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
function refuseForeignOrigin(req, port) {
  if (sameOrigin(req, port))
    return null;
  return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
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
function linesOf(text, from, to) {
  const lineAt = (i) => {
    let n = 1;
    for (let k = text.indexOf(`
`);k !== -1 && k < i; k = text.indexOf(`
`, k + 1))
      n++;
    return n;
  };
  return { from: lineAt(from), to: lineAt(Math.max(from, to - 1)) };
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

// src/scriptorium/backend/doctor.ts
function findings(c) {
  const out = [];
  for (const d of c.docs) {
    if (d.exists)
      continue;
    out.push({
      kind: "original.missing",
      subject: d.original,
      message: `${d.name} is in this session but its file is gone from disk. ${d.versions === 1 ? "1 version is" : `${d.versions} versions are`} still held here \u2014 saving would recreate the file.`,
      fix: `forget --doc ${d.slug}`,
      count: d.versions
    });
  }
  for (const n of c.nodes) {
    if (n.exists)
      continue;
    out.push({
      kind: "context.ghost",
      subject: n.path,
      message: `${n.shown} is in the context but not on disk.`,
      fix: `hide ${n.path}`
    });
  }
  for (const l of c.links) {
    if (l.dangling <= 0)
      continue;
    out.push({
      kind: "links.dangling",
      subject: l.entry,
      message: l.dangling === 1 ? `${l.label} has 1 link that answers nothing.` : `${l.label} has ${l.dangling} links that answer nothing.`,
      fix: `dangling --entry ${l.entry}`,
      count: l.dangling
    });
  }
  for (const l of c.links) {
    const n = l.unsupported ?? 0;
    if (n <= 0)
      continue;
    const schemes = (l.schemes ?? []).map((s) => `${s}:`).join(", ");
    out.push({
      kind: "links.unsupported",
      subject: l.entry,
      message: `${l.label} has ${n === 1 ? "1 link" : `${n} links`} with a scheme nothing here opens${schemes ? ` (${schemes})` : ""}.`,
      fix: `dangling --entry ${l.entry}`,
      count: n
    });
  }
  return out;
}
function summary(list) {
  if (list.length === 0)
    return null;
  const byKind = new Map;
  for (const f of list)
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const label = {
    "original.missing": ["missing file", "missing files"],
    "context.ghost": ["ghost in the context", "ghosts in the context"],
    "links.dangling": ["set with dangling links", "sets with dangling links"],
    "links.unsupported": ["set with unsupported links", "sets with unsupported links"]
  };
  const parts = [...byKind].map(([kind, n]) => `${n} ${label[kind][n === 1 ? 0 : 1]}`);
  return `Startup check: ${parts.join(", ")} \u2014 run \`doctor\` for the detail.`;
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

// src/scriptorium/backend/selection.ts
function selectionOnScreen(sel, screen) {
  if (!sel || !screen)
    return null;
  return sel.doc === screen.doc && sel.version === screen.version ? sel : null;
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
var FENCE = /^ {0,3}(`{3,}|~{3,})/;
var INDENTED = /^( {4}|\t)/;
var LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
var BLANK = /^\s*$/;
var QUOTE = /^ {0,3}(?:> ?)+/;
var FENCE_ANY = /^\s*(`{3,}|~{3,})/;
function fenceOf(line, nested) {
  const q = QUOTE.exec(line);
  const body = q ? line.slice(q[0].length) : line;
  const m = (q || nested ? FENCE_ANY : FENCE).exec(body);
  return m ? { marker: m[1], rest: body.slice(m[0].length) } : null;
}
function codeBlockLines(lines) {
  const out = new Set;
  let fence = null;
  let inList = false;
  let indented = false;
  let prevBlank = true;
  lines.forEach((line, i) => {
    if (fence !== null) {
      out.add(i);
      const m = fenceOf(line, true);
      if (m && m.marker[0] === fence[0] && m.marker.length >= fence.length && BLANK.test(m.rest))
        fence = null;
      return;
    }
    const blank = BLANK.test(line);
    if (indented && (blank || INDENTED.test(line))) {
      out.add(i);
      prevBlank = blank;
      return;
    }
    indented = false;
    const f = fenceOf(line, inList);
    if (f) {
      fence = f.marker;
      out.add(i);
      prevBlank = false;
      return;
    }
    if (!blank && INDENTED.test(line) && prevBlank && !inList) {
      indented = true;
      out.add(i);
      prevBlank = false;
      return;
    }
    if (!blank && !INDENTED.test(line))
      inList = LIST_ITEM.test(line) || inList && !prevBlank;
    prevBlank = blank;
  });
  return out;
}
function inlineSpans(line) {
  const spans = [];
  const runs = [...line.matchAll(/(?<!\\)`+/g)].map((m) => ({
    at: m.index,
    len: m[0].length
  }));
  for (let i = 0;i < runs.length; i++) {
    const open = runs[i];
    const close = runs.slice(i + 1).findIndex((r) => r.len === open.len);
    if (close === -1)
      continue;
    const end = runs[i + 1 + close];
    spans.push([open.at, end.at + end.len]);
    i += 1 + close;
  }
  return spans;
}
function maskCode(text) {
  const lines = text.split(`
`);
  const blocks = codeBlockLines(lines);
  return lines.map((line, i) => {
    if (blocks.has(i))
      return " ".repeat(line.length);
    let out = "";
    let at = 0;
    for (const [from, to] of inlineSpans(line)) {
      out += line.slice(at, from) + " ".repeat(to - from);
      at = to;
    }
    return out + line.slice(at);
  }).join(`
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
var LABEL_CHAR = String.raw`(?:[^\[\]\n]|\n(?![ \t]*\r?\n))`;
var ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
var MD_LINK = new RegExp(String.raw`(!?)\[((?:${LABEL_CHAR}|\[${LABEL_CHAR}*\])*)\]\(\s*(?:<([^>\n]*)>|((?:[^\s()]|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`, "gd");
var WIKI_LINK = /\[\[([^[\]\n]+)\]\]/dg;
var COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
var ESCAPE = /\\[!-/:-@[-`{-~]/g;
var unescapeMd = (s) => s.replace(ESCAPE, (e) => e.slice(1));
var OPENS_OUTWARD = new Set(["http", "https", "mailto"]);
function linkable(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return maskCode(text).replace(COMMENT, blank).replace(ESCAPE, "\x01\x01");
}
function extractLinks(body, opts = {}) {
  if (!body.includes("["))
    return [];
  const text = body;
  const masked = linkable(text);
  const starts = [0];
  for (let i = 0;i < text.length; i++)
    if (text.charCodeAt(i) === 10)
      starts.push(i + 1);
  const lineOf = (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (starts[mid] <= at)
        lo = mid;
      else
        hi = mid - 1;
    }
    return lo;
  };
  const lineText = (i) => text.slice(starts[i], (starts[i + 1] ?? text.length + 1) - 1).replace(/\r$/, "");
  const md = [];
  MD_LINK.lastIndex = 0;
  for (let m = MD_LINK.exec(masked);m; m = MD_LINK.exec(masked)) {
    const label = m[2] ?? "";
    const crossesHeading = label.includes(`
`) && ATX_HEADING.test(lineText(lineOf(m.index)));
    if (label.includes("](") || crossesHeading) {
      MD_LINK.lastIndex = m.index + 1;
      continue;
    }
    md.push(m);
  }
  const mdSpans = md.map((m) => [m.index, m.index + m[0].length]);
  const wiki = [...masked.matchAll(WIKI_LINK)].filter((m) => !mdSpans.some(([a, b]) => m.index < b && m.index + m[0].length > a));
  const slice = (m, g) => {
    const at = m.indices?.[g];
    return at ? text.slice(at[0], at[1]) : undefined;
  };
  const out = [];
  for (const m of md) {
    if (m[1] === "!")
      continue;
    const raw = slice(m, 3) ?? slice(m, 4) ?? "";
    if (raw === "" || raw.startsWith("#"))
      continue;
    const scheme = EXTERNAL.exec(raw)?.[0].slice(0, -1).toLowerCase();
    if (scheme !== undefined && !opts.schemes)
      continue;
    const { path, query } = splitTarget(unescapeMd(raw));
    if (path === "")
      continue;
    const label = unescapeMd(slice(m, 2) ?? "").replace(/\s*\n\s*/g, " ").trim();
    out.push({
      at: m.index,
      kind: "markdown",
      target: path,
      raw,
      line: lineOf(m.index) + 1,
      rel: parseRel(query),
      ...label ? { label } : {},
      ...scheme !== undefined ? { scheme } : {}
    });
  }
  for (const m of wiki) {
    const inner = slice(m, 1) ?? "";
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    const { path, query } = splitTarget(targetPart);
    if (path === "")
      continue;
    out.push({
      at: m.index,
      kind: "wiki",
      target: path,
      raw: targetPart,
      line: lineOf(m.index) + 1,
      rel: parseRel(query),
      ...label ? { label } : {}
    });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...link }) => link);
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
var trimSlash = (p) => p.length > 1 ? p.replace(/[\\/]+$/, "") || p : p;
function resolveTarget(rawTarget, from, index) {
  const target = splitTarget(rawTarget).path;
  const folderish = target.length > 1 && target.endsWith("/");
  const looksPath = folderish || target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || extname(target) !== "";
  if (looksPath) {
    const anchored = target.startsWith("/") || target.startsWith("./") || target.startsWith("../");
    const candidates = (target.startsWith("/") ? [normalize(join3(index.root, target))] : anchored ? [normalize(resolvePath(dirname2(from), target))] : [
      normalize(resolvePath(dirname2(from), target)),
      normalize(join3(index.root, target)),
      ...index.repoRoot ? [normalize(join3(index.repoRoot, target))] : []
    ]).map(trimSlash);
    const tried = candidates.map((c) => extname(c) === "" ? `${c}.md` : c);
    if (!folderish) {
      for (const c of tried)
        if (index.paths.includes(c))
          return { state: "in-bundle", path: c };
      for (const c of tried)
        if (index.exists(c))
          return { state: "outside", path: c };
    }
    for (const c of candidates)
      if (index.isDir?.(c))
        return { state: "folder", path: c };
    return { state: "missing", tried: folderish ? candidates[0] : tried[0] };
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
  for (const c of [resolvePath(dirname2(from), target), normalize(join3(index.root, target))])
    if (index.isDir?.(c))
      return { state: "folder", path: c };
  return { state: "missing", tried: target };
}
function buildGraph(index, bodyOf, cap = 400) {
  const paths = index.paths.slice(0, cap);
  const edges = [];
  const unsupported = [];
  for (const from of paths) {
    const meta = index.metaOf(from);
    for (const link of extractLinks(bodyOf(from), { schemes: true })) {
      if (link.scheme !== undefined) {
        if (!OPENS_OUTWARD.has(link.scheme))
          unsupported.push({
            from,
            raw: link.raw,
            line: link.line,
            scheme: link.scheme,
            rel: link.rel
          });
        continue;
      }
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
    dangling: edges.filter((e) => e.state === "missing").length,
    unsupported
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
var CHAT_ORIGIN = "\x00chat";
var META_SCAN_CAP = 500;
var META_HEAD_BYTES = 8192;
var isFileAt = (p) => statSync2(p, { throwIfNoEntry: false })?.isFile() ?? false;
var isDirAt = (p) => statSync2(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
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
  hint;
  constructor(message, status, choices, hint) {
    super(message);
    this.status = status;
    this.choices = choices;
    this.hint = hint;
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
  unwrittenCopies = new Map;
  activatedUnwritten = new Map;
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
    const wasEnded = s.m.ended !== undefined;
    delete s.m.ended;
    if (s.restoreFindings.length > 0 || wasEnded)
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
  markEnded(by) {
    this.m.ended = { by, at: Date.now() };
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
    this.contentChanged(this.versionPath(d, d.active), text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }
  contentChanged(path, text) {
    if (this.unwrittenCopies.get(path) !== contentHash(text))
      this.unwrittenCopies.delete(path);
  }
  preserveOutside(d, text) {
    const path = this.versionPath(d, d.active);
    const activatedBeforeWritten = this.activatedUnwritten.get(d.slug) === d.active && this.unwrittenCopies.has(path);
    this.unwrittenCopies.delete(path);
    this.activatedUnwritten.delete(d.slug);
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
    return { ...rec, path: this.versionPath(d, n), activatedBeforeWritten };
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
    const opened = this.m.docs.map((d2) => d2.slug);
    const choices = opened.length > 0 ? opened : this.m.context.flatMap((e) => docPaths(e)).slice(0, 20);
    const hint = opened.length > 0 ? undefined : "nothing is open yet \u2014 pass a PATH from the context (a filename only resolves once a document is open)";
    if (want === undefined)
      throw new SessionError("no document is open \u2014 name one with --doc", 409, choices, hint);
    const d = this.findDoc(want);
    if (!d)
      throw new SessionError(`no document "${want}" in this session`, 404, choices, hint);
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
    this.contentChanged(path, text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
    return { dirtyChanged: before !== this.isDirty(d), preserved };
  }
  newVersion(opts) {
    const d = this.docOrDie(opts.doc);
    const from = opts.from ?? d.active;
    this.versionOrDie(d, from);
    const text = opts.text ?? readFileSync3(this.versionPath(d, from), "utf8");
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
    if (opts.text === undefined && opts.author === "agent")
      this.unwrittenCopies.set(this.versionPath(d, n), contentHash(text));
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
    this.unwrittenCopies.delete(path);
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
    const path = this.versionPath(d, d.active);
    const text = readFileSync3(path, "utf8");
    this.adoptActive(d, text);
    const unwritten = this.unwrittenCopies.get(path);
    if (opts.by === "human" && unwritten === contentHash(text))
      this.activatedUnwritten.set(d.slug, d.active);
    else
      this.activatedUnwritten.delete(d.slug);
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
  noteFacts() {
    return this.m.docs.map((d) => ({ slug: d.slug, notes: d.notes ?? [] }));
  }
  noteLines(doc, note) {
    const d = this.docOrDie(doc);
    const text = this.activeText(d);
    const at = findAnchor(text, note);
    return at.from === null ? null : linesOf(text, at.from, at.to);
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
    note.editedBy = opts.who;
    this.persist();
    return { slug: d.slug, note };
  }
  resolveNote(opts) {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    if (note.resolved && !opts.resolved) {
      note.reopenedAt = Date.now();
      note.reopenedBy = opts.who;
    }
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
          preservedPath: kept.path,
          activatedBeforeWritten: kept.activatedBeforeWritten
        };
      }
      this.owned.set(abs, contentHash(text));
      this.unwrittenCopies.delete(abs);
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
  checkup() {
    const nodes = [];
    const links = [];
    for (const e of this.m.context) {
      for (const p of docPaths(e))
        nodes.push({ entry: e.id, path: p, shown: this.display(p), exists: existsSync3(p) });
      if (e.membership !== "mirrored")
        continue;
      try {
        const g = this.graphFor(e.id);
        if (g.dangling > 0 || g.unsupported.length > 0)
          links.push({
            entry: e.id,
            label: e.label ?? basename3(e.root),
            dangling: g.dangling,
            unsupported: g.unsupported.length,
            schemes: [...new Set(g.unsupported.map((u) => u.scheme))]
          });
      } catch {}
    }
    return findings({
      docs: this.m.docs.map((d) => ({
        slug: d.slug,
        name: d.name,
        original: d.original,
        exists: existsSync3(d.original),
        versions: d.versions.length
      })),
      nodes,
      links
    });
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
        let summary2;
        if (hit && hit.mtimeMs === mtimeMs)
          summary2 = hit.summary;
        else {
          summary2 = summarize(readMeta(readHead(abs)));
          this.metaCache.set(abs, { mtimeMs, summary: summary2 });
        }
        if (summary2)
          map[abs] = summary2;
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
      exists: isFileAt,
      isDir: isDirAt,
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
      unsupported: g.unsupported.map((u) => ({
        from: u.from,
        line: u.line + offsetOf(u.from),
        wrote: u.raw,
        scheme: u.scheme,
        ...u.rel.length ? { rel: u.rel } : {}
      })),
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
  resolveLink(from, target, doc) {
    if (from !== "chat")
      return this.resolveFrom(this.shownPath(from), target);
    const open = doc ? this.shownPath(doc) : null;
    const first = this.m.context[0];
    if (!open)
      return this.resolveFrom(join4(first?.root ?? this.workspace, CHAT_ORIGIN), target, first ?? null);
    const besideDoc = this.resolveFrom(open, target);
    if (besideDoc.state === "in-bundle")
      return besideDoc;
    const entry = this.entryHolding(open);
    if (!entry)
      return besideDoc;
    const fromRoot = this.resolveFrom(join4(entry.root, CHAT_ORIGIN), target, entry);
    if (fromRoot.state === "in-bundle")
      return fromRoot;
    return besideDoc.state !== "missing" || fromRoot.state === "missing" ? besideDoc : fromRoot;
  }
  entryHolding(src) {
    return this.m.context.find((e) => e.membership === "mirrored" && src.startsWith(e.root + sep2)) ?? null;
  }
  resolveFrom(src, target, entry = this.entryHolding(src)) {
    const root = entry?.root ?? dirname3(src);
    const paths = entry ? docPaths(entry) : [src];
    return resolveTarget(target, src, {
      root,
      paths,
      metaOf: (p) => readMeta(readHead(p)),
      exists: isFileAt,
      isDir: isDirAt,
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
  return { messageId, since, badge: badgeFor(since, now, opts) };
}
function badgeFor(since, now, opts) {
  const stallMs = opts.stallMs ?? STALL_MS;
  const acknowledged = opts.acknowledgedUntil !== undefined && now < opts.acknowledgedUntil;
  return now - since >= stallMs && !acknowledged ? "stalled" : "working";
}
function humanWroteAt(n) {
  const acts = [{ at: n.createdAt, by: n.who }];
  if (n.editedAt !== undefined && n.editedBy)
    acts.push({ at: n.editedAt, by: n.editedBy });
  if (n.reopenedAt !== undefined && n.reopenedBy)
    acts.push({ at: n.reopenedAt, by: n.reopenedBy });
  let last = acts[0];
  for (const a of acts)
    if (a.at >= last.at)
      last = a;
  return last.by === "human" ? last.at : null;
}
function notesWaiting(docs, chat, now, opts = {}) {
  let lastAgent = Number.NEGATIVE_INFINITY;
  for (const m of chat)
    if (m.who === "agent" && m.ts > lastAgent)
      lastAgent = m.ts;
  const wait = waitingOn(chat, now, opts);
  const out = [];
  for (const d of docs)
    for (const n of d.notes) {
      if (n.resolved)
        continue;
      const since = humanWroteAt(n);
      if (since === null || lastAgent > since)
        continue;
      const asked = wait ? chat.findLast((m) => m.who === "human" && m.ts >= since && m.note?.doc === d.slug && m.note.id === n.id) : undefined;
      out.push(asked && wait ? { doc: d.slug, noteId: n.id, since, badge: wait.badge, askedIn: asked.id } : { doc: d.slug, noteId: n.id, since, badge: badgeFor(since, now, opts) });
    }
  return out.sort((a, b) => a.since - b.since);
}
function attentionKey(w, notes) {
  return [
    w ? `${w.messageId}:${w.badge}` : "-",
    ...notes.map((n) => `${n.doc}/${n.noteId}:${n.badge}${n.askedIn ? `@${n.askedIn}` : ""}`)
  ].join("|");
}
var NOTE_TEXT_MAX = 1000;
function noteEventFacts(slug, note, lines) {
  const close = `note-resolve ${note.id} --doc ${slug}`;
  const at = lines ? { lines } : { passage: "gone" };
  const size = [...note.quote].length + [...note.body].length;
  if (size <= NOTE_TEXT_MAX)
    return {
      ...at,
      quote: note.quote,
      body: note.body,
      hint: lines ? `act on it, then \`${close}\` when it is dealt with` : `its passage is no longer in the active version \u2014 see \`notes --doc ${slug}\`, then act on it and \`${close}\` when it is dealt with`
    };
  return {
    ...at,
    hint: `too long to carry${lines ? "" : ", and its passage is no longer in the active version"} \u2014 read it with \`notes --doc ${slug}\`, act on it, then \`${close}\``
  };
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
  const screen = () => {
    const d = session.openDocSlug ? session.findDoc(session.openDocSlug) : undefined;
    return d ? { doc: d.slug, version: d.active } : null;
  };
  const heldSelection = () => {
    selection = selectionOnScreen(selection, screen());
    return selection;
  };
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
    const base2 = { ...session.view(mode, heldSelection()), prefs: readPrefs(), userHome };
    const now = Date.now();
    return {
      ...base2,
      waiting: waitingOn(base2.chat, now, { acknowledgedUntil }),
      notesWaiting: notesWaiting(session.noteFacts(), base2.chat, now, { acknowledgedUntil }),
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
  const announce = (text, fact = {}, forHuman) => {
    const m = session.addMessage("system", forHuman ?? text);
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
        announceOutside(ev.doc, ev.version, ev.path, ev.preservedAs, ev.preservedPath, ev.activatedBeforeWritten);
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
  const announceOutside = (doc, version, path, preservedAs, preservedPath, activatedBeforeWritten) => announce(activatedBeforeWritten ? `The human activated v${version} of ${doc} before you had written it, so your write landed on the ACTIVE version. Nothing is lost: your text is kept as v${preservedAs} (${preservedPath}); v${version} keeps its own text. Do NOT create another version \u2014 say in the chat that v${preservedAs} is your draft and let the human activate it. Next time, propose a version in one step with version-new --body-file.` : `v${version} of ${doc} is the ACTIVE version and was written from outside the editor. That text is kept as v${preservedAs}; the active version keeps your text. Agent edits belong in a new version (version-new).`, {
    fact: "active.outside",
    doc,
    version,
    path,
    preservedAs,
    preservedPath,
    activatedBeforeWritten
  }, humanOutsideLine(session.doc(doc).name, version, preservedAs, activatedBeforeWritten));
  const addPaths = (paths) => {
    const added = paths.map((p) => session.addContext(p));
    syncWatchers();
    broadcastState();
    return added;
  };
  const activate = (doc, version, by) => {
    const r = session.activate({ doc, version, by });
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
          announceOutside(d.slug, msg.version, session.activePath(d.slug) ?? "", r.preserved.n, r.preserved.path, r.preserved.activatedBeforeWritten);
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
        selection = selectionOnScreen(msg.selection, screen());
        return;
      case "say": {
        const text = msg.text.trim();
        if (!text)
          return;
        const sel = msg.withSelection ? heldSelection() : null;
        const activePath = sel ? session.activePath(sel.doc) : session.activePath();
        let note;
        if (msg.note) {
          const d = session.noteFacts().find((x) => x.slug === msg.note?.doc);
          if (!d?.notes.some((n) => n.id === msg.note?.id)) {
            reply(ws, { type: "error", message: `No note ${msg.note.id} on ${msg.note.doc}.` });
            return;
          }
          const owed = notesWaiting(session.noteFacts(), session.messages(), Date.now(), {
            acknowledgedUntil
          });
          if (owed.some((w) => w.doc === msg.note?.doc && w.noteId === msg.note.id && w.askedIn))
            return;
          note = { doc: msg.note.doc, id: msg.note.id };
        }
        const m = session.addMessage("human", text, {
          selection: sel,
          activePath,
          ...note ? { note } : {}
        });
        log.emit({
          type: "message",
          message_id: m.id,
          text,
          selection: sel,
          active: activeOf(sel?.doc),
          ts: m.ts,
          ...note ? {
            note: note.id,
            doc: note.doc,
            hint: `about note ${note.id} \u2014 \`notes --doc ${note.doc}\` has it whole; answer here, and \`note-resolve ${note.id} --doc ${note.doc}\` when it is dealt with`
          } : {}
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
        log.emit({
          type: "note.added",
          doc: r.slug,
          note: r.note.id,
          by: "human",
          ...noteEventFacts(r.slug, r.note, session.noteLines(r.slug, r.note))
        });
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
        const r = session.editNote({ doc: msg.doc, id: msg.id, body: msg.body, who: "human" });
        log.emit({
          type: "note.edited",
          doc: r.slug,
          note: r.note.id,
          by: "human",
          ...noteEventFacts(r.slug, r.note, session.noteLines(r.slug, r.note))
        });
        broadcastState();
        return;
      }
      case "note.resolve": {
        const r = session.resolveNote({
          doc: msg.doc,
          id: msg.id,
          resolved: msg.resolved,
          who: "human"
        });
        log.emit({
          type: msg.resolved ? "note.resolved" : "note.reopened",
          doc: r.slug,
          note: r.note.id,
          by: "human",
          ...msg.resolved ? {} : noteEventFacts(r.slug, r.note, session.noteLines(r.slug, r.note))
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
      case "session.end":
        resolveDone({ code: 0, reason: "close", by: "human" });
        return;
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
        const r = session.resolveLink(msg.from, msg.target, msg.doc);
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
      case "doctor": {
        const list = session.checkup();
        return { findings: list, count: list.length };
      }
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
        const r = session.editNote({ doc: cmd.doc, id: cmd.id, body: cmd.body, who: "agent" });
        announce(`Agent rewrote a note on ${r.slug}: \u201C${quoteLabel(r.note.quote)}\u201D.`, {
          fact: "note.edited",
          doc: r.slug,
          note: r.note.id,
          by: "agent"
        });
        return { doc: r.slug, note: r.note.id };
      }
      case "note.resolve": {
        const r = session.resolveNote({
          doc: cmd.doc,
          id: cmd.id,
          resolved: cmd.resolved,
          who: "agent"
        });
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
          ...typeof cmd.text === "string" ? { text: cmd.text } : {},
          author: "agent"
        });
        announce(`Agent created v${r.version.n} of ${r.slug} from v${r.version.from}${cmd.label ? ` \u2014 ${cmd.label}` : ""}.`, { fact: "version.created", doc: r.slug, version: r.version.n });
        const written = typeof cmd.text === "string";
        return {
          doc: r.slug,
          version: r.version.n,
          from: r.version.from,
          path: r.version.path,
          written,
          hint: written ? `v${r.version.n} holds your text and the human has been offered it \u2014 no need to announce it; say why you made it if that helps them decide` : `v${r.version.n} is a copy of v${r.version.from} and the human can already activate it \u2014 write your text to its path now (next time: version-new --body-file, one step)`
        };
      }
      case "say": {
        const m = session.addMessage("agent", cmd.text);
        broadcastState();
        return { id: m.id };
      }
      case "activate":
        return activate(cmd.doc, cmd.version, "agent");
      case "close":
        resolveDone({ code: 0, reason: "close", by: "agent" });
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
      return Response.json({
        ok: false,
        error: e.message,
        ...e.choices ? { choices: e.choices } : {},
        ...e.hint ? { hint: e.hint } : {}
      }, { status: e.status });
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
      {
        const refused = refuseForeignOrigin(req, srv.port);
        if (refused)
          return refused;
      }
      const url = new URL(req.url);
      const path = url.pathname;
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
  {
    const list = session.checkup();
    const line = summary(list);
    if (line) {
      announce(line, { fact: "doctor", findings: list.length });
      log.emit({ type: "doctor", count: list.length, findings: list });
    }
  }
  let lastWaiting = null;
  const attentionTimer = setInterval(() => {
    const now = Date.now();
    const w = waitingOn(session.messages(), now, { acknowledgedUntil });
    const notes = notesWaiting(session.noteFacts(), session.messages(), now, {
      acknowledgedUntil
    });
    const key = attentionKey(w, notes);
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
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout", by: "timeout" })
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
  const close = (by) => {
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
    if (by)
      session.markEnded(by);
    try {
      session.persist();
    } catch {}
    cleanupDiscovery();
    log.emit({ type: "closed", ...by ? { by } : {} });
    if (by)
      send({ type: "closed", by });
    drainAndStop({ server, clients: sseClients, sockets }).then(resolveShutdown);
  };
  done.then((r) => close(r.by));
  return {
    port: boundPort,
    sessionId,
    mode,
    dir: session.dir,
    workspace: session.workspace,
    close,
    done,
    shutdown
  };
}
function humanOutsideLine(name, version, preservedAs, activatedBeforeWritten) {
  return activatedBeforeWritten ? `You activated v${version} of ${name} before the agent had written it; the agent's text is v${preservedAs}.` : `v${version} of ${name} was written from outside the editor; that text is kept as v${preservedAs}, and v${version} keeps yours.`;
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
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId, mode: d.mode, dir: d.dir, workspace: d.workspace })}
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
  humanOutsideLine,
  main,
  resolveMode2 as resolveMode,
  run,
  scriptoriumHome,
  startDaemon,
  surfacePath
};

//# debugId=93C8FDB0578964DE64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL29yaWdpbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc2VydmVEaXN0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zc2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvYW5jaG9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9kaWZmLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2RvY3Rvci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oaXN0b3J5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZWxlY3Rpb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2Vzc2lvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9mcm9udG1hdHRlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9saW5rcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3NlYXJjaC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC93YWl0aW5nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBwZXItc2Vzc2lvbiBkYWVtb24g4oCUIHRoZSBwcm9jZXNzIHRoZSBzdXJmYWNlIHRhbGtzIHRvIG92ZXIgYVxuICogV2ViU29ja2V0IGFuZCB0aGUgQ0xJIHRhbGtzIHRvIG92ZXIgSFRUUC4gTGF1bmNoZWQgYnlcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvc2NyaXB0b3JpdW0vc2NyaXB0cy9zZXJ2ZXIudHNgICh0aGUgbGF1bmNoZXIpLCB3aGljaFxuICogaW1wb3J0cyB0aGUgQlVJTFQgYGRpc3Qvc2VydmVyLmpzYC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogYFNLSUxMX1JPT1RgL2BESVNUX0RJUmAgb25seSwgZm9yIHRoZSBraXQncyBgcmVzb2x2ZU1vZGVgIGFuZFxuICogICAgYHNlcnZlRnJvbURpc3RgLCBhbmQgdHJ1ZSBhdCB0aGUgRU1JVFRFRCBhZGRyZXNzIChgZGlzdC9zZXJ2ZXIuanNgLCB3aG9zZVxuICogICAgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyKS4gTm90aGluZyBlbHNlIGlzIHBpbm5lZCBvZmYgYGltcG9ydC5tZXRhYC5cbiAqIDIuIFNlcnZlczogWUVTLiBgL2AgaXMgdGhlIGJ1aWx0IGBpbmRleC5odG1sYCB2aWEgYHNlcnZlRnJvbURpc3RgLCBub1xuICogICAgc3Vic3RpdHV0aW9uOyB0aGUgb25seSByb3V0ZXMgb2YgaXRzIG93biBhcmUgYC9zdGF0ZWAsIGAvY21kYCwgYC9ldmVudHNgLFxuICogICAgYC93c2AgYW5kIGAvZnMvKmAgKHJlYWQtb25seTogYSB2ZXJzaW9uJ3MgdGV4dCwgYSBkaXJlY3RvcnkgbGlzdGluZykuXG4gKiAzLiBTZWNvbmQgaGFsZjogWUVTIOKAlCBgY2xpLnRzYDsgdGhlIHR3byBzaGFyZSBgLi9oZWFydGJlYXQudHNgLlxuICogNC4gTGlmZWN5Y2xlOiBsb25nLXJ1bm5pbmcsIG9uZSBkYWVtb24gcGVyIHNlc3Npb24sIGlkbGUtdGltZW91dCBsaWtlXG4gKiAgICBnbGFtb3VyIChsaW5nZXIgYWZ0ZXIgdGhlIGxhc3Qgc3Vic2NyaWJlciBsZWF2ZXM7IGV4aXQgMTI0KS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDigJQgYG1haW5gIGF3YWl0cyB0aGVcbiAqICAgIHNlc3Npb24ncyBlbmQgYW5kIGl0cyBvd24gZHJhaW4sIGV4YWN0bHkgYXMgZ2xhbW91cidzIHNlcnZlciBkb2VzLCBzbyB0aGVcbiAqICAgIGxhdW5jaGVyIGlzIFRFUk1JTkFMLUVYSVQgKGBwcm9jZXNzLmV4aXQoYXdhaXQgcnVuKCkpYCk6IG9uY2UgYG1haW5gXG4gKiAgICByZXNvbHZlcyBub3RoaW5nIG1heSBrZWVwIHRoZSBwcm9jZXNzIGFsaXZlLCBhbmQgYSB3YXRjaGVyIGhhbmRsZSBvciBhXG4gKiAgICBzdHJhZ2dsaW5nIHNvY2tldCB3b3VsZC4gRHJpdmVuLCBub3QgcmVhZCAoc2VlIHRoZSBzbGljZS1BIGpvdXJuYWwpLlxuICogNi4gRXZlbnQgaWRzIHJlY292ZXJlZCBhY3Jvc3MgcmVzdGFydD8gTk8g4oCUIHRoZSBsb2cgaXMgaW4gbWVtb3J5IGFuZCBpZHNcbiAqICAgIHJlc3RhcnQgYXQgMSwgZXZlbiB1bmRlciBgLS1yZXN0b3JlYCAod2hpY2ggcmVzdG9yZXMgdGhlIE1BTklGRVNULCBub3QgdGhlXG4gKiAgICBsb2cpLiBTbyB0aGUgbG9nIGlzIHN0YW1wZWQgd2l0aCBhIHBlci1ib290IEVQT0NIIChtaW5kLW1hcHBlcidzIHNoYXBlKVxuICogICAgYW5kIHRoZSB0YWlsIHJlc2V0cyBpdHMgY3Vyc29yIHdoZW4gdGhlIGVwb2NoIGNoYW5nZXMuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBObyDigJQgdGhlIHNoYXBlIHdhcyBjaG9zZW4gdG8gYmUgdGhlXG4gKiAgICBraXQncy5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBOTzogc2NyaXB0b3JpdW1cbiAqICAgIGlzIHRoZSBmaXJzdCBzcGVsbCBzY2FmZm9sZGVkIGFmdGVyIHRoZSBjb252ZXJnZW5jZS5cbiAqXG4gKiDilIDilIAgS0lUIFZFUkRJQ1RTIChwbGF5Ym9vayBONCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZXJyb3JzIFNVQkpFQ1QgKHRoZSBDTEk7IHRoZSBkYWVtb24gYW5zd2VycyBIVFRQIHN0YXR1c2VzIHRoZSBDTEkgbWFwcykgwrdcbiAqIHNlcnZlRGlzdCBTVUJKRUNUIChgcmVzb2x2ZU1vZGVgLCBgc2VydmVGcm9tRGlzdGApIMK3IGhvdXNla2VlcGluZyBTVUJKRUNULCBhbGxcbiAqIHRocmVlIGV4cG9ydHMgKGBzaG91bGRJZGxlQ2xvc2VgIHZpYSBgc3RhcnRIb3VzZWtlZXBpbmdgJ3MgaWRsZS1jbG9zZSwgdGhlXG4gKiBzbmFwc2hvdCBzd2VlcCDigJQgaGVyZSB0aGUgbWFuaWZlc3QgaXMgd3JpdHRlbiBvbiBldmVyeSBjaGFuZ2UgaW5zdGVhZCwgc28gdGhlXG4gKiBzd2VlcCdzIHNuYXBzaG90IGhvb2sgaXMgZGVsaWJlcmF0ZWx5IE5PVCBwYXNzZWQg4oCUIGFuZCBgZHJhaW5BbmRTdG9wYCkgwrdcbiAqIHRhaWxFdmVudHMgU1VCSkVDVCAodGhlIENMSSdzIGB0YWlsYCkgwrcgaGVhcnRiZWF0IFNVQkpFQ1QgKGAuL2hlYXJ0YmVhdC50c2ApIMK3XG4gKiBkaXNjb3ZlcnkgU1VCSkVDVCAoc2Vzc2lvbi1KU09OLCBFMTM6IGBzY3JpcHRvcml1bS08aWQ+Lmpzb25gICtcbiAqIGBzY3JpcHRvcml1bS1sYXRlc3QuanNvbmAgaW4gdG1wZGlyIHZpYSBgd3JpdGVGaWxlQXRvbWljYC9gdW5saW5rSWZNYXRjaGVzYCkgwrdcbiAqIGV2ZW50TG9nIFNVQkpFQ1QsIFdJVEggRVBPQ0ggKFE2KSDCtyBzc2UgU1VCSkVDVCAoYEdFVCAvZXZlbnRzYCkgwrdcbiAqIGxpYi9wcmludEpzb24gU1VCSkVDVCAodGhlIENMSSBzcGVha3MgdGhlIGFnZW50IHdpcmUpLlxuICpcbiAqIOKUgOKUgCBURUFSRE9XTiBPUkRFUiAocmVnaXN0ZXIgQTYpLCBTVEFURUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZ2xhbW91cidzIG9yZGVyOiBzdG9wIGhvdXNla2VlcGluZyDihpIgY2xvc2UgdGhlIHdhdGNoZXJzIOKGkiBwZXJzaXN0IHRoZVxuICogbWFuaWZlc3Qg4oaSIHVubGluayBkaXNjb3Zlcnkg4oaSIGVtaXQgYGNsb3NlZGAg4oaSIGRyYWluLiBEaXNjb3ZlcnkgZ29lcyBCRUZPUkUgdGhlXG4gKiBgY2xvc2VkYCBmcmFtZSBzbyBhIHRhaWwgdGhhdCBzZWVzIGBjbG9zZWRgIGFuZCBhIENMSSB2ZXJiIHRoYXQgcnVucyByaWdodFxuICogYWZ0ZXIgaXQgYm90aCBmaW5kIG5vIHBvaW50ZXIgdG8gYSBkYWVtb24gdGhhdCBpcyBsZWF2aW5nOyB0aGUgb3RoZXIgb3JkZXJcbiAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhIHZlcmIgcmVzb2x2ZXMgYSBzZXNzaW9uIHRoYXQgd2lsbCByZWZ1c2UgaXQuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgdHlwZSBGU1dhdGNoZXIsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMsIHVubGlua1N5bmMsIHdhdGNoIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgdW5saW5rSWZNYXRjaGVzLCB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudExvZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ldmVudExvZy50c1wiO1xuaW1wb3J0IHsgZHJhaW5BbmRTdG9wLCBzdGFydEhvdXNla2VlcGluZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHNcIjtcbmltcG9ydCB7IHJlZnVzZUZvcmVpZ25PcmlnaW4gfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvb3JpZ2luLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZSBhcyByZXNvbHZlTW9kZUluLCBzZXJ2ZUZyb21EaXN0IH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NlcnZlRGlzdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBTc2VDbGllbnRzLCBzc2VSZXNwb25zZSB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zc2UudHNcIjtcbmltcG9ydCB7IHF1b3RlTGFiZWwgfSBmcm9tIFwiLi9hbmNob3JzXCI7XG5pbXBvcnQgeyB1bmlmaWVkIH0gZnJvbSBcIi4vZGlmZlwiO1xuaW1wb3J0IHsgc3VtbWFyeSB9IGZyb20gXCIuL2RvY3RvclwiO1xuaW1wb3J0IHsgSURMRV9USU1FT1VUX1NFQywgU1NFX0hFQVJUQkVBVF9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgdHlwZSBBY3QsIHR5cGUgQWZ0ZXIsIHR5cGUgQmVmb3JlLCBIaXN0b3J5LCB0eXBlIEludmVyc2UsIHBsYW5JbnZlcnNlIH0gZnJvbSBcIi4vaGlzdG9yeVwiO1xuaW1wb3J0IHsgdHlwZSBQaWNrS2luZCwgcGFyc2VQaWNrZXJPdXRwdXQsIHBpY2tlckNvbW1hbmQsIHdhc0NhbmNlbGxlZCB9IGZyb20gXCIuL3BpY2tlclwiO1xuaW1wb3J0IHR5cGUge1xuICBBZ2VudENtZCxcbiAgQ2xpZW50TXNnLFxuICBDbG9zZWRCeSxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgU2VydmVyTXNnLFxuICBTdHJ1Y3R1cmVPcCxcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgU2NyZWVuLCBzZWxlY3Rpb25PblNjcmVlbiB9IGZyb20gXCIuL3NlbGVjdGlvblwiO1xuaW1wb3J0IHsgdHlwZSBGaWxlRXZlbnQsIFNlc3Npb24sIFNlc3Npb25FcnJvciwgc2lkZU5hbWUgfSBmcm9tIFwiLi9zZXNzaW9uXCI7XG5pbXBvcnQgeyBsaXN0RGlyLCBQYXRoRXJyb3IgfSBmcm9tIFwiLi90cmVlXCI7XG5pbXBvcnQge1xuICBhdHRlbnRpb25LZXksXG4gIERFRkFVTFRfU05PT1pFX01TLFxuICBub3RlRXZlbnRGYWN0cyxcbiAgbm90ZXNXYWl0aW5nLFxuICB3YWl0aW5nT24sXG59IGZyb20gXCIuL3dhaXRpbmdcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7XG4gIHBvcnQ/OiBudW1iZXI7XG4gIHJlc3RvcmU/OiBzdHJpbmc7XG4gIHRpbWVvdXRTPzogbnVtYmVyO1xuICAvKipcbiAgICogRTIzICsgRTY3OiBhIE5FVyBzZXNzaW9uJ3Mgd29ya3NwYWNlIOKAlCB0aGUgb25lIGZvbGRlciBgb3BlbmAgd2FzIGdpdmVuLFxuICAgKiBlbHNlIHRoZSBkaXJlY3RvcnkgaXQgcmFuIGluICh0aGUgQ0xJIGRlY2lkZXMpLiBBIHJlc3RvcmUga2VlcHMgaXRzIG93bi5cbiAgICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHRhaWwgZnJhbWUncyBwYXlsb2FkLiBUaGUgbG9nIHN0YW1wcyBgaWRgIGFuZCBgZXBvY2hgLiAqL1xudHlwZSBMb2dFdmVudCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyB0eXBlOiBzdHJpbmcgfTtcblxuLyoqIEhvdyBsb25nIGEgYnVyc3Qgb2Ygd2F0Y2hlciBldmVudHMgb24gb25lIHBhdGggc2V0dGxlcyBiZWZvcmUgaXQgaXMgcmVhZC4gKi9cbmNvbnN0IFdBVENIX1NFVFRMRV9NUyA9IDYwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgLy8gTW9kZSBCRUZPUkUgYW55IHdyaXRlOiBhIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0XG4gIC8vIGRpZSBhdCB0aGUgaW1wb3J0IGhhdmluZyBjcmVhdGVkIG5vdGhpbmcgKGdsYW1vdXIncyBtZWFzdXJlZCBvcmRlcikuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuICBjb25zdCBkZXZJbmRleCA9XG4gICAgbW9kZSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGNvbnN0IHNlc3Npb24gPSBvcHRzLnJlc3RvcmVcbiAgICA/IFNlc3Npb24ucmVzdG9yZShob21lLCBvcHRzLnJlc3RvcmUpXG4gICAgOiBTZXNzaW9uLmNyZWF0ZShob21lLCB1bmRlZmluZWQsIG9wdHMud29ya3NwYWNlKTtcbiAgY29uc3Qgc2Vzc2lvbklkID0gc2Vzc2lvbi5pZDtcbiAgbGV0IHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBUaGUgZG9jdW1lbnQgdGV4dCBvbiBzY3JlZW4g4oCUIHRoZSBvcGVuIGRvY3VtZW50IGF0IGl0cyBhY3RpdmUgdmVyc2lvbi4gKi9cbiAgY29uc3Qgc2NyZWVuID0gKCk6IFNjcmVlbiB8IG51bGwgPT4ge1xuICAgIGNvbnN0IGQgPSBzZXNzaW9uLm9wZW5Eb2NTbHVnID8gc2Vzc2lvbi5maW5kRG9jKHNlc3Npb24ub3BlbkRvY1NsdWcpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8geyBkb2M6IGQuc2x1ZywgdmVyc2lvbjogZC5hY3RpdmUgfSA6IG51bGw7XG4gIH07XG4gIC8qKlxuICAgKiBUaGUgaGVsZCBzZWxlY3Rpb24sIG9uY2UgdGhlIHRleHQgaXQgd2FzIG1hZGUgaW4gaXMgc3RpbGwgdGhlIHRleHQgb25cbiAgICogc2NyZWVuIChFNjYpLiDim5QgUkVBRCBUSFJPVUdIIFRISVMsIE5FVkVSIGBzZWxlY3Rpb25gIERJUkVDVExZOiB0aGUgb3BlblxuICAgKiBkb2N1bWVudCBtb3ZlcyB1bmRlciBpdCBmcm9tIG1hbnkgcGxhY2VzICh0aGUgc3VyZmFjZSdzIGBvcGVuYCBhbmRcbiAgICogYG9wZW4uZG9jYCwgdGhlIGFnZW50LCBhIHZlcnNpb24gYWN0aXZhdGVkLCBhIGRvY3VtZW50IHJlbW92ZWQpLCBhbmQgYVxuICAgKiBjaGVjayBhdCBlYWNoIG9mIHRoZW0gaXMgYSBjaGVjayBzb21lIGZ1dHVyZSBwYXRoIGZvcmdldHMuIERyb3BwaW5nIGl0XG4gICAqIGhlcmUsIG9uIHRoZSBuZXh0IHJlYWQsIGlzIHdoeSBnb2luZyBiYWNrIHRvIHRoZSBmaXJzdCBkb2N1bWVudCBkb2VzIG5vdFxuICAgKiByZXZpdmUgaXQg4oCUIGV2ZXJ5IG9uZSBvZiB0aG9zZSBwYXRocyBicm9hZGNhc3RzLCBhbmQgdGhlIGJyb2FkY2FzdCByZWFkcy5cbiAgICovXG4gIGNvbnN0IGhlbGRTZWxlY3Rpb24gPSAoKTogU2VsZWN0aW9uIHwgbnVsbCA9PiB7XG4gICAgc2VsZWN0aW9uID0gc2VsZWN0aW9uT25TY3JlZW4oc2VsZWN0aW9uLCBzY3JlZW4oKSk7XG4gICAgcmV0dXJuIHNlbGVjdGlvbjtcbiAgfTtcblxuICAvLyAtLS0gcHJlZnM6IHBlci12aWV3ZXIgY29udmVuaWVuY2VzIHRoYXQgb3V0bGl2ZSBhIHNlc3Npb24ncyBwb3J0IC0tLS0tLS0tLS0tLVxuICAvLyBCcm93c2VyIHN0b3JhZ2UgaXMga2V5ZWQgYnkgb3JpZ2luLCBwb3J0IGluY2x1ZGVkLCBhbmQgZXZlcnkgc2Vzc2lvbiBnZXRzIGFcbiAgLy8gbmV3IHBvcnQg4oCUIHNvIGEgcGFuZSBzaXplIGtlcHQgaW4gbG9jYWxTdG9yYWdlIHJlc2V0cyBhdCB0aGUgbmV4dCBgb3BlbmAuXG4gIC8vIFRoZXkgbGl2ZSBpbiB0aGUgaG9tZSBpbnN0ZWFkLCBzaGFyZWQgYnkgZXZlcnkgc2Vzc2lvbiBvZiB0aGlzIGhvbWUuXG4gIGNvbnN0IHByZWZzRmlsZSA9IGpvaW4oaG9tZSwgXCJwcmVmcy5qc29uXCIpO1xuICBjb25zdCBQUkVGX0tFWSA9IC9eW2Etel1bYS16MC05Oi5fLV17MCw2M30kLztcbiAgY29uc3QgUFJFRl9WQUxVRV9NQVggPSA0MDk2O1xuICBjb25zdCBQUkVGX0tFWVNfTUFYID0gNjQ7XG4gIC8qKlxuICAgKiBSZWFkIHRoZSBob21lJ3MgcHJlZnMgRlJFU0guIFNldmVyYWwgc2Vzc2lvbnMgY2FuIHNoYXJlIG9uZSBob21lIChFMTMpLCBlYWNoXG4gICAqIGl0cyBvd24gZGFlbW9uLCBzbyBhIGNvcHkgbG9hZGVkIG9uY2UgYXQgYm9vdCBhbmQgd3JpdHRlbiBiYWNrIHdob2xlIHdvdWxkXG4gICAqIGVyYXNlIGEga2V5IGFub3RoZXIgc2Vzc2lvbiB3cm90ZSBzaW5jZSAodmVyaWZ5IHBhc3MpLiBFdmVyeSB3cml0ZSBpc1xuICAgKiB0aGVyZWZvcmUgcmVhZCDihpIgc2V0IG9uZSBrZXkg4oaSIHdyaXRlLCBhbmQgZXZlcnkgc25hcHNob3QgcmVhZHMgdGhlIGZpbGUuXG4gICAqIE9ubHkgd2VsbC1mb3JtZWQgZW50cmllcyBzdXJ2aXZlIGEgcmVhZDsgYSBiYWQgZmlsZSByZWFkcyBhcyBlbXB0eSBhbmQgaXNcbiAgICogcmVwbGFjZWQgYnkgdGhlIG5leHQgd3JpdGUuXG4gICAqL1xuICBjb25zdCByZWFkUHJlZnMgPSAoKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9PiB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByZWZzRmlsZSwgXCJ1dGY4XCIpKSBhcyB1bmtub3duO1xuICAgICAgaWYgKHJhdyAmJiB0eXBlb2YgcmF3ID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocmF3KSlcbiAgICAgICAgICBpZiAoUFJFRl9LRVkudGVzdChrKSAmJiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2Lmxlbmd0aCA8PSBQUkVGX1ZBTFVFX01BWCkgb3V0W2tdID0gdjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIHByZWZzIHlldCwgb3IgdW5yZWFkYWJsZSDigJQgZW1wdHkgKi9cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfTtcbiAgY29uc3QgdXNlckhvbWUgPSBob21lZGlyKCk7XG4gIC8qKlxuICAgKiBFNTM6IHRoZSBzbm9vemUgdGhlIGFnZW50IGFza2VkIGZvciwgYW5kIHRoZSBtZXNzYWdlcyBhbHJlYWR5IG51ZGdlZC5cbiAgICpcbiAgICog4puUIE9ORSBOVURHRSBQRVIgTUVTU0FHRSwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIEFOVEktTkFHIFJVTEUuIENvbGU6IFwid2VcbiAgICogZG9uJ3Qgd2FudCB0byBoYXZlIGEgc2l0dWF0aW9uIHdoZXJlIGFuIGFnZW50IGtlZXBzIGdldHRpbmcgcGluZ2VkIGFib3V0XG4gICAqIHNvbWV0aGluZyBhbmQgaXQncyBsaWtlLCBubywgSSdtIGFjdHVhbGx5IHdvcmtpbmcuXCIgU28gYSBtZXNzYWdlIGlkIGVudGVyc1xuICAgKiBgbnVkZ2VkYCB0aGUgZmlyc3QgdGltZSBpdCBpcyByZXBvcnRlZCDigJQgb3IgdGhlIG1vbWVudCB0aGUgYWdlbnQgc25vb3plcyBpdFxuICAgKiDigJQgYW5kIG5ldmVyIGxlYXZlcy4gQSBzbm9vemUgRVhQSVJJTkcgdGhlcmVmb3JlIGNoYW5nZXMgd2hhdCB0aGUgSFVNQU5cbiAgICogc2VlcyAoYmFjayB0byBcIm1heSBiZSBzdHVja1wiLCBiZWNhdXNlIHRoZXkgYXJlIG93ZWQgdGhlIHRydXRoKSB3aXRob3V0XG4gICAqIHBpbmdpbmcgdGhlIGFnZW50IGFnYWluLlxuICAgKlxuICAgKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBkZWxpYmVyYXRlbHkuIEEgcmVzdG9yZWQgc2Vzc2lvbiB3aG9zZVxuICAgKiBodW1hbiB3YXMgbGVmdCB3YWl0aW5nIFNIT1VMRCB0ZWxsIHRoZSBhZ2VudCB0aGF0IGFycml2ZXMg4oCUIHRoZSB3YWl0IGlzXG4gICAqIHJlYWwgYW5kIHRoZSBuZXcgYWdlbnQgaGFzIG5vdCBoZWFyZCBhYm91dCBpdC5cbiAgICovXG4gIGxldCBhY2tub3dsZWRnZWRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBjb25zdCBudWRnZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgLyoqXG4gICAqIEU2MDogdGhlIENPTlRFWFQncyB1bmRvIGhpc3Rvcnkg4oCUIG5vdCB0aGUgZWRpdG9yJ3MsIHdoaWNoIENvZGVNaXJyb3Igb3ducy5cbiAgICogSW4gbWVtb3J5IG9uIHB1cnBvc2UgKHNlZSBgaGlzdG9yeS50c2ApOiBhbiBpbnZlcnNlIGRlc2NyaWJlcyB0aGUgd29ybGQgYXNcbiAgICogaXQgaXMgbm93LCBhbmQgYSBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGZpbGVzIHNvbWVib2R5IGhhc1xuICAgKiBzaW5jZSBtb3ZlZCBieSBoYW5kLlxuICAgKi9cbiAgY29uc3QgaGlzdG9yeSA9IG5ldyBIaXN0b3J5KCk7XG5cbiAgY29uc3Qgdmlld1N0YXRlID0gKCk6IFB1YmxpY1N0YXRlID0+IHtcbiAgICBjb25zdCBiYXNlID0geyAuLi5zZXNzaW9uLnZpZXcobW9kZSwgaGVsZFNlbGVjdGlvbigpKSwgcHJlZnM6IHJlYWRQcmVmcygpLCB1c2VySG9tZSB9O1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICB3YWl0aW5nOiB3YWl0aW5nT24oYmFzZS5jaGF0LCBub3csIHsgYWNrbm93bGVkZ2VkVW50aWwgfSksXG4gICAgICBub3Rlc1dhaXRpbmc6IG5vdGVzV2FpdGluZyhzZXNzaW9uLm5vdGVGYWN0cygpLCBiYXNlLmNoYXQsIG5vdywgeyBhY2tub3dsZWRnZWRVbnRpbCB9KSxcbiAgICAgIGhpc3Rvcnk6IGhpc3RvcnkudmlldygpLFxuICAgIH07XG4gIH07XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKlxuICAgKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLlxuICAgKlxuICAgKiBgZm9ySHVtYW5gLCB3aGVuIGdpdmVuLCBpcyB0aGUgY2hhdCdzIGxpbmUgYW5kIGB0ZXh0YCBzdGF5cyB0aGUgYWdlbnQnc1xuICAgKiAodGhlIHRhaWwgZXZlbnQpLiBGb3IgYSBmYWN0IHdob3NlIGFnZW50IHRleHQgaXMgaW5zdHJ1Y3Rpb25zIChcIkRvIE5PVFxuICAgKiBjcmVhdGUgYW5vdGhlciB2ZXJzaW9u4oCmXCIpIG9yIGNhcnJpZXMgYSBsb25nIHBhdGg6IHRoZSBodW1hbiB3YXMgc2hvd25cbiAgICogdGhlIGFnZW50J3Mgb3JkZXJzLCBhbmQgdGhlIHBhdGggb3ZlcmZsb3dlZCB0aGUgY2hhdCBjb2x1bW4gKHZlcmlmaWVyLFxuICAgKiAyMDI2LTEwLTAxKS4gVGhlIHNhbWUgc3BsaXQgYHNhdmVgIGFscmVhZHkgbWFrZXMg4oCUIGEgc2hvcnQgY2hhdCBsaW5lLCBhXG4gICAqIHN0cnVjdHVyZWQgZXZlbnQuXG4gICAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30sIGZvckh1bWFuPzogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBmb3JIdW1hbiA/PyB0ZXh0KTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwic3lzdGVtXCIsIHRleHQsIHRzOiBtLnRzLCAuLi5mYWN0IH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gIH07XG5cbiAgLy8gLS0tIHRoZSB3YXRjaGVyIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vXG4gIC8vIOKaoCBERVZJQVRJT04gRlJPTSBUSEUgQlJJRUYsIFdJVEggSVRTIFJFQVNPTjogYG5vZGU6ZnNgIGB3YXRjaGAgKEJ1bidzXG4gIC8vIGJ1aWx0LWluKSwgTk9UIGBAcGFyY2VsL3dhdGNoZXJgLiBgQHBhcmNlbC93YXRjaGVyYCBpcyBhIG5hdGl2ZSBhZGRvbiB3aG9zZVxuICAvLyBsb2FkZXIgZG9lcyBhIHJ1bnRpbWUgYHJlcXVpcmUoKWAgb2YgYSBwZXItcGxhdGZvcm0gcGFja2FnZTsgYnVuZGxlZCBpbnRvXG4gIC8vIGBkaXN0L3NlcnZlci5qc2AgaXQgaXMgbm90IGlubGluZWQsIHNvIHRoZSBzaGlwcGVkIGRhZW1vbiB3b3VsZCBuZWVkIGFcbiAgLy8gYG5vZGVfbW9kdWxlc2AgdGhlIG1hcmtldHBsYWNlIG5ldmVyIGNvcGllcyAoaW1wb3J0LWJvdW5kYXJ5IHdhcmQgMWInc1xuICAvLyBcInRoZSBzaGlwcGVkIGV4ZWN1dGlvbiBwYXRoIGNhcnJpZXMgbm8gZGVwZW5kZW5jaWVzXCIpLiBNZWFzdXJlZCB1bmRlciBCdW5cbiAgLy8gMS40LjAgb24gbWFjT1MgYmVmb3JlIGNob29zaW5nOiBhIHJlY3Vyc2l2ZSBkaXJlY3Rvcnkgd2F0Y2ggcmVwb3J0cyBhblxuICAvLyBpbi1wbGFjZSB3cml0ZSwgYW4gYXRvbWljIHRtcCtyZW5hbWUgc2F2ZSwgYW5kIGJvdGggYWdhaW4gaW4gYVxuICAvLyBzdWJkaXJlY3Rvcnkg4oCUIHRoZSBmb3VyIGNhc2VzIGludmVzdGlnYXRpb24gwqc1IGRyb3ZlIEBwYXJjZWwvd2F0Y2hlciBvbi5cbiAgLy8gVGhlIGhhc2gtY29tcGFyZSBhbmQgc2VsZi13cml0ZSBzdXBwcmVzc2lvbiBhcmUgdW5jaGFuZ2VkIChzZXNzaW9uLnRzKS5cbiAgY29uc3Qgd2F0Y2hlcnMgPSBuZXcgTWFwPHN0cmluZywgRlNXYXRjaGVyPigpO1xuICBjb25zdCBwZW5kaW5nID0gbmV3IE1hcDxzdHJpbmcsIFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+PigpO1xuICBjb25zdCBvbkZzID0gKGFiczogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgdCA9IHBlbmRpbmcuZ2V0KGFicyk7XG4gICAgaWYgKHQpIGNsZWFyVGltZW91dCh0KTtcbiAgICBwZW5kaW5nLnNldChcbiAgICAgIGFicyxcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBwZW5kaW5nLmRlbGV0ZShhYnMpO1xuICAgICAgICBsZXQgZXY6IEZpbGVFdmVudCB8IG51bGwgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGV2ID0gc2Vzc2lvbi5vbkZpbGVFdmVudChhYnMpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiB3YXRjaGVyOiAke2V9XFxuYCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV2KSBoYW5kbGVGaWxlRXZlbnQoZXYpO1xuICAgICAgfSwgV0FUQ0hfU0VUVExFX01TKSxcbiAgICApO1xuICB9O1xuICBjb25zdCBzeW5jV2F0Y2hlcnMgPSAoKSA9PiB7XG4gICAgY29uc3Qgd2FudCA9IG5ldyBNYXAoXG4gICAgICBzZXNzaW9uLndhdGNoUm9vdHMoKS5tYXAoKHIpID0+IFtgJHtyLnJlY3Vyc2l2ZSA/IFwiUlwiIDogXCJGXCJ9OiR7ci53YXRjaH0+JHtyLnBhdGh9YCwgcl0pLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBba2V5LCB3XSBvZiB3YXRjaGVycylcbiAgICAgIGlmICghd2FudC5oYXMoa2V5KSkge1xuICAgICAgICB3LmNsb3NlKCk7XG4gICAgICAgIHdhdGNoZXJzLmRlbGV0ZShrZXkpO1xuICAgICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgcl0gb2Ygd2FudCkge1xuICAgICAgaWYgKHdhdGNoZXJzLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIFdhdGNoZWQgYXQgdGhlIFJFQUxQQVRILCByZXBvcnRlZCB1bmRlciB0aGUgc3RvcmVkIHBhdGggZm9ybVxuICAgICAgICAvLyAodmVyaWZ5LXBhc3MgZml4IDMg4oCUIHNlZSBTZXNzaW9uLndhdGNoUm9vdHMpLlxuICAgICAgICBjb25zdCB3ID0gd2F0Y2goci53YXRjaCwgeyByZWN1cnNpdmU6IHIucmVjdXJzaXZlIH0sIChfZXZlbnQsIG5hbWUpID0+IHtcbiAgICAgICAgICBpZiAobmFtZSkgb25Gcyhqb2luKHIucGF0aCwgbmFtZS50b1N0cmluZygpKSk7XG4gICAgICAgICAgZWxzZSBpZiAoci5lbnRyeUlkKSBvbkZzKHIucGF0aCk7XG4gICAgICAgIH0pO1xuICAgICAgICB3Lm9uKFwiZXJyb3JcIiwgKCkgPT4ge1xuICAgICAgICAgIC8qIHRoZSBkaXJlY3Rvcnkgd2VudCBhd2F5OyB0aGUgbmV4dCBzeW5jIGRyb3BzIGl0ICovXG4gICAgICAgIH0pO1xuICAgICAgICB3YXRjaGVycy5zZXQoa2V5LCB3KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiB1bndhdGNoYWJsZSAoZ29uZSwgcGVybWlzc2lvbnMpIOKAlCBvdXRzaWRlIGNoYW5nZXMgdGhlcmUgZ28gdW5zZWVuICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUZpbGVFdmVudCA9IChldjogRmlsZUV2ZW50KSA9PiB7XG4gICAgc3dpdGNoIChldi5raW5kKSB7XG4gICAgICBjYXNlIFwidmVyc2lvbi5jaGFuZ2VkXCI6XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBldi50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNyZWF0ZWRcIjpcbiAgICAgICAgYW5ub3VuY2UoYHYke2V2LnZlcnNpb259IG9mICR7ZXYuZG9jfSBhcHBlYXJlZCAod3JpdHRlbiBkaXJlY3RseSB0byAke2V2LnBhdGh9KWAsIHtcbiAgICAgICAgICBmYWN0OiBcInZlcnNpb24uY3JlYXRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiYWN0aXZlLm91dHNpZGVcIjpcbiAgICAgICAgLy8gRTI6IHRoZSBhZ2VudCBuZXZlciB3cml0ZXMgdGhlIHZlcnNpb24gdGhlIGh1bWFuIGlzIGVkaXRpbmcuIFRoZVxuICAgICAgICAvLyBvdXRzaWRlIHRleHQgaXMgS0VQVCBhcyBhIG5ldyBhZ2VudCB2ZXJzaW9uIGFuZCB0aGUgYWN0aXZlIHZlcnNpb25cbiAgICAgICAgLy8ga2VlcHMgdGhlIGh1bWFuJ3MgdGV4dCDigJQgbm90aGluZyBpcyBsb3N0LCBhbmQgdGhlIGh1bWFuJ3MgYnVmZmVyIGlzXG4gICAgICAgIC8vIG5vdCB0b3VjaGVkICh2ZXJpZnktcGFzcyBmaXggNCkuXG4gICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICBldi5kb2MsXG4gICAgICAgICAgZXYudmVyc2lvbixcbiAgICAgICAgICBldi5wYXRoLFxuICAgICAgICAgIGV2LnByZXNlcnZlZEFzLFxuICAgICAgICAgIGV2LnByZXNlcnZlZFBhdGgsXG4gICAgICAgICAgZXYuYWN0aXZhdGVkQmVmb3JlV3JpdHRlbixcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLnJlbG9hZGVkXCI6XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBldi50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sg4oCUIHJlbG9hZGVkICh5b3UgaGFkIG5vIHVuc2F2ZWQgZWRpdHMpLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwuY29uZmxpY3RcIjpcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayB3aGlsZSB5b3UgaGF2ZSB1bnNhdmVkIGVkaXRzLiBTYXZlIG92ZXJ3cml0ZXMgaXQgd2l0aCB5b3VyczsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgICAgIHsgZmFjdDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGV2LmRvYyB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidHJlZVwiOlxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGFubm91bmNlT3V0c2lkZSA9IChcbiAgICBkb2M6IHN0cmluZyxcbiAgICB2ZXJzaW9uOiBudW1iZXIsXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIHByZXNlcnZlZEFzOiBudW1iZXIsXG4gICAgcHJlc2VydmVkUGF0aDogc3RyaW5nLFxuICAgIGFjdGl2YXRlZEJlZm9yZVdyaXR0ZW46IGJvb2xlYW4sXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIC8vICMxMTc6IHRoZSBodW1hbiBhY3RpdmF0ZWQgdGhlIGFnZW50J3MgYHZlcnNpb24tbmV3YCBjb3B5IGJlZm9yZSB0aGVcbiAgICAgIC8vIGFnZW50IGhhZCB3cml0dGVuIGl0LiBUaGUgYWdlbnQgZm9sbG93ZWQgdGhlIHJ1bGU7IHRoZSB0aW1pbmcgYnJva2VcbiAgICAgIC8vIGl0LiBTYXkgdGhhdCwgYW5kIG5hbWUgdGhlIGFjdCDigJQgaXRzIHRleHQgaXMgYWxyZWFkeSBzYWZlLCBzbyBhbm90aGVyXG4gICAgICAvLyB2ZXJzaW9uIHdvdWxkIG9ubHkgYWRkIGEgZHVwbGljYXRlLiBBZ2VudHMgcm91dGUgb24gdGhlIHN0cnVjdHVyZWRcbiAgICAgIC8vIGBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuYCwgbmV2ZXIgb24gdGhpcyB0ZXh0LlxuICAgICAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlblxuICAgICAgICA/IGBUaGUgaHVtYW4gYWN0aXZhdGVkIHYke3ZlcnNpb259IG9mICR7ZG9jfSBiZWZvcmUgeW91IGhhZCB3cml0dGVuIGl0LCBzbyB5b3VyIHdyaXRlIGxhbmRlZCBvbiB0aGUgQUNUSVZFIHZlcnNpb24uIE5vdGhpbmcgaXMgbG9zdDogeW91ciB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9ICgke3ByZXNlcnZlZFBhdGh9KTsgdiR7dmVyc2lvbn0ga2VlcHMgaXRzIG93biB0ZXh0LiBEbyBOT1QgY3JlYXRlIGFub3RoZXIgdmVyc2lvbiDigJQgc2F5IGluIHRoZSBjaGF0IHRoYXQgdiR7cHJlc2VydmVkQXN9IGlzIHlvdXIgZHJhZnQgYW5kIGxldCB0aGUgaHVtYW4gYWN0aXZhdGUgaXQuIE5leHQgdGltZSwgcHJvcG9zZSBhIHZlcnNpb24gaW4gb25lIHN0ZXAgd2l0aCB2ZXJzaW9uLW5ldyAtLWJvZHktZmlsZS5gXG4gICAgICAgIDogYHYke3ZlcnNpb259IG9mICR7ZG9jfSBpcyB0aGUgQUNUSVZFIHZlcnNpb24gYW5kIHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yLiBUaGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc307IHRoZSBhY3RpdmUgdmVyc2lvbiBrZWVwcyB5b3VyIHRleHQuIEFnZW50IGVkaXRzIGJlbG9uZyBpbiBhIG5ldyB2ZXJzaW9uICh2ZXJzaW9uLW5ldykuYCxcbiAgICAgIHtcbiAgICAgICAgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLFxuICAgICAgICBkb2MsXG4gICAgICAgIHZlcnNpb24sXG4gICAgICAgIHBhdGgsXG4gICAgICAgIHByZXNlcnZlZEFzLFxuICAgICAgICBwcmVzZXJ2ZWRQYXRoLFxuICAgICAgICBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuLFxuICAgICAgfSxcbiAgICAgIC8vIFRoZSBodW1hbidzIG93biBsaW5lOiB3aGF0IGhhcHBlbmVkIHRvIHRoZWlyIHZlcnNpb24sIG5vIHBhdGgsIG5vXG4gICAgICAvLyBpbnN0cnVjdGlvbnMgbWVhbnQgZm9yIHRoZSBhZ2VudC4gSXQgbmFtZXMgdGhlIGRvY3VtZW50IGJ5IHRoZSBuYW1lXG4gICAgICAvLyB0aGUgaHVtYW4gc2VlcyBvbiBpdHMgdGFiIOKAlCB0d28gZG9jdW1lbnRzIGluIG9uZSBjb252ZXJzYXRpb24gbXVzdCBub3RcbiAgICAgIC8vIHJlYWQgdGhlIHNhbWUgKHNlY29uZCB2ZXJpZmllciwgMjAyNi0xMC0wMSkuXG4gICAgICBodW1hbk91dHNpZGVMaW5lKHNlc3Npb24uZG9jKGRvYykubmFtZSwgdmVyc2lvbiwgcHJlc2VydmVkQXMsIGFjdGl2YXRlZEJlZm9yZVdyaXR0ZW4pLFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uLCBieSB9KTtcbiAgICBjb25zdCB2aWV3ID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICBjb25zdCBwYXRoID0gdmlldy52ZXJzaW9ucy5maW5kKCh2KSA9PiB2Lm4gPT09IHZlcnNpb24pPy5wYXRoID8/IG51bGw7XG4gICAgc2VuZCh7XG4gICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgZG9jOiByLnNsdWcsXG4gICAgICB2ZXJzaW9uLFxuICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihyLnNsdWcsIHZlcnNpb24pLnRleHQsXG4gICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgIH0pO1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICBcInN5c3RlbVwiLFxuICAgICAgYCR7YnkgPT09IFwiYWdlbnRcIiA/IFwiQWdlbnRcIiA6IFwiWW91XCJ9IG1hZGUgdiR7dmVyc2lvbn0gb2YgJHtyLnNsdWd9IGFjdGl2ZSAod2FzIHYke3IucHJldmlvdXN9KS5gLFxuICAgICk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImFjdGl2YXRlZFwiLCBieSwgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoLCB0czogbS50cyB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCB9O1xuICB9O1xuXG4gIC8qKlxuICAgKiBFMjQ6IG9uZSBzdHJ1Y3R1cmUgY2hhbmdlLCBmcm9tIGVpdGhlciBwYXJ0eSDigJQgdGhlIHNhbWUgc2Vzc2lvbiBtZXRob2QsIHRoZVxuICAgKiBzYW1lIGFubm91bmNlbWVudCAobmFtaW5nIHdobyBkaWQgaXQpLCB0aGUgc2FtZSB0YWlsIGZhY3QuIFJldHVybnMgdGhlIHBhdGhcbiAgICogdGhlIGNoYW5nZSBsYW5kZWQgYXQsIHdoaWNoIHRoZSBzdXJmYWNlIHVzZXMgdG8gb3BlbiBvciByZW5hbWUgaXQuXG4gICAqL1xuICBjb25zdCBTVFJVQ1RVUkVfT1BTID0gbmV3IFNldDxzdHJpbmc+KFtcbiAgICBcImRvYy5jcmVhdGVcIixcbiAgICBcImZvbGRlci5jcmVhdGVcIixcbiAgICBcIm1vdmVcIixcbiAgICBcInJlbmFtZVwiLFxuICAgIFwiaGlkZVwiLFxuICAgIFwidW5oaWRlXCIsXG4gICAgXCJzZXQubWFrZVwiLFxuICAgIFwiaW1wb3J0XCIsXG4gICAgXCJ3b3Jrc3BhY2Uuc2V0XCIsXG4gIF0gc2F0aXNmaWVzIFN0cnVjdHVyZU9wW1widHlwZVwiXVtdKTtcbiAgY29uc3QgaXNTdHJ1Y3R1cmVPcCA9IChtOiB7IHR5cGU6IHN0cmluZyB9KTogbSBpcyBTdHJ1Y3R1cmVPcCA9PiBTVFJVQ1RVUkVfT1BTLmhhcyhtLnR5cGUpO1xuXG4gIGNvbnN0IHN0cnVjdHVyZSA9IChvcDogU3RydWN0dXJlT3AsIGJ5OiBcImh1bWFuXCIgfCBcImFnZW50XCIpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgY29uc3Qgd2hvID0gYnkgPT09IFwiYWdlbnRcIiA/IFwiQWdlbnRcIiA6IFwiWW91XCI7XG4gICAgLy8g4puUIENBUFRVUkVEIEJFRk9SRSBUSEUgQUNULCBiZWNhdXNlIGV2ZXJ5IGZpZWxkIGhlcmUgaXMgc29tZXRoaW5nIHRoZSBhY3RcbiAgICAvLyBDSEFOR0VTOiByZWFkaW5nIGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgYWZ0ZXJ3YXJkcyByZXR1cm5zIHRoZSBsaXN0XG4gICAgLy8gaW5jbHVkaW5nIHdoYXQgd2FzIGp1c3QgaGlkZGVuLCB3aGljaCByZXN0b3JlcyBub3RoaW5nIChFNjApLlxuICAgIGNvbnN0IGJlZm9yZTogQmVmb3JlID0ge1xuICAgICAgLi4uKG9wLnR5cGUgPT09IFwiaGlkZVwiID8geyBoaWRkZW46IHNlc3Npb24uaGlkZGVuQmVmb3JlKG9wLnBhdGgpID8/IHVuZGVmaW5lZCB9IDoge30pLFxuICAgICAgLi4uKG9wLnR5cGUgPT09IFwidW5oaWRlXCIgPyB7IGhpZGRlbjogc2Vzc2lvbi5oaWRkZW5PZkVudHJ5KG9wLmVudHJ5KSA/PyB1bmRlZmluZWQgfSA6IHt9KSxcbiAgICAgIC4uLihvcC50eXBlID09PSBcIndvcmtzcGFjZS5zZXRcIiA/IHsgd29ya3NwYWNlOiBzZXNzaW9uLndvcmtzcGFjZSB9IDoge30pLFxuICAgIH07XG4gICAgY29uc3Qgc2hvd24gPSAocDogc3RyaW5nKSA9PiBzZXNzaW9uLmRpc3BsYXkocCk7XG4gICAgbGV0IHI6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyBwYXRoPzogc3RyaW5nIH07XG4gICAgbGV0IGxpbmU6IHN0cmluZztcbiAgICBzd2l0Y2ggKG9wLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJkb2MuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZURvYyhvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImZvbGRlci5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRm9sZGVyKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgdGhlIGZvbGRlciAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ubW92ZShvcC5wYXRoLCBvcC5pbnRvKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IG1vdmVkICR7c2hvd24obS5mcm9tKX0gdG8gJHtzaG93bihtLnBhdGgpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZW5hbWVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5yZW5hbWUob3AucGF0aCwgb3AubmFtZSk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSByZW5hbWVkICR7c2hvd24obS5mcm9tKX0gdG8gJHtzaG93bihtLnBhdGgpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaWRlXCI6IHtcbiAgICAgICAgY29uc3QgaCA9IHNlc3Npb24uaGlkZShvcC5wYXRoKTtcbiAgICAgICAgciA9IGg7XG4gICAgICAgIC8vIOKaoCBUSEUgUEFSRU5USEVUSUNBTCBIQVMgVE8gQkUgVFJVRS4gSXQgc2FpZCBcIih0aGUgZmlsZSBpcyBzdGlsbCBvblxuICAgICAgICAvLyBkaXNrKVwiIHVuY29uZGl0aW9uYWxseSwgd2hpY2ggaXMgd3JvbmcgdHdpY2Ugb3ZlciBvbiBhIEdIT1NUIOKAlCBhblxuICAgICAgICAvLyBlbnRyeSB3aG9zZSBmaWxlIGlzIGFscmVhZHkgZ29uZSDigJQgYW5kIGNhbGxzIGEgZm9sZGVyIGEgZmlsZS4gQ29sZVxuICAgICAgICAvLyBtZXQgYm90aCBpbiBvbmUgZ28gd2hpbGUgY2xlYXJpbmcgcmVzaWR1ZSBmcm9tIHRoZSBFNjAgYnVnLCBhbmQgYVxuICAgICAgICAvLyByZWFzc3VyYW5jZSB0aGF0IGlzIGZhbHNlIGlzIHdvcnNlIHRoYW4gbm8gcmVhc3N1cmFuY2U6IGl0IGlzIHRoZVxuICAgICAgICAvLyBzYW1lIGRlZmVjdCBhcyB0aGUgY29uZmxpY3QgYmFubmVyIGNsYWltaW5nIGVkaXRzIGhlIGhhZCBub3QgbWFkZS5cbiAgICAgICAgY29uc3QgZ29uZSA9ICFleGlzdHNTeW5jKGgucGF0aCk7XG4gICAgICAgIGNvbnN0IGtpbmQgPSBnb25lID8gXCJcIiA6IHN0YXRTeW5jKGgucGF0aCkuaXNEaXJlY3RvcnkoKSA/IFwiZm9sZGVyXCIgOiBcImZpbGVcIjtcbiAgICAgICAgbGluZSA9IGdvbmVcbiAgICAgICAgICA/IGAke3dob30gcmVtb3ZlZCAke3Nob3duKGgucGF0aCl9IGZyb20gU2NyaXB0b3JpdW0gKGl0IHdhcyBhbHJlYWR5IGdvbmUgZnJvbSBkaXNrKS5gXG4gICAgICAgICAgOiBgJHt3aG99IHJlbW92ZWQgJHtzaG93bihoLnBhdGgpfSBmcm9tIFNjcmlwdG9yaXVtICh0aGUgJHtraW5kfSBpcyBzdGlsbCBvbiBkaXNrKS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ1bmhpZGVcIjoge1xuICAgICAgICBjb25zdCB1ID0gc2Vzc2lvbi51bmhpZGUob3AuZW50cnkpO1xuICAgICAgICByID0gdTtcbiAgICAgICAgbGluZSA9IGAke3dob30gYnJvdWdodCBiYWNrICR7dS5yZXN0b3JlZH0gaGlkZGVuIGl0ZW0ke3UucmVzdG9yZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNldC5tYWtlXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ubWFrZVNldChvcC5wYXRoKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHR1cm5lZCAke2Jhc2VuYW1lKG0ucGF0aCl9IGludG8gYSBzZXQ6ICR7c2hvd24obS5mb2xkZXIpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJpbXBvcnRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uaW1wb3J0VGV4dChvcC5uYW1lLCBvcC50ZXh0LCBvcC5pbnRvKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY29waWVkICR7b3AubmFtZX0gaW4gYXMgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwid29ya3NwYWNlLnNldFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5zZXRXb3Jrc3BhY2Uob3AucGF0aCk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHNldCB0aGUgd29ya3NwYWNlIHRvICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAvLyBUaGUgd2F5IGJhY2ssIHBsYW5uZWQgbm93IGFuZCBmcm9tIHdoYXQgd2FzIHRydWUgbm93LlxuICAgIGhpc3RvcnkuZGlkKHBsYW5JbnZlcnNlKG9wLCByIGFzIEFmdGVyLCBiZWZvcmUpKTtcbiAgICBhbm5vdW5jZShsaW5lLCB7IGZhY3Q6IG9wLnR5cGUsIGJ5LCAuLi5yIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHI7XG4gIH07XG5cbiAgLyoqXG4gICAqIEFwcGx5IG9uZSByZWNvcmRlZCBpbnZlcnNlLCBhbmQgcmV0dXJuIHRoZSBhY3QgdGhhdCB3b3VsZCByZXZlcnNlIFRIQVQg4oCUXG4gICAqIHdoaWNoIGlzIHdoYXQgZ29lcyBvbnRvIHRoZSBvdGhlciBzdGFjay5cbiAgICpcbiAgICog4puUIEEgREVMRVRFIEhBUyBOTyBXQVkgQkFDSywgYW5kIHNheXMgc28gYnkgcmV0dXJuaW5nIG51bGwuIE9uY2UgYSBjcmVhdGVkXG4gICAqIGZpbGUgaXMgZ29uZSBpdHMgY29udGVudHMgYXJlIGdvbmUgd2l0aCBpdCwgc28gYSByZWRvIHRoYXQgXCJyZS1jcmVhdGVzXCIgaXRcbiAgICogd291bGQgaGFuZCBiYWNrIGFuIGVtcHR5IGZpbGUgd2VhcmluZyB0aGUgc2FtZSBuYW1lIOKAlCB0aGUga2luZCBvZiBsaWUgYW5cbiAgICogdW5kbyBzdGFjayBtdXN0IG5vdCB0ZWxsLiBDb25maXJtZWQgZGVsZXRpb25zIGFyZSB0aGVyZWZvcmUgb25lLXdheSwgd2hpY2hcbiAgICogaXMgYWxzbyB3aHkgdGhleSBhcmUgY29uZmlybWVkLlxuICAgKi9cbiAgY29uc3QgYXBwbHlJbnZlcnNlID0gKGludjogSW52ZXJzZSk6IEFjdCB8IG51bGwgPT4ge1xuICAgIHN3aXRjaCAoaW52LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ubW92ZShpbnYucGF0aCwgaW52LmludG8pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgbW92ZWQgJHtiYXNlbmFtZShtLmZyb20pfSBiYWNrIGludG8gJHtiYXNlbmFtZShkaXJuYW1lKG0ucGF0aCkpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIm1vdmVcIiwgcGF0aDogbS5wYXRoLCBpbnRvOiBkaXJuYW1lKG0uZnJvbSkgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZW5hbWVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5yZW5hbWUoaW52LnBhdGgsIGludi5uYW1lKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHJlbmFtZWQgJHtiYXNlbmFtZShtLmZyb20pfSBiYWNrIHRvICR7YmFzZW5hbWUobS5wYXRoKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJyZW5hbWVcIiwgcGF0aDogbS5wYXRoLCBuYW1lOiBiYXNlbmFtZShtLmZyb20pIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlkZGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzdG9yZUhpZGRlbihpbnYuZW50cnksIGludi5yZWxzKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogci53YXMubGVuZ3RoID4gaW52LnJlbHMubGVuZ3RoID8gXCJicm91Z2h0IGl0ZW1zIGJhY2tcIiA6IFwiaGlkIGl0ZW1zIGFnYWluXCIsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImhpZGRlblwiLCBlbnRyeTogci5lbnRyeSwgcmVsczogci53YXMgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHsgZW50cnkgfSA9IHNlc3Npb24uYWRkQ29udGV4dChpbnYucGF0aCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBwdXQgJHtiYXNlbmFtZShpbnYucGF0aCl9IGJhY2sgaW4gdGhlIGNvbnRleHRgLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJjb250ZXh0LnJlbW92ZVwiLCBlbnRyeTogZW50cnkuaWQgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBzZXNzaW9uLmVudHJ5Um9vdChpbnYuZW50cnkpO1xuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQoaW52LmVudHJ5KTtcbiAgICAgICAgcmV0dXJuIHBhdGggPT09IG51bGxcbiAgICAgICAgICA/IG51bGxcbiAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgbGFiZWw6IGB0b29rICR7YmFzZW5hbWUocGF0aCl9IGJhY2sgb3V0IG9mIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImNvbnRleHQuYWRkXCIsIHBhdGggfSxcbiAgICAgICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwid29ya3NwYWNlXCI6IHtcbiAgICAgICAgY29uc3Qgd2FzID0gc2Vzc2lvbi53b3Jrc3BhY2U7XG4gICAgICAgIHNlc3Npb24uc2V0V29ya3NwYWNlKGludi5wYXRoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHNldCB0aGUgd29ya3NwYWNlIGJhY2sgdG8gJHtiYXNlbmFtZShpbnYucGF0aCl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwid29ya3NwYWNlXCIsIHBhdGg6IHdhcyB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImRlbGV0ZVwiOiB7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ3JlYXRlZChpbnYucGF0aCwgaW52LmRpcik7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gc3VyZmFjZSBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCByZXBseSA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICB0cnkge1xuICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShtc2cpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUgKi9cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IENsaWVudE1zZykgPT4ge1xuICAgIGlmIChpc1N0cnVjdHVyZU9wKG1zZykpIHtcbiAgICAgIGNvbnN0IHIgPSBzdHJ1Y3R1cmUoYW5jaG9yU3VyZmFjZVBhdGhzKG1zZyksIFwiaHVtYW5cIik7XG4gICAgICBpZiAodHlwZW9mIHIucGF0aCA9PT0gXCJzdHJpbmdcIilcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzdHJ1Y3R1cmUuZG9uZVwiLCBvcDogbXNnLnR5cGUsIHBhdGg6IHIucGF0aCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgICAgY2FzZSBcIm9wZW5cIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5vcGVuUGF0aChtc2cucGF0aCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAvLyBUaGUgb3BlbmVyIGdldHMgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBzdHJhaWdodCBhd2F5IOKAlCB0aGUgc3RhdGVcbiAgICAgICAgLy8gc25hcHNob3QgY2FycmllcyBubyB0ZXh0cywgYW5kIGEgdmlld2VyIG11c3Qgbm90IHdhaXQgb24gYSBzZWNvbmQgYXNrLlxuICAgICAgICB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihyLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoci5jcmVhdGVkKVxuICAgICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJkb2Mub3BlbmVkXCIsIGRvYzogci5zbHVnLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoci5zbHVnKSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm9wZW4uZG9jXCI6XG4gICAgICAgIHNlc3Npb24ub3BlblNsdWcobXNnLmRvYyk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJlZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdChtc2cuZG9jLCBtc2cudmVyc2lvbiwgbXNnLnRleHQpO1xuICAgICAgICBpZiAoci5wcmVzZXJ2ZWQpIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2MobXNnLmRvYyk7XG4gICAgICAgICAgYW5ub3VuY2VPdXRzaWRlKFxuICAgICAgICAgICAgZC5zbHVnLFxuICAgICAgICAgICAgbXNnLnZlcnNpb24sXG4gICAgICAgICAgICBzZXNzaW9uLmFjdGl2ZVBhdGgoZC5zbHVnKSA/PyBcIlwiLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQubixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLnBhdGgsXG4gICAgICAgICAgICByLnByZXNlcnZlZC5hY3RpdmF0ZWRCZWZvcmVXcml0dGVuLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoci5kaXJ0eUNoYW5nZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWFyY2hcIjoge1xuICAgICAgICAvLyDim5QgUkVQTElFRCBUTyBUSEUgQVNLSU5HIFNPQ0tFVCwgTk9UIEJST0FEQ0FTVC4gQSBzZWFyY2ggaXMgb25lXG4gICAgICAgIC8vIHZpZXdlcidzIHF1ZXN0aW9uOyBwdXNoaW5nIHJlc3VsdHMgdG8gZXZlcnkgY2xpZW50IHdvdWxkIHB1dCBzb21lb25lXG4gICAgICAgIC8vIGVsc2UncyBxdWVyeSBpbiB5b3VyIHBhbmUuIChUaGUgc2FtZSByZWFzb24gYGRpZmZgIHJlcGxpZXMgcmF0aGVyXG4gICAgICAgIC8vIHRoYW4gYnJvYWRjYXN0aW5nLilcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInNlYXJjaC5yZXN1bHRzXCIsIHJlcG9ydDogc2Vzc2lvbi5zZWFyY2hBbGwobXNnKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnVuZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtVbmRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIC8vIOKblCBBIERFTEVUSU5HIFVORE8gTkVFRFMgVEhFIEhVTUFOJ1MgV09SRCwgY2FycmllZCBleHBsaWNpdGx5LiBBXG4gICAgICAgIC8vIGNsaWVudCB0aGF0IHNpbXBseSBvbWl0cyB0aGUgZmxhZyBnZXRzIGEgcmVmdXNhbCByYXRoZXIgdGhhbiBhXG4gICAgICAgIC8vIGRlbGV0aW9uLCBzbyBcImZvcmdvdCB0byBjb25maXJtXCIgY2FuIG5ldmVyIGJlY29tZSBcImRlbGV0ZWQgYW55d2F5XCIuXG4gICAgICAgIGlmIChhY3QuaW52ZXJzZS5raW5kID09PSBcImRlbGV0ZVwiICYmIG1zZy5jb25maXJtRGVsZXRlICE9PSB0cnVlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBVbmRvaW5nIFwiJHthY3QubGFiZWx9XCIgd291bGQgZGVsZXRlICR7c2Vzc2lvbi5kaXNwbGF5KGFjdC5pbnZlcnNlLnBhdGgpfSDigJQgY29uZmlybSBpdCBmaXJzdC5gLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGhpc3RvcnkudG9va1VuZG8oYXBwbHlJbnZlcnNlKGFjdC5pbnZlcnNlKSk7XG4gICAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgICAgYW5ub3VuY2UoYFlvdSB1bmRpZDogJHthY3QubGFiZWx9LmAsIHsgZmFjdDogXCJoaXN0b3J5LnVuZG9cIiB9KTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gVGhlIHJlZnVzYWwgdGhlIGh1bWFuIG5lZWRzIHRvIHJlYWQg4oCUIGEgZm9sZGVyIHdpdGggdGhpbmdzIGluIGl0LFxuICAgICAgICAgIC8vIG9yIGEgd29ybGQgdGhhdCBoYXMgbW92ZWQgdW5kZXIgYSByZWNvcmRlZCBpbnZlcnNlLiBUaGUgYWN0IFNUQVlTXG4gICAgICAgICAgLy8gb24gdGhlIHN0YWNrOiBub3RoaW5nIGhhcHBlbmVkLCBzbyBub3RoaW5nIHNob3VsZCBiZSBmb3Jnb3R0ZW4uXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpc3RvcnkucmVkb1wiOiB7XG4gICAgICAgIGNvbnN0IGFjdCA9IGhpc3RvcnkucGVla1JlZG8oKTtcbiAgICAgICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tSZWRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgcmVkaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS5yZWRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgICAgLy8gQU1CSUVOVCBzdGF0ZTogc3RvcmVkIGFuZCBzaG93biwgbmV2ZXIgcHVzaGVkIG9udG8gdGhlIGFnZW50J3MgdGFpbC5cbiAgICAgICAgLy8g4puUIE9uZSBuYW1pbmcgYSBkb2N1bWVudCB0aGF0IGlzIG5vdCBvbiBzY3JlZW4gaXMgYSBzdGFsZSBlY2hvIGZyb21cbiAgICAgICAgLy8gYmVmb3JlIGEgc3dpdGNoIChFNjYpLCBhbmQgaXMgbm90IGhlbGQuXG4gICAgICAgIHNlbGVjdGlvbiA9IHNlbGVjdGlvbk9uU2NyZWVuKG1zZy5zZWxlY3Rpb24sIHNjcmVlbigpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBtc2cudGV4dC50cmltKCk7XG4gICAgICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgICAgICAvLyDimqAgQSBCQUNLU1RPUCwgQU5EIE5PIFRFU1QgQ0FOIFBJTiBJVCAoRTY2KS4gRXZlcnkgcGF0aCB0aGF0IG1vdmVzIHRoZVxuICAgICAgICAvLyBvcGVuIGRvY3VtZW50IG9yIGl0cyB2ZXJzaW9uIGJyb2FkY2FzdHMgZmlyc3QsIGFuZCB0aGUgYnJvYWRjYXN0J3NcbiAgICAgICAgLy8gcmVhZCBoYXMgYWxyZWFkeSBkcm9wcGVkIGEgc3RhbGUgc2VsZWN0aW9uIOKAlCBzbyByZWFkaW5nIHRoZSByYXdcbiAgICAgICAgLy8gYHNlbGVjdGlvbmAgaGVyZSBpcyB1bnJlYWNoYWJsZS13cm9uZyBieSBjb25zdHJ1Y3Rpb24uIEl0IHJlYWRzXG4gICAgICAgIC8vIHRocm91Z2ggdGhlIHJ1bGUgYW55d2F5LCBmb3IgdGhlIHBhdGggc29tZWJvZHkgYWRkcyB3aXRob3V0IGFcbiAgICAgICAgLy8gYnJvYWRjYXN0LlxuICAgICAgICBjb25zdCBzZWwgPSBtc2cud2l0aFNlbGVjdGlvbiA/IGhlbGRTZWxlY3Rpb24oKSA6IG51bGw7XG4gICAgICAgIGNvbnN0IGFjdGl2ZVBhdGggPSBzZWwgPyBzZXNzaW9uLmFjdGl2ZVBhdGgoc2VsLmRvYykgOiBzZXNzaW9uLmFjdGl2ZVBhdGgoKTtcbiAgICAgICAgLy8gRTY1J3MgXCJBc2sgdGhlIGFnZW50XCI6IHRoZSBtZXNzYWdlIGNhcnJpZXMgdGhlIG5vdGUgaXQgaXMgYWJvdXQsIHNvXG4gICAgICAgIC8vIHRoZSBhZ2VudCBjYW4gYWN0IG9uIGl0IGFuZCByZXNvbHZlIGl0IGJ5IGlkIHJhdGhlciB0aGFuIGJ5IG1hdGNoaW5nXG4gICAgICAgIC8vIHByb3NlLiDim5QgT05FIEFTSyBBVCBBIFRJTUU6IHdoaWxlIGEgbWVzc2FnZSBhYm91dCB0aGlzIG5vdGUgaXNcbiAgICAgICAgLy8gdW5hbnN3ZXJlZCB0aGUgbm90ZSBhbHJlYWR5IHNheXMgaXQgd2FzIGFza2VkLCBzbyBhIHNlY29uZCBpcyBhXG4gICAgICAgIC8vIGRvdWJsZS1jbGljaywgbm90IGEgbmV3IHF1ZXN0aW9uIOKAlCBkcm9wcGVkLCBhbmQgZGVyaXZlZCByYXRoZXIgdGhhblxuICAgICAgICAvLyBmbGFnZ2VkOiBpdCBpcyB0aGUgc2FtZSBmYWN0IHRoZSBub3RlJ3Mgb3duIGJhZGdlIHJlYWRzLlxuICAgICAgICBsZXQgbm90ZTogeyBkb2M6IHN0cmluZzsgaWQ6IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAobXNnLm5vdGUpIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5ub3RlRmFjdHMoKS5maW5kKCh4KSA9PiB4LnNsdWcgPT09IG1zZy5ub3RlPy5kb2MpO1xuICAgICAgICAgIGlmICghZD8ubm90ZXMuc29tZSgobikgPT4gbi5pZCA9PT0gbXNnLm5vdGU/LmlkKSkge1xuICAgICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgTm8gbm90ZSAke21zZy5ub3RlLmlkfSBvbiAke21zZy5ub3RlLmRvY30uYCB9KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3Qgb3dlZCA9IG5vdGVzV2FpdGluZyhzZXNzaW9uLm5vdGVGYWN0cygpLCBzZXNzaW9uLm1lc3NhZ2VzKCksIERhdGUubm93KCksIHtcbiAgICAgICAgICAgIGFja25vd2xlZGdlZFVudGlsLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChvd2VkLnNvbWUoKHcpID0+IHcuZG9jID09PSBtc2cubm90ZT8uZG9jICYmIHcubm90ZUlkID09PSBtc2cubm90ZS5pZCAmJiB3LmFza2VkSW4pKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIG5vdGUgPSB7IGRvYzogbXNnLm5vdGUuZG9jLCBpZDogbXNnLm5vdGUuaWQgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiaHVtYW5cIiwgdGV4dCwge1xuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZVBhdGgsXG4gICAgICAgICAgLi4uKG5vdGUgPyB7IG5vdGUgfSA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICBtZXNzYWdlX2lkOiBtLmlkLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgc2VsZWN0aW9uOiBzZWwsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZihzZWw/LmRvYyksXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgICAgLi4uKG5vdGVcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIG5vdGU6IG5vdGUuaWQsXG4gICAgICAgICAgICAgICAgZG9jOiBub3RlLmRvYyxcbiAgICAgICAgICAgICAgICBoaW50OiBgYWJvdXQgbm90ZSAke25vdGUuaWR9IOKAlCBcXGBub3RlcyAtLWRvYyAke25vdGUuZG9jfVxcYCBoYXMgaXQgd2hvbGU7IGFuc3dlciBoZXJlLCBhbmQgXFxgbm90ZS1yZXNvbHZlICR7bm90ZS5pZH0gLS1kb2MgJHtub3RlLmRvY31cXGAgd2hlbiBpdCBpcyBkZWFsdCB3aXRoYCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB7fSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgYWN0aXZhdGUobXNnLmRvYywgbXNnLnZlcnNpb24sIFwiaHVtYW5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICBib2R5OiBtc2cuYm9keSxcbiAgICAgICAgICB3aG86IFwiaHVtYW5cIixcbiAgICAgICAgICByYW5nZTogeyBmcm9tOiBtc2cuZnJvbSwgdG86IG1zZy50byB9LFxuICAgICAgICB9KTtcbiAgICAgICAgLy8gRTY1OiB0aGUgZXZlbnQgY2FycmllcyB0aGUgbm90ZSBpdHNlbGYgd2hlbiBpdCBpcyBzaG9ydCwgYW5kIG5hbWVzXG4gICAgICAgIC8vIHRoZSBhY3QgdGhhdCBjbG9zZXMgaXQg4oCUIGFuIGFnZW50IHNob3VsZCBub3QgaGF2ZSB0byBnbyBhbmQgYXNrXG4gICAgICAgIC8vIHdoYXQganVzdCBhcnJpdmVkIGJlZm9yZSBpdCBjYW4gc3RhcnQuXG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuYWRkZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICAuLi5ub3RlRXZlbnRGYWN0cyhyLnNsdWcsIHIubm90ZSwgc2Vzc2lvbi5ub3RlTGluZXMoci5zbHVnLCByLm5vdGUpKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLmRvbmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5maW5pc2hUYXNrKG1zZy5pZCwgbXNnLm91dGNvbWUpO1xuICAgICAgICBpZiAoIXIuYWxyZWFkeSkge1xuICAgICAgICAgIHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBgRG9uZTogJHtyLnRhc2sudGV4dH1gKTtcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwidGFzay5kb25lXCIsIHRhc2s6IHIudGFzay5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgfVxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5yZW1vdmVcIjoge1xuICAgICAgICBzZXNzaW9uLnJlbW92ZVRhc2sobXNnLmlkKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2tzLmNsZWFyXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5jbGVhckRvbmVUYXNrcygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5lZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdE5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQsIGJvZHk6IG1zZy5ib2R5LCB3aG86IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgLy8gQSBodW1hbidzIHJld3JpdGUgaXMgb3dlZCBhbiBhbnN3ZXIgYWdhaW4gKEU2NSksIHNvIGl0IHNheXMgd2hhdFxuICAgICAgICAvLyB0aGUgbm90ZSBub3cgc2F5cywgZXhhY3RseSBhcyBgbm90ZS5hZGRlZGAgZG9lcy5cbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibm90ZS5lZGl0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICAuLi5ub3RlRXZlbnRGYWN0cyhyLnNsdWcsIHIubm90ZSwgc2Vzc2lvbi5ub3RlTGluZXMoci5zbHVnLCByLm5vdGUpKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlc29sdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTm90ZSh7XG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIGlkOiBtc2cuaWQsXG4gICAgICAgICAgcmVzb2x2ZWQ6IG1zZy5yZXNvbHZlZCxcbiAgICAgICAgICB3aG86IFwiaHVtYW5cIixcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBtc2cucmVzb2x2ZWQgPyBcIm5vdGUucmVzb2x2ZWRcIiA6IFwibm90ZS5yZW9wZW5lZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIC8vIEEgaHVtYW4gcmVvcGVuaW5nIGEgbm90ZSBpcyBhc2tpbmcgYWdhaW4gKEU2NSksIHNvIGl0IGNhcnJpZXMgd2hhdFxuICAgICAgICAgIC8vIGBub3RlLmFkZGVkYCBjYXJyaWVzLlxuICAgICAgICAgIC4uLihtc2cucmVzb2x2ZWRcbiAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgIDogbm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSkpLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVtb3ZlTm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUucmVtb3ZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiBtc2cudmVyc2lvbiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBEZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICAuLi4obXNnLmZyb20gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBmcm9tOiBtc2cuZnJvbSB9KSxcbiAgICAgICAgICAuLi4obXNnLmxhYmVsID8geyBsYWJlbDogbXNnLmxhYmVsIH0gOiB7fSksXG4gICAgICAgICAgYXV0aG9yOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDim5QgU0FZIFdIRVJFIFRIRVkgQVJFLCBub3QganVzdCB3aGF0IHdhcyBtYWRlIChFNDIpLiBUaGUgb2xkIG1lc3NhZ2VcbiAgICAgICAgLy8gYW5ub3VuY2VkIHRoZSBuZXcgdmVyc2lvbiBhbmQgd2VudCBxdWlldCBhYm91dCB3aGljaCBvbmUgdGhlIGh1bWFuXG4gICAgICAgIC8vIHdhcyBlZGl0aW5nIOKAlCB3aGljaCBpcyBleGFjdGx5IGhvdyBzb21lb25lIHR5cGVzIGludG8gdjEgYmVsaWV2aW5nXG4gICAgICAgIC8vIHRoZXkgYXJlIGluIHYyLlxuICAgICAgICBpZiAobXNnLmFjdGl2YXRlKSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYE1hZGUgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7bXNnLmxhYmVsID8gYCDigJQgJHttc2cubGFiZWx9YCA6IFwiXCJ9LiBgICtcbiAgICAgICAgICAgIChtc2cuYWN0aXZhdGVcbiAgICAgICAgICAgICAgPyBgWW91IGFyZSBub3cgZWRpdGluZyB2JHtyLnZlcnNpb24ubn0uYFxuICAgICAgICAgICAgICA6IGBZb3UgYXJlIHN0aWxsIGVkaXRpbmcgdiR7ci52ZXJzaW9uLmZyb219LmApLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24ubixcbiAgICAgICAgICBmcm9tOiByLnZlcnNpb24uZnJvbSxcbiAgICAgICAgICBhY3RpdmF0ZWQ6IG1zZy5hY3RpdmF0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24uc2hvd25QYXRoKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsLnZlcnNpb25cIjpcbiAgICAgICAgLy8gVGhlIGRhZW1vbiByZXNvbHZlcyBpdCwgc28gdGhlIHN1cmZhY2UgbmV2ZXIgbmFtZXMgYSBwYXRoIG91dHNpZGVcbiAgICAgICAgLy8gd2hhdCB0aGUgc2Vzc2lvbiBhbHJlYWR5IG93bnMuXG4gICAgICAgIHJldmVhbFBhdGgoc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikucGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZGlmZlwiLCAuLi5zZXNzaW9uLmNvbXBhcmUoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0IH0pIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogbXNnLmRvYywgYWdhaW5zdDogbXNnLmFnYWluc3QsIGh1bmtzOiBtc2cuaHVua3MgfSk7XG4gICAgICAgIC8vIFRoZSBidWZmZXIgdGhlIGh1bWFuIGlzIGxvb2tpbmcgYXQgbXVzdCBiZSB0b2xkOiB0aGUgbWVyZ2Ugd3JvdGUgdGhlXG4gICAgICAgIC8vIGFjdGl2ZSB2ZXJzaW9uJ3MgRklMRSwgYW5kIHRoZSBlZGl0b3IncyB0ZXh0IGlzIG5vdyBiZWhpbmQgaXQuXG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFRvb2sgJHtyLmFwcGxpZWR9IGNoYW5nZSR7ci5hcHBsaWVkID09PSAxID8gXCJcIiA6IFwic1wifSBmcm9tICR7c2lkZU5hbWUobXNnLmFnYWluc3QsIHNlc3Npb24uZG9jKHIuc2x1ZykubmFtZSl9IGludG8gdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzOiBtc2cuaHVua3MsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZXNzaW9uLmVuZFwiOlxuICAgICAgICAvLyDim5QgVEhFIERBRU1PTiBFTkRTIElULCBOT1QgVEhFIEFHRU5UIChDb2xlLCAyMDI2LTEwLTAxKTogdGhlIHBhZ2VcbiAgICAgICAgLy8gYWxyZWFkeSBhc2tlZCB0aGUgaHVtYW4gdG8gY29uZmlybSwgYW5kIGEgc2Vzc2lvbiB3aG9zZSBhZ2VudCBoYXNcbiAgICAgICAgLy8gZ29uZSBtdXN0IHN0aWxsIGJlIGFibGUgdG8gY2xvc2UuIFNhbWUgdGVhcmRvd24gYXMgYGNsb3NlYC5cbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInByZWZzLnNldFwiOiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICAhUFJFRl9LRVkudGVzdChtc2cua2V5KSB8fFxuICAgICAgICAgIHR5cGVvZiBtc2cudmFsdWUgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgICAgICBtc2cudmFsdWUubGVuZ3RoID4gUFJFRl9WQUxVRV9NQVhcbiAgICAgICAgKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9YCk7XG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkUHJlZnMoKTtcbiAgICAgICAgaWYgKGN1cnJlbnRbbXNnLmtleV0gPT09IG1zZy52YWx1ZSkgcmV0dXJuO1xuICAgICAgICBpZiAoIShtc2cua2V5IGluIGN1cnJlbnQpICYmIE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCA+PSBQUkVGX0tFWVNfTUFYKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX06ICR7UFJFRl9LRVlTX01BWH0ga2V5cyBhbHJlYWR5IGtlcHRgLFxuICAgICAgICAgICk7XG4gICAgICAgIHdyaXRlRmlsZUF0b21pYyhcbiAgICAgICAgICBwcmVmc0ZpbGUsXG4gICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyAuLi5jdXJyZW50LCBbbXNnLmtleV06IG1zZy52YWx1ZSB9LCBudWxsLCAyKX1cXG5gLFxuICAgICAgICApO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZ3JhcGhcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZ3JhcGhcIiwgZW50cnk6IG1zZy5lbnRyeSwgZ3JhcGg6IHNlc3Npb24uZ3JhcGhGb3IobXNnLmVudHJ5KSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImdyYXBoXCIsXG4gICAgICAgICAgICBlbnRyeTogbXNnLmVudHJ5LFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibGluay5vcGVuXCI6IHtcbiAgICAgICAgLy8gRTMzOiBhIGxpbmsgaW5zaWRlIHRoZSBidW5kbGUgaXMgRk9MTE9XRUQ7IG9uZSB0aGF0IGVzY2FwZXMgaXQgaXNcbiAgICAgICAgLy8gcmVwb3J0ZWQgc28gdGhlIHN1cmZhY2UgY2FuIG9mZmVyIHRvIGFkZCBpdCwgbmV2ZXIgYWRkZWQgc2lsZW50bHkuXG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc29sdmVMaW5rKG1zZy5mcm9tLCBtc2cudGFyZ2V0LCBtc2cuZG9jKTtcbiAgICAgICAgaWYgKHIuc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIHtcbiAgICAgICAgICBzZXNzaW9uLm9wZW5QYXRoKHIucGF0aCk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moc2Vzc2lvbi5vcGVuRG9jU2x1ZyA/PyBcIlwiKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKGQuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgdHlwZTogXCJsaW5rLnRhcmdldFwiLFxuICAgICAgICAgIHRhcmdldDogbXNnLnRhcmdldCxcbiAgICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgICAgICAuLi4oci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyB7fSA6IHsgcGF0aDogci5wYXRoIH0pLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc3VnZ2VzdFwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgciA9IHNlc3Npb24uc3VnZ2VzdE1ldGEobXNnLnBhdGgsIFwiaHVtYW5cIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGJsb2NrOiByLmJsb2NrLFxuICAgICAgICAgICAgLi4uKHIudHlwZSA/IHsgc3VnZ2VzdGVkVHlwZTogci50eXBlIH0gOiB7fSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtZXRhLnN1Z2dlc3Rpb25cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibW92ZS5wbGFuXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBwbGFuOiBzZXNzaW9uLm1vdmVQbGFuKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSwgc3VyZmFjZVBhdGgobXNnLmludG8pKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1vdmUucGxhblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBpbnRvOiBtc2cuaW50byxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZzLmxpc3RcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gZXhwYW5kSG9tZShtc2cucGF0aCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJmcy5saXN0XCIsIHBhdGg6IG1zZy5wYXRoLCBlbnRyaWVzOiBsaXN0RGlyKHBhdGgpIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZnMubGlzdFwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBlbnRyaWVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgLy8g4pSA4pSAIHRoZSBuYXRpdmUgcGlja2VyIChvbmUgZGlhbG9nIGF0IGEgdGltZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vXG4gIC8vIEEgbW9kYWwgZGlhbG9nIG93bnMgdGhlIGh1bWFuJ3MgYXR0ZW50aW9uLCBhbmQgYSBzZWNvbmQgb25lIGJlaGluZCB0aGVcbiAgLy8gZmlyc3QgY2Fubm90IGJlIHNlZW4gb3IgZGlzbWlzc2VkIOKAlCBzbyBhIHJlcXVlc3Qgd2hpbGUgb25lIGlzIG9wZW4gaXNcbiAgLy8gcmVmdXNlZCBpbiB3b3JkcyByYXRoZXIgdGhhbiBxdWV1ZWQuXG4gIGxldCBwaWNrZXJPcGVuID0gZmFsc2U7XG4gIGNvbnN0IHplbml0eSA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwibGludXhcIiA/IEJ1bi53aGljaChcInplbml0eVwiKSA6IG51bGw7XG4gIGNvbnN0IG9wZW5QaWNrZXIgPSBhc3luYyAoXG4gICAgd3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sXG4gICAgd2FudDogXCJjb250ZXh0LWZpbGVcIiB8IFwiY29udGV4dC1mb2xkZXJcIiB8IFwid29ya3NwYWNlXCIsXG4gICkgPT4ge1xuICAgIGlmIChwaWNrZXJPcGVuKSB7XG4gICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiYSBmaWxlIHBpY2tlciBpcyBhbHJlYWR5IG9wZW5cIiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qga2luZDogUGlja0tpbmQgPSB3YW50ID09PSBcImNvbnRleHQtZmlsZVwiID8gXCJmaWxlXCIgOiBcImZvbGRlclwiO1xuICAgIGNvbnN0IHByb21wdCA9XG4gICAgICB3YW50ID09PSBcIndvcmtzcGFjZVwiXG4gICAgICAgID8gXCJDaG9vc2UgdGhlIHdvcmtzcGFjZSBmb2xkZXIgZm9yIHNjcmlwdG9yaXVtXCJcbiAgICAgICAgOiB3YW50ID09PSBcImNvbnRleHQtZm9sZGVyXCJcbiAgICAgICAgICA/IFwiQ2hvb3NlIGEgZm9sZGVyIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiXG4gICAgICAgICAgOiBcIkNob29zZSBkb2N1bWVudHMgdG8gYWRkIHRvIHNjcmlwdG9yaXVtXCI7XG4gICAgY29uc3QgY21kID0gcGlja2VyQ29tbWFuZChwcm9jZXNzLnBsYXRmb3JtLCBraW5kLCBwcm9tcHQsIHplbml0eSk7XG4gICAgaWYgKCFjbWQpIHtcbiAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgbWVzc2FnZTogYG5vIGZpbGUgcGlja2VyIG9uIHRoaXMgc3lzdGVtICgke3Byb2Nlc3MucGxhdGZvcm19KSDigJQgdHlwZSB0aGUgcGF0aCBpbnN0ZWFkYCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBwaWNrZXJPcGVuID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihjbWQsIHsgc3Rkb3V0OiBcInBpcGVcIiwgc3RkZXJyOiBcInBpcGVcIiwgc3RkaW46IFwiaWdub3JlXCIgfSk7XG4gICAgICBjb25zdCBbb3V0LCBjb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtuZXcgUmVzcG9uc2UocHJvYy5zdGRvdXQpLnRleHQoKSwgcHJvYy5leGl0ZWRdKTtcbiAgICAgIHRvdWNoKCk7IC8vIGEgaHVtYW4gc3Rvb2QgYXQgYSBkaWFsb2c7IHRoZSBzZXNzaW9uIGlzIG5vdCBpZGxlXG4gICAgICBjb25zdCBwYXRocyA9IHBhcnNlUGlja2VyT3V0cHV0KG91dCk7XG4gICAgICBpZiAocGF0aHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIC8vIENhbmNlbGxlZDogbm90aGluZyBjaG9zZW4sIG5vdGhpbmcgc2FpZC4gQSByZWFsIGZhaWx1cmUgaXMgc2FpZC5cbiAgICAgICAgaWYgKCF3YXNDYW5jZWxsZWQoY29kZSwgb3V0KSlcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGB0aGUgZmlsZSBwaWNrZXIgZmFpbGVkIChleGl0ICR7Y29kZX0pYCB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gV2hhdCB3YXMgY2hvc2VuIGlzIGFkbWl0dGVkIGxpa2UgYW55IG90aGVyIHBhdGgg4oCUIGEgcGlja2VkIGZpbGUgdGhhdFxuICAgICAgLy8gc2NyaXB0b3JpdW0gZG9lcyBub3Qgb3BlbiBpcyByZWZ1c2VkIGluIHRoZSBzaWRlYmFyJ3Mgb3duIHdvcmRzLCBhbmRcbiAgICAgIC8vIHRoYXQgcmVmdXNhbCBtdXN0IG5vdCByZWFkIGFzIFwidGhlIHBpY2tlciBmYWlsZWRcIi5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICh3YW50ID09PSBcIndvcmtzcGFjZVwiKVxuICAgICAgICAgIHN0cnVjdHVyZSh7IHR5cGU6IFwid29ya3NwYWNlLnNldFwiLCBwYXRoOiBwYXRoc1swXSBhcyBzdHJpbmcgfSwgXCJodW1hblwiKTtcbiAgICAgICAgZWxzZSBhZGRQYXRocyhwYXRocyk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgIHR5cGU6IFwiZXJyb3JcIixcbiAgICAgICAgbWVzc2FnZTogYGNvdWxkIG5vdCBvcGVuIHRoZSBmaWxlIHBpY2tlcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCxcbiAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwaWNrZXJPcGVuID0gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGFjdGl2ZU9mID0gKGRvYz86IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHNsdWcgPSBkb2MgPz8gc2Vzc2lvbi5vcGVuRG9jU2x1ZztcbiAgICBpZiAoIXNsdWcpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gc2Vzc2lvbi5kb2Moc2x1Zyk7XG4gICAgICByZXR1cm4geyBkb2M6IHYuc2x1ZywgdmVyc2lvbjogdi5hY3RpdmUsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aCh2LnNsdWcpIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIGFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgbGV0IHJlc29sdmVEb25lITogKHY6IHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZzsgYnk6IENsb3NlZEJ5IH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmc7IGJ5OiBDbG9zZWRCeSB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgLyoqIFNob3cgYSBmaWxlIGluIHRoZSBwbGF0Zm9ybSdzIGZpbGUgbWFuYWdlci4gQW4gYXJndiwgbmV2ZXIgYSBzaGVsbCBzdHJpbmc6XG4gICAqICB0aGUgcGF0aCBpcyBkYXRhLCB3aGF0ZXZlciBpdCBob2xkcy4gKi9cbiAgY29uc3QgcmV2ZWFsUGF0aCA9IChwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBbY21kLCAuLi5hcmdzXSA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgID8gW1wib3BlblwiLCBcIi1SXCIsIHBhdGhdXG4gICAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICA6IFtcInhkZy1vcGVuXCIsIGRpcm5hbWUocGF0aCldO1xuICAgIEJ1bi5zcGF3bihbY21kIGFzIHN0cmluZywgLi4uYXJnc10sIHsgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSB9KS51bnJlZigpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcIm1ldGFcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24ubWV0YUZvcihjbWQucGF0aCk7XG4gICAgICBjYXNlIFwiZ3JhcGhcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZ3JhcGhGb3IoY21kLmVudHJ5KSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY2FzZSBcImRhbmdsaW5nXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmRhbmdsaW5nTGlua3MoY21kLmVudHJ5KTtcbiAgICAgIGNhc2UgXCJkb2N0b3JcIjoge1xuICAgICAgICBjb25zdCBsaXN0ID0gc2Vzc2lvbi5jaGVja3VwKCk7XG4gICAgICAgIHJldHVybiB7IGZpbmRpbmdzOiBsaXN0LCBjb3VudDogbGlzdC5sZW5ndGggfSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZvcmdldFwiOiB7XG4gICAgICAgIGNvbnN0IGYgPSBzZXNzaW9uLmZvcmdldERvYyhjbWQuZG9jKTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IGZvcmdvdCAke2YubmFtZX0g4oCUIGl0cyBmaWxlIHdhcyBnb25lLCBhbmQgJHtmLnZlcnNpb25zID09PSAxID8gXCIxIHZlcnNpb25cIiA6IGAke2YudmVyc2lvbnN9IHZlcnNpb25zYH0gaW4gdGhpcyBzZXNzaW9uICR7Zi52ZXJzaW9ucyA9PT0gMSA/IFwiaXNcIiA6IFwiYXJlXCJ9IG5vIGxvbmdlciByZWFjaGFibGUuYCxcbiAgICAgICAgICB7IGZhY3Q6IFwiZG9jLmZvcmdvdHRlblwiLCBkb2M6IGYuc2x1Zywgb3JpZ2luYWw6IGYub3JpZ2luYWwgfSxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIGYgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWFyY2hcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uc2VhcmNoQWxsKGNtZCkgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNhc2UgXCJiYWNrbGlua3NcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uYmFja2xpbmtzKGNtZC5wYXRoKTtcbiAgICAgIGNhc2UgXCJtZXRhLmluaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhSW5pdChjbWQucGF0aCwge1xuICAgICAgICAgIC4uLihjbWQubWV0YVR5cGUgPyB7IHR5cGU6IGNtZC5tZXRhVHlwZSB9IDoge30pLFxuICAgICAgICAgIGJ5OiBjbWQuYnkgPz8gXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGFkZGVkIGZyb250bWF0dGVyIHRvICR7c2Vzc2lvbi5kaXNwbGF5KFN0cmluZyhyLnBhdGgpKX0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAuLi5yLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWV0YS5zZXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhU2V0KGNtZC5wYXRoLCBjbWQuZmllbGRzKTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IHNldCAkeyhyLnNldCBhcyBzdHJpbmdbXSkuam9pbihcIiwgXCIpfSBvbiAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1ldGEuc2V0XCIsIGJ5OiBcImFnZW50XCIsIC4uLnIgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBjbWQuZG9jLCB2ZXJzaW9uOiBjbWQudmVyc2lvbiB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGRlbGV0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30ke3IubGFiZWwgPyBgIOKAlCAke3IubGFiZWx9YCA6IFwiXCJ9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcInZlcnNpb24uZGVsZXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgcmVtYWluaW5nOiByLnJlbWFpbmluZyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uYWRkTm90ZSh7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGJvZHk6IGNtZC5ib2R5LFxuICAgICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICAgIHF1b3RlOiBjbWQucXVvdGUsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgbm90ZWQg4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdIG9uICR7ci5zbHVnfS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBxdW90ZTogci5ub3RlLnF1b3RlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZXNcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5ub3Rlc09mKHsgZG9jOiBjbWQuZG9jLCAuLi4oY21kLmFsbCA/IHsgYWxsOiB0cnVlIH0gOiB7fSkgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3Rlczogci5ub3RlcyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24ucmVtb3ZlVGFzayhjbWQuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCByZW1vdmVkOiB0cnVlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBjb25zdCBjbGVhcmVkID0gc2Vzc2lvbi5jbGVhckRvbmVUYXNrcygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBjbGVhcmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwid29ya2luZ1wiOiB7XG4gICAgICAgIC8vIEU1MydzIHNub296ZS4gSXQgZG9lcyBOT1QgcG9zdCB0byB0aGUgY2hhdDogYW4gYWdlbnQgc2F5aW5nIFwic3RpbGxcbiAgICAgICAgLy8gd29ya2luZ1wiIGluIHRoZSBjb252ZXJzYXRpb24gaXMgYSByZXBseSwgYW5kIGl0IGNhbiBkbyB0aGF0IHdpdGhcbiAgICAgICAgLy8gYHNheWAg4oCUIHRoaXMgaXMgdGhlIHF1aWV0ZXIgdGhpbmcsIGZvciB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG9cbiAgICAgICAgLy8gcmVwb3J0IHlldCBidXQgdGhlIGFsYXJtIHNob3VsZCBzdG9wLlxuICAgICAgICBjb25zdCBtcyA9IGNtZC5zZWNvbmRzICE9PSB1bmRlZmluZWQgPyBjbWQuc2Vjb25kcyAqIDEwMDAgOiBERUZBVUxUX1NOT09aRV9NUztcbiAgICAgICAgYWNrbm93bGVkZ2VkVW50aWwgPSBEYXRlLm5vdygpICsgTWF0aC5tYXgoMCwgbXMpO1xuICAgICAgICAvLyBXaGF0ZXZlciBpcyBwZW5kaW5nIGlzIGFja25vd2xlZGdlZCwgc28gaXQgbXVzdCBuZXZlciBiZSBudWRnZWQgYWdhaW4uXG4gICAgICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pO1xuICAgICAgICBpZiAodykgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdW50aWw6IGFja25vd2xlZGdlZFVudGlsLFxuICAgICAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgbXMpIC8gMTAwMCksXG4gICAgICAgICAgLi4uKHcgPyB7IHdhaXRpbmc6IHcubWVzc2FnZUlkIH0gOiB7fSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5zdGFydFwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnN0YXJ0VGFzayhjbWQudGV4dCwgXCJhZ2VudFwiKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suc3RhcnRlZFwiLCB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQsIGJ5OiBcImFnZW50XCIgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHQuaWQsIHRleHQ6IHQudGV4dCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24uc2V0VGFza1N0YXR1cyhjbWQuaWQsIGNtZC5zdGF0dXMpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCBzdGF0dXM6IHQuc3RhdHVzIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhjbWQuaWQsIGNtZC5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpXG4gICAgICAgICAgYW5ub3VuY2UoYERvbmU6ICR7ci50YXNrLnRleHR9JHtyLnRhc2sub3V0Y29tZSA/IGAg4oCUICR7ci50YXNrLm91dGNvbWV9YCA6IFwiXCJ9YCwge1xuICAgICAgICAgICAgZmFjdDogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICAgIHRhc2s6IHIudGFzay5pZCxcbiAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHIudGFzay5pZCwgYWxyZWFkeTogci5hbHJlYWR5IH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5lZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdE5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIGJvZHk6IGNtZC5ib2R5LCB3aG86IFwiYWdlbnRcIiB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IHJld3JvdGUgYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBpZDogY21kLmlkLFxuICAgICAgICAgIHJlc29sdmVkOiBjbWQucmVzb2x2ZWQsXG4gICAgICAgICAgd2hvOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgJHtjbWQucmVzb2x2ZWQgPyBcInJlc29sdmVkXCIgOiBcInJlb3BlbmVkXCJ9IGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJub3RlLnJlc29sdmVkXCIsIGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQsIGJ5OiBcImFnZW50XCIgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgcmVzb2x2ZWQ6IHIubm90ZS5yZXNvbHZlZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVtb3ZlTm90ZSh7IGRvYzogY21kLmRvYywgaWQ6IGNtZC5pZCB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IHJlbW92ZWQgYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm5vdGUucmVtb3ZlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImRpZmZcIjoge1xuICAgICAgICBjb25zdCBwID0gc2Vzc2lvbi5jb21wYXJlKHsgZG9jOiBjbWQuZG9jLCBhZ2FpbnN0OiBjbWQuYWdhaW5zdCB9KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBkb2M6IHAuZG9jLFxuICAgICAgICAgIGFjdGl2ZTogcC5hY3RpdmUsXG4gICAgICAgICAgYWdhaW5zdDogcC5hZ2FpbnN0LFxuICAgICAgICAgIHNhbWU6IHAuZGlmZi5zYW1lLFxuICAgICAgICAgIGNvYXJzZTogcC5kaWZmLmNvYXJzZSxcbiAgICAgICAgICBodW5rczogcC5kaWZmLmh1bmtzLFxuICAgICAgICAgIHVuaWZpZWQ6IHVuaWZpZWQocC5kaWZmLCB7XG4gICAgICAgICAgICBmcm9tOiBgdiR7cC5hY3RpdmV9YCxcbiAgICAgICAgICAgIHRvOiBzaWRlTmFtZShwLmFnYWluc3QsIHNlc3Npb24uZG9jKHAuZG9jKS5uYW1lKSxcbiAgICAgICAgICAgIC4uLihjbWQuY29udGV4dCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGNvbnRleHQ6IGNtZC5jb250ZXh0IH0pLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1lcmdlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWVyZ2UoeyBkb2M6IGNtZC5kb2MsIGFnYWluc3Q6IGNtZC5hZ2FpbnN0LCBodW5rczogY21kLmh1bmtzIH0pO1xuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IHRvb2sgJHtyLmFwcGxpZWR9IGNoYW5nZSR7ci5hcHBsaWVkID09PSAxID8gXCJcIiA6IFwic1wifSBmcm9tICR7c2lkZU5hbWUoY21kLmFnYWluc3QsIHNlc3Npb24uZG9jKHIuc2x1ZykubmFtZSl9IGludG8gdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwibWVyZ2VkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIGh1bmtzOiBjbWQuaHVua3MsIGJ5OiBcImFnZW50XCIgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgYXBwbGllZDogci5hcHBsaWVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmluZFwiOlxuICAgICAgICByZXR1cm4gc2Vzc2lvbi5maW5kKGNtZC5maWx0ZXIpO1xuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgYWRkZWQgPSBhZGRQYXRocyhjbWQucGF0aHMpO1xuICAgICAgICByZXR1cm4geyBlbnRyaWVzOiBhZGRlZC5tYXAoKGEpID0+ICh7IC4uLmEuZW50cnksIGFkZGVkOiBhLmFkZGVkIH0pKSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24ubmV3XCI6IHtcbiAgICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCA3OiB0aGUgYWdlbnQgbWF5IG5hbWUgYSBkb2MgdGhlIGh1bWFuIGhhcyBub3RcbiAgICAgICAgLy8gb3BlbmVkLCBieSBBQlNPTFVURSBwYXRoICh0aGUgQ0xJIHJlc29sdmVzIGl0IGFnYWluc3QgaXRzIG93biBjd2QpO1xuICAgICAgICAvLyBpdCBpcyBvcGVuZWQgaW1wbGljaXRseSB1bmRlciB0aGUgc2FtZSBhZG1pc3Npb24gcnVsZSBhcyB0aGVcbiAgICAgICAgLy8gc3VyZmFjZSdzIGBvcGVuYCDigJQgYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkg4oCUIHdpdGhvdXRcbiAgICAgICAgLy8gbW92aW5nIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAgICAgIGlmIChjbWQuZG9jICYmIGlzQWJzb2x1dGUoY21kLmRvYykgJiYgIXNlc3Npb24uZmluZERvYyhjbWQuZG9jKSkge1xuICAgICAgICAgIGNvbnN0IG8gPSBzZXNzaW9uLm9wZW5QYXRoKGNtZC5kb2MsIHsgZm9jdXM6IGZhbHNlIH0pO1xuICAgICAgICAgIGlmIChvLmNyZWF0ZWQpXG4gICAgICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9jLm9wZW5lZFwiLFxuICAgICAgICAgICAgICBkb2M6IG8uc2x1ZyxcbiAgICAgICAgICAgICAgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKG8uc2x1ZyksXG4gICAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyAjMTE3OiB3aXRoIGB0ZXh0YCB0aGUgZmlsZSBpcyB3cml0dGVuIEhFUkUsIGJlZm9yZSB0aGUgYW5ub3VuY2VcbiAgICAgICAgLy8gYmVsb3cg4oCUIHRoZSB2ZXJzaW9uIGlzIG5ldmVyIG9mZmVyZWQgdG8gdGhlIGh1bWFuIHVud3JpdHRlbi5cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGZyb206IGNtZC5mcm9tLFxuICAgICAgICAgIGxhYmVsOiBjbWQubGFiZWwsXG4gICAgICAgICAgLi4uKHR5cGVvZiBjbWQudGV4dCA9PT0gXCJzdHJpbmdcIiA/IHsgdGV4dDogY21kLnRleHQgfSA6IHt9KSxcbiAgICAgICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBjcmVhdGVkIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke2NtZC5sYWJlbCA/IGAg4oCUICR7Y21kLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0sXG4gICAgICAgICk7XG4gICAgICAgIC8vIFRoZSBhbnN3ZXIgbmFtZXMgdGhlIGFjdCBpdCBtYWtlcyBsaWtlbHk6IGEgdmVyc2lvbiBib3JuIGhvbGRpbmcgdGhlXG4gICAgICAgIC8vIGFnZW50J3MgdGV4dCBpcyByZWFkeSB0byB0YWxrIGFib3V0OyBhIGNvcHkgc3RpbGwgaGFzIHRvIGJlIHdyaXR0ZW4sXG4gICAgICAgIC8vIGFuZCBpcyBhbHJlYWR5IG9uIG9mZmVyIHRvIHRoZSBodW1hbiAoIzExNykuXG4gICAgICAgIGNvbnN0IHdyaXR0ZW4gPSB0eXBlb2YgY21kLnRleHQgPT09IFwic3RyaW5nXCI7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLm4sXG4gICAgICAgICAgZnJvbTogci52ZXJzaW9uLmZyb20sXG4gICAgICAgICAgcGF0aDogci52ZXJzaW9uLnBhdGgsXG4gICAgICAgICAgd3JpdHRlbixcbiAgICAgICAgICBoaW50OiB3cml0dGVuXG4gICAgICAgICAgICA/IGB2JHtyLnZlcnNpb24ubn0gaG9sZHMgeW91ciB0ZXh0IGFuZCB0aGUgaHVtYW4gaGFzIGJlZW4gb2ZmZXJlZCBpdCDigJQgbm8gbmVlZCB0byBhbm5vdW5jZSBpdDsgc2F5IHdoeSB5b3UgbWFkZSBpdCBpZiB0aGF0IGhlbHBzIHRoZW0gZGVjaWRlYFxuICAgICAgICAgICAgOiBgdiR7ci52ZXJzaW9uLm59IGlzIGEgY29weSBvZiB2JHtyLnZlcnNpb24uZnJvbX0gYW5kIHRoZSBodW1hbiBjYW4gYWxyZWFkeSBhY3RpdmF0ZSBpdCDigJQgd3JpdGUgeW91ciB0ZXh0IHRvIGl0cyBwYXRoIG5vdyAobmV4dCB0aW1lOiB2ZXJzaW9uLW5ldyAtLWJvZHktZmlsZSwgb25lIHN0ZXApYCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiYWdlbnRcIiwgY21kLnRleHQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBpZDogbS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIHJldHVybiBhY3RpdmF0ZShjbWQuZG9jLCBjbWQudmVyc2lvbiwgXCJhZ2VudFwiKTtcbiAgICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiLCBieTogXCJhZ2VudFwiIH0pO1xuICAgICAgICByZXR1cm4ge307XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoKGNtZCBhcyB7IHR5cGU/OiB1bmtub3duIH0pLnR5cGUpfSDigJQgbm90aGluZyB3YXMgYXBwbGllZGAsXG4gICAgICAgICAgNDAwLFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIFwiY29udGV4dC5hZGRcIixcbiAgICAgICAgICAgIFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAgIFwic2F5XCIsXG4gICAgICAgICAgICBcImFjdGl2YXRlXCIsXG4gICAgICAgICAgICBcImNsb3NlXCIsXG4gICAgICAgICAgICBcIm1ldGFcIixcbiAgICAgICAgICAgIFwiZmluZFwiLFxuICAgICAgICAgICAgXCJncmFwaFwiLFxuICAgICAgICAgICAgXCJiYWNrbGlua3NcIixcbiAgICAgICAgICAgIFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgICBcIm1ldGEuc2V0XCIsXG4gICAgICAgICAgICAuLi5TVFJVQ1RVUkVfT1BTLFxuICAgICAgICAgIF0sXG4gICAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlZnVzYWwgPSAoZTogdW5rbm93bik6IFJlc3BvbnNlID0+IHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBlLm1lc3NhZ2UsXG4gICAgICAgICAgLi4uKGUuY2hvaWNlcyA/IHsgY2hvaWNlczogZS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAgICAgLi4uKGUuaGludCA/IHsgaGludDogZS5oaW50IH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICAgIHsgc3RhdHVzOiBlLnN0YXR1cyB9LFxuICAgICAgKTtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFBhdGhFcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoZSkgfSwgeyBzdGF0dXM6IDUwMCB9KTtcbiAgfTtcblxuICBjb25zdCBldmVudHNSZXNwb25zZSA9IChyZXE6IFJlcXVlc3QsIHVybDogVVJMKTogUmVzcG9uc2UgPT4ge1xuICAgIHRvdWNoKCk7XG4gICAgcmV0dXJuIHNzZVJlc3BvbnNlKHtcbiAgICAgIGxvZyxcbiAgICAgIHNpbmNlOiBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIi0xXCIsIDEwKSxcbiAgICAgIGhlYXJ0YmVhdE1zOiBTU0VfSEVBUlRCRUFUX01TLFxuICAgICAgY2xpZW50czogc3NlQ2xpZW50cyxcbiAgICAgIHNpZ25hbDogcmVxLnNpZ25hbCxcbiAgICAgIG9uT3BlbjogdG91Y2gsXG4gICAgICBvbkNsb3NlOiB0b3VjaCxcbiAgICB9KTtcbiAgfTtcblxuICAvLyAtLS0gc2VydmUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBcIjEyNy4wLjAuMVwiLFxuICAgIHJvdXRlcyxcbiAgICBpZGxlVGltZW91dDogSURMRV9USU1FT1VUX1NFQyxcbiAgICBkZXZlbG9wbWVudDogeyBobXI6IG1vZGUgPT09IFwiZGV2XCIgfSxcbiAgICBmZXRjaChyZXEsIHNydikge1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSwgTk9XIFRIRSBLSVQnUyBBTkQgTk9XIFJPU1RFUi1XSURFLiBUaGlzIHdhcyB0aGVcbiAgICAgIC8vIGZpcnN0IGNvcHkgYW5kIGl0IGxpc3RlZCBwYXRocyAoYC93c2AsIGAvY21kYCwgYC9mcy9gKSDigJQgYSBsaXN0IHRoYXRcbiAgICAgIC8vIHdhcyBhbHJlYWR5IG1pc3NpbmcgYC9zdGF0ZWAsIHdoaWNoIGFuc3dlcnMgYSBzZXNzaW9uJ3Mgd2hvbGUgY29udGVudHMuXG4gICAgICAvLyBgc3JjL2tpdC93aXJlL29yaWdpbi50c2AgcmVmdXNlcyBvbiB0aGUgUkVRVUVTVCBpbnN0ZWFkLCBzbyBubyBwYXRoXG4gICAgICAvLyBpbnZlbnRvcnkgY2FuIGdvIHN0YWxlLCBhbmQgYGdyaW1vaXJlL29yaWdpbi1ndWFyZC13YXJkLnRlc3QudHNgIGhvbGRzXG4gICAgICAvLyB0aGUgb3RoZXIgZWlnaHQgZGFlbW9ucyB0byB0aGUgc2FtZSBsaW5lLlxuICAgICAge1xuICAgICAgICBjb25zdCByZWZ1c2VkID0gcmVmdXNlRm9yZWlnbk9yaWdpbihyZXEsIHNydi5wb3J0KTtcbiAgICAgICAgaWYgKHJlZnVzZWQpIHJldHVybiByZWZ1c2VkO1xuICAgICAgfVxuICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsKTtcbiAgICAgIGNvbnN0IHBhdGggPSB1cmwucGF0aG5hbWU7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgLy8g4pqgIFRIRSBTRVNTSU9OIFNBWVMgV0hBVCBJVFMgT1dOIFRJTUVPVVQgSVMuIGAtLXRpbWVvdXQgMGAgaGFzIGFsd2F5cyBtZWFudFxuICAvLyBcInN0YW5kIHVudGlsIGNsb3NlZFwiIGFuZCB0aGVyZSB3YXMgbm8gd2F5IHRvIGNvbmZpcm0gZnJvbSBvdXRzaWRlIHRoYXQgYVxuICAvLyBkYWVtb24gaGFkIHRha2VuIGl0IOKAlCB3aGljaCBpcyB0aGUga2luZCBvZiBzZXR0aW5nIHlvdSBmaW5kIG91dCBhYm91dCBieVxuICAvLyBsb3NpbmcgYSBzZXNzaW9uIGF0IHRoZSB3cm9uZyBtb21lbnQuXG4gIGxvZy5lbWl0KHtcbiAgICB0eXBlOiBcInJlYWR5XCIsXG4gICAgbW9kZSxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlLFxuICAgIGlkbGVfdGltZW91dF9zOiBvcHRzLnRpbWVvdXRTID8/IDE4MDAsXG4gIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICAvLyBFNjI6IG9uZSBsaW5lIHdoZW4gdGhlIHNlc3Npb24gaGFzIHNvbWV0aGluZyB3b3J0aCBsb29raW5nIGF0LCBhbmQgc2lsZW5jZVxuICAvLyB3aGVuIGl0IGRvZXMgbm90LlxuICAvL1xuICAvLyDim5QgQSBTVU1NQVJZLCBOT1QgQSBSRVBFQVQuIFRoZSBwZXItZG9jdW1lbnQgY29uZmxpY3RzIGFib3ZlIHNheSB0aGVpciBvd25cbiAgLy8gcGllY2Ugd2l0aCB0aGUgU2F2ZS9SZXZlcnQgbnVhbmNlOyB0aGlzIGNvdW50cyB3aGF0IGlzIHRoZXJlIOKAlCBpbmNsdWRpbmdcbiAgLy8gdGhlIHRoaW5ncyB0aG9zZSBsaW5lcyBuZXZlciBjb3ZlcmVkLCBsaWtlIGEgY29udGV4dCBlbnRyeSBwb2ludGluZyBhdFxuICAvLyBub3RoaW5nIOKAlCBhbmQgcG9pbnRzIGF0IHRoZSB2ZXJiLiBBIHN0YXJ0dXAgY2hlY2sgdGhhdCByZXN0YXRlcyB3aGF0IHdhc1xuICAvLyBqdXN0IHNhaWQsIG9yIHRoYXQgYW5ub3VuY2VzIGl0c2VsZiB3aGVuIGV2ZXJ5dGhpbmcgaXMgZmluZSwgaXMgYSBsaW5lXG4gIC8vIHBlb3BsZSBsZWFybiB0byBza2lwLlxuICB7XG4gICAgY29uc3QgbGlzdCA9IHNlc3Npb24uY2hlY2t1cCgpO1xuICAgIGNvbnN0IGxpbmUgPSBzdW1tYXJ5KGxpc3QpO1xuICAgIGlmIChsaW5lKSB7XG4gICAgICBhbm5vdW5jZShsaW5lLCB7IGZhY3Q6IFwiZG9jdG9yXCIsIGZpbmRpbmdzOiBsaXN0Lmxlbmd0aCB9KTtcbiAgICAgIC8vIFRoZSBhZ2VudCBnZXRzIHRoZSB3aG9sZSByZXBvcnQgb24gaXRzIHRhaWwsIHNvIGFuIGFnZW50IHRoYXQgYXJyaXZlc1xuICAgICAgLy8gbGF0ZXIgZG9lcyBub3QgaGF2ZSB0byBhc2sg4oCUIGFuZCBkb2VzIG5vdCBoYXZlIHRvIHBhcnNlIHRoZSBzZW50ZW5jZS5cbiAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJkb2N0b3JcIiwgY291bnQ6IGxpc3QubGVuZ3RoLCBmaW5kaW5nczogbGlzdCB9KTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRTUzJ3MgYXR0ZW50aW9uIHRpY2suIFNlcGFyYXRlIGZyb20gaG91c2VrZWVwaW5nIGJlY2F1c2UgaXQgaXMgYWJvdXQgdGhlXG4gICAqIEhVTUFOJ3MgcGF0aWVuY2UgcmF0aGVyIHRoYW4gdGhlIGRhZW1vbidzIGxpZmV0aW1lLCBhbmQgYmVjYXVzZSBpdCBtdXN0IHJ1blxuICAgKiBvbiBhIHNsb3dlciBjbG9jazogYSAyNTAgbXMgc3dlZXAgcmUtYnJvYWRjYXN0aW5nIHN0YXRlIHdvdWxkIGJlIGNodXJuIGZvciBhXG4gICAqIHZhbHVlIHRoYXQgY2hhbmdlcyB0d2ljZSBpbiBhIHdhaXQuXG4gICAqL1xuICBsZXQgbGFzdFdhaXRpbmc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBhdHRlbnRpb25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBub3csIHsgYWNrbm93bGVkZ2VkVW50aWwgfSk7XG4gICAgLy8gRTY1OiBhIG5vdGUgZmxpcHBpbmcgdG8gc3RhbGxlZCBpcyBhIGNoYW5nZSB0aGUgc3VyZmFjZSBtdXN0IHNlZSB0b28uXG4gICAgLy8g4pqgIE5PVCBhIG51ZGdlOiBzZWUgRTY1IGluIHRoZSBkZWNpc2lvbiBsb2cg4oCUIHRoZSBub3RlJ3MgYWN0IGlzIHRoZVxuICAgIC8vIGh1bWFuJ3MsIGFuZCB0aGUgZXZlbnQgdGhhdCBkZWxpdmVyZWQgaXQgYWxyZWFkeSBjYXJyaWVkIGl0LlxuICAgIGNvbnN0IG5vdGVzID0gbm90ZXNXYWl0aW5nKHNlc3Npb24ubm90ZUZhY3RzKCksIHNlc3Npb24ubWVzc2FnZXMoKSwgbm93LCB7XG4gICAgICBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICB9KTtcbiAgICBjb25zdCBrZXkgPSBhdHRlbnRpb25LZXkodywgbm90ZXMpO1xuICAgIGlmIChrZXkgPT09IGxhc3RXYWl0aW5nKSByZXR1cm47XG4gICAgbGFzdFdhaXRpbmcgPSBrZXk7XG4gICAgLy8gVGhlIGJhZGdlIGNoYW5nZWQsIHNvIHRoZSBzdXJmYWNlIG5lZWRzIHRoZSBuZXcgc25hcHNob3QuXG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICBpZiAoIXcpIHJldHVybjtcbiAgICBpZiAody5iYWRnZSAhPT0gXCJzdGFsbGVkXCIgfHwgbnVkZ2VkLmhhcyh3Lm1lc3NhZ2VJZCkpIHJldHVybjtcbiAgICBudWRnZWQuYWRkKHcubWVzc2FnZUlkKTtcbiAgICAvLyDim5QgVEhFIE5VREdFIEdPRVMgVE8gVEhFIEFHRU5UJ1MgVEFJTCBBTkQgTk9XSEVSRSBFTFNFLiBUaGUgaHVtYW4gYWxyZWFkeVxuICAgIC8vIHNlZXMgdGhlIGJhZGdlOyBwdXR0aW5nIHRoaXMgaW4gdGhlIGNoYXQgYXMgd2VsbCB3b3VsZCBiZSB0ZWxsaW5nIHRoZW1cbiAgICAvLyB3aGF0IHRoZXkgYXJlIGxvb2tpbmcgYXQuIEl0IGNhcnJpZXMgdGhlIG1lc3NhZ2UgVEVYVCBiZWNhdXNlIGFuIGFnZW50XG4gICAgLy8gdGhhdCBoYXMgYmVlbiBhd2F5IG5lZWRzIHRvIGtub3cgd2hhdCBpcyBwZW5kaW5nLCBub3QganVzdCB0aGF0IHNvbWV0aGluZ1xuICAgIC8vIGlzIOKAlCBhbmQgaXQgbmFtZXMgdGhlIHR3byB3YXlzIG91dCwgYmVjYXVzZSBhIG51ZGdlIHRoYXQgZG9lcyBub3Qgc2F5IGhvd1xuICAgIC8vIHRvIGFuc3dlciBpdCBpbnZpdGVzIGEgZm91cnRoIHByaW1pdGl2ZS5cbiAgICBjb25zdCBwZW5kaW5nID0gc2Vzc2lvbi5tZXNzYWdlcygpLmZpbmQoKG0pID0+IG0uaWQgPT09IHcubWVzc2FnZUlkKTtcbiAgICBsb2cuZW1pdCh7XG4gICAgICB0eXBlOiBcIndhaXRpbmdcIixcbiAgICAgIG1lc3NhZ2VfaWQ6IHcubWVzc2FnZUlkLFxuICAgICAgc2Vjb25kczogTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIHcuc2luY2UpIC8gMTAwMCksXG4gICAgICAuLi4ocGVuZGluZyA/IHsgdGV4dDogcGVuZGluZy50ZXh0IH0gOiB7fSksXG4gICAgICBoaW50OiBcInJlcGx5IHdpdGggYHNheWAsIG9yIGB3b3JraW5nYCB0byBzYXkgeW91IGFyZSBzdGlsbCBvbiBpdFwiLFxuICAgIH0pO1xuICB9LCAxMDAwKTtcblxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiAob3B0cy50aW1lb3V0UyA/PyAxODAwKSAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiLCBieTogXCJ0aW1lb3V0XCIgfSksXG4gIH0pO1xuXG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgbGV0IHJlc29sdmVTaHV0ZG93biE6ICgpID0+IHZvaWQ7XG4gIGNvbnN0IHNodXRkb3duID0gbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHtcbiAgICByZXNvbHZlU2h1dGRvd24gPSByO1xuICB9KTtcblxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvLyBUaGUgb3JkZXIgaXMgdGhlIGhlYWRlcidzLCBhbmQgdGhlIGhlYWRlciBzYXlzIHdoeS5cbiAgY29uc3QgY2xvc2UgPSAoYnk/OiBDbG9zZWRCeSkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgICBjbGVhckludGVydmFsKGF0dGVudGlvblRpbWVyKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2F0Y2hlcnMudmFsdWVzKCkpIHcuY2xvc2UoKTtcbiAgICB3YXRjaGVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdCBvZiBwZW5kaW5nLnZhbHVlcygpKSBjbGVhclRpbWVvdXQodCk7XG4gICAgLy8gV0hPIGVuZGVkIGl0IGdvZXMgaW4gdGhlIG1hbmlmZXN0IGJlZm9yZSB0aGUgcGVyc2lzdDogdGhlIG1hbmlmZXN0XG4gICAgLy8gb3V0bGl2ZXMgdGhpcyBkYWVtb24sIGFuZCBhIHZlcmIgcnVuIGFmdGVyIHRoZSBlbmQgcmVhZHMgaXQgdGhlcmUuXG4gICAgaWYgKGJ5KSBzZXNzaW9uLm1hcmtFbmRlZChieSk7XG4gICAgdHJ5IHtcbiAgICAgIHNlc3Npb24ucGVyc2lzdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgY2xlYW51cERpc2NvdmVyeSgpO1xuICAgIC8vIFdITyBlbmRlZCBpdCByaWRlcyB0aGUgZXZlbnQsIHNvIHRoZSBhZ2VudCdzIHRhaWwgY2FuIHRlbGwgdGhlIGh1bWFuJ3NcbiAgICAvLyBkZWxpYmVyYXRlIGVuZCBmcm9tIGl0cyBvd24gYGNsb3NlYCBvciB0aGUgaWRsZSB0aW1lb3V0IOKAlCBhbmQgdGhlXG4gICAgLy8gc3VyZmFjZSBnZXRzIHRoZSBzYW1lIGZhY3QgYmVmb3JlIGl0cyBzb2NrZXQgZ29lcywgc28gaXQgY2FuIHNheVxuICAgIC8vIFwiU2Vzc2lvbiBlbmRlZFwiIGluc3RlYWQgb2YgcmV0cnlpbmcgYSBkYWVtb24gdGhhdCBpcyBub3QgY29taW5nIGJhY2suXG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImNsb3NlZFwiLCAuLi4oYnkgPyB7IGJ5IH0gOiB7fSkgfSk7XG4gICAgaWYgKGJ5KSBzZW5kKHsgdHlwZTogXCJjbG9zZWRcIiwgYnkgfSk7XG4gICAgdm9pZCBkcmFpbkFuZFN0b3AoeyBzZXJ2ZXIsIGNsaWVudHM6IHNzZUNsaWVudHMsIHNvY2tldHMgfSkudGhlbihyZXNvbHZlU2h1dGRvd24pO1xuICB9O1xuICBkb25lLnRoZW4oKHIpID0+IGNsb3NlKHIuYnkpKTtcblxuICByZXR1cm4ge1xuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uSWQsXG4gICAgbW9kZSxcbiAgICBkaXI6IHNlc3Npb24uZGlyLFxuICAgIC8vIFRoZSB3b3Jrc3BhY2UgQVMgU1RBUlRFRCAoRTY3KTogYSBuZXcgc2Vzc2lvbidzLCBvciBhIHJlc3RvcmVkIG9uZSdzIG93bi5cbiAgICB3b3Jrc3BhY2U6IHNlc3Npb24ud29ya3NwYWNlLFxuICAgIGNsb3NlLFxuICAgIGRvbmUsXG4gICAgc2h1dGRvd24sXG4gIH07XG59XG5cbi8qKlxuICogQSBwYXRoIHR5cGVkIGluIHRoZSBTVVJGQUNFLiBUaGUgcGFnZSBoYXMgbm8gd29ya2luZyBkaXJlY3RvcnksIHNvIGEgcGF0aFxuICogZnJvbSBpdCBtdXN0IGJlIGFic29sdXRlIG9yIHN0YXJ0IGF0IGB+YCDigJQgd2hpY2ggaXMgZXhwYW5kZWQgSEVSRS4gQmVmb3JlXG4gKiB0aGlzLCBgfi9Eb2N1bWVudHNgIHJlYWNoZWQgYHJlc29sdmUoKWAgYW5kIHdhcyB0YWtlbiBhcyByZWxhdGl2ZSB0byB0aGVcbiAqIGRhZW1vbidzIGN3ZCAodGhlIHNraWxsIGZvbGRlcik6IHRoZSBwYXRoIGJveCBjb21wbGV0ZWQgYH4v4oCmYCAobGlzdGluZ1xuICogZXhwYW5kcyBpdCkgYW5kIHRoZW4gRW50ZXIgZmFpbGVkIHdpdGggXCJubyBzdWNoIGZpbGUgb3IgZm9sZGVyOlxuICog4oCmL3NraWxscy9zY3JpcHRvcml1bS9+L0RvY3VtZW50cy/igKZcIiAoQ29sZSwgMjAyNi0wOS0xMSkuXG4gKi9cbi8qKlxuICogVGhlIGh1bWFuJ3MgY2hhdCBsaW5lIHdoZW4gYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gaXMga2VwdFxuICogKEUyLCAjMTE3KTogd2hhdCBoYXBwZW5lZCB0byB0aGVpciB2ZXJzaW9uIG9mIFdISUNIIGRvY3VtZW50LCBubyBwYXRoLCBub1xuICogaW5zdHJ1Y3Rpb25zIG1lYW50IGZvciB0aGUgYWdlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBodW1hbk91dHNpZGVMaW5lKFxuICBuYW1lOiBzdHJpbmcsXG4gIHZlcnNpb246IG51bWJlcixcbiAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbjogYm9vbGVhbixcbik6IHN0cmluZyB7XG4gIHJldHVybiBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuXG4gICAgPyBgWW91IGFjdGl2YXRlZCB2JHt2ZXJzaW9ufSBvZiAke25hbWV9IGJlZm9yZSB0aGUgYWdlbnQgaGFkIHdyaXR0ZW4gaXQ7IHRoZSBhZ2VudCdzIHRleHQgaXMgdiR7cHJlc2VydmVkQXN9LmBcbiAgICA6IGB2JHt2ZXJzaW9ufSBvZiAke25hbWV9IHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yOyB0aGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc30sIGFuZCB2JHt2ZXJzaW9ufSBrZWVwcyB5b3Vycy5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3VyZmFjZVBhdGgocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHAudHJpbSgpO1xuICBpZiAodCA9PT0gXCJ+XCIgfHwgdC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBleHBhbmRIb21lKHQpO1xuICBpZiAoIWlzQWJzb2x1dGUodCkpXG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke3B9XCIgaXMgbm90IGEgZnVsbCBwYXRoIOKAlCBzdGFydCBpdCB3aXRoIC8gb3Igfi9gLCA0MDApO1xuICByZXR1cm4gcmVzb2x2ZSh0KTtcbn1cblxuLyoqIEEgc3RydWN0dXJlIG9wIGZyb20gdGhlIHN1cmZhY2UsIHdpdGggZXZlcnkgcGF0aCBmaWVsZCB0aHJvdWdoIGBzdXJmYWNlUGF0aGAuICovXG5mdW5jdGlvbiBhbmNob3JTdXJmYWNlUGF0aHMob3A6IFN0cnVjdHVyZU9wKTogU3RydWN0dXJlT3Age1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5vcCB9O1xuICBmb3IgKGNvbnN0IGsgb2YgW1wiZGlyXCIsIFwicGF0aFwiLCBcImludG9cIl0gYXMgY29uc3QpXG4gICAgaWYgKHR5cGVvZiBvdXRba10gPT09IFwic3RyaW5nXCIpIG91dFtrXSA9IHN1cmZhY2VQYXRoKG91dFtrXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gb3V0IGFzIFN0cnVjdHVyZU9wO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB3b3Jrc3BhY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgICAgd29ya3NwYWNlOiBmbGFncy53b3Jrc3BhY2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyLCB3b3Jrc3BhY2U6IGQud29ya3NwYWNlIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IGEgY2xlYW4gY2xvc2UgbGVhdmVzIG5vIGVtcHR5IGxvZyBiZWhpbmQuXG4gIGlmIChyZXMuY29kZSA9PT0gMCAmJiBmbGFncy5sb2cpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHN0YXRTeW5jKGZsYWdzLmxvZykuc2l6ZSA9PT0gMCkgdW5saW5rU3luYyhmbGFncy5sb2cpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG4gIHJldHVybiByZXMuY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGVcbiAqIGJ1bmRsZSwgc28gdGhlcmUgaXMgbm8gc3VjaCBibG9jayBoZXJlLCBhbmQgdGhpcyB0YWtlcyBubyBhcmd1bWVudHM6IHRoZVxuICogY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8vIFdITyBJUyBBTExPV0VEIFRPIERSSVZFIEEgTE9DQUwgREFFTU9OIOKAlCB0aGUgb25lIGNoZWNrIHRoYXQgbWFrZXMgYVxuLy8gbG9jYWxob3N0IHBvcnQgbm90IGEgcHVibGljIEFQSS5cbi8vXG4vLyDim5QgVEhFIEhPTEUgVEhJUyBDTE9TRVMgV0FTIERFTU9OU1RSQVRFRCwgTk9UIElNQUdJTkVELiBBIHNwZWxsIGRhZW1vbiBiaW5kc1xuLy8gYDEyNy4wLjAuMTo8cG9ydD5gIGFuZCBhbnN3ZXJzIHdoYXRldmVyIGFza3MuICoqQW55IHdlYiBwYWdlIHRoZSBodW1hbiBpc1xuLy8gYnJvd3NpbmcgY2FuIHJlYWNoIGl0Kio6IGBuZXcgV2ViU29ja2V0KFwid3M6Ly8xMjcuMC4wLjE6PHBvcnQ+L3dzXCIpYCBhbmRcbi8vIGBmZXRjaChcImh0dHA6Ly8xMjcuMC4wLjE6PHBvcnQ+L2NtZFwiLCB7bWV0aG9kOlwiUE9TVFwiLCDigKZ9KWAgYXJlIG9yZGluYXJ5XG4vLyBzYW1lLW1hY2hpbmUgcmVxdWVzdHMsIGFuZCB0aGUgYnJvd3NlciBtYWtlcyB0aGVtIGZyb20gYSBwYWdlIHRoZSBodW1hbiBkaWRcbi8vIG5vdCB3cml0ZS4gU2NyaXB0b3JpdW0ncyB2ZXJpZnkgcGFzcyBidWlsdCBhIHdvcmtpbmcgb25lIOKAlCBhIGZvcmVpZ24gcGFnZVxuLy8gZHJpdmluZyBgb3BlbmAgdGhlbiBgc2F2ZWAgdG8gd3JpdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgZmlsZSBvdXRzaWRlIHRoZVxuLy8gc2Vzc2lvbiAoMjAyNi0wOS0xMSkuIFRoYXQgaXMgYSBmaWxlIHdyaXRlIGZyb20gYSBwYWdlIHRoZSBodW1hbiBtZXJlbHlcbi8vIHZpc2l0ZWQuXG4vL1xuLy8g4puUIEFORCBUSEUgV0hPTEUgRklYIFJFU1RTIE9OIE9ORSBBU1lNTUVUUlk6ICoqb25seSBicm93c2VycyBzZW5kIGBPcmlnaW5gLioqXG4vLyBBIGJyb3dzZXIgYXR0YWNoZXMgaXQgdG8gZXZlcnkgY3Jvc3Mtb3JpZ2luIHJlcXVlc3QgYW5kIGNhbm5vdCBiZSB0YWxrZWQgb3V0XG4vLyBvZiBpdCDigJQgaXQgaXMgc2V0IGJ5IHRoZSB1c2VyIGFnZW50LCBub3QgYnkgdGhlIHBhZ2UncyBzY3JpcHQuIEJ1bidzIGBmZXRjaGAsXG4vLyB3aGljaCBpcyB3aGF0IGV2ZXJ5IHNwZWxsJ3MgQ0xJIHVzZXMsIHNlbmRzIG5vbmUgYXQgYWxsLiBTbzpcbi8vXG4vLyAgICAgT3JpZ2luIGFic2VudCAgICAgICAgICAgIOKGkiB0aGUgQ0xJLCBgY3VybGAsIGEgdGVzdC4gQUxMT1cuXG4vLyAgICAgT3JpZ2luID09PSBvdXIgb3duIHBhZ2UgIOKGkiB0aGUgc3VyZmFjZSB3ZSBzZXJ2ZWQuIEFMTE9XLlxuLy8gICAgIE9yaWdpbiBhbnl0aGluZyBlbHNlICAgICDihpIgYSBwYWdlIHdlIGRpZCBub3Qgc2VydmUuIFJFRlVTRS5cbi8vXG4vLyDimqAgVEhBVCBJUyBXSFkgVEhJUyBORUVEUyBOTyBQRVItU1BFTEwgUk9VVEUgSU5WRU5UT1JZLCBhbmQgd2h5IGl0IGlzIGFwcGxpZWRcbi8vIHRvIEVWRVJZIHBhdGggcmF0aGVyIHRoYW4gdG8gYSBoYW5kLWxpc3RlZCBzZXQgb2YgbXV0YXRpbmcgb25lcy4gQSBsaXN0IG9mXG4vLyBcInRoZSBkYW5nZXJvdXMgcm91dGVzXCIgaXMgYSB0aGluZyB0aGF0IGdvZXMgc3RhbGUgdGhlIG5leHQgdGltZSBhIHJvdXRlIGlzXG4vLyBhZGRlZDsgdGhlIGFzeW1tZXRyeSBhYm92ZSBpcyBhIHByb3BlcnR5IG9mIHRoZSByZXF1ZXN0LCBub3Qgb2YgdGhlIFVSTC4gVGhlXG4vLyBmaXJzdCB2ZXJzaW9uIG9mIHRoaXMgY2hlY2sgKHNjcmlwdG9yaXVtJ3MsIGBzZXJ2ZXIudHNgKSBkaWQgbGlzdCBwYXRocyDigJRcbi8vIGAvd3NgLCBgL2NtZGAsIGAvZnMvYCDigJQgYW5kIHRoYXQgbGlzdCB3YXMgYWxyZWFkeSBpbmNvbXBsZXRlIGJ5IHRoZSB0aW1lIGl0XG4vLyB3YXMgbGlmdGVkIGhlcmUsIGJlY2F1c2UgYC9zdGF0ZWAgYW5zd2VycyBldmVyeXRoaW5nIGluIGEgc2Vzc2lvbiB0byBhbnlvbmVcbi8vIHdobyBhc2tzLiBCcm9hZGVuaW5nIGl0IHRvIGV2ZXJ5IHBhdGggaXMgYm90aCBzaW1wbGVyIGFuZCBzdHJpY3Rlci5cbi8vXG4vLyDimqAgV0hBVCBJVCBERUxJQkVSQVRFTFkgRE9FUyBOT1QgRE8uIEl0IGlzIG5vdCBhdXRoZW50aWNhdGlvbjogYW55dGhpbmcgb25cbi8vIHRoaXMgbWFjaGluZSB0aGF0IGNhbiBmb3JnZSBvciBvbWl0IGEgaGVhZGVyIGlzIHVuYWZmZWN0ZWQsIGFuZCBpcyBzdXBwb3NlZFxuLy8gdG8gYmUg4oCUIHRoZSBDTEkgaXMgZXhhY3RseSBzdWNoIGEgY2FsbGVyLiBJdCBzdG9wcyB0aGUgQlJPV1NFUi1zaGFwZWQgYXR0YWNrLFxuLy8gd2hpY2ggaXMgdGhlIG9uZSBhIGh1bWFuIGlzIGV4cG9zZWQgdG8gYnkgcmVhZGluZyB0aGVpciBtYWlsLlxuXG4vKipcbiAqIEJvdGggbG9vcGJhY2sgc3BlbGxpbmdzIGEgYnJvd3NlciBtYXkgcHV0IGluIGBPcmlnaW5gIGZvciBvdXIgb3duIHBhZ2UuXG4gKlxuICog4puUIEFOIFVOS05PV04gUE9SVCBNQVRDSEVTIE5PVEhJTkcsIGFuZCBhIGNlbGwgaGFkIHRvIHByb3ZlIGl0LiBgc3J2LnBvcnRgIGlzXG4gKiB0eXBlZCBgbnVtYmVyIHwgdW5kZWZpbmVkYCwgYW5kIHRoZSBmaXJzdCB2ZXJzaW9uIG9mIHRoaXMgaW50ZXJwb2xhdGVkIGl0XG4gKiBzdHJhaWdodCBpbnRvIHRoZSB0ZW1wbGF0ZSDigJQgc28gd2l0aCBubyBwb3J0IHRoZSBhbGxvd2VkIHNldCBiZWNhbWVcbiAqIGBodHRwOi8vMTI3LjAuMC4xOnVuZGVmaW5lZGAsIGEgc3RyaW5nIGEgcGFnZSBjYW4gc2ltcGx5IEJFIGhvc3RlZCBhdC4gQW5cbiAqIGVtcHR5IHNldCBpcyB0aGUgb25seSBzYWZlIHJlYWRpbmcgb2YgXCJ3ZSBkbyBub3Qga25vdyB3aG8gd2UgYXJlXCIuXG4gKi9cbmZ1bmN0aW9uIG91cnMocG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICBpZiAodHlwZW9mIHBvcnQgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIFtdO1xuICByZXR1cm4gW2BodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBgaHR0cDovL2xvY2FsaG9zdDoke3BvcnR9YF07XG59XG5cbi8qKlxuICogSXMgdGhpcyByZXF1ZXN0IGFsbG93ZWQgdG8gZHJpdmUgdGhlIGRhZW1vbj9cbiAqXG4gKiBBbiBhYnNlbnQgYE9yaWdpbmAgKHRoZSBDTEksIGBjdXJsYCwgYSB0ZXN0KSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlO1xuICogbm90aGluZyBlbHNlLlxuICpcbiAqIOKaoCBCT1RIIExPT1BCQUNLIFNQRUxMSU5HUyBBUkUgQUNDRVBURUQgYmVjYXVzZSB0aGUgaHVtYW4gdHlwZXMgdGhlIFVSTC4gVGhlXG4gKiBkYWVtb24gcHJpbnRzIGBodHRwOi8vMTI3LjAuMC4xOjxwb3J0PmAsIGJ1dCBhIHBlcnNvbiB3aG8gdmlzaXRzXG4gKiBgbG9jYWxob3N0Ojxwb3J0PmAgZ2V0cyBhIHBhZ2Ugd2hvc2UgYE9yaWdpbmAgaXMgYGxvY2FsaG9zdGAg4oCUIGFuZCByZWZ1c2luZ1xuICogaXQgd291bGQgYnJlYWsgdGhlIHN1cmZhY2UgZm9yIHRoZSBvbmUgdXNlciB3aG8gdHlwZWQgdGhlIGZyaWVuZGxpZXIgbmFtZS5cbiAqIGBbOjoxXWAgaXMgTk9UIGFjY2VwdGVkOiBub3RoaW5nIHByaW50cyBpdCwgYW5kIGEgc3BlbGxpbmcgbm90aGluZyBoYW5kcyBvdXRcbiAqIGlzIG5vdCBhIHNwZWxsaW5nIHRvIHdpZGVuIGZvciBvbiBzcGVjdWxhdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhbWVPcmlnaW4ocmVxOiBSZXF1ZXN0LCBwb3J0OiBudW1iZXIgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgY29uc3Qgb3JpZ2luID0gcmVxLmhlYWRlcnMuZ2V0KFwib3JpZ2luXCIpO1xuICBpZiAob3JpZ2luID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIG91cnMocG9ydCkuaW5jbHVkZXMob3JpZ2luKTtcbn1cblxuLyoqXG4gKiBUaGUgZ3VhcmQsIGFzIGEgYGZldGNoYCBwcm9sb2d1ZTogYSBgUmVzcG9uc2VgIHdoZW4gdGhlIHJlcXVlc3QgbXVzdCBiZVxuICogcmVmdXNlZCwgYG51bGxgIHdoZW4gaXQgbWF5IHByb2NlZWQuXG4gKlxuICog4puUIFJFVFVSTlMgVEhFIFJFRlVTQUwgUkFUSEVSIFRIQU4gVEhST1dJTkcsIHNvIGEgY2FsbGVyIGNhbm5vdCBoYWxmLWFwcGx5XG4gKiBpdC4gVGhlIHdob2xlIGZhaWx1cmUgbW9kZSB0aGlzIGNsb3NlcyBpcyBhbiBlZGl0IHRoYXQgZ2V0cyBmb3Jnb3R0ZW4gaW4gb25lXG4gKiBvZiBuaW5lIGNvcGllcywgYW5kIGBpZiAoeCkgcmV0dXJuIHg7YCBpcyB0aGUgc2hvcnRlc3Qgc2hhcGUgdGhhdCBjYW5ub3QgYmVcbiAqIHdyaXR0ZW4gd3JvbmcuIDQwMyB3aXRoIGEgSlNPTiBib2R5LCBiZWNhdXNlIGV2ZXJ5IHNwZWxsJ3Mgd2lyZSBhbnN3ZXJzIEpTT05cbiAqIGFuZCBhIHJlZnVzYWwgdGhhdCBicmVha3MgdGhhdCBzaGFwZSBpcyBhIHNlY29uZCBidWcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZ1c2VGb3JlaWduT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKHNhbWVPcmlnaW4ocmVxLCBwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJmb3JlaWduIG9yaWdpbiByZWZ1c2VkXCIgfSwgeyBzdGF0dXM6IDQwMyB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pdGVtcy9kYWVtb24tc3BpbmUtY2Vuc3VzL3dyaXRlLXVwLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8vIEZpbmRpbmcgd2hlcmUgYSBub3RlIGJlbG9uZ3MsIGluIGEgZG9jdW1lbnQgdGhhdCBoYXMgbW92ZWQgdW5kZXIgaXQgKEU0NSkuXG4vL1xuLy8g4puUIFFVT1RFRC1URVhUIEFOQ0hPUklORywgQU5EIFRIRSBBTFRFUk5BVElWRSBJUyBXSFkuIEFuIG9mZnNldCBnb2VzIHN0YWxlIG9uXG4vLyB0aGUgbmV4dCBrZXlzdHJva2U6IGZpeCBhIHR5cG8gdGhyZWUgbGluZXMgdXAgYW5kIGV2ZXJ5IG5vdGUgYmVsb3cgcG9pbnRzIGF0XG4vLyB0aGUgd3Jvbmcgd29yZHMuIFBpbm5pbmcgYSBub3RlIHRvIHRoZSBWRVJTSU9OIGl0IHdhcyBtYWRlIG9uIHdvdWxkIGJlIGV4YWN0XG4vLyBmb3JldmVyIGFuZCB1c2VsZXNzIOKAlCB0aGUgc3RhdGVkIHVzZSBpcyBtYWtpbmcgbm90ZXMgV0hJTEUgcmVhZGluZyBhbmRcbi8vIGVkaXRpbmcsIGFuZCBhIG5vdGUgdGhhdCBkZXRhY2hlcyB0aGUgbW9tZW50IHlvdSBlZGl0IGlzIGEgbm90ZSB5b3UgY2Fubm90XG4vLyB1c2UuIFNvIGEgbm90ZSByZW1lbWJlcnMgdGhlIFRFWFQgaXQgd2FzIG1hZGUgb24sIHBsdXMgYSBsaXR0bGUgb2Ygd2hhdFxuLy8gc3Vycm91bmRlZCBpdCwgYW5kIGlzIHJlLWZvdW5kIG9uIGV2ZXJ5IHJlYWQgKENvbGUgYXBwcm92ZWQgdGhlIHRyYWRlOiBcIndlXG4vLyB0ZXN0IGl0IG91dCBhbmQgc2VlIGlmIGl0IHdvcmtzIGFuZCBhZGp1c3QgYXMgbmVlZGVkXCIpLlxuLy9cbi8vIOKblCBBTkQgSVQgU0FZUyBXSEVOIElUIEhBUyBMT1NULiBUaGUgZm91cnRoIG91dGNvbWUgaXMgT1JQSEFORUQg4oCUIHRoZSBxdW90ZSBpc1xuLy8gZ29uZSBhbmQgdGhlIG5vdGUgaXMgc2hvd24gZGV0YWNoZWQgcmF0aGVyIHRoYW4gcGlubmVkIHNvbWV3aGVyZSBwbGF1c2libGUuXG4vLyBWaXNpYmxlLWFuZC13cm9uZyBiZWF0cyBpbnZpc2libGUtYW5kLXdyb25nOyBhIG5vdGUgc2lsZW50bHkgcmUtYW5jaG9yZWQgb250b1xuLy8gdW5yZWxhdGVkIHdvcmRzIGlzIHRoZSBmYWlsdXJlIHRoaXMgZGVzaWduIGV4aXN0cyB0byBhdm9pZC5cblxuLyoqIEhvdyBtdWNoIHRleHQgZWl0aGVyIHNpZGUgaXMga2VwdCwgdG8gdGVsbCBpZGVudGljYWwgcXVvdGVzIGFwYXJ0LiAqL1xuZXhwb3J0IGNvbnN0IENPTlRFWFRfQ0hBUlMgPSA0ODtcblxuLyoqIFdoYXQgYSBub3RlIHJlbWVtYmVycyBhYm91dCB3aGVyZSBpdCB3YXMgbWFkZS4gKi9cbmV4cG9ydCB0eXBlIEFuY2hvciA9IHtcbiAgLyoqIFRoZSB0ZXh0IHRoZSBub3RlIHdhcyBtYWRlIG9uLiBFbXB0eSBtZWFucyB0aGUgbm90ZSBpcyBhYm91dCB0aGUgZG9jdW1lbnQuICovXG4gIHF1b3RlOiBzdHJpbmc7XG4gIC8qKiBUaGUgY2hhcmFjdGVycyBpbW1lZGlhdGVseSBiZWZvcmUgYW5kIGFmdGVyIHRoZSBxdW90ZSwgd2hlbiBpdCB3YXMgbWFkZS4gKi9cbiAgYmVmb3JlOiBzdHJpbmc7XG4gIGFmdGVyOiBzdHJpbmc7XG4gIC8qKiBXaGVyZSBpdCB3YXMgdGhlbiDigJQgYSBISU5UIGZvciBjaG9vc2luZyBiZXR3ZWVuIGlkZW50aWNhbCBxdW90ZXMsIG5ldmVyIGEgc291cmNlIG9mIHRydXRoLiAqL1xuICBhdDogbnVtYmVyO1xufTtcblxuLyoqIFdoZXJlIGEgbm90ZSBiZWxvbmdzIG5vdywgYW5kIGhvdyBzdXJlIHdlIGFyZS4gKi9cbmV4cG9ydCB0eXBlIEZvdW5kID1cbiAgfCB7IGZyb206IG51bWJlcjsgdG86IG51bWJlcjsgaG93OiBcImNvbnRleHRcIiB8IFwidW5pcXVlXCIgfCBcIm5lYXJlc3RcIiB9XG4gIHwgeyBmcm9tOiBudWxsOyB0bzogbnVsbDsgaG93OiBcIm9ycGhhbmVkXCIgfTtcblxuY29uc3QgT1JQSEFORUQ6IEZvdW5kID0geyBmcm9tOiBudWxsLCB0bzogbnVsbCwgaG93OiBcIm9ycGhhbmVkXCIgfTtcblxuLyoqIFRha2UgYW4gYW5jaG9yIGZyb20gYSBzZWxlY3Rpb24g4oCUIHdoYXQgdGhlIG5vdGUgd2lsbCByZW1lbWJlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbmNob3JPZih0ZXh0OiBzdHJpbmcsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IEFuY2hvciB7XG4gIHJldHVybiB7XG4gICAgcXVvdGU6IHRleHQuc2xpY2UoZnJvbSwgdG8pLFxuICAgIGJlZm9yZTogdGV4dC5zbGljZShNYXRoLm1heCgwLCBmcm9tIC0gQ09OVEVYVF9DSEFSUyksIGZyb20pLFxuICAgIGFmdGVyOiB0ZXh0LnNsaWNlKHRvLCB0byArIENPTlRFWFRfQ0hBUlMpLFxuICAgIGF0OiBmcm9tLFxuICB9O1xufVxuXG4vKiogRXZlcnkgaW5kZXggYXQgd2hpY2ggYG5lZWRsZWAgb2NjdXJzIGluIGBoYXlgLCBpbmNsdWRpbmcgb3ZlcmxhcHMuICovXG5mdW5jdGlvbiBvY2N1cnJlbmNlcyhoYXk6IHN0cmluZywgbmVlZGxlOiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGlmIChuZWVkbGUgPT09IFwiXCIpIHJldHVybiBbXTtcbiAgY29uc3QgZm91bmQ6IG51bWJlcltdID0gW107XG4gIGxldCBpID0gaGF5LmluZGV4T2YobmVlZGxlKTtcbiAgd2hpbGUgKGkgIT09IC0xKSB7XG4gICAgZm91bmQucHVzaChpKTtcbiAgICBpID0gaGF5LmluZGV4T2YobmVlZGxlLCBpICsgMSk7XG4gIH1cbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKipcbiAqIFdoZXJlIHRoZSBub3RlIGJlbG9uZ3MgaW4gYHRleHRgIG5vdy5cbiAqXG4gKiBGb3VyIGFuc3dlcnMsIHRyaWVkIGluIG9yZGVyLCBhbmQgZWFjaCBzYXlzIGhvdyBpdCB3YXMgcmVhY2hlZCBzbyB0aGUgc3VyZmFjZVxuICogY2FuIHNob3cgYSByZS1hbmNob3JlZCBub3RlIGRpZmZlcmVudGx5IGZyb20gYSBjZXJ0YWluIG9uZTpcbiAqXG4gKiAxLiAqKmNvbnRleHQqKiDigJQgdGhlIHF1b3RlIFdJVEggaXRzIHN1cnJvdW5kaW5ncyBvY2N1cnMgZXhhY3RseSBvbmNlLiBUaGVcbiAqICAgIHN0cm9uZ2VzdCBhbnN3ZXI6IHR3byBpZGVudGljYWwgc2VudGVuY2VzIGFyZSB0b2xkIGFwYXJ0IGJ5IHdoYXQgaXNcbiAqICAgIGFyb3VuZCB0aGVtLlxuICogMi4gKip1bmlxdWUqKiDigJQgdGhlIHF1b3RlIG9jY3VycyBleGFjdGx5IG9uY2UuIEl0cyBzdXJyb3VuZGluZ3MgY2hhbmdlZCwgdGhlXG4gKiAgICB0ZXh0IGRpZCBub3QuXG4gKiAzLiAqKm5lYXJlc3QqKiDigJQgdGhlIHF1b3RlIG9jY3VycyBzZXZlcmFsIHRpbWVzOyB0aGUgb25lIGNsb3Nlc3QgdG8gd2hlcmUgaXRcbiAqICAgIHVzZWQgdG8gYmUgd2lucy4gQSBndWVzcywgYW5kIGxhYmVsbGVkIGFzIG9uZS5cbiAqIDQuICoqb3JwaGFuZWQqKiDigJQgdGhlIHF1b3RlIGlzIGdvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQW5jaG9yKHRleHQ6IHN0cmluZywgYW5jaG9yOiBBbmNob3IpOiBGb3VuZCB7XG4gIGlmIChhbmNob3IucXVvdGUgPT09IFwiXCIpIHJldHVybiBPUlBIQU5FRDtcblxuICAvLyAxLiBXaXRoIGNvbnRleHQuIFRoZSByZWNvcmRlZCBjb250ZXh0IG1heSBpdHNlbGYgYmUgY2xpcHBlZCBhdCBhIGRvY3VtZW50XG4gIC8vICAgIGVkZ2UsIHNvIHRoZSB3aG9sZSBydW4gaXMgc2VhcmNoZWQgcmF0aGVyIHRoYW4gYXNzZW1ibGVkIGJsaW5kbHkuXG4gIGNvbnN0IHdpdGhDb250ZXh0ID0gYW5jaG9yLmJlZm9yZSArIGFuY2hvci5xdW90ZSArIGFuY2hvci5hZnRlcjtcbiAgY29uc3QgY29udGV4dHMgPSBvY2N1cnJlbmNlcyh0ZXh0LCB3aXRoQ29udGV4dCk7XG4gIGlmIChjb250ZXh0cy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCBmcm9tID0gKGNvbnRleHRzWzBdIGFzIG51bWJlcikgKyBhbmNob3IuYmVmb3JlLmxlbmd0aDtcbiAgICByZXR1cm4geyBmcm9tLCB0bzogZnJvbSArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJjb250ZXh0XCIgfTtcbiAgfVxuXG4gIGNvbnN0IGhpdHMgPSBvY2N1cnJlbmNlcyh0ZXh0LCBhbmNob3IucXVvdGUpO1xuICBpZiAoaGl0cy5sZW5ndGggPT09IDApIHJldHVybiBPUlBIQU5FRDtcblxuICAvLyAyLiBUaGUgcXVvdGUgYWxvbmUsIG9uY2UuXG4gIGlmIChoaXRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IGZyb20gPSBoaXRzWzBdIGFzIG51bWJlcjtcbiAgICByZXR1cm4geyBmcm9tLCB0bzogZnJvbSArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJ1bmlxdWVcIiB9O1xuICB9XG5cbiAgLy8gMy4gU2V2ZXJhbCDigJQgdGFrZSB0aGUgb25lIG5lYXJlc3Qgd2hlcmUgaXQgd2FzLiBgYXRgIGlzIGEgaGludCwgd2hpY2ggaXNcbiAgLy8gICAgd2h5IHRoaXMgYW5zd2VyIGlzIGxhYmVsbGVkOiB0aGUgbm90ZSBtYXkgaGF2ZSBsYW5kZWQgb24gYSB0d2luLlxuICBsZXQgYmVzdCA9IGhpdHNbMF0gYXMgbnVtYmVyO1xuICBmb3IgKGNvbnN0IGhpdCBvZiBoaXRzKSBpZiAoTWF0aC5hYnMoaGl0IC0gYW5jaG9yLmF0KSA8IE1hdGguYWJzKGJlc3QgLSBhbmNob3IuYXQpKSBiZXN0ID0gaGl0O1xuICByZXR1cm4geyBmcm9tOiBiZXN0LCB0bzogYmVzdCArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJuZWFyZXN0XCIgfTtcbn1cblxuLyoqIEEgb25lLWxpbmUgdmVyc2lvbiBvZiB0aGUgcXVvdGUsIGZvciBhIGxpc3QgdGhhdCBjYW5ub3Qgc2hvdyBhbGwgb2YgaXQuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVMYWJlbChxdW90ZTogc3RyaW5nLCBtYXggPSA2MCk6IHN0cmluZyB7XG4gIGNvbnN0IGZsYXQgPSBxdW90ZS5yZXBsYWNlKC9cXHMrL2d1LCBcIiBcIikudHJpbSgpO1xuICByZXR1cm4gZmxhdC5sZW5ndGggPD0gbWF4ID8gZmxhdCA6IGAke2ZsYXQuc2xpY2UoMCwgbWF4IC0gMSkudHJpbUVuZCgpfeKApmA7XG59XG5cbi8qKlxuICogVGhlIDEtYmFzZWQgbGluZXMgYFtmcm9tLCB0bylgIGNvdmVycyAoRTY1KSwgYXMgYSBodW1hbiBjb3VudHMgdGhlbTogYSByYW5nZVxuICogdGhhdCBlbmRzIGp1c3QgYWZ0ZXIgYSBuZXdsaW5lIGVuZHMgb24gdGhlIGxpbmUgaXQgZmluaXNoZWQsIG5vdCB0aGUgbmV4dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpbmVzT2YodGV4dDogc3RyaW5nLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiB7IGZyb206IG51bWJlcjsgdG86IG51bWJlciB9IHtcbiAgY29uc3QgbGluZUF0ID0gKGk6IG51bWJlcikgPT4ge1xuICAgIGxldCBuID0gMTtcbiAgICBmb3IgKGxldCBrID0gdGV4dC5pbmRleE9mKFwiXFxuXCIpOyBrICE9PSAtMSAmJiBrIDwgaTsgayA9IHRleHQuaW5kZXhPZihcIlxcblwiLCBrICsgMSkpIG4rKztcbiAgICByZXR1cm4gbjtcbiAgfTtcbiAgcmV0dXJuIHsgZnJvbTogbGluZUF0KGZyb20pLCB0bzogbGluZUF0KE1hdGgubWF4KGZyb20sIHRvIC0gMSkpIH07XG59XG4iLAogICAgIi8vIENvbXBhcmluZyB0d28gdGV4dHMsIGFuZCB0YWtpbmcgcGFydCBvZiBvbmUgaW50byB0aGUgb3RoZXIgKEUzNikuXG4vL1xuLy8g4puUIE9ORSBESUZGLCBDT01QVVRFRCBJTiBUSEUgREFFTU9OLiBgQGNvZGVtaXJyb3IvbWVyZ2VgIHdhcyBtZWFzdXJlZCBmaXJzdFxuLy8gYW5kIGl0IGlzIGJ1bmRsZS1jbGVhbiDigJQgaXRzIG9ubHkgZGVwZW5kZW5jaWVzIGFyZSBgQGNvZGVtaXJyb3IvbGFuZ3VhZ2VgLFxuLy8gYHN0YXRlYCwgYHZpZXdgIGFuZCBgQGxlemVyL2hpZ2hsaWdodGAsIGV2ZXJ5IG9uZSBvZiB3aGljaCB0aGUgc3VyZmFjZVxuLy8gYWxyZWFkeSBzaGlwcywgc28gd2FyZCAxYiBoYXMgbm90aGluZyB0byBzYXkgYWJvdXQgaXQuIEl0IGlzIG5vdCB1c2VkXG4vLyBhbnl3YXksIGFuZCB0aGUgcmVhc29uIGlzIG5vdCB3ZWlnaHQ6IGl0IHdvdWxkIGdpdmUgdGhlIFNVUkZBQ0UgaXRzIG93blxuLy8gZGlmZiB3aGlsZSB0aGUgYGRpZmZgIENMSSB2ZXJiIHVzZWQgdGhpcyBtb2R1bGUncywgYW5kIGEgaHVuayB0aGUgaHVtYW5cbi8vIGFjY2VwdHMgd291bGQgdGhlbiBiZSBhIGh1bmsgYSBkaWZmZXJlbnQgZW5naW5lIGZvdW5kLiBUd28gZGlmZiBlbmdpbmVzIG92ZXJcbi8vIG9uZSBkb2N1bWVudCBpcyB0aGUgbG9ja3N0ZXAtbWlycm9yIGRyaWZ0IHRoaXMgcmVwbyBoYXMgYWxyZWFkeSBwYWlkIGZvclxuLy8gb25jZS4gVGhlIHN1cmZhY2UgcmVuZGVycyB0aGUgaHVua3MgdGhlIGRhZW1vbiBjb21wdXRlZCwgYW5kIGBtZXJnZWAgYXBwbGllc1xuLy8gdGhlIHNhbWUgb25lcyDigJQgc28gYSBtaXNtYXRjaCBpcyBub3QgYSBidWcgdGhhdCBjYW4gYmUgd3JpdHRlbiBoZXJlLlxuLy9cbi8vIFdoYXQgdGhpcyBkZWxpYmVyYXRlbHkgaXMgbm90OiBhIHNlbWFudGljIG9yIHN5bnRhY3RpYyBkaWZmLiBJdCBjb21wYXJlc1xuLy8gTElORVMsIHRoZW4gcmVmaW5lcyBpbnNpZGUgcGFpcmVkIGxpbmVzIGJ5IFdPUkQsIHdoaWNoIGlzIHdoYXQgYSBwcm9zZVxuLy8gcmVhZGVyIHdhbnRzIOKAlCBtb3ZlZCBwYXJhZ3JhcGhzIHJlYWQgYXMgYSBkZWxldGUgYW5kIGFuIGFkZCwgYW5kIHRoYXQgaXNcbi8vIHRoZSBob25lc3QgYW5zd2VyIHJhdGhlciB0aGFuIGEgd3JvbmcgY2xldmVyIG9uZS5cbmltcG9ydCB0eXBlIHsgRGlmZiwgRGlmZkh1bmssIERpZmZMaW5lLCBEaWZmU3BhbiB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogU3BsaXR0aW5nIG9uIFwiXFxuXCIgYW5kIGpvaW5pbmcgb24gXCJcXG5cIiByb3VuZC10cmlwcyBleGFjdGx5LCBJTkNMVURJTkcgdGhlXG4gKiB0cmFpbGluZyBlbXB0eSBzdHJpbmcgYSBmaWxlIGVuZGluZyBpbiBhIG5ld2xpbmUgcHJvZHVjZXMuIFRoYXQgZW1wdHkgbGluZVxuICogaXMgcmVhbCBhcyBmYXIgYXMgdGhpcyBtb2R1bGUgaXMgY29uY2VybmVkLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgbWVyZ2UgZnJvbVxuICogcXVpZXRseSBhZGRpbmcgb3IgZHJvcHBpbmcgYSBmaW5hbCBuZXdsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjYXAgb24gTXllcnMnIEQg4oCUIHRoZSBudW1iZXIgb2YgZWRpdHMgaXQgd2lsbCB3YWxrIGJlZm9yZSBnaXZpbmcgdXAuXG4gKiBUd28gdGV4dHMgZGlmZmVyaW5nIGJ5IG1vcmUgdGhhbiB0aGlzIGFyZSBub3Qgc29tZXRoaW5nIGEgaHVtYW4gcmVhZHMgaHVua1xuICogYnkgaHVuayBhbnl3YXksIGFuZCB0aGUgcXVhZHJhdGljIHdvcnN0IGNhc2UgaXMgd2hhdCB0aGUgY2FwIGV4aXN0cyB0byBrZWVwXG4gKiBvdXQgb2YgYSBkYWVtb24gc2VydmluZyBhIHN1cmZhY2UuXG4gKi9cbmNvbnN0IE1BWF9FRElUUyA9IDMwMDA7XG5cbi8qKlxuICogTXllcnMnIGdyZWVkeSBPKE5EKSBkaWZmIG92ZXIgbGluZXMuIFJldHVybnMgdGhlIHRyYWNlIG9mIFYgYXJyYXlzLCBvciBudWxsXG4gKiB3aGVuIHRoZSB0ZXh0cyBkaWZmZXIgYnkgbW9yZSB0aGFuIGBNQVhfRURJVFNgLlxuICovXG5mdW5jdGlvbiBteWVyc1RyYWNlKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IEludDMyQXJyYXlbXSB8IG51bGwge1xuICBjb25zdCBuID0gYS5sZW5ndGg7XG4gIGNvbnN0IG0gPSBiLmxlbmd0aDtcbiAgY29uc3QgbWF4ID0gTWF0aC5taW4obiArIG0sIE1BWF9FRElUUyk7XG4gIGNvbnN0IHNpemUgPSAyICogbWF4ICsgMTtcbiAgY29uc3Qgb2Zmc2V0ID0gbWF4O1xuICBsZXQgdiA9IG5ldyBJbnQzMkFycmF5KHNpemUpO1xuICBjb25zdCB0cmFjZTogSW50MzJBcnJheVtdID0gW107XG4gIGZvciAobGV0IGQgPSAwOyBkIDw9IG1heDsgZCsrKSB7XG4gICAgdHJhY2UucHVzaCh2LnNsaWNlKCkpO1xuICAgIGZvciAobGV0IGsgPSAtZDsgayA8PSBkOyBrICs9IDIpIHtcbiAgICAgIC8vIFRha2UgdGhlIGxvbmdlciBvZiB0aGUgdHdvIHJlYWNoYWJsZSBwYXRoczogZG93biAoYW4gaW5zZXJ0aW9uKSB3aGVuXG4gICAgICAvLyBrIGlzIGF0IHRoZSBsb3dlciBlZGdlIG9yIHRoZSBkb3duLW5laWdoYm91ciBoYXMgY29tZSBmdXJ0aGVyLlxuICAgICAgY29uc3QgZG93biA9IHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcjtcbiAgICAgIGNvbnN0IHJpZ2h0ID0gdltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyO1xuICAgICAgbGV0IHg6IG51bWJlcjtcbiAgICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiByaWdodCA8IGRvd24pKSB4ID0gZG93bjtcbiAgICAgIGVsc2UgeCA9IHJpZ2h0ICsgMTtcbiAgICAgIGxldCB5ID0geCAtIGs7XG4gICAgICB3aGlsZSAoeCA8IG4gJiYgeSA8IG0gJiYgYVt4XSA9PT0gYlt5XSkge1xuICAgICAgICB4Kys7XG4gICAgICAgIHkrKztcbiAgICAgIH1cbiAgICAgIHZbb2Zmc2V0ICsga10gPSB4O1xuICAgICAgaWYgKHggPj0gbiAmJiB5ID49IG0pIHJldHVybiB0cmFjZTtcbiAgICB9XG4gICAgdiA9IHYuc2xpY2UoKTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdhbGsgdGhlIHRyYWNlIGJhY2t3YXJkcyBpbnRvIGEgbGlzdCBvZiBsaW5lIG9wZXJhdGlvbnMsIGZyb250IHRvIGJhY2suICovXG5mdW5jdGlvbiBiYWNrdHJhY2soYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdLCB0cmFjZTogSW50MzJBcnJheVtdKTogRGlmZkxpbmVbXSB7XG4gIGNvbnN0IG9mZnNldCA9IE1hdGgubWluKGEubGVuZ3RoICsgYi5sZW5ndGgsIE1BWF9FRElUUyk7XG4gIGNvbnN0IG91dDogRGlmZkxpbmVbXSA9IFtdO1xuICBsZXQgeCA9IGEubGVuZ3RoO1xuICBsZXQgeSA9IGIubGVuZ3RoO1xuICBmb3IgKGxldCBkID0gdHJhY2UubGVuZ3RoIC0gMTsgZCA+PSAwOyBkLS0pIHtcbiAgICBjb25zdCB2ID0gdHJhY2VbZF0gYXMgSW50MzJBcnJheTtcbiAgICBjb25zdCBrID0geCAtIHk7XG4gICAgbGV0IHByZXZLOiBudW1iZXI7XG4gICAgaWYgKGsgPT09IC1kIHx8IChrICE9PSBkICYmICh2W29mZnNldCArIGsgLSAxXSBhcyBudW1iZXIpIDwgKHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcikpKVxuICAgICAgcHJldksgPSBrICsgMTtcbiAgICBlbHNlIHByZXZLID0gayAtIDE7XG4gICAgY29uc3QgcHJldlggPSB2W29mZnNldCArIHByZXZLXSBhcyBudW1iZXI7XG4gICAgY29uc3QgcHJldlkgPSBwcmV2WCAtIHByZXZLO1xuICAgIHdoaWxlICh4ID4gcHJldlggJiYgeSA+IHByZXZZKSB7XG4gICAgICB4LS07XG4gICAgICB5LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcInNhbWVcIiwgYTogeCwgYjogeSwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICAgIGlmIChkID09PSAwKSBicmVhaztcbiAgICBpZiAoeCA+IHByZXZYKSB7XG4gICAgICB4LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcImRlbFwiLCBhOiB4LCB0ZXh0OiBhW3hdIGFzIHN0cmluZyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJhZGRcIiwgYjogeSwgdGV4dDogYlt5XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICB9XG4gIG91dC5yZXZlcnNlKCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBFdmVyeSBsaW5lIGFzIG9uZSByZXBsYWNlbWVudCDigJQgdGhlIGhvbmVzdCBhbnN3ZXIgd2hlbiBNeWVycyBnaXZlcyB1cC4gKi9cbmZ1bmN0aW9uIGNvYXJzZUxpbmVzKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IERpZmZMaW5lW10ge1xuICByZXR1cm4gW1xuICAgIC4uLmEubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJkZWxcIiBhcyBjb25zdCwgYTogaSwgdGV4dCB9KSksXG4gICAgLi4uYi5tYXAoKHRleHQsIGkpID0+ICh7IG9wOiBcImFkZFwiIGFzIGNvbnN0LCBiOiBpLCB0ZXh0IH0pKSxcbiAgXTtcbn1cblxuLyoqIEdyb3VwIHRoZSBsaW5lIG9wcyBpbnRvIGNvbnRpZ3VvdXMgaHVua3MsIG51bWJlcmVkIGZyb20gMS4gKi9cbmZ1bmN0aW9uIGNvbGxlY3QobGluZXM6IERpZmZMaW5lW10pOiBEaWZmSHVua1tdIHtcbiAgY29uc3QgaHVua3M6IERpZmZIdW5rW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBsZXQgaWQgPSAxO1xuICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCkge1xuICAgIGlmICgobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wID09PSBcInNhbWVcIikge1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHN0YXJ0ID0gaTtcbiAgICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCAmJiAobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wICE9PSBcInNhbWVcIikgaSsrO1xuICAgIGNvbnN0IHJ1biA9IGxpbmVzLnNsaWNlKHN0YXJ0LCBpKTtcbiAgICBjb25zdCBkZWwgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiKTtcbiAgICBjb25zdCBhZGQgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiKTtcbiAgICAvLyBXaGVyZSB0aGUgaHVuayBzaXRzIGluIGVhY2ggdGV4dDogdGhlIGluZGV4IG9mIHRoZSBmaXJzdCBsaW5lIGl0IHRvdWNoZXMsXG4gICAgLy8gYW5kIGZvciBhIHB1cmUgaW5zZXJ0aW9uLCB0aGUgcG9pbnQgaXQgaXMgaW5zZXJ0ZWQgQVQuXG4gICAgY29uc3QgYUZyb20gPSBkZWwubGVuZ3RoID8gKChkZWxbMF0gYXMgRGlmZkxpbmUpLmEgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYVwiKTtcbiAgICBjb25zdCBiRnJvbSA9IGFkZC5sZW5ndGggPyAoKGFkZFswXSBhcyBEaWZmTGluZSkuYiBhcyBudW1iZXIpIDogbmV4dEluZGV4KGxpbmVzLCBzdGFydCwgXCJiXCIpO1xuICAgIGh1bmtzLnB1c2goe1xuICAgICAgaWQ6IGlkKyssXG4gICAgICBhRnJvbSxcbiAgICAgIGFUbzogYUZyb20gKyBkZWwubGVuZ3RoLFxuICAgICAgYkZyb20sXG4gICAgICBiVG86IGJGcm9tICsgYWRkLmxlbmd0aCxcbiAgICAgIGRlbDogZGVsLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICAgIGFkZDogYWRkLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gaHVua3M7XG59XG5cbi8qKlxuICogVGhlIGluZGV4IGEgcHVyZSBpbnNlcnRpb24gb3IgZGVsZXRpb24gc2l0cyBhdDogdGhlIGxpbmUgbnVtYmVyIG9mIHRoZSBuZXh0XG4gKiBgc2FtZWAgbGluZSBvbiB0aGF0IHNpZGUsIG9yIHRoZSBlbmQgb2YgdGhhdCB0ZXh0IHdoZW4gdGhlcmUgaXMgbm9uZS5cbiAqL1xuZnVuY3Rpb24gbmV4dEluZGV4KGxpbmVzOiBEaWZmTGluZVtdLCBmcm9tOiBudW1iZXIsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBudW1iZXIge1xuICBmb3IgKGxldCBpID0gZnJvbTsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXQgPSAobGluZXNbaV0gYXMgRGlmZkxpbmUpW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYXQ7XG4gIH1cbiAgbGV0IGxhc3QgPSAtMTtcbiAgZm9yIChjb25zdCBsIG9mIGxpbmVzKSB7XG4gICAgY29uc3QgYXQgPSBsW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkICYmIGF0ID4gbGFzdCkgbGFzdCA9IGF0O1xuICB9XG4gIHJldHVybiBsYXN0ICsgMTtcbn1cblxuLyoqIFdvcmRzLCB3aGl0ZXNwYWNlIHJ1bnMgYW5kIHB1bmN0dWF0aW9uIHJ1bnMsIGtlcHQgc2VwYXJhdGUgc28gc3BhbnMgYWxpZ24uICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHMobGluZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gbGluZS5tYXRjaCgvXFxzK3xbXFxwe0x9XFxwe059X10rfFteXFxzXFxwe0x9XFxwe059X10rL2d1KSA/PyBbXTtcbn1cblxuLyoqIFRoZSB3b3JkLWxldmVsIGRpZmYgb2Ygb25lIGxpbmUgcGFpciwgYXMgc3BhbnMgb3ZlciBlYWNoIHNpZGUuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmaW5lKGJlZm9yZTogc3RyaW5nLCBhZnRlcjogc3RyaW5nKTogeyBkZWw6IERpZmZTcGFuW107IGFkZDogRGlmZlNwYW5bXSB9IHtcbiAgY29uc3QgYSA9IHdvcmRzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSB3b3JkcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgaWYgKCF0cmFjZSlcbiAgICByZXR1cm4geyBkZWw6IFt7IHRleHQ6IGJlZm9yZSwgY2hhbmdlZDogdHJ1ZSB9XSwgYWRkOiBbeyB0ZXh0OiBhZnRlciwgY2hhbmdlZDogdHJ1ZSB9XSB9O1xuICBjb25zdCBvcHMgPSBiYWNrdHJhY2soYSwgYiwgdHJhY2UpO1xuICBjb25zdCBkZWw6IERpZmZTcGFuW10gPSBbXTtcbiAgY29uc3QgYWRkOiBEaWZmU3BhbltdID0gW107XG4gIGZvciAoY29uc3Qgb3Agb2Ygb3BzKSB7XG4gICAgaWYgKG9wLm9wID09PSBcInNhbWVcIikge1xuICAgICAgcHVzaChkZWwsIG9wLnRleHQsIGZhbHNlKTtcbiAgICAgIHB1c2goYWRkLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgfSBlbHNlIGlmIChvcC5vcCA9PT0gXCJkZWxcIikgcHVzaChkZWwsIG9wLnRleHQsIHRydWUpO1xuICAgIGVsc2UgcHVzaChhZGQsIG9wLnRleHQsIHRydWUpO1xuICB9XG4gIHJldHVybiB7IGRlbCwgYWRkIH07XG59XG5cbi8qKiBBcHBlbmQsIG1lcmdpbmcgaW50byB0aGUgcHJldmlvdXMgc3BhbiB3aGVuIGl0IGNhcnJpZXMgdGhlIHNhbWUgdmVyZGljdC4gKi9cbmZ1bmN0aW9uIHB1c2goc3BhbnM6IERpZmZTcGFuW10sIHRleHQ6IHN0cmluZywgY2hhbmdlZDogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBsYXN0ID0gc3BhbnNbc3BhbnMubGVuZ3RoIC0gMV07XG4gIGlmIChsYXN0ICYmIGxhc3QuY2hhbmdlZCA9PT0gY2hhbmdlZCkgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2Ugc3BhbnMucHVzaCh7IHRleHQsIGNoYW5nZWQgfSk7XG59XG5cbi8qKlxuICogUmVmaW5lIGEgaHVuaydzIGxpbmVzIHdoZW4gdGhleSBjYW4gYmUgUEFJUkVELiBBIGh1bmsgcmVwbGFjaW5nIHRocmVlIGxpbmVzXG4gKiB3aXRoIHRocmVlIGlzIHBhaXJlZCBsaW5lIGJ5IGxpbmU7IGEgMS1mb3ItbWFueSBodW5rIGlzIG5vdCwgYW5kIGdldHMgbm9cbiAqIHNwYW5zIHJhdGhlciB0aGFuIGFuIGFyYml0cmFyeSBwYWlyaW5nIOKAlCBzaG93aW5nIGEgd29yZC1sZXZlbCBkaWZmIGFnYWluc3RcbiAqIHRoZSB3cm9uZyBsaW5lIGlzIHdvcnNlIHRoYW4gc2hvd2luZyBub25lLlxuICovXG5mdW5jdGlvbiByZWZpbmVIdW5rKGxpbmVzOiBEaWZmTGluZVtdLCBodW5rOiBEaWZmSHVuayk6IHZvaWQge1xuICBpZiAoaHVuay5kZWwubGVuZ3RoICE9PSBodW5rLmFkZC5sZW5ndGggfHwgaHVuay5kZWwubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGRlbHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiZGVsXCIgJiYgaW5SYW5nZShsLmEsIGh1bmsuYUZyb20sIGh1bmsuYVRvKSk7XG4gIGNvbnN0IGFkZHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiYWRkXCIgJiYgaW5SYW5nZShsLmIsIGh1bmsuYkZyb20sIGh1bmsuYlRvKSk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGVscy5sZW5ndGggJiYgaSA8IGFkZHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBkID0gZGVsc1tpXSBhcyBEaWZmTGluZTtcbiAgICBjb25zdCBhZCA9IGFkZHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgeyBkZWwsIGFkZCB9ID0gcmVmaW5lKGQudGV4dCwgYWQudGV4dCk7XG4gICAgZC5zcGFucyA9IGRlbDtcbiAgICBhZC5zcGFucyA9IGFkZDtcbiAgfVxufVxuXG5mdW5jdGlvbiBpblJhbmdlKGF0OiBudW1iZXIgfCB1bmRlZmluZWQsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+PSBmcm9tICYmIGF0IDwgdG87XG59XG5cbi8qKiBDb21wYXJlIHR3byB0ZXh0cyBieSBsaW5lLCByZWZpbmVkIGJ5IHdvcmQgaW5zaWRlIHBhaXJlZCBsaW5lcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmVGV4dChiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IERpZmYge1xuICBpZiAoYmVmb3JlID09PSBhZnRlcikge1xuICAgIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpLm1hcCgodGV4dCwgaSkgPT4gKHtcbiAgICAgIG9wOiBcInNhbWVcIiBhcyBjb25zdCxcbiAgICAgIGE6IGksXG4gICAgICBiOiBpLFxuICAgICAgdGV4dCxcbiAgICB9KSk7XG4gICAgcmV0dXJuIHsgbGluZXMsIGh1bmtzOiBbXSwgc2FtZTogdHJ1ZSwgY29hcnNlOiBmYWxzZSB9O1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKGFmdGVyKTtcbiAgY29uc3QgdHJhY2UgPSBteWVyc1RyYWNlKGEsIGIpO1xuICBjb25zdCBjb2Fyc2UgPSB0cmFjZSA9PT0gbnVsbDtcbiAgY29uc3QgbGluZXMgPSB0cmFjZSA/IGJhY2t0cmFjayhhLCBiLCB0cmFjZSkgOiBjb2Fyc2VMaW5lcyhhLCBiKTtcbiAgY29uc3QgaHVua3MgPSBjb2xsZWN0KGxpbmVzKTtcbiAgZm9yIChjb25zdCBoIG9mIGh1bmtzKSByZWZpbmVIdW5rKGxpbmVzLCBoKTtcbiAgcmV0dXJuIHsgbGluZXMsIGh1bmtzLCBzYW1lOiBmYWxzZSwgY29hcnNlIH07XG59XG5cbi8qKlxuICogVGFrZSBodW5rcyBmcm9tIHRoZSByaWdodCBzaWRlIGludG8gdGhlIGxlZnQuIGB0YWtlYCBpcyB0aGUgaWRzIHRvIGFwcGx5O1xuICogZXZlcnkgaHVuayBub3QgbmFtZWQgaXMgbGVmdCBhcyB0aGUgbGVmdCBzaWRlIGhhcyBpdC5cbiAqXG4gKiDim5QgQVBQTElFRCBCQUNLIFRPIEZST05ULCBzbyBhbiBlYXJsaWVyIGh1bmsncyBsaW5lIG51bWJlcnMgYXJlIHN0aWxsIHRoZVxuICogb25lcyB0aGUgZGlmZiByZXBvcnRlZCB3aGVuIGl0IGlzIHJlYWNoZWQuIEFwcGx5aW5nIGZyb250IHRvIGJhY2sgd291bGRcbiAqIHNoaWZ0IGV2ZXJ5IGxhdGVyIGh1bmsgYnkgdGhlIHNpemUgb2YgdGhlIGNoYW5nZSBqdXN0IG1hZGUg4oCUIHRoZSBjbGFzc2ljIHdheVxuICogYSBtdWx0aS1odW5rIG1lcmdlIGxhbmRzIGl0cyBsYXN0IGh1bmsgaW4gdGhlIHdyb25nIHBsYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlIdW5rcyhiZWZvcmU6IHN0cmluZywgaHVua3M6IERpZmZIdW5rW10sIHRha2U6IG51bWJlcltdKTogc3RyaW5nIHtcbiAgY29uc3Qgd2FudGVkID0gbmV3IFNldCh0YWtlKTtcbiAgY29uc3QgY2hvc2VuID0gaHVua3MuZmlsdGVyKChoKSA9PiB3YW50ZWQuaGFzKGguaWQpKS5zb3J0KCh4LCB5KSA9PiB5LmFGcm9tIC0geC5hRnJvbSk7XG4gIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBmb3IgKGNvbnN0IGggb2YgY2hvc2VuKSBsaW5lcy5zcGxpY2UoaC5hRnJvbSwgaC5hVG8gLSBoLmFGcm9tLCAuLi5oLmFkZCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogVW5pZmllZC1kaWZmIHRleHQsIGZvciB0aGUgYWdlbnQncyBgZGlmZmAgdmVyYi4gYGNvbnRleHRgIGxpbmVzIGVpdGhlciBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaWZpZWQoXG4gIGRpZmY6IERpZmYsXG4gIG9wdHM6IHsgZnJvbTogc3RyaW5nOyB0bzogc3RyaW5nOyBjb250ZXh0PzogbnVtYmVyIH0gPSB7IGZyb206IFwiYVwiLCB0bzogXCJiXCIgfSxcbik6IHN0cmluZyB7XG4gIGlmIChkaWZmLnNhbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBjb250ZXh0ID0gb3B0cy5jb250ZXh0ID8/IDM7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbYC0tLSAke29wdHMuZnJvbX1gLCBgKysrICR7b3B0cy50b31gXTtcbiAgLy8gSHVua3MgY2xvc2VyIHRvZ2V0aGVyIHRoYW4gMsOXIGNvbnRleHQgc2hhcmUgb25lIGhlYWRlciwgdGhlIHdheSBldmVyeVxuICAvLyBvdGhlciBkaWZmIHRvb2wgam9pbnMgdGhlbSDigJQgb3RoZXJ3aXNlIHRoZSBjb250ZXh0IGxpbmVzIHByaW50IHR3aWNlLlxuICBjb25zdCBncm91cHM6IERpZmZIdW5rW11bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGggb2YgZGlmZi5odW5rcykge1xuICAgIGNvbnN0IGxhc3QgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdO1xuICAgIGNvbnN0IHByZXYgPSBsYXN0Py5bbGFzdC5sZW5ndGggLSAxXTtcbiAgICBpZiAocHJldiAmJiBoLmFGcm9tIC0gcHJldi5hVG8gPD0gY29udGV4dCAqIDIpIChsYXN0IGFzIERpZmZIdW5rW10pLnB1c2goaCk7XG4gICAgZWxzZSBncm91cHMucHVzaChbaF0pO1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYVwiKSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYlwiKSk7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgY29uc3QgZmlyc3QgPSBncm91cFswXSBhcyBEaWZmSHVuaztcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBbZ3JvdXAubGVuZ3RoIC0gMV0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgYVN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYUZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBhRW5kID0gTWF0aC5taW4oYS5sZW5ndGgsIGxhc3QuYVRvICsgY29udGV4dCk7XG4gICAgY29uc3QgYlN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYkZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBiRW5kID0gTWF0aC5taW4oYi5sZW5ndGgsIGxhc3QuYlRvICsgY29udGV4dCk7XG4gICAgb3V0LnB1c2goYEBAIC0ke2FTdGFydCArIDF9LCR7YUVuZCAtIGFTdGFydH0gKyR7YlN0YXJ0ICsgMX0sJHtiRW5kIC0gYlN0YXJ0fSBAQGApO1xuICAgIGxldCBhdCA9IGFTdGFydDtcbiAgICBmb3IgKGNvbnN0IGggb2YgZ3JvdXApIHtcbiAgICAgIGZvciAoOyBhdCA8IGguYUZyb207IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBoLmRlbCkgb3V0LnB1c2goYC0ke2xpbmV9YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5hZGQpIG91dC5wdXNoKGArJHtsaW5lfWApO1xuICAgICAgYXQgPSBoLmFUbztcbiAgICB9XG4gICAgZm9yICg7IGF0IDwgYUVuZDsgYXQrKykgb3V0LnB1c2goYCAke2FbYXRdfWApO1xuICB9XG4gIHJldHVybiBgJHtvdXQuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG4vKiogUmVidWlsZCBvbmUgc2lkZSdzIHRleHQgZnJvbSB0aGUgbGluZSBvcHMg4oCUIHVzZWQgYnkgYHVuaWZpZWRgIGZvciBjb250ZXh0LiAqL1xuZnVuY3Rpb24gc2lkZVRleHQoZGlmZjogRGlmZiwgc2lkZTogXCJhXCIgfCBcImJcIik6IHN0cmluZyB7XG4gIGNvbnN0IHNraXAgPSBzaWRlID09PSBcImFcIiA/IFwiYWRkXCIgOiBcImRlbFwiO1xuICByZXR1cm4gZGlmZi5saW5lc1xuICAgIC5maWx0ZXIoKGwpID0+IGwub3AgIT09IHNraXApXG4gICAgLm1hcCgobCkgPT4gbC50ZXh0KVxuICAgIC5qb2luKFwiXFxuXCIpO1xufVxuIiwKICAgICIvLyBXaGF0IGlzIHdyb25nIHdpdGggdGhpcyBzZXNzaW9uLCBhbmQgdGhlIHZlcmIgdGhhdCBmaXhlcyBlYWNoIHRoaW5nIChFNjIpLlxuLy9cbi8vIOKblCBSRVBPUlRTLCBORVZFUiBSRVBBSVJTLiBTaWxlbnRseSBwcnVuaW5nIGEgZ2hvc3QgZW50cnkgd291bGQgdGhyb3cgYXdheSB0aGVcbi8vIGZhY3QgdGhhdCB0aGUgaHVtYW4gQVNLRUQgZm9yIHRoYXQgZmlsZSB0byBiZSBpbiB0aGVpciBjb250ZXh0IOKAlCBhbmQgaWYgaXRcbi8vIGNvbWVzIGJhY2sgZnJvbSBhIGBnaXQgY2hlY2tvdXRgLCB0aGV5IHdvdWxkIGhhdmUgdG8gbm90aWNlIGl0IGlzIG1pc3NpbmcgYW5kXG4vLyBhZGQgaXQgYWdhaW4uIFRoZSBzYW1lIGxvZ2ljIHByb3RlY3RzIGEgZG9jdW1lbnQgcmVjb3JkIHdob3NlIGZpbGUgaGFzIGdvbmU6XG4vLyB0aGUgc2Vzc2lvbiBpcyBzdGlsbCBob2xkaW5nIHZlcnNpb25zIHRoZSBodW1hbiBjYW4gc2F2ZSBiYWNrLCBzbyBmb3JnZXR0aW5nXG4vLyBpdCBmb3IgdGhlbSB3b3VsZCBiZSBkaXNjYXJkaW5nIGNvbnRlbnQgb24gdGhlaXIgYmVoYWxmLiBDb2xlIHJ1bGVkIGl0OlxuLy8gXCJyZXBvcnQsIG5hbWUgdGhlIHZlcmIsIGxldCB5b3UgZGVjaWRlLlwiXG4vL1xuLy8g4puUIEFORCBFVkVSWSBGSU5ESU5HIENBUlJJRVMgSVRTIFZFUkIuIEEgcmVwb3J0IHRoYXQgc2F5cyBcIjMgcHJvYmxlbXNcIiBhbmRcbi8vIGxlYXZlcyB5b3UgdG8gd29yayBvdXQgd2hhdCB0byB0eXBlIGlzIHRoZSBzaGFwZSB0aGlzIHNwZWxsIGtlZXBzIGZhaWxpbmcgYXRcbi8vIGFuZCBmaXhpbmcg4oCUIHRoZSBjb25mbGljdCBiYW5uZXIgd2l0aCBubyByb3V0ZSB0byB0aGUgY29tcGFyaXNvbiwgdGhlXG4vLyBcImdvbmUgZnJvbSBkaXNrXCIgbm90aWNlIHdpdGggbm8gd2F5IHRvIGFuc3dlciBpdC4gQSBmaW5kaW5nIHdpdGhvdXQgYSBmaXggaXNcbi8vIGhhbGYgYSBmaW5kaW5nLlxuLy9cbi8vIOKaoCBUSEUgQ0hFQ0tTIEFSRSBFVklERU5DRUQsIE5PVCBJTUFHSU5FRC4gRWFjaCBvbmUgaXMgYSBzdGF0ZSB0aGF0IGhhc1xuLy8gYWN0dWFsbHkgaGFwcGVuZWQgaGVyZTogYSByZWNvcmQgd2hvc2Ugb3JpZ2luYWwgd2FzIGRlbGV0ZWQgKEU2MCdzIHJlc2lkdWUsXG4vLyBhbmQgYW55IGRlbGV0ZSBpbiBGaW5kZXIpLCBhIGBsaXN0ZWRgIGNvbnRleHQgZW50cnkgcG9pbnRpbmcgYXQgbm90aGluZ1xuLy8gKG5ldmVyIHJlc2Nhbm5lZCDigJQgbWVhc3VyZWQsIGFuZCByZWFjaGFibGUgdG9kYXkgd2l0aCBubyBidWcgYXQgYWxsKSwgYW5kXG4vLyBsaW5rcyBhIHNldCBjYW5ub3QgYW5zd2VyIChFNTQpLiBOb3RoaW5nIGlzIGNoZWNrZWQgYmVjYXVzZSBpdCBzb3VuZGVkXG4vLyBwbGF1c2libGUuXG5cbi8qKiBPbmUgdGhpbmcgd29ydGggbG9va2luZyBhdCwgYW5kIHdoYXQgdG8gZG8gYWJvdXQgaXQuICovXG5leHBvcnQgdHlwZSBGaW5kaW5nID0ge1xuICBraW5kOiBcIm9yaWdpbmFsLm1pc3NpbmdcIiB8IFwiY29udGV4dC5naG9zdFwiIHwgXCJsaW5rcy5kYW5nbGluZ1wiIHwgXCJsaW5rcy51bnN1cHBvcnRlZFwiO1xuICAvKiogV2hhdCBpdCBpcyBhYm91dDogYSBwYXRoLCBvciBhbiBlbnRyeSBpZC4gKi9cbiAgc3ViamVjdDogc3RyaW5nO1xuICAvKiogV2hhdCB0aGUgaHVtYW4gcmVhZHMuICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgLyoqIFdoYXQgdGhlIGFnZW50IHdvdWxkIHJ1biwgd2l0aCB0aGUgYXJndW1lbnQgYWxyZWFkeSBpbiBpdC4gKi9cbiAgZml4OiBzdHJpbmc7XG4gIC8qKiBIb3cgbWFueSBvZiBzb21ldGhpbmcgdGhlIGZpbmRpbmcgaXMgYWJvdXQsIHdoZW4gdGhhdCBpcyB0aGUgcG9pbnQuICovXG4gIGNvdW50PzogbnVtYmVyO1xufTtcblxuLyoqIFRoZSBmYWN0cyBhIGNoZWNrdXAgbmVlZHMsIGdhdGhlcmVkIGJ5IHdob2V2ZXIgY2FuIHRvdWNoIHRoZSBkaXNrLiAqL1xuZXhwb3J0IHR5cGUgQ2hlY2t1cCA9IHtcbiAgLyoqIEV2ZXJ5IGRvY3VtZW50IHJlY29yZCwgd2l0aCB3aGV0aGVyIGl0cyBmaWxlIG9mIHJlY29yZCBzdGlsbCBleGlzdHMuICovXG4gIGRvY3M6IHJlYWRvbmx5IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIG9yaWdpbmFsOiBzdHJpbmc7XG4gICAgZXhpc3RzOiBib29sZWFuO1xuICAgIHZlcnNpb25zOiBudW1iZXI7XG4gIH1bXTtcbiAgLyoqIEV2ZXJ5IGRvYyBub2RlIGluIGV2ZXJ5IGNvbnRleHQgZW50cnksIHdpdGggd2hldGhlciB0aGUgcGF0aCBleGlzdHMuICovXG4gIG5vZGVzOiByZWFkb25seSB7IGVudHJ5OiBzdHJpbmc7IHBhdGg6IHN0cmluZzsgc2hvd246IHN0cmluZzsgZXhpc3RzOiBib29sZWFuIH1bXTtcbiAgLyoqXG4gICAqIExpbmsgY291bnRzIHBlciBtaXJyb3JlZCBlbnRyeTogbGlua3MgdGhhdCBhbnN3ZXIgbm90aGluZywgYW5kIGxpbmtzIHdpdGggYVxuICAgKiBzY2hlbWUgbm90aGluZyBoZXJlIG9wZW5zIChgb3A6ZG9jL+KApmApLCB3aXRoIHRob3NlIHNjaGVtZXMgKCMxMjgpLlxuICAgKi9cbiAgbGlua3M6IHJlYWRvbmx5IHtcbiAgICBlbnRyeTogc3RyaW5nO1xuICAgIGxhYmVsOiBzdHJpbmc7XG4gICAgZGFuZ2xpbmc6IG51bWJlcjtcbiAgICB1bnN1cHBvcnRlZD86IG51bWJlcjtcbiAgICBzY2hlbWVzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIH1bXTtcbn07XG5cbi8qKlxuICogU2hhcGUgdGhlIGZhY3RzIGludG8gZmluZGluZ3MuXG4gKlxuICogUHVyZSBvbiBwdXJwb3NlOiB0aGUgZnMgcmVhZHMgYmVsb25nIHRvIHRoZSBzZXNzaW9uLCBhbmQgd2hhdCBjb3VudHMgYXMgYVxuICogcHJvYmxlbSDigJQgYW5kIHdoYXQgdG8gc2F5IGFib3V0IGl0IOKAlCBpcyB0aGUgcGFydCB3b3J0aCBwaW5uaW5nIHdpdGggY2VsbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kaW5ncyhjOiBDaGVja3VwKTogRmluZGluZ1tdIHtcbiAgY29uc3Qgb3V0OiBGaW5kaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IGQgb2YgYy5kb2NzKSB7XG4gICAgaWYgKGQuZXhpc3RzKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIm9yaWdpbmFsLm1pc3NpbmdcIixcbiAgICAgIHN1YmplY3Q6IGQub3JpZ2luYWwsXG4gICAgICBtZXNzYWdlOiBgJHtkLm5hbWV9IGlzIGluIHRoaXMgc2Vzc2lvbiBidXQgaXRzIGZpbGUgaXMgZ29uZSBmcm9tIGRpc2suICR7XG4gICAgICAgIGQudmVyc2lvbnMgPT09IDEgPyBcIjEgdmVyc2lvbiBpc1wiIDogYCR7ZC52ZXJzaW9uc30gdmVyc2lvbnMgYXJlYFxuICAgICAgfSBzdGlsbCBoZWxkIGhlcmUg4oCUIHNhdmluZyB3b3VsZCByZWNyZWF0ZSB0aGUgZmlsZS5gLFxuICAgICAgZml4OiBgZm9yZ2V0IC0tZG9jICR7ZC5zbHVnfWAsXG4gICAgICBjb3VudDogZC52ZXJzaW9ucyxcbiAgICB9KTtcbiAgfVxuXG4gIGZvciAoY29uc3QgbiBvZiBjLm5vZGVzKSB7XG4gICAgaWYgKG4uZXhpc3RzKSBjb250aW51ZTtcbiAgICAvLyDimqAgQSByZWNvcmQgYW5kIGFuIGVudHJ5IGNhbiBwb2ludCBhdCB0aGUgU0FNRSBtaXNzaW5nIHBhdGgsIGFuZCBib3RoIGFyZVxuICAgIC8vIHJlcG9ydGVkOiB0aGV5IGFyZSB0d28gZGlmZmVyZW50IHRoaW5ncyB0byBjbGVhbiB1cCwgd2l0aCB0d28gZGlmZmVyZW50XG4gICAgLy8gdmVyYnMsIGFuZCBtZXJnaW5nIHRoZW0gd291bGQgbGVhdmUgd2hpY2hldmVyIHRoZSBodW1hbiBkaWQgbm90IGRvLlxuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwiY29udGV4dC5naG9zdFwiLFxuICAgICAgc3ViamVjdDogbi5wYXRoLFxuICAgICAgbWVzc2FnZTogYCR7bi5zaG93bn0gaXMgaW4gdGhlIGNvbnRleHQgYnV0IG5vdCBvbiBkaXNrLmAsXG4gICAgICBmaXg6IGBoaWRlICR7bi5wYXRofWAsXG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGwgb2YgYy5saW5rcykge1xuICAgIGlmIChsLmRhbmdsaW5nIDw9IDApIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwibGlua3MuZGFuZ2xpbmdcIixcbiAgICAgIHN1YmplY3Q6IGwuZW50cnksXG4gICAgICBtZXNzYWdlOlxuICAgICAgICBsLmRhbmdsaW5nID09PSAxXG4gICAgICAgICAgPyBgJHtsLmxhYmVsfSBoYXMgMSBsaW5rIHRoYXQgYW5zd2VycyBub3RoaW5nLmBcbiAgICAgICAgICA6IGAke2wubGFiZWx9IGhhcyAke2wuZGFuZ2xpbmd9IGxpbmtzIHRoYXQgYW5zd2VyIG5vdGhpbmcuYCxcbiAgICAgIGZpeDogYGRhbmdsaW5nIC0tZW50cnkgJHtsLmVudHJ5fWAsXG4gICAgICBjb3VudDogbC5kYW5nbGluZyxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIOKaoCBBIFNFUEFSQVRFIEZJTkRJTkcsIE5PVCBNT1JFIERBTkdMSU5HIExJTktTICgjMTI4KS4gQW4gYG9wOmRvYy88aWQ+YCBsaW5rXG4gIC8vIGlzIG9uZSBhbiBleHBvcnQgY291bGQgbm90IHJld3JpdGU6IGl0IG1heSB3YW50IHJld3JpdGluZyBhcyBhIHBhdGgsIG9yXG4gIC8vIGtlZXBpbmcgZm9yIHRoZSB0b29sIHRoYXQgcmVhZHMgaXQsIGFuZCB0aGUgaHVtYW4gZGVjaWRlcyB3aGljaC5cbiAgZm9yIChjb25zdCBsIG9mIGMubGlua3MpIHtcbiAgICBjb25zdCBuID0gbC51bnN1cHBvcnRlZCA/PyAwO1xuICAgIGlmIChuIDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNjaGVtZXMgPSAobC5zY2hlbWVzID8/IFtdKS5tYXAoKHMpID0+IGAke3N9OmApLmpvaW4oXCIsIFwiKTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcImxpbmtzLnVuc3VwcG9ydGVkXCIsXG4gICAgICBzdWJqZWN0OiBsLmVudHJ5LFxuICAgICAgbWVzc2FnZTogYCR7bC5sYWJlbH0gaGFzICR7biA9PT0gMSA/IFwiMSBsaW5rXCIgOiBgJHtufSBsaW5rc2B9IHdpdGggYSBzY2hlbWUgbm90aGluZyBoZXJlIG9wZW5zJHtcbiAgICAgICAgc2NoZW1lcyA/IGAgKCR7c2NoZW1lc30pYCA6IFwiXCJcbiAgICAgIH0uYCxcbiAgICAgIGZpeDogYGRhbmdsaW5nIC0tZW50cnkgJHtsLmVudHJ5fWAsXG4gICAgICBjb3VudDogbixcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogVGhlIG9uZSBsaW5lIHRoZSBjaGF0IGdldHMgYXQgc3RhcnR1cCwgb3IgbnVsbCB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gc2F5LlxuICpcbiAqIOKblCBPTkUgTElORSwgQU5EIFNJTEVOQ0UgV0hFTiBDTEVBTi4gQSBjaGVjayB0aGF0IGFubm91bmNlcyBpdHNlbGYgZXZlcnkgdGltZVxuICogaXQgZmluZHMgbm90aGluZyB0cmFpbnMgdGhlIHJlYWRlciB0byBza2lwIGl0LCBhbmQgdGhlbiBpdCBpcyBub3QgYSBjaGVjayBhbnlcbiAqIG1vcmUuIFRoZSBkZXRhaWwgbGl2ZXMgYmVoaW5kIHRoZSB2ZXJiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyeShsaXN0OiByZWFkb25seSBGaW5kaW5nW10pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKGxpc3QubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgLy8g4pqgIENvdW50ZWQgYnkgS0lORCByYXRoZXIgdGhhbiBkZXNjcmliZWQsIGJlY2F1c2UgYSBzZW50ZW5jZSB0aGF0IHRyaWVzIHRvXG4gIC8vIG5hbWUgdGhyZWUgY2F0ZWdvcmllcyBpbiBvbmUgYnJlYXRoIHJlYWRzIHdvcnNlIHRoYW4gdGhlIG51bWJlcnMgZG8uXG4gIGNvbnN0IGJ5S2luZCA9IG5ldyBNYXA8RmluZGluZ1tcImtpbmRcIl0sIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBmIG9mIGxpc3QpIGJ5S2luZC5zZXQoZi5raW5kLCAoYnlLaW5kLmdldChmLmtpbmQpID8/IDApICsgMSk7XG4gIC8vIOKaoCBCT1RIIEZPUk1TIFdSSVRURU4gT1VULiBBcHBlbmRpbmcgXCJzXCIgcHJvZHVjZWQgXCJnaG9zdCBpbiB0aGUgY29udGV4dHNcIixcbiAgLy8gd2hpY2ggaXMgdGhlIGtpbmQgb2Ygc21hbGwgd3JvbmduZXNzIHRoYXQgbWFrZXMgYSB0b29sIHJlYWQgYXMgY2FyZWxlc3MuXG4gIGNvbnN0IGxhYmVsOiBSZWNvcmQ8RmluZGluZ1tcImtpbmRcIl0sIFtvbmU6IHN0cmluZywgbWFueTogc3RyaW5nXT4gPSB7XG4gICAgXCJvcmlnaW5hbC5taXNzaW5nXCI6IFtcIm1pc3NpbmcgZmlsZVwiLCBcIm1pc3NpbmcgZmlsZXNcIl0sXG4gICAgXCJjb250ZXh0Lmdob3N0XCI6IFtcImdob3N0IGluIHRoZSBjb250ZXh0XCIsIFwiZ2hvc3RzIGluIHRoZSBjb250ZXh0XCJdLFxuICAgIFwibGlua3MuZGFuZ2xpbmdcIjogW1wic2V0IHdpdGggZGFuZ2xpbmcgbGlua3NcIiwgXCJzZXRzIHdpdGggZGFuZ2xpbmcgbGlua3NcIl0sXG4gICAgXCJsaW5rcy51bnN1cHBvcnRlZFwiOiBbXCJzZXQgd2l0aCB1bnN1cHBvcnRlZCBsaW5rc1wiLCBcInNldHMgd2l0aCB1bnN1cHBvcnRlZCBsaW5rc1wiXSxcbiAgfTtcbiAgY29uc3QgcGFydHMgPSBbLi4uYnlLaW5kXS5tYXAoKFtraW5kLCBuXSkgPT4gYCR7bn0gJHtsYWJlbFtraW5kXVtuID09PSAxID8gMCA6IDFdfWApO1xuICByZXR1cm4gYFN0YXJ0dXAgY2hlY2s6ICR7cGFydHMuam9pbihcIiwgXCIpfSDigJQgcnVuIFxcYGRvY3RvclxcYCBmb3IgdGhlIGRldGFpbC5gO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLy8gVW5kbyBhbmQgcmVkbyBmb3IgdGhlIENPTlRFWFQg4oCUIG1vdmluZyB0aGluZ3MgYXJvdW5kLCBhZGRpbmcsIGhpZGluZyAoRTYwKS5cbi8vXG4vLyDim5QgVEhJUyBJUyBOT1QgVEhFIEVESVRPUidTIFVORE8sIGFuZCB0aGUgc3VyZmFjZSBzYXlzIHNvIGJ5IHB1dHRpbmcgdGhlc2Vcbi8vIGFycm93cyBpbiB0aGUgY29udGV4dCBoZWFkZXIgcmF0aGVyIHRoYW4gYW55d2hlcmUgbmVhciB0aGUgdGV4dC4gQ29kZU1pcnJvcidzXG4vLyBoaXN0b3J5IG93bnMga2V5c3Ryb2tlcyBpbnNpZGUgYSBkb2N1bWVudDsgdGhpcyBvd25zIGFjdHMgb24gdGhlIFNIQVBFIG9mIHRoZVxuLy8gY29udGV4dCwgd2hpY2ggaXMgdGhlIHRoaW5nIHRoYXQgaGFkIG5vIHdheSBiYWNrIGF0IGFsbC4gQ29sZTogXCJsZXR0aW5nIHRoZVxuLy8gdXNlciBrbm93IHRoYXQgdGhlcmUncyBhbiB1bmRvIGZvciB0aGlzIHNpZGViYXIgdGhhdCBpc24ndCB0aGUgc2FtZSBhcyB1bmRvXG4vLyByZWRvIHdoZW4geW91J3JlIGluIHRoZSBlZGl0b3IuXCJcbi8vXG4vLyDim5QgVU5ET0lORyBBIENSRUFUSU9OIERFTEVURVMsIEJVVCBPTkxZIEJFSElORCBBIENPTkZJUk1BVElPTi4gVGhpcyBzdGFydGVkIGFzXG4vLyBhIGhhcmQgYmxvY2sg4oCUIHVuZG8gbmV2ZXIgZGVsZXRlcyDigJQgYW5kIENvbGUgcHVzaGVkIGJhY2ssIGNvcnJlY3RseTogYmxvY2tpbmdcbi8vIGRvZXMgbm90IHJlZnVzZSBvbmUgc3RlcCwgaXQgU1RSQU5EUyBFVkVSWVRISU5HIEJFSElORCBJVC4gQ3JlYXRlIGEgZm9sZGVyLCBkb1xuLy8gdHdvIG1vdmVzLCBhbmQgeW91IGNhbiB1bmRvIHRoZSBtb3ZlcyBhbmQgdGhlbiBtZWV0IGEgd2FsbCB5b3UgY2FuIG5ldmVyXG4vLyBwYXNzLCBhdCB3aGljaCBwb2ludCB0aGUgaGlzdG9yeSBoYXMgc3RvcHBlZCBiZWluZyBhIGhpc3RvcnkuIEFuZCB0aGUgdGhpbmdcbi8vIHVuZG8gd291bGQgcmVtb3ZlIGlzIG9uZSB0aGUgc2Vzc2lvbiBpdHNlbGYgbWFkZSBtb21lbnRzIGFnbywgdXN1YWxseSBlbXB0eSDigJRcbi8vIGNhdGVnb3JpY2FsbHkgZGlmZmVyZW50IGZyb20gZGVsZXRpbmcgd29yaywgYW5kIHRoZSBhcHAgYWxyZWFkeSBoYXMgdGhlXG4vLyBwYXR0ZXJuIGZvciBpdCBpbiB0aGUgdmVyc2lvbi1kZWxldGUgZGlhbG9nLiBTbyB0aGUgYXJyb3cgc3RheXMgZW5hYmxlZCBhbmRcbi8vIHRoZSBDT05GSVJNQVRJT04gaXMgdGhlIGdhdGUuXG4vL1xuLy8g4puUIFdJVEggT05FIEhBUkQgTElNSVQgVEhBVCBJUyBOT1QgTkVHT1RJQUJMRSBCWSBESUFMT0c6IGEgTk9OLUVNUFRZIGZvbGRlciBpc1xuLy8gcmVmdXNlZCBvdXRyaWdodC4gVW5kbyB3b3JrcyBiYWNrd2FyZHMsIHNvIGl0IGVtcHRpZXMgYSBmb2xkZXIgYmVmb3JlIGl0XG4vLyByZWFjaGVzIHRoYXQgZm9sZGVyJ3MgY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzLCBzb21ldGhpbmdcbi8vIHB1dCB0aGVtIHRoZXJlIHRoYXQgdGhpcyBoaXN0b3J5IGRvZXMgbm90IGtub3cgYWJvdXQsIGFuZCByZW1vdmluZyBhXG4vLyBkaXJlY3RvcnkgdHJlZSBpcyBhIGRpZmZlcmVudCBhY3QgZnJvbSByZW1vdmluZyB0aGUgZW1wdHkgdGhpbmcgeW91IGp1c3Rcbi8vIG1hZGUuIFRoYXQgY2FzZSBzdG9wcyBhbmQgc2F5cyB3aHkuXG4vL1xuLy8g4pqgIFRIRSBJTlZFUlNFIElTIEJVSUxUIFdIRU4gVEhFIEFDVCBIQVBQRU5TLCBmcm9tIHdoYXQgd2FzIGFjdHVhbGx5IHRydWVcbi8vIHRoZW4g4oCUIG5vdCByZWNvbnN0cnVjdGVkIGxhdGVyIGZyb20gdGhlIG9wLiBBIGBtb3ZlYCByZWNvcmRzIHdoZXJlIHRoZSB0aGluZ1xuLy8gQ0FNRSBmcm9tIGJlY2F1c2Ugb25seSB0aGUgbW92ZXIga25vd3M7IGEgYGhpZGVgIHJlY29yZHMgdGhlIGVudHJ5J3Mgd2hvbGVcbi8vIGhpZGRlbiBsaXN0IGJlY2F1c2UgdGhhdCBpcyB3aGF0IHJlc3RvcmVzIGl0IGV4YWN0bHksIGluY2x1ZGluZyB0aGUgY2FzZVxuLy8gd2hlcmUgaGlkaW5nIHJlbW92ZWQgYSBzaW5nbGUtZG9jdW1lbnQgZW50cnkgb3V0cmlnaHQuXG5pbXBvcnQgdHlwZSB7IFN0cnVjdHVyZU9wIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqXG4gKiBIb3cgdG8gcHV0IG9uZSBhY3QgYmFjay4gRWFjaCB2YXJpYW50IGlzIHNvbWV0aGluZyB0aGUgc2Vzc2lvbiBjYW4gYWxyZWFkeVxuICogZG8sIHNvIHVuZG8gaW50cm9kdWNlcyBubyBuZXcgd2F5IHRvIGNoYW5nZSB0aGUgd29ybGQg4oCUIGl0IG9ubHkgcmVwbGF5cyB0aGVcbiAqIGV4aXN0aW5nIG9uZXMgd2l0aCByZWNvcmRlZCBhcmd1bWVudHMuXG4gKi9cbmV4cG9ydCB0eXBlIEludmVyc2UgPVxuICB8IHsga2luZDogXCJtb3ZlXCI7IHBhdGg6IHN0cmluZzsgaW50bzogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwicmVuYW1lXCI7IHBhdGg6IHN0cmluZzsgbmFtZTogc3RyaW5nIH1cbiAgLyoqIFNldCBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IHRvIGV4YWN0bHkgdGhlc2UgcmVsYXRpdmUgcGF0aHMuICovXG4gIHwgeyBraW5kOiBcImhpZGRlblwiOyBlbnRyeTogc3RyaW5nOyByZWxzOiBzdHJpbmdbXSB9XG4gIC8qKiBQdXQgYSB3aG9sZSBkb2N1bWVudCBvciBmb2xkZXIgYmFjayBpbiB0aGUgY29udGV4dC4gKi9cbiAgfCB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIjsgcGF0aDogc3RyaW5nIH1cbiAgLyoqIFRha2UgYSBjb250ZXh0IGVudHJ5IGJhY2sgb3V0ICh0aGUgaW52ZXJzZSBvZiBwdXR0aW5nIG9uZSBpbikuICovXG4gIHwgeyBraW5kOiBcImNvbnRleHQucmVtb3ZlXCI7IGVudHJ5OiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJ3b3Jrc3BhY2VcIjsgcGF0aDogc3RyaW5nIH1cbiAgLyoqXG4gICAqIFJlbW92ZSB3aGF0IHRoZSBhY3QgY3JlYXRlZC4gYGRpcmAgZGVjaWRlcyBib3RoIHRoZSBkaWFsb2cncyB3b3JkcyBhbmQgdGhlXG4gICAqIGVtcHRpbmVzcyBydWxlIOKAlCBhIGZpbGUgaXMgY29uZmlybWVkLCBhIGZvbGRlciBpcyBjb25maXJtZWQgQU5EIG11c3QgYmVcbiAgICogZW1wdHkuXG4gICAqL1xuICB8IHsga2luZDogXCJkZWxldGVcIjsgcGF0aDogc3RyaW5nOyBkaXI6IGJvb2xlYW4gfTtcblxuLyoqIE9uZSBhY3QsIHdpdGggdGhlIHdheSBiYWNrIGFuZCBhIHNlbnRlbmNlIGZvciB0aGUgYXJyb3cncyB0b29sdGlwLiAqL1xuZXhwb3J0IHR5cGUgQWN0ID0ge1xuICAvKiogV2hhdCBoYXBwZW5lZCwgZm9yIHRoZSB0b29sdGlwOiBcIm1vdmVkIG5vdGUubWQgaW50byBkcmFmdHNcIi4gKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgaW52ZXJzZTogSW52ZXJzZTtcbn07XG5cbi8qKlxuICogV2hhdCB0aGUgc2Vzc2lvbiBrbmV3IGJlZm9yZSB0aGUgYWN0IOKAlCB0aGUgcGFydHMgYW4gaW52ZXJzZSBtYXkgbmVlZC5cbiAqXG4gKiDimqAgUGFzc2VkIGluIHJhdGhlciB0aGFuIHJlYWQgYmFjayBhZnRlcndhcmRzLCBiZWNhdXNlIGV2ZXJ5IGZpZWxkIGhlcmUgaXNcbiAqIHNvbWV0aGluZyB0aGUgYWN0IGl0c2VsZiBDSEFOR0VTLiBSZWFkaW5nIGBoaWRkZW5gIGFmdGVyIGEgaGlkZSByZXR1cm5zIHRoZVxuICogbGlzdCBpbmNsdWRpbmcgdGhlIHRoaW5nIGp1c3QgaGlkZGVuLCB3aGljaCByZXN0b3JlcyBub3RoaW5nLlxuICovXG5leHBvcnQgdHlwZSBCZWZvcmUgPSB7XG4gIC8qKiBUaGUgZW50cnkncyBoaWRkZW4gbGlzdCBiZWZvcmUgdGhlIGFjdCwgd2hlbiB0aGUgYWN0IHRvdWNoZWQgb25lLiAqL1xuICBoaWRkZW4/OiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH07XG4gIC8qKiBUaGUgd29ya3NwYWNlIGJlZm9yZSB0aGUgYWN0LiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogV2hhdCB0aGUgYWN0IHJldHVybmVkIOKAlCB0aGUgc2Vzc2lvbidzIG93biByZXN1bHQsIG5hcnJvd2VkIHRvIHdoYXQgd2UgdXNlLiAqL1xuZXhwb3J0IHR5cGUgQWZ0ZXIgPSB7XG4gIHBhdGg/OiBzdHJpbmc7XG4gIC8qKiBXaGVyZSBhIG1vdmUgb3IgcmVuYW1lIGNhbWUgRlJPTS4gKi9cbiAgZnJvbT86IHN0cmluZztcbiAgLyoqIFRoZSBmb2xkZXIgYHNldC5tYWtlYCBjcmVhdGVkLiAqL1xuICBmb2xkZXI/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZW50cnkgYSBoaWRlIHRvdWNoZWQsIGFuZCB3aGV0aGVyIGl0IHJlbW92ZWQgdGhhdCBlbnRyeSBlbnRpcmVseS4gKi9cbiAgZW50cnk/OiBzdHJpbmc7XG4gIHJlbW92ZWRFbnRyeT86IGJvb2xlYW47XG59O1xuXG5jb25zdCBiYXNlID0gKHA6IHN0cmluZyk6IHN0cmluZyA9PiBwLnNwbGl0KFwiL1wiKS5wb3AoKSA/PyBwO1xuY29uc3QgcGFyZW50ID0gKHA6IHN0cmluZyk6IHN0cmluZyA9PiBwLnNsaWNlKDAsIE1hdGgubWF4KDAsIHAubGFzdEluZGV4T2YoXCIvXCIpKSkgfHwgXCIvXCI7XG5cbi8qKlxuICogVGhlIHdheSBiYWNrIGZyb20gb25lIGFjdC5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGFuIGFjdCBub3Qgd29ydGggYSBoaXN0b3J5IGVudHJ5IGF0IGFsbCDigJQgYHVuaGlkZWAgb24gYW5cbiAqIGVudHJ5IHRoYXQgaGFkIG5vdGhpbmcgaGlkZGVuIGNoYW5nZWQgbm90aGluZywgYW5kIGFuIHVuZG8gYXJyb3cgdGhhdCBzdGVwc1xuICogb3ZlciBuby1vcHMgaXMgYW4gYXJyb3cgdGhhdCBsaWVzIGFib3V0IGhvdyBmYXIgYmFjayBpdCBjYW4gZ28uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuSW52ZXJzZShvcDogU3RydWN0dXJlT3AsIGFmdGVyOiBBZnRlciwgYmVmb3JlOiBCZWZvcmUpOiBBY3QgfCBudWxsIHtcbiAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgLy8g4pSA4pSAIGJyb3VnaHQgc29tZXRoaW5nIGludG8gZXhpc3RlbmNlOiBubyBpbnZlcnNlIHRoYXQgZG9lcyBub3QgZGVsZXRlIOKUgOKUgFxuICAgIGNhc2UgXCJkb2MuY3JlYXRlXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNyZWF0ZWQgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogZmFsc2UgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcImZvbGRlci5jcmVhdGVcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY3JlYXRlZCB0aGUgZm9sZGVyICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiLCBkaXI6IHRydWUgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjb3BpZWQgaW4gJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogZmFsc2UgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcInNldC5tYWtlXCI6XG4gICAgICAvLyDimqAgVEhFIEZPTERFUiBJUyBUSEUgVEhJTkcgVE8gVU5ETywgbm90IHRoZSBtb3ZlIGluc2lkZSBpdC4gYHNldC5tYWtlYFxuICAgICAgLy8gY3JlYXRlcyBhIGZvbGRlciBhbmQgbW92ZXMgdGhlIGRvY3VtZW50IGluLCBzbyB0aGUgaW52ZXJzZSBpcyB0b1xuICAgICAgLy8gcmVtb3ZlIHRoZSBmb2xkZXIg4oCUIHdoaWNoIHRoZSBlbXB0aW5lc3MgcnVsZSB3aWxsIHJlZnVzZSB3aGlsZSB0aGVcbiAgICAgIC8vIGRvY3VtZW50IGlzIHN0aWxsIGluIHRoZXJlLiBUaGF0IHJlZnVzYWwgaXMgY29ycmVjdCBhbmQgcmVhZGFibGVcbiAgICAgIC8vIChcInRoZSBmb2xkZXIgaXMgbm90IGVtcHR5XCIpLCBhbmQgdGhlIHdheSB0aHJvdWdoIGl0IGlzIHRvIG1vdmUgdGhlXG4gICAgICAvLyBkb2N1bWVudCBvdXQgZmlyc3QsIHdoaWNoIGlzIGl0c2VsZiBhbiB1bmRvYWJsZSBhY3QuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHR1cm5lZCAke2Jhc2Uob3AucGF0aCl9IGludG8gYSBzZXRgLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLmZvbGRlciA/PyBcIlwiLCBkaXI6IHRydWUgfSxcbiAgICAgIH07XG5cbiAgICAvLyDilIDilIAgcmV2ZXJzaWJsZSwgd2l0aCBhcmd1bWVudHMgb25seSB0aGUgYWN0IGtuZXcg4pSA4pSAXG4gICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgaWYgKGFmdGVyLnBhdGggPT09IHVuZGVmaW5lZCB8fCBhZnRlci5mcm9tID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBtb3ZlZCAke2Jhc2UoYWZ0ZXIuZnJvbSl9IGludG8gJHtiYXNlKHBhcmVudChhZnRlci5wYXRoKSl9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIm1vdmVcIiwgcGF0aDogYWZ0ZXIucGF0aCwgaW50bzogcGFyZW50KGFmdGVyLmZyb20pIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgIGlmIChhZnRlci5wYXRoID09PSB1bmRlZmluZWQgfHwgYWZ0ZXIuZnJvbSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgcmVuYW1lZCAke2Jhc2UoYWZ0ZXIuZnJvbSl9IHRvICR7YmFzZShhZnRlci5wYXRoKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwicmVuYW1lXCIsIHBhdGg6IGFmdGVyLnBhdGgsIG5hbWU6IGJhc2UoYWZ0ZXIuZnJvbSkgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJoaWRlXCI6IHtcbiAgICAgIC8vIFR3byBzaGFwZXM6IGhpZGluZyBvbmUgaXRlbSBpbnNpZGUgYSBzZXQsIG9yIGhpZGluZyBhIHNpbmdsZS1kb2N1bWVudFxuICAgICAgLy8gZW50cnksIHdoaWNoIHJlbW92ZXMgdGhlIGVudHJ5IG91dHJpZ2h0LlxuICAgICAgaWYgKGFmdGVyLnJlbW92ZWRFbnRyeSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcmVtb3ZlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX0gZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImNvbnRleHQuYWRkXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY29uc3QgaGFkID0gYmVmb3JlLmhpZGRlbjtcbiAgICAgIGlmICghaGFkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgcmVtb3ZlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX0gZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IGhhZC5lbnRyeSwgcmVsczogaGFkLnJlbHMgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJ1bmhpZGVcIjoge1xuICAgICAgY29uc3QgaGFkID0gYmVmb3JlLmhpZGRlbjtcbiAgICAgIC8vIE5vdGhpbmcgd2FzIGhpZGRlbiwgc28gbm90aGluZyBoYXBwZW5lZDogbm90IGhpc3RvcnkuXG4gICAgICBpZiAoIWhhZCB8fCBoYWQucmVscy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBicm91Z2h0IGJhY2sgJHtoYWQucmVscy5sZW5ndGh9IGhpZGRlbiBpdGVtJHtoYWQucmVscy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImhpZGRlblwiLCBlbnRyeTogaGFkLmVudHJ5LCByZWxzOiBoYWQucmVscyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjoge1xuICAgICAgY29uc3Qgd2FzID0gYmVmb3JlLndvcmtzcGFjZTtcbiAgICAgIGlmICh3YXMgPT09IHVuZGVmaW5lZCB8fCB3YXMgPT09IGFmdGVyLnBhdGgpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBzZXQgdGhlIHdvcmtzcGFjZSB0byAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwid29ya3NwYWNlXCIsIHBhdGg6IHdhcyB9LFxuICAgICAgfTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFdoYXQgdGhlIGFycm93cyBuZWVkIHRvIGtub3csIGFuZCBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgdHlwZSBIaXN0b3J5VmlldyA9IHtcbiAgY2FuVW5kbzogYm9vbGVhbjtcbiAgY2FuUmVkbzogYm9vbGVhbjtcbiAgLyoqIFwibW92ZWQgbm90ZS5tZCBpbnRvIGRyYWZ0c1wiLCBmb3IgdGhlIHRvb2x0aXAuICovXG4gIHVuZG9MYWJlbD86IHN0cmluZztcbiAgcmVkb0xhYmVsPzogc3RyaW5nO1xuICAvKipcbiAgICogU2V0IHdoZW4gdGhlIG5leHQgdW5kbyB3b3VsZCBERUxFVEUgc29tZXRoaW5nLCBzbyB0aGUgc3VyZmFjZSBjYW4gcmFpc2UgYVxuICAgKiBjb25maXJtYXRpb24gYmVmb3JlIHNlbmRpbmcgaXQuIFByZXNlbnQgbWVhbnMgXCJhc2sgZmlyc3RcIiwgbm90IFwicmVmdXNlXCIuXG4gICAqL1xuICB1bmRvRGVsZXRlcz86IHsgcGF0aDogc3RyaW5nOyBkaXI6IGJvb2xlYW4gfTtcbn07XG5cbi8qKlxuICogVGhlIHR3byBzdGFja3MuXG4gKlxuICog4pqgIElOIE1FTU9SWSwgTk9UIElOIFRIRSBNQU5JRkVTVCwgYW5kIHRoYXQgaXMgYSBkZWNpc2lvbiByYXRoZXIgdGhhblxuICogbGF6aW5lc3M6IGFuIGludmVyc2UgcmVjb3JkZWQgbm93IGRlc2NyaWJlcyB0aGUgd29ybGQgYXMgaXQgaXMgbm93LCBhbmQgYVxuICogc2Vzc2lvbiByZXN0b3JlZCB0b21vcnJvdyBtYXkgbWVldCBhIGZpbGUgc29tZWJvZHkgaGFzIHNpbmNlIG1vdmVkIGJ5IGhhbmQuXG4gKiBPZmZlcmluZyBhbiB1bmRvIHdob3NlIGFyZ3VtZW50cyBoYXZlIGdvbmUgc3RhbGUgaXMgd29yc2UgdGhhbiBzdGFydGluZyBlYWNoXG4gKiBzZXNzaW9uIHdpdGggYW4gZW1wdHkgaGlzdG9yeSDigJQgc28gdGhlIGFycm93cyBhcmUgZ3JleSBhZnRlciBhIHJlc3RvcmUsIHdoaWNoXG4gKiBpcyBob25lc3QgYWJvdXQgd2hhdCBjYW4gc3RpbGwgYmUgcHV0IGJhY2suXG4gKi9cbmV4cG9ydCBjbGFzcyBIaXN0b3J5IHtcbiAgcHJpdmF0ZSB1bmRvczogQWN0W10gPSBbXTtcbiAgcHJpdmF0ZSByZWRvczogQWN0W10gPSBbXTtcblxuICAvKiogUmVjb3JkIGFuIGFjdC4gQSBuZXcgYWN0IG1ha2VzIHRoZSByZWRvIHN0YWNrIG1lYW5pbmdsZXNzLiAqL1xuICBkaWQoYWN0OiBBY3QgfCBudWxsKTogdm9pZCB7XG4gICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICB0aGlzLnVuZG9zLnB1c2goYWN0KTtcbiAgICB0aGlzLnJlZG9zID0gW107XG4gIH1cblxuICAvKiogV2hhdCB0aGUgbmV4dCB1bmRvIHdvdWxkIGRvLCB3aXRob3V0IGRvaW5nIGl0LiAqL1xuICBwZWVrVW5kbygpOiBBY3QgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy51bmRvc1t0aGlzLnVuZG9zLmxlbmd0aCAtIDFdID8/IG51bGw7XG4gIH1cblxuICBwZWVrUmVkbygpOiBBY3QgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5yZWRvc1t0aGlzLnJlZG9zLmxlbmd0aCAtIDFdID8/IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogVGFrZSB0aGUgbmV4dCB1bmRvLCBoYXZpbmcgYXBwbGllZCBpdC4gYHJlZG9gIGlzIHRoZSBhY3QgdGhhdCB3b3VsZCBwdXQgaXRcbiAgICogYmFjayDigJQgYnVpbHQgYnkgdGhlIGNhbGxlciwgYmVjYXVzZSBvbmx5IHRoZSBjYWxsZXIga25vd3Mgd2hhdCBpdHMgb3duXG4gICAqIGludmVyc2UgcHJvZHVjZWQuXG4gICAqL1xuICB0b29rVW5kbyhyZWRvOiBBY3QgfCBudWxsKTogdm9pZCB7XG4gICAgY29uc3QgYWN0ID0gdGhpcy51bmRvcy5wb3AoKTtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIGlmIChyZWRvKSB0aGlzLnJlZG9zLnB1c2gocmVkbyk7XG4gIH1cblxuICB0b29rUmVkbyh1bmRvOiBBY3QgfCBudWxsKTogdm9pZCB7XG4gICAgY29uc3QgYWN0ID0gdGhpcy5yZWRvcy5wb3AoKTtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIGlmICh1bmRvKSB0aGlzLnVuZG9zLnB1c2godW5kbyk7XG4gIH1cblxuICB2aWV3KCk6IEhpc3RvcnlWaWV3IHtcbiAgICBjb25zdCB1bmRvID0gdGhpcy5wZWVrVW5kbygpO1xuICAgIGNvbnN0IHJlZG8gPSB0aGlzLnBlZWtSZWRvKCk7XG4gICAgY29uc3QgZGVsZXRlcyA9IHVuZG8/LmludmVyc2Uua2luZCA9PT0gXCJkZWxldGVcIiA/IHVuZG8uaW52ZXJzZSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4ge1xuICAgICAgLy8g4puUIEEgREVMRVRJTkcgVU5ETyBJUyBTVElMTCBVTkRPQUJMRSDigJQgdGhlIGdhdGUgaXMgdGhlIGRpYWxvZywgbm90IHRoZVxuICAgICAgLy8gZGlzYWJsZWQgc3RhdGUgKENvbGUncyBydWxpbmcsIHJldmVyc2luZyBhbiBlYXJsaWVyIGRlc2lnbiB0aGF0XG4gICAgICAvLyBzdHJhbmRlZCBldmVyeSBhY3QgYmVoaW5kIGEgY3JlYXRpb24pLlxuICAgICAgY2FuVW5kbzogdW5kbyAhPT0gbnVsbCxcbiAgICAgIGNhblJlZG86IHJlZG8gIT09IG51bGwsXG4gICAgICAuLi4odW5kbyA/IHsgdW5kb0xhYmVsOiB1bmRvLmxhYmVsIH0gOiB7fSksXG4gICAgICAuLi4ocmVkbyA/IHsgcmVkb0xhYmVsOiByZWRvLmxhYmVsIH0gOiB7fSksXG4gICAgICAuLi4oZGVsZXRlcyA/IHsgdW5kb0RlbGV0ZXM6IHsgcGF0aDogZGVsZXRlcy5wYXRoLCBkaXI6IGRlbGV0ZXMuZGlyIH0gfSA6IHt9KSxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEhvdyBkZWVwIHRoZSBzdGFja3MgYXJlIOKAlCBmb3IgdGVzdHMgYW5kIGZvciBgc3RhdGUgLS1mdWxsYC4gKi9cbiAgZGVwdGgoKTogeyB1bmRvOiBudW1iZXI7IHJlZG86IG51bWJlciB9IHtcbiAgICByZXR1cm4geyB1bmRvOiB0aGlzLnVuZG9zLmxlbmd0aCwgcmVkbzogdGhpcy5yZWRvcy5sZW5ndGggfTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBOQVRJVkUgZmlsZSBwaWNrZXIg4oCUIHRoZSBhZmZvcmRhbmNlIGEgd2ViIHBhZ2UgY2Fubm90IGhhdmUuXG4gKlxuICogQSBicm93c2VyJ3Mgb3duIGA8aW5wdXQgdHlwZT1cImZpbGVcIj5gIGFuZCBgc2hvd09wZW5GaWxlUGlja2VyKClgIGJvdGggaGFuZFxuICogYmFjayBmaWxlIENPTlRFTlQgYW5kIGEgbmFtZSwgbmV2ZXIgYSBwYXRoIChhbmQgQnJhdmUsIENvbGUncyBicm93c2VyLFxuICogZGlzYWJsZXMgdGhlIEZpbGUgU3lzdGVtIEFjY2VzcyBBUEkgb3V0cmlnaHQpLiBBIGNvcHkgaXMgYWxsIGEgcGFnZSBjYW4gZG9cbiAqIHdpdGggdGhhdCwgd2hpY2ggaXMgZXhhY3RseSB3aGF0IGEgZHJvcCBhbHJlYWR5IGRvZXMgKEUyMykuIEJ1dCBzY3JpcHRvcml1bSdzXG4gKiBkYWVtb24gaXMgYSBMT0NBTCBQUk9DRVNTOiBpdCBjYW4gYXNrIHRoZSBPUyBmb3IgaXRzIG93biBvcGVuIGRpYWxvZyBhbmQgZ2V0XG4gKiBiYWNrIGEgcmVhbCBmaWxlc3lzdGVtIHBhdGgg4oCUIHNvIFwiQ2hvb3Nl4oCmXCIgbGlua3MgdGhlIHJlYWwgZmlsZSAoRTEpIGluc3RlYWRcbiAqIG9mIGNvcHlpbmcgaXQuXG4gKlxuICogRXZlcnl0aGluZyBoZXJlIGlzIHB1cmU6IHdoaWNoIGFyZ3YgdG8gcnVuLCBhbmQgaG93IHRvIHJlYWQgd2hhdCBpdCBwcmludGVkLlxuICogVGhlIHNwYXduaW5nIChhbmQgdGhlIG9uZS1hdC1hLXRpbWUgcnVsZSkgaXMgdGhlIGRhZW1vbidzLlxuICovXG5cbmV4cG9ydCB0eXBlIFBpY2tLaW5kID0gXCJmaWxlXCIgfCBcImZvbGRlclwiO1xuXG4vKiogQW4gQXBwbGVTY3JpcHQgdGhhdCBwdXRzIG9uZSBQT1NJWCBwYXRoIHBlciBsaW5lIG9uIHN0ZG91dC4gKi9cbmZ1bmN0aW9uIGFwcGxlU2NyaXB0KGtpbmQ6IFBpY2tLaW5kLCBwcm9tcHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHF1b3RlZCA9IHByb21wdC5yZXBsYWNlKC9bXCJcXFxcXS9nLCBcIlwiKTtcbiAgY29uc3QgY2hvb3NlID1cbiAgICBraW5kID09PSBcImZpbGVcIlxuICAgICAgPyBgY2hvb3NlIGZpbGUgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIiB3aXRoIG11bHRpcGxlIHNlbGVjdGlvbnMgYWxsb3dlZGBcbiAgICAgIDogYHtjaG9vc2UgZm9sZGVyIHdpdGggcHJvbXB0IFwiJHtxdW90ZWR9XCJ9YDtcbiAgcmV0dXJuIFtcbiAgICBgc2V0IGNob3NlbiB0byAke2Nob29zZX1gLFxuICAgICdzZXQgb3V0IHRvIFwiXCInLFxuICAgIFwicmVwZWF0IHdpdGggZiBpbiBjaG9zZW5cIixcbiAgICBcInNldCBvdXQgdG8gb3V0ICYgUE9TSVggcGF0aCBvZiBmICYgbGluZWZlZWRcIixcbiAgICBcImVuZCByZXBlYXRcIixcbiAgICBcInJldHVybiBvdXRcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjb21tYW5kIHRoYXQgb3BlbnMgdGhlIE9TJ3MgcGlja2VyLCBvciBudWxsIHdoZXJlIHRoZXJlIGlzIG5vbmUg4oCUIHRoZVxuICogY2FsbGVyIHRoZW4gc2F5cyBzbyByYXRoZXIgdGhhbiBoYW5naW5nIG9uIGEgZGlhbG9nIG5vYm9keSB3aWxsIHNlZS5cbiAqIGB6ZW5pdHlBdGAgaXMgd2hlcmUgYSBMaW51eCB6ZW5pdHkgd2FzIGZvdW5kICh0aGUgY2FsbGVyIGxvb2tzIGl0IHVwKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpY2tlckNvbW1hbmQoXG4gIHBsYXRmb3JtOiBzdHJpbmcsXG4gIGtpbmQ6IFBpY2tLaW5kLFxuICBwcm9tcHQ6IHN0cmluZyxcbiAgemVuaXR5QXQ/OiBzdHJpbmcgfCBudWxsLFxuKTogc3RyaW5nW10gfCBudWxsIHtcbiAgaWYgKHBsYXRmb3JtID09PSBcImRhcndpblwiKSByZXR1cm4gW1wib3Nhc2NyaXB0XCIsIFwiLWVcIiwgYXBwbGVTY3JpcHQoa2luZCwgcHJvbXB0KV07XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSByZXR1cm4gbnVsbDsgLy8gUG93ZXJTaGVsbCdzIGRpYWxvZyBuZWVkcyBhIFNUQSBob3N0OyBub3Qgd3JpdHRlbiB1bnRpbCBhc2tlZCBmb3JcbiAgaWYgKHplbml0eUF0KVxuICAgIHJldHVybiBbXG4gICAgICB6ZW5pdHlBdCxcbiAgICAgIFwiLS1maWxlLXNlbGVjdGlvblwiLFxuICAgICAgLi4uKGtpbmQgPT09IFwiZm9sZGVyXCIgPyBbXCItLWRpcmVjdG9yeVwiXSA6IFtcIi0tbXVsdGlwbGVcIl0pLFxuICAgICAgXCItLXNlcGFyYXRvcj1cXG5cIixcbiAgICAgIGAtLXRpdGxlPSR7cHJvbXB0fWAsXG4gICAgXTtcbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBUaGUgcGF0aHMgYSBwaWNrZXIgcHJpbnRlZDogb25lIHBlciBsaW5lLCBibGFua3MgZHJvcHBlZCwgb3JkZXIga2VwdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVBpY2tlck91dHB1dChzdGRvdXQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHN0ZG91dFxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5tYXAoKGwpID0+IGwudHJpbSgpKVxuICAgIC5maWx0ZXIoKGwpID0+IGwuc3RhcnRzV2l0aChcIi9cIikpXG4gICAgLm1hcCgobCkgPT4gKGwubGVuZ3RoID4gMSAmJiBsLmVuZHNXaXRoKFwiL1wiKSA/IGwuc2xpY2UoMCwgLTEpIDogbCkpO1xufVxuXG4vKiogQSBjYW5jZWxsZWQgZGlhbG9nIGlzIG5vdCBhIGZhaWx1cmUg4oCUIG9zYXNjcmlwdCBleGl0cyAxLCB6ZW5pdHkgZXhpdHMgMSwgYW5kIG5vdGhpbmcgd2FzIGNob3Nlbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YXNDYW5jZWxsZWQoZXhpdENvZGU6IG51bWJlciwgc3Rkb3V0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGV4aXRDb2RlICE9PSAwICYmIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dCkubGVuZ3RoID09PSAwO1xufVxuIiwKICAgICIvLyBFNjY6IHdoaWNoIGRvY3VtZW50IHRleHQgYSBoZWxkIHNlbGVjdGlvbiBpcyBhYm91dCDigJQgc2hhcmVkIGJ5IHRoZSBkYWVtb25cbi8vICh3aGF0IGBzYXlgIG1heSBhdHRhY2gpIGFuZCB0aGUgc3VyZmFjZSAod2hhdCB0aGUgY2hpcCBtYXkgc2hvdyksIHNvIHRoZSB0d29cbi8vIGhhbHZlcyBjYW5ub3QgZGlzYWdyZWUgYWJvdXQgd2hlbiBhIHNlbGVjdGlvbiBzdG9wcyBiZWluZyB0cnVlLlxuXG4vKiogVGhlIGRvY3VtZW50IHRleHQgb24gc2NyZWVuOiB0aGUgb3BlbiBkb2N1bWVudCwgYXQgaXRzIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuZXhwb3J0IHR5cGUgU2NyZWVuID0geyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH07XG5cbi8qKlxuICogVGhlIGhlbGQgc2VsZWN0aW9uIGlmIGl0IGlzIHN0aWxsIGFib3V0IHRoZSB0ZXh0IG9uIHNjcmVlbiwgZWxzZSBudWxsLlxuICpcbiAqIOKblCBBIFNFTEVDVElPTiBCRUxPTkdTIFRPIFRIRSBURVhUIElUIFdBUyBNQURFIElOLCBhbmQgY2Fubm90IG91dGxpdmUgdGhhdFxuICogdGV4dCBsZWF2aW5nIHRoZSBzY3JlZW4uIE9wZW5pbmcgYW5vdGhlciBkb2N1bWVudCDigJQgYnkgdGhlIGNvbnRleHQgbGlzdCwgYVxuICogc2VhcmNoIHJlc3VsdCwgYSBub3RlJ3MgXCJvcGVuXCIsIHRoZSBhZ2VudCDigJQgb3IgbWFraW5nIGFub3RoZXIgdmVyc2lvbiBhY3RpdmVcbiAqIHVzZWQgdG8gbGVhdmUgaXQgaGVsZCwgYW5kIHRoZSBzdXJmYWNlIHJlLXNlbnQgaXQgc3RhbXBlZCB3aXRoIHRoZSBORVdcbiAqIGRvY3VtZW50OiB0aGUgY2hpcCByZWFkIGBiZXRhLm1kIMK3IHYxIMK3IGxpbmUgNWAgb3ZlciBhbHBoYSdzIHdvcmRzLCBhbmQgYVxuICogYHNheWAgYXR0YWNoZWQgdGhlbSB0byBiZXRhJ3MgcGF0aC4gRHJvcHBlZCwgbmV2ZXIgcmUtbGFiZWxsZWQg4oCUIHRoZSBzYW1lXG4gKiBjbGVhciBhcyB0aGUgY2hpcCdzIFggKENvbGUsIDIwMjYtMDktMjI6IG9uZSBzdGF0ZSwgb25lIG1lYW5pbmcpLlxuICpcbiAqIFJldHVybnMgdGhlIFNBTUUgdmFsdWUgd2hlbiBpdCBpcyBrZXB0LCBzbyBhIGNhbGxlciBjYW4gdGVsbCBcIm5vIGNoYW5nZVwiIGJ5XG4gKiBpZGVudGl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdGlvbk9uU2NyZWVuPFQgZXh0ZW5kcyBTY3JlZW4+KFxuICBzZWw6IFQgfCBudWxsLFxuICBzY3JlZW46IFNjcmVlbiB8IG51bGwsXG4pOiBUIHwgbnVsbCB7XG4gIGlmICghc2VsIHx8ICFzY3JlZW4pIHJldHVybiBudWxsO1xuICByZXR1cm4gc2VsLmRvYyA9PT0gc2NyZWVuLmRvYyAmJiBzZWwudmVyc2lvbiA9PT0gc2NyZWVuLnZlcnNpb24gPyBzZWwgOiBudWxsO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBzZXNzaW9uIOKAlCB0aGUgZGFlbW9uJ3Mgc3RhdGUsIGFuZCB0aGUgb25seSBjb2RlIHRoYXQgd3JpdGVzIGEgZmlsZS5cbiAqXG4gKiBFOCdzIHNoYXBlLCB0aGUgaG91c2UncyBcIm1hdGVyaWFsaXplZCBwYXRoXCIgcGF0dGVybjogdGhlIGRhZW1vbiBvd25zIHRoZVxuICogc2Vzc2lvbiAoY29udGV4dCwgZG9jcywgdmVyc2lvbnMsIHdoaWNoIGlzIGFjdGl2ZSwgdGhlIGNoYXQpIGFuZCBwZXJzaXN0cyBpdFxuICogYXMgYG1hbmlmZXN0Lmpzb25gOyBldmVyeSB2ZXJzaW9uJ3MgVEVYVCBpcyBhIGZpbGUgaW4gdGhlIHNlc3Npb24gZm9sZGVyLCBzb1xuICogdGhlIGFnZW50IGVkaXRzIHZlcnNpb25zIHdpdGggaXRzIG93biBmaWxlIHRvb2xzLlxuICpcbiAqICAgICAkU0NSSVBUT1JJVU1fSE9NRS9zZXNzaW9ucy88c2Vzc2lvbklkPi9cbiAqICAgICAgIG1hbmlmZXN0Lmpzb24gICAgICAgICAgICAgIHdyaXR0ZW4gYXRvbWljYWxseSwgb24gZXZlcnkgY2hhbmdlXG4gKiAgICAgICBkb2NzLzxzbHVnPi92MS5tZCwgdjIubWQgICBvbmUgZmlsZSBwZXIgdmVyc2lvblxuICpcbiAqIFRoZSB0aHJlZSB3cml0ZSBydWxlcywgZWFjaCBhIGRlY2lzaW9uIHJhdGhlciB0aGFuIGEgaGFiaXQ6XG4gKlxuICogLSAqKlRoZSBvcmlnaW5hbCBpcyB3cml0dGVuIE9OTFkgYnkgYHNhdmVgKiogKEU3KS4gT3BlbmluZyBjb3BpZXMgaXQgdG8gdjE7XG4gKiAgIG5vdGhpbmcgZWxzZSB0b3VjaGVzIGl0LlxuICogLSAqKkV2ZXJ5IHdyaXRlIHRoaXMgbW9kdWxlIG1ha2VzIGlzIHJlbWVtYmVyZWQgYnkgY29udGVudCBoYXNoKiogKHRoZVxuICogICBgb3duZWRgIG1hcCkgc28gdGhlIHdhdGNoZXIgY2FuIHRlbGwgdGhlIGRhZW1vbidzIG93biB3cml0ZXMgZnJvbSBhbnlvbmVcbiAqICAgZWxzZSdzIChpbnZlc3RpZ2F0aW9uIMKnNSkuIEEgd3JpdGUgdG8gdGhlIEFDVElWRSB2ZXJzaW9uIHRoYXQgaXMgbm90IG91cnNcbiAqICAgaXMgYW4gRTIgdmlvbGF0aW9uIHRoZSBkYWVtb24gYW5ub3VuY2VzLlxuICogLSAqKlRoZSBhZ2VudCBuZXZlciB3cml0ZXMgdGhlIGFjdGl2ZSB2ZXJzaW9uKiogKEUyKSDigJQgZW5mb3JjZWQgc29jaWFsbHkgYnlcbiAqICAgU0tJTEwubWQgYW5kIGRldGVjdGVkIGhlcmUsIG5vdCBwcmV2ZW50ZWQ6IHRoZSBmaWxlIGlzIHRoZSBhZ2VudCdzIG1lZGl1bS5cbiAqXG4gKiBOb3RoaW5nIGhlcmUga25vd3MgYWJvdXQgc29ja2V0cywgSFRUUCBvciB0aGUgZXZlbnQgbG9nLiBUaGUgZGFlbW9uIGNhbGxzIGFcbiAqIG1ldGhvZCwgZ2V0cyBhIHJlc3VsdCwgYW5kIGRlY2lkZXMgd2hhdCB0byBicm9hZGNhc3Q7IHRoYXQgc3BsaXQgaXMgd2hhdFxuICogbGV0cyB0aGUgdW5pdCBjZWxscyBkcml2ZSB0aGUgd2hvbGUgbW9kZWwgd2l0aCBhIHRlbXAgaG9tZS5cbiAqL1xuXG5pbXBvcnQge1xuICBjbG9zZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgb3BlblN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWRTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIC8vIOKaoCBgcm1kaXJTeW5jYCByYXRoZXIgdGhhbiBgcm1TeW5jKOKApiwge3JlY3Vyc2l2ZTp0cnVlfSlgIE9OIFBVUlBPU0U6IGl0XG4gIC8vIHRocm93cyBFTk9URU1QVFksIHdoaWNoIGlzIGEgc2Vjb25kIG5ldCB1bmRlciBgcmVtb3ZlQ3JlYXRlZGAncyBvd25cbiAgLy8gZW1wdGluZXNzIGNoZWNrLiBBIHJlY3Vyc2l2ZSBkZWxldGUgd291bGQgbWFrZSB0aGUgYnVnIGl0IHByZXZlbnRzXG4gIC8vIHVucmVjb3ZlcmFibGUgcmF0aGVyIHRoYW4gbG91ZC5cbiAgcm1kaXJTeW5jLFxuICBybVN5bmMsXG4gIHN0YXRTeW5jLFxuICB1bmxpbmtTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgZXh0bmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IHR5cGUgQW5jaG9yLCBhbmNob3JPZiwgZmluZEFuY2hvciwgbGluZXNPZiB9IGZyb20gXCIuL2FuY2hvcnNcIjtcbmltcG9ydCB7IGFwcGx5SHVua3MsIGRpZmZUZXh0IH0gZnJvbSBcIi4vZGlmZlwiO1xuaW1wb3J0IHsgdHlwZSBGaW5kaW5nLCBmaW5kaW5ncyB9IGZyb20gXCIuL2RvY3RvclwiO1xuaW1wb3J0IHtcbiAgYm9keUxpbmVPZmZzZXQsXG4gIGJ1aWxkQmxvY2ssXG4gIGd1ZXNzVHlwZSxcbiAgbWF0Y2hlc0ZpbHRlcixcbiAgcmVhZE1ldGEsXG4gIHNldEtleSxcbiAgc3BsaXRGcm9udG1hdHRlcixcbiAgc3VtbWFyaXplLFxuICB0aXRsZUZyb21Cb2R5LFxuICB3aXRoQmxvY2ssXG59IGZyb20gXCIuL2Zyb250bWF0dGVyXCI7XG5pbXBvcnQgeyB0eXBlIEJ1bmRsZUluZGV4LCBidWlsZEdyYXBoLCB0eXBlIFJlc29sdXRpb24sIHJlc29sdmVUYXJnZXQgfSBmcm9tIFwiLi9saW5rc1wiO1xuaW1wb3J0IHR5cGUge1xuICBDaGF0TWVzc2FnZSxcbiAgQ2hhdFdobyxcbiAgQ2xvc2VkQnksXG4gIENvbnRleHRFbnRyeSxcbiAgQ29udGV4dE5vZGUsXG4gIERpZmZQYXlsb2FkLFxuICBEaWZmU2lkZSxcbiAgRG9jTWV0YSxcbiAgRG9jU3VtbWFyeSxcbiAgRG9jVmlldyxcbiAgR3JhcGhQYXlsb2FkLFxuICBNZXRhRmlsdGVyLFxuICBNb3ZlUGxhbixcbiAgTm90ZSxcbiAgTm90ZVJlZixcbiAgUGxhY2VkTm90ZSxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgVGFzayxcbiAgVmVyc2lvbixcbiAgVmVyc2lvbkF1dGhvcixcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgQ2FuZGlkYXRlLCB0eXBlIFNlYXJjaFJlcG9ydCwgc2VhcmNoRG9jdW1lbnRzIH0gZnJvbSBcIi4vc2VhcmNoXCI7XG5pbXBvcnQge1xuICBET0NfRVhURU5TSU9OUyxcbiAgZG9jUGF0aHMsXG4gIGVudHJ5Rm9yUGF0aCxcbiAgZmluZE5vZGUsXG4gIGlzRG9jTmFtZSxcbiAgbG9jYXRlLFxuICBNSVJST1JfTk9ERV9DQVAsXG4gIHNjYW5UcmVlLFxuICB0b1Bvc2l4LFxufSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCBjb25zdCBNQU5JRkVTVF9GT1JNQVQgPSAxO1xuXG4vKipcbiAqIFRoZSBmaWxlIG5hbWUgYSBjaGF0IGxpbmsgcmVzb2x2ZXMgXCJmcm9tXCIgd2hlbiBpdCByZWFkcyBmcm9tIGEgZm9sZGVyIHJhdGhlclxuICogdGhhbiBhIGRvY3VtZW50OiBgcmVzb2x2ZVRhcmdldGAgcmVhZHMgb25seSB0aGUgZm9sZGVyIG9mIGl0cyBgZnJvbWAuIE5vIGZpbGVcbiAqIG9mIHRoaXMgbmFtZSBpcyBldmVyIGxvb2tlZCB1cCBvciBjcmVhdGVkLlxuICovXG5jb25zdCBDSEFUX09SSUdJTiA9IFwiXFx1MDAwMGNoYXRcIjtcblxuLyoqIFRoZSBtb3N0IGRvY3VtZW50cyBvbmUgZnJvbnRtYXR0ZXIgc2NhbiByZWFkcy4gKi9cbmV4cG9ydCBjb25zdCBNRVRBX1NDQU5fQ0FQID0gNTAwO1xuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgbGl2ZXMgYXQgdGhlIHRvcCBvZiBhIGZpbGU7IHRoaXMgaXMgaG93IG11Y2ggd2UgcmVhZCB0byBmaW5kIGl0LiAqL1xuY29uc3QgTUVUQV9IRUFEX0JZVEVTID0gODE5MjtcblxuLyoqXG4gKiBXaGF0IHRoZSBsaW5rIHJlc29sdmVyIGFza3Mgb2YgdGhlIGRpc2sgKCMxMjMpOiBhIGZpbGUsIG9yIGEgZm9sZGVyLiBBIHBsYWluXG4gKiBgZXhpc3RzU3luY2AgYW5zd2VyZWQgeWVzIGZvciBhIGZvbGRlciB0b28sIHNvIGEgZm9sZGVyIG5hbWVkIGxpa2UgYSBmaWxlIHdhc1xuICogcmVwb3J0ZWQgYXMgYSBkb2N1bWVudCBvdXRzaWRlIHRoZSBzZXQuXG4gKi9cbmNvbnN0IGlzRmlsZUF0ID0gKHA6IHN0cmluZykgPT4gc3RhdFN5bmMocCwgeyB0aHJvd0lmTm9FbnRyeTogZmFsc2UgfSk/LmlzRmlsZSgpID8/IGZhbHNlO1xuY29uc3QgaXNEaXJBdCA9IChwOiBzdHJpbmcpID0+IHN0YXRTeW5jKHAsIHsgdGhyb3dJZk5vRW50cnk6IGZhbHNlIH0pPy5pc0RpcmVjdG9yeSgpID8/IGZhbHNlO1xuXG4vKiogVGhlIGZpcnN0IDggS0Igb2YgYSBmaWxlLCBhcyB0ZXh0IOKAlCBlbm91Z2ggZm9yIGFueSBmcm9udG1hdHRlciBibG9jay4gKi9cbmZ1bmN0aW9uIHJlYWRIZWFkKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBmZDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGZkID0gb3BlblN5bmMocGF0aCwgXCJyXCIpO1xuICAgIGNvbnN0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyhNRVRBX0hFQURfQllURVMpO1xuICAgIGNvbnN0IHJlYWQgPSByZWFkU3luYyhmZCwgYnVmLCAwLCBNRVRBX0hFQURfQllURVMsIDApO1xuICAgIHJldHVybiBidWYuc3ViYXJyYXkoMCwgcmVhZCkudG9TdHJpbmcoXCJ1dGY4XCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoZmQgIT09IHVuZGVmaW5lZCkgY2xvc2VTeW5jKGZkKTtcbiAgfVxufVxuXG50eXBlIERvY1JlY29yZCA9IHtcbiAgc2x1Zzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIG9yaWdpbmFsOiBzdHJpbmc7XG4gIGVudHJ5SWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlbDogc3RyaW5nIHwgbnVsbDtcbiAgZXh0OiBzdHJpbmc7XG4gIHZlcnNpb25zOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPltdO1xuICBhY3RpdmU6IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyIHRvIGhhbmQgb3V0IOKAlCBNT05PVE9OSUMsIGFuZCBuZXZlciBkZXJpdmVkIGZyb21cbiAgICogdGhlIHZlcnNpb25zIHN0aWxsIHByZXNlbnQgKEU0MSkuIE51bWJlcmluZyBhcyBgbWF4KGV4aXN0aW5nKSArIDFgIHdhc1xuICAgKiBjb3JyZWN0IHdoaWxlIG5vdGhpbmcgY291bGQgYmUgZGVsZXRlZDsgdGhlIG1vbWVudCBhIHZlcnNpb24gY2FuIGJlXG4gICAqIHJlbW92ZWQsIGRlbGV0aW5nIHRoZSBoaWdoZXN0IG1ha2VzIHRoZSBuZXh0IG9uZSBSRVVTRSBpdHMgbnVtYmVyLCBhbmQgYVxuICAgKiBgdjNgIG5hbWVkIGluIGEgY2hhdCBtZXNzYWdlLCBhIGxvZyBsaW5lIG9yIGFuIGFnZW50J3Mgbm90ZXMgd291bGQgdGhlblxuICAgKiBwb2ludCBhdCBhIGRpZmZlcmVudCBkb2N1bWVudC4gQWJzZW50IG9uIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgRTQxIOKAlFxuICAgKiBgdGFrZVZlcnNpb25gIGRlcml2ZXMgaXQgb25jZSwgZnJvbSB0aGUgaGlnaGVzdCB0aGF0IGV2ZXIgd2FzLlxuICAgKi9cbiAgbmV4dFZlcnNpb24/OiBudW1iZXI7XG4gIC8qKiBOb3RlcyBvbiB0aGlzIGRvY3VtZW50IChFNDUpLiBTdG9yZWQgaW4gdGhlIG1hbmlmZXN0OiB0aGV5IHRyYXZlbCB3aXRoIHRoZVxuICAgKiAgc2Vzc2lvbiBhbmQgbmV2ZXIgbGl0dGVyIHRoZSBodW1hbidzIGZvbGRlci4gKi9cbiAgbm90ZXM/OiBOb3RlW107XG4gIC8qKiBIYXNoIG9mIHRoZSBvcmlnaW5hbCBhcyB3ZSBsYXN0IHJlYWQgb3Igd3JvdGUgaXQg4oCUIGF0IG9wZW4sIHNhdmUsIHJldmVydFxuICAgKiAgYW5kIHJlbG9hZCDigJQgc28gYSByZXN0b3JlIGNhbiB0ZWxsIHRoYXQgaXQgY2hhbmdlZCB3aGlsZSBubyBkYWVtb24gd2FzXG4gICAqICB3YXRjaGluZyAodmVyaWZ5LXBhc3MgZml4IDIpLiAqL1xuICBvcmlnaW5hbEhhc2g6IHN0cmluZztcbiAgLyoqIFNldCBvbmx5IGJ5IGBvcGVuUGF0aGAsIHdoaWNoIGFkbWl0cyBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiAgZW50cnkuIGBzYXZlYCB3cml0ZXMgbm8gb3JpZ2luYWwgdGhhdCBsYWNrcyBpdCAodmVyaWZ5LXBhc3MgZml4IDFjKS4gKi9cbiAgYWRtaXR0ZWQ/OiBib29sZWFuO1xuICBvdXRzaWRlQ2hhbmdlZDogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIE1hbmlmZXN0ID0ge1xuICBmb3JtYXQ6IG51bWJlcjtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBjb250ZXh0OiBDb250ZXh0RW50cnlbXTtcbiAgZG9jczogRG9jUmVjb3JkW107XG4gIG9wZW5Eb2M6IHN0cmluZyB8IG51bGw7XG4gIGNoYXQ6IENoYXRNZXNzYWdlW107XG4gIC8qKiBUaGUgd29yayBxdWV1ZSAoRTUwKS4gQWJzZW50IGluIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgaXQgZXhpc3RlZC4gKi9cbiAgdGFza3M/OiBUYXNrW107XG4gIC8qKiBFMjMncyB3b3Jrc3BhY2UuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQ6IHRoZSB1c2VyJ3MgaG9tZS4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xuICAvKipcbiAgICogV2hvIGVuZGVkIHRoaXMgc2Vzc2lvbiwgYW5kIHdoZW4g4oCUIHNldCBhdCB0ZWFyZG93biwgY2xlYXJlZCBieSBhIHJlc3RvcmUuXG4gICAqIOKblCBJVCBMSVZFUyBIRVJFIEJFQ0FVU0UgVEhFIE1BTklGRVNUIE9VVExJVkVTIFRIRSBEQUVNT046IGEgdmVyYiBydW4gYWZ0ZXJcbiAgICogdGhlIGVuZCBmaW5kcyBubyBkYWVtb24gdG8gYXNrLCBhbmQgbXVzdCBzdGlsbCB0ZWxsIFwidGhlIGh1bWFuIGVuZGVkIHRoaXNcbiAgICogb24gcHVycG9zZVwiIChkbyBub3QgcmVvcGVuKSBmcm9tIGEgdGltZW91dCBvciBhIGNyYXNoIChyZW9wZW4gZnJlZWx5KS5cbiAgICogQWJzZW50IHdoaWxlIGxpdmUsIGFmdGVyIGEgY3Jhc2gsIGFuZCBvbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQuXG4gICAqL1xuICBlbmRlZD86IHsgYnk6IENsb3NlZEJ5OyBhdDogbnVtYmVyIH07XG59O1xuXG4vKiogQSByZWZ1c2FsIHRoZSBkYWVtb24gdHVybnMgaW50byBhbiBIVFRQIHN0YXR1cyDigJQgYGNob2ljZXNgIHdoZW4gdGhlIHNldCBpcyBpbiBoYW5kIChBMSkuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvbkVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgc3RhdHVzOiA0MDAgfCA0MDQgfCA0MDksXG4gICAgcmVhZG9ubHkgY2hvaWNlcz86IHN0cmluZ1tdLFxuICAgIC8qKlxuICAgICAqIFdoYXQgdG8gRE8gYWJvdXQgaXQsIHdoZW4gdGhlIG1lc3NhZ2UgYWxvbmUgZG9lcyBub3Qgc2F5LiBDYXJyaWVkIHRvIHRoZVxuICAgICAqIENMSSdzIGVudmVsb3BlLCB3aGVyZSB0aGUgaG91c2UgdGF4b25vbXkgYWxyZWFkeSBoYXMgYSBgaGludGAgZmllbGQgdGhhdFxuICAgICAqIHJlZnVzYWxzIGZyb20gdGhpcyBzaWRlIHdlcmUgbmV2ZXIgZmlsbGluZy5cbiAgICAgKi9cbiAgICByZWFkb25seSBoaW50Pzogc3RyaW5nLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgY29udGVudEhhc2ggPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IEJ1bi5oYXNoKHRleHQpLnRvU3RyaW5nKDE2KTtcblxuY29uc3QgcmFuZEhleCA9IChuOiBudW1iZXIpID0+XG4gIEFycmF5LmZyb20oY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhuZXcgVWludDhBcnJheShuKSkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxuICAgIC5qb2luKFwiXCIpO1xuXG5leHBvcnQgY29uc3QgbmV3U2Vzc2lvbklkID0gKCk6IHN0cmluZyA9PiByYW5kSGV4KDQpO1xuXG4vKiogQSBwYXRoJ3MgcmVhbHBhdGgsIG9yIHRoZSBwYXRoIGl0c2VsZiB3aGVuIGl0IGNhbm5vdCBiZSByZXNvbHZlZCAoZ29uZSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhbE9yKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWxwYXRoU3luYyhwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHA7XG4gIH1cbn1cblxuLyoqIFdoYXQgYSB3YXRjaGVyIGV2ZW50IHR1cm5lZCBvdXQgdG8gYmUuIGBudWxsYCA9IG5vdGhpbmcgKG91cnMsIG9yIG5vIGNoYW5nZSkuICovXG5leHBvcnQgdHlwZSBGaWxlRXZlbnQgPVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBhY3RpdmU6IGZhbHNlIH1cbiAgfCB7XG4gICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCI7XG4gICAgICBkb2M6IHN0cmluZztcbiAgICAgIHZlcnNpb246IG51bWJlcjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIC8qKiBUaGUgbmV3IGFnZW50IHZlcnNpb24gdGhlIG91dHNpZGUgdGV4dCB3YXMgcHJlc2VydmVkIGFzLiAqL1xuICAgICAgcHJlc2VydmVkQXM6IG51bWJlcjtcbiAgICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZztcbiAgICAgIC8qKiAjMTE3OiB0aGUgaHVtYW4gYWN0aXZhdGVkIHRoaXMgdmVyc2lvbiB3aGlsZSBpdCB3YXMgc3RpbGwgdGhlIGFnZW50J3NcbiAgICAgICAqICB1bndyaXR0ZW4gY29weSwgc28gdGhlIHdyaXRlIHdhcyB0aGUgYWdlbnQgZmlsbGluZyBpdCBpbiwgbm90IGJyZWFraW5nIEUyLiAqL1xuICAgICAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbjogYm9vbGVhbjtcbiAgICB9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiOyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInRyZWVcIjsgZW50cnlJZDogc3RyaW5nIH07XG5cbi8qKiBBIHZlcnNpb24gYW4gb3V0c2lkZSB3cml0ZSB3YXMga2VwdCBhcyDigJQgYW5kIHdoZXRoZXIgdGhhdCB3cml0ZSB3YXMgdGhlICMxMTcgcmFjZS4gKi9cbmV4cG9ydCB0eXBlIFByZXNlcnZlZFZlcnNpb24gPSBWZXJzaW9uICYgeyBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuOiBib29sZWFuIH07XG5cbmV4cG9ydCBjbGFzcyBTZXNzaW9uIHtcbiAgcmVhZG9ubHkgZGlyOiBzdHJpbmc7XG4gIHByaXZhdGUgbTogTWFuaWZlc3Q7XG4gIC8qKiBwYXRoIOKGkiBoYXNoIG9mIHRoZSBkYWVtb24ncyBsYXN0IHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIG93bmVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIGhhc2ggb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgY3VycmVudCB0ZXh0LiAqL1xuICBwcml2YXRlIGFjdGl2ZUhhc2ggPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBhcyB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgKG9yIGFkb3B0ZWQpXG4gICAqICBpdCDigJQgd2hhdCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBpcyByZXZlcnRlZCB0by4gKi9cbiAgcHJpdmF0ZSBsYXN0QWN0aXZlVGV4dCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKlxuICAgKiAjMTE3IOKAlCBwYXRoIOKGkiBoYXNoIG9mIGFuIGFnZW50IGB2ZXJzaW9uLW5ld2AgQ09QWSBhcyB0aGUgZGFlbW9uIG1hZGUgaXQsXG4gICAqIHdoaWxlIG5vYm9keSBoYXMgd3JpdHRlbiBpdCB5ZXQuIE5vdCBwZXJzaXN0ZWQ6IGl0IG9ubHkgaGFzIHRvIG91dGxpdmUgdGhlXG4gICAqIHNlY29uZHMgYmV0d2VlbiBgdmVyc2lvbi1uZXdgIGFuZCB0aGUgYWdlbnQncyB3cml0ZS5cbiAgICpcbiAgICog4puUIEFDVElWQVRJT04gRE9FUyBOT1QgQ0xFQVIgSVQuIFRoZSBmYWN0IGlzIFwidGhpcyB2ZXJzaW9uIHN0aWxsIGhvbGRzIHRoZVxuICAgKiBjb3B5IGl0IHdhcyBtYWRlIGZyb20gYW5kIG5vYm9keSBoYXMgd3JpdHRlbiBpdFwiIOKAlCB0cnVlIGFjcm9zcyBhbnkgbnVtYmVyXG4gICAqIG9mIGFjdGl2YXRpb25zLiBDbGVhcmluZyBpdCBvbiBhY3RpdmF0ZSBsb3N0IGl0IG9uIGEgaHVtYW4gZmxpcC1mbG9wXG4gICAqIChhY3RpdmF0ZSB2NCwgcGljayB2MSwgcGljayB2NCBhZ2FpbjsgdmVyaWZpZXIsIDIwMjYtMTAtMDEpLCBhbmQgdGhlIGFnZW50J3NcbiAgICogd3JpdGUgdGhlbiBnb3QgdGhlIG9sZCBcImJlbG9uZ3MgaW4gYSBuZXcgdmVyc2lvblwiIG1lc3NhZ2UgdGhhdCBpbnZpdGVzIHRoZVxuICAgKiBkdXBsaWNhdGUgIzExNyBzZXQgb3V0IHRvIHN0b3AuIEl0IGdvZXMgd2hlbiB0aGUgY29udGVudCBjaGFuZ2VzIChhblxuICAgKiBvdXRzaWRlIHdyaXRlLCBhIGh1bWFuIGVkaXQpIG9yIHRoZSB2ZXJzaW9uIGlzIGRlbGV0ZWQuXG4gICAqL1xuICBwcml2YXRlIHVud3JpdHRlbkNvcGllcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiAjMTE3IOKAlCBzbHVnIOKGkiB0aGUgdmVyc2lvbiB0aGUgSFVNQU4gYWN0aXZhdGVkIHdoaWxlIGl0IHdhcyBzdGlsbCBhblxuICAgKiAgdW53cml0dGVuIGNvcHkuIFJlYWQgKGFuZCBjbGVhcmVkKSBieSB0aGUgbmV4dCBvdXRzaWRlIHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIGFjdGl2YXRlZFVud3JpdHRlbiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8qKiBXaGF0IGEgcmVzdG9yZSBmb3VuZCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy4gKi9cbiAgcmVzdG9yZUZpbmRpbmdzOiB7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyBtaXNzaW5nOiBib29sZWFuIH1bXSA9IFtdO1xuXG4gIHByaXZhdGUgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgaG9tZTogc3RyaW5nLFxuICAgIG1hbmlmZXN0OiBNYW5pZmVzdCxcbiAgKSB7XG4gICAgdGhpcy5tID0gbWFuaWZlc3Q7XG4gICAgdGhpcy5kaXIgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgbWFuaWZlc3Quc2Vzc2lvbklkKTtcbiAgfVxuXG4gIHN0YXRpYyBjcmVhdGUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyA9IG5ld1Nlc3Npb25JZCgpLCB3b3Jrc3BhY2U/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgICAgLi4uKHdvcmtzcGFjZSA/IHsgd29ya3NwYWNlOiByZXNvbHZlKHdvcmtzcGFjZSkgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIC8qKiBSZWxvYWQgYSBzZXNzaW9uIGZyb20gaXRzIG1hbmlmZXN0IChgb3BlbiAtLXJlc3RvcmUgPGlkPmApLiAqL1xuICBzdGF0aWMgcmVzdG9yZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBzZXNzaW9uSWQsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHNhdmVkIHNlc3Npb24gJHtzZXNzaW9uSWR9YCwgNDA0KTtcbiAgICBjb25zdCBtID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBNYW5pZmVzdDtcbiAgICBpZiAobS5mb3JtYXQgIT09IE1BTklGRVNUX0ZPUk1BVClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHNlc3Npb24gJHtzZXNzaW9uSWR9IGhhcyBtYW5pZmVzdCBmb3JtYXQgJHttLmZvcm1hdH1gLCA0MDkpO1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCBtKTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBNaXJyb3JzIGFyZSByZS1yZWFkLCBub3QgdHJ1c3RlZDogdGhlIGZvbGRlciBtYXkgaGF2ZSBjaGFuZ2VkIHdoaWxlIG5vXG4gICAgLy8gZGFlbW9uIHdhcyB3YXRjaGluZyBpdC5cbiAgICBmb3IgKGNvbnN0IGUgb2Ygcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgcy5yZXNjYW4oZS5pZCk7XG4gICAgZm9yIChjb25zdCBkIG9mIHMubS5kb2NzKSB7XG4gICAgICBjb25zdCBwID0gcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgICBjb25zdCB0ZXh0ID0gZXhpc3RzU3luYyhwKSA/IHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikgOiBcIlwiO1xuICAgICAgcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMjogYW4gb3JpZ2luYWwgY2hhbmdlZCB3aGlsZSB0aGUgc2Vzc2lvbiB3YXMgY2xvc2VkXG4gICAgICAvLyB3YXMgaW52aXNpYmxlIGhlcmUsIHNvIHRoZSBuZXh0IFNhdmUgb3Zlcndyb3RlIGl0IHVuYW5ub3VuY2VkLiBUaGVcbiAgICAgIC8vIG1hbmlmZXN0IGhvbGRzIHRoZSBvcmlnaW5hbCdzIGhhc2ggYXMgb2YgdGhlIGxhc3Qgb3Blbi9zYXZlL3JldmVydC9cbiAgICAgIC8vIHJlbG9hZDsgYSBkaWZmZXJlbnQgaGFzaCBub3cgaXMgYW4gb3V0c2lkZSBjaGFuZ2UsIG1hcmtlZCBleGFjdGx5IGFzIGFcbiAgICAgIC8vIGxpdmUgb25lIHdpdGggYSBkaXJ0eSBidWZmZXIgaXMg4oCUIGFza2VkLCBuZXZlciBtZXJnZWQgb3IgcmVsb2FkZWQuXG4gICAgICBsZXQgbm93OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5vdyA9IGNvbnRlbnRIYXNoKHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIG5vdyA9IG51bGw7XG4gICAgICB9XG4gICAgICBpZiAobm93ID09PSBudWxsIHx8IG5vdyAhPT0gZC5vcmlnaW5hbEhhc2gpIHtcbiAgICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICAgIHMucmVzdG9yZUZpbmRpbmdzLnB1c2goeyBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwsIG1pc3Npbmc6IG5vdyA9PT0gbnVsbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gQSByZXN0b3JlZCBzZXNzaW9uIGlzIGxpdmUgYWdhaW46IHdob2V2ZXIgZW5kZWQgaXQgYmVmb3JlLCBub2JvZHkgaGFzIG5vdy5cbiAgICBjb25zdCB3YXNFbmRlZCA9IHMubS5lbmRlZCAhPT0gdW5kZWZpbmVkO1xuICAgIGRlbGV0ZSBzLm0uZW5kZWQ7XG4gICAgaWYgKHMucmVzdG9yZUZpbmRpbmdzLmxlbmd0aCA+IDAgfHwgd2FzRW5kZWQpIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgc3RhdGljIGxpc3RTYXZlZChob21lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpLmZpbHRlcigoaWQpID0+XG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIsIGlkLCBcIm1hbmlmZXN0Lmpzb25cIikpLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gIH1cblxuICBnZXQgaWQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLnNlc3Npb25JZDtcbiAgfVxuXG4gIGdldCBkb2NzRGlyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kaXIsIFwiZG9jc1wiKTtcbiAgfVxuXG4gIGdldCBvcGVuRG9jU2x1ZygpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLm9wZW5Eb2M7XG4gIH1cblxuICBnZXQgY29udGV4dCgpOiByZWFkb25seSBDb250ZXh0RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRpcmVjdG9yeSB0aGUgd2F0Y2hlciBtdXN0IHNlZTogdGhlIHNlc3Npb24ncyBkb2NzLCBlYWNoIGVudHJ5IHJvb3QsXG4gICAqIGFuZCB0aGUgUkVBTCBkaXJlY3Rvcnkgb2YgZXZlcnkgb3BlbmVkIG9yaWdpbmFsLlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDM6IGVhY2ggcm9vdCBpcyB3YXRjaGVkIGF0IGl0cyBSRUFMUEFUSCAoYHdhdGNoYCksIGFuZFxuICAgKiBhbiBldmVudCBpcyByZXBvcnRlZCB1bmRlciB0aGUgcGF0aCBmb3JtIHRoZSBzZXNzaW9uIHN0b3JlcyAoYHBhdGhgKS4gQVxuICAgKiB3YXRjaCBvbiBhIHN5bWxpbmtlZCBkaXJlY3Rvcnkg4oCUIGEgc3ltbGlua2VkIGhvbWUsIGEgc3ltbGlua2VkIGZvbGRlclxuICAgKiBlbnRyeSDigJQgb3Igb24gdGhlIGxpbmsncyBvd24gZGlyZWN0b3J5IGZvciBhIHN5bWxpbmtlZCBvcmlnaW5hbCBzYXdcbiAgICogbm90aGluZyB3aGVuIHRoZSBUQVJHRVQgY2hhbmdlZCAoRlNFdmVudHMgcmVwb3J0cyByZWFsIHBhdGhzKS4gQSBzeW1saW5rZWRcbiAgICogb3JpZ2luYWwgaXMgbWF0Y2hlZCBiYWNrIHRvIGl0cyBkb2MgYnkgcmVhbHBhdGggaW4gYG9uRmlsZUV2ZW50YC5cbiAgICovXG4gIHdhdGNoUm9vdHMoKTogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10ge1xuICAgIGNvbnN0IHJvb3RzOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSA9IFtcbiAgICAgIHsgcGF0aDogdGhpcy5kb2NzRGlyLCB3YXRjaDogcmVhbE9yKHRoaXMuZG9jc0RpciksIHJlY3Vyc2l2ZTogdHJ1ZSB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgcm9vdHMucHVzaCh7XG4gICAgICAgIHBhdGg6IGUucm9vdCxcbiAgICAgICAgd2F0Y2g6IHJlYWxPcihlLnJvb3QpLFxuICAgICAgICByZWN1cnNpdmU6IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiLFxuICAgICAgICBlbnRyeUlkOiBlLmlkLFxuICAgICAgfSk7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCByZWFsRGlyID0gZGlybmFtZShyZWFsT3IoZC5vcmlnaW5hbCkpO1xuICAgICAgaWYgKFxuICAgICAgICAhcm9vdHMuc29tZSgocikgPT4gci53YXRjaCA9PT0gcmVhbERpciAmJiByLnJlY3Vyc2l2ZSA9PT0gZmFsc2UpICYmXG4gICAgICAgICFyb290cy5zb21lKFxuICAgICAgICAgIChyKSA9PiByLnJlY3Vyc2l2ZSAmJiAocmVhbERpciA9PT0gci53YXRjaCB8fCByZWFsRGlyLnN0YXJ0c1dpdGgoci53YXRjaCArIHNlcCkpLFxuICAgICAgICApXG4gICAgICApXG4gICAgICAgIHJvb3RzLnB1c2goeyBwYXRoOiByZWFsRGlyLCB3YXRjaDogcmVhbERpciwgcmVjdXJzaXZlOiBmYWxzZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJvb3RzO1xuICB9XG5cbiAgLy8g4pSA4pSAIHBlcnNpc3RlbmNlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBSZWNvcmQgd2hvIGVuZGVkIHRoZSBzZXNzaW9uICh0ZWFyZG93biBwZXJzaXN0cyBpdCBuZXh0KS4gKi9cbiAgbWFya0VuZGVkKGJ5OiBDbG9zZWRCeSk6IHZvaWQge1xuICAgIHRoaXMubS5lbmRlZCA9IHsgYnksIGF0OiBEYXRlLm5vdygpIH07XG4gIH1cblxuICBwZXJzaXN0KCk6IHZvaWQge1xuICAgIG1rZGlyU3luYyh0aGlzLmRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGpvaW4odGhpcy5kaXIsIFwibWFuaWZlc3QuanNvblwiKSwgYCR7SlNPTi5zdHJpbmdpZnkodGhpcy5tLCBudWxsLCAyKX1cXG5gKTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVPd25lZChwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBSZW1lbWJlciBCRUZPUkUgd3JpdGluZzogdGhlIHdhdGNoZXIncyBldmVudCBjYW4gYXJyaXZlIGJlZm9yZSB0aGlzXG4gICAgLy8gZnVuY3Rpb24gcmV0dXJucywgYW5kIGl0IG11c3QgZmluZCB0aGUgaGFzaCBhbHJlYWR5IHRoZXJlLlxuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBhZG9wdEFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHAgPSB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICB0aGlzLm93bmVkLnNldChwLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZUFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5jb250ZW50Q2hhbmdlZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgLyoqIFRoZSB2ZXJzaW9uIGF0IGBwYXRoYCBub3cgaG9sZHMgYHRleHRgOiBhbiB1bndyaXR0ZW4gY29weSBpdCBubyBsb25nZXIgaXMuICovXG4gIHByaXZhdGUgY29udGVudENoYW5nZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAodGhpcy51bndyaXR0ZW5Db3BpZXMuZ2V0KHBhdGgpICE9PSBjb250ZW50SGFzaCh0ZXh0KSkgdGhpcy51bndyaXR0ZW5Db3BpZXMuZGVsZXRlKHBhdGgpO1xuICB9XG5cbiAgLyoqIEtlZXAgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gYXMgYSBORVcgYWdlbnQgdmVyc2lvbi4gKi9cbiAgcHJpdmF0ZSBwcmVzZXJ2ZU91dHNpZGUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiBQcmVzZXJ2ZWRWZXJzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgLy8gIzExNyDigJQgdHJ1ZSBvbmx5IHdoaWxlIEJPVEggaG9sZDogdGhlIGh1bWFuIGFjdGl2YXRlZCB0aGlzIHZlcnNpb24gYXMgYW5cbiAgICAvLyB1bndyaXR0ZW4gY29weSwgQU5EIGl0IGlzIG9uZSBzdGlsbCAobm9ib2R5IGhhcyBjaGFuZ2VkIGl0cyBjb250ZW50XG4gICAgLy8gc2luY2UpLiBBIGh1bWFuIHdobyB0eXBlZCBpbiBpdCBoYWQgd3JpdHRlbiBpdCAoc2Vjb25kIHZlcmlmaWVyLFxuICAgIC8vIDIwMjYtMTAtMDE6IGFjdGl2YXRlLCB0eXBlLCB3YWl0LCBhZ2VudCB3cml0ZXMg4oaSIHdhcyB0b2xkIFwiYmVmb3JlIHRoZVxuICAgIC8vIGFnZW50IGhhZCB3cml0dGVuIGl0XCIpLiBUaGUgY29udGVudCBydWxlIGRlY2lkZXMsIG5vdCB0aGUgYWN0aXZhdGlvbi5cbiAgICBjb25zdCBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuID1cbiAgICAgIHRoaXMuYWN0aXZhdGVkVW53cml0dGVuLmdldChkLnNsdWcpID09PSBkLmFjdGl2ZSAmJiB0aGlzLnVud3JpdHRlbkNvcGllcy5oYXMocGF0aCk7XG4gICAgLy8gU29tZW9uZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb246IHdoYXRldmVyIGl0IGhvbGRzIG5leHQsIGl0IGhhcyBiZWVuIHdyaXR0ZW4uXG4gICAgdGhpcy51bndyaXR0ZW5Db3BpZXMuZGVsZXRlKHBhdGgpO1xuICAgIC8vIFNhaWQgb25jZTogdGhlIGZpcnN0IG91dHNpZGUgd3JpdGUgYWZ0ZXIgdGhlIHJhY2UgaXMgdGhlIGFnZW50IGZpbGxpbmdcbiAgICAvLyB0aGUgY29weSBpbjsgYW55IGxhdGVyIG9uZSBpcyB0aGUgb3JkaW5hcnkgY2FzZS5cbiAgICB0aGlzLmFjdGl2YXRlZFVud3JpdHRlbi5kZWxldGUoZC5zbHVnKTtcbiAgICBjb25zdCBuID0gdGhpcy50YWtlVmVyc2lvbihkKTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgZnJvbTogZC5hY3RpdmUsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBsYWJlbDogYG91dHNpZGUgd3JpdGUgdG8gdiR7ZC5hY3RpdmV9YCxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbiksIGFjdGl2YXRlZEJlZm9yZVdyaXR0ZW4gfTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmZiBgdGV4dGAgYXQgYHBhdGhgIGlzIGV4YWN0bHkgd2hhdCB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgdGhlcmUuICovXG4gIGlzT3duV3JpdGUocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5vd25lZC5nZXQocGF0aCkgPT09IGNvbnRlbnRIYXNoKHRleHQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbnRleHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkQ29udGV4dChyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBDb250ZXh0RW50cnk7IGFkZGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgY29uc3QgcHJvYmUgPSBlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCk7XG4gICAgY29uc3Qgc2FtZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5yb290ID09PSBwcm9iZS5yb290ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gcHJvYmUubWVtYmVyc2hpcCAmJlxuICAgICAgICAocHJvYmUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiIHx8XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgPT09IEpTT04uc3RyaW5naWZ5KHByb2JlLm5vZGVzKSksXG4gICAgKTtcbiAgICBpZiAoc2FtZSkgcmV0dXJuIHsgZW50cnk6IHNhbWUsIGFkZGVkOiBmYWxzZSB9O1xuICAgIHRoaXMubS5jb250ZXh0LnB1c2gocHJvYmUpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IHByb2JlLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIEFuIGVudHJ5J3Mgcm9vdCBwYXRoLCBzbyBFNjAgY2FuIHB1dCBiYWNrIGEgY29udGV4dCBlbnRyeSBpdCByZW1vdmVkLiAqL1xuICBlbnRyeVJvb3QoaWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dC5maW5kKChlKSA9PiBlLmlkID09PSBpZCk/LnJvb3QgPz8gbnVsbDtcbiAgfVxuXG4gIHJlbW92ZUNvbnRleHQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGkgPSB0aGlzLm0uY29udGV4dC5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgICBpZiAoaSA8IDApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKChlKSA9PiBlLmlkKSxcbiAgICAgICk7XG4gICAgdGhpcy5tLmNvbnRleHQuc3BsaWNlKGksIDEpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBvcGVuIGRvY3VtZW50IGxlZnQgdGhlIGNvbnRleHQgKGl0cyBlbnRyeSByZW1vdmVkLCBvciB0aGUgZG9jdW1lbnRcbiAgICogaGlkZGVuKTogY2xvc2UgaXQgaW4gdGhlIHZpZXcuIEl0cyB2ZXJzaW9ucyBzdGF5IGluIHRoZSBzZXNzaW9uIOKAlCBub3RoaW5nXG4gICAqIGlzIGRlbGV0ZWQg4oCUIGFuZCBicmluZ2luZyBpdCBiYWNrIGFuZCBvcGVuaW5nIGl0IGFnYWluIGZpbmRzIHRoZW0uXG4gICAqL1xuICBwcml2YXRlIGNsb3NlT3JwaGFuZWRPcGVuRG9jKCk6IHZvaWQge1xuICAgIGNvbnN0IG9wZW4gPSB0aGlzLm0ub3BlbkRvYyA/IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIGlmIChvcGVuICYmIG9wZW4uZW50cnlJZCA9PT0gbnVsbCkgdGhpcy5tLm9wZW5Eb2MgPSBudWxsO1xuICB9XG5cbiAgLyoqIFJlLW1pcnJvciBhIGZvbGRlciBlbnRyeS4gUmV0dXJucyB3aGV0aGVyIGl0cyBub2RlcyBjaGFuZ2VkLiAqL1xuICByZXNjYW4oZW50cnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmIChlPy5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGUucm9vdCwgTUlSUk9SX05PREVfQ0FQLCBlLmhpZGRlbik7XG4gICAgY29uc3QgY2hhbmdlZCA9XG4gICAgICBKU09OLnN0cmluZ2lmeShub2RlcykgIT09IEpTT04uc3RyaW5naWZ5KGUubm9kZXMpIHx8ICEhdHJ1bmNhdGVkICE9PSAhIWUudHJ1bmNhdGVkO1xuICAgIGUubm9kZXMgPSBub2RlcztcbiAgICBpZiAodHJ1bmNhdGVkKSBlLnRydW5jYXRlZCA9IHRydWU7XG4gICAgZWxzZSBkZWxldGUgZS50cnVuY2F0ZWQ7XG4gICAgaWYgKGNoYW5nZWQpIHRoaXMucmVsaW5rKCk7XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG4gIH1cblxuICBwcml2YXRlIHJlbGluaygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBkLm9yaWdpbmFsKTtcbiAgICAgIGQuZW50cnlJZCA9IGF0Py5lbnRyeUlkID8/IG51bGw7XG4gICAgICBkLnJlbCA9IGF0Py5yZWwgPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgZG9jdW1lbnRzIGFuZCB2ZXJzaW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIHZlcnNpb25QYXRoKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRvY3NEaXIsIGQuc2x1ZywgYHYke259JHtkLmV4dH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgZG9jT3JEaWUoc2x1Zz86IHN0cmluZyk6IERvY1JlY29yZCB7XG4gICAgY29uc3Qgd2FudCA9IHNsdWcgPz8gdGhpcy5tLm9wZW5Eb2MgPz8gdW5kZWZpbmVkO1xuICAgIGNvbnN0IG9wZW5lZCA9IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gZC5zbHVnKTtcbiAgICAvKipcbiAgICAgKiDim5QgV0hFTiBOT1RISU5HIElTIE9QRU4sIFRIRSBPUEVORUQgU0xVR1MgQVJFIEFOIEVNUFRZIExJU1QgQU5EIEFOIEVNUFRZXG4gICAgICogTElTVCBJUyBOT1QgQU4gQU5TV0VSLiBBIGNvbGQgYWdlbnQgbmFtZWQgYSBkb2N1bWVudCBieSBmaWxlbmFtZSBiZWZvcmVcbiAgICAgKiBhbnl0aGluZyB3YXMgb3BlbiBhbmQgZ290IGBjaG9pY2VzOiBbXWAgd2l0aCBubyBoaW50IOKAlCBmcm9tIGEgc2Vzc2lvblxuICAgICAqIHdob3NlIGNvbnRleHQgaGVsZCBleGFjdGx5IHRoZSB0d28gZG9jdW1lbnRzIGl0IGNvdWxkIGhhdmUgbmFtZWQuIFRoZVxuICAgICAqIHJlZnVzYWwgd2FzIGNvcnJlY3QgYW5kIHVzZWxlc3MsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIG1vZGUgYGNob2ljZXNgXG4gICAgICogZXhpc3RzIHRvIHByZXZlbnQuXG4gICAgICpcbiAgICAgKiBTbyBhbiB1bm9wZW5lZCBzZXNzaW9uIG9mZmVycyB0aGUgcGF0aHMgaXQgQ09VTEQgb3BlbiwgYW5kIHNheXMgaG93LiBBXG4gICAgICogZmlsZW5hbWUgb25seSByZXNvbHZlcyBmb3IgYSBkb2N1bWVudCB0aGF0IGlzIGFscmVhZHkgb3BlbjsgYSBwYXRoIGFsd2F5c1xuICAgICAqIG9wZW5zIG9uZS5cbiAgICAgKi9cbiAgICBjb25zdCBjaG9pY2VzID1cbiAgICAgIG9wZW5lZC5sZW5ndGggPiAwID8gb3BlbmVkIDogdGhpcy5tLmNvbnRleHQuZmxhdE1hcCgoZSkgPT4gZG9jUGF0aHMoZSkpLnNsaWNlKDAsIDIwKTtcbiAgICBjb25zdCBoaW50ID1cbiAgICAgIG9wZW5lZC5sZW5ndGggPiAwXG4gICAgICAgID8gdW5kZWZpbmVkXG4gICAgICAgIDogXCJub3RoaW5nIGlzIG9wZW4geWV0IOKAlCBwYXNzIGEgUEFUSCBmcm9tIHRoZSBjb250ZXh0IChhIGZpbGVuYW1lIG9ubHkgcmVzb2x2ZXMgb25jZSBhIGRvY3VtZW50IGlzIG9wZW4pXCI7XG4gICAgaWYgKHdhbnQgPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJubyBkb2N1bWVudCBpcyBvcGVuIOKAlCBuYW1lIG9uZSB3aXRoIC0tZG9jXCIsIDQwOSwgY2hvaWNlcywgaGludCk7XG4gICAgY29uc3QgZCA9IHRoaXMuZmluZERvYyh3YW50KTtcbiAgICBpZiAoIWQpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIGRvY3VtZW50IFwiJHt3YW50fVwiIGluIHRoaXMgc2Vzc2lvbmAsIDQwNCwgY2hvaWNlcywgaGludCk7XG4gICAgcmV0dXJuIGQ7XG4gIH1cblxuICAvKiogQSBkb2MgYnkgc2x1ZywgYnkgb3JpZ2luYWwgcGF0aCwgb3IgYnkgYSB1bmlxdWUgb3JpZ2luYWwgYmFzZW5hbWUuICovXG4gIGZpbmREb2Moa2V5OiBzdHJpbmcpOiBEb2NSZWNvcmQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGJ5U2x1ZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0ga2V5KTtcbiAgICBpZiAoYnlTbHVnKSByZXR1cm4gYnlTbHVnO1xuICAgIC8vIOKblCBPTkxZIEFOIEFCU09MVVRFIGtleSBpcyBhIHBhdGggKHZlcmlmeS1wYXNzIGZpeCA4KTogcmVzb2x2aW5nIGFcbiAgICAvLyByZWxhdGl2ZSBvbmUgaGVyZSByZXNvbHZlZCBpdCBhZ2FpbnN0IHRoZSBEQUVNT04ncyBjd2QuIFRoZSBDTEkgcmVzb2x2ZXNcbiAgICAvLyBhZ2FpbnN0IGl0cyBvd24gY3dkIGFuZCBzZW5kcyBhbiBhYnNvbHV0ZSBwYXRoLlxuICAgIGlmIChpc0Fic29sdXRlKGtleSkpIHtcbiAgICAgIGNvbnN0IGJ5UGF0aCA9IHRoaXMubS5kb2NzLmZpbmQoXG4gICAgICAgIChkKSA9PiBkLm9yaWdpbmFsID09PSBrZXkgfHwgcmVhbE9yKGQub3JpZ2luYWwpID09PSByZWFsT3Ioa2V5KSxcbiAgICAgICk7XG4gICAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIH1cbiAgICBjb25zdCBieU5hbWUgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+IGJhc2VuYW1lKGQub3JpZ2luYWwpID09PSBrZXkgfHwgZC5yZWwgPT09IGtleSk7XG4gICAgcmV0dXJuIGJ5TmFtZS5sZW5ndGggPT09IDEgPyBieU5hbWVbMF0gOiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogVGhlIG5leHQgdmVyc2lvbiBudW1iZXIsIGNvbnN1bWVkLiBOdW1iZXJzIGFyZSBuZXZlciByZXVzZWQgKEU0MSkuICovXG4gIHByaXZhdGUgdGFrZVZlcnNpb24oZDogRG9jUmVjb3JkKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gZC5uZXh0VmVyc2lvbiA/PyBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGQubmV4dFZlcnNpb24gPSBuICsgMTtcbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIHByaXZhdGUgdmVyc2lvbk9yRGllKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4ge1xuICAgIGNvbnN0IHYgPSBkLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubiA9PT0gbik7XG4gICAgaWYgKCF2KVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gdiR7bn1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIGQudmVyc2lvbnMubWFwKCh4KSA9PiBgdiR7eC5ufWApLFxuICAgICAgKTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHByaXZhdGUgc2x1Z0ZvcihvcmlnaW5hbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzdGVtID1cbiAgICAgIGJhc2VuYW1lKG9yaWdpbmFsLCBleHRuYW1lKG9yaWdpbmFsKSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05Xy1dKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIikgfHwgXCJkb2NcIjtcbiAgICBsZXQgc2x1ZyA9IHN0ZW07XG4gICAgZm9yIChsZXQgaSA9IDI7IHRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gc2x1Zyk7IGkrKykgc2x1ZyA9IGAke3N0ZW19LSR7aX1gO1xuICAgIHJldHVybiBzbHVnO1xuICB9XG5cbiAgLyoqXG4gICAqIE9wZW4gYSBkb2N1bWVudCBieSBpdHMgb3JpZ2luYWwncyBwYXRoOiB2MSBpcyB3cml0dGVuIGZyb20gdGhlIG9yaWdpbmFsXG4gICAqIHRoZSBmaXJzdCB0aW1lLiBgZm9jdXM6IGZhbHNlYCAodGhlIGFnZW50J3MgaW1wbGljaXQgb3BlbiB0aHJvdWdoXG4gICAqIGB2ZXJzaW9uLW5ldyAtLWRvYyA8cGF0aD5gKSBkb2VzIG5vdCBtb3ZlIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMWIg4oCUIEFETUlTU0lPTi4gT25seSBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiBlbnRyeSBpcyBhZG1pdHRlZDsgYGNvbnRleHQuYWRkYCBzdGF5cyB0aGUgb25lIHdheSBpbi4gQmVmb3JlIHRoaXMsIGFueVxuICAgKiBwYXRoIG9mIGFueSB0eXBlIHdhcyBvcGVuZWQsIGFuZCBTYXZlIHRoZW4gd3JvdGUgaXQ6IGEgZm9yZWlnbiB3ZWIgcGFnZVxuICAgKiB3cm90ZSBgY3VybCBldmlsIHwgc2hgIGludG8gYSBgLnJjYCBmaWxlIG91dHNpZGUgdGhlIGNvbnRleHQuXG4gICAqL1xuICBvcGVuUGF0aChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgZm9jdXM/OiBib29sZWFuIH0gPSB7fSk6IHsgc2x1Zzogc3RyaW5nOyBjcmVhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGZvY3VzID0gb3B0cy5mb2N1cyA/PyB0cnVlO1xuICAgIC8vIFRoZSBjb250ZXh0J3Mgb3duIHNwZWxsaW5nIG9mIHRoZSBwYXRoOiBhIGNhbGxlciB3aG9zZSBjd2QgaXMgYSByZWFscGF0aFxuICAgIC8vICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgb3IgdGhyb3VnaCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAgLy8gZmlsZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBkb2MuXG4gICAgY29uc3QgYWJzID0gdGhpcy5jYW5vbmljYWwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBhYnMpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGV4aXN0aW5nLnNsdWc7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IHNsdWc6IGV4aXN0aW5nLnNsdWcsIGNyZWF0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmICghaXNEb2NOYW1lKGFicykpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCA0MDApO1xuICAgIGlmICghbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7YWJzfSBpcyBub3QgaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dCDigJQgYWRkIGl0IChvciBpdHMgZm9sZGVyKSBmaXJzdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSBmaWxlXCIpO1xuICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBvcGVuICR7YWJzfTogbm8gc3VjaCBmaWxlYCwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgZXh0ID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0uaW5jbHVkZXMoZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKCkpXG4gICAgICA/IGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpXG4gICAgICA6IFwiLm1kXCI7XG4gICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicyk7XG4gICAgY29uc3QgZDogRG9jUmVjb3JkID0ge1xuICAgICAgc2x1ZzogdGhpcy5zbHVnRm9yKGFicyksXG4gICAgICBuYW1lOiBiYXNlbmFtZShhYnMpLFxuICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgIGVudHJ5SWQ6IGF0Py5lbnRyeUlkID8/IG51bGwsXG4gICAgICByZWw6IGF0Py5yZWwgPz8gbnVsbCxcbiAgICAgIGV4dCxcbiAgICAgIHZlcnNpb25zOiBbeyBuOiAxLCBhdXRob3I6IFwiaHVtYW5cIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH1dLFxuICAgICAgYWN0aXZlOiAxLFxuICAgICAgb3JpZ2luYWxIYXNoOiBjb250ZW50SGFzaCh0ZXh0KSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFkbWl0dGVkOiB0cnVlLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MucHVzaChkKTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBkLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBjcmVhdGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogYGFic2AgYXMgdGhlIGNvbnRleHQgc3BlbGxzIGl0LCB3aGVuIGl0IGlzIHRoZSBzYW1lIGZpbGUgYnkgcmVhbHBhdGguICovXG4gIHByaXZhdGUgY2Fub25pY2FsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAoIXJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3BlbGxlZCA9IGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgc3BlbGxlZCkpIHJldHVybiBzcGVsbGVkO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgb3BlblNsdWcoc2x1Zzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLmRvY09yRGllKHNsdWcpLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICByZWFkVmVyc2lvbihzbHVnOiBzdHJpbmcsIG46IG51bWJlcik6IHsgdGV4dDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgbik7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgcmV0dXJuIHsgdGV4dDogcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSwgcGF0aCB9O1xuICB9XG5cbiAgYWN0aXZlUGF0aChzbHVnPzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgZCA9IHNsdWcgPyB0aGlzLmZpbmREb2Moc2x1ZykgOiB0aGlzLm0ub3BlbkRvYyA/IHRoaXMuZmluZERvYyh0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIGQgPyB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSA6IG51bGw7XG4gIH1cblxuICAvKiogVGhlIGh1bWFuJ3MgYnVmZmVyIHJlYWNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uJ3MgZmlsZSAoZGVib3VuY2VkIGJ5IHRoZSBzdXJmYWNlKS4gKi9cbiAgLyoqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggNCDigJQgQ0hFQ0sgQkVGT1JFIFdSSVRFLiBCZWZvcmUgdGhlIGh1bWFuJ3MgZWRpdCBpc1xuICAgKiB3cml0dGVuLCB0aGUgZmlsZSBvbiBkaXNrIGlzIGhhc2hlZDogaWYgaXQgaXMgbm90IHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgKiB3cml0ZSwgc29tZW9uZSBlbHNlIHdyb3RlIHRoZSBhY3RpdmUgdmVyc2lvbiAoRTIpLiBUaGF0IHRleHQgaXMga2VwdCBhcyBhXG4gICAqIE5FVyBhZ2VudCB2ZXJzaW9uLCBhbmQgb25seSB0aGVuIGlzIHRoZSBlZGl0IHdyaXR0ZW4uIERldGVjdGlvbiB1c2VkIHRvXG4gICAqIGRlcGVuZCBvbiB0aGUgd2F0Y2hlcidzIDYwIG1zIHNldHRsZSB0aW1lciBmaXJpbmcgYmVmb3JlIHRoZSBuZXh0XG4gICAqIGtleXN0cm9rZTsgYSBidXJzdCBvZiBlZGl0cyBhdCAzMCBtcyBjbG9iYmVyZWQgYW4gb3V0c2lkZSB3cml0ZVxuICAgKiB1bmFubm91bmNlZC4gTm93IG5vdGhpbmcgaXMgbG9zdCB3aGF0ZXZlciB0aGUgdGltaW5nIOKAlCB0aGUgb25lIHdpbmRvdyBsZWZ0XG4gICAqIGlzIHRoZSBtaWNyb3NlY29uZHMgYmV0d2VlbiB0aGlzIHJlYWQgYW5kIHRoaXMgd3JpdGUuXG4gICAqL1xuICBlZGl0KFxuICAgIHNsdWc6IHN0cmluZyxcbiAgICBuOiBudW1iZXIsXG4gICAgdGV4dDogc3RyaW5nLFxuICApOiB7IGRpcnR5Q2hhbmdlZDogYm9vbGVhbjsgcHJlc2VydmVkOiBQcmVzZXJ2ZWRWZXJzaW9uIHwgbnVsbCB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBpZiAobiAhPT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7bn0gaXMgbm90IHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30gKHYke2QuYWN0aXZlfSBpcykg4oCUIG9ubHkgdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIGVkaXRhYmxlYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSB0aGlzLmlzRGlydHkoZCk7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgLy8gVGhlIGVkaXQgaXMgc3RhZ2VkIGluIGEgc2libGluZyBmaWxlIEZJUlNULCBzbyB0aGUgY2hlY2sgYmVsb3cgYW5kIHRoZVxuICAgIC8vIHJlbmFtZSB0aGF0IGxhbmRzIHRoZSBlZGl0IGFyZSBhZGphY2VudCBzeXNjYWxsczogdGhlIHdpbmRvdyBpbiB3aGljaCBhblxuICAgIC8vIG91dHNpZGUgd3JpdGUgY291bGQgc2xpcCBiZXR3ZWVuIHRoZW0gaXMgbWljcm9zZWNvbmRzLCBub3QgdGhlIGxlbmd0aCBvZlxuICAgIC8vIGEgbXVsdGktbWVnYWJ5dGUgd3JpdGUg4oCUIGFuZCBhIHdyaXRlIGxhbmRpbmcgQUZURVIgdGhlIHJlbmFtZSBnb2VzIHRvIHRoZVxuICAgIC8vIG5ldyBmaWxlLCB3aGVyZSB0aGUgd2F0Y2hlciBmaW5kcyBpdCBhbmQgcHJlc2VydmVzIGl0IHRvby5cbiAgICBjb25zdCBzdGFnZWQgPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS5lZGl0YDtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YWdlZCwgdGV4dCk7XG4gICAgbGV0IHByZXNlcnZlZDogUHJlc2VydmVkVmVyc2lvbiB8IG51bGwgPSBudWxsO1xuICAgIGxldCBvbkRpc2s6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBvbkRpc2sgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgb25EaXNrID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKG9uRGlzayAhPT0gbnVsbCAmJiAhdGhpcy5pc093bldyaXRlKHBhdGgsIG9uRGlzaykpXG4gICAgICBwcmVzZXJ2ZWQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCBvbkRpc2spO1xuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICByZW5hbWVTeW5jKHN0YWdlZCwgcGF0aCk7XG4gICAgdGhpcy5jb250ZW50Q2hhbmdlZChwYXRoLCB0ZXh0KTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gICAgcmV0dXJuIHsgZGlydHlDaGFuZ2VkOiBiZWZvcmUgIT09IHRoaXMuaXNEaXJ0eShkKSwgcHJlc2VydmVkIH07XG4gIH1cblxuICAvKipcbiAgICogQ29weSBhIHZlcnNpb24gdG8gYSBuZXcgZmlsZTsgdGhlIGFnZW50IHRoZW4gZWRpdHMgdGhhdCBmaWxlIHdpdGggaXRzIG93blxuICAgKiB0b29scy4gV2l0aCBgdGV4dGAgKCMxMTcsIGB2ZXJzaW9uLW5ldyAtLWJvZHktZmlsZWApIHRoZSBuZXcgZmlsZSBob2xkc1xuICAgKiB0aGF0IHRleHQgaW5zdGVhZCwgd3JpdHRlbiBiZWZvcmUgYW55b25lIGlzIHRvbGQgdGhlIHZlcnNpb24gZXhpc3RzIOKAlCBzb1xuICAgKiB0aGVyZSBpcyBubyBtb21lbnQgaW4gd2hpY2ggYW4gdW53cml0dGVuIGNvcHkgY2FuIGJlIGFjdGl2YXRlZC5cbiAgICovXG4gIG5ld1ZlcnNpb24ob3B0czoge1xuICAgIGRvYz86IHN0cmluZztcbiAgICBmcm9tPzogbnVtYmVyO1xuICAgIGxhYmVsPzogc3RyaW5nO1xuICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgYXV0aG9yOiBWZXJzaW9uQXV0aG9yO1xuICB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBWZXJzaW9uO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgZnJvbSA9IG9wdHMuZnJvbSA/PyBkLmFjdGl2ZTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBmcm9tKTtcbiAgICBjb25zdCB0ZXh0ID0gb3B0cy50ZXh0ID8/IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGZyb20pLCBcInV0ZjhcIik7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IG9wdHMuYXV0aG9yLFxuICAgICAgZnJvbSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIC4uLihvcHRzLmxhYmVsID8geyBsYWJlbDogb3B0cy5sYWJlbCB9IDoge30pLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIGlmIChvcHRzLnRleHQgPT09IHVuZGVmaW5lZCAmJiBvcHRzLmF1dGhvciA9PT0gXCJhZ2VudFwiKVxuICAgICAgdGhpcy51bndyaXR0ZW5Db3BpZXMuc2V0KHRoaXMudmVyc2lvblBhdGgoZCwgbiksIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAoRTQxKS5cbiAgICpcbiAgICog4puUIFRIRSBBQ1RJVkUgVkVSU0lPTiBDQU5OT1QgQkUgREVMRVRFRCwgYW5kIHJlZnVzaW5nIGlzIGJldHRlciB0aGFuXG4gICAqIHBpY2tpbmcgYSByZXBsYWNlbWVudDogY2hvb3Npbmcgb25lIGZvciB0aGUgaHVtYW4gd291bGQgc2lsZW50bHkgbW92ZVxuICAgKiB3aGVyZSB0aGVpciBlZGl0cyBhbmQgU2F2ZSBhcmUgcG9pbnRlZCwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBFMiBhbmQgRTdcbiAgICogZXhpc3QgdG8ga2VlcCBleHBsaWNpdC4gQmVjYXVzZSBleGFjdGx5IG9uZSB2ZXJzaW9uIGlzIGFsd2F5cyBhY3RpdmUsIHRoaXNcbiAgICogYWxzbyBtZWFucyB0aGUgbGFzdCB2ZXJzaW9uIGNhbiBuZXZlciBiZSBkZWxldGVkIOKAlCBhIGRvY3VtZW50IGFsd2F5cyBoYXNcbiAgICogc29tZXRoaW5nIHRvIGVkaXQsIHdpdGhvdXQgdGhhdCBiZWluZyBhIHNlY29uZCBydWxlLlxuICAgKlxuICAgKiBgZnJvbWAgcG9pbnRlcnMgb24gT1RIRVIgdmVyc2lvbnMgYXJlIGxlZnQgYXMgdGhleSBhcmUuIFwiTWFkZSBmcm9tIHYyXCJcbiAgICogc3RheXMgdHJ1ZSBhZnRlciB2MiBpcyBnb25lOyBkZWxldGluZyBhIHZlcnNpb24gaXMgbm90IHJld3JpdGluZyB0aGVcbiAgICogaGlzdG9yeSBvZiB0aGUgb25lcyB0aGF0IHJlbWFpbi5cbiAgICovXG4gIGRlbGV0ZVZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgcmVtYWluaW5nOiBudW1iZXI7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCB2ID0gdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBpZiAob3B0cy52ZXJzaW9uID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtvcHRzLnZlcnNpb259IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGFjdGl2YXRlIGFub3RoZXIgb25lIGZpcnN0LCBgICtcbiAgICAgICAgICBgdGhlbiBkZWxldGUgdGhpc2AsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgLy8g4puUIE1BVEVSSUFMSVNFIFRIRSBDT1VOVEVSIEJFRk9SRSBSRU1PVklORyBUSEUgUkVDT1JELiBgdGFrZVZlcnNpb25gXG4gICAgLy8gZGVyaXZlcyBpdCBsYXppbHkgZnJvbSB0aGUgdmVyc2lvbnMgUFJFU0VOVCwgc28gb24gYSBkb2MgdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBhbGxvY2F0ZWQgb25lIChhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSwgcmVzdG9yZWQpIGRlbGV0aW5nIHRoZVxuICAgIC8vIGhpZ2hlc3Qgd291bGQgbGV0IHRoZSBuZXh0IGFsbG9jYXRpb24gZGVyaXZlIHRoZSBzYW1lIG51bWJlciBhZ2Fpbi4gRm91bmRcbiAgICAvLyBieSBkcml2aW5nIGl0LCBub3QgYnkgdGhlIHVuaXQgdGVzdCBhYm92ZSDigJQgd2hpY2ggYWxsb2NhdGVkIGZpcnN0IGFuZCBzb1xuICAgIC8vIG5ldmVyIGhhZCBhIGNvbGQgY291bnRlci5cbiAgICBkLm5leHRWZXJzaW9uID8/PSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgoeCkgPT4geC5uKSkgKyAxO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG9wdHMudmVyc2lvbik7XG4gICAgZC52ZXJzaW9ucyA9IGQudmVyc2lvbnMuZmlsdGVyKCh4KSA9PiB4Lm4gIT09IG9wdHMudmVyc2lvbik7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhwYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRoZSByZWNvcmQgaXMgd2hhdCB0aGUgc2Vzc2lvbiBiZWxpZXZlczsgYSBmaWxlIGFscmVhZHkgZ29uZSAoYSBoYW5kXG4gICAgICAvLyB0aWR5LCBhIGNyYXNoIGJldHdlZW4gd3JpdGUgYW5kIHJlY29yZCkgbXVzdCBub3QgYmxvY2sgcmVtb3ZpbmcgaXQuXG4gICAgfVxuICAgIHRoaXMub3duZWQuZGVsZXRlKHBhdGgpO1xuICAgIHRoaXMudW53cml0dGVuQ29waWVzLmRlbGV0ZShwYXRoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogb3B0cy52ZXJzaW9uLFxuICAgICAgLi4uKHYubGFiZWwgPyB7IGxhYmVsOiB2LmxhYmVsIH0gOiB7fSksXG4gICAgICByZW1haW5pbmc6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICBhY3RpdmF0ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBieT86IFwiaHVtYW5cIiB8IFwiYWdlbnRcIiB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBwcmV2aW91czogbnVtYmVyO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IGQuYWN0aXZlO1xuICAgIGQuYWN0aXZlID0gb3B0cy52ZXJzaW9uO1xuICAgIC8vIFRoZSBuZXcgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IEFTIElUIElTIE5PVyBpcyB0aGUgYmFzZWxpbmUgdGhlIG5leHRcbiAgICAvLyBjaGVjay1iZWZvcmUtd3JpdGUgY29tcGFyZXMgYWdhaW5zdC5cbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gICAgdGhpcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAvLyAjMTE3OiB0aGUgaHVtYW4gY2hvc2UgYSB2ZXJzaW9uIHRoZSBhZ2VudCBoYXMgbm90IHdyaXR0ZW4geWV0IChpdHMgdGV4dFxuICAgIC8vIGlzIHN0aWxsIHRoZSBjb3B5IGB2ZXJzaW9uLW5ld2AgbWFkZSkuIFRoZSBhZ2VudCdzIHdyaXRlIGlzIGNvbWluZyBhbmRcbiAgICAvLyB3aWxsIGxhbmQgb24gdGhlIGFjdGl2ZSB2ZXJzaW9uOyByZW1lbWJlciB3aHksIHNvIHRoZSBzYWZlZ3VhcmQgY2FuIHNheSBzby5cbiAgICBjb25zdCB1bndyaXR0ZW4gPSB0aGlzLnVud3JpdHRlbkNvcGllcy5nZXQocGF0aCk7XG4gICAgaWYgKG9wdHMuYnkgPT09IFwiaHVtYW5cIiAmJiB1bndyaXR0ZW4gPT09IGNvbnRlbnRIYXNoKHRleHQpKVxuICAgICAgdGhpcy5hY3RpdmF0ZWRVbndyaXR0ZW4uc2V0KGQuc2x1ZywgZC5hY3RpdmUpO1xuICAgIGVsc2UgdGhpcy5hY3RpdmF0ZWRVbndyaXR0ZW4uZGVsZXRlKGQuc2x1Zyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBwcmV2aW91cyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbXBhcmluZyBhbmQgbWVyZ2luZyAoRTM2KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogVGhlIHRleHQgb2Ygb25lIHNpZGUgb2YgYSBjb21wYXJpc29uLiBgXCJvcmlnaW5hbFwiYCBpcyByZWFkIGZyb20gRElTSywgbm90XG4gICAqIGZyb20gYSBjYWNoZTogdGhlIHdob2xlIHBvaW50IG9mIGNvbXBhcmluZyBhZ2FpbnN0IGl0IGlzIHRvIHNlZSB3aGF0IHRoZVxuICAgKiBmaWxlIG9mIHJlY29yZCBhY3R1YWxseSBzYXlzIHJpZ2h0IG5vdywgaW5jbHVkaW5nIGEgY2hhbmdlIHNvbWVvbmUgZWxzZVxuICAgKiBtYWRlIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgb3Blbi5cbiAgICovXG4gIHByaXZhdGUgc2lkZVRleHQoZDogRG9jUmVjb3JkLCBzaWRlOiBEaWZmU2lkZSk6IHN0cmluZyB7XG4gICAgaWYgKHNpZGUgPT09IFwib3JpZ2luYWxcIikgcmV0dXJuIHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgc2lkZSk7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIHNpZGUpLCBcInV0ZjhcIik7XG4gIH1cblxuICAvKiogQ29tcGFyZSB0aGUgQUNUSVZFIHZlcnNpb24gKGxlZnQpIGFnYWluc3QgYW5vdGhlciBzaWRlIChyaWdodCkuICovXG4gIGNvbXBhcmUob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlIH0pOiBEaWZmUGF5bG9hZCB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGlmIChvcHRzLmFnYWluc3QgPT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke2QuYWN0aXZlfSBpcyB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9IOKAlCBjb21wYXJpbmcgaXQgd2l0aCBpdHNlbGYgc2F5cyBub3RoaW5nYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBsZWZ0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCxcbiAgICAgIGRpZmY6IGRpZmZUZXh0KGxlZnQsIHRoaXMuc2lkZVRleHQoZCwgb3B0cy5hZ2FpbnN0KSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIG5hbWVkIGh1bmtzIGZyb20gYGFnYWluc3RgIGludG8gdGhlIGFjdGl2ZSB2ZXJzaW9uLlxuICAgKlxuICAgKiDim5QgVEhFIFdSSVRFIEdPRVMgVEhST1VHSCBgZWRpdGAsIHdoaWNoIGlzIHdoYXQgbWFrZXMgYSBtZXJnZSBvYmV5IGV2ZXJ5XG4gICAqIHJ1bGUgYW4gb3JkaW5hcnkga2V5c3Ryb2tlIG9iZXlzOiBpdCBsYW5kcyBvbiB0aGUgYWN0aXZlIHZlcnNpb24gYW5kIG5ldmVyXG4gICAqIHRoZSBvcmlnaW5hbCAoRTcpLCBhbmQgY2hlY2stYmVmb3JlLXdyaXRlIHByZXNlcnZlcyBhbiBvdXRzaWRlIHdyaXRlIGFzIGFcbiAgICogbmV3IHZlcnNpb24gZmlyc3QgKEUyKS4gQSBtZXJnZSB3cml0aW5nIHRoZSBmaWxlIGRpcmVjdGx5IHdvdWxkIGJlIHRoZSBvbmVcbiAgICogcGF0aCBpbnRvIHRoZSBkb2N1bWVudCB0aGF0IGNvdWxkIHNpbGVudGx5IGNsb2JiZXIgdGhlIGFnZW50LlxuICAgKi9cbiAgbWVyZ2Uob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlOyBodW5rczogbnVtYmVyW10gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogbnVtYmVyO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBhcHBsaWVkOiBudW1iZXI7XG4gICAgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbDtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBheWxvYWQgPSB0aGlzLmNvbXBhcmUoeyBkb2M6IGQuc2x1ZywgYWdhaW5zdDogb3B0cy5hZ2FpbnN0IH0pO1xuICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwYXlsb2FkLmRpZmYuaHVua3MubWFwKChoKSA9PiBoLmlkKSk7XG4gICAgY29uc3QgbWlzc2luZyA9IG9wdHMuaHVua3MuZmlsdGVyKChpZCkgPT4gIWtub3duLmhhcyhpZCkpO1xuICAgIGlmIChtaXNzaW5nLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIGh1bmsgJHttaXNzaW5nLmpvaW4oXCIsIFwiKX0gYWdhaW5zdCAke3NpZGVOYW1lKG9wdHMuYWdhaW5zdCwgZC5uYW1lKX0g4oCUIGAgK1xuICAgICAgICAgIGBpdCBoYXMgJHtrbm93bi5zaXplID09PSAwID8gXCJub25lXCIgOiBgMS4uJHtNYXRoLm1heCguLi5rbm93bil9YH0uIFJ1biBkaWZmIGFnYWluOiBgICtcbiAgICAgICAgICBgdGhlIHRleHQgY2hhbmdlZCB1bmRlciB0aGUgbnVtYmVycy5gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHRleHQgPSBhcHBseUh1bmtzKGJlZm9yZSwgcGF5bG9hZC5kaWZmLmh1bmtzLCBvcHRzLmh1bmtzKTtcbiAgICBjb25zdCB7IHByZXNlcnZlZCB9ID0gdGhpcy5lZGl0KGQuc2x1ZywgZC5hY3RpdmUsIHRleHQpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIHRleHQsXG4gICAgICBhcHBsaWVkOiBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+IGtub3duLmhhcyhpZCkpLmxlbmd0aCxcbiAgICAgIHByZXNlcnZlZCxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIG5vdGVzIChFNDUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBUaGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IGV2ZXJ5IG5vdGUgaXMgYW5jaG9yZWQgYWdhaW5zdC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVUZXh0KGQ6IERvY1JlY29yZCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIFBsYWNlIGV2ZXJ5IG5vdGUgaW4gdGhlIGFjdGl2ZSB0ZXh0IGFzIGl0IHN0YW5kcyBub3cuICovXG4gIHByaXZhdGUgcGxhY2VkTm90ZXMoZDogRG9jUmVjb3JkKTogUGxhY2VkTm90ZVtdIHtcbiAgICBjb25zdCBub3RlcyA9IGQubm90ZXMgPz8gW107XG4gICAgaWYgKG5vdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmFjdGl2ZVRleHQoZCk7XG4gICAgcmV0dXJuIG5vdGVzLm1hcCgobikgPT4gKHsgLi4ubiwgLi4uZmluZEFuY2hvcih0ZXh0LCBuKSB9KSk7XG4gIH1cblxuICAvKipcbiAgICogTm90ZSBhIHJhbmdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgKHRoZSBodW1hbiBzZWxlY3RzKSBvciBhIHF1b3RlXG4gICAqIGZvdW5kIGluIGl0ICh0aGUgYWdlbnQgcXVvdGVzIOKAlCBpdCBoYXMgbm8gb2Zmc2V0cykuXG4gICAqL1xuICBhZGROb3RlKG9wdHM6IHtcbiAgICBkb2M/OiBzdHJpbmc7XG4gICAgYm9keTogc3RyaW5nO1xuICAgIHdobzogVmVyc2lvbkF1dGhvcjtcbiAgICByYW5nZT86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07XG4gICAgcXVvdGU/OiBzdHJpbmc7XG4gIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZTsgaG93OiBcInNlbGVjdGlvblwiIHwgXCJxdW90ZVwiIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBib2R5ID0gb3B0cy5ib2R5LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIG5vdGUgbmVlZHMgc29tZXRoaW5nIHdyaXR0ZW4gaW4gaXRcIiwgNDAwKTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuXG4gICAgbGV0IGFuY2hvcjogQW5jaG9yO1xuICAgIGlmIChvcHRzLnJhbmdlKSB7XG4gICAgICBjb25zdCB7IGZyb20sIHRvIH0gPSBvcHRzLnJhbmdlO1xuICAgICAgaWYgKGZyb20gPCAwIHx8IHRvID4gdGV4dC5sZW5ndGggfHwgZnJvbSA+PSB0bylcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgJHtmcm9tfS4uJHt0b30gaXMgbm90IGEgcmFuZ2UgaW4gdiR7ZC5hY3RpdmV9IG9mICR7ZC5zbHVnfSAoJHt0ZXh0Lmxlbmd0aH0gY2hhcmFjdGVycylgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGZyb20sIHRvKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcXVvdGUgPSBvcHRzLnF1b3RlID8/IFwiXCI7XG4gICAgICBpZiAoIXF1b3RlKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIGEgc2VsZWN0aW9uIG9yIGEgcXVvdGVcIiwgNDAwKTtcbiAgICAgIGNvbnN0IGF0ID0gdGV4dC5pbmRleE9mKHF1b3RlKTtcbiAgICAgIC8vIOKblCBSRUZVU0VELCBub3QgYW5jaG9yZWQgaG9wZWZ1bGx5LiBBIHF1b3RlIHRoZSBhY3RpdmUgdmVyc2lvbiBkb2VzIG5vdFxuICAgICAgLy8gY29udGFpbiB3b3VsZCBiZWNvbWUgYW4gb3JwaGFuIHRoZSBtb21lbnQgaXQgd2FzIG1hZGUsIHdoaWNoIHJlYWRzIGFzXG4gICAgICAvLyBcInRoZSB0ZXh0IGNoYW5nZWRcIiB3aGVuIHRoZSB0cnV0aCBpcyBcInlvdSBxdW90ZWQgc29tZXRoaW5nIGVsc2VcIi5cbiAgICAgIGlmIChhdCA9PT0gLTEpXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gZG9lcyBub3QgY29udGFpbiB0aGF0IHRleHQg4oCUIHF1b3RlIGl0IGV4YWN0bHkgYXMgaXQgYXBwZWFyc2AsXG4gICAgICAgICAgNDA0LFxuICAgICAgICApO1xuICAgICAgYW5jaG9yID0gYW5jaG9yT2YodGV4dCwgYXQsIGF0ICsgcXVvdGUubGVuZ3RoKTtcbiAgICB9XG5cbiAgICBjb25zdCBub3RlOiBOb3RlID0ge1xuICAgICAgaWQ6IGBuJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDYpfWAsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIC4uLmFuY2hvcixcbiAgICAgIGJvZHksXG4gICAgICB3aG86IG9wdHMud2hvLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgcmVzb2x2ZWQ6IGZhbHNlLFxuICAgIH07XG4gICAgZC5ub3RlcyA9IFsuLi4oZC5ub3RlcyA/PyBbXSksIG5vdGVdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSwgaG93OiBvcHRzLnJhbmdlID8gXCJzZWxlY3Rpb25cIiA6IFwicXVvdGVcIiB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRvY3VtZW50J3Mgbm90ZXMgYXMgU1RPUkVEIOKAlCBubyBwbGFjZW1lbnQsIHNvIG5vIGZpbGUgcmVhZHMuIEU2NSdzXG4gICAqIGF0dGVudGlvbiB0aWNrIGFza3MgdGhpcyBldmVyeSBzZWNvbmQ7IGB2aWV3KClgIHdvdWxkIHJlLXBsYWNlIGV2ZXJ5IG5vdGUuXG4gICAqL1xuICBub3RlRmFjdHMoKTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiByZWFkb25seSBOb3RlW10gfVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmRvY3MubWFwKChkKSA9PiAoeyBzbHVnOiBkLnNsdWcsIG5vdGVzOiBkLm5vdGVzID8/IFtdIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgbGluZXMgYSBub3RlIGNvdmVycyBpbiB0aGUgYWN0aXZlIHZlcnNpb24gbm93IChFNjUpLCBvciBudWxsIHdoZW4gaXRzXG4gICAqIHRleHQgaXMgZ29uZS4gUGxhY2VkLCBub3QgcmVtZW1iZXJlZCwgZm9yIHRoZSByZWFzb24gbm90ZXMgYXJlIChFNDUpLlxuICAgKi9cbiAgbm90ZUxpbmVzKGRvYzogc3RyaW5nLCBub3RlOiBOb3RlKTogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfSB8IG51bGwge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKGRvYyk7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcbiAgICBjb25zdCBhdCA9IGZpbmRBbmNob3IodGV4dCwgbm90ZSk7XG4gICAgcmV0dXJuIGF0LmZyb20gPT09IG51bGwgPyBudWxsIDogbGluZXNPZih0ZXh0LCBhdC5mcm9tLCBhdC50byk7XG4gIH1cblxuICAvKiogTm90ZXMgb24gYSBkb2N1bWVudCwgcGxhY2VkIOKAlCBgYWxsYCBpbmNsdWRlcyB0aGUgcmVzb2x2ZWQgb25lcy4gKi9cbiAgbm90ZXNPZihvcHRzOiB7IGRvYz86IHN0cmluZzsgYWxsPzogYm9vbGVhbiB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiBQbGFjZWROb3RlW10gfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBsYWNlZCA9IHRoaXMucGxhY2VkTm90ZXMoZCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3Rlczogb3B0cy5hbGwgPyBwbGFjZWQgOiBwbGFjZWQuZmlsdGVyKChuKSA9PiAhbi5yZXNvbHZlZCkgfTtcbiAgfVxuXG4gIHByaXZhdGUgbm90ZU9yRGllKGQ6IERvY1JlY29yZCwgaWQ6IHN0cmluZyk6IE5vdGUge1xuICAgIGNvbnN0IG5vdGUgPSAoZC5ub3RlcyA/PyBbXSkuZmluZCgobikgPT4gbi5pZCA9PT0gaWQpO1xuICAgIGlmICghbm90ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIG5vdGUgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIChkLm5vdGVzID8/IFtdKS5tYXAoKG4pID0+IG4uaWQpLFxuICAgICAgKTtcbiAgICByZXR1cm4gbm90ZTtcbiAgfVxuXG4gIC8qKiBDaGFuZ2Ugd2hhdCBhIG5vdGUgU0FZUy4gSXRzIGFuY2hvciBpcyB1bnRvdWNoZWQg4oCUIGl0IGlzIHN0aWxsIGFib3V0IHRoZVxuICAgKiAgc2FtZSBwYXNzYWdlLCB3aGljaCBpcyB3aHkgZWRpdGluZyBkb2VzIG5vdCByZS1xdW90ZSAoRTQ2KS4gKi9cbiAgZWRpdE5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmc7IGJvZHk6IHN0cmluZzsgd2hvOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIG5vdGU6IE5vdGU7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgbm90ZS5ib2R5ID0gYm9keTtcbiAgICBub3RlLmVkaXRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAvLyBFNjU6IHdob3NlIHJld3JpdGUgaXQgd2FzIGRlY2lkZXMgd2hldGhlciB0aGUgbm90ZSBpcyBvd2VkIGFuIGFuc3dlci5cbiAgICBub3RlLmVkaXRlZEJ5ID0gb3B0cy53aG87XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZXNvbHZlTm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgcmVzb2x2ZWQ6IGJvb2xlYW47IHdobzogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBub3RlOiBOb3RlO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIC8vIEU2NTogYSBSRU9QRU4gaXMgYSB3cml0ZSDigJQgYSBodW1hbiByZW9wZW5pbmcgYXNrcyBhZ2FpbiwgYW5kIHRoZSB3YWl0IGlzXG4gICAgLy8gdGltZWQgZnJvbSBoZXJlOyB0aGUgYWdlbnQgcmVvcGVuaW5nIGlzIGFuIGFjdCBvbiB0aGUgbm90ZS5cbiAgICBpZiAobm90ZS5yZXNvbHZlZCAmJiAhb3B0cy5yZXNvbHZlZCkge1xuICAgICAgbm90ZS5yZW9wZW5lZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIG5vdGUucmVvcGVuZWRCeSA9IG9wdHMud2hvO1xuICAgIH1cbiAgICBub3RlLnJlc29sdmVkID0gb3B0cy5yZXNvbHZlZDtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIHJlbW92ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmcgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgZC5ub3RlcyA9IChkLm5vdGVzID8/IFtdKS5maWx0ZXIoKG4pID0+IG4uaWQgIT09IG9wdHMuaWQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgLyoqIFNhdmU6IHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgb3ZlciB0aGUgb3JpZ2luYWwuIFRoZSBPTkxZIHdyaXRlIHRvIGl0IChFNykuICovXG4gIHNhdmUoc2x1Zzogc3RyaW5nKTogeyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYzogU2F2ZSB3cml0ZXMgb25seSBhbiBvcmlnaW5hbCBhZG1pdHRlZCBieVxuICAgIC8vIGBvcGVuUGF0aGAgKGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5KS4gQ2hlY2tlZCBhZ2FpbiBoZXJlXG4gICAgLy8gc28gbm8gb3RoZXIgcGF0aCBpbnRvIHRoZSBtYW5pZmVzdCDigJQgYSBoYW5kLWVkaXRlZCBvbmUsIGEgZnV0dXJlIHZlcmIg4oCUXG4gICAgLy8gY2FuIHR1cm4gU2F2ZSBpbnRvIFwid3JpdGUgYW55IGZpbGVcIi5cbiAgICBpZiAoIWQuYWRtaXR0ZWQgfHwgIWlzRG9jTmFtZShkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBzYXZlICR7ZC5vcmlnaW5hbH06IGl0IHdhcyBub3Qgb3BlbmVkIGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICB0aGlzLndyaXRlT3duZWQoZC5vcmlnaW5hbCwgdGV4dCk7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgb3JpZ2luYWw6IGQub3JpZ2luYWwsIHZlcnNpb246IGQuYWN0aXZlIH07XG4gIH1cblxuICAvKiogUmV2ZXJ0OiB0aGUgb3JpZ2luYWwncyB0ZXh0IGJhY2sgb3ZlciB0aGUgYWN0aXZlIHZlcnNpb24uICovXG4gIHJldmVydChzbHVnOiBzdHJpbmcpOiB7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIGlmIChuID09PSBkLmFjdGl2ZSkge1xuICAgICAgICAvLyBFMiwgcmVmdXNlZCBhbmQgUkUtTEFCRUxMRUQ6IHRoZSBvdXRzaWRlIHRleHQgYmVjb21lcyBhIG5ldyBhZ2VudFxuICAgICAgICAvLyB2ZXJzaW9uLCBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uIGdvZXMgYmFjayB0byB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICAgICAgLy8gdGV4dCDigJQgc28gdGhlIGFjdGl2ZSB2ZXJzaW9uIG9ubHkgZXZlciBob2xkcyB3aGF0IHRoZSBodW1hbiB0eXBlZCxcbiAgICAgICAgLy8gYW5kIG5vdGhpbmcgYW55b25lIHdyb3RlIGlzIGxvc3QgKHZlcmlmeS1wYXNzIGZpeCA0LCB3YXRjaGVyIGhhbGYpLlxuICAgICAgICBjb25zdCBrZXB0ID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGhpcy5sYXN0QWN0aXZlVGV4dC5nZXQoZC5zbHVnKSA/PyB0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogbixcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgcHJlc2VydmVkQXM6IGtlcHQubixcbiAgICAgICAgICBwcmVzZXJ2ZWRQYXRoOiBrZXB0LnBhdGgsXG4gICAgICAgICAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbjoga2VwdC5hY3RpdmF0ZWRCZWZvcmVXcml0dGVuLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICB0aGlzLnVud3JpdHRlbkNvcGllcy5kZWxldGUoYWJzKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCB0ZXh0LCBhY3RpdmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIOKAlCBieSBpdHMgc3RvcmVkIHBhdGgsIG9yIGJ5IHJlYWxwYXRoIGZvciBhIHN5bWxpbms/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyB8fCByZWFsT3IoeC5vcmlnaW5hbCkgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGQub3V0c2lkZUNoYW5nZWQpIHJldHVybiBudWxsOyAvLyBhbHJlYWR5IGFza2VkXG4gICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBzdHJ1Y3R1cmUgKEUyMuKAk0UyNCk6IHJlYWwgY2hhbmdlcyBvbiBkaXNrLCBvbmUgcGF0aCBmb3IgYm90aCBwYXJ0aWVzIOKUgOKUgFxuICAvL1xuICAvLyBFdmVyeSBtZXRob2QgYmVsb3cgZG9lcyB0aGUgY2hhbmdlIE9OIERJU0sgYW5kIHRoZW4gYnJpbmdzIHRoZSBjb250ZXh0XG4gIC8vIG1vZGVsIGJhY2sgaW4gbGluZSB3aXRoIGl0LiBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZW0gdGhyb3VnaCBtZW51cyBhbmRcbiAgLy8gZHJhZyBhbmQgZHJvcCwgdGhlIGFnZW50IHRocm91Z2ggQ0xJIHZlcmJzOyB0aGUgZGFlbW9uIGFubm91bmNlcyBlYWNoIG9uZVxuICAvLyB1bmRlciB0aGUgbmFtZSBvZiB3aG9ldmVyIGRpZCBpdC4gVHdvIHJ1bGVzIGhvbGQgdGhyb3VnaG91dDpcbiAgLy9cbiAgLy8gLSBOT1RISU5HIElTIERFTEVURUQuIGBoaWRlYCB0YWtlcyBhIG5vZGUgb3V0IG9mIFNjcmlwdG9yaXVtOyB0aGUgZmlsZSBzdGF5cy5cbiAgLy8gLSBOT1RISU5HIElTIE9WRVJXUklUVEVOLiBBIGRlc3RpbmF0aW9uIHRoYXQgZXhpc3RzIGlzIHJlZnVzZWQgKGFuIGV4cGxpY2l0XG4gIC8vICAgbmFtZSkgb3IgZ2l2ZW4gYSBmcmVlIG5hbWUgKGEgZGVmYXVsdCBvbmUsIGEgZHJvcCk7IGZpbGVzIGFyZSBjcmVhdGVkXG4gIC8vICAgd2l0aCB0aGUgZXhjbHVzaXZlIGZsYWcsIHNvIGEgcmFjZSBjYW5ub3QgY2xvYmJlciBlaXRoZXIuXG5cbiAgLyoqIEUyMzogd2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQuICovXG4gIGdldCB3b3Jrc3BhY2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLndvcmtzcGFjZSA/PyBob21lZGlyKCk7XG4gIH1cblxuICBzZXRXb3Jrc3BhY2UocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzdWNoIGZvbGRlcjogJHthYnN9YCwgNDA0KTtcbiAgICB9XG4gICAgaWYgKCFpc0RpcikgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGhlIHdvcmtzcGFjZSBtdXN0IGJlIGEgZm9sZGVyOiAke2Fic31gLCA0MDApO1xuICAgIHRoaXMubS53b3Jrc3BhY2UgPSBhYnM7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogSG93IGEgcGF0aCByZWFkcyBpbiBhIGNoYXQgbGluZTogYHNldC9yZWxgIGluc2lkZSBhIHNldCwgYSBzaW5nbGVcbiAgICogZG9jdW1lbnQncyBmaWxlIG5hbWUsIGB3b3Jrc3BhY2Uv4oCmYCBpbiB0aGUgd29ya3NwYWNlLCBlbHNlIGB+L+KApmAuXG4gICAqL1xuICBkaXNwbGF5KGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikge1xuICAgICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBlLmxhYmVsO1xuICAgICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkgcmV0dXJuIGAke2UubGFiZWx9LyR7dG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpfWA7XG4gICAgICB9IGVsc2UgaWYgKGUubm9kZXMuc29tZSgobikgPT4gam9pbihlLnJvb3QsIG4ucmVsKSA9PT0gYWJzKSkgcmV0dXJuIGUubGFiZWw7XG4gICAgfVxuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLndvcmtzcGFjZSArIHNlcCkpXG4gICAgICByZXR1cm4gYHdvcmtzcGFjZS8ke3RvUG9zaXgocmVsYXRpdmUodGhpcy53b3Jrc3BhY2UsIGFicykpfWA7XG4gICAgY29uc3QgaG9tZSA9IGhvbWVkaXIoKTtcbiAgICByZXR1cm4gYWJzID09PSBob21lID8gXCJ+XCIgOiBhYnMuc3RhcnRzV2l0aChob21lICsgc2VwKSA/IGB+JHthYnMuc2xpY2UoaG9tZS5sZW5ndGgpfWAgOiBhYnM7XG4gIH1cblxuICAvKipcbiAgICogYGFic2Agc3BlbGxlZCB0aGUgd2F5IHRoZSBjb250ZXh0IHNwZWxscyBpdC4gQSBjYWxsZXIgd2hvc2UgY3dkIGlzIGFcbiAgICogcmVhbHBhdGggKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAqIHBsYWNlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIG5vZGUuXG4gICAqL1xuICBwcml2YXRlIHNwZWxsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5tLmNvbnRleHQuc29tZSgoZSkgPT4gYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmIChyZWFsID09PSByZWFsUm9vdCkgcmV0dXJuIGUucm9vdDtcbiAgICAgIGlmIChyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSByZXR1cm4gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBwcml2YXRlIGlzV29ya3NwYWNlKGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGFicyA9PT0gdGhpcy53b3Jrc3BhY2UgfHwgcmVhbE9yKGFicykgPT09IHJlYWxPcih0aGlzLndvcmtzcGFjZSk7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIGVudHJ5IHRoYXQgY292ZXJzIGBhYnNgIChpdHMgcm9vdCwgb3IgYW55dGhpbmcgdW5kZXIgaXQpLCBpZiBhbnkuICovXG4gIHByaXZhdGUgY292ZXJpbmdFbnRyeShhYnM6IHN0cmluZywgZXhjZXB0Pzogc3RyaW5nKTogQ29udGV4dEVudHJ5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLmlkICE9PSBleGNlcHQgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiZcbiAgICAgICAgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQSBmb2xkZXIgdGhpbmdzIG1heSBiZSBtYWRlIGluIG9yIG1vdmVkIGludG86IGEgbWlycm9yZWQgZW50cnkncyByb290LCBhXG4gICAqIHZpc2libGUgZm9sZGVyIHVuZGVyIG9uZSwgb3IgdGhlIHdvcmtzcGFjZS4gUmV0dXJucyB0aGUgYWJzb2x1dGUgZm9sZGVyO1xuICAgKiByZWZ1c2VzIGFueXRoaW5nIGVsc2Ug4oCUIHRoZSBjb250ZXh0IHN0YXlzIHRoZSB3YXkgaW4gKHZlcmlmeS1wYXNzIGZpeCAxYikuXG4gICAqL1xuICBwcml2YXRlIGRlc3RpbmF0aW9uT3JEaWUocmF3RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdEaXIpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgY29udGludWU7XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBhYnM7XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGU/LmtpbmQgPT09IFwiZ3JvdXBcIikgcmV0dXJuIGFicztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuaXNXb3Jrc3BhY2UoYWJzKSkgcmV0dXJuIHRoaXMud29ya3NwYWNlO1xuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICBgJHthYnN9IGlzIG5vdCBhIGZvbGRlciBpbiB0aGlzIHNlc3Npb24g4oCUIG5hbWUgYSBzZXQsIGEgZm9sZGVyIGluc2lkZSBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UgKCR7dGhpcy53b3Jrc3BhY2V9KWAsXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG9yIGZvbGRlciBzaG93biBpbiB0aGUgY29udGV4dCwgd2l0aCB3aGVyZSBpdCBpcyBzaG93bi4gKi9cbiAgcHJpdmF0ZSBpdGVtT3JEaWUocmF3UGF0aDogc3RyaW5nKToge1xuICAgIGFiczogc3RyaW5nO1xuICAgIGVudHJ5OiBDb250ZXh0RW50cnk7XG4gICAgLyoqIFRoZSB3aG9sZSBlbnRyeSAoYSBzZXQncyBvd24gZm9sZGVyLCBhIGxpc3RlZCBkb2N1bWVudCksIG9yIGEgbm9kZSBpbnNpZGUgYSBzZXQuICovXG4gICAgd2hvbGU6IGJvb2xlYW47XG4gICAgZGlyOiBib29sZWFuO1xuICB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAxICYmIG9ubHk/LmtpbmQgPT09IFwiZG9jXCIgJiYgam9pbihlLnJvb3QsIG9ubHkucmVsKSA9PT0gYWJzKVxuICAgICAgICAgIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IGZhbHNlIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiB0cnVlIH07XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGUpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiBmYWxzZSwgZGlyOiBub2RlLmtpbmQgPT09IFwiZ3JvdXBcIiB9O1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHRgLCA0MDQpO1xuICB9XG5cbiAgLyoqXG4gICAqIGByYXdQYXRoYCBpZiB0aGUgY29udGV4dCBzaG93cyBpdCDigJQgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gYSBzZXQsIGFcbiAgICogbGlzdGVkIGRvY3VtZW50LCBhIHNldCdzIG93biBmb2xkZXIg4oCUIG9yIGl0IGlzIHRoZSB3b3Jrc3BhY2U7IHJlZnVzZWRcbiAgICogb3RoZXJ3aXNlLiBGb3IgYWN0cyB0aGF0IHJlYWNoIG91dHNpZGUgdGhlIHNwZWxsIChyZXZlYWxpbmcgYSBwYXRoIGluIHRoZVxuICAgKiBmaWxlIG1hbmFnZXIpLCBzbyBhIHBhZ2UgY2Fubm90IGFpbSB0aGVtIGF0IGFuIGFyYml0cmFyeSBwYXRoLlxuICAgKi9cbiAgc2hvd25QYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBpZiAodGhpcy5pdGVtQXQoYWJzKSkgcmV0dXJuIGFicztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdGluYXRpb25PckRpZShhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb25gLCA0MDApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZWZ1c2UgYSBuYW1lIHRoYXQgaXMgbm90IG9uZSBwbGFpbiBmaWxlIG9yIGZvbGRlciBuYW1lLiAqL1xuICBwcml2YXRlIG5hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgICBpZiAoXG4gICAgICBuID09PSBcIlwiIHx8XG4gICAgICBuID09PSBcIi5cIiB8fFxuICAgICAgbiA9PT0gXCIuLlwiIHx8XG4gICAgICBuLnN0YXJ0c1dpdGgoXCIuXCIpIHx8XG4gICAgICAvWy9cXFxcXFwwXS8udGVzdChuKSB8fFxuICAgICAgbi5sZW5ndGggPiAyNTVcbiAgICApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgXCIke25hbWV9XCIgaXMgbm90IGEgdXNhYmxlIG5hbWUg4oCUIG9uZSBwbGFpbiBuYW1lLCBubyBzbGFzaGVzLCBub3Qgc3RhcnRpbmcgd2l0aCBhIGRvdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBuYW1lOiBhIG5hbWUgd2l0aG91dCBhIGRvY3VtZW50IGV4dGVuc2lvbiBnZXRzIGAubWRgLiAqL1xuICBwcml2YXRlIGRvY05hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICByZXR1cm4gaXNEb2NOYW1lKG4pID8gbiA6IGAke259Lm1kYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciBzb21ldGhpbmcgbW92ZWQgb24gZGlzayBmcm9tIGBmcm9tYCB0byBgdG9gLCBicmluZyB0aGUgbW9kZWwgd2l0aCBpdDpcbiAgICogb3BlbmVkIGRvY3VtZW50cyBrZWVwIHRoZWlyIHZlcnNpb25zIHVuZGVyIHRoZSBuZXcgcGF0aCwgZW50cmllcyByb290ZWQgYXRcbiAgICogb3IgaG9sZGluZyB0aGUgbW92ZWQgdGhpbmcgZm9sbG93IGl0LCBhbmQgZXZlcnkgbWlycm9yIGlzIHJlLXJlYWQuIEFuIGVudHJ5XG4gICAqIHRoYXQgbm93IHNpdHMgaW5zaWRlIGFub3RoZXIgc2V0IGlzIGRyb3BwZWQg4oCUIHRoZSBzZXQgc2hvd3MgaXQgYWxyZWFkeS5cbiAgICovXG4gIHByaXZhdGUgZm9sbG93TW92ZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBtb3ZlZCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+XG4gICAgICBwID09PSBmcm9tID8gdG8gOiBwLnN0YXJ0c1dpdGgoZnJvbSArIHNlcCkgPyB0byArIHAuc2xpY2UoZnJvbS5sZW5ndGgpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGQub3JpZ2luYWwpO1xuICAgICAgaWYgKG5vdykge1xuICAgICAgICBkLm9yaWdpbmFsID0gbm93O1xuICAgICAgICBkLm5hbWUgPSBiYXNlbmFtZShub3cpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBkcm9wID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAob25seT8ua2luZCAhPT0gXCJkb2NcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGpvaW4oZS5yb290LCBvbmx5LnJlbCkpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IGRpcm5hbWUobm93KTtcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KTtcbiAgICAgICAgICBlLm5vZGVzID0gW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShub3cpIH1dO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChlLnJvb3QpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IG5vdztcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KSB8fCBub3c7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5tLmNvbnRleHQgPSB0aGlzLm0uY29udGV4dC5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQWZ0ZXIgYSBmaWxlIG9yIGZvbGRlciBsYW5kZWQgYXQgYGFic2A6IHJlLXJlYWQgdGhlIHNldCBpdCBpcyBpbiwgb3IgZ2l2ZSBpdCBhbiBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBhZG9wdE5ldyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHNldCA9IHRoaXMuY292ZXJpbmdFbnRyeShhYnMpO1xuICAgIGlmIChzZXQpIHRoaXMucmVzY2FuKHNldC5pZCk7XG4gICAgZWxzZSB0aGlzLm0uY29udGV4dC5wdXNoKGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBIG5hbWUgaW4gYGRpcmAgdGhhdCBpcyBmcmVlOiBgbmFtZWAsIGVsc2UgYHN0ZW0gMi5leHRgLCBgc3RlbSAzLmV4dGAsIOKApiAqL1xuICBwcml2YXRlIGZyZWVOYW1lKGRpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGlzRGlyOiBib29sZWFuKTogc3RyaW5nIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG5hbWUpKSkgcmV0dXJuIG5hbWU7XG4gICAgY29uc3QgZXh0ID0gaXNEaXIgPyBcIlwiIDogZXh0bmFtZShuYW1lKTtcbiAgICBjb25zdCBzdGVtID0gZXh0ID8gbmFtZS5zbGljZSgwLCAtZXh0Lmxlbmd0aCkgOiBuYW1lO1xuICAgIGZvciAobGV0IGkgPSAyOyA7IGkrKykge1xuICAgICAgY29uc3QgbiA9IGAke3N0ZW19ICR7aX0ke2V4dH1gO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuKSkpIHJldHVybiBuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVmdXNlRXhpc3RpbmcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZXhpc3RzU3luYyhhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGFscmVhZHkgZXhpc3RzIOKAlCBub3RoaW5nIHdhcyBvdmVyd3JpdHRlbmAsIDQwOSk7XG4gIH1cblxuICBjcmVhdGVEb2MocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmaWxlID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIlVudGl0bGVkLm1kXCIsIGZhbHNlKSA6IHRoaXMuZG9jTmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmaWxlKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIFwiXCIsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIGNyZWF0ZUZvbGRlcihyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZvbGRlciA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJOZXcgZm9sZGVyXCIsIHRydWUpIDogdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZvbGRlcik7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIG1rZGlyU3luYyhhYnMpO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjY6IHdoYXQgYSBtb3ZlIFdPVUxEIGRvLCBmb3IgdGhlIGNvbmZpcm1hdGlvbiB0aGUgc3VyZmFjZSBzaG93cyBiZWZvcmVcbiAgICogbW92aW5nIGEgRk9MREVSLiBSZWFkcyBub3RoaW5nIGJ1dCB0aGUgZGlzayBhbmQgcmVmdXNlcyBleGFjdGx5IHdoYXRcbiAgICogYG1vdmVgIHdvdWxkIHJlZnVzZSwgc28gYSBjb25maXJtZWQgbW92ZSBjYW5ub3QgdGhlbiBmYWlsIG9uIGFkbWlzc2lvbi5cbiAgICpcbiAgICogVGhlIGdpdCBoYWxmIGlzIGhlcmUgYmVjYXVzZSBvbmx5IHRoZSBkYWVtb24gY2FuIHNlZSBhIGAuZ2l0YDogYSBmb2xkZXJcbiAgICogZHJhZ2dlZCBvdXQgb2YgYSByZXBvc2l0b3J5IGlzIHRoZSBjYXNlIHdoZXJlIHRoZSBjb25zZXF1ZW5jZSByZWFjaGVzIHBhc3RcbiAgICogc2NyaXB0b3JpdW0gKENvbGUgbW92ZWQgdGhpcyBwcm9qZWN0J3Mgb3duIGRvY3MgZm9sZGVyIGludG8gaGlzIHdvcmtzcGFjZSxcbiAgICogYW5kIGdpdCBzYXcgc2l4IGRlbGV0ZWQgZmlsZXMpLlxuICAgKi9cbiAgbW92ZVBsYW4ocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiBNb3ZlUGxhbiB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgY29uc3QgZnJvbVJlcG8gPSBnaXRSb290T2YoZGlybmFtZShpdGVtLmFicykpO1xuICAgIGNvbnN0IGludG9SZXBvID0gZ2l0Um9vdE9mKGludG8pO1xuICAgIHJldHVybiB7XG4gICAgICBmcm9tOiBpdGVtLmFicyxcbiAgICAgIGludG8sXG4gICAgICBuYW1lOiBiYXNlbmFtZShpdGVtLmFicyksXG4gICAgICBmb2xkZXI6IGl0ZW0uZGlyLFxuICAgICAgZG9jczogaXRlbS5kaXIgPyBjb3VudERvY3MoaXRlbS5hYnMpIDogMSxcbiAgICAgIHJlcG86IGZyb21SZXBvID8gYmFzZW5hbWUoZnJvbVJlcG8pIDogbnVsbCxcbiAgICAgIGxlYXZlc1JlcG86IGZyb21SZXBvICE9PSBudWxsICYmIGZyb21SZXBvICE9PSBpbnRvUmVwbyxcbiAgICB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICAvKipcbiAgICogVGhlIGhpZGRlbiBsaXN0IG9mIHRoZSBlbnRyeSBhIHBhdGggYmVsb25ncyB0bywgQkVGT1JFIGFueXRoaW5nIGNoYW5nZXMgaXRcbiAgICog4oCUIHdoYXQgRTYwIHJlY29yZHMgc28gYSBoaWRlIGNhbiBiZSBwdXQgYmFjayBleGFjdGx5LlxuICAgKi9cbiAgaGlkZGVuQmVmb3JlKHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfSB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgICByZXR1cm4geyBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVsczogWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvKiogVGhlIHNhbWUsIGFkZHJlc3NlZCBieSBlbnRyeSDigJQgd2hhdCBgdW5oaWRlYCBuZWVkcyByZWNvcmRlZC4gKi9cbiAgaGlkZGVuT2ZFbnRyeShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgcmV0dXJuIGUgPyB7IGVudHJ5OiBlLmlkLCByZWxzOiBbLi4uKGUuaGlkZGVuID8/IFtdKV0gfSA6IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSBgcmVsc2AgKEU2MCdzIGludmVyc2Ugb2YgYm90aCBoaWRlXG4gICAqIGFuZCB1bmhpZGUpLiBSZXR1cm5zIHdoYXQgaXQgV0FTLCBzbyB0aGUgY2FsbGVyIGNhbiBidWlsZCB0aGUgb3Bwb3NpdGUgYWN0XG4gICAqIHdpdGhvdXQgcmVhZGluZyBzdGF0ZSBpdCBoYXMgYWxyZWFkeSBjaGFuZ2VkLlxuICAgKi9cbiAgcmVzdG9yZUhpZGRlbihlbnRyeUlkOiBzdHJpbmcsIHJlbHM6IHN0cmluZ1tdKTogeyBlbnRyeTogc3RyaW5nOyB3YXM6IHN0cmluZ1tdIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCB3YXMgPSBbLi4uKGUuaGlkZGVuID8/IFtdKV07XG4gICAgaWYgKHJlbHMubGVuZ3RoID09PSAwKSBkZWxldGUgZS5oaWRkZW47XG4gICAgZWxzZSBlLmhpZGRlbiA9IFsuLi5yZWxzXTtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgd2FzIH07XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlIHNvbWV0aGluZyB0aGlzIHNlc3Npb24gY3JlYXRlZCAoRTYwJ3MgdW5kbyBvZiBhIGNyZWF0aW9uKS5cbiAgICpcbiAgICog4puUIEEgTk9OLUVNUFRZIERJUkVDVE9SWSBJUyBSRUZVU0VELCBhbmQgbm8gZGlhbG9nIGNhbiBhdXRob3Jpc2UgaXQuIFVuZG9cbiAgICogd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdCByZWFjaGVzIHRoYXQgZm9sZGVyJ3NcbiAgICogY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzIHRoZW4gc29tZXRoaW5nIHB1dCB0aGVtIHRoZXJlXG4gICAqIHRoYXQgdGhlIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGEgZGlyZWN0b3J5IFRSRUUgaXMgYVxuICAgKiBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0IG1hZGUuIChDb2xlIHJ1bGVkIHRoZVxuICAgKiBmaWxlIGNhc2UgdGhlIG90aGVyIHdheSDigJQgY29uZmlybWVkLCBub3QgcmVmdXNlZCDigJQgYW5kIHRoaXMgbGltaXQgaXMgdGhlXG4gICAqIGNhcnZlLW91dCBoZSBhY2NlcHRlZC4pXG4gICAqXG4gICAqIOKaoCBJdCBhbHNvIHJlZnVzZXMgYW55dGhpbmcgdGhhdCBpcyBub3Qgd2hlcmUgdGhlIGhpc3Rvcnkgc2FpZCBpdCB3YXM6IGFcbiAgICogcGF0aCB0aGF0IGhhcyBiZWNvbWUgYSBkaXJlY3RvcnksIG9yIGEgZGlyZWN0b3J5IHRoYXQgaGFzIGJlY29tZSBhIGZpbGUsXG4gICAqIG1lYW5zIHRoZSB3b3JsZCBtb3ZlZCBhbmQgdGhlIHJlY29yZGVkIGludmVyc2Ugbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdC5cbiAgICovXG4gIHJlbW92ZUNyZWF0ZWQocmF3UGF0aDogc3RyaW5nLCBkaXI6IGJvb2xlYW4pOiB7IHBhdGg6IHN0cmluZzsgcmVtb3ZlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbHJlYWR5IGdvbmU6IHRoZSB1bmRvIGhhcyBub3RoaW5nIHRvIGRvLCB3aGljaCBpcyBub3QgYW4gZXJyb3IuXG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIHJlbW92ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpICE9PSBkaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoYWJzKX0gaXMgJHtzdC5pc0RpcmVjdG9yeSgpID8gXCJhIGZvbGRlclwiIDogXCJhIGZpbGVcIn0gbm93IOKAlCB0aGUgY2hhbmdlIHRoaXMgd291bGQgdW5kbyBubyBsb25nZXIgZGVzY3JpYmVzIGl0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBpZiAoZGlyKSB7XG4gICAgICBjb25zdCBsZWZ0ID0gcmVhZGRpclN5bmMoYWJzKTtcbiAgICAgIGlmIChsZWZ0Lmxlbmd0aCA+IDApXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzIG5vdCBlbXB0eSAoJHtsZWZ0Lmxlbmd0aH0gaXRlbSR7bGVmdC5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9KSDigJQgbW92ZSB3aGF0IGlzIGluc2lkZSBpdCBvdXQgZmlyc3RgLFxuICAgICAgICAgIDQwOSxcbiAgICAgICAgICBsZWZ0LnNsaWNlKDAsIDEwKSxcbiAgICAgICAgKTtcbiAgICAgIHJtZGlyU3luYyhhYnMpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1bmxpbmtTeW5jKGFicyk7XG4gICAgfVxuICAgIHRoaXMuZm9yZ2V0UGF0aChhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgcmVtb3ZlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5dGhpbmcgd29ydGggbG9va2luZyBhdCBpbiB0aGlzIHNlc3Npb24sIHdpdGggdGhlIHZlcmIgZm9yIGVhY2ggKEU2MikuXG4gICAqXG4gICAqIOKblCBJVCBPTkxZIExPT0tTLiBSZXBhaXJpbmcgd291bGQgbWVhbiBkZWNpZGluZyBmb3IgdGhlIGh1bWFuIHRoYXQgYSBnaG9zdFxuICAgKiBlbnRyeSBpcyBub3Qgd2FudGVkIGJhY2sgYW5kIHRoYXQgdmVyc2lvbnMgaGVsZCBmb3IgYSB2YW5pc2hlZCBmaWxlIGFyZSBub3RcbiAgICogd29ydGggc2F2aW5nIOKAlCBib3RoIG9mIHdoaWNoIGFyZSB0aGVpcnMgdG8gZGVjaWRlIChDb2xlOiBcInJlcG9ydCwgbmFtZSB0aGVcbiAgICogdmVyYiwgbGV0IHlvdSBkZWNpZGVcIikuXG4gICAqXG4gICAqIOKaoCBgZXhpc3RzU3luY2AgcGVyIGRvY3VtZW50IGFuZCBwZXIgbm9kZSwgd2hpY2ggaXMgdGhlIG9uZSBjb3N0IGhlcmUuIEl0IGlzXG4gICAqIGJvdW5kZWQgYnkgdGhlIGNvbnRleHQgdGhlIGh1bWFuIGNob3NlIGFuZCBydW5zIG9uIGRlbWFuZCBwbHVzIG9uY2UgYXRcbiAgICogc3RhcnR1cCwgbm90IG9uIGEgdGltZXIuXG4gICAqL1xuICBjaGVja3VwKCk6IEZpbmRpbmdbXSB7XG4gICAgY29uc3Qgbm9kZXM6IHsgZW50cnk6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBzaG93bjogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfVtdID0gW107XG4gICAgY29uc3QgbGlua3M6IHtcbiAgICAgIGVudHJ5OiBzdHJpbmc7XG4gICAgICBsYWJlbDogc3RyaW5nO1xuICAgICAgZGFuZ2xpbmc6IG51bWJlcjtcbiAgICAgIHVuc3VwcG9ydGVkOiBudW1iZXI7XG4gICAgICBzY2hlbWVzOiBzdHJpbmdbXTtcbiAgICB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgbm9kZXMucHVzaCh7IGVudHJ5OiBlLmlkLCBwYXRoOiBwLCBzaG93bjogdGhpcy5kaXNwbGF5KHApLCBleGlzdHM6IGV4aXN0c1N5bmMocCkgfSk7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZS5pZCk7XG4gICAgICAgIGlmIChnLmRhbmdsaW5nID4gMCB8fCBnLnVuc3VwcG9ydGVkLmxlbmd0aCA+IDApXG4gICAgICAgICAgbGlua3MucHVzaCh7XG4gICAgICAgICAgICBlbnRyeTogZS5pZCxcbiAgICAgICAgICAgIGxhYmVsOiBlLmxhYmVsID8/IGJhc2VuYW1lKGUucm9vdCksXG4gICAgICAgICAgICBkYW5nbGluZzogZy5kYW5nbGluZyxcbiAgICAgICAgICAgIHVuc3VwcG9ydGVkOiBnLnVuc3VwcG9ydGVkLmxlbmd0aCxcbiAgICAgICAgICAgIHNjaGVtZXM6IFsuLi5uZXcgU2V0KGcudW5zdXBwb3J0ZWQubWFwKCh1KSA9PiB1LnNjaGVtZSkpXSxcbiAgICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBBIHNldCB0aGF0IGNhbm5vdCBiZSBtYXBwZWQgaXMgbm90IGEgZmluZGluZyBhYm91dCBsaW5rcy5cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZpbmRpbmdzKHtcbiAgICAgIGRvY3M6IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gKHtcbiAgICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICBleGlzdHM6IGV4aXN0c1N5bmMoZC5vcmlnaW5hbCksXG4gICAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICAgIH0pKSxcbiAgICAgIG5vZGVzLFxuICAgICAgbGlua3MsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgZG9jdW1lbnQgd2hvc2UgZmlsZSBvZiByZWNvcmQgaXMgZ29uZSAoRTYxKS5cbiAgICpcbiAgICog4puUIFRIRSBXQVJOSU5HIEhBRCBOTyBBTlNXRVIsIFdISUNIIElTIFdIWSBUSElTIEVYSVNUUy4gV2hlbiBhIGRvY3VtZW50J3NcbiAgICogb3JpZ2luYWwgZGlzYXBwZWFycyBiZXR3ZWVuIHNlc3Npb25zLCByZXN0b3JlIHNheXMgc28gb24gcHVycG9zZSDigJQgXCJnb25lXG4gICAqIGZyb20gZGlzayBzaW5jZSB0aGlzIHNlc3Npb24gd2FzIGxhc3Qgb3Blbi4gU2F2ZSB3b3VsZCByZWNyZWF0ZSBpdFwiIOKAlCBhbmRcbiAgICogdGhhdCBpcyB0aGUgUklHSFQgdGhpbmcgdG8gc2F5LCBiZWNhdXNlIHRoZSBzZXNzaW9uIGlzIHN0aWxsIGhvbGRpbmcgdGhlXG4gICAqIGNvbnRlbnQgYW5kIG9mZmVyaW5nIGl0IGJhY2suIFdoYXQgd2FzIG1pc3Npbmcgd2FzIGFueSB3YXkgdG8gcmVwbHkgXCJubywgSVxuICAgKiBtZWFudCB0byBkZWxldGUgdGhhdFwiOiB0aGUgbm90aWNlIHJlcGVhdGVkIG9uIGV2ZXJ5IHJlc3RvcmUgZm9yZXZlciBhbmQgdGhlXG4gICAqIG9ubHkgZXNjYXBlIHdhcyByZWNyZWF0aW5nIHRoZSBzZXNzaW9uLiBBIHdhcm5pbmcgd2l0aCBubyBjb3JyZXNwb25kaW5nIGFjdFxuICAgKiBpcyB0aGUgc2hhcGUgdGhpcyBzcGVsbCBrZWVwcyB0cnlpbmcgbm90IHRvIGhhdmUuXG4gICAqXG4gICAqIOKblCBSRUZVU0VEIFdISUxFIFRIRSBGSUxFIEVYSVNUUywgYW5kIHRoZSByZWZ1c2FsIG5hbWVzIHRoZSByaWdodCB2ZXJiLlxuICAgKiBGb3JnZXR0aW5nIGEgTElWRSBkb2N1bWVudCdzIHJlY29yZCB3b3VsZCB0aHJvdyBhd2F5IGl0cyB2ZXJzaW9uIGhpc3RvcnlcbiAgICogd2hpbGUgdGhlIGRvY3VtZW50IGl0c2VsZiBzaXRzIHRoZXJlIG9uIGRpc2sg4oCUIHRoZSBjb25mdXNpb24gdGhpcyBtdXN0IG5vdFxuICAgKiBlbmFibGUuIFRha2luZyBzb21ldGhpbmcgb3V0IG9mIHRoZSBzaWRlYmFyIGlzIGBoaWRlYDsgdGhpcyBpcyBvbmx5IGZvciBhXG4gICAqIHJlY29yZCB3aG9zZSBzdWJqZWN0IGlzIGdvbmUuXG4gICAqXG4gICAqIOKaoCBUaGUgdmVyc2lvbiBmaWxlcyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIGFyZSBMRUZUIHdoZXJlIHRoZXkgYXJlLCBhc1xuICAgKiB3aXRoIHVuZG8ncyBkZWxldGU6IG5vdGhpbmcgcmVhZHMgdGhlbSBvbmNlIHRoZSByZWNvcmQgaXMgZ29uZSwgYW5kXG4gICAqIHJlbW92aW5nIHRoZW0gd291bGQgYmUgYSBzZWNvbmQgZGVsZXRpb24gbm9ib2R5IGFza2VkIGZvci5cbiAgICovXG4gIGZvcmdldERvYyhyZWY/OiBzdHJpbmcpOiB7IHNsdWc6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uczogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHJlZik7XG4gICAgaWYgKGV4aXN0c1N5bmMoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoZC5vcmlnaW5hbCl9IGlzIHN0aWxsIG9uIGRpc2sg4oCUIGZvcmdldCBpcyBmb3IgYSBkb2N1bWVudCB3aG9zZSBmaWxlIGlzIGdvbmUuIFRvIHRha2UgaXQgb3V0IG9mIHRoZSBjb250ZXh0LCByZW1vdmUgaXQgZnJvbSBTY3JpcHRvcml1bSBpbnN0ZWFkLmAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgZm9yZ290dGVuID0ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5sZW5ndGgsXG4gICAgfTtcbiAgICB0aGlzLm0uZG9jcyA9IHRoaXMubS5kb2NzLmZpbHRlcigoeCkgPT4geC5zbHVnICE9PSBkLnNsdWcpO1xuICAgIGlmICh0aGlzLm0ub3BlbkRvYyA9PT0gZC5zbHVnKSB0aGlzLm0ub3BlbkRvYyA9IHRoaXMubS5kb2NzWzBdPy5zbHVnID8/IG51bGw7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gZm9yZ290dGVuO1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBhIHBhdGggdGhhdCBpcyBubyBsb25nZXIgb24gZGlzazogcHJ1bmUgaXQgZnJvbSBldmVyeSBjb250ZXh0IGVudHJ5LFxuICAgKiBkcm9wIHRoZSBlbnRyeSBpZiB0aGF0IGVtcHRpZXMgaXQsIGFuZCBmb3JnZXQgYW55IGRvY3VtZW50IHJlY29yZCBmb3IgaXQuXG4gICAqXG4gICAqIOKblCBgcmVzY2FuYCBJUyBOT1QgRU5PVUdILCBBTkQgVEhBVCBXQVMgVEhFIEJVRy4gSXQgcmV0dXJucyBlYXJseSBmb3IgYW55XG4gICAqIGVudHJ5IHdob3NlIG1lbWJlcnNoaXAgaXMgbm90IGBtaXJyb3JlZGAg4oCUIGFuZCBhIHNpbmdsZSBkb2N1bWVudCBpcyBhXG4gICAqIGBsaXN0ZWRgIGVudHJ5LCBzbyBkZWxldGluZyBvbmUgbGVmdCBpdHMgbm9kZSBpbiB0aGUgc2lkZWJhciBmb3JldmVyIHdoaWxlXG4gICAqIHRoZSBmaWxlIHdhcyBnb25lIGZyb20gdGhlIGRpc2suIENvbGUgZm91bmQgaXQgd2l0aGluIGEgbWludXRlIG9mIEU2MFxuICAgKiBzaGlwcGluZzogXCJpdCdzIG5vdCBiZWluZyByZW1vdmVkIGZyb20gdGhlIHNpZGViYXLigKYgdGhlbiBJIGNyZWF0ZWQgYW5vdGhlclxuICAgKiBkb2N1bWVudCBhbHNvIHVudGl0bGVkIGFuZCBJIHRoaW5rIHRoZXJlIG1pZ2h0IGhhdmUgYmVlbiBldmVuIGEgd2VpcmRcbiAgICogbmFtaW5nIGlzc3VlXCIuXG4gICAqXG4gICAqIOKaoCBUSEUgTkFNSU5HIE9ERElUWSBXQVMgVEhFIFNFQ09ORCBIQUxGIE9GIFRIRSBTQU1FIEJVRy4gVGhlIGBEb2NSZWNvcmRgXG4gICAqIG91dGxpdmVkIHRoZSBmaWxlIHRvbywgc28gaXRzIFNMVUcgc3RheWVkIHRha2VuIGFuZCB0aGUgbmV4dCBgVW50aXRsZWQubWRgXG4gICAqIGJlY2FtZSBgdW50aXRsZWQtMmAgd2hpbGUgdGhlIGZpbGUgb24gZGlzayB3YXMgcGxhaW4gYFVudGl0bGVkLm1kYC4gQVxuICAgKiByZWNvcmQgZm9yIGEgZG9jdW1lbnQgdGhhdCBkb2VzIG5vdCBleGlzdCBoYXMgbm8gcmVhZGVyOyBpdCBvbmx5IGdldHMgaW5cbiAgICogdGhlIHdheSBvZiB0aGUgbmV4dCBvbmUuXG4gICAqXG4gICAqIOKaoCBUaGUgdmVyc2lvbiBmaWxlcyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIGFyZSBMRUZUIHdoZXJlIHRoZXkgYXJlLiBUaGVcbiAgICogcmVjb3JkIGlzIGdvbmUsIHNvIG5vdGhpbmcgcmVhZHMgdGhlbSwgYW5kIHJlbW92aW5nIHRoZW0gd291bGQgYmUgYSBzZWNvbmRcbiAgICogZGVsZXRpb24gdGhlIGh1bWFuIHdhcyBuZXZlciBhc2tlZCBhYm91dCDigJQgdGhlIGRpYWxvZyBwcm9taXNlZCB0aGUgY3JlYXRlZFxuICAgKiBmaWxlLCBub3QgdGhlIHNlc3Npb24ncyBvd24gY29waWVzLlxuICAgKi9cbiAgcHJpdmF0ZSBmb3JnZXRQYXRoKGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaW5zaWRlID0gKHA6IHN0cmluZykgPT4gcCA9PT0gYWJzIHx8IHAuc3RhcnRzV2l0aChhYnMgKyBzZXApO1xuICAgIGZvciAoY29uc3QgZSBvZiBbLi4udGhpcy5tLmNvbnRleHRdKSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgIWluc2lkZShlLnJvb3QpKSB7XG4gICAgICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIEEgYGxpc3RlZGAgZW50cnkgKG9yIGEgbWlycm9yZWQgb25lIHRoYXQgV0FTIHRoZSBkZWxldGVkIGZvbGRlcik6XG4gICAgICAvLyBwcnVuZSB0aGUgbm9kZXMgYnkgaGFuZCwgc2luY2UgYHJlc2NhbmAgd2lsbCBub3QgbG9vayBhdCBpdC5cbiAgICAgIGNvbnN0IHBydW5lID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKTogQ29udGV4dE5vZGVbXSA9PlxuICAgICAgICBub2Rlc1xuICAgICAgICAgIC5maWx0ZXIoKG4pID0+ICFpbnNpZGUoam9pbihlLnJvb3QsIG4ucmVsKSkpXG4gICAgICAgICAgLm1hcCgobikgPT4gKG4ua2luZCA9PT0gXCJncm91cFwiID8geyAuLi5uLCBjaGlsZHJlbjogcHJ1bmUobi5jaGlsZHJlbikgfSA6IG4pKTtcbiAgICAgIGUubm9kZXMgPSBwcnVuZShlLm5vZGVzKTtcbiAgICAgIGlmIChlLm5vZGVzLmxlbmd0aCA9PT0gMCB8fCBpbnNpZGUoZS5yb290KSkgdGhpcy5yZW1vdmVDb250ZXh0KGUuaWQpO1xuICAgIH1cbiAgICAvLyBBIHJlY29yZCBmb3IgYSBmaWxlIHRoYXQgaXMgZ29uZSBoYXMgbm8gcmVhZGVyLCBhbmQgaXRzIHNsdWcgd291bGRcbiAgICAvLyBvdGhlcndpc2Ugc3RheSB0YWtlbi5cbiAgICB0aGlzLm0uZG9jcyA9IHRoaXMubS5kb2NzLmZpbHRlcigoZCkgPT4gIWluc2lkZShkLm9yaWdpbmFsKSk7XG4gICAgaWYgKHRoaXMubS5vcGVuRG9jICYmICF0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSlcbiAgICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5tLmRvY3NbMF0/LnNsdWcgPz8gbnVsbDtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIHVuaGlkZShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlc3RvcmVkOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHJlc3RvcmVkID0gZS5oaWRkZW4/Lmxlbmd0aCA/PyAwO1xuICAgIGRlbGV0ZSBlLmhpZGRlbjtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBlLmlkLCByZXN0b3JlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEUyMjogYSBzaW5nbGUgZG9jdW1lbnQgYmVjb21lcyBhIHNldCDigJQgYSBmb2xkZXIgbmFtZWQgZm9yIGl0IGJlc2lkZSBpdCwgdGhlXG4gICAqIGRvY3VtZW50IG1vdmVkIGluLCBhbmQgdGhlIGVudHJ5IChzYW1lIGlkKSBub3cgbWlycm9ycyB0aGF0IGZvbGRlci5cbiAgICovXG4gIG1ha2VTZXQocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZvbGRlcjogc3RyaW5nOyBlbnRyeTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS5lbnRyeS5tZW1iZXJzaGlwICE9PSBcImxpc3RlZFwiIHx8IGl0ZW0uZGlyKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaXMgYWxyZWFkeSBpbiBhIHNldCDigJQgbWFrZSBhIGZvbGRlciB0aGVyZSBpbnN0ZWFkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGl0ZW0uYWJzKTtcbiAgICBjb25zdCBzdGVtID0gYmFzZW5hbWUoaXRlbS5hYnMsIGV4dG5hbWUoaXRlbS5hYnMpKSB8fCBcIlVudGl0bGVkXCI7XG4gICAgY29uc3QgZm9sZGVyID0gam9pbihwYXJlbnQsIHRoaXMuZnJlZU5hbWUocGFyZW50LCBzdGVtLCB0cnVlKSk7XG4gICAgbWtkaXJTeW5jKGZvbGRlcik7XG4gICAgY29uc3QgdG8gPSBqb2luKGZvbGRlciwgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgY29uc3QgZSA9IGl0ZW0uZW50cnk7XG4gICAgZS5tZW1iZXJzaGlwID0gXCJtaXJyb3JlZFwiO1xuICAgIGUucm9vdCA9IGZvbGRlcjtcbiAgICBlLmxhYmVsID0gYmFzZW5hbWUoZm9sZGVyKTtcbiAgICBlLm5vZGVzID0gW107XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZvbGRlciwgZW50cnk6IGUuaWQgfTtcbiAgfVxuXG4gIC8qKiBUaGUgbW9zdCB0ZXh0IG9uZSBpbXBvcnQgY2FycmllcyDigJQgYSBkb2N1bWVudCwgbm90IGEgZGF0YSBkdW1wLiAqL1xuICBzdGF0aWMgcmVhZG9ubHkgSU1QT1JUX01BWF9CWVRFUyA9IDggKiAxMDI0ICogMTAyNDtcblxuICAvKipcbiAgICogRTIzJ3MgZHJvcDogYSBDT1BZIG9mIGEgZmlsZSdzIHRleHQsIHdyaXR0ZW4gdW5kZXIgYSBmcmVlIG5hbWUgaW50byBgaW50b2BcbiAgICogKGRlZmF1bHQ6IHRoZSB3b3Jrc3BhY2UpLCB0aGVuIHNob3duIGxpa2UgYW55IG90aGVyIGRvY3VtZW50LlxuICAgKi9cbiAgaW1wb3J0VGV4dChuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgcmF3SW50bz86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGZpbGUgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICBpZiAoIWlzRG9jTmFtZShmaWxlKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBub3QgYSBkb2N1bWVudCBTY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2ZpbGV9YCxcbiAgICAgICAgNDAwLFxuICAgICAgICBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgKTtcbiAgICBpZiAoQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCkgPiBTZXNzaW9uLklNUE9SVF9NQVhfQllURVMpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtmaWxlfSBpcyBsYXJnZXIgdGhhbiAke1Nlc3Npb24uSU1QT1JUX01BWF9CWVRFUyAvIDEwMjQgLyAxMDI0fSBNQiDigJQgbm90IGltcG9ydGVkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byA/PyB0aGlzLndvcmtzcGFjZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIHRoaXMuZnJlZU5hbWUoZGlyLCBmaWxlLCBmYWxzZSkpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB0ZXh0LCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvLyDilIDilIAgY2hhdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvLyDilIDilIAgdGhlIHdvcmsgcXVldWUgKEU1MCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFN0YXJ0IGEgdGFzay4gSXQgaXMgQU5OT1VOQ0VEIGFzIGEgY2hhdCBtZXNzYWdlIGFuZCByZWNvcmRlZCBhcyBhIHRhc2sgYXRcbiAgICogdGhlIHNhbWUgbW9tZW50IOKAlCBDb2xlJ3MgZnJhbWluZywgXCJhIG1lc3NhZ2UgdGhhdCBjYW4gYmUgbWFya2VkIGRvbmVcIiDigJRcbiAgICogc28gdGhlIGNvbnZlcnNhdGlvbiByZWFkcyBhcyBhIG5hcnJhdGl2ZSBhbmQgdGhlIHF1ZXVlIHJlYWRzIGFzIHN0YXRlLFxuICAgKiBvdmVyIG9uZSBmYWN0IHJhdGhlciB0aGFuIHR3by5cbiAgICovXG4gIHN0YXJ0VGFzayh0ZXh0OiBzdHJpbmcsIHdobzogVmVyc2lvbkF1dGhvcik6IFRhc2sge1xuICAgIGNvbnN0IGJvZHkgPSB0ZXh0LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIHRhc2sgbmVlZHMgdG8gc2F5IHdoYXQgdGhlIHdvcmsgaXNcIiwgNDAwKTtcbiAgICBjb25zdCBtZXNzYWdlID0gdGhpcy5hZGRNZXNzYWdlKHdobywgYm9keSk7XG4gICAgY29uc3QgdGFzazogVGFzayA9IHtcbiAgICAgIGlkOiBgdC0ke3JhbmRIZXgoNCl9YCxcbiAgICAgIHRleHQ6IGJvZHksXG4gICAgICB3aG8sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBtZXNzYWdlSWQ6IG1lc3NhZ2UuaWQsXG4gICAgfTtcbiAgICB0aGlzLm0udGFza3MgPSBbLi4uKHRoaXMubS50YXNrcyA/PyBbXSksIHRhc2tdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgcHJpdmF0ZSB0YXNrT3JEaWUoaWQ6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maW5kKCh0KSA9PiB0LmlkID09PSBpZCk7XG4gICAgaWYgKCF0YXNrKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIHRhc2sgJHtpZH0gaW4gdGhpcyBzZXNzaW9uYCxcbiAgICAgICAgNDA0LFxuICAgICAgICAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuZG9uZUF0ID09PSB1bmRlZmluZWQpLm1hcCgodCkgPT4gdC5pZCksXG4gICAgICApO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqIFNheSB3aGF0IGlzIGJlaW5nIGRvbmUgcmlnaHQgbm93IOKAlCBmb3Igd29yayB3aXRoIHN0ZXBzIHdvcnRoIHdhdGNoaW5nLiAqL1xuICBzZXRUYXNrU3RhdHVzKGlkOiBzdHJpbmcsIHN0YXR1czogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICBpZiAodGFzay5kb25lQXQgIT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRhc2sgJHtpZH0gaXMgYWxyZWFkeSBkb25lIOKAlCBpdHMgc3RhdHVzIGNhbm5vdCBjaGFuZ2VgLCA0MDkpO1xuICAgIHRhc2suc3RhdHVzID0gc3RhdHVzLnRyaW0oKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBNYXJrIGl0IGRvbmUuIElkZW1wb3RlbnQgb24gcHVycG9zZTogYSB0YXNrIGZpbmlzaGVkIHR3aWNlIOKAlCBhbiBhZ2VudFxuICAgKiByZXRyeWluZywgYSBodW1hbiBjbGlja2luZyBhcyB0aGUgYWdlbnQgcmVwb3J0cyDigJQgaXMgbm90IGFuIGVycm9yLCBhbmRcbiAgICogcmVmdXNpbmcgd291bGQgbWFrZSB0aGUgc3VyZmFjZSBoYW5kbGUgYSByYWNlIGl0IGRpZCBub3QgY2F1c2UuXG4gICAqL1xuICBmaW5pc2hUYXNrKGlkOiBzdHJpbmcsIG91dGNvbWU/OiBzdHJpbmcpOiB7IHRhc2s6IFRhc2s7IGFscmVhZHk6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICBjb25zdCBhbHJlYWR5ID0gdGFzay5kb25lQXQgIT09IHVuZGVmaW5lZDtcbiAgICBpZiAoIWFscmVhZHkpIHtcbiAgICAgIHRhc2suZG9uZUF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHRhc2suc3RhdHVzID0gdW5kZWZpbmVkO1xuICAgICAgaWYgKG91dGNvbWU/LnRyaW0oKSkgdGFzay5vdXRjb21lID0gb3V0Y29tZS50cmltKCk7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdGFzaywgYWxyZWFkeSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlLiBNYXJraW5nIGl0IGRvbmUgd291bGRcbiAgICogcHV0IGEgdGhpbmcgdGhhdCBuZXZlciBoYXBwZW5lZCBpbnRvIHRoZSByZWNvcmQ7IGEgcXVldWUgeW91IGNhbm5vdCBjbGVhclxuICAgKiBvZiBpdHMgb3duIG1pc3Rha2VzIHN0b3BzIGJlaW5nIGEgdHJ1c3R3b3J0aHkgYWNjb3VudCBvZiB0aGUgd29yay5cbiAgICovXG4gIHJlbW92ZVRhc2soaWQ6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSB0aGlzLnRhc2tPckRpZShpZCk7XG4gICAgdGhpcy5tLnRhc2tzID0gKHRoaXMubS50YXNrcyA/PyBbXSkuZmlsdGVyKCh0KSA9PiB0LmlkICE9PSBpZCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2suIE91dHN0YW5kaW5nIG9uZXMgYXJlIHVudG91Y2hlZCDigJQgY2xlYXJpbmcgaXNcbiAgICogdGlkeWluZyB3aGF0IGlzIE9WRVIsIG5ldmVyIGFiYW5kb25pbmcgd29yayBzdGlsbCBpbiBmbGlnaHQuXG4gICAqL1xuICBjbGVhckRvbmVUYXNrcygpOiBudW1iZXIge1xuICAgIGNvbnN0IGJlZm9yZSA9ICh0aGlzLm0udGFza3MgPz8gW10pLmxlbmd0aDtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuZG9uZUF0ID09PSB1bmRlZmluZWQpO1xuICAgIGNvbnN0IGNsZWFyZWQgPSBiZWZvcmUgLSAodGhpcy5tLnRhc2tzPy5sZW5ndGggPz8gMCk7XG4gICAgaWYgKGNsZWFyZWQgPiAwKSB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gY2xlYXJlZDtcbiAgfVxuXG4gIC8qKiBOZXdlc3QgZmlyc3Qg4oCUIGEgcXVldWUgaXMgcmVhZCBmcm9tIHRoZSB0b3AuICovXG4gIHRhc2tzKCk6IFRhc2tbXSB7XG4gICAgcmV0dXJuIFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKV0uc29ydCgoYSwgYikgPT4gYi5jcmVhdGVkQXQgLSBhLmNyZWF0ZWRBdCk7XG4gIH1cblxuICBhZGRNZXNzYWdlKFxuICAgIHdobzogQ2hhdFdobyxcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgZXh0cmE6IHsgc2VsZWN0aW9uPzogU2VsZWN0aW9uIHwgbnVsbDsgYWN0aXZlUGF0aD86IHN0cmluZyB8IG51bGw7IG5vdGU/OiBOb3RlUmVmIH0gPSB7fSxcbiAgKTogQ2hhdE1lc3NhZ2Uge1xuICAgIGNvbnN0IG1zZzogQ2hhdE1lc3NhZ2UgPSB7IGlkOiBgbS0ke3JhbmRIZXgoNCl9YCwgd2hvLCB0ZXh0LCB0czogRGF0ZS5ub3coKSwgLi4uZXh0cmEgfTtcbiAgICB0aGlzLm0uY2hhdC5wdXNoKG1zZyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCB2aWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQSBkb2N1bWVudCdzIGZyb250bWF0dGVyLCBmcm9tIHRoZSBBQ1RJVkUgdmVyc2lvbidzIHRleHQg4oCUIHdoYXQgdGhlIGh1bWFuXG4gICAqICBpcyByZWFkaW5nLCB3aGljaCBpcyBub3QgYWx3YXlzIHdoYXQgaXMgb24gZGlzayAoRTMyKS4gKi9cbiAgcHJpdmF0ZSBtZXRhT2YoZDogRG9jUmVjb3JkKTogRG9jVmlld1tcIm1ldGFcIl0ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhZE1ldGEocmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgZG9jVmlldyhkOiBEb2NSZWNvcmQpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4ge1xuICAgICAgbWV0YTogdGhpcy5tZXRhT2YoZCksXG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIGVudHJ5SWQ6IGQuZW50cnlJZCxcbiAgICAgIHJlbDogZC5yZWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5tYXAoKHYpID0+ICh7IC4uLnYsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgdi5uKSB9KSksXG4gICAgICBub3RlczogdGhpcy5wbGFjZWROb3RlcyhkKSxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBkaXJ0eTogdGhpcy5pc0RpcnR5KGQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGQub3V0c2lkZUNoYW5nZWQsXG4gICAgfTtcbiAgfVxuXG4gIGRvYyhzbHVnOiBzdHJpbmcpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4gdGhpcy5kb2NWaWV3KHRoaXMuZG9jT3JEaWUoc2x1ZykpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZyb250bWF0dGVyIGZvciBldmVyeSBkb2N1bWVudCBpbiB0aGUgY29udGV4dCwgYnkgcGF0aCAoRTMyKS5cbiAgICpcbiAgICogQ2FjaGVkIGJ5IHBhdGggYW5kIG10aW1lLCBhbmQgcmVhZCBIRUFELUZJUlNUOiBhIGZyb250bWF0dGVyIGJsb2NrIHNpdHMgYXRcbiAgICogdGhlIHRvcCBvZiBhIGZpbGUsIHNvIGEgMzAwIEtCIGRvY3VtZW50IGNvc3RzIDggS0Igb2YgcmVhZC4gVGhlIGNhcCBrZWVwcyBhXG4gICAqIDIsMDAwLW5vZGUgbWlycm9yIGZyb20gbWVhbmluZyAyLDAwMCByZWFkcyBwZXIgc25hcHNob3QsIGFuZCBoaXR0aW5nIGl0IGlzXG4gICAqIFNBSUQgb24gdGhlIHdpcmUgcmF0aGVyIHRoYW4gbGVmdCB0byBsb29rIGxpa2UgZG9jdW1lbnRzIHdpdGhvdXQgYW55LlxuICAgKi9cbiAgcHJpdmF0ZSBtZXRhQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBtdGltZU1zOiBudW1iZXI7IHN1bW1hcnk6IERvY1N1bW1hcnkgfCBudWxsIH0+KCk7XG5cbiAgY29udGV4dE1ldGEoY2FwID0gTUVUQV9TQ0FOX0NBUCk6IHsgbWFwOiBSZWNvcmQ8c3RyaW5nLCBEb2NTdW1tYXJ5PjsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IG1hcDogUmVjb3JkPHN0cmluZywgRG9jU3VtbWFyeT4gPSB7fTtcbiAgICBsZXQgc2VlbiA9IDA7XG4gICAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIHtcbiAgICAgICAgaWYgKHNlZW4gPj0gY2FwKSB7XG4gICAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBzZWVuKys7XG4gICAgICAgIGxldCBtdGltZU1zOiBudW1iZXI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbXRpbWVNcyA9IHN0YXRTeW5jKGFicykubXRpbWVNcztcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaGl0ID0gdGhpcy5tZXRhQ2FjaGUuZ2V0KGFicyk7XG4gICAgICAgIGxldCBzdW1tYXJ5OiBEb2NTdW1tYXJ5IHwgbnVsbDtcbiAgICAgICAgaWYgKGhpdCAmJiBoaXQubXRpbWVNcyA9PT0gbXRpbWVNcykgc3VtbWFyeSA9IGhpdC5zdW1tYXJ5O1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBzdW1tYXJ5ID0gc3VtbWFyaXplKHJlYWRNZXRhKHJlYWRIZWFkKGFicykpKTtcbiAgICAgICAgICB0aGlzLm1ldGFDYWNoZS5zZXQoYWJzLCB7IG10aW1lTXMsIHN1bW1hcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHN1bW1hcnkpIG1hcFthYnNdID0gc3VtbWFyeTtcbiAgICAgIH1cbiAgICAgIGlmICh0cnVuY2F0ZWQpIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4geyBtYXAsIHRydW5jYXRlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIE9uZSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHJlYWQsIG9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQncyAoRTMyKS4gVGhlXG4gICAqIGFnZW50IGdldHMgdGhlIGRhZW1vbidzIHBhcnNlIHJhdGhlciB0aGFuIHJlLXJlYWRpbmcgdGhlIFlBTUwgaXRzZWxmLlxuICAgKi9cbiAgbWV0YUZvcihyYXdQYXRoPzogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGlmIChyYXdQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgICAgY29uc3QgbWV0YSA9IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogYWJzLCBtZXRhLCAuLi4obWV0YSA/IHt9IDogeyBub3RlOiBcIm5vIGZyb250bWF0dGVyIGJsb2NrXCIgfSkgfTtcbiAgICB9XG4gICAgY29uc3Qgb3V0OiB7IHBhdGg6IHN0cmluZzsgbWV0YTogRG9jTWV0YSB8IG51bGwgfVtdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIG91dC5wdXNoKHsgcGF0aDogYWJzLCBtZXRhOiByZWFkTWV0YShyZWFkSGVhZChhYnMpKSB9KTtcbiAgICByZXR1cm4geyBkb2N1bWVudHM6IG91dCwgY291bnQ6IG91dC5sZW5ndGggfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBwZG9jcydzIGBmaW5kYCwgb3ZlciB0aGlzIHNlc3Npb24ncyBjb250ZXh0LiBTYW1lIGZpbHRlciBuYW1lcywgc2FtZVxuICAgKiBBTkRpbmcsIGFuZCB0aGUgc2FtZSBydWxlIHRoYXQgYW4gZW1wdHkgcmVzdWx0IGlzIGFuIEFOU1dFUjogYGNvdW50YCBzYXlzXG4gICAqIGhvdyBtYW55IG1hdGNoZWQsIGFuZCB0aGUgY2FsbGVyIHJlYWRzIHRoYXQgcmF0aGVyIHRoYW4gdGhlIGV4aXQgY29kZS5cbiAgICovXG4gIGZpbmQoZmlsdGVyOiBNZXRhRmlsdGVyKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IG1hdGNoZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkge1xuICAgICAgICBjb25zdCBtZXRhID0gcmVhZE1ldGEocmVhZEhlYWQoYWJzKSk7XG4gICAgICAgIGlmICghbWF0Y2hlc0ZpbHRlcihtZXRhLCBmaWx0ZXIpKSBjb250aW51ZTtcbiAgICAgICAgbWF0Y2hlcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgZW50cnk6IGUuaWQsXG4gICAgICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLihtZXRhPy50aXRsZSA/IHsgdGl0bGU6IG1ldGEudGl0bGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4obWV0YT8uZGVzY3JpcHRpb24gPyB7IGRlc2NyaXB0aW9uOiBtZXRhLmRlc2NyaXB0aW9uIH0gOiB7fSksXG4gICAgICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gbnVsbCxcbiAgICAgICAgICAuLi4obWV0YT8ubGlmZWN5Y2xlID8geyBsaWZlY3ljbGU6IG1ldGEubGlmZWN5Y2xlIH0gOiB7fSksXG4gICAgICAgICAgdGFnczogbWV0YT8udGFncyA/PyBbXSxcbiAgICAgICAgICBkYXRlOiBtZXRhPy5kYXRlID8/IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIHJldHVybiB7IG1hdGNoZXMsIGNvdW50OiBtYXRjaGVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIE9uZSBzZXQncyBtYXAgKEUzMyk6IGl0cyBkb2N1bWVudHMgYXMgbm9kZXMsIGFuZCB0aGUgZm91ciBzb3VyY2VzIG9mIGVkZ2VzXG4gICAqIOKAlCBib2R5IGxpbmtzLCB3aWtpIGxpbmtzLCB0eXBlZCBsaW5rcyBhbmQgZnJvbnRtYXR0ZXIgcmVmZXJlbmNlcy5cbiAgICovXG4gIGdyYXBoRm9yKGVudHJ5SWQ/OiBzdHJpbmcpOiBHcmFwaFBheWxvYWQge1xuICAgIGNvbnN0IGUgPSBlbnRyeUlkXG4gICAgICA/IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpXG4gICAgICA6IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHgubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBlbnRyeUlkID8gYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAgOiBcInRoaXMgc2Vzc2lvbiBoYXMgbm8gc2V0IHRvIG1hcFwiLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHBhdGhzID0gZG9jUGF0aHMoZSk7XG4gICAgY29uc3QgaW5kZXg6IEJ1bmRsZUluZGV4ID0ge1xuICAgICAgcm9vdDogZS5yb290LFxuICAgICAgcGF0aHMsXG4gICAgICBtZXRhT2Y6IChwKSA9PiByZWFkTWV0YShyZWFkSGVhZChwKSksXG4gICAgICBleGlzdHM6IGlzRmlsZUF0LFxuICAgICAgaXNEaXI6IGlzRGlyQXQsXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKGUucm9vdCksXG4gICAgfTtcbiAgICBjb25zdCBnID0gYnVpbGRHcmFwaChpbmRleCwgKHApID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBzcGxpdEZyb250bWF0dGVyKHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikpLmJvZHk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFwiXCI7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIC4uLmcgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZWFyY2ggZXZlcnl0aGluZyBpbiB0aGUgY29udGV4dDogZnV6enkgb3ZlciBuYW1lcywgZXhhY3Qgb3ZlciBjb250ZW50IChFNTkpLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBXSFkgVEhFIFZFUkIgRVhJU1RTIEFUIEFMTCwgYW5kIHRoZSByZWFzb24gaXMgb25lIGxpbmU6IGFcbiAgICogZG9jdW1lbnQgb3BlbiBpbiB0aGUgc2Vzc2lvbiBpcyBzaG93biBhcyBpdHMgQUNUSVZFIFZFUlNJT04sIHdoaWNoIGxpdmVzXG4gICAqIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYW5kIG5vdCBhdCB0aGUgb3JpZ2luYWwgcGF0aC4gQW4gYWdlbnQgZ3JlcHBpbmcgdGhlXG4gICAqIHdvcmtzcGFjZSB0aGVyZWZvcmUgZmluZHMgdGhlIFNBVkVEIGZpbGUgYW5kIHNpbGVudGx5IG1pc3NlcyB0aGUgdGV4dCB0aGVcbiAgICogaHVtYW4gaXMgcmVhZGluZyDigJQgc28gXCJzZWFyY2ggd2hhdCB5b3UgY2FuIHNlZVwiIGlzIGEgcXVlc3Rpb24gb25seSB0aGVcbiAgICogc2Vzc2lvbiBjYW4gYW5zd2VyLiBFdmVyeXRoaW5nIGVsc2UgYWJvdXQgc2VhcmNoaW5nIGZpbGVzLCBhbiBhZ2VudCBjYW5cbiAgICogYWxyZWFkeSBkbyB3aXRoIGdyZXAsIHdoaWNoIGlzIHdoeSB0aGVyZSBpcyBubyBpbi1kb2N1bWVudCB2ZXJiLlxuICAgKlxuICAgKiDimqAgSGlkZGVuIGRvY3VtZW50cyBhcmUgZXhjbHVkZWQsIGJlY2F1c2UgdGhlIGNvbnRleHQgaXMgd2hhdCB0aGUgaHVtYW5cbiAgICogY2hvc2UgdG8gbG9vayBhdDsgYSByZXN1bHQgdGhleSBjYW5ub3Qgc2VlIGluIHRoZSBzaWRlYmFyIHdvdWxkIGJlIGEgcmVzdWx0XG4gICAqIHRoZXkgY2Fubm90IG9wZW4uXG4gICAqL1xuICBzZWFyY2hBbGwob3B0czogeyBxdWVyeTogc3RyaW5nOyBsaW1pdD86IG51bWJlciB9KTogU2VhcmNoUmVwb3J0IHtcbiAgICBjb25zdCBjYW5kaWRhdGVzOiBDYW5kaWRhdGVbXSA9IFtdO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBmb3IgKGNvbnN0IHBhdGggb2YgZG9jUGF0aHMoZW50cnkpKSB7XG4gICAgICAgIGlmIChzZWVuLmhhcyhwYXRoKSkgY29udGludWU7XG4gICAgICAgIHNlZW4uYWRkKHBhdGgpO1xuICAgICAgICBjb25zdCByZWNvcmQgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBwYXRoKTtcbiAgICAgICAgY29uc3QgdGl0bGUgPSByZWFkTWV0YShyZWFkSGVhZChwYXRoKSk/LnRpdGxlO1xuICAgICAgICBjYW5kaWRhdGVzLnB1c2goe1xuICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgbmFtZTogYmFzZW5hbWUocGF0aCksXG4gICAgICAgICAgLi4uKHJlY29yZCA/IHsgc2x1ZzogcmVjb3JkLnNsdWcsIHZlcnNpb246IHJlY29yZC5hY3RpdmUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odGl0bGUgPyB7IHRpdGxlIH0gOiB7fSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gc2VhcmNoRG9jdW1lbnRzKFxuICAgICAgY2FuZGlkYXRlcyxcbiAgICAgIG9wdHMucXVlcnksXG4gICAgICAoYykgPT4ge1xuICAgICAgICAvLyBUaGUgQUNUSVZFIFZFUlNJT04gd2hlbiB0aGUgc2Vzc2lvbiBoYXMgb25lIOKAlCBzZWUgdGhlIG5vdGUgYWJvdmUuXG4gICAgICAgIGNvbnN0IHJlY29yZCA9XG4gICAgICAgICAgYy5zbHVnID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGMuc2x1Zyk7XG4gICAgICAgIGlmIChyZWNvcmQpIHJldHVybiB0aGlzLmFjdGl2ZVRleHQocmVjb3JkKTtcbiAgICAgICAgcmV0dXJuIHJlYWRGaWxlU3luYyhjLnBhdGgsIFwidXRmOFwiKTtcbiAgICAgIH0sXG4gICAgICBvcHRzLmxpbWl0ICE9PSB1bmRlZmluZWQgPyB7IHRvdGFsOiBvcHRzLmxpbWl0IH0gOiB7fSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGxpbmsgaW4gYSBzZXQgdGhhdCBub3RoaW5nIGFuc3dlcnMg4oCUIHRoZSByZXBvcnQgeW91IGNhbiBBQ1Qgb24gKEU1NCkuXG4gICAqXG4gICAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgZ3JhcGhgIEFMUkVBRFkgSEFEIFRIRSBGQUNUUyBBTkQgU1RJTEwgRElEIE5PVCBBTlNXRVJcbiAgICogVEhFIFFVRVNUSU9OLiBDb2xlIGFza2VkIHdoZXRoZXIgYW4gYWdlbnQgY2FuIGNoZWNrIGRhbmdsaW5nIGxpbmtzOyB0aGVcbiAgICogaG9uZXN0IGFuc3dlciB3YXMgXCJ5ZXMsIGJ5IGZldGNoaW5nIGEgc2V0J3Mgd2hvbGUgbWFwIGFuZCBmaWx0ZXJpbmcgc2V2ZXJhbFxuICAgKiBodW5kcmVkIGVkZ2VzXCIsIHdoaWNoIGlzIGEgZGlmZmVyZW50IHRoaW5nIGZyb20gYmVpbmcgYWJsZSB0byBjaGVjayB0aGVtLlxuICAgKiBUaGlzIHNheXMgb25seSB3aGF0IGlzIGJyb2tlbiwgYW5kIHNheXMgaXQgYXMgYGZpbGU6bGluZWAgcGx1cyBUSEUgU1RSSU5HXG4gICAqIFRIRSBET0NVTUVOVCBBQ1RVQUxMWSBDT05UQUlOUyDigJQgd2hpY2ggaXMgd2hhdCB5b3UgbmVlZCB0byByZXBhaXIgb25lLCBhbmRcbiAgICogd2hhdCB0aGUgbWFwJ3MgcmVzb2x2ZWQgYHRvYCBoYWQgcXVpZXRseSB0aHJvd24gYXdheS5cbiAgICpcbiAgICog4pqgIE5PVCBBTiBFUlJPUi4gQSBkYW5nbGluZyBsaW5rIGlzIGEgZmFjdCBhYm91dCBhIHNldCwgbm90IGEgZmFpbHVyZTogT0tGXG4gICAqIMKnMTEncyBydWxlLCBhbmQgaXQgaXMgd2h5IHRoaXMgcmVwb3J0cyBhbmQgZXhpdHMgemVyby4gRG9jdW1lbnRzIHRoYXQgcG9pbnRcbiAgICogYXQgdGhpbmdzIG5vdCB3cml0dGVuIHlldCBhcmUgbm9ybWFsIGluIGEgd29ybGQgYmlibGUuXG4gICAqL1xuICBkYW5nbGluZ0xpbmtzKGVudHJ5SWQ/OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZW50cnlJZCk7XG4gICAgY29uc3QgYnJva2VuID0gZy5lZGdlcy5maWx0ZXIoKGUpID0+IGUuc3RhdGUgPT09IFwibWlzc2luZ1wiKTtcbiAgICAvLyDim5QgQk9EWSBMSU5FUyBCRUNPTUUgRklMRSBMSU5FUyBIRVJFLiBMaW5rcyBhcmUgZXh0cmFjdGVkIGZyb20gdGhlIGJvZHksXG4gICAgLy8gc28gdGhlIG51bWJlciB0aGUgZ3JhcGggY2FycmllcyBpcyBzaG9ydCBieSBob3dldmVyIG11Y2ggZnJvbnRtYXR0ZXIgdGhlXG4gICAgLy8gZG9jdW1lbnQgaGFzIOKAlCBhbmQgYSByZXBvcnQgaXMgZm9yIG9wZW5pbmcgYSBmaWxlIGF0IGEgbGluZS5cbiAgICBjb25zdCBvZmZzZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgICBjb25zdCBvZmZzZXRPZiA9IChwYXRoOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xuICAgICAgY29uc3Qga25vd24gPSBvZmZzZXRzLmdldChwYXRoKTtcbiAgICAgIGlmIChrbm93biAhPT0gdW5kZWZpbmVkKSByZXR1cm4ga25vd247XG4gICAgICBsZXQgb2ZmID0gMDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG9mZiA9IGJvZHlMaW5lT2Zmc2V0KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVucmVhZGFibGUg4oCUIHJlcG9ydCB0aGUgYm9keSBsaW5lIHJhdGhlciB0aGFuIG5vdGhpbmcgKi9cbiAgICAgIH1cbiAgICAgIG9mZnNldHMuc2V0KHBhdGgsIG9mZik7XG4gICAgICByZXR1cm4gb2ZmO1xuICAgIH07XG4gICAgcmV0dXJuIHtcbiAgICAgIGVudHJ5OiBnLmVudHJ5LFxuICAgICAgcm9vdDogZy5yb290LFxuICAgICAgY291bnQ6IGJyb2tlbi5sZW5ndGgsXG4gICAgICAvLyDimqAgS0VQVCBBUEFSVCBGUk9NIGBsaW5rc2AsIEFORCBORVZFUiBDT1VOVEVEIElOIGBjb3VudGAgKCMxMjgpLiBBIGxpbmtcbiAgICAgIC8vIGxpa2UgYG9wOmRvYy88aWQ+YCBuYW1lcyBubyBmaWxlLCBzbyBcIndoZXJlIGl0IGxvb2tlZFwiIHdvdWxkIGJlIGVtcHR5IGFuZFxuICAgICAgLy8gY2FsbGluZyBpdCBtaXNzaW5nIHdvdWxkIG1pc2xlYWQ7IGl0IGlzIGRlYWQgYWxsIHRoZSBzYW1lLCBhbmQgdGhlXG4gICAgICAvLyByZW5kZXJlZCB2aWV3IHN0cmlrZXMgaXQgdGhyb3VnaCwgc28gdGhlIHJlcG9ydCBtdXN0IG5vdCBzdGF5IHNpbGVudC5cbiAgICAgIHVuc3VwcG9ydGVkOiBnLnVuc3VwcG9ydGVkLm1hcCgodSkgPT4gKHtcbiAgICAgICAgZnJvbTogdS5mcm9tLFxuICAgICAgICBsaW5lOiB1LmxpbmUgKyBvZmZzZXRPZih1LmZyb20pLFxuICAgICAgICB3cm90ZTogdS5yYXcsXG4gICAgICAgIHNjaGVtZTogdS5zY2hlbWUsXG4gICAgICAgIC4uLih1LnJlbC5sZW5ndGggPyB7IHJlbDogdS5yZWwgfSA6IHt9KSxcbiAgICAgIH0pKSxcbiAgICAgIGxpbmtzOiBicm9rZW4ubWFwKChlKSA9PiAoe1xuICAgICAgICBmcm9tOiBlLmZyb20sXG4gICAgICAgIC4uLihlLmxpbmUgIT09IHVuZGVmaW5lZCA/IHsgbGluZTogZS5saW5lICsgb2Zmc2V0T2YoZS5mcm9tKSB9IDoge30pLFxuICAgICAgICAvLyBXaGF0IHRoZSBkb2N1bWVudCBzYXlzLCBub3Qgd2hhdCB3ZSBsb29rZWQgZm9yLlxuICAgICAgICAuLi4oZS5yYXcgIT09IHVuZGVmaW5lZCA/IHsgd3JvdGU6IGUucmF3IH0gOiB7fSksXG4gICAgICAgIC8vIFdoZXJlIHRoZSByZXNvbHV0aW9uIGVuZGVkIHVwLCBzbyBhIG5lYXItbWlzcyBpcyB2aXNpYmxlLlxuICAgICAgICB0cmllZDogZS50byxcbiAgICAgICAgc291cmNlOiBlLnNvdXJjZSxcbiAgICAgICAgLi4uKGUua2V5ID8geyBrZXk6IGUua2V5IH0gOiB7fSksXG4gICAgICAgIC4uLihlLnJlbC5sZW5ndGggPyB7IHJlbDogZS5yZWwgfSA6IHt9KSxcbiAgICAgIH0pKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgY2l0ZXMgYSBkb2N1bWVudC4gYHJlbGF0ZWRgIChmcm9udG1hdHRlcikgYW5kIGBsaW5rc2AgKGJvZHkpIGFyZSBrZXB0XG4gICAqIEFQQVJULCB3aGljaCBpcyBob3cgcGRvY3MgcmVwb3J0cyBpdCBhbmQgdGhlIGRpc3RpbmN0aW9uIGlzIHJlYWw6IG9uZSBpcyBhXG4gICAqIGNsYWltIGFib3V0IHRoZSBkb2N1bWVudCwgdGhlIG90aGVyIGEgY2l0YXRpb24gaW4gcHJvc2UuXG4gICAqL1xuICBiYWNrbGlua3MocmF3UGF0aDogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSksXG4gICAgKTtcbiAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IGluc2lkZSBhIHNldCwgc28gbm90aGluZyBtYXBzIGl0YCwgNDAwKTtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeS5pZCk7XG4gICAgY29uc3QgaW5ib3VuZCA9IGcuZWRnZXMuZmlsdGVyKCh4KSA9PiB4LnRvID09PSBhYnMpO1xuICAgIGNvbnN0IHRpdGxlID0gKHA6IHN0cmluZykgPT4gZy5ub2Rlcy5maW5kKChuKSA9PiBuLnBhdGggPT09IHApPy50aXRsZSA/PyBiYXNlbmFtZShwKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGFyZ2V0OiB7IHBhdGg6IGFicywgdGl0bGU6IHRpdGxlKGFicykgfSxcbiAgICAgIHJlbGF0ZWQ6IGluYm91bmRcbiAgICAgICAgLmZpbHRlcigoeCkgPT4geC5zb3VyY2UgPT09IFwiZnJvbnRtYXR0ZXJcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwga2V5OiB4LmtleSB9KSksXG4gICAgICBsaW5rczogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJsaW5rXCIpXG4gICAgICAgIC5tYXAoKHgpID0+ICh7IHBhdGg6IHguZnJvbSwgdGl0bGU6IHRpdGxlKHguZnJvbSksIHJlbDogeC5yZWwgfSkpLFxuICAgICAgY291bnQ6IGluYm91bmQubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogV2hlcmUgZG9lcyB0aGlzIGxpbmsgZ28/IFRoZSBzdXJmYWNlIGFza3MgYmVmb3JlIGZvbGxvd2luZyBvbmUgKEUzMykuXG4gICAqXG4gICAqIGBmcm9tYCBpcyB0aGUgZG9jdW1lbnQgdGhlIGxpbmsgd2FzIHdyaXR0ZW4gaW4sIG9yIGBcImNoYXRcImAgZm9yIGEgbGluayBpblxuICAgKiBhIGNoYXQgbWVzc2FnZSwgd2l0aCBgZG9jYCBuYW1pbmcgdGhlIGRvY3VtZW50IG9wZW4gYXQgdGhlIGNsaWNrIChpZiBhbnkpLlxuICAgKlxuICAgKiDimqAgQSBDSEFUIExJTksgV0FTIE5PVCBXUklUVEVOIEJFU0lERSBUSEUgT1BFTiBET0NVTUVOVCAoIzEyMikuIFRoZSBhZ2VudFxuICAgKiB3cml0ZXMgYC4vbG9jYXRpb25zL3RoZS1nbGFkZS5tZGAgbWVhbmluZyB0aGUgc2V0LCBhbmQgdGhlIGh1bWFuIG1heSBoYXZlXG4gICAqIGFueSBkb2N1bWVudCBvcGVuIHdoZW4gdGhleSBjbGljayBpdC4gUmVhZCBhZ2FpbnN0IHRoYXQgZG9jdW1lbnQncyBmb2xkZXJcbiAgICogYWxvbmUsIHRoZSBzYW1lIG1lc3NhZ2Ugb3BlbmVkIGZyb20gb25lIGRvY3VtZW50IGFuZCB3YXMgbWlzc2luZyBmcm9tXG4gICAqIGFub3RoZXIgKGBsb2NhdGlvbnMvbG9jYXRpb25zL3RoZS1nbGFkZS5tZGApLCBhbmQgd2l0aCBub3RoaW5nIG9wZW4gaXQgZGlkXG4gICAqIG5vdGhpbmcgYXQgYWxsLiBTbyBhIGNoYXQgbGluayB0cmllcyB0aGUgb3BlbiBkb2N1bWVudCdzIGZvbGRlciBhbmQgdGhlblxuICAgKiB0aGUgc2V0J3Mgcm9vdCwgYW5kIHdpdGggbm8gZG9jdW1lbnQgb3BlbiBpdCByZWFkcyBmcm9tIHRoZSBmaXJzdFxuICAgKiBjb250ZXh0IGVudHJ5J3Mgcm9vdC4gQSBsaW5rIHdyaXR0ZW4gaW5zaWRlIGEgZG9jdW1lbnQgc3RpbGwgcmVzb2x2ZXNcbiAgICogYWdhaW5zdCB0aGF0IGRvY3VtZW50J3MgZm9sZGVyIG9ubHkuXG4gICAqL1xuICByZXNvbHZlTGluayhmcm9tOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nLCBkb2M/OiBzdHJpbmcpOiBSZXNvbHV0aW9uIHtcbiAgICBpZiAoZnJvbSAhPT0gXCJjaGF0XCIpIHJldHVybiB0aGlzLnJlc29sdmVGcm9tKHRoaXMuc2hvd25QYXRoKGZyb20pLCB0YXJnZXQpO1xuICAgIGNvbnN0IG9wZW4gPSBkb2MgPyB0aGlzLnNob3duUGF0aChkb2MpIDogbnVsbDtcbiAgICBjb25zdCBmaXJzdCA9IHRoaXMubS5jb250ZXh0WzBdO1xuICAgIC8vIFdpdGggbm8gZG9jdW1lbnQgb3BlbiB0aGVyZSBpcyBubyBmb2xkZXIgdG8gdHJ5IGZpcnN0OiB0aGUgcm9vdCBpcyB0aGVcbiAgICAvLyBmaXJzdCBlbnRyeSdzIChhIHNpbmdsZSBmaWxlJ3MgZW50cnkgaXMgcm9vdGVkIGF0IGl0cyBmb2xkZXIpLCBhbmQgd2l0aFxuICAgIC8vIGFuIGVtcHR5IGNvbnRleHQsIHRoZSB3b3Jrc3BhY2UuXG4gICAgaWYgKCFvcGVuKVxuICAgICAgcmV0dXJuIHRoaXMucmVzb2x2ZUZyb20oXG4gICAgICAgIGpvaW4oZmlyc3Q/LnJvb3QgPz8gdGhpcy53b3Jrc3BhY2UsIENIQVRfT1JJR0lOKSxcbiAgICAgICAgdGFyZ2V0LFxuICAgICAgICBmaXJzdCA/PyBudWxsLFxuICAgICAgKTtcbiAgICBjb25zdCBiZXNpZGVEb2MgPSB0aGlzLnJlc29sdmVGcm9tKG9wZW4sIHRhcmdldCk7XG4gICAgaWYgKGJlc2lkZURvYy5zdGF0ZSA9PT0gXCJpbi1idW5kbGVcIikgcmV0dXJuIGJlc2lkZURvYztcbiAgICAvLyBBIGRvY3VtZW50IG91dHNpZGUgYW55IHNldCByZWFkcyBmcm9tIGl0cyBvd24gZm9sZGVyLCB3aGljaCBpdCBqdXN0IGRpZC5cbiAgICBjb25zdCBlbnRyeSA9IHRoaXMuZW50cnlIb2xkaW5nKG9wZW4pO1xuICAgIGlmICghZW50cnkpIHJldHVybiBiZXNpZGVEb2M7XG4gICAgY29uc3QgZnJvbVJvb3QgPSB0aGlzLnJlc29sdmVGcm9tKGpvaW4oZW50cnkucm9vdCwgQ0hBVF9PUklHSU4pLCB0YXJnZXQsIGVudHJ5KTtcbiAgICBpZiAoZnJvbVJvb3Quc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIHJldHVybiBmcm9tUm9vdDtcbiAgICAvLyBOZWl0aGVyIGxhbmRlZCBpbiB0aGUgc2V0OiB0aGUgb3BlbiBkb2N1bWVudCdzIGZvbGRlciBhbnN3ZXJzIGZpcnN0LCBhc1xuICAgIC8vIHRoZSBkb2N1bWVudCdzIG93biBsaW5rcyB3b3VsZCwgYW5kIHRoZSByb290IG9ubHkgd2hlbiB0aGF0IGZvdW5kIG5vdGhpbmcuXG4gICAgcmV0dXJuIGJlc2lkZURvYy5zdGF0ZSAhPT0gXCJtaXNzaW5nXCIgfHwgZnJvbVJvb3Quc3RhdGUgPT09IFwibWlzc2luZ1wiID8gYmVzaWRlRG9jIDogZnJvbVJvb3Q7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIHNldCBhIHBhdGggc2l0cyBpbiwgaWYgYW55LiAqL1xuICBwcml2YXRlIGVudHJ5SG9sZGluZyhzcmM6IHN0cmluZyk6IENvbnRleHRFbnRyeSB8IG51bGwge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLm0uY29udGV4dC5maW5kKChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiBzcmMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSA/P1xuICAgICAgbnVsbFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogUmVzb2x2ZSBhZ2FpbnN0IHRoZSBzZXQgaG9sZGluZyBgc3JjYCAoYSBkb2N1bWVudCwgb3IgYSBwbGFjZWhvbGRlciBpbiB0aGVcbiAgICogZm9sZGVyIHRvIHJlYWQgZnJvbSkuIGBlbnRyeWAgb3ZlcnJpZGVzIHRoZSBsb29rdXA6IGEgY2hhdCBsaW5rIHdpdGggbm9cbiAgICogZG9jdW1lbnQgb3BlbiByZWFkcyBmcm9tIGEgcm9vdCwgd2hpY2ggbm8gc2V0IFwiaG9sZHNcIi5cbiAgICovXG4gIHByaXZhdGUgcmVzb2x2ZUZyb20oXG4gICAgc3JjOiBzdHJpbmcsXG4gICAgdGFyZ2V0OiBzdHJpbmcsXG4gICAgZW50cnk6IENvbnRleHRFbnRyeSB8IG51bGwgPSB0aGlzLmVudHJ5SG9sZGluZyhzcmMpLFxuICApOiBSZXNvbHV0aW9uIHtcbiAgICBjb25zdCByb290ID0gZW50cnk/LnJvb3QgPz8gZGlybmFtZShzcmMpO1xuICAgIGNvbnN0IHBhdGhzID0gZW50cnkgPyBkb2NQYXRocyhlbnRyeSkgOiBbc3JjXTtcbiAgICByZXR1cm4gcmVzb2x2ZVRhcmdldCh0YXJnZXQsIHNyYywge1xuICAgICAgcm9vdCxcbiAgICAgIHBhdGhzLFxuICAgICAgbWV0YU9mOiAocCkgPT4gcmVhZE1ldGEocmVhZEhlYWQocCkpLFxuICAgICAgZXhpc3RzOiBpc0ZpbGVBdCxcbiAgICAgIGlzRGlyOiBpc0RpckF0LFxuICAgICAgcmVwb1Jvb3Q6IGdpdFJvb3RPZihyb290KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGF0IGEgZnJvbnRtYXR0ZXIgYmxvY2sgZm9yIHRoaXMgZG9jdW1lbnQgV09VTEQgc2F5IChFMzUpLiBTdWdnZXN0ZWQsIG5vdFxuICAgKiB3cml0dGVuOiB0aGUgdHlwZSBjb21lcyBmcm9tIHRoZSBkb2N1bWVudHMgYmVzaWRlIGl0LCB0aGUgdGl0bGUgZnJvbSBpdHNcbiAgICogb3duIEgxLCBhbmQgYGRlc2NyaXB0aW9uYCBpcyBsZWZ0IGJsYW5rIGZvciB3aG9ldmVyIGZpbGxzIGl0IGluLlxuICAgKi9cbiAgc3VnZ2VzdE1ldGEocmF3UGF0aDogc3RyaW5nLCBieT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBibG9jazogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ICE9PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBhbHJlYWR5IGhhcyBmcm9udG1hdHRlcmAsIDQwOSk7XG4gICAgY29uc3QgZm9sZGVyID0gZGlybmFtZShhYnMpO1xuICAgIGNvbnN0IHNpYmxpbmdzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgaWYgKHAgIT09IGFicyAmJiBkaXJuYW1lKHApID09PSBmb2xkZXIpIHtcbiAgICAgICAgICBjb25zdCB0ID0gcmVhZE1ldGEocmVhZEhlYWQocCkpPy50eXBlO1xuICAgICAgICAgIGlmICh0KSBzaWJsaW5ncy5wdXNoKHQpO1xuICAgICAgICB9XG4gICAgY29uc3QgdHlwZSA9IGd1ZXNzVHlwZShzaWJsaW5ncywgYmFzZW5hbWUoZm9sZGVyKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGg6IGFicyxcbiAgICAgIHR5cGUsXG4gICAgICBibG9jazogYnVpbGRCbG9jayh7XG4gICAgICAgIC4uLih0eXBlID8geyB0eXBlIH0gOiB7fSksXG4gICAgICAgIC4uLih0aXRsZUZyb21Cb2R5KHRleHQpID8geyB0aXRsZTogdGl0bGVGcm9tQm9keSh0ZXh0KSBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgLi4uKGJ5ID8geyBieSB9IDoge30pLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSBhIG5ldyBibG9jayBpbnRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAoRTM1KS5cbiAgICpcbiAgICog4puUIFRISVMgV1JJVEVTIFRIRSBPUklHSU5BTCwgd2hpY2ggRTcgb3RoZXJ3aXNlIHJlc2VydmVzIGZvciBTYXZlIOKAlCBhbmRcbiAgICogdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW4gb3ZlcnNpZ2h0OiB0aGUgYWdlbnQncyB2ZXJiIHdyaXRlcyB0aGUgZmlsZSwgYW5kXG4gICAqIGlmIHRoZSBodW1hbiBoYXMgdW5zYXZlZCBlZGl0cyB0byBpdCB0aGUgQ09ORkxJQ1QgQkFSIGFwcGVhcnMgYW5kIHRoZXlcbiAgICogY2hvb3NlIChDb2xlOiBcIndlIGNhbiBhZGp1c3QgaWYgbmVlZGVkIGFmdGVyIGdldHRpbmcgYWN0dWFsIHVzYWdlIGJlaGluZFxuICAgKiB1c1wiKS4gUmVmdXNpbmcgd2hpbGUgYSBidWZmZXIgaXMgZGlydHkgd291bGQgbGV0IGFuIG9wZW4gZG9jdW1lbnQgYmxvY2sgdGhlXG4gICAqIGFnZW50IGluZGVmaW5pdGVseS4gVGhlIEhVTUFOJ3Mgb3duIHBhdGggbmV2ZXIgY29tZXMgaGVyZTogdGhlaXIgXCJhZGRcbiAgICogZnJvbnRtYXR0ZXJcIiBpcyBhbiBlZGl0IHRvIHRoZWlyIGJ1ZmZlciwgd2hpY2ggU2F2ZSB3cml0ZXMgbGlrZSBhbnkgb3RoZXIuXG4gICAqL1xuICBtZXRhSW5pdChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmcgfSA9IHt9KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IHN1Z2dlc3RlZCA9IHRoaXMuc3VnZ2VzdE1ldGEocmF3UGF0aCwgb3B0cy5ieSk7XG4gICAgY29uc3QgYWJzID0gc3VnZ2VzdGVkLnBhdGg7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBjb25zdCBibG9jayA9IG9wdHMudHlwZVxuICAgICAgPyBidWlsZEJsb2NrKHtcbiAgICAgICAgICB0eXBlOiBvcHRzLnR5cGUsXG4gICAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAgIC4uLihvcHRzLmJ5ID8geyBieTogb3B0cy5ieSB9IDoge30pLFxuICAgICAgICB9KVxuICAgICAgOiBzdWdnZXN0ZWQuYmxvY2s7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHdpdGhCbG9jayh0ZXh0LCBibG9jaykpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgdHlwZTogb3B0cy50eXBlID8/IHN1Z2dlc3RlZC50eXBlID8/IG51bGwsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogU2V0IGtleXMgaW4gYW4gZXhpc3RpbmcgYmxvY2sg4oCUIGEgTElORSBlZGl0IGVhY2gsIHNvIG5vdGhpbmcgZWxzZSBtb3Zlcy4gKi9cbiAgbWV0YVNldChyYXdQYXRoOiBzdHJpbmcsIHBhaXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGxldCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGlmIChzcGxpdEZyb250bWF0dGVyKHRleHQpLnJhdyA9PT0gbnVsbClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YmFzZW5hbWUoYWJzKX0gaGFzIG5vIGZyb250bWF0dGVyIOKAlCBhZGQgaXQgZmlyc3QgKG1ldGEtaW5pdClgLCA0MDkpO1xuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBhaXJzKSkge1xuICAgICAgaWYgKCEvXltBLVphLXpfXVtBLVphLXowLTlfLi1dKiQvLnRlc3Qoa2V5KSlcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke2tleX1cIiBpcyBub3QgYSBmcm9udG1hdHRlciBrZXlgLCA0MDApO1xuICAgICAgdGV4dCA9IHNldEtleSh0ZXh0LCBrZXksIHZhbHVlKTtcbiAgICB9XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgc2V0OiBPYmplY3Qua2V5cyhwYWlycykgfTtcbiAgfVxuXG4gIC8qKiBUaGUgc2Vzc2lvbidzIGhhbGYgb2YgYFB1YmxpY1N0YXRlYDsgdGhlIGRhZW1vbiBhZGRzIHRoZSBob21lLWxldmVsIGBwcmVmc2AgYW5kIGB1c2VySG9tZWAuICovXG4gIC8qKlxuICAgKiBUaGUgY29udmVyc2F0aW9uLCB3aXRob3V0IGJ1aWxkaW5nIGEgc25hcHNob3QgYXJvdW5kIGl0LlxuICAgKlxuICAgKiDimqAgRTUzJ3MgYXR0ZW50aW9uIHRpY2sgcnVucyBldmVyeSBzZWNvbmQgYW5kIG9ubHkgbmVlZHMgdGhlIGNoYXQ7IGNhbGxpbmdcbiAgICogYHZpZXcoKWAgZm9yIGl0IHdvdWxkIHJlLXJlYWQgZXZlcnkgZG9jdW1lbnQncyBmcm9udG1hdHRlciBvbiBhIHRpbWVyLlxuICAgKi9cbiAgbWVzc2FnZXMoKTogcmVhZG9ubHkgQ2hhdE1lc3NhZ2VbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jaGF0O1xuICB9XG5cbiAgdmlldyhcbiAgICBtb2RlOiBcImRldlwiIHwgXCJyZWxlYXNlXCIsXG4gICAgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsLFxuICAgIC8vIOKaoCBgd2FpdGluZ2AgaXMgdGhlIFNFUlZFUidzIHRvIGFkZCAoRTUzKTogaXQgZGVwZW5kcyBvbiB0aGUgY2xvY2sgYW5kIG9uXG4gICAgLy8gdGhlIHNub296ZSB0aGUgc2VydmVyIGhvbGRzLCBuZWl0aGVyIG9mIHdoaWNoIGJlbG9uZ3MgaW4gdGhlIHNlc3Npb24uXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBhbmQgYGhpc3RvcnlgIGFyZSB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMsIEU2MCk6IG9uZSBkZXBlbmRzXG4gICAgLy8gb24gdGhlIGNsb2NrIGFuZCB0aGUgc25vb3plIGl0IGhvbGRzLCB0aGUgb3RoZXIgb24gdGhlIGluLW1lbW9yeSBhY3RcbiAgICAvLyBzdGFja3MuIE5laXRoZXIgYmVsb25ncyBpbiB0aGUgc2Vzc2lvbidzIHBlcnNpc3RlZCBzdGF0ZS4gRTY1J3NcbiAgICAvLyBgbm90ZXNXYWl0aW5nYCBpcyB0aGUgc2VydmVyJ3MgZm9yIGB3YWl0aW5nYCdzIHJlYXNvbnMuXG4gICk6IE9taXQ8UHVibGljU3RhdGUsIFwicHJlZnNcIiB8IFwidXNlckhvbWVcIiB8IFwid2FpdGluZ1wiIHwgXCJub3Rlc1dhaXRpbmdcIiB8IFwiaGlzdG9yeVwiPiB7XG4gICAgY29uc3QgbWV0YSA9IHRoaXMuY29udGV4dE1ldGEoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2Vzc2lvbklkOiB0aGlzLm0uc2Vzc2lvbklkLFxuICAgICAgaG9tZTogdGhpcy5ob21lLFxuICAgICAgd29ya3NwYWNlOiB0aGlzLndvcmtzcGFjZSxcbiAgICAgIGRvY01ldGE6IG1ldGEubWFwLFxuICAgICAgLi4uKG1ldGEudHJ1bmNhdGVkID8geyBkb2NNZXRhVHJ1bmNhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICBtb2RlLFxuICAgICAgY29udGV4dDogdGhpcy5tLmNvbnRleHQsXG4gICAgICBkb2NzOiB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IHRoaXMuZG9jVmlldyhkKSksXG4gICAgICBvcGVuRG9jOiB0aGlzLm0ub3BlbkRvYyxcbiAgICAgIHNlbGVjdGlvbixcbiAgICAgIGNoYXQ6IHRoaXMubS5jaGF0LFxuICAgICAgdGFza3M6IHRoaXMudGFza3MoKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogVGhlIGdpdCB3b3JraW5nIHRyZWUgYGRpcmAgaXMgaW4sIG9yIG51bGwuIEEgYC5naXRgIEVOVFJZLCBub3QgYSBkaXJlY3RvcnlcbiAqIHRlc3Q6IGEgd29ya3RyZWUgYW5kIGEgc3VibW9kdWxlIGJvdGggaGF2ZSBgLmdpdGAgYXMgYSBGSUxFLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2l0Um9vdE9mKGRpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGxldCBhdCA9IGRpcjtcbiAgZm9yICg7Oykge1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYXQsIFwiLmdpdFwiKSkpIHJldHVybiBhdDtcbiAgICBjb25zdCB1cCA9IGRpcm5hbWUoYXQpO1xuICAgIGlmICh1cCA9PT0gYXQpIHJldHVybiBudWxsO1xuICAgIGF0ID0gdXA7XG4gIH1cbn1cblxuLyoqIERvY3VtZW50cyB1bmRlciBhIGZvbGRlciwgZm9yIHNheWluZyBob3cgbXVjaCBhIG1vdmUgbW92ZXMuICovXG5mdW5jdGlvbiBjb3VudERvY3MoZGlyOiBzdHJpbmcpOiBudW1iZXIge1xuICBsZXQgbiA9IDA7XG4gIGNvbnN0IHdhbGsgPSAoYXQ6IHN0cmluZykgPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoYXQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oYXQsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkgd2FsayhhYnMpO1xuICAgICAgZWxzZSBpZiAoaXNEb2NOYW1lKG5hbWUpKSBuKys7XG4gICAgfVxuICB9O1xuICB3YWxrKGRpcik7XG4gIHJldHVybiBuO1xufVxuXG4vKipcbiAqIEhvdyBhIGNvbXBhcmlzb24gc2lkZSByZWFkcyBpbiBhIG1lc3NhZ2UgdG8gYSBodW1hbiBvciBhbiBhZ2VudC5cbiAqXG4gKiDim5QgVEhFIEZJTEUgSVMgTkFNRUQsIE5PVCBERVNDUklCRUQgKEU0MywgcmV2aXNlZCkuIFwiVGhlIG9yaWdpbmFsXCIgc291bmRlZFxuICogdGVtcG9yYWwgd2hlbiB0aGUgdGhpbmcgaXMgbG9jYXRpb25hbDsgXCJ0aGUgc2F2ZWQgZmlsZVwiIGZpeGVkIHRoYXQgYnV0IHJlYWRzXG4gKiBjaXJjdWxhciB0aGUgbW9tZW50IGl0IGlzIGEgREVTVElOQVRJT04g4oCUIFwic2F2ZSB0byB0aGUgc2F2ZWQgZmlsZVwiIHNheXNcbiAqIG5vdGhpbmcuIE5vIG5vdW4gZW5jYXBzdWxhdGVzIFwidGhpcyBmaWxlLCBhdCB0aGlzIHBsYWNlXCIsIHNvIHRoZSBmaWxlIGdldHNcbiAqIGl0cyBvd24gbmFtZTogYG5vdGUubWRgLiBDb2xlOiBcInRoYXQncyBwcm9iYWJseSBjbG9zZXIgdG8gdGhlIHJpZ2h0IGFuc3dlclxuICogdmVyc3VzIHRyeWluZyB0byBjb21lIHVwIHdpdGggYSB3b3JkIHRoYXQgZW5jYXBzdWxhdGVzIGl0LlwiXG4gKlxuICogYGZpbGVgIGlzIHRoZSBkb2N1bWVudCdzIG5hbWUgd2hlbiB0aGUgY2FsbGVyIGtub3dzIGl0OyB3aXRob3V0IG9uZSB0aGlzXG4gKiBmYWxscyBiYWNrIHRvIGEgZ2VuZXJpYywgd2hpY2ggaXMgb25seSBmb3IgY29udGV4dHMgdGhhdCBoYXZlIG5vIGRvY3VtZW50IGluXG4gKiBoYW5kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2lkZU5hbWUoc2lkZTogRGlmZlNpZGUsIGZpbGU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoc2lkZSAhPT0gXCJvcmlnaW5hbFwiKSByZXR1cm4gYHYke3NpZGV9YDtcbiAgcmV0dXJuIGZpbGUgPz8gXCJ0aGUgc2F2ZWQgZmlsZVwiO1xufVxuIiwKICAgICIvKipcbiAqIE9LRiBmcm9udG1hdHRlciwgcmVhZCAoRTMyKS4gVGhlIGRhZW1vbiBwYXJzZXM7IHRoZSBzdXJmYWNlIHJlbmRlcnMgd2hhdCBpdFxuICogaXMgZ2l2ZW4g4oCUIGBCdW4uWUFNTC5wYXJzZWAgaXMgaGVyZSwgc28gbm8gWUFNTCBwYXJzZXIgcmVhY2hlcyB0aGUgYnJvd3Nlci5cbiAqXG4gKiDim5QgVEhFIFNQRUMnUyBURU1QRVIgSVMgVEhFIFBPSU5ULCBBTkQgSVQgSVMgTk9UIFRIRSBVU1VBTCBPTkUuIEEgY29uc3VtZXJcbiAqIFwiTVVTVCBOT1QgcmVqZWN0IGRvY3VtZW50c1wiIGZvciB1bmtub3duIHR5cGVzLCB1bmtub3duIGtleXMsIG1pc3Npbmcgb3B0aW9uYWxcbiAqIGZpZWxkcyBvciBicm9rZW4gbGlua3MsIGFuZCBcIlNIT1VMRCBwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4gKiAoT0tGIDAuMiDCpzExKS4gU28gbm90aGluZyBoZXJlIHZhbGlkYXRlczogYSBkb2N1bWVudCB3aG9zZSBmcm9udG1hdHRlciB3aWxsXG4gKiBub3QgcGFyc2Uga2VlcHMgaXRzIHRleHQgYW5kIHJlcG9ydHMgdGhlIHJlYXNvbiwgZXZlcnkga2V5IHN1cnZpdmVzIGluXG4gKiBgZmllbGRzYCB3aGV0aGVyIG9yIG5vdCB0aGlzIHNwZWxsIGhhcyBoZWFyZCBvZiBpdCwgYW5kIGB0eXBlYCDigJQgdGhlIE9ORVxuICogcmVxdWlyZWQgZmllbGQg4oCUIGJlaW5nIGFic2VudCBpcyBhIGZhY3QgdG8gc2hvdywgbmV2ZXIgYW4gZXJyb3IgdG8gcmFpc2UuXG4gKlxuICogVGhlIERFUklWRUQgdmFsdWVzICh0cnVzdCwgc3RhbGVuZXNzKSBhcmUgY29tcHV0ZWQgb24gcmVhZCBhbmQgbmV2ZXIgc3RvcmVkLFxuICogd2hpY2ggaXMgYWxzbyB0aGUgc3BlYydzIHJ1bGU6IGEgdHJ1c3QgdGllciB3cml0dGVuIGludG8gYSBmaWxlIHdvdWxkIGJlIGFcbiAqIGNsYWltIGFib3V0IGl0c2VsZi5cbiAqL1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhLCBEb2NTdW1tYXJ5LCBUcnVzdFRpZXIgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogQSBmcm9udG1hdHRlciBibG9jazogYC0tLWAgb24gaXRzIG93biBmaXJzdCBsaW5lLCB0byB0aGUgbmV4dCBgLS0tYCBsaW5lLiAqL1xuY29uc3QgQkxPQ0sgPSAvXi0tLVxccj9cXG4oW1xcc1xcU10qPylcXHI/XFxuLS0tWyBcXHRdKig/Olxccj9cXG58JCkvO1xuXG4vKipcbiAqIFNwbGl0IGEgZG9jdW1lbnQgaW50byBpdHMgcmF3IGZyb250bWF0dGVyIGJsb2NrIGFuZCB0aGUgYm9keSBiZW5lYXRoIGl0LlxuICogUHVyZSBzdHJpbmcgd29yaywgbm8gWUFNTCDigJQgdGhlIFNVUkZBQ0UgaGFzIHRoZSBzYW1lIGZ1bmN0aW9uIChpdCBtdXN0IHN0cmlwXG4gKiB0aGUgYmxvY2sgYmVmb3JlIHJlbmRlcmluZykgYW5kIGBmcm9udG1hdHRlci50ZXN0LnRzYCBob2xkcyB0aGUgdHdvIGVxdWFsLlxuICovXG4vKipcbiAqIEhvdyBtYW55IGxpbmVzIG9mIGEgZG9jdW1lbnQgY29tZSBCRUZPUkUgaXRzIGJvZHkg4oCUIHRoZSBmcm9udG1hdHRlciBibG9jayBhbmRcbiAqIGl0cyBkZWxpbWl0ZXJzLlxuICpcbiAqIOKblCBXSVRIT1VUIFRISVMgQSBSRVBPUlRFRCBMSU5FIE5VTUJFUiBJUyBBIExJRS4gTGlua3MgYXJlIGV4dHJhY3RlZCBmcm9tIHRoZVxuICogQk9EWSwgc28gYSBsaW5rIG9uIGJvZHkgbGluZSA5IG9mIGEgZG9jdW1lbnQgd2l0aCBmb3VyIGxpbmVzIG9mIGZyb250bWF0dGVyXG4gKiBpcyBvbiBGSUxFIGxpbmUgMTMg4oCUIGFuZCBhIHJlcG9ydCB0aGF0IHNheXMgOSBzZW5kcyB3aG9ldmVyIGlzIGZpeGluZyBpdCB0b1xuICogdGhlIHdyb25nIHBsYWNlLCBjb25maWRlbnRseS4gQ2F1Z2h0IHRoZSBtb21lbnQgRTU0J3MgcmVwb3J0IHdhcyBmaXJzdCByZWFkXG4gKiBhZ2FpbnN0IGEgZG9jdW1lbnQgdGhhdCBoYWQgZnJvbnRtYXR0ZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBib2R5TGluZU9mZnNldCh0ZXh0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB7IGJvZHkgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGNvbnN0IHByZWZpeCA9IHRleHQuc2xpY2UoMCwgdGV4dC5sZW5ndGggLSBib2R5Lmxlbmd0aCk7XG4gIGxldCBsaW5lcyA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcHJlZml4Lmxlbmd0aDsgaSsrKSBpZiAocHJlZml4LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBsaW5lcysrO1xuICByZXR1cm4gbGluZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdEZyb250bWF0dGVyKHRleHQ6IHN0cmluZyk6IHsgcmF3OiBzdHJpbmcgfCBudWxsOyBib2R5OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG0gPSBCTE9DSy5leGVjKHRleHQpO1xuICBpZiAoIW0pIHJldHVybiB7IHJhdzogbnVsbCwgYm9keTogdGV4dCB9O1xuICByZXR1cm4geyByYXc6IG1bMV0gPz8gXCJcIiwgYm9keTogdGV4dC5zbGljZShtWzBdLmxlbmd0aCkgfTtcbn1cblxuLyoqIE9LRidzIHRocmVlLCBhbmQgYW55dGhpbmcgZWxzZSBhIHByb2R1Y2VyIHdyb3RlLiBgc3RhYmxlYCBpcyB0aGUgZGVmYXVsdC4gKi9cbmZ1bmN0aW9uIHN0YXR1c09mKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuICBjb25zdCBzID0gZmllbGRzLnN0YXR1cztcbiAgcmV0dXJuIHR5cGVvZiBzID09PSBcInN0cmluZ1wiICYmIHMudHJpbSgpICE9PSBcIlwiID8gcyA6IFwic3RhYmxlXCI7XG59XG5cbmNvbnN0IGFzTGlzdCA9ICh2OiB1bmtub3duKTogc3RyaW5nW10gPT5cbiAgQXJyYXkuaXNBcnJheSh2KSA/IHYuZmlsdGVyKCh4KSA9PiB0eXBlb2YgeCA9PT0gXCJzdHJpbmdcIikgOiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IFt2XSA6IFtdO1xuXG4vKiogQW4gYWN0b3IgaXMgaHVtYW4gaWZmIGl0IGlzIHNwZWxsZWQgYGh1bWFuOjxpZD5gIOKAlCBPS0YgMC4yIMKnNidzIHJ1bGUuICovXG5jb25zdCBpc0h1bWFuID0gKGFjdG9yOiB1bmtub3duKTogYm9vbGVhbiA9PlxuICB0eXBlb2YgYWN0b3IgPT09IFwic3RyaW5nXCIgJiYgYWN0b3IudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKFwiaHVtYW46XCIpO1xuXG4vKipcbiAqIE9LRidzIHRydXN0IHRpZXJzLCBERVJJVkVEOiBubyBgdmVyaWZpZWRgIOKGkiB1bnZlcmlmaWVkOyB2ZXJpZmllZCBieSBtYWNoaW5lc1xuICogb25seSDihpIgbWFjaGluZS1jb25maXJtZWQ7IHZlcmlmaWVkIGJ5IGEgYGh1bWFuOjxpZD5gIOKGkiBodW1hbi1yZXZpZXdlZC5cbiAqIFRoZSB0aWVyIHN0YXlzIG9uIHRoZSB3aXJlIGZvciBldmVyeSBkb2N1bWVudCAoT0tGJ3MgcnVsZTsgYG1ldGFgIGFuZCBgc3RhdGVgXG4gKiByZWFkZXJzIHNlZSBpdCBiZXNpZGUgYGZpZWxkc2ApLCBidXQgdGhlIHN1cmZhY2UncyBoZWFkZXIgc2hvd3MgaXQgb25seSB3aGVuXG4gKiBgdmVyaWZpZWRgIGlzIHByZXNlbnQ6IFwidW52ZXJpZmllZFwiIGZyb20gYSBtaXNzaW5nIGZpZWxkIGlzIG5vdCBzaG93biAoRTY5KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRydXN0VGllcihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogVHJ1c3RUaWVyIHtcbiAgY29uc3QgdmVyaWZpZWQgPSBmaWVsZHMudmVyaWZpZWQ7XG4gIGNvbnN0IGV2ZW50cyA9IEFycmF5LmlzQXJyYXkodmVyaWZpZWQpID8gdmVyaWZpZWQgOiB2ZXJpZmllZCA/IFt2ZXJpZmllZF0gOiBbXTtcbiAgaWYgKGV2ZW50cy5sZW5ndGggPT09IDApIHJldHVybiBcInVudmVyaWZpZWRcIjtcbiAgZm9yIChjb25zdCBlIG9mIGV2ZW50cylcbiAgICBpZiAoZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBpc0h1bWFuKChlIGFzIHsgYnk/OiB1bmtub3duIH0pLmJ5KSkgcmV0dXJuIFwiaHVtYW4tcmV2aWV3ZWRcIjtcbiAgcmV0dXJuIFwibWFjaGluZS1jb25maXJtZWRcIjtcbn1cblxuLyoqIGBzdGFsZV9hZnRlcmAgaXMgYW4gSU5TVEFOVCwgbm90IGEgVFRMOiBzdGFsZSB3aGVuIG5vdyA+PSBpdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N0YWxlKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG5vdzogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF0ID0gZmllbGRzLnN0YWxlX2FmdGVyO1xuICBjb25zdCB0ID1cbiAgICBhdCBpbnN0YW5jZW9mIERhdGUgPyBhdC5nZXRUaW1lKCkgOiB0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIgPyBEYXRlLnBhcnNlKGF0KSA6IE51bWJlci5OYU47XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgbm93ID49IHQ7XG59XG5cbi8qKiBXaGVuIHRoZSBjb250ZW50IGxhc3QgbWVhbmluZ2Z1bGx5IGNoYW5nZWQsIHBlciBgZ2VuZXJhdGVkLmF0YCwgYXMgYW4gSVNPIGRhdGUuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVkQXQoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBnID0gZmllbGRzLmdlbmVyYXRlZDtcbiAgY29uc3QgYXQgPSBnICYmIHR5cGVvZiBnID09PSBcIm9iamVjdFwiID8gKGcgYXMgeyBhdD86IHVua25vd24gfSkuYXQgOiB1bmRlZmluZWQ7XG4gIGlmIChhdCBpbnN0YW5jZW9mIERhdGUpIHJldHVybiBhdC50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgaWYgKHR5cGVvZiBhdCA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IHQgPSBEYXRlLnBhcnNlKGF0KTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpID8gbmV3IERhdGUodCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCkgOiBhdDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuY29uc3Qgc3RyID0gKHY6IHVua25vd24pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cbiAgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi50cmltKCkgIT09IFwiXCIgPyB2LnRyaW0oKSA6IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBSZWFkIGEgZG9jdW1lbnQncyBmcm9udG1hdHRlci4gUmV0dXJucyBudWxsIHdoZW4gdGhlcmUgaXMgbm8gYmxvY2sgYXQgYWxsIOKAlFxuICogd2hpY2ggaXMgYSBub3JtYWwgZG9jdW1lbnQsIG5vdCBhIGRlZmVjdC4gQSBibG9jayB0aGF0IHdpbGwgbm90IHBhcnNlIGNvbWVzXG4gKiBiYWNrIHdpdGggYGVycm9yYCBzZXQgYW5kIGV2ZXJ5IG90aGVyIGZpZWxkIGVtcHR5OiBzYWlkLCBub3Qgc3dhbGxvd2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZE1ldGEodGV4dDogc3RyaW5nLCBub3cgPSBEYXRlLm5vdygpKTogRG9jTWV0YSB8IG51bGwge1xuICBjb25zdCB7IHJhdyB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGxldCBmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGxldCBlcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEJ1bi5ZQU1MLnBhcnNlKHJhdykgYXMgdW5rbm93bjtcbiAgICBpZiAocGFyc2VkICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocGFyc2VkKSlcbiAgICAgIGZpZWxkcyA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBlbHNlIGlmIChwYXJzZWQgIT09IG51bGwgJiYgcGFyc2VkICE9PSB1bmRlZmluZWQpXG4gICAgICBlcnJvciA9IFwidGhlIGZyb250bWF0dGVyIGlzIG5vdCBhIG1hcHBpbmcgb2Yga2V5cyB0byB2YWx1ZXNcIjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGVycm9yID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlLnNwbGl0KFwiXFxuXCIpWzBdIDogU3RyaW5nKGUpO1xuICB9XG4gIHJldHVybiB7XG4gICAgcmF3LFxuICAgIGZpZWxkcyxcbiAgICB0eXBlOiBzdHIoZmllbGRzLnR5cGUpLFxuICAgIHRpdGxlOiBzdHIoZmllbGRzLnRpdGxlKSxcbiAgICBkZXNjcmlwdGlvbjogc3RyKGZpZWxkcy5kZXNjcmlwdGlvbiksXG4gICAgc3RhdHVzOiBzdGF0dXNPZihmaWVsZHMpLFxuICAgIHRhZ3M6IGFzTGlzdChmaWVsZHMudGFncyksXG4gICAgbGlmZWN5Y2xlOiBzdHIoZmllbGRzLmxpZmVjeWNsZSksXG4gICAgdHJ1c3Q6IHRydXN0VGllcihmaWVsZHMpLFxuICAgIHN0YWxlOiBpc1N0YWxlKGZpZWxkcywgbm93KSxcbiAgICBkYXRlOiBnZW5lcmF0ZWRBdChmaWVsZHMpLFxuICAgIC4uLihlcnJvciA/IHsgZXJyb3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIFRoZSBzbWFsbCBzaGFwZSB0aGUgc2lkZWJhciBuZWVkcyBmb3IgZXZlcnkgY29udGV4dCBkb2N1bWVudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemUobWV0YTogRG9jTWV0YSB8IG51bGwpOiBEb2NTdW1tYXJ5IHwgbnVsbCB7XG4gIGlmICghbWV0YSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgLi4uKG1ldGEudHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgLi4uKG1ldGEudGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSksXG4gICAgc3RhdHVzOiBtZXRhLnN0YXR1cyxcbiAgICB0YWdzOiBtZXRhLnRhZ3MsXG4gICAgdHJ1c3Q6IG1ldGEudHJ1c3QsXG4gICAgc3RhbGU6IG1ldGEuc3RhbGUsXG4gICAgLi4uKG1ldGEubGlmZWN5Y2xlID8geyBsaWZlY3ljbGU6IG1ldGEubGlmZWN5Y2xlIH0gOiB7fSksXG4gICAgLi4uKG1ldGEuZXJyb3IgPyB7IGVycm9yOiBtZXRhLmVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBwZG9jcydzIGZpbHRlciB2b2NhYnVsYXJ5LCBzbyB3aGF0IHRoZSBodW1hbiBsZWFybnMgdGhlcmUgaG9sZHMgaGVyZS4gKi9cbmV4cG9ydCB0eXBlIE1ldGFGaWx0ZXIgPSB7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgbGlmZWN5Y2xlPzogc3RyaW5nO1xuICB0YWc/OiBzdHJpbmc7XG4gIC8qKiBBbiBJU08gZGF0ZTsgbWF0Y2hlcyBkb2N1bWVudHMgd2hvc2UgYGdlbmVyYXRlZC5hdGAgaXMgb24gb3IgYWZ0ZXIgaXQuICovXG4gIHNpbmNlPzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBGaWx0ZXJzIGFyZSBBTkRlZCwgYW5kIGV2ZXJ5IG9uZSBpcyBvcHRpb25hbCDigJQgYSBiYXJlIGZpbHRlciBtYXRjaGVzIGFsbC5cbiAqXG4gKiDim5QgQSBET0NVTUVOVCBXSVRIIE5PIEZST05UTUFUVEVSIE1BVENIRVMgT05MWSBUSEUgRU1QVFkgRklMVEVSLCBhbmQgdGhhdFxuICogaW5jbHVkZXMgYC0tc3RhdHVzIHN0YWJsZWAuIEFic2VudCBgc3RhdHVzYCBkZWZhdWx0cyB0byBgc3RhYmxlYCBmb3IgYW4gT0tGXG4gKiBkb2N1bWVudCAowqc1KSwgYnV0IGEgZG9jdW1lbnQgd2l0aCBubyBibG9jayBhdCBhbGwgaXMgbm90IG1ha2luZyB0aGUgY2xhaW06XG4gKiBgZmluZCAtLXN0YXR1cyBzdGFibGVgIGFza3Mgd2hpY2ggZG9jdW1lbnRzIFNBWSB0aGV5IGFyZSBzdGFibGUsIGFuZCBhIGZpbGVcbiAqIHdpdGggbm8gZnJvbnRtYXR0ZXIgc2F5cyBub3RoaW5nLiBSZWFkaW5nIHRoZSBkZWZhdWx0IHRoZSBvdGhlciB3YXkgd291bGQgcHV0XG4gKiBldmVyeSB1bnRvdWNoZWQgbm90ZSBpbiB0aGUgcmVzdWx0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc0ZpbHRlcihtZXRhOiBEb2NNZXRhIHwgbnVsbCwgZmlsdGVyOiBNZXRhRmlsdGVyKTogYm9vbGVhbiB7XG4gIGlmIChtZXRhID09PSBudWxsKSByZXR1cm4gT2JqZWN0LnZhbHVlcyhmaWx0ZXIpLmV2ZXJ5KCh2KSA9PiB2ID09PSB1bmRlZmluZWQpO1xuICBpZiAoZmlsdGVyLnR5cGUgIT09IHVuZGVmaW5lZCAmJiBtZXRhLnR5cGUgIT09IGZpbHRlci50eXBlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc3RhdHVzICE9PSB1bmRlZmluZWQgJiYgbWV0YS5zdGF0dXMgIT09IGZpbHRlci5zdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5saWZlY3ljbGUgIT09IHVuZGVmaW5lZCAmJiBtZXRhLmxpZmVjeWNsZSAhPT0gZmlsdGVyLmxpZmVjeWNsZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnRhZyAhPT0gdW5kZWZpbmVkICYmICFtZXRhLnRhZ3MuaW5jbHVkZXMoZmlsdGVyLnRhZykpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5zaW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFtZXRhLmRhdGUpIHJldHVybiBmYWxzZTtcbiAgICBpZiAobWV0YS5kYXRlIDwgZmlsdGVyLnNpbmNlKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIOKUgOKUgCBXUklUSU5HIChFMzUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBFVkVSWSBXUklURSBIRVJFIElTIEEgVEVYVCBFRElULCBORVZFUiBBIFJFU0VSSUFMSVNBVElPTi4gUGFyc2luZyBhIGJsb2NrXG4vLyBhbmQgcHJpbnRpbmcgaXQgYmFjayByZW9yZGVycyBrZXlzLCBkcm9wcyBjb21tZW50cyBhbmQgY2hhbmdlcyBxdW90aW5nIOKAlCBhbmRcbi8vIHRoZSBzcGVjIGFza3MgYSBjb25zdW1lciB0byBcInByZXNlcnZlIHVua25vd24ga2V5cyB3aGVuIHJvdW5kLXRyaXBwaW5nXCJcbi8vICjCpzExKSwgd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgdGhhdCBsb3Nlcy4gU28gYSBuZXcgYmxvY2sgaXMgQlVJTFQgKHRoZXJlIGlzXG4vLyBub3RoaW5nIHRvIHByZXNlcnZlIHlldCkgYW5kIGFuIGV4aXN0aW5nIG9uZSBpcyBlZGl0ZWQgYSBMSU5FIGF0IGEgdGltZS5cblxuLyoqIFRoZSBkb2N1bWVudCdzIGZpcnN0IEgxLCB3aGljaCBpcyB0aGUgdGl0bGUgYSBodW1hbiBhbHJlYWR5IHdyb3RlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpdGxlRnJvbUJvZHkoYm9keTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGJvZHkuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtID0gL14jXFxzKyguKz8pXFxzKiQvLmV4ZWMobGluZSk7XG4gICAgaWYgKG0pIHJldHVybiBtWzFdO1xuICAgIGlmIChsaW5lLnRyaW0oKSAhPT0gXCJcIiAmJiAhbGluZS5zdGFydHNXaXRoKFwiI1wiKSkgYnJlYWs7IC8vIHByb3NlIGJlZm9yZSBhbnkgaGVhZGluZ1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogQSBgdHlwZWAgdG8gU1VHR0VTVCBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLlxuICpcbiAqIOKblCBGUk9NIFRIRSBORUlHSEJPVVJTLCBORVZFUiBGUk9NIEEgRklYRUQgTElTVC4gT0tGJ3MgYHR5cGVgIGlzIFwibm90XG4gKiBjZW50cmFsbHkgcmVnaXN0ZXJlZFwiIGFuZCBldmVyeSBjb3JwdXMgaW52ZW50cyBpdHMgb3duIOKAlCBgcmVwb3J0YCwgYHJ1bGVgLFxuICogYGFyY2hldHlwZWAgaW4gb25lLCBzb21ldGhpbmcgZWxzZSBpbiB0aGUgbmV4dCDigJQgc28gdGhlIG9ubHkgaG9uZXN0IHNvdXJjZSBpc1xuICogd2hhdCB0aGUgZG9jdW1lbnRzIGJlc2lkZSB0aGlzIG9uZSBhbHJlYWR5IHNheS4gVGhlIGZvbGRlcidzIG5hbWUgaXMgdGhlXG4gKiBmYWxsYmFjaywgYW5kIHdoZW4gbmVpdGhlciBhbnN3ZXJzLCBub3RoaW5nIGlzIHN1Z2dlc3RlZDogYSBibGFuayB0aGUgaHVtYW5cbiAqIGZpbGxzIGJlYXRzIGEgcGxhdXNpYmxlIGd1ZXNzIChTQ0hFTUEubWQncyBvd24gcnVsZSBhYm91dCBgZ2VuZXJhdGVkLmJ5YCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBndWVzc1R5cGUoc2libGluZ1R5cGVzOiByZWFkb25seSBzdHJpbmdbXSwgZm9sZGVyOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc2libGluZ1R5cGVzKSBpZiAodCkgY291bnRzLnNldCh0LCAoY291bnRzLmdldCh0KSA/PyAwKSArIDEpO1xuICBjb25zdCBiZXN0ID0gWy4uLmNvdW50cy5lbnRyaWVzKCldLnNvcnQoKGEsIGIpID0+IGJbMV0gLSBhWzFdIHx8IGFbMF0ubG9jYWxlQ29tcGFyZShiWzBdKSlbMF07XG4gIGlmIChiZXN0KSByZXR1cm4gYmVzdFswXTtcbiAgY29uc3QgbmFtZSA9IGZvbGRlci50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5hbWUgPT09IFwiXCIgfHwgbmFtZSA9PT0gXCIuXCIgfHwgbmFtZSA9PT0gXCIvXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIC8vIGBkZWNpc2lvbnMvYCDihpIgYGRlY2lzaW9uYDsgYGRvY3MvYCDihpIgYGRvY2AuIEEgcGx1cmFsIGZvbGRlciBuYW1lcyBpdHMga2luZC5cbiAgcmV0dXJuIG5hbWUuZW5kc1dpdGgoXCJpZXNcIilcbiAgICA/IGAke25hbWUuc2xpY2UoMCwgLTMpfXlgXG4gICAgOiBuYW1lLmVuZHNXaXRoKFwic1wiKVxuICAgICAgPyBuYW1lLnNsaWNlKDAsIC0xKVxuICAgICAgOiBuYW1lO1xufVxuXG4vKiogQSBZQU1MIHNjYWxhciwgcXVvdGVkIG9ubHkgd2hlbiBpdCBtdXN0IGJlLiAqL1xuZnVuY3Rpb24gc2NhbGFyKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bXFx3IC4sJycvQCstXSokLy50ZXN0KHZhbHVlKSAmJiAhL15cXHN8XFxzJC8udGVzdCh2YWx1ZSkgJiYgdmFsdWUgIT09IFwiXCJcbiAgICA/IHZhbHVlXG4gICAgOiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG59XG5cbmV4cG9ydCB0eXBlIE5ld01ldGEgPSB7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgc3RhdHVzPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIC8qKiBgZ2VuZXJhdGVkLmJ5YCDigJQgdGhlIGFjdG9yLCByZWNvcmRlZCBob25lc3RseSBvciBsZWZ0IGB1bmtub3duYC4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIGF0Pzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBBIGZyb250bWF0dGVyIGJsb2NrIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE9LRidzIHJlY29tbWVuZGVkIHNldCBpblxuICogdGhlIG9yZGVyIHRoZSBjb3Jwb3JhIHdyaXRlIGl0LCB3aXRoIGBkZXNjcmlwdGlvbmAgbGVmdCBFTVBUWSBmb3IgdGhlIGF1dGhvcjpcbiAqIGEgb25lLWxpbmUgc3VtbWFyeSBub2JvZHkgd3JvdGUgaXMgd29yc2UgdGhhbiBhIGJsYW5rIHRoYXQgYXNrcyB0byBiZSBmaWxsZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEJsb2NrKG1ldGE6IE5ld01ldGEpOiBzdHJpbmcge1xuICBjb25zdCBhdCA9IG1ldGEuYXQgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgY29uc3QgbGluZXMgPSBbXG4gICAgYHR5cGU6ICR7c2NhbGFyKG1ldGEudHlwZSA/PyBcIlwiKX1gLFxuICAgIGB0aXRsZTogJHtzY2FsYXIobWV0YS50aXRsZSA/PyBcIlwiKX1gLFxuICAgIGBkZXNjcmlwdGlvbjogJHttZXRhLmRlc2NyaXB0aW9uID8gc2NhbGFyKG1ldGEuZGVzY3JpcHRpb24pIDogXCJcIn1gLFxuICAgIGB0YWdzOiBbJHsobWV0YS50YWdzID8/IFtdKS5tYXAoc2NhbGFyKS5qb2luKFwiLCBcIil9XWAsXG4gICAgYHN0YXR1czogJHtzY2FsYXIobWV0YS5zdGF0dXMgPz8gXCJkcmFmdFwiKX1gLFxuICAgIGBnZW5lcmF0ZWQ6IHsgYnk6ICR7c2NhbGFyKG1ldGEuYnkgPz8gXCJ1bmtub3duXCIpfSwgYXQ6ICR7YXR9IH1gLFxuICBdO1xuICByZXR1cm4gYC0tLVxcbiR7bGluZXMuam9pbihcIlxcblwiKX1cXG4tLS1cXG5gO1xufVxuXG4vKipcbiAqIFB1dCBhIG5ldyBibG9jayBhdCB0aGUgdG9wIG9mIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS4gTm8gYmxhbmsgbGluZSBpc1xuICogaW5zZXJ0ZWQ6IHRoZSBjb3Jwb3JhIHdyaXRlIHRoZSBib2R5IGRpcmVjdGx5IHVuZGVyIHRoZSBjbG9zaW5nIGAtLS1gLCBhbmQgYVxuICogYmxvY2sgdGhhdCBhZGRzIG9uZSB3b3VsZCBzaG93IGFzIGEgZGlmZiBvbiBldmVyeSBkb2N1bWVudCBpdCB0b3VjaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEJsb2NrKHRleHQ6IHN0cmluZywgYmxvY2s6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtibG9ja30ke3RleHR9YDtcbn1cblxuLyoqXG4gKiBTZXQgb25lIGtleSBpbiBhbiBFWElTVElORyBibG9jaywgYXMgYSBsaW5lIGVkaXQ6IHRoZSBrZXkncyBsaW5lIGlzIHJlcGxhY2VkXG4gKiB3aGVyZSBpdCBleGlzdHMgYW5kIGFwcGVuZGVkIGJlZm9yZSB0aGUgY2xvc2luZyBgLS0tYCB3aGVyZSBpdCBkb2VzIG5vdC5cbiAqIEV2ZXJ5dGhpbmcgZWxzZSDigJQgb3JkZXIsIGNvbW1lbnRzLCBzcGFjaW5nLCBrZXlzIHRoaXMgc3BlbGwgbmV2ZXIgaGVhcmQgb2Yg4oCUXG4gKiBzdXJ2aXZlcyBieXRlIGZvciBieXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0S2V5KHRleHQ6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB7IHJhdyB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKFwidGhpcyBkb2N1bWVudCBoYXMgbm8gZnJvbnRtYXR0ZXIgYmxvY2tcIik7XG4gIGNvbnN0IGxpbmUgPSBgJHtrZXl9OiAke3NjYWxhcih2YWx1ZSl9YDtcbiAgY29uc3Qga2V5TGluZSA9IG5ldyBSZWdFeHAoYF4ke2tleS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIil9XFxcXHMqOmApO1xuICBjb25zdCBsaW5lcyA9IHJhdy5zcGxpdChcIlxcblwiKTtcbiAgY29uc3QgYXQgPSBsaW5lcy5maW5kSW5kZXgoKGwpID0+IGtleUxpbmUudGVzdChsKSk7XG4gIGlmIChhdCA9PT0gLTEpIGxpbmVzLnB1c2gobGluZSk7XG4gIGVsc2Uge1xuICAgIC8vIEEgbXVsdGktbGluZSB2YWx1ZSAoYSBmb2xkZWQgZGVzY3JpcHRpb24sIGEgbmVzdGVkIG1hcHBpbmcpIGlzIHRoZVxuICAgIC8vIGtleSdzIGxpbmUgUExVUyBldmVyeSBpbmRlbnRlZCBsaW5lIHVuZGVyIGl0OyBhbGwgb2YgdGhlbSBnby5cbiAgICBsZXQgZW5kID0gYXQgKyAxO1xuICAgIHdoaWxlIChlbmQgPCBsaW5lcy5sZW5ndGggJiYgL15cXHMrXFxTLy50ZXN0KGxpbmVzW2VuZF0gPz8gXCJcIikpIGVuZCsrO1xuICAgIGxpbmVzLnNwbGljZShhdCwgZW5kIC0gYXQsIGxpbmUpO1xuICB9XG4gIGNvbnN0IHJlYnVpbHQgPSBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKHJhdywgcmVidWlsdCk7XG59XG4iLAogICAgIi8qKlxuICogTGlua3MgYmV0d2VlbiBkb2N1bWVudHMgKEUzMyk6IHdoYXQgYSBkb2N1bWVudCBwb2ludHMgYXQsIGFuZCB3aGF0IHRoYXRcbiAqIHJlc29sdmVzIHRvIGluc2lkZSBhIHNldC5cbiAqXG4gKiDilIDilIAgRk9VUiBTT1VSQ0VTIE9GIEVER0VTLCBBTkQgVEhFWSBBUkUgTk9UIE9ORSBLSU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICAgMS4gbWFya2Rvd24gbGlua3MgICAgICBgW2xhYmVsXSguL290aGVyLm1kKWAgICAgICDigJQgYm9keVxuICogICAyLiB3aWtpIGxpbmtzICAgICAgICAgIGBbW290aGVyLWRvY3xsYWJlbF1dYCAgICAgIOKAlCBib2R5XG4gKiAgIDMuIGZyb250bWF0dGVyIHZhbHVlcyAgYHJlbGF0ZWQ6IFtjb25jZXB0L3hdYCAgICAg4oCUIGF1dGhvcmVkIGludGVudFxuICogICA0LiBgc291cmNlc1tdLnJlc291cmNlYCAgICAgICAgICAgICAgICAgICAgICAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqXG4gKiBwZG9jcyBrZWVwcyB0aGUgZnJvbnRtYXR0ZXIgZWRnZSBhbmQgdGhlIGJvZHktbGluayBlZGdlIEFQQVJUIChgcmVsYXRlZFtdYFxuICogYW5kIGBsaW5rc1tdYCBpbiBpdHMgYGJhY2tsaW5rc2Agb3V0cHV0KSwgYW5kIHRoZSBkaXN0aW5jdGlvbiBpcyByZWFsOiBhXG4gKiBgcmVsYXRlZGAga2V5IGlzIGEgY2xhaW0gdGhlIGF1dGhvciBtYWRlIGFib3V0IHRoZSBkb2N1bWVudCBhcyBhIHdob2xlLCBhXG4gKiBib2R5IGxpbmsgaXMgYSBjaXRhdGlvbiBhdCBhIHBsYWNlIGluIHRoZSBwcm9zZS4gVGhleSBzdGF5IGFwYXJ0IGhlcmUgdG9vLlxuICpcbiAqIOKUgOKUgCBUWVBFRCBMSU5LUyAoT3BlcmF0b3IncyBzaGFwZSwgQ29sZSAyMDI2LTA5LTExKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBBIHJlbGF0aW9uIHJpZGVzIHRoZSBsaW5rIGFzIGEgcXVlcnk6IGBbbGFiZWxdKC4vb3RoZXIubWQ/cmVsPWV4dGVuZHMpYCxcbiAqIGBbW290aGVyP3JlbD1zdXBlcnNlZGVzfGxhYmVsXV1gLiBDb3BpZWQgZXhhY3RseSBmcm9tIE9wZXJhdG9yJ3MgcGFyc2VyXG4gKiAoYHBhY2thZ2VzL3NoYXJlZC9zcmMvbGlua3MvYCk6IG9uZSBsaW5rIGNhcnJpZXMgQUxMIG9mIGl0cyByZWxzLCB0aGV5IGFyZVxuICogbm9ybWFsaXNlZCAobG93ZXJjYXNlZCwgdHJpbW1lZCwgZGVkdXBlZCwgZmlyc3QtYXV0aG9yZWQgb3JkZXIga2VwdCkgYnV0XG4gKiB0aGVpciBTUEVMTElORyBpcyBub3QgY2Fub25pY2FsaXNlZCwgYW5kICoqYSBiYXJlIGxpbmsgaXMgYFtdYCDigJQgdGhlIEFCU0VOQ0VcbiAqIG9mIGFuIGFzc2VydGlvbiwgbm90IGFuIGltcGxpY2l0IGByZWZlcmVuY2VzYCoqLiBBIGdyYXBoIG11c3Qgbm90IGRyYXcgYVxuICogY2xhaW0gbm9ib2R5IG1hZGUuXG4gKlxuICog4pSA4pSAIFdIQVQgQSBCVU5ETEUgSVMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogT0tGJ3MgYnVuZGxlLXJlbGF0aXZlIGZvcm0gKGAvY29uY2VwdHMveC5tZGApIG1lYW5zIHRoZSBCVU5ETEUgcm9vdCwgbm90IHRoZVxuICogZmlsZXN5c3RlbSByb290LCBzbyBhIHJlc29sdmVyIG5lZWRzIGEgYnVuZGxlIGJlZm9yZSBpdCBjYW4gcmVzb2x2ZSBhbnl0aGluZzpcbiAqICoqYSBzZXQncyBlbnRyeSByb290IGlzIHRoZSBidW5kbGUqKiAoRTMzKS4gQSB0YXJnZXQgdGhhdCBlc2NhcGVzIGl0IGlzIG5vdCBhblxuICogZXJyb3Ig4oCUIHRoZSBzcGVjIHJlcXVpcmVzIHRvbGVyYXRpbmcgYnJva2VuIGxpbmtzIOKAlCBpdCBpcyBhbiBlZGdlIG1hcmtlZFxuICogYG91dHNpZGVgIG9yIGBtaXNzaW5nYCwgd2hpY2ggdGhlIHN1cmZhY2Ugb2ZmZXJzIHRvIGFkZCByYXRoZXIgdGhhbiBmb2xsb3cuXG4gKi9cbmltcG9ydCB7XG4gIGJhc2VuYW1lLFxuICBkaXJuYW1lLFxuICBleHRuYW1lLFxuICBqb2luLFxuICBub3JtYWxpemUsXG4gIHJlbGF0aXZlLFxuICByZXNvbHZlIGFzIHJlc29sdmVQYXRoLFxufSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IERvY01ldGEgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgdG9Qb3NpeCB9IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IHR5cGUgTGlua0tpbmQgPSBcIm1hcmtkb3duXCIgfCBcIndpa2lcIjtcblxuLyoqIE9uZSBsaW5rIGFzIHdyaXR0ZW4sIGJlZm9yZSBhbnl0aGluZyBpcyByZXNvbHZlZC4gKi9cbmV4cG9ydCB0eXBlIExpbmtSZWYgPSB7XG4gIGtpbmQ6IExpbmtLaW5kO1xuICAvKiogVGhlIHRhcmdldCBhcyBhdXRob3JlZCwgd2l0aCBpdHMgcXVlcnkgYW5kIGFuY2hvciBzdHJpcHBlZC4gKi9cbiAgdGFyZ2V0OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgdGFyZ2V0IEVYQUNUTFkgYXMgd3JpdHRlbiDigJQgcXVlcnksIGFuY2hvciwgcGVyY2VudC1lbmNvZGluZyBhbmQgYWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBXSEFUIE1BS0VTIEEgREFOR0xJTkcgTElOSyBGSVhBQkxFLiBgdGFyZ2V0YCBpcyB0aGUgcmVzb2x2ZWRcbiAgICogc2hhcGUsIHNvIGEgcmVwb3J0IGJ1aWx0IGZyb20gaXQgdGVsbHMgeW91IHRvIGxvb2sgZm9yIGBkZWVwLm1kYCB3aGVuIHRoZVxuICAgKiBkb2N1bWVudCBhY3R1YWxseSBzYXlzIGAuL21pc3NpbmcvZGVlcC5tZD9yZWw9eGAg4oCUIGEgc3RyaW5nIHRoYXQgaXMgbm90IGluXG4gICAqIHRoZSBmaWxlLiBXaG9ldmVyIChvciB3aGF0ZXZlcikgZ29lcyB0byByZXBhaXIgdGhlIGxpbmsgbmVlZHMgdGhlIHN0cmluZ1xuICAgKiB0aGF0IGlzIHRoZXJlLlxuICAgKi9cbiAgcmF3OiBzdHJpbmc7XG4gIC8qKiAxLWJhc2VkIGxpbmUgaW4gdGhlIGJvZHkgdGhlIGxpbmsgd2FzIHdyaXR0ZW4gb24sIGZvciB0aGUgc2FtZSByZWFzb24uICovXG4gIGxpbmU6IG51bWJlcjtcbiAgLyoqIFJlbGF0aW9ucyBmcm9tIGA/cmVsPWA7IEVNUFRZIG1lYW5zIG5vIGFzc2VydGlvbiwgbmV2ZXIgYHJlZmVyZW5jZXNgLiAqL1xuICByZWw6IHN0cmluZ1tdO1xuICBsYWJlbD86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSB0YXJnZXQncyBzY2hlbWUsIGxvd2VyLWNhc2VkIGFuZCB3aXRob3V0IGl0cyBjb2xvbiAoYG9wYCwgYGh0dHBzYCksIG9uIGFcbiAgICogbGluayByZWFkIHdpdGggYHsgc2NoZW1lczogdHJ1ZSB9YCBvbmx5ICgjMTI4KS4gQWJzZW50IG9uIGV2ZXJ5IGxpbmsgdGhhdFxuICAgKiBuYW1lcyBhIHBhdGguXG4gICAqL1xuICBzY2hlbWU/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZlcmVuY2UgZm91bmQgaW4gZnJvbnRtYXR0ZXIsIHdpdGggdGhlIGtleSB0aGF0IGNhcnJpZWQgaXQuICovXG5leHBvcnQgdHlwZSBGaWVsZFJlZiA9IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfTtcblxuLy8g4pSA4pSAIHdoZXJlIG1hcmtkb3duIGlzIGNvZGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gUG9ydGVkIGZyb20gU3RvcnkgU3R1ZGlvJ3Mga2l0IChgcGFja2FnZXMva2l0L3NyYy9saWIvbWFya2Rvd25Db2RlLnRzYCxcbi8vIHN0b3J5LXN0dWRpb0BhNTdkNjVhKSwgd2hpY2ggdG9vayBpdCBmcm9tIHRoZSBzYW1lIGxpbmVhZ2UgYXMgdGhpcyBmaWxlLlxuLy8gTGluZS1iYXNlZCBhbmQgZGVsaWJlcmF0ZWx5IHNtYWxsOiB0aGVyZSBpcyBubyBwYXJzZSB0cmVlIGhlcmUgdG8gYXNrLlxuXG5jb25zdCBGRU5DRSA9IC9eIHswLDN9KGB7Myx9fH57Myx9KS87XG5jb25zdCBJTkRFTlRFRCA9IC9eKCB7NH18XFx0KS87XG5jb25zdCBMSVNUX0lURU0gPSAvXiB7MCwzfShbLSorXXxcXGR7MSw5fVsuKV0pKFxcc3wkKS87XG5jb25zdCBCTEFOSyA9IC9eXFxzKiQvO1xuLyoqIEEgYmxvY2txdW90ZSdzIG1hcmtlcnMgYXQgdGhlIHN0YXJ0IG9mIGEgbGluZSwgbmVzdGVkIG9yIG5vdC4gKi9cbmNvbnN0IFFVT1RFID0gL14gezAsM30oPzo+ID8pKy87XG4vKiogQSBmZW5jZSBhdCBhbnkgaW5kZW50YXRpb24sIGZvciBhIGxpc3QgaXRlbSdzIGNvbnRlbnQgb3IgYSBxdW90ZSdzLiAqL1xuY29uc3QgRkVOQ0VfQU5ZID0gL15cXHMqKGB7Myx9fH57Myx9KS87XG5cbi8qKlxuICogVGhlIGZlbmNlIGEgbGluZSBvcGVucyBvciBjbG9zZXMsIGlmIGFueSwgYW5kIHdoYXQgZm9sbG93cyBpdC4gSW5zaWRlIGFcbiAqIHF1b3RlIHRoZSBgPmAgbWFya2VycyBhcmUgcmVhZCBwYXN0LCBhbmQgaW5zaWRlIGEgbGlzdCBpdGVtIChvciBhIHF1b3RlKSB0aGVcbiAqIGZlbmNlIG1heSBiZSBpbmRlbnRlZCB0byB0aGUgaXRlbSdzIGNvbnRlbnQuXG4gKi9cbmZ1bmN0aW9uIGZlbmNlT2YobGluZTogc3RyaW5nLCBuZXN0ZWQ6IGJvb2xlYW4pOiB7IG1hcmtlcjogc3RyaW5nOyByZXN0OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBxID0gUVVPVEUuZXhlYyhsaW5lKTtcbiAgY29uc3QgYm9keSA9IHEgPyBsaW5lLnNsaWNlKHFbMF0ubGVuZ3RoKSA6IGxpbmU7XG4gIGNvbnN0IG0gPSAocSB8fCBuZXN0ZWQgPyBGRU5DRV9BTlkgOiBGRU5DRSkuZXhlYyhib2R5KTtcbiAgcmV0dXJuIG0gPyB7IG1hcmtlcjogbVsxXSBhcyBzdHJpbmcsIHJlc3Q6IGJvZHkuc2xpY2UobVswXS5sZW5ndGgpIH0gOiBudWxsO1xufVxuXG4vKipcbiAqIFRoZSBpbmRpY2VzIG9mIHRoZSBsaW5lcyBpbnNpZGUgYSBjb2RlIGJsb2NrOiBhIGZlbmNlZCBibG9jayB3aXRoIGl0cyBmZW5jZVxuICogbGluZXMsIG9yIGFuIGluZGVudGVkIGJsb2NrIChmb3VyIHNwYWNlcyBvciBhIHRhYiwgb3BlbmVkIGFmdGVyIGEgYmxhbmsgbGluZVxuICogYW5kIG5vdCBjb250aW51aW5nIGEgbGlzdCkuIEFuIHVuY2xvc2VkIGZlbmNlIHJ1bnMgdG8gdGhlIGVuZCwgYXMgbWFya2Rvd25cbiAqIHJlYWRzIGl0LlxuICovXG5mdW5jdGlvbiBjb2RlQmxvY2tMaW5lcyhsaW5lczogcmVhZG9ubHkgc3RyaW5nW10pOiBTZXQ8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICBsZXQgZmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgaW5MaXN0ID0gZmFsc2U7XG4gIGxldCBpbmRlbnRlZCA9IGZhbHNlO1xuICBsZXQgcHJldkJsYW5rID0gdHJ1ZTtcbiAgbGluZXMuZm9yRWFjaCgobGluZSwgaSkgPT4ge1xuICAgIGlmIChmZW5jZSAhPT0gbnVsbCkge1xuICAgICAgb3V0LmFkZChpKTtcbiAgICAgIGNvbnN0IG0gPSBmZW5jZU9mKGxpbmUsIHRydWUpO1xuICAgICAgaWYgKG0gJiYgbS5tYXJrZXJbMF0gPT09IGZlbmNlWzBdICYmIG0ubWFya2VyLmxlbmd0aCA+PSBmZW5jZS5sZW5ndGggJiYgQkxBTksudGVzdChtLnJlc3QpKVxuICAgICAgICBmZW5jZSA9IG51bGw7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGJsYW5rID0gQkxBTksudGVzdChsaW5lKTtcbiAgICBpZiAoaW5kZW50ZWQgJiYgKGJsYW5rIHx8IElOREVOVEVELnRlc3QobGluZSkpKSB7XG4gICAgICBvdXQuYWRkKGkpO1xuICAgICAgcHJldkJsYW5rID0gYmxhbms7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGluZGVudGVkID0gZmFsc2U7XG4gICAgY29uc3QgZiA9IGZlbmNlT2YobGluZSwgaW5MaXN0KTtcbiAgICBpZiAoZikge1xuICAgICAgZmVuY2UgPSBmLm1hcmtlcjtcbiAgICAgIG91dC5hZGQoaSk7XG4gICAgICBwcmV2QmxhbmsgPSBmYWxzZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFibGFuayAmJiBJTkRFTlRFRC50ZXN0KGxpbmUpICYmIHByZXZCbGFuayAmJiAhaW5MaXN0KSB7XG4gICAgICBpbmRlbnRlZCA9IHRydWU7XG4gICAgICBvdXQuYWRkKGkpO1xuICAgICAgcHJldkJsYW5rID0gZmFsc2U7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghYmxhbmsgJiYgIUlOREVOVEVELnRlc3QobGluZSkpIGluTGlzdCA9IExJU1RfSVRFTS50ZXN0KGxpbmUpIHx8IChpbkxpc3QgJiYgIXByZXZCbGFuayk7XG4gICAgcHJldkJsYW5rID0gYmxhbms7XG4gIH0pO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogSW5saW5lIGNvZGUgc3BhbnMgaW4gYSBsaW5lLCBhcyBgW2Zyb20sIHRvKWAgcmFuZ2VzOyBhbiB1bmNsb3NlZCBydW4gaXMgbm90IGEgc3Bhbi4gKi9cbmZ1bmN0aW9uIGlubGluZVNwYW5zKGxpbmU6IHN0cmluZyk6IEFycmF5PFtudW1iZXIsIG51bWJlcl0+IHtcbiAgY29uc3Qgc3BhbnM6IEFycmF5PFtudW1iZXIsIG51bWJlcl0+ID0gW107XG4gIGNvbnN0IHJ1bnMgPSBbLi4ubGluZS5tYXRjaEFsbCgvKD88IVxcXFwpYCsvZyldLm1hcCgobSkgPT4gKHtcbiAgICBhdDogbS5pbmRleCBhcyBudW1iZXIsXG4gICAgbGVuOiBtWzBdLmxlbmd0aCxcbiAgfSkpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHJ1bnMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBvcGVuID0gcnVuc1tpXSBhcyB7IGF0OiBudW1iZXI7IGxlbjogbnVtYmVyIH07XG4gICAgY29uc3QgY2xvc2UgPSBydW5zLnNsaWNlKGkgKyAxKS5maW5kSW5kZXgoKHIpID0+IHIubGVuID09PSBvcGVuLmxlbik7XG4gICAgaWYgKGNsb3NlID09PSAtMSkgY29udGludWU7XG4gICAgY29uc3QgZW5kID0gcnVuc1tpICsgMSArIGNsb3NlXSBhcyB7IGF0OiBudW1iZXI7IGxlbjogbnVtYmVyIH07XG4gICAgc3BhbnMucHVzaChbb3Blbi5hdCwgZW5kLmF0ICsgZW5kLmxlbl0pO1xuICAgIGkgKz0gMSArIGNsb3NlO1xuICB9XG4gIHJldHVybiBzcGFucztcbn1cblxuLyoqXG4gKiBgdGV4dGAgd2l0aCBpdHMgY29kZSBibGFua2VkIElOIFBMQUNFOiBldmVyeSBjaGFyYWN0ZXIgb2YgYSBjb2RlIGJsb2NrXG4gKiAoZmVuY2VkIG9yIGluZGVudGVkKSBvciBhbiBpbmxpbmUgc3BhbiwgaXRzIHRpY2tzIGluY2x1ZGVkLCBiZWNvbWVzIGEgc3BhY2UsXG4gKiBhbmQgbGluZSBicmVha3Mgc3RheS4gVGhlIHJlc3VsdCBpcyBleGFjdGx5IGFzIGxvbmcgYXMgYHRleHRgLCBzbyBhbiBvZmZzZXRcbiAqIGZvdW5kIGluIGl0IGlzIGFuIG9mZnNldCBpbiBgdGV4dGAuXG4gKlxuICog4puUIEEgRE9DVU1FTlQgQUJPVVQgTElOS1MgUVVPVEVTIExJTksgU1lOVEFYLCBhbmQgaXQgZG9lcyBzbyBpbiBjb2RlOiB0aGUgd2lraVxuICogdGhpcyB3YXMgYnVpbHQgYWdhaW5zdCBoYXMgU0NIRU1BLm1kJ3MgZmVuY2VkIGV4YW1wbGVzLCBhbmQgQ09OVFJJQlVUSU5HLXN0eWxlXG4gKiBwcm9zZSBsaXN0cyBleGFtcGxlIGxpbmtzIGluIGJhY2t0aWNrcy4gRmVuY2VkIGNvZGUgYWxvbmUgd2FzIGJsYW5rZWQgb25jZVxuICogKGB3aXRob3V0RmVuY2VzYCk7IGlubGluZSBhbmQgaW5kZW50ZWQgY29kZSB3ZXJlIGVkZ2VzIHVudGlsICMxMjYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXNrQ29kZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGJsb2NrcyA9IGNvZGVCbG9ja0xpbmVzKGxpbmVzKTtcbiAgcmV0dXJuIGxpbmVzXG4gICAgLm1hcCgobGluZSwgaSkgPT4ge1xuICAgICAgaWYgKGJsb2Nrcy5oYXMoaSkpIHJldHVybiBcIiBcIi5yZXBlYXQobGluZS5sZW5ndGgpO1xuICAgICAgbGV0IG91dCA9IFwiXCI7XG4gICAgICBsZXQgYXQgPSAwO1xuICAgICAgZm9yIChjb25zdCBbZnJvbSwgdG9dIG9mIGlubGluZVNwYW5zKGxpbmUpKSB7XG4gICAgICAgIG91dCArPSBsaW5lLnNsaWNlKGF0LCBmcm9tKSArIFwiIFwiLnJlcGVhdCh0byAtIGZyb20pO1xuICAgICAgICBhdCA9IHRvO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dCArIGxpbmUuc2xpY2UoYXQpO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBgP3JlbD1hLGJgIOKGkiBgW1wiYVwiLFwiYlwiXWAsIG5vcm1hbGlzZWQgdGhlIHdheSBPcGVyYXRvciBub3JtYWxpc2VzIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWwocXVlcnk6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgaWYgKCFxdWVyeSkgcmV0dXJuIFtdO1xuICBjb25zdCBtID0gLyg/Ol58Wz8mXSlyZWw9KFteJl0qKS8uZXhlYyhxdWVyeSk7XG4gIGlmICghbSkgcmV0dXJuIFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgZGVjb2RlVVJJQ29tcG9uZW50KG1bMV0gPz8gXCJcIikuc3BsaXQoXCIsXCIpKSB7XG4gICAgY29uc3QgcmVsID0gcmF3LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChyZWwgPT09IFwiXCIgfHwgc2Vlbi5oYXMocmVsKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQocmVsKTtcbiAgICBvdXQucHVzaChyZWwpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBTcGxpdCBhIHdyaXR0ZW4gdGFyZ2V0IGludG8gaXRzIHBhdGgsIGl0cyBxdWVyeSBhbmQgaXRzIGFuY2hvci4gKi9cbi8qKlxuICogUGVyY2VudC1kZWNvZGluZywgd2hpY2ggYSBtYXJrZG93biBsaW5rIHRhcmdldCBjYXJyaWVzIHdoZW5ldmVyIHRoZSBmaWxlIGl0XG4gKiBuYW1lcyBoYXMgYSBzcGFjZSBpbiBpdCDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWRgIChFNDkpLlxuICpcbiAqIOKblCBJVCBNVVNUIE5PVCBUSFJPVy4gYGRlY29kZVVSSUNvbXBvbmVudGAgcmVqZWN0cyBhIGxvbmUgYCVgLCBhbmQgYSBmaWxlXG4gKiBjYWxsZWQgYDEwMCUgZG9uZS5tZGAgaXMgYSBwZXJmZWN0bHkgb3JkaW5hcnkgdGhpbmcgdG8gbGluayB0by4gQW5cbiAqIHVuZGVjb2RhYmxlIHRhcmdldCBpcyByZXR1cm5lZCBhcyBpdCBzdGFuZHM6IHdvcnN0IGNhc2UgaXQgZmFpbHMgdG8gcmVzb2x2ZSxcbiAqIHdoaWNoIGlzIHRoZSBiZWhhdmlvdXIgYmVmb3JlIGRlY29kaW5nIGV4aXN0ZWQsIHJhdGhlciB0aGFuIHRha2luZyB0aGUgZ3JhcGhcbiAqIGRvd24gd2l0aCBpdC5cbiAqL1xuZnVuY3Rpb24gZGVjb2RlUGF0aChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghcmF3LmluY2x1ZGVzKFwiJVwiKSkgcmV0dXJuIHJhdztcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiByYXc7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0VGFyZ2V0KHJhdzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IHF1ZXJ5Pzogc3RyaW5nOyBhbmNob3I/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGhhc2ggPSByYXcuaW5kZXhPZihcIiNcIik7XG4gIGNvbnN0IHdpdGhvdXRBbmNob3IgPSBoYXNoID09PSAtMSA/IHJhdyA6IHJhdy5zbGljZSgwLCBoYXNoKTtcbiAgY29uc3QgYW5jaG9yID0gaGFzaCA9PT0gLTEgPyB1bmRlZmluZWQgOiByYXcuc2xpY2UoaGFzaCArIDEpO1xuICBjb25zdCBxID0gd2l0aG91dEFuY2hvci5pbmRleE9mKFwiP1wiKTtcbiAgcmV0dXJuIHtcbiAgICBwYXRoOiBkZWNvZGVQYXRoKChxID09PSAtMSA/IHdpdGhvdXRBbmNob3IgOiB3aXRob3V0QW5jaG9yLnNsaWNlKDAsIHEpKS50cmltKCkpLFxuICAgIC4uLihxID09PSAtMSA/IHt9IDogeyBxdWVyeTogd2l0aG91dEFuY2hvci5zbGljZShxICsgMSkgfSksXG4gICAgLi4uKGFuY2hvciA/IHsgYW5jaG9yIH0gOiB7fSksXG4gIH07XG59XG5cbmNvbnN0IEVYVEVSTkFMID0gL15bYS16XVthLXowLTkrLi1dKjovaTtcbi8qKiBPbmUgbGFiZWwgY2hhcmFjdGVyOiBhbnl0aGluZyBidXQgYSBicmFja2V0LCBhbmQgYSBsaW5lIGJyZWFrIG9ubHkgd2hlbiB0aGUgbmV4dCBsaW5lIGlzIG5vdCBibGFuay4gKi9cbmNvbnN0IExBQkVMX0NIQVIgPSBTdHJpbmcucmF3YCg/OlteXFxbXFxdXFxuXXxcXG4oPyFbIFxcdF0qXFxyP1xcbikpYDtcbi8qKiBBbiBBVFggaGVhZGluZyBsaW5lOiBhIGhlYWRpbmcgZW5kcyBhdCBpdHMgbGluZSBicmVhaywgYW5kIHNvIGRvZXMgYW55IGxhYmVsIGluIGl0LiAqL1xuY29uc3QgQVRYX0hFQURJTkcgPSAvXiB7MCwzfSN7MSw2fSg/OlsgXFx0XXwkKS87XG4vKipcbiAqIGBbbGFiZWxdKHRhcmdldClgIG9yIGBbbGFiZWxdKDx0YXJnZXQ+KWAsIHdpdGggYW4gb3B0aW9uYWwgdGl0bGUgaW4gZG91YmxlIG9yXG4gKiBzaW5nbGUgcXVvdGVzOyBgIWAgbWFya3MgYW4gaW1hZ2UuIEEgbGFiZWwgbWF5IGhvbGQgb25lIGxldmVsIG9mIGJyYWNrZXRzXG4gKiAoYFthIFtiXSBjXSh4Lm1kKWApIGFuZCBydW4gb250byB0aGUgbmV4dCBsaW5lOyBhIHRhcmdldCBtYXkgaG9sZCBvbmUgbGV2ZWxcbiAqIG9mIGJhbGFuY2VkIHBhcmVudGhlc2VzLiBNYXRjaGVkIHdpdGggaW5kaWNlcyAoYGRgKSwgc28gZXZlcnkgcGFydCBjYW4gYmVcbiAqIHJlYWQgYmFjayBvdXQgb2YgdGhlIE9SSUdJTkFMIHRleHQuIChQb3J0ZWQgZnJvbSBzdG9yeS1zdHVkaW9AYTU3ZDY1YS4pXG4gKi9cbmNvbnN0IE1EX0xJTksgPSBuZXcgUmVnRXhwKFxuICBTdHJpbmcucmF3YCghPylcXFsoKD86JHtMQUJFTF9DSEFSfXxcXFske0xBQkVMX0NIQVJ9KlxcXSkqKVxcXVxcKFxccyooPzo8KFtePlxcbl0qKT58KCg/OlteXFxzKCldfFxcKFteXFxzKCldKlxcKSkqKSkoPzpcXHMrKD86XCJbXlwiXSpcInwnW14nXSonKSk/XFxzKlxcKWAsXG4gIFwiZ2RcIixcbik7XG5jb25zdCBXSUtJX0xJTksgPSAvXFxbXFxbKFteW1xcXVxcbl0rKVxcXVxcXS9kZztcbi8qKiBBbiBIVE1MIGNvbW1lbnQsIHRvIGl0cyBlbmQgb3IgdG8gdGhlIGVuZCBvZiB0aGUgdGV4dCB3aGVuIGl0IG5ldmVyIGNsb3Nlcy4gKi9cbmNvbnN0IENPTU1FTlQgPSAvPCEtLVtcXHNcXFNdKj8oPzotLT58JCkvZztcbi8qKiBBIGJhY2tzbGFzaCBlc2NhcGU6IG1hcmtkb3duJ3MsIG9mIGFueSBBU0NJSSBwdW5jdHVhdGlvbi4gKi9cbmNvbnN0IEVTQ0FQRSA9IC9cXFxcWyEtLzotQFstYHstfl0vZztcblxuY29uc3QgdW5lc2NhcGVNZCA9IChzOiBzdHJpbmcpID0+IHMucmVwbGFjZShFU0NBUEUsIChlKSA9PiBlLnNsaWNlKDEpKTtcblxuLyoqXG4gKiBUaGUgdGV4dCB3aXRoIGV2ZXJ5dGhpbmcgdGhhdCBjYW5ub3QgaG9sZCBhIGxpbmsgYmxhbmtlZCBJTiBQTEFDRSwgc28gZXZlcnlcbiAqIG9mZnNldCBpbiBpdCBpcyBhbiBvZmZzZXQgaW4gdGhlIG9yaWdpbmFsOiBjb2RlIChmZW5jZWQsIGluZGVudGVkLCBpbmxpbmUpXG4gKiBhbmQgSFRNTCBjb21tZW50cyBiZWNvbWUgc3BhY2VzLCBhbmQgYSBiYWNrc2xhc2ggZXNjYXBlIGJlY29tZXMgdHdvXG4gKiBwbGFjZWhvbGRlciBjaGFyYWN0ZXJzLCBzbyBgXFxbYCBvcGVucyBub3RoaW5nIGFuZCBgXFxdYCBjbG9zZXMgbm90aGluZyB3aGlsZVxuICogdGhlIGVzY2FwZWQgdGV4dCBrZWVwcyBpdHMgcGxhY2UuIExpbmUgYnJlYWtzIGFsd2F5cyBzdGF5LlxuICovXG4vKiogV2ViIHNjaGVtZXM6IHRoZSBzdXJmYWNlIG9wZW5zIHRoZXNlIG91dHdhcmQsIHNvIGEgbGluayB3aXRoIG9uZSB3b3Jrcy4gKi9cbmV4cG9ydCBjb25zdCBPUEVOU19PVVRXQVJEOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXCJodHRwXCIsIFwiaHR0cHNcIiwgXCJtYWlsdG9cIl0pO1xuXG4vKiogV2hhdCBgZXh0cmFjdExpbmtzYCBrZWVwcyBiZXlvbmQgZG9jdW1lbnQgbGlua3MuICovXG5leHBvcnQgdHlwZSBFeHRyYWN0T3B0aW9ucyA9IHtcbiAgLyoqXG4gICAqIEtlZXAgbWFya2Rvd24gdGFyZ2V0cyB3aXRoIGEgc2NoZW1lIChgb3A6ZG9jL+KApmAsIGBodHRwczpgKSwgZWFjaCBtYXJrZWQgd2l0aFxuICAgKiBpdHMgYHNjaGVtZWAgKCMxMjgpLiBUaGUgbWFwIG5lZWRzIHRoZW0gdG8gcmVwb3J0IHRoZSBvbmVzIG5vdGhpbmcgaGVyZVxuICAgKiBvcGVuczsgbm90aGluZyB0aGF0IFJFU09MVkVTIGEgbGluayB3YW50cyB0aGVtLlxuICAgKi9cbiAgc2NoZW1lcz86IGJvb2xlYW47XG59O1xuXG5mdW5jdGlvbiBsaW5rYWJsZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBibGFuayA9IChzOiBzdHJpbmcpID0+IHMucmVwbGFjZSgvW15cXG5dL2csIFwiIFwiKTtcbiAgcmV0dXJuIG1hc2tDb2RlKHRleHQpLnJlcGxhY2UoQ09NTUVOVCwgYmxhbmspLnJlcGxhY2UoRVNDQVBFLCBcIlxcdTAwMDFcXHUwMDAxXCIpO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGxpbmsgYSBkb2N1bWVudCdzIEJPRFkgcG9pbnRzIGF0LCBpbiBvcmRlcjogbWFya2Rvd24gbGlua3MgYW5kIHdpa2lcbiAqIGxpbmtzLCB3aXRoIGltYWdlcywgZXh0ZXJuYWwgdGFyZ2V0cyAoYGh0dHBzOmAsIGBtYWlsdG86YCwgYG9wOmApIGFuZFxuICogaW4tcGFnZSBhbmNob3JzIChgI3hgKSBsZWZ0IG91dCwgdW5sZXNzIGBvcHRzLnNjaGVtZXNgIGtlZXBzIHRoZSBzY2hlbWVcbiAqIHRhcmdldHMgKGVhY2ggbWFya2VkIHdpdGggaXRzIGBzY2hlbWVgKSwgYW5kIG5vdGhpbmcgaW5zaWRlIGNvZGUgKGZlbmNlZCwgaW5kZW50ZWQgb3JcbiAqIGlubGluZSkgb3IgYW4gSFRNTCBjb21tZW50LCB3aGljaCBob2xkIGV4YW1wbGVzIGFuZCBhc2lkZXMsIG5vdCBsaW5rcy4gQVxuICogYmFja3NsYXNoLWVzY2FwZWQgYnJhY2tldCBpcyB0ZXh0LlxuICpcbiAqIE1hdGNoZWQgb3ZlciB0aGUgd2hvbGUgYm9keSB3aXRoIHdoYXQgY2Fubm90IGhvbGQgYSBsaW5rIGJsYW5rZWQgaW4gcGxhY2VcbiAqIChgbGlua2FibGVgKSwgc28gb2Zmc2V0cyBuZWVkIG5vIG1hcHBpbmcgYmFjazogdGhlIHRhcmdldCBhcyB3cml0dGVuIGFuZCB0aGVcbiAqIGxhYmVsIGFyZSByZWFkIHN0cmFpZ2h0IG91dCBvZiB0aGUgb3JpZ2luYWwgdGV4dCwgYW5kIGBsaW5lYCBpcyB0aGUgYm9keVxuICogbGluZSB0aGUgbGluayBzdGFydHMgb24uIEEgbGFiZWwgbWF5IHJ1biBvbnRvIHRoZSBuZXh0IGxpbmUsIGFzIG1hcmtkb3duXG4gKiBhbGxvd3MsIGJ1dCBhIGJsYW5rIGxpbmUgb3IgdGhlIGVuZCBvZiBhbiBBVFggaGVhZGluZyBsaW5lIGVuZHMgaXQuXG4gKlxuICogUmVmZXJlbmNlLXN0eWxlIGxpbmtzIChgW3hdW3JlZl1gIHdpdGggYFtyZWZdOiAuL2EubWRgKSBhcmUgbm90IHJlYWQsIGhlcmVcbiAqIG9yIGluIHRoZSBraXQgdGhpcyB3YXMgcG9ydGVkIGZyb20uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TGlua3MoYm9keTogc3RyaW5nLCBvcHRzOiBFeHRyYWN0T3B0aW9ucyA9IHt9KTogTGlua1JlZltdIHtcbiAgaWYgKCFib2R5LmluY2x1ZGVzKFwiW1wiKSkgcmV0dXJuIFtdO1xuICBjb25zdCB0ZXh0ID0gYm9keTtcbiAgY29uc3QgbWFza2VkID0gbGlua2FibGUodGV4dCk7XG4gIC8vIOKaoCBMSU5FUyBGUk9NIEEgUFJFQ09NUFVURUQgVEFCTEUuIFdhbGtpbmcgZnJvbSB0aGUgc3RhcnQgb2YgdGhlIHRleHQgZm9yXG4gIC8vIGV2ZXJ5IGxpbmsgbWFkZSBleHRyYWN0aW9uIE8obGlua3Mgw5cgbGVuZ3RoKSBvbiBhIGxvbmcgZG9jdW1lbnQgKCMxMjYpLlxuICBjb25zdCBzdGFydHMgPSBbMF07XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdGV4dC5sZW5ndGg7IGkrKykgaWYgKHRleHQuY2hhckNvZGVBdChpKSA9PT0gMTApIHN0YXJ0cy5wdXNoKGkgKyAxKTtcbiAgLyoqIFRoZSAwLWJhc2VkIGxpbmUgaG9sZGluZyBvZmZzZXQgYGF0YC4gKi9cbiAgY29uc3QgbGluZU9mID0gKGF0OiBudW1iZXIpID0+IHtcbiAgICBsZXQgbG8gPSAwO1xuICAgIGxldCBoaSA9IHN0YXJ0cy5sZW5ndGggLSAxO1xuICAgIHdoaWxlIChsbyA8IGhpKSB7XG4gICAgICBjb25zdCBtaWQgPSAobG8gKyBoaSArIDEpID4+IDE7XG4gICAgICBpZiAoKHN0YXJ0c1ttaWRdIGFzIG51bWJlcikgPD0gYXQpIGxvID0gbWlkO1xuICAgICAgZWxzZSBoaSA9IG1pZCAtIDE7XG4gICAgfVxuICAgIHJldHVybiBsbztcbiAgfTtcbiAgY29uc3QgbGluZVRleHQgPSAoaTogbnVtYmVyKSA9PlxuICAgIHRleHQuc2xpY2Uoc3RhcnRzW2ldLCAoc3RhcnRzW2kgKyAxXSA/PyB0ZXh0Lmxlbmd0aCArIDEpIC0gMSkucmVwbGFjZSgvXFxyJC8sIFwiXCIpO1xuXG4gIC8vIE1hdGNoZWQgb25lIGF0IGEgdGltZSwgc28gYSByZWplY3RlZCBtYXRjaCBjYW4gYmUgcmV0cmllZCBvbmUgY2hhcmFjdGVyIG9uOlxuICAvLyBhIGxhYmVsIGhvbGRpbmcgYSB3aG9sZSBsaW5rIChgW3NlZSBbeF0oLi95Lm1kKV0oLi96Lm1kKWApIGlzIG5vdCBvbmUgbGluayxcbiAgLy8gYW5kIHJldHJ5aW5nIGZpbmRzIHRoZSBpbm5lciBgW3hdKC4veS5tZClgLCB3aGljaCBpcyB0aGUgb25lIG1hcmtkb3duXG4gIC8vIHJlbmRlcnMuIEEgbGFiZWwgdGhhdCBydW5zIHBhc3QgdGhlIGVuZCBvZiBhIGhlYWRpbmcgbGluZSBpcyBub3Qgb25lXG4gIC8vIGVpdGhlcjogdGhlIGhlYWRpbmcgZW5kZWQgdGhlcmUuXG4gIGNvbnN0IG1kOiBSZWdFeHBFeGVjQXJyYXlbXSA9IFtdO1xuICBNRF9MSU5LLmxhc3RJbmRleCA9IDA7XG4gIGZvciAobGV0IG0gPSBNRF9MSU5LLmV4ZWMobWFza2VkKTsgbTsgbSA9IE1EX0xJTksuZXhlYyhtYXNrZWQpKSB7XG4gICAgY29uc3QgbGFiZWwgPSBtWzJdID8/IFwiXCI7XG4gICAgY29uc3QgY3Jvc3Nlc0hlYWRpbmcgPSBsYWJlbC5pbmNsdWRlcyhcIlxcblwiKSAmJiBBVFhfSEVBRElORy50ZXN0KGxpbmVUZXh0KGxpbmVPZihtLmluZGV4KSkpO1xuICAgIGlmIChsYWJlbC5pbmNsdWRlcyhcIl0oXCIpIHx8IGNyb3NzZXNIZWFkaW5nKSB7XG4gICAgICBNRF9MSU5LLmxhc3RJbmRleCA9IG0uaW5kZXggKyAxO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIG1kLnB1c2gobSk7XG4gIH1cbiAgY29uc3QgbWRTcGFuczogW251bWJlciwgbnVtYmVyXVtdID0gbWQubWFwKChtKSA9PiBbbS5pbmRleCwgbS5pbmRleCArIG1bMF0ubGVuZ3RoXSk7XG4gIGNvbnN0IHdpa2kgPSBbLi4ubWFza2VkLm1hdGNoQWxsKFdJS0lfTElOSyldLmZpbHRlcihcbiAgICAobSkgPT4gIW1kU3BhbnMuc29tZSgoW2EsIGJdKSA9PiBtLmluZGV4IDwgYiAmJiBtLmluZGV4ICsgbVswXS5sZW5ndGggPiBhKSxcbiAgKTtcbiAgY29uc3Qgc2xpY2UgPSAobTogUmVnRXhwTWF0Y2hBcnJheSwgZzogbnVtYmVyKSA9PiB7XG4gICAgY29uc3QgYXQgPSBtLmluZGljZXM/LltnXTtcbiAgICByZXR1cm4gYXQgPyB0ZXh0LnNsaWNlKGF0WzBdLCBhdFsxXSkgOiB1bmRlZmluZWQ7XG4gIH07XG5cbiAgY29uc3Qgb3V0OiAoTGlua1JlZiAmIHsgYXQ6IG51bWJlciB9KVtdID0gW107XG4gIGZvciAoY29uc3QgbSBvZiBtZCkge1xuICAgIGlmIChtWzFdID09PSBcIiFcIikgY29udGludWU7IC8vIGFuIGltYWdlIGlzIG5vdCBhIGRvY3VtZW50IGxpbmtcbiAgICBjb25zdCByYXcgPSBzbGljZShtLCAzKSA/PyBzbGljZShtLCA0KSA/PyBcIlwiO1xuICAgIGlmIChyYXcgPT09IFwiXCIgfHwgcmF3LnN0YXJ0c1dpdGgoXCIjXCIpKSBjb250aW51ZTtcbiAgICAvLyDimqAgQU5ZIFNDSEVNRS1TSEFQRUQgUFJFRklYIElTIEEgU0NIRU1FLCB3aGljaCBpcyB0aGUgc3VyZmFjZSdzIHJ1bGUgdG9vXG4gICAgLy8gKGBzdGF0ZS9tYXJrZG93bi50c2ApOiBpdCBzdHJpa2VzIGV2ZXJ5IG9uZSBidXQgaHR0cCwgaHR0cHMgYW5kIG1haWx0b1xuICAgIC8vIHRocm91Z2gsIHNvIHRoZSBtYXAgbXVzdCBub3QgY2FsbCBzdWNoIGEgbGluayBhIHBhdGguXG4gICAgY29uc3Qgc2NoZW1lID0gRVhURVJOQUwuZXhlYyhyYXcpPy5bMF0uc2xpY2UoMCwgLTEpLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKHNjaGVtZSAhPT0gdW5kZWZpbmVkICYmICFvcHRzLnNjaGVtZXMpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHVuZXNjYXBlTWQocmF3KSk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxhYmVsID0gdW5lc2NhcGVNZChzbGljZShtLCAyKSA/PyBcIlwiKVxuICAgICAgLnJlcGxhY2UoL1xccypcXG5cXHMqL2csIFwiIFwiKVxuICAgICAgLnRyaW0oKTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBhdDogbS5pbmRleCxcbiAgICAgIGtpbmQ6IFwibWFya2Rvd25cIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJhdyxcbiAgICAgIGxpbmU6IGxpbmVPZihtLmluZGV4KSArIDEsXG4gICAgICByZWw6IHBhcnNlUmVsKHF1ZXJ5KSxcbiAgICAgIC4uLihsYWJlbCA/IHsgbGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihzY2hlbWUgIT09IHVuZGVmaW5lZCA/IHsgc2NoZW1lIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBtIG9mIHdpa2kpIHtcbiAgICBjb25zdCBpbm5lciA9IHNsaWNlKG0sIDEpID8/IFwiXCI7XG4gICAgY29uc3QgcGlwZSA9IGlubmVyLmluZGV4T2YoXCJ8XCIpO1xuICAgIGNvbnN0IHRhcmdldFBhcnQgPSBwaXBlID09PSAtMSA/IGlubmVyIDogaW5uZXIuc2xpY2UoMCwgcGlwZSk7XG4gICAgY29uc3QgbGFiZWwgPSBwaXBlID09PSAtMSA/IHVuZGVmaW5lZCA6IGlubmVyLnNsaWNlKHBpcGUgKyAxKS50cmltKCk7XG4gICAgY29uc3QgeyBwYXRoLCBxdWVyeSB9ID0gc3BsaXRUYXJnZXQodGFyZ2V0UGFydCk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGF0OiBtLmluZGV4LFxuICAgICAga2luZDogXCJ3aWtpXCIsXG4gICAgICB0YXJnZXQ6IHBhdGgsXG4gICAgICByYXc6IHRhcmdldFBhcnQsXG4gICAgICBsaW5lOiBsaW5lT2YobS5pbmRleCkgKyAxLFxuICAgICAgcmVsOiBwYXJzZVJlbChxdWVyeSksXG4gICAgICAuLi4obGFiZWwgPyB7IGxhYmVsIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiBhLmF0IC0gYi5hdCkubWFwKCh7IGF0OiBfYXQsIC4uLmxpbmsgfSkgPT4gbGluayk7XG59XG5cbi8qKiBEb2VzIHRoaXMgZnJvbnRtYXR0ZXIgdmFsdWUgTE9PSyBsaWtlIGEgZG9jdW1lbnQgcmVmZXJlbmNlPyAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzTGlrZVJlZih2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdiA9IHZhbHVlLnRyaW0oKTtcbiAgaWYgKHYgPT09IFwiXCIgfHwgRVhURVJOQUwudGVzdCh2KSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdi5pbmNsdWRlcyhcIi9cIikgfHwgdi50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKFwiLm1kXCIpO1xufVxuXG4vKipcbiAqIFJlZmVyZW5jZXMgaW5zaWRlIGZyb250bWF0dGVyLCB3aGF0ZXZlciBrZXkgY2FycmllcyB0aGVtIOKAlCBgcmVsYXRlZGAsXG4gKiBgc3VwZXJzZWRlc2AsIGBzb3VyY2VzW10ucmVzb3VyY2VgLCBvciBhIGtleSBpbnZlbnRlZCB0b21vcnJvdy4gVGhlIFNIQVBFXG4gKiBkZWNpZGVzIChhIHNsYXNoIG9yIGEgYC5tZGApLCB3aGljaCBpcyB3aHkgYmFyZSBgdGFnc2AgYXJlIG5vdCByZWZlcmVuY2VzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmllbGRSZWZzKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG1heERlcHRoID0gNCk6IEZpZWxkUmVmW10ge1xuICBjb25zdCBvdXQ6IEZpZWxkUmVmW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGRlcHRoOiBudW1iZXIpID0+IHtcbiAgICBpZiAoZGVwdGggPiBtYXhEZXB0aCkgcmV0dXJuO1xuICAgIGlmIChsb29rc0xpa2VSZWYodmFsdWUpKSBvdXQucHVzaCh7IGtleSwgdmFsdWU6IHZhbHVlLnRyaW0oKSB9KTtcbiAgICBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgZm9yIChjb25zdCB2IG9mIHZhbHVlKSB3YWxrKGtleSwgdiwgZGVwdGggKyAxKTtcbiAgICBlbHNlIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIpXG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpXG4gICAgICAgIHdhbGsoYCR7a2V5fS4ke2t9YCwgdiwgZGVwdGggKyAxKTtcbiAgfTtcbiAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoZmllbGRzKSkgd2FsayhrLCB2LCAwKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBXaGVyZSBhIHRhcmdldCBsYW5kZWQuIGBvdXRzaWRlYCBpcyBhIGZpbGUgb24gZGlzayBidXQgbm90IGluIHRoaXMgYnVuZGxlO1xuICogYGZvbGRlcmAgaXMgYSBmb2xkZXIgb24gZGlzaywgd2hpY2ggbmFtZXMgbm8gZG9jdW1lbnQgKCMxMjMpLlxuICovXG5leHBvcnQgdHlwZSBSZXNvbHV0aW9uID1cbiAgfCB7IHN0YXRlOiBcImluLWJ1bmRsZVwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsgc3RhdGU6IFwib3V0c2lkZVwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsgc3RhdGU6IFwiZm9sZGVyXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJtaXNzaW5nXCI7IHRyaWVkOiBzdHJpbmcgfTtcblxuZXhwb3J0IHR5cGUgQnVuZGxlSW5kZXggPSB7XG4gIC8qKiBUaGUgc2V0J3Mgcm9vdCDigJQgT0tGJ3MgYnVuZGxlLCBhbmQgd2hhdCBhIGAvYC10YXJnZXQgaXMgcmVsYXRpdmUgdG8uICovXG4gIHJvb3Q6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBidW5kbGUuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgZG9jdW1lbnQncyBwYXJzZWQgZnJvbnRtYXR0ZXIsIGZvciBgdHlwZS9zbHVnYCByZXNvbHV0aW9uLiAqL1xuICBtZXRhT2Y6IChwYXRoOiBzdHJpbmcpID0+IERvY01ldGEgfCBudWxsO1xuICAvKiogRG9lcyB0aGlzIHBhdGggZXhpc3Qgb24gZGlzayBhcyBhIGZpbGU/IChJbmplY3RlZCwgc28gdGhlIHJlc29sdmVyIHN0YXlzIHB1cmUuKSAqL1xuICBleGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBEb2VzIHRoaXMgcGF0aCBleGlzdCBvbiBkaXNrIGFzIGEgZm9sZGVyPyBBYnNlbnQgbWVhbnMgXCJuZXZlclwiLCB3aGljaCBpc1xuICAgKiB3aGF0IGEgcmVzb2x2ZXIgd2l0aG91dCBhIGRpc2sgKGEgdGVzdCwgYSBwcmV2aWV3KSBzaG91bGQgYXNzdW1lLlxuICAgKi9cbiAgaXNEaXI/OiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xuICAvKipcbiAgICogVGhlIGdpdCB3b3JraW5nIHRyZWUgdGhlIGJ1bmRsZSBzaXRzIGluLCB3aGVuIHRoZXJlIGlzIG9uZS4gQSB0aGlyZCBwbGFjZVxuICAgKiBhbiB1bmFuY2hvcmVkIHBhdGggaXMgdHJpZWQ6IHBkb2NzIHdyaXRlcyByZXBvLXJlbGF0aXZlIHBhdGhzXG4gICAqIChgZG9jcy9wbGF5Ym9va3MvZm9vLm1kYCkgYW5kIHRoZSB3aWtpJ3MgcnVsZSBwYWdlcyBjYXJyeSByZXBvLXJlbGF0aXZlXG4gICAqIGBjaGVja2VyOmAgdmFsdWVzLCBhbmQgbmVpdGhlciByZXNvbHZlcyBmcm9tIHRoZSBkb2N1bWVudCBvciB0aGUgYnVuZGxlLlxuICAgKi9cbiAgcmVwb1Jvb3Q/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuY29uc3Qgc3RlbSA9IChwOiBzdHJpbmcpID0+IGJhc2VuYW1lKHAsIGV4dG5hbWUocCkpO1xuXG4vKiogQSBwYXRoIHdpdGhvdXQgaXRzIHRyYWlsaW5nIHNlcGFyYXRvciwgdW5sZXNzIGl0IGlzIG9ubHkgb25lLiAqL1xuY29uc3QgdHJpbVNsYXNoID0gKHA6IHN0cmluZykgPT4gKHAubGVuZ3RoID4gMSA/IHAucmVwbGFjZSgvW1xcXFwvXSskLywgXCJcIikgfHwgcCA6IHApO1xuXG4vKipcbiAqIFJlc29sdmUgb25lIHdyaXR0ZW4gdGFyZ2V0IGFnYWluc3QgdGhlIGJ1bmRsZS5cbiAqXG4gKiBGb3VyIGZvcm1zLCBpbiBvcmRlcjogYSBidW5kbGUtcmVsYXRpdmUgcGF0aCAoYC94L3kubWRgKSwgYSByZWxhdGl2ZSBwYXRoXG4gKiAoYC4veS5tZGAsIGAuLi94L3kubWRgKSwgYSBgdHlwZS9zbHVnYCBrZXkg4oCUIHBkb2NzJyBhbmQgdGhlIHdpa2kncyBvd24gZm9ybSxcbiAqIHdoaWNoIHJlc29sdmVzIGJ5IFRZUEUgYW5kIEJBU0VOQU1FIHNvIGEgcGFnZSBjYW4gbW92ZSBmb2xkZXJzIHdpdGhvdXRcbiAqIGJyZWFraW5nIGluYm91bmQgcmVmZXJlbmNlcyDigJQgYW5kIGEgYmFyZSBuYW1lIChhIHdpa2kgbGluayksIGJ5IGJhc2VuYW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRhcmdldChyYXdUYXJnZXQ6IHN0cmluZywgZnJvbTogc3RyaW5nLCBpbmRleDogQnVuZGxlSW5kZXgpOiBSZXNvbHV0aW9uIHtcbiAgLy8g4puUIFNQTElUIEZJUlNULCBCRUNBVVNFIFRIRSBDQUxMRVJTIERJU0FHUkVFIEFCT1VUIFdIQVQgVEhFWSBIQU5EIE9WRVIuXG4gIC8vIGBleHRyYWN0TGlua3NgIHNwbGl0cyBhIHRhcmdldCBiZWZvcmUgaXQgZXZlciBnZXRzIGhlcmUgKEU0OSksIGJ1dCB0aGVcbiAgLy8gQ0xJQ0sgcGF0aCBkb2VzIG5vdDogYGxpbmsub3BlbmAgY2FycmllcyB0aGUgaHJlZiBleGFjdGx5IGFzIHRoZSBkb2N1bWVudFxuICAvLyB3cm90ZSBpdC4gU28gYW4gT3BlcmF0b3IgdHlwZWQgbGluayDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWQ/cmVsPWxvY2F0ZWQtaW5gXG4gIC8vIOKAlCBhcnJpdmVkIHdpdGggaXRzIHF1ZXJ5IGFuZCBpdHMgZW5jb2RpbmcgaW50YWN0LCBgZXh0bmFtZWAgcmVhZFxuICAvLyBgLm1kP3JlbD1sb2NhdGVkLWluYCwgYW5kIHRoZSBsb29rdXAgd2VudCBodW50aW5nIGZvciBhIGZpbGUgbmFtZWQgYWZ0ZXJcbiAgLy8gdGhlIHdob2xlIHN0cmluZy4gVGhlIEdSQVBIIGRyZXcgdGhhdCBlZGdlIGNvcnJlY3RseSB0aGUgZW50aXJlIHRpbWUsIHdoaWNoXG4gIC8vIGlzIHdoYXQgbWFkZSBpdCBwdXp6bGluZzogdGhlIHNhbWUgbGluayB3YXMgZmluZSBpbiB0aGUgbWFwIGFuZCBkZWFkIHVuZGVyXG4gIC8vIHRoZSBwb2ludGVyLiBTcGxpdHRpbmcgaGVyZSBmaXhlcyBldmVyeSBjYWxsZXIgYXQgb25jZSBhbmQgaXMgaWRlbXBvdGVudFxuICAvLyBmb3IgdGhlIHR3byB0aGF0IGhhZCBhbHJlYWR5IGRvbmUgaXQuIChDb2xlIGZvdW5kIGl0IGJ5IGNsaWNraW5nIG9uZSBpblxuICAvLyBIb2xsb3dicm9vaywgMjAyNi0wOS0xNC4pXG4gIGNvbnN0IHRhcmdldCA9IHNwbGl0VGFyZ2V0KHJhd1RhcmdldCkucGF0aDtcbiAgLy8g4puUIFdIQVQgTUFLRVMgQSBUQVJHRVQgQSBQQVRIIFJBVEhFUiBUSEFOIEEgS0VZLCBhbmQgdGhlIGNhc2UgdGhhdCB0YXVnaHRcbiAgLy8gaXQ6IGBbdGhlIGxpbnRlcl0obGludC50cylgIGluIHRoZSByZWFsIHdpa2kgaGFzIG5vIGAuL2AgYW5kIGlzIG5vdCBhIGAubWRgLFxuICAvLyBzbyBhIHJ1bGUga2V5ZWQgb24gdGhvc2UgdHdvIHJlYWQgaXQgYXMgYSBOQU1FIGFuZCByZXBvcnRlZCBpdCBtaXNzaW5nXG4gIC8vIHdoaWxlIHRoZSBmaWxlIHNhdCByaWdodCB0aGVyZS4gQSB0YXJnZXQgaXMgYSBwYXRoIHdoZW4gaXQgaXMgYW5jaG9yZWRcbiAgLy8gKGAvYCwgYC4vYCwgYC4uL2ApIG9yIGNhcnJpZXMgQU5ZIGV4dGVuc2lvbjsgYGNvbmNlcHQvZXhpdC1jb2Rlc2AgaGFzXG4gIC8vIG5laXRoZXIsIHdoaWNoIGlzIHdoYXQga2VlcHMgYSBgdHlwZS9zbHVnYCBrZXkgYSBrZXkuXG4gIC8vIOKblCBBIFRSQUlMSU5HIFNMQVNIIE5BTUVTIEEgRk9MREVSLCBhbmQgb25seSBhIGZvbGRlciAoIzEyMykuIFJlYWQgYXMgYSBrZXksXG4gIC8vIGBsb2NhdGlvbnMvYCBtYXRjaGVkIGFueSBgbG9jYXRpb25zLm1kYCBieSBiYXNlbmFtZTsgcmVhZCBhcyBhIHBhdGgsIGl0IGhhZFxuICAvLyBgLm1kYCBhcHBlbmRlZCBhbmQgd2FzIHJlcG9ydGVkIGFzIGEgbWlzc2luZyBmaWxlIGJlc2lkZSBhIGZvbGRlciB0aGF0XG4gIC8vIHBsYWlubHkgZXhpc3RzLlxuICBjb25zdCBmb2xkZXJpc2ggPSB0YXJnZXQubGVuZ3RoID4gMSAmJiB0YXJnZXQuZW5kc1dpdGgoXCIvXCIpO1xuICBjb25zdCBsb29rc1BhdGggPVxuICAgIGZvbGRlcmlzaCB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKSB8fFxuICAgIGV4dG5hbWUodGFyZ2V0KSAhPT0gXCJcIjtcbiAgaWYgKGxvb2tzUGF0aCkge1xuICAgIC8vIEFuIFVOQU5DSE9SRUQgcGF0aCAoYHNyYy9hY2Mva2l0L3gudHNgLCBgcmVwb3J0cy9hLm1kYCDigJQgbm8gYC4vYCBhbmQgbm9cbiAgICAvLyBsZWFkaW5nIGAvYCkgaXMgYW1iaWd1b3VzOiByZWxhdGl2ZSB0byB0aGUgZG9jdW1lbnQsIG9yIHRvIHRoZSBidW5kbGU/XG4gICAgLy8gQm90aCBhcmUgdHJpZWQsIGRvY3VtZW50IGZpcnN0LiBNZWFzdXJlZCBvbiB0aGUgcmVhbCB3aWtpLCB3aGVyZSBhIHJ1bGVcbiAgICAvLyBwYWdlJ3MgYGNoZWNrZXI6IHNyYy9hY2Mva2l0L2NoZWNrZXJzL+KApmAgd2FzIHJlcG9ydGVkIG1pc3Npbmcgd2hpbGVcbiAgICAvLyByZXNvbHZpbmcgZnJvbSB0aGUgYnVuZGxlIHJvb3Qgd291bGQgaGF2ZSBmb3VuZCBpdC5cbiAgICBjb25zdCBhbmNob3JlZCA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSAoXG4gICAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIilcbiAgICAgICAgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSldXG4gICAgICAgIDogYW5jaG9yZWRcbiAgICAgICAgICA/IFtub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSldXG4gICAgICAgICAgOiBbXG4gICAgICAgICAgICAgIG5vcm1hbGl6ZShyZXNvbHZlUGF0aChkaXJuYW1lKGZyb20pLCB0YXJnZXQpKSxcbiAgICAgICAgICAgICAgbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSksXG4gICAgICAgICAgICAgIC4uLihpbmRleC5yZXBvUm9vdCA/IFtub3JtYWxpemUoam9pbihpbmRleC5yZXBvUm9vdCwgdGFyZ2V0KSldIDogW10pLFxuICAgICAgICAgICAgXVxuICAgICkubWFwKHRyaW1TbGFzaCk7XG4gICAgLy8g4puUIGAubWRgIElTIEFQUEVOREVEIE9OTFkgVE8gTE9PSyBGT1IgQSBGSUxFLCBuZXZlciBiZWZvcmUgYXNraW5nIHdoZXRoZXJcbiAgICAvLyB0aGUgYmFyZSBjYW5kaWRhdGUgaXMgYSBmb2xkZXIgKCMxMjMpLiBBIGRvY3VtZW50IGJlYXRzIGEgZm9sZGVyIG9mIHRoZVxuICAgIC8vIHNhbWUgbmFtZSAoYGxvY2F0aW9uc2Agd2l0aCBib3RoIGBsb2NhdGlvbnMubWRgIGFuZCBgbG9jYXRpb25zL2ApLCB3aGljaFxuICAgIC8vIGlzIGhvdyBTdG9yeSBTdHVkaW8ncyBraXQgb3JkZXJzIGl0IHRvby5cbiAgICBjb25zdCB0cmllZCA9IGNhbmRpZGF0ZXMubWFwKChjKSA9PiAoZXh0bmFtZShjKSA9PT0gXCJcIiA/IGAke2N9Lm1kYCA6IGMpKTtcbiAgICBpZiAoIWZvbGRlcmlzaCkge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHRyaWVkKSBpZiAoaW5kZXgucGF0aHMuaW5jbHVkZXMoYykpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBjIH07XG4gICAgICBmb3IgKGNvbnN0IGMgb2YgdHJpZWQpIGlmIChpbmRleC5leGlzdHMoYykpIHJldHVybiB7IHN0YXRlOiBcIm91dHNpZGVcIiwgcGF0aDogYyB9O1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGMgb2YgY2FuZGlkYXRlcykgaWYgKGluZGV4LmlzRGlyPy4oYykpIHJldHVybiB7IHN0YXRlOiBcImZvbGRlclwiLCBwYXRoOiBjIH07XG4gICAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogKGZvbGRlcmlzaCA/IGNhbmRpZGF0ZXNbMF0gOiB0cmllZFswXSkgYXMgc3RyaW5nIH07XG4gIH1cbiAgY29uc3Qgc2xhc2ggPSB0YXJnZXQuaW5kZXhPZihcIi9cIik7XG4gIGlmIChzbGFzaCA+IDApIHtcbiAgICAvLyBgdHlwZS9zbHVnYDogdGhlIHR5cGUgaXMgYSBjbGFpbSB0aGUgdGFyZ2V0J3Mgb3duIGZyb250bWF0dGVyIG11c3QgbWFrZS5cbiAgICBjb25zdCB0eXBlID0gdGFyZ2V0LnNsaWNlKDAsIHNsYXNoKTtcbiAgICBjb25zdCBzbHVnID0gdGFyZ2V0LnNsaWNlKHNsYXNoICsgMSk7XG4gICAgZm9yIChjb25zdCBwIG9mIGluZGV4LnBhdGhzKVxuICAgICAgaWYgKHN0ZW0ocCkgPT09IHNsdWcgJiYgaW5kZXgubWV0YU9mKHApPy50eXBlID09PSB0eXBlKVxuICAgICAgICByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogcCB9O1xuICB9XG4gIGNvbnN0IGhpdCA9IGluZGV4LnBhdGhzLmZpbmQoKHApID0+IHN0ZW0ocCkgPT09IHN0ZW0odGFyZ2V0KSk7XG4gIGlmIChoaXQpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBoaXQgfTtcbiAgLy8gQSBiYXJlIG5hbWUgbm8gZG9jdW1lbnQgYW5zd2VycyBtYXkgc3RpbGwgYmUgYSBmb2xkZXIgYmVzaWRlIHRoZSBkb2N1bWVudCxcbiAgLy8gb3IgYXQgdGhlIGJ1bmRsZSByb290OiBgW3RoZSBwbGFjZXNdKGxvY2F0aW9ucylgLlxuICBmb3IgKGNvbnN0IGMgb2YgW3Jlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCksIG5vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpXSlcbiAgICBpZiAoaW5kZXguaXNEaXI/LihjKSkgcmV0dXJuIHsgc3RhdGU6IFwiZm9sZGVyXCIsIHBhdGg6IGMgfTtcbiAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdGFyZ2V0IH07XG59XG5cbi8qKiBBbiBlZGdlIGluIGEgc2V0J3MgbWFwLiBgcmVsYCBlbXB0eSBtZWFucyBubyBhc3NlcnRpb24gd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBFZGdlID0ge1xuICBmcm9tOiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRoIHdoZW4gcmVzb2x2ZWQ7IHRoZSB3cml0dGVuIHRhcmdldCB3aGVuIG5vdC4gKi9cbiAgdG86IHN0cmluZztcbiAgLyoqIEEgYm9keSBsaW5rLCBvciBhIGZyb250bWF0dGVyIHZhbHVlIOKAlCBrZXB0IGFwYXJ0LCBhcyBwZG9jcyBrZWVwcyB0aGVtLiAqL1xuICBzb3VyY2U6IFwibGlua1wiIHwgXCJmcm9udG1hdHRlclwiO1xuICAvKiogVGhlIGZyb250bWF0dGVyIGtleSB0aGF0IGNhcnJpZWQgaXQgKGByZWxhdGVkYCwgYHNvdXJjZXMucmVzb3VyY2VgLCDigKYpLiAqL1xuICBrZXk/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBGb3IgYSBCT0RZIGxpbms6IHRoZSB0YXJnZXQgYXMgd3JpdHRlbiwgYW5kIHRoZSBsaW5lIGl0IGlzIG9uLiBBYnNlbnQgZm9yIGFcbiAgICogZnJvbnRtYXR0ZXIgcmVmZXJlbmNlLCB3aGVyZSBga2V5YCBpcyB0aGUgYWRkcmVzcyBpbnN0ZWFkLlxuICAgKi9cbiAgcmF3Pzogc3RyaW5nO1xuICBsaW5lPzogbnVtYmVyO1xuICByZWw6IHN0cmluZ1tdO1xuICBzdGF0ZTogUmVzb2x1dGlvbltcInN0YXRlXCJdO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGhOb2RlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHJlbDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgc3RhbGU6IGJvb2xlYW47XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBsaW5rc091dDogbnVtYmVyO1xuICBsaW5rc0luOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIEEgYm9keSBsaW5rIHdob3NlIHNjaGVtZSBub3RoaW5nIGhlcmUgb3BlbnMgKCMxMjgpOiBPcGVyYXRvcidzIGBvcDpkb2MvPGlkPmAsXG4gKiBsZWZ0IGJlaGluZCBieSBhbiBleHBvcnQgdGhhdCBjb3VsZCBub3QgcmV3cml0ZSBpdC4gSXQgbmFtZXMgbm8gZmlsZSwgc28gaXRcbiAqIGlzIG5vdCBhbiBlZGdlIGFuZCBub3QgYG1pc3NpbmdgOyBpdCBpcyBrZXB0IGFwYXJ0IHNvIGl0IGNhbiBiZSByZXBvcnRlZC5cbiAqL1xuZXhwb3J0IHR5cGUgVW5zdXBwb3J0ZWRMaW5rID0ge1xuICBmcm9tOiBzdHJpbmc7XG4gIC8qKiBUaGUgdGFyZ2V0IGV4YWN0bHkgYXMgd3JpdHRlbi4gKi9cbiAgcmF3OiBzdHJpbmc7XG4gIC8qKiBUaGUgYm9keSBsaW5lIGl0IGlzIG9uLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBMb3dlci1jYXNlZCwgd2l0aG91dCBpdHMgY29sb246IGBvcGAuICovXG4gIHNjaGVtZTogc3RyaW5nO1xuICByZWw6IHN0cmluZ1tdO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGggPSB7XG4gIHJvb3Q6IHN0cmluZztcbiAgbm9kZXM6IEdyYXBoTm9kZVtdO1xuICBlZGdlczogRWRnZVtdO1xuICAvKiogVGFyZ2V0cyBub3RoaW5nIGluIHRoZSBidW5kbGUgYW5zd2VycyDigJQgc2FpZCwgbmV2ZXIgYW4gZXJyb3IgKE9LRiDCpzExKS4gKi9cbiAgZGFuZ2xpbmc6IG51bWJlcjtcbiAgLyoqXG4gICAqIEJvZHkgbGlua3Mgd2l0aCBhIHNjaGVtZSB0aGUgc3VyZmFjZSBzdHJpa2VzIHRocm91Z2ggKGFueXRoaW5nIGJ1dCBodHRwLFxuICAgKiBodHRwcyBhbmQgbWFpbHRvKS4gVGhleSB3ZXJlIGRyb3BwZWQgdW5zZWVuIGJlZm9yZSAjMTI4LCB3aGlsZSB0aGUgcmVhZGVyXG4gICAqIGNvdWxkIHNlZSB0aGV5IHdlcmUgZGVhZC5cbiAgICovXG4gIHVuc3VwcG9ydGVkOiBVbnN1cHBvcnRlZExpbmtbXTtcbn07XG5cbi8qKiBCdWlsZCBhIHNldCdzIG1hcDogbm9kZXMgYXJlIGl0cyBkb2N1bWVudHMsIGVkZ2VzIGFyZSB0aGUgZm91ciBzb3VyY2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR3JhcGgoaW5kZXg6IEJ1bmRsZUluZGV4LCBib2R5T2Y6IChwYXRoOiBzdHJpbmcpID0+IHN0cmluZywgY2FwID0gNDAwKTogR3JhcGgge1xuICBjb25zdCBwYXRocyA9IGluZGV4LnBhdGhzLnNsaWNlKDAsIGNhcCk7XG4gIGNvbnN0IGVkZ2VzOiBFZGdlW10gPSBbXTtcbiAgY29uc3QgdW5zdXBwb3J0ZWQ6IFVuc3VwcG9ydGVkTGlua1tdID0gW107XG4gIGZvciAoY29uc3QgZnJvbSBvZiBwYXRocykge1xuICAgIGNvbnN0IG1ldGEgPSBpbmRleC5tZXRhT2YoZnJvbSk7XG4gICAgZm9yIChjb25zdCBsaW5rIG9mIGV4dHJhY3RMaW5rcyhib2R5T2YoZnJvbSksIHsgc2NoZW1lczogdHJ1ZSB9KSkge1xuICAgICAgaWYgKGxpbmsuc2NoZW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKCFPUEVOU19PVVRXQVJELmhhcyhsaW5rLnNjaGVtZSkpXG4gICAgICAgICAgdW5zdXBwb3J0ZWQucHVzaCh7XG4gICAgICAgICAgICBmcm9tLFxuICAgICAgICAgICAgcmF3OiBsaW5rLnJhdyxcbiAgICAgICAgICAgIGxpbmU6IGxpbmsubGluZSxcbiAgICAgICAgICAgIHNjaGVtZTogbGluay5zY2hlbWUsXG4gICAgICAgICAgICByZWw6IGxpbmsucmVsLFxuICAgICAgICAgIH0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KGxpbmsudGFyZ2V0LCBmcm9tLCBpbmRleCk7XG4gICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgZnJvbSxcbiAgICAgICAgdG86IHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8gci50cmllZCA6IHIucGF0aCxcbiAgICAgICAgc291cmNlOiBcImxpbmtcIixcbiAgICAgICAgcmF3OiBsaW5rLnJhdyxcbiAgICAgICAgbGluZTogbGluay5saW5lLFxuICAgICAgICByZWw6IGxpbmsucmVsLFxuICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHJlZiBvZiBtZXRhID8gZmllbGRSZWZzKG1ldGEuZmllbGRzKSA6IFtdKSB7XG4gICAgICBjb25zdCByID0gcmVzb2x2ZVRhcmdldChyZWYudmFsdWUsIGZyb20sIGluZGV4KTtcbiAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICBmcm9tLFxuICAgICAgICB0bzogci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyByLnRyaWVkIDogci5wYXRoLFxuICAgICAgICBzb3VyY2U6IFwiZnJvbnRtYXR0ZXJcIixcbiAgICAgICAga2V5OiByZWYua2V5LFxuICAgICAgICByZWw6IFtdLFxuICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICBjb25zdCBvdXRPZiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGNvbnN0IGludG9PZiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgZSBvZiBlZGdlcykge1xuICAgIG91dE9mLnNldChlLmZyb20sIChvdXRPZi5nZXQoZS5mcm9tKSA/PyAwKSArIDEpO1xuICAgIGlmIChlLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSBpbnRvT2Yuc2V0KGUudG8sIChpbnRvT2YuZ2V0KGUudG8pID8/IDApICsgMSk7XG4gIH1cbiAgY29uc3Qgbm9kZXM6IEdyYXBoTm9kZVtdID0gcGF0aHMubWFwKChwYXRoKSA9PiB7XG4gICAgY29uc3QgbWV0YSA9IGluZGV4Lm1ldGFPZihwYXRoKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aCxcbiAgICAgIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShpbmRleC5yb290LCBwYXRoKSksXG4gICAgICB0aXRsZTogbWV0YT8udGl0bGUgPz8gc3RlbShwYXRoKSxcbiAgICAgIC4uLihtZXRhPy50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAgIHN0YXR1czogbWV0YT8uc3RhdHVzID8/IFwic3RhYmxlXCIsXG4gICAgICBzdGFsZTogbWV0YT8uc3RhbGUgPz8gZmFsc2UsXG4gICAgICB0YWdzOiBtZXRhPy50YWdzID8/IFtdLFxuICAgICAgbGlua3NPdXQ6IG91dE9mLmdldChwYXRoKSA/PyAwLFxuICAgICAgbGlua3NJbjogaW50b09mLmdldChwYXRoKSA/PyAwLFxuICAgIH07XG4gIH0pO1xuICByZXR1cm4ge1xuICAgIHJvb3Q6IGluZGV4LnJvb3QsXG4gICAgbm9kZXMsXG4gICAgZWRnZXMsXG4gICAgZGFuZ2xpbmc6IGVkZ2VzLmZpbHRlcigoZSkgPT4gZS5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIpLmxlbmd0aCxcbiAgICB1bnN1cHBvcnRlZCxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIiwKICAgICIvLyBGaW5kaW5nIHRoaW5ncyBhY3Jvc3MgZXZlcnl0aGluZyBpbiB0aGUgY29udGV4dCAoRTU5KS5cbi8vXG4vLyDim5QgVFdPIE1BVENIRVJTLCBPTiBQVVJQT1NFLCBiZWNhdXNlIHRoZXkgYW5zd2VyIGRpZmZlcmVudCBxdWVzdGlvbnMuIE5vdGVcbi8vIGFwcHMgc3BsaXQgdGhlc2UgYW5kIGl0IGlzIG5vdCBhbiBhY2NpZGVudDogRlVaWlkgb24gbmFtZXMgaXMgZm9yIGp1bXBpbmdcbi8vIChcIm1hYmFrXCIg4oaSIE1hcmVuJ3MgQmFrZXJ5KSwgYW5kIEVYQUNUIG9uIGNvbnRlbnQgaXMgZm9yIGZpbmRpbmcgKFwid2hlcmUgZGlkIElcbi8vIHNheSAnYXNraW5nLW5pY2VseSdcIikuIEZ1enp5IGZ1bGwtdGV4dCB3b3VsZCBiZSB0aGUgd29yc3Qgb2YgYm90aCDigJQgc2VhcmNoaW5nXG4vLyBgYnJpZGdlYCB3b3VsZCBzdXJmYWNlIGRvY3VtZW50cyB0aGF0IG1lcmVseSBjb250YWluIHNpbWlsYXItbG9va2luZyBsZXR0ZXJzLFxuLy8gYW5kIHlvdSBjb3VsZCBubyBsb25nZXIgdHJ1c3QgXCJ0aGlzIHBocmFzZSBpcyBvbiBsaW5lIDI5XCIsIHdoaWNoIGlzIHRoZSBvbmx5XG4vLyB0aGluZyBhIGNvbnRlbnQgc2VhcmNoIGlzIGZvci4gKENvbGUgcmFpc2VkIEZ1c2UgZm9yIHRoZSBuYW1lIGhhbGYgYW5kIGNob3NlXG4vLyB0aGUgaGFuZC1yb2xsZWQgc2NvcmVyOiB0aGVyZSBpcyBubyBzZWNvbmQgZW5naW5lIHRoaXMgaGFzIHRvIGFncmVlIHdpdGgsIHNvXG4vLyBmdXp6eSByYW5raW5nIGlzIGEgc2VsZi1jb250YWluZWQgdGFzdGUganVkZ21lbnQgd2l0aCBubyBkcmlmdCByaXNrLilcbi8vXG4vLyDimqAgQU5EIElUIFNFQVJDSEVTIFdIQVQgVEhFIEhVTUFOIElTIExPT0tJTkcgQVQsIHdoaWNoIGlzIG5vdCBhbHdheXMgdGhlIGZpbGUuXG4vLyBBIGRvY3VtZW50IG9wZW4gaW4gdGhlIHNlc3Npb24gaXMgc2hvd24gYXMgaXRzIEFDVElWRSBWRVJTSU9OLCB3aGljaCBsaXZlc1xuLy8gdW5kZXIgdGhlIHNlc3Npb24gaG9tZSByYXRoZXIgdGhhbiBhdCB0aGUgb3JpZ2luYWwgcGF0aCDigJQgc28gYW4gZWRpdCBtYWRlIHR3b1xuLy8gbWludXRlcyBhZ28gbXVzdCBzdGlsbCBiZSBmaW5kYWJsZS4gVGhhdCBhc3ltbWV0cnkgaXMgYWxzbyB0aGUgcmVhc29uIHRoaXNcbi8vIGV4aXN0cyBmb3IgdGhlIEFHRU5UIGF0IGFsbDogZ3JlcCBvdmVyIHRoZSB3b3Jrc3BhY2UgZmluZHMgdGhlIFNBVkVEIGZpbGUgYW5kXG4vLyBzaWxlbnRseSBtaXNzZXMgdGhlIHZlcnNpb24gYmVpbmcgcmVhZC4gVGhlIGNhbGxlciBzdXBwbGllcyB0aGUgdGV4dCBwZXJcbi8vIGRvY3VtZW50IGZvciBleGFjdGx5IHRoaXMgcmVhc29uIChzZWUgYFNlc3Npb24uc2VhcmNoQWxsYCkuXG5cbi8qKiBPbmUgbGluZSB0aGF0IG1hdGNoZWQsIHdpdGggdGhlIG9mZnNldHMgb2YgdGhlIGhpdCBpbnNpZGUgdGhlIGRvY3VtZW50LiAqL1xuZXhwb3J0IHR5cGUgSGl0ID0ge1xuICAvKiogMS1iYXNlZCwgc28gaXQgY2FuIGJlIHNob3duIGFuZCBvcGVuZWQuICovXG4gIGxpbmU6IG51bWJlcjtcbiAgLyoqIFRoZSBsaW5lLCBmb3IgY29udGV4dCBpbiB0aGUgcmVzdWx0IGxpc3QuICovXG4gIHRleHQ6IHN0cmluZztcbiAgLyoqIE9mZnNldHMgb2YgdGhlIG1hdGNoIHdpdGhpbiB0aGUgZG9jdW1lbnQsIGZvciByZXZlYWwtYW5kLXNlbGVjdC4gKi9cbiAgZnJvbTogbnVtYmVyO1xuICB0bzogbnVtYmVyO1xufTtcblxuLyoqXG4gKiBIb3cgbXVjaCBvZiBhIGxpbmUgaXMgd29ydGggY2FycnlpbmcgYmFjay4gQSByZXN1bHQgbGlzdCBpcyBhIGxpc3QsIGFuZCBhXG4gKiBkb2N1bWVudCB3aXRoIGEgNCwwMDAtY2hhcmFjdGVyIHBhcmFncmFwaCBzaG91bGQgbm90IHNlbmQgYWxsIG9mIGl0IHBlciBoaXQuXG4gKi9cbmNvbnN0IExJTkVfQ0FQID0gMjQwO1xuXG4vKiogRXZlcnkgbWF0Y2ggb2YgYHF1ZXJ5YCBpbiBgdGV4dGAsIGF0IG1vc3QgYGxpbWl0YCBvZiB0aGVtLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlYXJjaFRleHQodGV4dDogc3RyaW5nLCBxdWVyeTogc3RyaW5nLCBsaW1pdCA9IDUwKTogSGl0W10ge1xuICBjb25zdCBuZWVkbGUgPSBxdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5lZWRsZSA9PT0gXCJcIiB8fCBsaW1pdCA8PSAwKSByZXR1cm4gW107XG4gIGNvbnN0IGhheSA9IHRleHQudG9Mb3dlckNhc2UoKTtcbiAgbGV0IGF0ID0gaGF5LmluZGV4T2YobmVlZGxlKTtcbiAgaWYgKGF0ID09PSAtMSkgcmV0dXJuIFtdO1xuICAvLyBMaW5lIHN0YXJ0cywgd2Fsa2VkIE9OQ0UuIEEgcGVyLWhpdCBgbGFzdEluZGV4T2YoXCJcXG5cIilgIGlzIHF1YWRyYXRpYyBvdmVyIGFcbiAgLy8gZG9jdW1lbnQgdGhhdCBtYXRjaGVzIG9uIGV2ZXJ5IGxpbmUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGRvY3VtZW50IHNvbWVvbmVcbiAgLy8gc2VhcmNoZXMgZm9yIGEgY29tbW9uIHdvcmQuXG4gIGNvbnN0IHN0YXJ0czogbnVtYmVyW10gPSBbMF07XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdGV4dC5sZW5ndGg7IGkrKykgaWYgKHRleHQuY2hhckNvZGVBdChpKSA9PT0gMTApIHN0YXJ0cy5wdXNoKGkgKyAxKTtcbiAgY29uc3QgaGl0czogSGl0W10gPSBbXTtcbiAgbGV0IGN1cnNvciA9IDA7XG4gIHdoaWxlIChhdCAhPT0gLTEgJiYgaGl0cy5sZW5ndGggPCBsaW1pdCkge1xuICAgIHdoaWxlIChjdXJzb3IgKyAxIDwgc3RhcnRzLmxlbmd0aCAmJiAoc3RhcnRzW2N1cnNvciArIDFdIGFzIG51bWJlcikgPD0gYXQpIGN1cnNvcisrO1xuICAgIGNvbnN0IGxpbmVTdGFydCA9IHN0YXJ0c1tjdXJzb3JdIGFzIG51bWJlcjtcbiAgICBjb25zdCBsaW5lRW5kID0gY3Vyc29yICsgMSA8IHN0YXJ0cy5sZW5ndGggPyAoc3RhcnRzW2N1cnNvciArIDFdIGFzIG51bWJlcikgLSAxIDogdGV4dC5sZW5ndGg7XG4gICAgY29uc3Qgd2hvbGUgPSB0ZXh0LnNsaWNlKGxpbmVTdGFydCwgbGluZUVuZCk7XG4gICAgaGl0cy5wdXNoKHtcbiAgICAgIGxpbmU6IGN1cnNvciArIDEsXG4gICAgICB0ZXh0OiB3aG9sZS5sZW5ndGggPiBMSU5FX0NBUCA/IGAke3dob2xlLnNsaWNlKDAsIExJTkVfQ0FQIC0gMSl94oCmYCA6IHdob2xlLFxuICAgICAgZnJvbTogYXQsXG4gICAgICB0bzogYXQgKyBuZWVkbGUubGVuZ3RoLFxuICAgIH0pO1xuICAgIC8vIOKaoCBBRFZBTkNFIFBBU1QgVEhFIE1BVENILCBOT1QgVEhFIExJTkU6IHR3byBoaXRzIG9uIG9uZSBsaW5lIGFyZSB0d29cbiAgICAvLyBoaXRzLCBhbmQgc3RlcHBpbmcgYnkgbGluZSB3b3VsZCBzaWxlbnRseSBkcm9wIHRoZSBzZWNvbmQuXG4gICAgYXQgPSBoYXkuaW5kZXhPZihuZWVkbGUsIGF0ICsgbmVlZGxlLmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGhpdHM7XG59XG5cbi8qKiBJcyB0aGlzIGNoYXJhY3RlciBhIHdvcmQgYm91bmRhcnkgZm9yIHNjb3JpbmcgcHVycG9zZXM/ICovXG5mdW5jdGlvbiBpc0JvdW5kYXJ5KGNoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGNoID09PSBcIiBcIiB8fCBjaCA9PT0gXCItXCIgfHwgY2ggPT09IFwiX1wiIHx8IGNoID09PSBcIi9cIiB8fCBjaCA9PT0gXCIuXCIgfHwgY2ggPT09IFwiJ1wiO1xufVxuXG4vKipcbiAqIEhvdyB3ZWxsIGBuYW1lYCBtYXRjaGVzIGBxdWVyeWAgYXMgYSBmdXp6eSBzdWJzZXF1ZW5jZSDigJQgaGlnaGVyIGlzIGJldHRlcixcbiAqIGBudWxsYCB3aGVuIHRoZSBxdWVyeSdzIGNoYXJhY3RlcnMgZG8gbm90IGFwcGVhciBpbiBvcmRlciBhdCBhbGwuXG4gKlxuICogVGhlIHdlaWdodHMgZW5jb2RlIHdoYXQgc29tZW9uZSB0eXBpbmcgaW50byBhIGp1bXAgYm94IG1lYW5zOlxuICpcbiAqIC0gKipjb250aWd1aXR5KiogZG9taW5hdGVzLCBiZWNhdXNlIGBtYXJlYCBtZWFuaW5nIGBNYXJlbmAgaXMgdGhlIGNvbW1vbiBjYXNlXG4gKiAgIGFuZCBgbeKApmHigKZy4oCmZWAgc2NhdHRlcmVkIHRocm91Z2ggYSBzZW50ZW5jZSBpcyB0aGUgcmFyZSBvbmU7XG4gKiAtICoqd29yZCBzdGFydHMqKiBzY29yZSwgc28gYG1iYCBmaW5kcyBgTWFyZW4ncyBCYWtlcnlgIHJhdGhlciB0aGFuIGBOdW1iZXJgO1xuICogLSAqKmVhcmxpZXIgaXMgYmV0dGVyKiosIGFuZCBhICoqc2hvcnRlciBuYW1lKiogd2lucyBhIHRpZSwgYmVjYXVzZSB0aGUgdGhpbmdcbiAqICAgeW91IG1lYW50IGlzIHVzdWFsbHkgdGhlIHRoaW5nIHdpdGggbGVzcyBhcm91bmQgaXQuXG4gKlxuICog4pqgIFRIRSBOVU1CRVJTIEFSRSBUQVNURSwgTk9UIFRSVVRILiBUaGV5IGFyZSBwaW5uZWQgYnkgY2VsbHMgdGhhdCBhc3NlcnRcbiAqIE9SREVSSU5HUyAoXCJ0aGlzIGJlYXRzIHRoYXRcIikgcmF0aGVyIHRoYW4gdmFsdWVzLCBzbyB0aGV5IGNhbiBiZSByZXR1bmVkXG4gKiB3aXRob3V0IHJld3JpdGluZyB0aGUgdGVzdHMg4oCUIHdoaWNoIGlzIHRoZSBvbmx5IHdheSBhIHNjb3JlciBsaWtlIHRoaXMgc3RheXNcbiAqIGNoYW5nZWFibGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY29yZU5hbWUobmFtZTogc3RyaW5nLCBxdWVyeTogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IHEgPSBxdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKHEgPT09IFwiXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBoYXkgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIGxldCBzY29yZSA9IDA7XG4gIGxldCBhdCA9IDA7XG4gIGxldCBydW4gPSAwO1xuICBmb3IgKGNvbnN0IGNoIG9mIHEpIHtcbiAgICBjb25zdCBmb3VuZCA9IGhheS5pbmRleE9mKGNoLCBhdCk7XG4gICAgaWYgKGZvdW5kID09PSAtMSkgcmV0dXJuIG51bGw7XG4gICAgcnVuID0gZm91bmQgPT09IGF0ICYmIGF0ID4gMCA/IHJ1biArIDEgOiAwO1xuICAgIHNjb3JlICs9IDEwICsgcnVuICogMTI7XG4gICAgaWYgKGZvdW5kID09PSAwIHx8IGlzQm91bmRhcnkoaGF5W2ZvdW5kIC0gMV0gYXMgc3RyaW5nKSkgc2NvcmUgKz0gMTQ7XG4gICAgLy8gRGlzdGFuY2UgZnJvbSB3aGVyZSB3ZSB3ZXJlIGxvb2tpbmcgY29zdHMsIHNvIHNjYXR0ZXJlZCBtYXRjaGVzIHJhbmsgbG93LlxuICAgIHNjb3JlIC09IE1hdGgubWluKGZvdW5kIC0gYXQsIDEyKTtcbiAgICBhdCA9IGZvdW5kICsgMTtcbiAgfVxuICAvLyBBIHdob2xlLXdvcmQgc3Vic3RyaW5nIGlzIHRoZSBzdHJvbmdlc3Qgc2lnbmFsIHRoZXJlIGlzOyBzYXkgc28gbG91ZGx5LlxuICBpZiAoaGF5LmluY2x1ZGVzKHEpKSBzY29yZSArPSA0MDtcbiAgaWYgKGhheS5zdGFydHNXaXRoKHEpKSBzY29yZSArPSAyNTtcbiAgLy8gU2hvcnRlciBuYW1lcyB3aW4gdGllcy5cbiAgc2NvcmUgLT0gTWF0aC5taW4obmFtZS5sZW5ndGgsIDQwKSAvIDQ7XG4gIHJldHVybiBzY29yZTtcbn1cblxuLyoqIEEgZG9jdW1lbnQgdGhlIE5BTUUgbWF0Y2hlZC4gKi9cbmV4cG9ydCB0eXBlIE5hbWVNYXRjaCA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzbHVnPzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBzY29yZTogbnVtYmVyO1xufTtcblxuLyoqXG4gKiDim5QgVEhFIFNXQVAgU0VBTSAoQ29sZSk6IFwiaWYgd2UgZmluZCB0aGF0IGFjdHVhbGx5IHdlIHNob3VsZCB1c2UgRnVzZSwgaXQnc1xuICogZmFpcmx5IGVhc3kgdG8gcmVwbGFjZS5cIlxuICpcbiAqIFRoZSBpbnRlcmZhY2UgaXMgQ09SUFVTLVNIQVBFRCDigJQgdGFrZSB0aGUgd2hvbGUgY2FuZGlkYXRlIGxpc3QgYW5kIGEgcXVlcnksXG4gKiByZXR1cm4gYSByYW5rZWQgc2xpY2Ug4oCUIGFuZCB0aGF0IHNoYXBlIGlzIHRoZSB3aG9sZSBwb2ludC4gQSBwZXItaXRlbVxuICogYHNjb3JlKG5hbWUsIHF1ZXJ5KWAgaG9vayB3b3VsZCBoYXZlIGxvb2tlZCBsaWtlIHRoZSBzbWFsbGVyIGFic3RyYWN0aW9uIGFuZFxuICogd291bGQgaGF2ZSBGT1VHSFQgdGhlIHZlcnkgbGlicmFyeSBpdCBleGlzdHMgdG8gYWRtaXQ6IEZ1c2UgaW5kZXhlcyBhIGxpc3RcbiAqIGFuZCBzZWFyY2hlcyBpdCwgaXQgZG9lcyBub3Qgc2NvcmUgb25lIHN0cmluZyBhdCBhIHRpbWUuIFdyaXR0ZW4gdGhpcyB3YXksXG4gKiBtb3ZpbmcgdG8gRnVzZSBpcyBhIG5ldyBmdW5jdGlvbiBhbmQgb25lIGRlZmF1bHQgY2hhbmdlZDpcbiAqXG4gKiAgICAgY29uc3QgZnVzZU5hbWVzOiBOYW1lU2VhcmNoID0gKGNhbmRpZGF0ZXMsIHF1ZXJ5LCBsaW1pdCkgPT4ge1xuICogICAgICAgY29uc3QgZnVzZSA9IG5ldyBGdXNlKGNhbmRpZGF0ZXMsIHsga2V5czogW1wibmFtZVwiLCBcInRpdGxlXCJdLCDigKYgfSk7XG4gKiAgICAgICByZXR1cm4gZnVzZS5zZWFyY2gocXVlcnksIHsgbGltaXQgfSkubWFwKOKApik7XG4gKiAgICAgfTtcbiAqXG4gKiBOb3RoaW5nIGVsc2UgaW4gdGhpcyBtb2R1bGUsIHRoZSBzZXNzaW9uLCB0aGUgd2lyZSBvciB0aGUgc3VyZmFjZSBtb3Zlcy5cbiAqL1xuZXhwb3J0IHR5cGUgTmFtZVNlYXJjaCA9IChcbiAgY2FuZGlkYXRlczogcmVhZG9ubHkgQ2FuZGlkYXRlW10sXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIGxpbWl0OiBudW1iZXIsXG4pID0+IE5hbWVNYXRjaFtdO1xuXG4vKiogQSBkb2N1bWVudCB0aGUgQ09OVEVOVCBtYXRjaGVkLiAqL1xuZXhwb3J0IHR5cGUgVGV4dE1hdGNoID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdmVyc2lvbj86IG51bWJlcjtcbiAgaGl0czogSGl0W107XG59O1xuXG5leHBvcnQgdHlwZSBTZWFyY2hSZXBvcnQgPSB7XG4gIHF1ZXJ5OiBzdHJpbmc7XG4gIC8qKiBOYW1lL3RpdGxlIG1hdGNoZXMsIGJlc3QgZmlyc3Qg4oCUIHRoZSBqdW1wIGxpc3QuICovXG4gIGRvY3VtZW50czogTmFtZU1hdGNoW107XG4gIC8qKiBDb250ZW50IG1hdGNoZXMsIGluIGNvbnRleHQgb3JkZXIg4oCUIHRoZSBmaW5kIGxpc3QuICovXG4gIHRleHQ6IFRleHRNYXRjaFtdO1xuICAvKiogVG90YWwgY29udGVudCBoaXRzIHJlcG9ydGVkLiAqL1xuICBjb3VudDogbnVtYmVyO1xuICAvKiogVHJ1ZSB3aGVuIGEgY2FwIHN0b3BwZWQgdGhlIHNlYXJjaCBlYXJseSwgc28gXCIzXCIgYW5kIFwiMyBvZiBtb3JlXCIgZGlmZmVyLiAqL1xuICB0cnVuY2F0ZWQ6IGJvb2xlYW47XG59O1xuXG4vKiogUGVyLWRvY3VtZW50IGNvbnRlbnQgY2FwLCBzbyBvbmUgZW5vcm1vdXMgZG9jdW1lbnQgY2Fubm90IGZpbGwgdGhlIHJlcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBQRVJfRE9DID0gMjA7XG4vKiogV2hvbGUtcmVwb3J0IGNvbnRlbnQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFRPVEFMID0gMjAwO1xuLyoqIEhvdyBtYW55IG5hbWUgbWF0Y2hlcyBhcmUgd29ydGggc2hvd2luZy4gKi9cbmV4cG9ydCBjb25zdCBOQU1FUyA9IDEwO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0IGBOYW1lU2VhcmNoYDogYHNjb3JlTmFtZWAgb3ZlciBldmVyeSBjYW5kaWRhdGUsIHJhbmtlZC5cbiAqXG4gKiBBIGRvY3VtZW50J3MgVElUTEUgaXMgbWF0Y2hlZCBhcyB3ZWxsIGFzIGl0cyBmaWxlbmFtZSDigJQgYW4gT0tGIGRvY3VtZW50J3NcbiAqIG5hbWUgYW5kIHRpdGxlIG9mdGVuIGRpZmZlciBhbmQgdGhlIGh1bWFuIG1heSByZW1lbWJlciBlaXRoZXIg4oCUIGFuZCB0aGVcbiAqIGJldHRlciBvZiB0aGUgdHdvIHNjb3JlcyBpcyB0aGUgb25lIHRoYXQgY291bnRzLlxuICovXG5leHBvcnQgY29uc3QgcmFua05hbWVzOiBOYW1lU2VhcmNoID0gKGNhbmRpZGF0ZXMsIHF1ZXJ5LCBsaW1pdCkgPT4ge1xuICBjb25zdCBvdXQ6IE5hbWVNYXRjaFtdID0gW107XG4gIGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgYnlOYW1lID0gc2NvcmVOYW1lKGMubmFtZSwgcXVlcnkpO1xuICAgIGNvbnN0IGJ5VGl0bGUgPSBjLnRpdGxlID09PSB1bmRlZmluZWQgPyBudWxsIDogc2NvcmVOYW1lKGMudGl0bGUsIHF1ZXJ5KTtcbiAgICBpZiAoYnlOYW1lID09PSBudWxsICYmIGJ5VGl0bGUgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIHBhdGg6IGMucGF0aCxcbiAgICAgIC4uLihjLnNsdWcgIT09IHVuZGVmaW5lZCA/IHsgc2x1ZzogYy5zbHVnIH0gOiB7fSksXG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICAuLi4oYy50aXRsZSAhPT0gdW5kZWZpbmVkID8geyB0aXRsZTogYy50aXRsZSB9IDoge30pLFxuICAgICAgc2NvcmU6IE1hdGgubWF4KGJ5TmFtZSA/PyAtSW5maW5pdHksIGJ5VGl0bGUgPz8gLUluZmluaXR5KSxcbiAgICB9KTtcbiAgfVxuICBvdXQuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUgfHwgYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSk7XG4gIHJldHVybiBvdXQuc2xpY2UoMCwgbGltaXQpO1xufTtcblxuZXhwb3J0IHR5cGUgQ2FuZGlkYXRlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgYmFzZW5hbWUsIHdoaWNoIGlzIHdoYXQgYSBodW1hbiB0eXBlcyBhdC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICBzbHVnPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgdmVyc2lvbj86IG51bWJlcjtcbn07XG5cbi8qKlxuICogU2VhcmNoIGEgbGlzdCBvZiBjYW5kaWRhdGVzIGZvciBib3RoIGtpbmRzIG9mIG1hdGNoLlxuICpcbiAqIGByZWFkYCBtYXkgdGhyb3cgb3IgcmV0dXJuIG51bGwgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgYmVlbiBkZWxldGVkIHVuZGVyXG4gKiB0aGUgY29udGV4dCDigJQgYSBzZWFyY2ggaXMgbm90IHRoZSBtb21lbnQgdG8gZmFpbCBvdmVyIHRoYXQsIHNvIGl0IGlzIHNraXBwZWRcbiAqIHJhdGhlciB0aGFuIHJlcG9ydGVkIGFzIGEgZG9jdW1lbnQgd2l0aCBubyBoaXRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VhcmNoRG9jdW1lbnRzKFxuICBjYW5kaWRhdGVzOiByZWFkb25seSBDYW5kaWRhdGVbXSxcbiAgcXVlcnk6IHN0cmluZyxcbiAgcmVhZDogKGM6IENhbmRpZGF0ZSkgPT4gc3RyaW5nIHwgbnVsbCxcbiAgY2FwczogeyBwZXJEb2M/OiBudW1iZXI7IHRvdGFsPzogbnVtYmVyOyBuYW1lcz86IG51bWJlcjsgbmFtZVNlYXJjaD86IE5hbWVTZWFyY2ggfSA9IHt9LFxuKTogU2VhcmNoUmVwb3J0IHtcbiAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKTtcbiAgaWYgKHEgPT09IFwiXCIpIHJldHVybiB7IHF1ZXJ5OiBcIlwiLCBkb2N1bWVudHM6IFtdLCB0ZXh0OiBbXSwgY291bnQ6IDAsIHRydW5jYXRlZDogZmFsc2UgfTtcbiAgY29uc3QgcGVyRG9jID0gY2Fwcy5wZXJEb2MgPz8gUEVSX0RPQztcbiAgY29uc3QgdG90YWwgPSBjYXBzLnRvdGFsID8/IFRPVEFMO1xuICBjb25zdCBuYW1lcyA9IGNhcHMubmFtZXMgPz8gTkFNRVM7XG5cbiAgY29uc3Qgc2NvcmVkID0gKGNhcHMubmFtZVNlYXJjaCA/PyByYW5rTmFtZXMpKGNhbmRpZGF0ZXMsIHEsIG5hbWVzKTtcblxuICBjb25zdCB0ZXh0OiBUZXh0TWF0Y2hbXSA9IFtdO1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKGNvdW50ID49IHRvdGFsKSB7XG4gICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGxldCBib2R5OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgYm9keSA9IHJlYWQoYyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBib2R5ID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKGJvZHkgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJvb20gPSBNYXRoLm1pbihwZXJEb2MsIHRvdGFsIC0gY291bnQpO1xuICAgIGNvbnN0IGhpdHMgPSBzZWFyY2hUZXh0KGJvZHksIHEsIHJvb20gKyAxKTtcbiAgICBpZiAoaGl0cy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIGlmIChoaXRzLmxlbmd0aCA+IHJvb20pIHRydW5jYXRlZCA9IHRydWU7XG4gICAgY29uc3Qga2VwdCA9IGhpdHMuc2xpY2UoMCwgcm9vbSk7XG4gICAgY291bnQgKz0ga2VwdC5sZW5ndGg7XG4gICAgdGV4dC5wdXNoKHtcbiAgICAgIHBhdGg6IGMucGF0aCxcbiAgICAgIC4uLihjLnNsdWcgIT09IHVuZGVmaW5lZCA/IHsgc2x1ZzogYy5zbHVnIH0gOiB7fSksXG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICAuLi4oYy52ZXJzaW9uICE9PSB1bmRlZmluZWQgPyB7IHZlcnNpb246IGMudmVyc2lvbiB9IDoge30pLFxuICAgICAgaGl0czoga2VwdCxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7IHF1ZXJ5OiBxLCBkb2N1bWVudHM6IHNjb3JlZCwgdGV4dCwgY291bnQsIHRydW5jYXRlZCB9O1xufVxuIiwKICAgICIvLyBJcyB0aGUgaHVtYW4gd2FpdGluZyBvbiBhbiBhbnN3ZXIsIGFuZCBmb3IgaG93IGxvbmcgKEU1Myk/XG4vL1xuLy8g4puUIERFUklWRUQsIE5PVCBERUNMQVJFRCDigJQgQ29sZSdzIHJ1bGluZywgYW5kIHRoZSByZWFzb24gaXMgbG9hZC1iZWFyaW5nOiBcIndlXG4vLyBjb3VsZCBhZGQgc29tZSBhZmZvcmRhbmNlIHRoYXQgc2VuZHMgYSBjaGVjay1pbiB3aXRoIGFuIGFnZW504oCmIHdoZXJlIHdlJ3JlXG4vLyBub3QgYWRkaW5nIG1vcmUgdGFza3MgZm9yIHRoZSBhZ2VudCB0byBoYXZlIHRvIGV4cGxpY2l0bHkgZG8uXCIgQW4gYWdlbnQgdGhhdFxuLy8gbXVzdCByZW1lbWJlciB0byBzYXkgXCJ0aGlua2luZ1wiIHdpbGwgZm9yZ2V0IGV4YWN0bHkgd2hlbiBpdCBtYXR0ZXJzIOKAlCBpdCBpc1xuLy8gYnVzeSwgd2hpY2ggaXMgdGhlIHdob2xlIHNpdHVhdGlvbiBiZWluZyBzaWduYWxsZWQuIFNvIG5vdGhpbmcgaGVyZSBhc2tzIHRoZVxuLy8gYWdlbnQgZm9yIGFueXRoaW5nLiBUaGUgc3RhdGUgaXMgcmVhZCBvZmYgdGhlIGNvbnZlcnNhdGlvbjogYSBodW1hbiBtZXNzYWdlXG4vLyB3aXRoIG5vIGFnZW50IG1lc3NhZ2UgYWZ0ZXIgaXQgaXMgYSBodW1hbiB3YWl0aW5nLlxuLy9cbi8vIOKblCBBTkQgVEhFIEFHRU5UJ1MgUkVQTFkgSVMgVEhFIENPTVBMRVRJT04gU0lHTkFMLCB3aGljaCBpcyBtaW5kLW1hcHBlcidzXG4vLyBydWxlIChSMTEgU0VBTSAyKSBhbmQgaXMgc3RvbGVuIGRlbGliZXJhdGVseS4gVGhlcmUgaXMgbm8gYGRvbmVgIHN0YXRlIHRvXG4vLyBlbWl0LCBzbyB0aGVyZSBpcyBubyBgZG9uZWAgc3RhdGUgdG8gZ2V0IG91dCBvZiBzeW5jLiBPbmUgY29uc2VxdWVuY2Ugd29ydGhcbi8vIG5hbWluZyBiZWNhdXNlIGl0IGZlbGwgb3V0IGZvciBmcmVlOiBgc3RhcnRUYXNrYCBwb3N0cyBpdHMgYW5ub3VuY2VtZW50IEFTXG4vLyBUSEUgQUdFTlQgKEU1MCksIHNvIHRoZSBoYXBweSBwYXRoIENvbGUgZGVzY3JpYmVkIOKAlCBcImdyZWF0LCBJJ20gZ29pbmcgdG8gZ2V0XG4vLyB0aGF0IHN0YXJ0ZWRcIiwgdGhlbiBhIHRhc2ssIHRoZW4gYSBzdWJhZ2VudCDigJQgY2xlYXJzIHRoaXMgYnkgY29uc3RydWN0aW9uLlxuLy9cbi8vIOKaoCBBIFNZU1RFTSBMSU5FIElTIE5PVCBBIFJFUExZLiBgYW5ub3VuY2UoKWAgbmFycmF0ZXMgYWdlbnQgQUNUUyAoXCJBZ2VudFxuLy8gbm90ZWQg4oCmIG9uIG1hcmVuXCIpLCB3aGljaCBpcyBldmlkZW5jZSBvZiBsaWZlIGJ1dCBub3QgYSBjaGVjay1pbiB3aXRoIHRoZVxuLy8gcGVyc29uIHdhaXRpbmcuIENvdW50aW5nIGl0IHdvdWxkIHNpbGVuY2UgdGhlIHNpZ25hbCBwcmVjaXNlbHkgaW4gdGhlIGNhc2Vcbi8vIHRoaXMgZXhpc3RzIGZvcjogYW4gYWdlbnQgdGhhdCBpcyBidXN5IGRvaW5nIHRoaW5ncyBhbmQgaGFzIG5vdCBzYWlkIGEgd29yZFxuLy8gdG8gdGhlIGh1bWFuLiBPbmx5IGB3aG8gPT09IFwiYWdlbnRcImAgY2xlYXJzLlxuaW1wb3J0IHR5cGUgeyBDaGF0V2hvLCBOb3RlLCBOb3RlV2FpdGluZywgV2FpdGluZyB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogSG93IGxvbmcgYSBodW1hbiB3YWl0cyBiZWZvcmUgdGhlIHdhaXQgaXMgd29ydGggcmVwb3J0aW5nLiAzMCBzLCBDb2xlJ3NcbiAqIG51bWJlciDigJQgbG9uZyBlbm91Z2ggdGhhdCBhbiBvcmRpbmFyeSBhbnN3ZXIgbmV2ZXIgdHJpcHMgaXQsIHNob3J0IGVub3VnaFxuICogdGhhdCBpdCBpcyBzdGlsbCB0aGUgc2FtZSBtb21lbnQgZm9yIHRoZSBwZXJzb24gc2l0dGluZyB0aGVyZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNUQUxMX01TID0gMzBfMDAwO1xuXG4vKiogV2hhdCBhIHNub296ZSBidXlzLCB3aGVuIHRoZSBhZ2VudCBkb2VzIG5vdCBuYW1lIGEgZHVyYXRpb24uICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TTk9PWkVfTVMgPSAxMjBfMDAwO1xuXG4vLyBgV2FpdGluZ2AgaXRzZWxmIGxpdmVzIGluIGBwcm90b2NvbC50c2Ag4oCUIGl0IHJpZGVzIGluIGBQdWJsaWNTdGF0ZWAsIGFuZCB0aGF0XG4vLyBmaWxlIGlzIGltcG9ydC1mcmVlIG9uIHB1cnBvc2UuIEl0cyBgYmFkZ2VgIGNhcnJpZXMgdGhlIHJ1bGUgdGhhdCBtYXR0ZXJzOlxuLy8g4puUIFNUQUxMRUQgTVVTVCBOT1QgUFVMU0UuIEEgcHVsc2Ugb3ZlciBhIHdlZGdlZCBhZ2VudCBpcyBmYWxzZSBsaXZlbmVzcyDigJQgdGhlXG4vLyBhbmltYXRpb24gY2xhaW1zIFwic29tZXRoaW5nIGlzIGhhcHBlbmluZ1wiIHdoZW4gdGhlIGhvbmVzdCBhbnN3ZXIgaXMgXCJJIGNhbm5vdFxuLy8gdGVsbCBhbnkgbW9yZVwiLiBtaW5kLW1hcHBlciBzZXBhcmF0ZXMgdGhlc2UgdHdvIGZvciB0aGUgc2FtZSByZWFzb24uXG5cbnR5cGUgTXNnID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IENoYXRXaG87XG4gIHRzOiBudW1iZXI7XG4gIC8qKiBFNjU6IHRoZSBub3RlIGEgbWVzc2FnZSBpcyBBQk9VVCDigJQgc2V0IGJ5IFwiQXNrIHRoZSBhZ2VudFwiLiAqL1xuICBub3RlPzogeyBkb2M6IHN0cmluZzsgaWQ6IHN0cmluZyB9O1xufTtcblxuLyoqXG4gKiBUaGUgaHVtYW4gbWVzc2FnZSBub3RoaW5nIGhhcyBhbnN3ZXJlZCB5ZXQsIG9yIG51bGwuXG4gKlxuICogYGFja25vd2xlZGdlZFVudGlsYCBpcyBhIHNub296ZSAodGhlIGFnZW50IHNhaWQgaXQgaXMgc3RpbGwgd29ya2luZykuIFdoaWxlXG4gKiBpdCBob2xkcywgdGhlIGJhZGdlIHN0YXlzIGEgcHVsc2UgcGFzdCB0aGUgc3RhbGwgdGhyZXNob2xkIOKAlCB0aGUgYWdlbnRcbiAqIHZvbHVudGVlcmVkIGV2aWRlbmNlIG9mIGxpZmUsIHNvIHNob3dpbmcgXCJtYXkgYmUgc3R1Y2tcIiB3b3VsZCBiZSB0aGUgbGllLlxuICogV2hlbiBpdCBFWFBJUkVTIHRoZSBiYWRnZSBnb2VzIHN0YWxsZWQgYWdhaW4sIGJlY2F1c2UgdGhlIGh1bWFuIGlzIG93ZWQgdGhlXG4gKiB0cnV0aCBldmVudHVhbGx5OyB0aGF0IGV4cGlyeSBpcyBkZWxpYmVyYXRlbHkgbm90IGEgcmVhc29uIHRvIG51ZGdlIHRoZSBhZ2VudFxuICogYSBzZWNvbmQgdGltZSAoc2VlIHRoZSBzZXJ2ZXIncyBvbmNlLXBlci1tZXNzYWdlIHJ1bGUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2FpdGluZ09uKFxuICBjaGF0OiByZWFkb25seSBNc2dbXSxcbiAgbm93OiBudW1iZXIsXG4gIG9wdHM6IHsgc3RhbGxNcz86IG51bWJlcjsgYWNrbm93bGVkZ2VkVW50aWw/OiBudW1iZXIgfSA9IHt9LFxuKTogV2FpdGluZyB8IG51bGwge1xuICAvLyBXYWxrIGJhY2sgdG8gdGhlIGxhc3QgdGhpbmcgdGhhdCB3YXMgbm90IG5hcnJhdGlvbi4gQSBodW1hbiB0aGVyZSBtZWFuc1xuICAvLyBub2JvZHkgaGFzIGFuc3dlcmVkIHRoZW0uXG4gIGxldCBwZW5kaW5nOiBNc2cgfCBudWxsID0gbnVsbDtcbiAgZm9yIChsZXQgaSA9IGNoYXQubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBtID0gY2hhdFtpXTtcbiAgICBpZiAoIW0gfHwgbS53aG8gPT09IFwic3lzdGVtXCIpIGNvbnRpbnVlO1xuICAgIGlmIChtLndobyA9PT0gXCJhZ2VudFwiKSByZXR1cm4gbnVsbDtcbiAgICBwZW5kaW5nID0gbTtcbiAgICBicmVhaztcbiAgfVxuICBpZiAoIXBlbmRpbmcpIHJldHVybiBudWxsO1xuXG4gIC8vIOKaoCBUaGUgRklSU1Qgb2YgdGhlIHVuYW5zd2VyZWQgcnVuLCBub3QgdGhlIGxhc3QuIFNvbWVvbmUgd2hvIHNlbmRzIHRocmVlXG4gIC8vIG1lc3NhZ2VzIHdoaWxlIHdhaXRpbmcgaGFzIGJlZW4gd2FpdGluZyBzaW5jZSB0aGUgZmlyc3Qgb25lLCBhbmQgcmVzZXR0aW5nXG4gIC8vIHRoZSBjbG9jayBvbiBldmVyeSBmb2xsb3ctdXAgd291bGQgbWVhbiB0aGUgbW9yZSBhbnhpb3VzIHRoZXkgZ2V0LCB0aGVcbiAgLy8gbG9uZ2VyIHdlIGNsYWltIHRoZXkgaGF2ZSBiZWVuIHdhaXRpbmcgaXMgemVyby5cbiAgbGV0IHNpbmNlID0gcGVuZGluZy50cztcbiAgbGV0IG1lc3NhZ2VJZCA9IHBlbmRpbmcuaWQ7XG4gIGZvciAobGV0IGkgPSBjaGF0Lmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbSA9IGNoYXRbaV07XG4gICAgaWYgKCFtIHx8IG0ud2hvID09PSBcInN5c3RlbVwiKSBjb250aW51ZTtcbiAgICBpZiAobS53aG8gIT09IFwiaHVtYW5cIikgYnJlYWs7XG4gICAgc2luY2UgPSBtLnRzO1xuICAgIG1lc3NhZ2VJZCA9IG0uaWQ7XG4gIH1cblxuICByZXR1cm4geyBtZXNzYWdlSWQsIHNpbmNlLCBiYWRnZTogYmFkZ2VGb3Ioc2luY2UsIG5vdywgb3B0cykgfTtcbn1cblxuLyoqXG4gKiBQdWxzZSBvciBzdGFsbGVkLCBmb3IgYW55dGhpbmcgb3dlZCBhbiBhbnN3ZXIgc2luY2UgYHNpbmNlYC4gT05FIHBsYWNlLCBzbyBhXG4gKiBub3RlIGFuZCBhIG1lc3NhZ2Ugd2FpdGluZyBlcXVhbGx5IGxvbmcgY2FuIG5ldmVyIHJlYWQgZGlmZmVyZW50bHkuXG4gKi9cbmZ1bmN0aW9uIGJhZGdlRm9yKFxuICBzaW5jZTogbnVtYmVyLFxuICBub3c6IG51bWJlcixcbiAgb3B0czogeyBzdGFsbE1zPzogbnVtYmVyOyBhY2tub3dsZWRnZWRVbnRpbD86IG51bWJlciB9LFxuKTogV2FpdGluZ1tcImJhZGdlXCJdIHtcbiAgY29uc3Qgc3RhbGxNcyA9IG9wdHMuc3RhbGxNcyA/PyBTVEFMTF9NUztcbiAgY29uc3QgYWNrbm93bGVkZ2VkID0gb3B0cy5hY2tub3dsZWRnZWRVbnRpbCAhPT0gdW5kZWZpbmVkICYmIG5vdyA8IG9wdHMuYWNrbm93bGVkZ2VkVW50aWw7XG4gIHJldHVybiBub3cgLSBzaW5jZSA+PSBzdGFsbE1zICYmICFhY2tub3dsZWRnZWQgPyBcInN0YWxsZWRcIiA6IFwid29ya2luZ1wiO1xufVxuXG4vLyDilIDilIAgRTY1OiB0aGUgc2FtZSBxdWVzdGlvbiwgYXNrZWQgb2YgYSBub3RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIEFnZW50cyBhY3Qgb24gbmVhcmx5IGV2ZXJ5IG5vdGUsIGFuZCBDb2xlIHJ1bGVkIHRoYXQgdGhlIHJpZ2h0IGluc3RpbmN0OyB3aGF0XG4vLyB3YXMgbWlzc2luZyB3YXMgYW55IHNpZ24sIGJldHdlZW4gYWRkaW5nIGEgbm90ZSBhbmQgdGhlIGFnZW50J3MgYW5zd2VyLCB0aGF0XG4vLyBzb21ldGhpbmcgd2FzIGhhcHBlbmluZy4gU28gYSBub3RlIGdldHMgRTUzJ3MgdHJlYXRtZW50IFdIT0xFOiBkZXJpdmVkLCBuZXZlclxuLy8gZGVjbGFyZWQ7IGEgcHVsc2UsIHRoZW4gYSBzdGF0aWMgXCJtYXkgYmUgc3R1Y2tcIiBhdCB0aGUgc2FtZSAzMCBzOyB0aGUgc2FtZVxuLy8gc25vb3plLiBOb3RoaW5nIGhlcmUgYXNrcyB0aGUgYWdlbnQgZm9yIGFueXRoaW5nIG5ldy5cbi8vXG4vLyDim5QgV0hBVCBBTlNXRVJTIEEgTk9URSDigJQgdGhlIHJ1bGUsIGFuZCBlYWNoIHBhcnQgaXMgYSBmYWN0IHRoZSBkYWVtb24gYWxyZWFkeVxuLy8gaG9sZHM6XG4vLyAgIMK3IFJFU09MVkVELiBSZXNvbHZpbmcgaXMgdGhlIGFjdCB0aGF0IGNsb3NlcyBhIG5vdGUgKENvbGUpLCBieSBlaXRoZXIgcGFydHksXG4vLyAgICAgc28gYSByZXNvbHZlZCBub3RlIGlzIG93ZWQgbm90aGluZy4gSXQgaXMgdGhlIG5vdGUncyBvd24gc3RvcmVkIHN0YXRlLFxuLy8gICAgIG5vdCBhIGNvcHkgb2YgaXQuXG4vLyAgIMK3IEFOIEFHRU5UIE1FU1NBR0UgQUZURVIgSVQuIFRoZSBhZ2VudCBzcG9rZSB0byB0aGUgaHVtYW4gYWZ0ZXIgdGhlIG5vdGVcbi8vICAgICB3YXMgd3JpdHRlbiwgd2hpY2ggaXMgd2hhdCB0aGUgaHVtYW4gaXMgd2FpdGluZyBmb3Ig4oCUIHRoZSBzYW1lIHJlYXNvblxuLy8gICAgIG9uZSByZXBseSBhbnN3ZXJzIEU1MydzIHJ1biBvZiBtZXNzYWdlcy4gSXQgY2xhaW1zIFwidGhlIGFnZW50IGhhcyBzYWlkXG4vLyAgICAgc29tZXRoaW5nIHNpbmNlXCIsIG5ldmVyIFwidGhlIGFnZW50IGRlYWx0IHdpdGggdGhpc1wiLCBzbyBpdCBjbGVhcnMgdGhlXG4vLyAgICAgcGVuZGluZyBtYXJrIGFuZCBsZWF2ZXMgdGhlIG5vdGUgT1BFTjogZGVhbHQgd2l0aCBpcyBgcmVzb2x2ZWRgLlxuLy8gICAgIENvdW50aW5nIG9ubHkgYHJlc29sdmVkYCB3YXMgdGhlIG9wdGlvbiBub3QgdGFrZW4g4oCUIGFuIGFnZW50IHZpc2libHlcbi8vICAgICB3b3JraW5nIG9uIGEgbm90ZSB3b3VsZCBmbGlwIGl0IHRvIFwibWF5IGJlIHN0dWNrXCIgd2hlbmV2ZXIgaXQgZm9yZ290IHRvXG4vLyAgICAgcmVzb2x2ZSwgYW5kIEU1MydzIHdob2xlIHByZW1pc2UgaXMgdGhhdCBpdCBmb3JnZXRzLlxuLy8gICDCtyBUSEUgQUdFTlQgUkVXUklUSU5HIFRISVMgTk9URS4gQW4gYWN0IG9uIHRoaXMgbm90ZSwgc2VlbiBvbiB0aGlzIG5vdGUuXG4vLyDimqAgQU5EIEEgU1lTVEVNIExJTkUgSVMgU1RJTEwgTk9UIEEgUkVQTFkuIFRoZSBhZ2VudCByZXNvbHZpbmcgbm90ZSBBIGlzXG4vLyBuYXJyYXRlZCBhcyBhIHN5c3RlbSBsaW5lOyBpdCBhbnN3ZXJzIEEgKEEgaXMgcmVzb2x2ZWQpIGFuZCBzYXlzIG5vdGhpbmdcbi8vIGFib3V0IEIuXG5cbi8qKiBXaGF0IHRoZSBydWxlIHJlYWRzIG9mZiBhIG5vdGUg4oCUIHRoZSBzdG9yZWQgZmllbGRzLCBub3RoaW5nIHBsYWNlZC4gKi9cbnR5cGUgTm90ZUZhY3RzID0gUGljazxcbiAgTm90ZSxcbiAgXCJpZFwiIHwgXCJ3aG9cIiB8IFwiY3JlYXRlZEF0XCIgfCBcImVkaXRlZEF0XCIgfCBcImVkaXRlZEJ5XCIgfCBcInJlb3BlbmVkQXRcIiB8IFwicmVvcGVuZWRCeVwiIHwgXCJyZXNvbHZlZFwiXG4+O1xuXG4vKipcbiAqIFdoZW4gdGhlIGh1bWFuIGxhc3Qgd3JvdGUgaW50byB0aGlzIG5vdGUsIG9yIG51bGwgaWYgdGhleSBuZXZlciBkaWQgb3IgdGhlXG4gKiBhZ2VudCBoYXMgYWN0ZWQgb24gaXQgc2luY2UuIEEgd3JpdGUgaXMgbWFraW5nIGl0LCByZXdyaXRpbmcgaXQsIG9yXG4gKiBSRU9QRU5JTkcgaXQg4oCUIGVhY2ggb25lIGEgaHVtYW4gcHV0dGluZyB0aGUgbm90ZSBpbiBmcm9udCBvZiB0aGUgYWdlbnRcbiAqICh2ZXJpZmllcjogYSByZW9wZW4gdXNlZCB0byBjb21lIGJhY2sgdGltZWQgZnJvbSB3aGVuIHRoZSBub3RlIHdhcyBtYWRlLCBzb1xuICogaXQgY291bGQgcmVhcHBlYXIgYWxyZWFkeSBcIm1heSBiZSBzdHVja1wiKS4gVGhlIGFnZW50IHJld3JpdGluZyBvciByZW9wZW5pbmdcbiAqIGl0IGlzIGFuIGFjdCBvbiB0aGlzIG5vdGUsIGFuZCBhbnN3ZXJzIGl0LiBBbiBlZGl0IHdob3NlIGF1dGhvciB3YXMgbm90XG4gKiByZWNvcmRlZCAoYmVmb3JlIEU2NSkgaXMgbm90IGV2aWRlbmNlIGVpdGhlciB3YXkuXG4gKi9cbmZ1bmN0aW9uIGh1bWFuV3JvdGVBdChuOiBOb3RlRmFjdHMpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgYWN0czogeyBhdDogbnVtYmVyOyBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiIH1bXSA9IFt7IGF0OiBuLmNyZWF0ZWRBdCwgYnk6IG4ud2hvIH1dO1xuICBpZiAobi5lZGl0ZWRBdCAhPT0gdW5kZWZpbmVkICYmIG4uZWRpdGVkQnkpIGFjdHMucHVzaCh7IGF0OiBuLmVkaXRlZEF0LCBieTogbi5lZGl0ZWRCeSB9KTtcbiAgaWYgKG4ucmVvcGVuZWRBdCAhPT0gdW5kZWZpbmVkICYmIG4ucmVvcGVuZWRCeSkgYWN0cy5wdXNoKHsgYXQ6IG4ucmVvcGVuZWRBdCwgYnk6IG4ucmVvcGVuZWRCeSB9KTtcbiAgbGV0IGxhc3QgPSBhY3RzWzBdIGFzIHsgYXQ6IG51bWJlcjsgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIiB9O1xuICBmb3IgKGNvbnN0IGEgb2YgYWN0cykgaWYgKGEuYXQgPj0gbGFzdC5hdCkgbGFzdCA9IGE7XG4gIHJldHVybiBsYXN0LmJ5ID09PSBcImh1bWFuXCIgPyBsYXN0LmF0IDogbnVsbDtcbn1cblxuLyoqXG4gKiBFdmVyeSBub3RlIG93ZWQgYW4gYW5zd2VyLCBvbGRlc3QgZmlyc3QuXG4gKlxuICog4puUIEEgTk9URSBUSEUgSFVNQU4gSEFTIEFTS0VEIEFCT1VUIHdhaXRzIE9OIFRIQVQgTUVTU0FHRSAodmVyaWZpZXIgRDEpLiBcIkFza1xuICogdGhlIGFnZW50XCIgcG9zdHMgYSBtZXNzYWdlIGNhcnJ5aW5nIHRoZSBub3RlJ3MgcmVmZXJlbmNlOyB3aGlsZSB0aGF0IG1lc3NhZ2VcbiAqIGlzIHVuYW5zd2VyZWQsIHRoZSBub3RlIHNheXMgaXQgd2FzIGFza2VkLCBhbmQgaXRzIGJhZGdlIElTIEU1MydzIGJhZGdlIGZvclxuICogdGhlIGNvbnZlcnNhdGlvbiDigJQgbm90IGEgc2Vjb25kIGNsb2NrIHRoYXQgY291bGQgZGlzYWdyZWUgd2l0aCBpdC4gVGhlcmUgaXNcbiAqIG5vIFwiYXNrZWRcIiBmbGFnOiBpdCBpcyByZWFkIG9mZiB0aGUgY29udmVyc2F0aW9uIGxpa2UgZXZlcnl0aGluZyBlbHNlIGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3Rlc1dhaXRpbmcoXG4gIGRvY3M6IHJlYWRvbmx5IHsgc2x1Zzogc3RyaW5nOyBub3RlczogcmVhZG9ubHkgTm90ZUZhY3RzW10gfVtdLFxuICBjaGF0OiByZWFkb25seSBNc2dbXSxcbiAgbm93OiBudW1iZXIsXG4gIG9wdHM6IHsgc3RhbGxNcz86IG51bWJlcjsgYWNrbm93bGVkZ2VkVW50aWw/OiBudW1iZXIgfSA9IHt9LFxuKTogTm90ZVdhaXRpbmdbXSB7XG4gIGxldCBsYXN0QWdlbnQgPSBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIGZvciAoY29uc3QgbSBvZiBjaGF0KSBpZiAobS53aG8gPT09IFwiYWdlbnRcIiAmJiBtLnRzID4gbGFzdEFnZW50KSBsYXN0QWdlbnQgPSBtLnRzO1xuICBjb25zdCB3YWl0ID0gd2FpdGluZ09uKGNoYXQsIG5vdywgb3B0cyk7XG4gIGNvbnN0IG91dDogTm90ZVdhaXRpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGQgb2YgZG9jcylcbiAgICBmb3IgKGNvbnN0IG4gb2YgZC5ub3Rlcykge1xuICAgICAgaWYgKG4ucmVzb2x2ZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc2luY2UgPSBodW1hbldyb3RlQXQobik7XG4gICAgICAvLyDimqAgU1RSSUNUTFkgYWZ0ZXI6IGEgcmVwbHkgaW4gdGhlIHNhbWUgbWlsbGlzZWNvbmQgY2Fubm90IGhhdmUgcmVhZCBpdC5cbiAgICAgIGlmIChzaW5jZSA9PT0gbnVsbCB8fCBsYXN0QWdlbnQgPiBzaW5jZSkgY29udGludWU7XG4gICAgICAvLyBBbnkgYXNrIGFmdGVyIHRoZSBub3RlJ3MgbGFzdCB3cml0ZSBpcyB1bmFuc3dlcmVkIGJ5IGNvbnN0cnVjdGlvbjogYVxuICAgICAgLy8gcmVwbHkgYWZ0ZXIgaXQgd291bGQgYmUgYWZ0ZXIgdGhlIG5vdGUgdG9vLCBhbmQgY2xlYXJlZCBpdCBhYm92ZS5cbiAgICAgIGNvbnN0IGFza2VkID0gd2FpdFxuICAgICAgICA/IGNoYXQuZmluZExhc3QoXG4gICAgICAgICAgICAobSkgPT5cbiAgICAgICAgICAgICAgbS53aG8gPT09IFwiaHVtYW5cIiAmJiBtLnRzID49IHNpbmNlICYmIG0ubm90ZT8uZG9jID09PSBkLnNsdWcgJiYgbS5ub3RlLmlkID09PSBuLmlkLFxuICAgICAgICAgIClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBvdXQucHVzaChcbiAgICAgICAgYXNrZWQgJiYgd2FpdFxuICAgICAgICAgID8geyBkb2M6IGQuc2x1Zywgbm90ZUlkOiBuLmlkLCBzaW5jZSwgYmFkZ2U6IHdhaXQuYmFkZ2UsIGFza2VkSW46IGFza2VkLmlkIH1cbiAgICAgICAgICA6IHsgZG9jOiBkLnNsdWcsIG5vdGVJZDogbi5pZCwgc2luY2UsIGJhZGdlOiBiYWRnZUZvcihzaW5jZSwgbm93LCBvcHRzKSB9LFxuICAgICAgKTtcbiAgICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gYS5zaW5jZSAtIGIuc2luY2UpO1xufVxuXG4vKipcbiAqIFdoYXQgRTUzJ3MgYXR0ZW50aW9uIHRpY2sgY29tcGFyZXMgdG8gZGVjaWRlIHdoZXRoZXIgdGhlIHN1cmZhY2UgbmVlZHMgYSBuZXdcbiAqIHNuYXBzaG90OiB0aGUgbWVzc2FnZSB3YWl0IGFuZCBldmVyeSBvd2VkIG5vdGUsIHdpdGggdGhlaXIgYmFkZ2VzLiDim5QgQSBub3RlXG4gKiBmbGlwcGluZyB0byBcIm1heSBiZSBzdHVja1wiIGhhcHBlbnMgd2l0aCBub3RoaW5nIGVsc2UgY2hhbmdpbmcg4oCUIG5vIG1lc3NhZ2UsXG4gKiBubyBhY3Qg4oCUIHNvIGlmIHRoaXMga2V5IGNvdWxkIG5vdCBzZWUgbm90ZXMsIHRoZSBwdWxzZSB3b3VsZCBydW4gb24gb3ZlciBhXG4gKiBzdHVjayBub3RlIHVudGlsIHNvbWV0aGluZyB1bnJlbGF0ZWQgcmUtc2VudCB0aGUgc3RhdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhdHRlbnRpb25LZXkodzogV2FpdGluZyB8IG51bGwsIG5vdGVzOiByZWFkb25seSBOb3RlV2FpdGluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICB3ID8gYCR7dy5tZXNzYWdlSWR9OiR7dy5iYWRnZX1gIDogXCItXCIsXG4gICAgLi4ubm90ZXMubWFwKChuKSA9PiBgJHtuLmRvY30vJHtuLm5vdGVJZH06JHtuLmJhZGdlfSR7bi5hc2tlZEluID8gYEAke24uYXNrZWRJbn1gIDogXCJcIn1gKSxcbiAgXS5qb2luKFwifFwiKTtcbn1cblxuLyoqXG4gKiBIb3cgbXVjaCBvZiBhIG5vdGUgYG5vdGUuYWRkZWRgIGNhcnJpZXM6IHRoZSBxdW90ZSBhbmQgdGhlIGJvZHkgdG9nZXRoZXIsIGluXG4gKiBjaGFyYWN0ZXJzLiBBIHBhcmFncmFwaCdzIHdvcnRoLiBOb3RlcyBhcmUgbWFkZSBtaWQtcmVhZCwgb24gYSBwaHJhc2Ugb3IgYVxuICogc2VudGVuY2UsIGFuZCB0aG9zZSB0cmF2ZWwgd2hvbGUgc28gdGhlIGFnZW50IGNhbiBhY3Qgd2l0aG91dCBhIHJvdW5kIHRyaXAuXG4gKiBBIG5vdGUgb3ZlciBhIHdob2xlIHNlY3Rpb24gaXMgd2hlcmUgdGhlIHJvdW5kIHRyaXAgcGF5czogYG5vdGVzYCBhbHNvIHNheXNcbiAqIHdoZXRoZXIgdGhlIHBhc3NhZ2Ugc3RpbGwgc3RhbmRzIGFuZCB3aGVyZSBpdCBpcyBub3cuIFRoZSBvbmUgd2hvIGFjdHMgb25cbiAqIHRoaXMgbnVtYmVyIGlzIHRoZSBhZ2VudCByZWFkaW5nIGl0cyB0YWlsLlxuICovXG5leHBvcnQgY29uc3QgTk9URV9URVhUX01BWCA9IDEwMDA7XG5cbi8qKlxuICogV2hhdCBgbm90ZS5hZGRlZGAgKGFuZCBhIGh1bWFuJ3MgYG5vdGUuZWRpdGVkYCkgdGVsbHMgdGhlIGFnZW50IGJleW9uZCB0aGUgaWRzXG4gKiAoRTY1KS4gVGhlIGV2ZW50IG5hbWVzIGl0cyBuZXh0IGFjdCwgYmVjYXVzZSBhbiBhZ2VudCB0aGF0IG11c3QgZ28gYW5kIGFza1xuICogd2hhdCBhcnJpdmVkIGlzIGFuIGFnZW50IG9uZSBzdGVwIGZ1cnRoZXIgZnJvbSBkb2luZyBpdC5cbiAqXG4gKiDim5QgV0hPTEUgT1IgTk9UIEFUIEFMTCwgbmV2ZXIgdHJ1bmNhdGVkLiBBIGNsaXBwZWQgcXVvdGUgcmVhZHMgYXMgdGhlIHdob2xlXG4gKiBwYXNzYWdlLCB3aGljaCBpcyB3b3JzZSB0aGFuIG5vIHF1b3RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm90ZUV2ZW50RmFjdHMoXG4gIHNsdWc6IHN0cmluZyxcbiAgbm90ZTogeyBpZDogc3RyaW5nOyBxdW90ZTogc3RyaW5nOyBib2R5OiBzdHJpbmcgfSxcbiAgbGluZXM6IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH0gfCBudWxsLFxuKToge1xuICBsaW5lcz86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07XG4gIHF1b3RlPzogc3RyaW5nO1xuICBib2R5Pzogc3RyaW5nO1xuICBwYXNzYWdlPzogXCJnb25lXCI7XG4gIGhpbnQ6IHN0cmluZztcbn0ge1xuICBjb25zdCBjbG9zZSA9IGBub3RlLXJlc29sdmUgJHtub3RlLmlkfSAtLWRvYyAke3NsdWd9YDtcbiAgLy8g4pqgIEEgbm90ZSB3aG9zZSBwYXNzYWdlIGlzIG5vIGxvbmdlciBpbiB0aGUgYWN0aXZlIHZlcnNpb24gaGFzIG5vIGxpbmVzLCBhbmRcbiAgLy8gbXVzdCBTQVkgc28gKHZlcmlmaWVyIEQ1KSDigJQgb3RoZXJ3aXNlIFwiYWN0IG9uIGl0XCIgc2VuZHMgdGhlIGFnZW50IGxvb2tpbmdcbiAgLy8gZm9yIHRleHQgdGhhdCBpcyBub3QgdGhlcmUuXG4gIGNvbnN0IGF0ID0gbGluZXMgPyB7IGxpbmVzIH0gOiB7IHBhc3NhZ2U6IFwiZ29uZVwiIGFzIGNvbnN0IH07XG4gIC8vIENIQVJBQ1RFUlMsIG5vdCBVVEYtMTYgdW5pdHM6IGFuIGVtb2ppIGlzIG9uZSBjaGFyYWN0ZXIgdG8gd2hvZXZlciB3cm90ZSBpdC5cbiAgY29uc3Qgc2l6ZSA9IFsuLi5ub3RlLnF1b3RlXS5sZW5ndGggKyBbLi4ubm90ZS5ib2R5XS5sZW5ndGg7XG4gIGlmIChzaXplIDw9IE5PVEVfVEVYVF9NQVgpXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmF0LFxuICAgICAgcXVvdGU6IG5vdGUucXVvdGUsXG4gICAgICBib2R5OiBub3RlLmJvZHksXG4gICAgICBoaW50OiBsaW5lc1xuICAgICAgICA/IGBhY3Qgb24gaXQsIHRoZW4gXFxgJHtjbG9zZX1cXGAgd2hlbiBpdCBpcyBkZWFsdCB3aXRoYFxuICAgICAgICA6IGBpdHMgcGFzc2FnZSBpcyBubyBsb25nZXIgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uIOKAlCBzZWUgXFxgbm90ZXMgLS1kb2MgJHtzbHVnfVxcYCwgdGhlbiBhY3Qgb24gaXQgYW5kIFxcYCR7Y2xvc2V9XFxgIHdoZW4gaXQgaXMgZGVhbHQgd2l0aGAsXG4gICAgfTtcbiAgcmV0dXJuIHtcbiAgICAuLi5hdCxcbiAgICBoaW50OiBgdG9vIGxvbmcgdG8gY2Fycnkke2xpbmVzID8gXCJcIiA6IFwiLCBhbmQgaXRzIHBhc3NhZ2UgaXMgbm8gbG9uZ2VyIGluIHRoZSBhY3RpdmUgdmVyc2lvblwifSDigJQgcmVhZCBpdCB3aXRoIFxcYG5vdGVzIC0tZG9jICR7c2x1Z31cXGAsIGFjdCBvbiBpdCwgdGhlbiBcXGAke2Nsb3NlfVxcYGAsXG4gIH07XG59XG5cbi8qKiBXaGF0IHRoZSBjb252ZXJzYXRpb24gc2hvd3MsIHBlciBiYWRnZS4gbWluZC1tYXBwZXIncyB3b3JkcywgbmVhciBlbm91Z2guICovXG5leHBvcnQgY29uc3QgV0FJVElOR19MQUJFTDogUmVjb3JkPFdhaXRpbmdbXCJiYWRnZVwiXSwgc3RyaW5nPiA9IHtcbiAgd29ya2luZzogXCJ3b3JraW5nIG9uIHRoaXPigKZcIixcbiAgc3RhbGxlZDogXCJ0b29rIHRoaXMgaW4sIHRoZW4gd2VudCBxdWlldCDigJQgbWF5IGJlIHN0dWNrXCIsXG59O1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXFEQSx1QkFBUyw2QkFBNEIsMkJBQWMseUJBQVU7QUFDN0Qsb0JBQVM7QUFDVCxxQkFBUyxzQkFBVSx3QkFBUyxxQkFBWSxrQkFBTTtBQUM5QztBQUNBLHNCQUFTOzs7QUMzQ1Q7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFBZSxDQUM3QixNQUNBLFVBQ0EsV0FBMkMsQ0FBQyxRQUFRLElBQUksS0FBSyxHQUNwRDtBQUFBLEVBQ1QsSUFBSTtBQUFBLElBQ0YsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLE1BQUcsT0FBTztBQUFBLElBQzlCLElBQUksU0FBUyxhQUFhLE1BQU0sTUFBTSxDQUFDLE1BQU07QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5RCxXQUFXLElBQUk7QUFBQSxJQUNmLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBOzs7QUMrQkosSUFBTSxxQkFBcUI7QUEyQjNCLFNBQVMsY0FBZ0MsQ0FDOUMsT0FBZ0QsQ0FBQyxHQUNwQztBQUFBLEVBQ2IsTUFBTSxhQUFhLEtBQUssY0FBYztBQUFBLEVBQ3RDLE1BQU0sUUFBUSxLQUFLO0FBQUEsRUFDbkIsTUFBTSxTQUEwQixDQUFDO0FB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QUFFLE1BQU0sU0FBUztBQUM5QjtBQUdBLGVBQXNCLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQzFELElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFFBQVEsY0FBYyxFQUFFLE1BQU0sTUFBTSxTQUFTLGdCQUFnQixRQUFRLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFJN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYixnQkFBZ0IsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxzQkFBMEIsT0FBTyxLQUN4RixjQUNGLEVBQ0csSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQ25CLEtBQUssR0FBRztBQUFBLENBQ2I7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBRVQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsSUFBSSxNQUFNLFlBQVk7QUFBQSxNQUNwQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsTUFDeEMsU0FBUyxNQUFNO0FBQUEsTUFDZixVQUFVLE1BQU0sVUFBVSxPQUFPLE1BQU0sT0FBTyxJQUFJO0FBQUEsTUFDbEQsV0FBVyxNQUFNO0FBQUEsSUFDbkIsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFFVixNQUFNLFNBQVMsYUFBYSxlQUFlLEVBQUUsU0FBUztBQUFBLElBQ3RELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsSUFBSSxPQUFPLFFBQVEsT0FBTyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxDQUM1RjtBQUFBLElBQ0EsT0FBTyxXQUFXLE1BQU0sSUFBSSxXQUFXLE1BQU0sSUFBSTtBQUFBO0FBQUEsRUFFbkQsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLG9CQUFvQixFQUFFLFFBQVEsTUFBTSxFQUFFLE1BQU0sWUFBWSxFQUFFLFdBQVcsTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLEtBQUssV0FBVyxFQUFFLFVBQVUsQ0FBQztBQUFBLENBQ2xKO0FBQUEsRUFDQSxNQUFNLE1BQU0sTUFBTSxFQUFFO0FBQUEsRUFDcEIsTUFBTSxFQUFFO0FBQUEsRUFFUixJQUFJLElBQUksU0FBUyxLQUFLLE1BQU0sS0FBSztBQUFBLElBQy9CLElBQUk7QUFBQSxNQUNGLElBQUksVUFBUyxNQUFNLEdBQUcsRUFBRSxTQUFTO0FBQUEsUUFBRyxZQUFXLE1BQU0sR0FBRztBQUFBLE1BQ3hELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxPQUFPLElBQUk7QUFBQTtBQVFiLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjkzQzhGREIwNTc4OTY0REU2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
