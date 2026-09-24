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
    "links.dangling": ["set with dangling links", "sets with dangling links"]
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
        if (g.dangling > 0)
          links.push({ entry: e.id, label: e.label ?? basename3(e.root), dangling: g.dangling });
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
  scriptoriumHome,
  startDaemon,
  surfacePath
};

//# debugId=7ED905C5484023AE64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL29yaWdpbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc2VydmVEaXN0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zc2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvYW5jaG9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9kaWZmLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2RvY3Rvci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oaXN0b3J5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZWxlY3Rpb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2Vzc2lvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9mcm9udG1hdHRlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9saW5rcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3NlYXJjaC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC93YWl0aW5nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBwZXItc2Vzc2lvbiBkYWVtb24g4oCUIHRoZSBwcm9jZXNzIHRoZSBzdXJmYWNlIHRhbGtzIHRvIG92ZXIgYVxuICogV2ViU29ja2V0IGFuZCB0aGUgQ0xJIHRhbGtzIHRvIG92ZXIgSFRUUC4gTGF1bmNoZWQgYnlcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvc2NyaXB0b3JpdW0vc2NyaXB0cy9zZXJ2ZXIudHNgICh0aGUgbGF1bmNoZXIpLCB3aGljaFxuICogaW1wb3J0cyB0aGUgQlVJTFQgYGRpc3Qvc2VydmVyLmpzYC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogYFNLSUxMX1JPT1RgL2BESVNUX0RJUmAgb25seSwgZm9yIHRoZSBraXQncyBgcmVzb2x2ZU1vZGVgIGFuZFxuICogICAgYHNlcnZlRnJvbURpc3RgLCBhbmQgdHJ1ZSBhdCB0aGUgRU1JVFRFRCBhZGRyZXNzIChgZGlzdC9zZXJ2ZXIuanNgLCB3aG9zZVxuICogICAgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyKS4gTm90aGluZyBlbHNlIGlzIHBpbm5lZCBvZmYgYGltcG9ydC5tZXRhYC5cbiAqIDIuIFNlcnZlczogWUVTLiBgL2AgaXMgdGhlIGJ1aWx0IGBpbmRleC5odG1sYCB2aWEgYHNlcnZlRnJvbURpc3RgLCBub1xuICogICAgc3Vic3RpdHV0aW9uOyB0aGUgb25seSByb3V0ZXMgb2YgaXRzIG93biBhcmUgYC9zdGF0ZWAsIGAvY21kYCwgYC9ldmVudHNgLFxuICogICAgYC93c2AgYW5kIGAvZnMvKmAgKHJlYWQtb25seTogYSB2ZXJzaW9uJ3MgdGV4dCwgYSBkaXJlY3RvcnkgbGlzdGluZykuXG4gKiAzLiBTZWNvbmQgaGFsZjogWUVTIOKAlCBgY2xpLnRzYDsgdGhlIHR3byBzaGFyZSBgLi9oZWFydGJlYXQudHNgLlxuICogNC4gTGlmZWN5Y2xlOiBsb25nLXJ1bm5pbmcsIG9uZSBkYWVtb24gcGVyIHNlc3Npb24sIGlkbGUtdGltZW91dCBsaWtlXG4gKiAgICBnbGFtb3VyIChsaW5nZXIgYWZ0ZXIgdGhlIGxhc3Qgc3Vic2NyaWJlciBsZWF2ZXM7IGV4aXQgMTI0KS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDigJQgYG1haW5gIGF3YWl0cyB0aGVcbiAqICAgIHNlc3Npb24ncyBlbmQgYW5kIGl0cyBvd24gZHJhaW4sIGV4YWN0bHkgYXMgZ2xhbW91cidzIHNlcnZlciBkb2VzLCBzbyB0aGVcbiAqICAgIGxhdW5jaGVyIGlzIFRFUk1JTkFMLUVYSVQgKGBwcm9jZXNzLmV4aXQoYXdhaXQgcnVuKCkpYCk6IG9uY2UgYG1haW5gXG4gKiAgICByZXNvbHZlcyBub3RoaW5nIG1heSBrZWVwIHRoZSBwcm9jZXNzIGFsaXZlLCBhbmQgYSB3YXRjaGVyIGhhbmRsZSBvciBhXG4gKiAgICBzdHJhZ2dsaW5nIHNvY2tldCB3b3VsZC4gRHJpdmVuLCBub3QgcmVhZCAoc2VlIHRoZSBzbGljZS1BIGpvdXJuYWwpLlxuICogNi4gRXZlbnQgaWRzIHJlY292ZXJlZCBhY3Jvc3MgcmVzdGFydD8gTk8g4oCUIHRoZSBsb2cgaXMgaW4gbWVtb3J5IGFuZCBpZHNcbiAqICAgIHJlc3RhcnQgYXQgMSwgZXZlbiB1bmRlciBgLS1yZXN0b3JlYCAod2hpY2ggcmVzdG9yZXMgdGhlIE1BTklGRVNULCBub3QgdGhlXG4gKiAgICBsb2cpLiBTbyB0aGUgbG9nIGlzIHN0YW1wZWQgd2l0aCBhIHBlci1ib290IEVQT0NIIChtaW5kLW1hcHBlcidzIHNoYXBlKVxuICogICAgYW5kIHRoZSB0YWlsIHJlc2V0cyBpdHMgY3Vyc29yIHdoZW4gdGhlIGVwb2NoIGNoYW5nZXMuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBObyDigJQgdGhlIHNoYXBlIHdhcyBjaG9zZW4gdG8gYmUgdGhlXG4gKiAgICBraXQncy5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBOTzogc2NyaXB0b3JpdW1cbiAqICAgIGlzIHRoZSBmaXJzdCBzcGVsbCBzY2FmZm9sZGVkIGFmdGVyIHRoZSBjb252ZXJnZW5jZS5cbiAqXG4gKiDilIDilIAgS0lUIFZFUkRJQ1RTIChwbGF5Ym9vayBONCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZXJyb3JzIFNVQkpFQ1QgKHRoZSBDTEk7IHRoZSBkYWVtb24gYW5zd2VycyBIVFRQIHN0YXR1c2VzIHRoZSBDTEkgbWFwcykgwrdcbiAqIHNlcnZlRGlzdCBTVUJKRUNUIChgcmVzb2x2ZU1vZGVgLCBgc2VydmVGcm9tRGlzdGApIMK3IGhvdXNla2VlcGluZyBTVUJKRUNULCBhbGxcbiAqIHRocmVlIGV4cG9ydHMgKGBzaG91bGRJZGxlQ2xvc2VgIHZpYSBgc3RhcnRIb3VzZWtlZXBpbmdgJ3MgaWRsZS1jbG9zZSwgdGhlXG4gKiBzbmFwc2hvdCBzd2VlcCDigJQgaGVyZSB0aGUgbWFuaWZlc3QgaXMgd3JpdHRlbiBvbiBldmVyeSBjaGFuZ2UgaW5zdGVhZCwgc28gdGhlXG4gKiBzd2VlcCdzIHNuYXBzaG90IGhvb2sgaXMgZGVsaWJlcmF0ZWx5IE5PVCBwYXNzZWQg4oCUIGFuZCBgZHJhaW5BbmRTdG9wYCkgwrdcbiAqIHRhaWxFdmVudHMgU1VCSkVDVCAodGhlIENMSSdzIGB0YWlsYCkgwrcgaGVhcnRiZWF0IFNVQkpFQ1QgKGAuL2hlYXJ0YmVhdC50c2ApIMK3XG4gKiBkaXNjb3ZlcnkgU1VCSkVDVCAoc2Vzc2lvbi1KU09OLCBFMTM6IGBzY3JpcHRvcml1bS08aWQ+Lmpzb25gICtcbiAqIGBzY3JpcHRvcml1bS1sYXRlc3QuanNvbmAgaW4gdG1wZGlyIHZpYSBgd3JpdGVGaWxlQXRvbWljYC9gdW5saW5rSWZNYXRjaGVzYCkgwrdcbiAqIGV2ZW50TG9nIFNVQkpFQ1QsIFdJVEggRVBPQ0ggKFE2KSDCtyBzc2UgU1VCSkVDVCAoYEdFVCAvZXZlbnRzYCkgwrdcbiAqIGxpYi9wcmludEpzb24gU1VCSkVDVCAodGhlIENMSSBzcGVha3MgdGhlIGFnZW50IHdpcmUpLlxuICpcbiAqIOKUgOKUgCBURUFSRE9XTiBPUkRFUiAocmVnaXN0ZXIgQTYpLCBTVEFURUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZ2xhbW91cidzIG9yZGVyOiBzdG9wIGhvdXNla2VlcGluZyDihpIgY2xvc2UgdGhlIHdhdGNoZXJzIOKGkiBwZXJzaXN0IHRoZVxuICogbWFuaWZlc3Qg4oaSIHVubGluayBkaXNjb3Zlcnkg4oaSIGVtaXQgYGNsb3NlZGAg4oaSIGRyYWluLiBEaXNjb3ZlcnkgZ29lcyBCRUZPUkUgdGhlXG4gKiBgY2xvc2VkYCBmcmFtZSBzbyBhIHRhaWwgdGhhdCBzZWVzIGBjbG9zZWRgIGFuZCBhIENMSSB2ZXJiIHRoYXQgcnVucyByaWdodFxuICogYWZ0ZXIgaXQgYm90aCBmaW5kIG5vIHBvaW50ZXIgdG8gYSBkYWVtb24gdGhhdCBpcyBsZWF2aW5nOyB0aGUgb3RoZXIgb3JkZXJcbiAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhIHZlcmIgcmVzb2x2ZXMgYSBzZXNzaW9uIHRoYXQgd2lsbCByZWZ1c2UgaXQuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgdHlwZSBGU1dhdGNoZXIsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMsIHVubGlua1N5bmMsIHdhdGNoIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgdW5saW5rSWZNYXRjaGVzLCB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudExvZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ldmVudExvZy50c1wiO1xuaW1wb3J0IHsgZHJhaW5BbmRTdG9wLCBzdGFydEhvdXNla2VlcGluZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHNcIjtcbmltcG9ydCB7IHJlZnVzZUZvcmVpZ25PcmlnaW4gfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvb3JpZ2luLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZSBhcyByZXNvbHZlTW9kZUluLCBzZXJ2ZUZyb21EaXN0IH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NlcnZlRGlzdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBTc2VDbGllbnRzLCBzc2VSZXNwb25zZSB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zc2UudHNcIjtcbmltcG9ydCB7IHF1b3RlTGFiZWwgfSBmcm9tIFwiLi9hbmNob3JzXCI7XG5pbXBvcnQgeyB1bmlmaWVkIH0gZnJvbSBcIi4vZGlmZlwiO1xuaW1wb3J0IHsgc3VtbWFyeSB9IGZyb20gXCIuL2RvY3RvclwiO1xuaW1wb3J0IHsgSURMRV9USU1FT1VUX1NFQywgU1NFX0hFQVJUQkVBVF9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgdHlwZSBBY3QsIHR5cGUgQWZ0ZXIsIHR5cGUgQmVmb3JlLCBIaXN0b3J5LCB0eXBlIEludmVyc2UsIHBsYW5JbnZlcnNlIH0gZnJvbSBcIi4vaGlzdG9yeVwiO1xuaW1wb3J0IHsgdHlwZSBQaWNrS2luZCwgcGFyc2VQaWNrZXJPdXRwdXQsIHBpY2tlckNvbW1hbmQsIHdhc0NhbmNlbGxlZCB9IGZyb20gXCIuL3BpY2tlclwiO1xuaW1wb3J0IHR5cGUge1xuICBBZ2VudENtZCxcbiAgQ2xpZW50TXNnLFxuICBQdWJsaWNTdGF0ZSxcbiAgU2VsZWN0aW9uLFxuICBTZXJ2ZXJNc2csXG4gIFN0cnVjdHVyZU9wLFxufSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgdHlwZSBTY3JlZW4sIHNlbGVjdGlvbk9uU2NyZWVuIH0gZnJvbSBcIi4vc2VsZWN0aW9uXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yLCBzaWRlTmFtZSB9IGZyb20gXCIuL3Nlc3Npb25cIjtcbmltcG9ydCB7IGxpc3REaXIsIFBhdGhFcnJvciB9IGZyb20gXCIuL3RyZWVcIjtcbmltcG9ydCB7XG4gIGF0dGVudGlvbktleSxcbiAgREVGQVVMVF9TTk9PWkVfTVMsXG4gIG5vdGVFdmVudEZhY3RzLFxuICBub3Rlc1dhaXRpbmcsXG4gIHdhaXRpbmdPbixcbn0gZnJvbSBcIi4vd2FpdGluZ1wiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8qKiByZWxlYXNlIGlmZiBgZGlzdC9pbmRleC5odG1sYCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Q7IHRoZSBlbnYgdmFyIG92ZXJyaWRlcyAoQ29udHJhY3QgMSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYC4gYHByb21wdHMuanNvbmAgYmVzaWRlIGBzZXNzaW9ucy9gIGlzIHNsaWNlIEIncyAoRTkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIC8qKiBFMjM6IGEgTkVXIHNlc3Npb24ncyB3b3Jrc3BhY2Ug4oCUIHRoZSBkaXJlY3RvcnkgYG9wZW5gIHJhbiBpbi4gQSByZXN0b3JlIGtlZXBzIGl0cyBvd24uICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHRhaWwgZnJhbWUncyBwYXlsb2FkLiBUaGUgbG9nIHN0YW1wcyBgaWRgIGFuZCBgZXBvY2hgLiAqL1xudHlwZSBMb2dFdmVudCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyB0eXBlOiBzdHJpbmcgfTtcblxuLyoqIEhvdyBsb25nIGEgYnVyc3Qgb2Ygd2F0Y2hlciBldmVudHMgb24gb25lIHBhdGggc2V0dGxlcyBiZWZvcmUgaXQgaXMgcmVhZC4gKi9cbmNvbnN0IFdBVENIX1NFVFRMRV9NUyA9IDYwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgLy8gTW9kZSBCRUZPUkUgYW55IHdyaXRlOiBhIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0XG4gIC8vIGRpZSBhdCB0aGUgaW1wb3J0IGhhdmluZyBjcmVhdGVkIG5vdGhpbmcgKGdsYW1vdXIncyBtZWFzdXJlZCBvcmRlcikuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuICBjb25zdCBkZXZJbmRleCA9XG4gICAgbW9kZSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGNvbnN0IHNlc3Npb24gPSBvcHRzLnJlc3RvcmVcbiAgICA/IFNlc3Npb24ucmVzdG9yZShob21lLCBvcHRzLnJlc3RvcmUpXG4gICAgOiBTZXNzaW9uLmNyZWF0ZShob21lLCB1bmRlZmluZWQsIG9wdHMud29ya3NwYWNlKTtcbiAgY29uc3Qgc2Vzc2lvbklkID0gc2Vzc2lvbi5pZDtcbiAgbGV0IHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBUaGUgZG9jdW1lbnQgdGV4dCBvbiBzY3JlZW4g4oCUIHRoZSBvcGVuIGRvY3VtZW50IGF0IGl0cyBhY3RpdmUgdmVyc2lvbi4gKi9cbiAgY29uc3Qgc2NyZWVuID0gKCk6IFNjcmVlbiB8IG51bGwgPT4ge1xuICAgIGNvbnN0IGQgPSBzZXNzaW9uLm9wZW5Eb2NTbHVnID8gc2Vzc2lvbi5maW5kRG9jKHNlc3Npb24ub3BlbkRvY1NsdWcpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8geyBkb2M6IGQuc2x1ZywgdmVyc2lvbjogZC5hY3RpdmUgfSA6IG51bGw7XG4gIH07XG4gIC8qKlxuICAgKiBUaGUgaGVsZCBzZWxlY3Rpb24sIG9uY2UgdGhlIHRleHQgaXQgd2FzIG1hZGUgaW4gaXMgc3RpbGwgdGhlIHRleHQgb25cbiAgICogc2NyZWVuIChFNjYpLiDim5QgUkVBRCBUSFJPVUdIIFRISVMsIE5FVkVSIGBzZWxlY3Rpb25gIERJUkVDVExZOiB0aGUgb3BlblxuICAgKiBkb2N1bWVudCBtb3ZlcyB1bmRlciBpdCBmcm9tIG1hbnkgcGxhY2VzICh0aGUgc3VyZmFjZSdzIGBvcGVuYCBhbmRcbiAgICogYG9wZW4uZG9jYCwgdGhlIGFnZW50LCBhIHZlcnNpb24gYWN0aXZhdGVkLCBhIGRvY3VtZW50IHJlbW92ZWQpLCBhbmQgYVxuICAgKiBjaGVjayBhdCBlYWNoIG9mIHRoZW0gaXMgYSBjaGVjayBzb21lIGZ1dHVyZSBwYXRoIGZvcmdldHMuIERyb3BwaW5nIGl0XG4gICAqIGhlcmUsIG9uIHRoZSBuZXh0IHJlYWQsIGlzIHdoeSBnb2luZyBiYWNrIHRvIHRoZSBmaXJzdCBkb2N1bWVudCBkb2VzIG5vdFxuICAgKiByZXZpdmUgaXQg4oCUIGV2ZXJ5IG9uZSBvZiB0aG9zZSBwYXRocyBicm9hZGNhc3RzLCBhbmQgdGhlIGJyb2FkY2FzdCByZWFkcy5cbiAgICovXG4gIGNvbnN0IGhlbGRTZWxlY3Rpb24gPSAoKTogU2VsZWN0aW9uIHwgbnVsbCA9PiB7XG4gICAgc2VsZWN0aW9uID0gc2VsZWN0aW9uT25TY3JlZW4oc2VsZWN0aW9uLCBzY3JlZW4oKSk7XG4gICAgcmV0dXJuIHNlbGVjdGlvbjtcbiAgfTtcblxuICAvLyAtLS0gcHJlZnM6IHBlci12aWV3ZXIgY29udmVuaWVuY2VzIHRoYXQgb3V0bGl2ZSBhIHNlc3Npb24ncyBwb3J0IC0tLS0tLS0tLS0tLVxuICAvLyBCcm93c2VyIHN0b3JhZ2UgaXMga2V5ZWQgYnkgb3JpZ2luLCBwb3J0IGluY2x1ZGVkLCBhbmQgZXZlcnkgc2Vzc2lvbiBnZXRzIGFcbiAgLy8gbmV3IHBvcnQg4oCUIHNvIGEgcGFuZSBzaXplIGtlcHQgaW4gbG9jYWxTdG9yYWdlIHJlc2V0cyBhdCB0aGUgbmV4dCBgb3BlbmAuXG4gIC8vIFRoZXkgbGl2ZSBpbiB0aGUgaG9tZSBpbnN0ZWFkLCBzaGFyZWQgYnkgZXZlcnkgc2Vzc2lvbiBvZiB0aGlzIGhvbWUuXG4gIGNvbnN0IHByZWZzRmlsZSA9IGpvaW4oaG9tZSwgXCJwcmVmcy5qc29uXCIpO1xuICBjb25zdCBQUkVGX0tFWSA9IC9eW2Etel1bYS16MC05Oi5fLV17MCw2M30kLztcbiAgY29uc3QgUFJFRl9WQUxVRV9NQVggPSA0MDk2O1xuICBjb25zdCBQUkVGX0tFWVNfTUFYID0gNjQ7XG4gIC8qKlxuICAgKiBSZWFkIHRoZSBob21lJ3MgcHJlZnMgRlJFU0guIFNldmVyYWwgc2Vzc2lvbnMgY2FuIHNoYXJlIG9uZSBob21lIChFMTMpLCBlYWNoXG4gICAqIGl0cyBvd24gZGFlbW9uLCBzbyBhIGNvcHkgbG9hZGVkIG9uY2UgYXQgYm9vdCBhbmQgd3JpdHRlbiBiYWNrIHdob2xlIHdvdWxkXG4gICAqIGVyYXNlIGEga2V5IGFub3RoZXIgc2Vzc2lvbiB3cm90ZSBzaW5jZSAodmVyaWZ5IHBhc3MpLiBFdmVyeSB3cml0ZSBpc1xuICAgKiB0aGVyZWZvcmUgcmVhZCDihpIgc2V0IG9uZSBrZXkg4oaSIHdyaXRlLCBhbmQgZXZlcnkgc25hcHNob3QgcmVhZHMgdGhlIGZpbGUuXG4gICAqIE9ubHkgd2VsbC1mb3JtZWQgZW50cmllcyBzdXJ2aXZlIGEgcmVhZDsgYSBiYWQgZmlsZSByZWFkcyBhcyBlbXB0eSBhbmQgaXNcbiAgICogcmVwbGFjZWQgYnkgdGhlIG5leHQgd3JpdGUuXG4gICAqL1xuICBjb25zdCByZWFkUHJlZnMgPSAoKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9PiB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByZWZzRmlsZSwgXCJ1dGY4XCIpKSBhcyB1bmtub3duO1xuICAgICAgaWYgKHJhdyAmJiB0eXBlb2YgcmF3ID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocmF3KSlcbiAgICAgICAgICBpZiAoUFJFRl9LRVkudGVzdChrKSAmJiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2Lmxlbmd0aCA8PSBQUkVGX1ZBTFVFX01BWCkgb3V0W2tdID0gdjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIHByZWZzIHlldCwgb3IgdW5yZWFkYWJsZSDigJQgZW1wdHkgKi9cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfTtcbiAgY29uc3QgdXNlckhvbWUgPSBob21lZGlyKCk7XG4gIC8qKlxuICAgKiBFNTM6IHRoZSBzbm9vemUgdGhlIGFnZW50IGFza2VkIGZvciwgYW5kIHRoZSBtZXNzYWdlcyBhbHJlYWR5IG51ZGdlZC5cbiAgICpcbiAgICog4puUIE9ORSBOVURHRSBQRVIgTUVTU0FHRSwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIEFOVEktTkFHIFJVTEUuIENvbGU6IFwid2VcbiAgICogZG9uJ3Qgd2FudCB0byBoYXZlIGEgc2l0dWF0aW9uIHdoZXJlIGFuIGFnZW50IGtlZXBzIGdldHRpbmcgcGluZ2VkIGFib3V0XG4gICAqIHNvbWV0aGluZyBhbmQgaXQncyBsaWtlLCBubywgSSdtIGFjdHVhbGx5IHdvcmtpbmcuXCIgU28gYSBtZXNzYWdlIGlkIGVudGVyc1xuICAgKiBgbnVkZ2VkYCB0aGUgZmlyc3QgdGltZSBpdCBpcyByZXBvcnRlZCDigJQgb3IgdGhlIG1vbWVudCB0aGUgYWdlbnQgc25vb3plcyBpdFxuICAgKiDigJQgYW5kIG5ldmVyIGxlYXZlcy4gQSBzbm9vemUgRVhQSVJJTkcgdGhlcmVmb3JlIGNoYW5nZXMgd2hhdCB0aGUgSFVNQU5cbiAgICogc2VlcyAoYmFjayB0byBcIm1heSBiZSBzdHVja1wiLCBiZWNhdXNlIHRoZXkgYXJlIG93ZWQgdGhlIHRydXRoKSB3aXRob3V0XG4gICAqIHBpbmdpbmcgdGhlIGFnZW50IGFnYWluLlxuICAgKlxuICAgKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBkZWxpYmVyYXRlbHkuIEEgcmVzdG9yZWQgc2Vzc2lvbiB3aG9zZVxuICAgKiBodW1hbiB3YXMgbGVmdCB3YWl0aW5nIFNIT1VMRCB0ZWxsIHRoZSBhZ2VudCB0aGF0IGFycml2ZXMg4oCUIHRoZSB3YWl0IGlzXG4gICAqIHJlYWwgYW5kIHRoZSBuZXcgYWdlbnQgaGFzIG5vdCBoZWFyZCBhYm91dCBpdC5cbiAgICovXG4gIGxldCBhY2tub3dsZWRnZWRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBjb25zdCBudWRnZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgLyoqXG4gICAqIEU2MDogdGhlIENPTlRFWFQncyB1bmRvIGhpc3Rvcnkg4oCUIG5vdCB0aGUgZWRpdG9yJ3MsIHdoaWNoIENvZGVNaXJyb3Igb3ducy5cbiAgICogSW4gbWVtb3J5IG9uIHB1cnBvc2UgKHNlZSBgaGlzdG9yeS50c2ApOiBhbiBpbnZlcnNlIGRlc2NyaWJlcyB0aGUgd29ybGQgYXNcbiAgICogaXQgaXMgbm93LCBhbmQgYSBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGZpbGVzIHNvbWVib2R5IGhhc1xuICAgKiBzaW5jZSBtb3ZlZCBieSBoYW5kLlxuICAgKi9cbiAgY29uc3QgaGlzdG9yeSA9IG5ldyBIaXN0b3J5KCk7XG5cbiAgY29uc3Qgdmlld1N0YXRlID0gKCk6IFB1YmxpY1N0YXRlID0+IHtcbiAgICBjb25zdCBiYXNlID0geyAuLi5zZXNzaW9uLnZpZXcobW9kZSwgaGVsZFNlbGVjdGlvbigpKSwgcHJlZnM6IHJlYWRQcmVmcygpLCB1c2VySG9tZSB9O1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICB3YWl0aW5nOiB3YWl0aW5nT24oYmFzZS5jaGF0LCBub3csIHsgYWNrbm93bGVkZ2VkVW50aWwgfSksXG4gICAgICBub3Rlc1dhaXRpbmc6IG5vdGVzV2FpdGluZyhzZXNzaW9uLm5vdGVGYWN0cygpLCBiYXNlLmNoYXQsIG5vdywgeyBhY2tub3dsZWRnZWRVbnRpbCB9KSxcbiAgICAgIGhpc3Rvcnk6IGhpc3RvcnkudmlldygpLFxuICAgIH07XG4gIH07XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLiAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pID0+IHtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIHRleHQpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJzeXN0ZW1cIiwgdGV4dCwgdHM6IG0udHMsIC4uLmZhY3QgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgfTtcblxuICAvLyAtLS0gdGhlIHdhdGNoZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy9cbiAgLy8g4pqgIERFVklBVElPTiBGUk9NIFRIRSBCUklFRiwgV0lUSCBJVFMgUkVBU09OOiBgbm9kZTpmc2AgYHdhdGNoYCAoQnVuJ3NcbiAgLy8gYnVpbHQtaW4pLCBOT1QgYEBwYXJjZWwvd2F0Y2hlcmAuIGBAcGFyY2VsL3dhdGNoZXJgIGlzIGEgbmF0aXZlIGFkZG9uIHdob3NlXG4gIC8vIGxvYWRlciBkb2VzIGEgcnVudGltZSBgcmVxdWlyZSgpYCBvZiBhIHBlci1wbGF0Zm9ybSBwYWNrYWdlOyBidW5kbGVkIGludG9cbiAgLy8gYGRpc3Qvc2VydmVyLmpzYCBpdCBpcyBub3QgaW5saW5lZCwgc28gdGhlIHNoaXBwZWQgZGFlbW9uIHdvdWxkIG5lZWQgYVxuICAvLyBgbm9kZV9tb2R1bGVzYCB0aGUgbWFya2V0cGxhY2UgbmV2ZXIgY29waWVzIChpbXBvcnQtYm91bmRhcnkgd2FyZCAxYidzXG4gIC8vIFwidGhlIHNoaXBwZWQgZXhlY3V0aW9uIHBhdGggY2FycmllcyBubyBkZXBlbmRlbmNpZXNcIikuIE1lYXN1cmVkIHVuZGVyIEJ1blxuICAvLyAxLjQuMCBvbiBtYWNPUyBiZWZvcmUgY2hvb3Npbmc6IGEgcmVjdXJzaXZlIGRpcmVjdG9yeSB3YXRjaCByZXBvcnRzIGFuXG4gIC8vIGluLXBsYWNlIHdyaXRlLCBhbiBhdG9taWMgdG1wK3JlbmFtZSBzYXZlLCBhbmQgYm90aCBhZ2FpbiBpbiBhXG4gIC8vIHN1YmRpcmVjdG9yeSDigJQgdGhlIGZvdXIgY2FzZXMgaW52ZXN0aWdhdGlvbiDCpzUgZHJvdmUgQHBhcmNlbC93YXRjaGVyIG9uLlxuICAvLyBUaGUgaGFzaC1jb21wYXJlIGFuZCBzZWxmLXdyaXRlIHN1cHByZXNzaW9uIGFyZSB1bmNoYW5nZWQgKHNlc3Npb24udHMpLlxuICBjb25zdCB3YXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGU1dhdGNoZXI+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG4gIGNvbnN0IG9uRnMgPSAoYWJzOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB0ID0gcGVuZGluZy5nZXQoYWJzKTtcbiAgICBpZiAodCkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHBlbmRpbmcuc2V0KFxuICAgICAgYWJzLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHBlbmRpbmcuZGVsZXRlKGFicyk7XG4gICAgICAgIGxldCBldjogRmlsZUV2ZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZXYgPSBzZXNzaW9uLm9uRmlsZUV2ZW50KGFicyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IHdhdGNoZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXYpIGhhbmRsZUZpbGVFdmVudChldik7XG4gICAgICB9LCBXQVRDSF9TRVRUTEVfTVMpLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IHN5bmNXYXRjaGVycyA9ICgpID0+IHtcbiAgICBjb25zdCB3YW50ID0gbmV3IE1hcChcbiAgICAgIHNlc3Npb24ud2F0Y2hSb290cygpLm1hcCgocikgPT4gW2Ake3IucmVjdXJzaXZlID8gXCJSXCIgOiBcIkZcIn06JHtyLndhdGNofT4ke3IucGF0aH1gLCByXSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHddIG9mIHdhdGNoZXJzKVxuICAgICAgaWYgKCF3YW50LmhhcyhrZXkpKSB7XG4gICAgICAgIHcuY2xvc2UoKTtcbiAgICAgICAgd2F0Y2hlcnMuZGVsZXRlKGtleSk7XG4gICAgICB9XG4gICAgZm9yIChjb25zdCBba2V5LCByXSBvZiB3YW50KSB7XG4gICAgICBpZiAod2F0Y2hlcnMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gV2F0Y2hlZCBhdCB0aGUgUkVBTFBBVEgsIHJlcG9ydGVkIHVuZGVyIHRoZSBzdG9yZWQgcGF0aCBmb3JtXG4gICAgICAgIC8vICh2ZXJpZnktcGFzcyBmaXggMyDigJQgc2VlIFNlc3Npb24ud2F0Y2hSb290cykuXG4gICAgICAgIGNvbnN0IHcgPSB3YXRjaChyLndhdGNoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gVGhlXG4gICAgICAgIC8vIG91dHNpZGUgdGV4dCBpcyBLRVBUIGFzIGEgbmV3IGFnZW50IHZlcnNpb24gYW5kIHRoZSBhY3RpdmUgdmVyc2lvblxuICAgICAgICAvLyBrZWVwcyB0aGUgaHVtYW4ncyB0ZXh0IOKAlCBub3RoaW5nIGlzIGxvc3QsIGFuZCB0aGUgaHVtYW4ncyBidWZmZXIgaXNcbiAgICAgICAgLy8gbm90IHRvdWNoZWQgKHZlcmlmeS1wYXNzIGZpeCA0KS5cbiAgICAgICAgYW5ub3VuY2VPdXRzaWRlKGV2LmRvYywgZXYudmVyc2lvbiwgZXYucGF0aCwgZXYucHJlc2VydmVkQXMsIGV2LnByZXNlcnZlZFBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYW5ub3VuY2VPdXRzaWRlID0gKFxuICAgIGRvYzogc3RyaW5nLFxuICAgIHZlcnNpb246IG51bWJlcixcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmcsXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7IGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jLCB2ZXJzaW9uLCBwYXRoLCBwcmVzZXJ2ZWRBcywgcHJlc2VydmVkUGF0aCB9LFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLyoqXG4gICAqIEUyNDogb25lIHN0cnVjdHVyZSBjaGFuZ2UsIGZyb20gZWl0aGVyIHBhcnR5IOKAlCB0aGUgc2FtZSBzZXNzaW9uIG1ldGhvZCwgdGhlXG4gICAqIHNhbWUgYW5ub3VuY2VtZW50IChuYW1pbmcgd2hvIGRpZCBpdCksIHRoZSBzYW1lIHRhaWwgZmFjdC4gUmV0dXJucyB0aGUgcGF0aFxuICAgKiB0aGUgY2hhbmdlIGxhbmRlZCBhdCwgd2hpY2ggdGhlIHN1cmZhY2UgdXNlcyB0byBvcGVuIG9yIHJlbmFtZSBpdC5cbiAgICovXG4gIGNvbnN0IFNUUlVDVFVSRV9PUFMgPSBuZXcgU2V0PHN0cmluZz4oW1xuICAgIFwiZG9jLmNyZWF0ZVwiLFxuICAgIFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgIFwibW92ZVwiLFxuICAgIFwicmVuYW1lXCIsXG4gICAgXCJoaWRlXCIsXG4gICAgXCJ1bmhpZGVcIixcbiAgICBcInNldC5tYWtlXCIsXG4gICAgXCJpbXBvcnRcIixcbiAgICBcIndvcmtzcGFjZS5zZXRcIixcbiAgXSBzYXRpc2ZpZXMgU3RydWN0dXJlT3BbXCJ0eXBlXCJdW10pO1xuICBjb25zdCBpc1N0cnVjdHVyZU9wID0gKG06IHsgdHlwZTogc3RyaW5nIH0pOiBtIGlzIFN0cnVjdHVyZU9wID0+IFNUUlVDVFVSRV9PUFMuaGFzKG0udHlwZSk7XG5cbiAgY29uc3Qgc3RydWN0dXJlID0gKG9wOiBTdHJ1Y3R1cmVPcCwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBjb25zdCB3aG8gPSBieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIjtcbiAgICAvLyDim5QgQ0FQVFVSRUQgQkVGT1JFIFRIRSBBQ1QsIGJlY2F1c2UgZXZlcnkgZmllbGQgaGVyZSBpcyBzb21ldGhpbmcgdGhlIGFjdFxuICAgIC8vIENIQU5HRVM6IHJlYWRpbmcgYW4gZW50cnkncyBoaWRkZW4gbGlzdCBhZnRlcndhcmRzIHJldHVybnMgdGhlIGxpc3RcbiAgICAvLyBpbmNsdWRpbmcgd2hhdCB3YXMganVzdCBoaWRkZW4sIHdoaWNoIHJlc3RvcmVzIG5vdGhpbmcgKEU2MCkuXG4gICAgY29uc3QgYmVmb3JlOiBCZWZvcmUgPSB7XG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJoaWRlXCIgPyB7IGhpZGRlbjogc2Vzc2lvbi5oaWRkZW5CZWZvcmUob3AucGF0aCkgPz8gdW5kZWZpbmVkIH0gOiB7fSksXG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJ1bmhpZGVcIiA/IHsgaGlkZGVuOiBzZXNzaW9uLmhpZGRlbk9mRW50cnkob3AuZW50cnkpID8/IHVuZGVmaW5lZCB9IDoge30pLFxuICAgICAgLi4uKG9wLnR5cGUgPT09IFwid29ya3NwYWNlLnNldFwiID8geyB3b3Jrc3BhY2U6IHNlc3Npb24ud29ya3NwYWNlIH0gOiB7fSksXG4gICAgfTtcbiAgICBjb25zdCBzaG93biA9IChwOiBzdHJpbmcpID0+IHNlc3Npb24uZGlzcGxheShwKTtcbiAgICBsZXQgcjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHBhdGg/OiBzdHJpbmcgfTtcbiAgICBsZXQgbGluZTogc3RyaW5nO1xuICAgIHN3aXRjaCAob3AudHlwZSkge1xuICAgICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRG9jKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVGb2xkZXIob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCB0aGUgZm9sZGVyICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKG9wLnBhdGgsIG9wLmludG8pO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gbW92ZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShvcC5wYXRoLCBvcC5uYW1lKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHJlbmFtZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgICBjb25zdCBoID0gc2Vzc2lvbi5oaWRlKG9wLnBhdGgpO1xuICAgICAgICByID0gaDtcbiAgICAgICAgLy8g4pqgIFRIRSBQQVJFTlRIRVRJQ0FMIEhBUyBUTyBCRSBUUlVFLiBJdCBzYWlkIFwiKHRoZSBmaWxlIGlzIHN0aWxsIG9uXG4gICAgICAgIC8vIGRpc2spXCIgdW5jb25kaXRpb25hbGx5LCB3aGljaCBpcyB3cm9uZyB0d2ljZSBvdmVyIG9uIGEgR0hPU1Qg4oCUIGFuXG4gICAgICAgIC8vIGVudHJ5IHdob3NlIGZpbGUgaXMgYWxyZWFkeSBnb25lIOKAlCBhbmQgY2FsbHMgYSBmb2xkZXIgYSBmaWxlLiBDb2xlXG4gICAgICAgIC8vIG1ldCBib3RoIGluIG9uZSBnbyB3aGlsZSBjbGVhcmluZyByZXNpZHVlIGZyb20gdGhlIEU2MCBidWcsIGFuZCBhXG4gICAgICAgIC8vIHJlYXNzdXJhbmNlIHRoYXQgaXMgZmFsc2UgaXMgd29yc2UgdGhhbiBubyByZWFzc3VyYW5jZTogaXQgaXMgdGhlXG4gICAgICAgIC8vIHNhbWUgZGVmZWN0IGFzIHRoZSBjb25mbGljdCBiYW5uZXIgY2xhaW1pbmcgZWRpdHMgaGUgaGFkIG5vdCBtYWRlLlxuICAgICAgICBjb25zdCBnb25lID0gIWV4aXN0c1N5bmMoaC5wYXRoKTtcbiAgICAgICAgY29uc3Qga2luZCA9IGdvbmUgPyBcIlwiIDogc3RhdFN5bmMoaC5wYXRoKS5pc0RpcmVjdG9yeSgpID8gXCJmb2xkZXJcIiA6IFwiZmlsZVwiO1xuICAgICAgICBsaW5lID0gZ29uZVxuICAgICAgICAgID8gYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAoaXQgd2FzIGFscmVhZHkgZ29uZSBmcm9tIGRpc2spLmBcbiAgICAgICAgICA6IGAke3dob30gcmVtb3ZlZCAke3Nob3duKGgucGF0aCl9IGZyb20gU2NyaXB0b3JpdW0gKHRoZSAke2tpbmR9IGlzIHN0aWxsIG9uIGRpc2spLmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IHUgPSBzZXNzaW9uLnVuaGlkZShvcC5lbnRyeSk7XG4gICAgICAgIHIgPSB1O1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBicm91Z2h0IGJhY2sgJHt1LnJlc3RvcmVkfSBoaWRkZW4gaXRlbSR7dS5yZXN0b3JlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2V0Lm1ha2VcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tYWtlU2V0KG9wLnBhdGgpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gdHVybmVkICR7YmFzZW5hbWUobS5wYXRoKX0gaW50byBhIHNldDogJHtzaG93bihtLmZvbGRlcil9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5pbXBvcnRUZXh0KG9wLm5hbWUsIG9wLnRleHQsIG9wLmludG8pO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjb3BpZWQgJHtvcC5uYW1lfSBpbiBhcyAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLnNldFdvcmtzcGFjZShvcC5wYXRoKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIC8vIFRoZSB3YXkgYmFjaywgcGxhbm5lZCBub3cgYW5kIGZyb20gd2hhdCB3YXMgdHJ1ZSBub3cuXG4gICAgaGlzdG9yeS5kaWQocGxhbkludmVyc2Uob3AsIHIgYXMgQWZ0ZXIsIGJlZm9yZSkpO1xuICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogb3AudHlwZSwgYnksIC4uLnIgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcjtcbiAgfTtcblxuICAvKipcbiAgICogQXBwbHkgb25lIHJlY29yZGVkIGludmVyc2UsIGFuZCByZXR1cm4gdGhlIGFjdCB0aGF0IHdvdWxkIHJldmVyc2UgVEhBVCDigJRcbiAgICogd2hpY2ggaXMgd2hhdCBnb2VzIG9udG8gdGhlIG90aGVyIHN0YWNrLlxuICAgKlxuICAgKiDim5QgQSBERUxFVEUgSEFTIE5PIFdBWSBCQUNLLCBhbmQgc2F5cyBzbyBieSByZXR1cm5pbmcgbnVsbC4gT25jZSBhIGNyZWF0ZWRcbiAgICogZmlsZSBpcyBnb25lIGl0cyBjb250ZW50cyBhcmUgZ29uZSB3aXRoIGl0LCBzbyBhIHJlZG8gdGhhdCBcInJlLWNyZWF0ZXNcIiBpdFxuICAgKiB3b3VsZCBoYW5kIGJhY2sgYW4gZW1wdHkgZmlsZSB3ZWFyaW5nIHRoZSBzYW1lIG5hbWUg4oCUIHRoZSBraW5kIG9mIGxpZSBhblxuICAgKiB1bmRvIHN0YWNrIG11c3Qgbm90IHRlbGwuIENvbmZpcm1lZCBkZWxldGlvbnMgYXJlIHRoZXJlZm9yZSBvbmUtd2F5LCB3aGljaFxuICAgKiBpcyBhbHNvIHdoeSB0aGV5IGFyZSBjb25maXJtZWQuXG4gICAqL1xuICBjb25zdCBhcHBseUludmVyc2UgPSAoaW52OiBJbnZlcnNlKTogQWN0IHwgbnVsbCA9PiB7XG4gICAgc3dpdGNoIChpbnYua2luZCkge1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKGludi5wYXRoLCBpbnYuaW50byk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBtb3ZlZCAke2Jhc2VuYW1lKG0uZnJvbSl9IGJhY2sgaW50byAke2Jhc2VuYW1lKGRpcm5hbWUobS5wYXRoKSl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwibW92ZVwiLCBwYXRoOiBtLnBhdGgsIGludG86IGRpcm5hbWUobS5mcm9tKSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShpbnYucGF0aCwgaW52Lm5hbWUpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcmVuYW1lZCAke2Jhc2VuYW1lKG0uZnJvbSl9IGJhY2sgdG8gJHtiYXNlbmFtZShtLnBhdGgpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcInJlbmFtZVwiLCBwYXRoOiBtLnBhdGgsIG5hbWU6IGJhc2VuYW1lKG0uZnJvbSkgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaWRkZW5cIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXN0b3JlSGlkZGVuKGludi5lbnRyeSwgaW52LnJlbHMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiByLndhcy5sZW5ndGggPiBpbnYucmVscy5sZW5ndGggPyBcImJyb3VnaHQgaXRlbXMgYmFja1wiIDogXCJoaWQgaXRlbXMgYWdhaW5cIixcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiByLmVudHJ5LCByZWxzOiByLndhcyB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgeyBlbnRyeSB9ID0gc2Vzc2lvbi5hZGRDb250ZXh0KGludi5wYXRoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHB1dCAke2Jhc2VuYW1lKGludi5wYXRoKX0gYmFjayBpbiB0aGUgY29udGV4dGAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImNvbnRleHQucmVtb3ZlXCIsIGVudHJ5OiBlbnRyeS5pZCB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHNlc3Npb24uZW50cnlSb290KGludi5lbnRyeSk7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ29udGV4dChpbnYuZW50cnkpO1xuICAgICAgICByZXR1cm4gcGF0aCA9PT0gbnVsbFxuICAgICAgICAgID8gbnVsbFxuICAgICAgICAgIDoge1xuICAgICAgICAgICAgICBsYWJlbDogYHRvb2sgJHtiYXNlbmFtZShwYXRoKX0gYmFjayBvdXQgb2YgdGhlIGNvbnRleHRgLFxuICAgICAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIiwgcGF0aCB9LFxuICAgICAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2VcIjoge1xuICAgICAgICBjb25zdCB3YXMgPSBzZXNzaW9uLndvcmtzcGFjZTtcbiAgICAgICAgc2Vzc2lvbi5zZXRXb3Jrc3BhY2UoaW52LnBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgc2V0IHRoZSB3b3Jrc3BhY2UgYmFjayB0byAke2Jhc2VuYW1lKGludi5wYXRoKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJ3b3Jrc3BhY2VcIiwgcGF0aDogd2FzIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGVsZXRlXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDcmVhdGVkKGludi5wYXRoLCBpbnYuZGlyKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBzdXJmYWNlIG1lc3NhZ2VzIChXZWJTb2NrZXQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHJlcGx5ID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIHRyeSB7XG4gICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KG1zZykpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSAqL1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVDbGllbnRNc2cgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogQ2xpZW50TXNnKSA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AobXNnKSkge1xuICAgICAgY29uc3QgciA9IHN0cnVjdHVyZShhbmNob3JTdXJmYWNlUGF0aHMobXNnKSwgXCJodW1hblwiKTtcbiAgICAgIGlmICh0eXBlb2Ygci5wYXRoID09PSBcInN0cmluZ1wiKVxuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInN0cnVjdHVyZS5kb25lXCIsIG9wOiBtc2cudHlwZSwgcGF0aDogci5wYXRoIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwib3BlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm9wZW5QYXRoKG1zZy5wYXRoKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIC8vIFRoZSBvcGVuZXIgZ2V0cyB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IHN0cmFpZ2h0IGF3YXkg4oCUIHRoZSBzdGF0ZVxuICAgICAgICAvLyBzbmFwc2hvdCBjYXJyaWVzIG5vIHRleHRzLCBhbmQgYSB2aWV3ZXIgbXVzdCBub3Qgd2FpdCBvbiBhIHNlY29uZCBhc2suXG4gICAgICAgIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyLmNyZWF0ZWQpXG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvYy5vcGVuZWRcIiwgZG9jOiByLnNsdWcsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChyLnNsdWcpIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwib3Blbi5kb2NcIjpcbiAgICAgICAgc2Vzc2lvbi5vcGVuU2x1Zyhtc2cuZG9jKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0KG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBtc2cudGV4dCk7XG4gICAgICAgIGlmIChyLnByZXNlcnZlZCkge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhtc2cuZG9jKTtcbiAgICAgICAgICBhbm5vdW5jZU91dHNpZGUoXG4gICAgICAgICAgICBkLnNsdWcsXG4gICAgICAgICAgICBtc2cudmVyc2lvbixcbiAgICAgICAgICAgIHNlc3Npb24uYWN0aXZlUGF0aChkLnNsdWcpID8/IFwiXCIsXG4gICAgICAgICAgICByLnByZXNlcnZlZC5uLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQucGF0aCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHIuZGlydHlDaGFuZ2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6IHtcbiAgICAgICAgLy8g4puUIFJFUExJRUQgVE8gVEhFIEFTS0lORyBTT0NLRVQsIE5PVCBCUk9BRENBU1QuIEEgc2VhcmNoIGlzIG9uZVxuICAgICAgICAvLyB2aWV3ZXIncyBxdWVzdGlvbjsgcHVzaGluZyByZXN1bHRzIHRvIGV2ZXJ5IGNsaWVudCB3b3VsZCBwdXQgc29tZW9uZVxuICAgICAgICAvLyBlbHNlJ3MgcXVlcnkgaW4geW91ciBwYW5lLiAoVGhlIHNhbWUgcmVhc29uIGBkaWZmYCByZXBsaWVzIHJhdGhlclxuICAgICAgICAvLyB0aGFuIGJyb2FkY2FzdGluZy4pXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzZWFyY2gucmVzdWx0c1wiLCByZXBvcnQ6IHNlc3Npb24uc2VhcmNoQWxsKG1zZykgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlzdG9yeS51bmRvXCI6IHtcbiAgICAgICAgY29uc3QgYWN0ID0gaGlzdG9yeS5wZWVrVW5kbygpO1xuICAgICAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIE5FRURTIFRIRSBIVU1BTidTIFdPUkQsIGNhcnJpZWQgZXhwbGljaXRseS4gQVxuICAgICAgICAvLyBjbGllbnQgdGhhdCBzaW1wbHkgb21pdHMgdGhlIGZsYWcgZ2V0cyBhIHJlZnVzYWwgcmF0aGVyIHRoYW4gYVxuICAgICAgICAvLyBkZWxldGlvbiwgc28gXCJmb3Jnb3QgdG8gY29uZmlybVwiIGNhbiBuZXZlciBiZWNvbWUgXCJkZWxldGVkIGFueXdheVwiLlxuICAgICAgICBpZiAoYWN0LmludmVyc2Uua2luZCA9PT0gXCJkZWxldGVcIiAmJiBtc2cuY29uZmlybURlbGV0ZSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVW5kb2luZyBcIiR7YWN0LmxhYmVsfVwiIHdvdWxkIGRlbGV0ZSAke3Nlc3Npb24uZGlzcGxheShhY3QuaW52ZXJzZS5wYXRoKX0g4oCUIGNvbmZpcm0gaXQgZmlyc3QuYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tVbmRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgdW5kaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS51bmRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIFRoZSByZWZ1c2FsIHRoZSBodW1hbiBuZWVkcyB0byByZWFkIOKAlCBhIGZvbGRlciB3aXRoIHRoaW5ncyBpbiBpdCxcbiAgICAgICAgICAvLyBvciBhIHdvcmxkIHRoYXQgaGFzIG1vdmVkIHVuZGVyIGEgcmVjb3JkZWQgaW52ZXJzZS4gVGhlIGFjdCBTVEFZU1xuICAgICAgICAgIC8vIG9uIHRoZSBzdGFjazogbm90aGluZyBoYXBwZW5lZCwgc28gbm90aGluZyBzaG91bGQgYmUgZm9yZ290dGVuLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnJlZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtSZWRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGlzdG9yeS50b29rUmVkbyhhcHBseUludmVyc2UoYWN0LmludmVyc2UpKTtcbiAgICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgICBhbm5vdW5jZShgWW91IHJlZGlkOiAke2FjdC5sYWJlbH0uYCwgeyBmYWN0OiBcImhpc3RvcnkucmVkb1wiIH0pO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VsZWN0XCI6XG4gICAgICAgIC8vIEFNQklFTlQgc3RhdGU6IHN0b3JlZCBhbmQgc2hvd24sIG5ldmVyIHB1c2hlZCBvbnRvIHRoZSBhZ2VudCdzIHRhaWwuXG4gICAgICAgIC8vIOKblCBPbmUgbmFtaW5nIGEgZG9jdW1lbnQgdGhhdCBpcyBub3Qgb24gc2NyZWVuIGlzIGEgc3RhbGUgZWNobyBmcm9tXG4gICAgICAgIC8vIGJlZm9yZSBhIHN3aXRjaCAoRTY2KSwgYW5kIGlzIG5vdCBoZWxkLlxuICAgICAgICBzZWxlY3Rpb24gPSBzZWxlY3Rpb25PblNjcmVlbihtc2cuc2VsZWN0aW9uLCBzY3JlZW4oKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCB0ZXh0ID0gbXNnLnRleHQudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICAgICAgLy8g4pqgIEEgQkFDS1NUT1AsIEFORCBOTyBURVNUIENBTiBQSU4gSVQgKEU2NikuIEV2ZXJ5IHBhdGggdGhhdCBtb3ZlcyB0aGVcbiAgICAgICAgLy8gb3BlbiBkb2N1bWVudCBvciBpdHMgdmVyc2lvbiBicm9hZGNhc3RzIGZpcnN0LCBhbmQgdGhlIGJyb2FkY2FzdCdzXG4gICAgICAgIC8vIHJlYWQgaGFzIGFscmVhZHkgZHJvcHBlZCBhIHN0YWxlIHNlbGVjdGlvbiDigJQgc28gcmVhZGluZyB0aGUgcmF3XG4gICAgICAgIC8vIGBzZWxlY3Rpb25gIGhlcmUgaXMgdW5yZWFjaGFibGUtd3JvbmcgYnkgY29uc3RydWN0aW9uLiBJdCByZWFkc1xuICAgICAgICAvLyB0aHJvdWdoIHRoZSBydWxlIGFueXdheSwgZm9yIHRoZSBwYXRoIHNvbWVib2R5IGFkZHMgd2l0aG91dCBhXG4gICAgICAgIC8vIGJyb2FkY2FzdC5cbiAgICAgICAgY29uc3Qgc2VsID0gbXNnLndpdGhTZWxlY3Rpb24gPyBoZWxkU2VsZWN0aW9uKCkgOiBudWxsO1xuICAgICAgICBjb25zdCBhY3RpdmVQYXRoID0gc2VsID8gc2Vzc2lvbi5hY3RpdmVQYXRoKHNlbC5kb2MpIDogc2Vzc2lvbi5hY3RpdmVQYXRoKCk7XG4gICAgICAgIC8vIEU2NSdzIFwiQXNrIHRoZSBhZ2VudFwiOiB0aGUgbWVzc2FnZSBjYXJyaWVzIHRoZSBub3RlIGl0IGlzIGFib3V0LCBzb1xuICAgICAgICAvLyB0aGUgYWdlbnQgY2FuIGFjdCBvbiBpdCBhbmQgcmVzb2x2ZSBpdCBieSBpZCByYXRoZXIgdGhhbiBieSBtYXRjaGluZ1xuICAgICAgICAvLyBwcm9zZS4g4puUIE9ORSBBU0sgQVQgQSBUSU1FOiB3aGlsZSBhIG1lc3NhZ2UgYWJvdXQgdGhpcyBub3RlIGlzXG4gICAgICAgIC8vIHVuYW5zd2VyZWQgdGhlIG5vdGUgYWxyZWFkeSBzYXlzIGl0IHdhcyBhc2tlZCwgc28gYSBzZWNvbmQgaXMgYVxuICAgICAgICAvLyBkb3VibGUtY2xpY2ssIG5vdCBhIG5ldyBxdWVzdGlvbiDigJQgZHJvcHBlZCwgYW5kIGRlcml2ZWQgcmF0aGVyIHRoYW5cbiAgICAgICAgLy8gZmxhZ2dlZDogaXQgaXMgdGhlIHNhbWUgZmFjdCB0aGUgbm90ZSdzIG93biBiYWRnZSByZWFkcy5cbiAgICAgICAgbGV0IG5vdGU6IHsgZG9jOiBzdHJpbmc7IGlkOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKG1zZy5ub3RlKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24ubm90ZUZhY3RzKCkuZmluZCgoeCkgPT4geC5zbHVnID09PSBtc2cubm90ZT8uZG9jKTtcbiAgICAgICAgICBpZiAoIWQ/Lm5vdGVzLnNvbWUoKG4pID0+IG4uaWQgPT09IG1zZy5ub3RlPy5pZCkpIHtcbiAgICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYE5vIG5vdGUgJHttc2cubm90ZS5pZH0gb24gJHttc2cubm90ZS5kb2N9LmAgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IG93ZWQgPSBub3Rlc1dhaXRpbmcoc2Vzc2lvbi5ub3RlRmFjdHMoKSwgc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7XG4gICAgICAgICAgICBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAob3dlZC5zb21lKCh3KSA9PiB3LmRvYyA9PT0gbXNnLm5vdGU/LmRvYyAmJiB3Lm5vdGVJZCA9PT0gbXNnLm5vdGUuaWQgJiYgdy5hc2tlZEluKSlcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICBub3RlID0geyBkb2M6IG1zZy5ub3RlLmRvYywgaWQ6IG1zZy5ub3RlLmlkIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHtcbiAgICAgICAgICBzZWxlY3Rpb246IHNlbCxcbiAgICAgICAgICBhY3RpdmVQYXRoLFxuICAgICAgICAgIC4uLihub3RlID8geyBub3RlIH0gOiB7fSksXG4gICAgICAgIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgbWVzc2FnZV9pZDogbS5pZCxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2Yoc2VsPy5kb2MpLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICAgIC4uLihub3RlXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICBub3RlOiBub3RlLmlkLFxuICAgICAgICAgICAgICAgIGRvYzogbm90ZS5kb2MsXG4gICAgICAgICAgICAgICAgaGludDogYGFib3V0IG5vdGUgJHtub3RlLmlkfSDigJQgXFxgbm90ZXMgLS1kb2MgJHtub3RlLmRvY31cXGAgaGFzIGl0IHdob2xlOyBhbnN3ZXIgaGVyZSwgYW5kIFxcYG5vdGUtcmVzb2x2ZSAke25vdGUuaWR9IC0tZG9jICR7bm90ZS5kb2N9XFxgIHdoZW4gaXQgaXMgZGVhbHQgd2l0aGAsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDoge30pLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIGFjdGl2YXRlKG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBcImh1bWFuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwibm90ZS5hZGRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5hZGROb3RlKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgYm9keTogbXNnLmJvZHksXG4gICAgICAgICAgd2hvOiBcImh1bWFuXCIsXG4gICAgICAgICAgcmFuZ2U6IHsgZnJvbTogbXNnLmZyb20sIHRvOiBtc2cudG8gfSxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIEU2NTogdGhlIGV2ZW50IGNhcnJpZXMgdGhlIG5vdGUgaXRzZWxmIHdoZW4gaXQgaXMgc2hvcnQsIGFuZCBuYW1lc1xuICAgICAgICAvLyB0aGUgYWN0IHRoYXQgY2xvc2VzIGl0IOKAlCBhbiBhZ2VudCBzaG91bGQgbm90IGhhdmUgdG8gZ28gYW5kIGFza1xuICAgICAgICAvLyB3aGF0IGp1c3QgYXJyaXZlZCBiZWZvcmUgaXQgY2FuIHN0YXJ0LlxuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgLi4ubm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhtc2cuaWQsIG1zZy5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpIHtcbiAgICAgICAgICBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgYERvbmU6ICR7ci50YXNrLnRleHR9YCk7XG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suZG9uZVwiLCB0YXNrOiByLnRhc2suaWQsIGJ5OiBcImh1bWFuXCIgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVUYXNrKG1zZy5pZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrcy5jbGVhclwiOiB7XG4gICAgICAgIHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBtc2cuZG9jLCBpZDogbXNnLmlkLCBib2R5OiBtc2cuYm9keSwgd2hvOiBcImh1bWFuXCIgfSk7XG4gICAgICAgIC8vIEEgaHVtYW4ncyByZXdyaXRlIGlzIG93ZWQgYW4gYW5zd2VyIGFnYWluIChFNjUpLCBzbyBpdCBzYXlzIHdoYXRcbiAgICAgICAgLy8gdGhlIG5vdGUgbm93IHNheXMsIGV4YWN0bHkgYXMgYG5vdGUuYWRkZWRgIGRvZXMuXG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgLi4ubm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICBpZDogbXNnLmlkLFxuICAgICAgICAgIHJlc29sdmVkOiBtc2cucmVzb2x2ZWQsXG4gICAgICAgICAgd2hvOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogbXNnLnJlc29sdmVkID8gXCJub3RlLnJlc29sdmVkXCIgOiBcIm5vdGUucmVvcGVuZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICAvLyBBIGh1bWFuIHJlb3BlbmluZyBhIG5vdGUgaXMgYXNraW5nIGFnYWluIChFNjUpLCBzbyBpdCBjYXJyaWVzIHdoYXRcbiAgICAgICAgICAvLyBgbm90ZS5hZGRlZGAgY2Fycmllcy5cbiAgICAgICAgICAuLi4obXNnLnJlc29sdmVkXG4gICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICA6IG5vdGVFdmVudEZhY3RzKHIuc2x1Zywgci5ub3RlLCBzZXNzaW9uLm5vdGVMaW5lcyhyLnNsdWcsIHIubm90ZSkpKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLnJlbW92ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogbXNnLmRvYywgdmVyc2lvbjogbXNnLnZlcnNpb24gfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgRGVsZXRlZCB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfSR7ci5sYWJlbCA/IGAg4oCUICR7ci5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5kZWxldGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgLi4uKG1zZy5mcm9tID09PSB1bmRlZmluZWQgPyB7fSA6IHsgZnJvbTogbXNnLmZyb20gfSksXG4gICAgICAgICAgLi4uKG1zZy5sYWJlbCA/IHsgbGFiZWw6IG1zZy5sYWJlbCB9IDoge30pLFxuICAgICAgICAgIGF1dGhvcjogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgLy8g4puUIFNBWSBXSEVSRSBUSEVZIEFSRSwgbm90IGp1c3Qgd2hhdCB3YXMgbWFkZSAoRTQyKS4gVGhlIG9sZCBtZXNzYWdlXG4gICAgICAgIC8vIGFubm91bmNlZCB0aGUgbmV3IHZlcnNpb24gYW5kIHdlbnQgcXVpZXQgYWJvdXQgd2hpY2ggb25lIHRoZSBodW1hblxuICAgICAgICAvLyB3YXMgZWRpdGluZyDigJQgd2hpY2ggaXMgZXhhY3RseSBob3cgc29tZW9uZSB0eXBlcyBpbnRvIHYxIGJlbGlldmluZ1xuICAgICAgICAvLyB0aGV5IGFyZSBpbiB2Mi5cbiAgICAgICAgaWYgKG1zZy5hY3RpdmF0ZSkgc2Vzc2lvbi5hY3RpdmF0ZSh7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBNYWRlIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke21zZy5sYWJlbCA/IGAg4oCUICR7bXNnLmxhYmVsfWAgOiBcIlwifS4gYCArXG4gICAgICAgICAgICAobXNnLmFjdGl2YXRlXG4gICAgICAgICAgICAgID8gYFlvdSBhcmUgbm93IGVkaXRpbmcgdiR7ci52ZXJzaW9uLm59LmBcbiAgICAgICAgICAgICAgOiBgWW91IGFyZSBzdGlsbCBlZGl0aW5nIHYke3IudmVyc2lvbi5mcm9tfS5gKSxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLm4sXG4gICAgICAgICAgZnJvbTogci52ZXJzaW9uLmZyb20sXG4gICAgICAgICAgYWN0aXZhdGVkOiBtc2cuYWN0aXZhdGUgPT09IHRydWUsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uc2F2ZShtc2cuZG9jKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBgU2F2ZWQgdiR7ci52ZXJzaW9ufSB0byAke3Iub3JpZ2luYWx9LmApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJzYXZlZFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgb3JpZ2luYWw6IHIub3JpZ2luYWwsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicmV2ZXJ0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmV2ZXJ0KG1zZy5kb2MpO1xuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgUmV2ZXJ0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke21zZy5kb2N9IHRvIHRoZSBzYXZlZCBmaWxlLmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJyZXZlcnRlZFwiLCBkb2M6IG1zZy5kb2MsIHZlcnNpb246IHIudmVyc2lvbiwgdHM6IG0udHMgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOlxuICAgICAgICBhZGRQYXRocyhbc3VyZmFjZVBhdGgobXNnLnBhdGgpXSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZXZlYWxcIjpcbiAgICAgICAgcmV2ZWFsUGF0aChzZXNzaW9uLnNob3duUGF0aChzdXJmYWNlUGF0aChtc2cucGF0aCkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbC52ZXJzaW9uXCI6XG4gICAgICAgIC8vIFRoZSBkYWVtb24gcmVzb2x2ZXMgaXQsIHNvIHRoZSBzdXJmYWNlIG5ldmVyIG5hbWVzIGEgcGF0aCBvdXRzaWRlXG4gICAgICAgIC8vIHdoYXQgdGhlIHNlc3Npb24gYWxyZWFkeSBvd25zLlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24ucmVhZFZlcnNpb24obXNnLmRvYywgbXNnLnZlcnNpb24pLnBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicGlja1wiOiB7XG4gICAgICAgIHZvaWQgb3BlblBpY2tlcih3cywgbXNnLndhbnQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjpcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KG1zZy5pZCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmVhZFwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogbXNnLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImRpZmZcIjoge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImRpZmZcIiwgLi4uc2Vzc2lvbi5jb21wYXJlKHsgZG9jOiBtc2cuZG9jLCBhZ2FpbnN0OiBtc2cuYWdhaW5zdCB9KSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1lcmdlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWVyZ2UoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LCBodW5rczogbXNnLmh1bmtzIH0pO1xuICAgICAgICAvLyBUaGUgYnVmZmVyIHRoZSBodW1hbiBpcyBsb29raW5nIGF0IG11c3QgYmUgdG9sZDogdGhlIG1lcmdlIHdyb3RlIHRoZVxuICAgICAgICAvLyBhY3RpdmUgdmVyc2lvbidzIEZJTEUsIGFuZCB0aGUgZWRpdG9yJ3MgdGV4dCBpcyBub3cgYmVoaW5kIGl0LlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBUb29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKG1zZy5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lcmdlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBhZ2FpbnN0OiBtc2cuYWdhaW5zdCxcbiAgICAgICAgICBodW5rczogbXNnLmh1bmtzLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJlZnMuc2V0XCI6IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFQUkVGX0tFWS50ZXN0KG1zZy5rZXkpIHx8XG4gICAgICAgICAgdHlwZW9mIG1zZy52YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgIG1zZy52YWx1ZS5sZW5ndGggPiBQUkVGX1ZBTFVFX01BWFxuICAgICAgICApXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX1gKTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHJlYWRQcmVmcygpO1xuICAgICAgICBpZiAoY3VycmVudFttc2cua2V5XSA9PT0gbXNnLnZhbHVlKSByZXR1cm47XG4gICAgICAgIGlmICghKG1zZy5rZXkgaW4gY3VycmVudCkgJiYgT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoID49IFBSRUZfS0VZU19NQVgpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfTogJHtQUkVGX0tFWVNfTUFYfSBrZXlzIGFscmVhZHkga2VwdGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgd3JpdGVGaWxlQXRvbWljKFxuICAgICAgICAgIHByZWZzRmlsZSxcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IC4uLmN1cnJlbnQsIFttc2cua2V5XTogbXNnLnZhbHVlIH0sIG51bGwsIDIpfVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJncmFwaFwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJncmFwaFwiLCBlbnRyeTogbXNnLmVudHJ5LCBncmFwaDogc2Vzc2lvbi5ncmFwaEZvcihtc2cuZW50cnkpIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAgIGVudHJ5OiBtc2cuZW50cnksXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJsaW5rLm9wZW5cIjoge1xuICAgICAgICAvLyBFMzM6IGEgbGluayBpbnNpZGUgdGhlIGJ1bmRsZSBpcyBGT0xMT1dFRDsgb25lIHRoYXQgZXNjYXBlcyBpdCBpc1xuICAgICAgICAvLyByZXBvcnRlZCBzbyB0aGUgc3VyZmFjZSBjYW4gb2ZmZXIgdG8gYWRkIGl0LCBuZXZlciBhZGRlZCBzaWxlbnRseS5cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZUxpbmsobXNnLmZyb20sIG1zZy50YXJnZXQpO1xuICAgICAgICBpZiAoci5zdGF0ZSA9PT0gXCJpbi1idW5kbGVcIikge1xuICAgICAgICAgIHNlc3Npb24ub3BlblBhdGgoci5wYXRoKTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhzZXNzaW9uLm9wZW5Eb2NTbHVnID8/IFwiXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oZC5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcImxpbmsudGFyZ2V0XCIsXG4gICAgICAgICAgdGFyZ2V0OiBtc2cudGFyZ2V0LFxuICAgICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgICAgIC4uLihyLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHt9IDogeyBwYXRoOiByLnBhdGggfSksXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWV0YS5zdWdnZXN0XCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zdWdnZXN0TWV0YShtc2cucGF0aCwgXCJodW1hblwiKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtZXRhLnN1Z2dlc3Rpb25cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgYmxvY2s6IHIuYmxvY2ssXG4gICAgICAgICAgICAuLi4oci50eXBlID8geyBzdWdnZXN0ZWRUeXBlOiByLnR5cGUgfSA6IHt9KSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtb3ZlLnBsYW5cIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1vdmUucGxhblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBpbnRvOiBtc2cuaW50byxcbiAgICAgICAgICAgIHBsYW46IHNlc3Npb24ubW92ZVBsYW4oc3VyZmFjZVBhdGgobXNnLnBhdGgpLCBzdXJmYWNlUGF0aChtc2cuaW50bykpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZnMubGlzdFwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBleHBhbmRIb21lKG1zZy5wYXRoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImZzLmxpc3RcIiwgcGF0aDogbXNnLnBhdGgsIGVudHJpZXM6IGxpc3REaXIocGF0aCkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJmcy5saXN0XCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVudHJpZXM6IFtdLFxuICAgICAgICAgICAgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyDilIDilIAgdGhlIG5hdGl2ZSBwaWNrZXIgKG9uZSBkaWFsb2cgYXQgYSB0aW1lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy9cbiAgLy8gQSBtb2RhbCBkaWFsb2cgb3ducyB0aGUgaHVtYW4ncyBhdHRlbnRpb24sIGFuZCBhIHNlY29uZCBvbmUgYmVoaW5kIHRoZVxuICAvLyBmaXJzdCBjYW5ub3QgYmUgc2VlbiBvciBkaXNtaXNzZWQg4oCUIHNvIGEgcmVxdWVzdCB3aGlsZSBvbmUgaXMgb3BlbiBpc1xuICAvLyByZWZ1c2VkIGluIHdvcmRzIHJhdGhlciB0aGFuIHF1ZXVlZC5cbiAgbGV0IHBpY2tlck9wZW4gPSBmYWxzZTtcbiAgY29uc3QgemVuaXR5ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJsaW51eFwiID8gQnVuLndoaWNoKFwiemVuaXR5XCIpIDogbnVsbDtcbiAgY29uc3Qgb3BlblBpY2tlciA9IGFzeW5jIChcbiAgICB3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPixcbiAgICB3YW50OiBcImNvbnRleHQtZmlsZVwiIHwgXCJjb250ZXh0LWZvbGRlclwiIHwgXCJ3b3Jrc3BhY2VcIixcbiAgKSA9PiB7XG4gICAgaWYgKHBpY2tlck9wZW4pIHtcbiAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogXCJhIGZpbGUgcGlja2VyIGlzIGFscmVhZHkgb3BlblwiIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBraW5kOiBQaWNrS2luZCA9IHdhbnQgPT09IFwiY29udGV4dC1maWxlXCIgPyBcImZpbGVcIiA6IFwiZm9sZGVyXCI7XG4gICAgY29uc3QgcHJvbXB0ID1cbiAgICAgIHdhbnQgPT09IFwid29ya3NwYWNlXCJcbiAgICAgICAgPyBcIkNob29zZSB0aGUgd29ya3NwYWNlIGZvbGRlciBmb3Igc2NyaXB0b3JpdW1cIlxuICAgICAgICA6IHdhbnQgPT09IFwiY29udGV4dC1mb2xkZXJcIlxuICAgICAgICAgID8gXCJDaG9vc2UgYSBmb2xkZXIgdG8gYWRkIHRvIHNjcmlwdG9yaXVtXCJcbiAgICAgICAgICA6IFwiQ2hvb3NlIGRvY3VtZW50cyB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIjtcbiAgICBjb25zdCBjbWQgPSBwaWNrZXJDb21tYW5kKHByb2Nlc3MucGxhdGZvcm0sIGtpbmQsIHByb21wdCwgemVuaXR5KTtcbiAgICBpZiAoIWNtZCkge1xuICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgdHlwZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgbm8gZmlsZSBwaWNrZXIgb24gdGhpcyBzeXN0ZW0gKCR7cHJvY2Vzcy5wbGF0Zm9ybX0pIOKAlCB0eXBlIHRoZSBwYXRoIGluc3RlYWRgLFxuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHBpY2tlck9wZW4gPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKGNtZCwgeyBzdGRvdXQ6IFwicGlwZVwiLCBzdGRlcnI6IFwicGlwZVwiLCBzdGRpbjogXCJpZ25vcmVcIiB9KTtcbiAgICAgIGNvbnN0IFtvdXQsIGNvZGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW25ldyBSZXNwb25zZShwcm9jLnN0ZG91dCkudGV4dCgpLCBwcm9jLmV4aXRlZF0pO1xuICAgICAgdG91Y2goKTsgLy8gYSBodW1hbiBzdG9vZCBhdCBhIGRpYWxvZzsgdGhlIHNlc3Npb24gaXMgbm90IGlkbGVcbiAgICAgIGNvbnN0IHBhdGhzID0gcGFyc2VQaWNrZXJPdXRwdXQob3V0KTtcbiAgICAgIGlmIChwYXRocy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgLy8gQ2FuY2VsbGVkOiBub3RoaW5nIGNob3Nlbiwgbm90aGluZyBzYWlkLiBBIHJlYWwgZmFpbHVyZSBpcyBzYWlkLlxuICAgICAgICBpZiAoIXdhc0NhbmNlbGxlZChjb2RlLCBvdXQpKVxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYHRoZSBmaWxlIHBpY2tlciBmYWlsZWQgKGV4aXQgJHtjb2RlfSlgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBXaGF0IHdhcyBjaG9zZW4gaXMgYWRtaXR0ZWQgbGlrZSBhbnkgb3RoZXIgcGF0aCDigJQgYSBwaWNrZWQgZmlsZSB0aGF0XG4gICAgICAvLyBzY3JpcHRvcml1bSBkb2VzIG5vdCBvcGVuIGlzIHJlZnVzZWQgaW4gdGhlIHNpZGViYXIncyBvd24gd29yZHMsIGFuZFxuICAgICAgLy8gdGhhdCByZWZ1c2FsIG11c3Qgbm90IHJlYWQgYXMgXCJ0aGUgcGlja2VyIGZhaWxlZFwiLlxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKHdhbnQgPT09IFwid29ya3NwYWNlXCIpXG4gICAgICAgICAgc3RydWN0dXJlKHsgdHlwZTogXCJ3b3Jrc3BhY2Uuc2V0XCIsIHBhdGg6IHBhdGhzWzBdIGFzIHN0cmluZyB9LCBcImh1bWFuXCIpO1xuICAgICAgICBlbHNlIGFkZFBhdGhzKHBhdGhzKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgdHlwZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgY291bGQgbm90IG9wZW4gdGhlIGZpbGUgcGlja2VyOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHBpY2tlck9wZW4gPSBmYWxzZTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYWN0aXZlT2YgPSAoZG9jPzogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qgc2x1ZyA9IGRvYyA/PyBzZXNzaW9uLm9wZW5Eb2NTbHVnO1xuICAgIGlmICghc2x1ZykgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBzZXNzaW9uLmRvYyhzbHVnKTtcbiAgICAgIHJldHVybiB7IGRvYzogdi5zbHVnLCB2ZXJzaW9uOiB2LmFjdGl2ZSwgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHYuc2x1ZykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gYWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8qKiBTaG93IGEgZmlsZSBpbiB0aGUgcGxhdGZvcm0ncyBmaWxlIG1hbmFnZXIuIEFuIGFyZ3YsIG5ldmVyIGEgc2hlbGwgc3RyaW5nOlxuICAgKiAgdGhlIHBhdGggaXMgZGF0YSwgd2hhdGV2ZXIgaXQgaG9sZHMuICovXG4gIGNvbnN0IHJldmVhbFBhdGggPSAocGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3QgW2NtZCwgLi4uYXJnc10gPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIlxuICAgICAgICA/IFtcIm9wZW5cIiwgXCItUlwiLCBwYXRoXVxuICAgICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICAgID8gW1wiZXhwbG9yZXJcIiwgYC9zZWxlY3QsJHtwYXRofWBdXG4gICAgICAgICAgOiBbXCJ4ZGctb3BlblwiLCBkaXJuYW1lKHBhdGgpXTtcbiAgICBCdW4uc3Bhd24oW2NtZCBhcyBzdHJpbmcsIC4uLmFyZ3NdLCB7IHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0gfSkudW5yZWYoKTtcbiAgfTtcblxuICBjb25zdCBoYW5kbGVBZ2VudENtZCA9IChjbWQ6IEFnZW50Q21kKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGlmIChpc1N0cnVjdHVyZU9wKGNtZCkpIHJldHVybiBzdHJ1Y3R1cmUoY21kLCBcImFnZW50XCIpO1xuICAgIHN3aXRjaCAoY21kLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJtZXRhXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLm1ldGFGb3IoY21kLnBhdGgpO1xuICAgICAgY2FzZSBcImdyYXBoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmdyYXBoRm9yKGNtZC5lbnRyeSkgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNhc2UgXCJkYW5nbGluZ1wiOlxuICAgICAgICByZXR1cm4gc2Vzc2lvbi5kYW5nbGluZ0xpbmtzKGNtZC5lbnRyeSk7XG4gICAgICBjYXNlIFwiZG9jdG9yXCI6IHtcbiAgICAgICAgY29uc3QgbGlzdCA9IHNlc3Npb24uY2hlY2t1cCgpO1xuICAgICAgICByZXR1cm4geyBmaW5kaW5nczogbGlzdCwgY291bnQ6IGxpc3QubGVuZ3RoIH0gYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb3JnZXRcIjoge1xuICAgICAgICBjb25zdCBmID0gc2Vzc2lvbi5mb3JnZXREb2MoY21kLmRvYyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBmb3Jnb3QgJHtmLm5hbWV9IOKAlCBpdHMgZmlsZSB3YXMgZ29uZSwgYW5kICR7Zi52ZXJzaW9ucyA9PT0gMSA/IFwiMSB2ZXJzaW9uXCIgOiBgJHtmLnZlcnNpb25zfSB2ZXJzaW9uc2B9IGluIHRoaXMgc2Vzc2lvbiAke2YudmVyc2lvbnMgPT09IDEgPyBcImlzXCIgOiBcImFyZVwifSBubyBsb25nZXIgcmVhY2hhYmxlLmAsXG4gICAgICAgICAgeyBmYWN0OiBcImRvYy5mb3Jnb3R0ZW5cIiwgZG9jOiBmLnNsdWcsIG9yaWdpbmFsOiBmLm9yaWdpbmFsIH0sXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiBmIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLnNlYXJjaEFsbChjbWQpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjYXNlIFwiYmFja2xpbmtzXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmJhY2tsaW5rcyhjbWQucGF0aCk7XG4gICAgICBjYXNlIFwibWV0YS5pbml0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YUluaXQoY21kLnBhdGgsIHtcbiAgICAgICAgICAuLi4oY21kLm1ldGFUeXBlID8geyB0eXBlOiBjbWQubWV0YVR5cGUgfSA6IHt9KSxcbiAgICAgICAgICBieTogY21kLmJ5ID8/IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBhZGRlZCBmcm9udG1hdHRlciB0byAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgLi4ucixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc2V0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YVNldChjbWQucGF0aCwgY21kLmZpZWxkcyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBzZXQgJHsoci5zZXQgYXMgc3RyaW5nW10pLmpvaW4oXCIsIFwiKX0gb24gJHtzZXNzaW9uLmRpc3BsYXkoU3RyaW5nKHIucGF0aCkpfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXRhLnNldFwiLCBieTogXCJhZ2VudFwiLCAuLi5yIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogY21kLmRvYywgdmVyc2lvbjogY21kLnZlcnNpb24gfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBkZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIHJlbWFpbmluZzogci5yZW1haW5pbmcgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBib2R5OiBjbWQuYm9keSxcbiAgICAgICAgICB3aG86IFwiYWdlbnRcIixcbiAgICAgICAgICBxdW90ZTogY21kLnF1b3RlLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IG5vdGVkIOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnSBvbiAke3Iuc2x1Z30uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5hZGRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgcXVvdGU6IHIubm90ZS5xdW90ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGVzXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubm90ZXNPZih7IGRvYzogY21kLmRvYywgLi4uKGNtZC5hbGwgPyB7IGFsbDogdHJ1ZSB9IDoge30pIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZXM6IHIubm90ZXMgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnJlbW92ZVRhc2soY21kLmlkKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgcmVtb3ZlZDogdHJ1ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2tzLmNsZWFyXCI6IHtcbiAgICAgICAgY29uc3QgY2xlYXJlZCA9IHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgY2xlYXJlZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtpbmdcIjoge1xuICAgICAgICAvLyBFNTMncyBzbm9vemUuIEl0IGRvZXMgTk9UIHBvc3QgdG8gdGhlIGNoYXQ6IGFuIGFnZW50IHNheWluZyBcInN0aWxsXG4gICAgICAgIC8vIHdvcmtpbmdcIiBpbiB0aGUgY29udmVyc2F0aW9uIGlzIGEgcmVwbHksIGFuZCBpdCBjYW4gZG8gdGhhdCB3aXRoXG4gICAgICAgIC8vIGBzYXlgIOKAlCB0aGlzIGlzIHRoZSBxdWlldGVyIHRoaW5nLCBmb3Igd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvXG4gICAgICAgIC8vIHJlcG9ydCB5ZXQgYnV0IHRoZSBhbGFybSBzaG91bGQgc3RvcC5cbiAgICAgICAgY29uc3QgbXMgPSBjbWQuc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8gY21kLnNlY29uZHMgKiAxMDAwIDogREVGQVVMVF9TTk9PWkVfTVM7XG4gICAgICAgIGFja25vd2xlZGdlZFVudGlsID0gRGF0ZS5ub3coKSArIE1hdGgubWF4KDAsIG1zKTtcbiAgICAgICAgLy8gV2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBhY2tub3dsZWRnZWQsIHNvIGl0IG11c3QgbmV2ZXIgYmUgbnVkZ2VkIGFnYWluLlxuICAgICAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICAgICAgaWYgKHcpIG51ZGdlZC5hZGQody5tZXNzYWdlSWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHVudGlsOiBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICAgICAgICBzZWNvbmRzOiBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIG1zKSAvIDEwMDApLFxuICAgICAgICAgIC4uLih3ID8geyB3YWl0aW5nOiB3Lm1lc3NhZ2VJZCB9IDoge30pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhcnRcIjoge1xuICAgICAgICBjb25zdCB0ID0gc2Vzc2lvbi5zdGFydFRhc2soY21kLnRleHQsIFwiYWdlbnRcIik7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLnN0YXJ0ZWRcIiwgdGFzazogdC5pZCwgdGV4dDogdC50ZXh0LCBieTogXCJhZ2VudFwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnN0YXR1c1wiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnNldFRhc2tTdGF0dXMoY21kLmlkLCBjbWQuc3RhdHVzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgc3RhdHVzOiB0LnN0YXR1cyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2soY21kLmlkLCBjbWQub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KVxuICAgICAgICAgIGFubm91bmNlKGBEb25lOiAke3IudGFzay50ZXh0fSR7ci50YXNrLm91dGNvbWUgPyBgIOKAlCAke3IudGFzay5vdXRjb21lfWAgOiBcIlwifWAsIHtcbiAgICAgICAgICAgIGZhY3Q6IFwidGFzay5kb25lXCIsXG4gICAgICAgICAgICB0YXNrOiByLnRhc2suaWQsXG4gICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiByLnRhc2suaWQsIGFscmVhZHk6IHIuYWxyZWFkeSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkLCBib2R5OiBjbWQuYm9keSwgd2hvOiBcImFnZW50XCIgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCByZXdyb3RlIGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLmVkaXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVzb2x2ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc29sdmVOb3RlKHtcbiAgICAgICAgICBkb2M6IGNtZC5kb2MsXG4gICAgICAgICAgaWQ6IGNtZC5pZCxcbiAgICAgICAgICByZXNvbHZlZDogY21kLnJlc29sdmVkLFxuICAgICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50ICR7Y21kLnJlc29sdmVkID8gXCJyZXNvbHZlZFwiIDogXCJyZW9wZW5lZFwifSBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwibm90ZS5yZXNvbHZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQsIHJlc29sdmVkOiByLm5vdGUucmVzb2x2ZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCByZW1vdmVkIGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLnJlbW92ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkaWZmXCI6IHtcbiAgICAgICAgY29uc3QgcCA9IHNlc3Npb24uY29tcGFyZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jOiBwLmRvYyxcbiAgICAgICAgICBhY3RpdmU6IHAuYWN0aXZlLFxuICAgICAgICAgIGFnYWluc3Q6IHAuYWdhaW5zdCxcbiAgICAgICAgICBzYW1lOiBwLmRpZmYuc2FtZSxcbiAgICAgICAgICBjb2Fyc2U6IHAuZGlmZi5jb2Fyc2UsXG4gICAgICAgICAgaHVua3M6IHAuZGlmZi5odW5rcyxcbiAgICAgICAgICB1bmlmaWVkOiB1bmlmaWVkKHAuZGlmZiwge1xuICAgICAgICAgICAgZnJvbTogYHYke3AuYWN0aXZlfWAsXG4gICAgICAgICAgICB0bzogc2lkZU5hbWUocC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhwLmRvYykubmFtZSksXG4gICAgICAgICAgICAuLi4oY21kLmNvbnRleHQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBjb250ZXh0OiBjbWQuY29udGV4dCB9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXJnZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm1lcmdlKHsgZG9jOiBjbWQuZG9jLCBhZ2FpbnN0OiBjbWQuYWdhaW5zdCwgaHVua3M6IGNtZC5odW5rcyB9KTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCB0b29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKGNtZC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1lcmdlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBodW5rczogY21kLmh1bmtzLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIGFwcGxpZWQ6IHIuYXBwbGllZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZpbmRcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZmluZChjbWQuZmlsdGVyKTtcbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGFkZGVkID0gYWRkUGF0aHMoY21kLnBhdGhzKTtcbiAgICAgICAgcmV0dXJuIHsgZW50cmllczogYWRkZWQubWFwKChhKSA9PiAoeyAuLi5hLmVudHJ5LCBhZGRlZDogYS5hZGRlZCB9KSkgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggNzogdGhlIGFnZW50IG1heSBuYW1lIGEgZG9jIHRoZSBodW1hbiBoYXMgbm90XG4gICAgICAgIC8vIG9wZW5lZCwgYnkgQUJTT0xVVEUgcGF0aCAodGhlIENMSSByZXNvbHZlcyBpdCBhZ2FpbnN0IGl0cyBvd24gY3dkKTtcbiAgICAgICAgLy8gaXQgaXMgb3BlbmVkIGltcGxpY2l0bHkgdW5kZXIgdGhlIHNhbWUgYWRtaXNzaW9uIHJ1bGUgYXMgdGhlXG4gICAgICAgIC8vIHN1cmZhY2UncyBgb3BlbmAg4oCUIGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5IOKAlCB3aXRob3V0XG4gICAgICAgIC8vIG1vdmluZyB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgICAgICBpZiAoY21kLmRvYyAmJiBpc0Fic29sdXRlKGNtZC5kb2MpICYmICFzZXNzaW9uLmZpbmREb2MoY21kLmRvYykpIHtcbiAgICAgICAgICBjb25zdCBvID0gc2Vzc2lvbi5vcGVuUGF0aChjbWQuZG9jLCB7IGZvY3VzOiBmYWxzZSB9KTtcbiAgICAgICAgICBpZiAoby5jcmVhdGVkKVxuICAgICAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgICAgICB0eXBlOiBcImRvYy5vcGVuZWRcIixcbiAgICAgICAgICAgICAgZG9jOiBvLnNsdWcsXG4gICAgICAgICAgICAgIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChvLnNsdWcpLFxuICAgICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGZyb206IGNtZC5mcm9tLFxuICAgICAgICAgIGxhYmVsOiBjbWQubGFiZWwsXG4gICAgICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgY3JlYXRlZCB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHtjbWQubGFiZWwgPyBgIOKAlCAke2NtZC5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4sIGZyb206IHIudmVyc2lvbi5mcm9tLCBwYXRoOiByLnZlcnNpb24ucGF0aCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJhZ2VudFwiLCBjbWQudGV4dCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IGlkOiBtLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgcmV0dXJuIGFjdGl2YXRlKGNtZC5kb2MsIGNtZC52ZXJzaW9uLCBcImFnZW50XCIpO1xuICAgICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICAgIHJldHVybiB7fTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgJHtKU09OLnN0cmluZ2lmeSgoY21kIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICAgW1xuICAgICAgICAgICAgXCJjb250ZXh0LmFkZFwiLFxuICAgICAgICAgICAgXCJ2ZXJzaW9uLm5ld1wiLFxuICAgICAgICAgICAgXCJzYXlcIixcbiAgICAgICAgICAgIFwiYWN0aXZhdGVcIixcbiAgICAgICAgICAgIFwiY2xvc2VcIixcbiAgICAgICAgICAgIFwibWV0YVwiLFxuICAgICAgICAgICAgXCJmaW5kXCIsXG4gICAgICAgICAgICBcImdyYXBoXCIsXG4gICAgICAgICAgICBcImJhY2tsaW5rc1wiLFxuICAgICAgICAgICAgXCJtZXRhLmluaXRcIixcbiAgICAgICAgICAgIFwibWV0YS5zZXRcIixcbiAgICAgICAgICAgIC4uLlNUUlVDVFVSRV9PUFMsXG4gICAgICAgICAgXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IGUubWVzc2FnZSxcbiAgICAgICAgICAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgICAgICAuLi4oZS5oaW50ID8geyBoaW50OiBlLmhpbnQgfSA6IHt9KSxcbiAgICAgICAgfSxcbiAgICAgICAgeyBzdGF0dXM6IGUuc3RhdHVzIH0sXG4gICAgICApO1xuICAgIGlmIChlIGluc3RhbmNlb2YgUGF0aEVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlKSB9LCB7IHN0YXR1czogNTAwIH0pO1xuICB9O1xuXG4gIGNvbnN0IGV2ZW50c1Jlc3BvbnNlID0gKHJlcTogUmVxdWVzdCwgdXJsOiBVUkwpOiBSZXNwb25zZSA9PiB7XG4gICAgdG91Y2goKTtcbiAgICByZXR1cm4gc3NlUmVzcG9uc2Uoe1xuICAgICAgbG9nLFxuICAgICAgc2luY2U6IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApLFxuICAgICAgaGVhcnRiZWF0TXM6IFNTRV9IRUFSVEJFQVRfTVMsXG4gICAgICBjbGllbnRzOiBzc2VDbGllbnRzLFxuICAgICAgc2lnbmFsOiByZXEuc2lnbmFsLFxuICAgICAgb25PcGVuOiB0b3VjaCxcbiAgICAgIG9uQ2xvc2U6IHRvdWNoLFxuICAgIH0pO1xuICB9O1xuXG4gIC8vIC0tLSBzZXJ2ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNlcnZlciA9IEJ1bi5zZXJ2ZSh7XG4gICAgcG9ydDogb3B0cy5wb3J0ID8/IDAsXG4gICAgaG9zdG5hbWU6IFwiMTI3LjAuMC4xXCIsXG4gICAgcm91dGVzLFxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDFhLCBOT1cgVEhFIEtJVCdTIEFORCBOT1cgUk9TVEVSLVdJREUuIFRoaXMgd2FzIHRoZVxuICAgICAgLy8gZmlyc3QgY29weSBhbmQgaXQgbGlzdGVkIHBhdGhzIChgL3dzYCwgYC9jbWRgLCBgL2ZzL2ApIOKAlCBhIGxpc3QgdGhhdFxuICAgICAgLy8gd2FzIGFscmVhZHkgbWlzc2luZyBgL3N0YXRlYCwgd2hpY2ggYW5zd2VycyBhIHNlc3Npb24ncyB3aG9sZSBjb250ZW50cy5cbiAgICAgIC8vIGBzcmMva2l0L3dpcmUvb3JpZ2luLnRzYCByZWZ1c2VzIG9uIHRoZSBSRVFVRVNUIGluc3RlYWQsIHNvIG5vIHBhdGhcbiAgICAgIC8vIGludmVudG9yeSBjYW4gZ28gc3RhbGUsIGFuZCBgZ3JpbW9pcmUvb3JpZ2luLWd1YXJkLXdhcmQudGVzdC50c2AgaG9sZHNcbiAgICAgIC8vIHRoZSBvdGhlciBlaWdodCBkYWVtb25zIHRvIHRoZSBzYW1lIGxpbmUuXG4gICAgICB7XG4gICAgICAgIGNvbnN0IHJlZnVzZWQgPSByZWZ1c2VGb3JlaWduT3JpZ2luKHJlcSwgc3J2LnBvcnQpO1xuICAgICAgICBpZiAocmVmdXNlZCkgcmV0dXJuIHJlZnVzZWQ7XG4gICAgICB9XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSB2aWV3U3RhdGUoKTtcbiAgICAgICAgY29uc3QgZnVsbCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZnVsbFwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAuLi5zdGF0ZSxcbiAgICAgICAgICBjaGF0OiBmdWxsID8gc3RhdGUuY2hhdCA6IHN0YXRlLmNoYXQuc2xpY2UoLTEwKSxcbiAgICAgICAgICBjaGF0VG90YWw6IHN0YXRlLmNoYXQubGVuZ3RoLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2YoKSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgICBlcG9jaDogbG9nLmVwb2NoLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2V2ZW50c1wiKSByZXR1cm4gZXZlbnRzUmVzcG9uc2UocmVxLCB1cmwpO1xuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvdmVyc2lvblwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVhZFZlcnNpb24oXG4gICAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmdldChcImRvY1wiKSA/PyBcIlwiLFxuICAgICAgICAgICAgTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwidlwiKSA/PyBcIlwiLCAxMCksXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihyKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJldHVybiByZWZ1c2FsKGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9mcy9saXN0XCIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgICBlbnRyaWVzOiBsaXN0RGlyKGV4cGFuZEhvbWUodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJwYXRoXCIpID8/IFwiflwiKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSkgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL2NtZFwiKVxuICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgLmpzb24oKVxuICAgICAgICAgIC50aGVuKChiKSA9PiB7XG4gICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgLi4uaGFuZGxlQWdlbnRDbWQoYiBhcyBBZ2VudENtZCkgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIHJldHVybiByZWZ1c2FsKGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKCgpID0+IFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBcImJhZCBqc29uXCIgfSwgeyBzdGF0dXM6IDQwMCB9KSk7XG4gICAgICBpZiAobW9kZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgIGlmIChhc3NldCkgcmV0dXJuIGFzc2V0O1xuICAgICAgfVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBlcnJvcjogXCJub3QgZm91bmRcIiB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIH0sXG4gICAgd2Vic29ja2V0OiB7XG4gICAgICBvcGVuKHdzKSB7XG4gICAgICAgIHNvY2tldHMuYWRkKHdzKTtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pKTtcbiAgICAgIH0sXG4gICAgICBtZXNzYWdlKHdzLCByYXcpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgbGV0IG1zZzogQ2xpZW50TXNnO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG1zZyA9IEpTT04ucGFyc2UoXG4gICAgICAgICAgICB0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdyksXG4gICAgICAgICAgKSBhcyBDbGllbnRNc2c7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IGJhZCBqc29uIGZyb20gYnJvd3NlcjogJHtlfVxcbmApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyh3cywgbXNnKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIEEgcmVmdXNhbCB0aGUgaHVtYW4gY2F1c2VkIChlZGl0IGEgbm9uLWFjdGl2ZSB2ZXJzaW9uLCBvcGVuIGFcbiAgICAgICAgICAvLyB2YW5pc2hlZCBmaWxlKSByZWFjaGVzIFRIRU0sIGFzIGEgY2hhdC12aXNpYmxlIHN5c3RlbSBsaW5lIHdvdWxkIGJlXG4gICAgICAgICAgLy8gdG9vIGxvdWQgZm9yIGEga2V5c3Ryb2tlIOKAlCBzbyBpdCBpcyBhbiBlcnJvciBmcmFtZSB0aGUgc3VyZmFjZSBzaG93cy5cbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgYm91bmRQb3J0ID0gc2VydmVyLnBvcnQ7XG4gIC8vIC0tLSBkaXNjb3ZlcnkgKEUxMzogc2Vzc2lvbi1KU09OLCB0aGUgb25seSBjb252ZW50aW9uIHRoYXQgY2FuIGV4cHJlc3Mgc2V2ZXJhbCkgLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgc2NyaXB0b3JpdW0tJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgY29uc3QgbGF0ZXN0RmlsZSA9IGpvaW4odG1wZGlyKCksIFwic2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25cIik7XG4gIGNvbnN0IGluZm8gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2JvdW5kUG9ydH1gLFxuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgaG9tZSxcbiAgICBkaXI6IHNlc3Npb24uZGlyLFxuICAgIG1vZGUsXG4gIH0pO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZUF0b21pYyhzZXNzaW9uRmlsZSwgaW5mbyk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGxhdGVzdEZpbGUsIGluZm8pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBkaXNjb3ZlcnkgaXMgYmVzdC1lZmZvcnQgKi9cbiAgfVxuXG4gIHN5bmNXYXRjaGVycygpO1xuICAvLyDimqAgVEhFIFNFU1NJT04gU0FZUyBXSEFUIElUUyBPV04gVElNRU9VVCBJUy4gYC0tdGltZW91dCAwYCBoYXMgYWx3YXlzIG1lYW50XG4gIC8vIFwic3RhbmQgdW50aWwgY2xvc2VkXCIgYW5kIHRoZXJlIHdhcyBubyB3YXkgdG8gY29uZmlybSBmcm9tIG91dHNpZGUgdGhhdCBhXG4gIC8vIGRhZW1vbiBoYWQgdGFrZW4gaXQg4oCUIHdoaWNoIGlzIHRoZSBraW5kIG9mIHNldHRpbmcgeW91IGZpbmQgb3V0IGFib3V0IGJ5XG4gIC8vIGxvc2luZyBhIHNlc3Npb24gYXQgdGhlIHdyb25nIG1vbWVudC5cbiAgbG9nLmVtaXQoe1xuICAgIHR5cGU6IFwicmVhZHlcIixcbiAgICBtb2RlLFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICByZXN0b3JlZDogISFvcHRzLnJlc3RvcmUsXG4gICAgaWRsZV90aW1lb3V0X3M6IG9wdHMudGltZW91dFMgPz8gMTgwMCxcbiAgfSk7XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCAyOiB3aGF0IGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLlxuICBmb3IgKGNvbnN0IGYgb2Ygc2Vzc2lvbi5yZXN0b3JlRmluZGluZ3MpXG4gICAgYW5ub3VuY2UoXG4gICAgICBmLm1pc3NpbmdcbiAgICAgICAgPyBgJHtmLm9yaWdpbmFsfSBpcyBnb25lIGZyb20gZGlzayBzaW5jZSB0aGlzIHNlc3Npb24gd2FzIGxhc3Qgb3Blbi4gU2F2ZSB3b3VsZCByZWNyZWF0ZSBpdDsgUmV2ZXJ0IGNhbm5vdCBydW4uYFxuICAgICAgICA6IGAke2Yub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIGNsb3NlZC4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggdGhlIGFjdGl2ZSB2ZXJzaW9uOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBmLmRvYywgd2hpbGVDbG9zZWQ6IHRydWUgfSxcbiAgICApO1xuXG4gIC8vIEU2Mjogb25lIGxpbmUgd2hlbiB0aGUgc2Vzc2lvbiBoYXMgc29tZXRoaW5nIHdvcnRoIGxvb2tpbmcgYXQsIGFuZCBzaWxlbmNlXG4gIC8vIHdoZW4gaXQgZG9lcyBub3QuXG4gIC8vXG4gIC8vIOKblCBBIFNVTU1BUlksIE5PVCBBIFJFUEVBVC4gVGhlIHBlci1kb2N1bWVudCBjb25mbGljdHMgYWJvdmUgc2F5IHRoZWlyIG93blxuICAvLyBwaWVjZSB3aXRoIHRoZSBTYXZlL1JldmVydCBudWFuY2U7IHRoaXMgY291bnRzIHdoYXQgaXMgdGhlcmUg4oCUIGluY2x1ZGluZ1xuICAvLyB0aGUgdGhpbmdzIHRob3NlIGxpbmVzIG5ldmVyIGNvdmVyZWQsIGxpa2UgYSBjb250ZXh0IGVudHJ5IHBvaW50aW5nIGF0XG4gIC8vIG5vdGhpbmcg4oCUIGFuZCBwb2ludHMgYXQgdGhlIHZlcmIuIEEgc3RhcnR1cCBjaGVjayB0aGF0IHJlc3RhdGVzIHdoYXQgd2FzXG4gIC8vIGp1c3Qgc2FpZCwgb3IgdGhhdCBhbm5vdW5jZXMgaXRzZWxmIHdoZW4gZXZlcnl0aGluZyBpcyBmaW5lLCBpcyBhIGxpbmVcbiAgLy8gcGVvcGxlIGxlYXJuIHRvIHNraXAuXG4gIHtcbiAgICBjb25zdCBsaXN0ID0gc2Vzc2lvbi5jaGVja3VwKCk7XG4gICAgY29uc3QgbGluZSA9IHN1bW1hcnkobGlzdCk7XG4gICAgaWYgKGxpbmUpIHtcbiAgICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogXCJkb2N0b3JcIiwgZmluZGluZ3M6IGxpc3QubGVuZ3RoIH0pO1xuICAgICAgLy8gVGhlIGFnZW50IGdldHMgdGhlIHdob2xlIHJlcG9ydCBvbiBpdHMgdGFpbCwgc28gYW4gYWdlbnQgdGhhdCBhcnJpdmVzXG4gICAgICAvLyBsYXRlciBkb2VzIG5vdCBoYXZlIHRvIGFzayDigJQgYW5kIGRvZXMgbm90IGhhdmUgdG8gcGFyc2UgdGhlIHNlbnRlbmNlLlxuICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvY3RvclwiLCBjb3VudDogbGlzdC5sZW5ndGgsIGZpbmRpbmdzOiBsaXN0IH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBFNTMncyBhdHRlbnRpb24gdGljay4gU2VwYXJhdGUgZnJvbSBob3VzZWtlZXBpbmcgYmVjYXVzZSBpdCBpcyBhYm91dCB0aGVcbiAgICogSFVNQU4ncyBwYXRpZW5jZSByYXRoZXIgdGhhbiB0aGUgZGFlbW9uJ3MgbGlmZXRpbWUsIGFuZCBiZWNhdXNlIGl0IG11c3QgcnVuXG4gICAqIG9uIGEgc2xvd2VyIGNsb2NrOiBhIDI1MCBtcyBzd2VlcCByZS1icm9hZGNhc3Rpbmcgc3RhdGUgd291bGQgYmUgY2h1cm4gZm9yIGFcbiAgICogdmFsdWUgdGhhdCBjaGFuZ2VzIHR3aWNlIGluIGEgd2FpdC5cbiAgICovXG4gIGxldCBsYXN0V2FpdGluZzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IGF0dGVudGlvblRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3QgdyA9IHdhaXRpbmdPbihzZXNzaW9uLm1lc3NhZ2VzKCksIG5vdywgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICAvLyBFNjU6IGEgbm90ZSBmbGlwcGluZyB0byBzdGFsbGVkIGlzIGEgY2hhbmdlIHRoZSBzdXJmYWNlIG11c3Qgc2VlIHRvby5cbiAgICAvLyDimqAgTk9UIGEgbnVkZ2U6IHNlZSBFNjUgaW4gdGhlIGRlY2lzaW9uIGxvZyDigJQgdGhlIG5vdGUncyBhY3QgaXMgdGhlXG4gICAgLy8gaHVtYW4ncywgYW5kIHRoZSBldmVudCB0aGF0IGRlbGl2ZXJlZCBpdCBhbHJlYWR5IGNhcnJpZWQgaXQuXG4gICAgY29uc3Qgbm90ZXMgPSBub3Rlc1dhaXRpbmcoc2Vzc2lvbi5ub3RlRmFjdHMoKSwgc2Vzc2lvbi5tZXNzYWdlcygpLCBub3csIHtcbiAgICAgIGFja25vd2xlZGdlZFVudGlsLFxuICAgIH0pO1xuICAgIGNvbnN0IGtleSA9IGF0dGVudGlvbktleSh3LCBub3Rlcyk7XG4gICAgaWYgKGtleSA9PT0gbGFzdFdhaXRpbmcpIHJldHVybjtcbiAgICBsYXN0V2FpdGluZyA9IGtleTtcbiAgICAvLyBUaGUgYmFkZ2UgY2hhbmdlZCwgc28gdGhlIHN1cmZhY2UgbmVlZHMgdGhlIG5ldyBzbmFwc2hvdC5cbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIGlmICghdykgcmV0dXJuO1xuICAgIGlmICh3LmJhZGdlICE9PSBcInN0YWxsZWRcIiB8fCBudWRnZWQuaGFzKHcubWVzc2FnZUlkKSkgcmV0dXJuO1xuICAgIG51ZGdlZC5hZGQody5tZXNzYWdlSWQpO1xuICAgIC8vIOKblCBUSEUgTlVER0UgR09FUyBUTyBUSEUgQUdFTlQnUyBUQUlMIEFORCBOT1dIRVJFIEVMU0UuIFRoZSBodW1hbiBhbHJlYWR5XG4gICAgLy8gc2VlcyB0aGUgYmFkZ2U7IHB1dHRpbmcgdGhpcyBpbiB0aGUgY2hhdCBhcyB3ZWxsIHdvdWxkIGJlIHRlbGxpbmcgdGhlbVxuICAgIC8vIHdoYXQgdGhleSBhcmUgbG9va2luZyBhdC4gSXQgY2FycmllcyB0aGUgbWVzc2FnZSBURVhUIGJlY2F1c2UgYW4gYWdlbnRcbiAgICAvLyB0aGF0IGhhcyBiZWVuIGF3YXkgbmVlZHMgdG8ga25vdyB3aGF0IGlzIHBlbmRpbmcsIG5vdCBqdXN0IHRoYXQgc29tZXRoaW5nXG4gICAgLy8gaXMg4oCUIGFuZCBpdCBuYW1lcyB0aGUgdHdvIHdheXMgb3V0LCBiZWNhdXNlIGEgbnVkZ2UgdGhhdCBkb2VzIG5vdCBzYXkgaG93XG4gICAgLy8gdG8gYW5zd2VyIGl0IGludml0ZXMgYSBmb3VydGggcHJpbWl0aXZlLlxuICAgIGNvbnN0IHBlbmRpbmcgPSBzZXNzaW9uLm1lc3NhZ2VzKCkuZmluZCgobSkgPT4gbS5pZCA9PT0gdy5tZXNzYWdlSWQpO1xuICAgIGxvZy5lbWl0KHtcbiAgICAgIHR5cGU6IFwid2FpdGluZ1wiLFxuICAgICAgbWVzc2FnZV9pZDogdy5tZXNzYWdlSWQsXG4gICAgICBzZWNvbmRzOiBNYXRoLnJvdW5kKChEYXRlLm5vdygpIC0gdy5zaW5jZSkgLyAxMDAwKSxcbiAgICAgIC4uLihwZW5kaW5nID8geyB0ZXh0OiBwZW5kaW5nLnRleHQgfSA6IHt9KSxcbiAgICAgIGhpbnQ6IFwicmVwbHkgd2l0aCBgc2F5YCwgb3IgYHdvcmtpbmdgIHRvIHNheSB5b3UgYXJlIHN0aWxsIG9uIGl0XCIsXG4gICAgfSk7XG4gIH0sIDEwMDApO1xuXG4gIGNvbnN0IHN0b3BIb3VzZWtlZXBpbmcgPSBzdGFydEhvdXNla2VlcGluZyh7XG4gICAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUsXG4gICAgaWRsZU1zOiAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSxcbiAgICB0b3VjaCxcbiAgICB0aW1lb3V0TXM6IChvcHRzLnRpbWVvdXRTID8/IDE4MDApICogMTAwMCxcbiAgICBvbklkbGVDbG9zZTogKCkgPT4gcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSksXG4gIH0pO1xuXG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgbGV0IHJlc29sdmVTaHV0ZG93biE6ICgpID0+IHZvaWQ7XG4gIGNvbnN0IHNodXRkb3duID0gbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHtcbiAgICByZXNvbHZlU2h1dGRvd24gPSByO1xuICB9KTtcblxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvLyBUaGUgb3JkZXIgaXMgdGhlIGhlYWRlcidzLCBhbmQgdGhlIGhlYWRlciBzYXlzIHdoeS5cbiAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgc3RvcEhvdXNla2VlcGluZygpO1xuICAgIGNsZWFySW50ZXJ2YWwoYXR0ZW50aW9uVGltZXIpO1xuICAgIGZvciAoY29uc3QgdyBvZiB3YXRjaGVycy52YWx1ZXMoKSkgdy5jbG9zZSgpO1xuICAgIHdhdGNoZXJzLmNsZWFyKCk7XG4gICAgZm9yIChjb25zdCB0IG9mIHBlbmRpbmcudmFsdWVzKCkpIGNsZWFyVGltZW91dCh0KTtcbiAgICB0cnkge1xuICAgICAgc2Vzc2lvbi5wZXJzaXN0KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBkaXI6IHNlc3Npb24uZGlyLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLyoqXG4gKiBBIHBhdGggdHlwZWQgaW4gdGhlIFNVUkZBQ0UuIFRoZSBwYWdlIGhhcyBubyB3b3JraW5nIGRpcmVjdG9yeSwgc28gYSBwYXRoXG4gKiBmcm9tIGl0IG11c3QgYmUgYWJzb2x1dGUgb3Igc3RhcnQgYXQgYH5gIOKAlCB3aGljaCBpcyBleHBhbmRlZCBIRVJFLiBCZWZvcmVcbiAqIHRoaXMsIGB+L0RvY3VtZW50c2AgcmVhY2hlZCBgcmVzb2x2ZSgpYCBhbmQgd2FzIHRha2VuIGFzIHJlbGF0aXZlIHRvIHRoZVxuICogZGFlbW9uJ3MgY3dkICh0aGUgc2tpbGwgZm9sZGVyKTogdGhlIHBhdGggYm94IGNvbXBsZXRlZCBgfi/igKZgIChsaXN0aW5nXG4gKiBleHBhbmRzIGl0KSBhbmQgdGhlbiBFbnRlciBmYWlsZWQgd2l0aCBcIm5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6XG4gKiDigKYvc2tpbGxzL3NjcmlwdG9yaXVtL34vRG9jdW1lbnRzL+KAplwiIChDb2xlLCAyMDI2LTA5LTExKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cmZhY2VQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSBwLnRyaW0oKTtcbiAgaWYgKHQgPT09IFwiflwiIHx8IHQuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gZXhwYW5kSG9tZSh0KTtcbiAgaWYgKCFpc0Fic29sdXRlKHQpKVxuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYFwiJHtwfVwiIGlzIG5vdCBhIGZ1bGwgcGF0aCDigJQgc3RhcnQgaXQgd2l0aCAvIG9yIH4vYCwgNDAwKTtcbiAgcmV0dXJuIHJlc29sdmUodCk7XG59XG5cbi8qKiBBIHN0cnVjdHVyZSBvcCBmcm9tIHRoZSBzdXJmYWNlLCB3aXRoIGV2ZXJ5IHBhdGggZmllbGQgdGhyb3VnaCBgc3VyZmFjZVBhdGhgLiAqL1xuZnVuY3Rpb24gYW5jaG9yU3VyZmFjZVBhdGhzKG9wOiBTdHJ1Y3R1cmVPcCk6IFN0cnVjdHVyZU9wIHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4ub3AgfTtcbiAgZm9yIChjb25zdCBrIG9mIFtcImRpclwiLCBcInBhdGhcIiwgXCJpbnRvXCJdIGFzIGNvbnN0KVxuICAgIGlmICh0eXBlb2Ygb3V0W2tdID09PSBcInN0cmluZ1wiKSBvdXRba10gPSBzdXJmYWNlUGF0aChvdXRba10gYXMgc3RyaW5nKTtcbiAgcmV0dXJuIG91dCBhcyBTdHJ1Y3R1cmVPcDtcbn1cblxuZnVuY3Rpb24gZXhwYW5kSG9tZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAocCA9PT0gXCJ+XCIpIHJldHVybiBob21lZGlyKCk7XG4gIGlmIChwLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCBwLnNsaWNlKDIpKTtcbiAgcmV0dXJuIHJlc29sdmUocCk7XG59XG5cbi8qKiBUaGUgZGFlbW9uJ3MgcHJpdmF0ZSBhcmd2IOKAlCB0aGUgQ0xJIHNwYXducyBpdCB3aXRoIGV4YWN0bHkgdGhlc2UuICovXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgbG9nOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgd29ya3NwYWNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgd2FpdCBmb3IgdGhlIGVuZC4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYHNjcmlwdG9yaXVtOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG4gIHJlY29nbml6ZWQgZmxhZ3M6ICR7T2JqZWN0LmtleXMoXG4gICAgICAgIERBRU1PTl9PUFRJT05TLFxuICAgICAgKVxuICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBsZXQgZDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBzdGFydERhZW1vbj4+O1xuICB0cnkge1xuICAgIGQgPSBhd2FpdCBzdGFydERhZW1vbih7XG4gICAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICAgIHJlc3RvcmU6IGZsYWdzLnJlc3RvcmUsXG4gICAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICAgIHdvcmtzcGFjZTogZmxhZ3Mud29ya3NwYWNlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gVGhlIGhhbmRzaGFrZSBsaW5lIGlzIEpTT04gZWl0aGVyIHdheSwgc28gdGhlIENMSSByZWFkcyBPTkUgc2hhcGUuXG4gICAgY29uc3Qgc3RhdHVzID0gZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvciA/IGUuc3RhdHVzIDogNTAwO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIHN0YXR1cywgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIHN0YXR1cyA9PT0gNDA0ID8gNSA6IHN0YXR1cyA9PT0gNDA5ID8gNiA6IDE7XG4gIH1cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSwgZGlyOiBkLmRpciB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIGF3YWl0IGQuc2h1dGRvd247XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiBhIGNsZWFuIGNsb3NlIGxlYXZlcyBubyBlbXB0eSBsb2cgYmVoaW5kLlxuICBpZiAocmVzLmNvZGUgPT09IDAgJiYgZmxhZ3MubG9nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChzdGF0U3luYyhmbGFncy5sb2cpLnNpemUgPT09IDApIHVubGlua1N5bmMoZmxhZ3MubG9nKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSLiBgaW1wb3J0Lm1ldGEubWFpbmAgaXMgRkFMU0UgaW4gdGhlXG4gKiBidW5kbGUsIHNvIHRoZXJlIGlzIG5vIHN1Y2ggYmxvY2sgaGVyZSwgYW5kIHRoaXMgdGFrZXMgbm8gYXJndW1lbnRzOiB0aGVcbiAqIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHR3byBwcmltaXRpdmVzIHVuZGVyIEJPVEggb2YgdGhlIGhvdXNlJ3MgZGFlbW9uLWRpc2NvdmVyeSBjb252ZW50aW9ucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIEQzIHJ1bGVkIHRoYXQgdGhlIGNvbnZlbnRpb25zIHRoZW1zZWx2ZXMg4oCUIHBlci1zZXNzaW9uIHRtcGRpciBKU09OIChib3VudHksXG4gKiBnbGFtb3VyLCBpbWFnbywgbWFncGllKSBhbmQgc2luZ2xldG9uIGAkSE9NRS9kYWVtb24ucG9ydGAgKyBgZGFlbW9uLnBpZGBcbiAqIChhc3Ryb2xhYmUsIGdyYXBldmluZSwgbWluZC1tYXBwZXIpIOKAlCBib3RoIHN1cnZpdmUsIGJlY2F1c2UgdGhleSBlbmNvZGVcbiAqIGdlbnVpbmVseSBkaWZmZXJlbnQgbW9kZWxzIChjb25jdXJyZW50IHNlc3Npb25zIHZzIGEgc3RhbmRpbmcgc2luZ2xldG9uKSBhbmRcbiAqIHBpY2tpbmcgb25lIGlzIGEgcHJvZHVjdCBkZWNpc2lvbiwgbm90IGEgZmFjdG9yaW5nIG9uZS4gV2hhdCBJUyBvbmVcbiAqIGltcGxlbWVudGF0aW9uIGlzIHRoZSBwYWlyIGJlbG93LCB3aGljaCBpcyBhbHNvIGV4YWN0bHkgd2hlcmUgY2Vuc3VzIGRlZmVjdFxuICogKipMMyoqIGxpdmVzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuLyoqXG4gKiBXcml0ZSBgdGV4dGAgdG8gYHRhcmdldGAgYXRvbWljYWxseTogd3JpdGUgYmVzaWRlIGl0LCB0aGVuIHJlbmFtZS5cbiAqXG4gKiDim5QgKipMMywgQ0xPU0VEIEJZIENPTlNUUlVDVElPTi4qKiBBIGJhcmUgYHdyaXRlRmlsZVN5bmNgIGlzIG5vdCBhdG9taWMsIHNvIGFcbiAqIENMSSByZWFkaW5nIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgSEFMRi1XUklUVEVOIHBvaW50ZXIuIFVuZGVyXG4gKiBhIGJlc3QtZWZmb3J0IHJlYWRlciB0aGF0IHN1cmZhY2VkIGFzIFwibm8gcnVubmluZyBzZXNzaW9uXCIg4oCUIGFic2VuY2UgcmVwb3J0ZWRcbiAqIGZvciB3aGF0IHdhcyByZWFsbHkgYSB0b3JuIHJlYWQsIHdoaWNoIGlzIHRoZSBleGFjdCBjb25mbGF0aW9uIHRoZSBob3VzZSdzXG4gKiBgbnVsbGAtbm90LWAwYCBydWxlIGV4aXN0cyB0byBwcmV2ZW50LiBSZW5hbWUgd2l0aGluIG9uZSBkaXJlY3RvcnkgaXMgYXRvbWljLFxuICogc28gYSByZWFkZXIgc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbFxuICogZmlsZS5cbiAqXG4gKiBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDcsIGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIHRoZSBuZXh0IGRheSBieVxuICogdGhlIGR1cGxpY2F0aW9uIHJlY29uLCBhbmQgcmVwYWlyZWQgaW4gYWxsIG9mIHRoZW0gdGhlIG9ubHkgd2F5IHRoYXQgZG9lcyBub3RcbiAqIG5lZWQgZmluZGluZyBhZ2FpbjogdGhlcmUgaXMgbm93IG9uZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiDimqAgVGhlIHRlbXAgbmFtZSBjYXJyaWVzIHRoZSBwaWQsIHNvIHR3byBkYWVtb25zIHJhY2luZyB0byBwdWJsaXNoIHRoZSBzYW1lXG4gKiBwb2ludGVyIGNhbm5vdCBjbG9iYmVyIGVhY2ggb3RoZXIncyBpbnRlcm1lZGlhdGUgZmlsZSDigJQgYW5kIGl0IGlzIHJlbW92ZWQgb25cbiAqIGEgZmFpbGVkIHdyaXRlIHJhdGhlciB0aGFuIGxlZnQgYXMgbGl0dGVyIGJlc2lkZSB0aGUgcmVhbCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUZpbGVBdG9taWModGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCB0bXAgPSBgJHt0YXJnZXR9LiR7cHJvY2Vzcy5waWR9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgIHJlbmFtZVN5bmModG1wLCB0YXJnZXQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHRtcCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgIH1cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGUgYHBhdGhgIGlmZiBpdCBzdGlsbCBuYW1lcyBVUy4gUmV0dXJucyB3aGV0aGVyIGl0IHdhcyBkZWxldGVkLlxuICpcbiAqIOKblCAqKlwiU1RJTEwgT1VSU1wiIElTIFRIRSBXSE9MRSBGVU5DVElPTi4qKiBBIGRhZW1vbiB0aGF0IHVubGlua3MgaXRzIGRpc2NvdmVyeVxuICogZmlsZSB1bmNvbmRpdGlvbmFsbHkgYXQgZXhpdCBkZWxldGVzIHRoZSBwb2ludGVyIGEgU1VDQ0VTU09SIGhhcyBhbHJlYWR5XG4gKiB3cml0dGVuIOKAlCB0aGUgc3VjY2Vzc29yIGNhbiB0aGVuIG5vIGxvbmdlciBiZSBmb3VuZCBhbmQgdGhlIG5leHQgQ0xJIHZlcmIgc3Bhd25zIGFcbiAqIHRoaXJkIGRhZW1vbi4gQm90aCBjb252ZW50aW9ucyBoYXZlIHRoaXMgaGF6YXJkIGFuZCBib3RoIGV4cHJlc3MgaXRcbiAqIGRpZmZlcmVudGx5OiBhc3Ryb2xhYmUgY29tcGFyZXMgdGhlIHBpZCBmaWxlJ3MgYnl0ZXMgdG8gaXRzIG93biBwaWQsXG4gKiBtYWdwaWUgcGFyc2VzIHRoZSBKU09OIHBvaW50ZXIgYW5kIGNvbXBhcmVzIGBzZXNzaW9uX2lkYC4gYGlkZW50aWZ5YCBpcyB3aGF0XG4gKiBtYWtlcyB0aG9zZSBvbmUgZnVuY3Rpb24g4oCUIGl0IHR1cm5zIHRoZSBmaWxlJ3MgYnl0ZXMgaW50byB0aGUgaWRlbnRpdHkgdG9cbiAqIGNvbXBhcmUsIGFuZCBpdCBkZWZhdWx0cyB0byB0aGUgdHJpbW1lZCBieXRlcyB0aGVtc2VsdmVzLlxuICpcbiAqIOKaoCBFdmVyeSBmYWlsdXJlIGlzIHN3YWxsb3dlZCBhbmQgcmVwb3J0ZWQgYXMgYGZhbHNlYDogdGhlIGZpbGUgYmVpbmcgZ29uZSxcbiAqIHVucmVhZGFibGUsIG9yIHVucGFyc2VhYmxlIGFsbCBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmUg4oCUIGl0IGlzIG5vdCBvdXJzIHRvXG4gKiByZW1vdmUuIEFuIHVucGFyc2VhYmxlIHBvaW50ZXIgaXMgZGVsaWJlcmF0ZWx5IE5PVCB0cmVhdGVkIGFzIG91cnMsIHdoaWNoIGlzXG4gKiB0aGUgY29uc2VydmF0aXZlIGhhbGYgb2YgdGhlIHNhbWUgYG51bGxgLW5vdC1gMGAgcnVsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubGlua0lmTWF0Y2hlcyhcbiAgcGF0aDogc3RyaW5nLFxuICBleHBlY3RlZDogc3RyaW5nLFxuICBpZGVudGlmeTogKHJhdzogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsID0gKHJhdykgPT4gcmF3LnRyaW0oKSxcbik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpZGVudGlmeShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSAhPT0gZXhwZWN0ZWQpIHJldHVybiBmYWxzZTtcbiAgICB1bmxpbmtTeW5jKHBhdGgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgaW4tcHJvY2VzcyBldmVudCBsb2cg4oCUIHRoZSBhcHBlbmQtb25seSwgcmVwbGF5YWJsZSBidWZmZXJcbiAqIGJlaGluZCBldmVyeSBzcGVsbCdzIGBHRVQgL2V2ZW50c2AgU1NFIHRhaWwuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXInc1xuICogYHNjcmlwdHMvZXZlbnRzLnRzYCDigJQgdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMiwgYW5kIHRoZSBvbmx5IG9uZSBvZlxuICogdGhlIHNpeCBjb3BpZWQtaW4tcGxhY2UgYnVzZXMgdGhhdCBpcyBhIG1vZHVsZSwgaXMgYm91bmRlZCwgY2FycmllcyBhbiBlcG9jaCwgYW5kIGlzXG4gKiB1bml0LXRlc3RlZC4gVGhlIGZpdmUgb3RoZXJzIGFyZSB0aGUgc2FtZSB0d2VudHkgbGluZXMgd3JpdHRlbiBmaXZlIHRpbWVzLlxuICpcbiAqIOKUgOKUgCBUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMg4oCUIFRXTyBCWSBDT05TVFJVQ1RJT04sIE9ORSBCWSBPUFQtSU4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICog4puUIFRIRSBIRUFESU5HIFVTRUQgVE8gU0FZIFwiVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTlwiIEFORFxuICogSVRFTSAyIElTIE5PVCBPTkUgT0YgVEhFTS4gQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gbWluZC1tYXBwZXIncyBwcmUtd29ya1xuICogKEQ3OSk6IGBlcG9jaGAgaXMgT1BUSU9OQUwgaGVyZSwgc28gTDYgaXMgY2xvc2VkIG9ubHkgZm9yIGEgY2FsbGVyIHRoYXQgYXNrcy5cbiAqIFRocmVlIGFkb3B0ZXJzIGhhdmUgc2luY2UgZGVjbGluZWQgdG8g4oCUIGltYWdvIChEMzkpLCBib3VudHkgKEQ0OCkgYW5kXG4gKiBncmFwZXZpbmUgKEQ3MCkg4oCUIHNvIHRoZSBkZWZlY3QgdGhlIGhlYWRpbmcgY2xhaW1lZCB0byBtYWtlIGltcG9zc2libGUgaXNcbiAqIGxpdmUgaW4gdGhlIHRyZWUsIGJ5IG9wdC1vdXQsIGFuZCB0aGUgb3ZlcmNsYWltIGlzIHdoYXQgaGlkIHRoYXQuIEl0ZW1zIDEgYW5kXG4gKiAzIEFSRSBieSBjb25zdHJ1Y3Rpb246IGEgY2FsbGVyIGNhbm5vdCBzd2l0Y2ggdGhlIGNhcCBvZmYgb3IgcmVhY2ggdGhlIGJ1ZmZlci5cbiAqXG4gKiDimqAgQU5EIE1JTkQtTUFQUEVSJ1MgT1dOIEJVUywgV0hJQ0ggVEhJUyBNT0RVTEUgQ09OVkVSR0VEIFRPV0FSRCwgVFlQRVMgVEhFXG4gKiBFUE9DSCBBUyBSRVFVSVJFRCBhbmQgc3RhbXBzIGl0IHVuY29uZGl0aW9uYWxseSDigJQgaXQgaXMgdGhlIHNwZWxsIGNlbnN1cyBMNlxuICogbmFtZXMgYXMgQ09SUkVDVC4gTWFraW5nIGl0IHJlcXVpcmVkIEhFUkUgaXMgbm90IHRoZSByZXBhaXI6IGl0IHdvdWxkIHJldmVyc2VcbiAqIEQzOSwgRDQ4IGFuZCBENzAuIFRoZSBob25lc3Qgc3RhdGVtZW50IGlzIHRoaXMgaGVhZGluZy5cbiAqXG4gKiDim5QgKipSRVNPTFZFRCBBVCBUSEFUIFNQRUxMJ1MgUE9SVCwgQU5EIFRIRSBESVNQT1NJVElPTiBJUyBSRUNPUkRFRCBIRVJFXG4gKiBCRUNBVVNFIEEgTE9TUyBUSEFUIExJVkVTIE9OTFkgSU4gQSBKT1VSTkFMIElTIEEgTE9TUyBOT0JPRFkgQ0FOIFNFRVxuICogKEQ3OS9EODUpLioqIG1pbmQtbWFwcGVyIGFkb3B0ZWQgdGhpcyBtb2R1bGUgaW4gUGhhc2UgNyBhbmQga2VwdCBpdHNcbiAqIGd1YXJhbnRlZSBXSVRIT1VUIEEgS0lUIENIQU5HRTogaXQgcGFzc2VzIGB7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH1gIGF0XG4gKiBpdHMgT05FIGNvbnN0cnVjdGlvbiBzaXRlIGFuZCByZS10aWdodGVucyBgZXBvY2hgIHRvIFJFUVVJUkVEIGluIGl0cyBvd25cbiAqIGxvY2FsIGZyYW1lIHR5cGUsIHNvIG5vdGhpbmcgaXRzIGJ1cyBlbWl0cyBjYW4gbGFjayBvbmUuIEtpdCBieXRlczogemVyby5cbiAqICoqU28gdGhlIGVwb2NoIGlzIGEgTE9TU1ktQ09QWSBwcm9wZXJ0eSB3aG9zZSBkaXNwb3NpdGlvbiBpcyBLRUVQLUxPQ0FMLCBub3RcbiAqIFJFU1RPUkUqKiDigJQgdGhlIG9ubHkgcHJvcGVydHkgb2YgdGhhdCBzcGVsbCdzIG93biBtb2R1bGUgdGhpcyBtb2R1bGUgY291bGRcbiAqIG5vdCBjYXJyeSBhbmQgZGlkIG5vdCBuZWVkIHRvLiBMNiBpcyBDTE9TRUQgZm9yIHRoZSB0d28gc3BlbGxzIHRoYXQgYXNrIGFuZFxuICogT1BFTiwgYnkgb3B0LW91dCwgZm9yIHRoZSB0aHJlZSB0aGF0IGRlY2xpbmU7IHRoYXQgYXN5bW1ldHJ5IGlzIHRoZSBob25lc3RcbiAqIHN0YXRlIGFuZCB0aGlzIGhlYWRpbmcgaXMgd2hlcmUgaXQgaXMgd3JpdHRlbi5cbiAqXG4gKiDimqAgKipBTkQgVEhFIEFET1BUSU9OIFJFTkFNRVMgQSBGSUVMRCBPTiBBTiBBRE9QVEVSJ1MgUFVCTElTSEVEIFdJUkUuKiogYGlkYFxuICogaXMgbmFtZWQgaW4gYEZyYW1lPFQ+YCBhbmQgaW4gdGhlIGVtaXQgbGl0ZXJhbCBiZWxvdywgc28gYSBzcGVsbCB3aG9zZSBidXNcbiAqIHNwZWxsZWQgdGhlIGN1cnNvciBhbnl0aGluZyBlbHNlIHBheXMgYSByZW5hbWUgYXQgZXZlcnkgcmVhZGVyIOKAlCBmb3JcbiAqIG1pbmQtbWFwcGVyLCAxNzMgb2NjdXJyZW5jZXMgYWNyb3NzIDUgc3VyZmFjZSBmaWxlcywgfjIwOSBhY3Jvc3MgfjMwIGJhY2tlbmRcbiAqIGZpbGVzLCBldmVyeSBKU09OTCBsaW5lIGl0cyBgdGFpbGAgd3JpdGVzIGludG8gYW4gYWdlbnQncyBwaXBlLCBhbmQgKHRoZSBvbmVcbiAqIG5vYm9keSBjb3VudGVkKSB0aGUgRklYVFVSRSBpbiBpdHMgb3duIGB0YWlsLnRlc3QudHNgLCB3aGljaCBXUklURVMgdGhlXG4gKiBlbnZlbG9wZSB3aGlsZSBzdGFuZGluZyBpbiBmb3IgdGhlIGRhZW1vbi4gVGhlIE5FU1RJTkcgaXMgbm90IGZvcmNlZCDigJRcbiAqIGBGcmFtZTxUPmAgaXMgZ2VuZXJpYywgYW5kIG1pbmQtbWFwcGVyIGtlcHQgYHtraW5kLCBwYXlsb2FkfWAgbmVzdGVkIHdoZXJlIGFsbFxuICogZml2ZSBlYXJsaWVyIGFkb3B0ZXJzIGZsYXR0ZW4gYnkgaWRpb20uICoqQW4gaWRpb20gZml2ZSBzaWJsaW5ncyBzaGFyZSBpc1xuICogaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGNvbnRyYWN0IHVudGlsIHlvdSBvcGVuIHRoZSB0eXBlKiogKEQ4MSwgRDg2KS5cbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgV0hFTiBUSEUgQ0FMTEVSIEFTS1MgRk9SIE9ORSAob3B0LWluLFxuICogbm90IGNvbnN0cnVjdGlvbiDigJQgc2VlIGFib3ZlKS4qKiBBZnRlciBhIHJlc3RhcnQgdGhlIGlkcyBzdGFydCBhZ2FpbiBhdCAxLCBzb1xuICogYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZSB3YXRlcm1hcmsgZnJvbSBhIGZyZXNoIG9uZSBieSBpZCBhbG9uZS5cbiAqXG4gKiAqKjMgwrcgQSBTVEFMRSBXQVRFUk1BUksgUkVQTEFZUyBGUk9NIFRIRSBCRUdJTk5JTkcsIGFuZCB0aGlzIGlzIHRoZSBoYWxmIHRoZVxuICogY2xpZW50IGNhbm5vdCBkby4qKiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IGEgdGFpbCB0aGF0IHJlc3VtZXMgYXRcbiAqIGBzaW5jZT08bGFzdCBpZCBvZiB0aGUgcHJldmlvdXMgZGFlbW9uPmAgYWdhaW5zdCBhIHJlc3RhcnRlZCBkYWVtb24gcmVjZWl2ZXNcbiAqIE5PVEhJTkcg4oCUIHRoZSBuZXcgZGFlbW9uJ3MgYHJlYWR5YCBpcyBpZCAxLCB3aGljaCBpcyBub3QgYD4gc2luY2VgLCBzbyB0aGVcbiAqIGZpbHRlciBkcm9wcyBpdCwgc28gbm8gZnJhbWUgYXJyaXZlcywgc28gdGhlIGNsaWVudCdzIGVwb2NoIGNoZWNrIG5ldmVyIHJ1bnNcbiAqIGFuZCB0aGUgdGFpbCBzaXRzIGNvbm5lY3RlZCBhbmQgc2lsZW50IHVudGlsIHRoZSBuZXcgZGFlbW9uIGhhcyBlbWl0dGVkIGFzXG4gKiBtYW55IGV2ZW50cyBhcyB0aGUgb2xkIG9uZSBkaWQuIFN0YW1waW5nIGFuIGVwb2NoIGFsb25lIGRvZXMgTk9UIGNsb3NlIHRoYXRcbiAqIGdhcDogdGhlIGVwb2NoIHJpZGVzIGEgZnJhbWUsIGFuZCB0aGUgYnVnIGlzIHRoYXQgbm8gZnJhbWUgaXMgc2VudC4gU29cbiAqIGBzdWJzY3JpYmVgIHRyZWF0cyBgc2luY2UgPiBjdXJzb3JgIGFzIFwidGhpcyBjdXJzb3IgaXMgZnJvbSBhbm90aGVyIHByb2Nlc3NcIlxuICogYW5kIHJlcGxheXMgd2hvbGUuIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS4gTm90XG4gKiBcIm5vIHN1YmplY3RcIiDigJQgZ3JhcGV2aW5lIEhBUyBhbiBldmVudCBidXMgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZVxuICogc3BlbGwg4oCUIGJ1dCB0aGUgdHdvIHNoYXBlcyBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIG9uZSBwcm9jZXNzLXdpZGUgYXJyYXkgY2FwcGVkIGF0IFJFUExBWV9CVUZGRVJfU0laRSwgd2l0aCBvbmVcbiAqICAgICAgICAgICAgICAgIG1vbm90b25pYyBgc2VxYCwgYW5kIHRoZSBoZWFkZXIgdGhyZWUgcGFyYWdyYXBocyB1cCBzYXlzIGluIGFzXG4gKiAgICAgICAgICAgICAgICBtYW55IHdvcmRzIHRoYXQgaXQgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqICAgICAgICAgICAgICAgIGRhZW1vbidzIGxpZmV0aW1lLCBOT1QgYSBkdXJhYmxlIGxvZy5cbiAqICAgZ3JhcGV2aW5lICAgIE4gZHVyYWJsZSBhcHBlbmQtb25seSBgLmpzb25sYCBmaWxlcywgb25lIHBlciBuYW1lZCBjaGFubmVsLFxuICogICAgICAgICAgICAgICAgZWFjaCB3aXRoIGl0cyBvd24gYG5leHRfaWRgLCByZXBsYXllZCBmcm9tIGRpc2sgYnlcbiAqICAgICAgICAgICAgICAgIGByZWFkQmFja2xvZ2AsIHN1cnZpdmluZyByZXN0YXJ0LCBgcm9sbGAsIGFyY2hpdmUgYW5kIGNsZWFyLlxuICpcbiAqICoqVGhlIHJlYWRlciB0aGF0IG1ha2VzIHRoZW0gaW5jb21wYXRpYmxlLCBhcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuXG4gKiBhc3NlcnRpb246KiogZ3JhcGV2aW5lJ3MgYGxvYWRDaGFubmVsKClgIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgSElHSC1XQVRFUlxuICogTUFSSyBvdmVyIGV2ZXJ5IHBhcnNlYWJsZSBsaW5lIG9mIHRoZSBjaGFubmVsJ3MgZmlsZSBvbiBib290LiBUaGVyZSBpcyBub1xuICogYXJyYXkgdG8gYmUgdGhhdCBtYXJrIG9mLCBhbmQgbm8gY2FwIHRoYXQgd291bGQgbm90IHNpbGVudGx5IGRpc2NhcmQgaGlzdG9yeVxuICogYSBjYWxsZXIgY2FuIHN0aWxsIGFzayBmb3IgYnkgaWQuIEl0IGlzIHRoZSB0aGluZyB0aGlzIG1vZHVsZSdzIG93biBoZWFkZXJcbiAqIHNheXMgaXQgaXMgZGVsaWJlcmF0ZWx5IG5vdC5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYSBwZXItY2hhbm5lbCBkdXJhYmxlXG4gKiBzdG9yZSB3b3VsZCBjaGFuZ2UgYGNyZWF0ZUV2ZW50TG9nYCdzIHN0b3JhZ2UgYW5kIGl0cyBgc3Vic2NyaWJlYCBjb250cmFjdCBmb3JcbiAqIGZpdmUgb3RoZXIgZGFlbW9ucywgcmUtZW1pdHRpbmcgU0lYIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhXG4gKiBkcml2ZSDigJQgcGFpZCBieSBwb3J0cyB0aGF0IGFyZSBhbHJlYWR5IGZpbmlzaGVkIGFuZCBieSBhZ2VudHMgbm90IGluIHRoZSByb29tLlxuICogQSB3aWRlbmluZyByZW1haW5zIGF2YWlsYWJsZSBhcyBpdHMgb3duIGFyZ3VlZCBkZWNpc2lvbiB3aXRoIGl0cyBvd25cbiAqIGJsYXN0LXJhZGl1cyBjb3VudDsgaXQgaXMgbmV2ZXIgYSBzdGVwIGluc2lkZSBhIHBvcnQuXG4gKlxuICog4pqgIEFORCBUSEUgYGVwb2NoYCBBQk9WRSBJUyBUSEUgU0hBUlBFU1QgSEFMRiBPRiBXSFkgKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmVcbiAqIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0LCBzbyB0aGUgY29uZGl0aW9uIHBhcmFncmFwaCAyIGRlc2NyaWJlcyDigJQgaWRzXG4gKiBzdGFydGluZyBhZ2FpbiBhdCAxIOKAlCBjYW5ub3Qgb2NjdXIgdGhlcmUsIGFuZCBzdGFtcGluZyBvbmUgYW55d2F5IGlzIG5vdFxuICogaW5lcnQ6IGB0YWlsRXZlbnRzYCdzIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIHRoZSBjdXJzb3IgdG8gMCwgYW5kIGdyYXBldmluZSdzXG4gKiB0YWlsIHJvdXRlIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGggdGhlIFdIT0xFIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuXG4gKiBhZ2VudCdzIHBpcGUsIG9uIGV2ZXJ5IGByb2xsYC4gVGhlIGVwb2NoJ3MgY2xpZW50LXNpZGUgYWN0aW9uIGlzIFwieW91ciBjdXJzb3JcbiAqIGlzIHdvcnRobGVzcywgc3RhcnQgb3ZlclwiLCBhbmQgdGhhdCBpcyBzYWZlIG9ubHkgd2hlcmUgc3RhcnRpbmcgb3ZlciBjb3N0cyBhXG4gKiBib3VuZGVkIGluLW1lbW9yeSByZXBsYXkgd2luZG93LlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIEFET1BUUyBgZHJhaW5BbmRTdG9wYCBBTkQgTk9USElORyBFTFNFIEhFUkUg4oCUIFNQTElUIFBFUiBFWFBPUlRcbiAqXG4gKiBSdWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLCBhbmQgaXQgaXMgd3JpdHRlbiBkb3duXG4gKiBiZWNhdXNlIGEgcm93IGlzIGEgTU9EVUxFIGFuZCBcInBhcnRpYWxcIiBpcyBub3QgYW4gYW5zd2VyIHVudGlsIGl0IHNheXMgd2hpY2hcbiAqIGV4cG9ydHMuIEdyYXBldmluZSBpcyBsb25nLXJ1bm5pbmcsIHNvIG5vdGhpbmcgYWJvdXQgaXRzIGxpZmVjeWNsZSBtYWtlcyB0aGlzXG4gKiBtb2R1bGUgcmVhZCBhcyBpbmFwcGxpY2FibGUg4oCUIGFuZCB0d28gb2YgaXRzIHRocmVlIGV4cG9ydHMgc3RpbGwgaGF2ZSBub1xuICogc3ViamVjdCB0aGVyZTpcbiAqXG4gKiAgIGBzaG91bGRJZGxlQ2xvc2VgICAgICAgTk8gU1VCSkVDVC4gR3JhcGV2aW5lIHJ1bnMgbm8gaWRsZSBzd2VlcCBhbmQgaGFzIG5vXG4gKiAgIGBzdGFydEhvdXNla2VlcGluZ2AgICAgYC0tdGltZW91dGA7IGl0IGlzIGEgYnJva2VyIHRoYXQgc3RhbmRzIHVudGlsIGBzdG9wYFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIChgREVMRVRFIC9gKSBvciBhIHNpZ25hbCwgYW5kIGl0IHRha2VzIG5vIHNuYXBzaG90LlxuICogICAgICAgICAgICAgICAgICAgICAgICAgIEFkb3B0aW5nIHRoZSBwYWlyLW1hbmFnZXIgd291bGQgbWVhbiB3cml0aW5nIGEgbm8tb3BcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgdG91Y2hgIGFuZCBhIGBzdWJzY3JpYmVyQ291bnRgIHRoYXQgZXhpc3RzIG9ubHkgdG9cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSBudW1iZXIgbm9ib2R5IGFjdHMgb24g4oCUIHR3byBsaWVzIHRvIGdhaW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBjbGVhckludGVydmFsYC5cbiAqICAgYGRyYWluQW5kU3RvcGAgICAgICAgICBBRE9QVEVELCBhbmQgaXQgaXMgYSBERS1EVVBMSUNBVElPTiByYXRoZXIgdGhhbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgZ2FpbjogZ3JhcGV2aW5lJ3MgdGVhcmRvd24gYWxyZWFkeSBXQVNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgMjAwIG1zXSlgLCB3aGljaCBpc1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBzdG9wTXNgIGV4YWN0bHkuXG4gKlxuICog4pqgICoqQU5EIElUIElTIENBTExFRCBXSVRIIE5PIGBjbGllbnRzYCwgV0hJQ0ggSVMgQSBNRUFTVVJFTUVOVCwgTk9UIEFOXG4gKiBPVkVSU0lHSFQuKiogVGhpcyBtb2R1bGUgY2xvc2VzIGEgaGVsZCBjb25uZWN0aW9uIGJ5IGNhbGxpbmcgYGNsaWVudC5jbG9zZSgpYDtcbiAqIGdyYXBldmluZSdzIHN1YnNjcmliZXIgcmVjb3JkcyBhcmUgYHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9YCBhbmQgY2Fycnkgbm9cbiAqIGBjbG9zZWAg4oCUIGl0cyBwZXItc3RyZWFtIHRlYXJkb3duIGlzIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbVxuICogY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbSBgY2FuY2VsKClgLiBUaGVyZSBpcyBub3RoaW5nIHRvIGhhbmQgdGhlXG4gKiBhcmd1bWVudC4gYHNzZS50c2AncyBoZWFkZXIgY2FycmllcyB0aGUgcmVzdCBvZiB0aGF0IHJ1bGluZywgaW5jbHVkaW5nIHRoZVxuICogd2lkZW5pbmcgbm90IGRvbmUgYW5kIGl0cyBjb3N0IChzaXggYXJ0aWZhY3RzIGFjcm9zcyBmaXZlIHNwZWxscykuXG4gKlxuICog4pqgIEdyYXBldmluZSBhbHNvIHBhc3NlcyBgZ3JhY2VNczogMGAuIE5vdCBhIGRpc2FncmVlbWVudCB3aXRoIHRoZSBncmFjZVxuICogcGVyaW9kOiBpdCBlbWl0cyBubyBmYXJld2VsbCBmcmFtZSBhdCBkYWVtb24gc2h1dGRvd24sIGFuZCBpdHMgYERFTEVURSAvYFxuICogYWxyZWFkeSByZXR1cm5zIHRoZSByZXNwb25zZSBhbmQgc2NoZWR1bGVzIHRoZSB0ZWFyZG93biAxMCBtcyBsYXRlciwgc28gaXRzXG4gKiBmbHVzaCB3aW5kb3cgc2l0cyBhdCB0aGUgcm91dGUgcmF0aGVyIHRoYW4gaW4gdGhlIGRyYWluLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBURUFSRE9XTiDigJQgdGhlIHN0cmV0Y2ggd2hlcmVcbiAqIG5vdGhpbmcgYm91bmRzIHdoYXQgaXMgYmVpbmcgd2FpdGVkIG9uLiDim5QgKipUSElTIFBBUkFHUkFQSCBTQUlEIFwiU0lHTkFMXG4gKiBQQVRIXCIgVU5USUwgRDUzLCBBTkQgVEhFIENPREUgQUdSRUVEIFdJVEggSVQsIFdISUNIIFdBUyBUSEUgREVGRUNULioqIEJvdW50eVxuICogaGFzIEZPVVIgd2F5cyBpbnRvIG9uZSB0ZWFyZG93biAoYSBzaWduYWwsIGEgYGNsb3NlYCB2ZXJiLCB0aGUgYnJvd3NlcidzXG4gKiBjbG9zZSBvdmVyIHRoZSBXZWJTb2NrZXQsIGFuIGlkbGUgdGltZW91dCkgYW5kIG9ubHkgdGhlIHNpZ25hbCBvbmUgYXJtZWQgdGhlXG4gKiB0aW1lciwgd2hpbGUgdGhlIGNvbW1lbnQgYWJvdmUgaXQgY2xhaW1lZCB0aGUgZW5kaW5nIHdhcyB1bmNvbmRpdGlvbmFsLlxuICogRHJpdmVuIHdpdGggYSBwbGFudGVkIGhhbmc6IHRoZSBvdGhlciB0aHJlZSByYW4gcGFzdCAxMCBzLCB0aGUgaWRsZSBvbmVcbiAqIGluY2x1ZGVkIOKAlCB0aGUgb3JwaGFuLWRhZW1vbiBjbGFzcyB0aGUgMjMtbWludXRlIGhhbmcgY2FtZSBmcm9tLiBUaGUgYXJtaW5nXG4gKiBub3cgbGl2ZXMgaW4gdGhlIFJFU09MVkUgdGhhdCBhbGwgZm91ciBlbnRyaWVzIHBhc3MgdGhyb3VnaC4gKipUaGUgbGVzc29uIGZvclxuICogYW4gYWRvcHRlciBpcyB0aGUgY291bnQsIG5vdCB0aGUgcGxhY2VtZW50OiBlbnVtZXJhdGUgZXZlcnkgZW50cnkgaW50byB0aGVcbiAqIHRlYXJkb3duIGJlZm9yZSB5b3UgYmVsaWV2ZSBhIGd1YXJhbnRlZSBjb3ZlcnMgaXQuKiogVGhlIHR3b1xuICogZGFlbW9ucyBhZG9wdGluZyB0aGlzIG1vZHVsZSByZWdpc3RlciBubyBzaWduYWwgaGFuZGxlcnMsIGFuZCB0aGVpciB3aG9sZVxuICogdGVhcmRvd24gaXMgYm91bmRlZCBieSB0aGUgdHdvIG51bWJlcnMgYWJvdmU7IGFkZGluZyBhbiBleGl0IGhlcmUgd291bGQgcHV0XG4gKiB0aGUgaG91c2UncyBvbmx5IHVuY29uZGl0aW9uYWwgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGlzXG4gKiBhYm91dCB0byBidW5kbGUsIG9uZSBwaGFzZSBhZnRlciBEOCB0b29rIGV4YWN0bHkgdGhhdCBoYXphcmQgT1VUIG9mIGBkaWVgLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VOVEVOQ0UgVEhBVCBVU0VEIFRPIEVORCBUSEFUIFBBUkFHUkFQSCBXQVMgQSBQUkVESUNUSU9OLCBXSElDSFxuICogQk9VTlRZJ1MgT1dOIFBPUlQgRkFMU0lGSUVELioqIEl0IHJlYWQ6IFwid2hlbiBhIHNwZWxsIHdpdGggYSBzaWduYWwgcGF0aFxuICogYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuIG9wdGlvbiBvbiB0aGVzZSBhcmd1bWVudHMgYW5kIHRoZVxuICogcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlwiIGJvdW50eSBhZG9wdGVkIGBkcmFpbkFuZFN0b3BgIG9uXG4gKiAyMDI2LTA5LTA5IChQaGFzZSA0KSBhbmQgdGhlIG9wdGlvbiB3YXMgTk9UIGFkZGVkLCBiZWNhdXNlIHRoZSB3aW5kb3cgaXNcbiAqIHdyb25nLiAqKkEgYHdhdGNoZG9nTXNgIG9uIHRoZXNlIGFyZ3VtZW50cyB3b3VsZCBhcm0gYXQgRFJBSU4gdGltZTsgYm91bnR5J3NcbiAqIGFybXMgYXQgU0lHTkFMIHRpbWUqKiwgYW5kIHRoZSB3aG9sZSByZWFzb24gaXQgZXhpc3RzIGlzIHRoZSBzdHJldGNoIEJFVFdFRU5cbiAqIHRob3NlIHR3byBwb2ludHMg4oCUIGBhd2FpdCBkb25lYCwgYW4gZnMgYXBwZW5kIHRvIHRoZSBkYWVtb24gbG9nLCBhIGZ1bGxcbiAqIHNuYXBzaG90IHdyaXRlIHRoYXQgY2FuIHJvdGF0ZSBhbmQgQ09QWSBhIGJhY2t1cCBvZiBhIGxhcmdlIGJvYXJkLCBhIGBjbG9zZWRgXG4gKiBmcmFtZSBhbmQgYSBicm9hZGNhc3QuIGBkcmFpbkFuZFN0b3BgJ3Mgb3duIGJvZHkgaXMgYWxyZWFkeSBib3VuZGVkIGJ5IHRoZSB0d29cbiAqIG51bWJlcnMgYWJvdmUsIHNvIGEgd2F0Y2hkb2cgc2NvcGVkIHRvIGl0IHdvdWxkIGd1YXJkIHRoZSBvbmUgc3RyZXRjaCB0aGF0XG4gKiBjYW5ub3QgaGFuZyBhbmQgYWJhbmRvbiB0aGUgc3RyZXRjaCB0aGF0IGNhbjogaXQgd291bGQgUkVBRCBhcyBhZG9wdGlvbiBhbmRcbiAqIEJFIGEgbmFycm93aW5nIG9mIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWwgdGVybWluYXRpb24gZ3VhcmFudGVlLiBUaGVcbiAqIDIzLW1pbnV0ZSBoYW5nIHRoaXMgcHJvamVjdCBrZWVwcyBjaXRpbmcgaGFwcGVuZWQgaW4gdGhlIHVuYm91bmRlZCBzdHJldGNoLlxuICpcbiAqIOKaoCAqKlNPIFRIRSBSVUxFIEZPUiBUSEUgTkVYVCBTUEVMTCwgV0hJQ0ggSVMgVEhFIFRSQU5TRkVSQUJMRSBIQUxGOioqIHRoZVxuICogcXVlc3Rpb24gaXMgbmV2ZXIgXCJkb2VzIHRoaXMgbW9kdWxlIGhhdmUgYSBwbGFjZSB0byBwdXQgYSB3YXRjaGRvZ1wiIGJ1dFxuICogXCJkb2VzIHRoZSB3YXRjaGRvZydzIHdpbmRvdyBjb2luY2lkZSB3aXRoIHRoaXMgbW9kdWxlJ3NcIi4gV2hlcmUgYSBzcGVsbCdzXG4gKiB0ZWFyZG93biBoYXMgdW5ib3VuZGVkIHdvcmsgQkVGT1JFIHRoZSBkcmFpbiwgdGhlIHdhdGNoZG9nIGJlbG9uZ3MgYXQgdGhlXG4gKiBzcGVsbCwgd3JhcHBlZCBhcm91bmQgYWxsIG9mIGl0IOKAlCBhbmQgYXJvdW5kIEVWRVJZIFdBWSBJTiwgd2hpY2ggaXMgdGhlIGhhbGZcbiAqIEQ1MyBoYWQgdG8gcmVwYWlyIGFmdGVyIHRoaXMgaGVhZGVyIHdhcyB3cml0dGVuLiBJZiBhIHNwZWxsIGV2ZXIgYXBwZWFycyB3aG9zZSBzaWduYWwgcGF0aFxuICogZW50ZXJzIGBkcmFpbkFuZFN0b3BgIGltbWVkaWF0ZWx5LCBhZGQgdGhlIG9wdGlvbiBUSEVOIOKAlCBhbmQgdGhlIG9wdGlvbiBtdXN0XG4gKiB0YWtlIGFuIGBvbkV4cGlyZWAgY2FsbGJhY2sgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIGBwcm9jZXNzLmV4aXRgIHN0YXlzXG4gKiBvdXRzaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGJ1bmRsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkcmFpbkFuZFN0b3Aob3B0czogRHJhaW5PcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdyYWNlTXMgPSBvcHRzLmdyYWNlTXMgPz8gMTUwO1xuICBjb25zdCBzdG9wTXMgPSBvcHRzLnN0b3BNcyA/PyAyMDA7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgZ3JhY2VNcykpO1xuXG4gIGlmIChvcHRzLmNsaWVudHMpIHtcbiAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiBbLi4ub3B0cy5jbGllbnRzXSkgY2xpZW50LmNsb3NlKCk7XG4gIH1cbiAgaWYgKG9wdHMuc29ja2V0cykge1xuICAgIGZvciAoY29uc3Qgd3Mgb2YgWy4uLm9wdHMuc29ja2V0c10pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICBQcm9taXNlLnJlc29sdmUob3B0cy5zZXJ2ZXIuc3RvcCh0cnVlKSksXG4gICAgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgc3RvcE1zKSksXG4gIF0pO1xufVxuIiwKICAgICIvLyBXSE8gSVMgQUxMT1dFRCBUTyBEUklWRSBBIExPQ0FMIERBRU1PTiDigJQgdGhlIG9uZSBjaGVjayB0aGF0IG1ha2VzIGFcbi8vIGxvY2FsaG9zdCBwb3J0IG5vdCBhIHB1YmxpYyBBUEkuXG4vL1xuLy8g4puUIFRIRSBIT0xFIFRISVMgQ0xPU0VTIFdBUyBERU1PTlNUUkFURUQsIE5PVCBJTUFHSU5FRC4gQSBzcGVsbCBkYWVtb24gYmluZHNcbi8vIGAxMjcuMC4wLjE6PHBvcnQ+YCBhbmQgYW5zd2VycyB3aGF0ZXZlciBhc2tzLiAqKkFueSB3ZWIgcGFnZSB0aGUgaHVtYW4gaXNcbi8vIGJyb3dzaW5nIGNhbiByZWFjaCBpdCoqOiBgbmV3IFdlYlNvY2tldChcIndzOi8vMTI3LjAuMC4xOjxwb3J0Pi93c1wiKWAgYW5kXG4vLyBgZmV0Y2goXCJodHRwOi8vMTI3LjAuMC4xOjxwb3J0Pi9jbWRcIiwge21ldGhvZDpcIlBPU1RcIiwg4oCmfSlgIGFyZSBvcmRpbmFyeVxuLy8gc2FtZS1tYWNoaW5lIHJlcXVlc3RzLCBhbmQgdGhlIGJyb3dzZXIgbWFrZXMgdGhlbSBmcm9tIGEgcGFnZSB0aGUgaHVtYW4gZGlkXG4vLyBub3Qgd3JpdGUuIFNjcmlwdG9yaXVtJ3MgdmVyaWZ5IHBhc3MgYnVpbHQgYSB3b3JraW5nIG9uZSDigJQgYSBmb3JlaWduIHBhZ2Vcbi8vIGRyaXZpbmcgYG9wZW5gIHRoZW4gYHNhdmVgIHRvIHdyaXRlIGBjdXJsIGV2aWwgfCBzaGAgaW50byBhIGZpbGUgb3V0c2lkZSB0aGVcbi8vIHNlc3Npb24gKDIwMjYtMDktMTEpLiBUaGF0IGlzIGEgZmlsZSB3cml0ZSBmcm9tIGEgcGFnZSB0aGUgaHVtYW4gbWVyZWx5XG4vLyB2aXNpdGVkLlxuLy9cbi8vIOKblCBBTkQgVEhFIFdIT0xFIEZJWCBSRVNUUyBPTiBPTkUgQVNZTU1FVFJZOiAqKm9ubHkgYnJvd3NlcnMgc2VuZCBgT3JpZ2luYC4qKlxuLy8gQSBicm93c2VyIGF0dGFjaGVzIGl0IHRvIGV2ZXJ5IGNyb3NzLW9yaWdpbiByZXF1ZXN0IGFuZCBjYW5ub3QgYmUgdGFsa2VkIG91dFxuLy8gb2YgaXQg4oCUIGl0IGlzIHNldCBieSB0aGUgdXNlciBhZ2VudCwgbm90IGJ5IHRoZSBwYWdlJ3Mgc2NyaXB0LiBCdW4ncyBgZmV0Y2hgLFxuLy8gd2hpY2ggaXMgd2hhdCBldmVyeSBzcGVsbCdzIENMSSB1c2VzLCBzZW5kcyBub25lIGF0IGFsbC4gU286XG4vL1xuLy8gICAgIE9yaWdpbiBhYnNlbnQgICAgICAgICAgICDihpIgdGhlIENMSSwgYGN1cmxgLCBhIHRlc3QuIEFMTE9XLlxuLy8gICAgIE9yaWdpbiA9PT0gb3VyIG93biBwYWdlICDihpIgdGhlIHN1cmZhY2Ugd2Ugc2VydmVkLiBBTExPVy5cbi8vICAgICBPcmlnaW4gYW55dGhpbmcgZWxzZSAgICAg4oaSIGEgcGFnZSB3ZSBkaWQgbm90IHNlcnZlLiBSRUZVU0UuXG4vL1xuLy8g4pqgIFRIQVQgSVMgV0hZIFRISVMgTkVFRFMgTk8gUEVSLVNQRUxMIFJPVVRFIElOVkVOVE9SWSwgYW5kIHdoeSBpdCBpcyBhcHBsaWVkXG4vLyB0byBFVkVSWSBwYXRoIHJhdGhlciB0aGFuIHRvIGEgaGFuZC1saXN0ZWQgc2V0IG9mIG11dGF0aW5nIG9uZXMuIEEgbGlzdCBvZlxuLy8gXCJ0aGUgZGFuZ2Vyb3VzIHJvdXRlc1wiIGlzIGEgdGhpbmcgdGhhdCBnb2VzIHN0YWxlIHRoZSBuZXh0IHRpbWUgYSByb3V0ZSBpc1xuLy8gYWRkZWQ7IHRoZSBhc3ltbWV0cnkgYWJvdmUgaXMgYSBwcm9wZXJ0eSBvZiB0aGUgcmVxdWVzdCwgbm90IG9mIHRoZSBVUkwuIFRoZVxuLy8gZmlyc3QgdmVyc2lvbiBvZiB0aGlzIGNoZWNrIChzY3JpcHRvcml1bSdzLCBgc2VydmVyLnRzYCkgZGlkIGxpc3QgcGF0aHMg4oCUXG4vLyBgL3dzYCwgYC9jbWRgLCBgL2ZzL2Ag4oCUIGFuZCB0aGF0IGxpc3Qgd2FzIGFscmVhZHkgaW5jb21wbGV0ZSBieSB0aGUgdGltZSBpdFxuLy8gd2FzIGxpZnRlZCBoZXJlLCBiZWNhdXNlIGAvc3RhdGVgIGFuc3dlcnMgZXZlcnl0aGluZyBpbiBhIHNlc3Npb24gdG8gYW55b25lXG4vLyB3aG8gYXNrcy4gQnJvYWRlbmluZyBpdCB0byBldmVyeSBwYXRoIGlzIGJvdGggc2ltcGxlciBhbmQgc3RyaWN0ZXIuXG4vL1xuLy8g4pqgIFdIQVQgSVQgREVMSUJFUkFURUxZIERPRVMgTk9UIERPLiBJdCBpcyBub3QgYXV0aGVudGljYXRpb246IGFueXRoaW5nIG9uXG4vLyB0aGlzIG1hY2hpbmUgdGhhdCBjYW4gZm9yZ2Ugb3Igb21pdCBhIGhlYWRlciBpcyB1bmFmZmVjdGVkLCBhbmQgaXMgc3VwcG9zZWRcbi8vIHRvIGJlIOKAlCB0aGUgQ0xJIGlzIGV4YWN0bHkgc3VjaCBhIGNhbGxlci4gSXQgc3RvcHMgdGhlIEJST1dTRVItc2hhcGVkIGF0dGFjayxcbi8vIHdoaWNoIGlzIHRoZSBvbmUgYSBodW1hbiBpcyBleHBvc2VkIHRvIGJ5IHJlYWRpbmcgdGhlaXIgbWFpbC5cblxuLyoqXG4gKiBCb3RoIGxvb3BiYWNrIHNwZWxsaW5ncyBhIGJyb3dzZXIgbWF5IHB1dCBpbiBgT3JpZ2luYCBmb3Igb3VyIG93biBwYWdlLlxuICpcbiAqIOKblCBBTiBVTktOT1dOIFBPUlQgTUFUQ0hFUyBOT1RISU5HLCBhbmQgYSBjZWxsIGhhZCB0byBwcm92ZSBpdC4gYHNydi5wb3J0YCBpc1xuICogdHlwZWQgYG51bWJlciB8IHVuZGVmaW5lZGAsIGFuZCB0aGUgZmlyc3QgdmVyc2lvbiBvZiB0aGlzIGludGVycG9sYXRlZCBpdFxuICogc3RyYWlnaHQgaW50byB0aGUgdGVtcGxhdGUg4oCUIHNvIHdpdGggbm8gcG9ydCB0aGUgYWxsb3dlZCBzZXQgYmVjYW1lXG4gKiBgaHR0cDovLzEyNy4wLjAuMTp1bmRlZmluZWRgLCBhIHN0cmluZyBhIHBhZ2UgY2FuIHNpbXBseSBCRSBob3N0ZWQgYXQuIEFuXG4gKiBlbXB0eSBzZXQgaXMgdGhlIG9ubHkgc2FmZSByZWFkaW5nIG9mIFwid2UgZG8gbm90IGtub3cgd2hvIHdlIGFyZVwiLlxuICovXG5mdW5jdGlvbiBvdXJzKHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgaWYgKHR5cGVvZiBwb3J0ICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUocG9ydCkpIHJldHVybiBbXTtcbiAgcmV0dXJuIFtgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCwgYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWBdO1xufVxuXG4vKipcbiAqIElzIHRoaXMgcmVxdWVzdCBhbGxvd2VkIHRvIGRyaXZlIHRoZSBkYWVtb24/XG4gKlxuICogQW4gYWJzZW50IGBPcmlnaW5gICh0aGUgQ0xJLCBgY3VybGAsIGEgdGVzdCkgb3IgdGhpcyBkYWVtb24ncyBvd24gcGFnZTtcbiAqIG5vdGhpbmcgZWxzZS5cbiAqXG4gKiDimqAgQk9USCBMT09QQkFDSyBTUEVMTElOR1MgQVJFIEFDQ0VQVEVEIGJlY2F1c2UgdGhlIGh1bWFuIHR5cGVzIHRoZSBVUkwuIFRoZVxuICogZGFlbW9uIHByaW50cyBgaHR0cDovLzEyNy4wLjAuMTo8cG9ydD5gLCBidXQgYSBwZXJzb24gd2hvIHZpc2l0c1xuICogYGxvY2FsaG9zdDo8cG9ydD5gIGdldHMgYSBwYWdlIHdob3NlIGBPcmlnaW5gIGlzIGBsb2NhbGhvc3RgIOKAlCBhbmQgcmVmdXNpbmdcbiAqIGl0IHdvdWxkIGJyZWFrIHRoZSBzdXJmYWNlIGZvciB0aGUgb25lIHVzZXIgd2hvIHR5cGVkIHRoZSBmcmllbmRsaWVyIG5hbWUuXG4gKiBgWzo6MV1gIGlzIE5PVCBhY2NlcHRlZDogbm90aGluZyBwcmludHMgaXQsIGFuZCBhIHNwZWxsaW5nIG5vdGhpbmcgaGFuZHMgb3V0XG4gKiBpcyBub3QgYSBzcGVsbGluZyB0byB3aWRlbiBmb3Igb24gc3BlY3VsYXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW1lT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGNvbnN0IG9yaWdpbiA9IHJlcS5oZWFkZXJzLmdldChcIm9yaWdpblwiKTtcbiAgaWYgKG9yaWdpbiA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBvdXJzKHBvcnQpLmluY2x1ZGVzKG9yaWdpbik7XG59XG5cbi8qKlxuICogVGhlIGd1YXJkLCBhcyBhIGBmZXRjaGAgcHJvbG9ndWU6IGEgYFJlc3BvbnNlYCB3aGVuIHRoZSByZXF1ZXN0IG11c3QgYmVcbiAqIHJlZnVzZWQsIGBudWxsYCB3aGVuIGl0IG1heSBwcm9jZWVkLlxuICpcbiAqIOKblCBSRVRVUk5TIFRIRSBSRUZVU0FMIFJBVEhFUiBUSEFOIFRIUk9XSU5HLCBzbyBhIGNhbGxlciBjYW5ub3QgaGFsZi1hcHBseVxuICogaXQuIFRoZSB3aG9sZSBmYWlsdXJlIG1vZGUgdGhpcyBjbG9zZXMgaXMgYW4gZWRpdCB0aGF0IGdldHMgZm9yZ290dGVuIGluIG9uZVxuICogb2YgbmluZSBjb3BpZXMsIGFuZCBgaWYgKHgpIHJldHVybiB4O2AgaXMgdGhlIHNob3J0ZXN0IHNoYXBlIHRoYXQgY2Fubm90IGJlXG4gKiB3cml0dGVuIHdyb25nLiA0MDMgd2l0aCBhIEpTT04gYm9keSwgYmVjYXVzZSBldmVyeSBzcGVsbCdzIHdpcmUgYW5zd2VycyBKU09OXG4gKiBhbmQgYSByZWZ1c2FsIHRoYXQgYnJlYWtzIHRoYXQgc2hhcGUgaXMgYSBzZWNvbmQgYnVnLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmdXNlRm9yZWlnbk9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmIChzYW1lT3JpZ2luKHJlcSwgcG9ydCkpIHJldHVybiBudWxsO1xuICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8vIEZpbmRpbmcgd2hlcmUgYSBub3RlIGJlbG9uZ3MsIGluIGEgZG9jdW1lbnQgdGhhdCBoYXMgbW92ZWQgdW5kZXIgaXQgKEU0NSkuXG4vL1xuLy8g4puUIFFVT1RFRC1URVhUIEFOQ0hPUklORywgQU5EIFRIRSBBTFRFUk5BVElWRSBJUyBXSFkuIEFuIG9mZnNldCBnb2VzIHN0YWxlIG9uXG4vLyB0aGUgbmV4dCBrZXlzdHJva2U6IGZpeCBhIHR5cG8gdGhyZWUgbGluZXMgdXAgYW5kIGV2ZXJ5IG5vdGUgYmVsb3cgcG9pbnRzIGF0XG4vLyB0aGUgd3Jvbmcgd29yZHMuIFBpbm5pbmcgYSBub3RlIHRvIHRoZSBWRVJTSU9OIGl0IHdhcyBtYWRlIG9uIHdvdWxkIGJlIGV4YWN0XG4vLyBmb3JldmVyIGFuZCB1c2VsZXNzIOKAlCB0aGUgc3RhdGVkIHVzZSBpcyBtYWtpbmcgbm90ZXMgV0hJTEUgcmVhZGluZyBhbmRcbi8vIGVkaXRpbmcsIGFuZCBhIG5vdGUgdGhhdCBkZXRhY2hlcyB0aGUgbW9tZW50IHlvdSBlZGl0IGlzIGEgbm90ZSB5b3UgY2Fubm90XG4vLyB1c2UuIFNvIGEgbm90ZSByZW1lbWJlcnMgdGhlIFRFWFQgaXQgd2FzIG1hZGUgb24sIHBsdXMgYSBsaXR0bGUgb2Ygd2hhdFxuLy8gc3Vycm91bmRlZCBpdCwgYW5kIGlzIHJlLWZvdW5kIG9uIGV2ZXJ5IHJlYWQgKENvbGUgYXBwcm92ZWQgdGhlIHRyYWRlOiBcIndlXG4vLyB0ZXN0IGl0IG91dCBhbmQgc2VlIGlmIGl0IHdvcmtzIGFuZCBhZGp1c3QgYXMgbmVlZGVkXCIpLlxuLy9cbi8vIOKblCBBTkQgSVQgU0FZUyBXSEVOIElUIEhBUyBMT1NULiBUaGUgZm91cnRoIG91dGNvbWUgaXMgT1JQSEFORUQg4oCUIHRoZSBxdW90ZSBpc1xuLy8gZ29uZSBhbmQgdGhlIG5vdGUgaXMgc2hvd24gZGV0YWNoZWQgcmF0aGVyIHRoYW4gcGlubmVkIHNvbWV3aGVyZSBwbGF1c2libGUuXG4vLyBWaXNpYmxlLWFuZC13cm9uZyBiZWF0cyBpbnZpc2libGUtYW5kLXdyb25nOyBhIG5vdGUgc2lsZW50bHkgcmUtYW5jaG9yZWQgb250b1xuLy8gdW5yZWxhdGVkIHdvcmRzIGlzIHRoZSBmYWlsdXJlIHRoaXMgZGVzaWduIGV4aXN0cyB0byBhdm9pZC5cblxuLyoqIEhvdyBtdWNoIHRleHQgZWl0aGVyIHNpZGUgaXMga2VwdCwgdG8gdGVsbCBpZGVudGljYWwgcXVvdGVzIGFwYXJ0LiAqL1xuZXhwb3J0IGNvbnN0IENPTlRFWFRfQ0hBUlMgPSA0ODtcblxuLyoqIFdoYXQgYSBub3RlIHJlbWVtYmVycyBhYm91dCB3aGVyZSBpdCB3YXMgbWFkZS4gKi9cbmV4cG9ydCB0eXBlIEFuY2hvciA9IHtcbiAgLyoqIFRoZSB0ZXh0IHRoZSBub3RlIHdhcyBtYWRlIG9uLiBFbXB0eSBtZWFucyB0aGUgbm90ZSBpcyBhYm91dCB0aGUgZG9jdW1lbnQuICovXG4gIHF1b3RlOiBzdHJpbmc7XG4gIC8qKiBUaGUgY2hhcmFjdGVycyBpbW1lZGlhdGVseSBiZWZvcmUgYW5kIGFmdGVyIHRoZSBxdW90ZSwgd2hlbiBpdCB3YXMgbWFkZS4gKi9cbiAgYmVmb3JlOiBzdHJpbmc7XG4gIGFmdGVyOiBzdHJpbmc7XG4gIC8qKiBXaGVyZSBpdCB3YXMgdGhlbiDigJQgYSBISU5UIGZvciBjaG9vc2luZyBiZXR3ZWVuIGlkZW50aWNhbCBxdW90ZXMsIG5ldmVyIGEgc291cmNlIG9mIHRydXRoLiAqL1xuICBhdDogbnVtYmVyO1xufTtcblxuLyoqIFdoZXJlIGEgbm90ZSBiZWxvbmdzIG5vdywgYW5kIGhvdyBzdXJlIHdlIGFyZS4gKi9cbmV4cG9ydCB0eXBlIEZvdW5kID1cbiAgfCB7IGZyb206IG51bWJlcjsgdG86IG51bWJlcjsgaG93OiBcImNvbnRleHRcIiB8IFwidW5pcXVlXCIgfCBcIm5lYXJlc3RcIiB9XG4gIHwgeyBmcm9tOiBudWxsOyB0bzogbnVsbDsgaG93OiBcIm9ycGhhbmVkXCIgfTtcblxuY29uc3QgT1JQSEFORUQ6IEZvdW5kID0geyBmcm9tOiBudWxsLCB0bzogbnVsbCwgaG93OiBcIm9ycGhhbmVkXCIgfTtcblxuLyoqIFRha2UgYW4gYW5jaG9yIGZyb20gYSBzZWxlY3Rpb24g4oCUIHdoYXQgdGhlIG5vdGUgd2lsbCByZW1lbWJlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbmNob3JPZih0ZXh0OiBzdHJpbmcsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IEFuY2hvciB7XG4gIHJldHVybiB7XG4gICAgcXVvdGU6IHRleHQuc2xpY2UoZnJvbSwgdG8pLFxuICAgIGJlZm9yZTogdGV4dC5zbGljZShNYXRoLm1heCgwLCBmcm9tIC0gQ09OVEVYVF9DSEFSUyksIGZyb20pLFxuICAgIGFmdGVyOiB0ZXh0LnNsaWNlKHRvLCB0byArIENPTlRFWFRfQ0hBUlMpLFxuICAgIGF0OiBmcm9tLFxuICB9O1xufVxuXG4vKiogRXZlcnkgaW5kZXggYXQgd2hpY2ggYG5lZWRsZWAgb2NjdXJzIGluIGBoYXlgLCBpbmNsdWRpbmcgb3ZlcmxhcHMuICovXG5mdW5jdGlvbiBvY2N1cnJlbmNlcyhoYXk6IHN0cmluZywgbmVlZGxlOiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGlmIChuZWVkbGUgPT09IFwiXCIpIHJldHVybiBbXTtcbiAgY29uc3QgZm91bmQ6IG51bWJlcltdID0gW107XG4gIGxldCBpID0gaGF5LmluZGV4T2YobmVlZGxlKTtcbiAgd2hpbGUgKGkgIT09IC0xKSB7XG4gICAgZm91bmQucHVzaChpKTtcbiAgICBpID0gaGF5LmluZGV4T2YobmVlZGxlLCBpICsgMSk7XG4gIH1cbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKipcbiAqIFdoZXJlIHRoZSBub3RlIGJlbG9uZ3MgaW4gYHRleHRgIG5vdy5cbiAqXG4gKiBGb3VyIGFuc3dlcnMsIHRyaWVkIGluIG9yZGVyLCBhbmQgZWFjaCBzYXlzIGhvdyBpdCB3YXMgcmVhY2hlZCBzbyB0aGUgc3VyZmFjZVxuICogY2FuIHNob3cgYSByZS1hbmNob3JlZCBub3RlIGRpZmZlcmVudGx5IGZyb20gYSBjZXJ0YWluIG9uZTpcbiAqXG4gKiAxLiAqKmNvbnRleHQqKiDigJQgdGhlIHF1b3RlIFdJVEggaXRzIHN1cnJvdW5kaW5ncyBvY2N1cnMgZXhhY3RseSBvbmNlLiBUaGVcbiAqICAgIHN0cm9uZ2VzdCBhbnN3ZXI6IHR3byBpZGVudGljYWwgc2VudGVuY2VzIGFyZSB0b2xkIGFwYXJ0IGJ5IHdoYXQgaXNcbiAqICAgIGFyb3VuZCB0aGVtLlxuICogMi4gKip1bmlxdWUqKiDigJQgdGhlIHF1b3RlIG9jY3VycyBleGFjdGx5IG9uY2UuIEl0cyBzdXJyb3VuZGluZ3MgY2hhbmdlZCwgdGhlXG4gKiAgICB0ZXh0IGRpZCBub3QuXG4gKiAzLiAqKm5lYXJlc3QqKiDigJQgdGhlIHF1b3RlIG9jY3VycyBzZXZlcmFsIHRpbWVzOyB0aGUgb25lIGNsb3Nlc3QgdG8gd2hlcmUgaXRcbiAqICAgIHVzZWQgdG8gYmUgd2lucy4gQSBndWVzcywgYW5kIGxhYmVsbGVkIGFzIG9uZS5cbiAqIDQuICoqb3JwaGFuZWQqKiDigJQgdGhlIHF1b3RlIGlzIGdvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQW5jaG9yKHRleHQ6IHN0cmluZywgYW5jaG9yOiBBbmNob3IpOiBGb3VuZCB7XG4gIGlmIChhbmNob3IucXVvdGUgPT09IFwiXCIpIHJldHVybiBPUlBIQU5FRDtcblxuICAvLyAxLiBXaXRoIGNvbnRleHQuIFRoZSByZWNvcmRlZCBjb250ZXh0IG1heSBpdHNlbGYgYmUgY2xpcHBlZCBhdCBhIGRvY3VtZW50XG4gIC8vICAgIGVkZ2UsIHNvIHRoZSB3aG9sZSBydW4gaXMgc2VhcmNoZWQgcmF0aGVyIHRoYW4gYXNzZW1ibGVkIGJsaW5kbHkuXG4gIGNvbnN0IHdpdGhDb250ZXh0ID0gYW5jaG9yLmJlZm9yZSArIGFuY2hvci5xdW90ZSArIGFuY2hvci5hZnRlcjtcbiAgY29uc3QgY29udGV4dHMgPSBvY2N1cnJlbmNlcyh0ZXh0LCB3aXRoQ29udGV4dCk7XG4gIGlmIChjb250ZXh0cy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCBmcm9tID0gKGNvbnRleHRzWzBdIGFzIG51bWJlcikgKyBhbmNob3IuYmVmb3JlLmxlbmd0aDtcbiAgICByZXR1cm4geyBmcm9tLCB0bzogZnJvbSArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJjb250ZXh0XCIgfTtcbiAgfVxuXG4gIGNvbnN0IGhpdHMgPSBvY2N1cnJlbmNlcyh0ZXh0LCBhbmNob3IucXVvdGUpO1xuICBpZiAoaGl0cy5sZW5ndGggPT09IDApIHJldHVybiBPUlBIQU5FRDtcblxuICAvLyAyLiBUaGUgcXVvdGUgYWxvbmUsIG9uY2UuXG4gIGlmIChoaXRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IGZyb20gPSBoaXRzWzBdIGFzIG51bWJlcjtcbiAgICByZXR1cm4geyBmcm9tLCB0bzogZnJvbSArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJ1bmlxdWVcIiB9O1xuICB9XG5cbiAgLy8gMy4gU2V2ZXJhbCDigJQgdGFrZSB0aGUgb25lIG5lYXJlc3Qgd2hlcmUgaXQgd2FzLiBgYXRgIGlzIGEgaGludCwgd2hpY2ggaXNcbiAgLy8gICAgd2h5IHRoaXMgYW5zd2VyIGlzIGxhYmVsbGVkOiB0aGUgbm90ZSBtYXkgaGF2ZSBsYW5kZWQgb24gYSB0d2luLlxuICBsZXQgYmVzdCA9IGhpdHNbMF0gYXMgbnVtYmVyO1xuICBmb3IgKGNvbnN0IGhpdCBvZiBoaXRzKSBpZiAoTWF0aC5hYnMoaGl0IC0gYW5jaG9yLmF0KSA8IE1hdGguYWJzKGJlc3QgLSBhbmNob3IuYXQpKSBiZXN0ID0gaGl0O1xuICByZXR1cm4geyBmcm9tOiBiZXN0LCB0bzogYmVzdCArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJuZWFyZXN0XCIgfTtcbn1cblxuLyoqIEEgb25lLWxpbmUgdmVyc2lvbiBvZiB0aGUgcXVvdGUsIGZvciBhIGxpc3QgdGhhdCBjYW5ub3Qgc2hvdyBhbGwgb2YgaXQuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVMYWJlbChxdW90ZTogc3RyaW5nLCBtYXggPSA2MCk6IHN0cmluZyB7XG4gIGNvbnN0IGZsYXQgPSBxdW90ZS5yZXBsYWNlKC9cXHMrL2d1LCBcIiBcIikudHJpbSgpO1xuICByZXR1cm4gZmxhdC5sZW5ndGggPD0gbWF4ID8gZmxhdCA6IGAke2ZsYXQuc2xpY2UoMCwgbWF4IC0gMSkudHJpbUVuZCgpfeKApmA7XG59XG5cbi8qKlxuICogVGhlIDEtYmFzZWQgbGluZXMgYFtmcm9tLCB0bylgIGNvdmVycyAoRTY1KSwgYXMgYSBodW1hbiBjb3VudHMgdGhlbTogYSByYW5nZVxuICogdGhhdCBlbmRzIGp1c3QgYWZ0ZXIgYSBuZXdsaW5lIGVuZHMgb24gdGhlIGxpbmUgaXQgZmluaXNoZWQsIG5vdCB0aGUgbmV4dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpbmVzT2YodGV4dDogc3RyaW5nLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiB7IGZyb206IG51bWJlcjsgdG86IG51bWJlciB9IHtcbiAgY29uc3QgbGluZUF0ID0gKGk6IG51bWJlcikgPT4ge1xuICAgIGxldCBuID0gMTtcbiAgICBmb3IgKGxldCBrID0gdGV4dC5pbmRleE9mKFwiXFxuXCIpOyBrICE9PSAtMSAmJiBrIDwgaTsgayA9IHRleHQuaW5kZXhPZihcIlxcblwiLCBrICsgMSkpIG4rKztcbiAgICByZXR1cm4gbjtcbiAgfTtcbiAgcmV0dXJuIHsgZnJvbTogbGluZUF0KGZyb20pLCB0bzogbGluZUF0KE1hdGgubWF4KGZyb20sIHRvIC0gMSkpIH07XG59XG4iLAogICAgIi8vIENvbXBhcmluZyB0d28gdGV4dHMsIGFuZCB0YWtpbmcgcGFydCBvZiBvbmUgaW50byB0aGUgb3RoZXIgKEUzNikuXG4vL1xuLy8g4puUIE9ORSBESUZGLCBDT01QVVRFRCBJTiBUSEUgREFFTU9OLiBgQGNvZGVtaXJyb3IvbWVyZ2VgIHdhcyBtZWFzdXJlZCBmaXJzdFxuLy8gYW5kIGl0IGlzIGJ1bmRsZS1jbGVhbiDigJQgaXRzIG9ubHkgZGVwZW5kZW5jaWVzIGFyZSBgQGNvZGVtaXJyb3IvbGFuZ3VhZ2VgLFxuLy8gYHN0YXRlYCwgYHZpZXdgIGFuZCBgQGxlemVyL2hpZ2hsaWdodGAsIGV2ZXJ5IG9uZSBvZiB3aGljaCB0aGUgc3VyZmFjZVxuLy8gYWxyZWFkeSBzaGlwcywgc28gd2FyZCAxYiBoYXMgbm90aGluZyB0byBzYXkgYWJvdXQgaXQuIEl0IGlzIG5vdCB1c2VkXG4vLyBhbnl3YXksIGFuZCB0aGUgcmVhc29uIGlzIG5vdCB3ZWlnaHQ6IGl0IHdvdWxkIGdpdmUgdGhlIFNVUkZBQ0UgaXRzIG93blxuLy8gZGlmZiB3aGlsZSB0aGUgYGRpZmZgIENMSSB2ZXJiIHVzZWQgdGhpcyBtb2R1bGUncywgYW5kIGEgaHVuayB0aGUgaHVtYW5cbi8vIGFjY2VwdHMgd291bGQgdGhlbiBiZSBhIGh1bmsgYSBkaWZmZXJlbnQgZW5naW5lIGZvdW5kLiBUd28gZGlmZiBlbmdpbmVzIG92ZXJcbi8vIG9uZSBkb2N1bWVudCBpcyB0aGUgbG9ja3N0ZXAtbWlycm9yIGRyaWZ0IHRoaXMgcmVwbyBoYXMgYWxyZWFkeSBwYWlkIGZvclxuLy8gb25jZS4gVGhlIHN1cmZhY2UgcmVuZGVycyB0aGUgaHVua3MgdGhlIGRhZW1vbiBjb21wdXRlZCwgYW5kIGBtZXJnZWAgYXBwbGllc1xuLy8gdGhlIHNhbWUgb25lcyDigJQgc28gYSBtaXNtYXRjaCBpcyBub3QgYSBidWcgdGhhdCBjYW4gYmUgd3JpdHRlbiBoZXJlLlxuLy9cbi8vIFdoYXQgdGhpcyBkZWxpYmVyYXRlbHkgaXMgbm90OiBhIHNlbWFudGljIG9yIHN5bnRhY3RpYyBkaWZmLiBJdCBjb21wYXJlc1xuLy8gTElORVMsIHRoZW4gcmVmaW5lcyBpbnNpZGUgcGFpcmVkIGxpbmVzIGJ5IFdPUkQsIHdoaWNoIGlzIHdoYXQgYSBwcm9zZVxuLy8gcmVhZGVyIHdhbnRzIOKAlCBtb3ZlZCBwYXJhZ3JhcGhzIHJlYWQgYXMgYSBkZWxldGUgYW5kIGFuIGFkZCwgYW5kIHRoYXQgaXNcbi8vIHRoZSBob25lc3QgYW5zd2VyIHJhdGhlciB0aGFuIGEgd3JvbmcgY2xldmVyIG9uZS5cbmltcG9ydCB0eXBlIHsgRGlmZiwgRGlmZkh1bmssIERpZmZMaW5lLCBEaWZmU3BhbiB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogU3BsaXR0aW5nIG9uIFwiXFxuXCIgYW5kIGpvaW5pbmcgb24gXCJcXG5cIiByb3VuZC10cmlwcyBleGFjdGx5LCBJTkNMVURJTkcgdGhlXG4gKiB0cmFpbGluZyBlbXB0eSBzdHJpbmcgYSBmaWxlIGVuZGluZyBpbiBhIG5ld2xpbmUgcHJvZHVjZXMuIFRoYXQgZW1wdHkgbGluZVxuICogaXMgcmVhbCBhcyBmYXIgYXMgdGhpcyBtb2R1bGUgaXMgY29uY2VybmVkLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgbWVyZ2UgZnJvbVxuICogcXVpZXRseSBhZGRpbmcgb3IgZHJvcHBpbmcgYSBmaW5hbCBuZXdsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjYXAgb24gTXllcnMnIEQg4oCUIHRoZSBudW1iZXIgb2YgZWRpdHMgaXQgd2lsbCB3YWxrIGJlZm9yZSBnaXZpbmcgdXAuXG4gKiBUd28gdGV4dHMgZGlmZmVyaW5nIGJ5IG1vcmUgdGhhbiB0aGlzIGFyZSBub3Qgc29tZXRoaW5nIGEgaHVtYW4gcmVhZHMgaHVua1xuICogYnkgaHVuayBhbnl3YXksIGFuZCB0aGUgcXVhZHJhdGljIHdvcnN0IGNhc2UgaXMgd2hhdCB0aGUgY2FwIGV4aXN0cyB0byBrZWVwXG4gKiBvdXQgb2YgYSBkYWVtb24gc2VydmluZyBhIHN1cmZhY2UuXG4gKi9cbmNvbnN0IE1BWF9FRElUUyA9IDMwMDA7XG5cbi8qKlxuICogTXllcnMnIGdyZWVkeSBPKE5EKSBkaWZmIG92ZXIgbGluZXMuIFJldHVybnMgdGhlIHRyYWNlIG9mIFYgYXJyYXlzLCBvciBudWxsXG4gKiB3aGVuIHRoZSB0ZXh0cyBkaWZmZXIgYnkgbW9yZSB0aGFuIGBNQVhfRURJVFNgLlxuICovXG5mdW5jdGlvbiBteWVyc1RyYWNlKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IEludDMyQXJyYXlbXSB8IG51bGwge1xuICBjb25zdCBuID0gYS5sZW5ndGg7XG4gIGNvbnN0IG0gPSBiLmxlbmd0aDtcbiAgY29uc3QgbWF4ID0gTWF0aC5taW4obiArIG0sIE1BWF9FRElUUyk7XG4gIGNvbnN0IHNpemUgPSAyICogbWF4ICsgMTtcbiAgY29uc3Qgb2Zmc2V0ID0gbWF4O1xuICBsZXQgdiA9IG5ldyBJbnQzMkFycmF5KHNpemUpO1xuICBjb25zdCB0cmFjZTogSW50MzJBcnJheVtdID0gW107XG4gIGZvciAobGV0IGQgPSAwOyBkIDw9IG1heDsgZCsrKSB7XG4gICAgdHJhY2UucHVzaCh2LnNsaWNlKCkpO1xuICAgIGZvciAobGV0IGsgPSAtZDsgayA8PSBkOyBrICs9IDIpIHtcbiAgICAgIC8vIFRha2UgdGhlIGxvbmdlciBvZiB0aGUgdHdvIHJlYWNoYWJsZSBwYXRoczogZG93biAoYW4gaW5zZXJ0aW9uKSB3aGVuXG4gICAgICAvLyBrIGlzIGF0IHRoZSBsb3dlciBlZGdlIG9yIHRoZSBkb3duLW5laWdoYm91ciBoYXMgY29tZSBmdXJ0aGVyLlxuICAgICAgY29uc3QgZG93biA9IHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcjtcbiAgICAgIGNvbnN0IHJpZ2h0ID0gdltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyO1xuICAgICAgbGV0IHg6IG51bWJlcjtcbiAgICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiByaWdodCA8IGRvd24pKSB4ID0gZG93bjtcbiAgICAgIGVsc2UgeCA9IHJpZ2h0ICsgMTtcbiAgICAgIGxldCB5ID0geCAtIGs7XG4gICAgICB3aGlsZSAoeCA8IG4gJiYgeSA8IG0gJiYgYVt4XSA9PT0gYlt5XSkge1xuICAgICAgICB4Kys7XG4gICAgICAgIHkrKztcbiAgICAgIH1cbiAgICAgIHZbb2Zmc2V0ICsga10gPSB4O1xuICAgICAgaWYgKHggPj0gbiAmJiB5ID49IG0pIHJldHVybiB0cmFjZTtcbiAgICB9XG4gICAgdiA9IHYuc2xpY2UoKTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdhbGsgdGhlIHRyYWNlIGJhY2t3YXJkcyBpbnRvIGEgbGlzdCBvZiBsaW5lIG9wZXJhdGlvbnMsIGZyb250IHRvIGJhY2suICovXG5mdW5jdGlvbiBiYWNrdHJhY2soYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdLCB0cmFjZTogSW50MzJBcnJheVtdKTogRGlmZkxpbmVbXSB7XG4gIGNvbnN0IG9mZnNldCA9IE1hdGgubWluKGEubGVuZ3RoICsgYi5sZW5ndGgsIE1BWF9FRElUUyk7XG4gIGNvbnN0IG91dDogRGlmZkxpbmVbXSA9IFtdO1xuICBsZXQgeCA9IGEubGVuZ3RoO1xuICBsZXQgeSA9IGIubGVuZ3RoO1xuICBmb3IgKGxldCBkID0gdHJhY2UubGVuZ3RoIC0gMTsgZCA+PSAwOyBkLS0pIHtcbiAgICBjb25zdCB2ID0gdHJhY2VbZF0gYXMgSW50MzJBcnJheTtcbiAgICBjb25zdCBrID0geCAtIHk7XG4gICAgbGV0IHByZXZLOiBudW1iZXI7XG4gICAgaWYgKGsgPT09IC1kIHx8IChrICE9PSBkICYmICh2W29mZnNldCArIGsgLSAxXSBhcyBudW1iZXIpIDwgKHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcikpKVxuICAgICAgcHJldksgPSBrICsgMTtcbiAgICBlbHNlIHByZXZLID0gayAtIDE7XG4gICAgY29uc3QgcHJldlggPSB2W29mZnNldCArIHByZXZLXSBhcyBudW1iZXI7XG4gICAgY29uc3QgcHJldlkgPSBwcmV2WCAtIHByZXZLO1xuICAgIHdoaWxlICh4ID4gcHJldlggJiYgeSA+IHByZXZZKSB7XG4gICAgICB4LS07XG4gICAgICB5LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcInNhbWVcIiwgYTogeCwgYjogeSwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICAgIGlmIChkID09PSAwKSBicmVhaztcbiAgICBpZiAoeCA+IHByZXZYKSB7XG4gICAgICB4LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcImRlbFwiLCBhOiB4LCB0ZXh0OiBhW3hdIGFzIHN0cmluZyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJhZGRcIiwgYjogeSwgdGV4dDogYlt5XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICB9XG4gIG91dC5yZXZlcnNlKCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBFdmVyeSBsaW5lIGFzIG9uZSByZXBsYWNlbWVudCDigJQgdGhlIGhvbmVzdCBhbnN3ZXIgd2hlbiBNeWVycyBnaXZlcyB1cC4gKi9cbmZ1bmN0aW9uIGNvYXJzZUxpbmVzKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IERpZmZMaW5lW10ge1xuICByZXR1cm4gW1xuICAgIC4uLmEubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJkZWxcIiBhcyBjb25zdCwgYTogaSwgdGV4dCB9KSksXG4gICAgLi4uYi5tYXAoKHRleHQsIGkpID0+ICh7IG9wOiBcImFkZFwiIGFzIGNvbnN0LCBiOiBpLCB0ZXh0IH0pKSxcbiAgXTtcbn1cblxuLyoqIEdyb3VwIHRoZSBsaW5lIG9wcyBpbnRvIGNvbnRpZ3VvdXMgaHVua3MsIG51bWJlcmVkIGZyb20gMS4gKi9cbmZ1bmN0aW9uIGNvbGxlY3QobGluZXM6IERpZmZMaW5lW10pOiBEaWZmSHVua1tdIHtcbiAgY29uc3QgaHVua3M6IERpZmZIdW5rW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBsZXQgaWQgPSAxO1xuICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCkge1xuICAgIGlmICgobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wID09PSBcInNhbWVcIikge1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHN0YXJ0ID0gaTtcbiAgICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCAmJiAobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wICE9PSBcInNhbWVcIikgaSsrO1xuICAgIGNvbnN0IHJ1biA9IGxpbmVzLnNsaWNlKHN0YXJ0LCBpKTtcbiAgICBjb25zdCBkZWwgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiKTtcbiAgICBjb25zdCBhZGQgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiKTtcbiAgICAvLyBXaGVyZSB0aGUgaHVuayBzaXRzIGluIGVhY2ggdGV4dDogdGhlIGluZGV4IG9mIHRoZSBmaXJzdCBsaW5lIGl0IHRvdWNoZXMsXG4gICAgLy8gYW5kIGZvciBhIHB1cmUgaW5zZXJ0aW9uLCB0aGUgcG9pbnQgaXQgaXMgaW5zZXJ0ZWQgQVQuXG4gICAgY29uc3QgYUZyb20gPSBkZWwubGVuZ3RoID8gKChkZWxbMF0gYXMgRGlmZkxpbmUpLmEgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYVwiKTtcbiAgICBjb25zdCBiRnJvbSA9IGFkZC5sZW5ndGggPyAoKGFkZFswXSBhcyBEaWZmTGluZSkuYiBhcyBudW1iZXIpIDogbmV4dEluZGV4KGxpbmVzLCBzdGFydCwgXCJiXCIpO1xuICAgIGh1bmtzLnB1c2goe1xuICAgICAgaWQ6IGlkKyssXG4gICAgICBhRnJvbSxcbiAgICAgIGFUbzogYUZyb20gKyBkZWwubGVuZ3RoLFxuICAgICAgYkZyb20sXG4gICAgICBiVG86IGJGcm9tICsgYWRkLmxlbmd0aCxcbiAgICAgIGRlbDogZGVsLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICAgIGFkZDogYWRkLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gaHVua3M7XG59XG5cbi8qKlxuICogVGhlIGluZGV4IGEgcHVyZSBpbnNlcnRpb24gb3IgZGVsZXRpb24gc2l0cyBhdDogdGhlIGxpbmUgbnVtYmVyIG9mIHRoZSBuZXh0XG4gKiBgc2FtZWAgbGluZSBvbiB0aGF0IHNpZGUsIG9yIHRoZSBlbmQgb2YgdGhhdCB0ZXh0IHdoZW4gdGhlcmUgaXMgbm9uZS5cbiAqL1xuZnVuY3Rpb24gbmV4dEluZGV4KGxpbmVzOiBEaWZmTGluZVtdLCBmcm9tOiBudW1iZXIsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBudW1iZXIge1xuICBmb3IgKGxldCBpID0gZnJvbTsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXQgPSAobGluZXNbaV0gYXMgRGlmZkxpbmUpW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYXQ7XG4gIH1cbiAgbGV0IGxhc3QgPSAtMTtcbiAgZm9yIChjb25zdCBsIG9mIGxpbmVzKSB7XG4gICAgY29uc3QgYXQgPSBsW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkICYmIGF0ID4gbGFzdCkgbGFzdCA9IGF0O1xuICB9XG4gIHJldHVybiBsYXN0ICsgMTtcbn1cblxuLyoqIFdvcmRzLCB3aGl0ZXNwYWNlIHJ1bnMgYW5kIHB1bmN0dWF0aW9uIHJ1bnMsIGtlcHQgc2VwYXJhdGUgc28gc3BhbnMgYWxpZ24uICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHMobGluZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gbGluZS5tYXRjaCgvXFxzK3xbXFxwe0x9XFxwe059X10rfFteXFxzXFxwe0x9XFxwe059X10rL2d1KSA/PyBbXTtcbn1cblxuLyoqIFRoZSB3b3JkLWxldmVsIGRpZmYgb2Ygb25lIGxpbmUgcGFpciwgYXMgc3BhbnMgb3ZlciBlYWNoIHNpZGUuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmaW5lKGJlZm9yZTogc3RyaW5nLCBhZnRlcjogc3RyaW5nKTogeyBkZWw6IERpZmZTcGFuW107IGFkZDogRGlmZlNwYW5bXSB9IHtcbiAgY29uc3QgYSA9IHdvcmRzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSB3b3JkcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgaWYgKCF0cmFjZSlcbiAgICByZXR1cm4geyBkZWw6IFt7IHRleHQ6IGJlZm9yZSwgY2hhbmdlZDogdHJ1ZSB9XSwgYWRkOiBbeyB0ZXh0OiBhZnRlciwgY2hhbmdlZDogdHJ1ZSB9XSB9O1xuICBjb25zdCBvcHMgPSBiYWNrdHJhY2soYSwgYiwgdHJhY2UpO1xuICBjb25zdCBkZWw6IERpZmZTcGFuW10gPSBbXTtcbiAgY29uc3QgYWRkOiBEaWZmU3BhbltdID0gW107XG4gIGZvciAoY29uc3Qgb3Agb2Ygb3BzKSB7XG4gICAgaWYgKG9wLm9wID09PSBcInNhbWVcIikge1xuICAgICAgcHVzaChkZWwsIG9wLnRleHQsIGZhbHNlKTtcbiAgICAgIHB1c2goYWRkLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgfSBlbHNlIGlmIChvcC5vcCA9PT0gXCJkZWxcIikgcHVzaChkZWwsIG9wLnRleHQsIHRydWUpO1xuICAgIGVsc2UgcHVzaChhZGQsIG9wLnRleHQsIHRydWUpO1xuICB9XG4gIHJldHVybiB7IGRlbCwgYWRkIH07XG59XG5cbi8qKiBBcHBlbmQsIG1lcmdpbmcgaW50byB0aGUgcHJldmlvdXMgc3BhbiB3aGVuIGl0IGNhcnJpZXMgdGhlIHNhbWUgdmVyZGljdC4gKi9cbmZ1bmN0aW9uIHB1c2goc3BhbnM6IERpZmZTcGFuW10sIHRleHQ6IHN0cmluZywgY2hhbmdlZDogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBsYXN0ID0gc3BhbnNbc3BhbnMubGVuZ3RoIC0gMV07XG4gIGlmIChsYXN0ICYmIGxhc3QuY2hhbmdlZCA9PT0gY2hhbmdlZCkgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2Ugc3BhbnMucHVzaCh7IHRleHQsIGNoYW5nZWQgfSk7XG59XG5cbi8qKlxuICogUmVmaW5lIGEgaHVuaydzIGxpbmVzIHdoZW4gdGhleSBjYW4gYmUgUEFJUkVELiBBIGh1bmsgcmVwbGFjaW5nIHRocmVlIGxpbmVzXG4gKiB3aXRoIHRocmVlIGlzIHBhaXJlZCBsaW5lIGJ5IGxpbmU7IGEgMS1mb3ItbWFueSBodW5rIGlzIG5vdCwgYW5kIGdldHMgbm9cbiAqIHNwYW5zIHJhdGhlciB0aGFuIGFuIGFyYml0cmFyeSBwYWlyaW5nIOKAlCBzaG93aW5nIGEgd29yZC1sZXZlbCBkaWZmIGFnYWluc3RcbiAqIHRoZSB3cm9uZyBsaW5lIGlzIHdvcnNlIHRoYW4gc2hvd2luZyBub25lLlxuICovXG5mdW5jdGlvbiByZWZpbmVIdW5rKGxpbmVzOiBEaWZmTGluZVtdLCBodW5rOiBEaWZmSHVuayk6IHZvaWQge1xuICBpZiAoaHVuay5kZWwubGVuZ3RoICE9PSBodW5rLmFkZC5sZW5ndGggfHwgaHVuay5kZWwubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGRlbHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiZGVsXCIgJiYgaW5SYW5nZShsLmEsIGh1bmsuYUZyb20sIGh1bmsuYVRvKSk7XG4gIGNvbnN0IGFkZHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiYWRkXCIgJiYgaW5SYW5nZShsLmIsIGh1bmsuYkZyb20sIGh1bmsuYlRvKSk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGVscy5sZW5ndGggJiYgaSA8IGFkZHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBkID0gZGVsc1tpXSBhcyBEaWZmTGluZTtcbiAgICBjb25zdCBhZCA9IGFkZHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgeyBkZWwsIGFkZCB9ID0gcmVmaW5lKGQudGV4dCwgYWQudGV4dCk7XG4gICAgZC5zcGFucyA9IGRlbDtcbiAgICBhZC5zcGFucyA9IGFkZDtcbiAgfVxufVxuXG5mdW5jdGlvbiBpblJhbmdlKGF0OiBudW1iZXIgfCB1bmRlZmluZWQsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+PSBmcm9tICYmIGF0IDwgdG87XG59XG5cbi8qKiBDb21wYXJlIHR3byB0ZXh0cyBieSBsaW5lLCByZWZpbmVkIGJ5IHdvcmQgaW5zaWRlIHBhaXJlZCBsaW5lcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmVGV4dChiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IERpZmYge1xuICBpZiAoYmVmb3JlID09PSBhZnRlcikge1xuICAgIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpLm1hcCgodGV4dCwgaSkgPT4gKHtcbiAgICAgIG9wOiBcInNhbWVcIiBhcyBjb25zdCxcbiAgICAgIGE6IGksXG4gICAgICBiOiBpLFxuICAgICAgdGV4dCxcbiAgICB9KSk7XG4gICAgcmV0dXJuIHsgbGluZXMsIGh1bmtzOiBbXSwgc2FtZTogdHJ1ZSwgY29hcnNlOiBmYWxzZSB9O1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKGFmdGVyKTtcbiAgY29uc3QgdHJhY2UgPSBteWVyc1RyYWNlKGEsIGIpO1xuICBjb25zdCBjb2Fyc2UgPSB0cmFjZSA9PT0gbnVsbDtcbiAgY29uc3QgbGluZXMgPSB0cmFjZSA/IGJhY2t0cmFjayhhLCBiLCB0cmFjZSkgOiBjb2Fyc2VMaW5lcyhhLCBiKTtcbiAgY29uc3QgaHVua3MgPSBjb2xsZWN0KGxpbmVzKTtcbiAgZm9yIChjb25zdCBoIG9mIGh1bmtzKSByZWZpbmVIdW5rKGxpbmVzLCBoKTtcbiAgcmV0dXJuIHsgbGluZXMsIGh1bmtzLCBzYW1lOiBmYWxzZSwgY29hcnNlIH07XG59XG5cbi8qKlxuICogVGFrZSBodW5rcyBmcm9tIHRoZSByaWdodCBzaWRlIGludG8gdGhlIGxlZnQuIGB0YWtlYCBpcyB0aGUgaWRzIHRvIGFwcGx5O1xuICogZXZlcnkgaHVuayBub3QgbmFtZWQgaXMgbGVmdCBhcyB0aGUgbGVmdCBzaWRlIGhhcyBpdC5cbiAqXG4gKiDim5QgQVBQTElFRCBCQUNLIFRPIEZST05ULCBzbyBhbiBlYXJsaWVyIGh1bmsncyBsaW5lIG51bWJlcnMgYXJlIHN0aWxsIHRoZVxuICogb25lcyB0aGUgZGlmZiByZXBvcnRlZCB3aGVuIGl0IGlzIHJlYWNoZWQuIEFwcGx5aW5nIGZyb250IHRvIGJhY2sgd291bGRcbiAqIHNoaWZ0IGV2ZXJ5IGxhdGVyIGh1bmsgYnkgdGhlIHNpemUgb2YgdGhlIGNoYW5nZSBqdXN0IG1hZGUg4oCUIHRoZSBjbGFzc2ljIHdheVxuICogYSBtdWx0aS1odW5rIG1lcmdlIGxhbmRzIGl0cyBsYXN0IGh1bmsgaW4gdGhlIHdyb25nIHBsYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlIdW5rcyhiZWZvcmU6IHN0cmluZywgaHVua3M6IERpZmZIdW5rW10sIHRha2U6IG51bWJlcltdKTogc3RyaW5nIHtcbiAgY29uc3Qgd2FudGVkID0gbmV3IFNldCh0YWtlKTtcbiAgY29uc3QgY2hvc2VuID0gaHVua3MuZmlsdGVyKChoKSA9PiB3YW50ZWQuaGFzKGguaWQpKS5zb3J0KCh4LCB5KSA9PiB5LmFGcm9tIC0geC5hRnJvbSk7XG4gIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBmb3IgKGNvbnN0IGggb2YgY2hvc2VuKSBsaW5lcy5zcGxpY2UoaC5hRnJvbSwgaC5hVG8gLSBoLmFGcm9tLCAuLi5oLmFkZCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogVW5pZmllZC1kaWZmIHRleHQsIGZvciB0aGUgYWdlbnQncyBgZGlmZmAgdmVyYi4gYGNvbnRleHRgIGxpbmVzIGVpdGhlciBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaWZpZWQoXG4gIGRpZmY6IERpZmYsXG4gIG9wdHM6IHsgZnJvbTogc3RyaW5nOyB0bzogc3RyaW5nOyBjb250ZXh0PzogbnVtYmVyIH0gPSB7IGZyb206IFwiYVwiLCB0bzogXCJiXCIgfSxcbik6IHN0cmluZyB7XG4gIGlmIChkaWZmLnNhbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBjb250ZXh0ID0gb3B0cy5jb250ZXh0ID8/IDM7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbYC0tLSAke29wdHMuZnJvbX1gLCBgKysrICR7b3B0cy50b31gXTtcbiAgLy8gSHVua3MgY2xvc2VyIHRvZ2V0aGVyIHRoYW4gMsOXIGNvbnRleHQgc2hhcmUgb25lIGhlYWRlciwgdGhlIHdheSBldmVyeVxuICAvLyBvdGhlciBkaWZmIHRvb2wgam9pbnMgdGhlbSDigJQgb3RoZXJ3aXNlIHRoZSBjb250ZXh0IGxpbmVzIHByaW50IHR3aWNlLlxuICBjb25zdCBncm91cHM6IERpZmZIdW5rW11bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGggb2YgZGlmZi5odW5rcykge1xuICAgIGNvbnN0IGxhc3QgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdO1xuICAgIGNvbnN0IHByZXYgPSBsYXN0Py5bbGFzdC5sZW5ndGggLSAxXTtcbiAgICBpZiAocHJldiAmJiBoLmFGcm9tIC0gcHJldi5hVG8gPD0gY29udGV4dCAqIDIpIChsYXN0IGFzIERpZmZIdW5rW10pLnB1c2goaCk7XG4gICAgZWxzZSBncm91cHMucHVzaChbaF0pO1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYVwiKSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYlwiKSk7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgY29uc3QgZmlyc3QgPSBncm91cFswXSBhcyBEaWZmSHVuaztcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBbZ3JvdXAubGVuZ3RoIC0gMV0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgYVN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYUZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBhRW5kID0gTWF0aC5taW4oYS5sZW5ndGgsIGxhc3QuYVRvICsgY29udGV4dCk7XG4gICAgY29uc3QgYlN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYkZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBiRW5kID0gTWF0aC5taW4oYi5sZW5ndGgsIGxhc3QuYlRvICsgY29udGV4dCk7XG4gICAgb3V0LnB1c2goYEBAIC0ke2FTdGFydCArIDF9LCR7YUVuZCAtIGFTdGFydH0gKyR7YlN0YXJ0ICsgMX0sJHtiRW5kIC0gYlN0YXJ0fSBAQGApO1xuICAgIGxldCBhdCA9IGFTdGFydDtcbiAgICBmb3IgKGNvbnN0IGggb2YgZ3JvdXApIHtcbiAgICAgIGZvciAoOyBhdCA8IGguYUZyb207IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBoLmRlbCkgb3V0LnB1c2goYC0ke2xpbmV9YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5hZGQpIG91dC5wdXNoKGArJHtsaW5lfWApO1xuICAgICAgYXQgPSBoLmFUbztcbiAgICB9XG4gICAgZm9yICg7IGF0IDwgYUVuZDsgYXQrKykgb3V0LnB1c2goYCAke2FbYXRdfWApO1xuICB9XG4gIHJldHVybiBgJHtvdXQuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG4vKiogUmVidWlsZCBvbmUgc2lkZSdzIHRleHQgZnJvbSB0aGUgbGluZSBvcHMg4oCUIHVzZWQgYnkgYHVuaWZpZWRgIGZvciBjb250ZXh0LiAqL1xuZnVuY3Rpb24gc2lkZVRleHQoZGlmZjogRGlmZiwgc2lkZTogXCJhXCIgfCBcImJcIik6IHN0cmluZyB7XG4gIGNvbnN0IHNraXAgPSBzaWRlID09PSBcImFcIiA/IFwiYWRkXCIgOiBcImRlbFwiO1xuICByZXR1cm4gZGlmZi5saW5lc1xuICAgIC5maWx0ZXIoKGwpID0+IGwub3AgIT09IHNraXApXG4gICAgLm1hcCgobCkgPT4gbC50ZXh0KVxuICAgIC5qb2luKFwiXFxuXCIpO1xufVxuIiwKICAgICIvLyBXaGF0IGlzIHdyb25nIHdpdGggdGhpcyBzZXNzaW9uLCBhbmQgdGhlIHZlcmIgdGhhdCBmaXhlcyBlYWNoIHRoaW5nIChFNjIpLlxuLy9cbi8vIOKblCBSRVBPUlRTLCBORVZFUiBSRVBBSVJTLiBTaWxlbnRseSBwcnVuaW5nIGEgZ2hvc3QgZW50cnkgd291bGQgdGhyb3cgYXdheSB0aGVcbi8vIGZhY3QgdGhhdCB0aGUgaHVtYW4gQVNLRUQgZm9yIHRoYXQgZmlsZSB0byBiZSBpbiB0aGVpciBjb250ZXh0IOKAlCBhbmQgaWYgaXRcbi8vIGNvbWVzIGJhY2sgZnJvbSBhIGBnaXQgY2hlY2tvdXRgLCB0aGV5IHdvdWxkIGhhdmUgdG8gbm90aWNlIGl0IGlzIG1pc3NpbmcgYW5kXG4vLyBhZGQgaXQgYWdhaW4uIFRoZSBzYW1lIGxvZ2ljIHByb3RlY3RzIGEgZG9jdW1lbnQgcmVjb3JkIHdob3NlIGZpbGUgaGFzIGdvbmU6XG4vLyB0aGUgc2Vzc2lvbiBpcyBzdGlsbCBob2xkaW5nIHZlcnNpb25zIHRoZSBodW1hbiBjYW4gc2F2ZSBiYWNrLCBzbyBmb3JnZXR0aW5nXG4vLyBpdCBmb3IgdGhlbSB3b3VsZCBiZSBkaXNjYXJkaW5nIGNvbnRlbnQgb24gdGhlaXIgYmVoYWxmLiBDb2xlIHJ1bGVkIGl0OlxuLy8gXCJyZXBvcnQsIG5hbWUgdGhlIHZlcmIsIGxldCB5b3UgZGVjaWRlLlwiXG4vL1xuLy8g4puUIEFORCBFVkVSWSBGSU5ESU5HIENBUlJJRVMgSVRTIFZFUkIuIEEgcmVwb3J0IHRoYXQgc2F5cyBcIjMgcHJvYmxlbXNcIiBhbmRcbi8vIGxlYXZlcyB5b3UgdG8gd29yayBvdXQgd2hhdCB0byB0eXBlIGlzIHRoZSBzaGFwZSB0aGlzIHNwZWxsIGtlZXBzIGZhaWxpbmcgYXRcbi8vIGFuZCBmaXhpbmcg4oCUIHRoZSBjb25mbGljdCBiYW5uZXIgd2l0aCBubyByb3V0ZSB0byB0aGUgY29tcGFyaXNvbiwgdGhlXG4vLyBcImdvbmUgZnJvbSBkaXNrXCIgbm90aWNlIHdpdGggbm8gd2F5IHRvIGFuc3dlciBpdC4gQSBmaW5kaW5nIHdpdGhvdXQgYSBmaXggaXNcbi8vIGhhbGYgYSBmaW5kaW5nLlxuLy9cbi8vIOKaoCBUSEUgQ0hFQ0tTIEFSRSBFVklERU5DRUQsIE5PVCBJTUFHSU5FRC4gRWFjaCBvbmUgaXMgYSBzdGF0ZSB0aGF0IGhhc1xuLy8gYWN0dWFsbHkgaGFwcGVuZWQgaGVyZTogYSByZWNvcmQgd2hvc2Ugb3JpZ2luYWwgd2FzIGRlbGV0ZWQgKEU2MCdzIHJlc2lkdWUsXG4vLyBhbmQgYW55IGRlbGV0ZSBpbiBGaW5kZXIpLCBhIGBsaXN0ZWRgIGNvbnRleHQgZW50cnkgcG9pbnRpbmcgYXQgbm90aGluZ1xuLy8gKG5ldmVyIHJlc2Nhbm5lZCDigJQgbWVhc3VyZWQsIGFuZCByZWFjaGFibGUgdG9kYXkgd2l0aCBubyBidWcgYXQgYWxsKSwgYW5kXG4vLyBsaW5rcyBhIHNldCBjYW5ub3QgYW5zd2VyIChFNTQpLiBOb3RoaW5nIGlzIGNoZWNrZWQgYmVjYXVzZSBpdCBzb3VuZGVkXG4vLyBwbGF1c2libGUuXG5cbi8qKiBPbmUgdGhpbmcgd29ydGggbG9va2luZyBhdCwgYW5kIHdoYXQgdG8gZG8gYWJvdXQgaXQuICovXG5leHBvcnQgdHlwZSBGaW5kaW5nID0ge1xuICBraW5kOiBcIm9yaWdpbmFsLm1pc3NpbmdcIiB8IFwiY29udGV4dC5naG9zdFwiIHwgXCJsaW5rcy5kYW5nbGluZ1wiO1xuICAvKiogV2hhdCBpdCBpcyBhYm91dDogYSBwYXRoLCBvciBhbiBlbnRyeSBpZC4gKi9cbiAgc3ViamVjdDogc3RyaW5nO1xuICAvKiogV2hhdCB0aGUgaHVtYW4gcmVhZHMuICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgLyoqIFdoYXQgdGhlIGFnZW50IHdvdWxkIHJ1biwgd2l0aCB0aGUgYXJndW1lbnQgYWxyZWFkeSBpbiBpdC4gKi9cbiAgZml4OiBzdHJpbmc7XG4gIC8qKiBIb3cgbWFueSBvZiBzb21ldGhpbmcgdGhlIGZpbmRpbmcgaXMgYWJvdXQsIHdoZW4gdGhhdCBpcyB0aGUgcG9pbnQuICovXG4gIGNvdW50PzogbnVtYmVyO1xufTtcblxuLyoqIFRoZSBmYWN0cyBhIGNoZWNrdXAgbmVlZHMsIGdhdGhlcmVkIGJ5IHdob2V2ZXIgY2FuIHRvdWNoIHRoZSBkaXNrLiAqL1xuZXhwb3J0IHR5cGUgQ2hlY2t1cCA9IHtcbiAgLyoqIEV2ZXJ5IGRvY3VtZW50IHJlY29yZCwgd2l0aCB3aGV0aGVyIGl0cyBmaWxlIG9mIHJlY29yZCBzdGlsbCBleGlzdHMuICovXG4gIGRvY3M6IHJlYWRvbmx5IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIG9yaWdpbmFsOiBzdHJpbmc7XG4gICAgZXhpc3RzOiBib29sZWFuO1xuICAgIHZlcnNpb25zOiBudW1iZXI7XG4gIH1bXTtcbiAgLyoqIEV2ZXJ5IGRvYyBub2RlIGluIGV2ZXJ5IGNvbnRleHQgZW50cnksIHdpdGggd2hldGhlciB0aGUgcGF0aCBleGlzdHMuICovXG4gIG5vZGVzOiByZWFkb25seSB7IGVudHJ5OiBzdHJpbmc7IHBhdGg6IHN0cmluZzsgc2hvd246IHN0cmluZzsgZXhpc3RzOiBib29sZWFuIH1bXTtcbiAgLyoqIERhbmdsaW5nIGxpbmsgY291bnRzIHBlciBtaXJyb3JlZCBlbnRyeS4gKi9cbiAgbGlua3M6IHJlYWRvbmx5IHsgZW50cnk6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGFuZ2xpbmc6IG51bWJlciB9W107XG59O1xuXG4vKipcbiAqIFNoYXBlIHRoZSBmYWN0cyBpbnRvIGZpbmRpbmdzLlxuICpcbiAqIFB1cmUgb24gcHVycG9zZTogdGhlIGZzIHJlYWRzIGJlbG9uZyB0byB0aGUgc2Vzc2lvbiwgYW5kIHdoYXQgY291bnRzIGFzIGFcbiAqIHByb2JsZW0g4oCUIGFuZCB3aGF0IHRvIHNheSBhYm91dCBpdCDigJQgaXMgdGhlIHBhcnQgd29ydGggcGlubmluZyB3aXRoIGNlbGxzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZGluZ3MoYzogQ2hlY2t1cCk6IEZpbmRpbmdbXSB7XG4gIGNvbnN0IG91dDogRmluZGluZ1tdID0gW107XG5cbiAgZm9yIChjb25zdCBkIG9mIGMuZG9jcykge1xuICAgIGlmIChkLmV4aXN0cykgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJvcmlnaW5hbC5taXNzaW5nXCIsXG4gICAgICBzdWJqZWN0OiBkLm9yaWdpbmFsLFxuICAgICAgbWVzc2FnZTogYCR7ZC5uYW1lfSBpcyBpbiB0aGlzIHNlc3Npb24gYnV0IGl0cyBmaWxlIGlzIGdvbmUgZnJvbSBkaXNrLiAke1xuICAgICAgICBkLnZlcnNpb25zID09PSAxID8gXCIxIHZlcnNpb24gaXNcIiA6IGAke2QudmVyc2lvbnN9IHZlcnNpb25zIGFyZWBcbiAgICAgIH0gc3RpbGwgaGVsZCBoZXJlIOKAlCBzYXZpbmcgd291bGQgcmVjcmVhdGUgdGhlIGZpbGUuYCxcbiAgICAgIGZpeDogYGZvcmdldCAtLWRvYyAke2Quc2x1Z31gLFxuICAgICAgY291bnQ6IGQudmVyc2lvbnMsXG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IG4gb2YgYy5ub2Rlcykge1xuICAgIGlmIChuLmV4aXN0cykgY29udGludWU7XG4gICAgLy8g4pqgIEEgcmVjb3JkIGFuZCBhbiBlbnRyeSBjYW4gcG9pbnQgYXQgdGhlIFNBTUUgbWlzc2luZyBwYXRoLCBhbmQgYm90aCBhcmVcbiAgICAvLyByZXBvcnRlZDogdGhleSBhcmUgdHdvIGRpZmZlcmVudCB0aGluZ3MgdG8gY2xlYW4gdXAsIHdpdGggdHdvIGRpZmZlcmVudFxuICAgIC8vIHZlcmJzLCBhbmQgbWVyZ2luZyB0aGVtIHdvdWxkIGxlYXZlIHdoaWNoZXZlciB0aGUgaHVtYW4gZGlkIG5vdCBkby5cbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcImNvbnRleHQuZ2hvc3RcIixcbiAgICAgIHN1YmplY3Q6IG4ucGF0aCxcbiAgICAgIG1lc3NhZ2U6IGAke24uc2hvd259IGlzIGluIHRoZSBjb250ZXh0IGJ1dCBub3Qgb24gZGlzay5gLFxuICAgICAgZml4OiBgaGlkZSAke24ucGF0aH1gLFxuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBsIG9mIGMubGlua3MpIHtcbiAgICBpZiAobC5kYW5nbGluZyA8PSAwKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcImxpbmtzLmRhbmdsaW5nXCIsXG4gICAgICBzdWJqZWN0OiBsLmVudHJ5LFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgbC5kYW5nbGluZyA9PT0gMVxuICAgICAgICAgID8gYCR7bC5sYWJlbH0gaGFzIDEgbGluayB0aGF0IGFuc3dlcnMgbm90aGluZy5gXG4gICAgICAgICAgOiBgJHtsLmxhYmVsfSBoYXMgJHtsLmRhbmdsaW5nfSBsaW5rcyB0aGF0IGFuc3dlciBub3RoaW5nLmAsXG4gICAgICBmaXg6IGBkYW5nbGluZyAtLWVudHJ5ICR7bC5lbnRyeX1gLFxuICAgICAgY291bnQ6IGwuZGFuZ2xpbmcsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIFRoZSBvbmUgbGluZSB0aGUgY2hhdCBnZXRzIGF0IHN0YXJ0dXAsIG9yIG51bGwgd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvIHNheS5cbiAqXG4gKiDim5QgT05FIExJTkUsIEFORCBTSUxFTkNFIFdIRU4gQ0xFQU4uIEEgY2hlY2sgdGhhdCBhbm5vdW5jZXMgaXRzZWxmIGV2ZXJ5IHRpbWVcbiAqIGl0IGZpbmRzIG5vdGhpbmcgdHJhaW5zIHRoZSByZWFkZXIgdG8gc2tpcCBpdCwgYW5kIHRoZW4gaXQgaXMgbm90IGEgY2hlY2sgYW55XG4gKiBtb3JlLiBUaGUgZGV0YWlsIGxpdmVzIGJlaGluZCB0aGUgdmVyYi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcnkobGlzdDogcmVhZG9ubHkgRmluZGluZ1tdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChsaXN0Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIC8vIOKaoCBDb3VudGVkIGJ5IEtJTkQgcmF0aGVyIHRoYW4gZGVzY3JpYmVkLCBiZWNhdXNlIGEgc2VudGVuY2UgdGhhdCB0cmllcyB0b1xuICAvLyBuYW1lIHRocmVlIGNhdGVnb3JpZXMgaW4gb25lIGJyZWF0aCByZWFkcyB3b3JzZSB0aGFuIHRoZSBudW1iZXJzIGRvLlxuICBjb25zdCBieUtpbmQgPSBuZXcgTWFwPEZpbmRpbmdbXCJraW5kXCJdLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgZiBvZiBsaXN0KSBieUtpbmQuc2V0KGYua2luZCwgKGJ5S2luZC5nZXQoZi5raW5kKSA/PyAwKSArIDEpO1xuICAvLyDimqAgQk9USCBGT1JNUyBXUklUVEVOIE9VVC4gQXBwZW5kaW5nIFwic1wiIHByb2R1Y2VkIFwiZ2hvc3QgaW4gdGhlIGNvbnRleHRzXCIsXG4gIC8vIHdoaWNoIGlzIHRoZSBraW5kIG9mIHNtYWxsIHdyb25nbmVzcyB0aGF0IG1ha2VzIGEgdG9vbCByZWFkIGFzIGNhcmVsZXNzLlxuICBjb25zdCBsYWJlbDogUmVjb3JkPEZpbmRpbmdbXCJraW5kXCJdLCBbb25lOiBzdHJpbmcsIG1hbnk6IHN0cmluZ10+ID0ge1xuICAgIFwib3JpZ2luYWwubWlzc2luZ1wiOiBbXCJtaXNzaW5nIGZpbGVcIiwgXCJtaXNzaW5nIGZpbGVzXCJdLFxuICAgIFwiY29udGV4dC5naG9zdFwiOiBbXCJnaG9zdCBpbiB0aGUgY29udGV4dFwiLCBcImdob3N0cyBpbiB0aGUgY29udGV4dFwiXSxcbiAgICBcImxpbmtzLmRhbmdsaW5nXCI6IFtcInNldCB3aXRoIGRhbmdsaW5nIGxpbmtzXCIsIFwic2V0cyB3aXRoIGRhbmdsaW5nIGxpbmtzXCJdLFxuICB9O1xuICBjb25zdCBwYXJ0cyA9IFsuLi5ieUtpbmRdLm1hcCgoW2tpbmQsIG5dKSA9PiBgJHtufSAke2xhYmVsW2tpbmRdW24gPT09IDEgPyAwIDogMV19YCk7XG4gIHJldHVybiBgU3RhcnR1cCBjaGVjazogJHtwYXJ0cy5qb2luKFwiLCBcIil9IOKAlCBydW4gXFxgZG9jdG9yXFxgIGZvciB0aGUgZGV0YWlsLmA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvLyBVbmRvIGFuZCByZWRvIGZvciB0aGUgQ09OVEVYVCDigJQgbW92aW5nIHRoaW5ncyBhcm91bmQsIGFkZGluZywgaGlkaW5nIChFNjApLlxuLy9cbi8vIOKblCBUSElTIElTIE5PVCBUSEUgRURJVE9SJ1MgVU5ETywgYW5kIHRoZSBzdXJmYWNlIHNheXMgc28gYnkgcHV0dGluZyB0aGVzZVxuLy8gYXJyb3dzIGluIHRoZSBjb250ZXh0IGhlYWRlciByYXRoZXIgdGhhbiBhbnl3aGVyZSBuZWFyIHRoZSB0ZXh0LiBDb2RlTWlycm9yJ3Ncbi8vIGhpc3Rvcnkgb3ducyBrZXlzdHJva2VzIGluc2lkZSBhIGRvY3VtZW50OyB0aGlzIG93bnMgYWN0cyBvbiB0aGUgU0hBUEUgb2YgdGhlXG4vLyBjb250ZXh0LCB3aGljaCBpcyB0aGUgdGhpbmcgdGhhdCBoYWQgbm8gd2F5IGJhY2sgYXQgYWxsLiBDb2xlOiBcImxldHRpbmcgdGhlXG4vLyB1c2VyIGtub3cgdGhhdCB0aGVyZSdzIGFuIHVuZG8gZm9yIHRoaXMgc2lkZWJhciB0aGF0IGlzbid0IHRoZSBzYW1lIGFzIHVuZG9cbi8vIHJlZG8gd2hlbiB5b3UncmUgaW4gdGhlIGVkaXRvci5cIlxuLy9cbi8vIOKblCBVTkRPSU5HIEEgQ1JFQVRJT04gREVMRVRFUywgQlVUIE9OTFkgQkVISU5EIEEgQ09ORklSTUFUSU9OLiBUaGlzIHN0YXJ0ZWQgYXNcbi8vIGEgaGFyZCBibG9jayDigJQgdW5kbyBuZXZlciBkZWxldGVzIOKAlCBhbmQgQ29sZSBwdXNoZWQgYmFjaywgY29ycmVjdGx5OiBibG9ja2luZ1xuLy8gZG9lcyBub3QgcmVmdXNlIG9uZSBzdGVwLCBpdCBTVFJBTkRTIEVWRVJZVEhJTkcgQkVISU5EIElULiBDcmVhdGUgYSBmb2xkZXIsIGRvXG4vLyB0d28gbW92ZXMsIGFuZCB5b3UgY2FuIHVuZG8gdGhlIG1vdmVzIGFuZCB0aGVuIG1lZXQgYSB3YWxsIHlvdSBjYW4gbmV2ZXJcbi8vIHBhc3MsIGF0IHdoaWNoIHBvaW50IHRoZSBoaXN0b3J5IGhhcyBzdG9wcGVkIGJlaW5nIGEgaGlzdG9yeS4gQW5kIHRoZSB0aGluZ1xuLy8gdW5kbyB3b3VsZCByZW1vdmUgaXMgb25lIHRoZSBzZXNzaW9uIGl0c2VsZiBtYWRlIG1vbWVudHMgYWdvLCB1c3VhbGx5IGVtcHR5IOKAlFxuLy8gY2F0ZWdvcmljYWxseSBkaWZmZXJlbnQgZnJvbSBkZWxldGluZyB3b3JrLCBhbmQgdGhlIGFwcCBhbHJlYWR5IGhhcyB0aGVcbi8vIHBhdHRlcm4gZm9yIGl0IGluIHRoZSB2ZXJzaW9uLWRlbGV0ZSBkaWFsb2cuIFNvIHRoZSBhcnJvdyBzdGF5cyBlbmFibGVkIGFuZFxuLy8gdGhlIENPTkZJUk1BVElPTiBpcyB0aGUgZ2F0ZS5cbi8vXG4vLyDim5QgV0lUSCBPTkUgSEFSRCBMSU1JVCBUSEFUIElTIE5PVCBORUdPVElBQkxFIEJZIERJQUxPRzogYSBOT04tRU1QVFkgZm9sZGVyIGlzXG4vLyByZWZ1c2VkIG91dHJpZ2h0LiBVbmRvIHdvcmtzIGJhY2t3YXJkcywgc28gaXQgZW1wdGllcyBhIGZvbGRlciBiZWZvcmUgaXRcbi8vIHJlYWNoZXMgdGhhdCBmb2xkZXIncyBjcmVhdGlvbjsgaWYgdGhlIGZvbGRlciBzdGlsbCBoYXMgY29udGVudHMsIHNvbWV0aGluZ1xuLy8gcHV0IHRoZW0gdGhlcmUgdGhhdCB0aGlzIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGFcbi8vIGRpcmVjdG9yeSB0cmVlIGlzIGEgZGlmZmVyZW50IGFjdCBmcm9tIHJlbW92aW5nIHRoZSBlbXB0eSB0aGluZyB5b3UganVzdFxuLy8gbWFkZS4gVGhhdCBjYXNlIHN0b3BzIGFuZCBzYXlzIHdoeS5cbi8vXG4vLyDimqAgVEhFIElOVkVSU0UgSVMgQlVJTFQgV0hFTiBUSEUgQUNUIEhBUFBFTlMsIGZyb20gd2hhdCB3YXMgYWN0dWFsbHkgdHJ1ZVxuLy8gdGhlbiDigJQgbm90IHJlY29uc3RydWN0ZWQgbGF0ZXIgZnJvbSB0aGUgb3AuIEEgYG1vdmVgIHJlY29yZHMgd2hlcmUgdGhlIHRoaW5nXG4vLyBDQU1FIGZyb20gYmVjYXVzZSBvbmx5IHRoZSBtb3ZlciBrbm93czsgYSBgaGlkZWAgcmVjb3JkcyB0aGUgZW50cnkncyB3aG9sZVxuLy8gaGlkZGVuIGxpc3QgYmVjYXVzZSB0aGF0IGlzIHdoYXQgcmVzdG9yZXMgaXQgZXhhY3RseSwgaW5jbHVkaW5nIHRoZSBjYXNlXG4vLyB3aGVyZSBoaWRpbmcgcmVtb3ZlZCBhIHNpbmdsZS1kb2N1bWVudCBlbnRyeSBvdXRyaWdodC5cbmltcG9ydCB0eXBlIHsgU3RydWN0dXJlT3AgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIEhvdyB0byBwdXQgb25lIGFjdCBiYWNrLiBFYWNoIHZhcmlhbnQgaXMgc29tZXRoaW5nIHRoZSBzZXNzaW9uIGNhbiBhbHJlYWR5XG4gKiBkbywgc28gdW5kbyBpbnRyb2R1Y2VzIG5vIG5ldyB3YXkgdG8gY2hhbmdlIHRoZSB3b3JsZCDigJQgaXQgb25seSByZXBsYXlzIHRoZVxuICogZXhpc3Rpbmcgb25lcyB3aXRoIHJlY29yZGVkIGFyZ3VtZW50cy5cbiAqL1xuZXhwb3J0IHR5cGUgSW52ZXJzZSA9XG4gIHwgeyBraW5kOiBcIm1vdmVcIjsgcGF0aDogc3RyaW5nOyBpbnRvOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJyZW5hbWVcIjsgcGF0aDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVxuICAvKiogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSB0aGVzZSByZWxhdGl2ZSBwYXRocy4gKi9cbiAgfCB7IGtpbmQ6IFwiaGlkZGVuXCI7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH1cbiAgLyoqIFB1dCBhIHdob2xlIGRvY3VtZW50IG9yIGZvbGRlciBiYWNrIGluIHRoZSBjb250ZXh0LiAqL1xuICB8IHsga2luZDogXCJjb250ZXh0LmFkZFwiOyBwYXRoOiBzdHJpbmcgfVxuICAvKiogVGFrZSBhIGNvbnRleHQgZW50cnkgYmFjayBvdXQgKHRoZSBpbnZlcnNlIG9mIHB1dHRpbmcgb25lIGluKS4gKi9cbiAgfCB7IGtpbmQ6IFwiY29udGV4dC5yZW1vdmVcIjsgZW50cnk6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIndvcmtzcGFjZVwiOyBwYXRoOiBzdHJpbmcgfVxuICAvKipcbiAgICogUmVtb3ZlIHdoYXQgdGhlIGFjdCBjcmVhdGVkLiBgZGlyYCBkZWNpZGVzIGJvdGggdGhlIGRpYWxvZydzIHdvcmRzIGFuZCB0aGVcbiAgICogZW1wdGluZXNzIHJ1bGUg4oCUIGEgZmlsZSBpcyBjb25maXJtZWQsIGEgZm9sZGVyIGlzIGNvbmZpcm1lZCBBTkQgbXVzdCBiZVxuICAgKiBlbXB0eS5cbiAgICovXG4gIHwgeyBraW5kOiBcImRlbGV0ZVwiOyBwYXRoOiBzdHJpbmc7IGRpcjogYm9vbGVhbiB9O1xuXG4vKiogT25lIGFjdCwgd2l0aCB0aGUgd2F5IGJhY2sgYW5kIGEgc2VudGVuY2UgZm9yIHRoZSBhcnJvdydzIHRvb2x0aXAuICovXG5leHBvcnQgdHlwZSBBY3QgPSB7XG4gIC8qKiBXaGF0IGhhcHBlbmVkLCBmb3IgdGhlIHRvb2x0aXA6IFwibW92ZWQgbm90ZS5tZCBpbnRvIGRyYWZ0c1wiLiAqL1xuICBsYWJlbDogc3RyaW5nO1xuICBpbnZlcnNlOiBJbnZlcnNlO1xufTtcblxuLyoqXG4gKiBXaGF0IHRoZSBzZXNzaW9uIGtuZXcgYmVmb3JlIHRoZSBhY3Qg4oCUIHRoZSBwYXJ0cyBhbiBpbnZlcnNlIG1heSBuZWVkLlxuICpcbiAqIOKaoCBQYXNzZWQgaW4gcmF0aGVyIHRoYW4gcmVhZCBiYWNrIGFmdGVyd2FyZHMsIGJlY2F1c2UgZXZlcnkgZmllbGQgaGVyZSBpc1xuICogc29tZXRoaW5nIHRoZSBhY3QgaXRzZWxmIENIQU5HRVMuIFJlYWRpbmcgYGhpZGRlbmAgYWZ0ZXIgYSBoaWRlIHJldHVybnMgdGhlXG4gKiBsaXN0IGluY2x1ZGluZyB0aGUgdGhpbmcganVzdCBoaWRkZW4sIHdoaWNoIHJlc3RvcmVzIG5vdGhpbmcuXG4gKi9cbmV4cG9ydCB0eXBlIEJlZm9yZSA9IHtcbiAgLyoqIFRoZSBlbnRyeSdzIGhpZGRlbiBsaXN0IGJlZm9yZSB0aGUgYWN0LCB3aGVuIHRoZSBhY3QgdG91Y2hlZCBvbmUuICovXG4gIGhpZGRlbj86IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfTtcbiAgLyoqIFRoZSB3b3Jrc3BhY2UgYmVmb3JlIHRoZSBhY3QuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBXaGF0IHRoZSBhY3QgcmV0dXJuZWQg4oCUIHRoZSBzZXNzaW9uJ3Mgb3duIHJlc3VsdCwgbmFycm93ZWQgdG8gd2hhdCB3ZSB1c2UuICovXG5leHBvcnQgdHlwZSBBZnRlciA9IHtcbiAgcGF0aD86IHN0cmluZztcbiAgLyoqIFdoZXJlIGEgbW92ZSBvciByZW5hbWUgY2FtZSBGUk9NLiAqL1xuICBmcm9tPzogc3RyaW5nO1xuICAvKiogVGhlIGZvbGRlciBgc2V0Lm1ha2VgIGNyZWF0ZWQuICovXG4gIGZvbGRlcj86IHN0cmluZztcbiAgLyoqIFRoZSBlbnRyeSBhIGhpZGUgdG91Y2hlZCwgYW5kIHdoZXRoZXIgaXQgcmVtb3ZlZCB0aGF0IGVudHJ5IGVudGlyZWx5LiAqL1xuICBlbnRyeT86IHN0cmluZztcbiAgcmVtb3ZlZEVudHJ5PzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IGJhc2UgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHAuc3BsaXQoXCIvXCIpLnBvcCgpID8/IHA7XG5jb25zdCBwYXJlbnQgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHAuc2xpY2UoMCwgTWF0aC5tYXgoMCwgcC5sYXN0SW5kZXhPZihcIi9cIikpKSB8fCBcIi9cIjtcblxuLyoqXG4gKiBUaGUgd2F5IGJhY2sgZnJvbSBvbmUgYWN0LlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYW4gYWN0IG5vdCB3b3J0aCBhIGhpc3RvcnkgZW50cnkgYXQgYWxsIOKAlCBgdW5oaWRlYCBvbiBhblxuICogZW50cnkgdGhhdCBoYWQgbm90aGluZyBoaWRkZW4gY2hhbmdlZCBub3RoaW5nLCBhbmQgYW4gdW5kbyBhcnJvdyB0aGF0IHN0ZXBzXG4gKiBvdmVyIG5vLW9wcyBpcyBhbiBhcnJvdyB0aGF0IGxpZXMgYWJvdXQgaG93IGZhciBiYWNrIGl0IGNhbiBnby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5JbnZlcnNlKG9wOiBTdHJ1Y3R1cmVPcCwgYWZ0ZXI6IEFmdGVyLCBiZWZvcmU6IEJlZm9yZSk6IEFjdCB8IG51bGwge1xuICBzd2l0Y2ggKG9wLnR5cGUpIHtcbiAgICAvLyDilIDilIAgYnJvdWdodCBzb21ldGhpbmcgaW50byBleGlzdGVuY2U6IG5vIGludmVyc2UgdGhhdCBkb2VzIG5vdCBkZWxldGUg4pSA4pSAXG4gICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY3JlYXRlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiBmYWxzZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjcmVhdGVkIHRoZSBmb2xkZXIgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogdHJ1ZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNvcGllZCBpbiAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiBmYWxzZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwic2V0Lm1ha2VcIjpcbiAgICAgIC8vIOKaoCBUSEUgRk9MREVSIElTIFRIRSBUSElORyBUTyBVTkRPLCBub3QgdGhlIG1vdmUgaW5zaWRlIGl0LiBgc2V0Lm1ha2VgXG4gICAgICAvLyBjcmVhdGVzIGEgZm9sZGVyIGFuZCBtb3ZlcyB0aGUgZG9jdW1lbnQgaW4sIHNvIHRoZSBpbnZlcnNlIGlzIHRvXG4gICAgICAvLyByZW1vdmUgdGhlIGZvbGRlciDigJQgd2hpY2ggdGhlIGVtcHRpbmVzcyBydWxlIHdpbGwgcmVmdXNlIHdoaWxlIHRoZVxuICAgICAgLy8gZG9jdW1lbnQgaXMgc3RpbGwgaW4gdGhlcmUuIFRoYXQgcmVmdXNhbCBpcyBjb3JyZWN0IGFuZCByZWFkYWJsZVxuICAgICAgLy8gKFwidGhlIGZvbGRlciBpcyBub3QgZW1wdHlcIiksIGFuZCB0aGUgd2F5IHRocm91Z2ggaXQgaXMgdG8gbW92ZSB0aGVcbiAgICAgIC8vIGRvY3VtZW50IG91dCBmaXJzdCwgd2hpY2ggaXMgaXRzZWxmIGFuIHVuZG9hYmxlIGFjdC5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgdHVybmVkICR7YmFzZShvcC5wYXRoKX0gaW50byBhIHNldGAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIuZm9sZGVyID8/IFwiXCIsIGRpcjogdHJ1ZSB9LFxuICAgICAgfTtcblxuICAgIC8vIOKUgOKUgCByZXZlcnNpYmxlLCB3aXRoIGFyZ3VtZW50cyBvbmx5IHRoZSBhY3Qga25ldyDilIDilIBcbiAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICBpZiAoYWZ0ZXIucGF0aCA9PT0gdW5kZWZpbmVkIHx8IGFmdGVyLmZyb20gPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYG1vdmVkICR7YmFzZShhZnRlci5mcm9tKX0gaW50byAke2Jhc2UocGFyZW50KGFmdGVyLnBhdGgpKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwibW92ZVwiLCBwYXRoOiBhZnRlci5wYXRoLCBpbnRvOiBwYXJlbnQoYWZ0ZXIuZnJvbSkgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJyZW5hbWVcIjoge1xuICAgICAgaWYgKGFmdGVyLnBhdGggPT09IHVuZGVmaW5lZCB8fCBhZnRlci5mcm9tID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGByZW5hbWVkICR7YmFzZShhZnRlci5mcm9tKX0gdG8gJHtiYXNlKGFmdGVyLnBhdGgpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJyZW5hbWVcIiwgcGF0aDogYWZ0ZXIucGF0aCwgbmFtZTogYmFzZShhZnRlci5mcm9tKSB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgLy8gVHdvIHNoYXBlczogaGlkaW5nIG9uZSBpdGVtIGluc2lkZSBhIHNldCwgb3IgaGlkaW5nIGEgc2luZ2xlLWRvY3VtZW50XG4gICAgICAvLyBlbnRyeSwgd2hpY2ggcmVtb3ZlcyB0aGUgZW50cnkgb3V0cmlnaHQuXG4gICAgICBpZiAoYWZ0ZXIucmVtb3ZlZEVudHJ5KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGByZW1vdmVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfSBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjb25zdCBoYWQgPSBiZWZvcmUuaGlkZGVuO1xuICAgICAgaWYgKCFoYWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGByZW1vdmVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfSBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImhpZGRlblwiLCBlbnRyeTogaGFkLmVudHJ5LCByZWxzOiBoYWQucmVscyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICBjb25zdCBoYWQgPSBiZWZvcmUuaGlkZGVuO1xuICAgICAgLy8gTm90aGluZyB3YXMgaGlkZGVuLCBzbyBub3RoaW5nIGhhcHBlbmVkOiBub3QgaGlzdG9yeS5cbiAgICAgIGlmICghaGFkIHx8IGhhZC5yZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGJyb3VnaHQgYmFjayAke2hhZC5yZWxzLmxlbmd0aH0gaGlkZGVuIGl0ZW0ke2hhZC5yZWxzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiBoYWQuZW50cnksIHJlbHM6IGhhZC5yZWxzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwid29ya3NwYWNlLnNldFwiOiB7XG4gICAgICBjb25zdCB3YXMgPSBiZWZvcmUud29ya3NwYWNlO1xuICAgICAgaWYgKHdhcyA9PT0gdW5kZWZpbmVkIHx8IHdhcyA9PT0gYWZ0ZXIucGF0aCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHNldCB0aGUgd29ya3NwYWNlIHRvICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJ3b3Jrc3BhY2VcIiwgcGF0aDogd2FzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxufVxuXG4vKiogV2hhdCB0aGUgYXJyb3dzIG5lZWQgdG8ga25vdywgYW5kIG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCB0eXBlIEhpc3RvcnlWaWV3ID0ge1xuICBjYW5VbmRvOiBib29sZWFuO1xuICBjYW5SZWRvOiBib29sZWFuO1xuICAvKiogXCJtb3ZlZCBub3RlLm1kIGludG8gZHJhZnRzXCIsIGZvciB0aGUgdG9vbHRpcC4gKi9cbiAgdW5kb0xhYmVsPzogc3RyaW5nO1xuICByZWRvTGFiZWw/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBTZXQgd2hlbiB0aGUgbmV4dCB1bmRvIHdvdWxkIERFTEVURSBzb21ldGhpbmcsIHNvIHRoZSBzdXJmYWNlIGNhbiByYWlzZSBhXG4gICAqIGNvbmZpcm1hdGlvbiBiZWZvcmUgc2VuZGluZyBpdC4gUHJlc2VudCBtZWFucyBcImFzayBmaXJzdFwiLCBub3QgXCJyZWZ1c2VcIi5cbiAgICovXG4gIHVuZG9EZWxldGVzPzogeyBwYXRoOiBzdHJpbmc7IGRpcjogYm9vbGVhbiB9O1xufTtcblxuLyoqXG4gKiBUaGUgdHdvIHN0YWNrcy5cbiAqXG4gKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBhbmQgdGhhdCBpcyBhIGRlY2lzaW9uIHJhdGhlciB0aGFuXG4gKiBsYXppbmVzczogYW4gaW52ZXJzZSByZWNvcmRlZCBub3cgZGVzY3JpYmVzIHRoZSB3b3JsZCBhcyBpdCBpcyBub3csIGFuZCBhXG4gKiBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGEgZmlsZSBzb21lYm9keSBoYXMgc2luY2UgbW92ZWQgYnkgaGFuZC5cbiAqIE9mZmVyaW5nIGFuIHVuZG8gd2hvc2UgYXJndW1lbnRzIGhhdmUgZ29uZSBzdGFsZSBpcyB3b3JzZSB0aGFuIHN0YXJ0aW5nIGVhY2hcbiAqIHNlc3Npb24gd2l0aCBhbiBlbXB0eSBoaXN0b3J5IOKAlCBzbyB0aGUgYXJyb3dzIGFyZSBncmV5IGFmdGVyIGEgcmVzdG9yZSwgd2hpY2hcbiAqIGlzIGhvbmVzdCBhYm91dCB3aGF0IGNhbiBzdGlsbCBiZSBwdXQgYmFjay5cbiAqL1xuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICBwcml2YXRlIHVuZG9zOiBBY3RbXSA9IFtdO1xuICBwcml2YXRlIHJlZG9zOiBBY3RbXSA9IFtdO1xuXG4gIC8qKiBSZWNvcmQgYW4gYWN0LiBBIG5ldyBhY3QgbWFrZXMgdGhlIHJlZG8gc3RhY2sgbWVhbmluZ2xlc3MuICovXG4gIGRpZChhY3Q6IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIHRoaXMudW5kb3MucHVzaChhY3QpO1xuICAgIHRoaXMucmVkb3MgPSBbXTtcbiAgfVxuXG4gIC8qKiBXaGF0IHRoZSBuZXh0IHVuZG8gd291bGQgZG8sIHdpdGhvdXQgZG9pbmcgaXQuICovXG4gIHBlZWtVbmRvKCk6IEFjdCB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnVuZG9zW3RoaXMudW5kb3MubGVuZ3RoIC0gMV0gPz8gbnVsbDtcbiAgfVxuXG4gIHBlZWtSZWRvKCk6IEFjdCB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnJlZG9zW3RoaXMucmVkb3MubGVuZ3RoIC0gMV0gPz8gbnVsbDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIHRoZSBuZXh0IHVuZG8sIGhhdmluZyBhcHBsaWVkIGl0LiBgcmVkb2AgaXMgdGhlIGFjdCB0aGF0IHdvdWxkIHB1dCBpdFxuICAgKiBiYWNrIOKAlCBidWlsdCBieSB0aGUgY2FsbGVyLCBiZWNhdXNlIG9ubHkgdGhlIGNhbGxlciBrbm93cyB3aGF0IGl0cyBvd25cbiAgICogaW52ZXJzZSBwcm9kdWNlZC5cbiAgICovXG4gIHRvb2tVbmRvKHJlZG86IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBjb25zdCBhY3QgPSB0aGlzLnVuZG9zLnBvcCgpO1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgaWYgKHJlZG8pIHRoaXMucmVkb3MucHVzaChyZWRvKTtcbiAgfVxuXG4gIHRvb2tSZWRvKHVuZG86IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBjb25zdCBhY3QgPSB0aGlzLnJlZG9zLnBvcCgpO1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgaWYgKHVuZG8pIHRoaXMudW5kb3MucHVzaCh1bmRvKTtcbiAgfVxuXG4gIHZpZXcoKTogSGlzdG9yeVZpZXcge1xuICAgIGNvbnN0IHVuZG8gPSB0aGlzLnBlZWtVbmRvKCk7XG4gICAgY29uc3QgcmVkbyA9IHRoaXMucGVla1JlZG8oKTtcbiAgICBjb25zdCBkZWxldGVzID0gdW5kbz8uaW52ZXJzZS5raW5kID09PSBcImRlbGV0ZVwiID8gdW5kby5pbnZlcnNlIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiB7XG4gICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIElTIFNUSUxMIFVORE9BQkxFIOKAlCB0aGUgZ2F0ZSBpcyB0aGUgZGlhbG9nLCBub3QgdGhlXG4gICAgICAvLyBkaXNhYmxlZCBzdGF0ZSAoQ29sZSdzIHJ1bGluZywgcmV2ZXJzaW5nIGFuIGVhcmxpZXIgZGVzaWduIHRoYXRcbiAgICAgIC8vIHN0cmFuZGVkIGV2ZXJ5IGFjdCBiZWhpbmQgYSBjcmVhdGlvbikuXG4gICAgICBjYW5VbmRvOiB1bmRvICE9PSBudWxsLFxuICAgICAgY2FuUmVkbzogcmVkbyAhPT0gbnVsbCxcbiAgICAgIC4uLih1bmRvID8geyB1bmRvTGFiZWw6IHVuZG8ubGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihyZWRvID8geyByZWRvTGFiZWw6IHJlZG8ubGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihkZWxldGVzID8geyB1bmRvRGVsZXRlczogeyBwYXRoOiBkZWxldGVzLnBhdGgsIGRpcjogZGVsZXRlcy5kaXIgfSB9IDoge30pLFxuICAgIH07XG4gIH1cblxuICAvKiogSG93IGRlZXAgdGhlIHN0YWNrcyBhcmUg4oCUIGZvciB0ZXN0cyBhbmQgZm9yIGBzdGF0ZSAtLWZ1bGxgLiAqL1xuICBkZXB0aCgpOiB7IHVuZG86IG51bWJlcjsgcmVkbzogbnVtYmVyIH0ge1xuICAgIHJldHVybiB7IHVuZG86IHRoaXMudW5kb3MubGVuZ3RoLCByZWRvOiB0aGlzLnJlZG9zLmxlbmd0aCB9O1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIE5BVElWRSBmaWxlIHBpY2tlciDigJQgdGhlIGFmZm9yZGFuY2UgYSB3ZWIgcGFnZSBjYW5ub3QgaGF2ZS5cbiAqXG4gKiBBIGJyb3dzZXIncyBvd24gYDxpbnB1dCB0eXBlPVwiZmlsZVwiPmAgYW5kIGBzaG93T3BlbkZpbGVQaWNrZXIoKWAgYm90aCBoYW5kXG4gKiBiYWNrIGZpbGUgQ09OVEVOVCBhbmQgYSBuYW1lLCBuZXZlciBhIHBhdGggKGFuZCBCcmF2ZSwgQ29sZSdzIGJyb3dzZXIsXG4gKiBkaXNhYmxlcyB0aGUgRmlsZSBTeXN0ZW0gQWNjZXNzIEFQSSBvdXRyaWdodCkuIEEgY29weSBpcyBhbGwgYSBwYWdlIGNhbiBkb1xuICogd2l0aCB0aGF0LCB3aGljaCBpcyBleGFjdGx5IHdoYXQgYSBkcm9wIGFscmVhZHkgZG9lcyAoRTIzKS4gQnV0IHNjcmlwdG9yaXVtJ3NcbiAqIGRhZW1vbiBpcyBhIExPQ0FMIFBST0NFU1M6IGl0IGNhbiBhc2sgdGhlIE9TIGZvciBpdHMgb3duIG9wZW4gZGlhbG9nIGFuZCBnZXRcbiAqIGJhY2sgYSByZWFsIGZpbGVzeXN0ZW0gcGF0aCDigJQgc28gXCJDaG9vc2XigKZcIiBsaW5rcyB0aGUgcmVhbCBmaWxlIChFMSkgaW5zdGVhZFxuICogb2YgY29weWluZyBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGhlcmUgaXMgcHVyZTogd2hpY2ggYXJndiB0byBydW4sIGFuZCBob3cgdG8gcmVhZCB3aGF0IGl0IHByaW50ZWQuXG4gKiBUaGUgc3Bhd25pbmcgKGFuZCB0aGUgb25lLWF0LWEtdGltZSBydWxlKSBpcyB0aGUgZGFlbW9uJ3MuXG4gKi9cblxuZXhwb3J0IHR5cGUgUGlja0tpbmQgPSBcImZpbGVcIiB8IFwiZm9sZGVyXCI7XG5cbi8qKiBBbiBBcHBsZVNjcmlwdCB0aGF0IHB1dHMgb25lIFBPU0lYIHBhdGggcGVyIGxpbmUgb24gc3Rkb3V0LiAqL1xuZnVuY3Rpb24gYXBwbGVTY3JpcHQoa2luZDogUGlja0tpbmQsIHByb21wdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcXVvdGVkID0gcHJvbXB0LnJlcGxhY2UoL1tcIlxcXFxdL2csIFwiXCIpO1xuICBjb25zdCBjaG9vc2UgPVxuICAgIGtpbmQgPT09IFwiZmlsZVwiXG4gICAgICA/IGBjaG9vc2UgZmlsZSB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwiIHdpdGggbXVsdGlwbGUgc2VsZWN0aW9ucyBhbGxvd2VkYFxuICAgICAgOiBge2Nob29zZSBmb2xkZXIgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIn1gO1xuICByZXR1cm4gW1xuICAgIGBzZXQgY2hvc2VuIHRvICR7Y2hvb3NlfWAsXG4gICAgJ3NldCBvdXQgdG8gXCJcIicsXG4gICAgXCJyZXBlYXQgd2l0aCBmIGluIGNob3NlblwiLFxuICAgIFwic2V0IG91dCB0byBvdXQgJiBQT1NJWCBwYXRoIG9mIGYgJiBsaW5lZmVlZFwiLFxuICAgIFwiZW5kIHJlcGVhdFwiLFxuICAgIFwicmV0dXJuIG91dFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNvbW1hbmQgdGhhdCBvcGVucyB0aGUgT1MncyBwaWNrZXIsIG9yIG51bGwgd2hlcmUgdGhlcmUgaXMgbm9uZSDigJQgdGhlXG4gKiBjYWxsZXIgdGhlbiBzYXlzIHNvIHJhdGhlciB0aGFuIGhhbmdpbmcgb24gYSBkaWFsb2cgbm9ib2R5IHdpbGwgc2VlLlxuICogYHplbml0eUF0YCBpcyB3aGVyZSBhIExpbnV4IHplbml0eSB3YXMgZm91bmQgKHRoZSBjYWxsZXIgbG9va3MgaXQgdXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja2VyQ29tbWFuZChcbiAgcGxhdGZvcm06IHN0cmluZyxcbiAga2luZDogUGlja0tpbmQsXG4gIHByb21wdDogc3RyaW5nLFxuICB6ZW5pdHlBdD86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAocGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHJldHVybiBbXCJvc2FzY3JpcHRcIiwgXCItZVwiLCBhcHBsZVNjcmlwdChraW5kLCBwcm9tcHQpXTtcbiAgaWYgKHBsYXRmb3JtID09PSBcIndpbjMyXCIpIHJldHVybiBudWxsOyAvLyBQb3dlclNoZWxsJ3MgZGlhbG9nIG5lZWRzIGEgU1RBIGhvc3Q7IG5vdCB3cml0dGVuIHVudGlsIGFza2VkIGZvclxuICBpZiAoemVuaXR5QXQpXG4gICAgcmV0dXJuIFtcbiAgICAgIHplbml0eUF0LFxuICAgICAgXCItLWZpbGUtc2VsZWN0aW9uXCIsXG4gICAgICAuLi4oa2luZCA9PT0gXCJmb2xkZXJcIiA/IFtcIi0tZGlyZWN0b3J5XCJdIDogW1wiLS1tdWx0aXBsZVwiXSksXG4gICAgICBcIi0tc2VwYXJhdG9yPVxcblwiLFxuICAgICAgYC0tdGl0bGU9JHtwcm9tcHR9YCxcbiAgICBdO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBwYXRocyBhIHBpY2tlciBwcmludGVkOiBvbmUgcGVyIGxpbmUsIGJsYW5rcyBkcm9wcGVkLCBvcmRlciBrZXB0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gc3Rkb3V0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXG4gICAgLmZpbHRlcigobCkgPT4gbC5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAubWFwKChsKSA9PiAobC5sZW5ndGggPiAxICYmIGwuZW5kc1dpdGgoXCIvXCIpID8gbC5zbGljZSgwLCAtMSkgOiBsKSk7XG59XG5cbi8qKiBBIGNhbmNlbGxlZCBkaWFsb2cgaXMgbm90IGEgZmFpbHVyZSDigJQgb3Nhc2NyaXB0IGV4aXRzIDEsIHplbml0eSBleGl0cyAxLCBhbmQgbm90aGluZyB3YXMgY2hvc2VuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhc0NhbmNlbGxlZChleGl0Q29kZTogbnVtYmVyLCBzdGRvdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXhpdENvZGUgIT09IDAgJiYgcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0KS5sZW5ndGggPT09IDA7XG59XG4iLAogICAgIi8vIEU2Njogd2hpY2ggZG9jdW1lbnQgdGV4dCBhIGhlbGQgc2VsZWN0aW9uIGlzIGFib3V0IOKAlCBzaGFyZWQgYnkgdGhlIGRhZW1vblxuLy8gKHdoYXQgYHNheWAgbWF5IGF0dGFjaCkgYW5kIHRoZSBzdXJmYWNlICh3aGF0IHRoZSBjaGlwIG1heSBzaG93KSwgc28gdGhlIHR3b1xuLy8gaGFsdmVzIGNhbm5vdCBkaXNhZ3JlZSBhYm91dCB3aGVuIGEgc2VsZWN0aW9uIHN0b3BzIGJlaW5nIHRydWUuXG5cbi8qKiBUaGUgZG9jdW1lbnQgdGV4dCBvbiBzY3JlZW46IHRoZSBvcGVuIGRvY3VtZW50LCBhdCBpdHMgYWN0aXZlIHZlcnNpb24uICovXG5leHBvcnQgdHlwZSBTY3JlZW4gPSB7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfTtcblxuLyoqXG4gKiBUaGUgaGVsZCBzZWxlY3Rpb24gaWYgaXQgaXMgc3RpbGwgYWJvdXQgdGhlIHRleHQgb24gc2NyZWVuLCBlbHNlIG51bGwuXG4gKlxuICog4puUIEEgU0VMRUNUSU9OIEJFTE9OR1MgVE8gVEhFIFRFWFQgSVQgV0FTIE1BREUgSU4sIGFuZCBjYW5ub3Qgb3V0bGl2ZSB0aGF0XG4gKiB0ZXh0IGxlYXZpbmcgdGhlIHNjcmVlbi4gT3BlbmluZyBhbm90aGVyIGRvY3VtZW50IOKAlCBieSB0aGUgY29udGV4dCBsaXN0LCBhXG4gKiBzZWFyY2ggcmVzdWx0LCBhIG5vdGUncyBcIm9wZW5cIiwgdGhlIGFnZW50IOKAlCBvciBtYWtpbmcgYW5vdGhlciB2ZXJzaW9uIGFjdGl2ZVxuICogdXNlZCB0byBsZWF2ZSBpdCBoZWxkLCBhbmQgdGhlIHN1cmZhY2UgcmUtc2VudCBpdCBzdGFtcGVkIHdpdGggdGhlIE5FV1xuICogZG9jdW1lbnQ6IHRoZSBjaGlwIHJlYWQgYGJldGEubWQgwrcgdjEgwrcgbGluZSA1YCBvdmVyIGFscGhhJ3Mgd29yZHMsIGFuZCBhXG4gKiBgc2F5YCBhdHRhY2hlZCB0aGVtIHRvIGJldGEncyBwYXRoLiBEcm9wcGVkLCBuZXZlciByZS1sYWJlbGxlZCDigJQgdGhlIHNhbWVcbiAqIGNsZWFyIGFzIHRoZSBjaGlwJ3MgWCAoQ29sZSwgMjAyNi0wOS0yMjogb25lIHN0YXRlLCBvbmUgbWVhbmluZykuXG4gKlxuICogUmV0dXJucyB0aGUgU0FNRSB2YWx1ZSB3aGVuIGl0IGlzIGtlcHQsIHNvIGEgY2FsbGVyIGNhbiB0ZWxsIFwibm8gY2hhbmdlXCIgYnlcbiAqIGlkZW50aXR5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VsZWN0aW9uT25TY3JlZW48VCBleHRlbmRzIFNjcmVlbj4oXG4gIHNlbDogVCB8IG51bGwsXG4gIHNjcmVlbjogU2NyZWVuIHwgbnVsbCxcbik6IFQgfCBudWxsIHtcbiAgaWYgKCFzZWwgfHwgIXNjcmVlbikgcmV0dXJuIG51bGw7XG4gIHJldHVybiBzZWwuZG9jID09PSBzY3JlZW4uZG9jICYmIHNlbC52ZXJzaW9uID09PSBzY3JlZW4udmVyc2lvbiA/IHNlbCA6IG51bGw7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhZFN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgLy8g4pqgIGBybWRpclN5bmNgIHJhdGhlciB0aGFuIGBybVN5bmMo4oCmLCB7cmVjdXJzaXZlOnRydWV9KWAgT04gUFVSUE9TRTogaXRcbiAgLy8gdGhyb3dzIEVOT1RFTVBUWSwgd2hpY2ggaXMgYSBzZWNvbmQgbmV0IHVuZGVyIGByZW1vdmVDcmVhdGVkYCdzIG93blxuICAvLyBlbXB0aW5lc3MgY2hlY2suIEEgcmVjdXJzaXZlIGRlbGV0ZSB3b3VsZCBtYWtlIHRoZSBidWcgaXQgcHJldmVudHNcbiAgLy8gdW5yZWNvdmVyYWJsZSByYXRoZXIgdGhhbiBsb3VkLlxuICBybWRpclN5bmMsXG4gIHJtU3luYyxcbiAgc3RhdFN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHsgdHlwZSBBbmNob3IsIGFuY2hvck9mLCBmaW5kQW5jaG9yLCBsaW5lc09mIH0gZnJvbSBcIi4vYW5jaG9yc1wiO1xuaW1wb3J0IHsgYXBwbHlIdW5rcywgZGlmZlRleHQgfSBmcm9tIFwiLi9kaWZmXCI7XG5pbXBvcnQgeyB0eXBlIEZpbmRpbmcsIGZpbmRpbmdzIH0gZnJvbSBcIi4vZG9jdG9yXCI7XG5pbXBvcnQge1xuICBib2R5TGluZU9mZnNldCxcbiAgYnVpbGRCbG9jayxcbiAgZ3Vlc3NUeXBlLFxuICBtYXRjaGVzRmlsdGVyLFxuICByZWFkTWV0YSxcbiAgc2V0S2V5LFxuICBzcGxpdEZyb250bWF0dGVyLFxuICBzdW1tYXJpemUsXG4gIHRpdGxlRnJvbUJvZHksXG4gIHdpdGhCbG9jayxcbn0gZnJvbSBcIi4vZnJvbnRtYXR0ZXJcIjtcbmltcG9ydCB7IHR5cGUgQnVuZGxlSW5kZXgsIGJ1aWxkR3JhcGgsIHR5cGUgUmVzb2x1dGlvbiwgcmVzb2x2ZVRhcmdldCB9IGZyb20gXCIuL2xpbmtzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENoYXRNZXNzYWdlLFxuICBDaGF0V2hvLFxuICBDb250ZXh0RW50cnksXG4gIENvbnRleHROb2RlLFxuICBEaWZmUGF5bG9hZCxcbiAgRGlmZlNpZGUsXG4gIERvY01ldGEsXG4gIERvY1N1bW1hcnksXG4gIERvY1ZpZXcsXG4gIEdyYXBoUGF5bG9hZCxcbiAgTWV0YUZpbHRlcixcbiAgTW92ZVBsYW4sXG4gIE5vdGUsXG4gIE5vdGVSZWYsXG4gIFBsYWNlZE5vdGUsXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFRhc2ssXG4gIFZlcnNpb24sXG4gIFZlcnNpb25BdXRob3IsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIENhbmRpZGF0ZSwgdHlwZSBTZWFyY2hSZXBvcnQsIHNlYXJjaERvY3VtZW50cyB9IGZyb20gXCIuL3NlYXJjaFwiO1xuaW1wb3J0IHtcbiAgRE9DX0VYVEVOU0lPTlMsXG4gIGRvY1BhdGhzLFxuICBlbnRyeUZvclBhdGgsXG4gIGZpbmROb2RlLFxuICBpc0RvY05hbWUsXG4gIGxvY2F0ZSxcbiAgTUlSUk9SX05PREVfQ0FQLFxuICBzY2FuVHJlZSxcbiAgdG9Qb3NpeCxcbn0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgY29uc3QgTUFOSUZFU1RfRk9STUFUID0gMTtcblxuLyoqIFRoZSBtb3N0IGRvY3VtZW50cyBvbmUgZnJvbnRtYXR0ZXIgc2NhbiByZWFkcy4gKi9cbmV4cG9ydCBjb25zdCBNRVRBX1NDQU5fQ0FQID0gNTAwO1xuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgbGl2ZXMgYXQgdGhlIHRvcCBvZiBhIGZpbGU7IHRoaXMgaXMgaG93IG11Y2ggd2UgcmVhZCB0byBmaW5kIGl0LiAqL1xuY29uc3QgTUVUQV9IRUFEX0JZVEVTID0gODE5MjtcblxuLyoqIFRoZSBmaXJzdCA4IEtCIG9mIGEgZmlsZSwgYXMgdGV4dCDigJQgZW5vdWdoIGZvciBhbnkgZnJvbnRtYXR0ZXIgYmxvY2suICovXG5mdW5jdGlvbiByZWFkSGVhZChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgZmQ6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmZCA9IG9wZW5TeW5jKHBhdGgsIFwiclwiKTtcbiAgICBjb25zdCBidWYgPSBCdWZmZXIuYWxsb2MoTUVUQV9IRUFEX0JZVEVTKTtcbiAgICBjb25zdCByZWFkID0gcmVhZFN5bmMoZmQsIGJ1ZiwgMCwgTUVUQV9IRUFEX0JZVEVTLCAwKTtcbiAgICByZXR1cm4gYnVmLnN1YmFycmF5KDAsIHJlYWQpLnRvU3RyaW5nKFwidXRmOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKGZkICE9PSB1bmRlZmluZWQpIGNsb3NlU3luYyhmZCk7XG4gIH1cbn1cblxudHlwZSBEb2NSZWNvcmQgPSB7XG4gIHNsdWc6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBvcmlnaW5hbDogc3RyaW5nO1xuICBlbnRyeUlkOiBzdHJpbmcgfCBudWxsO1xuICByZWw6IHN0cmluZyB8IG51bGw7XG4gIGV4dDogc3RyaW5nO1xuICB2ZXJzaW9uczogT21pdDxWZXJzaW9uLCBcInBhdGhcIj5bXTtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIC8qKlxuICAgKiBUaGUgbmV4dCB2ZXJzaW9uIG51bWJlciB0byBoYW5kIG91dCDigJQgTU9OT1RPTklDLCBhbmQgbmV2ZXIgZGVyaXZlZCBmcm9tXG4gICAqIHRoZSB2ZXJzaW9ucyBzdGlsbCBwcmVzZW50IChFNDEpLiBOdW1iZXJpbmcgYXMgYG1heChleGlzdGluZykgKyAxYCB3YXNcbiAgICogY29ycmVjdCB3aGlsZSBub3RoaW5nIGNvdWxkIGJlIGRlbGV0ZWQ7IHRoZSBtb21lbnQgYSB2ZXJzaW9uIGNhbiBiZVxuICAgKiByZW1vdmVkLCBkZWxldGluZyB0aGUgaGlnaGVzdCBtYWtlcyB0aGUgbmV4dCBvbmUgUkVVU0UgaXRzIG51bWJlciwgYW5kIGFcbiAgICogYHYzYCBuYW1lZCBpbiBhIGNoYXQgbWVzc2FnZSwgYSBsb2cgbGluZSBvciBhbiBhZ2VudCdzIG5vdGVzIHdvdWxkIHRoZW5cbiAgICogcG9pbnQgYXQgYSBkaWZmZXJlbnQgZG9jdW1lbnQuIEFic2VudCBvbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSDigJRcbiAgICogYHRha2VWZXJzaW9uYCBkZXJpdmVzIGl0IG9uY2UsIGZyb20gdGhlIGhpZ2hlc3QgdGhhdCBldmVyIHdhcy5cbiAgICovXG4gIG5leHRWZXJzaW9uPzogbnVtYmVyO1xuICAvKiogTm90ZXMgb24gdGhpcyBkb2N1bWVudCAoRTQ1KS4gU3RvcmVkIGluIHRoZSBtYW5pZmVzdDogdGhleSB0cmF2ZWwgd2l0aCB0aGVcbiAgICogIHNlc3Npb24gYW5kIG5ldmVyIGxpdHRlciB0aGUgaHVtYW4ncyBmb2xkZXIuICovXG4gIG5vdGVzPzogTm90ZVtdO1xuICAvKiogSGFzaCBvZiB0aGUgb3JpZ2luYWwgYXMgd2UgbGFzdCByZWFkIG9yIHdyb3RlIGl0IOKAlCBhdCBvcGVuLCBzYXZlLCByZXZlcnRcbiAgICogIGFuZCByZWxvYWQg4oCUIHNvIGEgcmVzdG9yZSBjYW4gdGVsbCB0aGF0IGl0IGNoYW5nZWQgd2hpbGUgbm8gZGFlbW9uIHdhc1xuICAgKiAgd2F0Y2hpbmcgKHZlcmlmeS1wYXNzIGZpeCAyKS4gKi9cbiAgb3JpZ2luYWxIYXNoOiBzdHJpbmc7XG4gIC8qKiBTZXQgb25seSBieSBgb3BlblBhdGhgLCB3aGljaCBhZG1pdHMgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogIGVudHJ5LiBgc2F2ZWAgd3JpdGVzIG5vIG9yaWdpbmFsIHRoYXQgbGFja3MgaXQgKHZlcmlmeS1wYXNzIGZpeCAxYykuICovXG4gIGFkbWl0dGVkPzogYm9vbGVhbjtcbiAgb3V0c2lkZUNoYW5nZWQ6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgZm9ybWF0OiBudW1iZXI7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgY29udGV4dDogQ29udGV4dEVudHJ5W107XG4gIGRvY3M6IERvY1JlY29yZFtdO1xuICBvcGVuRG9jOiBzdHJpbmcgfCBudWxsO1xuICBjaGF0OiBDaGF0TWVzc2FnZVtdO1xuICAvKiogVGhlIHdvcmsgcXVldWUgKEU1MCkuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQuICovXG4gIHRhc2tzPzogVGFza1tdO1xuICAvKiogRTIzJ3Mgd29ya3NwYWNlLiBBYnNlbnQgaW4gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBpdCBleGlzdGVkOiB0aGUgdXNlcidzIGhvbWUuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICAgLyoqXG4gICAgICogV2hhdCB0byBETyBhYm91dCBpdCwgd2hlbiB0aGUgbWVzc2FnZSBhbG9uZSBkb2VzIG5vdCBzYXkuIENhcnJpZWQgdG8gdGhlXG4gICAgICogQ0xJJ3MgZW52ZWxvcGUsIHdoZXJlIHRoZSBob3VzZSB0YXhvbm9teSBhbHJlYWR5IGhhcyBhIGBoaW50YCBmaWVsZCB0aGF0XG4gICAgICogcmVmdXNhbHMgZnJvbSB0aGlzIHNpZGUgd2VyZSBuZXZlciBmaWxsaW5nLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhpbnQ/OiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBBIHBhdGgncyByZWFscGF0aCwgb3IgdGhlIHBhdGggaXRzZWxmIHdoZW4gaXQgY2Fubm90IGJlIHJlc29sdmVkIChnb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFsT3IocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcDtcbiAgfVxufVxuXG4vKiogV2hhdCBhIHdhdGNoZXIgZXZlbnQgdHVybmVkIG91dCB0byBiZS4gYG51bGxgID0gbm90aGluZyAob3Vycywgb3Igbm8gY2hhbmdlKS4gKi9cbmV4cG9ydCB0eXBlIEZpbGVFdmVudCA9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IGFjdGl2ZTogZmFsc2UgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIjtcbiAgICAgIGRvYzogc3RyaW5nO1xuICAgICAgdmVyc2lvbjogbnVtYmVyO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgLyoqIFRoZSBuZXcgYWdlbnQgdmVyc2lvbiB0aGUgb3V0c2lkZSB0ZXh0IHdhcyBwcmVzZXJ2ZWQgYXMuICovXG4gICAgICBwcmVzZXJ2ZWRBczogbnVtYmVyO1xuICAgICAgcHJlc2VydmVkUGF0aDogc3RyaW5nO1xuICAgIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGFzIHRoZSBkYWVtb24gbGFzdCB3cm90ZSAob3IgYWRvcHRlZClcbiAgICogIGl0IOKAlCB3aGF0IGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIHJldmVydGVkIHRvLiAqL1xuICBwcml2YXRlIGxhc3RBY3RpdmVUZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFdoYXQgYSByZXN0b3JlIGZvdW5kIGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLiAqL1xuICByZXN0b3JlRmluZGluZ3M6IHsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IG1pc3Npbmc6IGJvb2xlYW4gfVtdID0gW107XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCksIHdvcmtzcGFjZT86IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCB7XG4gICAgICBmb3JtYXQ6IE1BTklGRVNUX0ZPUk1BVCxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGNvbnRleHQ6IFtdLFxuICAgICAgZG9jczogW10sXG4gICAgICBvcGVuRG9jOiBudWxsLFxuICAgICAgY2hhdDogW10sXG4gICAgICAuLi4od29ya3NwYWNlID8geyB3b3Jrc3BhY2U6IHJlc29sdmUod29ya3NwYWNlKSB9IDoge30pLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIGNvbnN0IHRleHQgPSBleGlzdHNTeW5jKHApID8gcmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSA6IFwiXCI7XG4gICAgICBzLmFkb3B0QWN0aXZlKGQsIHRleHQpO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAyOiBhbiBvcmlnaW5hbCBjaGFuZ2VkIHdoaWxlIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWRcbiAgICAgIC8vIHdhcyBpbnZpc2libGUgaGVyZSwgc28gdGhlIG5leHQgU2F2ZSBvdmVyd3JvdGUgaXQgdW5hbm5vdW5jZWQuIFRoZVxuICAgICAgLy8gbWFuaWZlc3QgaG9sZHMgdGhlIG9yaWdpbmFsJ3MgaGFzaCBhcyBvZiB0aGUgbGFzdCBvcGVuL3NhdmUvcmV2ZXJ0L1xuICAgICAgLy8gcmVsb2FkOyBhIGRpZmZlcmVudCBoYXNoIG5vdyBpcyBhbiBvdXRzaWRlIGNoYW5nZSwgbWFya2VkIGV4YWN0bHkgYXMgYVxuICAgICAgLy8gbGl2ZSBvbmUgd2l0aCBhIGRpcnR5IGJ1ZmZlciBpcyDigJQgYXNrZWQsIG5ldmVyIG1lcmdlZCBvciByZWxvYWRlZC5cbiAgICAgIGxldCBub3c6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbm93ID0gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbm93ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChub3cgPT09IG51bGwgfHwgbm93ICE9PSBkLm9yaWdpbmFsSGFzaCkge1xuICAgICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgcy5yZXN0b3JlRmluZGluZ3MucHVzaCh7IGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCwgbWlzc2luZzogbm93ID09PSBudWxsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocy5yZXN0b3JlRmluZGluZ3MubGVuZ3RoID4gMCkgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGVhY2ggZW50cnkgcm9vdCxcbiAgICogYW5kIHRoZSBSRUFMIGRpcmVjdG9yeSBvZiBldmVyeSBvcGVuZWQgb3JpZ2luYWwuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMzogZWFjaCByb290IGlzIHdhdGNoZWQgYXQgaXRzIFJFQUxQQVRIIChgd2F0Y2hgKSwgYW5kXG4gICAqIGFuIGV2ZW50IGlzIHJlcG9ydGVkIHVuZGVyIHRoZSBwYXRoIGZvcm0gdGhlIHNlc3Npb24gc3RvcmVzIChgcGF0aGApLiBBXG4gICAqIHdhdGNoIG9uIGEgc3ltbGlua2VkIGRpcmVjdG9yeSDigJQgYSBzeW1saW5rZWQgaG9tZSwgYSBzeW1saW5rZWQgZm9sZGVyXG4gICAqIGVudHJ5IOKAlCBvciBvbiB0aGUgbGluaydzIG93biBkaXJlY3RvcnkgZm9yIGEgc3ltbGlua2VkIG9yaWdpbmFsIHNhd1xuICAgKiBub3RoaW5nIHdoZW4gdGhlIFRBUkdFVCBjaGFuZ2VkIChGU0V2ZW50cyByZXBvcnRzIHJlYWwgcGF0aHMpLiBBIHN5bWxpbmtlZFxuICAgKiBvcmlnaW5hbCBpcyBtYXRjaGVkIGJhY2sgdG8gaXRzIGRvYyBieSByZWFscGF0aCBpbiBgb25GaWxlRXZlbnRgLlxuICAgKi9cbiAgd2F0Y2hSb290cygpOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSB7XG4gICAgY29uc3Qgcm9vdHM6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdID0gW1xuICAgICAgeyBwYXRoOiB0aGlzLmRvY3NEaXIsIHdhdGNoOiByZWFsT3IodGhpcy5kb2NzRGlyKSwgcmVjdXJzaXZlOiB0cnVlIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICByb290cy5wdXNoKHtcbiAgICAgICAgcGF0aDogZS5yb290LFxuICAgICAgICB3YXRjaDogcmVhbE9yKGUucm9vdCksXG4gICAgICAgIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsXG4gICAgICAgIGVudHJ5SWQ6IGUuaWQsXG4gICAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBkaXJuYW1lKHJlYWxPcihkLm9yaWdpbmFsKSk7XG4gICAgICBpZiAoXG4gICAgICAgICFyb290cy5zb21lKChyKSA9PiByLndhdGNoID09PSByZWFsRGlyICYmIHIucmVjdXJzaXZlID09PSBmYWxzZSkgJiZcbiAgICAgICAgIXJvb3RzLnNvbWUoXG4gICAgICAgICAgKHIpID0+IHIucmVjdXJzaXZlICYmIChyZWFsRGlyID09PSByLndhdGNoIHx8IHJlYWxEaXIuc3RhcnRzV2l0aChyLndhdGNoICsgc2VwKSksXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgcm9vdHMucHVzaCh7IHBhdGg6IHJlYWxEaXIsIHdhdGNoOiByZWFsRGlyLCByZWN1cnNpdmU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRvcHRBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgdGhpcy5vd25lZC5zZXQocCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBLZWVwIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFzIGEgTkVXIGFnZW50IHZlcnNpb24uICovXG4gIHByaXZhdGUgcHJlc2VydmVPdXRzaWRlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogVmVyc2lvbiB7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgIGZyb206IGQuYWN0aXZlLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbGFiZWw6IGBvdXRzaWRlIHdyaXRlIHRvIHYke2QuYWN0aXZlfWAsXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH07XG4gIH1cblxuICAvKiogVHJ1ZSBpZmYgYHRleHRgIGF0IGBwYXRoYCBpcyBleGFjdGx5IHdoYXQgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIHRoZXJlLiAqL1xuICBpc093bldyaXRlKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMub3duZWQuZ2V0KHBhdGgpID09PSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb250ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZENvbnRleHQocmF3UGF0aDogc3RyaW5nKTogeyBlbnRyeTogQ29udGV4dEVudHJ5OyBhZGRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGNvbnN0IHByb2JlID0gZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApO1xuICAgIGNvbnN0IHNhbWUgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUucm9vdCA9PT0gcHJvYmUucm9vdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IHByb2JlLm1lbWJlcnNoaXAgJiZcbiAgICAgICAgKHByb2JlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiB8fFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGUubm9kZXMpID09PSBKU09OLnN0cmluZ2lmeShwcm9iZS5ub2RlcykpLFxuICAgICk7XG4gICAgaWYgKHNhbWUpIHJldHVybiB7IGVudHJ5OiBzYW1lLCBhZGRlZDogZmFsc2UgfTtcbiAgICB0aGlzLm0uY29udGV4dC5wdXNoKHByb2JlKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBwcm9iZSwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBBbiBlbnRyeSdzIHJvb3QgcGF0aCwgc28gRTYwIGNhbiBwdXQgYmFjayBhIGNvbnRleHQgZW50cnkgaXQgcmVtb3ZlZC4gKi9cbiAgZW50cnlSb290KGlkOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpPy5yb290ID8/IG51bGw7XG4gIH1cblxuICByZW1vdmVDb250ZXh0KGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpID0gdGhpcy5tLmNvbnRleHQuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gICAgaWYgKGkgPCAwKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoZSkgPT4gZS5pZCksXG4gICAgICApO1xuICAgIHRoaXMubS5jb250ZXh0LnNwbGljZShpLCAxKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgb3BlbiBkb2N1bWVudCBsZWZ0IHRoZSBjb250ZXh0IChpdHMgZW50cnkgcmVtb3ZlZCwgb3IgdGhlIGRvY3VtZW50XG4gICAqIGhpZGRlbik6IGNsb3NlIGl0IGluIHRoZSB2aWV3LiBJdHMgdmVyc2lvbnMgc3RheSBpbiB0aGUgc2Vzc2lvbiDigJQgbm90aGluZ1xuICAgKiBpcyBkZWxldGVkIOKAlCBhbmQgYnJpbmdpbmcgaXQgYmFjayBhbmQgb3BlbmluZyBpdCBhZ2FpbiBmaW5kcyB0aGVtLlxuICAgKi9cbiAgcHJpdmF0ZSBjbG9zZU9ycGhhbmVkT3BlbkRvYygpOiB2b2lkIHtcbiAgICBjb25zdCBvcGVuID0gdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICBpZiAob3BlbiAmJiBvcGVuLmVudHJ5SWQgPT09IG51bGwpIHRoaXMubS5vcGVuRG9jID0gbnVsbDtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QsIE1JUlJPUl9OT0RFX0NBUCwgZS5oaWRkZW4pO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBvcGVuZWQgPSB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IGQuc2x1Zyk7XG4gICAgLyoqXG4gICAgICog4puUIFdIRU4gTk9USElORyBJUyBPUEVOLCBUSEUgT1BFTkVEIFNMVUdTIEFSRSBBTiBFTVBUWSBMSVNUIEFORCBBTiBFTVBUWVxuICAgICAqIExJU1QgSVMgTk9UIEFOIEFOU1dFUi4gQSBjb2xkIGFnZW50IG5hbWVkIGEgZG9jdW1lbnQgYnkgZmlsZW5hbWUgYmVmb3JlXG4gICAgICogYW55dGhpbmcgd2FzIG9wZW4gYW5kIGdvdCBgY2hvaWNlczogW11gIHdpdGggbm8gaGludCDigJQgZnJvbSBhIHNlc3Npb25cbiAgICAgKiB3aG9zZSBjb250ZXh0IGhlbGQgZXhhY3RseSB0aGUgdHdvIGRvY3VtZW50cyBpdCBjb3VsZCBoYXZlIG5hbWVkLiBUaGVcbiAgICAgKiByZWZ1c2FsIHdhcyBjb3JyZWN0IGFuZCB1c2VsZXNzLCB3aGljaCBpcyB0aGUgZmFpbHVyZSBtb2RlIGBjaG9pY2VzYFxuICAgICAqIGV4aXN0cyB0byBwcmV2ZW50LlxuICAgICAqXG4gICAgICogU28gYW4gdW5vcGVuZWQgc2Vzc2lvbiBvZmZlcnMgdGhlIHBhdGhzIGl0IENPVUxEIG9wZW4sIGFuZCBzYXlzIGhvdy4gQVxuICAgICAqIGZpbGVuYW1lIG9ubHkgcmVzb2x2ZXMgZm9yIGEgZG9jdW1lbnQgdGhhdCBpcyBhbHJlYWR5IG9wZW47IGEgcGF0aCBhbHdheXNcbiAgICAgKiBvcGVucyBvbmUuXG4gICAgICovXG4gICAgY29uc3QgY2hvaWNlcyA9XG4gICAgICBvcGVuZWQubGVuZ3RoID4gMCA/IG9wZW5lZCA6IHRoaXMubS5jb250ZXh0LmZsYXRNYXAoKGUpID0+IGRvY1BhdGhzKGUpKS5zbGljZSgwLCAyMCk7XG4gICAgY29uc3QgaGludCA9XG4gICAgICBvcGVuZWQubGVuZ3RoID4gMFxuICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICA6IFwibm90aGluZyBpcyBvcGVuIHlldCDigJQgcGFzcyBhIFBBVEggZnJvbSB0aGUgY29udGV4dCAoYSBmaWxlbmFtZSBvbmx5IHJlc29sdmVzIG9uY2UgYSBkb2N1bWVudCBpcyBvcGVuKVwiO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMsIGhpbnQpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMsIGhpbnQpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICAvLyDim5QgT05MWSBBTiBBQlNPTFVURSBrZXkgaXMgYSBwYXRoICh2ZXJpZnktcGFzcyBmaXggOCk6IHJlc29sdmluZyBhXG4gICAgLy8gcmVsYXRpdmUgb25lIGhlcmUgcmVzb2x2ZWQgaXQgYWdhaW5zdCB0aGUgREFFTU9OJ3MgY3dkLiBUaGUgQ0xJIHJlc29sdmVzXG4gICAgLy8gYWdhaW5zdCBpdHMgb3duIGN3ZCBhbmQgc2VuZHMgYW4gYWJzb2x1dGUgcGF0aC5cbiAgICBpZiAoaXNBYnNvbHV0ZShrZXkpKSB7XG4gICAgICBjb25zdCBieVBhdGggPSB0aGlzLm0uZG9jcy5maW5kKFxuICAgICAgICAoZCkgPT4gZC5vcmlnaW5hbCA9PT0ga2V5IHx8IHJlYWxPcihkLm9yaWdpbmFsKSA9PT0gcmVhbE9yKGtleSksXG4gICAgICApO1xuICAgICAgaWYgKGJ5UGF0aCkgcmV0dXJuIGJ5UGF0aDtcbiAgICB9XG4gICAgY29uc3QgYnlOYW1lID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiBiYXNlbmFtZShkLm9yaWdpbmFsKSA9PT0ga2V5IHx8IGQucmVsID09PSBrZXkpO1xuICAgIHJldHVybiBieU5hbWUubGVuZ3RoID09PSAxID8gYnlOYW1lWzBdIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyLCBjb25zdW1lZC4gTnVtYmVycyBhcmUgbmV2ZXIgcmV1c2VkIChFNDEpLiAqL1xuICBwcml2YXRlIHRha2VWZXJzaW9uKGQ6IERvY1JlY29yZCk6IG51bWJlciB7XG4gICAgY29uc3QgbiA9IGQubmV4dFZlcnNpb24gPz8gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBkLm5leHRWZXJzaW9uID0gbiArIDE7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICBwcml2YXRlIHZlcnNpb25PckRpZShkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+IHtcbiAgICBjb25zdCB2ID0gZC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm4gPT09IG4pO1xuICAgIGlmICghdilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIHYke259YCxcbiAgICAgICAgNDA0LFxuICAgICAgICBkLnZlcnNpb25zLm1hcCgoeCkgPT4gYHYke3gubn1gKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHY7XG4gIH1cblxuICBwcml2YXRlIHNsdWdGb3Iob3JpZ2luYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlbSA9XG4gICAgICBiYXNlbmFtZShvcmlnaW5hbCwgZXh0bmFtZShvcmlnaW5hbCkpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOV8tXSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwiZG9jXCI7XG4gICAgbGV0IHNsdWcgPSBzdGVtO1xuICAgIGZvciAobGV0IGkgPSAyOyB0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHNsdWcpOyBpKyspIHNsdWcgPSBgJHtzdGVtfS0ke2l9YDtcbiAgICByZXR1cm4gc2x1ZztcbiAgfVxuXG4gIC8qKlxuICAgKiBPcGVuIGEgZG9jdW1lbnQgYnkgaXRzIG9yaWdpbmFsJ3MgcGF0aDogdjEgaXMgd3JpdHRlbiBmcm9tIHRoZSBvcmlnaW5hbFxuICAgKiB0aGUgZmlyc3QgdGltZS4gYGZvY3VzOiBmYWxzZWAgKHRoZSBhZ2VudCdzIGltcGxpY2l0IG9wZW4gdGhyb3VnaFxuICAgKiBgdmVyc2lvbi1uZXcgLS1kb2MgPHBhdGg+YCkgZG9lcyBub3QgbW92ZSB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IGZvY3VzPzogYm9vbGVhbiB9ID0ge30pOiB7IHNsdWc6IHN0cmluZzsgY3JlYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBmb2N1cyA9IG9wdHMuZm9jdXMgPz8gdHJ1ZTtcbiAgICAvLyBUaGUgY29udGV4dCdzIG93biBzcGVsbGluZyBvZiB0aGUgcGF0aDogYSBjYWxsZXIgd2hvc2UgY3dkIGlzIGEgcmVhbHBhdGhcbiAgICAvLyAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIG9yIHRocm91Z2ggYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgIC8vIGZpbGUgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgZG9jLlxuICAgIGNvbnN0IGFicyA9IHRoaXMuY2Fub25pY2FsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBleGlzdGluZy5zbHVnO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBzbHVnOiBleGlzdGluZy5zbHVnLCBjcmVhdGVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoIWlzRG9jTmFtZShhYnMpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgNDAwKTtcbiAgICBpZiAoIWxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Fic30gaXMgbm90IGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQg4oCUIGFkZCBpdCAob3IgaXRzIGZvbGRlcikgZmlyc3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghc3RhdFN5bmMoYWJzKS5pc0ZpbGUoKSkgdGhyb3cgbmV3IEVycm9yKFwibm90IGEgZmlsZVwiKTtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3Qgb3BlbiAke2Fic306IG5vIHN1Y2ggZmlsZWAsIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGV4dCA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdLmluY2x1ZGVzKGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpKVxuICAgICAgPyBleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKVxuICAgICAgOiBcIi5tZFwiO1xuICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpO1xuICAgIGNvbnN0IGQ6IERvY1JlY29yZCA9IHtcbiAgICAgIHNsdWc6IHRoaXMuc2x1Z0ZvcihhYnMpLFxuICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIG9yaWdpbmFsOiBhYnMsXG4gICAgICBlbnRyeUlkOiBhdD8uZW50cnlJZCA/PyBudWxsLFxuICAgICAgcmVsOiBhdD8ucmVsID8/IG51bGwsXG4gICAgICBleHQsXG4gICAgICB2ZXJzaW9uczogW3sgbjogMSwgYXV0aG9yOiBcImh1bWFuXCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9XSxcbiAgICAgIGFjdGl2ZTogMSxcbiAgICAgIG9yaWdpbmFsSGFzaDogY29udGVudEhhc2godGV4dCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZmFsc2UsXG4gICAgICBhZG1pdHRlZDogdHJ1ZSxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzLnB1c2goZCk7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZC5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgY3JlYXRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIGBhYnNgIGFzIHRoZSBjb250ZXh0IHNwZWxscyBpdCwgd2hlbiBpdCBpcyB0aGUgc2FtZSBmaWxlIGJ5IHJlYWxwYXRoLiAqL1xuICBwcml2YXRlIGNhbm9uaWNhbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKCFyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNwZWxsZWQgPSBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIHNwZWxsZWQpKSByZXR1cm4gc3BlbGxlZDtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIC8qKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDQg4oCUIENIRUNLIEJFRk9SRSBXUklURS4gQmVmb3JlIHRoZSBodW1hbidzIGVkaXQgaXNcbiAgICogd3JpdHRlbiwgdGhlIGZpbGUgb24gZGlzayBpcyBoYXNoZWQ6IGlmIGl0IGlzIG5vdCB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICogd3JpdGUsIHNvbWVvbmUgZWxzZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb24gKEUyKS4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgYVxuICAgKiBORVcgYWdlbnQgdmVyc2lvbiwgYW5kIG9ubHkgdGhlbiBpcyB0aGUgZWRpdCB3cml0dGVuLiBEZXRlY3Rpb24gdXNlZCB0b1xuICAgKiBkZXBlbmQgb24gdGhlIHdhdGNoZXIncyA2MCBtcyBzZXR0bGUgdGltZXIgZmlyaW5nIGJlZm9yZSB0aGUgbmV4dFxuICAgKiBrZXlzdHJva2U7IGEgYnVyc3Qgb2YgZWRpdHMgYXQgMzAgbXMgY2xvYmJlcmVkIGFuIG91dHNpZGUgd3JpdGVcbiAgICogdW5hbm5vdW5jZWQuIE5vdyBub3RoaW5nIGlzIGxvc3Qgd2hhdGV2ZXIgdGhlIHRpbWluZyDigJQgdGhlIG9uZSB3aW5kb3cgbGVmdFxuICAgKiBpcyB0aGUgbWljcm9zZWNvbmRzIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGlzIHdyaXRlLlxuICAgKi9cbiAgZWRpdChcbiAgICBzbHVnOiBzdHJpbmcsXG4gICAgbjogbnVtYmVyLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgKTogeyBkaXJ0eUNoYW5nZWQ6IGJvb2xlYW47IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgaWYgKG4gIT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke259IGlzIG5vdCB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9ICh2JHtkLmFjdGl2ZX0gaXMpIOKAlCBvbmx5IHRoZSBhY3RpdmUgdmVyc2lvbiBpcyBlZGl0YWJsZWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0RpcnR5KGQpO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIC8vIFRoZSBlZGl0IGlzIHN0YWdlZCBpbiBhIHNpYmxpbmcgZmlsZSBGSVJTVCwgc28gdGhlIGNoZWNrIGJlbG93IGFuZCB0aGVcbiAgICAvLyByZW5hbWUgdGhhdCBsYW5kcyB0aGUgZWRpdCBhcmUgYWRqYWNlbnQgc3lzY2FsbHM6IHRoZSB3aW5kb3cgaW4gd2hpY2ggYW5cbiAgICAvLyBvdXRzaWRlIHdyaXRlIGNvdWxkIHNsaXAgYmV0d2VlbiB0aGVtIGlzIG1pY3Jvc2Vjb25kcywgbm90IHRoZSBsZW5ndGggb2ZcbiAgICAvLyBhIG11bHRpLW1lZ2FieXRlIHdyaXRlIOKAlCBhbmQgYSB3cml0ZSBsYW5kaW5nIEFGVEVSIHRoZSByZW5hbWUgZ29lcyB0byB0aGVcbiAgICAvLyBuZXcgZmlsZSwgd2hlcmUgdGhlIHdhdGNoZXIgZmluZHMgaXQgYW5kIHByZXNlcnZlcyBpdCB0b28uXG4gICAgY29uc3Qgc3RhZ2VkID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0uZWRpdGA7XG4gICAgd3JpdGVGaWxlU3luYyhzdGFnZWQsIHRleHQpO1xuICAgIGxldCBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb25EaXNrOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgb25EaXNrID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIG9uRGlzayA9IG51bGw7XG4gICAgfVxuICAgIGlmIChvbkRpc2sgIT09IG51bGwgJiYgIXRoaXMuaXNPd25Xcml0ZShwYXRoLCBvbkRpc2spKVxuICAgICAgcHJlc2VydmVkID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgb25EaXNrKTtcbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgcmVuYW1lU3luYyhzdGFnZWQsIHBhdGgpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpLCBwcmVzZXJ2ZWQgfTtcbiAgfVxuXG4gIC8qKiBDb3B5IGEgdmVyc2lvbiB0byBhIG5ldyBmaWxlOyB0aGUgYWdlbnQgdGhlbiBlZGl0cyB0aGF0IGZpbGUgd2l0aCBpdHMgb3duIHRvb2xzLiAqL1xuICBuZXdWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBmcm9tPzogbnVtYmVyOyBsYWJlbD86IHN0cmluZzsgYXV0aG9yOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IFZlcnNpb247XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBmcm9tID0gb3B0cy5mcm9tID8/IGQuYWN0aXZlO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIGZyb20pO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBmcm9tKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IG4gPSB0aGlzLnRha2VWZXJzaW9uKGQpO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBvcHRzLmF1dGhvcixcbiAgICAgIGZyb20sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAuLi4ob3B0cy5sYWJlbCA/IHsgbGFiZWw6IG9wdHMubGFiZWwgfSA6IHt9KSxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAoRTQxKS5cbiAgICpcbiAgICog4puUIFRIRSBBQ1RJVkUgVkVSU0lPTiBDQU5OT1QgQkUgREVMRVRFRCwgYW5kIHJlZnVzaW5nIGlzIGJldHRlciB0aGFuXG4gICAqIHBpY2tpbmcgYSByZXBsYWNlbWVudDogY2hvb3Npbmcgb25lIGZvciB0aGUgaHVtYW4gd291bGQgc2lsZW50bHkgbW92ZVxuICAgKiB3aGVyZSB0aGVpciBlZGl0cyBhbmQgU2F2ZSBhcmUgcG9pbnRlZCwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBFMiBhbmQgRTdcbiAgICogZXhpc3QgdG8ga2VlcCBleHBsaWNpdC4gQmVjYXVzZSBleGFjdGx5IG9uZSB2ZXJzaW9uIGlzIGFsd2F5cyBhY3RpdmUsIHRoaXNcbiAgICogYWxzbyBtZWFucyB0aGUgbGFzdCB2ZXJzaW9uIGNhbiBuZXZlciBiZSBkZWxldGVkIOKAlCBhIGRvY3VtZW50IGFsd2F5cyBoYXNcbiAgICogc29tZXRoaW5nIHRvIGVkaXQsIHdpdGhvdXQgdGhhdCBiZWluZyBhIHNlY29uZCBydWxlLlxuICAgKlxuICAgKiBgZnJvbWAgcG9pbnRlcnMgb24gT1RIRVIgdmVyc2lvbnMgYXJlIGxlZnQgYXMgdGhleSBhcmUuIFwiTWFkZSBmcm9tIHYyXCJcbiAgICogc3RheXMgdHJ1ZSBhZnRlciB2MiBpcyBnb25lOyBkZWxldGluZyBhIHZlcnNpb24gaXMgbm90IHJld3JpdGluZyB0aGVcbiAgICogaGlzdG9yeSBvZiB0aGUgb25lcyB0aGF0IHJlbWFpbi5cbiAgICovXG4gIGRlbGV0ZVZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgcmVtYWluaW5nOiBudW1iZXI7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCB2ID0gdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBpZiAob3B0cy52ZXJzaW9uID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtvcHRzLnZlcnNpb259IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGFjdGl2YXRlIGFub3RoZXIgb25lIGZpcnN0LCBgICtcbiAgICAgICAgICBgdGhlbiBkZWxldGUgdGhpc2AsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgLy8g4puUIE1BVEVSSUFMSVNFIFRIRSBDT1VOVEVSIEJFRk9SRSBSRU1PVklORyBUSEUgUkVDT1JELiBgdGFrZVZlcnNpb25gXG4gICAgLy8gZGVyaXZlcyBpdCBsYXppbHkgZnJvbSB0aGUgdmVyc2lvbnMgUFJFU0VOVCwgc28gb24gYSBkb2MgdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBhbGxvY2F0ZWQgb25lIChhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSwgcmVzdG9yZWQpIGRlbGV0aW5nIHRoZVxuICAgIC8vIGhpZ2hlc3Qgd291bGQgbGV0IHRoZSBuZXh0IGFsbG9jYXRpb24gZGVyaXZlIHRoZSBzYW1lIG51bWJlciBhZ2Fpbi4gRm91bmRcbiAgICAvLyBieSBkcml2aW5nIGl0LCBub3QgYnkgdGhlIHVuaXQgdGVzdCBhYm92ZSDigJQgd2hpY2ggYWxsb2NhdGVkIGZpcnN0IGFuZCBzb1xuICAgIC8vIG5ldmVyIGhhZCBhIGNvbGQgY291bnRlci5cbiAgICBkLm5leHRWZXJzaW9uID8/PSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgoeCkgPT4geC5uKSkgKyAxO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG9wdHMudmVyc2lvbik7XG4gICAgZC52ZXJzaW9ucyA9IGQudmVyc2lvbnMuZmlsdGVyKCh4KSA9PiB4Lm4gIT09IG9wdHMudmVyc2lvbik7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhwYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRoZSByZWNvcmQgaXMgd2hhdCB0aGUgc2Vzc2lvbiBiZWxpZXZlczsgYSBmaWxlIGFscmVhZHkgZ29uZSAoYSBoYW5kXG4gICAgICAvLyB0aWR5LCBhIGNyYXNoIGJldHdlZW4gd3JpdGUgYW5kIHJlY29yZCkgbXVzdCBub3QgYmxvY2sgcmVtb3ZpbmcgaXQuXG4gICAgfVxuICAgIHRoaXMub3duZWQuZGVsZXRlKHBhdGgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBvcHRzLnZlcnNpb24sXG4gICAgICAuLi4odi5sYWJlbCA/IHsgbGFiZWw6IHYubGFiZWwgfSA6IHt9KSxcbiAgICAgIHJlbWFpbmluZzogZC52ZXJzaW9ucy5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIGFjdGl2YXRlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHsgc2x1Zzogc3RyaW5nOyBwcmV2aW91czogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGNvbnN0IHByZXZpb3VzID0gZC5hY3RpdmU7XG4gICAgZC5hY3RpdmUgPSBvcHRzLnZlcnNpb247XG4gICAgLy8gVGhlIG5ldyBhY3RpdmUgdmVyc2lvbidzIHRleHQgQVMgSVQgSVMgTk9XIGlzIHRoZSBiYXNlbGluZSB0aGUgbmV4dFxuICAgIC8vIGNoZWNrLWJlZm9yZS13cml0ZSBjb21wYXJlcyBhZ2FpbnN0LlxuICAgIHRoaXMuYWRvcHRBY3RpdmUoZCwgcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb21wYXJpbmcgYW5kIG1lcmdpbmcgKEUzNikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSB0ZXh0IG9mIG9uZSBzaWRlIG9mIGEgY29tcGFyaXNvbi4gYFwib3JpZ2luYWxcImAgaXMgcmVhZCBmcm9tIERJU0ssIG5vdFxuICAgKiBmcm9tIGEgY2FjaGU6IHRoZSB3aG9sZSBwb2ludCBvZiBjb21wYXJpbmcgYWdhaW5zdCBpdCBpcyB0byBzZWUgd2hhdCB0aGVcbiAgICogZmlsZSBvZiByZWNvcmQgYWN0dWFsbHkgc2F5cyByaWdodCBub3csIGluY2x1ZGluZyBhIGNoYW5nZSBzb21lb25lIGVsc2VcbiAgICogbWFkZSB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIG9wZW4uXG4gICAqL1xuICBwcml2YXRlIHNpZGVUZXh0KGQ6IERvY1JlY29yZCwgc2lkZTogRGlmZlNpZGUpOiBzdHJpbmcge1xuICAgIGlmIChzaWRlID09PSBcIm9yaWdpbmFsXCIpIHJldHVybiByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIHNpZGUpO1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBzaWRlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIENvbXBhcmUgdGhlIEFDVElWRSB2ZXJzaW9uIChsZWZ0KSBhZ2FpbnN0IGFub3RoZXIgc2lkZSAocmlnaHQpLiAqL1xuICBjb21wYXJlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZSB9KTogRGlmZlBheWxvYWQge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBpZiAob3B0cy5hZ2FpbnN0ID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtkLmFjdGl2ZX0gaXMgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSDigJQgY29tcGFyaW5nIGl0IHdpdGggaXRzZWxmIHNheXMgbm90aGluZ2AsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgbGVmdCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiB7XG4gICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBhZ2FpbnN0OiBvcHRzLmFnYWluc3QsXG4gICAgICBkaWZmOiBkaWZmVGV4dChsZWZ0LCB0aGlzLnNpZGVUZXh0KGQsIG9wdHMuYWdhaW5zdCkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogVGFrZSBuYW1lZCBodW5rcyBmcm9tIGBhZ2FpbnN0YCBpbnRvIHRoZSBhY3RpdmUgdmVyc2lvbi5cbiAgICpcbiAgICog4puUIFRIRSBXUklURSBHT0VTIFRIUk9VR0ggYGVkaXRgLCB3aGljaCBpcyB3aGF0IG1ha2VzIGEgbWVyZ2Ugb2JleSBldmVyeVxuICAgKiBydWxlIGFuIG9yZGluYXJ5IGtleXN0cm9rZSBvYmV5czogaXQgbGFuZHMgb24gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFuZCBuZXZlclxuICAgKiB0aGUgb3JpZ2luYWwgKEU3KSwgYW5kIGNoZWNrLWJlZm9yZS13cml0ZSBwcmVzZXJ2ZXMgYW4gb3V0c2lkZSB3cml0ZSBhcyBhXG4gICAqIG5ldyB2ZXJzaW9uIGZpcnN0IChFMikuIEEgbWVyZ2Ugd3JpdGluZyB0aGUgZmlsZSBkaXJlY3RseSB3b3VsZCBiZSB0aGUgb25lXG4gICAqIHBhdGggaW50byB0aGUgZG9jdW1lbnQgdGhhdCBjb3VsZCBzaWxlbnRseSBjbG9iYmVyIHRoZSBhZ2VudC5cbiAgICovXG4gIG1lcmdlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZTsgaHVua3M6IG51bWJlcltdIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IG51bWJlcjtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYXBwbGllZDogbnVtYmVyO1xuICAgIHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGw7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBwYXlsb2FkID0gdGhpcy5jb21wYXJlKHsgZG9jOiBkLnNsdWcsIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCB9KTtcbiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQocGF5bG9hZC5kaWZmLmh1bmtzLm1hcCgoaCkgPT4gaC5pZCkpO1xuICAgIGNvbnN0IG1pc3NpbmcgPSBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+ICFrbm93bi5oYXMoaWQpKTtcbiAgICBpZiAobWlzc2luZy5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyBodW5rICR7bWlzc2luZy5qb2luKFwiLCBcIil9IGFnYWluc3QgJHtzaWRlTmFtZShvcHRzLmFnYWluc3QsIGQubmFtZSl9IOKAlCBgICtcbiAgICAgICAgICBgaXQgaGFzICR7a25vd24uc2l6ZSA9PT0gMCA/IFwibm9uZVwiIDogYDEuLiR7TWF0aC5tYXgoLi4ua25vd24pfWB9LiBSdW4gZGlmZiBhZ2FpbjogYCArXG4gICAgICAgICAgYHRoZSB0ZXh0IGNoYW5nZWQgdW5kZXIgdGhlIG51bWJlcnMuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICBjb25zdCB0ZXh0ID0gYXBwbHlIdW5rcyhiZWZvcmUsIHBheWxvYWQuZGlmZi5odW5rcywgb3B0cy5odW5rcyk7XG4gICAgY29uc3QgeyBwcmVzZXJ2ZWQgfSA9IHRoaXMuZWRpdChkLnNsdWcsIGQuYWN0aXZlLCB0ZXh0KTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICB0ZXh0LFxuICAgICAgYXBwbGllZDogb3B0cy5odW5rcy5maWx0ZXIoKGlkKSA9PiBrbm93bi5oYXMoaWQpKS5sZW5ndGgsXG4gICAgICBwcmVzZXJ2ZWQsXG4gICAgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBub3RlcyAoRTQ1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogVGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCDigJQgd2hhdCBldmVyeSBub3RlIGlzIGFuY2hvcmVkIGFnYWluc3QuICovXG4gIHByaXZhdGUgYWN0aXZlVGV4dChkOiBEb2NSZWNvcmQpOiBzdHJpbmcge1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgfVxuXG4gIC8qKiBQbGFjZSBldmVyeSBub3RlIGluIHRoZSBhY3RpdmUgdGV4dCBhcyBpdCBzdGFuZHMgbm93LiAqL1xuICBwcml2YXRlIHBsYWNlZE5vdGVzKGQ6IERvY1JlY29yZCk6IFBsYWNlZE5vdGVbXSB7XG4gICAgY29uc3Qgbm90ZXMgPSBkLm5vdGVzID8/IFtdO1xuICAgIGlmIChub3Rlcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuICAgIHJldHVybiBub3Rlcy5tYXAoKG4pID0+ICh7IC4uLm4sIC4uLmZpbmRBbmNob3IodGV4dCwgbikgfSkpO1xuICB9XG5cbiAgLyoqXG4gICAqIE5vdGUgYSByYW5nZSBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0ICh0aGUgaHVtYW4gc2VsZWN0cykgb3IgYSBxdW90ZVxuICAgKiBmb3VuZCBpbiBpdCAodGhlIGFnZW50IHF1b3RlcyDigJQgaXQgaGFzIG5vIG9mZnNldHMpLlxuICAgKi9cbiAgYWRkTm90ZShvcHRzOiB7XG4gICAgZG9jPzogc3RyaW5nO1xuICAgIGJvZHk6IHN0cmluZztcbiAgICB3aG86IFZlcnNpb25BdXRob3I7XG4gICAgcmFuZ2U/OiB7IGZyb206IG51bWJlcjsgdG86IG51bWJlciB9O1xuICAgIHF1b3RlPzogc3RyaW5nO1xuICB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGU6IE5vdGU7IGhvdzogXCJzZWxlY3Rpb25cIiB8IFwicXVvdGVcIiB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcblxuICAgIGxldCBhbmNob3I6IEFuY2hvcjtcbiAgICBpZiAob3B0cy5yYW5nZSkge1xuICAgICAgY29uc3QgeyBmcm9tLCB0byB9ID0gb3B0cy5yYW5nZTtcbiAgICAgIGlmIChmcm9tIDwgMCB8fCB0byA+IHRleHQubGVuZ3RoIHx8IGZyb20gPj0gdG8pXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7ZnJvbX0uLiR7dG99IGlzIG5vdCBhIHJhbmdlIGluIHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gKCR7dGV4dC5sZW5ndGh9IGNoYXJhY3RlcnMpYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICk7XG4gICAgICBhbmNob3IgPSBhbmNob3JPZih0ZXh0LCBmcm9tLCB0byk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHF1b3RlID0gb3B0cy5xdW90ZSA/PyBcIlwiO1xuICAgICAgaWYgKCFxdW90ZSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBhIHNlbGVjdGlvbiBvciBhIHF1b3RlXCIsIDQwMCk7XG4gICAgICBjb25zdCBhdCA9IHRleHQuaW5kZXhPZihxdW90ZSk7XG4gICAgICAvLyDim5QgUkVGVVNFRCwgbm90IGFuY2hvcmVkIGhvcGVmdWxseS4gQSBxdW90ZSB0aGUgYWN0aXZlIHZlcnNpb24gZG9lcyBub3RcbiAgICAgIC8vIGNvbnRhaW4gd291bGQgYmVjb21lIGFuIG9ycGhhbiB0aGUgbW9tZW50IGl0IHdhcyBtYWRlLCB3aGljaCByZWFkcyBhc1xuICAgICAgLy8gXCJ0aGUgdGV4dCBjaGFuZ2VkXCIgd2hlbiB0aGUgdHJ1dGggaXMgXCJ5b3UgcXVvdGVkIHNvbWV0aGluZyBlbHNlXCIuXG4gICAgICBpZiAoYXQgPT09IC0xKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB2JHtkLmFjdGl2ZX0gb2YgJHtkLnNsdWd9IGRvZXMgbm90IGNvbnRhaW4gdGhhdCB0ZXh0IOKAlCBxdW90ZSBpdCBleGFjdGx5IGFzIGl0IGFwcGVhcnNgLFxuICAgICAgICAgIDQwNCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGF0LCBhdCArIHF1b3RlLmxlbmd0aCk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm90ZTogTm90ZSA9IHtcbiAgICAgIGlkOiBgbiR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA2KX1gLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAuLi5hbmNob3IsXG4gICAgICBib2R5LFxuICAgICAgd2hvOiBvcHRzLndobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIHJlc29sdmVkOiBmYWxzZSxcbiAgICB9O1xuICAgIGQubm90ZXMgPSBbLi4uKGQubm90ZXMgPz8gW10pLCBub3RlXTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUsIGhvdzogb3B0cy5yYW5nZSA/IFwic2VsZWN0aW9uXCIgOiBcInF1b3RlXCIgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBkb2N1bWVudCdzIG5vdGVzIGFzIFNUT1JFRCDigJQgbm8gcGxhY2VtZW50LCBzbyBubyBmaWxlIHJlYWRzLiBFNjUnc1xuICAgKiBhdHRlbnRpb24gdGljayBhc2tzIHRoaXMgZXZlcnkgc2Vjb25kOyBgdmlldygpYCB3b3VsZCByZS1wbGFjZSBldmVyeSBub3RlLlxuICAgKi9cbiAgbm90ZUZhY3RzKCk6IHsgc2x1Zzogc3RyaW5nOyBub3RlczogcmVhZG9ubHkgTm90ZVtdIH1bXSB7XG4gICAgcmV0dXJuIHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gKHsgc2x1ZzogZC5zbHVnLCBub3RlczogZC5ub3RlcyA/PyBbXSB9KSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIGxpbmVzIGEgbm90ZSBjb3ZlcnMgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uIG5vdyAoRTY1KSwgb3IgbnVsbCB3aGVuIGl0c1xuICAgKiB0ZXh0IGlzIGdvbmUuIFBsYWNlZCwgbm90IHJlbWVtYmVyZWQsIGZvciB0aGUgcmVhc29uIG5vdGVzIGFyZSAoRTQ1KS5cbiAgICovXG4gIG5vdGVMaW5lcyhkb2M6IHN0cmluZywgbm90ZTogTm90ZSk6IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH0gfCBudWxsIHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShkb2MpO1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmFjdGl2ZVRleHQoZCk7XG4gICAgY29uc3QgYXQgPSBmaW5kQW5jaG9yKHRleHQsIG5vdGUpO1xuICAgIHJldHVybiBhdC5mcm9tID09PSBudWxsID8gbnVsbCA6IGxpbmVzT2YodGV4dCwgYXQuZnJvbSwgYXQudG8pO1xuICB9XG5cbiAgLyoqIE5vdGVzIG9uIGEgZG9jdW1lbnQsIHBsYWNlZCDigJQgYGFsbGAgaW5jbHVkZXMgdGhlIHJlc29sdmVkIG9uZXMuICovXG4gIG5vdGVzT2Yob3B0czogeyBkb2M/OiBzdHJpbmc7IGFsbD86IGJvb2xlYW4gfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlczogUGxhY2VkTm90ZVtdIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBwbGFjZWQgPSB0aGlzLnBsYWNlZE5vdGVzKGQpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZXM6IG9wdHMuYWxsID8gcGxhY2VkIDogcGxhY2VkLmZpbHRlcigobikgPT4gIW4ucmVzb2x2ZWQpIH07XG4gIH1cblxuICBwcml2YXRlIG5vdGVPckRpZShkOiBEb2NSZWNvcmQsIGlkOiBzdHJpbmcpOiBOb3RlIHtcbiAgICBjb25zdCBub3RlID0gKGQubm90ZXMgPz8gW10pLmZpbmQoKG4pID0+IG4uaWQgPT09IGlkKTtcbiAgICBpZiAoIW5vdGUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyBub3RlICR7aWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICAoZC5ub3RlcyA/PyBbXSkubWFwKChuKSA9PiBuLmlkKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIG5vdGU7XG4gIH1cblxuICAvKiogQ2hhbmdlIHdoYXQgYSBub3RlIFNBWVMuIEl0cyBhbmNob3IgaXMgdW50b3VjaGVkIOKAlCBpdCBpcyBzdGlsbCBhYm91dCB0aGVcbiAgICogIHNhbWUgcGFzc2FnZSwgd2hpY2ggaXMgd2h5IGVkaXRpbmcgZG9lcyBub3QgcmUtcXVvdGUgKEU0NikuICovXG4gIGVkaXROb3RlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBpZDogc3RyaW5nOyBib2R5OiBzdHJpbmc7IHdobzogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBub3RlOiBOb3RlO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIGNvbnN0IGJvZHkgPSBvcHRzLmJvZHkudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBzb21ldGhpbmcgd3JpdHRlbiBpbiBpdFwiLCA0MDApO1xuICAgIG5vdGUuYm9keSA9IGJvZHk7XG4gICAgbm90ZS5lZGl0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgLy8gRTY1OiB3aG9zZSByZXdyaXRlIGl0IHdhcyBkZWNpZGVzIHdoZXRoZXIgdGhlIG5vdGUgaXMgb3dlZCBhbiBhbnN3ZXIuXG4gICAgbm90ZS5lZGl0ZWRCeSA9IG9wdHMud2hvO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgcmVzb2x2ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmc7IHJlc29sdmVkOiBib29sZWFuOyB3aG86IFZlcnNpb25BdXRob3IgfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbm90ZTogTm90ZTtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IG5vdGUgPSB0aGlzLm5vdGVPckRpZShkLCBvcHRzLmlkKTtcbiAgICAvLyBFNjU6IGEgUkVPUEVOIGlzIGEgd3JpdGUg4oCUIGEgaHVtYW4gcmVvcGVuaW5nIGFza3MgYWdhaW4sIGFuZCB0aGUgd2FpdCBpc1xuICAgIC8vIHRpbWVkIGZyb20gaGVyZTsgdGhlIGFnZW50IHJlb3BlbmluZyBpcyBhbiBhY3Qgb24gdGhlIG5vdGUuXG4gICAgaWYgKG5vdGUucmVzb2x2ZWQgJiYgIW9wdHMucmVzb2x2ZWQpIHtcbiAgICAgIG5vdGUucmVvcGVuZWRBdCA9IERhdGUubm93KCk7XG4gICAgICBub3RlLnJlb3BlbmVkQnkgPSBvcHRzLndobztcbiAgICB9XG4gICAgbm90ZS5yZXNvbHZlZCA9IG9wdHMucmVzb2x2ZWQ7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZW1vdmVOb3RlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBpZDogc3RyaW5nIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZSB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIGQubm90ZXMgPSAoZC5ub3RlcyA/PyBbXSkuZmlsdGVyKChuKSA9PiBuLmlkICE9PSBvcHRzLmlkKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIC8qKiBTYXZlOiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IG92ZXIgdGhlIG9yaWdpbmFsLiBUaGUgT05MWSB3cml0ZSB0byBpdCAoRTcpLiAqL1xuICBzYXZlKHNsdWc6IHN0cmluZyk6IHsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWM6IFNhdmUgd3JpdGVzIG9ubHkgYW4gb3JpZ2luYWwgYWRtaXR0ZWQgYnlcbiAgICAvLyBgb3BlblBhdGhgIChhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSkuIENoZWNrZWQgYWdhaW4gaGVyZVxuICAgIC8vIHNvIG5vIG90aGVyIHBhdGggaW50byB0aGUgbWFuaWZlc3Qg4oCUIGEgaGFuZC1lZGl0ZWQgb25lLCBhIGZ1dHVyZSB2ZXJiIOKAlFxuICAgIC8vIGNhbiB0dXJuIFNhdmUgaW50byBcIndyaXRlIGFueSBmaWxlXCIuXG4gICAgaWYgKCFkLmFkbWl0dGVkIHx8ICFpc0RvY05hbWUoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gc2F2ZSAke2Qub3JpZ2luYWx9OiBpdCB3YXMgbm90IG9wZW5lZCBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgdGhpcy53cml0ZU93bmVkKGQub3JpZ2luYWwsIHRleHQpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IG9yaWdpbmFsOiBkLm9yaWdpbmFsLCB2ZXJzaW9uOiBkLmFjdGl2ZSB9O1xuICB9XG5cbiAgLyoqIFJldmVydDogdGhlIG9yaWdpbmFsJ3MgdGV4dCBiYWNrIG92ZXIgdGhlIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuICByZXZlcnQoc2x1Zzogc3RyaW5nKTogeyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHZlcnNpb246IGQuYWN0aXZlLCB0ZXh0IH07XG4gIH1cblxuICBwcml2YXRlIGlzRGlydHkoZDogRG9jUmVjb3JkKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICh0aGlzLmFjdGl2ZUhhc2guZ2V0KGQuc2x1ZykgPz8gXCJcIikgIT09IGQub3JpZ2luYWxIYXNoO1xuICB9XG5cbiAgLy8g4pSA4pSAIHRoZSB3YXRjaGVyJ3MgcXVlc3Rpb246IHdob3NlIHdyaXRlIHdhcyB0aGF0PyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ2xhc3NpZnkgb25lIGZpbGVzeXN0ZW0gZXZlbnQuIFJlYWRzIHRoZSBmaWxlOyByZXR1cm5zIGBudWxsYCB3aGVuIGl0IGlzXG4gICAqIHRoZSBkYWVtb24ncyBvd24gd3JpdGUsIHVuY2hhbmdlZCwgZ29uZSwgb3Igbm90IG91cnMgdG8gY2FyZSBhYm91dC5cbiAgICovXG4gIG9uRmlsZUV2ZW50KGFiczogc3RyaW5nKTogRmlsZUV2ZW50IHwgbnVsbCB7XG4gICAgLy8gQSB2ZXJzaW9uIGZpbGUgdW5kZXIgZG9jcy88c2x1Zz4vdk4uZXh0P1xuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLmRvY3NEaXIgKyBzZXApKSB7XG4gICAgICBjb25zdCByZXN0ID0gYWJzLnNsaWNlKHRoaXMuZG9jc0Rpci5sZW5ndGggKyAxKS5zcGxpdChzZXApO1xuICAgICAgaWYgKHJlc3QubGVuZ3RoICE9PSAyKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IFtzbHVnLCBmaWxlXSA9IHJlc3QgYXMgW3N0cmluZywgc3RyaW5nXTtcbiAgICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4LnNsdWcgPT09IHNsdWcpO1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXnYoXFxkKykoXFwuW2Etel0rKSQvLmV4ZWMoZmlsZSk7XG4gICAgICBpZiAoIWQgfHwgIW1hdGNoIHx8IG1hdGNoWzJdICE9PSBkLmV4dCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBuID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuaXNPd25Xcml0ZShhYnMsIHRleHQpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghZC52ZXJzaW9ucy5zb21lKCh2KSA9PiB2Lm4gPT09IG4pKSB7XG4gICAgICAgIC8vIFRoZSBhZ2VudCB3cm90ZSBhIHZlcnNpb24gZmlsZSBieSBoYW5kIHJhdGhlciB0aGFuIHRocm91Z2hcbiAgICAgICAgLy8gYHZlcnNpb24tbmV3YCDigJQgYWRvcHQgaXQgcmF0aGVyIHRoYW4gbGVhdmUgYSBmaWxlIHRoZSBzdXJmYWNlIGNhbm5vdCBzZWUuXG4gICAgICAgIGQudmVyc2lvbnMucHVzaCh7IG4sIGF1dGhvcjogXCJhZ2VudFwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgICAgIGQudmVyc2lvbnMuc29ydCgoYSwgYikgPT4gYS5uIC0gYi5uKTtcbiAgICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgcGF0aDogYWJzIH07XG4gICAgICB9XG4gICAgICBpZiAobiA9PT0gZC5hY3RpdmUpIHtcbiAgICAgICAgLy8gRTIsIHJlZnVzZWQgYW5kIFJFLUxBQkVMTEVEOiB0aGUgb3V0c2lkZSB0ZXh0IGJlY29tZXMgYSBuZXcgYWdlbnRcbiAgICAgICAgLy8gdmVyc2lvbiwgYW5kIHRoZSBhY3RpdmUgdmVyc2lvbiBnb2VzIGJhY2sgdG8gdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAgICAgIC8vIHRleHQg4oCUIHNvIHRoZSBhY3RpdmUgdmVyc2lvbiBvbmx5IGV2ZXIgaG9sZHMgd2hhdCB0aGUgaHVtYW4gdHlwZWQsXG4gICAgICAgIC8vIGFuZCBub3RoaW5nIGFueW9uZSB3cm90ZSBpcyBsb3N0ICh2ZXJpZnktcGFzcyBmaXggNCwgd2F0Y2hlciBoYWxmKS5cbiAgICAgICAgY29uc3Qga2VwdCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRoaXMubGFzdEFjdGl2ZVRleHQuZ2V0KGQuc2x1ZykgPz8gdGV4dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IG4sXG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIHByZXNlcnZlZEFzOiBrZXB0Lm4sXG4gICAgICAgICAgcHJlc2VydmVkUGF0aDoga2VwdC5wYXRoLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgdGV4dCwgYWN0aXZlOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIC8vIEFuIG9wZW5lZCBvcmlnaW5hbCDigJQgYnkgaXRzIHN0b3JlZCBwYXRoLCBvciBieSByZWFscGF0aCBmb3IgYSBzeW1saW5rP1xuICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4Lm9yaWdpbmFsID09PSBhYnMgfHwgcmVhbE9yKHgub3JpZ2luYWwpID09PSBhYnMpO1xuICAgIGlmIChkKSB7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICAgIGlmIChoID09PSBkLm9yaWdpbmFsSGFzaCkgcmV0dXJuIG51bGw7IC8vIG91ciBvd24gc2F2ZSwgb3Igbm8gY2hhbmdlXG4gICAgICBjb25zdCBjbGVhbiA9ICF0aGlzLmlzRGlydHkoZCk7XG4gICAgICBpZiAoY2xlYW4pIHtcbiAgICAgICAgZC5vcmlnaW5hbEhhc2ggPSBoO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkLm91dHNpZGVDaGFuZ2VkKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBhc2tlZFxuICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsIH07XG4gICAgfVxuXG4gICAgLy8gU29tZXRoaW5nIHVuZGVyIGEgbWlycm9yZWQgcm9vdDogdGhlIHRyZWUgbWF5IGhhdmUgY2hhbmdlZC5cbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzY2FuKGUuaWQpID8geyBraW5kOiBcInRyZWVcIiwgZW50cnlJZDogZS5pZCB9IDogbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyDilIDilIAgc3RydWN0dXJlIChFMjLigJNFMjQpOiByZWFsIGNoYW5nZXMgb24gZGlzaywgb25lIHBhdGggZm9yIGJvdGggcGFydGllcyDilIDilIBcbiAgLy9cbiAgLy8gRXZlcnkgbWV0aG9kIGJlbG93IGRvZXMgdGhlIGNoYW5nZSBPTiBESVNLIGFuZCB0aGVuIGJyaW5ncyB0aGUgY29udGV4dFxuICAvLyBtb2RlbCBiYWNrIGluIGxpbmUgd2l0aCBpdC4gVGhlIHN1cmZhY2UgcmVhY2hlcyB0aGVtIHRocm91Z2ggbWVudXMgYW5kXG4gIC8vIGRyYWcgYW5kIGRyb3AsIHRoZSBhZ2VudCB0aHJvdWdoIENMSSB2ZXJiczsgdGhlIGRhZW1vbiBhbm5vdW5jZXMgZWFjaCBvbmVcbiAgLy8gdW5kZXIgdGhlIG5hbWUgb2Ygd2hvZXZlciBkaWQgaXQuIFR3byBydWxlcyBob2xkIHRocm91Z2hvdXQ6XG4gIC8vXG4gIC8vIC0gTk9USElORyBJUyBERUxFVEVELiBgaGlkZWAgdGFrZXMgYSBub2RlIG91dCBvZiBTY3JpcHRvcml1bTsgdGhlIGZpbGUgc3RheXMuXG4gIC8vIC0gTk9USElORyBJUyBPVkVSV1JJVFRFTi4gQSBkZXN0aW5hdGlvbiB0aGF0IGV4aXN0cyBpcyByZWZ1c2VkIChhbiBleHBsaWNpdFxuICAvLyAgIG5hbWUpIG9yIGdpdmVuIGEgZnJlZSBuYW1lIChhIGRlZmF1bHQgb25lLCBhIGRyb3ApOyBmaWxlcyBhcmUgY3JlYXRlZFxuICAvLyAgIHdpdGggdGhlIGV4Y2x1c2l2ZSBmbGFnLCBzbyBhIHJhY2UgY2Fubm90IGNsb2JiZXIgZWl0aGVyLlxuXG4gIC8qKiBFMjM6IHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kLiAqL1xuICBnZXQgd29ya3NwYWNlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS53b3Jrc3BhY2UgPz8gaG9tZWRpcigpO1xuICB9XG5cbiAgc2V0V29ya3NwYWNlKHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc3VjaCBmb2xkZXI6ICR7YWJzfWAsIDQwNCk7XG4gICAgfVxuICAgIGlmICghaXNEaXIpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRoZSB3b3Jrc3BhY2UgbXVzdCBiZSBhIGZvbGRlcjogJHthYnN9YCwgNDAwKTtcbiAgICB0aGlzLm0ud29ya3NwYWNlID0gYWJzO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEhvdyBhIHBhdGggcmVhZHMgaW4gYSBjaGF0IGxpbmU6IGBzZXQvcmVsYCBpbnNpZGUgYSBzZXQsIGEgc2luZ2xlXG4gICAqIGRvY3VtZW50J3MgZmlsZSBuYW1lLCBgd29ya3NwYWNlL+KApmAgaW4gdGhlIHdvcmtzcGFjZSwgZWxzZSBgfi/igKZgLlxuICAgKi9cbiAgZGlzcGxheShhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHtcbiAgICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gZS5sYWJlbDtcbiAgICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHJldHVybiBgJHtlLmxhYmVsfS8ke3RvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKX1gO1xuICAgICAgfSBlbHNlIGlmIChlLm5vZGVzLnNvbWUoKG4pID0+IGpvaW4oZS5yb290LCBuLnJlbCkgPT09IGFicykpIHJldHVybiBlLmxhYmVsO1xuICAgIH1cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy53b3Jrc3BhY2UgKyBzZXApKVxuICAgICAgcmV0dXJuIGB3b3Jrc3BhY2UvJHt0b1Bvc2l4KHJlbGF0aXZlKHRoaXMud29ya3NwYWNlLCBhYnMpKX1gO1xuICAgIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG4gICAgcmV0dXJuIGFicyA9PT0gaG9tZSA/IFwiflwiIDogYWJzLnN0YXJ0c1dpdGgoaG9tZSArIHNlcCkgPyBgfiR7YWJzLnNsaWNlKGhvbWUubGVuZ3RoKX1gIDogYWJzO1xuICB9XG5cbiAgLyoqXG4gICAqIGBhYnNgIHNwZWxsZWQgdGhlIHdheSB0aGUgY29udGV4dCBzcGVsbHMgaXQuIEEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhXG4gICAqIHJlYWxwYXRoICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgKiBwbGFjZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBub2RlLlxuICAgKi9cbiAgcHJpdmF0ZSBzcGVsbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMubS5jb250ZXh0LnNvbWUoKGUpID0+IGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAocmVhbCA9PT0gcmVhbFJvb3QpIHJldHVybiBlLnJvb3Q7XG4gICAgICBpZiAocmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgcmV0dXJuIGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1dvcmtzcGFjZShhYnM6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBhYnMgPT09IHRoaXMud29ya3NwYWNlIHx8IHJlYWxPcihhYnMpID09PSByZWFsT3IodGhpcy53b3Jrc3BhY2UpO1xuICB9XG5cbiAgLyoqIFRoZSBtaXJyb3JlZCBlbnRyeSB0aGF0IGNvdmVycyBgYWJzYCAoaXRzIHJvb3QsIG9yIGFueXRoaW5nIHVuZGVyIGl0KSwgaWYgYW55LiAqL1xuICBwcml2YXRlIGNvdmVyaW5nRW50cnkoYWJzOiBzdHJpbmcsIGV4Y2VwdD86IHN0cmluZyk6IENvbnRleHRFbnRyeSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5pZCAhPT0gZXhjZXB0ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmXG4gICAgICAgIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEEgZm9sZGVyIHRoaW5ncyBtYXkgYmUgbWFkZSBpbiBvciBtb3ZlZCBpbnRvOiBhIG1pcnJvcmVkIGVudHJ5J3Mgcm9vdCwgYVxuICAgKiB2aXNpYmxlIGZvbGRlciB1bmRlciBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UuIFJldHVybnMgdGhlIGFic29sdXRlIGZvbGRlcjtcbiAgICogcmVmdXNlcyBhbnl0aGluZyBlbHNlIOKAlCB0aGUgY29udGV4dCBzdGF5cyB0aGUgd2F5IGluICh2ZXJpZnktcGFzcyBmaXggMWIpLlxuICAgKi9cbiAgcHJpdmF0ZSBkZXN0aW5hdGlvbk9yRGllKHJhd0Rpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3RGlyKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gYWJzO1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlPy5raW5kID09PSBcImdyb3VwXCIpIHJldHVybiBhYnM7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICh0aGlzLmlzV29ya3NwYWNlKGFicykpIHJldHVybiB0aGlzLndvcmtzcGFjZTtcbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgYCR7YWJzfSBpcyBub3QgYSBmb2xkZXIgaW4gdGhpcyBzZXNzaW9uIOKAlCBuYW1lIGEgc2V0LCBhIGZvbGRlciBpbnNpZGUgb25lLCBvciB0aGUgd29ya3NwYWNlICgke3RoaXMud29ya3NwYWNlfSlgLFxuICAgICAgNDAwLFxuICAgICk7XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBvciBmb2xkZXIgc2hvd24gaW4gdGhlIGNvbnRleHQsIHdpdGggd2hlcmUgaXQgaXMgc2hvd24uICovXG4gIHByaXZhdGUgaXRlbU9yRGllKHJhd1BhdGg6IHN0cmluZyk6IHtcbiAgICBhYnM6IHN0cmluZztcbiAgICBlbnRyeTogQ29udGV4dEVudHJ5O1xuICAgIC8qKiBUaGUgd2hvbGUgZW50cnkgKGEgc2V0J3Mgb3duIGZvbGRlciwgYSBsaXN0ZWQgZG9jdW1lbnQpLCBvciBhIG5vZGUgaW5zaWRlIGEgc2V0LiAqL1xuICAgIHdob2xlOiBib29sZWFuO1xuICAgIGRpcjogYm9vbGVhbjtcbiAgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibGlzdGVkXCIpIHtcbiAgICAgICAgY29uc3Qgb25seSA9IGUubm9kZXNbMF07XG4gICAgICAgIGlmIChlLm5vZGVzLmxlbmd0aCA9PT0gMSAmJiBvbmx5Py5raW5kID09PSBcImRvY1wiICYmIGpvaW4oZS5yb290LCBvbmx5LnJlbCkgPT09IGFicylcbiAgICAgICAgICByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiBmYWxzZSB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IHRydWUsIGRpcjogdHJ1ZSB9O1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlKSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogZmFsc2UsIGRpcjogbm9kZS5raW5kID09PSBcImdyb3VwXCIgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0YCwgNDA0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBgcmF3UGF0aGAgaWYgdGhlIGNvbnRleHQgc2hvd3MgaXQg4oCUIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIGEgc2V0LCBhXG4gICAqIGxpc3RlZCBkb2N1bWVudCwgYSBzZXQncyBvd24gZm9sZGVyIOKAlCBvciBpdCBpcyB0aGUgd29ya3NwYWNlOyByZWZ1c2VkXG4gICAqIG90aGVyd2lzZS4gRm9yIGFjdHMgdGhhdCByZWFjaCBvdXRzaWRlIHRoZSBzcGVsbCAocmV2ZWFsaW5nIGEgcGF0aCBpbiB0aGVcbiAgICogZmlsZSBtYW5hZ2VyKSwgc28gYSBwYWdlIGNhbm5vdCBhaW0gdGhlbSBhdCBhbiBhcmJpdHJhcnkgcGF0aC5cbiAgICovXG4gIHNob3duUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgaWYgKHRoaXMuaXRlbUF0KGFicykpIHJldHVybiBhYnM7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3RpbmF0aW9uT3JEaWUoYWJzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3Qgc2hvd24gaW4gdGhpcyBzZXNzaW9uYCwgNDAwKTtcbiAgICB9XG4gIH1cblxuICAvKiogUmVmdXNlIGEgbmFtZSB0aGF0IGlzIG5vdCBvbmUgcGxhaW4gZmlsZSBvciBmb2xkZXIgbmFtZS4gKi9cbiAgcHJpdmF0ZSBuYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gbmFtZS50cmltKCk7XG4gICAgaWYgKFxuICAgICAgbiA9PT0gXCJcIiB8fFxuICAgICAgbiA9PT0gXCIuXCIgfHxcbiAgICAgIG4gPT09IFwiLi5cIiB8fFxuICAgICAgbi5zdGFydHNXaXRoKFwiLlwiKSB8fFxuICAgICAgL1svXFxcXFxcMF0vLnRlc3QobikgfHxcbiAgICAgIG4ubGVuZ3RoID4gMjU1XG4gICAgKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYFwiJHtuYW1lfVwiIGlzIG5vdCBhIHVzYWJsZSBuYW1lIOKAlCBvbmUgcGxhaW4gbmFtZSwgbm8gc2xhc2hlcywgbm90IHN0YXJ0aW5nIHdpdGggYSBkb3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIHJldHVybiBuO1xuICB9XG5cbiAgLyoqIEEgZG9jdW1lbnQgbmFtZTogYSBuYW1lIHdpdGhvdXQgYSBkb2N1bWVudCBleHRlbnNpb24gZ2V0cyBgLm1kYC4gKi9cbiAgcHJpdmF0ZSBkb2NOYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgcmV0dXJuIGlzRG9jTmFtZShuKSA/IG4gOiBgJHtufS5tZGA7XG4gIH1cblxuICAvKipcbiAgICogQWZ0ZXIgc29tZXRoaW5nIG1vdmVkIG9uIGRpc2sgZnJvbSBgZnJvbWAgdG8gYHRvYCwgYnJpbmcgdGhlIG1vZGVsIHdpdGggaXQ6XG4gICAqIG9wZW5lZCBkb2N1bWVudHMga2VlcCB0aGVpciB2ZXJzaW9ucyB1bmRlciB0aGUgbmV3IHBhdGgsIGVudHJpZXMgcm9vdGVkIGF0XG4gICAqIG9yIGhvbGRpbmcgdGhlIG1vdmVkIHRoaW5nIGZvbGxvdyBpdCwgYW5kIGV2ZXJ5IG1pcnJvciBpcyByZS1yZWFkLiBBbiBlbnRyeVxuICAgKiB0aGF0IG5vdyBzaXRzIGluc2lkZSBhbm90aGVyIHNldCBpcyBkcm9wcGVkIOKAlCB0aGUgc2V0IHNob3dzIGl0IGFscmVhZHkuXG4gICAqL1xuICBwcml2YXRlIGZvbGxvd01vdmUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgbW92ZWQgPSAocDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCA9PlxuICAgICAgcCA9PT0gZnJvbSA/IHRvIDogcC5zdGFydHNXaXRoKGZyb20gKyBzZXApID8gdG8gKyBwLnNsaWNlKGZyb20ubGVuZ3RoKSA6IG51bGw7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBub3cgPSBtb3ZlZChkLm9yaWdpbmFsKTtcbiAgICAgIGlmIChub3cpIHtcbiAgICAgICAgZC5vcmlnaW5hbCA9IG5vdztcbiAgICAgICAgZC5uYW1lID0gYmFzZW5hbWUobm93KTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgZHJvcCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKG9ubHk/LmtpbmQgIT09IFwiZG9jXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChqb2luKGUucm9vdCwgb25seS5yZWwpKTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBkaXJuYW1lKG5vdyk7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdyk7XG4gICAgICAgICAgZS5ub2RlcyA9IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUobm93KSB9XTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3Qgbm93ID0gbW92ZWQoZS5yb290KTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBub3c7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdykgfHwgbm93O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMubS5jb250ZXh0ID0gdGhpcy5tLmNvbnRleHQuZmlsdGVyKChlKSA9PiAhZHJvcC5oYXMoZS5pZCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICB9XG5cbiAgLyoqIEFmdGVyIGEgZmlsZSBvciBmb2xkZXIgbGFuZGVkIGF0IGBhYnNgOiByZS1yZWFkIHRoZSBzZXQgaXQgaXMgaW4sIG9yIGdpdmUgaXQgYW4gZW50cnkuICovXG4gIHByaXZhdGUgYWRvcHROZXcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBzZXQgPSB0aGlzLmNvdmVyaW5nRW50cnkoYWJzKTtcbiAgICBpZiAoc2V0KSB0aGlzLnJlc2NhbihzZXQuaWQpO1xuICAgIGVsc2UgdGhpcy5tLmNvbnRleHQucHVzaChlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCkpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQSBuYW1lIGluIGBkaXJgIHRoYXQgaXMgZnJlZTogYG5hbWVgLCBlbHNlIGBzdGVtIDIuZXh0YCwgYHN0ZW0gMy5leHRgLCDigKYgKi9cbiAgcHJpdmF0ZSBmcmVlTmFtZShkaXI6IHN0cmluZywgbmFtZTogc3RyaW5nLCBpc0RpcjogYm9vbGVhbik6IHN0cmluZyB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuYW1lKSkpIHJldHVybiBuYW1lO1xuICAgIGNvbnN0IGV4dCA9IGlzRGlyID8gXCJcIiA6IGV4dG5hbWUobmFtZSk7XG4gICAgY29uc3Qgc3RlbSA9IGV4dCA/IG5hbWUuc2xpY2UoMCwgLWV4dC5sZW5ndGgpIDogbmFtZTtcbiAgICBmb3IgKGxldCBpID0gMjsgOyBpKyspIHtcbiAgICAgIGNvbnN0IG4gPSBgJHtzdGVtfSAke2l9JHtleHR9YDtcbiAgICAgIGlmICghZXhpc3RzU3luYyhqb2luKGRpciwgbikpKSByZXR1cm4gbjtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlZnVzZUV4aXN0aW5nKGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKGV4aXN0c1N5bmMoYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBhbHJlYWR5IGV4aXN0cyDigJQgbm90aGluZyB3YXMgb3ZlcndyaXR0ZW5gLCA0MDkpO1xuICB9XG5cbiAgY3JlYXRlRG9jKHJhd0Rpcjogc3RyaW5nLCBuYW1lPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0Rpcik7XG4gICAgY29uc3QgZmlsZSA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJVbnRpdGxlZC5tZFwiLCBmYWxzZSkgOiB0aGlzLmRvY05hbWVPckRpZShuYW1lKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgZmlsZSk7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCBcIlwiLCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICBjcmVhdGVGb2xkZXIocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmb2xkZXIgPVxuICAgICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gdGhpcy5mcmVlTmFtZShkaXIsIFwiTmV3IGZvbGRlclwiLCB0cnVlKSA6IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmb2xkZXIpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcoYWJzKTtcbiAgICBta2RpclN5bmMoYWJzKTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogRTI2OiB3aGF0IGEgbW92ZSBXT1VMRCBkbywgZm9yIHRoZSBjb25maXJtYXRpb24gdGhlIHN1cmZhY2Ugc2hvd3MgYmVmb3JlXG4gICAqIG1vdmluZyBhIEZPTERFUi4gUmVhZHMgbm90aGluZyBidXQgdGhlIGRpc2sgYW5kIHJlZnVzZXMgZXhhY3RseSB3aGF0XG4gICAqIGBtb3ZlYCB3b3VsZCByZWZ1c2UsIHNvIGEgY29uZmlybWVkIG1vdmUgY2Fubm90IHRoZW4gZmFpbCBvbiBhZG1pc3Npb24uXG4gICAqXG4gICAqIFRoZSBnaXQgaGFsZiBpcyBoZXJlIGJlY2F1c2Ugb25seSB0aGUgZGFlbW9uIGNhbiBzZWUgYSBgLmdpdGA6IGEgZm9sZGVyXG4gICAqIGRyYWdnZWQgb3V0IG9mIGEgcmVwb3NpdG9yeSBpcyB0aGUgY2FzZSB3aGVyZSB0aGUgY29uc2VxdWVuY2UgcmVhY2hlcyBwYXN0XG4gICAqIHNjcmlwdG9yaXVtIChDb2xlIG1vdmVkIHRoaXMgcHJvamVjdCdzIG93biBkb2NzIGZvbGRlciBpbnRvIGhpcyB3b3Jrc3BhY2UsXG4gICAqIGFuZCBnaXQgc2F3IHNpeCBkZWxldGVkIGZpbGVzKS5cbiAgICovXG4gIG1vdmVQbGFuKHJhd1BhdGg6IHN0cmluZywgcmF3SW50bzogc3RyaW5nKTogTW92ZVBsYW4ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBjb25zdCBpbnRvID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8pO1xuICAgIGNvbnN0IGZyb21SZXBvID0gZ2l0Um9vdE9mKGRpcm5hbWUoaXRlbS5hYnMpKTtcbiAgICBjb25zdCBpbnRvUmVwbyA9IGdpdFJvb3RPZihpbnRvKTtcbiAgICByZXR1cm4ge1xuICAgICAgZnJvbTogaXRlbS5hYnMsXG4gICAgICBpbnRvLFxuICAgICAgbmFtZTogYmFzZW5hbWUoaXRlbS5hYnMpLFxuICAgICAgZm9sZGVyOiBpdGVtLmRpcixcbiAgICAgIGRvY3M6IGl0ZW0uZGlyID8gY291bnREb2NzKGl0ZW0uYWJzKSA6IDEsXG4gICAgICByZXBvOiBmcm9tUmVwbyA/IGJhc2VuYW1lKGZyb21SZXBvKSA6IG51bGwsXG4gICAgICBsZWF2ZXNSZXBvOiBmcm9tUmVwbyAhPT0gbnVsbCAmJiBmcm9tUmVwbyAhPT0gaW50b1JlcG8sXG4gICAgfTtcbiAgfVxuXG4gIG1vdmUocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBjb25zdCBpbnRvID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8pO1xuICAgIGlmIChpbnRvID09PSBpdGVtLmFicyB8fCBpbnRvLnN0YXJ0c1dpdGgoaXRlbS5hYnMgKyBzZXApKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgY2Fubm90IG1vdmUgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpbnRvIGl0c2VsZmAsIDQwMCk7XG4gICAgaWYgKGRpcm5hbWUoaXRlbS5hYnMpID09PSBpbnRvKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIHRoYXQgZm9sZGVyYCwgNDAwKTtcbiAgICBjb25zdCB0byA9IGpvaW4oaW50bywgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKHRvKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgaWYgKCF0aGlzLml0ZW1BdCh0bykpIHRoaXMuYWRvcHROZXcodG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICB9XG5cbiAgcmVuYW1lKHJhd1BhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZyb206IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgbGV0IG5leHQgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICAvLyBBIGRvY3VtZW50IGtlZXBzIGEgZG9jdW1lbnQgZXh0ZW5zaW9uOiBcIm5vdGVzXCIgcmVuYW1lcyBub3Rlcy5tZCB0b1xuICAgIC8vIG5vdGVzLm1kLCBub3QgdG8gYW4gZXh0ZW5zaW9ubGVzcyBmaWxlIFNjcmlwdG9yaXVtIHdvdWxkIHN0b3Agc2hvd2luZy5cbiAgICBpZiAoIWl0ZW0uZGlyICYmICFpc0RvY05hbWUobmV4dCkpIG5leHQgKz0gZXh0bmFtZShpdGVtLmFicykgfHwgXCIubWRcIjtcbiAgICBjb25zdCB0byA9IGpvaW4oZGlybmFtZShpdGVtLmFicyksIG5leHQpO1xuICAgIGlmICh0byA9PT0gaXRlbS5hYnMpIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICAgIC8vIEEgY2FzZS1vbmx5IHJlbmFtZSBvbiBhIGNhc2UtaW5zZW5zaXRpdmUgZGlzayBmaW5kcyBcIml0c2VsZlwiIGV4aXN0aW5nLlxuICAgIGlmICh0by50b0xvd2VyQ2FzZSgpICE9PSBpdGVtLmFicy50b0xvd2VyQ2FzZSgpKSB0aGlzLnJlZnVzZUV4aXN0aW5nKHRvKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICBwcml2YXRlIHJlbmFtZU9yRGllKGZyb206IHN0cmluZywgdG86IHN0cmluZyk6IHZvaWQge1xuICAgIHRyeSB7XG4gICAgICByZW5hbWVTeW5jKGZyb20sIHRvKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgY29kZSA9PT0gXCJFWERFVlwiXG4gICAgICAgICAgPyBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byBhbm90aGVyIGRpc2sgKCR7dG99KSDigJQgY29weSBpdCBpbnN0ZWFkYFxuICAgICAgICAgIDogYGNhbm5vdCBtb3ZlICR7ZnJvbX0gdG8gJHt0b306ICR7Y29kZSA/PyBTdHJpbmcoZSl9YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogV2hldGhlciBgYWJzYCBpcyBzaG93biBhbnl3aGVyZSBpbiB0aGUgY29udGV4dCBub3cuICovXG4gIHByaXZhdGUgaXRlbUF0KGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuaXRlbU9yRGllKGFicyk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvKiogXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiIOKAlCBuZXZlciBmcm9tIGRpc2sgKEUyNCkuICovXG4gIGhpZGUocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmc7IHJlbW92ZWRFbnRyeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgaWYgKGl0ZW0ud2hvbGUpIHtcbiAgICAgIHRoaXMucmVtb3ZlQ29udGV4dChpdGVtLmVudHJ5LmlkKTtcbiAgICAgIHJldHVybiB7IHBhdGg6IGl0ZW0uYWJzLCBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVtb3ZlZEVudHJ5OiB0cnVlIH07XG4gICAgfVxuICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUoaXRlbS5lbnRyeS5yb290LCBpdGVtLmFicykpO1xuICAgIGl0ZW0uZW50cnkuaGlkZGVuID0gWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSkuZmlsdGVyKChoKSA9PiBoICE9PSByZWwpLCByZWxdO1xuICAgIHRoaXMucmVzY2FuKGl0ZW0uZW50cnkuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGl0ZW0uYWJzLCBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVtb3ZlZEVudHJ5OiBmYWxzZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBoaWRkZW4gbGlzdCBvZiB0aGUgZW50cnkgYSBwYXRoIGJlbG9uZ3MgdG8sIEJFRk9SRSBhbnl0aGluZyBjaGFuZ2VzIGl0XG4gICAqIOKAlCB3aGF0IEU2MCByZWNvcmRzIHNvIGEgaGlkZSBjYW4gYmUgcHV0IGJhY2sgZXhhY3RseS5cbiAgICovXG4gIGhpZGRlbkJlZm9yZShyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgICAgcmV0dXJuIHsgZW50cnk6IGl0ZW0uZW50cnkuaWQsIHJlbHM6IFsuLi4oaXRlbS5lbnRyeS5oaWRkZW4gPz8gW10pXSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgLyoqIFRoZSBzYW1lLCBhZGRyZXNzZWQgYnkgZW50cnkg4oCUIHdoYXQgYHVuaGlkZWAgbmVlZHMgcmVjb3JkZWQuICovXG4gIGhpZGRlbk9mRW50cnkoZW50cnlJZDogc3RyaW5nKTogeyBlbnRyeTogc3RyaW5nOyByZWxzOiBzdHJpbmdbXSB9IHwgbnVsbCB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIHJldHVybiBlID8geyBlbnRyeTogZS5pZCwgcmVsczogWy4uLihlLmhpZGRlbiA/PyBbXSldIH0gOiBudWxsO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IHRvIGV4YWN0bHkgYHJlbHNgIChFNjAncyBpbnZlcnNlIG9mIGJvdGggaGlkZVxuICAgKiBhbmQgdW5oaWRlKS4gUmV0dXJucyB3aGF0IGl0IFdBUywgc28gdGhlIGNhbGxlciBjYW4gYnVpbGQgdGhlIG9wcG9zaXRlIGFjdFxuICAgKiB3aXRob3V0IHJlYWRpbmcgc3RhdGUgaXQgaGFzIGFscmVhZHkgY2hhbmdlZC5cbiAgICovXG4gIHJlc3RvcmVIaWRkZW4oZW50cnlJZDogc3RyaW5nLCByZWxzOiBzdHJpbmdbXSk6IHsgZW50cnk6IHN0cmluZzsgd2FzOiBzdHJpbmdbXSB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3Qgd2FzID0gWy4uLihlLmhpZGRlbiA/PyBbXSldO1xuICAgIGlmIChyZWxzLmxlbmd0aCA9PT0gMCkgZGVsZXRlIGUuaGlkZGVuO1xuICAgIGVsc2UgZS5oaWRkZW4gPSBbLi4ucmVsc107XG4gICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHdhcyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSBzb21ldGhpbmcgdGhpcyBzZXNzaW9uIGNyZWF0ZWQgKEU2MCdzIHVuZG8gb2YgYSBjcmVhdGlvbikuXG4gICAqXG4gICAqIOKblCBBIE5PTi1FTVBUWSBESVJFQ1RPUlkgSVMgUkVGVVNFRCwgYW5kIG5vIGRpYWxvZyBjYW4gYXV0aG9yaXNlIGl0LiBVbmRvXG4gICAqIHdvcmtzIGJhY2t3YXJkcywgc28gaXQgZW1wdGllcyBhIGZvbGRlciBiZWZvcmUgaXQgcmVhY2hlcyB0aGF0IGZvbGRlcidzXG4gICAqIGNyZWF0aW9uOyBpZiB0aGUgZm9sZGVyIHN0aWxsIGhhcyBjb250ZW50cyB0aGVuIHNvbWV0aGluZyBwdXQgdGhlbSB0aGVyZVxuICAgKiB0aGF0IHRoZSBoaXN0b3J5IGRvZXMgbm90IGtub3cgYWJvdXQsIGFuZCByZW1vdmluZyBhIGRpcmVjdG9yeSBUUkVFIGlzIGFcbiAgICogZGlmZmVyZW50IGFjdCBmcm9tIHJlbW92aW5nIHRoZSBlbXB0eSB0aGluZyB5b3UganVzdCBtYWRlLiAoQ29sZSBydWxlZCB0aGVcbiAgICogZmlsZSBjYXNlIHRoZSBvdGhlciB3YXkg4oCUIGNvbmZpcm1lZCwgbm90IHJlZnVzZWQg4oCUIGFuZCB0aGlzIGxpbWl0IGlzIHRoZVxuICAgKiBjYXJ2ZS1vdXQgaGUgYWNjZXB0ZWQuKVxuICAgKlxuICAgKiDimqAgSXQgYWxzbyByZWZ1c2VzIGFueXRoaW5nIHRoYXQgaXMgbm90IHdoZXJlIHRoZSBoaXN0b3J5IHNhaWQgaXQgd2FzOiBhXG4gICAqIHBhdGggdGhhdCBoYXMgYmVjb21lIGEgZGlyZWN0b3J5LCBvciBhIGRpcmVjdG9yeSB0aGF0IGhhcyBiZWNvbWUgYSBmaWxlLFxuICAgKiBtZWFucyB0aGUgd29ybGQgbW92ZWQgYW5kIHRoZSByZWNvcmRlZCBpbnZlcnNlIG5vIGxvbmdlciBkZXNjcmliZXMgaXQuXG4gICAqL1xuICByZW1vdmVDcmVhdGVkKHJhd1BhdGg6IHN0cmluZywgZGlyOiBib29sZWFuKTogeyBwYXRoOiBzdHJpbmc7IHJlbW92ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICB0cnkge1xuICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQWxyZWFkeSBnb25lOiB0aGUgdW5kbyBoYXMgbm90aGluZyB0byBkbywgd2hpY2ggaXMgbm90IGFuIGVycm9yLlxuICAgICAgcmV0dXJuIHsgcGF0aDogYWJzLCByZW1vdmVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSAhPT0gZGlyKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzICR7c3QuaXNEaXJlY3RvcnkoKSA/IFwiYSBmb2xkZXJcIiA6IFwiYSBmaWxlXCJ9IG5vdyDigJQgdGhlIGNoYW5nZSB0aGlzIHdvdWxkIHVuZG8gbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdGAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgaWYgKGRpcikge1xuICAgICAgY29uc3QgbGVmdCA9IHJlYWRkaXJTeW5jKGFicyk7XG4gICAgICBpZiAobGVmdC5sZW5ndGggPiAwKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGAke3RoaXMuZGlzcGxheShhYnMpfSBpcyBub3QgZW1wdHkgKCR7bGVmdC5sZW5ndGh9IGl0ZW0ke2xlZnQubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifSkg4oCUIG1vdmUgd2hhdCBpcyBpbnNpZGUgaXQgb3V0IGZpcnN0YCxcbiAgICAgICAgICA0MDksXG4gICAgICAgICAgbGVmdC5zbGljZSgwLCAxMCksXG4gICAgICAgICk7XG4gICAgICBybWRpclN5bmMoYWJzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdW5saW5rU3luYyhhYnMpO1xuICAgIH1cbiAgICB0aGlzLmZvcmdldFBhdGgoYWJzKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMsIHJlbW92ZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeXRoaW5nIHdvcnRoIGxvb2tpbmcgYXQgaW4gdGhpcyBzZXNzaW9uLCB3aXRoIHRoZSB2ZXJiIGZvciBlYWNoIChFNjIpLlxuICAgKlxuICAgKiDim5QgSVQgT05MWSBMT09LUy4gUmVwYWlyaW5nIHdvdWxkIG1lYW4gZGVjaWRpbmcgZm9yIHRoZSBodW1hbiB0aGF0IGEgZ2hvc3RcbiAgICogZW50cnkgaXMgbm90IHdhbnRlZCBiYWNrIGFuZCB0aGF0IHZlcnNpb25zIGhlbGQgZm9yIGEgdmFuaXNoZWQgZmlsZSBhcmUgbm90XG4gICAqIHdvcnRoIHNhdmluZyDigJQgYm90aCBvZiB3aGljaCBhcmUgdGhlaXJzIHRvIGRlY2lkZSAoQ29sZTogXCJyZXBvcnQsIG5hbWUgdGhlXG4gICAqIHZlcmIsIGxldCB5b3UgZGVjaWRlXCIpLlxuICAgKlxuICAgKiDimqAgYGV4aXN0c1N5bmNgIHBlciBkb2N1bWVudCBhbmQgcGVyIG5vZGUsIHdoaWNoIGlzIHRoZSBvbmUgY29zdCBoZXJlLiBJdCBpc1xuICAgKiBib3VuZGVkIGJ5IHRoZSBjb250ZXh0IHRoZSBodW1hbiBjaG9zZSBhbmQgcnVucyBvbiBkZW1hbmQgcGx1cyBvbmNlIGF0XG4gICAqIHN0YXJ0dXAsIG5vdCBvbiBhIHRpbWVyLlxuICAgKi9cbiAgY2hlY2t1cCgpOiBGaW5kaW5nW10ge1xuICAgIGNvbnN0IG5vZGVzOiB7IGVudHJ5OiBzdHJpbmc7IHBhdGg6IHN0cmluZzsgc2hvd246IHN0cmluZzsgZXhpc3RzOiBib29sZWFuIH1bXSA9IFtdO1xuICAgIGNvbnN0IGxpbmtzOiB7IGVudHJ5OiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGRhbmdsaW5nOiBudW1iZXIgfVtdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBmb3IgKGNvbnN0IHAgb2YgZG9jUGF0aHMoZSkpXG4gICAgICAgIG5vZGVzLnB1c2goeyBlbnRyeTogZS5pZCwgcGF0aDogcCwgc2hvd246IHRoaXMuZGlzcGxheShwKSwgZXhpc3RzOiBleGlzdHNTeW5jKHApIH0pO1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSBjb250aW51ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGUuaWQpO1xuICAgICAgICBpZiAoZy5kYW5nbGluZyA+IDApXG4gICAgICAgICAgbGlua3MucHVzaCh7IGVudHJ5OiBlLmlkLCBsYWJlbDogZS5sYWJlbCA/PyBiYXNlbmFtZShlLnJvb3QpLCBkYW5nbGluZzogZy5kYW5nbGluZyB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBBIHNldCB0aGF0IGNhbm5vdCBiZSBtYXBwZWQgaXMgbm90IGEgZmluZGluZyBhYm91dCBsaW5rcy5cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZpbmRpbmdzKHtcbiAgICAgIGRvY3M6IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gKHtcbiAgICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICBleGlzdHM6IGV4aXN0c1N5bmMoZC5vcmlnaW5hbCksXG4gICAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICAgIH0pKSxcbiAgICAgIG5vZGVzLFxuICAgICAgbGlua3MsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgZG9jdW1lbnQgd2hvc2UgZmlsZSBvZiByZWNvcmQgaXMgZ29uZSAoRTYxKS5cbiAgICpcbiAgICog4puUIFRIRSBXQVJOSU5HIEhBRCBOTyBBTlNXRVIsIFdISUNIIElTIFdIWSBUSElTIEVYSVNUUy4gV2hlbiBhIGRvY3VtZW50J3NcbiAgICogb3JpZ2luYWwgZGlzYXBwZWFycyBiZXR3ZWVuIHNlc3Npb25zLCByZXN0b3JlIHNheXMgc28gb24gcHVycG9zZSDigJQgXCJnb25lXG4gICAqIGZyb20gZGlzayBzaW5jZSB0aGlzIHNlc3Npb24gd2FzIGxhc3Qgb3Blbi4gU2F2ZSB3b3VsZCByZWNyZWF0ZSBpdFwiIOKAlCBhbmRcbiAgICogdGhhdCBpcyB0aGUgUklHSFQgdGhpbmcgdG8gc2F5LCBiZWNhdXNlIHRoZSBzZXNzaW9uIGlzIHN0aWxsIGhvbGRpbmcgdGhlXG4gICAqIGNvbnRlbnQgYW5kIG9mZmVyaW5nIGl0IGJhY2suIFdoYXQgd2FzIG1pc3Npbmcgd2FzIGFueSB3YXkgdG8gcmVwbHkgXCJubywgSVxuICAgKiBtZWFudCB0byBkZWxldGUgdGhhdFwiOiB0aGUgbm90aWNlIHJlcGVhdGVkIG9uIGV2ZXJ5IHJlc3RvcmUgZm9yZXZlciBhbmQgdGhlXG4gICAqIG9ubHkgZXNjYXBlIHdhcyByZWNyZWF0aW5nIHRoZSBzZXNzaW9uLiBBIHdhcm5pbmcgd2l0aCBubyBjb3JyZXNwb25kaW5nIGFjdFxuICAgKiBpcyB0aGUgc2hhcGUgdGhpcyBzcGVsbCBrZWVwcyB0cnlpbmcgbm90IHRvIGhhdmUuXG4gICAqXG4gICAqIOKblCBSRUZVU0VEIFdISUxFIFRIRSBGSUxFIEVYSVNUUywgYW5kIHRoZSByZWZ1c2FsIG5hbWVzIHRoZSByaWdodCB2ZXJiLlxuICAgKiBGb3JnZXR0aW5nIGEgTElWRSBkb2N1bWVudCdzIHJlY29yZCB3b3VsZCB0aHJvdyBhd2F5IGl0cyB2ZXJzaW9uIGhpc3RvcnlcbiAgICogd2hpbGUgdGhlIGRvY3VtZW50IGl0c2VsZiBzaXRzIHRoZXJlIG9uIGRpc2sg4oCUIHRoZSBjb25mdXNpb24gdGhpcyBtdXN0IG5vdFxuICAgKiBlbmFibGUuIFRha2luZyBzb21ldGhpbmcgb3V0IG9mIHRoZSBzaWRlYmFyIGlzIGBoaWRlYDsgdGhpcyBpcyBvbmx5IGZvciBhXG4gICAqIHJlY29yZCB3aG9zZSBzdWJqZWN0IGlzIGdvbmUuXG4gICAqXG4gICAqIOKaoCBUaGUgdmVyc2lvbiBmaWxlcyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIGFyZSBMRUZUIHdoZXJlIHRoZXkgYXJlLCBhc1xuICAgKiB3aXRoIHVuZG8ncyBkZWxldGU6IG5vdGhpbmcgcmVhZHMgdGhlbSBvbmNlIHRoZSByZWNvcmQgaXMgZ29uZSwgYW5kXG4gICAqIHJlbW92aW5nIHRoZW0gd291bGQgYmUgYSBzZWNvbmQgZGVsZXRpb24gbm9ib2R5IGFza2VkIGZvci5cbiAgICovXG4gIGZvcmdldERvYyhyZWY/OiBzdHJpbmcpOiB7IHNsdWc6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uczogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHJlZik7XG4gICAgaWYgKGV4aXN0c1N5bmMoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoZC5vcmlnaW5hbCl9IGlzIHN0aWxsIG9uIGRpc2sg4oCUIGZvcmdldCBpcyBmb3IgYSBkb2N1bWVudCB3aG9zZSBmaWxlIGlzIGdvbmUuIFRvIHRha2UgaXQgb3V0IG9mIHRoZSBjb250ZXh0LCByZW1vdmUgaXQgZnJvbSBTY3JpcHRvcml1bSBpbnN0ZWFkLmAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgZm9yZ290dGVuID0ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5sZW5ndGgsXG4gICAgfTtcbiAgICB0aGlzLm0uZG9jcyA9IHRoaXMubS5kb2NzLmZpbHRlcigoeCkgPT4geC5zbHVnICE9PSBkLnNsdWcpO1xuICAgIGlmICh0aGlzLm0ub3BlbkRvYyA9PT0gZC5zbHVnKSB0aGlzLm0ub3BlbkRvYyA9IHRoaXMubS5kb2NzWzBdPy5zbHVnID8/IG51bGw7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gZm9yZ290dGVuO1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBhIHBhdGggdGhhdCBpcyBubyBsb25nZXIgb24gZGlzazogcHJ1bmUgaXQgZnJvbSBldmVyeSBjb250ZXh0IGVudHJ5LFxuICAgKiBkcm9wIHRoZSBlbnRyeSBpZiB0aGF0IGVtcHRpZXMgaXQsIGFuZCBmb3JnZXQgYW55IGRvY3VtZW50IHJlY29yZCBmb3IgaXQuXG4gICAqXG4gICAqIOKblCBgcmVzY2FuYCBJUyBOT1QgRU5PVUdILCBBTkQgVEhBVCBXQVMgVEhFIEJVRy4gSXQgcmV0dXJucyBlYXJseSBmb3IgYW55XG4gICAqIGVudHJ5IHdob3NlIG1lbWJlcnNoaXAgaXMgbm90IGBtaXJyb3JlZGAg4oCUIGFuZCBhIHNpbmdsZSBkb2N1bWVudCBpcyBhXG4gICAqIGBsaXN0ZWRgIGVudHJ5LCBzbyBkZWxldGluZyBvbmUgbGVmdCBpdHMgbm9kZSBpbiB0aGUgc2lkZWJhciBmb3JldmVyIHdoaWxlXG4gICAqIHRoZSBmaWxlIHdhcyBnb25lIGZyb20gdGhlIGRpc2suIENvbGUgZm91bmQgaXQgd2l0aGluIGEgbWludXRlIG9mIEU2MFxuICAgKiBzaGlwcGluZzogXCJpdCdzIG5vdCBiZWluZyByZW1vdmVkIGZyb20gdGhlIHNpZGViYXLigKYgdGhlbiBJIGNyZWF0ZWQgYW5vdGhlclxuICAgKiBkb2N1bWVudCBhbHNvIHVudGl0bGVkIGFuZCBJIHRoaW5rIHRoZXJlIG1pZ2h0IGhhdmUgYmVlbiBldmVuIGEgd2VpcmRcbiAgICogbmFtaW5nIGlzc3VlXCIuXG4gICAqXG4gICAqIOKaoCBUSEUgTkFNSU5HIE9ERElUWSBXQVMgVEhFIFNFQ09ORCBIQUxGIE9GIFRIRSBTQU1FIEJVRy4gVGhlIGBEb2NSZWNvcmRgXG4gICAqIG91dGxpdmVkIHRoZSBmaWxlIHRvbywgc28gaXRzIFNMVUcgc3RheWVkIHRha2VuIGFuZCB0aGUgbmV4dCBgVW50aXRsZWQubWRgXG4gICAqIGJlY2FtZSBgdW50aXRsZWQtMmAgd2hpbGUgdGhlIGZpbGUgb24gZGlzayB3YXMgcGxhaW4gYFVudGl0bGVkLm1kYC4gQVxuICAgKiByZWNvcmQgZm9yIGEgZG9jdW1lbnQgdGhhdCBkb2VzIG5vdCBleGlzdCBoYXMgbm8gcmVhZGVyOyBpdCBvbmx5IGdldHMgaW5cbiAgICogdGhlIHdheSBvZiB0aGUgbmV4dCBvbmUuXG4gICAqXG4gICAqIOKaoCBUaGUgdmVyc2lvbiBmaWxlcyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIGFyZSBMRUZUIHdoZXJlIHRoZXkgYXJlLiBUaGVcbiAgICogcmVjb3JkIGlzIGdvbmUsIHNvIG5vdGhpbmcgcmVhZHMgdGhlbSwgYW5kIHJlbW92aW5nIHRoZW0gd291bGQgYmUgYSBzZWNvbmRcbiAgICogZGVsZXRpb24gdGhlIGh1bWFuIHdhcyBuZXZlciBhc2tlZCBhYm91dCDigJQgdGhlIGRpYWxvZyBwcm9taXNlZCB0aGUgY3JlYXRlZFxuICAgKiBmaWxlLCBub3QgdGhlIHNlc3Npb24ncyBvd24gY29waWVzLlxuICAgKi9cbiAgcHJpdmF0ZSBmb3JnZXRQYXRoKGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaW5zaWRlID0gKHA6IHN0cmluZykgPT4gcCA9PT0gYWJzIHx8IHAuc3RhcnRzV2l0aChhYnMgKyBzZXApO1xuICAgIGZvciAoY29uc3QgZSBvZiBbLi4udGhpcy5tLmNvbnRleHRdKSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgIWluc2lkZShlLnJvb3QpKSB7XG4gICAgICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIEEgYGxpc3RlZGAgZW50cnkgKG9yIGEgbWlycm9yZWQgb25lIHRoYXQgV0FTIHRoZSBkZWxldGVkIGZvbGRlcik6XG4gICAgICAvLyBwcnVuZSB0aGUgbm9kZXMgYnkgaGFuZCwgc2luY2UgYHJlc2NhbmAgd2lsbCBub3QgbG9vayBhdCBpdC5cbiAgICAgIGNvbnN0IHBydW5lID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKTogQ29udGV4dE5vZGVbXSA9PlxuICAgICAgICBub2Rlc1xuICAgICAgICAgIC5maWx0ZXIoKG4pID0+ICFpbnNpZGUoam9pbihlLnJvb3QsIG4ucmVsKSkpXG4gICAgICAgICAgLm1hcCgobikgPT4gKG4ua2luZCA9PT0gXCJncm91cFwiID8geyAuLi5uLCBjaGlsZHJlbjogcHJ1bmUobi5jaGlsZHJlbikgfSA6IG4pKTtcbiAgICAgIGUubm9kZXMgPSBwcnVuZShlLm5vZGVzKTtcbiAgICAgIGlmIChlLm5vZGVzLmxlbmd0aCA9PT0gMCB8fCBpbnNpZGUoZS5yb290KSkgdGhpcy5yZW1vdmVDb250ZXh0KGUuaWQpO1xuICAgIH1cbiAgICAvLyBBIHJlY29yZCBmb3IgYSBmaWxlIHRoYXQgaXMgZ29uZSBoYXMgbm8gcmVhZGVyLCBhbmQgaXRzIHNsdWcgd291bGRcbiAgICAvLyBvdGhlcndpc2Ugc3RheSB0YWtlbi5cbiAgICB0aGlzLm0uZG9jcyA9IHRoaXMubS5kb2NzLmZpbHRlcigoZCkgPT4gIWluc2lkZShkLm9yaWdpbmFsKSk7XG4gICAgaWYgKHRoaXMubS5vcGVuRG9jICYmICF0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSlcbiAgICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5tLmRvY3NbMF0/LnNsdWcgPz8gbnVsbDtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIHVuaGlkZShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlc3RvcmVkOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHJlc3RvcmVkID0gZS5oaWRkZW4/Lmxlbmd0aCA/PyAwO1xuICAgIGRlbGV0ZSBlLmhpZGRlbjtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBlLmlkLCByZXN0b3JlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEUyMjogYSBzaW5nbGUgZG9jdW1lbnQgYmVjb21lcyBhIHNldCDigJQgYSBmb2xkZXIgbmFtZWQgZm9yIGl0IGJlc2lkZSBpdCwgdGhlXG4gICAqIGRvY3VtZW50IG1vdmVkIGluLCBhbmQgdGhlIGVudHJ5IChzYW1lIGlkKSBub3cgbWlycm9ycyB0aGF0IGZvbGRlci5cbiAgICovXG4gIG1ha2VTZXQocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZvbGRlcjogc3RyaW5nOyBlbnRyeTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS5lbnRyeS5tZW1iZXJzaGlwICE9PSBcImxpc3RlZFwiIHx8IGl0ZW0uZGlyKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaXMgYWxyZWFkeSBpbiBhIHNldCDigJQgbWFrZSBhIGZvbGRlciB0aGVyZSBpbnN0ZWFkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGl0ZW0uYWJzKTtcbiAgICBjb25zdCBzdGVtID0gYmFzZW5hbWUoaXRlbS5hYnMsIGV4dG5hbWUoaXRlbS5hYnMpKSB8fCBcIlVudGl0bGVkXCI7XG4gICAgY29uc3QgZm9sZGVyID0gam9pbihwYXJlbnQsIHRoaXMuZnJlZU5hbWUocGFyZW50LCBzdGVtLCB0cnVlKSk7XG4gICAgbWtkaXJTeW5jKGZvbGRlcik7XG4gICAgY29uc3QgdG8gPSBqb2luKGZvbGRlciwgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgY29uc3QgZSA9IGl0ZW0uZW50cnk7XG4gICAgZS5tZW1iZXJzaGlwID0gXCJtaXJyb3JlZFwiO1xuICAgIGUucm9vdCA9IGZvbGRlcjtcbiAgICBlLmxhYmVsID0gYmFzZW5hbWUoZm9sZGVyKTtcbiAgICBlLm5vZGVzID0gW107XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZvbGRlciwgZW50cnk6IGUuaWQgfTtcbiAgfVxuXG4gIC8qKiBUaGUgbW9zdCB0ZXh0IG9uZSBpbXBvcnQgY2FycmllcyDigJQgYSBkb2N1bWVudCwgbm90IGEgZGF0YSBkdW1wLiAqL1xuICBzdGF0aWMgcmVhZG9ubHkgSU1QT1JUX01BWF9CWVRFUyA9IDggKiAxMDI0ICogMTAyNDtcblxuICAvKipcbiAgICogRTIzJ3MgZHJvcDogYSBDT1BZIG9mIGEgZmlsZSdzIHRleHQsIHdyaXR0ZW4gdW5kZXIgYSBmcmVlIG5hbWUgaW50byBgaW50b2BcbiAgICogKGRlZmF1bHQ6IHRoZSB3b3Jrc3BhY2UpLCB0aGVuIHNob3duIGxpa2UgYW55IG90aGVyIGRvY3VtZW50LlxuICAgKi9cbiAgaW1wb3J0VGV4dChuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgcmF3SW50bz86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGZpbGUgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICBpZiAoIWlzRG9jTmFtZShmaWxlKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBub3QgYSBkb2N1bWVudCBTY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2ZpbGV9YCxcbiAgICAgICAgNDAwLFxuICAgICAgICBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgKTtcbiAgICBpZiAoQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCkgPiBTZXNzaW9uLklNUE9SVF9NQVhfQllURVMpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtmaWxlfSBpcyBsYXJnZXIgdGhhbiAke1Nlc3Npb24uSU1QT1JUX01BWF9CWVRFUyAvIDEwMjQgLyAxMDI0fSBNQiDigJQgbm90IGltcG9ydGVkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byA/PyB0aGlzLndvcmtzcGFjZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIHRoaXMuZnJlZU5hbWUoZGlyLCBmaWxlLCBmYWxzZSkpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB0ZXh0LCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvLyDilIDilIAgY2hhdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvLyDilIDilIAgdGhlIHdvcmsgcXVldWUgKEU1MCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFN0YXJ0IGEgdGFzay4gSXQgaXMgQU5OT1VOQ0VEIGFzIGEgY2hhdCBtZXNzYWdlIGFuZCByZWNvcmRlZCBhcyBhIHRhc2sgYXRcbiAgICogdGhlIHNhbWUgbW9tZW50IOKAlCBDb2xlJ3MgZnJhbWluZywgXCJhIG1lc3NhZ2UgdGhhdCBjYW4gYmUgbWFya2VkIGRvbmVcIiDigJRcbiAgICogc28gdGhlIGNvbnZlcnNhdGlvbiByZWFkcyBhcyBhIG5hcnJhdGl2ZSBhbmQgdGhlIHF1ZXVlIHJlYWRzIGFzIHN0YXRlLFxuICAgKiBvdmVyIG9uZSBmYWN0IHJhdGhlciB0aGFuIHR3by5cbiAgICovXG4gIHN0YXJ0VGFzayh0ZXh0OiBzdHJpbmcsIHdobzogVmVyc2lvbkF1dGhvcik6IFRhc2sge1xuICAgIGNvbnN0IGJvZHkgPSB0ZXh0LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIHRhc2sgbmVlZHMgdG8gc2F5IHdoYXQgdGhlIHdvcmsgaXNcIiwgNDAwKTtcbiAgICBjb25zdCBtZXNzYWdlID0gdGhpcy5hZGRNZXNzYWdlKHdobywgYm9keSk7XG4gICAgY29uc3QgdGFzazogVGFzayA9IHtcbiAgICAgIGlkOiBgdC0ke3JhbmRIZXgoNCl9YCxcbiAgICAgIHRleHQ6IGJvZHksXG4gICAgICB3aG8sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBtZXNzYWdlSWQ6IG1lc3NhZ2UuaWQsXG4gICAgfTtcbiAgICB0aGlzLm0udGFza3MgPSBbLi4uKHRoaXMubS50YXNrcyA/PyBbXSksIHRhc2tdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgcHJpdmF0ZSB0YXNrT3JEaWUoaWQ6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maW5kKCh0KSA9PiB0LmlkID09PSBpZCk7XG4gICAgaWYgKCF0YXNrKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIHRhc2sgJHtpZH0gaW4gdGhpcyBzZXNzaW9uYCxcbiAgICAgICAgNDA0LFxuICAgICAgICAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuZG9uZUF0ID09PSB1bmRlZmluZWQpLm1hcCgodCkgPT4gdC5pZCksXG4gICAgICApO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqIFNheSB3aGF0IGlzIGJlaW5nIGRvbmUgcmlnaHQgbm93IOKAlCBmb3Igd29yayB3aXRoIHN0ZXBzIHdvcnRoIHdhdGNoaW5nLiAqL1xuICBzZXRUYXNrU3RhdHVzKGlkOiBzdHJpbmcsIHN0YXR1czogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICBpZiAodGFzay5kb25lQXQgIT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRhc2sgJHtpZH0gaXMgYWxyZWFkeSBkb25lIOKAlCBpdHMgc3RhdHVzIGNhbm5vdCBjaGFuZ2VgLCA0MDkpO1xuICAgIHRhc2suc3RhdHVzID0gc3RhdHVzLnRyaW0oKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBNYXJrIGl0IGRvbmUuIElkZW1wb3RlbnQgb24gcHVycG9zZTogYSB0YXNrIGZpbmlzaGVkIHR3aWNlIOKAlCBhbiBhZ2VudFxuICAgKiByZXRyeWluZywgYSBodW1hbiBjbGlja2luZyBhcyB0aGUgYWdlbnQgcmVwb3J0cyDigJQgaXMgbm90IGFuIGVycm9yLCBhbmRcbiAgICogcmVmdXNpbmcgd291bGQgbWFrZSB0aGUgc3VyZmFjZSBoYW5kbGUgYSByYWNlIGl0IGRpZCBub3QgY2F1c2UuXG4gICAqL1xuICBmaW5pc2hUYXNrKGlkOiBzdHJpbmcsIG91dGNvbWU/OiBzdHJpbmcpOiB7IHRhc2s6IFRhc2s7IGFscmVhZHk6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICBjb25zdCBhbHJlYWR5ID0gdGFzay5kb25lQXQgIT09IHVuZGVmaW5lZDtcbiAgICBpZiAoIWFscmVhZHkpIHtcbiAgICAgIHRhc2suZG9uZUF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHRhc2suc3RhdHVzID0gdW5kZWZpbmVkO1xuICAgICAgaWYgKG91dGNvbWU/LnRyaW0oKSkgdGFzay5vdXRjb21lID0gb3V0Y29tZS50cmltKCk7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdGFzaywgYWxyZWFkeSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlLiBNYXJraW5nIGl0IGRvbmUgd291bGRcbiAgICogcHV0IGEgdGhpbmcgdGhhdCBuZXZlciBoYXBwZW5lZCBpbnRvIHRoZSByZWNvcmQ7IGEgcXVldWUgeW91IGNhbm5vdCBjbGVhclxuICAgKiBvZiBpdHMgb3duIG1pc3Rha2VzIHN0b3BzIGJlaW5nIGEgdHJ1c3R3b3J0aHkgYWNjb3VudCBvZiB0aGUgd29yay5cbiAgICovXG4gIHJlbW92ZVRhc2soaWQ6IHN0cmluZyk6IFRhc2sge1xuICAgIGNvbnN0IHRhc2sgPSB0aGlzLnRhc2tPckRpZShpZCk7XG4gICAgdGhpcy5tLnRhc2tzID0gKHRoaXMubS50YXNrcyA/PyBbXSkuZmlsdGVyKCh0KSA9PiB0LmlkICE9PSBpZCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2suIE91dHN0YW5kaW5nIG9uZXMgYXJlIHVudG91Y2hlZCDigJQgY2xlYXJpbmcgaXNcbiAgICogdGlkeWluZyB3aGF0IGlzIE9WRVIsIG5ldmVyIGFiYW5kb25pbmcgd29yayBzdGlsbCBpbiBmbGlnaHQuXG4gICAqL1xuICBjbGVhckRvbmVUYXNrcygpOiBudW1iZXIge1xuICAgIGNvbnN0IGJlZm9yZSA9ICh0aGlzLm0udGFza3MgPz8gW10pLmxlbmd0aDtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuZG9uZUF0ID09PSB1bmRlZmluZWQpO1xuICAgIGNvbnN0IGNsZWFyZWQgPSBiZWZvcmUgLSAodGhpcy5tLnRhc2tzPy5sZW5ndGggPz8gMCk7XG4gICAgaWYgKGNsZWFyZWQgPiAwKSB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gY2xlYXJlZDtcbiAgfVxuXG4gIC8qKiBOZXdlc3QgZmlyc3Qg4oCUIGEgcXVldWUgaXMgcmVhZCBmcm9tIHRoZSB0b3AuICovXG4gIHRhc2tzKCk6IFRhc2tbXSB7XG4gICAgcmV0dXJuIFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKV0uc29ydCgoYSwgYikgPT4gYi5jcmVhdGVkQXQgLSBhLmNyZWF0ZWRBdCk7XG4gIH1cblxuICBhZGRNZXNzYWdlKFxuICAgIHdobzogQ2hhdFdobyxcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgZXh0cmE6IHsgc2VsZWN0aW9uPzogU2VsZWN0aW9uIHwgbnVsbDsgYWN0aXZlUGF0aD86IHN0cmluZyB8IG51bGw7IG5vdGU/OiBOb3RlUmVmIH0gPSB7fSxcbiAgKTogQ2hhdE1lc3NhZ2Uge1xuICAgIGNvbnN0IG1zZzogQ2hhdE1lc3NhZ2UgPSB7IGlkOiBgbS0ke3JhbmRIZXgoNCl9YCwgd2hvLCB0ZXh0LCB0czogRGF0ZS5ub3coKSwgLi4uZXh0cmEgfTtcbiAgICB0aGlzLm0uY2hhdC5wdXNoKG1zZyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCB2aWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQSBkb2N1bWVudCdzIGZyb250bWF0dGVyLCBmcm9tIHRoZSBBQ1RJVkUgdmVyc2lvbidzIHRleHQg4oCUIHdoYXQgdGhlIGh1bWFuXG4gICAqICBpcyByZWFkaW5nLCB3aGljaCBpcyBub3QgYWx3YXlzIHdoYXQgaXMgb24gZGlzayAoRTMyKS4gKi9cbiAgcHJpdmF0ZSBtZXRhT2YoZDogRG9jUmVjb3JkKTogRG9jVmlld1tcIm1ldGFcIl0ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhZE1ldGEocmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgZG9jVmlldyhkOiBEb2NSZWNvcmQpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4ge1xuICAgICAgbWV0YTogdGhpcy5tZXRhT2YoZCksXG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIGVudHJ5SWQ6IGQuZW50cnlJZCxcbiAgICAgIHJlbDogZC5yZWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5tYXAoKHYpID0+ICh7IC4uLnYsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgdi5uKSB9KSksXG4gICAgICBub3RlczogdGhpcy5wbGFjZWROb3RlcyhkKSxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBkaXJ0eTogdGhpcy5pc0RpcnR5KGQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGQub3V0c2lkZUNoYW5nZWQsXG4gICAgfTtcbiAgfVxuXG4gIGRvYyhzbHVnOiBzdHJpbmcpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4gdGhpcy5kb2NWaWV3KHRoaXMuZG9jT3JEaWUoc2x1ZykpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZyb250bWF0dGVyIGZvciBldmVyeSBkb2N1bWVudCBpbiB0aGUgY29udGV4dCwgYnkgcGF0aCAoRTMyKS5cbiAgICpcbiAgICogQ2FjaGVkIGJ5IHBhdGggYW5kIG10aW1lLCBhbmQgcmVhZCBIRUFELUZJUlNUOiBhIGZyb250bWF0dGVyIGJsb2NrIHNpdHMgYXRcbiAgICogdGhlIHRvcCBvZiBhIGZpbGUsIHNvIGEgMzAwIEtCIGRvY3VtZW50IGNvc3RzIDggS0Igb2YgcmVhZC4gVGhlIGNhcCBrZWVwcyBhXG4gICAqIDIsMDAwLW5vZGUgbWlycm9yIGZyb20gbWVhbmluZyAyLDAwMCByZWFkcyBwZXIgc25hcHNob3QsIGFuZCBoaXR0aW5nIGl0IGlzXG4gICAqIFNBSUQgb24gdGhlIHdpcmUgcmF0aGVyIHRoYW4gbGVmdCB0byBsb29rIGxpa2UgZG9jdW1lbnRzIHdpdGhvdXQgYW55LlxuICAgKi9cbiAgcHJpdmF0ZSBtZXRhQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBtdGltZU1zOiBudW1iZXI7IHN1bW1hcnk6IERvY1N1bW1hcnkgfCBudWxsIH0+KCk7XG5cbiAgY29udGV4dE1ldGEoY2FwID0gTUVUQV9TQ0FOX0NBUCk6IHsgbWFwOiBSZWNvcmQ8c3RyaW5nLCBEb2NTdW1tYXJ5PjsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IG1hcDogUmVjb3JkPHN0cmluZywgRG9jU3VtbWFyeT4gPSB7fTtcbiAgICBsZXQgc2VlbiA9IDA7XG4gICAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIHtcbiAgICAgICAgaWYgKHNlZW4gPj0gY2FwKSB7XG4gICAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBzZWVuKys7XG4gICAgICAgIGxldCBtdGltZU1zOiBudW1iZXI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbXRpbWVNcyA9IHN0YXRTeW5jKGFicykubXRpbWVNcztcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaGl0ID0gdGhpcy5tZXRhQ2FjaGUuZ2V0KGFicyk7XG4gICAgICAgIGxldCBzdW1tYXJ5OiBEb2NTdW1tYXJ5IHwgbnVsbDtcbiAgICAgICAgaWYgKGhpdCAmJiBoaXQubXRpbWVNcyA9PT0gbXRpbWVNcykgc3VtbWFyeSA9IGhpdC5zdW1tYXJ5O1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBzdW1tYXJ5ID0gc3VtbWFyaXplKHJlYWRNZXRhKHJlYWRIZWFkKGFicykpKTtcbiAgICAgICAgICB0aGlzLm1ldGFDYWNoZS5zZXQoYWJzLCB7IG10aW1lTXMsIHN1bW1hcnkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHN1bW1hcnkpIG1hcFthYnNdID0gc3VtbWFyeTtcbiAgICAgIH1cbiAgICAgIGlmICh0cnVuY2F0ZWQpIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4geyBtYXAsIHRydW5jYXRlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIE9uZSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHJlYWQsIG9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQncyAoRTMyKS4gVGhlXG4gICAqIGFnZW50IGdldHMgdGhlIGRhZW1vbidzIHBhcnNlIHJhdGhlciB0aGFuIHJlLXJlYWRpbmcgdGhlIFlBTUwgaXRzZWxmLlxuICAgKi9cbiAgbWV0YUZvcihyYXdQYXRoPzogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGlmIChyYXdQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgICAgY29uc3QgbWV0YSA9IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogYWJzLCBtZXRhLCAuLi4obWV0YSA/IHt9IDogeyBub3RlOiBcIm5vIGZyb250bWF0dGVyIGJsb2NrXCIgfSkgfTtcbiAgICB9XG4gICAgY29uc3Qgb3V0OiB7IHBhdGg6IHN0cmluZzsgbWV0YTogRG9jTWV0YSB8IG51bGwgfVtdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIG91dC5wdXNoKHsgcGF0aDogYWJzLCBtZXRhOiByZWFkTWV0YShyZWFkSGVhZChhYnMpKSB9KTtcbiAgICByZXR1cm4geyBkb2N1bWVudHM6IG91dCwgY291bnQ6IG91dC5sZW5ndGggfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBwZG9jcydzIGBmaW5kYCwgb3ZlciB0aGlzIHNlc3Npb24ncyBjb250ZXh0LiBTYW1lIGZpbHRlciBuYW1lcywgc2FtZVxuICAgKiBBTkRpbmcsIGFuZCB0aGUgc2FtZSBydWxlIHRoYXQgYW4gZW1wdHkgcmVzdWx0IGlzIGFuIEFOU1dFUjogYGNvdW50YCBzYXlzXG4gICAqIGhvdyBtYW55IG1hdGNoZWQsIGFuZCB0aGUgY2FsbGVyIHJlYWRzIHRoYXQgcmF0aGVyIHRoYW4gdGhlIGV4aXQgY29kZS5cbiAgICovXG4gIGZpbmQoZmlsdGVyOiBNZXRhRmlsdGVyKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IG1hdGNoZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkge1xuICAgICAgICBjb25zdCBtZXRhID0gcmVhZE1ldGEocmVhZEhlYWQoYWJzKSk7XG4gICAgICAgIGlmICghbWF0Y2hlc0ZpbHRlcihtZXRhLCBmaWx0ZXIpKSBjb250aW51ZTtcbiAgICAgICAgbWF0Y2hlcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgZW50cnk6IGUuaWQsXG4gICAgICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLihtZXRhPy50aXRsZSA/IHsgdGl0bGU6IG1ldGEudGl0bGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4obWV0YT8uZGVzY3JpcHRpb24gPyB7IGRlc2NyaXB0aW9uOiBtZXRhLmRlc2NyaXB0aW9uIH0gOiB7fSksXG4gICAgICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gbnVsbCxcbiAgICAgICAgICAuLi4obWV0YT8ubGlmZWN5Y2xlID8geyBsaWZlY3ljbGU6IG1ldGEubGlmZWN5Y2xlIH0gOiB7fSksXG4gICAgICAgICAgdGFnczogbWV0YT8udGFncyA/PyBbXSxcbiAgICAgICAgICBkYXRlOiBtZXRhPy5kYXRlID8/IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIHJldHVybiB7IG1hdGNoZXMsIGNvdW50OiBtYXRjaGVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIE9uZSBzZXQncyBtYXAgKEUzMyk6IGl0cyBkb2N1bWVudHMgYXMgbm9kZXMsIGFuZCB0aGUgZm91ciBzb3VyY2VzIG9mIGVkZ2VzXG4gICAqIOKAlCBib2R5IGxpbmtzLCB3aWtpIGxpbmtzLCB0eXBlZCBsaW5rcyBhbmQgZnJvbnRtYXR0ZXIgcmVmZXJlbmNlcy5cbiAgICovXG4gIGdyYXBoRm9yKGVudHJ5SWQ/OiBzdHJpbmcpOiBHcmFwaFBheWxvYWQge1xuICAgIGNvbnN0IGUgPSBlbnRyeUlkXG4gICAgICA/IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpXG4gICAgICA6IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHgubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBlbnRyeUlkID8gYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAgOiBcInRoaXMgc2Vzc2lvbiBoYXMgbm8gc2V0IHRvIG1hcFwiLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHBhdGhzID0gZG9jUGF0aHMoZSk7XG4gICAgY29uc3QgaW5kZXg6IEJ1bmRsZUluZGV4ID0ge1xuICAgICAgcm9vdDogZS5yb290LFxuICAgICAgcGF0aHMsXG4gICAgICBtZXRhT2Y6IChwKSA9PiByZWFkTWV0YShyZWFkSGVhZChwKSksXG4gICAgICBleGlzdHM6IChwKSA9PiBleGlzdHNTeW5jKHApLFxuICAgICAgcmVwb1Jvb3Q6IGdpdFJvb3RPZihlLnJvb3QpLFxuICAgIH07XG4gICAgY29uc3QgZyA9IGJ1aWxkR3JhcGgoaW5kZXgsIChwKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICByZXR1cm4gc3BsaXRGcm9udG1hdHRlcihyZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpKS5ib2R5O1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBcIlwiO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiB7IGVudHJ5OiBlLmlkLCAuLi5nIH07XG4gIH1cblxuICAvKipcbiAgICogU2VhcmNoIGV2ZXJ5dGhpbmcgaW4gdGhlIGNvbnRleHQ6IGZ1enp5IG92ZXIgbmFtZXMsIGV4YWN0IG92ZXIgY29udGVudCAoRTU5KS5cbiAgICpcbiAgICog4puUIFRISVMgSVMgV0hZIFRIRSBWRVJCIEVYSVNUUyBBVCBBTEwsIGFuZCB0aGUgcmVhc29uIGlzIG9uZSBsaW5lOiBhXG4gICAqIGRvY3VtZW50IG9wZW4gaW4gdGhlIHNlc3Npb24gaXMgc2hvd24gYXMgaXRzIEFDVElWRSBWRVJTSU9OLCB3aGljaCBsaXZlc1xuICAgKiB1bmRlciB0aGUgc2Vzc2lvbiBob21lIGFuZCBub3QgYXQgdGhlIG9yaWdpbmFsIHBhdGguIEFuIGFnZW50IGdyZXBwaW5nIHRoZVxuICAgKiB3b3Jrc3BhY2UgdGhlcmVmb3JlIGZpbmRzIHRoZSBTQVZFRCBmaWxlIGFuZCBzaWxlbnRseSBtaXNzZXMgdGhlIHRleHQgdGhlXG4gICAqIGh1bWFuIGlzIHJlYWRpbmcg4oCUIHNvIFwic2VhcmNoIHdoYXQgeW91IGNhbiBzZWVcIiBpcyBhIHF1ZXN0aW9uIG9ubHkgdGhlXG4gICAqIHNlc3Npb24gY2FuIGFuc3dlci4gRXZlcnl0aGluZyBlbHNlIGFib3V0IHNlYXJjaGluZyBmaWxlcywgYW4gYWdlbnQgY2FuXG4gICAqIGFscmVhZHkgZG8gd2l0aCBncmVwLCB3aGljaCBpcyB3aHkgdGhlcmUgaXMgbm8gaW4tZG9jdW1lbnQgdmVyYi5cbiAgICpcbiAgICog4pqgIEhpZGRlbiBkb2N1bWVudHMgYXJlIGV4Y2x1ZGVkLCBiZWNhdXNlIHRoZSBjb250ZXh0IGlzIHdoYXQgdGhlIGh1bWFuXG4gICAqIGNob3NlIHRvIGxvb2sgYXQ7IGEgcmVzdWx0IHRoZXkgY2Fubm90IHNlZSBpbiB0aGUgc2lkZWJhciB3b3VsZCBiZSBhIHJlc3VsdFxuICAgKiB0aGV5IGNhbm5vdCBvcGVuLlxuICAgKi9cbiAgc2VhcmNoQWxsKG9wdHM6IHsgcXVlcnk6IHN0cmluZzsgbGltaXQ/OiBudW1iZXIgfSk6IFNlYXJjaFJlcG9ydCB7XG4gICAgY29uc3QgY2FuZGlkYXRlczogQ2FuZGlkYXRlW10gPSBbXTtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgZm9yIChjb25zdCBwYXRoIG9mIGRvY1BhdGhzKGVudHJ5KSkge1xuICAgICAgICBpZiAoc2Vlbi5oYXMocGF0aCkpIGNvbnRpbnVlO1xuICAgICAgICBzZWVuLmFkZChwYXRoKTtcbiAgICAgICAgY29uc3QgcmVjb3JkID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gcGF0aCk7XG4gICAgICAgIGNvbnN0IHRpdGxlID0gcmVhZE1ldGEocmVhZEhlYWQocGF0aCkpPy50aXRsZTtcbiAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHtcbiAgICAgICAgICBwYXRoLFxuICAgICAgICAgIG5hbWU6IGJhc2VuYW1lKHBhdGgpLFxuICAgICAgICAgIC4uLihyZWNvcmQgPyB7IHNsdWc6IHJlY29yZC5zbHVnLCB2ZXJzaW9uOiByZWNvcmQuYWN0aXZlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHRpdGxlID8geyB0aXRsZSB9IDoge30pLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHNlYXJjaERvY3VtZW50cyhcbiAgICAgIGNhbmRpZGF0ZXMsXG4gICAgICBvcHRzLnF1ZXJ5LFxuICAgICAgKGMpID0+IHtcbiAgICAgICAgLy8gVGhlIEFDVElWRSBWRVJTSU9OIHdoZW4gdGhlIHNlc3Npb24gaGFzIG9uZSDigJQgc2VlIHRoZSBub3RlIGFib3ZlLlxuICAgICAgICBjb25zdCByZWNvcmQgPVxuICAgICAgICAgIGMuc2x1ZyA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5zbHVnID09PSBjLnNsdWcpO1xuICAgICAgICBpZiAocmVjb3JkKSByZXR1cm4gdGhpcy5hY3RpdmVUZXh0KHJlY29yZCk7XG4gICAgICAgIHJldHVybiByZWFkRmlsZVN5bmMoYy5wYXRoLCBcInV0ZjhcIik7XG4gICAgICB9LFxuICAgICAgb3B0cy5saW1pdCAhPT0gdW5kZWZpbmVkID8geyB0b3RhbDogb3B0cy5saW1pdCB9IDoge30sXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBsaW5rIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCB0aGUgcmVwb3J0IHlvdSBjYW4gQUNUIG9uIChFNTQpLlxuICAgKlxuICAgKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGdyYXBoYCBBTFJFQURZIEhBRCBUSEUgRkFDVFMgQU5EIFNUSUxMIERJRCBOT1QgQU5TV0VSXG4gICAqIFRIRSBRVUVTVElPTi4gQ29sZSBhc2tlZCB3aGV0aGVyIGFuIGFnZW50IGNhbiBjaGVjayBkYW5nbGluZyBsaW5rczsgdGhlXG4gICAqIGhvbmVzdCBhbnN3ZXIgd2FzIFwieWVzLCBieSBmZXRjaGluZyBhIHNldCdzIHdob2xlIG1hcCBhbmQgZmlsdGVyaW5nIHNldmVyYWxcbiAgICogaHVuZHJlZCBlZGdlc1wiLCB3aGljaCBpcyBhIGRpZmZlcmVudCB0aGluZyBmcm9tIGJlaW5nIGFibGUgdG8gY2hlY2sgdGhlbS5cbiAgICogVGhpcyBzYXlzIG9ubHkgd2hhdCBpcyBicm9rZW4sIGFuZCBzYXlzIGl0IGFzIGBmaWxlOmxpbmVgIHBsdXMgVEhFIFNUUklOR1xuICAgKiBUSEUgRE9DVU1FTlQgQUNUVUFMTFkgQ09OVEFJTlMg4oCUIHdoaWNoIGlzIHdoYXQgeW91IG5lZWQgdG8gcmVwYWlyIG9uZSwgYW5kXG4gICAqIHdoYXQgdGhlIG1hcCdzIHJlc29sdmVkIGB0b2AgaGFkIHF1aWV0bHkgdGhyb3duIGF3YXkuXG4gICAqXG4gICAqIOKaoCBOT1QgQU4gRVJST1IuIEEgZGFuZ2xpbmcgbGluayBpcyBhIGZhY3QgYWJvdXQgYSBzZXQsIG5vdCBhIGZhaWx1cmU6IE9LRlxuICAgKiDCpzExJ3MgcnVsZSwgYW5kIGl0IGlzIHdoeSB0aGlzIHJlcG9ydHMgYW5kIGV4aXRzIHplcm8uIERvY3VtZW50cyB0aGF0IHBvaW50XG4gICAqIGF0IHRoaW5ncyBub3Qgd3JpdHRlbiB5ZXQgYXJlIG5vcm1hbCBpbiBhIHdvcmxkIGJpYmxlLlxuICAgKi9cbiAgZGFuZ2xpbmdMaW5rcyhlbnRyeUlkPzogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGVudHJ5SWQpO1xuICAgIGNvbnN0IGJyb2tlbiA9IGcuZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIik7XG4gICAgLy8g4puUIEJPRFkgTElORVMgQkVDT01FIEZJTEUgTElORVMgSEVSRS4gTGlua3MgYXJlIGV4dHJhY3RlZCBmcm9tIHRoZSBib2R5LFxuICAgIC8vIHNvIHRoZSBudW1iZXIgdGhlIGdyYXBoIGNhcnJpZXMgaXMgc2hvcnQgYnkgaG93ZXZlciBtdWNoIGZyb250bWF0dGVyIHRoZVxuICAgIC8vIGRvY3VtZW50IGhhcyDigJQgYW5kIGEgcmVwb3J0IGlzIGZvciBvcGVuaW5nIGEgZmlsZSBhdCBhIGxpbmUuXG4gICAgY29uc3Qgb2Zmc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgY29uc3Qgb2Zmc2V0T2YgPSAocGF0aDogc3RyaW5nKTogbnVtYmVyID0+IHtcbiAgICAgIGNvbnN0IGtub3duID0gb2Zmc2V0cy5nZXQocGF0aCk7XG4gICAgICBpZiAoa25vd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIGtub3duO1xuICAgICAgbGV0IG9mZiA9IDA7XG4gICAgICB0cnkge1xuICAgICAgICBvZmYgPSBib2R5TGluZU9mZnNldChyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiB1bnJlYWRhYmxlIOKAlCByZXBvcnQgdGhlIGJvZHkgbGluZSByYXRoZXIgdGhhbiBub3RoaW5nICovXG4gICAgICB9XG4gICAgICBvZmZzZXRzLnNldChwYXRoLCBvZmYpO1xuICAgICAgcmV0dXJuIG9mZjtcbiAgICB9O1xuICAgIHJldHVybiB7XG4gICAgICBlbnRyeTogZy5lbnRyeSxcbiAgICAgIHJvb3Q6IGcucm9vdCxcbiAgICAgIGNvdW50OiBicm9rZW4ubGVuZ3RoLFxuICAgICAgbGlua3M6IGJyb2tlbi5tYXAoKGUpID0+ICh7XG4gICAgICAgIGZyb206IGUuZnJvbSxcbiAgICAgICAgLi4uKGUubGluZSAhPT0gdW5kZWZpbmVkID8geyBsaW5lOiBlLmxpbmUgKyBvZmZzZXRPZihlLmZyb20pIH0gOiB7fSksXG4gICAgICAgIC8vIFdoYXQgdGhlIGRvY3VtZW50IHNheXMsIG5vdCB3aGF0IHdlIGxvb2tlZCBmb3IuXG4gICAgICAgIC4uLihlLnJhdyAhPT0gdW5kZWZpbmVkID8geyB3cm90ZTogZS5yYXcgfSA6IHt9KSxcbiAgICAgICAgLy8gV2hlcmUgdGhlIHJlc29sdXRpb24gZW5kZWQgdXAsIHNvIGEgbmVhci1taXNzIGlzIHZpc2libGUuXG4gICAgICAgIHRyaWVkOiBlLnRvLFxuICAgICAgICBzb3VyY2U6IGUuc291cmNlLFxuICAgICAgICAuLi4oZS5rZXkgPyB7IGtleTogZS5rZXkgfSA6IHt9KSxcbiAgICAgICAgLi4uKGUucmVsLmxlbmd0aCA/IHsgcmVsOiBlLnJlbCB9IDoge30pLFxuICAgICAgfSkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogV2hhdCBjaXRlcyBhIGRvY3VtZW50LiBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSkgYXJlIGtlcHRcbiAgICogQVBBUlQsIHdoaWNoIGlzIGhvdyBwZG9jcyByZXBvcnRzIGl0IGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogb25lIGlzIGFcbiAgICogY2xhaW0gYWJvdXQgdGhlIGRvY3VtZW50LCB0aGUgb3RoZXIgYSBjaXRhdGlvbiBpbiBwcm9zZS5cbiAgICovXG4gIGJhY2tsaW5rcyhyYXdQYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICAgIGlmICghZW50cnkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3QgaW5zaWRlIGEgc2V0LCBzbyBub3RoaW5nIG1hcHMgaXRgLCA0MDApO1xuICAgIGNvbnN0IGcgPSB0aGlzLmdyYXBoRm9yKGVudHJ5LmlkKTtcbiAgICBjb25zdCBpbmJvdW5kID0gZy5lZGdlcy5maWx0ZXIoKHgpID0+IHgudG8gPT09IGFicyk7XG4gICAgY29uc3QgdGl0bGUgPSAocDogc3RyaW5nKSA9PiBnLm5vZGVzLmZpbmQoKG4pID0+IG4ucGF0aCA9PT0gcCk/LnRpdGxlID8/IGJhc2VuYW1lKHApO1xuICAgIHJldHVybiB7XG4gICAgICB0YXJnZXQ6IHsgcGF0aDogYWJzLCB0aXRsZTogdGl0bGUoYWJzKSB9LFxuICAgICAgcmVsYXRlZDogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJmcm9udG1hdHRlclwiKVxuICAgICAgICAubWFwKCh4KSA9PiAoeyBwYXRoOiB4LmZyb20sIHRpdGxlOiB0aXRsZSh4LmZyb20pLCBrZXk6IHgua2V5IH0pKSxcbiAgICAgIGxpbmtzOiBpbmJvdW5kXG4gICAgICAgIC5maWx0ZXIoKHgpID0+IHguc291cmNlID09PSBcImxpbmtcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwgcmVsOiB4LnJlbCB9KSksXG4gICAgICBjb3VudDogaW5ib3VuZC5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBXaGVyZSBkb2VzIHRoaXMgbGluayBnbz8gVGhlIHN1cmZhY2UgYXNrcyBiZWZvcmUgZm9sbG93aW5nIG9uZSAoRTMzKS4gKi9cbiAgcmVzb2x2ZUxpbmsoZnJvbTogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZyk6IFJlc29sdXRpb24ge1xuICAgIGNvbnN0IHNyYyA9IHRoaXMuc2hvd25QYXRoKGZyb20pO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiBzcmMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApLFxuICAgICk7XG4gICAgY29uc3Qgcm9vdCA9IGVudHJ5Py5yb290ID8/IGRpcm5hbWUoc3JjKTtcbiAgICBjb25zdCBwYXRocyA9IGVudHJ5ID8gZG9jUGF0aHMoZW50cnkpIDogW3NyY107XG4gICAgcmV0dXJuIHJlc29sdmVUYXJnZXQodGFyZ2V0LCBzcmMsIHtcbiAgICAgIHJvb3QsXG4gICAgICBwYXRocyxcbiAgICAgIG1ldGFPZjogKHApID0+IHJlYWRNZXRhKHJlYWRIZWFkKHApKSxcbiAgICAgIGV4aXN0czogKHApID0+IGV4aXN0c1N5bmMocCksXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKHJvb3QpLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgYSBmcm9udG1hdHRlciBibG9jayBmb3IgdGhpcyBkb2N1bWVudCBXT1VMRCBzYXkgKEUzNSkuIFN1Z2dlc3RlZCwgbm90XG4gICAqIHdyaXR0ZW46IHRoZSB0eXBlIGNvbWVzIGZyb20gdGhlIGRvY3VtZW50cyBiZXNpZGUgaXQsIHRoZSB0aXRsZSBmcm9tIGl0c1xuICAgKiBvd24gSDEsIGFuZCBgZGVzY3JpcHRpb25gIGlzIGxlZnQgYmxhbmsgZm9yIHdob2V2ZXIgZmlsbHMgaXQgaW4uXG4gICAqL1xuICBzdWdnZXN0TWV0YShyYXdQYXRoOiBzdHJpbmcsIGJ5Pzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGJsb2NrOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBpZiAoc3BsaXRGcm9udG1hdHRlcih0ZXh0KS5yYXcgIT09IG51bGwpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Jhc2VuYW1lKGFicyl9IGFscmVhZHkgaGFzIGZyb250bWF0dGVyYCwgNDA5KTtcbiAgICBjb25zdCBmb2xkZXIgPSBkaXJuYW1lKGFicyk7XG4gICAgY29uc3Qgc2libGluZ3M6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBwIG9mIGRvY1BhdGhzKGUpKVxuICAgICAgICBpZiAocCAhPT0gYWJzICYmIGRpcm5hbWUocCkgPT09IGZvbGRlcikge1xuICAgICAgICAgIGNvbnN0IHQgPSByZWFkTWV0YShyZWFkSGVhZChwKSk/LnR5cGU7XG4gICAgICAgICAgaWYgKHQpIHNpYmxpbmdzLnB1c2godCk7XG4gICAgICAgIH1cbiAgICBjb25zdCB0eXBlID0gZ3Vlc3NUeXBlKHNpYmxpbmdzLCBiYXNlbmFtZShmb2xkZXIpKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogYWJzLFxuICAgICAgdHlwZSxcbiAgICAgIGJsb2NrOiBidWlsZEJsb2NrKHtcbiAgICAgICAgLi4uKHR5cGUgPyB7IHR5cGUgfSA6IHt9KSxcbiAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAuLi4oYnkgPyB7IGJ5IH0gOiB7fSksXG4gICAgICB9KSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdyaXRlIGEgbmV3IGJsb2NrIGludG8gYSBkb2N1bWVudCB0aGF0IGhhcyBub25lIChFMzUpLlxuICAgKlxuICAgKiDim5QgVEhJUyBXUklURVMgVEhFIE9SSUdJTkFMLCB3aGljaCBFNyBvdGhlcndpc2UgcmVzZXJ2ZXMgZm9yIFNhdmUg4oCUIGFuZFxuICAgKiB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhbiBvdmVyc2lnaHQ6IHRoZSBhZ2VudCdzIHZlcmIgd3JpdGVzIHRoZSBmaWxlLCBhbmRcbiAgICogaWYgdGhlIGh1bWFuIGhhcyB1bnNhdmVkIGVkaXRzIHRvIGl0IHRoZSBDT05GTElDVCBCQVIgYXBwZWFycyBhbmQgdGhleVxuICAgKiBjaG9vc2UgKENvbGU6IFwid2UgY2FuIGFkanVzdCBpZiBuZWVkZWQgYWZ0ZXIgZ2V0dGluZyBhY3R1YWwgdXNhZ2UgYmVoaW5kXG4gICAqIHVzXCIpLiBSZWZ1c2luZyB3aGlsZSBhIGJ1ZmZlciBpcyBkaXJ0eSB3b3VsZCBsZXQgYW4gb3BlbiBkb2N1bWVudCBibG9jayB0aGVcbiAgICogYWdlbnQgaW5kZWZpbml0ZWx5LiBUaGUgSFVNQU4ncyBvd24gcGF0aCBuZXZlciBjb21lcyBoZXJlOiB0aGVpciBcImFkZFxuICAgKiBmcm9udG1hdHRlclwiIGlzIGFuIGVkaXQgdG8gdGhlaXIgYnVmZmVyLCB3aGljaCBTYXZlIHdyaXRlcyBsaWtlIGFueSBvdGhlci5cbiAgICovXG4gIG1ldGFJbml0KHJhd1BhdGg6IHN0cmluZywgb3B0czogeyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZyB9ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgc3VnZ2VzdGVkID0gdGhpcy5zdWdnZXN0TWV0YShyYXdQYXRoLCBvcHRzLmJ5KTtcbiAgICBjb25zdCBhYnMgPSBzdWdnZXN0ZWQucGF0aDtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IGJsb2NrID0gb3B0cy50eXBlXG4gICAgICA/IGJ1aWxkQmxvY2soe1xuICAgICAgICAgIHR5cGU6IG9wdHMudHlwZSxcbiAgICAgICAgICAuLi4odGl0bGVGcm9tQm9keSh0ZXh0KSA/IHsgdGl0bGU6IHRpdGxlRnJvbUJvZHkodGV4dCkgYXMgc3RyaW5nIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG9wdHMuYnkgPyB7IGJ5OiBvcHRzLmJ5IH0gOiB7fSksXG4gICAgICAgIH0pXG4gICAgICA6IHN1Z2dlc3RlZC5ibG9jaztcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgd2l0aEJsb2NrKHRleHQsIGJsb2NrKSk7XG4gICAgdGhpcy5tZXRhQ2FjaGUuZGVsZXRlKGFicyk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzLCB0eXBlOiBvcHRzLnR5cGUgPz8gc3VnZ2VzdGVkLnR5cGUgPz8gbnVsbCwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBTZXQga2V5cyBpbiBhbiBleGlzdGluZyBibG9jayDigJQgYSBMSU5FIGVkaXQgZWFjaCwgc28gbm90aGluZyBlbHNlIG1vdmVzLiAqL1xuICBtZXRhU2V0KHJhd1BhdGg6IHN0cmluZywgcGFpcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgbGV0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ID09PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBoYXMgbm8gZnJvbnRtYXR0ZXIg4oCUIGFkZCBpdCBmaXJzdCAobWV0YS1pbml0KWAsIDQwOSk7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGFpcnMpKSB7XG4gICAgICBpZiAoIS9eW0EtWmEtel9dW0EtWmEtejAtOV8uLV0qJC8udGVzdChrZXkpKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBcIiR7a2V5fVwiIGlzIG5vdCBhIGZyb250bWF0dGVyIGtleWAsIDQwMCk7XG4gICAgICB0ZXh0ID0gc2V0S2V5KHRleHQsIGtleSwgdmFsdWUpO1xuICAgIH1cbiAgICB3cml0ZUZpbGVTeW5jKGFicywgdGV4dCk7XG4gICAgdGhpcy5tZXRhQ2FjaGUuZGVsZXRlKGFicyk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzLCBzZXQ6IE9iamVjdC5rZXlzKHBhaXJzKSB9O1xuICB9XG5cbiAgLyoqIFRoZSBzZXNzaW9uJ3MgaGFsZiBvZiBgUHVibGljU3RhdGVgOyB0aGUgZGFlbW9uIGFkZHMgdGhlIGhvbWUtbGV2ZWwgYHByZWZzYCBhbmQgYHVzZXJIb21lYC4gKi9cbiAgLyoqXG4gICAqIFRoZSBjb252ZXJzYXRpb24sIHdpdGhvdXQgYnVpbGRpbmcgYSBzbmFwc2hvdCBhcm91bmQgaXQuXG4gICAqXG4gICAqIOKaoCBFNTMncyBhdHRlbnRpb24gdGljayBydW5zIGV2ZXJ5IHNlY29uZCBhbmQgb25seSBuZWVkcyB0aGUgY2hhdDsgY2FsbGluZ1xuICAgKiBgdmlldygpYCBmb3IgaXQgd291bGQgcmUtcmVhZCBldmVyeSBkb2N1bWVudCdzIGZyb250bWF0dGVyIG9uIGEgdGltZXIuXG4gICAqL1xuICBtZXNzYWdlcygpOiByZWFkb25seSBDaGF0TWVzc2FnZVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNoYXQ7XG4gIH1cblxuICB2aWV3KFxuICAgIG1vZGU6IFwiZGV2XCIgfCBcInJlbGVhc2VcIixcbiAgICBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwsXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBpcyB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMpOiBpdCBkZXBlbmRzIG9uIHRoZSBjbG9jayBhbmQgb25cbiAgICAvLyB0aGUgc25vb3plIHRoZSBzZXJ2ZXIgaG9sZHMsIG5laXRoZXIgb2Ygd2hpY2ggYmVsb25ncyBpbiB0aGUgc2Vzc2lvbi5cbiAgICAvLyDimqAgYHdhaXRpbmdgIGFuZCBgaGlzdG9yeWAgYXJlIHRoZSBTRVJWRVIncyB0byBhZGQgKEU1MywgRTYwKTogb25lIGRlcGVuZHNcbiAgICAvLyBvbiB0aGUgY2xvY2sgYW5kIHRoZSBzbm9vemUgaXQgaG9sZHMsIHRoZSBvdGhlciBvbiB0aGUgaW4tbWVtb3J5IGFjdFxuICAgIC8vIHN0YWNrcy4gTmVpdGhlciBiZWxvbmdzIGluIHRoZSBzZXNzaW9uJ3MgcGVyc2lzdGVkIHN0YXRlLiBFNjUnc1xuICAgIC8vIGBub3Rlc1dhaXRpbmdgIGlzIHRoZSBzZXJ2ZXIncyBmb3IgYHdhaXRpbmdgJ3MgcmVhc29ucy5cbiAgKTogT21pdDxQdWJsaWNTdGF0ZSwgXCJwcmVmc1wiIHwgXCJ1c2VySG9tZVwiIHwgXCJ3YWl0aW5nXCIgfCBcIm5vdGVzV2FpdGluZ1wiIHwgXCJoaXN0b3J5XCI+IHtcbiAgICBjb25zdCBtZXRhID0gdGhpcy5jb250ZXh0TWV0YSgpO1xuICAgIHJldHVybiB7XG4gICAgICBzZXNzaW9uSWQ6IHRoaXMubS5zZXNzaW9uSWQsXG4gICAgICBob21lOiB0aGlzLmhvbWUsXG4gICAgICB3b3Jrc3BhY2U6IHRoaXMud29ya3NwYWNlLFxuICAgICAgZG9jTWV0YTogbWV0YS5tYXAsXG4gICAgICAuLi4obWV0YS50cnVuY2F0ZWQgPyB7IGRvY01ldGFUcnVuY2F0ZWQ6IHRydWUgfSA6IHt9KSxcbiAgICAgIG1vZGUsXG4gICAgICBjb250ZXh0OiB0aGlzLm0uY29udGV4dCxcbiAgICAgIGRvY3M6IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gdGhpcy5kb2NWaWV3KGQpKSxcbiAgICAgIG9wZW5Eb2M6IHRoaXMubS5vcGVuRG9jLFxuICAgICAgc2VsZWN0aW9uLFxuICAgICAgY2hhdDogdGhpcy5tLmNoYXQsXG4gICAgICB0YXNrczogdGhpcy50YXNrcygpLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgZ2l0IHdvcmtpbmcgdHJlZSBgZGlyYCBpcyBpbiwgb3IgbnVsbC4gQSBgLmdpdGAgRU5UUlksIG5vdCBhIGRpcmVjdG9yeVxuICogdGVzdDogYSB3b3JrdHJlZSBhbmQgYSBzdWJtb2R1bGUgYm90aCBoYXZlIGAuZ2l0YCBhcyBhIEZJTEUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnaXRSb290T2YoZGlyOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgbGV0IGF0ID0gZGlyO1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihhdCwgXCIuZ2l0XCIpKSkgcmV0dXJuIGF0O1xuICAgIGNvbnN0IHVwID0gZGlybmFtZShhdCk7XG4gICAgaWYgKHVwID09PSBhdCkgcmV0dXJuIG51bGw7XG4gICAgYXQgPSB1cDtcbiAgfVxufVxuXG4vKiogRG9jdW1lbnRzIHVuZGVyIGEgZm9sZGVyLCBmb3Igc2F5aW5nIGhvdyBtdWNoIGEgbW92ZSBtb3Zlcy4gKi9cbmZ1bmN0aW9uIGNvdW50RG9jcyhkaXI6IHN0cmluZyk6IG51bWJlciB7XG4gIGxldCBuID0gMDtcbiAgY29uc3Qgd2FsayA9IChhdDogc3RyaW5nKSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhhdCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgYWJzID0gam9pbihhdCwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB3YWxrKGFicyk7XG4gICAgICBlbHNlIGlmIChpc0RvY05hbWUobmFtZSkpIG4rKztcbiAgICB9XG4gIH07XG4gIHdhbGsoZGlyKTtcbiAgcmV0dXJuIG47XG59XG5cbi8qKlxuICogSG93IGEgY29tcGFyaXNvbiBzaWRlIHJlYWRzIGluIGEgbWVzc2FnZSB0byBhIGh1bWFuIG9yIGFuIGFnZW50LlxuICpcbiAqIOKblCBUSEUgRklMRSBJUyBOQU1FRCwgTk9UIERFU0NSSUJFRCAoRTQzLCByZXZpc2VkKS4gXCJUaGUgb3JpZ2luYWxcIiBzb3VuZGVkXG4gKiB0ZW1wb3JhbCB3aGVuIHRoZSB0aGluZyBpcyBsb2NhdGlvbmFsOyBcInRoZSBzYXZlZCBmaWxlXCIgZml4ZWQgdGhhdCBidXQgcmVhZHNcbiAqIGNpcmN1bGFyIHRoZSBtb21lbnQgaXQgaXMgYSBERVNUSU5BVElPTiDigJQgXCJzYXZlIHRvIHRoZSBzYXZlZCBmaWxlXCIgc2F5c1xuICogbm90aGluZy4gTm8gbm91biBlbmNhcHN1bGF0ZXMgXCJ0aGlzIGZpbGUsIGF0IHRoaXMgcGxhY2VcIiwgc28gdGhlIGZpbGUgZ2V0c1xuICogaXRzIG93biBuYW1lOiBgbm90ZS5tZGAuIENvbGU6IFwidGhhdCdzIHByb2JhYmx5IGNsb3NlciB0byB0aGUgcmlnaHQgYW5zd2VyXG4gKiB2ZXJzdXMgdHJ5aW5nIHRvIGNvbWUgdXAgd2l0aCBhIHdvcmQgdGhhdCBlbmNhcHN1bGF0ZXMgaXQuXCJcbiAqXG4gKiBgZmlsZWAgaXMgdGhlIGRvY3VtZW50J3MgbmFtZSB3aGVuIHRoZSBjYWxsZXIga25vd3MgaXQ7IHdpdGhvdXQgb25lIHRoaXNcbiAqIGZhbGxzIGJhY2sgdG8gYSBnZW5lcmljLCB3aGljaCBpcyBvbmx5IGZvciBjb250ZXh0cyB0aGF0IGhhdmUgbm8gZG9jdW1lbnQgaW5cbiAqIGhhbmQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaWRlTmFtZShzaWRlOiBEaWZmU2lkZSwgZmlsZT86IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChzaWRlICE9PSBcIm9yaWdpbmFsXCIpIHJldHVybiBgdiR7c2lkZX1gO1xuICByZXR1cm4gZmlsZSA/PyBcInRoZSBzYXZlZCBmaWxlXCI7XG59XG4iLAogICAgIi8qKlxuICogT0tGIGZyb250bWF0dGVyLCByZWFkIChFMzIpLiBUaGUgZGFlbW9uIHBhcnNlczsgdGhlIHN1cmZhY2UgcmVuZGVycyB3aGF0IGl0XG4gKiBpcyBnaXZlbiDigJQgYEJ1bi5ZQU1MLnBhcnNlYCBpcyBoZXJlLCBzbyBubyBZQU1MIHBhcnNlciByZWFjaGVzIHRoZSBicm93c2VyLlxuICpcbiAqIOKblCBUSEUgU1BFQydTIFRFTVBFUiBJUyBUSEUgUE9JTlQsIEFORCBJVCBJUyBOT1QgVEhFIFVTVUFMIE9ORS4gQSBjb25zdW1lclxuICogXCJNVVNUIE5PVCByZWplY3QgZG9jdW1lbnRzXCIgZm9yIHVua25vd24gdHlwZXMsIHVua25vd24ga2V5cywgbWlzc2luZyBvcHRpb25hbFxuICogZmllbGRzIG9yIGJyb2tlbiBsaW5rcywgYW5kIFwiU0hPVUxEIHByZXNlcnZlIHVua25vd24ga2V5cyB3aGVuIHJvdW5kLXRyaXBwaW5nXCJcbiAqIChPS0YgMC4yIMKnMTEpLiBTbyBub3RoaW5nIGhlcmUgdmFsaWRhdGVzOiBhIGRvY3VtZW50IHdob3NlIGZyb250bWF0dGVyIHdpbGxcbiAqIG5vdCBwYXJzZSBrZWVwcyBpdHMgdGV4dCBhbmQgcmVwb3J0cyB0aGUgcmVhc29uLCBldmVyeSBrZXkgc3Vydml2ZXMgaW5cbiAqIGBmaWVsZHNgIHdoZXRoZXIgb3Igbm90IHRoaXMgc3BlbGwgaGFzIGhlYXJkIG9mIGl0LCBhbmQgYHR5cGVgIOKAlCB0aGUgT05FXG4gKiByZXF1aXJlZCBmaWVsZCDigJQgYmVpbmcgYWJzZW50IGlzIGEgZmFjdCB0byBzaG93LCBuZXZlciBhbiBlcnJvciB0byByYWlzZS5cbiAqXG4gKiBUaGUgREVSSVZFRCB2YWx1ZXMgKHRydXN0LCBzdGFsZW5lc3MpIGFyZSBjb21wdXRlZCBvbiByZWFkIGFuZCBuZXZlciBzdG9yZWQsXG4gKiB3aGljaCBpcyBhbHNvIHRoZSBzcGVjJ3MgcnVsZTogYSB0cnVzdCB0aWVyIHdyaXR0ZW4gaW50byBhIGZpbGUgd291bGQgYmUgYVxuICogY2xhaW0gYWJvdXQgaXRzZWxmLlxuICovXG5pbXBvcnQgdHlwZSB7IERvY01ldGEsIERvY1N1bW1hcnksIFRydXN0VGllciB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBBIGZyb250bWF0dGVyIGJsb2NrOiBgLS0tYCBvbiBpdHMgb3duIGZpcnN0IGxpbmUsIHRvIHRoZSBuZXh0IGAtLS1gIGxpbmUuICovXG5jb25zdCBCTE9DSyA9IC9eLS0tXFxyP1xcbihbXFxzXFxTXSo/KVxccj9cXG4tLS1bIFxcdF0qKD86XFxyP1xcbnwkKS87XG5cbi8qKlxuICogU3BsaXQgYSBkb2N1bWVudCBpbnRvIGl0cyByYXcgZnJvbnRtYXR0ZXIgYmxvY2sgYW5kIHRoZSBib2R5IGJlbmVhdGggaXQuXG4gKiBQdXJlIHN0cmluZyB3b3JrLCBubyBZQU1MIOKAlCB0aGUgU1VSRkFDRSBoYXMgdGhlIHNhbWUgZnVuY3Rpb24gKGl0IG11c3Qgc3RyaXBcbiAqIHRoZSBibG9jayBiZWZvcmUgcmVuZGVyaW5nKSBhbmQgYGZyb250bWF0dGVyLnRlc3QudHNgIGhvbGRzIHRoZSB0d28gZXF1YWwuXG4gKi9cbi8qKlxuICogSG93IG1hbnkgbGluZXMgb2YgYSBkb2N1bWVudCBjb21lIEJFRk9SRSBpdHMgYm9keSDigJQgdGhlIGZyb250bWF0dGVyIGJsb2NrIGFuZFxuICogaXRzIGRlbGltaXRlcnMuXG4gKlxuICog4puUIFdJVEhPVVQgVEhJUyBBIFJFUE9SVEVEIExJTkUgTlVNQkVSIElTIEEgTElFLiBMaW5rcyBhcmUgZXh0cmFjdGVkIGZyb20gdGhlXG4gKiBCT0RZLCBzbyBhIGxpbmsgb24gYm9keSBsaW5lIDkgb2YgYSBkb2N1bWVudCB3aXRoIGZvdXIgbGluZXMgb2YgZnJvbnRtYXR0ZXJcbiAqIGlzIG9uIEZJTEUgbGluZSAxMyDigJQgYW5kIGEgcmVwb3J0IHRoYXQgc2F5cyA5IHNlbmRzIHdob2V2ZXIgaXMgZml4aW5nIGl0IHRvXG4gKiB0aGUgd3JvbmcgcGxhY2UsIGNvbmZpZGVudGx5LiBDYXVnaHQgdGhlIG1vbWVudCBFNTQncyByZXBvcnQgd2FzIGZpcnN0IHJlYWRcbiAqIGFnYWluc3QgYSBkb2N1bWVudCB0aGF0IGhhZCBmcm9udG1hdHRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJvZHlMaW5lT2Zmc2V0KHRleHQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHsgYm9keSB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgY29uc3QgcHJlZml4ID0gdGV4dC5zbGljZSgwLCB0ZXh0Lmxlbmd0aCAtIGJvZHkubGVuZ3RoKTtcbiAgbGV0IGxpbmVzID0gMDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwcmVmaXgubGVuZ3RoOyBpKyspIGlmIChwcmVmaXguY2hhckNvZGVBdChpKSA9PT0gMTApIGxpbmVzKys7XG4gIHJldHVybiBsaW5lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0RnJvbnRtYXR0ZXIodGV4dDogc3RyaW5nKTogeyByYXc6IHN0cmluZyB8IG51bGw7IGJvZHk6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IEJMT0NLLmV4ZWModGV4dCk7XG4gIGlmICghbSkgcmV0dXJuIHsgcmF3OiBudWxsLCBib2R5OiB0ZXh0IH07XG4gIHJldHVybiB7IHJhdzogbVsxXSA/PyBcIlwiLCBib2R5OiB0ZXh0LnNsaWNlKG1bMF0ubGVuZ3RoKSB9O1xufVxuXG4vKiogT0tGJ3MgdGhyZWUsIGFuZCBhbnl0aGluZyBlbHNlIGEgcHJvZHVjZXIgd3JvdGUuIGBzdGFibGVgIGlzIHRoZSBkZWZhdWx0LiAqL1xuZnVuY3Rpb24gc3RhdHVzT2YoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG4gIGNvbnN0IHMgPSBmaWVsZHMuc3RhdHVzO1xuICByZXR1cm4gdHlwZW9mIHMgPT09IFwic3RyaW5nXCIgJiYgcy50cmltKCkgIT09IFwiXCIgPyBzIDogXCJzdGFibGVcIjtcbn1cblxuY29uc3QgYXNMaXN0ID0gKHY6IHVua25vd24pOiBzdHJpbmdbXSA9PlxuICBBcnJheS5pc0FycmF5KHYpID8gdi5maWx0ZXIoKHgpID0+IHR5cGVvZiB4ID09PSBcInN0cmluZ1wiKSA6IHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gW3ZdIDogW107XG5cbi8qKiBBbiBhY3RvciBpcyBodW1hbiBpZmYgaXQgaXMgc3BlbGxlZCBgaHVtYW46PGlkPmAg4oCUIE9LRiAwLjIgwqc2J3MgcnVsZS4gKi9cbmNvbnN0IGlzSHVtYW4gPSAoYWN0b3I6IHVua25vd24pOiBib29sZWFuID0+XG4gIHR5cGVvZiBhY3RvciA9PT0gXCJzdHJpbmdcIiAmJiBhY3Rvci50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoXCJodW1hbjpcIik7XG5cbi8qKlxuICogT0tGJ3MgdHJ1c3QgdGllcnMsIERFUklWRUQ6IG5vIGB2ZXJpZmllZGAg4oaSIHVudmVyaWZpZWQ7IHZlcmlmaWVkIGJ5IG1hY2hpbmVzXG4gKiBvbmx5IOKGkiBtYWNoaW5lLWNvbmZpcm1lZDsgdmVyaWZpZWQgYnkgYSBgaHVtYW46PGlkPmAg4oaSIGh1bWFuLXJldmlld2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdHJ1c3RUaWVyKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBUcnVzdFRpZXIge1xuICBjb25zdCB2ZXJpZmllZCA9IGZpZWxkcy52ZXJpZmllZDtcbiAgY29uc3QgZXZlbnRzID0gQXJyYXkuaXNBcnJheSh2ZXJpZmllZCkgPyB2ZXJpZmllZCA6IHZlcmlmaWVkID8gW3ZlcmlmaWVkXSA6IFtdO1xuICBpZiAoZXZlbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwidW52ZXJpZmllZFwiO1xuICBmb3IgKGNvbnN0IGUgb2YgZXZlbnRzKVxuICAgIGlmIChlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIGlzSHVtYW4oKGUgYXMgeyBieT86IHVua25vd24gfSkuYnkpKSByZXR1cm4gXCJodW1hbi1yZXZpZXdlZFwiO1xuICByZXR1cm4gXCJtYWNoaW5lLWNvbmZpcm1lZFwiO1xufVxuXG4vKiogYHN0YWxlX2FmdGVyYCBpcyBhbiBJTlNUQU5ULCBub3QgYSBUVEw6IHN0YWxlIHdoZW4gbm93ID49IGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU3RhbGUoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgbm93OiBudW1iZXIpOiBib29sZWFuIHtcbiAgY29uc3QgYXQgPSBmaWVsZHMuc3RhbGVfYWZ0ZXI7XG4gIGNvbnN0IHQgPVxuICAgIGF0IGluc3RhbmNlb2YgRGF0ZSA/IGF0LmdldFRpbWUoKSA6IHR5cGVvZiBhdCA9PT0gXCJzdHJpbmdcIiA/IERhdGUucGFyc2UoYXQpIDogTnVtYmVyLk5hTjtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSAmJiBub3cgPj0gdDtcbn1cblxuLyoqIFdoZW4gdGhlIGNvbnRlbnQgbGFzdCBtZWFuaW5nZnVsbHkgY2hhbmdlZCwgcGVyIGBnZW5lcmF0ZWQuYXRgLCBhcyBhbiBJU08gZGF0ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZW5lcmF0ZWRBdChmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGcgPSBmaWVsZHMuZ2VuZXJhdGVkO1xuICBjb25zdCBhdCA9IGcgJiYgdHlwZW9mIGcgPT09IFwib2JqZWN0XCIgPyAoZyBhcyB7IGF0PzogdW5rbm93biB9KS5hdCA6IHVuZGVmaW5lZDtcbiAgaWYgKGF0IGluc3RhbmNlb2YgRGF0ZSkgcmV0dXJuIGF0LnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApO1xuICBpZiAodHlwZW9mIGF0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgdCA9IERhdGUucGFyc2UoYXQpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgPyBuZXcgRGF0ZSh0KS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSA6IGF0O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5jb25zdCBzdHIgPSAodjogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxuICB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2LnRyaW0oKSAhPT0gXCJcIiA/IHYudHJpbSgpIDogdW5kZWZpbmVkO1xuXG4vKipcbiAqIFJlYWQgYSBkb2N1bWVudCdzIGZyb250bWF0dGVyLiBSZXR1cm5zIG51bGwgd2hlbiB0aGVyZSBpcyBubyBibG9jayBhdCBhbGwg4oCUXG4gKiB3aGljaCBpcyBhIG5vcm1hbCBkb2N1bWVudCwgbm90IGEgZGVmZWN0LiBBIGJsb2NrIHRoYXQgd2lsbCBub3QgcGFyc2UgY29tZXNcbiAqIGJhY2sgd2l0aCBgZXJyb3JgIHNldCBhbmQgZXZlcnkgb3RoZXIgZmllbGQgZW1wdHk6IHNhaWQsIG5vdCBzd2FsbG93ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkTWV0YSh0ZXh0OiBzdHJpbmcsIG5vdyA9IERhdGUubm93KCkpOiBEb2NNZXRhIHwgbnVsbCB7XG4gIGNvbnN0IHsgcmF3IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBpZiAocmF3ID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgbGV0IGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgbGV0IGVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gQnVuLllBTUwucGFyc2UocmF3KSBhcyB1bmtub3duO1xuICAgIGlmIChwYXJzZWQgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWQpKVxuICAgICAgZmllbGRzID0gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGVsc2UgaWYgKHBhcnNlZCAhPT0gbnVsbCAmJiBwYXJzZWQgIT09IHVuZGVmaW5lZClcbiAgICAgIGVycm9yID0gXCJ0aGUgZnJvbnRtYXR0ZXIgaXMgbm90IGEgbWFwcGluZyBvZiBrZXlzIHRvIHZhbHVlc1wiO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZXJyb3IgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2Uuc3BsaXQoXCJcXG5cIilbMF0gOiBTdHJpbmcoZSk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICByYXcsXG4gICAgZmllbGRzLFxuICAgIHR5cGU6IHN0cihmaWVsZHMudHlwZSksXG4gICAgdGl0bGU6IHN0cihmaWVsZHMudGl0bGUpLFxuICAgIGRlc2NyaXB0aW9uOiBzdHIoZmllbGRzLmRlc2NyaXB0aW9uKSxcbiAgICBzdGF0dXM6IHN0YXR1c09mKGZpZWxkcyksXG4gICAgdGFnczogYXNMaXN0KGZpZWxkcy50YWdzKSxcbiAgICBsaWZlY3ljbGU6IHN0cihmaWVsZHMubGlmZWN5Y2xlKSxcbiAgICB0cnVzdDogdHJ1c3RUaWVyKGZpZWxkcyksXG4gICAgc3RhbGU6IGlzU3RhbGUoZmllbGRzLCBub3cpLFxuICAgIGRhdGU6IGdlbmVyYXRlZEF0KGZpZWxkcyksXG4gICAgLi4uKGVycm9yID8geyBlcnJvciB9IDoge30pLFxuICB9O1xufVxuXG4vKiogVGhlIHNtYWxsIHNoYXBlIHRoZSBzaWRlYmFyIG5lZWRzIGZvciBldmVyeSBjb250ZXh0IGRvY3VtZW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZShtZXRhOiBEb2NNZXRhIHwgbnVsbCk6IERvY1N1bW1hcnkgfCBudWxsIHtcbiAgaWYgKCFtZXRhKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICAuLi4obWV0YS50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAuLi4obWV0YS50aXRsZSA/IHsgdGl0bGU6IG1ldGEudGl0bGUgfSA6IHt9KSxcbiAgICBzdGF0dXM6IG1ldGEuc3RhdHVzLFxuICAgIHRhZ3M6IG1ldGEudGFncyxcbiAgICB0cnVzdDogbWV0YS50cnVzdCxcbiAgICBzdGFsZTogbWV0YS5zdGFsZSxcbiAgICAuLi4obWV0YS5saWZlY3ljbGUgPyB7IGxpZmVjeWNsZTogbWV0YS5saWZlY3ljbGUgfSA6IHt9KSxcbiAgICAuLi4obWV0YS5lcnJvciA/IHsgZXJyb3I6IG1ldGEuZXJyb3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIHBkb2NzJ3MgZmlsdGVyIHZvY2FidWxhcnksIHNvIHdoYXQgdGhlIGh1bWFuIGxlYXJucyB0aGVyZSBob2xkcyBoZXJlLiAqL1xuZXhwb3J0IHR5cGUgTWV0YUZpbHRlciA9IHtcbiAgdHlwZT86IHN0cmluZztcbiAgc3RhdHVzPzogc3RyaW5nO1xuICBsaWZlY3ljbGU/OiBzdHJpbmc7XG4gIHRhZz86IHN0cmluZztcbiAgLyoqIEFuIElTTyBkYXRlOyBtYXRjaGVzIGRvY3VtZW50cyB3aG9zZSBgZ2VuZXJhdGVkLmF0YCBpcyBvbiBvciBhZnRlciBpdC4gKi9cbiAgc2luY2U/OiBzdHJpbmc7XG59O1xuXG4vKipcbiAqIEZpbHRlcnMgYXJlIEFORGVkLCBhbmQgZXZlcnkgb25lIGlzIG9wdGlvbmFsIOKAlCBhIGJhcmUgZmlsdGVyIG1hdGNoZXMgYWxsLlxuICpcbiAqIOKblCBBIERPQ1VNRU5UIFdJVEggTk8gRlJPTlRNQVRURVIgTUFUQ0hFUyBPTkxZIFRIRSBFTVBUWSBGSUxURVIsIGFuZCB0aGF0XG4gKiBpbmNsdWRlcyBgLS1zdGF0dXMgc3RhYmxlYC4gQWJzZW50IGBzdGF0dXNgIGRlZmF1bHRzIHRvIGBzdGFibGVgIGZvciBhbiBPS0ZcbiAqIGRvY3VtZW50ICjCpzUpLCBidXQgYSBkb2N1bWVudCB3aXRoIG5vIGJsb2NrIGF0IGFsbCBpcyBub3QgbWFraW5nIHRoZSBjbGFpbTpcbiAqIGBmaW5kIC0tc3RhdHVzIHN0YWJsZWAgYXNrcyB3aGljaCBkb2N1bWVudHMgU0FZIHRoZXkgYXJlIHN0YWJsZSwgYW5kIGEgZmlsZVxuICogd2l0aCBubyBmcm9udG1hdHRlciBzYXlzIG5vdGhpbmcuIFJlYWRpbmcgdGhlIGRlZmF1bHQgdGhlIG90aGVyIHdheSB3b3VsZCBwdXRcbiAqIGV2ZXJ5IHVudG91Y2hlZCBub3RlIGluIHRoZSByZXN1bHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaGVzRmlsdGVyKG1ldGE6IERvY01ldGEgfCBudWxsLCBmaWx0ZXI6IE1ldGFGaWx0ZXIpOiBib29sZWFuIHtcbiAgaWYgKG1ldGEgPT09IG51bGwpIHJldHVybiBPYmplY3QudmFsdWVzKGZpbHRlcikuZXZlcnkoKHYpID0+IHYgPT09IHVuZGVmaW5lZCk7XG4gIGlmIChmaWx0ZXIudHlwZSAhPT0gdW5kZWZpbmVkICYmIG1ldGEudHlwZSAhPT0gZmlsdGVyLnR5cGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5zdGF0dXMgIT09IHVuZGVmaW5lZCAmJiBtZXRhLnN0YXR1cyAhPT0gZmlsdGVyLnN0YXR1cykgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLmxpZmVjeWNsZSAhPT0gdW5kZWZpbmVkICYmIG1ldGEubGlmZWN5Y2xlICE9PSBmaWx0ZXIubGlmZWN5Y2xlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIudGFnICE9PSB1bmRlZmluZWQgJiYgIW1ldGEudGFncy5pbmNsdWRlcyhmaWx0ZXIudGFnKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnNpbmNlICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIW1ldGEuZGF0ZSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChtZXRhLmRhdGUgPCBmaWx0ZXIuc2luY2UpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8g4pSA4pSAIFdSSVRJTkcgKEUzNSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8g4puUIEVWRVJZIFdSSVRFIEhFUkUgSVMgQSBURVhUIEVESVQsIE5FVkVSIEEgUkVTRVJJQUxJU0FUSU9OLiBQYXJzaW5nIGEgYmxvY2tcbi8vIGFuZCBwcmludGluZyBpdCBiYWNrIHJlb3JkZXJzIGtleXMsIGRyb3BzIGNvbW1lbnRzIGFuZCBjaGFuZ2VzIHF1b3Rpbmcg4oCUIGFuZFxuLy8gdGhlIHNwZWMgYXNrcyBhIGNvbnN1bWVyIHRvIFwicHJlc2VydmUgdW5rbm93biBrZXlzIHdoZW4gcm91bmQtdHJpcHBpbmdcIlxuLy8gKMKnMTEpLCB3aGljaCBpcyBwcmVjaXNlbHkgd2hhdCB0aGF0IGxvc2VzLiBTbyBhIG5ldyBibG9jayBpcyBCVUlMVCAodGhlcmUgaXNcbi8vIG5vdGhpbmcgdG8gcHJlc2VydmUgeWV0KSBhbmQgYW4gZXhpc3Rpbmcgb25lIGlzIGVkaXRlZCBhIExJTkUgYXQgYSB0aW1lLlxuXG4vKiogVGhlIGRvY3VtZW50J3MgZmlyc3QgSDEsIHdoaWNoIGlzIHRoZSB0aXRsZSBhIGh1bWFuIGFscmVhZHkgd3JvdGUuICovXG5leHBvcnQgZnVuY3Rpb24gdGl0bGVGcm9tQm9keShib2R5OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IG0gPSAvXiNcXHMrKC4rPylcXHMqJC8uZXhlYyhsaW5lKTtcbiAgICBpZiAobSkgcmV0dXJuIG1bMV07XG4gICAgaWYgKGxpbmUudHJpbSgpICE9PSBcIlwiICYmICFsaW5lLnN0YXJ0c1dpdGgoXCIjXCIpKSBicmVhazsgLy8gcHJvc2UgYmVmb3JlIGFueSBoZWFkaW5nXG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBBIGB0eXBlYCB0byBTVUdHRVNUIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuXG4gKlxuICog4puUIEZST00gVEhFIE5FSUdIQk9VUlMsIE5FVkVSIEZST00gQSBGSVhFRCBMSVNULiBPS0YncyBgdHlwZWAgaXMgXCJub3RcbiAqIGNlbnRyYWxseSByZWdpc3RlcmVkXCIgYW5kIGV2ZXJ5IGNvcnB1cyBpbnZlbnRzIGl0cyBvd24g4oCUIGByZXBvcnRgLCBgcnVsZWAsXG4gKiBgYXJjaGV0eXBlYCBpbiBvbmUsIHNvbWV0aGluZyBlbHNlIGluIHRoZSBuZXh0IOKAlCBzbyB0aGUgb25seSBob25lc3Qgc291cmNlIGlzXG4gKiB3aGF0IHRoZSBkb2N1bWVudHMgYmVzaWRlIHRoaXMgb25lIGFscmVhZHkgc2F5LiBUaGUgZm9sZGVyJ3MgbmFtZSBpcyB0aGVcbiAqIGZhbGxiYWNrLCBhbmQgd2hlbiBuZWl0aGVyIGFuc3dlcnMsIG5vdGhpbmcgaXMgc3VnZ2VzdGVkOiBhIGJsYW5rIHRoZSBodW1hblxuICogZmlsbHMgYmVhdHMgYSBwbGF1c2libGUgZ3Vlc3MgKFNDSEVNQS5tZCdzIG93biBydWxlIGFib3V0IGBnZW5lcmF0ZWQuYnlgKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGd1ZXNzVHlwZShzaWJsaW5nVHlwZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBmb2xkZXI6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGNvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBzaWJsaW5nVHlwZXMpIGlmICh0KSBjb3VudHMuc2V0KHQsIChjb3VudHMuZ2V0KHQpID8/IDApICsgMSk7XG4gIGNvbnN0IGJlc3QgPSBbLi4uY291bnRzLmVudHJpZXMoKV0uc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0gfHwgYVswXS5sb2NhbGVDb21wYXJlKGJbMF0pKVswXTtcbiAgaWYgKGJlc3QpIHJldHVybiBiZXN0WzBdO1xuICBjb25zdCBuYW1lID0gZm9sZGVyLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAobmFtZSA9PT0gXCJcIiB8fCBuYW1lID09PSBcIi5cIiB8fCBuYW1lID09PSBcIi9cIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgLy8gYGRlY2lzaW9ucy9gIOKGkiBgZGVjaXNpb25gOyBgZG9jcy9gIOKGkiBgZG9jYC4gQSBwbHVyYWwgZm9sZGVyIG5hbWVzIGl0cyBraW5kLlxuICByZXR1cm4gbmFtZS5lbmRzV2l0aChcImllc1wiKVxuICAgID8gYCR7bmFtZS5zbGljZSgwLCAtMyl9eWBcbiAgICA6IG5hbWUuZW5kc1dpdGgoXCJzXCIpXG4gICAgICA/IG5hbWUuc2xpY2UoMCwgLTEpXG4gICAgICA6IG5hbWU7XG59XG5cbi8qKiBBIFlBTUwgc2NhbGFyLCBxdW90ZWQgb25seSB3aGVuIGl0IG11c3QgYmUuICovXG5mdW5jdGlvbiBzY2FsYXIodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltcXHcgLiwnJy9AKy1dKiQvLnRlc3QodmFsdWUpICYmICEvXlxcc3xcXHMkLy50ZXN0KHZhbHVlKSAmJiB2YWx1ZSAhPT0gXCJcIlxuICAgID8gdmFsdWVcbiAgICA6IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbn1cblxuZXhwb3J0IHR5cGUgTmV3TWV0YSA9IHtcbiAgdHlwZT86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgLyoqIGBnZW5lcmF0ZWQuYnlgIOKAlCB0aGUgYWN0b3IsIHJlY29yZGVkIGhvbmVzdGx5IG9yIGxlZnQgYHVua25vd25gLiAqL1xuICBieT86IHN0cmluZztcbiAgYXQ/OiBzdHJpbmc7XG59O1xuXG4vKipcbiAqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS4gT0tGJ3MgcmVjb21tZW5kZWQgc2V0IGluXG4gKiB0aGUgb3JkZXIgdGhlIGNvcnBvcmEgd3JpdGUgaXQsIHdpdGggYGRlc2NyaXB0aW9uYCBsZWZ0IEVNUFRZIGZvciB0aGUgYXV0aG9yOlxuICogYSBvbmUtbGluZSBzdW1tYXJ5IG5vYm9keSB3cm90ZSBpcyB3b3JzZSB0aGFuIGEgYmxhbmsgdGhhdCBhc2tzIHRvIGJlIGZpbGxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQmxvY2sobWV0YTogTmV3TWV0YSk6IHN0cmluZyB7XG4gIGNvbnN0IGF0ID0gbWV0YS5hdCA/PyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApO1xuICBjb25zdCBsaW5lcyA9IFtcbiAgICBgdHlwZTogJHtzY2FsYXIobWV0YS50eXBlID8/IFwiXCIpfWAsXG4gICAgYHRpdGxlOiAke3NjYWxhcihtZXRhLnRpdGxlID8/IFwiXCIpfWAsXG4gICAgYGRlc2NyaXB0aW9uOiAke21ldGEuZGVzY3JpcHRpb24gPyBzY2FsYXIobWV0YS5kZXNjcmlwdGlvbikgOiBcIlwifWAsXG4gICAgYHRhZ3M6IFskeyhtZXRhLnRhZ3MgPz8gW10pLm1hcChzY2FsYXIpLmpvaW4oXCIsIFwiKX1dYCxcbiAgICBgc3RhdHVzOiAke3NjYWxhcihtZXRhLnN0YXR1cyA/PyBcImRyYWZ0XCIpfWAsXG4gICAgYGdlbmVyYXRlZDogeyBieTogJHtzY2FsYXIobWV0YS5ieSA/PyBcInVua25vd25cIil9LCBhdDogJHthdH0gfWAsXG4gIF07XG4gIHJldHVybiBgLS0tXFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfVxcbi0tLVxcbmA7XG59XG5cbi8qKlxuICogUHV0IGEgbmV3IGJsb2NrIGF0IHRoZSB0b3Agb2YgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLiBObyBibGFuayBsaW5lIGlzXG4gKiBpbnNlcnRlZDogdGhlIGNvcnBvcmEgd3JpdGUgdGhlIGJvZHkgZGlyZWN0bHkgdW5kZXIgdGhlIGNsb3NpbmcgYC0tLWAsIGFuZCBhXG4gKiBibG9jayB0aGF0IGFkZHMgb25lIHdvdWxkIHNob3cgYXMgYSBkaWZmIG9uIGV2ZXJ5IGRvY3VtZW50IGl0IHRvdWNoZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRoQmxvY2sodGV4dDogc3RyaW5nLCBibG9jazogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2Jsb2NrfSR7dGV4dH1gO1xufVxuXG4vKipcbiAqIFNldCBvbmUga2V5IGluIGFuIEVYSVNUSU5HIGJsb2NrLCBhcyBhIGxpbmUgZWRpdDogdGhlIGtleSdzIGxpbmUgaXMgcmVwbGFjZWRcbiAqIHdoZXJlIGl0IGV4aXN0cyBhbmQgYXBwZW5kZWQgYmVmb3JlIHRoZSBjbG9zaW5nIGAtLS1gIHdoZXJlIGl0IGRvZXMgbm90LlxuICogRXZlcnl0aGluZyBlbHNlIOKAlCBvcmRlciwgY29tbWVudHMsIHNwYWNpbmcsIGtleXMgdGhpcyBzcGVsbCBuZXZlciBoZWFyZCBvZiDigJRcbiAqIHN1cnZpdmVzIGJ5dGUgZm9yIGJ5dGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRLZXkodGV4dDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHsgcmF3IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBpZiAocmF3ID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoXCJ0aGlzIGRvY3VtZW50IGhhcyBubyBmcm9udG1hdHRlciBibG9ja1wiKTtcbiAgY29uc3QgbGluZSA9IGAke2tleX06ICR7c2NhbGFyKHZhbHVlKX1gO1xuICBjb25zdCBrZXlMaW5lID0gbmV3IFJlZ0V4cChgXiR7a2V5LnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKX1cXFxccyo6YCk7XG4gIGNvbnN0IGxpbmVzID0gcmF3LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBhdCA9IGxpbmVzLmZpbmRJbmRleCgobCkgPT4ga2V5TGluZS50ZXN0KGwpKTtcbiAgaWYgKGF0ID09PSAtMSkgbGluZXMucHVzaChsaW5lKTtcbiAgZWxzZSB7XG4gICAgLy8gQSBtdWx0aS1saW5lIHZhbHVlIChhIGZvbGRlZCBkZXNjcmlwdGlvbiwgYSBuZXN0ZWQgbWFwcGluZykgaXMgdGhlXG4gICAgLy8ga2V5J3MgbGluZSBQTFVTIGV2ZXJ5IGluZGVudGVkIGxpbmUgdW5kZXIgaXQ7IGFsbCBvZiB0aGVtIGdvLlxuICAgIGxldCBlbmQgPSBhdCArIDE7XG4gICAgd2hpbGUgKGVuZCA8IGxpbmVzLmxlbmd0aCAmJiAvXlxccytcXFMvLnRlc3QobGluZXNbZW5kXSA/PyBcIlwiKSkgZW5kKys7XG4gICAgbGluZXMuc3BsaWNlKGF0LCBlbmQgLSBhdCwgbGluZSk7XG4gIH1cbiAgY29uc3QgcmVidWlsdCA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UocmF3LCByZWJ1aWx0KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBMaW5rcyBiZXR3ZWVuIGRvY3VtZW50cyAoRTMzKTogd2hhdCBhIGRvY3VtZW50IHBvaW50cyBhdCwgYW5kIHdoYXQgdGhhdFxuICogcmVzb2x2ZXMgdG8gaW5zaWRlIGEgc2V0LlxuICpcbiAqIOKUgOKUgCBGT1VSIFNPVVJDRVMgT0YgRURHRVMsIEFORCBUSEVZIEFSRSBOT1QgT05FIEtJTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogICAxLiBtYXJrZG93biBsaW5rcyAgICAgIGBbbGFiZWxdKC4vb3RoZXIubWQpYCAgICAgIOKAlCBib2R5XG4gKiAgIDIuIHdpa2kgbGlua3MgICAgICAgICAgYFtbb3RoZXItZG9jfGxhYmVsXV1gICAgICAg4oCUIGJvZHlcbiAqICAgMy4gZnJvbnRtYXR0ZXIgdmFsdWVzICBgcmVsYXRlZDogW2NvbmNlcHQveF1gICAgICDigJQgYXV0aG9yZWQgaW50ZW50XG4gKiAgIDQuIGBzb3VyY2VzW10ucmVzb3VyY2VgICAgICAgICAgICAgICAgICAgICAgICAgICAg4oCUIGF1dGhvcmVkIGludGVudFxuICpcbiAqIHBkb2NzIGtlZXBzIHRoZSBmcm9udG1hdHRlciBlZGdlIGFuZCB0aGUgYm9keS1saW5rIGVkZ2UgQVBBUlQgKGByZWxhdGVkW11gXG4gKiBhbmQgYGxpbmtzW11gIGluIGl0cyBgYmFja2xpbmtzYCBvdXRwdXQpLCBhbmQgdGhlIGRpc3RpbmN0aW9uIGlzIHJlYWw6IGFcbiAqIGByZWxhdGVkYCBrZXkgaXMgYSBjbGFpbSB0aGUgYXV0aG9yIG1hZGUgYWJvdXQgdGhlIGRvY3VtZW50IGFzIGEgd2hvbGUsIGFcbiAqIGJvZHkgbGluayBpcyBhIGNpdGF0aW9uIGF0IGEgcGxhY2UgaW4gdGhlIHByb3NlLiBUaGV5IHN0YXkgYXBhcnQgaGVyZSB0b28uXG4gKlxuICog4pSA4pSAIFRZUEVEIExJTktTIChPcGVyYXRvcidzIHNoYXBlLCBDb2xlIDIwMjYtMDktMTEpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEEgcmVsYXRpb24gcmlkZXMgdGhlIGxpbmsgYXMgYSBxdWVyeTogYFtsYWJlbF0oLi9vdGhlci5tZD9yZWw9ZXh0ZW5kcylgLFxuICogYFtbb3RoZXI/cmVsPXN1cGVyc2VkZXN8bGFiZWxdXWAuIENvcGllZCBleGFjdGx5IGZyb20gT3BlcmF0b3IncyBwYXJzZXJcbiAqIChgcGFja2FnZXMvc2hhcmVkL3NyYy9saW5rcy9gKTogb25lIGxpbmsgY2FycmllcyBBTEwgb2YgaXRzIHJlbHMsIHRoZXkgYXJlXG4gKiBub3JtYWxpc2VkIChsb3dlcmNhc2VkLCB0cmltbWVkLCBkZWR1cGVkLCBmaXJzdC1hdXRob3JlZCBvcmRlciBrZXB0KSBidXRcbiAqIHRoZWlyIFNQRUxMSU5HIGlzIG5vdCBjYW5vbmljYWxpc2VkLCBhbmQgKiphIGJhcmUgbGluayBpcyBgW11gIOKAlCB0aGUgQUJTRU5DRVxuICogb2YgYW4gYXNzZXJ0aW9uLCBub3QgYW4gaW1wbGljaXQgYHJlZmVyZW5jZXNgKiouIEEgZ3JhcGggbXVzdCBub3QgZHJhdyBhXG4gKiBjbGFpbSBub2JvZHkgbWFkZS5cbiAqXG4gKiDilIDilIAgV0hBVCBBIEJVTkRMRSBJUyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBPS0YncyBidW5kbGUtcmVsYXRpdmUgZm9ybSAoYC9jb25jZXB0cy94Lm1kYCkgbWVhbnMgdGhlIEJVTkRMRSByb290LCBub3QgdGhlXG4gKiBmaWxlc3lzdGVtIHJvb3QsIHNvIGEgcmVzb2x2ZXIgbmVlZHMgYSBidW5kbGUgYmVmb3JlIGl0IGNhbiByZXNvbHZlIGFueXRoaW5nOlxuICogKiphIHNldCdzIGVudHJ5IHJvb3QgaXMgdGhlIGJ1bmRsZSoqIChFMzMpLiBBIHRhcmdldCB0aGF0IGVzY2FwZXMgaXQgaXMgbm90IGFuXG4gKiBlcnJvciDigJQgdGhlIHNwZWMgcmVxdWlyZXMgdG9sZXJhdGluZyBicm9rZW4gbGlua3Mg4oCUIGl0IGlzIGFuIGVkZ2UgbWFya2VkXG4gKiBgb3V0c2lkZWAgb3IgYG1pc3NpbmdgLCB3aGljaCB0aGUgc3VyZmFjZSBvZmZlcnMgdG8gYWRkIHJhdGhlciB0aGFuIGZvbGxvdy5cbiAqL1xuaW1wb3J0IHtcbiAgYmFzZW5hbWUsXG4gIGRpcm5hbWUsXG4gIGV4dG5hbWUsXG4gIGpvaW4sXG4gIG5vcm1hbGl6ZSxcbiAgcmVsYXRpdmUsXG4gIHJlc29sdmUgYXMgcmVzb2x2ZVBhdGgsXG59IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgRG9jTWV0YSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0b1Bvc2l4IH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgdHlwZSBMaW5rS2luZCA9IFwibWFya2Rvd25cIiB8IFwid2lraVwiO1xuXG4vKiogT25lIGxpbmsgYXMgd3JpdHRlbiwgYmVmb3JlIGFueXRoaW5nIGlzIHJlc29sdmVkLiAqL1xuZXhwb3J0IHR5cGUgTGlua1JlZiA9IHtcbiAga2luZDogTGlua0tpbmQ7XG4gIC8qKiBUaGUgdGFyZ2V0IGFzIGF1dGhvcmVkLCB3aXRoIGl0cyBxdWVyeSBhbmQgYW5jaG9yIHN0cmlwcGVkLiAqL1xuICB0YXJnZXQ6IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSB0YXJnZXQgRVhBQ1RMWSBhcyB3cml0dGVuIOKAlCBxdWVyeSwgYW5jaG9yLCBwZXJjZW50LWVuY29kaW5nIGFuZCBhbGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIFdIQVQgTUFLRVMgQSBEQU5HTElORyBMSU5LIEZJWEFCTEUuIGB0YXJnZXRgIGlzIHRoZSByZXNvbHZlZFxuICAgKiBzaGFwZSwgc28gYSByZXBvcnQgYnVpbHQgZnJvbSBpdCB0ZWxscyB5b3UgdG8gbG9vayBmb3IgYGRlZXAubWRgIHdoZW4gdGhlXG4gICAqIGRvY3VtZW50IGFjdHVhbGx5IHNheXMgYC4vbWlzc2luZy9kZWVwLm1kP3JlbD14YCDigJQgYSBzdHJpbmcgdGhhdCBpcyBub3QgaW5cbiAgICogdGhlIGZpbGUuIFdob2V2ZXIgKG9yIHdoYXRldmVyKSBnb2VzIHRvIHJlcGFpciB0aGUgbGluayBuZWVkcyB0aGUgc3RyaW5nXG4gICAqIHRoYXQgaXMgdGhlcmUuXG4gICAqL1xuICByYXc6IHN0cmluZztcbiAgLyoqIDEtYmFzZWQgbGluZSBpbiB0aGUgYm9keSB0aGUgbGluayB3YXMgd3JpdHRlbiBvbiwgZm9yIHRoZSBzYW1lIHJlYXNvbi4gKi9cbiAgbGluZTogbnVtYmVyO1xuICAvKiogUmVsYXRpb25zIGZyb20gYD9yZWw9YDsgRU1QVFkgbWVhbnMgbm8gYXNzZXJ0aW9uLCBuZXZlciBgcmVmZXJlbmNlc2AuICovXG4gIHJlbDogc3RyaW5nW107XG4gIGxhYmVsPzogc3RyaW5nO1xufTtcblxuLyoqIEEgcmVmZXJlbmNlIGZvdW5kIGluIGZyb250bWF0dGVyLCB3aXRoIHRoZSBrZXkgdGhhdCBjYXJyaWVkIGl0LiAqL1xuZXhwb3J0IHR5cGUgRmllbGRSZWYgPSB7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH07XG5cbmNvbnN0IEZFTkNFX0xJTkUgPSAvXig/OmBgYHx+fn4pLztcblxuLyoqXG4gKiBTdHJpcCBmZW5jZWQgY29kZSBibG9ja3MuIEEgZG9jdW1lbnQgYWJvdXQgbGlua3MgcXVvdGVzIGxpbmsgc3ludGF4LCBhbmQgdGhlXG4gKiB3aWtpIHRoaXMgd2FzIGJ1aWx0IGFnYWluc3QgZG9lcyBleGFjdGx5IHRoYXQg4oCUIHdpdGhvdXQgdGhpcywgU0NIRU1BLm1kJ3NcbiAqIGV4YW1wbGVzIGJlY29tZSBlZGdlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhvdXRGZW5jZXMoYm9keTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IG0gPSBGRU5DRV9MSU5FLmV4ZWMobGluZSk7XG4gICAgaWYgKGZlbmNlID09PSBudWxsICYmIG0pIHtcbiAgICAgIGZlbmNlID0gbVswXTtcbiAgICAgIG91dC5wdXNoKFwiXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChmZW5jZSAhPT0gbnVsbCkge1xuICAgICAgaWYgKG0gJiYgbGluZS5zdGFydHNXaXRoKGZlbmNlKSkgZmVuY2UgPSBudWxsO1xuICAgICAgb3V0LnB1c2goXCJcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3V0LnB1c2gobGluZSk7XG4gIH1cbiAgcmV0dXJuIG91dC5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogYD9yZWw9YSxiYCDihpIgYFtcImFcIixcImJcIl1gLCBub3JtYWxpc2VkIHRoZSB3YXkgT3BlcmF0b3Igbm9ybWFsaXNlcyB0aGVtLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUmVsKHF1ZXJ5OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmdbXSB7XG4gIGlmICghcXVlcnkpIHJldHVybiBbXTtcbiAgY29uc3QgbSA9IC8oPzpefFs/Jl0pcmVsPShbXiZdKikvLmV4ZWMocXVlcnkpO1xuICBpZiAoIW0pIHJldHVybiBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcmF3IG9mIGRlY29kZVVSSUNvbXBvbmVudChtWzFdID8/IFwiXCIpLnNwbGl0KFwiLFwiKSkge1xuICAgIGNvbnN0IHJlbCA9IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAocmVsID09PSBcIlwiIHx8IHNlZW4uaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHJlbCk7XG4gICAgb3V0LnB1c2gocmVsKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogU3BsaXQgYSB3cml0dGVuIHRhcmdldCBpbnRvIGl0cyBwYXRoLCBpdHMgcXVlcnkgYW5kIGl0cyBhbmNob3IuICovXG4vKipcbiAqIFBlcmNlbnQtZGVjb2RpbmcsIHdoaWNoIGEgbWFya2Rvd24gbGluayB0YXJnZXQgY2FycmllcyB3aGVuZXZlciB0aGUgZmlsZSBpdFxuICogbmFtZXMgaGFzIGEgc3BhY2UgaW4gaXQg4oCUIGBNYXJlbidzJTIwQmFrZXJ5Lm1kYCAoRTQ5KS5cbiAqXG4gKiDim5QgSVQgTVVTVCBOT1QgVEhST1cuIGBkZWNvZGVVUklDb21wb25lbnRgIHJlamVjdHMgYSBsb25lIGAlYCwgYW5kIGEgZmlsZVxuICogY2FsbGVkIGAxMDAlIGRvbmUubWRgIGlzIGEgcGVyZmVjdGx5IG9yZGluYXJ5IHRoaW5nIHRvIGxpbmsgdG8uIEFuXG4gKiB1bmRlY29kYWJsZSB0YXJnZXQgaXMgcmV0dXJuZWQgYXMgaXQgc3RhbmRzOiB3b3JzdCBjYXNlIGl0IGZhaWxzIHRvIHJlc29sdmUsXG4gKiB3aGljaCBpcyB0aGUgYmVoYXZpb3VyIGJlZm9yZSBkZWNvZGluZyBleGlzdGVkLCByYXRoZXIgdGhhbiB0YWtpbmcgdGhlIGdyYXBoXG4gKiBkb3duIHdpdGggaXQuXG4gKi9cbmZ1bmN0aW9uIGRlY29kZVBhdGgocmF3OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXJhdy5pbmNsdWRlcyhcIiVcIikpIHJldHVybiByYXc7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGRlY29kZVVSSUNvbXBvbmVudChyYXcpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcmF3O1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdFRhcmdldChyYXc6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBxdWVyeT86IHN0cmluZzsgYW5jaG9yPzogc3RyaW5nIH0ge1xuICBjb25zdCBoYXNoID0gcmF3LmluZGV4T2YoXCIjXCIpO1xuICBjb25zdCB3aXRob3V0QW5jaG9yID0gaGFzaCA9PT0gLTEgPyByYXcgOiByYXcuc2xpY2UoMCwgaGFzaCk7XG4gIGNvbnN0IGFuY2hvciA9IGhhc2ggPT09IC0xID8gdW5kZWZpbmVkIDogcmF3LnNsaWNlKGhhc2ggKyAxKTtcbiAgY29uc3QgcSA9IHdpdGhvdXRBbmNob3IuaW5kZXhPZihcIj9cIik7XG4gIHJldHVybiB7XG4gICAgcGF0aDogZGVjb2RlUGF0aCgocSA9PT0gLTEgPyB3aXRob3V0QW5jaG9yIDogd2l0aG91dEFuY2hvci5zbGljZSgwLCBxKSkudHJpbSgpKSxcbiAgICAuLi4ocSA9PT0gLTEgPyB7fSA6IHsgcXVlcnk6IHdpdGhvdXRBbmNob3Iuc2xpY2UocSArIDEpIH0pLFxuICAgIC4uLihhbmNob3IgPyB7IGFuY2hvciB9IDoge30pLFxuICB9O1xufVxuXG5jb25zdCBFWFRFUk5BTCA9IC9eW2Etel1bYS16MC05Ky4tXSo6L2k7XG5jb25zdCBNRF9MSU5LID0gLyghPylcXFsoW15cXF1cXG5dKilcXF1cXCgoW14pXFxzXSspKD86XFxzK1wiW15cIl0qXCIpP1xcKS9nO1xuY29uc3QgV0lLSV9MSU5LID0gL1xcW1xcWyhbXlxcXVxcbl0rKVxcXVxcXS9nO1xuXG4vKiogRXZlcnkgbGluayBhIGRvY3VtZW50J3MgQk9EWSBwb2ludHMgYXQg4oCUIGV4dGVybmFsIHRhcmdldHMgYW5kIGltYWdlcyBsZWZ0IG91dC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TGlua3MoYm9keTogc3RyaW5nKTogTGlua1JlZltdIHtcbiAgY29uc3QgdGV4dCA9IHdpdGhvdXRGZW5jZXMoYm9keSk7XG4gIGNvbnN0IG91dDogTGlua1JlZltdID0gW107XG4gIC8vIOKaoCBMSU5FIE5VTUJFUlMgU1VSVklWRSBgd2l0aG91dEZlbmNlc2AgQU5EIE9GRlNFVFMgRE8gTk9UOiBpdCBibGFua3MgZWFjaFxuICAvLyBmZW5jZWQgbGluZSByYXRoZXIgdGhhbiBkZWxldGluZyBpdCwgc28gdGhlIGxpbmUgQ09VTlQgaXMgcHJlc2VydmVkIHdoaWxlXG4gIC8vIHRoZSBjaGFyYWN0ZXIgb2Zmc2V0cyBhcmUgbm90LiBDb3VudGluZyBuZXdsaW5lcyBpcyB0aGVyZWZvcmUgc291bmQ7IHVzaW5nXG4gIC8vIGBtLmluZGV4YCBhcyBhIGNoYXJhY3RlciBwb3NpdGlvbiBpbiB0aGUgb3JpZ2luYWwgYm9keSB3b3VsZCBub3QgYmUuXG4gIGNvbnN0IGxpbmVBdCA9IChhdDogbnVtYmVyKSA9PiB7XG4gICAgbGV0IGxpbmUgPSAxO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXQgJiYgaSA8IHRleHQubGVuZ3RoOyBpKyspIGlmICh0ZXh0LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBsaW5lKys7XG4gICAgcmV0dXJuIGxpbmU7XG4gIH07XG4gIGZvciAoY29uc3QgbSBvZiB0ZXh0Lm1hdGNoQWxsKE1EX0xJTkspKSB7XG4gICAgaWYgKG1bMV0gPT09IFwiIVwiKSBjb250aW51ZTsgLy8gYW4gaW1hZ2UgaXMgbm90IGEgZG9jdW1lbnQgbGlua1xuICAgIGNvbnN0IHJhdyA9IG1bM10gPz8gXCJcIjtcbiAgICBpZiAoRVhURVJOQUwudGVzdChyYXcpIHx8IHJhdy5zdGFydHNXaXRoKFwiI1wiKSkgY29udGludWU7XG4gICAgY29uc3QgeyBwYXRoLCBxdWVyeSB9ID0gc3BsaXRUYXJnZXQocmF3KTtcbiAgICBpZiAocGF0aCA9PT0gXCJcIikgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJtYXJrZG93blwiLFxuICAgICAgdGFyZ2V0OiBwYXRoLFxuICAgICAgcmF3LFxuICAgICAgbGluZTogbGluZUF0KG0uaW5kZXggPz8gMCksXG4gICAgICByZWw6IHBhcnNlUmVsKHF1ZXJ5KSxcbiAgICAgIC4uLihtWzJdID8geyBsYWJlbDogbVsyXSB9IDoge30pLFxuICAgIH0pO1xuICB9XG4gIGZvciAoY29uc3QgbSBvZiB0ZXh0Lm1hdGNoQWxsKFdJS0lfTElOSykpIHtcbiAgICBjb25zdCBpbm5lciA9IG1bMV0gPz8gXCJcIjtcbiAgICBjb25zdCBwaXBlID0gaW5uZXIuaW5kZXhPZihcInxcIik7XG4gICAgY29uc3QgdGFyZ2V0UGFydCA9IHBpcGUgPT09IC0xID8gaW5uZXIgOiBpbm5lci5zbGljZSgwLCBwaXBlKTtcbiAgICBjb25zdCBsYWJlbCA9IHBpcGUgPT09IC0xID8gdW5kZWZpbmVkIDogaW5uZXIuc2xpY2UocGlwZSArIDEpLnRyaW0oKTtcbiAgICBjb25zdCB7IHBhdGgsIHF1ZXJ5IH0gPSBzcGxpdFRhcmdldCh0YXJnZXRQYXJ0KTtcbiAgICBpZiAocGF0aCA9PT0gXCJcIikgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJ3aWtpXCIsXG4gICAgICB0YXJnZXQ6IHBhdGgsXG4gICAgICByYXc6IHRhcmdldFBhcnQsXG4gICAgICBsaW5lOiBsaW5lQXQobS5pbmRleCA/PyAwKSxcbiAgICAgIHJlbDogcGFyc2VSZWwocXVlcnkpLFxuICAgICAgLi4uKGxhYmVsID8geyBsYWJlbCB9IDoge30pLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBEb2VzIHRoaXMgZnJvbnRtYXR0ZXIgdmFsdWUgTE9PSyBsaWtlIGEgZG9jdW1lbnQgcmVmZXJlbmNlPyAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzTGlrZVJlZih2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdiA9IHZhbHVlLnRyaW0oKTtcbiAgaWYgKHYgPT09IFwiXCIgfHwgRVhURVJOQUwudGVzdCh2KSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdi5pbmNsdWRlcyhcIi9cIikgfHwgdi50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKFwiLm1kXCIpO1xufVxuXG4vKipcbiAqIFJlZmVyZW5jZXMgaW5zaWRlIGZyb250bWF0dGVyLCB3aGF0ZXZlciBrZXkgY2FycmllcyB0aGVtIOKAlCBgcmVsYXRlZGAsXG4gKiBgc3VwZXJzZWRlc2AsIGBzb3VyY2VzW10ucmVzb3VyY2VgLCBvciBhIGtleSBpbnZlbnRlZCB0b21vcnJvdy4gVGhlIFNIQVBFXG4gKiBkZWNpZGVzIChhIHNsYXNoIG9yIGEgYC5tZGApLCB3aGljaCBpcyB3aHkgYmFyZSBgdGFnc2AgYXJlIG5vdCByZWZlcmVuY2VzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmllbGRSZWZzKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG1heERlcHRoID0gNCk6IEZpZWxkUmVmW10ge1xuICBjb25zdCBvdXQ6IEZpZWxkUmVmW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGRlcHRoOiBudW1iZXIpID0+IHtcbiAgICBpZiAoZGVwdGggPiBtYXhEZXB0aCkgcmV0dXJuO1xuICAgIGlmIChsb29rc0xpa2VSZWYodmFsdWUpKSBvdXQucHVzaCh7IGtleSwgdmFsdWU6IHZhbHVlLnRyaW0oKSB9KTtcbiAgICBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgZm9yIChjb25zdCB2IG9mIHZhbHVlKSB3YWxrKGtleSwgdiwgZGVwdGggKyAxKTtcbiAgICBlbHNlIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIpXG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpXG4gICAgICAgIHdhbGsoYCR7a2V5fS4ke2t9YCwgdiwgZGVwdGggKyAxKTtcbiAgfTtcbiAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoZmllbGRzKSkgd2FsayhrLCB2LCAwKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoZXJlIGEgdGFyZ2V0IGxhbmRlZC4gYG91dHNpZGVgIGV4aXN0cyBvbiBkaXNrIGJ1dCBub3QgaW4gdGhpcyBidW5kbGUuICovXG5leHBvcnQgdHlwZSBSZXNvbHV0aW9uID1cbiAgfCB7IHN0YXRlOiBcImluLWJ1bmRsZVwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsgc3RhdGU6IFwib3V0c2lkZVwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsgc3RhdGU6IFwibWlzc2luZ1wiOyB0cmllZDogc3RyaW5nIH07XG5cbmV4cG9ydCB0eXBlIEJ1bmRsZUluZGV4ID0ge1xuICAvKiogVGhlIHNldCdzIHJvb3Qg4oCUIE9LRidzIGJ1bmRsZSwgYW5kIHdoYXQgYSBgL2AtdGFyZ2V0IGlzIHJlbGF0aXZlIHRvLiAqL1xuICByb290OiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRocyBvZiBldmVyeSBkb2N1bWVudCBpbiB0aGUgYnVuZGxlLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIGRvY3VtZW50J3MgcGFyc2VkIGZyb250bWF0dGVyLCBmb3IgYHR5cGUvc2x1Z2AgcmVzb2x1dGlvbi4gKi9cbiAgbWV0YU9mOiAocGF0aDogc3RyaW5nKSA9PiBEb2NNZXRhIHwgbnVsbDtcbiAgLyoqIERvZXMgdGhpcyBwYXRoIGV4aXN0IG9uIGRpc2s/IChJbmplY3RlZCwgc28gdGhlIHJlc29sdmVyIHN0YXlzIHB1cmUuKSAqL1xuICBleGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBUaGUgZ2l0IHdvcmtpbmcgdHJlZSB0aGUgYnVuZGxlIHNpdHMgaW4sIHdoZW4gdGhlcmUgaXMgb25lLiBBIHRoaXJkIHBsYWNlXG4gICAqIGFuIHVuYW5jaG9yZWQgcGF0aCBpcyB0cmllZDogcGRvY3Mgd3JpdGVzIHJlcG8tcmVsYXRpdmUgcGF0aHNcbiAgICogKGBkb2NzL3BsYXlib29rcy9mb28ubWRgKSBhbmQgdGhlIHdpa2kncyBydWxlIHBhZ2VzIGNhcnJ5IHJlcG8tcmVsYXRpdmVcbiAgICogYGNoZWNrZXI6YCB2YWx1ZXMsIGFuZCBuZWl0aGVyIHJlc29sdmVzIGZyb20gdGhlIGRvY3VtZW50IG9yIHRoZSBidW5kbGUuXG4gICAqL1xuICByZXBvUm9vdD86IHN0cmluZyB8IG51bGw7XG59O1xuXG5jb25zdCBzdGVtID0gKHA6IHN0cmluZykgPT4gYmFzZW5hbWUocCwgZXh0bmFtZShwKSk7XG5cbi8qKlxuICogUmVzb2x2ZSBvbmUgd3JpdHRlbiB0YXJnZXQgYWdhaW5zdCB0aGUgYnVuZGxlLlxuICpcbiAqIEZvdXIgZm9ybXMsIGluIG9yZGVyOiBhIGJ1bmRsZS1yZWxhdGl2ZSBwYXRoIChgL3gveS5tZGApLCBhIHJlbGF0aXZlIHBhdGhcbiAqIChgLi95Lm1kYCwgYC4uL3gveS5tZGApLCBhIGB0eXBlL3NsdWdgIGtleSDigJQgcGRvY3MnIGFuZCB0aGUgd2lraSdzIG93biBmb3JtLFxuICogd2hpY2ggcmVzb2x2ZXMgYnkgVFlQRSBhbmQgQkFTRU5BTUUgc28gYSBwYWdlIGNhbiBtb3ZlIGZvbGRlcnMgd2l0aG91dFxuICogYnJlYWtpbmcgaW5ib3VuZCByZWZlcmVuY2VzIOKAlCBhbmQgYSBiYXJlIG5hbWUgKGEgd2lraSBsaW5rKSwgYnkgYmFzZW5hbWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVGFyZ2V0KHJhd1RhcmdldDogc3RyaW5nLCBmcm9tOiBzdHJpbmcsIGluZGV4OiBCdW5kbGVJbmRleCk6IFJlc29sdXRpb24ge1xuICAvLyDim5QgU1BMSVQgRklSU1QsIEJFQ0FVU0UgVEhFIENBTExFUlMgRElTQUdSRUUgQUJPVVQgV0hBVCBUSEVZIEhBTkQgT1ZFUi5cbiAgLy8gYGV4dHJhY3RMaW5rc2Agc3BsaXRzIGEgdGFyZ2V0IGJlZm9yZSBpdCBldmVyIGdldHMgaGVyZSAoRTQ5KSwgYnV0IHRoZVxuICAvLyBDTElDSyBwYXRoIGRvZXMgbm90OiBgbGluay5vcGVuYCBjYXJyaWVzIHRoZSBocmVmIGV4YWN0bHkgYXMgdGhlIGRvY3VtZW50XG4gIC8vIHdyb3RlIGl0LiBTbyBhbiBPcGVyYXRvciB0eXBlZCBsaW5rIOKAlCBgTWFyZW4ncyUyMEJha2VyeS5tZD9yZWw9bG9jYXRlZC1pbmBcbiAgLy8g4oCUIGFycml2ZWQgd2l0aCBpdHMgcXVlcnkgYW5kIGl0cyBlbmNvZGluZyBpbnRhY3QsIGBleHRuYW1lYCByZWFkXG4gIC8vIGAubWQ/cmVsPWxvY2F0ZWQtaW5gLCBhbmQgdGhlIGxvb2t1cCB3ZW50IGh1bnRpbmcgZm9yIGEgZmlsZSBuYW1lZCBhZnRlclxuICAvLyB0aGUgd2hvbGUgc3RyaW5nLiBUaGUgR1JBUEggZHJldyB0aGF0IGVkZ2UgY29ycmVjdGx5IHRoZSBlbnRpcmUgdGltZSwgd2hpY2hcbiAgLy8gaXMgd2hhdCBtYWRlIGl0IHB1enpsaW5nOiB0aGUgc2FtZSBsaW5rIHdhcyBmaW5lIGluIHRoZSBtYXAgYW5kIGRlYWQgdW5kZXJcbiAgLy8gdGhlIHBvaW50ZXIuIFNwbGl0dGluZyBoZXJlIGZpeGVzIGV2ZXJ5IGNhbGxlciBhdCBvbmNlIGFuZCBpcyBpZGVtcG90ZW50XG4gIC8vIGZvciB0aGUgdHdvIHRoYXQgaGFkIGFscmVhZHkgZG9uZSBpdC4gKENvbGUgZm91bmQgaXQgYnkgY2xpY2tpbmcgb25lIGluXG4gIC8vIEhvbGxvd2Jyb29rLCAyMDI2LTA5LTE0LilcbiAgY29uc3QgdGFyZ2V0ID0gc3BsaXRUYXJnZXQocmF3VGFyZ2V0KS5wYXRoO1xuICAvLyDim5QgV0hBVCBNQUtFUyBBIFRBUkdFVCBBIFBBVEggUkFUSEVSIFRIQU4gQSBLRVksIGFuZCB0aGUgY2FzZSB0aGF0IHRhdWdodFxuICAvLyBpdDogYFt0aGUgbGludGVyXShsaW50LnRzKWAgaW4gdGhlIHJlYWwgd2lraSBoYXMgbm8gYC4vYCBhbmQgaXMgbm90IGEgYC5tZGAsXG4gIC8vIHNvIGEgcnVsZSBrZXllZCBvbiB0aG9zZSB0d28gcmVhZCBpdCBhcyBhIE5BTUUgYW5kIHJlcG9ydGVkIGl0IG1pc3NpbmdcbiAgLy8gd2hpbGUgdGhlIGZpbGUgc2F0IHJpZ2h0IHRoZXJlLiBBIHRhcmdldCBpcyBhIHBhdGggd2hlbiBpdCBpcyBhbmNob3JlZFxuICAvLyAoYC9gLCBgLi9gLCBgLi4vYCkgb3IgY2FycmllcyBBTlkgZXh0ZW5zaW9uOyBgY29uY2VwdC9leGl0LWNvZGVzYCBoYXNcbiAgLy8gbmVpdGhlciwgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIGB0eXBlL3NsdWdgIGtleSBhIGtleS5cbiAgY29uc3QgbG9va3NQYXRoID1cbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8XG4gICAgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuLi9cIikgfHxcbiAgICBleHRuYW1lKHRhcmdldCkgIT09IFwiXCI7XG4gIGlmIChsb29rc1BhdGgpIHtcbiAgICAvLyBBbiBVTkFOQ0hPUkVEIHBhdGggKGBzcmMvYWNjL2tpdC94LnRzYCwgYHJlcG9ydHMvYS5tZGAg4oCUIG5vIGAuL2AgYW5kIG5vXG4gICAgLy8gbGVhZGluZyBgL2ApIGlzIGFtYmlndW91czogcmVsYXRpdmUgdG8gdGhlIGRvY3VtZW50LCBvciB0byB0aGUgYnVuZGxlP1xuICAgIC8vIEJvdGggYXJlIHRyaWVkLCBkb2N1bWVudCBmaXJzdC4gTWVhc3VyZWQgb24gdGhlIHJlYWwgd2lraSwgd2hlcmUgYSBydWxlXG4gICAgLy8gcGFnZSdzIGBjaGVja2VyOiBzcmMvYWNjL2tpdC9jaGVja2Vycy/igKZgIHdhcyByZXBvcnRlZCBtaXNzaW5nIHdoaWxlXG4gICAgLy8gcmVzb2x2aW5nIGZyb20gdGhlIGJ1bmRsZSByb290IHdvdWxkIGhhdmUgZm91bmQgaXQuXG4gICAgY29uc3QgYW5jaG9yZWQgPSB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIikgfHwgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKTtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gdGFyZ2V0LnN0YXJ0c1dpdGgoXCIvXCIpXG4gICAgICA/IFtub3JtYWxpemUoam9pbihpbmRleC5yb290LCB0YXJnZXQpKV1cbiAgICAgIDogYW5jaG9yZWRcbiAgICAgICAgPyBbbm9ybWFsaXplKHJlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCkpXVxuICAgICAgICA6IFtcbiAgICAgICAgICAgIG5vcm1hbGl6ZShyZXNvbHZlUGF0aChkaXJuYW1lKGZyb20pLCB0YXJnZXQpKSxcbiAgICAgICAgICAgIG5vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpLFxuICAgICAgICAgICAgLi4uKGluZGV4LnJlcG9Sb290ID8gW25vcm1hbGl6ZShqb2luKGluZGV4LnJlcG9Sb290LCB0YXJnZXQpKV0gOiBbXSksXG4gICAgICAgICAgXTtcbiAgICBjb25zdCB0cmllZCA9IGNhbmRpZGF0ZXMubWFwKChjKSA9PiAoZXh0bmFtZShjKSA9PT0gXCJcIiA/IGAke2N9Lm1kYCA6IGMpKTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdHJpZWQpIGlmIChpbmRleC5wYXRocy5pbmNsdWRlcyhjKSkgcmV0dXJuIHsgc3RhdGU6IFwiaW4tYnVuZGxlXCIsIHBhdGg6IGMgfTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdHJpZWQpIGlmIChpbmRleC5leGlzdHMoYykpIHJldHVybiB7IHN0YXRlOiBcIm91dHNpZGVcIiwgcGF0aDogYyB9O1xuICAgIHJldHVybiB7IHN0YXRlOiBcIm1pc3NpbmdcIiwgdHJpZWQ6IHRyaWVkWzBdIGFzIHN0cmluZyB9O1xuICB9XG4gIGNvbnN0IHNsYXNoID0gdGFyZ2V0LmluZGV4T2YoXCIvXCIpO1xuICBpZiAoc2xhc2ggPiAwKSB7XG4gICAgLy8gYHR5cGUvc2x1Z2A6IHRoZSB0eXBlIGlzIGEgY2xhaW0gdGhlIHRhcmdldCdzIG93biBmcm9udG1hdHRlciBtdXN0IG1ha2UuXG4gICAgY29uc3QgdHlwZSA9IHRhcmdldC5zbGljZSgwLCBzbGFzaCk7XG4gICAgY29uc3Qgc2x1ZyA9IHRhcmdldC5zbGljZShzbGFzaCArIDEpO1xuICAgIGZvciAoY29uc3QgcCBvZiBpbmRleC5wYXRocylcbiAgICAgIGlmIChzdGVtKHApID09PSBzbHVnICYmIGluZGV4Lm1ldGFPZihwKT8udHlwZSA9PT0gdHlwZSlcbiAgICAgICAgcmV0dXJuIHsgc3RhdGU6IFwiaW4tYnVuZGxlXCIsIHBhdGg6IHAgfTtcbiAgfVxuICBjb25zdCBoaXQgPSBpbmRleC5wYXRocy5maW5kKChwKSA9PiBzdGVtKHApID09PSBzdGVtKHRhcmdldCkpO1xuICBpZiAoaGl0KSByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogaGl0IH07XG4gIHJldHVybiB7IHN0YXRlOiBcIm1pc3NpbmdcIiwgdHJpZWQ6IHRhcmdldCB9O1xufVxuXG4vKiogQW4gZWRnZSBpbiBhIHNldCdzIG1hcC4gYHJlbGAgZW1wdHkgbWVhbnMgbm8gYXNzZXJ0aW9uIHdhcyBtYWRlLiAqL1xuZXhwb3J0IHR5cGUgRWRnZSA9IHtcbiAgZnJvbTogc3RyaW5nO1xuICAvKiogQWJzb2x1dGUgcGF0aCB3aGVuIHJlc29sdmVkOyB0aGUgd3JpdHRlbiB0YXJnZXQgd2hlbiBub3QuICovXG4gIHRvOiBzdHJpbmc7XG4gIC8qKiBBIGJvZHkgbGluaywgb3IgYSBmcm9udG1hdHRlciB2YWx1ZSDigJQga2VwdCBhcGFydCwgYXMgcGRvY3Mga2VlcHMgdGhlbS4gKi9cbiAgc291cmNlOiBcImxpbmtcIiB8IFwiZnJvbnRtYXR0ZXJcIjtcbiAgLyoqIFRoZSBmcm9udG1hdHRlciBrZXkgdGhhdCBjYXJyaWVkIGl0IChgcmVsYXRlZGAsIGBzb3VyY2VzLnJlc291cmNlYCwg4oCmKS4gKi9cbiAga2V5Pzogc3RyaW5nO1xuICAvKipcbiAgICogRm9yIGEgQk9EWSBsaW5rOiB0aGUgdGFyZ2V0IGFzIHdyaXR0ZW4sIGFuZCB0aGUgbGluZSBpdCBpcyBvbi4gQWJzZW50IGZvciBhXG4gICAqIGZyb250bWF0dGVyIHJlZmVyZW5jZSwgd2hlcmUgYGtleWAgaXMgdGhlIGFkZHJlc3MgaW5zdGVhZC5cbiAgICovXG4gIHJhdz86IHN0cmluZztcbiAgbGluZT86IG51bWJlcjtcbiAgcmVsOiBzdHJpbmdbXTtcbiAgc3RhdGU6IFJlc29sdXRpb25bXCJzdGF0ZVwiXTtcbn07XG5cbmV4cG9ydCB0eXBlIEdyYXBoTm9kZSA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICByZWw6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgdHlwZT86IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHN0YWxlOiBib29sZWFuO1xuICB0YWdzOiBzdHJpbmdbXTtcbiAgbGlua3NPdXQ6IG51bWJlcjtcbiAgbGlua3NJbjogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGggPSB7XG4gIHJvb3Q6IHN0cmluZztcbiAgbm9kZXM6IEdyYXBoTm9kZVtdO1xuICBlZGdlczogRWRnZVtdO1xuICAvKiogVGFyZ2V0cyBub3RoaW5nIGluIHRoZSBidW5kbGUgYW5zd2VycyDigJQgc2FpZCwgbmV2ZXIgYW4gZXJyb3IgKE9LRiDCpzExKS4gKi9cbiAgZGFuZ2xpbmc6IG51bWJlcjtcbn07XG5cbi8qKiBCdWlsZCBhIHNldCdzIG1hcDogbm9kZXMgYXJlIGl0cyBkb2N1bWVudHMsIGVkZ2VzIGFyZSB0aGUgZm91ciBzb3VyY2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR3JhcGgoaW5kZXg6IEJ1bmRsZUluZGV4LCBib2R5T2Y6IChwYXRoOiBzdHJpbmcpID0+IHN0cmluZywgY2FwID0gNDAwKTogR3JhcGgge1xuICBjb25zdCBwYXRocyA9IGluZGV4LnBhdGhzLnNsaWNlKDAsIGNhcCk7XG4gIGNvbnN0IGVkZ2VzOiBFZGdlW10gPSBbXTtcbiAgZm9yIChjb25zdCBmcm9tIG9mIHBhdGhzKSB7XG4gICAgY29uc3QgbWV0YSA9IGluZGV4Lm1ldGFPZihmcm9tKTtcbiAgICBmb3IgKGNvbnN0IGxpbmsgb2YgZXh0cmFjdExpbmtzKGJvZHlPZihmcm9tKSkpIHtcbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KGxpbmsudGFyZ2V0LCBmcm9tLCBpbmRleCk7XG4gICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgZnJvbSxcbiAgICAgICAgdG86IHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8gci50cmllZCA6IHIucGF0aCxcbiAgICAgICAgc291cmNlOiBcImxpbmtcIixcbiAgICAgICAgcmF3OiBsaW5rLnJhdyxcbiAgICAgICAgbGluZTogbGluay5saW5lLFxuICAgICAgICByZWw6IGxpbmsucmVsLFxuICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHJlZiBvZiBtZXRhID8gZmllbGRSZWZzKG1ldGEuZmllbGRzKSA6IFtdKSB7XG4gICAgICBjb25zdCByID0gcmVzb2x2ZVRhcmdldChyZWYudmFsdWUsIGZyb20sIGluZGV4KTtcbiAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICBmcm9tLFxuICAgICAgICB0bzogci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyByLnRyaWVkIDogci5wYXRoLFxuICAgICAgICBzb3VyY2U6IFwiZnJvbnRtYXR0ZXJcIixcbiAgICAgICAga2V5OiByZWYua2V5LFxuICAgICAgICByZWw6IFtdLFxuICAgICAgICBzdGF0ZTogci5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICBjb25zdCBvdXRPZiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGNvbnN0IGludG9PZiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgZSBvZiBlZGdlcykge1xuICAgIG91dE9mLnNldChlLmZyb20sIChvdXRPZi5nZXQoZS5mcm9tKSA/PyAwKSArIDEpO1xuICAgIGlmIChlLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSBpbnRvT2Yuc2V0KGUudG8sIChpbnRvT2YuZ2V0KGUudG8pID8/IDApICsgMSk7XG4gIH1cbiAgY29uc3Qgbm9kZXM6IEdyYXBoTm9kZVtdID0gcGF0aHMubWFwKChwYXRoKSA9PiB7XG4gICAgY29uc3QgbWV0YSA9IGluZGV4Lm1ldGFPZihwYXRoKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aCxcbiAgICAgIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShpbmRleC5yb290LCBwYXRoKSksXG4gICAgICB0aXRsZTogbWV0YT8udGl0bGUgPz8gc3RlbShwYXRoKSxcbiAgICAgIC4uLihtZXRhPy50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAgIHN0YXR1czogbWV0YT8uc3RhdHVzID8/IFwic3RhYmxlXCIsXG4gICAgICBzdGFsZTogbWV0YT8uc3RhbGUgPz8gZmFsc2UsXG4gICAgICB0YWdzOiBtZXRhPy50YWdzID8/IFtdLFxuICAgICAgbGlua3NPdXQ6IG91dE9mLmdldChwYXRoKSA/PyAwLFxuICAgICAgbGlua3NJbjogaW50b09mLmdldChwYXRoKSA/PyAwLFxuICAgIH07XG4gIH0pO1xuICByZXR1cm4ge1xuICAgIHJvb3Q6IGluZGV4LnJvb3QsXG4gICAgbm9kZXMsXG4gICAgZWRnZXMsXG4gICAgZGFuZ2xpbmc6IGVkZ2VzLmZpbHRlcigoZSkgPT4gZS5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIpLmxlbmd0aCxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIiwKICAgICIvLyBGaW5kaW5nIHRoaW5ncyBhY3Jvc3MgZXZlcnl0aGluZyBpbiB0aGUgY29udGV4dCAoRTU5KS5cbi8vXG4vLyDim5QgVFdPIE1BVENIRVJTLCBPTiBQVVJQT1NFLCBiZWNhdXNlIHRoZXkgYW5zd2VyIGRpZmZlcmVudCBxdWVzdGlvbnMuIE5vdGVcbi8vIGFwcHMgc3BsaXQgdGhlc2UgYW5kIGl0IGlzIG5vdCBhbiBhY2NpZGVudDogRlVaWlkgb24gbmFtZXMgaXMgZm9yIGp1bXBpbmdcbi8vIChcIm1hYmFrXCIg4oaSIE1hcmVuJ3MgQmFrZXJ5KSwgYW5kIEVYQUNUIG9uIGNvbnRlbnQgaXMgZm9yIGZpbmRpbmcgKFwid2hlcmUgZGlkIElcbi8vIHNheSAnYXNraW5nLW5pY2VseSdcIikuIEZ1enp5IGZ1bGwtdGV4dCB3b3VsZCBiZSB0aGUgd29yc3Qgb2YgYm90aCDigJQgc2VhcmNoaW5nXG4vLyBgYnJpZGdlYCB3b3VsZCBzdXJmYWNlIGRvY3VtZW50cyB0aGF0IG1lcmVseSBjb250YWluIHNpbWlsYXItbG9va2luZyBsZXR0ZXJzLFxuLy8gYW5kIHlvdSBjb3VsZCBubyBsb25nZXIgdHJ1c3QgXCJ0aGlzIHBocmFzZSBpcyBvbiBsaW5lIDI5XCIsIHdoaWNoIGlzIHRoZSBvbmx5XG4vLyB0aGluZyBhIGNvbnRlbnQgc2VhcmNoIGlzIGZvci4gKENvbGUgcmFpc2VkIEZ1c2UgZm9yIHRoZSBuYW1lIGhhbGYgYW5kIGNob3NlXG4vLyB0aGUgaGFuZC1yb2xsZWQgc2NvcmVyOiB0aGVyZSBpcyBubyBzZWNvbmQgZW5naW5lIHRoaXMgaGFzIHRvIGFncmVlIHdpdGgsIHNvXG4vLyBmdXp6eSByYW5raW5nIGlzIGEgc2VsZi1jb250YWluZWQgdGFzdGUganVkZ21lbnQgd2l0aCBubyBkcmlmdCByaXNrLilcbi8vXG4vLyDimqAgQU5EIElUIFNFQVJDSEVTIFdIQVQgVEhFIEhVTUFOIElTIExPT0tJTkcgQVQsIHdoaWNoIGlzIG5vdCBhbHdheXMgdGhlIGZpbGUuXG4vLyBBIGRvY3VtZW50IG9wZW4gaW4gdGhlIHNlc3Npb24gaXMgc2hvd24gYXMgaXRzIEFDVElWRSBWRVJTSU9OLCB3aGljaCBsaXZlc1xuLy8gdW5kZXIgdGhlIHNlc3Npb24gaG9tZSByYXRoZXIgdGhhbiBhdCB0aGUgb3JpZ2luYWwgcGF0aCDigJQgc28gYW4gZWRpdCBtYWRlIHR3b1xuLy8gbWludXRlcyBhZ28gbXVzdCBzdGlsbCBiZSBmaW5kYWJsZS4gVGhhdCBhc3ltbWV0cnkgaXMgYWxzbyB0aGUgcmVhc29uIHRoaXNcbi8vIGV4aXN0cyBmb3IgdGhlIEFHRU5UIGF0IGFsbDogZ3JlcCBvdmVyIHRoZSB3b3Jrc3BhY2UgZmluZHMgdGhlIFNBVkVEIGZpbGUgYW5kXG4vLyBzaWxlbnRseSBtaXNzZXMgdGhlIHZlcnNpb24gYmVpbmcgcmVhZC4gVGhlIGNhbGxlciBzdXBwbGllcyB0aGUgdGV4dCBwZXJcbi8vIGRvY3VtZW50IGZvciBleGFjdGx5IHRoaXMgcmVhc29uIChzZWUgYFNlc3Npb24uc2VhcmNoQWxsYCkuXG5cbi8qKiBPbmUgbGluZSB0aGF0IG1hdGNoZWQsIHdpdGggdGhlIG9mZnNldHMgb2YgdGhlIGhpdCBpbnNpZGUgdGhlIGRvY3VtZW50LiAqL1xuZXhwb3J0IHR5cGUgSGl0ID0ge1xuICAvKiogMS1iYXNlZCwgc28gaXQgY2FuIGJlIHNob3duIGFuZCBvcGVuZWQuICovXG4gIGxpbmU6IG51bWJlcjtcbiAgLyoqIFRoZSBsaW5lLCBmb3IgY29udGV4dCBpbiB0aGUgcmVzdWx0IGxpc3QuICovXG4gIHRleHQ6IHN0cmluZztcbiAgLyoqIE9mZnNldHMgb2YgdGhlIG1hdGNoIHdpdGhpbiB0aGUgZG9jdW1lbnQsIGZvciByZXZlYWwtYW5kLXNlbGVjdC4gKi9cbiAgZnJvbTogbnVtYmVyO1xuICB0bzogbnVtYmVyO1xufTtcblxuLyoqXG4gKiBIb3cgbXVjaCBvZiBhIGxpbmUgaXMgd29ydGggY2FycnlpbmcgYmFjay4gQSByZXN1bHQgbGlzdCBpcyBhIGxpc3QsIGFuZCBhXG4gKiBkb2N1bWVudCB3aXRoIGEgNCwwMDAtY2hhcmFjdGVyIHBhcmFncmFwaCBzaG91bGQgbm90IHNlbmQgYWxsIG9mIGl0IHBlciBoaXQuXG4gKi9cbmNvbnN0IExJTkVfQ0FQID0gMjQwO1xuXG4vKiogRXZlcnkgbWF0Y2ggb2YgYHF1ZXJ5YCBpbiBgdGV4dGAsIGF0IG1vc3QgYGxpbWl0YCBvZiB0aGVtLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlYXJjaFRleHQodGV4dDogc3RyaW5nLCBxdWVyeTogc3RyaW5nLCBsaW1pdCA9IDUwKTogSGl0W10ge1xuICBjb25zdCBuZWVkbGUgPSBxdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5lZWRsZSA9PT0gXCJcIiB8fCBsaW1pdCA8PSAwKSByZXR1cm4gW107XG4gIGNvbnN0IGhheSA9IHRleHQudG9Mb3dlckNhc2UoKTtcbiAgbGV0IGF0ID0gaGF5LmluZGV4T2YobmVlZGxlKTtcbiAgaWYgKGF0ID09PSAtMSkgcmV0dXJuIFtdO1xuICAvLyBMaW5lIHN0YXJ0cywgd2Fsa2VkIE9OQ0UuIEEgcGVyLWhpdCBgbGFzdEluZGV4T2YoXCJcXG5cIilgIGlzIHF1YWRyYXRpYyBvdmVyIGFcbiAgLy8gZG9jdW1lbnQgdGhhdCBtYXRjaGVzIG9uIGV2ZXJ5IGxpbmUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGRvY3VtZW50IHNvbWVvbmVcbiAgLy8gc2VhcmNoZXMgZm9yIGEgY29tbW9uIHdvcmQuXG4gIGNvbnN0IHN0YXJ0czogbnVtYmVyW10gPSBbMF07XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdGV4dC5sZW5ndGg7IGkrKykgaWYgKHRleHQuY2hhckNvZGVBdChpKSA9PT0gMTApIHN0YXJ0cy5wdXNoKGkgKyAxKTtcbiAgY29uc3QgaGl0czogSGl0W10gPSBbXTtcbiAgbGV0IGN1cnNvciA9IDA7XG4gIHdoaWxlIChhdCAhPT0gLTEgJiYgaGl0cy5sZW5ndGggPCBsaW1pdCkge1xuICAgIHdoaWxlIChjdXJzb3IgKyAxIDwgc3RhcnRzLmxlbmd0aCAmJiAoc3RhcnRzW2N1cnNvciArIDFdIGFzIG51bWJlcikgPD0gYXQpIGN1cnNvcisrO1xuICAgIGNvbnN0IGxpbmVTdGFydCA9IHN0YXJ0c1tjdXJzb3JdIGFzIG51bWJlcjtcbiAgICBjb25zdCBsaW5lRW5kID0gY3Vyc29yICsgMSA8IHN0YXJ0cy5sZW5ndGggPyAoc3RhcnRzW2N1cnNvciArIDFdIGFzIG51bWJlcikgLSAxIDogdGV4dC5sZW5ndGg7XG4gICAgY29uc3Qgd2hvbGUgPSB0ZXh0LnNsaWNlKGxpbmVTdGFydCwgbGluZUVuZCk7XG4gICAgaGl0cy5wdXNoKHtcbiAgICAgIGxpbmU6IGN1cnNvciArIDEsXG4gICAgICB0ZXh0OiB3aG9sZS5sZW5ndGggPiBMSU5FX0NBUCA/IGAke3dob2xlLnNsaWNlKDAsIExJTkVfQ0FQIC0gMSl94oCmYCA6IHdob2xlLFxuICAgICAgZnJvbTogYXQsXG4gICAgICB0bzogYXQgKyBuZWVkbGUubGVuZ3RoLFxuICAgIH0pO1xuICAgIC8vIOKaoCBBRFZBTkNFIFBBU1QgVEhFIE1BVENILCBOT1QgVEhFIExJTkU6IHR3byBoaXRzIG9uIG9uZSBsaW5lIGFyZSB0d29cbiAgICAvLyBoaXRzLCBhbmQgc3RlcHBpbmcgYnkgbGluZSB3b3VsZCBzaWxlbnRseSBkcm9wIHRoZSBzZWNvbmQuXG4gICAgYXQgPSBoYXkuaW5kZXhPZihuZWVkbGUsIGF0ICsgbmVlZGxlLmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGhpdHM7XG59XG5cbi8qKiBJcyB0aGlzIGNoYXJhY3RlciBhIHdvcmQgYm91bmRhcnkgZm9yIHNjb3JpbmcgcHVycG9zZXM/ICovXG5mdW5jdGlvbiBpc0JvdW5kYXJ5KGNoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGNoID09PSBcIiBcIiB8fCBjaCA9PT0gXCItXCIgfHwgY2ggPT09IFwiX1wiIHx8IGNoID09PSBcIi9cIiB8fCBjaCA9PT0gXCIuXCIgfHwgY2ggPT09IFwiJ1wiO1xufVxuXG4vKipcbiAqIEhvdyB3ZWxsIGBuYW1lYCBtYXRjaGVzIGBxdWVyeWAgYXMgYSBmdXp6eSBzdWJzZXF1ZW5jZSDigJQgaGlnaGVyIGlzIGJldHRlcixcbiAqIGBudWxsYCB3aGVuIHRoZSBxdWVyeSdzIGNoYXJhY3RlcnMgZG8gbm90IGFwcGVhciBpbiBvcmRlciBhdCBhbGwuXG4gKlxuICogVGhlIHdlaWdodHMgZW5jb2RlIHdoYXQgc29tZW9uZSB0eXBpbmcgaW50byBhIGp1bXAgYm94IG1lYW5zOlxuICpcbiAqIC0gKipjb250aWd1aXR5KiogZG9taW5hdGVzLCBiZWNhdXNlIGBtYXJlYCBtZWFuaW5nIGBNYXJlbmAgaXMgdGhlIGNvbW1vbiBjYXNlXG4gKiAgIGFuZCBgbeKApmHigKZy4oCmZWAgc2NhdHRlcmVkIHRocm91Z2ggYSBzZW50ZW5jZSBpcyB0aGUgcmFyZSBvbmU7XG4gKiAtICoqd29yZCBzdGFydHMqKiBzY29yZSwgc28gYG1iYCBmaW5kcyBgTWFyZW4ncyBCYWtlcnlgIHJhdGhlciB0aGFuIGBOdW1iZXJgO1xuICogLSAqKmVhcmxpZXIgaXMgYmV0dGVyKiosIGFuZCBhICoqc2hvcnRlciBuYW1lKiogd2lucyBhIHRpZSwgYmVjYXVzZSB0aGUgdGhpbmdcbiAqICAgeW91IG1lYW50IGlzIHVzdWFsbHkgdGhlIHRoaW5nIHdpdGggbGVzcyBhcm91bmQgaXQuXG4gKlxuICog4pqgIFRIRSBOVU1CRVJTIEFSRSBUQVNURSwgTk9UIFRSVVRILiBUaGV5IGFyZSBwaW5uZWQgYnkgY2VsbHMgdGhhdCBhc3NlcnRcbiAqIE9SREVSSU5HUyAoXCJ0aGlzIGJlYXRzIHRoYXRcIikgcmF0aGVyIHRoYW4gdmFsdWVzLCBzbyB0aGV5IGNhbiBiZSByZXR1bmVkXG4gKiB3aXRob3V0IHJld3JpdGluZyB0aGUgdGVzdHMg4oCUIHdoaWNoIGlzIHRoZSBvbmx5IHdheSBhIHNjb3JlciBsaWtlIHRoaXMgc3RheXNcbiAqIGNoYW5nZWFibGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY29yZU5hbWUobmFtZTogc3RyaW5nLCBxdWVyeTogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IHEgPSBxdWVyeS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKHEgPT09IFwiXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBoYXkgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIGxldCBzY29yZSA9IDA7XG4gIGxldCBhdCA9IDA7XG4gIGxldCBydW4gPSAwO1xuICBmb3IgKGNvbnN0IGNoIG9mIHEpIHtcbiAgICBjb25zdCBmb3VuZCA9IGhheS5pbmRleE9mKGNoLCBhdCk7XG4gICAgaWYgKGZvdW5kID09PSAtMSkgcmV0dXJuIG51bGw7XG4gICAgcnVuID0gZm91bmQgPT09IGF0ICYmIGF0ID4gMCA/IHJ1biArIDEgOiAwO1xuICAgIHNjb3JlICs9IDEwICsgcnVuICogMTI7XG4gICAgaWYgKGZvdW5kID09PSAwIHx8IGlzQm91bmRhcnkoaGF5W2ZvdW5kIC0gMV0gYXMgc3RyaW5nKSkgc2NvcmUgKz0gMTQ7XG4gICAgLy8gRGlzdGFuY2UgZnJvbSB3aGVyZSB3ZSB3ZXJlIGxvb2tpbmcgY29zdHMsIHNvIHNjYXR0ZXJlZCBtYXRjaGVzIHJhbmsgbG93LlxuICAgIHNjb3JlIC09IE1hdGgubWluKGZvdW5kIC0gYXQsIDEyKTtcbiAgICBhdCA9IGZvdW5kICsgMTtcbiAgfVxuICAvLyBBIHdob2xlLXdvcmQgc3Vic3RyaW5nIGlzIHRoZSBzdHJvbmdlc3Qgc2lnbmFsIHRoZXJlIGlzOyBzYXkgc28gbG91ZGx5LlxuICBpZiAoaGF5LmluY2x1ZGVzKHEpKSBzY29yZSArPSA0MDtcbiAgaWYgKGhheS5zdGFydHNXaXRoKHEpKSBzY29yZSArPSAyNTtcbiAgLy8gU2hvcnRlciBuYW1lcyB3aW4gdGllcy5cbiAgc2NvcmUgLT0gTWF0aC5taW4obmFtZS5sZW5ndGgsIDQwKSAvIDQ7XG4gIHJldHVybiBzY29yZTtcbn1cblxuLyoqIEEgZG9jdW1lbnQgdGhlIE5BTUUgbWF0Y2hlZC4gKi9cbmV4cG9ydCB0eXBlIE5hbWVNYXRjaCA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzbHVnPzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBzY29yZTogbnVtYmVyO1xufTtcblxuLyoqXG4gKiDim5QgVEhFIFNXQVAgU0VBTSAoQ29sZSk6IFwiaWYgd2UgZmluZCB0aGF0IGFjdHVhbGx5IHdlIHNob3VsZCB1c2UgRnVzZSwgaXQnc1xuICogZmFpcmx5IGVhc3kgdG8gcmVwbGFjZS5cIlxuICpcbiAqIFRoZSBpbnRlcmZhY2UgaXMgQ09SUFVTLVNIQVBFRCDigJQgdGFrZSB0aGUgd2hvbGUgY2FuZGlkYXRlIGxpc3QgYW5kIGEgcXVlcnksXG4gKiByZXR1cm4gYSByYW5rZWQgc2xpY2Ug4oCUIGFuZCB0aGF0IHNoYXBlIGlzIHRoZSB3aG9sZSBwb2ludC4gQSBwZXItaXRlbVxuICogYHNjb3JlKG5hbWUsIHF1ZXJ5KWAgaG9vayB3b3VsZCBoYXZlIGxvb2tlZCBsaWtlIHRoZSBzbWFsbGVyIGFic3RyYWN0aW9uIGFuZFxuICogd291bGQgaGF2ZSBGT1VHSFQgdGhlIHZlcnkgbGlicmFyeSBpdCBleGlzdHMgdG8gYWRtaXQ6IEZ1c2UgaW5kZXhlcyBhIGxpc3RcbiAqIGFuZCBzZWFyY2hlcyBpdCwgaXQgZG9lcyBub3Qgc2NvcmUgb25lIHN0cmluZyBhdCBhIHRpbWUuIFdyaXR0ZW4gdGhpcyB3YXksXG4gKiBtb3ZpbmcgdG8gRnVzZSBpcyBhIG5ldyBmdW5jdGlvbiBhbmQgb25lIGRlZmF1bHQgY2hhbmdlZDpcbiAqXG4gKiAgICAgY29uc3QgZnVzZU5hbWVzOiBOYW1lU2VhcmNoID0gKGNhbmRpZGF0ZXMsIHF1ZXJ5LCBsaW1pdCkgPT4ge1xuICogICAgICAgY29uc3QgZnVzZSA9IG5ldyBGdXNlKGNhbmRpZGF0ZXMsIHsga2V5czogW1wibmFtZVwiLCBcInRpdGxlXCJdLCDigKYgfSk7XG4gKiAgICAgICByZXR1cm4gZnVzZS5zZWFyY2gocXVlcnksIHsgbGltaXQgfSkubWFwKOKApik7XG4gKiAgICAgfTtcbiAqXG4gKiBOb3RoaW5nIGVsc2UgaW4gdGhpcyBtb2R1bGUsIHRoZSBzZXNzaW9uLCB0aGUgd2lyZSBvciB0aGUgc3VyZmFjZSBtb3Zlcy5cbiAqL1xuZXhwb3J0IHR5cGUgTmFtZVNlYXJjaCA9IChcbiAgY2FuZGlkYXRlczogcmVhZG9ubHkgQ2FuZGlkYXRlW10sXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIGxpbWl0OiBudW1iZXIsXG4pID0+IE5hbWVNYXRjaFtdO1xuXG4vKiogQSBkb2N1bWVudCB0aGUgQ09OVEVOVCBtYXRjaGVkLiAqL1xuZXhwb3J0IHR5cGUgVGV4dE1hdGNoID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdmVyc2lvbj86IG51bWJlcjtcbiAgaGl0czogSGl0W107XG59O1xuXG5leHBvcnQgdHlwZSBTZWFyY2hSZXBvcnQgPSB7XG4gIHF1ZXJ5OiBzdHJpbmc7XG4gIC8qKiBOYW1lL3RpdGxlIG1hdGNoZXMsIGJlc3QgZmlyc3Qg4oCUIHRoZSBqdW1wIGxpc3QuICovXG4gIGRvY3VtZW50czogTmFtZU1hdGNoW107XG4gIC8qKiBDb250ZW50IG1hdGNoZXMsIGluIGNvbnRleHQgb3JkZXIg4oCUIHRoZSBmaW5kIGxpc3QuICovXG4gIHRleHQ6IFRleHRNYXRjaFtdO1xuICAvKiogVG90YWwgY29udGVudCBoaXRzIHJlcG9ydGVkLiAqL1xuICBjb3VudDogbnVtYmVyO1xuICAvKiogVHJ1ZSB3aGVuIGEgY2FwIHN0b3BwZWQgdGhlIHNlYXJjaCBlYXJseSwgc28gXCIzXCIgYW5kIFwiMyBvZiBtb3JlXCIgZGlmZmVyLiAqL1xuICB0cnVuY2F0ZWQ6IGJvb2xlYW47XG59O1xuXG4vKiogUGVyLWRvY3VtZW50IGNvbnRlbnQgY2FwLCBzbyBvbmUgZW5vcm1vdXMgZG9jdW1lbnQgY2Fubm90IGZpbGwgdGhlIHJlcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBQRVJfRE9DID0gMjA7XG4vKiogV2hvbGUtcmVwb3J0IGNvbnRlbnQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFRPVEFMID0gMjAwO1xuLyoqIEhvdyBtYW55IG5hbWUgbWF0Y2hlcyBhcmUgd29ydGggc2hvd2luZy4gKi9cbmV4cG9ydCBjb25zdCBOQU1FUyA9IDEwO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0IGBOYW1lU2VhcmNoYDogYHNjb3JlTmFtZWAgb3ZlciBldmVyeSBjYW5kaWRhdGUsIHJhbmtlZC5cbiAqXG4gKiBBIGRvY3VtZW50J3MgVElUTEUgaXMgbWF0Y2hlZCBhcyB3ZWxsIGFzIGl0cyBmaWxlbmFtZSDigJQgYW4gT0tGIGRvY3VtZW50J3NcbiAqIG5hbWUgYW5kIHRpdGxlIG9mdGVuIGRpZmZlciBhbmQgdGhlIGh1bWFuIG1heSByZW1lbWJlciBlaXRoZXIg4oCUIGFuZCB0aGVcbiAqIGJldHRlciBvZiB0aGUgdHdvIHNjb3JlcyBpcyB0aGUgb25lIHRoYXQgY291bnRzLlxuICovXG5leHBvcnQgY29uc3QgcmFua05hbWVzOiBOYW1lU2VhcmNoID0gKGNhbmRpZGF0ZXMsIHF1ZXJ5LCBsaW1pdCkgPT4ge1xuICBjb25zdCBvdXQ6IE5hbWVNYXRjaFtdID0gW107XG4gIGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgYnlOYW1lID0gc2NvcmVOYW1lKGMubmFtZSwgcXVlcnkpO1xuICAgIGNvbnN0IGJ5VGl0bGUgPSBjLnRpdGxlID09PSB1bmRlZmluZWQgPyBudWxsIDogc2NvcmVOYW1lKGMudGl0bGUsIHF1ZXJ5KTtcbiAgICBpZiAoYnlOYW1lID09PSBudWxsICYmIGJ5VGl0bGUgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIHBhdGg6IGMucGF0aCxcbiAgICAgIC4uLihjLnNsdWcgIT09IHVuZGVmaW5lZCA/IHsgc2x1ZzogYy5zbHVnIH0gOiB7fSksXG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICAuLi4oYy50aXRsZSAhPT0gdW5kZWZpbmVkID8geyB0aXRsZTogYy50aXRsZSB9IDoge30pLFxuICAgICAgc2NvcmU6IE1hdGgubWF4KGJ5TmFtZSA/PyAtSW5maW5pdHksIGJ5VGl0bGUgPz8gLUluZmluaXR5KSxcbiAgICB9KTtcbiAgfVxuICBvdXQuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUgfHwgYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSk7XG4gIHJldHVybiBvdXQuc2xpY2UoMCwgbGltaXQpO1xufTtcblxuZXhwb3J0IHR5cGUgQ2FuZGlkYXRlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgYmFzZW5hbWUsIHdoaWNoIGlzIHdoYXQgYSBodW1hbiB0eXBlcyBhdC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICBzbHVnPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgdmVyc2lvbj86IG51bWJlcjtcbn07XG5cbi8qKlxuICogU2VhcmNoIGEgbGlzdCBvZiBjYW5kaWRhdGVzIGZvciBib3RoIGtpbmRzIG9mIG1hdGNoLlxuICpcbiAqIGByZWFkYCBtYXkgdGhyb3cgb3IgcmV0dXJuIG51bGwgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgYmVlbiBkZWxldGVkIHVuZGVyXG4gKiB0aGUgY29udGV4dCDigJQgYSBzZWFyY2ggaXMgbm90IHRoZSBtb21lbnQgdG8gZmFpbCBvdmVyIHRoYXQsIHNvIGl0IGlzIHNraXBwZWRcbiAqIHJhdGhlciB0aGFuIHJlcG9ydGVkIGFzIGEgZG9jdW1lbnQgd2l0aCBubyBoaXRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VhcmNoRG9jdW1lbnRzKFxuICBjYW5kaWRhdGVzOiByZWFkb25seSBDYW5kaWRhdGVbXSxcbiAgcXVlcnk6IHN0cmluZyxcbiAgcmVhZDogKGM6IENhbmRpZGF0ZSkgPT4gc3RyaW5nIHwgbnVsbCxcbiAgY2FwczogeyBwZXJEb2M/OiBudW1iZXI7IHRvdGFsPzogbnVtYmVyOyBuYW1lcz86IG51bWJlcjsgbmFtZVNlYXJjaD86IE5hbWVTZWFyY2ggfSA9IHt9LFxuKTogU2VhcmNoUmVwb3J0IHtcbiAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKTtcbiAgaWYgKHEgPT09IFwiXCIpIHJldHVybiB7IHF1ZXJ5OiBcIlwiLCBkb2N1bWVudHM6IFtdLCB0ZXh0OiBbXSwgY291bnQ6IDAsIHRydW5jYXRlZDogZmFsc2UgfTtcbiAgY29uc3QgcGVyRG9jID0gY2Fwcy5wZXJEb2MgPz8gUEVSX0RPQztcbiAgY29uc3QgdG90YWwgPSBjYXBzLnRvdGFsID8/IFRPVEFMO1xuICBjb25zdCBuYW1lcyA9IGNhcHMubmFtZXMgPz8gTkFNRVM7XG5cbiAgY29uc3Qgc2NvcmVkID0gKGNhcHMubmFtZVNlYXJjaCA/PyByYW5rTmFtZXMpKGNhbmRpZGF0ZXMsIHEsIG5hbWVzKTtcblxuICBjb25zdCB0ZXh0OiBUZXh0TWF0Y2hbXSA9IFtdO1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKGNvdW50ID49IHRvdGFsKSB7XG4gICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGxldCBib2R5OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgYm9keSA9IHJlYWQoYyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBib2R5ID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKGJvZHkgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJvb20gPSBNYXRoLm1pbihwZXJEb2MsIHRvdGFsIC0gY291bnQpO1xuICAgIGNvbnN0IGhpdHMgPSBzZWFyY2hUZXh0KGJvZHksIHEsIHJvb20gKyAxKTtcbiAgICBpZiAoaGl0cy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIGlmIChoaXRzLmxlbmd0aCA+IHJvb20pIHRydW5jYXRlZCA9IHRydWU7XG4gICAgY29uc3Qga2VwdCA9IGhpdHMuc2xpY2UoMCwgcm9vbSk7XG4gICAgY291bnQgKz0ga2VwdC5sZW5ndGg7XG4gICAgdGV4dC5wdXNoKHtcbiAgICAgIHBhdGg6IGMucGF0aCxcbiAgICAgIC4uLihjLnNsdWcgIT09IHVuZGVmaW5lZCA/IHsgc2x1ZzogYy5zbHVnIH0gOiB7fSksXG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICAuLi4oYy52ZXJzaW9uICE9PSB1bmRlZmluZWQgPyB7IHZlcnNpb246IGMudmVyc2lvbiB9IDoge30pLFxuICAgICAgaGl0czoga2VwdCxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7IHF1ZXJ5OiBxLCBkb2N1bWVudHM6IHNjb3JlZCwgdGV4dCwgY291bnQsIHRydW5jYXRlZCB9O1xufVxuIiwKICAgICIvLyBJcyB0aGUgaHVtYW4gd2FpdGluZyBvbiBhbiBhbnN3ZXIsIGFuZCBmb3IgaG93IGxvbmcgKEU1Myk/XG4vL1xuLy8g4puUIERFUklWRUQsIE5PVCBERUNMQVJFRCDigJQgQ29sZSdzIHJ1bGluZywgYW5kIHRoZSByZWFzb24gaXMgbG9hZC1iZWFyaW5nOiBcIndlXG4vLyBjb3VsZCBhZGQgc29tZSBhZmZvcmRhbmNlIHRoYXQgc2VuZHMgYSBjaGVjay1pbiB3aXRoIGFuIGFnZW504oCmIHdoZXJlIHdlJ3JlXG4vLyBub3QgYWRkaW5nIG1vcmUgdGFza3MgZm9yIHRoZSBhZ2VudCB0byBoYXZlIHRvIGV4cGxpY2l0bHkgZG8uXCIgQW4gYWdlbnQgdGhhdFxuLy8gbXVzdCByZW1lbWJlciB0byBzYXkgXCJ0aGlua2luZ1wiIHdpbGwgZm9yZ2V0IGV4YWN0bHkgd2hlbiBpdCBtYXR0ZXJzIOKAlCBpdCBpc1xuLy8gYnVzeSwgd2hpY2ggaXMgdGhlIHdob2xlIHNpdHVhdGlvbiBiZWluZyBzaWduYWxsZWQuIFNvIG5vdGhpbmcgaGVyZSBhc2tzIHRoZVxuLy8gYWdlbnQgZm9yIGFueXRoaW5nLiBUaGUgc3RhdGUgaXMgcmVhZCBvZmYgdGhlIGNvbnZlcnNhdGlvbjogYSBodW1hbiBtZXNzYWdlXG4vLyB3aXRoIG5vIGFnZW50IG1lc3NhZ2UgYWZ0ZXIgaXQgaXMgYSBodW1hbiB3YWl0aW5nLlxuLy9cbi8vIOKblCBBTkQgVEhFIEFHRU5UJ1MgUkVQTFkgSVMgVEhFIENPTVBMRVRJT04gU0lHTkFMLCB3aGljaCBpcyBtaW5kLW1hcHBlcidzXG4vLyBydWxlIChSMTEgU0VBTSAyKSBhbmQgaXMgc3RvbGVuIGRlbGliZXJhdGVseS4gVGhlcmUgaXMgbm8gYGRvbmVgIHN0YXRlIHRvXG4vLyBlbWl0LCBzbyB0aGVyZSBpcyBubyBgZG9uZWAgc3RhdGUgdG8gZ2V0IG91dCBvZiBzeW5jLiBPbmUgY29uc2VxdWVuY2Ugd29ydGhcbi8vIG5hbWluZyBiZWNhdXNlIGl0IGZlbGwgb3V0IGZvciBmcmVlOiBgc3RhcnRUYXNrYCBwb3N0cyBpdHMgYW5ub3VuY2VtZW50IEFTXG4vLyBUSEUgQUdFTlQgKEU1MCksIHNvIHRoZSBoYXBweSBwYXRoIENvbGUgZGVzY3JpYmVkIOKAlCBcImdyZWF0LCBJJ20gZ29pbmcgdG8gZ2V0XG4vLyB0aGF0IHN0YXJ0ZWRcIiwgdGhlbiBhIHRhc2ssIHRoZW4gYSBzdWJhZ2VudCDigJQgY2xlYXJzIHRoaXMgYnkgY29uc3RydWN0aW9uLlxuLy9cbi8vIOKaoCBBIFNZU1RFTSBMSU5FIElTIE5PVCBBIFJFUExZLiBgYW5ub3VuY2UoKWAgbmFycmF0ZXMgYWdlbnQgQUNUUyAoXCJBZ2VudFxuLy8gbm90ZWQg4oCmIG9uIG1hcmVuXCIpLCB3aGljaCBpcyBldmlkZW5jZSBvZiBsaWZlIGJ1dCBub3QgYSBjaGVjay1pbiB3aXRoIHRoZVxuLy8gcGVyc29uIHdhaXRpbmcuIENvdW50aW5nIGl0IHdvdWxkIHNpbGVuY2UgdGhlIHNpZ25hbCBwcmVjaXNlbHkgaW4gdGhlIGNhc2Vcbi8vIHRoaXMgZXhpc3RzIGZvcjogYW4gYWdlbnQgdGhhdCBpcyBidXN5IGRvaW5nIHRoaW5ncyBhbmQgaGFzIG5vdCBzYWlkIGEgd29yZFxuLy8gdG8gdGhlIGh1bWFuLiBPbmx5IGB3aG8gPT09IFwiYWdlbnRcImAgY2xlYXJzLlxuaW1wb3J0IHR5cGUgeyBDaGF0V2hvLCBOb3RlLCBOb3RlV2FpdGluZywgV2FpdGluZyB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogSG93IGxvbmcgYSBodW1hbiB3YWl0cyBiZWZvcmUgdGhlIHdhaXQgaXMgd29ydGggcmVwb3J0aW5nLiAzMCBzLCBDb2xlJ3NcbiAqIG51bWJlciDigJQgbG9uZyBlbm91Z2ggdGhhdCBhbiBvcmRpbmFyeSBhbnN3ZXIgbmV2ZXIgdHJpcHMgaXQsIHNob3J0IGVub3VnaFxuICogdGhhdCBpdCBpcyBzdGlsbCB0aGUgc2FtZSBtb21lbnQgZm9yIHRoZSBwZXJzb24gc2l0dGluZyB0aGVyZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNUQUxMX01TID0gMzBfMDAwO1xuXG4vKiogV2hhdCBhIHNub296ZSBidXlzLCB3aGVuIHRoZSBhZ2VudCBkb2VzIG5vdCBuYW1lIGEgZHVyYXRpb24uICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TTk9PWkVfTVMgPSAxMjBfMDAwO1xuXG4vLyBgV2FpdGluZ2AgaXRzZWxmIGxpdmVzIGluIGBwcm90b2NvbC50c2Ag4oCUIGl0IHJpZGVzIGluIGBQdWJsaWNTdGF0ZWAsIGFuZCB0aGF0XG4vLyBmaWxlIGlzIGltcG9ydC1mcmVlIG9uIHB1cnBvc2UuIEl0cyBgYmFkZ2VgIGNhcnJpZXMgdGhlIHJ1bGUgdGhhdCBtYXR0ZXJzOlxuLy8g4puUIFNUQUxMRUQgTVVTVCBOT1QgUFVMU0UuIEEgcHVsc2Ugb3ZlciBhIHdlZGdlZCBhZ2VudCBpcyBmYWxzZSBsaXZlbmVzcyDigJQgdGhlXG4vLyBhbmltYXRpb24gY2xhaW1zIFwic29tZXRoaW5nIGlzIGhhcHBlbmluZ1wiIHdoZW4gdGhlIGhvbmVzdCBhbnN3ZXIgaXMgXCJJIGNhbm5vdFxuLy8gdGVsbCBhbnkgbW9yZVwiLiBtaW5kLW1hcHBlciBzZXBhcmF0ZXMgdGhlc2UgdHdvIGZvciB0aGUgc2FtZSByZWFzb24uXG5cbnR5cGUgTXNnID0ge1xuICBpZDogc3RyaW5nO1xuICB3aG86IENoYXRXaG87XG4gIHRzOiBudW1iZXI7XG4gIC8qKiBFNjU6IHRoZSBub3RlIGEgbWVzc2FnZSBpcyBBQk9VVCDigJQgc2V0IGJ5IFwiQXNrIHRoZSBhZ2VudFwiLiAqL1xuICBub3RlPzogeyBkb2M6IHN0cmluZzsgaWQ6IHN0cmluZyB9O1xufTtcblxuLyoqXG4gKiBUaGUgaHVtYW4gbWVzc2FnZSBub3RoaW5nIGhhcyBhbnN3ZXJlZCB5ZXQsIG9yIG51bGwuXG4gKlxuICogYGFja25vd2xlZGdlZFVudGlsYCBpcyBhIHNub296ZSAodGhlIGFnZW50IHNhaWQgaXQgaXMgc3RpbGwgd29ya2luZykuIFdoaWxlXG4gKiBpdCBob2xkcywgdGhlIGJhZGdlIHN0YXlzIGEgcHVsc2UgcGFzdCB0aGUgc3RhbGwgdGhyZXNob2xkIOKAlCB0aGUgYWdlbnRcbiAqIHZvbHVudGVlcmVkIGV2aWRlbmNlIG9mIGxpZmUsIHNvIHNob3dpbmcgXCJtYXkgYmUgc3R1Y2tcIiB3b3VsZCBiZSB0aGUgbGllLlxuICogV2hlbiBpdCBFWFBJUkVTIHRoZSBiYWRnZSBnb2VzIHN0YWxsZWQgYWdhaW4sIGJlY2F1c2UgdGhlIGh1bWFuIGlzIG93ZWQgdGhlXG4gKiB0cnV0aCBldmVudHVhbGx5OyB0aGF0IGV4cGlyeSBpcyBkZWxpYmVyYXRlbHkgbm90IGEgcmVhc29uIHRvIG51ZGdlIHRoZSBhZ2VudFxuICogYSBzZWNvbmQgdGltZSAoc2VlIHRoZSBzZXJ2ZXIncyBvbmNlLXBlci1tZXNzYWdlIHJ1bGUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2FpdGluZ09uKFxuICBjaGF0OiByZWFkb25seSBNc2dbXSxcbiAgbm93OiBudW1iZXIsXG4gIG9wdHM6IHsgc3RhbGxNcz86IG51bWJlcjsgYWNrbm93bGVkZ2VkVW50aWw/OiBudW1iZXIgfSA9IHt9LFxuKTogV2FpdGluZyB8IG51bGwge1xuICAvLyBXYWxrIGJhY2sgdG8gdGhlIGxhc3QgdGhpbmcgdGhhdCB3YXMgbm90IG5hcnJhdGlvbi4gQSBodW1hbiB0aGVyZSBtZWFuc1xuICAvLyBub2JvZHkgaGFzIGFuc3dlcmVkIHRoZW0uXG4gIGxldCBwZW5kaW5nOiBNc2cgfCBudWxsID0gbnVsbDtcbiAgZm9yIChsZXQgaSA9IGNoYXQubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBtID0gY2hhdFtpXTtcbiAgICBpZiAoIW0gfHwgbS53aG8gPT09IFwic3lzdGVtXCIpIGNvbnRpbnVlO1xuICAgIGlmIChtLndobyA9PT0gXCJhZ2VudFwiKSByZXR1cm4gbnVsbDtcbiAgICBwZW5kaW5nID0gbTtcbiAgICBicmVhaztcbiAgfVxuICBpZiAoIXBlbmRpbmcpIHJldHVybiBudWxsO1xuXG4gIC8vIOKaoCBUaGUgRklSU1Qgb2YgdGhlIHVuYW5zd2VyZWQgcnVuLCBub3QgdGhlIGxhc3QuIFNvbWVvbmUgd2hvIHNlbmRzIHRocmVlXG4gIC8vIG1lc3NhZ2VzIHdoaWxlIHdhaXRpbmcgaGFzIGJlZW4gd2FpdGluZyBzaW5jZSB0aGUgZmlyc3Qgb25lLCBhbmQgcmVzZXR0aW5nXG4gIC8vIHRoZSBjbG9jayBvbiBldmVyeSBmb2xsb3ctdXAgd291bGQgbWVhbiB0aGUgbW9yZSBhbnhpb3VzIHRoZXkgZ2V0LCB0aGVcbiAgLy8gbG9uZ2VyIHdlIGNsYWltIHRoZXkgaGF2ZSBiZWVuIHdhaXRpbmcgaXMgemVyby5cbiAgbGV0IHNpbmNlID0gcGVuZGluZy50cztcbiAgbGV0IG1lc3NhZ2VJZCA9IHBlbmRpbmcuaWQ7XG4gIGZvciAobGV0IGkgPSBjaGF0Lmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbSA9IGNoYXRbaV07XG4gICAgaWYgKCFtIHx8IG0ud2hvID09PSBcInN5c3RlbVwiKSBjb250aW51ZTtcbiAgICBpZiAobS53aG8gIT09IFwiaHVtYW5cIikgYnJlYWs7XG4gICAgc2luY2UgPSBtLnRzO1xuICAgIG1lc3NhZ2VJZCA9IG0uaWQ7XG4gIH1cblxuICByZXR1cm4geyBtZXNzYWdlSWQsIHNpbmNlLCBiYWRnZTogYmFkZ2VGb3Ioc2luY2UsIG5vdywgb3B0cykgfTtcbn1cblxuLyoqXG4gKiBQdWxzZSBvciBzdGFsbGVkLCBmb3IgYW55dGhpbmcgb3dlZCBhbiBhbnN3ZXIgc2luY2UgYHNpbmNlYC4gT05FIHBsYWNlLCBzbyBhXG4gKiBub3RlIGFuZCBhIG1lc3NhZ2Ugd2FpdGluZyBlcXVhbGx5IGxvbmcgY2FuIG5ldmVyIHJlYWQgZGlmZmVyZW50bHkuXG4gKi9cbmZ1bmN0aW9uIGJhZGdlRm9yKFxuICBzaW5jZTogbnVtYmVyLFxuICBub3c6IG51bWJlcixcbiAgb3B0czogeyBzdGFsbE1zPzogbnVtYmVyOyBhY2tub3dsZWRnZWRVbnRpbD86IG51bWJlciB9LFxuKTogV2FpdGluZ1tcImJhZGdlXCJdIHtcbiAgY29uc3Qgc3RhbGxNcyA9IG9wdHMuc3RhbGxNcyA/PyBTVEFMTF9NUztcbiAgY29uc3QgYWNrbm93bGVkZ2VkID0gb3B0cy5hY2tub3dsZWRnZWRVbnRpbCAhPT0gdW5kZWZpbmVkICYmIG5vdyA8IG9wdHMuYWNrbm93bGVkZ2VkVW50aWw7XG4gIHJldHVybiBub3cgLSBzaW5jZSA+PSBzdGFsbE1zICYmICFhY2tub3dsZWRnZWQgPyBcInN0YWxsZWRcIiA6IFwid29ya2luZ1wiO1xufVxuXG4vLyDilIDilIAgRTY1OiB0aGUgc2FtZSBxdWVzdGlvbiwgYXNrZWQgb2YgYSBub3RlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIEFnZW50cyBhY3Qgb24gbmVhcmx5IGV2ZXJ5IG5vdGUsIGFuZCBDb2xlIHJ1bGVkIHRoYXQgdGhlIHJpZ2h0IGluc3RpbmN0OyB3aGF0XG4vLyB3YXMgbWlzc2luZyB3YXMgYW55IHNpZ24sIGJldHdlZW4gYWRkaW5nIGEgbm90ZSBhbmQgdGhlIGFnZW50J3MgYW5zd2VyLCB0aGF0XG4vLyBzb21ldGhpbmcgd2FzIGhhcHBlbmluZy4gU28gYSBub3RlIGdldHMgRTUzJ3MgdHJlYXRtZW50IFdIT0xFOiBkZXJpdmVkLCBuZXZlclxuLy8gZGVjbGFyZWQ7IGEgcHVsc2UsIHRoZW4gYSBzdGF0aWMgXCJtYXkgYmUgc3R1Y2tcIiBhdCB0aGUgc2FtZSAzMCBzOyB0aGUgc2FtZVxuLy8gc25vb3plLiBOb3RoaW5nIGhlcmUgYXNrcyB0aGUgYWdlbnQgZm9yIGFueXRoaW5nIG5ldy5cbi8vXG4vLyDim5QgV0hBVCBBTlNXRVJTIEEgTk9URSDigJQgdGhlIHJ1bGUsIGFuZCBlYWNoIHBhcnQgaXMgYSBmYWN0IHRoZSBkYWVtb24gYWxyZWFkeVxuLy8gaG9sZHM6XG4vLyAgIMK3IFJFU09MVkVELiBSZXNvbHZpbmcgaXMgdGhlIGFjdCB0aGF0IGNsb3NlcyBhIG5vdGUgKENvbGUpLCBieSBlaXRoZXIgcGFydHksXG4vLyAgICAgc28gYSByZXNvbHZlZCBub3RlIGlzIG93ZWQgbm90aGluZy4gSXQgaXMgdGhlIG5vdGUncyBvd24gc3RvcmVkIHN0YXRlLFxuLy8gICAgIG5vdCBhIGNvcHkgb2YgaXQuXG4vLyAgIMK3IEFOIEFHRU5UIE1FU1NBR0UgQUZURVIgSVQuIFRoZSBhZ2VudCBzcG9rZSB0byB0aGUgaHVtYW4gYWZ0ZXIgdGhlIG5vdGVcbi8vICAgICB3YXMgd3JpdHRlbiwgd2hpY2ggaXMgd2hhdCB0aGUgaHVtYW4gaXMgd2FpdGluZyBmb3Ig4oCUIHRoZSBzYW1lIHJlYXNvblxuLy8gICAgIG9uZSByZXBseSBhbnN3ZXJzIEU1MydzIHJ1biBvZiBtZXNzYWdlcy4gSXQgY2xhaW1zIFwidGhlIGFnZW50IGhhcyBzYWlkXG4vLyAgICAgc29tZXRoaW5nIHNpbmNlXCIsIG5ldmVyIFwidGhlIGFnZW50IGRlYWx0IHdpdGggdGhpc1wiLCBzbyBpdCBjbGVhcnMgdGhlXG4vLyAgICAgcGVuZGluZyBtYXJrIGFuZCBsZWF2ZXMgdGhlIG5vdGUgT1BFTjogZGVhbHQgd2l0aCBpcyBgcmVzb2x2ZWRgLlxuLy8gICAgIENvdW50aW5nIG9ubHkgYHJlc29sdmVkYCB3YXMgdGhlIG9wdGlvbiBub3QgdGFrZW4g4oCUIGFuIGFnZW50IHZpc2libHlcbi8vICAgICB3b3JraW5nIG9uIGEgbm90ZSB3b3VsZCBmbGlwIGl0IHRvIFwibWF5IGJlIHN0dWNrXCIgd2hlbmV2ZXIgaXQgZm9yZ290IHRvXG4vLyAgICAgcmVzb2x2ZSwgYW5kIEU1MydzIHdob2xlIHByZW1pc2UgaXMgdGhhdCBpdCBmb3JnZXRzLlxuLy8gICDCtyBUSEUgQUdFTlQgUkVXUklUSU5HIFRISVMgTk9URS4gQW4gYWN0IG9uIHRoaXMgbm90ZSwgc2VlbiBvbiB0aGlzIG5vdGUuXG4vLyDimqAgQU5EIEEgU1lTVEVNIExJTkUgSVMgU1RJTEwgTk9UIEEgUkVQTFkuIFRoZSBhZ2VudCByZXNvbHZpbmcgbm90ZSBBIGlzXG4vLyBuYXJyYXRlZCBhcyBhIHN5c3RlbSBsaW5lOyBpdCBhbnN3ZXJzIEEgKEEgaXMgcmVzb2x2ZWQpIGFuZCBzYXlzIG5vdGhpbmdcbi8vIGFib3V0IEIuXG5cbi8qKiBXaGF0IHRoZSBydWxlIHJlYWRzIG9mZiBhIG5vdGUg4oCUIHRoZSBzdG9yZWQgZmllbGRzLCBub3RoaW5nIHBsYWNlZC4gKi9cbnR5cGUgTm90ZUZhY3RzID0gUGljazxcbiAgTm90ZSxcbiAgXCJpZFwiIHwgXCJ3aG9cIiB8IFwiY3JlYXRlZEF0XCIgfCBcImVkaXRlZEF0XCIgfCBcImVkaXRlZEJ5XCIgfCBcInJlb3BlbmVkQXRcIiB8IFwicmVvcGVuZWRCeVwiIHwgXCJyZXNvbHZlZFwiXG4+O1xuXG4vKipcbiAqIFdoZW4gdGhlIGh1bWFuIGxhc3Qgd3JvdGUgaW50byB0aGlzIG5vdGUsIG9yIG51bGwgaWYgdGhleSBuZXZlciBkaWQgb3IgdGhlXG4gKiBhZ2VudCBoYXMgYWN0ZWQgb24gaXQgc2luY2UuIEEgd3JpdGUgaXMgbWFraW5nIGl0LCByZXdyaXRpbmcgaXQsIG9yXG4gKiBSRU9QRU5JTkcgaXQg4oCUIGVhY2ggb25lIGEgaHVtYW4gcHV0dGluZyB0aGUgbm90ZSBpbiBmcm9udCBvZiB0aGUgYWdlbnRcbiAqICh2ZXJpZmllcjogYSByZW9wZW4gdXNlZCB0byBjb21lIGJhY2sgdGltZWQgZnJvbSB3aGVuIHRoZSBub3RlIHdhcyBtYWRlLCBzb1xuICogaXQgY291bGQgcmVhcHBlYXIgYWxyZWFkeSBcIm1heSBiZSBzdHVja1wiKS4gVGhlIGFnZW50IHJld3JpdGluZyBvciByZW9wZW5pbmdcbiAqIGl0IGlzIGFuIGFjdCBvbiB0aGlzIG5vdGUsIGFuZCBhbnN3ZXJzIGl0LiBBbiBlZGl0IHdob3NlIGF1dGhvciB3YXMgbm90XG4gKiByZWNvcmRlZCAoYmVmb3JlIEU2NSkgaXMgbm90IGV2aWRlbmNlIGVpdGhlciB3YXkuXG4gKi9cbmZ1bmN0aW9uIGh1bWFuV3JvdGVBdChuOiBOb3RlRmFjdHMpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgYWN0czogeyBhdDogbnVtYmVyOyBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiIH1bXSA9IFt7IGF0OiBuLmNyZWF0ZWRBdCwgYnk6IG4ud2hvIH1dO1xuICBpZiAobi5lZGl0ZWRBdCAhPT0gdW5kZWZpbmVkICYmIG4uZWRpdGVkQnkpIGFjdHMucHVzaCh7IGF0OiBuLmVkaXRlZEF0LCBieTogbi5lZGl0ZWRCeSB9KTtcbiAgaWYgKG4ucmVvcGVuZWRBdCAhPT0gdW5kZWZpbmVkICYmIG4ucmVvcGVuZWRCeSkgYWN0cy5wdXNoKHsgYXQ6IG4ucmVvcGVuZWRBdCwgYnk6IG4ucmVvcGVuZWRCeSB9KTtcbiAgbGV0IGxhc3QgPSBhY3RzWzBdIGFzIHsgYXQ6IG51bWJlcjsgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIiB9O1xuICBmb3IgKGNvbnN0IGEgb2YgYWN0cykgaWYgKGEuYXQgPj0gbGFzdC5hdCkgbGFzdCA9IGE7XG4gIHJldHVybiBsYXN0LmJ5ID09PSBcImh1bWFuXCIgPyBsYXN0LmF0IDogbnVsbDtcbn1cblxuLyoqXG4gKiBFdmVyeSBub3RlIG93ZWQgYW4gYW5zd2VyLCBvbGRlc3QgZmlyc3QuXG4gKlxuICog4puUIEEgTk9URSBUSEUgSFVNQU4gSEFTIEFTS0VEIEFCT1VUIHdhaXRzIE9OIFRIQVQgTUVTU0FHRSAodmVyaWZpZXIgRDEpLiBcIkFza1xuICogdGhlIGFnZW50XCIgcG9zdHMgYSBtZXNzYWdlIGNhcnJ5aW5nIHRoZSBub3RlJ3MgcmVmZXJlbmNlOyB3aGlsZSB0aGF0IG1lc3NhZ2VcbiAqIGlzIHVuYW5zd2VyZWQsIHRoZSBub3RlIHNheXMgaXQgd2FzIGFza2VkLCBhbmQgaXRzIGJhZGdlIElTIEU1MydzIGJhZGdlIGZvclxuICogdGhlIGNvbnZlcnNhdGlvbiDigJQgbm90IGEgc2Vjb25kIGNsb2NrIHRoYXQgY291bGQgZGlzYWdyZWUgd2l0aCBpdC4gVGhlcmUgaXNcbiAqIG5vIFwiYXNrZWRcIiBmbGFnOiBpdCBpcyByZWFkIG9mZiB0aGUgY29udmVyc2F0aW9uIGxpa2UgZXZlcnl0aGluZyBlbHNlIGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3Rlc1dhaXRpbmcoXG4gIGRvY3M6IHJlYWRvbmx5IHsgc2x1Zzogc3RyaW5nOyBub3RlczogcmVhZG9ubHkgTm90ZUZhY3RzW10gfVtdLFxuICBjaGF0OiByZWFkb25seSBNc2dbXSxcbiAgbm93OiBudW1iZXIsXG4gIG9wdHM6IHsgc3RhbGxNcz86IG51bWJlcjsgYWNrbm93bGVkZ2VkVW50aWw/OiBudW1iZXIgfSA9IHt9LFxuKTogTm90ZVdhaXRpbmdbXSB7XG4gIGxldCBsYXN0QWdlbnQgPSBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIGZvciAoY29uc3QgbSBvZiBjaGF0KSBpZiAobS53aG8gPT09IFwiYWdlbnRcIiAmJiBtLnRzID4gbGFzdEFnZW50KSBsYXN0QWdlbnQgPSBtLnRzO1xuICBjb25zdCB3YWl0ID0gd2FpdGluZ09uKGNoYXQsIG5vdywgb3B0cyk7XG4gIGNvbnN0IG91dDogTm90ZVdhaXRpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGQgb2YgZG9jcylcbiAgICBmb3IgKGNvbnN0IG4gb2YgZC5ub3Rlcykge1xuICAgICAgaWYgKG4ucmVzb2x2ZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc2luY2UgPSBodW1hbldyb3RlQXQobik7XG4gICAgICAvLyDimqAgU1RSSUNUTFkgYWZ0ZXI6IGEgcmVwbHkgaW4gdGhlIHNhbWUgbWlsbGlzZWNvbmQgY2Fubm90IGhhdmUgcmVhZCBpdC5cbiAgICAgIGlmIChzaW5jZSA9PT0gbnVsbCB8fCBsYXN0QWdlbnQgPiBzaW5jZSkgY29udGludWU7XG4gICAgICAvLyBBbnkgYXNrIGFmdGVyIHRoZSBub3RlJ3MgbGFzdCB3cml0ZSBpcyB1bmFuc3dlcmVkIGJ5IGNvbnN0cnVjdGlvbjogYVxuICAgICAgLy8gcmVwbHkgYWZ0ZXIgaXQgd291bGQgYmUgYWZ0ZXIgdGhlIG5vdGUgdG9vLCBhbmQgY2xlYXJlZCBpdCBhYm92ZS5cbiAgICAgIGNvbnN0IGFza2VkID0gd2FpdFxuICAgICAgICA/IGNoYXQuZmluZExhc3QoXG4gICAgICAgICAgICAobSkgPT5cbiAgICAgICAgICAgICAgbS53aG8gPT09IFwiaHVtYW5cIiAmJiBtLnRzID49IHNpbmNlICYmIG0ubm90ZT8uZG9jID09PSBkLnNsdWcgJiYgbS5ub3RlLmlkID09PSBuLmlkLFxuICAgICAgICAgIClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBvdXQucHVzaChcbiAgICAgICAgYXNrZWQgJiYgd2FpdFxuICAgICAgICAgID8geyBkb2M6IGQuc2x1Zywgbm90ZUlkOiBuLmlkLCBzaW5jZSwgYmFkZ2U6IHdhaXQuYmFkZ2UsIGFza2VkSW46IGFza2VkLmlkIH1cbiAgICAgICAgICA6IHsgZG9jOiBkLnNsdWcsIG5vdGVJZDogbi5pZCwgc2luY2UsIGJhZGdlOiBiYWRnZUZvcihzaW5jZSwgbm93LCBvcHRzKSB9LFxuICAgICAgKTtcbiAgICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gYS5zaW5jZSAtIGIuc2luY2UpO1xufVxuXG4vKipcbiAqIFdoYXQgRTUzJ3MgYXR0ZW50aW9uIHRpY2sgY29tcGFyZXMgdG8gZGVjaWRlIHdoZXRoZXIgdGhlIHN1cmZhY2UgbmVlZHMgYSBuZXdcbiAqIHNuYXBzaG90OiB0aGUgbWVzc2FnZSB3YWl0IGFuZCBldmVyeSBvd2VkIG5vdGUsIHdpdGggdGhlaXIgYmFkZ2VzLiDim5QgQSBub3RlXG4gKiBmbGlwcGluZyB0byBcIm1heSBiZSBzdHVja1wiIGhhcHBlbnMgd2l0aCBub3RoaW5nIGVsc2UgY2hhbmdpbmcg4oCUIG5vIG1lc3NhZ2UsXG4gKiBubyBhY3Qg4oCUIHNvIGlmIHRoaXMga2V5IGNvdWxkIG5vdCBzZWUgbm90ZXMsIHRoZSBwdWxzZSB3b3VsZCBydW4gb24gb3ZlciBhXG4gKiBzdHVjayBub3RlIHVudGlsIHNvbWV0aGluZyB1bnJlbGF0ZWQgcmUtc2VudCB0aGUgc3RhdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhdHRlbnRpb25LZXkodzogV2FpdGluZyB8IG51bGwsIG5vdGVzOiByZWFkb25seSBOb3RlV2FpdGluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICB3ID8gYCR7dy5tZXNzYWdlSWR9OiR7dy5iYWRnZX1gIDogXCItXCIsXG4gICAgLi4ubm90ZXMubWFwKChuKSA9PiBgJHtuLmRvY30vJHtuLm5vdGVJZH06JHtuLmJhZGdlfSR7bi5hc2tlZEluID8gYEAke24uYXNrZWRJbn1gIDogXCJcIn1gKSxcbiAgXS5qb2luKFwifFwiKTtcbn1cblxuLyoqXG4gKiBIb3cgbXVjaCBvZiBhIG5vdGUgYG5vdGUuYWRkZWRgIGNhcnJpZXM6IHRoZSBxdW90ZSBhbmQgdGhlIGJvZHkgdG9nZXRoZXIsIGluXG4gKiBjaGFyYWN0ZXJzLiBBIHBhcmFncmFwaCdzIHdvcnRoLiBOb3RlcyBhcmUgbWFkZSBtaWQtcmVhZCwgb24gYSBwaHJhc2Ugb3IgYVxuICogc2VudGVuY2UsIGFuZCB0aG9zZSB0cmF2ZWwgd2hvbGUgc28gdGhlIGFnZW50IGNhbiBhY3Qgd2l0aG91dCBhIHJvdW5kIHRyaXAuXG4gKiBBIG5vdGUgb3ZlciBhIHdob2xlIHNlY3Rpb24gaXMgd2hlcmUgdGhlIHJvdW5kIHRyaXAgcGF5czogYG5vdGVzYCBhbHNvIHNheXNcbiAqIHdoZXRoZXIgdGhlIHBhc3NhZ2Ugc3RpbGwgc3RhbmRzIGFuZCB3aGVyZSBpdCBpcyBub3cuIFRoZSBvbmUgd2hvIGFjdHMgb25cbiAqIHRoaXMgbnVtYmVyIGlzIHRoZSBhZ2VudCByZWFkaW5nIGl0cyB0YWlsLlxuICovXG5leHBvcnQgY29uc3QgTk9URV9URVhUX01BWCA9IDEwMDA7XG5cbi8qKlxuICogV2hhdCBgbm90ZS5hZGRlZGAgKGFuZCBhIGh1bWFuJ3MgYG5vdGUuZWRpdGVkYCkgdGVsbHMgdGhlIGFnZW50IGJleW9uZCB0aGUgaWRzXG4gKiAoRTY1KS4gVGhlIGV2ZW50IG5hbWVzIGl0cyBuZXh0IGFjdCwgYmVjYXVzZSBhbiBhZ2VudCB0aGF0IG11c3QgZ28gYW5kIGFza1xuICogd2hhdCBhcnJpdmVkIGlzIGFuIGFnZW50IG9uZSBzdGVwIGZ1cnRoZXIgZnJvbSBkb2luZyBpdC5cbiAqXG4gKiDim5QgV0hPTEUgT1IgTk9UIEFUIEFMTCwgbmV2ZXIgdHJ1bmNhdGVkLiBBIGNsaXBwZWQgcXVvdGUgcmVhZHMgYXMgdGhlIHdob2xlXG4gKiBwYXNzYWdlLCB3aGljaCBpcyB3b3JzZSB0aGFuIG5vIHF1b3RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm90ZUV2ZW50RmFjdHMoXG4gIHNsdWc6IHN0cmluZyxcbiAgbm90ZTogeyBpZDogc3RyaW5nOyBxdW90ZTogc3RyaW5nOyBib2R5OiBzdHJpbmcgfSxcbiAgbGluZXM6IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH0gfCBudWxsLFxuKToge1xuICBsaW5lcz86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07XG4gIHF1b3RlPzogc3RyaW5nO1xuICBib2R5Pzogc3RyaW5nO1xuICBwYXNzYWdlPzogXCJnb25lXCI7XG4gIGhpbnQ6IHN0cmluZztcbn0ge1xuICBjb25zdCBjbG9zZSA9IGBub3RlLXJlc29sdmUgJHtub3RlLmlkfSAtLWRvYyAke3NsdWd9YDtcbiAgLy8g4pqgIEEgbm90ZSB3aG9zZSBwYXNzYWdlIGlzIG5vIGxvbmdlciBpbiB0aGUgYWN0aXZlIHZlcnNpb24gaGFzIG5vIGxpbmVzLCBhbmRcbiAgLy8gbXVzdCBTQVkgc28gKHZlcmlmaWVyIEQ1KSDigJQgb3RoZXJ3aXNlIFwiYWN0IG9uIGl0XCIgc2VuZHMgdGhlIGFnZW50IGxvb2tpbmdcbiAgLy8gZm9yIHRleHQgdGhhdCBpcyBub3QgdGhlcmUuXG4gIGNvbnN0IGF0ID0gbGluZXMgPyB7IGxpbmVzIH0gOiB7IHBhc3NhZ2U6IFwiZ29uZVwiIGFzIGNvbnN0IH07XG4gIC8vIENIQVJBQ1RFUlMsIG5vdCBVVEYtMTYgdW5pdHM6IGFuIGVtb2ppIGlzIG9uZSBjaGFyYWN0ZXIgdG8gd2hvZXZlciB3cm90ZSBpdC5cbiAgY29uc3Qgc2l6ZSA9IFsuLi5ub3RlLnF1b3RlXS5sZW5ndGggKyBbLi4ubm90ZS5ib2R5XS5sZW5ndGg7XG4gIGlmIChzaXplIDw9IE5PVEVfVEVYVF9NQVgpXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmF0LFxuICAgICAgcXVvdGU6IG5vdGUucXVvdGUsXG4gICAgICBib2R5OiBub3RlLmJvZHksXG4gICAgICBoaW50OiBsaW5lc1xuICAgICAgICA/IGBhY3Qgb24gaXQsIHRoZW4gXFxgJHtjbG9zZX1cXGAgd2hlbiBpdCBpcyBkZWFsdCB3aXRoYFxuICAgICAgICA6IGBpdHMgcGFzc2FnZSBpcyBubyBsb25nZXIgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uIOKAlCBzZWUgXFxgbm90ZXMgLS1kb2MgJHtzbHVnfVxcYCwgdGhlbiBhY3Qgb24gaXQgYW5kIFxcYCR7Y2xvc2V9XFxgIHdoZW4gaXQgaXMgZGVhbHQgd2l0aGAsXG4gICAgfTtcbiAgcmV0dXJuIHtcbiAgICAuLi5hdCxcbiAgICBoaW50OiBgdG9vIGxvbmcgdG8gY2Fycnkke2xpbmVzID8gXCJcIiA6IFwiLCBhbmQgaXRzIHBhc3NhZ2UgaXMgbm8gbG9uZ2VyIGluIHRoZSBhY3RpdmUgdmVyc2lvblwifSDigJQgcmVhZCBpdCB3aXRoIFxcYG5vdGVzIC0tZG9jICR7c2x1Z31cXGAsIGFjdCBvbiBpdCwgdGhlbiBcXGAke2Nsb3NlfVxcYGAsXG4gIH07XG59XG5cbi8qKiBXaGF0IHRoZSBjb252ZXJzYXRpb24gc2hvd3MsIHBlciBiYWRnZS4gbWluZC1tYXBwZXIncyB3b3JkcywgbmVhciBlbm91Z2guICovXG5leHBvcnQgY29uc3QgV0FJVElOR19MQUJFTDogUmVjb3JkPFdhaXRpbmdbXCJiYWRnZVwiXSwgc3RyaW5nPiA9IHtcbiAgd29ya2luZzogXCJ3b3JraW5nIG9uIHRoaXPigKZcIixcbiAgc3RhbGxlZDogXCJ0b29rIHRoaXMgaW4sIHRoZW4gd2VudCBxdWlldCDigJQgbWF5IGJlIHN0dWNrXCIsXG59O1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXFEQSx1QkFBUyw2QkFBNEIsMkJBQWMseUJBQVU7QUFDN0Qsb0JBQVM7QUFDVCxxQkFBUyxzQkFBVSx3QkFBUyxxQkFBWSxrQkFBTTtBQUM5QztBQUNBLHNCQUFTOzs7QUMzQ1Q7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFBZSxDQUM3QixNQUNBLFVBQ0EsV0FBMkMsQ0FBQyxRQUFRLElBQUksS0FBSyxHQUNwRDtBQUFBLEVBQ1QsSUFBSTtBQUFBLElBQ0YsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLE1BQUcsT0FBTztBQUFBLElBQzlCLElBQUksU0FB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
