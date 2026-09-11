// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { readFileSync as readFileSync4, statSync as statSync3, unlinkSync as unlinkSync2, watch } from "fs";
import { homedir as homedir2, tmpdir } from "os";
import { basename as basename3, dirname as dirname3, isAbsolute as isAbsolute2, join as join4, resolve as resolve2 } from "path";
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

// src/scriptorium/backend/session.ts
import {
  existsSync as existsSync3,
  mkdirSync,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  realpathSync,
  renameSync as renameSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { homedir } from "os";
import { basename as basename2, dirname as dirname2, extname, isAbsolute, join as join3, relative as relative2, resolve, sep as sep2 } from "path";

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

// src/scriptorium/backend/session.ts
var MANIFEST_FORMAT = 1;

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
    this.dir = join3(home, "sessions", manifest.sessionId);
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
    mkdirSync(join3(s.dir, "docs"), { recursive: true });
    s.persist();
    return s;
  }
  static restore(home, sessionId) {
    const path = join3(home, "sessions", sessionId, "manifest.json");
    if (!existsSync3(path))
      throw new SessionError(`no saved session ${sessionId}`, 404);
    const m = JSON.parse(readFileSync3(path, "utf8"));
    if (m.format !== MANIFEST_FORMAT)
      throw new SessionError(`session ${sessionId} has manifest format ${m.format}`, 409);
    const s = new Session(home, m);
    mkdirSync(join3(s.dir, "docs"), { recursive: true });
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
      return readdirSync2(join3(home, "sessions")).filter((id) => existsSync3(join3(home, "sessions", id, "manifest.json")));
    } catch {
      return [];
    }
  }
  get id() {
    return this.m.sessionId;
  }
  get docsDir() {
    return join3(this.dir, "docs");
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
      const realDir = dirname2(realOr(d.original));
      if (!roots.some((r) => r.watch === realDir && r.recursive === false) && !roots.some((r) => r.recursive && (realDir === r.watch || realDir.startsWith(r.watch + sep2))))
        roots.push({ path: realDir, watch: realDir, recursive: false });
    }
    return roots;
  }
  persist() {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(join3(this.dir, "manifest.json"), `${JSON.stringify(this.m, null, 2)}
`);
  }
  writeOwned(path, text) {
    mkdirSync(dirname2(path), { recursive: true });
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
    const n = Math.max(...d.versions.map((v) => v.n)) + 1;
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
    return join3(this.docsDir, d.slug, `v${n}${d.ext}`);
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
    const byName = this.m.docs.filter((d) => basename2(d.original) === key || d.rel === key);
    return byName.length === 1 ? byName[0] : undefined;
  }
  versionOrDie(d, n) {
    const v = d.versions.find((x) => x.n === n);
    if (!v)
      throw new SessionError(`${d.slug} has no v${n}`, 404, d.versions.map((x) => `v${x.n}`));
    return v;
  }
  slugFor(original) {
    const stem = basename2(original, extname(original)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "doc";
    let slug = stem;
    for (let i = 2;this.m.docs.some((d) => d.slug === slug); i++)
      slug = `${stem}-${i}`;
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
    const ext = [".md", ".markdown", ".mdx", ".txt"].includes(extname(abs).toLowerCase()) ? extname(abs).toLowerCase() : ".md";
    const at = locate(this.m.context, abs);
    const d = {
      slug: this.slugFor(abs),
      name: basename2(abs),
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
      const spelled = join3(e.root, relative2(realRoot, real));
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
    const n = Math.max(...d.versions.map((v) => v.n)) + 1;
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
  activate(opts) {
    const d = this.docOrDie(opts.doc);
    this.versionOrDie(d, opts.version);
    const previous = d.active;
    d.active = opts.version;
    this.adoptActive(d, readFileSync3(this.versionPath(d, d.active), "utf8"));
    this.persist();
    return { slug: d.slug, previous };
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
          return `${e.label}/${toPosix(relative2(e.root, abs))}`;
      } else if (e.nodes.some((n) => join3(e.root, n.rel) === abs))
        return e.label;
    }
    if (abs.startsWith(this.workspace + sep2))
      return `workspace/${toPosix(relative2(this.workspace, abs))}`;
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
        return join3(e.root, relative2(realRoot, real));
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
        const node = findNode(e.nodes, toPosix(relative2(e.root, abs)));
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
        if (e.nodes.length === 1 && only?.kind === "doc" && join3(e.root, only.rel) === abs)
          return { abs, entry: e, whole: true, dir: false };
        continue;
      }
      if (abs === e.root)
        return { abs, entry: e, whole: true, dir: true };
      if (abs.startsWith(e.root + sep2)) {
        const node = findNode(e.nodes, toPosix(relative2(e.root, abs)));
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
        d.name = basename2(now);
      }
    }
    const drop = new Set;
    for (const e of this.m.context) {
      if (e.membership === "listed") {
        const only = e.nodes[0];
        if (only?.kind !== "doc")
          continue;
        const now = moved(join3(e.root, only.rel));
        if (!now)
          continue;
        if (this.coveringEntry(now, e.id))
          drop.add(e.id);
        else {
          e.root = dirname2(now);
          e.label = basename2(now);
          e.nodes = [{ kind: "doc", rel: basename2(now) }];
        }
      } else {
        const now = moved(e.root);
        if (!now)
          continue;
        if (this.coveringEntry(now, e.id))
          drop.add(e.id);
        else {
          e.root = now;
          e.label = basename2(now) || now;
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
    if (!existsSync3(join3(dir, name)))
      return name;
    const ext = isDir ? "" : extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2;; i++) {
      const n = `${stem} ${i}${ext}`;
      if (!existsSync3(join3(dir, n)))
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
    const abs = join3(dir, file);
    this.refuseExisting(abs);
    writeFileSync2(abs, "", { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }
  createFolder(rawDir, name) {
    const dir = this.destinationOrDie(rawDir);
    const folder = name === undefined ? this.freeName(dir, "New folder", true) : this.nameOrDie(name);
    const abs = join3(dir, folder);
    this.refuseExisting(abs);
    mkdirSync(abs);
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }
  move(rawPath, rawInto) {
    const item = this.itemOrDie(rawPath);
    const into = this.destinationOrDie(rawInto);
    if (into === item.abs || into.startsWith(item.abs + sep2))
      throw new SessionError(`cannot move ${this.display(item.abs)} into itself`, 400);
    if (dirname2(item.abs) === into)
      throw new SessionError(`${this.display(item.abs)} is already in that folder`, 400);
    const to = join3(into, basename2(item.abs));
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
      next += extname(item.abs) || ".md";
    const to = join3(dirname2(item.abs), next);
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
    const rel = toPosix(relative2(item.entry.root, item.abs));
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
    const parent = dirname2(item.abs);
    const stem = basename2(item.abs, extname(item.abs)) || "Untitled";
    const folder = join3(parent, this.freeName(parent, stem, true));
    mkdirSync(folder);
    const to = join3(folder, basename2(item.abs));
    this.renameOrDie(item.abs, to);
    const e = item.entry;
    e.membership = "mirrored";
    e.root = folder;
    e.label = basename2(folder);
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
    const abs = join3(dir, this.freeName(dir, file, false));
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
  docView(d) {
    return {
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
  view(mode, selection) {
    return {
      sessionId: this.m.sessionId,
      home: this.home,
      workspace: this.workspace,
      mode,
      context: this.m.context,
      docs: this.m.docs.map((d) => this.docView(d)),
      openDoc: this.m.openDoc,
      selection,
      chat: this.m.chat
    };
  }
}

// src/scriptorium/backend/server.ts
var SCRIPT_DIR = dirname3(fileURLToPath(import.meta.url));
var SKILL_ROOT = join4(SCRIPT_DIR, "..");
var DIST_DIR = join4(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
function serveDist(path) {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}
function scriptoriumHome() {
  return resolve2(process.env.SCRIPTORIUM_HOME ?? join4(homedir2(), ".scriptorium"));
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
  const prefsFile = join4(home, "prefs.json");
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
            onFs(join4(r.path, name.toString()));
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
        line = `${who} turned ${basename3(m.path)} into a set: ${shown(m.folder)}.`;
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
      case "reveal": {
        const path = session.shownPath(surfacePath(msg.path));
        const [cmd, ...args] = process.platform === "darwin" ? ["open", "-R", path] : process.platform === "win32" ? ["explorer", `/select,${path}`] : ["xdg-open", dirname3(path)];
        Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
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
  const handleAgentCmd = (cmd) => {
    if (isStructureOp(cmd))
      return structure(cmd, "agent");
    switch (cmd.type) {
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
        throw new SessionError(`unrecognised command type ${JSON.stringify(cmd.type)} \u2014 nothing was applied`, 400, ["context.add", "version.new", "say", "activate", "close", ...STRUCTURE_OPS]);
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
  const sessionFile = join4(tmpdir(), `scriptorium-${sessionId}.json`);
  const latestFile = join4(tmpdir(), "scriptorium-latest.json");
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
    return join4(homedir2(), p.slice(2));
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

//# debugId=12C074F9D677B1DD64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3Nlc3Npb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdHJlZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgcGVyLXNlc3Npb24gZGFlbW9uIOKAlCB0aGUgcHJvY2VzcyB0aGUgc3VyZmFjZSB0YWxrcyB0byBvdmVyIGFcbiAqIFdlYlNvY2tldCBhbmQgdGhlIENMSSB0YWxrcyB0byBvdmVyIEhUVFAuIExhdW5jaGVkIGJ5XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL3NjcmlwdG9yaXVtL3NjcmlwdHMvc2VydmVyLnRzYCAodGhlIGxhdW5jaGVyKSwgd2hpY2hcbiAqIGltcG9ydHMgdGhlIEJVSUxUIGBkaXN0L3NlcnZlci5qc2AuXG4gKlxuICog4pSA4pSAIFRIRSBFSUdIVCBRVUVTVElPTlMgKHNjYWZmb2xkaW5nIHBsYXlib29rIE4xKSwgQU5TV0VSRUQgQVMgREVTSUdOIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIEFyaXRobWV0aWM6IGBTS0lMTF9ST09UYC9gRElTVF9ESVJgIG9ubHksIGZvciB0aGUga2l0J3MgYHJlc29sdmVNb2RlYCBhbmRcbiAqICAgIGBzZXJ2ZUZyb21EaXN0YCwgYW5kIHRydWUgYXQgdGhlIEVNSVRURUQgYWRkcmVzcyAoYGRpc3Qvc2VydmVyLmpzYCwgd2hvc2VcbiAqICAgIGAuLmAgaXMgdGhlIHNraWxsIGZvbGRlcikuIE5vdGhpbmcgZWxzZSBpcyBwaW5uZWQgb2ZmIGBpbXBvcnQubWV0YWAuXG4gKiAyLiBTZXJ2ZXM6IFlFUy4gYC9gIGlzIHRoZSBidWlsdCBgaW5kZXguaHRtbGAgdmlhIGBzZXJ2ZUZyb21EaXN0YCwgbm9cbiAqICAgIHN1YnN0aXR1dGlvbjsgdGhlIG9ubHkgcm91dGVzIG9mIGl0cyBvd24gYXJlIGAvc3RhdGVgLCBgL2NtZGAsIGAvZXZlbnRzYCxcbiAqICAgIGAvd3NgIGFuZCBgL2ZzLypgIChyZWFkLW9ubHk6IGEgdmVyc2lvbidzIHRleHQsIGEgZGlyZWN0b3J5IGxpc3RpbmcpLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgYGNsaS50c2A7IHRoZSB0d28gc2hhcmUgYC4vaGVhcnRiZWF0LnRzYC5cbiAqIDQuIExpZmVjeWNsZTogbG9uZy1ydW5uaW5nLCBvbmUgZGFlbW9uIHBlciBzZXNzaW9uLCBpZGxlLXRpbWVvdXQgbGlrZVxuICogICAgZ2xhbW91ciAobGluZ2VyIGFmdGVyIHRoZSBsYXN0IHN1YnNjcmliZXIgbGVhdmVzOyBleGl0IDEyNCkuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oCUIGBtYWluYCBhd2FpdHMgdGhlXG4gKiAgICBzZXNzaW9uJ3MgZW5kIGFuZCBpdHMgb3duIGRyYWluLCBleGFjdGx5IGFzIGdsYW1vdXIncyBzZXJ2ZXIgZG9lcywgc28gdGhlXG4gKiAgICBsYXVuY2hlciBpcyBURVJNSU5BTC1FWElUIChgcHJvY2Vzcy5leGl0KGF3YWl0IHJ1bigpKWApOiBvbmNlIGBtYWluYFxuICogICAgcmVzb2x2ZXMgbm90aGluZyBtYXkga2VlcCB0aGUgcHJvY2VzcyBhbGl2ZSwgYW5kIGEgd2F0Y2hlciBoYW5kbGUgb3IgYVxuICogICAgc3RyYWdnbGluZyBzb2NrZXQgd291bGQuIERyaXZlbiwgbm90IHJlYWQgKHNlZSB0aGUgc2xpY2UtQSBqb3VybmFsKS5cbiAqIDYuIEV2ZW50IGlkcyByZWNvdmVyZWQgYWNyb3NzIHJlc3RhcnQ/IE5PIOKAlCB0aGUgbG9nIGlzIGluIG1lbW9yeSBhbmQgaWRzXG4gKiAgICByZXN0YXJ0IGF0IDEsIGV2ZW4gdW5kZXIgYC0tcmVzdG9yZWAgKHdoaWNoIHJlc3RvcmVzIHRoZSBNQU5JRkVTVCwgbm90IHRoZVxuICogICAgbG9nKS4gU28gdGhlIGxvZyBpcyBzdGFtcGVkIHdpdGggYSBwZXItYm9vdCBFUE9DSCAobWluZC1tYXBwZXIncyBzaGFwZSlcbiAqICAgIGFuZCB0aGUgdGFpbCByZXNldHMgaXRzIGN1cnNvciB3aGVuIHRoZSBlcG9jaCBjaGFuZ2VzLlxuICogNy4gQSBraXQgc3ViamVjdCBpbiBhIGRpZmZlcmVudCBzaGFwZT8gTm8g4oCUIHRoZSBzaGFwZSB3YXMgY2hvc2VuIHRvIGJlIHRoZVxuICogICAga2l0J3MuXG4gKiA4LiBBIGtpdCBtb2R1bGUgbmFtZXMgdGhpcyBzcGVsbCBhcyBpdHMgc291cmNlPyBTdHJ1Y3R1cmFsbHkgTk86IHNjcmlwdG9yaXVtXG4gKiAgICBpcyB0aGUgZmlyc3Qgc3BlbGwgc2NhZmZvbGRlZCBhZnRlciB0aGUgY29udmVyZ2VuY2UuXG4gKlxuICog4pSA4pSAIEtJVCBWRVJESUNUUyAocGxheWJvb2sgTjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGVycm9ycyBTVUJKRUNUICh0aGUgQ0xJOyB0aGUgZGFlbW9uIGFuc3dlcnMgSFRUUCBzdGF0dXNlcyB0aGUgQ0xJIG1hcHMpIMK3XG4gKiBzZXJ2ZURpc3QgU1VCSkVDVCAoYHJlc29sdmVNb2RlYCwgYHNlcnZlRnJvbURpc3RgKSDCtyBob3VzZWtlZXBpbmcgU1VCSkVDVCwgYWxsXG4gKiB0aHJlZSBleHBvcnRzIChgc2hvdWxkSWRsZUNsb3NlYCB2aWEgYHN0YXJ0SG91c2VrZWVwaW5nYCdzIGlkbGUtY2xvc2UsIHRoZVxuICogc25hcHNob3Qgc3dlZXAg4oCUIGhlcmUgdGhlIG1hbmlmZXN0IGlzIHdyaXR0ZW4gb24gZXZlcnkgY2hhbmdlIGluc3RlYWQsIHNvIHRoZVxuICogc3dlZXAncyBzbmFwc2hvdCBob29rIGlzIGRlbGliZXJhdGVseSBOT1QgcGFzc2VkIOKAlCBhbmQgYGRyYWluQW5kU3RvcGApIMK3XG4gKiB0YWlsRXZlbnRzIFNVQkpFQ1QgKHRoZSBDTEkncyBgdGFpbGApIMK3IGhlYXJ0YmVhdCBTVUJKRUNUIChgLi9oZWFydGJlYXQudHNgKSDCt1xuICogZGlzY292ZXJ5IFNVQkpFQ1QgKHNlc3Npb24tSlNPTiwgRTEzOiBgc2NyaXB0b3JpdW0tPGlkPi5qc29uYCArXG4gKiBgc2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25gIGluIHRtcGRpciB2aWEgYHdyaXRlRmlsZUF0b21pY2AvYHVubGlua0lmTWF0Y2hlc2ApIMK3XG4gKiBldmVudExvZyBTVUJKRUNULCBXSVRIIEVQT0NIIChRNikgwrcgc3NlIFNVQkpFQ1QgKGBHRVQgL2V2ZW50c2ApIMK3XG4gKiBsaWIvcHJpbnRKc29uIFNVQkpFQ1QgKHRoZSBDTEkgc3BlYWtzIHRoZSBhZ2VudCB3aXJlKS5cbiAqXG4gKiDilIDilIAgVEVBUkRPV04gT1JERVIgKHJlZ2lzdGVyIEE2KSwgU1RBVEVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGdsYW1vdXIncyBvcmRlcjogc3RvcCBob3VzZWtlZXBpbmcg4oaSIGNsb3NlIHRoZSB3YXRjaGVycyDihpIgcGVyc2lzdCB0aGVcbiAqIG1hbmlmZXN0IOKGkiB1bmxpbmsgZGlzY292ZXJ5IOKGkiBlbWl0IGBjbG9zZWRgIOKGkiBkcmFpbi4gRGlzY292ZXJ5IGdvZXMgQkVGT1JFIHRoZVxuICogYGNsb3NlZGAgZnJhbWUgc28gYSB0YWlsIHRoYXQgc2VlcyBgY2xvc2VkYCBhbmQgYSBDTEkgdmVyYiB0aGF0IHJ1bnMgcmlnaHRcbiAqIGFmdGVyIGl0IGJvdGggZmluZCBubyBwb2ludGVyIHRvIGEgZGFlbW9uIHRoYXQgaXMgbGVhdmluZzsgdGhlIG90aGVyIG9yZGVyXG4gKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYSB2ZXJiIHJlc29sdmVzIGEgc2Vzc2lvbiB0aGF0IHdpbGwgcmVmdXNlIGl0LlxuICovXG5cbmltcG9ydCB7IHR5cGUgRlNXYXRjaGVyLCByZWFkRmlsZVN5bmMsIHN0YXRTeW5jLCB1bmxpbmtTeW5jLCB3YXRjaCB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHVubGlua0lmTWF0Y2hlcywgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHsgY3JlYXRlRXZlbnRMb2cgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXZlbnRMb2cudHNcIjtcbmltcG9ydCB7IGRyYWluQW5kU3RvcCwgc3RhcnRIb3VzZWtlZXBpbmcgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaG91c2VrZWVwaW5nLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZSBhcyByZXNvbHZlTW9kZUluLCBzZXJ2ZUZyb21EaXN0IH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NlcnZlRGlzdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBTc2VDbGllbnRzLCBzc2VSZXNwb25zZSB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zc2UudHNcIjtcbmltcG9ydCB7IElETEVfVElNRU9VVF9TRUMsIFNTRV9IRUFSVEJFQVRfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRDbWQsIENsaWVudE1zZywgU2VsZWN0aW9uLCBTZXJ2ZXJNc2csIFN0cnVjdHVyZU9wIH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IHR5cGUgRmlsZUV2ZW50LCBTZXNzaW9uLCBTZXNzaW9uRXJyb3IgfSBmcm9tIFwiLi9zZXNzaW9uXCI7XG5pbXBvcnQgeyBsaXN0RGlyLCBQYXRoRXJyb3IgfSBmcm9tIFwiLi90cmVlXCI7XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcblxuLyoqIHJlbGVhc2UgaWZmIGBkaXN0L2luZGV4Lmh0bWxgIGV4aXN0cyBhdCB0aGUgc2tpbGwgcm9vdDsgdGhlIGVudiB2YXIgb3ZlcnJpZGVzIChDb250cmFjdCAxKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZSgpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICByZXR1cm4gcmVzb2x2ZU1vZGVJbihESVNUX0RJUik7XG59XG5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICByZXR1cm4gc2VydmVGcm9tRGlzdChESVNUX0RJUiwgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSkpO1xufVxuXG4vKiogYCRTQ1JJUFRPUklVTV9IT01FYCwgZGVmYXVsdCBgfi8uc2NyaXB0b3JpdW1gLiBgcHJvbXB0cy5qc29uYCBiZXNpZGUgYHNlc3Npb25zL2AgaXMgc2xpY2UgQidzIChFOSkuICovXG5leHBvcnQgZnVuY3Rpb24gc2NyaXB0b3JpdW1Ib21lKCk6IHN0cmluZyB7XG4gIHJldHVybiByZXNvbHZlKHByb2Nlc3MuZW52LlNDUklQVE9SSVVNX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLnNjcmlwdG9yaXVtXCIpKTtcbn1cblxuZXhwb3J0IHR5cGUgU3RhcnRPcHRzID0ge1xuICBwb3J0PzogbnVtYmVyO1xuICByZXN0b3JlPzogc3RyaW5nO1xuICB0aW1lb3V0Uz86IG51bWJlcjtcbiAgLyoqIEUyMzogYSBORVcgc2Vzc2lvbidzIHdvcmtzcGFjZSDigJQgdGhlIGRpcmVjdG9yeSBgb3BlbmAgcmFuIGluLiBBIHJlc3RvcmUga2VlcHMgaXRzIG93bi4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIEEgdGFpbCBmcmFtZSdzIHBheWxvYWQuIFRoZSBsb2cgc3RhbXBzIGBpZGAgYW5kIGBlcG9jaGAuICovXG50eXBlIExvZ0V2ZW50ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHR5cGU6IHN0cmluZyB9O1xuXG4vKiogSG93IGxvbmcgYSBidXJzdCBvZiB3YXRjaGVyIGV2ZW50cyBvbiBvbmUgcGF0aCBzZXR0bGVzIGJlZm9yZSBpdCBpcyByZWFkLiAqL1xuY29uc3QgV0FUQ0hfU0VUVExFX01TID0gNjA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydERhZW1vbihvcHRzOiBTdGFydE9wdHMpIHtcbiAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAvLyBNb2RlIEJFRk9SRSBhbnkgd3JpdGU6IGEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3RcbiAgLy8gZGllIGF0IHRoZSBpbXBvcnQgaGF2aW5nIGNyZWF0ZWQgbm90aGluZyAoZ2xhbW91cidzIG1lYXN1cmVkIG9yZGVyKS5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IG9wdHMucmVzdG9yZVxuICAgID8gU2Vzc2lvbi5yZXN0b3JlKGhvbWUsIG9wdHMucmVzdG9yZSlcbiAgICA6IFNlc3Npb24uY3JlYXRlKGhvbWUsIHVuZGVmaW5lZCwgb3B0cy53b3Jrc3BhY2UpO1xuICBjb25zdCBzZXNzaW9uSWQgPSBzZXNzaW9uLmlkO1xuICBsZXQgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsID0gbnVsbDtcblxuICAvLyAtLS0gcHJlZnM6IHBlci12aWV3ZXIgY29udmVuaWVuY2VzIHRoYXQgb3V0bGl2ZSBhIHNlc3Npb24ncyBwb3J0IC0tLS0tLS0tLS0tLVxuICAvLyBCcm93c2VyIHN0b3JhZ2UgaXMga2V5ZWQgYnkgb3JpZ2luLCBwb3J0IGluY2x1ZGVkLCBhbmQgZXZlcnkgc2Vzc2lvbiBnZXRzIGFcbiAgLy8gbmV3IHBvcnQg4oCUIHNvIGEgcGFuZSBzaXplIGtlcHQgaW4gbG9jYWxTdG9yYWdlIHJlc2V0cyBhdCB0aGUgbmV4dCBgb3BlbmAuXG4gIC8vIFRoZXkgbGl2ZSBpbiB0aGUgaG9tZSBpbnN0ZWFkLCBzaGFyZWQgYnkgZXZlcnkgc2Vzc2lvbiBvZiB0aGlzIGhvbWUuXG4gIGNvbnN0IHByZWZzRmlsZSA9IGpvaW4oaG9tZSwgXCJwcmVmcy5qc29uXCIpO1xuICBjb25zdCBQUkVGX0tFWSA9IC9eW2Etel1bYS16MC05Oi5fLV17MCw2M30kLztcbiAgY29uc3QgUFJFRl9WQUxVRV9NQVggPSA0MDk2O1xuICBjb25zdCBQUkVGX0tFWVNfTUFYID0gNjQ7XG4gIC8qKlxuICAgKiBSZWFkIHRoZSBob21lJ3MgcHJlZnMgRlJFU0guIFNldmVyYWwgc2Vzc2lvbnMgY2FuIHNoYXJlIG9uZSBob21lIChFMTMpLCBlYWNoXG4gICAqIGl0cyBvd24gZGFlbW9uLCBzbyBhIGNvcHkgbG9hZGVkIG9uY2UgYXQgYm9vdCBhbmQgd3JpdHRlbiBiYWNrIHdob2xlIHdvdWxkXG4gICAqIGVyYXNlIGEga2V5IGFub3RoZXIgc2Vzc2lvbiB3cm90ZSBzaW5jZSAodmVyaWZ5IHBhc3MpLiBFdmVyeSB3cml0ZSBpc1xuICAgKiB0aGVyZWZvcmUgcmVhZCDihpIgc2V0IG9uZSBrZXkg4oaSIHdyaXRlLCBhbmQgZXZlcnkgc25hcHNob3QgcmVhZHMgdGhlIGZpbGUuXG4gICAqIE9ubHkgd2VsbC1mb3JtZWQgZW50cmllcyBzdXJ2aXZlIGEgcmVhZDsgYSBiYWQgZmlsZSByZWFkcyBhcyBlbXB0eSBhbmQgaXNcbiAgICogcmVwbGFjZWQgYnkgdGhlIG5leHQgd3JpdGUuXG4gICAqL1xuICBjb25zdCByZWFkUHJlZnMgPSAoKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9PiB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHByZWZzRmlsZSwgXCJ1dGY4XCIpKSBhcyB1bmtub3duO1xuICAgICAgaWYgKHJhdyAmJiB0eXBlb2YgcmF3ID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocmF3KSlcbiAgICAgICAgICBpZiAoUFJFRl9LRVkudGVzdChrKSAmJiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2Lmxlbmd0aCA8PSBQUkVGX1ZBTFVFX01BWCkgb3V0W2tdID0gdjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIHByZWZzIHlldCwgb3IgdW5yZWFkYWJsZSDigJQgZW1wdHkgKi9cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfTtcbiAgY29uc3QgdXNlckhvbWUgPSBob21lZGlyKCk7XG4gIGNvbnN0IHZpZXdTdGF0ZSA9ICgpID0+ICh7IC4uLnNlc3Npb24udmlldyhtb2RlLCBzZWxlY3Rpb24pLCBwcmVmczogcmVhZFByZWZzKCksIHVzZXJIb21lIH0pO1xuXG4gIC8vIC0tLSBjaGFubmVscyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8aW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPj4oKTtcbiAgY29uc3QgbG9nID0gY3JlYXRlRXZlbnRMb2c8TG9nRXZlbnQ+KHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfSk7XG4gIGNvbnN0IHNzZUNsaWVudHM6IFNzZUNsaWVudHMgPSBuZXcgU2V0KCk7XG4gIGxldCBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3QgdG91Y2ggPSAoKSA9PiB7XG4gICAgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIH07XG5cbiAgY29uc3Qgc2VuZCA9IChtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIGNvbnN0IHMgPSBKU09OLnN0cmluZ2lmeShtc2cpO1xuICAgIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3Muc2VuZChzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBzb2NrZXQgY2xvc2VkICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHNlbmQoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KTtcblxuICAvKiogQSBzeXN0ZW0gbGluZSBpbiB0aGUgY2hhdCDigJQgYW5kLCBiZWNhdXNlIHRoZSBhZ2VudCBtdXN0IGtub3cgaXQgdG9vLCBvbiB0aGUgdGFpbC4gKi9cbiAgY29uc3QgYW5ub3VuY2UgPSAodGV4dDogc3RyaW5nLCBmYWN0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9KSA9PiB7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCB0ZXh0KTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwic3lzdGVtXCIsIHRleHQsIHRzOiBtLnRzLCAuLi5mYWN0IH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gIH07XG5cbiAgLy8gLS0tIHRoZSB3YXRjaGVyIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vXG4gIC8vIOKaoCBERVZJQVRJT04gRlJPTSBUSEUgQlJJRUYsIFdJVEggSVRTIFJFQVNPTjogYG5vZGU6ZnNgIGB3YXRjaGAgKEJ1bidzXG4gIC8vIGJ1aWx0LWluKSwgTk9UIGBAcGFyY2VsL3dhdGNoZXJgLiBgQHBhcmNlbC93YXRjaGVyYCBpcyBhIG5hdGl2ZSBhZGRvbiB3aG9zZVxuICAvLyBsb2FkZXIgZG9lcyBhIHJ1bnRpbWUgYHJlcXVpcmUoKWAgb2YgYSBwZXItcGxhdGZvcm0gcGFja2FnZTsgYnVuZGxlZCBpbnRvXG4gIC8vIGBkaXN0L3NlcnZlci5qc2AgaXQgaXMgbm90IGlubGluZWQsIHNvIHRoZSBzaGlwcGVkIGRhZW1vbiB3b3VsZCBuZWVkIGFcbiAgLy8gYG5vZGVfbW9kdWxlc2AgdGhlIG1hcmtldHBsYWNlIG5ldmVyIGNvcGllcyAoaW1wb3J0LWJvdW5kYXJ5IHdhcmQgMWInc1xuICAvLyBcInRoZSBzaGlwcGVkIGV4ZWN1dGlvbiBwYXRoIGNhcnJpZXMgbm8gZGVwZW5kZW5jaWVzXCIpLiBNZWFzdXJlZCB1bmRlciBCdW5cbiAgLy8gMS40LjAgb24gbWFjT1MgYmVmb3JlIGNob29zaW5nOiBhIHJlY3Vyc2l2ZSBkaXJlY3Rvcnkgd2F0Y2ggcmVwb3J0cyBhblxuICAvLyBpbi1wbGFjZSB3cml0ZSwgYW4gYXRvbWljIHRtcCtyZW5hbWUgc2F2ZSwgYW5kIGJvdGggYWdhaW4gaW4gYVxuICAvLyBzdWJkaXJlY3Rvcnkg4oCUIHRoZSBmb3VyIGNhc2VzIGludmVzdGlnYXRpb24gwqc1IGRyb3ZlIEBwYXJjZWwvd2F0Y2hlciBvbi5cbiAgLy8gVGhlIGhhc2gtY29tcGFyZSBhbmQgc2VsZi13cml0ZSBzdXBwcmVzc2lvbiBhcmUgdW5jaGFuZ2VkIChzZXNzaW9uLnRzKS5cbiAgY29uc3Qgd2F0Y2hlcnMgPSBuZXcgTWFwPHN0cmluZywgRlNXYXRjaGVyPigpO1xuICBjb25zdCBwZW5kaW5nID0gbmV3IE1hcDxzdHJpbmcsIFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+PigpO1xuICBjb25zdCBvbkZzID0gKGFiczogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgdCA9IHBlbmRpbmcuZ2V0KGFicyk7XG4gICAgaWYgKHQpIGNsZWFyVGltZW91dCh0KTtcbiAgICBwZW5kaW5nLnNldChcbiAgICAgIGFicyxcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBwZW5kaW5nLmRlbGV0ZShhYnMpO1xuICAgICAgICBsZXQgZXY6IEZpbGVFdmVudCB8IG51bGwgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGV2ID0gc2Vzc2lvbi5vbkZpbGVFdmVudChhYnMpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiB3YXRjaGVyOiAke2V9XFxuYCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV2KSBoYW5kbGVGaWxlRXZlbnQoZXYpO1xuICAgICAgfSwgV0FUQ0hfU0VUVExFX01TKSxcbiAgICApO1xuICB9O1xuICBjb25zdCBzeW5jV2F0Y2hlcnMgPSAoKSA9PiB7XG4gICAgY29uc3Qgd2FudCA9IG5ldyBNYXAoXG4gICAgICBzZXNzaW9uLndhdGNoUm9vdHMoKS5tYXAoKHIpID0+IFtgJHtyLnJlY3Vyc2l2ZSA/IFwiUlwiIDogXCJGXCJ9OiR7ci53YXRjaH0+JHtyLnBhdGh9YCwgcl0pLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBba2V5LCB3XSBvZiB3YXRjaGVycylcbiAgICAgIGlmICghd2FudC5oYXMoa2V5KSkge1xuICAgICAgICB3LmNsb3NlKCk7XG4gICAgICAgIHdhdGNoZXJzLmRlbGV0ZShrZXkpO1xuICAgICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgcl0gb2Ygd2FudCkge1xuICAgICAgaWYgKHdhdGNoZXJzLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIFdhdGNoZWQgYXQgdGhlIFJFQUxQQVRILCByZXBvcnRlZCB1bmRlciB0aGUgc3RvcmVkIHBhdGggZm9ybVxuICAgICAgICAvLyAodmVyaWZ5LXBhc3MgZml4IDMg4oCUIHNlZSBTZXNzaW9uLndhdGNoUm9vdHMpLlxuICAgICAgICBjb25zdCB3ID0gd2F0Y2goci53YXRjaCwgeyByZWN1cnNpdmU6IHIucmVjdXJzaXZlIH0sIChfZXZlbnQsIG5hbWUpID0+IHtcbiAgICAgICAgICBpZiAobmFtZSkgb25Gcyhqb2luKHIucGF0aCwgbmFtZS50b1N0cmluZygpKSk7XG4gICAgICAgICAgZWxzZSBpZiAoci5lbnRyeUlkKSBvbkZzKHIucGF0aCk7XG4gICAgICAgIH0pO1xuICAgICAgICB3Lm9uKFwiZXJyb3JcIiwgKCkgPT4ge1xuICAgICAgICAgIC8qIHRoZSBkaXJlY3Rvcnkgd2VudCBhd2F5OyB0aGUgbmV4dCBzeW5jIGRyb3BzIGl0ICovXG4gICAgICAgIH0pO1xuICAgICAgICB3YXRjaGVycy5zZXQoa2V5LCB3KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiB1bndhdGNoYWJsZSAoZ29uZSwgcGVybWlzc2lvbnMpIOKAlCBvdXRzaWRlIGNoYW5nZXMgdGhlcmUgZ28gdW5zZWVuICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUZpbGVFdmVudCA9IChldjogRmlsZUV2ZW50KSA9PiB7XG4gICAgc3dpdGNoIChldi5raW5kKSB7XG4gICAgICBjYXNlIFwidmVyc2lvbi5jaGFuZ2VkXCI6XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBldi50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNyZWF0ZWRcIjpcbiAgICAgICAgYW5ub3VuY2UoYHYke2V2LnZlcnNpb259IG9mICR7ZXYuZG9jfSBhcHBlYXJlZCAod3JpdHRlbiBkaXJlY3RseSB0byAke2V2LnBhdGh9KWAsIHtcbiAgICAgICAgICBmYWN0OiBcInZlcnNpb24uY3JlYXRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiYWN0aXZlLm91dHNpZGVcIjpcbiAgICAgICAgLy8gRTI6IHRoZSBhZ2VudCBuZXZlciB3cml0ZXMgdGhlIHZlcnNpb24gdGhlIGh1bWFuIGlzIGVkaXRpbmcuIFRoZVxuICAgICAgICAvLyBvdXRzaWRlIHRleHQgaXMgS0VQVCBhcyBhIG5ldyBhZ2VudCB2ZXJzaW9uIGFuZCB0aGUgYWN0aXZlIHZlcnNpb25cbiAgICAgICAgLy8ga2VlcHMgdGhlIGh1bWFuJ3MgdGV4dCDigJQgbm90aGluZyBpcyBsb3N0LCBhbmQgdGhlIGh1bWFuJ3MgYnVmZmVyIGlzXG4gICAgICAgIC8vIG5vdCB0b3VjaGVkICh2ZXJpZnktcGFzcyBmaXggNCkuXG4gICAgICAgIGFubm91bmNlT3V0c2lkZShldi5kb2MsIGV2LnZlcnNpb24sIGV2LnBhdGgsIGV2LnByZXNlcnZlZEFzLCBldi5wcmVzZXJ2ZWRQYXRoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLnJlbG9hZGVkXCI6XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBldi50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sg4oCUIHJlbG9hZGVkICh5b3UgaGFkIG5vIHVuc2F2ZWQgZWRpdHMpLmAsIHtcbiAgICAgICAgICBmYWN0OiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwuY29uZmxpY3RcIjpcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayB3aGlsZSB5b3UgaGF2ZSB1bnNhdmVkIGVkaXRzLiBTYXZlIG92ZXJ3cml0ZXMgaXQgd2l0aCB5b3VyczsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgICAgIHsgZmFjdDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGV2LmRvYyB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidHJlZVwiOlxuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGFubm91bmNlT3V0c2lkZSA9IChcbiAgICBkb2M6IHN0cmluZyxcbiAgICB2ZXJzaW9uOiBudW1iZXIsXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIHByZXNlcnZlZEFzOiBudW1iZXIsXG4gICAgcHJlc2VydmVkUGF0aDogc3RyaW5nLFxuICApID0+XG4gICAgYW5ub3VuY2UoXG4gICAgICBgdiR7dmVyc2lvbn0gb2YgJHtkb2N9IGlzIHRoZSBBQ1RJVkUgdmVyc2lvbiBhbmQgd2FzIHdyaXR0ZW4gZnJvbSBvdXRzaWRlIHRoZSBlZGl0b3IuIFRoYXQgdGV4dCBpcyBrZXB0IGFzIHYke3ByZXNlcnZlZEFzfTsgdGhlIGFjdGl2ZSB2ZXJzaW9uIGtlZXBzIHlvdXIgdGV4dC4gQWdlbnQgZWRpdHMgYmVsb25nIGluIGEgbmV3IHZlcnNpb24gKHZlcnNpb24tbmV3KS5gLFxuICAgICAgeyBmYWN0OiBcImFjdGl2ZS5vdXRzaWRlXCIsIGRvYywgdmVyc2lvbiwgcGF0aCwgcHJlc2VydmVkQXMsIHByZXNlcnZlZFBhdGggfSxcbiAgICApO1xuXG4gIC8vIC0tLSBzaGFyZWQgYWN0cyAoc3VyZmFjZSBhbmQgYWdlbnQgcmVhY2ggdGhlIHNhbWUgY29kZSkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IGFkZFBhdGhzID0gKHBhdGhzOiBzdHJpbmdbXSkgPT4ge1xuICAgIGNvbnN0IGFkZGVkID0gcGF0aHMubWFwKChwKSA9PiBzZXNzaW9uLmFkZENvbnRleHQocCkpO1xuICAgIHN5bmNXYXRjaGVycygpO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIGFkZGVkO1xuICB9O1xuXG4gIGNvbnN0IGFjdGl2YXRlID0gKGRvYzogc3RyaW5nIHwgdW5kZWZpbmVkLCB2ZXJzaW9uOiBudW1iZXIsIGJ5OiBcImh1bWFuXCIgfCBcImFnZW50XCIpID0+IHtcbiAgICBjb25zdCByID0gc2Vzc2lvbi5hY3RpdmF0ZSh7IGRvYywgdmVyc2lvbiB9KTtcbiAgICBjb25zdCB2aWV3ID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICBjb25zdCBwYXRoID0gdmlldy52ZXJzaW9ucy5maW5kKCh2KSA9PiB2Lm4gPT09IHZlcnNpb24pPy5wYXRoID8/IG51bGw7XG4gICAgc2VuZCh7XG4gICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgZG9jOiByLnNsdWcsXG4gICAgICB2ZXJzaW9uLFxuICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihyLnNsdWcsIHZlcnNpb24pLnRleHQsXG4gICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgIH0pO1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICBcInN5c3RlbVwiLFxuICAgICAgYCR7YnkgPT09IFwiYWdlbnRcIiA/IFwiQWdlbnRcIiA6IFwiWW91XCJ9IG1hZGUgdiR7dmVyc2lvbn0gb2YgJHtyLnNsdWd9IGFjdGl2ZSAod2FzIHYke3IucHJldmlvdXN9KS5gLFxuICAgICk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImFjdGl2YXRlZFwiLCBieSwgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoLCB0czogbS50cyB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCB9O1xuICB9O1xuXG4gIC8qKlxuICAgKiBFMjQ6IG9uZSBzdHJ1Y3R1cmUgY2hhbmdlLCBmcm9tIGVpdGhlciBwYXJ0eSDigJQgdGhlIHNhbWUgc2Vzc2lvbiBtZXRob2QsIHRoZVxuICAgKiBzYW1lIGFubm91bmNlbWVudCAobmFtaW5nIHdobyBkaWQgaXQpLCB0aGUgc2FtZSB0YWlsIGZhY3QuIFJldHVybnMgdGhlIHBhdGhcbiAgICogdGhlIGNoYW5nZSBsYW5kZWQgYXQsIHdoaWNoIHRoZSBzdXJmYWNlIHVzZXMgdG8gb3BlbiBvciByZW5hbWUgaXQuXG4gICAqL1xuICBjb25zdCBTVFJVQ1RVUkVfT1BTID0gbmV3IFNldDxzdHJpbmc+KFtcbiAgICBcImRvYy5jcmVhdGVcIixcbiAgICBcImZvbGRlci5jcmVhdGVcIixcbiAgICBcIm1vdmVcIixcbiAgICBcInJlbmFtZVwiLFxuICAgIFwiaGlkZVwiLFxuICAgIFwidW5oaWRlXCIsXG4gICAgXCJzZXQubWFrZVwiLFxuICAgIFwiaW1wb3J0XCIsXG4gICAgXCJ3b3Jrc3BhY2Uuc2V0XCIsXG4gIF0gc2F0aXNmaWVzIFN0cnVjdHVyZU9wW1widHlwZVwiXVtdKTtcbiAgY29uc3QgaXNTdHJ1Y3R1cmVPcCA9IChtOiB7IHR5cGU6IHN0cmluZyB9KTogbSBpcyBTdHJ1Y3R1cmVPcCA9PiBTVFJVQ1RVUkVfT1BTLmhhcyhtLnR5cGUpO1xuXG4gIGNvbnN0IHN0cnVjdHVyZSA9IChvcDogU3RydWN0dXJlT3AsIGJ5OiBcImh1bWFuXCIgfCBcImFnZW50XCIpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgY29uc3Qgd2hvID0gYnkgPT09IFwiYWdlbnRcIiA/IFwiQWdlbnRcIiA6IFwiWW91XCI7XG4gICAgY29uc3Qgc2hvd24gPSAocDogc3RyaW5nKSA9PiBzZXNzaW9uLmRpc3BsYXkocCk7XG4gICAgbGV0IHI6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyBwYXRoPzogc3RyaW5nIH07XG4gICAgbGV0IGxpbmU6IHN0cmluZztcbiAgICBzd2l0Y2ggKG9wLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJkb2MuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZURvYyhvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImZvbGRlci5jcmVhdGVcIjpcbiAgICAgICAgciA9IHNlc3Npb24uY3JlYXRlRm9sZGVyKG9wLmRpciwgb3AubmFtZSk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNyZWF0ZWQgdGhlIGZvbGRlciAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtb3ZlXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ubW92ZShvcC5wYXRoLCBvcC5pbnRvKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IG1vdmVkICR7c2hvd24obS5mcm9tKX0gdG8gJHtzaG93bihtLnBhdGgpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZW5hbWVcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5yZW5hbWUob3AucGF0aCwgb3AubmFtZSk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSByZW5hbWVkICR7c2hvd24obS5mcm9tKX0gdG8gJHtzaG93bihtLnBhdGgpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJoaWRlXCI6IHtcbiAgICAgICAgY29uc3QgaCA9IHNlc3Npb24uaGlkZShvcC5wYXRoKTtcbiAgICAgICAgciA9IGg7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHJlbW92ZWQgJHtzaG93bihoLnBhdGgpfSBmcm9tIFNjcmlwdG9yaXVtICh0aGUgZmlsZSBpcyBzdGlsbCBvbiBkaXNrKS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ1bmhpZGVcIjoge1xuICAgICAgICBjb25zdCB1ID0gc2Vzc2lvbi51bmhpZGUob3AuZW50cnkpO1xuICAgICAgICByID0gdTtcbiAgICAgICAgbGluZSA9IGAke3dob30gYnJvdWdodCBiYWNrICR7dS5yZXN0b3JlZH0gaGlkZGVuIGl0ZW0ke3UucmVzdG9yZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNldC5tYWtlXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ubWFrZVNldChvcC5wYXRoKTtcbiAgICAgICAgciA9IG07XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHR1cm5lZCAke2Jhc2VuYW1lKG0ucGF0aCl9IGludG8gYSBzZXQ6ICR7c2hvd24obS5mb2xkZXIpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJpbXBvcnRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uaW1wb3J0VGV4dChvcC5uYW1lLCBvcC50ZXh0LCBvcC5pbnRvKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY29waWVkICR7b3AubmFtZX0gaW4gYXMgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwid29ya3NwYWNlLnNldFwiOlxuICAgICAgICByID0gc2Vzc2lvbi5zZXRXb3Jrc3BhY2Uob3AucGF0aCk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IHNldCB0aGUgd29ya3NwYWNlIHRvICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICBhbm5vdW5jZShsaW5lLCB7IGZhY3Q6IG9wLnR5cGUsIGJ5LCAuLi5yIH0pO1xuICAgIHJldHVybiByO1xuICB9O1xuXG4gIC8vIC0tLSBzdXJmYWNlIG1lc3NhZ2VzIChXZWJTb2NrZXQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHJlcGx5ID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIHRyeSB7XG4gICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KG1zZykpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSAqL1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVDbGllbnRNc2cgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogQ2xpZW50TXNnKSA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AobXNnKSkge1xuICAgICAgY29uc3QgciA9IHN0cnVjdHVyZShhbmNob3JTdXJmYWNlUGF0aHMobXNnKSwgXCJodW1hblwiKTtcbiAgICAgIGlmICh0eXBlb2Ygci5wYXRoID09PSBcInN0cmluZ1wiKVxuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcInN0cnVjdHVyZS5kb25lXCIsIG9wOiBtc2cudHlwZSwgcGF0aDogci5wYXRoIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwib3BlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm9wZW5QYXRoKG1zZy5wYXRoKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIC8vIFRoZSBvcGVuZXIgZ2V0cyB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IHN0cmFpZ2h0IGF3YXkg4oCUIHRoZSBzdGF0ZVxuICAgICAgICAvLyBzbmFwc2hvdCBjYXJyaWVzIG5vIHRleHRzLCBhbmQgYSB2aWV3ZXIgbXVzdCBub3Qgd2FpdCBvbiBhIHNlY29uZCBhc2suXG4gICAgICAgIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyLmNyZWF0ZWQpXG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvYy5vcGVuZWRcIiwgZG9jOiByLnNsdWcsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChyLnNsdWcpIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwib3Blbi5kb2NcIjpcbiAgICAgICAgc2Vzc2lvbi5vcGVuU2x1Zyhtc2cuZG9jKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0KG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBtc2cudGV4dCk7XG4gICAgICAgIGlmIChyLnByZXNlcnZlZCkge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhtc2cuZG9jKTtcbiAgICAgICAgICBhbm5vdW5jZU91dHNpZGUoXG4gICAgICAgICAgICBkLnNsdWcsXG4gICAgICAgICAgICBtc2cudmVyc2lvbixcbiAgICAgICAgICAgIHNlc3Npb24uYWN0aXZlUGF0aChkLnNsdWcpID8/IFwiXCIsXG4gICAgICAgICAgICByLnByZXNlcnZlZC5uLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQucGF0aCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHIuZGlydHlDaGFuZ2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VsZWN0XCI6XG4gICAgICAgIC8vIEFNQklFTlQgc3RhdGU6IHN0b3JlZCBhbmQgc2hvd24sIG5ldmVyIHB1c2hlZCBvbnRvIHRoZSBhZ2VudCdzIHRhaWwuXG4gICAgICAgIHNlbGVjdGlvbiA9IG1zZy5zZWxlY3Rpb247XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCB0ZXh0ID0gbXNnLnRleHQudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2VsID0gbXNnLndpdGhTZWxlY3Rpb24gPyBzZWxlY3Rpb24gOiBudWxsO1xuICAgICAgICBjb25zdCBhY3RpdmVQYXRoID0gc2VsID8gc2Vzc2lvbi5hY3RpdmVQYXRoKHNlbC5kb2MpIDogc2Vzc2lvbi5hY3RpdmVQYXRoKCk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJodW1hblwiLCB0ZXh0LCB7IHNlbGVjdGlvbjogc2VsLCBhY3RpdmVQYXRoIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgbWVzc2FnZV9pZDogbS5pZCxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2Yoc2VsPy5kb2MpLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIGFjdGl2YXRlKG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBcImh1bWFuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwic2F2ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnNhdmUobXNnLmRvYyk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgYFNhdmVkIHYke3IudmVyc2lvbn0gdG8gJHtyLm9yaWdpbmFsfS5gKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwic2F2ZWRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIG9yaWdpbmFsOiByLm9yaWdpbmFsLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJldmVydFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJldmVydChtc2cuZG9jKTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFJldmVydGVkIHYke3IudmVyc2lvbn0gb2YgJHttc2cuZG9jfSB0byB0aGUgc2F2ZWQgZmlsZS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwicmV2ZXJ0ZWRcIiwgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiByLnZlcnNpb24sIHRzOiBtLnRzIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjpcbiAgICAgICAgYWRkUGF0aHMoW3N1cmZhY2VQYXRoKG1zZy5wYXRoKV0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwicmV2ZWFsXCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHNlc3Npb24uc2hvd25QYXRoKHN1cmZhY2VQYXRoKG1zZy5wYXRoKSk7XG4gICAgICAgIC8vIEFuIGFyZ3YsIG5ldmVyIGEgc2hlbGwgc3RyaW5nOiB0aGUgcGF0aCBpcyBkYXRhLCB3aGF0ZXZlciBpdCBob2xkcy5cbiAgICAgICAgY29uc3QgW2NtZCwgLi4uYXJnc10gPVxuICAgICAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCJcbiAgICAgICAgICAgID8gW1wib3BlblwiLCBcIi1SXCIsIHBhdGhdXG4gICAgICAgICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICAgICAgICA/IFtcImV4cGxvcmVyXCIsIGAvc2VsZWN0LCR7cGF0aH1gXVxuICAgICAgICAgICAgICA6IFtcInhkZy1vcGVuXCIsIGRpcm5hbWUocGF0aCldO1xuICAgICAgICBCdW4uc3Bhd24oW2NtZCBhcyBzdHJpbmcsIC4uLmFyZ3NdLCB7IHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0gfSkudW5yZWYoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQucmVtb3ZlXCI6XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ29udGV4dChtc2cuaWQpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJlYWRcIjoge1xuICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IG1zZy52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24obXNnLmRvYywgbXNnLnZlcnNpb24pLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwcmVmcy5zZXRcIjoge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVBSRUZfS0VZLnRlc3QobXNnLmtleSkgfHxcbiAgICAgICAgICB0eXBlb2YgbXNnLnZhbHVlICE9PSBcInN0cmluZ1wiIHx8XG4gICAgICAgICAgbXNnLnZhbHVlLmxlbmd0aCA+IFBSRUZfVkFMVUVfTUFYXG4gICAgICAgIClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfWApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFByZWZzKCk7XG4gICAgICAgIGlmIChjdXJyZW50W21zZy5rZXldID09PSBtc2cudmFsdWUpIHJldHVybjtcbiAgICAgICAgaWYgKCEobXNnLmtleSBpbiBjdXJyZW50KSAmJiBPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGggPj0gUFJFRl9LRVlTX01BWClcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgcmVmdXNlZCBwcmVmICR7SlNPTi5zdHJpbmdpZnkobXNnLmtleSl9OiAke1BSRUZfS0VZU19NQVh9IGtleXMgYWxyZWFkeSBrZXB0YCxcbiAgICAgICAgICApO1xuICAgICAgICB3cml0ZUZpbGVBdG9taWMoXG4gICAgICAgICAgcHJlZnNGaWxlLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgLi4uY3VycmVudCwgW21zZy5rZXldOiBtc2cudmFsdWUgfSwgbnVsbCwgMil9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZzLmxpc3RcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gZXhwYW5kSG9tZShtc2cucGF0aCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJmcy5saXN0XCIsIHBhdGg6IG1zZy5wYXRoLCBlbnRyaWVzOiBsaXN0RGlyKHBhdGgpIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZnMubGlzdFwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBlbnRyaWVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYWN0aXZlT2YgPSAoZG9jPzogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qgc2x1ZyA9IGRvYyA/PyBzZXNzaW9uLm9wZW5Eb2NTbHVnO1xuICAgIGlmICghc2x1ZykgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBzZXNzaW9uLmRvYyhzbHVnKTtcbiAgICAgIHJldHVybiB7IGRvYzogdi5zbHVnLCB2ZXJzaW9uOiB2LmFjdGl2ZSwgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHYuc2x1ZykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gYWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgYWRkZWQgPSBhZGRQYXRocyhjbWQucGF0aHMpO1xuICAgICAgICByZXR1cm4geyBlbnRyaWVzOiBhZGRlZC5tYXAoKGEpID0+ICh7IC4uLmEuZW50cnksIGFkZGVkOiBhLmFkZGVkIH0pKSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24ubmV3XCI6IHtcbiAgICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCA3OiB0aGUgYWdlbnQgbWF5IG5hbWUgYSBkb2MgdGhlIGh1bWFuIGhhcyBub3RcbiAgICAgICAgLy8gb3BlbmVkLCBieSBBQlNPTFVURSBwYXRoICh0aGUgQ0xJIHJlc29sdmVzIGl0IGFnYWluc3QgaXRzIG93biBjd2QpO1xuICAgICAgICAvLyBpdCBpcyBvcGVuZWQgaW1wbGljaXRseSB1bmRlciB0aGUgc2FtZSBhZG1pc3Npb24gcnVsZSBhcyB0aGVcbiAgICAgICAgLy8gc3VyZmFjZSdzIGBvcGVuYCDigJQgYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkg4oCUIHdpdGhvdXRcbiAgICAgICAgLy8gbW92aW5nIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAgICAgIGlmIChjbWQuZG9jICYmIGlzQWJzb2x1dGUoY21kLmRvYykgJiYgIXNlc3Npb24uZmluZERvYyhjbWQuZG9jKSkge1xuICAgICAgICAgIGNvbnN0IG8gPSBzZXNzaW9uLm9wZW5QYXRoKGNtZC5kb2MsIHsgZm9jdXM6IGZhbHNlIH0pO1xuICAgICAgICAgIGlmIChvLmNyZWF0ZWQpXG4gICAgICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9jLm9wZW5lZFwiLFxuICAgICAgICAgICAgICBkb2M6IG8uc2x1ZyxcbiAgICAgICAgICAgICAgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKG8uc2x1ZyksXG4gICAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IGNtZC5kb2MsXG4gICAgICAgICAgZnJvbTogY21kLmZyb20sXG4gICAgICAgICAgbGFiZWw6IGNtZC5sYWJlbCxcbiAgICAgICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBjcmVhdGVkIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke2NtZC5sYWJlbCA/IGAg4oCUICR7Y21kLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiwgZnJvbTogci52ZXJzaW9uLmZyb20sIHBhdGg6IHIudmVyc2lvbi5wYXRoIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImFnZW50XCIsIGNtZC50ZXh0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgaWQ6IG0uaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICByZXR1cm4gYWN0aXZhdGUoY21kLmRvYywgY21kLnZlcnNpb24sIFwiYWdlbnRcIik7XG4gICAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KChjbWQgYXMgeyB0eXBlPzogdW5rbm93biB9KS50eXBlKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgICBbXCJjb250ZXh0LmFkZFwiLCBcInZlcnNpb24ubmV3XCIsIFwic2F5XCIsIFwiYWN0aXZhdGVcIiwgXCJjbG9zZVwiLCAuLi5TVFJVQ1RVUkVfT1BTXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgbG9nLmVtaXQoeyB0eXBlOiBcInJlYWR5XCIsIG1vZGUsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiAob3B0cy50aW1lb3V0UyA/PyAxODAwKSAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICB9KTtcblxuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lIOKAlCBmaW5lICovXG4gICAgfVxuICAgIHVubGlua0lmTWF0Y2hlcyhsYXRlc3RGaWxlLCBzZXNzaW9uSWQsIChyYXcpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlkID0gKEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiB1bmtub3duIH0pLnNlc3Npb25faWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGhlIG9yZGVyIGlzIHRoZSBoZWFkZXIncywgYW5kIHRoZSBoZWFkZXIgc2F5cyB3aHkuXG4gIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2F0Y2hlcnMudmFsdWVzKCkpIHcuY2xvc2UoKTtcbiAgICB3YXRjaGVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdCBvZiBwZW5kaW5nLnZhbHVlcygpKSBjbGVhclRpbWVvdXQodCk7XG4gICAgdHJ5IHtcbiAgICAgIHNlc3Npb24ucGVyc2lzdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgY2xlYW51cERpc2NvdmVyeSgpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJjbG9zZWRcIiB9KTtcbiAgICB2b2lkIGRyYWluQW5kU3RvcCh7IHNlcnZlciwgY2xpZW50czogc3NlQ2xpZW50cywgc29ja2V0cyB9KS50aGVuKHJlc29sdmVTaHV0ZG93bik7XG4gIH07XG4gIGRvbmUudGhlbigoKSA9PiBjbG9zZSgpKTtcblxuICByZXR1cm4geyBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25JZCwgbW9kZSwgZGlyOiBzZXNzaW9uLmRpciwgY2xvc2UsIGRvbmUsIHNodXRkb3duIH07XG59XG5cbi8qKiBBbiBhYnNlbnQgT3JpZ2luICh0aGUgQ0xJLCBjdXJsKSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlOyBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtZU9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBjb25zdCBvcmlnaW4gPSByZXEuaGVhZGVycy5nZXQoXCJvcmlnaW5cIik7XG4gIGlmIChvcmlnaW4gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gb3JpZ2luID09PSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCB8fCBvcmlnaW4gPT09IGBodHRwOi8vbG9jYWxob3N0OiR7cG9ydH1gO1xufVxuXG4vKipcbiAqIEEgcGF0aCB0eXBlZCBpbiB0aGUgU1VSRkFDRS4gVGhlIHBhZ2UgaGFzIG5vIHdvcmtpbmcgZGlyZWN0b3J5LCBzbyBhIHBhdGhcbiAqIGZyb20gaXQgbXVzdCBiZSBhYnNvbHV0ZSBvciBzdGFydCBhdCBgfmAg4oCUIHdoaWNoIGlzIGV4cGFuZGVkIEhFUkUuIEJlZm9yZVxuICogdGhpcywgYH4vRG9jdW1lbnRzYCByZWFjaGVkIGByZXNvbHZlKClgIGFuZCB3YXMgdGFrZW4gYXMgcmVsYXRpdmUgdG8gdGhlXG4gKiBkYWVtb24ncyBjd2QgKHRoZSBza2lsbCBmb2xkZXIpOiB0aGUgcGF0aCBib3ggY29tcGxldGVkIGB+L+KApmAgKGxpc3RpbmdcbiAqIGV4cGFuZHMgaXQpIGFuZCB0aGVuIEVudGVyIGZhaWxlZCB3aXRoIFwibm8gc3VjaCBmaWxlIG9yIGZvbGRlcjpcbiAqIOKApi9za2lsbHMvc2NyaXB0b3JpdW0vfi9Eb2N1bWVudHMv4oCmXCIgKENvbGUsIDIwMjYtMDktMTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VyZmFjZVBhdGgocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHAudHJpbSgpO1xuICBpZiAodCA9PT0gXCJ+XCIgfHwgdC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBleHBhbmRIb21lKHQpO1xuICBpZiAoIWlzQWJzb2x1dGUodCkpXG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke3B9XCIgaXMgbm90IGEgZnVsbCBwYXRoIOKAlCBzdGFydCBpdCB3aXRoIC8gb3Igfi9gLCA0MDApO1xuICByZXR1cm4gcmVzb2x2ZSh0KTtcbn1cblxuLyoqIEEgc3RydWN0dXJlIG9wIGZyb20gdGhlIHN1cmZhY2UsIHdpdGggZXZlcnkgcGF0aCBmaWVsZCB0aHJvdWdoIGBzdXJmYWNlUGF0aGAuICovXG5mdW5jdGlvbiBhbmNob3JTdXJmYWNlUGF0aHMob3A6IFN0cnVjdHVyZU9wKTogU3RydWN0dXJlT3Age1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5vcCB9O1xuICBmb3IgKGNvbnN0IGsgb2YgW1wiZGlyXCIsIFwicGF0aFwiLCBcImludG9cIl0gYXMgY29uc3QpXG4gICAgaWYgKHR5cGVvZiBvdXRba10gPT09IFwic3RyaW5nXCIpIG91dFtrXSA9IHN1cmZhY2VQYXRoKG91dFtrXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gb3V0IGFzIFN0cnVjdHVyZU9wO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB3b3Jrc3BhY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgICAgd29ya3NwYWNlOiBmbGFncy53b3Jrc3BhY2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IGEgY2xlYW4gY2xvc2UgbGVhdmVzIG5vIGVtcHR5IGxvZyBiZWhpbmQuXG4gIGlmIChyZXMuY29kZSA9PT0gMCAmJiBmbGFncy5sb2cpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHN0YXRTeW5jKGZsYWdzLmxvZykuc2l6ZSA9PT0gMCkgdW5saW5rU3luYyhmbGFncy5sb2cpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG4gIHJldHVybiByZXMuY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGVcbiAqIGJ1bmRsZSwgc28gdGhlcmUgaXMgbm8gc3VjaCBibG9jayBoZXJlLCBhbmQgdGhpcyB0YWtlcyBubyBhcmd1bWVudHM6IHRoZVxuICogY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvKipcbiAqIFRoZSBzZXNzaW9uIOKAlCB0aGUgZGFlbW9uJ3Mgc3RhdGUsIGFuZCB0aGUgb25seSBjb2RlIHRoYXQgd3JpdGVzIGEgZmlsZS5cbiAqXG4gKiBFOCdzIHNoYXBlLCB0aGUgaG91c2UncyBcIm1hdGVyaWFsaXplZCBwYXRoXCIgcGF0dGVybjogdGhlIGRhZW1vbiBvd25zIHRoZVxuICogc2Vzc2lvbiAoY29udGV4dCwgZG9jcywgdmVyc2lvbnMsIHdoaWNoIGlzIGFjdGl2ZSwgdGhlIGNoYXQpIGFuZCBwZXJzaXN0cyBpdFxuICogYXMgYG1hbmlmZXN0Lmpzb25gOyBldmVyeSB2ZXJzaW9uJ3MgVEVYVCBpcyBhIGZpbGUgaW4gdGhlIHNlc3Npb24gZm9sZGVyLCBzb1xuICogdGhlIGFnZW50IGVkaXRzIHZlcnNpb25zIHdpdGggaXRzIG93biBmaWxlIHRvb2xzLlxuICpcbiAqICAgICAkU0NSSVBUT1JJVU1fSE9NRS9zZXNzaW9ucy88c2Vzc2lvbklkPi9cbiAqICAgICAgIG1hbmlmZXN0Lmpzb24gICAgICAgICAgICAgIHdyaXR0ZW4gYXRvbWljYWxseSwgb24gZXZlcnkgY2hhbmdlXG4gKiAgICAgICBkb2NzLzxzbHVnPi92MS5tZCwgdjIubWQgICBvbmUgZmlsZSBwZXIgdmVyc2lvblxuICpcbiAqIFRoZSB0aHJlZSB3cml0ZSBydWxlcywgZWFjaCBhIGRlY2lzaW9uIHJhdGhlciB0aGFuIGEgaGFiaXQ6XG4gKlxuICogLSAqKlRoZSBvcmlnaW5hbCBpcyB3cml0dGVuIE9OTFkgYnkgYHNhdmVgKiogKEU3KS4gT3BlbmluZyBjb3BpZXMgaXQgdG8gdjE7XG4gKiAgIG5vdGhpbmcgZWxzZSB0b3VjaGVzIGl0LlxuICogLSAqKkV2ZXJ5IHdyaXRlIHRoaXMgbW9kdWxlIG1ha2VzIGlzIHJlbWVtYmVyZWQgYnkgY29udGVudCBoYXNoKiogKHRoZVxuICogICBgb3duZWRgIG1hcCkgc28gdGhlIHdhdGNoZXIgY2FuIHRlbGwgdGhlIGRhZW1vbidzIG93biB3cml0ZXMgZnJvbSBhbnlvbmVcbiAqICAgZWxzZSdzIChpbnZlc3RpZ2F0aW9uIMKnNSkuIEEgd3JpdGUgdG8gdGhlIEFDVElWRSB2ZXJzaW9uIHRoYXQgaXMgbm90IG91cnNcbiAqICAgaXMgYW4gRTIgdmlvbGF0aW9uIHRoZSBkYWVtb24gYW5ub3VuY2VzLlxuICogLSAqKlRoZSBhZ2VudCBuZXZlciB3cml0ZXMgdGhlIGFjdGl2ZSB2ZXJzaW9uKiogKEUyKSDigJQgZW5mb3JjZWQgc29jaWFsbHkgYnlcbiAqICAgU0tJTEwubWQgYW5kIGRldGVjdGVkIGhlcmUsIG5vdCBwcmV2ZW50ZWQ6IHRoZSBmaWxlIGlzIHRoZSBhZ2VudCdzIG1lZGl1bS5cbiAqXG4gKiBOb3RoaW5nIGhlcmUga25vd3MgYWJvdXQgc29ja2V0cywgSFRUUCBvciB0aGUgZXZlbnQgbG9nLiBUaGUgZGFlbW9uIGNhbGxzIGFcbiAqIG1ldGhvZCwgZ2V0cyBhIHJlc3VsdCwgYW5kIGRlY2lkZXMgd2hhdCB0byBicm9hZGNhc3Q7IHRoYXQgc3BsaXQgaXMgd2hhdFxuICogbGV0cyB0aGUgdW5pdCBjZWxscyBkcml2ZSB0aGUgd2hvbGUgbW9kZWwgd2l0aCBhIHRlbXAgaG9tZS5cbiAqL1xuXG5pbXBvcnQge1xuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgc3RhdFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHR5cGUge1xuICBDaGF0TWVzc2FnZSxcbiAgQ2hhdFdobyxcbiAgQ29udGV4dEVudHJ5LFxuICBEb2NWaWV3LFxuICBQdWJsaWNTdGF0ZSxcbiAgU2VsZWN0aW9uLFxuICBWZXJzaW9uLFxuICBWZXJzaW9uQXV0aG9yLFxufSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHtcbiAgRE9DX0VYVEVOU0lPTlMsXG4gIGVudHJ5Rm9yUGF0aCxcbiAgZmluZE5vZGUsXG4gIGlzRG9jTmFtZSxcbiAgbG9jYXRlLFxuICBNSVJST1JfTk9ERV9DQVAsXG4gIHNjYW5UcmVlLFxuICB0b1Bvc2l4LFxufSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCBjb25zdCBNQU5JRkVTVF9GT1JNQVQgPSAxO1xuXG50eXBlIERvY1JlY29yZCA9IHtcbiAgc2x1Zzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIG9yaWdpbmFsOiBzdHJpbmc7XG4gIGVudHJ5SWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlbDogc3RyaW5nIHwgbnVsbDtcbiAgZXh0OiBzdHJpbmc7XG4gIHZlcnNpb25zOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPltdO1xuICBhY3RpdmU6IG51bWJlcjtcbiAgLyoqIEhhc2ggb2YgdGhlIG9yaWdpbmFsIGFzIHdlIGxhc3QgcmVhZCBvciB3cm90ZSBpdCDigJQgYXQgb3Blbiwgc2F2ZSwgcmV2ZXJ0XG4gICAqICBhbmQgcmVsb2FkIOKAlCBzbyBhIHJlc3RvcmUgY2FuIHRlbGwgdGhhdCBpdCBjaGFuZ2VkIHdoaWxlIG5vIGRhZW1vbiB3YXNcbiAgICogIHdhdGNoaW5nICh2ZXJpZnktcGFzcyBmaXggMikuICovXG4gIG9yaWdpbmFsSGFzaDogc3RyaW5nO1xuICAvKiogU2V0IG9ubHkgYnkgYG9wZW5QYXRoYCwgd2hpY2ggYWRtaXRzIGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqICBlbnRyeS4gYHNhdmVgIHdyaXRlcyBubyBvcmlnaW5hbCB0aGF0IGxhY2tzIGl0ICh2ZXJpZnktcGFzcyBmaXggMWMpLiAqL1xuICBhZG1pdHRlZD86IGJvb2xlYW47XG4gIG91dHNpZGVDaGFuZ2VkOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIGZvcm1hdDogbnVtYmVyO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGNvbnRleHQ6IENvbnRleHRFbnRyeVtdO1xuICBkb2NzOiBEb2NSZWNvcmRbXTtcbiAgb3BlbkRvYzogc3RyaW5nIHwgbnVsbDtcbiAgY2hhdDogQ2hhdE1lc3NhZ2VbXTtcbiAgLyoqIEUyMydzIHdvcmtzcGFjZS4gQWJzZW50IGluIGEgbWFuaWZlc3Qgd3JpdHRlbiBiZWZvcmUgaXQgZXhpc3RlZDogdGhlIHVzZXIncyBob21lLiAqL1xuICB3b3Jrc3BhY2U/OiBzdHJpbmc7XG59O1xuXG4vKiogQSByZWZ1c2FsIHRoZSBkYWVtb24gdHVybnMgaW50byBhbiBIVFRQIHN0YXR1cyDigJQgYGNob2ljZXNgIHdoZW4gdGhlIHNldCBpcyBpbiBoYW5kIChBMSkuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvbkVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgc3RhdHVzOiA0MDAgfCA0MDQgfCA0MDksXG4gICAgcmVhZG9ubHkgY2hvaWNlcz86IHN0cmluZ1tdLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgY29udGVudEhhc2ggPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IEJ1bi5oYXNoKHRleHQpLnRvU3RyaW5nKDE2KTtcblxuY29uc3QgcmFuZEhleCA9IChuOiBudW1iZXIpID0+XG4gIEFycmF5LmZyb20oY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhuZXcgVWludDhBcnJheShuKSkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxuICAgIC5qb2luKFwiXCIpO1xuXG5leHBvcnQgY29uc3QgbmV3U2Vzc2lvbklkID0gKCk6IHN0cmluZyA9PiByYW5kSGV4KDQpO1xuXG4vKiogQSBwYXRoJ3MgcmVhbHBhdGgsIG9yIHRoZSBwYXRoIGl0c2VsZiB3aGVuIGl0IGNhbm5vdCBiZSByZXNvbHZlZCAoZ29uZSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhbE9yKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWxwYXRoU3luYyhwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHA7XG4gIH1cbn1cblxuLyoqIFdoYXQgYSB3YXRjaGVyIGV2ZW50IHR1cm5lZCBvdXQgdG8gYmUuIGBudWxsYCA9IG5vdGhpbmcgKG91cnMsIG9yIG5vIGNoYW5nZSkuICovXG5leHBvcnQgdHlwZSBGaWxlRXZlbnQgPVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBhY3RpdmU6IGZhbHNlIH1cbiAgfCB7XG4gICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCI7XG4gICAgICBkb2M6IHN0cmluZztcbiAgICAgIHZlcnNpb246IG51bWJlcjtcbiAgICAgIHBhdGg6IHN0cmluZztcbiAgICAgIC8qKiBUaGUgbmV3IGFnZW50IHZlcnNpb24gdGhlIG91dHNpZGUgdGV4dCB3YXMgcHJlc2VydmVkIGFzLiAqL1xuICAgICAgcHJlc2VydmVkQXM6IG51bWJlcjtcbiAgICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZztcbiAgICB9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiOyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInRyZWVcIjsgZW50cnlJZDogc3RyaW5nIH07XG5cbmV4cG9ydCBjbGFzcyBTZXNzaW9uIHtcbiAgcmVhZG9ubHkgZGlyOiBzdHJpbmc7XG4gIHByaXZhdGUgbTogTWFuaWZlc3Q7XG4gIC8qKiBwYXRoIOKGkiBoYXNoIG9mIHRoZSBkYWVtb24ncyBsYXN0IHdyaXRlIHRvIGl0LiAqL1xuICBwcml2YXRlIG93bmVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIGhhc2ggb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgY3VycmVudCB0ZXh0LiAqL1xuICBwcml2YXRlIGFjdGl2ZUhhc2ggPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBhcyB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgKG9yIGFkb3B0ZWQpXG4gICAqICBpdCDigJQgd2hhdCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBpcyByZXZlcnRlZCB0by4gKi9cbiAgcHJpdmF0ZSBsYXN0QWN0aXZlVGV4dCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBXaGF0IGEgcmVzdG9yZSBmb3VuZCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy4gKi9cbiAgcmVzdG9yZUZpbmRpbmdzOiB7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nOyBtaXNzaW5nOiBib29sZWFuIH1bXSA9IFtdO1xuXG4gIHByaXZhdGUgY29uc3RydWN0b3IoXG4gICAgcmVhZG9ubHkgaG9tZTogc3RyaW5nLFxuICAgIG1hbmlmZXN0OiBNYW5pZmVzdCxcbiAgKSB7XG4gICAgdGhpcy5tID0gbWFuaWZlc3Q7XG4gICAgdGhpcy5kaXIgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgbWFuaWZlc3Quc2Vzc2lvbklkKTtcbiAgfVxuXG4gIHN0YXRpYyBjcmVhdGUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyA9IG5ld1Nlc3Npb25JZCgpLCB3b3Jrc3BhY2U/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgICAgLi4uKHdvcmtzcGFjZSA/IHsgd29ya3NwYWNlOiByZXNvbHZlKHdvcmtzcGFjZSkgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIC8qKiBSZWxvYWQgYSBzZXNzaW9uIGZyb20gaXRzIG1hbmlmZXN0IChgb3BlbiAtLXJlc3RvcmUgPGlkPmApLiAqL1xuICBzdGF0aWMgcmVzdG9yZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBzZXNzaW9uSWQsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHNhdmVkIHNlc3Npb24gJHtzZXNzaW9uSWR9YCwgNDA0KTtcbiAgICBjb25zdCBtID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBNYW5pZmVzdDtcbiAgICBpZiAobS5mb3JtYXQgIT09IE1BTklGRVNUX0ZPUk1BVClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHNlc3Npb24gJHtzZXNzaW9uSWR9IGhhcyBtYW5pZmVzdCBmb3JtYXQgJHttLmZvcm1hdH1gLCA0MDkpO1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCBtKTtcbiAgICBta2RpclN5bmMoam9pbihzLmRpciwgXCJkb2NzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBNaXJyb3JzIGFyZSByZS1yZWFkLCBub3QgdHJ1c3RlZDogdGhlIGZvbGRlciBtYXkgaGF2ZSBjaGFuZ2VkIHdoaWxlIG5vXG4gICAgLy8gZGFlbW9uIHdhcyB3YXRjaGluZyBpdC5cbiAgICBmb3IgKGNvbnN0IGUgb2Ygcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgcy5yZXNjYW4oZS5pZCk7XG4gICAgZm9yIChjb25zdCBkIG9mIHMubS5kb2NzKSB7XG4gICAgICBjb25zdCBwID0gcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgICBjb25zdCB0ZXh0ID0gZXhpc3RzU3luYyhwKSA/IHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIikgOiBcIlwiO1xuICAgICAgcy5hZG9wdEFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMjogYW4gb3JpZ2luYWwgY2hhbmdlZCB3aGlsZSB0aGUgc2Vzc2lvbiB3YXMgY2xvc2VkXG4gICAgICAvLyB3YXMgaW52aXNpYmxlIGhlcmUsIHNvIHRoZSBuZXh0IFNhdmUgb3Zlcndyb3RlIGl0IHVuYW5ub3VuY2VkLiBUaGVcbiAgICAgIC8vIG1hbmlmZXN0IGhvbGRzIHRoZSBvcmlnaW5hbCdzIGhhc2ggYXMgb2YgdGhlIGxhc3Qgb3Blbi9zYXZlL3JldmVydC9cbiAgICAgIC8vIHJlbG9hZDsgYSBkaWZmZXJlbnQgaGFzaCBub3cgaXMgYW4gb3V0c2lkZSBjaGFuZ2UsIG1hcmtlZCBleGFjdGx5IGFzIGFcbiAgICAgIC8vIGxpdmUgb25lIHdpdGggYSBkaXJ0eSBidWZmZXIgaXMg4oCUIGFza2VkLCBuZXZlciBtZXJnZWQgb3IgcmVsb2FkZWQuXG4gICAgICBsZXQgbm93OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgIG5vdyA9IGNvbnRlbnRIYXNoKHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIikpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIG5vdyA9IG51bGw7XG4gICAgICB9XG4gICAgICBpZiAobm93ID09PSBudWxsIHx8IG5vdyAhPT0gZC5vcmlnaW5hbEhhc2gpIHtcbiAgICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICAgIHMucmVzdG9yZUZpbmRpbmdzLnB1c2goeyBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwsIG1pc3Npbmc6IG5vdyA9PT0gbnVsbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHMucmVzdG9yZUZpbmRpbmdzLmxlbmd0aCA+IDApIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgc3RhdGljIGxpc3RTYXZlZChob21lOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpLmZpbHRlcigoaWQpID0+XG4gICAgICAgIGV4aXN0c1N5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIsIGlkLCBcIm1hbmlmZXN0Lmpzb25cIikpLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gIH1cblxuICBnZXQgaWQoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLnNlc3Npb25JZDtcbiAgfVxuXG4gIGdldCBkb2NzRGlyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kaXIsIFwiZG9jc1wiKTtcbiAgfVxuXG4gIGdldCBvcGVuRG9jU2x1ZygpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5tLm9wZW5Eb2M7XG4gIH1cblxuICBnZXQgY29udGV4dCgpOiByZWFkb25seSBDb250ZXh0RW50cnlbXSB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0O1xuICB9XG5cbiAgLyoqXG4gICAqIEV2ZXJ5IGRpcmVjdG9yeSB0aGUgd2F0Y2hlciBtdXN0IHNlZTogdGhlIHNlc3Npb24ncyBkb2NzLCBlYWNoIGVudHJ5IHJvb3QsXG4gICAqIGFuZCB0aGUgUkVBTCBkaXJlY3Rvcnkgb2YgZXZlcnkgb3BlbmVkIG9yaWdpbmFsLlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDM6IGVhY2ggcm9vdCBpcyB3YXRjaGVkIGF0IGl0cyBSRUFMUEFUSCAoYHdhdGNoYCksIGFuZFxuICAgKiBhbiBldmVudCBpcyByZXBvcnRlZCB1bmRlciB0aGUgcGF0aCBmb3JtIHRoZSBzZXNzaW9uIHN0b3JlcyAoYHBhdGhgKS4gQVxuICAgKiB3YXRjaCBvbiBhIHN5bWxpbmtlZCBkaXJlY3Rvcnkg4oCUIGEgc3ltbGlua2VkIGhvbWUsIGEgc3ltbGlua2VkIGZvbGRlclxuICAgKiBlbnRyeSDigJQgb3Igb24gdGhlIGxpbmsncyBvd24gZGlyZWN0b3J5IGZvciBhIHN5bWxpbmtlZCBvcmlnaW5hbCBzYXdcbiAgICogbm90aGluZyB3aGVuIHRoZSBUQVJHRVQgY2hhbmdlZCAoRlNFdmVudHMgcmVwb3J0cyByZWFsIHBhdGhzKS4gQSBzeW1saW5rZWRcbiAgICogb3JpZ2luYWwgaXMgbWF0Y2hlZCBiYWNrIHRvIGl0cyBkb2MgYnkgcmVhbHBhdGggaW4gYG9uRmlsZUV2ZW50YC5cbiAgICovXG4gIHdhdGNoUm9vdHMoKTogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10ge1xuICAgIGNvbnN0IHJvb3RzOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSA9IFtcbiAgICAgIHsgcGF0aDogdGhpcy5kb2NzRGlyLCB3YXRjaDogcmVhbE9yKHRoaXMuZG9jc0RpciksIHJlY3Vyc2l2ZTogdHJ1ZSB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KVxuICAgICAgcm9vdHMucHVzaCh7XG4gICAgICAgIHBhdGg6IGUucm9vdCxcbiAgICAgICAgd2F0Y2g6IHJlYWxPcihlLnJvb3QpLFxuICAgICAgICByZWN1cnNpdmU6IGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiLFxuICAgICAgICBlbnRyeUlkOiBlLmlkLFxuICAgICAgfSk7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCByZWFsRGlyID0gZGlybmFtZShyZWFsT3IoZC5vcmlnaW5hbCkpO1xuICAgICAgaWYgKFxuICAgICAgICAhcm9vdHMuc29tZSgocikgPT4gci53YXRjaCA9PT0gcmVhbERpciAmJiByLnJlY3Vyc2l2ZSA9PT0gZmFsc2UpICYmXG4gICAgICAgICFyb290cy5zb21lKFxuICAgICAgICAgIChyKSA9PiByLnJlY3Vyc2l2ZSAmJiAocmVhbERpciA9PT0gci53YXRjaCB8fCByZWFsRGlyLnN0YXJ0c1dpdGgoci53YXRjaCArIHNlcCkpLFxuICAgICAgICApXG4gICAgICApXG4gICAgICAgIHJvb3RzLnB1c2goeyBwYXRoOiByZWFsRGlyLCB3YXRjaDogcmVhbERpciwgcmVjdXJzaXZlOiBmYWxzZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJvb3RzO1xuICB9XG5cbiAgLy8g4pSA4pSAIHBlcnNpc3RlbmNlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHBlcnNpc3QoKTogdm9pZCB7XG4gICAgbWtkaXJTeW5jKHRoaXMuZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVBdG9taWMoam9pbih0aGlzLmRpciwgXCJtYW5pZmVzdC5qc29uXCIpLCBgJHtKU09OLnN0cmluZ2lmeSh0aGlzLm0sIG51bGwsIDIpfVxcbmApO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZU93bmVkKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgbWtkaXJTeW5jKGRpcm5hbWUocGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIFJlbWVtYmVyIEJFRk9SRSB3cml0aW5nOiB0aGUgd2F0Y2hlcidzIGV2ZW50IGNhbiBhcnJpdmUgYmVmb3JlIHRoaXNcbiAgICAvLyBmdW5jdGlvbiByZXR1cm5zLCBhbmQgaXQgbXVzdCBmaW5kIHRoZSBoYXNoIGFscmVhZHkgdGhlcmUuXG4gICAgdGhpcy5vd25lZC5zZXQocGF0aCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgdGV4dCk7XG4gIH1cblxuICBwcml2YXRlIGFkb3B0QWN0aXZlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcCA9IHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpO1xuICAgIHRoaXMub3duZWQuc2V0KHAsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlQWN0aXZlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCB0ZXh0KTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gIH1cblxuICAvKiogS2VlcCBhbiBvdXRzaWRlIHdyaXRlIHRvIHRoZSBhY3RpdmUgdmVyc2lvbiBhcyBhIE5FVyBhZ2VudCB2ZXJzaW9uLiAqL1xuICBwcml2YXRlIHByZXNlcnZlT3V0c2lkZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IFZlcnNpb24ge1xuICAgIGNvbnN0IG4gPSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICBmcm9tOiBkLmFjdGl2ZSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGxhYmVsOiBgb3V0c2lkZSB3cml0ZSB0byB2JHtkLmFjdGl2ZX1gLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9O1xuICB9XG5cbiAgLyoqIFRydWUgaWZmIGB0ZXh0YCBhdCBgcGF0aGAgaXMgZXhhY3RseSB3aGF0IHRoZSBkYWVtb24gbGFzdCB3cm90ZSB0aGVyZS4gKi9cbiAgaXNPd25Xcml0ZShwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLm93bmVkLmdldChwYXRoKSA9PT0gY29udGVudEhhc2godGV4dCk7XG4gIH1cblxuICAvLyDilIDilIAgY29udGV4dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhZGRDb250ZXh0KHJhd1BhdGg6IHN0cmluZyk6IHsgZW50cnk6IENvbnRleHRFbnRyeTsgYWRkZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBjb25zdCBwcm9iZSA9IGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKTtcbiAgICBjb25zdCBzYW1lID0gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLnJvb3QgPT09IHByb2JlLnJvb3QgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBwcm9iZS5tZW1iZXJzaGlwICYmXG4gICAgICAgIChwcm9iZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgfHxcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSA9PT0gSlNPTi5zdHJpbmdpZnkocHJvYmUubm9kZXMpKSxcbiAgICApO1xuICAgIGlmIChzYW1lKSByZXR1cm4geyBlbnRyeTogc2FtZSwgYWRkZWQ6IGZhbHNlIH07XG4gICAgdGhpcy5tLmNvbnRleHQucHVzaChwcm9iZSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogcHJvYmUsIGFkZGVkOiB0cnVlIH07XG4gIH1cblxuICByZW1vdmVDb250ZXh0KGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpID0gdGhpcy5tLmNvbnRleHQuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gICAgaWYgKGkgPCAwKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYG5vIGNvbnRleHQgZW50cnkgJHtpZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoZSkgPT4gZS5pZCksXG4gICAgICApO1xuICAgIHRoaXMubS5jb250ZXh0LnNwbGljZShpLCAxKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgb3BlbiBkb2N1bWVudCBsZWZ0IHRoZSBjb250ZXh0IChpdHMgZW50cnkgcmVtb3ZlZCwgb3IgdGhlIGRvY3VtZW50XG4gICAqIGhpZGRlbik6IGNsb3NlIGl0IGluIHRoZSB2aWV3LiBJdHMgdmVyc2lvbnMgc3RheSBpbiB0aGUgc2Vzc2lvbiDigJQgbm90aGluZ1xuICAgKiBpcyBkZWxldGVkIOKAlCBhbmQgYnJpbmdpbmcgaXQgYmFjayBhbmQgb3BlbmluZyBpdCBhZ2FpbiBmaW5kcyB0aGVtLlxuICAgKi9cbiAgcHJpdmF0ZSBjbG9zZU9ycGhhbmVkT3BlbkRvYygpOiB2b2lkIHtcbiAgICBjb25zdCBvcGVuID0gdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICBpZiAob3BlbiAmJiBvcGVuLmVudHJ5SWQgPT09IG51bGwpIHRoaXMubS5vcGVuRG9jID0gbnVsbDtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QsIE1JUlJPUl9OT0RFX0NBUCwgZS5oaWRkZW4pO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjaG9pY2VzID0gdGhpcy5tLmRvY3MubWFwKChkKSA9PiBkLnNsdWcpO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICAvLyDim5QgT05MWSBBTiBBQlNPTFVURSBrZXkgaXMgYSBwYXRoICh2ZXJpZnktcGFzcyBmaXggOCk6IHJlc29sdmluZyBhXG4gICAgLy8gcmVsYXRpdmUgb25lIGhlcmUgcmVzb2x2ZWQgaXQgYWdhaW5zdCB0aGUgREFFTU9OJ3MgY3dkLiBUaGUgQ0xJIHJlc29sdmVzXG4gICAgLy8gYWdhaW5zdCBpdHMgb3duIGN3ZCBhbmQgc2VuZHMgYW4gYWJzb2x1dGUgcGF0aC5cbiAgICBpZiAoaXNBYnNvbHV0ZShrZXkpKSB7XG4gICAgICBjb25zdCBieVBhdGggPSB0aGlzLm0uZG9jcy5maW5kKFxuICAgICAgICAoZCkgPT4gZC5vcmlnaW5hbCA9PT0ga2V5IHx8IHJlYWxPcihkLm9yaWdpbmFsKSA9PT0gcmVhbE9yKGtleSksXG4gICAgICApO1xuICAgICAgaWYgKGJ5UGF0aCkgcmV0dXJuIGJ5UGF0aDtcbiAgICB9XG4gICAgY29uc3QgYnlOYW1lID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiBiYXNlbmFtZShkLm9yaWdpbmFsKSA9PT0ga2V5IHx8IGQucmVsID09PSBrZXkpO1xuICAgIHJldHVybiBieU5hbWUubGVuZ3RoID09PSAxID8gYnlOYW1lWzBdIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgcHJpdmF0ZSB2ZXJzaW9uT3JEaWUoZDogRG9jUmVjb3JkLCBuOiBudW1iZXIpOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiB7XG4gICAgY29uc3QgdiA9IGQudmVyc2lvbnMuZmluZCgoeCkgPT4geC5uID09PSBuKTtcbiAgICBpZiAoIXYpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyB2JHtufWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgZC52ZXJzaW9ucy5tYXAoKHgpID0+IGB2JHt4Lm59YCksXG4gICAgICApO1xuICAgIHJldHVybiB2O1xuICB9XG5cbiAgcHJpdmF0ZSBzbHVnRm9yKG9yaWdpbmFsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHN0ZW0gPVxuICAgICAgYmFzZW5hbWUob3JpZ2luYWwsIGV4dG5hbWUob3JpZ2luYWwpKVxuICAgICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgICAucmVwbGFjZSgvW15hLXowLTlfLV0rL2csIFwiLVwiKVxuICAgICAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKSB8fCBcImRvY1wiO1xuICAgIGxldCBzbHVnID0gc3RlbTtcbiAgICBmb3IgKGxldCBpID0gMjsgdGhpcy5tLmRvY3Muc29tZSgoZCkgPT4gZC5zbHVnID09PSBzbHVnKTsgaSsrKSBzbHVnID0gYCR7c3RlbX0tJHtpfWA7XG4gICAgcmV0dXJuIHNsdWc7XG4gIH1cblxuICAvKipcbiAgICogT3BlbiBhIGRvY3VtZW50IGJ5IGl0cyBvcmlnaW5hbCdzIHBhdGg6IHYxIGlzIHdyaXR0ZW4gZnJvbSB0aGUgb3JpZ2luYWxcbiAgICogdGhlIGZpcnN0IHRpbWUuIGBmb2N1czogZmFsc2VgICh0aGUgYWdlbnQncyBpbXBsaWNpdCBvcGVuIHRocm91Z2hcbiAgICogYHZlcnNpb24tbmV3IC0tZG9jIDxwYXRoPmApIGRvZXMgbm90IG1vdmUgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICpcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCAxYiDigJQgQURNSVNTSU9OLiBPbmx5IGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqIGVudHJ5IGlzIGFkbWl0dGVkOyBgY29udGV4dC5hZGRgIHN0YXlzIHRoZSBvbmUgd2F5IGluLiBCZWZvcmUgdGhpcywgYW55XG4gICAqIHBhdGggb2YgYW55IHR5cGUgd2FzIG9wZW5lZCwgYW5kIFNhdmUgdGhlbiB3cm90ZSBpdDogYSBmb3JlaWduIHdlYiBwYWdlXG4gICAqIHdyb3RlIGBjdXJsIGV2aWwgfCBzaGAgaW50byBhIGAucmNgIGZpbGUgb3V0c2lkZSB0aGUgY29udGV4dC5cbiAgICovXG4gIG9wZW5QYXRoKHJhd1BhdGg6IHN0cmluZywgb3B0czogeyBmb2N1cz86IGJvb2xlYW4gfSA9IHt9KTogeyBzbHVnOiBzdHJpbmc7IGNyZWF0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgZm9jdXMgPSBvcHRzLmZvY3VzID8/IHRydWU7XG4gICAgLy8gVGhlIGNvbnRleHQncyBvd24gc3BlbGxpbmcgb2YgdGhlIHBhdGg6IGEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhIHJlYWxwYXRoXG4gICAgLy8gKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBvciB0aHJvdWdoIGEgc3ltbGlua2VkIGZvbGRlcikgbmFtZXMgdGhlIHNhbWVcbiAgICAvLyBmaWxlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIGRvYy5cbiAgICBjb25zdCBhYnMgPSB0aGlzLmNhbm9uaWNhbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IGFicyk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZXhpc3Rpbmcuc2x1ZztcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsgc2x1ZzogZXhpc3Rpbmcuc2x1ZywgY3JlYXRlZDogZmFsc2UgfTtcbiAgICB9XG4gICAgaWYgKCFpc0RvY05hbWUoYWJzKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7YWJzfWAsIDQwMCk7XG4gICAgaWYgKCFsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicykpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHthYnN9IGlzIG5vdCBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0IOKAlCBhZGQgaXQgKG9yIGl0cyBmb2xkZXIpIGZpcnN0YCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXN0YXRTeW5jKGFicykuaXNGaWxlKCkpIHRocm93IG5ldyBFcnJvcihcIm5vdCBhIGZpbGVcIik7XG4gICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgY2Fubm90IG9wZW4gJHthYnN9OiBubyBzdWNoIGZpbGVgLCA0MDQpO1xuICAgIH1cbiAgICBjb25zdCBleHQgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXS5pbmNsdWRlcyhleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKSlcbiAgICAgID8gZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKClcbiAgICAgIDogXCIubWRcIjtcbiAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKTtcbiAgICBjb25zdCBkOiBEb2NSZWNvcmQgPSB7XG4gICAgICBzbHVnOiB0aGlzLnNsdWdGb3IoYWJzKSxcbiAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICBvcmlnaW5hbDogYWJzLFxuICAgICAgZW50cnlJZDogYXQ/LmVudHJ5SWQgPz8gbnVsbCxcbiAgICAgIHJlbDogYXQ/LnJlbCA/PyBudWxsLFxuICAgICAgZXh0LFxuICAgICAgdmVyc2lvbnM6IFt7IG46IDEsIGF1dGhvcjogXCJodW1hblwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfV0sXG4gICAgICBhY3RpdmU6IDEsXG4gICAgICBvcmlnaW5hbEhhc2g6IGNvbnRlbnRIYXNoKHRleHQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGZhbHNlLFxuICAgICAgYWRtaXR0ZWQ6IHRydWUsXG4gICAgfTtcbiAgICB0aGlzLm0uZG9jcy5wdXNoKGQpO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGQuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIGNyZWF0ZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBgYWJzYCBhcyB0aGUgY29udGV4dCBzcGVsbHMgaXQsIHdoZW4gaXQgaXMgdGhlIHNhbWUgZmlsZSBieSByZWFscGF0aC4gKi9cbiAgcHJpdmF0ZSBjYW5vbmljYWwoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicykpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmICghcmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgY29udGludWU7XG4gICAgICBjb25zdCBzcGVsbGVkID0gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBzcGVsbGVkKSkgcmV0dXJuIHNwZWxsZWQ7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBvcGVuU2x1ZyhzbHVnOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLm0ub3BlbkRvYyA9IHRoaXMuZG9jT3JEaWUoc2x1Zykuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIHJlYWRWZXJzaW9uKHNsdWc6IHN0cmluZywgbjogbnVtYmVyKTogeyB0ZXh0OiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBuKTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBuKTtcbiAgICByZXR1cm4geyB0ZXh0OiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLCBwYXRoIH07XG4gIH1cblxuICBhY3RpdmVQYXRoKHNsdWc/OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBkID0gc2x1ZyA/IHRoaXMuZmluZERvYyhzbHVnKSA6IHRoaXMubS5vcGVuRG9jID8gdGhpcy5maW5kRG9jKHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gZCA/IHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpIDogbnVsbDtcbiAgfVxuXG4gIC8qKiBUaGUgaHVtYW4ncyBidWZmZXIgcmVhY2hlcyB0aGUgQUNUSVZFIHZlcnNpb24ncyBmaWxlIChkZWJvdW5jZWQgYnkgdGhlIHN1cmZhY2UpLiAqL1xuICAvKipcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCA0IOKAlCBDSEVDSyBCRUZPUkUgV1JJVEUuIEJlZm9yZSB0aGUgaHVtYW4ncyBlZGl0IGlzXG4gICAqIHdyaXR0ZW4sIHRoZSBmaWxlIG9uIGRpc2sgaXMgaGFzaGVkOiBpZiBpdCBpcyBub3QgdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAqIHdyaXRlLCBzb21lb25lIGVsc2Ugd3JvdGUgdGhlIGFjdGl2ZSB2ZXJzaW9uIChFMikuIFRoYXQgdGV4dCBpcyBrZXB0IGFzIGFcbiAgICogTkVXIGFnZW50IHZlcnNpb24sIGFuZCBvbmx5IHRoZW4gaXMgdGhlIGVkaXQgd3JpdHRlbi4gRGV0ZWN0aW9uIHVzZWQgdG9cbiAgICogZGVwZW5kIG9uIHRoZSB3YXRjaGVyJ3MgNjAgbXMgc2V0dGxlIHRpbWVyIGZpcmluZyBiZWZvcmUgdGhlIG5leHRcbiAgICoga2V5c3Ryb2tlOyBhIGJ1cnN0IG9mIGVkaXRzIGF0IDMwIG1zIGNsb2JiZXJlZCBhbiBvdXRzaWRlIHdyaXRlXG4gICAqIHVuYW5ub3VuY2VkLiBOb3cgbm90aGluZyBpcyBsb3N0IHdoYXRldmVyIHRoZSB0aW1pbmcg4oCUIHRoZSBvbmUgd2luZG93IGxlZnRcbiAgICogaXMgdGhlIG1pY3Jvc2Vjb25kcyBiZXR3ZWVuIHRoaXMgcmVhZCBhbmQgdGhpcyB3cml0ZS5cbiAgICovXG4gIGVkaXQoXG4gICAgc2x1Zzogc3RyaW5nLFxuICAgIG46IG51bWJlcixcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICk6IHsgZGlydHlDaGFuZ2VkOiBib29sZWFuOyBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGlmIChuICE9PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtufSBpcyBub3QgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSAodiR7ZC5hY3RpdmV9IGlzKSDigJQgb25seSB0aGUgYWN0aXZlIHZlcnNpb24gaXMgZWRpdGFibGVgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHRoaXMuaXNEaXJ0eShkKTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBuKTtcbiAgICAvLyBUaGUgZWRpdCBpcyBzdGFnZWQgaW4gYSBzaWJsaW5nIGZpbGUgRklSU1QsIHNvIHRoZSBjaGVjayBiZWxvdyBhbmQgdGhlXG4gICAgLy8gcmVuYW1lIHRoYXQgbGFuZHMgdGhlIGVkaXQgYXJlIGFkamFjZW50IHN5c2NhbGxzOiB0aGUgd2luZG93IGluIHdoaWNoIGFuXG4gICAgLy8gb3V0c2lkZSB3cml0ZSBjb3VsZCBzbGlwIGJldHdlZW4gdGhlbSBpcyBtaWNyb3NlY29uZHMsIG5vdCB0aGUgbGVuZ3RoIG9mXG4gICAgLy8gYSBtdWx0aS1tZWdhYnl0ZSB3cml0ZSDigJQgYW5kIGEgd3JpdGUgbGFuZGluZyBBRlRFUiB0aGUgcmVuYW1lIGdvZXMgdG8gdGhlXG4gICAgLy8gbmV3IGZpbGUsIHdoZXJlIHRoZSB3YXRjaGVyIGZpbmRzIGl0IGFuZCBwcmVzZXJ2ZXMgaXQgdG9vLlxuICAgIGNvbnN0IHN0YWdlZCA9IGAke3BhdGh9LiR7cHJvY2Vzcy5waWR9LmVkaXRgO1xuICAgIHdyaXRlRmlsZVN5bmMoc3RhZ2VkLCB0ZXh0KTtcbiAgICBsZXQgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IG9uRGlzazogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIG9uRGlzayA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICBvbkRpc2sgPSBudWxsO1xuICAgIH1cbiAgICBpZiAob25EaXNrICE9PSBudWxsICYmICF0aGlzLmlzT3duV3JpdGUocGF0aCwgb25EaXNrKSlcbiAgICAgIHByZXNlcnZlZCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIG9uRGlzayk7XG4gICAgdGhpcy5vd25lZC5zZXQocGF0aCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHJlbmFtZVN5bmMoc3RhZ2VkLCBwYXRoKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gICAgcmV0dXJuIHsgZGlydHlDaGFuZ2VkOiBiZWZvcmUgIT09IHRoaXMuaXNEaXJ0eShkKSwgcHJlc2VydmVkIH07XG4gIH1cblxuICAvKiogQ29weSBhIHZlcnNpb24gdG8gYSBuZXcgZmlsZTsgdGhlIGFnZW50IHRoZW4gZWRpdHMgdGhhdCBmaWxlIHdpdGggaXRzIG93biB0b29scy4gKi9cbiAgbmV3VmVyc2lvbihvcHRzOiB7IGRvYz86IHN0cmluZzsgZnJvbT86IG51bWJlcjsgbGFiZWw/OiBzdHJpbmc7IGF1dGhvcjogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBWZXJzaW9uO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgZnJvbSA9IG9wdHMuZnJvbSA/PyBkLmFjdGl2ZTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBmcm9tKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZnJvbSksIFwidXRmOFwiKTtcbiAgICBjb25zdCBuID0gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogb3B0cy5hdXRob3IsXG4gICAgICBmcm9tLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgLi4uKG9wdHMubGFiZWwgPyB7IGxhYmVsOiBvcHRzLmxhYmVsIH0gOiB7fSksXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCB2ZXJzaW9uOiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9IH07XG4gIH1cblxuICBhY3RpdmF0ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0pOiB7IHNsdWc6IHN0cmluZzsgcHJldmlvdXM6IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IGQuYWN0aXZlO1xuICAgIGQuYWN0aXZlID0gb3B0cy52ZXJzaW9uO1xuICAgIC8vIFRoZSBuZXcgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IEFTIElUIElTIE5PVyBpcyB0aGUgYmFzZWxpbmUgdGhlIG5leHRcbiAgICAvLyBjaGVjay1iZWZvcmUtd3JpdGUgY29tcGFyZXMgYWdhaW5zdC5cbiAgICB0aGlzLmFkb3B0QWN0aXZlKGQsIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHByZXZpb3VzIH07XG4gIH1cblxuICAvKiogU2F2ZTogdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBvdmVyIHRoZSBvcmlnaW5hbC4gVGhlIE9OTFkgd3JpdGUgdG8gaXQgKEU3KS4gKi9cbiAgc2F2ZShzbHVnOiBzdHJpbmcpOiB7IG9yaWdpbmFsOiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDFjOiBTYXZlIHdyaXRlcyBvbmx5IGFuIG9yaWdpbmFsIGFkbWl0dGVkIGJ5XG4gICAgLy8gYG9wZW5QYXRoYCAoYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkpLiBDaGVja2VkIGFnYWluIGhlcmVcbiAgICAvLyBzbyBubyBvdGhlciBwYXRoIGludG8gdGhlIG1hbmlmZXN0IOKAlCBhIGhhbmQtZWRpdGVkIG9uZSwgYSBmdXR1cmUgdmVyYiDigJRcbiAgICAvLyBjYW4gdHVybiBTYXZlIGludG8gXCJ3cml0ZSBhbnkgZmlsZVwiLlxuICAgIGlmICghZC5hZG1pdHRlZCB8fCAhaXNEb2NOYW1lKGQub3JpZ2luYWwpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHJlZnVzaW5nIHRvIHNhdmUgJHtkLm9yaWdpbmFsfTogaXQgd2FzIG5vdCBvcGVuZWQgZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHRoaXMud3JpdGVPd25lZChkLm9yaWdpbmFsLCB0ZXh0KTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBvcmlnaW5hbDogZC5vcmlnaW5hbCwgdmVyc2lvbjogZC5hY3RpdmUgfTtcbiAgfVxuXG4gIC8qKiBSZXZlcnQ6IHRoZSBvcmlnaW5hbCdzIHRleHQgYmFjayBvdmVyIHRoZSBhY3RpdmUgdmVyc2lvbi4gKi9cbiAgcmV2ZXJ0KHNsdWc6IHN0cmluZyk6IHsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyB2ZXJzaW9uOiBkLmFjdGl2ZSwgdGV4dCB9O1xuICB9XG5cbiAgcHJpdmF0ZSBpc0RpcnR5KGQ6IERvY1JlY29yZCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAodGhpcy5hY3RpdmVIYXNoLmdldChkLnNsdWcpID8/IFwiXCIpICE9PSBkLm9yaWdpbmFsSGFzaDtcbiAgfVxuXG4gIC8vIOKUgOKUgCB0aGUgd2F0Y2hlcidzIHF1ZXN0aW9uOiB3aG9zZSB3cml0ZSB3YXMgdGhhdD8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIENsYXNzaWZ5IG9uZSBmaWxlc3lzdGVtIGV2ZW50LiBSZWFkcyB0aGUgZmlsZTsgcmV0dXJucyBgbnVsbGAgd2hlbiBpdCBpc1xuICAgKiB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlLCB1bmNoYW5nZWQsIGdvbmUsIG9yIG5vdCBvdXJzIHRvIGNhcmUgYWJvdXQuXG4gICAqL1xuICBvbkZpbGVFdmVudChhYnM6IHN0cmluZyk6IEZpbGVFdmVudCB8IG51bGwge1xuICAgIC8vIEEgdmVyc2lvbiBmaWxlIHVuZGVyIGRvY3MvPHNsdWc+L3ZOLmV4dD9cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy5kb2NzRGlyICsgc2VwKSkge1xuICAgICAgY29uc3QgcmVzdCA9IGFicy5zbGljZSh0aGlzLmRvY3NEaXIubGVuZ3RoICsgMSkuc3BsaXQoc2VwKTtcbiAgICAgIGlmIChyZXN0Lmxlbmd0aCAhPT0gMikgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBbc2x1ZywgZmlsZV0gPSByZXN0IGFzIFtzdHJpbmcsIHN0cmluZ107XG4gICAgICBjb25zdCBkID0gdGhpcy5tLmRvY3MuZmluZCgoeCkgPT4geC5zbHVnID09PSBzbHVnKTtcbiAgICAgIGNvbnN0IG1hdGNoID0gL152KFxcZCspKFxcLlthLXpdKykkLy5leGVjKGZpbGUpO1xuICAgICAgaWYgKCFkIHx8ICFtYXRjaCB8fCBtYXRjaFsyXSAhPT0gZC5leHQpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgbiA9IE51bWJlcihtYXRjaFsxXSk7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLmlzT3duV3JpdGUoYWJzLCB0ZXh0KSkgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIWQudmVyc2lvbnMuc29tZSgodikgPT4gdi5uID09PSBuKSkge1xuICAgICAgICAvLyBUaGUgYWdlbnQgd3JvdGUgYSB2ZXJzaW9uIGZpbGUgYnkgaGFuZCByYXRoZXIgdGhhbiB0aHJvdWdoXG4gICAgICAgIC8vIGB2ZXJzaW9uLW5ld2Ag4oCUIGFkb3B0IGl0IHJhdGhlciB0aGFuIGxlYXZlIGEgZmlsZSB0aGUgc3VyZmFjZSBjYW5ub3Qgc2VlLlxuICAgICAgICBkLnZlcnNpb25zLnB1c2goeyBuLCBhdXRob3I6IFwiYWdlbnRcIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH0pO1xuICAgICAgICBkLnZlcnNpb25zLnNvcnQoKGEsIGIpID0+IGEubiAtIGIubik7XG4gICAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHBhdGg6IGFicyB9O1xuICAgICAgfVxuICAgICAgaWYgKG4gPT09IGQuYWN0aXZlKSB7XG4gICAgICAgIC8vIEUyLCByZWZ1c2VkIGFuZCBSRS1MQUJFTExFRDogdGhlIG91dHNpZGUgdGV4dCBiZWNvbWVzIGEgbmV3IGFnZW50XG4gICAgICAgIC8vIHZlcnNpb24sIGFuZCB0aGUgYWN0aXZlIHZlcnNpb24gZ29lcyBiYWNrIHRvIHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgICAgICAvLyB0ZXh0IOKAlCBzbyB0aGUgYWN0aXZlIHZlcnNpb24gb25seSBldmVyIGhvbGRzIHdoYXQgdGhlIGh1bWFuIHR5cGVkLFxuICAgICAgICAvLyBhbmQgbm90aGluZyBhbnlvbmUgd3JvdGUgaXMgbG9zdCAodmVyaWZ5LXBhc3MgZml4IDQsIHdhdGNoZXIgaGFsZikuXG4gICAgICAgIGNvbnN0IGtlcHQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCB0ZXh0KTtcbiAgICAgICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0aGlzLmxhc3RBY3RpdmVUZXh0LmdldChkLnNsdWcpID8/IHRleHQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBuLFxuICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICBwcmVzZXJ2ZWRBczoga2VwdC5uLFxuICAgICAgICAgIHByZXNlcnZlZFBhdGg6IGtlcHQucGF0aCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHRleHQsIGFjdGl2ZTogZmFsc2UgfTtcbiAgICB9XG5cbiAgICAvLyBBbiBvcGVuZWQgb3JpZ2luYWwg4oCUIGJ5IGl0cyBzdG9yZWQgcGF0aCwgb3IgYnkgcmVhbHBhdGggZm9yIGEgc3ltbGluaz9cbiAgICBjb25zdCBkID0gdGhpcy5tLmRvY3MuZmluZCgoeCkgPT4geC5vcmlnaW5hbCA9PT0gYWJzIHx8IHJlYWxPcih4Lm9yaWdpbmFsKSA9PT0gYWJzKTtcbiAgICBpZiAoZCkge1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBjb25zdCBoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgICBpZiAoaCA9PT0gZC5vcmlnaW5hbEhhc2gpIHJldHVybiBudWxsOyAvLyBvdXIgb3duIHNhdmUsIG9yIG5vIGNoYW5nZVxuICAgICAgY29uc3QgY2xlYW4gPSAhdGhpcy5pc0RpcnR5KGQpO1xuICAgICAgaWYgKGNsZWFuKSB7XG4gICAgICAgIGQub3JpZ2luYWxIYXNoID0gaDtcbiAgICAgICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAoZC5vdXRzaWRlQ2hhbmdlZCkgcmV0dXJuIG51bGw7IC8vIGFscmVhZHkgYXNrZWRcbiAgICAgIGQub3V0c2lkZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCB9O1xuICAgIH1cblxuICAgIC8vIFNvbWV0aGluZyB1bmRlciBhIG1pcnJvcmVkIHJvb3Q6IHRoZSB0cmVlIG1heSBoYXZlIGNoYW5nZWQuXG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSB7XG4gICAgICAgIHJldHVybiB0aGlzLnJlc2NhbihlLmlkKSA/IHsga2luZDogXCJ0cmVlXCIsIGVudHJ5SWQ6IGUuaWQgfSA6IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8g4pSA4pSAIHN0cnVjdHVyZSAoRTIy4oCTRTI0KTogcmVhbCBjaGFuZ2VzIG9uIGRpc2ssIG9uZSBwYXRoIGZvciBib3RoIHBhcnRpZXMg4pSA4pSAXG4gIC8vXG4gIC8vIEV2ZXJ5IG1ldGhvZCBiZWxvdyBkb2VzIHRoZSBjaGFuZ2UgT04gRElTSyBhbmQgdGhlbiBicmluZ3MgdGhlIGNvbnRleHRcbiAgLy8gbW9kZWwgYmFjayBpbiBsaW5lIHdpdGggaXQuIFRoZSBzdXJmYWNlIHJlYWNoZXMgdGhlbSB0aHJvdWdoIG1lbnVzIGFuZFxuICAvLyBkcmFnIGFuZCBkcm9wLCB0aGUgYWdlbnQgdGhyb3VnaCBDTEkgdmVyYnM7IHRoZSBkYWVtb24gYW5ub3VuY2VzIGVhY2ggb25lXG4gIC8vIHVuZGVyIHRoZSBuYW1lIG9mIHdob2V2ZXIgZGlkIGl0LiBUd28gcnVsZXMgaG9sZCB0aHJvdWdob3V0OlxuICAvL1xuICAvLyAtIE5PVEhJTkcgSVMgREVMRVRFRC4gYGhpZGVgIHRha2VzIGEgbm9kZSBvdXQgb2YgU2NyaXB0b3JpdW07IHRoZSBmaWxlIHN0YXlzLlxuICAvLyAtIE5PVEhJTkcgSVMgT1ZFUldSSVRURU4uIEEgZGVzdGluYXRpb24gdGhhdCBleGlzdHMgaXMgcmVmdXNlZCAoYW4gZXhwbGljaXRcbiAgLy8gICBuYW1lKSBvciBnaXZlbiBhIGZyZWUgbmFtZSAoYSBkZWZhdWx0IG9uZSwgYSBkcm9wKTsgZmlsZXMgYXJlIGNyZWF0ZWRcbiAgLy8gICB3aXRoIHRoZSBleGNsdXNpdmUgZmxhZywgc28gYSByYWNlIGNhbm5vdCBjbG9iYmVyIGVpdGhlci5cblxuICAvKiogRTIzOiB3aGVyZSBkcm9wcyBhbmQgbmV3IHRvcC1sZXZlbCBkb2N1bWVudHMgbGFuZC4gKi9cbiAgZ2V0IHdvcmtzcGFjZSgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0ud29ya3NwYWNlID8/IGhvbWVkaXIoKTtcbiAgfVxuXG4gIHNldFdvcmtzcGFjZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIHN1Y2ggZm9sZGVyOiAke2Fic31gLCA0MDQpO1xuICAgIH1cbiAgICBpZiAoIWlzRGlyKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGB0aGUgd29ya3NwYWNlIG11c3QgYmUgYSBmb2xkZXI6ICR7YWJzfWAsIDQwMCk7XG4gICAgdGhpcy5tLndvcmtzcGFjZSA9IGFicztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIb3cgYSBwYXRoIHJlYWRzIGluIGEgY2hhdCBsaW5lOiBgc2V0L3JlbGAgaW5zaWRlIGEgc2V0LCBhIHNpbmdsZVxuICAgKiBkb2N1bWVudCdzIGZpbGUgbmFtZSwgYHdvcmtzcGFjZS/igKZgIGluIHRoZSB3b3Jrc3BhY2UsIGVsc2UgYH4v4oCmYC5cbiAgICovXG4gIGRpc3BsYXkoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSB7XG4gICAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIGUubGFiZWw7XG4gICAgICAgIGlmIChhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSByZXR1cm4gYCR7ZS5sYWJlbH0vJHt0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSl9YDtcbiAgICAgIH0gZWxzZSBpZiAoZS5ub2Rlcy5zb21lKChuKSA9PiBqb2luKGUucm9vdCwgbi5yZWwpID09PSBhYnMpKSByZXR1cm4gZS5sYWJlbDtcbiAgICB9XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMud29ya3NwYWNlICsgc2VwKSlcbiAgICAgIHJldHVybiBgd29ya3NwYWNlLyR7dG9Qb3NpeChyZWxhdGl2ZSh0aGlzLndvcmtzcGFjZSwgYWJzKSl9YDtcbiAgICBjb25zdCBob21lID0gaG9tZWRpcigpO1xuICAgIHJldHVybiBhYnMgPT09IGhvbWUgPyBcIn5cIiA6IGFicy5zdGFydHNXaXRoKGhvbWUgKyBzZXApID8gYH4ke2Ficy5zbGljZShob21lLmxlbmd0aCl9YCA6IGFicztcbiAgfVxuXG4gIC8qKlxuICAgKiBgYWJzYCBzcGVsbGVkIHRoZSB3YXkgdGhlIGNvbnRleHQgc3BlbGxzIGl0LiBBIGNhbGxlciB3aG9zZSBjd2QgaXMgYVxuICAgKiByZWFscGF0aCAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIGEgc3ltbGlua2VkIGZvbGRlcikgbmFtZXMgdGhlIHNhbWVcbiAgICogcGxhY2UgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgbm9kZS5cbiAgICovXG4gIHByaXZhdGUgc3BlbGwoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLm0uY29udGV4dC5zb21lKChlKSA9PiBhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKHJlYWwgPT09IHJlYWxSb290KSByZXR1cm4gZS5yb290O1xuICAgICAgaWYgKHJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIHJldHVybiBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIHByaXZhdGUgaXNXb3Jrc3BhY2UoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gYWJzID09PSB0aGlzLndvcmtzcGFjZSB8fCByZWFsT3IoYWJzKSA9PT0gcmVhbE9yKHRoaXMud29ya3NwYWNlKTtcbiAgfVxuXG4gIC8qKiBUaGUgbWlycm9yZWQgZW50cnkgdGhhdCBjb3ZlcnMgYGFic2AgKGl0cyByb290LCBvciBhbnl0aGluZyB1bmRlciBpdCksIGlmIGFueS4gKi9cbiAgcHJpdmF0ZSBjb3ZlcmluZ0VudHJ5KGFiczogc3RyaW5nLCBleGNlcHQ/OiBzdHJpbmcpOiBDb250ZXh0RW50cnkgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUuaWQgIT09IGV4Y2VwdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJlxuICAgICAgICAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSksXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBIGZvbGRlciB0aGluZ3MgbWF5IGJlIG1hZGUgaW4gb3IgbW92ZWQgaW50bzogYSBtaXJyb3JlZCBlbnRyeSdzIHJvb3QsIGFcbiAgICogdmlzaWJsZSBmb2xkZXIgdW5kZXIgb25lLCBvciB0aGUgd29ya3NwYWNlLiBSZXR1cm5zIHRoZSBhYnNvbHV0ZSBmb2xkZXI7XG4gICAqIHJlZnVzZXMgYW55dGhpbmcgZWxzZSDigJQgdGhlIGNvbnRleHQgc3RheXMgdGhlIHdheSBpbiAodmVyaWZ5LXBhc3MgZml4IDFiKS5cbiAgICovXG4gIHByaXZhdGUgZGVzdGluYXRpb25PckRpZShyYXdEaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd0RpcikpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSBjb250aW51ZTtcbiAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIGFicztcbiAgICAgIGlmIChhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShlLm5vZGVzLCB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkpO1xuICAgICAgICBpZiAobm9kZT8ua2luZCA9PT0gXCJncm91cFwiKSByZXR1cm4gYWJzO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAodGhpcy5pc1dvcmtzcGFjZShhYnMpKSByZXR1cm4gdGhpcy53b3Jrc3BhY2U7XG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgIGAke2Fic30gaXMgbm90IGEgZm9sZGVyIGluIHRoaXMgc2Vzc2lvbiDigJQgbmFtZSBhIHNldCwgYSBmb2xkZXIgaW5zaWRlIG9uZSwgb3IgdGhlIHdvcmtzcGFjZSAoJHt0aGlzLndvcmtzcGFjZX0pYCxcbiAgICAgIDQwMCxcbiAgICApO1xuICB9XG5cbiAgLyoqIEEgZG9jdW1lbnQgb3IgZm9sZGVyIHNob3duIGluIHRoZSBjb250ZXh0LCB3aXRoIHdoZXJlIGl0IGlzIHNob3duLiAqL1xuICBwcml2YXRlIGl0ZW1PckRpZShyYXdQYXRoOiBzdHJpbmcpOiB7XG4gICAgYWJzOiBzdHJpbmc7XG4gICAgZW50cnk6IENvbnRleHRFbnRyeTtcbiAgICAvKiogVGhlIHdob2xlIGVudHJ5IChhIHNldCdzIG93biBmb2xkZXIsIGEgbGlzdGVkIGRvY3VtZW50KSwgb3IgYSBub2RlIGluc2lkZSBhIHNldC4gKi9cbiAgICB3aG9sZTogYm9vbGVhbjtcbiAgICBkaXI6IGJvb2xlYW47XG4gIH0ge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAoZS5ub2Rlcy5sZW5ndGggPT09IDEgJiYgb25seT8ua2luZCA9PT0gXCJkb2NcIiAmJiBqb2luKGUucm9vdCwgb25seS5yZWwpID09PSBhYnMpXG4gICAgICAgICAgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IHRydWUsIGRpcjogZmFsc2UgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IHRydWUgfTtcbiAgICAgIGlmIChhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShlLm5vZGVzLCB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkpO1xuICAgICAgICBpZiAobm9kZSkgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IGZhbHNlLCBkaXI6IG5vZGUua2luZCA9PT0gXCJncm91cFwiIH07XG4gICAgICB9XG4gICAgfVxuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3Qgc2hvd24gaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dGAsIDQwNCk7XG4gIH1cblxuICAvKipcbiAgICogYHJhd1BhdGhgIGlmIHRoZSBjb250ZXh0IHNob3dzIGl0IOKAlCBhIGRvY3VtZW50IG9yIGZvbGRlciBpbiBhIHNldCwgYVxuICAgKiBsaXN0ZWQgZG9jdW1lbnQsIGEgc2V0J3Mgb3duIGZvbGRlciDigJQgb3IgaXQgaXMgdGhlIHdvcmtzcGFjZTsgcmVmdXNlZFxuICAgKiBvdGhlcndpc2UuIEZvciBhY3RzIHRoYXQgcmVhY2ggb3V0c2lkZSB0aGUgc3BlbGwgKHJldmVhbGluZyBhIHBhdGggaW4gdGhlXG4gICAqIGZpbGUgbWFuYWdlciksIHNvIGEgcGFnZSBjYW5ub3QgYWltIHRoZW0gYXQgYW4gYXJiaXRyYXJ5IHBhdGguXG4gICAqL1xuICBzaG93blBhdGgocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGlmICh0aGlzLml0ZW1BdChhYnMpKSByZXR1cm4gYWJzO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0aW5hdGlvbk9yRGllKGFicyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbmAsIDQwMCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFJlZnVzZSBhIG5hbWUgdGhhdCBpcyBub3Qgb25lIHBsYWluIGZpbGUgb3IgZm9sZGVyIG5hbWUuICovXG4gIHByaXZhdGUgbmFtZU9yRGllKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgbiA9IG5hbWUudHJpbSgpO1xuICAgIGlmIChcbiAgICAgIG4gPT09IFwiXCIgfHxcbiAgICAgIG4gPT09IFwiLlwiIHx8XG4gICAgICBuID09PSBcIi4uXCIgfHxcbiAgICAgIG4uc3RhcnRzV2l0aChcIi5cIikgfHxcbiAgICAgIC9bL1xcXFxcXDBdLy50ZXN0KG4pIHx8XG4gICAgICBuLmxlbmd0aCA+IDI1NVxuICAgIClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBcIiR7bmFtZX1cIiBpcyBub3QgYSB1c2FibGUgbmFtZSDigJQgb25lIHBsYWluIG5hbWUsIG5vIHNsYXNoZXMsIG5vdCBzdGFydGluZyB3aXRoIGEgZG90YCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICByZXR1cm4gbjtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG5hbWU6IGEgbmFtZSB3aXRob3V0IGEgZG9jdW1lbnQgZXh0ZW5zaW9uIGdldHMgYC5tZGAuICovXG4gIHByaXZhdGUgZG9jTmFtZU9yRGllKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgbiA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIHJldHVybiBpc0RvY05hbWUobikgPyBuIDogYCR7bn0ubWRgO1xuICB9XG5cbiAgLyoqXG4gICAqIEFmdGVyIHNvbWV0aGluZyBtb3ZlZCBvbiBkaXNrIGZyb20gYGZyb21gIHRvIGB0b2AsIGJyaW5nIHRoZSBtb2RlbCB3aXRoIGl0OlxuICAgKiBvcGVuZWQgZG9jdW1lbnRzIGtlZXAgdGhlaXIgdmVyc2lvbnMgdW5kZXIgdGhlIG5ldyBwYXRoLCBlbnRyaWVzIHJvb3RlZCBhdFxuICAgKiBvciBob2xkaW5nIHRoZSBtb3ZlZCB0aGluZyBmb2xsb3cgaXQsIGFuZCBldmVyeSBtaXJyb3IgaXMgcmUtcmVhZC4gQW4gZW50cnlcbiAgICogdGhhdCBub3cgc2l0cyBpbnNpZGUgYW5vdGhlciBzZXQgaXMgZHJvcHBlZCDigJQgdGhlIHNldCBzaG93cyBpdCBhbHJlYWR5LlxuICAgKi9cbiAgcHJpdmF0ZSBmb2xsb3dNb3ZlKGZyb206IHN0cmluZywgdG86IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IG1vdmVkID0gKHA6IHN0cmluZyk6IHN0cmluZyB8IG51bGwgPT5cbiAgICAgIHAgPT09IGZyb20gPyB0byA6IHAuc3RhcnRzV2l0aChmcm9tICsgc2VwKSA/IHRvICsgcC5zbGljZShmcm9tLmxlbmd0aCkgOiBudWxsO1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3Qgbm93ID0gbW92ZWQoZC5vcmlnaW5hbCk7XG4gICAgICBpZiAobm93KSB7XG4gICAgICAgIGQub3JpZ2luYWwgPSBub3c7XG4gICAgICAgIGQubmFtZSA9IGJhc2VuYW1lKG5vdyk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGRyb3AgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibGlzdGVkXCIpIHtcbiAgICAgICAgY29uc3Qgb25seSA9IGUubm9kZXNbMF07XG4gICAgICAgIGlmIChvbmx5Py5raW5kICE9PSBcImRvY1wiKSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qgbm93ID0gbW92ZWQoam9pbihlLnJvb3QsIG9ubHkucmVsKSk7XG4gICAgICAgIGlmICghbm93KSBjb250aW51ZTtcbiAgICAgICAgaWYgKHRoaXMuY292ZXJpbmdFbnRyeShub3csIGUuaWQpKSBkcm9wLmFkZChlLmlkKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZS5yb290ID0gZGlybmFtZShub3cpO1xuICAgICAgICAgIGUubGFiZWwgPSBiYXNlbmFtZShub3cpO1xuICAgICAgICAgIGUubm9kZXMgPSBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKG5vdykgfV07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGUucm9vdCk7XG4gICAgICAgIGlmICghbm93KSBjb250aW51ZTtcbiAgICAgICAgaWYgKHRoaXMuY292ZXJpbmdFbnRyeShub3csIGUuaWQpKSBkcm9wLmFkZChlLmlkKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZS5yb290ID0gbm93O1xuICAgICAgICAgIGUubGFiZWwgPSBiYXNlbmFtZShub3cpIHx8IG5vdztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLm0uY29udGV4dCA9IHRoaXMubS5jb250ZXh0LmZpbHRlcigoZSkgPT4gIWRyb3AuaGFzKGUuaWQpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBZnRlciBhIGZpbGUgb3IgZm9sZGVyIGxhbmRlZCBhdCBgYWJzYDogcmUtcmVhZCB0aGUgc2V0IGl0IGlzIGluLCBvciBnaXZlIGl0IGFuIGVudHJ5LiAqL1xuICBwcml2YXRlIGFkb3B0TmV3KGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3Qgc2V0ID0gdGhpcy5jb3ZlcmluZ0VudHJ5KGFicyk7XG4gICAgaWYgKHNldCkgdGhpcy5yZXNjYW4oc2V0LmlkKTtcbiAgICBlbHNlIHRoaXMubS5jb250ZXh0LnB1c2goZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICB9XG5cbiAgLyoqIEEgbmFtZSBpbiBgZGlyYCB0aGF0IGlzIGZyZWU6IGBuYW1lYCwgZWxzZSBgc3RlbSAyLmV4dGAsIGBzdGVtIDMuZXh0YCwg4oCmICovXG4gIHByaXZhdGUgZnJlZU5hbWUoZGlyOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgaXNEaXI6IGJvb2xlYW4pOiBzdHJpbmcge1xuICAgIGlmICghZXhpc3RzU3luYyhqb2luKGRpciwgbmFtZSkpKSByZXR1cm4gbmFtZTtcbiAgICBjb25zdCBleHQgPSBpc0RpciA/IFwiXCIgOiBleHRuYW1lKG5hbWUpO1xuICAgIGNvbnN0IHN0ZW0gPSBleHQgPyBuYW1lLnNsaWNlKDAsIC1leHQubGVuZ3RoKSA6IG5hbWU7XG4gICAgZm9yIChsZXQgaSA9IDI7IDsgaSsrKSB7XG4gICAgICBjb25zdCBuID0gYCR7c3RlbX0gJHtpfSR7ZXh0fWA7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG4pKSkgcmV0dXJuIG47XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZWZ1c2VFeGlzdGluZyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChleGlzdHNTeW5jKGFicykpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gYWxyZWFkeSBleGlzdHMg4oCUIG5vdGhpbmcgd2FzIG92ZXJ3cml0dGVuYCwgNDA5KTtcbiAgfVxuXG4gIGNyZWF0ZURvYyhyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZpbGUgPVxuICAgICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gdGhpcy5mcmVlTmFtZShkaXIsIFwiVW50aXRsZWQubWRcIiwgZmFsc2UpIDogdGhpcy5kb2NOYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZpbGUpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcoYWJzKTtcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgXCJcIiwgeyBmbGFnOiBcInd4XCIgfSk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgY3JlYXRlRm9sZGVyKHJhd0Rpcjogc3RyaW5nLCBuYW1lPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0Rpcik7XG4gICAgY29uc3QgZm9sZGVyID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIk5ldyBmb2xkZXJcIiwgdHJ1ZSkgOiB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgZm9sZGVyKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgbWtkaXJTeW5jKGFicyk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICB1bmhpZGUoZW50cnlJZDogc3RyaW5nKTogeyBlbnRyeTogc3RyaW5nOyByZXN0b3JlZDogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCByZXN0b3JlZCA9IGUuaGlkZGVuPy5sZW5ndGggPz8gMDtcbiAgICBkZWxldGUgZS5oaWRkZW47XG4gICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgcmVzdG9yZWQgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjI6IGEgc2luZ2xlIGRvY3VtZW50IGJlY29tZXMgYSBzZXQg4oCUIGEgZm9sZGVyIG5hbWVkIGZvciBpdCBiZXNpZGUgaXQsIHRoZVxuICAgKiBkb2N1bWVudCBtb3ZlZCBpbiwgYW5kIHRoZSBlbnRyeSAoc2FtZSBpZCkgbm93IG1pcnJvcnMgdGhhdCBmb2xkZXIuXG4gICAqL1xuICBtYWtlU2V0KHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmb2xkZXI6IHN0cmluZzsgZW50cnk6IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgaWYgKGl0ZW0uZW50cnkubWVtYmVyc2hpcCAhPT0gXCJsaXN0ZWRcIiB8fCBpdGVtLmRpcilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gYSBzZXQg4oCUIG1ha2UgYSBmb2xkZXIgdGhlcmUgaW5zdGVhZGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShpdGVtLmFicyk7XG4gICAgY29uc3Qgc3RlbSA9IGJhc2VuYW1lKGl0ZW0uYWJzLCBleHRuYW1lKGl0ZW0uYWJzKSkgfHwgXCJVbnRpdGxlZFwiO1xuICAgIGNvbnN0IGZvbGRlciA9IGpvaW4ocGFyZW50LCB0aGlzLmZyZWVOYW1lKHBhcmVudCwgc3RlbSwgdHJ1ZSkpO1xuICAgIG1rZGlyU3luYyhmb2xkZXIpO1xuICAgIGNvbnN0IHRvID0gam9pbihmb2xkZXIsIGJhc2VuYW1lKGl0ZW0uYWJzKSk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIGNvbnN0IGUgPSBpdGVtLmVudHJ5O1xuICAgIGUubWVtYmVyc2hpcCA9IFwibWlycm9yZWRcIjtcbiAgICBlLnJvb3QgPSBmb2xkZXI7XG4gICAgZS5sYWJlbCA9IGJhc2VuYW1lKGZvbGRlcik7XG4gICAgZS5ub2RlcyA9IFtdO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmb2xkZXIsIGVudHJ5OiBlLmlkIH07XG4gIH1cblxuICAvKiogVGhlIG1vc3QgdGV4dCBvbmUgaW1wb3J0IGNhcnJpZXMg4oCUIGEgZG9jdW1lbnQsIG5vdCBhIGRhdGEgZHVtcC4gKi9cbiAgc3RhdGljIHJlYWRvbmx5IElNUE9SVF9NQVhfQllURVMgPSA4ICogMTAyNCAqIDEwMjQ7XG5cbiAgLyoqXG4gICAqIEUyMydzIGRyb3A6IGEgQ09QWSBvZiBhIGZpbGUncyB0ZXh0LCB3cml0dGVuIHVuZGVyIGEgZnJlZSBuYW1lIGludG8gYGludG9gXG4gICAqIChkZWZhdWx0OiB0aGUgd29ya3NwYWNlKSwgdGhlbiBzaG93biBsaWtlIGFueSBvdGhlciBkb2N1bWVudC5cbiAgICovXG4gIGltcG9ydFRleHQobmFtZTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIHJhd0ludG8/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBmaWxlID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgaWYgKCFpc0RvY05hbWUoZmlsZSkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm90IGEgZG9jdW1lbnQgU2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHtmaWxlfWAsXG4gICAgICAgIDQwMCxcbiAgICAgICAgWy4uLkRPQ19FWFRFTlNJT05TXSxcbiAgICAgICk7XG4gICAgaWYgKEJ1ZmZlci5ieXRlTGVuZ3RoKHRleHQpID4gU2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZmlsZX0gaXMgbGFyZ2VyIHRoYW4gJHtTZXNzaW9uLklNUE9SVF9NQVhfQllURVMgLyAxMDI0IC8gMTAyNH0gTUIg4oCUIG5vdCBpbXBvcnRlZGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8gPz8gdGhpcy53b3Jrc3BhY2UpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCB0aGlzLmZyZWVOYW1lKGRpciwgZmlsZSwgZmFsc2UpKTtcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgdGV4dCwgeyBmbGFnOiBcInd4XCIgfSk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNoYXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkTWVzc2FnZShcbiAgICB3aG86IENoYXRXaG8sXG4gICAgdGV4dDogc3RyaW5nLFxuICAgIGV4dHJhOiB7IHNlbGVjdGlvbj86IFNlbGVjdGlvbiB8IG51bGw7IGFjdGl2ZVBhdGg/OiBzdHJpbmcgfCBudWxsIH0gPSB7fSxcbiAgKTogQ2hhdE1lc3NhZ2Uge1xuICAgIGNvbnN0IG1zZzogQ2hhdE1lc3NhZ2UgPSB7IGlkOiBgbS0ke3JhbmRIZXgoNCl9YCwgd2hvLCB0ZXh0LCB0czogRGF0ZS5ub3coKSwgLi4uZXh0cmEgfTtcbiAgICB0aGlzLm0uY2hhdC5wdXNoKG1zZyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCB2aWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBkb2NWaWV3KGQ6IERvY1JlY29yZCk6IERvY1ZpZXcge1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIGVudHJ5SWQ6IGQuZW50cnlJZCxcbiAgICAgIHJlbDogZC5yZWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5tYXAoKHYpID0+ICh7IC4uLnYsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgdi5uKSB9KSksXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgZGlydHk6IHRoaXMuaXNEaXJ0eShkKSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBkLm91dHNpZGVDaGFuZ2VkLFxuICAgIH07XG4gIH1cblxuICBkb2Moc2x1Zzogc3RyaW5nKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHRoaXMuZG9jVmlldyh0aGlzLmRvY09yRGllKHNsdWcpKTtcbiAgfVxuXG4gIC8qKiBUaGUgc2Vzc2lvbidzIGhhbGYgb2YgYFB1YmxpY1N0YXRlYDsgdGhlIGRhZW1vbiBhZGRzIHRoZSBob21lLWxldmVsIGBwcmVmc2AgYW5kIGB1c2VySG9tZWAuICovXG4gIHZpZXcoXG4gICAgbW9kZTogXCJkZXZcIiB8IFwicmVsZWFzZVwiLFxuICAgIHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCxcbiAgKTogT21pdDxQdWJsaWNTdGF0ZSwgXCJwcmVmc1wiIHwgXCJ1c2VySG9tZVwiPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy53b3Jrc3BhY2UsXG4gICAgICBtb2RlLFxuICAgICAgY29udGV4dDogdGhpcy5tLmNvbnRleHQsXG4gICAgICBkb2NzOiB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IHRoaXMuZG9jVmlldyhkKSksXG4gICAgICBvcGVuRG9jOiB0aGlzLm0ub3BlbkRvYyxcbiAgICAgIHNlbGVjdGlvbixcbiAgICAgIGNoYXQ6IHRoaXMubS5jaGF0LFxuICAgIH07XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXFEQSx5QkFBeUIsMkJBQWMseUJBQVU7QUFDakQsb0JBQVM7QUFDVCxxQkFBUyxzQkFBVSx3QkFBUyxxQkFBWSxrQkFBTTtBQUM5QztBQUNBLHNCQUFTOzs7QUMzQ1Q7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFB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QyxFQUFFO0FBQUEsSUFJN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYixnQkFBZ0IsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxzQkFBMEIsT0FBTyxLQUN4RixjQUNGLEVBQ0csSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQ25CLEtBQUssR0FBRztBQUFBLENBQ2I7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBRVQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsSUFBSSxNQUFNLFlBQVk7QUFBQSxNQUNwQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsTUFDeEMsU0FBUyxNQUFNO0FBQUEsTUFDZixVQUFVLE1BQU0sVUFBVSxPQUFPLE1BQU0sT0FBTyxJQUFJO0FBQUEsTUFDbEQsV0FBVyxNQUFNO0FBQUEsSUFDbkIsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFFVixNQUFNLFNBQVMsYUFBYSxlQUFlLEVBQUUsU0FBUztBQUFBLElBQ3RELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsSUFBSSxPQUFPLFFBQVEsT0FBTyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxDQUM1RjtBQUFBLElBQ0EsT0FBTyxXQUFXLE1BQU0sSUFBSSxXQUFXLE1BQU0sSUFBSTtBQUFBO0FBQUEsRUFFbkQsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLG9CQUFvQixFQUFFLFFBQVEsTUFBTSxFQUFFLE1BQU0sWUFBWSxFQUFFLFdBQVcsTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLElBQUksQ0FBQztBQUFBLENBQzFIO0FBQUEsRUFDQSxNQUFNLE1BQU0sTUFBTSxFQUFFO0FBQUEsRUFDcEIsTUFBTSxFQUFFO0FBQUEsRUFFUixJQUFJLElBQUksU0FBUyxLQUFLLE1BQU0sS0FBSztBQUFBLElBQy9CLElBQUk7QUFBQSxNQUNGLElBQUksVUFBUyxNQUFNLEdBQUcsRUFBRSxTQUFTO0FBQUEsUUFBRyxZQUFXLE1BQU0sR0FBRztBQUFBLE1BQ3hELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxPQUFPLElBQUk7QUFBQTtBQVFiLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjEyQzA3NEY5RDY3N0IxREQ2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
