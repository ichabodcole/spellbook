// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, statSync as statSync3, unlinkSync as unlinkSync3, watch } from "fs";
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
    this.forgetPath(abs);
    return { path: abs, removed: true };
  }
  forgetDoc(ref) {
    const d = this.docOrDie(ref);
    if (existsSync3(d.original))
      throw new SessionError(`${this.display(d.original)} is still on disk \u2014 forget is for a document whose file is gone. To take it out of the context, remove it from Scriptorium instead.`, 409);
    const forgotten = {
      slug: d.slug,
      name: d.name,
      original: d.original,
      versions: d.versions.length
    };
    this.m.docs = this.m.docs.filter((x) => x.slug !== d.slug);
    if (this.m.openDoc === d.slug)
      this.m.openDoc = this.m.docs[0]?.slug ?? null;
    this.relink();
    this.persist();
    return forgotten;
  }
  forgetPath(abs) {
    const inside = (p) => p === abs || p.startsWith(abs + sep2);
    for (const e of [...this.m.context]) {
      if (e.membership === "mirrored" && !inside(e.root)) {
        this.rescan(e.id);
        continue;
      }
      const prune = (nodes) => nodes.filter((n) => !inside(join4(e.root, n.rel))).map((n) => n.kind === "group" ? { ...n, children: prune(n.children) } : n);
      e.nodes = prune(e.nodes);
      if (e.nodes.length === 0 || inside(e.root))
        this.removeContext(e.id);
    }
    this.m.docs = this.m.docs.filter((d) => !inside(d.original));
    if (this.m.openDoc && !this.m.docs.some((d) => d.slug === this.m.openDoc))
      this.m.openDoc = this.m.docs[0]?.slug ?? null;
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
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
        const gone = !existsSync4(h.path);
        const kind = gone ? "" : statSync3(h.path).isDirectory() ? "folder" : "file";
        line = gone ? `${who} removed ${shown(h.path)} from Scriptorium (it was already gone from disk).` : `${who} removed ${shown(h.path)} from Scriptorium (the ${kind} is still on disk).`;
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
      case "forget": {
        const f = session.forgetDoc(cmd.doc);
        announce(`Agent forgot ${f.name} \u2014 its file was gone, and ${f.versions === 1 ? "1 version" : `${f.versions} versions`} in this session ${f.versions === 1 ? "is" : "are"} no longer reachable.`, { fact: "doc.forgotten", doc: f.slug, original: f.original });
        broadcastState();
        return f;
      }
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

//# debugId=18F8BCA994FC5C1064756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2FuY2hvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvZGlmZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oaXN0b3J5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZXNzaW9uLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2Zyb250bWF0dGVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2xpbmtzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VhcmNoLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3dhaXRpbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIHBlci1zZXNzaW9uIGRhZW1vbiDigJQgdGhlIHByb2Nlc3MgdGhlIHN1cmZhY2UgdGFsa3MgdG8gb3ZlciBhXG4gKiBXZWJTb2NrZXQgYW5kIHRoZSBDTEkgdGFsa3MgdG8gb3ZlciBIVFRQLiBMYXVuY2hlZCBieVxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9zY3JpcHRvcml1bS9zY3JpcHRzL3NlcnZlci50c2AgKHRoZSBsYXVuY2hlciksIHdoaWNoXG4gKiBpbXBvcnRzIHRoZSBCVUlMVCBgZGlzdC9zZXJ2ZXIuanNgLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBgU0tJTExfUk9PVGAvYERJU1RfRElSYCBvbmx5LCBmb3IgdGhlIGtpdCdzIGByZXNvbHZlTW9kZWAgYW5kXG4gKiAgICBgc2VydmVGcm9tRGlzdGAsIGFuZCB0cnVlIGF0IHRoZSBFTUlUVEVEIGFkZHJlc3MgKGBkaXN0L3NlcnZlci5qc2AsIHdob3NlXG4gKiAgICBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIpLiBOb3RoaW5nIGVsc2UgaXMgcGlubmVkIG9mZiBgaW1wb3J0Lm1ldGFgLlxuICogMi4gU2VydmVzOiBZRVMuIGAvYCBpcyB0aGUgYnVpbHQgYGluZGV4Lmh0bWxgIHZpYSBgc2VydmVGcm9tRGlzdGAsIG5vXG4gKiAgICBzdWJzdGl0dXRpb247IHRoZSBvbmx5IHJvdXRlcyBvZiBpdHMgb3duIGFyZSBgL3N0YXRlYCwgYC9jbWRgLCBgL2V2ZW50c2AsXG4gKiAgICBgL3dzYCBhbmQgYC9mcy8qYCAocmVhZC1vbmx5OiBhIHZlcnNpb24ncyB0ZXh0LCBhIGRpcmVjdG9yeSBsaXN0aW5nKS5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIGBjbGkudHNgOyB0aGUgdHdvIHNoYXJlIGAuL2hlYXJ0YmVhdC50c2AuXG4gKiA0LiBMaWZlY3ljbGU6IGxvbmctcnVubmluZywgb25lIGRhZW1vbiBwZXIgc2Vzc2lvbiwgaWRsZS10aW1lb3V0IGxpa2VcbiAqICAgIGdsYW1vdXIgKGxpbmdlciBhZnRlciB0aGUgbGFzdCBzdWJzY3JpYmVyIGxlYXZlczsgZXhpdCAxMjQpLlxuICogNS4gYG1haW4oKWAgcmV0dXJucyB3aGlsZSB0aGUgcHJvY2VzcyBtdXN0IGxpdmU/IE5PIOKAlCBgbWFpbmAgYXdhaXRzIHRoZVxuICogICAgc2Vzc2lvbidzIGVuZCBhbmQgaXRzIG93biBkcmFpbiwgZXhhY3RseSBhcyBnbGFtb3VyJ3Mgc2VydmVyIGRvZXMsIHNvIHRoZVxuICogICAgbGF1bmNoZXIgaXMgVEVSTUlOQUwtRVhJVCAoYHByb2Nlc3MuZXhpdChhd2FpdCBydW4oKSlgKTogb25jZSBgbWFpbmBcbiAqICAgIHJlc29sdmVzIG5vdGhpbmcgbWF5IGtlZXAgdGhlIHByb2Nlc3MgYWxpdmUsIGFuZCBhIHdhdGNoZXIgaGFuZGxlIG9yIGFcbiAqICAgIHN0cmFnZ2xpbmcgc29ja2V0IHdvdWxkLiBEcml2ZW4sIG5vdCByZWFkIChzZWUgdGhlIHNsaWNlLUEgam91cm5hbCkuXG4gKiA2LiBFdmVudCBpZHMgcmVjb3ZlcmVkIGFjcm9zcyByZXN0YXJ0PyBOTyDigJQgdGhlIGxvZyBpcyBpbiBtZW1vcnkgYW5kIGlkc1xuICogICAgcmVzdGFydCBhdCAxLCBldmVuIHVuZGVyIGAtLXJlc3RvcmVgICh3aGljaCByZXN0b3JlcyB0aGUgTUFOSUZFU1QsIG5vdCB0aGVcbiAqICAgIGxvZykuIFNvIHRoZSBsb2cgaXMgc3RhbXBlZCB3aXRoIGEgcGVyLWJvb3QgRVBPQ0ggKG1pbmQtbWFwcGVyJ3Mgc2hhcGUpXG4gKiAgICBhbmQgdGhlIHRhaWwgcmVzZXRzIGl0cyBjdXJzb3Igd2hlbiB0aGUgZXBvY2ggY2hhbmdlcy5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vIOKAlCB0aGUgc2hhcGUgd2FzIGNob3NlbiB0byBiZSB0aGVcbiAqICAgIGtpdCdzLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IE5POiBzY3JpcHRvcml1bVxuICogICAgaXMgdGhlIGZpcnN0IHNwZWxsIHNjYWZmb2xkZWQgYWZ0ZXIgdGhlIGNvbnZlcmdlbmNlLlxuICpcbiAqIOKUgOKUgCBLSVQgVkVSRElDVFMgKHBsYXlib29rIE40KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBlcnJvcnMgU1VCSkVDVCAodGhlIENMSTsgdGhlIGRhZW1vbiBhbnN3ZXJzIEhUVFAgc3RhdHVzZXMgdGhlIENMSSBtYXBzKSDCt1xuICogc2VydmVEaXN0IFNVQkpFQ1QgKGByZXNvbHZlTW9kZWAsIGBzZXJ2ZUZyb21EaXN0YCkgwrcgaG91c2VrZWVwaW5nIFNVQkpFQ1QsIGFsbFxuICogdGhyZWUgZXhwb3J0cyAoYHNob3VsZElkbGVDbG9zZWAgdmlhIGBzdGFydEhvdXNla2VlcGluZ2AncyBpZGxlLWNsb3NlLCB0aGVcbiAqIHNuYXBzaG90IHN3ZWVwIOKAlCBoZXJlIHRoZSBtYW5pZmVzdCBpcyB3cml0dGVuIG9uIGV2ZXJ5IGNoYW5nZSBpbnN0ZWFkLCBzbyB0aGVcbiAqIHN3ZWVwJ3Mgc25hcHNob3QgaG9vayBpcyBkZWxpYmVyYXRlbHkgTk9UIHBhc3NlZCDigJQgYW5kIGBkcmFpbkFuZFN0b3BgKSDCt1xuICogdGFpbEV2ZW50cyBTVUJKRUNUICh0aGUgQ0xJJ3MgYHRhaWxgKSDCtyBoZWFydGJlYXQgU1VCSkVDVCAoYC4vaGVhcnRiZWF0LnRzYCkgwrdcbiAqIGRpc2NvdmVyeSBTVUJKRUNUIChzZXNzaW9uLUpTT04sIEUxMzogYHNjcmlwdG9yaXVtLTxpZD4uanNvbmAgK1xuICogYHNjcmlwdG9yaXVtLWxhdGVzdC5qc29uYCBpbiB0bXBkaXIgdmlhIGB3cml0ZUZpbGVBdG9taWNgL2B1bmxpbmtJZk1hdGNoZXNgKSDCt1xuICogZXZlbnRMb2cgU1VCSkVDVCwgV0lUSCBFUE9DSCAoUTYpIMK3IHNzZSBTVUJKRUNUIChgR0VUIC9ldmVudHNgKSDCt1xuICogbGliL3ByaW50SnNvbiBTVUJKRUNUICh0aGUgQ0xJIHNwZWFrcyB0aGUgYWdlbnQgd2lyZSkuXG4gKlxuICog4pSA4pSAIFRFQVJET1dOIE9SREVSIChyZWdpc3RlciBBNiksIFNUQVRFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBnbGFtb3VyJ3Mgb3JkZXI6IHN0b3AgaG91c2VrZWVwaW5nIOKGkiBjbG9zZSB0aGUgd2F0Y2hlcnMg4oaSIHBlcnNpc3QgdGhlXG4gKiBtYW5pZmVzdCDihpIgdW5saW5rIGRpc2NvdmVyeSDihpIgZW1pdCBgY2xvc2VkYCDihpIgZHJhaW4uIERpc2NvdmVyeSBnb2VzIEJFRk9SRSB0aGVcbiAqIGBjbG9zZWRgIGZyYW1lIHNvIGEgdGFpbCB0aGF0IHNlZXMgYGNsb3NlZGAgYW5kIGEgQ0xJIHZlcmIgdGhhdCBydW5zIHJpZ2h0XG4gKiBhZnRlciBpdCBib3RoIGZpbmQgbm8gcG9pbnRlciB0byBhIGRhZW1vbiB0aGF0IGlzIGxlYXZpbmc7IHRoZSBvdGhlciBvcmRlclxuICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGEgdmVyYiByZXNvbHZlcyBhIHNlc3Npb24gdGhhdCB3aWxsIHJlZnVzZSBpdC5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBxdW90ZUxhYmVsIH0gZnJvbSBcIi4vYW5jaG9yc1wiO1xuaW1wb3J0IHsgdW5pZmllZCB9IGZyb20gXCIuL2RpZmZcIjtcbmltcG9ydCB7IElETEVfVElNRU9VVF9TRUMsIFNTRV9IRUFSVEJFQVRfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IHR5cGUgQWN0LCB0eXBlIEFmdGVyLCB0eXBlIEJlZm9yZSwgSGlzdG9yeSwgdHlwZSBJbnZlcnNlLCBwbGFuSW52ZXJzZSB9IGZyb20gXCIuL2hpc3RvcnlcIjtcbmltcG9ydCB7IHR5cGUgUGlja0tpbmQsIHBhcnNlUGlja2VyT3V0cHV0LCBwaWNrZXJDb21tYW5kLCB3YXNDYW5jZWxsZWQgfSBmcm9tIFwiLi9waWNrZXJcIjtcbmltcG9ydCB0eXBlIHtcbiAgQWdlbnRDbWQsXG4gIENsaWVudE1zZyxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgU2VydmVyTXNnLFxuICBTdHJ1Y3R1cmVPcCxcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgRmlsZUV2ZW50LCBTZXNzaW9uLCBTZXNzaW9uRXJyb3IsIHNpZGVOYW1lIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuaW1wb3J0IHsgREVGQVVMVF9TTk9PWkVfTVMsIHdhaXRpbmdPbiB9IGZyb20gXCIuL3dhaXRpbmdcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7XG4gIHBvcnQ/OiBudW1iZXI7XG4gIHJlc3RvcmU/OiBzdHJpbmc7XG4gIHRpbWVvdXRTPzogbnVtYmVyO1xuICAvKiogRTIzOiBhIE5FVyBzZXNzaW9uJ3Mgd29ya3NwYWNlIOKAlCB0aGUgZGlyZWN0b3J5IGBvcGVuYCByYW4gaW4uIEEgcmVzdG9yZSBrZWVwcyBpdHMgb3duLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSB0YWlsIGZyYW1lJ3MgcGF5bG9hZC4gVGhlIGxvZyBzdGFtcHMgYGlkYCBhbmQgYGVwb2NoYC4gKi9cbnR5cGUgTG9nRXZlbnQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgdHlwZTogc3RyaW5nIH07XG5cbi8qKiBIb3cgbG9uZyBhIGJ1cnN0IG9mIHdhdGNoZXIgZXZlbnRzIG9uIG9uZSBwYXRoIHNldHRsZXMgYmVmb3JlIGl0IGlzIHJlYWQuICovXG5jb25zdCBXQVRDSF9TRVRUTEVfTVMgPSA2MDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RGFlbW9uKG9wdHM6IFN0YXJ0T3B0cykge1xuICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gIC8vIE1vZGUgQkVGT1JFIGFueSB3cml0ZTogYSBmb3JjZWQtZGV2IGJvb3QgYXQgYSBzdXJmYWNlLWZyZWUgZGVzdGluYXRpb24gbXVzdFxuICAvLyBkaWUgYXQgdGhlIGltcG9ydCBoYXZpbmcgY3JlYXRlZCBub3RoaW5nIChnbGFtb3VyJ3MgbWVhc3VyZWQgb3JkZXIpLlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcblxuICBjb25zdCBzZXNzaW9uID0gb3B0cy5yZXN0b3JlXG4gICAgPyBTZXNzaW9uLnJlc3RvcmUoaG9tZSwgb3B0cy5yZXN0b3JlKVxuICAgIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSwgdW5kZWZpbmVkLCBvcHRzLndvcmtzcGFjZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIC0tLSBwcmVmczogcGVyLXZpZXdlciBjb252ZW5pZW5jZXMgdGhhdCBvdXRsaXZlIGEgc2Vzc2lvbidzIHBvcnQgLS0tLS0tLS0tLS0tXG4gIC8vIEJyb3dzZXIgc3RvcmFnZSBpcyBrZXllZCBieSBvcmlnaW4sIHBvcnQgaW5jbHVkZWQsIGFuZCBldmVyeSBzZXNzaW9uIGdldHMgYVxuICAvLyBuZXcgcG9ydCDigJQgc28gYSBwYW5lIHNpemUga2VwdCBpbiBsb2NhbFN0b3JhZ2UgcmVzZXRzIGF0IHRoZSBuZXh0IGBvcGVuYC5cbiAgLy8gVGhleSBsaXZlIGluIHRoZSBob21lIGluc3RlYWQsIHNoYXJlZCBieSBldmVyeSBzZXNzaW9uIG9mIHRoaXMgaG9tZS5cbiAgY29uc3QgcHJlZnNGaWxlID0gam9pbihob21lLCBcInByZWZzLmpzb25cIik7XG4gIGNvbnN0IFBSRUZfS0VZID0gL15bYS16XVthLXowLTk6Ll8tXXswLDYzfSQvO1xuICBjb25zdCBQUkVGX1ZBTFVFX01BWCA9IDQwOTY7XG4gIGNvbnN0IFBSRUZfS0VZU19NQVggPSA2NDtcbiAgLyoqXG4gICAqIFJlYWQgdGhlIGhvbWUncyBwcmVmcyBGUkVTSC4gU2V2ZXJhbCBzZXNzaW9ucyBjYW4gc2hhcmUgb25lIGhvbWUgKEUxMyksIGVhY2hcbiAgICogaXRzIG93biBkYWVtb24sIHNvIGEgY29weSBsb2FkZWQgb25jZSBhdCBib290IGFuZCB3cml0dGVuIGJhY2sgd2hvbGUgd291bGRcbiAgICogZXJhc2UgYSBrZXkgYW5vdGhlciBzZXNzaW9uIHdyb3RlIHNpbmNlICh2ZXJpZnkgcGFzcykuIEV2ZXJ5IHdyaXRlIGlzXG4gICAqIHRoZXJlZm9yZSByZWFkIOKGkiBzZXQgb25lIGtleSDihpIgd3JpdGUsIGFuZCBldmVyeSBzbmFwc2hvdCByZWFkcyB0aGUgZmlsZS5cbiAgICogT25seSB3ZWxsLWZvcm1lZCBlbnRyaWVzIHN1cnZpdmUgYSByZWFkOyBhIGJhZCBmaWxlIHJlYWRzIGFzIGVtcHR5IGFuZCBpc1xuICAgKiByZXBsYWNlZCBieSB0aGUgbmV4dCB3cml0ZS5cbiAgICovXG4gIGNvbnN0IHJlYWRQcmVmcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocHJlZnNGaWxlLCBcInV0ZjhcIikpIGFzIHVua25vd247XG4gICAgICBpZiAocmF3ICYmIHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhyYXcpKVxuICAgICAgICAgIGlmIChQUkVGX0tFWS50ZXN0KGspICYmIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYubGVuZ3RoIDw9IFBSRUZfVkFMVUVfTUFYKSBvdXRba10gPSB2O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gcHJlZnMgeWV0LCBvciB1bnJlYWRhYmxlIOKAlCBlbXB0eSAqL1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9O1xuICBjb25zdCB1c2VySG9tZSA9IGhvbWVkaXIoKTtcbiAgLyoqXG4gICAqIEU1MzogdGhlIHNub296ZSB0aGUgYWdlbnQgYXNrZWQgZm9yLCBhbmQgdGhlIG1lc3NhZ2VzIGFscmVhZHkgbnVkZ2VkLlxuICAgKlxuICAgKiDim5QgT05FIE5VREdFIFBFUiBNRVNTQUdFLCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgQU5USS1OQUcgUlVMRS4gQ29sZTogXCJ3ZVxuICAgKiBkb24ndCB3YW50IHRvIGhhdmUgYSBzaXR1YXRpb24gd2hlcmUgYW4gYWdlbnQga2VlcHMgZ2V0dGluZyBwaW5nZWQgYWJvdXRcbiAgICogc29tZXRoaW5nIGFuZCBpdCdzIGxpa2UsIG5vLCBJJ20gYWN0dWFsbHkgd29ya2luZy5cIiBTbyBhIG1lc3NhZ2UgaWQgZW50ZXJzXG4gICAqIGBudWRnZWRgIHRoZSBmaXJzdCB0aW1lIGl0IGlzIHJlcG9ydGVkIOKAlCBvciB0aGUgbW9tZW50IHRoZSBhZ2VudCBzbm9vemVzIGl0XG4gICAqIOKAlCBhbmQgbmV2ZXIgbGVhdmVzLiBBIHNub296ZSBFWFBJUklORyB0aGVyZWZvcmUgY2hhbmdlcyB3aGF0IHRoZSBIVU1BTlxuICAgKiBzZWVzIChiYWNrIHRvIFwibWF5IGJlIHN0dWNrXCIsIGJlY2F1c2UgdGhleSBhcmUgb3dlZCB0aGUgdHJ1dGgpIHdpdGhvdXRcbiAgICogcGluZ2luZyB0aGUgYWdlbnQgYWdhaW4uXG4gICAqXG4gICAqIOKaoCBJTiBNRU1PUlksIE5PVCBJTiBUSEUgTUFOSUZFU1QsIGRlbGliZXJhdGVseS4gQSByZXN0b3JlZCBzZXNzaW9uIHdob3NlXG4gICAqIGh1bWFuIHdhcyBsZWZ0IHdhaXRpbmcgU0hPVUxEIHRlbGwgdGhlIGFnZW50IHRoYXQgYXJyaXZlcyDigJQgdGhlIHdhaXQgaXNcbiAgICogcmVhbCBhbmQgdGhlIG5ldyBhZ2VudCBoYXMgbm90IGhlYXJkIGFib3V0IGl0LlxuICAgKi9cbiAgbGV0IGFja25vd2xlZGdlZFVudGlsOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IG51ZGdlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAvKipcbiAgICogRTYwOiB0aGUgQ09OVEVYVCdzIHVuZG8gaGlzdG9yeSDigJQgbm90IHRoZSBlZGl0b3Incywgd2hpY2ggQ29kZU1pcnJvciBvd25zLlxuICAgKiBJbiBtZW1vcnkgb24gcHVycG9zZSAoc2VlIGBoaXN0b3J5LnRzYCk6IGFuIGludmVyc2UgZGVzY3JpYmVzIHRoZSB3b3JsZCBhc1xuICAgKiBpdCBpcyBub3csIGFuZCBhIHNlc3Npb24gcmVzdG9yZWQgdG9tb3Jyb3cgbWF5IG1lZXQgZmlsZXMgc29tZWJvZHkgaGFzXG4gICAqIHNpbmNlIG1vdmVkIGJ5IGhhbmQuXG4gICAqL1xuICBjb25zdCBoaXN0b3J5ID0gbmV3IEhpc3RvcnkoKTtcblxuICBjb25zdCB2aWV3U3RhdGUgPSAoKTogUHVibGljU3RhdGUgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSB7IC4uLnNlc3Npb24udmlldyhtb2RlLCBzZWxlY3Rpb24pLCBwcmVmczogcmVhZFByZWZzKCksIHVzZXJIb21lIH07XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICB3YWl0aW5nOiB3YWl0aW5nT24oYmFzZS5jaGF0LCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pLFxuICAgICAgaGlzdG9yeTogaGlzdG9yeS52aWV3KCksXG4gICAgfTtcbiAgfTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIGNvbnN0IGxvZyA9IGNyZWF0ZUV2ZW50TG9nPExvZ0V2ZW50Pih7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH0pO1xuICBjb25zdCBzc2VDbGllbnRzOiBTc2VDbGllbnRzID0gbmV3IFNldCgpO1xuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGNvbnN0IHNlbmQgPSAobXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiBzZW5kKHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSk7XG5cbiAgLyoqIEEgc3lzdGVtIGxpbmUgaW4gdGhlIGNoYXQg4oCUIGFuZCwgYmVjYXVzZSB0aGUgYWdlbnQgbXVzdCBrbm93IGl0IHRvbywgb24gdGhlIHRhaWwuICovXG4gIGNvbnN0IGFubm91bmNlID0gKHRleHQ6IHN0cmluZywgZmFjdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSkgPT4ge1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgdGV4dCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcInN5c3RlbVwiLCB0ZXh0LCB0czogbS50cywgLi4uZmFjdCB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICB9O1xuXG4gIC8vIC0tLSB0aGUgd2F0Y2hlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDimqAgREVWSUFUSU9OIEZST00gVEhFIEJSSUVGLCBXSVRIIElUUyBSRUFTT046IGBub2RlOmZzYCBgd2F0Y2hgIChCdW4nc1xuICAvLyBidWlsdC1pbiksIE5PVCBgQHBhcmNlbC93YXRjaGVyYC4gYEBwYXJjZWwvd2F0Y2hlcmAgaXMgYSBuYXRpdmUgYWRkb24gd2hvc2VcbiAgLy8gbG9hZGVyIGRvZXMgYSBydW50aW1lIGByZXF1aXJlKClgIG9mIGEgcGVyLXBsYXRmb3JtIHBhY2thZ2U7IGJ1bmRsZWQgaW50b1xuICAvLyBgZGlzdC9zZXJ2ZXIuanNgIGl0IGlzIG5vdCBpbmxpbmVkLCBzbyB0aGUgc2hpcHBlZCBkYWVtb24gd291bGQgbmVlZCBhXG4gIC8vIGBub2RlX21vZHVsZXNgIHRoZSBtYXJrZXRwbGFjZSBuZXZlciBjb3BpZXMgKGltcG9ydC1ib3VuZGFyeSB3YXJkIDFiJ3NcbiAgLy8gXCJ0aGUgc2hpcHBlZCBleGVjdXRpb24gcGF0aCBjYXJyaWVzIG5vIGRlcGVuZGVuY2llc1wiKS4gTWVhc3VyZWQgdW5kZXIgQnVuXG4gIC8vIDEuNC4wIG9uIG1hY09TIGJlZm9yZSBjaG9vc2luZzogYSByZWN1cnNpdmUgZGlyZWN0b3J5IHdhdGNoIHJlcG9ydHMgYW5cbiAgLy8gaW4tcGxhY2Ugd3JpdGUsIGFuIGF0b21pYyB0bXArcmVuYW1lIHNhdmUsIGFuZCBib3RoIGFnYWluIGluIGFcbiAgLy8gc3ViZGlyZWN0b3J5IOKAlCB0aGUgZm91ciBjYXNlcyBpbnZlc3RpZ2F0aW9uIMKnNSBkcm92ZSBAcGFyY2VsL3dhdGNoZXIgb24uXG4gIC8vIFRoZSBoYXNoLWNvbXBhcmUgYW5kIHNlbGYtd3JpdGUgc3VwcHJlc3Npb24gYXJlIHVuY2hhbmdlZCAoc2Vzc2lvbi50cykuXG4gIGNvbnN0IHdhdGNoZXJzID0gbmV3IE1hcDxzdHJpbmcsIEZTV2F0Y2hlcj4oKTtcbiAgY29uc3QgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pj4oKTtcbiAgY29uc3Qgb25GcyA9IChhYnM6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHQgPSBwZW5kaW5nLmdldChhYnMpO1xuICAgIGlmICh0KSBjbGVhclRpbWVvdXQodCk7XG4gICAgcGVuZGluZy5zZXQoXG4gICAgICBhYnMsXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcGVuZGluZy5kZWxldGUoYWJzKTtcbiAgICAgICAgbGV0IGV2OiBGaWxlRXZlbnQgfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBldiA9IHNlc3Npb24ub25GaWxlRXZlbnQoYWJzKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogd2F0Y2hlcjogJHtlfVxcbmApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldikgaGFuZGxlRmlsZUV2ZW50KGV2KTtcbiAgICAgIH0sIFdBVENIX1NFVFRMRV9NUyksXG4gICAgKTtcbiAgfTtcbiAgY29uc3Qgc3luY1dhdGNoZXJzID0gKCkgPT4ge1xuICAgIGNvbnN0IHdhbnQgPSBuZXcgTWFwKFxuICAgICAgc2Vzc2lvbi53YXRjaFJvb3RzKCkubWFwKChyKSA9PiBbYCR7ci5yZWN1cnNpdmUgPyBcIlJcIiA6IFwiRlwifToke3Iud2F0Y2h9PiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBXYXRjaGVkIGF0IHRoZSBSRUFMUEFUSCwgcmVwb3J0ZWQgdW5kZXIgdGhlIHN0b3JlZCBwYXRoIGZvcm1cbiAgICAgICAgLy8gKHZlcmlmeS1wYXNzIGZpeCAzIOKAlCBzZWUgU2Vzc2lvbi53YXRjaFJvb3RzKS5cbiAgICAgICAgY29uc3QgdyA9IHdhdGNoKHIud2F0Y2gsIHsgcmVjdXJzaXZlOiByLnJlY3Vyc2l2ZSB9LCAoX2V2ZW50LCBuYW1lKSA9PiB7XG4gICAgICAgICAgaWYgKG5hbWUpIG9uRnMoam9pbihyLnBhdGgsIG5hbWUudG9TdHJpbmcoKSkpO1xuICAgICAgICAgIGVsc2UgaWYgKHIuZW50cnlJZCkgb25GcyhyLnBhdGgpO1xuICAgICAgICB9KTtcbiAgICAgICAgdy5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICAgICAgICAvKiB0aGUgZGlyZWN0b3J5IHdlbnQgYXdheTsgdGhlIG5leHQgc3luYyBkcm9wcyBpdCAqL1xuICAgICAgICB9KTtcbiAgICAgICAgd2F0Y2hlcnMuc2V0KGtleSwgdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW53YXRjaGFibGUgKGdvbmUsIHBlcm1pc3Npb25zKSDigJQgb3V0c2lkZSBjaGFuZ2VzIHRoZXJlIGdvIHVuc2VlbiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVGaWxlRXZlbnQgPSAoZXY6IEZpbGVFdmVudCkgPT4ge1xuICAgIHN3aXRjaCAoZXYua2luZCkge1xuICAgICAgY2FzZSBcInZlcnNpb24uY2hhbmdlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidmVyc2lvbi5jcmVhdGVkXCI6XG4gICAgICAgIGFubm91bmNlKGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gYXBwZWFyZWQgKHdyaXR0ZW4gZGlyZWN0bHkgdG8gJHtldi5wYXRofSlgLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImFjdGl2ZS5vdXRzaWRlXCI6XG4gICAgICAgIC8vIEUyOiB0aGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSB2ZXJzaW9uIHRoZSBodW1hbiBpcyBlZGl0aW5nLiBUaGVcbiAgICAgICAgLy8gb3V0c2lkZSB0ZXh0IGlzIEtFUFQgYXMgYSBuZXcgYWdlbnQgdmVyc2lvbiBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uXG4gICAgICAgIC8vIGtlZXBzIHRoZSBodW1hbidzIHRleHQg4oCUIG5vdGhpbmcgaXMgbG9zdCwgYW5kIHRoZSBodW1hbidzIGJ1ZmZlciBpc1xuICAgICAgICAvLyBub3QgdG91Y2hlZCAodmVyaWZ5LXBhc3MgZml4IDQpLlxuICAgICAgICBhbm5vdW5jZU91dHNpZGUoZXYuZG9jLCBldi52ZXJzaW9uLCBldi5wYXRoLCBldi5wcmVzZXJ2ZWRBcywgZXYucHJlc2VydmVkUGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5yZWxvYWRlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIOKAlCByZWxvYWRlZCAoeW91IGhhZCBubyB1bnNhdmVkIGVkaXRzKS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLmNvbmZsaWN0XCI6XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgeW91IGhhdmUgdW5zYXZlZCBlZGl0cy4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggeW91cnM7IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBldi5kb2MgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInRyZWVcIjpcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhbm5vdW5jZU91dHNpZGUgPSAoXG4gICAgZG9jOiBzdHJpbmcsXG4gICAgdmVyc2lvbjogbnVtYmVyLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBwcmVzZXJ2ZWRBczogbnVtYmVyLFxuICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZyxcbiAgKSA9PlxuICAgIGFubm91bmNlKFxuICAgICAgYHYke3ZlcnNpb259IG9mICR7ZG9jfSBpcyB0aGUgQUNUSVZFIHZlcnNpb24gYW5kIHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yLiBUaGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc307IHRoZSBhY3RpdmUgdmVyc2lvbiBrZWVwcyB5b3VyIHRleHQuIEFnZW50IGVkaXRzIGJlbG9uZyBpbiBhIG5ldyB2ZXJzaW9uICh2ZXJzaW9uLW5ldykuYCxcbiAgICAgIHsgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLCBkb2MsIHZlcnNpb24sIHBhdGgsIHByZXNlcnZlZEFzLCBwcmVzZXJ2ZWRQYXRoIH0sXG4gICAgKTtcblxuICAvLyAtLS0gc2hhcmVkIGFjdHMgKHN1cmZhY2UgYW5kIGFnZW50IHJlYWNoIHRoZSBzYW1lIGNvZGUpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBhZGRQYXRocyA9IChwYXRoczogc3RyaW5nW10pID0+IHtcbiAgICBjb25zdCBhZGRlZCA9IHBhdGhzLm1hcCgocCkgPT4gc2Vzc2lvbi5hZGRDb250ZXh0KHApKTtcbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiBhZGRlZDtcbiAgfTtcblxuICBjb25zdCBhY3RpdmF0ZSA9IChkb2M6IHN0cmluZyB8IHVuZGVmaW5lZCwgdmVyc2lvbjogbnVtYmVyLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKSA9PiB7XG4gICAgY29uc3QgciA9IHNlc3Npb24uYWN0aXZhdGUoeyBkb2MsIHZlcnNpb24gfSk7XG4gICAgY29uc3QgdmlldyA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgY29uc3QgcGF0aCA9IHZpZXcudmVyc2lvbnMuZmluZCgodikgPT4gdi5uID09PSB2ZXJzaW9uKT8ucGF0aCA/PyBudWxsO1xuICAgIHNlbmQoe1xuICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgIGRvYzogci5zbHVnLFxuICAgICAgdmVyc2lvbixcbiAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCB2ZXJzaW9uKS50ZXh0LFxuICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgXCJzeXN0ZW1cIixcbiAgICAgIGAke2J5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwifSBtYWRlIHYke3ZlcnNpb259IG9mICR7ci5zbHVnfSBhY3RpdmUgKHdhcyB2JHtyLnByZXZpb3VzfSkuYCxcbiAgICApO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJhY3RpdmF0ZWRcIiwgYnksIGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCwgdHM6IG0udHMgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGggfTtcbiAgfTtcblxuICAvKipcbiAgICogRTI0OiBvbmUgc3RydWN0dXJlIGNoYW5nZSwgZnJvbSBlaXRoZXIgcGFydHkg4oCUIHRoZSBzYW1lIHNlc3Npb24gbWV0aG9kLCB0aGVcbiAgICogc2FtZSBhbm5vdW5jZW1lbnQgKG5hbWluZyB3aG8gZGlkIGl0KSwgdGhlIHNhbWUgdGFpbCBmYWN0LiBSZXR1cm5zIHRoZSBwYXRoXG4gICAqIHRoZSBjaGFuZ2UgbGFuZGVkIGF0LCB3aGljaCB0aGUgc3VyZmFjZSB1c2VzIHRvIG9wZW4gb3IgcmVuYW1lIGl0LlxuICAgKi9cbiAgY29uc3QgU1RSVUNUVVJFX09QUyA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gICAgXCJkb2MuY3JlYXRlXCIsXG4gICAgXCJmb2xkZXIuY3JlYXRlXCIsXG4gICAgXCJtb3ZlXCIsXG4gICAgXCJyZW5hbWVcIixcbiAgICBcImhpZGVcIixcbiAgICBcInVuaGlkZVwiLFxuICAgIFwic2V0Lm1ha2VcIixcbiAgICBcImltcG9ydFwiLFxuICAgIFwid29ya3NwYWNlLnNldFwiLFxuICBdIHNhdGlzZmllcyBTdHJ1Y3R1cmVPcFtcInR5cGVcIl1bXSk7XG4gIGNvbnN0IGlzU3RydWN0dXJlT3AgPSAobTogeyB0eXBlOiBzdHJpbmcgfSk6IG0gaXMgU3RydWN0dXJlT3AgPT4gU1RSVUNUVVJFX09QUy5oYXMobS50eXBlKTtcblxuICBjb25zdCBzdHJ1Y3R1cmUgPSAob3A6IFN0cnVjdHVyZU9wLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IHdobyA9IGJ5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwiO1xuICAgIC8vIOKblCBDQVBUVVJFRCBCRUZPUkUgVEhFIEFDVCwgYmVjYXVzZSBldmVyeSBmaWVsZCBoZXJlIGlzIHNvbWV0aGluZyB0aGUgYWN0XG4gICAgLy8gQ0hBTkdFUzogcmVhZGluZyBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IGFmdGVyd2FyZHMgcmV0dXJucyB0aGUgbGlzdFxuICAgIC8vIGluY2x1ZGluZyB3aGF0IHdhcyBqdXN0IGhpZGRlbiwgd2hpY2ggcmVzdG9yZXMgbm90aGluZyAoRTYwKS5cbiAgICBjb25zdCBiZWZvcmU6IEJlZm9yZSA9IHtcbiAgICAgIC4uLihvcC50eXBlID09PSBcImhpZGVcIiA/IHsgaGlkZGVuOiBzZXNzaW9uLmhpZGRlbkJlZm9yZShvcC5wYXRoKSA/PyB1bmRlZmluZWQgfSA6IHt9KSxcbiAgICAgIC4uLihvcC50eXBlID09PSBcInVuaGlkZVwiID8geyBoaWRkZW46IHNlc3Npb24uaGlkZGVuT2ZFbnRyeShvcC5lbnRyeSkgPz8gdW5kZWZpbmVkIH0gOiB7fSksXG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJ3b3Jrc3BhY2Uuc2V0XCIgPyB7IHdvcmtzcGFjZTogc2Vzc2lvbi53b3Jrc3BhY2UgfSA6IHt9KSxcbiAgICB9O1xuICAgIGNvbnN0IHNob3duID0gKHA6IHN0cmluZykgPT4gc2Vzc2lvbi5kaXNwbGF5KHApO1xuICAgIGxldCByOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgcGF0aD86IHN0cmluZyB9O1xuICAgIGxldCBsaW5lOiBzdHJpbmc7XG4gICAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVEb2Mob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZUZvbGRlcihvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkIHRoZSBmb2xkZXIgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUob3AucGF0aCwgb3AuaW50byk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBtb3ZlZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKG9wLnBhdGgsIG9wLm5hbWUpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVuYW1lZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IGggPSBzZXNzaW9uLmhpZGUob3AucGF0aCk7XG4gICAgICAgIHIgPSBoO1xuICAgICAgICAvLyDimqAgVEhFIFBBUkVOVEhFVElDQUwgSEFTIFRPIEJFIFRSVUUuIEl0IHNhaWQgXCIodGhlIGZpbGUgaXMgc3RpbGwgb25cbiAgICAgICAgLy8gZGlzaylcIiB1bmNvbmRpdGlvbmFsbHksIHdoaWNoIGlzIHdyb25nIHR3aWNlIG92ZXIgb24gYSBHSE9TVCDigJQgYW5cbiAgICAgICAgLy8gZW50cnkgd2hvc2UgZmlsZSBpcyBhbHJlYWR5IGdvbmUg4oCUIGFuZCBjYWxscyBhIGZvbGRlciBhIGZpbGUuIENvbGVcbiAgICAgICAgLy8gbWV0IGJvdGggaW4gb25lIGdvIHdoaWxlIGNsZWFyaW5nIHJlc2lkdWUgZnJvbSB0aGUgRTYwIGJ1ZywgYW5kIGFcbiAgICAgICAgLy8gcmVhc3N1cmFuY2UgdGhhdCBpcyBmYWxzZSBpcyB3b3JzZSB0aGFuIG5vIHJlYXNzdXJhbmNlOiBpdCBpcyB0aGVcbiAgICAgICAgLy8gc2FtZSBkZWZlY3QgYXMgdGhlIGNvbmZsaWN0IGJhbm5lciBjbGFpbWluZyBlZGl0cyBoZSBoYWQgbm90IG1hZGUuXG4gICAgICAgIGNvbnN0IGdvbmUgPSAhZXhpc3RzU3luYyhoLnBhdGgpO1xuICAgICAgICBjb25zdCBraW5kID0gZ29uZSA/IFwiXCIgOiBzdGF0U3luYyhoLnBhdGgpLmlzRGlyZWN0b3J5KCkgPyBcImZvbGRlclwiIDogXCJmaWxlXCI7XG4gICAgICAgIGxpbmUgPSBnb25lXG4gICAgICAgICAgPyBgJHt3aG99IHJlbW92ZWQgJHtzaG93bihoLnBhdGgpfSBmcm9tIFNjcmlwdG9yaXVtIChpdCB3YXMgYWxyZWFkeSBnb25lIGZyb20gZGlzaykuYFxuICAgICAgICAgIDogYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAodGhlICR7a2luZH0gaXMgc3RpbGwgb24gZGlzaykuYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgICAgY29uc3QgdSA9IHNlc3Npb24udW5oaWRlKG9wLmVudHJ5KTtcbiAgICAgICAgciA9IHU7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGJyb3VnaHQgYmFjayAke3UucmVzdG9yZWR9IGhpZGRlbiBpdGVtJHt1LnJlc3RvcmVkID09PSAxID8gXCJcIiA6IFwic1wifS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZXQubWFrZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1ha2VTZXQob3AucGF0aCk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSB0dXJuZWQgJHtiYXNlbmFtZShtLnBhdGgpfSBpbnRvIGEgc2V0OiAke3Nob3duKG0uZm9sZGVyKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmltcG9ydFRleHQob3AubmFtZSwgb3AudGV4dCwgb3AuaW50byk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNvcGllZCAke29wLm5hbWV9IGluIGFzICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uc2V0V29ya3NwYWNlKG9wLnBhdGgpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBzZXQgdGhlIHdvcmtzcGFjZSB0byAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgLy8gVGhlIHdheSBiYWNrLCBwbGFubmVkIG5vdyBhbmQgZnJvbSB3aGF0IHdhcyB0cnVlIG5vdy5cbiAgICBoaXN0b3J5LmRpZChwbGFuSW52ZXJzZShvcCwgciBhcyBBZnRlciwgYmVmb3JlKSk7XG4gICAgYW5ub3VuY2UobGluZSwgeyBmYWN0OiBvcC50eXBlLCBieSwgLi4uciB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiByO1xuICB9O1xuXG4gIC8qKlxuICAgKiBBcHBseSBvbmUgcmVjb3JkZWQgaW52ZXJzZSwgYW5kIHJldHVybiB0aGUgYWN0IHRoYXQgd291bGQgcmV2ZXJzZSBUSEFUIOKAlFxuICAgKiB3aGljaCBpcyB3aGF0IGdvZXMgb250byB0aGUgb3RoZXIgc3RhY2suXG4gICAqXG4gICAqIOKblCBBIERFTEVURSBIQVMgTk8gV0FZIEJBQ0ssIGFuZCBzYXlzIHNvIGJ5IHJldHVybmluZyBudWxsLiBPbmNlIGEgY3JlYXRlZFxuICAgKiBmaWxlIGlzIGdvbmUgaXRzIGNvbnRlbnRzIGFyZSBnb25lIHdpdGggaXQsIHNvIGEgcmVkbyB0aGF0IFwicmUtY3JlYXRlc1wiIGl0XG4gICAqIHdvdWxkIGhhbmQgYmFjayBhbiBlbXB0eSBmaWxlIHdlYXJpbmcgdGhlIHNhbWUgbmFtZSDigJQgdGhlIGtpbmQgb2YgbGllIGFuXG4gICAqIHVuZG8gc3RhY2sgbXVzdCBub3QgdGVsbC4gQ29uZmlybWVkIGRlbGV0aW9ucyBhcmUgdGhlcmVmb3JlIG9uZS13YXksIHdoaWNoXG4gICAqIGlzIGFsc28gd2h5IHRoZXkgYXJlIGNvbmZpcm1lZC5cbiAgICovXG4gIGNvbnN0IGFwcGx5SW52ZXJzZSA9IChpbnY6IEludmVyc2UpOiBBY3QgfCBudWxsID0+IHtcbiAgICBzd2l0Y2ggKGludi5raW5kKSB7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUoaW52LnBhdGgsIGludi5pbnRvKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYG1vdmVkICR7YmFzZW5hbWUobS5mcm9tKX0gYmFjayBpbnRvICR7YmFzZW5hbWUoZGlybmFtZShtLnBhdGgpKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJtb3ZlXCIsIHBhdGg6IG0ucGF0aCwgaW50bzogZGlybmFtZShtLmZyb20pIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKGludi5wYXRoLCBpbnYubmFtZSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGByZW5hbWVkICR7YmFzZW5hbWUobS5mcm9tKX0gYmFjayB0byAke2Jhc2VuYW1lKG0ucGF0aCl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwicmVuYW1lXCIsIHBhdGg6IG0ucGF0aCwgbmFtZTogYmFzZW5hbWUobS5mcm9tKSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGRlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc3RvcmVIaWRkZW4oaW52LmVudHJ5LCBpbnYucmVscyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IHIud2FzLmxlbmd0aCA+IGludi5yZWxzLmxlbmd0aCA/IFwiYnJvdWdodCBpdGVtcyBiYWNrXCIgOiBcImhpZCBpdGVtcyBhZ2FpblwiLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IHIuZW50cnksIHJlbHM6IHIud2FzIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCB7IGVudHJ5IH0gPSBzZXNzaW9uLmFkZENvbnRleHQoaW52LnBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcHV0ICR7YmFzZW5hbWUoaW52LnBhdGgpfSBiYWNrIGluIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5yZW1vdmVcIiwgZW50cnk6IGVudHJ5LmlkIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gc2Vzc2lvbi5lbnRyeVJvb3QoaW52LmVudHJ5KTtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KGludi5lbnRyeSk7XG4gICAgICAgIHJldHVybiBwYXRoID09PSBudWxsXG4gICAgICAgICAgPyBudWxsXG4gICAgICAgICAgOiB7XG4gICAgICAgICAgICAgIGxhYmVsOiBgdG9vayAke2Jhc2VuYW1lKHBhdGgpfSBiYWNrIG91dCBvZiB0aGUgY29udGV4dGAsXG4gICAgICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJjb250ZXh0LmFkZFwiLCBwYXRoIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtzcGFjZVwiOiB7XG4gICAgICAgIGNvbnN0IHdhcyA9IHNlc3Npb24ud29ya3NwYWNlO1xuICAgICAgICBzZXNzaW9uLnNldFdvcmtzcGFjZShpbnYucGF0aCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBzZXQgdGhlIHdvcmtzcGFjZSBiYWNrIHRvICR7YmFzZW5hbWUoaW52LnBhdGgpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIndvcmtzcGFjZVwiLCBwYXRoOiB3YXMgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkZWxldGVcIjoge1xuICAgICAgICBzZXNzaW9uLnJlbW92ZUNyZWF0ZWQoaW52LnBhdGgsIGludi5kaXIpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChtc2cpKSB7XG4gICAgICBjb25zdCByID0gc3RydWN0dXJlKGFuY2hvclN1cmZhY2VQYXRocyhtc2cpLCBcImh1bWFuXCIpO1xuICAgICAgaWYgKHR5cGVvZiByLnBhdGggPT09IFwic3RyaW5nXCIpXG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwic3RydWN0dXJlLmRvbmVcIiwgb3A6IG1zZy50eXBlLCBwYXRoOiByLnBhdGggfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJvcGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ub3BlblBhdGgobXNnLnBhdGgpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgLy8gVGhlIG9wZW5lciBnZXRzIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgc3RyYWlnaHQgYXdheSDigJQgdGhlIHN0YXRlXG4gICAgICAgIC8vIHNuYXBzaG90IGNhcnJpZXMgbm8gdGV4dHMsIGFuZCBhIHZpZXdlciBtdXN0IG5vdCB3YWl0IG9uIGEgc2Vjb25kIGFzay5cbiAgICAgICAge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHIuY3JlYXRlZClcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jLm9wZW5lZFwiLCBkb2M6IHIuc2x1ZywgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHIuc2x1ZykgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJvcGVuLmRvY1wiOlxuICAgICAgICBzZXNzaW9uLm9wZW5TbHVnKG1zZy5kb2MpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXQobXNnLmRvYywgbXNnLnZlcnNpb24sIG1zZy50ZXh0KTtcbiAgICAgICAgaWYgKHIucHJlc2VydmVkKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKG1zZy5kb2MpO1xuICAgICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICAgIGQuc2x1ZyxcbiAgICAgICAgICAgIG1zZy52ZXJzaW9uLFxuICAgICAgICAgICAgc2Vzc2lvbi5hY3RpdmVQYXRoKGQuc2x1ZykgPz8gXCJcIixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLm4sXG4gICAgICAgICAgICByLnByZXNlcnZlZC5wYXRoLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoci5kaXJ0eUNoYW5nZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWFyY2hcIjoge1xuICAgICAgICAvLyDim5QgUkVQTElFRCBUTyBUSEUgQVNLSU5HIFNPQ0tFVCwgTk9UIEJST0FEQ0FTVC4gQSBzZWFyY2ggaXMgb25lXG4gICAgICAgIC8vIHZpZXdlcidzIHF1ZXN0aW9uOyBwdXNoaW5nIHJlc3VsdHMgdG8gZXZlcnkgY2xpZW50IHdvdWxkIHB1dCBzb21lb25lXG4gICAgICAgIC8vIGVsc2UncyBxdWVyeSBpbiB5b3VyIHBhbmUuIChUaGUgc2FtZSByZWFzb24gYGRpZmZgIHJlcGxpZXMgcmF0aGVyXG4gICAgICAgIC8vIHRoYW4gYnJvYWRjYXN0aW5nLilcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInNlYXJjaC5yZXN1bHRzXCIsIHJlcG9ydDogc2Vzc2lvbi5zZWFyY2hBbGwobXNnKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnVuZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtVbmRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIC8vIOKblCBBIERFTEVUSU5HIFVORE8gTkVFRFMgVEhFIEhVTUFOJ1MgV09SRCwgY2FycmllZCBleHBsaWNpdGx5LiBBXG4gICAgICAgIC8vIGNsaWVudCB0aGF0IHNpbXBseSBvbWl0cyB0aGUgZmxhZyBnZXRzIGEgcmVmdXNhbCByYXRoZXIgdGhhbiBhXG4gICAgICAgIC8vIGRlbGV0aW9uLCBzbyBcImZvcmdvdCB0byBjb25maXJtXCIgY2FuIG5ldmVyIGJlY29tZSBcImRlbGV0ZWQgYW55d2F5XCIuXG4gICAgICAgIGlmIChhY3QuaW52ZXJzZS5raW5kID09PSBcImRlbGV0ZVwiICYmIG1zZy5jb25maXJtRGVsZXRlICE9PSB0cnVlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBVbmRvaW5nIFwiJHthY3QubGFiZWx9XCIgd291bGQgZGVsZXRlICR7c2Vzc2lvbi5kaXNwbGF5KGFjdC5pbnZlcnNlLnBhdGgpfSDigJQgY29uZmlybSBpdCBmaXJzdC5gLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGhpc3RvcnkudG9va1VuZG8oYXBwbHlJbnZlcnNlKGFjdC5pbnZlcnNlKSk7XG4gICAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgICAgYW5ub3VuY2UoYFlvdSB1bmRpZDogJHthY3QubGFiZWx9LmAsIHsgZmFjdDogXCJoaXN0b3J5LnVuZG9cIiB9KTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gVGhlIHJlZnVzYWwgdGhlIGh1bWFuIG5lZWRzIHRvIHJlYWQg4oCUIGEgZm9sZGVyIHdpdGggdGhpbmdzIGluIGl0LFxuICAgICAgICAgIC8vIG9yIGEgd29ybGQgdGhhdCBoYXMgbW92ZWQgdW5kZXIgYSByZWNvcmRlZCBpbnZlcnNlLiBUaGUgYWN0IFNUQVlTXG4gICAgICAgICAgLy8gb24gdGhlIHN0YWNrOiBub3RoaW5nIGhhcHBlbmVkLCBzbyBub3RoaW5nIHNob3VsZCBiZSBmb3Jnb3R0ZW4uXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpc3RvcnkucmVkb1wiOiB7XG4gICAgICAgIGNvbnN0IGFjdCA9IGhpc3RvcnkucGVla1JlZG8oKTtcbiAgICAgICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tSZWRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgcmVkaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS5yZWRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgICAgLy8gQU1CSUVOVCBzdGF0ZTogc3RvcmVkIGFuZCBzaG93biwgbmV2ZXIgcHVzaGVkIG9udG8gdGhlIGFnZW50J3MgdGFpbC5cbiAgICAgICAgc2VsZWN0aW9uID0gbXNnLnNlbGVjdGlvbjtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBtc2cudGV4dC50cmltKCk7XG4gICAgICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWwgPSBtc2cud2l0aFNlbGVjdGlvbiA/IHNlbGVjdGlvbiA6IG51bGw7XG4gICAgICAgIGNvbnN0IGFjdGl2ZVBhdGggPSBzZWwgPyBzZXNzaW9uLmFjdGl2ZVBhdGgoc2VsLmRvYykgOiBzZXNzaW9uLmFjdGl2ZVBhdGgoKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHsgc2VsZWN0aW9uOiBzZWwsIGFjdGl2ZVBhdGggfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICBtZXNzYWdlX2lkOiBtLmlkLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgc2VsZWN0aW9uOiBzZWwsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZihzZWw/LmRvYyksXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgYWN0aXZhdGUobXNnLmRvYywgbXNnLnZlcnNpb24sIFwiaHVtYW5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICBib2R5OiBtc2cuYm9keSxcbiAgICAgICAgICB3aG86IFwiaHVtYW5cIixcbiAgICAgICAgICByYW5nZTogeyBmcm9tOiBtc2cuZnJvbSwgdG86IG1zZy50byB9LFxuICAgICAgICB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUuYWRkZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2sobXNnLmlkLCBtc2cub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KSB7XG4gICAgICAgICAgc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBEb25lOiAke3IudGFzay50ZXh0fWApO1xuICAgICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLmRvbmVcIiwgdGFzazogci50YXNrLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlVGFzayhtc2cuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBzZXNzaW9uLmNsZWFyRG9uZVRhc2tzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0Tm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCwgYm9keTogbXNnLmJvZHkgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLmVkaXRlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQsIHJlc29sdmVkOiBtc2cucmVzb2x2ZWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBtc2cucmVzb2x2ZWQgPyBcIm5vdGUucmVzb2x2ZWRcIiA6IFwibm90ZS5yZW9wZW5lZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVtb3ZlTm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUucmVtb3ZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiBtc2cudmVyc2lvbiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBEZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICAuLi4obXNnLmZyb20gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBmcm9tOiBtc2cuZnJvbSB9KSxcbiAgICAgICAgICAuLi4obXNnLmxhYmVsID8geyBsYWJlbDogbXNnLmxhYmVsIH0gOiB7fSksXG4gICAgICAgICAgYXV0aG9yOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDim5QgU0FZIFdIRVJFIFRIRVkgQVJFLCBub3QganVzdCB3aGF0IHdhcyBtYWRlIChFNDIpLiBUaGUgb2xkIG1lc3NhZ2VcbiAgICAgICAgLy8gYW5ub3VuY2VkIHRoZSBuZXcgdmVyc2lvbiBhbmQgd2VudCBxdWlldCBhYm91dCB3aGljaCBvbmUgdGhlIGh1bWFuXG4gICAgICAgIC8vIHdhcyBlZGl0aW5nIOKAlCB3aGljaCBpcyBleGFjdGx5IGhvdyBzb21lb25lIHR5cGVzIGludG8gdjEgYmVsaWV2aW5nXG4gICAgICAgIC8vIHRoZXkgYXJlIGluIHYyLlxuICAgICAgICBpZiAobXNnLmFjdGl2YXRlKSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYE1hZGUgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7bXNnLmxhYmVsID8gYCDigJQgJHttc2cubGFiZWx9YCA6IFwiXCJ9LiBgICtcbiAgICAgICAgICAgIChtc2cuYWN0aXZhdGVcbiAgICAgICAgICAgICAgPyBgWW91IGFyZSBub3cgZWRpdGluZyB2JHtyLnZlcnNpb24ubn0uYFxuICAgICAgICAgICAgICA6IGBZb3UgYXJlIHN0aWxsIGVkaXRpbmcgdiR7ci52ZXJzaW9uLmZyb219LmApLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24ubixcbiAgICAgICAgICBmcm9tOiByLnZlcnNpb24uZnJvbSxcbiAgICAgICAgICBhY3RpdmF0ZWQ6IG1zZy5hY3RpdmF0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24uc2hvd25QYXRoKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsLnZlcnNpb25cIjpcbiAgICAgICAgLy8gVGhlIGRhZW1vbiByZXNvbHZlcyBpdCwgc28gdGhlIHN1cmZhY2UgbmV2ZXIgbmFtZXMgYSBwYXRoIG91dHNpZGVcbiAgICAgICAgLy8gd2hhdCB0aGUgc2Vzc2lvbiBhbHJlYWR5IG93bnMuXG4gICAgICAgIHJldmVhbFBhdGgoc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikucGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZGlmZlwiLCAuLi5zZXNzaW9uLmNvbXBhcmUoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0IH0pIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogbXNnLmRvYywgYWdhaW5zdDogbXNnLmFnYWluc3QsIGh1bmtzOiBtc2cuaHVua3MgfSk7XG4gICAgICAgIC8vIFRoZSBidWZmZXIgdGhlIGh1bWFuIGlzIGxvb2tpbmcgYXQgbXVzdCBiZSB0b2xkOiB0aGUgbWVyZ2Ugd3JvdGUgdGhlXG4gICAgICAgIC8vIGFjdGl2ZSB2ZXJzaW9uJ3MgRklMRSwgYW5kIHRoZSBlZGl0b3IncyB0ZXh0IGlzIG5vdyBiZWhpbmQgaXQuXG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFRvb2sgJHtyLmFwcGxpZWR9IGNoYW5nZSR7ci5hcHBsaWVkID09PSAxID8gXCJcIiA6IFwic1wifSBmcm9tICR7c2lkZU5hbWUobXNnLmFnYWluc3QsIHNlc3Npb24uZG9jKHIuc2x1ZykubmFtZSl9IGludG8gdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzOiBtc2cuaHVua3MsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwcmVmcy5zZXRcIjoge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVBSRUZfS0VZLnRlc3QobXNnLmtleSkgfHxcbiAgICAgICAgICB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgbXNnLnZhbHVlLmxlbmd0aCA+IFBSRUZfVkFMVUVfTUFYXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfWApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFByZWZzKCk7XG4gICAgICAgIGlmIChjdXJyZW50W21zZy5rZXldID09PSBtc2cudmFsdWUpIHJldHVybjtcbiAgICAgICAgaWYgKCEobXNnLmtleSBpbiBjdXJyZW50KSAmJiBPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGggPj0gUFJFRl9LRVlTX01BWClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9OiAke1BSRUZfS0VZU19NQVh9IGtleXMgYWxyZWFkeSBrZXB0YCxcbiAgICAgICAgICApO1xuICAgICAgICB3cml0ZUZpbGVBdG9taWMoXG4gICAgICAgICAgcHJlZnNGaWxlLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgLi4uY3VycmVudCwgW21zZy5rZXldOiBtc2cudmFsdWUgfSwgbnVsbCwgMil9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImdyYXBoXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImdyYXBoXCIsIGVudHJ5OiBtc2cuZW50cnksIGdyYXBoOiBzZXNzaW9uLmdyYXBoRm9yKG1zZy5lbnRyeSkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgICAgZW50cnk6IG1zZy5lbnRyeSxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxpbmsub3BlblwiOiB7XG4gICAgICAgIC8vIEUzMzogYSBsaW5rIGluc2lkZSB0aGUgYnVuZGxlIGlzIEZPTExPV0VEOyBvbmUgdGhhdCBlc2NhcGVzIGl0IGlzXG4gICAgICAgIC8vIHJlcG9ydGVkIHNvIHRoZSBzdXJmYWNlIGNhbiBvZmZlciB0byBhZGQgaXQsIG5ldmVyIGFkZGVkIHNpbGVudGx5LlxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTGluayhtc2cuZnJvbSwgbXNnLnRhcmdldCk7XG4gICAgICAgIGlmIChyLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSB7XG4gICAgICAgICAgc2Vzc2lvbi5vcGVuUGF0aChyLnBhdGgpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHNlc3Npb24ub3BlbkRvY1NsdWcgPz8gXCJcIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihkLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwibGluay50YXJnZXRcIixcbiAgICAgICAgICB0YXJnZXQ6IG1zZy50YXJnZXQsXG4gICAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICAgICAgLi4uKHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8ge30gOiB7IHBhdGg6IHIucGF0aCB9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXRhLnN1Z2dlc3RcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnN1Z2dlc3RNZXRhKG1zZy5wYXRoLCBcImh1bWFuXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBibG9jazogci5ibG9jayxcbiAgICAgICAgICAgIC4uLihyLnR5cGUgPyB7IHN1Z2dlc3RlZFR5cGU6IHIudHlwZSB9IDoge30pLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1vdmUucGxhblwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgcGxhbjogc2Vzc2lvbi5tb3ZlUGxhbihzdXJmYWNlUGF0aChtc2cucGF0aCksIHN1cmZhY2VQYXRoKG1zZy5pbnRvKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgbmF0aXZlIHBpY2tlciAob25lIGRpYWxvZyBhdCBhIHRpbWUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvL1xuICAvLyBBIG1vZGFsIGRpYWxvZyBvd25zIHRoZSBodW1hbidzIGF0dGVudGlvbiwgYW5kIGEgc2Vjb25kIG9uZSBiZWhpbmQgdGhlXG4gIC8vIGZpcnN0IGNhbm5vdCBiZSBzZWVuIG9yIGRpc21pc3NlZCDigJQgc28gYSByZXF1ZXN0IHdoaWxlIG9uZSBpcyBvcGVuIGlzXG4gIC8vIHJlZnVzZWQgaW4gd29yZHMgcmF0aGVyIHRoYW4gcXVldWVkLlxuICBsZXQgcGlja2VyT3BlbiA9IGZhbHNlO1xuICBjb25zdCB6ZW5pdHkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBCdW4ud2hpY2goXCJ6ZW5pdHlcIikgOiBudWxsO1xuICBjb25zdCBvcGVuUGlja2VyID0gYXN5bmMgKFxuICAgIHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LFxuICAgIHdhbnQ6IFwiY29udGV4dC1maWxlXCIgfCBcImNvbnRleHQtZm9sZGVyXCIgfCBcIndvcmtzcGFjZVwiLFxuICApID0+IHtcbiAgICBpZiAocGlja2VyT3Blbikge1xuICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBcImEgZmlsZSBwaWNrZXIgaXMgYWxyZWFkeSBvcGVuXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGtpbmQ6IFBpY2tLaW5kID0gd2FudCA9PT0gXCJjb250ZXh0LWZpbGVcIiA/IFwiZmlsZVwiIDogXCJmb2xkZXJcIjtcbiAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgd2FudCA9PT0gXCJ3b3Jrc3BhY2VcIlxuICAgICAgICA/IFwiQ2hvb3NlIHRoZSB3b3Jrc3BhY2UgZm9sZGVyIGZvciBzY3JpcHRvcml1bVwiXG4gICAgICAgIDogd2FudCA9PT0gXCJjb250ZXh0LWZvbGRlclwiXG4gICAgICAgICAgPyBcIkNob29zZSBhIGZvbGRlciB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIlxuICAgICAgICAgIDogXCJDaG9vc2UgZG9jdW1lbnRzIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiO1xuICAgIGNvbnN0IGNtZCA9IHBpY2tlckNvbW1hbmQocHJvY2Vzcy5wbGF0Zm9ybSwga2luZCwgcHJvbXB0LCB6ZW5pdHkpO1xuICAgIGlmICghY21kKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBubyBmaWxlIHBpY2tlciBvbiB0aGlzIHN5c3RlbSAoJHtwcm9jZXNzLnBsYXRmb3JtfSkg4oCUIHR5cGUgdGhlIHBhdGggaW5zdGVhZGAsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcGlja2VyT3BlbiA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oY21kLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIsIHN0ZGluOiBcImlnbm9yZVwiIH0pO1xuICAgICAgY29uc3QgW291dCwgY29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgICB0b3VjaCgpOyAvLyBhIGh1bWFuIHN0b29kIGF0IGEgZGlhbG9nOyB0aGUgc2Vzc2lvbiBpcyBub3QgaWRsZVxuICAgICAgY29uc3QgcGF0aHMgPSBwYXJzZVBpY2tlck91dHB1dChvdXQpO1xuICAgICAgaWYgKHBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBDYW5jZWxsZWQ6IG5vdGhpbmcgY2hvc2VuLCBub3RoaW5nIHNhaWQuIEEgcmVhbCBmYWlsdXJlIGlzIHNhaWQuXG4gICAgICAgIGlmICghd2FzQ2FuY2VsbGVkKGNvZGUsIG91dCkpXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgdGhlIGZpbGUgcGlja2VyIGZhaWxlZCAoZXhpdCAke2NvZGV9KWAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFdoYXQgd2FzIGNob3NlbiBpcyBhZG1pdHRlZCBsaWtlIGFueSBvdGhlciBwYXRoIOKAlCBhIHBpY2tlZCBmaWxlIHRoYXRcbiAgICAgIC8vIHNjcmlwdG9yaXVtIGRvZXMgbm90IG9wZW4gaXMgcmVmdXNlZCBpbiB0aGUgc2lkZWJhcidzIG93biB3b3JkcywgYW5kXG4gICAgICAvLyB0aGF0IHJlZnVzYWwgbXVzdCBub3QgcmVhZCBhcyBcInRoZSBwaWNrZXIgZmFpbGVkXCIuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAod2FudCA9PT0gXCJ3b3Jrc3BhY2VcIilcbiAgICAgICAgICBzdHJ1Y3R1cmUoeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcGF0aHNbMF0gYXMgc3RyaW5nIH0sIFwiaHVtYW5cIik7XG4gICAgICAgIGVsc2UgYWRkUGF0aHMocGF0aHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBjb3VsZCBub3Qgb3BlbiB0aGUgZmlsZSBwaWNrZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcGlja2VyT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgLyoqIFNob3cgYSBmaWxlIGluIHRoZSBwbGF0Zm9ybSdzIGZpbGUgbWFuYWdlci4gQW4gYXJndiwgbmV2ZXIgYSBzaGVsbCBzdHJpbmc6XG4gICAqICB0aGUgcGF0aCBpcyBkYXRhLCB3aGF0ZXZlciBpdCBob2xkcy4gKi9cbiAgY29uc3QgcmV2ZWFsUGF0aCA9IChwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBbY21kLCAuLi5hcmdzXSA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgID8gW1wib3BlblwiLCBcIi1SXCIsIHBhdGhdXG4gICAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICA6IFtcInhkZy1vcGVuXCIsIGRpcm5hbWUocGF0aCldO1xuICAgIEJ1bi5zcGF3bihbY21kIGFzIHN0cmluZywgLi4uYXJnc10sIHsgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSB9KS51bnJlZigpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcIm1ldGFcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24ubWV0YUZvcihjbWQucGF0aCk7XG4gICAgICBjYXNlIFwiZ3JhcGhcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZ3JhcGhGb3IoY21kLmVudHJ5KSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY2FzZSBcImRhbmdsaW5nXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmRhbmdsaW5nTGlua3MoY21kLmVudHJ5KTtcbiAgICAgIGNhc2UgXCJmb3JnZXRcIjoge1xuICAgICAgICBjb25zdCBmID0gc2Vzc2lvbi5mb3JnZXREb2MoY21kLmRvYyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBmb3Jnb3QgJHtmLm5hbWV9IOKAlCBpdHMgZmlsZSB3YXMgZ29uZSwgYW5kICR7Zi52ZXJzaW9ucyA9PT0gMSA/IFwiMSB2ZXJzaW9uXCIgOiBgJHtmLnZlcnNpb25zfSB2ZXJzaW9uc2B9IGluIHRoaXMgc2Vzc2lvbiAke2YudmVyc2lvbnMgPT09IDEgPyBcImlzXCIgOiBcImFyZVwifSBubyBsb25nZXIgcmVhY2hhYmxlLmAsXG4gICAgICAgICAgeyBmYWN0OiBcImRvYy5mb3Jnb3R0ZW5cIiwgZG9jOiBmLnNsdWcsIG9yaWdpbmFsOiBmLm9yaWdpbmFsIH0sXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiBmIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLnNlYXJjaEFsbChjbWQpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjYXNlIFwiYmFja2xpbmtzXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmJhY2tsaW5rcyhjbWQucGF0aCk7XG4gICAgICBjYXNlIFwibWV0YS5pbml0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YUluaXQoY21kLnBhdGgsIHtcbiAgICAgICAgICAuLi4oY21kLm1ldGFUeXBlID8geyB0eXBlOiBjbWQubWV0YVR5cGUgfSA6IHt9KSxcbiAgICAgICAgICBieTogY21kLmJ5ID8/IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBhZGRlZCBmcm9udG1hdHRlciB0byAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgLi4ucixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc2V0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YVNldChjbWQucGF0aCwgY21kLmZpZWxkcyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBzZXQgJHsoci5zZXQgYXMgc3RyaW5nW10pLmpvaW4oXCIsIFwiKX0gb24gJHtzZXNzaW9uLmRpc3BsYXkoU3RyaW5nKHIucGF0aCkpfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXRhLnNldFwiLCBieTogXCJhZ2VudFwiLCAuLi5yIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogY21kLmRvYywgdmVyc2lvbjogY21kLnZlcnNpb24gfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBkZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIHJlbWFpbmluZzogci5yZW1haW5pbmcgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBib2R5OiBjbWQuYm9keSxcbiAgICAgICAgICB3aG86IFwiYWdlbnRcIixcbiAgICAgICAgICBxdW90ZTogY21kLnF1b3RlLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IG5vdGVkIOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnSBvbiAke3Iuc2x1Z30uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5hZGRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgcXVvdGU6IHIubm90ZS5xdW90ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGVzXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubm90ZXNPZih7IGRvYzogY21kLmRvYywgLi4uKGNtZC5hbGwgPyB7IGFsbDogdHJ1ZSB9IDoge30pIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZXM6IHIubm90ZXMgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnJlbW92ZVRhc2soY21kLmlkKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgcmVtb3ZlZDogdHJ1ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2tzLmNsZWFyXCI6IHtcbiAgICAgICAgY29uc3QgY2xlYXJlZCA9IHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgY2xlYXJlZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtpbmdcIjoge1xuICAgICAgICAvLyBFNTMncyBzbm9vemUuIEl0IGRvZXMgTk9UIHBvc3QgdG8gdGhlIGNoYXQ6IGFuIGFnZW50IHNheWluZyBcInN0aWxsXG4gICAgICAgIC8vIHdvcmtpbmdcIiBpbiB0aGUgY29udmVyc2F0aW9uIGlzIGEgcmVwbHksIGFuZCBpdCBjYW4gZG8gdGhhdCB3aXRoXG4gICAgICAgIC8vIGBzYXlgIOKAlCB0aGlzIGlzIHRoZSBxdWlldGVyIHRoaW5nLCBmb3Igd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvXG4gICAgICAgIC8vIHJlcG9ydCB5ZXQgYnV0IHRoZSBhbGFybSBzaG91bGQgc3RvcC5cbiAgICAgICAgY29uc3QgbXMgPSBjbWQuc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8gY21kLnNlY29uZHMgKiAxMDAwIDogREVGQVVMVF9TTk9PWkVfTVM7XG4gICAgICAgIGFja25vd2xlZGdlZFVudGlsID0gRGF0ZS5ub3coKSArIE1hdGgubWF4KDAsIG1zKTtcbiAgICAgICAgLy8gV2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBhY2tub3dsZWRnZWQsIHNvIGl0IG11c3QgbmV2ZXIgYmUgbnVkZ2VkIGFnYWluLlxuICAgICAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICAgICAgaWYgKHcpIG51ZGdlZC5hZGQody5tZXNzYWdlSWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHVudGlsOiBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICAgICAgICBzZWNvbmRzOiBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIG1zKSAvIDEwMDApLFxuICAgICAgICAgIC4uLih3ID8geyB3YWl0aW5nOiB3Lm1lc3NhZ2VJZCB9IDoge30pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhcnRcIjoge1xuICAgICAgICBjb25zdCB0ID0gc2Vzc2lvbi5zdGFydFRhc2soY21kLnRleHQsIFwiYWdlbnRcIik7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLnN0YXJ0ZWRcIiwgdGFzazogdC5pZCwgdGV4dDogdC50ZXh0LCBieTogXCJhZ2VudFwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnN0YXR1c1wiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnNldFRhc2tTdGF0dXMoY21kLmlkLCBjbWQuc3RhdHVzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgc3RhdHVzOiB0LnN0YXR1cyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2soY21kLmlkLCBjbWQub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KVxuICAgICAgICAgIGFubm91bmNlKGBEb25lOiAke3IudGFzay50ZXh0fSR7ci50YXNrLm91dGNvbWUgPyBgIOKAlCAke3IudGFzay5vdXRjb21lfWAgOiBcIlwifWAsIHtcbiAgICAgICAgICAgIGZhY3Q6IFwidGFzay5kb25lXCIsXG4gICAgICAgICAgICB0YXNrOiByLnRhc2suaWQsXG4gICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiByLnRhc2suaWQsIGFscmVhZHk6IHIuYWxyZWFkeSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkLCBib2R5OiBjbWQuYm9keSB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IHJld3JvdGUgYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIHJlc29sdmVkOiBjbWQucmVzb2x2ZWQgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCAke2NtZC5yZXNvbHZlZCA/IFwicmVzb2x2ZWRcIiA6IFwicmVvcGVuZWRcIn0gYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm5vdGUucmVzb2x2ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiYWdlbnRcIiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCByZXNvbHZlZDogci5ub3RlLnJlc29sdmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZW1vdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZW1vdmVOb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgcmVtb3ZlZCBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5yZW1vdmVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIGNvbnN0IHAgPSBzZXNzaW9uLmNvbXBhcmUoeyBkb2M6IGNtZC5kb2MsIGFnYWluc3Q6IGNtZC5hZ2FpbnN0IH0pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvYzogcC5kb2MsXG4gICAgICAgICAgYWN0aXZlOiBwLmFjdGl2ZSxcbiAgICAgICAgICBhZ2FpbnN0OiBwLmFnYWluc3QsXG4gICAgICAgICAgc2FtZTogcC5kaWZmLnNhbWUsXG4gICAgICAgICAgY29hcnNlOiBwLmRpZmYuY29hcnNlLFxuICAgICAgICAgIGh1bmtzOiBwLmRpZmYuaHVua3MsXG4gICAgICAgICAgdW5pZmllZDogdW5pZmllZChwLmRpZmYsIHtcbiAgICAgICAgICAgIGZyb206IGB2JHtwLmFjdGl2ZX1gLFxuICAgICAgICAgICAgdG86IHNpZGVOYW1lKHAuYWdhaW5zdCwgc2Vzc2lvbi5kb2MocC5kb2MpLm5hbWUpLFxuICAgICAgICAgICAgLi4uKGNtZC5jb250ZXh0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgY29udGV4dDogY21kLmNvbnRleHQgfSksXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QsIGh1bmtzOiBjbWQuaHVua3MgfSk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgdG9vayAke3IuYXBwbGllZH0gY2hhbmdlJHtyLmFwcGxpZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGZyb20gJHtzaWRlTmFtZShjbWQuYWdhaW5zdCwgc2Vzc2lvbi5kb2Moci5zbHVnKS5uYW1lKX0gaW50byB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXJnZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgaHVua3M6IGNtZC5odW5rcywgYnk6IFwiYWdlbnRcIiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBhcHBsaWVkOiByLmFwcGxpZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmaW5kXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmZpbmQoY21kLmZpbHRlcik7XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCBhZGRlZCA9IGFkZFBhdGhzKGNtZC5wYXRocyk7XG4gICAgICAgIHJldHVybiB7IGVudHJpZXM6IGFkZGVkLm1hcCgoYSkgPT4gKHsgLi4uYS5lbnRyeSwgYWRkZWQ6IGEuYWRkZWQgfSkpIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDc6IHRoZSBhZ2VudCBtYXkgbmFtZSBhIGRvYyB0aGUgaHVtYW4gaGFzIG5vdFxuICAgICAgICAvLyBvcGVuZWQsIGJ5IEFCU09MVVRFIHBhdGggKHRoZSBDTEkgcmVzb2x2ZXMgaXQgYWdhaW5zdCBpdHMgb3duIGN3ZCk7XG4gICAgICAgIC8vIGl0IGlzIG9wZW5lZCBpbXBsaWNpdGx5IHVuZGVyIHRoZSBzYW1lIGFkbWlzc2lvbiBydWxlIGFzIHRoZVxuICAgICAgICAvLyBzdXJmYWNlJ3MgYG9wZW5gIOKAlCBhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSDigJQgd2l0aG91dFxuICAgICAgICAvLyBtb3ZpbmcgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICAgICAgaWYgKGNtZC5kb2MgJiYgaXNBYnNvbHV0ZShjbWQuZG9jKSAmJiAhc2Vzc2lvbi5maW5kRG9jKGNtZC5kb2MpKSB7XG4gICAgICAgICAgY29uc3QgbyA9IHNlc3Npb24ub3BlblBhdGgoY21kLmRvYywgeyBmb2N1czogZmFsc2UgfSk7XG4gICAgICAgICAgaWYgKG8uY3JlYXRlZClcbiAgICAgICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJkb2Mub3BlbmVkXCIsXG4gICAgICAgICAgICAgIGRvYzogby5zbHVnLFxuICAgICAgICAgICAgICBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoby5zbHVnKSxcbiAgICAgICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBmcm9tOiBjbWQuZnJvbSxcbiAgICAgICAgICBsYWJlbDogY21kLmxhYmVsLFxuICAgICAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IGNyZWF0ZWQgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7Y21kLmxhYmVsID8gYCDigJQgJHtjbWQubGFiZWx9YCA6IFwiXCJ9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4gfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uLCBmcm9tOiByLnZlcnNpb24uZnJvbSwgcGF0aDogci52ZXJzaW9uLnBhdGggfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiYWdlbnRcIiwgY21kLnRleHQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBpZDogbS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIHJldHVybiBhY3RpdmF0ZShjbWQuZG9jLCBjbWQudmVyc2lvbiwgXCJhZ2VudFwiKTtcbiAgICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgICByZXR1cm4ge307XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoKGNtZCBhcyB7IHR5cGU/OiB1bmtub3duIH0pLnR5cGUpfSDigJQgbm90aGluZyB3YXMgYXBwbGllZGAsXG4gICAgICAgICAgNDAwLFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIFwiY29udGV4dC5hZGRcIixcbiAgICAgICAgICAgIFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAgIFwic2F5XCIsXG4gICAgICAgICAgICBcImFjdGl2YXRlXCIsXG4gICAgICAgICAgICBcImNsb3NlXCIsXG4gICAgICAgICAgICBcIm1ldGFcIixcbiAgICAgICAgICAgIFwiZmluZFwiLFxuICAgICAgICAgICAgXCJncmFwaFwiLFxuICAgICAgICAgICAgXCJiYWNrbGlua3NcIixcbiAgICAgICAgICAgIFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgICBcIm1ldGEuc2V0XCIsXG4gICAgICAgICAgICAuLi5TVFJVQ1RVUkVfT1BTLFxuICAgICAgICAgIF0sXG4gICAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlZnVzYWwgPSAoZTogdW5rbm93bik6IFJlc3BvbnNlID0+IHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICB7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSwgLi4uKGUuY2hvaWNlcyA/IHsgY2hvaWNlczogZS5jaG9pY2VzIH0gOiB7fSkgfSxcbiAgICAgICAgeyBzdGF0dXM6IGUuc3RhdHVzIH0sXG4gICAgICApO1xuICAgIGlmIChlIGluc3RhbmNlb2YgUGF0aEVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlKSB9LCB7IHN0YXR1czogNTAwIH0pO1xuICB9O1xuXG4gIGNvbnN0IGV2ZW50c1Jlc3BvbnNlID0gKHJlcTogUmVxdWVzdCwgdXJsOiBVUkwpOiBSZXNwb25zZSA9PiB7XG4gICAgdG91Y2goKTtcbiAgICByZXR1cm4gc3NlUmVzcG9uc2Uoe1xuICAgICAgbG9nLFxuICAgICAgc2luY2U6IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApLFxuICAgICAgaGVhcnRiZWF0TXM6IFNTRV9IRUFSVEJFQVRfTVMsXG4gICAgICBjbGllbnRzOiBzc2VDbGllbnRzLFxuICAgICAgc2lnbmFsOiByZXEuc2lnbmFsLFxuICAgICAgb25PcGVuOiB0b3VjaCxcbiAgICAgIG9uQ2xvc2U6IHRvdWNoLFxuICAgIH0pO1xuICB9O1xuXG4gIC8vIC0tLSBzZXJ2ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNlcnZlciA9IEJ1bi5zZXJ2ZSh7XG4gICAgcG9ydDogb3B0cy5wb3J0ID8/IDAsXG4gICAgaG9zdG5hbWU6IFwiMTI3LjAuMC4xXCIsXG4gICAgcm91dGVzLFxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWEg4oCUIEEgRk9SRUlHTiBPUklHSU4gSVMgUkVGVVNFRC4gQW55IHdlYiBwYWdlIHRoZVxuICAgICAgLy8gaHVtYW4gdmlzaXRzIGNhbiBvcGVuIGEgV2ViU29ja2V0IG9yIFBPU1QgdG8gMTI3LjAuMC4xOyB0aGUgYnJvd3NlclxuICAgICAgLy8gc2VuZHMgaXRzIE9yaWdpbiwgYW5kIG9ubHkgdGhpcyBkYWVtb24ncyBvd24gcGFnZSBtYXkgZHJpdmUgaXQuIFRoZVxuICAgICAgLy8gQ0xJJ3MgZmV0Y2ggc2VuZHMgbm8gT3JpZ2luIGF0IGFsbCwgc28gaXQgaXMgdW5hZmZlY3RlZC5cbiAgICAgIGlmIChcbiAgICAgICAgKHBhdGggPT09IFwiL3dzXCIgfHwgcGF0aCA9PT0gXCIvY21kXCIgfHwgcGF0aC5zdGFydHNXaXRoKFwiL2ZzL1wiKSkgJiZcbiAgICAgICAgIXNhbWVPcmlnaW4ocmVxLCBzcnYucG9ydClcbiAgICAgIClcbiAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBcImZvcmVpZ24gb3JpZ2luIHJlZnVzZWRcIiB9LCB7IHN0YXR1czogNDAzIH0pO1xuICAgICAgaWYgKHBhdGggPT09IFwiL3dzXCIpXG4gICAgICAgIHJldHVybiBzcnYudXBncmFkZShyZXEpID8gdW5kZWZpbmVkIDogbmV3IFJlc3BvbnNlKFwidXBncmFkZSByZXF1aXJlZFwiLCB7IHN0YXR1czogNDI2IH0pO1xuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvc3RhdGVcIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICBjb25zdCBzdGF0ZSA9IHZpZXdTdGF0ZSgpO1xuICAgICAgICBjb25zdCBmdWxsID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJmdWxsXCIpID09PSBcIjFcIjtcbiAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgIC4uLnN0YXRlLFxuICAgICAgICAgIGNoYXQ6IGZ1bGwgPyBzdGF0ZS5jaGF0IDogc3RhdGUuY2hhdC5zbGljZSgtMTApLFxuICAgICAgICAgIGNoYXRUb3RhbDogc3RhdGUuY2hhdC5sZW5ndGgsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZigpLFxuICAgICAgICAgIGN1cnNvcjogbG9nLmN1cnNvcigpLFxuICAgICAgICAgIGVwb2NoOiBsb2cuZXBvY2gsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHJldHVybiBldmVudHNSZXNwb25zZShyZXEsIHVybCk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9mcy92ZXJzaW9uXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZWFkVmVyc2lvbihcbiAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZG9jXCIpID8/IFwiXCIsXG4gICAgICAgICAgICBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJ2XCIpID8/IFwiXCIsIDEwKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHIpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIHJlZnVzYWwoZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL2xpc3RcIikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAgIGVudHJpZXM6IGxpc3REaXIoZXhwYW5kSG9tZSh1cmwuc2VhcmNoUGFyYW1zLmdldChcInBhdGhcIikgPz8gXCJ+XCIpKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpXG4gICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgLnRoZW4oKGIpID0+IHtcbiAgICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlLCAuLi5oYW5kbGVBZ2VudENtZChiIGFzIEFnZW50Q21kKSB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzYWwoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goKCkgPT4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICBjb25zdCBhc3NldCA9IHNlcnZlRGlzdChwYXRoKTtcbiAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gYXNzZXQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgfSxcbiAgICB3ZWJzb2NrZXQ6IHtcbiAgICAgIG9wZW4od3MpIHtcbiAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSkpO1xuICAgICAgfSxcbiAgICAgIG1lc3NhZ2Uod3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICBsZXQgbXNnOiBDbGllbnRNc2c7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbXNnID0gSlNPTi5wYXJzZShcbiAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICApIGFzIENsaWVudE1zZztcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogYmFkIGpzb24gZnJvbSBicm93c2VyOiAke2V9XFxuYCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGFuZGxlQ2xpZW50TXNnKHdzLCBtc2cpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gQSByZWZ1c2FsIHRoZSBodW1hbiBjYXVzZWQgKGVkaXQgYSBub24tYWN0aXZlIHZlcnNpb24sIG9wZW4gYVxuICAgICAgICAgIC8vIHZhbmlzaGVkIGZpbGUpIHJlYWNoZXMgVEhFTSwgYXMgYSBjaGF0LXZpc2libGUgc3lzdGVtIGxpbmUgd291bGQgYmVcbiAgICAgICAgICAvLyB0b28gbG91ZCBmb3IgYSBrZXlzdHJva2Ug4oCUIHNvIGl0IGlzIGFuIGVycm9yIGZyYW1lIHRoZSBzdXJmYWNlIHNob3dzLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgY2xvc2Uod3MpIHtcbiAgICAgICAgc29ja2V0cy5kZWxldGUod3MpO1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBib3VuZFBvcnQgPSBzZXJ2ZXIucG9ydDtcbiAgLy8gLS0tIGRpc2NvdmVyeSAoRTEzOiBzZXNzaW9uLUpTT04sIHRoZSBvbmx5IGNvbnZlbnRpb24gdGhhdCBjYW4gZXhwcmVzcyBzZXZlcmFsKSAtLVxuICBjb25zdCBzZXNzaW9uRmlsZSA9IGpvaW4odG1wZGlyKCksIGBzY3JpcHRvcml1bS0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7Ym91bmRQb3J0fWAsXG4gICAgcG9ydDogYm91bmRQb3J0LFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICBob21lLFxuICAgIGRpcjogc2Vzc2lvbi5kaXIsXG4gICAgbW9kZSxcbiAgfSk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgc3luY1dhdGNoZXJzKCk7XG4gIC8vIOKaoCBUSEUgU0VTU0lPTiBTQVlTIFdIQVQgSVRTIE9XTiBUSU1FT1VUIElTLiBgLS10aW1lb3V0IDBgIGhhcyBhbHdheXMgbWVhbnRcbiAgLy8gXCJzdGFuZCB1bnRpbCBjbG9zZWRcIiBhbmQgdGhlcmUgd2FzIG5vIHdheSB0byBjb25maXJtIGZyb20gb3V0c2lkZSB0aGF0IGFcbiAgLy8gZGFlbW9uIGhhZCB0YWtlbiBpdCDigJQgd2hpY2ggaXMgdGhlIGtpbmQgb2Ygc2V0dGluZyB5b3UgZmluZCBvdXQgYWJvdXQgYnlcbiAgLy8gbG9zaW5nIGEgc2Vzc2lvbiBhdCB0aGUgd3JvbmcgbW9tZW50LlxuICBsb2cuZW1pdCh7XG4gICAgdHlwZTogXCJyZWFkeVwiLFxuICAgIG1vZGUsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHJlc3RvcmVkOiAhIW9wdHMucmVzdG9yZSxcbiAgICBpZGxlX3RpbWVvdXRfczogb3B0cy50aW1lb3V0UyA/PyAxODAwLFxuICB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDI6IHdoYXQgY2hhbmdlZCBvbiBkaXNrIHdoaWxlIG5vIGRhZW1vbiB3YXMgd2F0Y2hpbmcuXG4gIGZvciAoY29uc3QgZiBvZiBzZXNzaW9uLnJlc3RvcmVGaW5kaW5ncylcbiAgICBhbm5vdW5jZShcbiAgICAgIGYubWlzc2luZ1xuICAgICAgICA/IGAke2Yub3JpZ2luYWx9IGlzIGdvbmUgZnJvbSBkaXNrIHNpbmNlIHRoaXMgc2Vzc2lvbiB3YXMgbGFzdCBvcGVuLiBTYXZlIHdvdWxkIHJlY3JlYXRlIGl0OyBSZXZlcnQgY2Fubm90IHJ1bi5gXG4gICAgICAgIDogYCR7Zi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgY2xvc2VkLiBTYXZlIG92ZXJ3cml0ZXMgaXQgd2l0aCB0aGUgYWN0aXZlIHZlcnNpb247IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgIHsgZmFjdDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGYuZG9jLCB3aGlsZUNsb3NlZDogdHJ1ZSB9LFxuICAgICk7XG5cbiAgLyoqXG4gICAqIEU1MydzIGF0dGVudGlvbiB0aWNrLiBTZXBhcmF0ZSBmcm9tIGhvdXNla2VlcGluZyBiZWNhdXNlIGl0IGlzIGFib3V0IHRoZVxuICAgKiBIVU1BTidzIHBhdGllbmNlIHJhdGhlciB0aGFuIHRoZSBkYWVtb24ncyBsaWZldGltZSwgYW5kIGJlY2F1c2UgaXQgbXVzdCBydW5cbiAgICogb24gYSBzbG93ZXIgY2xvY2s6IGEgMjUwIG1zIHN3ZWVwIHJlLWJyb2FkY2FzdGluZyBzdGF0ZSB3b3VsZCBiZSBjaHVybiBmb3IgYVxuICAgKiB2YWx1ZSB0aGF0IGNoYW5nZXMgdHdpY2UgaW4gYSB3YWl0LlxuICAgKi9cbiAgbGV0IGxhc3RXYWl0aW5nOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgYXR0ZW50aW9uVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3QgdyA9IHdhaXRpbmdPbihzZXNzaW9uLm1lc3NhZ2VzKCksIERhdGUubm93KCksIHsgYWNrbm93bGVkZ2VkVW50aWwgfSk7XG4gICAgY29uc3Qga2V5ID0gdyA/IGAke3cubWVzc2FnZUlkfToke3cuYmFkZ2V9YCA6IG51bGw7XG4gICAgaWYgKGtleSA9PT0gbGFzdFdhaXRpbmcpIHJldHVybjtcbiAgICBsYXN0V2FpdGluZyA9IGtleTtcbiAgICAvLyBUaGUgYmFkZ2UgY2hhbmdlZCwgc28gdGhlIHN1cmZhY2UgbmVlZHMgdGhlIG5ldyBzbmFwc2hvdC5cbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIGlmICghdykgcmV0dXJuO1xuICAgIGlmICh3LmJhZGdlICE9PSBcInN0YWxsZWRcIiB8fCBudWRnZWQuaGFzKHcubWVzc2FnZUlkKSkgcmV0dXJuO1xuICAgIG51ZGdlZC5hZGQody5tZXNzYWdlSWQpO1xuICAgIC8vIOKblCBUSEUgTlVER0UgR09FUyBUTyBUSEUgQUdFTlQnUyBUQUlMIEFORCBOT1dIRVJFIEVMU0UuIFRoZSBodW1hbiBhbHJlYWR5XG4gICAgLy8gc2VlcyB0aGUgYmFkZ2U7IHB1dHRpbmcgdGhpcyBpbiB0aGUgY2hhdCBhcyB3ZWxsIHdvdWxkIGJlIHRlbGxpbmcgdGhlbVxuICAgIC8vIHdoYXQgdGhleSBhcmUgbG9va2luZyBhdC4gSXQgY2FycmllcyB0aGUgbWVzc2FnZSBURVhUIGJlY2F1c2UgYW4gYWdlbnRcbiAgICAvLyB0aGF0IGhhcyBiZWVuIGF3YXkgbmVlZHMgdG8ga25vdyB3aGF0IGlzIHBlbmRpbmcsIG5vdCBqdXN0IHRoYXQgc29tZXRoaW5nXG4gICAgLy8gaXMg4oCUIGFuZCBpdCBuYW1lcyB0aGUgdHdvIHdheXMgb3V0LCBiZWNhdXNlIGEgbnVkZ2UgdGhhdCBkb2VzIG5vdCBzYXkgaG93XG4gICAgLy8gdG8gYW5zd2VyIGl0IGludml0ZXMgYSBmb3VydGggcHJpbWl0aXZlLlxuICAgIGNvbnN0IHBlbmRpbmcgPSBzZXNzaW9uLm1lc3NhZ2VzKCkuZmluZCgobSkgPT4gbS5pZCA9PT0gdy5tZXNzYWdlSWQpO1xuICAgIGxvZy5lbWl0KHtcbiAgICAgIHR5cGU6IFwid2FpdGluZ1wiLFxuICAgICAgbWVzc2FnZV9pZDogdy5tZXNzYWdlSWQsXG4gICAgICBzZWNvbmRzOiBNYXRoLnJvdW5kKChEYXRlLm5vdygpIC0gdy5zaW5jZSkgLyAxMDAwKSxcbiAgICAgIC4uLihwZW5kaW5nID8geyB0ZXh0OiBwZW5kaW5nLnRleHQgfSA6IHt9KSxcbiAgICAgIGhpbnQ6IFwicmVwbHkgd2l0aCBgc2F5YCwgb3IgYHdvcmtpbmdgIHRvIHNheSB5b3UgYXJlIHN0aWxsIG9uIGl0XCIsXG4gICAgfSk7XG4gIH0sIDEwMDApO1xuXG4gIGNvbnN0IHN0b3BIb3VzZWtlZXBpbmcgPSBzdGFydEhvdXNla2VlcGluZyh7XG4gICAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUsXG4gICAgaWRsZU1zOiAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSxcbiAgICB0b3VjaCxcbiAgICB0aW1lb3V0TXM6IChvcHRzLnRpbWVvdXRTID8/IDE4MDApICogMTAwMCxcbiAgICBvbklkbGVDbG9zZTogKCkgPT4gcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSksXG4gIH0pO1xuXG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgbGV0IHJlc29sdmVTaHV0ZG93biE6ICgpID0+IHZvaWQ7XG4gIGNvbnN0IHNodXRkb3duID0gbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHtcbiAgICByZXNvbHZlU2h1dGRvd24gPSByO1xuICB9KTtcblxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvLyBUaGUgb3JkZXIgaXMgdGhlIGhlYWRlcidzLCBhbmQgdGhlIGhlYWRlciBzYXlzIHdoeS5cbiAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgc3RvcEhvdXNla2VlcGluZygpO1xuICAgIGNsZWFySW50ZXJ2YWwoYXR0ZW50aW9uVGltZXIpO1xuICAgIGZvciAoY29uc3QgdyBvZiB3YXRjaGVycy52YWx1ZXMoKSkgdy5jbG9zZSgpO1xuICAgIHdhdGNoZXJzLmNsZWFyKCk7XG4gICAgZm9yIChjb25zdCB0IG9mIHBlbmRpbmcudmFsdWVzKCkpIGNsZWFyVGltZW91dCh0KTtcbiAgICB0cnkge1xuICAgICAgc2Vzc2lvbi5wZXJzaXN0KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBkaXI6IHNlc3Npb24uZGlyLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLyoqIEFuIGFic2VudCBPcmlnaW4gKHRoZSBDTEksIGN1cmwpIG9yIHRoaXMgZGFlbW9uJ3Mgb3duIHBhZ2U7IG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW1lT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGNvbnN0IG9yaWdpbiA9IHJlcS5oZWFkZXJzLmdldChcIm9yaWdpblwiKTtcbiAgaWYgKG9yaWdpbiA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBvcmlnaW4gPT09IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gIHx8IG9yaWdpbiA9PT0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWA7XG59XG5cbi8qKlxuICogQSBwYXRoIHR5cGVkIGluIHRoZSBTVVJGQUNFLiBUaGUgcGFnZSBoYXMgbm8gd29ya2luZyBkaXJlY3RvcnksIHNvIGEgcGF0aFxuICogZnJvbSBpdCBtdXN0IGJlIGFic29sdXRlIG9yIHN0YXJ0IGF0IGB+YCDigJQgd2hpY2ggaXMgZXhwYW5kZWQgSEVSRS4gQmVmb3JlXG4gKiB0aGlzLCBgfi9Eb2N1bWVudHNgIHJlYWNoZWQgYHJlc29sdmUoKWAgYW5kIHdhcyB0YWtlbiBhcyByZWxhdGl2ZSB0byB0aGVcbiAqIGRhZW1vbidzIGN3ZCAodGhlIHNraWxsIGZvbGRlcik6IHRoZSBwYXRoIGJveCBjb21wbGV0ZWQgYH4v4oCmYCAobGlzdGluZ1xuICogZXhwYW5kcyBpdCkgYW5kIHRoZW4gRW50ZXIgZmFpbGVkIHdpdGggXCJubyBzdWNoIGZpbGUgb3IgZm9sZGVyOlxuICog4oCmL3NraWxscy9zY3JpcHRvcml1bS9+L0RvY3VtZW50cy/igKZcIiAoQ29sZSwgMjAyNi0wOS0xMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdXJmYWNlUGF0aChwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0ID0gcC50cmltKCk7XG4gIGlmICh0ID09PSBcIn5cIiB8fCB0LnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGV4cGFuZEhvbWUodCk7XG4gIGlmICghaXNBYnNvbHV0ZSh0KSlcbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBcIiR7cH1cIiBpcyBub3QgYSBmdWxsIHBhdGgg4oCUIHN0YXJ0IGl0IHdpdGggLyBvciB+L2AsIDQwMCk7XG4gIHJldHVybiByZXNvbHZlKHQpO1xufVxuXG4vKiogQSBzdHJ1Y3R1cmUgb3AgZnJvbSB0aGUgc3VyZmFjZSwgd2l0aCBldmVyeSBwYXRoIGZpZWxkIHRocm91Z2ggYHN1cmZhY2VQYXRoYC4gKi9cbmZ1bmN0aW9uIGFuY2hvclN1cmZhY2VQYXRocyhvcDogU3RydWN0dXJlT3ApOiBTdHJ1Y3R1cmVPcCB7XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLm9wIH07XG4gIGZvciAoY29uc3QgayBvZiBbXCJkaXJcIiwgXCJwYXRoXCIsIFwiaW50b1wiXSBhcyBjb25zdClcbiAgICBpZiAodHlwZW9mIG91dFtrXSA9PT0gXCJzdHJpbmdcIikgb3V0W2tdID0gc3VyZmFjZVBhdGgob3V0W2tdIGFzIHN0cmluZyk7XG4gIHJldHVybiBvdXQgYXMgU3RydWN0dXJlT3A7XG59XG5cbmZ1bmN0aW9uIGV4cGFuZEhvbWUocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHAgPT09IFwiflwiKSByZXR1cm4gaG9tZWRpcigpO1xuICBpZiAocC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBqb2luKGhvbWVkaXIoKSwgcC5zbGljZSgyKSk7XG4gIHJldHVybiByZXNvbHZlKHApO1xufVxuXG4vKiogVGhlIGRhZW1vbidzIHByaXZhdGUgYXJndiDigJQgdGhlIENMSSBzcGF3bnMgaXQgd2l0aCBleGFjdGx5IHRoZXNlLiAqL1xuY29uc3QgREFFTU9OX09QVElPTlMgPSB7XG4gIGxvZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHdvcmtzcGFjZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG4vKiogUGFyc2UgdGhlIGRhZW1vbidzIGFyZ3YsIGJvb3QsIHByaW50IHRoZSBoYW5kc2hha2UsIHdhaXQgZm9yIHRoZSBlbmQuIFJldHVybnMgdGhlIGV4aXQgY29kZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICB0cnkge1xuICAgIGZsYWdzID0gbm9kZVBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IERBRU1PTl9PUFRJT05TLCBzdHJpY3Q6IHRydWUgfSkudmFsdWVzIGFzIFJlY29yZDxcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyB8IHVuZGVmaW5lZFxuICAgID47XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBzY3JpcHRvcml1bTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKFxuICAgICAgICBEQUVNT05fT1BUSU9OUyxcbiAgICAgIClcbiAgICAgICAgLm1hcCgoaykgPT4gYC0tJHtrfWApXG4gICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgbGV0IGQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2Ygc3RhcnREYWVtb24+PjtcbiAgdHJ5IHtcbiAgICBkID0gYXdhaXQgc3RhcnREYWVtb24oe1xuICAgICAgcG9ydDogZmxhZ3MucG9ydCA/IE51bWJlcihmbGFncy5wb3J0KSA6IDAsXG4gICAgICByZXN0b3JlOiBmbGFncy5yZXN0b3JlLFxuICAgICAgdGltZW91dFM6IGZsYWdzLnRpbWVvdXQgPyBOdW1iZXIoZmxhZ3MudGltZW91dCkgOiB1bmRlZmluZWQsXG4gICAgICB3b3Jrc3BhY2U6IGZsYWdzLndvcmtzcGFjZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIFRoZSBoYW5kc2hha2UgbGluZSBpcyBKU09OIGVpdGhlciB3YXksIHNvIHRoZSBDTEkgcmVhZHMgT05FIHNoYXBlLlxuICAgIGNvbnN0IHN0YXR1cyA9IGUgaW5zdGFuY2VvZiBTZXNzaW9uRXJyb3IgPyBlLnN0YXR1cyA6IDUwMDtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBzdGF0dXMsIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSl9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiBzdGF0dXMgPT09IDQwNCA/IDUgOiBzdGF0dXMgPT09IDQwOSA/IDYgOiAxO1xuICB9XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2QucG9ydH1gLCBwb3J0OiBkLnBvcnQsIHNlc3Npb25faWQ6IGQuc2Vzc2lvbklkLCBtb2RlOiBkLm1vZGUsIGRpcjogZC5kaXIgfSl9XFxuYCxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZC5kb25lO1xuICBhd2FpdCBkLnNodXRkb3duO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogYSBjbGVhbiBjbG9zZSBsZWF2ZXMgbm8gZW1wdHkgbG9nIGJlaGluZC5cbiAgaWYgKHJlcy5jb2RlID09PSAwICYmIGZsYWdzLmxvZykge1xuICAgIHRyeSB7XG4gICAgICBpZiAoc3RhdFN5bmMoZmxhZ3MubG9nKS5zaXplID09PSAwKSB1bmxpbmtTeW5jKGZsYWdzLmxvZyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlcy5jb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZVxuICogYnVuZGxlLCBzbyB0aGVyZSBpcyBubyBzdWNoIGJsb2NrIGhlcmUsIGFuZCB0aGlzIHRha2VzIG5vIGFyZ3VtZW50czogdGhlXG4gKiBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSB0d28gcHJpbWl0aXZlcyB1bmRlciBCT1RIIG9mIHRoZSBob3VzZSdzIGRhZW1vbi1kaXNjb3ZlcnkgY29udmVudGlvbnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBEMyBydWxlZCB0aGF0IHRoZSBjb252ZW50aW9ucyB0aGVtc2VsdmVzIOKAlCBwZXItc2Vzc2lvbiB0bXBkaXIgSlNPTiAoYm91bnR5LFxuICogZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZSkgYW5kIHNpbmdsZXRvbiBgJEhPTUUvZGFlbW9uLnBvcnRgICsgYGRhZW1vbi5waWRgXG4gKiAoYXN0cm9sYWJlLCBncmFwZXZpbmUsIG1pbmQtbWFwcGVyKSDigJQgYm90aCBzdXJ2aXZlLCBiZWNhdXNlIHRoZXkgZW5jb2RlXG4gKiBnZW51aW5lbHkgZGlmZmVyZW50IG1vZGVscyAoY29uY3VycmVudCBzZXNzaW9ucyB2cyBhIHN0YW5kaW5nIHNpbmdsZXRvbikgYW5kXG4gKiBwaWNraW5nIG9uZSBpcyBhIHByb2R1Y3QgZGVjaXNpb24sIG5vdCBhIGZhY3RvcmluZyBvbmUuIFdoYXQgSVMgb25lXG4gKiBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgcGFpciBiZWxvdywgd2hpY2ggaXMgYWxzbyBleGFjdGx5IHdoZXJlIGNlbnN1cyBkZWZlY3RcbiAqICoqTDMqKiBsaXZlcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKlxuICogV3JpdGUgYHRleHRgIHRvIGB0YXJnZXRgIGF0b21pY2FsbHk6IHdyaXRlIGJlc2lkZSBpdCwgdGhlbiByZW5hbWUuXG4gKlxuICog4puUICoqTDMsIENMT1NFRCBCWSBDT05TVFJVQ1RJT04uKiogQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljLCBzbyBhXG4gKiBDTEkgcmVhZGluZyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIEhBTEYtV1JJVFRFTiBwb2ludGVyLiBVbmRlclxuICogYSBiZXN0LWVmZm9ydCByZWFkZXIgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiIOKAlCBhYnNlbmNlIHJlcG9ydGVkXG4gKiBmb3Igd2hhdCB3YXMgcmVhbGx5IGEgdG9ybiByZWFkLCB3aGljaCBpcyB0aGUgZXhhY3QgY29uZmxhdGlvbiB0aGUgaG91c2Unc1xuICogYG51bGxgLW5vdC1gMGAgcnVsZSBleGlzdHMgdG8gcHJldmVudC4gUmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYyxcbiAqIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLCBuZXZlciBhIHBhcnRpYWxcbiAqIGZpbGUuXG4gKlxuICogRml4ZWQgaW4gZ2xhbW91ciAyMDI2LTA5LTA3LCBmb3VuZCBzdGFuZGluZyBpbiB0aHJlZSBzaWJsaW5ncyB0aGUgbmV4dCBkYXkgYnlcbiAqIHRoZSBkdXBsaWNhdGlvbiByZWNvbiwgYW5kIHJlcGFpcmVkIGluIGFsbCBvZiB0aGVtIHRoZSBvbmx5IHdheSB0aGF0IGRvZXMgbm90XG4gKiBuZWVkIGZpbmRpbmcgYWdhaW46IHRoZXJlIGlzIG5vdyBvbmUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4pqgIFRoZSB0ZW1wIG5hbWUgY2FycmllcyB0aGUgcGlkLCBzbyB0d28gZGFlbW9ucyByYWNpbmcgdG8gcHVibGlzaCB0aGUgc2FtZVxuICogcG9pbnRlciBjYW5ub3QgY2xvYmJlciBlYWNoIG90aGVyJ3MgaW50ZXJtZWRpYXRlIGZpbGUg4oCUIGFuZCBpdCBpcyByZW1vdmVkIG9uXG4gKiBhIGZhaWxlZCB3cml0ZSByYXRoZXIgdGhhbiBsZWZ0IGFzIGxpdHRlciBiZXNpZGUgdGhlIHJlYWwgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVGaWxlQXRvbWljKHRhcmdldDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModG1wLCB0ZXh0KTtcbiAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiB0aGUgdGVtcCBmaWxlIGlzIGFscmVhZHkgZ29uZSwgb3Igd2FzIG5ldmVyIGNyZWF0ZWQgKi9cbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogRGVsZXRlIGBwYXRoYCBpZmYgaXQgc3RpbGwgbmFtZXMgVVMuIFJldHVybnMgd2hldGhlciBpdCB3YXMgZGVsZXRlZC5cbiAqXG4gKiDim5QgKipcIlNUSUxMIE9VUlNcIiBJUyBUSEUgV0hPTEUgRlVOQ1RJT04uKiogQSBkYWVtb24gdGhhdCB1bmxpbmtzIGl0cyBkaXNjb3ZlcnlcbiAqIGZpbGUgdW5jb25kaXRpb25hbGx5IGF0IGV4aXQgZGVsZXRlcyB0aGUgcG9pbnRlciBhIFNVQ0NFU1NPUiBoYXMgYWxyZWFkeVxuICogd3JpdHRlbiDigJQgdGhlIHN1Y2Nlc3NvciBjYW4gdGhlbiBubyBsb25nZXIgYmUgZm91bmQgYW5kIHRoZSBuZXh0IENMSSB2ZXJiIHNwYXducyBhXG4gKiB0aGlyZCBkYWVtb24uIEJvdGggY29udmVudGlvbnMgaGF2ZSB0aGlzIGhhemFyZCBhbmQgYm90aCBleHByZXNzIGl0XG4gKiBkaWZmZXJlbnRseTogYXN0cm9sYWJlIGNvbXBhcmVzIHRoZSBwaWQgZmlsZSdzIGJ5dGVzIHRvIGl0cyBvd24gcGlkLFxuICogbWFncGllIHBhcnNlcyB0aGUgSlNPTiBwb2ludGVyIGFuZCBjb21wYXJlcyBgc2Vzc2lvbl9pZGAuIGBpZGVudGlmeWAgaXMgd2hhdFxuICogbWFrZXMgdGhvc2Ugb25lIGZ1bmN0aW9uIOKAlCBpdCB0dXJucyB0aGUgZmlsZSdzIGJ5dGVzIGludG8gdGhlIGlkZW50aXR5IHRvXG4gKiBjb21wYXJlLCBhbmQgaXQgZGVmYXVsdHMgdG8gdGhlIHRyaW1tZWQgYnl0ZXMgdGhlbXNlbHZlcy5cbiAqXG4gKiDimqAgRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgYW5kIHJlcG9ydGVkIGFzIGBmYWxzZWA6IHRoZSBmaWxlIGJlaW5nIGdvbmUsXG4gKiB1bnJlYWRhYmxlLCBvciB1bnBhcnNlYWJsZSBhbGwgbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlIOKAlCBpdCBpcyBub3Qgb3VycyB0b1xuICogcmVtb3ZlLiBBbiB1bnBhcnNlYWJsZSBwb2ludGVyIGlzIGRlbGliZXJhdGVseSBOT1QgdHJlYXRlZCBhcyBvdXJzLCB3aGljaCBpc1xuICogdGhlIGNvbnNlcnZhdGl2ZSBoYWxmIG9mIHRoZSBzYW1lIGBudWxsYC1ub3QtYDBgIHJ1bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxpbmtJZk1hdGNoZXMoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IHN0cmluZyxcbiAgaWRlbnRpZnk6IChyYXc6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbCA9IChyYXcpID0+IHJhdy50cmltKCksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaWRlbnRpZnkocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgIT09IGV4cGVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdW5saW5rU3luYyhwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGluLXByb2Nlc3MgZXZlbnQgbG9nIOKAlCB0aGUgYXBwZW5kLW9ubHksIHJlcGxheWFibGUgYnVmZmVyXG4gKiBiZWhpbmQgZXZlcnkgc3BlbGwncyBgR0VUIC9ldmVudHNgIFNTRSB0YWlsLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3NcbiAqIGBzY3JpcHRzL2V2ZW50cy50c2Ag4oCUIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzIsIGFuZCB0aGUgb25seSBvbmUgb2ZcbiAqIHRoZSBzaXggY29waWVkLWluLXBsYWNlIGJ1c2VzIHRoYXQgaXMgYSBtb2R1bGUsIGlzIGJvdW5kZWQsIGNhcnJpZXMgYW4gZXBvY2gsIGFuZCBpc1xuICogdW5pdC10ZXN0ZWQuIFRoZSBmaXZlIG90aGVycyBhcmUgdGhlIHNhbWUgdHdlbnR5IGxpbmVzIHdyaXR0ZW4gZml2ZSB0aW1lcy5cbiAqXG4gKiDilIDilIAgVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIOKAlCBUV08gQlkgQ09OU1RSVUNUSU9OLCBPTkUgQlkgT1BULUlOIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIOKblCBUSEUgSEVBRElORyBVU0VEIFRPIFNBWSBcIlRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyBCWSBDT05TVFJVQ1RJT05cIiBBTkRcbiAqIElURU0gMiBJUyBOT1QgT05FIE9GIFRIRU0uIENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIG1pbmQtbWFwcGVyJ3MgcHJlLXdvcmtcbiAqIChENzkpOiBgZXBvY2hgIGlzIE9QVElPTkFMIGhlcmUsIHNvIEw2IGlzIGNsb3NlZCBvbmx5IGZvciBhIGNhbGxlciB0aGF0IGFza3MuXG4gKiBUaHJlZSBhZG9wdGVycyBoYXZlIHNpbmNlIGRlY2xpbmVkIHRvIOKAlCBpbWFnbyAoRDM5KSwgYm91bnR5IChENDgpIGFuZFxuICogZ3JhcGV2aW5lIChENzApIOKAlCBzbyB0aGUgZGVmZWN0IHRoZSBoZWFkaW5nIGNsYWltZWQgdG8gbWFrZSBpbXBvc3NpYmxlIGlzXG4gKiBsaXZlIGluIHRoZSB0cmVlLCBieSBvcHQtb3V0LCBhbmQgdGhlIG92ZXJjbGFpbSBpcyB3aGF0IGhpZCB0aGF0LiBJdGVtcyAxIGFuZFxuICogMyBBUkUgYnkgY29uc3RydWN0aW9uOiBhIGNhbGxlciBjYW5ub3Qgc3dpdGNoIHRoZSBjYXAgb2ZmIG9yIHJlYWNoIHRoZSBidWZmZXIuXG4gKlxuICog4pqgIEFORCBNSU5ELU1BUFBFUidTIE9XTiBCVVMsIFdISUNIIFRISVMgTU9EVUxFIENPTlZFUkdFRCBUT1dBUkQsIFRZUEVTIFRIRVxuICogRVBPQ0ggQVMgUkVRVUlSRUQgYW5kIHN0YW1wcyBpdCB1bmNvbmRpdGlvbmFsbHkg4oCUIGl0IGlzIHRoZSBzcGVsbCBjZW5zdXMgTDZcbiAqIG5hbWVzIGFzIENPUlJFQ1QuIE1ha2luZyBpdCByZXF1aXJlZCBIRVJFIGlzIG5vdCB0aGUgcmVwYWlyOiBpdCB3b3VsZCByZXZlcnNlXG4gKiBEMzksIEQ0OCBhbmQgRDcwLiBUaGUgaG9uZXN0IHN0YXRlbWVudCBpcyB0aGlzIGhlYWRpbmcuXG4gKlxuICog4puUICoqUkVTT0xWRUQgQVQgVEhBVCBTUEVMTCdTIFBPUlQsIEFORCBUSEUgRElTUE9TSVRJT04gSVMgUkVDT1JERUQgSEVSRVxuICogQkVDQVVTRSBBIExPU1MgVEhBVCBMSVZFUyBPTkxZIElOIEEgSk9VUk5BTCBJUyBBIExPU1MgTk9CT0RZIENBTiBTRUVcbiAqIChENzkvRDg1KS4qKiBtaW5kLW1hcHBlciBhZG9wdGVkIHRoaXMgbW9kdWxlIGluIFBoYXNlIDcgYW5kIGtlcHQgaXRzXG4gKiBndWFyYW50ZWUgV0lUSE9VVCBBIEtJVCBDSEFOR0U6IGl0IHBhc3NlcyBgeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9YCBhdFxuICogaXRzIE9ORSBjb25zdHJ1Y3Rpb24gc2l0ZSBhbmQgcmUtdGlnaHRlbnMgYGVwb2NoYCB0byBSRVFVSVJFRCBpbiBpdHMgb3duXG4gKiBsb2NhbCBmcmFtZSB0eXBlLCBzbyBub3RoaW5nIGl0cyBidXMgZW1pdHMgY2FuIGxhY2sgb25lLiBLaXQgYnl0ZXM6IHplcm8uXG4gKiAqKlNvIHRoZSBlcG9jaCBpcyBhIExPU1NZLUNPUFkgcHJvcGVydHkgd2hvc2UgZGlzcG9zaXRpb24gaXMgS0VFUC1MT0NBTCwgbm90XG4gKiBSRVNUT1JFKiog4oCUIHRoZSBvbmx5IHByb3BlcnR5IG9mIHRoYXQgc3BlbGwncyBvd24gbW9kdWxlIHRoaXMgbW9kdWxlIGNvdWxkXG4gKiBub3QgY2FycnkgYW5kIGRpZCBub3QgbmVlZCB0by4gTDYgaXMgQ0xPU0VEIGZvciB0aGUgdHdvIHNwZWxscyB0aGF0IGFzayBhbmRcbiAqIE9QRU4sIGJ5IG9wdC1vdXQsIGZvciB0aGUgdGhyZWUgdGhhdCBkZWNsaW5lOyB0aGF0IGFzeW1tZXRyeSBpcyB0aGUgaG9uZXN0XG4gKiBzdGF0ZSBhbmQgdGhpcyBoZWFkaW5nIGlzIHdoZXJlIGl0IGlzIHdyaXR0ZW4uXG4gKlxuICog4pqgICoqQU5EIFRIRSBBRE9QVElPTiBSRU5BTUVTIEEgRklFTEQgT04gQU4gQURPUFRFUidTIFBVQkxJU0hFRCBXSVJFLioqIGBpZGBcbiAqIGlzIG5hbWVkIGluIGBGcmFtZTxUPmAgYW5kIGluIHRoZSBlbWl0IGxpdGVyYWwgYmVsb3csIHNvIGEgc3BlbGwgd2hvc2UgYnVzXG4gKiBzcGVsbGVkIHRoZSBjdXJzb3IgYW55dGhpbmcgZWxzZSBwYXlzIGEgcmVuYW1lIGF0IGV2ZXJ5IHJlYWRlciDigJQgZm9yXG4gKiBtaW5kLW1hcHBlciwgMTczIG9jY3VycmVuY2VzIGFjcm9zcyA1IHN1cmZhY2UgZmlsZXMsIH4yMDkgYWNyb3NzIH4zMCBiYWNrZW5kXG4gKiBmaWxlcywgZXZlcnkgSlNPTkwgbGluZSBpdHMgYHRhaWxgIHdyaXRlcyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgYW5kICh0aGUgb25lXG4gKiBub2JvZHkgY291bnRlZCkgdGhlIEZJWFRVUkUgaW4gaXRzIG93biBgdGFpbC50ZXN0LnRzYCwgd2hpY2ggV1JJVEVTIHRoZVxuICogZW52ZWxvcGUgd2hpbGUgc3RhbmRpbmcgaW4gZm9yIHRoZSBkYWVtb24uIFRoZSBORVNUSU5HIGlzIG5vdCBmb3JjZWQg4oCUXG4gKiBgRnJhbWU8VD5gIGlzIGdlbmVyaWMsIGFuZCBtaW5kLW1hcHBlciBrZXB0IGB7a2luZCwgcGF5bG9hZH1gIG5lc3RlZCB3aGVyZSBhbGxcbiAqIGZpdmUgZWFybGllciBhZG9wdGVycyBmbGF0dGVuIGJ5IGlkaW9tLiAqKkFuIGlkaW9tIGZpdmUgc2libGluZ3Mgc2hhcmUgaXNcbiAqIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBjb250cmFjdCB1bnRpbCB5b3Ugb3BlbiB0aGUgdHlwZSoqIChEODEsIEQ4NikuXG4gKlxuICogKioxIMK3IEw1IOKAlCB0aGUgYnVmZmVyIGlzIGJvdW5kZWQuKiogRml2ZSBkYWVtb25zIGFwcGVuZCB0byBhbiBhcnJheSBmb3IgdGhlXG4gKiB3aG9sZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBUaGUgd2luZG93IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiBkYWVtb24ncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2c7IGEgY2FwIGlzIHRoZSBob25lc3Qgc2hhcGUuXG4gKlxuICogKioyIMK3IEw2IOKAlCBhIGZyYW1lIGNhcnJpZXMgYW4gZXBvY2gsIFdIRU4gVEhFIENBTExFUiBBU0tTIEZPUiBPTkUgKG9wdC1pbixcbiAqIG5vdCBjb25zdHJ1Y3Rpb24g4oCUIHNlZSBhYm92ZSkuKiogQWZ0ZXIgYSByZXN0YXJ0IHRoZSBpZHMgc3RhcnQgYWdhaW4gYXQgMSwgc29cbiAqIGEgcmVzdW1pbmcgY2xpZW50IGNhbm5vdCB0ZWxsIGEgc3RhbGUgd2F0ZXJtYXJrIGZyb20gYSBmcmVzaCBvbmUgYnkgaWQgYWxvbmUuXG4gKlxuICogKiozIMK3IEEgU1RBTEUgV0FURVJNQVJLIFJFUExBWVMgRlJPTSBUSEUgQkVHSU5OSU5HLCBhbmQgdGhpcyBpcyB0aGUgaGFsZiB0aGVcbiAqIGNsaWVudCBjYW5ub3QgZG8uKiogTUVBU1VSRUQgb24gYXN0cm9sYWJlOiBhIHRhaWwgdGhhdCByZXN1bWVzIGF0XG4gKiBgc2luY2U9PGxhc3QgaWQgb2YgdGhlIHByZXZpb3VzIGRhZW1vbj5gIGFnYWluc3QgYSByZXN0YXJ0ZWQgZGFlbW9uIHJlY2VpdmVzXG4gKiBOT1RISU5HIOKAlCB0aGUgbmV3IGRhZW1vbidzIGByZWFkeWAgaXMgaWQgMSwgd2hpY2ggaXMgbm90IGA+IHNpbmNlYCwgc28gdGhlXG4gKiBmaWx0ZXIgZHJvcHMgaXQsIHNvIG5vIGZyYW1lIGFycml2ZXMsIHNvIHRoZSBjbGllbnQncyBlcG9jaCBjaGVjayBuZXZlciBydW5zXG4gKiBhbmQgdGhlIHRhaWwgc2l0cyBjb25uZWN0ZWQgYW5kIHNpbGVudCB1bnRpbCB0aGUgbmV3IGRhZW1vbiBoYXMgZW1pdHRlZCBhc1xuICogbWFueSBldmVudHMgYXMgdGhlIG9sZCBvbmUgZGlkLiBTdGFtcGluZyBhbiBlcG9jaCBhbG9uZSBkb2VzIE5PVCBjbG9zZSB0aGF0XG4gKiBnYXA6IHRoZSBlcG9jaCByaWRlcyBhIGZyYW1lLCBhbmQgdGhlIGJ1ZyBpcyB0aGF0IG5vIGZyYW1lIGlzIHNlbnQuIFNvXG4gKiBgc3Vic2NyaWJlYCB0cmVhdHMgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYW5vdGhlciBwcm9jZXNzXCJcbiAqIGFuZCByZXBsYXlzIHdob2xlLiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuIE5vdFxuICogXCJubyBzdWJqZWN0XCIg4oCUIGdyYXBldmluZSBIQVMgYW4gZXZlbnQgYnVzIGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGVcbiAqIHNwZWxsIOKAlCBidXQgdGhlIHR3byBzaGFwZXMgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBvbmUgcHJvY2Vzcy13aWRlIGFycmF5IGNhcHBlZCBhdCBSRVBMQVlfQlVGRkVSX1NJWkUsIHdpdGggb25lXG4gKiAgICAgICAgICAgICAgICBtb25vdG9uaWMgYHNlcWAsIGFuZCB0aGUgaGVhZGVyIHRocmVlIHBhcmFncmFwaHMgdXAgc2F5cyBpbiBhc1xuICogICAgICAgICAgICAgICAgbWFueSB3b3JkcyB0aGF0IGl0IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiAgICAgICAgICAgICAgICBkYWVtb24ncyBsaWZldGltZSwgTk9UIGEgZHVyYWJsZSBsb2cuXG4gKiAgIGdyYXBldmluZSAgICBOIGR1cmFibGUgYXBwZW5kLW9ubHkgYC5qc29ubGAgZmlsZXMsIG9uZSBwZXIgbmFtZWQgY2hhbm5lbCxcbiAqICAgICAgICAgICAgICAgIGVhY2ggd2l0aCBpdHMgb3duIGBuZXh0X2lkYCwgcmVwbGF5ZWQgZnJvbSBkaXNrIGJ5XG4gKiAgICAgICAgICAgICAgICBgcmVhZEJhY2tsb2dgLCBzdXJ2aXZpbmcgcmVzdGFydCwgYHJvbGxgLCBhcmNoaXZlIGFuZCBjbGVhci5cbiAqXG4gKiAqKlRoZSByZWFkZXIgdGhhdCBtYWtlcyB0aGVtIGluY29tcGF0aWJsZSwgYXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhblxuICogYXNzZXJ0aW9uOioqIGdyYXBldmluZSdzIGBsb2FkQ2hhbm5lbCgpYCBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIEhJR0gtV0FURVJcbiAqIE1BUksgb3ZlciBldmVyeSBwYXJzZWFibGUgbGluZSBvZiB0aGUgY2hhbm5lbCdzIGZpbGUgb24gYm9vdC4gVGhlcmUgaXMgbm9cbiAqIGFycmF5IHRvIGJlIHRoYXQgbWFyayBvZiwgYW5kIG5vIGNhcCB0aGF0IHdvdWxkIG5vdCBzaWxlbnRseSBkaXNjYXJkIGhpc3RvcnlcbiAqIGEgY2FsbGVyIGNhbiBzdGlsbCBhc2sgZm9yIGJ5IGlkLiBJdCBpcyB0aGUgdGhpbmcgdGhpcyBtb2R1bGUncyBvd24gaGVhZGVyXG4gKiBzYXlzIGl0IGlzIGRlbGliZXJhdGVseSBub3QuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGEgcGVyLWNoYW5uZWwgZHVyYWJsZVxuICogc3RvcmUgd291bGQgY2hhbmdlIGBjcmVhdGVFdmVudExvZ2AncyBzdG9yYWdlIGFuZCBpdHMgYHN1YnNjcmliZWAgY29udHJhY3QgZm9yXG4gKiBmaXZlIG90aGVyIGRhZW1vbnMsIHJlLWVtaXR0aW5nIFNJWCBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYVxuICogZHJpdmUg4oCUIHBhaWQgYnkgcG9ydHMgdGhhdCBhcmUgYWxyZWFkeSBmaW5pc2hlZCBhbmQgYnkgYWdlbnRzIG5vdCBpbiB0aGUgcm9vbS5cbiAqIEEgd2lkZW5pbmcgcmVtYWlucyBhdmFpbGFibGUgYXMgaXRzIG93biBhcmd1ZWQgZGVjaXNpb24gd2l0aCBpdHMgb3duXG4gKiBibGFzdC1yYWRpdXMgY291bnQ7IGl0IGlzIG5ldmVyIGEgc3RlcCBpbnNpZGUgYSBwb3J0LlxuICpcbiAqIOKaoCBBTkQgVEhFIGBlcG9jaGAgQUJPVkUgSVMgVEhFIFNIQVJQRVNUIEhBTEYgT0YgV0hZIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlXG4gKiBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCwgc28gdGhlIGNvbmRpdGlvbiBwYXJhZ3JhcGggMiBkZXNjcmliZXMg4oCUIGlkc1xuICogc3RhcnRpbmcgYWdhaW4gYXQgMSDigJQgY2Fubm90IG9jY3VyIHRoZXJlLCBhbmQgc3RhbXBpbmcgb25lIGFueXdheSBpcyBub3RcbiAqIGluZXJ0OiBgdGFpbEV2ZW50c2AncyBgb25FcG9jaENoYW5nZWAgc2V0cyB0aGUgY3Vyc29yIHRvIDAsIGFuZCBncmFwZXZpbmUnc1xuICogdGFpbCByb3V0ZSBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoIHRoZSBXSE9MRSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhblxuICogYWdlbnQncyBwaXBlLCBvbiBldmVyeSBgcm9sbGAuIFRoZSBlcG9jaCdzIGNsaWVudC1zaWRlIGFjdGlvbiBpcyBcInlvdXIgY3Vyc29yXG4gKiBpcyB3b3J0aGxlc3MsIHN0YXJ0IG92ZXJcIiwgYW5kIHRoYXQgaXMgc2FmZSBvbmx5IHdoZXJlIHN0YXJ0aW5nIG92ZXIgY29zdHMgYVxuICogYm91bmRlZCBpbi1tZW1vcnkgcmVwbGF5IHdpbmRvdy5cbiAqL1xuXG4vKiogVGhlIGRlZmF1bHQgcmVwbGF5IHdpbmRvdywgaW5oZXJpdGVkIGZyb20gbWluZC1tYXBwZXIncyBtZWFzdXJlZCBjYXAuICovXG5leHBvcnQgY29uc3QgUkVQTEFZX0JVRkZFUl9TSVpFID0gMTAwMDtcblxuLyoqIEEgZnJhbWUgYXMgaXQgZ29lcyBvbiB0aGUgd2lyZTogdGhlIGNhbGxlcidzIHBheWxvYWQgcGx1cyBhIG1vbm90b25pYyBgaWRgLFxuICogIHBsdXMgYW4gYGVwb2NoYCB3aGVuIHRoZSBsb2cgd2FzIGdpdmVuIG9uZS4gKi9cbmV4cG9ydCB0eXBlIEZyYW1lPFQ+ID0gVCAmIHsgaWQ6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBFdmVudExvZzxUPiB7XG4gIC8qKiBBcHBlbmQgb25lIGZyYW1lLCBmYW4gaXQgb3V0IHRvIGxpdmUgc3Vic2NyaWJlcnMsIGFuZCByZXR1cm4gaXQuICovXG4gIGVtaXQobXNnOiBUKTogRnJhbWU8VD47XG4gIC8qKlxuICAgKiBSZXBsYXkgZXZlcnl0aGluZyBhZnRlciBgc2luY2VgLCB0aGVuIHN0YXkgc3Vic2NyaWJlZC4gUmV0dXJucyBhblxuICAgKiB1bnN1YnNjcmliZSBmdW5jdGlvbi5cbiAgICpcbiAgICog4puUIFJFUExBWSBBTkQgU1VCU0NSSUJFIEFSRSBPTkUgQ0FMTCBPTiBQVVJQT1NFLiBEb2luZyB0aGVtIGluIHR3byBzdGVwc1xuICAgKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYW4gZW1pdCBsYW5kcyBiZXR3ZWVuIHRoZSByZXBsYXkgbG9vcCBhbmQgdGhlXG4gICAqIGBhZGRgLCBhbmQgdGhhdCBmcmFtZSBpcyBkZWxpdmVyZWQgdG8gbm9ib2R5IOKAlCB0aGUgc2hhcGUgZml2ZSBkYWVtb25zIGhhdmUsXG4gICAqIHN1cnZpdmVkIGJ5IG5vdGhpbmcgYnV0IHRoZSBzaW5nbGUtdGhyZWFkZWQgZXZlbnQgbG9vcCBoYXBwZW5pbmcgdG8gY2xvc2VcbiAgICogaXQuIERlcGVuZGluZyBvbiB0aGF0IGlzIGRlcGVuZGluZyBvbiBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgb2YgdGhlXG4gICAqIHJ1bnRpbWUgcmF0aGVyIHRoYW4gb24gdGhlIGNvZGUuXG4gICAqL1xuICBzdWJzY3JpYmUoc2luY2U6IG51bWJlciwgbGlzdGVuZXI6IChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGhpZ2hlc3QgaWQgZW1pdHRlZCBzbyBmYXIg4oCUIHdoYXQgYEdFVCAvc3RhdGVgIHJldHVybnMgYXMgYGN1cnNvcmAuICovXG4gIGN1cnNvcigpOiBudW1iZXI7XG4gIC8qKiBUaGUgZXBvY2ggc3RhbXBlZCBvbiBldmVyeSBmcmFtZSwgb3IgYHVuZGVmaW5lZGAgaWYgbm9uZSB3YXMgY29uZmlndXJlZC4gKi9cbiAgcmVhZG9ubHkgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50TG9nPFQgZXh0ZW5kcyBvYmplY3Q+KFxuICBvcHRzOiB7IGVwb2NoPzogc3RyaW5nOyBidWZmZXJTaXplPzogbnVtYmVyIH0gPSB7fSxcbik6IEV2ZW50TG9nPFQ+IHtcbiAgY29uc3QgYnVmZmVyU2l6ZSA9IG9wdHMuYnVmZmVyU2l6ZSA/PyBSRVBMQVlfQlVGRkVSX1NJWkU7XG4gIGNvbnN0IGVwb2NoID0gb3B0cy5lcG9jaDtcbiAgY29uc3QgYnVmZmVyOiBBcnJheTxGcmFtZTxUPj4gPSBbXTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IFNldDwoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkPigpO1xuICBsZXQgc2VxID0gMDtcblxuICByZXR1cm4ge1xuICAgIGVwb2NoLFxuXG4gICAgZW1pdChtc2cpIHtcbiAgICAgIHNlcSArPSAxO1xuICAgICAgLy8g4puUIFRIRSBNT05PVE9OSUMgSUQgV0lOUyBPVkVSIEFOWVRISU5HIElOIFRIRSBQQVlMT0FELCBBTkQgVU5USUwgTk9XIElUXG4gICAgICAvLyBPTkxZIENMQUlNRUQgVE8uIEJvdGggYWRvcHRpbmcgZGFlbW9ucyB3cm90ZSBgeyBpZDogKytzZXEsIC4uLm1zZyB9YFxuICAgICAgLy8gdW5kZXIgYSBjb21tZW50IHNheWluZyBcInRoZSBtb25vdG9uaWMgYGlkYCBNVVNUIHdpbiBvdmVyIGFueSBgaWRgIGluXG4gICAgICAvLyB0aGUgcGF5bG9hZCwgc28gY2FsbGVycyBjYXJyeSBhIHByb2plY3QgaWRlbnRpZmllciBhcyBgcHJvamVjdElkYCxcbiAgICAgIC8vIG5ldmVyIGBpZGBcIiDigJQgYnV0IHNwcmVhZCBvcmRlciBtZWFucyBhIHBheWxvYWQgYGlkYCBvdmVycm9kZSB0aGVcbiAgICAgIC8vIGN1cnNvciwgc2lsZW50bHksIGFuZCB0aGUgY29udmVudGlvbiBpbiB0aGUgY29tbWVudCB3YXMgdGhlIG9ubHkgdGhpbmdcbiAgICAgIC8vIGhvbGRpbmcgaXQuIFRoZSBsaXRlcmFsIGtlZXBzIGBpZGAgRklSU1Qgc28gdGhlIHdpcmUga2V5IG9yZGVyIGlzXG4gICAgICAvLyB1bmNoYW5nZWQ7IHRoZSBhc3NpZ25tZW50IGFmdGVyIHRoZSBzcHJlYWQgaXMgd2hhdCBtYWtlcyB0aGUgc2VudGVuY2VcbiAgICAgIC8vIHRydWUuIGBlcG9jaGAgaXMgc3RhbXBlZCB0aGUgc2FtZSB3YXkgYW5kIGZvciB0aGUgc2FtZSByZWFzb24uXG4gICAgICBjb25zdCBmcmFtZSA9IHsgaWQ6IHNlcSwgLi4ubXNnIH0gYXMgRnJhbWU8VD47XG4gICAgICBmcmFtZS5pZCA9IHNlcTtcbiAgICAgIGlmIChlcG9jaCAhPT0gdW5kZWZpbmVkKSBmcmFtZS5lcG9jaCA9IGVwb2NoO1xuXG4gICAgICBidWZmZXIucHVzaChmcmFtZSk7XG4gICAgICBpZiAoYnVmZmVyLmxlbmd0aCA+IGJ1ZmZlclNpemUpIGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCBsaXN0ZW5lciBvZiBsaXN0ZW5lcnMpIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIHJldHVybiBmcmFtZTtcbiAgICB9LFxuXG4gICAgc3Vic2NyaWJlKHNpbmNlLCBsaXN0ZW5lcikge1xuICAgICAgLy8gU2VlIHRoZSBoZWFkZXIsIHBvaW50IDM6IGEgY3Vyc29yIGJleW9uZCBvdXIgb3duIGlzIGEgY3Vyc29yIGZyb20gYVxuICAgICAgLy8gUFJJT1IgUFJPQ0VTUywgYW5kIHRoZSBvbmx5IHVzZWZ1bCByZWFkaW5nIG9mIGl0IGlzIFwicmVwbGF5IHdob2xlXCIuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEEgTk9OLUZJTklURSBDVVJTT1IgQUxTTyBNRUFOUyBcIkZST00gVEhFIFNUQVJUXCIsIHdoaWNoIHRoZSBjb3BpZXMgZ290XG4gICAgICAvLyB3cm9uZyBieSBhY2NpZGVudDogdGhleSB3cm90ZSBgcGFyc2VJbnQocGFyYW0gPz8gXCItMVwiKWAgYW5kIGNvbXBhcmVkXG4gICAgICAvLyBgaWQgPiBzaW5jZWAsIHNvIGEgdHlwbydkIGA/c2luY2U9eGAgcHJvZHVjZWQgYE5hTmAsIGV2ZXJ5IGNvbXBhcmlzb25cbiAgICAgIC8vIHdhcyBmYWxzZSwgYW5kIHRoZSB0YWlsIG9wZW5lZCBFTVBUWSBhbmQgc3RheWVkIGNvbm5lY3RlZCDigJQgdGhlIHNhbWVcbiAgICAgIC8vIHNpbGVudC1hbmQtY29ubmVjdGVkIHN5bXB0b20gYXMgdGhlIHN0YWxlIHdhdGVybWFyaywgZnJvbSBhIGRpZmZlcmVudFxuICAgICAgLy8gY2F1c2UuIEFic2VudCBhbmQgdW5wYXJzZWFibGUgYXJlIHRoZSBzYW1lIHJlcXVlc3QgaGVyZS5cbiAgICAgIGNvbnN0IGZyb20gPSAhTnVtYmVyLmlzRmluaXRlKHNpbmNlKSB8fCBzaW5jZSA+IHNlcSA/IC0xIDogc2luY2U7XG4gICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGJ1ZmZlcikge1xuICAgICAgICBpZiAoZnJhbWUuaWQgPiBmcm9tKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICB9XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgIGxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgICAgfTtcbiAgICB9LFxuXG4gICAgY3Vyc29yKCkge1xuICAgICAgcmV0dXJuIHNlcTtcbiAgICB9LFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBkYWVtb24gbGlmZWN5Y2xlIHRhaWw6IHRoZSBpZGxlLWNsb3NlIGRlY2lzaW9uLCB0aGUgc3dlZXBcbiAqIHRoYXQgbWFrZXMgaXQsIGFuZCB0aGUgYm91bmRlZCB0ZWFyZG93bi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBib3VudHkg4oCUIHRoZSBjZW5zdXMnc1xuICogY29udmVyZ2VuY2UgdGFyZ2V0ICMzIOKAlCB3aXRoIGFzdHJvbGFiZSdzIGB0aW1lb3V0TXMgPiAwYCBndWFyZCBmb2xkZWQgaW4sXG4gKiB3aGljaCBpcyB0aGUgb25lIHRoaW5nIGJvdW50eSdzIGNvcHkgZG9lcyBub3QgZXhwcmVzcy5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBBRE9QVFMgYGRyYWluQW5kU3RvcGAgQU5EIE5PVEhJTkcgRUxTRSBIRVJFIOKAlCBTUExJVCBQRVIgRVhQT1JUXG4gKlxuICogUnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KSwgYW5kIGl0IGlzIHdyaXR0ZW4gZG93blxuICogYmVjYXVzZSBhIHJvdyBpcyBhIE1PRFVMRSBhbmQgXCJwYXJ0aWFsXCIgaXMgbm90IGFuIGFuc3dlciB1bnRpbCBpdCBzYXlzIHdoaWNoXG4gKiBleHBvcnRzLiBHcmFwZXZpbmUgaXMgbG9uZy1ydW5uaW5nLCBzbyBub3RoaW5nIGFib3V0IGl0cyBsaWZlY3ljbGUgbWFrZXMgdGhpc1xuICogbW9kdWxlIHJlYWQgYXMgaW5hcHBsaWNhYmxlIOKAlCBhbmQgdHdvIG9mIGl0cyB0aHJlZSBleHBvcnRzIHN0aWxsIGhhdmUgbm9cbiAqIHN1YmplY3QgdGhlcmU6XG4gKlxuICogICBgc2hvdWxkSWRsZUNsb3NlYCAgICAgIE5PIFNVQkpFQ1QuIEdyYXBldmluZSBydW5zIG5vIGlkbGUgc3dlZXAgYW5kIGhhcyBub1xuICogICBgc3RhcnRIb3VzZWtlZXBpbmdgICAgIGAtLXRpbWVvdXRgOyBpdCBpcyBhIGJyb2tlciB0aGF0IHN0YW5kcyB1bnRpbCBgc3RvcGBcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAoYERFTEVURSAvYCkgb3IgYSBzaWduYWwsIGFuZCBpdCB0YWtlcyBubyBzbmFwc2hvdC5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBBZG9wdGluZyB0aGUgcGFpci1tYW5hZ2VyIHdvdWxkIG1lYW4gd3JpdGluZyBhIG5vLW9wXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHRvdWNoYCBhbmQgYSBgc3Vic2NyaWJlckNvdW50YCB0aGF0IGV4aXN0cyBvbmx5IHRvXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGEgbnVtYmVyIG5vYm9keSBhY3RzIG9uIOKAlCB0d28gbGllcyB0byBnYWluIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgY2xlYXJJbnRlcnZhbGAuXG4gKiAgIGBkcmFpbkFuZFN0b3BgICAgICAgICAgQURPUFRFRCwgYW5kIGl0IGlzIGEgREUtRFVQTElDQVRJT04gcmF0aGVyIHRoYW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGdhaW46IGdyYXBldmluZSdzIHRlYXJkb3duIGFscmVhZHkgV0FTXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIDIwMCBtc10pYCwgd2hpY2ggaXNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgc3RvcE1zYCBleGFjdGx5LlxuICpcbiAqIOKaoCAqKkFORCBJVCBJUyBDQUxMRUQgV0lUSCBOTyBgY2xpZW50c2AsIFdISUNIIElTIEEgTUVBU1VSRU1FTlQsIE5PVCBBTlxuICogT1ZFUlNJR0hULioqIFRoaXMgbW9kdWxlIGNsb3NlcyBhIGhlbGQgY29ubmVjdGlvbiBieSBjYWxsaW5nIGBjbGllbnQuY2xvc2UoKWA7XG4gKiBncmFwZXZpbmUncyBzdWJzY3JpYmVyIHJlY29yZHMgYXJlIGB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfWAgYW5kIGNhcnJ5IG5vXG4gKiBgY2xvc2VgIOKAlCBpdHMgcGVyLXN0cmVhbSB0ZWFyZG93biBpcyBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW1cbiAqIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb20gYGNhbmNlbCgpYC4gVGhlcmUgaXMgbm90aGluZyB0byBoYW5kIHRoZVxuICogYXJndW1lbnQuIGBzc2UudHNgJ3MgaGVhZGVyIGNhcnJpZXMgdGhlIHJlc3Qgb2YgdGhhdCBydWxpbmcsIGluY2x1ZGluZyB0aGVcbiAqIHdpZGVuaW5nIG5vdCBkb25lIGFuZCBpdHMgY29zdCAoc2l4IGFydGlmYWN0cyBhY3Jvc3MgZml2ZSBzcGVsbHMpLlxuICpcbiAqIOKaoCBHcmFwZXZpbmUgYWxzbyBwYXNzZXMgYGdyYWNlTXM6IDBgLiBOb3QgYSBkaXNhZ3JlZW1lbnQgd2l0aCB0aGUgZ3JhY2VcbiAqIHBlcmlvZDogaXQgZW1pdHMgbm8gZmFyZXdlbGwgZnJhbWUgYXQgZGFlbW9uIHNodXRkb3duLCBhbmQgaXRzIGBERUxFVEUgL2BcbiAqIGFscmVhZHkgcmV0dXJucyB0aGUgcmVzcG9uc2UgYW5kIHNjaGVkdWxlcyB0aGUgdGVhcmRvd24gMTAgbXMgbGF0ZXIsIHNvIGl0c1xuICogZmx1c2ggd2luZG93IHNpdHMgYXQgdGhlIHJvdXRlIHJhdGhlciB0aGFuIGluIHRoZSBkcmFpbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFNzZUNsaWVudHMgfSBmcm9tIFwiLi9zc2UudHNcIjtcblxuLyoqXG4gKiBTaG91bGQgdGhlIGRhZW1vbiBpZGxlLWNsb3NlP1xuICpcbiAqIOKblCAqKmBzdWJzY3JpYmVyQ291bnRgIElTIEEgUkVRVUlSRUQgQVJHVU1FTlQsIEFORCBUSEFUIElTIFRIRSBXSE9MRSBQT0lOVC4qKlxuICogVGhpcyBjbG9zZXMgY2Vuc3VzIGRlZmVjdCAqKkwxKiogYnkgY29uc3RydWN0aW9uOiBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllXG4gKiBjb3VudGVkIHRoZWlyIGlkbGUgZmxvb3IgZG93biB3aGlsZSBhbiBhZ2VudCBoZWxkIGEgdGFpbCBvcGVuLCBzbyBhbiBhZ2VudFxuICogd2F0Y2hpbmcgYSBxdWlldCBib2FyZCB3YXMga2lsbGVkIFdJVEggSVRTIENPTk5FQ1RJT04gT1BFTi4gVGhlcmUgaXMgbm9cbiAqIG92ZXJsb2FkIG9mIHRoaXMgZnVuY3Rpb24gdGhhdCBjYW5ub3Qgc2VlIGl0cyBzdWJzY3JpYmVycywgc28gdGhlIGRlZmVjdFxuICogY2Fubm90IGJlIHJlLWV4cHJlc3NlZCBieSBhIGNhbGxlciB3aG8gZm9yZ2V0cy5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNDQVIgSVQgQ0FNRSBXSVRILCByZS1ob21lZCBmcm9tIGJvdW50eSB2ZXJiYXRpbSBpbiBzdWJzdGFuY2U6KipcbiAqIGEgYm9hcmQgb25seSBjb3VudHMgaXRzIGlkbGUgZmxvb3IgZG93biB3aGlsZSBVTldBVENIRUQuIEEgbGl2ZSBzdWJzY3JpYmVyIOKAlFxuICogYSBicm93c2VyIFdlYlNvY2tldCwgb3IgYW4gYWdlbnQgU1NFIHRhaWwgb24gYC9ldmVudHNgIOKAlCBrZWVwcyBpdCBvcGVuXG4gKiBpbmRlZmluaXRlbHkuIFNvIGB0aW1lb3V0YCBtZWFucyBcImxpbmdlciB0aGlzIGxvbmcgYWZ0ZXIgdGhlIExBU1Qgc3Vic2NyaWJlclxuICogbGVhdmVzXCIsIE5PVCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi4gVGhlIHN3ZWVwIGJlbG93IGFsc28gdG91Y2hlcyB0aGVcbiAqIGFjdGl2aXR5IGNsb2NrIG9uIGV2ZXJ5IHRpY2sgd2hpbGUgd2F0Y2hlZCwgc28gb25jZSB1bndhdGNoZWQgdGhlIGZsb29yXG4gKiBjb3VudHMgZnJvbSB0aGF0IGxhc3QgZGlzY29ubmVjdCBhbmQgbm90IGZyb20gdGhlIGxhc3QgcmVxdWVzdC5cbiAqXG4gKiDimqAgYHRpbWVvdXRNcyA8PSAwYCBtZWFucyBORVZFUiwgd2hpY2ggaXMgYXN0cm9sYWJlJ3Mgc3RhbmRpbmctb2JzZXJ2YXRvcnlcbiAqIGRlZmF1bHQgYW5kIGlzIHdoeSB0aGUgZ3VhcmQgaXMgaGVyZSByYXRoZXIgdGhhbiBhdCBpdHMgb25lIGNhbGwgc2l0ZTogYVxuICogc2luZ2xldG9uIGRhZW1vbiBpcyBtZWFudCB0byBzdGFuZCB1bnRpbCBpdCBpcyBleHBsaWNpdGx5IGNsb3NlZCwgYW5kIGFcbiAqIGA+PSAwYCBjb21wYXJpc29uIHdvdWxkIGNsb3NlIGl0IG9uIHRoZSBmaXJzdCB0aWNrLlxuICpcbiAqIENsb2NrLWZyZWUgYW5kIGZzLWZyZWUsIHNvIGl0IGlzIHRlc3RhYmxlIHdpdGhvdXQgYSBkYWVtb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRJZGxlQ2xvc2UoXG4gIHN1YnNjcmliZXJDb3VudDogbnVtYmVyLFxuICBpZGxlTXM6IG51bWJlcixcbiAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKHRpbWVvdXRNcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvdXNla2VlcGluZ09wdGlvbnMge1xuICAvKiog4puUIFJFUVVJUkVELiBTZWUgYHNob3VsZElkbGVDbG9zZWAg4oCUIHRoaXMgaXMgd2hhdCBjbG9zZXMgTDEuICovXG4gIHN1YnNjcmliZXJDb3VudDogKCkgPT4gbnVtYmVyO1xuICAvKiogTWlsbGlzZWNvbmRzIHNpbmNlIHRoZSBsYXN0IGFjdGl2aXR5LiAqL1xuICBpZGxlTXM6ICgpID0+IG51bWJlcjtcbiAgLyoqIFJlc2V0IHRoZSBhY3Rpdml0eSBjbG9jay4gQ2FsbGVkIG9uIGV2ZXJ5IHRpY2sgdGhhdCBoYXMgYSBzdWJzY3JpYmVyLiAqL1xuICB0b3VjaDogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBjb25maWd1cmVkIGlkbGUgdGltZW91dCBpbiBtczsgYDBgIChvciBsZXNzKSBtZWFucyBuZXZlci4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBGaXJlZCBvbmNlIHdoZW4gdGhlIGRhZW1vbiBzaG91bGQgY2xvc2UgaXRzZWxmLiAqL1xuICBvbklkbGVDbG9zZTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBkZWJvdW5jZWQgc25hcHNob3QsIGlmIHRoZSBzcGVsbCBoYXMgb25lLiAqL1xuICBzbmFwc2hvdD86IHtcbiAgICBkaXJ0eTogKCkgPT4gYm9vbGVhbjtcbiAgICBjbGVhcjogKCkgPT4gdm9pZDtcbiAgICB3cml0ZTogKCkgPT4gdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIH07XG4gIC8qKiBTd2VlcCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMjUwIG1zLiAqL1xuICB0aWNrTXM/OiBudW1iZXI7XG4gIC8qKiBTbmFwc2hvdCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMTAwMCBtcy4gKi9cbiAgc25hcHNob3RNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBTdGFydCB0aGUgdHdvIHN0YW5kaW5nIHRpbWVycyBldmVyeSBzZXNzaW9uIGRhZW1vbiBydW5zIOKAlCB0aGUgaWRsZSBzd2VlcCBhbmRcbiAqIHRoZSBkZWJvdW5jZWQgc25hcHNob3Qg4oCUIGFuZCByZXR1cm4gdGhlIGZ1bmN0aW9uIHRoYXQgc3RvcHMgYm90aC5cbiAqXG4gKiBUaGV5IGFyZSBPTkUgY2FsbCBiZWNhdXNlIHRoZXkgaGF2ZSBhbHdheXMgYmVlbiBvbmUgbGlmZXRpbWU6IGV2ZXJ5IGNvcHlcbiAqIGNsZWFyZWQgYm90aCBpbiB0aGUgc2FtZSB0d28gbGluZXMgYWZ0ZXIgYGF3YWl0IGRvbmVgLCBhbmQgdGhlIHBhaXIgdGhhdCBnZXRzXG4gKiBmb3Jnb3R0ZW4gaXMgdGhlIHBhaXIgd2hvc2UgdGltZXJzIGtlZXAgYSBwcm9jZXNzIGFsaXZlIGFmdGVyIHRlYXJkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRIb3VzZWtlZXBpbmcob3B0czogSG91c2VrZWVwaW5nT3B0aW9ucyk6ICgpID0+IHZvaWQge1xuICBjb25zdCB0aWNrTXMgPSBvcHRzLnRpY2tNcyA/PyAyNTA7XG4gIGNvbnN0IHNuYXBzaG90TXMgPSBvcHRzLnNuYXBzaG90TXMgPz8gMTAwMDtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcHRzLnN1YnNjcmliZXJDb3VudCgpO1xuICAgIGlmIChzdWJzY3JpYmVycyA+IDApIG9wdHMudG91Y2goKTtcbiAgICBpZiAoc2hvdWxkSWRsZUNsb3NlKHN1YnNjcmliZXJzLCBvcHRzLmlkbGVNcygpLCBvcHRzLnRpbWVvdXRNcykpIG9wdHMub25JZGxlQ2xvc2UoKTtcbiAgfSwgdGlja01zKTtcblxuICBjb25zdCBzbmFwID0gb3B0cy5zbmFwc2hvdDtcbiAgY29uc3Qgc25hcFRpbWVyID0gc25hcFxuICAgID8gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoIXNuYXAuZGlydHkoKSkgcmV0dXJuO1xuICAgICAgICBzbmFwLmNsZWFyKCk7XG4gICAgICAgIHZvaWQgc25hcC53cml0ZSgpO1xuICAgICAgfSwgc25hcHNob3RNcylcbiAgICA6IG51bGw7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBjbGVhckludGVydmFsKGlkbGVUaW1lcik7XG4gICAgaWYgKHNuYXBUaW1lciAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChzbmFwVGltZXIpO1xuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERyYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgYm91bmQgc2VydmVyLiBUeXBlZCBzdHJ1Y3R1cmFsbHkgc28gdGhlIGtpdCBzdGF5cyBmcmVlIG9mIGBidW5gLiAqL1xuICBzZXJ2ZXI6IHsgc3RvcChjbG9zZUFjdGl2ZUNvbm5lY3Rpb25zPzogYm9vbGVhbik6IHVua25vd24gfTtcbiAgLyoqIExpdmUgU1NFIHRhaWxzOyBldmVyeSByZWdpc3RlcmVkIGNsb3NlciBpcyBpbnZva2VkLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIExpdmUgV2ViU29ja2V0cy4gKi9cbiAgc29ja2V0cz86IEl0ZXJhYmxlPHsgY2xvc2UoKTogdm9pZCB9PjtcbiAgLyoqIEhvdyBsb25nIHF1ZXVlZCBmcmFtZXMgZ2V0IHRvIGZsdXNoIGJlZm9yZSBhbnl0aGluZyBpcyBjbG9zZWQuICovXG4gIGdyYWNlTXM/OiBudW1iZXI7XG4gIC8qKiBIb3cgbG9uZyB0aGUgZ3JhY2VmdWwgc3RvcCBnZXRzIGJlZm9yZSB0ZWFyZG93biBwcm9jZWVkcyByZWdhcmRsZXNzLiAqL1xuICBzdG9wTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvc2UgZXZlcnkgaGVsZCBjb25uZWN0aW9uIGFuZCBzdG9wIHRoZSBzZXJ2ZXIsIGluIGJvdW5kZWQgdGltZS5cbiAqXG4gKiDim5QgKipUSEUgR1JBQ0UgUEVSSU9EIElTIE5PVCBQT0xJVEVORVNTLioqIEEgYGNsb3NlZGAgZnJhbWUgZW1pdHRlZCBhbmQgdGhlblxuICogZm9sbG93ZWQgaW1tZWRpYXRlbHkgYnkgYW4gYWdncmVzc2l2ZSBgc2VydmVyLnN0b3AodHJ1ZSlgIGlzIGEgZnJhbWUgdGhlXG4gKiBjbGllbnQgbmV2ZXIgc2VlcyDigJQgdGhlIHF1ZXVlIGdvZXMgd2l0aCB0aGUgc29ja2V0LiBUaGUgMTUwIG1zIGlzIHdoYXQgdHVybnNcbiAqIFwidGhlIGRhZW1vbiB0b2xkIHlvdSB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24sIGFuZCBldmVyeVxuICogb25lIG9mIHRoZSBlaWdodCBkYWVtb25zIGNvbnZlcmdlZCBvbiB0aGF0IG51bWJlciBpbmRlcGVuZGVudGx5LlxuICpcbiAqIOKblCAqKkFORCBUSEUgU1RPUCBJUyBSQUNFRCwgQkVDQVVTRSBBIFNMT1cgU09DS0VUIE1VU1QgTk9UIEJFIEFCTEUgVE8gSEFOR1xuICogVEVBUkRPV04uKiogYHNlcnZlci5zdG9wKHRydWUpYCBhd2FpdHMgaXRzIGNvbm5lY3Rpb25zOyBvbmUgd2VkZ2VkIHBlZXIgaXNcbiAqIGVub3VnaCB0byBwYXJrIGl0IGZvcmV2ZXIsIHdoaWNoIGlzIGhvdyBhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZS5cbiAqXG4gKiDimqAgKipXSEFUIElTIERFTElCRVJBVEVMWSBOT1QgSEVSRTogYm91bnR5J3Mgc2h1dGRvd24gd2F0Y2hkb2cuKiogQm91bnR5IGFybXNcbiAqIGEgUkVGJ2QgYHNldFRpbWVvdXRgIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgaWYgdGVhcmRvd24gZG9lcyBub3QgZmluaXNoLFxuICogYW5kIHRoZSBjZW5zdXMgaXMgcmlnaHQgdGhhdCBpdCBpcyB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsXG4gKiB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIEl0IGJlbG9uZ3MgdG8gYm91bnR5J3MgVEVBUkRPV04g4oCUIHRoZSBzdHJldGNoIHdoZXJlXG4gKiBub3RoaW5nIGJvdW5kcyB3aGF0IGlzIGJlaW5nIHdhaXRlZCBvbi4g4puUICoqVEhJUyBQQVJBR1JBUEggU0FJRCBcIlNJR05BTFxuICogUEFUSFwiIFVOVElMIEQ1MywgQU5EIFRIRSBDT0RFIEFHUkVFRCBXSVRIIElULCBXSElDSCBXQVMgVEhFIERFRkVDVC4qKiBCb3VudHlcbiAqIGhhcyBGT1VSIHdheXMgaW50byBvbmUgdGVhcmRvd24gKGEgc2lnbmFsLCBhIGBjbG9zZWAgdmVyYiwgdGhlIGJyb3dzZXInc1xuICogY2xvc2Ugb3ZlciB0aGUgV2ViU29ja2V0LCBhbiBpZGxlIHRpbWVvdXQpIGFuZCBvbmx5IHRoZSBzaWduYWwgb25lIGFybWVkIHRoZVxuICogdGltZXIsIHdoaWxlIHRoZSBjb21tZW50IGFib3ZlIGl0IGNsYWltZWQgdGhlIGVuZGluZyB3YXMgdW5jb25kaXRpb25hbC5cbiAqIERyaXZlbiB3aXRoIGEgcGxhbnRlZCBoYW5nOiB0aGUgb3RoZXIgdGhyZWUgcmFuIHBhc3QgMTAgcywgdGhlIGlkbGUgb25lXG4gKiBpbmNsdWRlZCDigJQgdGhlIG9ycGhhbi1kYWVtb24gY2xhc3MgdGhlIDIzLW1pbnV0ZSBoYW5nIGNhbWUgZnJvbS4gVGhlIGFybWluZ1xuICogbm93IGxpdmVzIGluIHRoZSBSRVNPTFZFIHRoYXQgYWxsIGZvdXIgZW50cmllcyBwYXNzIHRocm91Z2guICoqVGhlIGxlc3NvbiBmb3JcbiAqIGFuIGFkb3B0ZXIgaXMgdGhlIGNvdW50LCBub3QgdGhlIHBsYWNlbWVudDogZW51bWVyYXRlIGV2ZXJ5IGVudHJ5IGludG8gdGhlXG4gKiB0ZWFyZG93biBiZWZvcmUgeW91IGJlbGlldmUgYSBndWFyYW50ZWUgY292ZXJzIGl0LioqIFRoZSB0d29cbiAqIGRhZW1vbnMgYWRvcHRpbmcgdGhpcyBtb2R1bGUgcmVnaXN0ZXIgbm8gc2lnbmFsIGhhbmRsZXJzLCBhbmQgdGhlaXIgd2hvbGVcbiAqIHRlYXJkb3duIGlzIGJvdW5kZWQgYnkgdGhlIHR3byBudW1iZXJzIGFib3ZlOyBhZGRpbmcgYW4gZXhpdCBoZXJlIHdvdWxkIHB1dFxuICogdGhlIGhvdXNlJ3Mgb25seSB1bmNvbmRpdGlvbmFsIGBwcm9jZXNzLmV4aXRgIGluc2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBpc1xuICogYWJvdXQgdG8gYnVuZGxlLCBvbmUgcGhhc2UgYWZ0ZXIgRDggdG9vayBleGFjdGx5IHRoYXQgaGF6YXJkIE9VVCBvZiBgZGllYC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFTlRFTkNFIFRIQVQgVVNFRCBUTyBFTkQgVEhBVCBQQVJBR1JBUEggV0FTIEEgUFJFRElDVElPTiwgV0hJQ0hcbiAqIEJPVU5UWSdTIE9XTiBQT1JUIEZBTFNJRklFRC4qKiBJdCByZWFkOiBcIndoZW4gYSBzcGVsbCB3aXRoIGEgc2lnbmFsIHBhdGhcbiAqIGFkb3B0cyB0aGlzLCB0aGUgd2F0Y2hkb2cgYXJyaXZlcyBhcyBhbiBvcHRpb24gb24gdGhlc2UgYXJndW1lbnRzIGFuZCB0aGVcbiAqIHJlYXNvbmluZyBpcyBhbHJlYWR5IHdyaXR0ZW4gZG93bi5cIiBib3VudHkgYWRvcHRlZCBgZHJhaW5BbmRTdG9wYCBvblxuICogMjAyNi0wOS0wOSAoUGhhc2UgNCkgYW5kIHRoZSBvcHRpb24gd2FzIE5PVCBhZGRlZCwgYmVjYXVzZSB0aGUgd2luZG93IGlzXG4gKiB3cm9uZy4gKipBIGB3YXRjaGRvZ01zYCBvbiB0aGVzZSBhcmd1bWVudHMgd291bGQgYXJtIGF0IERSQUlOIHRpbWU7IGJvdW50eSdzXG4gKiBhcm1zIGF0IFNJR05BTCB0aW1lKiosIGFuZCB0aGUgd2hvbGUgcmVhc29uIGl0IGV4aXN0cyBpcyB0aGUgc3RyZXRjaCBCRVRXRUVOXG4gKiB0aG9zZSB0d28gcG9pbnRzIOKAlCBgYXdhaXQgZG9uZWAsIGFuIGZzIGFwcGVuZCB0byB0aGUgZGFlbW9uIGxvZywgYSBmdWxsXG4gKiBzbmFwc2hvdCB3cml0ZSB0aGF0IGNhbiByb3RhdGUgYW5kIENPUFkgYSBiYWNrdXAgb2YgYSBsYXJnZSBib2FyZCwgYSBgY2xvc2VkYFxuICogZnJhbWUgYW5kIGEgYnJvYWRjYXN0LiBgZHJhaW5BbmRTdG9wYCdzIG93biBib2R5IGlzIGFscmVhZHkgYm91bmRlZCBieSB0aGUgdHdvXG4gKiBudW1iZXJzIGFib3ZlLCBzbyBhIHdhdGNoZG9nIHNjb3BlZCB0byBpdCB3b3VsZCBndWFyZCB0aGUgb25lIHN0cmV0Y2ggdGhhdFxuICogY2Fubm90IGhhbmcgYW5kIGFiYW5kb24gdGhlIHN0cmV0Y2ggdGhhdCBjYW46IGl0IHdvdWxkIFJFQUQgYXMgYWRvcHRpb24gYW5kXG4gKiBCRSBhIG5hcnJvd2luZyBvZiB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gVGhlXG4gKiAyMy1taW51dGUgaGFuZyB0aGlzIHByb2plY3Qga2VlcHMgY2l0aW5nIGhhcHBlbmVkIGluIHRoZSB1bmJvdW5kZWQgc3RyZXRjaC5cbiAqXG4gKiDimqAgKipTTyBUSEUgUlVMRSBGT1IgVEhFIE5FWFQgU1BFTEwsIFdISUNIIElTIFRIRSBUUkFOU0ZFUkFCTEUgSEFMRjoqKiB0aGVcbiAqIHF1ZXN0aW9uIGlzIG5ldmVyIFwiZG9lcyB0aGlzIG1vZHVsZSBoYXZlIGEgcGxhY2UgdG8gcHV0IGEgd2F0Y2hkb2dcIiBidXRcbiAqIFwiZG9lcyB0aGUgd2F0Y2hkb2cncyB3aW5kb3cgY29pbmNpZGUgd2l0aCB0aGlzIG1vZHVsZSdzXCIuIFdoZXJlIGEgc3BlbGwnc1xuICogdGVhcmRvd24gaGFzIHVuYm91bmRlZCB3b3JrIEJFRk9SRSB0aGUgZHJhaW4sIHRoZSB3YXRjaGRvZyBiZWxvbmdzIGF0IHRoZVxuICogc3BlbGwsIHdyYXBwZWQgYXJvdW5kIGFsbCBvZiBpdCDigJQgYW5kIGFyb3VuZCBFVkVSWSBXQVkgSU4sIHdoaWNoIGlzIHRoZSBoYWxmXG4gKiBENTMgaGFkIHRvIHJlcGFpciBhZnRlciB0aGlzIGhlYWRlciB3YXMgd3JpdHRlbi4gSWYgYSBzcGVsbCBldmVyIGFwcGVhcnMgd2hvc2Ugc2lnbmFsIHBhdGhcbiAqIGVudGVycyBgZHJhaW5BbmRTdG9wYCBpbW1lZGlhdGVseSwgYWRkIHRoZSBvcHRpb24gVEhFTiDigJQgYW5kIHRoZSBvcHRpb24gbXVzdFxuICogdGFrZSBhbiBgb25FeHBpcmVgIGNhbGxiYWNrIHJhdGhlciB0aGFuIGV4aXRpbmcsIHNvIHRoZSBgcHJvY2Vzcy5leGl0YCBzdGF5c1xuICogb3V0c2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBidW5kbGVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZHJhaW5BbmRTdG9wKG9wdHM6IERyYWluT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBncmFjZU1zID0gb3B0cy5ncmFjZU1zID8/IDE1MDtcbiAgY29uc3Qgc3RvcE1zID0gb3B0cy5zdG9wTXMgPz8gMjAwO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIGdyYWNlTXMpKTtcblxuICBpZiAob3B0cy5jbGllbnRzKSB7XG4gICAgZm9yIChjb25zdCBjbGllbnQgb2YgWy4uLm9wdHMuY2xpZW50c10pIGNsaWVudC5jbG9zZSgpO1xuICB9XG4gIGlmIChvcHRzLnNvY2tldHMpIHtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIFsuLi5vcHRzLnNvY2tldHNdKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgUHJvbWlzZS5yZXNvbHZlKG9wdHMuc2VydmVyLnN0b3AodHJ1ZSkpLFxuICAgIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHN0b3BNcykpLFxuICBdKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKlxuICog4pSA4pSAIEFORCBcIldIRVRIRVIgSVQgTUFZIEJFIFJFQURcIiBJUyBOT1cgQSBXSElURUxJU1Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRXh0cmFjdGVkIHdpdGggdGhyZWUgZ3VhcmRzIChlbXB0eSAvIGAuLmAgLyBuZXN0ZWQpIGFuZCBgZXhpc3RzU3luY2AgZm9yIHRoZVxuICogcmVzdCwgd2hpY2ggd2FzIHRydWUgb2YgYSBgZGlzdC9gIHRoYXQgaGVsZCBvbmx5IGEgc3VyZmFjZS4gUGhhc2UgMWIgcHV0IGV2ZXJ5XG4gKiBkYWVtb24ncyBCVU5ETEUgaW4gdGhhdCBzYW1lIGRpcmVjdG9yeSwgYW5kIGFsbCBmaXZlIGFkb3B0ZXJzIHNlcnZlZCBpdDpcbiAqIGAvY2xpLmpzYCwgYC9zZXJ2ZXIuanNgLCBgL2pvaW4uanNgIGF0IDIwMCwgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGNvbW1pdHRlZFxuICogYXJ0aWZhY3RzLCBlbWJlZGRlZCBzb3VyY2VtYXBzIGFuZCBhbGwuIGBzZXJ2ZUZyb21EaXN0YCBub3cgc2VydmVzIG9ubHkgd2hhdCB0aGVcbiAqIGJ1aWx0IGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgbGlua3Mg4oCUIHNlZSBgc3VyZmFjZVdoaXRlbGlzdGAgYmVsb3csIHdoaWNoIGlzXG4gKiB0aGUgc2hhcGUgZGlnZXN0aWZ5IHByb3ZlZCBsb2NhbGx5IGluIGBkOGNiYWZmYCBhbmQgdGhpcyBpcyBpdHMgb25lIGVkaXQgZm9yXG4gKiBmaXZlIHNwZWxscy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKblCBBTkQgYGV4aXN0c1N5bmNgIElTIE5PIExPTkdFUiBUSEUgUEVSTUlTU0lPTi4gQSBmaWxlIHVuZGVyIGBkaXN0RGlyYCBpc1xuICogc2VydmVkIG9ubHkgaWYgaXQgaXMgaW4gYHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcilgIOKAlCB3aGF0IHRoZSBidWlsdFxuICogYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBMSU5LUy4gYGRpc3QvYCBzdG9wcGVkIGJlaW5nIGEgc3VyZmFjZSBkaXJlY3RvcnlcbiAqIHdoZW4gdGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgYnVpbHQgdGhlIGRhZW1vbnMgaW50byBpdCwgYW5kIHRoZSBndWFyZHMgYWJvdmVcbiAqIGRvIG5vdCBkaXN0aW5ndWlzaCBgaW5kZXgtPGhhc2g+LmpzYCBmcm9tIGBzZXJ2ZXIuanNgLiBSZWFkIHRoYXQgZnVuY3Rpb24nc1xuICogaGVhZGVyIGJlZm9yZSB0b3VjaGluZyB0aGlzIGxpbmU7IHRoZSB3aGl0ZWxpc3QgaXMgdGhlIGRlZmVuY2UuXG4gKlxuICog4pqgIFRoZSBuZXN0aW5nIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwnc1xuICogb3duIHJvdXRlczogbWFncGllLCBib3VudHksIGdsYW1vdXIgYW5kIGltYWdvIGVhY2ggaGF2ZSBhbiBgL2Fzc2V0cy88bmFtZT5gXG4gKiByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXMgcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW5cbiAqIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3byBmaWdodGluZy4gVGhlIHdoaXRlbGlzdCBnb3Zlcm5zIGBkaXN0L2AgcmVhZHMgT05MWVxuICog4oCUIGl0IG5ldmVyIHNlZXMgdGhvc2Ugcm91dGVzIGFuZCBtdXN0IG5ldmVyIGJlIHdpZGVuZWQgaW50byB0aGVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmICghc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKS5oYXMocmVsKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG5cbi8qKiBgc3JjYC9gaHJlZmAgdmFsdWVzIGluIGEgYnVpbHQgZW50cnkgZG9jdW1lbnQsIGAuL2AtcHJlZml4ZWQgb3IgYmFyZS4gKi9cbmNvbnN0IEVOVFJZX1JFRl9SRSA9IC8oPzpzcmN8aHJlZilcXHMqPVxccypcIig/OlxcLlxcLyk/KFteXCJdKylcIi9nO1xuXG4vKiogQSBgLi9gLVBSRUZJWEVEIHNpYmxpbmcgc3BlY2lmaWVyIOKAlCBgXCIuL25hbWVcImAsIGAnLi9uYW1lJ2AsIGAoLi9uYW1lKWAg4oCUIHdoaWNoXG4gKiAgaXMgdGhlIG9ubHkgc2hhcGUgYSBidW5kbGVyIGVtaXRzIGZvciBhIHNpYmxpbmcgY2h1bmsuIFJlcXVpcmluZyB0aGUgYC4vYCBpc1xuICogIHdoYXQga2VlcHMgYSBzdHJpbmcgbGl0ZXJhbCB0aGF0IG1lcmVseSBTQVlTIGBjbGkuanNgIG91dCBvZiB0aGUgc2V0LiAqL1xuY29uc3QgUkVMQVRJVkVfUkVGX1JFID0gL1tcIicoXVxcLlxcLyhbXlwiJygpXFxzXSspW1wiJyldL2c7XG5cbi8qKiBPbmx5IHRleHQgdGhlIGJ1aWxkIGVtaXRzIGFzIHN1cmZhY2UgY29kZSBpcyBzY2FubmVkIGZvciBvbndhcmQgcmVmZXJlbmNlcy5cbiAqICBBIGAucG5nYCBpcyBhIGxlYWY7IG9wZW5pbmcgaXQgd291bGQgYmUgcmVhZGluZyBhIGJpbmFyeSBmb3IgZmlsZW5hbWVzLiAqL1xuY29uc3QgVFJBTlNJVElWRV9FWFRTID0gW1wiLmpzXCIsIFwiLmNzc1wiXTtcblxuLyoqIE9uZSBkZXJpdmF0aW9uIHBlciBgZGlzdC9gLCBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3Mg4oCUIGBkaXN0L2AgaXMgYSBidWlsZFxuICogIGFydGlmYWN0IGFuZCBkb2VzIG5vdCBjaGFuZ2UgdW5kZXIgYSBydW5uaW5nIGRhZW1vbi4gS2V5ZWQgYnkgZGlyZWN0b3J5IHNvXG4gKiAgdHdvIGRhZW1vbnMgaW4gb25lIHByb2Nlc3MgKGFuZCBldmVyeSB0ZXN0IHdpdGggaXRzIG93biB0ZW1wIHRyZWUpIHN0YXlcbiAqICBpbmRlcGVuZGVudC4gKi9cbmNvbnN0IHdoaXRlbGlzdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+KCk7XG5cbmZ1bmN0aW9uIHJlZnNJbih0ZXh0OiBzdHJpbmcsIHJlOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIHJldHVybiAoXG4gICAgWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgICAgLm1hcCgoWywgcmVmXSkgPT4gcmVmKVxuICAgICAgLy8gQSBUWVBFIFBSRURJQ0FURSwgYW5kIGhvbmVzdCBvbmx5IGJlY2F1c2UgaXRzIGZpcnN0IGNsYXVzZSB3YXMgYWxyZWFkeVxuICAgICAgLy8gaGVyZTogYCEhcmVmYCBpcyB0aGUgcnVudGltZSBjaGVjayB0aGF0IG1ha2VzIGByZWYgaXMgc3RyaW5nYCB0cnVlICh0aGVcbiAgICAgIC8vIEZFTEwgc2VudGVuY2UncyBwcmVkaWNhdGUgcm91dGUsIHRha2VuIHdpdGggaXRzIGNsYXVzZSDigJQgdHlwZS1kZWJ0IFQzNikuXG4gICAgICAuZmlsdGVyKFxuICAgICAgICAocmVmKTogcmVmIGlzIHN0cmluZyA9PlxuICAgICAgICAgICEhcmVmICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiLi5cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiOlwiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCI/XCIpLFxuICAgICAgKVxuICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLy8gRmluZGluZyB3aGVyZSBhIG5vdGUgYmVsb25ncywgaW4gYSBkb2N1bWVudCB0aGF0IGhhcyBtb3ZlZCB1bmRlciBpdCAoRTQ1KS5cbi8vXG4vLyDim5QgUVVPVEVELVRFWFQgQU5DSE9SSU5HLCBBTkQgVEhFIEFMVEVSTkFUSVZFIElTIFdIWS4gQW4gb2Zmc2V0IGdvZXMgc3RhbGUgb25cbi8vIHRoZSBuZXh0IGtleXN0cm9rZTogZml4IGEgdHlwbyB0aHJlZSBsaW5lcyB1cCBhbmQgZXZlcnkgbm90ZSBiZWxvdyBwb2ludHMgYXRcbi8vIHRoZSB3cm9uZyB3b3Jkcy4gUGlubmluZyBhIG5vdGUgdG8gdGhlIFZFUlNJT04gaXQgd2FzIG1hZGUgb24gd291bGQgYmUgZXhhY3Rcbi8vIGZvcmV2ZXIgYW5kIHVzZWxlc3Mg4oCUIHRoZSBzdGF0ZWQgdXNlIGlzIG1ha2luZyBub3RlcyBXSElMRSByZWFkaW5nIGFuZFxuLy8gZWRpdGluZywgYW5kIGEgbm90ZSB0aGF0IGRldGFjaGVzIHRoZSBtb21lbnQgeW91IGVkaXQgaXMgYSBub3RlIHlvdSBjYW5ub3Rcbi8vIHVzZS4gU28gYSBub3RlIHJlbWVtYmVycyB0aGUgVEVYVCBpdCB3YXMgbWFkZSBvbiwgcGx1cyBhIGxpdHRsZSBvZiB3aGF0XG4vLyBzdXJyb3VuZGVkIGl0LCBhbmQgaXMgcmUtZm91bmQgb24gZXZlcnkgcmVhZCAoQ29sZSBhcHByb3ZlZCB0aGUgdHJhZGU6IFwid2Vcbi8vIHRlc3QgaXQgb3V0IGFuZCBzZWUgaWYgaXQgd29ya3MgYW5kIGFkanVzdCBhcyBuZWVkZWRcIikuXG4vL1xuLy8g4puUIEFORCBJVCBTQVlTIFdIRU4gSVQgSEFTIExPU1QuIFRoZSBmb3VydGggb3V0Y29tZSBpcyBPUlBIQU5FRCDigJQgdGhlIHF1b3RlIGlzXG4vLyBnb25lIGFuZCB0aGUgbm90ZSBpcyBzaG93biBkZXRhY2hlZCByYXRoZXIgdGhhbiBwaW5uZWQgc29tZXdoZXJlIHBsYXVzaWJsZS5cbi8vIFZpc2libGUtYW5kLXdyb25nIGJlYXRzIGludmlzaWJsZS1hbmQtd3Jvbmc7IGEgbm90ZSBzaWxlbnRseSByZS1hbmNob3JlZCBvbnRvXG4vLyB1bnJlbGF0ZWQgd29yZHMgaXMgdGhlIGZhaWx1cmUgdGhpcyBkZXNpZ24gZXhpc3RzIHRvIGF2b2lkLlxuXG4vKiogSG93IG11Y2ggdGV4dCBlaXRoZXIgc2lkZSBpcyBrZXB0LCB0byB0ZWxsIGlkZW50aWNhbCBxdW90ZXMgYXBhcnQuICovXG5leHBvcnQgY29uc3QgQ09OVEVYVF9DSEFSUyA9IDQ4O1xuXG4vKiogV2hhdCBhIG5vdGUgcmVtZW1iZXJzIGFib3V0IHdoZXJlIGl0IHdhcyBtYWRlLiAqL1xuZXhwb3J0IHR5cGUgQW5jaG9yID0ge1xuICAvKiogVGhlIHRleHQgdGhlIG5vdGUgd2FzIG1hZGUgb24uIEVtcHR5IG1lYW5zIHRoZSBub3RlIGlzIGFib3V0IHRoZSBkb2N1bWVudC4gKi9cbiAgcXVvdGU6IHN0cmluZztcbiAgLyoqIFRoZSBjaGFyYWN0ZXJzIGltbWVkaWF0ZWx5IGJlZm9yZSBhbmQgYWZ0ZXIgdGhlIHF1b3RlLCB3aGVuIGl0IHdhcyBtYWRlLiAqL1xuICBiZWZvcmU6IHN0cmluZztcbiAgYWZ0ZXI6IHN0cmluZztcbiAgLyoqIFdoZXJlIGl0IHdhcyB0aGVuIOKAlCBhIEhJTlQgZm9yIGNob29zaW5nIGJldHdlZW4gaWRlbnRpY2FsIHF1b3RlcywgbmV2ZXIgYSBzb3VyY2Ugb2YgdHJ1dGguICovXG4gIGF0OiBudW1iZXI7XG59O1xuXG4vKiogV2hlcmUgYSBub3RlIGJlbG9uZ3Mgbm93LCBhbmQgaG93IHN1cmUgd2UgYXJlLiAqL1xuZXhwb3J0IHR5cGUgRm91bmQgPVxuICB8IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyOyBob3c6IFwiY29udGV4dFwiIHwgXCJ1bmlxdWVcIiB8IFwibmVhcmVzdFwiIH1cbiAgfCB7IGZyb206IG51bGw7IHRvOiBudWxsOyBob3c6IFwib3JwaGFuZWRcIiB9O1xuXG5jb25zdCBPUlBIQU5FRDogRm91bmQgPSB7IGZyb206IG51bGwsIHRvOiBudWxsLCBob3c6IFwib3JwaGFuZWRcIiB9O1xuXG4vKiogVGFrZSBhbiBhbmNob3IgZnJvbSBhIHNlbGVjdGlvbiDigJQgd2hhdCB0aGUgbm90ZSB3aWxsIHJlbWVtYmVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFuY2hvck9mKHRleHQ6IHN0cmluZywgZnJvbTogbnVtYmVyLCB0bzogbnVtYmVyKTogQW5jaG9yIHtcbiAgcmV0dXJuIHtcbiAgICBxdW90ZTogdGV4dC5zbGljZShmcm9tLCB0byksXG4gICAgYmVmb3JlOiB0ZXh0LnNsaWNlKE1hdGgubWF4KDAsIGZyb20gLSBDT05URVhUX0NIQVJTKSwgZnJvbSksXG4gICAgYWZ0ZXI6IHRleHQuc2xpY2UodG8sIHRvICsgQ09OVEVYVF9DSEFSUyksXG4gICAgYXQ6IGZyb20sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBpbmRleCBhdCB3aGljaCBgbmVlZGxlYCBvY2N1cnMgaW4gYGhheWAsIGluY2x1ZGluZyBvdmVybGFwcy4gKi9cbmZ1bmN0aW9uIG9jY3VycmVuY2VzKGhheTogc3RyaW5nLCBuZWVkbGU6IHN0cmluZyk6IG51bWJlcltdIHtcbiAgaWYgKG5lZWRsZSA9PT0gXCJcIikgcmV0dXJuIFtdO1xuICBjb25zdCBmb3VuZDogbnVtYmVyW10gPSBbXTtcbiAgbGV0IGkgPSBoYXkuaW5kZXhPZihuZWVkbGUpO1xuICB3aGlsZSAoaSAhPT0gLTEpIHtcbiAgICBmb3VuZC5wdXNoKGkpO1xuICAgIGkgPSBoYXkuaW5kZXhPZihuZWVkbGUsIGkgKyAxKTtcbiAgfVxuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogV2hlcmUgdGhlIG5vdGUgYmVsb25ncyBpbiBgdGV4dGAgbm93LlxuICpcbiAqIEZvdXIgYW5zd2VycywgdHJpZWQgaW4gb3JkZXIsIGFuZCBlYWNoIHNheXMgaG93IGl0IHdhcyByZWFjaGVkIHNvIHRoZSBzdXJmYWNlXG4gKiBjYW4gc2hvdyBhIHJlLWFuY2hvcmVkIG5vdGUgZGlmZmVyZW50bHkgZnJvbSBhIGNlcnRhaW4gb25lOlxuICpcbiAqIDEuICoqY29udGV4dCoqIOKAlCB0aGUgcXVvdGUgV0lUSCBpdHMgc3Vycm91bmRpbmdzIG9jY3VycyBleGFjdGx5IG9uY2UuIFRoZVxuICogICAgc3Ryb25nZXN0IGFuc3dlcjogdHdvIGlkZW50aWNhbCBzZW50ZW5jZXMgYXJlIHRvbGQgYXBhcnQgYnkgd2hhdCBpc1xuICogICAgYXJvdW5kIHRoZW0uXG4gKiAyLiAqKnVuaXF1ZSoqIOKAlCB0aGUgcXVvdGUgb2NjdXJzIGV4YWN0bHkgb25jZS4gSXRzIHN1cnJvdW5kaW5ncyBjaGFuZ2VkLCB0aGVcbiAqICAgIHRleHQgZGlkIG5vdC5cbiAqIDMuICoqbmVhcmVzdCoqIOKAlCB0aGUgcXVvdGUgb2NjdXJzIHNldmVyYWwgdGltZXM7IHRoZSBvbmUgY2xvc2VzdCB0byB3aGVyZSBpdFxuICogICAgdXNlZCB0byBiZSB3aW5zLiBBIGd1ZXNzLCBhbmQgbGFiZWxsZWQgYXMgb25lLlxuICogNC4gKipvcnBoYW5lZCoqIOKAlCB0aGUgcXVvdGUgaXMgZ29uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRBbmNob3IodGV4dDogc3RyaW5nLCBhbmNob3I6IEFuY2hvcik6IEZvdW5kIHtcbiAgaWYgKGFuY2hvci5xdW90ZSA9PT0gXCJcIikgcmV0dXJuIE9SUEhBTkVEO1xuXG4gIC8vIDEuIFdpdGggY29udGV4dC4gVGhlIHJlY29yZGVkIGNvbnRleHQgbWF5IGl0c2VsZiBiZSBjbGlwcGVkIGF0IGEgZG9jdW1lbnRcbiAgLy8gICAgZWRnZSwgc28gdGhlIHdob2xlIHJ1biBpcyBzZWFyY2hlZCByYXRoZXIgdGhhbiBhc3NlbWJsZWQgYmxpbmRseS5cbiAgY29uc3Qgd2l0aENvbnRleHQgPSBhbmNob3IuYmVmb3JlICsgYW5jaG9yLnF1b3RlICsgYW5jaG9yLmFmdGVyO1xuICBjb25zdCBjb250ZXh0cyA9IG9jY3VycmVuY2VzKHRleHQsIHdpdGhDb250ZXh0KTtcbiAgaWYgKGNvbnRleHRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IGZyb20gPSAoY29udGV4dHNbMF0gYXMgbnVtYmVyKSArIGFuY2hvci5iZWZvcmUubGVuZ3RoO1xuICAgIHJldHVybiB7IGZyb20sIHRvOiBmcm9tICsgYW5jaG9yLnF1b3RlLmxlbmd0aCwgaG93OiBcImNvbnRleHRcIiB9O1xuICB9XG5cbiAgY29uc3QgaGl0cyA9IG9jY3VycmVuY2VzKHRleHQsIGFuY2hvci5xdW90ZSk7XG4gIGlmIChoaXRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIE9SUEhBTkVEO1xuXG4gIC8vIDIuIFRoZSBxdW90ZSBhbG9uZSwgb25jZS5cbiAgaWYgKGhpdHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgZnJvbSA9IGhpdHNbMF0gYXMgbnVtYmVyO1xuICAgIHJldHVybiB7IGZyb20sIHRvOiBmcm9tICsgYW5jaG9yLnF1b3RlLmxlbmd0aCwgaG93OiBcInVuaXF1ZVwiIH07XG4gIH1cblxuICAvLyAzLiBTZXZlcmFsIOKAlCB0YWtlIHRoZSBvbmUgbmVhcmVzdCB3aGVyZSBpdCB3YXMuIGBhdGAgaXMgYSBoaW50LCB3aGljaCBpc1xuICAvLyAgICB3aHkgdGhpcyBhbnN3ZXIgaXMgbGFiZWxsZWQ6IHRoZSBub3RlIG1heSBoYXZlIGxhbmRlZCBvbiBhIHR3aW4uXG4gIGxldCBiZXN0ID0gaGl0c1swXSBhcyBudW1iZXI7XG4gIGZvciAoY29uc3QgaGl0IG9mIGhpdHMpIGlmIChNYXRoLmFicyhoaXQgLSBhbmNob3IuYXQpIDwgTWF0aC5hYnMoYmVzdCAtIGFuY2hvci5hdCkpIGJlc3QgPSBoaXQ7XG4gIHJldHVybiB7IGZyb206IGJlc3QsIHRvOiBiZXN0ICsgYW5jaG9yLnF1b3RlLmxlbmd0aCwgaG93OiBcIm5lYXJlc3RcIiB9O1xufVxuXG4vKiogQSBvbmUtbGluZSB2ZXJzaW9uIG9mIHRoZSBxdW90ZSwgZm9yIGEgbGlzdCB0aGF0IGNhbm5vdCBzaG93IGFsbCBvZiBpdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBxdW90ZUxhYmVsKHF1b3RlOiBzdHJpbmcsIG1heCA9IDYwKTogc3RyaW5nIHtcbiAgY29uc3QgZmxhdCA9IHF1b3RlLnJlcGxhY2UoL1xccysvZ3UsIFwiIFwiKS50cmltKCk7XG4gIHJldHVybiBmbGF0Lmxlbmd0aCA8PSBtYXggPyBmbGF0IDogYCR7ZmxhdC5zbGljZSgwLCBtYXggLSAxKS50cmltRW5kKCl94oCmYDtcbn1cbiIsCiAgICAiLy8gQ29tcGFyaW5nIHR3byB0ZXh0cywgYW5kIHRha2luZyBwYXJ0IG9mIG9uZSBpbnRvIHRoZSBvdGhlciAoRTM2KS5cbi8vXG4vLyDim5QgT05FIERJRkYsIENPTVBVVEVEIElOIFRIRSBEQUVNT04uIGBAY29kZW1pcnJvci9tZXJnZWAgd2FzIG1lYXN1cmVkIGZpcnN0XG4vLyBhbmQgaXQgaXMgYnVuZGxlLWNsZWFuIOKAlCBpdHMgb25seSBkZXBlbmRlbmNpZXMgYXJlIGBAY29kZW1pcnJvci9sYW5ndWFnZWAsXG4vLyBgc3RhdGVgLCBgdmlld2AgYW5kIGBAbGV6ZXIvaGlnaGxpZ2h0YCwgZXZlcnkgb25lIG9mIHdoaWNoIHRoZSBzdXJmYWNlXG4vLyBhbHJlYWR5IHNoaXBzLCBzbyB3YXJkIDFiIGhhcyBub3RoaW5nIHRvIHNheSBhYm91dCBpdC4gSXQgaXMgbm90IHVzZWRcbi8vIGFueXdheSwgYW5kIHRoZSByZWFzb24gaXMgbm90IHdlaWdodDogaXQgd291bGQgZ2l2ZSB0aGUgU1VSRkFDRSBpdHMgb3duXG4vLyBkaWZmIHdoaWxlIHRoZSBgZGlmZmAgQ0xJIHZlcmIgdXNlZCB0aGlzIG1vZHVsZSdzLCBhbmQgYSBodW5rIHRoZSBodW1hblxuLy8gYWNjZXB0cyB3b3VsZCB0aGVuIGJlIGEgaHVuayBhIGRpZmZlcmVudCBlbmdpbmUgZm91bmQuIFR3byBkaWZmIGVuZ2luZXMgb3ZlclxuLy8gb25lIGRvY3VtZW50IGlzIHRoZSBsb2Nrc3RlcC1taXJyb3IgZHJpZnQgdGhpcyByZXBvIGhhcyBhbHJlYWR5IHBhaWQgZm9yXG4vLyBvbmNlLiBUaGUgc3VyZmFjZSByZW5kZXJzIHRoZSBodW5rcyB0aGUgZGFlbW9uIGNvbXB1dGVkLCBhbmQgYG1lcmdlYCBhcHBsaWVzXG4vLyB0aGUgc2FtZSBvbmVzIOKAlCBzbyBhIG1pc21hdGNoIGlzIG5vdCBhIGJ1ZyB0aGF0IGNhbiBiZSB3cml0dGVuIGhlcmUuXG4vL1xuLy8gV2hhdCB0aGlzIGRlbGliZXJhdGVseSBpcyBub3Q6IGEgc2VtYW50aWMgb3Igc3ludGFjdGljIGRpZmYuIEl0IGNvbXBhcmVzXG4vLyBMSU5FUywgdGhlbiByZWZpbmVzIGluc2lkZSBwYWlyZWQgbGluZXMgYnkgV09SRCwgd2hpY2ggaXMgd2hhdCBhIHByb3NlXG4vLyByZWFkZXIgd2FudHMg4oCUIG1vdmVkIHBhcmFncmFwaHMgcmVhZCBhcyBhIGRlbGV0ZSBhbmQgYW4gYWRkLCBhbmQgdGhhdCBpc1xuLy8gdGhlIGhvbmVzdCBhbnN3ZXIgcmF0aGVyIHRoYW4gYSB3cm9uZyBjbGV2ZXIgb25lLlxuaW1wb3J0IHR5cGUgeyBEaWZmLCBEaWZmSHVuaywgRGlmZkxpbmUsIERpZmZTcGFuIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqXG4gKiBTcGxpdHRpbmcgb24gXCJcXG5cIiBhbmQgam9pbmluZyBvbiBcIlxcblwiIHJvdW5kLXRyaXBzIGV4YWN0bHksIElOQ0xVRElORyB0aGVcbiAqIHRyYWlsaW5nIGVtcHR5IHN0cmluZyBhIGZpbGUgZW5kaW5nIGluIGEgbmV3bGluZSBwcm9kdWNlcy4gVGhhdCBlbXB0eSBsaW5lXG4gKiBpcyByZWFsIGFzIGZhciBhcyB0aGlzIG1vZHVsZSBpcyBjb25jZXJuZWQsIHdoaWNoIGlzIHdoYXQga2VlcHMgYSBtZXJnZSBmcm9tXG4gKiBxdWlldGx5IGFkZGluZyBvciBkcm9wcGluZyBhIGZpbmFsIG5ld2xpbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdExpbmVzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRleHQuc3BsaXQoXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNhcCBvbiBNeWVycycgRCDigJQgdGhlIG51bWJlciBvZiBlZGl0cyBpdCB3aWxsIHdhbGsgYmVmb3JlIGdpdmluZyB1cC5cbiAqIFR3byB0ZXh0cyBkaWZmZXJpbmcgYnkgbW9yZSB0aGFuIHRoaXMgYXJlIG5vdCBzb21ldGhpbmcgYSBodW1hbiByZWFkcyBodW5rXG4gKiBieSBodW5rIGFueXdheSwgYW5kIHRoZSBxdWFkcmF0aWMgd29yc3QgY2FzZSBpcyB3aGF0IHRoZSBjYXAgZXhpc3RzIHRvIGtlZXBcbiAqIG91dCBvZiBhIGRhZW1vbiBzZXJ2aW5nIGEgc3VyZmFjZS5cbiAqL1xuY29uc3QgTUFYX0VESVRTID0gMzAwMDtcblxuLyoqXG4gKiBNeWVycycgZ3JlZWR5IE8oTkQpIGRpZmYgb3ZlciBsaW5lcy4gUmV0dXJucyB0aGUgdHJhY2Ugb2YgViBhcnJheXMsIG9yIG51bGxcbiAqIHdoZW4gdGhlIHRleHRzIGRpZmZlciBieSBtb3JlIHRoYW4gYE1BWF9FRElUU2AuXG4gKi9cbmZ1bmN0aW9uIG15ZXJzVHJhY2UoYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdKTogSW50MzJBcnJheVtdIHwgbnVsbCB7XG4gIGNvbnN0IG4gPSBhLmxlbmd0aDtcbiAgY29uc3QgbSA9IGIubGVuZ3RoO1xuICBjb25zdCBtYXggPSBNYXRoLm1pbihuICsgbSwgTUFYX0VESVRTKTtcbiAgY29uc3Qgc2l6ZSA9IDIgKiBtYXggKyAxO1xuICBjb25zdCBvZmZzZXQgPSBtYXg7XG4gIGxldCB2ID0gbmV3IEludDMyQXJyYXkoc2l6ZSk7XG4gIGNvbnN0IHRyYWNlOiBJbnQzMkFycmF5W10gPSBbXTtcbiAgZm9yIChsZXQgZCA9IDA7IGQgPD0gbWF4OyBkKyspIHtcbiAgICB0cmFjZS5wdXNoKHYuc2xpY2UoKSk7XG4gICAgZm9yIChsZXQgayA9IC1kOyBrIDw9IGQ7IGsgKz0gMikge1xuICAgICAgLy8gVGFrZSB0aGUgbG9uZ2VyIG9mIHRoZSB0d28gcmVhY2hhYmxlIHBhdGhzOiBkb3duIChhbiBpbnNlcnRpb24pIHdoZW5cbiAgICAgIC8vIGsgaXMgYXQgdGhlIGxvd2VyIGVkZ2Ugb3IgdGhlIGRvd24tbmVpZ2hib3VyIGhhcyBjb21lIGZ1cnRoZXIuXG4gICAgICBjb25zdCBkb3duID0gdltvZmZzZXQgKyBrICsgMV0gYXMgbnVtYmVyO1xuICAgICAgY29uc3QgcmlnaHQgPSB2W29mZnNldCArIGsgLSAxXSBhcyBudW1iZXI7XG4gICAgICBsZXQgeDogbnVtYmVyO1xuICAgICAgaWYgKGsgPT09IC1kIHx8IChrICE9PSBkICYmIHJpZ2h0IDwgZG93bikpIHggPSBkb3duO1xuICAgICAgZWxzZSB4ID0gcmlnaHQgKyAxO1xuICAgICAgbGV0IHkgPSB4IC0gaztcbiAgICAgIHdoaWxlICh4IDwgbiAmJiB5IDwgbSAmJiBhW3hdID09PSBiW3ldKSB7XG4gICAgICAgIHgrKztcbiAgICAgICAgeSsrO1xuICAgICAgfVxuICAgICAgdltvZmZzZXQgKyBrXSA9IHg7XG4gICAgICBpZiAoeCA+PSBuICYmIHkgPj0gbSkgcmV0dXJuIHRyYWNlO1xuICAgIH1cbiAgICB2ID0gdi5zbGljZSgpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogV2FsayB0aGUgdHJhY2UgYmFja3dhcmRzIGludG8gYSBsaXN0IG9mIGxpbmUgb3BlcmF0aW9ucywgZnJvbnQgdG8gYmFjay4gKi9cbmZ1bmN0aW9uIGJhY2t0cmFjayhhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10sIHRyYWNlOiBJbnQzMkFycmF5W10pOiBEaWZmTGluZVtdIHtcbiAgY29uc3Qgb2Zmc2V0ID0gTWF0aC5taW4oYS5sZW5ndGggKyBiLmxlbmd0aCwgTUFYX0VESVRTKTtcbiAgY29uc3Qgb3V0OiBEaWZmTGluZVtdID0gW107XG4gIGxldCB4ID0gYS5sZW5ndGg7XG4gIGxldCB5ID0gYi5sZW5ndGg7XG4gIGZvciAobGV0IGQgPSB0cmFjZS5sZW5ndGggLSAxOyBkID49IDA7IGQtLSkge1xuICAgIGNvbnN0IHYgPSB0cmFjZVtkXSBhcyBJbnQzMkFycmF5O1xuICAgIGNvbnN0IGsgPSB4IC0geTtcbiAgICBsZXQgcHJldks6IG51bWJlcjtcbiAgICBpZiAoayA9PT0gLWQgfHwgKGsgIT09IGQgJiYgKHZbb2Zmc2V0ICsgayAtIDFdIGFzIG51bWJlcikgPCAodltvZmZzZXQgKyBrICsgMV0gYXMgbnVtYmVyKSkpXG4gICAgICBwcmV2SyA9IGsgKyAxO1xuICAgIGVsc2UgcHJldksgPSBrIC0gMTtcbiAgICBjb25zdCBwcmV2WCA9IHZbb2Zmc2V0ICsgcHJldktdIGFzIG51bWJlcjtcbiAgICBjb25zdCBwcmV2WSA9IHByZXZYIC0gcHJldks7XG4gICAgd2hpbGUgKHggPiBwcmV2WCAmJiB5ID4gcHJldlkpIHtcbiAgICAgIHgtLTtcbiAgICAgIHktLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwic2FtZVwiLCBhOiB4LCBiOiB5LCB0ZXh0OiBhW3hdIGFzIHN0cmluZyB9KTtcbiAgICB9XG4gICAgaWYgKGQgPT09IDApIGJyZWFrO1xuICAgIGlmICh4ID4gcHJldlgpIHtcbiAgICAgIHgtLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwiZGVsXCIsIGE6IHgsIHRleHQ6IGFbeF0gYXMgc3RyaW5nIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB5LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcImFkZFwiLCBiOiB5LCB0ZXh0OiBiW3ldIGFzIHN0cmluZyB9KTtcbiAgICB9XG4gIH1cbiAgb3V0LnJldmVyc2UoKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIEV2ZXJ5IGxpbmUgYXMgb25lIHJlcGxhY2VtZW50IOKAlCB0aGUgaG9uZXN0IGFuc3dlciB3aGVuIE15ZXJzIGdpdmVzIHVwLiAqL1xuZnVuY3Rpb24gY29hcnNlTGluZXMoYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdKTogRGlmZkxpbmVbXSB7XG4gIHJldHVybiBbXG4gICAgLi4uYS5tYXAoKHRleHQsIGkpID0+ICh7IG9wOiBcImRlbFwiIGFzIGNvbnN0LCBhOiBpLCB0ZXh0IH0pKSxcbiAgICAuLi5iLm1hcCgodGV4dCwgaSkgPT4gKHsgb3A6IFwiYWRkXCIgYXMgY29uc3QsIGI6IGksIHRleHQgfSkpLFxuICBdO1xufVxuXG4vKiogR3JvdXAgdGhlIGxpbmUgb3BzIGludG8gY29udGlndW91cyBodW5rcywgbnVtYmVyZWQgZnJvbSAxLiAqL1xuZnVuY3Rpb24gY29sbGVjdChsaW5lczogRGlmZkxpbmVbXSk6IERpZmZIdW5rW10ge1xuICBjb25zdCBodW5rczogRGlmZkh1bmtbXSA9IFtdO1xuICBsZXQgaSA9IDA7XG4gIGxldCBpZCA9IDE7XG4gIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgaWYgKChsaW5lc1tpXSBhcyBEaWZmTGluZSkub3AgPT09IFwic2FtZVwiKSB7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgc3RhcnQgPSBpO1xuICAgIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoICYmIChsaW5lc1tpXSBhcyBEaWZmTGluZSkub3AgIT09IFwic2FtZVwiKSBpKys7XG4gICAgY29uc3QgcnVuID0gbGluZXMuc2xpY2Uoc3RhcnQsIGkpO1xuICAgIGNvbnN0IGRlbCA9IHJ1bi5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiZGVsXCIpO1xuICAgIGNvbnN0IGFkZCA9IHJ1bi5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiYWRkXCIpO1xuICAgIC8vIFdoZXJlIHRoZSBodW5rIHNpdHMgaW4gZWFjaCB0ZXh0OiB0aGUgaW5kZXggb2YgdGhlIGZpcnN0IGxpbmUgaXQgdG91Y2hlcyxcbiAgICAvLyBhbmQgZm9yIGEgcHVyZSBpbnNlcnRpb24sIHRoZSBwb2ludCBpdCBpcyBpbnNlcnRlZCBBVC5cbiAgICBjb25zdCBhRnJvbSA9IGRlbC5sZW5ndGggPyAoKGRlbFswXSBhcyBEaWZmTGluZSkuYSBhcyBudW1iZXIpIDogbmV4dEluZGV4KGxpbmVzLCBzdGFydCwgXCJhXCIpO1xuICAgIGNvbnN0IGJGcm9tID0gYWRkLmxlbmd0aCA/ICgoYWRkWzBdIGFzIERpZmZMaW5lKS5iIGFzIG51bWJlcikgOiBuZXh0SW5kZXgobGluZXMsIHN0YXJ0LCBcImJcIik7XG4gICAgaHVua3MucHVzaCh7XG4gICAgICBpZDogaWQrKyxcbiAgICAgIGFGcm9tLFxuICAgICAgYVRvOiBhRnJvbSArIGRlbC5sZW5ndGgsXG4gICAgICBiRnJvbSxcbiAgICAgIGJUbzogYkZyb20gKyBhZGQubGVuZ3RoLFxuICAgICAgZGVsOiBkZWwubWFwKChsKSA9PiBsLnRleHQpLFxuICAgICAgYWRkOiBhZGQubWFwKChsKSA9PiBsLnRleHQpLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBodW5rcztcbn1cblxuLyoqXG4gKiBUaGUgaW5kZXggYSBwdXJlIGluc2VydGlvbiBvciBkZWxldGlvbiBzaXRzIGF0OiB0aGUgbGluZSBudW1iZXIgb2YgdGhlIG5leHRcbiAqIGBzYW1lYCBsaW5lIG9uIHRoYXQgc2lkZSwgb3IgdGhlIGVuZCBvZiB0aGF0IHRleHQgd2hlbiB0aGVyZSBpcyBub25lLlxuICovXG5mdW5jdGlvbiBuZXh0SW5kZXgobGluZXM6IERpZmZMaW5lW10sIGZyb206IG51bWJlciwgc2lkZTogXCJhXCIgfCBcImJcIik6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSBmcm9tOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhdCA9IChsaW5lc1tpXSBhcyBEaWZmTGluZSlbc2lkZV07XG4gICAgaWYgKGF0ICE9PSB1bmRlZmluZWQpIHJldHVybiBhdDtcbiAgfVxuICBsZXQgbGFzdCA9IC0xO1xuICBmb3IgKGNvbnN0IGwgb2YgbGluZXMpIHtcbiAgICBjb25zdCBhdCA9IGxbc2lkZV07XG4gICAgaWYgKGF0ICE9PSB1bmRlZmluZWQgJiYgYXQgPiBsYXN0KSBsYXN0ID0gYXQ7XG4gIH1cbiAgcmV0dXJuIGxhc3QgKyAxO1xufVxuXG4vKiogV29yZHMsIHdoaXRlc3BhY2UgcnVucyBhbmQgcHVuY3R1YXRpb24gcnVucywga2VwdCBzZXBhcmF0ZSBzbyBzcGFucyBhbGlnbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3JkcyhsaW5lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBsaW5lLm1hdGNoKC9cXHMrfFtcXHB7TH1cXHB7Tn1fXSt8W15cXHNcXHB7TH1cXHB7Tn1fXSsvZ3UpID8/IFtdO1xufVxuXG4vKiogVGhlIHdvcmQtbGV2ZWwgZGlmZiBvZiBvbmUgbGluZSBwYWlyLCBhcyBzcGFucyBvdmVyIGVhY2ggc2lkZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZpbmUoYmVmb3JlOiBzdHJpbmcsIGFmdGVyOiBzdHJpbmcpOiB7IGRlbDogRGlmZlNwYW5bXTsgYWRkOiBEaWZmU3BhbltdIH0ge1xuICBjb25zdCBhID0gd29yZHMoYmVmb3JlKTtcbiAgY29uc3QgYiA9IHdvcmRzKGFmdGVyKTtcbiAgY29uc3QgdHJhY2UgPSBteWVyc1RyYWNlKGEsIGIpO1xuICBpZiAoIXRyYWNlKVxuICAgIHJldHVybiB7IGRlbDogW3sgdGV4dDogYmVmb3JlLCBjaGFuZ2VkOiB0cnVlIH1dLCBhZGQ6IFt7IHRleHQ6IGFmdGVyLCBjaGFuZ2VkOiB0cnVlIH1dIH07XG4gIGNvbnN0IG9wcyA9IGJhY2t0cmFjayhhLCBiLCB0cmFjZSk7XG4gIGNvbnN0IGRlbDogRGlmZlNwYW5bXSA9IFtdO1xuICBjb25zdCBhZGQ6IERpZmZTcGFuW10gPSBbXTtcbiAgZm9yIChjb25zdCBvcCBvZiBvcHMpIHtcbiAgICBpZiAob3Aub3AgPT09IFwic2FtZVwiKSB7XG4gICAgICBwdXNoKGRlbCwgb3AudGV4dCwgZmFsc2UpO1xuICAgICAgcHVzaChhZGQsIG9wLnRleHQsIGZhbHNlKTtcbiAgICB9IGVsc2UgaWYgKG9wLm9wID09PSBcImRlbFwiKSBwdXNoKGRlbCwgb3AudGV4dCwgdHJ1ZSk7XG4gICAgZWxzZSBwdXNoKGFkZCwgb3AudGV4dCwgdHJ1ZSk7XG4gIH1cbiAgcmV0dXJuIHsgZGVsLCBhZGQgfTtcbn1cblxuLyoqIEFwcGVuZCwgbWVyZ2luZyBpbnRvIHRoZSBwcmV2aW91cyBzcGFuIHdoZW4gaXQgY2FycmllcyB0aGUgc2FtZSB2ZXJkaWN0LiAqL1xuZnVuY3Rpb24gcHVzaChzcGFuczogRGlmZlNwYW5bXSwgdGV4dDogc3RyaW5nLCBjaGFuZ2VkOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGxhc3QgPSBzcGFuc1tzcGFucy5sZW5ndGggLSAxXTtcbiAgaWYgKGxhc3QgJiYgbGFzdC5jaGFuZ2VkID09PSBjaGFuZ2VkKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBzcGFucy5wdXNoKHsgdGV4dCwgY2hhbmdlZCB9KTtcbn1cblxuLyoqXG4gKiBSZWZpbmUgYSBodW5rJ3MgbGluZXMgd2hlbiB0aGV5IGNhbiBiZSBQQUlSRUQuIEEgaHVuayByZXBsYWNpbmcgdGhyZWUgbGluZXNcbiAqIHdpdGggdGhyZWUgaXMgcGFpcmVkIGxpbmUgYnkgbGluZTsgYSAxLWZvci1tYW55IGh1bmsgaXMgbm90LCBhbmQgZ2V0cyBub1xuICogc3BhbnMgcmF0aGVyIHRoYW4gYW4gYXJiaXRyYXJ5IHBhaXJpbmcg4oCUIHNob3dpbmcgYSB3b3JkLWxldmVsIGRpZmYgYWdhaW5zdFxuICogdGhlIHdyb25nIGxpbmUgaXMgd29yc2UgdGhhbiBzaG93aW5nIG5vbmUuXG4gKi9cbmZ1bmN0aW9uIHJlZmluZUh1bmsobGluZXM6IERpZmZMaW5lW10sIGh1bms6IERpZmZIdW5rKTogdm9pZCB7XG4gIGlmIChodW5rLmRlbC5sZW5ndGggIT09IGh1bmsuYWRkLmxlbmd0aCB8fCBodW5rLmRlbC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgY29uc3QgZGVscyA9IGxpbmVzLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJkZWxcIiAmJiBpblJhbmdlKGwuYSwgaHVuay5hRnJvbSwgaHVuay5hVG8pKTtcbiAgY29uc3QgYWRkcyA9IGxpbmVzLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJhZGRcIiAmJiBpblJhbmdlKGwuYiwgaHVuay5iRnJvbSwgaHVuay5iVG8pKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBkZWxzLmxlbmd0aCAmJiBpIDwgYWRkcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGQgPSBkZWxzW2ldIGFzIERpZmZMaW5lO1xuICAgIGNvbnN0IGFkID0gYWRkc1tpXSBhcyBEaWZmTGluZTtcbiAgICBjb25zdCB7IGRlbCwgYWRkIH0gPSByZWZpbmUoZC50ZXh0LCBhZC50ZXh0KTtcbiAgICBkLnNwYW5zID0gZGVsO1xuICAgIGFkLnNwYW5zID0gYWRkO1xuICB9XG59XG5cbmZ1bmN0aW9uIGluUmFuZ2UoYXQ6IG51bWJlciB8IHVuZGVmaW5lZCwgZnJvbTogbnVtYmVyLCB0bzogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiBhdCAhPT0gdW5kZWZpbmVkICYmIGF0ID49IGZyb20gJiYgYXQgPCB0bztcbn1cblxuLyoqIENvbXBhcmUgdHdvIHRleHRzIGJ5IGxpbmUsIHJlZmluZWQgYnkgd29yZCBpbnNpZGUgcGFpcmVkIGxpbmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZmZUZXh0KGJlZm9yZTogc3RyaW5nLCBhZnRlcjogc3RyaW5nKTogRGlmZiB7XG4gIGlmIChiZWZvcmUgPT09IGFmdGVyKSB7XG4gICAgY29uc3QgbGluZXMgPSBzcGxpdExpbmVzKGJlZm9yZSkubWFwKCh0ZXh0LCBpKSA9PiAoe1xuICAgICAgb3A6IFwic2FtZVwiIGFzIGNvbnN0LFxuICAgICAgYTogaSxcbiAgICAgIGI6IGksXG4gICAgICB0ZXh0LFxuICAgIH0pKTtcbiAgICByZXR1cm4geyBsaW5lcywgaHVua3M6IFtdLCBzYW1lOiB0cnVlLCBjb2Fyc2U6IGZhbHNlIH07XG4gIH1cbiAgY29uc3QgYSA9IHNwbGl0TGluZXMoYmVmb3JlKTtcbiAgY29uc3QgYiA9IHNwbGl0TGluZXMoYWZ0ZXIpO1xuICBjb25zdCB0cmFjZSA9IG15ZXJzVHJhY2UoYSwgYik7XG4gIGNvbnN0IGNvYXJzZSA9IHRyYWNlID09PSBudWxsO1xuICBjb25zdCBsaW5lcyA9IHRyYWNlID8gYmFja3RyYWNrKGEsIGIsIHRyYWNlKSA6IGNvYXJzZUxpbmVzKGEsIGIpO1xuICBjb25zdCBodW5rcyA9IGNvbGxlY3QobGluZXMpO1xuICBmb3IgKGNvbnN0IGggb2YgaHVua3MpIHJlZmluZUh1bmsobGluZXMsIGgpO1xuICByZXR1cm4geyBsaW5lcywgaHVua3MsIHNhbWU6IGZhbHNlLCBjb2Fyc2UgfTtcbn1cblxuLyoqXG4gKiBUYWtlIGh1bmtzIGZyb20gdGhlIHJpZ2h0IHNpZGUgaW50byB0aGUgbGVmdC4gYHRha2VgIGlzIHRoZSBpZHMgdG8gYXBwbHk7XG4gKiBldmVyeSBodW5rIG5vdCBuYW1lZCBpcyBsZWZ0IGFzIHRoZSBsZWZ0IHNpZGUgaGFzIGl0LlxuICpcbiAqIOKblCBBUFBMSUVEIEJBQ0sgVE8gRlJPTlQsIHNvIGFuIGVhcmxpZXIgaHVuaydzIGxpbmUgbnVtYmVycyBhcmUgc3RpbGwgdGhlXG4gKiBvbmVzIHRoZSBkaWZmIHJlcG9ydGVkIHdoZW4gaXQgaXMgcmVhY2hlZC4gQXBwbHlpbmcgZnJvbnQgdG8gYmFjayB3b3VsZFxuICogc2hpZnQgZXZlcnkgbGF0ZXIgaHVuayBieSB0aGUgc2l6ZSBvZiB0aGUgY2hhbmdlIGp1c3QgbWFkZSDigJQgdGhlIGNsYXNzaWMgd2F5XG4gKiBhIG11bHRpLWh1bmsgbWVyZ2UgbGFuZHMgaXRzIGxhc3QgaHVuayBpbiB0aGUgd3JvbmcgcGxhY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUh1bmtzKGJlZm9yZTogc3RyaW5nLCBodW5rczogRGlmZkh1bmtbXSwgdGFrZTogbnVtYmVyW10pOiBzdHJpbmcge1xuICBjb25zdCB3YW50ZWQgPSBuZXcgU2V0KHRha2UpO1xuICBjb25zdCBjaG9zZW4gPSBodW5rcy5maWx0ZXIoKGgpID0+IHdhbnRlZC5oYXMoaC5pZCkpLnNvcnQoKHgsIHkpID0+IHkuYUZyb20gLSB4LmFGcm9tKTtcbiAgY29uc3QgbGluZXMgPSBzcGxpdExpbmVzKGJlZm9yZSk7XG4gIGZvciAoY29uc3QgaCBvZiBjaG9zZW4pIGxpbmVzLnNwbGljZShoLmFGcm9tLCBoLmFUbyAtIGguYUZyb20sIC4uLmguYWRkKTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBVbmlmaWVkLWRpZmYgdGV4dCwgZm9yIHRoZSBhZ2VudCdzIGBkaWZmYCB2ZXJiLiBgY29udGV4dGAgbGluZXMgZWl0aGVyIHNpZGUuICovXG5leHBvcnQgZnVuY3Rpb24gdW5pZmllZChcbiAgZGlmZjogRGlmZixcbiAgb3B0czogeyBmcm9tOiBzdHJpbmc7IHRvOiBzdHJpbmc7IGNvbnRleHQ/OiBudW1iZXIgfSA9IHsgZnJvbTogXCJhXCIsIHRvOiBcImJcIiB9LFxuKTogc3RyaW5nIHtcbiAgaWYgKGRpZmYuc2FtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IGNvbnRleHQgPSBvcHRzLmNvbnRleHQgPz8gMztcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtgLS0tICR7b3B0cy5mcm9tfWAsIGArKysgJHtvcHRzLnRvfWBdO1xuICAvLyBIdW5rcyBjbG9zZXIgdG9nZXRoZXIgdGhhbiAyw5cgY29udGV4dCBzaGFyZSBvbmUgaGVhZGVyLCB0aGUgd2F5IGV2ZXJ5XG4gIC8vIG90aGVyIGRpZmYgdG9vbCBqb2lucyB0aGVtIOKAlCBvdGhlcndpc2UgdGhlIGNvbnRleHQgbGluZXMgcHJpbnQgdHdpY2UuXG4gIGNvbnN0IGdyb3VwczogRGlmZkh1bmtbXVtdID0gW107XG4gIGZvciAoY29uc3QgaCBvZiBkaWZmLmh1bmtzKSB7XG4gICAgY29uc3QgbGFzdCA9IGdyb3Vwc1tncm91cHMubGVuZ3RoIC0gMV07XG4gICAgY29uc3QgcHJldiA9IGxhc3Q/LltsYXN0Lmxlbmd0aCAtIDFdO1xuICAgIGlmIChwcmV2ICYmIGguYUZyb20gLSBwcmV2LmFUbyA8PSBjb250ZXh0ICogMikgKGxhc3QgYXMgRGlmZkh1bmtbXSkucHVzaChoKTtcbiAgICBlbHNlIGdyb3Vwcy5wdXNoKFtoXSk7XG4gIH1cbiAgY29uc3QgYSA9IHNwbGl0TGluZXMoc2lkZVRleHQoZGlmZiwgXCJhXCIpKTtcbiAgY29uc3QgYiA9IHNwbGl0TGluZXMoc2lkZVRleHQoZGlmZiwgXCJiXCIpKTtcbiAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMpIHtcbiAgICBjb25zdCBmaXJzdCA9IGdyb3VwWzBdIGFzIERpZmZIdW5rO1xuICAgIGNvbnN0IGxhc3QgPSBncm91cFtncm91cC5sZW5ndGggLSAxXSBhcyBEaWZmSHVuaztcbiAgICBjb25zdCBhU3RhcnQgPSBNYXRoLm1heCgwLCBmaXJzdC5hRnJvbSAtIGNvbnRleHQpO1xuICAgIGNvbnN0IGFFbmQgPSBNYXRoLm1pbihhLmxlbmd0aCwgbGFzdC5hVG8gKyBjb250ZXh0KTtcbiAgICBjb25zdCBiU3RhcnQgPSBNYXRoLm1heCgwLCBmaXJzdC5iRnJvbSAtIGNvbnRleHQpO1xuICAgIGNvbnN0IGJFbmQgPSBNYXRoLm1pbihiLmxlbmd0aCwgbGFzdC5iVG8gKyBjb250ZXh0KTtcbiAgICBvdXQucHVzaChgQEAgLSR7YVN0YXJ0ICsgMX0sJHthRW5kIC0gYVN0YXJ0fSArJHtiU3RhcnQgKyAxfSwke2JFbmQgLSBiU3RhcnR9IEBAYCk7XG4gICAgbGV0IGF0ID0gYVN0YXJ0O1xuICAgIGZvciAoY29uc3QgaCBvZiBncm91cCkge1xuICAgICAgZm9yICg7IGF0IDwgaC5hRnJvbTsgYXQrKykgb3V0LnB1c2goYCAke2FbYXRdfWApO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGguZGVsKSBvdXQucHVzaChgLSR7bGluZX1gKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBoLmFkZCkgb3V0LnB1c2goYCske2xpbmV9YCk7XG4gICAgICBhdCA9IGguYVRvO1xuICAgIH1cbiAgICBmb3IgKDsgYXQgPCBhRW5kOyBhdCsrKSBvdXQucHVzaChgICR7YVthdF19YCk7XG4gIH1cbiAgcmV0dXJuIGAke291dC5qb2luKFwiXFxuXCIpfVxcbmA7XG59XG5cbi8qKiBSZWJ1aWxkIG9uZSBzaWRlJ3MgdGV4dCBmcm9tIHRoZSBsaW5lIG9wcyDigJQgdXNlZCBieSBgdW5pZmllZGAgZm9yIGNvbnRleHQuICovXG5mdW5jdGlvbiBzaWRlVGV4dChkaWZmOiBEaWZmLCBzaWRlOiBcImFcIiB8IFwiYlwiKTogc3RyaW5nIHtcbiAgY29uc3Qgc2tpcCA9IHNpZGUgPT09IFwiYVwiID8gXCJhZGRcIiA6IFwiZGVsXCI7XG4gIHJldHVybiBkaWZmLmxpbmVzXG4gICAgLmZpbHRlcigobCkgPT4gbC5vcCAhPT0gc2tpcClcbiAgICAubWFwKChsKSA9PiBsLnRleHQpXG4gICAgLmpvaW4oXCJcXG5cIik7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvLyBVbmRvIGFuZCByZWRvIGZvciB0aGUgQ09OVEVYVCDigJQgbW92aW5nIHRoaW5ncyBhcm91bmQsIGFkZGluZywgaGlkaW5nIChFNjApLlxuLy9cbi8vIOKblCBUSElTIElTIE5PVCBUSEUgRURJVE9SJ1MgVU5ETywgYW5kIHRoZSBzdXJmYWNlIHNheXMgc28gYnkgcHV0dGluZyB0aGVzZVxuLy8gYXJyb3dzIGluIHRoZSBjb250ZXh0IGhlYWRlciByYXRoZXIgdGhhbiBhbnl3aGVyZSBuZWFyIHRoZSB0ZXh0LiBDb2RlTWlycm9yJ3Ncbi8vIGhpc3Rvcnkgb3ducyBrZXlzdHJva2VzIGluc2lkZSBhIGRvY3VtZW50OyB0aGlzIG93bnMgYWN0cyBvbiB0aGUgU0hBUEUgb2YgdGhlXG4vLyBjb250ZXh0LCB3aGljaCBpcyB0aGUgdGhpbmcgdGhhdCBoYWQgbm8gd2F5IGJhY2sgYXQgYWxsLiBDb2xlOiBcImxldHRpbmcgdGhlXG4vLyB1c2VyIGtub3cgdGhhdCB0aGVyZSdzIGFuIHVuZG8gZm9yIHRoaXMgc2lkZWJhciB0aGF0IGlzbid0IHRoZSBzYW1lIGFzIHVuZG9cbi8vIHJlZG8gd2hlbiB5b3UncmUgaW4gdGhlIGVkaXRvci5cIlxuLy9cbi8vIOKblCBVTkRPSU5HIEEgQ1JFQVRJT04gREVMRVRFUywgQlVUIE9OTFkgQkVISU5EIEEgQ09ORklSTUFUSU9OLiBUaGlzIHN0YXJ0ZWQgYXNcbi8vIGEgaGFyZCBibG9jayDigJQgdW5kbyBuZXZlciBkZWxldGVzIOKAlCBhbmQgQ29sZSBwdXNoZWQgYmFjaywgY29ycmVjdGx5OiBibG9ja2luZ1xuLy8gZG9lcyBub3QgcmVmdXNlIG9uZSBzdGVwLCBpdCBTVFJBTkRTIEVWRVJZVEhJTkcgQkVISU5EIElULiBDcmVhdGUgYSBmb2xkZXIsIGRvXG4vLyB0d28gbW92ZXMsIGFuZCB5b3UgY2FuIHVuZG8gdGhlIG1vdmVzIGFuZCB0aGVuIG1lZXQgYSB3YWxsIHlvdSBjYW4gbmV2ZXJcbi8vIHBhc3MsIGF0IHdoaWNoIHBvaW50IHRoZSBoaXN0b3J5IGhhcyBzdG9wcGVkIGJlaW5nIGEgaGlzdG9yeS4gQW5kIHRoZSB0aGluZ1xuLy8gdW5kbyB3b3VsZCByZW1vdmUgaXMgb25lIHRoZSBzZXNzaW9uIGl0c2VsZiBtYWRlIG1vbWVudHMgYWdvLCB1c3VhbGx5IGVtcHR5IOKAlFxuLy8gY2F0ZWdvcmljYWxseSBkaWZmZXJlbnQgZnJvbSBkZWxldGluZyB3b3JrLCBhbmQgdGhlIGFwcCBhbHJlYWR5IGhhcyB0aGVcbi8vIHBhdHRlcm4gZm9yIGl0IGluIHRoZSB2ZXJzaW9uLWRlbGV0ZSBkaWFsb2cuIFNvIHRoZSBhcnJvdyBzdGF5cyBlbmFibGVkIGFuZFxuLy8gdGhlIENPTkZJUk1BVElPTiBpcyB0aGUgZ2F0ZS5cbi8vXG4vLyDim5QgV0lUSCBPTkUgSEFSRCBMSU1JVCBUSEFUIElTIE5PVCBORUdPVElBQkxFIEJZIERJQUxPRzogYSBOT04tRU1QVFkgZm9sZGVyIGlzXG4vLyByZWZ1c2VkIG91dHJpZ2h0LiBVbmRvIHdvcmtzIGJhY2t3YXJkcywgc28gaXQgZW1wdGllcyBhIGZvbGRlciBiZWZvcmUgaXRcbi8vIHJlYWNoZXMgdGhhdCBmb2xkZXIncyBjcmVhdGlvbjsgaWYgdGhlIGZvbGRlciBzdGlsbCBoYXMgY29udGVudHMsIHNvbWV0aGluZ1xuLy8gcHV0IHRoZW0gdGhlcmUgdGhhdCB0aGlzIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGFcbi8vIGRpcmVjdG9yeSB0cmVlIGlzIGEgZGlmZmVyZW50IGFjdCBmcm9tIHJlbW92aW5nIHRoZSBlbXB0eSB0aGluZyB5b3UganVzdFxuLy8gbWFkZS4gVGhhdCBjYXNlIHN0b3BzIGFuZCBzYXlzIHdoeS5cbi8vXG4vLyDimqAgVEhFIElOVkVSU0UgSVMgQlVJTFQgV0hFTiBUSEUgQUNUIEhBUFBFTlMsIGZyb20gd2hhdCB3YXMgYWN0dWFsbHkgdHJ1ZVxuLy8gdGhlbiDigJQgbm90IHJlY29uc3RydWN0ZWQgbGF0ZXIgZnJvbSB0aGUgb3AuIEEgYG1vdmVgIHJlY29yZHMgd2hlcmUgdGhlIHRoaW5nXG4vLyBDQU1FIGZyb20gYmVjYXVzZSBvbmx5IHRoZSBtb3ZlciBrbm93czsgYSBgaGlkZWAgcmVjb3JkcyB0aGUgZW50cnkncyB3aG9sZVxuLy8gaGlkZGVuIGxpc3QgYmVjYXVzZSB0aGF0IGlzIHdoYXQgcmVzdG9yZXMgaXQgZXhhY3RseSwgaW5jbHVkaW5nIHRoZSBjYXNlXG4vLyB3aGVyZSBoaWRpbmcgcmVtb3ZlZCBhIHNpbmdsZS1kb2N1bWVudCBlbnRyeSBvdXRyaWdodC5cbmltcG9ydCB0eXBlIHsgU3RydWN0dXJlT3AgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIEhvdyB0byBwdXQgb25lIGFjdCBiYWNrLiBFYWNoIHZhcmlhbnQgaXMgc29tZXRoaW5nIHRoZSBzZXNzaW9uIGNhbiBhbHJlYWR5XG4gKiBkbywgc28gdW5kbyBpbnRyb2R1Y2VzIG5vIG5ldyB3YXkgdG8gY2hhbmdlIHRoZSB3b3JsZCDigJQgaXQgb25seSByZXBsYXlzIHRoZVxuICogZXhpc3Rpbmcgb25lcyB3aXRoIHJlY29yZGVkIGFyZ3VtZW50cy5cbiAqL1xuZXhwb3J0IHR5cGUgSW52ZXJzZSA9XG4gIHwgeyBraW5kOiBcIm1vdmVcIjsgcGF0aDogc3RyaW5nOyBpbnRvOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJyZW5hbWVcIjsgcGF0aDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVxuICAvKiogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSB0aGVzZSByZWxhdGl2ZSBwYXRocy4gKi9cbiAgfCB7IGtpbmQ6IFwiaGlkZGVuXCI7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH1cbiAgLyoqIFB1dCBhIHdob2xlIGRvY3VtZW50IG9yIGZvbGRlciBiYWNrIGluIHRoZSBjb250ZXh0LiAqL1xuICB8IHsga2luZDogXCJjb250ZXh0LmFkZFwiOyBwYXRoOiBzdHJpbmcgfVxuICAvKiogVGFrZSBhIGNvbnRleHQgZW50cnkgYmFjayBvdXQgKHRoZSBpbnZlcnNlIG9mIHB1dHRpbmcgb25lIGluKS4gKi9cbiAgfCB7IGtpbmQ6IFwiY29udGV4dC5yZW1vdmVcIjsgZW50cnk6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIndvcmtzcGFjZVwiOyBwYXRoOiBzdHJpbmcgfVxuICAvKipcbiAgICogUmVtb3ZlIHdoYXQgdGhlIGFjdCBjcmVhdGVkLiBgZGlyYCBkZWNpZGVzIGJvdGggdGhlIGRpYWxvZydzIHdvcmRzIGFuZCB0aGVcbiAgICogZW1wdGluZXNzIHJ1bGUg4oCUIGEgZmlsZSBpcyBjb25maXJtZWQsIGEgZm9sZGVyIGlzIGNvbmZpcm1lZCBBTkQgbXVzdCBiZVxuICAgKiBlbXB0eS5cbiAgICovXG4gIHwgeyBraW5kOiBcImRlbGV0ZVwiOyBwYXRoOiBzdHJpbmc7IGRpcjogYm9vbGVhbiB9O1xuXG4vKiogT25lIGFjdCwgd2l0aCB0aGUgd2F5IGJhY2sgYW5kIGEgc2VudGVuY2UgZm9yIHRoZSBhcnJvdydzIHRvb2x0aXAuICovXG5leHBvcnQgdHlwZSBBY3QgPSB7XG4gIC8qKiBXaGF0IGhhcHBlbmVkLCBmb3IgdGhlIHRvb2x0aXA6IFwibW92ZWQgbm90ZS5tZCBpbnRvIGRyYWZ0c1wiLiAqL1xuICBsYWJlbDogc3RyaW5nO1xuICBpbnZlcnNlOiBJbnZlcnNlO1xufTtcblxuLyoqXG4gKiBXaGF0IHRoZSBzZXNzaW9uIGtuZXcgYmVmb3JlIHRoZSBhY3Qg4oCUIHRoZSBwYXJ0cyBhbiBpbnZlcnNlIG1heSBuZWVkLlxuICpcbiAqIOKaoCBQYXNzZWQgaW4gcmF0aGVyIHRoYW4gcmVhZCBiYWNrIGFmdGVyd2FyZHMsIGJlY2F1c2UgZXZlcnkgZmllbGQgaGVyZSBpc1xuICogc29tZXRoaW5nIHRoZSBhY3QgaXRzZWxmIENIQU5HRVMuIFJlYWRpbmcgYGhpZGRlbmAgYWZ0ZXIgYSBoaWRlIHJldHVybnMgdGhlXG4gKiBsaXN0IGluY2x1ZGluZyB0aGUgdGhpbmcganVzdCBoaWRkZW4sIHdoaWNoIHJlc3RvcmVzIG5vdGhpbmcuXG4gKi9cbmV4cG9ydCB0eXBlIEJlZm9yZSA9IHtcbiAgLyoqIFRoZSBlbnRyeSdzIGhpZGRlbiBsaXN0IGJlZm9yZSB0aGUgYWN0LCB3aGVuIHRoZSBhY3QgdG91Y2hlZCBvbmUuICovXG4gIGhpZGRlbj86IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfTtcbiAgLyoqIFRoZSB3b3Jrc3BhY2UgYmVmb3JlIHRoZSBhY3QuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBXaGF0IHRoZSBhY3QgcmV0dXJuZWQg4oCUIHRoZSBzZXNzaW9uJ3Mgb3duIHJlc3VsdCwgbmFycm93ZWQgdG8gd2hhdCB3ZSB1c2UuICovXG5leHBvcnQgdHlwZSBBZnRlciA9IHtcbiAgcGF0aD86IHN0cmluZztcbiAgLyoqIFdoZXJlIGEgbW92ZSBvciByZW5hbWUgY2FtZSBGUk9NLiAqL1xuICBmcm9tPzogc3RyaW5nO1xuICAvKiogVGhlIGZvbGRlciBgc2V0Lm1ha2VgIGNyZWF0ZWQuICovXG4gIGZvbGRlcj86IHN0cmluZztcbiAgLyoqIFRoZSBlbnRyeSBhIGhpZGUgdG91Y2hlZCwgYW5kIHdoZXRoZXIgaXQgcmVtb3ZlZCB0aGF0IGVudHJ5IGVudGlyZWx5LiAqL1xuICBlbnRyeT86IHN0cmluZztcbiAgcmVtb3ZlZEVudHJ5PzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IGJhc2UgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHAuc3BsaXQoXCIvXCIpLnBvcCgpID8/IHA7XG5jb25zdCBwYXJlbnQgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHAuc2xpY2UoMCwgTWF0aC5tYXgoMCwgcC5sYXN0SW5kZXhPZihcIi9cIikpKSB8fCBcIi9cIjtcblxuLyoqXG4gKiBUaGUgd2F5IGJhY2sgZnJvbSBvbmUgYWN0LlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYW4gYWN0IG5vdCB3b3J0aCBhIGhpc3RvcnkgZW50cnkgYXQgYWxsIOKAlCBgdW5oaWRlYCBvbiBhblxuICogZW50cnkgdGhhdCBoYWQgbm90aGluZyBoaWRkZW4gY2hhbmdlZCBub3RoaW5nLCBhbmQgYW4gdW5kbyBhcnJvdyB0aGF0IHN0ZXBzXG4gKiBvdmVyIG5vLW9wcyBpcyBhbiBhcnJvdyB0aGF0IGxpZXMgYWJvdXQgaG93IGZhciBiYWNrIGl0IGNhbiBnby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5JbnZlcnNlKG9wOiBTdHJ1Y3R1cmVPcCwgYWZ0ZXI6IEFmdGVyLCBiZWZvcmU6IEJlZm9yZSk6IEFjdCB8IG51bGwge1xuICBzd2l0Y2ggKG9wLnR5cGUpIHtcbiAgICAvLyDilIDilIAgYnJvdWdodCBzb21ldGhpbmcgaW50byBleGlzdGVuY2U6IG5vIGludmVyc2UgdGhhdCBkb2VzIG5vdCBkZWxldGUg4pSA4pSAXG4gICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY3JlYXRlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiBmYWxzZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjcmVhdGVkIHRoZSBmb2xkZXIgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogdHJ1ZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNvcGllZCBpbiAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiBmYWxzZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwic2V0Lm1ha2VcIjpcbiAgICAgIC8vIOKaoCBUSEUgRk9MREVSIElTIFRIRSBUSElORyBUTyBVTkRPLCBub3QgdGhlIG1vdmUgaW5zaWRlIGl0LiBgc2V0Lm1ha2VgXG4gICAgICAvLyBjcmVhdGVzIGEgZm9sZGVyIGFuZCBtb3ZlcyB0aGUgZG9jdW1lbnQgaW4sIHNvIHRoZSBpbnZlcnNlIGlzIHRvXG4gICAgICAvLyByZW1vdmUgdGhlIGZvbGRlciDigJQgd2hpY2ggdGhlIGVtcHRpbmVzcyBydWxlIHdpbGwgcmVmdXNlIHdoaWxlIHRoZVxuICAgICAgLy8gZG9jdW1lbnQgaXMgc3RpbGwgaW4gdGhlcmUuIFRoYXQgcmVmdXNhbCBpcyBjb3JyZWN0IGFuZCByZWFkYWJsZVxuICAgICAgLy8gKFwidGhlIGZvbGRlciBpcyBub3QgZW1wdHlcIiksIGFuZCB0aGUgd2F5IHRocm91Z2ggaXQgaXMgdG8gbW92ZSB0aGVcbiAgICAgIC8vIGRvY3VtZW50IG91dCBmaXJzdCwgd2hpY2ggaXMgaXRzZWxmIGFuIHVuZG9hYmxlIGFjdC5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgdHVybmVkICR7YmFzZShvcC5wYXRoKX0gaW50byBhIHNldGAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIuZm9sZGVyID8/IFwiXCIsIGRpcjogdHJ1ZSB9LFxuICAgICAgfTtcblxuICAgIC8vIOKUgOKUgCByZXZlcnNpYmxlLCB3aXRoIGFyZ3VtZW50cyBvbmx5IHRoZSBhY3Qga25ldyDilIDilIBcbiAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICBpZiAoYWZ0ZXIucGF0aCA9PT0gdW5kZWZpbmVkIHx8IGFmdGVyLmZyb20gPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYG1vdmVkICR7YmFzZShhZnRlci5mcm9tKX0gaW50byAke2Jhc2UocGFyZW50KGFmdGVyLnBhdGgpKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwibW92ZVwiLCBwYXRoOiBhZnRlci5wYXRoLCBpbnRvOiBwYXJlbnQoYWZ0ZXIuZnJvbSkgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJyZW5hbWVcIjoge1xuICAgICAgaWYgKGFmdGVyLnBhdGggPT09IHVuZGVmaW5lZCB8fCBhZnRlci5mcm9tID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGByZW5hbWVkICR7YmFzZShhZnRlci5mcm9tKX0gdG8gJHtiYXNlKGFmdGVyLnBhdGgpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJyZW5hbWVcIiwgcGF0aDogYWZ0ZXIucGF0aCwgbmFtZTogYmFzZShhZnRlci5mcm9tKSB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgLy8gVHdvIHNoYXBlczogaGlkaW5nIG9uZSBpdGVtIGluc2lkZSBhIHNldCwgb3IgaGlkaW5nIGEgc2luZ2xlLWRvY3VtZW50XG4gICAgICAvLyBlbnRyeSwgd2hpY2ggcmVtb3ZlcyB0aGUgZW50cnkgb3V0cmlnaHQuXG4gICAgICBpZiAoYWZ0ZXIucmVtb3ZlZEVudHJ5KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGByZW1vdmVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfSBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjb25zdCBoYWQgPSBiZWZvcmUuaGlkZGVuO1xuICAgICAgaWYgKCFoYWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGByZW1vdmVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfSBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImhpZGRlblwiLCBlbnRyeTogaGFkLmVudHJ5LCByZWxzOiBoYWQucmVscyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICBjb25zdCBoYWQgPSBiZWZvcmUuaGlkZGVuO1xuICAgICAgLy8gTm90aGluZyB3YXMgaGlkZGVuLCBzbyBub3RoaW5nIGhhcHBlbmVkOiBub3QgaGlzdG9yeS5cbiAgICAgIGlmICghaGFkIHx8IGhhZC5yZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGJyb3VnaHQgYmFjayAke2hhZC5yZWxzLmxlbmd0aH0gaGlkZGVuIGl0ZW0ke2hhZC5yZWxzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiBoYWQuZW50cnksIHJlbHM6IGhhZC5yZWxzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwid29ya3NwYWNlLnNldFwiOiB7XG4gICAgICBjb25zdCB3YXMgPSBiZWZvcmUud29ya3NwYWNlO1xuICAgICAgaWYgKHdhcyA9PT0gdW5kZWZpbmVkIHx8IHdhcyA9PT0gYWZ0ZXIucGF0aCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHNldCB0aGUgd29ya3NwYWNlIHRvICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJ3b3Jrc3BhY2VcIiwgcGF0aDogd2FzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxufVxuXG4vKiogV2hhdCB0aGUgYXJyb3dzIG5lZWQgdG8ga25vdywgYW5kIG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCB0eXBlIEhpc3RvcnlWaWV3ID0ge1xuICBjYW5VbmRvOiBib29sZWFuO1xuICBjYW5SZWRvOiBib29sZWFuO1xuICAvKiogXCJtb3ZlZCBub3RlLm1kIGludG8gZHJhZnRzXCIsIGZvciB0aGUgdG9vbHRpcC4gKi9cbiAgdW5kb0xhYmVsPzogc3RyaW5nO1xuICByZWRvTGFiZWw/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBTZXQgd2hlbiB0aGUgbmV4dCB1bmRvIHdvdWxkIERFTEVURSBzb21ldGhpbmcsIHNvIHRoZSBzdXJmYWNlIGNhbiByYWlzZSBhXG4gICAqIGNvbmZpcm1hdGlvbiBiZWZvcmUgc2VuZGluZyBpdC4gUHJlc2VudCBtZWFucyBcImFzayBmaXJzdFwiLCBub3QgXCJyZWZ1c2VcIi5cbiAgICovXG4gIHVuZG9EZWxldGVzPzogeyBwYXRoOiBzdHJpbmc7IGRpcjogYm9vbGVhbiB9O1xufTtcblxuLyoqXG4gKiBUaGUgdHdvIHN0YWNrcy5cbiAqXG4gKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBhbmQgdGhhdCBpcyBhIGRlY2lzaW9uIHJhdGhlciB0aGFuXG4gKiBsYXppbmVzczogYW4gaW52ZXJzZSByZWNvcmRlZCBub3cgZGVzY3JpYmVzIHRoZSB3b3JsZCBhcyBpdCBpcyBub3csIGFuZCBhXG4gKiBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGEgZmlsZSBzb21lYm9keSBoYXMgc2luY2UgbW92ZWQgYnkgaGFuZC5cbiAqIE9mZmVyaW5nIGFuIHVuZG8gd2hvc2UgYXJndW1lbnRzIGhhdmUgZ29uZSBzdGFsZSBpcyB3b3JzZSB0aGFuIHN0YXJ0aW5nIGVhY2hcbiAqIHNlc3Npb24gd2l0aCBhbiBlbXB0eSBoaXN0b3J5IOKAlCBzbyB0aGUgYXJyb3dzIGFyZSBncmV5IGFmdGVyIGEgcmVzdG9yZSwgd2hpY2hcbiAqIGlzIGhvbmVzdCBhYm91dCB3aGF0IGNhbiBzdGlsbCBiZSBwdXQgYmFjay5cbiAqL1xuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICBwcml2YXRlIHVuZG9zOiBBY3RbXSA9IFtdO1xuICBwcml2YXRlIHJlZG9zOiBBY3RbXSA9IFtdO1xuXG4gIC8qKiBSZWNvcmQgYW4gYWN0LiBBIG5ldyBhY3QgbWFrZXMgdGhlIHJlZG8gc3RhY2sgbWVhbmluZ2xlc3MuICovXG4gIGRpZChhY3Q6IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIHRoaXMudW5kb3MucHVzaChhY3QpO1xuICAgIHRoaXMucmVkb3MgPSBbXTtcbiAgfVxuXG4gIC8qKiBXaGF0IHRoZSBuZXh0IHVuZG8gd291bGQgZG8sIHdpdGhvdXQgZG9pbmcgaXQuICovXG4gIHBlZWtVbmRvKCk6IEFjdCB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnVuZG9zW3RoaXMudW5kb3MubGVuZ3RoIC0gMV0gPz8gbnVsbDtcbiAgfVxuXG4gIHBlZWtSZWRvKCk6IEFjdCB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnJlZG9zW3RoaXMucmVkb3MubGVuZ3RoIC0gMV0gPz8gbnVsbDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIHRoZSBuZXh0IHVuZG8sIGhhdmluZyBhcHBsaWVkIGl0LiBgcmVkb2AgaXMgdGhlIGFjdCB0aGF0IHdvdWxkIHB1dCBpdFxuICAgKiBiYWNrIOKAlCBidWlsdCBieSB0aGUgY2FsbGVyLCBiZWNhdXNlIG9ubHkgdGhlIGNhbGxlciBrbm93cyB3aGF0IGl0cyBvd25cbiAgICogaW52ZXJzZSBwcm9kdWNlZC5cbiAgICovXG4gIHRvb2tVbmRvKHJlZG86IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBjb25zdCBhY3QgPSB0aGlzLnVuZG9zLnBvcCgpO1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgaWYgKHJlZG8pIHRoaXMucmVkb3MucHVzaChyZWRvKTtcbiAgfVxuXG4gIHRvb2tSZWRvKHVuZG86IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBjb25zdCBhY3QgPSB0aGlzLnJlZG9zLnBvcCgpO1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgaWYgKHVuZG8pIHRoaXMudW5kb3MucHVzaCh1bmRvKTtcbiAgfVxuXG4gIHZpZXcoKTogSGlzdG9yeVZpZXcge1xuICAgIGNvbnN0IHVuZG8gPSB0aGlzLnBlZWtVbmRvKCk7XG4gICAgY29uc3QgcmVkbyA9IHRoaXMucGVla1JlZG8oKTtcbiAgICBjb25zdCBkZWxldGVzID0gdW5kbz8uaW52ZXJzZS5raW5kID09PSBcImRlbGV0ZVwiID8gdW5kby5pbnZlcnNlIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiB7XG4gICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIElTIFNUSUxMIFVORE9BQkxFIOKAlCB0aGUgZ2F0ZSBpcyB0aGUgZGlhbG9nLCBub3QgdGhlXG4gICAgICAvLyBkaXNhYmxlZCBzdGF0ZSAoQ29sZSdzIHJ1bGluZywgcmV2ZXJzaW5nIGFuIGVhcmxpZXIgZGVzaWduIHRoYXRcbiAgICAgIC8vIHN0cmFuZGVkIGV2ZXJ5IGFjdCBiZWhpbmQgYSBjcmVhdGlvbikuXG4gICAgICBjYW5VbmRvOiB1bmRvICE9PSBudWxsLFxuICAgICAgY2FuUmVkbzogcmVkbyAhPT0gbnVsbCxcbiAgICAgIC4uLih1bmRvID8geyB1bmRvTGFiZWw6IHVuZG8ubGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihyZWRvID8geyByZWRvTGFiZWw6IHJlZG8ubGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihkZWxldGVzID8geyB1bmRvRGVsZXRlczogeyBwYXRoOiBkZWxldGVzLnBhdGgsIGRpcjogZGVsZXRlcy5kaXIgfSB9IDoge30pLFxuICAgIH07XG4gIH1cblxuICAvKiogSG93IGRlZXAgdGhlIHN0YWNrcyBhcmUg4oCUIGZvciB0ZXN0cyBhbmQgZm9yIGBzdGF0ZSAtLWZ1bGxgLiAqL1xuICBkZXB0aCgpOiB7IHVuZG86IG51bWJlcjsgcmVkbzogbnVtYmVyIH0ge1xuICAgIHJldHVybiB7IHVuZG86IHRoaXMudW5kb3MubGVuZ3RoLCByZWRvOiB0aGlzLnJlZG9zLmxlbmd0aCB9O1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIE5BVElWRSBmaWxlIHBpY2tlciDigJQgdGhlIGFmZm9yZGFuY2UgYSB3ZWIgcGFnZSBjYW5ub3QgaGF2ZS5cbiAqXG4gKiBBIGJyb3dzZXIncyBvd24gYDxpbnB1dCB0eXBlPVwiZmlsZVwiPmAgYW5kIGBzaG93T3BlbkZpbGVQaWNrZXIoKWAgYm90aCBoYW5kXG4gKiBiYWNrIGZpbGUgQ09OVEVOVCBhbmQgYSBuYW1lLCBuZXZlciBhIHBhdGggKGFuZCBCcmF2ZSwgQ29sZSdzIGJyb3dzZXIsXG4gKiBkaXNhYmxlcyB0aGUgRmlsZSBTeXN0ZW0gQWNjZXNzIEFQSSBvdXRyaWdodCkuIEEgY29weSBpcyBhbGwgYSBwYWdlIGNhbiBkb1xuICogd2l0aCB0aGF0LCB3aGljaCBpcyBleGFjdGx5IHdoYXQgYSBkcm9wIGFscmVhZHkgZG9lcyAoRTIzKS4gQnV0IHNjcmlwdG9yaXVtJ3NcbiAqIGRhZW1vbiBpcyBhIExPQ0FMIFBST0NFU1M6IGl0IGNhbiBhc2sgdGhlIE9TIGZvciBpdHMgb3duIG9wZW4gZGlhbG9nIGFuZCBnZXRcbiAqIGJhY2sgYSByZWFsIGZpbGVzeXN0ZW0gcGF0aCDigJQgc28gXCJDaG9vc2XigKZcIiBsaW5rcyB0aGUgcmVhbCBmaWxlIChFMSkgaW5zdGVhZFxuICogb2YgY29weWluZyBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGhlcmUgaXMgcHVyZTogd2hpY2ggYXJndiB0byBydW4sIGFuZCBob3cgdG8gcmVhZCB3aGF0IGl0IHByaW50ZWQuXG4gKiBUaGUgc3Bhd25pbmcgKGFuZCB0aGUgb25lLWF0LWEtdGltZSBydWxlKSBpcyB0aGUgZGFlbW9uJ3MuXG4gKi9cblxuZXhwb3J0IHR5cGUgUGlja0tpbmQgPSBcImZpbGVcIiB8IFwiZm9sZGVyXCI7XG5cbi8qKiBBbiBBcHBsZVNjcmlwdCB0aGF0IHB1dHMgb25lIFBPU0lYIHBhdGggcGVyIGxpbmUgb24gc3Rkb3V0LiAqL1xuZnVuY3Rpb24gYXBwbGVTY3JpcHQoa2luZDogUGlja0tpbmQsIHByb21wdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcXVvdGVkID0gcHJvbXB0LnJlcGxhY2UoL1tcIlxcXFxdL2csIFwiXCIpO1xuICBjb25zdCBjaG9vc2UgPVxuICAgIGtpbmQgPT09IFwiZmlsZVwiXG4gICAgICA/IGBjaG9vc2UgZmlsZSB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwiIHdpdGggbXVsdGlwbGUgc2VsZWN0aW9ucyBhbGxvd2VkYFxuICAgICAgOiBge2Nob29zZSBmb2xkZXIgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIn1gO1xuICByZXR1cm4gW1xuICAgIGBzZXQgY2hvc2VuIHRvICR7Y2hvb3NlfWAsXG4gICAgJ3NldCBvdXQgdG8gXCJcIicsXG4gICAgXCJyZXBlYXQgd2l0aCBmIGluIGNob3NlblwiLFxuICAgIFwic2V0IG91dCB0byBvdXQgJiBQT1NJWCBwYXRoIG9mIGYgJiBsaW5lZmVlZFwiLFxuICAgIFwiZW5kIHJlcGVhdFwiLFxuICAgIFwicmV0dXJuIG91dFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNvbW1hbmQgdGhhdCBvcGVucyB0aGUgT1MncyBwaWNrZXIsIG9yIG51bGwgd2hlcmUgdGhlcmUgaXMgbm9uZSDigJQgdGhlXG4gKiBjYWxsZXIgdGhlbiBzYXlzIHNvIHJhdGhlciB0aGFuIGhhbmdpbmcgb24gYSBkaWFsb2cgbm9ib2R5IHdpbGwgc2VlLlxuICogYHplbml0eUF0YCBpcyB3aGVyZSBhIExpbnV4IHplbml0eSB3YXMgZm91bmQgKHRoZSBjYWxsZXIgbG9va3MgaXQgdXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja2VyQ29tbWFuZChcbiAgcGxhdGZvcm06IHN0cmluZyxcbiAga2luZDogUGlja0tpbmQsXG4gIHByb21wdDogc3RyaW5nLFxuICB6ZW5pdHlBdD86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAocGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHJldHVybiBbXCJvc2FzY3JpcHRcIiwgXCItZVwiLCBhcHBsZVNjcmlwdChraW5kLCBwcm9tcHQpXTtcbiAgaWYgKHBsYXRmb3JtID09PSBcIndpbjMyXCIpIHJldHVybiBudWxsOyAvLyBQb3dlclNoZWxsJ3MgZGlhbG9nIG5lZWRzIGEgU1RBIGhvc3Q7IG5vdCB3cml0dGVuIHVudGlsIGFza2VkIGZvclxuICBpZiAoemVuaXR5QXQpXG4gICAgcmV0dXJuIFtcbiAgICAgIHplbml0eUF0LFxuICAgICAgXCItLWZpbGUtc2VsZWN0aW9uXCIsXG4gICAgICAuLi4oa2luZCA9PT0gXCJmb2xkZXJcIiA/IFtcIi0tZGlyZWN0b3J5XCJdIDogW1wiLS1tdWx0aXBsZVwiXSksXG4gICAgICBcIi0tc2VwYXJhdG9yPVxcblwiLFxuICAgICAgYC0tdGl0bGU9JHtwcm9tcHR9YCxcbiAgICBdO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBwYXRocyBhIHBpY2tlciBwcmludGVkOiBvbmUgcGVyIGxpbmUsIGJsYW5rcyBkcm9wcGVkLCBvcmRlciBrZXB0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gc3Rkb3V0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXG4gICAgLmZpbHRlcigobCkgPT4gbC5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAubWFwKChsKSA9PiAobC5sZW5ndGggPiAxICYmIGwuZW5kc1dpdGgoXCIvXCIpID8gbC5zbGljZSgwLCAtMSkgOiBsKSk7XG59XG5cbi8qKiBBIGNhbmNlbGxlZCBkaWFsb2cgaXMgbm90IGEgZmFpbHVyZSDigJQgb3Nhc2NyaXB0IGV4aXRzIDEsIHplbml0eSBleGl0cyAxLCBhbmQgbm90aGluZyB3YXMgY2hvc2VuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhc0NhbmNlbGxlZChleGl0Q29kZTogbnVtYmVyLCBzdGRvdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXhpdENvZGUgIT09IDAgJiYgcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0KS5sZW5ndGggPT09IDA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhZFN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgLy8g4pqgIGBybWRpclN5bmNgIHJhdGhlciB0aGFuIGBybVN5bmMo4oCmLCB7cmVjdXJzaXZlOnRydWV9KWAgT04gUFVSUE9TRTogaXRcbiAgLy8gdGhyb3dzIEVOT1RFTVBUWSwgd2hpY2ggaXMgYSBzZWNvbmQgbmV0IHVuZGVyIGByZW1vdmVDcmVhdGVkYCdzIG93blxuICAvLyBlbXB0aW5lc3MgY2hlY2suIEEgcmVjdXJzaXZlIGRlbGV0ZSB3b3VsZCBtYWtlIHRoZSBidWcgaXQgcHJldmVudHNcbiAgLy8gdW5yZWNvdmVyYWJsZSByYXRoZXIgdGhhbiBsb3VkLlxuICBybWRpclN5bmMsXG4gIHJtU3luYyxcbiAgc3RhdFN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHsgdHlwZSBBbmNob3IsIGFuY2hvck9mLCBmaW5kQW5jaG9yIH0gZnJvbSBcIi4vYW5jaG9yc1wiO1xuaW1wb3J0IHsgYXBwbHlIdW5rcywgZGlmZlRleHQgfSBmcm9tIFwiLi9kaWZmXCI7XG5pbXBvcnQge1xuICBib2R5TGluZU9mZnNldCxcbiAgYnVpbGRCbG9jayxcbiAgZ3Vlc3NUeXBlLFxuICBtYXRjaGVzRmlsdGVyLFxuICByZWFkTWV0YSxcbiAgc2V0S2V5LFxuICBzcGxpdEZyb250bWF0dGVyLFxuICBzdW1tYXJpemUsXG4gIHRpdGxlRnJvbUJvZHksXG4gIHdpdGhCbG9jayxcbn0gZnJvbSBcIi4vZnJvbnRtYXR0ZXJcIjtcbmltcG9ydCB7IHR5cGUgQnVuZGxlSW5kZXgsIGJ1aWxkR3JhcGgsIHR5cGUgUmVzb2x1dGlvbiwgcmVzb2x2ZVRhcmdldCB9IGZyb20gXCIuL2xpbmtzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENoYXRNZXNzYWdlLFxuICBDaGF0V2hvLFxuICBDb250ZXh0RW50cnksXG4gIENvbnRleHROb2RlLFxuICBEaWZmUGF5bG9hZCxcbiAgRGlmZlNpZGUsXG4gIERvY01ldGEsXG4gIERvY1N1bW1hcnksXG4gIERvY1ZpZXcsXG4gIEdyYXBoUGF5bG9hZCxcbiAgTWV0YUZpbHRlcixcbiAgTW92ZVBsYW4sXG4gIE5vdGUsXG4gIFBsYWNlZE5vdGUsXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFRhc2ssXG4gIFZlcnNpb24sXG4gIFZlcnNpb25BdXRob3IsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIENhbmRpZGF0ZSwgdHlwZSBTZWFyY2hSZXBvcnQsIHNlYXJjaERvY3VtZW50cyB9IGZyb20gXCIuL3NlYXJjaFwiO1xuaW1wb3J0IHtcbiAgRE9DX0VYVEVOU0lPTlMsXG4gIGRvY1BhdGhzLFxuICBlbnRyeUZvclBhdGgsXG4gIGZpbmROb2RlLFxuICBpc0RvY05hbWUsXG4gIGxvY2F0ZSxcbiAgTUlSUk9SX05PREVfQ0FQLFxuICBzY2FuVHJlZSxcbiAgdG9Qb3NpeCxcbn0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgY29uc3QgTUFOSUZFU1RfRk9STUFUID0gMTtcblxuLyoqIFRoZSBtb3N0IGRvY3VtZW50cyBvbmUgZnJvbnRtYXR0ZXIgc2NhbiByZWFkcy4gKi9cbmV4cG9ydCBjb25zdCBNRVRBX1NDQU5fQ0FQID0gNTAwO1xuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgbGl2ZXMgYXQgdGhlIHRvcCBvZiBhIGZpbGU7IHRoaXMgaXMgaG93IG11Y2ggd2UgcmVhZCB0byBmaW5kIGl0LiAqL1xuY29uc3QgTUVUQV9IRUFEX0JZVEVTID0gODE5MjtcblxuLyoqIFRoZSBmaXJzdCA4IEtCIG9mIGEgZmlsZSwgYXMgdGV4dCDigJQgZW5vdWdoIGZvciBhbnkgZnJvbnRtYXR0ZXIgYmxvY2suICovXG5mdW5jdGlvbiByZWFkSGVhZChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgZmQ6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmZCA9IG9wZW5TeW5jKHBhdGgsIFwiclwiKTtcbiAgICBjb25zdCBidWYgPSBCdWZmZXIuYWxsb2MoTUVUQV9IRUFEX0JZVEVTKTtcbiAgICBjb25zdCByZWFkID0gcmVhZFN5bmMoZmQsIGJ1ZiwgMCwgTUVUQV9IRUFEX0JZVEVTLCAwKTtcbiAgICByZXR1cm4gYnVmLnN1YmFycmF5KDAsIHJlYWQpLnRvU3RyaW5nKFwidXRmOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKGZkICE9PSB1bmRlZmluZWQpIGNsb3NlU3luYyhmZCk7XG4gIH1cbn1cblxudHlwZSBEb2NSZWNvcmQgPSB7XG4gIHNsdWc6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBvcmlnaW5hbDogc3RyaW5nO1xuICBlbnRyeUlkOiBzdHJpbmcgfCBudWxsO1xuICByZWw6IHN0cmluZyB8IG51bGw7XG4gIGV4dDogc3RyaW5nO1xuICB2ZXJzaW9uczogT21pdDxWZXJzaW9uLCBcInBhdGhcIj5bXTtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIC8qKlxuICAgKiBUaGUgbmV4dCB2ZXJzaW9uIG51bWJlciB0byBoYW5kIG91dCDigJQgTU9OT1RPTklDLCBhbmQgbmV2ZXIgZGVyaXZlZCBmcm9tXG4gICAqIHRoZSB2ZXJzaW9ucyBzdGlsbCBwcmVzZW50IChFNDEpLiBOdW1iZXJpbmcgYXMgYG1heChleGlzdGluZykgKyAxYCB3YXNcbiAgICogY29ycmVjdCB3aGlsZSBub3RoaW5nIGNvdWxkIGJlIGRlbGV0ZWQ7IHRoZSBtb21lbnQgYSB2ZXJzaW9uIGNhbiBiZVxuICAgKiByZW1vdmVkLCBkZWxldGluZyB0aGUgaGlnaGVzdCBtYWtlcyB0aGUgbmV4dCBvbmUgUkVVU0UgaXRzIG51bWJlciwgYW5kIGFcbiAgICogYHYzYCBuYW1lZCBpbiBhIGNoYXQgbWVzc2FnZSwgYSBsb2cgbGluZSBvciBhbiBhZ2VudCdzIG5vdGVzIHdvdWxkIHRoZW5cbiAgICogcG9pbnQgYXQgYSBkaWZmZXJlbnQgZG9jdW1lbnQuIEFic2VudCBvbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSDigJRcbiAgICogYHRha2VWZXJzaW9uYCBkZXJpdmVzIGl0IG9uY2UsIGZyb20gdGhlIGhpZ2hlc3QgdGhhdCBldmVyIHdhcy5cbiAgICovXG4gIG5leHRWZXJzaW9uPzogbnVtYmVyO1xuICAvKiogTm90ZXMgb24gdGhpcyBkb2N1bWVudCAoRTQ1KS4gU3RvcmVkIGluIHRoZSBtYW5pZmVzdDogdGhleSB0cmF2ZWwgd2l0aCB0aGVcbiAgICogIHNlc3Npb24gYW5kIG5ldmVyIGxpdHRlciB0aGUgaHVtYW4ncyBmb2xkZXIuICovXG4gIG5vdGVzPzogTm90ZVtdO1xuICAvKiogSGFzaCBvZiB0aGUgb3JpZ2luYWwgYXMgd2UgbGFzdCByZWFkIG9yIHdyb3RlIGl0IOKAlCBhdCBvcGVuLCBzYXZlLCByZXZlcnRcbiAgICogIGFuZCByZWxvYWQg4oCUIHNvIGEgcmVzdG9yZSBjYW4gdGVsbCB0aGF0IGl0IGNoYW5nZWQgd2hpbGUgbm8gZGFlbW9uIHdhc1xuICAgKiAgd2F0Y2hpbmcgKHZlcmlmeS1wYXNzIGZpeCAyKS4gKi9cbiAgb3JpZ2luYWxIYXNoOiBzdHJpbmc7XG4gIC8qKiBTZXQgb25seSBieSBgb3BlblBhdGhgLCB3aGljaCBhZG1pdHMgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogIGVudHJ5LiBgc2F2ZWAgd3JpdGVzIG5vIG9yaWdpbmFsIHRoYXQgbGFja3MgaXQgKHZlcmlmeS1wYXNzIGZpeCAxYykuICovXG4gIGFkbWl0dGVkPzogYm9vbGVhbjtcbiAgb3V0c2lkZUNoYW5nZWQ6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgZm9ybWF0OiBudW1iZXI7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgY29udGV4dDogQ29udGV4dEVudHJ5W107XG4gIGRvY3M6IERvY1JlY29yZFtdO1xuICBvcGVuRG9jOiBzdHJpbmcgfCBudWxsO1xuICBjaGF0OiBDaGF0TWVzc2FnZVtdO1xuICAvKiogVGhlIHdvcmsgcXVldWUgKEU1MCkuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQuICovXG4gIHRhc2tzPzogVGFza1tdO1xuICAvKiogRTIzJ3Mgd29ya3NwYWNlLiBBYnNlbnQgaW4gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBpdCBleGlzdGVkOiB0aGUgdXNlcidzIGhvbWUuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBBIHBhdGgncyByZWFscGF0aCwgb3IgdGhlIHBhdGggaXRzZWxmIHdoZW4gaXQgY2Fubm90IGJlIHJlc29sdmVkIChnb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFsT3IocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcDtcbiAgfVxufVxuXG4vKiogV2hhdCBhIHdhdGNoZXIgZXZlbnQgdHVybmVkIG91dCB0byBiZS4gYG51bGxgID0gbm90aGluZyAob3Vycywgb3Igbm8gY2hhbmdlKS4gKi9cbmV4cG9ydCB0eXBlIEZpbGVFdmVudCA9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IGFjdGl2ZTogZmFsc2UgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIjtcbiAgICAgIGRvYzogc3RyaW5nO1xuICAgICAgdmVyc2lvbjogbnVtYmVyO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgLyoqIFRoZSBuZXcgYWdlbnQgdmVyc2lvbiB0aGUgb3V0c2lkZSB0ZXh0IHdhcyBwcmVzZXJ2ZWQgYXMuICovXG4gICAgICBwcmVzZXJ2ZWRBczogbnVtYmVyO1xuICAgICAgcHJlc2VydmVkUGF0aDogc3RyaW5nO1xuICAgIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGFzIHRoZSBkYWVtb24gbGFzdCB3cm90ZSAob3IgYWRvcHRlZClcbiAgICogIGl0IOKAlCB3aGF0IGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIHJldmVydGVkIHRvLiAqL1xuICBwcml2YXRlIGxhc3RBY3RpdmVUZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFdoYXQgYSByZXN0b3JlIGZvdW5kIGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLiAqL1xuICByZXN0b3JlRmluZGluZ3M6IHsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IG1pc3Npbmc6IGJvb2xlYW4gfVtdID0gW107XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCksIHdvcmtzcGFjZT86IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCB7XG4gICAgICBmb3JtYXQ6IE1BTklGRVNUX0ZPUk1BVCxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGNvbnRleHQ6IFtdLFxuICAgICAgZG9jczogW10sXG4gICAgICBvcGVuRG9jOiBudWxsLFxuICAgICAgY2hhdDogW10sXG4gICAgICAuLi4od29ya3NwYWNlID8geyB3b3Jrc3BhY2U6IHJlc29sdmUod29ya3NwYWNlKSB9IDoge30pLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIGNvbnN0IHRleHQgPSBleGlzdHNTeW5jKHApID8gcmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSA6IFwiXCI7XG4gICAgICBzLmFkb3B0QWN0aXZlKGQsIHRleHQpO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAyOiBhbiBvcmlnaW5hbCBjaGFuZ2VkIHdoaWxlIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWRcbiAgICAgIC8vIHdhcyBpbnZpc2libGUgaGVyZSwgc28gdGhlIG5leHQgU2F2ZSBvdmVyd3JvdGUgaXQgdW5hbm5vdW5jZWQuIFRoZVxuICAgICAgLy8gbWFuaWZlc3QgaG9sZHMgdGhlIG9yaWdpbmFsJ3MgaGFzaCBhcyBvZiB0aGUgbGFzdCBvcGVuL3NhdmUvcmV2ZXJ0L1xuICAgICAgLy8gcmVsb2FkOyBhIGRpZmZlcmVudCBoYXNoIG5vdyBpcyBhbiBvdXRzaWRlIGNoYW5nZSwgbWFya2VkIGV4YWN0bHkgYXMgYVxuICAgICAgLy8gbGl2ZSBvbmUgd2l0aCBhIGRpcnR5IGJ1ZmZlciBpcyDigJQgYXNrZWQsIG5ldmVyIG1lcmdlZCBvciByZWxvYWRlZC5cbiAgICAgIGxldCBub3c6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbm93ID0gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbm93ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChub3cgPT09IG51bGwgfHwgbm93ICE9PSBkLm9yaWdpbmFsSGFzaCkge1xuICAgICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgcy5yZXN0b3JlRmluZGluZ3MucHVzaCh7IGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCwgbWlzc2luZzogbm93ID09PSBudWxsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocy5yZXN0b3JlRmluZGluZ3MubGVuZ3RoID4gMCkgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGVhY2ggZW50cnkgcm9vdCxcbiAgICogYW5kIHRoZSBSRUFMIGRpcmVjdG9yeSBvZiBldmVyeSBvcGVuZWQgb3JpZ2luYWwuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMzogZWFjaCByb290IGlzIHdhdGNoZWQgYXQgaXRzIFJFQUxQQVRIIChgd2F0Y2hgKSwgYW5kXG4gICAqIGFuIGV2ZW50IGlzIHJlcG9ydGVkIHVuZGVyIHRoZSBwYXRoIGZvcm0gdGhlIHNlc3Npb24gc3RvcmVzIChgcGF0aGApLiBBXG4gICAqIHdhdGNoIG9uIGEgc3ltbGlua2VkIGRpcmVjdG9yeSDigJQgYSBzeW1saW5rZWQgaG9tZSwgYSBzeW1saW5rZWQgZm9sZGVyXG4gICAqIGVudHJ5IOKAlCBvciBvbiB0aGUgbGluaydzIG93biBkaXJlY3RvcnkgZm9yIGEgc3ltbGlua2VkIG9yaWdpbmFsIHNhd1xuICAgKiBub3RoaW5nIHdoZW4gdGhlIFRBUkdFVCBjaGFuZ2VkIChGU0V2ZW50cyByZXBvcnRzIHJlYWwgcGF0aHMpLiBBIHN5bWxpbmtlZFxuICAgKiBvcmlnaW5hbCBpcyBtYXRjaGVkIGJhY2sgdG8gaXRzIGRvYyBieSByZWFscGF0aCBpbiBgb25GaWxlRXZlbnRgLlxuICAgKi9cbiAgd2F0Y2hSb290cygpOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSB7XG4gICAgY29uc3Qgcm9vdHM6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdID0gW1xuICAgICAgeyBwYXRoOiB0aGlzLmRvY3NEaXIsIHdhdGNoOiByZWFsT3IodGhpcy5kb2NzRGlyKSwgcmVjdXJzaXZlOiB0cnVlIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICByb290cy5wdXNoKHtcbiAgICAgICAgcGF0aDogZS5yb290LFxuICAgICAgICB3YXRjaDogcmVhbE9yKGUucm9vdCksXG4gICAgICAgIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsXG4gICAgICAgIGVudHJ5SWQ6IGUuaWQsXG4gICAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBkaXJuYW1lKHJlYWxPcihkLm9yaWdpbmFsKSk7XG4gICAgICBpZiAoXG4gICAgICAgICFyb290cy5zb21lKChyKSA9PiByLndhdGNoID09PSByZWFsRGlyICYmIHIucmVjdXJzaXZlID09PSBmYWxzZSkgJiZcbiAgICAgICAgIXJvb3RzLnNvbWUoXG4gICAgICAgICAgKHIpID0+IHIucmVjdXJzaXZlICYmIChyZWFsRGlyID09PSByLndhdGNoIHx8IHJlYWxEaXIuc3RhcnRzV2l0aChyLndhdGNoICsgc2VwKSksXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgcm9vdHMucHVzaCh7IHBhdGg6IHJlYWxEaXIsIHdhdGNoOiByZWFsRGlyLCByZWN1cnNpdmU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRvcHRBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgdGhpcy5vd25lZC5zZXQocCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBLZWVwIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFzIGEgTkVXIGFnZW50IHZlcnNpb24uICovXG4gIHByaXZhdGUgcHJlc2VydmVPdXRzaWRlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogVmVyc2lvbiB7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgIGZyb206IGQuYWN0aXZlLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbGFiZWw6IGBvdXRzaWRlIHdyaXRlIHRvIHYke2QuYWN0aXZlfWAsXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH07XG4gIH1cblxuICAvKiogVHJ1ZSBpZmYgYHRleHRgIGF0IGBwYXRoYCBpcyBleGFjdGx5IHdoYXQgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIHRoZXJlLiAqL1xuICBpc093bldyaXRlKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMub3duZWQuZ2V0KHBhdGgpID09PSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb250ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZENvbnRleHQocmF3UGF0aDogc3RyaW5nKTogeyBlbnRyeTogQ29udGV4dEVudHJ5OyBhZGRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGNvbnN0IHByb2JlID0gZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApO1xuICAgIGNvbnN0IHNhbWUgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUucm9vdCA9PT0gcHJvYmUucm9vdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IHByb2JlLm1lbWJlcnNoaXAgJiZcbiAgICAgICAgKHByb2JlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiB8fFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGUubm9kZXMpID09PSBKU09OLnN0cmluZ2lmeShwcm9iZS5ub2RlcykpLFxuICAgICk7XG4gICAgaWYgKHNhbWUpIHJldHVybiB7IGVudHJ5OiBzYW1lLCBhZGRlZDogZmFsc2UgfTtcbiAgICB0aGlzLm0uY29udGV4dC5wdXNoKHByb2JlKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBwcm9iZSwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBBbiBlbnRyeSdzIHJvb3QgcGF0aCwgc28gRTYwIGNhbiBwdXQgYmFjayBhIGNvbnRleHQgZW50cnkgaXQgcmVtb3ZlZC4gKi9cbiAgZW50cnlSb290KGlkOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpPy5yb290ID8/IG51bGw7XG4gIH1cblxuICByZW1vdmVDb250ZXh0KGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpID0gdGhpcy5tLmNvbnRleHQuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gICAgaWYgKGkgPCAwKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoZSkgPT4gZS5pZCksXG4gICAgICApO1xuICAgIHRoaXMubS5jb250ZXh0LnNwbGljZShpLCAxKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgb3BlbiBkb2N1bWVudCBsZWZ0IHRoZSBjb250ZXh0IChpdHMgZW50cnkgcmVtb3ZlZCwgb3IgdGhlIGRvY3VtZW50XG4gICAqIGhpZGRlbik6IGNsb3NlIGl0IGluIHRoZSB2aWV3LiBJdHMgdmVyc2lvbnMgc3RheSBpbiB0aGUgc2Vzc2lvbiDigJQgbm90aGluZ1xuICAgKiBpcyBkZWxldGVkIOKAlCBhbmQgYnJpbmdpbmcgaXQgYmFjayBhbmQgb3BlbmluZyBpdCBhZ2FpbiBmaW5kcyB0aGVtLlxuICAgKi9cbiAgcHJpdmF0ZSBjbG9zZU9ycGhhbmVkT3BlbkRvYygpOiB2b2lkIHtcbiAgICBjb25zdCBvcGVuID0gdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICBpZiAob3BlbiAmJiBvcGVuLmVudHJ5SWQgPT09IG51bGwpIHRoaXMubS5vcGVuRG9jID0gbnVsbDtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QsIE1JUlJPUl9OT0RFX0NBUCwgZS5oaWRkZW4pO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjaG9pY2VzID0gdGhpcy5tLmRvY3MubWFwKChkKSA9PiBkLnNsdWcpO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICAvLyDim5QgT05MWSBBTiBBQlNPTFVURSBrZXkgaXMgYSBwYXRoICh2ZXJpZnktcGFzcyBmaXggOCk6IHJlc29sdmluZyBhXG4gICAgLy8gcmVsYXRpdmUgb25lIGhlcmUgcmVzb2x2ZWQgaXQgYWdhaW5zdCB0aGUgREFFTU9OJ3MgY3dkLiBUaGUgQ0xJIHJlc29sdmVzXG4gICAgLy8gYWdhaW5zdCBpdHMgb3duIGN3ZCBhbmQgc2VuZHMgYW4gYWJzb2x1dGUgcGF0aC5cbiAgICBpZiAoaXNBYnNvbHV0ZShrZXkpKSB7XG4gICAgICBjb25zdCBieVBhdGggPSB0aGlzLm0uZG9jcy5maW5kKFxuICAgICAgICAoZCkgPT4gZC5vcmlnaW5hbCA9PT0ga2V5IHx8IHJlYWxPcihkLm9yaWdpbmFsKSA9PT0gcmVhbE9yKGtleSksXG4gICAgICApO1xuICAgICAgaWYgKGJ5UGF0aCkgcmV0dXJuIGJ5UGF0aDtcbiAgICB9XG4gICAgY29uc3QgYnlOYW1lID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiBiYXNlbmFtZShkLm9yaWdpbmFsKSA9PT0ga2V5IHx8IGQucmVsID09PSBrZXkpO1xuICAgIHJldHVybiBieU5hbWUubGVuZ3RoID09PSAxID8gYnlOYW1lWzBdIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyLCBjb25zdW1lZC4gTnVtYmVycyBhcmUgbmV2ZXIgcmV1c2VkIChFNDEpLiAqL1xuICBwcml2YXRlIHRha2VWZXJzaW9uKGQ6IERvY1JlY29yZCk6IG51bWJlciB7XG4gICAgY29uc3QgbiA9IGQubmV4dFZlcnNpb24gPz8gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBkLm5leHRWZXJzaW9uID0gbiArIDE7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICBwcml2YXRlIHZlcnNpb25PckRpZShkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+IHtcbiAgICBjb25zdCB2ID0gZC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm4gPT09IG4pO1xuICAgIGlmICghdilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIHYke259YCxcbiAgICAgICAgNDA0LFxuICAgICAgICBkLnZlcnNpb25zLm1hcCgoeCkgPT4gYHYke3gubn1gKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHY7XG4gIH1cblxuICBwcml2YXRlIHNsdWdGb3Iob3JpZ2luYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlbSA9XG4gICAgICBiYXNlbmFtZShvcmlnaW5hbCwgZXh0bmFtZShvcmlnaW5hbCkpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOV8tXSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwiZG9jXCI7XG4gICAgbGV0IHNsdWcgPSBzdGVtO1xuICAgIGZvciAobGV0IGkgPSAyOyB0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHNsdWcpOyBpKyspIHNsdWcgPSBgJHtzdGVtfS0ke2l9YDtcbiAgICByZXR1cm4gc2x1ZztcbiAgfVxuXG4gIC8qKlxuICAgKiBPcGVuIGEgZG9jdW1lbnQgYnkgaXRzIG9yaWdpbmFsJ3MgcGF0aDogdjEgaXMgd3JpdHRlbiBmcm9tIHRoZSBvcmlnaW5hbFxuICAgKiB0aGUgZmlyc3QgdGltZS4gYGZvY3VzOiBmYWxzZWAgKHRoZSBhZ2VudCdzIGltcGxpY2l0IG9wZW4gdGhyb3VnaFxuICAgKiBgdmVyc2lvbi1uZXcgLS1kb2MgPHBhdGg+YCkgZG9lcyBub3QgbW92ZSB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IGZvY3VzPzogYm9vbGVhbiB9ID0ge30pOiB7IHNsdWc6IHN0cmluZzsgY3JlYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBmb2N1cyA9IG9wdHMuZm9jdXMgPz8gdHJ1ZTtcbiAgICAvLyBUaGUgY29udGV4dCdzIG93biBzcGVsbGluZyBvZiB0aGUgcGF0aDogYSBjYWxsZXIgd2hvc2UgY3dkIGlzIGEgcmVhbHBhdGhcbiAgICAvLyAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIG9yIHRocm91Z2ggYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgIC8vIGZpbGUgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgZG9jLlxuICAgIGNvbnN0IGFicyA9IHRoaXMuY2Fub25pY2FsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBleGlzdGluZy5zbHVnO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBzbHVnOiBleGlzdGluZy5zbHVnLCBjcmVhdGVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoIWlzRG9jTmFtZShhYnMpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgNDAwKTtcbiAgICBpZiAoIWxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Fic30gaXMgbm90IGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQg4oCUIGFkZCBpdCAob3IgaXRzIGZvbGRlcikgZmlyc3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghc3RhdFN5bmMoYWJzKS5pc0ZpbGUoKSkgdGhyb3cgbmV3IEVycm9yKFwibm90IGEgZmlsZVwiKTtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3Qgb3BlbiAke2Fic306IG5vIHN1Y2ggZmlsZWAsIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGV4dCA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdLmluY2x1ZGVzKGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpKVxuICAgICAgPyBleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKVxuICAgICAgOiBcIi5tZFwiO1xuICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpO1xuICAgIGNvbnN0IGQ6IERvY1JlY29yZCA9IHtcbiAgICAgIHNsdWc6IHRoaXMuc2x1Z0ZvcihhYnMpLFxuICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIG9yaWdpbmFsOiBhYnMsXG4gICAgICBlbnRyeUlkOiBhdD8uZW50cnlJZCA/PyBudWxsLFxuICAgICAgcmVsOiBhdD8ucmVsID8/IG51bGwsXG4gICAgICBleHQsXG4gICAgICB2ZXJzaW9uczogW3sgbjogMSwgYXV0aG9yOiBcImh1bWFuXCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9XSxcbiAgICAgIGFjdGl2ZTogMSxcbiAgICAgIG9yaWdpbmFsSGFzaDogY29udGVudEhhc2godGV4dCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZmFsc2UsXG4gICAgICBhZG1pdHRlZDogdHJ1ZSxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzLnB1c2goZCk7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZC5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgY3JlYXRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIGBhYnNgIGFzIHRoZSBjb250ZXh0IHNwZWxscyBpdCwgd2hlbiBpdCBpcyB0aGUgc2FtZSBmaWxlIGJ5IHJlYWxwYXRoLiAqL1xuICBwcml2YXRlIGNhbm9uaWNhbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKCFyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNwZWxsZWQgPSBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIHNwZWxsZWQpKSByZXR1cm4gc3BlbGxlZDtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIC8qKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDQg4oCUIENIRUNLIEJFRk9SRSBXUklURS4gQmVmb3JlIHRoZSBodW1hbidzIGVkaXQgaXNcbiAgICogd3JpdHRlbiwgdGhlIGZpbGUgb24gZGlzayBpcyBoYXNoZWQ6IGlmIGl0IGlzIG5vdCB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICogd3JpdGUsIHNvbWVvbmUgZWxzZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb24gKEUyKS4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgYVxuICAgKiBORVcgYWdlbnQgdmVyc2lvbiwgYW5kIG9ubHkgdGhlbiBpcyB0aGUgZWRpdCB3cml0dGVuLiBEZXRlY3Rpb24gdXNlZCB0b1xuICAgKiBkZXBlbmQgb24gdGhlIHdhdGNoZXIncyA2MCBtcyBzZXR0bGUgdGltZXIgZmlyaW5nIGJlZm9yZSB0aGUgbmV4dFxuICAgKiBrZXlzdHJva2U7IGEgYnVyc3Qgb2YgZWRpdHMgYXQgMzAgbXMgY2xvYmJlcmVkIGFuIG91dHNpZGUgd3JpdGVcbiAgICogdW5hbm5vdW5jZWQuIE5vdyBub3RoaW5nIGlzIGxvc3Qgd2hhdGV2ZXIgdGhlIHRpbWluZyDigJQgdGhlIG9uZSB3aW5kb3cgbGVmdFxuICAgKiBpcyB0aGUgbWljcm9zZWNvbmRzIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGlzIHdyaXRlLlxuICAgKi9cbiAgZWRpdChcbiAgICBzbHVnOiBzdHJpbmcsXG4gICAgbjogbnVtYmVyLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgKTogeyBkaXJ0eUNoYW5nZWQ6IGJvb2xlYW47IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgaWYgKG4gIT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke259IGlzIG5vdCB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9ICh2JHtkLmFjdGl2ZX0gaXMpIOKAlCBvbmx5IHRoZSBhY3RpdmUgdmVyc2lvbiBpcyBlZGl0YWJsZWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0RpcnR5KGQpO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIC8vIFRoZSBlZGl0IGlzIHN0YWdlZCBpbiBhIHNpYmxpbmcgZmlsZSBGSVJTVCwgc28gdGhlIGNoZWNrIGJlbG93IGFuZCB0aGVcbiAgICAvLyByZW5hbWUgdGhhdCBsYW5kcyB0aGUgZWRpdCBhcmUgYWRqYWNlbnQgc3lzY2FsbHM6IHRoZSB3aW5kb3cgaW4gd2hpY2ggYW5cbiAgICAvLyBvdXRzaWRlIHdyaXRlIGNvdWxkIHNsaXAgYmV0d2VlbiB0aGVtIGlzIG1pY3Jvc2Vjb25kcywgbm90IHRoZSBsZW5ndGggb2ZcbiAgICAvLyBhIG11bHRpLW1lZ2FieXRlIHdyaXRlIOKAlCBhbmQgYSB3cml0ZSBsYW5kaW5nIEFGVEVSIHRoZSByZW5hbWUgZ29lcyB0byB0aGVcbiAgICAvLyBuZXcgZmlsZSwgd2hlcmUgdGhlIHdhdGNoZXIgZmluZHMgaXQgYW5kIHByZXNlcnZlcyBpdCB0b28uXG4gICAgY29uc3Qgc3RhZ2VkID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0uZWRpdGA7XG4gICAgd3JpdGVGaWxlU3luYyhzdGFnZWQsIHRleHQpO1xuICAgIGxldCBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb25EaXNrOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgb25EaXNrID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIG9uRGlzayA9IG51bGw7XG4gICAgfVxuICAgIGlmIChvbkRpc2sgIT09IG51bGwgJiYgIXRoaXMuaXNPd25Xcml0ZShwYXRoLCBvbkRpc2spKVxuICAgICAgcHJlc2VydmVkID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgb25EaXNrKTtcbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgcmVuYW1lU3luYyhzdGFnZWQsIHBhdGgpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpLCBwcmVzZXJ2ZWQgfTtcbiAgfVxuXG4gIC8qKiBDb3B5IGEgdmVyc2lvbiB0byBhIG5ldyBmaWxlOyB0aGUgYWdlbnQgdGhlbiBlZGl0cyB0aGF0IGZpbGUgd2l0aCBpdHMgb3duIHRvb2xzLiAqL1xuICBuZXdWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBmcm9tPzogbnVtYmVyOyBsYWJlbD86IHN0cmluZzsgYXV0aG9yOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IFZlcnNpb247XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBmcm9tID0gb3B0cy5mcm9tID8/IGQuYWN0aXZlO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIGZyb20pO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBmcm9tKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IG4gPSB0aGlzLnRha2VWZXJzaW9uKGQpO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBvcHRzLmF1dGhvcixcbiAgICAgIGZyb20sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAuLi4ob3B0cy5sYWJlbCA/IHsgbGFiZWw6IG9wdHMubGFiZWwgfSA6IHt9KSxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAoRTQxKS5cbiAgICpcbiAgICog4puUIFRIRSBBQ1RJVkUgVkVSU0lPTiBDQU5OT1QgQkUgREVMRVRFRCwgYW5kIHJlZnVzaW5nIGlzIGJldHRlciB0aGFuXG4gICAqIHBpY2tpbmcgYSByZXBsYWNlbWVudDogY2hvb3Npbmcgb25lIGZvciB0aGUgaHVtYW4gd291bGQgc2lsZW50bHkgbW92ZVxuICAgKiB3aGVyZSB0aGVpciBlZGl0cyBhbmQgU2F2ZSBhcmUgcG9pbnRlZCwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBFMiBhbmQgRTdcbiAgICogZXhpc3QgdG8ga2VlcCBleHBsaWNpdC4gQmVjYXVzZSBleGFjdGx5IG9uZSB2ZXJzaW9uIGlzIGFsd2F5cyBhY3RpdmUsIHRoaXNcbiAgICogYWxzbyBtZWFucyB0aGUgbGFzdCB2ZXJzaW9uIGNhbiBuZXZlciBiZSBkZWxldGVkIOKAlCBhIGRvY3VtZW50IGFsd2F5cyBoYXNcbiAgICogc29tZXRoaW5nIHRvIGVkaXQsIHdpdGhvdXQgdGhhdCBiZWluZyBhIHNlY29uZCBydWxlLlxuICAgKlxuICAgKiBgZnJvbWAgcG9pbnRlcnMgb24gT1RIRVIgdmVyc2lvbnMgYXJlIGxlZnQgYXMgdGhleSBhcmUuIFwiTWFkZSBmcm9tIHYyXCJcbiAgICogc3RheXMgdHJ1ZSBhZnRlciB2MiBpcyBnb25lOyBkZWxldGluZyBhIHZlcnNpb24gaXMgbm90IHJld3JpdGluZyB0aGVcbiAgICogaGlzdG9yeSBvZiB0aGUgb25lcyB0aGF0IHJlbWFpbi5cbiAgICovXG4gIGRlbGV0ZVZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgcmVtYWluaW5nOiBudW1iZXI7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCB2ID0gdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBpZiAob3B0cy52ZXJzaW9uID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtvcHRzLnZlcnNpb259IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGFjdGl2YXRlIGFub3RoZXIgb25lIGZpcnN0LCBgICtcbiAgICAgICAgICBgdGhlbiBkZWxldGUgdGhpc2AsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgLy8g4puUIE1BVEVSSUFMSVNFIFRIRSBDT1VOVEVSIEJFRk9SRSBSRU1PVklORyBUSEUgUkVDT1JELiBgdGFrZVZlcnNpb25gXG4gICAgLy8gZGVyaXZlcyBpdCBsYXppbHkgZnJvbSB0aGUgdmVyc2lvbnMgUFJFU0VOVCwgc28gb24gYSBkb2MgdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBhbGxvY2F0ZWQgb25lIChhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSwgcmVzdG9yZWQpIGRlbGV0aW5nIHRoZVxuICAgIC8vIGhpZ2hlc3Qgd291bGQgbGV0IHRoZSBuZXh0IGFsbG9jYXRpb24gZGVyaXZlIHRoZSBzYW1lIG51bWJlciBhZ2Fpbi4gRm91bmRcbiAgICAvLyBieSBkcml2aW5nIGl0LCBub3QgYnkgdGhlIHVuaXQgdGVzdCBhYm92ZSDigJQgd2hpY2ggYWxsb2NhdGVkIGZpcnN0IGFuZCBzb1xuICAgIC8vIG5ldmVyIGhhZCBhIGNvbGQgY291bnRlci5cbiAgICBkLm5leHRWZXJzaW9uID8/PSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgoeCkgPT4geC5uKSkgKyAxO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG9wdHMudmVyc2lvbik7XG4gICAgZC52ZXJzaW9ucyA9IGQudmVyc2lvbnMuZmlsdGVyKCh4KSA9PiB4Lm4gIT09IG9wdHMudmVyc2lvbik7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhwYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRoZSByZWNvcmQgaXMgd2hhdCB0aGUgc2Vzc2lvbiBiZWxpZXZlczsgYSBmaWxlIGFscmVhZHkgZ29uZSAoYSBoYW5kXG4gICAgICAvLyB0aWR5LCBhIGNyYXNoIGJldHdlZW4gd3JpdGUgYW5kIHJlY29yZCkgbXVzdCBub3QgYmxvY2sgcmVtb3ZpbmcgaXQuXG4gICAgfVxuICAgIHRoaXMub3duZWQuZGVsZXRlKHBhdGgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBvcHRzLnZlcnNpb24sXG4gICAgICAuLi4odi5sYWJlbCA/IHsgbGFiZWw6IHYubGFiZWwgfSA6IHt9KSxcbiAgICAgIHJlbWFpbmluZzogZC52ZXJzaW9ucy5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIGFjdGl2YXRlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHsgc2x1Zzogc3RyaW5nOyBwcmV2aW91czogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGNvbnN0IHByZXZpb3VzID0gZC5hY3RpdmU7XG4gICAgZC5hY3RpdmUgPSBvcHRzLnZlcnNpb247XG4gICAgLy8gVGhlIG5ldyBhY3RpdmUgdmVyc2lvbidzIHRleHQgQVMgSVQgSVMgTk9XIGlzIHRoZSBiYXNlbGluZSB0aGUgbmV4dFxuICAgIC8vIGNoZWNrLWJlZm9yZS13cml0ZSBjb21wYXJlcyBhZ2FpbnN0LlxuICAgIHRoaXMuYWRvcHRBY3RpdmUoZCwgcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb21wYXJpbmcgYW5kIG1lcmdpbmcgKEUzNikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSB0ZXh0IG9mIG9uZSBzaWRlIG9mIGEgY29tcGFyaXNvbi4gYFwib3JpZ2luYWxcImAgaXMgcmVhZCBmcm9tIERJU0ssIG5vdFxuICAgKiBmcm9tIGEgY2FjaGU6IHRoZSB3aG9sZSBwb2ludCBvZiBjb21wYXJpbmcgYWdhaW5zdCBpdCBpcyB0byBzZWUgd2hhdCB0aGVcbiAgICogZmlsZSBvZiByZWNvcmQgYWN0dWFsbHkgc2F5cyByaWdodCBub3csIGluY2x1ZGluZyBhIGNoYW5nZSBzb21lb25lIGVsc2VcbiAgICogbWFkZSB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIG9wZW4uXG4gICAqL1xuICBwcml2YXRlIHNpZGVUZXh0KGQ6IERvY1JlY29yZCwgc2lkZTogRGlmZlNpZGUpOiBzdHJpbmcge1xuICAgIGlmIChzaWRlID09PSBcIm9yaWdpbmFsXCIpIHJldHVybiByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIHNpZGUpO1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBzaWRlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIENvbXBhcmUgdGhlIEFDVElWRSB2ZXJzaW9uIChsZWZ0KSBhZ2FpbnN0IGFub3RoZXIgc2lkZSAocmlnaHQpLiAqL1xuICBjb21wYXJlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZSB9KTogRGlmZlBheWxvYWQge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBpZiAob3B0cy5hZ2FpbnN0ID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtkLmFjdGl2ZX0gaXMgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSDigJQgY29tcGFyaW5nIGl0IHdpdGggaXRzZWxmIHNheXMgbm90aGluZ2AsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgbGVmdCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiB7XG4gICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBhZ2FpbnN0OiBvcHRzLmFnYWluc3QsXG4gICAgICBkaWZmOiBkaWZmVGV4dChsZWZ0LCB0aGlzLnNpZGVUZXh0KGQsIG9wdHMuYWdhaW5zdCkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogVGFrZSBuYW1lZCBodW5rcyBmcm9tIGBhZ2FpbnN0YCBpbnRvIHRoZSBhY3RpdmUgdmVyc2lvbi5cbiAgICpcbiAgICog4puUIFRIRSBXUklURSBHT0VTIFRIUk9VR0ggYGVkaXRgLCB3aGljaCBpcyB3aGF0IG1ha2VzIGEgbWVyZ2Ugb2JleSBldmVyeVxuICAgKiBydWxlIGFuIG9yZGluYXJ5IGtleXN0cm9rZSBvYmV5czogaXQgbGFuZHMgb24gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFuZCBuZXZlclxuICAgKiB0aGUgb3JpZ2luYWwgKEU3KSwgYW5kIGNoZWNrLWJlZm9yZS13cml0ZSBwcmVzZXJ2ZXMgYW4gb3V0c2lkZSB3cml0ZSBhcyBhXG4gICAqIG5ldyB2ZXJzaW9uIGZpcnN0IChFMikuIEEgbWVyZ2Ugd3JpdGluZyB0aGUgZmlsZSBkaXJlY3RseSB3b3VsZCBiZSB0aGUgb25lXG4gICAqIHBhdGggaW50byB0aGUgZG9jdW1lbnQgdGhhdCBjb3VsZCBzaWxlbnRseSBjbG9iYmVyIHRoZSBhZ2VudC5cbiAgICovXG4gIG1lcmdlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZTsgaHVua3M6IG51bWJlcltdIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IG51bWJlcjtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYXBwbGllZDogbnVtYmVyO1xuICAgIHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGw7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBwYXlsb2FkID0gdGhpcy5jb21wYXJlKHsgZG9jOiBkLnNsdWcsIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCB9KTtcbiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQocGF5bG9hZC5kaWZmLmh1bmtzLm1hcCgoaCkgPT4gaC5pZCkpO1xuICAgIGNvbnN0IG1pc3NpbmcgPSBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+ICFrbm93bi5oYXMoaWQpKTtcbiAgICBpZiAobWlzc2luZy5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyBodW5rICR7bWlzc2luZy5qb2luKFwiLCBcIil9IGFnYWluc3QgJHtzaWRlTmFtZShvcHRzLmFnYWluc3QsIGQubmFtZSl9IOKAlCBgICtcbiAgICAgICAgICBgaXQgaGFzICR7a25vd24uc2l6ZSA9PT0gMCA/IFwibm9uZVwiIDogYDEuLiR7TWF0aC5tYXgoLi4ua25vd24pfWB9LiBSdW4gZGlmZiBhZ2FpbjogYCArXG4gICAgICAgICAgYHRoZSB0ZXh0IGNoYW5nZWQgdW5kZXIgdGhlIG51bWJlcnMuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICBjb25zdCB0ZXh0ID0gYXBwbHlIdW5rcyhiZWZvcmUsIHBheWxvYWQuZGlmZi5odW5rcywgb3B0cy5odW5rcyk7XG4gICAgY29uc3QgeyBwcmVzZXJ2ZWQgfSA9IHRoaXMuZWRpdChkLnNsdWcsIGQuYWN0aXZlLCB0ZXh0KTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICB0ZXh0LFxuICAgICAgYXBwbGllZDogb3B0cy5odW5rcy5maWx0ZXIoKGlkKSA9PiBrbm93bi5oYXMoaWQpKS5sZW5ndGgsXG4gICAgICBwcmVzZXJ2ZWQsXG4gICAgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBub3RlcyAoRTQ1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogVGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCDigJQgd2hhdCBldmVyeSBub3RlIGlzIGFuY2hvcmVkIGFnYWluc3QuICovXG4gIHByaXZhdGUgYWN0aXZlVGV4dChkOiBEb2NSZWNvcmQpOiBzdHJpbmcge1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgfVxuXG4gIC8qKiBQbGFjZSBldmVyeSBub3RlIGluIHRoZSBhY3RpdmUgdGV4dCBhcyBpdCBzdGFuZHMgbm93LiAqL1xuICBwcml2YXRlIHBsYWNlZE5vdGVzKGQ6IERvY1JlY29yZCk6IFBsYWNlZE5vdGVbXSB7XG4gICAgY29uc3Qgbm90ZXMgPSBkLm5vdGVzID8/IFtdO1xuICAgIGlmIChub3Rlcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuICAgIHJldHVybiBub3Rlcy5tYXAoKG4pID0+ICh7IC4uLm4sIC4uLmZpbmRBbmNob3IodGV4dCwgbikgfSkpO1xuICB9XG5cbiAgLyoqXG4gICAqIE5vdGUgYSByYW5nZSBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0ICh0aGUgaHVtYW4gc2VsZWN0cykgb3IgYSBxdW90ZVxuICAgKiBmb3VuZCBpbiBpdCAodGhlIGFnZW50IHF1b3RlcyDigJQgaXQgaGFzIG5vIG9mZnNldHMpLlxuICAgKi9cbiAgYWRkTm90ZShvcHRzOiB7XG4gICAgZG9jPzogc3RyaW5nO1xuICAgIGJvZHk6IHN0cmluZztcbiAgICB3aG86IFZlcnNpb25BdXRob3I7XG4gICAgcmFuZ2U/OiB7IGZyb206IG51bWJlcjsgdG86IG51bWJlciB9O1xuICAgIHF1b3RlPzogc3RyaW5nO1xuICB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGU6IE5vdGU7IGhvdzogXCJzZWxlY3Rpb25cIiB8IFwicXVvdGVcIiB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcblxuICAgIGxldCBhbmNob3I6IEFuY2hvcjtcbiAgICBpZiAob3B0cy5yYW5nZSkge1xuICAgICAgY29uc3QgeyBmcm9tLCB0byB9ID0gb3B0cy5yYW5nZTtcbiAgICAgIGlmIChmcm9tIDwgMCB8fCB0byA+IHRleHQubGVuZ3RoIHx8IGZyb20gPj0gdG8pXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7ZnJvbX0uLiR7dG99IGlzIG5vdCBhIHJhbmdlIGluIHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gKCR7dGV4dC5sZW5ndGh9IGNoYXJhY3RlcnMpYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICk7XG4gICAgICBhbmNob3IgPSBhbmNob3JPZih0ZXh0LCBmcm9tLCB0byk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHF1b3RlID0gb3B0cy5xdW90ZSA/PyBcIlwiO1xuICAgICAgaWYgKCFxdW90ZSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBhIHNlbGVjdGlvbiBvciBhIHF1b3RlXCIsIDQwMCk7XG4gICAgICBjb25zdCBhdCA9IHRleHQuaW5kZXhPZihxdW90ZSk7XG4gICAgICAvLyDim5QgUkVGVVNFRCwgbm90IGFuY2hvcmVkIGhvcGVmdWxseS4gQSBxdW90ZSB0aGUgYWN0aXZlIHZlcnNpb24gZG9lcyBub3RcbiAgICAgIC8vIGNvbnRhaW4gd291bGQgYmVjb21lIGFuIG9ycGhhbiB0aGUgbW9tZW50IGl0IHdhcyBtYWRlLCB3aGljaCByZWFkcyBhc1xuICAgICAgLy8gXCJ0aGUgdGV4dCBjaGFuZ2VkXCIgd2hlbiB0aGUgdHJ1dGggaXMgXCJ5b3UgcXVvdGVkIHNvbWV0aGluZyBlbHNlXCIuXG4gICAgICBpZiAoYXQgPT09IC0xKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB2JHtkLmFjdGl2ZX0gb2YgJHtkLnNsdWd9IGRvZXMgbm90IGNvbnRhaW4gdGhhdCB0ZXh0IOKAlCBxdW90ZSBpdCBleGFjdGx5IGFzIGl0IGFwcGVhcnNgLFxuICAgICAgICAgIDQwNCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGF0LCBhdCArIHF1b3RlLmxlbmd0aCk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm90ZTogTm90ZSA9IHtcbiAgICAgIGlkOiBgbiR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA2KX1gLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAuLi5hbmNob3IsXG4gICAgICBib2R5LFxuICAgICAgd2hvOiBvcHRzLndobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIHJlc29sdmVkOiBmYWxzZSxcbiAgICB9O1xuICAgIGQubm90ZXMgPSBbLi4uKGQubm90ZXMgPz8gW10pLCBub3RlXTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUsIGhvdzogb3B0cy5yYW5nZSA/IFwic2VsZWN0aW9uXCIgOiBcInF1b3RlXCIgfTtcbiAgfVxuXG4gIC8qKiBOb3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQg4oCUIGBhbGxgIGluY2x1ZGVzIHRoZSByZXNvbHZlZCBvbmVzLiAqL1xuICBub3Rlc09mKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhbGw/OiBib29sZWFuIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZXM6IFBsYWNlZE5vdGVbXSB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgcGxhY2VkID0gdGhpcy5wbGFjZWROb3RlcyhkKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGVzOiBvcHRzLmFsbCA/IHBsYWNlZCA6IHBsYWNlZC5maWx0ZXIoKG4pID0+ICFuLnJlc29sdmVkKSB9O1xuICB9XG5cbiAgcHJpdmF0ZSBub3RlT3JEaWUoZDogRG9jUmVjb3JkLCBpZDogc3RyaW5nKTogTm90ZSB7XG4gICAgY29uc3Qgbm90ZSA9IChkLm5vdGVzID8/IFtdKS5maW5kKChuKSA9PiBuLmlkID09PSBpZCk7XG4gICAgaWYgKCFub3RlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gbm90ZSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgKGQubm90ZXMgPz8gW10pLm1hcCgobikgPT4gbi5pZCksXG4gICAgICApO1xuICAgIHJldHVybiBub3RlO1xuICB9XG5cbiAgLyoqIENoYW5nZSB3aGF0IGEgbm90ZSBTQVlTLiBJdHMgYW5jaG9yIGlzIHVudG91Y2hlZCDigJQgaXQgaXMgc3RpbGwgYWJvdXQgdGhlXG4gICAqICBzYW1lIHBhc3NhZ2UsIHdoaWNoIGlzIHdoeSBlZGl0aW5nIGRvZXMgbm90IHJlLXF1b3RlIChFNDYpLiAqL1xuICBlZGl0Tm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgYm9keTogc3RyaW5nIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZSB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIGNvbnN0IGJvZHkgPSBvcHRzLmJvZHkudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBzb21ldGhpbmcgd3JpdHRlbiBpbiBpdFwiLCA0MDApO1xuICAgIG5vdGUuYm9keSA9IGJvZHk7XG4gICAgbm90ZS5lZGl0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZXNvbHZlTm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgcmVzb2x2ZWQ6IGJvb2xlYW4gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbm90ZTogTm90ZTtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IG5vdGUgPSB0aGlzLm5vdGVPckRpZShkLCBvcHRzLmlkKTtcbiAgICBub3RlLnJlc29sdmVkID0gb3B0cy5yZXNvbHZlZDtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIHJlbW92ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmcgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgZC5ub3RlcyA9IChkLm5vdGVzID8/IFtdKS5maWx0ZXIoKG4pID0+IG4uaWQgIT09IG9wdHMuaWQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgLyoqIFNhdmU6IHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgb3ZlciB0aGUgb3JpZ2luYWwuIFRoZSBPTkxZIHdyaXRlIHRvIGl0IChFNykuICovXG4gIHNhdmUoc2x1Zzogc3RyaW5nKTogeyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYzogU2F2ZSB3cml0ZXMgb25seSBhbiBvcmlnaW5hbCBhZG1pdHRlZCBieVxuICAgIC8vIGBvcGVuUGF0aGAgKGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5KS4gQ2hlY2tlZCBhZ2FpbiBoZXJlXG4gICAgLy8gc28gbm8gb3RoZXIgcGF0aCBpbnRvIHRoZSBtYW5pZmVzdCDigJQgYSBoYW5kLWVkaXRlZCBvbmUsIGEgZnV0dXJlIHZlcmIg4oCUXG4gICAgLy8gY2FuIHR1cm4gU2F2ZSBpbnRvIFwid3JpdGUgYW55IGZpbGVcIi5cbiAgICBpZiAoIWQuYWRtaXR0ZWQgfHwgIWlzRG9jTmFtZShkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBzYXZlICR7ZC5vcmlnaW5hbH06IGl0IHdhcyBub3Qgb3BlbmVkIGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICB0aGlzLndyaXRlT3duZWQoZC5vcmlnaW5hbCwgdGV4dCk7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgb3JpZ2luYWw6IGQub3JpZ2luYWwsIHZlcnNpb246IGQuYWN0aXZlIH07XG4gIH1cblxuICAvKiogUmV2ZXJ0OiB0aGUgb3JpZ2luYWwncyB0ZXh0IGJhY2sgb3ZlciB0aGUgYWN0aXZlIHZlcnNpb24uICovXG4gIHJldmVydChzbHVnOiBzdHJpbmcpOiB7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIGlmIChuID09PSBkLmFjdGl2ZSkge1xuICAgICAgICAvLyBFMiwgcmVmdXNlZCBhbmQgUkUtTEFCRUxMRUQ6IHRoZSBvdXRzaWRlIHRleHQgYmVjb21lcyBhIG5ldyBhZ2VudFxuICAgICAgICAvLyB2ZXJzaW9uLCBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uIGdvZXMgYmFjayB0byB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICAgICAgLy8gdGV4dCDigJQgc28gdGhlIGFjdGl2ZSB2ZXJzaW9uIG9ubHkgZXZlciBob2xkcyB3aGF0IHRoZSBodW1hbiB0eXBlZCxcbiAgICAgICAgLy8gYW5kIG5vdGhpbmcgYW55b25lIHdyb3RlIGlzIGxvc3QgKHZlcmlmeS1wYXNzIGZpeCA0LCB3YXRjaGVyIGhhbGYpLlxuICAgICAgICBjb25zdCBrZXB0ID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGhpcy5sYXN0QWN0aXZlVGV4dC5nZXQoZC5zbHVnKSA/PyB0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogbixcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgcHJlc2VydmVkQXM6IGtlcHQubixcbiAgICAgICAgICBwcmVzZXJ2ZWRQYXRoOiBrZXB0LnBhdGgsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCB0ZXh0LCBhY3RpdmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIOKAlCBieSBpdHMgc3RvcmVkIHBhdGgsIG9yIGJ5IHJlYWxwYXRoIGZvciBhIHN5bWxpbms/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyB8fCByZWFsT3IoeC5vcmlnaW5hbCkgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGQub3V0c2lkZUNoYW5nZWQpIHJldHVybiBudWxsOyAvLyBhbHJlYWR5IGFza2VkXG4gICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBzdHJ1Y3R1cmUgKEUyMuKAk0UyNCk6IHJlYWwgY2hhbmdlcyBvbiBkaXNrLCBvbmUgcGF0aCBmb3IgYm90aCBwYXJ0aWVzIOKUgOKUgFxuICAvL1xuICAvLyBFdmVyeSBtZXRob2QgYmVsb3cgZG9lcyB0aGUgY2hhbmdlIE9OIERJU0sgYW5kIHRoZW4gYnJpbmdzIHRoZSBjb250ZXh0XG4gIC8vIG1vZGVsIGJhY2sgaW4gbGluZSB3aXRoIGl0LiBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZW0gdGhyb3VnaCBtZW51cyBhbmRcbiAgLy8gZHJhZyBhbmQgZHJvcCwgdGhlIGFnZW50IHRocm91Z2ggQ0xJIHZlcmJzOyB0aGUgZGFlbW9uIGFubm91bmNlcyBlYWNoIG9uZVxuICAvLyB1bmRlciB0aGUgbmFtZSBvZiB3aG9ldmVyIGRpZCBpdC4gVHdvIHJ1bGVzIGhvbGQgdGhyb3VnaG91dDpcbiAgLy9cbiAgLy8gLSBOT1RISU5HIElTIERFTEVURUQuIGBoaWRlYCB0YWtlcyBhIG5vZGUgb3V0IG9mIFNjcmlwdG9yaXVtOyB0aGUgZmlsZSBzdGF5cy5cbiAgLy8gLSBOT1RISU5HIElTIE9WRVJXUklUVEVOLiBBIGRlc3RpbmF0aW9uIHRoYXQgZXhpc3RzIGlzIHJlZnVzZWQgKGFuIGV4cGxpY2l0XG4gIC8vICAgbmFtZSkgb3IgZ2l2ZW4gYSBmcmVlIG5hbWUgKGEgZGVmYXVsdCBvbmUsIGEgZHJvcCk7IGZpbGVzIGFyZSBjcmVhdGVkXG4gIC8vICAgd2l0aCB0aGUgZXhjbHVzaXZlIGZsYWcsIHNvIGEgcmFjZSBjYW5ub3QgY2xvYmJlciBlaXRoZXIuXG5cbiAgLyoqIEUyMzogd2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQuICovXG4gIGdldCB3b3Jrc3BhY2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLndvcmtzcGFjZSA/PyBob21lZGlyKCk7XG4gIH1cblxuICBzZXRXb3Jrc3BhY2UocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzdWNoIGZvbGRlcjogJHthYnN9YCwgNDA0KTtcbiAgICB9XG4gICAgaWYgKCFpc0RpcikgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGhlIHdvcmtzcGFjZSBtdXN0IGJlIGEgZm9sZGVyOiAke2Fic31gLCA0MDApO1xuICAgIHRoaXMubS53b3Jrc3BhY2UgPSBhYnM7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogSG93IGEgcGF0aCByZWFkcyBpbiBhIGNoYXQgbGluZTogYHNldC9yZWxgIGluc2lkZSBhIHNldCwgYSBzaW5nbGVcbiAgICogZG9jdW1lbnQncyBmaWxlIG5hbWUsIGB3b3Jrc3BhY2Uv4oCmYCBpbiB0aGUgd29ya3NwYWNlLCBlbHNlIGB+L+KApmAuXG4gICAqL1xuICBkaXNwbGF5KGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikge1xuICAgICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBlLmxhYmVsO1xuICAgICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkgcmV0dXJuIGAke2UubGFiZWx9LyR7dG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpfWA7XG4gICAgICB9IGVsc2UgaWYgKGUubm9kZXMuc29tZSgobikgPT4gam9pbihlLnJvb3QsIG4ucmVsKSA9PT0gYWJzKSkgcmV0dXJuIGUubGFiZWw7XG4gICAgfVxuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLndvcmtzcGFjZSArIHNlcCkpXG4gICAgICByZXR1cm4gYHdvcmtzcGFjZS8ke3RvUG9zaXgocmVsYXRpdmUodGhpcy53b3Jrc3BhY2UsIGFicykpfWA7XG4gICAgY29uc3QgaG9tZSA9IGhvbWVkaXIoKTtcbiAgICByZXR1cm4gYWJzID09PSBob21lID8gXCJ+XCIgOiBhYnMuc3RhcnRzV2l0aChob21lICsgc2VwKSA/IGB+JHthYnMuc2xpY2UoaG9tZS5sZW5ndGgpfWAgOiBhYnM7XG4gIH1cblxuICAvKipcbiAgICogYGFic2Agc3BlbGxlZCB0aGUgd2F5IHRoZSBjb250ZXh0IHNwZWxscyBpdC4gQSBjYWxsZXIgd2hvc2UgY3dkIGlzIGFcbiAgICogcmVhbHBhdGggKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAqIHBsYWNlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIG5vZGUuXG4gICAqL1xuICBwcml2YXRlIHNwZWxsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5tLmNvbnRleHQuc29tZSgoZSkgPT4gYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmIChyZWFsID09PSByZWFsUm9vdCkgcmV0dXJuIGUucm9vdDtcbiAgICAgIGlmIChyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSByZXR1cm4gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBwcml2YXRlIGlzV29ya3NwYWNlKGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGFicyA9PT0gdGhpcy53b3Jrc3BhY2UgfHwgcmVhbE9yKGFicykgPT09IHJlYWxPcih0aGlzLndvcmtzcGFjZSk7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIGVudHJ5IHRoYXQgY292ZXJzIGBhYnNgIChpdHMgcm9vdCwgb3IgYW55dGhpbmcgdW5kZXIgaXQpLCBpZiBhbnkuICovXG4gIHByaXZhdGUgY292ZXJpbmdFbnRyeShhYnM6IHN0cmluZywgZXhjZXB0Pzogc3RyaW5nKTogQ29udGV4dEVudHJ5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLmlkICE9PSBleGNlcHQgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiZcbiAgICAgICAgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQSBmb2xkZXIgdGhpbmdzIG1heSBiZSBtYWRlIGluIG9yIG1vdmVkIGludG86IGEgbWlycm9yZWQgZW50cnkncyByb290LCBhXG4gICAqIHZpc2libGUgZm9sZGVyIHVuZGVyIG9uZSwgb3IgdGhlIHdvcmtzcGFjZS4gUmV0dXJucyB0aGUgYWJzb2x1dGUgZm9sZGVyO1xuICAgKiByZWZ1c2VzIGFueXRoaW5nIGVsc2Ug4oCUIHRoZSBjb250ZXh0IHN0YXlzIHRoZSB3YXkgaW4gKHZlcmlmeS1wYXNzIGZpeCAxYikuXG4gICAqL1xuICBwcml2YXRlIGRlc3RpbmF0aW9uT3JEaWUocmF3RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdEaXIpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgY29udGludWU7XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBhYnM7XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGU/LmtpbmQgPT09IFwiZ3JvdXBcIikgcmV0dXJuIGFicztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuaXNXb3Jrc3BhY2UoYWJzKSkgcmV0dXJuIHRoaXMud29ya3NwYWNlO1xuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICBgJHthYnN9IGlzIG5vdCBhIGZvbGRlciBpbiB0aGlzIHNlc3Npb24g4oCUIG5hbWUgYSBzZXQsIGEgZm9sZGVyIGluc2lkZSBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UgKCR7dGhpcy53b3Jrc3BhY2V9KWAsXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG9yIGZvbGRlciBzaG93biBpbiB0aGUgY29udGV4dCwgd2l0aCB3aGVyZSBpdCBpcyBzaG93bi4gKi9cbiAgcHJpdmF0ZSBpdGVtT3JEaWUocmF3UGF0aDogc3RyaW5nKToge1xuICAgIGFiczogc3RyaW5nO1xuICAgIGVudHJ5OiBDb250ZXh0RW50cnk7XG4gICAgLyoqIFRoZSB3aG9sZSBlbnRyeSAoYSBzZXQncyBvd24gZm9sZGVyLCBhIGxpc3RlZCBkb2N1bWVudCksIG9yIGEgbm9kZSBpbnNpZGUgYSBzZXQuICovXG4gICAgd2hvbGU6IGJvb2xlYW47XG4gICAgZGlyOiBib29sZWFuO1xuICB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAxICYmIG9ubHk/LmtpbmQgPT09IFwiZG9jXCIgJiYgam9pbihlLnJvb3QsIG9ubHkucmVsKSA9PT0gYWJzKVxuICAgICAgICAgIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IGZhbHNlIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiB0cnVlIH07XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGUpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiBmYWxzZSwgZGlyOiBub2RlLmtpbmQgPT09IFwiZ3JvdXBcIiB9O1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHRgLCA0MDQpO1xuICB9XG5cbiAgLyoqXG4gICAqIGByYXdQYXRoYCBpZiB0aGUgY29udGV4dCBzaG93cyBpdCDigJQgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gYSBzZXQsIGFcbiAgICogbGlzdGVkIGRvY3VtZW50LCBhIHNldCdzIG93biBmb2xkZXIg4oCUIG9yIGl0IGlzIHRoZSB3b3Jrc3BhY2U7IHJlZnVzZWRcbiAgICogb3RoZXJ3aXNlLiBGb3IgYWN0cyB0aGF0IHJlYWNoIG91dHNpZGUgdGhlIHNwZWxsIChyZXZlYWxpbmcgYSBwYXRoIGluIHRoZVxuICAgKiBmaWxlIG1hbmFnZXIpLCBzbyBhIHBhZ2UgY2Fubm90IGFpbSB0aGVtIGF0IGFuIGFyYml0cmFyeSBwYXRoLlxuICAgKi9cbiAgc2hvd25QYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBpZiAodGhpcy5pdGVtQXQoYWJzKSkgcmV0dXJuIGFicztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdGluYXRpb25PckRpZShhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb25gLCA0MDApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZWZ1c2UgYSBuYW1lIHRoYXQgaXMgbm90IG9uZSBwbGFpbiBmaWxlIG9yIGZvbGRlciBuYW1lLiAqL1xuICBwcml2YXRlIG5hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgICBpZiAoXG4gICAgICBuID09PSBcIlwiIHx8XG4gICAgICBuID09PSBcIi5cIiB8fFxuICAgICAgbiA9PT0gXCIuLlwiIHx8XG4gICAgICBuLnN0YXJ0c1dpdGgoXCIuXCIpIHx8XG4gICAgICAvWy9cXFxcXFwwXS8udGVzdChuKSB8fFxuICAgICAgbi5sZW5ndGggPiAyNTVcbiAgICApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgXCIke25hbWV9XCIgaXMgbm90IGEgdXNhYmxlIG5hbWUg4oCUIG9uZSBwbGFpbiBuYW1lLCBubyBzbGFzaGVzLCBub3Qgc3RhcnRpbmcgd2l0aCBhIGRvdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBuYW1lOiBhIG5hbWUgd2l0aG91dCBhIGRvY3VtZW50IGV4dGVuc2lvbiBnZXRzIGAubWRgLiAqL1xuICBwcml2YXRlIGRvY05hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICByZXR1cm4gaXNEb2NOYW1lKG4pID8gbiA6IGAke259Lm1kYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciBzb21ldGhpbmcgbW92ZWQgb24gZGlzayBmcm9tIGBmcm9tYCB0byBgdG9gLCBicmluZyB0aGUgbW9kZWwgd2l0aCBpdDpcbiAgICogb3BlbmVkIGRvY3VtZW50cyBrZWVwIHRoZWlyIHZlcnNpb25zIHVuZGVyIHRoZSBuZXcgcGF0aCwgZW50cmllcyByb290ZWQgYXRcbiAgICogb3IgaG9sZGluZyB0aGUgbW92ZWQgdGhpbmcgZm9sbG93IGl0LCBhbmQgZXZlcnkgbWlycm9yIGlzIHJlLXJlYWQuIEFuIGVudHJ5XG4gICAqIHRoYXQgbm93IHNpdHMgaW5zaWRlIGFub3RoZXIgc2V0IGlzIGRyb3BwZWQg4oCUIHRoZSBzZXQgc2hvd3MgaXQgYWxyZWFkeS5cbiAgICovXG4gIHByaXZhdGUgZm9sbG93TW92ZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBtb3ZlZCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+XG4gICAgICBwID09PSBmcm9tID8gdG8gOiBwLnN0YXJ0c1dpdGgoZnJvbSArIHNlcCkgPyB0byArIHAuc2xpY2UoZnJvbS5sZW5ndGgpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGQub3JpZ2luYWwpO1xuICAgICAgaWYgKG5vdykge1xuICAgICAgICBkLm9yaWdpbmFsID0gbm93O1xuICAgICAgICBkLm5hbWUgPSBiYXNlbmFtZShub3cpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBkcm9wID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAob25seT8ua2luZCAhPT0gXCJkb2NcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGpvaW4oZS5yb290LCBvbmx5LnJlbCkpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IGRpcm5hbWUobm93KTtcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KTtcbiAgICAgICAgICBlLm5vZGVzID0gW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShub3cpIH1dO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChlLnJvb3QpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IG5vdztcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KSB8fCBub3c7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5tLmNvbnRleHQgPSB0aGlzLm0uY29udGV4dC5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQWZ0ZXIgYSBmaWxlIG9yIGZvbGRlciBsYW5kZWQgYXQgYGFic2A6IHJlLXJlYWQgdGhlIHNldCBpdCBpcyBpbiwgb3IgZ2l2ZSBpdCBhbiBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBhZG9wdE5ldyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHNldCA9IHRoaXMuY292ZXJpbmdFbnRyeShhYnMpO1xuICAgIGlmIChzZXQpIHRoaXMucmVzY2FuKHNldC5pZCk7XG4gICAgZWxzZSB0aGlzLm0uY29udGV4dC5wdXNoKGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBIG5hbWUgaW4gYGRpcmAgdGhhdCBpcyBmcmVlOiBgbmFtZWAsIGVsc2UgYHN0ZW0gMi5leHRgLCBgc3RlbSAzLmV4dGAsIOKApiAqL1xuICBwcml2YXRlIGZyZWVOYW1lKGRpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGlzRGlyOiBib29sZWFuKTogc3RyaW5nIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG5hbWUpKSkgcmV0dXJuIG5hbWU7XG4gICAgY29uc3QgZXh0ID0gaXNEaXIgPyBcIlwiIDogZXh0bmFtZShuYW1lKTtcbiAgICBjb25zdCBzdGVtID0gZXh0ID8gbmFtZS5zbGljZSgwLCAtZXh0Lmxlbmd0aCkgOiBuYW1lO1xuICAgIGZvciAobGV0IGkgPSAyOyA7IGkrKykge1xuICAgICAgY29uc3QgbiA9IGAke3N0ZW19ICR7aX0ke2V4dH1gO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuKSkpIHJldHVybiBuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVmdXNlRXhpc3RpbmcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZXhpc3RzU3luYyhhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGFscmVhZHkgZXhpc3RzIOKAlCBub3RoaW5nIHdhcyBvdmVyd3JpdHRlbmAsIDQwOSk7XG4gIH1cblxuICBjcmVhdGVEb2MocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmaWxlID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIlVudGl0bGVkLm1kXCIsIGZhbHNlKSA6IHRoaXMuZG9jTmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmaWxlKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIFwiXCIsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIGNyZWF0ZUZvbGRlcihyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZvbGRlciA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJOZXcgZm9sZGVyXCIsIHRydWUpIDogdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZvbGRlcik7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIG1rZGlyU3luYyhhYnMpO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjY6IHdoYXQgYSBtb3ZlIFdPVUxEIGRvLCBmb3IgdGhlIGNvbmZpcm1hdGlvbiB0aGUgc3VyZmFjZSBzaG93cyBiZWZvcmVcbiAgICogbW92aW5nIGEgRk9MREVSLiBSZWFkcyBub3RoaW5nIGJ1dCB0aGUgZGlzayBhbmQgcmVmdXNlcyBleGFjdGx5IHdoYXRcbiAgICogYG1vdmVgIHdvdWxkIHJlZnVzZSwgc28gYSBjb25maXJtZWQgbW92ZSBjYW5ub3QgdGhlbiBmYWlsIG9uIGFkbWlzc2lvbi5cbiAgICpcbiAgICogVGhlIGdpdCBoYWxmIGlzIGhlcmUgYmVjYXVzZSBvbmx5IHRoZSBkYWVtb24gY2FuIHNlZSBhIGAuZ2l0YDogYSBmb2xkZXJcbiAgICogZHJhZ2dlZCBvdXQgb2YgYSByZXBvc2l0b3J5IGlzIHRoZSBjYXNlIHdoZXJlIHRoZSBjb25zZXF1ZW5jZSByZWFjaGVzIHBhc3RcbiAgICogc2NyaXB0b3JpdW0gKENvbGUgbW92ZWQgdGhpcyBwcm9qZWN0J3Mgb3duIGRvY3MgZm9sZGVyIGludG8gaGlzIHdvcmtzcGFjZSxcbiAgICogYW5kIGdpdCBzYXcgc2l4IGRlbGV0ZWQgZmlsZXMpLlxuICAgKi9cbiAgbW92ZVBsYW4ocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiBNb3ZlUGxhbiB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgY29uc3QgZnJvbVJlcG8gPSBnaXRSb290T2YoZGlybmFtZShpdGVtLmFicykpO1xuICAgIGNvbnN0IGludG9SZXBvID0gZ2l0Um9vdE9mKGludG8pO1xuICAgIHJldHVybiB7XG4gICAgICBmcm9tOiBpdGVtLmFicyxcbiAgICAgIGludG8sXG4gICAgICBuYW1lOiBiYXNlbmFtZShpdGVtLmFicyksXG4gICAgICBmb2xkZXI6IGl0ZW0uZGlyLFxuICAgICAgZG9jczogaXRlbS5kaXIgPyBjb3VudERvY3MoaXRlbS5hYnMpIDogMSxcbiAgICAgIHJlcG86IGZyb21SZXBvID8gYmFzZW5hbWUoZnJvbVJlcG8pIDogbnVsbCxcbiAgICAgIGxlYXZlc1JlcG86IGZyb21SZXBvICE9PSBudWxsICYmIGZyb21SZXBvICE9PSBpbnRvUmVwbyxcbiAgICB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICAvKipcbiAgICogVGhlIGhpZGRlbiBsaXN0IG9mIHRoZSBlbnRyeSBhIHBhdGggYmVsb25ncyB0bywgQkVGT1JFIGFueXRoaW5nIGNoYW5nZXMgaXRcbiAgICog4oCUIHdoYXQgRTYwIHJlY29yZHMgc28gYSBoaWRlIGNhbiBiZSBwdXQgYmFjayBleGFjdGx5LlxuICAgKi9cbiAgaGlkZGVuQmVmb3JlKHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfSB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgICByZXR1cm4geyBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVsczogWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvKiogVGhlIHNhbWUsIGFkZHJlc3NlZCBieSBlbnRyeSDigJQgd2hhdCBgdW5oaWRlYCBuZWVkcyByZWNvcmRlZC4gKi9cbiAgaGlkZGVuT2ZFbnRyeShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgcmV0dXJuIGUgPyB7IGVudHJ5OiBlLmlkLCByZWxzOiBbLi4uKGUuaGlkZGVuID8/IFtdKV0gfSA6IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSBgcmVsc2AgKEU2MCdzIGludmVyc2Ugb2YgYm90aCBoaWRlXG4gICAqIGFuZCB1bmhpZGUpLiBSZXR1cm5zIHdoYXQgaXQgV0FTLCBzbyB0aGUgY2FsbGVyIGNhbiBidWlsZCB0aGUgb3Bwb3NpdGUgYWN0XG4gICAqIHdpdGhvdXQgcmVhZGluZyBzdGF0ZSBpdCBoYXMgYWxyZWFkeSBjaGFuZ2VkLlxuICAgKi9cbiAgcmVzdG9yZUhpZGRlbihlbnRyeUlkOiBzdHJpbmcsIHJlbHM6IHN0cmluZ1tdKTogeyBlbnRyeTogc3RyaW5nOyB3YXM6IHN0cmluZ1tdIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCB3YXMgPSBbLi4uKGUuaGlkZGVuID8/IFtdKV07XG4gICAgaWYgKHJlbHMubGVuZ3RoID09PSAwKSBkZWxldGUgZS5oaWRkZW47XG4gICAgZWxzZSBlLmhpZGRlbiA9IFsuLi5yZWxzXTtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgd2FzIH07XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlIHNvbWV0aGluZyB0aGlzIHNlc3Npb24gY3JlYXRlZCAoRTYwJ3MgdW5kbyBvZiBhIGNyZWF0aW9uKS5cbiAgICpcbiAgICog4puUIEEgTk9OLUVNUFRZIERJUkVDVE9SWSBJUyBSRUZVU0VELCBhbmQgbm8gZGlhbG9nIGNhbiBhdXRob3Jpc2UgaXQuIFVuZG9cbiAgICogd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdCByZWFjaGVzIHRoYXQgZm9sZGVyJ3NcbiAgICogY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzIHRoZW4gc29tZXRoaW5nIHB1dCB0aGVtIHRoZXJlXG4gICAqIHRoYXQgdGhlIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGEgZGlyZWN0b3J5IFRSRUUgaXMgYVxuICAgKiBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0IG1hZGUuIChDb2xlIHJ1bGVkIHRoZVxuICAgKiBmaWxlIGNhc2UgdGhlIG90aGVyIHdheSDigJQgY29uZmlybWVkLCBub3QgcmVmdXNlZCDigJQgYW5kIHRoaXMgbGltaXQgaXMgdGhlXG4gICAqIGNhcnZlLW91dCBoZSBhY2NlcHRlZC4pXG4gICAqXG4gICAqIOKaoCBJdCBhbHNvIHJlZnVzZXMgYW55dGhpbmcgdGhhdCBpcyBub3Qgd2hlcmUgdGhlIGhpc3Rvcnkgc2FpZCBpdCB3YXM6IGFcbiAgICogcGF0aCB0aGF0IGhhcyBiZWNvbWUgYSBkaXJlY3RvcnksIG9yIGEgZGlyZWN0b3J5IHRoYXQgaGFzIGJlY29tZSBhIGZpbGUsXG4gICAqIG1lYW5zIHRoZSB3b3JsZCBtb3ZlZCBhbmQgdGhlIHJlY29yZGVkIGludmVyc2Ugbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdC5cbiAgICovXG4gIHJlbW92ZUNyZWF0ZWQocmF3UGF0aDogc3RyaW5nLCBkaXI6IGJvb2xlYW4pOiB7IHBhdGg6IHN0cmluZzsgcmVtb3ZlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbHJlYWR5IGdvbmU6IHRoZSB1bmRvIGhhcyBub3RoaW5nIHRvIGRvLCB3aGljaCBpcyBub3QgYW4gZXJyb3IuXG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIHJlbW92ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpICE9PSBkaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoYWJzKX0gaXMgJHtzdC5pc0RpcmVjdG9yeSgpID8gXCJhIGZvbGRlclwiIDogXCJhIGZpbGVcIn0gbm93IOKAlCB0aGUgY2hhbmdlIHRoaXMgd291bGQgdW5kbyBubyBsb25nZXIgZGVzY3JpYmVzIGl0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBpZiAoZGlyKSB7XG4gICAgICBjb25zdCBsZWZ0ID0gcmVhZGRpclN5bmMoYWJzKTtcbiAgICAgIGlmIChsZWZ0Lmxlbmd0aCA+IDApXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzIG5vdCBlbXB0eSAoJHtsZWZ0Lmxlbmd0aH0gaXRlbSR7bGVmdC5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9KSDigJQgbW92ZSB3aGF0IGlzIGluc2lkZSBpdCBvdXQgZmlyc3RgLFxuICAgICAgICAgIDQwOSxcbiAgICAgICAgICBsZWZ0LnNsaWNlKDAsIDEwKSxcbiAgICAgICAgKTtcbiAgICAgIHJtZGlyU3luYyhhYnMpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1bmxpbmtTeW5jKGFicyk7XG4gICAgfVxuICAgIHRoaXMuZm9yZ2V0UGF0aChhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgcmVtb3ZlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKEU2MSkuXG4gICAqXG4gICAqIOKblCBUSEUgV0FSTklORyBIQUQgTk8gQU5TV0VSLCBXSElDSCBJUyBXSFkgVEhJUyBFWElTVFMuIFdoZW4gYSBkb2N1bWVudCdzXG4gICAqIG9yaWdpbmFsIGRpc2FwcGVhcnMgYmV0d2VlbiBzZXNzaW9ucywgcmVzdG9yZSBzYXlzIHNvIG9uIHB1cnBvc2Ug4oCUIFwiZ29uZVxuICAgKiBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXRcIiDigJQgYW5kXG4gICAqIHRoYXQgaXMgdGhlIFJJR0hUIHRoaW5nIHRvIHNheSwgYmVjYXVzZSB0aGUgc2Vzc2lvbiBpcyBzdGlsbCBob2xkaW5nIHRoZVxuICAgKiBjb250ZW50IGFuZCBvZmZlcmluZyBpdCBiYWNrLiBXaGF0IHdhcyBtaXNzaW5nIHdhcyBhbnkgd2F5IHRvIHJlcGx5IFwibm8sIElcbiAgICogbWVhbnQgdG8gZGVsZXRlIHRoYXRcIjogdGhlIG5vdGljZSByZXBlYXRlZCBvbiBldmVyeSByZXN0b3JlIGZvcmV2ZXIgYW5kIHRoZVxuICAgKiBvbmx5IGVzY2FwZSB3YXMgcmVjcmVhdGluZyB0aGUgc2Vzc2lvbi4gQSB3YXJuaW5nIHdpdGggbm8gY29ycmVzcG9uZGluZyBhY3RcbiAgICogaXMgdGhlIHNoYXBlIHRoaXMgc3BlbGwga2VlcHMgdHJ5aW5nIG5vdCB0byBoYXZlLlxuICAgKlxuICAgKiDim5QgUkVGVVNFRCBXSElMRSBUSEUgRklMRSBFWElTVFMsIGFuZCB0aGUgcmVmdXNhbCBuYW1lcyB0aGUgcmlnaHQgdmVyYi5cbiAgICogRm9yZ2V0dGluZyBhIExJVkUgZG9jdW1lbnQncyByZWNvcmQgd291bGQgdGhyb3cgYXdheSBpdHMgdmVyc2lvbiBoaXN0b3J5XG4gICAqIHdoaWxlIHRoZSBkb2N1bWVudCBpdHNlbGYgc2l0cyB0aGVyZSBvbiBkaXNrIOKAlCB0aGUgY29uZnVzaW9uIHRoaXMgbXVzdCBub3RcbiAgICogZW5hYmxlLiBUYWtpbmcgc29tZXRoaW5nIG91dCBvZiB0aGUgc2lkZWJhciBpcyBgaGlkZWA7IHRoaXMgaXMgb25seSBmb3IgYVxuICAgKiByZWNvcmQgd2hvc2Ugc3ViamVjdCBpcyBnb25lLlxuICAgKlxuICAgKiDimqAgVGhlIHZlcnNpb24gZmlsZXMgdW5kZXIgdGhlIHNlc3Npb24gaG9tZSBhcmUgTEVGVCB3aGVyZSB0aGV5IGFyZSwgYXNcbiAgICogd2l0aCB1bmRvJ3MgZGVsZXRlOiBub3RoaW5nIHJlYWRzIHRoZW0gb25jZSB0aGUgcmVjb3JkIGlzIGdvbmUsIGFuZFxuICAgKiByZW1vdmluZyB0aGVtIHdvdWxkIGJlIGEgc2Vjb25kIGRlbGV0aW9uIG5vYm9keSBhc2tlZCBmb3IuXG4gICAqL1xuICBmb3JnZXREb2MocmVmPzogc3RyaW5nKTogeyBzbHVnOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbnM6IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShyZWYpO1xuICAgIGlmIChleGlzdHNTeW5jKGQub3JpZ2luYWwpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGQub3JpZ2luYWwpfSBpcyBzdGlsbCBvbiBkaXNrIOKAlCBmb3JnZXQgaXMgZm9yIGEgZG9jdW1lbnQgd2hvc2UgZmlsZSBpcyBnb25lLiBUbyB0YWtlIGl0IG91dCBvZiB0aGUgY29udGV4dCwgcmVtb3ZlIGl0IGZyb20gU2NyaXB0b3JpdW0gaW5zdGVhZC5gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGZvcmdvdHRlbiA9IHtcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKHgpID0+IHguc2x1ZyAhPT0gZC5zbHVnKTtcbiAgICBpZiAodGhpcy5tLm9wZW5Eb2MgPT09IGQuc2x1ZykgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLm0uZG9jc1swXT8uc2x1ZyA/PyBudWxsO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIGZvcmdvdHRlbjtcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgYSBwYXRoIHRoYXQgaXMgbm8gbG9uZ2VyIG9uIGRpc2s6IHBydW5lIGl0IGZyb20gZXZlcnkgY29udGV4dCBlbnRyeSxcbiAgICogZHJvcCB0aGUgZW50cnkgaWYgdGhhdCBlbXB0aWVzIGl0LCBhbmQgZm9yZ2V0IGFueSBkb2N1bWVudCByZWNvcmQgZm9yIGl0LlxuICAgKlxuICAgKiDim5QgYHJlc2NhbmAgSVMgTk9UIEVOT1VHSCwgQU5EIFRIQVQgV0FTIFRIRSBCVUcuIEl0IHJldHVybnMgZWFybHkgZm9yIGFueVxuICAgKiBlbnRyeSB3aG9zZSBtZW1iZXJzaGlwIGlzIG5vdCBgbWlycm9yZWRgIOKAlCBhbmQgYSBzaW5nbGUgZG9jdW1lbnQgaXMgYVxuICAgKiBgbGlzdGVkYCBlbnRyeSwgc28gZGVsZXRpbmcgb25lIGxlZnQgaXRzIG5vZGUgaW4gdGhlIHNpZGViYXIgZm9yZXZlciB3aGlsZVxuICAgKiB0aGUgZmlsZSB3YXMgZ29uZSBmcm9tIHRoZSBkaXNrLiBDb2xlIGZvdW5kIGl0IHdpdGhpbiBhIG1pbnV0ZSBvZiBFNjBcbiAgICogc2hpcHBpbmc6IFwiaXQncyBub3QgYmVpbmcgcmVtb3ZlZCBmcm9tIHRoZSBzaWRlYmFy4oCmIHRoZW4gSSBjcmVhdGVkIGFub3RoZXJcbiAgICogZG9jdW1lbnQgYWxzbyB1bnRpdGxlZCBhbmQgSSB0aGluayB0aGVyZSBtaWdodCBoYXZlIGJlZW4gZXZlbiBhIHdlaXJkXG4gICAqIG5hbWluZyBpc3N1ZVwiLlxuICAgKlxuICAgKiDimqAgVEhFIE5BTUlORyBPRERJVFkgV0FTIFRIRSBTRUNPTkQgSEFMRiBPRiBUSEUgU0FNRSBCVUcuIFRoZSBgRG9jUmVjb3JkYFxuICAgKiBvdXRsaXZlZCB0aGUgZmlsZSB0b28sIHNvIGl0cyBTTFVHIHN0YXllZCB0YWtlbiBhbmQgdGhlIG5leHQgYFVudGl0bGVkLm1kYFxuICAgKiBiZWNhbWUgYHVudGl0bGVkLTJgIHdoaWxlIHRoZSBmaWxlIG9uIGRpc2sgd2FzIHBsYWluIGBVbnRpdGxlZC5tZGAuIEFcbiAgICogcmVjb3JkIGZvciBhIGRvY3VtZW50IHRoYXQgZG9lcyBub3QgZXhpc3QgaGFzIG5vIHJlYWRlcjsgaXQgb25seSBnZXRzIGluXG4gICAqIHRoZSB3YXkgb2YgdGhlIG5leHQgb25lLlxuICAgKlxuICAgKiDimqAgVGhlIHZlcnNpb24gZmlsZXMgdW5kZXIgdGhlIHNlc3Npb24gaG9tZSBhcmUgTEVGVCB3aGVyZSB0aGV5IGFyZS4gVGhlXG4gICAqIHJlY29yZCBpcyBnb25lLCBzbyBub3RoaW5nIHJlYWRzIHRoZW0sIGFuZCByZW1vdmluZyB0aGVtIHdvdWxkIGJlIGEgc2Vjb25kXG4gICAqIGRlbGV0aW9uIHRoZSBodW1hbiB3YXMgbmV2ZXIgYXNrZWQgYWJvdXQg4oCUIHRoZSBkaWFsb2cgcHJvbWlzZWQgdGhlIGNyZWF0ZWRcbiAgICogZmlsZSwgbm90IHRoZSBzZXNzaW9uJ3Mgb3duIGNvcGllcy5cbiAgICovXG4gIHByaXZhdGUgZm9yZ2V0UGF0aChhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGluc2lkZSA9IChwOiBzdHJpbmcpID0+IHAgPT09IGFicyB8fCBwLnN0YXJ0c1dpdGgoYWJzICsgc2VwKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgWy4uLnRoaXMubS5jb250ZXh0XSkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmICFpbnNpZGUoZS5yb290KSkge1xuICAgICAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyBBIGBsaXN0ZWRgIGVudHJ5IChvciBhIG1pcnJvcmVkIG9uZSB0aGF0IFdBUyB0aGUgZGVsZXRlZCBmb2xkZXIpOlxuICAgICAgLy8gcHJ1bmUgdGhlIG5vZGVzIGJ5IGhhbmQsIHNpbmNlIGByZXNjYW5gIHdpbGwgbm90IGxvb2sgYXQgaXQuXG4gICAgICBjb25zdCBwcnVuZSA9IChub2RlczogQ29udGV4dE5vZGVbXSk6IENvbnRleHROb2RlW10gPT5cbiAgICAgICAgbm9kZXNcbiAgICAgICAgICAuZmlsdGVyKChuKSA9PiAhaW5zaWRlKGpvaW4oZS5yb290LCBuLnJlbCkpKVxuICAgICAgICAgIC5tYXAoKG4pID0+IChuLmtpbmQgPT09IFwiZ3JvdXBcIiA/IHsgLi4ubiwgY2hpbGRyZW46IHBydW5lKG4uY2hpbGRyZW4pIH0gOiBuKSk7XG4gICAgICBlLm5vZGVzID0gcHJ1bmUoZS5ub2Rlcyk7XG4gICAgICBpZiAoZS5ub2Rlcy5sZW5ndGggPT09IDAgfHwgaW5zaWRlKGUucm9vdCkpIHRoaXMucmVtb3ZlQ29udGV4dChlLmlkKTtcbiAgICB9XG4gICAgLy8gQSByZWNvcmQgZm9yIGEgZmlsZSB0aGF0IGlzIGdvbmUgaGFzIG5vIHJlYWRlciwgYW5kIGl0cyBzbHVnIHdvdWxkXG4gICAgLy8gb3RoZXJ3aXNlIHN0YXkgdGFrZW4uXG4gICAgdGhpcy5tLmRvY3MgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+ICFpbnNpZGUoZC5vcmlnaW5hbCkpO1xuICAgIGlmICh0aGlzLm0ub3BlbkRvYyAmJiAhdGhpcy5tLmRvY3Muc29tZSgoZCkgPT4gZC5zbHVnID09PSB0aGlzLm0ub3BlbkRvYykpXG4gICAgICB0aGlzLm0ub3BlbkRvYyA9IHRoaXMubS5kb2NzWzBdPy5zbHVnID8/IG51bGw7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICB1bmhpZGUoZW50cnlJZDogc3RyaW5nKTogeyBlbnRyeTogc3RyaW5nOyByZXN0b3JlZDogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCByZXN0b3JlZCA9IGUuaGlkZGVuPy5sZW5ndGggPz8gMDtcbiAgICBkZWxldGUgZS5oaWRkZW47XG4gICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgcmVzdG9yZWQgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjI6IGEgc2luZ2xlIGRvY3VtZW50IGJlY29tZXMgYSBzZXQg4oCUIGEgZm9sZGVyIG5hbWVkIGZvciBpdCBiZXNpZGUgaXQsIHRoZVxuICAgKiBkb2N1bWVudCBtb3ZlZCBpbiwgYW5kIHRoZSBlbnRyeSAoc2FtZSBpZCkgbm93IG1pcnJvcnMgdGhhdCBmb2xkZXIuXG4gICAqL1xuICBtYWtlU2V0KHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmb2xkZXI6IHN0cmluZzsgZW50cnk6IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgaWYgKGl0ZW0uZW50cnkubWVtYmVyc2hpcCAhPT0gXCJsaXN0ZWRcIiB8fCBpdGVtLmRpcilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gYSBzZXQg4oCUIG1ha2UgYSBmb2xkZXIgdGhlcmUgaW5zdGVhZGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShpdGVtLmFicyk7XG4gICAgY29uc3Qgc3RlbSA9IGJhc2VuYW1lKGl0ZW0uYWJzLCBleHRuYW1lKGl0ZW0uYWJzKSkgfHwgXCJVbnRpdGxlZFwiO1xuICAgIGNvbnN0IGZvbGRlciA9IGpvaW4ocGFyZW50LCB0aGlzLmZyZWVOYW1lKHBhcmVudCwgc3RlbSwgdHJ1ZSkpO1xuICAgIG1rZGlyU3luYyhmb2xkZXIpO1xuICAgIGNvbnN0IHRvID0gam9pbihmb2xkZXIsIGJhc2VuYW1lKGl0ZW0uYWJzKSk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIGNvbnN0IGUgPSBpdGVtLmVudHJ5O1xuICAgIGUubWVtYmVyc2hpcCA9IFwibWlycm9yZWRcIjtcbiAgICBlLnJvb3QgPSBmb2xkZXI7XG4gICAgZS5sYWJlbCA9IGJhc2VuYW1lKGZvbGRlcik7XG4gICAgZS5ub2RlcyA9IFtdO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmb2xkZXIsIGVudHJ5OiBlLmlkIH07XG4gIH1cblxuICAvKiogVGhlIG1vc3QgdGV4dCBvbmUgaW1wb3J0IGNhcnJpZXMg4oCUIGEgZG9jdW1lbnQsIG5vdCBhIGRhdGEgZHVtcC4gKi9cbiAgc3RhdGljIHJlYWRvbmx5IElNUE9SVF9NQVhfQllURVMgPSA4ICogMTAyNCAqIDEwMjQ7XG5cbiAgLyoqXG4gICAqIEUyMydzIGRyb3A6IGEgQ09QWSBvZiBhIGZpbGUncyB0ZXh0LCB3cml0dGVuIHVuZGVyIGEgZnJlZSBuYW1lIGludG8gYGludG9gXG4gICAqIChkZWZhdWx0OiB0aGUgd29ya3NwYWNlKSwgdGhlbiBzaG93biBsaWtlIGFueSBvdGhlciBkb2N1bWVudC5cbiAgICovXG4gIGltcG9ydFRleHQobmFtZTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIHJhd0ludG8/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBmaWxlID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgaWYgKCFpc0RvY05hbWUoZmlsZSkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm90IGEgZG9jdW1lbnQgU2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHtmaWxlfWAsXG4gICAgICAgIDQwMCxcbiAgICAgICAgWy4uLkRPQ19FWFRFTlNJT05TXSxcbiAgICAgICk7XG4gICAgaWYgKEJ1ZmZlci5ieXRlTGVuZ3RoKHRleHQpID4gU2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZmlsZX0gaXMgbGFyZ2VyIHRoYW4gJHtTZXNzaW9uLklNUE9SVF9NQVhfQllURVMgLyAxMDI0IC8gMTAyNH0gTUIg4oCUIG5vdCBpbXBvcnRlZGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8gPz8gdGhpcy53b3Jrc3BhY2UpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCB0aGlzLmZyZWVOYW1lKGRpciwgZmlsZSwgZmFsc2UpKTtcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgdGV4dCwgeyBmbGFnOiBcInd4XCIgfSk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNoYXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLy8g4pSA4pSAIHRoZSB3b3JrIHF1ZXVlIChFNTApIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBTdGFydCBhIHRhc2suIEl0IGlzIEFOTk9VTkNFRCBhcyBhIGNoYXQgbWVzc2FnZSBhbmQgcmVjb3JkZWQgYXMgYSB0YXNrIGF0XG4gICAqIHRoZSBzYW1lIG1vbWVudCDigJQgQ29sZSdzIGZyYW1pbmcsIFwiYSBtZXNzYWdlIHRoYXQgY2FuIGJlIG1hcmtlZCBkb25lXCIg4oCUXG4gICAqIHNvIHRoZSBjb252ZXJzYXRpb24gcmVhZHMgYXMgYSBuYXJyYXRpdmUgYW5kIHRoZSBxdWV1ZSByZWFkcyBhcyBzdGF0ZSxcbiAgICogb3ZlciBvbmUgZmFjdCByYXRoZXIgdGhhbiB0d28uXG4gICAqL1xuICBzdGFydFRhc2sodGV4dDogc3RyaW5nLCB3aG86IFZlcnNpb25BdXRob3IpOiBUYXNrIHtcbiAgICBjb25zdCBib2R5ID0gdGV4dC50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSB0YXNrIG5lZWRzIHRvIHNheSB3aGF0IHRoZSB3b3JrIGlzXCIsIDQwMCk7XG4gICAgY29uc3QgbWVzc2FnZSA9IHRoaXMuYWRkTWVzc2FnZSh3aG8sIGJvZHkpO1xuICAgIGNvbnN0IHRhc2s6IFRhc2sgPSB7XG4gICAgICBpZDogYHQtJHtyYW5kSGV4KDQpfWAsXG4gICAgICB0ZXh0OiBib2R5LFxuICAgICAgd2hvLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbWVzc2FnZUlkOiBtZXNzYWdlLmlkLFxuICAgIH07XG4gICAgdGhpcy5tLnRhc2tzID0gWy4uLih0aGlzLm0udGFza3MgPz8gW10pLCB0YXNrXTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIHByaXZhdGUgdGFza09yRGllKGlkOiBzdHJpbmcpOiBUYXNrIHtcbiAgICBjb25zdCB0YXNrID0gKHRoaXMubS50YXNrcyA/PyBbXSkuZmluZCgodCkgPT4gdC5pZCA9PT0gaWQpO1xuICAgIGlmICghdGFzaylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyB0YXNrICR7aWR9IGluIHRoaXMgc2Vzc2lvbmAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgKHRoaXMubS50YXNrcyA/PyBbXSkuZmlsdGVyKCh0KSA9PiB0LmRvbmVBdCA9PT0gdW5kZWZpbmVkKS5tYXAoKHQpID0+IHQuaWQpLFxuICAgICAgKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKiBTYXkgd2hhdCBpcyBiZWluZyBkb25lIHJpZ2h0IG5vdyDigJQgZm9yIHdvcmsgd2l0aCBzdGVwcyB3b3J0aCB3YXRjaGluZy4gKi9cbiAgc2V0VGFza1N0YXR1cyhpZDogc3RyaW5nLCBzdGF0dXM6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSB0aGlzLnRhc2tPckRpZShpZCk7XG4gICAgaWYgKHRhc2suZG9uZUF0ICE9PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGB0YXNrICR7aWR9IGlzIGFscmVhZHkgZG9uZSDigJQgaXRzIHN0YXR1cyBjYW5ub3QgY2hhbmdlYCwgNDA5KTtcbiAgICB0YXNrLnN0YXR1cyA9IHN0YXR1cy50cmltKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKipcbiAgICogTWFyayBpdCBkb25lLiBJZGVtcG90ZW50IG9uIHB1cnBvc2U6IGEgdGFzayBmaW5pc2hlZCB0d2ljZSDigJQgYW4gYWdlbnRcbiAgICogcmV0cnlpbmcsIGEgaHVtYW4gY2xpY2tpbmcgYXMgdGhlIGFnZW50IHJlcG9ydHMg4oCUIGlzIG5vdCBhbiBlcnJvciwgYW5kXG4gICAqIHJlZnVzaW5nIHdvdWxkIG1ha2UgdGhlIHN1cmZhY2UgaGFuZGxlIGEgcmFjZSBpdCBkaWQgbm90IGNhdXNlLlxuICAgKi9cbiAgZmluaXNoVGFzayhpZDogc3RyaW5nLCBvdXRjb21lPzogc3RyaW5nKTogeyB0YXNrOiBUYXNrOyBhbHJlYWR5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IHRhc2sgPSB0aGlzLnRhc2tPckRpZShpZCk7XG4gICAgY29uc3QgYWxyZWFkeSA9IHRhc2suZG9uZUF0ICE9PSB1bmRlZmluZWQ7XG4gICAgaWYgKCFhbHJlYWR5KSB7XG4gICAgICB0YXNrLmRvbmVBdCA9IERhdGUubm93KCk7XG4gICAgICB0YXNrLnN0YXR1cyA9IHVuZGVmaW5lZDtcbiAgICAgIGlmIChvdXRjb21lPy50cmltKCkpIHRhc2sub3V0Y29tZSA9IG91dGNvbWUudHJpbSgpO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgfVxuICAgIHJldHVybiB7IHRhc2ssIGFscmVhZHkgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgYSB0YXNrIGVudGlyZWx5IOKAlCBmb3Igb25lIHN0YXJ0ZWQgYnkgbWlzdGFrZS4gTWFya2luZyBpdCBkb25lIHdvdWxkXG4gICAqIHB1dCBhIHRoaW5nIHRoYXQgbmV2ZXIgaGFwcGVuZWQgaW50byB0aGUgcmVjb3JkOyBhIHF1ZXVlIHlvdSBjYW5ub3QgY2xlYXJcbiAgICogb2YgaXRzIG93biBtaXN0YWtlcyBzdG9wcyBiZWluZyBhIHRydXN0d29ydGh5IGFjY291bnQgb2YgdGhlIHdvcmsuXG4gICAqL1xuICByZW1vdmVUYXNrKGlkOiBzdHJpbmcpOiBUYXNrIHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIHRoaXMubS50YXNrcyA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5pZCAhPT0gaWQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBldmVyeSBmaW5pc2hlZCB0YXNrLiBPdXRzdGFuZGluZyBvbmVzIGFyZSB1bnRvdWNoZWQg4oCUIGNsZWFyaW5nIGlzXG4gICAqIHRpZHlpbmcgd2hhdCBpcyBPVkVSLCBuZXZlciBhYmFuZG9uaW5nIHdvcmsgc3RpbGwgaW4gZmxpZ2h0LlxuICAgKi9cbiAgY2xlYXJEb25lVGFza3MoKTogbnVtYmVyIHtcbiAgICBjb25zdCBiZWZvcmUgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5sZW5ndGg7XG4gICAgdGhpcy5tLnRhc2tzID0gKHRoaXMubS50YXNrcyA/PyBbXSkuZmlsdGVyKCh0KSA9PiB0LmRvbmVBdCA9PT0gdW5kZWZpbmVkKTtcbiAgICBjb25zdCBjbGVhcmVkID0gYmVmb3JlIC0gKHRoaXMubS50YXNrcz8ubGVuZ3RoID8/IDApO1xuICAgIGlmIChjbGVhcmVkID4gMCkgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIGNsZWFyZWQ7XG4gIH1cblxuICAvKiogTmV3ZXN0IGZpcnN0IOKAlCBhIHF1ZXVlIGlzIHJlYWQgZnJvbSB0aGUgdG9wLiAqL1xuICB0YXNrcygpOiBUYXNrW10ge1xuICAgIHJldHVybiBbLi4uKHRoaXMubS50YXNrcyA/PyBbXSldLnNvcnQoKGEsIGIpID0+IGIuY3JlYXRlZEF0IC0gYS5jcmVhdGVkQXQpO1xuICB9XG5cbiAgYWRkTWVzc2FnZShcbiAgICB3aG86IENoYXRXaG8sXG4gICAgdGV4dDogc3RyaW5nLFxuICAgIGV4dHJhOiB7IHNlbGVjdGlvbj86IFNlbGVjdGlvbiB8IG51bGw7IGFjdGl2ZVBhdGg/OiBzdHJpbmcgfCBudWxsIH0gPSB7fSxcbiAgKTogQ2hhdE1lc3NhZ2Uge1xuICAgIGNvbnN0IG1zZzogQ2hhdE1lc3NhZ2UgPSB7IGlkOiBgbS0ke3JhbmRIZXgoNCl9YCwgd2hvLCB0ZXh0LCB0czogRGF0ZS5ub3coKSwgLi4uZXh0cmEgfTtcbiAgICB0aGlzLm0uY2hhdC5wdXNoKG1zZyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCB2aWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQSBkb2N1bWVudCdzIGZyb250bWF0dGVyLCBmcm9tIHRoZSBBQ1RJVkUgdmVyc2lvbidzIHRleHQg4oCUIHdoYXQgdGhlIGh1bWFuXG4gICAqICBpcyByZWFkaW5nLCB3aGljaCBpcyBub3QgYWx3YXlzIHdoYXQgaXMgb24gZGlzayAoRTMyKS4gKi9cbiAgcHJpdmF0ZSBtZXRhT2YoZDogRG9jUmVjb3JkKTogRG9jVmlld1tcIm1ldGFcIl0ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhZE1ldGEocmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgZG9jVmlldyhkOiBEb2NSZWNvcmQpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4ge1xuICAgICAgbWV0YTogdGhpcy5tZXRhT2YoZCksXG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIGVudHJ5SWQ6IGQuZW50cnlJZCxcbiAgICAgIHJlbDogZC5yZWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5tYXAoKHYpID0+ICh7IC4uLnYsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgdi5uKSB9KSksXG4gICAgICBub3RlczogdGhpcy5wbGFjZWROb3RlcyhkKSxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBkaXJ0eTogdGhpcy5pc0RpcnR5KGQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGQub3V0c2lkZUNoYW5nZWQsXG4gICAgfTtcbiAgfVxuXG4gIGRvYyhzbHVnOiBzdHJpbmcpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4gdGhpcy5kb2NWaWV3KHRoaXMuZG9jT3JEaWUoc2x1ZykpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZyb250bWF0dGVyIGZvciBldmVyeSBkb2N1bWVudCBpbiB0aGUgY29udGV4dCwgYnkgcGF0aCAoRTMyKS5cbiAgICpcbiAgICogQ2FjaGVkIGJ5IHBhdGggYW5kIG10aW1lLCBhbmQgcmVhZCBIRUFELUZJUlNUOiBhIGZyb250bWF0dGVyIGJsb2NrIHNpdHMgYXRcbiAgICogdGhlIHRvcCBvZiBhIGZpbGUsIHNvIGEgMzAwIEtCIGRvY3VtZW50IGNvc3RzIDggS0Igb2YgcmVhZC4gVGhlIGNhcCBrZWVwcyBhXG4gICAqIDIsMDAwLW5vZGUgbWlycm9yIGZyb20gbWVhbmluZyAyLDAwMCByZWFkcyBwZXIgc25hcHNob3QsIGFuZCBoaXR0aW5nIGl0IGlzXG4gICAqIFNBSUQgb24gdGhlIHdpcmUgcmF0aGVyIHRoYW4gbGVmdCB0byBsb29rIGxpa2UgZG9jdW1lbnRzIHdpdGhvdXQgYW55LlxuICAgKi9cbiAgcHJpdmF0ZSBtZXRhQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBtdGltZU1zOiBudW1iZXI7IHN1bW1hcnk6IERvY1N1bW1hcnkgfCBudWxsIH0+KCk7XG5cbiAgY29udGV4dE1ldGEoY2FwID0gTUVUQV9TQ0FOX0NBUCk6IHsgbWFwOiBSZWNvcmQ8c3RyaW5nLCBEb2NTdW1tYXJ5PjsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IG1hcDogUmVjb3JkPHN0cmluZywgRG9jU3VtbWFyeT4gPSB7fTtcbiAgICBsZXQgc2VlbiA9IDA7XG4gICAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIHtcbiAgICAgICAgaWYgKHNlZW4gPj0gY2FwKSB7XG4gICAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBzZWVuKys7XG4gICAgICAgIGxldCBtdGltZU1zOiBudW1iZXI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbXRpbWVNcyA9IHN0YXRTeW5jKGFicykubXRpbWVNcztcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaGl0ID0gdGhpcy5tZXRhQ2FjaGUuZ2V0KGFicyk7XG4gICAgICAgIGxldCBzdW1tYXJ5OiBEb2NTdW1tYXJ5IHwgbnVsbDtcbiAgICAgICAgaWYgKGhpdCAmJiBoaXQubXRpbWVNcyA9PT0gbXRpbWVNcykgc3VtbWFyeSA9IGhpdC5zdW1tYXJ5O1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBzdW1tYXJ5ID0gc3VtbWFyaXplKHJlYWRNZXRhKHJlYWRIZWFkKGFicykpKTtcbiAgICAgICAgICB0aGlzLm1ldGFDYWNoZS5zZXQoYWJzLCB7IG10aW1lTXMsIHN1bW1hcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHN1bW1hcnkpIG1hcFthYnNdID0gc3VtbWFyeTtcbiAgICAgIH1cbiAgICAgIGlmICh0cnVuY2F0ZWQpIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4geyBtYXAsIHRydW5jYXRlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIE9uZSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHJlYWQsIG9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQncyAoRTMyKS4gVGhlXG4gICAqIGFnZW50IGdldHMgdGhlIGRhZW1vbidzIHBhcnNlIHJhdGhlciB0aGFuIHJlLXJlYWRpbmcgdGhlIFlBTUwgaXRzZWxmLlxuICAgKi9cbiAgbWV0YUZvcihyYXdQYXRoPzogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGlmIChyYXdQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgICAgY29uc3QgbWV0YSA9IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogYWJzLCBtZXRhLCAuLi4obWV0YSA/IHt9IDogeyBub3RlOiBcIm5vIGZyb250bWF0dGVyIGJsb2NrXCIgfSkgfTtcbiAgICB9XG4gICAgY29uc3Qgb3V0OiB7IHBhdGg6IHN0cmluZzsgbWV0YTogRG9jTWV0YSB8IG51bGwgfVtdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIG91dC5wdXNoKHsgcGF0aDogYWJzLCBtZXRhOiByZWFkTWV0YShyZWFkSGVhZChhYnMpKSB9KTtcbiAgICByZXR1cm4geyBkb2N1bWVudHM6IG91dCwgY291bnQ6IG91dC5sZW5ndGggfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBwZG9jcydzIGBmaW5kYCwgb3ZlciB0aGlzIHNlc3Npb24ncyBjb250ZXh0LiBTYW1lIGZpbHRlciBuYW1lcywgc2FtZVxuICAgKiBBTkRpbmcsIGFuZCB0aGUgc2FtZSBydWxlIHRoYXQgYW4gZW1wdHkgcmVzdWx0IGlzIGFuIEFOU1dFUjogYGNvdW50YCBzYXlzXG4gICAqIGhvdyBtYW55IG1hdGNoZWQsIGFuZCB0aGUgY2FsbGVyIHJlYWRzIHRoYXQgcmF0aGVyIHRoYW4gdGhlIGV4aXQgY29kZS5cbiAgICovXG4gIGZpbmQoZmlsdGVyOiBNZXRhRmlsdGVyKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IG1hdGNoZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkge1xuICAgICAgICBjb25zdCBtZXRhID0gcmVhZE1ldGEocmVhZEhlYWQoYWJzKSk7XG4gICAgICAgIGlmICghbWF0Y2hlc0ZpbHRlcihtZXRhLCBmaWx0ZXIpKSBjb250aW51ZTtcbiAgICAgICAgbWF0Y2hlcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgZW50cnk6IGUuaWQsXG4gICAgICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLihtZXRhPy50aXRsZSA/IHsgdGl0bGU6IG1ldGEudGl0bGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4obWV0YT8uZGVzY3JpcHRpb24gPyB7IGRlc2NyaXB0aW9uOiBtZXRhLmRlc2NyaXB0aW9uIH0gOiB7fSksXG4gICAgICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gbnVsbCxcbiAgICAgICAgICAuLi4obWV0YT8ubGlmZWN5Y2xlID8geyBsaWZlY3ljbGU6IG1ldGEubGlmZWN5Y2xlIH0gOiB7fSksXG4gICAgICAgICAgdGFnczogbWV0YT8udGFncyA/PyBbXSxcbiAgICAgICAgICBkYXRlOiBtZXRhPy5kYXRlID8/IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIHJldHVybiB7IG1hdGNoZXMsIGNvdW50OiBtYXRjaGVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIE9uZSBzZXQncyBtYXAgKEUzMyk6IGl0cyBkb2N1bWVudHMgYXMgbm9kZXMsIGFuZCB0aGUgZm91ciBzb3VyY2VzIG9mIGVkZ2VzXG4gICAqIOKAlCBib2R5IGxpbmtzLCB3aWtpIGxpbmtzLCB0eXBlZCBsaW5rcyBhbmQgZnJvbnRtYXR0ZXIgcmVmZXJlbmNlcy5cbiAgICovXG4gIGdyYXBoRm9yKGVudHJ5SWQ/OiBzdHJpbmcpOiBHcmFwaFBheWxvYWQge1xuICAgIGNvbnN0IGUgPSBlbnRyeUlkXG4gICAgICA/IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpXG4gICAgICA6IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHgubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBlbnRyeUlkID8gYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAgOiBcInRoaXMgc2Vzc2lvbiBoYXMgbm8gc2V0IHRvIG1hcFwiLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHBhdGhzID0gZG9jUGF0aHMoZSk7XG4gICAgY29uc3QgaW5kZXg6IEJ1bmRsZUluZGV4ID0ge1xuICAgICAgcm9vdDogZS5yb290LFxuICAgICAgcGF0aHMsXG4gICAgICBtZXRhT2Y6IChwKSA9PiByZWFkTWV0YShyZWFkSGVhZChwKSksXG4gICAgICBleGlzdHM6IChwKSA9PiBleGlzdHNTeW5jKHApLFxuICAgICAgcmVwb1Jvb3Q6IGdpdFJvb3RPZihlLnJvb3QpLFxuICAgIH07XG4gICAgY29uc3QgZyA9IGJ1aWxkR3JhcGgoaW5kZXgsIChwKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICByZXR1cm4gc3BsaXRGcm9udG1hdHRlcihyZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpKS5ib2R5O1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBcIlwiO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiB7IGVudHJ5OiBlLmlkLCAuLi5nIH07XG4gIH1cblxuICAvKipcbiAgICogU2VhcmNoIGV2ZXJ5dGhpbmcgaW4gdGhlIGNvbnRleHQ6IGZ1enp5IG92ZXIgbmFtZXMsIGV4YWN0IG92ZXIgY29udGVudCAoRTU5KS5cbiAgICpcbiAgICog4puUIFRISVMgSVMgV0hZIFRIRSBWRVJCIEVYSVNUUyBBVCBBTEwsIGFuZCB0aGUgcmVhc29uIGlzIG9uZSBsaW5lOiBhXG4gICAqIGRvY3VtZW50IG9wZW4gaW4gdGhlIHNlc3Npb24gaXMgc2hvd24gYXMgaXRzIEFDVElWRSBWRVJTSU9OLCB3aGljaCBsaXZlc1xuICAgKiB1bmRlciB0aGUgc2Vzc2lvbiBob21lIGFuZCBub3QgYXQgdGhlIG9yaWdpbmFsIHBhdGguIEFuIGFnZW50IGdyZXBwaW5nIHRoZVxuICAgKiB3b3Jrc3BhY2UgdGhlcmVmb3JlIGZpbmRzIHRoZSBTQVZFRCBmaWxlIGFuZCBzaWxlbnRseSBtaXNzZXMgdGhlIHRleHQgdGhlXG4gICAqIGh1bWFuIGlzIHJlYWRpbmcg4oCUIHNvIFwic2VhcmNoIHdoYXQgeW91IGNhbiBzZWVcIiBpcyBhIHF1ZXN0aW9uIG9ubHkgdGhlXG4gICAqIHNlc3Npb24gY2FuIGFuc3dlci4gRXZlcnl0aGluZyBlbHNlIGFib3V0IHNlYXJjaGluZyBmaWxlcywgYW4gYWdlbnQgY2FuXG4gICAqIGFscmVhZHkgZG8gd2l0aCBncmVwLCB3aGljaCBpcyB3aHkgdGhlcmUgaXMgbm8gaW4tZG9jdW1lbnQgdmVyYi5cbiAgICpcbiAgICog4pqgIEhpZGRlbiBkb2N1bWVudHMgYXJlIGV4Y2x1ZGVkLCBiZWNhdXNlIHRoZSBjb250ZXh0IGlzIHdoYXQgdGhlIGh1bWFuXG4gICAqIGNob3NlIHRvIGxvb2sgYXQ7IGEgcmVzdWx0IHRoZXkgY2Fubm90IHNlZSBpbiB0aGUgc2lkZWJhciB3b3VsZCBiZSBhIHJlc3VsdFxuICAgKiB0aGV5IGNhbm5vdCBvcGVuLlxuICAgKi9cbiAgc2VhcmNoQWxsKG9wdHM6IHsgcXVlcnk6IHN0cmluZzsgbGltaXQ/OiBudW1iZXIgfSk6IFNlYXJjaFJlcG9ydCB7XG4gICAgY29uc3QgY2FuZGlkYXRlczogQ2FuZGlkYXRlW10gPSBbXTtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgZm9yIChjb25zdCBwYXRoIG9mIGRvY1BhdGhzKGVudHJ5KSkge1xuICAgICAgICBpZiAoc2Vlbi5oYXMocGF0aCkpIGNvbnRpbnVlO1xuICAgICAgICBzZWVuLmFkZChwYXRoKTtcbiAgICAgICAgY29uc3QgcmVjb3JkID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gcGF0aCk7XG4gICAgICAgIGNvbnN0IHRpdGxlID0gcmVhZE1ldGEocmVhZEhlYWQocGF0aCkpPy50aXRsZTtcbiAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHtcbiAgICAgICAgICBwYXRoLFxuICAgICAgICAgIG5hbWU6IGJhc2VuYW1lKHBhdGgpLFxuICAgICAgICAgIC4uLihyZWNvcmQgPyB7IHNsdWc6IHJlY29yZC5zbHVnLCB2ZXJzaW9uOiByZWNvcmQuYWN0aXZlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHRpdGxlID8geyB0aXRsZSB9IDoge30pLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHNlYXJjaERvY3VtZW50cyhcbiAgICAgIGNhbmRpZGF0ZXMsXG4gICAgICBvcHRzLnF1ZXJ5LFxuICAgICAgKGMpID0+IHtcbiAgICAgICAgLy8gVGhlIEFDVElWRSBWRVJTSU9OIHdoZW4gdGhlIHNlc3Npb24gaGFzIG9uZSDigJQgc2VlIHRoZSBub3RlIGFib3ZlLlxuICAgICAgICBjb25zdCByZWNvcmQgPVxuICAgICAgICAgIGMuc2x1ZyA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5zbHVnID09PSBjLnNsdWcpO1xuICAgICAgICBpZiAocmVjb3JkKSByZXR1cm4gdGhpcy5hY3RpdmVUZXh0KHJlY29yZCk7XG4gICAgICAgIHJldHVybiByZWFkRmlsZVN5bmMoYy5wYXRoLCBcInV0ZjhcIik7XG4gICAgICB9LFxuICAgICAgb3B0cy5saW1pdCAhPT0gdW5kZWZpbmVkID8geyB0b3RhbDogb3B0cy5saW1pdCB9IDoge30sXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBsaW5rIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCB0aGUgcmVwb3J0IHlvdSBjYW4gQUNUIG9uIChFNTQpLlxuICAgKlxuICAgKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGdyYXBoYCBBTFJFQURZIEhBRCBUSEUgRkFDVFMgQU5EIFNUSUxMIERJRCBOT1QgQU5TV0VSXG4gICAqIFRIRSBRVUVTVElPTi4gQ29sZSBhc2tlZCB3aGV0aGVyIGFuIGFnZW50IGNhbiBjaGVjayBkYW5nbGluZyBsaW5rczsgdGhlXG4gICAqIGhvbmVzdCBhbnN3ZXIgd2FzIFwieWVzLCBieSBmZXRjaGluZyBhIHNldCdzIHdob2xlIG1hcCBhbmQgZmlsdGVyaW5nIHNldmVyYWxcbiAgICogaHVuZHJlZCBlZGdlc1wiLCB3aGljaCBpcyBhIGRpZmZlcmVudCB0aGluZyBmcm9tIGJlaW5nIGFibGUgdG8gY2hlY2sgdGhlbS5cbiAgICogVGhpcyBzYXlzIG9ubHkgd2hhdCBpcyBicm9rZW4sIGFuZCBzYXlzIGl0IGFzIGBmaWxlOmxpbmVgIHBsdXMgVEhFIFNUUklOR1xuICAgKiBUSEUgRE9DVU1FTlQgQUNUVUFMTFkgQ09OVEFJTlMg4oCUIHdoaWNoIGlzIHdoYXQgeW91IG5lZWQgdG8gcmVwYWlyIG9uZSwgYW5kXG4gICAqIHdoYXQgdGhlIG1hcCdzIHJlc29sdmVkIGB0b2AgaGFkIHF1aWV0bHkgdGhyb3duIGF3YXkuXG4gICAqXG4gICAqIOKaoCBOT1QgQU4gRVJST1IuIEEgZGFuZ2xpbmcgbGluayBpcyBhIGZhY3QgYWJvdXQgYSBzZXQsIG5vdCBhIGZhaWx1cmU6IE9LRlxuICAgKiDCpzExJ3MgcnVsZSwgYW5kIGl0IGlzIHdoeSB0aGlzIHJlcG9ydHMgYW5kIGV4aXRzIHplcm8uIERvY3VtZW50cyB0aGF0IHBvaW50XG4gICAqIGF0IHRoaW5ncyBub3Qgd3JpdHRlbiB5ZXQgYXJlIG5vcm1hbCBpbiBhIHdvcmxkIGJpYmxlLlxuICAgKi9cbiAgZGFuZ2xpbmdMaW5rcyhlbnRyeUlkPzogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGVudHJ5SWQpO1xuICAgIGNvbnN0IGJyb2tlbiA9IGcuZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIik7XG4gICAgLy8g4puUIEJPRFkgTElORVMgQkVDT01FIEZJTEUgTElORVMgSEVSRS4gTGlua3MgYXJlIGV4dHJhY3RlZCBmcm9tIHRoZSBib2R5LFxuICAgIC8vIHNvIHRoZSBudW1iZXIgdGhlIGdyYXBoIGNhcnJpZXMgaXMgc2hvcnQgYnkgaG93ZXZlciBtdWNoIGZyb250bWF0dGVyIHRoZVxuICAgIC8vIGRvY3VtZW50IGhhcyDigJQgYW5kIGEgcmVwb3J0IGlzIGZvciBvcGVuaW5nIGEgZmlsZSBhdCBhIGxpbmUuXG4gICAgY29uc3Qgb2Zmc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgY29uc3Qgb2Zmc2V0T2YgPSAocGF0aDogc3RyaW5nKTogbnVtYmVyID0+IHtcbiAgICAgIGNvbnN0IGtub3duID0gb2Zmc2V0cy5nZXQocGF0aCk7XG4gICAgICBpZiAoa25vd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIGtub3duO1xuICAgICAgbGV0IG9mZiA9IDA7XG4gICAgICB0cnkge1xuICAgICAgICBvZmYgPSBib2R5TGluZU9mZnNldChyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiB1bnJlYWRhYmxlIOKAlCByZXBvcnQgdGhlIGJvZHkgbGluZSByYXRoZXIgdGhhbiBub3RoaW5nICovXG4gICAgICB9XG4gICAgICBvZmZzZXRzLnNldChwYXRoLCBvZmYpO1xuICAgICAgcmV0dXJuIG9mZjtcbiAgICB9O1xuICAgIHJldHVybiB7XG4gICAgICBlbnRyeTogZy5lbnRyeSxcbiAgICAgIHJvb3Q6IGcucm9vdCxcbiAgICAgIGNvdW50OiBicm9rZW4ubGVuZ3RoLFxuICAgICAgbGlua3M6IGJyb2tlbi5tYXAoKGUpID0+ICh7XG4gICAgICAgIGZyb206IGUuZnJvbSxcbiAgICAgICAgLi4uKGUubGluZSAhPT0gdW5kZWZpbmVkID8geyBsaW5lOiBlLmxpbmUgKyBvZmZzZXRPZihlLmZyb20pIH0gOiB7fSksXG4gICAgICAgIC8vIFdoYXQgdGhlIGRvY3VtZW50IHNheXMsIG5vdCB3aGF0IHdlIGxvb2tlZCBmb3IuXG4gICAgICAgIC4uLihlLnJhdyAhPT0gdW5kZWZpbmVkID8geyB3cm90ZTogZS5yYXcgfSA6IHt9KSxcbiAgICAgICAgLy8gV2hlcmUgdGhlIHJlc29sdXRpb24gZW5kZWQgdXAsIHNvIGEgbmVhci1taXNzIGlzIHZpc2libGUuXG4gICAgICAgIHRyaWVkOiBlLnRvLFxuICAgICAgICBzb3VyY2U6IGUuc291cmNlLFxuICAgICAgICAuLi4oZS5rZXkgPyB7IGtleTogZS5rZXkgfSA6IHt9KSxcbiAgICAgICAgLi4uKGUucmVsLmxlbmd0aCA/IHsgcmVsOiBlLnJlbCB9IDoge30pLFxuICAgICAgfSkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogV2hhdCBjaXRlcyBhIGRvY3VtZW50LiBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSkgYXJlIGtlcHRcbiAgICogQVBBUlQsIHdoaWNoIGlzIGhvdyBwZG9jcyByZXBvcnRzIGl0IGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogb25lIGlzIGFcbiAgICogY2xhaW0gYWJvdXQgdGhlIGRvY3VtZW50LCB0aGUgb3RoZXIgYSBjaXRhdGlvbiBpbiBwcm9zZS5cbiAgICovXG4gIGJhY2tsaW5rcyhyYXdQYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICAgIGlmICghZW50cnkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3QgaW5zaWRlIGEgc2V0LCBzbyBub3RoaW5nIG1hcHMgaXRgLCA0MDApO1xuICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGVudHJ5LmlkKTtcbiAgICBjb25zdCBpbmJvdW5kID0gZy5lZGdlcy5maWx0ZXIoKHgpID0+IHgudG8gPT09IGFicyk7XG4gICAgY29uc3QgdGl0bGUgPSAocDogc3RyaW5nKSA9PiBnLm5vZGVzLmZpbmQoKG4pID0+IG4ucGF0aCA9PT0gcCk/LnRpdGxlID8/IGJhc2VuYW1lKHApO1xuICAgIHJldHVybiB7XG4gICAgICB0YXJnZXQ6IHsgcGF0aDogYWJzLCB0aXRsZTogdGl0bGUoYWJzKSB9LFxuICAgICAgcmVsYXRlZDogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJmcm9udG1hdHRlclwiKVxuICAgICAgICAubWFwKCh4KSA9PiAoeyBwYXRoOiB4LmZyb20sIHRpdGxlOiB0aXRsZSh4LmZyb20pLCBrZXk6IHgua2V5IH0pKSxcbiAgICAgIGxpbmtzOiBpbmJvdW5kXG4gICAgICAgIC5maWx0ZXIoKHgpID0+IHguc291cmNlID09PSBcImxpbmtcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwgcmVsOiB4LnJlbCB9KSksXG4gICAgICBjb3VudDogaW5ib3VuZC5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBXaGVyZSBkb2VzIHRoaXMgbGluayBnbz8gVGhlIHN1cmZhY2UgYXNrcyBiZWZvcmUgZm9sbG93aW5nIG9uZSAoRTMzKS4gKi9cbiAgcmVzb2x2ZUxpbmsoZnJvbTogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZyk6IFJlc29sdXRpb24ge1xuICAgIGNvbnN0IHNyYyA9IHRoaXMuc2hvd25QYXRoKGZyb20pO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiBzcmMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApLFxuICAgICk7XG4gICAgY29uc3Qgcm9vdCA9IGVudHJ5Py5yb290ID8/IGRpcm5hbWUoc3JjKTtcbiAgICBjb25zdCBwYXRocyA9IGVudHJ5ID8gZG9jUGF0aHMoZW50cnkpIDogW3NyY107XG4gICAgcmV0dXJuIHJlc29sdmVUYXJnZXQodGFyZ2V0LCBzcmMsIHtcbiAgICAgIHJvb3QsXG4gICAgICBwYXRocyxcbiAgICAgIG1ldGFPZjogKHApID0+IHJlYWRNZXRhKHJlYWRIZWFkKHApKSxcbiAgICAgIGV4aXN0czogKHApID0+IGV4aXN0c1N5bmMocCksXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKHJvb3QpLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgYSBmcm9udG1hdHRlciBibG9jayBmb3IgdGhpcyBkb2N1bWVudCBXT1VMRCBzYXkgKEUzNSkuIFN1Z2dlc3RlZCwgbm90XG4gICAqIHdyaXR0ZW46IHRoZSB0eXBlIGNvbWVzIGZyb20gdGhlIGRvY3VtZW50cyBiZXNpZGUgaXQsIHRoZSB0aXRsZSBmcm9tIGl0c1xuICAgKiBvd24gSDEsIGFuZCBgZGVzY3JpcHRpb25gIGlzIGxlZnQgYmxhbmsgZm9yIHdob2V2ZXIgZmlsbHMgaXQgaW4uXG4gICAqL1xuICBzdWdnZXN0TWV0YShyYXdQYXRoOiBzdHJpbmcsIGJ5Pzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGJsb2NrOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBpZiAoc3BsaXRGcm9udG1hdHRlcih0ZXh0KS5yYXcgIT09IG51bGwpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Jhc2VuYW1lKGFicyl9IGFscmVhZHkgaGFzIGZyb250bWF0dGVyYCwgNDA5KTtcbiAgICBjb25zdCBmb2xkZXIgPSBkaXJuYW1lKGFicyk7XG4gICAgY29uc3Qgc2libGluZ3M6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBwIG9mIGRvY1BhdGhzKGUpKVxuICAgICAgICBpZiAocCAhPT0gYWJzICYmIGRpcm5hbWUocCkgPT09IGZvbGRlcikge1xuICAgICAgICAgIGNvbnN0IHQgPSByZWFkTWV0YShyZWFkSGVhZChwKSk/LnR5cGU7XG4gICAgICAgICAgaWYgKHQpIHNpYmxpbmdzLnB1c2godCk7XG4gICAgICAgIH1cbiAgICBjb25zdCB0eXBlID0gZ3Vlc3NUeXBlKHNpYmxpbmdzLCBiYXNlbmFtZShmb2xkZXIpKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogYWJzLFxuICAgICAgdHlwZSxcbiAgICAgIGJsb2NrOiBidWlsZEJsb2NrKHtcbiAgICAgICAgLi4uKHR5cGUgPyB7IHR5cGUgfSA6IHt9KSxcbiAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAuLi4oYnkgPyB7IGJ5IH0gOiB7fSksXG4gICAgICB9KSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdyaXRlIGEgbmV3IGJsb2NrIGludG8gYSBkb2N1bWVudCB0aGF0IGhhcyBub25lIChFMzUpLlxuICAgKlxuICAgKiDim5QgVEhJUyBXUklURVMgVEhFIE9SSUdJTkFMLCB3aGljaCBFNyBvdGhlcndpc2UgcmVzZXJ2ZXMgZm9yIFNhdmUg4oCUIGFuZFxuICAgKiB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhbiBvdmVyc2lnaHQ6IHRoZSBhZ2VudCdzIHZlcmIgd3JpdGVzIHRoZSBmaWxlLCBhbmRcbiAgICogaWYgdGhlIGh1bWFuIGhhcyB1bnNhdmVkIGVkaXRzIHRvIGl0IHRoZSBDT05GTElDVCBCQVIgYXBwZWFycyBhbmQgdGhleVxuICAgKiBjaG9vc2UgKENvbGU6IFwid2UgY2FuIGFkanVzdCBpZiBuZWVkZWQgYWZ0ZXIgZ2V0dGluZyBhY3R1YWwgdXNhZ2UgYmVoaW5kXG4gICAqIHVzXCIpLiBSZWZ1c2luZyB3aGlsZSBhIGJ1ZmZlciBpcyBkaXJ0eSB3b3VsZCBsZXQgYW4gb3BlbiBkb2N1bWVudCBibG9jayB0aGVcbiAgICogYWdlbnQgaW5kZWZpbml0ZWx5LiBUaGUgSFVNQU4ncyBvd24gcGF0aCBuZXZlciBjb21lcyBoZXJlOiB0aGVpciBcImFkZFxuICAgKiBmcm9udG1hdHRlclwiIGlzIGFuIGVkaXQgdG8gdGhlaXIgYnVmZmVyLCB3aGljaCBTYXZlIHdyaXRlcyBsaWtlIGFueSBvdGhlci5cbiAgICovXG4gIG1ldGFJbml0KHJhd1BhdGg6IHN0cmluZywgb3B0czogeyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZyB9ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgc3VnZ2VzdGVkID0gdGhpcy5zdWdnZXN0TWV0YShyYXdQYXRoLCBvcHRzLmJ5KTtcbiAgICBjb25zdCBhYnMgPSBzdWdnZXN0ZWQucGF0aDtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IGJsb2NrID0gb3B0cy50eXBlXG4gICAgICA/IGJ1aWxkQmxvY2soe1xuICAgICAgICAgIHR5cGU6IG9wdHMudHlwZSxcbiAgICAgICAgICAuLi4odGl0bGVGcm9tQm9keSh0ZXh0KSA/IHsgdGl0bGU6IHRpdGxlRnJvbUJvZHkodGV4dCkgYXMgc3RyaW5nIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG9wdHMuYnkgPyB7IGJ5OiBvcHRzLmJ5IH0gOiB7fSksXG4gICAgICAgIH0pXG4gICAgICA6IHN1Z2dlc3RlZC5ibG9jaztcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgd2l0aEJsb2NrKHRleHQsIGJsb2NrKSk7XG4gICAgdGhpcy5tZXRhQ2FjaGUuZGVsZXRlKGFicyk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzLCB0eXBlOiBvcHRzLnR5cGUgPz8gc3VnZ2VzdGVkLnR5cGUgPz8gbnVsbCwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBTZXQga2V5cyBpbiBhbiBleGlzdGluZyBibG9jayDigJQgYSBMSU5FIGVkaXQgZWFjaCwgc28gbm90aGluZyBlbHNlIG1vdmVzLiAqL1xuICBtZXRhU2V0KHJhd1BhdGg6IHN0cmluZywgcGFpcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgbGV0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ID09PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBoYXMgbm8gZnJvbnRtYXR0ZXIg4oCUIGFkZCBpdCBmaXJzdCAobWV0YS1pbml0KWAsIDQwOSk7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGFpcnMpKSB7XG4gICAgICBpZiAoIS9eW0EtWmEtel9dW0EtWmEtejAtOV8uLV0qJC8udGVzdChrZXkpKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBcIiR7a2V5fVwiIGlzIG5vdCBhIGZyb250bWF0dGVyIGtleWAsIDQwMCk7XG4gICAgICB0ZXh0ID0gc2V0S2V5KHRleHQsIGtleSwgdmFsdWUpO1xuICAgIH1cbiAgICB3cml0ZUZpbGVTeW5jKGFicywgdGV4dCk7XG4gICAgdGhpcy5tZXRhQ2FjaGUuZGVsZXRlKGFicyk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzLCBzZXQ6IE9iamVjdC5rZXlzKHBhaXJzKSB9O1xuICB9XG5cbiAgLyoqIFRoZSBzZXNzaW9uJ3MgaGFsZiBvZiBgUHVibGljU3RhdGVgOyB0aGUgZGFlbW9uIGFkZHMgdGhlIGhvbWUtbGV2ZWwgYHByZWZzYCBhbmQgYHVzZXJIb21lYC4gKi9cbiAgLyoqXG4gICAqIFRoZSBjb252ZXJzYXRpb24sIHdpdGhvdXQgYnVpbGRpbmcgYSBzbmFwc2hvdCBhcm91bmQgaXQuXG4gICAqXG4gICAqIOKaoCBFNTMncyBhdHRlbnRpb24gdGljayBydW5zIGV2ZXJ5IHNlY29uZCBhbmQgb25seSBuZWVkcyB0aGUgY2hhdDsgY2FsbGluZ1xuICAgKiBgdmlldygpYCBmb3IgaXQgd291bGQgcmUtcmVhZCBldmVyeSBkb2N1bWVudCdzIGZyb250bWF0dGVyIG9uIGEgdGltZXIuXG4gICAqL1xuICBtZXNzYWdlcygpOiByZWFkb25seSBDaGF0TWVzc2FnZVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNoYXQ7XG4gIH1cblxuICB2aWV3KFxuICAgIG1vZGU6IFwiZGV2XCIgfCBcInJlbGVhc2VcIixcbiAgICBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwsXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBpcyB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMpOiBpdCBkZXBlbmRzIG9uIHRoZSBjbG9jayBhbmQgb25cbiAgICAvLyB0aGUgc25vb3plIHRoZSBzZXJ2ZXIgaG9sZHMsIG5laXRoZXIgb2Ygd2hpY2ggYmVsb25ncyBpbiB0aGUgc2Vzc2lvbi5cbiAgICAvLyDimqAgYHdhaXRpbmdgIGFuZCBgaGlzdG9yeWAgYXJlIHRoZSBTRVJWRVIncyB0byBhZGQgKEU1MywgRTYwKTogb25lIGRlcGVuZHNcbiAgICAvLyBvbiB0aGUgY2xvY2sgYW5kIHRoZSBzbm9vemUgaXQgaG9sZHMsIHRoZSBvdGhlciBvbiB0aGUgaW4tbWVtb3J5IGFjdFxuICAgIC8vIHN0YWNrcy4gTmVpdGhlciBiZWxvbmdzIGluIHRoZSBzZXNzaW9uJ3MgcGVyc2lzdGVkIHN0YXRlLlxuICApOiBPbWl0PFB1YmxpY1N0YXRlLCBcInByZWZzXCIgfCBcInVzZXJIb21lXCIgfCBcIndhaXRpbmdcIiB8IFwiaGlzdG9yeVwiPiB7XG4gICAgY29uc3QgbWV0YSA9IHRoaXMuY29udGV4dE1ldGEoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2Vzc2lvbklkOiB0aGlzLm0uc2Vzc2lvbklkLFxuICAgICAgaG9tZTogdGhpcy5ob21lLFxuICAgICAgd29ya3NwYWNlOiB0aGlzLndvcmtzcGFjZSxcbiAgICAgIGRvY01ldGE6IG1ldGEubWFwLFxuICAgICAgLi4uKG1ldGEudHJ1bmNhdGVkID8geyBkb2NNZXRhVHJ1bmNhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICBtb2RlLFxuICAgICAgY29udGV4dDogdGhpcy5tLmNvbnRleHQsXG4gICAgICBkb2NzOiB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IHRoaXMuZG9jVmlldyhkKSksXG4gICAgICBvcGVuRG9jOiB0aGlzLm0ub3BlbkRvYyxcbiAgICAgIHNlbGVjdGlvbixcbiAgICAgIGNoYXQ6IHRoaXMubS5jaGF0LFxuICAgICAgdGFza3M6IHRoaXMudGFza3MoKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogVGhlIGdpdCB3b3JraW5nIHRyZWUgYGRpcmAgaXMgaW4sIG9yIG51bGwuIEEgYC5naXRgIEVOVFJZLCBub3QgYSBkaXJlY3RvcnlcbiAqIHRlc3Q6IGEgd29ya3RyZWUgYW5kIGEgc3VibW9kdWxlIGJvdGggaGF2ZSBgLmdpdGAgYXMgYSBGSUxFLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2l0Um9vdE9mKGRpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGxldCBhdCA9IGRpcjtcbiAgZm9yICg7Oykge1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYXQsIFwiLmdpdFwiKSkpIHJldHVybiBhdDtcbiAgICBjb25zdCB1cCA9IGRpcm5hbWUoYXQpO1xuICAgIGlmICh1cCA9PT0gYXQpIHJldHVybiBudWxsO1xuICAgIGF0ID0gdXA7XG4gIH1cbn1cblxuLyoqIERvY3VtZW50cyB1bmRlciBhIGZvbGRlciwgZm9yIHNheWluZyBob3cgbXVjaCBhIG1vdmUgbW92ZXMuICovXG5mdW5jdGlvbiBjb3VudERvY3MoZGlyOiBzdHJpbmcpOiBudW1iZXIge1xuICBsZXQgbiA9IDA7XG4gIGNvbnN0IHdhbGsgPSAoYXQ6IHN0cmluZykgPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoYXQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oYXQsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkgd2FsayhhYnMpO1xuICAgICAgZWxzZSBpZiAoaXNEb2NOYW1lKG5hbWUpKSBuKys7XG4gICAgfVxuICB9O1xuICB3YWxrKGRpcik7XG4gIHJldHVybiBuO1xufVxuXG4vKipcbiAqIEhvdyBhIGNvbXBhcmlzb24gc2lkZSByZWFkcyBpbiBhIG1lc3NhZ2UgdG8gYSBodW1hbiBvciBhbiBhZ2VudC5cbiAqXG4gKiDim5QgVEhFIEZJTEUgSVMgTkFNRUQsIE5PVCBERVNDUklCRUQgKEU0MywgcmV2aXNlZCkuIFwiVGhlIG9yaWdpbmFsXCIgc291bmRlZFxuICogdGVtcG9yYWwgd2hlbiB0aGUgdGhpbmcgaXMgbG9jYXRpb25hbDsgXCJ0aGUgc2F2ZWQgZmlsZVwiIGZpeGVkIHRoYXQgYnV0IHJlYWRzXG4gKiBjaXJjdWxhciB0aGUgbW9tZW50IGl0IGlzIGEgREVTVElOQVRJT04g4oCUIFwic2F2ZSB0byB0aGUgc2F2ZWQgZmlsZVwiIHNheXNcbiAqIG5vdGhpbmcuIE5vIG5vdW4gZW5jYXBzdWxhdGVzIFwidGhpcyBmaWxlLCBhdCB0aGlzIHBsYWNlXCIsIHNvIHRoZSBmaWxlIGdldHNcbiAqIGl0cyBvd24gbmFtZTogYG5vdGUubWRgLiBDb2xlOiBcInRoYXQncyBwcm9iYWJseSBjbG9zZXIgdG8gdGhlIHJpZ2h0IGFuc3dlclxuICogdmVyc3VzIHRyeWluZyB0byBjb21lIHVwIHdpdGggYSB3b3JkIHRoYXQgZW5jYXBzdWxhdGVzIGl0LlwiXG4gKlxuICogYGZpbGVgIGlzIHRoZSBkb2N1bWVudCdzIG5hbWUgd2hlbiB0aGUgY2FsbGVyIGtub3dzIGl0OyB3aXRob3V0IG9uZSB0aGlzXG4gKiBmYWxscyBiYWNrIHRvIGEgZ2VuZXJpYywgd2hpY2ggaXMgb25seSBmb3IgY29udGV4dHMgdGhhdCBoYXZlIG5vIGRvY3VtZW50IGluXG4gKiBoYW5kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2lkZU5hbWUoc2lkZTogRGlmZlNpZGUsIGZpbGU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoc2lkZSAhPT0gXCJvcmlnaW5hbFwiKSByZXR1cm4gYHYke3NpZGV9YDtcbiAgcmV0dXJuIGZpbGUgPz8gXCJ0aGUgc2F2ZWQgZmlsZVwiO1xufVxuIiwKICAgICIvKipcbiAqIE9LRiBmcm9udG1hdHRlciwgcmVhZCAoRTMyKS4gVGhlIGRhZW1vbiBwYXJzZXM7IHRoZSBzdXJmYWNlIHJlbmRlcnMgd2hhdCBpdFxuICogaXMgZ2l2ZW4g4oCUIGBCdW4uWUFNTC5wYXJzZWAgaXMgaGVyZSwgc28gbm8gWUFNTCBwYXJzZXIgcmVhY2hlcyB0aGUgYnJvd3Nlci5cbiAqXG4gKiDim5QgVEhFIFNQRUMnUyBURU1QRVIgSVMgVEhFIFBPSU5ULCBBTkQgSVQgSVMgTk9UIFRIRSBVU1VBTCBPTkUuIEEgY29uc3VtZXJcbiAqIFwiTVVTVCBOT1QgcmVqZWN0IGRvY3VtZW50c1wiIGZvciB1bmtub3duIHR5cGVzLCB1bmtub3duIGtleXMsIG1pc3Npbmcgb3B0aW9uYWxcbiAqIGZpZWxkcyBvciBicm9rZW4gbGlua3MsIGFuZCBcIlNIT1VMRCBwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4gKiAoT0tGIDAuMiDCpzExKS4gU28gbm90aGluZyBoZXJlIHZhbGlkYXRlczogYSBkb2N1bWVudCB3aG9zZSBmcm9udG1hdHRlciB3aWxsXG4gKiBub3QgcGFyc2Uga2VlcHMgaXRzIHRleHQgYW5kIHJlcG9ydHMgdGhlIHJlYXNvbiwgZXZlcnkga2V5IHN1cnZpdmVzIGluXG4gKiBgZmllbGRzYCB3aGV0aGVyIG9yIG5vdCB0aGlzIHNwZWxsIGhhcyBoZWFyZCBvZiBpdCwgYW5kIGB0eXBlYCDigJQgdGhlIE9ORVxuICogcmVxdWlyZWQgZmllbGQg4oCUIGJlaW5nIGFic2VudCBpcyBhIGZhY3QgdG8gc2hvdywgbmV2ZXIgYW4gZXJyb3IgdG8gcmFpc2UuXG4gKlxuICogVGhlIERFUklWRUQgdmFsdWVzICh0cnVzdCwgc3RhbGVuZXNzKSBhcmUgY29tcHV0ZWQgb24gcmVhZCBhbmQgbmV2ZXIgc3RvcmVkLFxuICogd2hpY2ggaXMgYWxzbyB0aGUgc3BlYydzIHJ1bGU6IGEgdHJ1c3QgdGllciB3cml0dGVuIGludG8gYSBmaWxlIHdvdWxkIGJlIGFcbiAqIGNsYWltIGFib3V0IGl0c2VsZi5cbiAqL1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhLCBEb2NTdW1tYXJ5LCBUcnVzdFRpZXIgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogQSBmcm9udG1hdHRlciBibG9jazogYC0tLWAgb24gaXRzIG93biBmaXJzdCBsaW5lLCB0byB0aGUgbmV4dCBgLS0tYCBsaW5lLiAqL1xuY29uc3QgQkxPQ0sgPSAvXi0tLVxccj9cXG4oW1xcc1xcU10qPylcXHI/XFxuLS0tWyBcXHRdKig/Olxccj9cXG58JCkvO1xuXG4vKipcbiAqIFNwbGl0IGEgZG9jdW1lbnQgaW50byBpdHMgcmF3IGZyb250bWF0dGVyIGJsb2NrIGFuZCB0aGUgYm9keSBiZW5lYXRoIGl0LlxuICogUHVyZSBzdHJpbmcgd29yaywgbm8gWUFNTCDigJQgdGhlIFNVUkZBQ0UgaGFzIHRoZSBzYW1lIGZ1bmN0aW9uIChpdCBtdXN0IHN0cmlwXG4gKiB0aGUgYmxvY2sgYmVmb3JlIHJlbmRlcmluZykgYW5kIGBmcm9udG1hdHRlci50ZXN0LnRzYCBob2xkcyB0aGUgdHdvIGVxdWFsLlxuICovXG4vKipcbiAqIEhvdyBtYW55IGxpbmVzIG9mIGEgZG9jdW1lbnQgY29tZSBCRUZPUkUgaXRzIGJvZHkg4oCUIHRoZSBmcm9udG1hdHRlciBibG9jayBhbmRcbiAqIGl0cyBkZWxpbWl0ZXJzLlxuICpcbiAqIOKblCBXSVRIT1VUIFRISVMgQSBSRVBPUlRFRCBMSU5FIE5VTUJFUiBJUyBBIExJRS4gTGlua3MgYXJlIGV4dHJhY3RlZCBmcm9tIHRoZVxuICogQk9EWSwgc28gYSBsaW5rIG9uIGJvZHkgbGluZSA5IG9mIGEgZG9jdW1lbnQgd2l0aCBmb3VyIGxpbmVzIG9mIGZyb250bWF0dGVyXG4gKiBpcyBvbiBGSUxFIGxpbmUgMTMg4oCUIGFuZCBhIHJlcG9ydCB0aGF0IHNheXMgOSBzZW5kcyB3aG9ldmVyIGlzIGZpeGluZyBpdCB0b1xuICogdGhlIHdyb25nIHBsYWNlLCBjb25maWRlbnRseS4gQ2F1Z2h0IHRoZSBtb21lbnQgRTU0J3MgcmVwb3J0IHdhcyBmaXJzdCByZWFkXG4gKiBhZ2FpbnN0IGEgZG9jdW1lbnQgdGhhdCBoYWQgZnJvbnRtYXR0ZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBib2R5TGluZU9mZnNldCh0ZXh0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB7IGJvZHkgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGNvbnN0IHByZWZpeCA9IHRleHQuc2xpY2UoMCwgdGV4dC5sZW5ndGggLSBib2R5Lmxlbmd0aCk7XG4gIGxldCBsaW5lcyA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcHJlZml4Lmxlbmd0aDsgaSsrKSBpZiAocHJlZml4LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBsaW5lcysrO1xuICByZXR1cm4gbGluZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdEZyb250bWF0dGVyKHRleHQ6IHN0cmluZyk6IHsgcmF3OiBzdHJpbmcgfCBudWxsOyBib2R5OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG0gPSBCTE9DSy5leGVjKHRleHQpO1xuICBpZiAoIW0pIHJldHVybiB7IHJhdzogbnVsbCwgYm9keTogdGV4dCB9O1xuICByZXR1cm4geyByYXc6IG1bMV0gPz8gXCJcIiwgYm9keTogdGV4dC5zbGljZShtWzBdLmxlbmd0aCkgfTtcbn1cblxuLyoqIE9LRidzIHRocmVlLCBhbmQgYW55dGhpbmcgZWxzZSBhIHByb2R1Y2VyIHdyb3RlLiBgc3RhYmxlYCBpcyB0aGUgZGVmYXVsdC4gKi9cbmZ1bmN0aW9uIHN0YXR1c09mKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuICBjb25zdCBzID0gZmllbGRzLnN0YXR1cztcbiAgcmV0dXJuIHR5cGVvZiBzID09PSBcInN0cmluZ1wiICYmIHMudHJpbSgpICE9PSBcIlwiID8gcyA6IFwic3RhYmxlXCI7XG59XG5cbmNvbnN0IGFzTGlzdCA9ICh2OiB1bmtub3duKTogc3RyaW5nW10gPT5cbiAgQXJyYXkuaXNBcnJheSh2KSA/IHYuZmlsdGVyKCh4KSA9PiB0eXBlb2YgeCA9PT0gXCJzdHJpbmdcIikgOiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IFt2XSA6IFtdO1xuXG4vKiogQW4gYWN0b3IgaXMgaHVtYW4gaWZmIGl0IGlzIHNwZWxsZWQgYGh1bWFuOjxpZD5gIOKAlCBPS0YgMC4yIMKnNidzIHJ1bGUuICovXG5jb25zdCBpc0h1bWFuID0gKGFjdG9yOiB1bmtub3duKTogYm9vbGVhbiA9PlxuICB0eXBlb2YgYWN0b3IgPT09IFwic3RyaW5nXCIgJiYgYWN0b3IudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKFwiaHVtYW46XCIpO1xuXG4vKipcbiAqIE9LRidzIHRydXN0IHRpZXJzLCBERVJJVkVEOiBubyBgdmVyaWZpZWRgIOKGkiB1bnZlcmlmaWVkOyB2ZXJpZmllZCBieSBtYWNoaW5lc1xuICogb25seSDihpIgbWFjaGluZS1jb25maXJtZWQ7IHZlcmlmaWVkIGJ5IGEgYGh1bWFuOjxpZD5gIOKGkiBodW1hbi1yZXZpZXdlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRydXN0VGllcihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogVHJ1c3RUaWVyIHtcbiAgY29uc3QgdmVyaWZpZWQgPSBmaWVsZHMudmVyaWZpZWQ7XG4gIGNvbnN0IGV2ZW50cyA9IEFycmF5LmlzQXJyYXkodmVyaWZpZWQpID8gdmVyaWZpZWQgOiB2ZXJpZmllZCA/IFt2ZXJpZmllZF0gOiBbXTtcbiAgaWYgKGV2ZW50cy5sZW5ndGggPT09IDApIHJldHVybiBcInVudmVyaWZpZWRcIjtcbiAgZm9yIChjb25zdCBlIG9mIGV2ZW50cylcbiAgICBpZiAoZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBpc0h1bWFuKChlIGFzIHsgYnk/OiB1bmtub3duIH0pLmJ5KSkgcmV0dXJuIFwiaHVtYW4tcmV2aWV3ZWRcIjtcbiAgcmV0dXJuIFwibWFjaGluZS1jb25maXJtZWRcIjtcbn1cblxuLyoqIGBzdGFsZV9hZnRlcmAgaXMgYW4gSU5TVEFOVCwgbm90IGEgVFRMOiBzdGFsZSB3aGVuIG5vdyA+PSBpdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N0YWxlKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG5vdzogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF0ID0gZmllbGRzLnN0YWxlX2FmdGVyO1xuICBjb25zdCB0ID1cbiAgICBhdCBpbnN0YW5jZW9mIERhdGUgPyBhdC5nZXRUaW1lKCkgOiB0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIgPyBEYXRlLnBhcnNlKGF0KSA6IE51bWJlci5OYU47XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgbm93ID49IHQ7XG59XG5cbi8qKiBXaGVuIHRoZSBjb250ZW50IGxhc3QgbWVhbmluZ2Z1bGx5IGNoYW5nZWQsIHBlciBgZ2VuZXJhdGVkLmF0YCwgYXMgYW4gSVNPIGRhdGUuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVkQXQoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBnID0gZmllbGRzLmdlbmVyYXRlZDtcbiAgY29uc3QgYXQgPSBnICYmIHR5cGVvZiBnID09PSBcIm9iamVjdFwiID8gKGcgYXMgeyBhdD86IHVua25vd24gfSkuYXQgOiB1bmRlZmluZWQ7XG4gIGlmIChhdCBpbnN0YW5jZW9mIERhdGUpIHJldHVybiBhdC50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgaWYgKHR5cGVvZiBhdCA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IHQgPSBEYXRlLnBhcnNlKGF0KTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpID8gbmV3IERhdGUodCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCkgOiBhdDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuY29uc3Qgc3RyID0gKHY6IHVua25vd24pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cbiAgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi50cmltKCkgIT09IFwiXCIgPyB2LnRyaW0oKSA6IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBSZWFkIGEgZG9jdW1lbnQncyBmcm9udG1hdHRlci4gUmV0dXJucyBudWxsIHdoZW4gdGhlcmUgaXMgbm8gYmxvY2sgYXQgYWxsIOKAlFxuICogd2hpY2ggaXMgYSBub3JtYWwgZG9jdW1lbnQsIG5vdCBhIGRlZmVjdC4gQSBibG9jayB0aGF0IHdpbGwgbm90IHBhcnNlIGNvbWVzXG4gKiBiYWNrIHdpdGggYGVycm9yYCBzZXQgYW5kIGV2ZXJ5IG90aGVyIGZpZWxkIGVtcHR5OiBzYWlkLCBub3Qgc3dhbGxvd2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZE1ldGEodGV4dDogc3RyaW5nLCBub3cgPSBEYXRlLm5vdygpKTogRG9jTWV0YSB8IG51bGwge1xuICBjb25zdCB7IHJhdyB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGxldCBmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGxldCBlcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEJ1bi5ZQU1MLnBhcnNlKHJhdykgYXMgdW5rbm93bjtcbiAgICBpZiAocGFyc2VkICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocGFyc2VkKSlcbiAgICAgIGZpZWxkcyA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBlbHNlIGlmIChwYXJzZWQgIT09IG51bGwgJiYgcGFyc2VkICE9PSB1bmRlZmluZWQpXG4gICAgICBlcnJvciA9IFwidGhlIGZyb250bWF0dGVyIGlzIG5vdCBhIG1hcHBpbmcgb2Yga2V5cyB0byB2YWx1ZXNcIjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGVycm9yID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlLnNwbGl0KFwiXFxuXCIpWzBdIDogU3RyaW5nKGUpO1xuICB9XG4gIHJldHVybiB7XG4gICAgcmF3LFxuICAgIGZpZWxkcyxcbiAgICB0eXBlOiBzdHIoZmllbGRzLnR5cGUpLFxuICAgIHRpdGxlOiBzdHIoZmllbGRzLnRpdGxlKSxcbiAgICBkZXNjcmlwdGlvbjogc3RyKGZpZWxkcy5kZXNjcmlwdGlvbiksXG4gICAgc3RhdHVzOiBzdGF0dXNPZihmaWVsZHMpLFxuICAgIHRhZ3M6IGFzTGlzdChmaWVsZHMudGFncyksXG4gICAgbGlmZWN5Y2xlOiBzdHIoZmllbGRzLmxpZmVjeWNsZSksXG4gICAgdHJ1c3Q6IHRydXN0VGllcihmaWVsZHMpLFxuICAgIHN0YWxlOiBpc1N0YWxlKGZpZWxkcywgbm93KSxcbiAgICBkYXRlOiBnZW5lcmF0ZWRBdChmaWVsZHMpLFxuICAgIC4uLihlcnJvciA/IHsgZXJyb3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIFRoZSBzbWFsbCBzaGFwZSB0aGUgc2lkZWJhciBuZWVkcyBmb3IgZXZlcnkgY29udGV4dCBkb2N1bWVudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemUobWV0YTogRG9jTWV0YSB8IG51bGwpOiBEb2NTdW1tYXJ5IHwgbnVsbCB7XG4gIGlmICghbWV0YSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgLi4uKG1ldGEudHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgLi4uKG1ldGEudGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSksXG4gICAgc3RhdHVzOiBtZXRhLnN0YXR1cyxcbiAgICB0YWdzOiBtZXRhLnRhZ3MsXG4gICAgdHJ1c3Q6IG1ldGEudHJ1c3QsXG4gICAgc3RhbGU6IG1ldGEuc3RhbGUsXG4gICAgLi4uKG1ldGEubGlmZWN5Y2xlID8geyBsaWZlY3ljbGU6IG1ldGEubGlmZWN5Y2xlIH0gOiB7fSksXG4gICAgLi4uKG1ldGEuZXJyb3IgPyB7IGVycm9yOiBtZXRhLmVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBwZG9jcydzIGZpbHRlciB2b2NhYnVsYXJ5LCBzbyB3aGF0IHRoZSBodW1hbiBsZWFybnMgdGhlcmUgaG9sZHMgaGVyZS4gKi9cbmV4cG9ydCB0eXBlIE1ldGFGaWx0ZXIgPSB7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgbGlmZWN5Y2xlPzogc3RyaW5nO1xuICB0YWc/OiBzdHJpbmc7XG4gIC8qKiBBbiBJU08gZGF0ZTsgbWF0Y2hlcyBkb2N1bWVudHMgd2hvc2UgYGdlbmVyYXRlZC5hdGAgaXMgb24gb3IgYWZ0ZXIgaXQuICovXG4gIHNpbmNlPzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBGaWx0ZXJzIGFyZSBBTkRlZCwgYW5kIGV2ZXJ5IG9uZSBpcyBvcHRpb25hbCDigJQgYSBiYXJlIGZpbHRlciBtYXRjaGVzIGFsbC5cbiAqXG4gKiDim5QgQSBET0NVTUVOVCBXSVRIIE5PIEZST05UTUFUVEVSIE1BVENIRVMgT05MWSBUSEUgRU1QVFkgRklMVEVSLCBhbmQgdGhhdFxuICogaW5jbHVkZXMgYC0tc3RhdHVzIHN0YWJsZWAuIEFic2VudCBgc3RhdHVzYCBkZWZhdWx0cyB0byBgc3RhYmxlYCBmb3IgYW4gT0tGXG4gKiBkb2N1bWVudCAowqc1KSwgYnV0IGEgZG9jdW1lbnQgd2l0aCBubyBibG9jayBhdCBhbGwgaXMgbm90IG1ha2luZyB0aGUgY2xhaW06XG4gKiBgZmluZCAtLXN0YXR1cyBzdGFibGVgIGFza3Mgd2hpY2ggZG9jdW1lbnRzIFNBWSB0aGV5IGFyZSBzdGFibGUsIGFuZCBhIGZpbGVcbiAqIHdpdGggbm8gZnJvbnRtYXR0ZXIgc2F5cyBub3RoaW5nLiBSZWFkaW5nIHRoZSBkZWZhdWx0IHRoZSBvdGhlciB3YXkgd291bGQgcHV0XG4gKiBldmVyeSB1bnRvdWNoZWQgbm90ZSBpbiB0aGUgcmVzdWx0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc0ZpbHRlcihtZXRhOiBEb2NNZXRhIHwgbnVsbCwgZmlsdGVyOiBNZXRhRmlsdGVyKTogYm9vbGVhbiB7XG4gIGlmIChtZXRhID09PSBudWxsKSByZXR1cm4gT2JqZWN0LnZhbHVlcyhmaWx0ZXIpLmV2ZXJ5KCh2KSA9PiB2ID09PSB1bmRlZmluZWQpO1xuICBpZiAoZmlsdGVyLnR5cGUgIT09IHVuZGVmaW5lZCAmJiBtZXRhLnR5cGUgIT09IGZpbHRlci50eXBlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc3RhdHVzICE9PSB1bmRlZmluZWQgJiYgbWV0YS5zdGF0dXMgIT09IGZpbHRlci5zdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5saWZlY3ljbGUgIT09IHVuZGVmaW5lZCAmJiBtZXRhLmxpZmVjeWNsZSAhPT0gZmlsdGVyLmxpZmVjeWNsZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnRhZyAhPT0gdW5kZWZpbmVkICYmICFtZXRhLnRhZ3MuaW5jbHVkZXMoZmlsdGVyLnRhZykpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5zaW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFtZXRhLmRhdGUpIHJldHVybiBmYWxzZTtcbiAgICBpZiAobWV0YS5kYXRlIDwgZmlsdGVyLnNpbmNlKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIOKUgOKUgCBXUklUSU5HIChFMzUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBFVkVSWSBXUklURSBIRVJFIElTIEEgVEVYVCBFRElULCBORVZFUiBBIFJFU0VSSUFMSVNBVElPTi4gUGFyc2luZyBhIGJsb2NrXG4vLyBhbmQgcHJpbnRpbmcgaXQgYmFjayByZW9yZGVycyBrZXlzLCBkcm9wcyBjb21tZW50cyBhbmQgY2hhbmdlcyBxdW90aW5nIOKAlCBhbmRcbi8vIHRoZSBzcGVjIGFza3MgYSBjb25zdW1lciB0byBcInByZXNlcnZlIHVua25vd24ga2V5cyB3aGVuIHJvdW5kLXRyaXBwaW5nXCJcbi8vICjCpzExKSwgd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgdGhhdCBsb3Nlcy4gU28gYSBuZXcgYmxvY2sgaXMgQlVJTFQgKHRoZXJlIGlzXG4vLyBub3RoaW5nIHRvIHByZXNlcnZlIHlldCkgYW5kIGFuIGV4aXN0aW5nIG9uZSBpcyBlZGl0ZWQgYSBMSU5FIGF0IGEgdGltZS5cblxuLyoqIFRoZSBkb2N1bWVudCdzIGZpcnN0IEgxLCB3aGljaCBpcyB0aGUgdGl0bGUgYSBodW1hbiBhbHJlYWR5IHdyb3RlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpdGxlRnJvbUJvZHkoYm9keTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGJvZHkuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtID0gL14jXFxzKyguKz8pXFxzKiQvLmV4ZWMobGluZSk7XG4gICAgaWYgKG0pIHJldHVybiBtWzFdO1xuICAgIGlmIChsaW5lLnRyaW0oKSAhPT0gXCJcIiAmJiAhbGluZS5zdGFydHNXaXRoKFwiI1wiKSkgYnJlYWs7IC8vIHByb3NlIGJlZm9yZSBhbnkgaGVhZGluZ1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogQSBgdHlwZWAgdG8gU1VHR0VTVCBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLlxuICpcbiAqIOKblCBGUk9NIFRIRSBORUlHSEJPVVJTLCBORVZFUiBGUk9NIEEgRklYRUQgTElTVC4gT0tGJ3MgYHR5cGVgIGlzIFwibm90XG4gKiBjZW50cmFsbHkgcmVnaXN0ZXJlZFwiIGFuZCBldmVyeSBjb3JwdXMgaW52ZW50cyBpdHMgb3duIOKAlCBgcmVwb3J0YCwgYHJ1bGVgLFxuICogYGFyY2hldHlwZWAgaW4gb25lLCBzb21ldGhpbmcgZWxzZSBpbiB0aGUgbmV4dCDigJQgc28gdGhlIG9ubHkgaG9uZXN0IHNvdXJjZSBpc1xuICogd2hhdCB0aGUgZG9jdW1lbnRzIGJlc2lkZSB0aGlzIG9uZSBhbHJlYWR5IHNheS4gVGhlIGZvbGRlcidzIG5hbWUgaXMgdGhlXG4gKiBmYWxsYmFjaywgYW5kIHdoZW4gbmVpdGhlciBhbnN3ZXJzLCBub3RoaW5nIGlzIHN1Z2dlc3RlZDogYSBibGFuayB0aGUgaHVtYW5cbiAqIGZpbGxzIGJlYXRzIGEgcGxhdXNpYmxlIGd1ZXNzIChTQ0hFTUEubWQncyBvd24gcnVsZSBhYm91dCBgZ2VuZXJhdGVkLmJ5YCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBndWVzc1R5cGUoc2libGluZ1R5cGVzOiByZWFkb25seSBzdHJpbmdbXSwgZm9sZGVyOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc2libGluZ1R5cGVzKSBpZiAodCkgY291bnRzLnNldCh0LCAoY291bnRzLmdldCh0KSA/PyAwKSArIDEpO1xuICBjb25zdCBiZXN0ID0gWy4uLmNvdW50cy5lbnRyaWVzKCldLnNvcnQoKGEsIGIpID0+IGJbMV0gLSBhWzFdIHx8IGFbMF0ubG9jYWxlQ29tcGFyZShiWzBdKSlbMF07XG4gIGlmIChiZXN0KSByZXR1cm4gYmVzdFswXTtcbiAgY29uc3QgbmFtZSA9IGZvbGRlci50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5hbWUgPT09IFwiXCIgfHwgbmFtZSA9PT0gXCIuXCIgfHwgbmFtZSA9PT0gXCIvXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIC8vIGBkZWNpc2lvbnMvYCDihpIgYGRlY2lzaW9uYDsgYGRvY3MvYCDihpIgYGRvY2AuIEEgcGx1cmFsIGZvbGRlciBuYW1lcyBpdHMga2luZC5cbiAgcmV0dXJuIG5hbWUuZW5kc1dpdGgoXCJpZXNcIilcbiAgICA/IGAke25hbWUuc2xpY2UoMCwgLTMpfXlgXG4gICAgOiBuYW1lLmVuZHNXaXRoKFwic1wiKVxuICAgICAgPyBuYW1lLnNsaWNlKDAsIC0xKVxuICAgICAgOiBuYW1lO1xufVxuXG4vKiogQSBZQU1MIHNjYWxhciwgcXVvdGVkIG9ubHkgd2hlbiBpdCBtdXN0IGJlLiAqL1xuZnVuY3Rpb24gc2NhbGFyKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bXFx3IC4sJycvQCstXSokLy50ZXN0KHZhbHVlKSAmJiAhL15cXHN8XFxzJC8udGVzdCh2YWx1ZSkgJiYgdmFsdWUgIT09IFwiXCJcbiAgICA/IHZhbHVlXG4gICAgOiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG59XG5cbmV4cG9ydCB0eXBlIE5ld01ldGEgPSB7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgc3RhdHVzPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIC8qKiBgZ2VuZXJhdGVkLmJ5YCDigJQgdGhlIGFjdG9yLCByZWNvcmRlZCBob25lc3RseSBvciBsZWZ0IGB1bmtub3duYC4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIGF0Pzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBBIGZyb250bWF0dGVyIGJsb2NrIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE9LRidzIHJlY29tbWVuZGVkIHNldCBpblxuICogdGhlIG9yZGVyIHRoZSBjb3Jwb3JhIHdyaXRlIGl0LCB3aXRoIGBkZXNjcmlwdGlvbmAgbGVmdCBFTVBUWSBmb3IgdGhlIGF1dGhvcjpcbiAqIGEgb25lLWxpbmUgc3VtbWFyeSBub2JvZHkgd3JvdGUgaXMgd29yc2UgdGhhbiBhIGJsYW5rIHRoYXQgYXNrcyB0byBiZSBmaWxsZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEJsb2NrKG1ldGE6IE5ld01ldGEpOiBzdHJpbmcge1xuICBjb25zdCBhdCA9IG1ldGEuYXQgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgY29uc3QgbGluZXMgPSBbXG4gICAgYHR5cGU6ICR7c2NhbGFyKG1ldGEudHlwZSA/PyBcIlwiKX1gLFxuICAgIGB0aXRsZTogJHtzY2FsYXIobWV0YS50aXRsZSA/PyBcIlwiKX1gLFxuICAgIGBkZXNjcmlwdGlvbjogJHttZXRhLmRlc2NyaXB0aW9uID8gc2NhbGFyKG1ldGEuZGVzY3JpcHRpb24pIDogXCJcIn1gLFxuICAgIGB0YWdzOiBbJHsobWV0YS50YWdzID8/IFtdKS5tYXAoc2NhbGFyKS5qb2luKFwiLCBcIil9XWAsXG4gICAgYHN0YXR1czogJHtzY2FsYXIobWV0YS5zdGF0dXMgPz8gXCJkcmFmdFwiKX1gLFxuICAgIGBnZW5lcmF0ZWQ6IHsgYnk6ICR7c2NhbGFyKG1ldGEuYnkgPz8gXCJ1bmtub3duXCIpfSwgYXQ6ICR7YXR9IH1gLFxuICBdO1xuICByZXR1cm4gYC0tLVxcbiR7bGluZXMuam9pbihcIlxcblwiKX1cXG4tLS1cXG5gO1xufVxuXG4vKipcbiAqIFB1dCBhIG5ldyBibG9jayBhdCB0aGUgdG9wIG9mIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS4gTm8gYmxhbmsgbGluZSBpc1xuICogaW5zZXJ0ZWQ6IHRoZSBjb3Jwb3JhIHdyaXRlIHRoZSBib2R5IGRpcmVjdGx5IHVuZGVyIHRoZSBjbG9zaW5nIGAtLS1gLCBhbmQgYVxuICogYmxvY2sgdGhhdCBhZGRzIG9uZSB3b3VsZCBzaG93IGFzIGEgZGlmZiBvbiBldmVyeSBkb2N1bWVudCBpdCB0b3VjaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEJsb2NrKHRleHQ6IHN0cmluZywgYmxvY2s6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtibG9ja30ke3RleHR9YDtcbn1cblxuLyoqXG4gKiBTZXQgb25lIGtleSBpbiBhbiBFWElTVElORyBibG9jaywgYXMgYSBsaW5lIGVkaXQ6IHRoZSBrZXkncyBsaW5lIGlzIHJlcGxhY2VkXG4gKiB3aGVyZSBpdCBleGlzdHMgYW5kIGFwcGVuZGVkIGJlZm9yZSB0aGUgY2xvc2luZyBgLS0tYCB3aGVyZSBpdCBkb2VzIG5vdC5cbiAqIEV2ZXJ5dGhpbmcgZWxzZSDigJQgb3JkZXIsIGNvbW1lbnRzLCBzcGFjaW5nLCBrZXlzIHRoaXMgc3BlbGwgbmV2ZXIgaGVhcmQgb2Yg4oCUXG4gKiBzdXJ2aXZlcyBieXRlIGZvciBieXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0S2V5KHRleHQ6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB7IHJhdyB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKFwidGhpcyBkb2N1bWVudCBoYXMgbm8gZnJvbnRtYXR0ZXIgYmxvY2tcIik7XG4gIGNvbnN0IGxpbmUgPSBgJHtrZXl9OiAke3NjYWxhcih2YWx1ZSl9YDtcbiAgY29uc3Qga2V5TGluZSA9IG5ldyBSZWdFeHAoYF4ke2tleS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIil9XFxcXHMqOmApO1xuICBjb25zdCBsaW5lcyA9IHJhdy5zcGxpdChcIlxcblwiKTtcbiAgY29uc3QgYXQgPSBsaW5lcy5maW5kSW5kZXgoKGwpID0+IGtleUxpbmUudGVzdChsKSk7XG4gIGlmIChhdCA9PT0gLTEpIGxpbmVzLnB1c2gobGluZSk7XG4gIGVsc2Uge1xuICAgIC8vIEEgbXVsdGktbGluZSB2YWx1ZSAoYSBmb2xkZWQgZGVzY3JpcHRpb24sIGEgbmVzdGVkIG1hcHBpbmcpIGlzIHRoZVxuICAgIC8vIGtleSdzIGxpbmUgUExVUyBldmVyeSBpbmRlbnRlZCBsaW5lIHVuZGVyIGl0OyBhbGwgb2YgdGhlbSBnby5cbiAgICBsZXQgZW5kID0gYXQgKyAxO1xuICAgIHdoaWxlIChlbmQgPCBsaW5lcy5sZW5ndGggJiYgL15cXHMrXFxTLy50ZXN0KGxpbmVzW2VuZF0gPz8gXCJcIikpIGVuZCsrO1xuICAgIGxpbmVzLnNwbGljZShhdCwgZW5kIC0gYXQsIGxpbmUpO1xuICB9XG4gIGNvbnN0IHJlYnVpbHQgPSBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKHJhdywgcmVidWlsdCk7XG59XG4iLAogICAgIi8qKlxuICogTGlua3MgYmV0d2VlbiBkb2N1bWVudHMgKEUzMyk6IHdoYXQgYSBkb2N1bWVudCBwb2ludHMgYXQsIGFuZCB3aGF0IHRoYXRcbiAqIHJlc29sdmVzIHRvIGluc2lkZSBhIHNldC5cbiAqXG4gKiDilIDilIAgRk9VUiBTT1VSQ0VTIE9GIEVER0VTLCBBTkQgVEhFWSBBUkUgTk9UIE9ORSBLSU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICAgMS4gbWFya2Rvd24gbGlua3MgICAgICBgW2xhYmVsXSguL290aGVyLm1kKWAgICAgICDigJQgYm9keVxuICogICAyLiB3aWtpIGxpbmtzICAgICAgICAgIGBbW290aGVyLWRvY3xsYWJlbF1dYCAgICAgIOKAlCBib2R5XG4gKiAgIDMuIGZyb250bWF0dGVyIHZhbHVlcyAgYHJlbGF0ZWQ6IFtjb25jZXB0L3hdYCAgICAg4oCUIGF1dGhvcmVkIGludGVudFxuICogICA0LiBgc291cmNlc1tdLnJlc291cmNlYCAgICAgICAgICAgICAgICAgICAgICAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqXG4gKiBwZG9jcyBrZWVwcyB0aGUgZnJvbnRtYXR0ZXIgZWRnZSBhbmQgdGhlIGJvZHktbGluayBlZGdlIEFQQVJUIChgcmVsYXRlZFtdYFxuICogYW5kIGBsaW5rc1tdYCBpbiBpdHMgYGJhY2tsaW5rc2Agb3V0cHV0KSwgYW5kIHRoZSBkaXN0aW5jdGlvbiBpcyByZWFsOiBhXG4gKiBgcmVsYXRlZGAga2V5IGlzIGEgY2xhaW0gdGhlIGF1dGhvciBtYWRlIGFib3V0IHRoZSBkb2N1bWVudCBhcyBhIHdob2xlLCBhXG4gKiBib2R5IGxpbmsgaXMgYSBjaXRhdGlvbiBhdCBhIHBsYWNlIGluIHRoZSBwcm9zZS4gVGhleSBzdGF5IGFwYXJ0IGhlcmUgdG9vLlxuICpcbiAqIOKUgOKUgCBUWVBFRCBMSU5LUyAoT3BlcmF0b3IncyBzaGFwZSwgQ29sZSAyMDI2LTA5LTExKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBBIHJlbGF0aW9uIHJpZGVzIHRoZSBsaW5rIGFzIGEgcXVlcnk6IGBbbGFiZWxdKC4vb3RoZXIubWQ/cmVsPWV4dGVuZHMpYCxcbiAqIGBbW290aGVyP3JlbD1zdXBlcnNlZGVzfGxhYmVsXV1gLiBDb3BpZWQgZXhhY3RseSBmcm9tIE9wZXJhdG9yJ3MgcGFyc2VyXG4gKiAoYHBhY2thZ2VzL3NoYXJlZC9zcmMvbGlua3MvYCk6IG9uZSBsaW5rIGNhcnJpZXMgQUxMIG9mIGl0cyByZWxzLCB0aGV5IGFyZVxuICogbm9ybWFsaXNlZCAobG93ZXJjYXNlZCwgdHJpbW1lZCwgZGVkdXBlZCwgZmlyc3QtYXV0aG9yZWQgb3JkZXIga2VwdCkgYnV0XG4gKiB0aGVpciBTUEVMTElORyBpcyBub3QgY2Fub25pY2FsaXNlZCwgYW5kICoqYSBiYXJlIGxpbmsgaXMgYFtdYCDigJQgdGhlIEFCU0VOQ0VcbiAqIG9mIGFuIGFzc2VydGlvbiwgbm90IGFuIGltcGxpY2l0IGByZWZlcmVuY2VzYCoqLiBBIGdyYXBoIG11c3Qgbm90IGRyYXcgYVxuICogY2xhaW0gbm9ib2R5IG1hZGUuXG4gKlxuICog4pSA4pSAIFdIQVQgQSBCVU5ETEUgSVMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogT0tGJ3MgYnVuZGxlLXJlbGF0aXZlIGZvcm0gKGAvY29uY2VwdHMveC5tZGApIG1lYW5zIHRoZSBCVU5ETEUgcm9vdCwgbm90IHRoZVxuICogZmlsZXN5c3RlbSByb290LCBzbyBhIHJlc29sdmVyIG5lZWRzIGEgYnVuZGxlIGJlZm9yZSBpdCBjYW4gcmVzb2x2ZSBhbnl0aGluZzpcbiAqICoqYSBzZXQncyBlbnRyeSByb290IGlzIHRoZSBidW5kbGUqKiAoRTMzKS4gQSB0YXJnZXQgdGhhdCBlc2NhcGVzIGl0IGlzIG5vdCBhblxuICogZXJyb3Ig4oCUIHRoZSBzcGVjIHJlcXVpcmVzIHRvbGVyYXRpbmcgYnJva2VuIGxpbmtzIOKAlCBpdCBpcyBhbiBlZGdlIG1hcmtlZFxuICogYG91dHNpZGVgIG9yIGBtaXNzaW5nYCwgd2hpY2ggdGhlIHN1cmZhY2Ugb2ZmZXJzIHRvIGFkZCByYXRoZXIgdGhhbiBmb2xsb3cuXG4gKi9cbmltcG9ydCB7XG4gIGJhc2VuYW1lLFxuICBkaXJuYW1lLFxuICBleHRuYW1lLFxuICBqb2luLFxuICBub3JtYWxpemUsXG4gIHJlbGF0aXZlLFxuICByZXNvbHZlIGFzIHJlc29sdmVQYXRoLFxufSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IERvY01ldGEgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgdG9Qb3NpeCB9IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IHR5cGUgTGlua0tpbmQgPSBcIm1hcmtkb3duXCIgfCBcIndpa2lcIjtcblxuLyoqIE9uZSBsaW5rIGFzIHdyaXR0ZW4sIGJlZm9yZSBhbnl0aGluZyBpcyByZXNvbHZlZC4gKi9cbmV4cG9ydCB0eXBlIExpbmtSZWYgPSB7XG4gIGtpbmQ6IExpbmtLaW5kO1xuICAvKiogVGhlIHRhcmdldCBhcyBhdXRob3JlZCwgd2l0aCBpdHMgcXVlcnkgYW5kIGFuY2hvciBzdHJpcHBlZC4gKi9cbiAgdGFyZ2V0OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgdGFyZ2V0IEVYQUNUTFkgYXMgd3JpdHRlbiDigJQgcXVlcnksIGFuY2hvciwgcGVyY2VudC1lbmNvZGluZyBhbmQgYWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBXSEFUIE1BS0VTIEEgREFOR0xJTkcgTElOSyBGSVhBQkxFLiBgdGFyZ2V0YCBpcyB0aGUgcmVzb2x2ZWRcbiAgICogc2hhcGUsIHNvIGEgcmVwb3J0IGJ1aWx0IGZyb20gaXQgdGVsbHMgeW91IHRvIGxvb2sgZm9yIGBkZWVwLm1kYCB3aGVuIHRoZVxuICAgKiBkb2N1bWVudCBhY3R1YWxseSBzYXlzIGAuL21pc3NpbmcvZGVlcC5tZD9yZWw9eGAg4oCUIGEgc3RyaW5nIHRoYXQgaXMgbm90IGluXG4gICAqIHRoZSBmaWxlLiBXaG9ldmVyIChvciB3aGF0ZXZlcikgZ29lcyB0byByZXBhaXIgdGhlIGxpbmsgbmVlZHMgdGhlIHN0cmluZ1xuICAgKiB0aGF0IGlzIHRoZXJlLlxuICAgKi9cbiAgcmF3OiBzdHJpbmc7XG4gIC8qKiAxLWJhc2VkIGxpbmUgaW4gdGhlIGJvZHkgdGhlIGxpbmsgd2FzIHdyaXR0ZW4gb24sIGZvciB0aGUgc2FtZSByZWFzb24uICovXG4gIGxpbmU6IG51bWJlcjtcbiAgLyoqIFJlbGF0aW9ucyBmcm9tIGA/cmVsPWA7IEVNUFRZIG1lYW5zIG5vIGFzc2VydGlvbiwgbmV2ZXIgYHJlZmVyZW5jZXNgLiAqL1xuICByZWw6IHN0cmluZ1tdO1xuICBsYWJlbD86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZmVyZW5jZSBmb3VuZCBpbiBmcm9udG1hdHRlciwgd2l0aCB0aGUga2V5IHRoYXQgY2FycmllZCBpdC4gKi9cbmV4cG9ydCB0eXBlIEZpZWxkUmVmID0geyBrZXk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9O1xuXG5jb25zdCBGRU5DRV9MSU5FID0gL14oPzpgYGB8fn5+KS87XG5cbi8qKlxuICogU3RyaXAgZmVuY2VkIGNvZGUgYmxvY2tzLiBBIGRvY3VtZW50IGFib3V0IGxpbmtzIHF1b3RlcyBsaW5rIHN5bnRheCwgYW5kIHRoZVxuICogd2lraSB0aGlzIHdhcyBidWlsdCBhZ2FpbnN0IGRvZXMgZXhhY3RseSB0aGF0IOKAlCB3aXRob3V0IHRoaXMsIFNDSEVNQS5tZCdzXG4gKiBleGFtcGxlcyBiZWNvbWUgZWRnZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRob3V0RmVuY2VzKGJvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGZlbmNlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGJvZHkuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtID0gRkVOQ0VfTElORS5leGVjKGxpbmUpO1xuICAgIGlmIChmZW5jZSA9PT0gbnVsbCAmJiBtKSB7XG4gICAgICBmZW5jZSA9IG1bMF07XG4gICAgICBvdXQucHVzaChcIlwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoZmVuY2UgIT09IG51bGwpIHtcbiAgICAgIGlmIChtICYmIGxpbmUuc3RhcnRzV2l0aChmZW5jZSkpIGZlbmNlID0gbnVsbDtcbiAgICAgIG91dC5wdXNoKFwiXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIG91dC5wdXNoKGxpbmUpO1xuICB9XG4gIHJldHVybiBvdXQuam9pbihcIlxcblwiKTtcbn1cblxuLyoqIGA/cmVsPWEsYmAg4oaSIGBbXCJhXCIsXCJiXCJdYCwgbm9ybWFsaXNlZCB0aGUgd2F5IE9wZXJhdG9yIG5vcm1hbGlzZXMgdGhlbS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJlbChxdWVyeTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICBpZiAoIXF1ZXJ5KSByZXR1cm4gW107XG4gIGNvbnN0IG0gPSAvKD86XnxbPyZdKXJlbD0oW14mXSopLy5leGVjKHF1ZXJ5KTtcbiAgaWYgKCFtKSByZXR1cm4gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJhdyBvZiBkZWNvZGVVUklDb21wb25lbnQobVsxXSA/PyBcIlwiKS5zcGxpdChcIixcIikpIHtcbiAgICBjb25zdCByZWwgPSByYXcudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKHJlbCA9PT0gXCJcIiB8fCBzZWVuLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChyZWwpO1xuICAgIG91dC5wdXNoKHJlbCk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFNwbGl0IGEgd3JpdHRlbiB0YXJnZXQgaW50byBpdHMgcGF0aCwgaXRzIHF1ZXJ5IGFuZCBpdHMgYW5jaG9yLiAqL1xuLyoqXG4gKiBQZXJjZW50LWRlY29kaW5nLCB3aGljaCBhIG1hcmtkb3duIGxpbmsgdGFyZ2V0IGNhcnJpZXMgd2hlbmV2ZXIgdGhlIGZpbGUgaXRcbiAqIG5hbWVzIGhhcyBhIHNwYWNlIGluIGl0IOKAlCBgTWFyZW4ncyUyMEJha2VyeS5tZGAgKEU0OSkuXG4gKlxuICog4puUIElUIE1VU1QgTk9UIFRIUk9XLiBgZGVjb2RlVVJJQ29tcG9uZW50YCByZWplY3RzIGEgbG9uZSBgJWAsIGFuZCBhIGZpbGVcbiAqIGNhbGxlZCBgMTAwJSBkb25lLm1kYCBpcyBhIHBlcmZlY3RseSBvcmRpbmFyeSB0aGluZyB0byBsaW5rIHRvLiBBblxuICogdW5kZWNvZGFibGUgdGFyZ2V0IGlzIHJldHVybmVkIGFzIGl0IHN0YW5kczogd29yc3QgY2FzZSBpdCBmYWlscyB0byByZXNvbHZlLFxuICogd2hpY2ggaXMgdGhlIGJlaGF2aW91ciBiZWZvcmUgZGVjb2RpbmcgZXhpc3RlZCwgcmF0aGVyIHRoYW4gdGFraW5nIHRoZSBncmFwaFxuICogZG93biB3aXRoIGl0LlxuICovXG5mdW5jdGlvbiBkZWNvZGVQYXRoKHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFyYXcuaW5jbHVkZXMoXCIlXCIpKSByZXR1cm4gcmF3O1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHJhdztcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRUYXJnZXQocmF3OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgcXVlcnk/OiBzdHJpbmc7IGFuY2hvcj86IHN0cmluZyB9IHtcbiAgY29uc3QgaGFzaCA9IHJhdy5pbmRleE9mKFwiI1wiKTtcbiAgY29uc3Qgd2l0aG91dEFuY2hvciA9IGhhc2ggPT09IC0xID8gcmF3IDogcmF3LnNsaWNlKDAsIGhhc2gpO1xuICBjb25zdCBhbmNob3IgPSBoYXNoID09PSAtMSA/IHVuZGVmaW5lZCA6IHJhdy5zbGljZShoYXNoICsgMSk7XG4gIGNvbnN0IHEgPSB3aXRob3V0QW5jaG9yLmluZGV4T2YoXCI/XCIpO1xuICByZXR1cm4ge1xuICAgIHBhdGg6IGRlY29kZVBhdGgoKHEgPT09IC0xID8gd2l0aG91dEFuY2hvciA6IHdpdGhvdXRBbmNob3Iuc2xpY2UoMCwgcSkpLnRyaW0oKSksXG4gICAgLi4uKHEgPT09IC0xID8ge30gOiB7IHF1ZXJ5OiB3aXRob3V0QW5jaG9yLnNsaWNlKHEgKyAxKSB9KSxcbiAgICAuLi4oYW5jaG9yID8geyBhbmNob3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuY29uc3QgRVhURVJOQUwgPSAvXlthLXpdW2EtejAtOSsuLV0qOi9pO1xuY29uc3QgTURfTElOSyA9IC8oIT8pXFxbKFteXFxdXFxuXSopXFxdXFwoKFteKVxcc10rKSg/OlxccytcIlteXCJdKlwiKT9cXCkvZztcbmNvbnN0IFdJS0lfTElOSyA9IC9cXFtcXFsoW15cXF1cXG5dKylcXF1cXF0vZztcblxuLyoqIEV2ZXJ5IGxpbmsgYSBkb2N1bWVudCdzIEJPRFkgcG9pbnRzIGF0IOKAlCBleHRlcm5hbCB0YXJnZXRzIGFuZCBpbWFnZXMgbGVmdCBvdXQuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdExpbmtzKGJvZHk6IHN0cmluZyk6IExpbmtSZWZbXSB7XG4gIGNvbnN0IHRleHQgPSB3aXRob3V0RmVuY2VzKGJvZHkpO1xuICBjb25zdCBvdXQ6IExpbmtSZWZbXSA9IFtdO1xuICAvLyDimqAgTElORSBOVU1CRVJTIFNVUlZJVkUgYHdpdGhvdXRGZW5jZXNgIEFORCBPRkZTRVRTIERPIE5PVDogaXQgYmxhbmtzIGVhY2hcbiAgLy8gZmVuY2VkIGxpbmUgcmF0aGVyIHRoYW4gZGVsZXRpbmcgaXQsIHNvIHRoZSBsaW5lIENPVU5UIGlzIHByZXNlcnZlZCB3aGlsZVxuICAvLyB0aGUgY2hhcmFjdGVyIG9mZnNldHMgYXJlIG5vdC4gQ291bnRpbmcgbmV3bGluZXMgaXMgdGhlcmVmb3JlIHNvdW5kOyB1c2luZ1xuICAvLyBgbS5pbmRleGAgYXMgYSBjaGFyYWN0ZXIgcG9zaXRpb24gaW4gdGhlIG9yaWdpbmFsIGJvZHkgd291bGQgbm90IGJlLlxuICBjb25zdCBsaW5lQXQgPSAoYXQ6IG51bWJlcikgPT4ge1xuICAgIGxldCBsaW5lID0gMTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGF0ICYmIGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSBpZiAodGV4dC5jaGFyQ29kZUF0KGkpID09PSAxMCkgbGluZSsrO1xuICAgIHJldHVybiBsaW5lO1xuICB9O1xuICBmb3IgKGNvbnN0IG0gb2YgdGV4dC5tYXRjaEFsbChNRF9MSU5LKSkge1xuICAgIGlmIChtWzFdID09PSBcIiFcIikgY29udGludWU7IC8vIGFuIGltYWdlIGlzIG5vdCBhIGRvY3VtZW50IGxpbmtcbiAgICBjb25zdCByYXcgPSBtWzNdID8/IFwiXCI7XG4gICAgaWYgKEVYVEVSTkFMLnRlc3QocmF3KSB8fCByYXcuc3RhcnRzV2l0aChcIiNcIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHJhdyk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwibWFya2Rvd25cIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJhdyxcbiAgICAgIGxpbmU6IGxpbmVBdChtLmluZGV4ID8/IDApLFxuICAgICAgcmVsOiBwYXJzZVJlbChxdWVyeSksXG4gICAgICAuLi4obVsyXSA/IHsgbGFiZWw6IG1bMl0gfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuICBmb3IgKGNvbnN0IG0gb2YgdGV4dC5tYXRjaEFsbChXSUtJX0xJTkspKSB7XG4gICAgY29uc3QgaW5uZXIgPSBtWzFdID8/IFwiXCI7XG4gICAgY29uc3QgcGlwZSA9IGlubmVyLmluZGV4T2YoXCJ8XCIpO1xuICAgIGNvbnN0IHRhcmdldFBhcnQgPSBwaXBlID09PSAtMSA/IGlubmVyIDogaW5uZXIuc2xpY2UoMCwgcGlwZSk7XG4gICAgY29uc3QgbGFiZWwgPSBwaXBlID09PSAtMSA/IHVuZGVmaW5lZCA6IGlubmVyLnNsaWNlKHBpcGUgKyAxKS50cmltKCk7XG4gICAgY29uc3QgeyBwYXRoLCBxdWVyeSB9ID0gc3BsaXRUYXJnZXQodGFyZ2V0UGFydCk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwid2lraVwiLFxuICAgICAgdGFyZ2V0OiBwYXRoLFxuICAgICAgcmF3OiB0YXJnZXRQYXJ0LFxuICAgICAgbGluZTogbGluZUF0KG0uaW5kZXggPz8gMCksXG4gICAgICByZWw6IHBhcnNlUmVsKHF1ZXJ5KSxcbiAgICAgIC4uLihsYWJlbCA/IHsgbGFiZWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogRG9lcyB0aGlzIGZyb250bWF0dGVyIHZhbHVlIExPT0sgbGlrZSBhIGRvY3VtZW50IHJlZmVyZW5jZT8gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb29rc0xpa2VSZWYodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHYgPSB2YWx1ZS50cmltKCk7XG4gIGlmICh2ID09PSBcIlwiIHx8IEVYVEVSTkFMLnRlc3QodikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHYuaW5jbHVkZXMoXCIvXCIpIHx8IHYudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5tZFwiKTtcbn1cblxuLyoqXG4gKiBSZWZlcmVuY2VzIGluc2lkZSBmcm9udG1hdHRlciwgd2hhdGV2ZXIga2V5IGNhcnJpZXMgdGhlbSDigJQgYHJlbGF0ZWRgLFxuICogYHN1cGVyc2VkZXNgLCBgc291cmNlc1tdLnJlc291cmNlYCwgb3IgYSBrZXkgaW52ZW50ZWQgdG9tb3Jyb3cuIFRoZSBTSEFQRVxuICogZGVjaWRlcyAoYSBzbGFzaCBvciBhIGAubWRgKSwgd2hpY2ggaXMgd2h5IGJhcmUgYHRhZ3NgIGFyZSBub3QgcmVmZXJlbmNlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpZWxkUmVmcyhmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBtYXhEZXB0aCA9IDQpOiBGaWVsZFJlZltdIHtcbiAgY29uc3Qgb3V0OiBGaWVsZFJlZltdID0gW107XG4gIGNvbnN0IHdhbGsgPSAoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBkZXB0aDogbnVtYmVyKSA9PiB7XG4gICAgaWYgKGRlcHRoID4gbWF4RGVwdGgpIHJldHVybjtcbiAgICBpZiAobG9va3NMaWtlUmVmKHZhbHVlKSkgb3V0LnB1c2goeyBrZXksIHZhbHVlOiB2YWx1ZS50cmltKCkgfSk7XG4gICAgZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIGZvciAoY29uc3QgdiBvZiB2YWx1ZSkgd2FsayhrZXksIHYsIGRlcHRoICsgMSk7XG4gICAgZWxzZSBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiKVxuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKVxuICAgICAgICB3YWxrKGAke2tleX0uJHtrfWAsIHYsIGRlcHRoICsgMSk7XG4gIH07XG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGZpZWxkcykpIHdhbGsoaywgdiwgMCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGVyZSBhIHRhcmdldCBsYW5kZWQuIGBvdXRzaWRlYCBleGlzdHMgb24gZGlzayBidXQgbm90IGluIHRoaXMgYnVuZGxlLiAqL1xuZXhwb3J0IHR5cGUgUmVzb2x1dGlvbiA9XG4gIHwgeyBzdGF0ZTogXCJpbi1idW5kbGVcIjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiBcIm91dHNpZGVcIjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiBcIm1pc3NpbmdcIjsgdHJpZWQ6IHN0cmluZyB9O1xuXG5leHBvcnQgdHlwZSBCdW5kbGVJbmRleCA9IHtcbiAgLyoqIFRoZSBzZXQncyByb290IOKAlCBPS0YncyBidW5kbGUsIGFuZCB3aGF0IGEgYC9gLXRhcmdldCBpcyByZWxhdGl2ZSB0by4gKi9cbiAgcm9vdDogc3RyaW5nO1xuICAvKiogQWJzb2x1dGUgcGF0aHMgb2YgZXZlcnkgZG9jdW1lbnQgaW4gdGhlIGJ1bmRsZS4gKi9cbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogQSBkb2N1bWVudCdzIHBhcnNlZCBmcm9udG1hdHRlciwgZm9yIGB0eXBlL3NsdWdgIHJlc29sdXRpb24uICovXG4gIG1ldGFPZjogKHBhdGg6IHN0cmluZykgPT4gRG9jTWV0YSB8IG51bGw7XG4gIC8qKiBEb2VzIHRoaXMgcGF0aCBleGlzdCBvbiBkaXNrPyAoSW5qZWN0ZWQsIHNvIHRoZSByZXNvbHZlciBzdGF5cyBwdXJlLikgKi9cbiAgZXhpc3RzOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xuICAvKipcbiAgICogVGhlIGdpdCB3b3JraW5nIHRyZWUgdGhlIGJ1bmRsZSBzaXRzIGluLCB3aGVuIHRoZXJlIGlzIG9uZS4gQSB0aGlyZCBwbGFjZVxuICAgKiBhbiB1bmFuY2hvcmVkIHBhdGggaXMgdHJpZWQ6IHBkb2NzIHdyaXRlcyByZXBvLXJlbGF0aXZlIHBhdGhzXG4gICAqIChgZG9jcy9wbGF5Ym9va3MvZm9vLm1kYCkgYW5kIHRoZSB3aWtpJ3MgcnVsZSBwYWdlcyBjYXJyeSByZXBvLXJlbGF0aXZlXG4gICAqIGBjaGVja2VyOmAgdmFsdWVzLCBhbmQgbmVpdGhlciByZXNvbHZlcyBmcm9tIHRoZSBkb2N1bWVudCBvciB0aGUgYnVuZGxlLlxuICAgKi9cbiAgcmVwb1Jvb3Q/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuY29uc3Qgc3RlbSA9IChwOiBzdHJpbmcpID0+IGJhc2VuYW1lKHAsIGV4dG5hbWUocCkpO1xuXG4vKipcbiAqIFJlc29sdmUgb25lIHdyaXR0ZW4gdGFyZ2V0IGFnYWluc3QgdGhlIGJ1bmRsZS5cbiAqXG4gKiBGb3VyIGZvcm1zLCBpbiBvcmRlcjogYSBidW5kbGUtcmVsYXRpdmUgcGF0aCAoYC94L3kubWRgKSwgYSByZWxhdGl2ZSBwYXRoXG4gKiAoYC4veS5tZGAsIGAuLi94L3kubWRgKSwgYSBgdHlwZS9zbHVnYCBrZXkg4oCUIHBkb2NzJyBhbmQgdGhlIHdpa2kncyBvd24gZm9ybSxcbiAqIHdoaWNoIHJlc29sdmVzIGJ5IFRZUEUgYW5kIEJBU0VOQU1FIHNvIGEgcGFnZSBjYW4gbW92ZSBmb2xkZXJzIHdpdGhvdXRcbiAqIGJyZWFraW5nIGluYm91bmQgcmVmZXJlbmNlcyDigJQgYW5kIGEgYmFyZSBuYW1lIChhIHdpa2kgbGluayksIGJ5IGJhc2VuYW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRhcmdldChyYXdUYXJnZXQ6IHN0cmluZywgZnJvbTogc3RyaW5nLCBpbmRleDogQnVuZGxlSW5kZXgpOiBSZXNvbHV0aW9uIHtcbiAgLy8g4puUIFNQTElUIEZJUlNULCBCRUNBVVNFIFRIRSBDQUxMRVJTIERJU0FHUkVFIEFCT1VUIFdIQVQgVEhFWSBIQU5EIE9WRVIuXG4gIC8vIGBleHRyYWN0TGlua3NgIHNwbGl0cyBhIHRhcmdldCBiZWZvcmUgaXQgZXZlciBnZXRzIGhlcmUgKEU0OSksIGJ1dCB0aGVcbiAgLy8gQ0xJQ0sgcGF0aCBkb2VzIG5vdDogYGxpbmsub3BlbmAgY2FycmllcyB0aGUgaHJlZiBleGFjdGx5IGFzIHRoZSBkb2N1bWVudFxuICAvLyB3cm90ZSBpdC4gU28gYW4gT3BlcmF0b3IgdHlwZWQgbGluayDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWQ/cmVsPWxvY2F0ZWQtaW5gXG4gIC8vIOKAlCBhcnJpdmVkIHdpdGggaXRzIHF1ZXJ5IGFuZCBpdHMgZW5jb2RpbmcgaW50YWN0LCBgZXh0bmFtZWAgcmVhZFxuICAvLyBgLm1kP3JlbD1sb2NhdGVkLWluYCwgYW5kIHRoZSBsb29rdXAgd2VudCBodW50aW5nIGZvciBhIGZpbGUgbmFtZWQgYWZ0ZXJcbiAgLy8gdGhlIHdob2xlIHN0cmluZy4gVGhlIEdSQVBIIGRyZXcgdGhhdCBlZGdlIGNvcnJlY3RseSB0aGUgZW50aXJlIHRpbWUsIHdoaWNoXG4gIC8vIGlzIHdoYXQgbWFkZSBpdCBwdXp6bGluZzogdGhlIHNhbWUgbGluayB3YXMgZmluZSBpbiB0aGUgbWFwIGFuZCBkZWFkIHVuZGVyXG4gIC8vIHRoZSBwb2ludGVyLiBTcGxpdHRpbmcgaGVyZSBmaXhlcyBldmVyeSBjYWxsZXIgYXQgb25jZSBhbmQgaXMgaWRlbXBvdGVudFxuICAvLyBmb3IgdGhlIHR3byB0aGF0IGhhZCBhbHJlYWR5IGRvbmUgaXQuIChDb2xlIGZvdW5kIGl0IGJ5IGNsaWNraW5nIG9uZSBpblxuICAvLyBIb2xsb3dicm9vaywgMjAyNi0wOS0xNC4pXG4gIGNvbnN0IHRhcmdldCA9IHNwbGl0VGFyZ2V0KHJhd1RhcmdldCkucGF0aDtcbiAgLy8g4puUIFdIQVQgTUFLRVMgQSBUQVJHRVQgQSBQQVRIIFJBVEhFUiBUSEFOIEEgS0VZLCBhbmQgdGhlIGNhc2UgdGhhdCB0YXVnaHRcbiAgLy8gaXQ6IGBbdGhlIGxpbnRlcl0obGludC50cylgIGluIHRoZSByZWFsIHdpa2kgaGFzIG5vIGAuL2AgYW5kIGlzIG5vdCBhIGAubWRgLFxuICAvLyBzbyBhIHJ1bGUga2V5ZWQgb24gdGhvc2UgdHdvIHJlYWQgaXQgYXMgYSBOQU1FIGFuZCByZXBvcnRlZCBpdCBtaXNzaW5nXG4gIC8vIHdoaWxlIHRoZSBmaWxlIHNhdCByaWdodCB0aGVyZS4gQSB0YXJnZXQgaXMgYSBwYXRoIHdoZW4gaXQgaXMgYW5jaG9yZWRcbiAgLy8gKGAvYCwgYC4vYCwgYC4uL2ApIG9yIGNhcnJpZXMgQU5ZIGV4dGVuc2lvbjsgYGNvbmNlcHQvZXhpdC1jb2Rlc2AgaGFzXG4gIC8vIG5laXRoZXIsIHdoaWNoIGlzIHdoYXQga2VlcHMgYSBgdHlwZS9zbHVnYCBrZXkgYSBrZXkuXG4gIGNvbnN0IGxvb2tzUGF0aCA9XG4gICAgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpIHx8XG4gICAgZXh0bmFtZSh0YXJnZXQpICE9PSBcIlwiO1xuICBpZiAobG9va3NQYXRoKSB7XG4gICAgLy8gQW4gVU5BTkNIT1JFRCBwYXRoIChgc3JjL2FjYy9raXQveC50c2AsIGByZXBvcnRzL2EubWRgIOKAlCBubyBgLi9gIGFuZCBub1xuICAgIC8vIGxlYWRpbmcgYC9gKSBpcyBhbWJpZ3VvdXM6IHJlbGF0aXZlIHRvIHRoZSBkb2N1bWVudCwgb3IgdG8gdGhlIGJ1bmRsZT9cbiAgICAvLyBCb3RoIGFyZSB0cmllZCwgZG9jdW1lbnQgZmlyc3QuIE1lYXN1cmVkIG9uIHRoZSByZWFsIHdpa2ksIHdoZXJlIGEgcnVsZVxuICAgIC8vIHBhZ2UncyBgY2hlY2tlcjogc3JjL2FjYy9raXQvY2hlY2tlcnMv4oCmYCB3YXMgcmVwb3J0ZWQgbWlzc2luZyB3aGlsZVxuICAgIC8vIHJlc29sdmluZyBmcm9tIHRoZSBidW5kbGUgcm9vdCB3b3VsZCBoYXZlIGZvdW5kIGl0LlxuICAgIGNvbnN0IGFuY2hvcmVkID0gdGFyZ2V0LnN0YXJ0c1dpdGgoXCIvXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHwgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuLi9cIik7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKVxuICAgICAgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSldXG4gICAgICA6IGFuY2hvcmVkXG4gICAgICAgID8gW25vcm1hbGl6ZShyZXNvbHZlUGF0aChkaXJuYW1lKGZyb20pLCB0YXJnZXQpKV1cbiAgICAgICAgOiBbXG4gICAgICAgICAgICBub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSksXG4gICAgICAgICAgICBub3JtYWxpemUoam9pbihpbmRleC5yb290LCB0YXJnZXQpKSxcbiAgICAgICAgICAgIC4uLihpbmRleC5yZXBvUm9vdCA/IFtub3JtYWxpemUoam9pbihpbmRleC5yZXBvUm9vdCwgdGFyZ2V0KSldIDogW10pLFxuICAgICAgICAgIF07XG4gICAgY29uc3QgdHJpZWQgPSBjYW5kaWRhdGVzLm1hcCgoYykgPT4gKGV4dG5hbWUoYykgPT09IFwiXCIgPyBgJHtjfS5tZGAgOiBjKSk7XG4gICAgZm9yIChjb25zdCBjIG9mIHRyaWVkKSBpZiAoaW5kZXgucGF0aHMuaW5jbHVkZXMoYykpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBjIH07XG4gICAgZm9yIChjb25zdCBjIG9mIHRyaWVkKSBpZiAoaW5kZXguZXhpc3RzKGMpKSByZXR1cm4geyBzdGF0ZTogXCJvdXRzaWRlXCIsIHBhdGg6IGMgfTtcbiAgICByZXR1cm4geyBzdGF0ZTogXCJtaXNzaW5nXCIsIHRyaWVkOiB0cmllZFswXSBhcyBzdHJpbmcgfTtcbiAgfVxuICBjb25zdCBzbGFzaCA9IHRhcmdldC5pbmRleE9mKFwiL1wiKTtcbiAgaWYgKHNsYXNoID4gMCkge1xuICAgIC8vIGB0eXBlL3NsdWdgOiB0aGUgdHlwZSBpcyBhIGNsYWltIHRoZSB0YXJnZXQncyBvd24gZnJvbnRtYXR0ZXIgbXVzdCBtYWtlLlxuICAgIGNvbnN0IHR5cGUgPSB0YXJnZXQuc2xpY2UoMCwgc2xhc2gpO1xuICAgIGNvbnN0IHNsdWcgPSB0YXJnZXQuc2xpY2Uoc2xhc2ggKyAxKTtcbiAgICBmb3IgKGNvbnN0IHAgb2YgaW5kZXgucGF0aHMpXG4gICAgICBpZiAoc3RlbShwKSA9PT0gc2x1ZyAmJiBpbmRleC5tZXRhT2YocCk/LnR5cGUgPT09IHR5cGUpXG4gICAgICAgIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBwIH07XG4gIH1cbiAgY29uc3QgaGl0ID0gaW5kZXgucGF0aHMuZmluZCgocCkgPT4gc3RlbShwKSA9PT0gc3RlbSh0YXJnZXQpKTtcbiAgaWYgKGhpdCkgcmV0dXJuIHsgc3RhdGU6IFwiaW4tYnVuZGxlXCIsIHBhdGg6IGhpdCB9O1xuICByZXR1cm4geyBzdGF0ZTogXCJtaXNzaW5nXCIsIHRyaWVkOiB0YXJnZXQgfTtcbn1cblxuLyoqIEFuIGVkZ2UgaW4gYSBzZXQncyBtYXAuIGByZWxgIGVtcHR5IG1lYW5zIG5vIGFzc2VydGlvbiB3YXMgbWFkZS4gKi9cbmV4cG9ydCB0eXBlIEVkZ2UgPSB7XG4gIGZyb206IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGggd2hlbiByZXNvbHZlZDsgdGhlIHdyaXR0ZW4gdGFyZ2V0IHdoZW4gbm90LiAqL1xuICB0bzogc3RyaW5nO1xuICAvKiogQSBib2R5IGxpbmssIG9yIGEgZnJvbnRtYXR0ZXIgdmFsdWUg4oCUIGtlcHQgYXBhcnQsIGFzIHBkb2NzIGtlZXBzIHRoZW0uICovXG4gIHNvdXJjZTogXCJsaW5rXCIgfCBcImZyb250bWF0dGVyXCI7XG4gIC8qKiBUaGUgZnJvbnRtYXR0ZXIga2V5IHRoYXQgY2FycmllZCBpdCAoYHJlbGF0ZWRgLCBgc291cmNlcy5yZXNvdXJjZWAsIOKApikuICovXG4gIGtleT86IHN0cmluZztcbiAgLyoqXG4gICAqIEZvciBhIEJPRFkgbGluazogdGhlIHRhcmdldCBhcyB3cml0dGVuLCBhbmQgdGhlIGxpbmUgaXQgaXMgb24uIEFic2VudCBmb3IgYVxuICAgKiBmcm9udG1hdHRlciByZWZlcmVuY2UsIHdoZXJlIGBrZXlgIGlzIHRoZSBhZGRyZXNzIGluc3RlYWQuXG4gICAqL1xuICByYXc/OiBzdHJpbmc7XG4gIGxpbmU/OiBudW1iZXI7XG4gIHJlbDogc3RyaW5nW107XG4gIHN0YXRlOiBSZXNvbHV0aW9uW1wic3RhdGVcIl07XG59O1xuXG5leHBvcnQgdHlwZSBHcmFwaE5vZGUgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgcmVsOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICBzdGFsZTogYm9vbGVhbjtcbiAgdGFnczogc3RyaW5nW107XG4gIGxpbmtzT3V0OiBudW1iZXI7XG4gIGxpbmtzSW46IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIEdyYXBoID0ge1xuICByb290OiBzdHJpbmc7XG4gIG5vZGVzOiBHcmFwaE5vZGVbXTtcbiAgZWRnZXM6IEVkZ2VbXTtcbiAgLyoqIFRhcmdldHMgbm90aGluZyBpbiB0aGUgYnVuZGxlIGFuc3dlcnMg4oCUIHNhaWQsIG5ldmVyIGFuIGVycm9yIChPS0YgwqcxMSkuICovXG4gIGRhbmdsaW5nOiBudW1iZXI7XG59O1xuXG4vKiogQnVpbGQgYSBzZXQncyBtYXA6IG5vZGVzIGFyZSBpdHMgZG9jdW1lbnRzLCBlZGdlcyBhcmUgdGhlIGZvdXIgc291cmNlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdyYXBoKGluZGV4OiBCdW5kbGVJbmRleCwgYm9keU9mOiAocGF0aDogc3RyaW5nKSA9PiBzdHJpbmcsIGNhcCA9IDQwMCk6IEdyYXBoIHtcbiAgY29uc3QgcGF0aHMgPSBpbmRleC5wYXRocy5zbGljZSgwLCBjYXApO1xuICBjb25zdCBlZGdlczogRWRnZVtdID0gW107XG4gIGZvciAoY29uc3QgZnJvbSBvZiBwYXRocykge1xuICAgIGNvbnN0IG1ldGEgPSBpbmRleC5tZXRhT2YoZnJvbSk7XG4gICAgZm9yIChjb25zdCBsaW5rIG9mIGV4dHJhY3RMaW5rcyhib2R5T2YoZnJvbSkpKSB7XG4gICAgICBjb25zdCByID0gcmVzb2x2ZVRhcmdldChsaW5rLnRhcmdldCwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJsaW5rXCIsXG4gICAgICAgIHJhdzogbGluay5yYXcsXG4gICAgICAgIGxpbmU6IGxpbmsubGluZSxcbiAgICAgICAgcmVsOiBsaW5rLnJlbCxcbiAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICB9KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCByZWYgb2YgbWV0YSA/IGZpZWxkUmVmcyhtZXRhLmZpZWxkcykgOiBbXSkge1xuICAgICAgY29uc3QgciA9IHJlc29sdmVUYXJnZXQocmVmLnZhbHVlLCBmcm9tLCBpbmRleCk7XG4gICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgZnJvbSxcbiAgICAgICAgdG86IHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8gci50cmllZCA6IHIucGF0aCxcbiAgICAgICAgc291cmNlOiBcImZyb250bWF0dGVyXCIsXG4gICAgICAgIGtleTogcmVmLmtleSxcbiAgICAgICAgcmVsOiBbXSxcbiAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgb3V0T2YgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBjb25zdCBpbnRvT2YgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2YgZWRnZXMpIHtcbiAgICBvdXRPZi5zZXQoZS5mcm9tLCAob3V0T2YuZ2V0KGUuZnJvbSkgPz8gMCkgKyAxKTtcbiAgICBpZiAoZS5zdGF0ZSA9PT0gXCJpbi1idW5kbGVcIikgaW50b09mLnNldChlLnRvLCAoaW50b09mLmdldChlLnRvKSA/PyAwKSArIDEpO1xuICB9XG4gIGNvbnN0IG5vZGVzOiBHcmFwaE5vZGVbXSA9IHBhdGhzLm1hcCgocGF0aCkgPT4ge1xuICAgIGNvbnN0IG1ldGEgPSBpbmRleC5tZXRhT2YocGF0aCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGgsXG4gICAgICByZWw6IHRvUG9zaXgocmVsYXRpdmUoaW5kZXgucm9vdCwgcGF0aCkpLFxuICAgICAgdGl0bGU6IG1ldGE/LnRpdGxlID8/IHN0ZW0ocGF0aCksXG4gICAgICAuLi4obWV0YT8udHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgICBzdGF0dXM6IG1ldGE/LnN0YXR1cyA/PyBcInN0YWJsZVwiLFxuICAgICAgc3RhbGU6IG1ldGE/LnN0YWxlID8/IGZhbHNlLFxuICAgICAgdGFnczogbWV0YT8udGFncyA/PyBbXSxcbiAgICAgIGxpbmtzT3V0OiBvdXRPZi5nZXQocGF0aCkgPz8gMCxcbiAgICAgIGxpbmtzSW46IGludG9PZi5nZXQocGF0aCkgPz8gMCxcbiAgICB9O1xuICB9KTtcbiAgcmV0dXJuIHtcbiAgICByb290OiBpbmRleC5yb290LFxuICAgIG5vZGVzLFxuICAgIGVkZ2VzLFxuICAgIGRhbmdsaW5nOiBlZGdlcy5maWx0ZXIoKGUpID0+IGUuc3RhdGUgPT09IFwibWlzc2luZ1wiKS5sZW5ndGgsXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogQ29udGV4dCBlbnRyaWVzIG9uIGRpc2sg4oCUIGJ1aWxkaW5nIGFuIGVudHJ5IGZyb20gYSBwYXRoIChFMTUncyBvbmUgbW9kZWwpLFxuICogbWlycm9yaW5nIGEgZm9sZGVyIGludG8gYSBub2RlIHRyZWUsIGFuZCBsaXN0aW5nIGEgZGlyZWN0b3J5IGZvciB0aGVcbiAqIHN1cmZhY2UncyBwYXRoIGNvbXBsZXRpb24gKGBmcy5saXN0YCkuXG4gKlxuICogUHVyZSBvdmVyIHRoZSBmaWxlc3lzdGVtOiBubyBkYWVtb24gc3RhdGUsIHNvIHRoZSB1bml0IGNlbGxzIGRyaXZlIGl0IHdpdGggYVxuICogdGVtcCBkaXJlY3RvcnkgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRleHRFbnRyeSwgQ29udGV4dE5vZGUsIEZzTGlzdEVudHJ5IH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIFdoYXQgc2NyaXB0b3JpdW0gb3BlbnMgYXMgYSBkb2N1bWVudC4gRXZlcnl0aGluZyBlbHNlIGlzIG5vdCBzaG93bi4gKi9cbmV4cG9ydCBjb25zdCBET0NfRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNEb2NOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIERPQ19FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSk7XG59XG5cbi8qKiBEaXJlY3RvcmllcyBhIG1pcnJvciBuZXZlciBkZXNjZW5kcyBpbnRvIOKAlCBub2lzZSwgbm90IGRvY3VtZW50cy4gKi9cbmNvbnN0IFNLSVBfRElSUyA9IG5ldyBTZXQoW1wibm9kZV9tb2R1bGVzXCIsIFwiLmdpdFwiLCBcImRpc3RcIiwgXCJvdXRcIiwgXCJjb3ZlcmFnZVwiXSk7XG5cbi8qKlxuICogVGhlIG1vc3Qgbm9kZXMgb25lIG1pcnJvcmVkIHNjYW4gd2lsbCBob2xkLiBBIGZvbGRlciBlbnRyeSBwb2ludGVkIGF0IGEgaHVnZVxuICogdHJlZSBtdXN0IG5vdCBzdGFsbCB0aGUgZGFlbW9uIG9yIGZsb29kIGV2ZXJ5IHN0YXRlIGJyb2FkY2FzdDsgaGl0dGluZyB0aGVcbiAqIGNhcCBzZXRzIGB0cnVuY2F0ZWRgIG9uIHRoZSBlbnRyeSBzbyB0aGUgc3VyZmFjZSBjYW4gU0FZIHRoZSBsaXN0IGlzIHNob3J0XG4gKiByYXRoZXIgdGhhbiByZW5kZXIgYSBzaG9ydCBsaXN0IGFzIGEgY29tcGxldGUgb25lLlxuICovXG5leHBvcnQgY29uc3QgTUlSUk9SX05PREVfQ0FQID0gMjAwMDtcblxuZXhwb3J0IGNvbnN0IHRvUG9zaXggPSAocDogc3RyaW5nKSA9PiBwLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG5cbi8qKlxuICogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuXG4gKiBgaGlkZGVuYCByZWxzIChFMjQncyBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIpIGFyZSBza2lwcGVkLCBhIGZvbGRlciB3aXRoXG4gKiBldmVyeXRoaW5nIHVuZGVyIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuICBoaWRkZW46IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4pOiB7IG5vZGVzOiBDb250ZXh0Tm9kZVtdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoaGlkZGVuKTtcbiAgY29uc3Qgd2FsayA9IChkaXI6IHN0cmluZyk6IENvbnRleHROb2RlW10gPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXBzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgY29uc3QgZG9jczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcy5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gY2FwKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKHJvb3QsIGFicykpO1xuICAgICAgaWYgKHNraXAuaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHdhbGsoYWJzKTtcbiAgICAgICAgLy8gQSBmb2xkZXIgaG9sZGluZyBvbmx5IG5vbi1kb2N1bWVudHMgKGltYWdlcywgYXNzZXRzKSBpcyBub2lzZSBpbiBhXG4gICAgICAgIC8vIGRvY3MgbWlycm9yIGFuZCBpcyBsZWZ0IG91dC4gQSBUUlVMWSBFTVBUWSBmb2xkZXIgaXMga2VwdDogaXQgaXMgb25lXG4gICAgICAgIC8vIHNvbWVib2R5IGp1c3QgbWFkZSB0byBwdXQgZG9jdW1lbnRzIGluIChcIk5ldyBmb2xkZXJcIiwgRTI0KSwgYW5kXG4gICAgICAgIC8vIGxlYXZpbmcgaXQgb3V0IG1hZGUgaXQgdmFuaXNoIHRoZSBtb21lbnQgaXQgd2FzIGNyZWF0ZWQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwIHx8IGlzRW1wdHlEaXIoYWJzKSkgZ3JvdXBzLnB1c2goeyBraW5kOiBcImdyb3VwXCIsIHJlbCwgY2hpbGRyZW4gfSk7XG4gICAgICB9IGVsc2UgaWYgKHN0LmlzRmlsZSgpICYmIGlzRG9jTmFtZShuYW1lKSkge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBkb2NzLnB1c2goeyBraW5kOiBcImRvY1wiLCByZWwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbLi4uZ3JvdXBzLCAuLi5kb2NzXTtcbiAgfTtcbiAgY29uc3Qgbm9kZXMgPSB3YWxrKHJvb3QpO1xuICByZXR1cm4geyBub2RlcywgdHJ1bmNhdGVkIH07XG59XG5cbi8qKiBOb3RoaW5nIGluIGl0IGJ1dCBkb3RmaWxlcyAoYSBgLkRTX1N0b3JlYCBkb2VzIG5vdCBtYWtlIGEgZm9sZGVyIGZ1bGwpLiAqL1xuZnVuY3Rpb24gaXNFbXB0eURpcihkaXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIpLmV2ZXJ5KChuKSA9PiBuLnN0YXJ0c1dpdGgoXCIuXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUaGUgbm9kZSBhdCBgcmVsYCBpbiBhIHRyZWUsIG9yIHVuZGVmaW5lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTm9kZShub2RlczogcmVhZG9ubHkgQ29udGV4dE5vZGVbXSwgcmVsOiBzdHJpbmcpOiBDb250ZXh0Tm9kZSB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgIGlmIChuLnJlbCA9PT0gcmVsKSByZXR1cm4gbjtcbiAgICBpZiAobi5raW5kID09PSBcImdyb3VwXCIgJiYgcmVsLnN0YXJ0c1dpdGgoYCR7bi5yZWx9L2ApKSByZXR1cm4gZmluZE5vZGUobi5jaGlsZHJlbiwgcmVsKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgY2xhc3MgUGF0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgY29kZTogXCJtaXNzaW5nXCIgfCBcIm5vdC1hLWRvY1wiLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG4vKipcbiAqIEFuIGVudHJ5IGZvciBhbiBhYnNvbHV0ZSBwYXRoLiBBIGRpcmVjdG9yeSBpcyBgbWlycm9yZWRgOyBhIGRvY3VtZW50IGZpbGUgaXNcbiAqIGBsaXN0ZWRgLCByb290ZWQgYXQgaXRzIHBhcmVudCwgaG9sZGluZyBvbmx5IGl0c2VsZiAoRTE1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudHJ5Rm9yUGF0aChhYnM6IHN0cmluZywgaWQ6IHN0cmluZyk6IENvbnRleHRFbnRyeSB7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHthYnN9YCwgXCJtaXNzaW5nXCIpO1xuICB9XG4gIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShhYnMpO1xuICAgIHJldHVybiB7XG4gICAgICBpZCxcbiAgICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpIHx8IGFicyxcbiAgICAgIHJvb3Q6IGFicyxcbiAgICAgIG1lbWJlcnNoaXA6IFwibWlycm9yZWRcIixcbiAgICAgIG5vZGVzLFxuICAgICAgLi4uKHRydW5jYXRlZCA/IHsgdHJ1bmNhdGVkIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzRG9jTmFtZShhYnMpKSB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihcbiAgICAgIGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2Fic31gLFxuICAgICAgXCJub3QtYS1kb2NcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbGFiZWw6IGJhc2VuYW1lKGFicyksXG4gICAgcm9vdDogZGlybmFtZShhYnMpLFxuICAgIG1lbWJlcnNoaXA6IFwibGlzdGVkXCIsXG4gICAgbm9kZXM6IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUoYWJzKSB9XSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGRvYyBub2RlJ3MgYWJzb2x1dGUgcGF0aCwgZGVwdGgtZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jUGF0aHMoZW50cnk6IENvbnRleHRFbnRyeSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKSA9PiB7XG4gICAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgICBpZiAobi5raW5kID09PSBcImRvY1wiKSBvdXQucHVzaChqb2luKGVudHJ5LnJvb3QsIG4ucmVsKSk7XG4gICAgICBlbHNlIHdhbGsobi5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuICB3YWxrKGVudHJ5Lm5vZGVzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoaWNoIGVudHJ5IChpZiBhbnkpIGhvbGRzIGBhYnNgLCBhbmQgYXQgd2hhdCBgcmVsYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhdGUoXG4gIGVudHJpZXM6IENvbnRleHRFbnRyeVtdLFxuICBhYnM6IHN0cmluZyxcbik6IHsgZW50cnlJZDogc3RyaW5nOyByZWw6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGRvY1BhdGhzKGUpLmluY2x1ZGVzKGFicykpIHJldHVybiB7IGVudHJ5SWQ6IGUuaWQsIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogT25lIGRpcmVjdG9yeSwgZm9yIHRoZSBzdXJmYWNlJ3MgYWRkLWJ5LXBhdGggY29tcGxldGlvbjogc3ViZGlyZWN0b3JpZXMgYW5kXG4gKiBkb2N1bWVudHMgb25seSwgZGlyZWN0b3JpZXMgZmlyc3QuIGB+YCBpcyBleHBhbmRlZCBieSB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdERpcihkaXI6IHN0cmluZyk6IEZzTGlzdEVudHJ5W10ge1xuICBjb25zdCBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gIGNvbnN0IG91dDogRnNMaXN0RW50cnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNEaXIgfHwgaXNEb2NOYW1lKG5hbWUpKSBvdXQucHVzaCh7IG5hbWUsIHBhdGg6IGFicywgZGlyOiBpc0RpciB9KTtcbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IChhLmRpciA9PT0gYi5kaXIgPyBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIDogYS5kaXIgPyAtMSA6IDEpKTtcbn1cbiIsCiAgICAiLy8gRmluZGluZyB0aGluZ3MgYWNyb3NzIGV2ZXJ5dGhpbmcgaW4gdGhlIGNvbnRleHQgKEU1OSkuXG4vL1xuLy8g4puUIFRXTyBNQVRDSEVSUywgT04gUFVSUE9TRSwgYmVjYXVzZSB0aGV5IGFuc3dlciBkaWZmZXJlbnQgcXVlc3Rpb25zLiBOb3RlXG4vLyBhcHBzIHNwbGl0IHRoZXNlIGFuZCBpdCBpcyBub3QgYW4gYWNjaWRlbnQ6IEZVWlpZIG9uIG5hbWVzIGlzIGZvciBqdW1waW5nXG4vLyAoXCJtYWJha1wiIOKGkiBNYXJlbidzIEJha2VyeSksIGFuZCBFWEFDVCBvbiBjb250ZW50IGlzIGZvciBmaW5kaW5nIChcIndoZXJlIGRpZCBJXG4vLyBzYXkgJ2Fza2luZy1uaWNlbHknXCIpLiBGdXp6eSBmdWxsLXRleHQgd291bGQgYmUgdGhlIHdvcnN0IG9mIGJvdGgg4oCUIHNlYXJjaGluZ1xuLy8gYGJyaWRnZWAgd291bGQgc3VyZmFjZSBkb2N1bWVudHMgdGhhdCBtZXJlbHkgY29udGFpbiBzaW1pbGFyLWxvb2tpbmcgbGV0dGVycyxcbi8vIGFuZCB5b3UgY291bGQgbm8gbG9uZ2VyIHRydXN0IFwidGhpcyBwaHJhc2UgaXMgb24gbGluZSAyOVwiLCB3aGljaCBpcyB0aGUgb25seVxuLy8gdGhpbmcgYSBjb250ZW50IHNlYXJjaCBpcyBmb3IuIChDb2xlIHJhaXNlZCBGdXNlIGZvciB0aGUgbmFtZSBoYWxmIGFuZCBjaG9zZVxuLy8gdGhlIGhhbmQtcm9sbGVkIHNjb3JlcjogdGhlcmUgaXMgbm8gc2Vjb25kIGVuZ2luZSB0aGlzIGhhcyB0byBhZ3JlZSB3aXRoLCBzb1xuLy8gZnV6enkgcmFua2luZyBpcyBhIHNlbGYtY29udGFpbmVkIHRhc3RlIGp1ZGdtZW50IHdpdGggbm8gZHJpZnQgcmlzay4pXG4vL1xuLy8g4pqgIEFORCBJVCBTRUFSQ0hFUyBXSEFUIFRIRSBIVU1BTiBJUyBMT09LSU5HIEFULCB3aGljaCBpcyBub3QgYWx3YXlzIHRoZSBmaWxlLlxuLy8gQSBkb2N1bWVudCBvcGVuIGluIHRoZSBzZXNzaW9uIGlzIHNob3duIGFzIGl0cyBBQ1RJVkUgVkVSU0lPTiwgd2hpY2ggbGl2ZXNcbi8vIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgcmF0aGVyIHRoYW4gYXQgdGhlIG9yaWdpbmFsIHBhdGgg4oCUIHNvIGFuIGVkaXQgbWFkZSB0d29cbi8vIG1pbnV0ZXMgYWdvIG11c3Qgc3RpbGwgYmUgZmluZGFibGUuIFRoYXQgYXN5bW1ldHJ5IGlzIGFsc28gdGhlIHJlYXNvbiB0aGlzXG4vLyBleGlzdHMgZm9yIHRoZSBBR0VOVCBhdCBhbGw6IGdyZXAgb3ZlciB0aGUgd29ya3NwYWNlIGZpbmRzIHRoZSBTQVZFRCBmaWxlIGFuZFxuLy8gc2lsZW50bHkgbWlzc2VzIHRoZSB2ZXJzaW9uIGJlaW5nIHJlYWQuIFRoZSBjYWxsZXIgc3VwcGxpZXMgdGhlIHRleHQgcGVyXG4vLyBkb2N1bWVudCBmb3IgZXhhY3RseSB0aGlzIHJlYXNvbiAoc2VlIGBTZXNzaW9uLnNlYXJjaEFsbGApLlxuXG4vKiogT25lIGxpbmUgdGhhdCBtYXRjaGVkLCB3aXRoIHRoZSBvZmZzZXRzIG9mIHRoZSBoaXQgaW5zaWRlIHRoZSBkb2N1bWVudC4gKi9cbmV4cG9ydCB0eXBlIEhpdCA9IHtcbiAgLyoqIDEtYmFzZWQsIHNvIGl0IGNhbiBiZSBzaG93biBhbmQgb3BlbmVkLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBUaGUgbGluZSwgZm9yIGNvbnRleHQgaW4gdGhlIHJlc3VsdCBsaXN0LiAqL1xuICB0ZXh0OiBzdHJpbmc7XG4gIC8qKiBPZmZzZXRzIG9mIHRoZSBtYXRjaCB3aXRoaW4gdGhlIGRvY3VtZW50LCBmb3IgcmV2ZWFsLWFuZC1zZWxlY3QuICovXG4gIGZyb206IG51bWJlcjtcbiAgdG86IG51bWJlcjtcbn07XG5cbi8qKlxuICogSG93IG11Y2ggb2YgYSBsaW5lIGlzIHdvcnRoIGNhcnJ5aW5nIGJhY2suIEEgcmVzdWx0IGxpc3QgaXMgYSBsaXN0LCBhbmQgYVxuICogZG9jdW1lbnQgd2l0aCBhIDQsMDAwLWNoYXJhY3RlciBwYXJhZ3JhcGggc2hvdWxkIG5vdCBzZW5kIGFsbCBvZiBpdCBwZXIgaGl0LlxuICovXG5jb25zdCBMSU5FX0NBUCA9IDI0MDtcblxuLyoqIEV2ZXJ5IG1hdGNoIG9mIGBxdWVyeWAgaW4gYHRleHRgLCBhdCBtb3N0IGBsaW1pdGAgb2YgdGhlbS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWFyY2hUZXh0KHRleHQ6IHN0cmluZywgcXVlcnk6IHN0cmluZywgbGltaXQgPSA1MCk6IEhpdFtdIHtcbiAgY29uc3QgbmVlZGxlID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuZWVkbGUgPT09IFwiXCIgfHwgbGltaXQgPD0gMCkgcmV0dXJuIFtdO1xuICBjb25zdCBoYXkgPSB0ZXh0LnRvTG93ZXJDYXNlKCk7XG4gIGxldCBhdCA9IGhheS5pbmRleE9mKG5lZWRsZSk7XG4gIGlmIChhdCA9PT0gLTEpIHJldHVybiBbXTtcbiAgLy8gTGluZSBzdGFydHMsIHdhbGtlZCBPTkNFLiBBIHBlci1oaXQgYGxhc3RJbmRleE9mKFwiXFxuXCIpYCBpcyBxdWFkcmF0aWMgb3ZlciBhXG4gIC8vIGRvY3VtZW50IHRoYXQgbWF0Y2hlcyBvbiBldmVyeSBsaW5lLCB3aGljaCBpcyBleGFjdGx5IHRoZSBkb2N1bWVudCBzb21lb25lXG4gIC8vIHNlYXJjaGVzIGZvciBhIGNvbW1vbiB3b3JkLlxuICBjb25zdCBzdGFydHM6IG51bWJlcltdID0gWzBdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpKyspIGlmICh0ZXh0LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBzdGFydHMucHVzaChpICsgMSk7XG4gIGNvbnN0IGhpdHM6IEhpdFtdID0gW107XG4gIGxldCBjdXJzb3IgPSAwO1xuICB3aGlsZSAoYXQgIT09IC0xICYmIGhpdHMubGVuZ3RoIDwgbGltaXQpIHtcbiAgICB3aGlsZSAoY3Vyc29yICsgMSA8IHN0YXJ0cy5sZW5ndGggJiYgKHN0YXJ0c1tjdXJzb3IgKyAxXSBhcyBudW1iZXIpIDw9IGF0KSBjdXJzb3IrKztcbiAgICBjb25zdCBsaW5lU3RhcnQgPSBzdGFydHNbY3Vyc29yXSBhcyBudW1iZXI7XG4gICAgY29uc3QgbGluZUVuZCA9IGN1cnNvciArIDEgPCBzdGFydHMubGVuZ3RoID8gKHN0YXJ0c1tjdXJzb3IgKyAxXSBhcyBudW1iZXIpIC0gMSA6IHRleHQubGVuZ3RoO1xuICAgIGNvbnN0IHdob2xlID0gdGV4dC5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpO1xuICAgIGhpdHMucHVzaCh7XG4gICAgICBsaW5lOiBjdXJzb3IgKyAxLFxuICAgICAgdGV4dDogd2hvbGUubGVuZ3RoID4gTElORV9DQVAgPyBgJHt3aG9sZS5zbGljZSgwLCBMSU5FX0NBUCAtIDEpfeKApmAgOiB3aG9sZSxcbiAgICAgIGZyb206IGF0LFxuICAgICAgdG86IGF0ICsgbmVlZGxlLmxlbmd0aCxcbiAgICB9KTtcbiAgICAvLyDimqAgQURWQU5DRSBQQVNUIFRIRSBNQVRDSCwgTk9UIFRIRSBMSU5FOiB0d28gaGl0cyBvbiBvbmUgbGluZSBhcmUgdHdvXG4gICAgLy8gaGl0cywgYW5kIHN0ZXBwaW5nIGJ5IGxpbmUgd291bGQgc2lsZW50bHkgZHJvcCB0aGUgc2Vjb25kLlxuICAgIGF0ID0gaGF5LmluZGV4T2YobmVlZGxlLCBhdCArIG5lZWRsZS5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBoaXRzO1xufVxuXG4vKiogSXMgdGhpcyBjaGFyYWN0ZXIgYSB3b3JkIGJvdW5kYXJ5IGZvciBzY29yaW5nIHB1cnBvc2VzPyAqL1xuZnVuY3Rpb24gaXNCb3VuZGFyeShjaDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBjaCA9PT0gXCIgXCIgfHwgY2ggPT09IFwiLVwiIHx8IGNoID09PSBcIl9cIiB8fCBjaCA9PT0gXCIvXCIgfHwgY2ggPT09IFwiLlwiIHx8IGNoID09PSBcIidcIjtcbn1cblxuLyoqXG4gKiBIb3cgd2VsbCBgbmFtZWAgbWF0Y2hlcyBgcXVlcnlgIGFzIGEgZnV6enkgc3Vic2VxdWVuY2Ug4oCUIGhpZ2hlciBpcyBiZXR0ZXIsXG4gKiBgbnVsbGAgd2hlbiB0aGUgcXVlcnkncyBjaGFyYWN0ZXJzIGRvIG5vdCBhcHBlYXIgaW4gb3JkZXIgYXQgYWxsLlxuICpcbiAqIFRoZSB3ZWlnaHRzIGVuY29kZSB3aGF0IHNvbWVvbmUgdHlwaW5nIGludG8gYSBqdW1wIGJveCBtZWFuczpcbiAqXG4gKiAtICoqY29udGlndWl0eSoqIGRvbWluYXRlcywgYmVjYXVzZSBgbWFyZWAgbWVhbmluZyBgTWFyZW5gIGlzIHRoZSBjb21tb24gY2FzZVxuICogICBhbmQgYG3igKZh4oCmcuKApmVgIHNjYXR0ZXJlZCB0aHJvdWdoIGEgc2VudGVuY2UgaXMgdGhlIHJhcmUgb25lO1xuICogLSAqKndvcmQgc3RhcnRzKiogc2NvcmUsIHNvIGBtYmAgZmluZHMgYE1hcmVuJ3MgQmFrZXJ5YCByYXRoZXIgdGhhbiBgTnVtYmVyYDtcbiAqIC0gKiplYXJsaWVyIGlzIGJldHRlcioqLCBhbmQgYSAqKnNob3J0ZXIgbmFtZSoqIHdpbnMgYSB0aWUsIGJlY2F1c2UgdGhlIHRoaW5nXG4gKiAgIHlvdSBtZWFudCBpcyB1c3VhbGx5IHRoZSB0aGluZyB3aXRoIGxlc3MgYXJvdW5kIGl0LlxuICpcbiAqIOKaoCBUSEUgTlVNQkVSUyBBUkUgVEFTVEUsIE5PVCBUUlVUSC4gVGhleSBhcmUgcGlubmVkIGJ5IGNlbGxzIHRoYXQgYXNzZXJ0XG4gKiBPUkRFUklOR1MgKFwidGhpcyBiZWF0cyB0aGF0XCIpIHJhdGhlciB0aGFuIHZhbHVlcywgc28gdGhleSBjYW4gYmUgcmV0dW5lZFxuICogd2l0aG91dCByZXdyaXRpbmcgdGhlIHRlc3RzIOKAlCB3aGljaCBpcyB0aGUgb25seSB3YXkgYSBzY29yZXIgbGlrZSB0aGlzIHN0YXlzXG4gKiBjaGFuZ2VhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NvcmVOYW1lKG5hbWU6IHN0cmluZywgcXVlcnk6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChxID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgaGF5ID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICBsZXQgc2NvcmUgPSAwO1xuICBsZXQgYXQgPSAwO1xuICBsZXQgcnVuID0gMDtcbiAgZm9yIChjb25zdCBjaCBvZiBxKSB7XG4gICAgY29uc3QgZm91bmQgPSBoYXkuaW5kZXhPZihjaCwgYXQpO1xuICAgIGlmIChmb3VuZCA9PT0gLTEpIHJldHVybiBudWxsO1xuICAgIHJ1biA9IGZvdW5kID09PSBhdCAmJiBhdCA+IDAgPyBydW4gKyAxIDogMDtcbiAgICBzY29yZSArPSAxMCArIHJ1biAqIDEyO1xuICAgIGlmIChmb3VuZCA9PT0gMCB8fCBpc0JvdW5kYXJ5KGhheVtmb3VuZCAtIDFdIGFzIHN0cmluZykpIHNjb3JlICs9IDE0O1xuICAgIC8vIERpc3RhbmNlIGZyb20gd2hlcmUgd2Ugd2VyZSBsb29raW5nIGNvc3RzLCBzbyBzY2F0dGVyZWQgbWF0Y2hlcyByYW5rIGxvdy5cbiAgICBzY29yZSAtPSBNYXRoLm1pbihmb3VuZCAtIGF0LCAxMik7XG4gICAgYXQgPSBmb3VuZCArIDE7XG4gIH1cbiAgLy8gQSB3aG9sZS13b3JkIHN1YnN0cmluZyBpcyB0aGUgc3Ryb25nZXN0IHNpZ25hbCB0aGVyZSBpczsgc2F5IHNvIGxvdWRseS5cbiAgaWYgKGhheS5pbmNsdWRlcyhxKSkgc2NvcmUgKz0gNDA7XG4gIGlmIChoYXkuc3RhcnRzV2l0aChxKSkgc2NvcmUgKz0gMjU7XG4gIC8vIFNob3J0ZXIgbmFtZXMgd2luIHRpZXMuXG4gIHNjb3JlIC09IE1hdGgubWluKG5hbWUubGVuZ3RoLCA0MCkgLyA0O1xuICByZXR1cm4gc2NvcmU7XG59XG5cbi8qKiBBIGRvY3VtZW50IHRoZSBOQU1FIG1hdGNoZWQuICovXG5leHBvcnQgdHlwZSBOYW1lTWF0Y2ggPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgc2NvcmU6IG51bWJlcjtcbn07XG5cbi8qKlxuICog4puUIFRIRSBTV0FQIFNFQU0gKENvbGUpOiBcImlmIHdlIGZpbmQgdGhhdCBhY3R1YWxseSB3ZSBzaG91bGQgdXNlIEZ1c2UsIGl0J3NcbiAqIGZhaXJseSBlYXN5IHRvIHJlcGxhY2UuXCJcbiAqXG4gKiBUaGUgaW50ZXJmYWNlIGlzIENPUlBVUy1TSEFQRUQg4oCUIHRha2UgdGhlIHdob2xlIGNhbmRpZGF0ZSBsaXN0IGFuZCBhIHF1ZXJ5LFxuICogcmV0dXJuIGEgcmFua2VkIHNsaWNlIOKAlCBhbmQgdGhhdCBzaGFwZSBpcyB0aGUgd2hvbGUgcG9pbnQuIEEgcGVyLWl0ZW1cbiAqIGBzY29yZShuYW1lLCBxdWVyeSlgIGhvb2sgd291bGQgaGF2ZSBsb29rZWQgbGlrZSB0aGUgc21hbGxlciBhYnN0cmFjdGlvbiBhbmRcbiAqIHdvdWxkIGhhdmUgRk9VR0hUIHRoZSB2ZXJ5IGxpYnJhcnkgaXQgZXhpc3RzIHRvIGFkbWl0OiBGdXNlIGluZGV4ZXMgYSBsaXN0XG4gKiBhbmQgc2VhcmNoZXMgaXQsIGl0IGRvZXMgbm90IHNjb3JlIG9uZSBzdHJpbmcgYXQgYSB0aW1lLiBXcml0dGVuIHRoaXMgd2F5LFxuICogbW92aW5nIHRvIEZ1c2UgaXMgYSBuZXcgZnVuY3Rpb24gYW5kIG9uZSBkZWZhdWx0IGNoYW5nZWQ6XG4gKlxuICogICAgIGNvbnN0IGZ1c2VOYW1lczogTmFtZVNlYXJjaCA9IChjYW5kaWRhdGVzLCBxdWVyeSwgbGltaXQpID0+IHtcbiAqICAgICAgIGNvbnN0IGZ1c2UgPSBuZXcgRnVzZShjYW5kaWRhdGVzLCB7IGtleXM6IFtcIm5hbWVcIiwgXCJ0aXRsZVwiXSwg4oCmIH0pO1xuICogICAgICAgcmV0dXJuIGZ1c2Uuc2VhcmNoKHF1ZXJ5LCB7IGxpbWl0IH0pLm1hcCjigKYpO1xuICogICAgIH07XG4gKlxuICogTm90aGluZyBlbHNlIGluIHRoaXMgbW9kdWxlLCB0aGUgc2Vzc2lvbiwgdGhlIHdpcmUgb3IgdGhlIHN1cmZhY2UgbW92ZXMuXG4gKi9cbmV4cG9ydCB0eXBlIE5hbWVTZWFyY2ggPSAoXG4gIGNhbmRpZGF0ZXM6IHJlYWRvbmx5IENhbmRpZGF0ZVtdLFxuICBxdWVyeTogc3RyaW5nLFxuICBsaW1pdDogbnVtYmVyLFxuKSA9PiBOYW1lTWF0Y2hbXTtcblxuLyoqIEEgZG9jdW1lbnQgdGhlIENPTlRFTlQgbWF0Y2hlZC4gKi9cbmV4cG9ydCB0eXBlIFRleHRNYXRjaCA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzbHVnPzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGhpdHM6IEhpdFtdO1xufTtcblxuZXhwb3J0IHR5cGUgU2VhcmNoUmVwb3J0ID0ge1xuICBxdWVyeTogc3RyaW5nO1xuICAvKiogTmFtZS90aXRsZSBtYXRjaGVzLCBiZXN0IGZpcnN0IOKAlCB0aGUganVtcCBsaXN0LiAqL1xuICBkb2N1bWVudHM6IE5hbWVNYXRjaFtdO1xuICAvKiogQ29udGVudCBtYXRjaGVzLCBpbiBjb250ZXh0IG9yZGVyIOKAlCB0aGUgZmluZCBsaXN0LiAqL1xuICB0ZXh0OiBUZXh0TWF0Y2hbXTtcbiAgLyoqIFRvdGFsIGNvbnRlbnQgaGl0cyByZXBvcnRlZC4gKi9cbiAgY291bnQ6IG51bWJlcjtcbiAgLyoqIFRydWUgd2hlbiBhIGNhcCBzdG9wcGVkIHRoZSBzZWFyY2ggZWFybHksIHNvIFwiM1wiIGFuZCBcIjMgb2YgbW9yZVwiIGRpZmZlci4gKi9cbiAgdHJ1bmNhdGVkOiBib29sZWFuO1xufTtcblxuLyoqIFBlci1kb2N1bWVudCBjb250ZW50IGNhcCwgc28gb25lIGVub3Jtb3VzIGRvY3VtZW50IGNhbm5vdCBmaWxsIHRoZSByZXBvcnQuICovXG5leHBvcnQgY29uc3QgUEVSX0RPQyA9IDIwO1xuLyoqIFdob2xlLXJlcG9ydCBjb250ZW50IGNhcC4gKi9cbmV4cG9ydCBjb25zdCBUT1RBTCA9IDIwMDtcbi8qKiBIb3cgbWFueSBuYW1lIG1hdGNoZXMgYXJlIHdvcnRoIHNob3dpbmcuICovXG5leHBvcnQgY29uc3QgTkFNRVMgPSAxMDtcblxuLyoqXG4gKiBUaGUgZGVmYXVsdCBgTmFtZVNlYXJjaGA6IGBzY29yZU5hbWVgIG92ZXIgZXZlcnkgY2FuZGlkYXRlLCByYW5rZWQuXG4gKlxuICogQSBkb2N1bWVudCdzIFRJVExFIGlzIG1hdGNoZWQgYXMgd2VsbCBhcyBpdHMgZmlsZW5hbWUg4oCUIGFuIE9LRiBkb2N1bWVudCdzXG4gKiBuYW1lIGFuZCB0aXRsZSBvZnRlbiBkaWZmZXIgYW5kIHRoZSBodW1hbiBtYXkgcmVtZW1iZXIgZWl0aGVyIOKAlCBhbmQgdGhlXG4gKiBiZXR0ZXIgb2YgdGhlIHR3byBzY29yZXMgaXMgdGhlIG9uZSB0aGF0IGNvdW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IHJhbmtOYW1lczogTmFtZVNlYXJjaCA9IChjYW5kaWRhdGVzLCBxdWVyeSwgbGltaXQpID0+IHtcbiAgY29uc3Qgb3V0OiBOYW1lTWF0Y2hbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGMgb2YgY2FuZGlkYXRlcykge1xuICAgIGNvbnN0IGJ5TmFtZSA9IHNjb3JlTmFtZShjLm5hbWUsIHF1ZXJ5KTtcbiAgICBjb25zdCBieVRpdGxlID0gYy50aXRsZSA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IHNjb3JlTmFtZShjLnRpdGxlLCBxdWVyeSk7XG4gICAgaWYgKGJ5TmFtZSA9PT0gbnVsbCAmJiBieVRpdGxlID09PSBudWxsKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBwYXRoOiBjLnBhdGgsXG4gICAgICAuLi4oYy5zbHVnICE9PSB1bmRlZmluZWQgPyB7IHNsdWc6IGMuc2x1ZyB9IDoge30pLFxuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgLi4uKGMudGl0bGUgIT09IHVuZGVmaW5lZCA/IHsgdGl0bGU6IGMudGl0bGUgfSA6IHt9KSxcbiAgICAgIHNjb3JlOiBNYXRoLm1heChieU5hbWUgPz8gLUluZmluaXR5LCBieVRpdGxlID8/IC1JbmZpbml0eSksXG4gICAgfSk7XG4gIH1cbiAgb3V0LnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlIHx8IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkpO1xuICByZXR1cm4gb3V0LnNsaWNlKDAsIGxpbWl0KTtcbn07XG5cbmV4cG9ydCB0eXBlIENhbmRpZGF0ZSA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIGJhc2VuYW1lLCB3aGljaCBpcyB3aGF0IGEgaHVtYW4gdHlwZXMgYXQuICovXG4gIG5hbWU6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBudW1iZXI7XG59O1xuXG4vKipcbiAqIFNlYXJjaCBhIGxpc3Qgb2YgY2FuZGlkYXRlcyBmb3IgYm90aCBraW5kcyBvZiBtYXRjaC5cbiAqXG4gKiBgcmVhZGAgbWF5IHRocm93IG9yIHJldHVybiBudWxsIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIGJlZW4gZGVsZXRlZCB1bmRlclxuICogdGhlIGNvbnRleHQg4oCUIGEgc2VhcmNoIGlzIG5vdCB0aGUgbW9tZW50IHRvIGZhaWwgb3ZlciB0aGF0LCBzbyBpdCBpcyBza2lwcGVkXG4gKiByYXRoZXIgdGhhbiByZXBvcnRlZCBhcyBhIGRvY3VtZW50IHdpdGggbm8gaGl0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlYXJjaERvY3VtZW50cyhcbiAgY2FuZGlkYXRlczogcmVhZG9ubHkgQ2FuZGlkYXRlW10sXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHJlYWQ6IChjOiBDYW5kaWRhdGUpID0+IHN0cmluZyB8IG51bGwsXG4gIGNhcHM6IHsgcGVyRG9jPzogbnVtYmVyOyB0b3RhbD86IG51bWJlcjsgbmFtZXM/OiBudW1iZXI7IG5hbWVTZWFyY2g/OiBOYW1lU2VhcmNoIH0gPSB7fSxcbik6IFNlYXJjaFJlcG9ydCB7XG4gIGNvbnN0IHEgPSBxdWVyeS50cmltKCk7XG4gIGlmIChxID09PSBcIlwiKSByZXR1cm4geyBxdWVyeTogXCJcIiwgZG9jdW1lbnRzOiBbXSwgdGV4dDogW10sIGNvdW50OiAwLCB0cnVuY2F0ZWQ6IGZhbHNlIH07XG4gIGNvbnN0IHBlckRvYyA9IGNhcHMucGVyRG9jID8/IFBFUl9ET0M7XG4gIGNvbnN0IHRvdGFsID0gY2Fwcy50b3RhbCA/PyBUT1RBTDtcbiAgY29uc3QgbmFtZXMgPSBjYXBzLm5hbWVzID8/IE5BTUVTO1xuXG4gIGNvbnN0IHNjb3JlZCA9IChjYXBzLm5hbWVTZWFyY2ggPz8gcmFua05hbWVzKShjYW5kaWRhdGVzLCBxLCBuYW1lcyk7XG5cbiAgY29uc3QgdGV4dDogVGV4dE1hdGNoW10gPSBbXTtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGMgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmIChjb3VudCA+PSB0b3RhbCkge1xuICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBsZXQgYm9keTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGJvZHkgPSByZWFkKGMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgYm9keSA9IG51bGw7XG4gICAgfVxuICAgIGlmIChib2R5ID09PSBudWxsKSBjb250aW51ZTtcbiAgICBjb25zdCByb29tID0gTWF0aC5taW4ocGVyRG9jLCB0b3RhbCAtIGNvdW50KTtcbiAgICBjb25zdCBoaXRzID0gc2VhcmNoVGV4dChib2R5LCBxLCByb29tICsgMSk7XG4gICAgaWYgKGhpdHMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBpZiAoaGl0cy5sZW5ndGggPiByb29tKSB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGNvbnN0IGtlcHQgPSBoaXRzLnNsaWNlKDAsIHJvb20pO1xuICAgIGNvdW50ICs9IGtlcHQubGVuZ3RoO1xuICAgIHRleHQucHVzaCh7XG4gICAgICBwYXRoOiBjLnBhdGgsXG4gICAgICAuLi4oYy5zbHVnICE9PSB1bmRlZmluZWQgPyB7IHNsdWc6IGMuc2x1ZyB9IDoge30pLFxuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgLi4uKGMudmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyB2ZXJzaW9uOiBjLnZlcnNpb24gfSA6IHt9KSxcbiAgICAgIGhpdHM6IGtlcHQsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4geyBxdWVyeTogcSwgZG9jdW1lbnRzOiBzY29yZWQsIHRleHQsIGNvdW50LCB0cnVuY2F0ZWQgfTtcbn1cbiIsCiAgICAiLy8gSXMgdGhlIGh1bWFuIHdhaXRpbmcgb24gYW4gYW5zd2VyLCBhbmQgZm9yIGhvdyBsb25nIChFNTMpP1xuLy9cbi8vIOKblCBERVJJVkVELCBOT1QgREVDTEFSRUQg4oCUIENvbGUncyBydWxpbmcsIGFuZCB0aGUgcmVhc29uIGlzIGxvYWQtYmVhcmluZzogXCJ3ZVxuLy8gY291bGQgYWRkIHNvbWUgYWZmb3JkYW5jZSB0aGF0IHNlbmRzIGEgY2hlY2staW4gd2l0aCBhbiBhZ2VudOKApiB3aGVyZSB3ZSdyZVxuLy8gbm90IGFkZGluZyBtb3JlIHRhc2tzIGZvciB0aGUgYWdlbnQgdG8gaGF2ZSB0byBleHBsaWNpdGx5IGRvLlwiIEFuIGFnZW50IHRoYXRcbi8vIG11c3QgcmVtZW1iZXIgdG8gc2F5IFwidGhpbmtpbmdcIiB3aWxsIGZvcmdldCBleGFjdGx5IHdoZW4gaXQgbWF0dGVycyDigJQgaXQgaXNcbi8vIGJ1c3ksIHdoaWNoIGlzIHRoZSB3aG9sZSBzaXR1YXRpb24gYmVpbmcgc2lnbmFsbGVkLiBTbyBub3RoaW5nIGhlcmUgYXNrcyB0aGVcbi8vIGFnZW50IGZvciBhbnl0aGluZy4gVGhlIHN0YXRlIGlzIHJlYWQgb2ZmIHRoZSBjb252ZXJzYXRpb246IGEgaHVtYW4gbWVzc2FnZVxuLy8gd2l0aCBubyBhZ2VudCBtZXNzYWdlIGFmdGVyIGl0IGlzIGEgaHVtYW4gd2FpdGluZy5cbi8vXG4vLyDim5QgQU5EIFRIRSBBR0VOVCdTIFJFUExZIElTIFRIRSBDT01QTEVUSU9OIFNJR05BTCwgd2hpY2ggaXMgbWluZC1tYXBwZXInc1xuLy8gcnVsZSAoUjExIFNFQU0gMikgYW5kIGlzIHN0b2xlbiBkZWxpYmVyYXRlbHkuIFRoZXJlIGlzIG5vIGBkb25lYCBzdGF0ZSB0b1xuLy8gZW1pdCwgc28gdGhlcmUgaXMgbm8gYGRvbmVgIHN0YXRlIHRvIGdldCBvdXQgb2Ygc3luYy4gT25lIGNvbnNlcXVlbmNlIHdvcnRoXG4vLyBuYW1pbmcgYmVjYXVzZSBpdCBmZWxsIG91dCBmb3IgZnJlZTogYHN0YXJ0VGFza2AgcG9zdHMgaXRzIGFubm91bmNlbWVudCBBU1xuLy8gVEhFIEFHRU5UIChFNTApLCBzbyB0aGUgaGFwcHkgcGF0aCBDb2xlIGRlc2NyaWJlZCDigJQgXCJncmVhdCwgSSdtIGdvaW5nIHRvIGdldFxuLy8gdGhhdCBzdGFydGVkXCIsIHRoZW4gYSB0YXNrLCB0aGVuIGEgc3ViYWdlbnQg4oCUIGNsZWFycyB0aGlzIGJ5IGNvbnN0cnVjdGlvbi5cbi8vXG4vLyDimqAgQSBTWVNURU0gTElORSBJUyBOT1QgQSBSRVBMWS4gYGFubm91bmNlKClgIG5hcnJhdGVzIGFnZW50IEFDVFMgKFwiQWdlbnRcbi8vIG5vdGVkIOKApiBvbiBtYXJlblwiKSwgd2hpY2ggaXMgZXZpZGVuY2Ugb2YgbGlmZSBidXQgbm90IGEgY2hlY2staW4gd2l0aCB0aGVcbi8vIHBlcnNvbiB3YWl0aW5nLiBDb3VudGluZyBpdCB3b3VsZCBzaWxlbmNlIHRoZSBzaWduYWwgcHJlY2lzZWx5IGluIHRoZSBjYXNlXG4vLyB0aGlzIGV4aXN0cyBmb3I6IGFuIGFnZW50IHRoYXQgaXMgYnVzeSBkb2luZyB0aGluZ3MgYW5kIGhhcyBub3Qgc2FpZCBhIHdvcmRcbi8vIHRvIHRoZSBodW1hbi4gT25seSBgd2hvID09PSBcImFnZW50XCJgIGNsZWFycy5cbmltcG9ydCB0eXBlIHsgQ2hhdFdobywgV2FpdGluZyB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogSG93IGxvbmcgYSBodW1hbiB3YWl0cyBiZWZvcmUgdGhlIHdhaXQgaXMgd29ydGggcmVwb3J0aW5nLiAzMCBzLCBDb2xlJ3NcbiAqIG51bWJlciDigJQgbG9uZyBlbm91Z2ggdGhhdCBhbiBvcmRpbmFyeSBhbnN3ZXIgbmV2ZXIgdHJpcHMgaXQsIHNob3J0IGVub3VnaFxuICogdGhhdCBpdCBpcyBzdGlsbCB0aGUgc2FtZSBtb21lbnQgZm9yIHRoZSBwZXJzb24gc2l0dGluZyB0aGVyZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNUQUxMX01TID0gMzBfMDAwO1xuXG4vKiogV2hhdCBhIHNub296ZSBidXlzLCB3aGVuIHRoZSBhZ2VudCBkb2VzIG5vdCBuYW1lIGEgZHVyYXRpb24uICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TTk9PWkVfTVMgPSAxMjBfMDAwO1xuXG4vLyBgV2FpdGluZ2AgaXRzZWxmIGxpdmVzIGluIGBwcm90b2NvbC50c2Ag4oCUIGl0IHJpZGVzIGluIGBQdWJsaWNTdGF0ZWAsIGFuZCB0aGF0XG4vLyBmaWxlIGlzIGltcG9ydC1mcmVlIG9uIHB1cnBvc2UuIEl0cyBgYmFkZ2VgIGNhcnJpZXMgdGhlIHJ1bGUgdGhhdCBtYXR0ZXJzOlxuLy8g4puUIFNUQUxMRUQgTVVTVCBOT1QgUFVMU0UuIEEgcHVsc2Ugb3ZlciBhIHdlZGdlZCBhZ2VudCBpcyBmYWxzZSBsaXZlbmVzcyDigJQgdGhlXG4vLyBhbmltYXRpb24gY2xhaW1zIFwic29tZXRoaW5nIGlzIGhhcHBlbmluZ1wiIHdoZW4gdGhlIGhvbmVzdCBhbnN3ZXIgaXMgXCJJIGNhbm5vdFxuLy8gdGVsbCBhbnkgbW9yZVwiLiBtaW5kLW1hcHBlciBzZXBhcmF0ZXMgdGhlc2UgdHdvIGZvciB0aGUgc2FtZSByZWFzb24uXG5cbnR5cGUgTXNnID0geyBpZDogc3RyaW5nOyB3aG86IENoYXRXaG87IHRzOiBudW1iZXIgfTtcblxuLyoqXG4gKiBUaGUgaHVtYW4gbWVzc2FnZSBub3RoaW5nIGhhcyBhbnN3ZXJlZCB5ZXQsIG9yIG51bGwuXG4gKlxuICogYGFja25vd2xlZGdlZFVudGlsYCBpcyBhIHNub296ZSAodGhlIGFnZW50IHNhaWQgaXQgaXMgc3RpbGwgd29ya2luZykuIFdoaWxlXG4gKiBpdCBob2xkcywgdGhlIGJhZGdlIHN0YXlzIGEgcHVsc2UgcGFzdCB0aGUgc3RhbGwgdGhyZXNob2xkIOKAlCB0aGUgYWdlbnRcbiAqIHZvbHVudGVlcmVkIGV2aWRlbmNlIG9mIGxpZmUsIHNvIHNob3dpbmcgXCJtYXkgYmUgc3R1Y2tcIiB3b3VsZCBiZSB0aGUgbGllLlxuICogV2hlbiBpdCBFWFBJUkVTIHRoZSBiYWRnZSBnb2VzIHN0YWxsZWQgYWdhaW4sIGJlY2F1c2UgdGhlIGh1bWFuIGlzIG93ZWQgdGhlXG4gKiB0cnV0aCBldmVudHVhbGx5OyB0aGF0IGV4cGlyeSBpcyBkZWxpYmVyYXRlbHkgbm90IGEgcmVhc29uIHRvIG51ZGdlIHRoZSBhZ2VudFxuICogYSBzZWNvbmQgdGltZSAoc2VlIHRoZSBzZXJ2ZXIncyBvbmNlLXBlci1tZXNzYWdlIHJ1bGUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2FpdGluZ09uKFxuICBjaGF0OiByZWFkb25seSBNc2dbXSxcbiAgbm93OiBudW1iZXIsXG4gIG9wdHM6IHsgc3RhbGxNcz86IG51bWJlcjsgYWNrbm93bGVkZ2VkVW50aWw/OiBudW1iZXIgfSA9IHt9LFxuKTogV2FpdGluZyB8IG51bGwge1xuICBjb25zdCBzdGFsbE1zID0gb3B0cy5zdGFsbE1zID8/IFNUQUxMX01TO1xuICAvLyBXYWxrIGJhY2sgdG8gdGhlIGxhc3QgdGhpbmcgdGhhdCB3YXMgbm90IG5hcnJhdGlvbi4gQSBodW1hbiB0aGVyZSBtZWFuc1xuICAvLyBub2JvZHkgaGFzIGFuc3dlcmVkIHRoZW0uXG4gIGxldCBwZW5kaW5nOiBNc2cgfCBudWxsID0gbnVsbDtcbiAgZm9yIChsZXQgaSA9IGNoYXQubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBtID0gY2hhdFtpXTtcbiAgICBpZiAoIW0gfHwgbS53aG8gPT09IFwic3lzdGVtXCIpIGNvbnRpbnVlO1xuICAgIGlmIChtLndobyA9PT0gXCJhZ2VudFwiKSByZXR1cm4gbnVsbDtcbiAgICBwZW5kaW5nID0gbTtcbiAgICBicmVhaztcbiAgfVxuICBpZiAoIXBlbmRpbmcpIHJldHVybiBudWxsO1xuXG4gIC8vIOKaoCBUaGUgRklSU1Qgb2YgdGhlIHVuYW5zd2VyZWQgcnVuLCBub3QgdGhlIGxhc3QuIFNvbWVvbmUgd2hvIHNlbmRzIHRocmVlXG4gIC8vIG1lc3NhZ2VzIHdoaWxlIHdhaXRpbmcgaGFzIGJlZW4gd2FpdGluZyBzaW5jZSB0aGUgZmlyc3Qgb25lLCBhbmQgcmVzZXR0aW5nXG4gIC8vIHRoZSBjbG9jayBvbiBldmVyeSBmb2xsb3ctdXAgd291bGQgbWVhbiB0aGUgbW9yZSBhbnhpb3VzIHRoZXkgZ2V0LCB0aGVcbiAgLy8gbG9uZ2VyIHdlIGNsYWltIHRoZXkgaGF2ZSBiZWVuIHdhaXRpbmcgaXMgemVyby5cbiAgbGV0IHNpbmNlID0gcGVuZGluZy50cztcbiAgbGV0IG1lc3NhZ2VJZCA9IHBlbmRpbmcuaWQ7XG4gIGZvciAobGV0IGkgPSBjaGF0Lmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbSA9IGNoYXRbaV07XG4gICAgaWYgKCFtIHx8IG0ud2hvID09PSBcInN5c3RlbVwiKSBjb250aW51ZTtcbiAgICBpZiAobS53aG8gIT09IFwiaHVtYW5cIikgYnJlYWs7XG4gICAgc2luY2UgPSBtLnRzO1xuICAgIG1lc3NhZ2VJZCA9IG0uaWQ7XG4gIH1cblxuICBjb25zdCBhY2tub3dsZWRnZWQgPSBvcHRzLmFja25vd2xlZGdlZFVudGlsICE9PSB1bmRlZmluZWQgJiYgbm93IDwgb3B0cy5hY2tub3dsZWRnZWRVbnRpbDtcbiAgY29uc3Qgc3RhbGxlZCA9IG5vdyAtIHNpbmNlID49IHN0YWxsTXMgJiYgIWFja25vd2xlZGdlZDtcbiAgcmV0dXJuIHsgbWVzc2FnZUlkLCBzaW5jZSwgYmFkZ2U6IHN0YWxsZWQgPyBcInN0YWxsZWRcIiA6IFwid29ya2luZ1wiIH07XG59XG5cbi8qKiBXaGF0IHRoZSBjb252ZXJzYXRpb24gc2hvd3MsIHBlciBiYWRnZS4gbWluZC1tYXBwZXIncyB3b3JkcywgbmVhciBlbm91Z2guICovXG5leHBvcnQgY29uc3QgV0FJVElOR19MQUJFTDogUmVjb3JkPFdhaXRpbmdbXCJiYWRnZVwiXSwgc3RyaW5nPiA9IHtcbiAgd29ya2luZzogXCJ3b3JraW5nIG9uIHRoaXPigKZcIixcbiAgc3RhbGxlZDogXCJ0b29rIHRoaXMgaW4sIHRoZW4gd2VudCBxdWlldCDigJQgbWF5IGJlIHN0dWNrXCIsXG59O1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXFEQSx1QkFBUyw2QkFBNEIsMkJBQWMseUJBQVU7QUFDN0Qsb0JBQVM7QUFDVCxxQkFBUyxzQkFBVSx3QkFBUyxxQkFBWSxrQkFBTTtBQUM5QztBQUNBLHNCQUFTOzs7QUMzQ1Q7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFBZSxDQUM3QixNQUNBLFVBQ0EsV0FBMkMsQ0FBQyxRQUFRLElBQUksS0FBSyxHQUNwRDtBQUFBLEVBQ1QsSUFBSTtBQUFBLElBQ0YsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLE1BQUcsT0FBTztBQUFBLElBQzlCLElBQUksU0FBUyxhQUFhLE1BQU0sTUFBTSxDQUFDLE1BQU07QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5RCxXQUFXLElBQUk7QUFBQSxJQUNmLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBOzs7QUMrQkosSUFBTSxxQkFBcUI7QUEyQjNCLFNBQVMsY0FBZ0MsQ0FDOUMsT0FBZ0QsQ0FBQyxHQUNwQztBQUFBLEVBQ2IsTUFBTSxhQUFhLEtBQUssY0FB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QUN0RCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxRQUFRLE9BQU8sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsQ0FDNUY7QUFBQSxJQUNBLE9BQU8sV0FBVyxNQUFNLElBQUksV0FBVyxNQUFNLElBQUk7QUFBQTtBQUFBLEVBRW5ELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsS0FBSyxvQkFBb0IsRUFBRSxRQUFRLE1BQU0sRUFBRSxNQUFNLFlBQVksRUFBRSxXQUFXLE1BQU0sRUFBRSxNQUFNLEtBQUssRUFBRSxJQUFJLENBQUM7QUFBQSxDQUMxSDtBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sRUFBRTtBQUFBLEVBQ3BCLE1BQU0sRUFBRTtBQUFBLEVBRVIsSUFBSSxJQUFJLFNBQVMsS0FBSyxNQUFNLEtBQUs7QUFBQSxJQUMvQixJQUFJO0FBQUEsTUFDRixJQUFJLFVBQVMsTUFBTSxHQUFHLEVBQUUsU0FBUztBQUFBLFFBQUcsWUFBVyxNQUFNLEdBQUc7QUFBQSxNQUN4RCxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsT0FBTyxJQUFJO0FBQUE7QUFRYixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICIxOEY4QkNBOTk0RkM1QzEwNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
