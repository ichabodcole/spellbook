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
  if (n.editedAt !== undefined && n.editedBy === "human")
    return n.editedAt;
  if (n.editedAt !== undefined && n.editedBy === "agent")
    return null;
  return n.who === "human" ? n.createdAt : null;
}
function notesWaiting(docs, chat, now, opts = {}) {
  let lastAgent = Number.NEGATIVE_INFINITY;
  for (const m of chat)
    if (m.who === "agent" && m.ts > lastAgent)
      lastAgent = m.ts;
  const out = [];
  for (const d of docs)
    for (const n of d.notes) {
      if (n.resolved)
        continue;
      const since = humanWroteAt(n);
      if (since === null || lastAgent > since)
        continue;
      out.push({ doc: d.slug, noteId: n.id, since, badge: badgeFor(since, now, opts) });
    }
  return out.sort((a, b) => a.since - b.since);
}
var NOTE_TEXT_MAX = 1000;
function noteEventFacts(slug, note, lines) {
  const close = `note-resolve ${note.id} --doc ${slug}`;
  const at = lines ? { lines } : {};
  if (note.quote.length + note.body.length <= NOTE_TEXT_MAX)
    return {
      ...at,
      quote: note.quote,
      body: note.body,
      hint: `act on it, then \`${close}\` when it is dealt with`
    };
  return {
    ...at,
    hint: `too long to carry \u2014 read it with \`notes --doc ${slug}\`, act on it, then \`${close}\``
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
    const key = [
      w ? `${w.messageId}:${w.badge}` : "-",
      ...notes.map((n) => `${n.noteId}:${n.badge}`)
    ].join("|");
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

//# debugId=18A433E2CC9A124864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL29yaWdpbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc2VydmVEaXN0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9zc2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvYW5jaG9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9kaWZmLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2RvY3Rvci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oaXN0b3J5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZXNzaW9uLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2Zyb250bWF0dGVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2xpbmtzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VhcmNoLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3dhaXRpbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIHBlci1zZXNzaW9uIGRhZW1vbiDigJQgdGhlIHByb2Nlc3MgdGhlIHN1cmZhY2UgdGFsa3MgdG8gb3ZlciBhXG4gKiBXZWJTb2NrZXQgYW5kIHRoZSBDTEkgdGFsa3MgdG8gb3ZlciBIVFRQLiBMYXVuY2hlZCBieVxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9zY3JpcHRvcml1bS9zY3JpcHRzL3NlcnZlci50c2AgKHRoZSBsYXVuY2hlciksIHdoaWNoXG4gKiBpbXBvcnRzIHRoZSBCVUlMVCBgZGlzdC9zZXJ2ZXIuanNgLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBgU0tJTExfUk9PVGAvYERJU1RfRElSYCBvbmx5LCBmb3IgdGhlIGtpdCdzIGByZXNvbHZlTW9kZWAgYW5kXG4gKiAgICBgc2VydmVGcm9tRGlzdGAsIGFuZCB0cnVlIGF0IHRoZSBFTUlUVEVEIGFkZHJlc3MgKGBkaXN0L3NlcnZlci5qc2AsIHdob3NlXG4gKiAgICBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIpLiBOb3RoaW5nIGVsc2UgaXMgcGlubmVkIG9mZiBgaW1wb3J0Lm1ldGFgLlxuICogMi4gU2VydmVzOiBZRVMuIGAvYCBpcyB0aGUgYnVpbHQgYGluZGV4Lmh0bWxgIHZpYSBgc2VydmVGcm9tRGlzdGAsIG5vXG4gKiAgICBzdWJzdGl0dXRpb247IHRoZSBvbmx5IHJvdXRlcyBvZiBpdHMgb3duIGFyZSBgL3N0YXRlYCwgYC9jbWRgLCBgL2V2ZW50c2AsXG4gKiAgICBgL3dzYCBhbmQgYC9mcy8qYCAocmVhZC1vbmx5OiBhIHZlcnNpb24ncyB0ZXh0LCBhIGRpcmVjdG9yeSBsaXN0aW5nKS5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIGBjbGkudHNgOyB0aGUgdHdvIHNoYXJlIGAuL2hlYXJ0YmVhdC50c2AuXG4gKiA0LiBMaWZlY3ljbGU6IGxvbmctcnVubmluZywgb25lIGRhZW1vbiBwZXIgc2Vzc2lvbiwgaWRsZS10aW1lb3V0IGxpa2VcbiAqICAgIGdsYW1vdXIgKGxpbmdlciBhZnRlciB0aGUgbGFzdCBzdWJzY3JpYmVyIGxlYXZlczsgZXhpdCAxMjQpLlxuICogNS4gYG1haW4oKWAgcmV0dXJucyB3aGlsZSB0aGUgcHJvY2VzcyBtdXN0IGxpdmU/IE5PIOKAlCBgbWFpbmAgYXdhaXRzIHRoZVxuICogICAgc2Vzc2lvbidzIGVuZCBhbmQgaXRzIG93biBkcmFpbiwgZXhhY3RseSBhcyBnbGFtb3VyJ3Mgc2VydmVyIGRvZXMsIHNvIHRoZVxuICogICAgbGF1bmNoZXIgaXMgVEVSTUlOQUwtRVhJVCAoYHByb2Nlc3MuZXhpdChhd2FpdCBydW4oKSlgKTogb25jZSBgbWFpbmBcbiAqICAgIHJlc29sdmVzIG5vdGhpbmcgbWF5IGtlZXAgdGhlIHByb2Nlc3MgYWxpdmUsIGFuZCBhIHdhdGNoZXIgaGFuZGxlIG9yIGFcbiAqICAgIHN0cmFnZ2xpbmcgc29ja2V0IHdvdWxkLiBEcml2ZW4sIG5vdCByZWFkIChzZWUgdGhlIHNsaWNlLUEgam91cm5hbCkuXG4gKiA2LiBFdmVudCBpZHMgcmVjb3ZlcmVkIGFjcm9zcyByZXN0YXJ0PyBOTyDigJQgdGhlIGxvZyBpcyBpbiBtZW1vcnkgYW5kIGlkc1xuICogICAgcmVzdGFydCBhdCAxLCBldmVuIHVuZGVyIGAtLXJlc3RvcmVgICh3aGljaCByZXN0b3JlcyB0aGUgTUFOSUZFU1QsIG5vdCB0aGVcbiAqICAgIGxvZykuIFNvIHRoZSBsb2cgaXMgc3RhbXBlZCB3aXRoIGEgcGVyLWJvb3QgRVBPQ0ggKG1pbmQtbWFwcGVyJ3Mgc2hhcGUpXG4gKiAgICBhbmQgdGhlIHRhaWwgcmVzZXRzIGl0cyBjdXJzb3Igd2hlbiB0aGUgZXBvY2ggY2hhbmdlcy5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vIOKAlCB0aGUgc2hhcGUgd2FzIGNob3NlbiB0byBiZSB0aGVcbiAqICAgIGtpdCdzLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IE5POiBzY3JpcHRvcml1bVxuICogICAgaXMgdGhlIGZpcnN0IHNwZWxsIHNjYWZmb2xkZWQgYWZ0ZXIgdGhlIGNvbnZlcmdlbmNlLlxuICpcbiAqIOKUgOKUgCBLSVQgVkVSRElDVFMgKHBsYXlib29rIE40KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBlcnJvcnMgU1VCSkVDVCAodGhlIENMSTsgdGhlIGRhZW1vbiBhbnN3ZXJzIEhUVFAgc3RhdHVzZXMgdGhlIENMSSBtYXBzKSDCt1xuICogc2VydmVEaXN0IFNVQkpFQ1QgKGByZXNvbHZlTW9kZWAsIGBzZXJ2ZUZyb21EaXN0YCkgwrcgaG91c2VrZWVwaW5nIFNVQkpFQ1QsIGFsbFxuICogdGhyZWUgZXhwb3J0cyAoYHNob3VsZElkbGVDbG9zZWAgdmlhIGBzdGFydEhvdXNla2VlcGluZ2AncyBpZGxlLWNsb3NlLCB0aGVcbiAqIHNuYXBzaG90IHN3ZWVwIOKAlCBoZXJlIHRoZSBtYW5pZmVzdCBpcyB3cml0dGVuIG9uIGV2ZXJ5IGNoYW5nZSBpbnN0ZWFkLCBzbyB0aGVcbiAqIHN3ZWVwJ3Mgc25hcHNob3QgaG9vayBpcyBkZWxpYmVyYXRlbHkgTk9UIHBhc3NlZCDigJQgYW5kIGBkcmFpbkFuZFN0b3BgKSDCt1xuICogdGFpbEV2ZW50cyBTVUJKRUNUICh0aGUgQ0xJJ3MgYHRhaWxgKSDCtyBoZWFydGJlYXQgU1VCSkVDVCAoYC4vaGVhcnRiZWF0LnRzYCkgwrdcbiAqIGRpc2NvdmVyeSBTVUJKRUNUIChzZXNzaW9uLUpTT04sIEUxMzogYHNjcmlwdG9yaXVtLTxpZD4uanNvbmAgK1xuICogYHNjcmlwdG9yaXVtLWxhdGVzdC5qc29uYCBpbiB0bXBkaXIgdmlhIGB3cml0ZUZpbGVBdG9taWNgL2B1bmxpbmtJZk1hdGNoZXNgKSDCt1xuICogZXZlbnRMb2cgU1VCSkVDVCwgV0lUSCBFUE9DSCAoUTYpIMK3IHNzZSBTVUJKRUNUIChgR0VUIC9ldmVudHNgKSDCt1xuICogbGliL3ByaW50SnNvbiBTVUJKRUNUICh0aGUgQ0xJIHNwZWFrcyB0aGUgYWdlbnQgd2lyZSkuXG4gKlxuICog4pSA4pSAIFRFQVJET1dOIE9SREVSIChyZWdpc3RlciBBNiksIFNUQVRFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBnbGFtb3VyJ3Mgb3JkZXI6IHN0b3AgaG91c2VrZWVwaW5nIOKGkiBjbG9zZSB0aGUgd2F0Y2hlcnMg4oaSIHBlcnNpc3QgdGhlXG4gKiBtYW5pZmVzdCDihpIgdW5saW5rIGRpc2NvdmVyeSDihpIgZW1pdCBgY2xvc2VkYCDihpIgZHJhaW4uIERpc2NvdmVyeSBnb2VzIEJFRk9SRSB0aGVcbiAqIGBjbG9zZWRgIGZyYW1lIHNvIGEgdGFpbCB0aGF0IHNlZXMgYGNsb3NlZGAgYW5kIGEgQ0xJIHZlcmIgdGhhdCBydW5zIHJpZ2h0XG4gKiBhZnRlciBpdCBib3RoIGZpbmQgbm8gcG9pbnRlciB0byBhIGRhZW1vbiB0aGF0IGlzIGxlYXZpbmc7IHRoZSBvdGhlciBvcmRlclxuICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGEgdmVyYiByZXNvbHZlcyBhIHNlc3Npb24gdGhhdCB3aWxsIHJlZnVzZSBpdC5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVmdXNlRm9yZWlnbk9yaWdpbiB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9vcmlnaW4udHNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlIGFzIHJlc29sdmVNb2RlSW4sIHNlcnZlRnJvbURpc3QgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc2VydmVEaXN0LnRzXCI7XG5pbXBvcnQgeyB0eXBlIFNzZUNsaWVudHMsIHNzZVJlc3BvbnNlIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NzZS50c1wiO1xuaW1wb3J0IHsgcXVvdGVMYWJlbCB9IGZyb20gXCIuL2FuY2hvcnNcIjtcbmltcG9ydCB7IHVuaWZpZWQgfSBmcm9tIFwiLi9kaWZmXCI7XG5pbXBvcnQgeyBzdW1tYXJ5IH0gZnJvbSBcIi4vZG9jdG9yXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyB0eXBlIEFjdCwgdHlwZSBBZnRlciwgdHlwZSBCZWZvcmUsIEhpc3RvcnksIHR5cGUgSW52ZXJzZSwgcGxhbkludmVyc2UgfSBmcm9tIFwiLi9oaXN0b3J5XCI7XG5pbXBvcnQgeyB0eXBlIFBpY2tLaW5kLCBwYXJzZVBpY2tlck91dHB1dCwgcGlja2VyQ29tbWFuZCwgd2FzQ2FuY2VsbGVkIH0gZnJvbSBcIi4vcGlja2VyXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEFnZW50Q21kLFxuICBDbGllbnRNc2csXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFNlcnZlck1zZyxcbiAgU3RydWN0dXJlT3AsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yLCBzaWRlTmFtZSB9IGZyb20gXCIuL3Nlc3Npb25cIjtcbmltcG9ydCB7IGxpc3REaXIsIFBhdGhFcnJvciB9IGZyb20gXCIuL3RyZWVcIjtcbmltcG9ydCB7IERFRkFVTFRfU05PT1pFX01TLCBub3RlRXZlbnRGYWN0cywgbm90ZXNXYWl0aW5nLCB3YWl0aW5nT24gfSBmcm9tIFwiLi93YWl0aW5nXCI7XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcblxuLyoqIHJlbGVhc2UgaWZmIGBkaXN0L2luZGV4Lmh0bWxgIGV4aXN0cyBhdCB0aGUgc2tpbGwgcm9vdDsgdGhlIGVudiB2YXIgb3ZlcnJpZGVzIChDb250cmFjdCAxKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZSgpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICByZXR1cm4gcmVzb2x2ZU1vZGVJbihESVNUX0RJUik7XG59XG5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG4vKiogYCRTQ1JJUFRPUklVTV9IT01FYCwgZGVmYXVsdCBgfi8uc2NyaXB0b3JpdW1gLiBgcHJvbXB0cy5qc29uYCBiZXNpZGUgYHNlc3Npb25zL2AgaXMgc2xpY2UgQidzIChFOSkuICovXG5leHBvcnQgZnVuY3Rpb24gc2NyaXB0b3JpdW1Ib21lKCk6IHN0cmluZyB7XG4gIHJldHVybiByZXNvbHZlKHByb2Nlc3MuZW52LlNDUklQVE9SSVVNX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLnNjcmlwdG9yaXVtXCIpKTtcbn1cblxuZXhwb3J0IHR5cGUgU3RhcnRPcHRzID0ge1xuICBwb3J0PzogbnVtYmVyO1xuICByZXN0b3JlPzogc3RyaW5nO1xuICB0aW1lb3V0Uz86IG51bWJlcjtcbiAgLyoqIEUyMzogYSBORVcgc2Vzc2lvbidzIHdvcmtzcGFjZSDigJQgdGhlIGRpcmVjdG9yeSBgb3BlbmAgcmFuIGluLiBBIHJlc3RvcmUga2VlcHMgaXRzIG93bi4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIEEgdGFpbCBmcmFtZSdzIHBheWxvYWQuIFRoZSBsb2cgc3RhbXBzIGBpZGAgYW5kIGBlcG9jaGAuICovXG50eXBlIExvZ0V2ZW50ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHR5cGU6IHN0cmluZyB9O1xuXG4vKiogSG93IGxvbmcgYSBidXJzdCBvZiB3YXRjaGVyIGV2ZW50cyBvbiBvbmUgcGF0aCBzZXR0bGVzIGJlZm9yZSBpdCBpcyByZWFkLiAqL1xuY29uc3QgV0FUQ0hfU0VUVExFX01TID0gNjA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydERhZW1vbihvcHRzOiBTdGFydE9wdHMpIHtcbiAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAvLyBNb2RlIEJFRk9SRSBhbnkgd3JpdGU6IGEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3RcbiAgLy8gZGllIGF0IHRoZSBpbXBvcnQgaGF2aW5nIGNyZWF0ZWQgbm90aGluZyAoZ2xhbW91cidzIG1lYXN1cmVkIG9yZGVyKS5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IG9wdHMucmVzdG9yZVxuICAgID8gU2Vzc2lvbi5yZXN0b3JlKGhvbWUsIG9wdHMucmVzdG9yZSlcbiAgICA6IFNlc3Npb24uY3JlYXRlKGhvbWUsIHVuZGVmaW5lZCwgb3B0cy53b3Jrc3BhY2UpO1xuICBjb25zdCBzZXNzaW9uSWQgPSBzZXNzaW9uLmlkO1xuICBsZXQgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsID0gbnVsbDtcblxuICAvLyAtLS0gcHJlZnM6IHBlci12aWV3ZXIgY29udmVuaWVuY2VzIHRoYXQgb3V0bGl2ZSBhIHNlc3Npb24ncyBwb3J0IC0tLS0tLS0tLS0tLVxuICAvLyBCcm93c2VyIHN0b3JhZ2UgaXMga2V5ZWQgYnkgb3JpZ2luLCBwb3J0IGluY2x1ZGVkLCBhbmQgZXZlcnkgc2Vzc2lvbiBnZXRzIGFcbiAgLy8gbmV3IHBvcnQg4oCUIHNvIGEgcGFuZSBzaXplIGtlcHQgaW4gbG9jYWxTdG9yYWdlIHJlc2V0cyBhdCB0aGUgbmV4dCBgb3BlbmAuXG4gIC8vIFRoZXkgbGl2ZSBpbiB0aGUgaG9tZSBpbnN0ZWFkLCBzaGFyZWQgYnkgZXZlcnkgc2Vzc2lvbiBvZiB0aGlzIGhvbWUuXG4gIGNvbnN0IHByZWZzRmlsZSA9IGpvaW4oaG9tZSwgXCJwcmVmcy5qc29uXCIpO1xuICBjb25zdCBQUkVGX0tFWSA9IC9eW2Etel1bYS16MC05Oi5fLV17MCw2M30kLztcbiAgY29uc3QgUFJFRl9WQUxVRV9NQVggPSA0MDk2O1xuICBjb25zdCBQUkVGX0tFWVNfTUFYID0gNjQ7XG4gIC8qKlxuICAgKiBSZWFkIHRoZSBob21lJ3MgcHJlZnMgRlJFU0guIFNldmVyYWwgc2Vzc2lvbnMgY2FuIHNoYXJlIG9uZSBob21lIChFMTMpLCBlYWNoXG4gICAqIGl0cyBvd24gZGFlbW9uLCBzbyBhIGNvcHkgbG9hZGVkIG9uY2UgYXQgYm9vdCBhbmQgd3JpdHRlbiBiYWNrIHdob2xlIHdvdWxkXG4gICAqIGVyYXNlIGEga2V5IGFub3RoZXIgc2Vzc2lvbiB3cm90ZSBzaW5jZSAodmVyaWZ5IHBhc3MpLiBFdmVyeSB3cml0ZSBpc1xuICAgKiB0aGVyZWZvcmUgcmVhZCDihpIgc2V0IG9uZSBrZXkg4oaSIHdyaXRlLCBhbmQgZXZlcnkgc25hcHNob3QgcmVhZHMgdGhlIGZpbGUuXG4gICAqIE9ubHkgd2VsbC1mb3JtZWQgZW50cmllcyBzdXJ2aXZlIGEgcmVhZDsgYSBiYWQgZmlsZSByZWFkcyBhcyBlbXB0eSBhbmQgaXNcbiAgICogcmVwbGFjZWQgYnkgdGhlIG5leHQgd3JpdGUuXG4gICAqL1xuICBjb25zdCByZWFkUHJlZnMgPSAoKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9PiB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByZWZzRmlsZSwgXCJ1dGY4XCIpKSBhcyB1bmtub3duO1xuICAgICAgaWYgKHJhdyAmJiB0eXBlb2YgcmF3ID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocmF3KSlcbiAgICAgICAgICBpZiAoUFJFRl9LRVkudGVzdChrKSAmJiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2Lmxlbmd0aCA8PSBQUkVGX1ZBTFVFX01BWCkgb3V0W2tdID0gdjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIHByZWZzIHlldCwgb3IgdW5yZWFkYWJsZSDigJQgZW1wdHkgKi9cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfTtcbiAgY29uc3QgdXNlckhvbWUgPSBob21lZGlyKCk7XG4gIC8qKlxuICAgKiBFNTM6IHRoZSBzbm9vemUgdGhlIGFnZW50IGFza2VkIGZvciwgYW5kIHRoZSBtZXNzYWdlcyBhbHJlYWR5IG51ZGdlZC5cbiAgICpcbiAgICog4puUIE9ORSBOVURHRSBQRVIgTUVTU0FHRSwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIEFOVEktTkFHIFJVTEUuIENvbGU6IFwid2VcbiAgICogZG9uJ3Qgd2FudCB0byBoYXZlIGEgc2l0dWF0aW9uIHdoZXJlIGFuIGFnZW50IGtlZXBzIGdldHRpbmcgcGluZ2VkIGFib3V0XG4gICAqIHNvbWV0aGluZyBhbmQgaXQncyBsaWtlLCBubywgSSdtIGFjdHVhbGx5IHdvcmtpbmcuXCIgU28gYSBtZXNzYWdlIGlkIGVudGVyc1xuICAgKiBgbnVkZ2VkYCB0aGUgZmlyc3QgdGltZSBpdCBpcyByZXBvcnRlZCDigJQgb3IgdGhlIG1vbWVudCB0aGUgYWdlbnQgc25vb3plcyBpdFxuICAgKiDigJQgYW5kIG5ldmVyIGxlYXZlcy4gQSBzbm9vemUgRVhQSVJJTkcgdGhlcmVmb3JlIGNoYW5nZXMgd2hhdCB0aGUgSFVNQU5cbiAgICogc2VlcyAoYmFjayB0byBcIm1heSBiZSBzdHVja1wiLCBiZWNhdXNlIHRoZXkgYXJlIG93ZWQgdGhlIHRydXRoKSB3aXRob3V0XG4gICAqIHBpbmdpbmcgdGhlIGFnZW50IGFnYWluLlxuICAgKlxuICAgKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBkZWxpYmVyYXRlbHkuIEEgcmVzdG9yZWQgc2Vzc2lvbiB3aG9zZVxuICAgKiBodW1hbiB3YXMgbGVmdCB3YWl0aW5nIFNIT1VMRCB0ZWxsIHRoZSBhZ2VudCB0aGF0IGFycml2ZXMg4oCUIHRoZSB3YWl0IGlzXG4gICAqIHJlYWwgYW5kIHRoZSBuZXcgYWdlbnQgaGFzIG5vdCBoZWFyZCBhYm91dCBpdC5cbiAgICovXG4gIGxldCBhY2tub3dsZWRnZWRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBjb25zdCBudWRnZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgLyoqXG4gICAqIEU2MDogdGhlIENPTlRFWFQncyB1bmRvIGhpc3Rvcnkg4oCUIG5vdCB0aGUgZWRpdG9yJ3MsIHdoaWNoIENvZGVNaXJyb3Igb3ducy5cbiAgICogSW4gbWVtb3J5IG9uIHB1cnBvc2UgKHNlZSBgaGlzdG9yeS50c2ApOiBhbiBpbnZlcnNlIGRlc2NyaWJlcyB0aGUgd29ybGQgYXNcbiAgICogaXQgaXMgbm93LCBhbmQgYSBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGZpbGVzIHNvbWVib2R5IGhhc1xuICAgKiBzaW5jZSBtb3ZlZCBieSBoYW5kLlxuICAgKi9cbiAgY29uc3QgaGlzdG9yeSA9IG5ldyBIaXN0b3J5KCk7XG5cbiAgY29uc3Qgdmlld1N0YXRlID0gKCk6IFB1YmxpY1N0YXRlID0+IHtcbiAgICBjb25zdCBiYXNlID0geyAuLi5zZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSwgcHJlZnM6IHJlYWRQcmVmcygpLCB1c2VySG9tZSB9O1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICB3YWl0aW5nOiB3YWl0aW5nT24oYmFzZS5jaGF0LCBub3csIHsgYWNrbm93bGVkZ2VkVW50aWwgfSksXG4gICAgICBub3Rlc1dhaXRpbmc6IG5vdGVzV2FpdGluZyhzZXNzaW9uLm5vdGVGYWN0cygpLCBiYXNlLmNoYXQsIG5vdywgeyBhY2tub3dsZWRnZWRVbnRpbCB9KSxcbiAgICAgIGhpc3Rvcnk6IGhpc3RvcnkudmlldygpLFxuICAgIH07XG4gIH07XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLiAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pID0+IHtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIHRleHQpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJzeXN0ZW1cIiwgdGV4dCwgdHM6IG0udHMsIC4uLmZhY3QgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgfTtcblxuICAvLyAtLS0gdGhlIHdhdGNoZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy9cbiAgLy8g4pqgIERFVklBVElPTiBGUk9NIFRIRSBCUklFRiwgV0lUSCBJVFMgUkVBU09OOiBgbm9kZTpmc2AgYHdhdGNoYCAoQnVuJ3NcbiAgLy8gYnVpbHQtaW4pLCBOT1QgYEBwYXJjZWwvd2F0Y2hlcmAuIGBAcGFyY2VsL3dhdGNoZXJgIGlzIGEgbmF0aXZlIGFkZG9uIHdob3NlXG4gIC8vIGxvYWRlciBkb2VzIGEgcnVudGltZSBgcmVxdWlyZSgpYCBvZiBhIHBlci1wbGF0Zm9ybSBwYWNrYWdlOyBidW5kbGVkIGludG9cbiAgLy8gYGRpc3Qvc2VydmVyLmpzYCBpdCBpcyBub3QgaW5saW5lZCwgc28gdGhlIHNoaXBwZWQgZGFlbW9uIHdvdWxkIG5lZWQgYVxuICAvLyBgbm9kZV9tb2R1bGVzYCB0aGUgbWFya2V0cGxhY2UgbmV2ZXIgY29waWVzIChpbXBvcnQtYm91bmRhcnkgd2FyZCAxYidzXG4gIC8vIFwidGhlIHNoaXBwZWQgZXhlY3V0aW9uIHBhdGggY2FycmllcyBubyBkZXBlbmRlbmNpZXNcIikuIE1lYXN1cmVkIHVuZGVyIEJ1blxuICAvLyAxLjQuMCBvbiBtYWNPUyBiZWZvcmUgY2hvb3Npbmc6IGEgcmVjdXJzaXZlIGRpcmVjdG9yeSB3YXRjaCByZXBvcnRzIGFuXG4gIC8vIGluLXBsYWNlIHdyaXRlLCBhbiBhdG9taWMgdG1wK3JlbmFtZSBzYXZlLCBhbmQgYm90aCBhZ2FpbiBpbiBhXG4gIC8vIHN1YmRpcmVjdG9yeSDigJQgdGhlIGZvdXIgY2FzZXMgaW52ZXN0aWdhdGlvbiDCpzUgZHJvdmUgQHBhcmNlbC93YXRjaGVyIG9uLlxuICAvLyBUaGUgaGFzaC1jb21wYXJlIGFuZCBzZWxmLXdyaXRlIHN1cHByZXNzaW9uIGFyZSB1bmNoYW5nZWQgKHNlc3Npb24udHMpLlxuICBjb25zdCB3YXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGU1dhdGNoZXI+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG4gIGNvbnN0IG9uRnMgPSAoYWJzOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB0ID0gcGVuZGluZy5nZXQoYWJzKTtcbiAgICBpZiAodCkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHBlbmRpbmcuc2V0KFxuICAgICAgYWJzLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHBlbmRpbmcuZGVsZXRlKGFicyk7XG4gICAgICAgIGxldCBldjogRmlsZUV2ZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZXYgPSBzZXNzaW9uLm9uRmlsZUV2ZW50KGFicyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IHdhdGNoZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXYpIGhhbmRsZUZpbGVFdmVudChldik7XG4gICAgICB9LCBXQVRDSF9TRVRUTEVfTVMpLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IHN5bmNXYXRjaGVycyA9ICgpID0+IHtcbiAgICBjb25zdCB3YW50ID0gbmV3IE1hcChcbiAgICAgIHNlc3Npb24ud2F0Y2hSb290cygpLm1hcCgocikgPT4gW2Ake3IucmVjdXJzaXZlID8gXCJSXCIgOiBcIkZcIn06JHtyLndhdGNofT4ke3IucGF0aH1gLCByXSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHddIG9mIHdhdGNoZXJzKVxuICAgICAgaWYgKCF3YW50LmhhcyhrZXkpKSB7XG4gICAgICAgIHcuY2xvc2UoKTtcbiAgICAgICAgd2F0Y2hlcnMuZGVsZXRlKGtleSk7XG4gICAgICB9XG4gICAgZm9yIChjb25zdCBba2V5LCByXSBvZiB3YW50KSB7XG4gICAgICBpZiAod2F0Y2hlcnMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gV2F0Y2hlZCBhdCB0aGUgUkVBTFBBVEgsIHJlcG9ydGVkIHVuZGVyIHRoZSBzdG9yZWQgcGF0aCBmb3JtXG4gICAgICAgIC8vICh2ZXJpZnktcGFzcyBmaXggMyDigJQgc2VlIFNlc3Npb24ud2F0Y2hSb290cykuXG4gICAgICAgIGNvbnN0IHcgPSB3YXRjaChyLndhdGNoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gVGhlXG4gICAgICAgIC8vIG91dHNpZGUgdGV4dCBpcyBLRVBUIGFzIGEgbmV3IGFnZW50IHZlcnNpb24gYW5kIHRoZSBhY3RpdmUgdmVyc2lvblxuICAgICAgICAvLyBrZWVwcyB0aGUgaHVtYW4ncyB0ZXh0IOKAlCBub3RoaW5nIGlzIGxvc3QsIGFuZCB0aGUgaHVtYW4ncyBidWZmZXIgaXNcbiAgICAgICAgLy8gbm90IHRvdWNoZWQgKHZlcmlmeS1wYXNzIGZpeCA0KS5cbiAgICAgICAgYW5ub3VuY2VPdXRzaWRlKGV2LmRvYywgZXYudmVyc2lvbiwgZXYucGF0aCwgZXYucHJlc2VydmVkQXMsIGV2LnByZXNlcnZlZFBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYW5ub3VuY2VPdXRzaWRlID0gKFxuICAgIGRvYzogc3RyaW5nLFxuICAgIHZlcnNpb246IG51bWJlcixcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmcsXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7IGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jLCB2ZXJzaW9uLCBwYXRoLCBwcmVzZXJ2ZWRBcywgcHJlc2VydmVkUGF0aCB9LFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLyoqXG4gICAqIEUyNDogb25lIHN0cnVjdHVyZSBjaGFuZ2UsIGZyb20gZWl0aGVyIHBhcnR5IOKAlCB0aGUgc2FtZSBzZXNzaW9uIG1ldGhvZCwgdGhlXG4gICAqIHNhbWUgYW5ub3VuY2VtZW50IChuYW1pbmcgd2hvIGRpZCBpdCksIHRoZSBzYW1lIHRhaWwgZmFjdC4gUmV0dXJucyB0aGUgcGF0aFxuICAgKiB0aGUgY2hhbmdlIGxhbmRlZCBhdCwgd2hpY2ggdGhlIHN1cmZhY2UgdXNlcyB0byBvcGVuIG9yIHJlbmFtZSBpdC5cbiAgICovXG4gIGNvbnN0IFNUUlVDVFVSRV9PUFMgPSBuZXcgU2V0PHN0cmluZz4oW1xuICAgIFwiZG9jLmNyZWF0ZVwiLFxuICAgIFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgIFwibW92ZVwiLFxuICAgIFwicmVuYW1lXCIsXG4gICAgXCJoaWRlXCIsXG4gICAgXCJ1bmhpZGVcIixcbiAgICBcInNldC5tYWtlXCIsXG4gICAgXCJpbXBvcnRcIixcbiAgICBcIndvcmtzcGFjZS5zZXRcIixcbiAgXSBzYXRpc2ZpZXMgU3RydWN0dXJlT3BbXCJ0eXBlXCJdW10pO1xuICBjb25zdCBpc1N0cnVjdHVyZU9wID0gKG06IHsgdHlwZTogc3RyaW5nIH0pOiBtIGlzIFN0cnVjdHVyZU9wID0+IFNUUlVDVFVSRV9PUFMuaGFzKG0udHlwZSk7XG5cbiAgY29uc3Qgc3RydWN0dXJlID0gKG9wOiBTdHJ1Y3R1cmVPcCwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBjb25zdCB3aG8gPSBieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIjtcbiAgICAvLyDim5QgQ0FQVFVSRUQgQkVGT1JFIFRIRSBBQ1QsIGJlY2F1c2UgZXZlcnkgZmllbGQgaGVyZSBpcyBzb21ldGhpbmcgdGhlIGFjdFxuICAgIC8vIENIQU5HRVM6IHJlYWRpbmcgYW4gZW50cnkncyBoaWRkZW4gbGlzdCBhZnRlcndhcmRzIHJldHVybnMgdGhlIGxpc3RcbiAgICAvLyBpbmNsdWRpbmcgd2hhdCB3YXMganVzdCBoaWRkZW4sIHdoaWNoIHJlc3RvcmVzIG5vdGhpbmcgKEU2MCkuXG4gICAgY29uc3QgYmVmb3JlOiBCZWZvcmUgPSB7XG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJoaWRlXCIgPyB7IGhpZGRlbjogc2Vzc2lvbi5oaWRkZW5CZWZvcmUob3AucGF0aCkgPz8gdW5kZWZpbmVkIH0gOiB7fSksXG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJ1bmhpZGVcIiA/IHsgaGlkZGVuOiBzZXNzaW9uLmhpZGRlbk9mRW50cnkob3AuZW50cnkpID8/IHVuZGVmaW5lZCB9IDoge30pLFxuICAgICAgLi4uKG9wLnR5cGUgPT09IFwid29ya3NwYWNlLnNldFwiID8geyB3b3Jrc3BhY2U6IHNlc3Npb24ud29ya3NwYWNlIH0gOiB7fSksXG4gICAgfTtcbiAgICBjb25zdCBzaG93biA9IChwOiBzdHJpbmcpID0+IHNlc3Npb24uZGlzcGxheShwKTtcbiAgICBsZXQgcjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHBhdGg/OiBzdHJpbmcgfTtcbiAgICBsZXQgbGluZTogc3RyaW5nO1xuICAgIHN3aXRjaCAob3AudHlwZSkge1xuICAgICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRG9jKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVGb2xkZXIob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCB0aGUgZm9sZGVyICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKG9wLnBhdGgsIG9wLmludG8pO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gbW92ZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShvcC5wYXRoLCBvcC5uYW1lKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHJlbmFtZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgICBjb25zdCBoID0gc2Vzc2lvbi5oaWRlKG9wLnBhdGgpO1xuICAgICAgICByID0gaDtcbiAgICAgICAgLy8g4pqgIFRIRSBQQVJFTlRIRVRJQ0FMIEhBUyBUTyBCRSBUUlVFLiBJdCBzYWlkIFwiKHRoZSBmaWxlIGlzIHN0aWxsIG9uXG4gICAgICAgIC8vIGRpc2spXCIgdW5jb25kaXRpb25hbGx5LCB3aGljaCBpcyB3cm9uZyB0d2ljZSBvdmVyIG9uIGEgR0hPU1Qg4oCUIGFuXG4gICAgICAgIC8vIGVudHJ5IHdob3NlIGZpbGUgaXMgYWxyZWFkeSBnb25lIOKAlCBhbmQgY2FsbHMgYSBmb2xkZXIgYSBmaWxlLiBDb2xlXG4gICAgICAgIC8vIG1ldCBib3RoIGluIG9uZSBnbyB3aGlsZSBjbGVhcmluZyByZXNpZHVlIGZyb20gdGhlIEU2MCBidWcsIGFuZCBhXG4gICAgICAgIC8vIHJlYXNzdXJhbmNlIHRoYXQgaXMgZmFsc2UgaXMgd29yc2UgdGhhbiBubyByZWFzc3VyYW5jZTogaXQgaXMgdGhlXG4gICAgICAgIC8vIHNhbWUgZGVmZWN0IGFzIHRoZSBjb25mbGljdCBiYW5uZXIgY2xhaW1pbmcgZWRpdHMgaGUgaGFkIG5vdCBtYWRlLlxuICAgICAgICBjb25zdCBnb25lID0gIWV4aXN0c1N5bmMoaC5wYXRoKTtcbiAgICAgICAgY29uc3Qga2luZCA9IGdvbmUgPyBcIlwiIDogc3RhdFN5bmMoaC5wYXRoKS5pc0RpcmVjdG9yeSgpID8gXCJmb2xkZXJcIiA6IFwiZmlsZVwiO1xuICAgICAgICBsaW5lID0gZ29uZVxuICAgICAgICAgID8gYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAoaXQgd2FzIGFscmVhZHkgZ29uZSBmcm9tIGRpc2spLmBcbiAgICAgICAgICA6IGAke3dob30gcmVtb3ZlZCAke3Nob3duKGgucGF0aCl9IGZyb20gU2NyaXB0b3JpdW0gKHRoZSAke2tpbmR9IGlzIHN0aWxsIG9uIGRpc2spLmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IHUgPSBzZXNzaW9uLnVuaGlkZShvcC5lbnRyeSk7XG4gICAgICAgIHIgPSB1O1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBicm91Z2h0IGJhY2sgJHt1LnJlc3RvcmVkfSBoaWRkZW4gaXRlbSR7dS5yZXN0b3JlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2V0Lm1ha2VcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tYWtlU2V0KG9wLnBhdGgpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gdHVybmVkICR7YmFzZW5hbWUobS5wYXRoKX0gaW50byBhIHNldDogJHtzaG93bihtLmZvbGRlcil9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5pbXBvcnRUZXh0KG9wLm5hbWUsIG9wLnRleHQsIG9wLmludG8pO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjb3BpZWQgJHtvcC5uYW1lfSBpbiBhcyAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLnNldFdvcmtzcGFjZShvcC5wYXRoKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIC8vIFRoZSB3YXkgYmFjaywgcGxhbm5lZCBub3cgYW5kIGZyb20gd2hhdCB3YXMgdHJ1ZSBub3cuXG4gICAgaGlzdG9yeS5kaWQocGxhbkludmVyc2Uob3AsIHIgYXMgQWZ0ZXIsIGJlZm9yZSkpO1xuICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogb3AudHlwZSwgYnksIC4uLnIgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcjtcbiAgfTtcblxuICAvKipcbiAgICogQXBwbHkgb25lIHJlY29yZGVkIGludmVyc2UsIGFuZCByZXR1cm4gdGhlIGFjdCB0aGF0IHdvdWxkIHJldmVyc2UgVEhBVCDigJRcbiAgICogd2hpY2ggaXMgd2hhdCBnb2VzIG9udG8gdGhlIG90aGVyIHN0YWNrLlxuICAgKlxuICAgKiDim5QgQSBERUxFVEUgSEFTIE5PIFdBWSBCQUNLLCBhbmQgc2F5cyBzbyBieSByZXR1cm5pbmcgbnVsbC4gT25jZSBhIGNyZWF0ZWRcbiAgICogZmlsZSBpcyBnb25lIGl0cyBjb250ZW50cyBhcmUgZ29uZSB3aXRoIGl0LCBzbyBhIHJlZG8gdGhhdCBcInJlLWNyZWF0ZXNcIiBpdFxuICAgKiB3b3VsZCBoYW5kIGJhY2sgYW4gZW1wdHkgZmlsZSB3ZWFyaW5nIHRoZSBzYW1lIG5hbWUg4oCUIHRoZSBraW5kIG9mIGxpZSBhblxuICAgKiB1bmRvIHN0YWNrIG11c3Qgbm90IHRlbGwuIENvbmZpcm1lZCBkZWxldGlvbnMgYXJlIHRoZXJlZm9yZSBvbmUtd2F5LCB3aGljaFxuICAgKiBpcyBhbHNvIHdoeSB0aGV5IGFyZSBjb25maXJtZWQuXG4gICAqL1xuICBjb25zdCBhcHBseUludmVyc2UgPSAoaW52OiBJbnZlcnNlKTogQWN0IHwgbnVsbCA9PiB7XG4gICAgc3dpdGNoIChpbnYua2luZCkge1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKGludi5wYXRoLCBpbnYuaW50byk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBtb3ZlZCAke2Jhc2VuYW1lKG0uZnJvbSl9IGJhY2sgaW50byAke2Jhc2VuYW1lKGRpcm5hbWUobS5wYXRoKSl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwibW92ZVwiLCBwYXRoOiBtLnBhdGgsIGludG86IGRpcm5hbWUobS5mcm9tKSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShpbnYucGF0aCwgaW52Lm5hbWUpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcmVuYW1lZCAke2Jhc2VuYW1lKG0uZnJvbSl9IGJhY2sgdG8gJHtiYXNlbmFtZShtLnBhdGgpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcInJlbmFtZVwiLCBwYXRoOiBtLnBhdGgsIG5hbWU6IGJhc2VuYW1lKG0uZnJvbSkgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaWRkZW5cIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXN0b3JlSGlkZGVuKGludi5lbnRyeSwgaW52LnJlbHMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiByLndhcy5sZW5ndGggPiBpbnYucmVscy5sZW5ndGggPyBcImJyb3VnaHQgaXRlbXMgYmFja1wiIDogXCJoaWQgaXRlbXMgYWdhaW5cIixcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiByLmVudHJ5LCByZWxzOiByLndhcyB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgeyBlbnRyeSB9ID0gc2Vzc2lvbi5hZGRDb250ZXh0KGludi5wYXRoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHB1dCAke2Jhc2VuYW1lKGludi5wYXRoKX0gYmFjayBpbiB0aGUgY29udGV4dGAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImNvbnRleHQucmVtb3ZlXCIsIGVudHJ5OiBlbnRyeS5pZCB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHNlc3Npb24uZW50cnlSb290KGludi5lbnRyeSk7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ29udGV4dChpbnYuZW50cnkpO1xuICAgICAgICByZXR1cm4gcGF0aCA9PT0gbnVsbFxuICAgICAgICAgID8gbnVsbFxuICAgICAgICAgIDoge1xuICAgICAgICAgICAgICBsYWJlbDogYHRvb2sgJHtiYXNlbmFtZShwYXRoKX0gYmFjayBvdXQgb2YgdGhlIGNvbnRleHRgLFxuICAgICAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIiwgcGF0aCB9LFxuICAgICAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2VcIjoge1xuICAgICAgICBjb25zdCB3YXMgPSBzZXNzaW9uLndvcmtzcGFjZTtcbiAgICAgICAgc2Vzc2lvbi5zZXRXb3Jrc3BhY2UoaW52LnBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgc2V0IHRoZSB3b3Jrc3BhY2UgYmFjayB0byAke2Jhc2VuYW1lKGludi5wYXRoKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJ3b3Jrc3BhY2VcIiwgcGF0aDogd2FzIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGVsZXRlXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDcmVhdGVkKGludi5wYXRoLCBpbnYuZGlyKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBzdXJmYWNlIG1lc3NhZ2VzIChXZWJTb2NrZXQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHJlcGx5ID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIHRyeSB7XG4gICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KG1zZykpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSAqL1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVDbGllbnRNc2cgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogQ2xpZW50TXNnKSA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AobXNnKSkge1xuICAgICAgY29uc3QgciA9IHN0cnVjdHVyZShhbmNob3JTdXJmYWNlUGF0aHMobXNnKSwgXCJodW1hblwiKTtcbiAgICAgIGlmICh0eXBlb2Ygci5wYXRoID09PSBcInN0cmluZ1wiKVxuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInN0cnVjdHVyZS5kb25lXCIsIG9wOiBtc2cudHlwZSwgcGF0aDogci5wYXRoIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwib3BlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm9wZW5QYXRoKG1zZy5wYXRoKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIC8vIFRoZSBvcGVuZXIgZ2V0cyB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IHN0cmFpZ2h0IGF3YXkg4oCUIHRoZSBzdGF0ZVxuICAgICAgICAvLyBzbmFwc2hvdCBjYXJyaWVzIG5vIHRleHRzLCBhbmQgYSB2aWV3ZXIgbXVzdCBub3Qgd2FpdCBvbiBhIHNlY29uZCBhc2suXG4gICAgICAgIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyLmNyZWF0ZWQpXG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvYy5vcGVuZWRcIiwgZG9jOiByLnNsdWcsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChyLnNsdWcpIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwib3Blbi5kb2NcIjpcbiAgICAgICAgc2Vzc2lvbi5vcGVuU2x1Zyhtc2cuZG9jKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0KG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBtc2cudGV4dCk7XG4gICAgICAgIGlmIChyLnByZXNlcnZlZCkge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhtc2cuZG9jKTtcbiAgICAgICAgICBhbm5vdW5jZU91dHNpZGUoXG4gICAgICAgICAgICBkLnNsdWcsXG4gICAgICAgICAgICBtc2cudmVyc2lvbixcbiAgICAgICAgICAgIHNlc3Npb24uYWN0aXZlUGF0aChkLnNsdWcpID8/IFwiXCIsXG4gICAgICAgICAgICByLnByZXNlcnZlZC5uLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQucGF0aCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHIuZGlydHlDaGFuZ2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6IHtcbiAgICAgICAgLy8g4puUIFJFUExJRUQgVE8gVEhFIEFTS0lORyBTT0NLRVQsIE5PVCBCUk9BRENBU1QuIEEgc2VhcmNoIGlzIG9uZVxuICAgICAgICAvLyB2aWV3ZXIncyBxdWVzdGlvbjsgcHVzaGluZyByZXN1bHRzIHRvIGV2ZXJ5IGNsaWVudCB3b3VsZCBwdXQgc29tZW9uZVxuICAgICAgICAvLyBlbHNlJ3MgcXVlcnkgaW4geW91ciBwYW5lLiAoVGhlIHNhbWUgcmVhc29uIGBkaWZmYCByZXBsaWVzIHJhdGhlclxuICAgICAgICAvLyB0aGFuIGJyb2FkY2FzdGluZy4pXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzZWFyY2gucmVzdWx0c1wiLCByZXBvcnQ6IHNlc3Npb24uc2VhcmNoQWxsKG1zZykgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlzdG9yeS51bmRvXCI6IHtcbiAgICAgICAgY29uc3QgYWN0ID0gaGlzdG9yeS5wZWVrVW5kbygpO1xuICAgICAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIE5FRURTIFRIRSBIVU1BTidTIFdPUkQsIGNhcnJpZWQgZXhwbGljaXRseS4gQVxuICAgICAgICAvLyBjbGllbnQgdGhhdCBzaW1wbHkgb21pdHMgdGhlIGZsYWcgZ2V0cyBhIHJlZnVzYWwgcmF0aGVyIHRoYW4gYVxuICAgICAgICAvLyBkZWxldGlvbiwgc28gXCJmb3Jnb3QgdG8gY29uZmlybVwiIGNhbiBuZXZlciBiZWNvbWUgXCJkZWxldGVkIGFueXdheVwiLlxuICAgICAgICBpZiAoYWN0LmludmVyc2Uua2luZCA9PT0gXCJkZWxldGVcIiAmJiBtc2cuY29uZmlybURlbGV0ZSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVW5kb2luZyBcIiR7YWN0LmxhYmVsfVwiIHdvdWxkIGRlbGV0ZSAke3Nlc3Npb24uZGlzcGxheShhY3QuaW52ZXJzZS5wYXRoKX0g4oCUIGNvbmZpcm0gaXQgZmlyc3QuYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tVbmRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgdW5kaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS51bmRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIFRoZSByZWZ1c2FsIHRoZSBodW1hbiBuZWVkcyB0byByZWFkIOKAlCBhIGZvbGRlciB3aXRoIHRoaW5ncyBpbiBpdCxcbiAgICAgICAgICAvLyBvciBhIHdvcmxkIHRoYXQgaGFzIG1vdmVkIHVuZGVyIGEgcmVjb3JkZWQgaW52ZXJzZS4gVGhlIGFjdCBTVEFZU1xuICAgICAgICAgIC8vIG9uIHRoZSBzdGFjazogbm90aGluZyBoYXBwZW5lZCwgc28gbm90aGluZyBzaG91bGQgYmUgZm9yZ290dGVuLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnJlZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtSZWRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGlzdG9yeS50b29rUmVkbyhhcHBseUludmVyc2UoYWN0LmludmVyc2UpKTtcbiAgICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgICBhbm5vdW5jZShgWW91IHJlZGlkOiAke2FjdC5sYWJlbH0uYCwgeyBmYWN0OiBcImhpc3RvcnkucmVkb1wiIH0pO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VsZWN0XCI6XG4gICAgICAgIC8vIEFNQklFTlQgc3RhdGU6IHN0b3JlZCBhbmQgc2hvd24sIG5ldmVyIHB1c2hlZCBvbnRvIHRoZSBhZ2VudCdzIHRhaWwuXG4gICAgICAgIHNlbGVjdGlvbiA9IG1zZy5zZWxlY3Rpb247XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCB0ZXh0ID0gbXNnLnRleHQudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2VsID0gbXNnLndpdGhTZWxlY3Rpb24gPyBzZWxlY3Rpb24gOiBudWxsO1xuICAgICAgICBjb25zdCBhY3RpdmVQYXRoID0gc2VsID8gc2Vzc2lvbi5hY3RpdmVQYXRoKHNlbC5kb2MpIDogc2Vzc2lvbi5hY3RpdmVQYXRoKCk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJodW1hblwiLCB0ZXh0LCB7IHNlbGVjdGlvbjogc2VsLCBhY3RpdmVQYXRoIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgbWVzc2FnZV9pZDogbS5pZCxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2Yoc2VsPy5kb2MpLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIGFjdGl2YXRlKG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBcImh1bWFuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwibm90ZS5hZGRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5hZGROb3RlKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgYm9keTogbXNnLmJvZHksXG4gICAgICAgICAgd2hvOiBcImh1bWFuXCIsXG4gICAgICAgICAgcmFuZ2U6IHsgZnJvbTogbXNnLmZyb20sIHRvOiBtc2cudG8gfSxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIEU2NTogdGhlIGV2ZW50IGNhcnJpZXMgdGhlIG5vdGUgaXRzZWxmIHdoZW4gaXQgaXMgc2hvcnQsIGFuZCBuYW1lc1xuICAgICAgICAvLyB0aGUgYWN0IHRoYXQgY2xvc2VzIGl0IOKAlCBhbiBhZ2VudCBzaG91bGQgbm90IGhhdmUgdG8gZ28gYW5kIGFza1xuICAgICAgICAvLyB3aGF0IGp1c3QgYXJyaXZlZCBiZWZvcmUgaXQgY2FuIHN0YXJ0LlxuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgLi4ubm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhtc2cuaWQsIG1zZy5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpIHtcbiAgICAgICAgICBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgYERvbmU6ICR7ci50YXNrLnRleHR9YCk7XG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suZG9uZVwiLCB0YXNrOiByLnRhc2suaWQsIGJ5OiBcImh1bWFuXCIgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVUYXNrKG1zZy5pZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrcy5jbGVhclwiOiB7XG4gICAgICAgIHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBtc2cuZG9jLCBpZDogbXNnLmlkLCBib2R5OiBtc2cuYm9keSwgd2hvOiBcImh1bWFuXCIgfSk7XG4gICAgICAgIC8vIEEgaHVtYW4ncyByZXdyaXRlIGlzIG93ZWQgYW4gYW5zd2VyIGFnYWluIChFNjUpLCBzbyBpdCBzYXlzIHdoYXRcbiAgICAgICAgLy8gdGhlIG5vdGUgbm93IHNheXMsIGV4YWN0bHkgYXMgYG5vdGUuYWRkZWRgIGRvZXMuXG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgLi4ubm90ZUV2ZW50RmFjdHMoci5zbHVnLCByLm5vdGUsIHNlc3Npb24ubm90ZUxpbmVzKHIuc2x1Zywgci5ub3RlKSksXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQsIHJlc29sdmVkOiBtc2cucmVzb2x2ZWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBtc2cucmVzb2x2ZWQgPyBcIm5vdGUucmVzb2x2ZWRcIiA6IFwibm90ZS5yZW9wZW5lZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVtb3ZlTm90ZSh7IGRvYzogbXNnLmRvYywgaWQ6IG1zZy5pZCB9KTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcIm5vdGUucmVtb3ZlZFwiLCBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBieTogXCJodW1hblwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiBtc2cudmVyc2lvbiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBEZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICAuLi4obXNnLmZyb20gPT09IHVuZGVmaW5lZCA/IHt9IDogeyBmcm9tOiBtc2cuZnJvbSB9KSxcbiAgICAgICAgICAuLi4obXNnLmxhYmVsID8geyBsYWJlbDogbXNnLmxhYmVsIH0gOiB7fSksXG4gICAgICAgICAgYXV0aG9yOiBcImh1bWFuXCIsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyDim5QgU0FZIFdIRVJFIFRIRVkgQVJFLCBub3QganVzdCB3aGF0IHdhcyBtYWRlIChFNDIpLiBUaGUgb2xkIG1lc3NhZ2VcbiAgICAgICAgLy8gYW5ub3VuY2VkIHRoZSBuZXcgdmVyc2lvbiBhbmQgd2VudCBxdWlldCBhYm91dCB3aGljaCBvbmUgdGhlIGh1bWFuXG4gICAgICAgIC8vIHdhcyBlZGl0aW5nIOKAlCB3aGljaCBpcyBleGFjdGx5IGhvdyBzb21lb25lIHR5cGVzIGludG8gdjEgYmVsaWV2aW5nXG4gICAgICAgIC8vIHRoZXkgYXJlIGluIHYyLlxuICAgICAgICBpZiAobXNnLmFjdGl2YXRlKSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYE1hZGUgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7bXNnLmxhYmVsID8gYCDigJQgJHttc2cubGFiZWx9YCA6IFwiXCJ9LiBgICtcbiAgICAgICAgICAgIChtc2cuYWN0aXZhdGVcbiAgICAgICAgICAgICAgPyBgWW91IGFyZSBub3cgZWRpdGluZyB2JHtyLnZlcnNpb24ubn0uYFxuICAgICAgICAgICAgICA6IGBZb3UgYXJlIHN0aWxsIGVkaXRpbmcgdiR7ci52ZXJzaW9uLmZyb219LmApLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24ubixcbiAgICAgICAgICBmcm9tOiByLnZlcnNpb24uZnJvbSxcbiAgICAgICAgICBhY3RpdmF0ZWQ6IG1zZy5hY3RpdmF0ZSA9PT0gdHJ1ZSxcbiAgICAgICAgICBieTogXCJodW1hblwiLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24uc2hvd25QYXRoKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsLnZlcnNpb25cIjpcbiAgICAgICAgLy8gVGhlIGRhZW1vbiByZXNvbHZlcyBpdCwgc28gdGhlIHN1cmZhY2UgbmV2ZXIgbmFtZXMgYSBwYXRoIG91dHNpZGVcbiAgICAgICAgLy8gd2hhdCB0aGUgc2Vzc2lvbiBhbHJlYWR5IG93bnMuXG4gICAgICAgIHJldmVhbFBhdGgoc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikucGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZGlmZlwiLCAuLi5zZXNzaW9uLmNvbXBhcmUoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0IH0pIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogbXNnLmRvYywgYWdhaW5zdDogbXNnLmFnYWluc3QsIGh1bmtzOiBtc2cuaHVua3MgfSk7XG4gICAgICAgIC8vIFRoZSBidWZmZXIgdGhlIGh1bWFuIGlzIGxvb2tpbmcgYXQgbXVzdCBiZSB0b2xkOiB0aGUgbWVyZ2Ugd3JvdGUgdGhlXG4gICAgICAgIC8vIGFjdGl2ZSB2ZXJzaW9uJ3MgRklMRSwgYW5kIHRoZSBlZGl0b3IncyB0ZXh0IGlzIG5vdyBiZWhpbmQgaXQuXG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFRvb2sgJHtyLmFwcGxpZWR9IGNoYW5nZSR7ci5hcHBsaWVkID09PSAxID8gXCJcIiA6IFwic1wifSBmcm9tICR7c2lkZU5hbWUobXNnLmFnYWluc3QsIHNlc3Npb24uZG9jKHIuc2x1ZykubmFtZSl9IGludG8gdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzOiBtc2cuaHVua3MsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwcmVmcy5zZXRcIjoge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVBSRUZfS0VZLnRlc3QobXNnLmtleSkgfHxcbiAgICAgICAgICB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgbXNnLnZhbHVlLmxlbmd0aCA+IFBSRUZfVkFMVUVfTUFYXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfWApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFByZWZzKCk7XG4gICAgICAgIGlmIChjdXJyZW50W21zZy5rZXldID09PSBtc2cudmFsdWUpIHJldHVybjtcbiAgICAgICAgaWYgKCEobXNnLmtleSBpbiBjdXJyZW50KSAmJiBPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGggPj0gUFJFRl9LRVlTX01BWClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9OiAke1BSRUZfS0VZU19NQVh9IGtleXMgYWxyZWFkeSBrZXB0YCxcbiAgICAgICAgICApO1xuICAgICAgICB3cml0ZUZpbGVBdG9taWMoXG4gICAgICAgICAgcHJlZnNGaWxlLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgLi4uY3VycmVudCwgW21zZy5rZXldOiBtc2cudmFsdWUgfSwgbnVsbCwgMil9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImdyYXBoXCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImdyYXBoXCIsIGVudHJ5OiBtc2cuZW50cnksIGdyYXBoOiBzZXNzaW9uLmdyYXBoRm9yKG1zZy5lbnRyeSkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgICAgZW50cnk6IG1zZy5lbnRyeSxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxpbmsub3BlblwiOiB7XG4gICAgICAgIC8vIEUzMzogYSBsaW5rIGluc2lkZSB0aGUgYnVuZGxlIGlzIEZPTExPV0VEOyBvbmUgdGhhdCBlc2NhcGVzIGl0IGlzXG4gICAgICAgIC8vIHJlcG9ydGVkIHNvIHRoZSBzdXJmYWNlIGNhbiBvZmZlciB0byBhZGQgaXQsIG5ldmVyIGFkZGVkIHNpbGVudGx5LlxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXNvbHZlTGluayhtc2cuZnJvbSwgbXNnLnRhcmdldCk7XG4gICAgICAgIGlmIChyLnN0YXRlID09PSBcImluLWJ1bmRsZVwiKSB7XG4gICAgICAgICAgc2Vzc2lvbi5vcGVuUGF0aChyLnBhdGgpO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHNlc3Npb24ub3BlbkRvY1NsdWcgPz8gXCJcIik7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihkLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwibGluay50YXJnZXRcIixcbiAgICAgICAgICB0YXJnZXQ6IG1zZy50YXJnZXQsXG4gICAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICAgICAgLi4uKHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8ge30gOiB7IHBhdGg6IHIucGF0aCB9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtZXRhLnN1Z2dlc3RcIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnN1Z2dlc3RNZXRhKG1zZy5wYXRoLCBcImh1bWFuXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBibG9jazogci5ibG9jayxcbiAgICAgICAgICAgIC4uLihyLnR5cGUgPyB7IHN1Z2dlc3RlZFR5cGU6IHIudHlwZSB9IDoge30pLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibWV0YS5zdWdnZXN0aW9uXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1vdmUucGxhblwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgcGxhbjogc2Vzc2lvbi5tb3ZlUGxhbihzdXJmYWNlUGF0aChtc2cucGF0aCksIHN1cmZhY2VQYXRoKG1zZy5pbnRvKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtb3ZlLnBsYW5cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgaW50bzogbXNnLmludG8sXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgbmF0aXZlIHBpY2tlciAob25lIGRpYWxvZyBhdCBhIHRpbWUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvL1xuICAvLyBBIG1vZGFsIGRpYWxvZyBvd25zIHRoZSBodW1hbidzIGF0dGVudGlvbiwgYW5kIGEgc2Vjb25kIG9uZSBiZWhpbmQgdGhlXG4gIC8vIGZpcnN0IGNhbm5vdCBiZSBzZWVuIG9yIGRpc21pc3NlZCDigJQgc28gYSByZXF1ZXN0IHdoaWxlIG9uZSBpcyBvcGVuIGlzXG4gIC8vIHJlZnVzZWQgaW4gd29yZHMgcmF0aGVyIHRoYW4gcXVldWVkLlxuICBsZXQgcGlja2VyT3BlbiA9IGZhbHNlO1xuICBjb25zdCB6ZW5pdHkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBCdW4ud2hpY2goXCJ6ZW5pdHlcIikgOiBudWxsO1xuICBjb25zdCBvcGVuUGlja2VyID0gYXN5bmMgKFxuICAgIHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LFxuICAgIHdhbnQ6IFwiY29udGV4dC1maWxlXCIgfCBcImNvbnRleHQtZm9sZGVyXCIgfCBcIndvcmtzcGFjZVwiLFxuICApID0+IHtcbiAgICBpZiAocGlja2VyT3Blbikge1xuICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBcImEgZmlsZSBwaWNrZXIgaXMgYWxyZWFkeSBvcGVuXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGtpbmQ6IFBpY2tLaW5kID0gd2FudCA9PT0gXCJjb250ZXh0LWZpbGVcIiA/IFwiZmlsZVwiIDogXCJmb2xkZXJcIjtcbiAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgd2FudCA9PT0gXCJ3b3Jrc3BhY2VcIlxuICAgICAgICA/IFwiQ2hvb3NlIHRoZSB3b3Jrc3BhY2UgZm9sZGVyIGZvciBzY3JpcHRvcml1bVwiXG4gICAgICAgIDogd2FudCA9PT0gXCJjb250ZXh0LWZvbGRlclwiXG4gICAgICAgICAgPyBcIkNob29zZSBhIGZvbGRlciB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIlxuICAgICAgICAgIDogXCJDaG9vc2UgZG9jdW1lbnRzIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiO1xuICAgIGNvbnN0IGNtZCA9IHBpY2tlckNvbW1hbmQocHJvY2Vzcy5wbGF0Zm9ybSwga2luZCwgcHJvbXB0LCB6ZW5pdHkpO1xuICAgIGlmICghY21kKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBubyBmaWxlIHBpY2tlciBvbiB0aGlzIHN5c3RlbSAoJHtwcm9jZXNzLnBsYXRmb3JtfSkg4oCUIHR5cGUgdGhlIHBhdGggaW5zdGVhZGAsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcGlja2VyT3BlbiA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oY21kLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIsIHN0ZGluOiBcImlnbm9yZVwiIH0pO1xuICAgICAgY29uc3QgW291dCwgY29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgICB0b3VjaCgpOyAvLyBhIGh1bWFuIHN0b29kIGF0IGEgZGlhbG9nOyB0aGUgc2Vzc2lvbiBpcyBub3QgaWRsZVxuICAgICAgY29uc3QgcGF0aHMgPSBwYXJzZVBpY2tlck91dHB1dChvdXQpO1xuICAgICAgaWYgKHBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBDYW5jZWxsZWQ6IG5vdGhpbmcgY2hvc2VuLCBub3RoaW5nIHNhaWQuIEEgcmVhbCBmYWlsdXJlIGlzIHNhaWQuXG4gICAgICAgIGlmICghd2FzQ2FuY2VsbGVkKGNvZGUsIG91dCkpXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgdGhlIGZpbGUgcGlja2VyIGZhaWxlZCAoZXhpdCAke2NvZGV9KWAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFdoYXQgd2FzIGNob3NlbiBpcyBhZG1pdHRlZCBsaWtlIGFueSBvdGhlciBwYXRoIOKAlCBhIHBpY2tlZCBmaWxlIHRoYXRcbiAgICAgIC8vIHNjcmlwdG9yaXVtIGRvZXMgbm90IG9wZW4gaXMgcmVmdXNlZCBpbiB0aGUgc2lkZWJhcidzIG93biB3b3JkcywgYW5kXG4gICAgICAvLyB0aGF0IHJlZnVzYWwgbXVzdCBub3QgcmVhZCBhcyBcInRoZSBwaWNrZXIgZmFpbGVkXCIuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAod2FudCA9PT0gXCJ3b3Jrc3BhY2VcIilcbiAgICAgICAgICBzdHJ1Y3R1cmUoeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcGF0aHNbMF0gYXMgc3RyaW5nIH0sIFwiaHVtYW5cIik7XG4gICAgICAgIGVsc2UgYWRkUGF0aHMocGF0aHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBjb3VsZCBub3Qgb3BlbiB0aGUgZmlsZSBwaWNrZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcGlja2VyT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgLyoqIFNob3cgYSBmaWxlIGluIHRoZSBwbGF0Zm9ybSdzIGZpbGUgbWFuYWdlci4gQW4gYXJndiwgbmV2ZXIgYSBzaGVsbCBzdHJpbmc6XG4gICAqICB0aGUgcGF0aCBpcyBkYXRhLCB3aGF0ZXZlciBpdCBob2xkcy4gKi9cbiAgY29uc3QgcmV2ZWFsUGF0aCA9IChwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBbY21kLCAuLi5hcmdzXSA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgID8gW1wib3BlblwiLCBcIi1SXCIsIHBhdGhdXG4gICAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiXG4gICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICA6IFtcInhkZy1vcGVuXCIsIGRpcm5hbWUocGF0aCldO1xuICAgIEJ1bi5zcGF3bihbY21kIGFzIHN0cmluZywgLi4uYXJnc10sIHsgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSB9KS51bnJlZigpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcIm1ldGFcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24ubWV0YUZvcihjbWQucGF0aCk7XG4gICAgICBjYXNlIFwiZ3JhcGhcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uZ3JhcGhGb3IoY21kLmVudHJ5KSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY2FzZSBcImRhbmdsaW5nXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmRhbmdsaW5nTGlua3MoY21kLmVudHJ5KTtcbiAgICAgIGNhc2UgXCJkb2N0b3JcIjoge1xuICAgICAgICBjb25zdCBsaXN0ID0gc2Vzc2lvbi5jaGVja3VwKCk7XG4gICAgICAgIHJldHVybiB7IGZpbmRpbmdzOiBsaXN0LCBjb3VudDogbGlzdC5sZW5ndGggfSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgfVxuICAgICAgY2FzZSBcImZvcmdldFwiOiB7XG4gICAgICAgIGNvbnN0IGYgPSBzZXNzaW9uLmZvcmdldERvYyhjbWQuZG9jKTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IGZvcmdvdCAke2YubmFtZX0g4oCUIGl0cyBmaWxlIHdhcyBnb25lLCBhbmQgJHtmLnZlcnNpb25zID09PSAxID8gXCIxIHZlcnNpb25cIiA6IGAke2YudmVyc2lvbnN9IHZlcnNpb25zYH0gaW4gdGhpcyBzZXNzaW9uICR7Zi52ZXJzaW9ucyA9PT0gMSA/IFwiaXNcIiA6IFwiYXJlXCJ9IG5vIGxvbmdlciByZWFjaGFibGUuYCxcbiAgICAgICAgICB7IGZhY3Q6IFwiZG9jLmZvcmdvdHRlblwiLCBkb2M6IGYuc2x1Zywgb3JpZ2luYWw6IGYub3JpZ2luYWwgfSxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIGYgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWFyY2hcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uc2VhcmNoQWxsKGNtZCkgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNhc2UgXCJiYWNrbGlua3NcIjpcbiAgICAgICAgcmV0dXJuIHNlc3Npb24uYmFja2xpbmtzKGNtZC5wYXRoKTtcbiAgICAgIGNhc2UgXCJtZXRhLmluaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhSW5pdChjbWQucGF0aCwge1xuICAgICAgICAgIC4uLihjbWQubWV0YVR5cGUgPyB7IHR5cGU6IGNtZC5tZXRhVHlwZSB9IDoge30pLFxuICAgICAgICAgIGJ5OiBjbWQuYnkgPz8gXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGFkZGVkIGZyb250bWF0dGVyIHRvICR7c2Vzc2lvbi5kaXNwbGF5KFN0cmluZyhyLnBhdGgpKX0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAuLi5yLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWV0YS5zZXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXRhU2V0KGNtZC5wYXRoLCBjbWQuZmllbGRzKTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IHNldCAkeyhyLnNldCBhcyBzdHJpbmdbXSkuam9pbihcIiwgXCIpfSBvbiAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm1ldGEuc2V0XCIsIGJ5OiBcImFnZW50XCIsIC4uLnIgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5kZWxldGVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5kZWxldGVWZXJzaW9uKHsgZG9jOiBjbWQuZG9jLCB2ZXJzaW9uOiBjbWQudmVyc2lvbiB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IGRlbGV0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke3Iuc2x1Z30ke3IubGFiZWwgPyBgIOKAlCAke3IubGFiZWx9YCA6IFwiXCJ9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcInZlcnNpb24uZGVsZXRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgcmVtYWluaW5nOiByLnJlbWFpbmluZyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uYWRkTm90ZSh7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGJvZHk6IGNtZC5ib2R5LFxuICAgICAgICAgIHdobzogXCJhZ2VudFwiLFxuICAgICAgICAgIHF1b3RlOiBjbWQucXVvdGUsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgbm90ZWQg4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdIG9uICR7ci5zbHVnfS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJub3RlLmFkZGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCBxdW90ZTogci5ub3RlLnF1b3RlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZXNcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5ub3Rlc09mKHsgZG9jOiBjbWQuZG9jLCAuLi4oY21kLmFsbCA/IHsgYWxsOiB0cnVlIH0gOiB7fSkgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCBub3Rlczogci5ub3RlcyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2sucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24ucmVtb3ZlVGFzayhjbWQuaWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCByZW1vdmVkOiB0cnVlIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFza3MuY2xlYXJcIjoge1xuICAgICAgICBjb25zdCBjbGVhcmVkID0gc2Vzc2lvbi5jbGVhckRvbmVUYXNrcygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBjbGVhcmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwid29ya2luZ1wiOiB7XG4gICAgICAgIC8vIEU1MydzIHNub296ZS4gSXQgZG9lcyBOT1QgcG9zdCB0byB0aGUgY2hhdDogYW4gYWdlbnQgc2F5aW5nIFwic3RpbGxcbiAgICAgICAgLy8gd29ya2luZ1wiIGluIHRoZSBjb252ZXJzYXRpb24gaXMgYSByZXBseSwgYW5kIGl0IGNhbiBkbyB0aGF0IHdpdGhcbiAgICAgICAgLy8gYHNheWAg4oCUIHRoaXMgaXMgdGhlIHF1aWV0ZXIgdGhpbmcsIGZvciB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG9cbiAgICAgICAgLy8gcmVwb3J0IHlldCBidXQgdGhlIGFsYXJtIHNob3VsZCBzdG9wLlxuICAgICAgICBjb25zdCBtcyA9IGNtZC5zZWNvbmRzICE9PSB1bmRlZmluZWQgPyBjbWQuc2Vjb25kcyAqIDEwMDAgOiBERUZBVUxUX1NOT09aRV9NUztcbiAgICAgICAgYWNrbm93bGVkZ2VkVW50aWwgPSBEYXRlLm5vdygpICsgTWF0aC5tYXgoMCwgbXMpO1xuICAgICAgICAvLyBXaGF0ZXZlciBpcyBwZW5kaW5nIGlzIGFja25vd2xlZGdlZCwgc28gaXQgbXVzdCBuZXZlciBiZSBudWRnZWQgYWdhaW4uXG4gICAgICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pO1xuICAgICAgICBpZiAodykgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdW50aWw6IGFja25vd2xlZGdlZFVudGlsLFxuICAgICAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgbXMpIC8gMTAwMCksXG4gICAgICAgICAgLi4uKHcgPyB7IHdhaXRpbmc6IHcubWVzc2FnZUlkIH0gOiB7fSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5zdGFydFwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnN0YXJ0VGFzayhjbWQudGV4dCwgXCJhZ2VudFwiKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInRhc2suc3RhcnRlZFwiLCB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQsIGJ5OiBcImFnZW50XCIgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHQuaWQsIHRleHQ6IHQudGV4dCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgdCA9IHNlc3Npb24uc2V0VGFza1N0YXR1cyhjbWQuaWQsIGNtZC5zdGF0dXMpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCBzdGF0dXM6IHQuc3RhdHVzIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5kb25lXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZmluaXNoVGFzayhjbWQuaWQsIGNtZC5vdXRjb21lKTtcbiAgICAgICAgaWYgKCFyLmFscmVhZHkpXG4gICAgICAgICAgYW5ub3VuY2UoYERvbmU6ICR7ci50YXNrLnRleHR9JHtyLnRhc2sub3V0Y29tZSA/IGAg4oCUICR7ci50YXNrLm91dGNvbWV9YCA6IFwiXCJ9YCwge1xuICAgICAgICAgICAgZmFjdDogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICAgIHRhc2s6IHIudGFzay5pZCxcbiAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IHRhc2s6IHIudGFzay5pZCwgYWxyZWFkeTogci5hbHJlYWR5IH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5lZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdE5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIGJvZHk6IGNtZC5ib2R5LCB3aG86IFwiYWdlbnRcIiB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IHJld3JvdGUgYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIHJlc29sdmVkOiBjbWQucmVzb2x2ZWQgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCAke2NtZC5yZXNvbHZlZCA/IFwicmVzb2x2ZWRcIiA6IFwicmVvcGVuZWRcIn0gYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm5vdGUucmVzb2x2ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiYWdlbnRcIiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCByZXNvbHZlZDogci5ub3RlLnJlc29sdmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZW1vdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZW1vdmVOb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgcmVtb3ZlZCBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5yZW1vdmVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIGNvbnN0IHAgPSBzZXNzaW9uLmNvbXBhcmUoeyBkb2M6IGNtZC5kb2MsIGFnYWluc3Q6IGNtZC5hZ2FpbnN0IH0pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvYzogcC5kb2MsXG4gICAgICAgICAgYWN0aXZlOiBwLmFjdGl2ZSxcbiAgICAgICAgICBhZ2FpbnN0OiBwLmFnYWluc3QsXG4gICAgICAgICAgc2FtZTogcC5kaWZmLnNhbWUsXG4gICAgICAgICAgY29hcnNlOiBwLmRpZmYuY29hcnNlLFxuICAgICAgICAgIGh1bmtzOiBwLmRpZmYuaHVua3MsXG4gICAgICAgICAgdW5pZmllZDogdW5pZmllZChwLmRpZmYsIHtcbiAgICAgICAgICAgIGZyb206IGB2JHtwLmFjdGl2ZX1gLFxuICAgICAgICAgICAgdG86IHNpZGVOYW1lKHAuYWdhaW5zdCwgc2Vzc2lvbi5kb2MocC5kb2MpLm5hbWUpLFxuICAgICAgICAgICAgLi4uKGNtZC5jb250ZXh0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgY29udGV4dDogY21kLmNvbnRleHQgfSksXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QsIGh1bmtzOiBjbWQuaHVua3MgfSk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgdG9vayAke3IuYXBwbGllZH0gY2hhbmdlJHtyLmFwcGxpZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGZyb20gJHtzaWRlTmFtZShjbWQuYWdhaW5zdCwgc2Vzc2lvbi5kb2Moci5zbHVnKS5uYW1lKX0gaW50byB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXJnZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgaHVua3M6IGNtZC5odW5rcywgYnk6IFwiYWdlbnRcIiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBhcHBsaWVkOiByLmFwcGxpZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmaW5kXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmZpbmQoY21kLmZpbHRlcik7XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCBhZGRlZCA9IGFkZFBhdGhzKGNtZC5wYXRocyk7XG4gICAgICAgIHJldHVybiB7IGVudHJpZXM6IGFkZGVkLm1hcCgoYSkgPT4gKHsgLi4uYS5lbnRyeSwgYWRkZWQ6IGEuYWRkZWQgfSkpIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDc6IHRoZSBhZ2VudCBtYXkgbmFtZSBhIGRvYyB0aGUgaHVtYW4gaGFzIG5vdFxuICAgICAgICAvLyBvcGVuZWQsIGJ5IEFCU09MVVRFIHBhdGggKHRoZSBDTEkgcmVzb2x2ZXMgaXQgYWdhaW5zdCBpdHMgb3duIGN3ZCk7XG4gICAgICAgIC8vIGl0IGlzIG9wZW5lZCBpbXBsaWNpdGx5IHVuZGVyIHRoZSBzYW1lIGFkbWlzc2lvbiBydWxlIGFzIHRoZVxuICAgICAgICAvLyBzdXJmYWNlJ3MgYG9wZW5gIOKAlCBhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSDigJQgd2l0aG91dFxuICAgICAgICAvLyBtb3ZpbmcgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICAgICAgaWYgKGNtZC5kb2MgJiYgaXNBYnNvbHV0ZShjbWQuZG9jKSAmJiAhc2Vzc2lvbi5maW5kRG9jKGNtZC5kb2MpKSB7XG4gICAgICAgICAgY29uc3QgbyA9IHNlc3Npb24ub3BlblBhdGgoY21kLmRvYywgeyBmb2N1czogZmFsc2UgfSk7XG4gICAgICAgICAgaWYgKG8uY3JlYXRlZClcbiAgICAgICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJkb2Mub3BlbmVkXCIsXG4gICAgICAgICAgICAgIGRvYzogby5zbHVnLFxuICAgICAgICAgICAgICBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoby5zbHVnKSxcbiAgICAgICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBmcm9tOiBjbWQuZnJvbSxcbiAgICAgICAgICBsYWJlbDogY21kLmxhYmVsLFxuICAgICAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IGNyZWF0ZWQgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7Y21kLmxhYmVsID8gYCDigJQgJHtjbWQubGFiZWx9YCA6IFwiXCJ9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4gfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uLCBmcm9tOiByLnZlcnNpb24uZnJvbSwgcGF0aDogci52ZXJzaW9uLnBhdGggfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiYWdlbnRcIiwgY21kLnRleHQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBpZDogbS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIHJldHVybiBhY3RpdmF0ZShjbWQuZG9jLCBjbWQudmVyc2lvbiwgXCJhZ2VudFwiKTtcbiAgICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgICByZXR1cm4ge307XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoKGNtZCBhcyB7IHR5cGU/OiB1bmtub3duIH0pLnR5cGUpfSDigJQgbm90aGluZyB3YXMgYXBwbGllZGAsXG4gICAgICAgICAgNDAwLFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIFwiY29udGV4dC5hZGRcIixcbiAgICAgICAgICAgIFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAgIFwic2F5XCIsXG4gICAgICAgICAgICBcImFjdGl2YXRlXCIsXG4gICAgICAgICAgICBcImNsb3NlXCIsXG4gICAgICAgICAgICBcIm1ldGFcIixcbiAgICAgICAgICAgIFwiZmluZFwiLFxuICAgICAgICAgICAgXCJncmFwaFwiLFxuICAgICAgICAgICAgXCJiYWNrbGlua3NcIixcbiAgICAgICAgICAgIFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgICBcIm1ldGEuc2V0XCIsXG4gICAgICAgICAgICAuLi5TVFJVQ1RVUkVfT1BTLFxuICAgICAgICAgIF0sXG4gICAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlZnVzYWwgPSAoZTogdW5rbm93bik6IFJlc3BvbnNlID0+IHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBlLm1lc3NhZ2UsXG4gICAgICAgICAgLi4uKGUuY2hvaWNlcyA/IHsgY2hvaWNlczogZS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAgICAgLi4uKGUuaGludCA/IHsgaGludDogZS5oaW50IH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICAgIHsgc3RhdHVzOiBlLnN0YXR1cyB9LFxuICAgICAgKTtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFBhdGhFcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoZSkgfSwgeyBzdGF0dXM6IDUwMCB9KTtcbiAgfTtcblxuICBjb25zdCBldmVudHNSZXNwb25zZSA9IChyZXE6IFJlcXVlc3QsIHVybDogVVJMKTogUmVzcG9uc2UgPT4ge1xuICAgIHRvdWNoKCk7XG4gICAgcmV0dXJuIHNzZVJlc3BvbnNlKHtcbiAgICAgIGxvZyxcbiAgICAgIHNpbmNlOiBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIi0xXCIsIDEwKSxcbiAgICAgIGhlYXJ0YmVhdE1zOiBTU0VfSEVBUlRCRUFUX01TLFxuICAgICAgY2xpZW50czogc3NlQ2xpZW50cyxcbiAgICAgIHNpZ25hbDogcmVxLnNpZ25hbCxcbiAgICAgIG9uT3BlbjogdG91Y2gsXG4gICAgICBvbkNsb3NlOiB0b3VjaCxcbiAgICB9KTtcbiAgfTtcblxuICAvLyAtLS0gc2VydmUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBcIjEyNy4wLjAuMVwiLFxuICAgIHJvdXRlcyxcbiAgICBpZGxlVGltZW91dDogSURMRV9USU1FT1VUX1NFQyxcbiAgICBkZXZlbG9wbWVudDogeyBobXI6IG1vZGUgPT09IFwiZGV2XCIgfSxcbiAgICBmZXRjaChyZXEsIHNydikge1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSwgTk9XIFRIRSBLSVQnUyBBTkQgTk9XIFJPU1RFUi1XSURFLiBUaGlzIHdhcyB0aGVcbiAgICAgIC8vIGZpcnN0IGNvcHkgYW5kIGl0IGxpc3RlZCBwYXRocyAoYC93c2AsIGAvY21kYCwgYC9mcy9gKSDigJQgYSBsaXN0IHRoYXRcbiAgICAgIC8vIHdhcyBhbHJlYWR5IG1pc3NpbmcgYC9zdGF0ZWAsIHdoaWNoIGFuc3dlcnMgYSBzZXNzaW9uJ3Mgd2hvbGUgY29udGVudHMuXG4gICAgICAvLyBgc3JjL2tpdC93aXJlL29yaWdpbi50c2AgcmVmdXNlcyBvbiB0aGUgUkVRVUVTVCBpbnN0ZWFkLCBzbyBubyBwYXRoXG4gICAgICAvLyBpbnZlbnRvcnkgY2FuIGdvIHN0YWxlLCBhbmQgYGdyaW1vaXJlL29yaWdpbi1ndWFyZC13YXJkLnRlc3QudHNgIGhvbGRzXG4gICAgICAvLyB0aGUgb3RoZXIgZWlnaHQgZGFlbW9ucyB0byB0aGUgc2FtZSBsaW5lLlxuICAgICAge1xuICAgICAgICBjb25zdCByZWZ1c2VkID0gcmVmdXNlRm9yZWlnbk9yaWdpbihyZXEsIHNydi5wb3J0KTtcbiAgICAgICAgaWYgKHJlZnVzZWQpIHJldHVybiByZWZ1c2VkO1xuICAgICAgfVxuICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsKTtcbiAgICAgIGNvbnN0IHBhdGggPSB1cmwucGF0aG5hbWU7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgLy8g4pqgIFRIRSBTRVNTSU9OIFNBWVMgV0hBVCBJVFMgT1dOIFRJTUVPVVQgSVMuIGAtLXRpbWVvdXQgMGAgaGFzIGFsd2F5cyBtZWFudFxuICAvLyBcInN0YW5kIHVudGlsIGNsb3NlZFwiIGFuZCB0aGVyZSB3YXMgbm8gd2F5IHRvIGNvbmZpcm0gZnJvbSBvdXRzaWRlIHRoYXQgYVxuICAvLyBkYWVtb24gaGFkIHRha2VuIGl0IOKAlCB3aGljaCBpcyB0aGUga2luZCBvZiBzZXR0aW5nIHlvdSBmaW5kIG91dCBhYm91dCBieVxuICAvLyBsb3NpbmcgYSBzZXNzaW9uIGF0IHRoZSB3cm9uZyBtb21lbnQuXG4gIGxvZy5lbWl0KHtcbiAgICB0eXBlOiBcInJlYWR5XCIsXG4gICAgbW9kZSxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlLFxuICAgIGlkbGVfdGltZW91dF9zOiBvcHRzLnRpbWVvdXRTID8/IDE4MDAsXG4gIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICAvLyBFNjI6IG9uZSBsaW5lIHdoZW4gdGhlIHNlc3Npb24gaGFzIHNvbWV0aGluZyB3b3J0aCBsb29raW5nIGF0LCBhbmQgc2lsZW5jZVxuICAvLyB3aGVuIGl0IGRvZXMgbm90LlxuICAvL1xuICAvLyDim5QgQSBTVU1NQVJZLCBOT1QgQSBSRVBFQVQuIFRoZSBwZXItZG9jdW1lbnQgY29uZmxpY3RzIGFib3ZlIHNheSB0aGVpciBvd25cbiAgLy8gcGllY2Ugd2l0aCB0aGUgU2F2ZS9SZXZlcnQgbnVhbmNlOyB0aGlzIGNvdW50cyB3aGF0IGlzIHRoZXJlIOKAlCBpbmNsdWRpbmdcbiAgLy8gdGhlIHRoaW5ncyB0aG9zZSBsaW5lcyBuZXZlciBjb3ZlcmVkLCBsaWtlIGEgY29udGV4dCBlbnRyeSBwb2ludGluZyBhdFxuICAvLyBub3RoaW5nIOKAlCBhbmQgcG9pbnRzIGF0IHRoZSB2ZXJiLiBBIHN0YXJ0dXAgY2hlY2sgdGhhdCByZXN0YXRlcyB3aGF0IHdhc1xuICAvLyBqdXN0IHNhaWQsIG9yIHRoYXQgYW5ub3VuY2VzIGl0c2VsZiB3aGVuIGV2ZXJ5dGhpbmcgaXMgZmluZSwgaXMgYSBsaW5lXG4gIC8vIHBlb3BsZSBsZWFybiB0byBza2lwLlxuICB7XG4gICAgY29uc3QgbGlzdCA9IHNlc3Npb24uY2hlY2t1cCgpO1xuICAgIGNvbnN0IGxpbmUgPSBzdW1tYXJ5KGxpc3QpO1xuICAgIGlmIChsaW5lKSB7XG4gICAgICBhbm5vdW5jZShsaW5lLCB7IGZhY3Q6IFwiZG9jdG9yXCIsIGZpbmRpbmdzOiBsaXN0Lmxlbmd0aCB9KTtcbiAgICAgIC8vIFRoZSBhZ2VudCBnZXRzIHRoZSB3aG9sZSByZXBvcnQgb24gaXRzIHRhaWwsIHNvIGFuIGFnZW50IHRoYXQgYXJyaXZlc1xuICAgICAgLy8gbGF0ZXIgZG9lcyBub3QgaGF2ZSB0byBhc2sg4oCUIGFuZCBkb2VzIG5vdCBoYXZlIHRvIHBhcnNlIHRoZSBzZW50ZW5jZS5cbiAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJkb2N0b3JcIiwgY291bnQ6IGxpc3QubGVuZ3RoLCBmaW5kaW5nczogbGlzdCB9KTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRTUzJ3MgYXR0ZW50aW9uIHRpY2suIFNlcGFyYXRlIGZyb20gaG91c2VrZWVwaW5nIGJlY2F1c2UgaXQgaXMgYWJvdXQgdGhlXG4gICAqIEhVTUFOJ3MgcGF0aWVuY2UgcmF0aGVyIHRoYW4gdGhlIGRhZW1vbidzIGxpZmV0aW1lLCBhbmQgYmVjYXVzZSBpdCBtdXN0IHJ1blxuICAgKiBvbiBhIHNsb3dlciBjbG9jazogYSAyNTAgbXMgc3dlZXAgcmUtYnJvYWRjYXN0aW5nIHN0YXRlIHdvdWxkIGJlIGNodXJuIGZvciBhXG4gICAqIHZhbHVlIHRoYXQgY2hhbmdlcyB0d2ljZSBpbiBhIHdhaXQuXG4gICAqL1xuICBsZXQgbGFzdFdhaXRpbmc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBhdHRlbnRpb25UaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBub3csIHsgYWNrbm93bGVkZ2VkVW50aWwgfSk7XG4gICAgLy8gRTY1OiBhIG5vdGUgZmxpcHBpbmcgdG8gc3RhbGxlZCBpcyBhIGNoYW5nZSB0aGUgc3VyZmFjZSBtdXN0IHNlZSB0b28uXG4gICAgLy8g4pqgIE5PVCBhIG51ZGdlOiBzZWUgRTY1IGluIHRoZSBkZWNpc2lvbiBsb2cg4oCUIHRoZSBub3RlJ3MgYWN0IGlzIHRoZVxuICAgIC8vIGh1bWFuJ3MsIGFuZCB0aGUgZXZlbnQgdGhhdCBkZWxpdmVyZWQgaXQgYWxyZWFkeSBjYXJyaWVkIGl0LlxuICAgIGNvbnN0IG5vdGVzID0gbm90ZXNXYWl0aW5nKHNlc3Npb24ubm90ZUZhY3RzKCksIHNlc3Npb24ubWVzc2FnZXMoKSwgbm93LCB7XG4gICAgICBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICB9KTtcbiAgICBjb25zdCBrZXkgPSBbXG4gICAgICB3ID8gYCR7dy5tZXNzYWdlSWR9OiR7dy5iYWRnZX1gIDogXCItXCIsXG4gICAgICAuLi5ub3Rlcy5tYXAoKG4pID0+IGAke24ubm90ZUlkfToke24uYmFkZ2V9YCksXG4gICAgXS5qb2luKFwifFwiKTtcbiAgICBpZiAoa2V5ID09PSBsYXN0V2FpdGluZykgcmV0dXJuO1xuICAgIGxhc3RXYWl0aW5nID0ga2V5O1xuICAgIC8vIFRoZSBiYWRnZSBjaGFuZ2VkLCBzbyB0aGUgc3VyZmFjZSBuZWVkcyB0aGUgbmV3IHNuYXBzaG90LlxuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgaWYgKCF3KSByZXR1cm47XG4gICAgaWYgKHcuYmFkZ2UgIT09IFwic3RhbGxlZFwiIHx8IG51ZGdlZC5oYXMody5tZXNzYWdlSWQpKSByZXR1cm47XG4gICAgbnVkZ2VkLmFkZCh3Lm1lc3NhZ2VJZCk7XG4gICAgLy8g4puUIFRIRSBOVURHRSBHT0VTIFRPIFRIRSBBR0VOVCdTIFRBSUwgQU5EIE5PV0hFUkUgRUxTRS4gVGhlIGh1bWFuIGFscmVhZHlcbiAgICAvLyBzZWVzIHRoZSBiYWRnZTsgcHV0dGluZyB0aGlzIGluIHRoZSBjaGF0IGFzIHdlbGwgd291bGQgYmUgdGVsbGluZyB0aGVtXG4gICAgLy8gd2hhdCB0aGV5IGFyZSBsb29raW5nIGF0LiBJdCBjYXJyaWVzIHRoZSBtZXNzYWdlIFRFWFQgYmVjYXVzZSBhbiBhZ2VudFxuICAgIC8vIHRoYXQgaGFzIGJlZW4gYXdheSBuZWVkcyB0byBrbm93IHdoYXQgaXMgcGVuZGluZywgbm90IGp1c3QgdGhhdCBzb21ldGhpbmdcbiAgICAvLyBpcyDigJQgYW5kIGl0IG5hbWVzIHRoZSB0d28gd2F5cyBvdXQsIGJlY2F1c2UgYSBudWRnZSB0aGF0IGRvZXMgbm90IHNheSBob3dcbiAgICAvLyB0byBhbnN3ZXIgaXQgaW52aXRlcyBhIGZvdXJ0aCBwcmltaXRpdmUuXG4gICAgY29uc3QgcGVuZGluZyA9IHNlc3Npb24ubWVzc2FnZXMoKS5maW5kKChtKSA9PiBtLmlkID09PSB3Lm1lc3NhZ2VJZCk7XG4gICAgbG9nLmVtaXQoe1xuICAgICAgdHlwZTogXCJ3YWl0aW5nXCIsXG4gICAgICBtZXNzYWdlX2lkOiB3Lm1lc3NhZ2VJZCxcbiAgICAgIHNlY29uZHM6IE1hdGgucm91bmQoKERhdGUubm93KCkgLSB3LnNpbmNlKSAvIDEwMDApLFxuICAgICAgLi4uKHBlbmRpbmcgPyB7IHRleHQ6IHBlbmRpbmcudGV4dCB9IDoge30pLFxuICAgICAgaGludDogXCJyZXBseSB3aXRoIGBzYXlgLCBvciBgd29ya2luZ2AgdG8gc2F5IHlvdSBhcmUgc3RpbGwgb24gaXRcIixcbiAgICB9KTtcbiAgfSwgMTAwMCk7XG5cbiAgY29uc3Qgc3RvcEhvdXNla2VlcGluZyA9IHN0YXJ0SG91c2VrZWVwaW5nKHtcbiAgICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IHNvY2tldHMuc2l6ZSArIHNzZUNsaWVudHMuc2l6ZSxcbiAgICBpZGxlTXM6ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LFxuICAgIHRvdWNoLFxuICAgIHRpbWVvdXRNczogKG9wdHMudGltZW91dFMgPz8gMTgwMCkgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICBsZXQgcmVzb2x2ZVNodXRkb3duITogKCkgPT4gdm9pZDtcbiAgY29uc3Qgc2h1dGRvd24gPSBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4ge1xuICAgIHJlc29sdmVTaHV0ZG93biA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGNsZWFudXBEaXNjb3ZlcnkgPSAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSDigJQgZmluZSAqL1xuICAgIH1cbiAgICB1bmxpbmtJZk1hdGNoZXMobGF0ZXN0RmlsZSwgc2Vzc2lvbklkLCAocmF3KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpZCA9IChKU09OLnBhcnNlKHJhdykgYXMgeyBzZXNzaW9uX2lkPzogdW5rbm93biB9KS5zZXNzaW9uX2lkO1xuICAgICAgICByZXR1cm4gdHlwZW9mIGlkID09PSBcInN0cmluZ1wiID8gaWQgOiBudWxsO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuXG4gIC8vIFRoZSBvcmRlciBpcyB0aGUgaGVhZGVyJ3MsIGFuZCB0aGUgaGVhZGVyIHNheXMgd2h5LlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgY2xlYXJJbnRlcnZhbChhdHRlbnRpb25UaW1lcik7XG4gICAgZm9yIChjb25zdCB3IG9mIHdhdGNoZXJzLnZhbHVlcygpKSB3LmNsb3NlKCk7XG4gICAgd2F0Y2hlcnMuY2xlYXIoKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgcGVuZGluZy52YWx1ZXMoKSkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHRyeSB7XG4gICAgICBzZXNzaW9uLnBlcnNpc3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiY2xvc2VkXCIgfSk7XG4gICAgdm9pZCBkcmFpbkFuZFN0b3AoeyBzZXJ2ZXIsIGNsaWVudHM6IHNzZUNsaWVudHMsIHNvY2tldHMgfSkudGhlbihyZXNvbHZlU2h1dGRvd24pO1xuICB9O1xuICBkb25lLnRoZW4oKCkgPT4gY2xvc2UoKSk7XG5cbiAgcmV0dXJuIHsgcG9ydDogYm91bmRQb3J0LCBzZXNzaW9uSWQsIG1vZGUsIGRpcjogc2Vzc2lvbi5kaXIsIGNsb3NlLCBkb25lLCBzaHV0ZG93biB9O1xufVxuXG4vKipcbiAqIEEgcGF0aCB0eXBlZCBpbiB0aGUgU1VSRkFDRS4gVGhlIHBhZ2UgaGFzIG5vIHdvcmtpbmcgZGlyZWN0b3J5LCBzbyBhIHBhdGhcbiAqIGZyb20gaXQgbXVzdCBiZSBhYnNvbHV0ZSBvciBzdGFydCBhdCBgfmAg4oCUIHdoaWNoIGlzIGV4cGFuZGVkIEhFUkUuIEJlZm9yZVxuICogdGhpcywgYH4vRG9jdW1lbnRzYCByZWFjaGVkIGByZXNvbHZlKClgIGFuZCB3YXMgdGFrZW4gYXMgcmVsYXRpdmUgdG8gdGhlXG4gKiBkYWVtb24ncyBjd2QgKHRoZSBza2lsbCBmb2xkZXIpOiB0aGUgcGF0aCBib3ggY29tcGxldGVkIGB+L+KApmAgKGxpc3RpbmdcbiAqIGV4cGFuZHMgaXQpIGFuZCB0aGVuIEVudGVyIGZhaWxlZCB3aXRoIFwibm8gc3VjaCBmaWxlIG9yIGZvbGRlcjpcbiAqIOKApi9za2lsbHMvc2NyaXB0b3JpdW0vfi9Eb2N1bWVudHMv4oCmXCIgKENvbGUsIDIwMjYtMDktMTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VyZmFjZVBhdGgocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHAudHJpbSgpO1xuICBpZiAodCA9PT0gXCJ+XCIgfHwgdC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBleHBhbmRIb21lKHQpO1xuICBpZiAoIWlzQWJzb2x1dGUodCkpXG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke3B9XCIgaXMgbm90IGEgZnVsbCBwYXRoIOKAlCBzdGFydCBpdCB3aXRoIC8gb3Igfi9gLCA0MDApO1xuICByZXR1cm4gcmVzb2x2ZSh0KTtcbn1cblxuLyoqIEEgc3RydWN0dXJlIG9wIGZyb20gdGhlIHN1cmZhY2UsIHdpdGggZXZlcnkgcGF0aCBmaWVsZCB0aHJvdWdoIGBzdXJmYWNlUGF0aGAuICovXG5mdW5jdGlvbiBhbmNob3JTdXJmYWNlUGF0aHMob3A6IFN0cnVjdHVyZU9wKTogU3RydWN0dXJlT3Age1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5vcCB9O1xuICBmb3IgKGNvbnN0IGsgb2YgW1wiZGlyXCIsIFwicGF0aFwiLCBcImludG9cIl0gYXMgY29uc3QpXG4gICAgaWYgKHR5cGVvZiBvdXRba10gPT09IFwic3RyaW5nXCIpIG91dFtrXSA9IHN1cmZhY2VQYXRoKG91dFtrXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gb3V0IGFzIFN0cnVjdHVyZU9wO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB3b3Jrc3BhY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgICAgd29ya3NwYWNlOiBmbGFncy53b3Jrc3BhY2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IGEgY2xlYW4gY2xvc2UgbGVhdmVzIG5vIGVtcHR5IGxvZyBiZWhpbmQuXG4gIGlmIChyZXMuY29kZSA9PT0gMCAmJiBmbGFncy5sb2cpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHN0YXRTeW5jKGZsYWdzLmxvZykuc2l6ZSA9PT0gMCkgdW5saW5rU3luYyhmbGFncy5sb2cpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG4gIHJldHVybiByZXMuY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGVcbiAqIGJ1bmRsZSwgc28gdGhlcmUgaXMgbm8gc3VjaCBibG9jayBoZXJlLCBhbmQgdGhpcyB0YWtlcyBubyBhcmd1bWVudHM6IHRoZVxuICogY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8vIFdITyBJUyBBTExPV0VEIFRPIERSSVZFIEEgTE9DQUwgREFFTU9OIOKAlCB0aGUgb25lIGNoZWNrIHRoYXQgbWFrZXMgYVxuLy8gbG9jYWxob3N0IHBvcnQgbm90IGEgcHVibGljIEFQSS5cbi8vXG4vLyDim5QgVEhFIEhPTEUgVEhJUyBDTE9TRVMgV0FTIERFTU9OU1RSQVRFRCwgTk9UIElNQUdJTkVELiBBIHNwZWxsIGRhZW1vbiBiaW5kc1xuLy8gYDEyNy4wLjAuMTo8cG9ydD5gIGFuZCBhbnN3ZXJzIHdoYXRldmVyIGFza3MuICoqQW55IHdlYiBwYWdlIHRoZSBodW1hbiBpc1xuLy8gYnJvd3NpbmcgY2FuIHJlYWNoIGl0Kio6IGBuZXcgV2ViU29ja2V0KFwid3M6Ly8xMjcuMC4wLjE6PHBvcnQ+L3dzXCIpYCBhbmRcbi8vIGBmZXRjaChcImh0dHA6Ly8xMjcuMC4wLjE6PHBvcnQ+L2NtZFwiLCB7bWV0aG9kOlwiUE9TVFwiLCDigKZ9KWAgYXJlIG9yZGluYXJ5XG4vLyBzYW1lLW1hY2hpbmUgcmVxdWVzdHMsIGFuZCB0aGUgYnJvd3NlciBtYWtlcyB0aGVtIGZyb20gYSBwYWdlIHRoZSBodW1hbiBkaWRcbi8vIG5vdCB3cml0ZS4gU2NyaXB0b3JpdW0ncyB2ZXJpZnkgcGFzcyBidWlsdCBhIHdvcmtpbmcgb25lIOKAlCBhIGZvcmVpZ24gcGFnZVxuLy8gZHJpdmluZyBgb3BlbmAgdGhlbiBgc2F2ZWAgdG8gd3JpdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgZmlsZSBvdXRzaWRlIHRoZVxuLy8gc2Vzc2lvbiAoMjAyNi0wOS0xMSkuIFRoYXQgaXMgYSBmaWxlIHdyaXRlIGZyb20gYSBwYWdlIHRoZSBodW1hbiBtZXJlbHlcbi8vIHZpc2l0ZWQuXG4vL1xuLy8g4puUIEFORCBUSEUgV0hPTEUgRklYIFJFU1RTIE9OIE9ORSBBU1lNTUVUUlk6ICoqb25seSBicm93c2VycyBzZW5kIGBPcmlnaW5gLioqXG4vLyBBIGJyb3dzZXIgYXR0YWNoZXMgaXQgdG8gZXZlcnkgY3Jvc3Mtb3JpZ2luIHJlcXVlc3QgYW5kIGNhbm5vdCBiZSB0YWxrZWQgb3V0XG4vLyBvZiBpdCDigJQgaXQgaXMgc2V0IGJ5IHRoZSB1c2VyIGFnZW50LCBub3QgYnkgdGhlIHBhZ2UncyBzY3JpcHQuIEJ1bidzIGBmZXRjaGAsXG4vLyB3aGljaCBpcyB3aGF0IGV2ZXJ5IHNwZWxsJ3MgQ0xJIHVzZXMsIHNlbmRzIG5vbmUgYXQgYWxsLiBTbzpcbi8vXG4vLyAgICAgT3JpZ2luIGFic2VudCAgICAgICAgICAgIOKGkiB0aGUgQ0xJLCBgY3VybGAsIGEgdGVzdC4gQUxMT1cuXG4vLyAgICAgT3JpZ2luID09PSBvdXIgb3duIHBhZ2UgIOKGkiB0aGUgc3VyZmFjZSB3ZSBzZXJ2ZWQuIEFMTE9XLlxuLy8gICAgIE9yaWdpbiBhbnl0aGluZyBlbHNlICAgICDihpIgYSBwYWdlIHdlIGRpZCBub3Qgc2VydmUuIFJFRlVTRS5cbi8vXG4vLyDimqAgVEhBVCBJUyBXSFkgVEhJUyBORUVEUyBOTyBQRVItU1BFTEwgUk9VVEUgSU5WRU5UT1JZLCBhbmQgd2h5IGl0IGlzIGFwcGxpZWRcbi8vIHRvIEVWRVJZIHBhdGggcmF0aGVyIHRoYW4gdG8gYSBoYW5kLWxpc3RlZCBzZXQgb2YgbXV0YXRpbmcgb25lcy4gQSBsaXN0IG9mXG4vLyBcInRoZSBkYW5nZXJvdXMgcm91dGVzXCIgaXMgYSB0aGluZyB0aGF0IGdvZXMgc3RhbGUgdGhlIG5leHQgdGltZSBhIHJvdXRlIGlzXG4vLyBhZGRlZDsgdGhlIGFzeW1tZXRyeSBhYm92ZSBpcyBhIHByb3BlcnR5IG9mIHRoZSByZXF1ZXN0LCBub3Qgb2YgdGhlIFVSTC4gVGhlXG4vLyBmaXJzdCB2ZXJzaW9uIG9mIHRoaXMgY2hlY2sgKHNjcmlwdG9yaXVtJ3MsIGBzZXJ2ZXIudHNgKSBkaWQgbGlzdCBwYXRocyDigJRcbi8vIGAvd3NgLCBgL2NtZGAsIGAvZnMvYCDigJQgYW5kIHRoYXQgbGlzdCB3YXMgYWxyZWFkeSBpbmNvbXBsZXRlIGJ5IHRoZSB0aW1lIGl0XG4vLyB3YXMgbGlmdGVkIGhlcmUsIGJlY2F1c2UgYC9zdGF0ZWAgYW5zd2VycyBldmVyeXRoaW5nIGluIGEgc2Vzc2lvbiB0byBhbnlvbmVcbi8vIHdobyBhc2tzLiBCcm9hZGVuaW5nIGl0IHRvIGV2ZXJ5IHBhdGggaXMgYm90aCBzaW1wbGVyIGFuZCBzdHJpY3Rlci5cbi8vXG4vLyDimqAgV0hBVCBJVCBERUxJQkVSQVRFTFkgRE9FUyBOT1QgRE8uIEl0IGlzIG5vdCBhdXRoZW50aWNhdGlvbjogYW55dGhpbmcgb25cbi8vIHRoaXMgbWFjaGluZSB0aGF0IGNhbiBmb3JnZSBvciBvbWl0IGEgaGVhZGVyIGlzIHVuYWZmZWN0ZWQsIGFuZCBpcyBzdXBwb3NlZFxuLy8gdG8gYmUg4oCUIHRoZSBDTEkgaXMgZXhhY3RseSBzdWNoIGEgY2FsbGVyLiBJdCBzdG9wcyB0aGUgQlJPV1NFUi1zaGFwZWQgYXR0YWNrLFxuLy8gd2hpY2ggaXMgdGhlIG9uZSBhIGh1bWFuIGlzIGV4cG9zZWQgdG8gYnkgcmVhZGluZyB0aGVpciBtYWlsLlxuXG4vKipcbiAqIEJvdGggbG9vcGJhY2sgc3BlbGxpbmdzIGEgYnJvd3NlciBtYXkgcHV0IGluIGBPcmlnaW5gIGZvciBvdXIgb3duIHBhZ2UuXG4gKlxuICog4puUIEFOIFVOS05PV04gUE9SVCBNQVRDSEVTIE5PVEhJTkcsIGFuZCBhIGNlbGwgaGFkIHRvIHByb3ZlIGl0LiBgc3J2LnBvcnRgIGlzXG4gKiB0eXBlZCBgbnVtYmVyIHwgdW5kZWZpbmVkYCwgYW5kIHRoZSBmaXJzdCB2ZXJzaW9uIG9mIHRoaXMgaW50ZXJwb2xhdGVkIGl0XG4gKiBzdHJhaWdodCBpbnRvIHRoZSB0ZW1wbGF0ZSDigJQgc28gd2l0aCBubyBwb3J0IHRoZSBhbGxvd2VkIHNldCBiZWNhbWVcbiAqIGBodHRwOi8vMTI3LjAuMC4xOnVuZGVmaW5lZGAsIGEgc3RyaW5nIGEgcGFnZSBjYW4gc2ltcGx5IEJFIGhvc3RlZCBhdC4gQW5cbiAqIGVtcHR5IHNldCBpcyB0aGUgb25seSBzYWZlIHJlYWRpbmcgb2YgXCJ3ZSBkbyBub3Qga25vdyB3aG8gd2UgYXJlXCIuXG4gKi9cbmZ1bmN0aW9uIG91cnMocG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICBpZiAodHlwZW9mIHBvcnQgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIFtdO1xuICByZXR1cm4gW2BodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBgaHR0cDovL2xvY2FsaG9zdDoke3BvcnR9YF07XG59XG5cbi8qKlxuICogSXMgdGhpcyByZXF1ZXN0IGFsbG93ZWQgdG8gZHJpdmUgdGhlIGRhZW1vbj9cbiAqXG4gKiBBbiBhYnNlbnQgYE9yaWdpbmAgKHRoZSBDTEksIGBjdXJsYCwgYSB0ZXN0KSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlO1xuICogbm90aGluZyBlbHNlLlxuICpcbiAqIOKaoCBCT1RIIExPT1BCQUNLIFNQRUxMSU5HUyBBUkUgQUNDRVBURUQgYmVjYXVzZSB0aGUgaHVtYW4gdHlwZXMgdGhlIFVSTC4gVGhlXG4gKiBkYWVtb24gcHJpbnRzIGBodHRwOi8vMTI3LjAuMC4xOjxwb3J0PmAsIGJ1dCBhIHBlcnNvbiB3aG8gdmlzaXRzXG4gKiBgbG9jYWxob3N0Ojxwb3J0PmAgZ2V0cyBhIHBhZ2Ugd2hvc2UgYE9yaWdpbmAgaXMgYGxvY2FsaG9zdGAg4oCUIGFuZCByZWZ1c2luZ1xuICogaXQgd291bGQgYnJlYWsgdGhlIHN1cmZhY2UgZm9yIHRoZSBvbmUgdXNlciB3aG8gdHlwZWQgdGhlIGZyaWVuZGxpZXIgbmFtZS5cbiAqIGBbOjoxXWAgaXMgTk9UIGFjY2VwdGVkOiBub3RoaW5nIHByaW50cyBpdCwgYW5kIGEgc3BlbGxpbmcgbm90aGluZyBoYW5kcyBvdXRcbiAqIGlzIG5vdCBhIHNwZWxsaW5nIHRvIHdpZGVuIGZvciBvbiBzcGVjdWxhdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhbWVPcmlnaW4ocmVxOiBSZXF1ZXN0LCBwb3J0OiBudW1iZXIgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgY29uc3Qgb3JpZ2luID0gcmVxLmhlYWRlcnMuZ2V0KFwib3JpZ2luXCIpO1xuICBpZiAob3JpZ2luID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIG91cnMocG9ydCkuaW5jbHVkZXMob3JpZ2luKTtcbn1cblxuLyoqXG4gKiBUaGUgZ3VhcmQsIGFzIGEgYGZldGNoYCBwcm9sb2d1ZTogYSBgUmVzcG9uc2VgIHdoZW4gdGhlIHJlcXVlc3QgbXVzdCBiZVxuICogcmVmdXNlZCwgYG51bGxgIHdoZW4gaXQgbWF5IHByb2NlZWQuXG4gKlxuICog4puUIFJFVFVSTlMgVEhFIFJFRlVTQUwgUkFUSEVSIFRIQU4gVEhST1dJTkcsIHNvIGEgY2FsbGVyIGNhbm5vdCBoYWxmLWFwcGx5XG4gKiBpdC4gVGhlIHdob2xlIGZhaWx1cmUgbW9kZSB0aGlzIGNsb3NlcyBpcyBhbiBlZGl0IHRoYXQgZ2V0cyBmb3Jnb3R0ZW4gaW4gb25lXG4gKiBvZiBuaW5lIGNvcGllcywgYW5kIGBpZiAoeCkgcmV0dXJuIHg7YCBpcyB0aGUgc2hvcnRlc3Qgc2hhcGUgdGhhdCBjYW5ub3QgYmVcbiAqIHdyaXR0ZW4gd3JvbmcuIDQwMyB3aXRoIGEgSlNPTiBib2R5LCBiZWNhdXNlIGV2ZXJ5IHNwZWxsJ3Mgd2lyZSBhbnN3ZXJzIEpTT05cbiAqIGFuZCBhIHJlZnVzYWwgdGhhdCBicmVha3MgdGhhdCBzaGFwZSBpcyBhIHNlY29uZCBidWcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZ1c2VGb3JlaWduT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKHNhbWVPcmlnaW4ocmVxLCBwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJmb3JlaWduIG9yaWdpbiByZWZ1c2VkXCIgfSwgeyBzdGF0dXM6IDQwMyB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKlxuICog4pSA4pSAIEFORCBcIldIRVRIRVIgSVQgTUFZIEJFIFJFQURcIiBJUyBOT1cgQSBXSElURUxJU1Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRXh0cmFjdGVkIHdpdGggdGhyZWUgZ3VhcmRzIChlbXB0eSAvIGAuLmAgLyBuZXN0ZWQpIGFuZCBgZXhpc3RzU3luY2AgZm9yIHRoZVxuICogcmVzdCwgd2hpY2ggd2FzIHRydWUgb2YgYSBgZGlzdC9gIHRoYXQgaGVsZCBvbmx5IGEgc3VyZmFjZS4gUGhhc2UgMWIgcHV0IGV2ZXJ5XG4gKiBkYWVtb24ncyBCVU5ETEUgaW4gdGhhdCBzYW1lIGRpcmVjdG9yeSwgYW5kIGFsbCBmaXZlIGFkb3B0ZXJzIHNlcnZlZCBpdDpcbiAqIGAvY2xpLmpzYCwgYC9zZXJ2ZXIuanNgLCBgL2pvaW4uanNgIGF0IDIwMCwgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGNvbW1pdHRlZFxuICogYXJ0aWZhY3RzLCBlbWJlZGRlZCBzb3VyY2VtYXBzIGFuZCBhbGwuIGBzZXJ2ZUZyb21EaXN0YCBub3cgc2VydmVzIG9ubHkgd2hhdCB0aGVcbiAqIGJ1aWx0IGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgbGlua3Mg4oCUIHNlZSBgc3VyZmFjZVdoaXRlbGlzdGAgYmVsb3csIHdoaWNoIGlzXG4gKiB0aGUgc2hhcGUgZGlnZXN0aWZ5IHByb3ZlZCBsb2NhbGx5IGluIGBkOGNiYWZmYCBhbmQgdGhpcyBpcyBpdHMgb25lIGVkaXQgZm9yXG4gKiBmaXZlIHNwZWxscy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKblCBBTkQgYGV4aXN0c1N5bmNgIElTIE5PIExPTkdFUiBUSEUgUEVSTUlTU0lPTi4gQSBmaWxlIHVuZGVyIGBkaXN0RGlyYCBpc1xuICogc2VydmVkIG9ubHkgaWYgaXQgaXMgaW4gYHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcilgIOKAlCB3aGF0IHRoZSBidWlsdFxuICogYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBMSU5LUy4gYGRpc3QvYCBzdG9wcGVkIGJlaW5nIGEgc3VyZmFjZSBkaXJlY3RvcnlcbiAqIHdoZW4gdGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgYnVpbHQgdGhlIGRhZW1vbnMgaW50byBpdCwgYW5kIHRoZSBndWFyZHMgYWJvdmVcbiAqIGRvIG5vdCBkaXN0aW5ndWlzaCBgaW5kZXgtPGhhc2g+LmpzYCBmcm9tIGBzZXJ2ZXIuanNgLiBSZWFkIHRoYXQgZnVuY3Rpb24nc1xuICogaGVhZGVyIGJlZm9yZSB0b3VjaGluZyB0aGlzIGxpbmU7IHRoZSB3aGl0ZWxpc3QgaXMgdGhlIGRlZmVuY2UuXG4gKlxuICog4pqgIFRoZSBuZXN0aW5nIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwnc1xuICogb3duIHJvdXRlczogbWFncGllLCBib3VudHksIGdsYW1vdXIgYW5kIGltYWdvIGVhY2ggaGF2ZSBhbiBgL2Fzc2V0cy88bmFtZT5gXG4gKiByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXMgcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW5cbiAqIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3byBmaWdodGluZy4gVGhlIHdoaXRlbGlzdCBnb3Zlcm5zIGBkaXN0L2AgcmVhZHMgT05MWVxuICog4oCUIGl0IG5ldmVyIHNlZXMgdGhvc2Ugcm91dGVzIGFuZCBtdXN0IG5ldmVyIGJlIHdpZGVuZWQgaW50byB0aGVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmICghc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKS5oYXMocmVsKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG5cbi8qKiBgc3JjYC9gaHJlZmAgdmFsdWVzIGluIGEgYnVpbHQgZW50cnkgZG9jdW1lbnQsIGAuL2AtcHJlZml4ZWQgb3IgYmFyZS4gKi9cbmNvbnN0IEVOVFJZX1JFRl9SRSA9IC8oPzpzcmN8aHJlZilcXHMqPVxccypcIig/OlxcLlxcLyk/KFteXCJdKylcIi9nO1xuXG4vKiogQSBgLi9gLVBSRUZJWEVEIHNpYmxpbmcgc3BlY2lmaWVyIOKAlCBgXCIuL25hbWVcImAsIGAnLi9uYW1lJ2AsIGAoLi9uYW1lKWAg4oCUIHdoaWNoXG4gKiAgaXMgdGhlIG9ubHkgc2hhcGUgYSBidW5kbGVyIGVtaXRzIGZvciBhIHNpYmxpbmcgY2h1bmsuIFJlcXVpcmluZyB0aGUgYC4vYCBpc1xuICogIHdoYXQga2VlcHMgYSBzdHJpbmcgbGl0ZXJhbCB0aGF0IG1lcmVseSBTQVlTIGBjbGkuanNgIG91dCBvZiB0aGUgc2V0LiAqL1xuY29uc3QgUkVMQVRJVkVfUkVGX1JFID0gL1tcIicoXVxcLlxcLyhbXlwiJygpXFxzXSspW1wiJyldL2c7XG5cbi8qKiBPbmx5IHRleHQgdGhlIGJ1aWxkIGVtaXRzIGFzIHN1cmZhY2UgY29kZSBpcyBzY2FubmVkIGZvciBvbndhcmQgcmVmZXJlbmNlcy5cbiAqICBBIGAucG5nYCBpcyBhIGxlYWY7IG9wZW5pbmcgaXQgd291bGQgYmUgcmVhZGluZyBhIGJpbmFyeSBmb3IgZmlsZW5hbWVzLiAqL1xuY29uc3QgVFJBTlNJVElWRV9FWFRTID0gW1wiLmpzXCIsIFwiLmNzc1wiXTtcblxuLyoqIE9uZSBkZXJpdmF0aW9uIHBlciBgZGlzdC9gLCBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3Mg4oCUIGBkaXN0L2AgaXMgYSBidWlsZFxuICogIGFydGlmYWN0IGFuZCBkb2VzIG5vdCBjaGFuZ2UgdW5kZXIgYSBydW5uaW5nIGRhZW1vbi4gS2V5ZWQgYnkgZGlyZWN0b3J5IHNvXG4gKiAgdHdvIGRhZW1vbnMgaW4gb25lIHByb2Nlc3MgKGFuZCBldmVyeSB0ZXN0IHdpdGggaXRzIG93biB0ZW1wIHRyZWUpIHN0YXlcbiAqICBpbmRlcGVuZGVudC4gKi9cbmNvbnN0IHdoaXRlbGlzdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+KCk7XG5cbmZ1bmN0aW9uIHJlZnNJbih0ZXh0OiBzdHJpbmcsIHJlOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIHJldHVybiAoXG4gICAgWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgICAgLm1hcCgoWywgcmVmXSkgPT4gcmVmKVxuICAgICAgLy8gQSBUWVBFIFBSRURJQ0FURSwgYW5kIGhvbmVzdCBvbmx5IGJlY2F1c2UgaXRzIGZpcnN0IGNsYXVzZSB3YXMgYWxyZWFkeVxuICAgICAgLy8gaGVyZTogYCEhcmVmYCBpcyB0aGUgcnVudGltZSBjaGVjayB0aGF0IG1ha2VzIGByZWYgaXMgc3RyaW5nYCB0cnVlICh0aGVcbiAgICAgIC8vIEZFTEwgc2VudGVuY2UncyBwcmVkaWNhdGUgcm91dGUsIHRha2VuIHdpdGggaXRzIGNsYXVzZSDigJQgdHlwZS1kZWJ0IFQzNikuXG4gICAgICAuZmlsdGVyKFxuICAgICAgICAocmVmKTogcmVmIGlzIHN0cmluZyA9PlxuICAgICAgICAgICEhcmVmICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiLi5cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiOlwiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCI/XCIpLFxuICAgICAgKVxuICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLy8gRmluZGluZyB3aGVyZSBhIG5vdGUgYmVsb25ncywgaW4gYSBkb2N1bWVudCB0aGF0IGhhcyBtb3ZlZCB1bmRlciBpdCAoRTQ1KS5cbi8vXG4vLyDim5QgUVVPVEVELVRFWFQgQU5DSE9SSU5HLCBBTkQgVEhFIEFMVEVSTkFUSVZFIElTIFdIWS4gQW4gb2Zmc2V0IGdvZXMgc3RhbGUgb25cbi8vIHRoZSBuZXh0IGtleXN0cm9rZTogZml4IGEgdHlwbyB0aHJlZSBsaW5lcyB1cCBhbmQgZXZlcnkgbm90ZSBiZWxvdyBwb2ludHMgYXRcbi8vIHRoZSB3cm9uZyB3b3Jkcy4gUGlubmluZyBhIG5vdGUgdG8gdGhlIFZFUlNJT04gaXQgd2FzIG1hZGUgb24gd291bGQgYmUgZXhhY3Rcbi8vIGZvcmV2ZXIgYW5kIHVzZWxlc3Mg4oCUIHRoZSBzdGF0ZWQgdXNlIGlzIG1ha2luZyBub3RlcyBXSElMRSByZWFkaW5nIGFuZFxuLy8gZWRpdGluZywgYW5kIGEgbm90ZSB0aGF0IGRldGFjaGVzIHRoZSBtb21lbnQgeW91IGVkaXQgaXMgYSBub3RlIHlvdSBjYW5ub3Rcbi8vIHVzZS4gU28gYSBub3RlIHJlbWVtYmVycyB0aGUgVEVYVCBpdCB3YXMgbWFkZSBvbiwgcGx1cyBhIGxpdHRsZSBvZiB3aGF0XG4vLyBzdXJyb3VuZGVkIGl0LCBhbmQgaXMgcmUtZm91bmQgb24gZXZlcnkgcmVhZCAoQ29sZSBhcHByb3ZlZCB0aGUgdHJhZGU6IFwid2Vcbi8vIHRlc3QgaXQgb3V0IGFuZCBzZWUgaWYgaXQgd29ya3MgYW5kIGFkanVzdCBhcyBuZWVkZWRcIikuXG4vL1xuLy8g4puUIEFORCBJVCBTQVlTIFdIRU4gSVQgSEFTIExPU1QuIFRoZSBmb3VydGggb3V0Y29tZSBpcyBPUlBIQU5FRCDigJQgdGhlIHF1b3RlIGlzXG4vLyBnb25lIGFuZCB0aGUgbm90ZSBpcyBzaG93biBkZXRhY2hlZCByYXRoZXIgdGhhbiBwaW5uZWQgc29tZXdoZXJlIHBsYXVzaWJsZS5cbi8vIFZpc2libGUtYW5kLXdyb25nIGJlYXRzIGludmlzaWJsZS1hbmQtd3Jvbmc7IGEgbm90ZSBzaWxlbnRseSByZS1hbmNob3JlZCBvbnRvXG4vLyB1bnJlbGF0ZWQgd29yZHMgaXMgdGhlIGZhaWx1cmUgdGhpcyBkZXNpZ24gZXhpc3RzIHRvIGF2b2lkLlxuXG4vKiogSG93IG11Y2ggdGV4dCBlaXRoZXIgc2lkZSBpcyBrZXB0LCB0byB0ZWxsIGlkZW50aWNhbCBxdW90ZXMgYXBhcnQuICovXG5leHBvcnQgY29uc3QgQ09OVEVYVF9DSEFSUyA9IDQ4O1xuXG4vKiogV2hhdCBhIG5vdGUgcmVtZW1iZXJzIGFib3V0IHdoZXJlIGl0IHdhcyBtYWRlLiAqL1xuZXhwb3J0IHR5cGUgQW5jaG9yID0ge1xuICAvKiogVGhlIHRleHQgdGhlIG5vdGUgd2FzIG1hZGUgb24uIEVtcHR5IG1lYW5zIHRoZSBub3RlIGlzIGFib3V0IHRoZSBkb2N1bWVudC4gKi9cbiAgcXVvdGU6IHN0cmluZztcbiAgLyoqIFRoZSBjaGFyYWN0ZXJzIGltbWVkaWF0ZWx5IGJlZm9yZSBhbmQgYWZ0ZXIgdGhlIHF1b3RlLCB3aGVuIGl0IHdhcyBtYWRlLiAqL1xuICBiZWZvcmU6IHN0cmluZztcbiAgYWZ0ZXI6IHN0cmluZztcbiAgLyoqIFdoZXJlIGl0IHdhcyB0aGVuIOKAlCBhIEhJTlQgZm9yIGNob29zaW5nIGJldHdlZW4gaWRlbnRpY2FsIHF1b3RlcywgbmV2ZXIgYSBzb3VyY2Ugb2YgdHJ1dGguICovXG4gIGF0OiBudW1iZXI7XG59O1xuXG4vKiogV2hlcmUgYSBub3RlIGJlbG9uZ3Mgbm93LCBhbmQgaG93IHN1cmUgd2UgYXJlLiAqL1xuZXhwb3J0IHR5cGUgRm91bmQgPVxuICB8IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyOyBob3c6IFwiY29udGV4dFwiIHwgXCJ1bmlxdWVcIiB8IFwibmVhcmVzdFwiIH1cbiAgfCB7IGZyb206IG51bGw7IHRvOiBudWxsOyBob3c6IFwib3JwaGFuZWRcIiB9O1xuXG5jb25zdCBPUlBIQU5FRDogRm91bmQgPSB7IGZyb206IG51bGwsIHRvOiBudWxsLCBob3c6IFwib3JwaGFuZWRcIiB9O1xuXG4vKiogVGFrZSBhbiBhbmNob3IgZnJvbSBhIHNlbGVjdGlvbiDigJQgd2hhdCB0aGUgbm90ZSB3aWxsIHJlbWVtYmVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFuY2hvck9mKHRleHQ6IHN0cmluZywgZnJvbTogbnVtYmVyLCB0bzogbnVtYmVyKTogQW5jaG9yIHtcbiAgcmV0dXJuIHtcbiAgICBxdW90ZTogdGV4dC5zbGljZShmcm9tLCB0byksXG4gICAgYmVmb3JlOiB0ZXh0LnNsaWNlKE1hdGgubWF4KDAsIGZyb20gLSBDT05URVhUX0NIQVJTKSwgZnJvbSksXG4gICAgYWZ0ZXI6IHRleHQuc2xpY2UodG8sIHRvICsgQ09OVEVYVF9DSEFSUyksXG4gICAgYXQ6IGZyb20sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBpbmRleCBhdCB3aGljaCBgbmVlZGxlYCBvY2N1cnMgaW4gYGhheWAsIGluY2x1ZGluZyBvdmVybGFwcy4gKi9cbmZ1bmN0aW9uIG9jY3VycmVuY2VzKGhheTogc3RyaW5nLCBuZWVkbGU6IHN0cmluZyk6IG51bWJlcltdIHtcbiAgaWYgKG5lZWRsZSA9PT0gXCJcIikgcmV0dXJuIFtdO1xuICBjb25zdCBmb3VuZDogbnVtYmVyW10gPSBbXTtcbiAgbGV0IGkgPSBoYXkuaW5kZXhPZihuZWVkbGUpO1xuICB3aGlsZSAoaSAhPT0gLTEpIHtcbiAgICBmb3VuZC5wdXNoKGkpO1xuICAgIGkgPSBoYXkuaW5kZXhPZihuZWVkbGUsIGkgKyAxKTtcbiAgfVxuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogV2hlcmUgdGhlIG5vdGUgYmVsb25ncyBpbiBgdGV4dGAgbm93LlxuICpcbiAqIEZvdXIgYW5zd2VycywgdHJpZWQgaW4gb3JkZXIsIGFuZCBlYWNoIHNheXMgaG93IGl0IHdhcyByZWFjaGVkIHNvIHRoZSBzdXJmYWNlXG4gKiBjYW4gc2hvdyBhIHJlLWFuY2hvcmVkIG5vdGUgZGlmZmVyZW50bHkgZnJvbSBhIGNlcnRhaW4gb25lOlxuICpcbiAqIDEuICoqY29udGV4dCoqIOKAlCB0aGUgcXVvdGUgV0lUSCBpdHMgc3Vycm91bmRpbmdzIG9jY3VycyBleGFjdGx5IG9uY2UuIFRoZVxuICogICAgc3Ryb25nZXN0IGFuc3dlcjogdHdvIGlkZW50aWNhbCBzZW50ZW5jZXMgYXJlIHRvbGQgYXBhcnQgYnkgd2hhdCBpc1xuICogICAgYXJvdW5kIHRoZW0uXG4gKiAyLiAqKnVuaXF1ZSoqIOKAlCB0aGUgcXVvdGUgb2NjdXJzIGV4YWN0bHkgb25jZS4gSXRzIHN1cnJvdW5kaW5ncyBjaGFuZ2VkLCB0aGVcbiAqICAgIHRleHQgZGlkIG5vdC5cbiAqIDMuICoqbmVhcmVzdCoqIOKAlCB0aGUgcXVvdGUgb2NjdXJzIHNldmVyYWwgdGltZXM7IHRoZSBvbmUgY2xvc2VzdCB0byB3aGVyZSBpdFxuICogICAgdXNlZCB0byBiZSB3aW5zLiBBIGd1ZXNzLCBhbmQgbGFiZWxsZWQgYXMgb25lLlxuICogNC4gKipvcnBoYW5lZCoqIOKAlCB0aGUgcXVvdGUgaXMgZ29uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRBbmNob3IodGV4dDogc3RyaW5nLCBhbmNob3I6IEFuY2hvcik6IEZvdW5kIHtcbiAgaWYgKGFuY2hvci5xdW90ZSA9PT0gXCJcIikgcmV0dXJuIE9SUEhBTkVEO1xuXG4gIC8vIDEuIFdpdGggY29udGV4dC4gVGhlIHJlY29yZGVkIGNvbnRleHQgbWF5IGl0c2VsZiBiZSBjbGlwcGVkIGF0IGEgZG9jdW1lbnRcbiAgLy8gICAgZWRnZSwgc28gdGhlIHdob2xlIHJ1biBpcyBzZWFyY2hlZCByYXRoZXIgdGhhbiBhc3NlbWJsZWQgYmxpbmRseS5cbiAgY29uc3Qgd2l0aENvbnRleHQgPSBhbmNob3IuYmVmb3JlICsgYW5jaG9yLnF1b3RlICsgYW5jaG9yLmFmdGVyO1xuICBjb25zdCBjb250ZXh0cyA9IG9jY3VycmVuY2VzKHRleHQsIHdpdGhDb250ZXh0KTtcbiAgaWYgKGNvbnRleHRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IGZyb20gPSAoY29udGV4dHNbMF0gYXMgbnVtYmVyKSArIGFuY2hvci5iZWZvcmUubGVuZ3RoO1xuICAgIHJldHVybiB7IGZyb20sIHRvOiBmcm9tICsgYW5jaG9yLnF1b3RlLmxlbmd0aCwgaG93OiBcImNvbnRleHRcIiB9O1xuICB9XG5cbiAgY29uc3QgaGl0cyA9IG9jY3VycmVuY2VzKHRleHQsIGFuY2hvci5xdW90ZSk7XG4gIGlmIChoaXRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIE9SUEhBTkVEO1xuXG4gIC8vIDIuIFRoZSBxdW90ZSBhbG9uZSwgb25jZS5cbiAgaWYgKGhpdHMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgZnJvbSA9IGhpdHNbMF0gYXMgbnVtYmVyO1xuICAgIHJldHVybiB7IGZyb20sIHRvOiBmcm9tICsgYW5jaG9yLnF1b3RlLmxlbmd0aCwgaG93OiBcInVuaXF1ZVwiIH07XG4gIH1cblxuICAvLyAzLiBTZXZlcmFsIOKAlCB0YWtlIHRoZSBvbmUgbmVhcmVzdCB3aGVyZSBpdCB3YXMuIGBhdGAgaXMgYSBoaW50LCB3aGljaCBpc1xuICAvLyAgICB3aHkgdGhpcyBhbnN3ZXIgaXMgbGFiZWxsZWQ6IHRoZSBub3RlIG1heSBoYXZlIGxhbmRlZCBvbiBhIHR3aW4uXG4gIGxldCBiZXN0ID0gaGl0c1swXSBhcyBudW1iZXI7XG4gIGZvciAoY29uc3QgaGl0IG9mIGhpdHMpIGlmIChNYXRoLmFicyhoaXQgLSBhbmNob3IuYXQpIDwgTWF0aC5hYnMoYmVzdCAtIGFuY2hvci5hdCkpIGJlc3QgPSBoaXQ7XG4gIHJldHVybiB7IGZyb206IGJlc3QsIHRvOiBiZXN0ICsgYW5jaG9yLnF1b3RlLmxlbmd0aCwgaG93OiBcIm5lYXJlc3RcIiB9O1xufVxuXG4vKiogQSBvbmUtbGluZSB2ZXJzaW9uIG9mIHRoZSBxdW90ZSwgZm9yIGEgbGlzdCB0aGF0IGNhbm5vdCBzaG93IGFsbCBvZiBpdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBxdW90ZUxhYmVsKHF1b3RlOiBzdHJpbmcsIG1heCA9IDYwKTogc3RyaW5nIHtcbiAgY29uc3QgZmxhdCA9IHF1b3RlLnJlcGxhY2UoL1xccysvZ3UsIFwiIFwiKS50cmltKCk7XG4gIHJldHVybiBmbGF0Lmxlbmd0aCA8PSBtYXggPyBmbGF0IDogYCR7ZmxhdC5zbGljZSgwLCBtYXggLSAxKS50cmltRW5kKCl94oCmYDtcbn1cblxuLyoqXG4gKiBUaGUgMS1iYXNlZCBsaW5lcyBgW2Zyb20sIHRvKWAgY292ZXJzIChFNjUpLCBhcyBhIGh1bWFuIGNvdW50cyB0aGVtOiBhIHJhbmdlXG4gKiB0aGF0IGVuZHMganVzdCBhZnRlciBhIG5ld2xpbmUgZW5kcyBvbiB0aGUgbGluZSBpdCBmaW5pc2hlZCwgbm90IHRoZSBuZXh0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGluZXNPZih0ZXh0OiBzdHJpbmcsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH0ge1xuICBjb25zdCBsaW5lQXQgPSAoaTogbnVtYmVyKSA9PiB7XG4gICAgbGV0IG4gPSAxO1xuICAgIGZvciAobGV0IGsgPSB0ZXh0LmluZGV4T2YoXCJcXG5cIik7IGsgIT09IC0xICYmIGsgPCBpOyBrID0gdGV4dC5pbmRleE9mKFwiXFxuXCIsIGsgKyAxKSkgbisrO1xuICAgIHJldHVybiBuO1xuICB9O1xuICByZXR1cm4geyBmcm9tOiBsaW5lQXQoZnJvbSksIHRvOiBsaW5lQXQoTWF0aC5tYXgoZnJvbSwgdG8gLSAxKSkgfTtcbn1cbiIsCiAgICAiLy8gQ29tcGFyaW5nIHR3byB0ZXh0cywgYW5kIHRha2luZyBwYXJ0IG9mIG9uZSBpbnRvIHRoZSBvdGhlciAoRTM2KS5cbi8vXG4vLyDim5QgT05FIERJRkYsIENPTVBVVEVEIElOIFRIRSBEQUVNT04uIGBAY29kZW1pcnJvci9tZXJnZWAgd2FzIG1lYXN1cmVkIGZpcnN0XG4vLyBhbmQgaXQgaXMgYnVuZGxlLWNsZWFuIOKAlCBpdHMgb25seSBkZXBlbmRlbmNpZXMgYXJlIGBAY29kZW1pcnJvci9sYW5ndWFnZWAsXG4vLyBgc3RhdGVgLCBgdmlld2AgYW5kIGBAbGV6ZXIvaGlnaGxpZ2h0YCwgZXZlcnkgb25lIG9mIHdoaWNoIHRoZSBzdXJmYWNlXG4vLyBhbHJlYWR5IHNoaXBzLCBzbyB3YXJkIDFiIGhhcyBub3RoaW5nIHRvIHNheSBhYm91dCBpdC4gSXQgaXMgbm90IHVzZWRcbi8vIGFueXdheSwgYW5kIHRoZSByZWFzb24gaXMgbm90IHdlaWdodDogaXQgd291bGQgZ2l2ZSB0aGUgU1VSRkFDRSBpdHMgb3duXG4vLyBkaWZmIHdoaWxlIHRoZSBgZGlmZmAgQ0xJIHZlcmIgdXNlZCB0aGlzIG1vZHVsZSdzLCBhbmQgYSBodW5rIHRoZSBodW1hblxuLy8gYWNjZXB0cyB3b3VsZCB0aGVuIGJlIGEgaHVuayBhIGRpZmZlcmVudCBlbmdpbmUgZm91bmQuIFR3byBkaWZmIGVuZ2luZXMgb3ZlclxuLy8gb25lIGRvY3VtZW50IGlzIHRoZSBsb2Nrc3RlcC1taXJyb3IgZHJpZnQgdGhpcyByZXBvIGhhcyBhbHJlYWR5IHBhaWQgZm9yXG4vLyBvbmNlLiBUaGUgc3VyZmFjZSByZW5kZXJzIHRoZSBodW5rcyB0aGUgZGFlbW9uIGNvbXB1dGVkLCBhbmQgYG1lcmdlYCBhcHBsaWVzXG4vLyB0aGUgc2FtZSBvbmVzIOKAlCBzbyBhIG1pc21hdGNoIGlzIG5vdCBhIGJ1ZyB0aGF0IGNhbiBiZSB3cml0dGVuIGhlcmUuXG4vL1xuLy8gV2hhdCB0aGlzIGRlbGliZXJhdGVseSBpcyBub3Q6IGEgc2VtYW50aWMgb3Igc3ludGFjdGljIGRpZmYuIEl0IGNvbXBhcmVzXG4vLyBMSU5FUywgdGhlbiByZWZpbmVzIGluc2lkZSBwYWlyZWQgbGluZXMgYnkgV09SRCwgd2hpY2ggaXMgd2hhdCBhIHByb3NlXG4vLyByZWFkZXIgd2FudHMg4oCUIG1vdmVkIHBhcmFncmFwaHMgcmVhZCBhcyBhIGRlbGV0ZSBhbmQgYW4gYWRkLCBhbmQgdGhhdCBpc1xuLy8gdGhlIGhvbmVzdCBhbnN3ZXIgcmF0aGVyIHRoYW4gYSB3cm9uZyBjbGV2ZXIgb25lLlxuaW1wb3J0IHR5cGUgeyBEaWZmLCBEaWZmSHVuaywgRGlmZkxpbmUsIERpZmZTcGFuIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqXG4gKiBTcGxpdHRpbmcgb24gXCJcXG5cIiBhbmQgam9pbmluZyBvbiBcIlxcblwiIHJvdW5kLXRyaXBzIGV4YWN0bHksIElOQ0xVRElORyB0aGVcbiAqIHRyYWlsaW5nIGVtcHR5IHN0cmluZyBhIGZpbGUgZW5kaW5nIGluIGEgbmV3bGluZSBwcm9kdWNlcy4gVGhhdCBlbXB0eSBsaW5lXG4gKiBpcyByZWFsIGFzIGZhciBhcyB0aGlzIG1vZHVsZSBpcyBjb25jZXJuZWQsIHdoaWNoIGlzIHdoYXQga2VlcHMgYSBtZXJnZSBmcm9tXG4gKiBxdWlldGx5IGFkZGluZyBvciBkcm9wcGluZyBhIGZpbmFsIG5ld2xpbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdExpbmVzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRleHQuc3BsaXQoXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNhcCBvbiBNeWVycycgRCDigJQgdGhlIG51bWJlciBvZiBlZGl0cyBpdCB3aWxsIHdhbGsgYmVmb3JlIGdpdmluZyB1cC5cbiAqIFR3byB0ZXh0cyBkaWZmZXJpbmcgYnkgbW9yZSB0aGFuIHRoaXMgYXJlIG5vdCBzb21ldGhpbmcgYSBodW1hbiByZWFkcyBodW5rXG4gKiBieSBodW5rIGFueXdheSwgYW5kIHRoZSBxdWFkcmF0aWMgd29yc3QgY2FzZSBpcyB3aGF0IHRoZSBjYXAgZXhpc3RzIHRvIGtlZXBcbiAqIG91dCBvZiBhIGRhZW1vbiBzZXJ2aW5nIGEgc3VyZmFjZS5cbiAqL1xuY29uc3QgTUFYX0VESVRTID0gMzAwMDtcblxuLyoqXG4gKiBNeWVycycgZ3JlZWR5IE8oTkQpIGRpZmYgb3ZlciBsaW5lcy4gUmV0dXJucyB0aGUgdHJhY2Ugb2YgViBhcnJheXMsIG9yIG51bGxcbiAqIHdoZW4gdGhlIHRleHRzIGRpZmZlciBieSBtb3JlIHRoYW4gYE1BWF9FRElUU2AuXG4gKi9cbmZ1bmN0aW9uIG15ZXJzVHJhY2UoYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdKTogSW50MzJBcnJheVtdIHwgbnVsbCB7XG4gIGNvbnN0IG4gPSBhLmxlbmd0aDtcbiAgY29uc3QgbSA9IGIubGVuZ3RoO1xuICBjb25zdCBtYXggPSBNYXRoLm1pbihuICsgbSwgTUFYX0VESVRTKTtcbiAgY29uc3Qgc2l6ZSA9IDIgKiBtYXggKyAxO1xuICBjb25zdCBvZmZzZXQgPSBtYXg7XG4gIGxldCB2ID0gbmV3IEludDMyQXJyYXkoc2l6ZSk7XG4gIGNvbnN0IHRyYWNlOiBJbnQzMkFycmF5W10gPSBbXTtcbiAgZm9yIChsZXQgZCA9IDA7IGQgPD0gbWF4OyBkKyspIHtcbiAgICB0cmFjZS5wdXNoKHYuc2xpY2UoKSk7XG4gICAgZm9yIChsZXQgayA9IC1kOyBrIDw9IGQ7IGsgKz0gMikge1xuICAgICAgLy8gVGFrZSB0aGUgbG9uZ2VyIG9mIHRoZSB0d28gcmVhY2hhYmxlIHBhdGhzOiBkb3duIChhbiBpbnNlcnRpb24pIHdoZW5cbiAgICAgIC8vIGsgaXMgYXQgdGhlIGxvd2VyIGVkZ2Ugb3IgdGhlIGRvd24tbmVpZ2hib3VyIGhhcyBjb21lIGZ1cnRoZXIuXG4gICAgICBjb25zdCBkb3duID0gdltvZmZzZXQgKyBrICsgMV0gYXMgbnVtYmVyO1xuICAgICAgY29uc3QgcmlnaHQgPSB2W29mZnNldCArIGsgLSAxXSBhcyBudW1iZXI7XG4gICAgICBsZXQgeDogbnVtYmVyO1xuICAgICAgaWYgKGsgPT09IC1kIHx8IChrICE9PSBkICYmIHJpZ2h0IDwgZG93bikpIHggPSBkb3duO1xuICAgICAgZWxzZSB4ID0gcmlnaHQgKyAxO1xuICAgICAgbGV0IHkgPSB4IC0gaztcbiAgICAgIHdoaWxlICh4IDwgbiAmJiB5IDwgbSAmJiBhW3hdID09PSBiW3ldKSB7XG4gICAgICAgIHgrKztcbiAgICAgICAgeSsrO1xuICAgICAgfVxuICAgICAgdltvZmZzZXQgKyBrXSA9IHg7XG4gICAgICBpZiAoeCA+PSBuICYmIHkgPj0gbSkgcmV0dXJuIHRyYWNlO1xuICAgIH1cbiAgICB2ID0gdi5zbGljZSgpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogV2FsayB0aGUgdHJhY2UgYmFja3dhcmRzIGludG8gYSBsaXN0IG9mIGxpbmUgb3BlcmF0aW9ucywgZnJvbnQgdG8gYmFjay4gKi9cbmZ1bmN0aW9uIGJhY2t0cmFjayhhOiBzdHJpbmdbXSwgYjogc3RyaW5nW10sIHRyYWNlOiBJbnQzMkFycmF5W10pOiBEaWZmTGluZVtdIHtcbiAgY29uc3Qgb2Zmc2V0ID0gTWF0aC5taW4oYS5sZW5ndGggKyBiLmxlbmd0aCwgTUFYX0VESVRTKTtcbiAgY29uc3Qgb3V0OiBEaWZmTGluZVtdID0gW107XG4gIGxldCB4ID0gYS5sZW5ndGg7XG4gIGxldCB5ID0gYi5sZW5ndGg7XG4gIGZvciAobGV0IGQgPSB0cmFjZS5sZW5ndGggLSAxOyBkID49IDA7IGQtLSkge1xuICAgIGNvbnN0IHYgPSB0cmFjZVtkXSBhcyBJbnQzMkFycmF5O1xuICAgIGNvbnN0IGsgPSB4IC0geTtcbiAgICBsZXQgcHJldks6IG51bWJlcjtcbiAgICBpZiAoayA9PT0gLWQgfHwgKGsgIT09IGQgJiYgKHZbb2Zmc2V0ICsgayAtIDFdIGFzIG51bWJlcikgPCAodltvZmZzZXQgKyBrICsgMV0gYXMgbnVtYmVyKSkpXG4gICAgICBwcmV2SyA9IGsgKyAxO1xuICAgIGVsc2UgcHJldksgPSBrIC0gMTtcbiAgICBjb25zdCBwcmV2WCA9IHZbb2Zmc2V0ICsgcHJldktdIGFzIG51bWJlcjtcbiAgICBjb25zdCBwcmV2WSA9IHByZXZYIC0gcHJldks7XG4gICAgd2hpbGUgKHggPiBwcmV2WCAmJiB5ID4gcHJldlkpIHtcbiAgICAgIHgtLTtcbiAgICAgIHktLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwic2FtZVwiLCBhOiB4LCBiOiB5LCB0ZXh0OiBhW3hdIGFzIHN0cmluZyB9KTtcbiAgICB9XG4gICAgaWYgKGQgPT09IDApIGJyZWFrO1xuICAgIGlmICh4ID4gcHJldlgpIHtcbiAgICAgIHgtLTtcbiAgICAgIG91dC5wdXNoKHsgb3A6IFwiZGVsXCIsIGE6IHgsIHRleHQ6IGFbeF0gYXMgc3RyaW5nIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB5LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcImFkZFwiLCBiOiB5LCB0ZXh0OiBiW3ldIGFzIHN0cmluZyB9KTtcbiAgICB9XG4gIH1cbiAgb3V0LnJldmVyc2UoKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIEV2ZXJ5IGxpbmUgYXMgb25lIHJlcGxhY2VtZW50IOKAlCB0aGUgaG9uZXN0IGFuc3dlciB3aGVuIE15ZXJzIGdpdmVzIHVwLiAqL1xuZnVuY3Rpb24gY29hcnNlTGluZXMoYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdKTogRGlmZkxpbmVbXSB7XG4gIHJldHVybiBbXG4gICAgLi4uYS5tYXAoKHRleHQsIGkpID0+ICh7IG9wOiBcImRlbFwiIGFzIGNvbnN0LCBhOiBpLCB0ZXh0IH0pKSxcbiAgICAuLi5iLm1hcCgodGV4dCwgaSkgPT4gKHsgb3A6IFwiYWRkXCIgYXMgY29uc3QsIGI6IGksIHRleHQgfSkpLFxuICBdO1xufVxuXG4vKiogR3JvdXAgdGhlIGxpbmUgb3BzIGludG8gY29udGlndW91cyBodW5rcywgbnVtYmVyZWQgZnJvbSAxLiAqL1xuZnVuY3Rpb24gY29sbGVjdChsaW5lczogRGlmZkxpbmVbXSk6IERpZmZIdW5rW10ge1xuICBjb25zdCBodW5rczogRGlmZkh1bmtbXSA9IFtdO1xuICBsZXQgaSA9IDA7XG4gIGxldCBpZCA9IDE7XG4gIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgaWYgKChsaW5lc1tpXSBhcyBEaWZmTGluZSkub3AgPT09IFwic2FtZVwiKSB7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgc3RhcnQgPSBpO1xuICAgIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoICYmIChsaW5lc1tpXSBhcyBEaWZmTGluZSkub3AgIT09IFwic2FtZVwiKSBpKys7XG4gICAgY29uc3QgcnVuID0gbGluZXMuc2xpY2Uoc3RhcnQsIGkpO1xuICAgIGNvbnN0IGRlbCA9IHJ1bi5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiZGVsXCIpO1xuICAgIGNvbnN0IGFkZCA9IHJ1bi5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiYWRkXCIpO1xuICAgIC8vIFdoZXJlIHRoZSBodW5rIHNpdHMgaW4gZWFjaCB0ZXh0OiB0aGUgaW5kZXggb2YgdGhlIGZpcnN0IGxpbmUgaXQgdG91Y2hlcyxcbiAgICAvLyBhbmQgZm9yIGEgcHVyZSBpbnNlcnRpb24sIHRoZSBwb2ludCBpdCBpcyBpbnNlcnRlZCBBVC5cbiAgICBjb25zdCBhRnJvbSA9IGRlbC5sZW5ndGggPyAoKGRlbFswXSBhcyBEaWZmTGluZSkuYSBhcyBudW1iZXIpIDogbmV4dEluZGV4KGxpbmVzLCBzdGFydCwgXCJhXCIpO1xuICAgIGNvbnN0IGJGcm9tID0gYWRkLmxlbmd0aCA/ICgoYWRkWzBdIGFzIERpZmZMaW5lKS5iIGFzIG51bWJlcikgOiBuZXh0SW5kZXgobGluZXMsIHN0YXJ0LCBcImJcIik7XG4gICAgaHVua3MucHVzaCh7XG4gICAgICBpZDogaWQrKyxcbiAgICAgIGFGcm9tLFxuICAgICAgYVRvOiBhRnJvbSArIGRlbC5sZW5ndGgsXG4gICAgICBiRnJvbSxcbiAgICAgIGJUbzogYkZyb20gKyBhZGQubGVuZ3RoLFxuICAgICAgZGVsOiBkZWwubWFwKChsKSA9PiBsLnRleHQpLFxuICAgICAgYWRkOiBhZGQubWFwKChsKSA9PiBsLnRleHQpLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBodW5rcztcbn1cblxuLyoqXG4gKiBUaGUgaW5kZXggYSBwdXJlIGluc2VydGlvbiBvciBkZWxldGlvbiBzaXRzIGF0OiB0aGUgbGluZSBudW1iZXIgb2YgdGhlIG5leHRcbiAqIGBzYW1lYCBsaW5lIG9uIHRoYXQgc2lkZSwgb3IgdGhlIGVuZCBvZiB0aGF0IHRleHQgd2hlbiB0aGVyZSBpcyBub25lLlxuICovXG5mdW5jdGlvbiBuZXh0SW5kZXgobGluZXM6IERpZmZMaW5lW10sIGZyb206IG51bWJlciwgc2lkZTogXCJhXCIgfCBcImJcIik6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSBmcm9tOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhdCA9IChsaW5lc1tpXSBhcyBEaWZmTGluZSlbc2lkZV07XG4gICAgaWYgKGF0ICE9PSB1bmRlZmluZWQpIHJldHVybiBhdDtcbiAgfVxuICBsZXQgbGFzdCA9IC0xO1xuICBmb3IgKGNvbnN0IGwgb2YgbGluZXMpIHtcbiAgICBjb25zdCBhdCA9IGxbc2lkZV07XG4gICAgaWYgKGF0ICE9PSB1bmRlZmluZWQgJiYgYXQgPiBsYXN0KSBsYXN0ID0gYXQ7XG4gIH1cbiAgcmV0dXJuIGxhc3QgKyAxO1xufVxuXG4vKiogV29yZHMsIHdoaXRlc3BhY2UgcnVucyBhbmQgcHVuY3R1YXRpb24gcnVucywga2VwdCBzZXBhcmF0ZSBzbyBzcGFucyBhbGlnbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3JkcyhsaW5lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBsaW5lLm1hdGNoKC9cXHMrfFtcXHB7TH1cXHB7Tn1fXSt8W15cXHNcXHB7TH1cXHB7Tn1fXSsvZ3UpID8/IFtdO1xufVxuXG4vKiogVGhlIHdvcmQtbGV2ZWwgZGlmZiBvZiBvbmUgbGluZSBwYWlyLCBhcyBzcGFucyBvdmVyIGVhY2ggc2lkZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZpbmUoYmVmb3JlOiBzdHJpbmcsIGFmdGVyOiBzdHJpbmcpOiB7IGRlbDogRGlmZlNwYW5bXTsgYWRkOiBEaWZmU3BhbltdIH0ge1xuICBjb25zdCBhID0gd29yZHMoYmVmb3JlKTtcbiAgY29uc3QgYiA9IHdvcmRzKGFmdGVyKTtcbiAgY29uc3QgdHJhY2UgPSBteWVyc1RyYWNlKGEsIGIpO1xuICBpZiAoIXRyYWNlKVxuICAgIHJldHVybiB7IGRlbDogW3sgdGV4dDogYmVmb3JlLCBjaGFuZ2VkOiB0cnVlIH1dLCBhZGQ6IFt7IHRleHQ6IGFmdGVyLCBjaGFuZ2VkOiB0cnVlIH1dIH07XG4gIGNvbnN0IG9wcyA9IGJhY2t0cmFjayhhLCBiLCB0cmFjZSk7XG4gIGNvbnN0IGRlbDogRGlmZlNwYW5bXSA9IFtdO1xuICBjb25zdCBhZGQ6IERpZmZTcGFuW10gPSBbXTtcbiAgZm9yIChjb25zdCBvcCBvZiBvcHMpIHtcbiAgICBpZiAob3Aub3AgPT09IFwic2FtZVwiKSB7XG4gICAgICBwdXNoKGRlbCwgb3AudGV4dCwgZmFsc2UpO1xuICAgICAgcHVzaChhZGQsIG9wLnRleHQsIGZhbHNlKTtcbiAgICB9IGVsc2UgaWYgKG9wLm9wID09PSBcImRlbFwiKSBwdXNoKGRlbCwgb3AudGV4dCwgdHJ1ZSk7XG4gICAgZWxzZSBwdXNoKGFkZCwgb3AudGV4dCwgdHJ1ZSk7XG4gIH1cbiAgcmV0dXJuIHsgZGVsLCBhZGQgfTtcbn1cblxuLyoqIEFwcGVuZCwgbWVyZ2luZyBpbnRvIHRoZSBwcmV2aW91cyBzcGFuIHdoZW4gaXQgY2FycmllcyB0aGUgc2FtZSB2ZXJkaWN0LiAqL1xuZnVuY3Rpb24gcHVzaChzcGFuczogRGlmZlNwYW5bXSwgdGV4dDogc3RyaW5nLCBjaGFuZ2VkOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGxhc3QgPSBzcGFuc1tzcGFucy5sZW5ndGggLSAxXTtcbiAgaWYgKGxhc3QgJiYgbGFzdC5jaGFuZ2VkID09PSBjaGFuZ2VkKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBzcGFucy5wdXNoKHsgdGV4dCwgY2hhbmdlZCB9KTtcbn1cblxuLyoqXG4gKiBSZWZpbmUgYSBodW5rJ3MgbGluZXMgd2hlbiB0aGV5IGNhbiBiZSBQQUlSRUQuIEEgaHVuayByZXBsYWNpbmcgdGhyZWUgbGluZXNcbiAqIHdpdGggdGhyZWUgaXMgcGFpcmVkIGxpbmUgYnkgbGluZTsgYSAxLWZvci1tYW55IGh1bmsgaXMgbm90LCBhbmQgZ2V0cyBub1xuICogc3BhbnMgcmF0aGVyIHRoYW4gYW4gYXJiaXRyYXJ5IHBhaXJpbmcg4oCUIHNob3dpbmcgYSB3b3JkLWxldmVsIGRpZmYgYWdhaW5zdFxuICogdGhlIHdyb25nIGxpbmUgaXMgd29yc2UgdGhhbiBzaG93aW5nIG5vbmUuXG4gKi9cbmZ1bmN0aW9uIHJlZmluZUh1bmsobGluZXM6IERpZmZMaW5lW10sIGh1bms6IERpZmZIdW5rKTogdm9pZCB7XG4gIGlmIChodW5rLmRlbC5sZW5ndGggIT09IGh1bmsuYWRkLmxlbmd0aCB8fCBodW5rLmRlbC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgY29uc3QgZGVscyA9IGxpbmVzLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJkZWxcIiAmJiBpblJhbmdlKGwuYSwgaHVuay5hRnJvbSwgaHVuay5hVG8pKTtcbiAgY29uc3QgYWRkcyA9IGxpbmVzLmZpbHRlcigobCkgPT4gbC5vcCA9PT0gXCJhZGRcIiAmJiBpblJhbmdlKGwuYiwgaHVuay5iRnJvbSwgaHVuay5iVG8pKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBkZWxzLmxlbmd0aCAmJiBpIDwgYWRkcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGQgPSBkZWxzW2ldIGFzIERpZmZMaW5lO1xuICAgIGNvbnN0IGFkID0gYWRkc1tpXSBhcyBEaWZmTGluZTtcbiAgICBjb25zdCB7IGRlbCwgYWRkIH0gPSByZWZpbmUoZC50ZXh0LCBhZC50ZXh0KTtcbiAgICBkLnNwYW5zID0gZGVsO1xuICAgIGFkLnNwYW5zID0gYWRkO1xuICB9XG59XG5cbmZ1bmN0aW9uIGluUmFuZ2UoYXQ6IG51bWJlciB8IHVuZGVmaW5lZCwgZnJvbTogbnVtYmVyLCB0bzogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiBhdCAhPT0gdW5kZWZpbmVkICYmIGF0ID49IGZyb20gJiYgYXQgPCB0bztcbn1cblxuLyoqIENvbXBhcmUgdHdvIHRleHRzIGJ5IGxpbmUsIHJlZmluZWQgYnkgd29yZCBpbnNpZGUgcGFpcmVkIGxpbmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZmZUZXh0KGJlZm9yZTogc3RyaW5nLCBhZnRlcjogc3RyaW5nKTogRGlmZiB7XG4gIGlmIChiZWZvcmUgPT09IGFmdGVyKSB7XG4gICAgY29uc3QgbGluZXMgPSBzcGxpdExpbmVzKGJlZm9yZSkubWFwKCh0ZXh0LCBpKSA9PiAoe1xuICAgICAgb3A6IFwic2FtZVwiIGFzIGNvbnN0LFxuICAgICAgYTogaSxcbiAgICAgIGI6IGksXG4gICAgICB0ZXh0LFxuICAgIH0pKTtcbiAgICByZXR1cm4geyBsaW5lcywgaHVua3M6IFtdLCBzYW1lOiB0cnVlLCBjb2Fyc2U6IGZhbHNlIH07XG4gIH1cbiAgY29uc3QgYSA9IHNwbGl0TGluZXMoYmVmb3JlKTtcbiAgY29uc3QgYiA9IHNwbGl0TGluZXMoYWZ0ZXIpO1xuICBjb25zdCB0cmFjZSA9IG15ZXJzVHJhY2UoYSwgYik7XG4gIGNvbnN0IGNvYXJzZSA9IHRyYWNlID09PSBudWxsO1xuICBjb25zdCBsaW5lcyA9IHRyYWNlID8gYmFja3RyYWNrKGEsIGIsIHRyYWNlKSA6IGNvYXJzZUxpbmVzKGEsIGIpO1xuICBjb25zdCBodW5rcyA9IGNvbGxlY3QobGluZXMpO1xuICBmb3IgKGNvbnN0IGggb2YgaHVua3MpIHJlZmluZUh1bmsobGluZXMsIGgpO1xuICByZXR1cm4geyBsaW5lcywgaHVua3MsIHNhbWU6IGZhbHNlLCBjb2Fyc2UgfTtcbn1cblxuLyoqXG4gKiBUYWtlIGh1bmtzIGZyb20gdGhlIHJpZ2h0IHNpZGUgaW50byB0aGUgbGVmdC4gYHRha2VgIGlzIHRoZSBpZHMgdG8gYXBwbHk7XG4gKiBldmVyeSBodW5rIG5vdCBuYW1lZCBpcyBsZWZ0IGFzIHRoZSBsZWZ0IHNpZGUgaGFzIGl0LlxuICpcbiAqIOKblCBBUFBMSUVEIEJBQ0sgVE8gRlJPTlQsIHNvIGFuIGVhcmxpZXIgaHVuaydzIGxpbmUgbnVtYmVycyBhcmUgc3RpbGwgdGhlXG4gKiBvbmVzIHRoZSBkaWZmIHJlcG9ydGVkIHdoZW4gaXQgaXMgcmVhY2hlZC4gQXBwbHlpbmcgZnJvbnQgdG8gYmFjayB3b3VsZFxuICogc2hpZnQgZXZlcnkgbGF0ZXIgaHVuayBieSB0aGUgc2l6ZSBvZiB0aGUgY2hhbmdlIGp1c3QgbWFkZSDigJQgdGhlIGNsYXNzaWMgd2F5XG4gKiBhIG11bHRpLWh1bmsgbWVyZ2UgbGFuZHMgaXRzIGxhc3QgaHVuayBpbiB0aGUgd3JvbmcgcGxhY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUh1bmtzKGJlZm9yZTogc3RyaW5nLCBodW5rczogRGlmZkh1bmtbXSwgdGFrZTogbnVtYmVyW10pOiBzdHJpbmcge1xuICBjb25zdCB3YW50ZWQgPSBuZXcgU2V0KHRha2UpO1xuICBjb25zdCBjaG9zZW4gPSBodW5rcy5maWx0ZXIoKGgpID0+IHdhbnRlZC5oYXMoaC5pZCkpLnNvcnQoKHgsIHkpID0+IHkuYUZyb20gLSB4LmFGcm9tKTtcbiAgY29uc3QgbGluZXMgPSBzcGxpdExpbmVzKGJlZm9yZSk7XG4gIGZvciAoY29uc3QgaCBvZiBjaG9zZW4pIGxpbmVzLnNwbGljZShoLmFGcm9tLCBoLmFUbyAtIGguYUZyb20sIC4uLmguYWRkKTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBVbmlmaWVkLWRpZmYgdGV4dCwgZm9yIHRoZSBhZ2VudCdzIGBkaWZmYCB2ZXJiLiBgY29udGV4dGAgbGluZXMgZWl0aGVyIHNpZGUuICovXG5leHBvcnQgZnVuY3Rpb24gdW5pZmllZChcbiAgZGlmZjogRGlmZixcbiAgb3B0czogeyBmcm9tOiBzdHJpbmc7IHRvOiBzdHJpbmc7IGNvbnRleHQ/OiBudW1iZXIgfSA9IHsgZnJvbTogXCJhXCIsIHRvOiBcImJcIiB9LFxuKTogc3RyaW5nIHtcbiAgaWYgKGRpZmYuc2FtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IGNvbnRleHQgPSBvcHRzLmNvbnRleHQgPz8gMztcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtgLS0tICR7b3B0cy5mcm9tfWAsIGArKysgJHtvcHRzLnRvfWBdO1xuICAvLyBIdW5rcyBjbG9zZXIgdG9nZXRoZXIgdGhhbiAyw5cgY29udGV4dCBzaGFyZSBvbmUgaGVhZGVyLCB0aGUgd2F5IGV2ZXJ5XG4gIC8vIG90aGVyIGRpZmYgdG9vbCBqb2lucyB0aGVtIOKAlCBvdGhlcndpc2UgdGhlIGNvbnRleHQgbGluZXMgcHJpbnQgdHdpY2UuXG4gIGNvbnN0IGdyb3VwczogRGlmZkh1bmtbXVtdID0gW107XG4gIGZvciAoY29uc3QgaCBvZiBkaWZmLmh1bmtzKSB7XG4gICAgY29uc3QgbGFzdCA9IGdyb3Vwc1tncm91cHMubGVuZ3RoIC0gMV07XG4gICAgY29uc3QgcHJldiA9IGxhc3Q/LltsYXN0Lmxlbmd0aCAtIDFdO1xuICAgIGlmIChwcmV2ICYmIGguYUZyb20gLSBwcmV2LmFUbyA8PSBjb250ZXh0ICogMikgKGxhc3QgYXMgRGlmZkh1bmtbXSkucHVzaChoKTtcbiAgICBlbHNlIGdyb3Vwcy5wdXNoKFtoXSk7XG4gIH1cbiAgY29uc3QgYSA9IHNwbGl0TGluZXMoc2lkZVRleHQoZGlmZiwgXCJhXCIpKTtcbiAgY29uc3QgYiA9IHNwbGl0TGluZXMoc2lkZVRleHQoZGlmZiwgXCJiXCIpKTtcbiAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMpIHtcbiAgICBjb25zdCBmaXJzdCA9IGdyb3VwWzBdIGFzIERpZmZIdW5rO1xuICAgIGNvbnN0IGxhc3QgPSBncm91cFtncm91cC5sZW5ndGggLSAxXSBhcyBEaWZmSHVuaztcbiAgICBjb25zdCBhU3RhcnQgPSBNYXRoLm1heCgwLCBmaXJzdC5hRnJvbSAtIGNvbnRleHQpO1xuICAgIGNvbnN0IGFFbmQgPSBNYXRoLm1pbihhLmxlbmd0aCwgbGFzdC5hVG8gKyBjb250ZXh0KTtcbiAgICBjb25zdCBiU3RhcnQgPSBNYXRoLm1heCgwLCBmaXJzdC5iRnJvbSAtIGNvbnRleHQpO1xuICAgIGNvbnN0IGJFbmQgPSBNYXRoLm1pbihiLmxlbmd0aCwgbGFzdC5iVG8gKyBjb250ZXh0KTtcbiAgICBvdXQucHVzaChgQEAgLSR7YVN0YXJ0ICsgMX0sJHthRW5kIC0gYVN0YXJ0fSArJHtiU3RhcnQgKyAxfSwke2JFbmQgLSBiU3RhcnR9IEBAYCk7XG4gICAgbGV0IGF0ID0gYVN0YXJ0O1xuICAgIGZvciAoY29uc3QgaCBvZiBncm91cCkge1xuICAgICAgZm9yICg7IGF0IDwgaC5hRnJvbTsgYXQrKykgb3V0LnB1c2goYCAke2FbYXRdfWApO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGguZGVsKSBvdXQucHVzaChgLSR7bGluZX1gKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBoLmFkZCkgb3V0LnB1c2goYCske2xpbmV9YCk7XG4gICAgICBhdCA9IGguYVRvO1xuICAgIH1cbiAgICBmb3IgKDsgYXQgPCBhRW5kOyBhdCsrKSBvdXQucHVzaChgICR7YVthdF19YCk7XG4gIH1cbiAgcmV0dXJuIGAke291dC5qb2luKFwiXFxuXCIpfVxcbmA7XG59XG5cbi8qKiBSZWJ1aWxkIG9uZSBzaWRlJ3MgdGV4dCBmcm9tIHRoZSBsaW5lIG9wcyDigJQgdXNlZCBieSBgdW5pZmllZGAgZm9yIGNvbnRleHQuICovXG5mdW5jdGlvbiBzaWRlVGV4dChkaWZmOiBEaWZmLCBzaWRlOiBcImFcIiB8IFwiYlwiKTogc3RyaW5nIHtcbiAgY29uc3Qgc2tpcCA9IHNpZGUgPT09IFwiYVwiID8gXCJhZGRcIiA6IFwiZGVsXCI7XG4gIHJldHVybiBkaWZmLmxpbmVzXG4gICAgLmZpbHRlcigobCkgPT4gbC5vcCAhPT0gc2tpcClcbiAgICAubWFwKChsKSA9PiBsLnRleHQpXG4gICAgLmpvaW4oXCJcXG5cIik7XG59XG4iLAogICAgIi8vIFdoYXQgaXMgd3Jvbmcgd2l0aCB0aGlzIHNlc3Npb24sIGFuZCB0aGUgdmVyYiB0aGF0IGZpeGVzIGVhY2ggdGhpbmcgKEU2MikuXG4vL1xuLy8g4puUIFJFUE9SVFMsIE5FVkVSIFJFUEFJUlMuIFNpbGVudGx5IHBydW5pbmcgYSBnaG9zdCBlbnRyeSB3b3VsZCB0aHJvdyBhd2F5IHRoZVxuLy8gZmFjdCB0aGF0IHRoZSBodW1hbiBBU0tFRCBmb3IgdGhhdCBmaWxlIHRvIGJlIGluIHRoZWlyIGNvbnRleHQg4oCUIGFuZCBpZiBpdFxuLy8gY29tZXMgYmFjayBmcm9tIGEgYGdpdCBjaGVja291dGAsIHRoZXkgd291bGQgaGF2ZSB0byBub3RpY2UgaXQgaXMgbWlzc2luZyBhbmRcbi8vIGFkZCBpdCBhZ2Fpbi4gVGhlIHNhbWUgbG9naWMgcHJvdGVjdHMgYSBkb2N1bWVudCByZWNvcmQgd2hvc2UgZmlsZSBoYXMgZ29uZTpcbi8vIHRoZSBzZXNzaW9uIGlzIHN0aWxsIGhvbGRpbmcgdmVyc2lvbnMgdGhlIGh1bWFuIGNhbiBzYXZlIGJhY2ssIHNvIGZvcmdldHRpbmdcbi8vIGl0IGZvciB0aGVtIHdvdWxkIGJlIGRpc2NhcmRpbmcgY29udGVudCBvbiB0aGVpciBiZWhhbGYuIENvbGUgcnVsZWQgaXQ6XG4vLyBcInJlcG9ydCwgbmFtZSB0aGUgdmVyYiwgbGV0IHlvdSBkZWNpZGUuXCJcbi8vXG4vLyDim5QgQU5EIEVWRVJZIEZJTkRJTkcgQ0FSUklFUyBJVFMgVkVSQi4gQSByZXBvcnQgdGhhdCBzYXlzIFwiMyBwcm9ibGVtc1wiIGFuZFxuLy8gbGVhdmVzIHlvdSB0byB3b3JrIG91dCB3aGF0IHRvIHR5cGUgaXMgdGhlIHNoYXBlIHRoaXMgc3BlbGwga2VlcHMgZmFpbGluZyBhdFxuLy8gYW5kIGZpeGluZyDigJQgdGhlIGNvbmZsaWN0IGJhbm5lciB3aXRoIG5vIHJvdXRlIHRvIHRoZSBjb21wYXJpc29uLCB0aGVcbi8vIFwiZ29uZSBmcm9tIGRpc2tcIiBub3RpY2Ugd2l0aCBubyB3YXkgdG8gYW5zd2VyIGl0LiBBIGZpbmRpbmcgd2l0aG91dCBhIGZpeCBpc1xuLy8gaGFsZiBhIGZpbmRpbmcuXG4vL1xuLy8g4pqgIFRIRSBDSEVDS1MgQVJFIEVWSURFTkNFRCwgTk9UIElNQUdJTkVELiBFYWNoIG9uZSBpcyBhIHN0YXRlIHRoYXQgaGFzXG4vLyBhY3R1YWxseSBoYXBwZW5lZCBoZXJlOiBhIHJlY29yZCB3aG9zZSBvcmlnaW5hbCB3YXMgZGVsZXRlZCAoRTYwJ3MgcmVzaWR1ZSxcbi8vIGFuZCBhbnkgZGVsZXRlIGluIEZpbmRlciksIGEgYGxpc3RlZGAgY29udGV4dCBlbnRyeSBwb2ludGluZyBhdCBub3RoaW5nXG4vLyAobmV2ZXIgcmVzY2FubmVkIOKAlCBtZWFzdXJlZCwgYW5kIHJlYWNoYWJsZSB0b2RheSB3aXRoIG5vIGJ1ZyBhdCBhbGwpLCBhbmRcbi8vIGxpbmtzIGEgc2V0IGNhbm5vdCBhbnN3ZXIgKEU1NCkuIE5vdGhpbmcgaXMgY2hlY2tlZCBiZWNhdXNlIGl0IHNvdW5kZWRcbi8vIHBsYXVzaWJsZS5cblxuLyoqIE9uZSB0aGluZyB3b3J0aCBsb29raW5nIGF0LCBhbmQgd2hhdCB0byBkbyBhYm91dCBpdC4gKi9cbmV4cG9ydCB0eXBlIEZpbmRpbmcgPSB7XG4gIGtpbmQ6IFwib3JpZ2luYWwubWlzc2luZ1wiIHwgXCJjb250ZXh0Lmdob3N0XCIgfCBcImxpbmtzLmRhbmdsaW5nXCI7XG4gIC8qKiBXaGF0IGl0IGlzIGFib3V0OiBhIHBhdGgsIG9yIGFuIGVudHJ5IGlkLiAqL1xuICBzdWJqZWN0OiBzdHJpbmc7XG4gIC8qKiBXaGF0IHRoZSBodW1hbiByZWFkcy4gKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICAvKiogV2hhdCB0aGUgYWdlbnQgd291bGQgcnVuLCB3aXRoIHRoZSBhcmd1bWVudCBhbHJlYWR5IGluIGl0LiAqL1xuICBmaXg6IHN0cmluZztcbiAgLyoqIEhvdyBtYW55IG9mIHNvbWV0aGluZyB0aGUgZmluZGluZyBpcyBhYm91dCwgd2hlbiB0aGF0IGlzIHRoZSBwb2ludC4gKi9cbiAgY291bnQ/OiBudW1iZXI7XG59O1xuXG4vKiogVGhlIGZhY3RzIGEgY2hlY2t1cCBuZWVkcywgZ2F0aGVyZWQgYnkgd2hvZXZlciBjYW4gdG91Y2ggdGhlIGRpc2suICovXG5leHBvcnQgdHlwZSBDaGVja3VwID0ge1xuICAvKiogRXZlcnkgZG9jdW1lbnQgcmVjb3JkLCB3aXRoIHdoZXRoZXIgaXRzIGZpbGUgb2YgcmVjb3JkIHN0aWxsIGV4aXN0cy4gKi9cbiAgZG9jczogcmVhZG9ubHkge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgb3JpZ2luYWw6IHN0cmluZztcbiAgICBleGlzdHM6IGJvb2xlYW47XG4gICAgdmVyc2lvbnM6IG51bWJlcjtcbiAgfVtdO1xuICAvKiogRXZlcnkgZG9jIG5vZGUgaW4gZXZlcnkgY29udGV4dCBlbnRyeSwgd2l0aCB3aGV0aGVyIHRoZSBwYXRoIGV4aXN0cy4gKi9cbiAgbm9kZXM6IHJlYWRvbmx5IHsgZW50cnk6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBzaG93bjogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfVtdO1xuICAvKiogRGFuZ2xpbmcgbGluayBjb3VudHMgcGVyIG1pcnJvcmVkIGVudHJ5LiAqL1xuICBsaW5rczogcmVhZG9ubHkgeyBlbnRyeTogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBkYW5nbGluZzogbnVtYmVyIH1bXTtcbn07XG5cbi8qKlxuICogU2hhcGUgdGhlIGZhY3RzIGludG8gZmluZGluZ3MuXG4gKlxuICogUHVyZSBvbiBwdXJwb3NlOiB0aGUgZnMgcmVhZHMgYmVsb25nIHRvIHRoZSBzZXNzaW9uLCBhbmQgd2hhdCBjb3VudHMgYXMgYVxuICogcHJvYmxlbSDigJQgYW5kIHdoYXQgdG8gc2F5IGFib3V0IGl0IOKAlCBpcyB0aGUgcGFydCB3b3J0aCBwaW5uaW5nIHdpdGggY2VsbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kaW5ncyhjOiBDaGVja3VwKTogRmluZGluZ1tdIHtcbiAgY29uc3Qgb3V0OiBGaW5kaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IGQgb2YgYy5kb2NzKSB7XG4gICAgaWYgKGQuZXhpc3RzKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIm9yaWdpbmFsLm1pc3NpbmdcIixcbiAgICAgIHN1YmplY3Q6IGQub3JpZ2luYWwsXG4gICAgICBtZXNzYWdlOiBgJHtkLm5hbWV9IGlzIGluIHRoaXMgc2Vzc2lvbiBidXQgaXRzIGZpbGUgaXMgZ29uZSBmcm9tIGRpc2suICR7XG4gICAgICAgIGQudmVyc2lvbnMgPT09IDEgPyBcIjEgdmVyc2lvbiBpc1wiIDogYCR7ZC52ZXJzaW9uc30gdmVyc2lvbnMgYXJlYFxuICAgICAgfSBzdGlsbCBoZWxkIGhlcmUg4oCUIHNhdmluZyB3b3VsZCByZWNyZWF0ZSB0aGUgZmlsZS5gLFxuICAgICAgZml4OiBgZm9yZ2V0IC0tZG9jICR7ZC5zbHVnfWAsXG4gICAgICBjb3VudDogZC52ZXJzaW9ucyxcbiAgICB9KTtcbiAgfVxuXG4gIGZvciAoY29uc3QgbiBvZiBjLm5vZGVzKSB7XG4gICAgaWYgKG4uZXhpc3RzKSBjb250aW51ZTtcbiAgICAvLyDimqAgQSByZWNvcmQgYW5kIGFuIGVudHJ5IGNhbiBwb2ludCBhdCB0aGUgU0FNRSBtaXNzaW5nIHBhdGgsIGFuZCBib3RoIGFyZVxuICAgIC8vIHJlcG9ydGVkOiB0aGV5IGFyZSB0d28gZGlmZmVyZW50IHRoaW5ncyB0byBjbGVhbiB1cCwgd2l0aCB0d28gZGlmZmVyZW50XG4gICAgLy8gdmVyYnMsIGFuZCBtZXJnaW5nIHRoZW0gd291bGQgbGVhdmUgd2hpY2hldmVyIHRoZSBodW1hbiBkaWQgbm90IGRvLlxuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwiY29udGV4dC5naG9zdFwiLFxuICAgICAgc3ViamVjdDogbi5wYXRoLFxuICAgICAgbWVzc2FnZTogYCR7bi5zaG93bn0gaXMgaW4gdGhlIGNvbnRleHQgYnV0IG5vdCBvbiBkaXNrLmAsXG4gICAgICBmaXg6IGBoaWRlICR7bi5wYXRofWAsXG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGwgb2YgYy5saW5rcykge1xuICAgIGlmIChsLmRhbmdsaW5nIDw9IDApIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwibGlua3MuZGFuZ2xpbmdcIixcbiAgICAgIHN1YmplY3Q6IGwuZW50cnksXG4gICAgICBtZXNzYWdlOlxuICAgICAgICBsLmRhbmdsaW5nID09PSAxXG4gICAgICAgICAgPyBgJHtsLmxhYmVsfSBoYXMgMSBsaW5rIHRoYXQgYW5zd2VycyBub3RoaW5nLmBcbiAgICAgICAgICA6IGAke2wubGFiZWx9IGhhcyAke2wuZGFuZ2xpbmd9IGxpbmtzIHRoYXQgYW5zd2VyIG5vdGhpbmcuYCxcbiAgICAgIGZpeDogYGRhbmdsaW5nIC0tZW50cnkgJHtsLmVudHJ5fWAsXG4gICAgICBjb3VudDogbC5kYW5nbGluZyxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogVGhlIG9uZSBsaW5lIHRoZSBjaGF0IGdldHMgYXQgc3RhcnR1cCwgb3IgbnVsbCB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gc2F5LlxuICpcbiAqIOKblCBPTkUgTElORSwgQU5EIFNJTEVOQ0UgV0hFTiBDTEVBTi4gQSBjaGVjayB0aGF0IGFubm91bmNlcyBpdHNlbGYgZXZlcnkgdGltZVxuICogaXQgZmluZHMgbm90aGluZyB0cmFpbnMgdGhlIHJlYWRlciB0byBza2lwIGl0LCBhbmQgdGhlbiBpdCBpcyBub3QgYSBjaGVjayBhbnlcbiAqIG1vcmUuIFRoZSBkZXRhaWwgbGl2ZXMgYmVoaW5kIHRoZSB2ZXJiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyeShsaXN0OiByZWFkb25seSBGaW5kaW5nW10pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKGxpc3QubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgLy8g4pqgIENvdW50ZWQgYnkgS0lORCByYXRoZXIgdGhhbiBkZXNjcmliZWQsIGJlY2F1c2UgYSBzZW50ZW5jZSB0aGF0IHRyaWVzIHRvXG4gIC8vIG5hbWUgdGhyZWUgY2F0ZWdvcmllcyBpbiBvbmUgYnJlYXRoIHJlYWRzIHdvcnNlIHRoYW4gdGhlIG51bWJlcnMgZG8uXG4gIGNvbnN0IGJ5S2luZCA9IG5ldyBNYXA8RmluZGluZ1tcImtpbmRcIl0sIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBmIG9mIGxpc3QpIGJ5S2luZC5zZXQoZi5raW5kLCAoYnlLaW5kLmdldChmLmtpbmQpID8/IDApICsgMSk7XG4gIC8vIOKaoCBCT1RIIEZPUk1TIFdSSVRURU4gT1VULiBBcHBlbmRpbmcgXCJzXCIgcHJvZHVjZWQgXCJnaG9zdCBpbiB0aGUgY29udGV4dHNcIixcbiAgLy8gd2hpY2ggaXMgdGhlIGtpbmQgb2Ygc21hbGwgd3JvbmduZXNzIHRoYXQgbWFrZXMgYSB0b29sIHJlYWQgYXMgY2FyZWxlc3MuXG4gIGNvbnN0IGxhYmVsOiBSZWNvcmQ8RmluZGluZ1tcImtpbmRcIl0sIFtvbmU6IHN0cmluZywgbWFueTogc3RyaW5nXT4gPSB7XG4gICAgXCJvcmlnaW5hbC5taXNzaW5nXCI6IFtcIm1pc3NpbmcgZmlsZVwiLCBcIm1pc3NpbmcgZmlsZXNcIl0sXG4gICAgXCJjb250ZXh0Lmdob3N0XCI6IFtcImdob3N0IGluIHRoZSBjb250ZXh0XCIsIFwiZ2hvc3RzIGluIHRoZSBjb250ZXh0XCJdLFxuICAgIFwibGlua3MuZGFuZ2xpbmdcIjogW1wic2V0IHdpdGggZGFuZ2xpbmcgbGlua3NcIiwgXCJzZXRzIHdpdGggZGFuZ2xpbmcgbGlua3NcIl0sXG4gIH07XG4gIGNvbnN0IHBhcnRzID0gWy4uLmJ5S2luZF0ubWFwKChba2luZCwgbl0pID0+IGAke259ICR7bGFiZWxba2luZF1bbiA9PT0gMSA/IDAgOiAxXX1gKTtcbiAgcmV0dXJuIGBTdGFydHVwIGNoZWNrOiAke3BhcnRzLmpvaW4oXCIsIFwiKX0g4oCUIHJ1biBcXGBkb2N0b3JcXGAgZm9yIHRoZSBkZXRhaWwuYDtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8vIFVuZG8gYW5kIHJlZG8gZm9yIHRoZSBDT05URVhUIOKAlCBtb3ZpbmcgdGhpbmdzIGFyb3VuZCwgYWRkaW5nLCBoaWRpbmcgKEU2MCkuXG4vL1xuLy8g4puUIFRISVMgSVMgTk9UIFRIRSBFRElUT1InUyBVTkRPLCBhbmQgdGhlIHN1cmZhY2Ugc2F5cyBzbyBieSBwdXR0aW5nIHRoZXNlXG4vLyBhcnJvd3MgaW4gdGhlIGNvbnRleHQgaGVhZGVyIHJhdGhlciB0aGFuIGFueXdoZXJlIG5lYXIgdGhlIHRleHQuIENvZGVNaXJyb3Inc1xuLy8gaGlzdG9yeSBvd25zIGtleXN0cm9rZXMgaW5zaWRlIGEgZG9jdW1lbnQ7IHRoaXMgb3ducyBhY3RzIG9uIHRoZSBTSEFQRSBvZiB0aGVcbi8vIGNvbnRleHQsIHdoaWNoIGlzIHRoZSB0aGluZyB0aGF0IGhhZCBubyB3YXkgYmFjayBhdCBhbGwuIENvbGU6IFwibGV0dGluZyB0aGVcbi8vIHVzZXIga25vdyB0aGF0IHRoZXJlJ3MgYW4gdW5kbyBmb3IgdGhpcyBzaWRlYmFyIHRoYXQgaXNuJ3QgdGhlIHNhbWUgYXMgdW5kb1xuLy8gcmVkbyB3aGVuIHlvdSdyZSBpbiB0aGUgZWRpdG9yLlwiXG4vL1xuLy8g4puUIFVORE9JTkcgQSBDUkVBVElPTiBERUxFVEVTLCBCVVQgT05MWSBCRUhJTkQgQSBDT05GSVJNQVRJT04uIFRoaXMgc3RhcnRlZCBhc1xuLy8gYSBoYXJkIGJsb2NrIOKAlCB1bmRvIG5ldmVyIGRlbGV0ZXMg4oCUIGFuZCBDb2xlIHB1c2hlZCBiYWNrLCBjb3JyZWN0bHk6IGJsb2NraW5nXG4vLyBkb2VzIG5vdCByZWZ1c2Ugb25lIHN0ZXAsIGl0IFNUUkFORFMgRVZFUllUSElORyBCRUhJTkQgSVQuIENyZWF0ZSBhIGZvbGRlciwgZG9cbi8vIHR3byBtb3ZlcywgYW5kIHlvdSBjYW4gdW5kbyB0aGUgbW92ZXMgYW5kIHRoZW4gbWVldCBhIHdhbGwgeW91IGNhbiBuZXZlclxuLy8gcGFzcywgYXQgd2hpY2ggcG9pbnQgdGhlIGhpc3RvcnkgaGFzIHN0b3BwZWQgYmVpbmcgYSBoaXN0b3J5LiBBbmQgdGhlIHRoaW5nXG4vLyB1bmRvIHdvdWxkIHJlbW92ZSBpcyBvbmUgdGhlIHNlc3Npb24gaXRzZWxmIG1hZGUgbW9tZW50cyBhZ28sIHVzdWFsbHkgZW1wdHkg4oCUXG4vLyBjYXRlZ29yaWNhbGx5IGRpZmZlcmVudCBmcm9tIGRlbGV0aW5nIHdvcmssIGFuZCB0aGUgYXBwIGFscmVhZHkgaGFzIHRoZVxuLy8gcGF0dGVybiBmb3IgaXQgaW4gdGhlIHZlcnNpb24tZGVsZXRlIGRpYWxvZy4gU28gdGhlIGFycm93IHN0YXlzIGVuYWJsZWQgYW5kXG4vLyB0aGUgQ09ORklSTUFUSU9OIGlzIHRoZSBnYXRlLlxuLy9cbi8vIOKblCBXSVRIIE9ORSBIQVJEIExJTUlUIFRIQVQgSVMgTk9UIE5FR09USUFCTEUgQlkgRElBTE9HOiBhIE5PTi1FTVBUWSBmb2xkZXIgaXNcbi8vIHJlZnVzZWQgb3V0cmlnaHQuIFVuZG8gd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdFxuLy8gcmVhY2hlcyB0aGF0IGZvbGRlcidzIGNyZWF0aW9uOyBpZiB0aGUgZm9sZGVyIHN0aWxsIGhhcyBjb250ZW50cywgc29tZXRoaW5nXG4vLyBwdXQgdGhlbSB0aGVyZSB0aGF0IHRoaXMgaGlzdG9yeSBkb2VzIG5vdCBrbm93IGFib3V0LCBhbmQgcmVtb3ZpbmcgYVxuLy8gZGlyZWN0b3J5IHRyZWUgaXMgYSBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0XG4vLyBtYWRlLiBUaGF0IGNhc2Ugc3RvcHMgYW5kIHNheXMgd2h5LlxuLy9cbi8vIOKaoCBUSEUgSU5WRVJTRSBJUyBCVUlMVCBXSEVOIFRIRSBBQ1QgSEFQUEVOUywgZnJvbSB3aGF0IHdhcyBhY3R1YWxseSB0cnVlXG4vLyB0aGVuIOKAlCBub3QgcmVjb25zdHJ1Y3RlZCBsYXRlciBmcm9tIHRoZSBvcC4gQSBgbW92ZWAgcmVjb3JkcyB3aGVyZSB0aGUgdGhpbmdcbi8vIENBTUUgZnJvbSBiZWNhdXNlIG9ubHkgdGhlIG1vdmVyIGtub3dzOyBhIGBoaWRlYCByZWNvcmRzIHRoZSBlbnRyeSdzIHdob2xlXG4vLyBoaWRkZW4gbGlzdCBiZWNhdXNlIHRoYXQgaXMgd2hhdCByZXN0b3JlcyBpdCBleGFjdGx5LCBpbmNsdWRpbmcgdGhlIGNhc2Vcbi8vIHdoZXJlIGhpZGluZyByZW1vdmVkIGEgc2luZ2xlLWRvY3VtZW50IGVudHJ5IG91dHJpZ2h0LlxuaW1wb3J0IHR5cGUgeyBTdHJ1Y3R1cmVPcCB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogSG93IHRvIHB1dCBvbmUgYWN0IGJhY2suIEVhY2ggdmFyaWFudCBpcyBzb21ldGhpbmcgdGhlIHNlc3Npb24gY2FuIGFscmVhZHlcbiAqIGRvLCBzbyB1bmRvIGludHJvZHVjZXMgbm8gbmV3IHdheSB0byBjaGFuZ2UgdGhlIHdvcmxkIOKAlCBpdCBvbmx5IHJlcGxheXMgdGhlXG4gKiBleGlzdGluZyBvbmVzIHdpdGggcmVjb3JkZWQgYXJndW1lbnRzLlxuICovXG5leHBvcnQgdHlwZSBJbnZlcnNlID1cbiAgfCB7IGtpbmQ6IFwibW92ZVwiOyBwYXRoOiBzdHJpbmc7IGludG86IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInJlbmFtZVwiOyBwYXRoOiBzdHJpbmc7IG5hbWU6IHN0cmluZyB9XG4gIC8qKiBTZXQgYW4gZW50cnkncyBoaWRkZW4gbGlzdCB0byBleGFjdGx5IHRoZXNlIHJlbGF0aXZlIHBhdGhzLiAqL1xuICB8IHsga2luZDogXCJoaWRkZW5cIjsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfVxuICAvKiogUHV0IGEgd2hvbGUgZG9jdW1lbnQgb3IgZm9sZGVyIGJhY2sgaW4gdGhlIGNvbnRleHQuICovXG4gIHwgeyBraW5kOiBcImNvbnRleHQuYWRkXCI7IHBhdGg6IHN0cmluZyB9XG4gIC8qKiBUYWtlIGEgY29udGV4dCBlbnRyeSBiYWNrIG91dCAodGhlIGludmVyc2Ugb2YgcHV0dGluZyBvbmUgaW4pLiAqL1xuICB8IHsga2luZDogXCJjb250ZXh0LnJlbW92ZVwiOyBlbnRyeTogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwid29ya3NwYWNlXCI7IHBhdGg6IHN0cmluZyB9XG4gIC8qKlxuICAgKiBSZW1vdmUgd2hhdCB0aGUgYWN0IGNyZWF0ZWQuIGBkaXJgIGRlY2lkZXMgYm90aCB0aGUgZGlhbG9nJ3Mgd29yZHMgYW5kIHRoZVxuICAgKiBlbXB0aW5lc3MgcnVsZSDigJQgYSBmaWxlIGlzIGNvbmZpcm1lZCwgYSBmb2xkZXIgaXMgY29uZmlybWVkIEFORCBtdXN0IGJlXG4gICAqIGVtcHR5LlxuICAgKi9cbiAgfCB7IGtpbmQ6IFwiZGVsZXRlXCI7IHBhdGg6IHN0cmluZzsgZGlyOiBib29sZWFuIH07XG5cbi8qKiBPbmUgYWN0LCB3aXRoIHRoZSB3YXkgYmFjayBhbmQgYSBzZW50ZW5jZSBmb3IgdGhlIGFycm93J3MgdG9vbHRpcC4gKi9cbmV4cG9ydCB0eXBlIEFjdCA9IHtcbiAgLyoqIFdoYXQgaGFwcGVuZWQsIGZvciB0aGUgdG9vbHRpcDogXCJtb3ZlZCBub3RlLm1kIGludG8gZHJhZnRzXCIuICovXG4gIGxhYmVsOiBzdHJpbmc7XG4gIGludmVyc2U6IEludmVyc2U7XG59O1xuXG4vKipcbiAqIFdoYXQgdGhlIHNlc3Npb24ga25ldyBiZWZvcmUgdGhlIGFjdCDigJQgdGhlIHBhcnRzIGFuIGludmVyc2UgbWF5IG5lZWQuXG4gKlxuICog4pqgIFBhc3NlZCBpbiByYXRoZXIgdGhhbiByZWFkIGJhY2sgYWZ0ZXJ3YXJkcywgYmVjYXVzZSBldmVyeSBmaWVsZCBoZXJlIGlzXG4gKiBzb21ldGhpbmcgdGhlIGFjdCBpdHNlbGYgQ0hBTkdFUy4gUmVhZGluZyBgaGlkZGVuYCBhZnRlciBhIGhpZGUgcmV0dXJucyB0aGVcbiAqIGxpc3QgaW5jbHVkaW5nIHRoZSB0aGluZyBqdXN0IGhpZGRlbiwgd2hpY2ggcmVzdG9yZXMgbm90aGluZy5cbiAqL1xuZXhwb3J0IHR5cGUgQmVmb3JlID0ge1xuICAvKiogVGhlIGVudHJ5J3MgaGlkZGVuIGxpc3QgYmVmb3JlIHRoZSBhY3QsIHdoZW4gdGhlIGFjdCB0b3VjaGVkIG9uZS4gKi9cbiAgaGlkZGVuPzogeyBlbnRyeTogc3RyaW5nOyByZWxzOiBzdHJpbmdbXSB9O1xuICAvKiogVGhlIHdvcmtzcGFjZSBiZWZvcmUgdGhlIGFjdC4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIFdoYXQgdGhlIGFjdCByZXR1cm5lZCDigJQgdGhlIHNlc3Npb24ncyBvd24gcmVzdWx0LCBuYXJyb3dlZCB0byB3aGF0IHdlIHVzZS4gKi9cbmV4cG9ydCB0eXBlIEFmdGVyID0ge1xuICBwYXRoPzogc3RyaW5nO1xuICAvKiogV2hlcmUgYSBtb3ZlIG9yIHJlbmFtZSBjYW1lIEZST00uICovXG4gIGZyb20/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZm9sZGVyIGBzZXQubWFrZWAgY3JlYXRlZC4gKi9cbiAgZm9sZGVyPzogc3RyaW5nO1xuICAvKiogVGhlIGVudHJ5IGEgaGlkZSB0b3VjaGVkLCBhbmQgd2hldGhlciBpdCByZW1vdmVkIHRoYXQgZW50cnkgZW50aXJlbHkuICovXG4gIGVudHJ5Pzogc3RyaW5nO1xuICByZW1vdmVkRW50cnk/OiBib29sZWFuO1xufTtcblxuY29uc3QgYmFzZSA9IChwOiBzdHJpbmcpOiBzdHJpbmcgPT4gcC5zcGxpdChcIi9cIikucG9wKCkgPz8gcDtcbmNvbnN0IHBhcmVudCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgPT4gcC5zbGljZSgwLCBNYXRoLm1heCgwLCBwLmxhc3RJbmRleE9mKFwiL1wiKSkpIHx8IFwiL1wiO1xuXG4vKipcbiAqIFRoZSB3YXkgYmFjayBmcm9tIG9uZSBhY3QuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhbiBhY3Qgbm90IHdvcnRoIGEgaGlzdG9yeSBlbnRyeSBhdCBhbGwg4oCUIGB1bmhpZGVgIG9uIGFuXG4gKiBlbnRyeSB0aGF0IGhhZCBub3RoaW5nIGhpZGRlbiBjaGFuZ2VkIG5vdGhpbmcsIGFuZCBhbiB1bmRvIGFycm93IHRoYXQgc3RlcHNcbiAqIG92ZXIgbm8tb3BzIGlzIGFuIGFycm93IHRoYXQgbGllcyBhYm91dCBob3cgZmFyIGJhY2sgaXQgY2FuIGdvLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbkludmVyc2Uob3A6IFN0cnVjdHVyZU9wLCBhZnRlcjogQWZ0ZXIsIGJlZm9yZTogQmVmb3JlKTogQWN0IHwgbnVsbCB7XG4gIHN3aXRjaCAob3AudHlwZSkge1xuICAgIC8vIOKUgOKUgCBicm91Z2h0IHNvbWV0aGluZyBpbnRvIGV4aXN0ZW5jZTogbm8gaW52ZXJzZSB0aGF0IGRvZXMgbm90IGRlbGV0ZSDilIDilIBcbiAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjcmVhdGVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiLCBkaXI6IGZhbHNlIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNyZWF0ZWQgdGhlIGZvbGRlciAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiB0cnVlIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJpbXBvcnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY29waWVkIGluICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiLCBkaXI6IGZhbHNlIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJzZXQubWFrZVwiOlxuICAgICAgLy8g4pqgIFRIRSBGT0xERVIgSVMgVEhFIFRISU5HIFRPIFVORE8sIG5vdCB0aGUgbW92ZSBpbnNpZGUgaXQuIGBzZXQubWFrZWBcbiAgICAgIC8vIGNyZWF0ZXMgYSBmb2xkZXIgYW5kIG1vdmVzIHRoZSBkb2N1bWVudCBpbiwgc28gdGhlIGludmVyc2UgaXMgdG9cbiAgICAgIC8vIHJlbW92ZSB0aGUgZm9sZGVyIOKAlCB3aGljaCB0aGUgZW1wdGluZXNzIHJ1bGUgd2lsbCByZWZ1c2Ugd2hpbGUgdGhlXG4gICAgICAvLyBkb2N1bWVudCBpcyBzdGlsbCBpbiB0aGVyZS4gVGhhdCByZWZ1c2FsIGlzIGNvcnJlY3QgYW5kIHJlYWRhYmxlXG4gICAgICAvLyAoXCJ0aGUgZm9sZGVyIGlzIG5vdCBlbXB0eVwiKSwgYW5kIHRoZSB3YXkgdGhyb3VnaCBpdCBpcyB0byBtb3ZlIHRoZVxuICAgICAgLy8gZG9jdW1lbnQgb3V0IGZpcnN0LCB3aGljaCBpcyBpdHNlbGYgYW4gdW5kb2FibGUgYWN0LlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGB0dXJuZWQgJHtiYXNlKG9wLnBhdGgpfSBpbnRvIGEgc2V0YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5mb2xkZXIgPz8gXCJcIiwgZGlyOiB0cnVlIH0sXG4gICAgICB9O1xuXG4gICAgLy8g4pSA4pSAIHJldmVyc2libGUsIHdpdGggYXJndW1lbnRzIG9ubHkgdGhlIGFjdCBrbmV3IOKUgOKUgFxuICAgIGNhc2UgXCJtb3ZlXCI6IHtcbiAgICAgIGlmIChhZnRlci5wYXRoID09PSB1bmRlZmluZWQgfHwgYWZ0ZXIuZnJvbSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgbW92ZWQgJHtiYXNlKGFmdGVyLmZyb20pfSBpbnRvICR7YmFzZShwYXJlbnQoYWZ0ZXIucGF0aCkpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJtb3ZlXCIsIHBhdGg6IGFmdGVyLnBhdGgsIGludG86IHBhcmVudChhZnRlci5mcm9tKSB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICBpZiAoYWZ0ZXIucGF0aCA9PT0gdW5kZWZpbmVkIHx8IGFmdGVyLmZyb20gPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHJlbmFtZWQgJHtiYXNlKGFmdGVyLmZyb20pfSB0byAke2Jhc2UoYWZ0ZXIucGF0aCl9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcInJlbmFtZVwiLCBwYXRoOiBhZnRlci5wYXRoLCBuYW1lOiBiYXNlKGFmdGVyLmZyb20pIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAvLyBUd28gc2hhcGVzOiBoaWRpbmcgb25lIGl0ZW0gaW5zaWRlIGEgc2V0LCBvciBoaWRpbmcgYSBzaW5nbGUtZG9jdW1lbnRcbiAgICAgIC8vIGVudHJ5LCB3aGljaCByZW1vdmVzIHRoZSBlbnRyeSBvdXRyaWdodC5cbiAgICAgIGlmIChhZnRlci5yZW1vdmVkRW50cnkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHJlbW92ZWQgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9IGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJjb250ZXh0LmFkZFwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGhhZCA9IGJlZm9yZS5oaWRkZW47XG4gICAgICBpZiAoIWhhZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHJlbW92ZWQgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9IGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiBoYWQuZW50cnksIHJlbHM6IGhhZC5yZWxzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgIGNvbnN0IGhhZCA9IGJlZm9yZS5oaWRkZW47XG4gICAgICAvLyBOb3RoaW5nIHdhcyBoaWRkZW4sIHNvIG5vdGhpbmcgaGFwcGVuZWQ6IG5vdCBoaXN0b3J5LlxuICAgICAgaWYgKCFoYWQgfHwgaGFkLnJlbHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgYnJvdWdodCBiYWNrICR7aGFkLnJlbHMubGVuZ3RofSBoaWRkZW4gaXRlbSR7aGFkLnJlbHMubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJoaWRkZW5cIiwgZW50cnk6IGhhZC5lbnRyeSwgcmVsczogaGFkLnJlbHMgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6IHtcbiAgICAgIGNvbnN0IHdhcyA9IGJlZm9yZS53b3Jrc3BhY2U7XG4gICAgICBpZiAod2FzID09PSB1bmRlZmluZWQgfHwgd2FzID09PSBhZnRlci5wYXRoKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcIndvcmtzcGFjZVwiLCBwYXRoOiB3YXMgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG59XG5cbi8qKiBXaGF0IHRoZSBhcnJvd3MgbmVlZCB0byBrbm93LCBhbmQgbm90aGluZyBlbHNlLiAqL1xuZXhwb3J0IHR5cGUgSGlzdG9yeVZpZXcgPSB7XG4gIGNhblVuZG86IGJvb2xlYW47XG4gIGNhblJlZG86IGJvb2xlYW47XG4gIC8qKiBcIm1vdmVkIG5vdGUubWQgaW50byBkcmFmdHNcIiwgZm9yIHRoZSB0b29sdGlwLiAqL1xuICB1bmRvTGFiZWw/OiBzdHJpbmc7XG4gIHJlZG9MYWJlbD86IHN0cmluZztcbiAgLyoqXG4gICAqIFNldCB3aGVuIHRoZSBuZXh0IHVuZG8gd291bGQgREVMRVRFIHNvbWV0aGluZywgc28gdGhlIHN1cmZhY2UgY2FuIHJhaXNlIGFcbiAgICogY29uZmlybWF0aW9uIGJlZm9yZSBzZW5kaW5nIGl0LiBQcmVzZW50IG1lYW5zIFwiYXNrIGZpcnN0XCIsIG5vdCBcInJlZnVzZVwiLlxuICAgKi9cbiAgdW5kb0RlbGV0ZXM/OiB7IHBhdGg6IHN0cmluZzsgZGlyOiBib29sZWFuIH07XG59O1xuXG4vKipcbiAqIFRoZSB0d28gc3RhY2tzLlxuICpcbiAqIOKaoCBJTiBNRU1PUlksIE5PVCBJTiBUSEUgTUFOSUZFU1QsIGFuZCB0aGF0IGlzIGEgZGVjaXNpb24gcmF0aGVyIHRoYW5cbiAqIGxhemluZXNzOiBhbiBpbnZlcnNlIHJlY29yZGVkIG5vdyBkZXNjcmliZXMgdGhlIHdvcmxkIGFzIGl0IGlzIG5vdywgYW5kIGFcbiAqIHNlc3Npb24gcmVzdG9yZWQgdG9tb3Jyb3cgbWF5IG1lZXQgYSBmaWxlIHNvbWVib2R5IGhhcyBzaW5jZSBtb3ZlZCBieSBoYW5kLlxuICogT2ZmZXJpbmcgYW4gdW5kbyB3aG9zZSBhcmd1bWVudHMgaGF2ZSBnb25lIHN0YWxlIGlzIHdvcnNlIHRoYW4gc3RhcnRpbmcgZWFjaFxuICogc2Vzc2lvbiB3aXRoIGFuIGVtcHR5IGhpc3Rvcnkg4oCUIHNvIHRoZSBhcnJvd3MgYXJlIGdyZXkgYWZ0ZXIgYSByZXN0b3JlLCB3aGljaFxuICogaXMgaG9uZXN0IGFib3V0IHdoYXQgY2FuIHN0aWxsIGJlIHB1dCBiYWNrLlxuICovXG5leHBvcnQgY2xhc3MgSGlzdG9yeSB7XG4gIHByaXZhdGUgdW5kb3M6IEFjdFtdID0gW107XG4gIHByaXZhdGUgcmVkb3M6IEFjdFtdID0gW107XG5cbiAgLyoqIFJlY29yZCBhbiBhY3QuIEEgbmV3IGFjdCBtYWtlcyB0aGUgcmVkbyBzdGFjayBtZWFuaW5nbGVzcy4gKi9cbiAgZGlkKGFjdDogQWN0IHwgbnVsbCk6IHZvaWQge1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgdGhpcy51bmRvcy5wdXNoKGFjdCk7XG4gICAgdGhpcy5yZWRvcyA9IFtdO1xuICB9XG5cbiAgLyoqIFdoYXQgdGhlIG5leHQgdW5kbyB3b3VsZCBkbywgd2l0aG91dCBkb2luZyBpdC4gKi9cbiAgcGVla1VuZG8oKTogQWN0IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMudW5kb3NbdGhpcy51bmRvcy5sZW5ndGggLSAxXSA/PyBudWxsO1xuICB9XG5cbiAgcGVla1JlZG8oKTogQWN0IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMucmVkb3NbdGhpcy5yZWRvcy5sZW5ndGggLSAxXSA/PyBudWxsO1xuICB9XG5cbiAgLyoqXG4gICAqIFRha2UgdGhlIG5leHQgdW5kbywgaGF2aW5nIGFwcGxpZWQgaXQuIGByZWRvYCBpcyB0aGUgYWN0IHRoYXQgd291bGQgcHV0IGl0XG4gICAqIGJhY2sg4oCUIGJ1aWx0IGJ5IHRoZSBjYWxsZXIsIGJlY2F1c2Ugb25seSB0aGUgY2FsbGVyIGtub3dzIHdoYXQgaXRzIG93blxuICAgKiBpbnZlcnNlIHByb2R1Y2VkLlxuICAgKi9cbiAgdG9va1VuZG8ocmVkbzogQWN0IHwgbnVsbCk6IHZvaWQge1xuICAgIGNvbnN0IGFjdCA9IHRoaXMudW5kb3MucG9wKCk7XG4gICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICBpZiAocmVkbykgdGhpcy5yZWRvcy5wdXNoKHJlZG8pO1xuICB9XG5cbiAgdG9va1JlZG8odW5kbzogQWN0IHwgbnVsbCk6IHZvaWQge1xuICAgIGNvbnN0IGFjdCA9IHRoaXMucmVkb3MucG9wKCk7XG4gICAgaWYgKCFhY3QpIHJldHVybjtcbiAgICBpZiAodW5kbykgdGhpcy51bmRvcy5wdXNoKHVuZG8pO1xuICB9XG5cbiAgdmlldygpOiBIaXN0b3J5VmlldyB7XG4gICAgY29uc3QgdW5kbyA9IHRoaXMucGVla1VuZG8oKTtcbiAgICBjb25zdCByZWRvID0gdGhpcy5wZWVrUmVkbygpO1xuICAgIGNvbnN0IGRlbGV0ZXMgPSB1bmRvPy5pbnZlcnNlLmtpbmQgPT09IFwiZGVsZXRlXCIgPyB1bmRvLmludmVyc2UgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHtcbiAgICAgIC8vIOKblCBBIERFTEVUSU5HIFVORE8gSVMgU1RJTEwgVU5ET0FCTEUg4oCUIHRoZSBnYXRlIGlzIHRoZSBkaWFsb2csIG5vdCB0aGVcbiAgICAgIC8vIGRpc2FibGVkIHN0YXRlIChDb2xlJ3MgcnVsaW5nLCByZXZlcnNpbmcgYW4gZWFybGllciBkZXNpZ24gdGhhdFxuICAgICAgLy8gc3RyYW5kZWQgZXZlcnkgYWN0IGJlaGluZCBhIGNyZWF0aW9uKS5cbiAgICAgIGNhblVuZG86IHVuZG8gIT09IG51bGwsXG4gICAgICBjYW5SZWRvOiByZWRvICE9PSBudWxsLFxuICAgICAgLi4uKHVuZG8gPyB7IHVuZG9MYWJlbDogdW5kby5sYWJlbCB9IDoge30pLFxuICAgICAgLi4uKHJlZG8gPyB7IHJlZG9MYWJlbDogcmVkby5sYWJlbCB9IDoge30pLFxuICAgICAgLi4uKGRlbGV0ZXMgPyB7IHVuZG9EZWxldGVzOiB7IHBhdGg6IGRlbGV0ZXMucGF0aCwgZGlyOiBkZWxldGVzLmRpciB9IH0gOiB7fSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKiBIb3cgZGVlcCB0aGUgc3RhY2tzIGFyZSDigJQgZm9yIHRlc3RzIGFuZCBmb3IgYHN0YXRlIC0tZnVsbGAuICovXG4gIGRlcHRoKCk6IHsgdW5kbzogbnVtYmVyOyByZWRvOiBudW1iZXIgfSB7XG4gICAgcmV0dXJuIHsgdW5kbzogdGhpcy51bmRvcy5sZW5ndGgsIHJlZG86IHRoaXMucmVkb3MubGVuZ3RoIH07XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgTkFUSVZFIGZpbGUgcGlja2VyIOKAlCB0aGUgYWZmb3JkYW5jZSBhIHdlYiBwYWdlIGNhbm5vdCBoYXZlLlxuICpcbiAqIEEgYnJvd3NlcidzIG93biBgPGlucHV0IHR5cGU9XCJmaWxlXCI+YCBhbmQgYHNob3dPcGVuRmlsZVBpY2tlcigpYCBib3RoIGhhbmRcbiAqIGJhY2sgZmlsZSBDT05URU5UIGFuZCBhIG5hbWUsIG5ldmVyIGEgcGF0aCAoYW5kIEJyYXZlLCBDb2xlJ3MgYnJvd3NlcixcbiAqIGRpc2FibGVzIHRoZSBGaWxlIFN5c3RlbSBBY2Nlc3MgQVBJIG91dHJpZ2h0KS4gQSBjb3B5IGlzIGFsbCBhIHBhZ2UgY2FuIGRvXG4gKiB3aXRoIHRoYXQsIHdoaWNoIGlzIGV4YWN0bHkgd2hhdCBhIGRyb3AgYWxyZWFkeSBkb2VzIChFMjMpLiBCdXQgc2NyaXB0b3JpdW0nc1xuICogZGFlbW9uIGlzIGEgTE9DQUwgUFJPQ0VTUzogaXQgY2FuIGFzayB0aGUgT1MgZm9yIGl0cyBvd24gb3BlbiBkaWFsb2cgYW5kIGdldFxuICogYmFjayBhIHJlYWwgZmlsZXN5c3RlbSBwYXRoIOKAlCBzbyBcIkNob29zZeKAplwiIGxpbmtzIHRoZSByZWFsIGZpbGUgKEUxKSBpbnN0ZWFkXG4gKiBvZiBjb3B5aW5nIGl0LlxuICpcbiAqIEV2ZXJ5dGhpbmcgaGVyZSBpcyBwdXJlOiB3aGljaCBhcmd2IHRvIHJ1biwgYW5kIGhvdyB0byByZWFkIHdoYXQgaXQgcHJpbnRlZC5cbiAqIFRoZSBzcGF3bmluZyAoYW5kIHRoZSBvbmUtYXQtYS10aW1lIHJ1bGUpIGlzIHRoZSBkYWVtb24ncy5cbiAqL1xuXG5leHBvcnQgdHlwZSBQaWNrS2luZCA9IFwiZmlsZVwiIHwgXCJmb2xkZXJcIjtcblxuLyoqIEFuIEFwcGxlU2NyaXB0IHRoYXQgcHV0cyBvbmUgUE9TSVggcGF0aCBwZXIgbGluZSBvbiBzdGRvdXQuICovXG5mdW5jdGlvbiBhcHBsZVNjcmlwdChraW5kOiBQaWNrS2luZCwgcHJvbXB0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBxdW90ZWQgPSBwcm9tcHQucmVwbGFjZSgvW1wiXFxcXF0vZywgXCJcIik7XG4gIGNvbnN0IGNob29zZSA9XG4gICAga2luZCA9PT0gXCJmaWxlXCJcbiAgICAgID8gYGNob29zZSBmaWxlIHdpdGggcHJvbXB0IFwiJHtxdW90ZWR9XCIgd2l0aCBtdWx0aXBsZSBzZWxlY3Rpb25zIGFsbG93ZWRgXG4gICAgICA6IGB7Y2hvb3NlIGZvbGRlciB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwifWA7XG4gIHJldHVybiBbXG4gICAgYHNldCBjaG9zZW4gdG8gJHtjaG9vc2V9YCxcbiAgICAnc2V0IG91dCB0byBcIlwiJyxcbiAgICBcInJlcGVhdCB3aXRoIGYgaW4gY2hvc2VuXCIsXG4gICAgXCJzZXQgb3V0IHRvIG91dCAmIFBPU0lYIHBhdGggb2YgZiAmIGxpbmVmZWVkXCIsXG4gICAgXCJlbmQgcmVwZWF0XCIsXG4gICAgXCJyZXR1cm4gb3V0XCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgY29tbWFuZCB0aGF0IG9wZW5zIHRoZSBPUydzIHBpY2tlciwgb3IgbnVsbCB3aGVyZSB0aGVyZSBpcyBub25lIOKAlCB0aGVcbiAqIGNhbGxlciB0aGVuIHNheXMgc28gcmF0aGVyIHRoYW4gaGFuZ2luZyBvbiBhIGRpYWxvZyBub2JvZHkgd2lsbCBzZWUuXG4gKiBgemVuaXR5QXRgIGlzIHdoZXJlIGEgTGludXggemVuaXR5IHdhcyBmb3VuZCAodGhlIGNhbGxlciBsb29rcyBpdCB1cCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwaWNrZXJDb21tYW5kKFxuICBwbGF0Zm9ybTogc3RyaW5nLFxuICBraW5kOiBQaWNrS2luZCxcbiAgcHJvbXB0OiBzdHJpbmcsXG4gIHplbml0eUF0Pzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIikgcmV0dXJuIFtcIm9zYXNjcmlwdFwiLCBcIi1lXCIsIGFwcGxlU2NyaXB0KGtpbmQsIHByb21wdCldO1xuICBpZiAocGxhdGZvcm0gPT09IFwid2luMzJcIikgcmV0dXJuIG51bGw7IC8vIFBvd2VyU2hlbGwncyBkaWFsb2cgbmVlZHMgYSBTVEEgaG9zdDsgbm90IHdyaXR0ZW4gdW50aWwgYXNrZWQgZm9yXG4gIGlmICh6ZW5pdHlBdClcbiAgICByZXR1cm4gW1xuICAgICAgemVuaXR5QXQsXG4gICAgICBcIi0tZmlsZS1zZWxlY3Rpb25cIixcbiAgICAgIC4uLihraW5kID09PSBcImZvbGRlclwiID8gW1wiLS1kaXJlY3RvcnlcIl0gOiBbXCItLW11bHRpcGxlXCJdKSxcbiAgICAgIFwiLS1zZXBhcmF0b3I9XFxuXCIsXG4gICAgICBgLS10aXRsZT0ke3Byb21wdH1gLFxuICAgIF07XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogVGhlIHBhdGhzIGEgcGlja2VyIHByaW50ZWQ6IG9uZSBwZXIgbGluZSwgYmxhbmtzIGRyb3BwZWQsIG9yZGVyIGtlcHQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBzdGRvdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAubWFwKChsKSA9PiBsLnRyaW0oKSlcbiAgICAuZmlsdGVyKChsKSA9PiBsLnN0YXJ0c1dpdGgoXCIvXCIpKVxuICAgIC5tYXAoKGwpID0+IChsLmxlbmd0aCA+IDEgJiYgbC5lbmRzV2l0aChcIi9cIikgPyBsLnNsaWNlKDAsIC0xKSA6IGwpKTtcbn1cblxuLyoqIEEgY2FuY2VsbGVkIGRpYWxvZyBpcyBub3QgYSBmYWlsdXJlIOKAlCBvc2FzY3JpcHQgZXhpdHMgMSwgemVuaXR5IGV4aXRzIDEsIGFuZCBub3RoaW5nIHdhcyBjaG9zZW4uICovXG5leHBvcnQgZnVuY3Rpb24gd2FzQ2FuY2VsbGVkKGV4aXRDb2RlOiBudW1iZXIsIHN0ZG91dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBleGl0Q29kZSAhPT0gMCAmJiBwYXJzZVBpY2tlck91dHB1dChzdGRvdXQpLmxlbmd0aCA9PT0gMDtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgc2Vzc2lvbiDigJQgdGhlIGRhZW1vbidzIHN0YXRlLCBhbmQgdGhlIG9ubHkgY29kZSB0aGF0IHdyaXRlcyBhIGZpbGUuXG4gKlxuICogRTgncyBzaGFwZSwgdGhlIGhvdXNlJ3MgXCJtYXRlcmlhbGl6ZWQgcGF0aFwiIHBhdHRlcm46IHRoZSBkYWVtb24gb3ducyB0aGVcbiAqIHNlc3Npb24gKGNvbnRleHQsIGRvY3MsIHZlcnNpb25zLCB3aGljaCBpcyBhY3RpdmUsIHRoZSBjaGF0KSBhbmQgcGVyc2lzdHMgaXRcbiAqIGFzIGBtYW5pZmVzdC5qc29uYDsgZXZlcnkgdmVyc2lvbidzIFRFWFQgaXMgYSBmaWxlIGluIHRoZSBzZXNzaW9uIGZvbGRlciwgc29cbiAqIHRoZSBhZ2VudCBlZGl0cyB2ZXJzaW9ucyB3aXRoIGl0cyBvd24gZmlsZSB0b29scy5cbiAqXG4gKiAgICAgJFNDUklQVE9SSVVNX0hPTUUvc2Vzc2lvbnMvPHNlc3Npb25JZD4vXG4gKiAgICAgICBtYW5pZmVzdC5qc29uICAgICAgICAgICAgICB3cml0dGVuIGF0b21pY2FsbHksIG9uIGV2ZXJ5IGNoYW5nZVxuICogICAgICAgZG9jcy88c2x1Zz4vdjEubWQsIHYyLm1kICAgb25lIGZpbGUgcGVyIHZlcnNpb25cbiAqXG4gKiBUaGUgdGhyZWUgd3JpdGUgcnVsZXMsIGVhY2ggYSBkZWNpc2lvbiByYXRoZXIgdGhhbiBhIGhhYml0OlxuICpcbiAqIC0gKipUaGUgb3JpZ2luYWwgaXMgd3JpdHRlbiBPTkxZIGJ5IGBzYXZlYCoqIChFNykuIE9wZW5pbmcgY29waWVzIGl0IHRvIHYxO1xuICogICBub3RoaW5nIGVsc2UgdG91Y2hlcyBpdC5cbiAqIC0gKipFdmVyeSB3cml0ZSB0aGlzIG1vZHVsZSBtYWtlcyBpcyByZW1lbWJlcmVkIGJ5IGNvbnRlbnQgaGFzaCoqICh0aGVcbiAqICAgYG93bmVkYCBtYXApIHNvIHRoZSB3YXRjaGVyIGNhbiB0ZWxsIHRoZSBkYWVtb24ncyBvd24gd3JpdGVzIGZyb20gYW55b25lXG4gKiAgIGVsc2UncyAoaW52ZXN0aWdhdGlvbiDCpzUpLiBBIHdyaXRlIHRvIHRoZSBBQ1RJVkUgdmVyc2lvbiB0aGF0IGlzIG5vdCBvdXJzXG4gKiAgIGlzIGFuIEUyIHZpb2xhdGlvbiB0aGUgZGFlbW9uIGFubm91bmNlcy5cbiAqIC0gKipUaGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSBhY3RpdmUgdmVyc2lvbioqIChFMikg4oCUIGVuZm9yY2VkIHNvY2lhbGx5IGJ5XG4gKiAgIFNLSUxMLm1kIGFuZCBkZXRlY3RlZCBoZXJlLCBub3QgcHJldmVudGVkOiB0aGUgZmlsZSBpcyB0aGUgYWdlbnQncyBtZWRpdW0uXG4gKlxuICogTm90aGluZyBoZXJlIGtub3dzIGFib3V0IHNvY2tldHMsIEhUVFAgb3IgdGhlIGV2ZW50IGxvZy4gVGhlIGRhZW1vbiBjYWxscyBhXG4gKiBtZXRob2QsIGdldHMgYSByZXN1bHQsIGFuZCBkZWNpZGVzIHdoYXQgdG8gYnJvYWRjYXN0OyB0aGF0IHNwbGl0IGlzIHdoYXRcbiAqIGxldHMgdGhlIHVuaXQgY2VsbHMgZHJpdmUgdGhlIHdob2xlIG1vZGVsIHdpdGggYSB0ZW1wIGhvbWUuXG4gKi9cblxuaW1wb3J0IHtcbiAgY2xvc2VTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG9wZW5TeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICByZW5hbWVTeW5jLFxuICAvLyDimqAgYHJtZGlyU3luY2AgcmF0aGVyIHRoYW4gYHJtU3luYyjigKYsIHtyZWN1cnNpdmU6dHJ1ZX0pYCBPTiBQVVJQT1NFOiBpdFxuICAvLyB0aHJvd3MgRU5PVEVNUFRZLCB3aGljaCBpcyBhIHNlY29uZCBuZXQgdW5kZXIgYHJlbW92ZUNyZWF0ZWRgJ3Mgb3duXG4gIC8vIGVtcHRpbmVzcyBjaGVjay4gQSByZWN1cnNpdmUgZGVsZXRlIHdvdWxkIG1ha2UgdGhlIGJ1ZyBpdCBwcmV2ZW50c1xuICAvLyB1bnJlY292ZXJhYmxlIHJhdGhlciB0aGFuIGxvdWQuXG4gIHJtZGlyU3luYyxcbiAgcm1TeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyB0eXBlIEFuY2hvciwgYW5jaG9yT2YsIGZpbmRBbmNob3IsIGxpbmVzT2YgfSBmcm9tIFwiLi9hbmNob3JzXCI7XG5pbXBvcnQgeyBhcHBseUh1bmtzLCBkaWZmVGV4dCB9IGZyb20gXCIuL2RpZmZcIjtcbmltcG9ydCB7IHR5cGUgRmluZGluZywgZmluZGluZ3MgfSBmcm9tIFwiLi9kb2N0b3JcIjtcbmltcG9ydCB7XG4gIGJvZHlMaW5lT2Zmc2V0LFxuICBidWlsZEJsb2NrLFxuICBndWVzc1R5cGUsXG4gIG1hdGNoZXNGaWx0ZXIsXG4gIHJlYWRNZXRhLFxuICBzZXRLZXksXG4gIHNwbGl0RnJvbnRtYXR0ZXIsXG4gIHN1bW1hcml6ZSxcbiAgdGl0bGVGcm9tQm9keSxcbiAgd2l0aEJsb2NrLFxufSBmcm9tIFwiLi9mcm9udG1hdHRlclwiO1xuaW1wb3J0IHsgdHlwZSBCdW5kbGVJbmRleCwgYnVpbGRHcmFwaCwgdHlwZSBSZXNvbHV0aW9uLCByZXNvbHZlVGFyZ2V0IH0gZnJvbSBcIi4vbGlua3NcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2hhdE1lc3NhZ2UsXG4gIENoYXRXaG8sXG4gIENvbnRleHRFbnRyeSxcbiAgQ29udGV4dE5vZGUsXG4gIERpZmZQYXlsb2FkLFxuICBEaWZmU2lkZSxcbiAgRG9jTWV0YSxcbiAgRG9jU3VtbWFyeSxcbiAgRG9jVmlldyxcbiAgR3JhcGhQYXlsb2FkLFxuICBNZXRhRmlsdGVyLFxuICBNb3ZlUGxhbixcbiAgTm90ZSxcbiAgUGxhY2VkTm90ZSxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgVGFzayxcbiAgVmVyc2lvbixcbiAgVmVyc2lvbkF1dGhvcixcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgQ2FuZGlkYXRlLCB0eXBlIFNlYXJjaFJlcG9ydCwgc2VhcmNoRG9jdW1lbnRzIH0gZnJvbSBcIi4vc2VhcmNoXCI7XG5pbXBvcnQge1xuICBET0NfRVhURU5TSU9OUyxcbiAgZG9jUGF0aHMsXG4gIGVudHJ5Rm9yUGF0aCxcbiAgZmluZE5vZGUsXG4gIGlzRG9jTmFtZSxcbiAgbG9jYXRlLFxuICBNSVJST1JfTk9ERV9DQVAsXG4gIHNjYW5UcmVlLFxuICB0b1Bvc2l4LFxufSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCBjb25zdCBNQU5JRkVTVF9GT1JNQVQgPSAxO1xuXG4vKiogVGhlIG1vc3QgZG9jdW1lbnRzIG9uZSBmcm9udG1hdHRlciBzY2FuIHJlYWRzLiAqL1xuZXhwb3J0IGNvbnN0IE1FVEFfU0NBTl9DQVAgPSA1MDA7XG4vKiogQSBmcm9udG1hdHRlciBibG9jayBsaXZlcyBhdCB0aGUgdG9wIG9mIGEgZmlsZTsgdGhpcyBpcyBob3cgbXVjaCB3ZSByZWFkIHRvIGZpbmQgaXQuICovXG5jb25zdCBNRVRBX0hFQURfQllURVMgPSA4MTkyO1xuXG4vKiogVGhlIGZpcnN0IDggS0Igb2YgYSBmaWxlLCBhcyB0ZXh0IOKAlCBlbm91Z2ggZm9yIGFueSBmcm9udG1hdHRlciBibG9jay4gKi9cbmZ1bmN0aW9uIHJlYWRIZWFkKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBmZDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGZkID0gb3BlblN5bmMocGF0aCwgXCJyXCIpO1xuICAgIGNvbnN0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyhNRVRBX0hFQURfQllURVMpO1xuICAgIGNvbnN0IHJlYWQgPSByZWFkU3luYyhmZCwgYnVmLCAwLCBNRVRBX0hFQURfQllURVMsIDApO1xuICAgIHJldHVybiBidWYuc3ViYXJyYXkoMCwgcmVhZCkudG9TdHJpbmcoXCJ1dGY4XCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoZmQgIT09IHVuZGVmaW5lZCkgY2xvc2VTeW5jKGZkKTtcbiAgfVxufVxuXG50eXBlIERvY1JlY29yZCA9IHtcbiAgc2x1Zzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIG9yaWdpbmFsOiBzdHJpbmc7XG4gIGVudHJ5SWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlbDogc3RyaW5nIHwgbnVsbDtcbiAgZXh0OiBzdHJpbmc7XG4gIHZlcnNpb25zOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPltdO1xuICBhY3RpdmU6IG51bWJlcjtcbiAgLyoqXG4gICAqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyIHRvIGhhbmQgb3V0IOKAlCBNT05PVE9OSUMsIGFuZCBuZXZlciBkZXJpdmVkIGZyb21cbiAgICogdGhlIHZlcnNpb25zIHN0aWxsIHByZXNlbnQgKEU0MSkuIE51bWJlcmluZyBhcyBgbWF4KGV4aXN0aW5nKSArIDFgIHdhc1xuICAgKiBjb3JyZWN0IHdoaWxlIG5vdGhpbmcgY291bGQgYmUgZGVsZXRlZDsgdGhlIG1vbWVudCBhIHZlcnNpb24gY2FuIGJlXG4gICAqIHJlbW92ZWQsIGRlbGV0aW5nIHRoZSBoaWdoZXN0IG1ha2VzIHRoZSBuZXh0IG9uZSBSRVVTRSBpdHMgbnVtYmVyLCBhbmQgYVxuICAgKiBgdjNgIG5hbWVkIGluIGEgY2hhdCBtZXNzYWdlLCBhIGxvZyBsaW5lIG9yIGFuIGFnZW50J3Mgbm90ZXMgd291bGQgdGhlblxuICAgKiBwb2ludCBhdCBhIGRpZmZlcmVudCBkb2N1bWVudC4gQWJzZW50IG9uIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgRTQxIOKAlFxuICAgKiBgdGFrZVZlcnNpb25gIGRlcml2ZXMgaXQgb25jZSwgZnJvbSB0aGUgaGlnaGVzdCB0aGF0IGV2ZXIgd2FzLlxuICAgKi9cbiAgbmV4dFZlcnNpb24/OiBudW1iZXI7XG4gIC8qKiBOb3RlcyBvbiB0aGlzIGRvY3VtZW50IChFNDUpLiBTdG9yZWQgaW4gdGhlIG1hbmlmZXN0OiB0aGV5IHRyYXZlbCB3aXRoIHRoZVxuICAgKiAgc2Vzc2lvbiBhbmQgbmV2ZXIgbGl0dGVyIHRoZSBodW1hbidzIGZvbGRlci4gKi9cbiAgbm90ZXM/OiBOb3RlW107XG4gIC8qKiBIYXNoIG9mIHRoZSBvcmlnaW5hbCBhcyB3ZSBsYXN0IHJlYWQgb3Igd3JvdGUgaXQg4oCUIGF0IG9wZW4sIHNhdmUsIHJldmVydFxuICAgKiAgYW5kIHJlbG9hZCDigJQgc28gYSByZXN0b3JlIGNhbiB0ZWxsIHRoYXQgaXQgY2hhbmdlZCB3aGlsZSBubyBkYWVtb24gd2FzXG4gICAqICB3YXRjaGluZyAodmVyaWZ5LXBhc3MgZml4IDIpLiAqL1xuICBvcmlnaW5hbEhhc2g6IHN0cmluZztcbiAgLyoqIFNldCBvbmx5IGJ5IGBvcGVuUGF0aGAsIHdoaWNoIGFkbWl0cyBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiAgZW50cnkuIGBzYXZlYCB3cml0ZXMgbm8gb3JpZ2luYWwgdGhhdCBsYWNrcyBpdCAodmVyaWZ5LXBhc3MgZml4IDFjKS4gKi9cbiAgYWRtaXR0ZWQ/OiBib29sZWFuO1xuICBvdXRzaWRlQ2hhbmdlZDogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIE1hbmlmZXN0ID0ge1xuICBmb3JtYXQ6IG51bWJlcjtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBjb250ZXh0OiBDb250ZXh0RW50cnlbXTtcbiAgZG9jczogRG9jUmVjb3JkW107XG4gIG9wZW5Eb2M6IHN0cmluZyB8IG51bGw7XG4gIGNoYXQ6IENoYXRNZXNzYWdlW107XG4gIC8qKiBUaGUgd29yayBxdWV1ZSAoRTUwKS4gQWJzZW50IGluIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgaXQgZXhpc3RlZC4gKi9cbiAgdGFza3M/OiBUYXNrW107XG4gIC8qKiBFMjMncyB3b3Jrc3BhY2UuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQ6IHRoZSB1c2VyJ3MgaG9tZS4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIEEgcmVmdXNhbCB0aGUgZGFlbW9uIHR1cm5zIGludG8gYW4gSFRUUCBzdGF0dXMg4oCUIGBjaG9pY2VzYCB3aGVuIHRoZSBzZXQgaXMgaW4gaGFuZCAoQTEpLiAqL1xuZXhwb3J0IGNsYXNzIFNlc3Npb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IHN0YXR1czogNDAwIHwgNDA0IHwgNDA5LFxuICAgIHJlYWRvbmx5IGNob2ljZXM/OiBzdHJpbmdbXSxcbiAgICAvKipcbiAgICAgKiBXaGF0IHRvIERPIGFib3V0IGl0LCB3aGVuIHRoZSBtZXNzYWdlIGFsb25lIGRvZXMgbm90IHNheS4gQ2FycmllZCB0byB0aGVcbiAgICAgKiBDTEkncyBlbnZlbG9wZSwgd2hlcmUgdGhlIGhvdXNlIHRheG9ub215IGFscmVhZHkgaGFzIGEgYGhpbnRgIGZpZWxkIHRoYXRcbiAgICAgKiByZWZ1c2FscyBmcm9tIHRoaXMgc2lkZSB3ZXJlIG5ldmVyIGZpbGxpbmcuXG4gICAgICovXG4gICAgcmVhZG9ubHkgaGludD86IHN0cmluZyxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IGNvbnRlbnRIYXNoID0gKHRleHQ6IHN0cmluZyk6IHN0cmluZyA9PiBCdW4uaGFzaCh0ZXh0KS50b1N0cmluZygxNik7XG5cbmNvbnN0IHJhbmRIZXggPSAobjogbnVtYmVyKSA9PlxuICBBcnJheS5mcm9tKGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKVxuICAgIC5tYXAoKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSlcbiAgICAuam9pbihcIlwiKTtcblxuZXhwb3J0IGNvbnN0IG5ld1Nlc3Npb25JZCA9ICgpOiBzdHJpbmcgPT4gcmFuZEhleCg0KTtcblxuLyoqIEEgcGF0aCdzIHJlYWxwYXRoLCBvciB0aGUgcGF0aCBpdHNlbGYgd2hlbiBpdCBjYW5ub3QgYmUgcmVzb2x2ZWQgKGdvbmUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWxPcihwOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiByZWFscGF0aFN5bmMocCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBwO1xuICB9XG59XG5cbi8qKiBXaGF0IGEgd2F0Y2hlciBldmVudCB0dXJuZWQgb3V0IHRvIGJlLiBgbnVsbGAgPSBub3RoaW5nIChvdXJzLCBvciBubyBjaGFuZ2UpLiAqL1xuZXhwb3J0IHR5cGUgRmlsZUV2ZW50ID1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgYWN0aXZlOiBmYWxzZSB9XG4gIHwge1xuICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiO1xuICAgICAgZG9jOiBzdHJpbmc7XG4gICAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgICBwYXRoOiBzdHJpbmc7XG4gICAgICAvKiogVGhlIG5ldyBhZ2VudCB2ZXJzaW9uIHRoZSBvdXRzaWRlIHRleHQgd2FzIHByZXNlcnZlZCBhcy4gKi9cbiAgICAgIHByZXNlcnZlZEFzOiBudW1iZXI7XG4gICAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmc7XG4gICAgfVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIjsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJ0cmVlXCI7IGVudHJ5SWQ6IHN0cmluZyB9O1xuXG5leHBvcnQgY2xhc3MgU2Vzc2lvbiB7XG4gIHJlYWRvbmx5IGRpcjogc3RyaW5nO1xuICBwcml2YXRlIG06IE1hbmlmZXN0O1xuICAvKiogcGF0aCDihpIgaGFzaCBvZiB0aGUgZGFlbW9uJ3MgbGFzdCB3cml0ZSB0byBpdC4gKi9cbiAgcHJpdmF0ZSBvd25lZCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiBoYXNoIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIGN1cnJlbnQgdGV4dC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVIYXNoID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgYXMgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIChvciBhZG9wdGVkKVxuICAgKiAgaXQg4oCUIHdoYXQgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gaXMgcmV2ZXJ0ZWQgdG8uICovXG4gIHByaXZhdGUgbGFzdEFjdGl2ZVRleHQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogV2hhdCBhIHJlc3RvcmUgZm91bmQgY2hhbmdlZCBvbiBkaXNrIHdoaWxlIG5vIGRhZW1vbiB3YXMgd2F0Y2hpbmcuICovXG4gIHJlc3RvcmVGaW5kaW5nczogeyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZzsgbWlzc2luZzogYm9vbGVhbiB9W10gPSBbXTtcblxuICBwcml2YXRlIGNvbnN0cnVjdG9yKFxuICAgIHJlYWRvbmx5IGhvbWU6IHN0cmluZyxcbiAgICBtYW5pZmVzdDogTWFuaWZlc3QsXG4gICkge1xuICAgIHRoaXMubSA9IG1hbmlmZXN0O1xuICAgIHRoaXMuZGlyID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIG1hbmlmZXN0LnNlc3Npb25JZCk7XG4gIH1cblxuICBzdGF0aWMgY3JlYXRlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcgPSBuZXdTZXNzaW9uSWQoKSwgd29ya3NwYWNlPzogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIHtcbiAgICAgIGZvcm1hdDogTUFOSUZFU1RfRk9STUFULFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgY29udGV4dDogW10sXG4gICAgICBkb2NzOiBbXSxcbiAgICAgIG9wZW5Eb2M6IG51bGwsXG4gICAgICBjaGF0OiBbXSxcbiAgICAgIC4uLih3b3Jrc3BhY2UgPyB7IHdvcmtzcGFjZTogcmVzb2x2ZSh3b3Jrc3BhY2UpIH0gOiB7fSksXG4gICAgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4ocy5kaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICAvKiogUmVsb2FkIGEgc2Vzc2lvbiBmcm9tIGl0cyBtYW5pZmVzdCAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gKS4gKi9cbiAgc3RhdGljIHJlc3RvcmUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgc2Vzc2lvbklkLCBcIm1hbmlmZXN0Lmpzb25cIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzYXZlZCBzZXNzaW9uICR7c2Vzc2lvbklkfWAsIDQwNCk7XG4gICAgY29uc3QgbSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgTWFuaWZlc3Q7XG4gICAgaWYgKG0uZm9ybWF0ICE9PSBNQU5JRkVTVF9GT1JNQVQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBzZXNzaW9uICR7c2Vzc2lvbklkfSBoYXMgbWFuaWZlc3QgZm9ybWF0ICR7bS5mb3JtYXR9YCwgNDA5KTtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwgbSk7XG4gICAgbWtkaXJTeW5jKGpvaW4ocy5kaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gTWlycm9ycyBhcmUgcmUtcmVhZCwgbm90IHRydXN0ZWQ6IHRoZSBmb2xkZXIgbWF5IGhhdmUgY2hhbmdlZCB3aGlsZSBub1xuICAgIC8vIGRhZW1vbiB3YXMgd2F0Y2hpbmcgaXQuXG4gICAgZm9yIChjb25zdCBlIG9mIHMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHMucmVzY2FuKGUuaWQpO1xuICAgIGZvciAoY29uc3QgZCBvZiBzLm0uZG9jcykge1xuICAgICAgY29uc3QgcCA9IHMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpO1xuICAgICAgY29uc3QgdGV4dCA9IGV4aXN0c1N5bmMocCkgPyByZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpIDogXCJcIjtcbiAgICAgIHMuYWRvcHRBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDI6IGFuIG9yaWdpbmFsIGNoYW5nZWQgd2hpbGUgdGhlIHNlc3Npb24gd2FzIGNsb3NlZFxuICAgICAgLy8gd2FzIGludmlzaWJsZSBoZXJlLCBzbyB0aGUgbmV4dCBTYXZlIG92ZXJ3cm90ZSBpdCB1bmFubm91bmNlZC4gVGhlXG4gICAgICAvLyBtYW5pZmVzdCBob2xkcyB0aGUgb3JpZ2luYWwncyBoYXNoIGFzIG9mIHRoZSBsYXN0IG9wZW4vc2F2ZS9yZXZlcnQvXG4gICAgICAvLyByZWxvYWQ7IGEgZGlmZmVyZW50IGhhc2ggbm93IGlzIGFuIG91dHNpZGUgY2hhbmdlLCBtYXJrZWQgZXhhY3RseSBhcyBhXG4gICAgICAvLyBsaXZlIG9uZSB3aXRoIGEgZGlydHkgYnVmZmVyIGlzIOKAlCBhc2tlZCwgbmV2ZXIgbWVyZ2VkIG9yIHJlbG9hZGVkLlxuICAgICAgbGV0IG5vdzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBub3cgPSBjb250ZW50SGFzaChyZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBub3cgPSBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKG5vdyA9PT0gbnVsbCB8fCBub3cgIT09IGQub3JpZ2luYWxIYXNoKSB7XG4gICAgICAgIGQub3V0c2lkZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgICBzLnJlc3RvcmVGaW5kaW5ncy5wdXNoKHsgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsLCBtaXNzaW5nOiBub3cgPT09IG51bGwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChzLnJlc3RvcmVGaW5kaW5ncy5sZW5ndGggPiAwKSBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIHN0YXRpYyBsaXN0U2F2ZWQoaG9tZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhZGRpclN5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIpKS5maWx0ZXIoKGlkKSA9PlxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBpZCwgXCJtYW5pZmVzdC5qc29uXCIpKSxcbiAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgZ2V0IGlkKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS5zZXNzaW9uSWQ7XG4gIH1cblxuICBnZXQgZG9jc0RpcigpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKHRoaXMuZGlyLCBcImRvY3NcIik7XG4gIH1cblxuICBnZXQgb3BlbkRvY1NsdWcoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubS5vcGVuRG9jO1xuICB9XG5cbiAgZ2V0IGNvbnRleHQoKTogcmVhZG9ubHkgQ29udGV4dEVudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBkaXJlY3RvcnkgdGhlIHdhdGNoZXIgbXVzdCBzZWU6IHRoZSBzZXNzaW9uJ3MgZG9jcywgZWFjaCBlbnRyeSByb290LFxuICAgKiBhbmQgdGhlIFJFQUwgZGlyZWN0b3J5IG9mIGV2ZXJ5IG9wZW5lZCBvcmlnaW5hbC5cbiAgICpcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCAzOiBlYWNoIHJvb3QgaXMgd2F0Y2hlZCBhdCBpdHMgUkVBTFBBVEggKGB3YXRjaGApLCBhbmRcbiAgICogYW4gZXZlbnQgaXMgcmVwb3J0ZWQgdW5kZXIgdGhlIHBhdGggZm9ybSB0aGUgc2Vzc2lvbiBzdG9yZXMgKGBwYXRoYCkuIEFcbiAgICogd2F0Y2ggb24gYSBzeW1saW5rZWQgZGlyZWN0b3J5IOKAlCBhIHN5bWxpbmtlZCBob21lLCBhIHN5bWxpbmtlZCBmb2xkZXJcbiAgICogZW50cnkg4oCUIG9yIG9uIHRoZSBsaW5rJ3Mgb3duIGRpcmVjdG9yeSBmb3IgYSBzeW1saW5rZWQgb3JpZ2luYWwgc2F3XG4gICAqIG5vdGhpbmcgd2hlbiB0aGUgVEFSR0VUIGNoYW5nZWQgKEZTRXZlbnRzIHJlcG9ydHMgcmVhbCBwYXRocykuIEEgc3ltbGlua2VkXG4gICAqIG9yaWdpbmFsIGlzIG1hdGNoZWQgYmFjayB0byBpdHMgZG9jIGJ5IHJlYWxwYXRoIGluIGBvbkZpbGVFdmVudGAuXG4gICAqL1xuICB3YXRjaFJvb3RzKCk6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdIHtcbiAgICBjb25zdCByb290czogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10gPSBbXG4gICAgICB7IHBhdGg6IHRoaXMuZG9jc0Rpciwgd2F0Y2g6IHJlYWxPcih0aGlzLmRvY3NEaXIpLCByZWN1cnNpdmU6IHRydWUgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIHJvb3RzLnB1c2goe1xuICAgICAgICBwYXRoOiBlLnJvb3QsXG4gICAgICAgIHdhdGNoOiByZWFsT3IoZS5yb290KSxcbiAgICAgICAgcmVjdXJzaXZlOiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIixcbiAgICAgICAgZW50cnlJZDogZS5pZCxcbiAgICAgIH0pO1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3QgcmVhbERpciA9IGRpcm5hbWUocmVhbE9yKGQub3JpZ2luYWwpKTtcbiAgICAgIGlmIChcbiAgICAgICAgIXJvb3RzLnNvbWUoKHIpID0+IHIud2F0Y2ggPT09IHJlYWxEaXIgJiYgci5yZWN1cnNpdmUgPT09IGZhbHNlKSAmJlxuICAgICAgICAhcm9vdHMuc29tZShcbiAgICAgICAgICAocikgPT4gci5yZWN1cnNpdmUgJiYgKHJlYWxEaXIgPT09IHIud2F0Y2ggfHwgcmVhbERpci5zdGFydHNXaXRoKHIud2F0Y2ggKyBzZXApKSxcbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgICByb290cy5wdXNoKHsgcGF0aDogcmVhbERpciwgd2F0Y2g6IHJlYWxEaXIsIHJlY3Vyc2l2ZTogZmFsc2UgfSk7XG4gICAgfVxuICAgIHJldHVybiByb290cztcbiAgfVxuXG4gIC8vIOKUgOKUgCBwZXJzaXN0ZW5jZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwZXJzaXN0KCk6IHZvaWQge1xuICAgIG1rZGlyU3luYyh0aGlzLmRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGpvaW4odGhpcy5kaXIsIFwibWFuaWZlc3QuanNvblwiKSwgYCR7SlNPTi5zdHJpbmdpZnkodGhpcy5tLCBudWxsLCAyKX1cXG5gKTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVPd25lZChwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBSZW1lbWJlciBCRUZPUkUgd3JpdGluZzogdGhlIHdhdGNoZXIncyBldmVudCBjYW4gYXJyaXZlIGJlZm9yZSB0aGlzXG4gICAgLy8gZnVuY3Rpb24gcmV0dXJucywgYW5kIGl0IG11c3QgZmluZCB0aGUgaGFzaCBhbHJlYWR5IHRoZXJlLlxuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBhZG9wdEFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHAgPSB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICB0aGlzLm93bmVkLnNldChwLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZUFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgLyoqIEtlZXAgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gYXMgYSBORVcgYWdlbnQgdmVyc2lvbi4gKi9cbiAgcHJpdmF0ZSBwcmVzZXJ2ZU91dHNpZGUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiBWZXJzaW9uIHtcbiAgICBjb25zdCBuID0gdGhpcy50YWtlVmVyc2lvbihkKTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgZnJvbTogZC5hY3RpdmUsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBsYWJlbDogYG91dHNpZGUgd3JpdGUgdG8gdiR7ZC5hY3RpdmV9YCxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbikgfTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmZiBgdGV4dGAgYXQgYHBhdGhgIGlzIGV4YWN0bHkgd2hhdCB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgdGhlcmUuICovXG4gIGlzT3duV3JpdGUocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5vd25lZC5nZXQocGF0aCkgPT09IGNvbnRlbnRIYXNoKHRleHQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbnRleHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkQ29udGV4dChyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBDb250ZXh0RW50cnk7IGFkZGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgY29uc3QgcHJvYmUgPSBlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCk7XG4gICAgY29uc3Qgc2FtZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5yb290ID09PSBwcm9iZS5yb290ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gcHJvYmUubWVtYmVyc2hpcCAmJlxuICAgICAgICAocHJvYmUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiIHx8XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgPT09IEpTT04uc3RyaW5naWZ5KHByb2JlLm5vZGVzKSksXG4gICAgKTtcbiAgICBpZiAoc2FtZSkgcmV0dXJuIHsgZW50cnk6IHNhbWUsIGFkZGVkOiBmYWxzZSB9O1xuICAgIHRoaXMubS5jb250ZXh0LnB1c2gocHJvYmUpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IHByb2JlLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIEFuIGVudHJ5J3Mgcm9vdCBwYXRoLCBzbyBFNjAgY2FuIHB1dCBiYWNrIGEgY29udGV4dCBlbnRyeSBpdCByZW1vdmVkLiAqL1xuICBlbnRyeVJvb3QoaWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dC5maW5kKChlKSA9PiBlLmlkID09PSBpZCk/LnJvb3QgPz8gbnVsbDtcbiAgfVxuXG4gIHJlbW92ZUNvbnRleHQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGkgPSB0aGlzLm0uY29udGV4dC5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgICBpZiAoaSA8IDApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKChlKSA9PiBlLmlkKSxcbiAgICAgICk7XG4gICAgdGhpcy5tLmNvbnRleHQuc3BsaWNlKGksIDEpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBvcGVuIGRvY3VtZW50IGxlZnQgdGhlIGNvbnRleHQgKGl0cyBlbnRyeSByZW1vdmVkLCBvciB0aGUgZG9jdW1lbnRcbiAgICogaGlkZGVuKTogY2xvc2UgaXQgaW4gdGhlIHZpZXcuIEl0cyB2ZXJzaW9ucyBzdGF5IGluIHRoZSBzZXNzaW9uIOKAlCBub3RoaW5nXG4gICAqIGlzIGRlbGV0ZWQg4oCUIGFuZCBicmluZ2luZyBpdCBiYWNrIGFuZCBvcGVuaW5nIGl0IGFnYWluIGZpbmRzIHRoZW0uXG4gICAqL1xuICBwcml2YXRlIGNsb3NlT3JwaGFuZWRPcGVuRG9jKCk6IHZvaWQge1xuICAgIGNvbnN0IG9wZW4gPSB0aGlzLm0ub3BlbkRvYyA/IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIGlmIChvcGVuICYmIG9wZW4uZW50cnlJZCA9PT0gbnVsbCkgdGhpcy5tLm9wZW5Eb2MgPSBudWxsO1xuICB9XG5cbiAgLyoqIFJlLW1pcnJvciBhIGZvbGRlciBlbnRyeS4gUmV0dXJucyB3aGV0aGVyIGl0cyBub2RlcyBjaGFuZ2VkLiAqL1xuICByZXNjYW4oZW50cnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmIChlPy5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGUucm9vdCwgTUlSUk9SX05PREVfQ0FQLCBlLmhpZGRlbik7XG4gICAgY29uc3QgY2hhbmdlZCA9XG4gICAgICBKU09OLnN0cmluZ2lmeShub2RlcykgIT09IEpTT04uc3RyaW5naWZ5KGUubm9kZXMpIHx8ICEhdHJ1bmNhdGVkICE9PSAhIWUudHJ1bmNhdGVkO1xuICAgIGUubm9kZXMgPSBub2RlcztcbiAgICBpZiAodHJ1bmNhdGVkKSBlLnRydW5jYXRlZCA9IHRydWU7XG4gICAgZWxzZSBkZWxldGUgZS50cnVuY2F0ZWQ7XG4gICAgaWYgKGNoYW5nZWQpIHRoaXMucmVsaW5rKCk7XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG4gIH1cblxuICBwcml2YXRlIHJlbGluaygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBkLm9yaWdpbmFsKTtcbiAgICAgIGQuZW50cnlJZCA9IGF0Py5lbnRyeUlkID8/IG51bGw7XG4gICAgICBkLnJlbCA9IGF0Py5yZWwgPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgZG9jdW1lbnRzIGFuZCB2ZXJzaW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIHZlcnNpb25QYXRoKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRvY3NEaXIsIGQuc2x1ZywgYHYke259JHtkLmV4dH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgZG9jT3JEaWUoc2x1Zz86IHN0cmluZyk6IERvY1JlY29yZCB7XG4gICAgY29uc3Qgd2FudCA9IHNsdWcgPz8gdGhpcy5tLm9wZW5Eb2MgPz8gdW5kZWZpbmVkO1xuICAgIGNvbnN0IG9wZW5lZCA9IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gZC5zbHVnKTtcbiAgICAvKipcbiAgICAgKiDim5QgV0hFTiBOT1RISU5HIElTIE9QRU4sIFRIRSBPUEVORUQgU0xVR1MgQVJFIEFOIEVNUFRZIExJU1QgQU5EIEFOIEVNUFRZXG4gICAgICogTElTVCBJUyBOT1QgQU4gQU5TV0VSLiBBIGNvbGQgYWdlbnQgbmFtZWQgYSBkb2N1bWVudCBieSBmaWxlbmFtZSBiZWZvcmVcbiAgICAgKiBhbnl0aGluZyB3YXMgb3BlbiBhbmQgZ290IGBjaG9pY2VzOiBbXWAgd2l0aCBubyBoaW50IOKAlCBmcm9tIGEgc2Vzc2lvblxuICAgICAqIHdob3NlIGNvbnRleHQgaGVsZCBleGFjdGx5IHRoZSB0d28gZG9jdW1lbnRzIGl0IGNvdWxkIGhhdmUgbmFtZWQuIFRoZVxuICAgICAqIHJlZnVzYWwgd2FzIGNvcnJlY3QgYW5kIHVzZWxlc3MsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIG1vZGUgYGNob2ljZXNgXG4gICAgICogZXhpc3RzIHRvIHByZXZlbnQuXG4gICAgICpcbiAgICAgKiBTbyBhbiB1bm9wZW5lZCBzZXNzaW9uIG9mZmVycyB0aGUgcGF0aHMgaXQgQ09VTEQgb3BlbiwgYW5kIHNheXMgaG93LiBBXG4gICAgICogZmlsZW5hbWUgb25seSByZXNvbHZlcyBmb3IgYSBkb2N1bWVudCB0aGF0IGlzIGFscmVhZHkgb3BlbjsgYSBwYXRoIGFsd2F5c1xuICAgICAqIG9wZW5zIG9uZS5cbiAgICAgKi9cbiAgICBjb25zdCBjaG9pY2VzID1cbiAgICAgIG9wZW5lZC5sZW5ndGggPiAwID8gb3BlbmVkIDogdGhpcy5tLmNvbnRleHQuZmxhdE1hcCgoZSkgPT4gZG9jUGF0aHMoZSkpLnNsaWNlKDAsIDIwKTtcbiAgICBjb25zdCBoaW50ID1cbiAgICAgIG9wZW5lZC5sZW5ndGggPiAwXG4gICAgICAgID8gdW5kZWZpbmVkXG4gICAgICAgIDogXCJub3RoaW5nIGlzIG9wZW4geWV0IOKAlCBwYXNzIGEgUEFUSCBmcm9tIHRoZSBjb250ZXh0IChhIGZpbGVuYW1lIG9ubHkgcmVzb2x2ZXMgb25jZSBhIGRvY3VtZW50IGlzIG9wZW4pXCI7XG4gICAgaWYgKHdhbnQgPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJubyBkb2N1bWVudCBpcyBvcGVuIOKAlCBuYW1lIG9uZSB3aXRoIC0tZG9jXCIsIDQwOSwgY2hvaWNlcywgaGludCk7XG4gICAgY29uc3QgZCA9IHRoaXMuZmluZERvYyh3YW50KTtcbiAgICBpZiAoIWQpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIGRvY3VtZW50IFwiJHt3YW50fVwiIGluIHRoaXMgc2Vzc2lvbmAsIDQwNCwgY2hvaWNlcywgaGludCk7XG4gICAgcmV0dXJuIGQ7XG4gIH1cblxuICAvKiogQSBkb2MgYnkgc2x1ZywgYnkgb3JpZ2luYWwgcGF0aCwgb3IgYnkgYSB1bmlxdWUgb3JpZ2luYWwgYmFzZW5hbWUuICovXG4gIGZpbmREb2Moa2V5OiBzdHJpbmcpOiBEb2NSZWNvcmQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGJ5U2x1ZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0ga2V5KTtcbiAgICBpZiAoYnlTbHVnKSByZXR1cm4gYnlTbHVnO1xuICAgIC8vIOKblCBPTkxZIEFOIEFCU09MVVRFIGtleSBpcyBhIHBhdGggKHZlcmlmeS1wYXNzIGZpeCA4KTogcmVzb2x2aW5nIGFcbiAgICAvLyByZWxhdGl2ZSBvbmUgaGVyZSByZXNvbHZlZCBpdCBhZ2FpbnN0IHRoZSBEQUVNT04ncyBjd2QuIFRoZSBDTEkgcmVzb2x2ZXNcbiAgICAvLyBhZ2FpbnN0IGl0cyBvd24gY3dkIGFuZCBzZW5kcyBhbiBhYnNvbHV0ZSBwYXRoLlxuICAgIGlmIChpc0Fic29sdXRlKGtleSkpIHtcbiAgICAgIGNvbnN0IGJ5UGF0aCA9IHRoaXMubS5kb2NzLmZpbmQoXG4gICAgICAgIChkKSA9PiBkLm9yaWdpbmFsID09PSBrZXkgfHwgcmVhbE9yKGQub3JpZ2luYWwpID09PSByZWFsT3Ioa2V5KSxcbiAgICAgICk7XG4gICAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIH1cbiAgICBjb25zdCBieU5hbWUgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+IGJhc2VuYW1lKGQub3JpZ2luYWwpID09PSBrZXkgfHwgZC5yZWwgPT09IGtleSk7XG4gICAgcmV0dXJuIGJ5TmFtZS5sZW5ndGggPT09IDEgPyBieU5hbWVbMF0gOiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogVGhlIG5leHQgdmVyc2lvbiBudW1iZXIsIGNvbnN1bWVkLiBOdW1iZXJzIGFyZSBuZXZlciByZXVzZWQgKEU0MSkuICovXG4gIHByaXZhdGUgdGFrZVZlcnNpb24oZDogRG9jUmVjb3JkKTogbnVtYmVyIHtcbiAgICBjb25zdCBuID0gZC5uZXh0VmVyc2lvbiA/PyBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGQubmV4dFZlcnNpb24gPSBuICsgMTtcbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIHByaXZhdGUgdmVyc2lvbk9yRGllKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4ge1xuICAgIGNvbnN0IHYgPSBkLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubiA9PT0gbik7XG4gICAgaWYgKCF2KVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gdiR7bn1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIGQudmVyc2lvbnMubWFwKCh4KSA9PiBgdiR7eC5ufWApLFxuICAgICAgKTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHByaXZhdGUgc2x1Z0ZvcihvcmlnaW5hbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzdGVtID1cbiAgICAgIGJhc2VuYW1lKG9yaWdpbmFsLCBleHRuYW1lKG9yaWdpbmFsKSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05Xy1dKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIikgfHwgXCJkb2NcIjtcbiAgICBsZXQgc2x1ZyA9IHN0ZW07XG4gICAgZm9yIChsZXQgaSA9IDI7IHRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gc2x1Zyk7IGkrKykgc2x1ZyA9IGAke3N0ZW19LSR7aX1gO1xuICAgIHJldHVybiBzbHVnO1xuICB9XG5cbiAgLyoqXG4gICAqIE9wZW4gYSBkb2N1bWVudCBieSBpdHMgb3JpZ2luYWwncyBwYXRoOiB2MSBpcyB3cml0dGVuIGZyb20gdGhlIG9yaWdpbmFsXG4gICAqIHRoZSBmaXJzdCB0aW1lLiBgZm9jdXM6IGZhbHNlYCAodGhlIGFnZW50J3MgaW1wbGljaXQgb3BlbiB0aHJvdWdoXG4gICAqIGB2ZXJzaW9uLW5ldyAtLWRvYyA8cGF0aD5gKSBkb2VzIG5vdCBtb3ZlIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMWIg4oCUIEFETUlTU0lPTi4gT25seSBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiBlbnRyeSBpcyBhZG1pdHRlZDsgYGNvbnRleHQuYWRkYCBzdGF5cyB0aGUgb25lIHdheSBpbi4gQmVmb3JlIHRoaXMsIGFueVxuICAgKiBwYXRoIG9mIGFueSB0eXBlIHdhcyBvcGVuZWQsIGFuZCBTYXZlIHRoZW4gd3JvdGUgaXQ6IGEgZm9yZWlnbiB3ZWIgcGFnZVxuICAgKiB3cm90ZSBgY3VybCBldmlsIHwgc2hgIGludG8gYSBgLnJjYCBmaWxlIG91dHNpZGUgdGhlIGNvbnRleHQuXG4gICAqL1xuICBvcGVuUGF0aChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgZm9jdXM/OiBib29sZWFuIH0gPSB7fSk6IHsgc2x1Zzogc3RyaW5nOyBjcmVhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGZvY3VzID0gb3B0cy5mb2N1cyA/PyB0cnVlO1xuICAgIC8vIFRoZSBjb250ZXh0J3Mgb3duIHNwZWxsaW5nIG9mIHRoZSBwYXRoOiBhIGNhbGxlciB3aG9zZSBjd2QgaXMgYSByZWFscGF0aFxuICAgIC8vICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgb3IgdGhyb3VnaCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAgLy8gZmlsZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBkb2MuXG4gICAgY29uc3QgYWJzID0gdGhpcy5jYW5vbmljYWwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBhYnMpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGV4aXN0aW5nLnNsdWc7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IHNsdWc6IGV4aXN0aW5nLnNsdWcsIGNyZWF0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmICghaXNEb2NOYW1lKGFicykpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCA0MDApO1xuICAgIGlmICghbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7YWJzfSBpcyBub3QgaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dCDigJQgYWRkIGl0IChvciBpdHMgZm9sZGVyKSBmaXJzdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSBmaWxlXCIpO1xuICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBvcGVuICR7YWJzfTogbm8gc3VjaCBmaWxlYCwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgZXh0ID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0uaW5jbHVkZXMoZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKCkpXG4gICAgICA/IGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpXG4gICAgICA6IFwiLm1kXCI7XG4gICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicyk7XG4gICAgY29uc3QgZDogRG9jUmVjb3JkID0ge1xuICAgICAgc2x1ZzogdGhpcy5zbHVnRm9yKGFicyksXG4gICAgICBuYW1lOiBiYXNlbmFtZShhYnMpLFxuICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgIGVudHJ5SWQ6IGF0Py5lbnRyeUlkID8/IG51bGwsXG4gICAgICByZWw6IGF0Py5yZWwgPz8gbnVsbCxcbiAgICAgIGV4dCxcbiAgICAgIHZlcnNpb25zOiBbeyBuOiAxLCBhdXRob3I6IFwiaHVtYW5cIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH1dLFxuICAgICAgYWN0aXZlOiAxLFxuICAgICAgb3JpZ2luYWxIYXNoOiBjb250ZW50SGFzaCh0ZXh0KSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFkbWl0dGVkOiB0cnVlLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MucHVzaChkKTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBkLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBjcmVhdGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogYGFic2AgYXMgdGhlIGNvbnRleHQgc3BlbGxzIGl0LCB3aGVuIGl0IGlzIHRoZSBzYW1lIGZpbGUgYnkgcmVhbHBhdGguICovXG4gIHByaXZhdGUgY2Fub25pY2FsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAoIXJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3BlbGxlZCA9IGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgc3BlbGxlZCkpIHJldHVybiBzcGVsbGVkO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgb3BlblNsdWcoc2x1Zzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLmRvY09yRGllKHNsdWcpLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICByZWFkVmVyc2lvbihzbHVnOiBzdHJpbmcsIG46IG51bWJlcik6IHsgdGV4dDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgbik7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgcmV0dXJuIHsgdGV4dDogcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSwgcGF0aCB9O1xuICB9XG5cbiAgYWN0aXZlUGF0aChzbHVnPzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgZCA9IHNsdWcgPyB0aGlzLmZpbmREb2Moc2x1ZykgOiB0aGlzLm0ub3BlbkRvYyA/IHRoaXMuZmluZERvYyh0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIGQgPyB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSA6IG51bGw7XG4gIH1cblxuICAvKiogVGhlIGh1bWFuJ3MgYnVmZmVyIHJlYWNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uJ3MgZmlsZSAoZGVib3VuY2VkIGJ5IHRoZSBzdXJmYWNlKS4gKi9cbiAgLyoqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggNCDigJQgQ0hFQ0sgQkVGT1JFIFdSSVRFLiBCZWZvcmUgdGhlIGh1bWFuJ3MgZWRpdCBpc1xuICAgKiB3cml0dGVuLCB0aGUgZmlsZSBvbiBkaXNrIGlzIGhhc2hlZDogaWYgaXQgaXMgbm90IHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgKiB3cml0ZSwgc29tZW9uZSBlbHNlIHdyb3RlIHRoZSBhY3RpdmUgdmVyc2lvbiAoRTIpLiBUaGF0IHRleHQgaXMga2VwdCBhcyBhXG4gICAqIE5FVyBhZ2VudCB2ZXJzaW9uLCBhbmQgb25seSB0aGVuIGlzIHRoZSBlZGl0IHdyaXR0ZW4uIERldGVjdGlvbiB1c2VkIHRvXG4gICAqIGRlcGVuZCBvbiB0aGUgd2F0Y2hlcidzIDYwIG1zIHNldHRsZSB0aW1lciBmaXJpbmcgYmVmb3JlIHRoZSBuZXh0XG4gICAqIGtleXN0cm9rZTsgYSBidXJzdCBvZiBlZGl0cyBhdCAzMCBtcyBjbG9iYmVyZWQgYW4gb3V0c2lkZSB3cml0ZVxuICAgKiB1bmFubm91bmNlZC4gTm93IG5vdGhpbmcgaXMgbG9zdCB3aGF0ZXZlciB0aGUgdGltaW5nIOKAlCB0aGUgb25lIHdpbmRvdyBsZWZ0XG4gICAqIGlzIHRoZSBtaWNyb3NlY29uZHMgYmV0d2VlbiB0aGlzIHJlYWQgYW5kIHRoaXMgd3JpdGUuXG4gICAqL1xuICBlZGl0KFxuICAgIHNsdWc6IHN0cmluZyxcbiAgICBuOiBudW1iZXIsXG4gICAgdGV4dDogc3RyaW5nLFxuICApOiB7IGRpcnR5Q2hhbmdlZDogYm9vbGVhbjsgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbCB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBpZiAobiAhPT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7bn0gaXMgbm90IHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30gKHYke2QuYWN0aXZlfSBpcykg4oCUIG9ubHkgdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIGVkaXRhYmxlYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSB0aGlzLmlzRGlydHkoZCk7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgLy8gVGhlIGVkaXQgaXMgc3RhZ2VkIGluIGEgc2libGluZyBmaWxlIEZJUlNULCBzbyB0aGUgY2hlY2sgYmVsb3cgYW5kIHRoZVxuICAgIC8vIHJlbmFtZSB0aGF0IGxhbmRzIHRoZSBlZGl0IGFyZSBhZGphY2VudCBzeXNjYWxsczogdGhlIHdpbmRvdyBpbiB3aGljaCBhblxuICAgIC8vIG91dHNpZGUgd3JpdGUgY291bGQgc2xpcCBiZXR3ZWVuIHRoZW0gaXMgbWljcm9zZWNvbmRzLCBub3QgdGhlIGxlbmd0aCBvZlxuICAgIC8vIGEgbXVsdGktbWVnYWJ5dGUgd3JpdGUg4oCUIGFuZCBhIHdyaXRlIGxhbmRpbmcgQUZURVIgdGhlIHJlbmFtZSBnb2VzIHRvIHRoZVxuICAgIC8vIG5ldyBmaWxlLCB3aGVyZSB0aGUgd2F0Y2hlciBmaW5kcyBpdCBhbmQgcHJlc2VydmVzIGl0IHRvby5cbiAgICBjb25zdCBzdGFnZWQgPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS5lZGl0YDtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YWdlZCwgdGV4dCk7XG4gICAgbGV0IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgPSBudWxsO1xuICAgIGxldCBvbkRpc2s6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBvbkRpc2sgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgb25EaXNrID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKG9uRGlzayAhPT0gbnVsbCAmJiAhdGhpcy5pc093bldyaXRlKHBhdGgsIG9uRGlzaykpXG4gICAgICBwcmVzZXJ2ZWQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCBvbkRpc2spO1xuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICByZW5hbWVTeW5jKHN0YWdlZCwgcGF0aCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICAgIHJldHVybiB7IGRpcnR5Q2hhbmdlZDogYmVmb3JlICE9PSB0aGlzLmlzRGlydHkoZCksIHByZXNlcnZlZCB9O1xuICB9XG5cbiAgLyoqIENvcHkgYSB2ZXJzaW9uIHRvIGEgbmV3IGZpbGU7IHRoZSBhZ2VudCB0aGVuIGVkaXRzIHRoYXQgZmlsZSB3aXRoIGl0cyBvd24gdG9vbHMuICovXG4gIG5ld1ZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IGZyb20/OiBudW1iZXI7IGxhYmVsPzogc3RyaW5nOyBhdXRob3I6IFZlcnNpb25BdXRob3IgfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogVmVyc2lvbjtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IGZyb20gPSBvcHRzLmZyb20gPz8gZC5hY3RpdmU7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgZnJvbSk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGZyb20pLCBcInV0ZjhcIik7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IG9wdHMuYXV0aG9yLFxuICAgICAgZnJvbSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIC4uLihvcHRzLmxhYmVsID8geyBsYWJlbDogb3B0cy5sYWJlbCB9IDoge30pLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgdmVyc2lvbjogeyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbikgfSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSBhIHZlcnNpb24gYW5kIGl0cyBmaWxlIChFNDEpLlxuICAgKlxuICAgKiDim5QgVEhFIEFDVElWRSBWRVJTSU9OIENBTk5PVCBCRSBERUxFVEVELCBhbmQgcmVmdXNpbmcgaXMgYmV0dGVyIHRoYW5cbiAgICogcGlja2luZyBhIHJlcGxhY2VtZW50OiBjaG9vc2luZyBvbmUgZm9yIHRoZSBodW1hbiB3b3VsZCBzaWxlbnRseSBtb3ZlXG4gICAqIHdoZXJlIHRoZWlyIGVkaXRzIGFuZCBTYXZlIGFyZSBwb2ludGVkLCB3aGljaCBpcyB0aGUgb25lIHRoaW5nIEUyIGFuZCBFN1xuICAgKiBleGlzdCB0byBrZWVwIGV4cGxpY2l0LiBCZWNhdXNlIGV4YWN0bHkgb25lIHZlcnNpb24gaXMgYWx3YXlzIGFjdGl2ZSwgdGhpc1xuICAgKiBhbHNvIG1lYW5zIHRoZSBsYXN0IHZlcnNpb24gY2FuIG5ldmVyIGJlIGRlbGV0ZWQg4oCUIGEgZG9jdW1lbnQgYWx3YXlzIGhhc1xuICAgKiBzb21ldGhpbmcgdG8gZWRpdCwgd2l0aG91dCB0aGF0IGJlaW5nIGEgc2Vjb25kIHJ1bGUuXG4gICAqXG4gICAqIGBmcm9tYCBwb2ludGVycyBvbiBPVEhFUiB2ZXJzaW9ucyBhcmUgbGVmdCBhcyB0aGV5IGFyZS4gXCJNYWRlIGZyb20gdjJcIlxuICAgKiBzdGF5cyB0cnVlIGFmdGVyIHYyIGlzIGdvbmU7IGRlbGV0aW5nIGEgdmVyc2lvbiBpcyBub3QgcmV3cml0aW5nIHRoZVxuICAgKiBoaXN0b3J5IG9mIHRoZSBvbmVzIHRoYXQgcmVtYWluLlxuICAgKi9cbiAgZGVsZXRlVmVyc2lvbihvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IG51bWJlcjtcbiAgICBsYWJlbD86IHN0cmluZztcbiAgICByZW1haW5pbmc6IG51bWJlcjtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHYgPSB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGlmIChvcHRzLnZlcnNpb24gPT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke29wdHMudmVyc2lvbn0gaXMgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSDigJQgYWN0aXZhdGUgYW5vdGhlciBvbmUgZmlyc3QsIGAgK1xuICAgICAgICAgIGB0aGVuIGRlbGV0ZSB0aGlzYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICAvLyDim5QgTUFURVJJQUxJU0UgVEhFIENPVU5URVIgQkVGT1JFIFJFTU9WSU5HIFRIRSBSRUNPUkQuIGB0YWtlVmVyc2lvbmBcbiAgICAvLyBkZXJpdmVzIGl0IGxhemlseSBmcm9tIHRoZSB2ZXJzaW9ucyBQUkVTRU5ULCBzbyBvbiBhIGRvYyB0aGF0IGhhcyBuZXZlclxuICAgIC8vIGFsbG9jYXRlZCBvbmUgKGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgRTQxLCByZXN0b3JlZCkgZGVsZXRpbmcgdGhlXG4gICAgLy8gaGlnaGVzdCB3b3VsZCBsZXQgdGhlIG5leHQgYWxsb2NhdGlvbiBkZXJpdmUgdGhlIHNhbWUgbnVtYmVyIGFnYWluLiBGb3VuZFxuICAgIC8vIGJ5IGRyaXZpbmcgaXQsIG5vdCBieSB0aGUgdW5pdCB0ZXN0IGFib3ZlIOKAlCB3aGljaCBhbGxvY2F0ZWQgZmlyc3QgYW5kIHNvXG4gICAgLy8gbmV2ZXIgaGFkIGEgY29sZCBjb3VudGVyLlxuICAgIGQubmV4dFZlcnNpb24gPz89IE1hdGgubWF4KC4uLmQudmVyc2lvbnMubWFwKCh4KSA9PiB4Lm4pKSArIDE7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBkLnZlcnNpb25zID0gZC52ZXJzaW9ucy5maWx0ZXIoKHgpID0+IHgubiAhPT0gb3B0cy52ZXJzaW9uKTtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHBhdGgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVGhlIHJlY29yZCBpcyB3aGF0IHRoZSBzZXNzaW9uIGJlbGlldmVzOyBhIGZpbGUgYWxyZWFkeSBnb25lIChhIGhhbmRcbiAgICAgIC8vIHRpZHksIGEgY3Jhc2ggYmV0d2VlbiB3cml0ZSBhbmQgcmVjb3JkKSBtdXN0IG5vdCBibG9jayByZW1vdmluZyBpdC5cbiAgICB9XG4gICAgdGhpcy5vd25lZC5kZWxldGUocGF0aCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIHZlcnNpb246IG9wdHMudmVyc2lvbixcbiAgICAgIC4uLih2LmxhYmVsID8geyBsYWJlbDogdi5sYWJlbCB9IDoge30pLFxuICAgICAgcmVtYWluaW5nOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICB9O1xuICB9XG5cbiAgYWN0aXZhdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KTogeyBzbHVnOiBzdHJpbmc7IHByZXZpb3VzOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG9wdHMudmVyc2lvbik7XG4gICAgY29uc3QgcHJldmlvdXMgPSBkLmFjdGl2ZTtcbiAgICBkLmFjdGl2ZSA9IG9wdHMudmVyc2lvbjtcbiAgICAvLyBUaGUgbmV3IGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBBUyBJVCBJUyBOT1cgaXMgdGhlIGJhc2VsaW5lIHRoZSBuZXh0XG4gICAgLy8gY2hlY2stYmVmb3JlLXdyaXRlIGNvbXBhcmVzIGFnYWluc3QuXG4gICAgdGhpcy5hZG9wdEFjdGl2ZShkLCByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKSk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBwcmV2aW91cyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbXBhcmluZyBhbmQgbWVyZ2luZyAoRTM2KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogVGhlIHRleHQgb2Ygb25lIHNpZGUgb2YgYSBjb21wYXJpc29uLiBgXCJvcmlnaW5hbFwiYCBpcyByZWFkIGZyb20gRElTSywgbm90XG4gICAqIGZyb20gYSBjYWNoZTogdGhlIHdob2xlIHBvaW50IG9mIGNvbXBhcmluZyBhZ2FpbnN0IGl0IGlzIHRvIHNlZSB3aGF0IHRoZVxuICAgKiBmaWxlIG9mIHJlY29yZCBhY3R1YWxseSBzYXlzIHJpZ2h0IG5vdywgaW5jbHVkaW5nIGEgY2hhbmdlIHNvbWVvbmUgZWxzZVxuICAgKiBtYWRlIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgb3Blbi5cbiAgICovXG4gIHByaXZhdGUgc2lkZVRleHQoZDogRG9jUmVjb3JkLCBzaWRlOiBEaWZmU2lkZSk6IHN0cmluZyB7XG4gICAgaWYgKHNpZGUgPT09IFwib3JpZ2luYWxcIikgcmV0dXJuIHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgc2lkZSk7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIHNpZGUpLCBcInV0ZjhcIik7XG4gIH1cblxuICAvKiogQ29tcGFyZSB0aGUgQUNUSVZFIHZlcnNpb24gKGxlZnQpIGFnYWluc3QgYW5vdGhlciBzaWRlIChyaWdodCkuICovXG4gIGNvbXBhcmUob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlIH0pOiBEaWZmUGF5bG9hZCB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGlmIChvcHRzLmFnYWluc3QgPT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke2QuYWN0aXZlfSBpcyB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9IOKAlCBjb21wYXJpbmcgaXQgd2l0aCBpdHNlbGYgc2F5cyBub3RoaW5nYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBsZWZ0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCxcbiAgICAgIGRpZmY6IGRpZmZUZXh0KGxlZnQsIHRoaXMuc2lkZVRleHQoZCwgb3B0cy5hZ2FpbnN0KSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIG5hbWVkIGh1bmtzIGZyb20gYGFnYWluc3RgIGludG8gdGhlIGFjdGl2ZSB2ZXJzaW9uLlxuICAgKlxuICAgKiDim5QgVEhFIFdSSVRFIEdPRVMgVEhST1VHSCBgZWRpdGAsIHdoaWNoIGlzIHdoYXQgbWFrZXMgYSBtZXJnZSBvYmV5IGV2ZXJ5XG4gICAqIHJ1bGUgYW4gb3JkaW5hcnkga2V5c3Ryb2tlIG9iZXlzOiBpdCBsYW5kcyBvbiB0aGUgYWN0aXZlIHZlcnNpb24gYW5kIG5ldmVyXG4gICAqIHRoZSBvcmlnaW5hbCAoRTcpLCBhbmQgY2hlY2stYmVmb3JlLXdyaXRlIHByZXNlcnZlcyBhbiBvdXRzaWRlIHdyaXRlIGFzIGFcbiAgICogbmV3IHZlcnNpb24gZmlyc3QgKEUyKS4gQSBtZXJnZSB3cml0aW5nIHRoZSBmaWxlIGRpcmVjdGx5IHdvdWxkIGJlIHRoZSBvbmVcbiAgICogcGF0aCBpbnRvIHRoZSBkb2N1bWVudCB0aGF0IGNvdWxkIHNpbGVudGx5IGNsb2JiZXIgdGhlIGFnZW50LlxuICAgKi9cbiAgbWVyZ2Uob3B0czogeyBkb2M/OiBzdHJpbmc7IGFnYWluc3Q6IERpZmZTaWRlOyBodW5rczogbnVtYmVyW10gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogbnVtYmVyO1xuICAgIHRleHQ6IHN0cmluZztcbiAgICBhcHBsaWVkOiBudW1iZXI7XG4gICAgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbDtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBheWxvYWQgPSB0aGlzLmNvbXBhcmUoeyBkb2M6IGQuc2x1ZywgYWdhaW5zdDogb3B0cy5hZ2FpbnN0IH0pO1xuICAgIGNvbnN0IGtub3duID0gbmV3IFNldChwYXlsb2FkLmRpZmYuaHVua3MubWFwKChoKSA9PiBoLmlkKSk7XG4gICAgY29uc3QgbWlzc2luZyA9IG9wdHMuaHVua3MuZmlsdGVyKChpZCkgPT4gIWtub3duLmhhcyhpZCkpO1xuICAgIGlmIChtaXNzaW5nLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIGh1bmsgJHttaXNzaW5nLmpvaW4oXCIsIFwiKX0gYWdhaW5zdCAke3NpZGVOYW1lKG9wdHMuYWdhaW5zdCwgZC5uYW1lKX0g4oCUIGAgK1xuICAgICAgICAgIGBpdCBoYXMgJHtrbm93bi5zaXplID09PSAwID8gXCJub25lXCIgOiBgMS4uJHtNYXRoLm1heCguLi5rbm93bil9YH0uIFJ1biBkaWZmIGFnYWluOiBgICtcbiAgICAgICAgICBgdGhlIHRleHQgY2hhbmdlZCB1bmRlciB0aGUgbnVtYmVycy5gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHRleHQgPSBhcHBseUh1bmtzKGJlZm9yZSwgcGF5bG9hZC5kaWZmLmh1bmtzLCBvcHRzLmh1bmtzKTtcbiAgICBjb25zdCB7IHByZXNlcnZlZCB9ID0gdGhpcy5lZGl0KGQuc2x1ZywgZC5hY3RpdmUsIHRleHQpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIHRleHQsXG4gICAgICBhcHBsaWVkOiBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+IGtub3duLmhhcyhpZCkpLmxlbmd0aCxcbiAgICAgIHByZXNlcnZlZCxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIG5vdGVzIChFNDUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBUaGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IGV2ZXJ5IG5vdGUgaXMgYW5jaG9yZWQgYWdhaW5zdC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVUZXh0KGQ6IERvY1JlY29yZCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIFBsYWNlIGV2ZXJ5IG5vdGUgaW4gdGhlIGFjdGl2ZSB0ZXh0IGFzIGl0IHN0YW5kcyBub3cuICovXG4gIHByaXZhdGUgcGxhY2VkTm90ZXMoZDogRG9jUmVjb3JkKTogUGxhY2VkTm90ZVtdIHtcbiAgICBjb25zdCBub3RlcyA9IGQubm90ZXMgPz8gW107XG4gICAgaWYgKG5vdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmFjdGl2ZVRleHQoZCk7XG4gICAgcmV0dXJuIG5vdGVzLm1hcCgobikgPT4gKHsgLi4ubiwgLi4uZmluZEFuY2hvcih0ZXh0LCBuKSB9KSk7XG4gIH1cblxuICAvKipcbiAgICogTm90ZSBhIHJhbmdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgKHRoZSBodW1hbiBzZWxlY3RzKSBvciBhIHF1b3RlXG4gICAqIGZvdW5kIGluIGl0ICh0aGUgYWdlbnQgcXVvdGVzIOKAlCBpdCBoYXMgbm8gb2Zmc2V0cykuXG4gICAqL1xuICBhZGROb3RlKG9wdHM6IHtcbiAgICBkb2M/OiBzdHJpbmc7XG4gICAgYm9keTogc3RyaW5nO1xuICAgIHdobzogVmVyc2lvbkF1dGhvcjtcbiAgICByYW5nZT86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07XG4gICAgcXVvdGU/OiBzdHJpbmc7XG4gIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZTsgaG93OiBcInNlbGVjdGlvblwiIHwgXCJxdW90ZVwiIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBib2R5ID0gb3B0cy5ib2R5LnRyaW0oKTtcbiAgICBpZiAoIWJvZHkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJhIG5vdGUgbmVlZHMgc29tZXRoaW5nIHdyaXR0ZW4gaW4gaXRcIiwgNDAwKTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuXG4gICAgbGV0IGFuY2hvcjogQW5jaG9yO1xuICAgIGlmIChvcHRzLnJhbmdlKSB7XG4gICAgICBjb25zdCB7IGZyb20sIHRvIH0gPSBvcHRzLnJhbmdlO1xuICAgICAgaWYgKGZyb20gPCAwIHx8IHRvID4gdGV4dC5sZW5ndGggfHwgZnJvbSA+PSB0bylcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgJHtmcm9tfS4uJHt0b30gaXMgbm90IGEgcmFuZ2UgaW4gdiR7ZC5hY3RpdmV9IG9mICR7ZC5zbHVnfSAoJHt0ZXh0Lmxlbmd0aH0gY2hhcmFjdGVycylgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGZyb20sIHRvKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcXVvdGUgPSBvcHRzLnF1b3RlID8/IFwiXCI7XG4gICAgICBpZiAoIXF1b3RlKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIGEgc2VsZWN0aW9uIG9yIGEgcXVvdGVcIiwgNDAwKTtcbiAgICAgIGNvbnN0IGF0ID0gdGV4dC5pbmRleE9mKHF1b3RlKTtcbiAgICAgIC8vIOKblCBSRUZVU0VELCBub3QgYW5jaG9yZWQgaG9wZWZ1bGx5LiBBIHF1b3RlIHRoZSBhY3RpdmUgdmVyc2lvbiBkb2VzIG5vdFxuICAgICAgLy8gY29udGFpbiB3b3VsZCBiZWNvbWUgYW4gb3JwaGFuIHRoZSBtb21lbnQgaXQgd2FzIG1hZGUsIHdoaWNoIHJlYWRzIGFzXG4gICAgICAvLyBcInRoZSB0ZXh0IGNoYW5nZWRcIiB3aGVuIHRoZSB0cnV0aCBpcyBcInlvdSBxdW90ZWQgc29tZXRoaW5nIGVsc2VcIi5cbiAgICAgIGlmIChhdCA9PT0gLTEpXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gZG9lcyBub3QgY29udGFpbiB0aGF0IHRleHQg4oCUIHF1b3RlIGl0IGV4YWN0bHkgYXMgaXQgYXBwZWFyc2AsXG4gICAgICAgICAgNDA0LFxuICAgICAgICApO1xuICAgICAgYW5jaG9yID0gYW5jaG9yT2YodGV4dCwgYXQsIGF0ICsgcXVvdGUubGVuZ3RoKTtcbiAgICB9XG5cbiAgICBjb25zdCBub3RlOiBOb3RlID0ge1xuICAgICAgaWQ6IGBuJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDYpfWAsXG4gICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgIC4uLmFuY2hvcixcbiAgICAgIGJvZHksXG4gICAgICB3aG86IG9wdHMud2hvLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgcmVzb2x2ZWQ6IGZhbHNlLFxuICAgIH07XG4gICAgZC5ub3RlcyA9IFsuLi4oZC5ub3RlcyA/PyBbXSksIG5vdGVdO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSwgaG93OiBvcHRzLnJhbmdlID8gXCJzZWxlY3Rpb25cIiA6IFwicXVvdGVcIiB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRvY3VtZW50J3Mgbm90ZXMgYXMgU1RPUkVEIOKAlCBubyBwbGFjZW1lbnQsIHNvIG5vIGZpbGUgcmVhZHMuIEU2NSdzXG4gICAqIGF0dGVudGlvbiB0aWNrIGFza3MgdGhpcyBldmVyeSBzZWNvbmQ7IGB2aWV3KClgIHdvdWxkIHJlLXBsYWNlIGV2ZXJ5IG5vdGUuXG4gICAqL1xuICBub3RlRmFjdHMoKTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiByZWFkb25seSBOb3RlW10gfVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmRvY3MubWFwKChkKSA9PiAoeyBzbHVnOiBkLnNsdWcsIG5vdGVzOiBkLm5vdGVzID8/IFtdIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgbGluZXMgYSBub3RlIGNvdmVycyBpbiB0aGUgYWN0aXZlIHZlcnNpb24gbm93IChFNjUpLCBvciBudWxsIHdoZW4gaXRzXG4gICAqIHRleHQgaXMgZ29uZS4gUGxhY2VkLCBub3QgcmVtZW1iZXJlZCwgZm9yIHRoZSByZWFzb24gbm90ZXMgYXJlIChFNDUpLlxuICAgKi9cbiAgbm90ZUxpbmVzKGRvYzogc3RyaW5nLCBub3RlOiBOb3RlKTogeyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXIgfSB8IG51bGwge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKGRvYyk7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcbiAgICBjb25zdCBhdCA9IGZpbmRBbmNob3IodGV4dCwgbm90ZSk7XG4gICAgcmV0dXJuIGF0LmZyb20gPT09IG51bGwgPyBudWxsIDogbGluZXNPZih0ZXh0LCBhdC5mcm9tLCBhdC50byk7XG4gIH1cblxuICAvKiogTm90ZXMgb24gYSBkb2N1bWVudCwgcGxhY2VkIOKAlCBgYWxsYCBpbmNsdWRlcyB0aGUgcmVzb2x2ZWQgb25lcy4gKi9cbiAgbm90ZXNPZihvcHRzOiB7IGRvYz86IHN0cmluZzsgYWxsPzogYm9vbGVhbiB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiBQbGFjZWROb3RlW10gfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IHBsYWNlZCA9IHRoaXMucGxhY2VkTm90ZXMoZCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3Rlczogb3B0cy5hbGwgPyBwbGFjZWQgOiBwbGFjZWQuZmlsdGVyKChuKSA9PiAhbi5yZXNvbHZlZCkgfTtcbiAgfVxuXG4gIHByaXZhdGUgbm90ZU9yRGllKGQ6IERvY1JlY29yZCwgaWQ6IHN0cmluZyk6IE5vdGUge1xuICAgIGNvbnN0IG5vdGUgPSAoZC5ub3RlcyA/PyBbXSkuZmluZCgobikgPT4gbi5pZCA9PT0gaWQpO1xuICAgIGlmICghbm90ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIG5vdGUgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIChkLm5vdGVzID8/IFtdKS5tYXAoKG4pID0+IG4uaWQpLFxuICAgICAgKTtcbiAgICByZXR1cm4gbm90ZTtcbiAgfVxuXG4gIC8qKiBDaGFuZ2Ugd2hhdCBhIG5vdGUgU0FZUy4gSXRzIGFuY2hvciBpcyB1bnRvdWNoZWQg4oCUIGl0IGlzIHN0aWxsIGFib3V0IHRoZVxuICAgKiAgc2FtZSBwYXNzYWdlLCB3aGljaCBpcyB3aHkgZWRpdGluZyBkb2VzIG5vdCByZS1xdW90ZSAoRTQ2KS4gKi9cbiAgZWRpdE5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmc7IGJvZHk6IHN0cmluZzsgd2hvOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIG5vdGU6IE5vdGU7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgbm90ZS5ib2R5ID0gYm9keTtcbiAgICBub3RlLmVkaXRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAvLyBFNjU6IHdob3NlIHJld3JpdGUgaXQgd2FzIGRlY2lkZXMgd2hldGhlciB0aGUgbm90ZSBpcyBvd2VkIGFuIGFuc3dlci5cbiAgICBub3RlLmVkaXRlZEJ5ID0gb3B0cy53aG87XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZXNvbHZlTm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgcmVzb2x2ZWQ6IGJvb2xlYW4gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbm90ZTogTm90ZTtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IG5vdGUgPSB0aGlzLm5vdGVPckRpZShkLCBvcHRzLmlkKTtcbiAgICBub3RlLnJlc29sdmVkID0gb3B0cy5yZXNvbHZlZDtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIHJlbW92ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmcgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgZC5ub3RlcyA9IChkLm5vdGVzID8/IFtdKS5maWx0ZXIoKG4pID0+IG4uaWQgIT09IG9wdHMuaWQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgLyoqIFNhdmU6IHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgb3ZlciB0aGUgb3JpZ2luYWwuIFRoZSBPTkxZIHdyaXRlIHRvIGl0IChFNykuICovXG4gIHNhdmUoc2x1Zzogc3RyaW5nKTogeyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYzogU2F2ZSB3cml0ZXMgb25seSBhbiBvcmlnaW5hbCBhZG1pdHRlZCBieVxuICAgIC8vIGBvcGVuUGF0aGAgKGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5KS4gQ2hlY2tlZCBhZ2FpbiBoZXJlXG4gICAgLy8gc28gbm8gb3RoZXIgcGF0aCBpbnRvIHRoZSBtYW5pZmVzdCDigJQgYSBoYW5kLWVkaXRlZCBvbmUsIGEgZnV0dXJlIHZlcmIg4oCUXG4gICAgLy8gY2FuIHR1cm4gU2F2ZSBpbnRvIFwid3JpdGUgYW55IGZpbGVcIi5cbiAgICBpZiAoIWQuYWRtaXR0ZWQgfHwgIWlzRG9jTmFtZShkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBzYXZlICR7ZC5vcmlnaW5hbH06IGl0IHdhcyBub3Qgb3BlbmVkIGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICB0aGlzLndyaXRlT3duZWQoZC5vcmlnaW5hbCwgdGV4dCk7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgb3JpZ2luYWw6IGQub3JpZ2luYWwsIHZlcnNpb246IGQuYWN0aXZlIH07XG4gIH1cblxuICAvKiogUmV2ZXJ0OiB0aGUgb3JpZ2luYWwncyB0ZXh0IGJhY2sgb3ZlciB0aGUgYWN0aXZlIHZlcnNpb24uICovXG4gIHJldmVydChzbHVnOiBzdHJpbmcpOiB7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIGlmIChuID09PSBkLmFjdGl2ZSkge1xuICAgICAgICAvLyBFMiwgcmVmdXNlZCBhbmQgUkUtTEFCRUxMRUQ6IHRoZSBvdXRzaWRlIHRleHQgYmVjb21lcyBhIG5ldyBhZ2VudFxuICAgICAgICAvLyB2ZXJzaW9uLCBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uIGdvZXMgYmFjayB0byB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICAgICAgLy8gdGV4dCDigJQgc28gdGhlIGFjdGl2ZSB2ZXJzaW9uIG9ubHkgZXZlciBob2xkcyB3aGF0IHRoZSBodW1hbiB0eXBlZCxcbiAgICAgICAgLy8gYW5kIG5vdGhpbmcgYW55b25lIHdyb3RlIGlzIGxvc3QgKHZlcmlmeS1wYXNzIGZpeCA0LCB3YXRjaGVyIGhhbGYpLlxuICAgICAgICBjb25zdCBrZXB0ID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGhpcy5sYXN0QWN0aXZlVGV4dC5nZXQoZC5zbHVnKSA/PyB0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogbixcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgcHJlc2VydmVkQXM6IGtlcHQubixcbiAgICAgICAgICBwcmVzZXJ2ZWRQYXRoOiBrZXB0LnBhdGgsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCB0ZXh0LCBhY3RpdmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIOKAlCBieSBpdHMgc3RvcmVkIHBhdGgsIG9yIGJ5IHJlYWxwYXRoIGZvciBhIHN5bWxpbms/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyB8fCByZWFsT3IoeC5vcmlnaW5hbCkgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGQub3V0c2lkZUNoYW5nZWQpIHJldHVybiBudWxsOyAvLyBhbHJlYWR5IGFza2VkXG4gICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBzdHJ1Y3R1cmUgKEUyMuKAk0UyNCk6IHJlYWwgY2hhbmdlcyBvbiBkaXNrLCBvbmUgcGF0aCBmb3IgYm90aCBwYXJ0aWVzIOKUgOKUgFxuICAvL1xuICAvLyBFdmVyeSBtZXRob2QgYmVsb3cgZG9lcyB0aGUgY2hhbmdlIE9OIERJU0sgYW5kIHRoZW4gYnJpbmdzIHRoZSBjb250ZXh0XG4gIC8vIG1vZGVsIGJhY2sgaW4gbGluZSB3aXRoIGl0LiBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZW0gdGhyb3VnaCBtZW51cyBhbmRcbiAgLy8gZHJhZyBhbmQgZHJvcCwgdGhlIGFnZW50IHRocm91Z2ggQ0xJIHZlcmJzOyB0aGUgZGFlbW9uIGFubm91bmNlcyBlYWNoIG9uZVxuICAvLyB1bmRlciB0aGUgbmFtZSBvZiB3aG9ldmVyIGRpZCBpdC4gVHdvIHJ1bGVzIGhvbGQgdGhyb3VnaG91dDpcbiAgLy9cbiAgLy8gLSBOT1RISU5HIElTIERFTEVURUQuIGBoaWRlYCB0YWtlcyBhIG5vZGUgb3V0IG9mIFNjcmlwdG9yaXVtOyB0aGUgZmlsZSBzdGF5cy5cbiAgLy8gLSBOT1RISU5HIElTIE9WRVJXUklUVEVOLiBBIGRlc3RpbmF0aW9uIHRoYXQgZXhpc3RzIGlzIHJlZnVzZWQgKGFuIGV4cGxpY2l0XG4gIC8vICAgbmFtZSkgb3IgZ2l2ZW4gYSBmcmVlIG5hbWUgKGEgZGVmYXVsdCBvbmUsIGEgZHJvcCk7IGZpbGVzIGFyZSBjcmVhdGVkXG4gIC8vICAgd2l0aCB0aGUgZXhjbHVzaXZlIGZsYWcsIHNvIGEgcmFjZSBjYW5ub3QgY2xvYmJlciBlaXRoZXIuXG5cbiAgLyoqIEUyMzogd2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQuICovXG4gIGdldCB3b3Jrc3BhY2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLndvcmtzcGFjZSA/PyBob21lZGlyKCk7XG4gIH1cblxuICBzZXRXb3Jrc3BhY2UocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzdWNoIGZvbGRlcjogJHthYnN9YCwgNDA0KTtcbiAgICB9XG4gICAgaWYgKCFpc0RpcikgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGhlIHdvcmtzcGFjZSBtdXN0IGJlIGEgZm9sZGVyOiAke2Fic31gLCA0MDApO1xuICAgIHRoaXMubS53b3Jrc3BhY2UgPSBhYnM7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogSG93IGEgcGF0aCByZWFkcyBpbiBhIGNoYXQgbGluZTogYHNldC9yZWxgIGluc2lkZSBhIHNldCwgYSBzaW5nbGVcbiAgICogZG9jdW1lbnQncyBmaWxlIG5hbWUsIGB3b3Jrc3BhY2Uv4oCmYCBpbiB0aGUgd29ya3NwYWNlLCBlbHNlIGB+L+KApmAuXG4gICAqL1xuICBkaXNwbGF5KGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikge1xuICAgICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBlLmxhYmVsO1xuICAgICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkgcmV0dXJuIGAke2UubGFiZWx9LyR7dG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpfWA7XG4gICAgICB9IGVsc2UgaWYgKGUubm9kZXMuc29tZSgobikgPT4gam9pbihlLnJvb3QsIG4ucmVsKSA9PT0gYWJzKSkgcmV0dXJuIGUubGFiZWw7XG4gICAgfVxuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLndvcmtzcGFjZSArIHNlcCkpXG4gICAgICByZXR1cm4gYHdvcmtzcGFjZS8ke3RvUG9zaXgocmVsYXRpdmUodGhpcy53b3Jrc3BhY2UsIGFicykpfWA7XG4gICAgY29uc3QgaG9tZSA9IGhvbWVkaXIoKTtcbiAgICByZXR1cm4gYWJzID09PSBob21lID8gXCJ+XCIgOiBhYnMuc3RhcnRzV2l0aChob21lICsgc2VwKSA/IGB+JHthYnMuc2xpY2UoaG9tZS5sZW5ndGgpfWAgOiBhYnM7XG4gIH1cblxuICAvKipcbiAgICogYGFic2Agc3BlbGxlZCB0aGUgd2F5IHRoZSBjb250ZXh0IHNwZWxscyBpdC4gQSBjYWxsZXIgd2hvc2UgY3dkIGlzIGFcbiAgICogcmVhbHBhdGggKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAqIHBsYWNlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIG5vZGUuXG4gICAqL1xuICBwcml2YXRlIHNwZWxsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5tLmNvbnRleHQuc29tZSgoZSkgPT4gYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmIChyZWFsID09PSByZWFsUm9vdCkgcmV0dXJuIGUucm9vdDtcbiAgICAgIGlmIChyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSByZXR1cm4gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBwcml2YXRlIGlzV29ya3NwYWNlKGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGFicyA9PT0gdGhpcy53b3Jrc3BhY2UgfHwgcmVhbE9yKGFicykgPT09IHJlYWxPcih0aGlzLndvcmtzcGFjZSk7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIGVudHJ5IHRoYXQgY292ZXJzIGBhYnNgIChpdHMgcm9vdCwgb3IgYW55dGhpbmcgdW5kZXIgaXQpLCBpZiBhbnkuICovXG4gIHByaXZhdGUgY292ZXJpbmdFbnRyeShhYnM6IHN0cmluZywgZXhjZXB0Pzogc3RyaW5nKTogQ29udGV4dEVudHJ5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLmlkICE9PSBleGNlcHQgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiZcbiAgICAgICAgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQSBmb2xkZXIgdGhpbmdzIG1heSBiZSBtYWRlIGluIG9yIG1vdmVkIGludG86IGEgbWlycm9yZWQgZW50cnkncyByb290LCBhXG4gICAqIHZpc2libGUgZm9sZGVyIHVuZGVyIG9uZSwgb3IgdGhlIHdvcmtzcGFjZS4gUmV0dXJucyB0aGUgYWJzb2x1dGUgZm9sZGVyO1xuICAgKiByZWZ1c2VzIGFueXRoaW5nIGVsc2Ug4oCUIHRoZSBjb250ZXh0IHN0YXlzIHRoZSB3YXkgaW4gKHZlcmlmeS1wYXNzIGZpeCAxYikuXG4gICAqL1xuICBwcml2YXRlIGRlc3RpbmF0aW9uT3JEaWUocmF3RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdEaXIpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgY29udGludWU7XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBhYnM7XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGU/LmtpbmQgPT09IFwiZ3JvdXBcIikgcmV0dXJuIGFicztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuaXNXb3Jrc3BhY2UoYWJzKSkgcmV0dXJuIHRoaXMud29ya3NwYWNlO1xuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICBgJHthYnN9IGlzIG5vdCBhIGZvbGRlciBpbiB0aGlzIHNlc3Npb24g4oCUIG5hbWUgYSBzZXQsIGEgZm9sZGVyIGluc2lkZSBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UgKCR7dGhpcy53b3Jrc3BhY2V9KWAsXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG9yIGZvbGRlciBzaG93biBpbiB0aGUgY29udGV4dCwgd2l0aCB3aGVyZSBpdCBpcyBzaG93bi4gKi9cbiAgcHJpdmF0ZSBpdGVtT3JEaWUocmF3UGF0aDogc3RyaW5nKToge1xuICAgIGFiczogc3RyaW5nO1xuICAgIGVudHJ5OiBDb250ZXh0RW50cnk7XG4gICAgLyoqIFRoZSB3aG9sZSBlbnRyeSAoYSBzZXQncyBvd24gZm9sZGVyLCBhIGxpc3RlZCBkb2N1bWVudCksIG9yIGEgbm9kZSBpbnNpZGUgYSBzZXQuICovXG4gICAgd2hvbGU6IGJvb2xlYW47XG4gICAgZGlyOiBib29sZWFuO1xuICB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAxICYmIG9ubHk/LmtpbmQgPT09IFwiZG9jXCIgJiYgam9pbihlLnJvb3QsIG9ubHkucmVsKSA9PT0gYWJzKVxuICAgICAgICAgIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IGZhbHNlIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiB0cnVlIH07XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGUpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiBmYWxzZSwgZGlyOiBub2RlLmtpbmQgPT09IFwiZ3JvdXBcIiB9O1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHRgLCA0MDQpO1xuICB9XG5cbiAgLyoqXG4gICAqIGByYXdQYXRoYCBpZiB0aGUgY29udGV4dCBzaG93cyBpdCDigJQgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gYSBzZXQsIGFcbiAgICogbGlzdGVkIGRvY3VtZW50LCBhIHNldCdzIG93biBmb2xkZXIg4oCUIG9yIGl0IGlzIHRoZSB3b3Jrc3BhY2U7IHJlZnVzZWRcbiAgICogb3RoZXJ3aXNlLiBGb3IgYWN0cyB0aGF0IHJlYWNoIG91dHNpZGUgdGhlIHNwZWxsIChyZXZlYWxpbmcgYSBwYXRoIGluIHRoZVxuICAgKiBmaWxlIG1hbmFnZXIpLCBzbyBhIHBhZ2UgY2Fubm90IGFpbSB0aGVtIGF0IGFuIGFyYml0cmFyeSBwYXRoLlxuICAgKi9cbiAgc2hvd25QYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBpZiAodGhpcy5pdGVtQXQoYWJzKSkgcmV0dXJuIGFicztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdGluYXRpb25PckRpZShhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb25gLCA0MDApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZWZ1c2UgYSBuYW1lIHRoYXQgaXMgbm90IG9uZSBwbGFpbiBmaWxlIG9yIGZvbGRlciBuYW1lLiAqL1xuICBwcml2YXRlIG5hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgICBpZiAoXG4gICAgICBuID09PSBcIlwiIHx8XG4gICAgICBuID09PSBcIi5cIiB8fFxuICAgICAgbiA9PT0gXCIuLlwiIHx8XG4gICAgICBuLnN0YXJ0c1dpdGgoXCIuXCIpIHx8XG4gICAgICAvWy9cXFxcXFwwXS8udGVzdChuKSB8fFxuICAgICAgbi5sZW5ndGggPiAyNTVcbiAgICApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgXCIke25hbWV9XCIgaXMgbm90IGEgdXNhYmxlIG5hbWUg4oCUIG9uZSBwbGFpbiBuYW1lLCBubyBzbGFzaGVzLCBub3Qgc3RhcnRpbmcgd2l0aCBhIGRvdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBuYW1lOiBhIG5hbWUgd2l0aG91dCBhIGRvY3VtZW50IGV4dGVuc2lvbiBnZXRzIGAubWRgLiAqL1xuICBwcml2YXRlIGRvY05hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICByZXR1cm4gaXNEb2NOYW1lKG4pID8gbiA6IGAke259Lm1kYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciBzb21ldGhpbmcgbW92ZWQgb24gZGlzayBmcm9tIGBmcm9tYCB0byBgdG9gLCBicmluZyB0aGUgbW9kZWwgd2l0aCBpdDpcbiAgICogb3BlbmVkIGRvY3VtZW50cyBrZWVwIHRoZWlyIHZlcnNpb25zIHVuZGVyIHRoZSBuZXcgcGF0aCwgZW50cmllcyByb290ZWQgYXRcbiAgICogb3IgaG9sZGluZyB0aGUgbW92ZWQgdGhpbmcgZm9sbG93IGl0LCBhbmQgZXZlcnkgbWlycm9yIGlzIHJlLXJlYWQuIEFuIGVudHJ5XG4gICAqIHRoYXQgbm93IHNpdHMgaW5zaWRlIGFub3RoZXIgc2V0IGlzIGRyb3BwZWQg4oCUIHRoZSBzZXQgc2hvd3MgaXQgYWxyZWFkeS5cbiAgICovXG4gIHByaXZhdGUgZm9sbG93TW92ZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBtb3ZlZCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+XG4gICAgICBwID09PSBmcm9tID8gdG8gOiBwLnN0YXJ0c1dpdGgoZnJvbSArIHNlcCkgPyB0byArIHAuc2xpY2UoZnJvbS5sZW5ndGgpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGQub3JpZ2luYWwpO1xuICAgICAgaWYgKG5vdykge1xuICAgICAgICBkLm9yaWdpbmFsID0gbm93O1xuICAgICAgICBkLm5hbWUgPSBiYXNlbmFtZShub3cpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBkcm9wID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAob25seT8ua2luZCAhPT0gXCJkb2NcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGpvaW4oZS5yb290LCBvbmx5LnJlbCkpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IGRpcm5hbWUobm93KTtcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KTtcbiAgICAgICAgICBlLm5vZGVzID0gW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShub3cpIH1dO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChlLnJvb3QpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IG5vdztcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KSB8fCBub3c7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5tLmNvbnRleHQgPSB0aGlzLm0uY29udGV4dC5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQWZ0ZXIgYSBmaWxlIG9yIGZvbGRlciBsYW5kZWQgYXQgYGFic2A6IHJlLXJlYWQgdGhlIHNldCBpdCBpcyBpbiwgb3IgZ2l2ZSBpdCBhbiBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBhZG9wdE5ldyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHNldCA9IHRoaXMuY292ZXJpbmdFbnRyeShhYnMpO1xuICAgIGlmIChzZXQpIHRoaXMucmVzY2FuKHNldC5pZCk7XG4gICAgZWxzZSB0aGlzLm0uY29udGV4dC5wdXNoKGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBIG5hbWUgaW4gYGRpcmAgdGhhdCBpcyBmcmVlOiBgbmFtZWAsIGVsc2UgYHN0ZW0gMi5leHRgLCBgc3RlbSAzLmV4dGAsIOKApiAqL1xuICBwcml2YXRlIGZyZWVOYW1lKGRpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGlzRGlyOiBib29sZWFuKTogc3RyaW5nIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG5hbWUpKSkgcmV0dXJuIG5hbWU7XG4gICAgY29uc3QgZXh0ID0gaXNEaXIgPyBcIlwiIDogZXh0bmFtZShuYW1lKTtcbiAgICBjb25zdCBzdGVtID0gZXh0ID8gbmFtZS5zbGljZSgwLCAtZXh0Lmxlbmd0aCkgOiBuYW1lO1xuICAgIGZvciAobGV0IGkgPSAyOyA7IGkrKykge1xuICAgICAgY29uc3QgbiA9IGAke3N0ZW19ICR7aX0ke2V4dH1gO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuKSkpIHJldHVybiBuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVmdXNlRXhpc3RpbmcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZXhpc3RzU3luYyhhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGFscmVhZHkgZXhpc3RzIOKAlCBub3RoaW5nIHdhcyBvdmVyd3JpdHRlbmAsIDQwOSk7XG4gIH1cblxuICBjcmVhdGVEb2MocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmaWxlID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIlVudGl0bGVkLm1kXCIsIGZhbHNlKSA6IHRoaXMuZG9jTmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmaWxlKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIFwiXCIsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIGNyZWF0ZUZvbGRlcihyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZvbGRlciA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJOZXcgZm9sZGVyXCIsIHRydWUpIDogdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZvbGRlcik7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIG1rZGlyU3luYyhhYnMpO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjY6IHdoYXQgYSBtb3ZlIFdPVUxEIGRvLCBmb3IgdGhlIGNvbmZpcm1hdGlvbiB0aGUgc3VyZmFjZSBzaG93cyBiZWZvcmVcbiAgICogbW92aW5nIGEgRk9MREVSLiBSZWFkcyBub3RoaW5nIGJ1dCB0aGUgZGlzayBhbmQgcmVmdXNlcyBleGFjdGx5IHdoYXRcbiAgICogYG1vdmVgIHdvdWxkIHJlZnVzZSwgc28gYSBjb25maXJtZWQgbW92ZSBjYW5ub3QgdGhlbiBmYWlsIG9uIGFkbWlzc2lvbi5cbiAgICpcbiAgICogVGhlIGdpdCBoYWxmIGlzIGhlcmUgYmVjYXVzZSBvbmx5IHRoZSBkYWVtb24gY2FuIHNlZSBhIGAuZ2l0YDogYSBmb2xkZXJcbiAgICogZHJhZ2dlZCBvdXQgb2YgYSByZXBvc2l0b3J5IGlzIHRoZSBjYXNlIHdoZXJlIHRoZSBjb25zZXF1ZW5jZSByZWFjaGVzIHBhc3RcbiAgICogc2NyaXB0b3JpdW0gKENvbGUgbW92ZWQgdGhpcyBwcm9qZWN0J3Mgb3duIGRvY3MgZm9sZGVyIGludG8gaGlzIHdvcmtzcGFjZSxcbiAgICogYW5kIGdpdCBzYXcgc2l4IGRlbGV0ZWQgZmlsZXMpLlxuICAgKi9cbiAgbW92ZVBsYW4ocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiBNb3ZlUGxhbiB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgY29uc3QgZnJvbVJlcG8gPSBnaXRSb290T2YoZGlybmFtZShpdGVtLmFicykpO1xuICAgIGNvbnN0IGludG9SZXBvID0gZ2l0Um9vdE9mKGludG8pO1xuICAgIHJldHVybiB7XG4gICAgICBmcm9tOiBpdGVtLmFicyxcbiAgICAgIGludG8sXG4gICAgICBuYW1lOiBiYXNlbmFtZShpdGVtLmFicyksXG4gICAgICBmb2xkZXI6IGl0ZW0uZGlyLFxuICAgICAgZG9jczogaXRlbS5kaXIgPyBjb3VudERvY3MoaXRlbS5hYnMpIDogMSxcbiAgICAgIHJlcG86IGZyb21SZXBvID8gYmFzZW5hbWUoZnJvbVJlcG8pIDogbnVsbCxcbiAgICAgIGxlYXZlc1JlcG86IGZyb21SZXBvICE9PSBudWxsICYmIGZyb21SZXBvICE9PSBpbnRvUmVwbyxcbiAgICB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICAvKipcbiAgICogVGhlIGhpZGRlbiBsaXN0IG9mIHRoZSBlbnRyeSBhIHBhdGggYmVsb25ncyB0bywgQkVGT1JFIGFueXRoaW5nIGNoYW5nZXMgaXRcbiAgICog4oCUIHdoYXQgRTYwIHJlY29yZHMgc28gYSBoaWRlIGNhbiBiZSBwdXQgYmFjayBleGFjdGx5LlxuICAgKi9cbiAgaGlkZGVuQmVmb3JlKHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfSB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgICByZXR1cm4geyBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVsczogWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvKiogVGhlIHNhbWUsIGFkZHJlc3NlZCBieSBlbnRyeSDigJQgd2hhdCBgdW5oaWRlYCBuZWVkcyByZWNvcmRlZC4gKi9cbiAgaGlkZGVuT2ZFbnRyeShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgcmV0dXJuIGUgPyB7IGVudHJ5OiBlLmlkLCByZWxzOiBbLi4uKGUuaGlkZGVuID8/IFtdKV0gfSA6IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSBgcmVsc2AgKEU2MCdzIGludmVyc2Ugb2YgYm90aCBoaWRlXG4gICAqIGFuZCB1bmhpZGUpLiBSZXR1cm5zIHdoYXQgaXQgV0FTLCBzbyB0aGUgY2FsbGVyIGNhbiBidWlsZCB0aGUgb3Bwb3NpdGUgYWN0XG4gICAqIHdpdGhvdXQgcmVhZGluZyBzdGF0ZSBpdCBoYXMgYWxyZWFkeSBjaGFuZ2VkLlxuICAgKi9cbiAgcmVzdG9yZUhpZGRlbihlbnRyeUlkOiBzdHJpbmcsIHJlbHM6IHN0cmluZ1tdKTogeyBlbnRyeTogc3RyaW5nOyB3YXM6IHN0cmluZ1tdIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCB3YXMgPSBbLi4uKGUuaGlkZGVuID8/IFtdKV07XG4gICAgaWYgKHJlbHMubGVuZ3RoID09PSAwKSBkZWxldGUgZS5oaWRkZW47XG4gICAgZWxzZSBlLmhpZGRlbiA9IFsuLi5yZWxzXTtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgd2FzIH07XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlIHNvbWV0aGluZyB0aGlzIHNlc3Npb24gY3JlYXRlZCAoRTYwJ3MgdW5kbyBvZiBhIGNyZWF0aW9uKS5cbiAgICpcbiAgICog4puUIEEgTk9OLUVNUFRZIERJUkVDVE9SWSBJUyBSRUZVU0VELCBhbmQgbm8gZGlhbG9nIGNhbiBhdXRob3Jpc2UgaXQuIFVuZG9cbiAgICogd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdCByZWFjaGVzIHRoYXQgZm9sZGVyJ3NcbiAgICogY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzIHRoZW4gc29tZXRoaW5nIHB1dCB0aGVtIHRoZXJlXG4gICAqIHRoYXQgdGhlIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGEgZGlyZWN0b3J5IFRSRUUgaXMgYVxuICAgKiBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0IG1hZGUuIChDb2xlIHJ1bGVkIHRoZVxuICAgKiBmaWxlIGNhc2UgdGhlIG90aGVyIHdheSDigJQgY29uZmlybWVkLCBub3QgcmVmdXNlZCDigJQgYW5kIHRoaXMgbGltaXQgaXMgdGhlXG4gICAqIGNhcnZlLW91dCBoZSBhY2NlcHRlZC4pXG4gICAqXG4gICAqIOKaoCBJdCBhbHNvIHJlZnVzZXMgYW55dGhpbmcgdGhhdCBpcyBub3Qgd2hlcmUgdGhlIGhpc3Rvcnkgc2FpZCBpdCB3YXM6IGFcbiAgICogcGF0aCB0aGF0IGhhcyBiZWNvbWUgYSBkaXJlY3RvcnksIG9yIGEgZGlyZWN0b3J5IHRoYXQgaGFzIGJlY29tZSBhIGZpbGUsXG4gICAqIG1lYW5zIHRoZSB3b3JsZCBtb3ZlZCBhbmQgdGhlIHJlY29yZGVkIGludmVyc2Ugbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdC5cbiAgICovXG4gIHJlbW92ZUNyZWF0ZWQocmF3UGF0aDogc3RyaW5nLCBkaXI6IGJvb2xlYW4pOiB7IHBhdGg6IHN0cmluZzsgcmVtb3ZlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbHJlYWR5IGdvbmU6IHRoZSB1bmRvIGhhcyBub3RoaW5nIHRvIGRvLCB3aGljaCBpcyBub3QgYW4gZXJyb3IuXG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIHJlbW92ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpICE9PSBkaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoYWJzKX0gaXMgJHtzdC5pc0RpcmVjdG9yeSgpID8gXCJhIGZvbGRlclwiIDogXCJhIGZpbGVcIn0gbm93IOKAlCB0aGUgY2hhbmdlIHRoaXMgd291bGQgdW5kbyBubyBsb25nZXIgZGVzY3JpYmVzIGl0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBpZiAoZGlyKSB7XG4gICAgICBjb25zdCBsZWZ0ID0gcmVhZGRpclN5bmMoYWJzKTtcbiAgICAgIGlmIChsZWZ0Lmxlbmd0aCA+IDApXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzIG5vdCBlbXB0eSAoJHtsZWZ0Lmxlbmd0aH0gaXRlbSR7bGVmdC5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9KSDigJQgbW92ZSB3aGF0IGlzIGluc2lkZSBpdCBvdXQgZmlyc3RgLFxuICAgICAgICAgIDQwOSxcbiAgICAgICAgICBsZWZ0LnNsaWNlKDAsIDEwKSxcbiAgICAgICAgKTtcbiAgICAgIHJtZGlyU3luYyhhYnMpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1bmxpbmtTeW5jKGFicyk7XG4gICAgfVxuICAgIHRoaXMuZm9yZ2V0UGF0aChhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgcmVtb3ZlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5dGhpbmcgd29ydGggbG9va2luZyBhdCBpbiB0aGlzIHNlc3Npb24sIHdpdGggdGhlIHZlcmIgZm9yIGVhY2ggKEU2MikuXG4gICAqXG4gICAqIOKblCBJVCBPTkxZIExPT0tTLiBSZXBhaXJpbmcgd291bGQgbWVhbiBkZWNpZGluZyBmb3IgdGhlIGh1bWFuIHRoYXQgYSBnaG9zdFxuICAgKiBlbnRyeSBpcyBub3Qgd2FudGVkIGJhY2sgYW5kIHRoYXQgdmVyc2lvbnMgaGVsZCBmb3IgYSB2YW5pc2hlZCBmaWxlIGFyZSBub3RcbiAgICogd29ydGggc2F2aW5nIOKAlCBib3RoIG9mIHdoaWNoIGFyZSB0aGVpcnMgdG8gZGVjaWRlIChDb2xlOiBcInJlcG9ydCwgbmFtZSB0aGVcbiAgICogdmVyYiwgbGV0IHlvdSBkZWNpZGVcIikuXG4gICAqXG4gICAqIOKaoCBgZXhpc3RzU3luY2AgcGVyIGRvY3VtZW50IGFuZCBwZXIgbm9kZSwgd2hpY2ggaXMgdGhlIG9uZSBjb3N0IGhlcmUuIEl0IGlzXG4gICAqIGJvdW5kZWQgYnkgdGhlIGNvbnRleHQgdGhlIGh1bWFuIGNob3NlIGFuZCBydW5zIG9uIGRlbWFuZCBwbHVzIG9uY2UgYXRcbiAgICogc3RhcnR1cCwgbm90IG9uIGEgdGltZXIuXG4gICAqL1xuICBjaGVja3VwKCk6IEZpbmRpbmdbXSB7XG4gICAgY29uc3Qgbm9kZXM6IHsgZW50cnk6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBzaG93bjogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfVtdID0gW107XG4gICAgY29uc3QgbGlua3M6IHsgZW50cnk6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGFuZ2xpbmc6IG51bWJlciB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgbm9kZXMucHVzaCh7IGVudHJ5OiBlLmlkLCBwYXRoOiBwLCBzaG93bjogdGhpcy5kaXNwbGF5KHApLCBleGlzdHM6IGV4aXN0c1N5bmMocCkgfSk7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZS5pZCk7XG4gICAgICAgIGlmIChnLmRhbmdsaW5nID4gMClcbiAgICAgICAgICBsaW5rcy5wdXNoKHsgZW50cnk6IGUuaWQsIGxhYmVsOiBlLmxhYmVsID8/IGJhc2VuYW1lKGUucm9vdCksIGRhbmdsaW5nOiBnLmRhbmdsaW5nIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEEgc2V0IHRoYXQgY2Fubm90IGJlIG1hcHBlZCBpcyBub3QgYSBmaW5kaW5nIGFib3V0IGxpbmtzLlxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmluZGluZ3Moe1xuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiAoe1xuICAgICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICAgIGV4aXN0czogZXhpc3RzU3luYyhkLm9yaWdpbmFsKSxcbiAgICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgICAgfSkpLFxuICAgICAgbm9kZXMsXG4gICAgICBsaW5rcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgYSBkb2N1bWVudCB3aG9zZSBmaWxlIG9mIHJlY29yZCBpcyBnb25lIChFNjEpLlxuICAgKlxuICAgKiDim5QgVEhFIFdBUk5JTkcgSEFEIE5PIEFOU1dFUiwgV0hJQ0ggSVMgV0hZIFRISVMgRVhJU1RTLiBXaGVuIGEgZG9jdW1lbnQnc1xuICAgKiBvcmlnaW5hbCBkaXNhcHBlYXJzIGJldHdlZW4gc2Vzc2lvbnMsIHJlc3RvcmUgc2F5cyBzbyBvbiBwdXJwb3NlIOKAlCBcImdvbmVcbiAgICogZnJvbSBkaXNrIHNpbmNlIHRoaXMgc2Vzc2lvbiB3YXMgbGFzdCBvcGVuLiBTYXZlIHdvdWxkIHJlY3JlYXRlIGl0XCIg4oCUIGFuZFxuICAgKiB0aGF0IGlzIHRoZSBSSUdIVCB0aGluZyB0byBzYXksIGJlY2F1c2UgdGhlIHNlc3Npb24gaXMgc3RpbGwgaG9sZGluZyB0aGVcbiAgICogY29udGVudCBhbmQgb2ZmZXJpbmcgaXQgYmFjay4gV2hhdCB3YXMgbWlzc2luZyB3YXMgYW55IHdheSB0byByZXBseSBcIm5vLCBJXG4gICAqIG1lYW50IHRvIGRlbGV0ZSB0aGF0XCI6IHRoZSBub3RpY2UgcmVwZWF0ZWQgb24gZXZlcnkgcmVzdG9yZSBmb3JldmVyIGFuZCB0aGVcbiAgICogb25seSBlc2NhcGUgd2FzIHJlY3JlYXRpbmcgdGhlIHNlc3Npb24uIEEgd2FybmluZyB3aXRoIG5vIGNvcnJlc3BvbmRpbmcgYWN0XG4gICAqIGlzIHRoZSBzaGFwZSB0aGlzIHNwZWxsIGtlZXBzIHRyeWluZyBub3QgdG8gaGF2ZS5cbiAgICpcbiAgICog4puUIFJFRlVTRUQgV0hJTEUgVEhFIEZJTEUgRVhJU1RTLCBhbmQgdGhlIHJlZnVzYWwgbmFtZXMgdGhlIHJpZ2h0IHZlcmIuXG4gICAqIEZvcmdldHRpbmcgYSBMSVZFIGRvY3VtZW50J3MgcmVjb3JkIHdvdWxkIHRocm93IGF3YXkgaXRzIHZlcnNpb24gaGlzdG9yeVxuICAgKiB3aGlsZSB0aGUgZG9jdW1lbnQgaXRzZWxmIHNpdHMgdGhlcmUgb24gZGlzayDigJQgdGhlIGNvbmZ1c2lvbiB0aGlzIG11c3Qgbm90XG4gICAqIGVuYWJsZS4gVGFraW5nIHNvbWV0aGluZyBvdXQgb2YgdGhlIHNpZGViYXIgaXMgYGhpZGVgOyB0aGlzIGlzIG9ubHkgZm9yIGFcbiAgICogcmVjb3JkIHdob3NlIHN1YmplY3QgaXMgZ29uZS5cbiAgICpcbiAgICog4pqgIFRoZSB2ZXJzaW9uIGZpbGVzIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYXJlIExFRlQgd2hlcmUgdGhleSBhcmUsIGFzXG4gICAqIHdpdGggdW5kbydzIGRlbGV0ZTogbm90aGluZyByZWFkcyB0aGVtIG9uY2UgdGhlIHJlY29yZCBpcyBnb25lLCBhbmRcbiAgICogcmVtb3ZpbmcgdGhlbSB3b3VsZCBiZSBhIHNlY29uZCBkZWxldGlvbiBub2JvZHkgYXNrZWQgZm9yLlxuICAgKi9cbiAgZm9yZ2V0RG9jKHJlZj86IHN0cmluZyk6IHsgc2x1Zzogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IHZlcnNpb25zOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUocmVmKTtcbiAgICBpZiAoZXhpc3RzU3luYyhkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke3RoaXMuZGlzcGxheShkLm9yaWdpbmFsKX0gaXMgc3RpbGwgb24gZGlzayDigJQgZm9yZ2V0IGlzIGZvciBhIGRvY3VtZW50IHdob3NlIGZpbGUgaXMgZ29uZS4gVG8gdGFrZSBpdCBvdXQgb2YgdGhlIGNvbnRleHQsIHJlbW92ZSBpdCBmcm9tIFNjcmlwdG9yaXVtIGluc3RlYWQuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBmb3Jnb3R0ZW4gPSB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzID0gdGhpcy5tLmRvY3MuZmlsdGVyKCh4KSA9PiB4LnNsdWcgIT09IGQuc2x1Zyk7XG4gICAgaWYgKHRoaXMubS5vcGVuRG9jID09PSBkLnNsdWcpIHRoaXMubS5vcGVuRG9jID0gdGhpcy5tLmRvY3NbMF0/LnNsdWcgPz8gbnVsbDtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBmb3Jnb3R0ZW47XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgcGF0aCB0aGF0IGlzIG5vIGxvbmdlciBvbiBkaXNrOiBwcnVuZSBpdCBmcm9tIGV2ZXJ5IGNvbnRleHQgZW50cnksXG4gICAqIGRyb3AgdGhlIGVudHJ5IGlmIHRoYXQgZW1wdGllcyBpdCwgYW5kIGZvcmdldCBhbnkgZG9jdW1lbnQgcmVjb3JkIGZvciBpdC5cbiAgICpcbiAgICog4puUIGByZXNjYW5gIElTIE5PVCBFTk9VR0gsIEFORCBUSEFUIFdBUyBUSEUgQlVHLiBJdCByZXR1cm5zIGVhcmx5IGZvciBhbnlcbiAgICogZW50cnkgd2hvc2UgbWVtYmVyc2hpcCBpcyBub3QgYG1pcnJvcmVkYCDigJQgYW5kIGEgc2luZ2xlIGRvY3VtZW50IGlzIGFcbiAgICogYGxpc3RlZGAgZW50cnksIHNvIGRlbGV0aW5nIG9uZSBsZWZ0IGl0cyBub2RlIGluIHRoZSBzaWRlYmFyIGZvcmV2ZXIgd2hpbGVcbiAgICogdGhlIGZpbGUgd2FzIGdvbmUgZnJvbSB0aGUgZGlzay4gQ29sZSBmb3VuZCBpdCB3aXRoaW4gYSBtaW51dGUgb2YgRTYwXG4gICAqIHNoaXBwaW5nOiBcIml0J3Mgbm90IGJlaW5nIHJlbW92ZWQgZnJvbSB0aGUgc2lkZWJhcuKApiB0aGVuIEkgY3JlYXRlZCBhbm90aGVyXG4gICAqIGRvY3VtZW50IGFsc28gdW50aXRsZWQgYW5kIEkgdGhpbmsgdGhlcmUgbWlnaHQgaGF2ZSBiZWVuIGV2ZW4gYSB3ZWlyZFxuICAgKiBuYW1pbmcgaXNzdWVcIi5cbiAgICpcbiAgICog4pqgIFRIRSBOQU1JTkcgT0RESVRZIFdBUyBUSEUgU0VDT05EIEhBTEYgT0YgVEhFIFNBTUUgQlVHLiBUaGUgYERvY1JlY29yZGBcbiAgICogb3V0bGl2ZWQgdGhlIGZpbGUgdG9vLCBzbyBpdHMgU0xVRyBzdGF5ZWQgdGFrZW4gYW5kIHRoZSBuZXh0IGBVbnRpdGxlZC5tZGBcbiAgICogYmVjYW1lIGB1bnRpdGxlZC0yYCB3aGlsZSB0aGUgZmlsZSBvbiBkaXNrIHdhcyBwbGFpbiBgVW50aXRsZWQubWRgLiBBXG4gICAqIHJlY29yZCBmb3IgYSBkb2N1bWVudCB0aGF0IGRvZXMgbm90IGV4aXN0IGhhcyBubyByZWFkZXI7IGl0IG9ubHkgZ2V0cyBpblxuICAgKiB0aGUgd2F5IG9mIHRoZSBuZXh0IG9uZS5cbiAgICpcbiAgICog4pqgIFRoZSB2ZXJzaW9uIGZpbGVzIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYXJlIExFRlQgd2hlcmUgdGhleSBhcmUuIFRoZVxuICAgKiByZWNvcmQgaXMgZ29uZSwgc28gbm90aGluZyByZWFkcyB0aGVtLCBhbmQgcmVtb3ZpbmcgdGhlbSB3b3VsZCBiZSBhIHNlY29uZFxuICAgKiBkZWxldGlvbiB0aGUgaHVtYW4gd2FzIG5ldmVyIGFza2VkIGFib3V0IOKAlCB0aGUgZGlhbG9nIHByb21pc2VkIHRoZSBjcmVhdGVkXG4gICAqIGZpbGUsIG5vdCB0aGUgc2Vzc2lvbidzIG93biBjb3BpZXMuXG4gICAqL1xuICBwcml2YXRlIGZvcmdldFBhdGgoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpbnNpZGUgPSAocDogc3RyaW5nKSA9PiBwID09PSBhYnMgfHwgcC5zdGFydHNXaXRoKGFicyArIHNlcCk7XG4gICAgZm9yIChjb25zdCBlIG9mIFsuLi50aGlzLm0uY29udGV4dF0pIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAhaW5zaWRlKGUucm9vdCkpIHtcbiAgICAgICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gQSBgbGlzdGVkYCBlbnRyeSAob3IgYSBtaXJyb3JlZCBvbmUgdGhhdCBXQVMgdGhlIGRlbGV0ZWQgZm9sZGVyKTpcbiAgICAgIC8vIHBydW5lIHRoZSBub2RlcyBieSBoYW5kLCBzaW5jZSBgcmVzY2FuYCB3aWxsIG5vdCBsb29rIGF0IGl0LlxuICAgICAgY29uc3QgcHJ1bmUgPSAobm9kZXM6IENvbnRleHROb2RlW10pOiBDb250ZXh0Tm9kZVtdID0+XG4gICAgICAgIG5vZGVzXG4gICAgICAgICAgLmZpbHRlcigobikgPT4gIWluc2lkZShqb2luKGUucm9vdCwgbi5yZWwpKSlcbiAgICAgICAgICAubWFwKChuKSA9PiAobi5raW5kID09PSBcImdyb3VwXCIgPyB7IC4uLm4sIGNoaWxkcmVuOiBwcnVuZShuLmNoaWxkcmVuKSB9IDogbikpO1xuICAgICAgZS5ub2RlcyA9IHBydW5lKGUubm9kZXMpO1xuICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAwIHx8IGluc2lkZShlLnJvb3QpKSB0aGlzLnJlbW92ZUNvbnRleHQoZS5pZCk7XG4gICAgfVxuICAgIC8vIEEgcmVjb3JkIGZvciBhIGZpbGUgdGhhdCBpcyBnb25lIGhhcyBubyByZWFkZXIsIGFuZCBpdHMgc2x1ZyB3b3VsZFxuICAgIC8vIG90aGVyd2lzZSBzdGF5IHRha2VuLlxuICAgIHRoaXMubS5kb2NzID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiAhaW5zaWRlKGQub3JpZ2luYWwpKTtcbiAgICBpZiAodGhpcy5tLm9wZW5Eb2MgJiYgIXRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpKVxuICAgICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLm0uZG9jc1swXT8uc2x1ZyA/PyBudWxsO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgdW5oaWRlKGVudHJ5SWQ6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVzdG9yZWQ6IG51bWJlciB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcmVzdG9yZWQgPSBlLmhpZGRlbj8ubGVuZ3RoID8/IDA7XG4gICAgZGVsZXRlIGUuaGlkZGVuO1xuICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHJlc3RvcmVkIH07XG4gIH1cblxuICAvKipcbiAgICogRTIyOiBhIHNpbmdsZSBkb2N1bWVudCBiZWNvbWVzIGEgc2V0IOKAlCBhIGZvbGRlciBuYW1lZCBmb3IgaXQgYmVzaWRlIGl0LCB0aGVcbiAgICogZG9jdW1lbnQgbW92ZWQgaW4sIGFuZCB0aGUgZW50cnkgKHNhbWUgaWQpIG5vdyBtaXJyb3JzIHRoYXQgZm9sZGVyLlxuICAgKi9cbiAgbWFrZVNldChyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZm9sZGVyOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLmVudHJ5Lm1lbWJlcnNoaXAgIT09IFwibGlzdGVkXCIgfHwgaXRlbS5kaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIGEgc2V0IOKAlCBtYWtlIGEgZm9sZGVyIHRoZXJlIGluc3RlYWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoaXRlbS5hYnMpO1xuICAgIGNvbnN0IHN0ZW0gPSBiYXNlbmFtZShpdGVtLmFicywgZXh0bmFtZShpdGVtLmFicykpIHx8IFwiVW50aXRsZWRcIjtcbiAgICBjb25zdCBmb2xkZXIgPSBqb2luKHBhcmVudCwgdGhpcy5mcmVlTmFtZShwYXJlbnQsIHN0ZW0sIHRydWUpKTtcbiAgICBta2RpclN5bmMoZm9sZGVyKTtcbiAgICBjb25zdCB0byA9IGpvaW4oZm9sZGVyLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICBjb25zdCBlID0gaXRlbS5lbnRyeTtcbiAgICBlLm1lbWJlcnNoaXAgPSBcIm1pcnJvcmVkXCI7XG4gICAgZS5yb290ID0gZm9sZGVyO1xuICAgIGUubGFiZWwgPSBiYXNlbmFtZShmb2xkZXIpO1xuICAgIGUubm9kZXMgPSBbXTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZm9sZGVyLCBlbnRyeTogZS5pZCB9O1xuICB9XG5cbiAgLyoqIFRoZSBtb3N0IHRleHQgb25lIGltcG9ydCBjYXJyaWVzIOKAlCBhIGRvY3VtZW50LCBub3QgYSBkYXRhIGR1bXAuICovXG4gIHN0YXRpYyByZWFkb25seSBJTVBPUlRfTUFYX0JZVEVTID0gOCAqIDEwMjQgKiAxMDI0O1xuXG4gIC8qKlxuICAgKiBFMjMncyBkcm9wOiBhIENPUFkgb2YgYSBmaWxlJ3MgdGV4dCwgd3JpdHRlbiB1bmRlciBhIGZyZWUgbmFtZSBpbnRvIGBpbnRvYFxuICAgKiAoZGVmYXVsdDogdGhlIHdvcmtzcGFjZSksIHRoZW4gc2hvd24gbGlrZSBhbnkgb3RoZXIgZG9jdW1lbnQuXG4gICAqL1xuICBpbXBvcnRUZXh0KG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nLCByYXdJbnRvPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGlmICghaXNEb2NOYW1lKGZpbGUpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vdCBhIGRvY3VtZW50IFNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7ZmlsZX1gLFxuICAgICAgICA0MDAsXG4gICAgICAgIFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICApO1xuICAgIGlmIChCdWZmZXIuYnl0ZUxlbmd0aCh0ZXh0KSA+IFNlc3Npb24uSU1QT1JUX01BWF9CWVRFUylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2ZpbGV9IGlzIGxhcmdlciB0aGFuICR7U2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTIC8gMTAyNCAvIDEwMjR9IE1CIOKAlCBub3QgaW1wb3J0ZWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvID8/IHRoaXMud29ya3NwYWNlKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgdGhpcy5mcmVlTmFtZShkaXIsIGZpbGUsIGZhbHNlKSk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjaGF0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8vIOKUgOKUgCB0aGUgd29yayBxdWV1ZSAoRTUwKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogU3RhcnQgYSB0YXNrLiBJdCBpcyBBTk5PVU5DRUQgYXMgYSBjaGF0IG1lc3NhZ2UgYW5kIHJlY29yZGVkIGFzIGEgdGFzayBhdFxuICAgKiB0aGUgc2FtZSBtb21lbnQg4oCUIENvbGUncyBmcmFtaW5nLCBcImEgbWVzc2FnZSB0aGF0IGNhbiBiZSBtYXJrZWQgZG9uZVwiIOKAlFxuICAgKiBzbyB0aGUgY29udmVyc2F0aW9uIHJlYWRzIGFzIGEgbmFycmF0aXZlIGFuZCB0aGUgcXVldWUgcmVhZHMgYXMgc3RhdGUsXG4gICAqIG92ZXIgb25lIGZhY3QgcmF0aGVyIHRoYW4gdHdvLlxuICAgKi9cbiAgc3RhcnRUYXNrKHRleHQ6IHN0cmluZywgd2hvOiBWZXJzaW9uQXV0aG9yKTogVGFzayB7XG4gICAgY29uc3QgYm9keSA9IHRleHQudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgdGFzayBuZWVkcyB0byBzYXkgd2hhdCB0aGUgd29yayBpc1wiLCA0MDApO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSB0aGlzLmFkZE1lc3NhZ2Uod2hvLCBib2R5KTtcbiAgICBjb25zdCB0YXNrOiBUYXNrID0ge1xuICAgICAgaWQ6IGB0LSR7cmFuZEhleCg0KX1gLFxuICAgICAgdGV4dDogYm9keSxcbiAgICAgIHdobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIG1lc3NhZ2VJZDogbWVzc2FnZS5pZCxcbiAgICB9O1xuICAgIHRoaXMubS50YXNrcyA9IFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKSwgdGFza107XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICBwcml2YXRlIHRhc2tPckRpZShpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgICBpZiAoIXRhc2spXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gdGFzayAke2lkfSBpbiB0aGlzIHNlc3Npb25gLFxuICAgICAgICA0MDQsXG4gICAgICAgICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCkubWFwKCh0KSA9PiB0LmlkKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKiogU2F5IHdoYXQgaXMgYmVpbmcgZG9uZSByaWdodCBub3cg4oCUIGZvciB3b3JrIHdpdGggc3RlcHMgd29ydGggd2F0Y2hpbmcuICovXG4gIHNldFRhc2tTdGF0dXMoaWQ6IHN0cmluZywgc3RhdHVzOiBzdHJpbmcpOiBUYXNrIHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGlmICh0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGFzayAke2lkfSBpcyBhbHJlYWR5IGRvbmUg4oCUIGl0cyBzdGF0dXMgY2Fubm90IGNoYW5nZWAsIDQwOSk7XG4gICAgdGFzay5zdGF0dXMgPSBzdGF0dXMudHJpbSgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcmsgaXQgZG9uZS4gSWRlbXBvdGVudCBvbiBwdXJwb3NlOiBhIHRhc2sgZmluaXNoZWQgdHdpY2Ug4oCUIGFuIGFnZW50XG4gICAqIHJldHJ5aW5nLCBhIGh1bWFuIGNsaWNraW5nIGFzIHRoZSBhZ2VudCByZXBvcnRzIOKAlCBpcyBub3QgYW4gZXJyb3IsIGFuZFxuICAgKiByZWZ1c2luZyB3b3VsZCBtYWtlIHRoZSBzdXJmYWNlIGhhbmRsZSBhIHJhY2UgaXQgZGlkIG5vdCBjYXVzZS5cbiAgICovXG4gIGZpbmlzaFRhc2soaWQ6IHN0cmluZywgb3V0Y29tZT86IHN0cmluZyk6IHsgdGFzazogVGFzazsgYWxyZWFkeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGNvbnN0IGFscmVhZHkgPSB0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghYWxyZWFkeSkge1xuICAgICAgdGFzay5kb25lQXQgPSBEYXRlLm5vdygpO1xuICAgICAgdGFzay5zdGF0dXMgPSB1bmRlZmluZWQ7XG4gICAgICBpZiAob3V0Y29tZT8udHJpbSgpKSB0YXNrLm91dGNvbWUgPSBvdXRjb21lLnRyaW0oKTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIH1cbiAgICByZXR1cm4geyB0YXNrLCBhbHJlYWR5IH07XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgdGFzayBlbnRpcmVseSDigJQgZm9yIG9uZSBzdGFydGVkIGJ5IG1pc3Rha2UuIE1hcmtpbmcgaXQgZG9uZSB3b3VsZFxuICAgKiBwdXQgYSB0aGluZyB0aGF0IG5ldmVyIGhhcHBlbmVkIGludG8gdGhlIHJlY29yZDsgYSBxdWV1ZSB5b3UgY2Fubm90IGNsZWFyXG4gICAqIG9mIGl0cyBvd24gbWlzdGFrZXMgc3RvcHMgYmVpbmcgYSB0cnVzdHdvcnRoeSBhY2NvdW50IG9mIHRoZSB3b3JrLlxuICAgKi9cbiAgcmVtb3ZlVGFzayhpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuaWQgIT09IGlkKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgZXZlcnkgZmluaXNoZWQgdGFzay4gT3V0c3RhbmRpbmcgb25lcyBhcmUgdW50b3VjaGVkIOKAlCBjbGVhcmluZyBpc1xuICAgKiB0aWR5aW5nIHdoYXQgaXMgT1ZFUiwgbmV2ZXIgYWJhbmRvbmluZyB3b3JrIHN0aWxsIGluIGZsaWdodC5cbiAgICovXG4gIGNsZWFyRG9uZVRhc2tzKCk6IG51bWJlciB7XG4gICAgY29uc3QgYmVmb3JlID0gKHRoaXMubS50YXNrcyA/PyBbXSkubGVuZ3RoO1xuICAgIHRoaXMubS50YXNrcyA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgY2xlYXJlZCA9IGJlZm9yZSAtICh0aGlzLm0udGFza3M/Lmxlbmd0aCA/PyAwKTtcbiAgICBpZiAoY2xlYXJlZCA+IDApIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBjbGVhcmVkO1xuICB9XG5cbiAgLyoqIE5ld2VzdCBmaXJzdCDigJQgYSBxdWV1ZSBpcyByZWFkIGZyb20gdGhlIHRvcC4gKi9cbiAgdGFza3MoKTogVGFza1tdIHtcbiAgICByZXR1cm4gWy4uLih0aGlzLm0udGFza3MgPz8gW10pXS5zb3J0KChhLCBiKSA9PiBiLmNyZWF0ZWRBdCAtIGEuY3JlYXRlZEF0KTtcbiAgfVxuXG4gIGFkZE1lc3NhZ2UoXG4gICAgd2hvOiBDaGF0V2hvLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBleHRyYTogeyBzZWxlY3Rpb24/OiBTZWxlY3Rpb24gfCBudWxsOyBhY3RpdmVQYXRoPzogc3RyaW5nIHwgbnVsbCB9ID0ge30sXG4gICk6IENoYXRNZXNzYWdlIHtcbiAgICBjb25zdCBtc2c6IENoYXRNZXNzYWdlID0geyBpZDogYG0tJHtyYW5kSGV4KDQpfWAsIHdobywgdGV4dCwgdHM6IERhdGUubm93KCksIC4uLmV4dHJhIH07XG4gICAgdGhpcy5tLmNoYXQucHVzaChtc2cpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBtc2c7XG4gIH1cblxuICAvLyDilIDilIAgdmlld3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEEgZG9jdW1lbnQncyBmcm9udG1hdHRlciwgZnJvbSB0aGUgQUNUSVZFIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IHRoZSBodW1hblxuICAgKiAgaXMgcmVhZGluZywgd2hpY2ggaXMgbm90IGFsd2F5cyB3aGF0IGlzIG9uIGRpc2sgKEUzMikuICovXG4gIHByaXZhdGUgbWV0YU9mKGQ6IERvY1JlY29yZCk6IERvY1ZpZXdbXCJtZXRhXCJdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRNZXRhKHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGRvY1ZpZXcoZDogRG9jUmVjb3JkKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1ldGE6IHRoaXMubWV0YU9mKGQpLFxuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICBlbnRyeUlkOiBkLmVudHJ5SWQsXG4gICAgICByZWw6IGQucmVsLFxuICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubWFwKCh2KSA9PiAoeyAuLi52LCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIHYubikgfSkpLFxuICAgICAgbm90ZXM6IHRoaXMucGxhY2VkTm90ZXMoZCksXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgZGlydHk6IHRoaXMuaXNEaXJ0eShkKSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBkLm91dHNpZGVDaGFuZ2VkLFxuICAgIH07XG4gIH1cblxuICBkb2Moc2x1Zzogc3RyaW5nKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHRoaXMuZG9jVmlldyh0aGlzLmRvY09yRGllKHNsdWcpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGcm9udG1hdHRlciBmb3IgZXZlcnkgZG9jdW1lbnQgaW4gdGhlIGNvbnRleHQsIGJ5IHBhdGggKEUzMikuXG4gICAqXG4gICAqIENhY2hlZCBieSBwYXRoIGFuZCBtdGltZSwgYW5kIHJlYWQgSEVBRC1GSVJTVDogYSBmcm9udG1hdHRlciBibG9jayBzaXRzIGF0XG4gICAqIHRoZSB0b3Agb2YgYSBmaWxlLCBzbyBhIDMwMCBLQiBkb2N1bWVudCBjb3N0cyA4IEtCIG9mIHJlYWQuIFRoZSBjYXAga2VlcHMgYVxuICAgKiAyLDAwMC1ub2RlIG1pcnJvciBmcm9tIG1lYW5pbmcgMiwwMDAgcmVhZHMgcGVyIHNuYXBzaG90LCBhbmQgaGl0dGluZyBpdCBpc1xuICAgKiBTQUlEIG9uIHRoZSB3aXJlIHJhdGhlciB0aGFuIGxlZnQgdG8gbG9vayBsaWtlIGRvY3VtZW50cyB3aXRob3V0IGFueS5cbiAgICovXG4gIHByaXZhdGUgbWV0YUNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIHsgbXRpbWVNczogbnVtYmVyOyBzdW1tYXJ5OiBEb2NTdW1tYXJ5IHwgbnVsbCB9PigpO1xuXG4gIGNvbnRleHRNZXRhKGNhcCA9IE1FVEFfU0NBTl9DQVApOiB7IG1hcDogUmVjb3JkPHN0cmluZywgRG9jU3VtbWFyeT47IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBtYXA6IFJlY29yZDxzdHJpbmcsIERvY1N1bW1hcnk+ID0ge307XG4gICAgbGV0IHNlZW4gPSAwO1xuICAgIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSB7XG4gICAgICAgIGlmIChzZWVuID49IGNhcCkge1xuICAgICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgc2VlbisrO1xuICAgICAgICBsZXQgbXRpbWVNczogbnVtYmVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG10aW1lTXMgPSBzdGF0U3luYyhhYnMpLm10aW1lTXM7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGhpdCA9IHRoaXMubWV0YUNhY2hlLmdldChhYnMpO1xuICAgICAgICBsZXQgc3VtbWFyeTogRG9jU3VtbWFyeSB8IG51bGw7XG4gICAgICAgIGlmIChoaXQgJiYgaGl0Lm10aW1lTXMgPT09IG10aW1lTXMpIHN1bW1hcnkgPSBoaXQuc3VtbWFyeTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgc3VtbWFyeSA9IHN1bW1hcml6ZShyZWFkTWV0YShyZWFkSGVhZChhYnMpKSk7XG4gICAgICAgICAgdGhpcy5tZXRhQ2FjaGUuc2V0KGFicywgeyBtdGltZU1zLCBzdW1tYXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzdW1tYXJ5KSBtYXBbYWJzXSA9IHN1bW1hcnk7XG4gICAgICB9XG4gICAgICBpZiAodHJ1bmNhdGVkKSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIHsgbWFwLCB0cnVuY2F0ZWQgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPbmUgZG9jdW1lbnQncyBmcm9udG1hdHRlciBhcyByZWFkLCBvciBldmVyeSBjb250ZXh0IGRvY3VtZW50J3MgKEUzMikuIFRoZVxuICAgKiBhZ2VudCBnZXRzIHRoZSBkYWVtb24ncyBwYXJzZSByYXRoZXIgdGhhbiByZS1yZWFkaW5nIHRoZSBZQU1MIGl0c2VsZi5cbiAgICovXG4gIG1ldGFGb3IocmF3UGF0aD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBpZiAocmF3UGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICAgIGNvbnN0IG1ldGEgPSByZWFkTWV0YShyZWFkSGVhZChhYnMpKTtcbiAgICAgIHJldHVybiB7IHBhdGg6IGFicywgbWV0YSwgLi4uKG1ldGEgPyB7fSA6IHsgbm90ZTogXCJubyBmcm9udG1hdHRlciBibG9ja1wiIH0pIH07XG4gICAgfVxuICAgIGNvbnN0IG91dDogeyBwYXRoOiBzdHJpbmc7IG1ldGE6IERvY01ldGEgfCBudWxsIH1bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSBvdXQucHVzaCh7IHBhdGg6IGFicywgbWV0YTogcmVhZE1ldGEocmVhZEhlYWQoYWJzKSkgfSk7XG4gICAgcmV0dXJuIHsgZG9jdW1lbnRzOiBvdXQsIGNvdW50OiBvdXQubGVuZ3RoIH07XG4gIH1cblxuICAvKipcbiAgICogcGRvY3MncyBgZmluZGAsIG92ZXIgdGhpcyBzZXNzaW9uJ3MgY29udGV4dC4gU2FtZSBmaWx0ZXIgbmFtZXMsIHNhbWVcbiAgICogQU5EaW5nLCBhbmQgdGhlIHNhbWUgcnVsZSB0aGF0IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBBTlNXRVI6IGBjb3VudGAgc2F5c1xuICAgKiBob3cgbWFueSBtYXRjaGVkLCBhbmQgdGhlIGNhbGxlciByZWFkcyB0aGF0IHJhdGhlciB0aGFuIHRoZSBleGl0IGNvZGUuXG4gICAqL1xuICBmaW5kKGZpbHRlcjogTWV0YUZpbHRlcik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBtYXRjaGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpO1xuICAgICAgICBpZiAoIW1hdGNoZXNGaWx0ZXIobWV0YSwgZmlsdGVyKSkgY29udGludWU7XG4gICAgICAgIG1hdGNoZXMucHVzaCh7XG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIGVudHJ5OiBlLmlkLFxuICAgICAgICAgIC4uLihtZXRhPy50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4obWV0YT8udGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG1ldGE/LmRlc2NyaXB0aW9uID8geyBkZXNjcmlwdGlvbjogbWV0YS5kZXNjcmlwdGlvbiB9IDoge30pLFxuICAgICAgICAgIHN0YXR1czogbWV0YT8uc3RhdHVzID8/IG51bGwsXG4gICAgICAgICAgLi4uKG1ldGE/LmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgICAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICAgICAgZGF0ZTogbWV0YT8uZGF0ZSA/PyBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICByZXR1cm4geyBtYXRjaGVzLCBjb3VudDogbWF0Y2hlcy5sZW5ndGggfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPbmUgc2V0J3MgbWFwIChFMzMpOiBpdHMgZG9jdW1lbnRzIGFzIG5vZGVzLCBhbmQgdGhlIGZvdXIgc291cmNlcyBvZiBlZGdlc1xuICAgKiDigJQgYm9keSBsaW5rcywgd2lraSBsaW5rcywgdHlwZWQgbGlua3MgYW5kIGZyb250bWF0dGVyIHJlZmVyZW5jZXMuXG4gICAqL1xuICBncmFwaEZvcihlbnRyeUlkPzogc3RyaW5nKTogR3JhcGhQYXlsb2FkIHtcbiAgICBjb25zdCBlID0gZW50cnlJZFxuICAgICAgPyB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKVxuICAgICAgOiB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4Lm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIik7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgZW50cnlJZCA/IGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gIDogXCJ0aGlzIHNlc3Npb24gaGFzIG5vIHNldCB0byBtYXBcIixcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXRocyA9IGRvY1BhdGhzKGUpO1xuICAgIGNvbnN0IGluZGV4OiBCdW5kbGVJbmRleCA9IHtcbiAgICAgIHJvb3Q6IGUucm9vdCxcbiAgICAgIHBhdGhzLFxuICAgICAgbWV0YU9mOiAocCkgPT4gcmVhZE1ldGEocmVhZEhlYWQocCkpLFxuICAgICAgZXhpc3RzOiAocCkgPT4gZXhpc3RzU3luYyhwKSxcbiAgICAgIHJlcG9Sb290OiBnaXRSb290T2YoZS5yb290KSxcbiAgICB9O1xuICAgIGNvbnN0IGcgPSBidWlsZEdyYXBoKGluZGV4LCAocCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIHNwbGl0RnJvbnRtYXR0ZXIocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkuYm9keTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gXCJcIjtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgLi4uZyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlYXJjaCBldmVyeXRoaW5nIGluIHRoZSBjb250ZXh0OiBmdXp6eSBvdmVyIG5hbWVzLCBleGFjdCBvdmVyIGNvbnRlbnQgKEU1OSkuXG4gICAqXG4gICAqIOKblCBUSElTIElTIFdIWSBUSEUgVkVSQiBFWElTVFMgQVQgQUxMLCBhbmQgdGhlIHJlYXNvbiBpcyBvbmUgbGluZTogYVxuICAgKiBkb2N1bWVudCBvcGVuIGluIHRoZSBzZXNzaW9uIGlzIHNob3duIGFzIGl0cyBBQ1RJVkUgVkVSU0lPTiwgd2hpY2ggbGl2ZXNcbiAgICogdW5kZXIgdGhlIHNlc3Npb24gaG9tZSBhbmQgbm90IGF0IHRoZSBvcmlnaW5hbCBwYXRoLiBBbiBhZ2VudCBncmVwcGluZyB0aGVcbiAgICogd29ya3NwYWNlIHRoZXJlZm9yZSBmaW5kcyB0aGUgU0FWRUQgZmlsZSBhbmQgc2lsZW50bHkgbWlzc2VzIHRoZSB0ZXh0IHRoZVxuICAgKiBodW1hbiBpcyByZWFkaW5nIOKAlCBzbyBcInNlYXJjaCB3aGF0IHlvdSBjYW4gc2VlXCIgaXMgYSBxdWVzdGlvbiBvbmx5IHRoZVxuICAgKiBzZXNzaW9uIGNhbiBhbnN3ZXIuIEV2ZXJ5dGhpbmcgZWxzZSBhYm91dCBzZWFyY2hpbmcgZmlsZXMsIGFuIGFnZW50IGNhblxuICAgKiBhbHJlYWR5IGRvIHdpdGggZ3JlcCwgd2hpY2ggaXMgd2h5IHRoZXJlIGlzIG5vIGluLWRvY3VtZW50IHZlcmIuXG4gICAqXG4gICAqIOKaoCBIaWRkZW4gZG9jdW1lbnRzIGFyZSBleGNsdWRlZCwgYmVjYXVzZSB0aGUgY29udGV4dCBpcyB3aGF0IHRoZSBodW1hblxuICAgKiBjaG9zZSB0byBsb29rIGF0OyBhIHJlc3VsdCB0aGV5IGNhbm5vdCBzZWUgaW4gdGhlIHNpZGViYXIgd291bGQgYmUgYSByZXN1bHRcbiAgICogdGhleSBjYW5ub3Qgb3Blbi5cbiAgICovXG4gIHNlYXJjaEFsbChvcHRzOiB7IHF1ZXJ5OiBzdHJpbmc7IGxpbWl0PzogbnVtYmVyIH0pOiBTZWFyY2hSZXBvcnQge1xuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IENhbmRpZGF0ZVtdID0gW107XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBkb2NQYXRocyhlbnRyeSkpIHtcbiAgICAgICAgaWYgKHNlZW4uaGFzKHBhdGgpKSBjb250aW51ZTtcbiAgICAgICAgc2Vlbi5hZGQocGF0aCk7XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IHBhdGgpO1xuICAgICAgICBjb25zdCB0aXRsZSA9IHJlYWRNZXRhKHJlYWRIZWFkKHBhdGgpKT8udGl0bGU7XG4gICAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XG4gICAgICAgICAgcGF0aCxcbiAgICAgICAgICBuYW1lOiBiYXNlbmFtZShwYXRoKSxcbiAgICAgICAgICAuLi4ocmVjb3JkID8geyBzbHVnOiByZWNvcmQuc2x1ZywgdmVyc2lvbjogcmVjb3JkLmFjdGl2ZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0aXRsZSA/IHsgdGl0bGUgfSA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBzZWFyY2hEb2N1bWVudHMoXG4gICAgICBjYW5kaWRhdGVzLFxuICAgICAgb3B0cy5xdWVyeSxcbiAgICAgIChjKSA9PiB7XG4gICAgICAgIC8vIFRoZSBBQ1RJVkUgVkVSU0lPTiB3aGVuIHRoZSBzZXNzaW9uIGhhcyBvbmUg4oCUIHNlZSB0aGUgbm90ZSBhYm92ZS5cbiAgICAgICAgY29uc3QgcmVjb3JkID1cbiAgICAgICAgICBjLnNsdWcgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gYy5zbHVnKTtcbiAgICAgICAgaWYgKHJlY29yZCkgcmV0dXJuIHRoaXMuYWN0aXZlVGV4dChyZWNvcmQpO1xuICAgICAgICByZXR1cm4gcmVhZEZpbGVTeW5jKGMucGF0aCwgXCJ1dGY4XCIpO1xuICAgICAgfSxcbiAgICAgIG9wdHMubGltaXQgIT09IHVuZGVmaW5lZCA/IHsgdG90YWw6IG9wdHMubGltaXQgfSA6IHt9LFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgbGluayBpbiBhIHNldCB0aGF0IG5vdGhpbmcgYW5zd2VycyDigJQgdGhlIHJlcG9ydCB5b3UgY2FuIEFDVCBvbiAoRTU0KS5cbiAgICpcbiAgICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBncmFwaGAgQUxSRUFEWSBIQUQgVEhFIEZBQ1RTIEFORCBTVElMTCBESUQgTk9UIEFOU1dFUlxuICAgKiBUSEUgUVVFU1RJT04uIENvbGUgYXNrZWQgd2hldGhlciBhbiBhZ2VudCBjYW4gY2hlY2sgZGFuZ2xpbmcgbGlua3M7IHRoZVxuICAgKiBob25lc3QgYW5zd2VyIHdhcyBcInllcywgYnkgZmV0Y2hpbmcgYSBzZXQncyB3aG9sZSBtYXAgYW5kIGZpbHRlcmluZyBzZXZlcmFsXG4gICAqIGh1bmRyZWQgZWRnZXNcIiwgd2hpY2ggaXMgYSBkaWZmZXJlbnQgdGhpbmcgZnJvbSBiZWluZyBhYmxlIHRvIGNoZWNrIHRoZW0uXG4gICAqIFRoaXMgc2F5cyBvbmx5IHdoYXQgaXMgYnJva2VuLCBhbmQgc2F5cyBpdCBhcyBgZmlsZTpsaW5lYCBwbHVzIFRIRSBTVFJJTkdcbiAgICogVEhFIERPQ1VNRU5UIEFDVFVBTExZIENPTlRBSU5TIOKAlCB3aGljaCBpcyB3aGF0IHlvdSBuZWVkIHRvIHJlcGFpciBvbmUsIGFuZFxuICAgKiB3aGF0IHRoZSBtYXAncyByZXNvbHZlZCBgdG9gIGhhZCBxdWlldGx5IHRocm93biBhd2F5LlxuICAgKlxuICAgKiDimqAgTk9UIEFOIEVSUk9SLiBBIGRhbmdsaW5nIGxpbmsgaXMgYSBmYWN0IGFib3V0IGEgc2V0LCBub3QgYSBmYWlsdXJlOiBPS0ZcbiAgICogwqcxMSdzIHJ1bGUsIGFuZCBpdCBpcyB3aHkgdGhpcyByZXBvcnRzIGFuZCBleGl0cyB6ZXJvLiBEb2N1bWVudHMgdGhhdCBwb2ludFxuICAgKiBhdCB0aGluZ3Mgbm90IHdyaXR0ZW4geWV0IGFyZSBub3JtYWwgaW4gYSB3b3JsZCBiaWJsZS5cbiAgICovXG4gIGRhbmdsaW5nTGlua3MoZW50cnlJZD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeUlkKTtcbiAgICBjb25zdCBicm9rZW4gPSBnLmVkZ2VzLmZpbHRlcigoZSkgPT4gZS5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIpO1xuICAgIC8vIOKblCBCT0RZIExJTkVTIEJFQ09NRSBGSUxFIExJTkVTIEhFUkUuIExpbmtzIGFyZSBleHRyYWN0ZWQgZnJvbSB0aGUgYm9keSxcbiAgICAvLyBzbyB0aGUgbnVtYmVyIHRoZSBncmFwaCBjYXJyaWVzIGlzIHNob3J0IGJ5IGhvd2V2ZXIgbXVjaCBmcm9udG1hdHRlciB0aGVcbiAgICAvLyBkb2N1bWVudCBoYXMg4oCUIGFuZCBhIHJlcG9ydCBpcyBmb3Igb3BlbmluZyBhIGZpbGUgYXQgYSBsaW5lLlxuICAgIGNvbnN0IG9mZnNldHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAgIGNvbnN0IG9mZnNldE9mID0gKHBhdGg6IHN0cmluZyk6IG51bWJlciA9PiB7XG4gICAgICBjb25zdCBrbm93biA9IG9mZnNldHMuZ2V0KHBhdGgpO1xuICAgICAgaWYgKGtub3duICE9PSB1bmRlZmluZWQpIHJldHVybiBrbm93bjtcbiAgICAgIGxldCBvZmYgPSAwO1xuICAgICAgdHJ5IHtcbiAgICAgICAgb2ZmID0gYm9keUxpbmVPZmZzZXQocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW5yZWFkYWJsZSDigJQgcmVwb3J0IHRoZSBib2R5IGxpbmUgcmF0aGVyIHRoYW4gbm90aGluZyAqL1xuICAgICAgfVxuICAgICAgb2Zmc2V0cy5zZXQocGF0aCwgb2ZmKTtcbiAgICAgIHJldHVybiBvZmY7XG4gICAgfTtcbiAgICByZXR1cm4ge1xuICAgICAgZW50cnk6IGcuZW50cnksXG4gICAgICByb290OiBnLnJvb3QsXG4gICAgICBjb3VudDogYnJva2VuLmxlbmd0aCxcbiAgICAgIGxpbmtzOiBicm9rZW4ubWFwKChlKSA9PiAoe1xuICAgICAgICBmcm9tOiBlLmZyb20sXG4gICAgICAgIC4uLihlLmxpbmUgIT09IHVuZGVmaW5lZCA/IHsgbGluZTogZS5saW5lICsgb2Zmc2V0T2YoZS5mcm9tKSB9IDoge30pLFxuICAgICAgICAvLyBXaGF0IHRoZSBkb2N1bWVudCBzYXlzLCBub3Qgd2hhdCB3ZSBsb29rZWQgZm9yLlxuICAgICAgICAuLi4oZS5yYXcgIT09IHVuZGVmaW5lZCA/IHsgd3JvdGU6IGUucmF3IH0gOiB7fSksXG4gICAgICAgIC8vIFdoZXJlIHRoZSByZXNvbHV0aW9uIGVuZGVkIHVwLCBzbyBhIG5lYXItbWlzcyBpcyB2aXNpYmxlLlxuICAgICAgICB0cmllZDogZS50byxcbiAgICAgICAgc291cmNlOiBlLnNvdXJjZSxcbiAgICAgICAgLi4uKGUua2V5ID8geyBrZXk6IGUua2V5IH0gOiB7fSksXG4gICAgICAgIC4uLihlLnJlbC5sZW5ndGggPyB7IHJlbDogZS5yZWwgfSA6IHt9KSxcbiAgICAgIH0pKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgY2l0ZXMgYSBkb2N1bWVudC4gYHJlbGF0ZWRgIChmcm9udG1hdHRlcikgYW5kIGBsaW5rc2AgKGJvZHkpIGFyZSBrZXB0XG4gICAqIEFQQVJULCB3aGljaCBpcyBob3cgcGRvY3MgcmVwb3J0cyBpdCBhbmQgdGhlIGRpc3RpbmN0aW9uIGlzIHJlYWw6IG9uZSBpcyBhXG4gICAqIGNsYWltIGFib3V0IHRoZSBkb2N1bWVudCwgdGhlIG90aGVyIGEgY2l0YXRpb24gaW4gcHJvc2UuXG4gICAqL1xuICBiYWNrbGlua3MocmF3UGF0aDogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSksXG4gICAgKTtcbiAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IGluc2lkZSBhIHNldCwgc28gbm90aGluZyBtYXBzIGl0YCwgNDAwKTtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeS5pZCk7XG4gICAgY29uc3QgaW5ib3VuZCA9IGcuZWRnZXMuZmlsdGVyKCh4KSA9PiB4LnRvID09PSBhYnMpO1xuICAgIGNvbnN0IHRpdGxlID0gKHA6IHN0cmluZykgPT4gZy5ub2Rlcy5maW5kKChuKSA9PiBuLnBhdGggPT09IHApPy50aXRsZSA/PyBiYXNlbmFtZShwKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGFyZ2V0OiB7IHBhdGg6IGFicywgdGl0bGU6IHRpdGxlKGFicykgfSxcbiAgICAgIHJlbGF0ZWQ6IGluYm91bmRcbiAgICAgICAgLmZpbHRlcigoeCkgPT4geC5zb3VyY2UgPT09IFwiZnJvbnRtYXR0ZXJcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwga2V5OiB4LmtleSB9KSksXG4gICAgICBsaW5rczogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJsaW5rXCIpXG4gICAgICAgIC5tYXAoKHgpID0+ICh7IHBhdGg6IHguZnJvbSwgdGl0bGU6IHRpdGxlKHguZnJvbSksIHJlbDogeC5yZWwgfSkpLFxuICAgICAgY291bnQ6IGluYm91bmQubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICAvKiogV2hlcmUgZG9lcyB0aGlzIGxpbmsgZ28/IFRoZSBzdXJmYWNlIGFza3MgYmVmb3JlIGZvbGxvd2luZyBvbmUgKEUzMykuICovXG4gIHJlc29sdmVMaW5rKGZyb206IHN0cmluZywgdGFyZ2V0OiBzdHJpbmcpOiBSZXNvbHV0aW9uIHtcbiAgICBjb25zdCBzcmMgPSB0aGlzLnNob3duUGF0aChmcm9tKTtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT4gZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgc3JjLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSxcbiAgICApO1xuICAgIGNvbnN0IHJvb3QgPSBlbnRyeT8ucm9vdCA/PyBkaXJuYW1lKHNyYyk7XG4gICAgY29uc3QgcGF0aHMgPSBlbnRyeSA/IGRvY1BhdGhzKGVudHJ5KSA6IFtzcmNdO1xuICAgIHJldHVybiByZXNvbHZlVGFyZ2V0KHRhcmdldCwgc3JjLCB7XG4gICAgICByb290LFxuICAgICAgcGF0aHMsXG4gICAgICBtZXRhT2Y6IChwKSA9PiByZWFkTWV0YShyZWFkSGVhZChwKSksXG4gICAgICBleGlzdHM6IChwKSA9PiBleGlzdHNTeW5jKHApLFxuICAgICAgcmVwb1Jvb3Q6IGdpdFJvb3RPZihyb290KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGF0IGEgZnJvbnRtYXR0ZXIgYmxvY2sgZm9yIHRoaXMgZG9jdW1lbnQgV09VTEQgc2F5IChFMzUpLiBTdWdnZXN0ZWQsIG5vdFxuICAgKiB3cml0dGVuOiB0aGUgdHlwZSBjb21lcyBmcm9tIHRoZSBkb2N1bWVudHMgYmVzaWRlIGl0LCB0aGUgdGl0bGUgZnJvbSBpdHNcbiAgICogb3duIEgxLCBhbmQgYGRlc2NyaXB0aW9uYCBpcyBsZWZ0IGJsYW5rIGZvciB3aG9ldmVyIGZpbGxzIGl0IGluLlxuICAgKi9cbiAgc3VnZ2VzdE1ldGEocmF3UGF0aDogc3RyaW5nLCBieT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBibG9jazogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ICE9PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBhbHJlYWR5IGhhcyBmcm9udG1hdHRlcmAsIDQwOSk7XG4gICAgY29uc3QgZm9sZGVyID0gZGlybmFtZShhYnMpO1xuICAgIGNvbnN0IHNpYmxpbmdzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgaWYgKHAgIT09IGFicyAmJiBkaXJuYW1lKHApID09PSBmb2xkZXIpIHtcbiAgICAgICAgICBjb25zdCB0ID0gcmVhZE1ldGEocmVhZEhlYWQocCkpPy50eXBlO1xuICAgICAgICAgIGlmICh0KSBzaWJsaW5ncy5wdXNoKHQpO1xuICAgICAgICB9XG4gICAgY29uc3QgdHlwZSA9IGd1ZXNzVHlwZShzaWJsaW5ncywgYmFzZW5hbWUoZm9sZGVyKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGg6IGFicyxcbiAgICAgIHR5cGUsXG4gICAgICBibG9jazogYnVpbGRCbG9jayh7XG4gICAgICAgIC4uLih0eXBlID8geyB0eXBlIH0gOiB7fSksXG4gICAgICAgIC4uLih0aXRsZUZyb21Cb2R5KHRleHQpID8geyB0aXRsZTogdGl0bGVGcm9tQm9keSh0ZXh0KSBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgLi4uKGJ5ID8geyBieSB9IDoge30pLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSBhIG5ldyBibG9jayBpbnRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAoRTM1KS5cbiAgICpcbiAgICog4puUIFRISVMgV1JJVEVTIFRIRSBPUklHSU5BTCwgd2hpY2ggRTcgb3RoZXJ3aXNlIHJlc2VydmVzIGZvciBTYXZlIOKAlCBhbmRcbiAgICogdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW4gb3ZlcnNpZ2h0OiB0aGUgYWdlbnQncyB2ZXJiIHdyaXRlcyB0aGUgZmlsZSwgYW5kXG4gICAqIGlmIHRoZSBodW1hbiBoYXMgdW5zYXZlZCBlZGl0cyB0byBpdCB0aGUgQ09ORkxJQ1QgQkFSIGFwcGVhcnMgYW5kIHRoZXlcbiAgICogY2hvb3NlIChDb2xlOiBcIndlIGNhbiBhZGp1c3QgaWYgbmVlZGVkIGFmdGVyIGdldHRpbmcgYWN0dWFsIHVzYWdlIGJlaGluZFxuICAgKiB1c1wiKS4gUmVmdXNpbmcgd2hpbGUgYSBidWZmZXIgaXMgZGlydHkgd291bGQgbGV0IGFuIG9wZW4gZG9jdW1lbnQgYmxvY2sgdGhlXG4gICAqIGFnZW50IGluZGVmaW5pdGVseS4gVGhlIEhVTUFOJ3Mgb3duIHBhdGggbmV2ZXIgY29tZXMgaGVyZTogdGhlaXIgXCJhZGRcbiAgICogZnJvbnRtYXR0ZXJcIiBpcyBhbiBlZGl0IHRvIHRoZWlyIGJ1ZmZlciwgd2hpY2ggU2F2ZSB3cml0ZXMgbGlrZSBhbnkgb3RoZXIuXG4gICAqL1xuICBtZXRhSW5pdChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmcgfSA9IHt9KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IHN1Z2dlc3RlZCA9IHRoaXMuc3VnZ2VzdE1ldGEocmF3UGF0aCwgb3B0cy5ieSk7XG4gICAgY29uc3QgYWJzID0gc3VnZ2VzdGVkLnBhdGg7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBjb25zdCBibG9jayA9IG9wdHMudHlwZVxuICAgICAgPyBidWlsZEJsb2NrKHtcbiAgICAgICAgICB0eXBlOiBvcHRzLnR5cGUsXG4gICAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAgIC4uLihvcHRzLmJ5ID8geyBieTogb3B0cy5ieSB9IDoge30pLFxuICAgICAgICB9KVxuICAgICAgOiBzdWdnZXN0ZWQuYmxvY2s7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHdpdGhCbG9jayh0ZXh0LCBibG9jaykpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgdHlwZTogb3B0cy50eXBlID8/IHN1Z2dlc3RlZC50eXBlID8/IG51bGwsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogU2V0IGtleXMgaW4gYW4gZXhpc3RpbmcgYmxvY2sg4oCUIGEgTElORSBlZGl0IGVhY2gsIHNvIG5vdGhpbmcgZWxzZSBtb3Zlcy4gKi9cbiAgbWV0YVNldChyYXdQYXRoOiBzdHJpbmcsIHBhaXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGxldCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGlmIChzcGxpdEZyb250bWF0dGVyKHRleHQpLnJhdyA9PT0gbnVsbClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YmFzZW5hbWUoYWJzKX0gaGFzIG5vIGZyb250bWF0dGVyIOKAlCBhZGQgaXQgZmlyc3QgKG1ldGEtaW5pdClgLCA0MDkpO1xuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBhaXJzKSkge1xuICAgICAgaWYgKCEvXltBLVphLXpfXVtBLVphLXowLTlfLi1dKiQvLnRlc3Qoa2V5KSlcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke2tleX1cIiBpcyBub3QgYSBmcm9udG1hdHRlciBrZXlgLCA0MDApO1xuICAgICAgdGV4dCA9IHNldEtleSh0ZXh0LCBrZXksIHZhbHVlKTtcbiAgICB9XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgc2V0OiBPYmplY3Qua2V5cyhwYWlycykgfTtcbiAgfVxuXG4gIC8qKiBUaGUgc2Vzc2lvbidzIGhhbGYgb2YgYFB1YmxpY1N0YXRlYDsgdGhlIGRhZW1vbiBhZGRzIHRoZSBob21lLWxldmVsIGBwcmVmc2AgYW5kIGB1c2VySG9tZWAuICovXG4gIC8qKlxuICAgKiBUaGUgY29udmVyc2F0aW9uLCB3aXRob3V0IGJ1aWxkaW5nIGEgc25hcHNob3QgYXJvdW5kIGl0LlxuICAgKlxuICAgKiDimqAgRTUzJ3MgYXR0ZW50aW9uIHRpY2sgcnVucyBldmVyeSBzZWNvbmQgYW5kIG9ubHkgbmVlZHMgdGhlIGNoYXQ7IGNhbGxpbmdcbiAgICogYHZpZXcoKWAgZm9yIGl0IHdvdWxkIHJlLXJlYWQgZXZlcnkgZG9jdW1lbnQncyBmcm9udG1hdHRlciBvbiBhIHRpbWVyLlxuICAgKi9cbiAgbWVzc2FnZXMoKTogcmVhZG9ubHkgQ2hhdE1lc3NhZ2VbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jaGF0O1xuICB9XG5cbiAgdmlldyhcbiAgICBtb2RlOiBcImRldlwiIHwgXCJyZWxlYXNlXCIsXG4gICAgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsLFxuICAgIC8vIOKaoCBgd2FpdGluZ2AgaXMgdGhlIFNFUlZFUidzIHRvIGFkZCAoRTUzKTogaXQgZGVwZW5kcyBvbiB0aGUgY2xvY2sgYW5kIG9uXG4gICAgLy8gdGhlIHNub296ZSB0aGUgc2VydmVyIGhvbGRzLCBuZWl0aGVyIG9mIHdoaWNoIGJlbG9uZ3MgaW4gdGhlIHNlc3Npb24uXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBhbmQgYGhpc3RvcnlgIGFyZSB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMsIEU2MCk6IG9uZSBkZXBlbmRzXG4gICAgLy8gb24gdGhlIGNsb2NrIGFuZCB0aGUgc25vb3plIGl0IGhvbGRzLCB0aGUgb3RoZXIgb24gdGhlIGluLW1lbW9yeSBhY3RcbiAgICAvLyBzdGFja3MuIE5laXRoZXIgYmVsb25ncyBpbiB0aGUgc2Vzc2lvbidzIHBlcnNpc3RlZCBzdGF0ZS4gRTY1J3NcbiAgICAvLyBgbm90ZXNXYWl0aW5nYCBpcyB0aGUgc2VydmVyJ3MgZm9yIGB3YWl0aW5nYCdzIHJlYXNvbnMuXG4gICk6IE9taXQ8UHVibGljU3RhdGUsIFwicHJlZnNcIiB8IFwidXNlckhvbWVcIiB8IFwid2FpdGluZ1wiIHwgXCJub3Rlc1dhaXRpbmdcIiB8IFwiaGlzdG9yeVwiPiB7XG4gICAgY29uc3QgbWV0YSA9IHRoaXMuY29udGV4dE1ldGEoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2Vzc2lvbklkOiB0aGlzLm0uc2Vzc2lvbklkLFxuICAgICAgaG9tZTogdGhpcy5ob21lLFxuICAgICAgd29ya3NwYWNlOiB0aGlzLndvcmtzcGFjZSxcbiAgICAgIGRvY01ldGE6IG1ldGEubWFwLFxuICAgICAgLi4uKG1ldGEudHJ1bmNhdGVkID8geyBkb2NNZXRhVHJ1bmNhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICBtb2RlLFxuICAgICAgY29udGV4dDogdGhpcy5tLmNvbnRleHQsXG4gICAgICBkb2NzOiB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IHRoaXMuZG9jVmlldyhkKSksXG4gICAgICBvcGVuRG9jOiB0aGlzLm0ub3BlbkRvYyxcbiAgICAgIHNlbGVjdGlvbixcbiAgICAgIGNoYXQ6IHRoaXMubS5jaGF0LFxuICAgICAgdGFza3M6IHRoaXMudGFza3MoKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogVGhlIGdpdCB3b3JraW5nIHRyZWUgYGRpcmAgaXMgaW4sIG9yIG51bGwuIEEgYC5naXRgIEVOVFJZLCBub3QgYSBkaXJlY3RvcnlcbiAqIHRlc3Q6IGEgd29ya3RyZWUgYW5kIGEgc3VibW9kdWxlIGJvdGggaGF2ZSBgLmdpdGAgYXMgYSBGSUxFLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2l0Um9vdE9mKGRpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGxldCBhdCA9IGRpcjtcbiAgZm9yICg7Oykge1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYXQsIFwiLmdpdFwiKSkpIHJldHVybiBhdDtcbiAgICBjb25zdCB1cCA9IGRpcm5hbWUoYXQpO1xuICAgIGlmICh1cCA9PT0gYXQpIHJldHVybiBudWxsO1xuICAgIGF0ID0gdXA7XG4gIH1cbn1cblxuLyoqIERvY3VtZW50cyB1bmRlciBhIGZvbGRlciwgZm9yIHNheWluZyBob3cgbXVjaCBhIG1vdmUgbW92ZXMuICovXG5mdW5jdGlvbiBjb3VudERvY3MoZGlyOiBzdHJpbmcpOiBudW1iZXIge1xuICBsZXQgbiA9IDA7XG4gIGNvbnN0IHdhbGsgPSAoYXQ6IHN0cmluZykgPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoYXQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oYXQsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkgd2FsayhhYnMpO1xuICAgICAgZWxzZSBpZiAoaXNEb2NOYW1lKG5hbWUpKSBuKys7XG4gICAgfVxuICB9O1xuICB3YWxrKGRpcik7XG4gIHJldHVybiBuO1xufVxuXG4vKipcbiAqIEhvdyBhIGNvbXBhcmlzb24gc2lkZSByZWFkcyBpbiBhIG1lc3NhZ2UgdG8gYSBodW1hbiBvciBhbiBhZ2VudC5cbiAqXG4gKiDim5QgVEhFIEZJTEUgSVMgTkFNRUQsIE5PVCBERVNDUklCRUQgKEU0MywgcmV2aXNlZCkuIFwiVGhlIG9yaWdpbmFsXCIgc291bmRlZFxuICogdGVtcG9yYWwgd2hlbiB0aGUgdGhpbmcgaXMgbG9jYXRpb25hbDsgXCJ0aGUgc2F2ZWQgZmlsZVwiIGZpeGVkIHRoYXQgYnV0IHJlYWRzXG4gKiBjaXJjdWxhciB0aGUgbW9tZW50IGl0IGlzIGEgREVTVElOQVRJT04g4oCUIFwic2F2ZSB0byB0aGUgc2F2ZWQgZmlsZVwiIHNheXNcbiAqIG5vdGhpbmcuIE5vIG5vdW4gZW5jYXBzdWxhdGVzIFwidGhpcyBmaWxlLCBhdCB0aGlzIHBsYWNlXCIsIHNvIHRoZSBmaWxlIGdldHNcbiAqIGl0cyBvd24gbmFtZTogYG5vdGUubWRgLiBDb2xlOiBcInRoYXQncyBwcm9iYWJseSBjbG9zZXIgdG8gdGhlIHJpZ2h0IGFuc3dlclxuICogdmVyc3VzIHRyeWluZyB0byBjb21lIHVwIHdpdGggYSB3b3JkIHRoYXQgZW5jYXBzdWxhdGVzIGl0LlwiXG4gKlxuICogYGZpbGVgIGlzIHRoZSBkb2N1bWVudCdzIG5hbWUgd2hlbiB0aGUgY2FsbGVyIGtub3dzIGl0OyB3aXRob3V0IG9uZSB0aGlzXG4gKiBmYWxscyBiYWNrIHRvIGEgZ2VuZXJpYywgd2hpY2ggaXMgb25seSBmb3IgY29udGV4dHMgdGhhdCBoYXZlIG5vIGRvY3VtZW50IGluXG4gKiBoYW5kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2lkZU5hbWUoc2lkZTogRGlmZlNpZGUsIGZpbGU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoc2lkZSAhPT0gXCJvcmlnaW5hbFwiKSByZXR1cm4gYHYke3NpZGV9YDtcbiAgcmV0dXJuIGZpbGUgPz8gXCJ0aGUgc2F2ZWQgZmlsZVwiO1xufVxuIiwKICAgICIvKipcbiAqIE9LRiBmcm9udG1hdHRlciwgcmVhZCAoRTMyKS4gVGhlIGRhZW1vbiBwYXJzZXM7IHRoZSBzdXJmYWNlIHJlbmRlcnMgd2hhdCBpdFxuICogaXMgZ2l2ZW4g4oCUIGBCdW4uWUFNTC5wYXJzZWAgaXMgaGVyZSwgc28gbm8gWUFNTCBwYXJzZXIgcmVhY2hlcyB0aGUgYnJvd3Nlci5cbiAqXG4gKiDim5QgVEhFIFNQRUMnUyBURU1QRVIgSVMgVEhFIFBPSU5ULCBBTkQgSVQgSVMgTk9UIFRIRSBVU1VBTCBPTkUuIEEgY29uc3VtZXJcbiAqIFwiTVVTVCBOT1QgcmVqZWN0IGRvY3VtZW50c1wiIGZvciB1bmtub3duIHR5cGVzLCB1bmtub3duIGtleXMsIG1pc3Npbmcgb3B0aW9uYWxcbiAqIGZpZWxkcyBvciBicm9rZW4gbGlua3MsIGFuZCBcIlNIT1VMRCBwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4gKiAoT0tGIDAuMiDCpzExKS4gU28gbm90aGluZyBoZXJlIHZhbGlkYXRlczogYSBkb2N1bWVudCB3aG9zZSBmcm9udG1hdHRlciB3aWxsXG4gKiBub3QgcGFyc2Uga2VlcHMgaXRzIHRleHQgYW5kIHJlcG9ydHMgdGhlIHJlYXNvbiwgZXZlcnkga2V5IHN1cnZpdmVzIGluXG4gKiBgZmllbGRzYCB3aGV0aGVyIG9yIG5vdCB0aGlzIHNwZWxsIGhhcyBoZWFyZCBvZiBpdCwgYW5kIGB0eXBlYCDigJQgdGhlIE9ORVxuICogcmVxdWlyZWQgZmllbGQg4oCUIGJlaW5nIGFic2VudCBpcyBhIGZhY3QgdG8gc2hvdywgbmV2ZXIgYW4gZXJyb3IgdG8gcmFpc2UuXG4gKlxuICogVGhlIERFUklWRUQgdmFsdWVzICh0cnVzdCwgc3RhbGVuZXNzKSBhcmUgY29tcHV0ZWQgb24gcmVhZCBhbmQgbmV2ZXIgc3RvcmVkLFxuICogd2hpY2ggaXMgYWxzbyB0aGUgc3BlYydzIHJ1bGU6IGEgdHJ1c3QgdGllciB3cml0dGVuIGludG8gYSBmaWxlIHdvdWxkIGJlIGFcbiAqIGNsYWltIGFib3V0IGl0c2VsZi5cbiAqL1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhLCBEb2NTdW1tYXJ5LCBUcnVzdFRpZXIgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogQSBmcm9udG1hdHRlciBibG9jazogYC0tLWAgb24gaXRzIG93biBmaXJzdCBsaW5lLCB0byB0aGUgbmV4dCBgLS0tYCBsaW5lLiAqL1xuY29uc3QgQkxPQ0sgPSAvXi0tLVxccj9cXG4oW1xcc1xcU10qPylcXHI/XFxuLS0tWyBcXHRdKig/Olxccj9cXG58JCkvO1xuXG4vKipcbiAqIFNwbGl0IGEgZG9jdW1lbnQgaW50byBpdHMgcmF3IGZyb250bWF0dGVyIGJsb2NrIGFuZCB0aGUgYm9keSBiZW5lYXRoIGl0LlxuICogUHVyZSBzdHJpbmcgd29yaywgbm8gWUFNTCDigJQgdGhlIFNVUkZBQ0UgaGFzIHRoZSBzYW1lIGZ1bmN0aW9uIChpdCBtdXN0IHN0cmlwXG4gKiB0aGUgYmxvY2sgYmVmb3JlIHJlbmRlcmluZykgYW5kIGBmcm9udG1hdHRlci50ZXN0LnRzYCBob2xkcyB0aGUgdHdvIGVxdWFsLlxuICovXG4vKipcbiAqIEhvdyBtYW55IGxpbmVzIG9mIGEgZG9jdW1lbnQgY29tZSBCRUZPUkUgaXRzIGJvZHkg4oCUIHRoZSBmcm9udG1hdHRlciBibG9jayBhbmRcbiAqIGl0cyBkZWxpbWl0ZXJzLlxuICpcbiAqIOKblCBXSVRIT1VUIFRISVMgQSBSRVBPUlRFRCBMSU5FIE5VTUJFUiBJUyBBIExJRS4gTGlua3MgYXJlIGV4dHJhY3RlZCBmcm9tIHRoZVxuICogQk9EWSwgc28gYSBsaW5rIG9uIGJvZHkgbGluZSA5IG9mIGEgZG9jdW1lbnQgd2l0aCBmb3VyIGxpbmVzIG9mIGZyb250bWF0dGVyXG4gKiBpcyBvbiBGSUxFIGxpbmUgMTMg4oCUIGFuZCBhIHJlcG9ydCB0aGF0IHNheXMgOSBzZW5kcyB3aG9ldmVyIGlzIGZpeGluZyBpdCB0b1xuICogdGhlIHdyb25nIHBsYWNlLCBjb25maWRlbnRseS4gQ2F1Z2h0IHRoZSBtb21lbnQgRTU0J3MgcmVwb3J0IHdhcyBmaXJzdCByZWFkXG4gKiBhZ2FpbnN0IGEgZG9jdW1lbnQgdGhhdCBoYWQgZnJvbnRtYXR0ZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBib2R5TGluZU9mZnNldCh0ZXh0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB7IGJvZHkgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGNvbnN0IHByZWZpeCA9IHRleHQuc2xpY2UoMCwgdGV4dC5sZW5ndGggLSBib2R5Lmxlbmd0aCk7XG4gIGxldCBsaW5lcyA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcHJlZml4Lmxlbmd0aDsgaSsrKSBpZiAocHJlZml4LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBsaW5lcysrO1xuICByZXR1cm4gbGluZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdEZyb250bWF0dGVyKHRleHQ6IHN0cmluZyk6IHsgcmF3OiBzdHJpbmcgfCBudWxsOyBib2R5OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG0gPSBCTE9DSy5leGVjKHRleHQpO1xuICBpZiAoIW0pIHJldHVybiB7IHJhdzogbnVsbCwgYm9keTogdGV4dCB9O1xuICByZXR1cm4geyByYXc6IG1bMV0gPz8gXCJcIiwgYm9keTogdGV4dC5zbGljZShtWzBdLmxlbmd0aCkgfTtcbn1cblxuLyoqIE9LRidzIHRocmVlLCBhbmQgYW55dGhpbmcgZWxzZSBhIHByb2R1Y2VyIHdyb3RlLiBgc3RhYmxlYCBpcyB0aGUgZGVmYXVsdC4gKi9cbmZ1bmN0aW9uIHN0YXR1c09mKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuICBjb25zdCBzID0gZmllbGRzLnN0YXR1cztcbiAgcmV0dXJuIHR5cGVvZiBzID09PSBcInN0cmluZ1wiICYmIHMudHJpbSgpICE9PSBcIlwiID8gcyA6IFwic3RhYmxlXCI7XG59XG5cbmNvbnN0IGFzTGlzdCA9ICh2OiB1bmtub3duKTogc3RyaW5nW10gPT5cbiAgQXJyYXkuaXNBcnJheSh2KSA/IHYuZmlsdGVyKCh4KSA9PiB0eXBlb2YgeCA9PT0gXCJzdHJpbmdcIikgOiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IFt2XSA6IFtdO1xuXG4vKiogQW4gYWN0b3IgaXMgaHVtYW4gaWZmIGl0IGlzIHNwZWxsZWQgYGh1bWFuOjxpZD5gIOKAlCBPS0YgMC4yIMKnNidzIHJ1bGUuICovXG5jb25zdCBpc0h1bWFuID0gKGFjdG9yOiB1bmtub3duKTogYm9vbGVhbiA9PlxuICB0eXBlb2YgYWN0b3IgPT09IFwic3RyaW5nXCIgJiYgYWN0b3IudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKFwiaHVtYW46XCIpO1xuXG4vKipcbiAqIE9LRidzIHRydXN0IHRpZXJzLCBERVJJVkVEOiBubyBgdmVyaWZpZWRgIOKGkiB1bnZlcmlmaWVkOyB2ZXJpZmllZCBieSBtYWNoaW5lc1xuICogb25seSDihpIgbWFjaGluZS1jb25maXJtZWQ7IHZlcmlmaWVkIGJ5IGEgYGh1bWFuOjxpZD5gIOKGkiBodW1hbi1yZXZpZXdlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRydXN0VGllcihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogVHJ1c3RUaWVyIHtcbiAgY29uc3QgdmVyaWZpZWQgPSBmaWVsZHMudmVyaWZpZWQ7XG4gIGNvbnN0IGV2ZW50cyA9IEFycmF5LmlzQXJyYXkodmVyaWZpZWQpID8gdmVyaWZpZWQgOiB2ZXJpZmllZCA/IFt2ZXJpZmllZF0gOiBbXTtcbiAgaWYgKGV2ZW50cy5sZW5ndGggPT09IDApIHJldHVybiBcInVudmVyaWZpZWRcIjtcbiAgZm9yIChjb25zdCBlIG9mIGV2ZW50cylcbiAgICBpZiAoZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBpc0h1bWFuKChlIGFzIHsgYnk/OiB1bmtub3duIH0pLmJ5KSkgcmV0dXJuIFwiaHVtYW4tcmV2aWV3ZWRcIjtcbiAgcmV0dXJuIFwibWFjaGluZS1jb25maXJtZWRcIjtcbn1cblxuLyoqIGBzdGFsZV9hZnRlcmAgaXMgYW4gSU5TVEFOVCwgbm90IGEgVFRMOiBzdGFsZSB3aGVuIG5vdyA+PSBpdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N0YWxlKGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG5vdzogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF0ID0gZmllbGRzLnN0YWxlX2FmdGVyO1xuICBjb25zdCB0ID1cbiAgICBhdCBpbnN0YW5jZW9mIERhdGUgPyBhdC5nZXRUaW1lKCkgOiB0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIgPyBEYXRlLnBhcnNlKGF0KSA6IE51bWJlci5OYU47XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgbm93ID49IHQ7XG59XG5cbi8qKiBXaGVuIHRoZSBjb250ZW50IGxhc3QgbWVhbmluZ2Z1bGx5IGNoYW5nZWQsIHBlciBgZ2VuZXJhdGVkLmF0YCwgYXMgYW4gSVNPIGRhdGUuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVkQXQoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBnID0gZmllbGRzLmdlbmVyYXRlZDtcbiAgY29uc3QgYXQgPSBnICYmIHR5cGVvZiBnID09PSBcIm9iamVjdFwiID8gKGcgYXMgeyBhdD86IHVua25vd24gfSkuYXQgOiB1bmRlZmluZWQ7XG4gIGlmIChhdCBpbnN0YW5jZW9mIERhdGUpIHJldHVybiBhdC50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgaWYgKHR5cGVvZiBhdCA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IHQgPSBEYXRlLnBhcnNlKGF0KTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpID8gbmV3IERhdGUodCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCkgOiBhdDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuY29uc3Qgc3RyID0gKHY6IHVua25vd24pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cbiAgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi50cmltKCkgIT09IFwiXCIgPyB2LnRyaW0oKSA6IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBSZWFkIGEgZG9jdW1lbnQncyBmcm9udG1hdHRlci4gUmV0dXJucyBudWxsIHdoZW4gdGhlcmUgaXMgbm8gYmxvY2sgYXQgYWxsIOKAlFxuICogd2hpY2ggaXMgYSBub3JtYWwgZG9jdW1lbnQsIG5vdCBhIGRlZmVjdC4gQSBibG9jayB0aGF0IHdpbGwgbm90IHBhcnNlIGNvbWVzXG4gKiBiYWNrIHdpdGggYGVycm9yYCBzZXQgYW5kIGV2ZXJ5IG90aGVyIGZpZWxkIGVtcHR5OiBzYWlkLCBub3Qgc3dhbGxvd2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZE1ldGEodGV4dDogc3RyaW5nLCBub3cgPSBEYXRlLm5vdygpKTogRG9jTWV0YSB8IG51bGwge1xuICBjb25zdCB7IHJhdyB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGxldCBmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGxldCBlcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEJ1bi5ZQU1MLnBhcnNlKHJhdykgYXMgdW5rbm93bjtcbiAgICBpZiAocGFyc2VkICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocGFyc2VkKSlcbiAgICAgIGZpZWxkcyA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBlbHNlIGlmIChwYXJzZWQgIT09IG51bGwgJiYgcGFyc2VkICE9PSB1bmRlZmluZWQpXG4gICAgICBlcnJvciA9IFwidGhlIGZyb250bWF0dGVyIGlzIG5vdCBhIG1hcHBpbmcgb2Yga2V5cyB0byB2YWx1ZXNcIjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGVycm9yID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlLnNwbGl0KFwiXFxuXCIpWzBdIDogU3RyaW5nKGUpO1xuICB9XG4gIHJldHVybiB7XG4gICAgcmF3LFxuICAgIGZpZWxkcyxcbiAgICB0eXBlOiBzdHIoZmllbGRzLnR5cGUpLFxuICAgIHRpdGxlOiBzdHIoZmllbGRzLnRpdGxlKSxcbiAgICBkZXNjcmlwdGlvbjogc3RyKGZpZWxkcy5kZXNjcmlwdGlvbiksXG4gICAgc3RhdHVzOiBzdGF0dXNPZihmaWVsZHMpLFxuICAgIHRhZ3M6IGFzTGlzdChmaWVsZHMudGFncyksXG4gICAgbGlmZWN5Y2xlOiBzdHIoZmllbGRzLmxpZmVjeWNsZSksXG4gICAgdHJ1c3Q6IHRydXN0VGllcihmaWVsZHMpLFxuICAgIHN0YWxlOiBpc1N0YWxlKGZpZWxkcywgbm93KSxcbiAgICBkYXRlOiBnZW5lcmF0ZWRBdChmaWVsZHMpLFxuICAgIC4uLihlcnJvciA/IHsgZXJyb3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIFRoZSBzbWFsbCBzaGFwZSB0aGUgc2lkZWJhciBuZWVkcyBmb3IgZXZlcnkgY29udGV4dCBkb2N1bWVudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemUobWV0YTogRG9jTWV0YSB8IG51bGwpOiBEb2NTdW1tYXJ5IHwgbnVsbCB7XG4gIGlmICghbWV0YSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgLi4uKG1ldGEudHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgLi4uKG1ldGEudGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSksXG4gICAgc3RhdHVzOiBtZXRhLnN0YXR1cyxcbiAgICB0YWdzOiBtZXRhLnRhZ3MsXG4gICAgdHJ1c3Q6IG1ldGEudHJ1c3QsXG4gICAgc3RhbGU6IG1ldGEuc3RhbGUsXG4gICAgLi4uKG1ldGEubGlmZWN5Y2xlID8geyBsaWZlY3ljbGU6IG1ldGEubGlmZWN5Y2xlIH0gOiB7fSksXG4gICAgLi4uKG1ldGEuZXJyb3IgPyB7IGVycm9yOiBtZXRhLmVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBwZG9jcydzIGZpbHRlciB2b2NhYnVsYXJ5LCBzbyB3aGF0IHRoZSBodW1hbiBsZWFybnMgdGhlcmUgaG9sZHMgaGVyZS4gKi9cbmV4cG9ydCB0eXBlIE1ldGFGaWx0ZXIgPSB7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgbGlmZWN5Y2xlPzogc3RyaW5nO1xuICB0YWc/OiBzdHJpbmc7XG4gIC8qKiBBbiBJU08gZGF0ZTsgbWF0Y2hlcyBkb2N1bWVudHMgd2hvc2UgYGdlbmVyYXRlZC5hdGAgaXMgb24gb3IgYWZ0ZXIgaXQuICovXG4gIHNpbmNlPzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBGaWx0ZXJzIGFyZSBBTkRlZCwgYW5kIGV2ZXJ5IG9uZSBpcyBvcHRpb25hbCDigJQgYSBiYXJlIGZpbHRlciBtYXRjaGVzIGFsbC5cbiAqXG4gKiDim5QgQSBET0NVTUVOVCBXSVRIIE5PIEZST05UTUFUVEVSIE1BVENIRVMgT05MWSBUSEUgRU1QVFkgRklMVEVSLCBhbmQgdGhhdFxuICogaW5jbHVkZXMgYC0tc3RhdHVzIHN0YWJsZWAuIEFic2VudCBgc3RhdHVzYCBkZWZhdWx0cyB0byBgc3RhYmxlYCBmb3IgYW4gT0tGXG4gKiBkb2N1bWVudCAowqc1KSwgYnV0IGEgZG9jdW1lbnQgd2l0aCBubyBibG9jayBhdCBhbGwgaXMgbm90IG1ha2luZyB0aGUgY2xhaW06XG4gKiBgZmluZCAtLXN0YXR1cyBzdGFibGVgIGFza3Mgd2hpY2ggZG9jdW1lbnRzIFNBWSB0aGV5IGFyZSBzdGFibGUsIGFuZCBhIGZpbGVcbiAqIHdpdGggbm8gZnJvbnRtYXR0ZXIgc2F5cyBub3RoaW5nLiBSZWFkaW5nIHRoZSBkZWZhdWx0IHRoZSBvdGhlciB3YXkgd291bGQgcHV0XG4gKiBldmVyeSB1bnRvdWNoZWQgbm90ZSBpbiB0aGUgcmVzdWx0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc0ZpbHRlcihtZXRhOiBEb2NNZXRhIHwgbnVsbCwgZmlsdGVyOiBNZXRhRmlsdGVyKTogYm9vbGVhbiB7XG4gIGlmIChtZXRhID09PSBudWxsKSByZXR1cm4gT2JqZWN0LnZhbHVlcyhmaWx0ZXIpLmV2ZXJ5KCh2KSA9PiB2ID09PSB1bmRlZmluZWQpO1xuICBpZiAoZmlsdGVyLnR5cGUgIT09IHVuZGVmaW5lZCAmJiBtZXRhLnR5cGUgIT09IGZpbHRlci50eXBlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc3RhdHVzICE9PSB1bmRlZmluZWQgJiYgbWV0YS5zdGF0dXMgIT09IGZpbHRlci5zdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5saWZlY3ljbGUgIT09IHVuZGVmaW5lZCAmJiBtZXRhLmxpZmVjeWNsZSAhPT0gZmlsdGVyLmxpZmVjeWNsZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnRhZyAhPT0gdW5kZWZpbmVkICYmICFtZXRhLnRhZ3MuaW5jbHVkZXMoZmlsdGVyLnRhZykpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci5zaW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFtZXRhLmRhdGUpIHJldHVybiBmYWxzZTtcbiAgICBpZiAobWV0YS5kYXRlIDwgZmlsdGVyLnNpbmNlKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIOKUgOKUgCBXUklUSU5HIChFMzUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBFVkVSWSBXUklURSBIRVJFIElTIEEgVEVYVCBFRElULCBORVZFUiBBIFJFU0VSSUFMSVNBVElPTi4gUGFyc2luZyBhIGJsb2NrXG4vLyBhbmQgcHJpbnRpbmcgaXQgYmFjayByZW9yZGVycyBrZXlzLCBkcm9wcyBjb21tZW50cyBhbmQgY2hhbmdlcyBxdW90aW5nIOKAlCBhbmRcbi8vIHRoZSBzcGVjIGFza3MgYSBjb25zdW1lciB0byBcInByZXNlcnZlIHVua25vd24ga2V5cyB3aGVuIHJvdW5kLXRyaXBwaW5nXCJcbi8vICjCpzExKSwgd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgdGhhdCBsb3Nlcy4gU28gYSBuZXcgYmxvY2sgaXMgQlVJTFQgKHRoZXJlIGlzXG4vLyBub3RoaW5nIHRvIHByZXNlcnZlIHlldCkgYW5kIGFuIGV4aXN0aW5nIG9uZSBpcyBlZGl0ZWQgYSBMSU5FIGF0IGEgdGltZS5cblxuLyoqIFRoZSBkb2N1bWVudCdzIGZpcnN0IEgxLCB3aGljaCBpcyB0aGUgdGl0bGUgYSBodW1hbiBhbHJlYWR5IHdyb3RlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpdGxlRnJvbUJvZHkoYm9keTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGJvZHkuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtID0gL14jXFxzKyguKz8pXFxzKiQvLmV4ZWMobGluZSk7XG4gICAgaWYgKG0pIHJldHVybiBtWzFdO1xuICAgIGlmIChsaW5lLnRyaW0oKSAhPT0gXCJcIiAmJiAhbGluZS5zdGFydHNXaXRoKFwiI1wiKSkgYnJlYWs7IC8vIHByb3NlIGJlZm9yZSBhbnkgaGVhZGluZ1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogQSBgdHlwZWAgdG8gU1VHR0VTVCBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLlxuICpcbiAqIOKblCBGUk9NIFRIRSBORUlHSEJPVVJTLCBORVZFUiBGUk9NIEEgRklYRUQgTElTVC4gT0tGJ3MgYHR5cGVgIGlzIFwibm90XG4gKiBjZW50cmFsbHkgcmVnaXN0ZXJlZFwiIGFuZCBldmVyeSBjb3JwdXMgaW52ZW50cyBpdHMgb3duIOKAlCBgcmVwb3J0YCwgYHJ1bGVgLFxuICogYGFyY2hldHlwZWAgaW4gb25lLCBzb21ldGhpbmcgZWxzZSBpbiB0aGUgbmV4dCDigJQgc28gdGhlIG9ubHkgaG9uZXN0IHNvdXJjZSBpc1xuICogd2hhdCB0aGUgZG9jdW1lbnRzIGJlc2lkZSB0aGlzIG9uZSBhbHJlYWR5IHNheS4gVGhlIGZvbGRlcidzIG5hbWUgaXMgdGhlXG4gKiBmYWxsYmFjaywgYW5kIHdoZW4gbmVpdGhlciBhbnN3ZXJzLCBub3RoaW5nIGlzIHN1Z2dlc3RlZDogYSBibGFuayB0aGUgaHVtYW5cbiAqIGZpbGxzIGJlYXRzIGEgcGxhdXNpYmxlIGd1ZXNzIChTQ0hFTUEubWQncyBvd24gcnVsZSBhYm91dCBgZ2VuZXJhdGVkLmJ5YCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBndWVzc1R5cGUoc2libGluZ1R5cGVzOiByZWFkb25seSBzdHJpbmdbXSwgZm9sZGVyOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc2libGluZ1R5cGVzKSBpZiAodCkgY291bnRzLnNldCh0LCAoY291bnRzLmdldCh0KSA/PyAwKSArIDEpO1xuICBjb25zdCBiZXN0ID0gWy4uLmNvdW50cy5lbnRyaWVzKCldLnNvcnQoKGEsIGIpID0+IGJbMV0gLSBhWzFdIHx8IGFbMF0ubG9jYWxlQ29tcGFyZShiWzBdKSlbMF07XG4gIGlmIChiZXN0KSByZXR1cm4gYmVzdFswXTtcbiAgY29uc3QgbmFtZSA9IGZvbGRlci50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5hbWUgPT09IFwiXCIgfHwgbmFtZSA9PT0gXCIuXCIgfHwgbmFtZSA9PT0gXCIvXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIC8vIGBkZWNpc2lvbnMvYCDihpIgYGRlY2lzaW9uYDsgYGRvY3MvYCDihpIgYGRvY2AuIEEgcGx1cmFsIGZvbGRlciBuYW1lcyBpdHMga2luZC5cbiAgcmV0dXJuIG5hbWUuZW5kc1dpdGgoXCJpZXNcIilcbiAgICA/IGAke25hbWUuc2xpY2UoMCwgLTMpfXlgXG4gICAgOiBuYW1lLmVuZHNXaXRoKFwic1wiKVxuICAgICAgPyBuYW1lLnNsaWNlKDAsIC0xKVxuICAgICAgOiBuYW1lO1xufVxuXG4vKiogQSBZQU1MIHNjYWxhciwgcXVvdGVkIG9ubHkgd2hlbiBpdCBtdXN0IGJlLiAqL1xuZnVuY3Rpb24gc2NhbGFyKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bXFx3IC4sJycvQCstXSokLy50ZXN0KHZhbHVlKSAmJiAhL15cXHN8XFxzJC8udGVzdCh2YWx1ZSkgJiYgdmFsdWUgIT09IFwiXCJcbiAgICA/IHZhbHVlXG4gICAgOiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG59XG5cbmV4cG9ydCB0eXBlIE5ld01ldGEgPSB7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgc3RhdHVzPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIC8qKiBgZ2VuZXJhdGVkLmJ5YCDigJQgdGhlIGFjdG9yLCByZWNvcmRlZCBob25lc3RseSBvciBsZWZ0IGB1bmtub3duYC4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIGF0Pzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBBIGZyb250bWF0dGVyIGJsb2NrIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE9LRidzIHJlY29tbWVuZGVkIHNldCBpblxuICogdGhlIG9yZGVyIHRoZSBjb3Jwb3JhIHdyaXRlIGl0LCB3aXRoIGBkZXNjcmlwdGlvbmAgbGVmdCBFTVBUWSBmb3IgdGhlIGF1dGhvcjpcbiAqIGEgb25lLWxpbmUgc3VtbWFyeSBub2JvZHkgd3JvdGUgaXMgd29yc2UgdGhhbiBhIGJsYW5rIHRoYXQgYXNrcyB0byBiZSBmaWxsZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEJsb2NrKG1ldGE6IE5ld01ldGEpOiBzdHJpbmcge1xuICBjb25zdCBhdCA9IG1ldGEuYXQgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgY29uc3QgbGluZXMgPSBbXG4gICAgYHR5cGU6ICR7c2NhbGFyKG1ldGEudHlwZSA/PyBcIlwiKX1gLFxuICAgIGB0aXRsZTogJHtzY2FsYXIobWV0YS50aXRsZSA/PyBcIlwiKX1gLFxuICAgIGBkZXNjcmlwdGlvbjogJHttZXRhLmRlc2NyaXB0aW9uID8gc2NhbGFyKG1ldGEuZGVzY3JpcHRpb24pIDogXCJcIn1gLFxuICAgIGB0YWdzOiBbJHsobWV0YS50YWdzID8/IFtdKS5tYXAoc2NhbGFyKS5qb2luKFwiLCBcIil9XWAsXG4gICAgYHN0YXR1czogJHtzY2FsYXIobWV0YS5zdGF0dXMgPz8gXCJkcmFmdFwiKX1gLFxuICAgIGBnZW5lcmF0ZWQ6IHsgYnk6ICR7c2NhbGFyKG1ldGEuYnkgPz8gXCJ1bmtub3duXCIpfSwgYXQ6ICR7YXR9IH1gLFxuICBdO1xuICByZXR1cm4gYC0tLVxcbiR7bGluZXMuam9pbihcIlxcblwiKX1cXG4tLS1cXG5gO1xufVxuXG4vKipcbiAqIFB1dCBhIG5ldyBibG9jayBhdCB0aGUgdG9wIG9mIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS4gTm8gYmxhbmsgbGluZSBpc1xuICogaW5zZXJ0ZWQ6IHRoZSBjb3Jwb3JhIHdyaXRlIHRoZSBib2R5IGRpcmVjdGx5IHVuZGVyIHRoZSBjbG9zaW5nIGAtLS1gLCBhbmQgYVxuICogYmxvY2sgdGhhdCBhZGRzIG9uZSB3b3VsZCBzaG93IGFzIGEgZGlmZiBvbiBldmVyeSBkb2N1bWVudCBpdCB0b3VjaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEJsb2NrKHRleHQ6IHN0cmluZywgYmxvY2s6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtibG9ja30ke3RleHR9YDtcbn1cblxuLyoqXG4gKiBTZXQgb25lIGtleSBpbiBhbiBFWElTVElORyBibG9jaywgYXMgYSBsaW5lIGVkaXQ6IHRoZSBrZXkncyBsaW5lIGlzIHJlcGxhY2VkXG4gKiB3aGVyZSBpdCBleGlzdHMgYW5kIGFwcGVuZGVkIGJlZm9yZSB0aGUgY2xvc2luZyBgLS0tYCB3aGVyZSBpdCBkb2VzIG5vdC5cbiAqIEV2ZXJ5dGhpbmcgZWxzZSDigJQgb3JkZXIsIGNvbW1lbnRzLCBzcGFjaW5nLCBrZXlzIHRoaXMgc3BlbGwgbmV2ZXIgaGVhcmQgb2Yg4oCUXG4gKiBzdXJ2aXZlcyBieXRlIGZvciBieXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0S2V5KHRleHQ6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB7IHJhdyB9ID0gc3BsaXRGcm9udG1hdHRlcih0ZXh0KTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKFwidGhpcyBkb2N1bWVudCBoYXMgbm8gZnJvbnRtYXR0ZXIgYmxvY2tcIik7XG4gIGNvbnN0IGxpbmUgPSBgJHtrZXl9OiAke3NjYWxhcih2YWx1ZSl9YDtcbiAgY29uc3Qga2V5TGluZSA9IG5ldyBSZWdFeHAoYF4ke2tleS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIil9XFxcXHMqOmApO1xuICBjb25zdCBsaW5lcyA9IHJhdy5zcGxpdChcIlxcblwiKTtcbiAgY29uc3QgYXQgPSBsaW5lcy5maW5kSW5kZXgoKGwpID0+IGtleUxpbmUudGVzdChsKSk7XG4gIGlmIChhdCA9PT0gLTEpIGxpbmVzLnB1c2gobGluZSk7XG4gIGVsc2Uge1xuICAgIC8vIEEgbXVsdGktbGluZSB2YWx1ZSAoYSBmb2xkZWQgZGVzY3JpcHRpb24sIGEgbmVzdGVkIG1hcHBpbmcpIGlzIHRoZVxuICAgIC8vIGtleSdzIGxpbmUgUExVUyBldmVyeSBpbmRlbnRlZCBsaW5lIHVuZGVyIGl0OyBhbGwgb2YgdGhlbSBnby5cbiAgICBsZXQgZW5kID0gYXQgKyAxO1xuICAgIHdoaWxlIChlbmQgPCBsaW5lcy5sZW5ndGggJiYgL15cXHMrXFxTLy50ZXN0KGxpbmVzW2VuZF0gPz8gXCJcIikpIGVuZCsrO1xuICAgIGxpbmVzLnNwbGljZShhdCwgZW5kIC0gYXQsIGxpbmUpO1xuICB9XG4gIGNvbnN0IHJlYnVpbHQgPSBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKHJhdywgcmVidWlsdCk7XG59XG4iLAogICAgIi8qKlxuICogTGlua3MgYmV0d2VlbiBkb2N1bWVudHMgKEUzMyk6IHdoYXQgYSBkb2N1bWVudCBwb2ludHMgYXQsIGFuZCB3aGF0IHRoYXRcbiAqIHJlc29sdmVzIHRvIGluc2lkZSBhIHNldC5cbiAqXG4gKiDilIDilIAgRk9VUiBTT1VSQ0VTIE9GIEVER0VTLCBBTkQgVEhFWSBBUkUgTk9UIE9ORSBLSU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICAgMS4gbWFya2Rvd24gbGlua3MgICAgICBgW2xhYmVsXSguL290aGVyLm1kKWAgICAgICDigJQgYm9keVxuICogICAyLiB3aWtpIGxpbmtzICAgICAgICAgIGBbW290aGVyLWRvY3xsYWJlbF1dYCAgICAgIOKAlCBib2R5XG4gKiAgIDMuIGZyb250bWF0dGVyIHZhbHVlcyAgYHJlbGF0ZWQ6IFtjb25jZXB0L3hdYCAgICAg4oCUIGF1dGhvcmVkIGludGVudFxuICogICA0LiBgc291cmNlc1tdLnJlc291cmNlYCAgICAgICAgICAgICAgICAgICAgICAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqXG4gKiBwZG9jcyBrZWVwcyB0aGUgZnJvbnRtYXR0ZXIgZWRnZSBhbmQgdGhlIGJvZHktbGluayBlZGdlIEFQQVJUIChgcmVsYXRlZFtdYFxuICogYW5kIGBsaW5rc1tdYCBpbiBpdHMgYGJhY2tsaW5rc2Agb3V0cHV0KSwgYW5kIHRoZSBkaXN0aW5jdGlvbiBpcyByZWFsOiBhXG4gKiBgcmVsYXRlZGAga2V5IGlzIGEgY2xhaW0gdGhlIGF1dGhvciBtYWRlIGFib3V0IHRoZSBkb2N1bWVudCBhcyBhIHdob2xlLCBhXG4gKiBib2R5IGxpbmsgaXMgYSBjaXRhdGlvbiBhdCBhIHBsYWNlIGluIHRoZSBwcm9zZS4gVGhleSBzdGF5IGFwYXJ0IGhlcmUgdG9vLlxuICpcbiAqIOKUgOKUgCBUWVBFRCBMSU5LUyAoT3BlcmF0b3IncyBzaGFwZSwgQ29sZSAyMDI2LTA5LTExKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBBIHJlbGF0aW9uIHJpZGVzIHRoZSBsaW5rIGFzIGEgcXVlcnk6IGBbbGFiZWxdKC4vb3RoZXIubWQ/cmVsPWV4dGVuZHMpYCxcbiAqIGBbW290aGVyP3JlbD1zdXBlcnNlZGVzfGxhYmVsXV1gLiBDb3BpZWQgZXhhY3RseSBmcm9tIE9wZXJhdG9yJ3MgcGFyc2VyXG4gKiAoYHBhY2thZ2VzL3NoYXJlZC9zcmMvbGlua3MvYCk6IG9uZSBsaW5rIGNhcnJpZXMgQUxMIG9mIGl0cyByZWxzLCB0aGV5IGFyZVxuICogbm9ybWFsaXNlZCAobG93ZXJjYXNlZCwgdHJpbW1lZCwgZGVkdXBlZCwgZmlyc3QtYXV0aG9yZWQgb3JkZXIga2VwdCkgYnV0XG4gKiB0aGVpciBTUEVMTElORyBpcyBub3QgY2Fub25pY2FsaXNlZCwgYW5kICoqYSBiYXJlIGxpbmsgaXMgYFtdYCDigJQgdGhlIEFCU0VOQ0VcbiAqIG9mIGFuIGFzc2VydGlvbiwgbm90IGFuIGltcGxpY2l0IGByZWZlcmVuY2VzYCoqLiBBIGdyYXBoIG11c3Qgbm90IGRyYXcgYVxuICogY2xhaW0gbm9ib2R5IG1hZGUuXG4gKlxuICog4pSA4pSAIFdIQVQgQSBCVU5ETEUgSVMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogT0tGJ3MgYnVuZGxlLXJlbGF0aXZlIGZvcm0gKGAvY29uY2VwdHMveC5tZGApIG1lYW5zIHRoZSBCVU5ETEUgcm9vdCwgbm90IHRoZVxuICogZmlsZXN5c3RlbSByb290LCBzbyBhIHJlc29sdmVyIG5lZWRzIGEgYnVuZGxlIGJlZm9yZSBpdCBjYW4gcmVzb2x2ZSBhbnl0aGluZzpcbiAqICoqYSBzZXQncyBlbnRyeSByb290IGlzIHRoZSBidW5kbGUqKiAoRTMzKS4gQSB0YXJnZXQgdGhhdCBlc2NhcGVzIGl0IGlzIG5vdCBhblxuICogZXJyb3Ig4oCUIHRoZSBzcGVjIHJlcXVpcmVzIHRvbGVyYXRpbmcgYnJva2VuIGxpbmtzIOKAlCBpdCBpcyBhbiBlZGdlIG1hcmtlZFxuICogYG91dHNpZGVgIG9yIGBtaXNzaW5nYCwgd2hpY2ggdGhlIHN1cmZhY2Ugb2ZmZXJzIHRvIGFkZCByYXRoZXIgdGhhbiBmb2xsb3cuXG4gKi9cbmltcG9ydCB7XG4gIGJhc2VuYW1lLFxuICBkaXJuYW1lLFxuICBleHRuYW1lLFxuICBqb2luLFxuICBub3JtYWxpemUsXG4gIHJlbGF0aXZlLFxuICByZXNvbHZlIGFzIHJlc29sdmVQYXRoLFxufSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IERvY01ldGEgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgdG9Qb3NpeCB9IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IHR5cGUgTGlua0tpbmQgPSBcIm1hcmtkb3duXCIgfCBcIndpa2lcIjtcblxuLyoqIE9uZSBsaW5rIGFzIHdyaXR0ZW4sIGJlZm9yZSBhbnl0aGluZyBpcyByZXNvbHZlZC4gKi9cbmV4cG9ydCB0eXBlIExpbmtSZWYgPSB7XG4gIGtpbmQ6IExpbmtLaW5kO1xuICAvKiogVGhlIHRhcmdldCBhcyBhdXRob3JlZCwgd2l0aCBpdHMgcXVlcnkgYW5kIGFuY2hvciBzdHJpcHBlZC4gKi9cbiAgdGFyZ2V0OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgdGFyZ2V0IEVYQUNUTFkgYXMgd3JpdHRlbiDigJQgcXVlcnksIGFuY2hvciwgcGVyY2VudC1lbmNvZGluZyBhbmQgYWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBXSEFUIE1BS0VTIEEgREFOR0xJTkcgTElOSyBGSVhBQkxFLiBgdGFyZ2V0YCBpcyB0aGUgcmVzb2x2ZWRcbiAgICogc2hhcGUsIHNvIGEgcmVwb3J0IGJ1aWx0IGZyb20gaXQgdGVsbHMgeW91IHRvIGxvb2sgZm9yIGBkZWVwLm1kYCB3aGVuIHRoZVxuICAgKiBkb2N1bWVudCBhY3R1YWxseSBzYXlzIGAuL21pc3NpbmcvZGVlcC5tZD9yZWw9eGAg4oCUIGEgc3RyaW5nIHRoYXQgaXMgbm90IGluXG4gICAqIHRoZSBmaWxlLiBXaG9ldmVyIChvciB3aGF0ZXZlcikgZ29lcyB0byByZXBhaXIgdGhlIGxpbmsgbmVlZHMgdGhlIHN0cmluZ1xuICAgKiB0aGF0IGlzIHRoZXJlLlxuICAgKi9cbiAgcmF3OiBzdHJpbmc7XG4gIC8qKiAxLWJhc2VkIGxpbmUgaW4gdGhlIGJvZHkgdGhlIGxpbmsgd2FzIHdyaXR0ZW4gb24sIGZvciB0aGUgc2FtZSByZWFzb24uICovXG4gIGxpbmU6IG51bWJlcjtcbiAgLyoqIFJlbGF0aW9ucyBmcm9tIGA/cmVsPWA7IEVNUFRZIG1lYW5zIG5vIGFzc2VydGlvbiwgbmV2ZXIgYHJlZmVyZW5jZXNgLiAqL1xuICByZWw6IHN0cmluZ1tdO1xuICBsYWJlbD86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZmVyZW5jZSBmb3VuZCBpbiBmcm9udG1hdHRlciwgd2l0aCB0aGUga2V5IHRoYXQgY2FycmllZCBpdC4gKi9cbmV4cG9ydCB0eXBlIEZpZWxkUmVmID0geyBrZXk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9O1xuXG5jb25zdCBGRU5DRV9MSU5FID0gL14oPzpgYGB8fn5+KS87XG5cbi8qKlxuICogU3RyaXAgZmVuY2VkIGNvZGUgYmxvY2tzLiBBIGRvY3VtZW50IGFib3V0IGxpbmtzIHF1b3RlcyBsaW5rIHN5bnRheCwgYW5kIHRoZVxuICogd2lraSB0aGlzIHdhcyBidWlsdCBhZ2FpbnN0IGRvZXMgZXhhY3RseSB0aGF0IOKAlCB3aXRob3V0IHRoaXMsIFNDSEVNQS5tZCdzXG4gKiBleGFtcGxlcyBiZWNvbWUgZWRnZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRob3V0RmVuY2VzKGJvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGZlbmNlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGJvZHkuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtID0gRkVOQ0VfTElORS5leGVjKGxpbmUpO1xuICAgIGlmIChmZW5jZSA9PT0gbnVsbCAmJiBtKSB7XG4gICAgICBmZW5jZSA9IG1bMF07XG4gICAgICBvdXQucHVzaChcIlwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoZmVuY2UgIT09IG51bGwpIHtcbiAgICAgIGlmIChtICYmIGxpbmUuc3RhcnRzV2l0aChmZW5jZSkpIGZlbmNlID0gbnVsbDtcbiAgICAgIG91dC5wdXNoKFwiXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIG91dC5wdXNoKGxpbmUpO1xuICB9XG4gIHJldHVybiBvdXQuam9pbihcIlxcblwiKTtcbn1cblxuLyoqIGA/cmVsPWEsYmAg4oaSIGBbXCJhXCIsXCJiXCJdYCwgbm9ybWFsaXNlZCB0aGUgd2F5IE9wZXJhdG9yIG5vcm1hbGlzZXMgdGhlbS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJlbChxdWVyeTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICBpZiAoIXF1ZXJ5KSByZXR1cm4gW107XG4gIGNvbnN0IG0gPSAvKD86XnxbPyZdKXJlbD0oW14mXSopLy5leGVjKHF1ZXJ5KTtcbiAgaWYgKCFtKSByZXR1cm4gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJhdyBvZiBkZWNvZGVVUklDb21wb25lbnQobVsxXSA/PyBcIlwiKS5zcGxpdChcIixcIikpIHtcbiAgICBjb25zdCByZWwgPSByYXcudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKHJlbCA9PT0gXCJcIiB8fCBzZWVuLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChyZWwpO1xuICAgIG91dC5wdXNoKHJlbCk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFNwbGl0IGEgd3JpdHRlbiB0YXJnZXQgaW50byBpdHMgcGF0aCwgaXRzIHF1ZXJ5IGFuZCBpdHMgYW5jaG9yLiAqL1xuLyoqXG4gKiBQZXJjZW50LWRlY29kaW5nLCB3aGljaCBhIG1hcmtkb3duIGxpbmsgdGFyZ2V0IGNhcnJpZXMgd2hlbmV2ZXIgdGhlIGZpbGUgaXRcbiAqIG5hbWVzIGhhcyBhIHNwYWNlIGluIGl0IOKAlCBgTWFyZW4ncyUyMEJha2VyeS5tZGAgKEU0OSkuXG4gKlxuICog4puUIElUIE1VU1QgTk9UIFRIUk9XLiBgZGVjb2RlVVJJQ29tcG9uZW50YCByZWplY3RzIGEgbG9uZSBgJWAsIGFuZCBhIGZpbGVcbiAqIGNhbGxlZCBgMTAwJSBkb25lLm1kYCBpcyBhIHBlcmZlY3RseSBvcmRpbmFyeSB0aGluZyB0byBsaW5rIHRvLiBBblxuICogdW5kZWNvZGFibGUgdGFyZ2V0IGlzIHJldHVybmVkIGFzIGl0IHN0YW5kczogd29yc3QgY2FzZSBpdCBmYWlscyB0byByZXNvbHZlLFxuICogd2hpY2ggaXMgdGhlIGJlaGF2aW91ciBiZWZvcmUgZGVjb2RpbmcgZXhpc3RlZCwgcmF0aGVyIHRoYW4gdGFraW5nIHRoZSBncmFwaFxuICogZG93biB3aXRoIGl0LlxuICovXG5mdW5jdGlvbiBkZWNvZGVQYXRoKHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFyYXcuaW5jbHVkZXMoXCIlXCIpKSByZXR1cm4gcmF3O1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHJhdztcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRUYXJnZXQocmF3OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgcXVlcnk/OiBzdHJpbmc7IGFuY2hvcj86IHN0cmluZyB9IHtcbiAgY29uc3QgaGFzaCA9IHJhdy5pbmRleE9mKFwiI1wiKTtcbiAgY29uc3Qgd2l0aG91dEFuY2hvciA9IGhhc2ggPT09IC0xID8gcmF3IDogcmF3LnNsaWNlKDAsIGhhc2gpO1xuICBjb25zdCBhbmNob3IgPSBoYXNoID09PSAtMSA/IHVuZGVmaW5lZCA6IHJhdy5zbGljZShoYXNoICsgMSk7XG4gIGNvbnN0IHEgPSB3aXRob3V0QW5jaG9yLmluZGV4T2YoXCI/XCIpO1xuICByZXR1cm4ge1xuICAgIHBhdGg6IGRlY29kZVBhdGgoKHEgPT09IC0xID8gd2l0aG91dEFuY2hvciA6IHdpdGhvdXRBbmNob3Iuc2xpY2UoMCwgcSkpLnRyaW0oKSksXG4gICAgLi4uKHEgPT09IC0xID8ge30gOiB7IHF1ZXJ5OiB3aXRob3V0QW5jaG9yLnNsaWNlKHEgKyAxKSB9KSxcbiAgICAuLi4oYW5jaG9yID8geyBhbmNob3IgfSA6IHt9KSxcbiAgfTtcbn1cblxuY29uc3QgRVhURVJOQUwgPSAvXlthLXpdW2EtejAtOSsuLV0qOi9pO1xuY29uc3QgTURfTElOSyA9IC8oIT8pXFxbKFteXFxdXFxuXSopXFxdXFwoKFteKVxcc10rKSg/OlxccytcIlteXCJdKlwiKT9cXCkvZztcbmNvbnN0IFdJS0lfTElOSyA9IC9cXFtcXFsoW15cXF1cXG5dKylcXF1cXF0vZztcblxuLyoqIEV2ZXJ5IGxpbmsgYSBkb2N1bWVudCdzIEJPRFkgcG9pbnRzIGF0IOKAlCBleHRlcm5hbCB0YXJnZXRzIGFuZCBpbWFnZXMgbGVmdCBvdXQuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdExpbmtzKGJvZHk6IHN0cmluZyk6IExpbmtSZWZbXSB7XG4gIGNvbnN0IHRleHQgPSB3aXRob3V0RmVuY2VzKGJvZHkpO1xuICBjb25zdCBvdXQ6IExpbmtSZWZbXSA9IFtdO1xuICAvLyDimqAgTElORSBOVU1CRVJTIFNVUlZJVkUgYHdpdGhvdXRGZW5jZXNgIEFORCBPRkZTRVRTIERPIE5PVDogaXQgYmxhbmtzIGVhY2hcbiAgLy8gZmVuY2VkIGxpbmUgcmF0aGVyIHRoYW4gZGVsZXRpbmcgaXQsIHNvIHRoZSBsaW5lIENPVU5UIGlzIHByZXNlcnZlZCB3aGlsZVxuICAvLyB0aGUgY2hhcmFjdGVyIG9mZnNldHMgYXJlIG5vdC4gQ291bnRpbmcgbmV3bGluZXMgaXMgdGhlcmVmb3JlIHNvdW5kOyB1c2luZ1xuICAvLyBgbS5pbmRleGAgYXMgYSBjaGFyYWN0ZXIgcG9zaXRpb24gaW4gdGhlIG9yaWdpbmFsIGJvZHkgd291bGQgbm90IGJlLlxuICBjb25zdCBsaW5lQXQgPSAoYXQ6IG51bWJlcikgPT4ge1xuICAgIGxldCBsaW5lID0gMTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGF0ICYmIGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSBpZiAodGV4dC5jaGFyQ29kZUF0KGkpID09PSAxMCkgbGluZSsrO1xuICAgIHJldHVybiBsaW5lO1xuICB9O1xuICBmb3IgKGNvbnN0IG0gb2YgdGV4dC5tYXRjaEFsbChNRF9MSU5LKSkge1xuICAgIGlmIChtWzFdID09PSBcIiFcIikgY29udGludWU7IC8vIGFuIGltYWdlIGlzIG5vdCBhIGRvY3VtZW50IGxpbmtcbiAgICBjb25zdCByYXcgPSBtWzNdID8/IFwiXCI7XG4gICAgaWYgKEVYVEVSTkFMLnRlc3QocmF3KSB8fCByYXcuc3RhcnRzV2l0aChcIiNcIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHJhdyk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwibWFya2Rvd25cIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJhdyxcbiAgICAgIGxpbmU6IGxpbmVBdChtLmluZGV4ID8/IDApLFxuICAgICAgcmVsOiBwYXJzZVJlbChxdWVyeSksXG4gICAgICAuLi4obVsyXSA/IHsgbGFiZWw6IG1bMl0gfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuICBmb3IgKGNvbnN0IG0gb2YgdGV4dC5tYXRjaEFsbChXSUtJX0xJTkspKSB7XG4gICAgY29uc3QgaW5uZXIgPSBtWzFdID8/IFwiXCI7XG4gICAgY29uc3QgcGlwZSA9IGlubmVyLmluZGV4T2YoXCJ8XCIpO1xuICAgIGNvbnN0IHRhcmdldFBhcnQgPSBwaXBlID09PSAtMSA/IGlubmVyIDogaW5uZXIuc2xpY2UoMCwgcGlwZSk7XG4gICAgY29uc3QgbGFiZWwgPSBwaXBlID09PSAtMSA/IHVuZGVmaW5lZCA6IGlubmVyLnNsaWNlKHBpcGUgKyAxKS50cmltKCk7XG4gICAgY29uc3QgeyBwYXRoLCBxdWVyeSB9ID0gc3BsaXRUYXJnZXQodGFyZ2V0UGFydCk7XG4gICAgaWYgKHBhdGggPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIG91dC5wdXNoKHtcbiAgICAgIGtpbmQ6IFwid2lraVwiLFxuICAgICAgdGFyZ2V0OiBwYXRoLFxuICAgICAgcmF3OiB0YXJnZXRQYXJ0LFxuICAgICAgbGluZTogbGluZUF0KG0uaW5kZXggPz8gMCksXG4gICAgICByZWw6IHBhcnNlUmVsKHF1ZXJ5KSxcbiAgICAgIC4uLihsYWJlbCA/IHsgbGFiZWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogRG9lcyB0aGlzIGZyb250bWF0dGVyIHZhbHVlIExPT0sgbGlrZSBhIGRvY3VtZW50IHJlZmVyZW5jZT8gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb29rc0xpa2VSZWYodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHYgPSB2YWx1ZS50cmltKCk7XG4gIGlmICh2ID09PSBcIlwiIHx8IEVYVEVSTkFMLnRlc3QodikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHYuaW5jbHVkZXMoXCIvXCIpIHx8IHYudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5tZFwiKTtcbn1cblxuLyoqXG4gKiBSZWZlcmVuY2VzIGluc2lkZSBmcm9udG1hdHRlciwgd2hhdGV2ZXIga2V5IGNhcnJpZXMgdGhlbSDigJQgYHJlbGF0ZWRgLFxuICogYHN1cGVyc2VkZXNgLCBgc291cmNlc1tdLnJlc291cmNlYCwgb3IgYSBrZXkgaW52ZW50ZWQgdG9tb3Jyb3cuIFRoZSBTSEFQRVxuICogZGVjaWRlcyAoYSBzbGFzaCBvciBhIGAubWRgKSwgd2hpY2ggaXMgd2h5IGJhcmUgYHRhZ3NgIGFyZSBub3QgcmVmZXJlbmNlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpZWxkUmVmcyhmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBtYXhEZXB0aCA9IDQpOiBGaWVsZFJlZltdIHtcbiAgY29uc3Qgb3V0OiBGaWVsZFJlZltdID0gW107XG4gIGNvbnN0IHdhbGsgPSAoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBkZXB0aDogbnVtYmVyKSA9PiB7XG4gICAgaWYgKGRlcHRoID4gbWF4RGVwdGgpIHJldHVybjtcbiAgICBpZiAobG9va3NMaWtlUmVmKHZhbHVlKSkgb3V0LnB1c2goeyBrZXksIHZhbHVlOiB2YWx1ZS50cmltKCkgfSk7XG4gICAgZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIGZvciAoY29uc3QgdiBvZiB2YWx1ZSkgd2FsayhrZXksIHYsIGRlcHRoICsgMSk7XG4gICAgZWxzZSBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiKVxuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKVxuICAgICAgICB3YWxrKGAke2tleX0uJHtrfWAsIHYsIGRlcHRoICsgMSk7XG4gIH07XG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGZpZWxkcykpIHdhbGsoaywgdiwgMCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGVyZSBhIHRhcmdldCBsYW5kZWQuIGBvdXRzaWRlYCBleGlzdHMgb24gZGlzayBidXQgbm90IGluIHRoaXMgYnVuZGxlLiAqL1xuZXhwb3J0IHR5cGUgUmVzb2x1dGlvbiA9XG4gIHwgeyBzdGF0ZTogXCJpbi1idW5kbGVcIjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiBcIm91dHNpZGVcIjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiBcIm1pc3NpbmdcIjsgdHJpZWQ6IHN0cmluZyB9O1xuXG5leHBvcnQgdHlwZSBCdW5kbGVJbmRleCA9IHtcbiAgLyoqIFRoZSBzZXQncyByb290IOKAlCBPS0YncyBidW5kbGUsIGFuZCB3aGF0IGEgYC9gLXRhcmdldCBpcyByZWxhdGl2ZSB0by4gKi9cbiAgcm9vdDogc3RyaW5nO1xuICAvKiogQWJzb2x1dGUgcGF0aHMgb2YgZXZlcnkgZG9jdW1lbnQgaW4gdGhlIGJ1bmRsZS4gKi9cbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogQSBkb2N1bWVudCdzIHBhcnNlZCBmcm9udG1hdHRlciwgZm9yIGB0eXBlL3NsdWdgIHJlc29sdXRpb24uICovXG4gIG1ldGFPZjogKHBhdGg6IHN0cmluZykgPT4gRG9jTWV0YSB8IG51bGw7XG4gIC8qKiBEb2VzIHRoaXMgcGF0aCBleGlzdCBvbiBkaXNrPyAoSW5qZWN0ZWQsIHNvIHRoZSByZXNvbHZlciBzdGF5cyBwdXJlLikgKi9cbiAgZXhpc3RzOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xuICAvKipcbiAgICogVGhlIGdpdCB3b3JraW5nIHRyZWUgdGhlIGJ1bmRsZSBzaXRzIGluLCB3aGVuIHRoZXJlIGlzIG9uZS4gQSB0aGlyZCBwbGFjZVxuICAgKiBhbiB1bmFuY2hvcmVkIHBhdGggaXMgdHJpZWQ6IHBkb2NzIHdyaXRlcyByZXBvLXJlbGF0aXZlIHBhdGhzXG4gICAqIChgZG9jcy9wbGF5Ym9va3MvZm9vLm1kYCkgYW5kIHRoZSB3aWtpJ3MgcnVsZSBwYWdlcyBjYXJyeSByZXBvLXJlbGF0aXZlXG4gICAqIGBjaGVja2VyOmAgdmFsdWVzLCBhbmQgbmVpdGhlciByZXNvbHZlcyBmcm9tIHRoZSBkb2N1bWVudCBvciB0aGUgYnVuZGxlLlxuICAgKi9cbiAgcmVwb1Jvb3Q/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuY29uc3Qgc3RlbSA9IChwOiBzdHJpbmcpID0+IGJhc2VuYW1lKHAsIGV4dG5hbWUocCkpO1xuXG4vKipcbiAqIFJlc29sdmUgb25lIHdyaXR0ZW4gdGFyZ2V0IGFnYWluc3QgdGhlIGJ1bmRsZS5cbiAqXG4gKiBGb3VyIGZvcm1zLCBpbiBvcmRlcjogYSBidW5kbGUtcmVsYXRpdmUgcGF0aCAoYC94L3kubWRgKSwgYSByZWxhdGl2ZSBwYXRoXG4gKiAoYC4veS5tZGAsIGAuLi94L3kubWRgKSwgYSBgdHlwZS9zbHVnYCBrZXkg4oCUIHBkb2NzJyBhbmQgdGhlIHdpa2kncyBvd24gZm9ybSxcbiAqIHdoaWNoIHJlc29sdmVzIGJ5IFRZUEUgYW5kIEJBU0VOQU1FIHNvIGEgcGFnZSBjYW4gbW92ZSBmb2xkZXJzIHdpdGhvdXRcbiAqIGJyZWFraW5nIGluYm91bmQgcmVmZXJlbmNlcyDigJQgYW5kIGEgYmFyZSBuYW1lIChhIHdpa2kgbGluayksIGJ5IGJhc2VuYW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRhcmdldChyYXdUYXJnZXQ6IHN0cmluZywgZnJvbTogc3RyaW5nLCBpbmRleDogQnVuZGxlSW5kZXgpOiBSZXNvbHV0aW9uIHtcbiAgLy8g4puUIFNQTElUIEZJUlNULCBCRUNBVVNFIFRIRSBDQUxMRVJTIERJU0FHUkVFIEFCT1VUIFdIQVQgVEhFWSBIQU5EIE9WRVIuXG4gIC8vIGBleHRyYWN0TGlua3NgIHNwbGl0cyBhIHRhcmdldCBiZWZvcmUgaXQgZXZlciBnZXRzIGhlcmUgKEU0OSksIGJ1dCB0aGVcbiAgLy8gQ0xJQ0sgcGF0aCBkb2VzIG5vdDogYGxpbmsub3BlbmAgY2FycmllcyB0aGUgaHJlZiBleGFjdGx5IGFzIHRoZSBkb2N1bWVudFxuICAvLyB3cm90ZSBpdC4gU28gYW4gT3BlcmF0b3IgdHlwZWQgbGluayDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWQ/cmVsPWxvY2F0ZWQtaW5gXG4gIC8vIOKAlCBhcnJpdmVkIHdpdGggaXRzIHF1ZXJ5IGFuZCBpdHMgZW5jb2RpbmcgaW50YWN0LCBgZXh0bmFtZWAgcmVhZFxuICAvLyBgLm1kP3JlbD1sb2NhdGVkLWluYCwgYW5kIHRoZSBsb29rdXAgd2VudCBodW50aW5nIGZvciBhIGZpbGUgbmFtZWQgYWZ0ZXJcbiAgLy8gdGhlIHdob2xlIHN0cmluZy4gVGhlIEdSQVBIIGRyZXcgdGhhdCBlZGdlIGNvcnJlY3RseSB0aGUgZW50aXJlIHRpbWUsIHdoaWNoXG4gIC8vIGlzIHdoYXQgbWFkZSBpdCBwdXp6bGluZzogdGhlIHNhbWUgbGluayB3YXMgZmluZSBpbiB0aGUgbWFwIGFuZCBkZWFkIHVuZGVyXG4gIC8vIHRoZSBwb2ludGVyLiBTcGxpdHRpbmcgaGVyZSBmaXhlcyBldmVyeSBjYWxsZXIgYXQgb25jZSBhbmQgaXMgaWRlbXBvdGVudFxuICAvLyBmb3IgdGhlIHR3byB0aGF0IGhhZCBhbHJlYWR5IGRvbmUgaXQuIChDb2xlIGZvdW5kIGl0IGJ5IGNsaWNraW5nIG9uZSBpblxuICAvLyBIb2xsb3dicm9vaywgMjAyNi0wOS0xNC4pXG4gIGNvbnN0IHRhcmdldCA9IHNwbGl0VGFyZ2V0KHJhd1RhcmdldCkucGF0aDtcbiAgLy8g4puUIFdIQVQgTUFLRVMgQSBUQVJHRVQgQSBQQVRIIFJBVEhFUiBUSEFOIEEgS0VZLCBhbmQgdGhlIGNhc2UgdGhhdCB0YXVnaHRcbiAgLy8gaXQ6IGBbdGhlIGxpbnRlcl0obGludC50cylgIGluIHRoZSByZWFsIHdpa2kgaGFzIG5vIGAuL2AgYW5kIGlzIG5vdCBhIGAubWRgLFxuICAvLyBzbyBhIHJ1bGUga2V5ZWQgb24gdGhvc2UgdHdvIHJlYWQgaXQgYXMgYSBOQU1FIGFuZCByZXBvcnRlZCBpdCBtaXNzaW5nXG4gIC8vIHdoaWxlIHRoZSBmaWxlIHNhdCByaWdodCB0aGVyZS4gQSB0YXJnZXQgaXMgYSBwYXRoIHdoZW4gaXQgaXMgYW5jaG9yZWRcbiAgLy8gKGAvYCwgYC4vYCwgYC4uL2ApIG9yIGNhcnJpZXMgQU5ZIGV4dGVuc2lvbjsgYGNvbmNlcHQvZXhpdC1jb2Rlc2AgaGFzXG4gIC8vIG5laXRoZXIsIHdoaWNoIGlzIHdoYXQga2VlcHMgYSBgdHlwZS9zbHVnYCBrZXkgYSBrZXkuXG4gIGNvbnN0IGxvb2tzUGF0aCA9XG4gICAgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpIHx8XG4gICAgZXh0bmFtZSh0YXJnZXQpICE9PSBcIlwiO1xuICBpZiAobG9va3NQYXRoKSB7XG4gICAgLy8gQW4gVU5BTkNIT1JFRCBwYXRoIChgc3JjL2FjYy9raXQveC50c2AsIGByZXBvcnRzL2EubWRgIOKAlCBubyBgLi9gIGFuZCBub1xuICAgIC8vIGxlYWRpbmcgYC9gKSBpcyBhbWJpZ3VvdXM6IHJlbGF0aXZlIHRvIHRoZSBkb2N1bWVudCwgb3IgdG8gdGhlIGJ1bmRsZT9cbiAgICAvLyBCb3RoIGFyZSB0cmllZCwgZG9jdW1lbnQgZmlyc3QuIE1lYXN1cmVkIG9uIHRoZSByZWFsIHdpa2ksIHdoZXJlIGEgcnVsZVxuICAgIC8vIHBhZ2UncyBgY2hlY2tlcjogc3JjL2FjYy9raXQvY2hlY2tlcnMv4oCmYCB3YXMgcmVwb3J0ZWQgbWlzc2luZyB3aGlsZVxuICAgIC8vIHJlc29sdmluZyBmcm9tIHRoZSBidW5kbGUgcm9vdCB3b3VsZCBoYXZlIGZvdW5kIGl0LlxuICAgIGNvbnN0IGFuY2hvcmVkID0gdGFyZ2V0LnN0YXJ0c1dpdGgoXCIvXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHwgdGFyZ2V0LnN0YXJ0c1dpdGgoXCIuLi9cIik7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKVxuICAgICAgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSldXG4gICAgICA6IGFuY2hvcmVkXG4gICAgICAgID8gW25vcm1hbGl6ZShyZXNvbHZlUGF0aChkaXJuYW1lKGZyb20pLCB0YXJnZXQpKV1cbiAgICAgICAgOiBbXG4gICAgICAgICAgICBub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSksXG4gICAgICAgICAgICBub3JtYWxpemUoam9pbihpbmRleC5yb290LCB0YXJnZXQpKSxcbiAgICAgICAgICAgIC4uLihpbmRleC5yZXBvUm9vdCA/IFtub3JtYWxpemUoam9pbihpbmRleC5yZXBvUm9vdCwgdGFyZ2V0KSldIDogW10pLFxuICAgICAgICAgIF07XG4gICAgY29uc3QgdHJpZWQgPSBjYW5kaWRhdGVzLm1hcCgoYykgPT4gKGV4dG5hbWUoYykgPT09IFwiXCIgPyBgJHtjfS5tZGAgOiBjKSk7XG4gICAgZm9yIChjb25zdCBjIG9mIHRyaWVkKSBpZiAoaW5kZXgucGF0aHMuaW5jbHVkZXMoYykpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBjIH07XG4gICAgZm9yIChjb25zdCBjIG9mIHRyaWVkKSBpZiAoaW5kZXguZXhpc3RzKGMpKSByZXR1cm4geyBzdGF0ZTogXCJvdXRzaWRlXCIsIHBhdGg6IGMgfTtcbiAgICByZXR1cm4geyBzdGF0ZTogXCJtaXNzaW5nXCIsIHRyaWVkOiB0cmllZFswXSBhcyBzdHJpbmcgfTtcbiAgfVxuICBjb25zdCBzbGFzaCA9IHRhcmdldC5pbmRleE9mKFwiL1wiKTtcbiAgaWYgKHNsYXNoID4gMCkge1xuICAgIC8vIGB0eXBlL3NsdWdgOiB0aGUgdHlwZSBpcyBhIGNsYWltIHRoZSB0YXJnZXQncyBvd24gZnJvbnRtYXR0ZXIgbXVzdCBtYWtlLlxuICAgIGNvbnN0IHR5cGUgPSB0YXJnZXQuc2xpY2UoMCwgc2xhc2gpO1xuICAgIGNvbnN0IHNsdWcgPSB0YXJnZXQuc2xpY2Uoc2xhc2ggKyAxKTtcbiAgICBmb3IgKGNvbnN0IHAgb2YgaW5kZXgucGF0aHMpXG4gICAgICBpZiAoc3RlbShwKSA9PT0gc2x1ZyAmJiBpbmRleC5tZXRhT2YocCk/LnR5cGUgPT09IHR5cGUpXG4gICAgICAgIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBwIH07XG4gIH1cbiAgY29uc3QgaGl0ID0gaW5kZXgucGF0aHMuZmluZCgocCkgPT4gc3RlbShwKSA9PT0gc3RlbSh0YXJnZXQpKTtcbiAgaWYgKGhpdCkgcmV0dXJuIHsgc3RhdGU6IFwiaW4tYnVuZGxlXCIsIHBhdGg6IGhpdCB9O1xuICByZXR1cm4geyBzdGF0ZTogXCJtaXNzaW5nXCIsIHRyaWVkOiB0YXJnZXQgfTtcbn1cblxuLyoqIEFuIGVkZ2UgaW4gYSBzZXQncyBtYXAuIGByZWxgIGVtcHR5IG1lYW5zIG5vIGFzc2VydGlvbiB3YXMgbWFkZS4gKi9cbmV4cG9ydCB0eXBlIEVkZ2UgPSB7XG4gIGZyb206IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGggd2hlbiByZXNvbHZlZDsgdGhlIHdyaXR0ZW4gdGFyZ2V0IHdoZW4gbm90LiAqL1xuICB0bzogc3RyaW5nO1xuICAvKiogQSBib2R5IGxpbmssIG9yIGEgZnJvbnRtYXR0ZXIgdmFsdWUg4oCUIGtlcHQgYXBhcnQsIGFzIHBkb2NzIGtlZXBzIHRoZW0uICovXG4gIHNvdXJjZTogXCJsaW5rXCIgfCBcImZyb250bWF0dGVyXCI7XG4gIC8qKiBUaGUgZnJvbnRtYXR0ZXIga2V5IHRoYXQgY2FycmllZCBpdCAoYHJlbGF0ZWRgLCBgc291cmNlcy5yZXNvdXJjZWAsIOKApikuICovXG4gIGtleT86IHN0cmluZztcbiAgLyoqXG4gICAqIEZvciBhIEJPRFkgbGluazogdGhlIHRhcmdldCBhcyB3cml0dGVuLCBhbmQgdGhlIGxpbmUgaXQgaXMgb24uIEFic2VudCBmb3IgYVxuICAgKiBmcm9udG1hdHRlciByZWZlcmVuY2UsIHdoZXJlIGBrZXlgIGlzIHRoZSBhZGRyZXNzIGluc3RlYWQuXG4gICAqL1xuICByYXc/OiBzdHJpbmc7XG4gIGxpbmU/OiBudW1iZXI7XG4gIHJlbDogc3RyaW5nW107XG4gIHN0YXRlOiBSZXNvbHV0aW9uW1wic3RhdGVcIl07XG59O1xuXG5leHBvcnQgdHlwZSBHcmFwaE5vZGUgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgcmVsOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICBzdGFsZTogYm9vbGVhbjtcbiAgdGFnczogc3RyaW5nW107XG4gIGxpbmtzT3V0OiBudW1iZXI7XG4gIGxpbmtzSW46IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIEdyYXBoID0ge1xuICByb290OiBzdHJpbmc7XG4gIG5vZGVzOiBHcmFwaE5vZGVbXTtcbiAgZWRnZXM6IEVkZ2VbXTtcbiAgLyoqIFRhcmdldHMgbm90aGluZyBpbiB0aGUgYnVuZGxlIGFuc3dlcnMg4oCUIHNhaWQsIG5ldmVyIGFuIGVycm9yIChPS0YgwqcxMSkuICovXG4gIGRhbmdsaW5nOiBudW1iZXI7XG59O1xuXG4vKiogQnVpbGQgYSBzZXQncyBtYXA6IG5vZGVzIGFyZSBpdHMgZG9jdW1lbnRzLCBlZGdlcyBhcmUgdGhlIGZvdXIgc291cmNlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdyYXBoKGluZGV4OiBCdW5kbGVJbmRleCwgYm9keU9mOiAocGF0aDogc3RyaW5nKSA9PiBzdHJpbmcsIGNhcCA9IDQwMCk6IEdyYXBoIHtcbiAgY29uc3QgcGF0aHMgPSBpbmRleC5wYXRocy5zbGljZSgwLCBjYXApO1xuICBjb25zdCBlZGdlczogRWRnZVtdID0gW107XG4gIGZvciAoY29uc3QgZnJvbSBvZiBwYXRocykge1xuICAgIGNvbnN0IG1ldGEgPSBpbmRleC5tZXRhT2YoZnJvbSk7XG4gICAgZm9yIChjb25zdCBsaW5rIG9mIGV4dHJhY3RMaW5rcyhib2R5T2YoZnJvbSkpKSB7XG4gICAgICBjb25zdCByID0gcmVzb2x2ZVRhcmdldChsaW5rLnRhcmdldCwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJsaW5rXCIsXG4gICAgICAgIHJhdzogbGluay5yYXcsXG4gICAgICAgIGxpbmU6IGxpbmsubGluZSxcbiAgICAgICAgcmVsOiBsaW5rLnJlbCxcbiAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICB9KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCByZWYgb2YgbWV0YSA/IGZpZWxkUmVmcyhtZXRhLmZpZWxkcykgOiBbXSkge1xuICAgICAgY29uc3QgciA9IHJlc29sdmVUYXJnZXQocmVmLnZhbHVlLCBmcm9tLCBpbmRleCk7XG4gICAgICBlZGdlcy5wdXNoKHtcbiAgICAgICAgZnJvbSxcbiAgICAgICAgdG86IHIuc3RhdGUgPT09IFwibWlzc2luZ1wiID8gci50cmllZCA6IHIucGF0aCxcbiAgICAgICAgc291cmNlOiBcImZyb250bWF0dGVyXCIsXG4gICAgICAgIGtleTogcmVmLmtleSxcbiAgICAgICAgcmVsOiBbXSxcbiAgICAgICAgc3RhdGU6IHIuc3RhdGUsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgb3V0T2YgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBjb25zdCBpbnRvT2YgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2YgZWRnZXMpIHtcbiAgICBvdXRPZi5zZXQoZS5mcm9tLCAob3V0T2YuZ2V0KGUuZnJvbSkgPz8gMCkgKyAxKTtcbiAgICBpZiAoZS5zdGF0ZSA9PT0gXCJpbi1idW5kbGVcIikgaW50b09mLnNldChlLnRvLCAoaW50b09mLmdldChlLnRvKSA/PyAwKSArIDEpO1xuICB9XG4gIGNvbnN0IG5vZGVzOiBHcmFwaE5vZGVbXSA9IHBhdGhzLm1hcCgocGF0aCkgPT4ge1xuICAgIGNvbnN0IG1ldGEgPSBpbmRleC5tZXRhT2YocGF0aCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGgsXG4gICAgICByZWw6IHRvUG9zaXgocmVsYXRpdmUoaW5kZXgucm9vdCwgcGF0aCkpLFxuICAgICAgdGl0bGU6IG1ldGE/LnRpdGxlID8/IHN0ZW0ocGF0aCksXG4gICAgICAuLi4obWV0YT8udHlwZSA/IHsgdHlwZTogbWV0YS50eXBlIH0gOiB7fSksXG4gICAgICBzdGF0dXM6IG1ldGE/LnN0YXR1cyA/PyBcInN0YWJsZVwiLFxuICAgICAgc3RhbGU6IG1ldGE/LnN0YWxlID8/IGZhbHNlLFxuICAgICAgdGFnczogbWV0YT8udGFncyA/PyBbXSxcbiAgICAgIGxpbmtzT3V0OiBvdXRPZi5nZXQocGF0aCkgPz8gMCxcbiAgICAgIGxpbmtzSW46IGludG9PZi5nZXQocGF0aCkgPz8gMCxcbiAgICB9O1xuICB9KTtcbiAgcmV0dXJuIHtcbiAgICByb290OiBpbmRleC5yb290LFxuICAgIG5vZGVzLFxuICAgIGVkZ2VzLFxuICAgIGRhbmdsaW5nOiBlZGdlcy5maWx0ZXIoKGUpID0+IGUuc3RhdGUgPT09IFwibWlzc2luZ1wiKS5sZW5ndGgsXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogQ29udGV4dCBlbnRyaWVzIG9uIGRpc2sg4oCUIGJ1aWxkaW5nIGFuIGVudHJ5IGZyb20gYSBwYXRoIChFMTUncyBvbmUgbW9kZWwpLFxuICogbWlycm9yaW5nIGEgZm9sZGVyIGludG8gYSBub2RlIHRyZWUsIGFuZCBsaXN0aW5nIGEgZGlyZWN0b3J5IGZvciB0aGVcbiAqIHN1cmZhY2UncyBwYXRoIGNvbXBsZXRpb24gKGBmcy5saXN0YCkuXG4gKlxuICogUHVyZSBvdmVyIHRoZSBmaWxlc3lzdGVtOiBubyBkYWVtb24gc3RhdGUsIHNvIHRoZSB1bml0IGNlbGxzIGRyaXZlIGl0IHdpdGggYVxuICogdGVtcCBkaXJlY3RvcnkgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRleHRFbnRyeSwgQ29udGV4dE5vZGUsIEZzTGlzdEVudHJ5IH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIFdoYXQgc2NyaXB0b3JpdW0gb3BlbnMgYXMgYSBkb2N1bWVudC4gRXZlcnl0aGluZyBlbHNlIGlzIG5vdCBzaG93bi4gKi9cbmV4cG9ydCBjb25zdCBET0NfRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNEb2NOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIERPQ19FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSk7XG59XG5cbi8qKiBEaXJlY3RvcmllcyBhIG1pcnJvciBuZXZlciBkZXNjZW5kcyBpbnRvIOKAlCBub2lzZSwgbm90IGRvY3VtZW50cy4gKi9cbmNvbnN0IFNLSVBfRElSUyA9IG5ldyBTZXQoW1wibm9kZV9tb2R1bGVzXCIsIFwiLmdpdFwiLCBcImRpc3RcIiwgXCJvdXRcIiwgXCJjb3ZlcmFnZVwiXSk7XG5cbi8qKlxuICogVGhlIG1vc3Qgbm9kZXMgb25lIG1pcnJvcmVkIHNjYW4gd2lsbCBob2xkLiBBIGZvbGRlciBlbnRyeSBwb2ludGVkIGF0IGEgaHVnZVxuICogdHJlZSBtdXN0IG5vdCBzdGFsbCB0aGUgZGFlbW9uIG9yIGZsb29kIGV2ZXJ5IHN0YXRlIGJyb2FkY2FzdDsgaGl0dGluZyB0aGVcbiAqIGNhcCBzZXRzIGB0cnVuY2F0ZWRgIG9uIHRoZSBlbnRyeSBzbyB0aGUgc3VyZmFjZSBjYW4gU0FZIHRoZSBsaXN0IGlzIHNob3J0XG4gKiByYXRoZXIgdGhhbiByZW5kZXIgYSBzaG9ydCBsaXN0IGFzIGEgY29tcGxldGUgb25lLlxuICovXG5leHBvcnQgY29uc3QgTUlSUk9SX05PREVfQ0FQID0gMjAwMDtcblxuZXhwb3J0IGNvbnN0IHRvUG9zaXggPSAocDogc3RyaW5nKSA9PiBwLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG5cbi8qKlxuICogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuXG4gKiBgaGlkZGVuYCByZWxzIChFMjQncyBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIpIGFyZSBza2lwcGVkLCBhIGZvbGRlciB3aXRoXG4gKiBldmVyeXRoaW5nIHVuZGVyIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuICBoaWRkZW46IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4pOiB7IG5vZGVzOiBDb250ZXh0Tm9kZVtdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoaGlkZGVuKTtcbiAgY29uc3Qgd2FsayA9IChkaXI6IHN0cmluZyk6IENvbnRleHROb2RlW10gPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXBzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgY29uc3QgZG9jczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcy5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gY2FwKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKHJvb3QsIGFicykpO1xuICAgICAgaWYgKHNraXAuaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHdhbGsoYWJzKTtcbiAgICAgICAgLy8gQSBmb2xkZXIgaG9sZGluZyBvbmx5IG5vbi1kb2N1bWVudHMgKGltYWdlcywgYXNzZXRzKSBpcyBub2lzZSBpbiBhXG4gICAgICAgIC8vIGRvY3MgbWlycm9yIGFuZCBpcyBsZWZ0IG91dC4gQSBUUlVMWSBFTVBUWSBmb2xkZXIgaXMga2VwdDogaXQgaXMgb25lXG4gICAgICAgIC8vIHNvbWVib2R5IGp1c3QgbWFkZSB0byBwdXQgZG9jdW1lbnRzIGluIChcIk5ldyBmb2xkZXJcIiwgRTI0KSwgYW5kXG4gICAgICAgIC8vIGxlYXZpbmcgaXQgb3V0IG1hZGUgaXQgdmFuaXNoIHRoZSBtb21lbnQgaXQgd2FzIGNyZWF0ZWQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwIHx8IGlzRW1wdHlEaXIoYWJzKSkgZ3JvdXBzLnB1c2goeyBraW5kOiBcImdyb3VwXCIsIHJlbCwgY2hpbGRyZW4gfSk7XG4gICAgICB9IGVsc2UgaWYgKHN0LmlzRmlsZSgpICYmIGlzRG9jTmFtZShuYW1lKSkge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBkb2NzLnB1c2goeyBraW5kOiBcImRvY1wiLCByZWwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbLi4uZ3JvdXBzLCAuLi5kb2NzXTtcbiAgfTtcbiAgY29uc3Qgbm9kZXMgPSB3YWxrKHJvb3QpO1xuICByZXR1cm4geyBub2RlcywgdHJ1bmNhdGVkIH07XG59XG5cbi8qKiBOb3RoaW5nIGluIGl0IGJ1dCBkb3RmaWxlcyAoYSBgLkRTX1N0b3JlYCBkb2VzIG5vdCBtYWtlIGEgZm9sZGVyIGZ1bGwpLiAqL1xuZnVuY3Rpb24gaXNFbXB0eURpcihkaXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIpLmV2ZXJ5KChuKSA9PiBuLnN0YXJ0c1dpdGgoXCIuXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUaGUgbm9kZSBhdCBgcmVsYCBpbiBhIHRyZWUsIG9yIHVuZGVmaW5lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTm9kZShub2RlczogcmVhZG9ubHkgQ29udGV4dE5vZGVbXSwgcmVsOiBzdHJpbmcpOiBDb250ZXh0Tm9kZSB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgIGlmIChuLnJlbCA9PT0gcmVsKSByZXR1cm4gbjtcbiAgICBpZiAobi5raW5kID09PSBcImdyb3VwXCIgJiYgcmVsLnN0YXJ0c1dpdGgoYCR7bi5yZWx9L2ApKSByZXR1cm4gZmluZE5vZGUobi5jaGlsZHJlbiwgcmVsKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgY2xhc3MgUGF0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgY29kZTogXCJtaXNzaW5nXCIgfCBcIm5vdC1hLWRvY1wiLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG4vKipcbiAqIEFuIGVudHJ5IGZvciBhbiBhYnNvbHV0ZSBwYXRoLiBBIGRpcmVjdG9yeSBpcyBgbWlycm9yZWRgOyBhIGRvY3VtZW50IGZpbGUgaXNcbiAqIGBsaXN0ZWRgLCByb290ZWQgYXQgaXRzIHBhcmVudCwgaG9sZGluZyBvbmx5IGl0c2VsZiAoRTE1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudHJ5Rm9yUGF0aChhYnM6IHN0cmluZywgaWQ6IHN0cmluZyk6IENvbnRleHRFbnRyeSB7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHthYnN9YCwgXCJtaXNzaW5nXCIpO1xuICB9XG4gIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShhYnMpO1xuICAgIHJldHVybiB7XG4gICAgICBpZCxcbiAgICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpIHx8IGFicyxcbiAgICAgIHJvb3Q6IGFicyxcbiAgICAgIG1lbWJlcnNoaXA6IFwibWlycm9yZWRcIixcbiAgICAgIG5vZGVzLFxuICAgICAgLi4uKHRydW5jYXRlZCA/IHsgdHJ1bmNhdGVkIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzRG9jTmFtZShhYnMpKSB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihcbiAgICAgIGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2Fic31gLFxuICAgICAgXCJub3QtYS1kb2NcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbGFiZWw6IGJhc2VuYW1lKGFicyksXG4gICAgcm9vdDogZGlybmFtZShhYnMpLFxuICAgIG1lbWJlcnNoaXA6IFwibGlzdGVkXCIsXG4gICAgbm9kZXM6IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUoYWJzKSB9XSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGRvYyBub2RlJ3MgYWJzb2x1dGUgcGF0aCwgZGVwdGgtZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jUGF0aHMoZW50cnk6IENvbnRleHRFbnRyeSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKSA9PiB7XG4gICAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgICBpZiAobi5raW5kID09PSBcImRvY1wiKSBvdXQucHVzaChqb2luKGVudHJ5LnJvb3QsIG4ucmVsKSk7XG4gICAgICBlbHNlIHdhbGsobi5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuICB3YWxrKGVudHJ5Lm5vZGVzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoaWNoIGVudHJ5IChpZiBhbnkpIGhvbGRzIGBhYnNgLCBhbmQgYXQgd2hhdCBgcmVsYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhdGUoXG4gIGVudHJpZXM6IENvbnRleHRFbnRyeVtdLFxuICBhYnM6IHN0cmluZyxcbik6IHsgZW50cnlJZDogc3RyaW5nOyByZWw6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGRvY1BhdGhzKGUpLmluY2x1ZGVzKGFicykpIHJldHVybiB7IGVudHJ5SWQ6IGUuaWQsIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogT25lIGRpcmVjdG9yeSwgZm9yIHRoZSBzdXJmYWNlJ3MgYWRkLWJ5LXBhdGggY29tcGxldGlvbjogc3ViZGlyZWN0b3JpZXMgYW5kXG4gKiBkb2N1bWVudHMgb25seSwgZGlyZWN0b3JpZXMgZmlyc3QuIGB+YCBpcyBleHBhbmRlZCBieSB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdERpcihkaXI6IHN0cmluZyk6IEZzTGlzdEVudHJ5W10ge1xuICBjb25zdCBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gIGNvbnN0IG91dDogRnNMaXN0RW50cnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNEaXIgfHwgaXNEb2NOYW1lKG5hbWUpKSBvdXQucHVzaCh7IG5hbWUsIHBhdGg6IGFicywgZGlyOiBpc0RpciB9KTtcbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IChhLmRpciA9PT0gYi5kaXIgPyBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIDogYS5kaXIgPyAtMSA6IDEpKTtcbn1cbiIsCiAgICAiLy8gRmluZGluZyB0aGluZ3MgYWNyb3NzIGV2ZXJ5dGhpbmcgaW4gdGhlIGNvbnRleHQgKEU1OSkuXG4vL1xuLy8g4puUIFRXTyBNQVRDSEVSUywgT04gUFVSUE9TRSwgYmVjYXVzZSB0aGV5IGFuc3dlciBkaWZmZXJlbnQgcXVlc3Rpb25zLiBOb3RlXG4vLyBhcHBzIHNwbGl0IHRoZXNlIGFuZCBpdCBpcyBub3QgYW4gYWNjaWRlbnQ6IEZVWlpZIG9uIG5hbWVzIGlzIGZvciBqdW1waW5nXG4vLyAoXCJtYWJha1wiIOKGkiBNYXJlbidzIEJha2VyeSksIGFuZCBFWEFDVCBvbiBjb250ZW50IGlzIGZvciBmaW5kaW5nIChcIndoZXJlIGRpZCBJXG4vLyBzYXkgJ2Fza2luZy1uaWNlbHknXCIpLiBGdXp6eSBmdWxsLXRleHQgd291bGQgYmUgdGhlIHdvcnN0IG9mIGJvdGgg4oCUIHNlYXJjaGluZ1xuLy8gYGJyaWRnZWAgd291bGQgc3VyZmFjZSBkb2N1bWVudHMgdGhhdCBtZXJlbHkgY29udGFpbiBzaW1pbGFyLWxvb2tpbmcgbGV0dGVycyxcbi8vIGFuZCB5b3UgY291bGQgbm8gbG9uZ2VyIHRydXN0IFwidGhpcyBwaHJhc2UgaXMgb24gbGluZSAyOVwiLCB3aGljaCBpcyB0aGUgb25seVxuLy8gdGhpbmcgYSBjb250ZW50IHNlYXJjaCBpcyBmb3IuIChDb2xlIHJhaXNlZCBGdXNlIGZvciB0aGUgbmFtZSBoYWxmIGFuZCBjaG9zZVxuLy8gdGhlIGhhbmQtcm9sbGVkIHNjb3JlcjogdGhlcmUgaXMgbm8gc2Vjb25kIGVuZ2luZSB0aGlzIGhhcyB0byBhZ3JlZSB3aXRoLCBzb1xuLy8gZnV6enkgcmFua2luZyBpcyBhIHNlbGYtY29udGFpbmVkIHRhc3RlIGp1ZGdtZW50IHdpdGggbm8gZHJpZnQgcmlzay4pXG4vL1xuLy8g4pqgIEFORCBJVCBTRUFSQ0hFUyBXSEFUIFRIRSBIVU1BTiBJUyBMT09LSU5HIEFULCB3aGljaCBpcyBub3QgYWx3YXlzIHRoZSBmaWxlLlxuLy8gQSBkb2N1bWVudCBvcGVuIGluIHRoZSBzZXNzaW9uIGlzIHNob3duIGFzIGl0cyBBQ1RJVkUgVkVSU0lPTiwgd2hpY2ggbGl2ZXNcbi8vIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgcmF0aGVyIHRoYW4gYXQgdGhlIG9yaWdpbmFsIHBhdGgg4oCUIHNvIGFuIGVkaXQgbWFkZSB0d29cbi8vIG1pbnV0ZXMgYWdvIG11c3Qgc3RpbGwgYmUgZmluZGFibGUuIFRoYXQgYXN5bW1ldHJ5IGlzIGFsc28gdGhlIHJlYXNvbiB0aGlzXG4vLyBleGlzdHMgZm9yIHRoZSBBR0VOVCBhdCBhbGw6IGdyZXAgb3ZlciB0aGUgd29ya3NwYWNlIGZpbmRzIHRoZSBTQVZFRCBmaWxlIGFuZFxuLy8gc2lsZW50bHkgbWlzc2VzIHRoZSB2ZXJzaW9uIGJlaW5nIHJlYWQuIFRoZSBjYWxsZXIgc3VwcGxpZXMgdGhlIHRleHQgcGVyXG4vLyBkb2N1bWVudCBmb3IgZXhhY3RseSB0aGlzIHJlYXNvbiAoc2VlIGBTZXNzaW9uLnNlYXJjaEFsbGApLlxuXG4vKiogT25lIGxpbmUgdGhhdCBtYXRjaGVkLCB3aXRoIHRoZSBvZmZzZXRzIG9mIHRoZSBoaXQgaW5zaWRlIHRoZSBkb2N1bWVudC4gKi9cbmV4cG9ydCB0eXBlIEhpdCA9IHtcbiAgLyoqIDEtYmFzZWQsIHNvIGl0IGNhbiBiZSBzaG93biBhbmQgb3BlbmVkLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBUaGUgbGluZSwgZm9yIGNvbnRleHQgaW4gdGhlIHJlc3VsdCBsaXN0LiAqL1xuICB0ZXh0OiBzdHJpbmc7XG4gIC8qKiBPZmZzZXRzIG9mIHRoZSBtYXRjaCB3aXRoaW4gdGhlIGRvY3VtZW50LCBmb3IgcmV2ZWFsLWFuZC1zZWxlY3QuICovXG4gIGZyb206IG51bWJlcjtcbiAgdG86IG51bWJlcjtcbn07XG5cbi8qKlxuICogSG93IG11Y2ggb2YgYSBsaW5lIGlzIHdvcnRoIGNhcnJ5aW5nIGJhY2suIEEgcmVzdWx0IGxpc3QgaXMgYSBsaXN0LCBhbmQgYVxuICogZG9jdW1lbnQgd2l0aCBhIDQsMDAwLWNoYXJhY3RlciBwYXJhZ3JhcGggc2hvdWxkIG5vdCBzZW5kIGFsbCBvZiBpdCBwZXIgaGl0LlxuICovXG5jb25zdCBMSU5FX0NBUCA9IDI0MDtcblxuLyoqIEV2ZXJ5IG1hdGNoIG9mIGBxdWVyeWAgaW4gYHRleHRgLCBhdCBtb3N0IGBsaW1pdGAgb2YgdGhlbS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWFyY2hUZXh0KHRleHQ6IHN0cmluZywgcXVlcnk6IHN0cmluZywgbGltaXQgPSA1MCk6IEhpdFtdIHtcbiAgY29uc3QgbmVlZGxlID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuZWVkbGUgPT09IFwiXCIgfHwgbGltaXQgPD0gMCkgcmV0dXJuIFtdO1xuICBjb25zdCBoYXkgPSB0ZXh0LnRvTG93ZXJDYXNlKCk7XG4gIGxldCBhdCA9IGhheS5pbmRleE9mKG5lZWRsZSk7XG4gIGlmIChhdCA9PT0gLTEpIHJldHVybiBbXTtcbiAgLy8gTGluZSBzdGFydHMsIHdhbGtlZCBPTkNFLiBBIHBlci1oaXQgYGxhc3RJbmRleE9mKFwiXFxuXCIpYCBpcyBxdWFkcmF0aWMgb3ZlciBhXG4gIC8vIGRvY3VtZW50IHRoYXQgbWF0Y2hlcyBvbiBldmVyeSBsaW5lLCB3aGljaCBpcyBleGFjdGx5IHRoZSBkb2N1bWVudCBzb21lb25lXG4gIC8vIHNlYXJjaGVzIGZvciBhIGNvbW1vbiB3b3JkLlxuICBjb25zdCBzdGFydHM6IG51bWJlcltdID0gWzBdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpKyspIGlmICh0ZXh0LmNoYXJDb2RlQXQoaSkgPT09IDEwKSBzdGFydHMucHVzaChpICsgMSk7XG4gIGNvbnN0IGhpdHM6IEhpdFtdID0gW107XG4gIGxldCBjdXJzb3IgPSAwO1xuICB3aGlsZSAoYXQgIT09IC0xICYmIGhpdHMubGVuZ3RoIDwgbGltaXQpIHtcbiAgICB3aGlsZSAoY3Vyc29yICsgMSA8IHN0YXJ0cy5sZW5ndGggJiYgKHN0YXJ0c1tjdXJzb3IgKyAxXSBhcyBudW1iZXIpIDw9IGF0KSBjdXJzb3IrKztcbiAgICBjb25zdCBsaW5lU3RhcnQgPSBzdGFydHNbY3Vyc29yXSBhcyBudW1iZXI7XG4gICAgY29uc3QgbGluZUVuZCA9IGN1cnNvciArIDEgPCBzdGFydHMubGVuZ3RoID8gKHN0YXJ0c1tjdXJzb3IgKyAxXSBhcyBudW1iZXIpIC0gMSA6IHRleHQubGVuZ3RoO1xuICAgIGNvbnN0IHdob2xlID0gdGV4dC5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpO1xuICAgIGhpdHMucHVzaCh7XG4gICAgICBsaW5lOiBjdXJzb3IgKyAxLFxuICAgICAgdGV4dDogd2hvbGUubGVuZ3RoID4gTElORV9DQVAgPyBgJHt3aG9sZS5zbGljZSgwLCBMSU5FX0NBUCAtIDEpfeKApmAgOiB3aG9sZSxcbiAgICAgIGZyb206IGF0LFxuICAgICAgdG86IGF0ICsgbmVlZGxlLmxlbmd0aCxcbiAgICB9KTtcbiAgICAvLyDimqAgQURWQU5DRSBQQVNUIFRIRSBNQVRDSCwgTk9UIFRIRSBMSU5FOiB0d28gaGl0cyBvbiBvbmUgbGluZSBhcmUgdHdvXG4gICAgLy8gaGl0cywgYW5kIHN0ZXBwaW5nIGJ5IGxpbmUgd291bGQgc2lsZW50bHkgZHJvcCB0aGUgc2Vjb25kLlxuICAgIGF0ID0gaGF5LmluZGV4T2YobmVlZGxlLCBhdCArIG5lZWRsZS5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBoaXRzO1xufVxuXG4vKiogSXMgdGhpcyBjaGFyYWN0ZXIgYSB3b3JkIGJvdW5kYXJ5IGZvciBzY29yaW5nIHB1cnBvc2VzPyAqL1xuZnVuY3Rpb24gaXNCb3VuZGFyeShjaDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBjaCA9PT0gXCIgXCIgfHwgY2ggPT09IFwiLVwiIHx8IGNoID09PSBcIl9cIiB8fCBjaCA9PT0gXCIvXCIgfHwgY2ggPT09IFwiLlwiIHx8IGNoID09PSBcIidcIjtcbn1cblxuLyoqXG4gKiBIb3cgd2VsbCBgbmFtZWAgbWF0Y2hlcyBgcXVlcnlgIGFzIGEgZnV6enkgc3Vic2VxdWVuY2Ug4oCUIGhpZ2hlciBpcyBiZXR0ZXIsXG4gKiBgbnVsbGAgd2hlbiB0aGUgcXVlcnkncyBjaGFyYWN0ZXJzIGRvIG5vdCBhcHBlYXIgaW4gb3JkZXIgYXQgYWxsLlxuICpcbiAqIFRoZSB3ZWlnaHRzIGVuY29kZSB3aGF0IHNvbWVvbmUgdHlwaW5nIGludG8gYSBqdW1wIGJveCBtZWFuczpcbiAqXG4gKiAtICoqY29udGlndWl0eSoqIGRvbWluYXRlcywgYmVjYXVzZSBgbWFyZWAgbWVhbmluZyBgTWFyZW5gIGlzIHRoZSBjb21tb24gY2FzZVxuICogICBhbmQgYG3igKZh4oCmcuKApmVgIHNjYXR0ZXJlZCB0aHJvdWdoIGEgc2VudGVuY2UgaXMgdGhlIHJhcmUgb25lO1xuICogLSAqKndvcmQgc3RhcnRzKiogc2NvcmUsIHNvIGBtYmAgZmluZHMgYE1hcmVuJ3MgQmFrZXJ5YCByYXRoZXIgdGhhbiBgTnVtYmVyYDtcbiAqIC0gKiplYXJsaWVyIGlzIGJldHRlcioqLCBhbmQgYSAqKnNob3J0ZXIgbmFtZSoqIHdpbnMgYSB0aWUsIGJlY2F1c2UgdGhlIHRoaW5nXG4gKiAgIHlvdSBtZWFudCBpcyB1c3VhbGx5IHRoZSB0aGluZyB3aXRoIGxlc3MgYXJvdW5kIGl0LlxuICpcbiAqIOKaoCBUSEUgTlVNQkVSUyBBUkUgVEFTVEUsIE5PVCBUUlVUSC4gVGhleSBhcmUgcGlubmVkIGJ5IGNlbGxzIHRoYXQgYXNzZXJ0XG4gKiBPUkRFUklOR1MgKFwidGhpcyBiZWF0cyB0aGF0XCIpIHJhdGhlciB0aGFuIHZhbHVlcywgc28gdGhleSBjYW4gYmUgcmV0dW5lZFxuICogd2l0aG91dCByZXdyaXRpbmcgdGhlIHRlc3RzIOKAlCB3aGljaCBpcyB0aGUgb25seSB3YXkgYSBzY29yZXIgbGlrZSB0aGlzIHN0YXlzXG4gKiBjaGFuZ2VhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NvcmVOYW1lKG5hbWU6IHN0cmluZywgcXVlcnk6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChxID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgaGF5ID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICBsZXQgc2NvcmUgPSAwO1xuICBsZXQgYXQgPSAwO1xuICBsZXQgcnVuID0gMDtcbiAgZm9yIChjb25zdCBjaCBvZiBxKSB7XG4gICAgY29uc3QgZm91bmQgPSBoYXkuaW5kZXhPZihjaCwgYXQpO1xuICAgIGlmIChmb3VuZCA9PT0gLTEpIHJldHVybiBudWxsO1xuICAgIHJ1biA9IGZvdW5kID09PSBhdCAmJiBhdCA+IDAgPyBydW4gKyAxIDogMDtcbiAgICBzY29yZSArPSAxMCArIHJ1biAqIDEyO1xuICAgIGlmIChmb3VuZCA9PT0gMCB8fCBpc0JvdW5kYXJ5KGhheVtmb3VuZCAtIDFdIGFzIHN0cmluZykpIHNjb3JlICs9IDE0O1xuICAgIC8vIERpc3RhbmNlIGZyb20gd2hlcmUgd2Ugd2VyZSBsb29raW5nIGNvc3RzLCBzbyBzY2F0dGVyZWQgbWF0Y2hlcyByYW5rIGxvdy5cbiAgICBzY29yZSAtPSBNYXRoLm1pbihmb3VuZCAtIGF0LCAxMik7XG4gICAgYXQgPSBmb3VuZCArIDE7XG4gIH1cbiAgLy8gQSB3aG9sZS13b3JkIHN1YnN0cmluZyBpcyB0aGUgc3Ryb25nZXN0IHNpZ25hbCB0aGVyZSBpczsgc2F5IHNvIGxvdWRseS5cbiAgaWYgKGhheS5pbmNsdWRlcyhxKSkgc2NvcmUgKz0gNDA7XG4gIGlmIChoYXkuc3RhcnRzV2l0aChxKSkgc2NvcmUgKz0gMjU7XG4gIC8vIFNob3J0ZXIgbmFtZXMgd2luIHRpZXMuXG4gIHNjb3JlIC09IE1hdGgubWluKG5hbWUubGVuZ3RoLCA0MCkgLyA0O1xuICByZXR1cm4gc2NvcmU7XG59XG5cbi8qKiBBIGRvY3VtZW50IHRoZSBOQU1FIG1hdGNoZWQuICovXG5leHBvcnQgdHlwZSBOYW1lTWF0Y2ggPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgc2NvcmU6IG51bWJlcjtcbn07XG5cbi8qKlxuICog4puUIFRIRSBTV0FQIFNFQU0gKENvbGUpOiBcImlmIHdlIGZpbmQgdGhhdCBhY3R1YWxseSB3ZSBzaG91bGQgdXNlIEZ1c2UsIGl0J3NcbiAqIGZhaXJseSBlYXN5IHRvIHJlcGxhY2UuXCJcbiAqXG4gKiBUaGUgaW50ZXJmYWNlIGlzIENPUlBVUy1TSEFQRUQg4oCUIHRha2UgdGhlIHdob2xlIGNhbmRpZGF0ZSBsaXN0IGFuZCBhIHF1ZXJ5LFxuICogcmV0dXJuIGEgcmFua2VkIHNsaWNlIOKAlCBhbmQgdGhhdCBzaGFwZSBpcyB0aGUgd2hvbGUgcG9pbnQuIEEgcGVyLWl0ZW1cbiAqIGBzY29yZShuYW1lLCBxdWVyeSlgIGhvb2sgd291bGQgaGF2ZSBsb29rZWQgbGlrZSB0aGUgc21hbGxlciBhYnN0cmFjdGlvbiBhbmRcbiAqIHdvdWxkIGhhdmUgRk9VR0hUIHRoZSB2ZXJ5IGxpYnJhcnkgaXQgZXhpc3RzIHRvIGFkbWl0OiBGdXNlIGluZGV4ZXMgYSBsaXN0XG4gKiBhbmQgc2VhcmNoZXMgaXQsIGl0IGRvZXMgbm90IHNjb3JlIG9uZSBzdHJpbmcgYXQgYSB0aW1lLiBXcml0dGVuIHRoaXMgd2F5LFxuICogbW92aW5nIHRvIEZ1c2UgaXMgYSBuZXcgZnVuY3Rpb24gYW5kIG9uZSBkZWZhdWx0IGNoYW5nZWQ6XG4gKlxuICogICAgIGNvbnN0IGZ1c2VOYW1lczogTmFtZVNlYXJjaCA9IChjYW5kaWRhdGVzLCBxdWVyeSwgbGltaXQpID0+IHtcbiAqICAgICAgIGNvbnN0IGZ1c2UgPSBuZXcgRnVzZShjYW5kaWRhdGVzLCB7IGtleXM6IFtcIm5hbWVcIiwgXCJ0aXRsZVwiXSwg4oCmIH0pO1xuICogICAgICAgcmV0dXJuIGZ1c2Uuc2VhcmNoKHF1ZXJ5LCB7IGxpbWl0IH0pLm1hcCjigKYpO1xuICogICAgIH07XG4gKlxuICogTm90aGluZyBlbHNlIGluIHRoaXMgbW9kdWxlLCB0aGUgc2Vzc2lvbiwgdGhlIHdpcmUgb3IgdGhlIHN1cmZhY2UgbW92ZXMuXG4gKi9cbmV4cG9ydCB0eXBlIE5hbWVTZWFyY2ggPSAoXG4gIGNhbmRpZGF0ZXM6IHJlYWRvbmx5IENhbmRpZGF0ZVtdLFxuICBxdWVyeTogc3RyaW5nLFxuICBsaW1pdDogbnVtYmVyLFxuKSA9PiBOYW1lTWF0Y2hbXTtcblxuLyoqIEEgZG9jdW1lbnQgdGhlIENPTlRFTlQgbWF0Y2hlZC4gKi9cbmV4cG9ydCB0eXBlIFRleHRNYXRjaCA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzbHVnPzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGhpdHM6IEhpdFtdO1xufTtcblxuZXhwb3J0IHR5cGUgU2VhcmNoUmVwb3J0ID0ge1xuICBxdWVyeTogc3RyaW5nO1xuICAvKiogTmFtZS90aXRsZSBtYXRjaGVzLCBiZXN0IGZpcnN0IOKAlCB0aGUganVtcCBsaXN0LiAqL1xuICBkb2N1bWVudHM6IE5hbWVNYXRjaFtdO1xuICAvKiogQ29udGVudCBtYXRjaGVzLCBpbiBjb250ZXh0IG9yZGVyIOKAlCB0aGUgZmluZCBsaXN0LiAqL1xuICB0ZXh0OiBUZXh0TWF0Y2hbXTtcbiAgLyoqIFRvdGFsIGNvbnRlbnQgaGl0cyByZXBvcnRlZC4gKi9cbiAgY291bnQ6IG51bWJlcjtcbiAgLyoqIFRydWUgd2hlbiBhIGNhcCBzdG9wcGVkIHRoZSBzZWFyY2ggZWFybHksIHNvIFwiM1wiIGFuZCBcIjMgb2YgbW9yZVwiIGRpZmZlci4gKi9cbiAgdHJ1bmNhdGVkOiBib29sZWFuO1xufTtcblxuLyoqIFBlci1kb2N1bWVudCBjb250ZW50IGNhcCwgc28gb25lIGVub3Jtb3VzIGRvY3VtZW50IGNhbm5vdCBmaWxsIHRoZSByZXBvcnQuICovXG5leHBvcnQgY29uc3QgUEVSX0RPQyA9IDIwO1xuLyoqIFdob2xlLXJlcG9ydCBjb250ZW50IGNhcC4gKi9cbmV4cG9ydCBjb25zdCBUT1RBTCA9IDIwMDtcbi8qKiBIb3cgbWFueSBuYW1lIG1hdGNoZXMgYXJlIHdvcnRoIHNob3dpbmcuICovXG5leHBvcnQgY29uc3QgTkFNRVMgPSAxMDtcblxuLyoqXG4gKiBUaGUgZGVmYXVsdCBgTmFtZVNlYXJjaGA6IGBzY29yZU5hbWVgIG92ZXIgZXZlcnkgY2FuZGlkYXRlLCByYW5rZWQuXG4gKlxuICogQSBkb2N1bWVudCdzIFRJVExFIGlzIG1hdGNoZWQgYXMgd2VsbCBhcyBpdHMgZmlsZW5hbWUg4oCUIGFuIE9LRiBkb2N1bWVudCdzXG4gKiBuYW1lIGFuZCB0aXRsZSBvZnRlbiBkaWZmZXIgYW5kIHRoZSBodW1hbiBtYXkgcmVtZW1iZXIgZWl0aGVyIOKAlCBhbmQgdGhlXG4gKiBiZXR0ZXIgb2YgdGhlIHR3byBzY29yZXMgaXMgdGhlIG9uZSB0aGF0IGNvdW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IHJhbmtOYW1lczogTmFtZVNlYXJjaCA9IChjYW5kaWRhdGVzLCBxdWVyeSwgbGltaXQpID0+IHtcbiAgY29uc3Qgb3V0OiBOYW1lTWF0Y2hbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGMgb2YgY2FuZGlkYXRlcykge1xuICAgIGNvbnN0IGJ5TmFtZSA9IHNjb3JlTmFtZShjLm5hbWUsIHF1ZXJ5KTtcbiAgICBjb25zdCBieVRpdGxlID0gYy50aXRsZSA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IHNjb3JlTmFtZShjLnRpdGxlLCBxdWVyeSk7XG4gICAgaWYgKGJ5TmFtZSA9PT0gbnVsbCAmJiBieVRpdGxlID09PSBudWxsKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBwYXRoOiBjLnBhdGgsXG4gICAgICAuLi4oYy5zbHVnICE9PSB1bmRlZmluZWQgPyB7IHNsdWc6IGMuc2x1ZyB9IDoge30pLFxuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgLi4uKGMudGl0bGUgIT09IHVuZGVmaW5lZCA/IHsgdGl0bGU6IGMudGl0bGUgfSA6IHt9KSxcbiAgICAgIHNjb3JlOiBNYXRoLm1heChieU5hbWUgPz8gLUluZmluaXR5LCBieVRpdGxlID8/IC1JbmZpbml0eSksXG4gICAgfSk7XG4gIH1cbiAgb3V0LnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlIHx8IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkpO1xuICByZXR1cm4gb3V0LnNsaWNlKDAsIGxpbWl0KTtcbn07XG5cbmV4cG9ydCB0eXBlIENhbmRpZGF0ZSA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIGJhc2VuYW1lLCB3aGljaCBpcyB3aGF0IGEgaHVtYW4gdHlwZXMgYXQuICovXG4gIG5hbWU6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBudW1iZXI7XG59O1xuXG4vKipcbiAqIFNlYXJjaCBhIGxpc3Qgb2YgY2FuZGlkYXRlcyBmb3IgYm90aCBraW5kcyBvZiBtYXRjaC5cbiAqXG4gKiBgcmVhZGAgbWF5IHRocm93IG9yIHJldHVybiBudWxsIGZvciBhIGRvY3VtZW50IHRoYXQgaGFzIGJlZW4gZGVsZXRlZCB1bmRlclxuICogdGhlIGNvbnRleHQg4oCUIGEgc2VhcmNoIGlzIG5vdCB0aGUgbW9tZW50IHRvIGZhaWwgb3ZlciB0aGF0LCBzbyBpdCBpcyBza2lwcGVkXG4gKiByYXRoZXIgdGhhbiByZXBvcnRlZCBhcyBhIGRvY3VtZW50IHdpdGggbm8gaGl0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlYXJjaERvY3VtZW50cyhcbiAgY2FuZGlkYXRlczogcmVhZG9ubHkgQ2FuZGlkYXRlW10sXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHJlYWQ6IChjOiBDYW5kaWRhdGUpID0+IHN0cmluZyB8IG51bGwsXG4gIGNhcHM6IHsgcGVyRG9jPzogbnVtYmVyOyB0b3RhbD86IG51bWJlcjsgbmFtZXM/OiBudW1iZXI7IG5hbWVTZWFyY2g/OiBOYW1lU2VhcmNoIH0gPSB7fSxcbik6IFNlYXJjaFJlcG9ydCB7XG4gIGNvbnN0IHEgPSBxdWVyeS50cmltKCk7XG4gIGlmIChxID09PSBcIlwiKSByZXR1cm4geyBxdWVyeTogXCJcIiwgZG9jdW1lbnRzOiBbXSwgdGV4dDogW10sIGNvdW50OiAwLCB0cnVuY2F0ZWQ6IGZhbHNlIH07XG4gIGNvbnN0IHBlckRvYyA9IGNhcHMucGVyRG9jID8/IFBFUl9ET0M7XG4gIGNvbnN0IHRvdGFsID0gY2Fwcy50b3RhbCA/PyBUT1RBTDtcbiAgY29uc3QgbmFtZXMgPSBjYXBzLm5hbWVzID8/IE5BTUVTO1xuXG4gIGNvbnN0IHNjb3JlZCA9IChjYXBzLm5hbWVTZWFyY2ggPz8gcmFua05hbWVzKShjYW5kaWRhdGVzLCBxLCBuYW1lcyk7XG5cbiAgY29uc3QgdGV4dDogVGV4dE1hdGNoW10gPSBbXTtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGMgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmIChjb3VudCA+PSB0b3RhbCkge1xuICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBsZXQgYm9keTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGJvZHkgPSByZWFkKGMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgYm9keSA9IG51bGw7XG4gICAgfVxuICAgIGlmIChib2R5ID09PSBudWxsKSBjb250aW51ZTtcbiAgICBjb25zdCByb29tID0gTWF0aC5taW4ocGVyRG9jLCB0b3RhbCAtIGNvdW50KTtcbiAgICBjb25zdCBoaXRzID0gc2VhcmNoVGV4dChib2R5LCBxLCByb29tICsgMSk7XG4gICAgaWYgKGhpdHMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBpZiAoaGl0cy5sZW5ndGggPiByb29tKSB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGNvbnN0IGtlcHQgPSBoaXRzLnNsaWNlKDAsIHJvb20pO1xuICAgIGNvdW50ICs9IGtlcHQubGVuZ3RoO1xuICAgIHRleHQucHVzaCh7XG4gICAgICBwYXRoOiBjLnBhdGgsXG4gICAgICAuLi4oYy5zbHVnICE9PSB1bmRlZmluZWQgPyB7IHNsdWc6IGMuc2x1ZyB9IDoge30pLFxuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgLi4uKGMudmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyB2ZXJzaW9uOiBjLnZlcnNpb24gfSA6IHt9KSxcbiAgICAgIGhpdHM6IGtlcHQsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4geyBxdWVyeTogcSwgZG9jdW1lbnRzOiBzY29yZWQsIHRleHQsIGNvdW50LCB0cnVuY2F0ZWQgfTtcbn1cbiIsCiAgICAiLy8gSXMgdGhlIGh1bWFuIHdhaXRpbmcgb24gYW4gYW5zd2VyLCBhbmQgZm9yIGhvdyBsb25nIChFNTMpP1xuLy9cbi8vIOKblCBERVJJVkVELCBOT1QgREVDTEFSRUQg4oCUIENvbGUncyBydWxpbmcsIGFuZCB0aGUgcmVhc29uIGlzIGxvYWQtYmVhcmluZzogXCJ3ZVxuLy8gY291bGQgYWRkIHNvbWUgYWZmb3JkYW5jZSB0aGF0IHNlbmRzIGEgY2hlY2staW4gd2l0aCBhbiBhZ2VudOKApiB3aGVyZSB3ZSdyZVxuLy8gbm90IGFkZGluZyBtb3JlIHRhc2tzIGZvciB0aGUgYWdlbnQgdG8gaGF2ZSB0byBleHBsaWNpdGx5IGRvLlwiIEFuIGFnZW50IHRoYXRcbi8vIG11c3QgcmVtZW1iZXIgdG8gc2F5IFwidGhpbmtpbmdcIiB3aWxsIGZvcmdldCBleGFjdGx5IHdoZW4gaXQgbWF0dGVycyDigJQgaXQgaXNcbi8vIGJ1c3ksIHdoaWNoIGlzIHRoZSB3aG9sZSBzaXR1YXRpb24gYmVpbmcgc2lnbmFsbGVkLiBTbyBub3RoaW5nIGhlcmUgYXNrcyB0aGVcbi8vIGFnZW50IGZvciBhbnl0aGluZy4gVGhlIHN0YXRlIGlzIHJlYWQgb2ZmIHRoZSBjb252ZXJzYXRpb246IGEgaHVtYW4gbWVzc2FnZVxuLy8gd2l0aCBubyBhZ2VudCBtZXNzYWdlIGFmdGVyIGl0IGlzIGEgaHVtYW4gd2FpdGluZy5cbi8vXG4vLyDim5QgQU5EIFRIRSBBR0VOVCdTIFJFUExZIElTIFRIRSBDT01QTEVUSU9OIFNJR05BTCwgd2hpY2ggaXMgbWluZC1tYXBwZXInc1xuLy8gcnVsZSAoUjExIFNFQU0gMikgYW5kIGlzIHN0b2xlbiBkZWxpYmVyYXRlbHkuIFRoZXJlIGlzIG5vIGBkb25lYCBzdGF0ZSB0b1xuLy8gZW1pdCwgc28gdGhlcmUgaXMgbm8gYGRvbmVgIHN0YXRlIHRvIGdldCBvdXQgb2Ygc3luYy4gT25lIGNvbnNlcXVlbmNlIHdvcnRoXG4vLyBuYW1pbmcgYmVjYXVzZSBpdCBmZWxsIG91dCBmb3IgZnJlZTogYHN0YXJ0VGFza2AgcG9zdHMgaXRzIGFubm91bmNlbWVudCBBU1xuLy8gVEhFIEFHRU5UIChFNTApLCBzbyB0aGUgaGFwcHkgcGF0aCBDb2xlIGRlc2NyaWJlZCDigJQgXCJncmVhdCwgSSdtIGdvaW5nIHRvIGdldFxuLy8gdGhhdCBzdGFydGVkXCIsIHRoZW4gYSB0YXNrLCB0aGVuIGEgc3ViYWdlbnQg4oCUIGNsZWFycyB0aGlzIGJ5IGNvbnN0cnVjdGlvbi5cbi8vXG4vLyDimqAgQSBTWVNURU0gTElORSBJUyBOT1QgQSBSRVBMWS4gYGFubm91bmNlKClgIG5hcnJhdGVzIGFnZW50IEFDVFMgKFwiQWdlbnRcbi8vIG5vdGVkIOKApiBvbiBtYXJlblwiKSwgd2hpY2ggaXMgZXZpZGVuY2Ugb2YgbGlmZSBidXQgbm90IGEgY2hlY2staW4gd2l0aCB0aGVcbi8vIHBlcnNvbiB3YWl0aW5nLiBDb3VudGluZyBpdCB3b3VsZCBzaWxlbmNlIHRoZSBzaWduYWwgcHJlY2lzZWx5IGluIHRoZSBjYXNlXG4vLyB0aGlzIGV4aXN0cyBmb3I6IGFuIGFnZW50IHRoYXQgaXMgYnVzeSBkb2luZyB0aGluZ3MgYW5kIGhhcyBub3Qgc2FpZCBhIHdvcmRcbi8vIHRvIHRoZSBodW1hbi4gT25seSBgd2hvID09PSBcImFnZW50XCJgIGNsZWFycy5cbmltcG9ydCB0eXBlIHsgQ2hhdFdobywgTm90ZSwgTm90ZVdhaXRpbmcsIFdhaXRpbmcgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIEhvdyBsb25nIGEgaHVtYW4gd2FpdHMgYmVmb3JlIHRoZSB3YWl0IGlzIHdvcnRoIHJlcG9ydGluZy4gMzAgcywgQ29sZSdzXG4gKiBudW1iZXIg4oCUIGxvbmcgZW5vdWdoIHRoYXQgYW4gb3JkaW5hcnkgYW5zd2VyIG5ldmVyIHRyaXBzIGl0LCBzaG9ydCBlbm91Z2hcbiAqIHRoYXQgaXQgaXMgc3RpbGwgdGhlIHNhbWUgbW9tZW50IGZvciB0aGUgcGVyc29uIHNpdHRpbmcgdGhlcmUuXG4gKi9cbmV4cG9ydCBjb25zdCBTVEFMTF9NUyA9IDMwXzAwMDtcblxuLyoqIFdoYXQgYSBzbm9vemUgYnV5cywgd2hlbiB0aGUgYWdlbnQgZG9lcyBub3QgbmFtZSBhIGR1cmF0aW9uLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU05PT1pFX01TID0gMTIwXzAwMDtcblxuLy8gYFdhaXRpbmdgIGl0c2VsZiBsaXZlcyBpbiBgcHJvdG9jb2wudHNgIOKAlCBpdCByaWRlcyBpbiBgUHVibGljU3RhdGVgLCBhbmQgdGhhdFxuLy8gZmlsZSBpcyBpbXBvcnQtZnJlZSBvbiBwdXJwb3NlLiBJdHMgYGJhZGdlYCBjYXJyaWVzIHRoZSBydWxlIHRoYXQgbWF0dGVyczpcbi8vIOKblCBTVEFMTEVEIE1VU1QgTk9UIFBVTFNFLiBBIHB1bHNlIG92ZXIgYSB3ZWRnZWQgYWdlbnQgaXMgZmFsc2UgbGl2ZW5lc3Mg4oCUIHRoZVxuLy8gYW5pbWF0aW9uIGNsYWltcyBcInNvbWV0aGluZyBpcyBoYXBwZW5pbmdcIiB3aGVuIHRoZSBob25lc3QgYW5zd2VyIGlzIFwiSSBjYW5ub3Rcbi8vIHRlbGwgYW55IG1vcmVcIi4gbWluZC1tYXBwZXIgc2VwYXJhdGVzIHRoZXNlIHR3byBmb3IgdGhlIHNhbWUgcmVhc29uLlxuXG50eXBlIE1zZyA9IHsgaWQ6IHN0cmluZzsgd2hvOiBDaGF0V2hvOyB0czogbnVtYmVyIH07XG5cbi8qKlxuICogVGhlIGh1bWFuIG1lc3NhZ2Ugbm90aGluZyBoYXMgYW5zd2VyZWQgeWV0LCBvciBudWxsLlxuICpcbiAqIGBhY2tub3dsZWRnZWRVbnRpbGAgaXMgYSBzbm9vemUgKHRoZSBhZ2VudCBzYWlkIGl0IGlzIHN0aWxsIHdvcmtpbmcpLiBXaGlsZVxuICogaXQgaG9sZHMsIHRoZSBiYWRnZSBzdGF5cyBhIHB1bHNlIHBhc3QgdGhlIHN0YWxsIHRocmVzaG9sZCDigJQgdGhlIGFnZW50XG4gKiB2b2x1bnRlZXJlZCBldmlkZW5jZSBvZiBsaWZlLCBzbyBzaG93aW5nIFwibWF5IGJlIHN0dWNrXCIgd291bGQgYmUgdGhlIGxpZS5cbiAqIFdoZW4gaXQgRVhQSVJFUyB0aGUgYmFkZ2UgZ29lcyBzdGFsbGVkIGFnYWluLCBiZWNhdXNlIHRoZSBodW1hbiBpcyBvd2VkIHRoZVxuICogdHJ1dGggZXZlbnR1YWxseTsgdGhhdCBleHBpcnkgaXMgZGVsaWJlcmF0ZWx5IG5vdCBhIHJlYXNvbiB0byBudWRnZSB0aGUgYWdlbnRcbiAqIGEgc2Vjb25kIHRpbWUgKHNlZSB0aGUgc2VydmVyJ3Mgb25jZS1wZXItbWVzc2FnZSBydWxlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhaXRpbmdPbihcbiAgY2hhdDogcmVhZG9ubHkgTXNnW10sXG4gIG5vdzogbnVtYmVyLFxuICBvcHRzOiB7IHN0YWxsTXM/OiBudW1iZXI7IGFja25vd2xlZGdlZFVudGlsPzogbnVtYmVyIH0gPSB7fSxcbik6IFdhaXRpbmcgfCBudWxsIHtcbiAgLy8gV2FsayBiYWNrIHRvIHRoZSBsYXN0IHRoaW5nIHRoYXQgd2FzIG5vdCBuYXJyYXRpb24uIEEgaHVtYW4gdGhlcmUgbWVhbnNcbiAgLy8gbm9ib2R5IGhhcyBhbnN3ZXJlZCB0aGVtLlxuICBsZXQgcGVuZGluZzogTXNnIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBjaGF0Lmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbSA9IGNoYXRbaV07XG4gICAgaWYgKCFtIHx8IG0ud2hvID09PSBcInN5c3RlbVwiKSBjb250aW51ZTtcbiAgICBpZiAobS53aG8gPT09IFwiYWdlbnRcIikgcmV0dXJuIG51bGw7XG4gICAgcGVuZGluZyA9IG07XG4gICAgYnJlYWs7XG4gIH1cbiAgaWYgKCFwZW5kaW5nKSByZXR1cm4gbnVsbDtcblxuICAvLyDimqAgVGhlIEZJUlNUIG9mIHRoZSB1bmFuc3dlcmVkIHJ1biwgbm90IHRoZSBsYXN0LiBTb21lb25lIHdobyBzZW5kcyB0aHJlZVxuICAvLyBtZXNzYWdlcyB3aGlsZSB3YWl0aW5nIGhhcyBiZWVuIHdhaXRpbmcgc2luY2UgdGhlIGZpcnN0IG9uZSwgYW5kIHJlc2V0dGluZ1xuICAvLyB0aGUgY2xvY2sgb24gZXZlcnkgZm9sbG93LXVwIHdvdWxkIG1lYW4gdGhlIG1vcmUgYW54aW91cyB0aGV5IGdldCwgdGhlXG4gIC8vIGxvbmdlciB3ZSBjbGFpbSB0aGV5IGhhdmUgYmVlbiB3YWl0aW5nIGlzIHplcm8uXG4gIGxldCBzaW5jZSA9IHBlbmRpbmcudHM7XG4gIGxldCBtZXNzYWdlSWQgPSBwZW5kaW5nLmlkO1xuICBmb3IgKGxldCBpID0gY2hhdC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IG0gPSBjaGF0W2ldO1xuICAgIGlmICghbSB8fCBtLndobyA9PT0gXCJzeXN0ZW1cIikgY29udGludWU7XG4gICAgaWYgKG0ud2hvICE9PSBcImh1bWFuXCIpIGJyZWFrO1xuICAgIHNpbmNlID0gbS50cztcbiAgICBtZXNzYWdlSWQgPSBtLmlkO1xuICB9XG5cbiAgcmV0dXJuIHsgbWVzc2FnZUlkLCBzaW5jZSwgYmFkZ2U6IGJhZGdlRm9yKHNpbmNlLCBub3csIG9wdHMpIH07XG59XG5cbi8qKlxuICogUHVsc2Ugb3Igc3RhbGxlZCwgZm9yIGFueXRoaW5nIG93ZWQgYW4gYW5zd2VyIHNpbmNlIGBzaW5jZWAuIE9ORSBwbGFjZSwgc28gYVxuICogbm90ZSBhbmQgYSBtZXNzYWdlIHdhaXRpbmcgZXF1YWxseSBsb25nIGNhbiBuZXZlciByZWFkIGRpZmZlcmVudGx5LlxuICovXG5mdW5jdGlvbiBiYWRnZUZvcihcbiAgc2luY2U6IG51bWJlcixcbiAgbm93OiBudW1iZXIsXG4gIG9wdHM6IHsgc3RhbGxNcz86IG51bWJlcjsgYWNrbm93bGVkZ2VkVW50aWw/OiBudW1iZXIgfSxcbik6IFdhaXRpbmdbXCJiYWRnZVwiXSB7XG4gIGNvbnN0IHN0YWxsTXMgPSBvcHRzLnN0YWxsTXMgPz8gU1RBTExfTVM7XG4gIGNvbnN0IGFja25vd2xlZGdlZCA9IG9wdHMuYWNrbm93bGVkZ2VkVW50aWwgIT09IHVuZGVmaW5lZCAmJiBub3cgPCBvcHRzLmFja25vd2xlZGdlZFVudGlsO1xuICByZXR1cm4gbm93IC0gc2luY2UgPj0gc3RhbGxNcyAmJiAhYWNrbm93bGVkZ2VkID8gXCJzdGFsbGVkXCIgOiBcIndvcmtpbmdcIjtcbn1cblxuLy8g4pSA4pSAIEU2NTogdGhlIHNhbWUgcXVlc3Rpb24sIGFza2VkIG9mIGEgbm90ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBBZ2VudHMgYWN0IG9uIG5lYXJseSBldmVyeSBub3RlLCBhbmQgQ29sZSBydWxlZCB0aGF0IHRoZSByaWdodCBpbnN0aW5jdDsgd2hhdFxuLy8gd2FzIG1pc3Npbmcgd2FzIGFueSBzaWduLCBiZXR3ZWVuIGFkZGluZyBhIG5vdGUgYW5kIHRoZSBhZ2VudCdzIGFuc3dlciwgdGhhdFxuLy8gc29tZXRoaW5nIHdhcyBoYXBwZW5pbmcuIFNvIGEgbm90ZSBnZXRzIEU1MydzIHRyZWF0bWVudCBXSE9MRTogZGVyaXZlZCwgbmV2ZXJcbi8vIGRlY2xhcmVkOyBhIHB1bHNlLCB0aGVuIGEgc3RhdGljIFwibWF5IGJlIHN0dWNrXCIgYXQgdGhlIHNhbWUgMzAgczsgdGhlIHNhbWVcbi8vIHNub296ZS4gTm90aGluZyBoZXJlIGFza3MgdGhlIGFnZW50IGZvciBhbnl0aGluZyBuZXcuXG4vL1xuLy8g4puUIFdIQVQgQU5TV0VSUyBBIE5PVEUg4oCUIHRoZSBydWxlLCBhbmQgZWFjaCBwYXJ0IGlzIGEgZmFjdCB0aGUgZGFlbW9uIGFscmVhZHlcbi8vIGhvbGRzOlxuLy8gICDCtyBSRVNPTFZFRC4gUmVzb2x2aW5nIGlzIHRoZSBhY3QgdGhhdCBjbG9zZXMgYSBub3RlIChDb2xlKSwgYnkgZWl0aGVyIHBhcnR5LFxuLy8gICAgIHNvIGEgcmVzb2x2ZWQgbm90ZSBpcyBvd2VkIG5vdGhpbmcuIEl0IGlzIHRoZSBub3RlJ3Mgb3duIHN0b3JlZCBzdGF0ZSxcbi8vICAgICBub3QgYSBjb3B5IG9mIGl0LlxuLy8gICDCtyBBTiBBR0VOVCBNRVNTQUdFIEFGVEVSIElULiBUaGUgYWdlbnQgc3Bva2UgdG8gdGhlIGh1bWFuIGFmdGVyIHRoZSBub3RlXG4vLyAgICAgd2FzIHdyaXR0ZW4sIHdoaWNoIGlzIHdoYXQgdGhlIGh1bWFuIGlzIHdhaXRpbmcgZm9yIOKAlCB0aGUgc2FtZSByZWFzb25cbi8vICAgICBvbmUgcmVwbHkgYW5zd2VycyBFNTMncyBydW4gb2YgbWVzc2FnZXMuIEl0IGNsYWltcyBcInRoZSBhZ2VudCBoYXMgc2FpZFxuLy8gICAgIHNvbWV0aGluZyBzaW5jZVwiLCBuZXZlciBcInRoZSBhZ2VudCBkZWFsdCB3aXRoIHRoaXNcIiwgc28gaXQgY2xlYXJzIHRoZVxuLy8gICAgIHBlbmRpbmcgbWFyayBhbmQgbGVhdmVzIHRoZSBub3RlIE9QRU46IGRlYWx0IHdpdGggaXMgYHJlc29sdmVkYC5cbi8vICAgICBDb3VudGluZyBvbmx5IGByZXNvbHZlZGAgd2FzIHRoZSBvcHRpb24gbm90IHRha2VuIOKAlCBhbiBhZ2VudCB2aXNpYmx5XG4vLyAgICAgd29ya2luZyBvbiBhIG5vdGUgd291bGQgZmxpcCBpdCB0byBcIm1heSBiZSBzdHVja1wiIHdoZW5ldmVyIGl0IGZvcmdvdCB0b1xuLy8gICAgIHJlc29sdmUsIGFuZCBFNTMncyB3aG9sZSBwcmVtaXNlIGlzIHRoYXQgaXQgZm9yZ2V0cy5cbi8vICAgwrcgVEhFIEFHRU5UIFJFV1JJVElORyBUSElTIE5PVEUuIEFuIGFjdCBvbiB0aGlzIG5vdGUsIHNlZW4gb24gdGhpcyBub3RlLlxuLy8g4pqgIEFORCBBIFNZU1RFTSBMSU5FIElTIFNUSUxMIE5PVCBBIFJFUExZLiBUaGUgYWdlbnQgcmVzb2x2aW5nIG5vdGUgQSBpc1xuLy8gbmFycmF0ZWQgYXMgYSBzeXN0ZW0gbGluZTsgaXQgYW5zd2VycyBBIChBIGlzIHJlc29sdmVkKSBhbmQgc2F5cyBub3RoaW5nXG4vLyBhYm91dCBCLlxuXG4vKiogV2hhdCB0aGUgcnVsZSByZWFkcyBvZmYgYSBub3RlIOKAlCB0aGUgc3RvcmVkIGZpZWxkcywgbm90aGluZyBwbGFjZWQuICovXG50eXBlIE5vdGVGYWN0cyA9IFBpY2s8Tm90ZSwgXCJpZFwiIHwgXCJ3aG9cIiB8IFwiY3JlYXRlZEF0XCIgfCBcImVkaXRlZEF0XCIgfCBcImVkaXRlZEJ5XCIgfCBcInJlc29sdmVkXCI+O1xuXG4vKipcbiAqIFdoZW4gdGhlIGh1bWFuIGxhc3Qgd3JvdGUgaW50byB0aGlzIG5vdGUsIG9yIG51bGwgaWYgdGhleSBuZXZlciBkaWQuIEFuIGVkaXRcbiAqIHdob3NlIGF1dGhvciB3YXMgbm90IHJlY29yZGVkIChiZWZvcmUgRTY1KSBpcyBub3QgZXZpZGVuY2UgZWl0aGVyIHdheSwgc28gdGhlXG4gKiBub3RlIGNvdW50cyBmcm9tIHdoZW4gaXQgd2FzIG1hZGUuXG4gKi9cbmZ1bmN0aW9uIGh1bWFuV3JvdGVBdChuOiBOb3RlRmFjdHMpOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKG4uZWRpdGVkQXQgIT09IHVuZGVmaW5lZCAmJiBuLmVkaXRlZEJ5ID09PSBcImh1bWFuXCIpIHJldHVybiBuLmVkaXRlZEF0O1xuICBpZiAobi5lZGl0ZWRBdCAhPT0gdW5kZWZpbmVkICYmIG4uZWRpdGVkQnkgPT09IFwiYWdlbnRcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuLndobyA9PT0gXCJodW1hblwiID8gbi5jcmVhdGVkQXQgOiBudWxsO1xufVxuXG4vKiogRXZlcnkgbm90ZSBvd2VkIGFuIGFuc3dlciwgb2xkZXN0IGZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vdGVzV2FpdGluZyhcbiAgZG9jczogcmVhZG9ubHkgeyBzbHVnOiBzdHJpbmc7IG5vdGVzOiByZWFkb25seSBOb3RlRmFjdHNbXSB9W10sXG4gIGNoYXQ6IHJlYWRvbmx5IE1zZ1tdLFxuICBub3c6IG51bWJlcixcbiAgb3B0czogeyBzdGFsbE1zPzogbnVtYmVyOyBhY2tub3dsZWRnZWRVbnRpbD86IG51bWJlciB9ID0ge30sXG4pOiBOb3RlV2FpdGluZ1tdIHtcbiAgbGV0IGxhc3RBZ2VudCA9IE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgZm9yIChjb25zdCBtIG9mIGNoYXQpIGlmIChtLndobyA9PT0gXCJhZ2VudFwiICYmIG0udHMgPiBsYXN0QWdlbnQpIGxhc3RBZ2VudCA9IG0udHM7XG4gIGNvbnN0IG91dDogTm90ZVdhaXRpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGQgb2YgZG9jcylcbiAgICBmb3IgKGNvbnN0IG4gb2YgZC5ub3Rlcykge1xuICAgICAgaWYgKG4ucmVzb2x2ZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc2luY2UgPSBodW1hbldyb3RlQXQobik7XG4gICAgICAvLyDimqAgU1RSSUNUTFkgYWZ0ZXI6IGEgcmVwbHkgaW4gdGhlIHNhbWUgbWlsbGlzZWNvbmQgY2Fubm90IGhhdmUgcmVhZCBpdC5cbiAgICAgIGlmIChzaW5jZSA9PT0gbnVsbCB8fCBsYXN0QWdlbnQgPiBzaW5jZSkgY29udGludWU7XG4gICAgICBvdXQucHVzaCh7IGRvYzogZC5zbHVnLCBub3RlSWQ6IG4uaWQsIHNpbmNlLCBiYWRnZTogYmFkZ2VGb3Ioc2luY2UsIG5vdywgb3B0cykgfSk7XG4gICAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IGEuc2luY2UgLSBiLnNpbmNlKTtcbn1cblxuLyoqXG4gKiBIb3cgbXVjaCBvZiBhIG5vdGUgYG5vdGUuYWRkZWRgIGNhcnJpZXM6IHRoZSBxdW90ZSBhbmQgdGhlIGJvZHkgdG9nZXRoZXIsIGluXG4gKiBjaGFyYWN0ZXJzLiBBIHBhcmFncmFwaCdzIHdvcnRoLiBOb3RlcyBhcmUgbWFkZSBtaWQtcmVhZCwgb24gYSBwaHJhc2Ugb3IgYVxuICogc2VudGVuY2UsIGFuZCB0aG9zZSB0cmF2ZWwgd2hvbGUgc28gdGhlIGFnZW50IGNhbiBhY3Qgd2l0aG91dCBhIHJvdW5kIHRyaXAuXG4gKiBBIG5vdGUgb3ZlciBhIHdob2xlIHNlY3Rpb24gaXMgd2hlcmUgdGhlIHJvdW5kIHRyaXAgcGF5czogYG5vdGVzYCBhbHNvIHNheXNcbiAqIHdoZXRoZXIgdGhlIHBhc3NhZ2Ugc3RpbGwgc3RhbmRzIGFuZCB3aGVyZSBpdCBpcyBub3cuIFRoZSBvbmUgd2hvIGFjdHMgb25cbiAqIHRoaXMgbnVtYmVyIGlzIHRoZSBhZ2VudCByZWFkaW5nIGl0cyB0YWlsLlxuICovXG5leHBvcnQgY29uc3QgTk9URV9URVhUX01BWCA9IDEwMDA7XG5cbi8qKlxuICogV2hhdCBgbm90ZS5hZGRlZGAgKGFuZCBhIGh1bWFuJ3MgYG5vdGUuZWRpdGVkYCkgdGVsbHMgdGhlIGFnZW50IGJleW9uZCB0aGUgaWRzXG4gKiAoRTY1KS4gVGhlIGV2ZW50IG5hbWVzIGl0cyBuZXh0IGFjdCwgYmVjYXVzZSBhbiBhZ2VudCB0aGF0IG11c3QgZ28gYW5kIGFza1xuICogd2hhdCBhcnJpdmVkIGlzIGFuIGFnZW50IG9uZSBzdGVwIGZ1cnRoZXIgZnJvbSBkb2luZyBpdC5cbiAqXG4gKiDim5QgV0hPTEUgT1IgTk9UIEFUIEFMTCwgbmV2ZXIgdHJ1bmNhdGVkLiBBIGNsaXBwZWQgcXVvdGUgcmVhZHMgYXMgdGhlIHdob2xlXG4gKiBwYXNzYWdlLCB3aGljaCBpcyB3b3JzZSB0aGFuIG5vIHF1b3RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm90ZUV2ZW50RmFjdHMoXG4gIHNsdWc6IHN0cmluZyxcbiAgbm90ZTogeyBpZDogc3RyaW5nOyBxdW90ZTogc3RyaW5nOyBib2R5OiBzdHJpbmcgfSxcbiAgbGluZXM6IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH0gfCBudWxsLFxuKTogeyBsaW5lcz86IHsgZnJvbTogbnVtYmVyOyB0bzogbnVtYmVyIH07IHF1b3RlPzogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBoaW50OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGNsb3NlID0gYG5vdGUtcmVzb2x2ZSAke25vdGUuaWR9IC0tZG9jICR7c2x1Z31gO1xuICBjb25zdCBhdCA9IGxpbmVzID8geyBsaW5lcyB9IDoge307XG4gIGlmIChub3RlLnF1b3RlLmxlbmd0aCArIG5vdGUuYm9keS5sZW5ndGggPD0gTk9URV9URVhUX01BWClcbiAgICByZXR1cm4ge1xuICAgICAgLi4uYXQsXG4gICAgICBxdW90ZTogbm90ZS5xdW90ZSxcbiAgICAgIGJvZHk6IG5vdGUuYm9keSxcbiAgICAgIGhpbnQ6IGBhY3Qgb24gaXQsIHRoZW4gXFxgJHtjbG9zZX1cXGAgd2hlbiBpdCBpcyBkZWFsdCB3aXRoYCxcbiAgICB9O1xuICByZXR1cm4ge1xuICAgIC4uLmF0LFxuICAgIGhpbnQ6IGB0b28gbG9uZyB0byBjYXJyeSDigJQgcmVhZCBpdCB3aXRoIFxcYG5vdGVzIC0tZG9jICR7c2x1Z31cXGAsIGFjdCBvbiBpdCwgdGhlbiBcXGAke2Nsb3NlfVxcYGAsXG4gIH07XG59XG5cbi8qKiBXaGF0IHRoZSBjb252ZXJzYXRpb24gc2hvd3MsIHBlciBiYWRnZS4gbWluZC1tYXBwZXIncyB3b3JkcywgbmVhciBlbm91Z2guICovXG5leHBvcnQgY29uc3QgV0FJVElOR19MQUJFTDogUmVjb3JkPFdhaXRpbmdbXCJiYWRnZVwiXSwgc3RyaW5nPiA9IHtcbiAgd29ya2luZzogXCJ3b3JraW5nIG9uIHRoaXPigKZcIixcbiAgc3RhbGxlZDogXCJ0b29rIHRoaXMgaW4sIHRoZW4gd2VudCBxdWlldCDigJQgbWF5IGJlIHN0dWNrXCIsXG59O1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXFEQSx1QkFBUyw2QkFBNEIsMkJBQWMseUJBQVU7QUFDN0Qsb0JBQVM7QUFDVCxxQkFBUyxzQkFBVSx3QkFBUyxxQkFBWSxrQkFBTTtBQUM5QztBQUNBLHNCQUFTOzs7QUMzQ1Q7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFBZSxDQUM3QixNQUNBLFVBQ0EsV0FBMkMsQ0FBQyxRQUFRLElBQUksS0FBSyxHQUNwRDtBQUFBLEVBQ1QsSUFBSTtBQUFBLElBQ0YsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLE1BQUcsT0FBTztBQUFBLElBQzlCLElBQUksU0FBUyxhQUFhLE1BQU0sTUFBTSxDQUFDLE1BQU07QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5RCxXQUFXLElBQUk7QUFBQSxJQUNmLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFB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b0IsRUFBRSxRQUFRLE1BQU0sRUFBRSxNQUFNLFlBQVksRUFBRSxXQUFXLE1BQU0sRUFBRSxNQUFNLEtBQUssRUFBRSxJQUFJLENBQUM7QUFBQSxDQUMxSDtBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sRUFBRTtBQUFBLEVBQ3BCLE1BQU0sRUFBRTtBQUFBLEVBRVIsSUFBSSxJQUFJLFNBQVMsS0FBSyxNQUFNLEtBQUs7QUFBQSxJQUMvQixJQUFJO0FBQUEsTUFDRixJQUFJLFVBQVMsTUFBTSxHQUFHLEVBQUUsU0FBUztBQUFBLFFBQUcsWUFBVyxNQUFNLEdBQUc7QUFBQSxNQUN4RCxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsT0FBTyxJQUFJO0FBQUE7QUFRYixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICIxOEE0MzNFMkNDOUExMjQ4NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
