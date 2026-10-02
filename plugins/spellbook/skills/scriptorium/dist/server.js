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
  return { port: boundPort, sessionId, mode, dir: session.dir, close, done, shutdown };
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
  humanOutsideLine,
  main,
  resolveMode2 as resolveMode,
  run,
  scriptoriumHome,
  startDaemon,
  surfacePath
};

//# debugId=D69B7D013DE1E8EC64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL29yaWdpbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc2VydmVEaXN0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zc2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvYW5jaG9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9kaWZmLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2RvY3Rvci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oaXN0b3J5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZWxlY3Rpb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2Vzc2lvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9mcm9udG1hdHRlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9saW5rcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3NlYXJjaC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC93YWl0aW5nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBwZXItc2Vzc2lvbiBkYWVtb24g4oCUIHRoZSBwcm9jZXNzIHRoZSBzdXJmYWNlIHRhbGtzIHRvIG92ZXIgYVxuICogV2ViU29ja2V0IGFuZCB0aGUgQ0xJIHRhbGtzIHRvIG92ZXIgSFRUUC4gTGF1bmNoZWQgYnlcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvc2NyaXB0b3JpdW0vc2NyaXB0cy9zZXJ2ZXIudHNgICh0aGUgbGF1bmNoZXIpLCB3aGljaFxuICogaW1wb3J0cyB0aGUgQlVJTFQgYGRpc3Qvc2VydmVyLmpzYC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogYFNLSUxMX1JPT1RgL2BESVNUX0RJUmAgb25seSwgZm9yIHRoZSBraXQncyBgcmVzb2x2ZU1vZGVgIGFuZFxuICogICAgYHNlcnZlRnJvbURpc3RgLCBhbmQgdHJ1ZSBhdCB0aGUgRU1JVFRFRCBhZGRyZXNzIChgZGlzdC9zZXJ2ZXIuanNgLCB3aG9zZVxuICogICAgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyKS4gTm90aGluZyBlbHNlIGlzIHBpbm5lZCBvZmYgYGltcG9ydC5tZXRhYC5cbiAqIDIuIFNlcnZlczogWUVTLiBgL2AgaXMgdGhlIGJ1aWx0IGBpbmRleC5odG1sYCB2aWEgYHNlcnZlRnJvbURpc3RgLCBub1xuICogICAgc3Vic3RpdHV0aW9uOyB0aGUgb25seSByb3V0ZXMgb2YgaXRzIG93biBhcmUgYC9zdGF0ZWAsIGAvY21kYCwgYC9ldmVudHNgLFxuICogICAgYC93c2AgYW5kIGAvZnMvKmAgKHJlYWQtb25seTogYSB2ZXJzaW9uJ3MgdGV4dCwgYSBkaXJlY3RvcnkgbGlzdGluZykuXG4gKiAzLiBTZWNvbmQgaGFsZjogWUVTIOKAlCBgY2xpLnRzYDsgdGhlIHR3byBzaGFyZSBgLi9oZWFydGJlYXQudHNgLlxuICogNC4gTGlmZWN5Y2xlOiBsb25nLXJ1bm5pbmcsIG9uZSBkYWVtb24gcGVyIHNlc3Npb24sIGlkbGUtdGltZW91dCBsaWtlXG4gKiAgICBnbGFtb3VyIChsaW5nZXIgYWZ0ZXIgdGhlIGxhc3Qgc3Vic2NyaWJlciBsZWF2ZXM7IGV4aXQgMTI0KS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDigJQgYG1haW5gIGF3YWl0cyB0aGVcbiAqICAgIHNlc3Npb24ncyBlbmQgYW5kIGl0cyBvd24gZHJhaW4sIGV4YWN0bHkgYXMgZ2xhbW91cidzIHNlcnZlciBkb2VzLCBzbyB0aGVcbiAqICAgIGxhdW5jaGVyIGlzIFRFUk1JTkFMLUVYSVQgKGBwcm9jZXNzLmV4aXQoYXdhaXQgcnVuKCkpYCk6IG9uY2UgYG1haW5gXG4gKiAgICByZXNvbHZlcyBub3RoaW5nIG1heSBrZWVwIHRoZSBwcm9jZXNzIGFsaXZlLCBhbmQgYSB3YXRjaGVyIGhhbmRsZSBvciBhXG4gKiAgICBzdHJhZ2dsaW5nIHNvY2tldCB3b3VsZC4gRHJpdmVuLCBub3QgcmVhZCAoc2VlIHRoZSBzbGljZS1BIGpvdXJuYWwpLlxuICogNi4gRXZlbnQgaWRzIHJlY292ZXJlZCBhY3Jvc3MgcmVzdGFydD8gTk8g4oCUIHRoZSBsb2cgaXMgaW4gbWVtb3J5IGFuZCBpZHNcbiAqICAgIHJlc3RhcnQgYXQgMSwgZXZlbiB1bmRlciBgLS1yZXN0b3JlYCAod2hpY2ggcmVzdG9yZXMgdGhlIE1BTklGRVNULCBub3QgdGhlXG4gKiAgICBsb2cpLiBTbyB0aGUgbG9nIGlzIHN0YW1wZWQgd2l0aCBhIHBlci1ib290IEVQT0NIIChtaW5kLW1hcHBlcidzIHNoYXBlKVxuICogICAgYW5kIHRoZSB0YWlsIHJlc2V0cyBpdHMgY3Vyc29yIHdoZW4gdGhlIGVwb2NoIGNoYW5nZXMuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBObyDigJQgdGhlIHNoYXBlIHdhcyBjaG9zZW4gdG8gYmUgdGhlXG4gKiAgICBraXQncy5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBOTzogc2NyaXB0b3JpdW1cbiAqICAgIGlzIHRoZSBmaXJzdCBzcGVsbCBzY2FmZm9sZGVkIGFmdGVyIHRoZSBjb252ZXJnZW5jZS5cbiAqXG4gKiDilIDilIAgS0lUIFZFUkRJQ1RTIChwbGF5Ym9vayBONCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZXJyb3JzIFNVQkpFQ1QgKHRoZSBDTEk7IHRoZSBkYWVtb24gYW5zd2VycyBIVFRQIHN0YXR1c2VzIHRoZSBDTEkgbWFwcykgwrdcbiAqIHNlcnZlRGlzdCBTVUJKRUNUIChgcmVzb2x2ZU1vZGVgLCBgc2VydmVGcm9tRGlzdGApIMK3IGhvdXNla2VlcGluZyBTVUJKRUNULCBhbGxcbiAqIHRocmVlIGV4cG9ydHMgKGBzaG91bGRJZGxlQ2xvc2VgIHZpYSBgc3RhcnRIb3VzZWtlZXBpbmdgJ3MgaWRsZS1jbG9zZSwgdGhlXG4gKiBzbmFwc2hvdCBzd2VlcCDigJQgaGVyZSB0aGUgbWFuaWZlc3QgaXMgd3JpdHRlbiBvbiBldmVyeSBjaGFuZ2UgaW5zdGVhZCwgc28gdGhlXG4gKiBzd2VlcCdzIHNuYXBzaG90IGhvb2sgaXMgZGVsaWJlcmF0ZWx5IE5PVCBwYXNzZWQg4oCUIGFuZCBgZHJhaW5BbmRTdG9wYCkgwrdcbiAqIHRhaWxFdmVudHMgU1VCSkVDVCAodGhlIENMSSdzIGB0YWlsYCkgwrcgaGVhcnRiZWF0IFNVQkpFQ1QgKGAuL2hlYXJ0YmVhdC50c2ApIMK3XG4gKiBkaXNjb3ZlcnkgU1VCSkVDVCAoc2Vzc2lvbi1KU09OLCBFMTM6IGBzY3JpcHRvcml1bS08aWQ+Lmpzb25gICtcbiAqIGBzY3JpcHRvcml1bS1sYXRlc3QuanNvbmAgaW4gdG1wZGlyIHZpYSBgd3JpdGVGaWxlQXRvbWljYC9gdW5saW5rSWZNYXRjaGVzYCkgwrdcbiAqIGV2ZW50TG9nIFNVQkpFQ1QsIFdJVEggRVBPQ0ggKFE2KSDCtyBzc2UgU1VCSkVDVCAoYEdFVCAvZXZlbnRzYCkgwrdcbiAqIGxpYi9wcmludEpzb24gU1VCSkVDVCAodGhlIENMSSBzcGVha3MgdGhlIGFnZW50IHdpcmUpLlxuICpcbiAqIOKUgOKUgCBURUFSRE9XTiBPUkRFUiAocmVnaXN0ZXIgQTYpLCBTVEFURUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZ2xhbW91cidzIG9yZGVyOiBzdG9wIGhvdXNla2VlcGluZyDihpIgY2xvc2UgdGhlIHdhdGNoZXJzIOKGkiBwZXJzaXN0IHRoZVxuICogbWFuaWZlc3Qg4oaSIHVubGluayBkaXNjb3Zlcnkg4oaSIGVtaXQgYGNsb3NlZGAg4oaSIGRyYWluLiBEaXNjb3ZlcnkgZ29lcyBCRUZPUkUgdGhlXG4gKiBgY2xvc2VkYCBmcmFtZSBzbyBhIHRhaWwgdGhhdCBzZWVzIGBjbG9zZWRgIGFuZCBhIENMSSB2ZXJiIHRoYXQgcnVucyByaWdodFxuICogYWZ0ZXIgaXQgYm90aCBmaW5kIG5vIHBvaW50ZXIgdG8gYSBkYWVtb24gdGhhdCBpcyBsZWF2aW5nOyB0aGUgb3RoZXIgb3JkZXJcbiAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhIHZlcmIgcmVzb2x2ZXMgYSBzZXNzaW9uIHRoYXQgd2lsbCByZWZ1c2UgaXQuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgdHlwZSBGU1dhdGNoZXIsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMsIHVubGlua1N5bmMsIHdhdGNoIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgdW5saW5rSWZNYXRjaGVzLCB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudExvZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ldmVudExvZy50c1wiO1xuaW1wb3J0IHsgZHJhaW5BbmRTdG9wLCBzdGFydEhvdXNla2VlcGluZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHNcIjtcbmltcG9ydCB7IHJlZnVzZUZvcmVpZ25PcmlnaW4gfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvb3JpZ2luLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZSBhcyByZXNvbHZlTW9kZUluLCBzZXJ2ZUZyb21EaXN0IH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NlcnZlRGlzdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBTc2VDbGllbnRzLCBzc2VSZXNwb25zZSB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zc2UudHNcIjtcbmltcG9ydCB7IHF1b3RlTGFiZWwgfSBmcm9tIFwiLi9hbmNob3JzXCI7XG5pbXBvcnQgeyB1bmlmaWVkIH0gZnJvbSBcIi4vZGlmZlwiO1xuaW1wb3J0IHsgc3VtbWFyeSB9IGZyb20gXCIuL2RvY3RvclwiO1xuaW1wb3J0IHsgSURMRV9USU1FT1VUX1NFQywgU1NFX0hFQVJUQkVBVF9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgdHlwZSBBY3QsIHR5cGUgQWZ0ZXIsIHR5cGUgQmVmb3JlLCBIaXN0b3J5LCB0eXBlIEludmVyc2UsIHBsYW5JbnZlcnNlIH0gZnJvbSBcIi4vaGlzdG9yeVwiO1xuaW1wb3J0IHsgdHlwZSBQaWNrS2luZCwgcGFyc2VQaWNrZXJPdXRwdXQsIHBpY2tlckNvbW1hbmQsIHdhc0NhbmNlbGxlZCB9IGZyb20gXCIuL3BpY2tlclwiO1xuaW1wb3J0IHR5cGUge1xuICBBZ2VudENtZCxcbiAgQ2xpZW50TXNnLFxuICBDbG9zZWRCeSxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgU2VydmVyTXNnLFxuICBTdHJ1Y3R1cmVPcCxcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgU2NyZWVuLCBzZWxlY3Rpb25PblNjcmVlbiB9IGZyb20gXCIuL3NlbGVjdGlvblwiO1xuaW1wb3J0IHsgdHlwZSBGaWxlRXZlbnQsIFNlc3Npb24sIFNlc3Npb25FcnJvciwgc2lkZU5hbWUgfSBmcm9tIFwiLi9zZXNzaW9uXCI7XG5pbXBvcnQgeyBsaXN0RGlyLCBQYXRoRXJyb3IgfSBmcm9tIFwiLi90cmVlXCI7XG5pbXBvcnQge1xuICBhdHRlbnRpb25LZXksXG4gIERFRkFVTFRfU05PT1pFX01TLFxuICBub3RlRXZlbnRGYWN0cyxcbiAgbm90ZXNXYWl0aW5nLFxuICB3YWl0aW5nT24sXG59IGZyb20gXCIuL3dhaXRpbmdcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7XG4gIHBvcnQ/OiBudW1iZXI7XG4gIHJlc3RvcmU/OiBzdHJpbmc7XG4gIHRpbWVvdXRTPzogbnVtYmVyO1xuICAvKiogRTIzOiBhIE5FVyBzZXNzaW9uJ3Mgd29ya3NwYWNlIOKAlCB0aGUgZGlyZWN0b3J5IGBvcGVuYCByYW4gaW4uIEEgcmVzdG9yZSBrZWVwcyBpdHMgb3duLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSB0YWlsIGZyYW1lJ3MgcGF5bG9hZC4gVGhlIGxvZyBzdGFtcHMgYGlkYCBhbmQgYGVwb2NoYC4gKi9cbnR5cGUgTG9nRXZlbnQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgdHlwZTogc3RyaW5nIH07XG5cbi8qKiBIb3cgbG9uZyBhIGJ1cnN0IG9mIHdhdGNoZXIgZXZlbnRzIG9uIG9uZSBwYXRoIHNldHRsZXMgYmVmb3JlIGl0IGlzIHJlYWQuICovXG5jb25zdCBXQVRDSF9TRVRUTEVfTVMgPSA2MDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RGFlbW9uKG9wdHM6IFN0YXJ0T3B0cykge1xuICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gIC8vIE1vZGUgQkVGT1JFIGFueSB3cml0ZTogYSBmb3JjZWQtZGV2IGJvb3QgYXQgYSBzdXJmYWNlLWZyZWUgZGVzdGluYXRpb24gbXVzdFxuICAvLyBkaWUgYXQgdGhlIGltcG9ydCBoYXZpbmcgY3JlYXRlZCBub3RoaW5nIChnbGFtb3VyJ3MgbWVhc3VyZWQgb3JkZXIpLlxuICBjb25zdCBtb2RlID0gcmVzb2x2ZU1vZGUoKTtcbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHRcbiAgICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCByb3V0ZXMgPSAoZGV2SW5kZXggPyB7IFwiL1wiOiBkZXZJbmRleCB9IDoge30pIGFzIFJlY29yZDxzdHJpbmcsIG5ldmVyPjtcblxuICBjb25zdCBzZXNzaW9uID0gb3B0cy5yZXN0b3JlXG4gICAgPyBTZXNzaW9uLnJlc3RvcmUoaG9tZSwgb3B0cy5yZXN0b3JlKVxuICAgIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSwgdW5kZWZpbmVkLCBvcHRzLndvcmtzcGFjZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuICAvKiogVGhlIGRvY3VtZW50IHRleHQgb24gc2NyZWVuIOKAlCB0aGUgb3BlbiBkb2N1bWVudCBhdCBpdHMgYWN0aXZlIHZlcnNpb24uICovXG4gIGNvbnN0IHNjcmVlbiA9ICgpOiBTY3JlZW4gfCBudWxsID0+IHtcbiAgICBjb25zdCBkID0gc2Vzc2lvbi5vcGVuRG9jU2x1ZyA/IHNlc3Npb24uZmluZERvYyhzZXNzaW9uLm9wZW5Eb2NTbHVnKSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gZCA/IHsgZG9jOiBkLnNsdWcsIHZlcnNpb246IGQuYWN0aXZlIH0gOiBudWxsO1xuICB9O1xuICAvKipcbiAgICogVGhlIGhlbGQgc2VsZWN0aW9uLCBvbmNlIHRoZSB0ZXh0IGl0IHdhcyBtYWRlIGluIGlzIHN0aWxsIHRoZSB0ZXh0IG9uXG4gICAqIHNjcmVlbiAoRTY2KS4g4puUIFJFQUQgVEhST1VHSCBUSElTLCBORVZFUiBgc2VsZWN0aW9uYCBESVJFQ1RMWTogdGhlIG9wZW5cbiAgICogZG9jdW1lbnQgbW92ZXMgdW5kZXIgaXQgZnJvbSBtYW55IHBsYWNlcyAodGhlIHN1cmZhY2UncyBgb3BlbmAgYW5kXG4gICAqIGBvcGVuLmRvY2AsIHRoZSBhZ2VudCwgYSB2ZXJzaW9uIGFjdGl2YXRlZCwgYSBkb2N1bWVudCByZW1vdmVkKSwgYW5kIGFcbiAgICogY2hlY2sgYXQgZWFjaCBvZiB0aGVtIGlzIGEgY2hlY2sgc29tZSBmdXR1cmUgcGF0aCBmb3JnZXRzLiBEcm9wcGluZyBpdFxuICAgKiBoZXJlLCBvbiB0aGUgbmV4dCByZWFkLCBpcyB3aHkgZ29pbmcgYmFjayB0byB0aGUgZmlyc3QgZG9jdW1lbnQgZG9lcyBub3RcbiAgICogcmV2aXZlIGl0IOKAlCBldmVyeSBvbmUgb2YgdGhvc2UgcGF0aHMgYnJvYWRjYXN0cywgYW5kIHRoZSBicm9hZGNhc3QgcmVhZHMuXG4gICAqL1xuICBjb25zdCBoZWxkU2VsZWN0aW9uID0gKCk6IFNlbGVjdGlvbiB8IG51bGwgPT4ge1xuICAgIHNlbGVjdGlvbiA9IHNlbGVjdGlvbk9uU2NyZWVuKHNlbGVjdGlvbiwgc2NyZWVuKCkpO1xuICAgIHJldHVybiBzZWxlY3Rpb247XG4gIH07XG5cbiAgLy8gLS0tIHByZWZzOiBwZXItdmlld2VyIGNvbnZlbmllbmNlcyB0aGF0IG91dGxpdmUgYSBzZXNzaW9uJ3MgcG9ydCAtLS0tLS0tLS0tLS1cbiAgLy8gQnJvd3NlciBzdG9yYWdlIGlzIGtleWVkIGJ5IG9yaWdpbiwgcG9ydCBpbmNsdWRlZCwgYW5kIGV2ZXJ5IHNlc3Npb24gZ2V0cyBhXG4gIC8vIG5ldyBwb3J0IOKAlCBzbyBhIHBhbmUgc2l6ZSBrZXB0IGluIGxvY2FsU3RvcmFnZSByZXNldHMgYXQgdGhlIG5leHQgYG9wZW5gLlxuICAvLyBUaGV5IGxpdmUgaW4gdGhlIGhvbWUgaW5zdGVhZCwgc2hhcmVkIGJ5IGV2ZXJ5IHNlc3Npb24gb2YgdGhpcyBob21lLlxuICBjb25zdCBwcmVmc0ZpbGUgPSBqb2luKGhvbWUsIFwicHJlZnMuanNvblwiKTtcbiAgY29uc3QgUFJFRl9LRVkgPSAvXlthLXpdW2EtejAtOTouXy1dezAsNjN9JC87XG4gIGNvbnN0IFBSRUZfVkFMVUVfTUFYID0gNDA5NjtcbiAgY29uc3QgUFJFRl9LRVlTX01BWCA9IDY0O1xuICAvKipcbiAgICogUmVhZCB0aGUgaG9tZSdzIHByZWZzIEZSRVNILiBTZXZlcmFsIHNlc3Npb25zIGNhbiBzaGFyZSBvbmUgaG9tZSAoRTEzKSwgZWFjaFxuICAgKiBpdHMgb3duIGRhZW1vbiwgc28gYSBjb3B5IGxvYWRlZCBvbmNlIGF0IGJvb3QgYW5kIHdyaXR0ZW4gYmFjayB3aG9sZSB3b3VsZFxuICAgKiBlcmFzZSBhIGtleSBhbm90aGVyIHNlc3Npb24gd3JvdGUgc2luY2UgKHZlcmlmeSBwYXNzKS4gRXZlcnkgd3JpdGUgaXNcbiAgICogdGhlcmVmb3JlIHJlYWQg4oaSIHNldCBvbmUga2V5IOKGkiB3cml0ZSwgYW5kIGV2ZXJ5IHNuYXBzaG90IHJlYWRzIHRoZSBmaWxlLlxuICAgKiBPbmx5IHdlbGwtZm9ybWVkIGVudHJpZXMgc3Vydml2ZSBhIHJlYWQ7IGEgYmFkIGZpbGUgcmVhZHMgYXMgZW1wdHkgYW5kIGlzXG4gICAqIHJlcGxhY2VkIGJ5IHRoZSBuZXh0IHdyaXRlLlxuICAgKi9cbiAgY29uc3QgcmVhZFByZWZzID0gKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwcmVmc0ZpbGUsIFwidXRmOFwiKSkgYXMgdW5rbm93bjtcbiAgICAgIGlmIChyYXcgJiYgdHlwZW9mIHJhdyA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHJhdykpXG4gICAgICAgICAgaWYgKFBSRUZfS0VZLnRlc3QoaykgJiYgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi5sZW5ndGggPD0gUFJFRl9WQUxVRV9NQVgpIG91dFtrXSA9IHY7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBwcmVmcyB5ZXQsIG9yIHVucmVhZGFibGUg4oCUIGVtcHR5ICovXG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH07XG4gIGNvbnN0IHVzZXJIb21lID0gaG9tZWRpcigpO1xuICAvKipcbiAgICogRTUzOiB0aGUgc25vb3plIHRoZSBhZ2VudCBhc2tlZCBmb3IsIGFuZCB0aGUgbWVzc2FnZXMgYWxyZWFkeSBudWRnZWQuXG4gICAqXG4gICAqIOKblCBPTkUgTlVER0UgUEVSIE1FU1NBR0UsIEFORCBUSEFUIElTIFRIRSBXSE9MRSBBTlRJLU5BRyBSVUxFLiBDb2xlOiBcIndlXG4gICAqIGRvbid0IHdhbnQgdG8gaGF2ZSBhIHNpdHVhdGlvbiB3aGVyZSBhbiBhZ2VudCBrZWVwcyBnZXR0aW5nIHBpbmdlZCBhYm91dFxuICAgKiBzb21ldGhpbmcgYW5kIGl0J3MgbGlrZSwgbm8sIEknbSBhY3R1YWxseSB3b3JraW5nLlwiIFNvIGEgbWVzc2FnZSBpZCBlbnRlcnNcbiAgICogYG51ZGdlZGAgdGhlIGZpcnN0IHRpbWUgaXQgaXMgcmVwb3J0ZWQg4oCUIG9yIHRoZSBtb21lbnQgdGhlIGFnZW50IHNub296ZXMgaXRcbiAgICog4oCUIGFuZCBuZXZlciBsZWF2ZXMuIEEgc25vb3plIEVYUElSSU5HIHRoZXJlZm9yZSBjaGFuZ2VzIHdoYXQgdGhlIEhVTUFOXG4gICAqIHNlZXMgKGJhY2sgdG8gXCJtYXkgYmUgc3R1Y2tcIiwgYmVjYXVzZSB0aGV5IGFyZSBvd2VkIHRoZSB0cnV0aCkgd2l0aG91dFxuICAgKiBwaW5naW5nIHRoZSBhZ2VudCBhZ2Fpbi5cbiAgICpcbiAgICog4pqgIElOIE1FTU9SWSwgTk9UIElOIFRIRSBNQU5JRkVTVCwgZGVsaWJlcmF0ZWx5LiBBIHJlc3RvcmVkIHNlc3Npb24gd2hvc2VcbiAgICogaHVtYW4gd2FzIGxlZnQgd2FpdGluZyBTSE9VTEQgdGVsbCB0aGUgYWdlbnQgdGhhdCBhcnJpdmVzIOKAlCB0aGUgd2FpdCBpc1xuICAgKiByZWFsIGFuZCB0aGUgbmV3IGFnZW50IGhhcyBub3QgaGVhcmQgYWJvdXQgaXQuXG4gICAqL1xuICBsZXQgYWNrbm93bGVkZ2VkVW50aWw6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgY29uc3QgbnVkZ2VkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIC8qKlxuICAgKiBFNjA6IHRoZSBDT05URVhUJ3MgdW5kbyBoaXN0b3J5IOKAlCBub3QgdGhlIGVkaXRvcidzLCB3aGljaCBDb2RlTWlycm9yIG93bnMuXG4gICAqIEluIG1lbW9yeSBvbiBwdXJwb3NlIChzZWUgYGhpc3RvcnkudHNgKTogYW4gaW52ZXJzZSBkZXNjcmliZXMgdGhlIHdvcmxkIGFzXG4gICAqIGl0IGlzIG5vdywgYW5kIGEgc2Vzc2lvbiByZXN0b3JlZCB0b21vcnJvdyBtYXkgbWVldCBmaWxlcyBzb21lYm9keSBoYXNcbiAgICogc2luY2UgbW92ZWQgYnkgaGFuZC5cbiAgICovXG4gIGNvbnN0IGhpc3RvcnkgPSBuZXcgSGlzdG9yeSgpO1xuXG4gIGNvbnN0IHZpZXdTdGF0ZSA9ICgpOiBQdWJsaWNTdGF0ZSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IHsgLi4uc2Vzc2lvbi52aWV3KG1vZGUsIGhlbGRTZWxlY3Rpb24oKSksIHByZWZzOiByZWFkUHJlZnMoKSwgdXNlckhvbWUgfTtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIHJldHVybiB7XG4gICAgICAuLi5iYXNlLFxuICAgICAgd2FpdGluZzogd2FpdGluZ09uKGJhc2UuY2hhdCwgbm93LCB7IGFja25vd2xlZGdlZFVudGlsIH0pLFxuICAgICAgbm90ZXNXYWl0aW5nOiBub3Rlc1dhaXRpbmcoc2Vzc2lvbi5ub3RlRmFjdHMoKSwgYmFzZS5jaGF0LCBub3csIHsgYWNrbm93bGVkZ2VkVW50aWwgfSksXG4gICAgICBoaXN0b3J5OiBoaXN0b3J5LnZpZXcoKSxcbiAgICB9O1xuICB9O1xuXG4gIC8vIC0tLSBjaGFubmVscyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8aW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPj4oKTtcbiAgY29uc3QgbG9nID0gY3JlYXRlRXZlbnRMb2c8TG9nRXZlbnQ+KHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfSk7XG4gIGNvbnN0IHNzZUNsaWVudHM6IFNzZUNsaWVudHMgPSBuZXcgU2V0KCk7XG4gIGxldCBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3QgdG91Y2ggPSAoKSA9PiB7XG4gICAgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIH07XG5cbiAgY29uc3Qgc2VuZCA9IChtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIGNvbnN0IHMgPSBKU09OLnN0cmluZ2lmeShtc2cpO1xuICAgIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3Muc2VuZChzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBzb2NrZXQgY2xvc2VkICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHNlbmQoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KTtcblxuICAvKipcbiAgICogQSBzeXN0ZW0gbGluZSBpbiB0aGUgY2hhdCDigJQgYW5kLCBiZWNhdXNlIHRoZSBhZ2VudCBtdXN0IGtub3cgaXQgdG9vLCBvbiB0aGUgdGFpbC5cbiAgICpcbiAgICogYGZvckh1bWFuYCwgd2hlbiBnaXZlbiwgaXMgdGhlIGNoYXQncyBsaW5lIGFuZCBgdGV4dGAgc3RheXMgdGhlIGFnZW50J3NcbiAgICogKHRoZSB0YWlsIGV2ZW50KS4gRm9yIGEgZmFjdCB3aG9zZSBhZ2VudCB0ZXh0IGlzIGluc3RydWN0aW9ucyAoXCJEbyBOT1RcbiAgICogY3JlYXRlIGFub3RoZXIgdmVyc2lvbuKAplwiKSBvciBjYXJyaWVzIGEgbG9uZyBwYXRoOiB0aGUgaHVtYW4gd2FzIHNob3duXG4gICAqIHRoZSBhZ2VudCdzIG9yZGVycywgYW5kIHRoZSBwYXRoIG92ZXJmbG93ZWQgdGhlIGNoYXQgY29sdW1uICh2ZXJpZmllcixcbiAgICogMjAyNi0xMC0wMSkuIFRoZSBzYW1lIHNwbGl0IGBzYXZlYCBhbHJlYWR5IG1ha2VzIOKAlCBhIHNob3J0IGNoYXQgbGluZSwgYVxuICAgKiBzdHJ1Y3R1cmVkIGV2ZW50LlxuICAgKi9cbiAgY29uc3QgYW5ub3VuY2UgPSAodGV4dDogc3RyaW5nLCBmYWN0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9LCBmb3JIdW1hbj86IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgZm9ySHVtYW4gPz8gdGV4dCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcInN5c3RlbVwiLCB0ZXh0LCB0czogbS50cywgLi4uZmFjdCB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICB9O1xuXG4gIC8vIC0tLSB0aGUgd2F0Y2hlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDimqAgREVWSUFUSU9OIEZST00gVEhFIEJSSUVGLCBXSVRIIElUUyBSRUFTT046IGBub2RlOmZzYCBgd2F0Y2hgIChCdW4nc1xuICAvLyBidWlsdC1pbiksIE5PVCBgQHBhcmNlbC93YXRjaGVyYC4gYEBwYXJjZWwvd2F0Y2hlcmAgaXMgYSBuYXRpdmUgYWRkb24gd2hvc2VcbiAgLy8gbG9hZGVyIGRvZXMgYSBydW50aW1lIGByZXF1aXJlKClgIG9mIGEgcGVyLXBsYXRmb3JtIHBhY2thZ2U7IGJ1bmRsZWQgaW50b1xuICAvLyBgZGlzdC9zZXJ2ZXIuanNgIGl0IGlzIG5vdCBpbmxpbmVkLCBzbyB0aGUgc2hpcHBlZCBkYWVtb24gd291bGQgbmVlZCBhXG4gIC8vIGBub2RlX21vZHVsZXNgIHRoZSBtYXJrZXRwbGFjZSBuZXZlciBjb3BpZXMgKGltcG9ydC1ib3VuZGFyeSB3YXJkIDFiJ3NcbiAgLy8gXCJ0aGUgc2hpcHBlZCBleGVjdXRpb24gcGF0aCBjYXJyaWVzIG5vIGRlcGVuZGVuY2llc1wiKS4gTWVhc3VyZWQgdW5kZXIgQnVuXG4gIC8vIDEuNC4wIG9uIG1hY09TIGJlZm9yZSBjaG9vc2luZzogYSByZWN1cnNpdmUgZGlyZWN0b3J5IHdhdGNoIHJlcG9ydHMgYW5cbiAgLy8gaW4tcGxhY2Ugd3JpdGUsIGFuIGF0b21pYyB0bXArcmVuYW1lIHNhdmUsIGFuZCBib3RoIGFnYWluIGluIGFcbiAgLy8gc3ViZGlyZWN0b3J5IOKAlCB0aGUgZm91ciBjYXNlcyBpbnZlc3RpZ2F0aW9uIMKnNSBkcm92ZSBAcGFyY2VsL3dhdGNoZXIgb24uXG4gIC8vIFRoZSBoYXNoLWNvbXBhcmUgYW5kIHNlbGYtd3JpdGUgc3VwcHJlc3Npb24gYXJlIHVuY2hhbmdlZCAoc2Vzc2lvbi50cykuXG4gIGNvbnN0IHdhdGNoZXJzID0gbmV3IE1hcDxzdHJpbmcsIEZTV2F0Y2hlcj4oKTtcbiAgY29uc3QgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pj4oKTtcbiAgY29uc3Qgb25GcyA9IChhYnM6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHQgPSBwZW5kaW5nLmdldChhYnMpO1xuICAgIGlmICh0KSBjbGVhclRpbWVvdXQodCk7XG4gICAgcGVuZGluZy5zZXQoXG4gICAgICBhYnMsXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcGVuZGluZy5kZWxldGUoYWJzKTtcbiAgICAgICAgbGV0IGV2OiBGaWxlRXZlbnQgfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBldiA9IHNlc3Npb24ub25GaWxlRXZlbnQoYWJzKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogd2F0Y2hlcjogJHtlfVxcbmApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldikgaGFuZGxlRmlsZUV2ZW50KGV2KTtcbiAgICAgIH0sIFdBVENIX1NFVFRMRV9NUyksXG4gICAgKTtcbiAgfTtcbiAgY29uc3Qgc3luY1dhdGNoZXJzID0gKCkgPT4ge1xuICAgIGNvbnN0IHdhbnQgPSBuZXcgTWFwKFxuICAgICAgc2Vzc2lvbi53YXRjaFJvb3RzKCkubWFwKChyKSA9PiBbYCR7ci5yZWN1cnNpdmUgPyBcIlJcIiA6IFwiRlwifToke3Iud2F0Y2h9PiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBXYXRjaGVkIGF0IHRoZSBSRUFMUEFUSCwgcmVwb3J0ZWQgdW5kZXIgdGhlIHN0b3JlZCBwYXRoIGZvcm1cbiAgICAgICAgLy8gKHZlcmlmeS1wYXNzIGZpeCAzIOKAlCBzZWUgU2Vzc2lvbi53YXRjaFJvb3RzKS5cbiAgICAgICAgY29uc3QgdyA9IHdhdGNoKHIud2F0Y2gsIHsgcmVjdXJzaXZlOiByLnJlY3Vyc2l2ZSB9LCAoX2V2ZW50LCBuYW1lKSA9PiB7XG4gICAgICAgICAgaWYgKG5hbWUpIG9uRnMoam9pbihyLnBhdGgsIG5hbWUudG9TdHJpbmcoKSkpO1xuICAgICAgICAgIGVsc2UgaWYgKHIuZW50cnlJZCkgb25GcyhyLnBhdGgpO1xuICAgICAgICB9KTtcbiAgICAgICAgdy5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICAgICAgICAvKiB0aGUgZGlyZWN0b3J5IHdlbnQgYXdheTsgdGhlIG5leHQgc3luYyBkcm9wcyBpdCAqL1xuICAgICAgICB9KTtcbiAgICAgICAgd2F0Y2hlcnMuc2V0KGtleSwgdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW53YXRjaGFibGUgKGdvbmUsIHBlcm1pc3Npb25zKSDigJQgb3V0c2lkZSBjaGFuZ2VzIHRoZXJlIGdvIHVuc2VlbiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVGaWxlRXZlbnQgPSAoZXY6IEZpbGVFdmVudCkgPT4ge1xuICAgIHN3aXRjaCAoZXYua2luZCkge1xuICAgICAgY2FzZSBcInZlcnNpb24uY2hhbmdlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidmVyc2lvbi5jcmVhdGVkXCI6XG4gICAgICAgIGFubm91bmNlKGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gYXBwZWFyZWQgKHdyaXR0ZW4gZGlyZWN0bHkgdG8gJHtldi5wYXRofSlgLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImFjdGl2ZS5vdXRzaWRlXCI6XG4gICAgICAgIC8vIEUyOiB0aGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSB2ZXJzaW9uIHRoZSBodW1hbiBpcyBlZGl0aW5nLiBUaGVcbiAgICAgICAgLy8gb3V0c2lkZSB0ZXh0IGlzIEtFUFQgYXMgYSBuZXcgYWdlbnQgdmVyc2lvbiBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uXG4gICAgICAgIC8vIGtlZXBzIHRoZSBodW1hbidzIHRleHQg4oCUIG5vdGhpbmcgaXMgbG9zdCwgYW5kIHRoZSBodW1hbidzIGJ1ZmZlciBpc1xuICAgICAgICAvLyBub3QgdG91Y2hlZCAodmVyaWZ5LXBhc3MgZml4IDQpLlxuICAgICAgICBhbm5vdW5jZU91dHNpZGUoXG4gICAgICAgICAgZXYuZG9jLFxuICAgICAgICAgIGV2LnZlcnNpb24sXG4gICAgICAgICAgZXYucGF0aCxcbiAgICAgICAgICBldi5wcmVzZXJ2ZWRBcyxcbiAgICAgICAgICBldi5wcmVzZXJ2ZWRQYXRoLFxuICAgICAgICAgIGV2LmFjdGl2YXRlZEJlZm9yZVdyaXR0ZW4sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5yZWxvYWRlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIOKAlCByZWxvYWRlZCAoeW91IGhhZCBubyB1bnNhdmVkIGVkaXRzKS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLmNvbmZsaWN0XCI6XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgeW91IGhhdmUgdW5zYXZlZCBlZGl0cy4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggeW91cnM7IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBldi5kb2MgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInRyZWVcIjpcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhbm5vdW5jZU91dHNpZGUgPSAoXG4gICAgZG9jOiBzdHJpbmcsXG4gICAgdmVyc2lvbjogbnVtYmVyLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBwcmVzZXJ2ZWRBczogbnVtYmVyLFxuICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZyxcbiAgICBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuOiBib29sZWFuLFxuICApID0+XG4gICAgYW5ub3VuY2UoXG4gICAgICAvLyAjMTE3OiB0aGUgaHVtYW4gYWN0aXZhdGVkIHRoZSBhZ2VudCdzIGB2ZXJzaW9uLW5ld2AgY29weSBiZWZvcmUgdGhlXG4gICAgICAvLyBhZ2VudCBoYWQgd3JpdHRlbiBpdC4gVGhlIGFnZW50IGZvbGxvd2VkIHRoZSBydWxlOyB0aGUgdGltaW5nIGJyb2tlXG4gICAgICAvLyBpdC4gU2F5IHRoYXQsIGFuZCBuYW1lIHRoZSBhY3Qg4oCUIGl0cyB0ZXh0IGlzIGFscmVhZHkgc2FmZSwgc28gYW5vdGhlclxuICAgICAgLy8gdmVyc2lvbiB3b3VsZCBvbmx5IGFkZCBhIGR1cGxpY2F0ZS4gQWdlbnRzIHJvdXRlIG9uIHRoZSBzdHJ1Y3R1cmVkXG4gICAgICAvLyBgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbmAsIG5ldmVyIG9uIHRoaXMgdGV4dC5cbiAgICAgIGFjdGl2YXRlZEJlZm9yZVdyaXR0ZW5cbiAgICAgICAgPyBgVGhlIGh1bWFuIGFjdGl2YXRlZCB2JHt2ZXJzaW9ufSBvZiAke2RvY30gYmVmb3JlIHlvdSBoYWQgd3JpdHRlbiBpdCwgc28geW91ciB3cml0ZSBsYW5kZWQgb24gdGhlIEFDVElWRSB2ZXJzaW9uLiBOb3RoaW5nIGlzIGxvc3Q6IHlvdXIgdGV4dCBpcyBrZXB0IGFzIHYke3ByZXNlcnZlZEFzfSAoJHtwcmVzZXJ2ZWRQYXRofSk7IHYke3ZlcnNpb259IGtlZXBzIGl0cyBvd24gdGV4dC4gRG8gTk9UIGNyZWF0ZSBhbm90aGVyIHZlcnNpb24g4oCUIHNheSBpbiB0aGUgY2hhdCB0aGF0IHYke3ByZXNlcnZlZEFzfSBpcyB5b3VyIGRyYWZ0IGFuZCBsZXQgdGhlIGh1bWFuIGFjdGl2YXRlIGl0LiBOZXh0IHRpbWUsIHByb3Bvc2UgYSB2ZXJzaW9uIGluIG9uZSBzdGVwIHdpdGggdmVyc2lvbi1uZXcgLS1ib2R5LWZpbGUuYFxuICAgICAgICA6IGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7XG4gICAgICAgIGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIixcbiAgICAgICAgZG9jLFxuICAgICAgICB2ZXJzaW9uLFxuICAgICAgICBwYXRoLFxuICAgICAgICBwcmVzZXJ2ZWRBcyxcbiAgICAgICAgcHJlc2VydmVkUGF0aCxcbiAgICAgICAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbixcbiAgICAgIH0sXG4gICAgICAvLyBUaGUgaHVtYW4ncyBvd24gbGluZTogd2hhdCBoYXBwZW5lZCB0byB0aGVpciB2ZXJzaW9uLCBubyBwYXRoLCBub1xuICAgICAgLy8gaW5zdHJ1Y3Rpb25zIG1lYW50IGZvciB0aGUgYWdlbnQuIEl0IG5hbWVzIHRoZSBkb2N1bWVudCBieSB0aGUgbmFtZVxuICAgICAgLy8gdGhlIGh1bWFuIHNlZXMgb24gaXRzIHRhYiDigJQgdHdvIGRvY3VtZW50cyBpbiBvbmUgY29udmVyc2F0aW9uIG11c3Qgbm90XG4gICAgICAvLyByZWFkIHRoZSBzYW1lIChzZWNvbmQgdmVyaWZpZXIsIDIwMjYtMTAtMDEpLlxuICAgICAgaHVtYW5PdXRzaWRlTGluZShzZXNzaW9uLmRvYyhkb2MpLm5hbWUsIHZlcnNpb24sIHByZXNlcnZlZEFzLCBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuKSxcbiAgICApO1xuXG4gIC8vIC0tLSBzaGFyZWQgYWN0cyAoc3VyZmFjZSBhbmQgYWdlbnQgcmVhY2ggdGhlIHNhbWUgY29kZSkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IGFkZFBhdGhzID0gKHBhdGhzOiBzdHJpbmdbXSkgPT4ge1xuICAgIGNvbnN0IGFkZGVkID0gcGF0aHMubWFwKChwKSA9PiBzZXNzaW9uLmFkZENvbnRleHQocCkpO1xuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIGFkZGVkO1xuICB9O1xuXG4gIGNvbnN0IGFjdGl2YXRlID0gKGRvYzogc3RyaW5nIHwgdW5kZWZpbmVkLCB2ZXJzaW9uOiBudW1iZXIsIGJ5OiBcImh1bWFuXCIgfCBcImFnZW50XCIpID0+IHtcbiAgICBjb25zdCByID0gc2Vzc2lvbi5hY3RpdmF0ZSh7IGRvYywgdmVyc2lvbiwgYnkgfSk7XG4gICAgY29uc3QgdmlldyA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgY29uc3QgcGF0aCA9IHZpZXcudmVyc2lvbnMuZmluZCgodikgPT4gdi5uID09PSB2ZXJzaW9uKT8ucGF0aCA/PyBudWxsO1xuICAgIHNlbmQoe1xuICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgIGRvYzogci5zbHVnLFxuICAgICAgdmVyc2lvbixcbiAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCB2ZXJzaW9uKS50ZXh0LFxuICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgXCJzeXN0ZW1cIixcbiAgICAgIGAke2J5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwifSBtYWRlIHYke3ZlcnNpb259IG9mICR7ci5zbHVnfSBhY3RpdmUgKHdhcyB2JHtyLnByZXZpb3VzfSkuYCxcbiAgICApO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJhY3RpdmF0ZWRcIiwgYnksIGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCwgdHM6IG0udHMgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGggfTtcbiAgfTtcblxuICAvKipcbiAgICogRTI0OiBvbmUgc3RydWN0dXJlIGNoYW5nZSwgZnJvbSBlaXRoZXIgcGFydHkg4oCUIHRoZSBzYW1lIHNlc3Npb24gbWV0aG9kLCB0aGVcbiAgICogc2FtZSBhbm5vdW5jZW1lbnQgKG5hbWluZyB3aG8gZGlkIGl0KSwgdGhlIHNhbWUgdGFpbCBmYWN0LiBSZXR1cm5zIHRoZSBwYXRoXG4gICAqIHRoZSBjaGFuZ2UgbGFuZGVkIGF0LCB3aGljaCB0aGUgc3VyZmFjZSB1c2VzIHRvIG9wZW4gb3IgcmVuYW1lIGl0LlxuICAgKi9cbiAgY29uc3QgU1RSVUNUVVJFX09QUyA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gICAgXCJkb2MuY3JlYXRlXCIsXG4gICAgXCJmb2xkZXIuY3JlYXRlXCIsXG4gICAgXCJtb3ZlXCIsXG4gICAgXCJyZW5hbWVcIixcbiAgICBcImhpZGVcIixcbiAgICBcInVuaGlkZVwiLFxuICAgIFwic2V0Lm1ha2VcIixcbiAgICBcImltcG9ydFwiLFxuICAgIFwid29ya3NwYWNlLnNldFwiLFxuICBdIHNhdGlzZmllcyBTdHJ1Y3R1cmVPcFtcInR5cGVcIl1bXSk7XG4gIGNvbnN0IGlzU3RydWN0dXJlT3AgPSAobTogeyB0eXBlOiBzdHJpbmcgfSk6IG0gaXMgU3RydWN0dXJlT3AgPT4gU1RSVUNUVVJFX09QUy5oYXMobS50eXBlKTtcblxuICBjb25zdCBzdHJ1Y3R1cmUgPSAob3A6IFN0cnVjdHVyZU9wLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IHdobyA9IGJ5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwiO1xuICAgIC8vIOKblCBDQVBUVVJFRCBCRUZPUkUgVEhFIEFDVCwgYmVjYXVzZSBldmVyeSBmaWVsZCBoZXJlIGlzIHNvbWV0aGluZyB0aGUgYWN0XG4gICAgLy8gQ0hBTkdFUzogcmVhZGluZyBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IGFmdGVyd2FyZHMgcmV0dXJucyB0aGUgbGlzdFxuICAgIC8vIGluY2x1ZGluZyB3aGF0IHdhcyBqdXN0IGhpZGRlbiwgd2hpY2ggcmVzdG9yZXMgbm90aGluZyAoRTYwKS5cbiAgICBjb25zdCBiZWZvcmU6IEJlZm9yZSA9IHtcbiAgICAgIC4uLihvcC50eXBlID09PSBcImhpZGVcIiA/IHsgaGlkZGVuOiBzZXNzaW9uLmhpZGRlbkJlZm9yZShvcC5wYXRoKSA/PyB1bmRlZmluZWQgfSA6IHt9KSxcbiAgICAgIC4uLihvcC50eXBlID09PSBcInVuaGlkZVwiID8geyBoaWRkZW46IHNlc3Npb24uaGlkZGVuT2ZFbnRyeShvcC5lbnRyeSkgPz8gdW5kZWZpbmVkIH0gOiB7fSksXG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJ3b3Jrc3BhY2Uuc2V0XCIgPyB7IHdvcmtzcGFjZTogc2Vzc2lvbi53b3Jrc3BhY2UgfSA6IHt9KSxcbiAgICB9O1xuICAgIGNvbnN0IHNob3duID0gKHA6IHN0cmluZykgPT4gc2Vzc2lvbi5kaXNwbGF5KHApO1xuICAgIGxldCByOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgcGF0aD86IHN0cmluZyB9O1xuICAgIGxldCBsaW5lOiBzdHJpbmc7XG4gICAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVEb2Mob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZUZvbGRlcihvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkIHRoZSBmb2xkZXIgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUob3AucGF0aCwgb3AuaW50byk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBtb3ZlZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKG9wLnBhdGgsIG9wLm5hbWUpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVuYW1lZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IGggPSBzZXNzaW9uLmhpZGUob3AucGF0aCk7XG4gICAgICAgIHIgPSBoO1xuICAgICAgICAvLyDimqAgVEhFIFBBUkVOVEhFVElDQUwgSEFTIFRPIEJFIFRSVUUuIEl0IHNhaWQgXCIodGhlIGZpbGUgaXMgc3RpbGwgb25cbiAgICAgICAgLy8gZGlzaylcIiB1bmNvbmRpdGlvbmFsbHksIHdoaWNoIGlzIHdyb25nIHR3aWNlIG92ZXIgb24gYSBHSE9TVCDigJQgYW5cbiAgICAgICAgLy8gZW50cnkgd2hvc2UgZmlsZSBpcyBhbHJlYWR5IGdvbmUg4oCUIGFuZCBjYWxscyBhIGZvbGRlciBhIGZpbGUuIENvbGVcbiAgICAgICAgLy8gbWV0IGJvdGggaW4gb25lIGdvIHdoaWxlIGNsZWFyaW5nIHJlc2lkdWUgZnJvbSB0aGUgRTYwIGJ1ZywgYW5kIGFcbiAgICAgICAgLy8gcmVhc3N1cmFuY2UgdGhhdCBpcyBmYWxzZSBpcyB3b3JzZSB0aGFuIG5vIHJlYXNzdXJhbmNlOiBpdCBpcyB0aGVcbiAgICAgICAgLy8gc2FtZSBkZWZlY3QgYXMgdGhlIGNvbmZsaWN0IGJhbm5lciBjbGFpbWluZyBlZGl0cyBoZSBoYWQgbm90IG1hZGUuXG4gICAgICAgIGNvbnN0IGdvbmUgPSAhZXhpc3RzU3luYyhoLnBhdGgpO1xuICAgICAgICBjb25zdCBraW5kID0gZ29uZSA/IFwiXCIgOiBzdGF0U3luYyhoLnBhdGgpLmlzRGlyZWN0b3J5KCkgPyBcImZvbGRlclwiIDogXCJmaWxlXCI7XG4gICAgICAgIGxpbmUgPSBnb25lXG4gICAgICAgICAgPyBgJHt3aG99IHJlbW92ZWQgJHtzaG93bihoLnBhdGgpfSBmcm9tIFNjcmlwdG9yaXVtIChpdCB3YXMgYWxyZWFkeSBnb25lIGZyb20gZGlzaykuYFxuICAgICAgICAgIDogYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAodGhlICR7a2luZH0gaXMgc3RpbGwgb24gZGlzaykuYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgICAgY29uc3QgdSA9IHNlc3Npb24udW5oaWRlKG9wLmVudHJ5KTtcbiAgICAgICAgciA9IHU7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGJyb3VnaHQgYmFjayAke3UucmVzdG9yZWR9IGhpZGRlbiBpdGVtJHt1LnJlc3RvcmVkID09PSAxID8gXCJcIiA6IFwic1wifS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZXQubWFrZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1ha2VTZXQob3AucGF0aCk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSB0dXJuZWQgJHtiYXNlbmFtZShtLnBhdGgpfSBpbnRvIGEgc2V0OiAke3Nob3duKG0uZm9sZGVyKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmltcG9ydFRleHQob3AubmFtZSwgb3AudGV4dCwgb3AuaW50byk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNvcGllZCAke29wLm5hbWV9IGluIGFzICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uc2V0V29ya3NwYWNlKG9wLnBhdGgpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBzZXQgdGhlIHdvcmtzcGFjZSB0byAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgLy8gVGhlIHdheSBiYWNrLCBwbGFubmVkIG5vdyBhbmQgZnJvbSB3aGF0IHdhcyB0cnVlIG5vdy5cbiAgICBoaXN0b3J5LmRpZChwbGFuSW52ZXJzZShvcCwgciBhcyBBZnRlciwgYmVmb3JlKSk7XG4gICAgYW5ub3VuY2UobGluZSwgeyBmYWN0OiBvcC50eXBlLCBieSwgLi4uciB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiByO1xuICB9O1xuXG4gIC8qKlxuICAgKiBBcHBseSBvbmUgcmVjb3JkZWQgaW52ZXJzZSwgYW5kIHJldHVybiB0aGUgYWN0IHRoYXQgd291bGQgcmV2ZXJzZSBUSEFUIOKAlFxuICAgKiB3aGljaCBpcyB3aGF0IGdvZXMgb250byB0aGUgb3RoZXIgc3RhY2suXG4gICAqXG4gICAqIOKblCBBIERFTEVURSBIQVMgTk8gV0FZIEJBQ0ssIGFuZCBzYXlzIHNvIGJ5IHJldHVybmluZyBudWxsLiBPbmNlIGEgY3JlYXRlZFxuICAgKiBmaWxlIGlzIGdvbmUgaXRzIGNvbnRlbnRzIGFyZSBnb25lIHdpdGggaXQsIHNvIGEgcmVkbyB0aGF0IFwicmUtY3JlYXRlc1wiIGl0XG4gICAqIHdvdWxkIGhhbmQgYmFjayBhbiBlbXB0eSBmaWxlIHdlYXJpbmcgdGhlIHNhbWUgbmFtZSDigJQgdGhlIGtpbmQgb2YgbGllIGFuXG4gICAqIHVuZG8gc3RhY2sgbXVzdCBub3QgdGVsbC4gQ29uZmlybWVkIGRlbGV0aW9ucyBhcmUgdGhlcmVmb3JlIG9uZS13YXksIHdoaWNoXG4gICAqIGlzIGFsc28gd2h5IHRoZXkgYXJlIGNvbmZpcm1lZC5cbiAgICovXG4gIGNvbnN0IGFwcGx5SW52ZXJzZSA9IChpbnY6IEludmVyc2UpOiBBY3QgfCBudWxsID0+IHtcbiAgICBzd2l0Y2ggKGludi5raW5kKSB7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUoaW52LnBhdGgsIGludi5pbnRvKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYG1vdmVkICR7YmFzZW5hbWUobS5mcm9tKX0gYmFjayBpbnRvICR7YmFzZW5hbWUoZGlybmFtZShtLnBhdGgpKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJtb3ZlXCIsIHBhdGg6IG0ucGF0aCwgaW50bzogZGlybmFtZShtLmZyb20pIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKGludi5wYXRoLCBpbnYubmFtZSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGByZW5hbWVkICR7YmFzZW5hbWUobS5mcm9tKX0gYmFjayB0byAke2Jhc2VuYW1lKG0ucGF0aCl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwicmVuYW1lXCIsIHBhdGg6IG0ucGF0aCwgbmFtZTogYmFzZW5hbWUobS5mcm9tKSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGRlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc3RvcmVIaWRkZW4oaW52LmVudHJ5LCBpbnYucmVscyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IHIud2FzLmxlbmd0aCA+IGludi5yZWxzLmxlbmd0aCA/IFwiYnJvdWdodCBpdGVtcyBiYWNrXCIgOiBcImhpZCBpdGVtcyBhZ2FpblwiLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IHIuZW50cnksIHJlbHM6IHIud2FzIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCB7IGVudHJ5IH0gPSBzZXNzaW9uLmFkZENvbnRleHQoaW52LnBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcHV0ICR7YmFzZW5hbWUoaW52LnBhdGgpfSBiYWNrIGluIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5yZW1vdmVcIiwgZW50cnk6IGVudHJ5LmlkIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gc2Vzc2lvbi5lbnRyeVJvb3QoaW52LmVudHJ5KTtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KGludi5lbnRyeSk7XG4gICAgICAgIHJldHVybiBwYXRoID09PSBudWxsXG4gICAgICAgICAgPyBudWxsXG4gICAgICAgICAgOiB7XG4gICAgICAgICAgICAgIGxhYmVsOiBgdG9vayAke2Jhc2VuYW1lKHBhdGgpfSBiYWNrIG91dCBvZiB0aGUgY29udGV4dGAsXG4gICAgICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJjb250ZXh0LmFkZFwiLCBwYXRoIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtzcGFjZVwiOiB7XG4gICAgICAgIGNvbnN0IHdhcyA9IHNlc3Npb24ud29ya3NwYWNlO1xuICAgICAgICBzZXNzaW9uLnNldFdvcmtzcGFjZShpbnYucGF0aCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBzZXQgdGhlIHdvcmtzcGFjZSBiYWNrIHRvICR7YmFzZW5hbWUoaW52LnBhdGgpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIndvcmtzcGFjZVwiLCBwYXRoOiB3YXMgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkZWxldGVcIjoge1xuICAgICAgICBzZXNzaW9uLnJlbW92ZUNyZWF0ZWQoaW52LnBhdGgsIGludi5kaXIpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChtc2cpKSB7XG4gICAgICBjb25zdCByID0gc3RydWN0dXJlKGFuY2hvclN1cmZhY2VQYXRocyhtc2cpLCBcImh1bWFuXCIpO1xuICAgICAgaWYgKHR5cGVvZiByLnBhdGggPT09IFwic3RyaW5nXCIpXG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwic3RydWN0dXJlLmRvbmVcIiwgb3A6IG1zZy50eXBlLCBwYXRoOiByLnBhdGggfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJvcGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ub3BlblBhdGgobXNnLnBhdGgpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgLy8gVGhlIG9wZW5lciBnZXRzIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgc3RyYWlnaHQgYXdheSDigJQgdGhlIHN0YXRlXG4gICAgICAgIC8vIHNuYXBzaG90IGNhcnJpZXMgbm8gdGV4dHMsIGFuZCBhIHZpZXdlciBtdXN0IG5vdCB3YWl0IG9uIGEgc2Vjb25kIGFzay5cbiAgICAgICAge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHIuY3JlYXRlZClcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jLm9wZW5lZFwiLCBkb2M6IHIuc2x1ZywgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHIuc2x1ZykgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJvcGVuLmRvY1wiOlxuICAgICAgICBzZXNzaW9uLm9wZW5TbHVnKG1zZy5kb2MpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXQobXNnLmRvYywgbXNnLnZlcnNpb24sIG1zZy50ZXh0KTtcbiAgICAgICAgaWYgKHIucHJlc2VydmVkKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKG1zZy5kb2MpO1xuICAgICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICAgIGQuc2x1ZyxcbiAgICAgICAgICAgIG1zZy52ZXJzaW9uLFxuICAgICAgICAgICAgc2Vzc2lvbi5hY3RpdmVQYXRoKGQuc2x1ZykgPz8gXCJcIixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLm4sXG4gICAgICAgICAgICByLnByZXNlcnZlZC5wYXRoLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQuYWN0aXZhdGVkQmVmb3JlV3JpdHRlbixcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHIuZGlydHlDaGFuZ2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6IHtcbiAgICAgICAgLy8g4puUIFJFUExJRUQgVE8gVEhFIEFTS0lORyBTT0NLRVQsIE5PVCBCUk9BRENBU1QuIEEgc2VhcmNoIGlzIG9uZVxuICAgICAgICAvLyB2aWV3ZXIncyBxdWVzdGlvbjsgcHVzaGluZyByZXN1bHRzIHRvIGV2ZXJ5IGNsaWVudCB3b3VsZCBwdXQgc29tZW9uZVxuICAgICAgICAvLyBlbHNlJ3MgcXVlcnkgaW4geW91ciBwYW5lLiAoVGhlIHNhbWUgcmVhc29uIGBkaWZmYCByZXBsaWVzIHJhdGhlclxuICAgICAgICAvLyB0aGFuIGJyb2FkY2FzdGluZy4pXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzZWFyY2gucmVzdWx0c1wiLCByZXBvcnQ6IHNlc3Npb24uc2VhcmNoQWxsKG1zZykgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlzdG9yeS51bmRvXCI6IHtcbiAgICAgICAgY29uc3QgYWN0ID0gaGlzdG9yeS5wZWVrVW5kbygpO1xuICAgICAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIE5FRURTIFRIRSBIVU1BTidTIFdPUkQsIGNhcnJpZWQgZXhwbGljaXRseS4gQVxuICAgICAgICAvLyBjbGllbnQgdGhhdCBzaW1wbHkgb21pdHMgdGhlIGZsYWcgZ2V0cyBhIHJlZnVzYWwgcmF0aGVyIHRoYW4gYVxuICAgICAgICAvLyBkZWxldGlvbiwgc28gXCJmb3Jnb3QgdG8gY29uZmlybVwiIGNhbiBuZXZlciBiZWNvbWUgXCJkZWxldGVkIGFueXdheVwiLlxuICAgICAgICBpZiAoYWN0LmludmVyc2Uua2luZCA9PT0gXCJkZWxldGVcIiAmJiBtc2cuY29uZmlybURlbGV0ZSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVW5kb2luZyBcIiR7YWN0LmxhYmVsfVwiIHdvdWxkIGRlbGV0ZSAke3Nlc3Npb24uZGlzcGxheShhY3QuaW52ZXJzZS5wYXRoKX0g4oCUIGNvbmZpcm0gaXQgZmlyc3QuYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tVbmRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgdW5kaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS51bmRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIFRoZSByZWZ1c2FsIHRoZSBodW1hbiBuZWVkcyB0byByZWFkIOKAlCBhIGZvbGRlciB3aXRoIHRoaW5ncyBpbiBpdCxcbiAgICAgICAgICAvLyBvciBhIHdvcmxkIHRoYXQgaGFzIG1vdmVkIHVuZGVyIGEgcmVjb3JkZWQgaW52ZXJzZS4gVGhlIGFjdCBTVEFZU1xuICAgICAgICAgIC8vIG9uIHRoZSBzdGFjazogbm90aGluZyBoYXBwZW5lZCwgc28gbm90aGluZyBzaG91bGQgYmUgZm9yZ290dGVuLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnJlZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtSZWRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGlzdG9yeS50b29rUmVkbyhhcHBseUludmVyc2UoYWN0LmludmVyc2UpKTtcbiAgICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgICBhbm5vdW5jZShgWW91IHJlZGlkOiAke2FjdC5sYWJlbH0uYCwgeyBmYWN0OiBcImhpc3RvcnkucmVkb1wiIH0pO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VsZWN0XCI6XG4gICAgICAgIC8vIEFNQklFTlQgc3RhdGU6IHN0b3JlZCBhbmQgc2hvd24sIG5ldmVyIHB1c2hlZCBvbnRvIHRoZSBhZ2VudCdzIHRhaWwuXG4gICAgICAgIC8vIOKblCBPbmUgbmFtaW5nIGEgZG9jdW1lbnQgdGhhdCBpcyBub3Qgb24gc2NyZWVuIGlzIGEgc3RhbGUgZWNobyBmcm9tXG4gICAgICAgIC8vIGJlZm9yZSBhIHN3aXRjaCAoRTY2KSwgYW5kIGlzIG5vdCBoZWxkLlxuICAgICAgICBzZWxlY3Rpb24gPSBzZWxlY3Rpb25PblNjcmVlbihtc2cuc2VsZWN0aW9uLCBzY3JlZW4oKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCB0ZXh0ID0gbXNnLnRleHQudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICAgICAgLy8g4pqgIEEgQkFDS1NUT1AsIEFORCBOTyBURVNUIENBTiBQSU4gSVQgKEU2NikuIEV2ZXJ5IHBhdGggdGhhdCBtb3ZlcyB0aGVcbiAgICAgICAgLy8gb3BlbiBkb2N1bWVudCBvciBpdHMgdmVyc2lvbiBicm9hZGNhc3RzIGZpcnN0LCBhbmQgdGhlIGJyb2FkY2FzdCdzXG4gICAgICAgIC8vIHJlYWQgaGFzIGFscmVhZHkgZHJvcHBlZCBhIHN0YWxlIHNlbGVjdGlvbiDigJQgc28gcmVhZGluZyB0aGUgcmF3XG4gICAgICAgIC8vIGBzZWxlY3Rpb25gIGhlcmUgaXMgdW5yZWFjaGFibGUtd3JvbmcgYnkgY29uc3RydWN0aW9uLiBJdCByZWFkc1xuICAgICAgICAvLyB0aHJvdWdoIHRoZSBydWxlIGFueXdheSwgZm9yIHRoZSBwYXRoIHNvbWVib2R5IGFkZHMgd2l0aG91dCBhXG4gICAgICAgIC8vIGJyb2FkY2FzdC5cbiAgICAgICAgY29uc3Qgc2VsID0gbXNnLndpdGhTZWxlY3Rpb24gPyBoZWxkU2VsZWN0aW9uKCkgOiBudWxsO1xuICAgICAgICBjb25zdCBhY3RpdmVQYXRoID0gc2VsID8gc2Vzc2lvbi5hY3RpdmVQYXRoKHNlbC5kb2MpIDogc2Vzc2lvbi5hY3RpdmVQYXRoKCk7XG4gICAgICAgIC8vIEU2NSdzIFwiQXNrIHRoZSBhZ2VudFwiOiB0aGUgbWVzc2FnZSBjYXJyaWVzIHRoZSBub3RlIGl0IGlzIGFib3V0LCBzb1xuICAgICAgICAvLyB0aGUgYWdlbnQgY2FuIGFjdCBvbiBpdCBhbmQgcmVzb2x2ZSBpdCBieSBpZCByYXRoZXIgdGhhbiBieSBtYXRjaGluZ1xuICAgICAgICAvLyBwcm9zZS4g4puUIE9ORSBBU0sgQVQgQSBUSU1FOiB3aGlsZSBhIG1lc3NhZ2UgYWJvdXQgdGhpcyBub3RlIGlzXG4gICAgICAgIC8vIHVuYW5zd2VyZWQgdGhlIG5vdGUgYWxyZWFkeSBzYXlzIGl0IHdhcyBhc2tlZCwgc28gYSBzZWNvbmQgaXMgYVxuICAgICAgICAvLyBkb3VibGUtY2xpY2ssIG5vdCBhIG5ldyBxdWVzdGlvbiDigJQgZHJvcHBlZCwgYW5kIGRlcml2ZWQgcmF0aGVyIHRoYW5cbiAgICAgICAgLy8gZmxhZ2dlZDogaXQgaXMgdGhlIHNhbWUgZmFjdCB0aGUgbm90ZSdzIG93biBiYWRnZSByZWFkcy5cbiAgICAgICAgbGV0IG5vdGU6IHsgZG9jOiBzdHJpbmc7IGlkOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKG1zZy5ub3RlKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24ubm90ZUZhY3RzKCkuZmluZCgoeCkgPT4geC5zbHVnID09PSBtc2cubm90ZT8uZG9jKTtcbiAgICAgICAgICBpZiAoIWQ/Lm5vdGVzLnNvbWUoKG4pID0+IG4uaWQgPT09IG1zZy5ub3RlPy5pZCkpIHtcbiAgICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYE5vIG5vdGUgJHttc2cubm90ZS5pZH0gb24gJHttc2cubm90ZS5kb2N9LmAgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IG93ZWQgPSBub3Rlc1dhaXRpbmcoc2Vzc2lvbi5ub3RlRmFjdHMoKSwgc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7XG4gICAgICAgICAgICBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAob3dlZC5zb21lKCh3KSA9PiB3LmRvYyA9PT0gbXNnLm5vdGU/LmRvYyAmJiB3Lm5vdGVJZCA9PT0gbXNnLm5vdGUuaWQgJiYgdy5hc2tlZEluKSlcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICBub3RlID0geyBkb2M6IG1zZy5ub3RlLmRvYywgaWQ6IG1zZy5ub3RlLmlkIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHtcbiAgICAgICAgICBzZWxlY3Rpb246IHNlbCxcbiAgICAgICAgICBhY3RpdmVQYXRoLFxuICAgICAgICAgIC4uLihub3RlID8geyBub3RlIH0gOiB7fSksXG4gICAgICAgIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgbWVzc2FnZV9pZDogbS5pZCxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2Yoc2VsPy5kb2MpLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICAgIC4uLihub3RlXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICBub3RlOiBub3RlLmlkLFxuICAgICAgICAgICAgICAgIGRvYzogbm90ZS5kb2MsXG4gICAgICAgICAgICAgICAgaGludDogYGFib3V0IG5vdGUgJHtub3RlLmlkfSDigJQgXFxgbm90ZXMgLS1kb2MgJHtub3RlLmRvY31cXGAgaGFzIGl0IHdob2xlOyBhbnN3ZXIgaGVyZSwgYW5kIFxcYG5vdGUtcmVzb2x2ZSAke25vdGUuaWR9IC0tZG9jICR7bm90ZS5kb2N9XFxgIHdoZW4gaXQgaXMgZGVhbHQgd2l0aGAsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDoge30pLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIGFjdGl2YXRlKG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBcImh1bWFuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwibm90ZS5hZGRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5hZGROb3RlKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgYm9keTogbXNnLmJvZHksXG4gICAgICAgICAgd2hvOiBcImh1bWFuXCIsXG4gICAgICAgICAgcmFuZ2U6IHsgZnJvbTogbXNnLmZyb20sIHRvOiBtc2cudG8gfSxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIEU2NTogdGhlIGV2ZW50IGNhcnJpZXMgdGhlIG5vdGUgaXRzZWxmIHdoZW4gaXQgaXMgc2hvcnQsIGFuZCBuYW1lc1xuICAgICAgICAvLyB0aGUgYWN0IHRoYXQgY2xvc2VzIGl0IOKAlCBhbiBhZ2VudCBzaG91bGQgbm90IGhhdmUgdG8gZ28gYW5kIGFza1xuICAgICAgICAvLyB3aGF0IGp1c3QgYXJyaXZlZCBiZWZvcmUgaXQgY2FuIHN0YXJ0LlxuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgLi4ubm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhtc2cuaWQsIG1zZy5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpIHtcbiAgICAgICAgICBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgYERvbmU6ICR7ci50YXNrLnRleHR9YCk7XG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suZG9uZVwiLCB0YXNrOiByLnRhc2suaWQsIGJ5OiBcImh1bWFuXCIgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVUYXNrKG1zZy5pZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrcy5jbGVhclwiOiB7XG4gICAgICAgIHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBtc2cuZG9jLCBpZDogbXNnLmlkLCBib2R5OiBtc2cuYm9keSwgd2hvOiBcImh1bWFuXCIgfSk7XG4gICAgICAgIC8vIEEgaHVtYW4ncyByZXdyaXRlIGlzIG93ZWQgYW4gYW5zd2VyIGFnYWluIChFNjUpLCBzbyBpdCBzYXlzIHdoYXRcbiAgICAgICAgLy8gdGhlIG5vdGUgbm93IHNheXMsIGV4YWN0bHkgYXMgYG5vdGUuYWRkZWRgIGRvZXMuXG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgLi4ubm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICBpZDogbXNnLmlkLFxuICAgICAgICAgIHJlc29sdmVkOiBtc2cucmVzb2x2ZWQsXG4gICAgICAgICAgd2hvOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogbXNnLnJlc29sdmVkID8gXCJub3RlLnJlc29sdmVkXCIgOiBcIm5vdGUucmVvcGVuZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICAvLyBBIGh1bWFuIHJlb3BlbmluZyBhIG5vdGUgaXMgYXNraW5nIGFnYWluIChFNjUpLCBzbyBpdCBjYXJyaWVzIHdoYXRcbiAgICAgICAgICAvLyBgbm90ZS5hZGRlZGAgY2Fycmllcy5cbiAgICAgICAgICAuLi4obXNnLnJlc29sdmVkXG4gICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICA6IG5vdGVFdmVudEZhY3RzKHIuc2x1Zywgci5ub3RlLCBzZXNzaW9uLm5vdGVMaW5lcyhyLnNsdWcsIHIubm90ZSkpKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLnJlbW92ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogbXNnLmRvYywgdmVyc2lvbjogbXNnLnZlcnNpb24gfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgRGVsZXRlZCB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfSR7ci5sYWJlbCA/IGAg4oCUICR7ci5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5kZWxldGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgLi4uKG1zZy5mcm9tID09PSB1bmRlZmluZWQgPyB7fSA6IHsgZnJvbTogbXNnLmZyb20gfSksXG4gICAgICAgICAgLi4uKG1zZy5sYWJlbCA/IHsgbGFiZWw6IG1zZy5sYWJlbCB9IDoge30pLFxuICAgICAgICAgIGF1dGhvcjogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgLy8g4puUIFNBWSBXSEVSRSBUSEVZIEFSRSwgbm90IGp1c3Qgd2hhdCB3YXMgbWFkZSAoRTQyKS4gVGhlIG9sZCBtZXNzYWdlXG4gICAgICAgIC8vIGFubm91bmNlZCB0aGUgbmV3IHZlcnNpb24gYW5kIHdlbnQgcXVpZXQgYWJvdXQgd2hpY2ggb25lIHRoZSBodW1hblxuICAgICAgICAvLyB3YXMgZWRpdGluZyDigJQgd2hpY2ggaXMgZXhhY3RseSBob3cgc29tZW9uZSB0eXBlcyBpbnRvIHYxIGJlbGlldmluZ1xuICAgICAgICAvLyB0aGV5IGFyZSBpbiB2Mi5cbiAgICAgICAgaWYgKG1zZy5hY3RpdmF0ZSkgc2Vzc2lvbi5hY3RpdmF0ZSh7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBNYWRlIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke21zZy5sYWJlbCA/IGAg4oCUICR7bXNnLmxhYmVsfWAgOiBcIlwifS4gYCArXG4gICAgICAgICAgICAobXNnLmFjdGl2YXRlXG4gICAgICAgICAgICAgID8gYFlvdSBhcmUgbm93IGVkaXRpbmcgdiR7ci52ZXJzaW9uLm59LmBcbiAgICAgICAgICAgICAgOiBgWW91IGFyZSBzdGlsbCBlZGl0aW5nIHYke3IudmVyc2lvbi5mcm9tfS5gKSxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLm4sXG4gICAgICAgICAgZnJvbTogci52ZXJzaW9uLmZyb20sXG4gICAgICAgICAgYWN0aXZhdGVkOiBtc2cuYWN0aXZhdGUgPT09IHRydWUsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uc2F2ZShtc2cuZG9jKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBgU2F2ZWQgdiR7ci52ZXJzaW9ufSB0byAke3Iub3JpZ2luYWx9LmApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJzYXZlZFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgb3JpZ2luYWw6IHIub3JpZ2luYWwsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicmV2ZXJ0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmV2ZXJ0KG1zZy5kb2MpO1xuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgUmV2ZXJ0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke21zZy5kb2N9IHRvIHRoZSBzYXZlZCBmaWxlLmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJyZXZlcnRlZFwiLCBkb2M6IG1zZy5kb2MsIHZlcnNpb246IHIudmVyc2lvbiwgdHM6IG0udHMgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOlxuICAgICAgICBhZGRQYXRocyhbc3VyZmFjZVBhdGgobXNnLnBhdGgpXSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZXZlYWxcIjpcbiAgICAgICAgcmV2ZWFsUGF0aChzZXNzaW9uLnNob3duUGF0aChzdXJmYWNlUGF0aChtc2cucGF0aCkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbC52ZXJzaW9uXCI6XG4gICAgICAgIC8vIFRoZSBkYWVtb24gcmVzb2x2ZXMgaXQsIHNvIHRoZSBzdXJmYWNlIG5ldmVyIG5hbWVzIGEgcGF0aCBvdXRzaWRlXG4gICAgICAgIC8vIHdoYXQgdGhlIHNlc3Npb24gYWxyZWFkeSBvd25zLlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24ucmVhZFZlcnNpb24obXNnLmRvYywgbXNnLnZlcnNpb24pLnBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicGlja1wiOiB7XG4gICAgICAgIHZvaWQgb3BlblBpY2tlcih3cywgbXNnLndhbnQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjpcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KG1zZy5pZCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmVhZFwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogbXNnLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImRpZmZcIjoge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImRpZmZcIiwgLi4uc2Vzc2lvbi5jb21wYXJlKHsgZG9jOiBtc2cuZG9jLCBhZ2FpbnN0OiBtc2cuYWdhaW5zdCB9KSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1lcmdlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWVyZ2UoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LCBodW5rczogbXNnLmh1bmtzIH0pO1xuICAgICAgICAvLyBUaGUgYnVmZmVyIHRoZSBodW1hbiBpcyBsb29raW5nIGF0IG11c3QgYmUgdG9sZDogdGhlIG1lcmdlIHdyb3RlIHRoZVxuICAgICAgICAvLyBhY3RpdmUgdmVyc2lvbidzIEZJTEUsIGFuZCB0aGUgZWRpdG9yJ3MgdGV4dCBpcyBub3cgYmVoaW5kIGl0LlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBUb29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKG1zZy5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lcmdlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBhZ2FpbnN0OiBtc2cuYWdhaW5zdCxcbiAgICAgICAgICBodW5rczogbXNnLmh1bmtzLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2Vzc2lvbi5lbmRcIjpcbiAgICAgICAgLy8g4puUIFRIRSBEQUVNT04gRU5EUyBJVCwgTk9UIFRIRSBBR0VOVCAoQ29sZSwgMjAyNi0xMC0wMSk6IHRoZSBwYWdlXG4gICAgICAgIC8vIGFscmVhZHkgYXNrZWQgdGhlIGh1bWFuIHRvIGNvbmZpcm0sIGFuZCBhIHNlc3Npb24gd2hvc2UgYWdlbnQgaGFzXG4gICAgICAgIC8vIGdvbmUgbXVzdCBzdGlsbCBiZSBhYmxlIHRvIGNsb3NlLiBTYW1lIHRlYXJkb3duIGFzIGBjbG9zZWAuXG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIsIGJ5OiBcImh1bWFuXCIgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJwcmVmcy5zZXRcIjoge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVBSRUZfS0VZLnRlc3QobXNnLmtleSkgfHxcbiAgICAgICAgICB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgbXNnLnZhbHVlLmxlbmd0aCA+IFBSRUZfVkFMVUVfTUFYXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfWApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFByZWZzKCk7XG4gICAgICAgIGlmIChjdXJyZW50W21zZy5rZXldID09PSBtc2cudmFsdWUpIHJldHVybjtcbiAgICAgICAgaWYgKCEobXNnLmtleSBpbiBjdXJyZW50KSAmJiBPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGggPj0gUFJFRl9LRVlTX01BWClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9OiAke1BSRUZfS0VZU19NQVh9IGtleXMgYWxyZWFkeSBrZXB0YCxcbiAgICAgICAgICApO1xuICAgICAgICB3cml0ZUZpbGVBdG9taWMoXG4gICAgICAgICAgcHJlZnNGaWxlLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgLi4uY3VycmVudCwgW21zZy5rZXldOiBtc2cudmFsdWUgfSwgbnVsbCwgMil9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImdyYXBoXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImdyYXBoXCIsIGVudHJ5OiBtc2cuZW50cnksIGdyYXBoOiBzZXNzaW9uLmdyYXBoRm9yKG1zZy5lbnRyeSkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgICAgZW50cnk6IG1zZy5lbnRyeSxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxpbmsub3BlblwiOiB7XG4gICAgICAgIC8vIEUzMzogYSBsaW5rIGluc2lkZSB0aGUgYnVuZGxlIGlzIEZPTExPV0VEOyBvbmUgdGhhdCBlc2NhcGVzIGl0IGlzXG4gICAgICAgIC8vIHJlcG9ydGVkIHNvIHRoZSBzdXJmYWNlIGNhbiBvZmZlciB0byBhZGQgaXQsIG5ldmVyIGFkZGVkIHNpbGVudGx5LlxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTGluayhtc2cuZnJvbSwgbXNnLnRhcmdldCk7XG4gICAgICAgIGlmIChyLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSB7XG4gICAgICAgICAgc2Vzc2lvbi5vcGVuUGF0aChyLnBhdGgpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHNlc3Npb24ub3BlbkRvY1NsdWcgPz8gXCJcIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihkLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwibGluay50YXJnZXRcIixcbiAgICAgICAgICB0YXJnZXQ6IG1zZy50YXJnZXQsXG4gICAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICAgICAgLi4uKHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8ge30gOiB7IHBhdGg6IHIucGF0aCB9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXRhLnN1Z2dlc3RcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnN1Z2dlc3RNZXRhKG1zZy5wYXRoLCBcImh1bWFuXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBibG9jazogci5ibG9jayxcbiAgICAgICAgICAgIC4uLihyLnR5cGUgPyB7IHN1Z2dlc3RlZFR5cGU6IHIudHlwZSB9IDoge30pLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1vdmUucGxhblwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgcGxhbjogc2Vzc2lvbi5tb3ZlUGxhbihzdXJmYWNlUGF0aChtc2cucGF0aCksIHN1cmZhY2VQYXRoKG1zZy5pbnRvKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgbmF0aXZlIHBpY2tlciAob25lIGRpYWxvZyBhdCBhIHRpbWUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvL1xuICAvLyBBIG1vZGFsIGRpYWxvZyBvd25zIHRoZSBodW1hbidzIGF0dGVudGlvbiwgYW5kIGEgc2Vjb25kIG9uZSBiZWhpbmQgdGhlXG4gIC8vIGZpcnN0IGNhbm5vdCBiZSBzZWVuIG9yIGRpc21pc3NlZCDigJQgc28gYSByZXF1ZXN0IHdoaWxlIG9uZSBpcyBvcGVuIGlzXG4gIC8vIHJlZnVzZWQgaW4gd29yZHMgcmF0aGVyIHRoYW4gcXVldWVkLlxuICBsZXQgcGlja2VyT3BlbiA9IGZhbHNlO1xuICBjb25zdCB6ZW5pdHkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBCdW4ud2hpY2goXCJ6ZW5pdHlcIikgOiBudWxsO1xuICBjb25zdCBvcGVuUGlja2VyID0gYXN5bmMgKFxuICAgIHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LFxuICAgIHdhbnQ6IFwiY29udGV4dC1maWxlXCIgfCBcImNvbnRleHQtZm9sZGVyXCIgfCBcIndvcmtzcGFjZVwiLFxuICApID0+IHtcbiAgICBpZiAocGlja2VyT3Blbikge1xuICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBcImEgZmlsZSBwaWNrZXIgaXMgYWxyZWFkeSBvcGVuXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGtpbmQ6IFBpY2tLaW5kID0gd2FudCA9PT0gXCJjb250ZXh0LWZpbGVcIiA/IFwiZmlsZVwiIDogXCJmb2xkZXJcIjtcbiAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgd2FudCA9PT0gXCJ3b3Jrc3BhY2VcIlxuICAgICAgICA/IFwiQ2hvb3NlIHRoZSB3b3Jrc3BhY2UgZm9sZGVyIGZvciBzY3JpcHRvcml1bVwiXG4gICAgICAgIDogd2FudCA9PT0gXCJjb250ZXh0LWZvbGRlclwiXG4gICAgICAgICAgPyBcIkNob29zZSBhIGZvbGRlciB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIlxuICAgICAgICAgIDogXCJDaG9vc2UgZG9jdW1lbnRzIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiO1xuICAgIGNvbnN0IGNtZCA9IHBpY2tlckNvbW1hbmQocHJvY2Vzcy5wbGF0Zm9ybSwga2luZCwgcHJvbXB0LCB6ZW5pdHkpO1xuICAgIGlmICghY21kKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBubyBmaWxlIHBpY2tlciBvbiB0aGlzIHN5c3RlbSAoJHtwcm9jZXNzLnBsYXRmb3JtfSkg4oCUIHR5cGUgdGhlIHBhdGggaW5zdGVhZGAsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcGlja2VyT3BlbiA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oY21kLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIsIHN0ZGluOiBcImlnbm9yZVwiIH0pO1xuICAgICAgY29uc3QgW291dCwgY29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgICB0b3VjaCgpOyAvLyBhIGh1bWFuIHN0b29kIGF0IGEgZGlhbG9nOyB0aGUgc2Vzc2lvbiBpcyBub3QgaWRsZVxuICAgICAgY29uc3QgcGF0aHMgPSBwYXJzZVBpY2tlck91dHB1dChvdXQpO1xuICAgICAgaWYgKHBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBDYW5jZWxsZWQ6IG5vdGhpbmcgY2hvc2VuLCBub3RoaW5nIHNhaWQuIEEgcmVhbCBmYWlsdXJlIGlzIHNhaWQuXG4gICAgICAgIGlmICghd2FzQ2FuY2VsbGVkKGNvZGUsIG91dCkpXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgdGhlIGZpbGUgcGlja2VyIGZhaWxlZCAoZXhpdCAke2NvZGV9KWAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFdoYXQgd2FzIGNob3NlbiBpcyBhZG1pdHRlZCBsaWtlIGFueSBvdGhlciBwYXRoIOKAlCBhIHBpY2tlZCBmaWxlIHRoYXRcbiAgICAgIC8vIHNjcmlwdG9yaXVtIGRvZXMgbm90IG9wZW4gaXMgcmVmdXNlZCBpbiB0aGUgc2lkZWJhcidzIG93biB3b3JkcywgYW5kXG4gICAgICAvLyB0aGF0IHJlZnVzYWwgbXVzdCBub3QgcmVhZCBhcyBcInRoZSBwaWNrZXIgZmFpbGVkXCIuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAod2FudCA9PT0gXCJ3b3Jrc3BhY2VcIilcbiAgICAgICAgICBzdHJ1Y3R1cmUoeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcGF0aHNbMF0gYXMgc3RyaW5nIH0sIFwiaHVtYW5cIik7XG4gICAgICAgIGVsc2UgYWRkUGF0aHMocGF0aHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBjb3VsZCBub3Qgb3BlbiB0aGUgZmlsZSBwaWNrZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcGlja2VyT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmc7IGJ5OiBDbG9zZWRCeSB9KSA9PiB2b2lkO1xuICBjb25zdCBkb25lID0gbmV3IFByb21pc2U8eyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nOyBieTogQ2xvc2VkQnkgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8qKiBTaG93IGEgZmlsZSBpbiB0aGUgcGxhdGZvcm0ncyBmaWxlIG1hbmFnZXIuIEFuIGFyZ3YsIG5ldmVyIGEgc2hlbGwgc3RyaW5nOlxuICAgKiAgdGhlIHBhdGggaXMgZGF0YSwgd2hhdGV2ZXIgaXQgaG9sZHMuICovXG4gIGNvbnN0IHJldmVhbFBhdGggPSAocGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3QgW2NtZCwgLi4uYXJnc10gPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIlxuICAgICAgICA/IFtcIm9wZW5cIiwgXCItUlwiLCBwYXRoXVxuICAgICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICAgID8gW1wiZXhwbG9yZXJcIiwgYC9zZWxlY3QsJHtwYXRofWBdXG4gICAgICAgICAgOiBbXCJ4ZGctb3BlblwiLCBkaXJuYW1lKHBhdGgpXTtcbiAgICBCdW4uc3Bhd24oW2NtZCBhcyBzdHJpbmcsIC4uLmFyZ3NdLCB7IHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0gfSkudW5yZWYoKTtcbiAgfTtcblxuICBjb25zdCBoYW5kbGVBZ2VudENtZCA9IChjbWQ6IEFnZW50Q21kKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGlmIChpc1N0cnVjdHVyZU9wKGNtZCkpIHJldHVybiBzdHJ1Y3R1cmUoY21kLCBcImFnZW50XCIpO1xuICAgIHN3aXRjaCAoY21kLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJtZXRhXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLm1ldGFGb3IoY21kLnBhdGgpO1xuICAgICAgY2FzZSBcImdyYXBoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmdyYXBoRm9yKGNtZC5lbnRyeSkgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNhc2UgXCJkYW5nbGluZ1wiOlxuICAgICAgICByZXR1cm4gc2Vzc2lvbi5kYW5nbGluZ0xpbmtzKGNtZC5lbnRyeSk7XG4gICAgICBjYXNlIFwiZG9jdG9yXCI6IHtcbiAgICAgICAgY29uc3QgbGlzdCA9IHNlc3Npb24uY2hlY2t1cCgpO1xuICAgICAgICByZXR1cm4geyBmaW5kaW5nczogbGlzdCwgY291bnQ6IGxpc3QubGVuZ3RoIH0gYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb3JnZXRcIjoge1xuICAgICAgICBjb25zdCBmID0gc2Vzc2lvbi5mb3JnZXREb2MoY21kLmRvYyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBmb3Jnb3QgJHtmLm5hbWV9IOKAlCBpdHMgZmlsZSB3YXMgZ29uZSwgYW5kICR7Zi52ZXJzaW9ucyA9PT0gMSA/IFwiMSB2ZXJzaW9uXCIgOiBgJHtmLnZlcnNpb25zfSB2ZXJzaW9uc2B9IGluIHRoaXMgc2Vzc2lvbiAke2YudmVyc2lvbnMgPT09IDEgPyBcImlzXCIgOiBcImFyZVwifSBubyBsb25nZXIgcmVhY2hhYmxlLmAsXG4gICAgICAgICAgeyBmYWN0OiBcImRvYy5mb3Jnb3R0ZW5cIiwgZG9jOiBmLnNsdWcsIG9yaWdpbmFsOiBmLm9yaWdpbmFsIH0sXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiBmIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLnNlYXJjaEFsbChjbWQpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjYXNlIFwiYmFja2xpbmtzXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmJhY2tsaW5rcyhjbWQucGF0aCk7XG4gICAgICBjYXNlIFwibWV0YS5pbml0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YUluaXQoY21kLnBhdGgsIHtcbiAgICAgICAgICAuLi4oY21kLm1ldGFUeXBlID8geyB0eXBlOiBjbWQubWV0YVR5cGUgfSA6IHt9KSxcbiAgICAgICAgICBieTogY21kLmJ5ID8/IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBhZGRlZCBmcm9udG1hdHRlciB0byAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgLi4ucixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc2V0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YVNldChjbWQucGF0aCwgY21kLmZpZWxkcyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBzZXQgJHsoci5zZXQgYXMgc3RyaW5nW10pLmpvaW4oXCIsIFwiKX0gb24gJHtzZXNzaW9uLmRpc3BsYXkoU3RyaW5nKHIucGF0aCkpfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXRhLnNldFwiLCBieTogXCJhZ2VudFwiLCAuLi5yIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogY21kLmRvYywgdmVyc2lvbjogY21kLnZlcnNpb24gfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBkZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIHJlbWFpbmluZzogci5yZW1haW5pbmcgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBib2R5OiBjbWQuYm9keSxcbiAgICAgICAgICB3aG86IFwiYWdlbnRcIixcbiAgICAgICAgICBxdW90ZTogY21kLnF1b3RlLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IG5vdGVkIOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnSBvbiAke3Iuc2x1Z30uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5hZGRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgcXVvdGU6IHIubm90ZS5xdW90ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGVzXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubm90ZXNPZih7IGRvYzogY21kLmRvYywgLi4uKGNtZC5hbGwgPyB7IGFsbDogdHJ1ZSB9IDoge30pIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZXM6IHIubm90ZXMgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnJlbW92ZVRhc2soY21kLmlkKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgcmVtb3ZlZDogdHJ1ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2tzLmNsZWFyXCI6IHtcbiAgICAgICAgY29uc3QgY2xlYXJlZCA9IHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgY2xlYXJlZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtpbmdcIjoge1xuICAgICAgICAvLyBFNTMncyBzbm9vemUuIEl0IGRvZXMgTk9UIHBvc3QgdG8gdGhlIGNoYXQ6IGFuIGFnZW50IHNheWluZyBcInN0aWxsXG4gICAgICAgIC8vIHdvcmtpbmdcIiBpbiB0aGUgY29udmVyc2F0aW9uIGlzIGEgcmVwbHksIGFuZCBpdCBjYW4gZG8gdGhhdCB3aXRoXG4gICAgICAgIC8vIGBzYXlgIOKAlCB0aGlzIGlzIHRoZSBxdWlldGVyIHRoaW5nLCBmb3Igd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvXG4gICAgICAgIC8vIHJlcG9ydCB5ZXQgYnV0IHRoZSBhbGFybSBzaG91bGQgc3RvcC5cbiAgICAgICAgY29uc3QgbXMgPSBjbWQuc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8gY21kLnNlY29uZHMgKiAxMDAwIDogREVGQVVMVF9TTk9PWkVfTVM7XG4gICAgICAgIGFja25vd2xlZGdlZFVudGlsID0gRGF0ZS5ub3coKSArIE1hdGgubWF4KDAsIG1zKTtcbiAgICAgICAgLy8gV2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBhY2tub3dsZWRnZWQsIHNvIGl0IG11c3QgbmV2ZXIgYmUgbnVkZ2VkIGFnYWluLlxuICAgICAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICAgICAgaWYgKHcpIG51ZGdlZC5hZGQody5tZXNzYWdlSWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHVudGlsOiBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICAgICAgICBzZWNvbmRzOiBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIG1zKSAvIDEwMDApLFxuICAgICAgICAgIC4uLih3ID8geyB3YWl0aW5nOiB3Lm1lc3NhZ2VJZCB9IDoge30pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhcnRcIjoge1xuICAgICAgICBjb25zdCB0ID0gc2Vzc2lvbi5zdGFydFRhc2soY21kLnRleHQsIFwiYWdlbnRcIik7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLnN0YXJ0ZWRcIiwgdGFzazogdC5pZCwgdGV4dDogdC50ZXh0LCBieTogXCJhZ2VudFwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnN0YXR1c1wiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnNldFRhc2tTdGF0dXMoY21kLmlkLCBjbWQuc3RhdHVzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgc3RhdHVzOiB0LnN0YXR1cyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2soY21kLmlkLCBjbWQub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KVxuICAgICAgICAgIGFubm91bmNlKGBEb25lOiAke3IudGFzay50ZXh0fSR7ci50YXNrLm91dGNvbWUgPyBgIOKAlCAke3IudGFzay5vdXRjb21lfWAgOiBcIlwifWAsIHtcbiAgICAgICAgICAgIGZhY3Q6IFwidGFzay5kb25lXCIsXG4gICAgICAgICAgICB0YXNrOiByLnRhc2suaWQsXG4gICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiByLnRhc2suaWQsIGFscmVhZHk6IHIuYWxyZWFkeSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkLCBib2R5OiBjbWQuYm9keSwgd2hvOiBcImFnZW50XCIgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCByZXdyb3RlIGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLmVkaXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVzb2x2ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc29sdmVOb3RlKHtcbiAgICAgICAgICBkb2M6IGNtZC5kb2MsXG4gICAgICAgICAgaWQ6IGNtZC5pZCxcbiAgICAgICAgICByZXNvbHZlZDogY21kLnJlc29sdmVkLFxuICAgICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50ICR7Y21kLnJlc29sdmVkID8gXCJyZXNvbHZlZFwiIDogXCJyZW9wZW5lZFwifSBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwibm90ZS5yZXNvbHZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQsIHJlc29sdmVkOiByLm5vdGUucmVzb2x2ZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCByZW1vdmVkIGEgbm90ZSBvbiAke3Iuc2x1Z306IOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLnJlbW92ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJkaWZmXCI6IHtcbiAgICAgICAgY29uc3QgcCA9IHNlc3Npb24uY29tcGFyZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QgfSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZG9jOiBwLmRvYyxcbiAgICAgICAgICBhY3RpdmU6IHAuYWN0aXZlLFxuICAgICAgICAgIGFnYWluc3Q6IHAuYWdhaW5zdCxcbiAgICAgICAgICBzYW1lOiBwLmRpZmYuc2FtZSxcbiAgICAgICAgICBjb2Fyc2U6IHAuZGlmZi5jb2Fyc2UsXG4gICAgICAgICAgaHVua3M6IHAuZGlmZi5odW5rcyxcbiAgICAgICAgICB1bmlmaWVkOiB1bmlmaWVkKHAuZGlmZiwge1xuICAgICAgICAgICAgZnJvbTogYHYke3AuYWN0aXZlfWAsXG4gICAgICAgICAgICB0bzogc2lkZU5hbWUocC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhwLmRvYykubmFtZSksXG4gICAgICAgICAgICAuLi4oY21kLmNvbnRleHQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBjb250ZXh0OiBjbWQuY29udGV4dCB9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXJnZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm1lcmdlKHsgZG9jOiBjbWQuZG9jLCBhZ2FpbnN0OiBjbWQuYWdhaW5zdCwgaHVua3M6IGNtZC5odW5rcyB9KTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCB0b29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKGNtZC5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1lcmdlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBodW5rczogY21kLmh1bmtzLCBieTogXCJhZ2VudFwiIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIGFwcGxpZWQ6IHIuYXBwbGllZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZpbmRcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZmluZChjbWQuZmlsdGVyKTtcbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGFkZGVkID0gYWRkUGF0aHMoY21kLnBhdGhzKTtcbiAgICAgICAgcmV0dXJuIHsgZW50cmllczogYWRkZWQubWFwKChhKSA9PiAoeyAuLi5hLmVudHJ5LCBhZGRlZDogYS5hZGRlZCB9KSkgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggNzogdGhlIGFnZW50IG1heSBuYW1lIGEgZG9jIHRoZSBodW1hbiBoYXMgbm90XG4gICAgICAgIC8vIG9wZW5lZCwgYnkgQUJTT0xVVEUgcGF0aCAodGhlIENMSSByZXNvbHZlcyBpdCBhZ2FpbnN0IGl0cyBvd24gY3dkKTtcbiAgICAgICAgLy8gaXQgaXMgb3BlbmVkIGltcGxpY2l0bHkgdW5kZXIgdGhlIHNhbWUgYWRtaXNzaW9uIHJ1bGUgYXMgdGhlXG4gICAgICAgIC8vIHN1cmZhY2UncyBgb3BlbmAg4oCUIGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5IOKAlCB3aXRob3V0XG4gICAgICAgIC8vIG1vdmluZyB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgICAgICBpZiAoY21kLmRvYyAmJiBpc0Fic29sdXRlKGNtZC5kb2MpICYmICFzZXNzaW9uLmZpbmREb2MoY21kLmRvYykpIHtcbiAgICAgICAgICBjb25zdCBvID0gc2Vzc2lvbi5vcGVuUGF0aChjbWQuZG9jLCB7IGZvY3VzOiBmYWxzZSB9KTtcbiAgICAgICAgICBpZiAoby5jcmVhdGVkKVxuICAgICAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgICAgICB0eXBlOiBcImRvYy5vcGVuZWRcIixcbiAgICAgICAgICAgICAgZG9jOiBvLnNsdWcsXG4gICAgICAgICAgICAgIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChvLnNsdWcpLFxuICAgICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gIzExNzogd2l0aCBgdGV4dGAgdGhlIGZpbGUgaXMgd3JpdHRlbiBIRVJFLCBiZWZvcmUgdGhlIGFubm91bmNlXG4gICAgICAgIC8vIGJlbG93IOKAlCB0aGUgdmVyc2lvbiBpcyBuZXZlciBvZmZlcmVkIHRvIHRoZSBodW1hbiB1bndyaXR0ZW4uXG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBmcm9tOiBjbWQuZnJvbSxcbiAgICAgICAgICBsYWJlbDogY21kLmxhYmVsLFxuICAgICAgICAgIC4uLih0eXBlb2YgY21kLnRleHQgPT09IFwic3RyaW5nXCIgPyB7IHRleHQ6IGNtZC50ZXh0IH0gOiB7fSksXG4gICAgICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgY3JlYXRlZCB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHtjbWQubGFiZWwgPyBgIOKAlCAke2NtZC5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9LFxuICAgICAgICApO1xuICAgICAgICAvLyBUaGUgYW5zd2VyIG5hbWVzIHRoZSBhY3QgaXQgbWFrZXMgbGlrZWx5OiBhIHZlcnNpb24gYm9ybiBob2xkaW5nIHRoZVxuICAgICAgICAvLyBhZ2VudCdzIHRleHQgaXMgcmVhZHkgdG8gdGFsayBhYm91dDsgYSBjb3B5IHN0aWxsIGhhcyB0byBiZSB3cml0dGVuLFxuICAgICAgICAvLyBhbmQgaXMgYWxyZWFkeSBvbiBvZmZlciB0byB0aGUgaHVtYW4gKCMxMTcpLlxuICAgICAgICBjb25zdCB3cml0dGVuID0gdHlwZW9mIGNtZC50ZXh0ID09PSBcInN0cmluZ1wiO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbi5uLFxuICAgICAgICAgIGZyb206IHIudmVyc2lvbi5mcm9tLFxuICAgICAgICAgIHBhdGg6IHIudmVyc2lvbi5wYXRoLFxuICAgICAgICAgIHdyaXR0ZW4sXG4gICAgICAgICAgaGludDogd3JpdHRlblxuICAgICAgICAgICAgPyBgdiR7ci52ZXJzaW9uLm59IGhvbGRzIHlvdXIgdGV4dCBhbmQgdGhlIGh1bWFuIGhhcyBiZWVuIG9mZmVyZWQgaXQg4oCUIG5vIG5lZWQgdG8gYW5ub3VuY2UgaXQ7IHNheSB3aHkgeW91IG1hZGUgaXQgaWYgdGhhdCBoZWxwcyB0aGVtIGRlY2lkZWBcbiAgICAgICAgICAgIDogYHYke3IudmVyc2lvbi5ufSBpcyBhIGNvcHkgb2YgdiR7ci52ZXJzaW9uLmZyb219IGFuZCB0aGUgaHVtYW4gY2FuIGFscmVhZHkgYWN0aXZhdGUgaXQg4oCUIHdyaXRlIHlvdXIgdGV4dCB0byBpdHMgcGF0aCBub3cgKG5leHQgdGltZTogdmVyc2lvbi1uZXcgLS1ib2R5LWZpbGUsIG9uZSBzdGVwKWAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImFnZW50XCIsIGNtZC50ZXh0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgaWQ6IG0uaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICByZXR1cm4gYWN0aXZhdGUoY21kLmRvYywgY21kLnZlcnNpb24sIFwiYWdlbnRcIik7XG4gICAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiwgYnk6IFwiYWdlbnRcIiB9KTtcbiAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KChjbWQgYXMgeyB0eXBlPzogdW5rbm93biB9KS50eXBlKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgICBbXG4gICAgICAgICAgICBcImNvbnRleHQuYWRkXCIsXG4gICAgICAgICAgICBcInZlcnNpb24ubmV3XCIsXG4gICAgICAgICAgICBcInNheVwiLFxuICAgICAgICAgICAgXCJhY3RpdmF0ZVwiLFxuICAgICAgICAgICAgXCJjbG9zZVwiLFxuICAgICAgICAgICAgXCJtZXRhXCIsXG4gICAgICAgICAgICBcImZpbmRcIixcbiAgICAgICAgICAgIFwiZ3JhcGhcIixcbiAgICAgICAgICAgIFwiYmFja2xpbmtzXCIsXG4gICAgICAgICAgICBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgICAgXCJtZXRhLnNldFwiLFxuICAgICAgICAgICAgLi4uU1RSVUNUVVJFX09QUyxcbiAgICAgICAgICBdLFxuICAgICAgICApO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCByZWZ1c2FsID0gKGU6IHVua25vd24pOiBSZXNwb25zZSA9PiB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBTZXNzaW9uRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogZS5tZXNzYWdlLFxuICAgICAgICAgIC4uLihlLmNob2ljZXMgPyB7IGNob2ljZXM6IGUuY2hvaWNlcyB9IDoge30pLFxuICAgICAgICAgIC4uLihlLmhpbnQgPyB7IGhpbnQ6IGUuaGludCB9IDoge30pLFxuICAgICAgICB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWEsIE5PVyBUSEUgS0lUJ1MgQU5EIE5PVyBST1NURVItV0lERS4gVGhpcyB3YXMgdGhlXG4gICAgICAvLyBmaXJzdCBjb3B5IGFuZCBpdCBsaXN0ZWQgcGF0aHMgKGAvd3NgLCBgL2NtZGAsIGAvZnMvYCkg4oCUIGEgbGlzdCB0aGF0XG4gICAgICAvLyB3YXMgYWxyZWFkeSBtaXNzaW5nIGAvc3RhdGVgLCB3aGljaCBhbnN3ZXJzIGEgc2Vzc2lvbidzIHdob2xlIGNvbnRlbnRzLlxuICAgICAgLy8gYHNyYy9raXQvd2lyZS9vcmlnaW4udHNgIHJlZnVzZXMgb24gdGhlIFJFUVVFU1QgaW5zdGVhZCwgc28gbm8gcGF0aFxuICAgICAgLy8gaW52ZW50b3J5IGNhbiBnbyBzdGFsZSwgYW5kIGBncmltb2lyZS9vcmlnaW4tZ3VhcmQtd2FyZC50ZXN0LnRzYCBob2xkc1xuICAgICAgLy8gdGhlIG90aGVyIGVpZ2h0IGRhZW1vbnMgdG8gdGhlIHNhbWUgbGluZS5cbiAgICAgIHtcbiAgICAgICAgY29uc3QgcmVmdXNlZCA9IHJlZnVzZUZvcmVpZ25PcmlnaW4ocmVxLCBzcnYucG9ydCk7XG4gICAgICAgIGlmIChyZWZ1c2VkKSByZXR1cm4gcmVmdXNlZDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgaWYgKHBhdGggPT09IFwiL3dzXCIpXG4gICAgICAgIHJldHVybiBzcnYudXBncmFkZShyZXEpID8gdW5kZWZpbmVkIDogbmV3IFJlc3BvbnNlKFwidXBncmFkZSByZXF1aXJlZFwiLCB7IHN0YXR1czogNDI2IH0pO1xuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvc3RhdGVcIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICBjb25zdCBzdGF0ZSA9IHZpZXdTdGF0ZSgpO1xuICAgICAgICBjb25zdCBmdWxsID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJmdWxsXCIpID09PSBcIjFcIjtcbiAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgIC4uLnN0YXRlLFxuICAgICAgICAgIGNoYXQ6IGZ1bGwgPyBzdGF0ZS5jaGF0IDogc3RhdGUuY2hhdC5zbGljZSgtMTApLFxuICAgICAgICAgIGNoYXRUb3RhbDogc3RhdGUuY2hhdC5sZW5ndGgsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZigpLFxuICAgICAgICAgIGN1cnNvcjogbG9nLmN1cnNvcigpLFxuICAgICAgICAgIGVwb2NoOiBsb2cuZXBvY2gsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHJldHVybiBldmVudHNSZXNwb25zZShyZXEsIHVybCk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9mcy92ZXJzaW9uXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZWFkVmVyc2lvbihcbiAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZG9jXCIpID8/IFwiXCIsXG4gICAgICAgICAgICBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJ2XCIpID8/IFwiXCIsIDEwKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHIpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIHJlZnVzYWwoZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL2xpc3RcIikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAgIGVudHJpZXM6IGxpc3REaXIoZXhwYW5kSG9tZSh1cmwuc2VhcmNoUGFyYW1zLmdldChcInBhdGhcIikgPz8gXCJ+XCIpKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpXG4gICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgLnRoZW4oKGIpID0+IHtcbiAgICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlLCAuLi5oYW5kbGVBZ2VudENtZChiIGFzIEFnZW50Q21kKSB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzYWwoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goKCkgPT4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICBjb25zdCBhc3NldCA9IHNlcnZlRGlzdChwYXRoKTtcbiAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gYXNzZXQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgfSxcbiAgICB3ZWJzb2NrZXQ6IHtcbiAgICAgIG9wZW4od3MpIHtcbiAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSkpO1xuICAgICAgfSxcbiAgICAgIG1lc3NhZ2Uod3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICBsZXQgbXNnOiBDbGllbnRNc2c7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbXNnID0gSlNPTi5wYXJzZShcbiAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICApIGFzIENsaWVudE1zZztcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogYmFkIGpzb24gZnJvbSBicm93c2VyOiAke2V9XFxuYCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGFuZGxlQ2xpZW50TXNnKHdzLCBtc2cpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gQSByZWZ1c2FsIHRoZSBodW1hbiBjYXVzZWQgKGVkaXQgYSBub24tYWN0aXZlIHZlcnNpb24sIG9wZW4gYVxuICAgICAgICAgIC8vIHZhbmlzaGVkIGZpbGUpIHJlYWNoZXMgVEhFTSwgYXMgYSBjaGF0LXZpc2libGUgc3lzdGVtIGxpbmUgd291bGQgYmVcbiAgICAgICAgICAvLyB0b28gbG91ZCBmb3IgYSBrZXlzdHJva2Ug4oCUIHNvIGl0IGlzIGFuIGVycm9yIGZyYW1lIHRoZSBzdXJmYWNlIHNob3dzLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgY2xvc2Uod3MpIHtcbiAgICAgICAgc29ja2V0cy5kZWxldGUod3MpO1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBib3VuZFBvcnQgPSBzZXJ2ZXIucG9ydDtcbiAgLy8gLS0tIGRpc2NvdmVyeSAoRTEzOiBzZXNzaW9uLUpTT04sIHRoZSBvbmx5IGNvbnZlbnRpb24gdGhhdCBjYW4gZXhwcmVzcyBzZXZlcmFsKSAtLVxuICBjb25zdCBzZXNzaW9uRmlsZSA9IGpvaW4odG1wZGlyKCksIGBzY3JpcHRvcml1bS0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7Ym91bmRQb3J0fWAsXG4gICAgcG9ydDogYm91bmRQb3J0LFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICBob21lLFxuICAgIGRpcjogc2Vzc2lvbi5kaXIsXG4gICAgbW9kZSxcbiAgfSk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgc3luY1dhdGNoZXJzKCk7XG4gIC8vIOKaoCBUSEUgU0VTU0lPTiBTQVlTIFdIQVQgSVRTIE9XTiBUSU1FT1VUIElTLiBgLS10aW1lb3V0IDBgIGhhcyBhbHdheXMgbWVhbnRcbiAgLy8gXCJzdGFuZCB1bnRpbCBjbG9zZWRcIiBhbmQgdGhlcmUgd2FzIG5vIHdheSB0byBjb25maXJtIGZyb20gb3V0c2lkZSB0aGF0IGFcbiAgLy8gZGFlbW9uIGhhZCB0YWtlbiBpdCDigJQgd2hpY2ggaXMgdGhlIGtpbmQgb2Ygc2V0dGluZyB5b3UgZmluZCBvdXQgYWJvdXQgYnlcbiAgLy8gbG9zaW5nIGEgc2Vzc2lvbiBhdCB0aGUgd3JvbmcgbW9tZW50LlxuICBsb2cuZW1pdCh7XG4gICAgdHlwZTogXCJyZWFkeVwiLFxuICAgIG1vZGUsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHJlc3RvcmVkOiAhIW9wdHMucmVzdG9yZSxcbiAgICBpZGxlX3RpbWVvdXRfczogb3B0cy50aW1lb3V0UyA/PyAxODAwLFxuICB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDI6IHdoYXQgY2hhbmdlZCBvbiBkaXNrIHdoaWxlIG5vIGRhZW1vbiB3YXMgd2F0Y2hpbmcuXG4gIGZvciAoY29uc3QgZiBvZiBzZXNzaW9uLnJlc3RvcmVGaW5kaW5ncylcbiAgICBhbm5vdW5jZShcbiAgICAgIGYubWlzc2luZ1xuICAgICAgICA/IGAke2Yub3JpZ2luYWx9IGlzIGdvbmUgZnJvbSBkaXNrIHNpbmNlIHRoaXMgc2Vzc2lvbiB3YXMgbGFzdCBvcGVuLiBTYXZlIHdvdWxkIHJlY3JlYXRlIGl0OyBSZXZlcnQgY2Fubm90IHJ1bi5gXG4gICAgICAgIDogYCR7Zi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgY2xvc2VkLiBTYXZlIG92ZXJ3cml0ZXMgaXQgd2l0aCB0aGUgYWN0aXZlIHZlcnNpb247IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgIHsgZmFjdDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGYuZG9jLCB3aGlsZUNsb3NlZDogdHJ1ZSB9LFxuICAgICk7XG5cbiAgLy8gRTYyOiBvbmUgbGluZSB3aGVuIHRoZSBzZXNzaW9uIGhhcyBzb21ldGhpbmcgd29ydGggbG9va2luZyBhdCwgYW5kIHNpbGVuY2VcbiAgLy8gd2hlbiBpdCBkb2VzIG5vdC5cbiAgLy9cbiAgLy8g4puUIEEgU1VNTUFSWSwgTk9UIEEgUkVQRUFULiBUaGUgcGVyLWRvY3VtZW50IGNvbmZsaWN0cyBhYm92ZSBzYXkgdGhlaXIgb3duXG4gIC8vIHBpZWNlIHdpdGggdGhlIFNhdmUvUmV2ZXJ0IG51YW5jZTsgdGhpcyBjb3VudHMgd2hhdCBpcyB0aGVyZSDigJQgaW5jbHVkaW5nXG4gIC8vIHRoZSB0aGluZ3MgdGhvc2UgbGluZXMgbmV2ZXIgY292ZXJlZCwgbGlrZSBhIGNvbnRleHQgZW50cnkgcG9pbnRpbmcgYXRcbiAgLy8gbm90aGluZyDigJQgYW5kIHBvaW50cyBhdCB0aGUgdmVyYi4gQSBzdGFydHVwIGNoZWNrIHRoYXQgcmVzdGF0ZXMgd2hhdCB3YXNcbiAgLy8ganVzdCBzYWlkLCBvciB0aGF0IGFubm91bmNlcyBpdHNlbGYgd2hlbiBldmVyeXRoaW5nIGlzIGZpbmUsIGlzIGEgbGluZVxuICAvLyBwZW9wbGUgbGVhcm4gdG8gc2tpcC5cbiAge1xuICAgIGNvbnN0IGxpc3QgPSBzZXNzaW9uLmNoZWNrdXAoKTtcbiAgICBjb25zdCBsaW5lID0gc3VtbWFyeShsaXN0KTtcbiAgICBpZiAobGluZSkge1xuICAgICAgYW5ub3VuY2UobGluZSwgeyBmYWN0OiBcImRvY3RvclwiLCBmaW5kaW5nczogbGlzdC5sZW5ndGggfSk7XG4gICAgICAvLyBUaGUgYWdlbnQgZ2V0cyB0aGUgd2hvbGUgcmVwb3J0IG9uIGl0cyB0YWlsLCBzbyBhbiBhZ2VudCB0aGF0IGFycml2ZXNcbiAgICAgIC8vIGxhdGVyIGRvZXMgbm90IGhhdmUgdG8gYXNrIOKAlCBhbmQgZG9lcyBub3QgaGF2ZSB0byBwYXJzZSB0aGUgc2VudGVuY2UuXG4gICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jdG9yXCIsIGNvdW50OiBsaXN0Lmxlbmd0aCwgZmluZGluZ3M6IGxpc3QgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEU1MydzIGF0dGVudGlvbiB0aWNrLiBTZXBhcmF0ZSBmcm9tIGhvdXNla2VlcGluZyBiZWNhdXNlIGl0IGlzIGFib3V0IHRoZVxuICAgKiBIVU1BTidzIHBhdGllbmNlIHJhdGhlciB0aGFuIHRoZSBkYWVtb24ncyBsaWZldGltZSwgYW5kIGJlY2F1c2UgaXQgbXVzdCBydW5cbiAgICogb24gYSBzbG93ZXIgY2xvY2s6IGEgMjUwIG1zIHN3ZWVwIHJlLWJyb2FkY2FzdGluZyBzdGF0ZSB3b3VsZCBiZSBjaHVybiBmb3IgYVxuICAgKiB2YWx1ZSB0aGF0IGNoYW5nZXMgdHdpY2UgaW4gYSB3YWl0LlxuICAgKi9cbiAgbGV0IGxhc3RXYWl0aW5nOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgYXR0ZW50aW9uVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgbm93LCB7IGFja25vd2xlZGdlZFVudGlsIH0pO1xuICAgIC8vIEU2NTogYSBub3RlIGZsaXBwaW5nIHRvIHN0YWxsZWQgaXMgYSBjaGFuZ2UgdGhlIHN1cmZhY2UgbXVzdCBzZWUgdG9vLlxuICAgIC8vIOKaoCBOT1QgYSBudWRnZTogc2VlIEU2NSBpbiB0aGUgZGVjaXNpb24gbG9nIOKAlCB0aGUgbm90ZSdzIGFjdCBpcyB0aGVcbiAgICAvLyBodW1hbidzLCBhbmQgdGhlIGV2ZW50IHRoYXQgZGVsaXZlcmVkIGl0IGFscmVhZHkgY2FycmllZCBpdC5cbiAgICBjb25zdCBub3RlcyA9IG5vdGVzV2FpdGluZyhzZXNzaW9uLm5vdGVGYWN0cygpLCBzZXNzaW9uLm1lc3NhZ2VzKCksIG5vdywge1xuICAgICAgYWNrbm93bGVkZ2VkVW50aWwsXG4gICAgfSk7XG4gICAgY29uc3Qga2V5ID0gYXR0ZW50aW9uS2V5KHcsIG5vdGVzKTtcbiAgICBpZiAoa2V5ID09PSBsYXN0V2FpdGluZykgcmV0dXJuO1xuICAgIGxhc3RXYWl0aW5nID0ga2V5O1xuICAgIC8vIFRoZSBiYWRnZSBjaGFuZ2VkLCBzbyB0aGUgc3VyZmFjZSBuZWVkcyB0aGUgbmV3IHNuYXBzaG90LlxuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgaWYgKCF3KSByZXR1cm47XG4gICAgaWYgKHcuYmFkZ2UgIT09IFwic3RhbGxlZFwiIHx8IG51ZGdlZC5oYXMody5tZXNzYWdlSWQpKSByZXR1cm47XG4gICAgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgLy8g4puUIFRIRSBOVURHRSBHT0VTIFRPIFRIRSBBR0VOVCdTIFRBSUwgQU5EIE5PV0hFUkUgRUxTRS4gVGhlIGh1bWFuIGFscmVhZHlcbiAgICAvLyBzZWVzIHRoZSBiYWRnZTsgcHV0dGluZyB0aGlzIGluIHRoZSBjaGF0IGFzIHdlbGwgd291bGQgYmUgdGVsbGluZyB0aGVtXG4gICAgLy8gd2hhdCB0aGV5IGFyZSBsb29raW5nIGF0LiBJdCBjYXJyaWVzIHRoZSBtZXNzYWdlIFRFWFQgYmVjYXVzZSBhbiBhZ2VudFxuICAgIC8vIHRoYXQgaGFzIGJlZW4gYXdheSBuZWVkcyB0byBrbm93IHdoYXQgaXMgcGVuZGluZywgbm90IGp1c3QgdGhhdCBzb21ldGhpbmdcbiAgICAvLyBpcyDigJQgYW5kIGl0IG5hbWVzIHRoZSB0d28gd2F5cyBvdXQsIGJlY2F1c2UgYSBudWRnZSB0aGF0IGRvZXMgbm90IHNheSBob3dcbiAgICAvLyB0byBhbnN3ZXIgaXQgaW52aXRlcyBhIGZvdXJ0aCBwcmltaXRpdmUuXG4gICAgY29uc3QgcGVuZGluZyA9IHNlc3Npb24ubWVzc2FnZXMoKS5maW5kKChtKSA9PiBtLmlkID09PSB3Lm1lc3NhZ2VJZCk7XG4gICAgbG9nLmVtaXQoe1xuICAgICAgdHlwZTogXCJ3YWl0aW5nXCIsXG4gICAgICBtZXNzYWdlX2lkOiB3Lm1lc3NhZ2VJZCxcbiAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoKERhdGUubm93KCkgLSB3LnNpbmNlKSAvIDEwMDApLFxuICAgICAgLi4uKHBlbmRpbmcgPyB7IHRleHQ6IHBlbmRpbmcudGV4dCB9IDoge30pLFxuICAgICAgaGludDogXCJyZXBseSB3aXRoIGBzYXlgLCBvciBgd29ya2luZ2AgdG8gc2F5IHlvdSBhcmUgc3RpbGwgb24gaXRcIixcbiAgICB9KTtcbiAgfSwgMTAwMCk7XG5cbiAgY29uc3Qgc3RvcEhvdXNla2VlcGluZyA9IHN0YXJ0SG91c2VrZWVwaW5nKHtcbiAgICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IHNvY2tldHMuc2l6ZSArIHNzZUNsaWVudHMuc2l6ZSxcbiAgICBpZGxlTXM6ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LFxuICAgIHRvdWNoLFxuICAgIHRpbWVvdXRNczogKG9wdHMudGltZW91dFMgPz8gMTgwMCkgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiwgYnk6IFwidGltZW91dFwiIH0pLFxuICB9KTtcblxuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lIOKAlCBmaW5lICovXG4gICAgfVxuICAgIHVubGlua0lmTWF0Y2hlcyhsYXRlc3RGaWxlLCBzZXNzaW9uSWQsIChyYXcpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlkID0gKEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiB1bmtub3duIH0pLnNlc3Npb25faWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGhlIG9yZGVyIGlzIHRoZSBoZWFkZXIncywgYW5kIHRoZSBoZWFkZXIgc2F5cyB3aHkuXG4gIGNvbnN0IGNsb3NlID0gKGJ5PzogQ2xvc2VkQnkpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgY2xlYXJJbnRlcnZhbChhdHRlbnRpb25UaW1lcik7XG4gICAgZm9yIChjb25zdCB3IG9mIHdhdGNoZXJzLnZhbHVlcygpKSB3LmNsb3NlKCk7XG4gICAgd2F0Y2hlcnMuY2xlYXIoKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgcGVuZGluZy52YWx1ZXMoKSkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIC8vIFdITyBlbmRlZCBpdCBnb2VzIGluIHRoZSBtYW5pZmVzdCBiZWZvcmUgdGhlIHBlcnNpc3Q6IHRoZSBtYW5pZmVzdFxuICAgIC8vIG91dGxpdmVzIHRoaXMgZGFlbW9uLCBhbmQgYSB2ZXJiIHJ1biBhZnRlciB0aGUgZW5kIHJlYWRzIGl0IHRoZXJlLlxuICAgIGlmIChieSkgc2Vzc2lvbi5tYXJrRW5kZWQoYnkpO1xuICAgIHRyeSB7XG4gICAgICBzZXNzaW9uLnBlcnNpc3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICAvLyBXSE8gZW5kZWQgaXQgcmlkZXMgdGhlIGV2ZW50LCBzbyB0aGUgYWdlbnQncyB0YWlsIGNhbiB0ZWxsIHRoZSBodW1hbidzXG4gICAgLy8gZGVsaWJlcmF0ZSBlbmQgZnJvbSBpdHMgb3duIGBjbG9zZWAgb3IgdGhlIGlkbGUgdGltZW91dCDigJQgYW5kIHRoZVxuICAgIC8vIHN1cmZhY2UgZ2V0cyB0aGUgc2FtZSBmYWN0IGJlZm9yZSBpdHMgc29ja2V0IGdvZXMsIHNvIGl0IGNhbiBzYXlcbiAgICAvLyBcIlNlc3Npb24gZW5kZWRcIiBpbnN0ZWFkIG9mIHJldHJ5aW5nIGEgZGFlbW9uIHRoYXQgaXMgbm90IGNvbWluZyBiYWNrLlxuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJjbG9zZWRcIiwgLi4uKGJ5ID8geyBieSB9IDoge30pIH0pO1xuICAgIGlmIChieSkgc2VuZCh7IHR5cGU6IFwiY2xvc2VkXCIsIGJ5IH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKChyKSA9PiBjbG9zZShyLmJ5KSk7XG5cbiAgcmV0dXJuIHsgcG9ydDogYm91bmRQb3J0LCBzZXNzaW9uSWQsIG1vZGUsIGRpcjogc2Vzc2lvbi5kaXIsIGNsb3NlLCBkb25lLCBzaHV0ZG93biB9O1xufVxuXG4vKipcbiAqIEEgcGF0aCB0eXBlZCBpbiB0aGUgU1VSRkFDRS4gVGhlIHBhZ2UgaGFzIG5vIHdvcmtpbmcgZGlyZWN0b3J5LCBzbyBhIHBhdGhcbiAqIGZyb20gaXQgbXVzdCBiZSBhYnNvbHV0ZSBvciBzdGFydCBhdCBgfmAg4oCUIHdoaWNoIGlzIGV4cGFuZGVkIEhFUkUuIEJlZm9yZVxuICogdGhpcywgYH4vRG9jdW1lbnRzYCByZWFjaGVkIGByZXNvbHZlKClgIGFuZCB3YXMgdGFrZW4gYXMgcmVsYXRpdmUgdG8gdGhlXG4gKiBkYWVtb24ncyBjd2QgKHRoZSBza2lsbCBmb2xkZXIpOiB0aGUgcGF0aCBib3ggY29tcGxldGVkIGB+L+KApmAgKGxpc3RpbmdcbiAqIGV4cGFuZHMgaXQpIGFuZCB0aGVuIEVudGVyIGZhaWxlZCB3aXRoIFwibm8gc3VjaCBmaWxlIG9yIGZvbGRlcjpcbiAqIOKApi9za2lsbHMvc2NyaXB0b3JpdW0vfi9Eb2N1bWVudHMv4oCmXCIgKENvbGUsIDIwMjYtMDktMTEpLlxuICovXG4vKipcbiAqIFRoZSBodW1hbidzIGNoYXQgbGluZSB3aGVuIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIGtlcHRcbiAqIChFMiwgIzExNyk6IHdoYXQgaGFwcGVuZWQgdG8gdGhlaXIgdmVyc2lvbiBvZiBXSElDSCBkb2N1bWVudCwgbm8gcGF0aCwgbm9cbiAqIGluc3RydWN0aW9ucyBtZWFudCBmb3IgdGhlIGFnZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaHVtYW5PdXRzaWRlTGluZShcbiAgbmFtZTogc3RyaW5nLFxuICB2ZXJzaW9uOiBudW1iZXIsXG4gIHByZXNlcnZlZEFzOiBudW1iZXIsXG4gIGFjdGl2YXRlZEJlZm9yZVdyaXR0ZW46IGJvb2xlYW4sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYWN0aXZhdGVkQmVmb3JlV3JpdHRlblxuICAgID8gYFlvdSBhY3RpdmF0ZWQgdiR7dmVyc2lvbn0gb2YgJHtuYW1lfSBiZWZvcmUgdGhlIGFnZW50IGhhZCB3cml0dGVuIGl0OyB0aGUgYWdlbnQncyB0ZXh0IGlzIHYke3ByZXNlcnZlZEFzfS5gXG4gICAgOiBgdiR7dmVyc2lvbn0gb2YgJHtuYW1lfSB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvcjsgdGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9LCBhbmQgdiR7dmVyc2lvbn0ga2VlcHMgeW91cnMuYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN1cmZhY2VQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSBwLnRyaW0oKTtcbiAgaWYgKHQgPT09IFwiflwiIHx8IHQuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gZXhwYW5kSG9tZSh0KTtcbiAgaWYgKCFpc0Fic29sdXRlKHQpKVxuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYFwiJHtwfVwiIGlzIG5vdCBhIGZ1bGwgcGF0aCDigJQgc3RhcnQgaXQgd2l0aCAvIG9yIH4vYCwgNDAwKTtcbiAgcmV0dXJuIHJlc29sdmUodCk7XG59XG5cbi8qKiBBIHN0cnVjdHVyZSBvcCBmcm9tIHRoZSBzdXJmYWNlLCB3aXRoIGV2ZXJ5IHBhdGggZmllbGQgdGhyb3VnaCBgc3VyZmFjZVBhdGhgLiAqL1xuZnVuY3Rpb24gYW5jaG9yU3VyZmFjZVBhdGhzKG9wOiBTdHJ1Y3R1cmVPcCk6IFN0cnVjdHVyZU9wIHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4ub3AgfTtcbiAgZm9yIChjb25zdCBrIG9mIFtcImRpclwiLCBcInBhdGhcIiwgXCJpbnRvXCJdIGFzIGNvbnN0KVxuICAgIGlmICh0eXBlb2Ygb3V0W2tdID09PSBcInN0cmluZ1wiKSBvdXRba10gPSBzdXJmYWNlUGF0aChvdXRba10gYXMgc3RyaW5nKTtcbiAgcmV0dXJuIG91dCBhcyBTdHJ1Y3R1cmVPcDtcbn1cblxuZnVuY3Rpb24gZXhwYW5kSG9tZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAocCA9PT0gXCJ+XCIpIHJldHVybiBob21lZGlyKCk7XG4gIGlmIChwLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCBwLnNsaWNlKDIpKTtcbiAgcmV0dXJuIHJlc29sdmUocCk7XG59XG5cbi8qKiBUaGUgZGFlbW9uJ3MgcHJpdmF0ZSBhcmd2IOKAlCB0aGUgQ0xJIHNwYXducyBpdCB3aXRoIGV4YWN0bHkgdGhlc2UuICovXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgbG9nOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgd29ya3NwYWNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgd2FpdCBmb3IgdGhlIGVuZC4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYHNjcmlwdG9yaXVtOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG4gIHJlY29nbml6ZWQgZmxhZ3M6ICR7T2JqZWN0LmtleXMoXG4gICAgICAgIERBRU1PTl9PUFRJT05TLFxuICAgICAgKVxuICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBsZXQgZDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBzdGFydERhZW1vbj4+O1xuICB0cnkge1xuICAgIGQgPSBhd2FpdCBzdGFydERhZW1vbih7XG4gICAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICAgIHJlc3RvcmU6IGZsYWdzLnJlc3RvcmUsXG4gICAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICAgIHdvcmtzcGFjZTogZmxhZ3Mud29ya3NwYWNlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gVGhlIGhhbmRzaGFrZSBsaW5lIGlzIEpTT04gZWl0aGVyIHdheSwgc28gdGhlIENMSSByZWFkcyBPTkUgc2hhcGUuXG4gICAgY29uc3Qgc3RhdHVzID0gZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvciA/IGUuc3RhdHVzIDogNTAwO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIHN0YXR1cywgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIHN0YXR1cyA9PT0gNDA0ID8gNSA6IHN0YXR1cyA9PT0gNDA5ID8gNiA6IDE7XG4gIH1cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSwgZGlyOiBkLmRpciB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIGF3YWl0IGQuc2h1dGRvd247XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiBhIGNsZWFuIGNsb3NlIGxlYXZlcyBubyBlbXB0eSBsb2cgYmVoaW5kLlxuICBpZiAocmVzLmNvZGUgPT09IDAgJiYgZmxhZ3MubG9nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChzdGF0U3luYyhmbGFncy5sb2cpLnNpemUgPT09IDApIHVubGlua1N5bmMoZmxhZ3MubG9nKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSLiBgaW1wb3J0Lm1ldGEubWFpbmAgaXMgRkFMU0UgaW4gdGhlXG4gKiBidW5kbGUsIHNvIHRoZXJlIGlzIG5vIHN1Y2ggYmxvY2sgaGVyZSwgYW5kIHRoaXMgdGFrZXMgbm8gYXJndW1lbnRzOiB0aGVcbiAqIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHR3byBwcmltaXRpdmVzIHVuZGVyIEJPVEggb2YgdGhlIGhvdXNlJ3MgZGFlbW9uLWRpc2NvdmVyeSBjb252ZW50aW9ucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIEQzIHJ1bGVkIHRoYXQgdGhlIGNvbnZlbnRpb25zIHRoZW1zZWx2ZXMg4oCUIHBlci1zZXNzaW9uIHRtcGRpciBKU09OIChib3VudHksXG4gKiBnbGFtb3VyLCBpbWFnbywgbWFncGllKSBhbmQgc2luZ2xldG9uIGAkSE9NRS9kYWVtb24ucG9ydGAgKyBgZGFlbW9uLnBpZGBcbiAqIChhc3Ryb2xhYmUsIGdyYXBldmluZSwgbWluZC1tYXBwZXIpIOKAlCBib3RoIHN1cnZpdmUsIGJlY2F1c2UgdGhleSBlbmNvZGVcbiAqIGdlbnVpbmVseSBkaWZmZXJlbnQgbW9kZWxzIChjb25jdXJyZW50IHNlc3Npb25zIHZzIGEgc3RhbmRpbmcgc2luZ2xldG9uKSBhbmRcbiAqIHBpY2tpbmcgb25lIGlzIGEgcHJvZHVjdCBkZWNpc2lvbiwgbm90IGEgZmFjdG9yaW5nIG9uZS4gV2hhdCBJUyBvbmVcbiAqIGltcGxlbWVudGF0aW9uIGlzIHRoZSBwYWlyIGJlbG93LCB3aGljaCBpcyBhbHNvIGV4YWN0bHkgd2hlcmUgY2Vuc3VzIGRlZmVjdFxuICogKipMMyoqIGxpdmVzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuLyoqXG4gKiBXcml0ZSBgdGV4dGAgdG8gYHRhcmdldGAgYXRvbWljYWxseTogd3JpdGUgYmVzaWRlIGl0LCB0aGVuIHJlbmFtZS5cbiAqXG4gKiDim5QgKipMMywgQ0xPU0VEIEJZIENPTlNUUlVDVElPTi4qKiBBIGJhcmUgYHdyaXRlRmlsZVN5bmNgIGlzIG5vdCBhdG9taWMsIHNvIGFcbiAqIENMSSByZWFkaW5nIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgSEFMRi1XUklUVEVOIHBvaW50ZXIuIFVuZGVyXG4gKiBhIGJlc3QtZWZmb3J0IHJlYWRlciB0aGF0IHN1cmZhY2VkIGFzIFwibm8gcnVubmluZyBzZXNzaW9uXCIg4oCUIGFic2VuY2UgcmVwb3J0ZWRcbiAqIGZvciB3aGF0IHdhcyByZWFsbHkgYSB0b3JuIHJlYWQsIHdoaWNoIGlzIHRoZSBleGFjdCBjb25mbGF0aW9uIHRoZSBob3VzZSdzXG4gKiBgbnVsbGAtbm90LWAwYCBydWxlIGV4aXN0cyB0byBwcmV2ZW50LiBSZW5hbWUgd2l0aGluIG9uZSBkaXJlY3RvcnkgaXMgYXRvbWljLFxuICogc28gYSByZWFkZXIgc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbFxuICogZmlsZS5cbiAqXG4gKiBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDcsIGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIHRoZSBuZXh0IGRheSBieVxuICogdGhlIGR1cGxpY2F0aW9uIHJlY29uLCBhbmQgcmVwYWlyZWQgaW4gYWxsIG9mIHRoZW0gdGhlIG9ubHkgd2F5IHRoYXQgZG9lcyBub3RcbiAqIG5lZWQgZmluZGluZyBhZ2FpbjogdGhlcmUgaXMgbm93IG9uZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiDimqAgVGhlIHRlbXAgbmFtZSBjYXJyaWVzIHRoZSBwaWQsIHNvIHR3byBkYWVtb25zIHJhY2luZyB0byBwdWJsaXNoIHRoZSBzYW1lXG4gKiBwb2ludGVyIGNhbm5vdCBjbG9iYmVyIGVhY2ggb3RoZXIncyBpbnRlcm1lZGlhdGUgZmlsZSDigJQgYW5kIGl0IGlzIHJlbW92ZWQgb25cbiAqIGEgZmFpbGVkIHdyaXRlIHJhdGhlciB0aGFuIGxlZnQgYXMgbGl0dGVyIGJlc2lkZSB0aGUgcmVhbCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUZpbGVBdG9taWModGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCB0bXAgPSBgJHt0YXJnZXR9LiR7cHJvY2Vzcy5waWR9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgIHJlbmFtZVN5bmModG1wLCB0YXJnZXQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHRtcCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgIH1cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGUgYHBhdGhgIGlmZiBpdCBzdGlsbCBuYW1lcyBVUy4gUmV0dXJucyB3aGV0aGVyIGl0IHdhcyBkZWxldGVkLlxuICpcbiAqIOKblCAqKlwiU1RJTEwgT1VSU1wiIElTIFRIRSBXSE9MRSBGVU5DVElPTi4qKiBBIGRhZW1vbiB0aGF0IHVubGlua3MgaXRzIGRpc2NvdmVyeVxuICogZmlsZSB1bmNvbmRpdGlvbmFsbHkgYXQgZXhpdCBkZWxldGVzIHRoZSBwb2ludGVyIGEgU1VDQ0VTU09SIGhhcyBhbHJlYWR5XG4gKiB3cml0dGVuIOKAlCB0aGUgc3VjY2Vzc29yIGNhbiB0aGVuIG5vIGxvbmdlciBiZSBmb3VuZCBhbmQgdGhlIG5leHQgQ0xJIHZlcmIgc3Bhd25zIGFcbiAqIHRoaXJkIGRhZW1vbi4gQm90aCBjb252ZW50aW9ucyBoYXZlIHRoaXMgaGF6YXJkIGFuZCBib3RoIGV4cHJlc3MgaXRcbiAqIGRpZmZlcmVudGx5OiBhc3Ryb2xhYmUgY29tcGFyZXMgdGhlIHBpZCBmaWxlJ3MgYnl0ZXMgdG8gaXRzIG93biBwaWQsXG4gKiBtYWdwaWUgcGFyc2VzIHRoZSBKU09OIHBvaW50ZXIgYW5kIGNvbXBhcmVzIGBzZXNzaW9uX2lkYC4gYGlkZW50aWZ5YCBpcyB3aGF0XG4gKiBtYWtlcyB0aG9zZSBvbmUgZnVuY3Rpb24g4oCUIGl0IHR1cm5zIHRoZSBmaWxlJ3MgYnl0ZXMgaW50byB0aGUgaWRlbnRpdHkgdG9cbiAqIGNvbXBhcmUsIGFuZCBpdCBkZWZhdWx0cyB0byB0aGUgdHJpbW1lZCBieXRlcyB0aGVtc2VsdmVzLlxuICpcbiAqIOKaoCBFdmVyeSBmYWlsdXJlIGlzIHN3YWxsb3dlZCBhbmQgcmVwb3J0ZWQgYXMgYGZhbHNlYDogdGhlIGZpbGUgYmVpbmcgZ29uZSxcbiAqIHVucmVhZGFibGUsIG9yIHVucGFyc2VhYmxlIGFsbCBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmUg4oCUIGl0IGlzIG5vdCBvdXJzIHRvXG4gKiByZW1vdmUuIEFuIHVucGFyc2VhYmxlIHBvaW50ZXIgaXMgZGVsaWJlcmF0ZWx5IE5PVCB0cmVhdGVkIGFzIG91cnMsIHdoaWNoIGlzXG4gKiB0aGUgY29uc2VydmF0aXZlIGhhbGYgb2YgdGhlIHNhbWUgYG51bGxgLW5vdC1gMGAgcnVsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubGlua0lmTWF0Y2hlcyhcbiAgcGF0aDogc3RyaW5nLFxuICBleHBlY3RlZDogc3RyaW5nLFxuICBpZGVudGlmeTogKHJhdzogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsID0gKHJhdykgPT4gcmF3LnRyaW0oKSxcbik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpZGVudGlmeShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSAhPT0gZXhwZWN0ZWQpIHJldHVybiBmYWxzZTtcbiAgICB1bmxpbmtTeW5jKHBhdGgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgaW4tcHJvY2VzcyBldmVudCBsb2cg4oCUIHRoZSBhcHBlbmQtb25seSwgcmVwbGF5YWJsZSBidWZmZXJcbiAqIGJlaGluZCBldmVyeSBzcGVsbCdzIGBHRVQgL2V2ZW50c2AgU1NFIHRhaWwuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXInc1xuICogYHNjcmlwdHMvZXZlbnRzLnRzYCDigJQgdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMiwgYW5kIHRoZSBvbmx5IG9uZSBvZlxuICogdGhlIHNpeCBjb3BpZWQtaW4tcGxhY2UgYnVzZXMgdGhhdCBpcyBhIG1vZHVsZSwgaXMgYm91bmRlZCwgY2FycmllcyBhbiBlcG9jaCwgYW5kIGlzXG4gKiB1bml0LXRlc3RlZC4gVGhlIGZpdmUgb3RoZXJzIGFyZSB0aGUgc2FtZSB0d2VudHkgbGluZXMgd3JpdHRlbiBmaXZlIHRpbWVzLlxuICpcbiAqIOKUgOKUgCBUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMg4oCUIFRXTyBCWSBDT05TVFJVQ1RJT04sIE9ORSBCWSBPUFQtSU4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICog4puUIFRIRSBIRUFESU5HIFVTRUQgVE8gU0FZIFwiVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTlwiIEFORFxuICogSVRFTSAyIElTIE5PVCBPTkUgT0YgVEhFTS4gQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gbWluZC1tYXBwZXIncyBwcmUtd29ya1xuICogKEQ3OSk6IGBlcG9jaGAgaXMgT1BUSU9OQUwgaGVyZSwgc28gTDYgaXMgY2xvc2VkIG9ubHkgZm9yIGEgY2FsbGVyIHRoYXQgYXNrcy5cbiAqIFRocmVlIGFkb3B0ZXJzIGhhdmUgc2luY2UgZGVjbGluZWQgdG8g4oCUIGltYWdvIChEMzkpLCBib3VudHkgKEQ0OCkgYW5kXG4gKiBncmFwZXZpbmUgKEQ3MCkg4oCUIHNvIHRoZSBkZWZlY3QgdGhlIGhlYWRpbmcgY2xhaW1lZCB0byBtYWtlIGltcG9zc2libGUgaXNcbiAqIGxpdmUgaW4gdGhlIHRyZWUsIGJ5IG9wdC1vdXQsIGFuZCB0aGUgb3ZlcmNsYWltIGlzIHdoYXQgaGlkIHRoYXQuIEl0ZW1zIDEgYW5kXG4gKiAzIEFSRSBieSBjb25zdHJ1Y3Rpb246IGEgY2FsbGVyIGNhbm5vdCBzd2l0Y2ggdGhlIGNhcCBvZmYgb3IgcmVhY2ggdGhlIGJ1ZmZlci5cbiAqXG4gKiDimqAgQU5EIE1JTkQtTUFQUEVSJ1MgT1dOIEJVUywgV0hJQ0ggVEhJUyBNT0RVTEUgQ09OVkVSR0VEIFRPV0FSRCwgVFlQRVMgVEhFXG4gKiBFUE9DSCBBUyBSRVFVSVJFRCBhbmQgc3RhbXBzIGl0IHVuY29uZGl0aW9uYWxseSDigJQgaXQgaXMgdGhlIHNwZWxsIGNlbnN1cyBMNlxuICogbmFtZXMgYXMgQ09SUkVDVC4gTWFraW5nIGl0IHJlcXVpcmVkIEhFUkUgaXMgbm90IHRoZSByZXBhaXI6IGl0IHdvdWxkIHJldmVyc2VcbiAqIEQzOSwgRDQ4IGFuZCBENzAuIFRoZSBob25lc3Qgc3RhdGVtZW50IGlzIHRoaXMgaGVhZGluZy5cbiAqXG4gKiDim5QgKipSRVNPTFZFRCBBVCBUSEFUIFNQRUxMJ1MgUE9SVCwgQU5EIFRIRSBESVNQT1NJVElPTiBJUyBSRUNPUkRFRCBIRVJFXG4gKiBCRUNBVVNFIEEgTE9TUyBUSEFUIExJVkVTIE9OTFkgSU4gQSBKT1VSTkFMIElTIEEgTE9TUyBOT0JPRFkgQ0FOIFNFRVxuICogKEQ3OS9EODUpLioqIG1pbmQtbWFwcGVyIGFkb3B0ZWQgdGhpcyBtb2R1bGUgaW4gUGhhc2UgNyBhbmQga2VwdCBpdHNcbiAqIGd1YXJhbnRlZSBXSVRIT1VUIEEgS0lUIENIQU5HRTogaXQgcGFzc2VzIGB7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH1gIGF0XG4gKiBpdHMgT05FIGNvbnN0cnVjdGlvbiBzaXRlIGFuZCByZS10aWdodGVucyBgZXBvY2hgIHRvIFJFUVVJUkVEIGluIGl0cyBvd25cbiAqIGxvY2FsIGZyYW1lIHR5cGUsIHNvIG5vdGhpbmcgaXRzIGJ1cyBlbWl0cyBjYW4gbGFjayBvbmUuIEtpdCBieXRlczogemVyby5cbiAqICoqU28gdGhlIGVwb2NoIGlzIGEgTE9TU1ktQ09QWSBwcm9wZXJ0eSB3aG9zZSBkaXNwb3NpdGlvbiBpcyBLRUVQLUxPQ0FMLCBub3RcbiAqIFJFU1RPUkUqKiDigJQgdGhlIG9ubHkgcHJvcGVydHkgb2YgdGhhdCBzcGVsbCdzIG93biBtb2R1bGUgdGhpcyBtb2R1bGUgY291bGRcbiAqIG5vdCBjYXJyeSBhbmQgZGlkIG5vdCBuZWVkIHRvLiBMNiBpcyBDTE9TRUQgZm9yIHRoZSB0d28gc3BlbGxzIHRoYXQgYXNrIGFuZFxuICogT1BFTiwgYnkgb3B0LW91dCwgZm9yIHRoZSB0aHJlZSB0aGF0IGRlY2xpbmU7IHRoYXQgYXN5bW1ldHJ5IGlzIHRoZSBob25lc3RcbiAqIHN0YXRlIGFuZCB0aGlzIGhlYWRpbmcgaXMgd2hlcmUgaXQgaXMgd3JpdHRlbi5cbiAqXG4gKiDimqAgKipBTkQgVEhFIEFET1BUSU9OIFJFTkFNRVMgQSBGSUVMRCBPTiBBTiBBRE9QVEVSJ1MgUFVCTElTSEVEIFdJUkUuKiogYGlkYFxuICogaXMgbmFtZWQgaW4gYEZyYW1lPFQ+YCBhbmQgaW4gdGhlIGVtaXQgbGl0ZXJhbCBiZWxvdywgc28gYSBzcGVsbCB3aG9zZSBidXNcbiAqIHNwZWxsZWQgdGhlIGN1cnNvciBhbnl0aGluZyBlbHNlIHBheXMgYSByZW5hbWUgYXQgZXZlcnkgcmVhZGVyIOKAlCBmb3JcbiAqIG1pbmQtbWFwcGVyLCAxNzMgb2NjdXJyZW5jZXMgYWNyb3NzIDUgc3VyZmFjZSBmaWxlcywgfjIwOSBhY3Jvc3MgfjMwIGJhY2tlbmRcbiAqIGZpbGVzLCBldmVyeSBKU09OTCBsaW5lIGl0cyBgdGFpbGAgd3JpdGVzIGludG8gYW4gYWdlbnQncyBwaXBlLCBhbmQgKHRoZSBvbmVcbiAqIG5vYm9keSBjb3VudGVkKSB0aGUgRklYVFVSRSBpbiBpdHMgb3duIGB0YWlsLnRlc3QudHNgLCB3aGljaCBXUklURVMgdGhlXG4gKiBlbnZlbG9wZSB3aGlsZSBzdGFuZGluZyBpbiBmb3IgdGhlIGRhZW1vbi4gVGhlIE5FU1RJTkcgaXMgbm90IGZvcmNlZCDigJRcbiAqIGBGcmFtZTxUPmAgaXMgZ2VuZXJpYywgYW5kIG1pbmQtbWFwcGVyIGtlcHQgYHtraW5kLCBwYXlsb2FkfWAgbmVzdGVkIHdoZXJlIGFsbFxuICogZml2ZSBlYXJsaWVyIGFkb3B0ZXJzIGZsYXR0ZW4gYnkgaWRpb20uICoqQW4gaWRpb20gZml2ZSBzaWJsaW5ncyBzaGFyZSBpc1xuICogaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGNvbnRyYWN0IHVudGlsIHlvdSBvcGVuIHRoZSB0eXBlKiogKEQ4MSwgRDg2KS5cbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgV0hFTiBUSEUgQ0FMTEVSIEFTS1MgRk9SIE9ORSAob3B0LWluLFxuICogbm90IGNvbnN0cnVjdGlvbiDigJQgc2VlIGFib3ZlKS4qKiBBZnRlciBhIHJlc3RhcnQgdGhlIGlkcyBzdGFydCBhZ2FpbiBhdCAxLCBzb1xuICogYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZSB3YXRlcm1hcmsgZnJvbSBhIGZyZXNoIG9uZSBieSBpZCBhbG9uZS5cbiAqXG4gKiAqKjMgwrcgQSBTVEFMRSBXQVRFUk1BUksgUkVQTEFZUyBGUk9NIFRIRSBCRUdJTk5JTkcsIGFuZCB0aGlzIGlzIHRoZSBoYWxmIHRoZVxuICogY2xpZW50IGNhbm5vdCBkby4qKiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IGEgdGFpbCB0aGF0IHJlc3VtZXMgYXRcbiAqIGBzaW5jZT08bGFzdCBpZCBvZiB0aGUgcHJldmlvdXMgZGFlbW9uPmAgYWdhaW5zdCBhIHJlc3RhcnRlZCBkYWVtb24gcmVjZWl2ZXNcbiAqIE5PVEhJTkcg4oCUIHRoZSBuZXcgZGFlbW9uJ3MgYHJlYWR5YCBpcyBpZCAxLCB3aGljaCBpcyBub3QgYD4gc2luY2VgLCBzbyB0aGVcbiAqIGZpbHRlciBkcm9wcyBpdCwgc28gbm8gZnJhbWUgYXJyaXZlcywgc28gdGhlIGNsaWVudCdzIGVwb2NoIGNoZWNrIG5ldmVyIHJ1bnNcbiAqIGFuZCB0aGUgdGFpbCBzaXRzIGNvbm5lY3RlZCBhbmQgc2lsZW50IHVudGlsIHRoZSBuZXcgZGFlbW9uIGhhcyBlbWl0dGVkIGFzXG4gKiBtYW55IGV2ZW50cyBhcyB0aGUgb2xkIG9uZSBkaWQuIFN0YW1waW5nIGFuIGVwb2NoIGFsb25lIGRvZXMgTk9UIGNsb3NlIHRoYXRcbiAqIGdhcDogdGhlIGVwb2NoIHJpZGVzIGEgZnJhbWUsIGFuZCB0aGUgYnVnIGlzIHRoYXQgbm8gZnJhbWUgaXMgc2VudC4gU29cbiAqIGBzdWJzY3JpYmVgIHRyZWF0cyBgc2luY2UgPiBjdXJzb3JgIGFzIFwidGhpcyBjdXJzb3IgaXMgZnJvbSBhbm90aGVyIHByb2Nlc3NcIlxuICogYW5kIHJlcGxheXMgd2hvbGUuIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS4gTm90XG4gKiBcIm5vIHN1YmplY3RcIiDigJQgZ3JhcGV2aW5lIEhBUyBhbiBldmVudCBidXMgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZVxuICogc3BlbGwg4oCUIGJ1dCB0aGUgdHdvIHNoYXBlcyBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIG9uZSBwcm9jZXNzLXdpZGUgYXJyYXkgY2FwcGVkIGF0IFJFUExBWV9CVUZGRVJfU0laRSwgd2l0aCBvbmVcbiAqICAgICAgICAgICAgICAgIG1vbm90b25pYyBgc2VxYCwgYW5kIHRoZSBoZWFkZXIgdGhyZWUgcGFyYWdyYXBocyB1cCBzYXlzIGluIGFzXG4gKiAgICAgICAgICAgICAgICBtYW55IHdvcmRzIHRoYXQgaXQgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqICAgICAgICAgICAgICAgIGRhZW1vbidzIGxpZmV0aW1lLCBOT1QgYSBkdXJhYmxlIGxvZy5cbiAqICAgZ3JhcGV2aW5lICAgIE4gZHVyYWJsZSBhcHBlbmQtb25seSBgLmpzb25sYCBmaWxlcywgb25lIHBlciBuYW1lZCBjaGFubmVsLFxuICogICAgICAgICAgICAgICAgZWFjaCB3aXRoIGl0cyBvd24gYG5leHRfaWRgLCByZXBsYXllZCBmcm9tIGRpc2sgYnlcbiAqICAgICAgICAgICAgICAgIGByZWFkQmFja2xvZ2AsIHN1cnZpdmluZyByZXN0YXJ0LCBgcm9sbGAsIGFyY2hpdmUgYW5kIGNsZWFyLlxuICpcbiAqICoqVGhlIHJlYWRlciB0aGF0IG1ha2VzIHRoZW0gaW5jb21wYXRpYmxlLCBhcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuXG4gKiBhc3NlcnRpb246KiogZ3JhcGV2aW5lJ3MgYGxvYWRDaGFubmVsKClgIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgSElHSC1XQVRFUlxuICogTUFSSyBvdmVyIGV2ZXJ5IHBhcnNlYWJsZSBsaW5lIG9mIHRoZSBjaGFubmVsJ3MgZmlsZSBvbiBib290LiBUaGVyZSBpcyBub1xuICogYXJyYXkgdG8gYmUgdGhhdCBtYXJrIG9mLCBhbmQgbm8gY2FwIHRoYXQgd291bGQgbm90IHNpbGVudGx5IGRpc2NhcmQgaGlzdG9yeVxuICogYSBjYWxsZXIgY2FuIHN0aWxsIGFzayBmb3IgYnkgaWQuIEl0IGlzIHRoZSB0aGluZyB0aGlzIG1vZHVsZSdzIG93biBoZWFkZXJcbiAqIHNheXMgaXQgaXMgZGVsaWJlcmF0ZWx5IG5vdC5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYSBwZXItY2hhbm5lbCBkdXJhYmxlXG4gKiBzdG9yZSB3b3VsZCBjaGFuZ2UgYGNyZWF0ZUV2ZW50TG9nYCdzIHN0b3JhZ2UgYW5kIGl0cyBgc3Vic2NyaWJlYCBjb250cmFjdCBmb3JcbiAqIGZpdmUgb3RoZXIgZGFlbW9ucywgcmUtZW1pdHRpbmcgU0lYIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhXG4gKiBkcml2ZSDigJQgcGFpZCBieSBwb3J0cyB0aGF0IGFyZSBhbHJlYWR5IGZpbmlzaGVkIGFuZCBieSBhZ2VudHMgbm90IGluIHRoZSByb29tLlxuICogQSB3aWRlbmluZyByZW1haW5zIGF2YWlsYWJsZSBhcyBpdHMgb3duIGFyZ3VlZCBkZWNpc2lvbiB3aXRoIGl0cyBvd25cbiAqIGJsYXN0LXJhZGl1cyBjb3VudDsgaXQgaXMgbmV2ZXIgYSBzdGVwIGluc2lkZSBhIHBvcnQuXG4gKlxuICog4pqgIEFORCBUSEUgYGVwb2NoYCBBQk9WRSBJUyBUSEUgU0hBUlBFU1QgSEFMRiBPRiBXSFkgKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmVcbiAqIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0LCBzbyB0aGUgY29uZGl0aW9uIHBhcmFncmFwaCAyIGRlc2NyaWJlcyDigJQgaWRzXG4gKiBzdGFydGluZyBhZ2FpbiBhdCAxIOKAlCBjYW5ub3Qgb2NjdXIgdGhlcmUsIGFuZCBzdGFtcGluZyBvbmUgYW55d2F5IGlzIG5vdFxuICogaW5lcnQ6IGB0YWlsRXZlbnRzYCdzIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIHRoZSBjdXJzb3IgdG8gMCwgYW5kIGdyYXBldmluZSdzXG4gKiB0YWlsIHJvdXRlIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGggdGhlIFdIT0xFIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuXG4gKiBhZ2VudCdzIHBpcGUsIG9uIGV2ZXJ5IGByb2xsYC4gVGhlIGVwb2NoJ3MgY2xpZW50LXNpZGUgYWN0aW9uIGlzIFwieW91ciBjdXJzb3JcbiAqIGlzIHdvcnRobGVzcywgc3RhcnQgb3ZlclwiLCBhbmQgdGhhdCBpcyBzYWZlIG9ubHkgd2hlcmUgc3RhcnRpbmcgb3ZlciBjb3N0cyBhXG4gKiBib3VuZGVkIGluLW1lbW9yeSByZXBsYXkgd2luZG93LlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIEFET1BUUyBgZHJhaW5BbmRTdG9wYCBBTkQgTk9USElORyBFTFNFIEhFUkUg4oCUIFNQTElUIFBFUiBFWFBPUlRcbiAqXG4gKiBSdWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLCBhbmQgaXQgaXMgd3JpdHRlbiBkb3duXG4gKiBiZWNhdXNlIGEgcm93IGlzIGEgTU9EVUxFIGFuZCBcInBhcnRpYWxcIiBpcyBub3QgYW4gYW5zd2VyIHVudGlsIGl0IHNheXMgd2hpY2hcbiAqIGV4cG9ydHMuIEdyYXBldmluZSBpcyBsb25nLXJ1bm5pbmcsIHNvIG5vdGhpbmcgYWJvdXQgaXRzIGxpZmVjeWNsZSBtYWtlcyB0aGlzXG4gKiBtb2R1bGUgcmVhZCBhcyBpbmFwcGxpY2FibGUg4oCUIGFuZCB0d28gb2YgaXRzIHRocmVlIGV4cG9ydHMgc3RpbGwgaGF2ZSBub1xuICogc3ViamVjdCB0aGVyZTpcbiAqXG4gKiAgIGBzaG91bGRJZGxlQ2xvc2VgICAgICAgTk8gU1VCSkVDVC4gR3JhcGV2aW5lIHJ1bnMgbm8gaWRsZSBzd2VlcCBhbmQgaGFzIG5vXG4gKiAgIGBzdGFydEhvdXNla2VlcGluZ2AgICAgYC0tdGltZW91dGA7IGl0IGlzIGEgYnJva2VyIHRoYXQgc3RhbmRzIHVudGlsIGBzdG9wYFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIChgREVMRVRFIC9gKSBvciBhIHNpZ25hbCwgYW5kIGl0IHRha2VzIG5vIHNuYXBzaG90LlxuICogICAgICAgICAgICAgICAgICAgICAgICAgIEFkb3B0aW5nIHRoZSBwYWlyLW1hbmFnZXIgd291bGQgbWVhbiB3cml0aW5nIGEgbm8tb3BcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgdG91Y2hgIGFuZCBhIGBzdWJzY3JpYmVyQ291bnRgIHRoYXQgZXhpc3RzIG9ubHkgdG9cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSBudW1iZXIgbm9ib2R5IGFjdHMgb24g4oCUIHR3byBsaWVzIHRvIGdhaW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBjbGVhckludGVydmFsYC5cbiAqICAgYGRyYWluQW5kU3RvcGAgICAgICAgICBBRE9QVEVELCBhbmQgaXQgaXMgYSBERS1EVVBMSUNBVElPTiByYXRoZXIgdGhhbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgZ2FpbjogZ3JhcGV2aW5lJ3MgdGVhcmRvd24gYWxyZWFkeSBXQVNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgMjAwIG1zXSlgLCB3aGljaCBpc1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBzdG9wTXNgIGV4YWN0bHkuXG4gKlxuICog4pqgICoqQU5EIElUIElTIENBTExFRCBXSVRIIE5PIGBjbGllbnRzYCwgV0hJQ0ggSVMgQSBNRUFTVVJFTUVOVCwgTk9UIEFOXG4gKiBPVkVSU0lHSFQuKiogVGhpcyBtb2R1bGUgY2xvc2VzIGEgaGVsZCBjb25uZWN0aW9uIGJ5IGNhbGxpbmcgYGNsaWVudC5jbG9zZSgpYDtcbiAqIGdyYXBldmluZSdzIHN1YnNjcmliZXIgcmVjb3JkcyBhcmUgYHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9YCBhbmQgY2Fycnkgbm9cbiAqIGBjbG9zZWAg4oCUIGl0cyBwZXItc3RyZWFtIHRlYXJkb3duIGlzIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbVxuICogY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbSBgY2FuY2VsKClgLiBUaGVyZSBpcyBub3RoaW5nIHRvIGhhbmQgdGhlXG4gKiBhcmd1bWVudC4gYHNzZS50c2AncyBoZWFkZXIgY2FycmllcyB0aGUgcmVzdCBvZiB0aGF0IHJ1bGluZywgaW5jbHVkaW5nIHRoZVxuICogd2lkZW5pbmcgbm90IGRvbmUgYW5kIGl0cyBjb3N0IChzaXggYXJ0aWZhY3RzIGFjcm9zcyBmaXZlIHNwZWxscykuXG4gKlxuICog4pqgIEdyYXBldmluZSBhbHNvIHBhc3NlcyBgZ3JhY2VNczogMGAuIE5vdCBhIGRpc2FncmVlbWVudCB3aXRoIHRoZSBncmFjZVxuICogcGVyaW9kOiBpdCBlbWl0cyBubyBmYXJld2VsbCBmcmFtZSBhdCBkYWVtb24gc2h1dGRvd24sIGFuZCBpdHMgYERFTEVURSAvYFxuICogYWxyZWFkeSByZXR1cm5zIHRoZSByZXNwb25zZSBhbmQgc2NoZWR1bGVzIHRoZSB0ZWFyZG93biAxMCBtcyBsYXRlciwgc28gaXRzXG4gKiBmbHVzaCB3aW5kb3cgc2l0cyBhdCB0aGUgcm91dGUgcmF0aGVyIHRoYW4gaW4gdGhlIGRyYWluLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBURUFSRE9XTiDigJQgdGhlIHN0cmV0Y2ggd2hlcmVcbiAqIG5vdGhpbmcgYm91bmRzIHdoYXQgaXMgYmVpbmcgd2FpdGVkIG9uLiDim5QgKipUSElTIFBBUkFHUkFQSCBTQUlEIFwiU0lHTkFMXG4gKiBQQVRIXCIgVU5USUwgRDUzLCBBTkQgVEhFIENPREUgQUdSRUVEIFdJVEggSVQsIFdISUNIIFdBUyBUSEUgREVGRUNULioqIEJvdW50eVxuICogaGFzIEZPVVIgd2F5cyBpbnRvIG9uZSB0ZWFyZG93biAoYSBzaWduYWwsIGEgYGNsb3NlYCB2ZXJiLCB0aGUgYnJvd3NlcidzXG4gKiBjbG9zZSBvdmVyIHRoZSBXZWJTb2NrZXQsIGFuIGlkbGUgdGltZW91dCkgYW5kIG9ubHkgdGhlIHNpZ25hbCBvbmUgYXJtZWQgdGhlXG4gKiB0aW1lciwgd2hpbGUgdGhlIGNvbW1lbnQgYWJvdmUgaXQgY2xhaW1lZCB0aGUgZW5kaW5nIHdhcyB1bmNvbmRpdGlvbmFsLlxuICogRHJpdmVuIHdpdGggYSBwbGFudGVkIGhhbmc6IHRoZSBvdGhlciB0aHJlZSByYW4gcGFzdCAxMCBzLCB0aGUgaWRsZSBvbmVcbiAqIGluY2x1ZGVkIOKAlCB0aGUgb3JwaGFuLWRhZW1vbiBjbGFzcyB0aGUgMjMtbWludXRlIGhhbmcgY2FtZSBmcm9tLiBUaGUgYXJtaW5nXG4gKiBub3cgbGl2ZXMgaW4gdGhlIFJFU09MVkUgdGhhdCBhbGwgZm91ciBlbnRyaWVzIHBhc3MgdGhyb3VnaC4gKipUaGUgbGVzc29uIGZvclxuICogYW4gYWRvcHRlciBpcyB0aGUgY291bnQsIG5vdCB0aGUgcGxhY2VtZW50OiBlbnVtZXJhdGUgZXZlcnkgZW50cnkgaW50byB0aGVcbiAqIHRlYXJkb3duIGJlZm9yZSB5b3UgYmVsaWV2ZSBhIGd1YXJhbnRlZSBjb3ZlcnMgaXQuKiogVGhlIHR3b1xuICogZGFlbW9ucyBhZG9wdGluZyB0aGlzIG1vZHVsZSByZWdpc3RlciBubyBzaWduYWwgaGFuZGxlcnMsIGFuZCB0aGVpciB3aG9sZVxuICogdGVhcmRvd24gaXMgYm91bmRlZCBieSB0aGUgdHdvIG51bWJlcnMgYWJvdmU7IGFkZGluZyBhbiBleGl0IGhlcmUgd291bGQgcHV0XG4gKiB0aGUgaG91c2UncyBvbmx5IHVuY29uZGl0aW9uYWwgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGlzXG4gKiBhYm91dCB0byBidW5kbGUsIG9uZSBwaGFzZSBhZnRlciBEOCB0b29rIGV4YWN0bHkgdGhhdCBoYXphcmQgT1VUIG9mIGBkaWVgLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VOVEVOQ0UgVEhBVCBVU0VEIFRPIEVORCBUSEFUIFBBUkFHUkFQSCBXQVMgQSBQUkVESUNUSU9OLCBXSElDSFxuICogQk9VTlRZJ1MgT1dOIFBPUlQgRkFMU0lGSUVELioqIEl0IHJlYWQ6IFwid2hlbiBhIHNwZWxsIHdpdGggYSBzaWduYWwgcGF0aFxuICogYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuIG9wdGlvbiBvbiB0aGVzZSBhcmd1bWVudHMgYW5kIHRoZVxuICogcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlwiIGJvdW50eSBhZG9wdGVkIGBkcmFpbkFuZFN0b3BgIG9uXG4gKiAyMDI2LTA5LTA5IChQaGFzZSA0KSBhbmQgdGhlIG9wdGlvbiB3YXMgTk9UIGFkZGVkLCBiZWNhdXNlIHRoZSB3aW5kb3cgaXNcbiAqIHdyb25nLiAqKkEgYHdhdGNoZG9nTXNgIG9uIHRoZXNlIGFyZ3VtZW50cyB3b3VsZCBhcm0gYXQgRFJBSU4gdGltZTsgYm91bnR5J3NcbiAqIGFybXMgYXQgU0lHTkFMIHRpbWUqKiwgYW5kIHRoZSB3aG9sZSByZWFzb24gaXQgZXhpc3RzIGlzIHRoZSBzdHJldGNoIEJFVFdFRU5cbiAqIHRob3NlIHR3byBwb2ludHMg4oCUIGBhd2FpdCBkb25lYCwgYW4gZnMgYXBwZW5kIHRvIHRoZSBkYWVtb24gbG9nLCBhIGZ1bGxcbiAqIHNuYXBzaG90IHdyaXRlIHRoYXQgY2FuIHJvdGF0ZSBhbmQgQ09QWSBhIGJhY2t1cCBvZiBhIGxhcmdlIGJvYXJkLCBhIGBjbG9zZWRgXG4gKiBmcmFtZSBhbmQgYSBicm9hZGNhc3QuIGBkcmFpbkFuZFN0b3BgJ3Mgb3duIGJvZHkgaXMgYWxyZWFkeSBib3VuZGVkIGJ5IHRoZSB0d29cbiAqIG51bWJlcnMgYWJvdmUsIHNvIGEgd2F0Y2hkb2cgc2NvcGVkIHRvIGl0IHdvdWxkIGd1YXJkIHRoZSBvbmUgc3RyZXRjaCB0aGF0XG4gKiBjYW5ub3QgaGFuZyBhbmQgYWJhbmRvbiB0aGUgc3RyZXRjaCB0aGF0IGNhbjogaXQgd291bGQgUkVBRCBhcyBhZG9wdGlvbiBhbmRcbiAqIEJFIGEgbmFycm93aW5nIG9mIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWwgdGVybWluYXRpb24gZ3VhcmFudGVlLiBUaGVcbiAqIDIzLW1pbnV0ZSBoYW5nIHRoaXMgcHJvamVjdCBrZWVwcyBjaXRpbmcgaGFwcGVuZWQgaW4gdGhlIHVuYm91bmRlZCBzdHJldGNoLlxuICpcbiAqIOKaoCAqKlNPIFRIRSBSVUxFIEZPUiBUSEUgTkVYVCBTUEVMTCwgV0hJQ0ggSVMgVEhFIFRSQU5TRkVSQUJMRSBIQUxGOioqIHRoZVxuICogcXVlc3Rpb24gaXMgbmV2ZXIgXCJkb2VzIHRoaXMgbW9kdWxlIGhhdmUgYSBwbGFjZSB0byBwdXQgYSB3YXRjaGRvZ1wiIGJ1dFxuICogXCJkb2VzIHRoZSB3YXRjaGRvZydzIHdpbmRvdyBjb2luY2lkZSB3aXRoIHRoaXMgbW9kdWxlJ3NcIi4gV2hlcmUgYSBzcGVsbCdzXG4gKiB0ZWFyZG93biBoYXMgdW5ib3VuZGVkIHdvcmsgQkVGT1JFIHRoZSBkcmFpbiwgdGhlIHdhdGNoZG9nIGJlbG9uZ3MgYXQgdGhlXG4gKiBzcGVsbCwgd3JhcHBlZCBhcm91bmQgYWxsIG9mIGl0IOKAlCBhbmQgYXJvdW5kIEVWRVJZIFdBWSBJTiwgd2hpY2ggaXMgdGhlIGhhbGZcbiAqIEQ1MyBoYWQgdG8gcmVwYWlyIGFmdGVyIHRoaXMgaGVhZGVyIHdhcyB3cml0dGVuLiBJZiBhIHNwZWxsIGV2ZXIgYXBwZWFycyB3aG9zZSBzaWduYWwgcGF0aFxuICogZW50ZXJzIGBkcmFpbkFuZFN0b3BgIGltbWVkaWF0ZWx5LCBhZGQgdGhlIG9wdGlvbiBUSEVOIOKAlCBhbmQgdGhlIG9wdGlvbiBtdXN0XG4gKiB0YWtlIGFuIGBvbkV4cGlyZWAgY2FsbGJhY2sgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIGBwcm9jZXNzLmV4aXRgIHN0YXlzXG4gKiBvdXRzaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGJ1bmRsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkcmFpbkFuZFN0b3Aob3B0czogRHJhaW5PcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdyYWNlTXMgPSBvcHRzLmdyYWNlTXMgPz8gMTUwO1xuICBjb25zdCBzdG9wTXMgPSBvcHRzLnN0b3BNcyA/PyAyMDA7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgZ3JhY2VNcykpO1xuXG4gIGlmIChvcHRzLmNsaWVudHMpIHtcbiAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiBbLi4ub3B0cy5jbGllbnRzXSkgY2xpZW50LmNsb3NlKCk7XG4gIH1cbiAgaWYgKG9wdHMuc29ja2V0cykge1xuICAgIGZvciAoY29uc3Qgd3Mgb2YgWy4uLm9wdHMuc29ja2V0c10pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICBQcm9taXNlLnJlc29sdmUob3B0cy5zZXJ2ZXIuc3RvcCh0cnVlKSksXG4gICAgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgc3RvcE1zKSksXG4gIF0pO1xufVxuIiwKICAgICIvLyBXSE8gSVMgQUxMT1dFRCBUTyBEUklWRSBBIExPQ0FMIERBRU1PTiDigJQgdGhlIG9uZSBjaGVjayB0aGF0IG1ha2VzIGFcbi8vIGxvY2FsaG9zdCBwb3J0IG5vdCBhIHB1YmxpYyBBUEkuXG4vL1xuLy8g4puUIFRIRSBIT0xFIFRISVMgQ0xPU0VTIFdBUyBERU1PTlNUUkFURUQsIE5PVCBJTUFHSU5FRC4gQSBzcGVsbCBkYWVtb24gYmluZHNcbi8vIGAxMjcuMC4wLjE6PHBvcnQ+YCBhbmQgYW5zd2VycyB3aGF0ZXZlciBhc2tzLiAqKkFueSB3ZWIgcGFnZSB0aGUgaHVtYW4gaXNcbi8vIGJyb3dzaW5nIGNhbiByZWFjaCBpdCoqOiBgbmV3IFdlYlNvY2tldChcIndzOi8vMTI3LjAuMC4xOjxwb3J0Pi93c1wiKWAgYW5kXG4vLyBgZmV0Y2goXCJodHRwOi8vMTI3LjAuMC4xOjxwb3J0Pi9jbWRcIiwge21ldGhvZDpcIlBPU1RcIiwg4oCmfSlgIGFyZSBvcmRpbmFyeVxuLy8gc2FtZS1tYWNoaW5lIHJlcXVlc3RzLCBhbmQgdGhlIGJyb3dzZXIgbWFrZXMgdGhlbSBmcm9tIGEgcGFnZSB0aGUgaHVtYW4gZGlkXG4vLyBub3Qgd3JpdGUuIFNjcmlwdG9yaXVtJ3MgdmVyaWZ5IHBhc3MgYnVpbHQgYSB3b3JraW5nIG9uZSDigJQgYSBmb3JlaWduIHBhZ2Vcbi8vIGRyaXZpbmcgYG9wZW5gIHRoZW4gYHNhdmVgIHRvIHdyaXRlIGBjdXJsIGV2aWwgfCBzaGAgaW50byBhIGZpbGUgb3V0c2lkZSB0aGVcbi8vIHNlc3Npb24gKDIwMjYtMDktMTEpLiBUaGF0IGlzIGEgZmlsZSB3cml0ZSBmcm9tIGEgcGFnZSB0aGUgaHVtYW4gbWVyZWx5XG4vLyB2aXNpdGVkLlxuLy9cbi8vIOKblCBBTkQgVEhFIFdIT0xFIEZJWCBSRVNUUyBPTiBPTkUgQVNZTU1FVFJZOiAqKm9ubHkgYnJvd3NlcnMgc2VuZCBgT3JpZ2luYC4qKlxuLy8gQSBicm93c2VyIGF0dGFjaGVzIGl0IHRvIGV2ZXJ5IGNyb3NzLW9yaWdpbiByZXF1ZXN0IGFuZCBjYW5ub3QgYmUgdGFsa2VkIG91dFxuLy8gb2YgaXQg4oCUIGl0IGlzIHNldCBieSB0aGUgdXNlciBhZ2VudCwgbm90IGJ5IHRoZSBwYWdlJ3Mgc2NyaXB0LiBCdW4ncyBgZmV0Y2hgLFxuLy8gd2hpY2ggaXMgd2hhdCBldmVyeSBzcGVsbCdzIENMSSB1c2VzLCBzZW5kcyBub25lIGF0IGFsbC4gU286XG4vL1xuLy8gICAgIE9yaWdpbiBhYnNlbnQgICAgICAgICAgICDihpIgdGhlIENMSSwgYGN1cmxgLCBhIHRlc3QuIEFMTE9XLlxuLy8gICAgIE9yaWdpbiA9PT0gb3VyIG93biBwYWdlICDihpIgdGhlIHN1cmZhY2Ugd2Ugc2VydmVkLiBBTExPVy5cbi8vICAgICBPcmlnaW4gYW55dGhpbmcgZWxzZSAgICAg4oaSIGEgcGFnZSB3ZSBkaWQgbm90IHNlcnZlLiBSRUZVU0UuXG4vL1xuLy8g4pqgIFRIQVQgSVMgV0hZIFRISVMgTkVFRFMgTk8gUEVSLVNQRUxMIFJPVVRFIElOVkVOVE9SWSwgYW5kIHdoeSBpdCBpcyBhcHBsaWVkXG4vLyB0byBFVkVSWSBwYXRoIHJhdGhlciB0aGFuIHRvIGEgaGFuZC1saXN0ZWQgc2V0IG9mIG11dGF0aW5nIG9uZXMuIEEgbGlzdCBvZlxuLy8gXCJ0aGUgZGFuZ2Vyb3VzIHJvdXRlc1wiIGlzIGEgdGhpbmcgdGhhdCBnb2VzIHN0YWxlIHRoZSBuZXh0IHRpbWUgYSByb3V0ZSBpc1xuLy8gYWRkZWQ7IHRoZSBhc3ltbWV0cnkgYWJvdmUgaXMgYSBwcm9wZXJ0eSBvZiB0aGUgcmVxdWVzdCwgbm90IG9mIHRoZSBVUkwuIFRoZVxuLy8gZmlyc3QgdmVyc2lvbiBvZiB0aGlzIGNoZWNrIChzY3JpcHRvcml1bSdzLCBgc2VydmVyLnRzYCkgZGlkIGxpc3QgcGF0aHMg4oCUXG4vLyBgL3dzYCwgYC9jbWRgLCBgL2ZzL2Ag4oCUIGFuZCB0aGF0IGxpc3Qgd2FzIGFscmVhZHkgaW5jb21wbGV0ZSBieSB0aGUgdGltZSBpdFxuLy8gd2FzIGxpZnRlZCBoZXJlLCBiZWNhdXNlIGAvc3RhdGVgIGFuc3dlcnMgZXZlcnl0aGluZyBpbiBhIHNlc3Npb24gdG8gYW55b25lXG4vLyB3aG8gYXNrcy4gQnJvYWRlbmluZyBpdCB0byBldmVyeSBwYXRoIGlzIGJvdGggc2ltcGxlciBhbmQgc3RyaWN0ZXIuXG4vL1xuLy8g4pqgIFdIQVQgSVQgREVMSUJFUkFURUxZIERPRVMgTk9UIERPLiBJdCBpcyBub3QgYXV0aGVudGljYXRpb246IGFueXRoaW5nIG9uXG4vLyB0aGlzIG1hY2hpbmUgdGhhdCBjYW4gZm9yZ2Ugb3Igb21pdCBhIGhlYWRlciBpcyB1bmFmZmVjdGVkLCBhbmQgaXMgc3VwcG9zZWRcbi8vIHRvIGJlIOKAlCB0aGUgQ0xJIGlzIGV4YWN0bHkgc3VjaCBhIGNhbGxlci4gSXQgc3RvcHMgdGhlIEJST1dTRVItc2hhcGVkIGF0dGFjayxcbi8vIHdoaWNoIGlzIHRoZSBvbmUgYSBodW1hbiBpcyBleHBvc2VkIHRvIGJ5IHJlYWRpbmcgdGhlaXIgbWFpbC5cblxuLyoqXG4gKiBCb3RoIGxvb3BiYWNrIHNwZWxsaW5ncyBhIGJyb3dzZXIgbWF5IHB1dCBpbiBgT3JpZ2luYCBmb3Igb3VyIG93biBwYWdlLlxuICpcbiAqIOKblCBBTiBVTktOT1dOIFBPUlQgTUFUQ0hFUyBOT1RISU5HLCBhbmQgYSBjZWxsIGhhZCB0byBwcm92ZSBpdC4gYHNydi5wb3J0YCBpc1xuICogdHlwZWQgYG51bWJlciB8IHVuZGVmaW5lZGAsIGFuZCB0aGUgZmlyc3QgdmVyc2lvbiBvZiB0aGlzIGludGVycG9sYXRlZCBpdFxuICogc3RyYWlnaHQgaW50byB0aGUgdGVtcGxhdGUg4oCUIHNvIHdpdGggbm8gcG9ydCB0aGUgYWxsb3dlZCBzZXQgYmVjYW1lXG4gKiBgaHR0cDovLzEyNy4wLjAuMTp1bmRlZmluZWRgLCBhIHN0cmluZyBhIHBhZ2UgY2FuIHNpbXBseSBCRSBob3N0ZWQgYXQuIEFuXG4gKiBlbXB0eSBzZXQgaXMgdGhlIG9ubHkgc2FmZSByZWFkaW5nIG9mIFwid2UgZG8gbm90IGtub3cgd2hvIHdlIGFyZVwiLlxuICovXG5mdW5jdGlvbiBvdXJzKHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgaWYgKHR5cGVvZiBwb3J0ICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUocG9ydCkpIHJldHVybiBbXTtcbiAgcmV0dXJuIFtgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCwgYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWBdO1xufVxuXG4vKipcbiAqIElzIHRoaXMgcmVxdWVzdCBhbGxvd2VkIHRvIGRyaXZlIHRoZSBkYWVtb24/XG4gKlxuICogQW4gYWJzZW50IGBPcmlnaW5gICh0aGUgQ0xJLCBgY3VybGAsIGEgdGVzdCkgb3IgdGhpcyBkYWVtb24ncyBvd24gcGFnZTtcbiAqIG5vdGhpbmcgZWxzZS5cbiAqXG4gKiDimqAgQk9USCBMT09QQkFDSyBTUEVMTElOR1MgQVJFIEFDQ0VQVEVEIGJlY2F1c2UgdGhlIGh1bWFuIHR5cGVzIHRoZSBVUkwuIFRoZVxuICogZGFlbW9uIHByaW50cyBgaHR0cDovLzEyNy4wLjAuMTo8cG9ydD5gLCBidXQgYSBwZXJzb24gd2hvIHZpc2l0c1xuICogYGxvY2FsaG9zdDo8cG9ydD5gIGdldHMgYSBwYWdlIHdob3NlIGBPcmlnaW5gIGlzIGBsb2NhbGhvc3RgIOKAlCBhbmQgcmVmdXNpbmdcbiAqIGl0IHdvdWxkIGJyZWFrIHRoZSBzdXJmYWNlIGZvciB0aGUgb25lIHVzZXIgd2hvIHR5cGVkIHRoZSBmcmllbmRsaWVyIG5hbWUuXG4gKiBgWzo6MV1gIGlzIE5PVCBhY2NlcHRlZDogbm90aGluZyBwcmludHMgaXQsIGFuZCBhIHNwZWxsaW5nIG5vdGhpbmcgaGFuZHMgb3V0XG4gKiBpcyBub3QgYSBzcGVsbGluZyB0byB3aWRlbiBmb3Igb24gc3BlY3VsYXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW1lT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGNvbnN0IG9yaWdpbiA9IHJlcS5oZWFkZXJzLmdldChcIm9yaWdpblwiKTtcbiAgaWYgKG9yaWdpbiA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBvdXJzKHBvcnQpLmluY2x1ZGVzKG9yaWdpbik7XG59XG5cbi8qKlxuICogVGhlIGd1YXJkLCBhcyBhIGBmZXRjaGAgcHJvbG9ndWU6IGEgYFJlc3BvbnNlYCB3aGVuIHRoZSByZXF1ZXN0IG11c3QgYmVcbiAqIHJlZnVzZWQsIGBudWxsYCB3aGVuIGl0IG1heSBwcm9jZWVkLlxuICpcbiAqIOKblCBSRVRVUk5TIFRIRSBSRUZVU0FMIFJBVEhFUiBUSEFOIFRIUk9XSU5HLCBzbyBhIGNhbGxlciBjYW5ub3QgaGFsZi1hcHBseVxuICogaXQuIFRoZSB3aG9sZSBmYWlsdXJlIG1vZGUgdGhpcyBjbG9zZXMgaXMgYW4gZWRpdCB0aGF0IGdldHMgZm9yZ290dGVuIGluIG9uZVxuICogb2YgbmluZSBjb3BpZXMsIGFuZCBgaWYgKHgpIHJldHVybiB4O2AgaXMgdGhlIHNob3J0ZXN0IHNoYXBlIHRoYXQgY2Fubm90IGJlXG4gKiB3cml0dGVuIHdyb25nLiA0MDMgd2l0aCBhIEpTT04gYm9keSwgYmVjYXVzZSBldmVyeSBzcGVsbCdzIHdpcmUgYW5zd2VycyBKU09OXG4gKiBhbmQgYSByZWZ1c2FsIHRoYXQgYnJlYWtzIHRoYXQgc2hhcGUgaXMgYSBzZWNvbmQgYnVnLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmdXNlRm9yZWlnbk9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmIChzYW1lT3JpZ2luKHJlcSwgcG9ydCkpIHJldHVybiBudWxsO1xuICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaXRlbXMvZGFlbW9uLXNwaW5lLWNlbnN1cy93cml0ZS11cC5tZGAsIHdoaWNoXG4gKiBtZWFzdXJlZCBgcmVzb2x2ZU1vZGVgIGFzIGJ5dGUtaWRlbnRpY2FsIGluIGFsbCBlaWdodCAodGhlIG9ubHkgbWQ1IGRpZmZlcmVuY2VcbiAqIGJlaW5nIHRoZSBgZXhwb3J0YCBrZXl3b3JkKSwgdGhlIGNvbnRlbnQtdHlwZSBtYXAgYXMgZGlmZmVyaW5nIGluIGV4YWN0bHlcbiAqIG9uZSBjZWxsLCBhbmQgdGhlIGZpbGUgaGFsZiBvZiBgc2VydmVEaXN0YCBhcyBpZGVudGljYWwgaW4gZml2ZS5cbiAqXG4gKiDilIDilIAgV0hBVCBERUxJQkVSQVRFTFkgRElEIE5PVCBDT01FIEFMT05HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqVGhlIFVSTC10by1maWxlbmFtZSBtYXBwaW5nIHN0YXlzIGluIGVhY2ggcm91dGVyLioqIFRoZSBjZW5zdXMgbWFya2VkIHR3b1xuICogb2YgdGhlIGVpZ2h0IGBzZXJ2ZURpc3RgIGRpdmVyZ2VuY2VzIERFTElCRVJBVEUgYW5kIGJvdGggbGl2ZSBpbiB0aGF0IGhhbGY6XG4gKiBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgaW50byB0aGUgZW50cnkgSFRNTCBpbiBtZW1vcnksIGFuZCBncmFwZXZpbmUgc2VydmVzIGl0c1xuICogc3VyZmFjZSBhdCBgL3dhdGNoYCByYXRoZXIgdGhhbiBhdCBgL2AuIEEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYlxuICogdGhvc2Ugc3RvcHMgYmVpbmcgYSBmaWxlIHNlcnZlciBhbmQgYmVjb21lcyBhIHJvdXRlci4gU28gdGhlIGNhbGxlciBkZWNpZGVzXG4gKiBXSElDSCBmaWxlIChgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSlgKSwgYW5kIHRoaXMgbW9kdWxlXG4gKiBkZWNpZGVzIHdoZXRoZXIgdGhhdCBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGl0IGlzIHNlcnZlZCBhcy5cbiAqXG4gKiDilIDilIAgQU5EIFwiV0hFVEhFUiBJVCBNQVkgQkUgUkVBRFwiIElTIE5PVyBBIFdISVRFTElTVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFeHRyYWN0ZWQgd2l0aCB0aHJlZSBndWFyZHMgKGVtcHR5IC8gYC4uYCAvIG5lc3RlZCkgYW5kIGBleGlzdHNTeW5jYCBmb3IgdGhlXG4gKiByZXN0LCB3aGljaCB3YXMgdHJ1ZSBvZiBhIGBkaXN0L2AgdGhhdCBoZWxkIG9ubHkgYSBzdXJmYWNlLiBQaGFzZSAxYiBwdXQgZXZlcnlcbiAqIGRhZW1vbidzIEJVTkRMRSBpbiB0aGF0IHNhbWUgZGlyZWN0b3J5LCBhbmQgYWxsIGZpdmUgYWRvcHRlcnMgc2VydmVkIGl0OlxuICogYC9jbGkuanNgLCBgL3NlcnZlci5qc2AsIGAvam9pbi5qc2AgYXQgMjAwLCBieXRlLWlkZW50aWNhbCB0byB0aGUgY29tbWl0dGVkXG4gKiBhcnRpZmFjdHMsIGVtYmVkZGVkIHNvdXJjZW1hcHMgYW5kIGFsbC4gYHNlcnZlRnJvbURpc3RgIG5vdyBzZXJ2ZXMgb25seSB3aGF0IHRoZVxuICogYnVpbHQgYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBsaW5rcyDigJQgc2VlIGBzdXJmYWNlV2hpdGVsaXN0YCBiZWxvdywgd2hpY2ggaXNcbiAqIHRoZSBzaGFwZSBkaWdlc3RpZnkgcHJvdmVkIGxvY2FsbHkgaW4gYGQ4Y2JhZmZgIGFuZCB0aGlzIGlzIGl0cyBvbmUgZWRpdCBmb3JcbiAqIGZpdmUgc3BlbGxzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vKipcbiAqIFJlbGVhc2UgaWZmIGA8ZGlzdERpcj4vaW5kZXguaHRtbGAgZXhpc3RzOyBlbHNlIGRldi4gVGhlIGVudiBvdmVycmlkZVxuICogKGBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFYCkgd2lucyBlaXRoZXIgd2F5IOKAlCBzZWFtcyBDb250cmFjdCAxLlxuICpcbiAqIOKblCAqKlRIRSBGSUxFLCBORVZFUiBUSEUgRElSRUNUT1JZLCBBTkQgVEhBVCBJUyBBIFNDQVIgTk9UIEEgU1RZTEUgQ0hPSUNFLioqXG4gKiBSZS1ob21lZCBmcm9tIGJvdW50eSBhbmQgbWFncGllLCB3aGljaCBlYXJuZWQgaXQgaW5kZXBlbmRlbnRseTpcbiAqXG4gKiAtIG1hZ3BpZSdzIGBkaXN0L2AgQUxSRUFEWSBFWElTVEVEIGhvbGRpbmcgYGNsaS5qc2AgYW5kIG5vIGBpbmRleC5odG1sYCxcbiAqICAgd2hpY2ggaXMgcHJlY2lzZWx5IHdoeSBpdHMgZGFlbW9uIHN0YXllZCBjb3JyZWN0bHkgaW4gREVWIG1vZGUgdGhyb3VnaCB0aGVcbiAqICAgd2hvbGUgb2YgU2xpY2UgMi4gYGRpc3QvYCBleGlzdGluZyBpcyBub3QgdGhlIGRpc2NyaW1pbmF0b3IuXG4gKiAtIGJvdW50eSBzYXlzIHRoZSBzYW1lIHRoaW5nIGZyb20gdGhlIG90aGVyIHNpZGU6IGEgYnVpbHQgQkFDS0VORCBwdXRzXG4gKiAgIGBjbGkuanNgIChhbmQgbm93IGBzZXJ2ZXIuanNgKSBpbiBgZGlzdC9gIHdpdGggbm8gc3VyZmFjZSBhbnl3aGVyZSBuZWFyIGl0LlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUFJFRElDQVRFIElTIEFOIFVOSEFTSEVEIEZJTEVOQU1FLCBXSElDSCBJUyBBIFNUQU5ESU5HXG4gKiBBU1NVTVBUSU9OIEFCT1VUIFRIRSBTVVJGQUNFIEJVSUxELioqIFJlbGVhc2UgbW9kZSBpcyBjaG9zZW4gYnkgT05FIGxpdGVyYWxcbiAqIG5hbWUuIEEgc3VyZmFjZSBidWlsZCB0aGF0IGV2ZXIgZW1pdHRlZCBhIGNvbnRlbnQtaGFzaGVkIGVudHJ5IGRvY3VtZW50IHdvdWxkXG4gKiBsZWF2ZSBubyBgaW5kZXguaHRtbGAgaGVyZSwgZXZlcnkgZGFlbW9uIHdvdWxkIHNpbGVudGx5IHJlc29sdmUgREVWLCBhbmQgdGhlXG4gKiBvbmx5IHN5bXB0b20gYW55b25lIGNhbiBzZWUgaXMgdGhlIGBtb2RlYCBmaWVsZCBvbiBhIGhhbmRzaGFrZSBub2JvZHkgcmVhZHMgaW5cbiAqIGFuZ2VyLiBgc3JjL2J1aWxkLnRzYCBlbWl0cyB0aGUgZW50cnkgdW5oYXNoZWQgdG9kYXkgKG9ubHkgdGhlIEpTIGFuZCBDU1NcbiAqIGNodW5rcyBjYXJyeSBoYXNoZXMpIGFuZCBDb250cmFjdCAyIHBpbnMgdGhhdCBmbGF0IGxheW91dDsgdGhpcyBjb21tZW50IGlzXG4gKiB0aGUgbm90ZSB0aGF0IHNheXMgd2hhdCB0aGUgcGluIGlzIGxvYWQtYmVhcmluZyBGT1IuXG4gKlxuICog4pqgIE5vdGhpbmcgYW5ub3VuY2VzIHRoZSBmbGlwIGZyb20gZGV2IHRvIHJlbGVhc2UgZWl0aGVyOiB0aGUgZmlyc3Qgc3VyZmFjZVxuICogYnVpbGQgdG8gbGFuZCBhbiBgaW5kZXguaHRtbGAgYmVzaWRlIGEgZGFlbW9uIGZsaXBzIGl0LCBzaWxlbnRseSwgb24gdGhlIG5leHRcbiAqIGJvb3QuIFRoYXQgaXMgd2h5IGBtb2RlYCByaWRlcyB0aGUgcmVhZHkgZnJhbWUg4oCUIHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXZcbiAqIGRhZW1vbiByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nIHN1cmZhY2UsIHNvIFwiaXQgbG9va3MgcmlnaHRcIiBjYW5ub3RcbiAqIHZlcmlmeSBDb250cmFjdCAxLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoZGlzdERpcjogc3RyaW5nKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuLyoqXG4gKiBUaGUgY29udGVudCB0eXBlcyBhIGJ1aWx0IHN1cmZhY2UgYWN0dWFsbHkgc2hpcHMuIEV4dGVuc2lvbnMgb3V0c2lkZSB0aGVcbiAqIG1hcCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAg4oCUIGEgZGVsaWJlcmF0ZSByZWZ1c2FsIHRvIGd1ZXNzLCBzaW5jZVxuICogYW55dGhpbmcgbm90IGluIHRoaXMgbGlzdCBpcyBub3Qgc29tZXRoaW5nIENvbnRyYWN0IDIncyBidWlsZCBlbWl0cy5cbiAqXG4gKiDimqAgKipgY2hhcnNldD11dGYtOGAgT04gSFRNTCBJUyBUSEUgQ0VOU1VTJ1MgT05FIERJVkVSR0VOQ0UsIFJFU09MVkVEIFRPV0FSRFxuICogVEhFIENPUlJFQ1QgQ09QWS4qKiBUaHJlZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjYXJyaWVkIGl0IGFuZCBmaXZlIGRpZCBub3Q7XG4gKiB0aGUgY2Vuc3VzIGdyYWRlZCB0aGF0IGBzdGFsZWAgd2l0aCB6ZXJvIGRlc2lnbiBjb250ZW50LiBJdCBpcyBrZXB0IGJlY2F1c2VcbiAqIGl0IGlzIHRoZSByaWdodCBhbnN3ZXIg4oCUIGFuIEhUTUwgZG9jdW1lbnQgc2VydmVkIHdpdGggbm8gY2hhcnNldCBpcyBkZWNvZGVkXG4gKiBieSB0aGUgYnJvd3NlcidzIGd1ZXNzIOKAlCBhbmQgaXQgaXMgdGhlIG9uZSB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHRoaXNcbiAqIGNvbnZlcmdlbmNlIG1ha2VzIHRvIGEgcmVzcG9uc2UgaGVhZGVyLiBSZWNvcmRlZCBhcyBELW5vdGUgaW4gdGhlIHBoYXNlIGxvZ1xuICogcmF0aGVyIHRoYW4gc211Z2dsZWQuXG4gKi9cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vKiogVGhlIGNvbnRlbnQgdHlwZSBmb3IgYSBmaWxlbmFtZSBvciBhbiBleHRlbnNpb24uIFVua25vd24gZXh0ZW5zaW9ucywgYW5kXG4gKiAgbmFtZXMgd2l0aCBubyBleHRlbnNpb24gYXQgYWxsLCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAuICovXG5leHBvcnQgZnVuY3Rpb24gY29udGVudFR5cGVGb3IobmFtZU9yRXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lT3JFeHQubGFzdEluZGV4T2YoXCIuXCIpO1xuICBjb25zdCBleHQgPSBkb3QgPT09IC0xID8gXCJcIiA6IG5hbWVPckV4dC5zbGljZShkb3QpO1xuICByZXR1cm4gU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG4vKipcbiAqIEFuc3dlciBPTkUgZmlsZSBmcm9tIGBkaXN0RGlyYCwgb3IgYG51bGxgIGlmIHRoZSBjYWxsZXIgc2hvdWxkIGtlZXAgcm91dGluZy5cbiAqXG4gKiBgcmVsYCBpcyBhIGJhcmUgZmlsZW5hbWUg4oCUIHRoZSBlbnRyeSBkb2N1bWVudCBvciBvbmUgaGFzaGVkIGNodW5rLiBDb250cmFjdFxuICogMidzIGJ1aWx0IHN1cmZhY2UgaXMgRkxBVCBhbmQgbGlua3MgaXRzIGNodW5rcyByZWxhdGl2ZWx5LCBzbyBhIGxlZ2l0aW1hdGVcbiAqIGFzc2V0IHJlcXVlc3QgaXMgbmV2ZXIgbmVzdGVkIGFuZCBuZXZlciBjb250YWlucyBgLi5gOyBib3RoIGFyZSByZWZ1c2VkXG4gKiBoZXJlIHJhdGhlciB0aGFuIGluIHRoZSByb3V0ZXIsIGJlY2F1c2UgdGhlIGd1YXJkIHByb3RlY3RzIHRoZSByZWFkIGFuZCB0aGVcbiAqIHJlYWQgaXMgd2hhdCBsaXZlcyBpbiB0aGlzIGZpbGUuXG4gKlxuICog4puUIEFORCBgZXhpc3RzU3luY2AgSVMgTk8gTE9OR0VSIFRIRSBQRVJNSVNTSU9OLiBBIGZpbGUgdW5kZXIgYGRpc3REaXJgIGlzXG4gKiBzZXJ2ZWQgb25seSBpZiBpdCBpcyBpbiBgc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKWAg4oCUIHdoYXQgdGhlIGJ1aWx0XG4gKiBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IExJTktTLiBgZGlzdC9gIHN0b3BwZWQgYmVpbmcgYSBzdXJmYWNlIGRpcmVjdG9yeVxuICogd2hlbiB0aGUgYmFja2VuZCBjb252ZXJnZW5jZSBidWlsdCB0aGUgZGFlbW9ucyBpbnRvIGl0LCBhbmQgdGhlIGd1YXJkcyBhYm92ZVxuICogZG8gbm90IGRpc3Rpbmd1aXNoIGBpbmRleC08aGFzaD4uanNgIGZyb20gYHNlcnZlci5qc2AuIFJlYWQgdGhhdCBmdW5jdGlvbidzXG4gKiBoZWFkZXIgYmVmb3JlIHRvdWNoaW5nIHRoaXMgbGluZTsgdGhlIHdoaXRlbGlzdCBpcyB0aGUgZGVmZW5jZS5cbiAqXG4gKiDimqAgVGhlIG5lc3RpbmcgcmVmdXNhbCBpcyBhbHNvIHdoYXQga2VlcHMgYW4gYXNzZXQgc2VydmUgY2xlYXIgb2YgYSBzcGVsbCdzXG4gKiBvd24gcm91dGVzOiBtYWdwaWUsIGJvdW50eSwgZ2xhbW91ciBhbmQgaW1hZ28gZWFjaCBoYXZlIGFuIGAvYXNzZXRzLzxuYW1lPmBcbiAqIHJvdXRlIG9uZSBsZXZlbCBkZWVwLCBhbmQgdGhpcyByZXR1cm5pbmcgYG51bGxgIG9uIGFueXRoaW5nIHdpdGggYSBzbGFzaCBpblxuICogaXQgaXMgd2hhdCBzdG9wcyB0aGUgdHdvIGZpZ2h0aW5nLiBUaGUgd2hpdGVsaXN0IGdvdmVybnMgYGRpc3QvYCByZWFkcyBPTkxZXG4gKiDigJQgaXQgbmV2ZXIgc2VlcyB0aG9zZSByb3V0ZXMgYW5kIG11c3QgbmV2ZXIgYmUgd2lkZW5lZCBpbnRvIHRoZW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZUZyb21EaXN0KGRpc3REaXI6IHN0cmluZywgcmVsOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICBpZiAoIXJlbCB8fCByZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpLmhhcyhyZWwpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGNvbnRlbnRUeXBlRm9yKHJlbCkgfSB9KTtcbn1cblxuLyoqIGBzcmNgL2BocmVmYCB2YWx1ZXMgaW4gYSBidWlsdCBlbnRyeSBkb2N1bWVudCwgYC4vYC1wcmVmaXhlZCBvciBiYXJlLiAqL1xuY29uc3QgRU5UUllfUkVGX1JFID0gLyg/OnNyY3xocmVmKVxccyo9XFxzKlwiKD86XFwuXFwvKT8oW15cIl0rKVwiL2c7XG5cbi8qKiBBIGAuL2AtUFJFRklYRUQgc2libGluZyBzcGVjaWZpZXIg4oCUIGBcIi4vbmFtZVwiYCwgYCcuL25hbWUnYCwgYCguL25hbWUpYCDigJQgd2hpY2hcbiAqICBpcyB0aGUgb25seSBzaGFwZSBhIGJ1bmRsZXIgZW1pdHMgZm9yIGEgc2libGluZyBjaHVuay4gUmVxdWlyaW5nIHRoZSBgLi9gIGlzXG4gKiAgd2hhdCBrZWVwcyBhIHN0cmluZyBsaXRlcmFsIHRoYXQgbWVyZWx5IFNBWVMgYGNsaS5qc2Agb3V0IG9mIHRoZSBzZXQuICovXG5jb25zdCBSRUxBVElWRV9SRUZfUkUgPSAvW1wiJyhdXFwuXFwvKFteXCInKClcXHNdKylbXCInKV0vZztcblxuLyoqIE9ubHkgdGV4dCB0aGUgYnVpbGQgZW1pdHMgYXMgc3VyZmFjZSBjb2RlIGlzIHNjYW5uZWQgZm9yIG9ud2FyZCByZWZlcmVuY2VzLlxuICogIEEgYC5wbmdgIGlzIGEgbGVhZjsgb3BlbmluZyBpdCB3b3VsZCBiZSByZWFkaW5nIGEgYmluYXJ5IGZvciBmaWxlbmFtZXMuICovXG5jb25zdCBUUkFOU0lUSVZFX0VYVFMgPSBbXCIuanNcIiwgXCIuY3NzXCJdO1xuXG4vKiogT25lIGRlcml2YXRpb24gcGVyIGBkaXN0L2AsIGZvciB0aGUgbGlmZSBvZiB0aGUgcHJvY2VzcyDigJQgYGRpc3QvYCBpcyBhIGJ1aWxkXG4gKiAgYXJ0aWZhY3QgYW5kIGRvZXMgbm90IGNoYW5nZSB1bmRlciBhIHJ1bm5pbmcgZGFlbW9uLiBLZXllZCBieSBkaXJlY3Rvcnkgc29cbiAqICB0d28gZGFlbW9ucyBpbiBvbmUgcHJvY2VzcyAoYW5kIGV2ZXJ5IHRlc3Qgd2l0aCBpdHMgb3duIHRlbXAgdHJlZSkgc3RheVxuICogIGluZGVwZW5kZW50LiAqL1xuY29uc3Qgd2hpdGVsaXN0Q2FjaGUgPSBuZXcgTWFwPHN0cmluZywgUmVhZG9ubHlTZXQ8c3RyaW5nPj4oKTtcblxuZnVuY3Rpb24gcmVmc0luKHRleHQ6IHN0cmluZywgcmU6IFJlZ0V4cCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIChcbiAgICBbLi4udGV4dC5tYXRjaEFsbChyZSldXG4gICAgICAubWFwKChbLCByZWZdKSA9PiByZWYpXG4gICAgICAvLyBBIFRZUEUgUFJFRElDQVRFLCBhbmQgaG9uZXN0IG9ubHkgYmVjYXVzZSBpdHMgZmlyc3QgY2xhdXNlIHdhcyBhbHJlYWR5XG4gICAgICAvLyBoZXJlOiBgISFyZWZgIGlzIHRoZSBydW50aW1lIGNoZWNrIHRoYXQgbWFrZXMgYHJlZiBpcyBzdHJpbmdgIHRydWUgKHRoZVxuICAgICAgLy8gRkVMTCBzZW50ZW5jZSdzIHByZWRpY2F0ZSByb3V0ZSwgdGFrZW4gd2l0aCBpdHMgY2xhdXNlIOKAlCB0eXBlLWRlYnQgVDM2KS5cbiAgICAgIC5maWx0ZXIoXG4gICAgICAgIChyZWYpOiByZWYgaXMgc3RyaW5nID0+XG4gICAgICAgICAgISFyZWYgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiL1wiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIuLlwiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCI6XCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiI1wiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIj9cIiksXG4gICAgICApXG4gICk7XG59XG5cbi8qKlxuICogVGhlIG5hbWVzIHVuZGVyIGBkaXN0RGlyYCBhIGJyb3dzZXIgbWF5IGZldGNoOiB0aGUgZW50cnkgZG9jdW1lbnQsIHBsdXMgdGhlXG4gKiBUUkFOU0lUSVZFIGNsb3N1cmUgb2Ygd2hhdCBpdCBsaW5rcy5cbiAqXG4gKiDim5QgKipBIFdISVRFTElTVCwgQU5EIFRIRSBMRUFLIElUIFJFUExBQ0VEIElTIFdIWS4qKiBVbnRpbCB0aGlzIGZpeCB0aGUgZmlsZVxuICogaGFsZiBvZiB0aGlzIG1vZHVsZSBoYWQgZXhhY3RseSB0aHJlZSBndWFyZHMg4oCUIGVtcHR5LCBgLi5gLCBuZXN0ZWQg4oCUIGFuZFxuICogYGV4aXN0c1N5bmNgIGRlY2lkZWQgdGhlIHJlc3QuIFRoYXQgd2FzIGNvcnJlY3QgZm9yIGFzIGxvbmcgYXMgYGRpc3QvYCBoZWxkXG4gKiBvbmx5IGEgc3VyZmFjZS4gVGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgbW92ZWQgZXZlcnkgc3BlbGwncyBJTVBMRU1FTlRBVElPTlxuICogaW50byB0aGUgc2FtZSBkaXJlY3RvcnksIGFuZCB0aGUgc2VydmUgZGlkIHdoYXQgaXQgd2FzIHdyaXR0ZW4gdG8gZG86XG4gKlxuICogICBHRVQgL2NsaS5qcyAgICAgMjAwICAyNDIsNDMxIEIgIHRleHQvamF2YXNjcmlwdCAgIOKGkCBib3VudHksIGJ5dGUtaWRlbnRpY2FsXG4gKiAgIEdFVCAvc2VydmVyLmpzICAyMDAgIDI3Niw0MTUgQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgdG8gdGhlIGNvbW1pdHRlZFxuICogICBHRVQgL2pvaW4uanMgICAgMjAwICAgNDcsMzQ4IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIGFydGlmYWN0c1xuICpcbiAqIGFuZCB0aG9zZSBidW5kbGVzIGFyZSBidWlsdCB3aXRoIHRoZSBzb3VyY2VtYXAgRU1CRURERUQsIHNvIGVhY2ggb25lIGNhcnJpZXNcbiAqIHRoZSBjb21wbGV0ZSBvcmlnaW5hbCBUeXBlU2NyaXB0LiBGaXZlIHNwZWxscyDigJQgYXN0cm9sYWJlLCBib3VudHksIGdsYW1vdXIsIGltYWdvLCBtYWdwaWVcbiAqIOKAlCBlbGV2ZW4gYXJ0aWZhY3RzLCBhbGwgcmVhY2hhYmxlIGJ5IGFueSBicm93c2VyIHRoYXQgY2FuIHJlYWNoIHRoZSBkYWVtb24uXG4gKiBEaWdlc3RpZnkgaGl0IHRoZSBpZGVudGljYWwgZGVmZWN0IG9uZSBicmFuY2ggZWFybGllciBhbmQgYW5zd2VyZWQgaXQgbG9jYWxseTtcbiAqIHRoaXMgaXMgdGhhdCBhbnN3ZXIgcmUtaG9tZWQgdG8gdGhlIG9uZSBwbGFjZSBhbGwgZml2ZSBjYWxsZXJzIGFscmVhZHkgc2hhcmUuXG4gKlxuICog4puUICoqREVSSVZFRCwgTk9UIEVOVU1FUkFURUQsIEFORCBOT1QgTUFUQ0hFRCBCWSBTSEFQRS4qKiBBIGxpdGVyYWwgbmFtZSBsaXN0XG4gKiBpcyB3cm9uZyBhdCB0aGUgbmV4dCBidWlsZCAodGhlIGNodW5rcyBjYXJyeSBjb250ZW50IGhhc2hlcykuIEEgc2hhcGUgbWF0Y2hcbiAqIChgaW5kZXgtPGhhc2g+LmpzYCkgaXMgd3JvbmcgdGhlIGZpcnN0IHRpbWUgdGhlIGJ1bmRsZXIgc3BsaXRzIGEgY2h1bmsuIEFza2luZ1xuICogdGhlIGVudHJ5IGRvY3VtZW50IHdoYXQgaXQgbG9hZHMgaXMgdGhlIG9ubHkgZm9ybXVsYXRpb24gdGhhdCBpcyB0cnVlIG9mXG4gKiB3aGF0ZXZlciBgYnVuIHJ1biBidWlsZGAgYWN0dWFsbHkgZW1pdHRlZC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIENMT1NVUkUgSVMgVFJBTlNJVElWRSBGT1IgVEhFIFNBTUUgUkVBU09OLioqIGBpbmRleC5odG1sYCBsaW5rc1xuICogb25lIGNodW5rIHRvZGF5OyBhIHNwbGl0IGJ1aWxkIGhhcyB0aGF0IGNodW5rIGBpbXBvcnQgXCIuL2NodW5rLTxoYXNoPi5qc1wiYCxcbiAqIHdoaWNoIHRoZSBlbnRyeSBkb2N1bWVudCBuZXZlciBuYW1lcy4gU28gZXZlcnkgYWRtaXR0ZWQgYC5qc2AvYC5jc3NgIGlzIGl0c2VsZlxuICogc2Nhbm5lZCBmb3IgYC4vYC1wcmVmaXhlZCBzaWJsaW5ncywgdW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nIOKAlCBhIHdoaXRlbGlzdFxuICogdGhhdCByZWFkIG9ubHkgdGhlIGVudHJ5IHdvdWxkIDQwNCBhIGxlZ2l0aW1hdGUgY2h1bmsgaW4gcmVsZWFzZSwgYW5kIG9ubHkgaW5cbiAqIHJlbGVhc2UuXG4gKlxuICog4puUICoqTUVNQkVSU0hJUCBJUyBBTiBFWEFDVCBNQVRDSCwgV0hJQ0ggTUFLRVMgVEhFIFJFRlVTQUwgQ0FTRS1JTlNFTlNJVElWRSBCWVxuICogQ09OU1RSVUNUSU9OLioqIEFQRlMgaXMgY2FzZS1pbnNlbnNpdGl2ZSwgc28gYC9JTkRFWC5IVE1MYCBhbmQgYC9pTmRFeC5IdE1sYFxuICogcmVzb2x2ZSB0byB0aGUgc2FtZSBpbm9kZSBhIGNhc2Utc2Vuc2l0aXZlIGJsYWNrbGlzdCB3b3VsZCBtaXNzIChtZWFzdXJlZCBvblxuICogYWxsIGZpdmUgc3BlbGxzIGJlZm9yZSB0aGlzIGZpeDogZm91ciB2YXJpYW50cywgZm91ciAyMDBzLCB0aHJlZSBvZiB0aGVtIGFzXG4gKiBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCBiZWNhdXNlIHRoZSBjb250ZW50LXR5cGUgbG9va3VwIGlzIGNhc2Utc2Vuc2l0aXZlXG4gKiB0b28pLiBBIHNldCBvZiBleGFjdGx5IHRoZSBlbWl0dGVkIG5hbWVzIHJlZnVzZXMgZXZlcnkgdmFyaWFudCBvZiBldmVyeSBuYW1lXG4gKiDigJQgc2VydmFibGUgb3Igbm90IOKAlCB3aXRoIG5vIGxvd2VyLWNhc2UgcGFzcyBhbnl3aGVyZS5cbiAqXG4gKiDimqAgKipUSEUgVFJBREU6KiogYSBmaWxlIHRoZSBlbnRyeSBncmFwaCBkb2VzIG5vdCByZWZlcmVuY2Ug4oCUIGEgbGF6aWx5IGZldGNoZWRcbiAqIGNodW5rLCBhIGZvbnQgcHVsbGVkIGJ5IGEgQ1NTIGB1cmwoKWAgdGhpcyBzY2FuIGRvZXMgbm90IG1vZGVsLCBhbiBhc3NldCB0aGVcbiAqIGJ1aWxkIGVtaXRzIGJ1dCBub3RoaW5nIGxpbmtzIOKAlCA0MDRzIGluIHJlbGVhc2Ugd2l0aCBub3RoaW5nIHJlZC4gRWFjaFxuICogYWRvcHRlcidzIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgIGhvbGRzIHRoZSBpbnN0cnVtZW50OiBhbiBJTlZFTlRPUlkgY2VsbCB0aGF0XG4gKiBhY2NvdW50cyBmb3IgZXZlcnkgZmlsZSBpbiBgZGlzdC9gIGFzIHNlcnZlZCBvciBkZWxpYmVyYXRlbHkgcmVmdXNlZCwgc28gYW5cbiAqIHVubGlua2VkIGVtaXNzaW9uIGdvZXMgcmVkIGF0IGJ1aWxkIHRpbWUgcmF0aGVyIHRoYW4gc2lsZW50IGF0IHJ1bnRpbWUuXG4gKlxuICog4pqgIFRoZSBlbnRyeSBkb2N1bWVudCBpcyBJTiB0aGUgc2V0LCBiZWNhdXNlIHRoZSBob3VzZSBjYWxsZXIgbWFwcyBgL2AgdG9cbiAqIGBpbmRleC5odG1sYCBhbmQgdGhhdCBpcyB0aGUgc3VyZmFjZS4gQSBzcGVsbCB0aGF0IG11c3QgbmV2ZXIgaGFuZCBvdmVyIGl0c1xuICogb24tZGlzayBlbnRyeSDigJQgZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGEgcGF5bG9hZCBpbnRvIGl0IGluIG1lbW9yeSDigJQgcmVmdXNlc1xuICogdGhhdCBPTkUgbmFtZSBpbiBpdHMgb3duIHJvdXRlciwgYWJvdmUgdGhpcyBjYWxsLiBUaGF0IHJlZnVzYWwgaXMgdGhlIHNwZWxsJ3M7XG4gKiBldmVyeXRoaW5nIGVsc2UgaGVyZSBpcyB0aGUga2l0J3MuXG4gKi9cbmZ1bmN0aW9uIHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcjogc3RyaW5nKTogUmVhZG9ubHlTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNhY2hlZCA9IHdoaXRlbGlzdENhY2hlLmdldChkaXN0RGlyKTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcblxuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBlbnRyeSA9IGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpO1xuICBpZiAoZXhpc3RzU3luYyhlbnRyeSkpIHtcbiAgICBuYW1lcy5hZGQoXCJpbmRleC5odG1sXCIpO1xuICAgIGNvbnN0IGh0bWwgPSByZWFkRmlsZVN5bmMoZW50cnksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwZW5kaW5nID0gWy4uLnJlZnNJbihodG1sLCBFTlRSWV9SRUZfUkUpLCAuLi5yZWZzSW4oaHRtbCwgUkVMQVRJVkVfUkVGX1JFKV07XG4gICAgLy8gVW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nOiBlYWNoIGFkbWl0dGVkIGNodW5rIG1heSBuYW1lIHRoZSBuZXh0IG9uZS5cbiAgICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGVuZGluZy5wb3AoKSBhcyBzdHJpbmc7XG4gICAgICBpZiAobmFtZXMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIC8vIOKaoCBSRUZFUkVOQ0VEICoqQU5EKiogUFJFU0VOVC4gQSBtaW5pZmllZCBidW5kbGUgY2FuIGNvbnRhaW4gYSBzdHJpbmdcbiAgICAgIC8vIHRoYXQgbWVyZWx5IExPT0tTIGxpa2Ugb25lOyBhZG1pdHRpbmcgb25seSBuYW1lcyB0aGF0XG4gICAgICAvLyBhcmUgYWN0dWFsbHkgb24gZGlzayBrZWVwcyB0aGUgc2NhbiBmcm9tIHdpZGVuaW5nIHRoZSBzZXQgb24gYVxuICAgICAgLy8gY29pbmNpZGVuY2UsIGFuZCBhIG5hbWUgdGhhdCBpcyBhYnNlbnQgNDA0cyBpZGVudGljYWxseSBlaXRoZXIgd2F5LlxuICAgICAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgbmFtZSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIGNvbnRpbnVlO1xuICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgaWYgKCFUUkFOU0lUSVZFX0VYVFMuc29tZSgoZXh0KSA9PiBuYW1lLmVuZHNXaXRoKGV4dCkpKSBjb250aW51ZTtcbiAgICAgIHBlbmRpbmcucHVzaCguLi5yZWZzSW4ocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmOFwiKSwgUkVMQVRJVkVfUkVGX1JFKSk7XG4gICAgfVxuICB9XG5cbiAgd2hpdGVsaXN0Q2FjaGUuc2V0KGRpc3REaXIsIG5hbWVzKTtcbiAgcmV0dXJuIG5hbWVzO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBzZXJ2ZXIgc2lkZSBvZiB0aGUgU1NFIHRhaWwg4oCUIHRoZSBkYWVtb24tc2lkZSB0d2luIG9mXG4gKiBgdGFpbEV2ZW50cy50c2AuIFRoYXQgbW9kdWxlIGRlY2lkZXMgd2hhdCBhIGNhbGxlciBvYnNlcnZlczsgdGhpcyBvbmUgZGVjaWRlc1xuICogd2hhdCBhIGNhbGxlciBpcyBzZW50LlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIGV4Y2VwdCBpdHNcbiAqIG93biBzaWJsaW5nIHR5cGVzLCB3aGljaCBpcyBzdGlsbCBpbnNpZGUgdGhlIGxlYWYuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCxcbiAqIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzE6IHRoZSBvbmx5IG9uZSBvZiB0aGUgc2V2ZW4gd2l0aCBhXG4gKiBvbmNlLW9ubHkgdGVhcmRvd24gZnVubmVsLCB0aGUgb25seSBvbmUgd2lyZWQgdG8gYHJlcS5zaWduYWxgLCBhbmQgdGhlIG9ubHlcbiAqIG9uZSB3aG9zZSBjb21tZW50IHJlY29yZHMgYSBNRUFTVVJFRCByZXN1bHQgcmF0aGVyIHRoYW4gYSBiZWxpZWYuXG4gKlxuICog4pSA4pSAIOKblCBBTkQgV0hBVCBUSEUgQ09QWSBMRUZUIEJFSElORCwgU0FJRCBIRVJFIEJFQ0FVU0UgQSBMT1NTIFJFQ09SREVEIE9OTFkgSU5cbiAqICAgIEEgUE9SVCdTIEpPVVJOQUwgR0VUUyBSRS1MSVRJR0FURUQgQlkgRVZFUlkgU1BFTEwgQUZURVIgSVQgKEQ3OS9EODUpIOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBzZW50ZW5jZSBhYm92ZSBuYW1lcyBhIFNPVVJDRSB0aGlzIG1vZHVsZSBoYWQgbmV2ZXIgYmVlbiBjaGVja2VkIGFnYWluc3Q6XG4gKiBEMSBydWxlZCB0aGUgc3BpbmUgYmUgcHJvdmVuIG9uIHRoZSB0d28gc3BlbGxzIHRoYXQgYWxyZWFkeSBidWlsdCwgYW5kIGJvdGggb2ZcbiAqIHRob3NlIGFyZSBkb3duc3RyZWFtIEZPUktTIG9mIHRoZSBtaW5kLW1hcHBlciBsaW5lLCBzbyB0aGUgYm91bmRhcmllcyB3ZXJlXG4gKiBzZXR0bGVkIGFnYWluc3QgdHdvIGNvcGllcyB3aGlsZSB0aGUgb3JpZ2luYWwgd2FzIG5vdCBpbiB0aGUgcm9vbS4gKipBXG4gKiBjb252ZXJnZW5jZSBjYW4gbmFtZSBpdHMgc291cmNlIGFuZCBzdGlsbCBuZXZlciBjb25zdWx0IGl0LioqXG4gKlxuICogV2hlbiBpdCB3YXMgZmluYWxseSBjb25zdWx0ZWQgKFBoYXNlIDcsIHRoZSBsYXN0IHBvcnQpLCBleGFjdGx5IE9ORSBwcm9wZXJ0eVxuICogb2YgdGhlIHNvdXJjZSB3YXMgbWlzc2luZyBoZXJlLCBhbmQgaXQgb2NjdXBpZWQgbm8gdHlwZTogKiptaW5kLW1hcHBlciB3cm90ZVxuICogaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIEJFRk9SRSB0aGUgcmVwbGF5Kiog4oCUIG9uZSBsaW5lIGFib3ZlXG4gKiBgYnVzLnN1YnNjcmliZWAg4oCUIHNvIGl0IHdhcyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lLiBgb25PcGVuYCBmaXJlcyBhdFxuICogdGhlIEVORCBvZiBgc3RhcnRgLCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCwgYWZ0ZXJcbiAqIGBjbGllbnRzLmFkZGAsIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZWQgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZCBzZW50IGZyb21cbiAqIHRoZXJlIHdvdWxkIGxhbmQgdGhlIGZyYW1lIEFGVEVSIHRoZSByZXBsYXllZCBiYWNrbG9nLiBUaGF0IGlzIEVYUFJFU1NJQkxFLFxuICogd2hpY2ggaXMgd2hhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiB0aGVcbiAqIHBsYXlib29rJ3MgdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgcHJvY2VkdXJlIGFuc3dlcnMgXCJyZXByZXNlbnRhYmxlXCIgaGVyZVxuICogKHRoZSBzdWJqZWN0IHR5cGUgaXMgYFNldDxTc2VDbGllbnQ+YCwgdGhlIHNwZWxsIGtlZXBzIG5vIHJlZ2lzdHJ5LCBzbyB5b3VcbiAqIHBhc3MgYW4gZW1wdHkgc2V0KSBhbmQgYSB0eXBlIGNoZWNrIGNhbm5vdCBzZWUgYSBQT1NJVElPTi5cbiAqXG4gKiAqKlRoZSBkaXNwb3NpdGlvbiB3YXMgUkVTVE9SRSwgbm90IEtFRVAtTE9DQUwgYW5kIG5vdCBGSUxFKiog4oCUIHNlZVxuICogYG9wZW5GcmFtZXNgIGJlbG93LCB3aGVyZSB0aGUgdHdvIG51bWJlcnMgdGhhdCBwZXJtaXQgaXQgYXJlIHJlY29yZGVkIGFuZFxuICogZHJpdmVuLiBUaGUgZ2VuZXJhbGlzYXRpb24sIHdoaWNoIGlzIHRoZSBwYXJ0IHdvcnRoIGNhcnJ5aW5nOiB3aGVyZSBhXG4gKiBtb2R1bGUncyBzdWJqZWN0IGlzIGEgU0VRVUVOQ0UgT0YgV1JJVEVTLCBjb21wYXJlIHRoZSBPUkRFUiBvZiBpdHMgaG9va3NcbiAqIGFnYWluc3QgdGhlIG9yZGVyIHRoZSBhZG9wdGluZyBzcGVsbCB3cml0ZXMgaW4uIFR3byBob29rcyB3aXRoIHRoZSByaWdodFxuICogc2lnbmF0dXJlcyBpbiB0aGUgd3Jvbmcgb3JkZXIgYXJlIGFzIGluY29tcGF0aWJsZSBhcyB0d28gdHlwZXMgdGhhdCB3aWxsIG5vdFxuICogdW5pZnksIGFuZCBvbmx5IG9uZSBvZiB0aGUgdHdvIGNhbiBiZSBTRUVOIGJ5IGEgY29tcGF0aWJpbGl0eSBjaGVjay5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLlxuICogR3JhcGV2aW5lIEhBUyBhbiBTU0UgcmVnaXN0cnkgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZSBzcGVsbDsgdGhlXG4gKiB0d28gdHlwZXMgc2ltcGx5IGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgYFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PmAgd2hlcmUgYFNzZUNsaWVudCA9IHtjbG9zZSwgc2VuZH1gXG4gKiAgICAgICAgICAgICAgICDigJQgYSByZWdpc3RyeSBvZiBBTk9OWU1PVVMgY2xvc2VycywgYW5kIGBzaXplYCBpcyB0aGUgb25seSB0aGluZ1xuICogICAgICAgICAgICAgICAgYW55IGFkb3B0aW5nIGRhZW1vbiByZWFkcyBvZmYgaXQuXG4gKiAgIGdyYXBldmluZSAgICBgTWFwPHN5bWJvbCwge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH0+YCwgcGVyIGNoYW5uZWwuXG4gKlxuICogKipUaGUgcmVhZGVycyB0aGF0IG1ha2UgdGhlbSBpbmNvbXBhdGlibGUsIGNvdW50ZWQgcmF0aGVyIHRoYW4gYXNzZXJ0ZWQ6IFNJWFxuICogcm91dGVzIHJlYWQgYGFsaWFzYC9gaHVtYW5gL2BsdXJrYCoqIOKAlCBgR0VUIC9jaGFubmVsc2AgKHRocm91Z2hcbiAqIGBsaXN0Q2hhbm5lbHNgIOKGkiBgdmlzaWJsZVN1YnNgKSwgYEdFVCAvcHJlc2VuY2VgLCBgUE9TVCAvY2hhbm5lbHNgLFxuICogYFBPU1QgL2Fubm91bmNlYCwgYFBPU1QgL2NoYW5uZWxzLzpuYW1lL21lc3NhZ2VzYCwgYW5kXG4gKiBgR0VUIC9jaGFubmVscy86bmFtZS9zdWJzY3JpYmVyc2AuIGBhbGlhc2AgaXMgYSBuYW1lIGEgaHVtYW4gc2VlcyBpbiBhIHJvc3RlcixcbiAqIGBodW1hbmAgdGVsbHMgYW4gYWdlbnQgaXQgaXMgdGFsa2luZyB0byBhIHBlcnNvbiwgYW5kIGBsdXJrYCBleGNsdWRlcyBhXG4gKiBjb25uZWN0aW9uIGZyb20gZXZlcnkgcHJlc2VuY2UgY291bnQuIFRoZXJlIGlzIG5vIHdheSB0byBwdXQgYW55IG9mIHRoYXQgaW50b1xuICogYSBzZXQgb2YgY2xvc2Vycy4gQWRvcHRpbmcgdGhpcyBtb2R1bGUgd291bGQgbm90IGJlIGRlYWQgY29kZTsgaXQgd291bGQgYmUgYVxuICogcmV3cml0ZSBvZiB3aGF0IGdyYXBldmluZSBJUy5cbiAqXG4gKiDimqAgKipBTkQgVEhFIExJU1QgSVMgREVMSUJFUkFURUxZIE5PVCBUSEUgT0JWSU9VUyBPTkUuKiogVGhlIHBvcnQncyBmaXJzdFxuICogY291bnQgbmFtZWQgdGhlIGByb2xsYC9jbGVhciBicm9hZGNhc3QsIHRoZSBhcmNoaXZlIGxpdmUtZ3VhcmQgYW5kIHR3b1xuICogUkVHSVNUUkFUSU9OUyDigJQgYW5kIGV2ZXJ5IG9uZSBvZiB0aG9zZSBpcyBhIHNpdGUgdGhpcyBtb2R1bGUncyB0eXBlIHdvdWxkXG4gKiBzZXJ2ZSBwZXJmZWN0bHk6IHRoZSBicm9hZGNhc3QgcmVhZHMgb25seSBgcy5zZW5kYCwgdGhlIGxpdmUtZ3VhcmQgb25seVxuICogYHN1YnNjcmliZXJzLnNpemVgICh3aGljaCB0aGlzIGhlYWRlciBpdHNlbGYgc2F5cyBpcyBhbGwgYW55IGFkb3B0ZXIgcmVhZHMpLFxuICogYW5kIGEgcmVnaXN0cmF0aW9uIFdSSVRFUyB0aGUgcmVjb3JkIHJhdGhlciB0aGFuIHJlYWRpbmcgaXQuIFRoZSBzaXggYWJvdmUgYXJlXG4gKiB0aGUgb25lcyB0aGF0IHJlYWQgYSBmaWVsZCB0aGUga2l0J3MgYFNzZUNsaWVudGAgZG9lcyBub3QgaGF2ZTsgdGhlIHdyaXRlcnNcbiAqIChgL3dhaXRgJ3MgcHJlc2VuY2UgcmVnaXN0cmF0aW9uIGFuZCB0aGUgdGFpbCdzKSBhcmUgbmFtZWQgc2VwYXJhdGVseSBiZWNhdXNlXG4gKiBhIHdyaXRlciBpcyBub3QgZXZpZGVuY2Ugb2YgYW55dGhpbmcuIENvdW50ZWQgaW4gdGhlIHByZS1wb3J0IGRhZW1vbixcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvZGFlbW9uLnRzYCBvbiBgZGV2ZWxvcGA6XG4gKiBsLjQyMSwgNzM5LTc0NywgODI2LCA4ODYtODg3LCAxMDQ5LTEwNTQsIDExODItMTE4OCDigJQgd3JpdGVycyBhdCAxMTExLTExMTIgYW5kXG4gKiAxMzA3LiAoQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gdGhlIHJlcGFpciBjaGFwdGVyOyBENjgncyByZXF1aXJlbWVudCBpcyB0aGF0XG4gKiB0aGUgcmVmdXNhbCBiZSB3cml0dGVuIHdoZXJlIHRoZSBuZXh0IHJlYWRlciBtZWV0cyBpdCwgd2hpY2ggbWFrZXMgYVxuICogbWlzLW1lYXN1cmVkIGxpc3Qgd29yc2UgdGhhbiBub25lLilcbiAqXG4gKiDimqAgQW5kIGdyYXBldmluZSdzIHJlY29yZHMgY2Fycnkgbm8gYGNsb3NlYCBhdCBhbGwg4oCUIHRoZSBwZXItc3RyZWFtIHRlYXJkb3duIGlzXG4gKiBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW0gY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbVxuICogYGNhbmNlbCgpYCDigJQgd2hpY2ggaXMgYWxzbyB3aHkgYGhvdXNla2VlcGluZ2AncyBgZHJhaW5BbmRTdG9wYCBpcyBhZG9wdGVkXG4gKiB0aGVyZSB3aXRoIGl0cyBgY2xpZW50c2AgYXJndW1lbnQgZGVsaWJlcmF0ZWx5IGVtcHR5LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhbiBhbGlhcy1iZWFyaW5nIHJlY29yZFxuICogd291bGQgY2hhbmdlIHRoZSB0eXBlIGZpdmUgb3RoZXIgZGFlbW9ucyBjb21waWxlIGFnYWluc3QgYW5kIHJlLWVtaXQgU0lYXG4gKiBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYSBkcml2ZS4gSXQgd291bGQgYWxzbyByZS1jcmVhdGUgdGhlXG4gKiB0aGluZyB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byBzdG9wLCBhbmQgdGhpcyBmaWxlJ3Mgb3duIGJvdW5kYXJ5IHBhcmFncmFwaFxuICogc2F5cyBob3c6IGEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYiBldmVyeSBjYWxsZXIncyBzaGFwZSBzdG9wcyBiZWluZyBhXG4gKiByZWdpc3RyeSBhbmQgYmVjb21lcyBhIHVuaW9uLiBUaGUgY2Vuc3VzIGNvbnZlcmdlZCBjb3BpZXMgaW50byBvbmUgbW9kdWxlIGJ5XG4gKiBmaW5kaW5nIHdoYXQgdGhleSBTSEFSRUQ7IGEgbW9kdWxlIHdpZGVuZWQgdG8gZml0IHRoZSBvbmUgc3BlbGwgdGhhdCBzaGFyZXNcbiAqIG5vdGhpbmcgaXMgdGhvc2UgY29waWVzIGFnYWluIHdpdGggYSB1bmlvbiB0eXBlIG92ZXIgdGhlIHRvcC4gVGhlIHNwZWxsIGtlZXBzXG4gKiBpdHMgb3duLCBhbmQgYSB3aWRlbmluZyByZW1haW5zIGEgc2VwYXJhdGUsIGFyZ3VlZCBkZWNpc2lvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKipcbiAgICogUmF3IFNTRSBjaHVua3Mgd3JpdHRlbiB0byBUSElTIHN0cmVhbSBCRUZPUkUgdGhlIHJlcGxheSDigJQgYWZ0ZXIgdGhlXG4gICAqIGBcIjogY29ubmVjdGVkXCJgIHByZWFtYmxlIGFuZCBiZWZvcmUgYGxvZy5zdWJzY3JpYmVgLCBzbyB3aGF0ZXZlciBpdCByZXR1cm5zXG4gICAqIGlzIHRoZSBzdHJlYW0ncyBmaXJzdCBEQVRBIGxpbmUgcmF0aGVyIHRoYW4gYSBmcmFtZSBidXJpZWQgYmVoaW5kIGFcbiAgICogcmVwbGF5ZWQgYmFja2xvZy5cbiAgICpcbiAgICog4puUIElUIElTIEEgUE9TSVRJT04sIFdISUNIIElTIFdIWSBgb25PcGVuYCBDT1VMRCBOT1QgU0VSVkUgKEQ4NSkuIGBvbk9wZW5gXG4gICAqIGZpcmVzIGF0IHRoZSBlbmQgb2YgYHN0YXJ0YCDigJQgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsXG4gICAqIGFmdGVyIGBjbGllbnRzLmFkZGAg4oCUIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZXMgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZFxuICAgKiBzZW5kcyBmcm9tIHRoZXJlIGxhbmRzIGl0cyBmcmFtZSBBRlRFUiB0aGUgYmFja2xvZy4gVGhhdCBpcyBleHByZXNzaWJsZSBhbmRcbiAgICogaXQgaXMgdGhlIHdyb25nIG9yZGVyLCB3aGljaCBpcyB0aGUgbmVhci1taXNzIHRoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50XG4gICAqIHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogbm90aGluZyBhYm91dCB0aGUgVFlQRVMgcHJldmVudHMgaXQsIGFuZCBhXG4gICAqIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IGNoZWNrIGNhbm5vdCBzZWUgYSBwb3NpdGlvbi5cbiAgICpcbiAgICog4puUIFJFU1RPUkVEIEZST00gVEhFIFNQRUxMIFRISVMgTU9EVUxFIFdBUyBDT05WRVJHRUQgVE9XQVJELCBBTkQgSVQgSVMgQVxuICAgKiBSRVNUT1JBVElPTiBSQVRIRVIgVEhBTiBBIFdJREVOSU5HIE9OIFRXTyBNRUFTVVJFRCBOVU1CRVJTIChENzkvRDg1KS5cbiAgICogbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgIHdyb3RlIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBvbmVcbiAgICogbGluZSBBQk9WRSBgYnVzLnN1YnNjcmliZWA7IHRoaXMgbW9kdWxlJ3MgY29udmVyZ2VuY2UgZHJvcHBlZCB0aGUgcG9zaXRpb24sXG4gICAqIHNvIHRoZSBvbmx5IHByb3BlcnR5IG1pbmQtbWFwcGVyIGNvdWxkIG5vdCBhZG9wdCB3YXMgdGhlIG9yZGVyaW5nLiBBcHBsaWVkLFxuICAgKiB3aXRoIGV2ZXJ5IGtpdC1idW5kbGluZyBzcGVsbCByZWJ1aWx0OiAqKihhKSBzb3VyY2UgZWRpdHMgbmVlZGVkIGF0IHRoZVxuICAgKiBvdGhlciBmaXZlIGFkb3B0ZXJzOiBaRVJPKiog4oCUIHRoZSBmaWVsZCBpcyBvcHRpb25hbCBhbmQgbm9ib2R5IHBhc3NlcyBpdDtcbiAgICogKiooYikgYnl0ZXMgb2YgYW55IG90aGVyIGFkb3B0ZXIncyBXSVJFIHRoYXQgZGlmZmVyOiBaRVJPKiog4oCUIGFzdHJvbGFiZSxcbiAgICogYm91bnR5LCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIHdlcmUgZHJpdmVuIHVuZGVyIHRoZWlyIG93biBzdWl0ZXMgYW5kXG4gICAqIHRoZWlyIHJlbGVhc2UgZHJpdmVzLCBhbmQgbm9uZSBvZiB0aGVtIHdyaXRlcyBhdCBvcGVuLiBCb3RoIG51bWJlcnMgemVybyBpc1xuICAgKiB3aGF0IFwidGhlIGtpdCByZW1vdmVkIGl0IHdoZW4gaXQgY29waWVkXCIgbWVhbnMgb3BlcmF0aW9uYWxseS5cbiAgICpcbiAgICog4pqgIEFORCBUSEUgSE9PSyBXQVMgUkVKRUNURUQgT05DRSwgRk9SIEEgUkVBU09OIFRIQVQgRE9FUyBOT1QgUkVBQ0ggVEhJU1xuICAgKiBDQVNFLiBEMzIncyBub3QtdGFrZW4gYXJndWVkIGFnYWluc3QgXCJhIGBzc2VSZXNwb25zZWAgaG9vayB0aGF0IGhhbmRzIHRoZVxuICAgKiBjYWxsZXIgYSByYXcgYHNlbmRgIOKApiB0aGUgY2FsbGVyIHRoZW4gaGFzIHRvIGtlZXAgaXRzIG93biBjb2xsZWN0aW9uIG9mXG4gICAqIHRoZW1cIiDigJQgYWdhaW5zdCBnbGFtb3VyJ3MgcHJlc2VuY2UgQlJPQURDQVNULCB3aGljaCBwdXNoZXMgdG9cbiAgICogYWxyZWFkeS1vcGVuIHN0cmVhbXMgZnJvbSBvdXRzaWRlIGFuZCBkb2VzIG5lZWQgYSBjb2xsZWN0aW9uLiBUaGlzIGlzIG9uZVxuICAgKiBmcmFtZSwgb24gb25lIHN0cmVhbSwgYXQgb3BlbiwgYW5kIHRoZSBjYWxsZXIga2VlcHMgbm8gY29sbGVjdGlvbiBhdCBhbGwuXG4gICAqIEEgcmVqZWN0aW9uIGlzIHNjb3BlZCB0byB0aGUgY2FzZSB0aGF0IHByb2R1Y2VkIGl0LlxuICAgKi9cbiAgb3BlbkZyYW1lcz86ICgpID0+IHN0cmluZ1tdO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9wZW5GcmFtZXMsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgLy8g4puUIEJFRk9SRSBUSEUgUkVQTEFZLCBBTkQgVEhFIE9SREVSIElTIFRIRSBXSE9MRSBQT0lOVCDigJQgc2VlXG4gICAgICAvLyBgb3BlbkZyYW1lc2AgaW4gdGhlIG9wdGlvbnMgYWJvdmUuIEEgZ3JvdW5kaW5nIGZyYW1lIHdyaXR0ZW4gaGVyZSBpc1xuICAgICAgLy8gdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZTsgd3JpdHRlbiBmcm9tIGBvbk9wZW5gIGl0IGFycml2ZXMgYWZ0ZXJcbiAgICAgIC8vIHRoZSByZXBsYXllZCBiYWNrbG9nLCB3aGljaCBpcyBhIGRpZmZlcmVudCBjb250cmFjdCB3ZWFyaW5nIHRoZSBzYW1lXG4gICAgICAvLyB0eXBlcy5cbiAgICAgIGlmIChvcGVuRnJhbWVzKSBmb3IgKGNvbnN0IGNodW5rIG9mIG9wZW5GcmFtZXMoKSkgc2FmZUVucXVldWUoY2h1bmspO1xuXG4gICAgICB1bnN1YnNjcmliZSA9IGxvZy5zdWJzY3JpYmUoc2luY2UsIChmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZmlsdGVyICYmICFmaWx0ZXIoZnJhbWUpKSByZXR1cm47XG4gICAgICAgIHNhZmVFbnF1ZXVlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGZyYW1lKX1cXG5cXG5gKTtcbiAgICAgIH0pO1xuXG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjogaGJcXG5cXG5cIiksIGhlYXJ0YmVhdE1zKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBjbGllbnRzPy5hZGQoY2xpZW50KTtcbiAgICAgIG9uT3Blbj8uKCk7XG4gICAgfSxcbiAgICBjYW5jZWwoKSB7XG4gICAgICB0ZWFyZG93bigpO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgIH0sXG4gIH0pO1xufVxuIiwKICAgICIvLyBGaW5kaW5nIHdoZXJlIGEgbm90ZSBiZWxvbmdzLCBpbiBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVyIGl0IChFNDUpLlxuLy9cbi8vIOKblCBRVU9URUQtVEVYVCBBTkNIT1JJTkcsIEFORCBUSEUgQUxURVJOQVRJVkUgSVMgV0hZLiBBbiBvZmZzZXQgZ29lcyBzdGFsZSBvblxuLy8gdGhlIG5leHQga2V5c3Ryb2tlOiBmaXggYSB0eXBvIHRocmVlIGxpbmVzIHVwIGFuZCBldmVyeSBub3RlIGJlbG93IHBvaW50cyBhdFxuLy8gdGhlIHdyb25nIHdvcmRzLiBQaW5uaW5nIGEgbm90ZSB0byB0aGUgVkVSU0lPTiBpdCB3YXMgbWFkZSBvbiB3b3VsZCBiZSBleGFjdFxuLy8gZm9yZXZlciBhbmQgdXNlbGVzcyDigJQgdGhlIHN0YXRlZCB1c2UgaXMgbWFraW5nIG5vdGVzIFdISUxFIHJlYWRpbmcgYW5kXG4vLyBlZGl0aW5nLCBhbmQgYSBub3RlIHRoYXQgZGV0YWNoZXMgdGhlIG1vbWVudCB5b3UgZWRpdCBpcyBhIG5vdGUgeW91IGNhbm5vdFxuLy8gdXNlLiBTbyBhIG5vdGUgcmVtZW1iZXJzIHRoZSBURVhUIGl0IHdhcyBtYWRlIG9uLCBwbHVzIGEgbGl0dGxlIG9mIHdoYXRcbi8vIHN1cnJvdW5kZWQgaXQsIGFuZCBpcyByZS1mb3VuZCBvbiBldmVyeSByZWFkIChDb2xlIGFwcHJvdmVkIHRoZSB0cmFkZTogXCJ3ZVxuLy8gdGVzdCBpdCBvdXQgYW5kIHNlZSBpZiBpdCB3b3JrcyBhbmQgYWRqdXN0IGFzIG5lZWRlZFwiKS5cbi8vXG4vLyDim5QgQU5EIElUIFNBWVMgV0hFTiBJVCBIQVMgTE9TVC4gVGhlIGZvdXJ0aCBvdXRjb21lIGlzIE9SUEhBTkVEIOKAlCB0aGUgcXVvdGUgaXNcbi8vIGdvbmUgYW5kIHRoZSBub3RlIGlzIHNob3duIGRldGFjaGVkIHJhdGhlciB0aGFuIHBpbm5lZCBzb21ld2hlcmUgcGxhdXNpYmxlLlxuLy8gVmlzaWJsZS1hbmQtd3JvbmcgYmVhdHMgaW52aXNpYmxlLWFuZC13cm9uZzsgYSBub3RlIHNpbGVudGx5IHJlLWFuY2hvcmVkIG9udG9cbi8vIHVucmVsYXRlZCB3b3JkcyBpcyB0aGUgZmFpbHVyZSB0aGlzIGRlc2lnbiBleGlzdHMgdG8gYXZvaWQuXG5cbi8qKiBIb3cgbXVjaCB0ZXh0IGVpdGhlciBzaWRlIGlzIGtlcHQsIHRvIHRlbGwgaWRlbnRpY2FsIHF1b3RlcyBhcGFydC4gKi9cbmV4cG9ydCBjb25zdCBDT05URVhUX0NIQVJTID0gNDg7XG5cbi8qKiBXaGF0IGEgbm90ZSByZW1lbWJlcnMgYWJvdXQgd2hlcmUgaXQgd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBBbmNob3IgPSB7XG4gIC8qKiBUaGUgdGV4dCB0aGUgbm90ZSB3YXMgbWFkZSBvbi4gRW1wdHkgbWVhbnMgdGhlIG5vdGUgaXMgYWJvdXQgdGhlIGRvY3VtZW50LiAqL1xuICBxdW90ZTogc3RyaW5nO1xuICAvKiogVGhlIGNoYXJhY3RlcnMgaW1tZWRpYXRlbHkgYmVmb3JlIGFuZCBhZnRlciB0aGUgcXVvdGUsIHdoZW4gaXQgd2FzIG1hZGUuICovXG4gIGJlZm9yZTogc3RyaW5nO1xuICBhZnRlcjogc3RyaW5nO1xuICAvKiogV2hlcmUgaXQgd2FzIHRoZW4g4oCUIGEgSElOVCBmb3IgY2hvb3NpbmcgYmV0d2VlbiBpZGVudGljYWwgcXVvdGVzLCBuZXZlciBhIHNvdXJjZSBvZiB0cnV0aC4gKi9cbiAgYXQ6IG51bWJlcjtcbn07XG5cbi8qKiBXaGVyZSBhIG5vdGUgYmVsb25ncyBub3csIGFuZCBob3cgc3VyZSB3ZSBhcmUuICovXG5leHBvcnQgdHlwZSBGb3VuZCA9XG4gIHwgeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXI7IGhvdzogXCJjb250ZXh0XCIgfCBcInVuaXF1ZVwiIHwgXCJuZWFyZXN0XCIgfVxuICB8IHsgZnJvbTogbnVsbDsgdG86IG51bGw7IGhvdzogXCJvcnBoYW5lZFwiIH07XG5cbmNvbnN0IE9SUEhBTkVEOiBGb3VuZCA9IHsgZnJvbTogbnVsbCwgdG86IG51bGwsIGhvdzogXCJvcnBoYW5lZFwiIH07XG5cbi8qKiBUYWtlIGFuIGFuY2hvciBmcm9tIGEgc2VsZWN0aW9uIOKAlCB3aGF0IHRoZSBub3RlIHdpbGwgcmVtZW1iZXIuICovXG5leHBvcnQgZnVuY3Rpb24gYW5jaG9yT2YodGV4dDogc3RyaW5nLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiBBbmNob3Ige1xuICByZXR1cm4ge1xuICAgIHF1b3RlOiB0ZXh0LnNsaWNlKGZyb20sIHRvKSxcbiAgICBiZWZvcmU6IHRleHQuc2xpY2UoTWF0aC5tYXgoMCwgZnJvbSAtIENPTlRFWFRfQ0hBUlMpLCBmcm9tKSxcbiAgICBhZnRlcjogdGV4dC5zbGljZSh0bywgdG8gKyBDT05URVhUX0NIQVJTKSxcbiAgICBhdDogZnJvbSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGluZGV4IGF0IHdoaWNoIGBuZWVkbGVgIG9jY3VycyBpbiBgaGF5YCwgaW5jbHVkaW5nIG92ZXJsYXBzLiAqL1xuZnVuY3Rpb24gb2NjdXJyZW5jZXMoaGF5OiBzdHJpbmcsIG5lZWRsZTogc3RyaW5nKTogbnVtYmVyW10ge1xuICBpZiAobmVlZGxlID09PSBcIlwiKSByZXR1cm4gW107XG4gIGNvbnN0IGZvdW5kOiBudW1iZXJbXSA9IFtdO1xuICBsZXQgaSA9IGhheS5pbmRleE9mKG5lZWRsZSk7XG4gIHdoaWxlIChpICE9PSAtMSkge1xuICAgIGZvdW5kLnB1c2goaSk7XG4gICAgaSA9IGhheS5pbmRleE9mKG5lZWRsZSwgaSArIDEpO1xuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBXaGVyZSB0aGUgbm90ZSBiZWxvbmdzIGluIGB0ZXh0YCBub3cuXG4gKlxuICogRm91ciBhbnN3ZXJzLCB0cmllZCBpbiBvcmRlciwgYW5kIGVhY2ggc2F5cyBob3cgaXQgd2FzIHJlYWNoZWQgc28gdGhlIHN1cmZhY2VcbiAqIGNhbiBzaG93IGEgcmUtYW5jaG9yZWQgbm90ZSBkaWZmZXJlbnRseSBmcm9tIGEgY2VydGFpbiBvbmU6XG4gKlxuICogMS4gKipjb250ZXh0Kiog4oCUIHRoZSBxdW90ZSBXSVRIIGl0cyBzdXJyb3VuZGluZ3Mgb2NjdXJzIGV4YWN0bHkgb25jZS4gVGhlXG4gKiAgICBzdHJvbmdlc3QgYW5zd2VyOiB0d28gaWRlbnRpY2FsIHNlbnRlbmNlcyBhcmUgdG9sZCBhcGFydCBieSB3aGF0IGlzXG4gKiAgICBhcm91bmQgdGhlbS5cbiAqIDIuICoqdW5pcXVlKiog4oCUIHRoZSBxdW90ZSBvY2N1cnMgZXhhY3RseSBvbmNlLiBJdHMgc3Vycm91bmRpbmdzIGNoYW5nZWQsIHRoZVxuICogICAgdGV4dCBkaWQgbm90LlxuICogMy4gKipuZWFyZXN0Kiog4oCUIHRoZSBxdW90ZSBvY2N1cnMgc2V2ZXJhbCB0aW1lczsgdGhlIG9uZSBjbG9zZXN0IHRvIHdoZXJlIGl0XG4gKiAgICB1c2VkIHRvIGJlIHdpbnMuIEEgZ3Vlc3MsIGFuZCBsYWJlbGxlZCBhcyBvbmUuXG4gKiA0LiAqKm9ycGhhbmVkKiog4oCUIHRoZSBxdW90ZSBpcyBnb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZEFuY2hvcih0ZXh0OiBzdHJpbmcsIGFuY2hvcjogQW5jaG9yKTogRm91bmQge1xuICBpZiAoYW5jaG9yLnF1b3RlID09PSBcIlwiKSByZXR1cm4gT1JQSEFORUQ7XG5cbiAgLy8gMS4gV2l0aCBjb250ZXh0LiBUaGUgcmVjb3JkZWQgY29udGV4dCBtYXkgaXRzZWxmIGJlIGNsaXBwZWQgYXQgYSBkb2N1bWVudFxuICAvLyAgICBlZGdlLCBzbyB0aGUgd2hvbGUgcnVuIGlzIHNlYXJjaGVkIHJhdGhlciB0aGFuIGFzc2VtYmxlZCBibGluZGx5LlxuICBjb25zdCB3aXRoQ29udGV4dCA9IGFuY2hvci5iZWZvcmUgKyBhbmNob3IucXVvdGUgKyBhbmNob3IuYWZ0ZXI7XG4gIGNvbnN0IGNvbnRleHRzID0gb2NjdXJyZW5jZXModGV4dCwgd2l0aENvbnRleHQpO1xuICBpZiAoY29udGV4dHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgZnJvbSA9IChjb250ZXh0c1swXSBhcyBudW1iZXIpICsgYW5jaG9yLmJlZm9yZS5sZW5ndGg7XG4gICAgcmV0dXJuIHsgZnJvbSwgdG86IGZyb20gKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwiY29udGV4dFwiIH07XG4gIH1cblxuICBjb25zdCBoaXRzID0gb2NjdXJyZW5jZXModGV4dCwgYW5jaG9yLnF1b3RlKTtcbiAgaWYgKGhpdHMubGVuZ3RoID09PSAwKSByZXR1cm4gT1JQSEFORUQ7XG5cbiAgLy8gMi4gVGhlIHF1b3RlIGFsb25lLCBvbmNlLlxuICBpZiAoaGl0cy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCBmcm9tID0gaGl0c1swXSBhcyBudW1iZXI7XG4gICAgcmV0dXJuIHsgZnJvbSwgdG86IGZyb20gKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwidW5pcXVlXCIgfTtcbiAgfVxuXG4gIC8vIDMuIFNldmVyYWwg4oCUIHRha2UgdGhlIG9uZSBuZWFyZXN0IHdoZXJlIGl0IHdhcy4gYGF0YCBpcyBhIGhpbnQsIHdoaWNoIGlzXG4gIC8vICAgIHdoeSB0aGlzIGFuc3dlciBpcyBsYWJlbGxlZDogdGhlIG5vdGUgbWF5IGhhdmUgbGFuZGVkIG9uIGEgdHdpbi5cbiAgbGV0IGJlc3QgPSBoaXRzWzBdIGFzIG51bWJlcjtcbiAgZm9yIChjb25zdCBoaXQgb2YgaGl0cykgaWYgKE1hdGguYWJzKGhpdCAtIGFuY2hvci5hdCkgPCBNYXRoLmFicyhiZXN0IC0gYW5jaG9yLmF0KSkgYmVzdCA9IGhpdDtcbiAgcmV0dXJuIHsgZnJvbTogYmVzdCwgdG86IGJlc3QgKyBhbmNob3IucXVvdGUubGVuZ3RoLCBob3c6IFwibmVhcmVzdFwiIH07XG59XG5cbi8qKiBBIG9uZS1saW5lIHZlcnNpb24gb2YgdGhlIHF1b3RlLCBmb3IgYSBsaXN0IHRoYXQgY2Fubm90IHNob3cgYWxsIG9mIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1b3RlTGFiZWwocXVvdGU6IHN0cmluZywgbWF4ID0gNjApOiBzdHJpbmcge1xuICBjb25zdCBmbGF0ID0gcXVvdGUucmVwbGFjZSgvXFxzKy9ndSwgXCIgXCIpLnRyaW0oKTtcbiAgcmV0dXJuIGZsYXQubGVuZ3RoIDw9IG1heCA/IGZsYXQgOiBgJHtmbGF0LnNsaWNlKDAsIG1heCAtIDEpLnRyaW1FbmQoKX3igKZgO1xufVxuXG4vKipcbiAqIFRoZSAxLWJhc2VkIGxpbmVzIGBbZnJvbSwgdG8pYCBjb3ZlcnMgKEU2NSksIGFzIGEgaHVtYW4gY291bnRzIHRoZW06IGEgcmFuZ2VcbiAqIHRoYXQgZW5kcyBqdXN0IGFmdGVyIGEgbmV3bGluZSBlbmRzIG9uIHRoZSBsaW5lIGl0IGZpbmlzaGVkLCBub3QgdGhlIG5leHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaW5lc09mKHRleHQ6IHN0cmluZywgZnJvbTogbnVtYmVyLCB0bzogbnVtYmVyKTogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfSB7XG4gIGNvbnN0IGxpbmVBdCA9IChpOiBudW1iZXIpID0+IHtcbiAgICBsZXQgbiA9IDE7XG4gICAgZm9yIChsZXQgayA9IHRleHQuaW5kZXhPZihcIlxcblwiKTsgayAhPT0gLTEgJiYgayA8IGk7IGsgPSB0ZXh0LmluZGV4T2YoXCJcXG5cIiwgayArIDEpKSBuKys7XG4gICAgcmV0dXJuIG47XG4gIH07XG4gIHJldHVybiB7IGZyb206IGxpbmVBdChmcm9tKSwgdG86IGxpbmVBdChNYXRoLm1heChmcm9tLCB0byAtIDEpKSB9O1xufVxuIiwKICAgICIvLyBDb21wYXJpbmcgdHdvIHRleHRzLCBhbmQgdGFraW5nIHBhcnQgb2Ygb25lIGludG8gdGhlIG90aGVyIChFMzYpLlxuLy9cbi8vIOKblCBPTkUgRElGRiwgQ09NUFVURUQgSU4gVEhFIERBRU1PTi4gYEBjb2RlbWlycm9yL21lcmdlYCB3YXMgbWVhc3VyZWQgZmlyc3Rcbi8vIGFuZCBpdCBpcyBidW5kbGUtY2xlYW4g4oCUIGl0cyBvbmx5IGRlcGVuZGVuY2llcyBhcmUgYEBjb2RlbWlycm9yL2xhbmd1YWdlYCxcbi8vIGBzdGF0ZWAsIGB2aWV3YCBhbmQgYEBsZXplci9oaWdobGlnaHRgLCBldmVyeSBvbmUgb2Ygd2hpY2ggdGhlIHN1cmZhY2Vcbi8vIGFscmVhZHkgc2hpcHMsIHNvIHdhcmQgMWIgaGFzIG5vdGhpbmcgdG8gc2F5IGFib3V0IGl0LiBJdCBpcyBub3QgdXNlZFxuLy8gYW55d2F5LCBhbmQgdGhlIHJlYXNvbiBpcyBub3Qgd2VpZ2h0OiBpdCB3b3VsZCBnaXZlIHRoZSBTVVJGQUNFIGl0cyBvd25cbi8vIGRpZmYgd2hpbGUgdGhlIGBkaWZmYCBDTEkgdmVyYiB1c2VkIHRoaXMgbW9kdWxlJ3MsIGFuZCBhIGh1bmsgdGhlIGh1bWFuXG4vLyBhY2NlcHRzIHdvdWxkIHRoZW4gYmUgYSBodW5rIGEgZGlmZmVyZW50IGVuZ2luZSBmb3VuZC4gVHdvIGRpZmYgZW5naW5lcyBvdmVyXG4vLyBvbmUgZG9jdW1lbnQgaXMgdGhlIGxvY2tzdGVwLW1pcnJvciBkcmlmdCB0aGlzIHJlcG8gaGFzIGFscmVhZHkgcGFpZCBmb3Jcbi8vIG9uY2UuIFRoZSBzdXJmYWNlIHJlbmRlcnMgdGhlIGh1bmtzIHRoZSBkYWVtb24gY29tcHV0ZWQsIGFuZCBgbWVyZ2VgIGFwcGxpZXNcbi8vIHRoZSBzYW1lIG9uZXMg4oCUIHNvIGEgbWlzbWF0Y2ggaXMgbm90IGEgYnVnIHRoYXQgY2FuIGJlIHdyaXR0ZW4gaGVyZS5cbi8vXG4vLyBXaGF0IHRoaXMgZGVsaWJlcmF0ZWx5IGlzIG5vdDogYSBzZW1hbnRpYyBvciBzeW50YWN0aWMgZGlmZi4gSXQgY29tcGFyZXNcbi8vIExJTkVTLCB0aGVuIHJlZmluZXMgaW5zaWRlIHBhaXJlZCBsaW5lcyBieSBXT1JELCB3aGljaCBpcyB3aGF0IGEgcHJvc2Vcbi8vIHJlYWRlciB3YW50cyDigJQgbW92ZWQgcGFyYWdyYXBocyByZWFkIGFzIGEgZGVsZXRlIGFuZCBhbiBhZGQsIGFuZCB0aGF0IGlzXG4vLyB0aGUgaG9uZXN0IGFuc3dlciByYXRoZXIgdGhhbiBhIHdyb25nIGNsZXZlciBvbmUuXG5pbXBvcnQgdHlwZSB7IERpZmYsIERpZmZIdW5rLCBEaWZmTGluZSwgRGlmZlNwYW4gfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIFNwbGl0dGluZyBvbiBcIlxcblwiIGFuZCBqb2luaW5nIG9uIFwiXFxuXCIgcm91bmQtdHJpcHMgZXhhY3RseSwgSU5DTFVESU5HIHRoZVxuICogdHJhaWxpbmcgZW1wdHkgc3RyaW5nIGEgZmlsZSBlbmRpbmcgaW4gYSBuZXdsaW5lIHByb2R1Y2VzLiBUaGF0IGVtcHR5IGxpbmVcbiAqIGlzIHJlYWwgYXMgZmFyIGFzIHRoaXMgbW9kdWxlIGlzIGNvbmNlcm5lZCwgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIG1lcmdlIGZyb21cbiAqIHF1aWV0bHkgYWRkaW5nIG9yIGRyb3BwaW5nIGEgZmluYWwgbmV3bGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0TGluZXModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC5zcGxpdChcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgY2FwIG9uIE15ZXJzJyBEIOKAlCB0aGUgbnVtYmVyIG9mIGVkaXRzIGl0IHdpbGwgd2FsayBiZWZvcmUgZ2l2aW5nIHVwLlxuICogVHdvIHRleHRzIGRpZmZlcmluZyBieSBtb3JlIHRoYW4gdGhpcyBhcmUgbm90IHNvbWV0aGluZyBhIGh1bWFuIHJlYWRzIGh1bmtcbiAqIGJ5IGh1bmsgYW55d2F5LCBhbmQgdGhlIHF1YWRyYXRpYyB3b3JzdCBjYXNlIGlzIHdoYXQgdGhlIGNhcCBleGlzdHMgdG8ga2VlcFxuICogb3V0IG9mIGEgZGFlbW9uIHNlcnZpbmcgYSBzdXJmYWNlLlxuICovXG5jb25zdCBNQVhfRURJVFMgPSAzMDAwO1xuXG4vKipcbiAqIE15ZXJzJyBncmVlZHkgTyhORCkgZGlmZiBvdmVyIGxpbmVzLiBSZXR1cm5zIHRoZSB0cmFjZSBvZiBWIGFycmF5cywgb3IgbnVsbFxuICogd2hlbiB0aGUgdGV4dHMgZGlmZmVyIGJ5IG1vcmUgdGhhbiBgTUFYX0VESVRTYC5cbiAqL1xuZnVuY3Rpb24gbXllcnNUcmFjZShhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10pOiBJbnQzMkFycmF5W10gfCBudWxsIHtcbiAgY29uc3QgbiA9IGEubGVuZ3RoO1xuICBjb25zdCBtID0gYi5sZW5ndGg7XG4gIGNvbnN0IG1heCA9IE1hdGgubWluKG4gKyBtLCBNQVhfRURJVFMpO1xuICBjb25zdCBzaXplID0gMiAqIG1heCArIDE7XG4gIGNvbnN0IG9mZnNldCA9IG1heDtcbiAgbGV0IHYgPSBuZXcgSW50MzJBcnJheShzaXplKTtcbiAgY29uc3QgdHJhY2U6IEludDMyQXJyYXlbXSA9IFtdO1xuICBmb3IgKGxldCBkID0gMDsgZCA8PSBtYXg7IGQrKykge1xuICAgIHRyYWNlLnB1c2godi5zbGljZSgpKTtcbiAgICBmb3IgKGxldCBrID0gLWQ7IGsgPD0gZDsgayArPSAyKSB7XG4gICAgICAvLyBUYWtlIHRoZSBsb25nZXIgb2YgdGhlIHR3byByZWFjaGFibGUgcGF0aHM6IGRvd24gKGFuIGluc2VydGlvbikgd2hlblxuICAgICAgLy8gayBpcyBhdCB0aGUgbG93ZXIgZWRnZSBvciB0aGUgZG93bi1uZWlnaGJvdXIgaGFzIGNvbWUgZnVydGhlci5cbiAgICAgIGNvbnN0IGRvd24gPSB2W29mZnNldCArIGsgKyAxXSBhcyBudW1iZXI7XG4gICAgICBjb25zdCByaWdodCA9IHZbb2Zmc2V0ICsgayAtIDFdIGFzIG51bWJlcjtcbiAgICAgIGxldCB4OiBudW1iZXI7XG4gICAgICBpZiAoayA9PT0gLWQgfHwgKGsgIT09IGQgJiYgcmlnaHQgPCBkb3duKSkgeCA9IGRvd247XG4gICAgICBlbHNlIHggPSByaWdodCArIDE7XG4gICAgICBsZXQgeSA9IHggLSBrO1xuICAgICAgd2hpbGUgKHggPCBuICYmIHkgPCBtICYmIGFbeF0gPT09IGJbeV0pIHtcbiAgICAgICAgeCsrO1xuICAgICAgICB5Kys7XG4gICAgICB9XG4gICAgICB2W29mZnNldCArIGtdID0geDtcbiAgICAgIGlmICh4ID49IG4gJiYgeSA+PSBtKSByZXR1cm4gdHJhY2U7XG4gICAgfVxuICAgIHYgPSB2LnNsaWNlKCk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBXYWxrIHRoZSB0cmFjZSBiYWNrd2FyZHMgaW50byBhIGxpc3Qgb2YgbGluZSBvcGVyYXRpb25zLCBmcm9udCB0byBiYWNrLiAqL1xuZnVuY3Rpb24gYmFja3RyYWNrKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSwgdHJhY2U6IEludDMyQXJyYXlbXSk6IERpZmZMaW5lW10ge1xuICBjb25zdCBvZmZzZXQgPSBNYXRoLm1pbihhLmxlbmd0aCArIGIubGVuZ3RoLCBNQVhfRURJVFMpO1xuICBjb25zdCBvdXQ6IERpZmZMaW5lW10gPSBbXTtcbiAgbGV0IHggPSBhLmxlbmd0aDtcbiAgbGV0IHkgPSBiLmxlbmd0aDtcbiAgZm9yIChsZXQgZCA9IHRyYWNlLmxlbmd0aCAtIDE7IGQgPj0gMDsgZC0tKSB7XG4gICAgY29uc3QgdiA9IHRyYWNlW2RdIGFzIEludDMyQXJyYXk7XG4gICAgY29uc3QgayA9IHggLSB5O1xuICAgIGxldCBwcmV2SzogbnVtYmVyO1xuICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiAodltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyKSA8ICh2W29mZnNldCArIGsgKyAxXSBhcyBudW1iZXIpKSlcbiAgICAgIHByZXZLID0gayArIDE7XG4gICAgZWxzZSBwcmV2SyA9IGsgLSAxO1xuICAgIGNvbnN0IHByZXZYID0gdltvZmZzZXQgKyBwcmV2S10gYXMgbnVtYmVyO1xuICAgIGNvbnN0IHByZXZZID0gcHJldlggLSBwcmV2SztcbiAgICB3aGlsZSAoeCA+IHByZXZYICYmIHkgPiBwcmV2WSkge1xuICAgICAgeC0tO1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJzYW1lXCIsIGE6IHgsIGI6IHksIHRleHQ6IGFbeF0gYXMgc3RyaW5nIH0pO1xuICAgIH1cbiAgICBpZiAoZCA9PT0gMCkgYnJlYWs7XG4gICAgaWYgKHggPiBwcmV2WCkge1xuICAgICAgeC0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJkZWxcIiwgYTogeCwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHktLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwiYWRkXCIsIGI6IHksIHRleHQ6IGJbeV0gYXMgc3RyaW5nIH0pO1xuICAgIH1cbiAgfVxuICBvdXQucmV2ZXJzZSgpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogRXZlcnkgbGluZSBhcyBvbmUgcmVwbGFjZW1lbnQg4oCUIHRoZSBob25lc3QgYW5zd2VyIHdoZW4gTXllcnMgZ2l2ZXMgdXAuICovXG5mdW5jdGlvbiBjb2Fyc2VMaW5lcyhhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10pOiBEaWZmTGluZVtdIHtcbiAgcmV0dXJuIFtcbiAgICAuLi5hLm1hcCgodGV4dCwgaSkgPT4gKHsgb3A6IFwiZGVsXCIgYXMgY29uc3QsIGE6IGksIHRleHQgfSkpLFxuICAgIC4uLmIubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJhZGRcIiBhcyBjb25zdCwgYjogaSwgdGV4dCB9KSksXG4gIF07XG59XG5cbi8qKiBHcm91cCB0aGUgbGluZSBvcHMgaW50byBjb250aWd1b3VzIGh1bmtzLCBudW1iZXJlZCBmcm9tIDEuICovXG5mdW5jdGlvbiBjb2xsZWN0KGxpbmVzOiBEaWZmTGluZVtdKTogRGlmZkh1bmtbXSB7XG4gIGNvbnN0IGh1bmtzOiBEaWZmSHVua1tdID0gW107XG4gIGxldCBpID0gMDtcbiAgbGV0IGlkID0gMTtcbiAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcbiAgICBpZiAoKGxpbmVzW2ldIGFzIERpZmZMaW5lKS5vcCA9PT0gXCJzYW1lXCIpIHtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBzdGFydCA9IGk7XG4gICAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGggJiYgKGxpbmVzW2ldIGFzIERpZmZMaW5lKS5vcCAhPT0gXCJzYW1lXCIpIGkrKztcbiAgICBjb25zdCBydW4gPSBsaW5lcy5zbGljZShzdGFydCwgaSk7XG4gICAgY29uc3QgZGVsID0gcnVuLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJkZWxcIik7XG4gICAgY29uc3QgYWRkID0gcnVuLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJhZGRcIik7XG4gICAgLy8gV2hlcmUgdGhlIGh1bmsgc2l0cyBpbiBlYWNoIHRleHQ6IHRoZSBpbmRleCBvZiB0aGUgZmlyc3QgbGluZSBpdCB0b3VjaGVzLFxuICAgIC8vIGFuZCBmb3IgYSBwdXJlIGluc2VydGlvbiwgdGhlIHBvaW50IGl0IGlzIGluc2VydGVkIEFULlxuICAgIGNvbnN0IGFGcm9tID0gZGVsLmxlbmd0aCA/ICgoZGVsWzBdIGFzIERpZmZMaW5lKS5hIGFzIG51bWJlcikgOiBuZXh0SW5kZXgobGluZXMsIHN0YXJ0LCBcImFcIik7XG4gICAgY29uc3QgYkZyb20gPSBhZGQubGVuZ3RoID8gKChhZGRbMF0gYXMgRGlmZkxpbmUpLmIgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYlwiKTtcbiAgICBodW5rcy5wdXNoKHtcbiAgICAgIGlkOiBpZCsrLFxuICAgICAgYUZyb20sXG4gICAgICBhVG86IGFGcm9tICsgZGVsLmxlbmd0aCxcbiAgICAgIGJGcm9tLFxuICAgICAgYlRvOiBiRnJvbSArIGFkZC5sZW5ndGgsXG4gICAgICBkZWw6IGRlbC5tYXAoKGwpID0+IGwudGV4dCksXG4gICAgICBhZGQ6IGFkZC5tYXAoKGwpID0+IGwudGV4dCksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGh1bmtzO1xufVxuXG4vKipcbiAqIFRoZSBpbmRleCBhIHB1cmUgaW5zZXJ0aW9uIG9yIGRlbGV0aW9uIHNpdHMgYXQ6IHRoZSBsaW5lIG51bWJlciBvZiB0aGUgbmV4dFxuICogYHNhbWVgIGxpbmUgb24gdGhhdCBzaWRlLCBvciB0aGUgZW5kIG9mIHRoYXQgdGV4dCB3aGVuIHRoZXJlIGlzIG5vbmUuXG4gKi9cbmZ1bmN0aW9uIG5leHRJbmRleChsaW5lczogRGlmZkxpbmVbXSwgZnJvbTogbnVtYmVyLCBzaWRlOiBcImFcIiB8IFwiYlwiKTogbnVtYmVyIHtcbiAgZm9yIChsZXQgaSA9IGZyb207IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGF0ID0gKGxpbmVzW2ldIGFzIERpZmZMaW5lKVtzaWRlXTtcbiAgICBpZiAoYXQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGF0O1xuICB9XG4gIGxldCBsYXN0ID0gLTE7XG4gIGZvciAoY29uc3QgbCBvZiBsaW5lcykge1xuICAgIGNvbnN0IGF0ID0gbFtzaWRlXTtcbiAgICBpZiAoYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+IGxhc3QpIGxhc3QgPSBhdDtcbiAgfVxuICByZXR1cm4gbGFzdCArIDE7XG59XG5cbi8qKiBXb3Jkcywgd2hpdGVzcGFjZSBydW5zIGFuZCBwdW5jdHVhdGlvbiBydW5zLCBrZXB0IHNlcGFyYXRlIHNvIHNwYW5zIGFsaWduLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmRzKGxpbmU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIGxpbmUubWF0Y2goL1xccyt8W1xccHtMfVxccHtOfV9dK3xbXlxcc1xccHtMfVxccHtOfV9dKy9ndSkgPz8gW107XG59XG5cbi8qKiBUaGUgd29yZC1sZXZlbCBkaWZmIG9mIG9uZSBsaW5lIHBhaXIsIGFzIHNwYW5zIG92ZXIgZWFjaCBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZmluZShiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IHsgZGVsOiBEaWZmU3BhbltdOyBhZGQ6IERpZmZTcGFuW10gfSB7XG4gIGNvbnN0IGEgPSB3b3JkcyhiZWZvcmUpO1xuICBjb25zdCBiID0gd29yZHMoYWZ0ZXIpO1xuICBjb25zdCB0cmFjZSA9IG15ZXJzVHJhY2UoYSwgYik7XG4gIGlmICghdHJhY2UpXG4gICAgcmV0dXJuIHsgZGVsOiBbeyB0ZXh0OiBiZWZvcmUsIGNoYW5nZWQ6IHRydWUgfV0sIGFkZDogW3sgdGV4dDogYWZ0ZXIsIGNoYW5nZWQ6IHRydWUgfV0gfTtcbiAgY29uc3Qgb3BzID0gYmFja3RyYWNrKGEsIGIsIHRyYWNlKTtcbiAgY29uc3QgZGVsOiBEaWZmU3BhbltdID0gW107XG4gIGNvbnN0IGFkZDogRGlmZlNwYW5bXSA9IFtdO1xuICBmb3IgKGNvbnN0IG9wIG9mIG9wcykge1xuICAgIGlmIChvcC5vcCA9PT0gXCJzYW1lXCIpIHtcbiAgICAgIHB1c2goZGVsLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgICBwdXNoKGFkZCwgb3AudGV4dCwgZmFsc2UpO1xuICAgIH0gZWxzZSBpZiAob3Aub3AgPT09IFwiZGVsXCIpIHB1c2goZGVsLCBvcC50ZXh0LCB0cnVlKTtcbiAgICBlbHNlIHB1c2goYWRkLCBvcC50ZXh0LCB0cnVlKTtcbiAgfVxuICByZXR1cm4geyBkZWwsIGFkZCB9O1xufVxuXG4vKiogQXBwZW5kLCBtZXJnaW5nIGludG8gdGhlIHByZXZpb3VzIHNwYW4gd2hlbiBpdCBjYXJyaWVzIHRoZSBzYW1lIHZlcmRpY3QuICovXG5mdW5jdGlvbiBwdXNoKHNwYW5zOiBEaWZmU3BhbltdLCB0ZXh0OiBzdHJpbmcsIGNoYW5nZWQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgbGFzdCA9IHNwYW5zW3NwYW5zLmxlbmd0aCAtIDFdO1xuICBpZiAobGFzdCAmJiBsYXN0LmNoYW5nZWQgPT09IGNoYW5nZWQpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIHNwYW5zLnB1c2goeyB0ZXh0LCBjaGFuZ2VkIH0pO1xufVxuXG4vKipcbiAqIFJlZmluZSBhIGh1bmsncyBsaW5lcyB3aGVuIHRoZXkgY2FuIGJlIFBBSVJFRC4gQSBodW5rIHJlcGxhY2luZyB0aHJlZSBsaW5lc1xuICogd2l0aCB0aHJlZSBpcyBwYWlyZWQgbGluZSBieSBsaW5lOyBhIDEtZm9yLW1hbnkgaHVuayBpcyBub3QsIGFuZCBnZXRzIG5vXG4gKiBzcGFucyByYXRoZXIgdGhhbiBhbiBhcmJpdHJhcnkgcGFpcmluZyDigJQgc2hvd2luZyBhIHdvcmQtbGV2ZWwgZGlmZiBhZ2FpbnN0XG4gKiB0aGUgd3JvbmcgbGluZSBpcyB3b3JzZSB0aGFuIHNob3dpbmcgbm9uZS5cbiAqL1xuZnVuY3Rpb24gcmVmaW5lSHVuayhsaW5lczogRGlmZkxpbmVbXSwgaHVuazogRGlmZkh1bmspOiB2b2lkIHtcbiAgaWYgKGh1bmsuZGVsLmxlbmd0aCAhPT0gaHVuay5hZGQubGVuZ3RoIHx8IGh1bmsuZGVsLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBkZWxzID0gbGluZXMuZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiICYmIGluUmFuZ2UobC5hLCBodW5rLmFGcm9tLCBodW5rLmFUbykpO1xuICBjb25zdCBhZGRzID0gbGluZXMuZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiICYmIGluUmFuZ2UobC5iLCBodW5rLmJGcm9tLCBodW5rLmJUbykpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGRlbHMubGVuZ3RoICYmIGkgPCBhZGRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZCA9IGRlbHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgYWQgPSBhZGRzW2ldIGFzIERpZmZMaW5lO1xuICAgIGNvbnN0IHsgZGVsLCBhZGQgfSA9IHJlZmluZShkLnRleHQsIGFkLnRleHQpO1xuICAgIGQuc3BhbnMgPSBkZWw7XG4gICAgYWQuc3BhbnMgPSBhZGQ7XG4gIH1cbn1cblxuZnVuY3Rpb24gaW5SYW5nZShhdDogbnVtYmVyIHwgdW5kZWZpbmVkLCBmcm9tOiBudW1iZXIsIHRvOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIGF0ICE9PSB1bmRlZmluZWQgJiYgYXQgPj0gZnJvbSAmJiBhdCA8IHRvO1xufVxuXG4vKiogQ29tcGFyZSB0d28gdGV4dHMgYnkgbGluZSwgcmVmaW5lZCBieSB3b3JkIGluc2lkZSBwYWlyZWQgbGluZXMuICovXG5leHBvcnQgZnVuY3Rpb24gZGlmZlRleHQoYmVmb3JlOiBzdHJpbmcsIGFmdGVyOiBzdHJpbmcpOiBEaWZmIHtcbiAgaWYgKGJlZm9yZSA9PT0gYWZ0ZXIpIHtcbiAgICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoYmVmb3JlKS5tYXAoKHRleHQsIGkpID0+ICh7XG4gICAgICBvcDogXCJzYW1lXCIgYXMgY29uc3QsXG4gICAgICBhOiBpLFxuICAgICAgYjogaSxcbiAgICAgIHRleHQsXG4gICAgfSkpO1xuICAgIHJldHVybiB7IGxpbmVzLCBodW5rczogW10sIHNhbWU6IHRydWUsIGNvYXJzZTogZmFsc2UgfTtcbiAgfVxuICBjb25zdCBhID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBjb25zdCBiID0gc3BsaXRMaW5lcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgY29uc3QgY29hcnNlID0gdHJhY2UgPT09IG51bGw7XG4gIGNvbnN0IGxpbmVzID0gdHJhY2UgPyBiYWNrdHJhY2soYSwgYiwgdHJhY2UpIDogY29hcnNlTGluZXMoYSwgYik7XG4gIGNvbnN0IGh1bmtzID0gY29sbGVjdChsaW5lcyk7XG4gIGZvciAoY29uc3QgaCBvZiBodW5rcykgcmVmaW5lSHVuayhsaW5lcywgaCk7XG4gIHJldHVybiB7IGxpbmVzLCBodW5rcywgc2FtZTogZmFsc2UsIGNvYXJzZSB9O1xufVxuXG4vKipcbiAqIFRha2UgaHVua3MgZnJvbSB0aGUgcmlnaHQgc2lkZSBpbnRvIHRoZSBsZWZ0LiBgdGFrZWAgaXMgdGhlIGlkcyB0byBhcHBseTtcbiAqIGV2ZXJ5IGh1bmsgbm90IG5hbWVkIGlzIGxlZnQgYXMgdGhlIGxlZnQgc2lkZSBoYXMgaXQuXG4gKlxuICog4puUIEFQUExJRUQgQkFDSyBUTyBGUk9OVCwgc28gYW4gZWFybGllciBodW5rJ3MgbGluZSBudW1iZXJzIGFyZSBzdGlsbCB0aGVcbiAqIG9uZXMgdGhlIGRpZmYgcmVwb3J0ZWQgd2hlbiBpdCBpcyByZWFjaGVkLiBBcHBseWluZyBmcm9udCB0byBiYWNrIHdvdWxkXG4gKiBzaGlmdCBldmVyeSBsYXRlciBodW5rIGJ5IHRoZSBzaXplIG9mIHRoZSBjaGFuZ2UganVzdCBtYWRlIOKAlCB0aGUgY2xhc3NpYyB3YXlcbiAqIGEgbXVsdGktaHVuayBtZXJnZSBsYW5kcyBpdHMgbGFzdCBodW5rIGluIHRoZSB3cm9uZyBwbGFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5SHVua3MoYmVmb3JlOiBzdHJpbmcsIGh1bmtzOiBEaWZmSHVua1tdLCB0YWtlOiBudW1iZXJbXSk6IHN0cmluZyB7XG4gIGNvbnN0IHdhbnRlZCA9IG5ldyBTZXQodGFrZSk7XG4gIGNvbnN0IGNob3NlbiA9IGh1bmtzLmZpbHRlcigoaCkgPT4gd2FudGVkLmhhcyhoLmlkKSkuc29ydCgoeCwgeSkgPT4geS5hRnJvbSAtIHguYUZyb20pO1xuICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoYmVmb3JlKTtcbiAgZm9yIChjb25zdCBoIG9mIGNob3NlbikgbGluZXMuc3BsaWNlKGguYUZyb20sIGguYVRvIC0gaC5hRnJvbSwgLi4uaC5hZGQpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqIFVuaWZpZWQtZGlmZiB0ZXh0LCBmb3IgdGhlIGFnZW50J3MgYGRpZmZgIHZlcmIuIGBjb250ZXh0YCBsaW5lcyBlaXRoZXIgc2lkZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmlmaWVkKFxuICBkaWZmOiBEaWZmLFxuICBvcHRzOiB7IGZyb206IHN0cmluZzsgdG86IHN0cmluZzsgY29udGV4dD86IG51bWJlciB9ID0geyBmcm9tOiBcImFcIiwgdG86IFwiYlwiIH0sXG4pOiBzdHJpbmcge1xuICBpZiAoZGlmZi5zYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgY29udGV4dCA9IG9wdHMuY29udGV4dCA/PyAzO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW2AtLS0gJHtvcHRzLmZyb219YCwgYCsrKyAke29wdHMudG99YF07XG4gIC8vIEh1bmtzIGNsb3NlciB0b2dldGhlciB0aGFuIDLDlyBjb250ZXh0IHNoYXJlIG9uZSBoZWFkZXIsIHRoZSB3YXkgZXZlcnlcbiAgLy8gb3RoZXIgZGlmZiB0b29sIGpvaW5zIHRoZW0g4oCUIG90aGVyd2lzZSB0aGUgY29udGV4dCBsaW5lcyBwcmludCB0d2ljZS5cbiAgY29uc3QgZ3JvdXBzOiBEaWZmSHVua1tdW10gPSBbXTtcbiAgZm9yIChjb25zdCBoIG9mIGRpZmYuaHVua3MpIHtcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBzW2dyb3Vwcy5sZW5ndGggLSAxXTtcbiAgICBjb25zdCBwcmV2ID0gbGFzdD8uW2xhc3QubGVuZ3RoIC0gMV07XG4gICAgaWYgKHByZXYgJiYgaC5hRnJvbSAtIHByZXYuYVRvIDw9IGNvbnRleHQgKiAyKSAobGFzdCBhcyBEaWZmSHVua1tdKS5wdXNoKGgpO1xuICAgIGVsc2UgZ3JvdXBzLnB1c2goW2hdKTtcbiAgfVxuICBjb25zdCBhID0gc3BsaXRMaW5lcyhzaWRlVGV4dChkaWZmLCBcImFcIikpO1xuICBjb25zdCBiID0gc3BsaXRMaW5lcyhzaWRlVGV4dChkaWZmLCBcImJcIikpO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcykge1xuICAgIGNvbnN0IGZpcnN0ID0gZ3JvdXBbMF0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgbGFzdCA9IGdyb3VwW2dyb3VwLmxlbmd0aCAtIDFdIGFzIERpZmZIdW5rO1xuICAgIGNvbnN0IGFTdGFydCA9IE1hdGgubWF4KDAsIGZpcnN0LmFGcm9tIC0gY29udGV4dCk7XG4gICAgY29uc3QgYUVuZCA9IE1hdGgubWluKGEubGVuZ3RoLCBsYXN0LmFUbyArIGNvbnRleHQpO1xuICAgIGNvbnN0IGJTdGFydCA9IE1hdGgubWF4KDAsIGZpcnN0LmJGcm9tIC0gY29udGV4dCk7XG4gICAgY29uc3QgYkVuZCA9IE1hdGgubWluKGIubGVuZ3RoLCBsYXN0LmJUbyArIGNvbnRleHQpO1xuICAgIG91dC5wdXNoKGBAQCAtJHthU3RhcnQgKyAxfSwke2FFbmQgLSBhU3RhcnR9ICske2JTdGFydCArIDF9LCR7YkVuZCAtIGJTdGFydH0gQEBgKTtcbiAgICBsZXQgYXQgPSBhU3RhcnQ7XG4gICAgZm9yIChjb25zdCBoIG9mIGdyb3VwKSB7XG4gICAgICBmb3IgKDsgYXQgPCBoLmFGcm9tOyBhdCsrKSBvdXQucHVzaChgICR7YVthdF19YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5kZWwpIG91dC5wdXNoKGAtJHtsaW5lfWApO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGguYWRkKSBvdXQucHVzaChgKyR7bGluZX1gKTtcbiAgICAgIGF0ID0gaC5hVG87XG4gICAgfVxuICAgIGZvciAoOyBhdCA8IGFFbmQ7IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgfVxuICByZXR1cm4gYCR7b3V0LmpvaW4oXCJcXG5cIil9XFxuYDtcbn1cblxuLyoqIFJlYnVpbGQgb25lIHNpZGUncyB0ZXh0IGZyb20gdGhlIGxpbmUgb3BzIOKAlCB1c2VkIGJ5IGB1bmlmaWVkYCBmb3IgY29udGV4dC4gKi9cbmZ1bmN0aW9uIHNpZGVUZXh0KGRpZmY6IERpZmYsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBzdHJpbmcge1xuICBjb25zdCBza2lwID0gc2lkZSA9PT0gXCJhXCIgPyBcImFkZFwiIDogXCJkZWxcIjtcbiAgcmV0dXJuIGRpZmYubGluZXNcbiAgICAuZmlsdGVyKChsKSA9PiBsLm9wICE9PSBza2lwKVxuICAgIC5tYXAoKGwpID0+IGwudGV4dClcbiAgICAuam9pbihcIlxcblwiKTtcbn1cbiIsCiAgICAiLy8gV2hhdCBpcyB3cm9uZyB3aXRoIHRoaXMgc2Vzc2lvbiwgYW5kIHRoZSB2ZXJiIHRoYXQgZml4ZXMgZWFjaCB0aGluZyAoRTYyKS5cbi8vXG4vLyDim5QgUkVQT1JUUywgTkVWRVIgUkVQQUlSUy4gU2lsZW50bHkgcHJ1bmluZyBhIGdob3N0IGVudHJ5IHdvdWxkIHRocm93IGF3YXkgdGhlXG4vLyBmYWN0IHRoYXQgdGhlIGh1bWFuIEFTS0VEIGZvciB0aGF0IGZpbGUgdG8gYmUgaW4gdGhlaXIgY29udGV4dCDigJQgYW5kIGlmIGl0XG4vLyBjb21lcyBiYWNrIGZyb20gYSBgZ2l0IGNoZWNrb3V0YCwgdGhleSB3b3VsZCBoYXZlIHRvIG5vdGljZSBpdCBpcyBtaXNzaW5nIGFuZFxuLy8gYWRkIGl0IGFnYWluLiBUaGUgc2FtZSBsb2dpYyBwcm90ZWN0cyBhIGRvY3VtZW50IHJlY29yZCB3aG9zZSBmaWxlIGhhcyBnb25lOlxuLy8gdGhlIHNlc3Npb24gaXMgc3RpbGwgaG9sZGluZyB2ZXJzaW9ucyB0aGUgaHVtYW4gY2FuIHNhdmUgYmFjaywgc28gZm9yZ2V0dGluZ1xuLy8gaXQgZm9yIHRoZW0gd291bGQgYmUgZGlzY2FyZGluZyBjb250ZW50IG9uIHRoZWlyIGJlaGFsZi4gQ29sZSBydWxlZCBpdDpcbi8vIFwicmVwb3J0LCBuYW1lIHRoZSB2ZXJiLCBsZXQgeW91IGRlY2lkZS5cIlxuLy9cbi8vIOKblCBBTkQgRVZFUlkgRklORElORyBDQVJSSUVTIElUUyBWRVJCLiBBIHJlcG9ydCB0aGF0IHNheXMgXCIzIHByb2JsZW1zXCIgYW5kXG4vLyBsZWF2ZXMgeW91IHRvIHdvcmsgb3V0IHdoYXQgdG8gdHlwZSBpcyB0aGUgc2hhcGUgdGhpcyBzcGVsbCBrZWVwcyBmYWlsaW5nIGF0XG4vLyBhbmQgZml4aW5nIOKAlCB0aGUgY29uZmxpY3QgYmFubmVyIHdpdGggbm8gcm91dGUgdG8gdGhlIGNvbXBhcmlzb24sIHRoZVxuLy8gXCJnb25lIGZyb20gZGlza1wiIG5vdGljZSB3aXRoIG5vIHdheSB0byBhbnN3ZXIgaXQuIEEgZmluZGluZyB3aXRob3V0IGEgZml4IGlzXG4vLyBoYWxmIGEgZmluZGluZy5cbi8vXG4vLyDimqAgVEhFIENIRUNLUyBBUkUgRVZJREVOQ0VELCBOT1QgSU1BR0lORUQuIEVhY2ggb25lIGlzIGEgc3RhdGUgdGhhdCBoYXNcbi8vIGFjdHVhbGx5IGhhcHBlbmVkIGhlcmU6IGEgcmVjb3JkIHdob3NlIG9yaWdpbmFsIHdhcyBkZWxldGVkIChFNjAncyByZXNpZHVlLFxuLy8gYW5kIGFueSBkZWxldGUgaW4gRmluZGVyKSwgYSBgbGlzdGVkYCBjb250ZXh0IGVudHJ5IHBvaW50aW5nIGF0IG5vdGhpbmdcbi8vIChuZXZlciByZXNjYW5uZWQg4oCUIG1lYXN1cmVkLCBhbmQgcmVhY2hhYmxlIHRvZGF5IHdpdGggbm8gYnVnIGF0IGFsbCksIGFuZFxuLy8gbGlua3MgYSBzZXQgY2Fubm90IGFuc3dlciAoRTU0KS4gTm90aGluZyBpcyBjaGVja2VkIGJlY2F1c2UgaXQgc291bmRlZFxuLy8gcGxhdXNpYmxlLlxuXG4vKiogT25lIHRoaW5nIHdvcnRoIGxvb2tpbmcgYXQsIGFuZCB3aGF0IHRvIGRvIGFib3V0IGl0LiAqL1xuZXhwb3J0IHR5cGUgRmluZGluZyA9IHtcbiAga2luZDogXCJvcmlnaW5hbC5taXNzaW5nXCIgfCBcImNvbnRleHQuZ2hvc3RcIiB8IFwibGlua3MuZGFuZ2xpbmdcIjtcbiAgLyoqIFdoYXQgaXQgaXMgYWJvdXQ6IGEgcGF0aCwgb3IgYW4gZW50cnkgaWQuICovXG4gIHN1YmplY3Q6IHN0cmluZztcbiAgLyoqIFdoYXQgdGhlIGh1bWFuIHJlYWRzLiAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIC8qKiBXaGF0IHRoZSBhZ2VudCB3b3VsZCBydW4sIHdpdGggdGhlIGFyZ3VtZW50IGFscmVhZHkgaW4gaXQuICovXG4gIGZpeDogc3RyaW5nO1xuICAvKiogSG93IG1hbnkgb2Ygc29tZXRoaW5nIHRoZSBmaW5kaW5nIGlzIGFib3V0LCB3aGVuIHRoYXQgaXMgdGhlIHBvaW50LiAqL1xuICBjb3VudD86IG51bWJlcjtcbn07XG5cbi8qKiBUaGUgZmFjdHMgYSBjaGVja3VwIG5lZWRzLCBnYXRoZXJlZCBieSB3aG9ldmVyIGNhbiB0b3VjaCB0aGUgZGlzay4gKi9cbmV4cG9ydCB0eXBlIENoZWNrdXAgPSB7XG4gIC8qKiBFdmVyeSBkb2N1bWVudCByZWNvcmQsIHdpdGggd2hldGhlciBpdHMgZmlsZSBvZiByZWNvcmQgc3RpbGwgZXhpc3RzLiAqL1xuICBkb2NzOiByZWFkb25seSB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBvcmlnaW5hbDogc3RyaW5nO1xuICAgIGV4aXN0czogYm9vbGVhbjtcbiAgICB2ZXJzaW9uczogbnVtYmVyO1xuICB9W107XG4gIC8qKiBFdmVyeSBkb2Mgbm9kZSBpbiBldmVyeSBjb250ZXh0IGVudHJ5LCB3aXRoIHdoZXRoZXIgdGhlIHBhdGggZXhpc3RzLiAqL1xuICBub2RlczogcmVhZG9ubHkgeyBlbnRyeTogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IHNob3duOiBzdHJpbmc7IGV4aXN0czogYm9vbGVhbiB9W107XG4gIC8qKiBEYW5nbGluZyBsaW5rIGNvdW50cyBwZXIgbWlycm9yZWQgZW50cnkuICovXG4gIGxpbmtzOiByZWFkb25seSB7IGVudHJ5OiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGRhbmdsaW5nOiBudW1iZXIgfVtdO1xufTtcblxuLyoqXG4gKiBTaGFwZSB0aGUgZmFjdHMgaW50byBmaW5kaW5ncy5cbiAqXG4gKiBQdXJlIG9uIHB1cnBvc2U6IHRoZSBmcyByZWFkcyBiZWxvbmcgdG8gdGhlIHNlc3Npb24sIGFuZCB3aGF0IGNvdW50cyBhcyBhXG4gKiBwcm9ibGVtIOKAlCBhbmQgd2hhdCB0byBzYXkgYWJvdXQgaXQg4oCUIGlzIHRoZSBwYXJ0IHdvcnRoIHBpbm5pbmcgd2l0aCBjZWxscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRpbmdzKGM6IENoZWNrdXApOiBGaW5kaW5nW10ge1xuICBjb25zdCBvdXQ6IEZpbmRpbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgZCBvZiBjLmRvY3MpIHtcbiAgICBpZiAoZC5leGlzdHMpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwib3JpZ2luYWwubWlzc2luZ1wiLFxuICAgICAgc3ViamVjdDogZC5vcmlnaW5hbCxcbiAgICAgIG1lc3NhZ2U6IGAke2QubmFtZX0gaXMgaW4gdGhpcyBzZXNzaW9uIGJ1dCBpdHMgZmlsZSBpcyBnb25lIGZyb20gZGlzay4gJHtcbiAgICAgICAgZC52ZXJzaW9ucyA9PT0gMSA/IFwiMSB2ZXJzaW9uIGlzXCIgOiBgJHtkLnZlcnNpb25zfSB2ZXJzaW9ucyBhcmVgXG4gICAgICB9IHN0aWxsIGhlbGQgaGVyZSDigJQgc2F2aW5nIHdvdWxkIHJlY3JlYXRlIHRoZSBmaWxlLmAsXG4gICAgICBmaXg6IGBmb3JnZXQgLS1kb2MgJHtkLnNsdWd9YCxcbiAgICAgIGNvdW50OiBkLnZlcnNpb25zLFxuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBuIG9mIGMubm9kZXMpIHtcbiAgICBpZiAobi5leGlzdHMpIGNvbnRpbnVlO1xuICAgIC8vIOKaoCBBIHJlY29yZCBhbmQgYW4gZW50cnkgY2FuIHBvaW50IGF0IHRoZSBTQU1FIG1pc3NpbmcgcGF0aCwgYW5kIGJvdGggYXJlXG4gICAgLy8gcmVwb3J0ZWQ6IHRoZXkgYXJlIHR3byBkaWZmZXJlbnQgdGhpbmdzIHRvIGNsZWFuIHVwLCB3aXRoIHR3byBkaWZmZXJlbnRcbiAgICAvLyB2ZXJicywgYW5kIG1lcmdpbmcgdGhlbSB3b3VsZCBsZWF2ZSB3aGljaGV2ZXIgdGhlIGh1bWFuIGRpZCBub3QgZG8uXG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJjb250ZXh0Lmdob3N0XCIsXG4gICAgICBzdWJqZWN0OiBuLnBhdGgsXG4gICAgICBtZXNzYWdlOiBgJHtuLnNob3dufSBpcyBpbiB0aGUgY29udGV4dCBidXQgbm90IG9uIGRpc2suYCxcbiAgICAgIGZpeDogYGhpZGUgJHtuLnBhdGh9YCxcbiAgICB9KTtcbiAgfVxuXG4gIGZvciAoY29uc3QgbCBvZiBjLmxpbmtzKSB7XG4gICAgaWYgKGwuZGFuZ2xpbmcgPD0gMCkgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJsaW5rcy5kYW5nbGluZ1wiLFxuICAgICAgc3ViamVjdDogbC5lbnRyeSxcbiAgICAgIG1lc3NhZ2U6XG4gICAgICAgIGwuZGFuZ2xpbmcgPT09IDFcbiAgICAgICAgICA/IGAke2wubGFiZWx9IGhhcyAxIGxpbmsgdGhhdCBhbnN3ZXJzIG5vdGhpbmcuYFxuICAgICAgICAgIDogYCR7bC5sYWJlbH0gaGFzICR7bC5kYW5nbGluZ30gbGlua3MgdGhhdCBhbnN3ZXIgbm90aGluZy5gLFxuICAgICAgZml4OiBgZGFuZ2xpbmcgLS1lbnRyeSAke2wuZW50cnl9YCxcbiAgICAgIGNvdW50OiBsLmRhbmdsaW5nLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBUaGUgb25lIGxpbmUgdGhlIGNoYXQgZ2V0cyBhdCBzdGFydHVwLCBvciBudWxsIHdoZW4gdGhlcmUgaXMgbm90aGluZyB0byBzYXkuXG4gKlxuICog4puUIE9ORSBMSU5FLCBBTkQgU0lMRU5DRSBXSEVOIENMRUFOLiBBIGNoZWNrIHRoYXQgYW5ub3VuY2VzIGl0c2VsZiBldmVyeSB0aW1lXG4gKiBpdCBmaW5kcyBub3RoaW5nIHRyYWlucyB0aGUgcmVhZGVyIHRvIHNraXAgaXQsIGFuZCB0aGVuIGl0IGlzIG5vdCBhIGNoZWNrIGFueVxuICogbW9yZS4gVGhlIGRldGFpbCBsaXZlcyBiZWhpbmQgdGhlIHZlcmIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJ5KGxpc3Q6IHJlYWRvbmx5IEZpbmRpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBpZiAobGlzdC5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAvLyDimqAgQ291bnRlZCBieSBLSU5EIHJhdGhlciB0aGFuIGRlc2NyaWJlZCwgYmVjYXVzZSBhIHNlbnRlbmNlIHRoYXQgdHJpZXMgdG9cbiAgLy8gbmFtZSB0aHJlZSBjYXRlZ29yaWVzIGluIG9uZSBicmVhdGggcmVhZHMgd29yc2UgdGhhbiB0aGUgbnVtYmVycyBkby5cbiAgY29uc3QgYnlLaW5kID0gbmV3IE1hcDxGaW5kaW5nW1wia2luZFwiXSwgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGYgb2YgbGlzdCkgYnlLaW5kLnNldChmLmtpbmQsIChieUtpbmQuZ2V0KGYua2luZCkgPz8gMCkgKyAxKTtcbiAgLy8g4pqgIEJPVEggRk9STVMgV1JJVFRFTiBPVVQuIEFwcGVuZGluZyBcInNcIiBwcm9kdWNlZCBcImdob3N0IGluIHRoZSBjb250ZXh0c1wiLFxuICAvLyB3aGljaCBpcyB0aGUga2luZCBvZiBzbWFsbCB3cm9uZ25lc3MgdGhhdCBtYWtlcyBhIHRvb2wgcmVhZCBhcyBjYXJlbGVzcy5cbiAgY29uc3QgbGFiZWw6IFJlY29yZDxGaW5kaW5nW1wia2luZFwiXSwgW29uZTogc3RyaW5nLCBtYW55OiBzdHJpbmddPiA9IHtcbiAgICBcIm9yaWdpbmFsLm1pc3NpbmdcIjogW1wibWlzc2luZyBmaWxlXCIsIFwibWlzc2luZyBmaWxlc1wiXSxcbiAgICBcImNvbnRleHQuZ2hvc3RcIjogW1wiZ2hvc3QgaW4gdGhlIGNvbnRleHRcIiwgXCJnaG9zdHMgaW4gdGhlIGNvbnRleHRcIl0sXG4gICAgXCJsaW5rcy5kYW5nbGluZ1wiOiBbXCJzZXQgd2l0aCBkYW5nbGluZyBsaW5rc1wiLCBcInNldHMgd2l0aCBkYW5nbGluZyBsaW5rc1wiXSxcbiAgfTtcbiAgY29uc3QgcGFydHMgPSBbLi4uYnlLaW5kXS5tYXAoKFtraW5kLCBuXSkgPT4gYCR7bn0gJHtsYWJlbFtraW5kXVtuID09PSAxID8gMCA6IDFdfWApO1xuICByZXR1cm4gYFN0YXJ0dXAgY2hlY2s6ICR7cGFydHMuam9pbihcIiwgXCIpfSDigJQgcnVuIFxcYGRvY3RvclxcYCBmb3IgdGhlIGRldGFpbC5gO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLy8gVW5kbyBhbmQgcmVkbyBmb3IgdGhlIENPTlRFWFQg4oCUIG1vdmluZyB0aGluZ3MgYXJvdW5kLCBhZGRpbmcsIGhpZGluZyAoRTYwKS5cbi8vXG4vLyDim5QgVEhJUyBJUyBOT1QgVEhFIEVESVRPUidTIFVORE8sIGFuZCB0aGUgc3VyZmFjZSBzYXlzIHNvIGJ5IHB1dHRpbmcgdGhlc2Vcbi8vIGFycm93cyBpbiB0aGUgY29udGV4dCBoZWFkZXIgcmF0aGVyIHRoYW4gYW55d2hlcmUgbmVhciB0aGUgdGV4dC4gQ29kZU1pcnJvcidzXG4vLyBoaXN0b3J5IG93bnMga2V5c3Ryb2tlcyBpbnNpZGUgYSBkb2N1bWVudDsgdGhpcyBvd25zIGFjdHMgb24gdGhlIFNIQVBFIG9mIHRoZVxuLy8gY29udGV4dCwgd2hpY2ggaXMgdGhlIHRoaW5nIHRoYXQgaGFkIG5vIHdheSBiYWNrIGF0IGFsbC4gQ29sZTogXCJsZXR0aW5nIHRoZVxuLy8gdXNlciBrbm93IHRoYXQgdGhlcmUncyBhbiB1bmRvIGZvciB0aGlzIHNpZGViYXIgdGhhdCBpc24ndCB0aGUgc2FtZSBhcyB1bmRvXG4vLyByZWRvIHdoZW4geW91J3JlIGluIHRoZSBlZGl0b3IuXCJcbi8vXG4vLyDim5QgVU5ET0lORyBBIENSRUFUSU9OIERFTEVURVMsIEJVVCBPTkxZIEJFSElORCBBIENPTkZJUk1BVElPTi4gVGhpcyBzdGFydGVkIGFzXG4vLyBhIGhhcmQgYmxvY2sg4oCUIHVuZG8gbmV2ZXIgZGVsZXRlcyDigJQgYW5kIENvbGUgcHVzaGVkIGJhY2ssIGNvcnJlY3RseTogYmxvY2tpbmdcbi8vIGRvZXMgbm90IHJlZnVzZSBvbmUgc3RlcCwgaXQgU1RSQU5EUyBFVkVSWVRISU5HIEJFSElORCBJVC4gQ3JlYXRlIGEgZm9sZGVyLCBkb1xuLy8gdHdvIG1vdmVzLCBhbmQgeW91IGNhbiB1bmRvIHRoZSBtb3ZlcyBhbmQgdGhlbiBtZWV0IGEgd2FsbCB5b3UgY2FuIG5ldmVyXG4vLyBwYXNzLCBhdCB3aGljaCBwb2ludCB0aGUgaGlzdG9yeSBoYXMgc3RvcHBlZCBiZWluZyBhIGhpc3RvcnkuIEFuZCB0aGUgdGhpbmdcbi8vIHVuZG8gd291bGQgcmVtb3ZlIGlzIG9uZSB0aGUgc2Vzc2lvbiBpdHNlbGYgbWFkZSBtb21lbnRzIGFnbywgdXN1YWxseSBlbXB0eSDigJRcbi8vIGNhdGVnb3JpY2FsbHkgZGlmZmVyZW50IGZyb20gZGVsZXRpbmcgd29yaywgYW5kIHRoZSBhcHAgYWxyZWFkeSBoYXMgdGhlXG4vLyBwYXR0ZXJuIGZvciBpdCBpbiB0aGUgdmVyc2lvbi1kZWxldGUgZGlhbG9nLiBTbyB0aGUgYXJyb3cgc3RheXMgZW5hYmxlZCBhbmRcbi8vIHRoZSBDT05GSVJNQVRJT04gaXMgdGhlIGdhdGUuXG4vL1xuLy8g4puUIFdJVEggT05FIEhBUkQgTElNSVQgVEhBVCBJUyBOT1QgTkVHT1RJQUJMRSBCWSBESUFMT0c6IGEgTk9OLUVNUFRZIGZvbGRlciBpc1xuLy8gcmVmdXNlZCBvdXRyaWdodC4gVW5kbyB3b3JrcyBiYWNrd2FyZHMsIHNvIGl0IGVtcHRpZXMgYSBmb2xkZXIgYmVmb3JlIGl0XG4vLyByZWFjaGVzIHRoYXQgZm9sZGVyJ3MgY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzLCBzb21ldGhpbmdcbi8vIHB1dCB0aGVtIHRoZXJlIHRoYXQgdGhpcyBoaXN0b3J5IGRvZXMgbm90IGtub3cgYWJvdXQsIGFuZCByZW1vdmluZyBhXG4vLyBkaXJlY3RvcnkgdHJlZSBpcyBhIGRpZmZlcmVudCBhY3QgZnJvbSByZW1vdmluZyB0aGUgZW1wdHkgdGhpbmcgeW91IGp1c3Rcbi8vIG1hZGUuIFRoYXQgY2FzZSBzdG9wcyBhbmQgc2F5cyB3aHkuXG4vL1xuLy8g4pqgIFRIRSBJTlZFUlNFIElTIEJVSUxUIFdIRU4gVEhFIEFDVCBIQVBQRU5TLCBmcm9tIHdoYXQgd2FzIGFjdHVhbGx5IHRydWVcbi8vIHRoZW4g4oCUIG5vdCByZWNvbnN0cnVjdGVkIGxhdGVyIGZyb20gdGhlIG9wLiBBIGBtb3ZlYCByZWNvcmRzIHdoZXJlIHRoZSB0aGluZ1xuLy8gQ0FNRSBmcm9tIGJlY2F1c2Ugb25seSB0aGUgbW92ZXIga25vd3M7IGEgYGhpZGVgIHJlY29yZHMgdGhlIGVudHJ5J3Mgd2hvbGVcbi8vIGhpZGRlbiBsaXN0IGJlY2F1c2UgdGhhdCBpcyB3aGF0IHJlc3RvcmVzIGl0IGV4YWN0bHksIGluY2x1ZGluZyB0aGUgY2FzZVxuLy8gd2hlcmUgaGlkaW5nIHJlbW92ZWQgYSBzaW5nbGUtZG9jdW1lbnQgZW50cnkgb3V0cmlnaHQuXG5pbXBvcnQgdHlwZSB7IFN0cnVjdHVyZU9wIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqXG4gKiBIb3cgdG8gcHV0IG9uZSBhY3QgYmFjay4gRWFjaCB2YXJpYW50IGlzIHNvbWV0aGluZyB0aGUgc2Vzc2lvbiBjYW4gYWxyZWFkeVxuICogZG8sIHNvIHVuZG8gaW50cm9kdWNlcyBubyBuZXcgd2F5IHRvIGNoYW5nZSB0aGUgd29ybGQg4oCUIGl0IG9ubHkgcmVwbGF5cyB0aGVcbiAqIGV4aXN0aW5nIG9uZXMgd2l0aCByZWNvcmRlZCBhcmd1bWVudHMuXG4gKi9cbmV4cG9ydCB0eXBlIEludmVyc2UgPVxuICB8IHsga2luZDogXCJtb3ZlXCI7IHBhdGg6IHN0cmluZzsgaW50bzogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwicmVuYW1lXCI7IHBhdGg6IHN0cmluZzsgbmFtZTogc3RyaW5nIH1cbiAgLyoqIFNldCBhbiBlbnRyeSdzIGhpZGRlbiBsaXN0IHRvIGV4YWN0bHkgdGhlc2UgcmVsYXRpdmUgcGF0aHMuICovXG4gIHwgeyBraW5kOiBcImhpZGRlblwiOyBlbnRyeTogc3RyaW5nOyByZWxzOiBzdHJpbmdbXSB9XG4gIC8qKiBQdXQgYSB3aG9sZSBkb2N1bWVudCBvciBmb2xkZXIgYmFjayBpbiB0aGUgY29udGV4dC4gKi9cbiAgfCB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIjsgcGF0aDogc3RyaW5nIH1cbiAgLyoqIFRha2UgYSBjb250ZXh0IGVudHJ5IGJhY2sgb3V0ICh0aGUgaW52ZXJzZSBvZiBwdXR0aW5nIG9uZSBpbikuICovXG4gIHwgeyBraW5kOiBcImNvbnRleHQucmVtb3ZlXCI7IGVudHJ5OiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJ3b3Jrc3BhY2VcIjsgcGF0aDogc3RyaW5nIH1cbiAgLyoqXG4gICAqIFJlbW92ZSB3aGF0IHRoZSBhY3QgY3JlYXRlZC4gYGRpcmAgZGVjaWRlcyBib3RoIHRoZSBkaWFsb2cncyB3b3JkcyBhbmQgdGhlXG4gICAqIGVtcHRpbmVzcyBydWxlIOKAlCBhIGZpbGUgaXMgY29uZmlybWVkLCBhIGZvbGRlciBpcyBjb25maXJtZWQgQU5EIG11c3QgYmVcbiAgICogZW1wdHkuXG4gICAqL1xuICB8IHsga2luZDogXCJkZWxldGVcIjsgcGF0aDogc3RyaW5nOyBkaXI6IGJvb2xlYW4gfTtcblxuLyoqIE9uZSBhY3QsIHdpdGggdGhlIHdheSBiYWNrIGFuZCBhIHNlbnRlbmNlIGZvciB0aGUgYXJyb3cncyB0b29sdGlwLiAqL1xuZXhwb3J0IHR5cGUgQWN0ID0ge1xuICAvKiogV2hhdCBoYXBwZW5lZCwgZm9yIHRoZSB0b29sdGlwOiBcIm1vdmVkIG5vdGUubWQgaW50byBkcmFmdHNcIi4gKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgaW52ZXJzZTogSW52ZXJzZTtcbn07XG5cbi8qKlxuICogV2hhdCB0aGUgc2Vzc2lvbiBrbmV3IGJlZm9yZSB0aGUgYWN0IOKAlCB0aGUgcGFydHMgYW4gaW52ZXJzZSBtYXkgbmVlZC5cbiAqXG4gKiDimqAgUGFzc2VkIGluIHJhdGhlciB0aGFuIHJlYWQgYmFjayBhZnRlcndhcmRzLCBiZWNhdXNlIGV2ZXJ5IGZpZWxkIGhlcmUgaXNcbiAqIHNvbWV0aGluZyB0aGUgYWN0IGl0c2VsZiBDSEFOR0VTLiBSZWFkaW5nIGBoaWRkZW5gIGFmdGVyIGEgaGlkZSByZXR1cm5zIHRoZVxuICogbGlzdCBpbmNsdWRpbmcgdGhlIHRoaW5nIGp1c3QgaGlkZGVuLCB3aGljaCByZXN0b3JlcyBub3RoaW5nLlxuICovXG5leHBvcnQgdHlwZSBCZWZvcmUgPSB7XG4gIC8qKiBUaGUgZW50cnkncyBoaWRkZW4gbGlzdCBiZWZvcmUgdGhlIGFjdCwgd2hlbiB0aGUgYWN0IHRvdWNoZWQgb25lLiAqL1xuICBoaWRkZW4/OiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH07XG4gIC8qKiBUaGUgd29ya3NwYWNlIGJlZm9yZSB0aGUgYWN0LiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogV2hhdCB0aGUgYWN0IHJldHVybmVkIOKAlCB0aGUgc2Vzc2lvbidzIG93biByZXN1bHQsIG5hcnJvd2VkIHRvIHdoYXQgd2UgdXNlLiAqL1xuZXhwb3J0IHR5cGUgQWZ0ZXIgPSB7XG4gIHBhdGg/OiBzdHJpbmc7XG4gIC8qKiBXaGVyZSBhIG1vdmUgb3IgcmVuYW1lIGNhbWUgRlJPTS4gKi9cbiAgZnJvbT86IHN0cmluZztcbiAgLyoqIFRoZSBmb2xkZXIgYHNldC5tYWtlYCBjcmVhdGVkLiAqL1xuICBmb2xkZXI/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZW50cnkgYSBoaWRlIHRvdWNoZWQsIGFuZCB3aGV0aGVyIGl0IHJlbW92ZWQgdGhhdCBlbnRyeSBlbnRpcmVseS4gKi9cbiAgZW50cnk/OiBzdHJpbmc7XG4gIHJlbW92ZWRFbnRyeT86IGJvb2xlYW47XG59O1xuXG5jb25zdCBiYXNlID0gKHA6IHN0cmluZyk6IHN0cmluZyA9PiBwLnNwbGl0KFwiL1wiKS5wb3AoKSA/PyBwO1xuY29uc3QgcGFyZW50ID0gKHA6IHN0cmluZyk6IHN0cmluZyA9PiBwLnNsaWNlKDAsIE1hdGgubWF4KDAsIHAubGFzdEluZGV4T2YoXCIvXCIpKSkgfHwgXCIvXCI7XG5cbi8qKlxuICogVGhlIHdheSBiYWNrIGZyb20gb25lIGFjdC5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGFuIGFjdCBub3Qgd29ydGggYSBoaXN0b3J5IGVudHJ5IGF0IGFsbCDigJQgYHVuaGlkZWAgb24gYW5cbiAqIGVudHJ5IHRoYXQgaGFkIG5vdGhpbmcgaGlkZGVuIGNoYW5nZWQgbm90aGluZywgYW5kIGFuIHVuZG8gYXJyb3cgdGhhdCBzdGVwc1xuICogb3ZlciBuby1vcHMgaXMgYW4gYXJyb3cgdGhhdCBsaWVzIGFib3V0IGhvdyBmYXIgYmFjayBpdCBjYW4gZ28uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuSW52ZXJzZShvcDogU3RydWN0dXJlT3AsIGFmdGVyOiBBZnRlciwgYmVmb3JlOiBCZWZvcmUpOiBBY3QgfCBudWxsIHtcbiAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgLy8g4pSA4pSAIGJyb3VnaHQgc29tZXRoaW5nIGludG8gZXhpc3RlbmNlOiBubyBpbnZlcnNlIHRoYXQgZG9lcyBub3QgZGVsZXRlIOKUgOKUgFxuICAgIGNhc2UgXCJkb2MuY3JlYXRlXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNyZWF0ZWQgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogZmFsc2UgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcImZvbGRlci5jcmVhdGVcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY3JlYXRlZCB0aGUgZm9sZGVyICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiLCBkaXI6IHRydWUgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjb3BpZWQgaW4gJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogZmFsc2UgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcInNldC5tYWtlXCI6XG4gICAgICAvLyDimqAgVEhFIEZPTERFUiBJUyBUSEUgVEhJTkcgVE8gVU5ETywgbm90IHRoZSBtb3ZlIGluc2lkZSBpdC4gYHNldC5tYWtlYFxuICAgICAgLy8gY3JlYXRlcyBhIGZvbGRlciBhbmQgbW92ZXMgdGhlIGRvY3VtZW50IGluLCBzbyB0aGUgaW52ZXJzZSBpcyB0b1xuICAgICAgLy8gcmVtb3ZlIHRoZSBmb2xkZXIg4oCUIHdoaWNoIHRoZSBlbXB0aW5lc3MgcnVsZSB3aWxsIHJlZnVzZSB3aGlsZSB0aGVcbiAgICAgIC8vIGRvY3VtZW50IGlzIHN0aWxsIGluIHRoZXJlLiBUaGF0IHJlZnVzYWwgaXMgY29ycmVjdCBhbmQgcmVhZGFibGVcbiAgICAgIC8vIChcInRoZSBmb2xkZXIgaXMgbm90IGVtcHR5XCIpLCBhbmQgdGhlIHdheSB0aHJvdWdoIGl0IGlzIHRvIG1vdmUgdGhlXG4gICAgICAvLyBkb2N1bWVudCBvdXQgZmlyc3QsIHdoaWNoIGlzIGl0c2VsZiBhbiB1bmRvYWJsZSBhY3QuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHR1cm5lZCAke2Jhc2Uob3AucGF0aCl9IGludG8gYSBzZXRgLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLmZvbGRlciA/PyBcIlwiLCBkaXI6IHRydWUgfSxcbiAgICAgIH07XG5cbiAgICAvLyDilIDilIAgcmV2ZXJzaWJsZSwgd2l0aCBhcmd1bWVudHMgb25seSB0aGUgYWN0IGtuZXcg4pSA4pSAXG4gICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgaWYgKGFmdGVyLnBhdGggPT09IHVuZGVmaW5lZCB8fCBhZnRlci5mcm9tID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBtb3ZlZCAke2Jhc2UoYWZ0ZXIuZnJvbSl9IGludG8gJHtiYXNlKHBhcmVudChhZnRlci5wYXRoKSl9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIm1vdmVcIiwgcGF0aDogYWZ0ZXIucGF0aCwgaW50bzogcGFyZW50KGFmdGVyLmZyb20pIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgIGlmIChhZnRlci5wYXRoID09PSB1bmRlZmluZWQgfHwgYWZ0ZXIuZnJvbSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgcmVuYW1lZCAke2Jhc2UoYWZ0ZXIuZnJvbSl9IHRvICR7YmFzZShhZnRlci5wYXRoKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwicmVuYW1lXCIsIHBhdGg6IGFmdGVyLnBhdGgsIG5hbWU6IGJhc2UoYWZ0ZXIuZnJvbSkgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJoaWRlXCI6IHtcbiAgICAgIC8vIFR3byBzaGFwZXM6IGhpZGluZyBvbmUgaXRlbSBpbnNpZGUgYSBzZXQsIG9yIGhpZGluZyBhIHNpbmdsZS1kb2N1bWVudFxuICAgICAgLy8gZW50cnksIHdoaWNoIHJlbW92ZXMgdGhlIGVudHJ5IG91dHJpZ2h0LlxuICAgICAgaWYgKGFmdGVyLnJlbW92ZWRFbnRyeSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcmVtb3ZlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX0gZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImNvbnRleHQuYWRkXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY29uc3QgaGFkID0gYmVmb3JlLmhpZGRlbjtcbiAgICAgIGlmICghaGFkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgcmVtb3ZlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX0gZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IGhhZC5lbnRyeSwgcmVsczogaGFkLnJlbHMgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJ1bmhpZGVcIjoge1xuICAgICAgY29uc3QgaGFkID0gYmVmb3JlLmhpZGRlbjtcbiAgICAgIC8vIE5vdGhpbmcgd2FzIGhpZGRlbiwgc28gbm90aGluZyBoYXBwZW5lZDogbm90IGhpc3RvcnkuXG4gICAgICBpZiAoIWhhZCB8fCBoYWQucmVscy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBicm91Z2h0IGJhY2sgJHtoYWQucmVscy5sZW5ndGh9IGhpZGRlbiBpdGVtJHtoYWQucmVscy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImhpZGRlblwiLCBlbnRyeTogaGFkLmVudHJ5LCByZWxzOiBoYWQucmVscyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjoge1xuICAgICAgY29uc3Qgd2FzID0gYmVmb3JlLndvcmtzcGFjZTtcbiAgICAgIGlmICh3YXMgPT09IHVuZGVmaW5lZCB8fCB3YXMgPT09IGFmdGVyLnBhdGgpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBzZXQgdGhlIHdvcmtzcGFjZSB0byAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwid29ya3NwYWNlXCIsIHBhdGg6IHdhcyB9LFxuICAgICAgfTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFdoYXQgdGhlIGFycm93cyBuZWVkIHRvIGtub3csIGFuZCBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgdHlwZSBIaXN0b3J5VmlldyA9IHtcbiAgY2FuVW5kbzogYm9vbGVhbjtcbiAgY2FuUmVkbzogYm9vbGVhbjtcbiAgLyoqIFwibW92ZWQgbm90ZS5tZCBpbnRvIGRyYWZ0c1wiLCBmb3IgdGhlIHRvb2x0aXAuICovXG4gIHVuZG9MYWJlbD86IHN0cmluZztcbiAgcmVkb0xhYmVsPzogc3RyaW5nO1xuICAvKipcbiAgICogU2V0IHdoZW4gdGhlIG5leHQgdW5kbyB3b3VsZCBERUxFVEUgc29tZXRoaW5nLCBzbyB0aGUgc3VyZmFjZSBjYW4gcmFpc2UgYVxuICAgKiBjb25maXJtYXRpb24gYmVmb3JlIHNlbmRpbmcgaXQuIFByZXNlbnQgbWVhbnMgXCJhc2sgZmlyc3RcIiwgbm90IFwicmVmdXNlXCIuXG4gICAqL1xuICB1bmRvRGVsZXRlcz86IHsgcGF0aDogc3RyaW5nOyBkaXI6IGJvb2xlYW4gfTtcbn07XG5cbi8qKlxuICogVGhlIHR3byBzdGFja3MuXG4gKlxuICog4pqgIElOIE1FTU9SWSwgTk9UIElOIFRIRSBNQU5JRkVTVCwgYW5kIHRoYXQgaXMgYSBkZWNpc2lvbiByYXRoZXIgdGhhblxuICogbGF6aW5lc3M6IGFuIGludmVyc2UgcmVjb3JkZWQgbm93IGRlc2NyaWJlcyB0aGUgd29ybGQgYXMgaXQgaXMgbm93LCBhbmQgYVxuICogc2Vzc2lvbiByZXN0b3JlZCB0b21vcnJvdyBtYXkgbWVldCBhIGZpbGUgc29tZWJvZHkgaGFzIHNpbmNlIG1vdmVkIGJ5IGhhbmQuXG4gKiBPZmZlcmluZyBhbiB1bmRvIHdob3NlIGFyZ3VtZW50cyBoYXZlIGdvbmUgc3RhbGUgaXMgd29yc2UgdGhhbiBzdGFydGluZyBlYWNoXG4gKiBzZXNzaW9uIHdpdGggYW4gZW1wdHkgaGlzdG9yeSDigJQgc28gdGhlIGFycm93cyBhcmUgZ3JleSBhZnRlciBhIHJlc3RvcmUsIHdoaWNoXG4gKiBpcyBob25lc3QgYWJvdXQgd2hhdCBjYW4gc3RpbGwgYmUgcHV0IGJhY2suXG4gKi9cbmV4cG9ydCBjbGFzcyBIaXN0b3J5IHtcbiAgcHJpdmF0ZSB1bmRvczogQWN0W10gPSBbXTtcbiAgcHJpdmF0ZSByZWRvczogQWN0W10gPSBbXTtcblxuICAvKiogUmVjb3JkIGFuIGFjdC4gQSBuZXcgYWN0IG1ha2VzIHRoZSByZWRvIHN0YWNrIG1lYW5pbmdsZXNzLiAqL1xuICBkaWQoYWN0OiBBY3QgfCBudWxsKTogdm9pZCB7XG4gICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICB0aGlzLnVuZG9zLnB1c2goYWN0KTtcbiAgICB0aGlzLnJlZG9zID0gW107XG4gIH1cblxuICAvKiogV2hhdCB0aGUgbmV4dCB1bmRvIHdvdWxkIGRvLCB3aXRob3V0IGRvaW5nIGl0LiAqL1xuICBwZWVrVW5kbygpOiBBY3QgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy51bmRvc1t0aGlzLnVuZG9zLmxlbmd0aCAtIDFdID8/IG51bGw7XG4gIH1cblxuICBwZWVrUmVkbygpOiBBY3QgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5yZWRvc1t0aGlzLnJlZG9zLmxlbmd0aCAtIDFdID8/IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogVGFrZSB0aGUgbmV4dCB1bmRvLCBoYXZpbmcgYXBwbGllZCBpdC4gYHJlZG9gIGlzIHRoZSBhY3QgdGhhdCB3b3VsZCBwdXQgaXRcbiAgICogYmFjayDigJQgYnVpbHQgYnkgdGhlIGNhbGxlciwgYmVjYXVzZSBvbmx5IHRoZSBjYWxsZXIga25vd3Mgd2hhdCBpdHMgb3duXG4gICAqIGludmVyc2UgcHJvZHVjZWQuXG4gICAqL1xuICB0b29rVW5kbyhyZWRvOiBBY3QgfCBudWxsKTogdm9pZCB7XG4gICAgY29uc3QgYWN0ID0gdGhpcy51bmRvcy5wb3AoKTtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIGlmIChyZWRvKSB0aGlzLnJlZG9zLnB1c2gocmVkbyk7XG4gIH1cblxuICB0b29rUmVkbyh1bmRvOiBBY3QgfCBudWxsKTogdm9pZCB7XG4gICAgY29uc3QgYWN0ID0gdGhpcy5yZWRvcy5wb3AoKTtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIGlmICh1bmRvKSB0aGlzLnVuZG9zLnB1c2godW5kbyk7XG4gIH1cblxuICB2aWV3KCk6IEhpc3RvcnlWaWV3IHtcbiAgICBjb25zdCB1bmRvID0gdGhpcy5wZWVrVW5kbygpO1xuICAgIGNvbnN0IHJlZG8gPSB0aGlzLnBlZWtSZWRvKCk7XG4gICAgY29uc3QgZGVsZXRlcyA9IHVuZG8/LmludmVyc2Uua2luZCA9PT0gXCJkZWxldGVcIiA/IHVuZG8uaW52ZXJzZSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4ge1xuICAgICAgLy8g4puUIEEgREVMRVRJTkcgVU5ETyBJUyBTVElMTCBVTkRPQUJMRSDigJQgdGhlIGdhdGUgaXMgdGhlIGRpYWxvZywgbm90IHRoZVxuICAgICAgLy8gZGlzYWJsZWQgc3RhdGUgKENvbGUncyBydWxpbmcsIHJldmVyc2luZyBhbiBlYXJsaWVyIGRlc2lnbiB0aGF0XG4gICAgICAvLyBzdHJhbmRlZCBldmVyeSBhY3QgYmVoaW5kIGEgY3JlYXRpb24pLlxuICAgICAgY2FuVW5kbzogdW5kbyAhPT0gbnVsbCxcbiAgICAgIGNhblJlZG86IHJlZG8gIT09IG51bGwsXG4gICAgICAuLi4odW5kbyA/IHsgdW5kb0xhYmVsOiB1bmRvLmxhYmVsIH0gOiB7fSksXG4gICAgICAuLi4ocmVkbyA/IHsgcmVkb0xhYmVsOiByZWRvLmxhYmVsIH0gOiB7fSksXG4gICAgICAuLi4oZGVsZXRlcyA/IHsgdW5kb0RlbGV0ZXM6IHsgcGF0aDogZGVsZXRlcy5wYXRoLCBkaXI6IGRlbGV0ZXMuZGlyIH0gfSA6IHt9KSxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEhvdyBkZWVwIHRoZSBzdGFja3MgYXJlIOKAlCBmb3IgdGVzdHMgYW5kIGZvciBgc3RhdGUgLS1mdWxsYC4gKi9cbiAgZGVwdGgoKTogeyB1bmRvOiBudW1iZXI7IHJlZG86IG51bWJlciB9IHtcbiAgICByZXR1cm4geyB1bmRvOiB0aGlzLnVuZG9zLmxlbmd0aCwgcmVkbzogdGhpcy5yZWRvcy5sZW5ndGggfTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBOQVRJVkUgZmlsZSBwaWNrZXIg4oCUIHRoZSBhZmZvcmRhbmNlIGEgd2ViIHBhZ2UgY2Fubm90IGhhdmUuXG4gKlxuICogQSBicm93c2VyJ3Mgb3duIGA8aW5wdXQgdHlwZT1cImZpbGVcIj5gIGFuZCBgc2hvd09wZW5GaWxlUGlja2VyKClgIGJvdGggaGFuZFxuICogYmFjayBmaWxlIENPTlRFTlQgYW5kIGEgbmFtZSwgbmV2ZXIgYSBwYXRoIChhbmQgQnJhdmUsIENvbGUncyBicm93c2VyLFxuICogZGlzYWJsZXMgdGhlIEZpbGUgU3lzdGVtIEFjY2VzcyBBUEkgb3V0cmlnaHQpLiBBIGNvcHkgaXMgYWxsIGEgcGFnZSBjYW4gZG9cbiAqIHdpdGggdGhhdCwgd2hpY2ggaXMgZXhhY3RseSB3aGF0IGEgZHJvcCBhbHJlYWR5IGRvZXMgKEUyMykuIEJ1dCBzY3JpcHRvcml1bSdzXG4gKiBkYWVtb24gaXMgYSBMT0NBTCBQUk9DRVNTOiBpdCBjYW4gYXNrIHRoZSBPUyBmb3IgaXRzIG93biBvcGVuIGRpYWxvZyBhbmQgZ2V0XG4gKiBiYWNrIGEgcmVhbCBmaWxlc3lzdGVtIHBhdGgg4oCUIHNvIFwiQ2hvb3Nl4oCmXCIgbGlua3MgdGhlIHJlYWwgZmlsZSAoRTEpIGluc3RlYWRcbiAqIG9mIGNvcHlpbmcgaXQuXG4gKlxuICogRXZlcnl0aGluZyBoZXJlIGlzIHB1cmU6IHdoaWNoIGFyZ3YgdG8gcnVuLCBhbmQgaG93IHRvIHJlYWQgd2hhdCBpdCBwcmludGVkLlxuICogVGhlIHNwYXduaW5nIChhbmQgdGhlIG9uZS1hdC1hLXRpbWUgcnVsZSkgaXMgdGhlIGRhZW1vbidzLlxuICovXG5cbmV4cG9ydCB0eXBlIFBpY2tLaW5kID0gXCJmaWxlXCIgfCBcImZvbGRlclwiO1xuXG4vKiogQW4gQXBwbGVTY3JpcHQgdGhhdCBwdXRzIG9uZSBQT1NJWCBwYXRoIHBlciBsaW5lIG9uIHN0ZG91dC4gKi9cbmZ1bmN0aW9uIGFwcGxlU2NyaXB0KGtpbmQ6IFBpY2tLaW5kLCBwcm9tcHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHF1b3RlZCA9IHByb21wdC5yZXBsYWNlKC9bXCJcXFxcXS9nLCBcIlwiKTtcbiAgY29uc3QgY2hvb3NlID1cbiAgICBraW5kID09PSBcImZpbGVcIlxuICAgICAgPyBgY2hvb3NlIGZpbGUgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIiB3aXRoIG11bHRpcGxlIHNlbGVjdGlvbnMgYWxsb3dlZGBcbiAgICAgIDogYHtjaG9vc2UgZm9sZGVyIHdpdGggcHJvbXB0IFwiJHtxdW90ZWR9XCJ9YDtcbiAgcmV0dXJuIFtcbiAgICBgc2V0IGNob3NlbiB0byAke2Nob29zZX1gLFxuICAgICdzZXQgb3V0IHRvIFwiXCInLFxuICAgIFwicmVwZWF0IHdpdGggZiBpbiBjaG9zZW5cIixcbiAgICBcInNldCBvdXQgdG8gb3V0ICYgUE9TSVggcGF0aCBvZiBmICYgbGluZWZlZWRcIixcbiAgICBcImVuZCByZXBlYXRcIixcbiAgICBcInJldHVybiBvdXRcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjb21tYW5kIHRoYXQgb3BlbnMgdGhlIE9TJ3MgcGlja2VyLCBvciBudWxsIHdoZXJlIHRoZXJlIGlzIG5vbmUg4oCUIHRoZVxuICogY2FsbGVyIHRoZW4gc2F5cyBzbyByYXRoZXIgdGhhbiBoYW5naW5nIG9uIGEgZGlhbG9nIG5vYm9keSB3aWxsIHNlZS5cbiAqIGB6ZW5pdHlBdGAgaXMgd2hlcmUgYSBMaW51eCB6ZW5pdHkgd2FzIGZvdW5kICh0aGUgY2FsbGVyIGxvb2tzIGl0IHVwKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpY2tlckNvbW1hbmQoXG4gIHBsYXRmb3JtOiBzdHJpbmcsXG4gIGtpbmQ6IFBpY2tLaW5kLFxuICBwcm9tcHQ6IHN0cmluZyxcbiAgemVuaXR5QXQ/OiBzdHJpbmcgfCBudWxsLFxuKTogc3RyaW5nW10gfCBudWxsIHtcbiAgaWYgKHBsYXRmb3JtID09PSBcImRhcndpblwiKSByZXR1cm4gW1wib3Nhc2NyaXB0XCIsIFwiLWVcIiwgYXBwbGVTY3JpcHQoa2luZCwgcHJvbXB0KV07XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSByZXR1cm4gbnVsbDsgLy8gUG93ZXJTaGVsbCdzIGRpYWxvZyBuZWVkcyBhIFNUQSBob3N0OyBub3Qgd3JpdHRlbiB1bnRpbCBhc2tlZCBmb3JcbiAgaWYgKHplbml0eUF0KVxuICAgIHJldHVybiBbXG4gICAgICB6ZW5pdHlBdCxcbiAgICAgIFwiLS1maWxlLXNlbGVjdGlvblwiLFxuICAgICAgLi4uKGtpbmQgPT09IFwiZm9sZGVyXCIgPyBbXCItLWRpcmVjdG9yeVwiXSA6IFtcIi0tbXVsdGlwbGVcIl0pLFxuICAgICAgXCItLXNlcGFyYXRvcj1cXG5cIixcbiAgICAgIGAtLXRpdGxlPSR7cHJvbXB0fWAsXG4gICAgXTtcbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBUaGUgcGF0aHMgYSBwaWNrZXIgcHJpbnRlZDogb25lIHBlciBsaW5lLCBibGFua3MgZHJvcHBlZCwgb3JkZXIga2VwdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVBpY2tlck91dHB1dChzdGRvdXQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHN0ZG91dFxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5tYXAoKGwpID0+IGwudHJpbSgpKVxuICAgIC5maWx0ZXIoKGwpID0+IGwuc3RhcnRzV2l0aChcIi9cIikpXG4gICAgLm1hcCgobCkgPT4gKGwubGVuZ3RoID4gMSAmJiBsLmVuZHNXaXRoKFwiL1wiKSA/IGwuc2xpY2UoMCwgLTEpIDogbCkpO1xufVxuXG4vKiogQSBjYW5jZWxsZWQgZGlhbG9nIGlzIG5vdCBhIGZhaWx1cmUg4oCUIG9zYXNjcmlwdCBleGl0cyAxLCB6ZW5pdHkgZXhpdHMgMSwgYW5kIG5vdGhpbmcgd2FzIGNob3Nlbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YXNDYW5jZWxsZWQoZXhpdENvZGU6IG51bWJlciwgc3Rkb3V0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGV4aXRDb2RlICE9PSAwICYmIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dCkubGVuZ3RoID09PSAwO1xufVxuIiwKICAgICIvLyBFNjY6IHdoaWNoIGRvY3VtZW50IHRleHQgYSBoZWxkIHNlbGVjdGlvbiBpcyBhYm91dCDigJQgc2hhcmVkIGJ5IHRoZSBkYWVtb25cbi8vICh3aGF0IGBzYXlgIG1heSBhdHRhY2gpIGFuZCB0aGUgc3VyZmFjZSAod2hhdCB0aGUgY2hpcCBtYXkgc2hvdyksIHNvIHRoZSB0d29cbi8vIGhhbHZlcyBjYW5ub3QgZGlzYWdyZWUgYWJvdXQgd2hlbiBhIHNlbGVjdGlvbiBzdG9wcyBiZWluZyB0cnVlLlxuXG4vKiogVGhlIGRvY3VtZW50IHRleHQgb24gc2NyZWVuOiB0aGUgb3BlbiBkb2N1bWVudCwgYXQgaXRzIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuZXhwb3J0IHR5cGUgU2NyZWVuID0geyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH07XG5cbi8qKlxuICogVGhlIGhlbGQgc2VsZWN0aW9uIGlmIGl0IGlzIHN0aWxsIGFib3V0IHRoZSB0ZXh0IG9uIHNjcmVlbiwgZWxzZSBudWxsLlxuICpcbiAqIOKblCBBIFNFTEVDVElPTiBCRUxPTkdTIFRPIFRIRSBURVhUIElUIFdBUyBNQURFIElOLCBhbmQgY2Fubm90IG91dGxpdmUgdGhhdFxuICogdGV4dCBsZWF2aW5nIHRoZSBzY3JlZW4uIE9wZW5pbmcgYW5vdGhlciBkb2N1bWVudCDigJQgYnkgdGhlIGNvbnRleHQgbGlzdCwgYVxuICogc2VhcmNoIHJlc3VsdCwgYSBub3RlJ3MgXCJvcGVuXCIsIHRoZSBhZ2VudCDigJQgb3IgbWFraW5nIGFub3RoZXIgdmVyc2lvbiBhY3RpdmVcbiAqIHVzZWQgdG8gbGVhdmUgaXQgaGVsZCwgYW5kIHRoZSBzdXJmYWNlIHJlLXNlbnQgaXQgc3RhbXBlZCB3aXRoIHRoZSBORVdcbiAqIGRvY3VtZW50OiB0aGUgY2hpcCByZWFkIGBiZXRhLm1kIMK3IHYxIMK3IGxpbmUgNWAgb3ZlciBhbHBoYSdzIHdvcmRzLCBhbmQgYVxuICogYHNheWAgYXR0YWNoZWQgdGhlbSB0byBiZXRhJ3MgcGF0aC4gRHJvcHBlZCwgbmV2ZXIgcmUtbGFiZWxsZWQg4oCUIHRoZSBzYW1lXG4gKiBjbGVhciBhcyB0aGUgY2hpcCdzIFggKENvbGUsIDIwMjYtMDktMjI6IG9uZSBzdGF0ZSwgb25lIG1lYW5pbmcpLlxuICpcbiAqIFJldHVybnMgdGhlIFNBTUUgdmFsdWUgd2hlbiBpdCBpcyBrZXB0LCBzbyBhIGNhbGxlciBjYW4gdGVsbCBcIm5vIGNoYW5nZVwiIGJ5XG4gKiBpZGVudGl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdGlvbk9uU2NyZWVuPFQgZXh0ZW5kcyBTY3JlZW4+KFxuICBzZWw6IFQgfCBudWxsLFxuICBzY3JlZW46IFNjcmVlbiB8IG51bGwsXG4pOiBUIHwgbnVsbCB7XG4gIGlmICghc2VsIHx8ICFzY3JlZW4pIHJldHVybiBudWxsO1xuICByZXR1cm4gc2VsLmRvYyA9PT0gc2NyZWVuLmRvYyAmJiBzZWwudmVyc2lvbiA9PT0gc2NyZWVuLnZlcnNpb24gPyBzZWwgOiBudWxsO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBzZXNzaW9uIOKAlCB0aGUgZGFlbW9uJ3Mgc3RhdGUsIGFuZCB0aGUgb25seSBjb2RlIHRoYXQgd3JpdGVzIGEgZmlsZS5cbiAqXG4gKiBFOCdzIHNoYXBlLCB0aGUgaG91c2UncyBcIm1hdGVyaWFsaXplZCBwYXRoXCIgcGF0dGVybjogdGhlIGRhZW1vbiBvd25zIHRoZVxuICogc2Vzc2lvbiAoY29udGV4dCwgZG9jcywgdmVyc2lvbnMsIHdoaWNoIGlzIGFjdGl2ZSwgdGhlIGNoYXQpIGFuZCBwZXJzaXN0cyBpdFxuICogYXMgYG1hbmlmZXN0Lmpzb25gOyBldmVyeSB2ZXJzaW9uJ3MgVEVYVCBpcyBhIGZpbGUgaW4gdGhlIHNlc3Npb24gZm9sZGVyLCBzb1xuICogdGhlIGFnZW50IGVkaXRzIHZlcnNpb25zIHdpdGggaXRzIG93biBmaWxlIHRvb2xzLlxuICpcbiAqICAgICAkU0NSSVBUT1JJVU1fSE9NRS9zZXNzaW9ucy88c2Vzc2lvbklkPi9cbiAqICAgICAgIG1hbmlmZXN0Lmpzb24gICAgICAgICAgICAgIHdyaXR0ZW4gYXRvbWljYWxseSwgb24gZXZlcnkgY2hhbmdlXG4gKiAgICAgICBkb2NzLzxzbHVnPi92MS5tZCwgdjIubWQgICBvbmUgZmlsZSBwZXIgdmVyc2lvblxuICpcbiAqIFRoZSB0aHJlZSB3cml0ZSBydWxlcywgZWFjaCBhIGRlY2lzaW9uIHJhdGhlciB0aGFuIGEgaGFiaXQ6XG4gKlxuICogLSAqKlRoZSBvcmlnaW5hbCBpcyB3cml0dGVuIE9OTFkgYnkgYHNhdmVgKiogKEU3KS4gT3BlbmluZyBjb3BpZXMgaXQgdG8gdjE7XG4gKiAgIG5vdGhpbmcgZWxzZSB0b3VjaGVzIGl0LlxuICogLSAqKkV2ZXJ5IHdyaXRlIHRoaXMgbW9kdWxlIG1ha2VzIGlzIHJlbWVtYmVyZWQgYnkgY29udGVudCBoYXNoKiogKHRoZVxuICogICBgb3duZWRgIG1hcCkgc28gdGhlIHdhdGNoZXIgY2FuIHRlbGwgdGhlIGRhZW1vbidzIG93biB3cml0ZXMgZnJvbSBhbnlvbmVcbiAqICAgZWxzZSdzIChpbnZlc3RpZ2F0aW9uIMKnNSkuIEEgd3JpdGUgdG8gdGhlIEFDVElWRSB2ZXJzaW9uIHRoYXQgaXMgbm90IG91cnNcbiAqICAgaXMgYW4gRTIgdmlvbGF0aW9uIHRoZSBkYWVtb24gYW5ub3VuY2VzLlxuICogLSAqKlRoZSBhZ2VudCBuZXZlciB3cml0ZXMgdGhlIGFjdGl2ZSB2ZXJzaW9uKiogKEUyKSDigJQgZW5mb3JjZWQgc29jaWFsbHkgYnlcbiAqICAgU0tJTEwubWQgYW5kIGRldGVjdGVkIGhlcmUsIG5vdCBwcmV2ZW50ZWQ6IHRoZSBmaWxlIGlzIHRoZSBhZ2VudCdzIG1lZGl1bS5cbiAqXG4gKiBOb3RoaW5nIGhlcmUga25vd3MgYWJvdXQgc29ja2V0cywgSFRUUCBvciB0aGUgZXZlbnQgbG9nLiBUaGUgZGFlbW9uIGNhbGxzIGFcbiAqIG1ldGhvZCwgZ2V0cyBhIHJlc3VsdCwgYW5kIGRlY2lkZXMgd2hhdCB0byBicm9hZGNhc3Q7IHRoYXQgc3BsaXQgaXMgd2hhdFxuICogbGV0cyB0aGUgdW5pdCBjZWxscyBkcml2ZSB0aGUgd2hvbGUgbW9kZWwgd2l0aCBhIHRlbXAgaG9tZS5cbiAqL1xuXG5pbXBvcnQge1xuICBjbG9zZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgb3BlblN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWRTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIC8vIOKaoCBgcm1kaXJTeW5jYCByYXRoZXIgdGhhbiBgcm1TeW5jKOKApiwge3JlY3Vyc2l2ZTp0cnVlfSlgIE9OIFBVUlBPU0U6IGl0XG4gIC8vIHRocm93cyBFTk9URU1QVFksIHdoaWNoIGlzIGEgc2Vjb25kIG5ldCB1bmRlciBgcmVtb3ZlQ3JlYXRlZGAncyBvd25cbiAgLy8gZW1wdGluZXNzIGNoZWNrLiBBIHJlY3Vyc2l2ZSBkZWxldGUgd291bGQgbWFrZSB0aGUgYnVnIGl0IHByZXZlbnRzXG4gIC8vIHVucmVjb3ZlcmFibGUgcmF0aGVyIHRoYW4gbG91ZC5cbiAgcm1kaXJTeW5jLFxuICBybVN5bmMsXG4gIHN0YXRTeW5jLFxuICB1bmxpbmtTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgZXh0bmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IHR5cGUgQW5jaG9yLCBhbmNob3JPZiwgZmluZEFuY2hvciwgbGluZXNPZiB9IGZyb20gXCIuL2FuY2hvcnNcIjtcbmltcG9ydCB7IGFwcGx5SHVua3MsIGRpZmZUZXh0IH0gZnJvbSBcIi4vZGlmZlwiO1xuaW1wb3J0IHsgdHlwZSBGaW5kaW5nLCBmaW5kaW5ncyB9IGZyb20gXCIuL2RvY3RvclwiO1xuaW1wb3J0IHtcbiAgYm9keUxpbmVPZmZzZXQsXG4gIGJ1aWxkQmxvY2ssXG4gIGd1ZXNzVHlwZSxcbiAgbWF0Y2hlc0ZpbHRlcixcbiAgcmVhZE1ldGEsXG4gIHNldEtleSxcbiAgc3BsaXRGcm9udG1hdHRlcixcbiAgc3VtbWFyaXplLFxuICB0aXRsZUZyb21Cb2R5LFxuICB3aXRoQmxvY2ssXG59IGZyb20gXCIuL2Zyb250bWF0dGVyXCI7XG5pbXBvcnQgeyB0eXBlIEJ1bmRsZUluZGV4LCBidWlsZEdyYXBoLCB0eXBlIFJlc29sdXRpb24sIHJlc29sdmVUYXJnZXQgfSBmcm9tIFwiLi9saW5rc1wiO1xuaW1wb3J0IHR5cGUge1xuICBDaGF0TWVzc2FnZSxcbiAgQ2hhdFdobyxcbiAgQ2xvc2VkQnksXG4gIENvbnRleHRFbnRyeSxcbiAgQ29udGV4dE5vZGUsXG4gIERpZmZQYXlsb2FkLFxuICBEaWZmU2lkZSxcbiAgRG9jTWV0YSxcbiAgRG9jU3VtbWFyeSxcbiAgRG9jVmlldyxcbiAgR3JhcGhQYXlsb2FkLFxuICBNZXRhRmlsdGVyLFxuICBNb3ZlUGxhbixcbiAgTm90ZSxcbiAgTm90ZVJlZixcbiAgUGxhY2VkTm90ZSxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgVGFzayxcbiAgVmVyc2lvbixcbiAgVmVyc2lvbkF1dGhvcixcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgQ2FuZGlkYXRlLCB0eXBlIFNlYXJjaFJlcG9ydCwgc2VhcmNoRG9jdW1lbnRzIH0gZnJvbSBcIi4vc2VhcmNoXCI7XG5pbXBvcnQge1xuICBET0NfRVhURU5TSU9OUyxcbiAgZG9jUGF0aHMsXG4gIGVudHJ5Rm9yUGF0aCxcbiAgZmluZE5vZGUsXG4gIGlzRG9jTmFtZSxcbiAgbG9jYXRlLFxuICBNSVJST1JfTk9ERV9DQVAsXG4gIHNjYW5UcmVlLFxuICB0b1Bvc2l4LFxufSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCBjb25zdCBNQU5JRkVTVF9GT1JNQVQgPSAxO1xuXG4vKiogVGhlIG1vc3QgZG9jdW1lbnRzIG9uZSBmcm9udG1hdHRlciBzY2FuIHJlYWRzLiAqL1xuZXhwb3J0IGNvbnN0IE1FVEFfU0NBTl9DQVAgPSA1MDA7XG4vKiogQSBmcm9udG1hdHRlciBibG9jayBsaXZlcyBhdCB0aGUgdG9wIG9mIGEgZmlsZTsgdGhpcyBpcyBob3cgbXVjaCB3ZSByZWFkIHRvIGZpbmQgaXQuICovXG5jb25zdCBNRVRBX0hFQURfQllURVMgPSA4MTkyO1xuXG4vKiogVGhlIGZpcnN0IDggS0Igb2YgYSBmaWxlLCBhcyB0ZXh0IOKAlCBlbm91Z2ggZm9yIGFueSBmcm9udG1hdHRlciBibG9jay4gKi9cbmZ1bmN0aW9uIHJlYWRIZWFkKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBmZDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGZkID0gb3BlblN5bmMocGF0aCwgXCJyXCIpO1xuICAgIGNvbnN0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyhNRVRBX0hFQURfQllURVMpO1xuICAgIGNvbnN0IHJlYWQgPSByZWFkU3luYyhmZCwgYnVmLCAwLCBNRVRBX0hFQURfQllURVMsIDApO1xuICAgIHJldHVybiBidWYuc3ViYXJyYXkoMCwgcmVhZCkudG9TdHJpbmcoXCJ1dGY4XCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoZmQgIT09IHVuZGVmaW5lZCkgY2xvc2VTeW5jKGZkKTtcbiAgfVxufVxuXG50eXBlIERvY1JlY29yZCA9IHtcbiAgc2x1Zzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIG9yaWdpbmFsOiBzdHJpbmc7XG4gIGVudHJ5SWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlbDogc3RyaW5nIHwgbnVsbDtcbiAgZXh0OiBzdHJpbmc7XG4gIHZlcnNpb25zOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPltdO1xuICBhY3RpdmU6IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyIHRvIGhhbmQgb3V0IOKAlCBNT05PVE9OSUMsIGFuZCBuZXZlciBkZXJpdmVkIGZyb21cbiAgICogdGhlIHZlcnNpb25zIHN0aWxsIHByZXNlbnQgKEU0MSkuIE51bWJlcmluZyBhcyBgbWF4KGV4aXN0aW5nKSArIDFgIHdhc1xuICAgKiBjb3JyZWN0IHdoaWxlIG5vdGhpbmcgY291bGQgYmUgZGVsZXRlZDsgdGhlIG1vbWVudCBhIHZlcnNpb24gY2FuIGJlXG4gICAqIHJlbW92ZWQsIGRlbGV0aW5nIHRoZSBoaWdoZXN0IG1ha2VzIHRoZSBuZXh0IG9uZSBSRVVTRSBpdHMgbnVtYmVyLCBhbmQgYVxuICAgKiBgdjNgIG5hbWVkIGluIGEgY2hhdCBtZXNzYWdlLCBhIGxvZyBsaW5lIG9yIGFuIGFnZW50J3Mgbm90ZXMgd291bGQgdGhlblxuICAgKiBwb2ludCBhdCBhIGRpZmZlcmVudCBkb2N1bWVudC4gQWJzZW50IG9uIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgRTQxIOKAlFxuICAgKiBgdGFrZVZlcnNpb25gIGRlcml2ZXMgaXQgb25jZSwgZnJvbSB0aGUgaGlnaGVzdCB0aGF0IGV2ZXIgd2FzLlxuICAgKi9cbiAgbmV4dFZlcnNpb24/OiBudW1iZXI7XG4gIC8qKiBOb3RlcyBvbiB0aGlzIGRvY3VtZW50IChFNDUpLiBTdG9yZWQgaW4gdGhlIG1hbmlmZXN0OiB0aGV5IHRyYXZlbCB3aXRoIHRoZVxuICAgKiAgc2Vzc2lvbiBhbmQgbmV2ZXIgbGl0dGVyIHRoZSBodW1hbidzIGZvbGRlci4gKi9cbiAgbm90ZXM/OiBOb3RlW107XG4gIC8qKiBIYXNoIG9mIHRoZSBvcmlnaW5hbCBhcyB3ZSBsYXN0IHJlYWQgb3Igd3JvdGUgaXQg4oCUIGF0IG9wZW4sIHNhdmUsIHJldmVydFxuICAgKiAgYW5kIHJlbG9hZCDigJQgc28gYSByZXN0b3JlIGNhbiB0ZWxsIHRoYXQgaXQgY2hhbmdlZCB3aGlsZSBubyBkYWVtb24gd2FzXG4gICAqICB3YXRjaGluZyAodmVyaWZ5LXBhc3MgZml4IDIpLiAqL1xuICBvcmlnaW5hbEhhc2g6IHN0cmluZztcbiAgLyoqIFNldCBvbmx5IGJ5IGBvcGVuUGF0aGAsIHdoaWNoIGFkbWl0cyBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiAgZW50cnkuIGBzYXZlYCB3cml0ZXMgbm8gb3JpZ2luYWwgdGhhdCBsYWNrcyBpdCAodmVyaWZ5LXBhc3MgZml4IDFjKS4gKi9cbiAgYWRtaXR0ZWQ/OiBib29sZWFuO1xuICBvdXRzaWRlQ2hhbmdlZDogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIE1hbmlmZXN0ID0ge1xuICBmb3JtYXQ6IG51bWJlcjtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBjb250ZXh0OiBDb250ZXh0RW50cnlbXTtcbiAgZG9jczogRG9jUmVjb3JkW107XG4gIG9wZW5Eb2M6IHN0cmluZyB8IG51bGw7XG4gIGNoYXQ6IENoYXRNZXNzYWdlW107XG4gIC8qKiBUaGUgd29yayBxdWV1ZSAoRTUwKS4gQWJzZW50IGluIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgaXQgZXhpc3RlZC4gKi9cbiAgdGFza3M/OiBUYXNrW107XG4gIC8qKiBFMjMncyB3b3Jrc3BhY2UuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQ6IHRoZSB1c2VyJ3MgaG9tZS4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xuICAvKipcbiAgICogV2hvIGVuZGVkIHRoaXMgc2Vzc2lvbiwgYW5kIHdoZW4g4oCUIHNldCBhdCB0ZWFyZG93biwgY2xlYXJlZCBieSBhIHJlc3RvcmUuXG4gICAqIOKblCBJVCBMSVZFUyBIRVJFIEJFQ0FVU0UgVEhFIE1BTklGRVNUIE9VVExJVkVTIFRIRSBEQUVNT046IGEgdmVyYiBydW4gYWZ0ZXJcbiAgICogdGhlIGVuZCBmaW5kcyBubyBkYWVtb24gdG8gYXNrLCBhbmQgbXVzdCBzdGlsbCB0ZWxsIFwidGhlIGh1bWFuIGVuZGVkIHRoaXNcbiAgICogb24gcHVycG9zZVwiIChkbyBub3QgcmVvcGVuKSBmcm9tIGEgdGltZW91dCBvciBhIGNyYXNoIChyZW9wZW4gZnJlZWx5KS5cbiAgICogQWJzZW50IHdoaWxlIGxpdmUsIGFmdGVyIGEgY3Jhc2gsIGFuZCBvbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQuXG4gICAqL1xuICBlbmRlZD86IHsgYnk6IENsb3NlZEJ5OyBhdDogbnVtYmVyIH07XG59O1xuXG4vKiogQSByZWZ1c2FsIHRoZSBkYWVtb24gdHVybnMgaW50byBhbiBIVFRQIHN0YXR1cyDigJQgYGNob2ljZXNgIHdoZW4gdGhlIHNldCBpcyBpbiBoYW5kIChBMSkuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvbkVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgc3RhdHVzOiA0MDAgfCA0MDQgfCA0MDksXG4gICAgcmVhZG9ubHkgY2hvaWNlcz86IHN0cmluZ1tdLFxuICAgIC8qKlxuICAgICAqIFdoYXQgdG8gRE8gYWJvdXQgaXQsIHdoZW4gdGhlIG1lc3NhZ2UgYWxvbmUgZG9lcyBub3Qgc2F5LiBDYXJyaWVkIHRvIHRoZVxuICAgICAqIENMSSdzIGVudmVsb3BlLCB3aGVyZSB0aGUgaG91c2UgdGF4b25vbXkgYWxyZWFkeSBoYXMgYSBgaGludGAgZmllbGQgdGhhdFxuICAgICAqIHJlZnVzYWxzIGZyb20gdGhpcyBzaWRlIHdlcmUgbmV2ZXIgZmlsbGluZy5cbiAgICAgKi9cbiAgICByZWFkb25seSBoaW50Pzogc3RyaW5nLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgY29udGVudEhhc2ggPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IEJ1bi5oYXNoKHRleHQpLnRvU3RyaW5nKDE2KTtcblxuY29uc3QgcmFuZEhleCA9IChuOiBudW1iZXIpID0+XG4gIEFycmF5LmZyb20oY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhuZXcgVWludDhBcnJheShuKSkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxuICAgIC5qb2luKFwiXCIpO1xuXG5leHBvcnQgY29uc3QgbmV3U2Vzc2lvbklkID0gKCk6IHN0cmluZyA9PiByYW5kSGV4KDQpO1xuXG4vKiogQSBwYXRoJ3MgcmVhbHBhdGgsIG9yIHRoZSBwYXRoIGl0c2VsZiB3aGVuIGl0IGNhbm5vdCBiZSByZXNvbHZlZCAoZ29uZSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhbE9yKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWxwYXRoU3luYyhwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHA7XG4gIH1cbn1cblxuLyoqIFdoYXQgYSB3YXRjaGVyIGV2ZW50IHR1cm5lZCBvdXQgdG8gYmUuIGBudWxsYCA9IG5vdGhpbmcgKG91cnMsIG9yIG5vIGNoYW5nZSkuICovXG5leHBvcnQgdHlwZSBGaWxlRXZlbnQgPVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBhY3RpdmU6IGZhbHNlIH1cbiAgfCB7XG4gICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCI7XG4gICAgICBkb2M6IHN0cmluZztcbiAgICAgIHZlcnNpb246IG51bWJlcjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIC8qKiBUaGUgbmV3IGFnZW50IHZlcnNpb24gdGhlIG91dHNpZGUgdGV4dCB3YXMgcHJlc2VydmVkIGFzLiAqL1xuICAgICAgcHJlc2VydmVkQXM6IG51bWJlcjtcbiAgICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZztcbiAgICAgIC8qKiAjMTE3OiB0aGUgaHVtYW4gYWN0aXZhdGVkIHRoaXMgdmVyc2lvbiB3aGlsZSBpdCB3YXMgc3RpbGwgdGhlIGFnZW50J3NcbiAgICAgICAqICB1bndyaXR0ZW4gY29weSwgc28gdGhlIHdyaXRlIHdhcyB0aGUgYWdlbnQgZmlsbGluZyBpdCBpbiwgbm90IGJyZWFraW5nIEUyLiAqL1xuICAgICAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbjogYm9vbGVhbjtcbiAgICB9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiOyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInRyZWVcIjsgZW50cnlJZDogc3RyaW5nIH07XG5cbi8qKiBBIHZlcnNpb24gYW4gb3V0c2lkZSB3cml0ZSB3YXMga2VwdCBhcyDigJQgYW5kIHdoZXRoZXIgdGhhdCB3cml0ZSB3YXMgdGhlICMxMTcgcmFjZS4gKi9cbmV4cG9ydCB0eXBlIFByZXNlcnZlZFZlcnNpb24gPSBWZXJzaW9uICYgeyBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuOiBib29sZWFuIH07XG5cbmV4cG9ydCBjbGFzcyBTZXNzaW9uIHtcbiAgcmVhZG9ubHkgZGlyOiBzdHJpbmc7XG4gIHByaXZhdGUgbTogTWFuaWZlc3Q7XG4gIC8qKiBwYXRoIOKGkiBoYXNoIG9mIHRoZSBkYWVtb24ncyBsYXN0IHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIG93bmVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIGhhc2ggb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgY3VycmVudCB0ZXh0LiAqL1xuICBwcml2YXRlIGFjdGl2ZUhhc2ggPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBhcyB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgKG9yIGFkb3B0ZWQpXG4gICAqICBpdCDigJQgd2hhdCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBpcyByZXZlcnRlZCB0by4gKi9cbiAgcHJpdmF0ZSBsYXN0QWN0aXZlVGV4dCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKlxuICAgKiAjMTE3IOKAlCBwYXRoIOKGkiBoYXNoIG9mIGFuIGFnZW50IGB2ZXJzaW9uLW5ld2AgQ09QWSBhcyB0aGUgZGFlbW9uIG1hZGUgaXQsXG4gICAqIHdoaWxlIG5vYm9keSBoYXMgd3JpdHRlbiBpdCB5ZXQuIE5vdCBwZXJzaXN0ZWQ6IGl0IG9ubHkgaGFzIHRvIG91dGxpdmUgdGhlXG4gICAqIHNlY29uZHMgYmV0d2VlbiBgdmVyc2lvbi1uZXdgIGFuZCB0aGUgYWdlbnQncyB3cml0ZS5cbiAgICpcbiAgICog4puUIEFDVElWQVRJT04gRE9FUyBOT1QgQ0xFQVIgSVQuIFRoZSBmYWN0IGlzIFwidGhpcyB2ZXJzaW9uIHN0aWxsIGhvbGRzIHRoZVxuICAgKiBjb3B5IGl0IHdhcyBtYWRlIGZyb20gYW5kIG5vYm9keSBoYXMgd3JpdHRlbiBpdFwiIOKAlCB0cnVlIGFjcm9zcyBhbnkgbnVtYmVyXG4gICAqIG9mIGFjdGl2YXRpb25zLiBDbGVhcmluZyBpdCBvbiBhY3RpdmF0ZSBsb3N0IGl0IG9uIGEgaHVtYW4gZmxpcC1mbG9wXG4gICAqIChhY3RpdmF0ZSB2NCwgcGljayB2MSwgcGljayB2NCBhZ2FpbjsgdmVyaWZpZXIsIDIwMjYtMTAtMDEpLCBhbmQgdGhlIGFnZW50J3NcbiAgICogd3JpdGUgdGhlbiBnb3QgdGhlIG9sZCBcImJlbG9uZ3MgaW4gYSBuZXcgdmVyc2lvblwiIG1lc3NhZ2UgdGhhdCBpbnZpdGVzIHRoZVxuICAgKiBkdXBsaWNhdGUgIzExNyBzZXQgb3V0IHRvIHN0b3AuIEl0IGdvZXMgd2hlbiB0aGUgY29udGVudCBjaGFuZ2VzIChhblxuICAgKiBvdXRzaWRlIHdyaXRlLCBhIGh1bWFuIGVkaXQpIG9yIHRoZSB2ZXJzaW9uIGlzIGRlbGV0ZWQuXG4gICAqL1xuICBwcml2YXRlIHVud3JpdHRlbkNvcGllcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiAjMTE3IOKAlCBzbHVnIOKGkiB0aGUgdmVyc2lvbiB0aGUgSFVNQU4gYWN0aXZhdGVkIHdoaWxlIGl0IHdhcyBzdGlsbCBhblxuICAgKiAgdW53cml0dGVuIGNvcHkuIFJlYWQgKGFuZCBjbGVhcmVkKSBieSB0aGUgbmV4dCBvdXRzaWRlIHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIGFjdGl2YXRlZFVud3JpdHRlbiA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8qKiBXaGF0IGEgcmVzdG9yZSBmb3VuZCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy4gKi9cbiAgcmVzdG9yZUZpbmRpbmdzOiB7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyBtaXNzaW5nOiBib29sZWFuIH1bXSA9IFtdO1xuXG4gIHByaXZhdGUgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgaG9tZTogc3RyaW5nLFxuICAgIG1hbmlmZXN0OiBNYW5pZmVzdCxcbiAgKSB7XG4gICAgdGhpcy5tID0gbWFuaWZlc3Q7XG4gICAgdGhpcy5kaXIgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgbWFuaWZlc3Quc2Vzc2lvbklkKTtcbiAgfVxuXG4gIHN0YXRpYyBjcmVhdGUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyA9IG5ld1Nlc3Npb25JZCgpLCB3b3Jrc3BhY2U/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgICAgLi4uKHdvcmtzcGFjZSA/IHsgd29ya3NwYWNlOiByZXNvbHZlKHdvcmtzcGFjZSkgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIC8qKiBSZWxvYWQgYSBzZXNzaW9uIGZyb20gaXRzIG1hbmlmZXN0IChgb3BlbiAtLXJlc3RvcmUgPGlkPmApLiAqL1xuICBzdGF0aWMgcmVzdG9yZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBzZXNzaW9uSWQsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHNhdmVkIHNlc3Npb24gJHtzZXNzaW9uSWR9YCwgNDA0KTtcbiAgICBjb25zdCBtID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBNYW5pZmVzdDtcbiAgICBpZiAobS5mb3JtYXQgIT09IE1BTklGRVNUX0ZPUk1BVClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHNlc3Npb24gJHtzZXNzaW9uSWR9IGhhcyBtYW5pZmVzdCBmb3JtYXQgJHttLmZvcm1hdH1gLCA0MDkpO1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCBtKTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBNaXJyb3JzIGFyZSByZS1yZWFkLCBub3QgdHJ1c3RlZDogdGhlIGZvbGRlciBtYXkgaGF2ZSBjaGFuZ2VkIHdoaWxlIG5vXG4gICAgLy8gZGFlbW9uIHdhcyB3YXRjaGluZyBpdC5cbiAgICBmb3IgKGNvbnN0IGUgb2Ygcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgcy5yZXNjYW4oZS5pZCk7XG4gICAgZm9yIChjb25zdCBkIG9mIHMubS5kb2NzKSB7XG4gICAgICBjb25zdCBwID0gcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgICBjb25zdCB0ZXh0ID0gZXhpc3RzU3luYyhwKSA/IHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikgOiBcIlwiO1xuICAgICAgcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMjogYW4gb3JpZ2luYWwgY2hhbmdlZCB3aGlsZSB0aGUgc2Vzc2lvbiB3YXMgY2xvc2VkXG4gICAgICAvLyB3YXMgaW52aXNpYmxlIGhlcmUsIHNvIHRoZSBuZXh0IFNhdmUgb3Zlcndyb3RlIGl0IHVuYW5ub3VuY2VkLiBUaGVcbiAgICAgIC8vIG1hbmlmZXN0IGhvbGRzIHRoZSBvcmlnaW5hbCdzIGhhc2ggYXMgb2YgdGhlIGxhc3Qgb3Blbi9zYXZlL3JldmVydC9cbiAgICAgIC8vIHJlbG9hZDsgYSBkaWZmZXJlbnQgaGFzaCBub3cgaXMgYW4gb3V0c2lkZSBjaGFuZ2UsIG1hcmtlZCBleGFjdGx5IGFzIGFcbiAgICAgIC8vIGxpdmUgb25lIHdpdGggYSBkaXJ0eSBidWZmZXIgaXMg4oCUIGFza2VkLCBuZXZlciBtZXJnZWQgb3IgcmVsb2FkZWQuXG4gICAgICBsZXQgbm93OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5vdyA9IGNvbnRlbnRIYXNoKHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIG5vdyA9IG51bGw7XG4gICAgICB9XG4gICAgICBpZiAobm93ID09PSBudWxsIHx8IG5vdyAhPT0gZC5vcmlnaW5hbEhhc2gpIHtcbiAgICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICAgIHMucmVzdG9yZUZpbmRpbmdzLnB1c2goeyBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwsIG1pc3Npbmc6IG5vdyA9PT0gbnVsbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gQSByZXN0b3JlZCBzZXNzaW9uIGlzIGxpdmUgYWdhaW46IHdob2V2ZXIgZW5kZWQgaXQgYmVmb3JlLCBub2JvZHkgaGFzIG5vdy5cbiAgICBjb25zdCB3YXNFbmRlZCA9IHMubS5lbmRlZCAhPT0gdW5kZWZpbmVkO1xuICAgIGRlbGV0ZSBzLm0uZW5kZWQ7XG4gICAgaWYgKHMucmVzdG9yZUZpbmRpbmdzLmxlbmd0aCA+IDAgfHwgd2FzRW5kZWQpIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgc3RhdGljIGxpc3RTYXZlZChob21lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpLmZpbHRlcigoaWQpID0+XG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIsIGlkLCBcIm1hbmlmZXN0Lmpzb25cIikpLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gIH1cblxuICBnZXQgaWQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLnNlc3Npb25JZDtcbiAgfVxuXG4gIGdldCBkb2NzRGlyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kaXIsIFwiZG9jc1wiKTtcbiAgfVxuXG4gIGdldCBvcGVuRG9jU2x1ZygpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLm9wZW5Eb2M7XG4gIH1cblxuICBnZXQgY29udGV4dCgpOiByZWFkb25seSBDb250ZXh0RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRpcmVjdG9yeSB0aGUgd2F0Y2hlciBtdXN0IHNlZTogdGhlIHNlc3Npb24ncyBkb2NzLCBlYWNoIGVudHJ5IHJvb3QsXG4gICAqIGFuZCB0aGUgUkVBTCBkaXJlY3Rvcnkgb2YgZXZlcnkgb3BlbmVkIG9yaWdpbmFsLlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDM6IGVhY2ggcm9vdCBpcyB3YXRjaGVkIGF0IGl0cyBSRUFMUEFUSCAoYHdhdGNoYCksIGFuZFxuICAgKiBhbiBldmVudCBpcyByZXBvcnRlZCB1bmRlciB0aGUgcGF0aCBmb3JtIHRoZSBzZXNzaW9uIHN0b3JlcyAoYHBhdGhgKS4gQVxuICAgKiB3YXRjaCBvbiBhIHN5bWxpbmtlZCBkaXJlY3Rvcnkg4oCUIGEgc3ltbGlua2VkIGhvbWUsIGEgc3ltbGlua2VkIGZvbGRlclxuICAgKiBlbnRyeSDigJQgb3Igb24gdGhlIGxpbmsncyBvd24gZGlyZWN0b3J5IGZvciBhIHN5bWxpbmtlZCBvcmlnaW5hbCBzYXdcbiAgICogbm90aGluZyB3aGVuIHRoZSBUQVJHRVQgY2hhbmdlZCAoRlNFdmVudHMgcmVwb3J0cyByZWFsIHBhdGhzKS4gQSBzeW1saW5rZWRcbiAgICogb3JpZ2luYWwgaXMgbWF0Y2hlZCBiYWNrIHRvIGl0cyBkb2MgYnkgcmVhbHBhdGggaW4gYG9uRmlsZUV2ZW50YC5cbiAgICovXG4gIHdhdGNoUm9vdHMoKTogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10ge1xuICAgIGNvbnN0IHJvb3RzOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSA9IFtcbiAgICAgIHsgcGF0aDogdGhpcy5kb2NzRGlyLCB3YXRjaDogcmVhbE9yKHRoaXMuZG9jc0RpciksIHJlY3Vyc2l2ZTogdHJ1ZSB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgcm9vdHMucHVzaCh7XG4gICAgICAgIHBhdGg6IGUucm9vdCxcbiAgICAgICAgd2F0Y2g6IHJlYWxPcihlLnJvb3QpLFxuICAgICAgICByZWN1cnNpdmU6IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiLFxuICAgICAgICBlbnRyeUlkOiBlLmlkLFxuICAgICAgfSk7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCByZWFsRGlyID0gZGlybmFtZShyZWFsT3IoZC5vcmlnaW5hbCkpO1xuICAgICAgaWYgKFxuICAgICAgICAhcm9vdHMuc29tZSgocikgPT4gci53YXRjaCA9PT0gcmVhbERpciAmJiByLnJlY3Vyc2l2ZSA9PT0gZmFsc2UpICYmXG4gICAgICAgICFyb290cy5zb21lKFxuICAgICAgICAgIChyKSA9PiByLnJlY3Vyc2l2ZSAmJiAocmVhbERpciA9PT0gci53YXRjaCB8fCByZWFsRGlyLnN0YXJ0c1dpdGgoci53YXRjaCArIHNlcCkpLFxuICAgICAgICApXG4gICAgICApXG4gICAgICAgIHJvb3RzLnB1c2goeyBwYXRoOiByZWFsRGlyLCB3YXRjaDogcmVhbERpciwgcmVjdXJzaXZlOiBmYWxzZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJvb3RzO1xuICB9XG5cbiAgLy8g4pSA4pSAIHBlcnNpc3RlbmNlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBSZWNvcmQgd2hvIGVuZGVkIHRoZSBzZXNzaW9uICh0ZWFyZG93biBwZXJzaXN0cyBpdCBuZXh0KS4gKi9cbiAgbWFya0VuZGVkKGJ5OiBDbG9zZWRCeSk6IHZvaWQge1xuICAgIHRoaXMubS5lbmRlZCA9IHsgYnksIGF0OiBEYXRlLm5vdygpIH07XG4gIH1cblxuICBwZXJzaXN0KCk6IHZvaWQge1xuICAgIG1rZGlyU3luYyh0aGlzLmRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGpvaW4odGhpcy5kaXIsIFwibWFuaWZlc3QuanNvblwiKSwgYCR7SlNPTi5zdHJpbmdpZnkodGhpcy5tLCBudWxsLCAyKX1cXG5gKTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVPd25lZChwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBSZW1lbWJlciBCRUZPUkUgd3JpdGluZzogdGhlIHdhdGNoZXIncyBldmVudCBjYW4gYXJyaXZlIGJlZm9yZSB0aGlzXG4gICAgLy8gZnVuY3Rpb24gcmV0dXJucywgYW5kIGl0IG11c3QgZmluZCB0aGUgaGFzaCBhbHJlYWR5IHRoZXJlLlxuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBhZG9wdEFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHAgPSB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICB0aGlzLm93bmVkLnNldChwLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZUFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5jb250ZW50Q2hhbmdlZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgLyoqIFRoZSB2ZXJzaW9uIGF0IGBwYXRoYCBub3cgaG9sZHMgYHRleHRgOiBhbiB1bndyaXR0ZW4gY29weSBpdCBubyBsb25nZXIgaXMuICovXG4gIHByaXZhdGUgY29udGVudENoYW5nZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAodGhpcy51bndyaXR0ZW5Db3BpZXMuZ2V0KHBhdGgpICE9PSBjb250ZW50SGFzaCh0ZXh0KSkgdGhpcy51bndyaXR0ZW5Db3BpZXMuZGVsZXRlKHBhdGgpO1xuICB9XG5cbiAgLyoqIEtlZXAgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gYXMgYSBORVcgYWdlbnQgdmVyc2lvbi4gKi9cbiAgcHJpdmF0ZSBwcmVzZXJ2ZU91dHNpZGUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiBQcmVzZXJ2ZWRWZXJzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgLy8gIzExNyDigJQgdHJ1ZSBvbmx5IHdoaWxlIEJPVEggaG9sZDogdGhlIGh1bWFuIGFjdGl2YXRlZCB0aGlzIHZlcnNpb24gYXMgYW5cbiAgICAvLyB1bndyaXR0ZW4gY29weSwgQU5EIGl0IGlzIG9uZSBzdGlsbCAobm9ib2R5IGhhcyBjaGFuZ2VkIGl0cyBjb250ZW50XG4gICAgLy8gc2luY2UpLiBBIGh1bWFuIHdobyB0eXBlZCBpbiBpdCBoYWQgd3JpdHRlbiBpdCAoc2Vjb25kIHZlcmlmaWVyLFxuICAgIC8vIDIwMjYtMTAtMDE6IGFjdGl2YXRlLCB0eXBlLCB3YWl0LCBhZ2VudCB3cml0ZXMg4oaSIHdhcyB0b2xkIFwiYmVmb3JlIHRoZVxuICAgIC8vIGFnZW50IGhhZCB3cml0dGVuIGl0XCIpLiBUaGUgY29udGVudCBydWxlIGRlY2lkZXMsIG5vdCB0aGUgYWN0aXZhdGlvbi5cbiAgICBjb25zdCBhY3RpdmF0ZWRCZWZvcmVXcml0dGVuID1cbiAgICAgIHRoaXMuYWN0aXZhdGVkVW53cml0dGVuLmdldChkLnNsdWcpID09PSBkLmFjdGl2ZSAmJiB0aGlzLnVud3JpdHRlbkNvcGllcy5oYXMocGF0aCk7XG4gICAgLy8gU29tZW9uZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb246IHdoYXRldmVyIGl0IGhvbGRzIG5leHQsIGl0IGhhcyBiZWVuIHdyaXR0ZW4uXG4gICAgdGhpcy51bndyaXR0ZW5Db3BpZXMuZGVsZXRlKHBhdGgpO1xuICAgIC8vIFNhaWQgb25jZTogdGhlIGZpcnN0IG91dHNpZGUgd3JpdGUgYWZ0ZXIgdGhlIHJhY2UgaXMgdGhlIGFnZW50IGZpbGxpbmdcbiAgICAvLyB0aGUgY29weSBpbjsgYW55IGxhdGVyIG9uZSBpcyB0aGUgb3JkaW5hcnkgY2FzZS5cbiAgICB0aGlzLmFjdGl2YXRlZFVud3JpdHRlbi5kZWxldGUoZC5zbHVnKTtcbiAgICBjb25zdCBuID0gdGhpcy50YWtlVmVyc2lvbihkKTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgZnJvbTogZC5hY3RpdmUsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBsYWJlbDogYG91dHNpZGUgd3JpdGUgdG8gdiR7ZC5hY3RpdmV9YCxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbiksIGFjdGl2YXRlZEJlZm9yZVdyaXR0ZW4gfTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmZiBgdGV4dGAgYXQgYHBhdGhgIGlzIGV4YWN0bHkgd2hhdCB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgdGhlcmUuICovXG4gIGlzT3duV3JpdGUocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5vd25lZC5nZXQocGF0aCkgPT09IGNvbnRlbnRIYXNoKHRleHQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbnRleHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkQ29udGV4dChyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBDb250ZXh0RW50cnk7IGFkZGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgY29uc3QgcHJvYmUgPSBlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCk7XG4gICAgY29uc3Qgc2FtZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5yb290ID09PSBwcm9iZS5yb290ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gcHJvYmUubWVtYmVyc2hpcCAmJlxuICAgICAgICAocHJvYmUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiIHx8XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgPT09IEpTT04uc3RyaW5naWZ5KHByb2JlLm5vZGVzKSksXG4gICAgKTtcbiAgICBpZiAoc2FtZSkgcmV0dXJuIHsgZW50cnk6IHNhbWUsIGFkZGVkOiBmYWxzZSB9O1xuICAgIHRoaXMubS5jb250ZXh0LnB1c2gocHJvYmUpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IHByb2JlLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIEFuIGVudHJ5J3Mgcm9vdCBwYXRoLCBzbyBFNjAgY2FuIHB1dCBiYWNrIGEgY29udGV4dCBlbnRyeSBpdCByZW1vdmVkLiAqL1xuICBlbnRyeVJvb3QoaWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dC5maW5kKChlKSA9PiBlLmlkID09PSBpZCk/LnJvb3QgPz8gbnVsbDtcbiAgfVxuXG4gIHJlbW92ZUNvbnRleHQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGkgPSB0aGlzLm0uY29udGV4dC5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgICBpZiAoaSA8IDApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKChlKSA9PiBlLmlkKSxcbiAgICAgICk7XG4gICAgdGhpcy5tLmNvbnRleHQuc3BsaWNlKGksIDEpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBvcGVuIGRvY3VtZW50IGxlZnQgdGhlIGNvbnRleHQgKGl0cyBlbnRyeSByZW1vdmVkLCBvciB0aGUgZG9jdW1lbnRcbiAgICogaGlkZGVuKTogY2xvc2UgaXQgaW4gdGhlIHZpZXcuIEl0cyB2ZXJzaW9ucyBzdGF5IGluIHRoZSBzZXNzaW9uIOKAlCBub3RoaW5nXG4gICAqIGlzIGRlbGV0ZWQg4oCUIGFuZCBicmluZ2luZyBpdCBiYWNrIGFuZCBvcGVuaW5nIGl0IGFnYWluIGZpbmRzIHRoZW0uXG4gICAqL1xuICBwcml2YXRlIGNsb3NlT3JwaGFuZWRPcGVuRG9jKCk6IHZvaWQge1xuICAgIGNvbnN0IG9wZW4gPSB0aGlzLm0ub3BlbkRvYyA/IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIGlmIChvcGVuICYmIG9wZW4uZW50cnlJZCA9PT0gbnVsbCkgdGhpcy5tLm9wZW5Eb2MgPSBudWxsO1xuICB9XG5cbiAgLyoqIFJlLW1pcnJvciBhIGZvbGRlciBlbnRyeS4gUmV0dXJucyB3aGV0aGVyIGl0cyBub2RlcyBjaGFuZ2VkLiAqL1xuICByZXNjYW4oZW50cnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmIChlPy5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGUucm9vdCwgTUlSUk9SX05PREVfQ0FQLCBlLmhpZGRlbik7XG4gICAgY29uc3QgY2hhbmdlZCA9XG4gICAgICBKU09OLnN0cmluZ2lmeShub2RlcykgIT09IEpTT04uc3RyaW5naWZ5KGUubm9kZXMpIHx8ICEhdHJ1bmNhdGVkICE9PSAhIWUudHJ1bmNhdGVkO1xuICAgIGUubm9kZXMgPSBub2RlcztcbiAgICBpZiAodHJ1bmNhdGVkKSBlLnRydW5jYXRlZCA9IHRydWU7XG4gICAgZWxzZSBkZWxldGUgZS50cnVuY2F0ZWQ7XG4gICAgaWYgKGNoYW5nZWQpIHRoaXMucmVsaW5rKCk7XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG4gIH1cblxuICBwcml2YXRlIHJlbGluaygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBkLm9yaWdpbmFsKTtcbiAgICAgIGQuZW50cnlJZCA9IGF0Py5lbnRyeUlkID8/IG51bGw7XG4gICAgICBkLnJlbCA9IGF0Py5yZWwgPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgZG9jdW1lbnRzIGFuZCB2ZXJzaW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIHZlcnNpb25QYXRoKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRvY3NEaXIsIGQuc2x1ZywgYHYke259JHtkLmV4dH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgZG9jT3JEaWUoc2x1Zz86IHN0cmluZyk6IERvY1JlY29yZCB7XG4gICAgY29uc3Qgd2FudCA9IHNsdWcgPz8gdGhpcy5tLm9wZW5Eb2MgPz8gdW5kZWZpbmVkO1xuICAgIGNvbnN0IG9wZW5lZCA9IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gZC5zbHVnKTtcbiAgICAvKipcbiAgICAgKiDim5QgV0hFTiBOT1RISU5HIElTIE9QRU4sIFRIRSBPUEVORUQgU0xVR1MgQVJFIEFOIEVNUFRZIExJU1QgQU5EIEFOIEVNUFRZXG4gICAgICogTElTVCBJUyBOT1QgQU4gQU5TV0VSLiBBIGNvbGQgYWdlbnQgbmFtZWQgYSBkb2N1bWVudCBieSBmaWxlbmFtZSBiZWZvcmVcbiAgICAgKiBhbnl0aGluZyB3YXMgb3BlbiBhbmQgZ290IGBjaG9pY2VzOiBbXWAgd2l0aCBubyBoaW50IOKAlCBmcm9tIGEgc2Vzc2lvblxuICAgICAqIHdob3NlIGNvbnRleHQgaGVsZCBleGFjdGx5IHRoZSB0d28gZG9jdW1lbnRzIGl0IGNvdWxkIGhhdmUgbmFtZWQuIFRoZVxuICAgICAqIHJlZnVzYWwgd2FzIGNvcnJlY3QgYW5kIHVzZWxlc3MsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIG1vZGUgYGNob2ljZXNgXG4gICAgICogZXhpc3RzIHRvIHByZXZlbnQuXG4gICAgICpcbiAgICAgKiBTbyBhbiB1bm9wZW5lZCBzZXNzaW9uIG9mZmVycyB0aGUgcGF0aHMgaXQgQ09VTEQgb3BlbiwgYW5kIHNheXMgaG93LiBBXG4gICAgICogZmlsZW5hbWUgb25seSByZXNvbHZlcyBmb3IgYSBkb2N1bWVudCB0aGF0IGlzIGFscmVhZHkgb3BlbjsgYSBwYXRoIGFsd2F5c1xuICAgICAqIG9wZW5zIG9uZS5cbiAgICAgKi9cbiAgICBjb25zdCBjaG9pY2VzID1cbiAgICAgIG9wZW5lZC5sZW5ndGggPiAwID8gb3BlbmVkIDogdGhpcy5tLmNvbnRleHQuZmxhdE1hcCgoZSkgPT4gZG9jUGF0aHMoZSkpLnNsaWNlKDAsIDIwKTtcbiAgICBjb25zdCBoaW50ID1cbiAgICAgIG9wZW5lZC5sZW5ndGggPiAwXG4gICAgICAgID8gdW5kZWZpbmVkXG4gICAgICAgIDogXCJub3RoaW5nIGlzIG9wZW4geWV0IOKAlCBwYXNzIGEgUEFUSCBmcm9tIHRoZSBjb250ZXh0IChhIGZpbGVuYW1lIG9ubHkgcmVzb2x2ZXMgb25jZSBhIGRvY3VtZW50IGlzIG9wZW4pXCI7XG4gICAgaWYgKHdhbnQgPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJubyBkb2N1bWVudCBpcyBvcGVuIOKAlCBuYW1lIG9uZSB3aXRoIC0tZG9jXCIsIDQwOSwgY2hvaWNlcywgaGludCk7XG4gICAgY29uc3QgZCA9IHRoaXMuZmluZERvYyh3YW50KTtcbiAgICBpZiAoIWQpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIGRvY3VtZW50IFwiJHt3YW50fVwiIGluIHRoaXMgc2Vzc2lvbmAsIDQwNCwgY2hvaWNlcywgaGludCk7XG4gICAgcmV0dXJuIGQ7XG4gIH1cblxuICAvKiogQSBkb2MgYnkgc2x1ZywgYnkgb3JpZ2luYWwgcGF0aCwgb3IgYnkgYSB1bmlxdWUgb3JpZ2luYWwgYmFzZW5hbWUuICovXG4gIGZpbmREb2Moa2V5OiBzdHJpbmcpOiBEb2NSZWNvcmQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGJ5U2x1ZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0ga2V5KTtcbiAgICBpZiAoYnlTbHVnKSByZXR1cm4gYnlTbHVnO1xuICAgIC8vIOKblCBPTkxZIEFOIEFCU09MVVRFIGtleSBpcyBhIHBhdGggKHZlcmlmeS1wYXNzIGZpeCA4KTogcmVzb2x2aW5nIGFcbiAgICAvLyByZWxhdGl2ZSBvbmUgaGVyZSByZXNvbHZlZCBpdCBhZ2FpbnN0IHRoZSBEQUVNT04ncyBjd2QuIFRoZSBDTEkgcmVzb2x2ZXNcbiAgICAvLyBhZ2FpbnN0IGl0cyBvd24gY3dkIGFuZCBzZW5kcyBhbiBhYnNvbHV0ZSBwYXRoLlxuICAgIGlmIChpc0Fic29sdXRlKGtleSkpIHtcbiAgICAgIGNvbnN0IGJ5UGF0aCA9IHRoaXMubS5kb2NzLmZpbmQoXG4gICAgICAgIChkKSA9PiBkLm9yaWdpbmFsID09PSBrZXkgfHwgcmVhbE9yKGQub3JpZ2luYWwpID09PSByZWFsT3Ioa2V5KSxcbiAgICAgICk7XG4gICAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIH1cbiAgICBjb25zdCBieU5hbWUgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+IGJhc2VuYW1lKGQub3JpZ2luYWwpID09PSBrZXkgfHwgZC5yZWwgPT09IGtleSk7XG4gICAgcmV0dXJuIGJ5TmFtZS5sZW5ndGggPT09IDEgPyBieU5hbWVbMF0gOiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogVGhlIG5leHQgdmVyc2lvbiBudW1iZXIsIGNvbnN1bWVkLiBOdW1iZXJzIGFyZSBuZXZlciByZXVzZWQgKEU0MSkuICovXG4gIHByaXZhdGUgdGFrZVZlcnNpb24oZDogRG9jUmVjb3JkKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gZC5uZXh0VmVyc2lvbiA/PyBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGQubmV4dFZlcnNpb24gPSBuICsgMTtcbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIHByaXZhdGUgdmVyc2lvbk9yRGllKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4ge1xuICAgIGNvbnN0IHYgPSBkLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubiA9PT0gbik7XG4gICAgaWYgKCF2KVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gdiR7bn1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIGQudmVyc2lvbnMubWFwKCh4KSA9PiBgdiR7eC5ufWApLFxuICAgICAgKTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHByaXZhdGUgc2x1Z0ZvcihvcmlnaW5hbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzdGVtID1cbiAgICAgIGJhc2VuYW1lKG9yaWdpbmFsLCBleHRuYW1lKG9yaWdpbmFsKSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05Xy1dKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIikgfHwgXCJkb2NcIjtcbiAgICBsZXQgc2x1ZyA9IHN0ZW07XG4gICAgZm9yIChsZXQgaSA9IDI7IHRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gc2x1Zyk7IGkrKykgc2x1ZyA9IGAke3N0ZW19LSR7aX1gO1xuICAgIHJldHVybiBzbHVnO1xuICB9XG5cbiAgLyoqXG4gICAqIE9wZW4gYSBkb2N1bWVudCBieSBpdHMgb3JpZ2luYWwncyBwYXRoOiB2MSBpcyB3cml0dGVuIGZyb20gdGhlIG9yaWdpbmFsXG4gICAqIHRoZSBmaXJzdCB0aW1lLiBgZm9jdXM6IGZhbHNlYCAodGhlIGFnZW50J3MgaW1wbGljaXQgb3BlbiB0aHJvdWdoXG4gICAqIGB2ZXJzaW9uLW5ldyAtLWRvYyA8cGF0aD5gKSBkb2VzIG5vdCBtb3ZlIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMWIg4oCUIEFETUlTU0lPTi4gT25seSBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiBlbnRyeSBpcyBhZG1pdHRlZDsgYGNvbnRleHQuYWRkYCBzdGF5cyB0aGUgb25lIHdheSBpbi4gQmVmb3JlIHRoaXMsIGFueVxuICAgKiBwYXRoIG9mIGFueSB0eXBlIHdhcyBvcGVuZWQsIGFuZCBTYXZlIHRoZW4gd3JvdGUgaXQ6IGEgZm9yZWlnbiB3ZWIgcGFnZVxuICAgKiB3cm90ZSBgY3VybCBldmlsIHwgc2hgIGludG8gYSBgLnJjYCBmaWxlIG91dHNpZGUgdGhlIGNvbnRleHQuXG4gICAqL1xuICBvcGVuUGF0aChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgZm9jdXM/OiBib29sZWFuIH0gPSB7fSk6IHsgc2x1Zzogc3RyaW5nOyBjcmVhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGZvY3VzID0gb3B0cy5mb2N1cyA/PyB0cnVlO1xuICAgIC8vIFRoZSBjb250ZXh0J3Mgb3duIHNwZWxsaW5nIG9mIHRoZSBwYXRoOiBhIGNhbGxlciB3aG9zZSBjd2QgaXMgYSByZWFscGF0aFxuICAgIC8vICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgb3IgdGhyb3VnaCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAgLy8gZmlsZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBkb2MuXG4gICAgY29uc3QgYWJzID0gdGhpcy5jYW5vbmljYWwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBhYnMpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGV4aXN0aW5nLnNsdWc7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IHNsdWc6IGV4aXN0aW5nLnNsdWcsIGNyZWF0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmICghaXNEb2NOYW1lKGFicykpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCA0MDApO1xuICAgIGlmICghbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7YWJzfSBpcyBub3QgaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dCDigJQgYWRkIGl0IChvciBpdHMgZm9sZGVyKSBmaXJzdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSBmaWxlXCIpO1xuICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBvcGVuICR7YWJzfTogbm8gc3VjaCBmaWxlYCwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgZXh0ID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0uaW5jbHVkZXMoZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKCkpXG4gICAgICA/IGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpXG4gICAgICA6IFwiLm1kXCI7XG4gICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicyk7XG4gICAgY29uc3QgZDogRG9jUmVjb3JkID0ge1xuICAgICAgc2x1ZzogdGhpcy5zbHVnRm9yKGFicyksXG4gICAgICBuYW1lOiBiYXNlbmFtZShhYnMpLFxuICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgIGVudHJ5SWQ6IGF0Py5lbnRyeUlkID8/IG51bGwsXG4gICAgICByZWw6IGF0Py5yZWwgPz8gbnVsbCxcbiAgICAgIGV4dCxcbiAgICAgIHZlcnNpb25zOiBbeyBuOiAxLCBhdXRob3I6IFwiaHVtYW5cIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH1dLFxuICAgICAgYWN0aXZlOiAxLFxuICAgICAgb3JpZ2luYWxIYXNoOiBjb250ZW50SGFzaCh0ZXh0KSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFkbWl0dGVkOiB0cnVlLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MucHVzaChkKTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBkLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBjcmVhdGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogYGFic2AgYXMgdGhlIGNvbnRleHQgc3BlbGxzIGl0LCB3aGVuIGl0IGlzIHRoZSBzYW1lIGZpbGUgYnkgcmVhbHBhdGguICovXG4gIHByaXZhdGUgY2Fub25pY2FsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAoIXJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3BlbGxlZCA9IGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgc3BlbGxlZCkpIHJldHVybiBzcGVsbGVkO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgb3BlblNsdWcoc2x1Zzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLmRvY09yRGllKHNsdWcpLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICByZWFkVmVyc2lvbihzbHVnOiBzdHJpbmcsIG46IG51bWJlcik6IHsgdGV4dDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgbik7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgcmV0dXJuIHsgdGV4dDogcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSwgcGF0aCB9O1xuICB9XG5cbiAgYWN0aXZlUGF0aChzbHVnPzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgZCA9IHNsdWcgPyB0aGlzLmZpbmREb2Moc2x1ZykgOiB0aGlzLm0ub3BlbkRvYyA/IHRoaXMuZmluZERvYyh0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIGQgPyB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSA6IG51bGw7XG4gIH1cblxuICAvKiogVGhlIGh1bWFuJ3MgYnVmZmVyIHJlYWNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uJ3MgZmlsZSAoZGVib3VuY2VkIGJ5IHRoZSBzdXJmYWNlKS4gKi9cbiAgLyoqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggNCDigJQgQ0hFQ0sgQkVGT1JFIFdSSVRFLiBCZWZvcmUgdGhlIGh1bWFuJ3MgZWRpdCBpc1xuICAgKiB3cml0dGVuLCB0aGUgZmlsZSBvbiBkaXNrIGlzIGhhc2hlZDogaWYgaXQgaXMgbm90IHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgKiB3cml0ZSwgc29tZW9uZSBlbHNlIHdyb3RlIHRoZSBhY3RpdmUgdmVyc2lvbiAoRTIpLiBUaGF0IHRleHQgaXMga2VwdCBhcyBhXG4gICAqIE5FVyBhZ2VudCB2ZXJzaW9uLCBhbmQgb25seSB0aGVuIGlzIHRoZSBlZGl0IHdyaXR0ZW4uIERldGVjdGlvbiB1c2VkIHRvXG4gICAqIGRlcGVuZCBvbiB0aGUgd2F0Y2hlcidzIDYwIG1zIHNldHRsZSB0aW1lciBmaXJpbmcgYmVmb3JlIHRoZSBuZXh0XG4gICAqIGtleXN0cm9rZTsgYSBidXJzdCBvZiBlZGl0cyBhdCAzMCBtcyBjbG9iYmVyZWQgYW4gb3V0c2lkZSB3cml0ZVxuICAgKiB1bmFubm91bmNlZC4gTm93IG5vdGhpbmcgaXMgbG9zdCB3aGF0ZXZlciB0aGUgdGltaW5nIOKAlCB0aGUgb25lIHdpbmRvdyBsZWZ0XG4gICAqIGlzIHRoZSBtaWNyb3NlY29uZHMgYmV0d2VlbiB0aGlzIHJlYWQgYW5kIHRoaXMgd3JpdGUuXG4gICAqL1xuICBlZGl0KFxuICAgIHNsdWc6IHN0cmluZyxcbiAgICBuOiBudW1iZXIsXG4gICAgdGV4dDogc3RyaW5nLFxuICApOiB7IGRpcnR5Q2hhbmdlZDogYm9vbGVhbjsgcHJlc2VydmVkOiBQcmVzZXJ2ZWRWZXJzaW9uIHwgbnVsbCB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBpZiAobiAhPT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7bn0gaXMgbm90IHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30gKHYke2QuYWN0aXZlfSBpcykg4oCUIG9ubHkgdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIGVkaXRhYmxlYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSB0aGlzLmlzRGlydHkoZCk7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgLy8gVGhlIGVkaXQgaXMgc3RhZ2VkIGluIGEgc2libGluZyBmaWxlIEZJUlNULCBzbyB0aGUgY2hlY2sgYmVsb3cgYW5kIHRoZVxuICAgIC8vIHJlbmFtZSB0aGF0IGxhbmRzIHRoZSBlZGl0IGFyZSBhZGphY2VudCBzeXNjYWxsczogdGhlIHdpbmRvdyBpbiB3aGljaCBhblxuICAgIC8vIG91dHNpZGUgd3JpdGUgY291bGQgc2xpcCBiZXR3ZWVuIHRoZW0gaXMgbWljcm9zZWNvbmRzLCBub3QgdGhlIGxlbmd0aCBvZlxuICAgIC8vIGEgbXVsdGktbWVnYWJ5dGUgd3JpdGUg4oCUIGFuZCBhIHdyaXRlIGxhbmRpbmcgQUZURVIgdGhlIHJlbmFtZSBnb2VzIHRvIHRoZVxuICAgIC8vIG5ldyBmaWxlLCB3aGVyZSB0aGUgd2F0Y2hlciBmaW5kcyBpdCBhbmQgcHJlc2VydmVzIGl0IHRvby5cbiAgICBjb25zdCBzdGFnZWQgPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS5lZGl0YDtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YWdlZCwgdGV4dCk7XG4gICAgbGV0IHByZXNlcnZlZDogUHJlc2VydmVkVmVyc2lvbiB8IG51bGwgPSBudWxsO1xuICAgIGxldCBvbkRpc2s6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBvbkRpc2sgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgb25EaXNrID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKG9uRGlzayAhPT0gbnVsbCAmJiAhdGhpcy5pc093bldyaXRlKHBhdGgsIG9uRGlzaykpXG4gICAgICBwcmVzZXJ2ZWQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCBvbkRpc2spO1xuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICByZW5hbWVTeW5jKHN0YWdlZCwgcGF0aCk7XG4gICAgdGhpcy5jb250ZW50Q2hhbmdlZChwYXRoLCB0ZXh0KTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gICAgcmV0dXJuIHsgZGlydHlDaGFuZ2VkOiBiZWZvcmUgIT09IHRoaXMuaXNEaXJ0eShkKSwgcHJlc2VydmVkIH07XG4gIH1cblxuICAvKipcbiAgICogQ29weSBhIHZlcnNpb24gdG8gYSBuZXcgZmlsZTsgdGhlIGFnZW50IHRoZW4gZWRpdHMgdGhhdCBmaWxlIHdpdGggaXRzIG93blxuICAgKiB0b29scy4gV2l0aCBgdGV4dGAgKCMxMTcsIGB2ZXJzaW9uLW5ldyAtLWJvZHktZmlsZWApIHRoZSBuZXcgZmlsZSBob2xkc1xuICAgKiB0aGF0IHRleHQgaW5zdGVhZCwgd3JpdHRlbiBiZWZvcmUgYW55b25lIGlzIHRvbGQgdGhlIHZlcnNpb24gZXhpc3RzIOKAlCBzb1xuICAgKiB0aGVyZSBpcyBubyBtb21lbnQgaW4gd2hpY2ggYW4gdW53cml0dGVuIGNvcHkgY2FuIGJlIGFjdGl2YXRlZC5cbiAgICovXG4gIG5ld1ZlcnNpb24ob3B0czoge1xuICAgIGRvYz86IHN0cmluZztcbiAgICBmcm9tPzogbnVtYmVyO1xuICAgIGxhYmVsPzogc3RyaW5nO1xuICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgYXV0aG9yOiBWZXJzaW9uQXV0aG9yO1xuICB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBWZXJzaW9uO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgZnJvbSA9IG9wdHMuZnJvbSA/PyBkLmFjdGl2ZTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBmcm9tKTtcbiAgICBjb25zdCB0ZXh0ID0gb3B0cy50ZXh0ID8/IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGZyb20pLCBcInV0ZjhcIik7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IG9wdHMuYXV0aG9yLFxuICAgICAgZnJvbSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIC4uLihvcHRzLmxhYmVsID8geyBsYWJlbDogb3B0cy5sYWJlbCB9IDoge30pLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIGlmIChvcHRzLnRleHQgPT09IHVuZGVmaW5lZCAmJiBvcHRzLmF1dGhvciA9PT0gXCJhZ2VudFwiKVxuICAgICAgdGhpcy51bndyaXR0ZW5Db3BpZXMuc2V0KHRoaXMudmVyc2lvblBhdGgoZCwgbiksIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAoRTQxKS5cbiAgICpcbiAgICog4puUIFRIRSBBQ1RJVkUgVkVSU0lPTiBDQU5OT1QgQkUgREVMRVRFRCwgYW5kIHJlZnVzaW5nIGlzIGJldHRlciB0aGFuXG4gICAqIHBpY2tpbmcgYSByZXBsYWNlbWVudDogY2hvb3Npbmcgb25lIGZvciB0aGUgaHVtYW4gd291bGQgc2lsZW50bHkgbW92ZVxuICAgKiB3aGVyZSB0aGVpciBlZGl0cyBhbmQgU2F2ZSBhcmUgcG9pbnRlZCwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBFMiBhbmQgRTdcbiAgICogZXhpc3QgdG8ga2VlcCBleHBsaWNpdC4gQmVjYXVzZSBleGFjdGx5IG9uZSB2ZXJzaW9uIGlzIGFsd2F5cyBhY3RpdmUsIHRoaXNcbiAgICogYWxzbyBtZWFucyB0aGUgbGFzdCB2ZXJzaW9uIGNhbiBuZXZlciBiZSBkZWxldGVkIOKAlCBhIGRvY3VtZW50IGFsd2F5cyBoYXNcbiAgICogc29tZXRoaW5nIHRvIGVkaXQsIHdpdGhvdXQgdGhhdCBiZWluZyBhIHNlY29uZCBydWxlLlxuICAgKlxuICAgKiBgZnJvbWAgcG9pbnRlcnMgb24gT1RIRVIgdmVyc2lvbnMgYXJlIGxlZnQgYXMgdGhleSBhcmUuIFwiTWFkZSBmcm9tIHYyXCJcbiAgICogc3RheXMgdHJ1ZSBhZnRlciB2MiBpcyBnb25lOyBkZWxldGluZyBhIHZlcnNpb24gaXMgbm90IHJld3JpdGluZyB0aGVcbiAgICogaGlzdG9yeSBvZiB0aGUgb25lcyB0aGF0IHJlbWFpbi5cbiAgICovXG4gIGRlbGV0ZVZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgcmVtYWluaW5nOiBudW1iZXI7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCB2ID0gdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBpZiAob3B0cy52ZXJzaW9uID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtvcHRzLnZlcnNpb259IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGFjdGl2YXRlIGFub3RoZXIgb25lIGZpcnN0LCBgICtcbiAgICAgICAgICBgdGhlbiBkZWxldGUgdGhpc2AsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgLy8g4puUIE1BVEVSSUFMSVNFIFRIRSBDT1VOVEVSIEJFRk9SRSBSRU1PVklORyBUSEUgUkVDT1JELiBgdGFrZVZlcnNpb25gXG4gICAgLy8gZGVyaXZlcyBpdCBsYXppbHkgZnJvbSB0aGUgdmVyc2lvbnMgUFJFU0VOVCwgc28gb24gYSBkb2MgdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBhbGxvY2F0ZWQgb25lIChhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSwgcmVzdG9yZWQpIGRlbGV0aW5nIHRoZVxuICAgIC8vIGhpZ2hlc3Qgd291bGQgbGV0IHRoZSBuZXh0IGFsbG9jYXRpb24gZGVyaXZlIHRoZSBzYW1lIG51bWJlciBhZ2Fpbi4gRm91bmRcbiAgICAvLyBieSBkcml2aW5nIGl0LCBub3QgYnkgdGhlIHVuaXQgdGVzdCBhYm92ZSDigJQgd2hpY2ggYWxsb2NhdGVkIGZpcnN0IGFuZCBzb1xuICAgIC8vIG5ldmVyIGhhZCBhIGNvbGQgY291bnRlci5cbiAgICBkLm5leHRWZXJzaW9uID8/PSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgoeCkgPT4geC5uKSkgKyAxO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG9wdHMudmVyc2lvbik7XG4gICAgZC52ZXJzaW9ucyA9IGQudmVyc2lvbnMuZmlsdGVyKCh4KSA9PiB4Lm4gIT09IG9wdHMudmVyc2lvbik7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhwYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRoZSByZWNvcmQgaXMgd2hhdCB0aGUgc2Vzc2lvbiBiZWxpZXZlczsgYSBmaWxlIGFscmVhZHkgZ29uZSAoYSBoYW5kXG4gICAgICAvLyB0aWR5LCBhIGNyYXNoIGJldHdlZW4gd3JpdGUgYW5kIHJlY29yZCkgbXVzdCBub3QgYmxvY2sgcmVtb3ZpbmcgaXQuXG4gICAgfVxuICAgIHRoaXMub3duZWQuZGVsZXRlKHBhdGgpO1xuICAgIHRoaXMudW53cml0dGVuQ29waWVzLmRlbGV0ZShwYXRoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogb3B0cy52ZXJzaW9uLFxuICAgICAgLi4uKHYubGFiZWwgPyB7IGxhYmVsOiB2LmxhYmVsIH0gOiB7fSksXG4gICAgICByZW1haW5pbmc6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICBhY3RpdmF0ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBieT86IFwiaHVtYW5cIiB8IFwiYWdlbnRcIiB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBwcmV2aW91czogbnVtYmVyO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IGQuYWN0aXZlO1xuICAgIGQuYWN0aXZlID0gb3B0cy52ZXJzaW9uO1xuICAgIC8vIFRoZSBuZXcgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IEFTIElUIElTIE5PVyBpcyB0aGUgYmFzZWxpbmUgdGhlIG5leHRcbiAgICAvLyBjaGVjay1iZWZvcmUtd3JpdGUgY29tcGFyZXMgYWdhaW5zdC5cbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gICAgdGhpcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAvLyAjMTE3OiB0aGUgaHVtYW4gY2hvc2UgYSB2ZXJzaW9uIHRoZSBhZ2VudCBoYXMgbm90IHdyaXR0ZW4geWV0IChpdHMgdGV4dFxuICAgIC8vIGlzIHN0aWxsIHRoZSBjb3B5IGB2ZXJzaW9uLW5ld2AgbWFkZSkuIFRoZSBhZ2VudCdzIHdyaXRlIGlzIGNvbWluZyBhbmRcbiAgICAvLyB3aWxsIGxhbmQgb24gdGhlIGFjdGl2ZSB2ZXJzaW9uOyByZW1lbWJlciB3aHksIHNvIHRoZSBzYWZlZ3VhcmQgY2FuIHNheSBzby5cbiAgICBjb25zdCB1bndyaXR0ZW4gPSB0aGlzLnVud3JpdHRlbkNvcGllcy5nZXQocGF0aCk7XG4gICAgaWYgKG9wdHMuYnkgPT09IFwiaHVtYW5cIiAmJiB1bndyaXR0ZW4gPT09IGNvbnRlbnRIYXNoKHRleHQpKVxuICAgICAgdGhpcy5hY3RpdmF0ZWRVbndyaXR0ZW4uc2V0KGQuc2x1ZywgZC5hY3RpdmUpO1xuICAgIGVsc2UgdGhpcy5hY3RpdmF0ZWRVbndyaXR0ZW4uZGVsZXRlKGQuc2x1Zyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBwcmV2aW91cyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbXBhcmluZyBhbmQgbWVyZ2luZyAoRTM2KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogVGhlIHRleHQgb2Ygb25lIHNpZGUgb2YgYSBjb21wYXJpc29uLiBgXCJvcmlnaW5hbFwiYCBpcyByZWFkIGZyb20gRElTSywgbm90XG4gICAqIGZyb20gYSBjYWNoZTogdGhlIHdob2xlIHBvaW50IG9mIGNvbXBhcmluZyBhZ2FpbnN0IGl0IGlzIHRvIHNlZSB3aGF0IHRoZVxuICAgKiBmaWxlIG9mIHJlY29yZCBhY3R1YWxseSBzYXlzIHJpZ2h0IG5vdywgaW5jbHVkaW5nIGEgY2hhbmdlIHNvbWVvbmUgZWxzZVxuICAgKiBtYWRlIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgb3Blbi5cbiAgICovXG4gIHByaXZhdGUgc2lkZVRleHQoZDogRG9jUmVjb3JkLCBzaWRlOiBEaWZmU2lkZSk6IHN0cmluZyB7XG4gICAgaWYgKHNpZGUgPT09IFwib3JpZ2luYWxcIikgcmV0dXJuIHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgc2lkZSk7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIHNpZGUpLCBcInV0ZjhcIik7XG4gIH1cblxuICAvKiogQ29tcGFyZSB0aGUgQUNUSVZFIHZlcnNpb24gKGxlZnQpIGFnYWluc3QgYW5vdGhlciBzaWRlIChyaWdodCkuICovXG4gIGNvbXBhcmUob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlIH0pOiBEaWZmUGF5bG9hZCB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGlmIChvcHRzLmFnYWluc3QgPT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke2QuYWN0aXZlfSBpcyB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9IOKAlCBjb21wYXJpbmcgaXQgd2l0aCBpdHNlbGYgc2F5cyBub3RoaW5nYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBsZWZ0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCxcbiAgICAgIGRpZmY6IGRpZmZUZXh0KGxlZnQsIHRoaXMuc2lkZVRleHQoZCwgb3B0cy5hZ2FpbnN0KSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIG5hbWVkIGh1bmtzIGZyb20gYGFnYWluc3RgIGludG8gdGhlIGFjdGl2ZSB2ZXJzaW9uLlxuICAgKlxuICAgKiDim5QgVEhFIFdSSVRFIEdPRVMgVEhST1VHSCBgZWRpdGAsIHdoaWNoIGlzIHdoYXQgbWFrZXMgYSBtZXJnZSBvYmV5IGV2ZXJ5XG4gICAqIHJ1bGUgYW4gb3JkaW5hcnkga2V5c3Ryb2tlIG9iZXlzOiBpdCBsYW5kcyBvbiB0aGUgYWN0aXZlIHZlcnNpb24gYW5kIG5ldmVyXG4gICAqIHRoZSBvcmlnaW5hbCAoRTcpLCBhbmQgY2hlY2stYmVmb3JlLXdyaXRlIHByZXNlcnZlcyBhbiBvdXRzaWRlIHdyaXRlIGFzIGFcbiAgICogbmV3IHZlcnNpb24gZmlyc3QgKEUyKS4gQSBtZXJnZSB3cml0aW5nIHRoZSBmaWxlIGRpcmVjdGx5IHdvdWxkIGJlIHRoZSBvbmVcbiAgICogcGF0aCBpbnRvIHRoZSBkb2N1bWVudCB0aGF0IGNvdWxkIHNpbGVudGx5IGNsb2JiZXIgdGhlIGFnZW50LlxuICAgKi9cbiAgbWVyZ2Uob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlOyBodW5rczogbnVtYmVyW10gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogbnVtYmVyO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBhcHBsaWVkOiBudW1iZXI7XG4gICAgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbDtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBheWxvYWQgPSB0aGlzLmNvbXBhcmUoeyBkb2M6IGQuc2x1ZywgYWdhaW5zdDogb3B0cy5hZ2FpbnN0IH0pO1xuICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwYXlsb2FkLmRpZmYuaHVua3MubWFwKChoKSA9PiBoLmlkKSk7XG4gICAgY29uc3QgbWlzc2luZyA9IG9wdHMuaHVua3MuZmlsdGVyKChpZCkgPT4gIWtub3duLmhhcyhpZCkpO1xuICAgIGlmIChtaXNzaW5nLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIGh1bmsgJHttaXNzaW5nLmpvaW4oXCIsIFwiKX0gYWdhaW5zdCAke3NpZGVOYW1lKG9wdHMuYWdhaW5zdCwgZC5uYW1lKX0g4oCUIGAgK1xuICAgICAgICAgIGBpdCBoYXMgJHtrbm93bi5zaXplID09PSAwID8gXCJub25lXCIgOiBgMS4uJHtNYXRoLm1heCguLi5rbm93bil9YH0uIFJ1biBkaWZmIGFnYWluOiBgICtcbiAgICAgICAgICBgdGhlIHRleHQgY2hhbmdlZCB1bmRlciB0aGUgbnVtYmVycy5gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHRleHQgPSBhcHBseUh1bmtzKGJlZm9yZSwgcGF5bG9hZC5kaWZmLmh1bmtzLCBvcHRzLmh1bmtzKTtcbiAgICBjb25zdCB7IHByZXNlcnZlZCB9ID0gdGhpcy5lZGl0KGQuc2x1ZywgZC5hY3RpdmUsIHRleHQpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIHRleHQsXG4gICAgICBhcHBsaWVkOiBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+IGtub3duLmhhcyhpZCkpLmxlbmd0aCxcbiAgICAgIHByZXNlcnZlZCxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIG5vdGVzIChFNDUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBUaGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IGV2ZXJ5IG5vdGUgaXMgYW5jaG9yZWQgYWdhaW5zdC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVUZXh0KGQ6IERvY1JlY29yZCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIFBsYWNlIGV2ZXJ5IG5vdGUgaW4gdGhlIGFjdGl2ZSB0ZXh0IGFzIGl0IHN0YW5kcyBub3cuICovXG4gIHByaXZhdGUgcGxhY2VkTm90ZXMoZDogRG9jUmVjb3JkKTogUGxhY2VkTm90ZVtdIHtcbiAgICBjb25zdCBub3RlcyA9IGQubm90ZXMgPz8gW107XG4gICAgaWYgKG5vdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmFjdGl2ZVRleHQoZCk7XG4gICAgcmV0dXJuIG5vdGVzLm1hcCgobikgPT4gKHsgLi4ubiwgLi4uZmluZEFuY2hvcih0ZXh0LCBuKSB9KSk7XG4gIH1cblxuICAvKipcbiAgICogTm90ZSBhIHJhbmdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgKHRoZSBodW1hbiBzZWxlY3RzKSBvciBhIHF1b3RlXG4gICAqIGZvdW5kIGluIGl0ICh0aGUgYWdlbnQgcXVvdGVzIOKAlCBpdCBoYXMgbm8gb2Zmc2V0cykuXG4gICAqL1xuICBhZGROb3RlKG9wdHM6IHtcbiAgICBkb2M/OiBzdHJpbmc7XG4gICAgYm9keTogc3RyaW5nO1xuICAgIHdobzogVmVyc2lvbkF1dGhvcjtcbiAgICByYW5nZT86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07XG4gICAgcXVvdGU/OiBzdHJpbmc7XG4gIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZTsgaG93OiBcInNlbGVjdGlvblwiIHwgXCJxdW90ZVwiIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBib2R5ID0gb3B0cy5ib2R5LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIG5vdGUgbmVlZHMgc29tZXRoaW5nIHdyaXR0ZW4gaW4gaXRcIiwgNDAwKTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuXG4gICAgbGV0IGFuY2hvcjogQW5jaG9yO1xuICAgIGlmIChvcHRzLnJhbmdlKSB7XG4gICAgICBjb25zdCB7IGZyb20sIHRvIH0gPSBvcHRzLnJhbmdlO1xuICAgICAgaWYgKGZyb20gPCAwIHx8IHRvID4gdGV4dC5sZW5ndGggfHwgZnJvbSA+PSB0bylcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgJHtmcm9tfS4uJHt0b30gaXMgbm90IGEgcmFuZ2UgaW4gdiR7ZC5hY3RpdmV9IG9mICR7ZC5zbHVnfSAoJHt0ZXh0Lmxlbmd0aH0gY2hhcmFjdGVycylgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGZyb20sIHRvKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcXVvdGUgPSBvcHRzLnF1b3RlID8/IFwiXCI7XG4gICAgICBpZiAoIXF1b3RlKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIGEgc2VsZWN0aW9uIG9yIGEgcXVvdGVcIiwgNDAwKTtcbiAgICAgIGNvbnN0IGF0ID0gdGV4dC5pbmRleE9mKHF1b3RlKTtcbiAgICAgIC8vIOKblCBSRUZVU0VELCBub3QgYW5jaG9yZWQgaG9wZWZ1bGx5LiBBIHF1b3RlIHRoZSBhY3RpdmUgdmVyc2lvbiBkb2VzIG5vdFxuICAgICAgLy8gY29udGFpbiB3b3VsZCBiZWNvbWUgYW4gb3JwaGFuIHRoZSBtb21lbnQgaXQgd2FzIG1hZGUsIHdoaWNoIHJlYWRzIGFzXG4gICAgICAvLyBcInRoZSB0ZXh0IGNoYW5nZWRcIiB3aGVuIHRoZSB0cnV0aCBpcyBcInlvdSBxdW90ZWQgc29tZXRoaW5nIGVsc2VcIi5cbiAgICAgIGlmIChhdCA9PT0gLTEpXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gZG9lcyBub3QgY29udGFpbiB0aGF0IHRleHQg4oCUIHF1b3RlIGl0IGV4YWN0bHkgYXMgaXQgYXBwZWFyc2AsXG4gICAgICAgICAgNDA0LFxuICAgICAgICApO1xuICAgICAgYW5jaG9yID0gYW5jaG9yT2YodGV4dCwgYXQsIGF0ICsgcXVvdGUubGVuZ3RoKTtcbiAgICB9XG5cbiAgICBjb25zdCBub3RlOiBOb3RlID0ge1xuICAgICAgaWQ6IGBuJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDYpfWAsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIC4uLmFuY2hvcixcbiAgICAgIGJvZHksXG4gICAgICB3aG86IG9wdHMud2hvLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgcmVzb2x2ZWQ6IGZhbHNlLFxuICAgIH07XG4gICAgZC5ub3RlcyA9IFsuLi4oZC5ub3RlcyA/PyBbXSksIG5vdGVdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSwgaG93OiBvcHRzLnJhbmdlID8gXCJzZWxlY3Rpb25cIiA6IFwicXVvdGVcIiB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRvY3VtZW50J3Mgbm90ZXMgYXMgU1RPUkVEIOKAlCBubyBwbGFjZW1lbnQsIHNvIG5vIGZpbGUgcmVhZHMuIEU2NSdzXG4gICAqIGF0dGVudGlvbiB0aWNrIGFza3MgdGhpcyBldmVyeSBzZWNvbmQ7IGB2aWV3KClgIHdvdWxkIHJlLXBsYWNlIGV2ZXJ5IG5vdGUuXG4gICAqL1xuICBub3RlRmFjdHMoKTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiByZWFkb25seSBOb3RlW10gfVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmRvY3MubWFwKChkKSA9PiAoeyBzbHVnOiBkLnNsdWcsIG5vdGVzOiBkLm5vdGVzID8/IFtdIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgbGluZXMgYSBub3RlIGNvdmVycyBpbiB0aGUgYWN0aXZlIHZlcnNpb24gbm93IChFNjUpLCBvciBudWxsIHdoZW4gaXRzXG4gICAqIHRleHQgaXMgZ29uZS4gUGxhY2VkLCBub3QgcmVtZW1iZXJlZCwgZm9yIHRoZSByZWFzb24gbm90ZXMgYXJlIChFNDUpLlxuICAgKi9cbiAgbm90ZUxpbmVzKGRvYzogc3RyaW5nLCBub3RlOiBOb3RlKTogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfSB8IG51bGwge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKGRvYyk7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcbiAgICBjb25zdCBhdCA9IGZpbmRBbmNob3IodGV4dCwgbm90ZSk7XG4gICAgcmV0dXJuIGF0LmZyb20gPT09IG51bGwgPyBudWxsIDogbGluZXNPZih0ZXh0LCBhdC5mcm9tLCBhdC50byk7XG4gIH1cblxuICAvKiogTm90ZXMgb24gYSBkb2N1bWVudCwgcGxhY2VkIOKAlCBgYWxsYCBpbmNsdWRlcyB0aGUgcmVzb2x2ZWQgb25lcy4gKi9cbiAgbm90ZXNPZihvcHRzOiB7IGRvYz86IHN0cmluZzsgYWxsPzogYm9vbGVhbiB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiBQbGFjZWROb3RlW10gfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBsYWNlZCA9IHRoaXMucGxhY2VkTm90ZXMoZCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3Rlczogb3B0cy5hbGwgPyBwbGFjZWQgOiBwbGFjZWQuZmlsdGVyKChuKSA9PiAhbi5yZXNvbHZlZCkgfTtcbiAgfVxuXG4gIHByaXZhdGUgbm90ZU9yRGllKGQ6IERvY1JlY29yZCwgaWQ6IHN0cmluZyk6IE5vdGUge1xuICAgIGNvbnN0IG5vdGUgPSAoZC5ub3RlcyA/PyBbXSkuZmluZCgobikgPT4gbi5pZCA9PT0gaWQpO1xuICAgIGlmICghbm90ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIG5vdGUgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIChkLm5vdGVzID8/IFtdKS5tYXAoKG4pID0+IG4uaWQpLFxuICAgICAgKTtcbiAgICByZXR1cm4gbm90ZTtcbiAgfVxuXG4gIC8qKiBDaGFuZ2Ugd2hhdCBhIG5vdGUgU0FZUy4gSXRzIGFuY2hvciBpcyB1bnRvdWNoZWQg4oCUIGl0IGlzIHN0aWxsIGFib3V0IHRoZVxuICAgKiAgc2FtZSBwYXNzYWdlLCB3aGljaCBpcyB3aHkgZWRpdGluZyBkb2VzIG5vdCByZS1xdW90ZSAoRTQ2KS4gKi9cbiAgZWRpdE5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmc7IGJvZHk6IHN0cmluZzsgd2hvOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIG5vdGU6IE5vdGU7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgbm90ZS5ib2R5ID0gYm9keTtcbiAgICBub3RlLmVkaXRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAvLyBFNjU6IHdob3NlIHJld3JpdGUgaXQgd2FzIGRlY2lkZXMgd2hldGhlciB0aGUgbm90ZSBpcyBvd2VkIGFuIGFuc3dlci5cbiAgICBub3RlLmVkaXRlZEJ5ID0gb3B0cy53aG87XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZXNvbHZlTm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgcmVzb2x2ZWQ6IGJvb2xlYW47IHdobzogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBub3RlOiBOb3RlO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIC8vIEU2NTogYSBSRU9QRU4gaXMgYSB3cml0ZSDigJQgYSBodW1hbiByZW9wZW5pbmcgYXNrcyBhZ2FpbiwgYW5kIHRoZSB3YWl0IGlzXG4gICAgLy8gdGltZWQgZnJvbSBoZXJlOyB0aGUgYWdlbnQgcmVvcGVuaW5nIGlzIGFuIGFjdCBvbiB0aGUgbm90ZS5cbiAgICBpZiAobm90ZS5yZXNvbHZlZCAmJiAhb3B0cy5yZXNvbHZlZCkge1xuICAgICAgbm90ZS5yZW9wZW5lZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIG5vdGUucmVvcGVuZWRCeSA9IG9wdHMud2hvO1xuICAgIH1cbiAgICBub3RlLnJlc29sdmVkID0gb3B0cy5yZXNvbHZlZDtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIHJlbW92ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmcgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgZC5ub3RlcyA9IChkLm5vdGVzID8/IFtdKS5maWx0ZXIoKG4pID0+IG4uaWQgIT09IG9wdHMuaWQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgLyoqIFNhdmU6IHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgb3ZlciB0aGUgb3JpZ2luYWwuIFRoZSBPTkxZIHdyaXRlIHRvIGl0IChFNykuICovXG4gIHNhdmUoc2x1Zzogc3RyaW5nKTogeyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYzogU2F2ZSB3cml0ZXMgb25seSBhbiBvcmlnaW5hbCBhZG1pdHRlZCBieVxuICAgIC8vIGBvcGVuUGF0aGAgKGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5KS4gQ2hlY2tlZCBhZ2FpbiBoZXJlXG4gICAgLy8gc28gbm8gb3RoZXIgcGF0aCBpbnRvIHRoZSBtYW5pZmVzdCDigJQgYSBoYW5kLWVkaXRlZCBvbmUsIGEgZnV0dXJlIHZlcmIg4oCUXG4gICAgLy8gY2FuIHR1cm4gU2F2ZSBpbnRvIFwid3JpdGUgYW55IGZpbGVcIi5cbiAgICBpZiAoIWQuYWRtaXR0ZWQgfHwgIWlzRG9jTmFtZShkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBzYXZlICR7ZC5vcmlnaW5hbH06IGl0IHdhcyBub3Qgb3BlbmVkIGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICB0aGlzLndyaXRlT3duZWQoZC5vcmlnaW5hbCwgdGV4dCk7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgb3JpZ2luYWw6IGQub3JpZ2luYWwsIHZlcnNpb246IGQuYWN0aXZlIH07XG4gIH1cblxuICAvKiogUmV2ZXJ0OiB0aGUgb3JpZ2luYWwncyB0ZXh0IGJhY2sgb3ZlciB0aGUgYWN0aXZlIHZlcnNpb24uICovXG4gIHJldmVydChzbHVnOiBzdHJpbmcpOiB7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIGlmIChuID09PSBkLmFjdGl2ZSkge1xuICAgICAgICAvLyBFMiwgcmVmdXNlZCBhbmQgUkUtTEFCRUxMRUQ6IHRoZSBvdXRzaWRlIHRleHQgYmVjb21lcyBhIG5ldyBhZ2VudFxuICAgICAgICAvLyB2ZXJzaW9uLCBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uIGdvZXMgYmFjayB0byB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICAgICAgLy8gdGV4dCDigJQgc28gdGhlIGFjdGl2ZSB2ZXJzaW9uIG9ubHkgZXZlciBob2xkcyB3aGF0IHRoZSBodW1hbiB0eXBlZCxcbiAgICAgICAgLy8gYW5kIG5vdGhpbmcgYW55b25lIHdyb3RlIGlzIGxvc3QgKHZlcmlmeS1wYXNzIGZpeCA0LCB3YXRjaGVyIGhhbGYpLlxuICAgICAgICBjb25zdCBrZXB0ID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGhpcy5sYXN0QWN0aXZlVGV4dC5nZXQoZC5zbHVnKSA/PyB0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogbixcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgcHJlc2VydmVkQXM6IGtlcHQubixcbiAgICAgICAgICBwcmVzZXJ2ZWRQYXRoOiBrZXB0LnBhdGgsXG4gICAgICAgICAgYWN0aXZhdGVkQmVmb3JlV3JpdHRlbjoga2VwdC5hY3RpdmF0ZWRCZWZvcmVXcml0dGVuLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICB0aGlzLnVud3JpdHRlbkNvcGllcy5kZWxldGUoYWJzKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCB0ZXh0LCBhY3RpdmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIOKAlCBieSBpdHMgc3RvcmVkIHBhdGgsIG9yIGJ5IHJlYWxwYXRoIGZvciBhIHN5bWxpbms/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyB8fCByZWFsT3IoeC5vcmlnaW5hbCkgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGQub3V0c2lkZUNoYW5nZWQpIHJldHVybiBudWxsOyAvLyBhbHJlYWR5IGFza2VkXG4gICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBzdHJ1Y3R1cmUgKEUyMuKAk0UyNCk6IHJlYWwgY2hhbmdlcyBvbiBkaXNrLCBvbmUgcGF0aCBmb3IgYm90aCBwYXJ0aWVzIOKUgOKUgFxuICAvL1xuICAvLyBFdmVyeSBtZXRob2QgYmVsb3cgZG9lcyB0aGUgY2hhbmdlIE9OIERJU0sgYW5kIHRoZW4gYnJpbmdzIHRoZSBjb250ZXh0XG4gIC8vIG1vZGVsIGJhY2sgaW4gbGluZSB3aXRoIGl0LiBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZW0gdGhyb3VnaCBtZW51cyBhbmRcbiAgLy8gZHJhZyBhbmQgZHJvcCwgdGhlIGFnZW50IHRocm91Z2ggQ0xJIHZlcmJzOyB0aGUgZGFlbW9uIGFubm91bmNlcyBlYWNoIG9uZVxuICAvLyB1bmRlciB0aGUgbmFtZSBvZiB3aG9ldmVyIGRpZCBpdC4gVHdvIHJ1bGVzIGhvbGQgdGhyb3VnaG91dDpcbiAgLy9cbiAgLy8gLSBOT1RISU5HIElTIERFTEVURUQuIGBoaWRlYCB0YWtlcyBhIG5vZGUgb3V0IG9mIFNjcmlwdG9yaXVtOyB0aGUgZmlsZSBzdGF5cy5cbiAgLy8gLSBOT1RISU5HIElTIE9WRVJXUklUVEVOLiBBIGRlc3RpbmF0aW9uIHRoYXQgZXhpc3RzIGlzIHJlZnVzZWQgKGFuIGV4cGxpY2l0XG4gIC8vICAgbmFtZSkgb3IgZ2l2ZW4gYSBmcmVlIG5hbWUgKGEgZGVmYXVsdCBvbmUsIGEgZHJvcCk7IGZpbGVzIGFyZSBjcmVhdGVkXG4gIC8vICAgd2l0aCB0aGUgZXhjbHVzaXZlIGZsYWcsIHNvIGEgcmFjZSBjYW5ub3QgY2xvYmJlciBlaXRoZXIuXG5cbiAgLyoqIEUyMzogd2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQuICovXG4gIGdldCB3b3Jrc3BhY2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLndvcmtzcGFjZSA/PyBob21lZGlyKCk7XG4gIH1cblxuICBzZXRXb3Jrc3BhY2UocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzdWNoIGZvbGRlcjogJHthYnN9YCwgNDA0KTtcbiAgICB9XG4gICAgaWYgKCFpc0RpcikgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGhlIHdvcmtzcGFjZSBtdXN0IGJlIGEgZm9sZGVyOiAke2Fic31gLCA0MDApO1xuICAgIHRoaXMubS53b3Jrc3BhY2UgPSBhYnM7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogSG93IGEgcGF0aCByZWFkcyBpbiBhIGNoYXQgbGluZTogYHNldC9yZWxgIGluc2lkZSBhIHNldCwgYSBzaW5nbGVcbiAgICogZG9jdW1lbnQncyBmaWxlIG5hbWUsIGB3b3Jrc3BhY2Uv4oCmYCBpbiB0aGUgd29ya3NwYWNlLCBlbHNlIGB+L+KApmAuXG4gICAqL1xuICBkaXNwbGF5KGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikge1xuICAgICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBlLmxhYmVsO1xuICAgICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkgcmV0dXJuIGAke2UubGFiZWx9LyR7dG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpfWA7XG4gICAgICB9IGVsc2UgaWYgKGUubm9kZXMuc29tZSgobikgPT4gam9pbihlLnJvb3QsIG4ucmVsKSA9PT0gYWJzKSkgcmV0dXJuIGUubGFiZWw7XG4gICAgfVxuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLndvcmtzcGFjZSArIHNlcCkpXG4gICAgICByZXR1cm4gYHdvcmtzcGFjZS8ke3RvUG9zaXgocmVsYXRpdmUodGhpcy53b3Jrc3BhY2UsIGFicykpfWA7XG4gICAgY29uc3QgaG9tZSA9IGhvbWVkaXIoKTtcbiAgICByZXR1cm4gYWJzID09PSBob21lID8gXCJ+XCIgOiBhYnMuc3RhcnRzV2l0aChob21lICsgc2VwKSA/IGB+JHthYnMuc2xpY2UoaG9tZS5sZW5ndGgpfWAgOiBhYnM7XG4gIH1cblxuICAvKipcbiAgICogYGFic2Agc3BlbGxlZCB0aGUgd2F5IHRoZSBjb250ZXh0IHNwZWxscyBpdC4gQSBjYWxsZXIgd2hvc2UgY3dkIGlzIGFcbiAgICogcmVhbHBhdGggKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAqIHBsYWNlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIG5vZGUuXG4gICAqL1xuICBwcml2YXRlIHNwZWxsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5tLmNvbnRleHQuc29tZSgoZSkgPT4gYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmIChyZWFsID09PSByZWFsUm9vdCkgcmV0dXJuIGUucm9vdDtcbiAgICAgIGlmIChyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSByZXR1cm4gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBwcml2YXRlIGlzV29ya3NwYWNlKGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGFicyA9PT0gdGhpcy53b3Jrc3BhY2UgfHwgcmVhbE9yKGFicykgPT09IHJlYWxPcih0aGlzLndvcmtzcGFjZSk7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIGVudHJ5IHRoYXQgY292ZXJzIGBhYnNgIChpdHMgcm9vdCwgb3IgYW55dGhpbmcgdW5kZXIgaXQpLCBpZiBhbnkuICovXG4gIHByaXZhdGUgY292ZXJpbmdFbnRyeShhYnM6IHN0cmluZywgZXhjZXB0Pzogc3RyaW5nKTogQ29udGV4dEVudHJ5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLmlkICE9PSBleGNlcHQgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiZcbiAgICAgICAgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQSBmb2xkZXIgdGhpbmdzIG1heSBiZSBtYWRlIGluIG9yIG1vdmVkIGludG86IGEgbWlycm9yZWQgZW50cnkncyByb290LCBhXG4gICAqIHZpc2libGUgZm9sZGVyIHVuZGVyIG9uZSwgb3IgdGhlIHdvcmtzcGFjZS4gUmV0dXJucyB0aGUgYWJzb2x1dGUgZm9sZGVyO1xuICAgKiByZWZ1c2VzIGFueXRoaW5nIGVsc2Ug4oCUIHRoZSBjb250ZXh0IHN0YXlzIHRoZSB3YXkgaW4gKHZlcmlmeS1wYXNzIGZpeCAxYikuXG4gICAqL1xuICBwcml2YXRlIGRlc3RpbmF0aW9uT3JEaWUocmF3RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdEaXIpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgY29udGludWU7XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBhYnM7XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGU/LmtpbmQgPT09IFwiZ3JvdXBcIikgcmV0dXJuIGFicztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuaXNXb3Jrc3BhY2UoYWJzKSkgcmV0dXJuIHRoaXMud29ya3NwYWNlO1xuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICBgJHthYnN9IGlzIG5vdCBhIGZvbGRlciBpbiB0aGlzIHNlc3Npb24g4oCUIG5hbWUgYSBzZXQsIGEgZm9sZGVyIGluc2lkZSBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UgKCR7dGhpcy53b3Jrc3BhY2V9KWAsXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG9yIGZvbGRlciBzaG93biBpbiB0aGUgY29udGV4dCwgd2l0aCB3aGVyZSBpdCBpcyBzaG93bi4gKi9cbiAgcHJpdmF0ZSBpdGVtT3JEaWUocmF3UGF0aDogc3RyaW5nKToge1xuICAgIGFiczogc3RyaW5nO1xuICAgIGVudHJ5OiBDb250ZXh0RW50cnk7XG4gICAgLyoqIFRoZSB3aG9sZSBlbnRyeSAoYSBzZXQncyBvd24gZm9sZGVyLCBhIGxpc3RlZCBkb2N1bWVudCksIG9yIGEgbm9kZSBpbnNpZGUgYSBzZXQuICovXG4gICAgd2hvbGU6IGJvb2xlYW47XG4gICAgZGlyOiBib29sZWFuO1xuICB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAxICYmIG9ubHk/LmtpbmQgPT09IFwiZG9jXCIgJiYgam9pbihlLnJvb3QsIG9ubHkucmVsKSA9PT0gYWJzKVxuICAgICAgICAgIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IGZhbHNlIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiB0cnVlIH07XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGUpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiBmYWxzZSwgZGlyOiBub2RlLmtpbmQgPT09IFwiZ3JvdXBcIiB9O1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHRgLCA0MDQpO1xuICB9XG5cbiAgLyoqXG4gICAqIGByYXdQYXRoYCBpZiB0aGUgY29udGV4dCBzaG93cyBpdCDigJQgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gYSBzZXQsIGFcbiAgICogbGlzdGVkIGRvY3VtZW50LCBhIHNldCdzIG93biBmb2xkZXIg4oCUIG9yIGl0IGlzIHRoZSB3b3Jrc3BhY2U7IHJlZnVzZWRcbiAgICogb3RoZXJ3aXNlLiBGb3IgYWN0cyB0aGF0IHJlYWNoIG91dHNpZGUgdGhlIHNwZWxsIChyZXZlYWxpbmcgYSBwYXRoIGluIHRoZVxuICAgKiBmaWxlIG1hbmFnZXIpLCBzbyBhIHBhZ2UgY2Fubm90IGFpbSB0aGVtIGF0IGFuIGFyYml0cmFyeSBwYXRoLlxuICAgKi9cbiAgc2hvd25QYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBpZiAodGhpcy5pdGVtQXQoYWJzKSkgcmV0dXJuIGFicztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdGluYXRpb25PckRpZShhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb25gLCA0MDApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZWZ1c2UgYSBuYW1lIHRoYXQgaXMgbm90IG9uZSBwbGFpbiBmaWxlIG9yIGZvbGRlciBuYW1lLiAqL1xuICBwcml2YXRlIG5hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgICBpZiAoXG4gICAgICBuID09PSBcIlwiIHx8XG4gICAgICBuID09PSBcIi5cIiB8fFxuICAgICAgbiA9PT0gXCIuLlwiIHx8XG4gICAgICBuLnN0YXJ0c1dpdGgoXCIuXCIpIHx8XG4gICAgICAvWy9cXFxcXFwwXS8udGVzdChuKSB8fFxuICAgICAgbi5sZW5ndGggPiAyNTVcbiAgICApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgXCIke25hbWV9XCIgaXMgbm90IGEgdXNhYmxlIG5hbWUg4oCUIG9uZSBwbGFpbiBuYW1lLCBubyBzbGFzaGVzLCBub3Qgc3RhcnRpbmcgd2l0aCBhIGRvdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBuYW1lOiBhIG5hbWUgd2l0aG91dCBhIGRvY3VtZW50IGV4dGVuc2lvbiBnZXRzIGAubWRgLiAqL1xuICBwcml2YXRlIGRvY05hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICByZXR1cm4gaXNEb2NOYW1lKG4pID8gbiA6IGAke259Lm1kYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciBzb21ldGhpbmcgbW92ZWQgb24gZGlzayBmcm9tIGBmcm9tYCB0byBgdG9gLCBicmluZyB0aGUgbW9kZWwgd2l0aCBpdDpcbiAgICogb3BlbmVkIGRvY3VtZW50cyBrZWVwIHRoZWlyIHZlcnNpb25zIHVuZGVyIHRoZSBuZXcgcGF0aCwgZW50cmllcyByb290ZWQgYXRcbiAgICogb3IgaG9sZGluZyB0aGUgbW92ZWQgdGhpbmcgZm9sbG93IGl0LCBhbmQgZXZlcnkgbWlycm9yIGlzIHJlLXJlYWQuIEFuIGVudHJ5XG4gICAqIHRoYXQgbm93IHNpdHMgaW5zaWRlIGFub3RoZXIgc2V0IGlzIGRyb3BwZWQg4oCUIHRoZSBzZXQgc2hvd3MgaXQgYWxyZWFkeS5cbiAgICovXG4gIHByaXZhdGUgZm9sbG93TW92ZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBtb3ZlZCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+XG4gICAgICBwID09PSBmcm9tID8gdG8gOiBwLnN0YXJ0c1dpdGgoZnJvbSArIHNlcCkgPyB0byArIHAuc2xpY2UoZnJvbS5sZW5ndGgpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGQub3JpZ2luYWwpO1xuICAgICAgaWYgKG5vdykge1xuICAgICAgICBkLm9yaWdpbmFsID0gbm93O1xuICAgICAgICBkLm5hbWUgPSBiYXNlbmFtZShub3cpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBkcm9wID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAob25seT8ua2luZCAhPT0gXCJkb2NcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGpvaW4oZS5yb290LCBvbmx5LnJlbCkpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IGRpcm5hbWUobm93KTtcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KTtcbiAgICAgICAgICBlLm5vZGVzID0gW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShub3cpIH1dO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChlLnJvb3QpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IG5vdztcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KSB8fCBub3c7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5tLmNvbnRleHQgPSB0aGlzLm0uY29udGV4dC5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQWZ0ZXIgYSBmaWxlIG9yIGZvbGRlciBsYW5kZWQgYXQgYGFic2A6IHJlLXJlYWQgdGhlIHNldCBpdCBpcyBpbiwgb3IgZ2l2ZSBpdCBhbiBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBhZG9wdE5ldyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHNldCA9IHRoaXMuY292ZXJpbmdFbnRyeShhYnMpO1xuICAgIGlmIChzZXQpIHRoaXMucmVzY2FuKHNldC5pZCk7XG4gICAgZWxzZSB0aGlzLm0uY29udGV4dC5wdXNoKGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBIG5hbWUgaW4gYGRpcmAgdGhhdCBpcyBmcmVlOiBgbmFtZWAsIGVsc2UgYHN0ZW0gMi5leHRgLCBgc3RlbSAzLmV4dGAsIOKApiAqL1xuICBwcml2YXRlIGZyZWVOYW1lKGRpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGlzRGlyOiBib29sZWFuKTogc3RyaW5nIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG5hbWUpKSkgcmV0dXJuIG5hbWU7XG4gICAgY29uc3QgZXh0ID0gaXNEaXIgPyBcIlwiIDogZXh0bmFtZShuYW1lKTtcbiAgICBjb25zdCBzdGVtID0gZXh0ID8gbmFtZS5zbGljZSgwLCAtZXh0Lmxlbmd0aCkgOiBuYW1lO1xuICAgIGZvciAobGV0IGkgPSAyOyA7IGkrKykge1xuICAgICAgY29uc3QgbiA9IGAke3N0ZW19ICR7aX0ke2V4dH1gO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuKSkpIHJldHVybiBuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVmdXNlRXhpc3RpbmcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZXhpc3RzU3luYyhhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGFscmVhZHkgZXhpc3RzIOKAlCBub3RoaW5nIHdhcyBvdmVyd3JpdHRlbmAsIDQwOSk7XG4gIH1cblxuICBjcmVhdGVEb2MocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmaWxlID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIlVudGl0bGVkLm1kXCIsIGZhbHNlKSA6IHRoaXMuZG9jTmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmaWxlKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIFwiXCIsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIGNyZWF0ZUZvbGRlcihyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZvbGRlciA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJOZXcgZm9sZGVyXCIsIHRydWUpIDogdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZvbGRlcik7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIG1rZGlyU3luYyhhYnMpO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjY6IHdoYXQgYSBtb3ZlIFdPVUxEIGRvLCBmb3IgdGhlIGNvbmZpcm1hdGlvbiB0aGUgc3VyZmFjZSBzaG93cyBiZWZvcmVcbiAgICogbW92aW5nIGEgRk9MREVSLiBSZWFkcyBub3RoaW5nIGJ1dCB0aGUgZGlzayBhbmQgcmVmdXNlcyBleGFjdGx5IHdoYXRcbiAgICogYG1vdmVgIHdvdWxkIHJlZnVzZSwgc28gYSBjb25maXJtZWQgbW92ZSBjYW5ub3QgdGhlbiBmYWlsIG9uIGFkbWlzc2lvbi5cbiAgICpcbiAgICogVGhlIGdpdCBoYWxmIGlzIGhlcmUgYmVjYXVzZSBvbmx5IHRoZSBkYWVtb24gY2FuIHNlZSBhIGAuZ2l0YDogYSBmb2xkZXJcbiAgICogZHJhZ2dlZCBvdXQgb2YgYSByZXBvc2l0b3J5IGlzIHRoZSBjYXNlIHdoZXJlIHRoZSBjb25zZXF1ZW5jZSByZWFjaGVzIHBhc3RcbiAgICogc2NyaXB0b3JpdW0gKENvbGUgbW92ZWQgdGhpcyBwcm9qZWN0J3Mgb3duIGRvY3MgZm9sZGVyIGludG8gaGlzIHdvcmtzcGFjZSxcbiAgICogYW5kIGdpdCBzYXcgc2l4IGRlbGV0ZWQgZmlsZXMpLlxuICAgKi9cbiAgbW92ZVBsYW4ocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiBNb3ZlUGxhbiB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgY29uc3QgZnJvbVJlcG8gPSBnaXRSb290T2YoZGlybmFtZShpdGVtLmFicykpO1xuICAgIGNvbnN0IGludG9SZXBvID0gZ2l0Um9vdE9mKGludG8pO1xuICAgIHJldHVybiB7XG4gICAgICBmcm9tOiBpdGVtLmFicyxcbiAgICAgIGludG8sXG4gICAgICBuYW1lOiBiYXNlbmFtZShpdGVtLmFicyksXG4gICAgICBmb2xkZXI6IGl0ZW0uZGlyLFxuICAgICAgZG9jczogaXRlbS5kaXIgPyBjb3VudERvY3MoaXRlbS5hYnMpIDogMSxcbiAgICAgIHJlcG86IGZyb21SZXBvID8gYmFzZW5hbWUoZnJvbVJlcG8pIDogbnVsbCxcbiAgICAgIGxlYXZlc1JlcG86IGZyb21SZXBvICE9PSBudWxsICYmIGZyb21SZXBvICE9PSBpbnRvUmVwbyxcbiAgICB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICAvKipcbiAgICogVGhlIGhpZGRlbiBsaXN0IG9mIHRoZSBlbnRyeSBhIHBhdGggYmVsb25ncyB0bywgQkVGT1JFIGFueXRoaW5nIGNoYW5nZXMgaXRcbiAgICog4oCUIHdoYXQgRTYwIHJlY29yZHMgc28gYSBoaWRlIGNhbiBiZSBwdXQgYmFjayBleGFjdGx5LlxuICAgKi9cbiAgaGlkZGVuQmVmb3JlKHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfSB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgICByZXR1cm4geyBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVsczogWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvKiogVGhlIHNhbWUsIGFkZHJlc3NlZCBieSBlbnRyeSDigJQgd2hhdCBgdW5oaWRlYCBuZWVkcyByZWNvcmRlZC4gKi9cbiAgaGlkZGVuT2ZFbnRyeShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgcmV0dXJuIGUgPyB7IGVudHJ5OiBlLmlkLCByZWxzOiBbLi4uKGUuaGlkZGVuID8/IFtdKV0gfSA6IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSBgcmVsc2AgKEU2MCdzIGludmVyc2Ugb2YgYm90aCBoaWRlXG4gICAqIGFuZCB1bmhpZGUpLiBSZXR1cm5zIHdoYXQgaXQgV0FTLCBzbyB0aGUgY2FsbGVyIGNhbiBidWlsZCB0aGUgb3Bwb3NpdGUgYWN0XG4gICAqIHdpdGhvdXQgcmVhZGluZyBzdGF0ZSBpdCBoYXMgYWxyZWFkeSBjaGFuZ2VkLlxuICAgKi9cbiAgcmVzdG9yZUhpZGRlbihlbnRyeUlkOiBzdHJpbmcsIHJlbHM6IHN0cmluZ1tdKTogeyBlbnRyeTogc3RyaW5nOyB3YXM6IHN0cmluZ1tdIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCB3YXMgPSBbLi4uKGUuaGlkZGVuID8/IFtdKV07XG4gICAgaWYgKHJlbHMubGVuZ3RoID09PSAwKSBkZWxldGUgZS5oaWRkZW47XG4gICAgZWxzZSBlLmhpZGRlbiA9IFsuLi5yZWxzXTtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgd2FzIH07XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlIHNvbWV0aGluZyB0aGlzIHNlc3Npb24gY3JlYXRlZCAoRTYwJ3MgdW5kbyBvZiBhIGNyZWF0aW9uKS5cbiAgICpcbiAgICog4puUIEEgTk9OLUVNUFRZIERJUkVDVE9SWSBJUyBSRUZVU0VELCBhbmQgbm8gZGlhbG9nIGNhbiBhdXRob3Jpc2UgaXQuIFVuZG9cbiAgICogd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdCByZWFjaGVzIHRoYXQgZm9sZGVyJ3NcbiAgICogY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzIHRoZW4gc29tZXRoaW5nIHB1dCB0aGVtIHRoZXJlXG4gICAqIHRoYXQgdGhlIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGEgZGlyZWN0b3J5IFRSRUUgaXMgYVxuICAgKiBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0IG1hZGUuIChDb2xlIHJ1bGVkIHRoZVxuICAgKiBmaWxlIGNhc2UgdGhlIG90aGVyIHdheSDigJQgY29uZmlybWVkLCBub3QgcmVmdXNlZCDigJQgYW5kIHRoaXMgbGltaXQgaXMgdGhlXG4gICAqIGNhcnZlLW91dCBoZSBhY2NlcHRlZC4pXG4gICAqXG4gICAqIOKaoCBJdCBhbHNvIHJlZnVzZXMgYW55dGhpbmcgdGhhdCBpcyBub3Qgd2hlcmUgdGhlIGhpc3Rvcnkgc2FpZCBpdCB3YXM6IGFcbiAgICogcGF0aCB0aGF0IGhhcyBiZWNvbWUgYSBkaXJlY3RvcnksIG9yIGEgZGlyZWN0b3J5IHRoYXQgaGFzIGJlY29tZSBhIGZpbGUsXG4gICAqIG1lYW5zIHRoZSB3b3JsZCBtb3ZlZCBhbmQgdGhlIHJlY29yZGVkIGludmVyc2Ugbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdC5cbiAgICovXG4gIHJlbW92ZUNyZWF0ZWQocmF3UGF0aDogc3RyaW5nLCBkaXI6IGJvb2xlYW4pOiB7IHBhdGg6IHN0cmluZzsgcmVtb3ZlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbHJlYWR5IGdvbmU6IHRoZSB1bmRvIGhhcyBub3RoaW5nIHRvIGRvLCB3aGljaCBpcyBub3QgYW4gZXJyb3IuXG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIHJlbW92ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpICE9PSBkaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoYWJzKX0gaXMgJHtzdC5pc0RpcmVjdG9yeSgpID8gXCJhIGZvbGRlclwiIDogXCJhIGZpbGVcIn0gbm93IOKAlCB0aGUgY2hhbmdlIHRoaXMgd291bGQgdW5kbyBubyBsb25nZXIgZGVzY3JpYmVzIGl0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBpZiAoZGlyKSB7XG4gICAgICBjb25zdCBsZWZ0ID0gcmVhZGRpclN5bmMoYWJzKTtcbiAgICAgIGlmIChsZWZ0Lmxlbmd0aCA+IDApXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzIG5vdCBlbXB0eSAoJHtsZWZ0Lmxlbmd0aH0gaXRlbSR7bGVmdC5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9KSDigJQgbW92ZSB3aGF0IGlzIGluc2lkZSBpdCBvdXQgZmlyc3RgLFxuICAgICAgICAgIDQwOSxcbiAgICAgICAgICBsZWZ0LnNsaWNlKDAsIDEwKSxcbiAgICAgICAgKTtcbiAgICAgIHJtZGlyU3luYyhhYnMpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1bmxpbmtTeW5jKGFicyk7XG4gICAgfVxuICAgIHRoaXMuZm9yZ2V0UGF0aChhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgcmVtb3ZlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5dGhpbmcgd29ydGggbG9va2luZyBhdCBpbiB0aGlzIHNlc3Npb24sIHdpdGggdGhlIHZlcmIgZm9yIGVhY2ggKEU2MikuXG4gICAqXG4gICAqIOKblCBJVCBPTkxZIExPT0tTLiBSZXBhaXJpbmcgd291bGQgbWVhbiBkZWNpZGluZyBmb3IgdGhlIGh1bWFuIHRoYXQgYSBnaG9zdFxuICAgKiBlbnRyeSBpcyBub3Qgd2FudGVkIGJhY2sgYW5kIHRoYXQgdmVyc2lvbnMgaGVsZCBmb3IgYSB2YW5pc2hlZCBmaWxlIGFyZSBub3RcbiAgICogd29ydGggc2F2aW5nIOKAlCBib3RoIG9mIHdoaWNoIGFyZSB0aGVpcnMgdG8gZGVjaWRlIChDb2xlOiBcInJlcG9ydCwgbmFtZSB0aGVcbiAgICogdmVyYiwgbGV0IHlvdSBkZWNpZGVcIikuXG4gICAqXG4gICAqIOKaoCBgZXhpc3RzU3luY2AgcGVyIGRvY3VtZW50IGFuZCBwZXIgbm9kZSwgd2hpY2ggaXMgdGhlIG9uZSBjb3N0IGhlcmUuIEl0IGlzXG4gICAqIGJvdW5kZWQgYnkgdGhlIGNvbnRleHQgdGhlIGh1bWFuIGNob3NlIGFuZCBydW5zIG9uIGRlbWFuZCBwbHVzIG9uY2UgYXRcbiAgICogc3RhcnR1cCwgbm90IG9uIGEgdGltZXIuXG4gICAqL1xuICBjaGVja3VwKCk6IEZpbmRpbmdbXSB7XG4gICAgY29uc3Qgbm9kZXM6IHsgZW50cnk6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBzaG93bjogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfVtdID0gW107XG4gICAgY29uc3QgbGlua3M6IHsgZW50cnk6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGFuZ2xpbmc6IG51bWJlciB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgbm9kZXMucHVzaCh7IGVudHJ5OiBlLmlkLCBwYXRoOiBwLCBzaG93bjogdGhpcy5kaXNwbGF5KHApLCBleGlzdHM6IGV4aXN0c1N5bmMocCkgfSk7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZS5pZCk7XG4gICAgICAgIGlmIChnLmRhbmdsaW5nID4gMClcbiAgICAgICAgICBsaW5rcy5wdXNoKHsgZW50cnk6IGUuaWQsIGxhYmVsOiBlLmxhYmVsID8/IGJhc2VuYW1lKGUucm9vdCksIGRhbmdsaW5nOiBnLmRhbmdsaW5nIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEEgc2V0IHRoYXQgY2Fubm90IGJlIG1hcHBlZCBpcyBub3QgYSBmaW5kaW5nIGFib3V0IGxpbmtzLlxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmluZGluZ3Moe1xuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiAoe1xuICAgICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICAgIGV4aXN0czogZXhpc3RzU3luYyhkLm9yaWdpbmFsKSxcbiAgICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgICAgfSkpLFxuICAgICAgbm9kZXMsXG4gICAgICBsaW5rcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgYSBkb2N1bWVudCB3aG9zZSBmaWxlIG9mIHJlY29yZCBpcyBnb25lIChFNjEpLlxuICAgKlxuICAgKiDim5QgVEhFIFdBUk5JTkcgSEFEIE5PIEFOU1dFUiwgV0hJQ0ggSVMgV0hZIFRISVMgRVhJU1RTLiBXaGVuIGEgZG9jdW1lbnQnc1xuICAgKiBvcmlnaW5hbCBkaXNhcHBlYXJzIGJldHdlZW4gc2Vzc2lvbnMsIHJlc3RvcmUgc2F5cyBzbyBvbiBwdXJwb3NlIOKAlCBcImdvbmVcbiAgICogZnJvbSBkaXNrIHNpbmNlIHRoaXMgc2Vzc2lvbiB3YXMgbGFzdCBvcGVuLiBTYXZlIHdvdWxkIHJlY3JlYXRlIGl0XCIg4oCUIGFuZFxuICAgKiB0aGF0IGlzIHRoZSBSSUdIVCB0aGluZyB0byBzYXksIGJlY2F1c2UgdGhlIHNlc3Npb24gaXMgc3RpbGwgaG9sZGluZyB0aGVcbiAgICogY29udGVudCBhbmQgb2ZmZXJpbmcgaXQgYmFjay4gV2hhdCB3YXMgbWlzc2luZyB3YXMgYW55IHdheSB0byByZXBseSBcIm5vLCBJXG4gICAqIG1lYW50IHRvIGRlbGV0ZSB0aGF0XCI6IHRoZSBub3RpY2UgcmVwZWF0ZWQgb24gZXZlcnkgcmVzdG9yZSBmb3JldmVyIGFuZCB0aGVcbiAgICogb25seSBlc2NhcGUgd2FzIHJlY3JlYXRpbmcgdGhlIHNlc3Npb24uIEEgd2FybmluZyB3aXRoIG5vIGNvcnJlc3BvbmRpbmcgYWN0XG4gICAqIGlzIHRoZSBzaGFwZSB0aGlzIHNwZWxsIGtlZXBzIHRyeWluZyBub3QgdG8gaGF2ZS5cbiAgICpcbiAgICog4puUIFJFRlVTRUQgV0hJTEUgVEhFIEZJTEUgRVhJU1RTLCBhbmQgdGhlIHJlZnVzYWwgbmFtZXMgdGhlIHJpZ2h0IHZlcmIuXG4gICAqIEZvcmdldHRpbmcgYSBMSVZFIGRvY3VtZW50J3MgcmVjb3JkIHdvdWxkIHRocm93IGF3YXkgaXRzIHZlcnNpb24gaGlzdG9yeVxuICAgKiB3aGlsZSB0aGUgZG9jdW1lbnQgaXRzZWxmIHNpdHMgdGhlcmUgb24gZGlzayDigJQgdGhlIGNvbmZ1c2lvbiB0aGlzIG11c3Qgbm90XG4gICAqIGVuYWJsZS4gVGFraW5nIHNvbWV0aGluZyBvdXQgb2YgdGhlIHNpZGViYXIgaXMgYGhpZGVgOyB0aGlzIGlzIG9ubHkgZm9yIGFcbiAgICogcmVjb3JkIHdob3NlIHN1YmplY3QgaXMgZ29uZS5cbiAgICpcbiAgICog4pqgIFRoZSB2ZXJzaW9uIGZpbGVzIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYXJlIExFRlQgd2hlcmUgdGhleSBhcmUsIGFzXG4gICAqIHdpdGggdW5kbydzIGRlbGV0ZTogbm90aGluZyByZWFkcyB0aGVtIG9uY2UgdGhlIHJlY29yZCBpcyBnb25lLCBhbmRcbiAgICogcmVtb3ZpbmcgdGhlbSB3b3VsZCBiZSBhIHNlY29uZCBkZWxldGlvbiBub2JvZHkgYXNrZWQgZm9yLlxuICAgKi9cbiAgZm9yZ2V0RG9jKHJlZj86IHN0cmluZyk6IHsgc2x1Zzogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IHZlcnNpb25zOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUocmVmKTtcbiAgICBpZiAoZXhpc3RzU3luYyhkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke3RoaXMuZGlzcGxheShkLm9yaWdpbmFsKX0gaXMgc3RpbGwgb24gZGlzayDigJQgZm9yZ2V0IGlzIGZvciBhIGRvY3VtZW50IHdob3NlIGZpbGUgaXMgZ29uZS4gVG8gdGFrZSBpdCBvdXQgb2YgdGhlIGNvbnRleHQsIHJlbW92ZSBpdCBmcm9tIFNjcmlwdG9yaXVtIGluc3RlYWQuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBmb3Jnb3R0ZW4gPSB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzID0gdGhpcy5tLmRvY3MuZmlsdGVyKCh4KSA9PiB4LnNsdWcgIT09IGQuc2x1Zyk7XG4gICAgaWYgKHRoaXMubS5vcGVuRG9jID09PSBkLnNsdWcpIHRoaXMubS5vcGVuRG9jID0gdGhpcy5tLmRvY3NbMF0/LnNsdWcgPz8gbnVsbDtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBmb3Jnb3R0ZW47XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgcGF0aCB0aGF0IGlzIG5vIGxvbmdlciBvbiBkaXNrOiBwcnVuZSBpdCBmcm9tIGV2ZXJ5IGNvbnRleHQgZW50cnksXG4gICAqIGRyb3AgdGhlIGVudHJ5IGlmIHRoYXQgZW1wdGllcyBpdCwgYW5kIGZvcmdldCBhbnkgZG9jdW1lbnQgcmVjb3JkIGZvciBpdC5cbiAgICpcbiAgICog4puUIGByZXNjYW5gIElTIE5PVCBFTk9VR0gsIEFORCBUSEFUIFdBUyBUSEUgQlVHLiBJdCByZXR1cm5zIGVhcmx5IGZvciBhbnlcbiAgICogZW50cnkgd2hvc2UgbWVtYmVyc2hpcCBpcyBub3QgYG1pcnJvcmVkYCDigJQgYW5kIGEgc2luZ2xlIGRvY3VtZW50IGlzIGFcbiAgICogYGxpc3RlZGAgZW50cnksIHNvIGRlbGV0aW5nIG9uZSBsZWZ0IGl0cyBub2RlIGluIHRoZSBzaWRlYmFyIGZvcmV2ZXIgd2hpbGVcbiAgICogdGhlIGZpbGUgd2FzIGdvbmUgZnJvbSB0aGUgZGlzay4gQ29sZSBmb3VuZCBpdCB3aXRoaW4gYSBtaW51dGUgb2YgRTYwXG4gICAqIHNoaXBwaW5nOiBcIml0J3Mgbm90IGJlaW5nIHJlbW92ZWQgZnJvbSB0aGUgc2lkZWJhcuKApiB0aGVuIEkgY3JlYXRlZCBhbm90aGVyXG4gICAqIGRvY3VtZW50IGFsc28gdW50aXRsZWQgYW5kIEkgdGhpbmsgdGhlcmUgbWlnaHQgaGF2ZSBiZWVuIGV2ZW4gYSB3ZWlyZFxuICAgKiBuYW1pbmcgaXNzdWVcIi5cbiAgICpcbiAgICog4pqgIFRIRSBOQU1JTkcgT0RESVRZIFdBUyBUSEUgU0VDT05EIEhBTEYgT0YgVEhFIFNBTUUgQlVHLiBUaGUgYERvY1JlY29yZGBcbiAgICogb3V0bGl2ZWQgdGhlIGZpbGUgdG9vLCBzbyBpdHMgU0xVRyBzdGF5ZWQgdGFrZW4gYW5kIHRoZSBuZXh0IGBVbnRpdGxlZC5tZGBcbiAgICogYmVjYW1lIGB1bnRpdGxlZC0yYCB3aGlsZSB0aGUgZmlsZSBvbiBkaXNrIHdhcyBwbGFpbiBgVW50aXRsZWQubWRgLiBBXG4gICAqIHJlY29yZCBmb3IgYSBkb2N1bWVudCB0aGF0IGRvZXMgbm90IGV4aXN0IGhhcyBubyByZWFkZXI7IGl0IG9ubHkgZ2V0cyBpblxuICAgKiB0aGUgd2F5IG9mIHRoZSBuZXh0IG9uZS5cbiAgICpcbiAgICog4pqgIFRoZSB2ZXJzaW9uIGZpbGVzIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYXJlIExFRlQgd2hlcmUgdGhleSBhcmUuIFRoZVxuICAgKiByZWNvcmQgaXMgZ29uZSwgc28gbm90aGluZyByZWFkcyB0aGVtLCBhbmQgcmVtb3ZpbmcgdGhlbSB3b3VsZCBiZSBhIHNlY29uZFxuICAgKiBkZWxldGlvbiB0aGUgaHVtYW4gd2FzIG5ldmVyIGFza2VkIGFib3V0IOKAlCB0aGUgZGlhbG9nIHByb21pc2VkIHRoZSBjcmVhdGVkXG4gICAqIGZpbGUsIG5vdCB0aGUgc2Vzc2lvbidzIG93biBjb3BpZXMuXG4gICAqL1xuICBwcml2YXRlIGZvcmdldFBhdGgoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpbnNpZGUgPSAocDogc3RyaW5nKSA9PiBwID09PSBhYnMgfHwgcC5zdGFydHNXaXRoKGFicyArIHNlcCk7XG4gICAgZm9yIChjb25zdCBlIG9mIFsuLi50aGlzLm0uY29udGV4dF0pIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAhaW5zaWRlKGUucm9vdCkpIHtcbiAgICAgICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gQSBgbGlzdGVkYCBlbnRyeSAob3IgYSBtaXJyb3JlZCBvbmUgdGhhdCBXQVMgdGhlIGRlbGV0ZWQgZm9sZGVyKTpcbiAgICAgIC8vIHBydW5lIHRoZSBub2RlcyBieSBoYW5kLCBzaW5jZSBgcmVzY2FuYCB3aWxsIG5vdCBsb29rIGF0IGl0LlxuICAgICAgY29uc3QgcHJ1bmUgPSAobm9kZXM6IENvbnRleHROb2RlW10pOiBDb250ZXh0Tm9kZVtdID0+XG4gICAgICAgIG5vZGVzXG4gICAgICAgICAgLmZpbHRlcigobikgPT4gIWluc2lkZShqb2luKGUucm9vdCwgbi5yZWwpKSlcbiAgICAgICAgICAubWFwKChuKSA9PiAobi5raW5kID09PSBcImdyb3VwXCIgPyB7IC4uLm4sIGNoaWxkcmVuOiBwcnVuZShuLmNoaWxkcmVuKSB9IDogbikpO1xuICAgICAgZS5ub2RlcyA9IHBydW5lKGUubm9kZXMpO1xuICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAwIHx8IGluc2lkZShlLnJvb3QpKSB0aGlzLnJlbW92ZUNvbnRleHQoZS5pZCk7XG4gICAgfVxuICAgIC8vIEEgcmVjb3JkIGZvciBhIGZpbGUgdGhhdCBpcyBnb25lIGhhcyBubyByZWFkZXIsIGFuZCBpdHMgc2x1ZyB3b3VsZFxuICAgIC8vIG90aGVyd2lzZSBzdGF5IHRha2VuLlxuICAgIHRoaXMubS5kb2NzID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiAhaW5zaWRlKGQub3JpZ2luYWwpKTtcbiAgICBpZiAodGhpcy5tLm9wZW5Eb2MgJiYgIXRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpKVxuICAgICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLm0uZG9jc1swXT8uc2x1ZyA/PyBudWxsO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgdW5oaWRlKGVudHJ5SWQ6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVzdG9yZWQ6IG51bWJlciB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcmVzdG9yZWQgPSBlLmhpZGRlbj8ubGVuZ3RoID8/IDA7XG4gICAgZGVsZXRlIGUuaGlkZGVuO1xuICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHJlc3RvcmVkIH07XG4gIH1cblxuICAvKipcbiAgICogRTIyOiBhIHNpbmdsZSBkb2N1bWVudCBiZWNvbWVzIGEgc2V0IOKAlCBhIGZvbGRlciBuYW1lZCBmb3IgaXQgYmVzaWRlIGl0LCB0aGVcbiAgICogZG9jdW1lbnQgbW92ZWQgaW4sIGFuZCB0aGUgZW50cnkgKHNhbWUgaWQpIG5vdyBtaXJyb3JzIHRoYXQgZm9sZGVyLlxuICAgKi9cbiAgbWFrZVNldChyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZm9sZGVyOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLmVudHJ5Lm1lbWJlcnNoaXAgIT09IFwibGlzdGVkXCIgfHwgaXRlbS5kaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIGEgc2V0IOKAlCBtYWtlIGEgZm9sZGVyIHRoZXJlIGluc3RlYWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoaXRlbS5hYnMpO1xuICAgIGNvbnN0IHN0ZW0gPSBiYXNlbmFtZShpdGVtLmFicywgZXh0bmFtZShpdGVtLmFicykpIHx8IFwiVW50aXRsZWRcIjtcbiAgICBjb25zdCBmb2xkZXIgPSBqb2luKHBhcmVudCwgdGhpcy5mcmVlTmFtZShwYXJlbnQsIHN0ZW0sIHRydWUpKTtcbiAgICBta2RpclN5bmMoZm9sZGVyKTtcbiAgICBjb25zdCB0byA9IGpvaW4oZm9sZGVyLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICBjb25zdCBlID0gaXRlbS5lbnRyeTtcbiAgICBlLm1lbWJlcnNoaXAgPSBcIm1pcnJvcmVkXCI7XG4gICAgZS5yb290ID0gZm9sZGVyO1xuICAgIGUubGFiZWwgPSBiYXNlbmFtZShmb2xkZXIpO1xuICAgIGUubm9kZXMgPSBbXTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZm9sZGVyLCBlbnRyeTogZS5pZCB9O1xuICB9XG5cbiAgLyoqIFRoZSBtb3N0IHRleHQgb25lIGltcG9ydCBjYXJyaWVzIOKAlCBhIGRvY3VtZW50LCBub3QgYSBkYXRhIGR1bXAuICovXG4gIHN0YXRpYyByZWFkb25seSBJTVBPUlRfTUFYX0JZVEVTID0gOCAqIDEwMjQgKiAxMDI0O1xuXG4gIC8qKlxuICAgKiBFMjMncyBkcm9wOiBhIENPUFkgb2YgYSBmaWxlJ3MgdGV4dCwgd3JpdHRlbiB1bmRlciBhIGZyZWUgbmFtZSBpbnRvIGBpbnRvYFxuICAgKiAoZGVmYXVsdDogdGhlIHdvcmtzcGFjZSksIHRoZW4gc2hvd24gbGlrZSBhbnkgb3RoZXIgZG9jdW1lbnQuXG4gICAqL1xuICBpbXBvcnRUZXh0KG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nLCByYXdJbnRvPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGlmICghaXNEb2NOYW1lKGZpbGUpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vdCBhIGRvY3VtZW50IFNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7ZmlsZX1gLFxuICAgICAgICA0MDAsXG4gICAgICAgIFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICApO1xuICAgIGlmIChCdWZmZXIuYnl0ZUxlbmd0aCh0ZXh0KSA+IFNlc3Npb24uSU1QT1JUX01BWF9CWVRFUylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2ZpbGV9IGlzIGxhcmdlciB0aGFuICR7U2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTIC8gMTAyNCAvIDEwMjR9IE1CIOKAlCBub3QgaW1wb3J0ZWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvID8/IHRoaXMud29ya3NwYWNlKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgdGhpcy5mcmVlTmFtZShkaXIsIGZpbGUsIGZhbHNlKSk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjaGF0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8vIOKUgOKUgCB0aGUgd29yayBxdWV1ZSAoRTUwKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogU3RhcnQgYSB0YXNrLiBJdCBpcyBBTk5PVU5DRUQgYXMgYSBjaGF0IG1lc3NhZ2UgYW5kIHJlY29yZGVkIGFzIGEgdGFzayBhdFxuICAgKiB0aGUgc2FtZSBtb21lbnQg4oCUIENvbGUncyBmcmFtaW5nLCBcImEgbWVzc2FnZSB0aGF0IGNhbiBiZSBtYXJrZWQgZG9uZVwiIOKAlFxuICAgKiBzbyB0aGUgY29udmVyc2F0aW9uIHJlYWRzIGFzIGEgbmFycmF0aXZlIGFuZCB0aGUgcXVldWUgcmVhZHMgYXMgc3RhdGUsXG4gICAqIG92ZXIgb25lIGZhY3QgcmF0aGVyIHRoYW4gdHdvLlxuICAgKi9cbiAgc3RhcnRUYXNrKHRleHQ6IHN0cmluZywgd2hvOiBWZXJzaW9uQXV0aG9yKTogVGFzayB7XG4gICAgY29uc3QgYm9keSA9IHRleHQudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgdGFzayBuZWVkcyB0byBzYXkgd2hhdCB0aGUgd29yayBpc1wiLCA0MDApO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSB0aGlzLmFkZE1lc3NhZ2Uod2hvLCBib2R5KTtcbiAgICBjb25zdCB0YXNrOiBUYXNrID0ge1xuICAgICAgaWQ6IGB0LSR7cmFuZEhleCg0KX1gLFxuICAgICAgdGV4dDogYm9keSxcbiAgICAgIHdobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIG1lc3NhZ2VJZDogbWVzc2FnZS5pZCxcbiAgICB9O1xuICAgIHRoaXMubS50YXNrcyA9IFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKSwgdGFza107XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICBwcml2YXRlIHRhc2tPckRpZShpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgICBpZiAoIXRhc2spXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gdGFzayAke2lkfSBpbiB0aGlzIHNlc3Npb25gLFxuICAgICAgICA0MDQsXG4gICAgICAgICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCkubWFwKCh0KSA9PiB0LmlkKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKiogU2F5IHdoYXQgaXMgYmVpbmcgZG9uZSByaWdodCBub3cg4oCUIGZvciB3b3JrIHdpdGggc3RlcHMgd29ydGggd2F0Y2hpbmcuICovXG4gIHNldFRhc2tTdGF0dXMoaWQ6IHN0cmluZywgc3RhdHVzOiBzdHJpbmcpOiBUYXNrIHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGlmICh0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGFzayAke2lkfSBpcyBhbHJlYWR5IGRvbmUg4oCUIGl0cyBzdGF0dXMgY2Fubm90IGNoYW5nZWAsIDQwOSk7XG4gICAgdGFzay5zdGF0dXMgPSBzdGF0dXMudHJpbSgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcmsgaXQgZG9uZS4gSWRlbXBvdGVudCBvbiBwdXJwb3NlOiBhIHRhc2sgZmluaXNoZWQgdHdpY2Ug4oCUIGFuIGFnZW50XG4gICAqIHJldHJ5aW5nLCBhIGh1bWFuIGNsaWNraW5nIGFzIHRoZSBhZ2VudCByZXBvcnRzIOKAlCBpcyBub3QgYW4gZXJyb3IsIGFuZFxuICAgKiByZWZ1c2luZyB3b3VsZCBtYWtlIHRoZSBzdXJmYWNlIGhhbmRsZSBhIHJhY2UgaXQgZGlkIG5vdCBjYXVzZS5cbiAgICovXG4gIGZpbmlzaFRhc2soaWQ6IHN0cmluZywgb3V0Y29tZT86IHN0cmluZyk6IHsgdGFzazogVGFzazsgYWxyZWFkeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGNvbnN0IGFscmVhZHkgPSB0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghYWxyZWFkeSkge1xuICAgICAgdGFzay5kb25lQXQgPSBEYXRlLm5vdygpO1xuICAgICAgdGFzay5zdGF0dXMgPSB1bmRlZmluZWQ7XG4gICAgICBpZiAob3V0Y29tZT8udHJpbSgpKSB0YXNrLm91dGNvbWUgPSBvdXRjb21lLnRyaW0oKTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIH1cbiAgICByZXR1cm4geyB0YXNrLCBhbHJlYWR5IH07XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgdGFzayBlbnRpcmVseSDigJQgZm9yIG9uZSBzdGFydGVkIGJ5IG1pc3Rha2UuIE1hcmtpbmcgaXQgZG9uZSB3b3VsZFxuICAgKiBwdXQgYSB0aGluZyB0aGF0IG5ldmVyIGhhcHBlbmVkIGludG8gdGhlIHJlY29yZDsgYSBxdWV1ZSB5b3UgY2Fubm90IGNsZWFyXG4gICAqIG9mIGl0cyBvd24gbWlzdGFrZXMgc3RvcHMgYmVpbmcgYSB0cnVzdHdvcnRoeSBhY2NvdW50IG9mIHRoZSB3b3JrLlxuICAgKi9cbiAgcmVtb3ZlVGFzayhpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuaWQgIT09IGlkKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgZXZlcnkgZmluaXNoZWQgdGFzay4gT3V0c3RhbmRpbmcgb25lcyBhcmUgdW50b3VjaGVkIOKAlCBjbGVhcmluZyBpc1xuICAgKiB0aWR5aW5nIHdoYXQgaXMgT1ZFUiwgbmV2ZXIgYWJhbmRvbmluZyB3b3JrIHN0aWxsIGluIGZsaWdodC5cbiAgICovXG4gIGNsZWFyRG9uZVRhc2tzKCk6IG51bWJlciB7XG4gICAgY29uc3QgYmVmb3JlID0gKHRoaXMubS50YXNrcyA/PyBbXSkubGVuZ3RoO1xuICAgIHRoaXMubS50YXNrcyA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgY2xlYXJlZCA9IGJlZm9yZSAtICh0aGlzLm0udGFza3M/Lmxlbmd0aCA/PyAwKTtcbiAgICBpZiAoY2xlYXJlZCA+IDApIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBjbGVhcmVkO1xuICB9XG5cbiAgLyoqIE5ld2VzdCBmaXJzdCDigJQgYSBxdWV1ZSBpcyByZWFkIGZyb20gdGhlIHRvcC4gKi9cbiAgdGFza3MoKTogVGFza1tdIHtcbiAgICByZXR1cm4gWy4uLih0aGlzLm0udGFza3MgPz8gW10pXS5zb3J0KChhLCBiKSA9PiBiLmNyZWF0ZWRBdCAtIGEuY3JlYXRlZEF0KTtcbiAgfVxuXG4gIGFkZE1lc3NhZ2UoXG4gICAgd2hvOiBDaGF0V2hvLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBleHRyYTogeyBzZWxlY3Rpb24/OiBTZWxlY3Rpb24gfCBudWxsOyBhY3RpdmVQYXRoPzogc3RyaW5nIHwgbnVsbDsgbm90ZT86IE5vdGVSZWYgfSA9IHt9LFxuICApOiBDaGF0TWVzc2FnZSB7XG4gICAgY29uc3QgbXNnOiBDaGF0TWVzc2FnZSA9IHsgaWQ6IGBtLSR7cmFuZEhleCg0KX1gLCB3aG8sIHRleHQsIHRzOiBEYXRlLm5vdygpLCAuLi5leHRyYSB9O1xuICAgIHRoaXMubS5jaGF0LnB1c2gobXNnKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gbXNnO1xuICB9XG5cbiAgLy8g4pSA4pSAIHZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBBIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIsIGZyb20gdGhlIEFDVElWRSB2ZXJzaW9uJ3MgdGV4dCDigJQgd2hhdCB0aGUgaHVtYW5cbiAgICogIGlzIHJlYWRpbmcsIHdoaWNoIGlzIG5vdCBhbHdheXMgd2hhdCBpcyBvbiBkaXNrIChFMzIpLiAqL1xuICBwcml2YXRlIG1ldGFPZihkOiBEb2NSZWNvcmQpOiBEb2NWaWV3W1wibWV0YVwiXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkTWV0YShyZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICBkb2NWaWV3KGQ6IERvY1JlY29yZCk6IERvY1ZpZXcge1xuICAgIHJldHVybiB7XG4gICAgICBtZXRhOiB0aGlzLm1ldGFPZihkKSxcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgZW50cnlJZDogZC5lbnRyeUlkLFxuICAgICAgcmVsOiBkLnJlbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLm1hcCgodikgPT4gKHsgLi4udiwgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCB2Lm4pIH0pKSxcbiAgICAgIG5vdGVzOiB0aGlzLnBsYWNlZE5vdGVzKGQpLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGRpcnR5OiB0aGlzLmlzRGlydHkoZCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZC5vdXRzaWRlQ2hhbmdlZCxcbiAgICB9O1xuICB9XG5cbiAgZG9jKHNsdWc6IHN0cmluZyk6IERvY1ZpZXcge1xuICAgIHJldHVybiB0aGlzLmRvY1ZpZXcodGhpcy5kb2NPckRpZShzbHVnKSk7XG4gIH1cblxuICAvKipcbiAgICogRnJvbnRtYXR0ZXIgZm9yIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBjb250ZXh0LCBieSBwYXRoIChFMzIpLlxuICAgKlxuICAgKiBDYWNoZWQgYnkgcGF0aCBhbmQgbXRpbWUsIGFuZCByZWFkIEhFQUQtRklSU1Q6IGEgZnJvbnRtYXR0ZXIgYmxvY2sgc2l0cyBhdFxuICAgKiB0aGUgdG9wIG9mIGEgZmlsZSwgc28gYSAzMDAgS0IgZG9jdW1lbnQgY29zdHMgOCBLQiBvZiByZWFkLiBUaGUgY2FwIGtlZXBzIGFcbiAgICogMiwwMDAtbm9kZSBtaXJyb3IgZnJvbSBtZWFuaW5nIDIsMDAwIHJlYWRzIHBlciBzbmFwc2hvdCwgYW5kIGhpdHRpbmcgaXQgaXNcbiAgICogU0FJRCBvbiB0aGUgd2lyZSByYXRoZXIgdGhhbiBsZWZ0IHRvIGxvb2sgbGlrZSBkb2N1bWVudHMgd2l0aG91dCBhbnkuXG4gICAqL1xuICBwcml2YXRlIG1ldGFDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCB7IG10aW1lTXM6IG51bWJlcjsgc3VtbWFyeTogRG9jU3VtbWFyeSB8IG51bGwgfT4oKTtcblxuICBjb250ZXh0TWV0YShjYXAgPSBNRVRBX1NDQU5fQ0FQKTogeyBtYXA6IFJlY29yZDxzdHJpbmcsIERvY1N1bW1hcnk+OyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgbWFwOiBSZWNvcmQ8c3RyaW5nLCBEb2NTdW1tYXJ5PiA9IHt9O1xuICAgIGxldCBzZWVuID0gMDtcbiAgICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkge1xuICAgICAgICBpZiAoc2VlbiA+PSBjYXApIHtcbiAgICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIHNlZW4rKztcbiAgICAgICAgbGV0IG10aW1lTXM6IG51bWJlcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtdGltZU1zID0gc3RhdFN5bmMoYWJzKS5tdGltZU1zO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBoaXQgPSB0aGlzLm1ldGFDYWNoZS5nZXQoYWJzKTtcbiAgICAgICAgbGV0IHN1bW1hcnk6IERvY1N1bW1hcnkgfCBudWxsO1xuICAgICAgICBpZiAoaGl0ICYmIGhpdC5tdGltZU1zID09PSBtdGltZU1zKSBzdW1tYXJ5ID0gaGl0LnN1bW1hcnk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHN1bW1hcnkgPSBzdW1tYXJpemUocmVhZE1ldGEocmVhZEhlYWQoYWJzKSkpO1xuICAgICAgICAgIHRoaXMubWV0YUNhY2hlLnNldChhYnMsIHsgbXRpbWVNcywgc3VtbWFyeSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3VtbWFyeSkgbWFwW2Fic10gPSBzdW1tYXJ5O1xuICAgICAgfVxuICAgICAgaWYgKHRydW5jYXRlZCkgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiB7IG1hcCwgdHJ1bmNhdGVkIH07XG4gIH1cblxuICAvKipcbiAgICogT25lIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgYXMgcmVhZCwgb3IgZXZlcnkgY29udGV4dCBkb2N1bWVudCdzIChFMzIpLiBUaGVcbiAgICogYWdlbnQgZ2V0cyB0aGUgZGFlbW9uJ3MgcGFyc2UgcmF0aGVyIHRoYW4gcmUtcmVhZGluZyB0aGUgWUFNTCBpdHNlbGYuXG4gICAqL1xuICBtZXRhRm9yKHJhd1BhdGg/OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgaWYgKHJhd1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYWJzID0gdGhpcy5zaG93blBhdGgocmF3UGF0aCk7XG4gICAgICBjb25zdCBtZXRhID0gcmVhZE1ldGEocmVhZEhlYWQoYWJzKSk7XG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIG1ldGEsIC4uLihtZXRhID8ge30gOiB7IG5vdGU6IFwibm8gZnJvbnRtYXR0ZXIgYmxvY2tcIiB9KSB9O1xuICAgIH1cbiAgICBjb25zdCBvdXQ6IHsgcGF0aDogc3RyaW5nOyBtZXRhOiBEb2NNZXRhIHwgbnVsbCB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IGFicyBvZiBkb2NQYXRocyhlKSkgb3V0LnB1c2goeyBwYXRoOiBhYnMsIG1ldGE6IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpIH0pO1xuICAgIHJldHVybiB7IGRvY3VtZW50czogb3V0LCBjb3VudDogb3V0Lmxlbmd0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIHBkb2NzJ3MgYGZpbmRgLCBvdmVyIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQuIFNhbWUgZmlsdGVyIG5hbWVzLCBzYW1lXG4gICAqIEFORGluZywgYW5kIHRoZSBzYW1lIHJ1bGUgdGhhdCBhbiBlbXB0eSByZXN1bHQgaXMgYW4gQU5TV0VSOiBgY291bnRgIHNheXNcbiAgICogaG93IG1hbnkgbWF0Y2hlZCwgYW5kIHRoZSBjYWxsZXIgcmVhZHMgdGhhdCByYXRoZXIgdGhhbiB0aGUgZXhpdCBjb2RlLlxuICAgKi9cbiAgZmluZChmaWx0ZXI6IE1ldGFGaWx0ZXIpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgbWF0Y2hlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSByZWFkTWV0YShyZWFkSGVhZChhYnMpKTtcbiAgICAgICAgaWYgKCFtYXRjaGVzRmlsdGVyKG1ldGEsIGZpbHRlcikpIGNvbnRpbnVlO1xuICAgICAgICBtYXRjaGVzLnB1c2goe1xuICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICBlbnRyeTogZS5pZCxcbiAgICAgICAgICAuLi4obWV0YT8udHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG1ldGE/LnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgICAgICAgIC4uLihtZXRhPy5kZXNjcmlwdGlvbiA/IHsgZGVzY3JpcHRpb246IG1ldGEuZGVzY3JpcHRpb24gfSA6IHt9KSxcbiAgICAgICAgICBzdGF0dXM6IG1ldGE/LnN0YXR1cyA/PyBudWxsLFxuICAgICAgICAgIC4uLihtZXRhPy5saWZlY3ljbGUgPyB7IGxpZmVjeWNsZTogbWV0YS5saWZlY3ljbGUgfSA6IHt9KSxcbiAgICAgICAgICB0YWdzOiBtZXRhPy50YWdzID8/IFtdLFxuICAgICAgICAgIGRhdGU6IG1ldGE/LmRhdGUgPz8gbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgcmV0dXJuIHsgbWF0Y2hlcywgY291bnQ6IG1hdGNoZXMubGVuZ3RoIH07XG4gIH1cblxuICAvKipcbiAgICogT25lIHNldCdzIG1hcCAoRTMzKTogaXRzIGRvY3VtZW50cyBhcyBub2RlcywgYW5kIHRoZSBmb3VyIHNvdXJjZXMgb2YgZWRnZXNcbiAgICog4oCUIGJvZHkgbGlua3MsIHdpa2kgbGlua3MsIHR5cGVkIGxpbmtzIGFuZCBmcm9udG1hdHRlciByZWZlcmVuY2VzLlxuICAgKi9cbiAgZ3JhcGhGb3IoZW50cnlJZD86IHN0cmluZyk6IEdyYXBoUGF5bG9hZCB7XG4gICAgY29uc3QgZSA9IGVudHJ5SWRcbiAgICAgID8gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZClcbiAgICAgIDogdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGVudHJ5SWQgPyBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCA6IFwidGhpcyBzZXNzaW9uIGhhcyBubyBzZXQgdG8gbWFwXCIsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcGF0aHMgPSBkb2NQYXRocyhlKTtcbiAgICBjb25zdCBpbmRleDogQnVuZGxlSW5kZXggPSB7XG4gICAgICByb290OiBlLnJvb3QsXG4gICAgICBwYXRocyxcbiAgICAgIG1ldGFPZjogKHApID0+IHJlYWRNZXRhKHJlYWRIZWFkKHApKSxcbiAgICAgIGV4aXN0czogKHApID0+IGV4aXN0c1N5bmMocCksXG4gICAgICByZXBvUm9vdDogZ2l0Um9vdE9mKGUucm9vdCksXG4gICAgfTtcbiAgICBjb25zdCBnID0gYnVpbGRHcmFwaChpbmRleCwgKHApID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBzcGxpdEZyb250bWF0dGVyKHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikpLmJvZHk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIFwiXCI7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIC4uLmcgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZWFyY2ggZXZlcnl0aGluZyBpbiB0aGUgY29udGV4dDogZnV6enkgb3ZlciBuYW1lcywgZXhhY3Qgb3ZlciBjb250ZW50IChFNTkpLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBXSFkgVEhFIFZFUkIgRVhJU1RTIEFUIEFMTCwgYW5kIHRoZSByZWFzb24gaXMgb25lIGxpbmU6IGFcbiAgICogZG9jdW1lbnQgb3BlbiBpbiB0aGUgc2Vzc2lvbiBpcyBzaG93biBhcyBpdHMgQUNUSVZFIFZFUlNJT04sIHdoaWNoIGxpdmVzXG4gICAqIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYW5kIG5vdCBhdCB0aGUgb3JpZ2luYWwgcGF0aC4gQW4gYWdlbnQgZ3JlcHBpbmcgdGhlXG4gICAqIHdvcmtzcGFjZSB0aGVyZWZvcmUgZmluZHMgdGhlIFNBVkVEIGZpbGUgYW5kIHNpbGVudGx5IG1pc3NlcyB0aGUgdGV4dCB0aGVcbiAgICogaHVtYW4gaXMgcmVhZGluZyDigJQgc28gXCJzZWFyY2ggd2hhdCB5b3UgY2FuIHNlZVwiIGlzIGEgcXVlc3Rpb24gb25seSB0aGVcbiAgICogc2Vzc2lvbiBjYW4gYW5zd2VyLiBFdmVyeXRoaW5nIGVsc2UgYWJvdXQgc2VhcmNoaW5nIGZpbGVzLCBhbiBhZ2VudCBjYW5cbiAgICogYWxyZWFkeSBkbyB3aXRoIGdyZXAsIHdoaWNoIGlzIHdoeSB0aGVyZSBpcyBubyBpbi1kb2N1bWVudCB2ZXJiLlxuICAgKlxuICAgKiDimqAgSGlkZGVuIGRvY3VtZW50cyBhcmUgZXhjbHVkZWQsIGJlY2F1c2UgdGhlIGNvbnRleHQgaXMgd2hhdCB0aGUgaHVtYW5cbiAgICogY2hvc2UgdG8gbG9vayBhdDsgYSByZXN1bHQgdGhleSBjYW5ub3Qgc2VlIGluIHRoZSBzaWRlYmFyIHdvdWxkIGJlIGEgcmVzdWx0XG4gICAqIHRoZXkgY2Fubm90IG9wZW4uXG4gICAqL1xuICBzZWFyY2hBbGwob3B0czogeyBxdWVyeTogc3RyaW5nOyBsaW1pdD86IG51bWJlciB9KTogU2VhcmNoUmVwb3J0IHtcbiAgICBjb25zdCBjYW5kaWRhdGVzOiBDYW5kaWRhdGVbXSA9IFtdO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBmb3IgKGNvbnN0IHBhdGggb2YgZG9jUGF0aHMoZW50cnkpKSB7XG4gICAgICAgIGlmIChzZWVuLmhhcyhwYXRoKSkgY29udGludWU7XG4gICAgICAgIHNlZW4uYWRkKHBhdGgpO1xuICAgICAgICBjb25zdCByZWNvcmQgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBwYXRoKTtcbiAgICAgICAgY29uc3QgdGl0bGUgPSByZWFkTWV0YShyZWFkSGVhZChwYXRoKSk/LnRpdGxlO1xuICAgICAgICBjYW5kaWRhdGVzLnB1c2goe1xuICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgbmFtZTogYmFzZW5hbWUocGF0aCksXG4gICAgICAgICAgLi4uKHJlY29yZCA/IHsgc2x1ZzogcmVjb3JkLnNsdWcsIHZlcnNpb246IHJlY29yZC5hY3RpdmUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odGl0bGUgPyB7IHRpdGxlIH0gOiB7fSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gc2VhcmNoRG9jdW1lbnRzKFxuICAgICAgY2FuZGlkYXRlcyxcbiAgICAgIG9wdHMucXVlcnksXG4gICAgICAoYykgPT4ge1xuICAgICAgICAvLyBUaGUgQUNUSVZFIFZFUlNJT04gd2hlbiB0aGUgc2Vzc2lvbiBoYXMgb25lIOKAlCBzZWUgdGhlIG5vdGUgYWJvdmUuXG4gICAgICAgIGNvbnN0IHJlY29yZCA9XG4gICAgICAgICAgYy5zbHVnID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGMuc2x1Zyk7XG4gICAgICAgIGlmIChyZWNvcmQpIHJldHVybiB0aGlzLmFjdGl2ZVRleHQocmVjb3JkKTtcbiAgICAgICAgcmV0dXJuIHJlYWRGaWxlU3luYyhjLnBhdGgsIFwidXRmOFwiKTtcbiAgICAgIH0sXG4gICAgICBvcHRzLmxpbWl0ICE9PSB1bmRlZmluZWQgPyB7IHRvdGFsOiBvcHRzLmxpbWl0IH0gOiB7fSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGxpbmsgaW4gYSBzZXQgdGhhdCBub3RoaW5nIGFuc3dlcnMg4oCUIHRoZSByZXBvcnQgeW91IGNhbiBBQ1Qgb24gKEU1NCkuXG4gICAqXG4gICAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgZ3JhcGhgIEFMUkVBRFkgSEFEIFRIRSBGQUNUUyBBTkQgU1RJTEwgRElEIE5PVCBBTlNXRVJcbiAgICogVEhFIFFVRVNUSU9OLiBDb2xlIGFza2VkIHdoZXRoZXIgYW4gYWdlbnQgY2FuIGNoZWNrIGRhbmdsaW5nIGxpbmtzOyB0aGVcbiAgICogaG9uZXN0IGFuc3dlciB3YXMgXCJ5ZXMsIGJ5IGZldGNoaW5nIGEgc2V0J3Mgd2hvbGUgbWFwIGFuZCBmaWx0ZXJpbmcgc2V2ZXJhbFxuICAgKiBodW5kcmVkIGVkZ2VzXCIsIHdoaWNoIGlzIGEgZGlmZmVyZW50IHRoaW5nIGZyb20gYmVpbmcgYWJsZSB0byBjaGVjayB0aGVtLlxuICAgKiBUaGlzIHNheXMgb25seSB3aGF0IGlzIGJyb2tlbiwgYW5kIHNheXMgaXQgYXMgYGZpbGU6bGluZWAgcGx1cyBUSEUgU1RSSU5HXG4gICAqIFRIRSBET0NVTUVOVCBBQ1RVQUxMWSBDT05UQUlOUyDigJQgd2hpY2ggaXMgd2hhdCB5b3UgbmVlZCB0byByZXBhaXIgb25lLCBhbmRcbiAgICogd2hhdCB0aGUgbWFwJ3MgcmVzb2x2ZWQgYHRvYCBoYWQgcXVpZXRseSB0aHJvd24gYXdheS5cbiAgICpcbiAgICog4pqgIE5PVCBBTiBFUlJPUi4gQSBkYW5nbGluZyBsaW5rIGlzIGEgZmFjdCBhYm91dCBhIHNldCwgbm90IGEgZmFpbHVyZTogT0tGXG4gICAqIMKnMTEncyBydWxlLCBhbmQgaXQgaXMgd2h5IHRoaXMgcmVwb3J0cyBhbmQgZXhpdHMgemVyby4gRG9jdW1lbnRzIHRoYXQgcG9pbnRcbiAgICogYXQgdGhpbmdzIG5vdCB3cml0dGVuIHlldCBhcmUgbm9ybWFsIGluIGEgd29ybGQgYmlibGUuXG4gICAqL1xuICBkYW5nbGluZ0xpbmtzKGVudHJ5SWQ/OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZW50cnlJZCk7XG4gICAgY29uc3QgYnJva2VuID0gZy5lZGdlcy5maWx0ZXIoKGUpID0+IGUuc3RhdGUgPT09IFwibWlzc2luZ1wiKTtcbiAgICAvLyDim5QgQk9EWSBMSU5FUyBCRUNPTUUgRklMRSBMSU5FUyBIRVJFLiBMaW5rcyBhcmUgZXh0cmFjdGVkIGZyb20gdGhlIGJvZHksXG4gICAgLy8gc28gdGhlIG51bWJlciB0aGUgZ3JhcGggY2FycmllcyBpcyBzaG9ydCBieSBob3dldmVyIG11Y2ggZnJvbnRtYXR0ZXIgdGhlXG4gICAgLy8gZG9jdW1lbnQgaGFzIOKAlCBhbmQgYSByZXBvcnQgaXMgZm9yIG9wZW5pbmcgYSBmaWxlIGF0IGEgbGluZS5cbiAgICBjb25zdCBvZmZzZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgICBjb25zdCBvZmZzZXRPZiA9IChwYXRoOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xuICAgICAgY29uc3Qga25vd24gPSBvZmZzZXRzLmdldChwYXRoKTtcbiAgICAgIGlmIChrbm93biAhPT0gdW5kZWZpbmVkKSByZXR1cm4ga25vd247XG4gICAgICBsZXQgb2ZmID0gMDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG9mZiA9IGJvZHlMaW5lT2Zmc2V0KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVucmVhZGFibGUg4oCUIHJlcG9ydCB0aGUgYm9keSBsaW5lIHJhdGhlciB0aGFuIG5vdGhpbmcgKi9cbiAgICAgIH1cbiAgICAgIG9mZnNldHMuc2V0KHBhdGgsIG9mZik7XG4gICAgICByZXR1cm4gb2ZmO1xuICAgIH07XG4gICAgcmV0dXJuIHtcbiAgICAgIGVudHJ5OiBnLmVudHJ5LFxuICAgICAgcm9vdDogZy5yb290LFxuICAgICAgY291bnQ6IGJyb2tlbi5sZW5ndGgsXG4gICAgICBsaW5rczogYnJva2VuLm1hcCgoZSkgPT4gKHtcbiAgICAgICAgZnJvbTogZS5mcm9tLFxuICAgICAgICAuLi4oZS5saW5lICE9PSB1bmRlZmluZWQgPyB7IGxpbmU6IGUubGluZSArIG9mZnNldE9mKGUuZnJvbSkgfSA6IHt9KSxcbiAgICAgICAgLy8gV2hhdCB0aGUgZG9jdW1lbnQgc2F5cywgbm90IHdoYXQgd2UgbG9va2VkIGZvci5cbiAgICAgICAgLi4uKGUucmF3ICE9PSB1bmRlZmluZWQgPyB7IHdyb3RlOiBlLnJhdyB9IDoge30pLFxuICAgICAgICAvLyBXaGVyZSB0aGUgcmVzb2x1dGlvbiBlbmRlZCB1cCwgc28gYSBuZWFyLW1pc3MgaXMgdmlzaWJsZS5cbiAgICAgICAgdHJpZWQ6IGUudG8sXG4gICAgICAgIHNvdXJjZTogZS5zb3VyY2UsXG4gICAgICAgIC4uLihlLmtleSA/IHsga2V5OiBlLmtleSB9IDoge30pLFxuICAgICAgICAuLi4oZS5yZWwubGVuZ3RoID8geyByZWw6IGUucmVsIH0gOiB7fSksXG4gICAgICB9KSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGF0IGNpdGVzIGEgZG9jdW1lbnQuIGByZWxhdGVkYCAoZnJvbnRtYXR0ZXIpIGFuZCBgbGlua3NgIChib2R5KSBhcmUga2VwdFxuICAgKiBBUEFSVCwgd2hpY2ggaXMgaG93IHBkb2NzIHJlcG9ydHMgaXQgYW5kIHRoZSBkaXN0aW5jdGlvbiBpcyByZWFsOiBvbmUgaXMgYVxuICAgKiBjbGFpbSBhYm91dCB0aGUgZG9jdW1lbnQsIHRoZSBvdGhlciBhIGNpdGF0aW9uIGluIHByb3NlLlxuICAgKi9cbiAgYmFja2xpbmtzKHJhd1BhdGg6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT4gZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gICAgaWYgKCFlbnRyeSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBpbnNpZGUgYSBzZXQsIHNvIG5vdGhpbmcgbWFwcyBpdGAsIDQwMCk7XG4gICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZW50cnkuaWQpO1xuICAgIGNvbnN0IGluYm91bmQgPSBnLmVkZ2VzLmZpbHRlcigoeCkgPT4geC50byA9PT0gYWJzKTtcbiAgICBjb25zdCB0aXRsZSA9IChwOiBzdHJpbmcpID0+IGcubm9kZXMuZmluZCgobikgPT4gbi5wYXRoID09PSBwKT8udGl0bGUgPz8gYmFzZW5hbWUocCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRhcmdldDogeyBwYXRoOiBhYnMsIHRpdGxlOiB0aXRsZShhYnMpIH0sXG4gICAgICByZWxhdGVkOiBpbmJvdW5kXG4gICAgICAgIC5maWx0ZXIoKHgpID0+IHguc291cmNlID09PSBcImZyb250bWF0dGVyXCIpXG4gICAgICAgIC5tYXAoKHgpID0+ICh7IHBhdGg6IHguZnJvbSwgdGl0bGU6IHRpdGxlKHguZnJvbSksIGtleTogeC5rZXkgfSkpLFxuICAgICAgbGlua3M6IGluYm91bmRcbiAgICAgICAgLmZpbHRlcigoeCkgPT4geC5zb3VyY2UgPT09IFwibGlua1wiKVxuICAgICAgICAubWFwKCh4KSA9PiAoeyBwYXRoOiB4LmZyb20sIHRpdGxlOiB0aXRsZSh4LmZyb20pLCByZWw6IHgucmVsIH0pKSxcbiAgICAgIGNvdW50OiBpbmJvdW5kLmxlbmd0aCxcbiAgICB9O1xuICB9XG5cbiAgLyoqIFdoZXJlIGRvZXMgdGhpcyBsaW5rIGdvPyBUaGUgc3VyZmFjZSBhc2tzIGJlZm9yZSBmb2xsb3dpbmcgb25lIChFMzMpLiAqL1xuICByZXNvbHZlTGluayhmcm9tOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nKTogUmVzb2x1dGlvbiB7XG4gICAgY29uc3Qgc3JjID0gdGhpcy5zaG93blBhdGgoZnJvbSk7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIHNyYy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCksXG4gICAgKTtcbiAgICBjb25zdCByb290ID0gZW50cnk/LnJvb3QgPz8gZGlybmFtZShzcmMpO1xuICAgIGNvbnN0IHBhdGhzID0gZW50cnkgPyBkb2NQYXRocyhlbnRyeSkgOiBbc3JjXTtcbiAgICByZXR1cm4gcmVzb2x2ZVRhcmdldCh0YXJnZXQsIHNyYywge1xuICAgICAgcm9vdCxcbiAgICAgIHBhdGhzLFxuICAgICAgbWV0YU9mOiAocCkgPT4gcmVhZE1ldGEocmVhZEhlYWQocCkpLFxuICAgICAgZXhpc3RzOiAocCkgPT4gZXhpc3RzU3luYyhwKSxcbiAgICAgIHJlcG9Sb290OiBnaXRSb290T2Yocm9vdCksXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogV2hhdCBhIGZyb250bWF0dGVyIGJsb2NrIGZvciB0aGlzIGRvY3VtZW50IFdPVUxEIHNheSAoRTM1KS4gU3VnZ2VzdGVkLCBub3RcbiAgICogd3JpdHRlbjogdGhlIHR5cGUgY29tZXMgZnJvbSB0aGUgZG9jdW1lbnRzIGJlc2lkZSBpdCwgdGhlIHRpdGxlIGZyb20gaXRzXG4gICAqIG93biBIMSwgYW5kIGBkZXNjcmlwdGlvbmAgaXMgbGVmdCBibGFuayBmb3Igd2hvZXZlciBmaWxscyBpdCBpbi5cbiAgICovXG4gIHN1Z2dlc3RNZXRhKHJhd1BhdGg6IHN0cmluZywgYnk/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgYmxvY2s6IHN0cmluZzsgdHlwZT86IHN0cmluZyB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGlmIChzcGxpdEZyb250bWF0dGVyKHRleHQpLnJhdyAhPT0gbnVsbClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YmFzZW5hbWUoYWJzKX0gYWxyZWFkeSBoYXMgZnJvbnRtYXR0ZXJgLCA0MDkpO1xuICAgIGNvbnN0IGZvbGRlciA9IGRpcm5hbWUoYWJzKTtcbiAgICBjb25zdCBzaWJsaW5nczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICBmb3IgKGNvbnN0IHAgb2YgZG9jUGF0aHMoZSkpXG4gICAgICAgIGlmIChwICE9PSBhYnMgJiYgZGlybmFtZShwKSA9PT0gZm9sZGVyKSB7XG4gICAgICAgICAgY29uc3QgdCA9IHJlYWRNZXRhKHJlYWRIZWFkKHApKT8udHlwZTtcbiAgICAgICAgICBpZiAodCkgc2libGluZ3MucHVzaCh0KTtcbiAgICAgICAgfVxuICAgIGNvbnN0IHR5cGUgPSBndWVzc1R5cGUoc2libGluZ3MsIGJhc2VuYW1lKGZvbGRlcikpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoOiBhYnMsXG4gICAgICB0eXBlLFxuICAgICAgYmxvY2s6IGJ1aWxkQmxvY2soe1xuICAgICAgICAuLi4odHlwZSA/IHsgdHlwZSB9IDoge30pLFxuICAgICAgICAuLi4odGl0bGVGcm9tQm9keSh0ZXh0KSA/IHsgdGl0bGU6IHRpdGxlRnJvbUJvZHkodGV4dCkgYXMgc3RyaW5nIH0gOiB7fSksXG4gICAgICAgIC4uLihieSA/IHsgYnkgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogV3JpdGUgYSBuZXcgYmxvY2sgaW50byBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUgKEUzNSkuXG4gICAqXG4gICAqIOKblCBUSElTIFdSSVRFUyBUSEUgT1JJR0lOQUwsIHdoaWNoIEU3IG90aGVyd2lzZSByZXNlcnZlcyBmb3IgU2F2ZSDigJQgYW5kXG4gICAqIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuIG92ZXJzaWdodDogdGhlIGFnZW50J3MgdmVyYiB3cml0ZXMgdGhlIGZpbGUsIGFuZFxuICAgKiBpZiB0aGUgaHVtYW4gaGFzIHVuc2F2ZWQgZWRpdHMgdG8gaXQgdGhlIENPTkZMSUNUIEJBUiBhcHBlYXJzIGFuZCB0aGV5XG4gICAqIGNob29zZSAoQ29sZTogXCJ3ZSBjYW4gYWRqdXN0IGlmIG5lZWRlZCBhZnRlciBnZXR0aW5nIGFjdHVhbCB1c2FnZSBiZWhpbmRcbiAgICogdXNcIikuIFJlZnVzaW5nIHdoaWxlIGEgYnVmZmVyIGlzIGRpcnR5IHdvdWxkIGxldCBhbiBvcGVuIGRvY3VtZW50IGJsb2NrIHRoZVxuICAgKiBhZ2VudCBpbmRlZmluaXRlbHkuIFRoZSBIVU1BTidzIG93biBwYXRoIG5ldmVyIGNvbWVzIGhlcmU6IHRoZWlyIFwiYWRkXG4gICAqIGZyb250bWF0dGVyXCIgaXMgYW4gZWRpdCB0byB0aGVpciBidWZmZXIsIHdoaWNoIFNhdmUgd3JpdGVzIGxpa2UgYW55IG90aGVyLlxuICAgKi9cbiAgbWV0YUluaXQocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IHR5cGU/OiBzdHJpbmc7IGJ5Pzogc3RyaW5nIH0gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBzdWdnZXN0ZWQgPSB0aGlzLnN1Z2dlc3RNZXRhKHJhd1BhdGgsIG9wdHMuYnkpO1xuICAgIGNvbnN0IGFicyA9IHN1Z2dlc3RlZC5wYXRoO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgY29uc3QgYmxvY2sgPSBvcHRzLnR5cGVcbiAgICAgID8gYnVpbGRCbG9jayh7XG4gICAgICAgICAgdHlwZTogb3B0cy50eXBlLFxuICAgICAgICAgIC4uLih0aXRsZUZyb21Cb2R5KHRleHQpID8geyB0aXRsZTogdGl0bGVGcm9tQm9keSh0ZXh0KSBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgICAuLi4ob3B0cy5ieSA/IHsgYnk6IG9wdHMuYnkgfSA6IHt9KSxcbiAgICAgICAgfSlcbiAgICAgIDogc3VnZ2VzdGVkLmJsb2NrO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB3aXRoQmxvY2sodGV4dCwgYmxvY2spKTtcbiAgICB0aGlzLm1ldGFDYWNoZS5kZWxldGUoYWJzKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMsIHR5cGU6IG9wdHMudHlwZSA/PyBzdWdnZXN0ZWQudHlwZSA/PyBudWxsLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIFNldCBrZXlzIGluIGFuIGV4aXN0aW5nIGJsb2NrIOKAlCBhIExJTkUgZWRpdCBlYWNoLCBzbyBub3RoaW5nIGVsc2UgbW92ZXMuICovXG4gIG1ldGFTZXQocmF3UGF0aDogc3RyaW5nLCBwYWlyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICBsZXQgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBpZiAoc3BsaXRGcm9udG1hdHRlcih0ZXh0KS5yYXcgPT09IG51bGwpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Jhc2VuYW1lKGFicyl9IGhhcyBubyBmcm9udG1hdHRlciDigJQgYWRkIGl0IGZpcnN0IChtZXRhLWluaXQpYCwgNDA5KTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwYWlycykpIHtcbiAgICAgIGlmICghL15bQS1aYS16X11bQS1aYS16MC05Xy4tXSokLy50ZXN0KGtleSkpXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYFwiJHtrZXl9XCIgaXMgbm90IGEgZnJvbnRtYXR0ZXIga2V5YCwgNDAwKTtcbiAgICAgIHRleHQgPSBzZXRLZXkodGV4dCwga2V5LCB2YWx1ZSk7XG4gICAgfVxuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB0ZXh0KTtcbiAgICB0aGlzLm1ldGFDYWNoZS5kZWxldGUoYWJzKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMsIHNldDogT2JqZWN0LmtleXMocGFpcnMpIH07XG4gIH1cblxuICAvKiogVGhlIHNlc3Npb24ncyBoYWxmIG9mIGBQdWJsaWNTdGF0ZWA7IHRoZSBkYWVtb24gYWRkcyB0aGUgaG9tZS1sZXZlbCBgcHJlZnNgIGFuZCBgdXNlckhvbWVgLiAqL1xuICAvKipcbiAgICogVGhlIGNvbnZlcnNhdGlvbiwgd2l0aG91dCBidWlsZGluZyBhIHNuYXBzaG90IGFyb3VuZCBpdC5cbiAgICpcbiAgICog4pqgIEU1MydzIGF0dGVudGlvbiB0aWNrIHJ1bnMgZXZlcnkgc2Vjb25kIGFuZCBvbmx5IG5lZWRzIHRoZSBjaGF0OyBjYWxsaW5nXG4gICAqIGB2aWV3KClgIGZvciBpdCB3b3VsZCByZS1yZWFkIGV2ZXJ5IGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgb24gYSB0aW1lci5cbiAgICovXG4gIG1lc3NhZ2VzKCk6IHJlYWRvbmx5IENoYXRNZXNzYWdlW10ge1xuICAgIHJldHVybiB0aGlzLm0uY2hhdDtcbiAgfVxuXG4gIHZpZXcoXG4gICAgbW9kZTogXCJkZXZcIiB8IFwicmVsZWFzZVwiLFxuICAgIHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCxcbiAgICAvLyDimqAgYHdhaXRpbmdgIGlzIHRoZSBTRVJWRVIncyB0byBhZGQgKEU1Myk6IGl0IGRlcGVuZHMgb24gdGhlIGNsb2NrIGFuZCBvblxuICAgIC8vIHRoZSBzbm9vemUgdGhlIHNlcnZlciBob2xkcywgbmVpdGhlciBvZiB3aGljaCBiZWxvbmdzIGluIHRoZSBzZXNzaW9uLlxuICAgIC8vIOKaoCBgd2FpdGluZ2AgYW5kIGBoaXN0b3J5YCBhcmUgdGhlIFNFUlZFUidzIHRvIGFkZCAoRTUzLCBFNjApOiBvbmUgZGVwZW5kc1xuICAgIC8vIG9uIHRoZSBjbG9jayBhbmQgdGhlIHNub296ZSBpdCBob2xkcywgdGhlIG90aGVyIG9uIHRoZSBpbi1tZW1vcnkgYWN0XG4gICAgLy8gc3RhY2tzLiBOZWl0aGVyIGJlbG9uZ3MgaW4gdGhlIHNlc3Npb24ncyBwZXJzaXN0ZWQgc3RhdGUuIEU2NSdzXG4gICAgLy8gYG5vdGVzV2FpdGluZ2AgaXMgdGhlIHNlcnZlcidzIGZvciBgd2FpdGluZ2AncyByZWFzb25zLlxuICApOiBPbWl0PFB1YmxpY1N0YXRlLCBcInByZWZzXCIgfCBcInVzZXJIb21lXCIgfCBcIndhaXRpbmdcIiB8IFwibm90ZXNXYWl0aW5nXCIgfCBcImhpc3RvcnlcIj4ge1xuICAgIGNvbnN0IG1ldGEgPSB0aGlzLmNvbnRleHRNZXRhKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy53b3Jrc3BhY2UsXG4gICAgICBkb2NNZXRhOiBtZXRhLm1hcCxcbiAgICAgIC4uLihtZXRhLnRydW5jYXRlZCA/IHsgZG9jTWV0YVRydW5jYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgbW9kZSxcbiAgICAgIGNvbnRleHQ6IHRoaXMubS5jb250ZXh0LFxuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiB0aGlzLmRvY1ZpZXcoZCkpLFxuICAgICAgb3BlbkRvYzogdGhpcy5tLm9wZW5Eb2MsXG4gICAgICBzZWxlY3Rpb24sXG4gICAgICBjaGF0OiB0aGlzLm0uY2hhdCxcbiAgICAgIHRhc2tzOiB0aGlzLnRhc2tzKCksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBnaXQgd29ya2luZyB0cmVlIGBkaXJgIGlzIGluLCBvciBudWxsLiBBIGAuZ2l0YCBFTlRSWSwgbm90IGEgZGlyZWN0b3J5XG4gKiB0ZXN0OiBhIHdvcmt0cmVlIGFuZCBhIHN1Ym1vZHVsZSBib3RoIGhhdmUgYC5naXRgIGFzIGEgRklMRS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdpdFJvb3RPZihkaXI6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBsZXQgYXQgPSBkaXI7XG4gIGZvciAoOzspIHtcbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKGF0LCBcIi5naXRcIikpKSByZXR1cm4gYXQ7XG4gICAgY29uc3QgdXAgPSBkaXJuYW1lKGF0KTtcbiAgICBpZiAodXAgPT09IGF0KSByZXR1cm4gbnVsbDtcbiAgICBhdCA9IHVwO1xuICB9XG59XG5cbi8qKiBEb2N1bWVudHMgdW5kZXIgYSBmb2xkZXIsIGZvciBzYXlpbmcgaG93IG11Y2ggYSBtb3ZlIG1vdmVzLiAqL1xuZnVuY3Rpb24gY291bnREb2NzKGRpcjogc3RyaW5nKTogbnVtYmVyIHtcbiAgbGV0IG4gPSAwO1xuICBjb25zdCB3YWxrID0gKGF0OiBzdHJpbmcpID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGF0KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGF0LCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHdhbGsoYWJzKTtcbiAgICAgIGVsc2UgaWYgKGlzRG9jTmFtZShuYW1lKSkgbisrO1xuICAgIH1cbiAgfTtcbiAgd2FsayhkaXIpO1xuICByZXR1cm4gbjtcbn1cblxuLyoqXG4gKiBIb3cgYSBjb21wYXJpc29uIHNpZGUgcmVhZHMgaW4gYSBtZXNzYWdlIHRvIGEgaHVtYW4gb3IgYW4gYWdlbnQuXG4gKlxuICog4puUIFRIRSBGSUxFIElTIE5BTUVELCBOT1QgREVTQ1JJQkVEIChFNDMsIHJldmlzZWQpLiBcIlRoZSBvcmlnaW5hbFwiIHNvdW5kZWRcbiAqIHRlbXBvcmFsIHdoZW4gdGhlIHRoaW5nIGlzIGxvY2F0aW9uYWw7IFwidGhlIHNhdmVkIGZpbGVcIiBmaXhlZCB0aGF0IGJ1dCByZWFkc1xuICogY2lyY3VsYXIgdGhlIG1vbWVudCBpdCBpcyBhIERFU1RJTkFUSU9OIOKAlCBcInNhdmUgdG8gdGhlIHNhdmVkIGZpbGVcIiBzYXlzXG4gKiBub3RoaW5nLiBObyBub3VuIGVuY2Fwc3VsYXRlcyBcInRoaXMgZmlsZSwgYXQgdGhpcyBwbGFjZVwiLCBzbyB0aGUgZmlsZSBnZXRzXG4gKiBpdHMgb3duIG5hbWU6IGBub3RlLm1kYC4gQ29sZTogXCJ0aGF0J3MgcHJvYmFibHkgY2xvc2VyIHRvIHRoZSByaWdodCBhbnN3ZXJcbiAqIHZlcnN1cyB0cnlpbmcgdG8gY29tZSB1cCB3aXRoIGEgd29yZCB0aGF0IGVuY2Fwc3VsYXRlcyBpdC5cIlxuICpcbiAqIGBmaWxlYCBpcyB0aGUgZG9jdW1lbnQncyBuYW1lIHdoZW4gdGhlIGNhbGxlciBrbm93cyBpdDsgd2l0aG91dCBvbmUgdGhpc1xuICogZmFsbHMgYmFjayB0byBhIGdlbmVyaWMsIHdoaWNoIGlzIG9ubHkgZm9yIGNvbnRleHRzIHRoYXQgaGF2ZSBubyBkb2N1bWVudCBpblxuICogaGFuZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpZGVOYW1lKHNpZGU6IERpZmZTaWRlLCBmaWxlPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHNpZGUgIT09IFwib3JpZ2luYWxcIikgcmV0dXJuIGB2JHtzaWRlfWA7XG4gIHJldHVybiBmaWxlID8/IFwidGhlIHNhdmVkIGZpbGVcIjtcbn1cbiIsCiAgICAiLyoqXG4gKiBPS0YgZnJvbnRtYXR0ZXIsIHJlYWQgKEUzMikuIFRoZSBkYWVtb24gcGFyc2VzOyB0aGUgc3VyZmFjZSByZW5kZXJzIHdoYXQgaXRcbiAqIGlzIGdpdmVuIOKAlCBgQnVuLllBTUwucGFyc2VgIGlzIGhlcmUsIHNvIG5vIFlBTUwgcGFyc2VyIHJlYWNoZXMgdGhlIGJyb3dzZXIuXG4gKlxuICog4puUIFRIRSBTUEVDJ1MgVEVNUEVSIElTIFRIRSBQT0lOVCwgQU5EIElUIElTIE5PVCBUSEUgVVNVQUwgT05FLiBBIGNvbnN1bWVyXG4gKiBcIk1VU1QgTk9UIHJlamVjdCBkb2N1bWVudHNcIiBmb3IgdW5rbm93biB0eXBlcywgdW5rbm93biBrZXlzLCBtaXNzaW5nIG9wdGlvbmFsXG4gKiBmaWVsZHMgb3IgYnJva2VuIGxpbmtzLCBhbmQgXCJTSE9VTEQgcHJlc2VydmUgdW5rbm93biBrZXlzIHdoZW4gcm91bmQtdHJpcHBpbmdcIlxuICogKE9LRiAwLjIgwqcxMSkuIFNvIG5vdGhpbmcgaGVyZSB2YWxpZGF0ZXM6IGEgZG9jdW1lbnQgd2hvc2UgZnJvbnRtYXR0ZXIgd2lsbFxuICogbm90IHBhcnNlIGtlZXBzIGl0cyB0ZXh0IGFuZCByZXBvcnRzIHRoZSByZWFzb24sIGV2ZXJ5IGtleSBzdXJ2aXZlcyBpblxuICogYGZpZWxkc2Agd2hldGhlciBvciBub3QgdGhpcyBzcGVsbCBoYXMgaGVhcmQgb2YgaXQsIGFuZCBgdHlwZWAg4oCUIHRoZSBPTkVcbiAqIHJlcXVpcmVkIGZpZWxkIOKAlCBiZWluZyBhYnNlbnQgaXMgYSBmYWN0IHRvIHNob3csIG5ldmVyIGFuIGVycm9yIHRvIHJhaXNlLlxuICpcbiAqIFRoZSBERVJJVkVEIHZhbHVlcyAodHJ1c3QsIHN0YWxlbmVzcykgYXJlIGNvbXB1dGVkIG9uIHJlYWQgYW5kIG5ldmVyIHN0b3JlZCxcbiAqIHdoaWNoIGlzIGFsc28gdGhlIHNwZWMncyBydWxlOiBhIHRydXN0IHRpZXIgd3JpdHRlbiBpbnRvIGEgZmlsZSB3b3VsZCBiZSBhXG4gKiBjbGFpbSBhYm91dCBpdHNlbGYuXG4gKi9cbmltcG9ydCB0eXBlIHsgRG9jTWV0YSwgRG9jU3VtbWFyeSwgVHJ1c3RUaWVyIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2s6IGAtLS1gIG9uIGl0cyBvd24gZmlyc3QgbGluZSwgdG8gdGhlIG5leHQgYC0tLWAgbGluZS4gKi9cbmNvbnN0IEJMT0NLID0gL14tLS1cXHI/XFxuKFtcXHNcXFNdKj8pXFxyP1xcbi0tLVsgXFx0XSooPzpcXHI/XFxufCQpLztcblxuLyoqXG4gKiBTcGxpdCBhIGRvY3VtZW50IGludG8gaXRzIHJhdyBmcm9udG1hdHRlciBibG9jayBhbmQgdGhlIGJvZHkgYmVuZWF0aCBpdC5cbiAqIFB1cmUgc3RyaW5nIHdvcmssIG5vIFlBTUwg4oCUIHRoZSBTVVJGQUNFIGhhcyB0aGUgc2FtZSBmdW5jdGlvbiAoaXQgbXVzdCBzdHJpcFxuICogdGhlIGJsb2NrIGJlZm9yZSByZW5kZXJpbmcpIGFuZCBgZnJvbnRtYXR0ZXIudGVzdC50c2AgaG9sZHMgdGhlIHR3byBlcXVhbC5cbiAqL1xuLyoqXG4gKiBIb3cgbWFueSBsaW5lcyBvZiBhIGRvY3VtZW50IGNvbWUgQkVGT1JFIGl0cyBib2R5IOKAlCB0aGUgZnJvbnRtYXR0ZXIgYmxvY2sgYW5kXG4gKiBpdHMgZGVsaW1pdGVycy5cbiAqXG4gKiDim5QgV0lUSE9VVCBUSElTIEEgUkVQT1JURUQgTElORSBOVU1CRVIgSVMgQSBMSUUuIExpbmtzIGFyZSBleHRyYWN0ZWQgZnJvbSB0aGVcbiAqIEJPRFksIHNvIGEgbGluayBvbiBib2R5IGxpbmUgOSBvZiBhIGRvY3VtZW50IHdpdGggZm91ciBsaW5lcyBvZiBmcm9udG1hdHRlclxuICogaXMgb24gRklMRSBsaW5lIDEzIOKAlCBhbmQgYSByZXBvcnQgdGhhdCBzYXlzIDkgc2VuZHMgd2hvZXZlciBpcyBmaXhpbmcgaXQgdG9cbiAqIHRoZSB3cm9uZyBwbGFjZSwgY29uZmlkZW50bHkuIENhdWdodCB0aGUgbW9tZW50IEU1NCdzIHJlcG9ydCB3YXMgZmlyc3QgcmVhZFxuICogYWdhaW5zdCBhIGRvY3VtZW50IHRoYXQgaGFkIGZyb250bWF0dGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9keUxpbmVPZmZzZXQodGV4dDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgeyBib2R5IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBjb25zdCBwcmVmaXggPSB0ZXh0LnNsaWNlKDAsIHRleHQubGVuZ3RoIC0gYm9keS5sZW5ndGgpO1xuICBsZXQgbGluZXMgPSAwO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHByZWZpeC5sZW5ndGg7IGkrKykgaWYgKHByZWZpeC5jaGFyQ29kZUF0KGkpID09PSAxMCkgbGluZXMrKztcbiAgcmV0dXJuIGxpbmVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRGcm9udG1hdHRlcih0ZXh0OiBzdHJpbmcpOiB7IHJhdzogc3RyaW5nIHwgbnVsbDsgYm9keTogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gQkxPQ0suZXhlYyh0ZXh0KTtcbiAgaWYgKCFtKSByZXR1cm4geyByYXc6IG51bGwsIGJvZHk6IHRleHQgfTtcbiAgcmV0dXJuIHsgcmF3OiBtWzFdID8/IFwiXCIsIGJvZHk6IHRleHQuc2xpY2UobVswXS5sZW5ndGgpIH07XG59XG5cbi8qKiBPS0YncyB0aHJlZSwgYW5kIGFueXRoaW5nIGVsc2UgYSBwcm9kdWNlciB3cm90ZS4gYHN0YWJsZWAgaXMgdGhlIGRlZmF1bHQuICovXG5mdW5jdGlvbiBzdGF0dXNPZihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgcyA9IGZpZWxkcy5zdGF0dXM7XG4gIHJldHVybiB0eXBlb2YgcyA9PT0gXCJzdHJpbmdcIiAmJiBzLnRyaW0oKSAhPT0gXCJcIiA/IHMgOiBcInN0YWJsZVwiO1xufVxuXG5jb25zdCBhc0xpc3QgPSAodjogdW5rbm93bik6IHN0cmluZ1tdID0+XG4gIEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcigoeCkgPT4gdHlwZW9mIHggPT09IFwic3RyaW5nXCIpIDogdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyBbdl0gOiBbXTtcblxuLyoqIEFuIGFjdG9yIGlzIGh1bWFuIGlmZiBpdCBpcyBzcGVsbGVkIGBodW1hbjo8aWQ+YCDigJQgT0tGIDAuMiDCpzYncyBydWxlLiAqL1xuY29uc3QgaXNIdW1hbiA9IChhY3RvcjogdW5rbm93bik6IGJvb2xlYW4gPT5cbiAgdHlwZW9mIGFjdG9yID09PSBcInN0cmluZ1wiICYmIGFjdG9yLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChcImh1bWFuOlwiKTtcblxuLyoqXG4gKiBPS0YncyB0cnVzdCB0aWVycywgREVSSVZFRDogbm8gYHZlcmlmaWVkYCDihpIgdW52ZXJpZmllZDsgdmVyaWZpZWQgYnkgbWFjaGluZXNcbiAqIG9ubHkg4oaSIG1hY2hpbmUtY29uZmlybWVkOyB2ZXJpZmllZCBieSBhIGBodW1hbjo8aWQ+YCDihpIgaHVtYW4tcmV2aWV3ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cnVzdFRpZXIoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFRydXN0VGllciB7XG4gIGNvbnN0IHZlcmlmaWVkID0gZmllbGRzLnZlcmlmaWVkO1xuICBjb25zdCBldmVudHMgPSBBcnJheS5pc0FycmF5KHZlcmlmaWVkKSA/IHZlcmlmaWVkIDogdmVyaWZpZWQgPyBbdmVyaWZpZWRdIDogW107XG4gIGlmIChldmVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJ1bnZlcmlmaWVkXCI7XG4gIGZvciAoY29uc3QgZSBvZiBldmVudHMpXG4gICAgaWYgKGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgaXNIdW1hbigoZSBhcyB7IGJ5PzogdW5rbm93biB9KS5ieSkpIHJldHVybiBcImh1bWFuLXJldmlld2VkXCI7XG4gIHJldHVybiBcIm1hY2hpbmUtY29uZmlybWVkXCI7XG59XG5cbi8qKiBgc3RhbGVfYWZ0ZXJgIGlzIGFuIElOU1RBTlQsIG5vdCBhIFRUTDogc3RhbGUgd2hlbiBub3cgPj0gaXQuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTdGFsZShmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBub3c6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBhdCA9IGZpZWxkcy5zdGFsZV9hZnRlcjtcbiAgY29uc3QgdCA9XG4gICAgYXQgaW5zdGFuY2VvZiBEYXRlID8gYXQuZ2V0VGltZSgpIDogdHlwZW9mIGF0ID09PSBcInN0cmluZ1wiID8gRGF0ZS5wYXJzZShhdCkgOiBOdW1iZXIuTmFOO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIG5vdyA+PSB0O1xufVxuXG4vKiogV2hlbiB0aGUgY29udGVudCBsYXN0IG1lYW5pbmdmdWxseSBjaGFuZ2VkLCBwZXIgYGdlbmVyYXRlZC5hdGAsIGFzIGFuIElTTyBkYXRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlZEF0KGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZyA9IGZpZWxkcy5nZW5lcmF0ZWQ7XG4gIGNvbnN0IGF0ID0gZyAmJiB0eXBlb2YgZyA9PT0gXCJvYmplY3RcIiA/IChnIGFzIHsgYXQ/OiB1bmtub3duIH0pLmF0IDogdW5kZWZpbmVkO1xuICBpZiAoYXQgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gYXQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGlmICh0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCB0ID0gRGF0ZS5wYXJzZShhdCk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSA/IG5ldyBEYXRlKHQpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApIDogYXQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmNvbnN0IHN0ciA9ICh2OiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpICE9PSBcIlwiID8gdi50cmltKCkgOiB1bmRlZmluZWQ7XG5cbi8qKlxuICogUmVhZCBhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIuIFJldHVybnMgbnVsbCB3aGVuIHRoZXJlIGlzIG5vIGJsb2NrIGF0IGFsbCDigJRcbiAqIHdoaWNoIGlzIGEgbm9ybWFsIGRvY3VtZW50LCBub3QgYSBkZWZlY3QuIEEgYmxvY2sgdGhhdCB3aWxsIG5vdCBwYXJzZSBjb21lc1xuICogYmFjayB3aXRoIGBlcnJvcmAgc2V0IGFuZCBldmVyeSBvdGhlciBmaWVsZCBlbXB0eTogc2FpZCwgbm90IHN3YWxsb3dlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRNZXRhKHRleHQ6IHN0cmluZywgbm93ID0gRGF0ZS5ub3coKSk6IERvY01ldGEgfCBudWxsIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBsZXQgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBsZXQgZXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBCdW4uWUFNTC5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgaWYgKHBhcnNlZCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZCkpXG4gICAgICBmaWVsZHMgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgZWxzZSBpZiAocGFyc2VkICE9PSBudWxsICYmIHBhcnNlZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgZXJyb3IgPSBcInRoZSBmcm9udG1hdHRlciBpcyBub3QgYSBtYXBwaW5nIG9mIGtleXMgdG8gdmFsdWVzXCI7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZS5zcGxpdChcIlxcblwiKVswXSA6IFN0cmluZyhlKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHJhdyxcbiAgICBmaWVsZHMsXG4gICAgdHlwZTogc3RyKGZpZWxkcy50eXBlKSxcbiAgICB0aXRsZTogc3RyKGZpZWxkcy50aXRsZSksXG4gICAgZGVzY3JpcHRpb246IHN0cihmaWVsZHMuZGVzY3JpcHRpb24pLFxuICAgIHN0YXR1czogc3RhdHVzT2YoZmllbGRzKSxcbiAgICB0YWdzOiBhc0xpc3QoZmllbGRzLnRhZ3MpLFxuICAgIGxpZmVjeWNsZTogc3RyKGZpZWxkcy5saWZlY3ljbGUpLFxuICAgIHRydXN0OiB0cnVzdFRpZXIoZmllbGRzKSxcbiAgICBzdGFsZTogaXNTdGFsZShmaWVsZHMsIG5vdyksXG4gICAgZGF0ZTogZ2VuZXJhdGVkQXQoZmllbGRzKSxcbiAgICAuLi4oZXJyb3IgPyB7IGVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBUaGUgc21hbGwgc2hhcGUgdGhlIHNpZGViYXIgbmVlZHMgZm9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXplKG1ldGE6IERvY01ldGEgfCBudWxsKTogRG9jU3VtbWFyeSB8IG51bGwge1xuICBpZiAoIW1ldGEpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIC4uLihtZXRhLnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgIC4uLihtZXRhLnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgIHN0YXR1czogbWV0YS5zdGF0dXMsXG4gICAgdGFnczogbWV0YS50YWdzLFxuICAgIHRydXN0OiBtZXRhLnRydXN0LFxuICAgIHN0YWxlOiBtZXRhLnN0YWxlLFxuICAgIC4uLihtZXRhLmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgIC4uLihtZXRhLmVycm9yID8geyBlcnJvcjogbWV0YS5lcnJvciB9IDoge30pLFxuICB9O1xufVxuXG4vKiogcGRvY3MncyBmaWx0ZXIgdm9jYWJ1bGFyeSwgc28gd2hhdCB0aGUgaHVtYW4gbGVhcm5zIHRoZXJlIGhvbGRzIGhlcmUuICovXG5leHBvcnQgdHlwZSBNZXRhRmlsdGVyID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGxpZmVjeWNsZT86IHN0cmluZztcbiAgdGFnPzogc3RyaW5nO1xuICAvKiogQW4gSVNPIGRhdGU7IG1hdGNoZXMgZG9jdW1lbnRzIHdob3NlIGBnZW5lcmF0ZWQuYXRgIGlzIG9uIG9yIGFmdGVyIGl0LiAqL1xuICBzaW5jZT86IHN0cmluZztcbn07XG5cbi8qKlxuICogRmlsdGVycyBhcmUgQU5EZWQsIGFuZCBldmVyeSBvbmUgaXMgb3B0aW9uYWwg4oCUIGEgYmFyZSBmaWx0ZXIgbWF0Y2hlcyBhbGwuXG4gKlxuICog4puUIEEgRE9DVU1FTlQgV0lUSCBOTyBGUk9OVE1BVFRFUiBNQVRDSEVTIE9OTFkgVEhFIEVNUFRZIEZJTFRFUiwgYW5kIHRoYXRcbiAqIGluY2x1ZGVzIGAtLXN0YXR1cyBzdGFibGVgLiBBYnNlbnQgYHN0YXR1c2AgZGVmYXVsdHMgdG8gYHN0YWJsZWAgZm9yIGFuIE9LRlxuICogZG9jdW1lbnQgKMKnNSksIGJ1dCBhIGRvY3VtZW50IHdpdGggbm8gYmxvY2sgYXQgYWxsIGlzIG5vdCBtYWtpbmcgdGhlIGNsYWltOlxuICogYGZpbmQgLS1zdGF0dXMgc3RhYmxlYCBhc2tzIHdoaWNoIGRvY3VtZW50cyBTQVkgdGhleSBhcmUgc3RhYmxlLCBhbmQgYSBmaWxlXG4gKiB3aXRoIG5vIGZyb250bWF0dGVyIHNheXMgbm90aGluZy4gUmVhZGluZyB0aGUgZGVmYXVsdCB0aGUgb3RoZXIgd2F5IHdvdWxkIHB1dFxuICogZXZlcnkgdW50b3VjaGVkIG5vdGUgaW4gdGhlIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hdGNoZXNGaWx0ZXIobWV0YTogRG9jTWV0YSB8IG51bGwsIGZpbHRlcjogTWV0YUZpbHRlcik6IGJvb2xlYW4ge1xuICBpZiAobWV0YSA9PT0gbnVsbCkgcmV0dXJuIE9iamVjdC52YWx1ZXMoZmlsdGVyKS5ldmVyeSgodikgPT4gdiA9PT0gdW5kZWZpbmVkKTtcbiAgaWYgKGZpbHRlci50eXBlICE9PSB1bmRlZmluZWQgJiYgbWV0YS50eXBlICE9PSBmaWx0ZXIudHlwZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnN0YXR1cyAhPT0gdW5kZWZpbmVkICYmIG1ldGEuc3RhdHVzICE9PSBmaWx0ZXIuc3RhdHVzKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIubGlmZWN5Y2xlICE9PSB1bmRlZmluZWQgJiYgbWV0YS5saWZlY3ljbGUgIT09IGZpbHRlci5saWZlY3ljbGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci50YWcgIT09IHVuZGVmaW5lZCAmJiAhbWV0YS50YWdzLmluY2x1ZGVzKGZpbHRlci50YWcpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc2luY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghbWV0YS5kYXRlKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG1ldGEuZGF0ZSA8IGZpbHRlci5zaW5jZSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyDilIDilIAgV1JJVElORyAoRTM1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyDim5QgRVZFUlkgV1JJVEUgSEVSRSBJUyBBIFRFWFQgRURJVCwgTkVWRVIgQSBSRVNFUklBTElTQVRJT04uIFBhcnNpbmcgYSBibG9ja1xuLy8gYW5kIHByaW50aW5nIGl0IGJhY2sgcmVvcmRlcnMga2V5cywgZHJvcHMgY29tbWVudHMgYW5kIGNoYW5nZXMgcXVvdGluZyDigJQgYW5kXG4vLyB0aGUgc3BlYyBhc2tzIGEgY29uc3VtZXIgdG8gXCJwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4vLyAowqcxMSksIHdoaWNoIGlzIHByZWNpc2VseSB3aGF0IHRoYXQgbG9zZXMuIFNvIGEgbmV3IGJsb2NrIGlzIEJVSUxUICh0aGVyZSBpc1xuLy8gbm90aGluZyB0byBwcmVzZXJ2ZSB5ZXQpIGFuZCBhbiBleGlzdGluZyBvbmUgaXMgZWRpdGVkIGEgTElORSBhdCBhIHRpbWUuXG5cbi8qKiBUaGUgZG9jdW1lbnQncyBmaXJzdCBIMSwgd2hpY2ggaXMgdGhlIHRpdGxlIGEgaHVtYW4gYWxyZWFkeSB3cm90ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aXRsZUZyb21Cb2R5KGJvZHk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IC9eI1xccysoLis/KVxccyokLy5leGVjKGxpbmUpO1xuICAgIGlmIChtKSByZXR1cm4gbVsxXTtcbiAgICBpZiAobGluZS50cmltKCkgIT09IFwiXCIgJiYgIWxpbmUuc3RhcnRzV2l0aChcIiNcIikpIGJyZWFrOyAvLyBwcm9zZSBiZWZvcmUgYW55IGhlYWRpbmdcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEEgYHR5cGVgIHRvIFNVR0dFU1QgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS5cbiAqXG4gKiDim5QgRlJPTSBUSEUgTkVJR0hCT1VSUywgTkVWRVIgRlJPTSBBIEZJWEVEIExJU1QuIE9LRidzIGB0eXBlYCBpcyBcIm5vdFxuICogY2VudHJhbGx5IHJlZ2lzdGVyZWRcIiBhbmQgZXZlcnkgY29ycHVzIGludmVudHMgaXRzIG93biDigJQgYHJlcG9ydGAsIGBydWxlYCxcbiAqIGBhcmNoZXR5cGVgIGluIG9uZSwgc29tZXRoaW5nIGVsc2UgaW4gdGhlIG5leHQg4oCUIHNvIHRoZSBvbmx5IGhvbmVzdCBzb3VyY2UgaXNcbiAqIHdoYXQgdGhlIGRvY3VtZW50cyBiZXNpZGUgdGhpcyBvbmUgYWxyZWFkeSBzYXkuIFRoZSBmb2xkZXIncyBuYW1lIGlzIHRoZVxuICogZmFsbGJhY2ssIGFuZCB3aGVuIG5laXRoZXIgYW5zd2Vycywgbm90aGluZyBpcyBzdWdnZXN0ZWQ6IGEgYmxhbmsgdGhlIGh1bWFuXG4gKiBmaWxscyBiZWF0cyBhIHBsYXVzaWJsZSBndWVzcyAoU0NIRU1BLm1kJ3Mgb3duIHJ1bGUgYWJvdXQgYGdlbmVyYXRlZC5ieWApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3Vlc3NUeXBlKHNpYmxpbmdUeXBlczogcmVhZG9ubHkgc3RyaW5nW10sIGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB0IG9mIHNpYmxpbmdUeXBlcykgaWYgKHQpIGNvdW50cy5zZXQodCwgKGNvdW50cy5nZXQodCkgPz8gMCkgKyAxKTtcbiAgY29uc3QgYmVzdCA9IFsuLi5jb3VudHMuZW50cmllcygpXS5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSB8fCBhWzBdLmxvY2FsZUNvbXBhcmUoYlswXSkpWzBdO1xuICBpZiAoYmVzdCkgcmV0dXJuIGJlc3RbMF07XG4gIGNvbnN0IG5hbWUgPSBmb2xkZXIudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuYW1lID09PSBcIlwiIHx8IG5hbWUgPT09IFwiLlwiIHx8IG5hbWUgPT09IFwiL1wiKSByZXR1cm4gdW5kZWZpbmVkO1xuICAvLyBgZGVjaXNpb25zL2Ag4oaSIGBkZWNpc2lvbmA7IGBkb2NzL2Ag4oaSIGBkb2NgLiBBIHBsdXJhbCBmb2xkZXIgbmFtZXMgaXRzIGtpbmQuXG4gIHJldHVybiBuYW1lLmVuZHNXaXRoKFwiaWVzXCIpXG4gICAgPyBgJHtuYW1lLnNsaWNlKDAsIC0zKX15YFxuICAgIDogbmFtZS5lbmRzV2l0aChcInNcIilcbiAgICAgID8gbmFtZS5zbGljZSgwLCAtMSlcbiAgICAgIDogbmFtZTtcbn1cblxuLyoqIEEgWUFNTCBzY2FsYXIsIHF1b3RlZCBvbmx5IHdoZW4gaXQgbXVzdCBiZS4gKi9cbmZ1bmN0aW9uIHNjYWxhcih2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW1xcdyAuLCcnL0ArLV0qJC8udGVzdCh2YWx1ZSkgJiYgIS9eXFxzfFxccyQvLnRlc3QodmFsdWUpICYmIHZhbHVlICE9PSBcIlwiXG4gICAgPyB2YWx1ZVxuICAgIDogSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xufVxuXG5leHBvcnQgdHlwZSBOZXdNZXRhID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICAvKiogYGdlbmVyYXRlZC5ieWAg4oCUIHRoZSBhY3RvciwgcmVjb3JkZWQgaG9uZXN0bHkgb3IgbGVmdCBgdW5rbm93bmAuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBhdD86IHN0cmluZztcbn07XG5cbi8qKlxuICogQSBmcm9udG1hdHRlciBibG9jayBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLiBPS0YncyByZWNvbW1lbmRlZCBzZXQgaW5cbiAqIHRoZSBvcmRlciB0aGUgY29ycG9yYSB3cml0ZSBpdCwgd2l0aCBgZGVzY3JpcHRpb25gIGxlZnQgRU1QVFkgZm9yIHRoZSBhdXRob3I6XG4gKiBhIG9uZS1saW5lIHN1bW1hcnkgbm9ib2R5IHdyb3RlIGlzIHdvcnNlIHRoYW4gYSBibGFuayB0aGF0IGFza3MgdG8gYmUgZmlsbGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCbG9jayhtZXRhOiBOZXdNZXRhKTogc3RyaW5nIHtcbiAgY29uc3QgYXQgPSBtZXRhLmF0ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGB0eXBlOiAke3NjYWxhcihtZXRhLnR5cGUgPz8gXCJcIil9YCxcbiAgICBgdGl0bGU6ICR7c2NhbGFyKG1ldGEudGl0bGUgPz8gXCJcIil9YCxcbiAgICBgZGVzY3JpcHRpb246ICR7bWV0YS5kZXNjcmlwdGlvbiA/IHNjYWxhcihtZXRhLmRlc2NyaXB0aW9uKSA6IFwiXCJ9YCxcbiAgICBgdGFnczogWyR7KG1ldGEudGFncyA/PyBbXSkubWFwKHNjYWxhcikuam9pbihcIiwgXCIpfV1gLFxuICAgIGBzdGF0dXM6ICR7c2NhbGFyKG1ldGEuc3RhdHVzID8/IFwiZHJhZnRcIil9YCxcbiAgICBgZ2VuZXJhdGVkOiB7IGJ5OiAke3NjYWxhcihtZXRhLmJ5ID8/IFwidW5rbm93blwiKX0sIGF0OiAke2F0fSB9YCxcbiAgXTtcbiAgcmV0dXJuIGAtLS1cXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9XFxuLS0tXFxuYDtcbn1cblxuLyoqXG4gKiBQdXQgYSBuZXcgYmxvY2sgYXQgdGhlIHRvcCBvZiBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE5vIGJsYW5rIGxpbmUgaXNcbiAqIGluc2VydGVkOiB0aGUgY29ycG9yYSB3cml0ZSB0aGUgYm9keSBkaXJlY3RseSB1bmRlciB0aGUgY2xvc2luZyBgLS0tYCwgYW5kIGFcbiAqIGJsb2NrIHRoYXQgYWRkcyBvbmUgd291bGQgc2hvdyBhcyBhIGRpZmYgb24gZXZlcnkgZG9jdW1lbnQgaXQgdG91Y2hlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhCbG9jayh0ZXh0OiBzdHJpbmcsIGJsb2NrOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YmxvY2t9JHt0ZXh0fWA7XG59XG5cbi8qKlxuICogU2V0IG9uZSBrZXkgaW4gYW4gRVhJU1RJTkcgYmxvY2ssIGFzIGEgbGluZSBlZGl0OiB0aGUga2V5J3MgbGluZSBpcyByZXBsYWNlZFxuICogd2hlcmUgaXQgZXhpc3RzIGFuZCBhcHBlbmRlZCBiZWZvcmUgdGhlIGNsb3NpbmcgYC0tLWAgd2hlcmUgaXQgZG9lcyBub3QuXG4gKiBFdmVyeXRoaW5nIGVsc2Ug4oCUIG9yZGVyLCBjb21tZW50cywgc3BhY2luZywga2V5cyB0aGlzIHNwZWxsIG5ldmVyIGhlYXJkIG9mIOKAlFxuICogc3Vydml2ZXMgYnl0ZSBmb3IgYnl0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEtleSh0ZXh0OiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihcInRoaXMgZG9jdW1lbnQgaGFzIG5vIGZyb250bWF0dGVyIGJsb2NrXCIpO1xuICBjb25zdCBsaW5lID0gYCR7a2V5fTogJHtzY2FsYXIodmFsdWUpfWA7XG4gIGNvbnN0IGtleUxpbmUgPSBuZXcgUmVnRXhwKGBeJHtrZXkucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpfVxcXFxzKjpgKTtcbiAgY29uc3QgbGluZXMgPSByYXcuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGF0ID0gbGluZXMuZmluZEluZGV4KChsKSA9PiBrZXlMaW5lLnRlc3QobCkpO1xuICBpZiAoYXQgPT09IC0xKSBsaW5lcy5wdXNoKGxpbmUpO1xuICBlbHNlIHtcbiAgICAvLyBBIG11bHRpLWxpbmUgdmFsdWUgKGEgZm9sZGVkIGRlc2NyaXB0aW9uLCBhIG5lc3RlZCBtYXBwaW5nKSBpcyB0aGVcbiAgICAvLyBrZXkncyBsaW5lIFBMVVMgZXZlcnkgaW5kZW50ZWQgbGluZSB1bmRlciBpdDsgYWxsIG9mIHRoZW0gZ28uXG4gICAgbGV0IGVuZCA9IGF0ICsgMTtcbiAgICB3aGlsZSAoZW5kIDwgbGluZXMubGVuZ3RoICYmIC9eXFxzK1xcUy8udGVzdChsaW5lc1tlbmRdID8/IFwiXCIpKSBlbmQrKztcbiAgICBsaW5lcy5zcGxpY2UoYXQsIGVuZCAtIGF0LCBsaW5lKTtcbiAgfVxuICBjb25zdCByZWJ1aWx0ID0gbGluZXMuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShyYXcsIHJlYnVpbHQpO1xufVxuIiwKICAgICIvKipcbiAqIExpbmtzIGJldHdlZW4gZG9jdW1lbnRzIChFMzMpOiB3aGF0IGEgZG9jdW1lbnQgcG9pbnRzIGF0LCBhbmQgd2hhdCB0aGF0XG4gKiByZXNvbHZlcyB0byBpbnNpZGUgYSBzZXQuXG4gKlxuICog4pSA4pSAIEZPVVIgU09VUkNFUyBPRiBFREdFUywgQU5EIFRIRVkgQVJFIE5PVCBPTkUgS0lORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAgIDEuIG1hcmtkb3duIGxpbmtzICAgICAgYFtsYWJlbF0oLi9vdGhlci5tZClgICAgICAg4oCUIGJvZHlcbiAqICAgMi4gd2lraSBsaW5rcyAgICAgICAgICBgW1tvdGhlci1kb2N8bGFiZWxdXWAgICAgICDigJQgYm9keVxuICogICAzLiBmcm9udG1hdHRlciB2YWx1ZXMgIGByZWxhdGVkOiBbY29uY2VwdC94XWAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqICAgNC4gYHNvdXJjZXNbXS5yZXNvdXJjZWAgICAgICAgICAgICAgICAgICAgICAgICAgICDigJQgYXV0aG9yZWQgaW50ZW50XG4gKlxuICogcGRvY3Mga2VlcHMgdGhlIGZyb250bWF0dGVyIGVkZ2UgYW5kIHRoZSBib2R5LWxpbmsgZWRnZSBBUEFSVCAoYHJlbGF0ZWRbXWBcbiAqIGFuZCBgbGlua3NbXWAgaW4gaXRzIGBiYWNrbGlua3NgIG91dHB1dCksIGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogYVxuICogYHJlbGF0ZWRgIGtleSBpcyBhIGNsYWltIHRoZSBhdXRob3IgbWFkZSBhYm91dCB0aGUgZG9jdW1lbnQgYXMgYSB3aG9sZSwgYVxuICogYm9keSBsaW5rIGlzIGEgY2l0YXRpb24gYXQgYSBwbGFjZSBpbiB0aGUgcHJvc2UuIFRoZXkgc3RheSBhcGFydCBoZXJlIHRvby5cbiAqXG4gKiDilIDilIAgVFlQRUQgTElOS1MgKE9wZXJhdG9yJ3Mgc2hhcGUsIENvbGUgMjAyNi0wOS0xMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQSByZWxhdGlvbiByaWRlcyB0aGUgbGluayBhcyBhIHF1ZXJ5OiBgW2xhYmVsXSguL290aGVyLm1kP3JlbD1leHRlbmRzKWAsXG4gKiBgW1tvdGhlcj9yZWw9c3VwZXJzZWRlc3xsYWJlbF1dYC4gQ29waWVkIGV4YWN0bHkgZnJvbSBPcGVyYXRvcidzIHBhcnNlclxuICogKGBwYWNrYWdlcy9zaGFyZWQvc3JjL2xpbmtzL2ApOiBvbmUgbGluayBjYXJyaWVzIEFMTCBvZiBpdHMgcmVscywgdGhleSBhcmVcbiAqIG5vcm1hbGlzZWQgKGxvd2VyY2FzZWQsIHRyaW1tZWQsIGRlZHVwZWQsIGZpcnN0LWF1dGhvcmVkIG9yZGVyIGtlcHQpIGJ1dFxuICogdGhlaXIgU1BFTExJTkcgaXMgbm90IGNhbm9uaWNhbGlzZWQsIGFuZCAqKmEgYmFyZSBsaW5rIGlzIGBbXWAg4oCUIHRoZSBBQlNFTkNFXG4gKiBvZiBhbiBhc3NlcnRpb24sIG5vdCBhbiBpbXBsaWNpdCBgcmVmZXJlbmNlc2AqKi4gQSBncmFwaCBtdXN0IG5vdCBkcmF3IGFcbiAqIGNsYWltIG5vYm9keSBtYWRlLlxuICpcbiAqIOKUgOKUgCBXSEFUIEEgQlVORExFIElTIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIE9LRidzIGJ1bmRsZS1yZWxhdGl2ZSBmb3JtIChgL2NvbmNlcHRzL3gubWRgKSBtZWFucyB0aGUgQlVORExFIHJvb3QsIG5vdCB0aGVcbiAqIGZpbGVzeXN0ZW0gcm9vdCwgc28gYSByZXNvbHZlciBuZWVkcyBhIGJ1bmRsZSBiZWZvcmUgaXQgY2FuIHJlc29sdmUgYW55dGhpbmc6XG4gKiAqKmEgc2V0J3MgZW50cnkgcm9vdCBpcyB0aGUgYnVuZGxlKiogKEUzMykuIEEgdGFyZ2V0IHRoYXQgZXNjYXBlcyBpdCBpcyBub3QgYW5cbiAqIGVycm9yIOKAlCB0aGUgc3BlYyByZXF1aXJlcyB0b2xlcmF0aW5nIGJyb2tlbiBsaW5rcyDigJQgaXQgaXMgYW4gZWRnZSBtYXJrZWRcbiAqIGBvdXRzaWRlYCBvciBgbWlzc2luZ2AsIHdoaWNoIHRoZSBzdXJmYWNlIG9mZmVycyB0byBhZGQgcmF0aGVyIHRoYW4gZm9sbG93LlxuICovXG5pbXBvcnQge1xuICBiYXNlbmFtZSxcbiAgZGlybmFtZSxcbiAgZXh0bmFtZSxcbiAgam9pbixcbiAgbm9ybWFsaXplLFxuICByZWxhdGl2ZSxcbiAgcmVzb2x2ZSBhcyByZXNvbHZlUGF0aCxcbn0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHRvUG9zaXggfSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCB0eXBlIExpbmtLaW5kID0gXCJtYXJrZG93blwiIHwgXCJ3aWtpXCI7XG5cbi8qKiBPbmUgbGluayBhcyB3cml0dGVuLCBiZWZvcmUgYW55dGhpbmcgaXMgcmVzb2x2ZWQuICovXG5leHBvcnQgdHlwZSBMaW5rUmVmID0ge1xuICBraW5kOiBMaW5rS2luZDtcbiAgLyoqIFRoZSB0YXJnZXQgYXMgYXV0aG9yZWQsIHdpdGggaXRzIHF1ZXJ5IGFuZCBhbmNob3Igc3RyaXBwZWQuICovXG4gIHRhcmdldDogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHRhcmdldCBFWEFDVExZIGFzIHdyaXR0ZW4g4oCUIHF1ZXJ5LCBhbmNob3IsIHBlcmNlbnQtZW5jb2RpbmcgYW5kIGFsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgV0hBVCBNQUtFUyBBIERBTkdMSU5HIExJTksgRklYQUJMRS4gYHRhcmdldGAgaXMgdGhlIHJlc29sdmVkXG4gICAqIHNoYXBlLCBzbyBhIHJlcG9ydCBidWlsdCBmcm9tIGl0IHRlbGxzIHlvdSB0byBsb29rIGZvciBgZGVlcC5tZGAgd2hlbiB0aGVcbiAgICogZG9jdW1lbnQgYWN0dWFsbHkgc2F5cyBgLi9taXNzaW5nL2RlZXAubWQ/cmVsPXhgIOKAlCBhIHN0cmluZyB0aGF0IGlzIG5vdCBpblxuICAgKiB0aGUgZmlsZS4gV2hvZXZlciAob3Igd2hhdGV2ZXIpIGdvZXMgdG8gcmVwYWlyIHRoZSBsaW5rIG5lZWRzIHRoZSBzdHJpbmdcbiAgICogdGhhdCBpcyB0aGVyZS5cbiAgICovXG4gIHJhdzogc3RyaW5nO1xuICAvKiogMS1iYXNlZCBsaW5lIGluIHRoZSBib2R5IHRoZSBsaW5rIHdhcyB3cml0dGVuIG9uLCBmb3IgdGhlIHNhbWUgcmVhc29uLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBSZWxhdGlvbnMgZnJvbSBgP3JlbD1gOyBFTVBUWSBtZWFucyBubyBhc3NlcnRpb24sIG5ldmVyIGByZWZlcmVuY2VzYC4gKi9cbiAgcmVsOiBzdHJpbmdbXTtcbiAgbGFiZWw/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZlcmVuY2UgZm91bmQgaW4gZnJvbnRtYXR0ZXIsIHdpdGggdGhlIGtleSB0aGF0IGNhcnJpZWQgaXQuICovXG5leHBvcnQgdHlwZSBGaWVsZFJlZiA9IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfTtcblxuY29uc3QgRkVOQ0VfTElORSA9IC9eKD86YGBgfH5+fikvO1xuXG4vKipcbiAqIFN0cmlwIGZlbmNlZCBjb2RlIGJsb2Nrcy4gQSBkb2N1bWVudCBhYm91dCBsaW5rcyBxdW90ZXMgbGluayBzeW50YXgsIGFuZCB0aGVcbiAqIHdpa2kgdGhpcyB3YXMgYnVpbHQgYWdhaW5zdCBkb2VzIGV4YWN0bHkgdGhhdCDigJQgd2l0aG91dCB0aGlzLCBTQ0hFTUEubWQnc1xuICogZXhhbXBsZXMgYmVjb21lIGVkZ2VzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aG91dEZlbmNlcyhib2R5OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBmZW5jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IEZFTkNFX0xJTkUuZXhlYyhsaW5lKTtcbiAgICBpZiAoZmVuY2UgPT09IG51bGwgJiYgbSkge1xuICAgICAgZmVuY2UgPSBtWzBdO1xuICAgICAgb3V0LnB1c2goXCJcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZlbmNlICE9PSBudWxsKSB7XG4gICAgICBpZiAobSAmJiBsaW5lLnN0YXJ0c1dpdGgoZmVuY2UpKSBmZW5jZSA9IG51bGw7XG4gICAgICBvdXQucHVzaChcIlwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBvdXQucHVzaChsaW5lKTtcbiAgfVxuICByZXR1cm4gb3V0LmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBgP3JlbD1hLGJgIOKGkiBgW1wiYVwiLFwiYlwiXWAsIG5vcm1hbGlzZWQgdGhlIHdheSBPcGVyYXRvciBub3JtYWxpc2VzIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWwocXVlcnk6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgaWYgKCFxdWVyeSkgcmV0dXJuIFtdO1xuICBjb25zdCBtID0gLyg/Ol58Wz8mXSlyZWw9KFteJl0qKS8uZXhlYyhxdWVyeSk7XG4gIGlmICghbSkgcmV0dXJuIFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgZGVjb2RlVVJJQ29tcG9uZW50KG1bMV0gPz8gXCJcIikuc3BsaXQoXCIsXCIpKSB7XG4gICAgY29uc3QgcmVsID0gcmF3LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChyZWwgPT09IFwiXCIgfHwgc2Vlbi5oYXMocmVsKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQocmVsKTtcbiAgICBvdXQucHVzaChyZWwpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBTcGxpdCBhIHdyaXR0ZW4gdGFyZ2V0IGludG8gaXRzIHBhdGgsIGl0cyBxdWVyeSBhbmQgaXRzIGFuY2hvci4gKi9cbi8qKlxuICogUGVyY2VudC1kZWNvZGluZywgd2hpY2ggYSBtYXJrZG93biBsaW5rIHRhcmdldCBjYXJyaWVzIHdoZW5ldmVyIHRoZSBmaWxlIGl0XG4gKiBuYW1lcyBoYXMgYSBzcGFjZSBpbiBpdCDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWRgIChFNDkpLlxuICpcbiAqIOKblCBJVCBNVVNUIE5PVCBUSFJPVy4gYGRlY29kZVVSSUNvbXBvbmVudGAgcmVqZWN0cyBhIGxvbmUgYCVgLCBhbmQgYSBmaWxlXG4gKiBjYWxsZWQgYDEwMCUgZG9uZS5tZGAgaXMgYSBwZXJmZWN0bHkgb3JkaW5hcnkgdGhpbmcgdG8gbGluayB0by4gQW5cbiAqIHVuZGVjb2RhYmxlIHRhcmdldCBpcyByZXR1cm5lZCBhcyBpdCBzdGFuZHM6IHdvcnN0IGNhc2UgaXQgZmFpbHMgdG8gcmVzb2x2ZSxcbiAqIHdoaWNoIGlzIHRoZSBiZWhhdmlvdXIgYmVmb3JlIGRlY29kaW5nIGV4aXN0ZWQsIHJhdGhlciB0aGFuIHRha2luZyB0aGUgZ3JhcGhcbiAqIGRvd24gd2l0aCBpdC5cbiAqL1xuZnVuY3Rpb24gZGVjb2RlUGF0aChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghcmF3LmluY2x1ZGVzKFwiJVwiKSkgcmV0dXJuIHJhdztcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiByYXc7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0VGFyZ2V0KHJhdzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IHF1ZXJ5Pzogc3RyaW5nOyBhbmNob3I/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGhhc2ggPSByYXcuaW5kZXhPZihcIiNcIik7XG4gIGNvbnN0IHdpdGhvdXRBbmNob3IgPSBoYXNoID09PSAtMSA/IHJhdyA6IHJhdy5zbGljZSgwLCBoYXNoKTtcbiAgY29uc3QgYW5jaG9yID0gaGFzaCA9PT0gLTEgPyB1bmRlZmluZWQgOiByYXcuc2xpY2UoaGFzaCArIDEpO1xuICBjb25zdCBxID0gd2l0aG91dEFuY2hvci5pbmRleE9mKFwiP1wiKTtcbiAgcmV0dXJuIHtcbiAgICBwYXRoOiBkZWNvZGVQYXRoKChxID09PSAtMSA/IHdpdGhvdXRBbmNob3IgOiB3aXRob3V0QW5jaG9yLnNsaWNlKDAsIHEpKS50cmltKCkpLFxuICAgIC4uLihxID09PSAtMSA/IHt9IDogeyBxdWVyeTogd2l0aG91dEFuY2hvci5zbGljZShxICsgMSkgfSksXG4gICAgLi4uKGFuY2hvciA/IHsgYW5jaG9yIH0gOiB7fSksXG4gIH07XG59XG5cbmNvbnN0IEVYVEVSTkFMID0gL15bYS16XVthLXowLTkrLi1dKjovaTtcbmNvbnN0IE1EX0xJTksgPSAvKCE/KVxcWyhbXlxcXVxcbl0qKVxcXVxcKChbXilcXHNdKykoPzpcXHMrXCJbXlwiXSpcIik/XFwpL2c7XG5jb25zdCBXSUtJX0xJTksgPSAvXFxbXFxbKFteXFxdXFxuXSspXFxdXFxdL2c7XG5cbi8qKiBFdmVyeSBsaW5rIGEgZG9jdW1lbnQncyBCT0RZIHBvaW50cyBhdCDigJQgZXh0ZXJuYWwgdGFyZ2V0cyBhbmQgaW1hZ2VzIGxlZnQgb3V0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RMaW5rcyhib2R5OiBzdHJpbmcpOiBMaW5rUmVmW10ge1xuICBjb25zdCB0ZXh0ID0gd2l0aG91dEZlbmNlcyhib2R5KTtcbiAgY29uc3Qgb3V0OiBMaW5rUmVmW10gPSBbXTtcbiAgLy8g4pqgIExJTkUgTlVNQkVSUyBTVVJWSVZFIGB3aXRob3V0RmVuY2VzYCBBTkQgT0ZGU0VUUyBETyBOT1Q6IGl0IGJsYW5rcyBlYWNoXG4gIC8vIGZlbmNlZCBsaW5lIHJhdGhlciB0aGFuIGRlbGV0aW5nIGl0LCBzbyB0aGUgbGluZSBDT1VOVCBpcyBwcmVzZXJ2ZWQgd2hpbGVcbiAgLy8gdGhlIGNoYXJhY3RlciBvZmZzZXRzIGFyZSBub3QuIENvdW50aW5nIG5ld2xpbmVzIGlzIHRoZXJlZm9yZSBzb3VuZDsgdXNpbmdcbiAgLy8gYG0uaW5kZXhgIGFzIGEgY2hhcmFjdGVyIHBvc2l0aW9uIGluIHRoZSBvcmlnaW5hbCBib2R5IHdvdWxkIG5vdCBiZS5cbiAgY29uc3QgbGluZUF0ID0gKGF0OiBudW1iZXIpID0+IHtcbiAgICBsZXQgbGluZSA9IDE7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhdCAmJiBpIDwgdGV4dC5sZW5ndGg7IGkrKykgaWYgKHRleHQuY2hhckNvZGVBdChpKSA9PT0gMTApIGxpbmUrKztcbiAgICByZXR1cm4gbGluZTtcbiAgfTtcbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoTURfTElOSykpIHtcbiAgICBpZiAobVsxXSA9PT0gXCIhXCIpIGNvbnRpbnVlOyAvLyBhbiBpbWFnZSBpcyBub3QgYSBkb2N1bWVudCBsaW5rXG4gICAgY29uc3QgcmF3ID0gbVszXSA/PyBcIlwiO1xuICAgIGlmIChFWFRFUk5BTC50ZXN0KHJhdykgfHwgcmF3LnN0YXJ0c1dpdGgoXCIjXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCB7IHBhdGgsIHF1ZXJ5IH0gPSBzcGxpdFRhcmdldChyYXcpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIm1hcmtkb3duXCIsXG4gICAgICB0YXJnZXQ6IHBhdGgsXG4gICAgICByYXcsXG4gICAgICBsaW5lOiBsaW5lQXQobS5pbmRleCA/PyAwKSxcbiAgICAgIHJlbDogcGFyc2VSZWwocXVlcnkpLFxuICAgICAgLi4uKG1bMl0gPyB7IGxhYmVsOiBtWzJdIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoV0lLSV9MSU5LKSkge1xuICAgIGNvbnN0IGlubmVyID0gbVsxXSA/PyBcIlwiO1xuICAgIGNvbnN0IHBpcGUgPSBpbm5lci5pbmRleE9mKFwifFwiKTtcbiAgICBjb25zdCB0YXJnZXRQYXJ0ID0gcGlwZSA9PT0gLTEgPyBpbm5lciA6IGlubmVyLnNsaWNlKDAsIHBpcGUpO1xuICAgIGNvbnN0IGxhYmVsID0gcGlwZSA9PT0gLTEgPyB1bmRlZmluZWQgOiBpbm5lci5zbGljZShwaXBlICsgMSkudHJpbSgpO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHRhcmdldFBhcnQpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIndpa2lcIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJhdzogdGFyZ2V0UGFydCxcbiAgICAgIGxpbmU6IGxpbmVBdChtLmluZGV4ID8/IDApLFxuICAgICAgcmVsOiBwYXJzZVJlbChxdWVyeSksXG4gICAgICAuLi4obGFiZWwgPyB7IGxhYmVsIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIERvZXMgdGhpcyBmcm9udG1hdHRlciB2YWx1ZSBMT09LIGxpa2UgYSBkb2N1bWVudCByZWZlcmVuY2U/ICovXG5leHBvcnQgZnVuY3Rpb24gbG9va3NMaWtlUmVmKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB2ID0gdmFsdWUudHJpbSgpO1xuICBpZiAodiA9PT0gXCJcIiB8fCBFWFRFUk5BTC50ZXN0KHYpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB2LmluY2x1ZGVzKFwiL1wiKSB8fCB2LnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIubWRcIik7XG59XG5cbi8qKlxuICogUmVmZXJlbmNlcyBpbnNpZGUgZnJvbnRtYXR0ZXIsIHdoYXRldmVyIGtleSBjYXJyaWVzIHRoZW0g4oCUIGByZWxhdGVkYCxcbiAqIGBzdXBlcnNlZGVzYCwgYHNvdXJjZXNbXS5yZXNvdXJjZWAsIG9yIGEga2V5IGludmVudGVkIHRvbW9ycm93LiBUaGUgU0hBUEVcbiAqIGRlY2lkZXMgKGEgc2xhc2ggb3IgYSBgLm1kYCksIHdoaWNoIGlzIHdoeSBiYXJlIGB0YWdzYCBhcmUgbm90IHJlZmVyZW5jZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWVsZFJlZnMoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgbWF4RGVwdGggPSA0KTogRmllbGRSZWZbXSB7XG4gIGNvbnN0IG91dDogRmllbGRSZWZbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgIGlmIChkZXB0aCA+IG1heERlcHRoKSByZXR1cm47XG4gICAgaWYgKGxvb2tzTGlrZVJlZih2YWx1ZSkpIG91dC5wdXNoKHsga2V5LCB2YWx1ZTogdmFsdWUudHJpbSgpIH0pO1xuICAgIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSBmb3IgKGNvbnN0IHYgb2YgdmFsdWUpIHdhbGsoa2V5LCB2LCBkZXB0aCArIDEpO1xuICAgIGVsc2UgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIilcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSlcbiAgICAgICAgd2FsayhgJHtrZXl9LiR7a31gLCB2LCBkZXB0aCArIDEpO1xuICB9O1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhmaWVsZHMpKSB3YWxrKGssIHYsIDApO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hlcmUgYSB0YXJnZXQgbGFuZGVkLiBgb3V0c2lkZWAgZXhpc3RzIG9uIGRpc2sgYnV0IG5vdCBpbiB0aGlzIGJ1bmRsZS4gKi9cbmV4cG9ydCB0eXBlIFJlc29sdXRpb24gPVxuICB8IHsgc3RhdGU6IFwiaW4tYnVuZGxlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJvdXRzaWRlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJtaXNzaW5nXCI7IHRyaWVkOiBzdHJpbmcgfTtcblxuZXhwb3J0IHR5cGUgQnVuZGxlSW5kZXggPSB7XG4gIC8qKiBUaGUgc2V0J3Mgcm9vdCDigJQgT0tGJ3MgYnVuZGxlLCBhbmQgd2hhdCBhIGAvYC10YXJnZXQgaXMgcmVsYXRpdmUgdG8uICovXG4gIHJvb3Q6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBidW5kbGUuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgZG9jdW1lbnQncyBwYXJzZWQgZnJvbnRtYXR0ZXIsIGZvciBgdHlwZS9zbHVnYCByZXNvbHV0aW9uLiAqL1xuICBtZXRhT2Y6IChwYXRoOiBzdHJpbmcpID0+IERvY01ldGEgfCBudWxsO1xuICAvKiogRG9lcyB0aGlzIHBhdGggZXhpc3Qgb24gZGlzaz8gKEluamVjdGVkLCBzbyB0aGUgcmVzb2x2ZXIgc3RheXMgcHVyZS4pICovXG4gIGV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSBnaXQgd29ya2luZyB0cmVlIHRoZSBidW5kbGUgc2l0cyBpbiwgd2hlbiB0aGVyZSBpcyBvbmUuIEEgdGhpcmQgcGxhY2VcbiAgICogYW4gdW5hbmNob3JlZCBwYXRoIGlzIHRyaWVkOiBwZG9jcyB3cml0ZXMgcmVwby1yZWxhdGl2ZSBwYXRoc1xuICAgKiAoYGRvY3MvcGxheWJvb2tzL2Zvby5tZGApIGFuZCB0aGUgd2lraSdzIHJ1bGUgcGFnZXMgY2FycnkgcmVwby1yZWxhdGl2ZVxuICAgKiBgY2hlY2tlcjpgIHZhbHVlcywgYW5kIG5laXRoZXIgcmVzb2x2ZXMgZnJvbSB0aGUgZG9jdW1lbnQgb3IgdGhlIGJ1bmRsZS5cbiAgICovXG4gIHJlcG9Sb290Pzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmNvbnN0IHN0ZW0gPSAocDogc3RyaW5nKSA9PiBiYXNlbmFtZShwLCBleHRuYW1lKHApKTtcblxuLyoqXG4gKiBSZXNvbHZlIG9uZSB3cml0dGVuIHRhcmdldCBhZ2FpbnN0IHRoZSBidW5kbGUuXG4gKlxuICogRm91ciBmb3JtcywgaW4gb3JkZXI6IGEgYnVuZGxlLXJlbGF0aXZlIHBhdGggKGAveC95Lm1kYCksIGEgcmVsYXRpdmUgcGF0aFxuICogKGAuL3kubWRgLCBgLi4veC95Lm1kYCksIGEgYHR5cGUvc2x1Z2Aga2V5IOKAlCBwZG9jcycgYW5kIHRoZSB3aWtpJ3Mgb3duIGZvcm0sXG4gKiB3aGljaCByZXNvbHZlcyBieSBUWVBFIGFuZCBCQVNFTkFNRSBzbyBhIHBhZ2UgY2FuIG1vdmUgZm9sZGVycyB3aXRob3V0XG4gKiBicmVha2luZyBpbmJvdW5kIHJlZmVyZW5jZXMg4oCUIGFuZCBhIGJhcmUgbmFtZSAoYSB3aWtpIGxpbmspLCBieSBiYXNlbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVUYXJnZXQocmF3VGFyZ2V0OiBzdHJpbmcsIGZyb206IHN0cmluZywgaW5kZXg6IEJ1bmRsZUluZGV4KTogUmVzb2x1dGlvbiB7XG4gIC8vIOKblCBTUExJVCBGSVJTVCwgQkVDQVVTRSBUSEUgQ0FMTEVSUyBESVNBR1JFRSBBQk9VVCBXSEFUIFRIRVkgSEFORCBPVkVSLlxuICAvLyBgZXh0cmFjdExpbmtzYCBzcGxpdHMgYSB0YXJnZXQgYmVmb3JlIGl0IGV2ZXIgZ2V0cyBoZXJlIChFNDkpLCBidXQgdGhlXG4gIC8vIENMSUNLIHBhdGggZG9lcyBub3Q6IGBsaW5rLm9wZW5gIGNhcnJpZXMgdGhlIGhyZWYgZXhhY3RseSBhcyB0aGUgZG9jdW1lbnRcbiAgLy8gd3JvdGUgaXQuIFNvIGFuIE9wZXJhdG9yIHR5cGVkIGxpbmsg4oCUIGBNYXJlbidzJTIwQmFrZXJ5Lm1kP3JlbD1sb2NhdGVkLWluYFxuICAvLyDigJQgYXJyaXZlZCB3aXRoIGl0cyBxdWVyeSBhbmQgaXRzIGVuY29kaW5nIGludGFjdCwgYGV4dG5hbWVgIHJlYWRcbiAgLy8gYC5tZD9yZWw9bG9jYXRlZC1pbmAsIGFuZCB0aGUgbG9va3VwIHdlbnQgaHVudGluZyBmb3IgYSBmaWxlIG5hbWVkIGFmdGVyXG4gIC8vIHRoZSB3aG9sZSBzdHJpbmcuIFRoZSBHUkFQSCBkcmV3IHRoYXQgZWRnZSBjb3JyZWN0bHkgdGhlIGVudGlyZSB0aW1lLCB3aGljaFxuICAvLyBpcyB3aGF0IG1hZGUgaXQgcHV6emxpbmc6IHRoZSBzYW1lIGxpbmsgd2FzIGZpbmUgaW4gdGhlIG1hcCBhbmQgZGVhZCB1bmRlclxuICAvLyB0aGUgcG9pbnRlci4gU3BsaXR0aW5nIGhlcmUgZml4ZXMgZXZlcnkgY2FsbGVyIGF0IG9uY2UgYW5kIGlzIGlkZW1wb3RlbnRcbiAgLy8gZm9yIHRoZSB0d28gdGhhdCBoYWQgYWxyZWFkeSBkb25lIGl0LiAoQ29sZSBmb3VuZCBpdCBieSBjbGlja2luZyBvbmUgaW5cbiAgLy8gSG9sbG93YnJvb2ssIDIwMjYtMDktMTQuKVxuICBjb25zdCB0YXJnZXQgPSBzcGxpdFRhcmdldChyYXdUYXJnZXQpLnBhdGg7XG4gIC8vIOKblCBXSEFUIE1BS0VTIEEgVEFSR0VUIEEgUEFUSCBSQVRIRVIgVEhBTiBBIEtFWSwgYW5kIHRoZSBjYXNlIHRoYXQgdGF1Z2h0XG4gIC8vIGl0OiBgW3RoZSBsaW50ZXJdKGxpbnQudHMpYCBpbiB0aGUgcmVhbCB3aWtpIGhhcyBubyBgLi9gIGFuZCBpcyBub3QgYSBgLm1kYCxcbiAgLy8gc28gYSBydWxlIGtleWVkIG9uIHRob3NlIHR3byByZWFkIGl0IGFzIGEgTkFNRSBhbmQgcmVwb3J0ZWQgaXQgbWlzc2luZ1xuICAvLyB3aGlsZSB0aGUgZmlsZSBzYXQgcmlnaHQgdGhlcmUuIEEgdGFyZ2V0IGlzIGEgcGF0aCB3aGVuIGl0IGlzIGFuY2hvcmVkXG4gIC8vIChgL2AsIGAuL2AsIGAuLi9gKSBvciBjYXJyaWVzIEFOWSBleHRlbnNpb247IGBjb25jZXB0L2V4aXQtY29kZXNgIGhhc1xuICAvLyBuZWl0aGVyLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgYHR5cGUvc2x1Z2Aga2V5IGEga2V5LlxuICBjb25zdCBsb29rc1BhdGggPVxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKSB8fFxuICAgIGV4dG5hbWUodGFyZ2V0KSAhPT0gXCJcIjtcbiAgaWYgKGxvb2tzUGF0aCkge1xuICAgIC8vIEFuIFVOQU5DSE9SRUQgcGF0aCAoYHNyYy9hY2Mva2l0L3gudHNgLCBgcmVwb3J0cy9hLm1kYCDigJQgbm8gYC4vYCBhbmQgbm9cbiAgICAvLyBsZWFkaW5nIGAvYCkgaXMgYW1iaWd1b3VzOiByZWxhdGl2ZSB0byB0aGUgZG9jdW1lbnQsIG9yIHRvIHRoZSBidW5kbGU/XG4gICAgLy8gQm90aCBhcmUgdHJpZWQsIGRvY3VtZW50IGZpcnN0LiBNZWFzdXJlZCBvbiB0aGUgcmVhbCB3aWtpLCB3aGVyZSBhIHJ1bGVcbiAgICAvLyBwYWdlJ3MgYGNoZWNrZXI6IHNyYy9hY2Mva2l0L2NoZWNrZXJzL+KApmAgd2FzIHJlcG9ydGVkIG1pc3Npbmcgd2hpbGVcbiAgICAvLyByZXNvbHZpbmcgZnJvbSB0aGUgYnVuZGxlIHJvb3Qgd291bGQgaGF2ZSBmb3VuZCBpdC5cbiAgICBjb25zdCBhbmNob3JlZCA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIilcbiAgICAgID8gW25vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpXVxuICAgICAgOiBhbmNob3JlZFxuICAgICAgICA/IFtub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSldXG4gICAgICAgIDogW1xuICAgICAgICAgICAgbm9ybWFsaXplKHJlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCkpLFxuICAgICAgICAgICAgbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSksXG4gICAgICAgICAgICAuLi4oaW5kZXgucmVwb1Jvb3QgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucmVwb1Jvb3QsIHRhcmdldCkpXSA6IFtdKSxcbiAgICAgICAgICBdO1xuICAgIGNvbnN0IHRyaWVkID0gY2FuZGlkYXRlcy5tYXAoKGMpID0+IChleHRuYW1lKGMpID09PSBcIlwiID8gYCR7Y30ubWRgIDogYykpO1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LnBhdGhzLmluY2x1ZGVzKGMpKSByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogYyB9O1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LmV4aXN0cyhjKSkgcmV0dXJuIHsgc3RhdGU6IFwib3V0c2lkZVwiLCBwYXRoOiBjIH07XG4gICAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdHJpZWRbMF0gYXMgc3RyaW5nIH07XG4gIH1cbiAgY29uc3Qgc2xhc2ggPSB0YXJnZXQuaW5kZXhPZihcIi9cIik7XG4gIGlmIChzbGFzaCA+IDApIHtcbiAgICAvLyBgdHlwZS9zbHVnYDogdGhlIHR5cGUgaXMgYSBjbGFpbSB0aGUgdGFyZ2V0J3Mgb3duIGZyb250bWF0dGVyIG11c3QgbWFrZS5cbiAgICBjb25zdCB0eXBlID0gdGFyZ2V0LnNsaWNlKDAsIHNsYXNoKTtcbiAgICBjb25zdCBzbHVnID0gdGFyZ2V0LnNsaWNlKHNsYXNoICsgMSk7XG4gICAgZm9yIChjb25zdCBwIG9mIGluZGV4LnBhdGhzKVxuICAgICAgaWYgKHN0ZW0ocCkgPT09IHNsdWcgJiYgaW5kZXgubWV0YU9mKHApPy50eXBlID09PSB0eXBlKVxuICAgICAgICByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogcCB9O1xuICB9XG4gIGNvbnN0IGhpdCA9IGluZGV4LnBhdGhzLmZpbmQoKHApID0+IHN0ZW0ocCkgPT09IHN0ZW0odGFyZ2V0KSk7XG4gIGlmIChoaXQpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBoaXQgfTtcbiAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdGFyZ2V0IH07XG59XG5cbi8qKiBBbiBlZGdlIGluIGEgc2V0J3MgbWFwLiBgcmVsYCBlbXB0eSBtZWFucyBubyBhc3NlcnRpb24gd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBFZGdlID0ge1xuICBmcm9tOiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRoIHdoZW4gcmVzb2x2ZWQ7IHRoZSB3cml0dGVuIHRhcmdldCB3aGVuIG5vdC4gKi9cbiAgdG86IHN0cmluZztcbiAgLyoqIEEgYm9keSBsaW5rLCBvciBhIGZyb250bWF0dGVyIHZhbHVlIOKAlCBrZXB0IGFwYXJ0LCBhcyBwZG9jcyBrZWVwcyB0aGVtLiAqL1xuICBzb3VyY2U6IFwibGlua1wiIHwgXCJmcm9udG1hdHRlclwiO1xuICAvKiogVGhlIGZyb250bWF0dGVyIGtleSB0aGF0IGNhcnJpZWQgaXQgKGByZWxhdGVkYCwgYHNvdXJjZXMucmVzb3VyY2VgLCDigKYpLiAqL1xuICBrZXk/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBGb3IgYSBCT0RZIGxpbms6IHRoZSB0YXJnZXQgYXMgd3JpdHRlbiwgYW5kIHRoZSBsaW5lIGl0IGlzIG9uLiBBYnNlbnQgZm9yIGFcbiAgICogZnJvbnRtYXR0ZXIgcmVmZXJlbmNlLCB3aGVyZSBga2V5YCBpcyB0aGUgYWRkcmVzcyBpbnN0ZWFkLlxuICAgKi9cbiAgcmF3Pzogc3RyaW5nO1xuICBsaW5lPzogbnVtYmVyO1xuICByZWw6IHN0cmluZ1tdO1xuICBzdGF0ZTogUmVzb2x1dGlvbltcInN0YXRlXCJdO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGhOb2RlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHJlbDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgc3RhbGU6IGJvb2xlYW47XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBsaW5rc091dDogbnVtYmVyO1xuICBsaW5rc0luOiBudW1iZXI7XG59O1xuXG5leHBvcnQgdHlwZSBHcmFwaCA9IHtcbiAgcm9vdDogc3RyaW5nO1xuICBub2RlczogR3JhcGhOb2RlW107XG4gIGVkZ2VzOiBFZGdlW107XG4gIC8qKiBUYXJnZXRzIG5vdGhpbmcgaW4gdGhlIGJ1bmRsZSBhbnN3ZXJzIOKAlCBzYWlkLCBuZXZlciBhbiBlcnJvciAoT0tGIMKnMTEpLiAqL1xuICBkYW5nbGluZzogbnVtYmVyO1xufTtcblxuLyoqIEJ1aWxkIGEgc2V0J3MgbWFwOiBub2RlcyBhcmUgaXRzIGRvY3VtZW50cywgZWRnZXMgYXJlIHRoZSBmb3VyIHNvdXJjZXMuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHcmFwaChpbmRleDogQnVuZGxlSW5kZXgsIGJvZHlPZjogKHBhdGg6IHN0cmluZykgPT4gc3RyaW5nLCBjYXAgPSA0MDApOiBHcmFwaCB7XG4gIGNvbnN0IHBhdGhzID0gaW5kZXgucGF0aHMuc2xpY2UoMCwgY2FwKTtcbiAgY29uc3QgZWRnZXM6IEVkZ2VbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGZyb20gb2YgcGF0aHMpIHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKGZyb20pO1xuICAgIGZvciAoY29uc3QgbGluayBvZiBleHRyYWN0TGlua3MoYm9keU9mKGZyb20pKSkge1xuICAgICAgY29uc3QgciA9IHJlc29sdmVUYXJnZXQobGluay50YXJnZXQsIGZyb20sIGluZGV4KTtcbiAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICBmcm9tLFxuICAgICAgICB0bzogci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyByLnRyaWVkIDogci5wYXRoLFxuICAgICAgICBzb3VyY2U6IFwibGlua1wiLFxuICAgICAgICByYXc6IGxpbmsucmF3LFxuICAgICAgICBsaW5lOiBsaW5rLmxpbmUsXG4gICAgICAgIHJlbDogbGluay5yZWwsXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcmVmIG9mIG1ldGEgPyBmaWVsZFJlZnMobWV0YS5maWVsZHMpIDogW10pIHtcbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KHJlZi52YWx1ZSwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJmcm9udG1hdHRlclwiLFxuICAgICAgICBrZXk6IHJlZi5rZXksXG4gICAgICAgIHJlbDogW10sXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IG91dE9mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgaW50b09mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBlIG9mIGVkZ2VzKSB7XG4gICAgb3V0T2Yuc2V0KGUuZnJvbSwgKG91dE9mLmdldChlLmZyb20pID8/IDApICsgMSk7XG4gICAgaWYgKGUuc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIGludG9PZi5zZXQoZS50bywgKGludG9PZi5nZXQoZS50bykgPz8gMCkgKyAxKTtcbiAgfVxuICBjb25zdCBub2RlczogR3JhcGhOb2RlW10gPSBwYXRocy5tYXAoKHBhdGgpID0+IHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKHBhdGgpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoLFxuICAgICAgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGluZGV4LnJvb3QsIHBhdGgpKSxcbiAgICAgIHRpdGxlOiBtZXRhPy50aXRsZSA/PyBzdGVtKHBhdGgpLFxuICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gXCJzdGFibGVcIixcbiAgICAgIHN0YWxlOiBtZXRhPy5zdGFsZSA/PyBmYWxzZSxcbiAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICBsaW5rc091dDogb3V0T2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgICBsaW5rc0luOiBpbnRvT2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgfTtcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgcm9vdDogaW5kZXgucm9vdCxcbiAgICBub2RlcyxcbiAgICBlZGdlcyxcbiAgICBkYW5nbGluZzogZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIikubGVuZ3RoLFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iLAogICAgIi8vIEZpbmRpbmcgdGhpbmdzIGFjcm9zcyBldmVyeXRoaW5nIGluIHRoZSBjb250ZXh0IChFNTkpLlxuLy9cbi8vIOKblCBUV08gTUFUQ0hFUlMsIE9OIFBVUlBPU0UsIGJlY2F1c2UgdGhleSBhbnN3ZXIgZGlmZmVyZW50IHF1ZXN0aW9ucy4gTm90ZVxuLy8gYXBwcyBzcGxpdCB0aGVzZSBhbmQgaXQgaXMgbm90IGFuIGFjY2lkZW50OiBGVVpaWSBvbiBuYW1lcyBpcyBmb3IganVtcGluZ1xuLy8gKFwibWFiYWtcIiDihpIgTWFyZW4ncyBCYWtlcnkpLCBhbmQgRVhBQ1Qgb24gY29udGVudCBpcyBmb3IgZmluZGluZyAoXCJ3aGVyZSBkaWQgSVxuLy8gc2F5ICdhc2tpbmctbmljZWx5J1wiKS4gRnV6enkgZnVsbC10ZXh0IHdvdWxkIGJlIHRoZSB3b3JzdCBvZiBib3RoIOKAlCBzZWFyY2hpbmdcbi8vIGBicmlkZ2VgIHdvdWxkIHN1cmZhY2UgZG9jdW1lbnRzIHRoYXQgbWVyZWx5IGNvbnRhaW4gc2ltaWxhci1sb29raW5nIGxldHRlcnMsXG4vLyBhbmQgeW91IGNvdWxkIG5vIGxvbmdlciB0cnVzdCBcInRoaXMgcGhyYXNlIGlzIG9uIGxpbmUgMjlcIiwgd2hpY2ggaXMgdGhlIG9ubHlcbi8vIHRoaW5nIGEgY29udGVudCBzZWFyY2ggaXMgZm9yLiAoQ29sZSByYWlzZWQgRnVzZSBmb3IgdGhlIG5hbWUgaGFsZiBhbmQgY2hvc2Vcbi8vIHRoZSBoYW5kLXJvbGxlZCBzY29yZXI6IHRoZXJlIGlzIG5vIHNlY29uZCBlbmdpbmUgdGhpcyBoYXMgdG8gYWdyZWUgd2l0aCwgc29cbi8vIGZ1enp5IHJhbmtpbmcgaXMgYSBzZWxmLWNvbnRhaW5lZCB0YXN0ZSBqdWRnbWVudCB3aXRoIG5vIGRyaWZ0IHJpc2suKVxuLy9cbi8vIOKaoCBBTkQgSVQgU0VBUkNIRVMgV0hBVCBUSEUgSFVNQU4gSVMgTE9PS0lORyBBVCwgd2hpY2ggaXMgbm90IGFsd2F5cyB0aGUgZmlsZS5cbi8vIEEgZG9jdW1lbnQgb3BlbiBpbiB0aGUgc2Vzc2lvbiBpcyBzaG93biBhcyBpdHMgQUNUSVZFIFZFUlNJT04sIHdoaWNoIGxpdmVzXG4vLyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIHJhdGhlciB0aGFuIGF0IHRoZSBvcmlnaW5hbCBwYXRoIOKAlCBzbyBhbiBlZGl0IG1hZGUgdHdvXG4vLyBtaW51dGVzIGFnbyBtdXN0IHN0aWxsIGJlIGZpbmRhYmxlLiBUaGF0IGFzeW1tZXRyeSBpcyBhbHNvIHRoZSByZWFzb24gdGhpc1xuLy8gZXhpc3RzIGZvciB0aGUgQUdFTlQgYXQgYWxsOiBncmVwIG92ZXIgdGhlIHdvcmtzcGFjZSBmaW5kcyB0aGUgU0FWRUQgZmlsZSBhbmRcbi8vIHNpbGVudGx5IG1pc3NlcyB0aGUgdmVyc2lvbiBiZWluZyByZWFkLiBUaGUgY2FsbGVyIHN1cHBsaWVzIHRoZSB0ZXh0IHBlclxuLy8gZG9jdW1lbnQgZm9yIGV4YWN0bHkgdGhpcyByZWFzb24gKHNlZSBgU2Vzc2lvbi5zZWFyY2hBbGxgKS5cblxuLyoqIE9uZSBsaW5lIHRoYXQgbWF0Y2hlZCwgd2l0aCB0aGUgb2Zmc2V0cyBvZiB0aGUgaGl0IGluc2lkZSB0aGUgZG9jdW1lbnQuICovXG5leHBvcnQgdHlwZSBIaXQgPSB7XG4gIC8qKiAxLWJhc2VkLCBzbyBpdCBjYW4gYmUgc2hvd24gYW5kIG9wZW5lZC4gKi9cbiAgbGluZTogbnVtYmVyO1xuICAvKiogVGhlIGxpbmUsIGZvciBjb250ZXh0IGluIHRoZSByZXN1bHQgbGlzdC4gKi9cbiAgdGV4dDogc3RyaW5nO1xuICAvKiogT2Zmc2V0cyBvZiB0aGUgbWF0Y2ggd2l0aGluIHRoZSBkb2N1bWVudCwgZm9yIHJldmVhbC1hbmQtc2VsZWN0LiAqL1xuICBmcm9tOiBudW1iZXI7XG4gIHRvOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIEhvdyBtdWNoIG9mIGEgbGluZSBpcyB3b3J0aCBjYXJyeWluZyBiYWNrLiBBIHJlc3VsdCBsaXN0IGlzIGEgbGlzdCwgYW5kIGFcbiAqIGRvY3VtZW50IHdpdGggYSA0LDAwMC1jaGFyYWN0ZXIgcGFyYWdyYXBoIHNob3VsZCBub3Qgc2VuZCBhbGwgb2YgaXQgcGVyIGhpdC5cbiAqL1xuY29uc3QgTElORV9DQVAgPSAyNDA7XG5cbi8qKiBFdmVyeSBtYXRjaCBvZiBgcXVlcnlgIGluIGB0ZXh0YCwgYXQgbW9zdCBgbGltaXRgIG9mIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gc2VhcmNoVGV4dCh0ZXh0OiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcsIGxpbWl0ID0gNTApOiBIaXRbXSB7XG4gIGNvbnN0IG5lZWRsZSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAobmVlZGxlID09PSBcIlwiIHx8IGxpbWl0IDw9IDApIHJldHVybiBbXTtcbiAgY29uc3QgaGF5ID0gdGV4dC50b0xvd2VyQ2FzZSgpO1xuICBsZXQgYXQgPSBoYXkuaW5kZXhPZihuZWVkbGUpO1xuICBpZiAoYXQgPT09IC0xKSByZXR1cm4gW107XG4gIC8vIExpbmUgc3RhcnRzLCB3YWxrZWQgT05DRS4gQSBwZXItaGl0IGBsYXN0SW5kZXhPZihcIlxcblwiKWAgaXMgcXVhZHJhdGljIG92ZXIgYVxuICAvLyBkb2N1bWVudCB0aGF0IG1hdGNoZXMgb24gZXZlcnkgbGluZSwgd2hpY2ggaXMgZXhhY3RseSB0aGUgZG9jdW1lbnQgc29tZW9uZVxuICAvLyBzZWFyY2hlcyBmb3IgYSBjb21tb24gd29yZC5cbiAgY29uc3Qgc3RhcnRzOiBudW1iZXJbXSA9IFswXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSBpZiAodGV4dC5jaGFyQ29kZUF0KGkpID09PSAxMCkgc3RhcnRzLnB1c2goaSArIDEpO1xuICBjb25zdCBoaXRzOiBIaXRbXSA9IFtdO1xuICBsZXQgY3Vyc29yID0gMDtcbiAgd2hpbGUgKGF0ICE9PSAtMSAmJiBoaXRzLmxlbmd0aCA8IGxpbWl0KSB7XG4gICAgd2hpbGUgKGN1cnNvciArIDEgPCBzdGFydHMubGVuZ3RoICYmIChzdGFydHNbY3Vyc29yICsgMV0gYXMgbnVtYmVyKSA8PSBhdCkgY3Vyc29yKys7XG4gICAgY29uc3QgbGluZVN0YXJ0ID0gc3RhcnRzW2N1cnNvcl0gYXMgbnVtYmVyO1xuICAgIGNvbnN0IGxpbmVFbmQgPSBjdXJzb3IgKyAxIDwgc3RhcnRzLmxlbmd0aCA/IChzdGFydHNbY3Vyc29yICsgMV0gYXMgbnVtYmVyKSAtIDEgOiB0ZXh0Lmxlbmd0aDtcbiAgICBjb25zdCB3aG9sZSA9IHRleHQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcbiAgICBoaXRzLnB1c2goe1xuICAgICAgbGluZTogY3Vyc29yICsgMSxcbiAgICAgIHRleHQ6IHdob2xlLmxlbmd0aCA+IExJTkVfQ0FQID8gYCR7d2hvbGUuc2xpY2UoMCwgTElORV9DQVAgLSAxKX3igKZgIDogd2hvbGUsXG4gICAgICBmcm9tOiBhdCxcbiAgICAgIHRvOiBhdCArIG5lZWRsZS5sZW5ndGgsXG4gICAgfSk7XG4gICAgLy8g4pqgIEFEVkFOQ0UgUEFTVCBUSEUgTUFUQ0gsIE5PVCBUSEUgTElORTogdHdvIGhpdHMgb24gb25lIGxpbmUgYXJlIHR3b1xuICAgIC8vIGhpdHMsIGFuZCBzdGVwcGluZyBieSBsaW5lIHdvdWxkIHNpbGVudGx5IGRyb3AgdGhlIHNlY29uZC5cbiAgICBhdCA9IGhheS5pbmRleE9mKG5lZWRsZSwgYXQgKyBuZWVkbGUubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gaGl0cztcbn1cblxuLyoqIElzIHRoaXMgY2hhcmFjdGVyIGEgd29yZCBib3VuZGFyeSBmb3Igc2NvcmluZyBwdXJwb3Nlcz8gKi9cbmZ1bmN0aW9uIGlzQm91bmRhcnkoY2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gY2ggPT09IFwiIFwiIHx8IGNoID09PSBcIi1cIiB8fCBjaCA9PT0gXCJfXCIgfHwgY2ggPT09IFwiL1wiIHx8IGNoID09PSBcIi5cIiB8fCBjaCA9PT0gXCInXCI7XG59XG5cbi8qKlxuICogSG93IHdlbGwgYG5hbWVgIG1hdGNoZXMgYHF1ZXJ5YCBhcyBhIGZ1enp5IHN1YnNlcXVlbmNlIOKAlCBoaWdoZXIgaXMgYmV0dGVyLFxuICogYG51bGxgIHdoZW4gdGhlIHF1ZXJ5J3MgY2hhcmFjdGVycyBkbyBub3QgYXBwZWFyIGluIG9yZGVyIGF0IGFsbC5cbiAqXG4gKiBUaGUgd2VpZ2h0cyBlbmNvZGUgd2hhdCBzb21lb25lIHR5cGluZyBpbnRvIGEganVtcCBib3ggbWVhbnM6XG4gKlxuICogLSAqKmNvbnRpZ3VpdHkqKiBkb21pbmF0ZXMsIGJlY2F1c2UgYG1hcmVgIG1lYW5pbmcgYE1hcmVuYCBpcyB0aGUgY29tbW9uIGNhc2VcbiAqICAgYW5kIGBt4oCmYeKApnLigKZlYCBzY2F0dGVyZWQgdGhyb3VnaCBhIHNlbnRlbmNlIGlzIHRoZSByYXJlIG9uZTtcbiAqIC0gKip3b3JkIHN0YXJ0cyoqIHNjb3JlLCBzbyBgbWJgIGZpbmRzIGBNYXJlbidzIEJha2VyeWAgcmF0aGVyIHRoYW4gYE51bWJlcmA7XG4gKiAtICoqZWFybGllciBpcyBiZXR0ZXIqKiwgYW5kIGEgKipzaG9ydGVyIG5hbWUqKiB3aW5zIGEgdGllLCBiZWNhdXNlIHRoZSB0aGluZ1xuICogICB5b3UgbWVhbnQgaXMgdXN1YWxseSB0aGUgdGhpbmcgd2l0aCBsZXNzIGFyb3VuZCBpdC5cbiAqXG4gKiDimqAgVEhFIE5VTUJFUlMgQVJFIFRBU1RFLCBOT1QgVFJVVEguIFRoZXkgYXJlIHBpbm5lZCBieSBjZWxscyB0aGF0IGFzc2VydFxuICogT1JERVJJTkdTIChcInRoaXMgYmVhdHMgdGhhdFwiKSByYXRoZXIgdGhhbiB2YWx1ZXMsIHNvIHRoZXkgY2FuIGJlIHJldHVuZWRcbiAqIHdpdGhvdXQgcmV3cml0aW5nIHRoZSB0ZXN0cyDigJQgd2hpY2ggaXMgdGhlIG9ubHkgd2F5IGEgc2NvcmVyIGxpa2UgdGhpcyBzdGF5c1xuICogY2hhbmdlYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjb3JlTmFtZShuYW1lOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAocSA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhheSA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgbGV0IHNjb3JlID0gMDtcbiAgbGV0IGF0ID0gMDtcbiAgbGV0IHJ1biA9IDA7XG4gIGZvciAoY29uc3QgY2ggb2YgcSkge1xuICAgIGNvbnN0IGZvdW5kID0gaGF5LmluZGV4T2YoY2gsIGF0KTtcbiAgICBpZiAoZm91bmQgPT09IC0xKSByZXR1cm4gbnVsbDtcbiAgICBydW4gPSBmb3VuZCA9PT0gYXQgJiYgYXQgPiAwID8gcnVuICsgMSA6IDA7XG4gICAgc2NvcmUgKz0gMTAgKyBydW4gKiAxMjtcbiAgICBpZiAoZm91bmQgPT09IDAgfHwgaXNCb3VuZGFyeShoYXlbZm91bmQgLSAxXSBhcyBzdHJpbmcpKSBzY29yZSArPSAxNDtcbiAgICAvLyBEaXN0YW5jZSBmcm9tIHdoZXJlIHdlIHdlcmUgbG9va2luZyBjb3N0cywgc28gc2NhdHRlcmVkIG1hdGNoZXMgcmFuayBsb3cuXG4gICAgc2NvcmUgLT0gTWF0aC5taW4oZm91bmQgLSBhdCwgMTIpO1xuICAgIGF0ID0gZm91bmQgKyAxO1xuICB9XG4gIC8vIEEgd2hvbGUtd29yZCBzdWJzdHJpbmcgaXMgdGhlIHN0cm9uZ2VzdCBzaWduYWwgdGhlcmUgaXM7IHNheSBzbyBsb3VkbHkuXG4gIGlmIChoYXkuaW5jbHVkZXMocSkpIHNjb3JlICs9IDQwO1xuICBpZiAoaGF5LnN0YXJ0c1dpdGgocSkpIHNjb3JlICs9IDI1O1xuICAvLyBTaG9ydGVyIG5hbWVzIHdpbiB0aWVzLlxuICBzY29yZSAtPSBNYXRoLm1pbihuYW1lLmxlbmd0aCwgNDApIC8gNDtcbiAgcmV0dXJuIHNjb3JlO1xufVxuXG4vKiogQSBkb2N1bWVudCB0aGUgTkFNRSBtYXRjaGVkLiAqL1xuZXhwb3J0IHR5cGUgTmFtZU1hdGNoID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHNjb3JlOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIOKblCBUSEUgU1dBUCBTRUFNIChDb2xlKTogXCJpZiB3ZSBmaW5kIHRoYXQgYWN0dWFsbHkgd2Ugc2hvdWxkIHVzZSBGdXNlLCBpdCdzXG4gKiBmYWlybHkgZWFzeSB0byByZXBsYWNlLlwiXG4gKlxuICogVGhlIGludGVyZmFjZSBpcyBDT1JQVVMtU0hBUEVEIOKAlCB0YWtlIHRoZSB3aG9sZSBjYW5kaWRhdGUgbGlzdCBhbmQgYSBxdWVyeSxcbiAqIHJldHVybiBhIHJhbmtlZCBzbGljZSDigJQgYW5kIHRoYXQgc2hhcGUgaXMgdGhlIHdob2xlIHBvaW50LiBBIHBlci1pdGVtXG4gKiBgc2NvcmUobmFtZSwgcXVlcnkpYCBob29rIHdvdWxkIGhhdmUgbG9va2VkIGxpa2UgdGhlIHNtYWxsZXIgYWJzdHJhY3Rpb24gYW5kXG4gKiB3b3VsZCBoYXZlIEZPVUdIVCB0aGUgdmVyeSBsaWJyYXJ5IGl0IGV4aXN0cyB0byBhZG1pdDogRnVzZSBpbmRleGVzIGEgbGlzdFxuICogYW5kIHNlYXJjaGVzIGl0LCBpdCBkb2VzIG5vdCBzY29yZSBvbmUgc3RyaW5nIGF0IGEgdGltZS4gV3JpdHRlbiB0aGlzIHdheSxcbiAqIG1vdmluZyB0byBGdXNlIGlzIGEgbmV3IGZ1bmN0aW9uIGFuZCBvbmUgZGVmYXVsdCBjaGFuZ2VkOlxuICpcbiAqICAgICBjb25zdCBmdXNlTmFtZXM6IE5hbWVTZWFyY2ggPSAoY2FuZGlkYXRlcywgcXVlcnksIGxpbWl0KSA9PiB7XG4gKiAgICAgICBjb25zdCBmdXNlID0gbmV3IEZ1c2UoY2FuZGlkYXRlcywgeyBrZXlzOiBbXCJuYW1lXCIsIFwidGl0bGVcIl0sIOKApiB9KTtcbiAqICAgICAgIHJldHVybiBmdXNlLnNlYXJjaChxdWVyeSwgeyBsaW1pdCB9KS5tYXAo4oCmKTtcbiAqICAgICB9O1xuICpcbiAqIE5vdGhpbmcgZWxzZSBpbiB0aGlzIG1vZHVsZSwgdGhlIHNlc3Npb24sIHRoZSB3aXJlIG9yIHRoZSBzdXJmYWNlIG1vdmVzLlxuICovXG5leHBvcnQgdHlwZSBOYW1lU2VhcmNoID0gKFxuICBjYW5kaWRhdGVzOiByZWFkb25seSBDYW5kaWRhdGVbXSxcbiAgcXVlcnk6IHN0cmluZyxcbiAgbGltaXQ6IG51bWJlcixcbikgPT4gTmFtZU1hdGNoW107XG5cbi8qKiBBIGRvY3VtZW50IHRoZSBDT05URU5UIG1hdGNoZWQuICovXG5leHBvcnQgdHlwZSBUZXh0TWF0Y2ggPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB2ZXJzaW9uPzogbnVtYmVyO1xuICBoaXRzOiBIaXRbXTtcbn07XG5cbmV4cG9ydCB0eXBlIFNlYXJjaFJlcG9ydCA9IHtcbiAgcXVlcnk6IHN0cmluZztcbiAgLyoqIE5hbWUvdGl0bGUgbWF0Y2hlcywgYmVzdCBmaXJzdCDigJQgdGhlIGp1bXAgbGlzdC4gKi9cbiAgZG9jdW1lbnRzOiBOYW1lTWF0Y2hbXTtcbiAgLyoqIENvbnRlbnQgbWF0Y2hlcywgaW4gY29udGV4dCBvcmRlciDigJQgdGhlIGZpbmQgbGlzdC4gKi9cbiAgdGV4dDogVGV4dE1hdGNoW107XG4gIC8qKiBUb3RhbCBjb250ZW50IGhpdHMgcmVwb3J0ZWQuICovXG4gIGNvdW50OiBudW1iZXI7XG4gIC8qKiBUcnVlIHdoZW4gYSBjYXAgc3RvcHBlZCB0aGUgc2VhcmNoIGVhcmx5LCBzbyBcIjNcIiBhbmQgXCIzIG9mIG1vcmVcIiBkaWZmZXIuICovXG4gIHRydW5jYXRlZDogYm9vbGVhbjtcbn07XG5cbi8qKiBQZXItZG9jdW1lbnQgY29udGVudCBjYXAsIHNvIG9uZSBlbm9ybW91cyBkb2N1bWVudCBjYW5ub3QgZmlsbCB0aGUgcmVwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IFBFUl9ET0MgPSAyMDtcbi8qKiBXaG9sZS1yZXBvcnQgY29udGVudCBjYXAuICovXG5leHBvcnQgY29uc3QgVE9UQUwgPSAyMDA7XG4vKiogSG93IG1hbnkgbmFtZSBtYXRjaGVzIGFyZSB3b3J0aCBzaG93aW5nLiAqL1xuZXhwb3J0IGNvbnN0IE5BTUVTID0gMTA7XG5cbi8qKlxuICogVGhlIGRlZmF1bHQgYE5hbWVTZWFyY2hgOiBgc2NvcmVOYW1lYCBvdmVyIGV2ZXJ5IGNhbmRpZGF0ZSwgcmFua2VkLlxuICpcbiAqIEEgZG9jdW1lbnQncyBUSVRMRSBpcyBtYXRjaGVkIGFzIHdlbGwgYXMgaXRzIGZpbGVuYW1lIOKAlCBhbiBPS0YgZG9jdW1lbnQnc1xuICogbmFtZSBhbmQgdGl0bGUgb2Z0ZW4gZGlmZmVyIGFuZCB0aGUgaHVtYW4gbWF5IHJlbWVtYmVyIGVpdGhlciDigJQgYW5kIHRoZVxuICogYmV0dGVyIG9mIHRoZSB0d28gc2NvcmVzIGlzIHRoZSBvbmUgdGhhdCBjb3VudHMuXG4gKi9cbmV4cG9ydCBjb25zdCByYW5rTmFtZXM6IE5hbWVTZWFyY2ggPSAoY2FuZGlkYXRlcywgcXVlcnksIGxpbWl0KSA9PiB7XG4gIGNvbnN0IG91dDogTmFtZU1hdGNoW10gPSBbXTtcbiAgZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBjb25zdCBieU5hbWUgPSBzY29yZU5hbWUoYy5uYW1lLCBxdWVyeSk7XG4gICAgY29uc3QgYnlUaXRsZSA9IGMudGl0bGUgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBzY29yZU5hbWUoYy50aXRsZSwgcXVlcnkpO1xuICAgIGlmIChieU5hbWUgPT09IG51bGwgJiYgYnlUaXRsZSA9PT0gbnVsbCkgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAgcGF0aDogYy5wYXRoLFxuICAgICAgLi4uKGMuc2x1ZyAhPT0gdW5kZWZpbmVkID8geyBzbHVnOiBjLnNsdWcgfSA6IHt9KSxcbiAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgIC4uLihjLnRpdGxlICE9PSB1bmRlZmluZWQgPyB7IHRpdGxlOiBjLnRpdGxlIH0gOiB7fSksXG4gICAgICBzY29yZTogTWF0aC5tYXgoYnlOYW1lID8/IC1JbmZpbml0eSwgYnlUaXRsZSA/PyAtSW5maW5pdHkpLFxuICAgIH0pO1xuICB9XG4gIG91dC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSB8fCBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTtcbiAgcmV0dXJuIG91dC5zbGljZSgwLCBsaW1pdCk7XG59O1xuXG5leHBvcnQgdHlwZSBDYW5kaWRhdGUgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBiYXNlbmFtZSwgd2hpY2ggaXMgd2hhdCBhIGh1bWFuIHR5cGVzIGF0LiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogbnVtYmVyO1xufTtcblxuLyoqXG4gKiBTZWFyY2ggYSBsaXN0IG9mIGNhbmRpZGF0ZXMgZm9yIGJvdGgga2luZHMgb2YgbWF0Y2guXG4gKlxuICogYHJlYWRgIG1heSB0aHJvdyBvciByZXR1cm4gbnVsbCBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBiZWVuIGRlbGV0ZWQgdW5kZXJcbiAqIHRoZSBjb250ZXh0IOKAlCBhIHNlYXJjaCBpcyBub3QgdGhlIG1vbWVudCB0byBmYWlsIG92ZXIgdGhhdCwgc28gaXQgaXMgc2tpcHBlZFxuICogcmF0aGVyIHRoYW4gcmVwb3J0ZWQgYXMgYSBkb2N1bWVudCB3aXRoIG5vIGhpdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWFyY2hEb2N1bWVudHMoXG4gIGNhbmRpZGF0ZXM6IHJlYWRvbmx5IENhbmRpZGF0ZVtdLFxuICBxdWVyeTogc3RyaW5nLFxuICByZWFkOiAoYzogQ2FuZGlkYXRlKSA9PiBzdHJpbmcgfCBudWxsLFxuICBjYXBzOiB7IHBlckRvYz86IG51bWJlcjsgdG90YWw/OiBudW1iZXI7IG5hbWVzPzogbnVtYmVyOyBuYW1lU2VhcmNoPzogTmFtZVNlYXJjaCB9ID0ge30sXG4pOiBTZWFyY2hSZXBvcnQge1xuICBjb25zdCBxID0gcXVlcnkudHJpbSgpO1xuICBpZiAocSA9PT0gXCJcIikgcmV0dXJuIHsgcXVlcnk6IFwiXCIsIGRvY3VtZW50czogW10sIHRleHQ6IFtdLCBjb3VudDogMCwgdHJ1bmNhdGVkOiBmYWxzZSB9O1xuICBjb25zdCBwZXJEb2MgPSBjYXBzLnBlckRvYyA/PyBQRVJfRE9DO1xuICBjb25zdCB0b3RhbCA9IGNhcHMudG90YWwgPz8gVE9UQUw7XG4gIGNvbnN0IG5hbWVzID0gY2Fwcy5uYW1lcyA/PyBOQU1FUztcblxuICBjb25zdCBzY29yZWQgPSAoY2Fwcy5uYW1lU2VhcmNoID8/IHJhbmtOYW1lcykoY2FuZGlkYXRlcywgcSwgbmFtZXMpO1xuXG4gIGNvbnN0IHRleHQ6IFRleHRNYXRjaFtdID0gW107XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoY291bnQgPj0gdG90YWwpIHtcbiAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgbGV0IGJvZHk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBib2R5ID0gcmVhZChjKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGJvZHkgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoYm9keSA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3Qgcm9vbSA9IE1hdGgubWluKHBlckRvYywgdG90YWwgLSBjb3VudCk7XG4gICAgY29uc3QgaGl0cyA9IHNlYXJjaFRleHQoYm9keSwgcSwgcm9vbSArIDEpO1xuICAgIGlmIChoaXRzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgaWYgKGhpdHMubGVuZ3RoID4gcm9vbSkgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICBjb25zdCBrZXB0ID0gaGl0cy5zbGljZSgwLCByb29tKTtcbiAgICBjb3VudCArPSBrZXB0Lmxlbmd0aDtcbiAgICB0ZXh0LnB1c2goe1xuICAgICAgcGF0aDogYy5wYXRoLFxuICAgICAgLi4uKGMuc2x1ZyAhPT0gdW5kZWZpbmVkID8geyBzbHVnOiBjLnNsdWcgfSA6IHt9KSxcbiAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgIC4uLihjLnZlcnNpb24gIT09IHVuZGVmaW5lZCA/IHsgdmVyc2lvbjogYy52ZXJzaW9uIH0gOiB7fSksXG4gICAgICBoaXRzOiBrZXB0LFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnk6IHEsIGRvY3VtZW50czogc2NvcmVkLCB0ZXh0LCBjb3VudCwgdHJ1bmNhdGVkIH07XG59XG4iLAogICAgIi8vIElzIHRoZSBodW1hbiB3YWl0aW5nIG9uIGFuIGFuc3dlciwgYW5kIGZvciBob3cgbG9uZyAoRTUzKT9cbi8vXG4vLyDim5QgREVSSVZFRCwgTk9UIERFQ0xBUkVEIOKAlCBDb2xlJ3MgcnVsaW5nLCBhbmQgdGhlIHJlYXNvbiBpcyBsb2FkLWJlYXJpbmc6IFwid2Vcbi8vIGNvdWxkIGFkZCBzb21lIGFmZm9yZGFuY2UgdGhhdCBzZW5kcyBhIGNoZWNrLWluIHdpdGggYW4gYWdlbnTigKYgd2hlcmUgd2UncmVcbi8vIG5vdCBhZGRpbmcgbW9yZSB0YXNrcyBmb3IgdGhlIGFnZW50IHRvIGhhdmUgdG8gZXhwbGljaXRseSBkby5cIiBBbiBhZ2VudCB0aGF0XG4vLyBtdXN0IHJlbWVtYmVyIHRvIHNheSBcInRoaW5raW5nXCIgd2lsbCBmb3JnZXQgZXhhY3RseSB3aGVuIGl0IG1hdHRlcnMg4oCUIGl0IGlzXG4vLyBidXN5LCB3aGljaCBpcyB0aGUgd2hvbGUgc2l0dWF0aW9uIGJlaW5nIHNpZ25hbGxlZC4gU28gbm90aGluZyBoZXJlIGFza3MgdGhlXG4vLyBhZ2VudCBmb3IgYW55dGhpbmcuIFRoZSBzdGF0ZSBpcyByZWFkIG9mZiB0aGUgY29udmVyc2F0aW9uOiBhIGh1bWFuIG1lc3NhZ2Vcbi8vIHdpdGggbm8gYWdlbnQgbWVzc2FnZSBhZnRlciBpdCBpcyBhIGh1bWFuIHdhaXRpbmcuXG4vL1xuLy8g4puUIEFORCBUSEUgQUdFTlQnUyBSRVBMWSBJUyBUSEUgQ09NUExFVElPTiBTSUdOQUwsIHdoaWNoIGlzIG1pbmQtbWFwcGVyJ3Ncbi8vIHJ1bGUgKFIxMSBTRUFNIDIpIGFuZCBpcyBzdG9sZW4gZGVsaWJlcmF0ZWx5LiBUaGVyZSBpcyBubyBgZG9uZWAgc3RhdGUgdG9cbi8vIGVtaXQsIHNvIHRoZXJlIGlzIG5vIGBkb25lYCBzdGF0ZSB0byBnZXQgb3V0IG9mIHN5bmMuIE9uZSBjb25zZXF1ZW5jZSB3b3J0aFxuLy8gbmFtaW5nIGJlY2F1c2UgaXQgZmVsbCBvdXQgZm9yIGZyZWU6IGBzdGFydFRhc2tgIHBvc3RzIGl0cyBhbm5vdW5jZW1lbnQgQVNcbi8vIFRIRSBBR0VOVCAoRTUwKSwgc28gdGhlIGhhcHB5IHBhdGggQ29sZSBkZXNjcmliZWQg4oCUIFwiZ3JlYXQsIEknbSBnb2luZyB0byBnZXRcbi8vIHRoYXQgc3RhcnRlZFwiLCB0aGVuIGEgdGFzaywgdGhlbiBhIHN1YmFnZW50IOKAlCBjbGVhcnMgdGhpcyBieSBjb25zdHJ1Y3Rpb24uXG4vL1xuLy8g4pqgIEEgU1lTVEVNIExJTkUgSVMgTk9UIEEgUkVQTFkuIGBhbm5vdW5jZSgpYCBuYXJyYXRlcyBhZ2VudCBBQ1RTIChcIkFnZW50XG4vLyBub3RlZCDigKYgb24gbWFyZW5cIiksIHdoaWNoIGlzIGV2aWRlbmNlIG9mIGxpZmUgYnV0IG5vdCBhIGNoZWNrLWluIHdpdGggdGhlXG4vLyBwZXJzb24gd2FpdGluZy4gQ291bnRpbmcgaXQgd291bGQgc2lsZW5jZSB0aGUgc2lnbmFsIHByZWNpc2VseSBpbiB0aGUgY2FzZVxuLy8gdGhpcyBleGlzdHMgZm9yOiBhbiBhZ2VudCB0aGF0IGlzIGJ1c3kgZG9pbmcgdGhpbmdzIGFuZCBoYXMgbm90IHNhaWQgYSB3b3JkXG4vLyB0byB0aGUgaHVtYW4uIE9ubHkgYHdobyA9PT0gXCJhZ2VudFwiYCBjbGVhcnMuXG5pbXBvcnQgdHlwZSB7IENoYXRXaG8sIE5vdGUsIE5vdGVXYWl0aW5nLCBXYWl0aW5nIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqXG4gKiBIb3cgbG9uZyBhIGh1bWFuIHdhaXRzIGJlZm9yZSB0aGUgd2FpdCBpcyB3b3J0aCByZXBvcnRpbmcuIDMwIHMsIENvbGUnc1xuICogbnVtYmVyIOKAlCBsb25nIGVub3VnaCB0aGF0IGFuIG9yZGluYXJ5IGFuc3dlciBuZXZlciB0cmlwcyBpdCwgc2hvcnQgZW5vdWdoXG4gKiB0aGF0IGl0IGlzIHN0aWxsIHRoZSBzYW1lIG1vbWVudCBmb3IgdGhlIHBlcnNvbiBzaXR0aW5nIHRoZXJlLlxuICovXG5leHBvcnQgY29uc3QgU1RBTExfTVMgPSAzMF8wMDA7XG5cbi8qKiBXaGF0IGEgc25vb3plIGJ1eXMsIHdoZW4gdGhlIGFnZW50IGRvZXMgbm90IG5hbWUgYSBkdXJhdGlvbi4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NOT09aRV9NUyA9IDEyMF8wMDA7XG5cbi8vIGBXYWl0aW5nYCBpdHNlbGYgbGl2ZXMgaW4gYHByb3RvY29sLnRzYCDigJQgaXQgcmlkZXMgaW4gYFB1YmxpY1N0YXRlYCwgYW5kIHRoYXRcbi8vIGZpbGUgaXMgaW1wb3J0LWZyZWUgb24gcHVycG9zZS4gSXRzIGBiYWRnZWAgY2FycmllcyB0aGUgcnVsZSB0aGF0IG1hdHRlcnM6XG4vLyDim5QgU1RBTExFRCBNVVNUIE5PVCBQVUxTRS4gQSBwdWxzZSBvdmVyIGEgd2VkZ2VkIGFnZW50IGlzIGZhbHNlIGxpdmVuZXNzIOKAlCB0aGVcbi8vIGFuaW1hdGlvbiBjbGFpbXMgXCJzb21ldGhpbmcgaXMgaGFwcGVuaW5nXCIgd2hlbiB0aGUgaG9uZXN0IGFuc3dlciBpcyBcIkkgY2Fubm90XG4vLyB0ZWxsIGFueSBtb3JlXCIuIG1pbmQtbWFwcGVyIHNlcGFyYXRlcyB0aGVzZSB0d28gZm9yIHRoZSBzYW1lIHJlYXNvbi5cblxudHlwZSBNc2cgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIHdobzogQ2hhdFdobztcbiAgdHM6IG51bWJlcjtcbiAgLyoqIEU2NTogdGhlIG5vdGUgYSBtZXNzYWdlIGlzIEFCT1VUIOKAlCBzZXQgYnkgXCJBc2sgdGhlIGFnZW50XCIuICovXG4gIG5vdGU/OiB7IGRvYzogc3RyaW5nOyBpZDogc3RyaW5nIH07XG59O1xuXG4vKipcbiAqIFRoZSBodW1hbiBtZXNzYWdlIG5vdGhpbmcgaGFzIGFuc3dlcmVkIHlldCwgb3IgbnVsbC5cbiAqXG4gKiBgYWNrbm93bGVkZ2VkVW50aWxgIGlzIGEgc25vb3plICh0aGUgYWdlbnQgc2FpZCBpdCBpcyBzdGlsbCB3b3JraW5nKS4gV2hpbGVcbiAqIGl0IGhvbGRzLCB0aGUgYmFkZ2Ugc3RheXMgYSBwdWxzZSBwYXN0IHRoZSBzdGFsbCB0aHJlc2hvbGQg4oCUIHRoZSBhZ2VudFxuICogdm9sdW50ZWVyZWQgZXZpZGVuY2Ugb2YgbGlmZSwgc28gc2hvd2luZyBcIm1heSBiZSBzdHVja1wiIHdvdWxkIGJlIHRoZSBsaWUuXG4gKiBXaGVuIGl0IEVYUElSRVMgdGhlIGJhZGdlIGdvZXMgc3RhbGxlZCBhZ2FpbiwgYmVjYXVzZSB0aGUgaHVtYW4gaXMgb3dlZCB0aGVcbiAqIHRydXRoIGV2ZW50dWFsbHk7IHRoYXQgZXhwaXJ5IGlzIGRlbGliZXJhdGVseSBub3QgYSByZWFzb24gdG8gbnVkZ2UgdGhlIGFnZW50XG4gKiBhIHNlY29uZCB0aW1lIChzZWUgdGhlIHNlcnZlcidzIG9uY2UtcGVyLW1lc3NhZ2UgcnVsZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YWl0aW5nT24oXG4gIGNoYXQ6IHJlYWRvbmx5IE1zZ1tdLFxuICBub3c6IG51bWJlcixcbiAgb3B0czogeyBzdGFsbE1zPzogbnVtYmVyOyBhY2tub3dsZWRnZWRVbnRpbD86IG51bWJlciB9ID0ge30sXG4pOiBXYWl0aW5nIHwgbnVsbCB7XG4gIC8vIFdhbGsgYmFjayB0byB0aGUgbGFzdCB0aGluZyB0aGF0IHdhcyBub3QgbmFycmF0aW9uLiBBIGh1bWFuIHRoZXJlIG1lYW5zXG4gIC8vIG5vYm9keSBoYXMgYW5zd2VyZWQgdGhlbS5cbiAgbGV0IHBlbmRpbmc6IE1zZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gY2hhdC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IG0gPSBjaGF0W2ldO1xuICAgIGlmICghbSB8fCBtLndobyA9PT0gXCJzeXN0ZW1cIikgY29udGludWU7XG4gICAgaWYgKG0ud2hvID09PSBcImFnZW50XCIpIHJldHVybiBudWxsO1xuICAgIHBlbmRpbmcgPSBtO1xuICAgIGJyZWFrO1xuICB9XG4gIGlmICghcGVuZGluZykgcmV0dXJuIG51bGw7XG5cbiAgLy8g4pqgIFRoZSBGSVJTVCBvZiB0aGUgdW5hbnN3ZXJlZCBydW4sIG5vdCB0aGUgbGFzdC4gU29tZW9uZSB3aG8gc2VuZHMgdGhyZWVcbiAgLy8gbWVzc2FnZXMgd2hpbGUgd2FpdGluZyBoYXMgYmVlbiB3YWl0aW5nIHNpbmNlIHRoZSBmaXJzdCBvbmUsIGFuZCByZXNldHRpbmdcbiAgLy8gdGhlIGNsb2NrIG9uIGV2ZXJ5IGZvbGxvdy11cCB3b3VsZCBtZWFuIHRoZSBtb3JlIGFueGlvdXMgdGhleSBnZXQsIHRoZVxuICAvLyBsb25nZXIgd2UgY2xhaW0gdGhleSBoYXZlIGJlZW4gd2FpdGluZyBpcyB6ZXJvLlxuICBsZXQgc2luY2UgPSBwZW5kaW5nLnRzO1xuICBsZXQgbWVzc2FnZUlkID0gcGVuZGluZy5pZDtcbiAgZm9yIChsZXQgaSA9IGNoYXQubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBtID0gY2hhdFtpXTtcbiAgICBpZiAoIW0gfHwgbS53aG8gPT09IFwic3lzdGVtXCIpIGNvbnRpbnVlO1xuICAgIGlmIChtLndobyAhPT0gXCJodW1hblwiKSBicmVhaztcbiAgICBzaW5jZSA9IG0udHM7XG4gICAgbWVzc2FnZUlkID0gbS5pZDtcbiAgfVxuXG4gIHJldHVybiB7IG1lc3NhZ2VJZCwgc2luY2UsIGJhZGdlOiBiYWRnZUZvcihzaW5jZSwgbm93LCBvcHRzKSB9O1xufVxuXG4vKipcbiAqIFB1bHNlIG9yIHN0YWxsZWQsIGZvciBhbnl0aGluZyBvd2VkIGFuIGFuc3dlciBzaW5jZSBgc2luY2VgLiBPTkUgcGxhY2UsIHNvIGFcbiAqIG5vdGUgYW5kIGEgbWVzc2FnZSB3YWl0aW5nIGVxdWFsbHkgbG9uZyBjYW4gbmV2ZXIgcmVhZCBkaWZmZXJlbnRseS5cbiAqL1xuZnVuY3Rpb24gYmFkZ2VGb3IoXG4gIHNpbmNlOiBudW1iZXIsXG4gIG5vdzogbnVtYmVyLFxuICBvcHRzOiB7IHN0YWxsTXM/OiBudW1iZXI7IGFja25vd2xlZGdlZFVudGlsPzogbnVtYmVyIH0sXG4pOiBXYWl0aW5nW1wiYmFkZ2VcIl0ge1xuICBjb25zdCBzdGFsbE1zID0gb3B0cy5zdGFsbE1zID8/IFNUQUxMX01TO1xuICBjb25zdCBhY2tub3dsZWRnZWQgPSBvcHRzLmFja25vd2xlZGdlZFVudGlsICE9PSB1bmRlZmluZWQgJiYgbm93IDwgb3B0cy5hY2tub3dsZWRnZWRVbnRpbDtcbiAgcmV0dXJuIG5vdyAtIHNpbmNlID49IHN0YWxsTXMgJiYgIWFja25vd2xlZGdlZCA/IFwic3RhbGxlZFwiIDogXCJ3b3JraW5nXCI7XG59XG5cbi8vIOKUgOKUgCBFNjU6IHRoZSBzYW1lIHF1ZXN0aW9uLCBhc2tlZCBvZiBhIG5vdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gQWdlbnRzIGFjdCBvbiBuZWFybHkgZXZlcnkgbm90ZSwgYW5kIENvbGUgcnVsZWQgdGhhdCB0aGUgcmlnaHQgaW5zdGluY3Q7IHdoYXRcbi8vIHdhcyBtaXNzaW5nIHdhcyBhbnkgc2lnbiwgYmV0d2VlbiBhZGRpbmcgYSBub3RlIGFuZCB0aGUgYWdlbnQncyBhbnN3ZXIsIHRoYXRcbi8vIHNvbWV0aGluZyB3YXMgaGFwcGVuaW5nLiBTbyBhIG5vdGUgZ2V0cyBFNTMncyB0cmVhdG1lbnQgV0hPTEU6IGRlcml2ZWQsIG5ldmVyXG4vLyBkZWNsYXJlZDsgYSBwdWxzZSwgdGhlbiBhIHN0YXRpYyBcIm1heSBiZSBzdHVja1wiIGF0IHRoZSBzYW1lIDMwIHM7IHRoZSBzYW1lXG4vLyBzbm9vemUuIE5vdGhpbmcgaGVyZSBhc2tzIHRoZSBhZ2VudCBmb3IgYW55dGhpbmcgbmV3LlxuLy9cbi8vIOKblCBXSEFUIEFOU1dFUlMgQSBOT1RFIOKAlCB0aGUgcnVsZSwgYW5kIGVhY2ggcGFydCBpcyBhIGZhY3QgdGhlIGRhZW1vbiBhbHJlYWR5XG4vLyBob2xkczpcbi8vICAgwrcgUkVTT0xWRUQuIFJlc29sdmluZyBpcyB0aGUgYWN0IHRoYXQgY2xvc2VzIGEgbm90ZSAoQ29sZSksIGJ5IGVpdGhlciBwYXJ0eSxcbi8vICAgICBzbyBhIHJlc29sdmVkIG5vdGUgaXMgb3dlZCBub3RoaW5nLiBJdCBpcyB0aGUgbm90ZSdzIG93biBzdG9yZWQgc3RhdGUsXG4vLyAgICAgbm90IGEgY29weSBvZiBpdC5cbi8vICAgwrcgQU4gQUdFTlQgTUVTU0FHRSBBRlRFUiBJVC4gVGhlIGFnZW50IHNwb2tlIHRvIHRoZSBodW1hbiBhZnRlciB0aGUgbm90ZVxuLy8gICAgIHdhcyB3cml0dGVuLCB3aGljaCBpcyB3aGF0IHRoZSBodW1hbiBpcyB3YWl0aW5nIGZvciDigJQgdGhlIHNhbWUgcmVhc29uXG4vLyAgICAgb25lIHJlcGx5IGFuc3dlcnMgRTUzJ3MgcnVuIG9mIG1lc3NhZ2VzLiBJdCBjbGFpbXMgXCJ0aGUgYWdlbnQgaGFzIHNhaWRcbi8vICAgICBzb21ldGhpbmcgc2luY2VcIiwgbmV2ZXIgXCJ0aGUgYWdlbnQgZGVhbHQgd2l0aCB0aGlzXCIsIHNvIGl0IGNsZWFycyB0aGVcbi8vICAgICBwZW5kaW5nIG1hcmsgYW5kIGxlYXZlcyB0aGUgbm90ZSBPUEVOOiBkZWFsdCB3aXRoIGlzIGByZXNvbHZlZGAuXG4vLyAgICAgQ291bnRpbmcgb25seSBgcmVzb2x2ZWRgIHdhcyB0aGUgb3B0aW9uIG5vdCB0YWtlbiDigJQgYW4gYWdlbnQgdmlzaWJseVxuLy8gICAgIHdvcmtpbmcgb24gYSBub3RlIHdvdWxkIGZsaXAgaXQgdG8gXCJtYXkgYmUgc3R1Y2tcIiB3aGVuZXZlciBpdCBmb3Jnb3QgdG9cbi8vICAgICByZXNvbHZlLCBhbmQgRTUzJ3Mgd2hvbGUgcHJlbWlzZSBpcyB0aGF0IGl0IGZvcmdldHMuXG4vLyAgIMK3IFRIRSBBR0VOVCBSRVdSSVRJTkcgVEhJUyBOT1RFLiBBbiBhY3Qgb24gdGhpcyBub3RlLCBzZWVuIG9uIHRoaXMgbm90ZS5cbi8vIOKaoCBBTkQgQSBTWVNURU0gTElORSBJUyBTVElMTCBOT1QgQSBSRVBMWS4gVGhlIGFnZW50IHJlc29sdmluZyBub3RlIEEgaXNcbi8vIG5hcnJhdGVkIGFzIGEgc3lzdGVtIGxpbmU7IGl0IGFuc3dlcnMgQSAoQSBpcyByZXNvbHZlZCkgYW5kIHNheXMgbm90aGluZ1xuLy8gYWJvdXQgQi5cblxuLyoqIFdoYXQgdGhlIHJ1bGUgcmVhZHMgb2ZmIGEgbm90ZSDigJQgdGhlIHN0b3JlZCBmaWVsZHMsIG5vdGhpbmcgcGxhY2VkLiAqL1xudHlwZSBOb3RlRmFjdHMgPSBQaWNrPFxuICBOb3RlLFxuICBcImlkXCIgfCBcIndob1wiIHwgXCJjcmVhdGVkQXRcIiB8IFwiZWRpdGVkQXRcIiB8IFwiZWRpdGVkQnlcIiB8IFwicmVvcGVuZWRBdFwiIHwgXCJyZW9wZW5lZEJ5XCIgfCBcInJlc29sdmVkXCJcbj47XG5cbi8qKlxuICogV2hlbiB0aGUgaHVtYW4gbGFzdCB3cm90ZSBpbnRvIHRoaXMgbm90ZSwgb3IgbnVsbCBpZiB0aGV5IG5ldmVyIGRpZCBvciB0aGVcbiAqIGFnZW50IGhhcyBhY3RlZCBvbiBpdCBzaW5jZS4gQSB3cml0ZSBpcyBtYWtpbmcgaXQsIHJld3JpdGluZyBpdCwgb3JcbiAqIFJFT1BFTklORyBpdCDigJQgZWFjaCBvbmUgYSBodW1hbiBwdXR0aW5nIHRoZSBub3RlIGluIGZyb250IG9mIHRoZSBhZ2VudFxuICogKHZlcmlmaWVyOiBhIHJlb3BlbiB1c2VkIHRvIGNvbWUgYmFjayB0aW1lZCBmcm9tIHdoZW4gdGhlIG5vdGUgd2FzIG1hZGUsIHNvXG4gKiBpdCBjb3VsZCByZWFwcGVhciBhbHJlYWR5IFwibWF5IGJlIHN0dWNrXCIpLiBUaGUgYWdlbnQgcmV3cml0aW5nIG9yIHJlb3BlbmluZ1xuICogaXQgaXMgYW4gYWN0IG9uIHRoaXMgbm90ZSwgYW5kIGFuc3dlcnMgaXQuIEFuIGVkaXQgd2hvc2UgYXV0aG9yIHdhcyBub3RcbiAqIHJlY29yZGVkIChiZWZvcmUgRTY1KSBpcyBub3QgZXZpZGVuY2UgZWl0aGVyIHdheS5cbiAqL1xuZnVuY3Rpb24gaHVtYW5Xcm90ZUF0KG46IE5vdGVGYWN0cyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBhY3RzOiB7IGF0OiBudW1iZXI7IGJ5OiBcImh1bWFuXCIgfCBcImFnZW50XCIgfVtdID0gW3sgYXQ6IG4uY3JlYXRlZEF0LCBieTogbi53aG8gfV07XG4gIGlmIChuLmVkaXRlZEF0ICE9PSB1bmRlZmluZWQgJiYgbi5lZGl0ZWRCeSkgYWN0cy5wdXNoKHsgYXQ6IG4uZWRpdGVkQXQsIGJ5OiBuLmVkaXRlZEJ5IH0pO1xuICBpZiAobi5yZW9wZW5lZEF0ICE9PSB1bmRlZmluZWQgJiYgbi5yZW9wZW5lZEJ5KSBhY3RzLnB1c2goeyBhdDogbi5yZW9wZW5lZEF0LCBieTogbi5yZW9wZW5lZEJ5IH0pO1xuICBsZXQgbGFzdCA9IGFjdHNbMF0gYXMgeyBhdDogbnVtYmVyOyBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiIH07XG4gIGZvciAoY29uc3QgYSBvZiBhY3RzKSBpZiAoYS5hdCA+PSBsYXN0LmF0KSBsYXN0ID0gYTtcbiAgcmV0dXJuIGxhc3QuYnkgPT09IFwiaHVtYW5cIiA/IGxhc3QuYXQgOiBudWxsO1xufVxuXG4vKipcbiAqIEV2ZXJ5IG5vdGUgb3dlZCBhbiBhbnN3ZXIsIG9sZGVzdCBmaXJzdC5cbiAqXG4gKiDim5QgQSBOT1RFIFRIRSBIVU1BTiBIQVMgQVNLRUQgQUJPVVQgd2FpdHMgT04gVEhBVCBNRVNTQUdFICh2ZXJpZmllciBEMSkuIFwiQXNrXG4gKiB0aGUgYWdlbnRcIiBwb3N0cyBhIG1lc3NhZ2UgY2FycnlpbmcgdGhlIG5vdGUncyByZWZlcmVuY2U7IHdoaWxlIHRoYXQgbWVzc2FnZVxuICogaXMgdW5hbnN3ZXJlZCwgdGhlIG5vdGUgc2F5cyBpdCB3YXMgYXNrZWQsIGFuZCBpdHMgYmFkZ2UgSVMgRTUzJ3MgYmFkZ2UgZm9yXG4gKiB0aGUgY29udmVyc2F0aW9uIOKAlCBub3QgYSBzZWNvbmQgY2xvY2sgdGhhdCBjb3VsZCBkaXNhZ3JlZSB3aXRoIGl0LiBUaGVyZSBpc1xuICogbm8gXCJhc2tlZFwiIGZsYWc6IGl0IGlzIHJlYWQgb2ZmIHRoZSBjb252ZXJzYXRpb24gbGlrZSBldmVyeXRoaW5nIGVsc2UgaGVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vdGVzV2FpdGluZyhcbiAgZG9jczogcmVhZG9ubHkgeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiByZWFkb25seSBOb3RlRmFjdHNbXSB9W10sXG4gIGNoYXQ6IHJlYWRvbmx5IE1zZ1tdLFxuICBub3c6IG51bWJlcixcbiAgb3B0czogeyBzdGFsbE1zPzogbnVtYmVyOyBhY2tub3dsZWRnZWRVbnRpbD86IG51bWJlciB9ID0ge30sXG4pOiBOb3RlV2FpdGluZ1tdIHtcbiAgbGV0IGxhc3RBZ2VudCA9IE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgZm9yIChjb25zdCBtIG9mIGNoYXQpIGlmIChtLndobyA9PT0gXCJhZ2VudFwiICYmIG0udHMgPiBsYXN0QWdlbnQpIGxhc3RBZ2VudCA9IG0udHM7XG4gIGNvbnN0IHdhaXQgPSB3YWl0aW5nT24oY2hhdCwgbm93LCBvcHRzKTtcbiAgY29uc3Qgb3V0OiBOb3RlV2FpdGluZ1tdID0gW107XG4gIGZvciAoY29uc3QgZCBvZiBkb2NzKVxuICAgIGZvciAoY29uc3QgbiBvZiBkLm5vdGVzKSB7XG4gICAgICBpZiAobi5yZXNvbHZlZCkgY29udGludWU7XG4gICAgICBjb25zdCBzaW5jZSA9IGh1bWFuV3JvdGVBdChuKTtcbiAgICAgIC8vIOKaoCBTVFJJQ1RMWSBhZnRlcjogYSByZXBseSBpbiB0aGUgc2FtZSBtaWxsaXNlY29uZCBjYW5ub3QgaGF2ZSByZWFkIGl0LlxuICAgICAgaWYgKHNpbmNlID09PSBudWxsIHx8IGxhc3RBZ2VudCA+IHNpbmNlKSBjb250aW51ZTtcbiAgICAgIC8vIEFueSBhc2sgYWZ0ZXIgdGhlIG5vdGUncyBsYXN0IHdyaXRlIGlzIHVuYW5zd2VyZWQgYnkgY29uc3RydWN0aW9uOiBhXG4gICAgICAvLyByZXBseSBhZnRlciBpdCB3b3VsZCBiZSBhZnRlciB0aGUgbm90ZSB0b28sIGFuZCBjbGVhcmVkIGl0IGFib3ZlLlxuICAgICAgY29uc3QgYXNrZWQgPSB3YWl0XG4gICAgICAgID8gY2hhdC5maW5kTGFzdChcbiAgICAgICAgICAgIChtKSA9PlxuICAgICAgICAgICAgICBtLndobyA9PT0gXCJodW1hblwiICYmIG0udHMgPj0gc2luY2UgJiYgbS5ub3RlPy5kb2MgPT09IGQuc2x1ZyAmJiBtLm5vdGUuaWQgPT09IG4uaWQsXG4gICAgICAgICAgKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIG91dC5wdXNoKFxuICAgICAgICBhc2tlZCAmJiB3YWl0XG4gICAgICAgICAgPyB7IGRvYzogZC5zbHVnLCBub3RlSWQ6IG4uaWQsIHNpbmNlLCBiYWRnZTogd2FpdC5iYWRnZSwgYXNrZWRJbjogYXNrZWQuaWQgfVxuICAgICAgICAgIDogeyBkb2M6IGQuc2x1Zywgbm90ZUlkOiBuLmlkLCBzaW5jZSwgYmFkZ2U6IGJhZGdlRm9yKHNpbmNlLCBub3csIG9wdHMpIH0sXG4gICAgICApO1xuICAgIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiBhLnNpbmNlIC0gYi5zaW5jZSk7XG59XG5cbi8qKlxuICogV2hhdCBFNTMncyBhdHRlbnRpb24gdGljayBjb21wYXJlcyB0byBkZWNpZGUgd2hldGhlciB0aGUgc3VyZmFjZSBuZWVkcyBhIG5ld1xuICogc25hcHNob3Q6IHRoZSBtZXNzYWdlIHdhaXQgYW5kIGV2ZXJ5IG93ZWQgbm90ZSwgd2l0aCB0aGVpciBiYWRnZXMuIOKblCBBIG5vdGVcbiAqIGZsaXBwaW5nIHRvIFwibWF5IGJlIHN0dWNrXCIgaGFwcGVucyB3aXRoIG5vdGhpbmcgZWxzZSBjaGFuZ2luZyDigJQgbm8gbWVzc2FnZSxcbiAqIG5vIGFjdCDigJQgc28gaWYgdGhpcyBrZXkgY291bGQgbm90IHNlZSBub3RlcywgdGhlIHB1bHNlIHdvdWxkIHJ1biBvbiBvdmVyIGFcbiAqIHN0dWNrIG5vdGUgdW50aWwgc29tZXRoaW5nIHVucmVsYXRlZCByZS1zZW50IHRoZSBzdGF0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGF0dGVudGlvbktleSh3OiBXYWl0aW5nIHwgbnVsbCwgbm90ZXM6IHJlYWRvbmx5IE5vdGVXYWl0aW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgIHcgPyBgJHt3Lm1lc3NhZ2VJZH06JHt3LmJhZGdlfWAgOiBcIi1cIixcbiAgICAuLi5ub3Rlcy5tYXAoKG4pID0+IGAke24uZG9jfS8ke24ubm90ZUlkfToke24uYmFkZ2V9JHtuLmFza2VkSW4gPyBgQCR7bi5hc2tlZElufWAgOiBcIlwifWApLFxuICBdLmpvaW4oXCJ8XCIpO1xufVxuXG4vKipcbiAqIEhvdyBtdWNoIG9mIGEgbm90ZSBgbm90ZS5hZGRlZGAgY2FycmllczogdGhlIHF1b3RlIGFuZCB0aGUgYm9keSB0b2dldGhlciwgaW5cbiAqIGNoYXJhY3RlcnMuIEEgcGFyYWdyYXBoJ3Mgd29ydGguIE5vdGVzIGFyZSBtYWRlIG1pZC1yZWFkLCBvbiBhIHBocmFzZSBvciBhXG4gKiBzZW50ZW5jZSwgYW5kIHRob3NlIHRyYXZlbCB3aG9sZSBzbyB0aGUgYWdlbnQgY2FuIGFjdCB3aXRob3V0IGEgcm91bmQgdHJpcC5cbiAqIEEgbm90ZSBvdmVyIGEgd2hvbGUgc2VjdGlvbiBpcyB3aGVyZSB0aGUgcm91bmQgdHJpcCBwYXlzOiBgbm90ZXNgIGFsc28gc2F5c1xuICogd2hldGhlciB0aGUgcGFzc2FnZSBzdGlsbCBzdGFuZHMgYW5kIHdoZXJlIGl0IGlzIG5vdy4gVGhlIG9uZSB3aG8gYWN0cyBvblxuICogdGhpcyBudW1iZXIgaXMgdGhlIGFnZW50IHJlYWRpbmcgaXRzIHRhaWwuXG4gKi9cbmV4cG9ydCBjb25zdCBOT1RFX1RFWFRfTUFYID0gMTAwMDtcblxuLyoqXG4gKiBXaGF0IGBub3RlLmFkZGVkYCAoYW5kIGEgaHVtYW4ncyBgbm90ZS5lZGl0ZWRgKSB0ZWxscyB0aGUgYWdlbnQgYmV5b25kIHRoZSBpZHNcbiAqIChFNjUpLiBUaGUgZXZlbnQgbmFtZXMgaXRzIG5leHQgYWN0LCBiZWNhdXNlIGFuIGFnZW50IHRoYXQgbXVzdCBnbyBhbmQgYXNrXG4gKiB3aGF0IGFycml2ZWQgaXMgYW4gYWdlbnQgb25lIHN0ZXAgZnVydGhlciBmcm9tIGRvaW5nIGl0LlxuICpcbiAqIOKblCBXSE9MRSBPUiBOT1QgQVQgQUxMLCBuZXZlciB0cnVuY2F0ZWQuIEEgY2xpcHBlZCBxdW90ZSByZWFkcyBhcyB0aGUgd2hvbGVcbiAqIHBhc3NhZ2UsIHdoaWNoIGlzIHdvcnNlIHRoYW4gbm8gcXVvdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3RlRXZlbnRGYWN0cyhcbiAgc2x1Zzogc3RyaW5nLFxuICBub3RlOiB7IGlkOiBzdHJpbmc7IHF1b3RlOiBzdHJpbmc7IGJvZHk6IHN0cmluZyB9LFxuICBsaW5lczogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfSB8IG51bGwsXG4pOiB7XG4gIGxpbmVzPzogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfTtcbiAgcXVvdGU/OiBzdHJpbmc7XG4gIGJvZHk/OiBzdHJpbmc7XG4gIHBhc3NhZ2U/OiBcImdvbmVcIjtcbiAgaGludDogc3RyaW5nO1xufSB7XG4gIGNvbnN0IGNsb3NlID0gYG5vdGUtcmVzb2x2ZSAke25vdGUuaWR9IC0tZG9jICR7c2x1Z31gO1xuICAvLyDimqAgQSBub3RlIHdob3NlIHBhc3NhZ2UgaXMgbm8gbG9uZ2VyIGluIHRoZSBhY3RpdmUgdmVyc2lvbiBoYXMgbm8gbGluZXMsIGFuZFxuICAvLyBtdXN0IFNBWSBzbyAodmVyaWZpZXIgRDUpIOKAlCBvdGhlcndpc2UgXCJhY3Qgb24gaXRcIiBzZW5kcyB0aGUgYWdlbnQgbG9va2luZ1xuICAvLyBmb3IgdGV4dCB0aGF0IGlzIG5vdCB0aGVyZS5cbiAgY29uc3QgYXQgPSBsaW5lcyA/IHsgbGluZXMgfSA6IHsgcGFzc2FnZTogXCJnb25lXCIgYXMgY29uc3QgfTtcbiAgLy8gQ0hBUkFDVEVSUywgbm90IFVURi0xNiB1bml0czogYW4gZW1vamkgaXMgb25lIGNoYXJhY3RlciB0byB3aG9ldmVyIHdyb3RlIGl0LlxuICBjb25zdCBzaXplID0gWy4uLm5vdGUucXVvdGVdLmxlbmd0aCArIFsuLi5ub3RlLmJvZHldLmxlbmd0aDtcbiAgaWYgKHNpemUgPD0gTk9URV9URVhUX01BWClcbiAgICByZXR1cm4ge1xuICAgICAgLi4uYXQsXG4gICAgICBxdW90ZTogbm90ZS5xdW90ZSxcbiAgICAgIGJvZHk6IG5vdGUuYm9keSxcbiAgICAgIGhpbnQ6IGxpbmVzXG4gICAgICAgID8gYGFjdCBvbiBpdCwgdGhlbiBcXGAke2Nsb3NlfVxcYCB3aGVuIGl0IGlzIGRlYWx0IHdpdGhgXG4gICAgICAgIDogYGl0cyBwYXNzYWdlIGlzIG5vIGxvbmdlciBpbiB0aGUgYWN0aXZlIHZlcnNpb24g4oCUIHNlZSBcXGBub3RlcyAtLWRvYyAke3NsdWd9XFxgLCB0aGVuIGFjdCBvbiBpdCBhbmQgXFxgJHtjbG9zZX1cXGAgd2hlbiBpdCBpcyBkZWFsdCB3aXRoYCxcbiAgICB9O1xuICByZXR1cm4ge1xuICAgIC4uLmF0LFxuICAgIGhpbnQ6IGB0b28gbG9uZyB0byBjYXJyeSR7bGluZXMgPyBcIlwiIDogXCIsIGFuZCBpdHMgcGFzc2FnZSBpcyBubyBsb25nZXIgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uXCJ9IOKAlCByZWFkIGl0IHdpdGggXFxgbm90ZXMgLS1kb2MgJHtzbHVnfVxcYCwgYWN0IG9uIGl0LCB0aGVuIFxcYCR7Y2xvc2V9XFxgYCxcbiAgfTtcbn1cblxuLyoqIFdoYXQgdGhlIGNvbnZlcnNhdGlvbiBzaG93cywgcGVyIGJhZGdlLiBtaW5kLW1hcHBlcidzIHdvcmRzLCBuZWFyIGVub3VnaC4gKi9cbmV4cG9ydCBjb25zdCBXQUlUSU5HX0xBQkVMOiBSZWNvcmQ8V2FpdGluZ1tcImJhZGdlXCJdLCBzdHJpbmc+ID0ge1xuICB3b3JraW5nOiBcIndvcmtpbmcgb24gdGhpc+KAplwiLFxuICBzdGFsbGVkOiBcInRvb2sgdGhpcyBpbiwgdGhlbiB3ZW50IHF1aWV0IOKAlCBtYXkgYmUgc3R1Y2tcIixcbn07XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBcURBLHVCQUFTLDZCQUE0QiwyQkFBYyx5QkFBVTtBQUM3RCxvQkFBUztBQUNULHFCQUFTLHNCQUFVLHdCQUFTLHFCQUFZLGtCQUFNO0FBQzlDO0FBQ0Esc0JBQVM7OztBQzNDVDtBQXFCTyxTQUFTLGVBQWUsQ0FBQyxRQUFnQixNQUFvQjtBQUFBLEVBQ2xFLE1BQU0sTUFBTSxHQUFHLFVBQVUsUUFBUTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLGNBQWMsS0FBSyxJQUFJO0FBQUEsSUFDdkIsV0FBVyxLQUFLLE1BQU07QUFBQSxJQUN0QixPQUFPLEtBQUs7QUFBQSxJQUNaLElBQUk7QUFBQSxNQUNGLE9BQU8sS0FBSyxFQUFFLE9BQU8sS0FBSyxDQUFD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RztBQUFBLElBQ1YsUUFBUSxPQUFPLE1BQ2IsZ0JBQWdCLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsc0JBQTBCLE9BQU8sS0FDeEYsY0FDRixFQUNHLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRyxFQUNuQixLQUFLLEdBQUc7QUFBQSxDQUNiO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUVULElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLElBQUksTUFBTSxZQUFZO0FBQUEsTUFDcEIsTUFBTSxNQUFNLE9BQU8sT0FBTyxNQUFNLElBQUksSUFBSTtBQUFBLE1BQ3hDLFNBQVMsTUFBTTtBQUFBLE1BQ2YsVUFBVSxNQUFNLFVBQVUsT0FBTyxNQUFNLE9BQU8sSUFBSTtBQUFBLE1BQ2xELFdBQVcsTUFBTTtBQUFBLElBQ25CLENBQUM7QUFBQSxJQUNELE9BQU8sR0FBRztBQUFBLElBRVYsTUFBTSxTQUFTLGFBQWEsZUFBZSxFQUFFLFNBQVM7QUFBQSxJQUN0RCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxRQUFRLE9BQU8sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsQ0FDNUY7QUFBQSxJQUNBLE9BQU8sV0FBVyxNQUFNLElBQUksV0FBVyxNQUFNLElBQUk7QUFBQTtBQUFBLEVBRW5ELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsS0FBSyxvQkFBb0IsRUFBRSxRQUFRLE1BQU0sRUFBRSxNQUFNLFlBQVksRUFBRSxXQUFXLE1BQU0sRUFBRSxNQUFNLEtBQUssRUFBRSxJQUFJLENBQUM7QUFBQSxDQUMxSDtBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sRUFBRTtBQUFBLEVBQ3BCLE1BQU0sRUFBRTtBQUFBLEVBRVIsSUFBSSxJQUFJLFNBQVMsS0FBSyxNQUFNLEtBQUs7QUFBQSxJQUMvQixJQUFJO0FBQUEsTUFDRixJQUFJLFVBQVMsTUFBTSxHQUFHLEVBQUUsU0FBUztBQUFBLFFBQUcsWUFBVyxNQUFNLEdBQUc7QUFBQSxNQUN4RCxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsT0FBTyxJQUFJO0FBQUE7QUFRYixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJENjlCN0QwMTNERTFFOEVDNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
