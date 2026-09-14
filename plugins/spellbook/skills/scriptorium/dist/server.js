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

//# debugId=8C2D9996ECFA0B6B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2FuY2hvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvZGlmZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9kb2N0b3IudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGlzdG9yeS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9waWNrZXIudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2Vzc2lvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9mcm9udG1hdHRlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9saW5rcy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3NlYXJjaC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC93YWl0aW5nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBwZXItc2Vzc2lvbiBkYWVtb24g4oCUIHRoZSBwcm9jZXNzIHRoZSBzdXJmYWNlIHRhbGtzIHRvIG92ZXIgYVxuICogV2ViU29ja2V0IGFuZCB0aGUgQ0xJIHRhbGtzIHRvIG92ZXIgSFRUUC4gTGF1bmNoZWQgYnlcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvc2NyaXB0b3JpdW0vc2NyaXB0cy9zZXJ2ZXIudHNgICh0aGUgbGF1bmNoZXIpLCB3aGljaFxuICogaW1wb3J0cyB0aGUgQlVJTFQgYGRpc3Qvc2VydmVyLmpzYC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogYFNLSUxMX1JPT1RgL2BESVNUX0RJUmAgb25seSwgZm9yIHRoZSBraXQncyBgcmVzb2x2ZU1vZGVgIGFuZFxuICogICAgYHNlcnZlRnJvbURpc3RgLCBhbmQgdHJ1ZSBhdCB0aGUgRU1JVFRFRCBhZGRyZXNzIChgZGlzdC9zZXJ2ZXIuanNgLCB3aG9zZVxuICogICAgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyKS4gTm90aGluZyBlbHNlIGlzIHBpbm5lZCBvZmYgYGltcG9ydC5tZXRhYC5cbiAqIDIuIFNlcnZlczogWUVTLiBgL2AgaXMgdGhlIGJ1aWx0IGBpbmRleC5odG1sYCB2aWEgYHNlcnZlRnJvbURpc3RgLCBub1xuICogICAgc3Vic3RpdHV0aW9uOyB0aGUgb25seSByb3V0ZXMgb2YgaXRzIG93biBhcmUgYC9zdGF0ZWAsIGAvY21kYCwgYC9ldmVudHNgLFxuICogICAgYC93c2AgYW5kIGAvZnMvKmAgKHJlYWQtb25seTogYSB2ZXJzaW9uJ3MgdGV4dCwgYSBkaXJlY3RvcnkgbGlzdGluZykuXG4gKiAzLiBTZWNvbmQgaGFsZjogWUVTIOKAlCBgY2xpLnRzYDsgdGhlIHR3byBzaGFyZSBgLi9oZWFydGJlYXQudHNgLlxuICogNC4gTGlmZWN5Y2xlOiBsb25nLXJ1bm5pbmcsIG9uZSBkYWVtb24gcGVyIHNlc3Npb24sIGlkbGUtdGltZW91dCBsaWtlXG4gKiAgICBnbGFtb3VyIChsaW5nZXIgYWZ0ZXIgdGhlIGxhc3Qgc3Vic2NyaWJlciBsZWF2ZXM7IGV4aXQgMTI0KS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDigJQgYG1haW5gIGF3YWl0cyB0aGVcbiAqICAgIHNlc3Npb24ncyBlbmQgYW5kIGl0cyBvd24gZHJhaW4sIGV4YWN0bHkgYXMgZ2xhbW91cidzIHNlcnZlciBkb2VzLCBzbyB0aGVcbiAqICAgIGxhdW5jaGVyIGlzIFRFUk1JTkFMLUVYSVQgKGBwcm9jZXNzLmV4aXQoYXdhaXQgcnVuKCkpYCk6IG9uY2UgYG1haW5gXG4gKiAgICByZXNvbHZlcyBub3RoaW5nIG1heSBrZWVwIHRoZSBwcm9jZXNzIGFsaXZlLCBhbmQgYSB3YXRjaGVyIGhhbmRsZSBvciBhXG4gKiAgICBzdHJhZ2dsaW5nIHNvY2tldCB3b3VsZC4gRHJpdmVuLCBub3QgcmVhZCAoc2VlIHRoZSBzbGljZS1BIGpvdXJuYWwpLlxuICogNi4gRXZlbnQgaWRzIHJlY292ZXJlZCBhY3Jvc3MgcmVzdGFydD8gTk8g4oCUIHRoZSBsb2cgaXMgaW4gbWVtb3J5IGFuZCBpZHNcbiAqICAgIHJlc3RhcnQgYXQgMSwgZXZlbiB1bmRlciBgLS1yZXN0b3JlYCAod2hpY2ggcmVzdG9yZXMgdGhlIE1BTklGRVNULCBub3QgdGhlXG4gKiAgICBsb2cpLiBTbyB0aGUgbG9nIGlzIHN0YW1wZWQgd2l0aCBhIHBlci1ib290IEVQT0NIIChtaW5kLW1hcHBlcidzIHNoYXBlKVxuICogICAgYW5kIHRoZSB0YWlsIHJlc2V0cyBpdHMgY3Vyc29yIHdoZW4gdGhlIGVwb2NoIGNoYW5nZXMuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBObyDigJQgdGhlIHNoYXBlIHdhcyBjaG9zZW4gdG8gYmUgdGhlXG4gKiAgICBraXQncy5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBOTzogc2NyaXB0b3JpdW1cbiAqICAgIGlzIHRoZSBmaXJzdCBzcGVsbCBzY2FmZm9sZGVkIGFmdGVyIHRoZSBjb252ZXJnZW5jZS5cbiAqXG4gKiDilIDilIAgS0lUIFZFUkRJQ1RTIChwbGF5Ym9vayBONCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZXJyb3JzIFNVQkpFQ1QgKHRoZSBDTEk7IHRoZSBkYWVtb24gYW5zd2VycyBIVFRQIHN0YXR1c2VzIHRoZSBDTEkgbWFwcykgwrdcbiAqIHNlcnZlRGlzdCBTVUJKRUNUIChgcmVzb2x2ZU1vZGVgLCBgc2VydmVGcm9tRGlzdGApIMK3IGhvdXNla2VlcGluZyBTVUJKRUNULCBhbGxcbiAqIHRocmVlIGV4cG9ydHMgKGBzaG91bGRJZGxlQ2xvc2VgIHZpYSBgc3RhcnRIb3VzZWtlZXBpbmdgJ3MgaWRsZS1jbG9zZSwgdGhlXG4gKiBzbmFwc2hvdCBzd2VlcCDigJQgaGVyZSB0aGUgbWFuaWZlc3QgaXMgd3JpdHRlbiBvbiBldmVyeSBjaGFuZ2UgaW5zdGVhZCwgc28gdGhlXG4gKiBzd2VlcCdzIHNuYXBzaG90IGhvb2sgaXMgZGVsaWJlcmF0ZWx5IE5PVCBwYXNzZWQg4oCUIGFuZCBgZHJhaW5BbmRTdG9wYCkgwrdcbiAqIHRhaWxFdmVudHMgU1VCSkVDVCAodGhlIENMSSdzIGB0YWlsYCkgwrcgaGVhcnRiZWF0IFNVQkpFQ1QgKGAuL2hlYXJ0YmVhdC50c2ApIMK3XG4gKiBkaXNjb3ZlcnkgU1VCSkVDVCAoc2Vzc2lvbi1KU09OLCBFMTM6IGBzY3JpcHRvcml1bS08aWQ+Lmpzb25gICtcbiAqIGBzY3JpcHRvcml1bS1sYXRlc3QuanNvbmAgaW4gdG1wZGlyIHZpYSBgd3JpdGVGaWxlQXRvbWljYC9gdW5saW5rSWZNYXRjaGVzYCkgwrdcbiAqIGV2ZW50TG9nIFNVQkpFQ1QsIFdJVEggRVBPQ0ggKFE2KSDCtyBzc2UgU1VCSkVDVCAoYEdFVCAvZXZlbnRzYCkgwrdcbiAqIGxpYi9wcmludEpzb24gU1VCSkVDVCAodGhlIENMSSBzcGVha3MgdGhlIGFnZW50IHdpcmUpLlxuICpcbiAqIOKUgOKUgCBURUFSRE9XTiBPUkRFUiAocmVnaXN0ZXIgQTYpLCBTVEFURUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogZ2xhbW91cidzIG9yZGVyOiBzdG9wIGhvdXNla2VlcGluZyDihpIgY2xvc2UgdGhlIHdhdGNoZXJzIOKGkiBwZXJzaXN0IHRoZVxuICogbWFuaWZlc3Qg4oaSIHVubGluayBkaXNjb3Zlcnkg4oaSIGVtaXQgYGNsb3NlZGAg4oaSIGRyYWluLiBEaXNjb3ZlcnkgZ29lcyBCRUZPUkUgdGhlXG4gKiBgY2xvc2VkYCBmcmFtZSBzbyBhIHRhaWwgdGhhdCBzZWVzIGBjbG9zZWRgIGFuZCBhIENMSSB2ZXJiIHRoYXQgcnVucyByaWdodFxuICogYWZ0ZXIgaXQgYm90aCBmaW5kIG5vIHBvaW50ZXIgdG8gYSBkYWVtb24gdGhhdCBpcyBsZWF2aW5nOyB0aGUgb3RoZXIgb3JkZXJcbiAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhIHZlcmIgcmVzb2x2ZXMgYSBzZXNzaW9uIHRoYXQgd2lsbCByZWZ1c2UgaXQuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgdHlwZSBGU1dhdGNoZXIsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMsIHVubGlua1N5bmMsIHdhdGNoIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgdW5saW5rSWZNYXRjaGVzLCB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudExvZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ldmVudExvZy50c1wiO1xuaW1wb3J0IHsgZHJhaW5BbmRTdG9wLCBzdGFydEhvdXNla2VlcGluZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlIGFzIHJlc29sdmVNb2RlSW4sIHNlcnZlRnJvbURpc3QgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc2VydmVEaXN0LnRzXCI7XG5pbXBvcnQgeyB0eXBlIFNzZUNsaWVudHMsIHNzZVJlc3BvbnNlIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NzZS50c1wiO1xuaW1wb3J0IHsgcXVvdGVMYWJlbCB9IGZyb20gXCIuL2FuY2hvcnNcIjtcbmltcG9ydCB7IHVuaWZpZWQgfSBmcm9tIFwiLi9kaWZmXCI7XG5pbXBvcnQgeyBzdW1tYXJ5IH0gZnJvbSBcIi4vZG9jdG9yXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyB0eXBlIEFjdCwgdHlwZSBBZnRlciwgdHlwZSBCZWZvcmUsIEhpc3RvcnksIHR5cGUgSW52ZXJzZSwgcGxhbkludmVyc2UgfSBmcm9tIFwiLi9oaXN0b3J5XCI7XG5pbXBvcnQgeyB0eXBlIFBpY2tLaW5kLCBwYXJzZVBpY2tlck91dHB1dCwgcGlja2VyQ29tbWFuZCwgd2FzQ2FuY2VsbGVkIH0gZnJvbSBcIi4vcGlja2VyXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEFnZW50Q21kLFxuICBDbGllbnRNc2csXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFNlcnZlck1zZyxcbiAgU3RydWN0dXJlT3AsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yLCBzaWRlTmFtZSB9IGZyb20gXCIuL3Nlc3Npb25cIjtcbmltcG9ydCB7IGxpc3REaXIsIFBhdGhFcnJvciB9IGZyb20gXCIuL3RyZWVcIjtcbmltcG9ydCB7IERFRkFVTFRfU05PT1pFX01TLCB3YWl0aW5nT24gfSBmcm9tIFwiLi93YWl0aW5nXCI7XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcblxuLyoqIHJlbGVhc2UgaWZmIGBkaXN0L2luZGV4Lmh0bWxgIGV4aXN0cyBhdCB0aGUgc2tpbGwgcm9vdDsgdGhlIGVudiB2YXIgb3ZlcnJpZGVzIChDb250cmFjdCAxKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZSgpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICByZXR1cm4gcmVzb2x2ZU1vZGVJbihESVNUX0RJUik7XG59XG5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG4vKiogYCRTQ1JJUFRPUklVTV9IT01FYCwgZGVmYXVsdCBgfi8uc2NyaXB0b3JpdW1gLiBgcHJvbXB0cy5qc29uYCBiZXNpZGUgYHNlc3Npb25zL2AgaXMgc2xpY2UgQidzIChFOSkuICovXG5leHBvcnQgZnVuY3Rpb24gc2NyaXB0b3JpdW1Ib21lKCk6IHN0cmluZyB7XG4gIHJldHVybiByZXNvbHZlKHByb2Nlc3MuZW52LlNDUklQVE9SSVVNX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLnNjcmlwdG9yaXVtXCIpKTtcbn1cblxuZXhwb3J0IHR5cGUgU3RhcnRPcHRzID0ge1xuICBwb3J0PzogbnVtYmVyO1xuICByZXN0b3JlPzogc3RyaW5nO1xuICB0aW1lb3V0Uz86IG51bWJlcjtcbiAgLyoqIEUyMzogYSBORVcgc2Vzc2lvbidzIHdvcmtzcGFjZSDigJQgdGhlIGRpcmVjdG9yeSBgb3BlbmAgcmFuIGluLiBBIHJlc3RvcmUga2VlcHMgaXRzIG93bi4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIEEgdGFpbCBmcmFtZSdzIHBheWxvYWQuIFRoZSBsb2cgc3RhbXBzIGBpZGAgYW5kIGBlcG9jaGAuICovXG50eXBlIExvZ0V2ZW50ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHR5cGU6IHN0cmluZyB9O1xuXG4vKiogSG93IGxvbmcgYSBidXJzdCBvZiB3YXRjaGVyIGV2ZW50cyBvbiBvbmUgcGF0aCBzZXR0bGVzIGJlZm9yZSBpdCBpcyByZWFkLiAqL1xuY29uc3QgV0FUQ0hfU0VUVExFX01TID0gNjA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydERhZW1vbihvcHRzOiBTdGFydE9wdHMpIHtcbiAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAvLyBNb2RlIEJFRk9SRSBhbnkgd3JpdGU6IGEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3RcbiAgLy8gZGllIGF0IHRoZSBpbXBvcnQgaGF2aW5nIGNyZWF0ZWQgbm90aGluZyAoZ2xhbW91cidzIG1lYXN1cmVkIG9yZGVyKS5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IG9wdHMucmVzdG9yZVxuICAgID8gU2Vzc2lvbi5yZXN0b3JlKGhvbWUsIG9wdHMucmVzdG9yZSlcbiAgICA6IFNlc3Npb24uY3JlYXRlKGhvbWUsIHVuZGVmaW5lZCwgb3B0cy53b3Jrc3BhY2UpO1xuICBjb25zdCBzZXNzaW9uSWQgPSBzZXNzaW9uLmlkO1xuICBsZXQgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsID0gbnVsbDtcblxuICAvLyAtLS0gcHJlZnM6IHBlci12aWV3ZXIgY29udmVuaWVuY2VzIHRoYXQgb3V0bGl2ZSBhIHNlc3Npb24ncyBwb3J0IC0tLS0tLS0tLS0tLVxuICAvLyBCcm93c2VyIHN0b3JhZ2UgaXMga2V5ZWQgYnkgb3JpZ2luLCBwb3J0IGluY2x1ZGVkLCBhbmQgZXZlcnkgc2Vzc2lvbiBnZXRzIGFcbiAgLy8gbmV3IHBvcnQg4oCUIHNvIGEgcGFuZSBzaXplIGtlcHQgaW4gbG9jYWxTdG9yYWdlIHJlc2V0cyBhdCB0aGUgbmV4dCBgb3BlbmAuXG4gIC8vIFRoZXkgbGl2ZSBpbiB0aGUgaG9tZSBpbnN0ZWFkLCBzaGFyZWQgYnkgZXZlcnkgc2Vzc2lvbiBvZiB0aGlzIGhvbWUuXG4gIGNvbnN0IHByZWZzRmlsZSA9IGpvaW4oaG9tZSwgXCJwcmVmcy5qc29uXCIpO1xuICBjb25zdCBQUkVGX0tFWSA9IC9eW2Etel1bYS16MC05Oi5fLV17MCw2M30kLztcbiAgY29uc3QgUFJFRl9WQUxVRV9NQVggPSA0MDk2O1xuICBjb25zdCBQUkVGX0tFWVNfTUFYID0gNjQ7XG4gIC8qKlxuICAgKiBSZWFkIHRoZSBob21lJ3MgcHJlZnMgRlJFU0guIFNldmVyYWwgc2Vzc2lvbnMgY2FuIHNoYXJlIG9uZSBob21lIChFMTMpLCBlYWNoXG4gICAqIGl0cyBvd24gZGFlbW9uLCBzbyBhIGNvcHkgbG9hZGVkIG9uY2UgYXQgYm9vdCBhbmQgd3JpdHRlbiBiYWNrIHdob2xlIHdvdWxkXG4gICAqIGVyYXNlIGEga2V5IGFub3RoZXIgc2Vzc2lvbiB3cm90ZSBzaW5jZSAodmVyaWZ5IHBhc3MpLiBFdmVyeSB3cml0ZSBpc1xuICAgKiB0aGVyZWZvcmUgcmVhZCDihpIgc2V0IG9uZSBrZXkg4oaSIHdyaXRlLCBhbmQgZXZlcnkgc25hcHNob3QgcmVhZHMgdGhlIGZpbGUuXG4gICAqIE9ubHkgd2VsbC1mb3JtZWQgZW50cmllcyBzdXJ2aXZlIGEgcmVhZDsgYSBiYWQgZmlsZSByZWFkcyBhcyBlbXB0eSBhbmQgaXNcbiAgICogcmVwbGFjZWQgYnkgdGhlIG5leHQgd3JpdGUuXG4gICAqL1xuICBjb25zdCByZWFkUHJlZnMgPSAoKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9PiB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByZWZzRmlsZSwgXCJ1dGY4XCIpKSBhcyB1bmtub3duO1xuICAgICAgaWYgKHJhdyAmJiB0eXBlb2YgcmF3ID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocmF3KSlcbiAgICAgICAgICBpZiAoUFJFRl9LRVkudGVzdChrKSAmJiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2Lmxlbmd0aCA8PSBQUkVGX1ZBTFVFX01BWCkgb3V0W2tdID0gdjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIHByZWZzIHlldCwgb3IgdW5yZWFkYWJsZSDigJQgZW1wdHkgKi9cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfTtcbiAgY29uc3QgdXNlckhvbWUgPSBob21lZGlyKCk7XG4gIC8qKlxuICAgKiBFNTM6IHRoZSBzbm9vemUgdGhlIGFnZW50IGFza2VkIGZvciwgYW5kIHRoZSBtZXNzYWdlcyBhbHJlYWR5IG51ZGdlZC5cbiAgICpcbiAgICog4puUIE9ORSBOVURHRSBQRVIgTUVTU0FHRSwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIEFOVEktTkFHIFJVTEUuIENvbGU6IFwid2VcbiAgICogZG9uJ3Qgd2FudCB0byBoYXZlIGEgc2l0dWF0aW9uIHdoZXJlIGFuIGFnZW50IGtlZXBzIGdldHRpbmcgcGluZ2VkIGFib3V0XG4gICAqIHNvbWV0aGluZyBhbmQgaXQncyBsaWtlLCBubywgSSdtIGFjdHVhbGx5IHdvcmtpbmcuXCIgU28gYSBtZXNzYWdlIGlkIGVudGVyc1xuICAgKiBgbnVkZ2VkYCB0aGUgZmlyc3QgdGltZSBpdCBpcyByZXBvcnRlZCDigJQgb3IgdGhlIG1vbWVudCB0aGUgYWdlbnQgc25vb3plcyBpdFxuICAgKiDigJQgYW5kIG5ldmVyIGxlYXZlcy4gQSBzbm9vemUgRVhQSVJJTkcgdGhlcmVmb3JlIGNoYW5nZXMgd2hhdCB0aGUgSFVNQU5cbiAgICogc2VlcyAoYmFjayB0byBcIm1heSBiZSBzdHVja1wiLCBiZWNhdXNlIHRoZXkgYXJlIG93ZWQgdGhlIHRydXRoKSB3aXRob3V0XG4gICAqIHBpbmdpbmcgdGhlIGFnZW50IGFnYWluLlxuICAgKlxuICAgKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBkZWxpYmVyYXRlbHkuIEEgcmVzdG9yZWQgc2Vzc2lvbiB3aG9zZVxuICAgKiBodW1hbiB3YXMgbGVmdCB3YWl0aW5nIFNIT1VMRCB0ZWxsIHRoZSBhZ2VudCB0aGF0IGFycml2ZXMg4oCUIHRoZSB3YWl0IGlzXG4gICAqIHJlYWwgYW5kIHRoZSBuZXcgYWdlbnQgaGFzIG5vdCBoZWFyZCBhYm91dCBpdC5cbiAgICovXG4gIGxldCBhY2tub3dsZWRnZWRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBjb25zdCBudWRnZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgLyoqXG4gICAqIEU2MDogdGhlIENPTlRFWFQncyB1bmRvIGhpc3Rvcnkg4oCUIG5vdCB0aGUgZWRpdG9yJ3MsIHdoaWNoIENvZGVNaXJyb3Igb3ducy5cbiAgICogSW4gbWVtb3J5IG9uIHB1cnBvc2UgKHNlZSBgaGlzdG9yeS50c2ApOiBhbiBpbnZlcnNlIGRlc2NyaWJlcyB0aGUgd29ybGQgYXNcbiAgICogaXQgaXMgbm93LCBhbmQgYSBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGZpbGVzIHNvbWVib2R5IGhhc1xuICAgKiBzaW5jZSBtb3ZlZCBieSBoYW5kLlxuICAgKi9cbiAgY29uc3QgaGlzdG9yeSA9IG5ldyBIaXN0b3J5KCk7XG5cbiAgY29uc3Qgdmlld1N0YXRlID0gKCk6IFB1YmxpY1N0YXRlID0+IHtcbiAgICBjb25zdCBiYXNlID0geyAuLi5zZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSwgcHJlZnM6IHJlYWRQcmVmcygpLCB1c2VySG9tZSB9O1xuICAgIHJldHVybiB7XG4gICAgICAuLi5iYXNlLFxuICAgICAgd2FpdGluZzogd2FpdGluZ09uKGJhc2UuY2hhdCwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KSxcbiAgICAgIGhpc3Rvcnk6IGhpc3RvcnkudmlldygpLFxuICAgIH07XG4gIH07XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLiAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pID0+IHtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIHRleHQpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJzeXN0ZW1cIiwgdGV4dCwgdHM6IG0udHMsIC4uLmZhY3QgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgfTtcblxuICAvLyAtLS0gdGhlIHdhdGNoZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy9cbiAgLy8g4pqgIERFVklBVElPTiBGUk9NIFRIRSBCUklFRiwgV0lUSCBJVFMgUkVBU09OOiBgbm9kZTpmc2AgYHdhdGNoYCAoQnVuJ3NcbiAgLy8gYnVpbHQtaW4pLCBOT1QgYEBwYXJjZWwvd2F0Y2hlcmAuIGBAcGFyY2VsL3dhdGNoZXJgIGlzIGEgbmF0aXZlIGFkZG9uIHdob3NlXG4gIC8vIGxvYWRlciBkb2VzIGEgcnVudGltZSBgcmVxdWlyZSgpYCBvZiBhIHBlci1wbGF0Zm9ybSBwYWNrYWdlOyBidW5kbGVkIGludG9cbiAgLy8gYGRpc3Qvc2VydmVyLmpzYCBpdCBpcyBub3QgaW5saW5lZCwgc28gdGhlIHNoaXBwZWQgZGFlbW9uIHdvdWxkIG5lZWQgYVxuICAvLyBgbm9kZV9tb2R1bGVzYCB0aGUgbWFya2V0cGxhY2UgbmV2ZXIgY29waWVzIChpbXBvcnQtYm91bmRhcnkgd2FyZCAxYidzXG4gIC8vIFwidGhlIHNoaXBwZWQgZXhlY3V0aW9uIHBhdGggY2FycmllcyBubyBkZXBlbmRlbmNpZXNcIikuIE1lYXN1cmVkIHVuZGVyIEJ1blxuICAvLyAxLjQuMCBvbiBtYWNPUyBiZWZvcmUgY2hvb3Npbmc6IGEgcmVjdXJzaXZlIGRpcmVjdG9yeSB3YXRjaCByZXBvcnRzIGFuXG4gIC8vIGluLXBsYWNlIHdyaXRlLCBhbiBhdG9taWMgdG1wK3JlbmFtZSBzYXZlLCBhbmQgYm90aCBhZ2FpbiBpbiBhXG4gIC8vIHN1YmRpcmVjdG9yeSDigJQgdGhlIGZvdXIgY2FzZXMgaW52ZXN0aWdhdGlvbiDCpzUgZHJvdmUgQHBhcmNlbC93YXRjaGVyIG9uLlxuICAvLyBUaGUgaGFzaC1jb21wYXJlIGFuZCBzZWxmLXdyaXRlIHN1cHByZXNzaW9uIGFyZSB1bmNoYW5nZWQgKHNlc3Npb24udHMpLlxuICBjb25zdCB3YXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGU1dhdGNoZXI+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG4gIGNvbnN0IG9uRnMgPSAoYWJzOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB0ID0gcGVuZGluZy5nZXQoYWJzKTtcbiAgICBpZiAodCkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHBlbmRpbmcuc2V0KFxuICAgICAgYWJzLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHBlbmRpbmcuZGVsZXRlKGFicyk7XG4gICAgICAgIGxldCBldjogRmlsZUV2ZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZXYgPSBzZXNzaW9uLm9uRmlsZUV2ZW50KGFicyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IHdhdGNoZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXYpIGhhbmRsZUZpbGVFdmVudChldik7XG4gICAgICB9LCBXQVRDSF9TRVRUTEVfTVMpLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IHN5bmNXYXRjaGVycyA9ICgpID0+IHtcbiAgICBjb25zdCB3YW50ID0gbmV3IE1hcChcbiAgICAgIHNlc3Npb24ud2F0Y2hSb290cygpLm1hcCgocikgPT4gW2Ake3IucmVjdXJzaXZlID8gXCJSXCIgOiBcIkZcIn06JHtyLndhdGNofT4ke3IucGF0aH1gLCByXSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHddIG9mIHdhdGNoZXJzKVxuICAgICAgaWYgKCF3YW50LmhhcyhrZXkpKSB7XG4gICAgICAgIHcuY2xvc2UoKTtcbiAgICAgICAgd2F0Y2hlcnMuZGVsZXRlKGtleSk7XG4gICAgICB9XG4gICAgZm9yIChjb25zdCBba2V5LCByXSBvZiB3YW50KSB7XG4gICAgICBpZiAod2F0Y2hlcnMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gV2F0Y2hlZCBhdCB0aGUgUkVBTFBBVEgsIHJlcG9ydGVkIHVuZGVyIHRoZSBzdG9yZWQgcGF0aCBmb3JtXG4gICAgICAgIC8vICh2ZXJpZnktcGFzcyBmaXggMyDigJQgc2VlIFNlc3Npb24ud2F0Y2hSb290cykuXG4gICAgICAgIGNvbnN0IHcgPSB3YXRjaChyLndhdGNoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gVGhlXG4gICAgICAgIC8vIG91dHNpZGUgdGV4dCBpcyBLRVBUIGFzIGEgbmV3IGFnZW50IHZlcnNpb24gYW5kIHRoZSBhY3RpdmUgdmVyc2lvblxuICAgICAgICAvLyBrZWVwcyB0aGUgaHVtYW4ncyB0ZXh0IOKAlCBub3RoaW5nIGlzIGxvc3QsIGFuZCB0aGUgaHVtYW4ncyBidWZmZXIgaXNcbiAgICAgICAgLy8gbm90IHRvdWNoZWQgKHZlcmlmeS1wYXNzIGZpeCA0KS5cbiAgICAgICAgYW5ub3VuY2VPdXRzaWRlKGV2LmRvYywgZXYudmVyc2lvbiwgZXYucGF0aCwgZXYucHJlc2VydmVkQXMsIGV2LnByZXNlcnZlZFBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYW5ub3VuY2VPdXRzaWRlID0gKFxuICAgIGRvYzogc3RyaW5nLFxuICAgIHZlcnNpb246IG51bWJlcixcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmcsXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7IGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jLCB2ZXJzaW9uLCBwYXRoLCBwcmVzZXJ2ZWRBcywgcHJlc2VydmVkUGF0aCB9LFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLyoqXG4gICAqIEUyNDogb25lIHN0cnVjdHVyZSBjaGFuZ2UsIGZyb20gZWl0aGVyIHBhcnR5IOKAlCB0aGUgc2FtZSBzZXNzaW9uIG1ldGhvZCwgdGhlXG4gICAqIHNhbWUgYW5ub3VuY2VtZW50IChuYW1pbmcgd2hvIGRpZCBpdCksIHRoZSBzYW1lIHRhaWwgZmFjdC4gUmV0dXJucyB0aGUgcGF0aFxuICAgKiB0aGUgY2hhbmdlIGxhbmRlZCBhdCwgd2hpY2ggdGhlIHN1cmZhY2UgdXNlcyB0byBvcGVuIG9yIHJlbmFtZSBpdC5cbiAgICovXG4gIGNvbnN0IFNUUlVDVFVSRV9PUFMgPSBuZXcgU2V0PHN0cmluZz4oW1xuICAgIFwiZG9jLmNyZWF0ZVwiLFxuICAgIFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgIFwibW92ZVwiLFxuICAgIFwicmVuYW1lXCIsXG4gICAgXCJoaWRlXCIsXG4gICAgXCJ1bmhpZGVcIixcbiAgICBcInNldC5tYWtlXCIsXG4gICAgXCJpbXBvcnRcIixcbiAgICBcIndvcmtzcGFjZS5zZXRcIixcbiAgXSBzYXRpc2ZpZXMgU3RydWN0dXJlT3BbXCJ0eXBlXCJdW10pO1xuICBjb25zdCBpc1N0cnVjdHVyZU9wID0gKG06IHsgdHlwZTogc3RyaW5nIH0pOiBtIGlzIFN0cnVjdHVyZU9wID0+IFNUUlVDVFVSRV9PUFMuaGFzKG0udHlwZSk7XG5cbiAgY29uc3Qgc3RydWN0dXJlID0gKG9wOiBTdHJ1Y3R1cmVPcCwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBjb25zdCB3aG8gPSBieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIjtcbiAgICAvLyDim5QgQ0FQVFVSRUQgQkVGT1JFIFRIRSBBQ1QsIGJlY2F1c2UgZXZlcnkgZmllbGQgaGVyZSBpcyBzb21ldGhpbmcgdGhlIGFjdFxuICAgIC8vIENIQU5HRVM6IHJlYWRpbmcgYW4gZW50cnkncyBoaWRkZW4gbGlzdCBhZnRlcndhcmRzIHJldHVybnMgdGhlIGxpc3RcbiAgICAvLyBpbmNsdWRpbmcgd2hhdCB3YXMganVzdCBoaWRkZW4sIHdoaWNoIHJlc3RvcmVzIG5vdGhpbmcgKEU2MCkuXG4gICAgY29uc3QgYmVmb3JlOiBCZWZvcmUgPSB7XG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJoaWRlXCIgPyB7IGhpZGRlbjogc2Vzc2lvbi5oaWRkZW5CZWZvcmUob3AucGF0aCkgPz8gdW5kZWZpbmVkIH0gOiB7fSksXG4gICAgICAuLi4ob3AudHlwZSA9PT0gXCJ1bmhpZGVcIiA/IHsgaGlkZGVuOiBzZXNzaW9uLmhpZGRlbk9mRW50cnkob3AuZW50cnkpID8/IHVuZGVmaW5lZCB9IDoge30pLFxuICAgICAgLi4uKG9wLnR5cGUgPT09IFwid29ya3NwYWNlLnNldFwiID8geyB3b3Jrc3BhY2U6IHNlc3Npb24ud29ya3NwYWNlIH0gOiB7fSksXG4gICAgfTtcbiAgICBjb25zdCBzaG93biA9IChwOiBzdHJpbmcpID0+IHNlc3Npb24uZGlzcGxheShwKTtcbiAgICBsZXQgcjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHBhdGg/OiBzdHJpbmcgfTtcbiAgICBsZXQgbGluZTogc3RyaW5nO1xuICAgIHN3aXRjaCAob3AudHlwZSkge1xuICAgICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRG9jKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVGb2xkZXIob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCB0aGUgZm9sZGVyICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKG9wLnBhdGgsIG9wLmludG8pO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gbW92ZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShvcC5wYXRoLCBvcC5uYW1lKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHJlbmFtZWQgJHtzaG93bihtLmZyb20pfSB0byAke3Nob3duKG0ucGF0aCl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgICBjb25zdCBoID0gc2Vzc2lvbi5oaWRlKG9wLnBhdGgpO1xuICAgICAgICByID0gaDtcbiAgICAgICAgLy8g4pqgIFRIRSBQQVJFTlRIRVRJQ0FMIEhBUyBUTyBCRSBUUlVFLiBJdCBzYWlkIFwiKHRoZSBmaWxlIGlzIHN0aWxsIG9uXG4gICAgICAgIC8vIGRpc2spXCIgdW5jb25kaXRpb25hbGx5LCB3aGljaCBpcyB3cm9uZyB0d2ljZSBvdmVyIG9uIGEgR0hPU1Qg4oCUIGFuXG4gICAgICAgIC8vIGVudHJ5IHdob3NlIGZpbGUgaXMgYWxyZWFkeSBnb25lIOKAlCBhbmQgY2FsbHMgYSBmb2xkZXIgYSBmaWxlLiBDb2xlXG4gICAgICAgIC8vIG1ldCBib3RoIGluIG9uZSBnbyB3aGlsZSBjbGVhcmluZyByZXNpZHVlIGZyb20gdGhlIEU2MCBidWcsIGFuZCBhXG4gICAgICAgIC8vIHJlYXNzdXJhbmNlIHRoYXQgaXMgZmFsc2UgaXMgd29yc2UgdGhhbiBubyByZWFzc3VyYW5jZTogaXQgaXMgdGhlXG4gICAgICAgIC8vIHNhbWUgZGVmZWN0IGFzIHRoZSBjb25mbGljdCBiYW5uZXIgY2xhaW1pbmcgZWRpdHMgaGUgaGFkIG5vdCBtYWRlLlxuICAgICAgICBjb25zdCBnb25lID0gIWV4aXN0c1N5bmMoaC5wYXRoKTtcbiAgICAgICAgY29uc3Qga2luZCA9IGdvbmUgPyBcIlwiIDogc3RhdFN5bmMoaC5wYXRoKS5pc0RpcmVjdG9yeSgpID8gXCJmb2xkZXJcIiA6IFwiZmlsZVwiO1xuICAgICAgICBsaW5lID0gZ29uZVxuICAgICAgICAgID8gYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAoaXQgd2FzIGFscmVhZHkgZ29uZSBmcm9tIGRpc2spLmBcbiAgICAgICAgICA6IGAke3dob30gcmVtb3ZlZCAke3Nob3duKGgucGF0aCl9IGZyb20gU2NyaXB0b3JpdW0gKHRoZSAke2tpbmR9IGlzIHN0aWxsIG9uIGRpc2spLmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IHUgPSBzZXNzaW9uLnVuaGlkZShvcC5lbnRyeSk7XG4gICAgICAgIHIgPSB1O1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBicm91Z2h0IGJhY2sgJHt1LnJlc3RvcmVkfSBoaWRkZW4gaXRlbSR7dS5yZXN0b3JlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2V0Lm1ha2VcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tYWtlU2V0KG9wLnBhdGgpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gdHVybmVkICR7YmFzZW5hbWUobS5wYXRoKX0gaW50byBhIHNldDogJHtzaG93bihtLmZvbGRlcil9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImltcG9ydFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5pbXBvcnRUZXh0KG9wLm5hbWUsIG9wLnRleHQsIG9wLmludG8pO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjb3BpZWQgJHtvcC5uYW1lfSBpbiBhcyAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2Uuc2V0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLnNldFdvcmtzcGFjZShvcC5wYXRoKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gc2V0IHRoZSB3b3Jrc3BhY2UgdG8gJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIC8vIFRoZSB3YXkgYmFjaywgcGxhbm5lZCBub3cgYW5kIGZyb20gd2hhdCB3YXMgdHJ1ZSBub3cuXG4gICAgaGlzdG9yeS5kaWQocGxhbkludmVyc2Uob3AsIHIgYXMgQWZ0ZXIsIGJlZm9yZSkpO1xuICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogb3AudHlwZSwgYnksIC4uLnIgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gcjtcbiAgfTtcblxuICAvKipcbiAgICogQXBwbHkgb25lIHJlY29yZGVkIGludmVyc2UsIGFuZCByZXR1cm4gdGhlIGFjdCB0aGF0IHdvdWxkIHJldmVyc2UgVEhBVCDigJRcbiAgICogd2hpY2ggaXMgd2hhdCBnb2VzIG9udG8gdGhlIG90aGVyIHN0YWNrLlxuICAgKlxuICAgKiDim5QgQSBERUxFVEUgSEFTIE5PIFdBWSBCQUNLLCBhbmQgc2F5cyBzbyBieSByZXR1cm5pbmcgbnVsbC4gT25jZSBhIGNyZWF0ZWRcbiAgICogZmlsZSBpcyBnb25lIGl0cyBjb250ZW50cyBhcmUgZ29uZSB3aXRoIGl0LCBzbyBhIHJlZG8gdGhhdCBcInJlLWNyZWF0ZXNcIiBpdFxuICAgKiB3b3VsZCBoYW5kIGJhY2sgYW4gZW1wdHkgZmlsZSB3ZWFyaW5nIHRoZSBzYW1lIG5hbWUg4oCUIHRoZSBraW5kIG9mIGxpZSBhblxuICAgKiB1bmRvIHN0YWNrIG11c3Qgbm90IHRlbGwuIENvbmZpcm1lZCBkZWxldGlvbnMgYXJlIHRoZXJlZm9yZSBvbmUtd2F5LCB3aGljaFxuICAgKiBpcyBhbHNvIHdoeSB0aGV5IGFyZSBjb25maXJtZWQuXG4gICAqL1xuICBjb25zdCBhcHBseUludmVyc2UgPSAoaW52OiBJbnZlcnNlKTogQWN0IHwgbnVsbCA9PiB7XG4gICAgc3dpdGNoIChpbnYua2luZCkge1xuICAgICAgY2FzZSBcIm1vdmVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5tb3ZlKGludi5wYXRoLCBpbnYuaW50byk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGBtb3ZlZCAke2Jhc2VuYW1lKG0uZnJvbSl9IGJhY2sgaW50byAke2Jhc2VuYW1lKGRpcm5hbWUobS5wYXRoKSl9YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwibW92ZVwiLCBwYXRoOiBtLnBhdGgsIGludG86IGRpcm5hbWUobS5mcm9tKSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlbmFtZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLnJlbmFtZShpbnYucGF0aCwgaW52Lm5hbWUpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgcmVuYW1lZCAke2Jhc2VuYW1lKG0uZnJvbSl9IGJhY2sgdG8gJHtiYXNlbmFtZShtLnBhdGgpfWAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcInJlbmFtZVwiLCBwYXRoOiBtLnBhdGgsIG5hbWU6IGJhc2VuYW1lKG0uZnJvbSkgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaWRkZW5cIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXN0b3JlSGlkZGVuKGludi5lbnRyeSwgaW52LnJlbHMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiByLndhcy5sZW5ndGggPiBpbnYucmVscy5sZW5ndGggPyBcImJyb3VnaHQgaXRlbXMgYmFja1wiIDogXCJoaWQgaXRlbXMgYWdhaW5cIixcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiByLmVudHJ5LCByZWxzOiByLndhcyB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgeyBlbnRyeSB9ID0gc2Vzc2lvbi5hZGRDb250ZXh0KGludi5wYXRoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsYWJlbDogYHB1dCAke2Jhc2VuYW1lKGludi5wYXRoKX0gYmFjayBpbiB0aGUgY29udGV4dGAsXG4gICAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImNvbnRleHQucmVtb3ZlXCIsIGVudHJ5OiBlbnRyeS5pZCB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQucmVtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHNlc3Npb24uZW50cnlSb290KGludi5lbnRyeSk7XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ29udGV4dChpbnYuZW50cnkpO1xuICAgICAgICByZXR1cm4gcGF0aCA9PT0gbnVsbFxuICAgICAgICAgID8gbnVsbFxuICAgICAgICAgIDoge1xuICAgICAgICAgICAgICBsYWJlbDogYHRvb2sgJHtiYXNlbmFtZShwYXRoKX0gYmFjayBvdXQgb2YgdGhlIGNvbnRleHRgLFxuICAgICAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIiwgcGF0aCB9LFxuICAgICAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3b3Jrc3BhY2VcIjoge1xuICAgICAgICBjb25zdCB3YXMgPSBzZXNzaW9uLndvcmtzcGFjZTtcbiAgICAgICAgc2Vzc2lvbi5zZXRXb3Jrc3BhY2UoaW52LnBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxhYmVsOiBgc2V0IHRoZSB3b3Jrc3BhY2UgYmFjayB0byAke2Jhc2VuYW1lKGludi5wYXRoKX1gLFxuICAgICAgICAgIGludmVyc2U6IHsga2luZDogXCJ3b3Jrc3BhY2VcIiwgcGF0aDogd2FzIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGVsZXRlXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDcmVhdGVkKGludi5wYXRoLCBpbnYuZGlyKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBzdXJmYWNlIG1lc3NhZ2VzIChXZWJTb2NrZXQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHJlcGx5ID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIHRyeSB7XG4gICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KG1zZykpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSAqL1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVDbGllbnRNc2cgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogQ2xpZW50TXNnKSA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AobXNnKSkge1xuICAgICAgY29uc3QgciA9IHN0cnVjdHVyZShhbmNob3JTdXJmYWNlUGF0aHMobXNnKSwgXCJodW1hblwiKTtcbiAgICAgIGlmICh0eXBlb2Ygci5wYXRoID09PSBcInN0cmluZ1wiKVxuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInN0cnVjdHVyZS5kb25lXCIsIG9wOiBtc2cudHlwZSwgcGF0aDogci5wYXRoIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwib3BlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm9wZW5QYXRoKG1zZy5wYXRoKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIC8vIFRoZSBvcGVuZXIgZ2V0cyB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IHN0cmFpZ2h0IGF3YXkg4oCUIHRoZSBzdGF0ZVxuICAgICAgICAvLyBzbmFwc2hvdCBjYXJyaWVzIG5vIHRleHRzLCBhbmQgYSB2aWV3ZXIgbXVzdCBub3Qgd2FpdCBvbiBhIHNlY29uZCBhc2suXG4gICAgICAgIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyLmNyZWF0ZWQpXG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvYy5vcGVuZWRcIiwgZG9jOiByLnNsdWcsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChyLnNsdWcpIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwib3Blbi5kb2NcIjpcbiAgICAgICAgc2Vzc2lvbi5vcGVuU2x1Zyhtc2cuZG9jKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0KG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBtc2cudGV4dCk7XG4gICAgICAgIGlmIChyLnByZXNlcnZlZCkge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhtc2cuZG9jKTtcbiAgICAgICAgICBhbm5vdW5jZU91dHNpZGUoXG4gICAgICAgICAgICBkLnNsdWcsXG4gICAgICAgICAgICBtc2cudmVyc2lvbixcbiAgICAgICAgICAgIHNlc3Npb24uYWN0aXZlUGF0aChkLnNsdWcpID8/IFwiXCIsXG4gICAgICAgICAgICByLnByZXNlcnZlZC5uLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQucGF0aCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHIuZGlydHlDaGFuZ2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6IHtcbiAgICAgICAgLy8g4puUIFJFUExJRUQgVE8gVEhFIEFTS0lORyBTT0NLRVQsIE5PVCBCUk9BRENBU1QuIEEgc2VhcmNoIGlzIG9uZVxuICAgICAgICAvLyB2aWV3ZXIncyBxdWVzdGlvbjsgcHVzaGluZyByZXN1bHRzIHRvIGV2ZXJ5IGNsaWVudCB3b3VsZCBwdXQgc29tZW9uZVxuICAgICAgICAvLyBlbHNlJ3MgcXVlcnkgaW4geW91ciBwYW5lLiAoVGhlIHNhbWUgcmVhc29uIGBkaWZmYCByZXBsaWVzIHJhdGhlclxuICAgICAgICAvLyB0aGFuIGJyb2FkY2FzdGluZy4pXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzZWFyY2gucmVzdWx0c1wiLCByZXBvcnQ6IHNlc3Npb24uc2VhcmNoQWxsKG1zZykgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlzdG9yeS51bmRvXCI6IHtcbiAgICAgICAgY29uc3QgYWN0ID0gaGlzdG9yeS5wZWVrVW5kbygpO1xuICAgICAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIE5FRURTIFRIRSBIVU1BTidTIFdPUkQsIGNhcnJpZWQgZXhwbGljaXRseS4gQVxuICAgICAgICAvLyBjbGllbnQgdGhhdCBzaW1wbHkgb21pdHMgdGhlIGZsYWcgZ2V0cyBhIHJlZnVzYWwgcmF0aGVyIHRoYW4gYVxuICAgICAgICAvLyBkZWxldGlvbiwgc28gXCJmb3Jnb3QgdG8gY29uZmlybVwiIGNhbiBuZXZlciBiZWNvbWUgXCJkZWxldGVkIGFueXdheVwiLlxuICAgICAgICBpZiAoYWN0LmludmVyc2Uua2luZCA9PT0gXCJkZWxldGVcIiAmJiBtc2cuY29uZmlybURlbGV0ZSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVW5kb2luZyBcIiR7YWN0LmxhYmVsfVwiIHdvdWxkIGRlbGV0ZSAke3Nlc3Npb24uZGlzcGxheShhY3QuaW52ZXJzZS5wYXRoKX0g4oCUIGNvbmZpcm0gaXQgZmlyc3QuYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoaXN0b3J5LnRvb2tVbmRvKGFwcGx5SW52ZXJzZShhY3QuaW52ZXJzZSkpO1xuICAgICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICAgIGFubm91bmNlKGBZb3UgdW5kaWQ6ICR7YWN0LmxhYmVsfS5gLCB7IGZhY3Q6IFwiaGlzdG9yeS51bmRvXCIgfSk7XG4gICAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIFRoZSByZWZ1c2FsIHRoZSBodW1hbiBuZWVkcyB0byByZWFkIOKAlCBhIGZvbGRlciB3aXRoIHRoaW5ncyBpbiBpdCxcbiAgICAgICAgICAvLyBvciBhIHdvcmxkIHRoYXQgaGFzIG1vdmVkIHVuZGVyIGEgcmVjb3JkZWQgaW52ZXJzZS4gVGhlIGFjdCBTVEFZU1xuICAgICAgICAgIC8vIG9uIHRoZSBzdGFjazogbm90aGluZyBoYXBwZW5lZCwgc28gbm90aGluZyBzaG91bGQgYmUgZm9yZ290dGVuLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaXN0b3J5LnJlZG9cIjoge1xuICAgICAgICBjb25zdCBhY3QgPSBoaXN0b3J5LnBlZWtSZWRvKCk7XG4gICAgICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGlzdG9yeS50b29rUmVkbyhhcHBseUludmVyc2UoYWN0LmludmVyc2UpKTtcbiAgICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgICBhbm5vdW5jZShgWW91IHJlZGlkOiAke2FjdC5sYWJlbH0uYCwgeyBmYWN0OiBcImhpc3RvcnkucmVkb1wiIH0pO1xuICAgICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VsZWN0XCI6XG4gICAgICAgIC8vIEFNQklFTlQgc3RhdGU6IHN0b3JlZCBhbmQgc2hvd24sIG5ldmVyIHB1c2hlZCBvbnRvIHRoZSBhZ2VudCdzIHRhaWwuXG4gICAgICAgIHNlbGVjdGlvbiA9IG1zZy5zZWxlY3Rpb247XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCB0ZXh0ID0gbXNnLnRleHQudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2VsID0gbXNnLndpdGhTZWxlY3Rpb24gPyBzZWxlY3Rpb24gOiBudWxsO1xuICAgICAgICBjb25zdCBhY3RpdmVQYXRoID0gc2VsID8gc2Vzc2lvbi5hY3RpdmVQYXRoKHNlbC5kb2MpIDogc2Vzc2lvbi5hY3RpdmVQYXRoKCk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJodW1hblwiLCB0ZXh0LCB7IHNlbGVjdGlvbjogc2VsLCBhY3RpdmVQYXRoIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgbWVzc2FnZV9pZDogbS5pZCxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2Yoc2VsPy5kb2MpLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIGFjdGl2YXRlKG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBcImh1bWFuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwibm90ZS5hZGRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5hZGROb3RlKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgYm9keTogbXNnLmJvZHksXG4gICAgICAgICAgd2hvOiBcImh1bWFuXCIsXG4gICAgICAgICAgcmFuZ2U6IHsgZnJvbTogbXNnLmZyb20sIHRvOiBtc2cudG8gfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLmFkZGVkXCIsIGRvYzogci5zbHVnLCBub3RlOiByLm5vdGUuaWQsIGJ5OiBcImh1bWFuXCIgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLmRvbmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5maW5pc2hUYXNrKG1zZy5pZCwgbXNnLm91dGNvbWUpO1xuICAgICAgICBpZiAoIXIuYWxyZWFkeSkge1xuICAgICAgICAgIHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBgRG9uZTogJHtyLnRhc2sudGV4dH1gKTtcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwidGFzay5kb25lXCIsIHRhc2s6IHIudGFzay5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgfVxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidGFzay5yZW1vdmVcIjoge1xuICAgICAgICBzZXNzaW9uLnJlbW92ZVRhc2sobXNnLmlkKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2tzLmNsZWFyXCI6IHtcbiAgICAgICAgc2Vzc2lvbi5jbGVhckRvbmVUYXNrcygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5lZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdE5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQsIGJvZHk6IG1zZy5ib2R5IH0pO1xuICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwibm90ZS5lZGl0ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUucmVzb2x2ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlc29sdmVOb3RlKHsgZG9jOiBtc2cuZG9jLCBpZDogbXNnLmlkLCByZXNvbHZlZDogbXNnLnJlc29sdmVkIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogbXNnLnJlc29sdmVkID8gXCJub3RlLnJlc29sdmVkXCIgOiBcIm5vdGUucmVvcGVuZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICBub3RlOiByLm5vdGUuaWQsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlbW92ZU5vdGUoeyBkb2M6IG1zZy5kb2MsIGlkOiBtc2cuaWQgfSk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJub3RlLnJlbW92ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiaHVtYW5cIiB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogbXNnLmRvYywgdmVyc2lvbjogbXNnLnZlcnNpb24gfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgRGVsZXRlZCB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfSR7ci5sYWJlbCA/IGAg4oCUICR7ci5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5kZWxldGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgLi4uKG1zZy5mcm9tID09PSB1bmRlZmluZWQgPyB7fSA6IHsgZnJvbTogbXNnLmZyb20gfSksXG4gICAgICAgICAgLi4uKG1zZy5sYWJlbCA/IHsgbGFiZWw6IG1zZy5sYWJlbCB9IDoge30pLFxuICAgICAgICAgIGF1dGhvcjogXCJodW1hblwiLFxuICAgICAgICB9KTtcbiAgICAgICAgLy8g4puUIFNBWSBXSEVSRSBUSEVZIEFSRSwgbm90IGp1c3Qgd2hhdCB3YXMgbWFkZSAoRTQyKS4gVGhlIG9sZCBtZXNzYWdlXG4gICAgICAgIC8vIGFubm91bmNlZCB0aGUgbmV3IHZlcnNpb24gYW5kIHdlbnQgcXVpZXQgYWJvdXQgd2hpY2ggb25lIHRoZSBodW1hblxuICAgICAgICAvLyB3YXMgZWRpdGluZyDigJQgd2hpY2ggaXMgZXhhY3RseSBob3cgc29tZW9uZSB0eXBlcyBpbnRvIHYxIGJlbGlldmluZ1xuICAgICAgICAvLyB0aGV5IGFyZSBpbiB2Mi5cbiAgICAgICAgaWYgKG1zZy5hY3RpdmF0ZSkgc2Vzc2lvbi5hY3RpdmF0ZSh7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBNYWRlIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke21zZy5sYWJlbCA/IGAg4oCUICR7bXNnLmxhYmVsfWAgOiBcIlwifS4gYCArXG4gICAgICAgICAgICAobXNnLmFjdGl2YXRlXG4gICAgICAgICAgICAgID8gYFlvdSBhcmUgbm93IGVkaXRpbmcgdiR7ci52ZXJzaW9uLm59LmBcbiAgICAgICAgICAgICAgOiBgWW91IGFyZSBzdGlsbCBlZGl0aW5nIHYke3IudmVyc2lvbi5mcm9tfS5gKSxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLm4sXG4gICAgICAgICAgZnJvbTogci52ZXJzaW9uLmZyb20sXG4gICAgICAgICAgYWN0aXZhdGVkOiBtc2cuYWN0aXZhdGUgPT09IHRydWUsXG4gICAgICAgICAgYnk6IFwiaHVtYW5cIixcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uc2F2ZShtc2cuZG9jKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBgU2F2ZWQgdiR7ci52ZXJzaW9ufSB0byAke3Iub3JpZ2luYWx9LmApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJzYXZlZFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgb3JpZ2luYWw6IHIub3JpZ2luYWwsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicmV2ZXJ0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmV2ZXJ0KG1zZy5kb2MpO1xuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgUmV2ZXJ0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke21zZy5kb2N9IHRvIHRoZSBzYXZlZCBmaWxlLmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJyZXZlcnRlZFwiLCBkb2M6IG1zZy5kb2MsIHZlcnNpb246IHIudmVyc2lvbiwgdHM6IG0udHMgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOlxuICAgICAgICBhZGRQYXRocyhbc3VyZmFjZVBhdGgobXNnLnBhdGgpXSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZXZlYWxcIjpcbiAgICAgICAgcmV2ZWFsUGF0aChzZXNzaW9uLnNob3duUGF0aChzdXJmYWNlUGF0aChtc2cucGF0aCkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbC52ZXJzaW9uXCI6XG4gICAgICAgIC8vIFRoZSBkYWVtb24gcmVzb2x2ZXMgaXQsIHNvIHRoZSBzdXJmYWNlIG5ldmVyIG5hbWVzIGEgcGF0aCBvdXRzaWRlXG4gICAgICAgIC8vIHdoYXQgdGhlIHNlc3Npb24gYWxyZWFkeSBvd25zLlxuICAgICAgICByZXZlYWxQYXRoKHNlc3Npb24ucmVhZFZlcnNpb24obXNnLmRvYywgbXNnLnZlcnNpb24pLnBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicGlja1wiOiB7XG4gICAgICAgIHZvaWQgb3BlblBpY2tlcih3cywgbXNnLndhbnQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjpcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KG1zZy5pZCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmVhZFwiOiB7XG4gICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogbXNnLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihtc2cuZG9jLCBtc2cudmVyc2lvbikudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImRpZmZcIjoge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImRpZmZcIiwgLi4uc2Vzc2lvbi5jb21wYXJlKHsgZG9jOiBtc2cuZG9jLCBhZ2FpbnN0OiBtc2cuYWdhaW5zdCB9KSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1lcmdlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWVyZ2UoeyBkb2M6IG1zZy5kb2MsIGFnYWluc3Q6IG1zZy5hZ2FpbnN0LCBodW5rczogbXNnLmh1bmtzIH0pO1xuICAgICAgICAvLyBUaGUgYnVmZmVyIHRoZSBodW1hbiBpcyBsb29raW5nIGF0IG11c3QgYmUgdG9sZDogdGhlIG1lcmdlIHdyb3RlIHRoZVxuICAgICAgICAvLyBhY3RpdmUgdmVyc2lvbidzIEZJTEUsIGFuZCB0aGUgZWRpdG9yJ3MgdGV4dCBpcyBub3cgYmVoaW5kIGl0LlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBUb29rICR7ci5hcHBsaWVkfSBjaGFuZ2Uke3IuYXBwbGllZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZnJvbSAke3NpZGVOYW1lKG1zZy5hZ2FpbnN0LCBzZXNzaW9uLmRvYyhyLnNsdWcpLm5hbWUpfSBpbnRvIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9LmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lcmdlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBhZ2FpbnN0OiBtc2cuYWdhaW5zdCxcbiAgICAgICAgICBodW5rczogbXNnLmh1bmtzLFxuICAgICAgICAgIGJ5OiBcImh1bWFuXCIsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJlZnMuc2V0XCI6IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFQUkVGX0tFWS50ZXN0KG1zZy5rZXkpIHx8XG4gICAgICAgICAgdHlwZW9mIG1zZy52YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgIG1zZy52YWx1ZS5sZW5ndGggPiBQUkVGX1ZBTFVFX01BWFxuICAgICAgICApXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX1gKTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHJlYWRQcmVmcygpO1xuICAgICAgICBpZiAoY3VycmVudFttc2cua2V5XSA9PT0gbXNnLnZhbHVlKSByZXR1cm47XG4gICAgICAgIGlmICghKG1zZy5rZXkgaW4gY3VycmVudCkgJiYgT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoID49IFBSRUZfS0VZU19NQVgpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfTogJHtQUkVGX0tFWVNfTUFYfSBrZXlzIGFscmVhZHkga2VwdGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgd3JpdGVGaWxlQXRvbWljKFxuICAgICAgICAgIHByZWZzRmlsZSxcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IC4uLmN1cnJlbnQsIFttc2cua2V5XTogbXNnLnZhbHVlIH0sIG51bGwsIDIpfVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJncmFwaFwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJncmFwaFwiLCBlbnRyeTogbXNnLmVudHJ5LCBncmFwaDogc2Vzc2lvbi5ncmFwaEZvcihtc2cuZW50cnkpIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAgIGVudHJ5OiBtc2cuZW50cnksXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJsaW5rLm9wZW5cIjoge1xuICAgICAgICAvLyBFMzM6IGEgbGluayBpbnNpZGUgdGhlIGJ1bmRsZSBpcyBGT0xMT1dFRDsgb25lIHRoYXQgZXNjYXBlcyBpdCBpc1xuICAgICAgICAvLyByZXBvcnRlZCBzbyB0aGUgc3VyZmFjZSBjYW4gb2ZmZXIgdG8gYWRkIGl0LCBuZXZlciBhZGRlZCBzaWxlbnRseS5cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZUxpbmsobXNnLmZyb20sIG1zZy50YXJnZXQpO1xuICAgICAgICBpZiAoci5zdGF0ZSA9PT0gXCJpbi1idW5kbGVcIikge1xuICAgICAgICAgIHNlc3Npb24ub3BlblBhdGgoci5wYXRoKTtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhzZXNzaW9uLm9wZW5Eb2NTbHVnID8/IFwiXCIpO1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oZC5zbHVnLCBkLmFjdGl2ZSkudGV4dCxcbiAgICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcImxpbmsudGFyZ2V0XCIsXG4gICAgICAgICAgdGFyZ2V0OiBtc2cudGFyZ2V0LFxuICAgICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgICAgIC4uLihyLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHt9IDogeyBwYXRoOiByLnBhdGggfSksXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwibWV0YS5zdWdnZXN0XCI6IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zdWdnZXN0TWV0YShtc2cucGF0aCwgXCJodW1hblwiKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJtZXRhLnN1Z2dlc3Rpb25cIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgYmxvY2s6IHIuYmxvY2ssXG4gICAgICAgICAgICAuLi4oci50eXBlID8geyBzdWdnZXN0ZWRUeXBlOiByLnR5cGUgfSA6IHt9KSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1ldGEuc3VnZ2VzdGlvblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtb3ZlLnBsYW5cIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1vdmUucGxhblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBpbnRvOiBtc2cuaW50byxcbiAgICAgICAgICAgIHBsYW46IHNlc3Npb24ubW92ZVBsYW4oc3VyZmFjZVBhdGgobXNnLnBhdGgpLCBzdXJmYWNlUGF0aChtc2cuaW50bykpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZnMubGlzdFwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBleHBhbmRIb21lKG1zZy5wYXRoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImZzLmxpc3RcIiwgcGF0aDogbXNnLnBhdGgsIGVudHJpZXM6IGxpc3REaXIocGF0aCkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJmcy5saXN0XCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVudHJpZXM6IFtdLFxuICAgICAgICAgICAgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyDilIDilIAgdGhlIG5hdGl2ZSBwaWNrZXIgKG9uZSBkaWFsb2cgYXQgYSB0aW1lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy9cbiAgLy8gQSBtb2RhbCBkaWFsb2cgb3ducyB0aGUgaHVtYW4ncyBhdHRlbnRpb24sIGFuZCBhIHNlY29uZCBvbmUgYmVoaW5kIHRoZVxuICAvLyBmaXJzdCBjYW5ub3QgYmUgc2VlbiBvciBkaXNtaXNzZWQg4oCUIHNvIGEgcmVxdWVzdCB3aGlsZSBvbmUgaXMgb3BlbiBpc1xuICAvLyByZWZ1c2VkIGluIHdvcmRzIHJhdGhlciB0aGFuIHF1ZXVlZC5cbiAgbGV0IHBpY2tlck9wZW4gPSBmYWxzZTtcbiAgY29uc3QgemVuaXR5ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJsaW51eFwiID8gQnVuLndoaWNoKFwiemVuaXR5XCIpIDogbnVsbDtcbiAgY29uc3Qgb3BlblBpY2tlciA9IGFzeW5jIChcbiAgICB3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPixcbiAgICB3YW50OiBcImNvbnRleHQtZmlsZVwiIHwgXCJjb250ZXh0LWZvbGRlclwiIHwgXCJ3b3Jrc3BhY2VcIixcbiAgKSA9PiB7XG4gICAgaWYgKHBpY2tlck9wZW4pIHtcbiAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogXCJhIGZpbGUgcGlja2VyIGlzIGFscmVhZHkgb3BlblwiIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBraW5kOiBQaWNrS2luZCA9IHdhbnQgPT09IFwiY29udGV4dC1maWxlXCIgPyBcImZpbGVcIiA6IFwiZm9sZGVyXCI7XG4gICAgY29uc3QgcHJvbXB0ID1cbiAgICAgIHdhbnQgPT09IFwid29ya3NwYWNlXCJcbiAgICAgICAgPyBcIkNob29zZSB0aGUgd29ya3NwYWNlIGZvbGRlciBmb3Igc2NyaXB0b3JpdW1cIlxuICAgICAgICA6IHdhbnQgPT09IFwiY29udGV4dC1mb2xkZXJcIlxuICAgICAgICAgID8gXCJDaG9vc2UgYSBmb2xkZXIgdG8gYWRkIHRvIHNjcmlwdG9yaXVtXCJcbiAgICAgICAgICA6IFwiQ2hvb3NlIGRvY3VtZW50cyB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIjtcbiAgICBjb25zdCBjbWQgPSBwaWNrZXJDb21tYW5kKHByb2Nlc3MucGxhdGZvcm0sIGtpbmQsIHByb21wdCwgemVuaXR5KTtcbiAgICBpZiAoIWNtZCkge1xuICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgdHlwZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgbm8gZmlsZSBwaWNrZXIgb24gdGhpcyBzeXN0ZW0gKCR7cHJvY2Vzcy5wbGF0Zm9ybX0pIOKAlCB0eXBlIHRoZSBwYXRoIGluc3RlYWRgLFxuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHBpY2tlck9wZW4gPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKGNtZCwgeyBzdGRvdXQ6IFwicGlwZVwiLCBzdGRlcnI6IFwicGlwZVwiLCBzdGRpbjogXCJpZ25vcmVcIiB9KTtcbiAgICAgIGNvbnN0IFtvdXQsIGNvZGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW25ldyBSZXNwb25zZShwcm9jLnN0ZG91dCkudGV4dCgpLCBwcm9jLmV4aXRlZF0pO1xuICAgICAgdG91Y2goKTsgLy8gYSBodW1hbiBzdG9vZCBhdCBhIGRpYWxvZzsgdGhlIHNlc3Npb24gaXMgbm90IGlkbGVcbiAgICAgIGNvbnN0IHBhdGhzID0gcGFyc2VQaWNrZXJPdXRwdXQob3V0KTtcbiAgICAgIGlmIChwYXRocy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgLy8gQ2FuY2VsbGVkOiBub3RoaW5nIGNob3Nlbiwgbm90aGluZyBzYWlkLiBBIHJlYWwgZmFpbHVyZSBpcyBzYWlkLlxuICAgICAgICBpZiAoIXdhc0NhbmNlbGxlZChjb2RlLCBvdXQpKVxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYHRoZSBmaWxlIHBpY2tlciBmYWlsZWQgKGV4aXQgJHtjb2RlfSlgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBXaGF0IHdhcyBjaG9zZW4gaXMgYWRtaXR0ZWQgbGlrZSBhbnkgb3RoZXIgcGF0aCDigJQgYSBwaWNrZWQgZmlsZSB0aGF0XG4gICAgICAvLyBzY3JpcHRvcml1bSBkb2VzIG5vdCBvcGVuIGlzIHJlZnVzZWQgaW4gdGhlIHNpZGViYXIncyBvd24gd29yZHMsIGFuZFxuICAgICAgLy8gdGhhdCByZWZ1c2FsIG11c3Qgbm90IHJlYWQgYXMgXCJ0aGUgcGlja2VyIGZhaWxlZFwiLlxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKHdhbnQgPT09IFwid29ya3NwYWNlXCIpXG4gICAgICAgICAgc3RydWN0dXJlKHsgdHlwZTogXCJ3b3Jrc3BhY2Uuc2V0XCIsIHBhdGg6IHBhdGhzWzBdIGFzIHN0cmluZyB9LCBcImh1bWFuXCIpO1xuICAgICAgICBlbHNlIGFkZFBhdGhzKHBhdGhzKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgdHlwZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgY291bGQgbm90IG9wZW4gdGhlIGZpbGUgcGlja2VyOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHBpY2tlck9wZW4gPSBmYWxzZTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYWN0aXZlT2YgPSAoZG9jPzogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qgc2x1ZyA9IGRvYyA/PyBzZXNzaW9uLm9wZW5Eb2NTbHVnO1xuICAgIGlmICghc2x1ZykgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBzZXNzaW9uLmRvYyhzbHVnKTtcbiAgICAgIHJldHVybiB7IGRvYzogdi5zbHVnLCB2ZXJzaW9uOiB2LmFjdGl2ZSwgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHYuc2x1ZykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gYWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIC8qKiBTaG93IGEgZmlsZSBpbiB0aGUgcGxhdGZvcm0ncyBmaWxlIG1hbmFnZXIuIEFuIGFyZ3YsIG5ldmVyIGEgc2hlbGwgc3RyaW5nOlxuICAgKiAgdGhlIHBhdGggaXMgZGF0YSwgd2hhdGV2ZXIgaXQgaG9sZHMuICovXG4gIGNvbnN0IHJldmVhbFBhdGggPSAocGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3QgW2NtZCwgLi4uYXJnc10gPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIlxuICAgICAgICA/IFtcIm9wZW5cIiwgXCItUlwiLCBwYXRoXVxuICAgICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICAgID8gW1wiZXhwbG9yZXJcIiwgYC9zZWxlY3QsJHtwYXRofWBdXG4gICAgICAgICAgOiBbXCJ4ZGctb3BlblwiLCBkaXJuYW1lKHBhdGgpXTtcbiAgICBCdW4uc3Bhd24oW2NtZCBhcyBzdHJpbmcsIC4uLmFyZ3NdLCB7IHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0gfSkudW5yZWYoKTtcbiAgfTtcblxuICBjb25zdCBoYW5kbGVBZ2VudENtZCA9IChjbWQ6IEFnZW50Q21kKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGlmIChpc1N0cnVjdHVyZU9wKGNtZCkpIHJldHVybiBzdHJ1Y3R1cmUoY21kLCBcImFnZW50XCIpO1xuICAgIHN3aXRjaCAoY21kLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJtZXRhXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLm1ldGFGb3IoY21kLnBhdGgpO1xuICAgICAgY2FzZSBcImdyYXBoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmdyYXBoRm9yKGNtZC5lbnRyeSkgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGNhc2UgXCJkYW5nbGluZ1wiOlxuICAgICAgICByZXR1cm4gc2Vzc2lvbi5kYW5nbGluZ0xpbmtzKGNtZC5lbnRyeSk7XG4gICAgICBjYXNlIFwiZG9jdG9yXCI6IHtcbiAgICAgICAgY29uc3QgbGlzdCA9IHNlc3Npb24uY2hlY2t1cCgpO1xuICAgICAgICByZXR1cm4geyBmaW5kaW5nczogbGlzdCwgY291bnQ6IGxpc3QubGVuZ3RoIH0gYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmb3JnZXRcIjoge1xuICAgICAgICBjb25zdCBmID0gc2Vzc2lvbi5mb3JnZXREb2MoY21kLmRvYyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBmb3Jnb3QgJHtmLm5hbWV9IOKAlCBpdHMgZmlsZSB3YXMgZ29uZSwgYW5kICR7Zi52ZXJzaW9ucyA9PT0gMSA/IFwiMSB2ZXJzaW9uXCIgOiBgJHtmLnZlcnNpb25zfSB2ZXJzaW9uc2B9IGluIHRoaXMgc2Vzc2lvbiAke2YudmVyc2lvbnMgPT09IDEgPyBcImlzXCIgOiBcImFyZVwifSBubyBsb25nZXIgcmVhY2hhYmxlLmAsXG4gICAgICAgICAgeyBmYWN0OiBcImRvYy5mb3Jnb3R0ZW5cIiwgZG9jOiBmLnNsdWcsIG9yaWdpbmFsOiBmLm9yaWdpbmFsIH0sXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiBmIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VhcmNoXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLnNlYXJjaEFsbChjbWQpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjYXNlIFwiYmFja2xpbmtzXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmJhY2tsaW5rcyhjbWQucGF0aCk7XG4gICAgICBjYXNlIFwibWV0YS5pbml0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YUluaXQoY21kLnBhdGgsIHtcbiAgICAgICAgICAuLi4oY21kLm1ldGFUeXBlID8geyB0eXBlOiBjbWQubWV0YVR5cGUgfSA6IHt9KSxcbiAgICAgICAgICBieTogY21kLmJ5ID8/IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBhZGRlZCBmcm9udG1hdHRlciB0byAke3Nlc3Npb24uZGlzcGxheShTdHJpbmcoci5wYXRoKSl9LmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgLi4ucixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1ldGEuc2V0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubWV0YVNldChjbWQucGF0aCwgY21kLmZpZWxkcyk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBzZXQgJHsoci5zZXQgYXMgc3RyaW5nW10pLmpvaW4oXCIsIFwiKX0gb24gJHtzZXNzaW9uLmRpc3BsYXkoU3RyaW5nKHIucGF0aCkpfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXRhLnNldFwiLCBieTogXCJhZ2VudFwiLCAuLi5yIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByO1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24uZGVsZXRlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZGVsZXRlVmVyc2lvbih7IGRvYzogY21kLmRvYywgdmVyc2lvbjogY21kLnZlcnNpb24gfSk7XG4gICAgICAgIGFubm91bmNlKGBBZ2VudCBkZWxldGVkIHYke3IudmVyc2lvbn0gb2YgJHtyLnNsdWd9JHtyLmxhYmVsID8gYCDigJQgJHtyLmxhYmVsfWAgOiBcIlwifS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmRlbGV0ZWRcIixcbiAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24sIHJlbWFpbmluZzogci5yZW1haW5pbmcgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJub3RlLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFkZE5vdGUoe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBib2R5OiBjbWQuYm9keSxcbiAgICAgICAgICB3aG86IFwiYWdlbnRcIixcbiAgICAgICAgICBxdW90ZTogY21kLnF1b3RlLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IG5vdGVkIOKAnCR7cXVvdGVMYWJlbChyLm5vdGUucXVvdGUpfeKAnSBvbiAke3Iuc2x1Z30uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5hZGRlZFwiLFxuICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgIG5vdGU6IHIubm90ZS5pZCxcbiAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgcXVvdGU6IHIubm90ZS5xdW90ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGVzXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubm90ZXNPZih7IGRvYzogY21kLmRvYywgLi4uKGNtZC5hbGwgPyB7IGFsbDogdHJ1ZSB9IDoge30pIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZXM6IHIubm90ZXMgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnJlbW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnJlbW92ZVRhc2soY21kLmlkKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgcmVtb3ZlZDogdHJ1ZSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2tzLmNsZWFyXCI6IHtcbiAgICAgICAgY29uc3QgY2xlYXJlZCA9IHNlc3Npb24uY2xlYXJEb25lVGFza3MoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgY2xlYXJlZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIndvcmtpbmdcIjoge1xuICAgICAgICAvLyBFNTMncyBzbm9vemUuIEl0IGRvZXMgTk9UIHBvc3QgdG8gdGhlIGNoYXQ6IGFuIGFnZW50IHNheWluZyBcInN0aWxsXG4gICAgICAgIC8vIHdvcmtpbmdcIiBpbiB0aGUgY29udmVyc2F0aW9uIGlzIGEgcmVwbHksIGFuZCBpdCBjYW4gZG8gdGhhdCB3aXRoXG4gICAgICAgIC8vIGBzYXlgIOKAlCB0aGlzIGlzIHRoZSBxdWlldGVyIHRoaW5nLCBmb3Igd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvXG4gICAgICAgIC8vIHJlcG9ydCB5ZXQgYnV0IHRoZSBhbGFybSBzaG91bGQgc3RvcC5cbiAgICAgICAgY29uc3QgbXMgPSBjbWQuc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8gY21kLnNlY29uZHMgKiAxMDAwIDogREVGQVVMVF9TTk9PWkVfTVM7XG4gICAgICAgIGFja25vd2xlZGdlZFVudGlsID0gRGF0ZS5ub3coKSArIE1hdGgubWF4KDAsIG1zKTtcbiAgICAgICAgLy8gV2hhdGV2ZXIgaXMgcGVuZGluZyBpcyBhY2tub3dsZWRnZWQsIHNvIGl0IG11c3QgbmV2ZXIgYmUgbnVkZ2VkIGFnYWluLlxuICAgICAgICBjb25zdCB3ID0gd2FpdGluZ09uKHNlc3Npb24ubWVzc2FnZXMoKSwgRGF0ZS5ub3coKSwgeyBhY2tub3dsZWRnZWRVbnRpbCB9KTtcbiAgICAgICAgaWYgKHcpIG51ZGdlZC5hZGQody5tZXNzYWdlSWQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHVudGlsOiBhY2tub3dsZWRnZWRVbnRpbCxcbiAgICAgICAgICBzZWNvbmRzOiBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIG1zKSAvIDEwMDApLFxuICAgICAgICAgIC4uLih3ID8geyB3YWl0aW5nOiB3Lm1lc3NhZ2VJZCB9IDoge30pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suc3RhcnRcIjoge1xuICAgICAgICBjb25zdCB0ID0gc2Vzc2lvbi5zdGFydFRhc2soY21kLnRleHQsIFwiYWdlbnRcIik7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJ0YXNrLnN0YXJ0ZWRcIiwgdGFzazogdC5pZCwgdGV4dDogdC50ZXh0LCBieTogXCJhZ2VudFwiIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiB0LmlkLCB0ZXh0OiB0LnRleHQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0YXNrLnN0YXR1c1wiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBzZXNzaW9uLnNldFRhc2tTdGF0dXMoY21kLmlkLCBjbWQuc3RhdHVzKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgdGFzazogdC5pZCwgc3RhdHVzOiB0LnN0YXR1cyB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInRhc2suZG9uZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmZpbmlzaFRhc2soY21kLmlkLCBjbWQub3V0Y29tZSk7XG4gICAgICAgIGlmICghci5hbHJlYWR5KVxuICAgICAgICAgIGFubm91bmNlKGBEb25lOiAke3IudGFzay50ZXh0fSR7ci50YXNrLm91dGNvbWUgPyBgIOKAlCAke3IudGFzay5vdXRjb21lfWAgOiBcIlwifWAsIHtcbiAgICAgICAgICAgIGZhY3Q6IFwidGFzay5kb25lXCIsXG4gICAgICAgICAgICB0YXNrOiByLnRhc2suaWQsXG4gICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyB0YXNrOiByLnRhc2suaWQsIGFscmVhZHk6IHIuYWxyZWFkeSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcIm5vdGUuZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXROb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkLCBib2R5OiBjbWQuYm9keSB9KTtcbiAgICAgICAgYW5ub3VuY2UoYEFnZW50IHJld3JvdGUgYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm5vdGUuZWRpdGVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZXNvbHZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVzb2x2ZU5vdGUoeyBkb2M6IGNtZC5kb2MsIGlkOiBjbWQuaWQsIHJlc29sdmVkOiBjbWQucmVzb2x2ZWQgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCAke2NtZC5yZXNvbHZlZCA/IFwicmVzb2x2ZWRcIiA6IFwicmVvcGVuZWRcIn0gYSBub3RlIG9uICR7ci5zbHVnfTog4oCcJHtxdW90ZUxhYmVsKHIubm90ZS5xdW90ZSl94oCdLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm5vdGUucmVzb2x2ZWRcIiwgZG9jOiByLnNsdWcsIG5vdGU6IHIubm90ZS5pZCwgYnk6IFwiYWdlbnRcIiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkLCByZXNvbHZlZDogci5ub3RlLnJlc29sdmVkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibm90ZS5yZW1vdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZW1vdmVOb3RlKHsgZG9jOiBjbWQuZG9jLCBpZDogY21kLmlkIH0pO1xuICAgICAgICBhbm5vdW5jZShgQWdlbnQgcmVtb3ZlZCBhIG5vdGUgb24gJHtyLnNsdWd9OiDigJwke3F1b3RlTGFiZWwoci5ub3RlLnF1b3RlKX3igJ0uYCwge1xuICAgICAgICAgIGZhY3Q6IFwibm90ZS5yZW1vdmVkXCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgbm90ZTogci5ub3RlLmlkLFxuICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1Zywgbm90ZTogci5ub3RlLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiZGlmZlwiOiB7XG4gICAgICAgIGNvbnN0IHAgPSBzZXNzaW9uLmNvbXBhcmUoeyBkb2M6IGNtZC5kb2MsIGFnYWluc3Q6IGNtZC5hZ2FpbnN0IH0pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRvYzogcC5kb2MsXG4gICAgICAgICAgYWN0aXZlOiBwLmFjdGl2ZSxcbiAgICAgICAgICBhZ2FpbnN0OiBwLmFnYWluc3QsXG4gICAgICAgICAgc2FtZTogcC5kaWZmLnNhbWUsXG4gICAgICAgICAgY29hcnNlOiBwLmRpZmYuY29hcnNlLFxuICAgICAgICAgIGh1bmtzOiBwLmRpZmYuaHVua3MsXG4gICAgICAgICAgdW5pZmllZDogdW5pZmllZChwLmRpZmYsIHtcbiAgICAgICAgICAgIGZyb206IGB2JHtwLmFjdGl2ZX1gLFxuICAgICAgICAgICAgdG86IHNpZGVOYW1lKHAuYWdhaW5zdCwgc2Vzc2lvbi5kb2MocC5kb2MpLm5hbWUpLFxuICAgICAgICAgICAgLi4uKGNtZC5jb250ZXh0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgY29udGV4dDogY21kLmNvbnRleHQgfSksXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwibWVyZ2VcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5tZXJnZSh7IGRvYzogY21kLmRvYywgYWdhaW5zdDogY21kLmFnYWluc3QsIGh1bmtzOiBjbWQuaHVua3MgfSk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiByLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgdG9vayAke3IuYXBwbGllZH0gY2hhbmdlJHtyLmFwcGxpZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGZyb20gJHtzaWRlTmFtZShjbWQuYWdhaW5zdCwgc2Vzc2lvbi5kb2Moci5zbHVnKS5uYW1lKX0gaW50byB2JHtyLnZlcnNpb259IG9mICR7ci5zbHVnfS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJtZXJnZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbiwgaHVua3M6IGNtZC5odW5rcywgYnk6IFwiYWdlbnRcIiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLCBhcHBsaWVkOiByLmFwcGxpZWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmaW5kXCI6XG4gICAgICAgIHJldHVybiBzZXNzaW9uLmZpbmQoY21kLmZpbHRlcik7XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCBhZGRlZCA9IGFkZFBhdGhzKGNtZC5wYXRocyk7XG4gICAgICAgIHJldHVybiB7IGVudHJpZXM6IGFkZGVkLm1hcCgoYSkgPT4gKHsgLi4uYS5lbnRyeSwgYWRkZWQ6IGEuYWRkZWQgfSkpIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDc6IHRoZSBhZ2VudCBtYXkgbmFtZSBhIGRvYyB0aGUgaHVtYW4gaGFzIG5vdFxuICAgICAgICAvLyBvcGVuZWQsIGJ5IEFCU09MVVRFIHBhdGggKHRoZSBDTEkgcmVzb2x2ZXMgaXQgYWdhaW5zdCBpdHMgb3duIGN3ZCk7XG4gICAgICAgIC8vIGl0IGlzIG9wZW5lZCBpbXBsaWNpdGx5IHVuZGVyIHRoZSBzYW1lIGFkbWlzc2lvbiBydWxlIGFzIHRoZVxuICAgICAgICAvLyBzdXJmYWNlJ3MgYG9wZW5gIOKAlCBhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSDigJQgd2l0aG91dFxuICAgICAgICAvLyBtb3ZpbmcgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICAgICAgaWYgKGNtZC5kb2MgJiYgaXNBYnNvbHV0ZShjbWQuZG9jKSAmJiAhc2Vzc2lvbi5maW5kRG9jKGNtZC5kb2MpKSB7XG4gICAgICAgICAgY29uc3QgbyA9IHNlc3Npb24ub3BlblBhdGgoY21kLmRvYywgeyBmb2N1czogZmFsc2UgfSk7XG4gICAgICAgICAgaWYgKG8uY3JlYXRlZClcbiAgICAgICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJkb2Mub3BlbmVkXCIsXG4gICAgICAgICAgICAgIGRvYzogby5zbHVnLFxuICAgICAgICAgICAgICBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoby5zbHVnKSxcbiAgICAgICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBmcm9tOiBjbWQuZnJvbSxcbiAgICAgICAgICBsYWJlbDogY21kLmxhYmVsLFxuICAgICAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IGNyZWF0ZWQgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7Y21kLmxhYmVsID8gYCDigJQgJHtjbWQubGFiZWx9YCA6IFwiXCJ9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4gfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uLCBmcm9tOiByLnZlcnNpb24uZnJvbSwgcGF0aDogci52ZXJzaW9uLnBhdGggfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiYWdlbnRcIiwgY21kLnRleHQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBpZDogbS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIHJldHVybiBhY3RpdmF0ZShjbWQuZG9jLCBjbWQudmVyc2lvbiwgXCJhZ2VudFwiKTtcbiAgICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgICByZXR1cm4ge307XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoKGNtZCBhcyB7IHR5cGU/OiB1bmtub3duIH0pLnR5cGUpfSDigJQgbm90aGluZyB3YXMgYXBwbGllZGAsXG4gICAgICAgICAgNDAwLFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIFwiY29udGV4dC5hZGRcIixcbiAgICAgICAgICAgIFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAgIFwic2F5XCIsXG4gICAgICAgICAgICBcImFjdGl2YXRlXCIsXG4gICAgICAgICAgICBcImNsb3NlXCIsXG4gICAgICAgICAgICBcIm1ldGFcIixcbiAgICAgICAgICAgIFwiZmluZFwiLFxuICAgICAgICAgICAgXCJncmFwaFwiLFxuICAgICAgICAgICAgXCJiYWNrbGlua3NcIixcbiAgICAgICAgICAgIFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgICBcIm1ldGEuc2V0XCIsXG4gICAgICAgICAgICAuLi5TVFJVQ1RVUkVfT1BTLFxuICAgICAgICAgIF0sXG4gICAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlZnVzYWwgPSAoZTogdW5rbm93bik6IFJlc3BvbnNlID0+IHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBlLm1lc3NhZ2UsXG4gICAgICAgICAgLi4uKGUuY2hvaWNlcyA/IHsgY2hvaWNlczogZS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAgICAgLi4uKGUuaGludCA/IHsgaGludDogZS5oaW50IH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICAgIHsgc3RhdHVzOiBlLnN0YXR1cyB9LFxuICAgICAgKTtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFBhdGhFcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoZSkgfSwgeyBzdGF0dXM6IDUwMCB9KTtcbiAgfTtcblxuICBjb25zdCBldmVudHNSZXNwb25zZSA9IChyZXE6IFJlcXVlc3QsIHVybDogVVJMKTogUmVzcG9uc2UgPT4ge1xuICAgIHRvdWNoKCk7XG4gICAgcmV0dXJuIHNzZVJlc3BvbnNlKHtcbiAgICAgIGxvZyxcbiAgICAgIHNpbmNlOiBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIi0xXCIsIDEwKSxcbiAgICAgIGhlYXJ0YmVhdE1zOiBTU0VfSEVBUlRCRUFUX01TLFxuICAgICAgY2xpZW50czogc3NlQ2xpZW50cyxcbiAgICAgIHNpZ25hbDogcmVxLnNpZ25hbCxcbiAgICAgIG9uT3BlbjogdG91Y2gsXG4gICAgICBvbkNsb3NlOiB0b3VjaCxcbiAgICB9KTtcbiAgfTtcblxuICAvLyAtLS0gc2VydmUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBcIjEyNy4wLjAuMVwiLFxuICAgIHJvdXRlcyxcbiAgICBpZGxlVGltZW91dDogSURMRV9USU1FT1VUX1NFQyxcbiAgICBkZXZlbG9wbWVudDogeyBobXI6IG1vZGUgPT09IFwiZGV2XCIgfSxcbiAgICBmZXRjaChyZXEsIHNydikge1xuICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsKTtcbiAgICAgIGNvbnN0IHBhdGggPSB1cmwucGF0aG5hbWU7XG4gICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDFhIOKAlCBBIEZPUkVJR04gT1JJR0lOIElTIFJFRlVTRUQuIEFueSB3ZWIgcGFnZSB0aGVcbiAgICAgIC8vIGh1bWFuIHZpc2l0cyBjYW4gb3BlbiBhIFdlYlNvY2tldCBvciBQT1NUIHRvIDEyNy4wLjAuMTsgdGhlIGJyb3dzZXJcbiAgICAgIC8vIHNlbmRzIGl0cyBPcmlnaW4sIGFuZCBvbmx5IHRoaXMgZGFlbW9uJ3Mgb3duIHBhZ2UgbWF5IGRyaXZlIGl0LiBUaGVcbiAgICAgIC8vIENMSSdzIGZldGNoIHNlbmRzIG5vIE9yaWdpbiBhdCBhbGwsIHNvIGl0IGlzIHVuYWZmZWN0ZWQuXG4gICAgICBpZiAoXG4gICAgICAgIChwYXRoID09PSBcIi93c1wiIHx8IHBhdGggPT09IFwiL2NtZFwiIHx8IHBhdGguc3RhcnRzV2l0aChcIi9mcy9cIikpICYmXG4gICAgICAgICFzYW1lT3JpZ2luKHJlcSwgc3J2LnBvcnQpXG4gICAgICApXG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJmb3JlaWduIG9yaWdpbiByZWZ1c2VkXCIgfSwgeyBzdGF0dXM6IDQwMyB9KTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSB2aWV3U3RhdGUoKTtcbiAgICAgICAgY29uc3QgZnVsbCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZnVsbFwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAuLi5zdGF0ZSxcbiAgICAgICAgICBjaGF0OiBmdWxsID8gc3RhdGUuY2hhdCA6IHN0YXRlLmNoYXQuc2xpY2UoLTEwKSxcbiAgICAgICAgICBjaGF0VG90YWw6IHN0YXRlLmNoYXQubGVuZ3RoLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2YoKSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgICBlcG9jaDogbG9nLmVwb2NoLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2V2ZW50c1wiKSByZXR1cm4gZXZlbnRzUmVzcG9uc2UocmVxLCB1cmwpO1xuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvdmVyc2lvblwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVhZFZlcnNpb24oXG4gICAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmdldChcImRvY1wiKSA/PyBcIlwiLFxuICAgICAgICAgICAgTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwidlwiKSA/PyBcIlwiLCAxMCksXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihyKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJldHVybiByZWZ1c2FsKGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9mcy9saXN0XCIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgICBlbnRyaWVzOiBsaXN0RGlyKGV4cGFuZEhvbWUodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJwYXRoXCIpID8/IFwiflwiKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSkgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL2NtZFwiKVxuICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgLmpzb24oKVxuICAgICAgICAgIC50aGVuKChiKSA9PiB7XG4gICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgLi4uaGFuZGxlQWdlbnRDbWQoYiBhcyBBZ2VudENtZCkgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIHJldHVybiByZWZ1c2FsKGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKCgpID0+IFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBcImJhZCBqc29uXCIgfSwgeyBzdGF0dXM6IDQwMCB9KSk7XG4gICAgICBpZiAobW9kZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgIGlmIChhc3NldCkgcmV0dXJuIGFzc2V0O1xuICAgICAgfVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBlcnJvcjogXCJub3QgZm91bmRcIiB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIH0sXG4gICAgd2Vic29ja2V0OiB7XG4gICAgICBvcGVuKHdzKSB7XG4gICAgICAgIHNvY2tldHMuYWRkKHdzKTtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pKTtcbiAgICAgIH0sXG4gICAgICBtZXNzYWdlKHdzLCByYXcpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgbGV0IG1zZzogQ2xpZW50TXNnO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG1zZyA9IEpTT04ucGFyc2UoXG4gICAgICAgICAgICB0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdyksXG4gICAgICAgICAgKSBhcyBDbGllbnRNc2c7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IGJhZCBqc29uIGZyb20gYnJvd3NlcjogJHtlfVxcbmApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyh3cywgbXNnKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIEEgcmVmdXNhbCB0aGUgaHVtYW4gY2F1c2VkIChlZGl0IGEgbm9uLWFjdGl2ZSB2ZXJzaW9uLCBvcGVuIGFcbiAgICAgICAgICAvLyB2YW5pc2hlZCBmaWxlKSByZWFjaGVzIFRIRU0sIGFzIGEgY2hhdC12aXNpYmxlIHN5c3RlbSBsaW5lIHdvdWxkIGJlXG4gICAgICAgICAgLy8gdG9vIGxvdWQgZm9yIGEga2V5c3Ryb2tlIOKAlCBzbyBpdCBpcyBhbiBlcnJvciBmcmFtZSB0aGUgc3VyZmFjZSBzaG93cy5cbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgYm91bmRQb3J0ID0gc2VydmVyLnBvcnQ7XG4gIC8vIC0tLSBkaXNjb3ZlcnkgKEUxMzogc2Vzc2lvbi1KU09OLCB0aGUgb25seSBjb252ZW50aW9uIHRoYXQgY2FuIGV4cHJlc3Mgc2V2ZXJhbCkgLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgc2NyaXB0b3JpdW0tJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgY29uc3QgbGF0ZXN0RmlsZSA9IGpvaW4odG1wZGlyKCksIFwic2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25cIik7XG4gIGNvbnN0IGluZm8gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2JvdW5kUG9ydH1gLFxuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgaG9tZSxcbiAgICBkaXI6IHNlc3Npb24uZGlyLFxuICAgIG1vZGUsXG4gIH0pO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZUF0b21pYyhzZXNzaW9uRmlsZSwgaW5mbyk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGxhdGVzdEZpbGUsIGluZm8pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBkaXNjb3ZlcnkgaXMgYmVzdC1lZmZvcnQgKi9cbiAgfVxuXG4gIHN5bmNXYXRjaGVycygpO1xuICAvLyDimqAgVEhFIFNFU1NJT04gU0FZUyBXSEFUIElUUyBPV04gVElNRU9VVCBJUy4gYC0tdGltZW91dCAwYCBoYXMgYWx3YXlzIG1lYW50XG4gIC8vIFwic3RhbmQgdW50aWwgY2xvc2VkXCIgYW5kIHRoZXJlIHdhcyBubyB3YXkgdG8gY29uZmlybSBmcm9tIG91dHNpZGUgdGhhdCBhXG4gIC8vIGRhZW1vbiBoYWQgdGFrZW4gaXQg4oCUIHdoaWNoIGlzIHRoZSBraW5kIG9mIHNldHRpbmcgeW91IGZpbmQgb3V0IGFib3V0IGJ5XG4gIC8vIGxvc2luZyBhIHNlc3Npb24gYXQgdGhlIHdyb25nIG1vbWVudC5cbiAgbG9nLmVtaXQoe1xuICAgIHR5cGU6IFwicmVhZHlcIixcbiAgICBtb2RlLFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICByZXN0b3JlZDogISFvcHRzLnJlc3RvcmUsXG4gICAgaWRsZV90aW1lb3V0X3M6IG9wdHMudGltZW91dFMgPz8gMTgwMCxcbiAgfSk7XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCAyOiB3aGF0IGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLlxuICBmb3IgKGNvbnN0IGYgb2Ygc2Vzc2lvbi5yZXN0b3JlRmluZGluZ3MpXG4gICAgYW5ub3VuY2UoXG4gICAgICBmLm1pc3NpbmdcbiAgICAgICAgPyBgJHtmLm9yaWdpbmFsfSBpcyBnb25lIGZyb20gZGlzayBzaW5jZSB0aGlzIHNlc3Npb24gd2FzIGxhc3Qgb3Blbi4gU2F2ZSB3b3VsZCByZWNyZWF0ZSBpdDsgUmV2ZXJ0IGNhbm5vdCBydW4uYFxuICAgICAgICA6IGAke2Yub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIGNsb3NlZC4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggdGhlIGFjdGl2ZSB2ZXJzaW9uOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBmLmRvYywgd2hpbGVDbG9zZWQ6IHRydWUgfSxcbiAgICApO1xuXG4gIC8vIEU2Mjogb25lIGxpbmUgd2hlbiB0aGUgc2Vzc2lvbiBoYXMgc29tZXRoaW5nIHdvcnRoIGxvb2tpbmcgYXQsIGFuZCBzaWxlbmNlXG4gIC8vIHdoZW4gaXQgZG9lcyBub3QuXG4gIC8vXG4gIC8vIOKblCBBIFNVTU1BUlksIE5PVCBBIFJFUEVBVC4gVGhlIHBlci1kb2N1bWVudCBjb25mbGljdHMgYWJvdmUgc2F5IHRoZWlyIG93blxuICAvLyBwaWVjZSB3aXRoIHRoZSBTYXZlL1JldmVydCBudWFuY2U7IHRoaXMgY291bnRzIHdoYXQgaXMgdGhlcmUg4oCUIGluY2x1ZGluZ1xuICAvLyB0aGUgdGhpbmdzIHRob3NlIGxpbmVzIG5ldmVyIGNvdmVyZWQsIGxpa2UgYSBjb250ZXh0IGVudHJ5IHBvaW50aW5nIGF0XG4gIC8vIG5vdGhpbmcg4oCUIGFuZCBwb2ludHMgYXQgdGhlIHZlcmIuIEEgc3RhcnR1cCBjaGVjayB0aGF0IHJlc3RhdGVzIHdoYXQgd2FzXG4gIC8vIGp1c3Qgc2FpZCwgb3IgdGhhdCBhbm5vdW5jZXMgaXRzZWxmIHdoZW4gZXZlcnl0aGluZyBpcyBmaW5lLCBpcyBhIGxpbmVcbiAgLy8gcGVvcGxlIGxlYXJuIHRvIHNraXAuXG4gIHtcbiAgICBjb25zdCBsaXN0ID0gc2Vzc2lvbi5jaGVja3VwKCk7XG4gICAgY29uc3QgbGluZSA9IHN1bW1hcnkobGlzdCk7XG4gICAgaWYgKGxpbmUpIHtcbiAgICAgIGFubm91bmNlKGxpbmUsIHsgZmFjdDogXCJkb2N0b3JcIiwgZmluZGluZ3M6IGxpc3QubGVuZ3RoIH0pO1xuICAgICAgLy8gVGhlIGFnZW50IGdldHMgdGhlIHdob2xlIHJlcG9ydCBvbiBpdHMgdGFpbCwgc28gYW4gYWdlbnQgdGhhdCBhcnJpdmVzXG4gICAgICAvLyBsYXRlciBkb2VzIG5vdCBoYXZlIHRvIGFzayDigJQgYW5kIGRvZXMgbm90IGhhdmUgdG8gcGFyc2UgdGhlIHNlbnRlbmNlLlxuICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvY3RvclwiLCBjb3VudDogbGlzdC5sZW5ndGgsIGZpbmRpbmdzOiBsaXN0IH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBFNTMncyBhdHRlbnRpb24gdGljay4gU2VwYXJhdGUgZnJvbSBob3VzZWtlZXBpbmcgYmVjYXVzZSBpdCBpcyBhYm91dCB0aGVcbiAgICogSFVNQU4ncyBwYXRpZW5jZSByYXRoZXIgdGhhbiB0aGUgZGFlbW9uJ3MgbGlmZXRpbWUsIGFuZCBiZWNhdXNlIGl0IG11c3QgcnVuXG4gICAqIG9uIGEgc2xvd2VyIGNsb2NrOiBhIDI1MCBtcyBzd2VlcCByZS1icm9hZGNhc3Rpbmcgc3RhdGUgd291bGQgYmUgY2h1cm4gZm9yIGFcbiAgICogdmFsdWUgdGhhdCBjaGFuZ2VzIHR3aWNlIGluIGEgd2FpdC5cbiAgICovXG4gIGxldCBsYXN0V2FpdGluZzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IGF0dGVudGlvblRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHcgPSB3YWl0aW5nT24oc2Vzc2lvbi5tZXNzYWdlcygpLCBEYXRlLm5vdygpLCB7IGFja25vd2xlZGdlZFVudGlsIH0pO1xuICAgIGNvbnN0IGtleSA9IHcgPyBgJHt3Lm1lc3NhZ2VJZH06JHt3LmJhZGdlfWAgOiBudWxsO1xuICAgIGlmIChrZXkgPT09IGxhc3RXYWl0aW5nKSByZXR1cm47XG4gICAgbGFzdFdhaXRpbmcgPSBrZXk7XG4gICAgLy8gVGhlIGJhZGdlIGNoYW5nZWQsIHNvIHRoZSBzdXJmYWNlIG5lZWRzIHRoZSBuZXcgc25hcHNob3QuXG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICBpZiAoIXcpIHJldHVybjtcbiAgICBpZiAody5iYWRnZSAhPT0gXCJzdGFsbGVkXCIgfHwgbnVkZ2VkLmhhcyh3Lm1lc3NhZ2VJZCkpIHJldHVybjtcbiAgICBudWRnZWQuYWRkKHcubWVzc2FnZUlkKTtcbiAgICAvLyDim5QgVEhFIE5VREdFIEdPRVMgVE8gVEhFIEFHRU5UJ1MgVEFJTCBBTkQgTk9XSEVSRSBFTFNFLiBUaGUgaHVtYW4gYWxyZWFkeVxuICAgIC8vIHNlZXMgdGhlIGJhZGdlOyBwdXR0aW5nIHRoaXMgaW4gdGhlIGNoYXQgYXMgd2VsbCB3b3VsZCBiZSB0ZWxsaW5nIHRoZW1cbiAgICAvLyB3aGF0IHRoZXkgYXJlIGxvb2tpbmcgYXQuIEl0IGNhcnJpZXMgdGhlIG1lc3NhZ2UgVEVYVCBiZWNhdXNlIGFuIGFnZW50XG4gICAgLy8gdGhhdCBoYXMgYmVlbiBhd2F5IG5lZWRzIHRvIGtub3cgd2hhdCBpcyBwZW5kaW5nLCBub3QganVzdCB0aGF0IHNvbWV0aGluZ1xuICAgIC8vIGlzIOKAlCBhbmQgaXQgbmFtZXMgdGhlIHR3byB3YXlzIG91dCwgYmVjYXVzZSBhIG51ZGdlIHRoYXQgZG9lcyBub3Qgc2F5IGhvd1xuICAgIC8vIHRvIGFuc3dlciBpdCBpbnZpdGVzIGEgZm91cnRoIHByaW1pdGl2ZS5cbiAgICBjb25zdCBwZW5kaW5nID0gc2Vzc2lvbi5tZXNzYWdlcygpLmZpbmQoKG0pID0+IG0uaWQgPT09IHcubWVzc2FnZUlkKTtcbiAgICBsb2cuZW1pdCh7XG4gICAgICB0eXBlOiBcIndhaXRpbmdcIixcbiAgICAgIG1lc3NhZ2VfaWQ6IHcubWVzc2FnZUlkLFxuICAgICAgc2Vjb25kczogTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIHcuc2luY2UpIC8gMTAwMCksXG4gICAgICAuLi4ocGVuZGluZyA/IHsgdGV4dDogcGVuZGluZy50ZXh0IH0gOiB7fSksXG4gICAgICBoaW50OiBcInJlcGx5IHdpdGggYHNheWAsIG9yIGB3b3JraW5nYCB0byBzYXkgeW91IGFyZSBzdGlsbCBvbiBpdFwiLFxuICAgIH0pO1xuICB9LCAxMDAwKTtcblxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiAob3B0cy50aW1lb3V0UyA/PyAxODAwKSAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICB9KTtcblxuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lIOKAlCBmaW5lICovXG4gICAgfVxuICAgIHVubGlua0lmTWF0Y2hlcyhsYXRlc3RGaWxlLCBzZXNzaW9uSWQsIChyYXcpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlkID0gKEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiB1bmtub3duIH0pLnNlc3Npb25faWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGhlIG9yZGVyIGlzIHRoZSBoZWFkZXIncywgYW5kIHRoZSBoZWFkZXIgc2F5cyB3aHkuXG4gIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgICBjbGVhckludGVydmFsKGF0dGVudGlvblRpbWVyKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2F0Y2hlcnMudmFsdWVzKCkpIHcuY2xvc2UoKTtcbiAgICB3YXRjaGVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdCBvZiBwZW5kaW5nLnZhbHVlcygpKSBjbGVhclRpbWVvdXQodCk7XG4gICAgdHJ5IHtcbiAgICAgIHNlc3Npb24ucGVyc2lzdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgY2xlYW51cERpc2NvdmVyeSgpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJjbG9zZWRcIiB9KTtcbiAgICB2b2lkIGRyYWluQW5kU3RvcCh7IHNlcnZlciwgY2xpZW50czogc3NlQ2xpZW50cywgc29ja2V0cyB9KS50aGVuKHJlc29sdmVTaHV0ZG93bik7XG4gIH07XG4gIGRvbmUudGhlbigoKSA9PiBjbG9zZSgpKTtcblxuICByZXR1cm4geyBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25JZCwgbW9kZSwgZGlyOiBzZXNzaW9uLmRpciwgY2xvc2UsIGRvbmUsIHNodXRkb3duIH07XG59XG5cbi8qKiBBbiBhYnNlbnQgT3JpZ2luICh0aGUgQ0xJLCBjdXJsKSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlOyBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtZU9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBjb25zdCBvcmlnaW4gPSByZXEuaGVhZGVycy5nZXQoXCJvcmlnaW5cIik7XG4gIGlmIChvcmlnaW4gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gb3JpZ2luID09PSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCB8fCBvcmlnaW4gPT09IGBodHRwOi8vbG9jYWxob3N0OiR7cG9ydH1gO1xufVxuXG4vKipcbiAqIEEgcGF0aCB0eXBlZCBpbiB0aGUgU1VSRkFDRS4gVGhlIHBhZ2UgaGFzIG5vIHdvcmtpbmcgZGlyZWN0b3J5LCBzbyBhIHBhdGhcbiAqIGZyb20gaXQgbXVzdCBiZSBhYnNvbHV0ZSBvciBzdGFydCBhdCBgfmAg4oCUIHdoaWNoIGlzIGV4cGFuZGVkIEhFUkUuIEJlZm9yZVxuICogdGhpcywgYH4vRG9jdW1lbnRzYCByZWFjaGVkIGByZXNvbHZlKClgIGFuZCB3YXMgdGFrZW4gYXMgcmVsYXRpdmUgdG8gdGhlXG4gKiBkYWVtb24ncyBjd2QgKHRoZSBza2lsbCBmb2xkZXIpOiB0aGUgcGF0aCBib3ggY29tcGxldGVkIGB+L+KApmAgKGxpc3RpbmdcbiAqIGV4cGFuZHMgaXQpIGFuZCB0aGVuIEVudGVyIGZhaWxlZCB3aXRoIFwibm8gc3VjaCBmaWxlIG9yIGZvbGRlcjpcbiAqIOKApi9za2lsbHMvc2NyaXB0b3JpdW0vfi9Eb2N1bWVudHMv4oCmXCIgKENvbGUsIDIwMjYtMDktMTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VyZmFjZVBhdGgocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHAudHJpbSgpO1xuICBpZiAodCA9PT0gXCJ+XCIgfHwgdC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBleHBhbmRIb21lKHQpO1xuICBpZiAoIWlzQWJzb2x1dGUodCkpXG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke3B9XCIgaXMgbm90IGEgZnVsbCBwYXRoIOKAlCBzdGFydCBpdCB3aXRoIC8gb3Igfi9gLCA0MDApO1xuICByZXR1cm4gcmVzb2x2ZSh0KTtcbn1cblxuLyoqIEEgc3RydWN0dXJlIG9wIGZyb20gdGhlIHN1cmZhY2UsIHdpdGggZXZlcnkgcGF0aCBmaWVsZCB0aHJvdWdoIGBzdXJmYWNlUGF0aGAuICovXG5mdW5jdGlvbiBhbmNob3JTdXJmYWNlUGF0aHMob3A6IFN0cnVjdHVyZU9wKTogU3RydWN0dXJlT3Age1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5vcCB9O1xuICBmb3IgKGNvbnN0IGsgb2YgW1wiZGlyXCIsIFwicGF0aFwiLCBcImludG9cIl0gYXMgY29uc3QpXG4gICAgaWYgKHR5cGVvZiBvdXRba10gPT09IFwic3RyaW5nXCIpIG91dFtrXSA9IHN1cmZhY2VQYXRoKG91dFtrXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gb3V0IGFzIFN0cnVjdHVyZU9wO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB3b3Jrc3BhY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgICAgd29ya3NwYWNlOiBmbGFncy53b3Jrc3BhY2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IGEgY2xlYW4gY2xvc2UgbGVhdmVzIG5vIGVtcHR5IGxvZyBiZWhpbmQuXG4gIGlmIChyZXMuY29kZSA9PT0gMCAmJiBmbGFncy5sb2cpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHN0YXRTeW5jKGZsYWdzLmxvZykuc2l6ZSA9PT0gMCkgdW5saW5rU3luYyhmbGFncy5sb2cpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG4gIHJldHVybiByZXMuY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGVcbiAqIGJ1bmRsZSwgc28gdGhlcmUgaXMgbm8gc3VjaCBibG9jayBoZXJlLCBhbmQgdGhpcyB0YWtlcyBubyBhcmd1bWVudHM6IHRoZVxuICogY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8vIEZpbmRpbmcgd2hlcmUgYSBub3RlIGJlbG9uZ3MsIGluIGEgZG9jdW1lbnQgdGhhdCBoYXMgbW92ZWQgdW5kZXIgaXQgKEU0NSkuXG4vL1xuLy8g4puUIFFVT1RFRC1URVhUIEFOQ0hPUklORywgQU5EIFRIRSBBTFRFUk5BVElWRSBJUyBXSFkuIEFuIG9mZnNldCBnb2VzIHN0YWxlIG9uXG4vLyB0aGUgbmV4dCBrZXlzdHJva2U6IGZpeCBhIHR5cG8gdGhyZWUgbGluZXMgdXAgYW5kIGV2ZXJ5IG5vdGUgYmVsb3cgcG9pbnRzIGF0XG4vLyB0aGUgd3Jvbmcgd29yZHMuIFBpbm5pbmcgYSBub3RlIHRvIHRoZSBWRVJTSU9OIGl0IHdhcyBtYWRlIG9uIHdvdWxkIGJlIGV4YWN0XG4vLyBmb3JldmVyIGFuZCB1c2VsZXNzIOKAlCB0aGUgc3RhdGVkIHVzZSBpcyBtYWtpbmcgbm90ZXMgV0hJTEUgcmVhZGluZyBhbmRcbi8vIGVkaXRpbmcsIGFuZCBhIG5vdGUgdGhhdCBkZXRhY2hlcyB0aGUgbW9tZW50IHlvdSBlZGl0IGlzIGEgbm90ZSB5b3UgY2Fubm90XG4vLyB1c2UuIFNvIGEgbm90ZSByZW1lbWJlcnMgdGhlIFRFWFQgaXQgd2FzIG1hZGUgb24sIHBsdXMgYSBsaXR0bGUgb2Ygd2hhdFxuLy8gc3Vycm91bmRlZCBpdCwgYW5kIGlzIHJlLWZvdW5kIG9uIGV2ZXJ5IHJlYWQgKENvbGUgYXBwcm92ZWQgdGhlIHRyYWRlOiBcIndlXG4vLyB0ZXN0IGl0IG91dCBhbmQgc2VlIGlmIGl0IHdvcmtzIGFuZCBhZGp1c3QgYXMgbmVlZGVkXCIpLlxuLy9cbi8vIOKblCBBTkQgSVQgU0FZUyBXSEVOIElUIEhBUyBMT1NULiBUaGUgZm91cnRoIG91dGNvbWUgaXMgT1JQSEFORUQg4oCUIHRoZSBxdW90ZSBpc1xuLy8gZ29uZSBhbmQgdGhlIG5vdGUgaXMgc2hvd24gZGV0YWNoZWQgcmF0aGVyIHRoYW4gcGlubmVkIHNvbWV3aGVyZSBwbGF1c2libGUuXG4vLyBWaXNpYmxlLWFuZC13cm9uZyBiZWF0cyBpbnZpc2libGUtYW5kLXdyb25nOyBhIG5vdGUgc2lsZW50bHkgcmUtYW5jaG9yZWQgb250b1xuLy8gdW5yZWxhdGVkIHdvcmRzIGlzIHRoZSBmYWlsdXJlIHRoaXMgZGVzaWduIGV4aXN0cyB0byBhdm9pZC5cblxuLyoqIEhvdyBtdWNoIHRleHQgZWl0aGVyIHNpZGUgaXMga2VwdCwgdG8gdGVsbCBpZGVudGljYWwgcXVvdGVzIGFwYXJ0LiAqL1xuZXhwb3J0IGNvbnN0IENPTlRFWFRfQ0hBUlMgPSA0ODtcblxuLyoqIFdoYXQgYSBub3RlIHJlbWVtYmVycyBhYm91dCB3aGVyZSBpdCB3YXMgbWFkZS4gKi9cbmV4cG9ydCB0eXBlIEFuY2hvciA9IHtcbiAgLyoqIFRoZSB0ZXh0IHRoZSBub3RlIHdhcyBtYWRlIG9uLiBFbXB0eSBtZWFucyB0aGUgbm90ZSBpcyBhYm91dCB0aGUgZG9jdW1lbnQuICovXG4gIHF1b3RlOiBzdHJpbmc7XG4gIC8qKiBUaGUgY2hhcmFjdGVycyBpbW1lZGlhdGVseSBiZWZvcmUgYW5kIGFmdGVyIHRoZSBxdW90ZSwgd2hlbiBpdCB3YXMgbWFkZS4gKi9cbiAgYmVmb3JlOiBzdHJpbmc7XG4gIGFmdGVyOiBzdHJpbmc7XG4gIC8qKiBXaGVyZSBpdCB3YXMgdGhlbiDigJQgYSBISU5UIGZvciBjaG9vc2luZyBiZXR3ZWVuIGlkZW50aWNhbCBxdW90ZXMsIG5ldmVyIGEgc291cmNlIG9mIHRydXRoLiAqL1xuICBhdDogbnVtYmVyO1xufTtcblxuLyoqIFdoZXJlIGEgbm90ZSBiZWxvbmdzIG5vdywgYW5kIGhvdyBzdXJlIHdlIGFyZS4gKi9cbmV4cG9ydCB0eXBlIEZvdW5kID1cbiAgfCB7IGZyb206IG51bWJlcjsgdG86IG51bWJlcjsgaG93OiBcImNvbnRleHRcIiB8IFwidW5pcXVlXCIgfCBcIm5lYXJlc3RcIiB9XG4gIHwgeyBmcm9tOiBudWxsOyB0bzogbnVsbDsgaG93OiBcIm9ycGhhbmVkXCIgfTtcblxuY29uc3QgT1JQSEFORUQ6IEZvdW5kID0geyBmcm9tOiBudWxsLCB0bzogbnVsbCwgaG93OiBcIm9ycGhhbmVkXCIgfTtcblxuLyoqIFRha2UgYW4gYW5jaG9yIGZyb20gYSBzZWxlY3Rpb24g4oCUIHdoYXQgdGhlIG5vdGUgd2lsbCByZW1lbWJlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbmNob3JPZih0ZXh0OiBzdHJpbmcsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IEFuY2hvciB7XG4gIHJldHVybiB7XG4gICAgcXVvdGU6IHRleHQuc2xpY2UoZnJvbSwgdG8pLFxuICAgIGJlZm9yZTogdGV4dC5zbGljZShNYXRoLm1heCgwLCBmcm9tIC0gQ09OVEVYVF9DSEFSUyksIGZyb20pLFxuICAgIGFmdGVyOiB0ZXh0LnNsaWNlKHRvLCB0byArIENPTlRFWFRfQ0hBUlMpLFxuICAgIGF0OiBmcm9tLFxuICB9O1xufVxuXG4vKiogRXZlcnkgaW5kZXggYXQgd2hpY2ggYG5lZWRsZWAgb2NjdXJzIGluIGBoYXlgLCBpbmNsdWRpbmcgb3ZlcmxhcHMuICovXG5mdW5jdGlvbiBvY2N1cnJlbmNlcyhoYXk6IHN0cmluZywgbmVlZGxlOiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGlmIChuZWVkbGUgPT09IFwiXCIpIHJldHVybiBbXTtcbiAgY29uc3QgZm91bmQ6IG51bWJlcltdID0gW107XG4gIGxldCBpID0gaGF5LmluZGV4T2YobmVlZGxlKTtcbiAgd2hpbGUgKGkgIT09IC0xKSB7XG4gICAgZm91bmQucHVzaChpKTtcbiAgICBpID0gaGF5LmluZGV4T2YobmVlZGxlLCBpICsgMSk7XG4gIH1cbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKipcbiAqIFdoZXJlIHRoZSBub3RlIGJlbG9uZ3MgaW4gYHRleHRgIG5vdy5cbiAqXG4gKiBGb3VyIGFuc3dlcnMsIHRyaWVkIGluIG9yZGVyLCBhbmQgZWFjaCBzYXlzIGhvdyBpdCB3YXMgcmVhY2hlZCBzbyB0aGUgc3VyZmFjZVxuICogY2FuIHNob3cgYSByZS1hbmNob3JlZCBub3RlIGRpZmZlcmVudGx5IGZyb20gYSBjZXJ0YWluIG9uZTpcbiAqXG4gKiAxLiAqKmNvbnRleHQqKiDigJQgdGhlIHF1b3RlIFdJVEggaXRzIHN1cnJvdW5kaW5ncyBvY2N1cnMgZXhhY3RseSBvbmNlLiBUaGVcbiAqICAgIHN0cm9uZ2VzdCBhbnN3ZXI6IHR3byBpZGVudGljYWwgc2VudGVuY2VzIGFyZSB0b2xkIGFwYXJ0IGJ5IHdoYXQgaXNcbiAqICAgIGFyb3VuZCB0aGVtLlxuICogMi4gKip1bmlxdWUqKiDigJQgdGhlIHF1b3RlIG9jY3VycyBleGFjdGx5IG9uY2UuIEl0cyBzdXJyb3VuZGluZ3MgY2hhbmdlZCwgdGhlXG4gKiAgICB0ZXh0IGRpZCBub3QuXG4gKiAzLiAqKm5lYXJlc3QqKiDigJQgdGhlIHF1b3RlIG9jY3VycyBzZXZlcmFsIHRpbWVzOyB0aGUgb25lIGNsb3Nlc3QgdG8gd2hlcmUgaXRcbiAqICAgIHVzZWQgdG8gYmUgd2lucy4gQSBndWVzcywgYW5kIGxhYmVsbGVkIGFzIG9uZS5cbiAqIDQuICoqb3JwaGFuZWQqKiDigJQgdGhlIHF1b3RlIGlzIGdvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQW5jaG9yKHRleHQ6IHN0cmluZywgYW5jaG9yOiBBbmNob3IpOiBGb3VuZCB7XG4gIGlmIChhbmNob3IucXVvdGUgPT09IFwiXCIpIHJldHVybiBPUlBIQU5FRDtcblxuICAvLyAxLiBXaXRoIGNvbnRleHQuIFRoZSByZWNvcmRlZCBjb250ZXh0IG1heSBpdHNlbGYgYmUgY2xpcHBlZCBhdCBhIGRvY3VtZW50XG4gIC8vICAgIGVkZ2UsIHNvIHRoZSB3aG9sZSBydW4gaXMgc2VhcmNoZWQgcmF0aGVyIHRoYW4gYXNzZW1ibGVkIGJsaW5kbHkuXG4gIGNvbnN0IHdpdGhDb250ZXh0ID0gYW5jaG9yLmJlZm9yZSArIGFuY2hvci5xdW90ZSArIGFuY2hvci5hZnRlcjtcbiAgY29uc3QgY29udGV4dHMgPSBvY2N1cnJlbmNlcyh0ZXh0LCB3aXRoQ29udGV4dCk7XG4gIGlmIChjb250ZXh0cy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCBmcm9tID0gKGNvbnRleHRzWzBdIGFzIG51bWJlcikgKyBhbmNob3IuYmVmb3JlLmxlbmd0aDtcbiAgICByZXR1cm4geyBmcm9tLCB0bzogZnJvbSArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJjb250ZXh0XCIgfTtcbiAgfVxuXG4gIGNvbnN0IGhpdHMgPSBvY2N1cnJlbmNlcyh0ZXh0LCBhbmNob3IucXVvdGUpO1xuICBpZiAoaGl0cy5sZW5ndGggPT09IDApIHJldHVybiBPUlBIQU5FRDtcblxuICAvLyAyLiBUaGUgcXVvdGUgYWxvbmUsIG9uY2UuXG4gIGlmIChoaXRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IGZyb20gPSBoaXRzWzBdIGFzIG51bWJlcjtcbiAgICByZXR1cm4geyBmcm9tLCB0bzogZnJvbSArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJ1bmlxdWVcIiB9O1xuICB9XG5cbiAgLy8gMy4gU2V2ZXJhbCDigJQgdGFrZSB0aGUgb25lIG5lYXJlc3Qgd2hlcmUgaXQgd2FzLiBgYXRgIGlzIGEgaGludCwgd2hpY2ggaXNcbiAgLy8gICAgd2h5IHRoaXMgYW5zd2VyIGlzIGxhYmVsbGVkOiB0aGUgbm90ZSBtYXkgaGF2ZSBsYW5kZWQgb24gYSB0d2luLlxuICBsZXQgYmVzdCA9IGhpdHNbMF0gYXMgbnVtYmVyO1xuICBmb3IgKGNvbnN0IGhpdCBvZiBoaXRzKSBpZiAoTWF0aC5hYnMoaGl0IC0gYW5jaG9yLmF0KSA8IE1hdGguYWJzKGJlc3QgLSBhbmNob3IuYXQpKSBiZXN0ID0gaGl0O1xuICByZXR1cm4geyBmcm9tOiBiZXN0LCB0bzogYmVzdCArIGFuY2hvci5xdW90ZS5sZW5ndGgsIGhvdzogXCJuZWFyZXN0XCIgfTtcbn1cblxuLyoqIEEgb25lLWxpbmUgdmVyc2lvbiBvZiB0aGUgcXVvdGUsIGZvciBhIGxpc3QgdGhhdCBjYW5ub3Qgc2hvdyBhbGwgb2YgaXQuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVMYWJlbChxdW90ZTogc3RyaW5nLCBtYXggPSA2MCk6IHN0cmluZyB7XG4gIGNvbnN0IGZsYXQgPSBxdW90ZS5yZXBsYWNlKC9cXHMrL2d1LCBcIiBcIikudHJpbSgpO1xuICByZXR1cm4gZmxhdC5sZW5ndGggPD0gbWF4ID8gZmxhdCA6IGAke2ZsYXQuc2xpY2UoMCwgbWF4IC0gMSkudHJpbUVuZCgpfeKApmA7XG59XG4iLAogICAgIi8vIENvbXBhcmluZyB0d28gdGV4dHMsIGFuZCB0YWtpbmcgcGFydCBvZiBvbmUgaW50byB0aGUgb3RoZXIgKEUzNikuXG4vL1xuLy8g4puUIE9ORSBESUZGLCBDT01QVVRFRCBJTiBUSEUgREFFTU9OLiBgQGNvZGVtaXJyb3IvbWVyZ2VgIHdhcyBtZWFzdXJlZCBmaXJzdFxuLy8gYW5kIGl0IGlzIGJ1bmRsZS1jbGVhbiDigJQgaXRzIG9ubHkgZGVwZW5kZW5jaWVzIGFyZSBgQGNvZGVtaXJyb3IvbGFuZ3VhZ2VgLFxuLy8gYHN0YXRlYCwgYHZpZXdgIGFuZCBgQGxlemVyL2hpZ2hsaWdodGAsIGV2ZXJ5IG9uZSBvZiB3aGljaCB0aGUgc3VyZmFjZVxuLy8gYWxyZWFkeSBzaGlwcywgc28gd2FyZCAxYiBoYXMgbm90aGluZyB0byBzYXkgYWJvdXQgaXQuIEl0IGlzIG5vdCB1c2VkXG4vLyBhbnl3YXksIGFuZCB0aGUgcmVhc29uIGlzIG5vdCB3ZWlnaHQ6IGl0IHdvdWxkIGdpdmUgdGhlIFNVUkZBQ0UgaXRzIG93blxuLy8gZGlmZiB3aGlsZSB0aGUgYGRpZmZgIENMSSB2ZXJiIHVzZWQgdGhpcyBtb2R1bGUncywgYW5kIGEgaHVuayB0aGUgaHVtYW5cbi8vIGFjY2VwdHMgd291bGQgdGhlbiBiZSBhIGh1bmsgYSBkaWZmZXJlbnQgZW5naW5lIGZvdW5kLiBUd28gZGlmZiBlbmdpbmVzIG92ZXJcbi8vIG9uZSBkb2N1bWVudCBpcyB0aGUgbG9ja3N0ZXAtbWlycm9yIGRyaWZ0IHRoaXMgcmVwbyBoYXMgYWxyZWFkeSBwYWlkIGZvclxuLy8gb25jZS4gVGhlIHN1cmZhY2UgcmVuZGVycyB0aGUgaHVua3MgdGhlIGRhZW1vbiBjb21wdXRlZCwgYW5kIGBtZXJnZWAgYXBwbGllc1xuLy8gdGhlIHNhbWUgb25lcyDigJQgc28gYSBtaXNtYXRjaCBpcyBub3QgYSBidWcgdGhhdCBjYW4gYmUgd3JpdHRlbiBoZXJlLlxuLy9cbi8vIFdoYXQgdGhpcyBkZWxpYmVyYXRlbHkgaXMgbm90OiBhIHNlbWFudGljIG9yIHN5bnRhY3RpYyBkaWZmLiBJdCBjb21wYXJlc1xuLy8gTElORVMsIHRoZW4gcmVmaW5lcyBpbnNpZGUgcGFpcmVkIGxpbmVzIGJ5IFdPUkQsIHdoaWNoIGlzIHdoYXQgYSBwcm9zZVxuLy8gcmVhZGVyIHdhbnRzIOKAlCBtb3ZlZCBwYXJhZ3JhcGhzIHJlYWQgYXMgYSBkZWxldGUgYW5kIGFuIGFkZCwgYW5kIHRoYXQgaXNcbi8vIHRoZSBob25lc3QgYW5zd2VyIHJhdGhlciB0aGFuIGEgd3JvbmcgY2xldmVyIG9uZS5cbmltcG9ydCB0eXBlIHsgRGlmZiwgRGlmZkh1bmssIERpZmZMaW5lLCBEaWZmU3BhbiB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKlxuICogU3BsaXR0aW5nIG9uIFwiXFxuXCIgYW5kIGpvaW5pbmcgb24gXCJcXG5cIiByb3VuZC10cmlwcyBleGFjdGx5LCBJTkNMVURJTkcgdGhlXG4gKiB0cmFpbGluZyBlbXB0eSBzdHJpbmcgYSBmaWxlIGVuZGluZyBpbiBhIG5ld2xpbmUgcHJvZHVjZXMuIFRoYXQgZW1wdHkgbGluZVxuICogaXMgcmVhbCBhcyBmYXIgYXMgdGhpcyBtb2R1bGUgaXMgY29uY2VybmVkLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgbWVyZ2UgZnJvbVxuICogcXVpZXRseSBhZGRpbmcgb3IgZHJvcHBpbmcgYSBmaW5hbCBuZXdsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjYXAgb24gTXllcnMnIEQg4oCUIHRoZSBudW1iZXIgb2YgZWRpdHMgaXQgd2lsbCB3YWxrIGJlZm9yZSBnaXZpbmcgdXAuXG4gKiBUd28gdGV4dHMgZGlmZmVyaW5nIGJ5IG1vcmUgdGhhbiB0aGlzIGFyZSBub3Qgc29tZXRoaW5nIGEgaHVtYW4gcmVhZHMgaHVua1xuICogYnkgaHVuayBhbnl3YXksIGFuZCB0aGUgcXVhZHJhdGljIHdvcnN0IGNhc2UgaXMgd2hhdCB0aGUgY2FwIGV4aXN0cyB0byBrZWVwXG4gKiBvdXQgb2YgYSBkYWVtb24gc2VydmluZyBhIHN1cmZhY2UuXG4gKi9cbmNvbnN0IE1BWF9FRElUUyA9IDMwMDA7XG5cbi8qKlxuICogTXllcnMnIGdyZWVkeSBPKE5EKSBkaWZmIG92ZXIgbGluZXMuIFJldHVybnMgdGhlIHRyYWNlIG9mIFYgYXJyYXlzLCBvciBudWxsXG4gKiB3aGVuIHRoZSB0ZXh0cyBkaWZmZXIgYnkgbW9yZSB0aGFuIGBNQVhfRURJVFNgLlxuICovXG5mdW5jdGlvbiBteWVyc1RyYWNlKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IEludDMyQXJyYXlbXSB8IG51bGwge1xuICBjb25zdCBuID0gYS5sZW5ndGg7XG4gIGNvbnN0IG0gPSBiLmxlbmd0aDtcbiAgY29uc3QgbWF4ID0gTWF0aC5taW4obiArIG0sIE1BWF9FRElUUyk7XG4gIGNvbnN0IHNpemUgPSAyICogbWF4ICsgMTtcbiAgY29uc3Qgb2Zmc2V0ID0gbWF4O1xuICBsZXQgdiA9IG5ldyBJbnQzMkFycmF5KHNpemUpO1xuICBjb25zdCB0cmFjZTogSW50MzJBcnJheVtdID0gW107XG4gIGZvciAobGV0IGQgPSAwOyBkIDw9IG1heDsgZCsrKSB7XG4gICAgdHJhY2UucHVzaCh2LnNsaWNlKCkpO1xuICAgIGZvciAobGV0IGsgPSAtZDsgayA8PSBkOyBrICs9IDIpIHtcbiAgICAgIC8vIFRha2UgdGhlIGxvbmdlciBvZiB0aGUgdHdvIHJlYWNoYWJsZSBwYXRoczogZG93biAoYW4gaW5zZXJ0aW9uKSB3aGVuXG4gICAgICAvLyBrIGlzIGF0IHRoZSBsb3dlciBlZGdlIG9yIHRoZSBkb3duLW5laWdoYm91ciBoYXMgY29tZSBmdXJ0aGVyLlxuICAgICAgY29uc3QgZG93biA9IHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcjtcbiAgICAgIGNvbnN0IHJpZ2h0ID0gdltvZmZzZXQgKyBrIC0gMV0gYXMgbnVtYmVyO1xuICAgICAgbGV0IHg6IG51bWJlcjtcbiAgICAgIGlmIChrID09PSAtZCB8fCAoayAhPT0gZCAmJiByaWdodCA8IGRvd24pKSB4ID0gZG93bjtcbiAgICAgIGVsc2UgeCA9IHJpZ2h0ICsgMTtcbiAgICAgIGxldCB5ID0geCAtIGs7XG4gICAgICB3aGlsZSAoeCA8IG4gJiYgeSA8IG0gJiYgYVt4XSA9PT0gYlt5XSkge1xuICAgICAgICB4Kys7XG4gICAgICAgIHkrKztcbiAgICAgIH1cbiAgICAgIHZbb2Zmc2V0ICsga10gPSB4O1xuICAgICAgaWYgKHggPj0gbiAmJiB5ID49IG0pIHJldHVybiB0cmFjZTtcbiAgICB9XG4gICAgdiA9IHYuc2xpY2UoKTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdhbGsgdGhlIHRyYWNlIGJhY2t3YXJkcyBpbnRvIGEgbGlzdCBvZiBsaW5lIG9wZXJhdGlvbnMsIGZyb250IHRvIGJhY2suICovXG5mdW5jdGlvbiBiYWNrdHJhY2soYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdLCB0cmFjZTogSW50MzJBcnJheVtdKTogRGlmZkxpbmVbXSB7XG4gIGNvbnN0IG9mZnNldCA9IE1hdGgubWluKGEubGVuZ3RoICsgYi5sZW5ndGgsIE1BWF9FRElUUyk7XG4gIGNvbnN0IG91dDogRGlmZkxpbmVbXSA9IFtdO1xuICBsZXQgeCA9IGEubGVuZ3RoO1xuICBsZXQgeSA9IGIubGVuZ3RoO1xuICBmb3IgKGxldCBkID0gdHJhY2UubGVuZ3RoIC0gMTsgZCA+PSAwOyBkLS0pIHtcbiAgICBjb25zdCB2ID0gdHJhY2VbZF0gYXMgSW50MzJBcnJheTtcbiAgICBjb25zdCBrID0geCAtIHk7XG4gICAgbGV0IHByZXZLOiBudW1iZXI7XG4gICAgaWYgKGsgPT09IC1kIHx8IChrICE9PSBkICYmICh2W29mZnNldCArIGsgLSAxXSBhcyBudW1iZXIpIDwgKHZbb2Zmc2V0ICsgayArIDFdIGFzIG51bWJlcikpKVxuICAgICAgcHJldksgPSBrICsgMTtcbiAgICBlbHNlIHByZXZLID0gayAtIDE7XG4gICAgY29uc3QgcHJldlggPSB2W29mZnNldCArIHByZXZLXSBhcyBudW1iZXI7XG4gICAgY29uc3QgcHJldlkgPSBwcmV2WCAtIHByZXZLO1xuICAgIHdoaWxlICh4ID4gcHJldlggJiYgeSA+IHByZXZZKSB7XG4gICAgICB4LS07XG4gICAgICB5LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcInNhbWVcIiwgYTogeCwgYjogeSwgdGV4dDogYVt4XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICAgIGlmIChkID09PSAwKSBicmVhaztcbiAgICBpZiAoeCA+IHByZXZYKSB7XG4gICAgICB4LS07XG4gICAgICBvdXQucHVzaCh7IG9wOiBcImRlbFwiLCBhOiB4LCB0ZXh0OiBhW3hdIGFzIHN0cmluZyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgeS0tO1xuICAgICAgb3V0LnB1c2goeyBvcDogXCJhZGRcIiwgYjogeSwgdGV4dDogYlt5XSBhcyBzdHJpbmcgfSk7XG4gICAgfVxuICB9XG4gIG91dC5yZXZlcnNlKCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBFdmVyeSBsaW5lIGFzIG9uZSByZXBsYWNlbWVudCDigJQgdGhlIGhvbmVzdCBhbnN3ZXIgd2hlbiBNeWVycyBnaXZlcyB1cC4gKi9cbmZ1bmN0aW9uIGNvYXJzZUxpbmVzKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IERpZmZMaW5lW10ge1xuICByZXR1cm4gW1xuICAgIC4uLmEubWFwKCh0ZXh0LCBpKSA9PiAoeyBvcDogXCJkZWxcIiBhcyBjb25zdCwgYTogaSwgdGV4dCB9KSksXG4gICAgLi4uYi5tYXAoKHRleHQsIGkpID0+ICh7IG9wOiBcImFkZFwiIGFzIGNvbnN0LCBiOiBpLCB0ZXh0IH0pKSxcbiAgXTtcbn1cblxuLyoqIEdyb3VwIHRoZSBsaW5lIG9wcyBpbnRvIGNvbnRpZ3VvdXMgaHVua3MsIG51bWJlcmVkIGZyb20gMS4gKi9cbmZ1bmN0aW9uIGNvbGxlY3QobGluZXM6IERpZmZMaW5lW10pOiBEaWZmSHVua1tdIHtcbiAgY29uc3QgaHVua3M6IERpZmZIdW5rW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICBsZXQgaWQgPSAxO1xuICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCkge1xuICAgIGlmICgobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wID09PSBcInNhbWVcIikge1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHN0YXJ0ID0gaTtcbiAgICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCAmJiAobGluZXNbaV0gYXMgRGlmZkxpbmUpLm9wICE9PSBcInNhbWVcIikgaSsrO1xuICAgIGNvbnN0IHJ1biA9IGxpbmVzLnNsaWNlKHN0YXJ0LCBpKTtcbiAgICBjb25zdCBkZWwgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImRlbFwiKTtcbiAgICBjb25zdCBhZGQgPSBydW4uZmlsdGVyKChsKSA9PiBsLm9wID09PSBcImFkZFwiKTtcbiAgICAvLyBXaGVyZSB0aGUgaHVuayBzaXRzIGluIGVhY2ggdGV4dDogdGhlIGluZGV4IG9mIHRoZSBmaXJzdCBsaW5lIGl0IHRvdWNoZXMsXG4gICAgLy8gYW5kIGZvciBhIHB1cmUgaW5zZXJ0aW9uLCB0aGUgcG9pbnQgaXQgaXMgaW5zZXJ0ZWQgQVQuXG4gICAgY29uc3QgYUZyb20gPSBkZWwubGVuZ3RoID8gKChkZWxbMF0gYXMgRGlmZkxpbmUpLmEgYXMgbnVtYmVyKSA6IG5leHRJbmRleChsaW5lcywgc3RhcnQsIFwiYVwiKTtcbiAgICBjb25zdCBiRnJvbSA9IGFkZC5sZW5ndGggPyAoKGFkZFswXSBhcyBEaWZmTGluZSkuYiBhcyBudW1iZXIpIDogbmV4dEluZGV4KGxpbmVzLCBzdGFydCwgXCJiXCIpO1xuICAgIGh1bmtzLnB1c2goe1xuICAgICAgaWQ6IGlkKyssXG4gICAgICBhRnJvbSxcbiAgICAgIGFUbzogYUZyb20gKyBkZWwubGVuZ3RoLFxuICAgICAgYkZyb20sXG4gICAgICBiVG86IGJGcm9tICsgYWRkLmxlbmd0aCxcbiAgICAgIGRlbDogZGVsLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICAgIGFkZDogYWRkLm1hcCgobCkgPT4gbC50ZXh0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gaHVua3M7XG59XG5cbi8qKlxuICogVGhlIGluZGV4IGEgcHVyZSBpbnNlcnRpb24gb3IgZGVsZXRpb24gc2l0cyBhdDogdGhlIGxpbmUgbnVtYmVyIG9mIHRoZSBuZXh0XG4gKiBgc2FtZWAgbGluZSBvbiB0aGF0IHNpZGUsIG9yIHRoZSBlbmQgb2YgdGhhdCB0ZXh0IHdoZW4gdGhlcmUgaXMgbm9uZS5cbiAqL1xuZnVuY3Rpb24gbmV4dEluZGV4KGxpbmVzOiBEaWZmTGluZVtdLCBmcm9tOiBudW1iZXIsIHNpZGU6IFwiYVwiIHwgXCJiXCIpOiBudW1iZXIge1xuICBmb3IgKGxldCBpID0gZnJvbTsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXQgPSAobGluZXNbaV0gYXMgRGlmZkxpbmUpW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gYXQ7XG4gIH1cbiAgbGV0IGxhc3QgPSAtMTtcbiAgZm9yIChjb25zdCBsIG9mIGxpbmVzKSB7XG4gICAgY29uc3QgYXQgPSBsW3NpZGVdO1xuICAgIGlmIChhdCAhPT0gdW5kZWZpbmVkICYmIGF0ID4gbGFzdCkgbGFzdCA9IGF0O1xuICB9XG4gIHJldHVybiBsYXN0ICsgMTtcbn1cblxuLyoqIFdvcmRzLCB3aGl0ZXNwYWNlIHJ1bnMgYW5kIHB1bmN0dWF0aW9uIHJ1bnMsIGtlcHQgc2VwYXJhdGUgc28gc3BhbnMgYWxpZ24uICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHMobGluZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gbGluZS5tYXRjaCgvXFxzK3xbXFxwe0x9XFxwe059X10rfFteXFxzXFxwe0x9XFxwe059X10rL2d1KSA/PyBbXTtcbn1cblxuLyoqIFRoZSB3b3JkLWxldmVsIGRpZmYgb2Ygb25lIGxpbmUgcGFpciwgYXMgc3BhbnMgb3ZlciBlYWNoIHNpZGUuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmaW5lKGJlZm9yZTogc3RyaW5nLCBhZnRlcjogc3RyaW5nKTogeyBkZWw6IERpZmZTcGFuW107IGFkZDogRGlmZlNwYW5bXSB9IHtcbiAgY29uc3QgYSA9IHdvcmRzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSB3b3JkcyhhZnRlcik7XG4gIGNvbnN0IHRyYWNlID0gbXllcnNUcmFjZShhLCBiKTtcbiAgaWYgKCF0cmFjZSlcbiAgICByZXR1cm4geyBkZWw6IFt7IHRleHQ6IGJlZm9yZSwgY2hhbmdlZDogdHJ1ZSB9XSwgYWRkOiBbeyB0ZXh0OiBhZnRlciwgY2hhbmdlZDogdHJ1ZSB9XSB9O1xuICBjb25zdCBvcHMgPSBiYWNrdHJhY2soYSwgYiwgdHJhY2UpO1xuICBjb25zdCBkZWw6IERpZmZTcGFuW10gPSBbXTtcbiAgY29uc3QgYWRkOiBEaWZmU3BhbltdID0gW107XG4gIGZvciAoY29uc3Qgb3Agb2Ygb3BzKSB7XG4gICAgaWYgKG9wLm9wID09PSBcInNhbWVcIikge1xuICAgICAgcHVzaChkZWwsIG9wLnRleHQsIGZhbHNlKTtcbiAgICAgIHB1c2goYWRkLCBvcC50ZXh0LCBmYWxzZSk7XG4gICAgfSBlbHNlIGlmIChvcC5vcCA9PT0gXCJkZWxcIikgcHVzaChkZWwsIG9wLnRleHQsIHRydWUpO1xuICAgIGVsc2UgcHVzaChhZGQsIG9wLnRleHQsIHRydWUpO1xuICB9XG4gIHJldHVybiB7IGRlbCwgYWRkIH07XG59XG5cbi8qKiBBcHBlbmQsIG1lcmdpbmcgaW50byB0aGUgcHJldmlvdXMgc3BhbiB3aGVuIGl0IGNhcnJpZXMgdGhlIHNhbWUgdmVyZGljdC4gKi9cbmZ1bmN0aW9uIHB1c2goc3BhbnM6IERpZmZTcGFuW10sIHRleHQ6IHN0cmluZywgY2hhbmdlZDogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBsYXN0ID0gc3BhbnNbc3BhbnMubGVuZ3RoIC0gMV07XG4gIGlmIChsYXN0ICYmIGxhc3QuY2hhbmdlZCA9PT0gY2hhbmdlZCkgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2Ugc3BhbnMucHVzaCh7IHRleHQsIGNoYW5nZWQgfSk7XG59XG5cbi8qKlxuICogUmVmaW5lIGEgaHVuaydzIGxpbmVzIHdoZW4gdGhleSBjYW4gYmUgUEFJUkVELiBBIGh1bmsgcmVwbGFjaW5nIHRocmVlIGxpbmVzXG4gKiB3aXRoIHRocmVlIGlzIHBhaXJlZCBsaW5lIGJ5IGxpbmU7IGEgMS1mb3ItbWFueSBodW5rIGlzIG5vdCwgYW5kIGdldHMgbm9cbiAqIHNwYW5zIHJhdGhlciB0aGFuIGFuIGFyYml0cmFyeSBwYWlyaW5nIOKAlCBzaG93aW5nIGEgd29yZC1sZXZlbCBkaWZmIGFnYWluc3RcbiAqIHRoZSB3cm9uZyBsaW5lIGlzIHdvcnNlIHRoYW4gc2hvd2luZyBub25lLlxuICovXG5mdW5jdGlvbiByZWZpbmVIdW5rKGxpbmVzOiBEaWZmTGluZVtdLCBodW5rOiBEaWZmSHVuayk6IHZvaWQge1xuICBpZiAoaHVuay5kZWwubGVuZ3RoICE9PSBodW5rLmFkZC5sZW5ndGggfHwgaHVuay5kZWwubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGRlbHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiZGVsXCIgJiYgaW5SYW5nZShsLmEsIGh1bmsuYUZyb20sIGh1bmsuYVRvKSk7XG4gIGNvbnN0IGFkZHMgPSBsaW5lcy5maWx0ZXIoKGwpID0+IGwub3AgPT09IFwiYWRkXCIgJiYgaW5SYW5nZShsLmIsIGh1bmsuYkZyb20sIGh1bmsuYlRvKSk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGVscy5sZW5ndGggJiYgaSA8IGFkZHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBkID0gZGVsc1tpXSBhcyBEaWZmTGluZTtcbiAgICBjb25zdCBhZCA9IGFkZHNbaV0gYXMgRGlmZkxpbmU7XG4gICAgY29uc3QgeyBkZWwsIGFkZCB9ID0gcmVmaW5lKGQudGV4dCwgYWQudGV4dCk7XG4gICAgZC5zcGFucyA9IGRlbDtcbiAgICBhZC5zcGFucyA9IGFkZDtcbiAgfVxufVxuXG5mdW5jdGlvbiBpblJhbmdlKGF0OiBudW1iZXIgfCB1bmRlZmluZWQsIGZyb206IG51bWJlciwgdG86IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gYXQgIT09IHVuZGVmaW5lZCAmJiBhdCA+PSBmcm9tICYmIGF0IDwgdG87XG59XG5cbi8qKiBDb21wYXJlIHR3byB0ZXh0cyBieSBsaW5lLCByZWZpbmVkIGJ5IHdvcmQgaW5zaWRlIHBhaXJlZCBsaW5lcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmVGV4dChiZWZvcmU6IHN0cmluZywgYWZ0ZXI6IHN0cmluZyk6IERpZmYge1xuICBpZiAoYmVmb3JlID09PSBhZnRlcikge1xuICAgIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpLm1hcCgodGV4dCwgaSkgPT4gKHtcbiAgICAgIG9wOiBcInNhbWVcIiBhcyBjb25zdCxcbiAgICAgIGE6IGksXG4gICAgICBiOiBpLFxuICAgICAgdGV4dCxcbiAgICB9KSk7XG4gICAgcmV0dXJuIHsgbGluZXMsIGh1bmtzOiBbXSwgc2FtZTogdHJ1ZSwgY29hcnNlOiBmYWxzZSB9O1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKGJlZm9yZSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKGFmdGVyKTtcbiAgY29uc3QgdHJhY2UgPSBteWVyc1RyYWNlKGEsIGIpO1xuICBjb25zdCBjb2Fyc2UgPSB0cmFjZSA9PT0gbnVsbDtcbiAgY29uc3QgbGluZXMgPSB0cmFjZSA/IGJhY2t0cmFjayhhLCBiLCB0cmFjZSkgOiBjb2Fyc2VMaW5lcyhhLCBiKTtcbiAgY29uc3QgaHVua3MgPSBjb2xsZWN0KGxpbmVzKTtcbiAgZm9yIChjb25zdCBoIG9mIGh1bmtzKSByZWZpbmVIdW5rKGxpbmVzLCBoKTtcbiAgcmV0dXJuIHsgbGluZXMsIGh1bmtzLCBzYW1lOiBmYWxzZSwgY29hcnNlIH07XG59XG5cbi8qKlxuICogVGFrZSBodW5rcyBmcm9tIHRoZSByaWdodCBzaWRlIGludG8gdGhlIGxlZnQuIGB0YWtlYCBpcyB0aGUgaWRzIHRvIGFwcGx5O1xuICogZXZlcnkgaHVuayBub3QgbmFtZWQgaXMgbGVmdCBhcyB0aGUgbGVmdCBzaWRlIGhhcyBpdC5cbiAqXG4gKiDim5QgQVBQTElFRCBCQUNLIFRPIEZST05ULCBzbyBhbiBlYXJsaWVyIGh1bmsncyBsaW5lIG51bWJlcnMgYXJlIHN0aWxsIHRoZVxuICogb25lcyB0aGUgZGlmZiByZXBvcnRlZCB3aGVuIGl0IGlzIHJlYWNoZWQuIEFwcGx5aW5nIGZyb250IHRvIGJhY2sgd291bGRcbiAqIHNoaWZ0IGV2ZXJ5IGxhdGVyIGh1bmsgYnkgdGhlIHNpemUgb2YgdGhlIGNoYW5nZSBqdXN0IG1hZGUg4oCUIHRoZSBjbGFzc2ljIHdheVxuICogYSBtdWx0aS1odW5rIG1lcmdlIGxhbmRzIGl0cyBsYXN0IGh1bmsgaW4gdGhlIHdyb25nIHBsYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlIdW5rcyhiZWZvcmU6IHN0cmluZywgaHVua3M6IERpZmZIdW5rW10sIHRha2U6IG51bWJlcltdKTogc3RyaW5nIHtcbiAgY29uc3Qgd2FudGVkID0gbmV3IFNldCh0YWtlKTtcbiAgY29uc3QgY2hvc2VuID0gaHVua3MuZmlsdGVyKChoKSA9PiB3YW50ZWQuaGFzKGguaWQpKS5zb3J0KCh4LCB5KSA9PiB5LmFGcm9tIC0geC5hRnJvbSk7XG4gIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhiZWZvcmUpO1xuICBmb3IgKGNvbnN0IGggb2YgY2hvc2VuKSBsaW5lcy5zcGxpY2UoaC5hRnJvbSwgaC5hVG8gLSBoLmFGcm9tLCAuLi5oLmFkZCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogVW5pZmllZC1kaWZmIHRleHQsIGZvciB0aGUgYWdlbnQncyBgZGlmZmAgdmVyYi4gYGNvbnRleHRgIGxpbmVzIGVpdGhlciBzaWRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaWZpZWQoXG4gIGRpZmY6IERpZmYsXG4gIG9wdHM6IHsgZnJvbTogc3RyaW5nOyB0bzogc3RyaW5nOyBjb250ZXh0PzogbnVtYmVyIH0gPSB7IGZyb206IFwiYVwiLCB0bzogXCJiXCIgfSxcbik6IHN0cmluZyB7XG4gIGlmIChkaWZmLnNhbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBjb250ZXh0ID0gb3B0cy5jb250ZXh0ID8/IDM7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbYC0tLSAke29wdHMuZnJvbX1gLCBgKysrICR7b3B0cy50b31gXTtcbiAgLy8gSHVua3MgY2xvc2VyIHRvZ2V0aGVyIHRoYW4gMsOXIGNvbnRleHQgc2hhcmUgb25lIGhlYWRlciwgdGhlIHdheSBldmVyeVxuICAvLyBvdGhlciBkaWZmIHRvb2wgam9pbnMgdGhlbSDigJQgb3RoZXJ3aXNlIHRoZSBjb250ZXh0IGxpbmVzIHByaW50IHR3aWNlLlxuICBjb25zdCBncm91cHM6IERpZmZIdW5rW11bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGggb2YgZGlmZi5odW5rcykge1xuICAgIGNvbnN0IGxhc3QgPSBncm91cHNbZ3JvdXBzLmxlbmd0aCAtIDFdO1xuICAgIGNvbnN0IHByZXYgPSBsYXN0Py5bbGFzdC5sZW5ndGggLSAxXTtcbiAgICBpZiAocHJldiAmJiBoLmFGcm9tIC0gcHJldi5hVG8gPD0gY29udGV4dCAqIDIpIChsYXN0IGFzIERpZmZIdW5rW10pLnB1c2goaCk7XG4gICAgZWxzZSBncm91cHMucHVzaChbaF0pO1xuICB9XG4gIGNvbnN0IGEgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYVwiKSk7XG4gIGNvbnN0IGIgPSBzcGxpdExpbmVzKHNpZGVUZXh0KGRpZmYsIFwiYlwiKSk7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgY29uc3QgZmlyc3QgPSBncm91cFswXSBhcyBEaWZmSHVuaztcbiAgICBjb25zdCBsYXN0ID0gZ3JvdXBbZ3JvdXAubGVuZ3RoIC0gMV0gYXMgRGlmZkh1bms7XG4gICAgY29uc3QgYVN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYUZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBhRW5kID0gTWF0aC5taW4oYS5sZW5ndGgsIGxhc3QuYVRvICsgY29udGV4dCk7XG4gICAgY29uc3QgYlN0YXJ0ID0gTWF0aC5tYXgoMCwgZmlyc3QuYkZyb20gLSBjb250ZXh0KTtcbiAgICBjb25zdCBiRW5kID0gTWF0aC5taW4oYi5sZW5ndGgsIGxhc3QuYlRvICsgY29udGV4dCk7XG4gICAgb3V0LnB1c2goYEBAIC0ke2FTdGFydCArIDF9LCR7YUVuZCAtIGFTdGFydH0gKyR7YlN0YXJ0ICsgMX0sJHtiRW5kIC0gYlN0YXJ0fSBAQGApO1xuICAgIGxldCBhdCA9IGFTdGFydDtcbiAgICBmb3IgKGNvbnN0IGggb2YgZ3JvdXApIHtcbiAgICAgIGZvciAoOyBhdCA8IGguYUZyb207IGF0KyspIG91dC5wdXNoKGAgJHthW2F0XX1gKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBoLmRlbCkgb3V0LnB1c2goYC0ke2xpbmV9YCk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgaC5hZGQpIG91dC5wdXNoKGArJHtsaW5lfWApO1xuICAgICAgYXQgPSBoLmFUbztcbiAgICB9XG4gICAgZm9yICg7IGF0IDwgYUVuZDsgYXQrKykgb3V0LnB1c2goYCAke2FbYXRdfWApO1xuICB9XG4gIHJldHVybiBgJHtvdXQuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG4vKiogUmVidWlsZCBvbmUgc2lkZSdzIHRleHQgZnJvbSB0aGUgbGluZSBvcHMg4oCUIHVzZWQgYnkgYHVuaWZpZWRgIGZvciBjb250ZXh0LiAqL1xuZnVuY3Rpb24gc2lkZVRleHQoZGlmZjogRGlmZiwgc2lkZTogXCJhXCIgfCBcImJcIik6IHN0cmluZyB7XG4gIGNvbnN0IHNraXAgPSBzaWRlID09PSBcImFcIiA/IFwiYWRkXCIgOiBcImRlbFwiO1xuICByZXR1cm4gZGlmZi5saW5lc1xuICAgIC5maWx0ZXIoKGwpID0+IGwub3AgIT09IHNraXApXG4gICAgLm1hcCgobCkgPT4gbC50ZXh0KVxuICAgIC5qb2luKFwiXFxuXCIpO1xufVxuIiwKICAgICIvLyBXaGF0IGlzIHdyb25nIHdpdGggdGhpcyBzZXNzaW9uLCBhbmQgdGhlIHZlcmIgdGhhdCBmaXhlcyBlYWNoIHRoaW5nIChFNjIpLlxuLy9cbi8vIOKblCBSRVBPUlRTLCBORVZFUiBSRVBBSVJTLiBTaWxlbnRseSBwcnVuaW5nIGEgZ2hvc3QgZW50cnkgd291bGQgdGhyb3cgYXdheSB0aGVcbi8vIGZhY3QgdGhhdCB0aGUgaHVtYW4gQVNLRUQgZm9yIHRoYXQgZmlsZSB0byBiZSBpbiB0aGVpciBjb250ZXh0IOKAlCBhbmQgaWYgaXRcbi8vIGNvbWVzIGJhY2sgZnJvbSBhIGBnaXQgY2hlY2tvdXRgLCB0aGV5IHdvdWxkIGhhdmUgdG8gbm90aWNlIGl0IGlzIG1pc3NpbmcgYW5kXG4vLyBhZGQgaXQgYWdhaW4uIFRoZSBzYW1lIGxvZ2ljIHByb3RlY3RzIGEgZG9jdW1lbnQgcmVjb3JkIHdob3NlIGZpbGUgaGFzIGdvbmU6XG4vLyB0aGUgc2Vzc2lvbiBpcyBzdGlsbCBob2xkaW5nIHZlcnNpb25zIHRoZSBodW1hbiBjYW4gc2F2ZSBiYWNrLCBzbyBmb3JnZXR0aW5nXG4vLyBpdCBmb3IgdGhlbSB3b3VsZCBiZSBkaXNjYXJkaW5nIGNvbnRlbnQgb24gdGhlaXIgYmVoYWxmLiBDb2xlIHJ1bGVkIGl0OlxuLy8gXCJyZXBvcnQsIG5hbWUgdGhlIHZlcmIsIGxldCB5b3UgZGVjaWRlLlwiXG4vL1xuLy8g4puUIEFORCBFVkVSWSBGSU5ESU5HIENBUlJJRVMgSVRTIFZFUkIuIEEgcmVwb3J0IHRoYXQgc2F5cyBcIjMgcHJvYmxlbXNcIiBhbmRcbi8vIGxlYXZlcyB5b3UgdG8gd29yayBvdXQgd2hhdCB0byB0eXBlIGlzIHRoZSBzaGFwZSB0aGlzIHNwZWxsIGtlZXBzIGZhaWxpbmcgYXRcbi8vIGFuZCBmaXhpbmcg4oCUIHRoZSBjb25mbGljdCBiYW5uZXIgd2l0aCBubyByb3V0ZSB0byB0aGUgY29tcGFyaXNvbiwgdGhlXG4vLyBcImdvbmUgZnJvbSBkaXNrXCIgbm90aWNlIHdpdGggbm8gd2F5IHRvIGFuc3dlciBpdC4gQSBmaW5kaW5nIHdpdGhvdXQgYSBmaXggaXNcbi8vIGhhbGYgYSBmaW5kaW5nLlxuLy9cbi8vIOKaoCBUSEUgQ0hFQ0tTIEFSRSBFVklERU5DRUQsIE5PVCBJTUFHSU5FRC4gRWFjaCBvbmUgaXMgYSBzdGF0ZSB0aGF0IGhhc1xuLy8gYWN0dWFsbHkgaGFwcGVuZWQgaGVyZTogYSByZWNvcmQgd2hvc2Ugb3JpZ2luYWwgd2FzIGRlbGV0ZWQgKEU2MCdzIHJlc2lkdWUsXG4vLyBhbmQgYW55IGRlbGV0ZSBpbiBGaW5kZXIpLCBhIGBsaXN0ZWRgIGNvbnRleHQgZW50cnkgcG9pbnRpbmcgYXQgbm90aGluZ1xuLy8gKG5ldmVyIHJlc2Nhbm5lZCDigJQgbWVhc3VyZWQsIGFuZCByZWFjaGFibGUgdG9kYXkgd2l0aCBubyBidWcgYXQgYWxsKSwgYW5kXG4vLyBsaW5rcyBhIHNldCBjYW5ub3QgYW5zd2VyIChFNTQpLiBOb3RoaW5nIGlzIGNoZWNrZWQgYmVjYXVzZSBpdCBzb3VuZGVkXG4vLyBwbGF1c2libGUuXG5cbi8qKiBPbmUgdGhpbmcgd29ydGggbG9va2luZyBhdCwgYW5kIHdoYXQgdG8gZG8gYWJvdXQgaXQuICovXG5leHBvcnQgdHlwZSBGaW5kaW5nID0ge1xuICBraW5kOiBcIm9yaWdpbmFsLm1pc3NpbmdcIiB8IFwiY29udGV4dC5naG9zdFwiIHwgXCJsaW5rcy5kYW5nbGluZ1wiO1xuICAvKiogV2hhdCBpdCBpcyBhYm91dDogYSBwYXRoLCBvciBhbiBlbnRyeSBpZC4gKi9cbiAgc3ViamVjdDogc3RyaW5nO1xuICAvKiogV2hhdCB0aGUgaHVtYW4gcmVhZHMuICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgLyoqIFdoYXQgdGhlIGFnZW50IHdvdWxkIHJ1biwgd2l0aCB0aGUgYXJndW1lbnQgYWxyZWFkeSBpbiBpdC4gKi9cbiAgZml4OiBzdHJpbmc7XG4gIC8qKiBIb3cgbWFueSBvZiBzb21ldGhpbmcgdGhlIGZpbmRpbmcgaXMgYWJvdXQsIHdoZW4gdGhhdCBpcyB0aGUgcG9pbnQuICovXG4gIGNvdW50PzogbnVtYmVyO1xufTtcblxuLyoqIFRoZSBmYWN0cyBhIGNoZWNrdXAgbmVlZHMsIGdhdGhlcmVkIGJ5IHdob2V2ZXIgY2FuIHRvdWNoIHRoZSBkaXNrLiAqL1xuZXhwb3J0IHR5cGUgQ2hlY2t1cCA9IHtcbiAgLyoqIEV2ZXJ5IGRvY3VtZW50IHJlY29yZCwgd2l0aCB3aGV0aGVyIGl0cyBmaWxlIG9mIHJlY29yZCBzdGlsbCBleGlzdHMuICovXG4gIGRvY3M6IHJlYWRvbmx5IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIG9yaWdpbmFsOiBzdHJpbmc7XG4gICAgZXhpc3RzOiBib29sZWFuO1xuICAgIHZlcnNpb25zOiBudW1iZXI7XG4gIH1bXTtcbiAgLyoqIEV2ZXJ5IGRvYyBub2RlIGluIGV2ZXJ5IGNvbnRleHQgZW50cnksIHdpdGggd2hldGhlciB0aGUgcGF0aCBleGlzdHMuICovXG4gIG5vZGVzOiByZWFkb25seSB7IGVudHJ5OiBzdHJpbmc7IHBhdGg6IHN0cmluZzsgc2hvd246IHN0cmluZzsgZXhpc3RzOiBib29sZWFuIH1bXTtcbiAgLyoqIERhbmdsaW5nIGxpbmsgY291bnRzIHBlciBtaXJyb3JlZCBlbnRyeS4gKi9cbiAgbGlua3M6IHJlYWRvbmx5IHsgZW50cnk6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGFuZ2xpbmc6IG51bWJlciB9W107XG59O1xuXG4vKipcbiAqIFNoYXBlIHRoZSBmYWN0cyBpbnRvIGZpbmRpbmdzLlxuICpcbiAqIFB1cmUgb24gcHVycG9zZTogdGhlIGZzIHJlYWRzIGJlbG9uZyB0byB0aGUgc2Vzc2lvbiwgYW5kIHdoYXQgY291bnRzIGFzIGFcbiAqIHByb2JsZW0g4oCUIGFuZCB3aGF0IHRvIHNheSBhYm91dCBpdCDigJQgaXMgdGhlIHBhcnQgd29ydGggcGlubmluZyB3aXRoIGNlbGxzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZGluZ3MoYzogQ2hlY2t1cCk6IEZpbmRpbmdbXSB7XG4gIGNvbnN0IG91dDogRmluZGluZ1tdID0gW107XG5cbiAgZm9yIChjb25zdCBkIG9mIGMuZG9jcykge1xuICAgIGlmIChkLmV4aXN0cykgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAga2luZDogXCJvcmlnaW5hbC5taXNzaW5nXCIsXG4gICAgICBzdWJqZWN0OiBkLm9yaWdpbmFsLFxuICAgICAgbWVzc2FnZTogYCR7ZC5uYW1lfSBpcyBpbiB0aGlzIHNlc3Npb24gYnV0IGl0cyBmaWxlIGlzIGdvbmUgZnJvbSBkaXNrLiAke1xuICAgICAgICBkLnZlcnNpb25zID09PSAxID8gXCIxIHZlcnNpb24gaXNcIiA6IGAke2QudmVyc2lvbnN9IHZlcnNpb25zIGFyZWBcbiAgICAgIH0gc3RpbGwgaGVsZCBoZXJlIOKAlCBzYXZpbmcgd291bGQgcmVjcmVhdGUgdGhlIGZpbGUuYCxcbiAgICAgIGZpeDogYGZvcmdldCAtLWRvYyAke2Quc2x1Z31gLFxuICAgICAgY291bnQ6IGQudmVyc2lvbnMsXG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IG4gb2YgYy5ub2Rlcykge1xuICAgIGlmIChuLmV4aXN0cykgY29udGludWU7XG4gICAgLy8g4pqgIEEgcmVjb3JkIGFuZCBhbiBlbnRyeSBjYW4gcG9pbnQgYXQgdGhlIFNBTUUgbWlzc2luZyBwYXRoLCBhbmQgYm90aCBhcmVcbiAgICAvLyByZXBvcnRlZDogdGhleSBhcmUgdHdvIGRpZmZlcmVudCB0aGluZ3MgdG8gY2xlYW4gdXAsIHdpdGggdHdvIGRpZmZlcmVudFxuICAgIC8vIHZlcmJzLCBhbmQgbWVyZ2luZyB0aGVtIHdvdWxkIGxlYXZlIHdoaWNoZXZlciB0aGUgaHVtYW4gZGlkIG5vdCBkby5cbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcImNvbnRleHQuZ2hvc3RcIixcbiAgICAgIHN1YmplY3Q6IG4ucGF0aCxcbiAgICAgIG1lc3NhZ2U6IGAke24uc2hvd259IGlzIGluIHRoZSBjb250ZXh0IGJ1dCBub3Qgb24gZGlzay5gLFxuICAgICAgZml4OiBgaGlkZSAke24ucGF0aH1gLFxuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBsIG9mIGMubGlua3MpIHtcbiAgICBpZiAobC5kYW5nbGluZyA8PSAwKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcImxpbmtzLmRhbmdsaW5nXCIsXG4gICAgICBzdWJqZWN0OiBsLmVudHJ5LFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgbC5kYW5nbGluZyA9PT0gMVxuICAgICAgICAgID8gYCR7bC5sYWJlbH0gaGFzIDEgbGluayB0aGF0IGFuc3dlcnMgbm90aGluZy5gXG4gICAgICAgICAgOiBgJHtsLmxhYmVsfSBoYXMgJHtsLmRhbmdsaW5nfSBsaW5rcyB0aGF0IGFuc3dlciBub3RoaW5nLmAsXG4gICAgICBmaXg6IGBkYW5nbGluZyAtLWVudHJ5ICR7bC5lbnRyeX1gLFxuICAgICAgY291bnQ6IGwuZGFuZ2xpbmcsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIFRoZSBvbmUgbGluZSB0aGUgY2hhdCBnZXRzIGF0IHN0YXJ0dXAsIG9yIG51bGwgd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvIHNheS5cbiAqXG4gKiDim5QgT05FIExJTkUsIEFORCBTSUxFTkNFIFdIRU4gQ0xFQU4uIEEgY2hlY2sgdGhhdCBhbm5vdW5jZXMgaXRzZWxmIGV2ZXJ5IHRpbWVcbiAqIGl0IGZpbmRzIG5vdGhpbmcgdHJhaW5zIHRoZSByZWFkZXIgdG8gc2tpcCBpdCwgYW5kIHRoZW4gaXQgaXMgbm90IGEgY2hlY2sgYW55XG4gKiBtb3JlLiBUaGUgZGV0YWlsIGxpdmVzIGJlaGluZCB0aGUgdmVyYi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcnkobGlzdDogcmVhZG9ubHkgRmluZGluZ1tdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChsaXN0Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIC8vIOKaoCBDb3VudGVkIGJ5IEtJTkQgcmF0aGVyIHRoYW4gZGVzY3JpYmVkLCBiZWNhdXNlIGEgc2VudGVuY2UgdGhhdCB0cmllcyB0b1xuICAvLyBuYW1lIHRocmVlIGNhdGVnb3JpZXMgaW4gb25lIGJyZWF0aCByZWFkcyB3b3JzZSB0aGFuIHRoZSBudW1iZXJzIGRvLlxuICBjb25zdCBieUtpbmQgPSBuZXcgTWFwPEZpbmRpbmdbXCJraW5kXCJdLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgZiBvZiBsaXN0KSBieUtpbmQuc2V0KGYua2luZCwgKGJ5S2luZC5nZXQoZi5raW5kKSA/PyAwKSArIDEpO1xuICAvLyDimqAgQk9USCBGT1JNUyBXUklUVEVOIE9VVC4gQXBwZW5kaW5nIFwic1wiIHByb2R1Y2VkIFwiZ2hvc3QgaW4gdGhlIGNvbnRleHRzXCIsXG4gIC8vIHdoaWNoIGlzIHRoZSBraW5kIG9mIHNtYWxsIHdyb25nbmVzcyB0aGF0IG1ha2VzIGEgdG9vbCByZWFkIGFzIGNhcmVsZXNzLlxuICBjb25zdCBsYWJlbDogUmVjb3JkPEZpbmRpbmdbXCJraW5kXCJdLCBbb25lOiBzdHJpbmcsIG1hbnk6IHN0cmluZ10+ID0ge1xuICAgIFwib3JpZ2luYWwubWlzc2luZ1wiOiBbXCJtaXNzaW5nIGZpbGVcIiwgXCJtaXNzaW5nIGZpbGVzXCJdLFxuICAgIFwiY29udGV4dC5naG9zdFwiOiBbXCJnaG9zdCBpbiB0aGUgY29udGV4dFwiLCBcImdob3N0cyBpbiB0aGUgY29udGV4dFwiXSxcbiAgICBcImxpbmtzLmRhbmdsaW5nXCI6IFtcInNldCB3aXRoIGRhbmdsaW5nIGxpbmtzXCIsIFwic2V0cyB3aXRoIGRhbmdsaW5nIGxpbmtzXCJdLFxuICB9O1xuICBjb25zdCBwYXJ0cyA9IFsuLi5ieUtpbmRdLm1hcCgoW2tpbmQsIG5dKSA9PiBgJHtufSAke2xhYmVsW2tpbmRdW24gPT09IDEgPyAwIDogMV19YCk7XG4gIHJldHVybiBgU3RhcnR1cCBjaGVjazogJHtwYXJ0cy5qb2luKFwiLCBcIil9IOKAlCBydW4gXFxgZG9jdG9yXFxgIGZvciB0aGUgZGV0YWlsLmA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvLyBVbmRvIGFuZCByZWRvIGZvciB0aGUgQ09OVEVYVCDigJQgbW92aW5nIHRoaW5ncyBhcm91bmQsIGFkZGluZywgaGlkaW5nIChFNjApLlxuLy9cbi8vIOKblCBUSElTIElTIE5PVCBUSEUgRURJVE9SJ1MgVU5ETywgYW5kIHRoZSBzdXJmYWNlIHNheXMgc28gYnkgcHV0dGluZyB0aGVzZVxuLy8gYXJyb3dzIGluIHRoZSBjb250ZXh0IGhlYWRlciByYXRoZXIgdGhhbiBhbnl3aGVyZSBuZWFyIHRoZSB0ZXh0LiBDb2RlTWlycm9yJ3Ncbi8vIGhpc3Rvcnkgb3ducyBrZXlzdHJva2VzIGluc2lkZSBhIGRvY3VtZW50OyB0aGlzIG93bnMgYWN0cyBvbiB0aGUgU0hBUEUgb2YgdGhlXG4vLyBjb250ZXh0LCB3aGljaCBpcyB0aGUgdGhpbmcgdGhhdCBoYWQgbm8gd2F5IGJhY2sgYXQgYWxsLiBDb2xlOiBcImxldHRpbmcgdGhlXG4vLyB1c2VyIGtub3cgdGhhdCB0aGVyZSdzIGFuIHVuZG8gZm9yIHRoaXMgc2lkZWJhciB0aGF0IGlzbid0IHRoZSBzYW1lIGFzIHVuZG9cbi8vIHJlZG8gd2hlbiB5b3UncmUgaW4gdGhlIGVkaXRvci5cIlxuLy9cbi8vIOKblCBVTkRPSU5HIEEgQ1JFQVRJT04gREVMRVRFUywgQlVUIE9OTFkgQkVISU5EIEEgQ09ORklSTUFUSU9OLiBUaGlzIHN0YXJ0ZWQgYXNcbi8vIGEgaGFyZCBibG9jayDigJQgdW5kbyBuZXZlciBkZWxldGVzIOKAlCBhbmQgQ29sZSBwdXNoZWQgYmFjaywgY29ycmVjdGx5OiBibG9ja2luZ1xuLy8gZG9lcyBub3QgcmVmdXNlIG9uZSBzdGVwLCBpdCBTVFJBTkRTIEVWRVJZVEhJTkcgQkVISU5EIElULiBDcmVhdGUgYSBmb2xkZXIsIGRvXG4vLyB0d28gbW92ZXMsIGFuZCB5b3UgY2FuIHVuZG8gdGhlIG1vdmVzIGFuZCB0aGVuIG1lZXQgYSB3YWxsIHlvdSBjYW4gbmV2ZXJcbi8vIHBhc3MsIGF0IHdoaWNoIHBvaW50IHRoZSBoaXN0b3J5IGhhcyBzdG9wcGVkIGJlaW5nIGEgaGlzdG9yeS4gQW5kIHRoZSB0aGluZ1xuLy8gdW5kbyB3b3VsZCByZW1vdmUgaXMgb25lIHRoZSBzZXNzaW9uIGl0c2VsZiBtYWRlIG1vbWVudHMgYWdvLCB1c3VhbGx5IGVtcHR5IOKAlFxuLy8gY2F0ZWdvcmljYWxseSBkaWZmZXJlbnQgZnJvbSBkZWxldGluZyB3b3JrLCBhbmQgdGhlIGFwcCBhbHJlYWR5IGhhcyB0aGVcbi8vIHBhdHRlcm4gZm9yIGl0IGluIHRoZSB2ZXJzaW9uLWRlbGV0ZSBkaWFsb2cuIFNvIHRoZSBhcnJvdyBzdGF5cyBlbmFibGVkIGFuZFxuLy8gdGhlIENPTkZJUk1BVElPTiBpcyB0aGUgZ2F0ZS5cbi8vXG4vLyDim5QgV0lUSCBPTkUgSEFSRCBMSU1JVCBUSEFUIElTIE5PVCBORUdPVElBQkxFIEJZIERJQUxPRzogYSBOT04tRU1QVFkgZm9sZGVyIGlzXG4vLyByZWZ1c2VkIG91dHJpZ2h0LiBVbmRvIHdvcmtzIGJhY2t3YXJkcywgc28gaXQgZW1wdGllcyBhIGZvbGRlciBiZWZvcmUgaXRcbi8vIHJlYWNoZXMgdGhhdCBmb2xkZXIncyBjcmVhdGlvbjsgaWYgdGhlIGZvbGRlciBzdGlsbCBoYXMgY29udGVudHMsIHNvbWV0aGluZ1xuLy8gcHV0IHRoZW0gdGhlcmUgdGhhdCB0aGlzIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGFcbi8vIGRpcmVjdG9yeSB0cmVlIGlzIGEgZGlmZmVyZW50IGFjdCBmcm9tIHJlbW92aW5nIHRoZSBlbXB0eSB0aGluZyB5b3UganVzdFxuLy8gbWFkZS4gVGhhdCBjYXNlIHN0b3BzIGFuZCBzYXlzIHdoeS5cbi8vXG4vLyDimqAgVEhFIElOVkVSU0UgSVMgQlVJTFQgV0hFTiBUSEUgQUNUIEhBUFBFTlMsIGZyb20gd2hhdCB3YXMgYWN0dWFsbHkgdHJ1ZVxuLy8gdGhlbiDigJQgbm90IHJlY29uc3RydWN0ZWQgbGF0ZXIgZnJvbSB0aGUgb3AuIEEgYG1vdmVgIHJlY29yZHMgd2hlcmUgdGhlIHRoaW5nXG4vLyBDQU1FIGZyb20gYmVjYXVzZSBvbmx5IHRoZSBtb3ZlciBrbm93czsgYSBgaGlkZWAgcmVjb3JkcyB0aGUgZW50cnkncyB3aG9sZVxuLy8gaGlkZGVuIGxpc3QgYmVjYXVzZSB0aGF0IGlzIHdoYXQgcmVzdG9yZXMgaXQgZXhhY3RseSwgaW5jbHVkaW5nIHRoZSBjYXNlXG4vLyB3aGVyZSBoaWRpbmcgcmVtb3ZlZCBhIHNpbmdsZS1kb2N1bWVudCBlbnRyeSBvdXRyaWdodC5cbmltcG9ydCB0eXBlIHsgU3RydWN0dXJlT3AgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIEhvdyB0byBwdXQgb25lIGFjdCBiYWNrLiBFYWNoIHZhcmlhbnQgaXMgc29tZXRoaW5nIHRoZSBzZXNzaW9uIGNhbiBhbHJlYWR5XG4gKiBkbywgc28gdW5kbyBpbnRyb2R1Y2VzIG5vIG5ldyB3YXkgdG8gY2hhbmdlIHRoZSB3b3JsZCDigJQgaXQgb25seSByZXBsYXlzIHRoZVxuICogZXhpc3Rpbmcgb25lcyB3aXRoIHJlY29yZGVkIGFyZ3VtZW50cy5cbiAqL1xuZXhwb3J0IHR5cGUgSW52ZXJzZSA9XG4gIHwgeyBraW5kOiBcIm1vdmVcIjsgcGF0aDogc3RyaW5nOyBpbnRvOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJyZW5hbWVcIjsgcGF0aDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVxuICAvKiogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSB0aGVzZSByZWxhdGl2ZSBwYXRocy4gKi9cbiAgfCB7IGtpbmQ6IFwiaGlkZGVuXCI7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH1cbiAgLyoqIFB1dCBhIHdob2xlIGRvY3VtZW50IG9yIGZvbGRlciBiYWNrIGluIHRoZSBjb250ZXh0LiAqL1xuICB8IHsga2luZDogXCJjb250ZXh0LmFkZFwiOyBwYXRoOiBzdHJpbmcgfVxuICAvKiogVGFrZSBhIGNvbnRleHQgZW50cnkgYmFjayBvdXQgKHRoZSBpbnZlcnNlIG9mIHB1dHRpbmcgb25lIGluKS4gKi9cbiAgfCB7IGtpbmQ6IFwiY29udGV4dC5yZW1vdmVcIjsgZW50cnk6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIndvcmtzcGFjZVwiOyBwYXRoOiBzdHJpbmcgfVxuICAvKipcbiAgICogUmVtb3ZlIHdoYXQgdGhlIGFjdCBjcmVhdGVkLiBgZGlyYCBkZWNpZGVzIGJvdGggdGhlIGRpYWxvZydzIHdvcmRzIGFuZCB0aGVcbiAgICogZW1wdGluZXNzIHJ1bGUg4oCUIGEgZmlsZSBpcyBjb25maXJtZWQsIGEgZm9sZGVyIGlzIGNvbmZpcm1lZCBBTkQgbXVzdCBiZVxuICAgKiBlbXB0eS5cbiAgICovXG4gIHwgeyBraW5kOiBcImRlbGV0ZVwiOyBwYXRoOiBzdHJpbmc7IGRpcjogYm9vbGVhbiB9O1xuXG4vKiogT25lIGFjdCwgd2l0aCB0aGUgd2F5IGJhY2sgYW5kIGEgc2VudGVuY2UgZm9yIHRoZSBhcnJvdydzIHRvb2x0aXAuICovXG5leHBvcnQgdHlwZSBBY3QgPSB7XG4gIC8qKiBXaGF0IGhhcHBlbmVkLCBmb3IgdGhlIHRvb2x0aXA6IFwibW92ZWQgbm90ZS5tZCBpbnRvIGRyYWZ0c1wiLiAqL1xuICBsYWJlbDogc3RyaW5nO1xuICBpbnZlcnNlOiBJbnZlcnNlO1xufTtcblxuLyoqXG4gKiBXaGF0IHRoZSBzZXNzaW9uIGtuZXcgYmVmb3JlIHRoZSBhY3Qg4oCUIHRoZSBwYXJ0cyBhbiBpbnZlcnNlIG1heSBuZWVkLlxuICpcbiAqIOKaoCBQYXNzZWQgaW4gcmF0aGVyIHRoYW4gcmVhZCBiYWNrIGFmdGVyd2FyZHMsIGJlY2F1c2UgZXZlcnkgZmllbGQgaGVyZSBpc1xuICogc29tZXRoaW5nIHRoZSBhY3QgaXRzZWxmIENIQU5HRVMuIFJlYWRpbmcgYGhpZGRlbmAgYWZ0ZXIgYSBoaWRlIHJldHVybnMgdGhlXG4gKiBsaXN0IGluY2x1ZGluZyB0aGUgdGhpbmcganVzdCBoaWRkZW4sIHdoaWNoIHJlc3RvcmVzIG5vdGhpbmcuXG4gKi9cbmV4cG9ydCB0eXBlIEJlZm9yZSA9IHtcbiAgLyoqIFRoZSBlbnRyeSdzIGhpZGRlbiBsaXN0IGJlZm9yZSB0aGUgYWN0LCB3aGVuIHRoZSBhY3QgdG91Y2hlZCBvbmUuICovXG4gIGhpZGRlbj86IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfTtcbiAgLyoqIFRoZSB3b3Jrc3BhY2UgYmVmb3JlIHRoZSBhY3QuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBXaGF0IHRoZSBhY3QgcmV0dXJuZWQg4oCUIHRoZSBzZXNzaW9uJ3Mgb3duIHJlc3VsdCwgbmFycm93ZWQgdG8gd2hhdCB3ZSB1c2UuICovXG5leHBvcnQgdHlwZSBBZnRlciA9IHtcbiAgcGF0aD86IHN0cmluZztcbiAgLyoqIFdoZXJlIGEgbW92ZSBvciByZW5hbWUgY2FtZSBGUk9NLiAqL1xuICBmcm9tPzogc3RyaW5nO1xuICAvKiogVGhlIGZvbGRlciBgc2V0Lm1ha2VgIGNyZWF0ZWQuICovXG4gIGZvbGRlcj86IHN0cmluZztcbiAgLyoqIFRoZSBlbnRyeSBhIGhpZGUgdG91Y2hlZCwgYW5kIHdoZXRoZXIgaXQgcmVtb3ZlZCB0aGF0IGVudHJ5IGVudGlyZWx5LiAqL1xuICBlbnRyeT86IHN0cmluZztcbiAgcmVtb3ZlZEVudHJ5PzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IGJhc2UgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHAuc3BsaXQoXCIvXCIpLnBvcCgpID8/IHA7XG5jb25zdCBwYXJlbnQgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHAuc2xpY2UoMCwgTWF0aC5tYXgoMCwgcC5sYXN0SW5kZXhPZihcIi9cIikpKSB8fCBcIi9cIjtcblxuLyoqXG4gKiBUaGUgd2F5IGJhY2sgZnJvbSBvbmUgYWN0LlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYW4gYWN0IG5vdCB3b3J0aCBhIGhpc3RvcnkgZW50cnkgYXQgYWxsIOKAlCBgdW5oaWRlYCBvbiBhblxuICogZW50cnkgdGhhdCBoYWQgbm90aGluZyBoaWRkZW4gY2hhbmdlZCBub3RoaW5nLCBhbmQgYW4gdW5kbyBhcnJvdyB0aGF0IHN0ZXBzXG4gKiBvdmVyIG5vLW9wcyBpcyBhbiBhcnJvdyB0aGF0IGxpZXMgYWJvdXQgaG93IGZhciBiYWNrIGl0IGNhbiBnby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5JbnZlcnNlKG9wOiBTdHJ1Y3R1cmVPcCwgYWZ0ZXI6IEFmdGVyLCBiZWZvcmU6IEJlZm9yZSk6IEFjdCB8IG51bGwge1xuICBzd2l0Y2ggKG9wLnR5cGUpIHtcbiAgICAvLyDilIDilIAgYnJvdWdodCBzb21ldGhpbmcgaW50byBleGlzdGVuY2U6IG5vIGludmVyc2UgdGhhdCBkb2VzIG5vdCBkZWxldGUg4pSA4pSAXG4gICAgY2FzZSBcImRvYy5jcmVhdGVcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgY3JlYXRlZCAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiBmYWxzZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwiZm9sZGVyLmNyZWF0ZVwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGBjcmVhdGVkIHRoZSBmb2xkZXIgJHtiYXNlKGFmdGVyLnBhdGggPz8gXCJcIil9YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImRlbGV0ZVwiLCBwYXRoOiBhZnRlci5wYXRoID8/IFwiXCIsIGRpcjogdHJ1ZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGNvcGllZCBpbiAke2Jhc2UoYWZ0ZXIucGF0aCA/PyBcIlwiKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiZGVsZXRlXCIsIHBhdGg6IGFmdGVyLnBhdGggPz8gXCJcIiwgZGlyOiBmYWxzZSB9LFxuICAgICAgfTtcbiAgICBjYXNlIFwic2V0Lm1ha2VcIjpcbiAgICAgIC8vIOKaoCBUSEUgRk9MREVSIElTIFRIRSBUSElORyBUTyBVTkRPLCBub3QgdGhlIG1vdmUgaW5zaWRlIGl0LiBgc2V0Lm1ha2VgXG4gICAgICAvLyBjcmVhdGVzIGEgZm9sZGVyIGFuZCBtb3ZlcyB0aGUgZG9jdW1lbnQgaW4sIHNvIHRoZSBpbnZlcnNlIGlzIHRvXG4gICAgICAvLyByZW1vdmUgdGhlIGZvbGRlciDigJQgd2hpY2ggdGhlIGVtcHRpbmVzcyBydWxlIHdpbGwgcmVmdXNlIHdoaWxlIHRoZVxuICAgICAgLy8gZG9jdW1lbnQgaXMgc3RpbGwgaW4gdGhlcmUuIFRoYXQgcmVmdXNhbCBpcyBjb3JyZWN0IGFuZCByZWFkYWJsZVxuICAgICAgLy8gKFwidGhlIGZvbGRlciBpcyBub3QgZW1wdHlcIiksIGFuZCB0aGUgd2F5IHRocm91Z2ggaXQgaXMgdG8gbW92ZSB0aGVcbiAgICAgIC8vIGRvY3VtZW50IG91dCBmaXJzdCwgd2hpY2ggaXMgaXRzZWxmIGFuIHVuZG9hYmxlIGFjdC5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGxhYmVsOiBgdHVybmVkICR7YmFzZShvcC5wYXRoKX0gaW50byBhIHNldGAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJkZWxldGVcIiwgcGF0aDogYWZ0ZXIuZm9sZGVyID8/IFwiXCIsIGRpcjogdHJ1ZSB9LFxuICAgICAgfTtcblxuICAgIC8vIOKUgOKUgCByZXZlcnNpYmxlLCB3aXRoIGFyZ3VtZW50cyBvbmx5IHRoZSBhY3Qga25ldyDilIDilIBcbiAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICBpZiAoYWZ0ZXIucGF0aCA9PT0gdW5kZWZpbmVkIHx8IGFmdGVyLmZyb20gPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYG1vdmVkICR7YmFzZShhZnRlci5mcm9tKX0gaW50byAke2Jhc2UocGFyZW50KGFmdGVyLnBhdGgpKX1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwibW92ZVwiLCBwYXRoOiBhZnRlci5wYXRoLCBpbnRvOiBwYXJlbnQoYWZ0ZXIuZnJvbSkgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNhc2UgXCJyZW5hbWVcIjoge1xuICAgICAgaWYgKGFmdGVyLnBhdGggPT09IHVuZGVmaW5lZCB8fCBhZnRlci5mcm9tID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGByZW5hbWVkICR7YmFzZShhZnRlci5mcm9tKX0gdG8gJHtiYXNlKGFmdGVyLnBhdGgpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJyZW5hbWVcIiwgcGF0aDogYWZ0ZXIucGF0aCwgbmFtZTogYmFzZShhZnRlci5mcm9tKSB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcImhpZGVcIjoge1xuICAgICAgLy8gVHdvIHNoYXBlczogaGlkaW5nIG9uZSBpdGVtIGluc2lkZSBhIHNldCwgb3IgaGlkaW5nIGEgc2luZ2xlLWRvY3VtZW50XG4gICAgICAvLyBlbnRyeSwgd2hpY2ggcmVtb3ZlcyB0aGUgZW50cnkgb3V0cmlnaHQuXG4gICAgICBpZiAoYWZ0ZXIucmVtb3ZlZEVudHJ5KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGFiZWw6IGByZW1vdmVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfSBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiY29udGV4dC5hZGRcIiwgcGF0aDogYWZ0ZXIucGF0aCA/PyBcIlwiIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjb25zdCBoYWQgPSBiZWZvcmUuaGlkZGVuO1xuICAgICAgaWYgKCFoYWQpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbGFiZWw6IGByZW1vdmVkICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfSBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgaW52ZXJzZTogeyBraW5kOiBcImhpZGRlblwiLCBlbnRyeTogaGFkLmVudHJ5LCByZWxzOiBoYWQucmVscyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSBcInVuaGlkZVwiOiB7XG4gICAgICBjb25zdCBoYWQgPSBiZWZvcmUuaGlkZGVuO1xuICAgICAgLy8gTm90aGluZyB3YXMgaGlkZGVuLCBzbyBub3RoaW5nIGhhcHBlbmVkOiBub3QgaGlzdG9yeS5cbiAgICAgIGlmICghaGFkIHx8IGhhZC5yZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYGJyb3VnaHQgYmFjayAke2hhZC5yZWxzLmxlbmd0aH0gaGlkZGVuIGl0ZW0ke2hhZC5yZWxzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICBpbnZlcnNlOiB7IGtpbmQ6IFwiaGlkZGVuXCIsIGVudHJ5OiBoYWQuZW50cnksIHJlbHM6IGhhZC5yZWxzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBjYXNlIFwid29ya3NwYWNlLnNldFwiOiB7XG4gICAgICBjb25zdCB3YXMgPSBiZWZvcmUud29ya3NwYWNlO1xuICAgICAgaWYgKHdhcyA9PT0gdW5kZWZpbmVkIHx8IHdhcyA9PT0gYWZ0ZXIucGF0aCkgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsYWJlbDogYHNldCB0aGUgd29ya3NwYWNlIHRvICR7YmFzZShhZnRlci5wYXRoID8/IFwiXCIpfWAsXG4gICAgICAgIGludmVyc2U6IHsga2luZDogXCJ3b3Jrc3BhY2VcIiwgcGF0aDogd2FzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxufVxuXG4vKiogV2hhdCB0aGUgYXJyb3dzIG5lZWQgdG8ga25vdywgYW5kIG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCB0eXBlIEhpc3RvcnlWaWV3ID0ge1xuICBjYW5VbmRvOiBib29sZWFuO1xuICBjYW5SZWRvOiBib29sZWFuO1xuICAvKiogXCJtb3ZlZCBub3RlLm1kIGludG8gZHJhZnRzXCIsIGZvciB0aGUgdG9vbHRpcC4gKi9cbiAgdW5kb0xhYmVsPzogc3RyaW5nO1xuICByZWRvTGFiZWw/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBTZXQgd2hlbiB0aGUgbmV4dCB1bmRvIHdvdWxkIERFTEVURSBzb21ldGhpbmcsIHNvIHRoZSBzdXJmYWNlIGNhbiByYWlzZSBhXG4gICAqIGNvbmZpcm1hdGlvbiBiZWZvcmUgc2VuZGluZyBpdC4gUHJlc2VudCBtZWFucyBcImFzayBmaXJzdFwiLCBub3QgXCJyZWZ1c2VcIi5cbiAgICovXG4gIHVuZG9EZWxldGVzPzogeyBwYXRoOiBzdHJpbmc7IGRpcjogYm9vbGVhbiB9O1xufTtcblxuLyoqXG4gKiBUaGUgdHdvIHN0YWNrcy5cbiAqXG4gKiDimqAgSU4gTUVNT1JZLCBOT1QgSU4gVEhFIE1BTklGRVNULCBhbmQgdGhhdCBpcyBhIGRlY2lzaW9uIHJhdGhlciB0aGFuXG4gKiBsYXppbmVzczogYW4gaW52ZXJzZSByZWNvcmRlZCBub3cgZGVzY3JpYmVzIHRoZSB3b3JsZCBhcyBpdCBpcyBub3csIGFuZCBhXG4gKiBzZXNzaW9uIHJlc3RvcmVkIHRvbW9ycm93IG1heSBtZWV0IGEgZmlsZSBzb21lYm9keSBoYXMgc2luY2UgbW92ZWQgYnkgaGFuZC5cbiAqIE9mZmVyaW5nIGFuIHVuZG8gd2hvc2UgYXJndW1lbnRzIGhhdmUgZ29uZSBzdGFsZSBpcyB3b3JzZSB0aGFuIHN0YXJ0aW5nIGVhY2hcbiAqIHNlc3Npb24gd2l0aCBhbiBlbXB0eSBoaXN0b3J5IOKAlCBzbyB0aGUgYXJyb3dzIGFyZSBncmV5IGFmdGVyIGEgcmVzdG9yZSwgd2hpY2hcbiAqIGlzIGhvbmVzdCBhYm91dCB3aGF0IGNhbiBzdGlsbCBiZSBwdXQgYmFjay5cbiAqL1xuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICBwcml2YXRlIHVuZG9zOiBBY3RbXSA9IFtdO1xuICBwcml2YXRlIHJlZG9zOiBBY3RbXSA9IFtdO1xuXG4gIC8qKiBSZWNvcmQgYW4gYWN0LiBBIG5ldyBhY3QgbWFrZXMgdGhlIHJlZG8gc3RhY2sgbWVhbmluZ2xlc3MuICovXG4gIGRpZChhY3Q6IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBpZiAoIWFjdCkgcmV0dXJuO1xuICAgIHRoaXMudW5kb3MucHVzaChhY3QpO1xuICAgIHRoaXMucmVkb3MgPSBbXTtcbiAgfVxuXG4gIC8qKiBXaGF0IHRoZSBuZXh0IHVuZG8gd291bGQgZG8sIHdpdGhvdXQgZG9pbmcgaXQuICovXG4gIHBlZWtVbmRvKCk6IEFjdCB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnVuZG9zW3RoaXMudW5kb3MubGVuZ3RoIC0gMV0gPz8gbnVsbDtcbiAgfVxuXG4gIHBlZWtSZWRvKCk6IEFjdCB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnJlZG9zW3RoaXMucmVkb3MubGVuZ3RoIC0gMV0gPz8gbnVsbDtcbiAgfVxuXG4gIC8qKlxuICAgKiBUYWtlIHRoZSBuZXh0IHVuZG8sIGhhdmluZyBhcHBsaWVkIGl0LiBgcmVkb2AgaXMgdGhlIGFjdCB0aGF0IHdvdWxkIHB1dCBpdFxuICAgKiBiYWNrIOKAlCBidWlsdCBieSB0aGUgY2FsbGVyLCBiZWNhdXNlIG9ubHkgdGhlIGNhbGxlciBrbm93cyB3aGF0IGl0cyBvd25cbiAgICogaW52ZXJzZSBwcm9kdWNlZC5cbiAgICovXG4gIHRvb2tVbmRvKHJlZG86IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBjb25zdCBhY3QgPSB0aGlzLnVuZG9zLnBvcCgpO1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgaWYgKHJlZG8pIHRoaXMucmVkb3MucHVzaChyZWRvKTtcbiAgfVxuXG4gIHRvb2tSZWRvKHVuZG86IEFjdCB8IG51bGwpOiB2b2lkIHtcbiAgICBjb25zdCBhY3QgPSB0aGlzLnJlZG9zLnBvcCgpO1xuICAgIGlmICghYWN0KSByZXR1cm47XG4gICAgaWYgKHVuZG8pIHRoaXMudW5kb3MucHVzaCh1bmRvKTtcbiAgfVxuXG4gIHZpZXcoKTogSGlzdG9yeVZpZXcge1xuICAgIGNvbnN0IHVuZG8gPSB0aGlzLnBlZWtVbmRvKCk7XG4gICAgY29uc3QgcmVkbyA9IHRoaXMucGVla1JlZG8oKTtcbiAgICBjb25zdCBkZWxldGVzID0gdW5kbz8uaW52ZXJzZS5raW5kID09PSBcImRlbGV0ZVwiID8gdW5kby5pbnZlcnNlIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiB7XG4gICAgICAvLyDim5QgQSBERUxFVElORyBVTkRPIElTIFNUSUxMIFVORE9BQkxFIOKAlCB0aGUgZ2F0ZSBpcyB0aGUgZGlhbG9nLCBub3QgdGhlXG4gICAgICAvLyBkaXNhYmxlZCBzdGF0ZSAoQ29sZSdzIHJ1bGluZywgcmV2ZXJzaW5nIGFuIGVhcmxpZXIgZGVzaWduIHRoYXRcbiAgICAgIC8vIHN0cmFuZGVkIGV2ZXJ5IGFjdCBiZWhpbmQgYSBjcmVhdGlvbikuXG4gICAgICBjYW5VbmRvOiB1bmRvICE9PSBudWxsLFxuICAgICAgY2FuUmVkbzogcmVkbyAhPT0gbnVsbCxcbiAgICAgIC4uLih1bmRvID8geyB1bmRvTGFiZWw6IHVuZG8ubGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihyZWRvID8geyByZWRvTGFiZWw6IHJlZG8ubGFiZWwgfSA6IHt9KSxcbiAgICAgIC4uLihkZWxldGVzID8geyB1bmRvRGVsZXRlczogeyBwYXRoOiBkZWxldGVzLnBhdGgsIGRpcjogZGVsZXRlcy5kaXIgfSB9IDoge30pLFxuICAgIH07XG4gIH1cblxuICAvKiogSG93IGRlZXAgdGhlIHN0YWNrcyBhcmUg4oCUIGZvciB0ZXN0cyBhbmQgZm9yIGBzdGF0ZSAtLWZ1bGxgLiAqL1xuICBkZXB0aCgpOiB7IHVuZG86IG51bWJlcjsgcmVkbzogbnVtYmVyIH0ge1xuICAgIHJldHVybiB7IHVuZG86IHRoaXMudW5kb3MubGVuZ3RoLCByZWRvOiB0aGlzLnJlZG9zLmxlbmd0aCB9O1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIE5BVElWRSBmaWxlIHBpY2tlciDigJQgdGhlIGFmZm9yZGFuY2UgYSB3ZWIgcGFnZSBjYW5ub3QgaGF2ZS5cbiAqXG4gKiBBIGJyb3dzZXIncyBvd24gYDxpbnB1dCB0eXBlPVwiZmlsZVwiPmAgYW5kIGBzaG93T3BlbkZpbGVQaWNrZXIoKWAgYm90aCBoYW5kXG4gKiBiYWNrIGZpbGUgQ09OVEVOVCBhbmQgYSBuYW1lLCBuZXZlciBhIHBhdGggKGFuZCBCcmF2ZSwgQ29sZSdzIGJyb3dzZXIsXG4gKiBkaXNhYmxlcyB0aGUgRmlsZSBTeXN0ZW0gQWNjZXNzIEFQSSBvdXRyaWdodCkuIEEgY29weSBpcyBhbGwgYSBwYWdlIGNhbiBkb1xuICogd2l0aCB0aGF0LCB3aGljaCBpcyBleGFjdGx5IHdoYXQgYSBkcm9wIGFscmVhZHkgZG9lcyAoRTIzKS4gQnV0IHNjcmlwdG9yaXVtJ3NcbiAqIGRhZW1vbiBpcyBhIExPQ0FMIFBST0NFU1M6IGl0IGNhbiBhc2sgdGhlIE9TIGZvciBpdHMgb3duIG9wZW4gZGlhbG9nIGFuZCBnZXRcbiAqIGJhY2sgYSByZWFsIGZpbGVzeXN0ZW0gcGF0aCDigJQgc28gXCJDaG9vc2XigKZcIiBsaW5rcyB0aGUgcmVhbCBmaWxlIChFMSkgaW5zdGVhZFxuICogb2YgY29weWluZyBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGhlcmUgaXMgcHVyZTogd2hpY2ggYXJndiB0byBydW4sIGFuZCBob3cgdG8gcmVhZCB3aGF0IGl0IHByaW50ZWQuXG4gKiBUaGUgc3Bhd25pbmcgKGFuZCB0aGUgb25lLWF0LWEtdGltZSBydWxlKSBpcyB0aGUgZGFlbW9uJ3MuXG4gKi9cblxuZXhwb3J0IHR5cGUgUGlja0tpbmQgPSBcImZpbGVcIiB8IFwiZm9sZGVyXCI7XG5cbi8qKiBBbiBBcHBsZVNjcmlwdCB0aGF0IHB1dHMgb25lIFBPU0lYIHBhdGggcGVyIGxpbmUgb24gc3Rkb3V0LiAqL1xuZnVuY3Rpb24gYXBwbGVTY3JpcHQoa2luZDogUGlja0tpbmQsIHByb21wdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcXVvdGVkID0gcHJvbXB0LnJlcGxhY2UoL1tcIlxcXFxdL2csIFwiXCIpO1xuICBjb25zdCBjaG9vc2UgPVxuICAgIGtpbmQgPT09IFwiZmlsZVwiXG4gICAgICA/IGBjaG9vc2UgZmlsZSB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwiIHdpdGggbXVsdGlwbGUgc2VsZWN0aW9ucyBhbGxvd2VkYFxuICAgICAgOiBge2Nob29zZSBmb2xkZXIgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIn1gO1xuICByZXR1cm4gW1xuICAgIGBzZXQgY2hvc2VuIHRvICR7Y2hvb3NlfWAsXG4gICAgJ3NldCBvdXQgdG8gXCJcIicsXG4gICAgXCJyZXBlYXQgd2l0aCBmIGluIGNob3NlblwiLFxuICAgIFwic2V0IG91dCB0byBvdXQgJiBQT1NJWCBwYXRoIG9mIGYgJiBsaW5lZmVlZFwiLFxuICAgIFwiZW5kIHJlcGVhdFwiLFxuICAgIFwicmV0dXJuIG91dFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNvbW1hbmQgdGhhdCBvcGVucyB0aGUgT1MncyBwaWNrZXIsIG9yIG51bGwgd2hlcmUgdGhlcmUgaXMgbm9uZSDigJQgdGhlXG4gKiBjYWxsZXIgdGhlbiBzYXlzIHNvIHJhdGhlciB0aGFuIGhhbmdpbmcgb24gYSBkaWFsb2cgbm9ib2R5IHdpbGwgc2VlLlxuICogYHplbml0eUF0YCBpcyB3aGVyZSBhIExpbnV4IHplbml0eSB3YXMgZm91bmQgKHRoZSBjYWxsZXIgbG9va3MgaXQgdXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja2VyQ29tbWFuZChcbiAgcGxhdGZvcm06IHN0cmluZyxcbiAga2luZDogUGlja0tpbmQsXG4gIHByb21wdDogc3RyaW5nLFxuICB6ZW5pdHlBdD86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAocGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHJldHVybiBbXCJvc2FzY3JpcHRcIiwgXCItZVwiLCBhcHBsZVNjcmlwdChraW5kLCBwcm9tcHQpXTtcbiAgaWYgKHBsYXRmb3JtID09PSBcIndpbjMyXCIpIHJldHVybiBudWxsOyAvLyBQb3dlclNoZWxsJ3MgZGlhbG9nIG5lZWRzIGEgU1RBIGhvc3Q7IG5vdCB3cml0dGVuIHVudGlsIGFza2VkIGZvclxuICBpZiAoemVuaXR5QXQpXG4gICAgcmV0dXJuIFtcbiAgICAgIHplbml0eUF0LFxuICAgICAgXCItLWZpbGUtc2VsZWN0aW9uXCIsXG4gICAgICAuLi4oa2luZCA9PT0gXCJmb2xkZXJcIiA/IFtcIi0tZGlyZWN0b3J5XCJdIDogW1wiLS1tdWx0aXBsZVwiXSksXG4gICAgICBcIi0tc2VwYXJhdG9yPVxcblwiLFxuICAgICAgYC0tdGl0bGU9JHtwcm9tcHR9YCxcbiAgICBdO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBwYXRocyBhIHBpY2tlciBwcmludGVkOiBvbmUgcGVyIGxpbmUsIGJsYW5rcyBkcm9wcGVkLCBvcmRlciBrZXB0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gc3Rkb3V0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXG4gICAgLmZpbHRlcigobCkgPT4gbC5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAubWFwKChsKSA9PiAobC5sZW5ndGggPiAxICYmIGwuZW5kc1dpdGgoXCIvXCIpID8gbC5zbGljZSgwLCAtMSkgOiBsKSk7XG59XG5cbi8qKiBBIGNhbmNlbGxlZCBkaWFsb2cgaXMgbm90IGEgZmFpbHVyZSDigJQgb3Nhc2NyaXB0IGV4aXRzIDEsIHplbml0eSBleGl0cyAxLCBhbmQgbm90aGluZyB3YXMgY2hvc2VuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhc0NhbmNlbGxlZChleGl0Q29kZTogbnVtYmVyLCBzdGRvdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXhpdENvZGUgIT09IDAgJiYgcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0KS5sZW5ndGggPT09IDA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhZFN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgLy8g4pqgIGBybWRpclN5bmNgIHJhdGhlciB0aGFuIGBybVN5bmMo4oCmLCB7cmVjdXJzaXZlOnRydWV9KWAgT04gUFVSUE9TRTogaXRcbiAgLy8gdGhyb3dzIEVOT1RFTVBUWSwgd2hpY2ggaXMgYSBzZWNvbmQgbmV0IHVuZGVyIGByZW1vdmVDcmVhdGVkYCdzIG93blxuICAvLyBlbXB0aW5lc3MgY2hlY2suIEEgcmVjdXJzaXZlIGRlbGV0ZSB3b3VsZCBtYWtlIHRoZSBidWcgaXQgcHJldmVudHNcbiAgLy8gdW5yZWNvdmVyYWJsZSByYXRoZXIgdGhhbiBsb3VkLlxuICBybWRpclN5bmMsXG4gIHJtU3luYyxcbiAgc3RhdFN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHsgdHlwZSBBbmNob3IsIGFuY2hvck9mLCBmaW5kQW5jaG9yIH0gZnJvbSBcIi4vYW5jaG9yc1wiO1xuaW1wb3J0IHsgYXBwbHlIdW5rcywgZGlmZlRleHQgfSBmcm9tIFwiLi9kaWZmXCI7XG5pbXBvcnQgeyB0eXBlIEZpbmRpbmcsIGZpbmRpbmdzIH0gZnJvbSBcIi4vZG9jdG9yXCI7XG5pbXBvcnQge1xuICBib2R5TGluZU9mZnNldCxcbiAgYnVpbGRCbG9jayxcbiAgZ3Vlc3NUeXBlLFxuICBtYXRjaGVzRmlsdGVyLFxuICByZWFkTWV0YSxcbiAgc2V0S2V5LFxuICBzcGxpdEZyb250bWF0dGVyLFxuICBzdW1tYXJpemUsXG4gIHRpdGxlRnJvbUJvZHksXG4gIHdpdGhCbG9jayxcbn0gZnJvbSBcIi4vZnJvbnRtYXR0ZXJcIjtcbmltcG9ydCB7IHR5cGUgQnVuZGxlSW5kZXgsIGJ1aWxkR3JhcGgsIHR5cGUgUmVzb2x1dGlvbiwgcmVzb2x2ZVRhcmdldCB9IGZyb20gXCIuL2xpbmtzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENoYXRNZXNzYWdlLFxuICBDaGF0V2hvLFxuICBDb250ZXh0RW50cnksXG4gIENvbnRleHROb2RlLFxuICBEaWZmUGF5bG9hZCxcbiAgRGlmZlNpZGUsXG4gIERvY01ldGEsXG4gIERvY1N1bW1hcnksXG4gIERvY1ZpZXcsXG4gIEdyYXBoUGF5bG9hZCxcbiAgTWV0YUZpbHRlcixcbiAgTW92ZVBsYW4sXG4gIE5vdGUsXG4gIFBsYWNlZE5vdGUsXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFRhc2ssXG4gIFZlcnNpb24sXG4gIFZlcnNpb25BdXRob3IsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIENhbmRpZGF0ZSwgdHlwZSBTZWFyY2hSZXBvcnQsIHNlYXJjaERvY3VtZW50cyB9IGZyb20gXCIuL3NlYXJjaFwiO1xuaW1wb3J0IHtcbiAgRE9DX0VYVEVOU0lPTlMsXG4gIGRvY1BhdGhzLFxuICBlbnRyeUZvclBhdGgsXG4gIGZpbmROb2RlLFxuICBpc0RvY05hbWUsXG4gIGxvY2F0ZSxcbiAgTUlSUk9SX05PREVfQ0FQLFxuICBzY2FuVHJlZSxcbiAgdG9Qb3NpeCxcbn0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgY29uc3QgTUFOSUZFU1RfRk9STUFUID0gMTtcblxuLyoqIFRoZSBtb3N0IGRvY3VtZW50cyBvbmUgZnJvbnRtYXR0ZXIgc2NhbiByZWFkcy4gKi9cbmV4cG9ydCBjb25zdCBNRVRBX1NDQU5fQ0FQID0gNTAwO1xuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2sgbGl2ZXMgYXQgdGhlIHRvcCBvZiBhIGZpbGU7IHRoaXMgaXMgaG93IG11Y2ggd2UgcmVhZCB0byBmaW5kIGl0LiAqL1xuY29uc3QgTUVUQV9IRUFEX0JZVEVTID0gODE5MjtcblxuLyoqIFRoZSBmaXJzdCA4IEtCIG9mIGEgZmlsZSwgYXMgdGV4dCDigJQgZW5vdWdoIGZvciBhbnkgZnJvbnRtYXR0ZXIgYmxvY2suICovXG5mdW5jdGlvbiByZWFkSGVhZChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgZmQ6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmZCA9IG9wZW5TeW5jKHBhdGgsIFwiclwiKTtcbiAgICBjb25zdCBidWYgPSBCdWZmZXIuYWxsb2MoTUVUQV9IRUFEX0JZVEVTKTtcbiAgICBjb25zdCByZWFkID0gcmVhZFN5bmMoZmQsIGJ1ZiwgMCwgTUVUQV9IRUFEX0JZVEVTLCAwKTtcbiAgICByZXR1cm4gYnVmLnN1YmFycmF5KDAsIHJlYWQpLnRvU3RyaW5nKFwidXRmOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKGZkICE9PSB1bmRlZmluZWQpIGNsb3NlU3luYyhmZCk7XG4gIH1cbn1cblxudHlwZSBEb2NSZWNvcmQgPSB7XG4gIHNsdWc6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBvcmlnaW5hbDogc3RyaW5nO1xuICBlbnRyeUlkOiBzdHJpbmcgfCBudWxsO1xuICByZWw6IHN0cmluZyB8IG51bGw7XG4gIGV4dDogc3RyaW5nO1xuICB2ZXJzaW9uczogT21pdDxWZXJzaW9uLCBcInBhdGhcIj5bXTtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIC8qKlxuICAgKiBUaGUgbmV4dCB2ZXJzaW9uIG51bWJlciB0byBoYW5kIG91dCDigJQgTU9OT1RPTklDLCBhbmQgbmV2ZXIgZGVyaXZlZCBmcm9tXG4gICAqIHRoZSB2ZXJzaW9ucyBzdGlsbCBwcmVzZW50IChFNDEpLiBOdW1iZXJpbmcgYXMgYG1heChleGlzdGluZykgKyAxYCB3YXNcbiAgICogY29ycmVjdCB3aGlsZSBub3RoaW5nIGNvdWxkIGJlIGRlbGV0ZWQ7IHRoZSBtb21lbnQgYSB2ZXJzaW9uIGNhbiBiZVxuICAgKiByZW1vdmVkLCBkZWxldGluZyB0aGUgaGlnaGVzdCBtYWtlcyB0aGUgbmV4dCBvbmUgUkVVU0UgaXRzIG51bWJlciwgYW5kIGFcbiAgICogYHYzYCBuYW1lZCBpbiBhIGNoYXQgbWVzc2FnZSwgYSBsb2cgbGluZSBvciBhbiBhZ2VudCdzIG5vdGVzIHdvdWxkIHRoZW5cbiAgICogcG9pbnQgYXQgYSBkaWZmZXJlbnQgZG9jdW1lbnQuIEFic2VudCBvbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSDigJRcbiAgICogYHRha2VWZXJzaW9uYCBkZXJpdmVzIGl0IG9uY2UsIGZyb20gdGhlIGhpZ2hlc3QgdGhhdCBldmVyIHdhcy5cbiAgICovXG4gIG5leHRWZXJzaW9uPzogbnVtYmVyO1xuICAvKiogTm90ZXMgb24gdGhpcyBkb2N1bWVudCAoRTQ1KS4gU3RvcmVkIGluIHRoZSBtYW5pZmVzdDogdGhleSB0cmF2ZWwgd2l0aCB0aGVcbiAgICogIHNlc3Npb24gYW5kIG5ldmVyIGxpdHRlciB0aGUgaHVtYW4ncyBmb2xkZXIuICovXG4gIG5vdGVzPzogTm90ZVtdO1xuICAvKiogSGFzaCBvZiB0aGUgb3JpZ2luYWwgYXMgd2UgbGFzdCByZWFkIG9yIHdyb3RlIGl0IOKAlCBhdCBvcGVuLCBzYXZlLCByZXZlcnRcbiAgICogIGFuZCByZWxvYWQg4oCUIHNvIGEgcmVzdG9yZSBjYW4gdGVsbCB0aGF0IGl0IGNoYW5nZWQgd2hpbGUgbm8gZGFlbW9uIHdhc1xuICAgKiAgd2F0Y2hpbmcgKHZlcmlmeS1wYXNzIGZpeCAyKS4gKi9cbiAgb3JpZ2luYWxIYXNoOiBzdHJpbmc7XG4gIC8qKiBTZXQgb25seSBieSBgb3BlblBhdGhgLCB3aGljaCBhZG1pdHMgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogIGVudHJ5LiBgc2F2ZWAgd3JpdGVzIG5vIG9yaWdpbmFsIHRoYXQgbGFja3MgaXQgKHZlcmlmeS1wYXNzIGZpeCAxYykuICovXG4gIGFkbWl0dGVkPzogYm9vbGVhbjtcbiAgb3V0c2lkZUNoYW5nZWQ6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgZm9ybWF0OiBudW1iZXI7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgY29udGV4dDogQ29udGV4dEVudHJ5W107XG4gIGRvY3M6IERvY1JlY29yZFtdO1xuICBvcGVuRG9jOiBzdHJpbmcgfCBudWxsO1xuICBjaGF0OiBDaGF0TWVzc2FnZVtdO1xuICAvKiogVGhlIHdvcmsgcXVldWUgKEU1MCkuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQuICovXG4gIHRhc2tzPzogVGFza1tdO1xuICAvKiogRTIzJ3Mgd29ya3NwYWNlLiBBYnNlbnQgaW4gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBpdCBleGlzdGVkOiB0aGUgdXNlcidzIGhvbWUuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICAgLyoqXG4gICAgICogV2hhdCB0byBETyBhYm91dCBpdCwgd2hlbiB0aGUgbWVzc2FnZSBhbG9uZSBkb2VzIG5vdCBzYXkuIENhcnJpZWQgdG8gdGhlXG4gICAgICogQ0xJJ3MgZW52ZWxvcGUsIHdoZXJlIHRoZSBob3VzZSB0YXhvbm9teSBhbHJlYWR5IGhhcyBhIGBoaW50YCBmaWVsZCB0aGF0XG4gICAgICogcmVmdXNhbHMgZnJvbSB0aGlzIHNpZGUgd2VyZSBuZXZlciBmaWxsaW5nLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhpbnQ/OiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBBIHBhdGgncyByZWFscGF0aCwgb3IgdGhlIHBhdGggaXRzZWxmIHdoZW4gaXQgY2Fubm90IGJlIHJlc29sdmVkIChnb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFsT3IocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcDtcbiAgfVxufVxuXG4vKiogV2hhdCBhIHdhdGNoZXIgZXZlbnQgdHVybmVkIG91dCB0byBiZS4gYG51bGxgID0gbm90aGluZyAob3Vycywgb3Igbm8gY2hhbmdlKS4gKi9cbmV4cG9ydCB0eXBlIEZpbGVFdmVudCA9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IGFjdGl2ZTogZmFsc2UgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIjtcbiAgICAgIGRvYzogc3RyaW5nO1xuICAgICAgdmVyc2lvbjogbnVtYmVyO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgLyoqIFRoZSBuZXcgYWdlbnQgdmVyc2lvbiB0aGUgb3V0c2lkZSB0ZXh0IHdhcyBwcmVzZXJ2ZWQgYXMuICovXG4gICAgICBwcmVzZXJ2ZWRBczogbnVtYmVyO1xuICAgICAgcHJlc2VydmVkUGF0aDogc3RyaW5nO1xuICAgIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGFzIHRoZSBkYWVtb24gbGFzdCB3cm90ZSAob3IgYWRvcHRlZClcbiAgICogIGl0IOKAlCB3aGF0IGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIHJldmVydGVkIHRvLiAqL1xuICBwcml2YXRlIGxhc3RBY3RpdmVUZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFdoYXQgYSByZXN0b3JlIGZvdW5kIGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLiAqL1xuICByZXN0b3JlRmluZGluZ3M6IHsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IG1pc3Npbmc6IGJvb2xlYW4gfVtdID0gW107XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCksIHdvcmtzcGFjZT86IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCB7XG4gICAgICBmb3JtYXQ6IE1BTklGRVNUX0ZPUk1BVCxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGNvbnRleHQ6IFtdLFxuICAgICAgZG9jczogW10sXG4gICAgICBvcGVuRG9jOiBudWxsLFxuICAgICAgY2hhdDogW10sXG4gICAgICAuLi4od29ya3NwYWNlID8geyB3b3Jrc3BhY2U6IHJlc29sdmUod29ya3NwYWNlKSB9IDoge30pLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIGNvbnN0IHRleHQgPSBleGlzdHNTeW5jKHApID8gcmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSA6IFwiXCI7XG4gICAgICBzLmFkb3B0QWN0aXZlKGQsIHRleHQpO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAyOiBhbiBvcmlnaW5hbCBjaGFuZ2VkIHdoaWxlIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWRcbiAgICAgIC8vIHdhcyBpbnZpc2libGUgaGVyZSwgc28gdGhlIG5leHQgU2F2ZSBvdmVyd3JvdGUgaXQgdW5hbm5vdW5jZWQuIFRoZVxuICAgICAgLy8gbWFuaWZlc3QgaG9sZHMgdGhlIG9yaWdpbmFsJ3MgaGFzaCBhcyBvZiB0aGUgbGFzdCBvcGVuL3NhdmUvcmV2ZXJ0L1xuICAgICAgLy8gcmVsb2FkOyBhIGRpZmZlcmVudCBoYXNoIG5vdyBpcyBhbiBvdXRzaWRlIGNoYW5nZSwgbWFya2VkIGV4YWN0bHkgYXMgYVxuICAgICAgLy8gbGl2ZSBvbmUgd2l0aCBhIGRpcnR5IGJ1ZmZlciBpcyDigJQgYXNrZWQsIG5ldmVyIG1lcmdlZCBvciByZWxvYWRlZC5cbiAgICAgIGxldCBub3c6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbm93ID0gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbm93ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChub3cgPT09IG51bGwgfHwgbm93ICE9PSBkLm9yaWdpbmFsSGFzaCkge1xuICAgICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgcy5yZXN0b3JlRmluZGluZ3MucHVzaCh7IGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCwgbWlzc2luZzogbm93ID09PSBudWxsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocy5yZXN0b3JlRmluZGluZ3MubGVuZ3RoID4gMCkgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGVhY2ggZW50cnkgcm9vdCxcbiAgICogYW5kIHRoZSBSRUFMIGRpcmVjdG9yeSBvZiBldmVyeSBvcGVuZWQgb3JpZ2luYWwuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMzogZWFjaCByb290IGlzIHdhdGNoZWQgYXQgaXRzIFJFQUxQQVRIIChgd2F0Y2hgKSwgYW5kXG4gICAqIGFuIGV2ZW50IGlzIHJlcG9ydGVkIHVuZGVyIHRoZSBwYXRoIGZvcm0gdGhlIHNlc3Npb24gc3RvcmVzIChgcGF0aGApLiBBXG4gICAqIHdhdGNoIG9uIGEgc3ltbGlua2VkIGRpcmVjdG9yeSDigJQgYSBzeW1saW5rZWQgaG9tZSwgYSBzeW1saW5rZWQgZm9sZGVyXG4gICAqIGVudHJ5IOKAlCBvciBvbiB0aGUgbGluaydzIG93biBkaXJlY3RvcnkgZm9yIGEgc3ltbGlua2VkIG9yaWdpbmFsIHNhd1xuICAgKiBub3RoaW5nIHdoZW4gdGhlIFRBUkdFVCBjaGFuZ2VkIChGU0V2ZW50cyByZXBvcnRzIHJlYWwgcGF0aHMpLiBBIHN5bWxpbmtlZFxuICAgKiBvcmlnaW5hbCBpcyBtYXRjaGVkIGJhY2sgdG8gaXRzIGRvYyBieSByZWFscGF0aCBpbiBgb25GaWxlRXZlbnRgLlxuICAgKi9cbiAgd2F0Y2hSb290cygpOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSB7XG4gICAgY29uc3Qgcm9vdHM6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdID0gW1xuICAgICAgeyBwYXRoOiB0aGlzLmRvY3NEaXIsIHdhdGNoOiByZWFsT3IodGhpcy5kb2NzRGlyKSwgcmVjdXJzaXZlOiB0cnVlIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICByb290cy5wdXNoKHtcbiAgICAgICAgcGF0aDogZS5yb290LFxuICAgICAgICB3YXRjaDogcmVhbE9yKGUucm9vdCksXG4gICAgICAgIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsXG4gICAgICAgIGVudHJ5SWQ6IGUuaWQsXG4gICAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBkaXJuYW1lKHJlYWxPcihkLm9yaWdpbmFsKSk7XG4gICAgICBpZiAoXG4gICAgICAgICFyb290cy5zb21lKChyKSA9PiByLndhdGNoID09PSByZWFsRGlyICYmIHIucmVjdXJzaXZlID09PSBmYWxzZSkgJiZcbiAgICAgICAgIXJvb3RzLnNvbWUoXG4gICAgICAgICAgKHIpID0+IHIucmVjdXJzaXZlICYmIChyZWFsRGlyID09PSByLndhdGNoIHx8IHJlYWxEaXIuc3RhcnRzV2l0aChyLndhdGNoICsgc2VwKSksXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgcm9vdHMucHVzaCh7IHBhdGg6IHJlYWxEaXIsIHdhdGNoOiByZWFsRGlyLCByZWN1cnNpdmU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRvcHRBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgdGhpcy5vd25lZC5zZXQocCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBLZWVwIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFzIGEgTkVXIGFnZW50IHZlcnNpb24uICovXG4gIHByaXZhdGUgcHJlc2VydmVPdXRzaWRlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogVmVyc2lvbiB7XG4gICAgY29uc3QgbiA9IHRoaXMudGFrZVZlcnNpb24oZCk7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgIGZyb206IGQuYWN0aXZlLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbGFiZWw6IGBvdXRzaWRlIHdyaXRlIHRvIHYke2QuYWN0aXZlfWAsXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH07XG4gIH1cblxuICAvKiogVHJ1ZSBpZmYgYHRleHRgIGF0IGBwYXRoYCBpcyBleGFjdGx5IHdoYXQgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIHRoZXJlLiAqL1xuICBpc093bldyaXRlKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMub3duZWQuZ2V0KHBhdGgpID09PSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb250ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZENvbnRleHQocmF3UGF0aDogc3RyaW5nKTogeyBlbnRyeTogQ29udGV4dEVudHJ5OyBhZGRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGNvbnN0IHByb2JlID0gZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApO1xuICAgIGNvbnN0IHNhbWUgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUucm9vdCA9PT0gcHJvYmUucm9vdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IHByb2JlLm1lbWJlcnNoaXAgJiZcbiAgICAgICAgKHByb2JlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiB8fFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGUubm9kZXMpID09PSBKU09OLnN0cmluZ2lmeShwcm9iZS5ub2RlcykpLFxuICAgICk7XG4gICAgaWYgKHNhbWUpIHJldHVybiB7IGVudHJ5OiBzYW1lLCBhZGRlZDogZmFsc2UgfTtcbiAgICB0aGlzLm0uY29udGV4dC5wdXNoKHByb2JlKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBwcm9iZSwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBBbiBlbnRyeSdzIHJvb3QgcGF0aCwgc28gRTYwIGNhbiBwdXQgYmFjayBhIGNvbnRleHQgZW50cnkgaXQgcmVtb3ZlZC4gKi9cbiAgZW50cnlSb290KGlkOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpPy5yb290ID8/IG51bGw7XG4gIH1cblxuICByZW1vdmVDb250ZXh0KGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpID0gdGhpcy5tLmNvbnRleHQuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gICAgaWYgKGkgPCAwKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoZSkgPT4gZS5pZCksXG4gICAgICApO1xuICAgIHRoaXMubS5jb250ZXh0LnNwbGljZShpLCAxKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgb3BlbiBkb2N1bWVudCBsZWZ0IHRoZSBjb250ZXh0IChpdHMgZW50cnkgcmVtb3ZlZCwgb3IgdGhlIGRvY3VtZW50XG4gICAqIGhpZGRlbik6IGNsb3NlIGl0IGluIHRoZSB2aWV3LiBJdHMgdmVyc2lvbnMgc3RheSBpbiB0aGUgc2Vzc2lvbiDigJQgbm90aGluZ1xuICAgKiBpcyBkZWxldGVkIOKAlCBhbmQgYnJpbmdpbmcgaXQgYmFjayBhbmQgb3BlbmluZyBpdCBhZ2FpbiBmaW5kcyB0aGVtLlxuICAgKi9cbiAgcHJpdmF0ZSBjbG9zZU9ycGhhbmVkT3BlbkRvYygpOiB2b2lkIHtcbiAgICBjb25zdCBvcGVuID0gdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICBpZiAob3BlbiAmJiBvcGVuLmVudHJ5SWQgPT09IG51bGwpIHRoaXMubS5vcGVuRG9jID0gbnVsbDtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QsIE1JUlJPUl9OT0RFX0NBUCwgZS5oaWRkZW4pO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBvcGVuZWQgPSB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IGQuc2x1Zyk7XG4gICAgLyoqXG4gICAgICog4puUIFdIRU4gTk9USElORyBJUyBPUEVOLCBUSEUgT1BFTkVEIFNMVUdTIEFSRSBBTiBFTVBUWSBMSVNUIEFORCBBTiBFTVBUWVxuICAgICAqIExJU1QgSVMgTk9UIEFOIEFOU1dFUi4gQSBjb2xkIGFnZW50IG5hbWVkIGEgZG9jdW1lbnQgYnkgZmlsZW5hbWUgYmVmb3JlXG4gICAgICogYW55dGhpbmcgd2FzIG9wZW4gYW5kIGdvdCBgY2hvaWNlczogW11gIHdpdGggbm8gaGludCDigJQgZnJvbSBhIHNlc3Npb25cbiAgICAgKiB3aG9zZSBjb250ZXh0IGhlbGQgZXhhY3RseSB0aGUgdHdvIGRvY3VtZW50cyBpdCBjb3VsZCBoYXZlIG5hbWVkLiBUaGVcbiAgICAgKiByZWZ1c2FsIHdhcyBjb3JyZWN0IGFuZCB1c2VsZXNzLCB3aGljaCBpcyB0aGUgZmFpbHVyZSBtb2RlIGBjaG9pY2VzYFxuICAgICAqIGV4aXN0cyB0byBwcmV2ZW50LlxuICAgICAqXG4gICAgICogU28gYW4gdW5vcGVuZWQgc2Vzc2lvbiBvZmZlcnMgdGhlIHBhdGhzIGl0IENPVUxEIG9wZW4sIGFuZCBzYXlzIGhvdy4gQVxuICAgICAqIGZpbGVuYW1lIG9ubHkgcmVzb2x2ZXMgZm9yIGEgZG9jdW1lbnQgdGhhdCBpcyBhbHJlYWR5IG9wZW47IGEgcGF0aCBhbHdheXNcbiAgICAgKiBvcGVucyBvbmUuXG4gICAgICovXG4gICAgY29uc3QgY2hvaWNlcyA9XG4gICAgICBvcGVuZWQubGVuZ3RoID4gMCA/IG9wZW5lZCA6IHRoaXMubS5jb250ZXh0LmZsYXRNYXAoKGUpID0+IGRvY1BhdGhzKGUpKS5zbGljZSgwLCAyMCk7XG4gICAgY29uc3QgaGludCA9XG4gICAgICBvcGVuZWQubGVuZ3RoID4gMFxuICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICA6IFwibm90aGluZyBpcyBvcGVuIHlldCDigJQgcGFzcyBhIFBBVEggZnJvbSB0aGUgY29udGV4dCAoYSBmaWxlbmFtZSBvbmx5IHJlc29sdmVzIG9uY2UgYSBkb2N1bWVudCBpcyBvcGVuKVwiO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMsIGhpbnQpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMsIGhpbnQpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICAvLyDim5QgT05MWSBBTiBBQlNPTFVURSBrZXkgaXMgYSBwYXRoICh2ZXJpZnktcGFzcyBmaXggOCk6IHJlc29sdmluZyBhXG4gICAgLy8gcmVsYXRpdmUgb25lIGhlcmUgcmVzb2x2ZWQgaXQgYWdhaW5zdCB0aGUgREFFTU9OJ3MgY3dkLiBUaGUgQ0xJIHJlc29sdmVzXG4gICAgLy8gYWdhaW5zdCBpdHMgb3duIGN3ZCBhbmQgc2VuZHMgYW4gYWJzb2x1dGUgcGF0aC5cbiAgICBpZiAoaXNBYnNvbHV0ZShrZXkpKSB7XG4gICAgICBjb25zdCBieVBhdGggPSB0aGlzLm0uZG9jcy5maW5kKFxuICAgICAgICAoZCkgPT4gZC5vcmlnaW5hbCA9PT0ga2V5IHx8IHJlYWxPcihkLm9yaWdpbmFsKSA9PT0gcmVhbE9yKGtleSksXG4gICAgICApO1xuICAgICAgaWYgKGJ5UGF0aCkgcmV0dXJuIGJ5UGF0aDtcbiAgICB9XG4gICAgY29uc3QgYnlOYW1lID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiBiYXNlbmFtZShkLm9yaWdpbmFsKSA9PT0ga2V5IHx8IGQucmVsID09PSBrZXkpO1xuICAgIHJldHVybiBieU5hbWUubGVuZ3RoID09PSAxID8gYnlOYW1lWzBdIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFRoZSBuZXh0IHZlcnNpb24gbnVtYmVyLCBjb25zdW1lZC4gTnVtYmVycyBhcmUgbmV2ZXIgcmV1c2VkIChFNDEpLiAqL1xuICBwcml2YXRlIHRha2VWZXJzaW9uKGQ6IERvY1JlY29yZCk6IG51bWJlciB7XG4gICAgY29uc3QgbiA9IGQubmV4dFZlcnNpb24gPz8gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBkLm5leHRWZXJzaW9uID0gbiArIDE7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICBwcml2YXRlIHZlcnNpb25PckRpZShkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+IHtcbiAgICBjb25zdCB2ID0gZC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm4gPT09IG4pO1xuICAgIGlmICghdilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIHYke259YCxcbiAgICAgICAgNDA0LFxuICAgICAgICBkLnZlcnNpb25zLm1hcCgoeCkgPT4gYHYke3gubn1gKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHY7XG4gIH1cblxuICBwcml2YXRlIHNsdWdGb3Iob3JpZ2luYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlbSA9XG4gICAgICBiYXNlbmFtZShvcmlnaW5hbCwgZXh0bmFtZShvcmlnaW5hbCkpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOV8tXSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwiZG9jXCI7XG4gICAgbGV0IHNsdWcgPSBzdGVtO1xuICAgIGZvciAobGV0IGkgPSAyOyB0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHNsdWcpOyBpKyspIHNsdWcgPSBgJHtzdGVtfS0ke2l9YDtcbiAgICByZXR1cm4gc2x1ZztcbiAgfVxuXG4gIC8qKlxuICAgKiBPcGVuIGEgZG9jdW1lbnQgYnkgaXRzIG9yaWdpbmFsJ3MgcGF0aDogdjEgaXMgd3JpdHRlbiBmcm9tIHRoZSBvcmlnaW5hbFxuICAgKiB0aGUgZmlyc3QgdGltZS4gYGZvY3VzOiBmYWxzZWAgKHRoZSBhZ2VudCdzIGltcGxpY2l0IG9wZW4gdGhyb3VnaFxuICAgKiBgdmVyc2lvbi1uZXcgLS1kb2MgPHBhdGg+YCkgZG9lcyBub3QgbW92ZSB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IGZvY3VzPzogYm9vbGVhbiB9ID0ge30pOiB7IHNsdWc6IHN0cmluZzsgY3JlYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBmb2N1cyA9IG9wdHMuZm9jdXMgPz8gdHJ1ZTtcbiAgICAvLyBUaGUgY29udGV4dCdzIG93biBzcGVsbGluZyBvZiB0aGUgcGF0aDogYSBjYWxsZXIgd2hvc2UgY3dkIGlzIGEgcmVhbHBhdGhcbiAgICAvLyAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIG9yIHRocm91Z2ggYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgIC8vIGZpbGUgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgZG9jLlxuICAgIGNvbnN0IGFicyA9IHRoaXMuY2Fub25pY2FsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBleGlzdGluZy5zbHVnO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBzbHVnOiBleGlzdGluZy5zbHVnLCBjcmVhdGVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoIWlzRG9jTmFtZShhYnMpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgNDAwKTtcbiAgICBpZiAoIWxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Fic30gaXMgbm90IGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQg4oCUIGFkZCBpdCAob3IgaXRzIGZvbGRlcikgZmlyc3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghc3RhdFN5bmMoYWJzKS5pc0ZpbGUoKSkgdGhyb3cgbmV3IEVycm9yKFwibm90IGEgZmlsZVwiKTtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3Qgb3BlbiAke2Fic306IG5vIHN1Y2ggZmlsZWAsIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGV4dCA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdLmluY2x1ZGVzKGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpKVxuICAgICAgPyBleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKVxuICAgICAgOiBcIi5tZFwiO1xuICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpO1xuICAgIGNvbnN0IGQ6IERvY1JlY29yZCA9IHtcbiAgICAgIHNsdWc6IHRoaXMuc2x1Z0ZvcihhYnMpLFxuICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIG9yaWdpbmFsOiBhYnMsXG4gICAgICBlbnRyeUlkOiBhdD8uZW50cnlJZCA/PyBudWxsLFxuICAgICAgcmVsOiBhdD8ucmVsID8/IG51bGwsXG4gICAgICBleHQsXG4gICAgICB2ZXJzaW9uczogW3sgbjogMSwgYXV0aG9yOiBcImh1bWFuXCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9XSxcbiAgICAgIGFjdGl2ZTogMSxcbiAgICAgIG9yaWdpbmFsSGFzaDogY29udGVudEhhc2godGV4dCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZmFsc2UsXG4gICAgICBhZG1pdHRlZDogdHJ1ZSxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzLnB1c2goZCk7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZC5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgY3JlYXRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIGBhYnNgIGFzIHRoZSBjb250ZXh0IHNwZWxscyBpdCwgd2hlbiBpdCBpcyB0aGUgc2FtZSBmaWxlIGJ5IHJlYWxwYXRoLiAqL1xuICBwcml2YXRlIGNhbm9uaWNhbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKCFyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNwZWxsZWQgPSBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIHNwZWxsZWQpKSByZXR1cm4gc3BlbGxlZDtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIC8qKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDQg4oCUIENIRUNLIEJFRk9SRSBXUklURS4gQmVmb3JlIHRoZSBodW1hbidzIGVkaXQgaXNcbiAgICogd3JpdHRlbiwgdGhlIGZpbGUgb24gZGlzayBpcyBoYXNoZWQ6IGlmIGl0IGlzIG5vdCB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICogd3JpdGUsIHNvbWVvbmUgZWxzZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb24gKEUyKS4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgYVxuICAgKiBORVcgYWdlbnQgdmVyc2lvbiwgYW5kIG9ubHkgdGhlbiBpcyB0aGUgZWRpdCB3cml0dGVuLiBEZXRlY3Rpb24gdXNlZCB0b1xuICAgKiBkZXBlbmQgb24gdGhlIHdhdGNoZXIncyA2MCBtcyBzZXR0bGUgdGltZXIgZmlyaW5nIGJlZm9yZSB0aGUgbmV4dFxuICAgKiBrZXlzdHJva2U7IGEgYnVyc3Qgb2YgZWRpdHMgYXQgMzAgbXMgY2xvYmJlcmVkIGFuIG91dHNpZGUgd3JpdGVcbiAgICogdW5hbm5vdW5jZWQuIE5vdyBub3RoaW5nIGlzIGxvc3Qgd2hhdGV2ZXIgdGhlIHRpbWluZyDigJQgdGhlIG9uZSB3aW5kb3cgbGVmdFxuICAgKiBpcyB0aGUgbWljcm9zZWNvbmRzIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGlzIHdyaXRlLlxuICAgKi9cbiAgZWRpdChcbiAgICBzbHVnOiBzdHJpbmcsXG4gICAgbjogbnVtYmVyLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgKTogeyBkaXJ0eUNoYW5nZWQ6IGJvb2xlYW47IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgaWYgKG4gIT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke259IGlzIG5vdCB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9ICh2JHtkLmFjdGl2ZX0gaXMpIOKAlCBvbmx5IHRoZSBhY3RpdmUgdmVyc2lvbiBpcyBlZGl0YWJsZWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0RpcnR5KGQpO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIC8vIFRoZSBlZGl0IGlzIHN0YWdlZCBpbiBhIHNpYmxpbmcgZmlsZSBGSVJTVCwgc28gdGhlIGNoZWNrIGJlbG93IGFuZCB0aGVcbiAgICAvLyByZW5hbWUgdGhhdCBsYW5kcyB0aGUgZWRpdCBhcmUgYWRqYWNlbnQgc3lzY2FsbHM6IHRoZSB3aW5kb3cgaW4gd2hpY2ggYW5cbiAgICAvLyBvdXRzaWRlIHdyaXRlIGNvdWxkIHNsaXAgYmV0d2VlbiB0aGVtIGlzIG1pY3Jvc2Vjb25kcywgbm90IHRoZSBsZW5ndGggb2ZcbiAgICAvLyBhIG11bHRpLW1lZ2FieXRlIHdyaXRlIOKAlCBhbmQgYSB3cml0ZSBsYW5kaW5nIEFGVEVSIHRoZSByZW5hbWUgZ29lcyB0byB0aGVcbiAgICAvLyBuZXcgZmlsZSwgd2hlcmUgdGhlIHdhdGNoZXIgZmluZHMgaXQgYW5kIHByZXNlcnZlcyBpdCB0b28uXG4gICAgY29uc3Qgc3RhZ2VkID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0uZWRpdGA7XG4gICAgd3JpdGVGaWxlU3luYyhzdGFnZWQsIHRleHQpO1xuICAgIGxldCBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb25EaXNrOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgb25EaXNrID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIG9uRGlzayA9IG51bGw7XG4gICAgfVxuICAgIGlmIChvbkRpc2sgIT09IG51bGwgJiYgIXRoaXMuaXNPd25Xcml0ZShwYXRoLCBvbkRpc2spKVxuICAgICAgcHJlc2VydmVkID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgb25EaXNrKTtcbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgcmVuYW1lU3luYyhzdGFnZWQsIHBhdGgpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpLCBwcmVzZXJ2ZWQgfTtcbiAgfVxuXG4gIC8qKiBDb3B5IGEgdmVyc2lvbiB0byBhIG5ldyBmaWxlOyB0aGUgYWdlbnQgdGhlbiBlZGl0cyB0aGF0IGZpbGUgd2l0aCBpdHMgb3duIHRvb2xzLiAqL1xuICBuZXdWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBmcm9tPzogbnVtYmVyOyBsYWJlbD86IHN0cmluZzsgYXV0aG9yOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IFZlcnNpb247XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBmcm9tID0gb3B0cy5mcm9tID8/IGQuYWN0aXZlO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIGZyb20pO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBmcm9tKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IG4gPSB0aGlzLnRha2VWZXJzaW9uKGQpO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBvcHRzLmF1dGhvcixcbiAgICAgIGZyb20sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAuLi4ob3B0cy5sYWJlbCA/IHsgbGFiZWw6IG9wdHMubGFiZWwgfSA6IHt9KSxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAoRTQxKS5cbiAgICpcbiAgICog4puUIFRIRSBBQ1RJVkUgVkVSU0lPTiBDQU5OT1QgQkUgREVMRVRFRCwgYW5kIHJlZnVzaW5nIGlzIGJldHRlciB0aGFuXG4gICAqIHBpY2tpbmcgYSByZXBsYWNlbWVudDogY2hvb3Npbmcgb25lIGZvciB0aGUgaHVtYW4gd291bGQgc2lsZW50bHkgbW92ZVxuICAgKiB3aGVyZSB0aGVpciBlZGl0cyBhbmQgU2F2ZSBhcmUgcG9pbnRlZCwgd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBFMiBhbmQgRTdcbiAgICogZXhpc3QgdG8ga2VlcCBleHBsaWNpdC4gQmVjYXVzZSBleGFjdGx5IG9uZSB2ZXJzaW9uIGlzIGFsd2F5cyBhY3RpdmUsIHRoaXNcbiAgICogYWxzbyBtZWFucyB0aGUgbGFzdCB2ZXJzaW9uIGNhbiBuZXZlciBiZSBkZWxldGVkIOKAlCBhIGRvY3VtZW50IGFsd2F5cyBoYXNcbiAgICogc29tZXRoaW5nIHRvIGVkaXQsIHdpdGhvdXQgdGhhdCBiZWluZyBhIHNlY29uZCBydWxlLlxuICAgKlxuICAgKiBgZnJvbWAgcG9pbnRlcnMgb24gT1RIRVIgdmVyc2lvbnMgYXJlIGxlZnQgYXMgdGhleSBhcmUuIFwiTWFkZSBmcm9tIHYyXCJcbiAgICogc3RheXMgdHJ1ZSBhZnRlciB2MiBpcyBnb25lOyBkZWxldGluZyBhIHZlcnNpb24gaXMgbm90IHJld3JpdGluZyB0aGVcbiAgICogaGlzdG9yeSBvZiB0aGUgb25lcyB0aGF0IHJlbWFpbi5cbiAgICovXG4gIGRlbGV0ZVZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgcmVtYWluaW5nOiBudW1iZXI7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCB2ID0gdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBpZiAob3B0cy52ZXJzaW9uID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtvcHRzLnZlcnNpb259IGlzIHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30g4oCUIGFjdGl2YXRlIGFub3RoZXIgb25lIGZpcnN0LCBgICtcbiAgICAgICAgICBgdGhlbiBkZWxldGUgdGhpc2AsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgLy8g4puUIE1BVEVSSUFMSVNFIFRIRSBDT1VOVEVSIEJFRk9SRSBSRU1PVklORyBUSEUgUkVDT1JELiBgdGFrZVZlcnNpb25gXG4gICAgLy8gZGVyaXZlcyBpdCBsYXppbHkgZnJvbSB0aGUgdmVyc2lvbnMgUFJFU0VOVCwgc28gb24gYSBkb2MgdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBhbGxvY2F0ZWQgb25lIChhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIEU0MSwgcmVzdG9yZWQpIGRlbGV0aW5nIHRoZVxuICAgIC8vIGhpZ2hlc3Qgd291bGQgbGV0IHRoZSBuZXh0IGFsbG9jYXRpb24gZGVyaXZlIHRoZSBzYW1lIG51bWJlciBhZ2Fpbi4gRm91bmRcbiAgICAvLyBieSBkcml2aW5nIGl0LCBub3QgYnkgdGhlIHVuaXQgdGVzdCBhYm92ZSDigJQgd2hpY2ggYWxsb2NhdGVkIGZpcnN0IGFuZCBzb1xuICAgIC8vIG5ldmVyIGhhZCBhIGNvbGQgY291bnRlci5cbiAgICBkLm5leHRWZXJzaW9uID8/PSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgoeCkgPT4geC5uKSkgKyAxO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG9wdHMudmVyc2lvbik7XG4gICAgZC52ZXJzaW9ucyA9IGQudmVyc2lvbnMuZmlsdGVyKCh4KSA9PiB4Lm4gIT09IG9wdHMudmVyc2lvbik7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhwYXRoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRoZSByZWNvcmQgaXMgd2hhdCB0aGUgc2Vzc2lvbiBiZWxpZXZlczsgYSBmaWxlIGFscmVhZHkgZ29uZSAoYSBoYW5kXG4gICAgICAvLyB0aWR5LCBhIGNyYXNoIGJldHdlZW4gd3JpdGUgYW5kIHJlY29yZCkgbXVzdCBub3QgYmxvY2sgcmVtb3ZpbmcgaXQuXG4gICAgfVxuICAgIHRoaXMub3duZWQuZGVsZXRlKHBhdGgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICB2ZXJzaW9uOiBvcHRzLnZlcnNpb24sXG4gICAgICAuLi4odi5sYWJlbCA/IHsgbGFiZWw6IHYubGFiZWwgfSA6IHt9KSxcbiAgICAgIHJlbWFpbmluZzogZC52ZXJzaW9ucy5sZW5ndGgsXG4gICAgfTtcbiAgfVxuXG4gIGFjdGl2YXRlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHsgc2x1Zzogc3RyaW5nOyBwcmV2aW91czogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGNvbnN0IHByZXZpb3VzID0gZC5hY3RpdmU7XG4gICAgZC5hY3RpdmUgPSBvcHRzLnZlcnNpb247XG4gICAgLy8gVGhlIG5ldyBhY3RpdmUgdmVyc2lvbidzIHRleHQgQVMgSVQgSVMgTk9XIGlzIHRoZSBiYXNlbGluZSB0aGUgbmV4dFxuICAgIC8vIGNoZWNrLWJlZm9yZS13cml0ZSBjb21wYXJlcyBhZ2FpbnN0LlxuICAgIHRoaXMuYWRvcHRBY3RpdmUoZCwgcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb21wYXJpbmcgYW5kIG1lcmdpbmcgKEUzNikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSB0ZXh0IG9mIG9uZSBzaWRlIG9mIGEgY29tcGFyaXNvbi4gYFwib3JpZ2luYWxcImAgaXMgcmVhZCBmcm9tIERJU0ssIG5vdFxuICAgKiBmcm9tIGEgY2FjaGU6IHRoZSB3aG9sZSBwb2ludCBvZiBjb21wYXJpbmcgYWdhaW5zdCBpdCBpcyB0byBzZWUgd2hhdCB0aGVcbiAgICogZmlsZSBvZiByZWNvcmQgYWN0dWFsbHkgc2F5cyByaWdodCBub3csIGluY2x1ZGluZyBhIGNoYW5nZSBzb21lb25lIGVsc2VcbiAgICogbWFkZSB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIG9wZW4uXG4gICAqL1xuICBwcml2YXRlIHNpZGVUZXh0KGQ6IERvY1JlY29yZCwgc2lkZTogRGlmZlNpZGUpOiBzdHJpbmcge1xuICAgIGlmIChzaWRlID09PSBcIm9yaWdpbmFsXCIpIHJldHVybiByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIHNpZGUpO1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBzaWRlKSwgXCJ1dGY4XCIpO1xuICB9XG5cbiAgLyoqIENvbXBhcmUgdGhlIEFDVElWRSB2ZXJzaW9uIChsZWZ0KSBhZ2FpbnN0IGFub3RoZXIgc2lkZSAocmlnaHQpLiAqL1xuICBjb21wYXJlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZSB9KTogRGlmZlBheWxvYWQge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBpZiAob3B0cy5hZ2FpbnN0ID09PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtkLmFjdGl2ZX0gaXMgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSDigJQgY29tcGFyaW5nIGl0IHdpdGggaXRzZWxmIHNheXMgbm90aGluZ2AsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgbGVmdCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiB7XG4gICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBhZ2FpbnN0OiBvcHRzLmFnYWluc3QsXG4gICAgICBkaWZmOiBkaWZmVGV4dChsZWZ0LCB0aGlzLnNpZGVUZXh0KGQsIG9wdHMuYWdhaW5zdCkpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogVGFrZSBuYW1lZCBodW5rcyBmcm9tIGBhZ2FpbnN0YCBpbnRvIHRoZSBhY3RpdmUgdmVyc2lvbi5cbiAgICpcbiAgICog4puUIFRIRSBXUklURSBHT0VTIFRIUk9VR0ggYGVkaXRgLCB3aGljaCBpcyB3aGF0IG1ha2VzIGEgbWVyZ2Ugb2JleSBldmVyeVxuICAgKiBydWxlIGFuIG9yZGluYXJ5IGtleXN0cm9rZSBvYmV5czogaXQgbGFuZHMgb24gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFuZCBuZXZlclxuICAgKiB0aGUgb3JpZ2luYWwgKEU3KSwgYW5kIGNoZWNrLWJlZm9yZS13cml0ZSBwcmVzZXJ2ZXMgYW4gb3V0c2lkZSB3cml0ZSBhcyBhXG4gICAqIG5ldyB2ZXJzaW9uIGZpcnN0IChFMikuIEEgbWVyZ2Ugd3JpdGluZyB0aGUgZmlsZSBkaXJlY3RseSB3b3VsZCBiZSB0aGUgb25lXG4gICAqIHBhdGggaW50byB0aGUgZG9jdW1lbnQgdGhhdCBjb3VsZCBzaWxlbnRseSBjbG9iYmVyIHRoZSBhZ2VudC5cbiAgICovXG4gIG1lcmdlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhZ2FpbnN0OiBEaWZmU2lkZTsgaHVua3M6IG51bWJlcltdIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IG51bWJlcjtcbiAgICB0ZXh0OiBzdHJpbmc7XG4gICAgYXBwbGllZDogbnVtYmVyO1xuICAgIHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGw7XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBwYXlsb2FkID0gdGhpcy5jb21wYXJlKHsgZG9jOiBkLnNsdWcsIGFnYWluc3Q6IG9wdHMuYWdhaW5zdCB9KTtcbiAgICBjb25zdCBrbm93biA9IG5ldyBTZXQocGF5bG9hZC5kaWZmLmh1bmtzLm1hcCgoaCkgPT4gaC5pZCkpO1xuICAgIGNvbnN0IG1pc3NpbmcgPSBvcHRzLmh1bmtzLmZpbHRlcigoaWQpID0+ICFrbm93bi5oYXMoaWQpKTtcbiAgICBpZiAobWlzc2luZy5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyBodW5rICR7bWlzc2luZy5qb2luKFwiLCBcIil9IGFnYWluc3QgJHtzaWRlTmFtZShvcHRzLmFnYWluc3QsIGQubmFtZSl9IOKAlCBgICtcbiAgICAgICAgICBgaXQgaGFzICR7a25vd24uc2l6ZSA9PT0gMCA/IFwibm9uZVwiIDogYDEuLiR7TWF0aC5tYXgoLi4ua25vd24pfWB9LiBSdW4gZGlmZiBhZ2FpbjogYCArXG4gICAgICAgICAgYHRoZSB0ZXh0IGNoYW5nZWQgdW5kZXIgdGhlIG51bWJlcnMuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICBjb25zdCB0ZXh0ID0gYXBwbHlIdW5rcyhiZWZvcmUsIHBheWxvYWQuZGlmZi5odW5rcywgb3B0cy5odW5rcyk7XG4gICAgY29uc3QgeyBwcmVzZXJ2ZWQgfSA9IHRoaXMuZWRpdChkLnNsdWcsIGQuYWN0aXZlLCB0ZXh0KTtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICB0ZXh0LFxuICAgICAgYXBwbGllZDogb3B0cy5odW5rcy5maWx0ZXIoKGlkKSA9PiBrbm93bi5oYXMoaWQpKS5sZW5ndGgsXG4gICAgICBwcmVzZXJ2ZWQsXG4gICAgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBub3RlcyAoRTQ1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogVGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCDigJQgd2hhdCBldmVyeSBub3RlIGlzIGFuY2hvcmVkIGFnYWluc3QuICovXG4gIHByaXZhdGUgYWN0aXZlVGV4dChkOiBEb2NSZWNvcmQpOiBzdHJpbmcge1xuICAgIHJldHVybiByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgfVxuXG4gIC8qKiBQbGFjZSBldmVyeSBub3RlIGluIHRoZSBhY3RpdmUgdGV4dCBhcyBpdCBzdGFuZHMgbm93LiAqL1xuICBwcml2YXRlIHBsYWNlZE5vdGVzKGQ6IERvY1JlY29yZCk6IFBsYWNlZE5vdGVbXSB7XG4gICAgY29uc3Qgbm90ZXMgPSBkLm5vdGVzID8/IFtdO1xuICAgIGlmIChub3Rlcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5hY3RpdmVUZXh0KGQpO1xuICAgIHJldHVybiBub3Rlcy5tYXAoKG4pID0+ICh7IC4uLm4sIC4uLmZpbmRBbmNob3IodGV4dCwgbikgfSkpO1xuICB9XG5cbiAgLyoqXG4gICAqIE5vdGUgYSByYW5nZSBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0ICh0aGUgaHVtYW4gc2VsZWN0cykgb3IgYSBxdW90ZVxuICAgKiBmb3VuZCBpbiBpdCAodGhlIGFnZW50IHF1b3RlcyDigJQgaXQgaGFzIG5vIG9mZnNldHMpLlxuICAgKi9cbiAgYWRkTm90ZShvcHRzOiB7XG4gICAgZG9jPzogc3RyaW5nO1xuICAgIGJvZHk6IHN0cmluZztcbiAgICB3aG86IFZlcnNpb25BdXRob3I7XG4gICAgcmFuZ2U/OiB7IGZyb206IG51bWJlcjsgdG86IG51bWJlciB9O1xuICAgIHF1b3RlPzogc3RyaW5nO1xuICB9KTogeyBzbHVnOiBzdHJpbmc7IG5vdGU6IE5vdGU7IGhvdzogXCJzZWxlY3Rpb25cIiB8IFwicXVvdGVcIiB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgYm9keSA9IG9wdHMuYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwiYSBub3RlIG5lZWRzIHNvbWV0aGluZyB3cml0dGVuIGluIGl0XCIsIDQwMCk7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuYWN0aXZlVGV4dChkKTtcblxuICAgIGxldCBhbmNob3I6IEFuY2hvcjtcbiAgICBpZiAob3B0cy5yYW5nZSkge1xuICAgICAgY29uc3QgeyBmcm9tLCB0byB9ID0gb3B0cy5yYW5nZTtcbiAgICAgIGlmIChmcm9tIDwgMCB8fCB0byA+IHRleHQubGVuZ3RoIHx8IGZyb20gPj0gdG8pXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7ZnJvbX0uLiR7dG99IGlzIG5vdCBhIHJhbmdlIGluIHYke2QuYWN0aXZlfSBvZiAke2Quc2x1Z30gKCR7dGV4dC5sZW5ndGh9IGNoYXJhY3RlcnMpYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICk7XG4gICAgICBhbmNob3IgPSBhbmNob3JPZih0ZXh0LCBmcm9tLCB0byk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHF1b3RlID0gb3B0cy5xdW90ZSA/PyBcIlwiO1xuICAgICAgaWYgKCFxdW90ZSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBhIHNlbGVjdGlvbiBvciBhIHF1b3RlXCIsIDQwMCk7XG4gICAgICBjb25zdCBhdCA9IHRleHQuaW5kZXhPZihxdW90ZSk7XG4gICAgICAvLyDim5QgUkVGVVNFRCwgbm90IGFuY2hvcmVkIGhvcGVmdWxseS4gQSBxdW90ZSB0aGUgYWN0aXZlIHZlcnNpb24gZG9lcyBub3RcbiAgICAgIC8vIGNvbnRhaW4gd291bGQgYmVjb21lIGFuIG9ycGhhbiB0aGUgbW9tZW50IGl0IHdhcyBtYWRlLCB3aGljaCByZWFkcyBhc1xuICAgICAgLy8gXCJ0aGUgdGV4dCBjaGFuZ2VkXCIgd2hlbiB0aGUgdHJ1dGggaXMgXCJ5b3UgcXVvdGVkIHNvbWV0aGluZyBlbHNlXCIuXG4gICAgICBpZiAoYXQgPT09IC0xKVxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB2JHtkLmFjdGl2ZX0gb2YgJHtkLnNsdWd9IGRvZXMgbm90IGNvbnRhaW4gdGhhdCB0ZXh0IOKAlCBxdW90ZSBpdCBleGFjdGx5IGFzIGl0IGFwcGVhcnNgLFxuICAgICAgICAgIDQwNCxcbiAgICAgICAgKTtcbiAgICAgIGFuY2hvciA9IGFuY2hvck9mKHRleHQsIGF0LCBhdCArIHF1b3RlLmxlbmd0aCk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm90ZTogTm90ZSA9IHtcbiAgICAgIGlkOiBgbiR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA2KX1gLFxuICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAuLi5hbmNob3IsXG4gICAgICBib2R5LFxuICAgICAgd2hvOiBvcHRzLndobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIHJlc29sdmVkOiBmYWxzZSxcbiAgICB9O1xuICAgIGQubm90ZXMgPSBbLi4uKGQubm90ZXMgPz8gW10pLCBub3RlXTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUsIGhvdzogb3B0cy5yYW5nZSA/IFwic2VsZWN0aW9uXCIgOiBcInF1b3RlXCIgfTtcbiAgfVxuXG4gIC8qKiBOb3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQg4oCUIGBhbGxgIGluY2x1ZGVzIHRoZSByZXNvbHZlZCBvbmVzLiAqL1xuICBub3Rlc09mKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBhbGw/OiBib29sZWFuIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZXM6IFBsYWNlZE5vdGVbXSB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgcGxhY2VkID0gdGhpcy5wbGFjZWROb3RlcyhkKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGVzOiBvcHRzLmFsbCA/IHBsYWNlZCA6IHBsYWNlZC5maWx0ZXIoKG4pID0+ICFuLnJlc29sdmVkKSB9O1xuICB9XG5cbiAgcHJpdmF0ZSBub3RlT3JEaWUoZDogRG9jUmVjb3JkLCBpZDogc3RyaW5nKTogTm90ZSB7XG4gICAgY29uc3Qgbm90ZSA9IChkLm5vdGVzID8/IFtdKS5maW5kKChuKSA9PiBuLmlkID09PSBpZCk7XG4gICAgaWYgKCFub3RlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gbm90ZSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgKGQubm90ZXMgPz8gW10pLm1hcCgobikgPT4gbi5pZCksXG4gICAgICApO1xuICAgIHJldHVybiBub3RlO1xuICB9XG5cbiAgLyoqIENoYW5nZSB3aGF0IGEgbm90ZSBTQVlTLiBJdHMgYW5jaG9yIGlzIHVudG91Y2hlZCDigJQgaXQgaXMgc3RpbGwgYWJvdXQgdGhlXG4gICAqICBzYW1lIHBhc3NhZ2UsIHdoaWNoIGlzIHdoeSBlZGl0aW5nIGRvZXMgbm90IHJlLXF1b3RlIChFNDYpLiAqL1xuICBlZGl0Tm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgYm9keTogc3RyaW5nIH0pOiB7IHNsdWc6IHN0cmluZzsgbm90ZTogTm90ZSB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3Qgbm90ZSA9IHRoaXMubm90ZU9yRGllKGQsIG9wdHMuaWQpO1xuICAgIGNvbnN0IGJvZHkgPSBvcHRzLmJvZHkudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgbm90ZSBuZWVkcyBzb21ldGhpbmcgd3JpdHRlbiBpbiBpdFwiLCA0MDApO1xuICAgIG5vdGUuYm9keSA9IGJvZHk7XG4gICAgbm90ZS5lZGl0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBub3RlIH07XG4gIH1cblxuICByZXNvbHZlTm90ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgaWQ6IHN0cmluZzsgcmVzb2x2ZWQ6IGJvb2xlYW4gfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgbm90ZTogTm90ZTtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IG5vdGUgPSB0aGlzLm5vdGVPckRpZShkLCBvcHRzLmlkKTtcbiAgICBub3RlLnJlc29sdmVkID0gb3B0cy5yZXNvbHZlZDtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIG5vdGUgfTtcbiAgfVxuXG4gIHJlbW92ZU5vdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IGlkOiBzdHJpbmcgfSk6IHsgc2x1Zzogc3RyaW5nOyBub3RlOiBOb3RlIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBub3RlID0gdGhpcy5ub3RlT3JEaWUoZCwgb3B0cy5pZCk7XG4gICAgZC5ub3RlcyA9IChkLm5vdGVzID8/IFtdKS5maWx0ZXIoKG4pID0+IG4uaWQgIT09IG9wdHMuaWQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1Zywgbm90ZSB9O1xuICB9XG5cbiAgLyoqIFNhdmU6IHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgb3ZlciB0aGUgb3JpZ2luYWwuIFRoZSBPTkxZIHdyaXRlIHRvIGl0IChFNykuICovXG4gIHNhdmUoc2x1Zzogc3RyaW5nKTogeyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYzogU2F2ZSB3cml0ZXMgb25seSBhbiBvcmlnaW5hbCBhZG1pdHRlZCBieVxuICAgIC8vIGBvcGVuUGF0aGAgKGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5KS4gQ2hlY2tlZCBhZ2FpbiBoZXJlXG4gICAgLy8gc28gbm8gb3RoZXIgcGF0aCBpbnRvIHRoZSBtYW5pZmVzdCDigJQgYSBoYW5kLWVkaXRlZCBvbmUsIGEgZnV0dXJlIHZlcmIg4oCUXG4gICAgLy8gY2FuIHR1cm4gU2F2ZSBpbnRvIFwid3JpdGUgYW55IGZpbGVcIi5cbiAgICBpZiAoIWQuYWRtaXR0ZWQgfHwgIWlzRG9jTmFtZShkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBzYXZlICR7ZC5vcmlnaW5hbH06IGl0IHdhcyBub3Qgb3BlbmVkIGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICB0aGlzLndyaXRlT3duZWQoZC5vcmlnaW5hbCwgdGV4dCk7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgb3JpZ2luYWw6IGQub3JpZ2luYWwsIHZlcnNpb246IGQuYWN0aXZlIH07XG4gIH1cblxuICAvKiogUmV2ZXJ0OiB0aGUgb3JpZ2luYWwncyB0ZXh0IGJhY2sgb3ZlciB0aGUgYWN0aXZlIHZlcnNpb24uICovXG4gIHJldmVydChzbHVnOiBzdHJpbmcpOiB7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIGlmIChuID09PSBkLmFjdGl2ZSkge1xuICAgICAgICAvLyBFMiwgcmVmdXNlZCBhbmQgUkUtTEFCRUxMRUQ6IHRoZSBvdXRzaWRlIHRleHQgYmVjb21lcyBhIG5ldyBhZ2VudFxuICAgICAgICAvLyB2ZXJzaW9uLCBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uIGdvZXMgYmFjayB0byB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICAgICAgLy8gdGV4dCDigJQgc28gdGhlIGFjdGl2ZSB2ZXJzaW9uIG9ubHkgZXZlciBob2xkcyB3aGF0IHRoZSBodW1hbiB0eXBlZCxcbiAgICAgICAgLy8gYW5kIG5vdGhpbmcgYW55b25lIHdyb3RlIGlzIGxvc3QgKHZlcmlmeS1wYXNzIGZpeCA0LCB3YXRjaGVyIGhhbGYpLlxuICAgICAgICBjb25zdCBrZXB0ID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGhpcy5sYXN0QWN0aXZlVGV4dC5nZXQoZC5zbHVnKSA/PyB0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogbixcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgcHJlc2VydmVkQXM6IGtlcHQubixcbiAgICAgICAgICBwcmVzZXJ2ZWRQYXRoOiBrZXB0LnBhdGgsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCB0ZXh0LCBhY3RpdmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIOKAlCBieSBpdHMgc3RvcmVkIHBhdGgsIG9yIGJ5IHJlYWxwYXRoIGZvciBhIHN5bWxpbms/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyB8fCByZWFsT3IoeC5vcmlnaW5hbCkgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGQub3V0c2lkZUNoYW5nZWQpIHJldHVybiBudWxsOyAvLyBhbHJlYWR5IGFza2VkXG4gICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBzdHJ1Y3R1cmUgKEUyMuKAk0UyNCk6IHJlYWwgY2hhbmdlcyBvbiBkaXNrLCBvbmUgcGF0aCBmb3IgYm90aCBwYXJ0aWVzIOKUgOKUgFxuICAvL1xuICAvLyBFdmVyeSBtZXRob2QgYmVsb3cgZG9lcyB0aGUgY2hhbmdlIE9OIERJU0sgYW5kIHRoZW4gYnJpbmdzIHRoZSBjb250ZXh0XG4gIC8vIG1vZGVsIGJhY2sgaW4gbGluZSB3aXRoIGl0LiBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZW0gdGhyb3VnaCBtZW51cyBhbmRcbiAgLy8gZHJhZyBhbmQgZHJvcCwgdGhlIGFnZW50IHRocm91Z2ggQ0xJIHZlcmJzOyB0aGUgZGFlbW9uIGFubm91bmNlcyBlYWNoIG9uZVxuICAvLyB1bmRlciB0aGUgbmFtZSBvZiB3aG9ldmVyIGRpZCBpdC4gVHdvIHJ1bGVzIGhvbGQgdGhyb3VnaG91dDpcbiAgLy9cbiAgLy8gLSBOT1RISU5HIElTIERFTEVURUQuIGBoaWRlYCB0YWtlcyBhIG5vZGUgb3V0IG9mIFNjcmlwdG9yaXVtOyB0aGUgZmlsZSBzdGF5cy5cbiAgLy8gLSBOT1RISU5HIElTIE9WRVJXUklUVEVOLiBBIGRlc3RpbmF0aW9uIHRoYXQgZXhpc3RzIGlzIHJlZnVzZWQgKGFuIGV4cGxpY2l0XG4gIC8vICAgbmFtZSkgb3IgZ2l2ZW4gYSBmcmVlIG5hbWUgKGEgZGVmYXVsdCBvbmUsIGEgZHJvcCk7IGZpbGVzIGFyZSBjcmVhdGVkXG4gIC8vICAgd2l0aCB0aGUgZXhjbHVzaXZlIGZsYWcsIHNvIGEgcmFjZSBjYW5ub3QgY2xvYmJlciBlaXRoZXIuXG5cbiAgLyoqIEUyMzogd2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQuICovXG4gIGdldCB3b3Jrc3BhY2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLndvcmtzcGFjZSA/PyBob21lZGlyKCk7XG4gIH1cblxuICBzZXRXb3Jrc3BhY2UocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzdWNoIGZvbGRlcjogJHthYnN9YCwgNDA0KTtcbiAgICB9XG4gICAgaWYgKCFpc0RpcikgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGhlIHdvcmtzcGFjZSBtdXN0IGJlIGEgZm9sZGVyOiAke2Fic31gLCA0MDApO1xuICAgIHRoaXMubS53b3Jrc3BhY2UgPSBhYnM7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogSG93IGEgcGF0aCByZWFkcyBpbiBhIGNoYXQgbGluZTogYHNldC9yZWxgIGluc2lkZSBhIHNldCwgYSBzaW5nbGVcbiAgICogZG9jdW1lbnQncyBmaWxlIG5hbWUsIGB3b3Jrc3BhY2Uv4oCmYCBpbiB0aGUgd29ya3NwYWNlLCBlbHNlIGB+L+KApmAuXG4gICAqL1xuICBkaXNwbGF5KGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikge1xuICAgICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBlLmxhYmVsO1xuICAgICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkgcmV0dXJuIGAke2UubGFiZWx9LyR7dG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpfWA7XG4gICAgICB9IGVsc2UgaWYgKGUubm9kZXMuc29tZSgobikgPT4gam9pbihlLnJvb3QsIG4ucmVsKSA9PT0gYWJzKSkgcmV0dXJuIGUubGFiZWw7XG4gICAgfVxuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLndvcmtzcGFjZSArIHNlcCkpXG4gICAgICByZXR1cm4gYHdvcmtzcGFjZS8ke3RvUG9zaXgocmVsYXRpdmUodGhpcy53b3Jrc3BhY2UsIGFicykpfWA7XG4gICAgY29uc3QgaG9tZSA9IGhvbWVkaXIoKTtcbiAgICByZXR1cm4gYWJzID09PSBob21lID8gXCJ+XCIgOiBhYnMuc3RhcnRzV2l0aChob21lICsgc2VwKSA/IGB+JHthYnMuc2xpY2UoaG9tZS5sZW5ndGgpfWAgOiBhYnM7XG4gIH1cblxuICAvKipcbiAgICogYGFic2Agc3BlbGxlZCB0aGUgd2F5IHRoZSBjb250ZXh0IHNwZWxscyBpdC4gQSBjYWxsZXIgd2hvc2UgY3dkIGlzIGFcbiAgICogcmVhbHBhdGggKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAqIHBsYWNlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIG5vZGUuXG4gICAqL1xuICBwcml2YXRlIHNwZWxsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5tLmNvbnRleHQuc29tZSgoZSkgPT4gYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmIChyZWFsID09PSByZWFsUm9vdCkgcmV0dXJuIGUucm9vdDtcbiAgICAgIGlmIChyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSByZXR1cm4gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBwcml2YXRlIGlzV29ya3NwYWNlKGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGFicyA9PT0gdGhpcy53b3Jrc3BhY2UgfHwgcmVhbE9yKGFicykgPT09IHJlYWxPcih0aGlzLndvcmtzcGFjZSk7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIGVudHJ5IHRoYXQgY292ZXJzIGBhYnNgIChpdHMgcm9vdCwgb3IgYW55dGhpbmcgdW5kZXIgaXQpLCBpZiBhbnkuICovXG4gIHByaXZhdGUgY292ZXJpbmdFbnRyeShhYnM6IHN0cmluZywgZXhjZXB0Pzogc3RyaW5nKTogQ29udGV4dEVudHJ5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLmlkICE9PSBleGNlcHQgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiZcbiAgICAgICAgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQSBmb2xkZXIgdGhpbmdzIG1heSBiZSBtYWRlIGluIG9yIG1vdmVkIGludG86IGEgbWlycm9yZWQgZW50cnkncyByb290LCBhXG4gICAqIHZpc2libGUgZm9sZGVyIHVuZGVyIG9uZSwgb3IgdGhlIHdvcmtzcGFjZS4gUmV0dXJucyB0aGUgYWJzb2x1dGUgZm9sZGVyO1xuICAgKiByZWZ1c2VzIGFueXRoaW5nIGVsc2Ug4oCUIHRoZSBjb250ZXh0IHN0YXlzIHRoZSB3YXkgaW4gKHZlcmlmeS1wYXNzIGZpeCAxYikuXG4gICAqL1xuICBwcml2YXRlIGRlc3RpbmF0aW9uT3JEaWUocmF3RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdEaXIpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgY29udGludWU7XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBhYnM7XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGU/LmtpbmQgPT09IFwiZ3JvdXBcIikgcmV0dXJuIGFicztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuaXNXb3Jrc3BhY2UoYWJzKSkgcmV0dXJuIHRoaXMud29ya3NwYWNlO1xuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICBgJHthYnN9IGlzIG5vdCBhIGZvbGRlciBpbiB0aGlzIHNlc3Npb24g4oCUIG5hbWUgYSBzZXQsIGEgZm9sZGVyIGluc2lkZSBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UgKCR7dGhpcy53b3Jrc3BhY2V9KWAsXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG9yIGZvbGRlciBzaG93biBpbiB0aGUgY29udGV4dCwgd2l0aCB3aGVyZSBpdCBpcyBzaG93bi4gKi9cbiAgcHJpdmF0ZSBpdGVtT3JEaWUocmF3UGF0aDogc3RyaW5nKToge1xuICAgIGFiczogc3RyaW5nO1xuICAgIGVudHJ5OiBDb250ZXh0RW50cnk7XG4gICAgLyoqIFRoZSB3aG9sZSBlbnRyeSAoYSBzZXQncyBvd24gZm9sZGVyLCBhIGxpc3RlZCBkb2N1bWVudCksIG9yIGEgbm9kZSBpbnNpZGUgYSBzZXQuICovXG4gICAgd2hvbGU6IGJvb2xlYW47XG4gICAgZGlyOiBib29sZWFuO1xuICB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAxICYmIG9ubHk/LmtpbmQgPT09IFwiZG9jXCIgJiYgam9pbihlLnJvb3QsIG9ubHkucmVsKSA9PT0gYWJzKVxuICAgICAgICAgIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IGZhbHNlIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiB0cnVlIH07XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGUpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiBmYWxzZSwgZGlyOiBub2RlLmtpbmQgPT09IFwiZ3JvdXBcIiB9O1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHRgLCA0MDQpO1xuICB9XG5cbiAgLyoqXG4gICAqIGByYXdQYXRoYCBpZiB0aGUgY29udGV4dCBzaG93cyBpdCDigJQgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gYSBzZXQsIGFcbiAgICogbGlzdGVkIGRvY3VtZW50LCBhIHNldCdzIG93biBmb2xkZXIg4oCUIG9yIGl0IGlzIHRoZSB3b3Jrc3BhY2U7IHJlZnVzZWRcbiAgICogb3RoZXJ3aXNlLiBGb3IgYWN0cyB0aGF0IHJlYWNoIG91dHNpZGUgdGhlIHNwZWxsIChyZXZlYWxpbmcgYSBwYXRoIGluIHRoZVxuICAgKiBmaWxlIG1hbmFnZXIpLCBzbyBhIHBhZ2UgY2Fubm90IGFpbSB0aGVtIGF0IGFuIGFyYml0cmFyeSBwYXRoLlxuICAgKi9cbiAgc2hvd25QYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBpZiAodGhpcy5pdGVtQXQoYWJzKSkgcmV0dXJuIGFicztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdGluYXRpb25PckRpZShhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb25gLCA0MDApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZWZ1c2UgYSBuYW1lIHRoYXQgaXMgbm90IG9uZSBwbGFpbiBmaWxlIG9yIGZvbGRlciBuYW1lLiAqL1xuICBwcml2YXRlIG5hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgICBpZiAoXG4gICAgICBuID09PSBcIlwiIHx8XG4gICAgICBuID09PSBcIi5cIiB8fFxuICAgICAgbiA9PT0gXCIuLlwiIHx8XG4gICAgICBuLnN0YXJ0c1dpdGgoXCIuXCIpIHx8XG4gICAgICAvWy9cXFxcXFwwXS8udGVzdChuKSB8fFxuICAgICAgbi5sZW5ndGggPiAyNTVcbiAgICApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgXCIke25hbWV9XCIgaXMgbm90IGEgdXNhYmxlIG5hbWUg4oCUIG9uZSBwbGFpbiBuYW1lLCBubyBzbGFzaGVzLCBub3Qgc3RhcnRpbmcgd2l0aCBhIGRvdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBuYW1lOiBhIG5hbWUgd2l0aG91dCBhIGRvY3VtZW50IGV4dGVuc2lvbiBnZXRzIGAubWRgLiAqL1xuICBwcml2YXRlIGRvY05hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICByZXR1cm4gaXNEb2NOYW1lKG4pID8gbiA6IGAke259Lm1kYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciBzb21ldGhpbmcgbW92ZWQgb24gZGlzayBmcm9tIGBmcm9tYCB0byBgdG9gLCBicmluZyB0aGUgbW9kZWwgd2l0aCBpdDpcbiAgICogb3BlbmVkIGRvY3VtZW50cyBrZWVwIHRoZWlyIHZlcnNpb25zIHVuZGVyIHRoZSBuZXcgcGF0aCwgZW50cmllcyByb290ZWQgYXRcbiAgICogb3IgaG9sZGluZyB0aGUgbW92ZWQgdGhpbmcgZm9sbG93IGl0LCBhbmQgZXZlcnkgbWlycm9yIGlzIHJlLXJlYWQuIEFuIGVudHJ5XG4gICAqIHRoYXQgbm93IHNpdHMgaW5zaWRlIGFub3RoZXIgc2V0IGlzIGRyb3BwZWQg4oCUIHRoZSBzZXQgc2hvd3MgaXQgYWxyZWFkeS5cbiAgICovXG4gIHByaXZhdGUgZm9sbG93TW92ZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBtb3ZlZCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+XG4gICAgICBwID09PSBmcm9tID8gdG8gOiBwLnN0YXJ0c1dpdGgoZnJvbSArIHNlcCkgPyB0byArIHAuc2xpY2UoZnJvbS5sZW5ndGgpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGQub3JpZ2luYWwpO1xuICAgICAgaWYgKG5vdykge1xuICAgICAgICBkLm9yaWdpbmFsID0gbm93O1xuICAgICAgICBkLm5hbWUgPSBiYXNlbmFtZShub3cpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBkcm9wID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAob25seT8ua2luZCAhPT0gXCJkb2NcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGpvaW4oZS5yb290LCBvbmx5LnJlbCkpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IGRpcm5hbWUobm93KTtcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KTtcbiAgICAgICAgICBlLm5vZGVzID0gW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShub3cpIH1dO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChlLnJvb3QpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IG5vdztcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KSB8fCBub3c7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5tLmNvbnRleHQgPSB0aGlzLm0uY29udGV4dC5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQWZ0ZXIgYSBmaWxlIG9yIGZvbGRlciBsYW5kZWQgYXQgYGFic2A6IHJlLXJlYWQgdGhlIHNldCBpdCBpcyBpbiwgb3IgZ2l2ZSBpdCBhbiBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBhZG9wdE5ldyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHNldCA9IHRoaXMuY292ZXJpbmdFbnRyeShhYnMpO1xuICAgIGlmIChzZXQpIHRoaXMucmVzY2FuKHNldC5pZCk7XG4gICAgZWxzZSB0aGlzLm0uY29udGV4dC5wdXNoKGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBIG5hbWUgaW4gYGRpcmAgdGhhdCBpcyBmcmVlOiBgbmFtZWAsIGVsc2UgYHN0ZW0gMi5leHRgLCBgc3RlbSAzLmV4dGAsIOKApiAqL1xuICBwcml2YXRlIGZyZWVOYW1lKGRpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGlzRGlyOiBib29sZWFuKTogc3RyaW5nIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG5hbWUpKSkgcmV0dXJuIG5hbWU7XG4gICAgY29uc3QgZXh0ID0gaXNEaXIgPyBcIlwiIDogZXh0bmFtZShuYW1lKTtcbiAgICBjb25zdCBzdGVtID0gZXh0ID8gbmFtZS5zbGljZSgwLCAtZXh0Lmxlbmd0aCkgOiBuYW1lO1xuICAgIGZvciAobGV0IGkgPSAyOyA7IGkrKykge1xuICAgICAgY29uc3QgbiA9IGAke3N0ZW19ICR7aX0ke2V4dH1gO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuKSkpIHJldHVybiBuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVmdXNlRXhpc3RpbmcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZXhpc3RzU3luYyhhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGFscmVhZHkgZXhpc3RzIOKAlCBub3RoaW5nIHdhcyBvdmVyd3JpdHRlbmAsIDQwOSk7XG4gIH1cblxuICBjcmVhdGVEb2MocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmaWxlID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIlVudGl0bGVkLm1kXCIsIGZhbHNlKSA6IHRoaXMuZG9jTmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmaWxlKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIFwiXCIsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIGNyZWF0ZUZvbGRlcihyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZvbGRlciA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJOZXcgZm9sZGVyXCIsIHRydWUpIDogdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZvbGRlcik7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIG1rZGlyU3luYyhhYnMpO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjY6IHdoYXQgYSBtb3ZlIFdPVUxEIGRvLCBmb3IgdGhlIGNvbmZpcm1hdGlvbiB0aGUgc3VyZmFjZSBzaG93cyBiZWZvcmVcbiAgICogbW92aW5nIGEgRk9MREVSLiBSZWFkcyBub3RoaW5nIGJ1dCB0aGUgZGlzayBhbmQgcmVmdXNlcyBleGFjdGx5IHdoYXRcbiAgICogYG1vdmVgIHdvdWxkIHJlZnVzZSwgc28gYSBjb25maXJtZWQgbW92ZSBjYW5ub3QgdGhlbiBmYWlsIG9uIGFkbWlzc2lvbi5cbiAgICpcbiAgICogVGhlIGdpdCBoYWxmIGlzIGhlcmUgYmVjYXVzZSBvbmx5IHRoZSBkYWVtb24gY2FuIHNlZSBhIGAuZ2l0YDogYSBmb2xkZXJcbiAgICogZHJhZ2dlZCBvdXQgb2YgYSByZXBvc2l0b3J5IGlzIHRoZSBjYXNlIHdoZXJlIHRoZSBjb25zZXF1ZW5jZSByZWFjaGVzIHBhc3RcbiAgICogc2NyaXB0b3JpdW0gKENvbGUgbW92ZWQgdGhpcyBwcm9qZWN0J3Mgb3duIGRvY3MgZm9sZGVyIGludG8gaGlzIHdvcmtzcGFjZSxcbiAgICogYW5kIGdpdCBzYXcgc2l4IGRlbGV0ZWQgZmlsZXMpLlxuICAgKi9cbiAgbW92ZVBsYW4ocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiBNb3ZlUGxhbiB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgY29uc3QgZnJvbVJlcG8gPSBnaXRSb290T2YoZGlybmFtZShpdGVtLmFicykpO1xuICAgIGNvbnN0IGludG9SZXBvID0gZ2l0Um9vdE9mKGludG8pO1xuICAgIHJldHVybiB7XG4gICAgICBmcm9tOiBpdGVtLmFicyxcbiAgICAgIGludG8sXG4gICAgICBuYW1lOiBiYXNlbmFtZShpdGVtLmFicyksXG4gICAgICBmb2xkZXI6IGl0ZW0uZGlyLFxuICAgICAgZG9jczogaXRlbS5kaXIgPyBjb3VudERvY3MoaXRlbS5hYnMpIDogMSxcbiAgICAgIHJlcG86IGZyb21SZXBvID8gYmFzZW5hbWUoZnJvbVJlcG8pIDogbnVsbCxcbiAgICAgIGxlYXZlc1JlcG86IGZyb21SZXBvICE9PSBudWxsICYmIGZyb21SZXBvICE9PSBpbnRvUmVwbyxcbiAgICB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICAvKipcbiAgICogVGhlIGhpZGRlbiBsaXN0IG9mIHRoZSBlbnRyeSBhIHBhdGggYmVsb25ncyB0bywgQkVGT1JFIGFueXRoaW5nIGNoYW5nZXMgaXRcbiAgICog4oCUIHdoYXQgRTYwIHJlY29yZHMgc28gYSBoaWRlIGNhbiBiZSBwdXQgYmFjayBleGFjdGx5LlxuICAgKi9cbiAgaGlkZGVuQmVmb3JlKHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVsczogc3RyaW5nW10gfSB8IG51bGwge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgICByZXR1cm4geyBlbnRyeTogaXRlbS5lbnRyeS5pZCwgcmVsczogWy4uLihpdGVtLmVudHJ5LmhpZGRlbiA/PyBbXSldIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvKiogVGhlIHNhbWUsIGFkZHJlc3NlZCBieSBlbnRyeSDigJQgd2hhdCBgdW5oaWRlYCBuZWVkcyByZWNvcmRlZC4gKi9cbiAgaGlkZGVuT2ZFbnRyeShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlbHM6IHN0cmluZ1tdIH0gfCBudWxsIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgcmV0dXJuIGUgPyB7IGVudHJ5OiBlLmlkLCByZWxzOiBbLi4uKGUuaGlkZGVuID8/IFtdKV0gfSA6IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogU2V0IGFuIGVudHJ5J3MgaGlkZGVuIGxpc3QgdG8gZXhhY3RseSBgcmVsc2AgKEU2MCdzIGludmVyc2Ugb2YgYm90aCBoaWRlXG4gICAqIGFuZCB1bmhpZGUpLiBSZXR1cm5zIHdoYXQgaXQgV0FTLCBzbyB0aGUgY2FsbGVyIGNhbiBidWlsZCB0aGUgb3Bwb3NpdGUgYWN0XG4gICAqIHdpdGhvdXQgcmVhZGluZyBzdGF0ZSBpdCBoYXMgYWxyZWFkeSBjaGFuZ2VkLlxuICAgKi9cbiAgcmVzdG9yZUhpZGRlbihlbnRyeUlkOiBzdHJpbmcsIHJlbHM6IHN0cmluZ1tdKTogeyBlbnRyeTogc3RyaW5nOyB3YXM6IHN0cmluZ1tdIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCB3YXMgPSBbLi4uKGUuaGlkZGVuID8/IFtdKV07XG4gICAgaWYgKHJlbHMubGVuZ3RoID09PSAwKSBkZWxldGUgZS5oaWRkZW47XG4gICAgZWxzZSBlLmhpZGRlbiA9IFsuLi5yZWxzXTtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgd2FzIH07XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlIHNvbWV0aGluZyB0aGlzIHNlc3Npb24gY3JlYXRlZCAoRTYwJ3MgdW5kbyBvZiBhIGNyZWF0aW9uKS5cbiAgICpcbiAgICog4puUIEEgTk9OLUVNUFRZIERJUkVDVE9SWSBJUyBSRUZVU0VELCBhbmQgbm8gZGlhbG9nIGNhbiBhdXRob3Jpc2UgaXQuIFVuZG9cbiAgICogd29ya3MgYmFja3dhcmRzLCBzbyBpdCBlbXB0aWVzIGEgZm9sZGVyIGJlZm9yZSBpdCByZWFjaGVzIHRoYXQgZm9sZGVyJ3NcbiAgICogY3JlYXRpb247IGlmIHRoZSBmb2xkZXIgc3RpbGwgaGFzIGNvbnRlbnRzIHRoZW4gc29tZXRoaW5nIHB1dCB0aGVtIHRoZXJlXG4gICAqIHRoYXQgdGhlIGhpc3RvcnkgZG9lcyBub3Qga25vdyBhYm91dCwgYW5kIHJlbW92aW5nIGEgZGlyZWN0b3J5IFRSRUUgaXMgYVxuICAgKiBkaWZmZXJlbnQgYWN0IGZyb20gcmVtb3ZpbmcgdGhlIGVtcHR5IHRoaW5nIHlvdSBqdXN0IG1hZGUuIChDb2xlIHJ1bGVkIHRoZVxuICAgKiBmaWxlIGNhc2UgdGhlIG90aGVyIHdheSDigJQgY29uZmlybWVkLCBub3QgcmVmdXNlZCDigJQgYW5kIHRoaXMgbGltaXQgaXMgdGhlXG4gICAqIGNhcnZlLW91dCBoZSBhY2NlcHRlZC4pXG4gICAqXG4gICAqIOKaoCBJdCBhbHNvIHJlZnVzZXMgYW55dGhpbmcgdGhhdCBpcyBub3Qgd2hlcmUgdGhlIGhpc3Rvcnkgc2FpZCBpdCB3YXM6IGFcbiAgICogcGF0aCB0aGF0IGhhcyBiZWNvbWUgYSBkaXJlY3RvcnksIG9yIGEgZGlyZWN0b3J5IHRoYXQgaGFzIGJlY29tZSBhIGZpbGUsXG4gICAqIG1lYW5zIHRoZSB3b3JsZCBtb3ZlZCBhbmQgdGhlIHJlY29yZGVkIGludmVyc2Ugbm8gbG9uZ2VyIGRlc2NyaWJlcyBpdC5cbiAgICovXG4gIHJlbW92ZUNyZWF0ZWQocmF3UGF0aDogc3RyaW5nLCBkaXI6IGJvb2xlYW4pOiB7IHBhdGg6IHN0cmluZzsgcmVtb3ZlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbHJlYWR5IGdvbmU6IHRoZSB1bmRvIGhhcyBub3RoaW5nIHRvIGRvLCB3aGljaCBpcyBub3QgYW4gZXJyb3IuXG4gICAgICByZXR1cm4geyBwYXRoOiBhYnMsIHJlbW92ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpICE9PSBkaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoYWJzKX0gaXMgJHtzdC5pc0RpcmVjdG9yeSgpID8gXCJhIGZvbGRlclwiIDogXCJhIGZpbGVcIn0gbm93IOKAlCB0aGUgY2hhbmdlIHRoaXMgd291bGQgdW5kbyBubyBsb25nZXIgZGVzY3JpYmVzIGl0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBpZiAoZGlyKSB7XG4gICAgICBjb25zdCBsZWZ0ID0gcmVhZGRpclN5bmMoYWJzKTtcbiAgICAgIGlmIChsZWZ0Lmxlbmd0aCA+IDApXG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGFicyl9IGlzIG5vdCBlbXB0eSAoJHtsZWZ0Lmxlbmd0aH0gaXRlbSR7bGVmdC5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9KSDigJQgbW92ZSB3aGF0IGlzIGluc2lkZSBpdCBvdXQgZmlyc3RgLFxuICAgICAgICAgIDQwOSxcbiAgICAgICAgICBsZWZ0LnNsaWNlKDAsIDEwKSxcbiAgICAgICAgKTtcbiAgICAgIHJtZGlyU3luYyhhYnMpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1bmxpbmtTeW5jKGFicyk7XG4gICAgfVxuICAgIHRoaXMuZm9yZ2V0UGF0aChhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgcmVtb3ZlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5dGhpbmcgd29ydGggbG9va2luZyBhdCBpbiB0aGlzIHNlc3Npb24sIHdpdGggdGhlIHZlcmIgZm9yIGVhY2ggKEU2MikuXG4gICAqXG4gICAqIOKblCBJVCBPTkxZIExPT0tTLiBSZXBhaXJpbmcgd291bGQgbWVhbiBkZWNpZGluZyBmb3IgdGhlIGh1bWFuIHRoYXQgYSBnaG9zdFxuICAgKiBlbnRyeSBpcyBub3Qgd2FudGVkIGJhY2sgYW5kIHRoYXQgdmVyc2lvbnMgaGVsZCBmb3IgYSB2YW5pc2hlZCBmaWxlIGFyZSBub3RcbiAgICogd29ydGggc2F2aW5nIOKAlCBib3RoIG9mIHdoaWNoIGFyZSB0aGVpcnMgdG8gZGVjaWRlIChDb2xlOiBcInJlcG9ydCwgbmFtZSB0aGVcbiAgICogdmVyYiwgbGV0IHlvdSBkZWNpZGVcIikuXG4gICAqXG4gICAqIOKaoCBgZXhpc3RzU3luY2AgcGVyIGRvY3VtZW50IGFuZCBwZXIgbm9kZSwgd2hpY2ggaXMgdGhlIG9uZSBjb3N0IGhlcmUuIEl0IGlzXG4gICAqIGJvdW5kZWQgYnkgdGhlIGNvbnRleHQgdGhlIGh1bWFuIGNob3NlIGFuZCBydW5zIG9uIGRlbWFuZCBwbHVzIG9uY2UgYXRcbiAgICogc3RhcnR1cCwgbm90IG9uIGEgdGltZXIuXG4gICAqL1xuICBjaGVja3VwKCk6IEZpbmRpbmdbXSB7XG4gICAgY29uc3Qgbm9kZXM6IHsgZW50cnk6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBzaG93bjogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfVtdID0gW107XG4gICAgY29uc3QgbGlua3M6IHsgZW50cnk6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGFuZ2xpbmc6IG51bWJlciB9W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgbm9kZXMucHVzaCh7IGVudHJ5OiBlLmlkLCBwYXRoOiBwLCBzaG93bjogdGhpcy5kaXNwbGF5KHApLCBleGlzdHM6IGV4aXN0c1N5bmMocCkgfSk7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZyA9IHRoaXMuZ3JhcGhGb3IoZS5pZCk7XG4gICAgICAgIGlmIChnLmRhbmdsaW5nID4gMClcbiAgICAgICAgICBsaW5rcy5wdXNoKHsgZW50cnk6IGUuaWQsIGxhYmVsOiBlLmxhYmVsID8/IGJhc2VuYW1lKGUucm9vdCksIGRhbmdsaW5nOiBnLmRhbmdsaW5nIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEEgc2V0IHRoYXQgY2Fubm90IGJlIG1hcHBlZCBpcyBub3QgYSBmaW5kaW5nIGFib3V0IGxpbmtzLlxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmluZGluZ3Moe1xuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiAoe1xuICAgICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICAgIGV4aXN0czogZXhpc3RzU3luYyhkLm9yaWdpbmFsKSxcbiAgICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubGVuZ3RoLFxuICAgICAgfSkpLFxuICAgICAgbm9kZXMsXG4gICAgICBsaW5rcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgYSBkb2N1bWVudCB3aG9zZSBmaWxlIG9mIHJlY29yZCBpcyBnb25lIChFNjEpLlxuICAgKlxuICAgKiDim5QgVEhFIFdBUk5JTkcgSEFEIE5PIEFOU1dFUiwgV0hJQ0ggSVMgV0hZIFRISVMgRVhJU1RTLiBXaGVuIGEgZG9jdW1lbnQnc1xuICAgKiBvcmlnaW5hbCBkaXNhcHBlYXJzIGJldHdlZW4gc2Vzc2lvbnMsIHJlc3RvcmUgc2F5cyBzbyBvbiBwdXJwb3NlIOKAlCBcImdvbmVcbiAgICogZnJvbSBkaXNrIHNpbmNlIHRoaXMgc2Vzc2lvbiB3YXMgbGFzdCBvcGVuLiBTYXZlIHdvdWxkIHJlY3JlYXRlIGl0XCIg4oCUIGFuZFxuICAgKiB0aGF0IGlzIHRoZSBSSUdIVCB0aGluZyB0byBzYXksIGJlY2F1c2UgdGhlIHNlc3Npb24gaXMgc3RpbGwgaG9sZGluZyB0aGVcbiAgICogY29udGVudCBhbmQgb2ZmZXJpbmcgaXQgYmFjay4gV2hhdCB3YXMgbWlzc2luZyB3YXMgYW55IHdheSB0byByZXBseSBcIm5vLCBJXG4gICAqIG1lYW50IHRvIGRlbGV0ZSB0aGF0XCI6IHRoZSBub3RpY2UgcmVwZWF0ZWQgb24gZXZlcnkgcmVzdG9yZSBmb3JldmVyIGFuZCB0aGVcbiAgICogb25seSBlc2NhcGUgd2FzIHJlY3JlYXRpbmcgdGhlIHNlc3Npb24uIEEgd2FybmluZyB3aXRoIG5vIGNvcnJlc3BvbmRpbmcgYWN0XG4gICAqIGlzIHRoZSBzaGFwZSB0aGlzIHNwZWxsIGtlZXBzIHRyeWluZyBub3QgdG8gaGF2ZS5cbiAgICpcbiAgICog4puUIFJFRlVTRUQgV0hJTEUgVEhFIEZJTEUgRVhJU1RTLCBhbmQgdGhlIHJlZnVzYWwgbmFtZXMgdGhlIHJpZ2h0IHZlcmIuXG4gICAqIEZvcmdldHRpbmcgYSBMSVZFIGRvY3VtZW50J3MgcmVjb3JkIHdvdWxkIHRocm93IGF3YXkgaXRzIHZlcnNpb24gaGlzdG9yeVxuICAgKiB3aGlsZSB0aGUgZG9jdW1lbnQgaXRzZWxmIHNpdHMgdGhlcmUgb24gZGlzayDigJQgdGhlIGNvbmZ1c2lvbiB0aGlzIG11c3Qgbm90XG4gICAqIGVuYWJsZS4gVGFraW5nIHNvbWV0aGluZyBvdXQgb2YgdGhlIHNpZGViYXIgaXMgYGhpZGVgOyB0aGlzIGlzIG9ubHkgZm9yIGFcbiAgICogcmVjb3JkIHdob3NlIHN1YmplY3QgaXMgZ29uZS5cbiAgICpcbiAgICog4pqgIFRoZSB2ZXJzaW9uIGZpbGVzIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYXJlIExFRlQgd2hlcmUgdGhleSBhcmUsIGFzXG4gICAqIHdpdGggdW5kbydzIGRlbGV0ZTogbm90aGluZyByZWFkcyB0aGVtIG9uY2UgdGhlIHJlY29yZCBpcyBnb25lLCBhbmRcbiAgICogcmVtb3ZpbmcgdGhlbSB3b3VsZCBiZSBhIHNlY29uZCBkZWxldGlvbiBub2JvZHkgYXNrZWQgZm9yLlxuICAgKi9cbiAgZm9yZ2V0RG9jKHJlZj86IHN0cmluZyk6IHsgc2x1Zzogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IHZlcnNpb25zOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUocmVmKTtcbiAgICBpZiAoZXhpc3RzU3luYyhkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke3RoaXMuZGlzcGxheShkLm9yaWdpbmFsKX0gaXMgc3RpbGwgb24gZGlzayDigJQgZm9yZ2V0IGlzIGZvciBhIGRvY3VtZW50IHdob3NlIGZpbGUgaXMgZ29uZS4gVG8gdGFrZSBpdCBvdXQgb2YgdGhlIGNvbnRleHQsIHJlbW92ZSBpdCBmcm9tIFNjcmlwdG9yaXVtIGluc3RlYWQuYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBmb3Jnb3R0ZW4gPSB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLmxlbmd0aCxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzID0gdGhpcy5tLmRvY3MuZmlsdGVyKCh4KSA9PiB4LnNsdWcgIT09IGQuc2x1Zyk7XG4gICAgaWYgKHRoaXMubS5vcGVuRG9jID09PSBkLnNsdWcpIHRoaXMubS5vcGVuRG9jID0gdGhpcy5tLmRvY3NbMF0/LnNsdWcgPz8gbnVsbDtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBmb3Jnb3R0ZW47XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgcGF0aCB0aGF0IGlzIG5vIGxvbmdlciBvbiBkaXNrOiBwcnVuZSBpdCBmcm9tIGV2ZXJ5IGNvbnRleHQgZW50cnksXG4gICAqIGRyb3AgdGhlIGVudHJ5IGlmIHRoYXQgZW1wdGllcyBpdCwgYW5kIGZvcmdldCBhbnkgZG9jdW1lbnQgcmVjb3JkIGZvciBpdC5cbiAgICpcbiAgICog4puUIGByZXNjYW5gIElTIE5PVCBFTk9VR0gsIEFORCBUSEFUIFdBUyBUSEUgQlVHLiBJdCByZXR1cm5zIGVhcmx5IGZvciBhbnlcbiAgICogZW50cnkgd2hvc2UgbWVtYmVyc2hpcCBpcyBub3QgYG1pcnJvcmVkYCDigJQgYW5kIGEgc2luZ2xlIGRvY3VtZW50IGlzIGFcbiAgICogYGxpc3RlZGAgZW50cnksIHNvIGRlbGV0aW5nIG9uZSBsZWZ0IGl0cyBub2RlIGluIHRoZSBzaWRlYmFyIGZvcmV2ZXIgd2hpbGVcbiAgICogdGhlIGZpbGUgd2FzIGdvbmUgZnJvbSB0aGUgZGlzay4gQ29sZSBmb3VuZCBpdCB3aXRoaW4gYSBtaW51dGUgb2YgRTYwXG4gICAqIHNoaXBwaW5nOiBcIml0J3Mgbm90IGJlaW5nIHJlbW92ZWQgZnJvbSB0aGUgc2lkZWJhcuKApiB0aGVuIEkgY3JlYXRlZCBhbm90aGVyXG4gICAqIGRvY3VtZW50IGFsc28gdW50aXRsZWQgYW5kIEkgdGhpbmsgdGhlcmUgbWlnaHQgaGF2ZSBiZWVuIGV2ZW4gYSB3ZWlyZFxuICAgKiBuYW1pbmcgaXNzdWVcIi5cbiAgICpcbiAgICog4pqgIFRIRSBOQU1JTkcgT0RESVRZIFdBUyBUSEUgU0VDT05EIEhBTEYgT0YgVEhFIFNBTUUgQlVHLiBUaGUgYERvY1JlY29yZGBcbiAgICogb3V0bGl2ZWQgdGhlIGZpbGUgdG9vLCBzbyBpdHMgU0xVRyBzdGF5ZWQgdGFrZW4gYW5kIHRoZSBuZXh0IGBVbnRpdGxlZC5tZGBcbiAgICogYmVjYW1lIGB1bnRpdGxlZC0yYCB3aGlsZSB0aGUgZmlsZSBvbiBkaXNrIHdhcyBwbGFpbiBgVW50aXRsZWQubWRgLiBBXG4gICAqIHJlY29yZCBmb3IgYSBkb2N1bWVudCB0aGF0IGRvZXMgbm90IGV4aXN0IGhhcyBubyByZWFkZXI7IGl0IG9ubHkgZ2V0cyBpblxuICAgKiB0aGUgd2F5IG9mIHRoZSBuZXh0IG9uZS5cbiAgICpcbiAgICog4pqgIFRoZSB2ZXJzaW9uIGZpbGVzIHVuZGVyIHRoZSBzZXNzaW9uIGhvbWUgYXJlIExFRlQgd2hlcmUgdGhleSBhcmUuIFRoZVxuICAgKiByZWNvcmQgaXMgZ29uZSwgc28gbm90aGluZyByZWFkcyB0aGVtLCBhbmQgcmVtb3ZpbmcgdGhlbSB3b3VsZCBiZSBhIHNlY29uZFxuICAgKiBkZWxldGlvbiB0aGUgaHVtYW4gd2FzIG5ldmVyIGFza2VkIGFib3V0IOKAlCB0aGUgZGlhbG9nIHByb21pc2VkIHRoZSBjcmVhdGVkXG4gICAqIGZpbGUsIG5vdCB0aGUgc2Vzc2lvbidzIG93biBjb3BpZXMuXG4gICAqL1xuICBwcml2YXRlIGZvcmdldFBhdGgoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpbnNpZGUgPSAocDogc3RyaW5nKSA9PiBwID09PSBhYnMgfHwgcC5zdGFydHNXaXRoKGFicyArIHNlcCk7XG4gICAgZm9yIChjb25zdCBlIG9mIFsuLi50aGlzLm0uY29udGV4dF0pIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAhaW5zaWRlKGUucm9vdCkpIHtcbiAgICAgICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gQSBgbGlzdGVkYCBlbnRyeSAob3IgYSBtaXJyb3JlZCBvbmUgdGhhdCBXQVMgdGhlIGRlbGV0ZWQgZm9sZGVyKTpcbiAgICAgIC8vIHBydW5lIHRoZSBub2RlcyBieSBoYW5kLCBzaW5jZSBgcmVzY2FuYCB3aWxsIG5vdCBsb29rIGF0IGl0LlxuICAgICAgY29uc3QgcHJ1bmUgPSAobm9kZXM6IENvbnRleHROb2RlW10pOiBDb250ZXh0Tm9kZVtdID0+XG4gICAgICAgIG5vZGVzXG4gICAgICAgICAgLmZpbHRlcigobikgPT4gIWluc2lkZShqb2luKGUucm9vdCwgbi5yZWwpKSlcbiAgICAgICAgICAubWFwKChuKSA9PiAobi5raW5kID09PSBcImdyb3VwXCIgPyB7IC4uLm4sIGNoaWxkcmVuOiBwcnVuZShuLmNoaWxkcmVuKSB9IDogbikpO1xuICAgICAgZS5ub2RlcyA9IHBydW5lKGUubm9kZXMpO1xuICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAwIHx8IGluc2lkZShlLnJvb3QpKSB0aGlzLnJlbW92ZUNvbnRleHQoZS5pZCk7XG4gICAgfVxuICAgIC8vIEEgcmVjb3JkIGZvciBhIGZpbGUgdGhhdCBpcyBnb25lIGhhcyBubyByZWFkZXIsIGFuZCBpdHMgc2x1ZyB3b3VsZFxuICAgIC8vIG90aGVyd2lzZSBzdGF5IHRha2VuLlxuICAgIHRoaXMubS5kb2NzID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiAhaW5zaWRlKGQub3JpZ2luYWwpKTtcbiAgICBpZiAodGhpcy5tLm9wZW5Eb2MgJiYgIXRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpKVxuICAgICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLm0uZG9jc1swXT8uc2x1ZyA/PyBudWxsO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgdW5oaWRlKGVudHJ5SWQ6IHN0cmluZyk6IHsgZW50cnk6IHN0cmluZzsgcmVzdG9yZWQ6IG51bWJlciB9IHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtlbnRyeUlkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKCh4KSA9PiB4LmlkKSxcbiAgICAgICk7XG4gICAgY29uc3QgcmVzdG9yZWQgPSBlLmhpZGRlbj8ubGVuZ3RoID8/IDA7XG4gICAgZGVsZXRlIGUuaGlkZGVuO1xuICAgIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IGUuaWQsIHJlc3RvcmVkIH07XG4gIH1cblxuICAvKipcbiAgICogRTIyOiBhIHNpbmdsZSBkb2N1bWVudCBiZWNvbWVzIGEgc2V0IOKAlCBhIGZvbGRlciBuYW1lZCBmb3IgaXQgYmVzaWRlIGl0LCB0aGVcbiAgICogZG9jdW1lbnQgbW92ZWQgaW4sIGFuZCB0aGUgZW50cnkgKHNhbWUgaWQpIG5vdyBtaXJyb3JzIHRoYXQgZm9sZGVyLlxuICAgKi9cbiAgbWFrZVNldChyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZm9sZGVyOiBzdHJpbmc7IGVudHJ5OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLmVudHJ5Lm1lbWJlcnNoaXAgIT09IFwibGlzdGVkXCIgfHwgaXRlbS5kaXIpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHt0aGlzLmRpc3BsYXkoaXRlbS5hYnMpfSBpcyBhbHJlYWR5IGluIGEgc2V0IOKAlCBtYWtlIGEgZm9sZGVyIHRoZXJlIGluc3RlYWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoaXRlbS5hYnMpO1xuICAgIGNvbnN0IHN0ZW0gPSBiYXNlbmFtZShpdGVtLmFicywgZXh0bmFtZShpdGVtLmFicykpIHx8IFwiVW50aXRsZWRcIjtcbiAgICBjb25zdCBmb2xkZXIgPSBqb2luKHBhcmVudCwgdGhpcy5mcmVlTmFtZShwYXJlbnQsIHN0ZW0sIHRydWUpKTtcbiAgICBta2RpclN5bmMoZm9sZGVyKTtcbiAgICBjb25zdCB0byA9IGpvaW4oZm9sZGVyLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICBjb25zdCBlID0gaXRlbS5lbnRyeTtcbiAgICBlLm1lbWJlcnNoaXAgPSBcIm1pcnJvcmVkXCI7XG4gICAgZS5yb290ID0gZm9sZGVyO1xuICAgIGUubGFiZWwgPSBiYXNlbmFtZShmb2xkZXIpO1xuICAgIGUubm9kZXMgPSBbXTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZm9sZGVyLCBlbnRyeTogZS5pZCB9O1xuICB9XG5cbiAgLyoqIFRoZSBtb3N0IHRleHQgb25lIGltcG9ydCBjYXJyaWVzIOKAlCBhIGRvY3VtZW50LCBub3QgYSBkYXRhIGR1bXAuICovXG4gIHN0YXRpYyByZWFkb25seSBJTVBPUlRfTUFYX0JZVEVTID0gOCAqIDEwMjQgKiAxMDI0O1xuXG4gIC8qKlxuICAgKiBFMjMncyBkcm9wOiBhIENPUFkgb2YgYSBmaWxlJ3MgdGV4dCwgd3JpdHRlbiB1bmRlciBhIGZyZWUgbmFtZSBpbnRvIGBpbnRvYFxuICAgKiAoZGVmYXVsdDogdGhlIHdvcmtzcGFjZSksIHRoZW4gc2hvd24gbGlrZSBhbnkgb3RoZXIgZG9jdW1lbnQuXG4gICAqL1xuICBpbXBvcnRUZXh0KG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nLCByYXdJbnRvPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGlmICghaXNEb2NOYW1lKGZpbGUpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vdCBhIGRvY3VtZW50IFNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7ZmlsZX1gLFxuICAgICAgICA0MDAsXG4gICAgICAgIFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICApO1xuICAgIGlmIChCdWZmZXIuYnl0ZUxlbmd0aCh0ZXh0KSA+IFNlc3Npb24uSU1QT1JUX01BWF9CWVRFUylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2ZpbGV9IGlzIGxhcmdlciB0aGFuICR7U2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTIC8gMTAyNCAvIDEwMjR9IE1CIOKAlCBub3QgaW1wb3J0ZWRgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvID8/IHRoaXMud29ya3NwYWNlKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgdGhpcy5mcmVlTmFtZShkaXIsIGZpbGUsIGZhbHNlKSk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjaGF0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8vIOKUgOKUgCB0aGUgd29yayBxdWV1ZSAoRTUwKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogU3RhcnQgYSB0YXNrLiBJdCBpcyBBTk5PVU5DRUQgYXMgYSBjaGF0IG1lc3NhZ2UgYW5kIHJlY29yZGVkIGFzIGEgdGFzayBhdFxuICAgKiB0aGUgc2FtZSBtb21lbnQg4oCUIENvbGUncyBmcmFtaW5nLCBcImEgbWVzc2FnZSB0aGF0IGNhbiBiZSBtYXJrZWQgZG9uZVwiIOKAlFxuICAgKiBzbyB0aGUgY29udmVyc2F0aW9uIHJlYWRzIGFzIGEgbmFycmF0aXZlIGFuZCB0aGUgcXVldWUgcmVhZHMgYXMgc3RhdGUsXG4gICAqIG92ZXIgb25lIGZhY3QgcmF0aGVyIHRoYW4gdHdvLlxuICAgKi9cbiAgc3RhcnRUYXNrKHRleHQ6IHN0cmluZywgd2hvOiBWZXJzaW9uQXV0aG9yKTogVGFzayB7XG4gICAgY29uc3QgYm9keSA9IHRleHQudHJpbSgpO1xuICAgIGlmICghYm9keSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcImEgdGFzayBuZWVkcyB0byBzYXkgd2hhdCB0aGUgd29yayBpc1wiLCA0MDApO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSB0aGlzLmFkZE1lc3NhZ2Uod2hvLCBib2R5KTtcbiAgICBjb25zdCB0YXNrOiBUYXNrID0ge1xuICAgICAgaWQ6IGB0LSR7cmFuZEhleCg0KX1gLFxuICAgICAgdGV4dDogYm9keSxcbiAgICAgIHdobyxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIG1lc3NhZ2VJZDogbWVzc2FnZS5pZCxcbiAgICB9O1xuICAgIHRoaXMubS50YXNrcyA9IFsuLi4odGhpcy5tLnRhc2tzID8/IFtdKSwgdGFza107XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICBwcml2YXRlIHRhc2tPckRpZShpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgICBpZiAoIXRhc2spXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gdGFzayAke2lkfSBpbiB0aGlzIHNlc3Npb25gLFxuICAgICAgICA0MDQsXG4gICAgICAgICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCkubWFwKCh0KSA9PiB0LmlkKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHRhc2s7XG4gIH1cblxuICAvKiogU2F5IHdoYXQgaXMgYmVpbmcgZG9uZSByaWdodCBub3cg4oCUIGZvciB3b3JrIHdpdGggc3RlcHMgd29ydGggd2F0Y2hpbmcuICovXG4gIHNldFRhc2tTdGF0dXMoaWQ6IHN0cmluZywgc3RhdHVzOiBzdHJpbmcpOiBUYXNrIHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGlmICh0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGFzayAke2lkfSBpcyBhbHJlYWR5IGRvbmUg4oCUIGl0cyBzdGF0dXMgY2Fubm90IGNoYW5nZWAsIDQwOSk7XG4gICAgdGFzay5zdGF0dXMgPSBzdGF0dXMudHJpbSgpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB0YXNrO1xuICB9XG5cbiAgLyoqXG4gICAqIE1hcmsgaXQgZG9uZS4gSWRlbXBvdGVudCBvbiBwdXJwb3NlOiBhIHRhc2sgZmluaXNoZWQgdHdpY2Ug4oCUIGFuIGFnZW50XG4gICAqIHJldHJ5aW5nLCBhIGh1bWFuIGNsaWNraW5nIGFzIHRoZSBhZ2VudCByZXBvcnRzIOKAlCBpcyBub3QgYW4gZXJyb3IsIGFuZFxuICAgKiByZWZ1c2luZyB3b3VsZCBtYWtlIHRoZSBzdXJmYWNlIGhhbmRsZSBhIHJhY2UgaXQgZGlkIG5vdCBjYXVzZS5cbiAgICovXG4gIGZpbmlzaFRhc2soaWQ6IHN0cmluZywgb3V0Y29tZT86IHN0cmluZyk6IHsgdGFzazogVGFzazsgYWxyZWFkeTogYm9vbGVhbiB9IHtcbiAgICBjb25zdCB0YXNrID0gdGhpcy50YXNrT3JEaWUoaWQpO1xuICAgIGNvbnN0IGFscmVhZHkgPSB0YXNrLmRvbmVBdCAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghYWxyZWFkeSkge1xuICAgICAgdGFzay5kb25lQXQgPSBEYXRlLm5vdygpO1xuICAgICAgdGFzay5zdGF0dXMgPSB1bmRlZmluZWQ7XG4gICAgICBpZiAob3V0Y29tZT8udHJpbSgpKSB0YXNrLm91dGNvbWUgPSBvdXRjb21lLnRyaW0oKTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIH1cbiAgICByZXR1cm4geyB0YXNrLCBhbHJlYWR5IH07XG4gIH1cblxuICAvKipcbiAgICogRm9yZ2V0IGEgdGFzayBlbnRpcmVseSDigJQgZm9yIG9uZSBzdGFydGVkIGJ5IG1pc3Rha2UuIE1hcmtpbmcgaXQgZG9uZSB3b3VsZFxuICAgKiBwdXQgYSB0aGluZyB0aGF0IG5ldmVyIGhhcHBlbmVkIGludG8gdGhlIHJlY29yZDsgYSBxdWV1ZSB5b3UgY2Fubm90IGNsZWFyXG4gICAqIG9mIGl0cyBvd24gbWlzdGFrZXMgc3RvcHMgYmVpbmcgYSB0cnVzdHdvcnRoeSBhY2NvdW50IG9mIHRoZSB3b3JrLlxuICAgKi9cbiAgcmVtb3ZlVGFzayhpZDogc3RyaW5nKTogVGFzayB7XG4gICAgY29uc3QgdGFzayA9IHRoaXMudGFza09yRGllKGlkKTtcbiAgICB0aGlzLm0udGFza3MgPSAodGhpcy5tLnRhc2tzID8/IFtdKS5maWx0ZXIoKHQpID0+IHQuaWQgIT09IGlkKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gdGFzaztcbiAgfVxuXG4gIC8qKlxuICAgKiBGb3JnZXQgZXZlcnkgZmluaXNoZWQgdGFzay4gT3V0c3RhbmRpbmcgb25lcyBhcmUgdW50b3VjaGVkIOKAlCBjbGVhcmluZyBpc1xuICAgKiB0aWR5aW5nIHdoYXQgaXMgT1ZFUiwgbmV2ZXIgYWJhbmRvbmluZyB3b3JrIHN0aWxsIGluIGZsaWdodC5cbiAgICovXG4gIGNsZWFyRG9uZVRhc2tzKCk6IG51bWJlciB7XG4gICAgY29uc3QgYmVmb3JlID0gKHRoaXMubS50YXNrcyA/PyBbXSkubGVuZ3RoO1xuICAgIHRoaXMubS50YXNrcyA9ICh0aGlzLm0udGFza3MgPz8gW10pLmZpbHRlcigodCkgPT4gdC5kb25lQXQgPT09IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgY2xlYXJlZCA9IGJlZm9yZSAtICh0aGlzLm0udGFza3M/Lmxlbmd0aCA/PyAwKTtcbiAgICBpZiAoY2xlYXJlZCA+IDApIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBjbGVhcmVkO1xuICB9XG5cbiAgLyoqIE5ld2VzdCBmaXJzdCDigJQgYSBxdWV1ZSBpcyByZWFkIGZyb20gdGhlIHRvcC4gKi9cbiAgdGFza3MoKTogVGFza1tdIHtcbiAgICByZXR1cm4gWy4uLih0aGlzLm0udGFza3MgPz8gW10pXS5zb3J0KChhLCBiKSA9PiBiLmNyZWF0ZWRBdCAtIGEuY3JlYXRlZEF0KTtcbiAgfVxuXG4gIGFkZE1lc3NhZ2UoXG4gICAgd2hvOiBDaGF0V2hvLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBleHRyYTogeyBzZWxlY3Rpb24/OiBTZWxlY3Rpb24gfCBudWxsOyBhY3RpdmVQYXRoPzogc3RyaW5nIHwgbnVsbCB9ID0ge30sXG4gICk6IENoYXRNZXNzYWdlIHtcbiAgICBjb25zdCBtc2c6IENoYXRNZXNzYWdlID0geyBpZDogYG0tJHtyYW5kSGV4KDQpfWAsIHdobywgdGV4dCwgdHM6IERhdGUubm93KCksIC4uLmV4dHJhIH07XG4gICAgdGhpcy5tLmNoYXQucHVzaChtc2cpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBtc2c7XG4gIH1cblxuICAvLyDilIDilIAgdmlld3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEEgZG9jdW1lbnQncyBmcm9udG1hdHRlciwgZnJvbSB0aGUgQUNUSVZFIHZlcnNpb24ncyB0ZXh0IOKAlCB3aGF0IHRoZSBodW1hblxuICAgKiAgaXMgcmVhZGluZywgd2hpY2ggaXMgbm90IGFsd2F5cyB3aGF0IGlzIG9uIGRpc2sgKEUzMikuICovXG4gIHByaXZhdGUgbWV0YU9mKGQ6IERvY1JlY29yZCk6IERvY1ZpZXdbXCJtZXRhXCJdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRNZXRhKHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGRvY1ZpZXcoZDogRG9jUmVjb3JkKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1ldGE6IHRoaXMubWV0YU9mKGQpLFxuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICBlbnRyeUlkOiBkLmVudHJ5SWQsXG4gICAgICByZWw6IGQucmVsLFxuICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubWFwKCh2KSA9PiAoeyAuLi52LCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIHYubikgfSkpLFxuICAgICAgbm90ZXM6IHRoaXMucGxhY2VkTm90ZXMoZCksXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgZGlydHk6IHRoaXMuaXNEaXJ0eShkKSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBkLm91dHNpZGVDaGFuZ2VkLFxuICAgIH07XG4gIH1cblxuICBkb2Moc2x1Zzogc3RyaW5nKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHRoaXMuZG9jVmlldyh0aGlzLmRvY09yRGllKHNsdWcpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGcm9udG1hdHRlciBmb3IgZXZlcnkgZG9jdW1lbnQgaW4gdGhlIGNvbnRleHQsIGJ5IHBhdGggKEUzMikuXG4gICAqXG4gICAqIENhY2hlZCBieSBwYXRoIGFuZCBtdGltZSwgYW5kIHJlYWQgSEVBRC1GSVJTVDogYSBmcm9udG1hdHRlciBibG9jayBzaXRzIGF0XG4gICAqIHRoZSB0b3Agb2YgYSBmaWxlLCBzbyBhIDMwMCBLQiBkb2N1bWVudCBjb3N0cyA4IEtCIG9mIHJlYWQuIFRoZSBjYXAga2VlcHMgYVxuICAgKiAyLDAwMC1ub2RlIG1pcnJvciBmcm9tIG1lYW5pbmcgMiwwMDAgcmVhZHMgcGVyIHNuYXBzaG90LCBhbmQgaGl0dGluZyBpdCBpc1xuICAgKiBTQUlEIG9uIHRoZSB3aXJlIHJhdGhlciB0aGFuIGxlZnQgdG8gbG9vayBsaWtlIGRvY3VtZW50cyB3aXRob3V0IGFueS5cbiAgICovXG4gIHByaXZhdGUgbWV0YUNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIHsgbXRpbWVNczogbnVtYmVyOyBzdW1tYXJ5OiBEb2NTdW1tYXJ5IHwgbnVsbCB9PigpO1xuXG4gIGNvbnRleHRNZXRhKGNhcCA9IE1FVEFfU0NBTl9DQVApOiB7IG1hcDogUmVjb3JkPHN0cmluZywgRG9jU3VtbWFyeT47IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBtYXA6IFJlY29yZDxzdHJpbmcsIERvY1N1bW1hcnk+ID0ge307XG4gICAgbGV0IHNlZW4gPSAwO1xuICAgIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSB7XG4gICAgICAgIGlmIChzZWVuID49IGNhcCkge1xuICAgICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgc2VlbisrO1xuICAgICAgICBsZXQgbXRpbWVNczogbnVtYmVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG10aW1lTXMgPSBzdGF0U3luYyhhYnMpLm10aW1lTXM7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGhpdCA9IHRoaXMubWV0YUNhY2hlLmdldChhYnMpO1xuICAgICAgICBsZXQgc3VtbWFyeTogRG9jU3VtbWFyeSB8IG51bGw7XG4gICAgICAgIGlmIChoaXQgJiYgaGl0Lm10aW1lTXMgPT09IG10aW1lTXMpIHN1bW1hcnkgPSBoaXQuc3VtbWFyeTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgc3VtbWFyeSA9IHN1bW1hcml6ZShyZWFkTWV0YShyZWFkSGVhZChhYnMpKSk7XG4gICAgICAgICAgdGhpcy5tZXRhQ2FjaGUuc2V0KGFicywgeyBtdGltZU1zLCBzdW1tYXJ5IH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzdW1tYXJ5KSBtYXBbYWJzXSA9IHN1bW1hcnk7XG4gICAgICB9XG4gICAgICBpZiAodHJ1bmNhdGVkKSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIHsgbWFwLCB0cnVuY2F0ZWQgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPbmUgZG9jdW1lbnQncyBmcm9udG1hdHRlciBhcyByZWFkLCBvciBldmVyeSBjb250ZXh0IGRvY3VtZW50J3MgKEUzMikuIFRoZVxuICAgKiBhZ2VudCBnZXRzIHRoZSBkYWVtb24ncyBwYXJzZSByYXRoZXIgdGhhbiByZS1yZWFkaW5nIHRoZSBZQU1MIGl0c2VsZi5cbiAgICovXG4gIG1ldGFGb3IocmF3UGF0aD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBpZiAocmF3UGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhYnMgPSB0aGlzLnNob3duUGF0aChyYXdQYXRoKTtcbiAgICAgIGNvbnN0IG1ldGEgPSByZWFkTWV0YShyZWFkSGVhZChhYnMpKTtcbiAgICAgIHJldHVybiB7IHBhdGg6IGFicywgbWV0YSwgLi4uKG1ldGEgPyB7fSA6IHsgbm90ZTogXCJubyBmcm9udG1hdHRlciBibG9ja1wiIH0pIH07XG4gICAgfVxuICAgIGNvbnN0IG91dDogeyBwYXRoOiBzdHJpbmc7IG1ldGE6IERvY01ldGEgfCBudWxsIH1bXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgYWJzIG9mIGRvY1BhdGhzKGUpKSBvdXQucHVzaCh7IHBhdGg6IGFicywgbWV0YTogcmVhZE1ldGEocmVhZEhlYWQoYWJzKSkgfSk7XG4gICAgcmV0dXJuIHsgZG9jdW1lbnRzOiBvdXQsIGNvdW50OiBvdXQubGVuZ3RoIH07XG4gIH1cblxuICAvKipcbiAgICogcGRvY3MncyBgZmluZGAsIG92ZXIgdGhpcyBzZXNzaW9uJ3MgY29udGV4dC4gU2FtZSBmaWx0ZXIgbmFtZXMsIHNhbWVcbiAgICogQU5EaW5nLCBhbmQgdGhlIHNhbWUgcnVsZSB0aGF0IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBBTlNXRVI6IGBjb3VudGAgc2F5c1xuICAgKiBob3cgbWFueSBtYXRjaGVkLCBhbmQgdGhlIGNhbGxlciByZWFkcyB0aGF0IHJhdGhlciB0aGFuIHRoZSBleGl0IGNvZGUuXG4gICAqL1xuICBmaW5kKGZpbHRlcjogTWV0YUZpbHRlcik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBtYXRjaGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgZm9yIChjb25zdCBhYnMgb2YgZG9jUGF0aHMoZSkpIHtcbiAgICAgICAgY29uc3QgbWV0YSA9IHJlYWRNZXRhKHJlYWRIZWFkKGFicykpO1xuICAgICAgICBpZiAoIW1hdGNoZXNGaWx0ZXIobWV0YSwgZmlsdGVyKSkgY29udGludWU7XG4gICAgICAgIG1hdGNoZXMucHVzaCh7XG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIGVudHJ5OiBlLmlkLFxuICAgICAgICAgIC4uLihtZXRhPy50eXBlID8geyB0eXBlOiBtZXRhLnR5cGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4obWV0YT8udGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKG1ldGE/LmRlc2NyaXB0aW9uID8geyBkZXNjcmlwdGlvbjogbWV0YS5kZXNjcmlwdGlvbiB9IDoge30pLFxuICAgICAgICAgIHN0YXR1czogbWV0YT8uc3RhdHVzID8/IG51bGwsXG4gICAgICAgICAgLi4uKG1ldGE/LmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgICAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICAgICAgZGF0ZTogbWV0YT8uZGF0ZSA/PyBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICByZXR1cm4geyBtYXRjaGVzLCBjb3VudDogbWF0Y2hlcy5sZW5ndGggfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPbmUgc2V0J3MgbWFwIChFMzMpOiBpdHMgZG9jdW1lbnRzIGFzIG5vZGVzLCBhbmQgdGhlIGZvdXIgc291cmNlcyBvZiBlZGdlc1xuICAgKiDigJQgYm9keSBsaW5rcywgd2lraSBsaW5rcywgdHlwZWQgbGlua3MgYW5kIGZyb250bWF0dGVyIHJlZmVyZW5jZXMuXG4gICAqL1xuICBncmFwaEZvcihlbnRyeUlkPzogc3RyaW5nKTogR3JhcGhQYXlsb2FkIHtcbiAgICBjb25zdCBlID0gZW50cnlJZFxuICAgICAgPyB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKVxuICAgICAgOiB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4Lm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIik7XG4gICAgaWYgKCFlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgZW50cnlJZCA/IGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gIDogXCJ0aGlzIHNlc3Npb24gaGFzIG5vIHNldCB0byBtYXBcIixcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXRocyA9IGRvY1BhdGhzKGUpO1xuICAgIGNvbnN0IGluZGV4OiBCdW5kbGVJbmRleCA9IHtcbiAgICAgIHJvb3Q6IGUucm9vdCxcbiAgICAgIHBhdGhzLFxuICAgICAgbWV0YU9mOiAocCkgPT4gcmVhZE1ldGEocmVhZEhlYWQocCkpLFxuICAgICAgZXhpc3RzOiAocCkgPT4gZXhpc3RzU3luYyhwKSxcbiAgICAgIHJlcG9Sb290OiBnaXRSb290T2YoZS5yb290KSxcbiAgICB9O1xuICAgIGNvbnN0IGcgPSBidWlsZEdyYXBoKGluZGV4LCAocCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIHNwbGl0RnJvbnRtYXR0ZXIocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkuYm9keTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gXCJcIjtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgLi4uZyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFNlYXJjaCBldmVyeXRoaW5nIGluIHRoZSBjb250ZXh0OiBmdXp6eSBvdmVyIG5hbWVzLCBleGFjdCBvdmVyIGNvbnRlbnQgKEU1OSkuXG4gICAqXG4gICAqIOKblCBUSElTIElTIFdIWSBUSEUgVkVSQiBFWElTVFMgQVQgQUxMLCBhbmQgdGhlIHJlYXNvbiBpcyBvbmUgbGluZTogYVxuICAgKiBkb2N1bWVudCBvcGVuIGluIHRoZSBzZXNzaW9uIGlzIHNob3duIGFzIGl0cyBBQ1RJVkUgVkVSU0lPTiwgd2hpY2ggbGl2ZXNcbiAgICogdW5kZXIgdGhlIHNlc3Npb24gaG9tZSBhbmQgbm90IGF0IHRoZSBvcmlnaW5hbCBwYXRoLiBBbiBhZ2VudCBncmVwcGluZyB0aGVcbiAgICogd29ya3NwYWNlIHRoZXJlZm9yZSBmaW5kcyB0aGUgU0FWRUQgZmlsZSBhbmQgc2lsZW50bHkgbWlzc2VzIHRoZSB0ZXh0IHRoZVxuICAgKiBodW1hbiBpcyByZWFkaW5nIOKAlCBzbyBcInNlYXJjaCB3aGF0IHlvdSBjYW4gc2VlXCIgaXMgYSBxdWVzdGlvbiBvbmx5IHRoZVxuICAgKiBzZXNzaW9uIGNhbiBhbnN3ZXIuIEV2ZXJ5dGhpbmcgZWxzZSBhYm91dCBzZWFyY2hpbmcgZmlsZXMsIGFuIGFnZW50IGNhblxuICAgKiBhbHJlYWR5IGRvIHdpdGggZ3JlcCwgd2hpY2ggaXMgd2h5IHRoZXJlIGlzIG5vIGluLWRvY3VtZW50IHZlcmIuXG4gICAqXG4gICAqIOKaoCBIaWRkZW4gZG9jdW1lbnRzIGFyZSBleGNsdWRlZCwgYmVjYXVzZSB0aGUgY29udGV4dCBpcyB3aGF0IHRoZSBodW1hblxuICAgKiBjaG9zZSB0byBsb29rIGF0OyBhIHJlc3VsdCB0aGV5IGNhbm5vdCBzZWUgaW4gdGhlIHNpZGViYXIgd291bGQgYmUgYSByZXN1bHRcbiAgICogdGhleSBjYW5ub3Qgb3Blbi5cbiAgICovXG4gIHNlYXJjaEFsbChvcHRzOiB7IHF1ZXJ5OiBzdHJpbmc7IGxpbWl0PzogbnVtYmVyIH0pOiBTZWFyY2hSZXBvcnQge1xuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IENhbmRpZGF0ZVtdID0gW107XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBkb2NQYXRocyhlbnRyeSkpIHtcbiAgICAgICAgaWYgKHNlZW4uaGFzKHBhdGgpKSBjb250aW51ZTtcbiAgICAgICAgc2Vlbi5hZGQocGF0aCk7XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IHBhdGgpO1xuICAgICAgICBjb25zdCB0aXRsZSA9IHJlYWRNZXRhKHJlYWRIZWFkKHBhdGgpKT8udGl0bGU7XG4gICAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XG4gICAgICAgICAgcGF0aCxcbiAgICAgICAgICBuYW1lOiBiYXNlbmFtZShwYXRoKSxcbiAgICAgICAgICAuLi4ocmVjb3JkID8geyBzbHVnOiByZWNvcmQuc2x1ZywgdmVyc2lvbjogcmVjb3JkLmFjdGl2ZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0aXRsZSA/IHsgdGl0bGUgfSA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBzZWFyY2hEb2N1bWVudHMoXG4gICAgICBjYW5kaWRhdGVzLFxuICAgICAgb3B0cy5xdWVyeSxcbiAgICAgIChjKSA9PiB7XG4gICAgICAgIC8vIFRoZSBBQ1RJVkUgVkVSU0lPTiB3aGVuIHRoZSBzZXNzaW9uIGhhcyBvbmUg4oCUIHNlZSB0aGUgbm90ZSBhYm92ZS5cbiAgICAgICAgY29uc3QgcmVjb3JkID1cbiAgICAgICAgICBjLnNsdWcgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gYy5zbHVnKTtcbiAgICAgICAgaWYgKHJlY29yZCkgcmV0dXJuIHRoaXMuYWN0aXZlVGV4dChyZWNvcmQpO1xuICAgICAgICByZXR1cm4gcmVhZEZpbGVTeW5jKGMucGF0aCwgXCJ1dGY4XCIpO1xuICAgICAgfSxcbiAgICAgIG9wdHMubGltaXQgIT09IHVuZGVmaW5lZCA/IHsgdG90YWw6IG9wdHMubGltaXQgfSA6IHt9LFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgbGluayBpbiBhIHNldCB0aGF0IG5vdGhpbmcgYW5zd2VycyDigJQgdGhlIHJlcG9ydCB5b3UgY2FuIEFDVCBvbiAoRTU0KS5cbiAgICpcbiAgICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBncmFwaGAgQUxSRUFEWSBIQUQgVEhFIEZBQ1RTIEFORCBTVElMTCBESUQgTk9UIEFOU1dFUlxuICAgKiBUSEUgUVVFU1RJT04uIENvbGUgYXNrZWQgd2hldGhlciBhbiBhZ2VudCBjYW4gY2hlY2sgZGFuZ2xpbmcgbGlua3M7IHRoZVxuICAgKiBob25lc3QgYW5zd2VyIHdhcyBcInllcywgYnkgZmV0Y2hpbmcgYSBzZXQncyB3aG9sZSBtYXAgYW5kIGZpbHRlcmluZyBzZXZlcmFsXG4gICAqIGh1bmRyZWQgZWRnZXNcIiwgd2hpY2ggaXMgYSBkaWZmZXJlbnQgdGhpbmcgZnJvbSBiZWluZyBhYmxlIHRvIGNoZWNrIHRoZW0uXG4gICAqIFRoaXMgc2F5cyBvbmx5IHdoYXQgaXMgYnJva2VuLCBhbmQgc2F5cyBpdCBhcyBgZmlsZTpsaW5lYCBwbHVzIFRIRSBTVFJJTkdcbiAgICogVEhFIERPQ1VNRU5UIEFDVFVBTExZIENPTlRBSU5TIOKAlCB3aGljaCBpcyB3aGF0IHlvdSBuZWVkIHRvIHJlcGFpciBvbmUsIGFuZFxuICAgKiB3aGF0IHRoZSBtYXAncyByZXNvbHZlZCBgdG9gIGhhZCBxdWlldGx5IHRocm93biBhd2F5LlxuICAgKlxuICAgKiDimqAgTk9UIEFOIEVSUk9SLiBBIGRhbmdsaW5nIGxpbmsgaXMgYSBmYWN0IGFib3V0IGEgc2V0LCBub3QgYSBmYWlsdXJlOiBPS0ZcbiAgICogwqcxMSdzIHJ1bGUsIGFuZCBpdCBpcyB3aHkgdGhpcyByZXBvcnRzIGFuZCBleGl0cyB6ZXJvLiBEb2N1bWVudHMgdGhhdCBwb2ludFxuICAgKiBhdCB0aGluZ3Mgbm90IHdyaXR0ZW4geWV0IGFyZSBub3JtYWwgaW4gYSB3b3JsZCBiaWJsZS5cbiAgICovXG4gIGRhbmdsaW5nTGlua3MoZW50cnlJZD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeUlkKTtcbiAgICBjb25zdCBicm9rZW4gPSBnLmVkZ2VzLmZpbHRlcigoZSkgPT4gZS5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIpO1xuICAgIC8vIOKblCBCT0RZIExJTkVTIEJFQ09NRSBGSUxFIExJTkVTIEhFUkUuIExpbmtzIGFyZSBleHRyYWN0ZWQgZnJvbSB0aGUgYm9keSxcbiAgICAvLyBzbyB0aGUgbnVtYmVyIHRoZSBncmFwaCBjYXJyaWVzIGlzIHNob3J0IGJ5IGhvd2V2ZXIgbXVjaCBmcm9udG1hdHRlciB0aGVcbiAgICAvLyBkb2N1bWVudCBoYXMg4oCUIGFuZCBhIHJlcG9ydCBpcyBmb3Igb3BlbmluZyBhIGZpbGUgYXQgYSBsaW5lLlxuICAgIGNvbnN0IG9mZnNldHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAgIGNvbnN0IG9mZnNldE9mID0gKHBhdGg6IHN0cmluZyk6IG51bWJlciA9PiB7XG4gICAgICBjb25zdCBrbm93biA9IG9mZnNldHMuZ2V0KHBhdGgpO1xuICAgICAgaWYgKGtub3duICE9PSB1bmRlZmluZWQpIHJldHVybiBrbm93bjtcbiAgICAgIGxldCBvZmYgPSAwO1xuICAgICAgdHJ5IHtcbiAgICAgICAgb2ZmID0gYm9keUxpbmVPZmZzZXQocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW5yZWFkYWJsZSDigJQgcmVwb3J0IHRoZSBib2R5IGxpbmUgcmF0aGVyIHRoYW4gbm90aGluZyAqL1xuICAgICAgfVxuICAgICAgb2Zmc2V0cy5zZXQocGF0aCwgb2ZmKTtcbiAgICAgIHJldHVybiBvZmY7XG4gICAgfTtcbiAgICByZXR1cm4ge1xuICAgICAgZW50cnk6IGcuZW50cnksXG4gICAgICByb290OiBnLnJvb3QsXG4gICAgICBjb3VudDogYnJva2VuLmxlbmd0aCxcbiAgICAgIGxpbmtzOiBicm9rZW4ubWFwKChlKSA9PiAoe1xuICAgICAgICBmcm9tOiBlLmZyb20sXG4gICAgICAgIC4uLihlLmxpbmUgIT09IHVuZGVmaW5lZCA/IHsgbGluZTogZS5saW5lICsgb2Zmc2V0T2YoZS5mcm9tKSB9IDoge30pLFxuICAgICAgICAvLyBXaGF0IHRoZSBkb2N1bWVudCBzYXlzLCBub3Qgd2hhdCB3ZSBsb29rZWQgZm9yLlxuICAgICAgICAuLi4oZS5yYXcgIT09IHVuZGVmaW5lZCA/IHsgd3JvdGU6IGUucmF3IH0gOiB7fSksXG4gICAgICAgIC8vIFdoZXJlIHRoZSByZXNvbHV0aW9uIGVuZGVkIHVwLCBzbyBhIG5lYXItbWlzcyBpcyB2aXNpYmxlLlxuICAgICAgICB0cmllZDogZS50byxcbiAgICAgICAgc291cmNlOiBlLnNvdXJjZSxcbiAgICAgICAgLi4uKGUua2V5ID8geyBrZXk6IGUua2V5IH0gOiB7fSksXG4gICAgICAgIC4uLihlLnJlbC5sZW5ndGggPyB7IHJlbDogZS5yZWwgfSA6IHt9KSxcbiAgICAgIH0pKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFdoYXQgY2l0ZXMgYSBkb2N1bWVudC4gYHJlbGF0ZWRgIChmcm9udG1hdHRlcikgYW5kIGBsaW5rc2AgKGJvZHkpIGFyZSBrZXB0XG4gICAqIEFQQVJULCB3aGljaCBpcyBob3cgcGRvY3MgcmVwb3J0cyBpdCBhbmQgdGhlIGRpc3RpbmN0aW9uIGlzIHJlYWw6IG9uZSBpcyBhXG4gICAqIGNsYWltIGFib3V0IHRoZSBkb2N1bWVudCwgdGhlIG90aGVyIGEgY2l0YXRpb24gaW4gcHJvc2UuXG4gICAqL1xuICBiYWNrbGlua3MocmF3UGF0aDogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSksXG4gICAgKTtcbiAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IGluc2lkZSBhIHNldCwgc28gbm90aGluZyBtYXBzIGl0YCwgNDAwKTtcbiAgICBjb25zdCBnID0gdGhpcy5ncmFwaEZvcihlbnRyeS5pZCk7XG4gICAgY29uc3QgaW5ib3VuZCA9IGcuZWRnZXMuZmlsdGVyKCh4KSA9PiB4LnRvID09PSBhYnMpO1xuICAgIGNvbnN0IHRpdGxlID0gKHA6IHN0cmluZykgPT4gZy5ub2Rlcy5maW5kKChuKSA9PiBuLnBhdGggPT09IHApPy50aXRsZSA/PyBiYXNlbmFtZShwKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGFyZ2V0OiB7IHBhdGg6IGFicywgdGl0bGU6IHRpdGxlKGFicykgfSxcbiAgICAgIHJlbGF0ZWQ6IGluYm91bmRcbiAgICAgICAgLmZpbHRlcigoeCkgPT4geC5zb3VyY2UgPT09IFwiZnJvbnRtYXR0ZXJcIilcbiAgICAgICAgLm1hcCgoeCkgPT4gKHsgcGF0aDogeC5mcm9tLCB0aXRsZTogdGl0bGUoeC5mcm9tKSwga2V5OiB4LmtleSB9KSksXG4gICAgICBsaW5rczogaW5ib3VuZFxuICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnNvdXJjZSA9PT0gXCJsaW5rXCIpXG4gICAgICAgIC5tYXAoKHgpID0+ICh7IHBhdGg6IHguZnJvbSwgdGl0bGU6IHRpdGxlKHguZnJvbSksIHJlbDogeC5yZWwgfSkpLFxuICAgICAgY291bnQ6IGluYm91bmQubGVuZ3RoLFxuICAgIH07XG4gIH1cblxuICAvKiogV2hlcmUgZG9lcyB0aGlzIGxpbmsgZ28/IFRoZSBzdXJmYWNlIGFza3MgYmVmb3JlIGZvbGxvd2luZyBvbmUgKEUzMykuICovXG4gIHJlc29sdmVMaW5rKGZyb206IHN0cmluZywgdGFyZ2V0OiBzdHJpbmcpOiBSZXNvbHV0aW9uIHtcbiAgICBjb25zdCBzcmMgPSB0aGlzLnNob3duUGF0aChmcm9tKTtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT4gZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgc3JjLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSxcbiAgICApO1xuICAgIGNvbnN0IHJvb3QgPSBlbnRyeT8ucm9vdCA/PyBkaXJuYW1lKHNyYyk7XG4gICAgY29uc3QgcGF0aHMgPSBlbnRyeSA/IGRvY1BhdGhzKGVudHJ5KSA6IFtzcmNdO1xuICAgIHJldHVybiByZXNvbHZlVGFyZ2V0KHRhcmdldCwgc3JjLCB7XG4gICAgICByb290LFxuICAgICAgcGF0aHMsXG4gICAgICBtZXRhT2Y6IChwKSA9PiByZWFkTWV0YShyZWFkSGVhZChwKSksXG4gICAgICBleGlzdHM6IChwKSA9PiBleGlzdHNTeW5jKHApLFxuICAgICAgcmVwb1Jvb3Q6IGdpdFJvb3RPZihyb290KSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGF0IGEgZnJvbnRtYXR0ZXIgYmxvY2sgZm9yIHRoaXMgZG9jdW1lbnQgV09VTEQgc2F5IChFMzUpLiBTdWdnZXN0ZWQsIG5vdFxuICAgKiB3cml0dGVuOiB0aGUgdHlwZSBjb21lcyBmcm9tIHRoZSBkb2N1bWVudHMgYmVzaWRlIGl0LCB0aGUgdGl0bGUgZnJvbSBpdHNcbiAgICogb3duIEgxLCBhbmQgYGRlc2NyaXB0aW9uYCBpcyBsZWZ0IGJsYW5rIGZvciB3aG9ldmVyIGZpbGxzIGl0IGluLlxuICAgKi9cbiAgc3VnZ2VzdE1ldGEocmF3UGF0aDogc3RyaW5nLCBieT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBibG9jazogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgaWYgKHNwbGl0RnJvbnRtYXR0ZXIodGV4dCkucmF3ICE9PSBudWxsKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHtiYXNlbmFtZShhYnMpfSBhbHJlYWR5IGhhcyBmcm9udG1hdHRlcmAsIDQwOSk7XG4gICAgY29uc3QgZm9sZGVyID0gZGlybmFtZShhYnMpO1xuICAgIGNvbnN0IHNpYmxpbmdzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIGZvciAoY29uc3QgcCBvZiBkb2NQYXRocyhlKSlcbiAgICAgICAgaWYgKHAgIT09IGFicyAmJiBkaXJuYW1lKHApID09PSBmb2xkZXIpIHtcbiAgICAgICAgICBjb25zdCB0ID0gcmVhZE1ldGEocmVhZEhlYWQocCkpPy50eXBlO1xuICAgICAgICAgIGlmICh0KSBzaWJsaW5ncy5wdXNoKHQpO1xuICAgICAgICB9XG4gICAgY29uc3QgdHlwZSA9IGd1ZXNzVHlwZShzaWJsaW5ncywgYmFzZW5hbWUoZm9sZGVyKSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGg6IGFicyxcbiAgICAgIHR5cGUsXG4gICAgICBibG9jazogYnVpbGRCbG9jayh7XG4gICAgICAgIC4uLih0eXBlID8geyB0eXBlIH0gOiB7fSksXG4gICAgICAgIC4uLih0aXRsZUZyb21Cb2R5KHRleHQpID8geyB0aXRsZTogdGl0bGVGcm9tQm9keSh0ZXh0KSBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgLi4uKGJ5ID8geyBieSB9IDoge30pLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXcml0ZSBhIG5ldyBibG9jayBpbnRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAoRTM1KS5cbiAgICpcbiAgICog4puUIFRISVMgV1JJVEVTIFRIRSBPUklHSU5BTCwgd2hpY2ggRTcgb3RoZXJ3aXNlIHJlc2VydmVzIGZvciBTYXZlIOKAlCBhbmRcbiAgICogdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW4gb3ZlcnNpZ2h0OiB0aGUgYWdlbnQncyB2ZXJiIHdyaXRlcyB0aGUgZmlsZSwgYW5kXG4gICAqIGlmIHRoZSBodW1hbiBoYXMgdW5zYXZlZCBlZGl0cyB0byBpdCB0aGUgQ09ORkxJQ1QgQkFSIGFwcGVhcnMgYW5kIHRoZXlcbiAgICogY2hvb3NlIChDb2xlOiBcIndlIGNhbiBhZGp1c3QgaWYgbmVlZGVkIGFmdGVyIGdldHRpbmcgYWN0dWFsIHVzYWdlIGJlaGluZFxuICAgKiB1c1wiKS4gUmVmdXNpbmcgd2hpbGUgYSBidWZmZXIgaXMgZGlydHkgd291bGQgbGV0IGFuIG9wZW4gZG9jdW1lbnQgYmxvY2sgdGhlXG4gICAqIGFnZW50IGluZGVmaW5pdGVseS4gVGhlIEhVTUFOJ3Mgb3duIHBhdGggbmV2ZXIgY29tZXMgaGVyZTogdGhlaXIgXCJhZGRcbiAgICogZnJvbnRtYXR0ZXJcIiBpcyBhbiBlZGl0IHRvIHRoZWlyIGJ1ZmZlciwgd2hpY2ggU2F2ZSB3cml0ZXMgbGlrZSBhbnkgb3RoZXIuXG4gICAqL1xuICBtZXRhSW5pdChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmcgfSA9IHt9KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IHN1Z2dlc3RlZCA9IHRoaXMuc3VnZ2VzdE1ldGEocmF3UGF0aCwgb3B0cy5ieSk7XG4gICAgY29uc3QgYWJzID0gc3VnZ2VzdGVkLnBhdGg7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICBjb25zdCBibG9jayA9IG9wdHMudHlwZVxuICAgICAgPyBidWlsZEJsb2NrKHtcbiAgICAgICAgICB0eXBlOiBvcHRzLnR5cGUsXG4gICAgICAgICAgLi4uKHRpdGxlRnJvbUJvZHkodGV4dCkgPyB7IHRpdGxlOiB0aXRsZUZyb21Cb2R5KHRleHQpIGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAgIC4uLihvcHRzLmJ5ID8geyBieTogb3B0cy5ieSB9IDoge30pLFxuICAgICAgICB9KVxuICAgICAgOiBzdWdnZXN0ZWQuYmxvY2s7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHdpdGhCbG9jayh0ZXh0LCBibG9jaykpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgdHlwZTogb3B0cy50eXBlID8/IHN1Z2dlc3RlZC50eXBlID8/IG51bGwsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogU2V0IGtleXMgaW4gYW4gZXhpc3RpbmcgYmxvY2sg4oCUIGEgTElORSBlZGl0IGVhY2gsIHNvIG5vdGhpbmcgZWxzZSBtb3Zlcy4gKi9cbiAgbWV0YVNldChyYXdQYXRoOiBzdHJpbmcsIHBhaXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc2hvd25QYXRoKHJhd1BhdGgpO1xuICAgIGxldCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIGlmIChzcGxpdEZyb250bWF0dGVyKHRleHQpLnJhdyA9PT0gbnVsbClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YmFzZW5hbWUoYWJzKX0gaGFzIG5vIGZyb250bWF0dGVyIOKAlCBhZGQgaXQgZmlyc3QgKG1ldGEtaW5pdClgLCA0MDkpO1xuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBhaXJzKSkge1xuICAgICAgaWYgKCEvXltBLVphLXpfXVtBLVphLXowLTlfLi1dKiQvLnRlc3Qoa2V5KSlcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke2tleX1cIiBpcyBub3QgYSBmcm9udG1hdHRlciBrZXlgLCA0MDApO1xuICAgICAgdGV4dCA9IHNldEtleSh0ZXh0LCBrZXksIHZhbHVlKTtcbiAgICB9XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIHRleHQpO1xuICAgIHRoaXMubWV0YUNhY2hlLmRlbGV0ZShhYnMpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicywgc2V0OiBPYmplY3Qua2V5cyhwYWlycykgfTtcbiAgfVxuXG4gIC8qKiBUaGUgc2Vzc2lvbidzIGhhbGYgb2YgYFB1YmxpY1N0YXRlYDsgdGhlIGRhZW1vbiBhZGRzIHRoZSBob21lLWxldmVsIGBwcmVmc2AgYW5kIGB1c2VySG9tZWAuICovXG4gIC8qKlxuICAgKiBUaGUgY29udmVyc2F0aW9uLCB3aXRob3V0IGJ1aWxkaW5nIGEgc25hcHNob3QgYXJvdW5kIGl0LlxuICAgKlxuICAgKiDimqAgRTUzJ3MgYXR0ZW50aW9uIHRpY2sgcnVucyBldmVyeSBzZWNvbmQgYW5kIG9ubHkgbmVlZHMgdGhlIGNoYXQ7IGNhbGxpbmdcbiAgICogYHZpZXcoKWAgZm9yIGl0IHdvdWxkIHJlLXJlYWQgZXZlcnkgZG9jdW1lbnQncyBmcm9udG1hdHRlciBvbiBhIHRpbWVyLlxuICAgKi9cbiAgbWVzc2FnZXMoKTogcmVhZG9ubHkgQ2hhdE1lc3NhZ2VbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jaGF0O1xuICB9XG5cbiAgdmlldyhcbiAgICBtb2RlOiBcImRldlwiIHwgXCJyZWxlYXNlXCIsXG4gICAgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsLFxuICAgIC8vIOKaoCBgd2FpdGluZ2AgaXMgdGhlIFNFUlZFUidzIHRvIGFkZCAoRTUzKTogaXQgZGVwZW5kcyBvbiB0aGUgY2xvY2sgYW5kIG9uXG4gICAgLy8gdGhlIHNub296ZSB0aGUgc2VydmVyIGhvbGRzLCBuZWl0aGVyIG9mIHdoaWNoIGJlbG9uZ3MgaW4gdGhlIHNlc3Npb24uXG4gICAgLy8g4pqgIGB3YWl0aW5nYCBhbmQgYGhpc3RvcnlgIGFyZSB0aGUgU0VSVkVSJ3MgdG8gYWRkIChFNTMsIEU2MCk6IG9uZSBkZXBlbmRzXG4gICAgLy8gb24gdGhlIGNsb2NrIGFuZCB0aGUgc25vb3plIGl0IGhvbGRzLCB0aGUgb3RoZXIgb24gdGhlIGluLW1lbW9yeSBhY3RcbiAgICAvLyBzdGFja3MuIE5laXRoZXIgYmVsb25ncyBpbiB0aGUgc2Vzc2lvbidzIHBlcnNpc3RlZCBzdGF0ZS5cbiAgKTogT21pdDxQdWJsaWNTdGF0ZSwgXCJwcmVmc1wiIHwgXCJ1c2VySG9tZVwiIHwgXCJ3YWl0aW5nXCIgfCBcImhpc3RvcnlcIj4ge1xuICAgIGNvbnN0IG1ldGEgPSB0aGlzLmNvbnRleHRNZXRhKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy53b3Jrc3BhY2UsXG4gICAgICBkb2NNZXRhOiBtZXRhLm1hcCxcbiAgICAgIC4uLihtZXRhLnRydW5jYXRlZCA/IHsgZG9jTWV0YVRydW5jYXRlZDogdHJ1ZSB9IDoge30pLFxuICAgICAgbW9kZSxcbiAgICAgIGNvbnRleHQ6IHRoaXMubS5jb250ZXh0LFxuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiB0aGlzLmRvY1ZpZXcoZCkpLFxuICAgICAgb3BlbkRvYzogdGhpcy5tLm9wZW5Eb2MsXG4gICAgICBzZWxlY3Rpb24sXG4gICAgICBjaGF0OiB0aGlzLm0uY2hhdCxcbiAgICAgIHRhc2tzOiB0aGlzLnRhc2tzKCksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBnaXQgd29ya2luZyB0cmVlIGBkaXJgIGlzIGluLCBvciBudWxsLiBBIGAuZ2l0YCBFTlRSWSwgbm90IGEgZGlyZWN0b3J5XG4gKiB0ZXN0OiBhIHdvcmt0cmVlIGFuZCBhIHN1Ym1vZHVsZSBib3RoIGhhdmUgYC5naXRgIGFzIGEgRklMRS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdpdFJvb3RPZihkaXI6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBsZXQgYXQgPSBkaXI7XG4gIGZvciAoOzspIHtcbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKGF0LCBcIi5naXRcIikpKSByZXR1cm4gYXQ7XG4gICAgY29uc3QgdXAgPSBkaXJuYW1lKGF0KTtcbiAgICBpZiAodXAgPT09IGF0KSByZXR1cm4gbnVsbDtcbiAgICBhdCA9IHVwO1xuICB9XG59XG5cbi8qKiBEb2N1bWVudHMgdW5kZXIgYSBmb2xkZXIsIGZvciBzYXlpbmcgaG93IG11Y2ggYSBtb3ZlIG1vdmVzLiAqL1xuZnVuY3Rpb24gY291bnREb2NzKGRpcjogc3RyaW5nKTogbnVtYmVyIHtcbiAgbGV0IG4gPSAwO1xuICBjb25zdCB3YWxrID0gKGF0OiBzdHJpbmcpID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGF0KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGF0LCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHdhbGsoYWJzKTtcbiAgICAgIGVsc2UgaWYgKGlzRG9jTmFtZShuYW1lKSkgbisrO1xuICAgIH1cbiAgfTtcbiAgd2FsayhkaXIpO1xuICByZXR1cm4gbjtcbn1cblxuLyoqXG4gKiBIb3cgYSBjb21wYXJpc29uIHNpZGUgcmVhZHMgaW4gYSBtZXNzYWdlIHRvIGEgaHVtYW4gb3IgYW4gYWdlbnQuXG4gKlxuICog4puUIFRIRSBGSUxFIElTIE5BTUVELCBOT1QgREVTQ1JJQkVEIChFNDMsIHJldmlzZWQpLiBcIlRoZSBvcmlnaW5hbFwiIHNvdW5kZWRcbiAqIHRlbXBvcmFsIHdoZW4gdGhlIHRoaW5nIGlzIGxvY2F0aW9uYWw7IFwidGhlIHNhdmVkIGZpbGVcIiBmaXhlZCB0aGF0IGJ1dCByZWFkc1xuICogY2lyY3VsYXIgdGhlIG1vbWVudCBpdCBpcyBhIERFU1RJTkFUSU9OIOKAlCBcInNhdmUgdG8gdGhlIHNhdmVkIGZpbGVcIiBzYXlzXG4gKiBub3RoaW5nLiBObyBub3VuIGVuY2Fwc3VsYXRlcyBcInRoaXMgZmlsZSwgYXQgdGhpcyBwbGFjZVwiLCBzbyB0aGUgZmlsZSBnZXRzXG4gKiBpdHMgb3duIG5hbWU6IGBub3RlLm1kYC4gQ29sZTogXCJ0aGF0J3MgcHJvYmFibHkgY2xvc2VyIHRvIHRoZSByaWdodCBhbnN3ZXJcbiAqIHZlcnN1cyB0cnlpbmcgdG8gY29tZSB1cCB3aXRoIGEgd29yZCB0aGF0IGVuY2Fwc3VsYXRlcyBpdC5cIlxuICpcbiAqIGBmaWxlYCBpcyB0aGUgZG9jdW1lbnQncyBuYW1lIHdoZW4gdGhlIGNhbGxlciBrbm93cyBpdDsgd2l0aG91dCBvbmUgdGhpc1xuICogZmFsbHMgYmFjayB0byBhIGdlbmVyaWMsIHdoaWNoIGlzIG9ubHkgZm9yIGNvbnRleHRzIHRoYXQgaGF2ZSBubyBkb2N1bWVudCBpblxuICogaGFuZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNpZGVOYW1lKHNpZGU6IERpZmZTaWRlLCBmaWxlPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHNpZGUgIT09IFwib3JpZ2luYWxcIikgcmV0dXJuIGB2JHtzaWRlfWA7XG4gIHJldHVybiBmaWxlID8/IFwidGhlIHNhdmVkIGZpbGVcIjtcbn1cbiIsCiAgICAiLyoqXG4gKiBPS0YgZnJvbnRtYXR0ZXIsIHJlYWQgKEUzMikuIFRoZSBkYWVtb24gcGFyc2VzOyB0aGUgc3VyZmFjZSByZW5kZXJzIHdoYXQgaXRcbiAqIGlzIGdpdmVuIOKAlCBgQnVuLllBTUwucGFyc2VgIGlzIGhlcmUsIHNvIG5vIFlBTUwgcGFyc2VyIHJlYWNoZXMgdGhlIGJyb3dzZXIuXG4gKlxuICog4puUIFRIRSBTUEVDJ1MgVEVNUEVSIElTIFRIRSBQT0lOVCwgQU5EIElUIElTIE5PVCBUSEUgVVNVQUwgT05FLiBBIGNvbnN1bWVyXG4gKiBcIk1VU1QgTk9UIHJlamVjdCBkb2N1bWVudHNcIiBmb3IgdW5rbm93biB0eXBlcywgdW5rbm93biBrZXlzLCBtaXNzaW5nIG9wdGlvbmFsXG4gKiBmaWVsZHMgb3IgYnJva2VuIGxpbmtzLCBhbmQgXCJTSE9VTEQgcHJlc2VydmUgdW5rbm93biBrZXlzIHdoZW4gcm91bmQtdHJpcHBpbmdcIlxuICogKE9LRiAwLjIgwqcxMSkuIFNvIG5vdGhpbmcgaGVyZSB2YWxpZGF0ZXM6IGEgZG9jdW1lbnQgd2hvc2UgZnJvbnRtYXR0ZXIgd2lsbFxuICogbm90IHBhcnNlIGtlZXBzIGl0cyB0ZXh0IGFuZCByZXBvcnRzIHRoZSByZWFzb24sIGV2ZXJ5IGtleSBzdXJ2aXZlcyBpblxuICogYGZpZWxkc2Agd2hldGhlciBvciBub3QgdGhpcyBzcGVsbCBoYXMgaGVhcmQgb2YgaXQsIGFuZCBgdHlwZWAg4oCUIHRoZSBPTkVcbiAqIHJlcXVpcmVkIGZpZWxkIOKAlCBiZWluZyBhYnNlbnQgaXMgYSBmYWN0IHRvIHNob3csIG5ldmVyIGFuIGVycm9yIHRvIHJhaXNlLlxuICpcbiAqIFRoZSBERVJJVkVEIHZhbHVlcyAodHJ1c3QsIHN0YWxlbmVzcykgYXJlIGNvbXB1dGVkIG9uIHJlYWQgYW5kIG5ldmVyIHN0b3JlZCxcbiAqIHdoaWNoIGlzIGFsc28gdGhlIHNwZWMncyBydWxlOiBhIHRydXN0IHRpZXIgd3JpdHRlbiBpbnRvIGEgZmlsZSB3b3VsZCBiZSBhXG4gKiBjbGFpbSBhYm91dCBpdHNlbGYuXG4gKi9cbmltcG9ydCB0eXBlIHsgRG9jTWV0YSwgRG9jU3VtbWFyeSwgVHJ1c3RUaWVyIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIEEgZnJvbnRtYXR0ZXIgYmxvY2s6IGAtLS1gIG9uIGl0cyBvd24gZmlyc3QgbGluZSwgdG8gdGhlIG5leHQgYC0tLWAgbGluZS4gKi9cbmNvbnN0IEJMT0NLID0gL14tLS1cXHI/XFxuKFtcXHNcXFNdKj8pXFxyP1xcbi0tLVsgXFx0XSooPzpcXHI/XFxufCQpLztcblxuLyoqXG4gKiBTcGxpdCBhIGRvY3VtZW50IGludG8gaXRzIHJhdyBmcm9udG1hdHRlciBibG9jayBhbmQgdGhlIGJvZHkgYmVuZWF0aCBpdC5cbiAqIFB1cmUgc3RyaW5nIHdvcmssIG5vIFlBTUwg4oCUIHRoZSBTVVJGQUNFIGhhcyB0aGUgc2FtZSBmdW5jdGlvbiAoaXQgbXVzdCBzdHJpcFxuICogdGhlIGJsb2NrIGJlZm9yZSByZW5kZXJpbmcpIGFuZCBgZnJvbnRtYXR0ZXIudGVzdC50c2AgaG9sZHMgdGhlIHR3byBlcXVhbC5cbiAqL1xuLyoqXG4gKiBIb3cgbWFueSBsaW5lcyBvZiBhIGRvY3VtZW50IGNvbWUgQkVGT1JFIGl0cyBib2R5IOKAlCB0aGUgZnJvbnRtYXR0ZXIgYmxvY2sgYW5kXG4gKiBpdHMgZGVsaW1pdGVycy5cbiAqXG4gKiDim5QgV0lUSE9VVCBUSElTIEEgUkVQT1JURUQgTElORSBOVU1CRVIgSVMgQSBMSUUuIExpbmtzIGFyZSBleHRyYWN0ZWQgZnJvbSB0aGVcbiAqIEJPRFksIHNvIGEgbGluayBvbiBib2R5IGxpbmUgOSBvZiBhIGRvY3VtZW50IHdpdGggZm91ciBsaW5lcyBvZiBmcm9udG1hdHRlclxuICogaXMgb24gRklMRSBsaW5lIDEzIOKAlCBhbmQgYSByZXBvcnQgdGhhdCBzYXlzIDkgc2VuZHMgd2hvZXZlciBpcyBmaXhpbmcgaXQgdG9cbiAqIHRoZSB3cm9uZyBwbGFjZSwgY29uZmlkZW50bHkuIENhdWdodCB0aGUgbW9tZW50IEU1NCdzIHJlcG9ydCB3YXMgZmlyc3QgcmVhZFxuICogYWdhaW5zdCBhIGRvY3VtZW50IHRoYXQgaGFkIGZyb250bWF0dGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9keUxpbmVPZmZzZXQodGV4dDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgeyBib2R5IH0gPSBzcGxpdEZyb250bWF0dGVyKHRleHQpO1xuICBjb25zdCBwcmVmaXggPSB0ZXh0LnNsaWNlKDAsIHRleHQubGVuZ3RoIC0gYm9keS5sZW5ndGgpO1xuICBsZXQgbGluZXMgPSAwO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHByZWZpeC5sZW5ndGg7IGkrKykgaWYgKHByZWZpeC5jaGFyQ29kZUF0KGkpID09PSAxMCkgbGluZXMrKztcbiAgcmV0dXJuIGxpbmVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3BsaXRGcm9udG1hdHRlcih0ZXh0OiBzdHJpbmcpOiB7IHJhdzogc3RyaW5nIHwgbnVsbDsgYm9keTogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gQkxPQ0suZXhlYyh0ZXh0KTtcbiAgaWYgKCFtKSByZXR1cm4geyByYXc6IG51bGwsIGJvZHk6IHRleHQgfTtcbiAgcmV0dXJuIHsgcmF3OiBtWzFdID8/IFwiXCIsIGJvZHk6IHRleHQuc2xpY2UobVswXS5sZW5ndGgpIH07XG59XG5cbi8qKiBPS0YncyB0aHJlZSwgYW5kIGFueXRoaW5nIGVsc2UgYSBwcm9kdWNlciB3cm90ZS4gYHN0YWJsZWAgaXMgdGhlIGRlZmF1bHQuICovXG5mdW5jdGlvbiBzdGF0dXNPZihmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgY29uc3QgcyA9IGZpZWxkcy5zdGF0dXM7XG4gIHJldHVybiB0eXBlb2YgcyA9PT0gXCJzdHJpbmdcIiAmJiBzLnRyaW0oKSAhPT0gXCJcIiA/IHMgOiBcInN0YWJsZVwiO1xufVxuXG5jb25zdCBhc0xpc3QgPSAodjogdW5rbm93bik6IHN0cmluZ1tdID0+XG4gIEFycmF5LmlzQXJyYXkodikgPyB2LmZpbHRlcigoeCkgPT4gdHlwZW9mIHggPT09IFwic3RyaW5nXCIpIDogdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyBbdl0gOiBbXTtcblxuLyoqIEFuIGFjdG9yIGlzIGh1bWFuIGlmZiBpdCBpcyBzcGVsbGVkIGBodW1hbjo8aWQ+YCDigJQgT0tGIDAuMiDCpzYncyBydWxlLiAqL1xuY29uc3QgaXNIdW1hbiA9IChhY3RvcjogdW5rbm93bik6IGJvb2xlYW4gPT5cbiAgdHlwZW9mIGFjdG9yID09PSBcInN0cmluZ1wiICYmIGFjdG9yLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChcImh1bWFuOlwiKTtcblxuLyoqXG4gKiBPS0YncyB0cnVzdCB0aWVycywgREVSSVZFRDogbm8gYHZlcmlmaWVkYCDihpIgdW52ZXJpZmllZDsgdmVyaWZpZWQgYnkgbWFjaGluZXNcbiAqIG9ubHkg4oaSIG1hY2hpbmUtY29uZmlybWVkOyB2ZXJpZmllZCBieSBhIGBodW1hbjo8aWQ+YCDihpIgaHVtYW4tcmV2aWV3ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cnVzdFRpZXIoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFRydXN0VGllciB7XG4gIGNvbnN0IHZlcmlmaWVkID0gZmllbGRzLnZlcmlmaWVkO1xuICBjb25zdCBldmVudHMgPSBBcnJheS5pc0FycmF5KHZlcmlmaWVkKSA/IHZlcmlmaWVkIDogdmVyaWZpZWQgPyBbdmVyaWZpZWRdIDogW107XG4gIGlmIChldmVudHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJ1bnZlcmlmaWVkXCI7XG4gIGZvciAoY29uc3QgZSBvZiBldmVudHMpXG4gICAgaWYgKGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgaXNIdW1hbigoZSBhcyB7IGJ5PzogdW5rbm93biB9KS5ieSkpIHJldHVybiBcImh1bWFuLXJldmlld2VkXCI7XG4gIHJldHVybiBcIm1hY2hpbmUtY29uZmlybWVkXCI7XG59XG5cbi8qKiBgc3RhbGVfYWZ0ZXJgIGlzIGFuIElOU1RBTlQsIG5vdCBhIFRUTDogc3RhbGUgd2hlbiBub3cgPj0gaXQuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTdGFsZShmaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBub3c6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBhdCA9IGZpZWxkcy5zdGFsZV9hZnRlcjtcbiAgY29uc3QgdCA9XG4gICAgYXQgaW5zdGFuY2VvZiBEYXRlID8gYXQuZ2V0VGltZSgpIDogdHlwZW9mIGF0ID09PSBcInN0cmluZ1wiID8gRGF0ZS5wYXJzZShhdCkgOiBOdW1iZXIuTmFOO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIG5vdyA+PSB0O1xufVxuXG4vKiogV2hlbiB0aGUgY29udGVudCBsYXN0IG1lYW5pbmdmdWxseSBjaGFuZ2VkLCBwZXIgYGdlbmVyYXRlZC5hdGAsIGFzIGFuIElTTyBkYXRlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlZEF0KGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZyA9IGZpZWxkcy5nZW5lcmF0ZWQ7XG4gIGNvbnN0IGF0ID0gZyAmJiB0eXBlb2YgZyA9PT0gXCJvYmplY3RcIiA/IChnIGFzIHsgYXQ/OiB1bmtub3duIH0pLmF0IDogdW5kZWZpbmVkO1xuICBpZiAoYXQgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gYXQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGlmICh0eXBlb2YgYXQgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCB0ID0gRGF0ZS5wYXJzZShhdCk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSA/IG5ldyBEYXRlKHQpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApIDogYXQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmNvbnN0IHN0ciA9ICh2OiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpICE9PSBcIlwiID8gdi50cmltKCkgOiB1bmRlZmluZWQ7XG5cbi8qKlxuICogUmVhZCBhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIuIFJldHVybnMgbnVsbCB3aGVuIHRoZXJlIGlzIG5vIGJsb2NrIGF0IGFsbCDigJRcbiAqIHdoaWNoIGlzIGEgbm9ybWFsIGRvY3VtZW50LCBub3QgYSBkZWZlY3QuIEEgYmxvY2sgdGhhdCB3aWxsIG5vdCBwYXJzZSBjb21lc1xuICogYmFjayB3aXRoIGBlcnJvcmAgc2V0IGFuZCBldmVyeSBvdGhlciBmaWVsZCBlbXB0eTogc2FpZCwgbm90IHN3YWxsb3dlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRNZXRhKHRleHQ6IHN0cmluZywgbm93ID0gRGF0ZS5ub3coKSk6IERvY01ldGEgfCBudWxsIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBsZXQgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBsZXQgZXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBCdW4uWUFNTC5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgaWYgKHBhcnNlZCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZCkpXG4gICAgICBmaWVsZHMgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgZWxzZSBpZiAocGFyc2VkICE9PSBudWxsICYmIHBhcnNlZCAhPT0gdW5kZWZpbmVkKVxuICAgICAgZXJyb3IgPSBcInRoZSBmcm9udG1hdHRlciBpcyBub3QgYSBtYXBwaW5nIG9mIGtleXMgdG8gdmFsdWVzXCI7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZS5zcGxpdChcIlxcblwiKVswXSA6IFN0cmluZyhlKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHJhdyxcbiAgICBmaWVsZHMsXG4gICAgdHlwZTogc3RyKGZpZWxkcy50eXBlKSxcbiAgICB0aXRsZTogc3RyKGZpZWxkcy50aXRsZSksXG4gICAgZGVzY3JpcHRpb246IHN0cihmaWVsZHMuZGVzY3JpcHRpb24pLFxuICAgIHN0YXR1czogc3RhdHVzT2YoZmllbGRzKSxcbiAgICB0YWdzOiBhc0xpc3QoZmllbGRzLnRhZ3MpLFxuICAgIGxpZmVjeWNsZTogc3RyKGZpZWxkcy5saWZlY3ljbGUpLFxuICAgIHRydXN0OiB0cnVzdFRpZXIoZmllbGRzKSxcbiAgICBzdGFsZTogaXNTdGFsZShmaWVsZHMsIG5vdyksXG4gICAgZGF0ZTogZ2VuZXJhdGVkQXQoZmllbGRzKSxcbiAgICAuLi4oZXJyb3IgPyB7IGVycm9yIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKiBUaGUgc21hbGwgc2hhcGUgdGhlIHNpZGViYXIgbmVlZHMgZm9yIGV2ZXJ5IGNvbnRleHQgZG9jdW1lbnQuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXplKG1ldGE6IERvY01ldGEgfCBudWxsKTogRG9jU3VtbWFyeSB8IG51bGwge1xuICBpZiAoIW1ldGEpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIC4uLihtZXRhLnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgIC4uLihtZXRhLnRpdGxlID8geyB0aXRsZTogbWV0YS50aXRsZSB9IDoge30pLFxuICAgIHN0YXR1czogbWV0YS5zdGF0dXMsXG4gICAgdGFnczogbWV0YS50YWdzLFxuICAgIHRydXN0OiBtZXRhLnRydXN0LFxuICAgIHN0YWxlOiBtZXRhLnN0YWxlLFxuICAgIC4uLihtZXRhLmxpZmVjeWNsZSA/IHsgbGlmZWN5Y2xlOiBtZXRhLmxpZmVjeWNsZSB9IDoge30pLFxuICAgIC4uLihtZXRhLmVycm9yID8geyBlcnJvcjogbWV0YS5lcnJvciB9IDoge30pLFxuICB9O1xufVxuXG4vKiogcGRvY3MncyBmaWx0ZXIgdm9jYWJ1bGFyeSwgc28gd2hhdCB0aGUgaHVtYW4gbGVhcm5zIHRoZXJlIGhvbGRzIGhlcmUuICovXG5leHBvcnQgdHlwZSBNZXRhRmlsdGVyID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGxpZmVjeWNsZT86IHN0cmluZztcbiAgdGFnPzogc3RyaW5nO1xuICAvKiogQW4gSVNPIGRhdGU7IG1hdGNoZXMgZG9jdW1lbnRzIHdob3NlIGBnZW5lcmF0ZWQuYXRgIGlzIG9uIG9yIGFmdGVyIGl0LiAqL1xuICBzaW5jZT86IHN0cmluZztcbn07XG5cbi8qKlxuICogRmlsdGVycyBhcmUgQU5EZWQsIGFuZCBldmVyeSBvbmUgaXMgb3B0aW9uYWwg4oCUIGEgYmFyZSBmaWx0ZXIgbWF0Y2hlcyBhbGwuXG4gKlxuICog4puUIEEgRE9DVU1FTlQgV0lUSCBOTyBGUk9OVE1BVFRFUiBNQVRDSEVTIE9OTFkgVEhFIEVNUFRZIEZJTFRFUiwgYW5kIHRoYXRcbiAqIGluY2x1ZGVzIGAtLXN0YXR1cyBzdGFibGVgLiBBYnNlbnQgYHN0YXR1c2AgZGVmYXVsdHMgdG8gYHN0YWJsZWAgZm9yIGFuIE9LRlxuICogZG9jdW1lbnQgKMKnNSksIGJ1dCBhIGRvY3VtZW50IHdpdGggbm8gYmxvY2sgYXQgYWxsIGlzIG5vdCBtYWtpbmcgdGhlIGNsYWltOlxuICogYGZpbmQgLS1zdGF0dXMgc3RhYmxlYCBhc2tzIHdoaWNoIGRvY3VtZW50cyBTQVkgdGhleSBhcmUgc3RhYmxlLCBhbmQgYSBmaWxlXG4gKiB3aXRoIG5vIGZyb250bWF0dGVyIHNheXMgbm90aGluZy4gUmVhZGluZyB0aGUgZGVmYXVsdCB0aGUgb3RoZXIgd2F5IHdvdWxkIHB1dFxuICogZXZlcnkgdW50b3VjaGVkIG5vdGUgaW4gdGhlIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hdGNoZXNGaWx0ZXIobWV0YTogRG9jTWV0YSB8IG51bGwsIGZpbHRlcjogTWV0YUZpbHRlcik6IGJvb2xlYW4ge1xuICBpZiAobWV0YSA9PT0gbnVsbCkgcmV0dXJuIE9iamVjdC52YWx1ZXMoZmlsdGVyKS5ldmVyeSgodikgPT4gdiA9PT0gdW5kZWZpbmVkKTtcbiAgaWYgKGZpbHRlci50eXBlICE9PSB1bmRlZmluZWQgJiYgbWV0YS50eXBlICE9PSBmaWx0ZXIudHlwZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVyLnN0YXR1cyAhPT0gdW5kZWZpbmVkICYmIG1ldGEuc3RhdHVzICE9PSBmaWx0ZXIuc3RhdHVzKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIubGlmZWN5Y2xlICE9PSB1bmRlZmluZWQgJiYgbWV0YS5saWZlY3ljbGUgIT09IGZpbHRlci5saWZlY3ljbGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGZpbHRlci50YWcgIT09IHVuZGVmaW5lZCAmJiAhbWV0YS50YWdzLmluY2x1ZGVzKGZpbHRlci50YWcpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXIuc2luY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghbWV0YS5kYXRlKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG1ldGEuZGF0ZSA8IGZpbHRlci5zaW5jZSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyDilIDilIAgV1JJVElORyAoRTM1KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyDim5QgRVZFUlkgV1JJVEUgSEVSRSBJUyBBIFRFWFQgRURJVCwgTkVWRVIgQSBSRVNFUklBTElTQVRJT04uIFBhcnNpbmcgYSBibG9ja1xuLy8gYW5kIHByaW50aW5nIGl0IGJhY2sgcmVvcmRlcnMga2V5cywgZHJvcHMgY29tbWVudHMgYW5kIGNoYW5nZXMgcXVvdGluZyDigJQgYW5kXG4vLyB0aGUgc3BlYyBhc2tzIGEgY29uc3VtZXIgdG8gXCJwcmVzZXJ2ZSB1bmtub3duIGtleXMgd2hlbiByb3VuZC10cmlwcGluZ1wiXG4vLyAowqcxMSksIHdoaWNoIGlzIHByZWNpc2VseSB3aGF0IHRoYXQgbG9zZXMuIFNvIGEgbmV3IGJsb2NrIGlzIEJVSUxUICh0aGVyZSBpc1xuLy8gbm90aGluZyB0byBwcmVzZXJ2ZSB5ZXQpIGFuZCBhbiBleGlzdGluZyBvbmUgaXMgZWRpdGVkIGEgTElORSBhdCBhIHRpbWUuXG5cbi8qKiBUaGUgZG9jdW1lbnQncyBmaXJzdCBIMSwgd2hpY2ggaXMgdGhlIHRpdGxlIGEgaHVtYW4gYWxyZWFkeSB3cm90ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aXRsZUZyb21Cb2R5KGJvZHk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IC9eI1xccysoLis/KVxccyokLy5leGVjKGxpbmUpO1xuICAgIGlmIChtKSByZXR1cm4gbVsxXTtcbiAgICBpZiAobGluZS50cmltKCkgIT09IFwiXCIgJiYgIWxpbmUuc3RhcnRzV2l0aChcIiNcIikpIGJyZWFrOyAvLyBwcm9zZSBiZWZvcmUgYW55IGhlYWRpbmdcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEEgYHR5cGVgIHRvIFNVR0dFU1QgZm9yIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZS5cbiAqXG4gKiDim5QgRlJPTSBUSEUgTkVJR0hCT1VSUywgTkVWRVIgRlJPTSBBIEZJWEVEIExJU1QuIE9LRidzIGB0eXBlYCBpcyBcIm5vdFxuICogY2VudHJhbGx5IHJlZ2lzdGVyZWRcIiBhbmQgZXZlcnkgY29ycHVzIGludmVudHMgaXRzIG93biDigJQgYHJlcG9ydGAsIGBydWxlYCxcbiAqIGBhcmNoZXR5cGVgIGluIG9uZSwgc29tZXRoaW5nIGVsc2UgaW4gdGhlIG5leHQg4oCUIHNvIHRoZSBvbmx5IGhvbmVzdCBzb3VyY2UgaXNcbiAqIHdoYXQgdGhlIGRvY3VtZW50cyBiZXNpZGUgdGhpcyBvbmUgYWxyZWFkeSBzYXkuIFRoZSBmb2xkZXIncyBuYW1lIGlzIHRoZVxuICogZmFsbGJhY2ssIGFuZCB3aGVuIG5laXRoZXIgYW5zd2Vycywgbm90aGluZyBpcyBzdWdnZXN0ZWQ6IGEgYmxhbmsgdGhlIGh1bWFuXG4gKiBmaWxscyBiZWF0cyBhIHBsYXVzaWJsZSBndWVzcyAoU0NIRU1BLm1kJ3Mgb3duIHJ1bGUgYWJvdXQgYGdlbmVyYXRlZC5ieWApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3Vlc3NUeXBlKHNpYmxpbmdUeXBlczogcmVhZG9ubHkgc3RyaW5nW10sIGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB0IG9mIHNpYmxpbmdUeXBlcykgaWYgKHQpIGNvdW50cy5zZXQodCwgKGNvdW50cy5nZXQodCkgPz8gMCkgKyAxKTtcbiAgY29uc3QgYmVzdCA9IFsuLi5jb3VudHMuZW50cmllcygpXS5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSB8fCBhWzBdLmxvY2FsZUNvbXBhcmUoYlswXSkpWzBdO1xuICBpZiAoYmVzdCkgcmV0dXJuIGJlc3RbMF07XG4gIGNvbnN0IG5hbWUgPSBmb2xkZXIudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuYW1lID09PSBcIlwiIHx8IG5hbWUgPT09IFwiLlwiIHx8IG5hbWUgPT09IFwiL1wiKSByZXR1cm4gdW5kZWZpbmVkO1xuICAvLyBgZGVjaXNpb25zL2Ag4oaSIGBkZWNpc2lvbmA7IGBkb2NzL2Ag4oaSIGBkb2NgLiBBIHBsdXJhbCBmb2xkZXIgbmFtZXMgaXRzIGtpbmQuXG4gIHJldHVybiBuYW1lLmVuZHNXaXRoKFwiaWVzXCIpXG4gICAgPyBgJHtuYW1lLnNsaWNlKDAsIC0zKX15YFxuICAgIDogbmFtZS5lbmRzV2l0aChcInNcIilcbiAgICAgID8gbmFtZS5zbGljZSgwLCAtMSlcbiAgICAgIDogbmFtZTtcbn1cblxuLyoqIEEgWUFNTCBzY2FsYXIsIHF1b3RlZCBvbmx5IHdoZW4gaXQgbXVzdCBiZS4gKi9cbmZ1bmN0aW9uIHNjYWxhcih2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW1xcdyAuLCcnL0ArLV0qJC8udGVzdCh2YWx1ZSkgJiYgIS9eXFxzfFxccyQvLnRlc3QodmFsdWUpICYmIHZhbHVlICE9PSBcIlwiXG4gICAgPyB2YWx1ZVxuICAgIDogSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xufVxuXG5leHBvcnQgdHlwZSBOZXdNZXRhID0ge1xuICB0eXBlPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgdGFncz86IHN0cmluZ1tdO1xuICAvKiogYGdlbmVyYXRlZC5ieWAg4oCUIHRoZSBhY3RvciwgcmVjb3JkZWQgaG9uZXN0bHkgb3IgbGVmdCBgdW5rbm93bmAuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBhdD86IHN0cmluZztcbn07XG5cbi8qKlxuICogQSBmcm9udG1hdHRlciBibG9jayBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBub25lLiBPS0YncyByZWNvbW1lbmRlZCBzZXQgaW5cbiAqIHRoZSBvcmRlciB0aGUgY29ycG9yYSB3cml0ZSBpdCwgd2l0aCBgZGVzY3JpcHRpb25gIGxlZnQgRU1QVFkgZm9yIHRoZSBhdXRob3I6XG4gKiBhIG9uZS1saW5lIHN1bW1hcnkgbm9ib2R5IHdyb3RlIGlzIHdvcnNlIHRoYW4gYSBibGFuayB0aGF0IGFza3MgdG8gYmUgZmlsbGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCbG9jayhtZXRhOiBOZXdNZXRhKTogc3RyaW5nIHtcbiAgY29uc3QgYXQgPSBtZXRhLmF0ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGB0eXBlOiAke3NjYWxhcihtZXRhLnR5cGUgPz8gXCJcIil9YCxcbiAgICBgdGl0bGU6ICR7c2NhbGFyKG1ldGEudGl0bGUgPz8gXCJcIil9YCxcbiAgICBgZGVzY3JpcHRpb246ICR7bWV0YS5kZXNjcmlwdGlvbiA/IHNjYWxhcihtZXRhLmRlc2NyaXB0aW9uKSA6IFwiXCJ9YCxcbiAgICBgdGFnczogWyR7KG1ldGEudGFncyA/PyBbXSkubWFwKHNjYWxhcikuam9pbihcIiwgXCIpfV1gLFxuICAgIGBzdGF0dXM6ICR7c2NhbGFyKG1ldGEuc3RhdHVzID8/IFwiZHJhZnRcIil9YCxcbiAgICBgZ2VuZXJhdGVkOiB7IGJ5OiAke3NjYWxhcihtZXRhLmJ5ID8/IFwidW5rbm93blwiKX0sIGF0OiAke2F0fSB9YCxcbiAgXTtcbiAgcmV0dXJuIGAtLS1cXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9XFxuLS0tXFxuYDtcbn1cblxuLyoqXG4gKiBQdXQgYSBuZXcgYmxvY2sgYXQgdGhlIHRvcCBvZiBhIGRvY3VtZW50IHRoYXQgaGFzIG5vbmUuIE5vIGJsYW5rIGxpbmUgaXNcbiAqIGluc2VydGVkOiB0aGUgY29ycG9yYSB3cml0ZSB0aGUgYm9keSBkaXJlY3RseSB1bmRlciB0aGUgY2xvc2luZyBgLS0tYCwgYW5kIGFcbiAqIGJsb2NrIHRoYXQgYWRkcyBvbmUgd291bGQgc2hvdyBhcyBhIGRpZmYgb24gZXZlcnkgZG9jdW1lbnQgaXQgdG91Y2hlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhCbG9jayh0ZXh0OiBzdHJpbmcsIGJsb2NrOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7YmxvY2t9JHt0ZXh0fWA7XG59XG5cbi8qKlxuICogU2V0IG9uZSBrZXkgaW4gYW4gRVhJU1RJTkcgYmxvY2ssIGFzIGEgbGluZSBlZGl0OiB0aGUga2V5J3MgbGluZSBpcyByZXBsYWNlZFxuICogd2hlcmUgaXQgZXhpc3RzIGFuZCBhcHBlbmRlZCBiZWZvcmUgdGhlIGNsb3NpbmcgYC0tLWAgd2hlcmUgaXQgZG9lcyBub3QuXG4gKiBFdmVyeXRoaW5nIGVsc2Ug4oCUIG9yZGVyLCBjb21tZW50cywgc3BhY2luZywga2V5cyB0aGlzIHNwZWxsIG5ldmVyIGhlYXJkIG9mIOKAlFxuICogc3Vydml2ZXMgYnl0ZSBmb3IgYnl0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEtleSh0ZXh0OiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgeyByYXcgfSA9IHNwbGl0RnJvbnRtYXR0ZXIodGV4dCk7XG4gIGlmIChyYXcgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihcInRoaXMgZG9jdW1lbnQgaGFzIG5vIGZyb250bWF0dGVyIGJsb2NrXCIpO1xuICBjb25zdCBsaW5lID0gYCR7a2V5fTogJHtzY2FsYXIodmFsdWUpfWA7XG4gIGNvbnN0IGtleUxpbmUgPSBuZXcgUmVnRXhwKGBeJHtrZXkucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpfVxcXFxzKjpgKTtcbiAgY29uc3QgbGluZXMgPSByYXcuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGF0ID0gbGluZXMuZmluZEluZGV4KChsKSA9PiBrZXlMaW5lLnRlc3QobCkpO1xuICBpZiAoYXQgPT09IC0xKSBsaW5lcy5wdXNoKGxpbmUpO1xuICBlbHNlIHtcbiAgICAvLyBBIG11bHRpLWxpbmUgdmFsdWUgKGEgZm9sZGVkIGRlc2NyaXB0aW9uLCBhIG5lc3RlZCBtYXBwaW5nKSBpcyB0aGVcbiAgICAvLyBrZXkncyBsaW5lIFBMVVMgZXZlcnkgaW5kZW50ZWQgbGluZSB1bmRlciBpdDsgYWxsIG9mIHRoZW0gZ28uXG4gICAgbGV0IGVuZCA9IGF0ICsgMTtcbiAgICB3aGlsZSAoZW5kIDwgbGluZXMubGVuZ3RoICYmIC9eXFxzK1xcUy8udGVzdChsaW5lc1tlbmRdID8/IFwiXCIpKSBlbmQrKztcbiAgICBsaW5lcy5zcGxpY2UoYXQsIGVuZCAtIGF0LCBsaW5lKTtcbiAgfVxuICBjb25zdCByZWJ1aWx0ID0gbGluZXMuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShyYXcsIHJlYnVpbHQpO1xufVxuIiwKICAgICIvKipcbiAqIExpbmtzIGJldHdlZW4gZG9jdW1lbnRzIChFMzMpOiB3aGF0IGEgZG9jdW1lbnQgcG9pbnRzIGF0LCBhbmQgd2hhdCB0aGF0XG4gKiByZXNvbHZlcyB0byBpbnNpZGUgYSBzZXQuXG4gKlxuICog4pSA4pSAIEZPVVIgU09VUkNFUyBPRiBFREdFUywgQU5EIFRIRVkgQVJFIE5PVCBPTkUgS0lORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAgIDEuIG1hcmtkb3duIGxpbmtzICAgICAgYFtsYWJlbF0oLi9vdGhlci5tZClgICAgICAg4oCUIGJvZHlcbiAqICAgMi4gd2lraSBsaW5rcyAgICAgICAgICBgW1tvdGhlci1kb2N8bGFiZWxdXWAgICAgICDigJQgYm9keVxuICogICAzLiBmcm9udG1hdHRlciB2YWx1ZXMgIGByZWxhdGVkOiBbY29uY2VwdC94XWAgICAgIOKAlCBhdXRob3JlZCBpbnRlbnRcbiAqICAgNC4gYHNvdXJjZXNbXS5yZXNvdXJjZWAgICAgICAgICAgICAgICAgICAgICAgICAgICDigJQgYXV0aG9yZWQgaW50ZW50XG4gKlxuICogcGRvY3Mga2VlcHMgdGhlIGZyb250bWF0dGVyIGVkZ2UgYW5kIHRoZSBib2R5LWxpbmsgZWRnZSBBUEFSVCAoYHJlbGF0ZWRbXWBcbiAqIGFuZCBgbGlua3NbXWAgaW4gaXRzIGBiYWNrbGlua3NgIG91dHB1dCksIGFuZCB0aGUgZGlzdGluY3Rpb24gaXMgcmVhbDogYVxuICogYHJlbGF0ZWRgIGtleSBpcyBhIGNsYWltIHRoZSBhdXRob3IgbWFkZSBhYm91dCB0aGUgZG9jdW1lbnQgYXMgYSB3aG9sZSwgYVxuICogYm9keSBsaW5rIGlzIGEgY2l0YXRpb24gYXQgYSBwbGFjZSBpbiB0aGUgcHJvc2UuIFRoZXkgc3RheSBhcGFydCBoZXJlIHRvby5cbiAqXG4gKiDilIDilIAgVFlQRUQgTElOS1MgKE9wZXJhdG9yJ3Mgc2hhcGUsIENvbGUgMjAyNi0wOS0xMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQSByZWxhdGlvbiByaWRlcyB0aGUgbGluayBhcyBhIHF1ZXJ5OiBgW2xhYmVsXSguL290aGVyLm1kP3JlbD1leHRlbmRzKWAsXG4gKiBgW1tvdGhlcj9yZWw9c3VwZXJzZWRlc3xsYWJlbF1dYC4gQ29waWVkIGV4YWN0bHkgZnJvbSBPcGVyYXRvcidzIHBhcnNlclxuICogKGBwYWNrYWdlcy9zaGFyZWQvc3JjL2xpbmtzL2ApOiBvbmUgbGluayBjYXJyaWVzIEFMTCBvZiBpdHMgcmVscywgdGhleSBhcmVcbiAqIG5vcm1hbGlzZWQgKGxvd2VyY2FzZWQsIHRyaW1tZWQsIGRlZHVwZWQsIGZpcnN0LWF1dGhvcmVkIG9yZGVyIGtlcHQpIGJ1dFxuICogdGhlaXIgU1BFTExJTkcgaXMgbm90IGNhbm9uaWNhbGlzZWQsIGFuZCAqKmEgYmFyZSBsaW5rIGlzIGBbXWAg4oCUIHRoZSBBQlNFTkNFXG4gKiBvZiBhbiBhc3NlcnRpb24sIG5vdCBhbiBpbXBsaWNpdCBgcmVmZXJlbmNlc2AqKi4gQSBncmFwaCBtdXN0IG5vdCBkcmF3IGFcbiAqIGNsYWltIG5vYm9keSBtYWRlLlxuICpcbiAqIOKUgOKUgCBXSEFUIEEgQlVORExFIElTIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIE9LRidzIGJ1bmRsZS1yZWxhdGl2ZSBmb3JtIChgL2NvbmNlcHRzL3gubWRgKSBtZWFucyB0aGUgQlVORExFIHJvb3QsIG5vdCB0aGVcbiAqIGZpbGVzeXN0ZW0gcm9vdCwgc28gYSByZXNvbHZlciBuZWVkcyBhIGJ1bmRsZSBiZWZvcmUgaXQgY2FuIHJlc29sdmUgYW55dGhpbmc6XG4gKiAqKmEgc2V0J3MgZW50cnkgcm9vdCBpcyB0aGUgYnVuZGxlKiogKEUzMykuIEEgdGFyZ2V0IHRoYXQgZXNjYXBlcyBpdCBpcyBub3QgYW5cbiAqIGVycm9yIOKAlCB0aGUgc3BlYyByZXF1aXJlcyB0b2xlcmF0aW5nIGJyb2tlbiBsaW5rcyDigJQgaXQgaXMgYW4gZWRnZSBtYXJrZWRcbiAqIGBvdXRzaWRlYCBvciBgbWlzc2luZ2AsIHdoaWNoIHRoZSBzdXJmYWNlIG9mZmVycyB0byBhZGQgcmF0aGVyIHRoYW4gZm9sbG93LlxuICovXG5pbXBvcnQge1xuICBiYXNlbmFtZSxcbiAgZGlybmFtZSxcbiAgZXh0bmFtZSxcbiAgam9pbixcbiAgbm9ybWFsaXplLFxuICByZWxhdGl2ZSxcbiAgcmVzb2x2ZSBhcyByZXNvbHZlUGF0aCxcbn0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBEb2NNZXRhIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHRvUG9zaXggfSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCB0eXBlIExpbmtLaW5kID0gXCJtYXJrZG93blwiIHwgXCJ3aWtpXCI7XG5cbi8qKiBPbmUgbGluayBhcyB3cml0dGVuLCBiZWZvcmUgYW55dGhpbmcgaXMgcmVzb2x2ZWQuICovXG5leHBvcnQgdHlwZSBMaW5rUmVmID0ge1xuICBraW5kOiBMaW5rS2luZDtcbiAgLyoqIFRoZSB0YXJnZXQgYXMgYXV0aG9yZWQsIHdpdGggaXRzIHF1ZXJ5IGFuZCBhbmNob3Igc3RyaXBwZWQuICovXG4gIHRhcmdldDogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIHRhcmdldCBFWEFDVExZIGFzIHdyaXR0ZW4g4oCUIHF1ZXJ5LCBhbmNob3IsIHBlcmNlbnQtZW5jb2RpbmcgYW5kIGFsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgV0hBVCBNQUtFUyBBIERBTkdMSU5HIExJTksgRklYQUJMRS4gYHRhcmdldGAgaXMgdGhlIHJlc29sdmVkXG4gICAqIHNoYXBlLCBzbyBhIHJlcG9ydCBidWlsdCBmcm9tIGl0IHRlbGxzIHlvdSB0byBsb29rIGZvciBgZGVlcC5tZGAgd2hlbiB0aGVcbiAgICogZG9jdW1lbnQgYWN0dWFsbHkgc2F5cyBgLi9taXNzaW5nL2RlZXAubWQ/cmVsPXhgIOKAlCBhIHN0cmluZyB0aGF0IGlzIG5vdCBpblxuICAgKiB0aGUgZmlsZS4gV2hvZXZlciAob3Igd2hhdGV2ZXIpIGdvZXMgdG8gcmVwYWlyIHRoZSBsaW5rIG5lZWRzIHRoZSBzdHJpbmdcbiAgICogdGhhdCBpcyB0aGVyZS5cbiAgICovXG4gIHJhdzogc3RyaW5nO1xuICAvKiogMS1iYXNlZCBsaW5lIGluIHRoZSBib2R5IHRoZSBsaW5rIHdhcyB3cml0dGVuIG9uLCBmb3IgdGhlIHNhbWUgcmVhc29uLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBSZWxhdGlvbnMgZnJvbSBgP3JlbD1gOyBFTVBUWSBtZWFucyBubyBhc3NlcnRpb24sIG5ldmVyIGByZWZlcmVuY2VzYC4gKi9cbiAgcmVsOiBzdHJpbmdbXTtcbiAgbGFiZWw/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZlcmVuY2UgZm91bmQgaW4gZnJvbnRtYXR0ZXIsIHdpdGggdGhlIGtleSB0aGF0IGNhcnJpZWQgaXQuICovXG5leHBvcnQgdHlwZSBGaWVsZFJlZiA9IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfTtcblxuY29uc3QgRkVOQ0VfTElORSA9IC9eKD86YGBgfH5+fikvO1xuXG4vKipcbiAqIFN0cmlwIGZlbmNlZCBjb2RlIGJsb2Nrcy4gQSBkb2N1bWVudCBhYm91dCBsaW5rcyBxdW90ZXMgbGluayBzeW50YXgsIGFuZCB0aGVcbiAqIHdpa2kgdGhpcyB3YXMgYnVpbHQgYWdhaW5zdCBkb2VzIGV4YWN0bHkgdGhhdCDigJQgd2l0aG91dCB0aGlzLCBTQ0hFTUEubWQnc1xuICogZXhhbXBsZXMgYmVjb21lIGVkZ2VzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aG91dEZlbmNlcyhib2R5OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBmZW5jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbSA9IEZFTkNFX0xJTkUuZXhlYyhsaW5lKTtcbiAgICBpZiAoZmVuY2UgPT09IG51bGwgJiYgbSkge1xuICAgICAgZmVuY2UgPSBtWzBdO1xuICAgICAgb3V0LnB1c2goXCJcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZlbmNlICE9PSBudWxsKSB7XG4gICAgICBpZiAobSAmJiBsaW5lLnN0YXJ0c1dpdGgoZmVuY2UpKSBmZW5jZSA9IG51bGw7XG4gICAgICBvdXQucHVzaChcIlwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBvdXQucHVzaChsaW5lKTtcbiAgfVxuICByZXR1cm4gb3V0LmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBgP3JlbD1hLGJgIOKGkiBgW1wiYVwiLFwiYlwiXWAsIG5vcm1hbGlzZWQgdGhlIHdheSBPcGVyYXRvciBub3JtYWxpc2VzIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWwocXVlcnk6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcbiAgaWYgKCFxdWVyeSkgcmV0dXJuIFtdO1xuICBjb25zdCBtID0gLyg/Ol58Wz8mXSlyZWw9KFteJl0qKS8uZXhlYyhxdWVyeSk7XG4gIGlmICghbSkgcmV0dXJuIFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgZGVjb2RlVVJJQ29tcG9uZW50KG1bMV0gPz8gXCJcIikuc3BsaXQoXCIsXCIpKSB7XG4gICAgY29uc3QgcmVsID0gcmF3LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChyZWwgPT09IFwiXCIgfHwgc2Vlbi5oYXMocmVsKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQocmVsKTtcbiAgICBvdXQucHVzaChyZWwpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBTcGxpdCBhIHdyaXR0ZW4gdGFyZ2V0IGludG8gaXRzIHBhdGgsIGl0cyBxdWVyeSBhbmQgaXRzIGFuY2hvci4gKi9cbi8qKlxuICogUGVyY2VudC1kZWNvZGluZywgd2hpY2ggYSBtYXJrZG93biBsaW5rIHRhcmdldCBjYXJyaWVzIHdoZW5ldmVyIHRoZSBmaWxlIGl0XG4gKiBuYW1lcyBoYXMgYSBzcGFjZSBpbiBpdCDigJQgYE1hcmVuJ3MlMjBCYWtlcnkubWRgIChFNDkpLlxuICpcbiAqIOKblCBJVCBNVVNUIE5PVCBUSFJPVy4gYGRlY29kZVVSSUNvbXBvbmVudGAgcmVqZWN0cyBhIGxvbmUgYCVgLCBhbmQgYSBmaWxlXG4gKiBjYWxsZWQgYDEwMCUgZG9uZS5tZGAgaXMgYSBwZXJmZWN0bHkgb3JkaW5hcnkgdGhpbmcgdG8gbGluayB0by4gQW5cbiAqIHVuZGVjb2RhYmxlIHRhcmdldCBpcyByZXR1cm5lZCBhcyBpdCBzdGFuZHM6IHdvcnN0IGNhc2UgaXQgZmFpbHMgdG8gcmVzb2x2ZSxcbiAqIHdoaWNoIGlzIHRoZSBiZWhhdmlvdXIgYmVmb3JlIGRlY29kaW5nIGV4aXN0ZWQsIHJhdGhlciB0aGFuIHRha2luZyB0aGUgZ3JhcGhcbiAqIGRvd24gd2l0aCBpdC5cbiAqL1xuZnVuY3Rpb24gZGVjb2RlUGF0aChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghcmF3LmluY2x1ZGVzKFwiJVwiKSkgcmV0dXJuIHJhdztcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiByYXc7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0VGFyZ2V0KHJhdzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IHF1ZXJ5Pzogc3RyaW5nOyBhbmNob3I/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGhhc2ggPSByYXcuaW5kZXhPZihcIiNcIik7XG4gIGNvbnN0IHdpdGhvdXRBbmNob3IgPSBoYXNoID09PSAtMSA/IHJhdyA6IHJhdy5zbGljZSgwLCBoYXNoKTtcbiAgY29uc3QgYW5jaG9yID0gaGFzaCA9PT0gLTEgPyB1bmRlZmluZWQgOiByYXcuc2xpY2UoaGFzaCArIDEpO1xuICBjb25zdCBxID0gd2l0aG91dEFuY2hvci5pbmRleE9mKFwiP1wiKTtcbiAgcmV0dXJuIHtcbiAgICBwYXRoOiBkZWNvZGVQYXRoKChxID09PSAtMSA/IHdpdGhvdXRBbmNob3IgOiB3aXRob3V0QW5jaG9yLnNsaWNlKDAsIHEpKS50cmltKCkpLFxuICAgIC4uLihxID09PSAtMSA/IHt9IDogeyBxdWVyeTogd2l0aG91dEFuY2hvci5zbGljZShxICsgMSkgfSksXG4gICAgLi4uKGFuY2hvciA/IHsgYW5jaG9yIH0gOiB7fSksXG4gIH07XG59XG5cbmNvbnN0IEVYVEVSTkFMID0gL15bYS16XVthLXowLTkrLi1dKjovaTtcbmNvbnN0IE1EX0xJTksgPSAvKCE/KVxcWyhbXlxcXVxcbl0qKVxcXVxcKChbXilcXHNdKykoPzpcXHMrXCJbXlwiXSpcIik/XFwpL2c7XG5jb25zdCBXSUtJX0xJTksgPSAvXFxbXFxbKFteXFxdXFxuXSspXFxdXFxdL2c7XG5cbi8qKiBFdmVyeSBsaW5rIGEgZG9jdW1lbnQncyBCT0RZIHBvaW50cyBhdCDigJQgZXh0ZXJuYWwgdGFyZ2V0cyBhbmQgaW1hZ2VzIGxlZnQgb3V0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RMaW5rcyhib2R5OiBzdHJpbmcpOiBMaW5rUmVmW10ge1xuICBjb25zdCB0ZXh0ID0gd2l0aG91dEZlbmNlcyhib2R5KTtcbiAgY29uc3Qgb3V0OiBMaW5rUmVmW10gPSBbXTtcbiAgLy8g4pqgIExJTkUgTlVNQkVSUyBTVVJWSVZFIGB3aXRob3V0RmVuY2VzYCBBTkQgT0ZGU0VUUyBETyBOT1Q6IGl0IGJsYW5rcyBlYWNoXG4gIC8vIGZlbmNlZCBsaW5lIHJhdGhlciB0aGFuIGRlbGV0aW5nIGl0LCBzbyB0aGUgbGluZSBDT1VOVCBpcyBwcmVzZXJ2ZWQgd2hpbGVcbiAgLy8gdGhlIGNoYXJhY3RlciBvZmZzZXRzIGFyZSBub3QuIENvdW50aW5nIG5ld2xpbmVzIGlzIHRoZXJlZm9yZSBzb3VuZDsgdXNpbmdcbiAgLy8gYG0uaW5kZXhgIGFzIGEgY2hhcmFjdGVyIHBvc2l0aW9uIGluIHRoZSBvcmlnaW5hbCBib2R5IHdvdWxkIG5vdCBiZS5cbiAgY29uc3QgbGluZUF0ID0gKGF0OiBudW1iZXIpID0+IHtcbiAgICBsZXQgbGluZSA9IDE7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhdCAmJiBpIDwgdGV4dC5sZW5ndGg7IGkrKykgaWYgKHRleHQuY2hhckNvZGVBdChpKSA9PT0gMTApIGxpbmUrKztcbiAgICByZXR1cm4gbGluZTtcbiAgfTtcbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoTURfTElOSykpIHtcbiAgICBpZiAobVsxXSA9PT0gXCIhXCIpIGNvbnRpbnVlOyAvLyBhbiBpbWFnZSBpcyBub3QgYSBkb2N1bWVudCBsaW5rXG4gICAgY29uc3QgcmF3ID0gbVszXSA/PyBcIlwiO1xuICAgIGlmIChFWFRFUk5BTC50ZXN0KHJhdykgfHwgcmF3LnN0YXJ0c1dpdGgoXCIjXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCB7IHBhdGgsIHF1ZXJ5IH0gPSBzcGxpdFRhcmdldChyYXcpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIm1hcmtkb3duXCIsXG4gICAgICB0YXJnZXQ6IHBhdGgsXG4gICAgICByYXcsXG4gICAgICBsaW5lOiBsaW5lQXQobS5pbmRleCA/PyAwKSxcbiAgICAgIHJlbDogcGFyc2VSZWwocXVlcnkpLFxuICAgICAgLi4uKG1bMl0gPyB7IGxhYmVsOiBtWzJdIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoV0lLSV9MSU5LKSkge1xuICAgIGNvbnN0IGlubmVyID0gbVsxXSA/PyBcIlwiO1xuICAgIGNvbnN0IHBpcGUgPSBpbm5lci5pbmRleE9mKFwifFwiKTtcbiAgICBjb25zdCB0YXJnZXRQYXJ0ID0gcGlwZSA9PT0gLTEgPyBpbm5lciA6IGlubmVyLnNsaWNlKDAsIHBpcGUpO1xuICAgIGNvbnN0IGxhYmVsID0gcGlwZSA9PT0gLTEgPyB1bmRlZmluZWQgOiBpbm5lci5zbGljZShwaXBlICsgMSkudHJpbSgpO1xuICAgIGNvbnN0IHsgcGF0aCwgcXVlcnkgfSA9IHNwbGl0VGFyZ2V0KHRhcmdldFBhcnQpO1xuICAgIGlmIChwYXRoID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBvdXQucHVzaCh7XG4gICAgICBraW5kOiBcIndpa2lcIixcbiAgICAgIHRhcmdldDogcGF0aCxcbiAgICAgIHJhdzogdGFyZ2V0UGFydCxcbiAgICAgIGxpbmU6IGxpbmVBdChtLmluZGV4ID8/IDApLFxuICAgICAgcmVsOiBwYXJzZVJlbChxdWVyeSksXG4gICAgICAuLi4obGFiZWwgPyB7IGxhYmVsIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIERvZXMgdGhpcyBmcm9udG1hdHRlciB2YWx1ZSBMT09LIGxpa2UgYSBkb2N1bWVudCByZWZlcmVuY2U/ICovXG5leHBvcnQgZnVuY3Rpb24gbG9va3NMaWtlUmVmKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB2ID0gdmFsdWUudHJpbSgpO1xuICBpZiAodiA9PT0gXCJcIiB8fCBFWFRFUk5BTC50ZXN0KHYpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB2LmluY2x1ZGVzKFwiL1wiKSB8fCB2LnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIubWRcIik7XG59XG5cbi8qKlxuICogUmVmZXJlbmNlcyBpbnNpZGUgZnJvbnRtYXR0ZXIsIHdoYXRldmVyIGtleSBjYXJyaWVzIHRoZW0g4oCUIGByZWxhdGVkYCxcbiAqIGBzdXBlcnNlZGVzYCwgYHNvdXJjZXNbXS5yZXNvdXJjZWAsIG9yIGEga2V5IGludmVudGVkIHRvbW9ycm93LiBUaGUgU0hBUEVcbiAqIGRlY2lkZXMgKGEgc2xhc2ggb3IgYSBgLm1kYCksIHdoaWNoIGlzIHdoeSBiYXJlIGB0YWdzYCBhcmUgbm90IHJlZmVyZW5jZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWVsZFJlZnMoZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgbWF4RGVwdGggPSA0KTogRmllbGRSZWZbXSB7XG4gIGNvbnN0IG91dDogRmllbGRSZWZbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgIGlmIChkZXB0aCA+IG1heERlcHRoKSByZXR1cm47XG4gICAgaWYgKGxvb2tzTGlrZVJlZih2YWx1ZSkpIG91dC5wdXNoKHsga2V5LCB2YWx1ZTogdmFsdWUudHJpbSgpIH0pO1xuICAgIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSBmb3IgKGNvbnN0IHYgb2YgdmFsdWUpIHdhbGsoa2V5LCB2LCBkZXB0aCArIDEpO1xuICAgIGVsc2UgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIilcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSlcbiAgICAgICAgd2FsayhgJHtrZXl9LiR7a31gLCB2LCBkZXB0aCArIDEpO1xuICB9O1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhmaWVsZHMpKSB3YWxrKGssIHYsIDApO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hlcmUgYSB0YXJnZXQgbGFuZGVkLiBgb3V0c2lkZWAgZXhpc3RzIG9uIGRpc2sgYnV0IG5vdCBpbiB0aGlzIGJ1bmRsZS4gKi9cbmV4cG9ydCB0eXBlIFJlc29sdXRpb24gPVxuICB8IHsgc3RhdGU6IFwiaW4tYnVuZGxlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJvdXRzaWRlXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogXCJtaXNzaW5nXCI7IHRyaWVkOiBzdHJpbmcgfTtcblxuZXhwb3J0IHR5cGUgQnVuZGxlSW5kZXggPSB7XG4gIC8qKiBUaGUgc2V0J3Mgcm9vdCDigJQgT0tGJ3MgYnVuZGxlLCBhbmQgd2hhdCBhIGAvYC10YXJnZXQgaXMgcmVsYXRpdmUgdG8uICovXG4gIHJvb3Q6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGhzIG9mIGV2ZXJ5IGRvY3VtZW50IGluIHRoZSBidW5kbGUuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgZG9jdW1lbnQncyBwYXJzZWQgZnJvbnRtYXR0ZXIsIGZvciBgdHlwZS9zbHVnYCByZXNvbHV0aW9uLiAqL1xuICBtZXRhT2Y6IChwYXRoOiBzdHJpbmcpID0+IERvY01ldGEgfCBudWxsO1xuICAvKiogRG9lcyB0aGlzIHBhdGggZXhpc3Qgb24gZGlzaz8gKEluamVjdGVkLCBzbyB0aGUgcmVzb2x2ZXIgc3RheXMgcHVyZS4pICovXG4gIGV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSBnaXQgd29ya2luZyB0cmVlIHRoZSBidW5kbGUgc2l0cyBpbiwgd2hlbiB0aGVyZSBpcyBvbmUuIEEgdGhpcmQgcGxhY2VcbiAgICogYW4gdW5hbmNob3JlZCBwYXRoIGlzIHRyaWVkOiBwZG9jcyB3cml0ZXMgcmVwby1yZWxhdGl2ZSBwYXRoc1xuICAgKiAoYGRvY3MvcGxheWJvb2tzL2Zvby5tZGApIGFuZCB0aGUgd2lraSdzIHJ1bGUgcGFnZXMgY2FycnkgcmVwby1yZWxhdGl2ZVxuICAgKiBgY2hlY2tlcjpgIHZhbHVlcywgYW5kIG5laXRoZXIgcmVzb2x2ZXMgZnJvbSB0aGUgZG9jdW1lbnQgb3IgdGhlIGJ1bmRsZS5cbiAgICovXG4gIHJlcG9Sb290Pzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmNvbnN0IHN0ZW0gPSAocDogc3RyaW5nKSA9PiBiYXNlbmFtZShwLCBleHRuYW1lKHApKTtcblxuLyoqXG4gKiBSZXNvbHZlIG9uZSB3cml0dGVuIHRhcmdldCBhZ2FpbnN0IHRoZSBidW5kbGUuXG4gKlxuICogRm91ciBmb3JtcywgaW4gb3JkZXI6IGEgYnVuZGxlLXJlbGF0aXZlIHBhdGggKGAveC95Lm1kYCksIGEgcmVsYXRpdmUgcGF0aFxuICogKGAuL3kubWRgLCBgLi4veC95Lm1kYCksIGEgYHR5cGUvc2x1Z2Aga2V5IOKAlCBwZG9jcycgYW5kIHRoZSB3aWtpJ3Mgb3duIGZvcm0sXG4gKiB3aGljaCByZXNvbHZlcyBieSBUWVBFIGFuZCBCQVNFTkFNRSBzbyBhIHBhZ2UgY2FuIG1vdmUgZm9sZGVycyB3aXRob3V0XG4gKiBicmVha2luZyBpbmJvdW5kIHJlZmVyZW5jZXMg4oCUIGFuZCBhIGJhcmUgbmFtZSAoYSB3aWtpIGxpbmspLCBieSBiYXNlbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVUYXJnZXQocmF3VGFyZ2V0OiBzdHJpbmcsIGZyb206IHN0cmluZywgaW5kZXg6IEJ1bmRsZUluZGV4KTogUmVzb2x1dGlvbiB7XG4gIC8vIOKblCBTUExJVCBGSVJTVCwgQkVDQVVTRSBUSEUgQ0FMTEVSUyBESVNBR1JFRSBBQk9VVCBXSEFUIFRIRVkgSEFORCBPVkVSLlxuICAvLyBgZXh0cmFjdExpbmtzYCBzcGxpdHMgYSB0YXJnZXQgYmVmb3JlIGl0IGV2ZXIgZ2V0cyBoZXJlIChFNDkpLCBidXQgdGhlXG4gIC8vIENMSUNLIHBhdGggZG9lcyBub3Q6IGBsaW5rLm9wZW5gIGNhcnJpZXMgdGhlIGhyZWYgZXhhY3RseSBhcyB0aGUgZG9jdW1lbnRcbiAgLy8gd3JvdGUgaXQuIFNvIGFuIE9wZXJhdG9yIHR5cGVkIGxpbmsg4oCUIGBNYXJlbidzJTIwQmFrZXJ5Lm1kP3JlbD1sb2NhdGVkLWluYFxuICAvLyDigJQgYXJyaXZlZCB3aXRoIGl0cyBxdWVyeSBhbmQgaXRzIGVuY29kaW5nIGludGFjdCwgYGV4dG5hbWVgIHJlYWRcbiAgLy8gYC5tZD9yZWw9bG9jYXRlZC1pbmAsIGFuZCB0aGUgbG9va3VwIHdlbnQgaHVudGluZyBmb3IgYSBmaWxlIG5hbWVkIGFmdGVyXG4gIC8vIHRoZSB3aG9sZSBzdHJpbmcuIFRoZSBHUkFQSCBkcmV3IHRoYXQgZWRnZSBjb3JyZWN0bHkgdGhlIGVudGlyZSB0aW1lLCB3aGljaFxuICAvLyBpcyB3aGF0IG1hZGUgaXQgcHV6emxpbmc6IHRoZSBzYW1lIGxpbmsgd2FzIGZpbmUgaW4gdGhlIG1hcCBhbmQgZGVhZCB1bmRlclxuICAvLyB0aGUgcG9pbnRlci4gU3BsaXR0aW5nIGhlcmUgZml4ZXMgZXZlcnkgY2FsbGVyIGF0IG9uY2UgYW5kIGlzIGlkZW1wb3RlbnRcbiAgLy8gZm9yIHRoZSB0d28gdGhhdCBoYWQgYWxyZWFkeSBkb25lIGl0LiAoQ29sZSBmb3VuZCBpdCBieSBjbGlja2luZyBvbmUgaW5cbiAgLy8gSG9sbG93YnJvb2ssIDIwMjYtMDktMTQuKVxuICBjb25zdCB0YXJnZXQgPSBzcGxpdFRhcmdldChyYXdUYXJnZXQpLnBhdGg7XG4gIC8vIOKblCBXSEFUIE1BS0VTIEEgVEFSR0VUIEEgUEFUSCBSQVRIRVIgVEhBTiBBIEtFWSwgYW5kIHRoZSBjYXNlIHRoYXQgdGF1Z2h0XG4gIC8vIGl0OiBgW3RoZSBsaW50ZXJdKGxpbnQudHMpYCBpbiB0aGUgcmVhbCB3aWtpIGhhcyBubyBgLi9gIGFuZCBpcyBub3QgYSBgLm1kYCxcbiAgLy8gc28gYSBydWxlIGtleWVkIG9uIHRob3NlIHR3byByZWFkIGl0IGFzIGEgTkFNRSBhbmQgcmVwb3J0ZWQgaXQgbWlzc2luZ1xuICAvLyB3aGlsZSB0aGUgZmlsZSBzYXQgcmlnaHQgdGhlcmUuIEEgdGFyZ2V0IGlzIGEgcGF0aCB3aGVuIGl0IGlzIGFuY2hvcmVkXG4gIC8vIChgL2AsIGAuL2AsIGAuLi9gKSBvciBjYXJyaWVzIEFOWSBleHRlbnNpb247IGBjb25jZXB0L2V4aXQtY29kZXNgIGhhc1xuICAvLyBuZWl0aGVyLCB3aGljaCBpcyB3aGF0IGtlZXBzIGEgYHR5cGUvc2x1Z2Aga2V5IGEga2V5LlxuICBjb25zdCBsb29rc1BhdGggPVxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgIHRhcmdldC5zdGFydHNXaXRoKFwiLi9cIikgfHxcbiAgICB0YXJnZXQuc3RhcnRzV2l0aChcIi4uL1wiKSB8fFxuICAgIGV4dG5hbWUodGFyZ2V0KSAhPT0gXCJcIjtcbiAgaWYgKGxvb2tzUGF0aCkge1xuICAgIC8vIEFuIFVOQU5DSE9SRUQgcGF0aCAoYHNyYy9hY2Mva2l0L3gudHNgLCBgcmVwb3J0cy9hLm1kYCDigJQgbm8gYC4vYCBhbmQgbm9cbiAgICAvLyBsZWFkaW5nIGAvYCkgaXMgYW1iaWd1b3VzOiByZWxhdGl2ZSB0byB0aGUgZG9jdW1lbnQsIG9yIHRvIHRoZSBidW5kbGU/XG4gICAgLy8gQm90aCBhcmUgdHJpZWQsIGRvY3VtZW50IGZpcnN0LiBNZWFzdXJlZCBvbiB0aGUgcmVhbCB3aWtpLCB3aGVyZSBhIHJ1bGVcbiAgICAvLyBwYWdlJ3MgYGNoZWNrZXI6IHNyYy9hY2Mva2l0L2NoZWNrZXJzL+KApmAgd2FzIHJlcG9ydGVkIG1pc3Npbmcgd2hpbGVcbiAgICAvLyByZXNvbHZpbmcgZnJvbSB0aGUgYnVuZGxlIHJvb3Qgd291bGQgaGF2ZSBmb3VuZCBpdC5cbiAgICBjb25zdCBhbmNob3JlZCA9IHRhcmdldC5zdGFydHNXaXRoKFwiL1wiKSB8fCB0YXJnZXQuc3RhcnRzV2l0aChcIi4vXCIpIHx8IHRhcmdldC5zdGFydHNXaXRoKFwiLi4vXCIpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSB0YXJnZXQuc3RhcnRzV2l0aChcIi9cIilcbiAgICAgID8gW25vcm1hbGl6ZShqb2luKGluZGV4LnJvb3QsIHRhcmdldCkpXVxuICAgICAgOiBhbmNob3JlZFxuICAgICAgICA/IFtub3JtYWxpemUocmVzb2x2ZVBhdGgoZGlybmFtZShmcm9tKSwgdGFyZ2V0KSldXG4gICAgICAgIDogW1xuICAgICAgICAgICAgbm9ybWFsaXplKHJlc29sdmVQYXRoKGRpcm5hbWUoZnJvbSksIHRhcmdldCkpLFxuICAgICAgICAgICAgbm9ybWFsaXplKGpvaW4oaW5kZXgucm9vdCwgdGFyZ2V0KSksXG4gICAgICAgICAgICAuLi4oaW5kZXgucmVwb1Jvb3QgPyBbbm9ybWFsaXplKGpvaW4oaW5kZXgucmVwb1Jvb3QsIHRhcmdldCkpXSA6IFtdKSxcbiAgICAgICAgICBdO1xuICAgIGNvbnN0IHRyaWVkID0gY2FuZGlkYXRlcy5tYXAoKGMpID0+IChleHRuYW1lKGMpID09PSBcIlwiID8gYCR7Y30ubWRgIDogYykpO1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LnBhdGhzLmluY2x1ZGVzKGMpKSByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogYyB9O1xuICAgIGZvciAoY29uc3QgYyBvZiB0cmllZCkgaWYgKGluZGV4LmV4aXN0cyhjKSkgcmV0dXJuIHsgc3RhdGU6IFwib3V0c2lkZVwiLCBwYXRoOiBjIH07XG4gICAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdHJpZWRbMF0gYXMgc3RyaW5nIH07XG4gIH1cbiAgY29uc3Qgc2xhc2ggPSB0YXJnZXQuaW5kZXhPZihcIi9cIik7XG4gIGlmIChzbGFzaCA+IDApIHtcbiAgICAvLyBgdHlwZS9zbHVnYDogdGhlIHR5cGUgaXMgYSBjbGFpbSB0aGUgdGFyZ2V0J3Mgb3duIGZyb250bWF0dGVyIG11c3QgbWFrZS5cbiAgICBjb25zdCB0eXBlID0gdGFyZ2V0LnNsaWNlKDAsIHNsYXNoKTtcbiAgICBjb25zdCBzbHVnID0gdGFyZ2V0LnNsaWNlKHNsYXNoICsgMSk7XG4gICAgZm9yIChjb25zdCBwIG9mIGluZGV4LnBhdGhzKVxuICAgICAgaWYgKHN0ZW0ocCkgPT09IHNsdWcgJiYgaW5kZXgubWV0YU9mKHApPy50eXBlID09PSB0eXBlKVxuICAgICAgICByZXR1cm4geyBzdGF0ZTogXCJpbi1idW5kbGVcIiwgcGF0aDogcCB9O1xuICB9XG4gIGNvbnN0IGhpdCA9IGluZGV4LnBhdGhzLmZpbmQoKHApID0+IHN0ZW0ocCkgPT09IHN0ZW0odGFyZ2V0KSk7XG4gIGlmIChoaXQpIHJldHVybiB7IHN0YXRlOiBcImluLWJ1bmRsZVwiLCBwYXRoOiBoaXQgfTtcbiAgcmV0dXJuIHsgc3RhdGU6IFwibWlzc2luZ1wiLCB0cmllZDogdGFyZ2V0IH07XG59XG5cbi8qKiBBbiBlZGdlIGluIGEgc2V0J3MgbWFwLiBgcmVsYCBlbXB0eSBtZWFucyBubyBhc3NlcnRpb24gd2FzIG1hZGUuICovXG5leHBvcnQgdHlwZSBFZGdlID0ge1xuICBmcm9tOiBzdHJpbmc7XG4gIC8qKiBBYnNvbHV0ZSBwYXRoIHdoZW4gcmVzb2x2ZWQ7IHRoZSB3cml0dGVuIHRhcmdldCB3aGVuIG5vdC4gKi9cbiAgdG86IHN0cmluZztcbiAgLyoqIEEgYm9keSBsaW5rLCBvciBhIGZyb250bWF0dGVyIHZhbHVlIOKAlCBrZXB0IGFwYXJ0LCBhcyBwZG9jcyBrZWVwcyB0aGVtLiAqL1xuICBzb3VyY2U6IFwibGlua1wiIHwgXCJmcm9udG1hdHRlclwiO1xuICAvKiogVGhlIGZyb250bWF0dGVyIGtleSB0aGF0IGNhcnJpZWQgaXQgKGByZWxhdGVkYCwgYHNvdXJjZXMucmVzb3VyY2VgLCDigKYpLiAqL1xuICBrZXk/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBGb3IgYSBCT0RZIGxpbms6IHRoZSB0YXJnZXQgYXMgd3JpdHRlbiwgYW5kIHRoZSBsaW5lIGl0IGlzIG9uLiBBYnNlbnQgZm9yIGFcbiAgICogZnJvbnRtYXR0ZXIgcmVmZXJlbmNlLCB3aGVyZSBga2V5YCBpcyB0aGUgYWRkcmVzcyBpbnN0ZWFkLlxuICAgKi9cbiAgcmF3Pzogc3RyaW5nO1xuICBsaW5lPzogbnVtYmVyO1xuICByZWw6IHN0cmluZ1tdO1xuICBzdGF0ZTogUmVzb2x1dGlvbltcInN0YXRlXCJdO1xufTtcblxuZXhwb3J0IHR5cGUgR3JhcGhOb2RlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHJlbDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgc3RhbGU6IGJvb2xlYW47XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBsaW5rc091dDogbnVtYmVyO1xuICBsaW5rc0luOiBudW1iZXI7XG59O1xuXG5leHBvcnQgdHlwZSBHcmFwaCA9IHtcbiAgcm9vdDogc3RyaW5nO1xuICBub2RlczogR3JhcGhOb2RlW107XG4gIGVkZ2VzOiBFZGdlW107XG4gIC8qKiBUYXJnZXRzIG5vdGhpbmcgaW4gdGhlIGJ1bmRsZSBhbnN3ZXJzIOKAlCBzYWlkLCBuZXZlciBhbiBlcnJvciAoT0tGIMKnMTEpLiAqL1xuICBkYW5nbGluZzogbnVtYmVyO1xufTtcblxuLyoqIEJ1aWxkIGEgc2V0J3MgbWFwOiBub2RlcyBhcmUgaXRzIGRvY3VtZW50cywgZWRnZXMgYXJlIHRoZSBmb3VyIHNvdXJjZXMuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHcmFwaChpbmRleDogQnVuZGxlSW5kZXgsIGJvZHlPZjogKHBhdGg6IHN0cmluZykgPT4gc3RyaW5nLCBjYXAgPSA0MDApOiBHcmFwaCB7XG4gIGNvbnN0IHBhdGhzID0gaW5kZXgucGF0aHMuc2xpY2UoMCwgY2FwKTtcbiAgY29uc3QgZWRnZXM6IEVkZ2VbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGZyb20gb2YgcGF0aHMpIHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKGZyb20pO1xuICAgIGZvciAoY29uc3QgbGluayBvZiBleHRyYWN0TGlua3MoYm9keU9mKGZyb20pKSkge1xuICAgICAgY29uc3QgciA9IHJlc29sdmVUYXJnZXQobGluay50YXJnZXQsIGZyb20sIGluZGV4KTtcbiAgICAgIGVkZ2VzLnB1c2goe1xuICAgICAgICBmcm9tLFxuICAgICAgICB0bzogci5zdGF0ZSA9PT0gXCJtaXNzaW5nXCIgPyByLnRyaWVkIDogci5wYXRoLFxuICAgICAgICBzb3VyY2U6IFwibGlua1wiLFxuICAgICAgICByYXc6IGxpbmsucmF3LFxuICAgICAgICBsaW5lOiBsaW5rLmxpbmUsXG4gICAgICAgIHJlbDogbGluay5yZWwsXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcmVmIG9mIG1ldGEgPyBmaWVsZFJlZnMobWV0YS5maWVsZHMpIDogW10pIHtcbiAgICAgIGNvbnN0IHIgPSByZXNvbHZlVGFyZ2V0KHJlZi52YWx1ZSwgZnJvbSwgaW5kZXgpO1xuICAgICAgZWRnZXMucHVzaCh7XG4gICAgICAgIGZyb20sXG4gICAgICAgIHRvOiByLnN0YXRlID09PSBcIm1pc3NpbmdcIiA/IHIudHJpZWQgOiByLnBhdGgsXG4gICAgICAgIHNvdXJjZTogXCJmcm9udG1hdHRlclwiLFxuICAgICAgICBrZXk6IHJlZi5rZXksXG4gICAgICAgIHJlbDogW10sXG4gICAgICAgIHN0YXRlOiByLnN0YXRlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IG91dE9mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgaW50b09mID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBlIG9mIGVkZ2VzKSB7XG4gICAgb3V0T2Yuc2V0KGUuZnJvbSwgKG91dE9mLmdldChlLmZyb20pID8/IDApICsgMSk7XG4gICAgaWYgKGUuc3RhdGUgPT09IFwiaW4tYnVuZGxlXCIpIGludG9PZi5zZXQoZS50bywgKGludG9PZi5nZXQoZS50bykgPz8gMCkgKyAxKTtcbiAgfVxuICBjb25zdCBub2RlczogR3JhcGhOb2RlW10gPSBwYXRocy5tYXAoKHBhdGgpID0+IHtcbiAgICBjb25zdCBtZXRhID0gaW5kZXgubWV0YU9mKHBhdGgpO1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoLFxuICAgICAgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGluZGV4LnJvb3QsIHBhdGgpKSxcbiAgICAgIHRpdGxlOiBtZXRhPy50aXRsZSA/PyBzdGVtKHBhdGgpLFxuICAgICAgLi4uKG1ldGE/LnR5cGUgPyB7IHR5cGU6IG1ldGEudHlwZSB9IDoge30pLFxuICAgICAgc3RhdHVzOiBtZXRhPy5zdGF0dXMgPz8gXCJzdGFibGVcIixcbiAgICAgIHN0YWxlOiBtZXRhPy5zdGFsZSA/PyBmYWxzZSxcbiAgICAgIHRhZ3M6IG1ldGE/LnRhZ3MgPz8gW10sXG4gICAgICBsaW5rc091dDogb3V0T2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgICBsaW5rc0luOiBpbnRvT2YuZ2V0KHBhdGgpID8/IDAsXG4gICAgfTtcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgcm9vdDogaW5kZXgucm9vdCxcbiAgICBub2RlcyxcbiAgICBlZGdlcyxcbiAgICBkYW5nbGluZzogZWRnZXMuZmlsdGVyKChlKSA9PiBlLnN0YXRlID09PSBcIm1pc3NpbmdcIikubGVuZ3RoLFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iLAogICAgIi8vIEZpbmRpbmcgdGhpbmdzIGFjcm9zcyBldmVyeXRoaW5nIGluIHRoZSBjb250ZXh0IChFNTkpLlxuLy9cbi8vIOKblCBUV08gTUFUQ0hFUlMsIE9OIFBVUlBPU0UsIGJlY2F1c2UgdGhleSBhbnN3ZXIgZGlmZmVyZW50IHF1ZXN0aW9ucy4gTm90ZVxuLy8gYXBwcyBzcGxpdCB0aGVzZSBhbmQgaXQgaXMgbm90IGFuIGFjY2lkZW50OiBGVVpaWSBvbiBuYW1lcyBpcyBmb3IganVtcGluZ1xuLy8gKFwibWFiYWtcIiDihpIgTWFyZW4ncyBCYWtlcnkpLCBhbmQgRVhBQ1Qgb24gY29udGVudCBpcyBmb3IgZmluZGluZyAoXCJ3aGVyZSBkaWQgSVxuLy8gc2F5ICdhc2tpbmctbmljZWx5J1wiKS4gRnV6enkgZnVsbC10ZXh0IHdvdWxkIGJlIHRoZSB3b3JzdCBvZiBib3RoIOKAlCBzZWFyY2hpbmdcbi8vIGBicmlkZ2VgIHdvdWxkIHN1cmZhY2UgZG9jdW1lbnRzIHRoYXQgbWVyZWx5IGNvbnRhaW4gc2ltaWxhci1sb29raW5nIGxldHRlcnMsXG4vLyBhbmQgeW91IGNvdWxkIG5vIGxvbmdlciB0cnVzdCBcInRoaXMgcGhyYXNlIGlzIG9uIGxpbmUgMjlcIiwgd2hpY2ggaXMgdGhlIG9ubHlcbi8vIHRoaW5nIGEgY29udGVudCBzZWFyY2ggaXMgZm9yLiAoQ29sZSByYWlzZWQgRnVzZSBmb3IgdGhlIG5hbWUgaGFsZiBhbmQgY2hvc2Vcbi8vIHRoZSBoYW5kLXJvbGxlZCBzY29yZXI6IHRoZXJlIGlzIG5vIHNlY29uZCBlbmdpbmUgdGhpcyBoYXMgdG8gYWdyZWUgd2l0aCwgc29cbi8vIGZ1enp5IHJhbmtpbmcgaXMgYSBzZWxmLWNvbnRhaW5lZCB0YXN0ZSBqdWRnbWVudCB3aXRoIG5vIGRyaWZ0IHJpc2suKVxuLy9cbi8vIOKaoCBBTkQgSVQgU0VBUkNIRVMgV0hBVCBUSEUgSFVNQU4gSVMgTE9PS0lORyBBVCwgd2hpY2ggaXMgbm90IGFsd2F5cyB0aGUgZmlsZS5cbi8vIEEgZG9jdW1lbnQgb3BlbiBpbiB0aGUgc2Vzc2lvbiBpcyBzaG93biBhcyBpdHMgQUNUSVZFIFZFUlNJT04sIHdoaWNoIGxpdmVzXG4vLyB1bmRlciB0aGUgc2Vzc2lvbiBob21lIHJhdGhlciB0aGFuIGF0IHRoZSBvcmlnaW5hbCBwYXRoIOKAlCBzbyBhbiBlZGl0IG1hZGUgdHdvXG4vLyBtaW51dGVzIGFnbyBtdXN0IHN0aWxsIGJlIGZpbmRhYmxlLiBUaGF0IGFzeW1tZXRyeSBpcyBhbHNvIHRoZSByZWFzb24gdGhpc1xuLy8gZXhpc3RzIGZvciB0aGUgQUdFTlQgYXQgYWxsOiBncmVwIG92ZXIgdGhlIHdvcmtzcGFjZSBmaW5kcyB0aGUgU0FWRUQgZmlsZSBhbmRcbi8vIHNpbGVudGx5IG1pc3NlcyB0aGUgdmVyc2lvbiBiZWluZyByZWFkLiBUaGUgY2FsbGVyIHN1cHBsaWVzIHRoZSB0ZXh0IHBlclxuLy8gZG9jdW1lbnQgZm9yIGV4YWN0bHkgdGhpcyByZWFzb24gKHNlZSBgU2Vzc2lvbi5zZWFyY2hBbGxgKS5cblxuLyoqIE9uZSBsaW5lIHRoYXQgbWF0Y2hlZCwgd2l0aCB0aGUgb2Zmc2V0cyBvZiB0aGUgaGl0IGluc2lkZSB0aGUgZG9jdW1lbnQuICovXG5leHBvcnQgdHlwZSBIaXQgPSB7XG4gIC8qKiAxLWJhc2VkLCBzbyBpdCBjYW4gYmUgc2hvd24gYW5kIG9wZW5lZC4gKi9cbiAgbGluZTogbnVtYmVyO1xuICAvKiogVGhlIGxpbmUsIGZvciBjb250ZXh0IGluIHRoZSByZXN1bHQgbGlzdC4gKi9cbiAgdGV4dDogc3RyaW5nO1xuICAvKiogT2Zmc2V0cyBvZiB0aGUgbWF0Y2ggd2l0aGluIHRoZSBkb2N1bWVudCwgZm9yIHJldmVhbC1hbmQtc2VsZWN0LiAqL1xuICBmcm9tOiBudW1iZXI7XG4gIHRvOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIEhvdyBtdWNoIG9mIGEgbGluZSBpcyB3b3J0aCBjYXJyeWluZyBiYWNrLiBBIHJlc3VsdCBsaXN0IGlzIGEgbGlzdCwgYW5kIGFcbiAqIGRvY3VtZW50IHdpdGggYSA0LDAwMC1jaGFyYWN0ZXIgcGFyYWdyYXBoIHNob3VsZCBub3Qgc2VuZCBhbGwgb2YgaXQgcGVyIGhpdC5cbiAqL1xuY29uc3QgTElORV9DQVAgPSAyNDA7XG5cbi8qKiBFdmVyeSBtYXRjaCBvZiBgcXVlcnlgIGluIGB0ZXh0YCwgYXQgbW9zdCBgbGltaXRgIG9mIHRoZW0uICovXG5leHBvcnQgZnVuY3Rpb24gc2VhcmNoVGV4dCh0ZXh0OiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcsIGxpbWl0ID0gNTApOiBIaXRbXSB7XG4gIGNvbnN0IG5lZWRsZSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAobmVlZGxlID09PSBcIlwiIHx8IGxpbWl0IDw9IDApIHJldHVybiBbXTtcbiAgY29uc3QgaGF5ID0gdGV4dC50b0xvd2VyQ2FzZSgpO1xuICBsZXQgYXQgPSBoYXkuaW5kZXhPZihuZWVkbGUpO1xuICBpZiAoYXQgPT09IC0xKSByZXR1cm4gW107XG4gIC8vIExpbmUgc3RhcnRzLCB3YWxrZWQgT05DRS4gQSBwZXItaGl0IGBsYXN0SW5kZXhPZihcIlxcblwiKWAgaXMgcXVhZHJhdGljIG92ZXIgYVxuICAvLyBkb2N1bWVudCB0aGF0IG1hdGNoZXMgb24gZXZlcnkgbGluZSwgd2hpY2ggaXMgZXhhY3RseSB0aGUgZG9jdW1lbnQgc29tZW9uZVxuICAvLyBzZWFyY2hlcyBmb3IgYSBjb21tb24gd29yZC5cbiAgY29uc3Qgc3RhcnRzOiBudW1iZXJbXSA9IFswXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSBpZiAodGV4dC5jaGFyQ29kZUF0KGkpID09PSAxMCkgc3RhcnRzLnB1c2goaSArIDEpO1xuICBjb25zdCBoaXRzOiBIaXRbXSA9IFtdO1xuICBsZXQgY3Vyc29yID0gMDtcbiAgd2hpbGUgKGF0ICE9PSAtMSAmJiBoaXRzLmxlbmd0aCA8IGxpbWl0KSB7XG4gICAgd2hpbGUgKGN1cnNvciArIDEgPCBzdGFydHMubGVuZ3RoICYmIChzdGFydHNbY3Vyc29yICsgMV0gYXMgbnVtYmVyKSA8PSBhdCkgY3Vyc29yKys7XG4gICAgY29uc3QgbGluZVN0YXJ0ID0gc3RhcnRzW2N1cnNvcl0gYXMgbnVtYmVyO1xuICAgIGNvbnN0IGxpbmVFbmQgPSBjdXJzb3IgKyAxIDwgc3RhcnRzLmxlbmd0aCA/IChzdGFydHNbY3Vyc29yICsgMV0gYXMgbnVtYmVyKSAtIDEgOiB0ZXh0Lmxlbmd0aDtcbiAgICBjb25zdCB3aG9sZSA9IHRleHQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcbiAgICBoaXRzLnB1c2goe1xuICAgICAgbGluZTogY3Vyc29yICsgMSxcbiAgICAgIHRleHQ6IHdob2xlLmxlbmd0aCA+IExJTkVfQ0FQID8gYCR7d2hvbGUuc2xpY2UoMCwgTElORV9DQVAgLSAxKX3igKZgIDogd2hvbGUsXG4gICAgICBmcm9tOiBhdCxcbiAgICAgIHRvOiBhdCArIG5lZWRsZS5sZW5ndGgsXG4gICAgfSk7XG4gICAgLy8g4pqgIEFEVkFOQ0UgUEFTVCBUSEUgTUFUQ0gsIE5PVCBUSEUgTElORTogdHdvIGhpdHMgb24gb25lIGxpbmUgYXJlIHR3b1xuICAgIC8vIGhpdHMsIGFuZCBzdGVwcGluZyBieSBsaW5lIHdvdWxkIHNpbGVudGx5IGRyb3AgdGhlIHNlY29uZC5cbiAgICBhdCA9IGhheS5pbmRleE9mKG5lZWRsZSwgYXQgKyBuZWVkbGUubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gaGl0cztcbn1cblxuLyoqIElzIHRoaXMgY2hhcmFjdGVyIGEgd29yZCBib3VuZGFyeSBmb3Igc2NvcmluZyBwdXJwb3Nlcz8gKi9cbmZ1bmN0aW9uIGlzQm91bmRhcnkoY2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gY2ggPT09IFwiIFwiIHx8IGNoID09PSBcIi1cIiB8fCBjaCA9PT0gXCJfXCIgfHwgY2ggPT09IFwiL1wiIHx8IGNoID09PSBcIi5cIiB8fCBjaCA9PT0gXCInXCI7XG59XG5cbi8qKlxuICogSG93IHdlbGwgYG5hbWVgIG1hdGNoZXMgYHF1ZXJ5YCBhcyBhIGZ1enp5IHN1YnNlcXVlbmNlIOKAlCBoaWdoZXIgaXMgYmV0dGVyLFxuICogYG51bGxgIHdoZW4gdGhlIHF1ZXJ5J3MgY2hhcmFjdGVycyBkbyBub3QgYXBwZWFyIGluIG9yZGVyIGF0IGFsbC5cbiAqXG4gKiBUaGUgd2VpZ2h0cyBlbmNvZGUgd2hhdCBzb21lb25lIHR5cGluZyBpbnRvIGEganVtcCBib3ggbWVhbnM6XG4gKlxuICogLSAqKmNvbnRpZ3VpdHkqKiBkb21pbmF0ZXMsIGJlY2F1c2UgYG1hcmVgIG1lYW5pbmcgYE1hcmVuYCBpcyB0aGUgY29tbW9uIGNhc2VcbiAqICAgYW5kIGBt4oCmYeKApnLigKZlYCBzY2F0dGVyZWQgdGhyb3VnaCBhIHNlbnRlbmNlIGlzIHRoZSByYXJlIG9uZTtcbiAqIC0gKip3b3JkIHN0YXJ0cyoqIHNjb3JlLCBzbyBgbWJgIGZpbmRzIGBNYXJlbidzIEJha2VyeWAgcmF0aGVyIHRoYW4gYE51bWJlcmA7XG4gKiAtICoqZWFybGllciBpcyBiZXR0ZXIqKiwgYW5kIGEgKipzaG9ydGVyIG5hbWUqKiB3aW5zIGEgdGllLCBiZWNhdXNlIHRoZSB0aGluZ1xuICogICB5b3UgbWVhbnQgaXMgdXN1YWxseSB0aGUgdGhpbmcgd2l0aCBsZXNzIGFyb3VuZCBpdC5cbiAqXG4gKiDimqAgVEhFIE5VTUJFUlMgQVJFIFRBU1RFLCBOT1QgVFJVVEguIFRoZXkgYXJlIHBpbm5lZCBieSBjZWxscyB0aGF0IGFzc2VydFxuICogT1JERVJJTkdTIChcInRoaXMgYmVhdHMgdGhhdFwiKSByYXRoZXIgdGhhbiB2YWx1ZXMsIHNvIHRoZXkgY2FuIGJlIHJldHVuZWRcbiAqIHdpdGhvdXQgcmV3cml0aW5nIHRoZSB0ZXN0cyDigJQgd2hpY2ggaXMgdGhlIG9ubHkgd2F5IGEgc2NvcmVyIGxpa2UgdGhpcyBzdGF5c1xuICogY2hhbmdlYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjb3JlTmFtZShuYW1lOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAocSA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhheSA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgbGV0IHNjb3JlID0gMDtcbiAgbGV0IGF0ID0gMDtcbiAgbGV0IHJ1biA9IDA7XG4gIGZvciAoY29uc3QgY2ggb2YgcSkge1xuICAgIGNvbnN0IGZvdW5kID0gaGF5LmluZGV4T2YoY2gsIGF0KTtcbiAgICBpZiAoZm91bmQgPT09IC0xKSByZXR1cm4gbnVsbDtcbiAgICBydW4gPSBmb3VuZCA9PT0gYXQgJiYgYXQgPiAwID8gcnVuICsgMSA6IDA7XG4gICAgc2NvcmUgKz0gMTAgKyBydW4gKiAxMjtcbiAgICBpZiAoZm91bmQgPT09IDAgfHwgaXNCb3VuZGFyeShoYXlbZm91bmQgLSAxXSBhcyBzdHJpbmcpKSBzY29yZSArPSAxNDtcbiAgICAvLyBEaXN0YW5jZSBmcm9tIHdoZXJlIHdlIHdlcmUgbG9va2luZyBjb3N0cywgc28gc2NhdHRlcmVkIG1hdGNoZXMgcmFuayBsb3cuXG4gICAgc2NvcmUgLT0gTWF0aC5taW4oZm91bmQgLSBhdCwgMTIpO1xuICAgIGF0ID0gZm91bmQgKyAxO1xuICB9XG4gIC8vIEEgd2hvbGUtd29yZCBzdWJzdHJpbmcgaXMgdGhlIHN0cm9uZ2VzdCBzaWduYWwgdGhlcmUgaXM7IHNheSBzbyBsb3VkbHkuXG4gIGlmIChoYXkuaW5jbHVkZXMocSkpIHNjb3JlICs9IDQwO1xuICBpZiAoaGF5LnN0YXJ0c1dpdGgocSkpIHNjb3JlICs9IDI1O1xuICAvLyBTaG9ydGVyIG5hbWVzIHdpbiB0aWVzLlxuICBzY29yZSAtPSBNYXRoLm1pbihuYW1lLmxlbmd0aCwgNDApIC8gNDtcbiAgcmV0dXJuIHNjb3JlO1xufVxuXG4vKiogQSBkb2N1bWVudCB0aGUgTkFNRSBtYXRjaGVkLiAqL1xuZXhwb3J0IHR5cGUgTmFtZU1hdGNoID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHNjb3JlOiBudW1iZXI7XG59O1xuXG4vKipcbiAqIOKblCBUSEUgU1dBUCBTRUFNIChDb2xlKTogXCJpZiB3ZSBmaW5kIHRoYXQgYWN0dWFsbHkgd2Ugc2hvdWxkIHVzZSBGdXNlLCBpdCdzXG4gKiBmYWlybHkgZWFzeSB0byByZXBsYWNlLlwiXG4gKlxuICogVGhlIGludGVyZmFjZSBpcyBDT1JQVVMtU0hBUEVEIOKAlCB0YWtlIHRoZSB3aG9sZSBjYW5kaWRhdGUgbGlzdCBhbmQgYSBxdWVyeSxcbiAqIHJldHVybiBhIHJhbmtlZCBzbGljZSDigJQgYW5kIHRoYXQgc2hhcGUgaXMgdGhlIHdob2xlIHBvaW50LiBBIHBlci1pdGVtXG4gKiBgc2NvcmUobmFtZSwgcXVlcnkpYCBob29rIHdvdWxkIGhhdmUgbG9va2VkIGxpa2UgdGhlIHNtYWxsZXIgYWJzdHJhY3Rpb24gYW5kXG4gKiB3b3VsZCBoYXZlIEZPVUdIVCB0aGUgdmVyeSBsaWJyYXJ5IGl0IGV4aXN0cyB0byBhZG1pdDogRnVzZSBpbmRleGVzIGEgbGlzdFxuICogYW5kIHNlYXJjaGVzIGl0LCBpdCBkb2VzIG5vdCBzY29yZSBvbmUgc3RyaW5nIGF0IGEgdGltZS4gV3JpdHRlbiB0aGlzIHdheSxcbiAqIG1vdmluZyB0byBGdXNlIGlzIGEgbmV3IGZ1bmN0aW9uIGFuZCBvbmUgZGVmYXVsdCBjaGFuZ2VkOlxuICpcbiAqICAgICBjb25zdCBmdXNlTmFtZXM6IE5hbWVTZWFyY2ggPSAoY2FuZGlkYXRlcywgcXVlcnksIGxpbWl0KSA9PiB7XG4gKiAgICAgICBjb25zdCBmdXNlID0gbmV3IEZ1c2UoY2FuZGlkYXRlcywgeyBrZXlzOiBbXCJuYW1lXCIsIFwidGl0bGVcIl0sIOKApiB9KTtcbiAqICAgICAgIHJldHVybiBmdXNlLnNlYXJjaChxdWVyeSwgeyBsaW1pdCB9KS5tYXAo4oCmKTtcbiAqICAgICB9O1xuICpcbiAqIE5vdGhpbmcgZWxzZSBpbiB0aGlzIG1vZHVsZSwgdGhlIHNlc3Npb24sIHRoZSB3aXJlIG9yIHRoZSBzdXJmYWNlIG1vdmVzLlxuICovXG5leHBvcnQgdHlwZSBOYW1lU2VhcmNoID0gKFxuICBjYW5kaWRhdGVzOiByZWFkb25seSBDYW5kaWRhdGVbXSxcbiAgcXVlcnk6IHN0cmluZyxcbiAgbGltaXQ6IG51bWJlcixcbikgPT4gTmFtZU1hdGNoW107XG5cbi8qKiBBIGRvY3VtZW50IHRoZSBDT05URU5UIG1hdGNoZWQuICovXG5leHBvcnQgdHlwZSBUZXh0TWF0Y2ggPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2x1Zz86IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB2ZXJzaW9uPzogbnVtYmVyO1xuICBoaXRzOiBIaXRbXTtcbn07XG5cbmV4cG9ydCB0eXBlIFNlYXJjaFJlcG9ydCA9IHtcbiAgcXVlcnk6IHN0cmluZztcbiAgLyoqIE5hbWUvdGl0bGUgbWF0Y2hlcywgYmVzdCBmaXJzdCDigJQgdGhlIGp1bXAgbGlzdC4gKi9cbiAgZG9jdW1lbnRzOiBOYW1lTWF0Y2hbXTtcbiAgLyoqIENvbnRlbnQgbWF0Y2hlcywgaW4gY29udGV4dCBvcmRlciDigJQgdGhlIGZpbmQgbGlzdC4gKi9cbiAgdGV4dDogVGV4dE1hdGNoW107XG4gIC8qKiBUb3RhbCBjb250ZW50IGhpdHMgcmVwb3J0ZWQuICovXG4gIGNvdW50OiBudW1iZXI7XG4gIC8qKiBUcnVlIHdoZW4gYSBjYXAgc3RvcHBlZCB0aGUgc2VhcmNoIGVhcmx5LCBzbyBcIjNcIiBhbmQgXCIzIG9mIG1vcmVcIiBkaWZmZXIuICovXG4gIHRydW5jYXRlZDogYm9vbGVhbjtcbn07XG5cbi8qKiBQZXItZG9jdW1lbnQgY29udGVudCBjYXAsIHNvIG9uZSBlbm9ybW91cyBkb2N1bWVudCBjYW5ub3QgZmlsbCB0aGUgcmVwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IFBFUl9ET0MgPSAyMDtcbi8qKiBXaG9sZS1yZXBvcnQgY29udGVudCBjYXAuICovXG5leHBvcnQgY29uc3QgVE9UQUwgPSAyMDA7XG4vKiogSG93IG1hbnkgbmFtZSBtYXRjaGVzIGFyZSB3b3J0aCBzaG93aW5nLiAqL1xuZXhwb3J0IGNvbnN0IE5BTUVTID0gMTA7XG5cbi8qKlxuICogVGhlIGRlZmF1bHQgYE5hbWVTZWFyY2hgOiBgc2NvcmVOYW1lYCBvdmVyIGV2ZXJ5IGNhbmRpZGF0ZSwgcmFua2VkLlxuICpcbiAqIEEgZG9jdW1lbnQncyBUSVRMRSBpcyBtYXRjaGVkIGFzIHdlbGwgYXMgaXRzIGZpbGVuYW1lIOKAlCBhbiBPS0YgZG9jdW1lbnQnc1xuICogbmFtZSBhbmQgdGl0bGUgb2Z0ZW4gZGlmZmVyIGFuZCB0aGUgaHVtYW4gbWF5IHJlbWVtYmVyIGVpdGhlciDigJQgYW5kIHRoZVxuICogYmV0dGVyIG9mIHRoZSB0d28gc2NvcmVzIGlzIHRoZSBvbmUgdGhhdCBjb3VudHMuXG4gKi9cbmV4cG9ydCBjb25zdCByYW5rTmFtZXM6IE5hbWVTZWFyY2ggPSAoY2FuZGlkYXRlcywgcXVlcnksIGxpbWl0KSA9PiB7XG4gIGNvbnN0IG91dDogTmFtZU1hdGNoW10gPSBbXTtcbiAgZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBjb25zdCBieU5hbWUgPSBzY29yZU5hbWUoYy5uYW1lLCBxdWVyeSk7XG4gICAgY29uc3QgYnlUaXRsZSA9IGMudGl0bGUgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBzY29yZU5hbWUoYy50aXRsZSwgcXVlcnkpO1xuICAgIGlmIChieU5hbWUgPT09IG51bGwgJiYgYnlUaXRsZSA9PT0gbnVsbCkgY29udGludWU7XG4gICAgb3V0LnB1c2goe1xuICAgICAgcGF0aDogYy5wYXRoLFxuICAgICAgLi4uKGMuc2x1ZyAhPT0gdW5kZWZpbmVkID8geyBzbHVnOiBjLnNsdWcgfSA6IHt9KSxcbiAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgIC4uLihjLnRpdGxlICE9PSB1bmRlZmluZWQgPyB7IHRpdGxlOiBjLnRpdGxlIH0gOiB7fSksXG4gICAgICBzY29yZTogTWF0aC5tYXgoYnlOYW1lID8/IC1JbmZpbml0eSwgYnlUaXRsZSA/PyAtSW5maW5pdHkpLFxuICAgIH0pO1xuICB9XG4gIG91dC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSB8fCBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTtcbiAgcmV0dXJuIG91dC5zbGljZSgwLCBsaW1pdCk7XG59O1xuXG5leHBvcnQgdHlwZSBDYW5kaWRhdGUgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBiYXNlbmFtZSwgd2hpY2ggaXMgd2hhdCBhIGh1bWFuIHR5cGVzIGF0LiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIHNsdWc/OiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogbnVtYmVyO1xufTtcblxuLyoqXG4gKiBTZWFyY2ggYSBsaXN0IG9mIGNhbmRpZGF0ZXMgZm9yIGJvdGgga2luZHMgb2YgbWF0Y2guXG4gKlxuICogYHJlYWRgIG1heSB0aHJvdyBvciByZXR1cm4gbnVsbCBmb3IgYSBkb2N1bWVudCB0aGF0IGhhcyBiZWVuIGRlbGV0ZWQgdW5kZXJcbiAqIHRoZSBjb250ZXh0IOKAlCBhIHNlYXJjaCBpcyBub3QgdGhlIG1vbWVudCB0byBmYWlsIG92ZXIgdGhhdCwgc28gaXQgaXMgc2tpcHBlZFxuICogcmF0aGVyIHRoYW4gcmVwb3J0ZWQgYXMgYSBkb2N1bWVudCB3aXRoIG5vIGhpdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWFyY2hEb2N1bWVudHMoXG4gIGNhbmRpZGF0ZXM6IHJlYWRvbmx5IENhbmRpZGF0ZVtdLFxuICBxdWVyeTogc3RyaW5nLFxuICByZWFkOiAoYzogQ2FuZGlkYXRlKSA9PiBzdHJpbmcgfCBudWxsLFxuICBjYXBzOiB7IHBlckRvYz86IG51bWJlcjsgdG90YWw/OiBudW1iZXI7IG5hbWVzPzogbnVtYmVyOyBuYW1lU2VhcmNoPzogTmFtZVNlYXJjaCB9ID0ge30sXG4pOiBTZWFyY2hSZXBvcnQge1xuICBjb25zdCBxID0gcXVlcnkudHJpbSgpO1xuICBpZiAocSA9PT0gXCJcIikgcmV0dXJuIHsgcXVlcnk6IFwiXCIsIGRvY3VtZW50czogW10sIHRleHQ6IFtdLCBjb3VudDogMCwgdHJ1bmNhdGVkOiBmYWxzZSB9O1xuICBjb25zdCBwZXJEb2MgPSBjYXBzLnBlckRvYyA/PyBQRVJfRE9DO1xuICBjb25zdCB0b3RhbCA9IGNhcHMudG90YWwgPz8gVE9UQUw7XG4gIGNvbnN0IG5hbWVzID0gY2Fwcy5uYW1lcyA/PyBOQU1FUztcblxuICBjb25zdCBzY29yZWQgPSAoY2Fwcy5uYW1lU2VhcmNoID8/IHJhbmtOYW1lcykoY2FuZGlkYXRlcywgcSwgbmFtZXMpO1xuXG4gIGNvbnN0IHRleHQ6IFRleHRNYXRjaFtdID0gW107XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoY291bnQgPj0gdG90YWwpIHtcbiAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgbGV0IGJvZHk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBib2R5ID0gcmVhZChjKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGJvZHkgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoYm9keSA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3Qgcm9vbSA9IE1hdGgubWluKHBlckRvYywgdG90YWwgLSBjb3VudCk7XG4gICAgY29uc3QgaGl0cyA9IHNlYXJjaFRleHQoYm9keSwgcSwgcm9vbSArIDEpO1xuICAgIGlmIChoaXRzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgaWYgKGhpdHMubGVuZ3RoID4gcm9vbSkgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICBjb25zdCBrZXB0ID0gaGl0cy5zbGljZSgwLCByb29tKTtcbiAgICBjb3VudCArPSBrZXB0Lmxlbmd0aDtcbiAgICB0ZXh0LnB1c2goe1xuICAgICAgcGF0aDogYy5wYXRoLFxuICAgICAgLi4uKGMuc2x1ZyAhPT0gdW5kZWZpbmVkID8geyBzbHVnOiBjLnNsdWcgfSA6IHt9KSxcbiAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgIC4uLihjLnZlcnNpb24gIT09IHVuZGVmaW5lZCA/IHsgdmVyc2lvbjogYy52ZXJzaW9uIH0gOiB7fSksXG4gICAgICBoaXRzOiBrZXB0LFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnk6IHEsIGRvY3VtZW50czogc2NvcmVkLCB0ZXh0LCBjb3VudCwgdHJ1bmNhdGVkIH07XG59XG4iLAogICAgIi8vIElzIHRoZSBodW1hbiB3YWl0aW5nIG9uIGFuIGFuc3dlciwgYW5kIGZvciBob3cgbG9uZyAoRTUzKT9cbi8vXG4vLyDim5QgREVSSVZFRCwgTk9UIERFQ0xBUkVEIOKAlCBDb2xlJ3MgcnVsaW5nLCBhbmQgdGhlIHJlYXNvbiBpcyBsb2FkLWJlYXJpbmc6IFwid2Vcbi8vIGNvdWxkIGFkZCBzb21lIGFmZm9yZGFuY2UgdGhhdCBzZW5kcyBhIGNoZWNrLWluIHdpdGggYW4gYWdlbnTigKYgd2hlcmUgd2UncmVcbi8vIG5vdCBhZGRpbmcgbW9yZSB0YXNrcyBmb3IgdGhlIGFnZW50IHRvIGhhdmUgdG8gZXhwbGljaXRseSBkby5cIiBBbiBhZ2VudCB0aGF0XG4vLyBtdXN0IHJlbWVtYmVyIHRvIHNheSBcInRoaW5raW5nXCIgd2lsbCBmb3JnZXQgZXhhY3RseSB3aGVuIGl0IG1hdHRlcnMg4oCUIGl0IGlzXG4vLyBidXN5LCB3aGljaCBpcyB0aGUgd2hvbGUgc2l0dWF0aW9uIGJlaW5nIHNpZ25hbGxlZC4gU28gbm90aGluZyBoZXJlIGFza3MgdGhlXG4vLyBhZ2VudCBmb3IgYW55dGhpbmcuIFRoZSBzdGF0ZSBpcyByZWFkIG9mZiB0aGUgY29udmVyc2F0aW9uOiBhIGh1bWFuIG1lc3NhZ2Vcbi8vIHdpdGggbm8gYWdlbnQgbWVzc2FnZSBhZnRlciBpdCBpcyBhIGh1bWFuIHdhaXRpbmcuXG4vL1xuLy8g4puUIEFORCBUSEUgQUdFTlQnUyBSRVBMWSBJUyBUSEUgQ09NUExFVElPTiBTSUdOQUwsIHdoaWNoIGlzIG1pbmQtbWFwcGVyJ3Ncbi8vIHJ1bGUgKFIxMSBTRUFNIDIpIGFuZCBpcyBzdG9sZW4gZGVsaWJlcmF0ZWx5LiBUaGVyZSBpcyBubyBgZG9uZWAgc3RhdGUgdG9cbi8vIGVtaXQsIHNvIHRoZXJlIGlzIG5vIGBkb25lYCBzdGF0ZSB0byBnZXQgb3V0IG9mIHN5bmMuIE9uZSBjb25zZXF1ZW5jZSB3b3J0aFxuLy8gbmFtaW5nIGJlY2F1c2UgaXQgZmVsbCBvdXQgZm9yIGZyZWU6IGBzdGFydFRhc2tgIHBvc3RzIGl0cyBhbm5vdW5jZW1lbnQgQVNcbi8vIFRIRSBBR0VOVCAoRTUwKSwgc28gdGhlIGhhcHB5IHBhdGggQ29sZSBkZXNjcmliZWQg4oCUIFwiZ3JlYXQsIEknbSBnb2luZyB0byBnZXRcbi8vIHRoYXQgc3RhcnRlZFwiLCB0aGVuIGEgdGFzaywgdGhlbiBhIHN1YmFnZW50IOKAlCBjbGVhcnMgdGhpcyBieSBjb25zdHJ1Y3Rpb24uXG4vL1xuLy8g4pqgIEEgU1lTVEVNIExJTkUgSVMgTk9UIEEgUkVQTFkuIGBhbm5vdW5jZSgpYCBuYXJyYXRlcyBhZ2VudCBBQ1RTIChcIkFnZW50XG4vLyBub3RlZCDigKYgb24gbWFyZW5cIiksIHdoaWNoIGlzIGV2aWRlbmNlIG9mIGxpZmUgYnV0IG5vdCBhIGNoZWNrLWluIHdpdGggdGhlXG4vLyBwZXJzb24gd2FpdGluZy4gQ291bnRpbmcgaXQgd291bGQgc2lsZW5jZSB0aGUgc2lnbmFsIHByZWNpc2VseSBpbiB0aGUgY2FzZVxuLy8gdGhpcyBleGlzdHMgZm9yOiBhbiBhZ2VudCB0aGF0IGlzIGJ1c3kgZG9pbmcgdGhpbmdzIGFuZCBoYXMgbm90IHNhaWQgYSB3b3JkXG4vLyB0byB0aGUgaHVtYW4uIE9ubHkgYHdobyA9PT0gXCJhZ2VudFwiYCBjbGVhcnMuXG5pbXBvcnQgdHlwZSB7IENoYXRXaG8sIFdhaXRpbmcgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKipcbiAqIEhvdyBsb25nIGEgaHVtYW4gd2FpdHMgYmVmb3JlIHRoZSB3YWl0IGlzIHdvcnRoIHJlcG9ydGluZy4gMzAgcywgQ29sZSdzXG4gKiBudW1iZXIg4oCUIGxvbmcgZW5vdWdoIHRoYXQgYW4gb3JkaW5hcnkgYW5zd2VyIG5ldmVyIHRyaXBzIGl0LCBzaG9ydCBlbm91Z2hcbiAqIHRoYXQgaXQgaXMgc3RpbGwgdGhlIHNhbWUgbW9tZW50IGZvciB0aGUgcGVyc29uIHNpdHRpbmcgdGhlcmUuXG4gKi9cbmV4cG9ydCBjb25zdCBTVEFMTF9NUyA9IDMwXzAwMDtcblxuLyoqIFdoYXQgYSBzbm9vemUgYnV5cywgd2hlbiB0aGUgYWdlbnQgZG9lcyBub3QgbmFtZSBhIGR1cmF0aW9uLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU05PT1pFX01TID0gMTIwXzAwMDtcblxuLy8gYFdhaXRpbmdgIGl0c2VsZiBsaXZlcyBpbiBgcHJvdG9jb2wudHNgIOKAlCBpdCByaWRlcyBpbiBgUHVibGljU3RhdGVgLCBhbmQgdGhhdFxuLy8gZmlsZSBpcyBpbXBvcnQtZnJlZSBvbiBwdXJwb3NlLiBJdHMgYGJhZGdlYCBjYXJyaWVzIHRoZSBydWxlIHRoYXQgbWF0dGVyczpcbi8vIOKblCBTVEFMTEVEIE1VU1QgTk9UIFBVTFNFLiBBIHB1bHNlIG92ZXIgYSB3ZWRnZWQgYWdlbnQgaXMgZmFsc2UgbGl2ZW5lc3Mg4oCUIHRoZVxuLy8gYW5pbWF0aW9uIGNsYWltcyBcInNvbWV0aGluZyBpcyBoYXBwZW5pbmdcIiB3aGVuIHRoZSBob25lc3QgYW5zd2VyIGlzIFwiSSBjYW5ub3Rcbi8vIHRlbGwgYW55IG1vcmVcIi4gbWluZC1tYXBwZXIgc2VwYXJhdGVzIHRoZXNlIHR3byBmb3IgdGhlIHNhbWUgcmVhc29uLlxuXG50eXBlIE1zZyA9IHsgaWQ6IHN0cmluZzsgd2hvOiBDaGF0V2hvOyB0czogbnVtYmVyIH07XG5cbi8qKlxuICogVGhlIGh1bWFuIG1lc3NhZ2Ugbm90aGluZyBoYXMgYW5zd2VyZWQgeWV0LCBvciBudWxsLlxuICpcbiAqIGBhY2tub3dsZWRnZWRVbnRpbGAgaXMgYSBzbm9vemUgKHRoZSBhZ2VudCBzYWlkIGl0IGlzIHN0aWxsIHdvcmtpbmcpLiBXaGlsZVxuICogaXQgaG9sZHMsIHRoZSBiYWRnZSBzdGF5cyBhIHB1bHNlIHBhc3QgdGhlIHN0YWxsIHRocmVzaG9sZCDigJQgdGhlIGFnZW50XG4gKiB2b2x1bnRlZXJlZCBldmlkZW5jZSBvZiBsaWZlLCBzbyBzaG93aW5nIFwibWF5IGJlIHN0dWNrXCIgd291bGQgYmUgdGhlIGxpZS5cbiAqIFdoZW4gaXQgRVhQSVJFUyB0aGUgYmFkZ2UgZ29lcyBzdGFsbGVkIGFnYWluLCBiZWNhdXNlIHRoZSBodW1hbiBpcyBvd2VkIHRoZVxuICogdHJ1dGggZXZlbnR1YWxseTsgdGhhdCBleHBpcnkgaXMgZGVsaWJlcmF0ZWx5IG5vdCBhIHJlYXNvbiB0byBudWRnZSB0aGUgYWdlbnRcbiAqIGEgc2Vjb25kIHRpbWUgKHNlZSB0aGUgc2VydmVyJ3Mgb25jZS1wZXItbWVzc2FnZSBydWxlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhaXRpbmdPbihcbiAgY2hhdDogcmVhZG9ubHkgTXNnW10sXG4gIG5vdzogbnVtYmVyLFxuICBvcHRzOiB7IHN0YWxsTXM/OiBudW1iZXI7IGFja25vd2xlZGdlZFVudGlsPzogbnVtYmVyIH0gPSB7fSxcbik6IFdhaXRpbmcgfCBudWxsIHtcbiAgY29uc3Qgc3RhbGxNcyA9IG9wdHMuc3RhbGxNcyA/PyBTVEFMTF9NUztcbiAgLy8gV2FsayBiYWNrIHRvIHRoZSBsYXN0IHRoaW5nIHRoYXQgd2FzIG5vdCBuYXJyYXRpb24uIEEgaHVtYW4gdGhlcmUgbWVhbnNcbiAgLy8gbm9ib2R5IGhhcyBhbnN3ZXJlZCB0aGVtLlxuICBsZXQgcGVuZGluZzogTXNnIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBjaGF0Lmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbSA9IGNoYXRbaV07XG4gICAgaWYgKCFtIHx8IG0ud2hvID09PSBcInN5c3RlbVwiKSBjb250aW51ZTtcbiAgICBpZiAobS53aG8gPT09IFwiYWdlbnRcIikgcmV0dXJuIG51bGw7XG4gICAgcGVuZGluZyA9IG07XG4gICAgYnJlYWs7XG4gIH1cbiAgaWYgKCFwZW5kaW5nKSByZXR1cm4gbnVsbDtcblxuICAvLyDimqAgVGhlIEZJUlNUIG9mIHRoZSB1bmFuc3dlcmVkIHJ1biwgbm90IHRoZSBsYXN0LiBTb21lb25lIHdobyBzZW5kcyB0aHJlZVxuICAvLyBtZXNzYWdlcyB3aGlsZSB3YWl0aW5nIGhhcyBiZWVuIHdhaXRpbmcgc2luY2UgdGhlIGZpcnN0IG9uZSwgYW5kIHJlc2V0dGluZ1xuICAvLyB0aGUgY2xvY2sgb24gZXZlcnkgZm9sbG93LXVwIHdvdWxkIG1lYW4gdGhlIG1vcmUgYW54aW91cyB0aGV5IGdldCwgdGhlXG4gIC8vIGxvbmdlciB3ZSBjbGFpbSB0aGV5IGhhdmUgYmVlbiB3YWl0aW5nIGlzIHplcm8uXG4gIGxldCBzaW5jZSA9IHBlbmRpbmcudHM7XG4gIGxldCBtZXNzYWdlSWQgPSBwZW5kaW5nLmlkO1xuICBmb3IgKGxldCBpID0gY2hhdC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IG0gPSBjaGF0W2ldO1xuICAgIGlmICghbSB8fCBtLndobyA9PT0gXCJzeXN0ZW1cIikgY29udGludWU7XG4gICAgaWYgKG0ud2hvICE9PSBcImh1bWFuXCIpIGJyZWFrO1xuICAgIHNpbmNlID0gbS50cztcbiAgICBtZXNzYWdlSWQgPSBtLmlkO1xuICB9XG5cbiAgY29uc3QgYWNrbm93bGVkZ2VkID0gb3B0cy5hY2tub3dsZWRnZWRVbnRpbCAhPT0gdW5kZWZpbmVkICYmIG5vdyA8IG9wdHMuYWNrbm93bGVkZ2VkVW50aWw7XG4gIGNvbnN0IHN0YWxsZWQgPSBub3cgLSBzaW5jZSA+PSBzdGFsbE1zICYmICFhY2tub3dsZWRnZWQ7XG4gIHJldHVybiB7IG1lc3NhZ2VJZCwgc2luY2UsIGJhZGdlOiBzdGFsbGVkID8gXCJzdGFsbGVkXCIgOiBcIndvcmtpbmdcIiB9O1xufVxuXG4vKiogV2hhdCB0aGUgY29udmVyc2F0aW9uIHNob3dzLCBwZXIgYmFkZ2UuIG1pbmQtbWFwcGVyJ3Mgd29yZHMsIG5lYXIgZW5vdWdoLiAqL1xuZXhwb3J0IGNvbnN0IFdBSVRJTkdfTEFCRUw6IFJlY29yZDxXYWl0aW5nW1wiYmFkZ2VcIl0sIHN0cmluZz4gPSB7XG4gIHdvcmtpbmc6IFwid29ya2luZyBvbiB0aGlz4oCmXCIsXG4gIHN0YWxsZWQ6IFwidG9vayB0aGlzIGluLCB0aGVuIHdlbnQgcXVpZXQg4oCUIG1heSBiZSBzdHVja1wiLFxufTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFxREEsdUJBQVMsNkJBQTRCLDJCQUFjLHlCQUFVO0FBQzdELG9CQUFTO0FBQ1QscUJBQVMsc0JBQVUsd0JBQVMscUJBQVksa0JBQU07QUFDOUM7QUFDQSxzQkFBUzs7O0FDM0NUO0FBcUJPLFNBQVMsZUFBZSxDQUFDLFFBQWdCLE1BQW9CO0FBQUEsRUFDbEUsTUFBTSxNQUFNLEdBQUcs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YSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxzQkFBMEIsT0FBTyxLQUN4RixjQUNGLEVBQ0csSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQ25CLEtBQUssR0FBRztBQUFBLENBQ2I7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBRVQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsSUFBSSxNQUFNLFlBQVk7QUFBQSxNQUNwQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsTUFDeEMsU0FBUyxNQUFNO0FBQUEsTUFDZixVQUFVLE1BQU0sVUFBVSxPQUFPLE1BQU0sT0FBTyxJQUFJO0FBQUEsTUFDbEQsV0FBVyxNQUFNO0FBQUEsSUFDbkIsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFFVixNQUFNLFNBQVMsYUFBYSxlQUFlLEVBQUUsU0FBUztBQUFBLElBQ3RELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsSUFBSSxPQUFPLFFBQVEsT0FBTyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxDQUM1RjtBQUFBLElBQ0EsT0FBTyxXQUFXLE1BQU0sSUFBSSxXQUFXLE1BQU0sSUFBSTtBQUFBO0FBQUEsRUFFbkQsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLG9CQUFvQixFQUFFLFFBQVEsTUFBTSxFQUFFLE1BQU0sWUFBWSxFQUFFLFdBQVcsTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLElBQUksQ0FBQztBQUFBLENBQzFIO0FBQUEsRUFDQSxNQUFNLE1BQU0sTUFBTSxFQUFFO0FBQUEsRUFDcEIsTUFBTSxFQUFFO0FBQUEsRUFFUixJQUFJLElBQUksU0FBUyxLQUFLLE1BQU0sS0FBSztBQUFBLElBQy9CLElBQUk7QUFBQSxNQUNGLElBQUksVUFBUyxNQUFNLEdBQUcsRUFBRSxTQUFTO0FBQUEsUUFBRyxZQUFXLE1BQU0sR0FBRztBQUFBLE1BQ3hELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxPQUFPLElBQUk7QUFBQTtBQVFiLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjhDMkQ5OTk2RUNGQTBCNkI2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
