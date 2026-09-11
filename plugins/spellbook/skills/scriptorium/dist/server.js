// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { statSync as statSync3, unlinkSync as unlinkSync2, watch } from "fs";
import { homedir, tmpdir } from "os";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join4, resolve as resolve2 } from "path";
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
function scanTree(root, cap = MIRROR_NODE_CAP) {
  let count = 0;
  let truncated = false;
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
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name))
          continue;
        count++;
        const children = walk(abs);
        if (children.length > 0)
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
  static create(home, sessionId = newSessionId()) {
    const s = new Session(home, {
      format: MANIFEST_FORMAT,
      sessionId,
      createdAt: Date.now(),
      context: [],
      docs: [],
      openDoc: null,
      chat: []
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
    this.persist();
  }
  rescan(entryId) {
    const e = this.m.context.find((x) => x.id === entryId);
    if (e?.membership !== "mirrored")
      return false;
    const { nodes, truncated } = scanTree(e.root);
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
  return resolve2(process.env.SCRIPTORIUM_HOME ?? join4(homedir(), ".scriptorium"));
}
var WATCH_SETTLE_MS = 60;
async function startDaemon(opts) {
  const home = scriptoriumHome();
  const mode = resolveMode2();
  const devIndex = mode === "dev" ? (await import("../../../../../src/scriptorium/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  const session = opts.restore ? Session.restore(home, opts.restore) : Session.create(home);
  const sessionId = session.id;
  let selection = null;
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
  const broadcastState = () => send({ type: "state", state: session.view(mode, selection) });
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
  const reply = (ws, msg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  };
  const handleClientMsg = (ws, msg) => {
    switch (msg.type) {
      case "open": {
        const r = session.openPath(msg.path);
        syncWatchers();
        broadcastState();
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
        addPaths([msg.path]);
        return;
      case "context.remove":
        session.removeContext(msg.id);
        syncWatchers();
        broadcastState();
        return;
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
        throw new SessionError(`unrecognised command type ${JSON.stringify(cmd.type)} \u2014 nothing was applied`, 400, ["context.add", "version.new", "say", "activate", "close"]);
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
        const state = session.view(mode, selection);
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
        ws.send(JSON.stringify({ type: "state", state: session.view(mode, selection) }));
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
function expandHome(p) {
  if (p === "~")
    return homedir();
  if (p.startsWith("~/"))
    return join4(homedir(), p.slice(2));
  return resolve2(p);
}
var DAEMON_OPTIONS = {
  log: { type: "string" },
  port: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" }
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
      timeoutS: flags.timeout ? Number(flags.timeout) : undefined
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
  startDaemon
};

//# debugId=A5B6D8C252BAB7BF64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3Nlc3Npb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdHJlZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgcGVyLXNlc3Npb24gZGFlbW9uIOKAlCB0aGUgcHJvY2VzcyB0aGUgc3VyZmFjZSB0YWxrcyB0byBvdmVyIGFcbiAqIFdlYlNvY2tldCBhbmQgdGhlIENMSSB0YWxrcyB0byBvdmVyIEhUVFAuIExhdW5jaGVkIGJ5XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL3NjcmlwdG9yaXVtL3NjcmlwdHMvc2VydmVyLnRzYCAodGhlIGxhdW5jaGVyKSwgd2hpY2hcbiAqIGltcG9ydHMgdGhlIEJVSUxUIGBkaXN0L3NlcnZlci5qc2AuXG4gKlxuICog4pSA4pSAIFRIRSBFSUdIVCBRVUVTVElPTlMgKHNjYWZmb2xkaW5nIHBsYXlib29rIE4xKSwgQU5TV0VSRUQgQVMgREVTSUdOIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIEFyaXRobWV0aWM6IGBTS0lMTF9ST09UYC9gRElTVF9ESVJgIG9ubHksIGZvciB0aGUga2l0J3MgYHJlc29sdmVNb2RlYCBhbmRcbiAqICAgIGBzZXJ2ZUZyb21EaXN0YCwgYW5kIHRydWUgYXQgdGhlIEVNSVRURUQgYWRkcmVzcyAoYGRpc3Qvc2VydmVyLmpzYCwgd2hvc2VcbiAqICAgIGAuLmAgaXMgdGhlIHNraWxsIGZvbGRlcikuIE5vdGhpbmcgZWxzZSBpcyBwaW5uZWQgb2ZmIGBpbXBvcnQubWV0YWAuXG4gKiAyLiBTZXJ2ZXM6IFlFUy4gYC9gIGlzIHRoZSBidWlsdCBgaW5kZXguaHRtbGAgdmlhIGBzZXJ2ZUZyb21EaXN0YCwgbm9cbiAqICAgIHN1YnN0aXR1dGlvbjsgdGhlIG9ubHkgcm91dGVzIG9mIGl0cyBvd24gYXJlIGAvc3RhdGVgLCBgL2NtZGAsIGAvZXZlbnRzYCxcbiAqICAgIGAvd3NgIGFuZCBgL2ZzLypgIChyZWFkLW9ubHk6IGEgdmVyc2lvbidzIHRleHQsIGEgZGlyZWN0b3J5IGxpc3RpbmcpLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgYGNsaS50c2A7IHRoZSB0d28gc2hhcmUgYC4vaGVhcnRiZWF0LnRzYC5cbiAqIDQuIExpZmVjeWNsZTogbG9uZy1ydW5uaW5nLCBvbmUgZGFlbW9uIHBlciBzZXNzaW9uLCBpZGxlLXRpbWVvdXQgbGlrZVxuICogICAgZ2xhbW91ciAobGluZ2VyIGFmdGVyIHRoZSBsYXN0IHN1YnNjcmliZXIgbGVhdmVzOyBleGl0IDEyNCkuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oCUIGBtYWluYCBhd2FpdHMgdGhlXG4gKiAgICBzZXNzaW9uJ3MgZW5kIGFuZCBpdHMgb3duIGRyYWluLCBleGFjdGx5IGFzIGdsYW1vdXIncyBzZXJ2ZXIgZG9lcywgc28gdGhlXG4gKiAgICBsYXVuY2hlciBpcyBURVJNSU5BTC1FWElUIChgcHJvY2Vzcy5leGl0KGF3YWl0IHJ1bigpKWApOiBvbmNlIGBtYWluYFxuICogICAgcmVzb2x2ZXMgbm90aGluZyBtYXkga2VlcCB0aGUgcHJvY2VzcyBhbGl2ZSwgYW5kIGEgd2F0Y2hlciBoYW5kbGUgb3IgYVxuICogICAgc3RyYWdnbGluZyBzb2NrZXQgd291bGQuIERyaXZlbiwgbm90IHJlYWQgKHNlZSB0aGUgc2xpY2UtQSBqb3VybmFsKS5cbiAqIDYuIEV2ZW50IGlkcyByZWNvdmVyZWQgYWNyb3NzIHJlc3RhcnQ/IE5PIOKAlCB0aGUgbG9nIGlzIGluIG1lbW9yeSBhbmQgaWRzXG4gKiAgICByZXN0YXJ0IGF0IDEsIGV2ZW4gdW5kZXIgYC0tcmVzdG9yZWAgKHdoaWNoIHJlc3RvcmVzIHRoZSBNQU5JRkVTVCwgbm90IHRoZVxuICogICAgbG9nKS4gU28gdGhlIGxvZyBpcyBzdGFtcGVkIHdpdGggYSBwZXItYm9vdCBFUE9DSCAobWluZC1tYXBwZXIncyBzaGFwZSlcbiAqICAgIGFuZCB0aGUgdGFpbCByZXNldHMgaXRzIGN1cnNvciB3aGVuIHRoZSBlcG9jaCBjaGFuZ2VzLlxuICogNy4gQSBraXQgc3ViamVjdCBpbiBhIGRpZmZlcmVudCBzaGFwZT8gTm8g4oCUIHRoZSBzaGFwZSB3YXMgY2hvc2VuIHRvIGJlIHRoZVxuICogICAga2l0J3MuXG4gKiA4LiBBIGtpdCBtb2R1bGUgbmFtZXMgdGhpcyBzcGVsbCBhcyBpdHMgc291cmNlPyBTdHJ1Y3R1cmFsbHkgTk86IHNjcmlwdG9yaXVtXG4gKiAgICBpcyB0aGUgZmlyc3Qgc3BlbGwgc2NhZmZvbGRlZCBhZnRlciB0aGUgY29udmVyZ2VuY2UuXG4gKlxuICog4pSA4pSAIEtJVCBWRVJESUNUUyAocGxheWJvb2sgTjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGVycm9ycyBTVUJKRUNUICh0aGUgQ0xJOyB0aGUgZGFlbW9uIGFuc3dlcnMgSFRUUCBzdGF0dXNlcyB0aGUgQ0xJIG1hcHMpIMK3XG4gKiBzZXJ2ZURpc3QgU1VCSkVDVCAoYHJlc29sdmVNb2RlYCwgYHNlcnZlRnJvbURpc3RgKSDCtyBob3VzZWtlZXBpbmcgU1VCSkVDVCwgYWxsXG4gKiB0aHJlZSBleHBvcnRzIChgc2hvdWxkSWRsZUNsb3NlYCB2aWEgYHN0YXJ0SG91c2VrZWVwaW5nYCdzIGlkbGUtY2xvc2UsIHRoZVxuICogc25hcHNob3Qgc3dlZXAg4oCUIGhlcmUgdGhlIG1hbmlmZXN0IGlzIHdyaXR0ZW4gb24gZXZlcnkgY2hhbmdlIGluc3RlYWQsIHNvIHRoZVxuICogc3dlZXAncyBzbmFwc2hvdCBob29rIGlzIGRlbGliZXJhdGVseSBOT1QgcGFzc2VkIOKAlCBhbmQgYGRyYWluQW5kU3RvcGApIMK3XG4gKiB0YWlsRXZlbnRzIFNVQkpFQ1QgKHRoZSBDTEkncyBgdGFpbGApIMK3IGhlYXJ0YmVhdCBTVUJKRUNUIChgLi9oZWFydGJlYXQudHNgKSDCt1xuICogZGlzY292ZXJ5IFNVQkpFQ1QgKHNlc3Npb24tSlNPTiwgRTEzOiBgc2NyaXB0b3JpdW0tPGlkPi5qc29uYCArXG4gKiBgc2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25gIGluIHRtcGRpciB2aWEgYHdyaXRlRmlsZUF0b21pY2AvYHVubGlua0lmTWF0Y2hlc2ApIMK3XG4gKiBldmVudExvZyBTVUJKRUNULCBXSVRIIEVQT0NIIChRNikgwrcgc3NlIFNVQkpFQ1QgKGBHRVQgL2V2ZW50c2ApIMK3XG4gKiBsaWIvcHJpbnRKc29uIFNVQkpFQ1QgKHRoZSBDTEkgc3BlYWtzIHRoZSBhZ2VudCB3aXJlKS5cbiAqXG4gKiDilIDilIAgVEVBUkRPV04gT1JERVIgKHJlZ2lzdGVyIEE2KSwgU1RBVEVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGdsYW1vdXIncyBvcmRlcjogc3RvcCBob3VzZWtlZXBpbmcg4oaSIGNsb3NlIHRoZSB3YXRjaGVycyDihpIgcGVyc2lzdCB0aGVcbiAqIG1hbmlmZXN0IOKGkiB1bmxpbmsgZGlzY292ZXJ5IOKGkiBlbWl0IGBjbG9zZWRgIOKGkiBkcmFpbi4gRGlzY292ZXJ5IGdvZXMgQkVGT1JFIHRoZVxuICogYGNsb3NlZGAgZnJhbWUgc28gYSB0YWlsIHRoYXQgc2VlcyBgY2xvc2VkYCBhbmQgYSBDTEkgdmVyYiB0aGF0IHJ1bnMgcmlnaHRcbiAqIGFmdGVyIGl0IGJvdGggZmluZCBubyBwb2ludGVyIHRvIGEgZGFlbW9uIHRoYXQgaXMgbGVhdmluZzsgdGhlIG90aGVyIG9yZGVyXG4gKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYSB2ZXJiIHJlc29sdmVzIGEgc2Vzc2lvbiB0aGF0IHdpbGwgcmVmdXNlIGl0LlxuICovXG5cbmltcG9ydCB7IHR5cGUgRlNXYXRjaGVyLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHVubGlua0lmTWF0Y2hlcywgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHsgY3JlYXRlRXZlbnRMb2cgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXZlbnRMb2cudHNcIjtcbmltcG9ydCB7IGRyYWluQW5kU3RvcCwgc3RhcnRIb3VzZWtlZXBpbmcgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaG91c2VrZWVwaW5nLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTW9kZSBhcyByZXNvbHZlTW9kZUluLCBzZXJ2ZUZyb21EaXN0IH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NlcnZlRGlzdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBTc2VDbGllbnRzLCBzc2VSZXNwb25zZSB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zc2UudHNcIjtcbmltcG9ydCB7IElETEVfVElNRU9VVF9TRUMsIFNTRV9IRUFSVEJFQVRfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRDbWQsIENsaWVudE1zZywgU2VsZWN0aW9uLCBTZXJ2ZXJNc2cgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgdHlwZSBGaWxlRXZlbnQsIFNlc3Npb24sIFNlc3Npb25FcnJvciB9IGZyb20gXCIuL3Nlc3Npb25cIjtcbmltcG9ydCB7IGxpc3REaXIsIFBhdGhFcnJvciB9IGZyb20gXCIuL3RyZWVcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuXG4vKiogcmVsZWFzZSBpZmYgYGRpc3QvaW5kZXguaHRtbGAgZXhpc3RzIGF0IHRoZSBza2lsbCByb290OyB0aGUgZW52IHZhciBvdmVycmlkZXMgKENvbnRyYWN0IDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIHJldHVybiByZXNvbHZlTW9kZUluKERJU1RfRElSKTtcbn1cblxuZnVuY3Rpb24gc2VydmVEaXN0KHBhdGg6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIHJldHVybiBzZXJ2ZUZyb21EaXN0KERJU1RfRElSLCBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKSk7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAuIGBwcm9tcHRzLmpzb25gIGJlc2lkZSBgc2Vzc2lvbnMvYCBpcyBzbGljZSBCJ3MgKEU5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG5leHBvcnQgdHlwZSBTdGFydE9wdHMgPSB7IHBvcnQ/OiBudW1iZXI7IHJlc3RvcmU/OiBzdHJpbmc7IHRpbWVvdXRTPzogbnVtYmVyIH07XG5cbi8qKiBBIHRhaWwgZnJhbWUncyBwYXlsb2FkLiBUaGUgbG9nIHN0YW1wcyBgaWRgIGFuZCBgZXBvY2hgLiAqL1xudHlwZSBMb2dFdmVudCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyB0eXBlOiBzdHJpbmcgfTtcblxuLyoqIEhvdyBsb25nIGEgYnVyc3Qgb2Ygd2F0Y2hlciBldmVudHMgb24gb25lIHBhdGggc2V0dGxlcyBiZWZvcmUgaXQgaXMgcmVhZC4gKi9cbmNvbnN0IFdBVENIX1NFVFRMRV9NUyA9IDYwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgLy8gTW9kZSBCRUZPUkUgYW55IHdyaXRlOiBhIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0XG4gIC8vIGRpZSBhdCB0aGUgaW1wb3J0IGhhdmluZyBjcmVhdGVkIG5vdGhpbmcgKGdsYW1vdXIncyBtZWFzdXJlZCBvcmRlcikuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuICBjb25zdCBkZXZJbmRleCA9XG4gICAgbW9kZSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGNvbnN0IHNlc3Npb24gPSBvcHRzLnJlc3RvcmUgPyBTZXNzaW9uLnJlc3RvcmUoaG9tZSwgb3B0cy5yZXN0b3JlKSA6IFNlc3Npb24uY3JlYXRlKGhvbWUpO1xuICBjb25zdCBzZXNzaW9uSWQgPSBzZXNzaW9uLmlkO1xuICBsZXQgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsID0gbnVsbDtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIGNvbnN0IGxvZyA9IGNyZWF0ZUV2ZW50TG9nPExvZ0V2ZW50Pih7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH0pO1xuICBjb25zdCBzc2VDbGllbnRzOiBTc2VDbGllbnRzID0gbmV3IFNldCgpO1xuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGNvbnN0IHNlbmQgPSAobXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiBzZW5kKHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogc2Vzc2lvbi52aWV3KG1vZGUsIHNlbGVjdGlvbikgfSk7XG5cbiAgLyoqIEEgc3lzdGVtIGxpbmUgaW4gdGhlIGNoYXQg4oCUIGFuZCwgYmVjYXVzZSB0aGUgYWdlbnQgbXVzdCBrbm93IGl0IHRvbywgb24gdGhlIHRhaWwuICovXG4gIGNvbnN0IGFubm91bmNlID0gKHRleHQ6IHN0cmluZywgZmFjdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSkgPT4ge1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgdGV4dCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcInN5c3RlbVwiLCB0ZXh0LCB0czogbS50cywgLi4uZmFjdCB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICB9O1xuXG4gIC8vIC0tLSB0aGUgd2F0Y2hlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDimqAgREVWSUFUSU9OIEZST00gVEhFIEJSSUVGLCBXSVRIIElUUyBSRUFTT046IGBub2RlOmZzYCBgd2F0Y2hgIChCdW4nc1xuICAvLyBidWlsdC1pbiksIE5PVCBgQHBhcmNlbC93YXRjaGVyYC4gYEBwYXJjZWwvd2F0Y2hlcmAgaXMgYSBuYXRpdmUgYWRkb24gd2hvc2VcbiAgLy8gbG9hZGVyIGRvZXMgYSBydW50aW1lIGByZXF1aXJlKClgIG9mIGEgcGVyLXBsYXRmb3JtIHBhY2thZ2U7IGJ1bmRsZWQgaW50b1xuICAvLyBgZGlzdC9zZXJ2ZXIuanNgIGl0IGlzIG5vdCBpbmxpbmVkLCBzbyB0aGUgc2hpcHBlZCBkYWVtb24gd291bGQgbmVlZCBhXG4gIC8vIGBub2RlX21vZHVsZXNgIHRoZSBtYXJrZXRwbGFjZSBuZXZlciBjb3BpZXMgKGltcG9ydC1ib3VuZGFyeSB3YXJkIDFiJ3NcbiAgLy8gXCJ0aGUgc2hpcHBlZCBleGVjdXRpb24gcGF0aCBjYXJyaWVzIG5vIGRlcGVuZGVuY2llc1wiKS4gTWVhc3VyZWQgdW5kZXIgQnVuXG4gIC8vIDEuNC4wIG9uIG1hY09TIGJlZm9yZSBjaG9vc2luZzogYSByZWN1cnNpdmUgZGlyZWN0b3J5IHdhdGNoIHJlcG9ydHMgYW5cbiAgLy8gaW4tcGxhY2Ugd3JpdGUsIGFuIGF0b21pYyB0bXArcmVuYW1lIHNhdmUsIGFuZCBib3RoIGFnYWluIGluIGFcbiAgLy8gc3ViZGlyZWN0b3J5IOKAlCB0aGUgZm91ciBjYXNlcyBpbnZlc3RpZ2F0aW9uIMKnNSBkcm92ZSBAcGFyY2VsL3dhdGNoZXIgb24uXG4gIC8vIFRoZSBoYXNoLWNvbXBhcmUgYW5kIHNlbGYtd3JpdGUgc3VwcHJlc3Npb24gYXJlIHVuY2hhbmdlZCAoc2Vzc2lvbi50cykuXG4gIGNvbnN0IHdhdGNoZXJzID0gbmV3IE1hcDxzdHJpbmcsIEZTV2F0Y2hlcj4oKTtcbiAgY29uc3QgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pj4oKTtcbiAgY29uc3Qgb25GcyA9IChhYnM6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHQgPSBwZW5kaW5nLmdldChhYnMpO1xuICAgIGlmICh0KSBjbGVhclRpbWVvdXQodCk7XG4gICAgcGVuZGluZy5zZXQoXG4gICAgICBhYnMsXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcGVuZGluZy5kZWxldGUoYWJzKTtcbiAgICAgICAgbGV0IGV2OiBGaWxlRXZlbnQgfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBldiA9IHNlc3Npb24ub25GaWxlRXZlbnQoYWJzKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogd2F0Y2hlcjogJHtlfVxcbmApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldikgaGFuZGxlRmlsZUV2ZW50KGV2KTtcbiAgICAgIH0sIFdBVENIX1NFVFRMRV9NUyksXG4gICAgKTtcbiAgfTtcbiAgY29uc3Qgc3luY1dhdGNoZXJzID0gKCkgPT4ge1xuICAgIGNvbnN0IHdhbnQgPSBuZXcgTWFwKFxuICAgICAgc2Vzc2lvbi53YXRjaFJvb3RzKCkubWFwKChyKSA9PiBbYCR7ci5yZWN1cnNpdmUgPyBcIlJcIiA6IFwiRlwifToke3Iud2F0Y2h9PiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBXYXRjaGVkIGF0IHRoZSBSRUFMUEFUSCwgcmVwb3J0ZWQgdW5kZXIgdGhlIHN0b3JlZCBwYXRoIGZvcm1cbiAgICAgICAgLy8gKHZlcmlmeS1wYXNzIGZpeCAzIOKAlCBzZWUgU2Vzc2lvbi53YXRjaFJvb3RzKS5cbiAgICAgICAgY29uc3QgdyA9IHdhdGNoKHIud2F0Y2gsIHsgcmVjdXJzaXZlOiByLnJlY3Vyc2l2ZSB9LCAoX2V2ZW50LCBuYW1lKSA9PiB7XG4gICAgICAgICAgaWYgKG5hbWUpIG9uRnMoam9pbihyLnBhdGgsIG5hbWUudG9TdHJpbmcoKSkpO1xuICAgICAgICAgIGVsc2UgaWYgKHIuZW50cnlJZCkgb25GcyhyLnBhdGgpO1xuICAgICAgICB9KTtcbiAgICAgICAgdy5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICAgICAgICAvKiB0aGUgZGlyZWN0b3J5IHdlbnQgYXdheTsgdGhlIG5leHQgc3luYyBkcm9wcyBpdCAqL1xuICAgICAgICB9KTtcbiAgICAgICAgd2F0Y2hlcnMuc2V0KGtleSwgdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW53YXRjaGFibGUgKGdvbmUsIHBlcm1pc3Npb25zKSDigJQgb3V0c2lkZSBjaGFuZ2VzIHRoZXJlIGdvIHVuc2VlbiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVGaWxlRXZlbnQgPSAoZXY6IEZpbGVFdmVudCkgPT4ge1xuICAgIHN3aXRjaCAoZXYua2luZCkge1xuICAgICAgY2FzZSBcInZlcnNpb24uY2hhbmdlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidmVyc2lvbi5jcmVhdGVkXCI6XG4gICAgICAgIGFubm91bmNlKGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gYXBwZWFyZWQgKHdyaXR0ZW4gZGlyZWN0bHkgdG8gJHtldi5wYXRofSlgLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImFjdGl2ZS5vdXRzaWRlXCI6XG4gICAgICAgIC8vIEUyOiB0aGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSB2ZXJzaW9uIHRoZSBodW1hbiBpcyBlZGl0aW5nLiBUaGVcbiAgICAgICAgLy8gb3V0c2lkZSB0ZXh0IGlzIEtFUFQgYXMgYSBuZXcgYWdlbnQgdmVyc2lvbiBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uXG4gICAgICAgIC8vIGtlZXBzIHRoZSBodW1hbidzIHRleHQg4oCUIG5vdGhpbmcgaXMgbG9zdCwgYW5kIHRoZSBodW1hbidzIGJ1ZmZlciBpc1xuICAgICAgICAvLyBub3QgdG91Y2hlZCAodmVyaWZ5LXBhc3MgZml4IDQpLlxuICAgICAgICBhbm5vdW5jZU91dHNpZGUoZXYuZG9jLCBldi52ZXJzaW9uLCBldi5wYXRoLCBldi5wcmVzZXJ2ZWRBcywgZXYucHJlc2VydmVkUGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5yZWxvYWRlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIOKAlCByZWxvYWRlZCAoeW91IGhhZCBubyB1bnNhdmVkIGVkaXRzKS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLmNvbmZsaWN0XCI6XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgeW91IGhhdmUgdW5zYXZlZCBlZGl0cy4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggeW91cnM7IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBldi5kb2MgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInRyZWVcIjpcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhbm5vdW5jZU91dHNpZGUgPSAoXG4gICAgZG9jOiBzdHJpbmcsXG4gICAgdmVyc2lvbjogbnVtYmVyLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBwcmVzZXJ2ZWRBczogbnVtYmVyLFxuICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZyxcbiAgKSA9PlxuICAgIGFubm91bmNlKFxuICAgICAgYHYke3ZlcnNpb259IG9mICR7ZG9jfSBpcyB0aGUgQUNUSVZFIHZlcnNpb24gYW5kIHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yLiBUaGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc307IHRoZSBhY3RpdmUgdmVyc2lvbiBrZWVwcyB5b3VyIHRleHQuIEFnZW50IGVkaXRzIGJlbG9uZyBpbiBhIG5ldyB2ZXJzaW9uICh2ZXJzaW9uLW5ldykuYCxcbiAgICAgIHsgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLCBkb2MsIHZlcnNpb24sIHBhdGgsIHByZXNlcnZlZEFzLCBwcmVzZXJ2ZWRQYXRoIH0sXG4gICAgKTtcblxuICAvLyAtLS0gc2hhcmVkIGFjdHMgKHN1cmZhY2UgYW5kIGFnZW50IHJlYWNoIHRoZSBzYW1lIGNvZGUpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBhZGRQYXRocyA9IChwYXRoczogc3RyaW5nW10pID0+IHtcbiAgICBjb25zdCBhZGRlZCA9IHBhdGhzLm1hcCgocCkgPT4gc2Vzc2lvbi5hZGRDb250ZXh0KHApKTtcbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiBhZGRlZDtcbiAgfTtcblxuICBjb25zdCBhY3RpdmF0ZSA9IChkb2M6IHN0cmluZyB8IHVuZGVmaW5lZCwgdmVyc2lvbjogbnVtYmVyLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKSA9PiB7XG4gICAgY29uc3QgciA9IHNlc3Npb24uYWN0aXZhdGUoeyBkb2MsIHZlcnNpb24gfSk7XG4gICAgY29uc3QgdmlldyA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgY29uc3QgcGF0aCA9IHZpZXcudmVyc2lvbnMuZmluZCgodikgPT4gdi5uID09PSB2ZXJzaW9uKT8ucGF0aCA/PyBudWxsO1xuICAgIHNlbmQoe1xuICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgIGRvYzogci5zbHVnLFxuICAgICAgdmVyc2lvbixcbiAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCB2ZXJzaW9uKS50ZXh0LFxuICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgXCJzeXN0ZW1cIixcbiAgICAgIGAke2J5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwifSBtYWRlIHYke3ZlcnNpb259IG9mICR7ci5zbHVnfSBhY3RpdmUgKHdhcyB2JHtyLnByZXZpb3VzfSkuYCxcbiAgICApO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJhY3RpdmF0ZWRcIiwgYnksIGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCwgdHM6IG0udHMgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGggfTtcbiAgfTtcblxuICAvLyAtLS0gc3VyZmFjZSBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCByZXBseSA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICB0cnkge1xuICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShtc2cpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUgKi9cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IENsaWVudE1zZykgPT4ge1xuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJvcGVuXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ub3BlblBhdGgobXNnLnBhdGgpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgaWYgKHIuY3JlYXRlZClcbiAgICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwiZG9jLm9wZW5lZFwiLCBkb2M6IHIuc2x1ZywgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHIuc2x1ZykgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJvcGVuLmRvY1wiOlxuICAgICAgICBzZXNzaW9uLm9wZW5TbHVnKG1zZy5kb2MpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZWRpdFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLmVkaXQobXNnLmRvYywgbXNnLnZlcnNpb24sIG1zZy50ZXh0KTtcbiAgICAgICAgaWYgKHIucHJlc2VydmVkKSB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKG1zZy5kb2MpO1xuICAgICAgICAgIGFubm91bmNlT3V0c2lkZShcbiAgICAgICAgICAgIGQuc2x1ZyxcbiAgICAgICAgICAgIG1zZy52ZXJzaW9uLFxuICAgICAgICAgICAgc2Vzc2lvbi5hY3RpdmVQYXRoKGQuc2x1ZykgPz8gXCJcIixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLm4sXG4gICAgICAgICAgICByLnByZXNlcnZlZC5wYXRoLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoci5kaXJ0eUNoYW5nZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgICAgLy8gQU1CSUVOVCBzdGF0ZTogc3RvcmVkIGFuZCBzaG93biwgbmV2ZXIgcHVzaGVkIG9udG8gdGhlIGFnZW50J3MgdGFpbC5cbiAgICAgICAgc2VsZWN0aW9uID0gbXNnLnNlbGVjdGlvbjtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBtc2cudGV4dC50cmltKCk7XG4gICAgICAgIGlmICghdGV4dCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWwgPSBtc2cud2l0aFNlbGVjdGlvbiA/IHNlbGVjdGlvbiA6IG51bGw7XG4gICAgICAgIGNvbnN0IGFjdGl2ZVBhdGggPSBzZWwgPyBzZXNzaW9uLmFjdGl2ZVBhdGgoc2VsLmRvYykgOiBzZXNzaW9uLmFjdGl2ZVBhdGgoKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImh1bWFuXCIsIHRleHQsIHsgc2VsZWN0aW9uOiBzZWwsIGFjdGl2ZVBhdGggfSk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICBtZXNzYWdlX2lkOiBtLmlkLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgc2VsZWN0aW9uOiBzZWwsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZihzZWw/LmRvYyksXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgYWN0aXZhdGUobXNnLmRvYywgbXNnLnZlcnNpb24sIFwiaHVtYW5cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXZlXCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uc2F2ZShtc2cuZG9jKTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCBgU2F2ZWQgdiR7ci52ZXJzaW9ufSB0byAke3Iub3JpZ2luYWx9LmApO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJzYXZlZFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgb3JpZ2luYWw6IHIub3JpZ2luYWwsXG4gICAgICAgICAgdHM6IG0udHMsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicmV2ZXJ0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmV2ZXJ0KG1zZy5kb2MpO1xuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiByLnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogci50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXG4gICAgICAgICAgXCJzeXN0ZW1cIixcbiAgICAgICAgICBgUmV2ZXJ0ZWQgdiR7ci52ZXJzaW9ufSBvZiAke21zZy5kb2N9IHRvIHRoZSBzYXZlZCBmaWxlLmAsXG4gICAgICAgICk7XG4gICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJyZXZlcnRlZFwiLCBkb2M6IG1zZy5kb2MsIHZlcnNpb246IHIudmVyc2lvbiwgdHM6IG0udHMgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOlxuICAgICAgICBhZGRQYXRocyhbbXNnLnBhdGhdKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImNvbnRleHQucmVtb3ZlXCI6XG4gICAgICAgIHNlc3Npb24ucmVtb3ZlQ29udGV4dChtc2cuaWQpO1xuICAgICAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImZzLmxpc3RcIjoge1xuICAgICAgICBjb25zdCBwYXRoID0gZXhwYW5kSG9tZShtc2cucGF0aCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJmcy5saXN0XCIsIHBhdGg6IG1zZy5wYXRoLCBlbnRyaWVzOiBsaXN0RGlyKHBhdGgpIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZnMubGlzdFwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBlbnRyaWVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYWN0aXZlT2YgPSAoZG9jPzogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qgc2x1ZyA9IGRvYyA/PyBzZXNzaW9uLm9wZW5Eb2NTbHVnO1xuICAgIGlmICghc2x1ZykgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBzZXNzaW9uLmRvYyhzbHVnKTtcbiAgICAgIHJldHVybiB7IGRvYzogdi5zbHVnLCB2ZXJzaW9uOiB2LmFjdGl2ZSwgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHYuc2x1ZykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gYWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgYWRkZWQgPSBhZGRQYXRocyhjbWQucGF0aHMpO1xuICAgICAgICByZXR1cm4geyBlbnRyaWVzOiBhZGRlZC5tYXAoKGEpID0+ICh7IC4uLmEuZW50cnksIGFkZGVkOiBhLmFkZGVkIH0pKSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24ubmV3XCI6IHtcbiAgICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCA3OiB0aGUgYWdlbnQgbWF5IG5hbWUgYSBkb2MgdGhlIGh1bWFuIGhhcyBub3RcbiAgICAgICAgLy8gb3BlbmVkLCBieSBBQlNPTFVURSBwYXRoICh0aGUgQ0xJIHJlc29sdmVzIGl0IGFnYWluc3QgaXRzIG93biBjd2QpO1xuICAgICAgICAvLyBpdCBpcyBvcGVuZWQgaW1wbGljaXRseSB1bmRlciB0aGUgc2FtZSBhZG1pc3Npb24gcnVsZSBhcyB0aGVcbiAgICAgICAgLy8gc3VyZmFjZSdzIGBvcGVuYCDigJQgYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkg4oCUIHdpdGhvdXRcbiAgICAgICAgLy8gbW92aW5nIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAgICAgIGlmIChjbWQuZG9jICYmIGlzQWJzb2x1dGUoY21kLmRvYykgJiYgIXNlc3Npb24uZmluZERvYyhjbWQuZG9jKSkge1xuICAgICAgICAgIGNvbnN0IG8gPSBzZXNzaW9uLm9wZW5QYXRoKGNtZC5kb2MsIHsgZm9jdXM6IGZhbHNlIH0pO1xuICAgICAgICAgIGlmIChvLmNyZWF0ZWQpXG4gICAgICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9jLm9wZW5lZFwiLFxuICAgICAgICAgICAgICBkb2M6IG8uc2x1ZyxcbiAgICAgICAgICAgICAgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKG8uc2x1ZyksXG4gICAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IGNtZC5kb2MsXG4gICAgICAgICAgZnJvbTogY21kLmZyb20sXG4gICAgICAgICAgbGFiZWw6IGNtZC5sYWJlbCxcbiAgICAgICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBjcmVhdGVkIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke2NtZC5sYWJlbCA/IGAg4oCUICR7Y21kLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiwgZnJvbTogci52ZXJzaW9uLmZyb20sIHBhdGg6IHIudmVyc2lvbi5wYXRoIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImFnZW50XCIsIGNtZC50ZXh0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgaWQ6IG0uaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICByZXR1cm4gYWN0aXZhdGUoY21kLmRvYywgY21kLnZlcnNpb24sIFwiYWdlbnRcIik7XG4gICAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KChjbWQgYXMgeyB0eXBlPzogdW5rbm93biB9KS50eXBlKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgICBbXCJjb250ZXh0LmFkZFwiLCBcInZlcnNpb24ubmV3XCIsIFwic2F5XCIsIFwiYWN0aXZhdGVcIiwgXCJjbG9zZVwiXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gc2Vzc2lvbi52aWV3KG1vZGUsIHNlbGVjdGlvbik7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiBzZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgbG9nLmVtaXQoeyB0eXBlOiBcInJlYWR5XCIsIG1vZGUsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiAob3B0cy50aW1lb3V0UyA/PyAxODAwKSAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICB9KTtcblxuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lIOKAlCBmaW5lICovXG4gICAgfVxuICAgIHVubGlua0lmTWF0Y2hlcyhsYXRlc3RGaWxlLCBzZXNzaW9uSWQsIChyYXcpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlkID0gKEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiB1bmtub3duIH0pLnNlc3Npb25faWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGhlIG9yZGVyIGlzIHRoZSBoZWFkZXIncywgYW5kIHRoZSBoZWFkZXIgc2F5cyB3aHkuXG4gIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2F0Y2hlcnMudmFsdWVzKCkpIHcuY2xvc2UoKTtcbiAgICB3YXRjaGVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdCBvZiBwZW5kaW5nLnZhbHVlcygpKSBjbGVhclRpbWVvdXQodCk7XG4gICAgdHJ5IHtcbiAgICAgIHNlc3Npb24ucGVyc2lzdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgY2xlYW51cERpc2NvdmVyeSgpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJjbG9zZWRcIiB9KTtcbiAgICB2b2lkIGRyYWluQW5kU3RvcCh7IHNlcnZlciwgY2xpZW50czogc3NlQ2xpZW50cywgc29ja2V0cyB9KS50aGVuKHJlc29sdmVTaHV0ZG93bik7XG4gIH07XG4gIGRvbmUudGhlbigoKSA9PiBjbG9zZSgpKTtcblxuICByZXR1cm4geyBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25JZCwgbW9kZSwgZGlyOiBzZXNzaW9uLmRpciwgY2xvc2UsIGRvbmUsIHNodXRkb3duIH07XG59XG5cbi8qKiBBbiBhYnNlbnQgT3JpZ2luICh0aGUgQ0xJLCBjdXJsKSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlOyBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtZU9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBjb25zdCBvcmlnaW4gPSByZXEuaGVhZGVycy5nZXQoXCJvcmlnaW5cIik7XG4gIGlmIChvcmlnaW4gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gb3JpZ2luID09PSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCB8fCBvcmlnaW4gPT09IGBodHRwOi8vbG9jYWxob3N0OiR7cG9ydH1gO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gVGhlIGhhbmRzaGFrZSBsaW5lIGlzIEpTT04gZWl0aGVyIHdheSwgc28gdGhlIENMSSByZWFkcyBPTkUgc2hhcGUuXG4gICAgY29uc3Qgc3RhdHVzID0gZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvciA/IGUuc3RhdHVzIDogNTAwO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIHN0YXR1cywgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIHN0YXR1cyA9PT0gNDA0ID8gNSA6IHN0YXR1cyA9PT0gNDA5ID8gNiA6IDE7XG4gIH1cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZC5wb3J0fWAsIHBvcnQ6IGQucG9ydCwgc2Vzc2lvbl9pZDogZC5zZXNzaW9uSWQsIG1vZGU6IGQubW9kZSwgZGlyOiBkLmRpciB9KX1cXG5gLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBkLmRvbmU7XG4gIGF3YWl0IGQuc2h1dGRvd247XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiBhIGNsZWFuIGNsb3NlIGxlYXZlcyBubyBlbXB0eSBsb2cgYmVoaW5kLlxuICBpZiAocmVzLmNvZGUgPT09IDAgJiYgZmxhZ3MubG9nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChzdGF0U3luYyhmbGFncy5sb2cpLnNpemUgPT09IDApIHVubGlua1N5bmMoZmxhZ3MubG9nKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzLmNvZGU7XG59XG5cbi8qKlxuICogVGhlIGRhZW1vbidzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSLiBgaW1wb3J0Lm1ldGEubWFpbmAgaXMgRkFMU0UgaW4gdGhlXG4gKiBidW5kbGUsIHNvIHRoZXJlIGlzIG5vIHN1Y2ggYmxvY2sgaGVyZSwgYW5kIHRoaXMgdGFrZXMgbm8gYXJndW1lbnRzOiB0aGVcbiAqIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHR3byBwcmltaXRpdmVzIHVuZGVyIEJPVEggb2YgdGhlIGhvdXNlJ3MgZGFlbW9uLWRpc2NvdmVyeSBjb252ZW50aW9ucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIEQzIHJ1bGVkIHRoYXQgdGhlIGNvbnZlbnRpb25zIHRoZW1zZWx2ZXMg4oCUIHBlci1zZXNzaW9uIHRtcGRpciBKU09OIChib3VudHksXG4gKiBnbGFtb3VyLCBpbWFnbywgbWFncGllKSBhbmQgc2luZ2xldG9uIGAkSE9NRS9kYWVtb24ucG9ydGAgKyBgZGFlbW9uLnBpZGBcbiAqIChhc3Ryb2xhYmUsIGdyYXBldmluZSwgbWluZC1tYXBwZXIpIOKAlCBib3RoIHN1cnZpdmUsIGJlY2F1c2UgdGhleSBlbmNvZGVcbiAqIGdlbnVpbmVseSBkaWZmZXJlbnQgbW9kZWxzIChjb25jdXJyZW50IHNlc3Npb25zIHZzIGEgc3RhbmRpbmcgc2luZ2xldG9uKSBhbmRcbiAqIHBpY2tpbmcgb25lIGlzIGEgcHJvZHVjdCBkZWNpc2lvbiwgbm90IGEgZmFjdG9yaW5nIG9uZS4gV2hhdCBJUyBvbmVcbiAqIGltcGxlbWVudGF0aW9uIGlzIHRoZSBwYWlyIGJlbG93LCB3aGljaCBpcyBhbHNvIGV4YWN0bHkgd2hlcmUgY2Vuc3VzIGRlZmVjdFxuICogKipMMyoqIGxpdmVzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuLyoqXG4gKiBXcml0ZSBgdGV4dGAgdG8gYHRhcmdldGAgYXRvbWljYWxseTogd3JpdGUgYmVzaWRlIGl0LCB0aGVuIHJlbmFtZS5cbiAqXG4gKiDim5QgKipMMywgQ0xPU0VEIEJZIENPTlNUUlVDVElPTi4qKiBBIGJhcmUgYHdyaXRlRmlsZVN5bmNgIGlzIG5vdCBhdG9taWMsIHNvIGFcbiAqIENMSSByZWFkaW5nIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgSEFMRi1XUklUVEVOIHBvaW50ZXIuIFVuZGVyXG4gKiBhIGJlc3QtZWZmb3J0IHJlYWRlciB0aGF0IHN1cmZhY2VkIGFzIFwibm8gcnVubmluZyBzZXNzaW9uXCIg4oCUIGFic2VuY2UgcmVwb3J0ZWRcbiAqIGZvciB3aGF0IHdhcyByZWFsbHkgYSB0b3JuIHJlYWQsIHdoaWNoIGlzIHRoZSBleGFjdCBjb25mbGF0aW9uIHRoZSBob3VzZSdzXG4gKiBgbnVsbGAtbm90LWAwYCBydWxlIGV4aXN0cyB0byBwcmV2ZW50LiBSZW5hbWUgd2l0aGluIG9uZSBkaXJlY3RvcnkgaXMgYXRvbWljLFxuICogc28gYSByZWFkZXIgc2VlcyBlaXRoZXIgdGhlIHByZXZpb3VzIHBvaW50ZXIgb3IgdGhlIG5ldyBvbmUsIG5ldmVyIGEgcGFydGlhbFxuICogZmlsZS5cbiAqXG4gKiBGaXhlZCBpbiBnbGFtb3VyIDIwMjYtMDktMDcsIGZvdW5kIHN0YW5kaW5nIGluIHRocmVlIHNpYmxpbmdzIHRoZSBuZXh0IGRheSBieVxuICogdGhlIGR1cGxpY2F0aW9uIHJlY29uLCBhbmQgcmVwYWlyZWQgaW4gYWxsIG9mIHRoZW0gdGhlIG9ubHkgd2F5IHRoYXQgZG9lcyBub3RcbiAqIG5lZWQgZmluZGluZyBhZ2FpbjogdGhlcmUgaXMgbm93IG9uZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiDimqAgVGhlIHRlbXAgbmFtZSBjYXJyaWVzIHRoZSBwaWQsIHNvIHR3byBkYWVtb25zIHJhY2luZyB0byBwdWJsaXNoIHRoZSBzYW1lXG4gKiBwb2ludGVyIGNhbm5vdCBjbG9iYmVyIGVhY2ggb3RoZXIncyBpbnRlcm1lZGlhdGUgZmlsZSDigJQgYW5kIGl0IGlzIHJlbW92ZWQgb25cbiAqIGEgZmFpbGVkIHdyaXRlIHJhdGhlciB0aGFuIGxlZnQgYXMgbGl0dGVyIGJlc2lkZSB0aGUgcmVhbCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUZpbGVBdG9taWModGFyZ2V0OiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCB0bXAgPSBgJHt0YXJnZXR9LiR7cHJvY2Vzcy5waWR9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIHRleHQpO1xuICAgIHJlbmFtZVN5bmModG1wLCB0YXJnZXQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKHRtcCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHRoZSB0ZW1wIGZpbGUgaXMgYWxyZWFkeSBnb25lLCBvciB3YXMgbmV2ZXIgY3JlYXRlZCAqL1xuICAgIH1cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGUgYHBhdGhgIGlmZiBpdCBzdGlsbCBuYW1lcyBVUy4gUmV0dXJucyB3aGV0aGVyIGl0IHdhcyBkZWxldGVkLlxuICpcbiAqIOKblCAqKlwiU1RJTEwgT1VSU1wiIElTIFRIRSBXSE9MRSBGVU5DVElPTi4qKiBBIGRhZW1vbiB0aGF0IHVubGlua3MgaXRzIGRpc2NvdmVyeVxuICogZmlsZSB1bmNvbmRpdGlvbmFsbHkgYXQgZXhpdCBkZWxldGVzIHRoZSBwb2ludGVyIGEgU1VDQ0VTU09SIGhhcyBhbHJlYWR5XG4gKiB3cml0dGVuIOKAlCB0aGUgc3VjY2Vzc29yIGNhbiB0aGVuIG5vIGxvbmdlciBiZSBmb3VuZCBhbmQgdGhlIG5leHQgQ0xJIHZlcmIgc3Bhd25zIGFcbiAqIHRoaXJkIGRhZW1vbi4gQm90aCBjb252ZW50aW9ucyBoYXZlIHRoaXMgaGF6YXJkIGFuZCBib3RoIGV4cHJlc3MgaXRcbiAqIGRpZmZlcmVudGx5OiBhc3Ryb2xhYmUgY29tcGFyZXMgdGhlIHBpZCBmaWxlJ3MgYnl0ZXMgdG8gaXRzIG93biBwaWQsXG4gKiBtYWdwaWUgcGFyc2VzIHRoZSBKU09OIHBvaW50ZXIgYW5kIGNvbXBhcmVzIGBzZXNzaW9uX2lkYC4gYGlkZW50aWZ5YCBpcyB3aGF0XG4gKiBtYWtlcyB0aG9zZSBvbmUgZnVuY3Rpb24g4oCUIGl0IHR1cm5zIHRoZSBmaWxlJ3MgYnl0ZXMgaW50byB0aGUgaWRlbnRpdHkgdG9cbiAqIGNvbXBhcmUsIGFuZCBpdCBkZWZhdWx0cyB0byB0aGUgdHJpbW1lZCBieXRlcyB0aGVtc2VsdmVzLlxuICpcbiAqIOKaoCBFdmVyeSBmYWlsdXJlIGlzIHN3YWxsb3dlZCBhbmQgcmVwb3J0ZWQgYXMgYGZhbHNlYDogdGhlIGZpbGUgYmVpbmcgZ29uZSxcbiAqIHVucmVhZGFibGUsIG9yIHVucGFyc2VhYmxlIGFsbCBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmUg4oCUIGl0IGlzIG5vdCBvdXJzIHRvXG4gKiByZW1vdmUuIEFuIHVucGFyc2VhYmxlIHBvaW50ZXIgaXMgZGVsaWJlcmF0ZWx5IE5PVCB0cmVhdGVkIGFzIG91cnMsIHdoaWNoIGlzXG4gKiB0aGUgY29uc2VydmF0aXZlIGhhbGYgb2YgdGhlIHNhbWUgYG51bGxgLW5vdC1gMGAgcnVsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVubGlua0lmTWF0Y2hlcyhcbiAgcGF0aDogc3RyaW5nLFxuICBleHBlY3RlZDogc3RyaW5nLFxuICBpZGVudGlmeTogKHJhdzogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsID0gKHJhdykgPT4gcmF3LnRyaW0oKSxcbik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpZGVudGlmeShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSAhPT0gZXhwZWN0ZWQpIHJldHVybiBmYWxzZTtcbiAgICB1bmxpbmtTeW5jKHBhdGgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgaW4tcHJvY2VzcyBldmVudCBsb2cg4oCUIHRoZSBhcHBlbmQtb25seSwgcmVwbGF5YWJsZSBidWZmZXJcbiAqIGJlaGluZCBldmVyeSBzcGVsbCdzIGBHRVQgL2V2ZW50c2AgU1NFIHRhaWwuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXInc1xuICogYHNjcmlwdHMvZXZlbnRzLnRzYCDigJQgdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMiwgYW5kIHRoZSBvbmx5IG9uZSBvZlxuICogdGhlIHNpeCBjb3BpZWQtaW4tcGxhY2UgYnVzZXMgdGhhdCBpcyBhIG1vZHVsZSwgaXMgYm91bmRlZCwgY2FycmllcyBhbiBlcG9jaCwgYW5kIGlzXG4gKiB1bml0LXRlc3RlZC4gVGhlIGZpdmUgb3RoZXJzIGFyZSB0aGUgc2FtZSB0d2VudHkgbGluZXMgd3JpdHRlbiBmaXZlIHRpbWVzLlxuICpcbiAqIOKUgOKUgCBUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMg4oCUIFRXTyBCWSBDT05TVFJVQ1RJT04sIE9ORSBCWSBPUFQtSU4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICog4puUIFRIRSBIRUFESU5HIFVTRUQgVE8gU0FZIFwiVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIEJZIENPTlNUUlVDVElPTlwiIEFORFxuICogSVRFTSAyIElTIE5PVCBPTkUgT0YgVEhFTS4gQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gbWluZC1tYXBwZXIncyBwcmUtd29ya1xuICogKEQ3OSk6IGBlcG9jaGAgaXMgT1BUSU9OQUwgaGVyZSwgc28gTDYgaXMgY2xvc2VkIG9ubHkgZm9yIGEgY2FsbGVyIHRoYXQgYXNrcy5cbiAqIFRocmVlIGFkb3B0ZXJzIGhhdmUgc2luY2UgZGVjbGluZWQgdG8g4oCUIGltYWdvIChEMzkpLCBib3VudHkgKEQ0OCkgYW5kXG4gKiBncmFwZXZpbmUgKEQ3MCkg4oCUIHNvIHRoZSBkZWZlY3QgdGhlIGhlYWRpbmcgY2xhaW1lZCB0byBtYWtlIGltcG9zc2libGUgaXNcbiAqIGxpdmUgaW4gdGhlIHRyZWUsIGJ5IG9wdC1vdXQsIGFuZCB0aGUgb3ZlcmNsYWltIGlzIHdoYXQgaGlkIHRoYXQuIEl0ZW1zIDEgYW5kXG4gKiAzIEFSRSBieSBjb25zdHJ1Y3Rpb246IGEgY2FsbGVyIGNhbm5vdCBzd2l0Y2ggdGhlIGNhcCBvZmYgb3IgcmVhY2ggdGhlIGJ1ZmZlci5cbiAqXG4gKiDimqAgQU5EIE1JTkQtTUFQUEVSJ1MgT1dOIEJVUywgV0hJQ0ggVEhJUyBNT0RVTEUgQ09OVkVSR0VEIFRPV0FSRCwgVFlQRVMgVEhFXG4gKiBFUE9DSCBBUyBSRVFVSVJFRCBhbmQgc3RhbXBzIGl0IHVuY29uZGl0aW9uYWxseSDigJQgaXQgaXMgdGhlIHNwZWxsIGNlbnN1cyBMNlxuICogbmFtZXMgYXMgQ09SUkVDVC4gTWFraW5nIGl0IHJlcXVpcmVkIEhFUkUgaXMgbm90IHRoZSByZXBhaXI6IGl0IHdvdWxkIHJldmVyc2VcbiAqIEQzOSwgRDQ4IGFuZCBENzAuIFRoZSBob25lc3Qgc3RhdGVtZW50IGlzIHRoaXMgaGVhZGluZy5cbiAqXG4gKiDim5QgKipSRVNPTFZFRCBBVCBUSEFUIFNQRUxMJ1MgUE9SVCwgQU5EIFRIRSBESVNQT1NJVElPTiBJUyBSRUNPUkRFRCBIRVJFXG4gKiBCRUNBVVNFIEEgTE9TUyBUSEFUIExJVkVTIE9OTFkgSU4gQSBKT1VSTkFMIElTIEEgTE9TUyBOT0JPRFkgQ0FOIFNFRVxuICogKEQ3OS9EODUpLioqIG1pbmQtbWFwcGVyIGFkb3B0ZWQgdGhpcyBtb2R1bGUgaW4gUGhhc2UgNyBhbmQga2VwdCBpdHNcbiAqIGd1YXJhbnRlZSBXSVRIT1VUIEEgS0lUIENIQU5HRTogaXQgcGFzc2VzIGB7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH1gIGF0XG4gKiBpdHMgT05FIGNvbnN0cnVjdGlvbiBzaXRlIGFuZCByZS10aWdodGVucyBgZXBvY2hgIHRvIFJFUVVJUkVEIGluIGl0cyBvd25cbiAqIGxvY2FsIGZyYW1lIHR5cGUsIHNvIG5vdGhpbmcgaXRzIGJ1cyBlbWl0cyBjYW4gbGFjayBvbmUuIEtpdCBieXRlczogemVyby5cbiAqICoqU28gdGhlIGVwb2NoIGlzIGEgTE9TU1ktQ09QWSBwcm9wZXJ0eSB3aG9zZSBkaXNwb3NpdGlvbiBpcyBLRUVQLUxPQ0FMLCBub3RcbiAqIFJFU1RPUkUqKiDigJQgdGhlIG9ubHkgcHJvcGVydHkgb2YgdGhhdCBzcGVsbCdzIG93biBtb2R1bGUgdGhpcyBtb2R1bGUgY291bGRcbiAqIG5vdCBjYXJyeSBhbmQgZGlkIG5vdCBuZWVkIHRvLiBMNiBpcyBDTE9TRUQgZm9yIHRoZSB0d28gc3BlbGxzIHRoYXQgYXNrIGFuZFxuICogT1BFTiwgYnkgb3B0LW91dCwgZm9yIHRoZSB0aHJlZSB0aGF0IGRlY2xpbmU7IHRoYXQgYXN5bW1ldHJ5IGlzIHRoZSBob25lc3RcbiAqIHN0YXRlIGFuZCB0aGlzIGhlYWRpbmcgaXMgd2hlcmUgaXQgaXMgd3JpdHRlbi5cbiAqXG4gKiDimqAgKipBTkQgVEhFIEFET1BUSU9OIFJFTkFNRVMgQSBGSUVMRCBPTiBBTiBBRE9QVEVSJ1MgUFVCTElTSEVEIFdJUkUuKiogYGlkYFxuICogaXMgbmFtZWQgaW4gYEZyYW1lPFQ+YCBhbmQgaW4gdGhlIGVtaXQgbGl0ZXJhbCBiZWxvdywgc28gYSBzcGVsbCB3aG9zZSBidXNcbiAqIHNwZWxsZWQgdGhlIGN1cnNvciBhbnl0aGluZyBlbHNlIHBheXMgYSByZW5hbWUgYXQgZXZlcnkgcmVhZGVyIOKAlCBmb3JcbiAqIG1pbmQtbWFwcGVyLCAxNzMgb2NjdXJyZW5jZXMgYWNyb3NzIDUgc3VyZmFjZSBmaWxlcywgfjIwOSBhY3Jvc3MgfjMwIGJhY2tlbmRcbiAqIGZpbGVzLCBldmVyeSBKU09OTCBsaW5lIGl0cyBgdGFpbGAgd3JpdGVzIGludG8gYW4gYWdlbnQncyBwaXBlLCBhbmQgKHRoZSBvbmVcbiAqIG5vYm9keSBjb3VudGVkKSB0aGUgRklYVFVSRSBpbiBpdHMgb3duIGB0YWlsLnRlc3QudHNgLCB3aGljaCBXUklURVMgdGhlXG4gKiBlbnZlbG9wZSB3aGlsZSBzdGFuZGluZyBpbiBmb3IgdGhlIGRhZW1vbi4gVGhlIE5FU1RJTkcgaXMgbm90IGZvcmNlZCDigJRcbiAqIGBGcmFtZTxUPmAgaXMgZ2VuZXJpYywgYW5kIG1pbmQtbWFwcGVyIGtlcHQgYHtraW5kLCBwYXlsb2FkfWAgbmVzdGVkIHdoZXJlIGFsbFxuICogZml2ZSBlYXJsaWVyIGFkb3B0ZXJzIGZsYXR0ZW4gYnkgaWRpb20uICoqQW4gaWRpb20gZml2ZSBzaWJsaW5ncyBzaGFyZSBpc1xuICogaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGNvbnRyYWN0IHVudGlsIHlvdSBvcGVuIHRoZSB0eXBlKiogKEQ4MSwgRDg2KS5cbiAqXG4gKiAqKjEgwrcgTDUg4oCUIHRoZSBidWZmZXIgaXMgYm91bmRlZC4qKiBGaXZlIGRhZW1vbnMgYXBwZW5kIHRvIGFuIGFycmF5IGZvciB0aGVcbiAqIHdob2xlIGxpZmUgb2YgdGhlIHByb2Nlc3MuIFRoZSB3aW5kb3cgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqIGRhZW1vbidzIGxpZmV0aW1lLCBub3QgYSBkdXJhYmxlIGxvZzsgYSBjYXAgaXMgdGhlIGhvbmVzdCBzaGFwZS5cbiAqXG4gKiAqKjIgwrcgTDYg4oCUIGEgZnJhbWUgY2FycmllcyBhbiBlcG9jaCwgV0hFTiBUSEUgQ0FMTEVSIEFTS1MgRk9SIE9ORSAob3B0LWluLFxuICogbm90IGNvbnN0cnVjdGlvbiDigJQgc2VlIGFib3ZlKS4qKiBBZnRlciBhIHJlc3RhcnQgdGhlIGlkcyBzdGFydCBhZ2FpbiBhdCAxLCBzb1xuICogYSByZXN1bWluZyBjbGllbnQgY2Fubm90IHRlbGwgYSBzdGFsZSB3YXRlcm1hcmsgZnJvbSBhIGZyZXNoIG9uZSBieSBpZCBhbG9uZS5cbiAqXG4gKiAqKjMgwrcgQSBTVEFMRSBXQVRFUk1BUksgUkVQTEFZUyBGUk9NIFRIRSBCRUdJTk5JTkcsIGFuZCB0aGlzIGlzIHRoZSBoYWxmIHRoZVxuICogY2xpZW50IGNhbm5vdCBkby4qKiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IGEgdGFpbCB0aGF0IHJlc3VtZXMgYXRcbiAqIGBzaW5jZT08bGFzdCBpZCBvZiB0aGUgcHJldmlvdXMgZGFlbW9uPmAgYWdhaW5zdCBhIHJlc3RhcnRlZCBkYWVtb24gcmVjZWl2ZXNcbiAqIE5PVEhJTkcg4oCUIHRoZSBuZXcgZGFlbW9uJ3MgYHJlYWR5YCBpcyBpZCAxLCB3aGljaCBpcyBub3QgYD4gc2luY2VgLCBzbyB0aGVcbiAqIGZpbHRlciBkcm9wcyBpdCwgc28gbm8gZnJhbWUgYXJyaXZlcywgc28gdGhlIGNsaWVudCdzIGVwb2NoIGNoZWNrIG5ldmVyIHJ1bnNcbiAqIGFuZCB0aGUgdGFpbCBzaXRzIGNvbm5lY3RlZCBhbmQgc2lsZW50IHVudGlsIHRoZSBuZXcgZGFlbW9uIGhhcyBlbWl0dGVkIGFzXG4gKiBtYW55IGV2ZW50cyBhcyB0aGUgb2xkIG9uZSBkaWQuIFN0YW1waW5nIGFuIGVwb2NoIGFsb25lIGRvZXMgTk9UIGNsb3NlIHRoYXRcbiAqIGdhcDogdGhlIGVwb2NoIHJpZGVzIGEgZnJhbWUsIGFuZCB0aGUgYnVnIGlzIHRoYXQgbm8gZnJhbWUgaXMgc2VudC4gU29cbiAqIGBzdWJzY3JpYmVgIHRyZWF0cyBgc2luY2UgPiBjdXJzb3JgIGFzIFwidGhpcyBjdXJzb3IgaXMgZnJvbSBhbm90aGVyIHByb2Nlc3NcIlxuICogYW5kIHJlcGxheXMgd2hvbGUuIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC90YWlsLnRlc3QudHNgJ3MgZXBvY2ggY2VsbCBpcyB0aGVcbiAqIGV4ZWN1dGFibGUgc3BlYyBvZiB0aGUgY2xpZW50IGhhbGYgYW5kIHNob3dzIHRoZSByZWNvbm5lY3Qgc3RpbGwgY2FycnlpbmcgdGhlXG4gKiBzdGFsZSBjdXJzb3Ig4oCUIGRldGVjdGlvbiBoYXBwZW5zIG9uIHdoYXQgaXMgUkVDRUlWRUQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS4gTm90XG4gKiBcIm5vIHN1YmplY3RcIiDigJQgZ3JhcGV2aW5lIEhBUyBhbiBldmVudCBidXMgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZVxuICogc3BlbGwg4oCUIGJ1dCB0aGUgdHdvIHNoYXBlcyBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIG9uZSBwcm9jZXNzLXdpZGUgYXJyYXkgY2FwcGVkIGF0IFJFUExBWV9CVUZGRVJfU0laRSwgd2l0aCBvbmVcbiAqICAgICAgICAgICAgICAgIG1vbm90b25pYyBgc2VxYCwgYW5kIHRoZSBoZWFkZXIgdGhyZWUgcGFyYWdyYXBocyB1cCBzYXlzIGluIGFzXG4gKiAgICAgICAgICAgICAgICBtYW55IHdvcmRzIHRoYXQgaXQgaXMgYSBSRVBMQVkgd2luZG93IGZvciByZWNvbm5lY3RzIHdpdGhpbiBvbmVcbiAqICAgICAgICAgICAgICAgIGRhZW1vbidzIGxpZmV0aW1lLCBOT1QgYSBkdXJhYmxlIGxvZy5cbiAqICAgZ3JhcGV2aW5lICAgIE4gZHVyYWJsZSBhcHBlbmQtb25seSBgLmpzb25sYCBmaWxlcywgb25lIHBlciBuYW1lZCBjaGFubmVsLFxuICogICAgICAgICAgICAgICAgZWFjaCB3aXRoIGl0cyBvd24gYG5leHRfaWRgLCByZXBsYXllZCBmcm9tIGRpc2sgYnlcbiAqICAgICAgICAgICAgICAgIGByZWFkQmFja2xvZ2AsIHN1cnZpdmluZyByZXN0YXJ0LCBgcm9sbGAsIGFyY2hpdmUgYW5kIGNsZWFyLlxuICpcbiAqICoqVGhlIHJlYWRlciB0aGF0IG1ha2VzIHRoZW0gaW5jb21wYXRpYmxlLCBhcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuXG4gKiBhc3NlcnRpb246KiogZ3JhcGV2aW5lJ3MgYGxvYWRDaGFubmVsKClgIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgSElHSC1XQVRFUlxuICogTUFSSyBvdmVyIGV2ZXJ5IHBhcnNlYWJsZSBsaW5lIG9mIHRoZSBjaGFubmVsJ3MgZmlsZSBvbiBib290LiBUaGVyZSBpcyBub1xuICogYXJyYXkgdG8gYmUgdGhhdCBtYXJrIG9mLCBhbmQgbm8gY2FwIHRoYXQgd291bGQgbm90IHNpbGVudGx5IGRpc2NhcmQgaGlzdG9yeVxuICogYSBjYWxsZXIgY2FuIHN0aWxsIGFzayBmb3IgYnkgaWQuIEl0IGlzIHRoZSB0aGluZyB0aGlzIG1vZHVsZSdzIG93biBoZWFkZXJcbiAqIHNheXMgaXQgaXMgZGVsaWJlcmF0ZWx5IG5vdC5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYSBwZXItY2hhbm5lbCBkdXJhYmxlXG4gKiBzdG9yZSB3b3VsZCBjaGFuZ2UgYGNyZWF0ZUV2ZW50TG9nYCdzIHN0b3JhZ2UgYW5kIGl0cyBgc3Vic2NyaWJlYCBjb250cmFjdCBmb3JcbiAqIGZpdmUgb3RoZXIgZGFlbW9ucywgcmUtZW1pdHRpbmcgU0lYIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhXG4gKiBkcml2ZSDigJQgcGFpZCBieSBwb3J0cyB0aGF0IGFyZSBhbHJlYWR5IGZpbmlzaGVkIGFuZCBieSBhZ2VudHMgbm90IGluIHRoZSByb29tLlxuICogQSB3aWRlbmluZyByZW1haW5zIGF2YWlsYWJsZSBhcyBpdHMgb3duIGFyZ3VlZCBkZWNpc2lvbiB3aXRoIGl0cyBvd25cbiAqIGJsYXN0LXJhZGl1cyBjb3VudDsgaXQgaXMgbmV2ZXIgYSBzdGVwIGluc2lkZSBhIHBvcnQuXG4gKlxuICog4pqgIEFORCBUSEUgYGVwb2NoYCBBQk9WRSBJUyBUSEUgU0hBUlBFU1QgSEFMRiBPRiBXSFkgKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmVcbiAqIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0LCBzbyB0aGUgY29uZGl0aW9uIHBhcmFncmFwaCAyIGRlc2NyaWJlcyDigJQgaWRzXG4gKiBzdGFydGluZyBhZ2FpbiBhdCAxIOKAlCBjYW5ub3Qgb2NjdXIgdGhlcmUsIGFuZCBzdGFtcGluZyBvbmUgYW55d2F5IGlzIG5vdFxuICogaW5lcnQ6IGB0YWlsRXZlbnRzYCdzIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIHRoZSBjdXJzb3IgdG8gMCwgYW5kIGdyYXBldmluZSdzXG4gKiB0YWlsIHJvdXRlIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGggdGhlIFdIT0xFIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuXG4gKiBhZ2VudCdzIHBpcGUsIG9uIGV2ZXJ5IGByb2xsYC4gVGhlIGVwb2NoJ3MgY2xpZW50LXNpZGUgYWN0aW9uIGlzIFwieW91ciBjdXJzb3JcbiAqIGlzIHdvcnRobGVzcywgc3RhcnQgb3ZlclwiLCBhbmQgdGhhdCBpcyBzYWZlIG9ubHkgd2hlcmUgc3RhcnRpbmcgb3ZlciBjb3N0cyBhXG4gKiBib3VuZGVkIGluLW1lbW9yeSByZXBsYXkgd2luZG93LlxuICovXG5cbi8qKiBUaGUgZGVmYXVsdCByZXBsYXkgd2luZG93LCBpbmhlcml0ZWQgZnJvbSBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIGNhcC4gKi9cbmV4cG9ydCBjb25zdCBSRVBMQVlfQlVGRkVSX1NJWkUgPSAxMDAwO1xuXG4vKiogQSBmcmFtZSBhcyBpdCBnb2VzIG9uIHRoZSB3aXJlOiB0aGUgY2FsbGVyJ3MgcGF5bG9hZCBwbHVzIGEgbW9ub3RvbmljIGBpZGAsXG4gKiAgcGx1cyBhbiBgZXBvY2hgIHdoZW4gdGhlIGxvZyB3YXMgZ2l2ZW4gb25lLiAqL1xuZXhwb3J0IHR5cGUgRnJhbWU8VD4gPSBUICYgeyBpZDogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50TG9nPFQ+IHtcbiAgLyoqIEFwcGVuZCBvbmUgZnJhbWUsIGZhbiBpdCBvdXQgdG8gbGl2ZSBzdWJzY3JpYmVycywgYW5kIHJldHVybiBpdC4gKi9cbiAgZW1pdChtc2c6IFQpOiBGcmFtZTxUPjtcbiAgLyoqXG4gICAqIFJlcGxheSBldmVyeXRoaW5nIGFmdGVyIGBzaW5jZWAsIHRoZW4gc3RheSBzdWJzY3JpYmVkLiBSZXR1cm5zIGFuXG4gICAqIHVuc3Vic2NyaWJlIGZ1bmN0aW9uLlxuICAgKlxuICAgKiDim5QgUkVQTEFZIEFORCBTVUJTQ1JJQkUgQVJFIE9ORSBDQUxMIE9OIFBVUlBPU0UuIERvaW5nIHRoZW0gaW4gdHdvIHN0ZXBzXG4gICAqIGxlYXZlcyBhIHdpbmRvdyBpbiB3aGljaCBhbiBlbWl0IGxhbmRzIGJldHdlZW4gdGhlIHJlcGxheSBsb29wIGFuZCB0aGVcbiAgICogYGFkZGAsIGFuZCB0aGF0IGZyYW1lIGlzIGRlbGl2ZXJlZCB0byBub2JvZHkg4oCUIHRoZSBzaGFwZSBmaXZlIGRhZW1vbnMgaGF2ZSxcbiAgICogc3Vydml2ZWQgYnkgbm90aGluZyBidXQgdGhlIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wIGhhcHBlbmluZyB0byBjbG9zZVxuICAgKiBpdC4gRGVwZW5kaW5nIG9uIHRoYXQgaXMgZGVwZW5kaW5nIG9uIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBvZiB0aGVcbiAgICogcnVudGltZSByYXRoZXIgdGhhbiBvbiB0aGUgY29kZS5cbiAgICovXG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogKGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZCk6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgaGlnaGVzdCBpZCBlbWl0dGVkIHNvIGZhciDigJQgd2hhdCBgR0VUIC9zdGF0ZWAgcmV0dXJucyBhcyBgY3Vyc29yYC4gKi9cbiAgY3Vyc29yKCk6IG51bWJlcjtcbiAgLyoqIFRoZSBlcG9jaCBzdGFtcGVkIG9uIGV2ZXJ5IGZyYW1lLCBvciBgdW5kZWZpbmVkYCBpZiBub25lIHdhcyBjb25maWd1cmVkLiAqL1xuICByZWFkb25seSBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXZlbnRMb2c8VCBleHRlbmRzIG9iamVjdD4oXG4gIG9wdHM6IHsgZXBvY2g/OiBzdHJpbmc7IGJ1ZmZlclNpemU/OiBudW1iZXIgfSA9IHt9LFxuKTogRXZlbnRMb2c8VD4ge1xuICBjb25zdCBidWZmZXJTaXplID0gb3B0cy5idWZmZXJTaXplID8/IFJFUExBWV9CVUZGRVJfU0laRTtcbiAgY29uc3QgZXBvY2ggPSBvcHRzLmVwb2NoO1xuICBjb25zdCBidWZmZXI6IEFycmF5PEZyYW1lPFQ+PiA9IFtdO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQ+KCk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIHJldHVybiB7XG4gICAgZXBvY2gsXG5cbiAgICBlbWl0KG1zZykge1xuICAgICAgc2VxICs9IDE7XG4gICAgICAvLyDim5QgVEhFIE1PTk9UT05JQyBJRCBXSU5TIE9WRVIgQU5ZVEhJTkcgSU4gVEhFIFBBWUxPQUQsIEFORCBVTlRJTCBOT1cgSVRcbiAgICAgIC8vIE9OTFkgQ0xBSU1FRCBUTy4gQm90aCBhZG9wdGluZyBkYWVtb25zIHdyb3RlIGB7IGlkOiArK3NlcSwgLi4ubXNnIH1gXG4gICAgICAvLyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nIFwidGhlIG1vbm90b25pYyBgaWRgIE1VU1Qgd2luIG92ZXIgYW55IGBpZGAgaW5cbiAgICAgIC8vIHRoZSBwYXlsb2FkLCBzbyBjYWxsZXJzIGNhcnJ5IGEgcHJvamVjdCBpZGVudGlmaWVyIGFzIGBwcm9qZWN0SWRgLFxuICAgICAgLy8gbmV2ZXIgYGlkYFwiIOKAlCBidXQgc3ByZWFkIG9yZGVyIG1lYW5zIGEgcGF5bG9hZCBgaWRgIG92ZXJyb2RlIHRoZVxuICAgICAgLy8gY3Vyc29yLCBzaWxlbnRseSwgYW5kIHRoZSBjb252ZW50aW9uIGluIHRoZSBjb21tZW50IHdhcyB0aGUgb25seSB0aGluZ1xuICAgICAgLy8gaG9sZGluZyBpdC4gVGhlIGxpdGVyYWwga2VlcHMgYGlkYCBGSVJTVCBzbyB0aGUgd2lyZSBrZXkgb3JkZXIgaXNcbiAgICAgIC8vIHVuY2hhbmdlZDsgdGhlIGFzc2lnbm1lbnQgYWZ0ZXIgdGhlIHNwcmVhZCBpcyB3aGF0IG1ha2VzIHRoZSBzZW50ZW5jZVxuICAgICAgLy8gdHJ1ZS4gYGVwb2NoYCBpcyBzdGFtcGVkIHRoZSBzYW1lIHdheSBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAgICAgIGNvbnN0IGZyYW1lID0geyBpZDogc2VxLCAuLi5tc2cgfSBhcyBGcmFtZTxUPjtcbiAgICAgIGZyYW1lLmlkID0gc2VxO1xuICAgICAgaWYgKGVwb2NoICE9PSB1bmRlZmluZWQpIGZyYW1lLmVwb2NoID0gZXBvY2g7XG5cbiAgICAgIGJ1ZmZlci5wdXNoKGZyYW1lKTtcbiAgICAgIGlmIChidWZmZXIubGVuZ3RoID4gYnVmZmVyU2l6ZSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgcmV0dXJuIGZyYW1lO1xuICAgIH0sXG5cbiAgICBzdWJzY3JpYmUoc2luY2UsIGxpc3RlbmVyKSB7XG4gICAgICAvLyBTZWUgdGhlIGhlYWRlciwgcG9pbnQgMzogYSBjdXJzb3IgYmV5b25kIG91ciBvd24gaXMgYSBjdXJzb3IgZnJvbSBhXG4gICAgICAvLyBQUklPUiBQUk9DRVNTLCBhbmQgdGhlIG9ubHkgdXNlZnVsIHJlYWRpbmcgb2YgaXQgaXMgXCJyZXBsYXkgd2hvbGVcIi5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQSBOT04tRklOSVRFIENVUlNPUiBBTFNPIE1FQU5TIFwiRlJPTSBUSEUgU1RBUlRcIiwgd2hpY2ggdGhlIGNvcGllcyBnb3RcbiAgICAgIC8vIHdyb25nIGJ5IGFjY2lkZW50OiB0aGV5IHdyb3RlIGBwYXJzZUludChwYXJhbSA/PyBcIi0xXCIpYCBhbmQgY29tcGFyZWRcbiAgICAgIC8vIGBpZCA+IHNpbmNlYCwgc28gYSB0eXBvJ2QgYD9zaW5jZT14YCBwcm9kdWNlZCBgTmFOYCwgZXZlcnkgY29tcGFyaXNvblxuICAgICAgLy8gd2FzIGZhbHNlLCBhbmQgdGhlIHRhaWwgb3BlbmVkIEVNUFRZIGFuZCBzdGF5ZWQgY29ubmVjdGVkIOKAlCB0aGUgc2FtZVxuICAgICAgLy8gc2lsZW50LWFuZC1jb25uZWN0ZWQgc3ltcHRvbSBhcyB0aGUgc3RhbGUgd2F0ZXJtYXJrLCBmcm9tIGEgZGlmZmVyZW50XG4gICAgICAvLyBjYXVzZS4gQWJzZW50IGFuZCB1bnBhcnNlYWJsZSBhcmUgdGhlIHNhbWUgcmVxdWVzdCBoZXJlLlxuICAgICAgY29uc3QgZnJvbSA9ICFOdW1iZXIuaXNGaW5pdGUoc2luY2UpIHx8IHNpbmNlID4gc2VxID8gLTEgOiBzaW5jZTtcbiAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgYnVmZmVyKSB7XG4gICAgICAgIGlmIChmcmFtZS5pZCA+IGZyb20pIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIH1cbiAgICAgIGxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgbGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBjdXJzb3IoKSB7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gIH07XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGRhZW1vbiBsaWZlY3ljbGUgdGFpbDogdGhlIGlkbGUtY2xvc2UgZGVjaXNpb24sIHRoZSBzd2VlcFxuICogdGhhdCBtYWtlcyBpdCwgYW5kIHRoZSBib3VuZGVkIHRlYXJkb3duLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIGJvdW50eSDigJQgdGhlIGNlbnN1cydzXG4gKiBjb252ZXJnZW5jZSB0YXJnZXQgIzMg4oCUIHdpdGggYXN0cm9sYWJlJ3MgYHRpbWVvdXRNcyA+IDBgIGd1YXJkIGZvbGRlZCBpbixcbiAqIHdoaWNoIGlzIHRoZSBvbmUgdGhpbmcgYm91bnR5J3MgY29weSBkb2VzIG5vdCBleHByZXNzLlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIEFET1BUUyBgZHJhaW5BbmRTdG9wYCBBTkQgTk9USElORyBFTFNFIEhFUkUg4oCUIFNQTElUIFBFUiBFWFBPUlRcbiAqXG4gKiBSdWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLCBhbmQgaXQgaXMgd3JpdHRlbiBkb3duXG4gKiBiZWNhdXNlIGEgcm93IGlzIGEgTU9EVUxFIGFuZCBcInBhcnRpYWxcIiBpcyBub3QgYW4gYW5zd2VyIHVudGlsIGl0IHNheXMgd2hpY2hcbiAqIGV4cG9ydHMuIEdyYXBldmluZSBpcyBsb25nLXJ1bm5pbmcsIHNvIG5vdGhpbmcgYWJvdXQgaXRzIGxpZmVjeWNsZSBtYWtlcyB0aGlzXG4gKiBtb2R1bGUgcmVhZCBhcyBpbmFwcGxpY2FibGUg4oCUIGFuZCB0d28gb2YgaXRzIHRocmVlIGV4cG9ydHMgc3RpbGwgaGF2ZSBub1xuICogc3ViamVjdCB0aGVyZTpcbiAqXG4gKiAgIGBzaG91bGRJZGxlQ2xvc2VgICAgICAgTk8gU1VCSkVDVC4gR3JhcGV2aW5lIHJ1bnMgbm8gaWRsZSBzd2VlcCBhbmQgaGFzIG5vXG4gKiAgIGBzdGFydEhvdXNla2VlcGluZ2AgICAgYC0tdGltZW91dGA7IGl0IGlzIGEgYnJva2VyIHRoYXQgc3RhbmRzIHVudGlsIGBzdG9wYFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIChgREVMRVRFIC9gKSBvciBhIHNpZ25hbCwgYW5kIGl0IHRha2VzIG5vIHNuYXBzaG90LlxuICogICAgICAgICAgICAgICAgICAgICAgICAgIEFkb3B0aW5nIHRoZSBwYWlyLW1hbmFnZXIgd291bGQgbWVhbiB3cml0aW5nIGEgbm8tb3BcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgdG91Y2hgIGFuZCBhIGBzdWJzY3JpYmVyQ291bnRgIHRoYXQgZXhpc3RzIG9ubHkgdG9cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSBudW1iZXIgbm9ib2R5IGFjdHMgb24g4oCUIHR3byBsaWVzIHRvIGdhaW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBjbGVhckludGVydmFsYC5cbiAqICAgYGRyYWluQW5kU3RvcGAgICAgICAgICBBRE9QVEVELCBhbmQgaXQgaXMgYSBERS1EVVBMSUNBVElPTiByYXRoZXIgdGhhbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgZ2FpbjogZ3JhcGV2aW5lJ3MgdGVhcmRvd24gYWxyZWFkeSBXQVNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvbWlzZS5yYWNlKFtzZXJ2ZXIuc3RvcCh0cnVlKSwgMjAwIG1zXSlgLCB3aGljaCBpc1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBzdG9wTXNgIGV4YWN0bHkuXG4gKlxuICog4pqgICoqQU5EIElUIElTIENBTExFRCBXSVRIIE5PIGBjbGllbnRzYCwgV0hJQ0ggSVMgQSBNRUFTVVJFTUVOVCwgTk9UIEFOXG4gKiBPVkVSU0lHSFQuKiogVGhpcyBtb2R1bGUgY2xvc2VzIGEgaGVsZCBjb25uZWN0aW9uIGJ5IGNhbGxpbmcgYGNsaWVudC5jbG9zZSgpYDtcbiAqIGdyYXBldmluZSdzIHN1YnNjcmliZXIgcmVjb3JkcyBhcmUgYHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9YCBhbmQgY2Fycnkgbm9cbiAqIGBjbG9zZWAg4oCUIGl0cyBwZXItc3RyZWFtIHRlYXJkb3duIGlzIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbVxuICogY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbSBgY2FuY2VsKClgLiBUaGVyZSBpcyBub3RoaW5nIHRvIGhhbmQgdGhlXG4gKiBhcmd1bWVudC4gYHNzZS50c2AncyBoZWFkZXIgY2FycmllcyB0aGUgcmVzdCBvZiB0aGF0IHJ1bGluZywgaW5jbHVkaW5nIHRoZVxuICogd2lkZW5pbmcgbm90IGRvbmUgYW5kIGl0cyBjb3N0IChzaXggYXJ0aWZhY3RzIGFjcm9zcyBmaXZlIHNwZWxscykuXG4gKlxuICog4pqgIEdyYXBldmluZSBhbHNvIHBhc3NlcyBgZ3JhY2VNczogMGAuIE5vdCBhIGRpc2FncmVlbWVudCB3aXRoIHRoZSBncmFjZVxuICogcGVyaW9kOiBpdCBlbWl0cyBubyBmYXJld2VsbCBmcmFtZSBhdCBkYWVtb24gc2h1dGRvd24sIGFuZCBpdHMgYERFTEVURSAvYFxuICogYWxyZWFkeSByZXR1cm5zIHRoZSByZXNwb25zZSBhbmQgc2NoZWR1bGVzIHRoZSB0ZWFyZG93biAxMCBtcyBsYXRlciwgc28gaXRzXG4gKiBmbHVzaCB3aW5kb3cgc2l0cyBhdCB0aGUgcm91dGUgcmF0aGVyIHRoYW4gaW4gdGhlIGRyYWluLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3NlQ2xpZW50cyB9IGZyb20gXCIuL3NzZS50c1wiO1xuXG4vKipcbiAqIFNob3VsZCB0aGUgZGFlbW9uIGlkbGUtY2xvc2U/XG4gKlxuICog4puUICoqYHN1YnNjcmliZXJDb3VudGAgSVMgQSBSRVFVSVJFRCBBUkdVTUVOVCwgQU5EIFRIQVQgSVMgVEhFIFdIT0xFIFBPSU5ULioqXG4gKiBUaGlzIGNsb3NlcyBjZW5zdXMgZGVmZWN0ICoqTDEqKiBieSBjb25zdHJ1Y3Rpb246IGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWVcbiAqIGNvdW50ZWQgdGhlaXIgaWRsZSBmbG9vciBkb3duIHdoaWxlIGFuIGFnZW50IGhlbGQgYSB0YWlsIG9wZW4sIHNvIGFuIGFnZW50XG4gKiB3YXRjaGluZyBhIHF1aWV0IGJvYXJkIHdhcyBraWxsZWQgV0lUSCBJVFMgQ09OTkVDVElPTiBPUEVOLiBUaGVyZSBpcyBub1xuICogb3ZlcmxvYWQgb2YgdGhpcyBmdW5jdGlvbiB0aGF0IGNhbm5vdCBzZWUgaXRzIHN1YnNjcmliZXJzLCBzbyB0aGUgZGVmZWN0XG4gKiBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGJ5IGEgY2FsbGVyIHdobyBmb3JnZXRzLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0NBUiBJVCBDQU1FIFdJVEgsIHJlLWhvbWVkIGZyb20gYm91bnR5IHZlcmJhdGltIGluIHN1YnN0YW5jZToqKlxuICogYSBib2FyZCBvbmx5IGNvdW50cyBpdHMgaWRsZSBmbG9vciBkb3duIHdoaWxlIFVOV0FUQ0hFRC4gQSBsaXZlIHN1YnNjcmliZXIg4oCUXG4gKiBhIGJyb3dzZXIgV2ViU29ja2V0LCBvciBhbiBhZ2VudCBTU0UgdGFpbCBvbiBgL2V2ZW50c2Ag4oCUIGtlZXBzIGl0IG9wZW5cbiAqIGluZGVmaW5pdGVseS4gU28gYHRpbWVvdXRgIG1lYW5zIFwibGluZ2VyIHRoaXMgbG9uZyBhZnRlciB0aGUgTEFTVCBzdWJzY3JpYmVyXG4gKiBsZWF2ZXNcIiwgTk9UIFwibWF4aW11bSBpZGxlIHdoaWxlIGNvbm5lY3RlZFwiLiBUaGUgc3dlZXAgYmVsb3cgYWxzbyB0b3VjaGVzIHRoZVxuICogYWN0aXZpdHkgY2xvY2sgb24gZXZlcnkgdGljayB3aGlsZSB3YXRjaGVkLCBzbyBvbmNlIHVud2F0Y2hlZCB0aGUgZmxvb3JcbiAqIGNvdW50cyBmcm9tIHRoYXQgbGFzdCBkaXNjb25uZWN0IGFuZCBub3QgZnJvbSB0aGUgbGFzdCByZXF1ZXN0LlxuICpcbiAqIOKaoCBgdGltZW91dE1zIDw9IDBgIG1lYW5zIE5FVkVSLCB3aGljaCBpcyBhc3Ryb2xhYmUncyBzdGFuZGluZy1vYnNlcnZhdG9yeVxuICogZGVmYXVsdCBhbmQgaXMgd2h5IHRoZSBndWFyZCBpcyBoZXJlIHJhdGhlciB0aGFuIGF0IGl0cyBvbmUgY2FsbCBzaXRlOiBhXG4gKiBzaW5nbGV0b24gZGFlbW9uIGlzIG1lYW50IHRvIHN0YW5kIHVudGlsIGl0IGlzIGV4cGxpY2l0bHkgY2xvc2VkLCBhbmQgYVxuICogYD49IDBgIGNvbXBhcmlzb24gd291bGQgY2xvc2UgaXQgb24gdGhlIGZpcnN0IHRpY2suXG4gKlxuICogQ2xvY2stZnJlZSBhbmQgZnMtZnJlZSwgc28gaXQgaXMgdGVzdGFibGUgd2l0aG91dCBhIGRhZW1vbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZElkbGVDbG9zZShcbiAgc3Vic2NyaWJlckNvdW50OiBudW1iZXIsXG4gIGlkbGVNczogbnVtYmVyLFxuICB0aW1lb3V0TXM6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBpZiAodGltZW91dE1zIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHN1YnNjcmliZXJDb3VudCA+IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlkbGVNcyA+PSB0aW1lb3V0TXM7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG91c2VrZWVwaW5nT3B0aW9ucyB7XG4gIC8qKiDim5QgUkVRVUlSRUQuIFNlZSBgc2hvdWxkSWRsZUNsb3NlYCDigJQgdGhpcyBpcyB3aGF0IGNsb3NlcyBMMS4gKi9cbiAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNaWxsaXNlY29uZHMgc2luY2UgdGhlIGxhc3QgYWN0aXZpdHkuICovXG4gIGlkbGVNczogKCkgPT4gbnVtYmVyO1xuICAvKiogUmVzZXQgdGhlIGFjdGl2aXR5IGNsb2NrLiBDYWxsZWQgb24gZXZlcnkgdGljayB0aGF0IGhhcyBhIHN1YnNjcmliZXIuICovXG4gIHRvdWNoOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGNvbmZpZ3VyZWQgaWRsZSB0aW1lb3V0IGluIG1zOyBgMGAgKG9yIGxlc3MpIG1lYW5zIG5ldmVyLiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgLyoqIEZpcmVkIG9uY2Ugd2hlbiB0aGUgZGFlbW9uIHNob3VsZCBjbG9zZSBpdHNlbGYuICovXG4gIG9uSWRsZUNsb3NlOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGRlYm91bmNlZCBzbmFwc2hvdCwgaWYgdGhlIHNwZWxsIGhhcyBvbmUuICovXG4gIHNuYXBzaG90Pzoge1xuICAgIGRpcnR5OiAoKSA9PiBib29sZWFuO1xuICAgIGNsZWFyOiAoKSA9PiB2b2lkO1xuICAgIHdyaXRlOiAoKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgfTtcbiAgLyoqIFN3ZWVwIGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAyNTAgbXMuICovXG4gIHRpY2tNcz86IG51bWJlcjtcbiAgLyoqIFNuYXBzaG90IGludGVydmFsOyBib3RoIGFkb3B0aW5nIGRhZW1vbnMgdXNlZCAxMDAwIG1zLiAqL1xuICBzbmFwc2hvdE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YXJ0IHRoZSB0d28gc3RhbmRpbmcgdGltZXJzIGV2ZXJ5IHNlc3Npb24gZGFlbW9uIHJ1bnMg4oCUIHRoZSBpZGxlIHN3ZWVwIGFuZFxuICogdGhlIGRlYm91bmNlZCBzbmFwc2hvdCDigJQgYW5kIHJldHVybiB0aGUgZnVuY3Rpb24gdGhhdCBzdG9wcyBib3RoLlxuICpcbiAqIFRoZXkgYXJlIE9ORSBjYWxsIGJlY2F1c2UgdGhleSBoYXZlIGFsd2F5cyBiZWVuIG9uZSBsaWZldGltZTogZXZlcnkgY29weVxuICogY2xlYXJlZCBib3RoIGluIHRoZSBzYW1lIHR3byBsaW5lcyBhZnRlciBgYXdhaXQgZG9uZWAsIGFuZCB0aGUgcGFpciB0aGF0IGdldHNcbiAqIGZvcmdvdHRlbiBpcyB0aGUgcGFpciB3aG9zZSB0aW1lcnMga2VlcCBhIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgdGVhcmRvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEhvdXNla2VlcGluZyhvcHRzOiBIb3VzZWtlZXBpbmdPcHRpb25zKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHRpY2tNcyA9IG9wdHMudGlja01zID8/IDI1MDtcbiAgY29uc3Qgc25hcHNob3RNcyA9IG9wdHMuc25hcHNob3RNcyA/PyAxMDAwO1xuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9wdHMuc3Vic2NyaWJlckNvdW50KCk7XG4gICAgaWYgKHN1YnNjcmliZXJzID4gMCkgb3B0cy50b3VjaCgpO1xuICAgIGlmIChzaG91bGRJZGxlQ2xvc2Uoc3Vic2NyaWJlcnMsIG9wdHMuaWRsZU1zKCksIG9wdHMudGltZW91dE1zKSkgb3B0cy5vbklkbGVDbG9zZSgpO1xuICB9LCB0aWNrTXMpO1xuXG4gIGNvbnN0IHNuYXAgPSBvcHRzLnNuYXBzaG90O1xuICBjb25zdCBzbmFwVGltZXIgPSBzbmFwXG4gICAgPyBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghc25hcC5kaXJ0eSgpKSByZXR1cm47XG4gICAgICAgIHNuYXAuY2xlYXIoKTtcbiAgICAgICAgdm9pZCBzbmFwLndyaXRlKCk7XG4gICAgICB9LCBzbmFwc2hvdE1zKVxuICAgIDogbnVsbDtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBpZiAoc25hcFRpbWVyICE9PSBudWxsKSBjbGVhckludGVydmFsKHNuYXBUaW1lcik7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhaW5PcHRpb25zIHtcbiAgLyoqIFRoZSBib3VuZCBzZXJ2ZXIuIFR5cGVkIHN0cnVjdHVyYWxseSBzbyB0aGUga2l0IHN0YXlzIGZyZWUgb2YgYGJ1bmAuICovXG4gIHNlcnZlcjogeyBzdG9wKGNsb3NlQWN0aXZlQ29ubmVjdGlvbnM/OiBib29sZWFuKTogdW5rbm93biB9O1xuICAvKiogTGl2ZSBTU0UgdGFpbHM7IGV2ZXJ5IHJlZ2lzdGVyZWQgY2xvc2VyIGlzIGludm9rZWQuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogTGl2ZSBXZWJTb2NrZXRzLiAqL1xuICBzb2NrZXRzPzogSXRlcmFibGU8eyBjbG9zZSgpOiB2b2lkIH0+O1xuICAvKiogSG93IGxvbmcgcXVldWVkIGZyYW1lcyBnZXQgdG8gZmx1c2ggYmVmb3JlIGFueXRoaW5nIGlzIGNsb3NlZC4gKi9cbiAgZ3JhY2VNcz86IG51bWJlcjtcbiAgLyoqIEhvdyBsb25nIHRoZSBncmFjZWZ1bCBzdG9wIGdldHMgYmVmb3JlIHRlYXJkb3duIHByb2NlZWRzIHJlZ2FyZGxlc3MuICovXG4gIHN0b3BNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDbG9zZSBldmVyeSBoZWxkIGNvbm5lY3Rpb24gYW5kIHN0b3AgdGhlIHNlcnZlciwgaW4gYm91bmRlZCB0aW1lLlxuICpcbiAqIOKblCAqKlRIRSBHUkFDRSBQRVJJT0QgSVMgTk9UIFBPTElURU5FU1MuKiogQSBgY2xvc2VkYCBmcmFtZSBlbWl0dGVkIGFuZCB0aGVuXG4gKiBmb2xsb3dlZCBpbW1lZGlhdGVseSBieSBhbiBhZ2dyZXNzaXZlIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgaXMgYSBmcmFtZSB0aGVcbiAqIGNsaWVudCBuZXZlciBzZWVzIOKAlCB0aGUgcXVldWUgZ29lcyB3aXRoIHRoZSBzb2NrZXQuIFRoZSAxNTAgbXMgaXMgd2hhdCB0dXJuc1xuICogXCJ0aGUgZGFlbW9uIHRvbGQgeW91IHdoeSBpdCBkaWVkXCIgZnJvbSBhIGhvcGUgaW50byBhbiBvYnNlcnZhdGlvbiwgYW5kIGV2ZXJ5XG4gKiBvbmUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY29udmVyZ2VkIG9uIHRoYXQgbnVtYmVyIGluZGVwZW5kZW50bHkuXG4gKlxuICog4puUICoqQU5EIFRIRSBTVE9QIElTIFJBQ0VELCBCRUNBVVNFIEEgU0xPVyBTT0NLRVQgTVVTVCBOT1QgQkUgQUJMRSBUTyBIQU5HXG4gKiBURUFSRE9XTi4qKiBgc2VydmVyLnN0b3AodHJ1ZSlgIGF3YWl0cyBpdHMgY29ubmVjdGlvbnM7IG9uZSB3ZWRnZWQgcGVlciBpc1xuICogZW5vdWdoIHRvIHBhcmsgaXQgZm9yZXZlciwgd2hpY2ggaXMgaG93IGEgMjMtbWludXRlIGhhbmcgc2hpcHBlZCBvbmNlLlxuICpcbiAqIOKaoCAqKldIQVQgSVMgREVMSUJFUkFURUxZIE5PVCBIRVJFOiBib3VudHkncyBzaHV0ZG93biB3YXRjaGRvZy4qKiBCb3VudHkgYXJtc1xuICogYSBSRUYnZCBgc2V0VGltZW91dGAgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBpZiB0ZWFyZG93biBkb2VzIG5vdCBmaW5pc2gsXG4gKiBhbmQgdGhlIGNlbnN1cyBpcyByaWdodCB0aGF0IGl0IGlzIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWxcbiAqIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gSXQgYmVsb25ncyB0byBib3VudHkncyBURUFSRE9XTiDigJQgdGhlIHN0cmV0Y2ggd2hlcmVcbiAqIG5vdGhpbmcgYm91bmRzIHdoYXQgaXMgYmVpbmcgd2FpdGVkIG9uLiDim5QgKipUSElTIFBBUkFHUkFQSCBTQUlEIFwiU0lHTkFMXG4gKiBQQVRIXCIgVU5USUwgRDUzLCBBTkQgVEhFIENPREUgQUdSRUVEIFdJVEggSVQsIFdISUNIIFdBUyBUSEUgREVGRUNULioqIEJvdW50eVxuICogaGFzIEZPVVIgd2F5cyBpbnRvIG9uZSB0ZWFyZG93biAoYSBzaWduYWwsIGEgYGNsb3NlYCB2ZXJiLCB0aGUgYnJvd3NlcidzXG4gKiBjbG9zZSBvdmVyIHRoZSBXZWJTb2NrZXQsIGFuIGlkbGUgdGltZW91dCkgYW5kIG9ubHkgdGhlIHNpZ25hbCBvbmUgYXJtZWQgdGhlXG4gKiB0aW1lciwgd2hpbGUgdGhlIGNvbW1lbnQgYWJvdmUgaXQgY2xhaW1lZCB0aGUgZW5kaW5nIHdhcyB1bmNvbmRpdGlvbmFsLlxuICogRHJpdmVuIHdpdGggYSBwbGFudGVkIGhhbmc6IHRoZSBvdGhlciB0aHJlZSByYW4gcGFzdCAxMCBzLCB0aGUgaWRsZSBvbmVcbiAqIGluY2x1ZGVkIOKAlCB0aGUgb3JwaGFuLWRhZW1vbiBjbGFzcyB0aGUgMjMtbWludXRlIGhhbmcgY2FtZSBmcm9tLiBUaGUgYXJtaW5nXG4gKiBub3cgbGl2ZXMgaW4gdGhlIFJFU09MVkUgdGhhdCBhbGwgZm91ciBlbnRyaWVzIHBhc3MgdGhyb3VnaC4gKipUaGUgbGVzc29uIGZvclxuICogYW4gYWRvcHRlciBpcyB0aGUgY291bnQsIG5vdCB0aGUgcGxhY2VtZW50OiBlbnVtZXJhdGUgZXZlcnkgZW50cnkgaW50byB0aGVcbiAqIHRlYXJkb3duIGJlZm9yZSB5b3UgYmVsaWV2ZSBhIGd1YXJhbnRlZSBjb3ZlcnMgaXQuKiogVGhlIHR3b1xuICogZGFlbW9ucyBhZG9wdGluZyB0aGlzIG1vZHVsZSByZWdpc3RlciBubyBzaWduYWwgaGFuZGxlcnMsIGFuZCB0aGVpciB3aG9sZVxuICogdGVhcmRvd24gaXMgYm91bmRlZCBieSB0aGUgdHdvIG51bWJlcnMgYWJvdmU7IGFkZGluZyBhbiBleGl0IGhlcmUgd291bGQgcHV0XG4gKiB0aGUgaG91c2UncyBvbmx5IHVuY29uZGl0aW9uYWwgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGlzXG4gKiBhYm91dCB0byBidW5kbGUsIG9uZSBwaGFzZSBhZnRlciBEOCB0b29rIGV4YWN0bHkgdGhhdCBoYXphcmQgT1VUIG9mIGBkaWVgLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VOVEVOQ0UgVEhBVCBVU0VEIFRPIEVORCBUSEFUIFBBUkFHUkFQSCBXQVMgQSBQUkVESUNUSU9OLCBXSElDSFxuICogQk9VTlRZJ1MgT1dOIFBPUlQgRkFMU0lGSUVELioqIEl0IHJlYWQ6IFwid2hlbiBhIHNwZWxsIHdpdGggYSBzaWduYWwgcGF0aFxuICogYWRvcHRzIHRoaXMsIHRoZSB3YXRjaGRvZyBhcnJpdmVzIGFzIGFuIG9wdGlvbiBvbiB0aGVzZSBhcmd1bWVudHMgYW5kIHRoZVxuICogcmVhc29uaW5nIGlzIGFscmVhZHkgd3JpdHRlbiBkb3duLlwiIGJvdW50eSBhZG9wdGVkIGBkcmFpbkFuZFN0b3BgIG9uXG4gKiAyMDI2LTA5LTA5IChQaGFzZSA0KSBhbmQgdGhlIG9wdGlvbiB3YXMgTk9UIGFkZGVkLCBiZWNhdXNlIHRoZSB3aW5kb3cgaXNcbiAqIHdyb25nLiAqKkEgYHdhdGNoZG9nTXNgIG9uIHRoZXNlIGFyZ3VtZW50cyB3b3VsZCBhcm0gYXQgRFJBSU4gdGltZTsgYm91bnR5J3NcbiAqIGFybXMgYXQgU0lHTkFMIHRpbWUqKiwgYW5kIHRoZSB3aG9sZSByZWFzb24gaXQgZXhpc3RzIGlzIHRoZSBzdHJldGNoIEJFVFdFRU5cbiAqIHRob3NlIHR3byBwb2ludHMg4oCUIGBhd2FpdCBkb25lYCwgYW4gZnMgYXBwZW5kIHRvIHRoZSBkYWVtb24gbG9nLCBhIGZ1bGxcbiAqIHNuYXBzaG90IHdyaXRlIHRoYXQgY2FuIHJvdGF0ZSBhbmQgQ09QWSBhIGJhY2t1cCBvZiBhIGxhcmdlIGJvYXJkLCBhIGBjbG9zZWRgXG4gKiBmcmFtZSBhbmQgYSBicm9hZGNhc3QuIGBkcmFpbkFuZFN0b3BgJ3Mgb3duIGJvZHkgaXMgYWxyZWFkeSBib3VuZGVkIGJ5IHRoZSB0d29cbiAqIG51bWJlcnMgYWJvdmUsIHNvIGEgd2F0Y2hkb2cgc2NvcGVkIHRvIGl0IHdvdWxkIGd1YXJkIHRoZSBvbmUgc3RyZXRjaCB0aGF0XG4gKiBjYW5ub3QgaGFuZyBhbmQgYWJhbmRvbiB0aGUgc3RyZXRjaCB0aGF0IGNhbjogaXQgd291bGQgUkVBRCBhcyBhZG9wdGlvbiBhbmRcbiAqIEJFIGEgbmFycm93aW5nIG9mIHRoZSBjb3JwdXMncyBvbmx5IHVuY29uZGl0aW9uYWwgdGVybWluYXRpb24gZ3VhcmFudGVlLiBUaGVcbiAqIDIzLW1pbnV0ZSBoYW5nIHRoaXMgcHJvamVjdCBrZWVwcyBjaXRpbmcgaGFwcGVuZWQgaW4gdGhlIHVuYm91bmRlZCBzdHJldGNoLlxuICpcbiAqIOKaoCAqKlNPIFRIRSBSVUxFIEZPUiBUSEUgTkVYVCBTUEVMTCwgV0hJQ0ggSVMgVEhFIFRSQU5TRkVSQUJMRSBIQUxGOioqIHRoZVxuICogcXVlc3Rpb24gaXMgbmV2ZXIgXCJkb2VzIHRoaXMgbW9kdWxlIGhhdmUgYSBwbGFjZSB0byBwdXQgYSB3YXRjaGRvZ1wiIGJ1dFxuICogXCJkb2VzIHRoZSB3YXRjaGRvZydzIHdpbmRvdyBjb2luY2lkZSB3aXRoIHRoaXMgbW9kdWxlJ3NcIi4gV2hlcmUgYSBzcGVsbCdzXG4gKiB0ZWFyZG93biBoYXMgdW5ib3VuZGVkIHdvcmsgQkVGT1JFIHRoZSBkcmFpbiwgdGhlIHdhdGNoZG9nIGJlbG9uZ3MgYXQgdGhlXG4gKiBzcGVsbCwgd3JhcHBlZCBhcm91bmQgYWxsIG9mIGl0IOKAlCBhbmQgYXJvdW5kIEVWRVJZIFdBWSBJTiwgd2hpY2ggaXMgdGhlIGhhbGZcbiAqIEQ1MyBoYWQgdG8gcmVwYWlyIGFmdGVyIHRoaXMgaGVhZGVyIHdhcyB3cml0dGVuLiBJZiBhIHNwZWxsIGV2ZXIgYXBwZWFycyB3aG9zZSBzaWduYWwgcGF0aFxuICogZW50ZXJzIGBkcmFpbkFuZFN0b3BgIGltbWVkaWF0ZWx5LCBhZGQgdGhlIG9wdGlvbiBUSEVOIOKAlCBhbmQgdGhlIG9wdGlvbiBtdXN0XG4gKiB0YWtlIGFuIGBvbkV4cGlyZWAgY2FsbGJhY2sgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIGBwcm9jZXNzLmV4aXRgIHN0YXlzXG4gKiBvdXRzaWRlIGEgbW9kdWxlIGV2ZXJ5IHNwZWxsIGJ1bmRsZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkcmFpbkFuZFN0b3Aob3B0czogRHJhaW5PcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdyYWNlTXMgPSBvcHRzLmdyYWNlTXMgPz8gMTUwO1xuICBjb25zdCBzdG9wTXMgPSBvcHRzLnN0b3BNcyA/PyAyMDA7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgZ3JhY2VNcykpO1xuXG4gIGlmIChvcHRzLmNsaWVudHMpIHtcbiAgICBmb3IgKGNvbnN0IGNsaWVudCBvZiBbLi4ub3B0cy5jbGllbnRzXSkgY2xpZW50LmNsb3NlKCk7XG4gIH1cbiAgaWYgKG9wdHMuc29ja2V0cykge1xuICAgIGZvciAoY29uc3Qgd3Mgb2YgWy4uLm9wdHMuc29ja2V0c10pIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICBQcm9taXNlLnJlc29sdmUob3B0cy5zZXJ2ZXIuc3RvcCh0cnVlKSksXG4gICAgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgc3RvcE1zKSksXG4gIF0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBhc3NldC1zZXJ2aW5nIHRyaW8gZm9yIGEgc3BlbGwgZGFlbW9uOiB3aGljaCBzdXJmYWNlIG1vZGUgd2VcbiAqIGFyZSBpbiwgd2hhdCBjb250ZW50IHR5cGUgYSBmaWxlIGdldHMsIGFuZCBob3cgYSBmaWxlIHVuZGVyIGBkaXN0L2AgaXNcbiAqIGFuc3dlcmVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRXh0cmFjdGVkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgZnJvbSB0aGUgZWlnaHQgYEJ1bi5zZXJ2ZWAgYmFja2VuZHNcbiAqIGNlbnN1c2VkIGluIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtZGFlbW9uLXNwaW5lLWNlbnN1cy5tZGAsIHdoaWNoXG4gKiBtZWFzdXJlZCBgcmVzb2x2ZU1vZGVgIGFzIGJ5dGUtaWRlbnRpY2FsIGluIGFsbCBlaWdodCAodGhlIG9ubHkgbWQ1IGRpZmZlcmVuY2VcbiAqIGJlaW5nIHRoZSBgZXhwb3J0YCBrZXl3b3JkKSwgdGhlIGNvbnRlbnQtdHlwZSBtYXAgYXMgZGlmZmVyaW5nIGluIGV4YWN0bHlcbiAqIG9uZSBjZWxsLCBhbmQgdGhlIGZpbGUgaGFsZiBvZiBgc2VydmVEaXN0YCBhcyBpZGVudGljYWwgaW4gZml2ZS5cbiAqXG4gKiDilIDilIAgV0hBVCBERUxJQkVSQVRFTFkgRElEIE5PVCBDT01FIEFMT05HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqVGhlIFVSTC10by1maWxlbmFtZSBtYXBwaW5nIHN0YXlzIGluIGVhY2ggcm91dGVyLioqIFRoZSBjZW5zdXMgbWFya2VkIHR3b1xuICogb2YgdGhlIGVpZ2h0IGBzZXJ2ZURpc3RgIGRpdmVyZ2VuY2VzIERFTElCRVJBVEUgYW5kIGJvdGggbGl2ZSBpbiB0aGF0IGhhbGY6XG4gKiBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgaW50byB0aGUgZW50cnkgSFRNTCBpbiBtZW1vcnksIGFuZCBncmFwZXZpbmUgc2VydmVzIGl0c1xuICogc3VyZmFjZSBhdCBgL3dhdGNoYCByYXRoZXIgdGhhbiBhdCBgL2AuIEEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYlxuICogdGhvc2Ugc3RvcHMgYmVpbmcgYSBmaWxlIHNlcnZlciBhbmQgYmVjb21lcyBhIHJvdXRlci4gU28gdGhlIGNhbGxlciBkZWNpZGVzXG4gKiBXSElDSCBmaWxlIChgcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSlgKSwgYW5kIHRoaXMgbW9kdWxlXG4gKiBkZWNpZGVzIHdoZXRoZXIgdGhhdCBmaWxlIG1heSBiZSByZWFkIGFuZCB3aGF0IGl0IGlzIHNlcnZlZCBhcy5cbiAqXG4gKiDilIDilIAgQU5EIFwiV0hFVEhFUiBJVCBNQVkgQkUgUkVBRFwiIElTIE5PVyBBIFdISVRFTElTVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFeHRyYWN0ZWQgd2l0aCB0aHJlZSBndWFyZHMgKGVtcHR5IC8gYC4uYCAvIG5lc3RlZCkgYW5kIGBleGlzdHNTeW5jYCBmb3IgdGhlXG4gKiByZXN0LCB3aGljaCB3YXMgdHJ1ZSBvZiBhIGBkaXN0L2AgdGhhdCBoZWxkIG9ubHkgYSBzdXJmYWNlLiBQaGFzZSAxYiBwdXQgZXZlcnlcbiAqIGRhZW1vbidzIEJVTkRMRSBpbiB0aGF0IHNhbWUgZGlyZWN0b3J5LCBhbmQgYWxsIGZpdmUgYWRvcHRlcnMgc2VydmVkIGl0OlxuICogYC9jbGkuanNgLCBgL3NlcnZlci5qc2AsIGAvam9pbi5qc2AgYXQgMjAwLCBieXRlLWlkZW50aWNhbCB0byB0aGUgY29tbWl0dGVkXG4gKiBhcnRpZmFjdHMsIGVtYmVkZGVkIHNvdXJjZW1hcHMgYW5kIGFsbC4gYHNlcnZlRnJvbURpc3RgIG5vdyBzZXJ2ZXMgb25seSB3aGF0IHRoZVxuICogYnVpbHQgYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBsaW5rcyDigJQgc2VlIGBzdXJmYWNlV2hpdGVsaXN0YCBiZWxvdywgd2hpY2ggaXNcbiAqIHRoZSBzaGFwZSBkaWdlc3RpZnkgcHJvdmVkIGxvY2FsbHkgaW4gYGQ4Y2JhZmZgIGFuZCB0aGlzIGlzIGl0cyBvbmUgZWRpdCBmb3JcbiAqIGZpdmUgc3BlbGxzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vKipcbiAqIFJlbGVhc2UgaWZmIGA8ZGlzdERpcj4vaW5kZXguaHRtbGAgZXhpc3RzOyBlbHNlIGRldi4gVGhlIGVudiBvdmVycmlkZVxuICogKGBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFYCkgd2lucyBlaXRoZXIgd2F5IOKAlCBzZWFtcyBDb250cmFjdCAxLlxuICpcbiAqIOKblCAqKlRIRSBGSUxFLCBORVZFUiBUSEUgRElSRUNUT1JZLCBBTkQgVEhBVCBJUyBBIFNDQVIgTk9UIEEgU1RZTEUgQ0hPSUNFLioqXG4gKiBSZS1ob21lZCBmcm9tIGJvdW50eSBhbmQgbWFncGllLCB3aGljaCBlYXJuZWQgaXQgaW5kZXBlbmRlbnRseTpcbiAqXG4gKiAtIG1hZ3BpZSdzIGBkaXN0L2AgQUxSRUFEWSBFWElTVEVEIGhvbGRpbmcgYGNsaS5qc2AgYW5kIG5vIGBpbmRleC5odG1sYCxcbiAqICAgd2hpY2ggaXMgcHJlY2lzZWx5IHdoeSBpdHMgZGFlbW9uIHN0YXllZCBjb3JyZWN0bHkgaW4gREVWIG1vZGUgdGhyb3VnaCB0aGVcbiAqICAgd2hvbGUgb2YgU2xpY2UgMi4gYGRpc3QvYCBleGlzdGluZyBpcyBub3QgdGhlIGRpc2NyaW1pbmF0b3IuXG4gKiAtIGJvdW50eSBzYXlzIHRoZSBzYW1lIHRoaW5nIGZyb20gdGhlIG90aGVyIHNpZGU6IGEgYnVpbHQgQkFDS0VORCBwdXRzXG4gKiAgIGBjbGkuanNgIChhbmQgbm93IGBzZXJ2ZXIuanNgKSBpbiBgZGlzdC9gIHdpdGggbm8gc3VyZmFjZSBhbnl3aGVyZSBuZWFyIGl0LlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUFJFRElDQVRFIElTIEFOIFVOSEFTSEVEIEZJTEVOQU1FLCBXSElDSCBJUyBBIFNUQU5ESU5HXG4gKiBBU1NVTVBUSU9OIEFCT1VUIFRIRSBTVVJGQUNFIEJVSUxELioqIFJlbGVhc2UgbW9kZSBpcyBjaG9zZW4gYnkgT05FIGxpdGVyYWxcbiAqIG5hbWUuIEEgc3VyZmFjZSBidWlsZCB0aGF0IGV2ZXIgZW1pdHRlZCBhIGNvbnRlbnQtaGFzaGVkIGVudHJ5IGRvY3VtZW50IHdvdWxkXG4gKiBsZWF2ZSBubyBgaW5kZXguaHRtbGAgaGVyZSwgZXZlcnkgZGFlbW9uIHdvdWxkIHNpbGVudGx5IHJlc29sdmUgREVWLCBhbmQgdGhlXG4gKiBvbmx5IHN5bXB0b20gYW55b25lIGNhbiBzZWUgaXMgdGhlIGBtb2RlYCBmaWVsZCBvbiBhIGhhbmRzaGFrZSBub2JvZHkgcmVhZHMgaW5cbiAqIGFuZ2VyLiBgc3JjL2J1aWxkLnRzYCBlbWl0cyB0aGUgZW50cnkgdW5oYXNoZWQgdG9kYXkgKG9ubHkgdGhlIEpTIGFuZCBDU1NcbiAqIGNodW5rcyBjYXJyeSBoYXNoZXMpIGFuZCBDb250cmFjdCAyIHBpbnMgdGhhdCBmbGF0IGxheW91dDsgdGhpcyBjb21tZW50IGlzXG4gKiB0aGUgbm90ZSB0aGF0IHNheXMgd2hhdCB0aGUgcGluIGlzIGxvYWQtYmVhcmluZyBGT1IuXG4gKlxuICog4pqgIE5vdGhpbmcgYW5ub3VuY2VzIHRoZSBmbGlwIGZyb20gZGV2IHRvIHJlbGVhc2UgZWl0aGVyOiB0aGUgZmlyc3Qgc3VyZmFjZVxuICogYnVpbGQgdG8gbGFuZCBhbiBgaW5kZXguaHRtbGAgYmVzaWRlIGEgZGFlbW9uIGZsaXBzIGl0LCBzaWxlbnRseSwgb24gdGhlIG5leHRcbiAqIGJvb3QuIFRoYXQgaXMgd2h5IGBtb2RlYCByaWRlcyB0aGUgcmVhZHkgZnJhbWUg4oCUIHdpdGggcm9vdCBkZXBzIHByZXNlbnQgYSBkZXZcbiAqIGRhZW1vbiByZW5kZXJzIGFuIGlkZW50aWNhbC1sb29raW5nIHN1cmZhY2UsIHNvIFwiaXQgbG9va3MgcmlnaHRcIiBjYW5ub3RcbiAqIHZlcmlmeSBDb250cmFjdCAxLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoZGlzdERpcjogc3RyaW5nKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpKSA/IFwicmVsZWFzZVwiIDogXCJkZXZcIjtcbn1cblxuLyoqXG4gKiBUaGUgY29udGVudCB0eXBlcyBhIGJ1aWx0IHN1cmZhY2UgYWN0dWFsbHkgc2hpcHMuIEV4dGVuc2lvbnMgb3V0c2lkZSB0aGVcbiAqIG1hcCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAg4oCUIGEgZGVsaWJlcmF0ZSByZWZ1c2FsIHRvIGd1ZXNzLCBzaW5jZVxuICogYW55dGhpbmcgbm90IGluIHRoaXMgbGlzdCBpcyBub3Qgc29tZXRoaW5nIENvbnRyYWN0IDIncyBidWlsZCBlbWl0cy5cbiAqXG4gKiDimqAgKipgY2hhcnNldD11dGYtOGAgT04gSFRNTCBJUyBUSEUgQ0VOU1VTJ1MgT05FIERJVkVSR0VOQ0UsIFJFU09MVkVEIFRPV0FSRFxuICogVEhFIENPUlJFQ1QgQ09QWS4qKiBUaHJlZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjYXJyaWVkIGl0IGFuZCBmaXZlIGRpZCBub3Q7XG4gKiB0aGUgY2Vuc3VzIGdyYWRlZCB0aGF0IGBzdGFsZWAgd2l0aCB6ZXJvIGRlc2lnbiBjb250ZW50LiBJdCBpcyBrZXB0IGJlY2F1c2VcbiAqIGl0IGlzIHRoZSByaWdodCBhbnN3ZXIg4oCUIGFuIEhUTUwgZG9jdW1lbnQgc2VydmVkIHdpdGggbm8gY2hhcnNldCBpcyBkZWNvZGVkXG4gKiBieSB0aGUgYnJvd3NlcidzIGd1ZXNzIOKAlCBhbmQgaXQgaXMgdGhlIG9uZSB3aXJlLW9ic2VydmFibGUgY2hhbmdlIHRoaXNcbiAqIGNvbnZlcmdlbmNlIG1ha2VzIHRvIGEgcmVzcG9uc2UgaGVhZGVyLiBSZWNvcmRlZCBhcyBELW5vdGUgaW4gdGhlIHBoYXNlIGxvZ1xuICogcmF0aGVyIHRoYW4gc211Z2dsZWQuXG4gKi9cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vKiogVGhlIGNvbnRlbnQgdHlwZSBmb3IgYSBmaWxlbmFtZSBvciBhbiBleHRlbnNpb24uIFVua25vd24gZXh0ZW5zaW9ucywgYW5kXG4gKiAgbmFtZXMgd2l0aCBubyBleHRlbnNpb24gYXQgYWxsLCBnZXQgYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAuICovXG5leHBvcnQgZnVuY3Rpb24gY29udGVudFR5cGVGb3IobmFtZU9yRXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lT3JFeHQubGFzdEluZGV4T2YoXCIuXCIpO1xuICBjb25zdCBleHQgPSBkb3QgPT09IC0xID8gXCJcIiA6IG5hbWVPckV4dC5zbGljZShkb3QpO1xuICByZXR1cm4gU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xufVxuXG4vKipcbiAqIEFuc3dlciBPTkUgZmlsZSBmcm9tIGBkaXN0RGlyYCwgb3IgYG51bGxgIGlmIHRoZSBjYWxsZXIgc2hvdWxkIGtlZXAgcm91dGluZy5cbiAqXG4gKiBgcmVsYCBpcyBhIGJhcmUgZmlsZW5hbWUg4oCUIHRoZSBlbnRyeSBkb2N1bWVudCBvciBvbmUgaGFzaGVkIGNodW5rLiBDb250cmFjdFxuICogMidzIGJ1aWx0IHN1cmZhY2UgaXMgRkxBVCBhbmQgbGlua3MgaXRzIGNodW5rcyByZWxhdGl2ZWx5LCBzbyBhIGxlZ2l0aW1hdGVcbiAqIGFzc2V0IHJlcXVlc3QgaXMgbmV2ZXIgbmVzdGVkIGFuZCBuZXZlciBjb250YWlucyBgLi5gOyBib3RoIGFyZSByZWZ1c2VkXG4gKiBoZXJlIHJhdGhlciB0aGFuIGluIHRoZSByb3V0ZXIsIGJlY2F1c2UgdGhlIGd1YXJkIHByb3RlY3RzIHRoZSByZWFkIGFuZCB0aGVcbiAqIHJlYWQgaXMgd2hhdCBsaXZlcyBpbiB0aGlzIGZpbGUuXG4gKlxuICog4puUIEFORCBgZXhpc3RzU3luY2AgSVMgTk8gTE9OR0VSIFRIRSBQRVJNSVNTSU9OLiBBIGZpbGUgdW5kZXIgYGRpc3REaXJgIGlzXG4gKiBzZXJ2ZWQgb25seSBpZiBpdCBpcyBpbiBgc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKWAg4oCUIHdoYXQgdGhlIGJ1aWx0XG4gKiBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IExJTktTLiBgZGlzdC9gIHN0b3BwZWQgYmVpbmcgYSBzdXJmYWNlIGRpcmVjdG9yeVxuICogd2hlbiB0aGUgYmFja2VuZCBjb252ZXJnZW5jZSBidWlsdCB0aGUgZGFlbW9ucyBpbnRvIGl0LCBhbmQgdGhlIGd1YXJkcyBhYm92ZVxuICogZG8gbm90IGRpc3Rpbmd1aXNoIGBpbmRleC08aGFzaD4uanNgIGZyb20gYHNlcnZlci5qc2AuIFJlYWQgdGhhdCBmdW5jdGlvbidzXG4gKiBoZWFkZXIgYmVmb3JlIHRvdWNoaW5nIHRoaXMgbGluZTsgdGhlIHdoaXRlbGlzdCBpcyB0aGUgZGVmZW5jZS5cbiAqXG4gKiDimqAgVGhlIG5lc3RpbmcgcmVmdXNhbCBpcyBhbHNvIHdoYXQga2VlcHMgYW4gYXNzZXQgc2VydmUgY2xlYXIgb2YgYSBzcGVsbCdzXG4gKiBvd24gcm91dGVzOiBtYWdwaWUsIGJvdW50eSwgZ2xhbW91ciBhbmQgaW1hZ28gZWFjaCBoYXZlIGFuIGAvYXNzZXRzLzxuYW1lPmBcbiAqIHJvdXRlIG9uZSBsZXZlbCBkZWVwLCBhbmQgdGhpcyByZXR1cm5pbmcgYG51bGxgIG9uIGFueXRoaW5nIHdpdGggYSBzbGFzaCBpblxuICogaXQgaXMgd2hhdCBzdG9wcyB0aGUgdHdvIGZpZ2h0aW5nLiBUaGUgd2hpdGVsaXN0IGdvdmVybnMgYGRpc3QvYCByZWFkcyBPTkxZXG4gKiDigJQgaXQgbmV2ZXIgc2VlcyB0aG9zZSByb3V0ZXMgYW5kIG11c3QgbmV2ZXIgYmUgd2lkZW5lZCBpbnRvIHRoZW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZUZyb21EaXN0KGRpc3REaXI6IHN0cmluZywgcmVsOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICBpZiAoIXJlbCB8fCByZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpLmhhcyhyZWwpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGNvbnRlbnRUeXBlRm9yKHJlbCkgfSB9KTtcbn1cblxuLyoqIGBzcmNgL2BocmVmYCB2YWx1ZXMgaW4gYSBidWlsdCBlbnRyeSBkb2N1bWVudCwgYC4vYC1wcmVmaXhlZCBvciBiYXJlLiAqL1xuY29uc3QgRU5UUllfUkVGX1JFID0gLyg/OnNyY3xocmVmKVxccyo9XFxzKlwiKD86XFwuXFwvKT8oW15cIl0rKVwiL2c7XG5cbi8qKiBBIGAuL2AtUFJFRklYRUQgc2libGluZyBzcGVjaWZpZXIg4oCUIGBcIi4vbmFtZVwiYCwgYCcuL25hbWUnYCwgYCguL25hbWUpYCDigJQgd2hpY2hcbiAqICBpcyB0aGUgb25seSBzaGFwZSBhIGJ1bmRsZXIgZW1pdHMgZm9yIGEgc2libGluZyBjaHVuay4gUmVxdWlyaW5nIHRoZSBgLi9gIGlzXG4gKiAgd2hhdCBrZWVwcyBhIHN0cmluZyBsaXRlcmFsIHRoYXQgbWVyZWx5IFNBWVMgYGNsaS5qc2Agb3V0IG9mIHRoZSBzZXQuICovXG5jb25zdCBSRUxBVElWRV9SRUZfUkUgPSAvW1wiJyhdXFwuXFwvKFteXCInKClcXHNdKylbXCInKV0vZztcblxuLyoqIE9ubHkgdGV4dCB0aGUgYnVpbGQgZW1pdHMgYXMgc3VyZmFjZSBjb2RlIGlzIHNjYW5uZWQgZm9yIG9ud2FyZCByZWZlcmVuY2VzLlxuICogIEEgYC5wbmdgIGlzIGEgbGVhZjsgb3BlbmluZyBpdCB3b3VsZCBiZSByZWFkaW5nIGEgYmluYXJ5IGZvciBmaWxlbmFtZXMuICovXG5jb25zdCBUUkFOU0lUSVZFX0VYVFMgPSBbXCIuanNcIiwgXCIuY3NzXCJdO1xuXG4vKiogT25lIGRlcml2YXRpb24gcGVyIGBkaXN0L2AsIGZvciB0aGUgbGlmZSBvZiB0aGUgcHJvY2VzcyDigJQgYGRpc3QvYCBpcyBhIGJ1aWxkXG4gKiAgYXJ0aWZhY3QgYW5kIGRvZXMgbm90IGNoYW5nZSB1bmRlciBhIHJ1bm5pbmcgZGFlbW9uLiBLZXllZCBieSBkaXJlY3Rvcnkgc29cbiAqICB0d28gZGFlbW9ucyBpbiBvbmUgcHJvY2VzcyAoYW5kIGV2ZXJ5IHRlc3Qgd2l0aCBpdHMgb3duIHRlbXAgdHJlZSkgc3RheVxuICogIGluZGVwZW5kZW50LiAqL1xuY29uc3Qgd2hpdGVsaXN0Q2FjaGUgPSBuZXcgTWFwPHN0cmluZywgUmVhZG9ubHlTZXQ8c3RyaW5nPj4oKTtcblxuZnVuY3Rpb24gcmVmc0luKHRleHQ6IHN0cmluZywgcmU6IFJlZ0V4cCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIChcbiAgICBbLi4udGV4dC5tYXRjaEFsbChyZSldXG4gICAgICAubWFwKChbLCByZWZdKSA9PiByZWYpXG4gICAgICAvLyBBIFRZUEUgUFJFRElDQVRFLCBhbmQgaG9uZXN0IG9ubHkgYmVjYXVzZSBpdHMgZmlyc3QgY2xhdXNlIHdhcyBhbHJlYWR5XG4gICAgICAvLyBoZXJlOiBgISFyZWZgIGlzIHRoZSBydW50aW1lIGNoZWNrIHRoYXQgbWFrZXMgYHJlZiBpcyBzdHJpbmdgIHRydWUgKHRoZVxuICAgICAgLy8gRkVMTCBzZW50ZW5jZSdzIHByZWRpY2F0ZSByb3V0ZSwgdGFrZW4gd2l0aCBpdHMgY2xhdXNlIOKAlCB0eXBlLWRlYnQgVDM2KS5cbiAgICAgIC5maWx0ZXIoXG4gICAgICAgIChyZWYpOiByZWYgaXMgc3RyaW5nID0+XG4gICAgICAgICAgISFyZWYgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiL1wiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIuLlwiKSAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCI6XCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiI1wiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIj9cIiksXG4gICAgICApXG4gICk7XG59XG5cbi8qKlxuICogVGhlIG5hbWVzIHVuZGVyIGBkaXN0RGlyYCBhIGJyb3dzZXIgbWF5IGZldGNoOiB0aGUgZW50cnkgZG9jdW1lbnQsIHBsdXMgdGhlXG4gKiBUUkFOU0lUSVZFIGNsb3N1cmUgb2Ygd2hhdCBpdCBsaW5rcy5cbiAqXG4gKiDim5QgKipBIFdISVRFTElTVCwgQU5EIFRIRSBMRUFLIElUIFJFUExBQ0VEIElTIFdIWS4qKiBVbnRpbCB0aGlzIGZpeCB0aGUgZmlsZVxuICogaGFsZiBvZiB0aGlzIG1vZHVsZSBoYWQgZXhhY3RseSB0aHJlZSBndWFyZHMg4oCUIGVtcHR5LCBgLi5gLCBuZXN0ZWQg4oCUIGFuZFxuICogYGV4aXN0c1N5bmNgIGRlY2lkZWQgdGhlIHJlc3QuIFRoYXQgd2FzIGNvcnJlY3QgZm9yIGFzIGxvbmcgYXMgYGRpc3QvYCBoZWxkXG4gKiBvbmx5IGEgc3VyZmFjZS4gVGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgbW92ZWQgZXZlcnkgc3BlbGwncyBJTVBMRU1FTlRBVElPTlxuICogaW50byB0aGUgc2FtZSBkaXJlY3RvcnksIGFuZCB0aGUgc2VydmUgZGlkIHdoYXQgaXQgd2FzIHdyaXR0ZW4gdG8gZG86XG4gKlxuICogICBHRVQgL2NsaS5qcyAgICAgMjAwICAyNDIsNDMxIEIgIHRleHQvamF2YXNjcmlwdCAgIOKGkCBib3VudHksIGJ5dGUtaWRlbnRpY2FsXG4gKiAgIEdFVCAvc2VydmVyLmpzICAyMDAgIDI3Niw0MTUgQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgdG8gdGhlIGNvbW1pdHRlZFxuICogICBHRVQgL2pvaW4uanMgICAgMjAwICAgNDcsMzQ4IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIGFydGlmYWN0c1xuICpcbiAqIGFuZCB0aG9zZSBidW5kbGVzIGFyZSBidWlsdCB3aXRoIHRoZSBzb3VyY2VtYXAgRU1CRURERUQsIHNvIGVhY2ggb25lIGNhcnJpZXNcbiAqIHRoZSBjb21wbGV0ZSBvcmlnaW5hbCBUeXBlU2NyaXB0LiBGaXZlIHNwZWxscyDigJQgYXN0cm9sYWJlLCBib3VudHksIGdsYW1vdXIsIGltYWdvLCBtYWdwaWVcbiAqIOKAlCBlbGV2ZW4gYXJ0aWZhY3RzLCBhbGwgcmVhY2hhYmxlIGJ5IGFueSBicm93c2VyIHRoYXQgY2FuIHJlYWNoIHRoZSBkYWVtb24uXG4gKiBEaWdlc3RpZnkgaGl0IHRoZSBpZGVudGljYWwgZGVmZWN0IG9uZSBicmFuY2ggZWFybGllciBhbmQgYW5zd2VyZWQgaXQgbG9jYWxseTtcbiAqIHRoaXMgaXMgdGhhdCBhbnN3ZXIgcmUtaG9tZWQgdG8gdGhlIG9uZSBwbGFjZSBhbGwgZml2ZSBjYWxsZXJzIGFscmVhZHkgc2hhcmUuXG4gKlxuICog4puUICoqREVSSVZFRCwgTk9UIEVOVU1FUkFURUQsIEFORCBOT1QgTUFUQ0hFRCBCWSBTSEFQRS4qKiBBIGxpdGVyYWwgbmFtZSBsaXN0XG4gKiBpcyB3cm9uZyBhdCB0aGUgbmV4dCBidWlsZCAodGhlIGNodW5rcyBjYXJyeSBjb250ZW50IGhhc2hlcykuIEEgc2hhcGUgbWF0Y2hcbiAqIChgaW5kZXgtPGhhc2g+LmpzYCkgaXMgd3JvbmcgdGhlIGZpcnN0IHRpbWUgdGhlIGJ1bmRsZXIgc3BsaXRzIGEgY2h1bmsuIEFza2luZ1xuICogdGhlIGVudHJ5IGRvY3VtZW50IHdoYXQgaXQgbG9hZHMgaXMgdGhlIG9ubHkgZm9ybXVsYXRpb24gdGhhdCBpcyB0cnVlIG9mXG4gKiB3aGF0ZXZlciBgYnVuIHJ1biBidWlsZGAgYWN0dWFsbHkgZW1pdHRlZC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIENMT1NVUkUgSVMgVFJBTlNJVElWRSBGT1IgVEhFIFNBTUUgUkVBU09OLioqIGBpbmRleC5odG1sYCBsaW5rc1xuICogb25lIGNodW5rIHRvZGF5OyBhIHNwbGl0IGJ1aWxkIGhhcyB0aGF0IGNodW5rIGBpbXBvcnQgXCIuL2NodW5rLTxoYXNoPi5qc1wiYCxcbiAqIHdoaWNoIHRoZSBlbnRyeSBkb2N1bWVudCBuZXZlciBuYW1lcy4gU28gZXZlcnkgYWRtaXR0ZWQgYC5qc2AvYC5jc3NgIGlzIGl0c2VsZlxuICogc2Nhbm5lZCBmb3IgYC4vYC1wcmVmaXhlZCBzaWJsaW5ncywgdW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nIOKAlCBhIHdoaXRlbGlzdFxuICogdGhhdCByZWFkIG9ubHkgdGhlIGVudHJ5IHdvdWxkIDQwNCBhIGxlZ2l0aW1hdGUgY2h1bmsgaW4gcmVsZWFzZSwgYW5kIG9ubHkgaW5cbiAqIHJlbGVhc2UuXG4gKlxuICog4puUICoqTUVNQkVSU0hJUCBJUyBBTiBFWEFDVCBNQVRDSCwgV0hJQ0ggTUFLRVMgVEhFIFJFRlVTQUwgQ0FTRS1JTlNFTlNJVElWRSBCWVxuICogQ09OU1RSVUNUSU9OLioqIEFQRlMgaXMgY2FzZS1pbnNlbnNpdGl2ZSwgc28gYC9JTkRFWC5IVE1MYCBhbmQgYC9pTmRFeC5IdE1sYFxuICogcmVzb2x2ZSB0byB0aGUgc2FtZSBpbm9kZSBhIGNhc2Utc2Vuc2l0aXZlIGJsYWNrbGlzdCB3b3VsZCBtaXNzIChtZWFzdXJlZCBvblxuICogYWxsIGZpdmUgc3BlbGxzIGJlZm9yZSB0aGlzIGZpeDogZm91ciB2YXJpYW50cywgZm91ciAyMDBzLCB0aHJlZSBvZiB0aGVtIGFzXG4gKiBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCBiZWNhdXNlIHRoZSBjb250ZW50LXR5cGUgbG9va3VwIGlzIGNhc2Utc2Vuc2l0aXZlXG4gKiB0b28pLiBBIHNldCBvZiBleGFjdGx5IHRoZSBlbWl0dGVkIG5hbWVzIHJlZnVzZXMgZXZlcnkgdmFyaWFudCBvZiBldmVyeSBuYW1lXG4gKiDigJQgc2VydmFibGUgb3Igbm90IOKAlCB3aXRoIG5vIGxvd2VyLWNhc2UgcGFzcyBhbnl3aGVyZS5cbiAqXG4gKiDimqAgKipUSEUgVFJBREU6KiogYSBmaWxlIHRoZSBlbnRyeSBncmFwaCBkb2VzIG5vdCByZWZlcmVuY2Ug4oCUIGEgbGF6aWx5IGZldGNoZWRcbiAqIGNodW5rLCBhIGZvbnQgcHVsbGVkIGJ5IGEgQ1NTIGB1cmwoKWAgdGhpcyBzY2FuIGRvZXMgbm90IG1vZGVsLCBhbiBhc3NldCB0aGVcbiAqIGJ1aWxkIGVtaXRzIGJ1dCBub3RoaW5nIGxpbmtzIOKAlCA0MDRzIGluIHJlbGVhc2Ugd2l0aCBub3RoaW5nIHJlZC4gRWFjaFxuICogYWRvcHRlcidzIGByZWxlYXNlLXNlcnZlLnRlc3QudHNgIGhvbGRzIHRoZSBpbnN0cnVtZW50OiBhbiBJTlZFTlRPUlkgY2VsbCB0aGF0XG4gKiBhY2NvdW50cyBmb3IgZXZlcnkgZmlsZSBpbiBgZGlzdC9gIGFzIHNlcnZlZCBvciBkZWxpYmVyYXRlbHkgcmVmdXNlZCwgc28gYW5cbiAqIHVubGlua2VkIGVtaXNzaW9uIGdvZXMgcmVkIGF0IGJ1aWxkIHRpbWUgcmF0aGVyIHRoYW4gc2lsZW50IGF0IHJ1bnRpbWUuXG4gKlxuICog4pqgIFRoZSBlbnRyeSBkb2N1bWVudCBpcyBJTiB0aGUgc2V0LCBiZWNhdXNlIHRoZSBob3VzZSBjYWxsZXIgbWFwcyBgL2AgdG9cbiAqIGBpbmRleC5odG1sYCBhbmQgdGhhdCBpcyB0aGUgc3VyZmFjZS4gQSBzcGVsbCB0aGF0IG11c3QgbmV2ZXIgaGFuZCBvdmVyIGl0c1xuICogb24tZGlzayBlbnRyeSDigJQgZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGEgcGF5bG9hZCBpbnRvIGl0IGluIG1lbW9yeSDigJQgcmVmdXNlc1xuICogdGhhdCBPTkUgbmFtZSBpbiBpdHMgb3duIHJvdXRlciwgYWJvdmUgdGhpcyBjYWxsLiBUaGF0IHJlZnVzYWwgaXMgdGhlIHNwZWxsJ3M7XG4gKiBldmVyeXRoaW5nIGVsc2UgaGVyZSBpcyB0aGUga2l0J3MuXG4gKi9cbmZ1bmN0aW9uIHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcjogc3RyaW5nKTogUmVhZG9ubHlTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNhY2hlZCA9IHdoaXRlbGlzdENhY2hlLmdldChkaXN0RGlyKTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcblxuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBlbnRyeSA9IGpvaW4oZGlzdERpciwgXCJpbmRleC5odG1sXCIpO1xuICBpZiAoZXhpc3RzU3luYyhlbnRyeSkpIHtcbiAgICBuYW1lcy5hZGQoXCJpbmRleC5odG1sXCIpO1xuICAgIGNvbnN0IGh0bWwgPSByZWFkRmlsZVN5bmMoZW50cnksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwZW5kaW5nID0gWy4uLnJlZnNJbihodG1sLCBFTlRSWV9SRUZfUkUpLCAuLi5yZWZzSW4oaHRtbCwgUkVMQVRJVkVfUkVGX1JFKV07XG4gICAgLy8gVW50aWwgdGhlIHNldCBzdG9wcyBncm93aW5nOiBlYWNoIGFkbWl0dGVkIGNodW5rIG1heSBuYW1lIHRoZSBuZXh0IG9uZS5cbiAgICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGVuZGluZy5wb3AoKSBhcyBzdHJpbmc7XG4gICAgICBpZiAobmFtZXMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgIC8vIOKaoCBSRUZFUkVOQ0VEICoqQU5EKiogUFJFU0VOVC4gQSBtaW5pZmllZCBidW5kbGUgY2FuIGNvbnRhaW4gYSBzdHJpbmdcbiAgICAgIC8vIHRoYXQgbWVyZWx5IExPT0tTIGxpa2Ugb25lOyBhZG1pdHRpbmcgb25seSBuYW1lcyB0aGF0XG4gICAgICAvLyBhcmUgYWN0dWFsbHkgb24gZGlzayBrZWVwcyB0aGUgc2NhbiBmcm9tIHdpZGVuaW5nIHRoZSBzZXQgb24gYVxuICAgICAgLy8gY29pbmNpZGVuY2UsIGFuZCBhIG5hbWUgdGhhdCBpcyBhYnNlbnQgNDA0cyBpZGVudGljYWxseSBlaXRoZXIgd2F5LlxuICAgICAgY29uc3QgZmlsZSA9IGpvaW4oZGlzdERpciwgbmFtZSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIGNvbnRpbnVlO1xuICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgaWYgKCFUUkFOU0lUSVZFX0VYVFMuc29tZSgoZXh0KSA9PiBuYW1lLmVuZHNXaXRoKGV4dCkpKSBjb250aW51ZTtcbiAgICAgIHBlbmRpbmcucHVzaCguLi5yZWZzSW4ocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmOFwiKSwgUkVMQVRJVkVfUkVGX1JFKSk7XG4gICAgfVxuICB9XG5cbiAgd2hpdGVsaXN0Q2FjaGUuc2V0KGRpc3REaXIsIG5hbWVzKTtcbiAgcmV0dXJuIG5hbWVzO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBzZXJ2ZXIgc2lkZSBvZiB0aGUgU1NFIHRhaWwg4oCUIHRoZSBkYWVtb24tc2lkZSB0d2luIG9mXG4gKiBgdGFpbEV2ZW50cy50c2AuIFRoYXQgbW9kdWxlIGRlY2lkZXMgd2hhdCBhIGNhbGxlciBvYnNlcnZlczsgdGhpcyBvbmUgZGVjaWRlc1xuICogd2hhdCBhIGNhbGxlciBpcyBzZW50LlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIGV4Y2VwdCBpdHNcbiAqIG93biBzaWJsaW5nIHR5cGVzLCB3aGljaCBpcyBzdGlsbCBpbnNpZGUgdGhlIGxlYWYuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCxcbiAqIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzE6IHRoZSBvbmx5IG9uZSBvZiB0aGUgc2V2ZW4gd2l0aCBhXG4gKiBvbmNlLW9ubHkgdGVhcmRvd24gZnVubmVsLCB0aGUgb25seSBvbmUgd2lyZWQgdG8gYHJlcS5zaWduYWxgLCBhbmQgdGhlIG9ubHlcbiAqIG9uZSB3aG9zZSBjb21tZW50IHJlY29yZHMgYSBNRUFTVVJFRCByZXN1bHQgcmF0aGVyIHRoYW4gYSBiZWxpZWYuXG4gKlxuICog4pSA4pSAIOKblCBBTkQgV0hBVCBUSEUgQ09QWSBMRUZUIEJFSElORCwgU0FJRCBIRVJFIEJFQ0FVU0UgQSBMT1NTIFJFQ09SREVEIE9OTFkgSU5cbiAqICAgIEEgUE9SVCdTIEpPVVJOQUwgR0VUUyBSRS1MSVRJR0FURUQgQlkgRVZFUlkgU1BFTEwgQUZURVIgSVQgKEQ3OS9EODUpIOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBzZW50ZW5jZSBhYm92ZSBuYW1lcyBhIFNPVVJDRSB0aGlzIG1vZHVsZSBoYWQgbmV2ZXIgYmVlbiBjaGVja2VkIGFnYWluc3Q6XG4gKiBEMSBydWxlZCB0aGUgc3BpbmUgYmUgcHJvdmVuIG9uIHRoZSB0d28gc3BlbGxzIHRoYXQgYWxyZWFkeSBidWlsdCwgYW5kIGJvdGggb2ZcbiAqIHRob3NlIGFyZSBkb3duc3RyZWFtIEZPUktTIG9mIHRoZSBtaW5kLW1hcHBlciBsaW5lLCBzbyB0aGUgYm91bmRhcmllcyB3ZXJlXG4gKiBzZXR0bGVkIGFnYWluc3QgdHdvIGNvcGllcyB3aGlsZSB0aGUgb3JpZ2luYWwgd2FzIG5vdCBpbiB0aGUgcm9vbS4gKipBXG4gKiBjb252ZXJnZW5jZSBjYW4gbmFtZSBpdHMgc291cmNlIGFuZCBzdGlsbCBuZXZlciBjb25zdWx0IGl0LioqXG4gKlxuICogV2hlbiBpdCB3YXMgZmluYWxseSBjb25zdWx0ZWQgKFBoYXNlIDcsIHRoZSBsYXN0IHBvcnQpLCBleGFjdGx5IE9ORSBwcm9wZXJ0eVxuICogb2YgdGhlIHNvdXJjZSB3YXMgbWlzc2luZyBoZXJlLCBhbmQgaXQgb2NjdXBpZWQgbm8gdHlwZTogKiptaW5kLW1hcHBlciB3cm90ZVxuICogaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIEJFRk9SRSB0aGUgcmVwbGF5Kiog4oCUIG9uZSBsaW5lIGFib3ZlXG4gKiBgYnVzLnN1YnNjcmliZWAg4oCUIHNvIGl0IHdhcyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lLiBgb25PcGVuYCBmaXJlcyBhdFxuICogdGhlIEVORCBvZiBgc3RhcnRgLCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCwgYWZ0ZXJcbiAqIGBjbGllbnRzLmFkZGAsIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZWQgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZCBzZW50IGZyb21cbiAqIHRoZXJlIHdvdWxkIGxhbmQgdGhlIGZyYW1lIEFGVEVSIHRoZSByZXBsYXllZCBiYWNrbG9nLiBUaGF0IGlzIEVYUFJFU1NJQkxFLFxuICogd2hpY2ggaXMgd2hhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiB0aGVcbiAqIHBsYXlib29rJ3MgdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgcHJvY2VkdXJlIGFuc3dlcnMgXCJyZXByZXNlbnRhYmxlXCIgaGVyZVxuICogKHRoZSBzdWJqZWN0IHR5cGUgaXMgYFNldDxTc2VDbGllbnQ+YCwgdGhlIHNwZWxsIGtlZXBzIG5vIHJlZ2lzdHJ5LCBzbyB5b3VcbiAqIHBhc3MgYW4gZW1wdHkgc2V0KSBhbmQgYSB0eXBlIGNoZWNrIGNhbm5vdCBzZWUgYSBQT1NJVElPTi5cbiAqXG4gKiAqKlRoZSBkaXNwb3NpdGlvbiB3YXMgUkVTVE9SRSwgbm90IEtFRVAtTE9DQUwgYW5kIG5vdCBGSUxFKiog4oCUIHNlZVxuICogYG9wZW5GcmFtZXNgIGJlbG93LCB3aGVyZSB0aGUgdHdvIG51bWJlcnMgdGhhdCBwZXJtaXQgaXQgYXJlIHJlY29yZGVkIGFuZFxuICogZHJpdmVuLiBUaGUgZ2VuZXJhbGlzYXRpb24sIHdoaWNoIGlzIHRoZSBwYXJ0IHdvcnRoIGNhcnJ5aW5nOiB3aGVyZSBhXG4gKiBtb2R1bGUncyBzdWJqZWN0IGlzIGEgU0VRVUVOQ0UgT0YgV1JJVEVTLCBjb21wYXJlIHRoZSBPUkRFUiBvZiBpdHMgaG9va3NcbiAqIGFnYWluc3QgdGhlIG9yZGVyIHRoZSBhZG9wdGluZyBzcGVsbCB3cml0ZXMgaW4uIFR3byBob29rcyB3aXRoIHRoZSByaWdodFxuICogc2lnbmF0dXJlcyBpbiB0aGUgd3Jvbmcgb3JkZXIgYXJlIGFzIGluY29tcGF0aWJsZSBhcyB0d28gdHlwZXMgdGhhdCB3aWxsIG5vdFxuICogdW5pZnksIGFuZCBvbmx5IG9uZSBvZiB0aGUgdHdvIGNhbiBiZSBTRUVOIGJ5IGEgY29tcGF0aWJpbGl0eSBjaGVjay5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogICAgQ0xJRU5ULiBNRUFTVVJFRCBPTiBCVU4gMS4zLjE0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFNpeCBkYWVtb25zIHdyaXRlIGEgaGVhcnRiZWF0IGFzIGB0cnkgeyBjb250cm9sbGVyLmVucXVldWUoLi4uKSB9IGNhdGNoIHt9YFxuICogd2l0aCBhIGNvbW1lbnQgc2F5aW5nIHRoZSBjYXRjaCBpcyBob3cgYSBkZXBhcnRlZCBjbGllbnQgaXMgbm90aWNlZC4gSXQgaXNcbiAqIG5vdDogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gQlVGRkVSUyBTSUxFTlRMWSBhbmQgbmV2ZXIgdGhyb3dzLCBzbyB0aGVcbiAqIGNhdGNoIG5ldmVyIGZpcmVzIGFuZCB0aG9zZSBkYWVtb25zJyBkZWFkLWNsaWVudCBkZXRlY3Rpb24gcmVzdHMgb24gYVxuICogbWVjaGFuaXNtIHRoZWlyIG93biBjb21tZW50cyBkZXNjcmliZSBpbmNvcnJlY3RseS4gV2hhdCBhY3R1YWxseSByZWNsYWltcyB0aGVcbiAqIGNvbm5lY3Rpb24gaXMgdGhlIHN0cmVhbSdzIGBjYW5jZWwoKWAg4oCUIGFuZCwgZm9yIGEgY2xpZW50IHRoYXQgbmV2ZXIgY2xvc2VzXG4gKiB0aGUgc29ja2V0LCBgcmVxLnNpZ25hbGAuXG4gKlxuICogU28gdGhlIGZ1bm5lbCBiZWxvdyBpcyB0aGUgbG9hZC1iZWFyaW5nIHBhcnQuIGB0ZWFyZG93bigpYCBydW5zIEFUIE1PU1QgT05DRVxuICogZnJvbSBldmVyeSBwYXRoIHRoZXJlIGlzIOKAlCBgY2FuY2VsKClgLCBhbiBhYm9ydCBvbiB0aGUgcmVxdWVzdCBzaWduYWwsIGFuZFxuICogdGhlIGJlbHQtYW5kLWJyYWNlcyBlbnF1ZXVlIGNhdGNoIOKAlCBhbmQgaXQgaXMgd2hlcmUgdGhlIHN1YnNjcmliZXIgY291bnQgYW5kXG4gKiBhbnkgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGUuIEJvdW5kaW5nIHByZXNlbmNlIGFjY3VyYWN5IGlzIGJvdW5kaW5nIHRoYXRcbiAqIGZ1bm5lbC5cbiAqXG4gKiDimqAgS25vd24gaG9sZSwgYWNjZXB0ZWQgYW5kIGluaGVyaXRlZDogQnVuJ3Mgb3duIGBmZXRjaCgpYCByZWFkZXIgYC5jYW5jZWwoKWBcbiAqIGNsb3NlcyBub3RoaW5nIGNsaWVudC1zaWRlIGFuZCB0aGUgc2VydmVyIGNhbm5vdCBzZWUgaXQuIFJlYWwgY2xpZW50cyBjbG9zZVxuICogdGhlIHNvY2tldC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLlxuICogR3JhcGV2aW5lIEhBUyBhbiBTU0UgcmVnaXN0cnkgYW5kIGl0IGlzIHRoZSBidXNpZXN0IHRoaW5nIGluIHRoZSBzcGVsbDsgdGhlXG4gKiB0d28gdHlwZXMgc2ltcGx5IGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgYFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PmAgd2hlcmUgYFNzZUNsaWVudCA9IHtjbG9zZSwgc2VuZH1gXG4gKiAgICAgICAgICAgICAgICDigJQgYSByZWdpc3RyeSBvZiBBTk9OWU1PVVMgY2xvc2VycywgYW5kIGBzaXplYCBpcyB0aGUgb25seSB0aGluZ1xuICogICAgICAgICAgICAgICAgYW55IGFkb3B0aW5nIGRhZW1vbiByZWFkcyBvZmYgaXQuXG4gKiAgIGdyYXBldmluZSAgICBgTWFwPHN5bWJvbCwge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH0+YCwgcGVyIGNoYW5uZWwuXG4gKlxuICogKipUaGUgcmVhZGVycyB0aGF0IG1ha2UgdGhlbSBpbmNvbXBhdGlibGUsIGNvdW50ZWQgcmF0aGVyIHRoYW4gYXNzZXJ0ZWQ6IFNJWFxuICogcm91dGVzIHJlYWQgYGFsaWFzYC9gaHVtYW5gL2BsdXJrYCoqIOKAlCBgR0VUIC9jaGFubmVsc2AgKHRocm91Z2hcbiAqIGBsaXN0Q2hhbm5lbHNgIOKGkiBgdmlzaWJsZVN1YnNgKSwgYEdFVCAvcHJlc2VuY2VgLCBgUE9TVCAvY2hhbm5lbHNgLFxuICogYFBPU1QgL2Fubm91bmNlYCwgYFBPU1QgL2NoYW5uZWxzLzpuYW1lL21lc3NhZ2VzYCwgYW5kXG4gKiBgR0VUIC9jaGFubmVscy86bmFtZS9zdWJzY3JpYmVyc2AuIGBhbGlhc2AgaXMgYSBuYW1lIGEgaHVtYW4gc2VlcyBpbiBhIHJvc3RlcixcbiAqIGBodW1hbmAgdGVsbHMgYW4gYWdlbnQgaXQgaXMgdGFsa2luZyB0byBhIHBlcnNvbiwgYW5kIGBsdXJrYCBleGNsdWRlcyBhXG4gKiBjb25uZWN0aW9uIGZyb20gZXZlcnkgcHJlc2VuY2UgY291bnQuIFRoZXJlIGlzIG5vIHdheSB0byBwdXQgYW55IG9mIHRoYXQgaW50b1xuICogYSBzZXQgb2YgY2xvc2Vycy4gQWRvcHRpbmcgdGhpcyBtb2R1bGUgd291bGQgbm90IGJlIGRlYWQgY29kZTsgaXQgd291bGQgYmUgYVxuICogcmV3cml0ZSBvZiB3aGF0IGdyYXBldmluZSBJUy5cbiAqXG4gKiDimqAgKipBTkQgVEhFIExJU1QgSVMgREVMSUJFUkFURUxZIE5PVCBUSEUgT0JWSU9VUyBPTkUuKiogVGhlIHBvcnQncyBmaXJzdFxuICogY291bnQgbmFtZWQgdGhlIGByb2xsYC9jbGVhciBicm9hZGNhc3QsIHRoZSBhcmNoaXZlIGxpdmUtZ3VhcmQgYW5kIHR3b1xuICogUkVHSVNUUkFUSU9OUyDigJQgYW5kIGV2ZXJ5IG9uZSBvZiB0aG9zZSBpcyBhIHNpdGUgdGhpcyBtb2R1bGUncyB0eXBlIHdvdWxkXG4gKiBzZXJ2ZSBwZXJmZWN0bHk6IHRoZSBicm9hZGNhc3QgcmVhZHMgb25seSBgcy5zZW5kYCwgdGhlIGxpdmUtZ3VhcmQgb25seVxuICogYHN1YnNjcmliZXJzLnNpemVgICh3aGljaCB0aGlzIGhlYWRlciBpdHNlbGYgc2F5cyBpcyBhbGwgYW55IGFkb3B0ZXIgcmVhZHMpLFxuICogYW5kIGEgcmVnaXN0cmF0aW9uIFdSSVRFUyB0aGUgcmVjb3JkIHJhdGhlciB0aGFuIHJlYWRpbmcgaXQuIFRoZSBzaXggYWJvdmUgYXJlXG4gKiB0aGUgb25lcyB0aGF0IHJlYWQgYSBmaWVsZCB0aGUga2l0J3MgYFNzZUNsaWVudGAgZG9lcyBub3QgaGF2ZTsgdGhlIHdyaXRlcnNcbiAqIChgL3dhaXRgJ3MgcHJlc2VuY2UgcmVnaXN0cmF0aW9uIGFuZCB0aGUgdGFpbCdzKSBhcmUgbmFtZWQgc2VwYXJhdGVseSBiZWNhdXNlXG4gKiBhIHdyaXRlciBpcyBub3QgZXZpZGVuY2Ugb2YgYW55dGhpbmcuIENvdW50ZWQgaW4gdGhlIHByZS1wb3J0IGRhZW1vbixcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvZGFlbW9uLnRzYCBvbiBgZGV2ZWxvcGA6XG4gKiBsLjQyMSwgNzM5LTc0NywgODI2LCA4ODYtODg3LCAxMDQ5LTEwNTQsIDExODItMTE4OCDigJQgd3JpdGVycyBhdCAxMTExLTExMTIgYW5kXG4gKiAxMzA3LiAoQ29ycmVjdGVkIDIwMjYtMDktMDkgaW4gdGhlIHJlcGFpciBjaGFwdGVyOyBENjgncyByZXF1aXJlbWVudCBpcyB0aGF0XG4gKiB0aGUgcmVmdXNhbCBiZSB3cml0dGVuIHdoZXJlIHRoZSBuZXh0IHJlYWRlciBtZWV0cyBpdCwgd2hpY2ggbWFrZXMgYVxuICogbWlzLW1lYXN1cmVkIGxpc3Qgd29yc2UgdGhhbiBub25lLilcbiAqXG4gKiDimqAgQW5kIGdyYXBldmluZSdzIHJlY29yZHMgY2Fycnkgbm8gYGNsb3NlYCBhdCBhbGwg4oCUIHRoZSBwZXItc3RyZWFtIHRlYXJkb3duIGlzXG4gKiBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW0gY29udHJvbGxlciwgcmVhY2hhYmxlIG9ubHkgZnJvbVxuICogYGNhbmNlbCgpYCDigJQgd2hpY2ggaXMgYWxzbyB3aHkgYGhvdXNla2VlcGluZ2AncyBgZHJhaW5BbmRTdG9wYCBpcyBhZG9wdGVkXG4gKiB0aGVyZSB3aXRoIGl0cyBgY2xpZW50c2AgYXJndW1lbnQgZGVsaWJlcmF0ZWx5IGVtcHR5LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhbiBhbGlhcy1iZWFyaW5nIHJlY29yZFxuICogd291bGQgY2hhbmdlIHRoZSB0eXBlIGZpdmUgb3RoZXIgZGFlbW9ucyBjb21waWxlIGFnYWluc3QgYW5kIHJlLWVtaXQgU0lYXG4gKiBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYSBkcml2ZS4gSXQgd291bGQgYWxzbyByZS1jcmVhdGUgdGhlXG4gKiB0aGluZyB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byBzdG9wLCBhbmQgdGhpcyBmaWxlJ3Mgb3duIGJvdW5kYXJ5IHBhcmFncmFwaFxuICogc2F5cyBob3c6IGEgc2lnbmF0dXJlIHdpZGUgZW5vdWdoIHRvIGFic29yYiBldmVyeSBjYWxsZXIncyBzaGFwZSBzdG9wcyBiZWluZyBhXG4gKiByZWdpc3RyeSBhbmQgYmVjb21lcyBhIHVuaW9uLiBUaGUgY2Vuc3VzIGNvbnZlcmdlZCBjb3BpZXMgaW50byBvbmUgbW9kdWxlIGJ5XG4gKiBmaW5kaW5nIHdoYXQgdGhleSBTSEFSRUQ7IGEgbW9kdWxlIHdpZGVuZWQgdG8gZml0IHRoZSBvbmUgc3BlbGwgdGhhdCBzaGFyZXNcbiAqIG5vdGhpbmcgaXMgdGhvc2UgY29waWVzIGFnYWluIHdpdGggYSB1bmlvbiB0eXBlIG92ZXIgdGhlIHRvcC4gVGhlIHNwZWxsIGtlZXBzXG4gKiBpdHMgb3duLCBhbmQgYSB3aWRlbmluZyByZW1haW5zIGEgc2VwYXJhdGUsIGFyZ3VlZCBkZWNpc2lvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV2ZW50TG9nLCBGcmFtZSB9IGZyb20gXCIuL2V2ZW50TG9nLnRzXCI7XG5cbi8qKlxuICogT25lIG9wZW4gU1NFIHN0cmVhbSwgYXMgdGhlIGRhZW1vbiBjYW4gYWN0IG9uIGl0OiBlbmQgaXQsIG9yIHB1c2ggYSBmcmFtZSB0b1xuICogaXQgdGhhdCBkaWQgbm90IGNvbWUgb3V0IG9mIHRoZSBsb2cuXG4gKlxuICog4puUIElUIElTIE5PVCBBIENPTlRST0xMRVIuIFRoZSBjb3BpZXMgaGVsZFxuICogYFNldDxSZWFkYWJsZVN0cmVhbURlZmF1bHRDb250cm9sbGVyPmAgYW5kIGNsb3NlZCB0aGVtIGRpcmVjdGx5IGF0IHRlYXJkb3duLFxuICogd2hpY2ggYnlwYXNzZXMgdGhlIHRlYXJkb3duIGZ1bm5lbCBhYm92ZSDigJQgdGhlIGhlYXJ0YmVhdCBpbnRlcnZhbCBmb3IgdGhhdFxuICogc3RyZWFtIHdhcyBjbGVhcmVkIG9ubHkgYmVjYXVzZSBhIHNlY29uZCBgU2V0YCBvZiB0aW1lcnMgd2FzIGtlcHQgaW4gcGFyYWxsZWxcbiAqIGFuZCBzd2VwdCBzZXBhcmF0ZWx5LiBFdmVyeXRoaW5nIGhlcmUgZ29lcyB0aHJvdWdoIHRoZSBmdW5uZWwsIGFuZCBhIGBzZW5kYFxuICogYWZ0ZXIgdGVhcmRvd24gaXMgYSBuby1vcCByYXRoZXIgdGhhbiBhIHRocm93LlxuICpcbiAqIOKaoCAqKmBzZW5kYCBBUlJJVkVEIElOIFBIQVNFIDIsIEZST00gVEhFIEZJUlNUIENPTlNVTUVSIFRIQVQgV0FTIE5PVCBPTkUgT0YgVEhFXG4gKiBUV08gVEhJUyBNT0RVTEUgV0FTIERFU0lHTkVEIEFHQUlOU1QuKiogYXN0cm9sYWJlIGFuZCBtYWdwaWUgYW5ub3VuY2UgcHJlc2VuY2VcbiAqIG92ZXIgdGhlaXIgYnJvd3NlciBXRUJTT0NLRVQsIHNvIGEgcmVnaXN0cnkgb2YgYmFyZSBjbG9zZXJzIHdhcyBzdWZmaWNpZW50IGFuZFxuICogdGhlIGJvdW5kYXJ5IGxvb2tlZCByaWdodC4gZ2xhbW91ciBhbm5vdW5jZXMgaXQgb24gdGhlIEFHRU5UJ3MgU1NFIHRhaWwg4oCUXG4gKiBge3R5cGU6XCJjb25uZWN0ZWRcIn1gIC8gYHt0eXBlOlwiZGlzY29ubmVjdGVkXCJ9YCwgZGVsaWJlcmF0ZWx5IHVubG9nZ2VkLCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgYWdlbnQgZG9lcyBub3QgcmUtc2VlIGV2ZXJ5IHBhc3QgY29ubmVjdCBhbmQgc28gdGhlIGZyYW1lIG5ldmVyXG4gKiBhZHZhbmNlcyBhIHRhaWwgY3Vyc29yLiBUaGF0IGlzIG5vdCBhIGdsYW1vdXIgcXVpcms7IGl0IGlzIHRoZSBnZW5lcmFsIHNoYXBlXG4gKiBvZiBcInRlbGwgdGhlIGxpdmUgc3Vic2NyaWJlcnMgc29tZXRoaW5nIHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGhpc3RvcnlcIiwgYW5kXG4gKiBhIHJlZ2lzdHJ5IHRoYXQgY2FuIG9ubHkgRU5EIGEgc3RyZWFtIGNhbm5vdCBleHByZXNzIGl0LiBXaXRob3V0IHRoaXMgdGhlXG4gKiBzcGVsbCB3b3VsZCBoYXZlIGhhZCB0byBrZWVwIGl0cyBvd24gcGFyYWxsZWwgYFNldGAgb2YgY29udHJvbGxlcnMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHRoZSBkcmlmdCB0aGlzIHJlZ2lzdHJ5IGV4aXN0cyB0byByZW1vdmUuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudCA9IHtcbiAgLyoqIEVuZCB0aGlzIHN0cmVhbSwgdGhyb3VnaCB0aGUgdGVhcmRvd24gZnVubmVsLCBhdCBtb3N0IG9uY2UuICovXG4gIGNsb3NlKCk6IHZvaWQ7XG4gIC8qKiBXcml0ZSBvbmUgcmF3IFNTRSBjaHVuayB0byB0aGlzIHN0cmVhbS4gTm8tb3Agb25jZSB0b3JuIGRvd24uICovXG4gIHNlbmQoY2h1bms6IHN0cmluZyk6IHZvaWQ7XG59O1xuXG4vKipcbiAqIFRoZSBsaXZlLXRhaWwgcmVnaXN0cnkuIGBzaXplYCBpcyB0aGUgZGFlbW9uJ3MgU1NFIHN1YnNjcmliZXIgY291bnQg4oCUIHRoZVxuICogbnVtYmVyIGBzaG91bGRJZGxlQ2xvc2VgIG11c3Qgc2VlIOKAlCBhbmQgY2xvc2luZyBldmVyeSBlbnRyeSBpcyB3aGF0IGEgZHJhaW5cbiAqIGRvZXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNzZUNsaWVudHMgPSBTZXQ8U3NlQ2xpZW50PjtcblxuZXhwb3J0IGludGVyZmFjZSBTc2VPcHRpb25zPFQgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyoqIFRoZSBsb2cgdG8gcmVwbGF5IGZyb20gYW5kIHN1YnNjcmliZSB0by4gKi9cbiAgbG9nOiBFdmVudExvZzxUPjtcbiAgLyoqIFRoZSBjYWxsZXIncyByZXN1bWUgY3Vyc29yLiBBYnNlbnQgb3IgdW5wYXJzZWFibGUgcmVwbGF5cyBmcm9tIHRoZSBzdGFydC4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIEhlYXJ0YmVhdCBjb21tZW50IGludGVydmFsLiBNVVNUIHN0YXkgd2VsbCB1bmRlciB0aGUgc2VydmVyJ3NcbiAgICogIGBpZGxlVGltZW91dGAg4oCUIHNlZSBgaGVhcnRiZWF0LnRzYCwgd2hpY2ggaXMgd2hlcmUgdGhhdCBwYWlyIGxpdmVzLiAqL1xuICBoZWFydGJlYXRNczogbnVtYmVyO1xuICAvKiogTGl2ZW5lc3MgcmVnaXN0cnk7IHRoZSBzdHJlYW0gYWRkcyBpdHNlbGYgb24gb3BlbiBhbmQgcmVtb3ZlcyBpdHNlbGYgaW5cbiAgICogIHRoZSB0ZWFyZG93biBmdW5uZWwuICovXG4gIGNsaWVudHM/OiBTc2VDbGllbnRzO1xuICAvKiogYHJlcS5zaWduYWxgIOKAlCB0aGUgb25seSB0aGluZyB0aGF0IHJlY2xhaW1zIGEgY2xpZW50IHRoYXQgd2VudCBhd2F5XG4gICAqICB3aXRob3V0IGNhbmNlbGxpbmcgdGhlIHN0cmVhbS4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKiBTZXJ2ZXItc2lkZSBmaWx0ZXIuIEEgcmVqZWN0ZWQgZnJhbWUgaXMgbm90IHNlbnQ7IHRoZSBjbGllbnQgc3RpbGxcbiAgICogIGFkdmFuY2VzIGl0cyBjdXJzb3IgcGFzdCBpdCwgd2hpY2ggaXMgYHRhaWxFdmVudHNgJ3MgZG9jdW1lbnRlZCBydWxlLiAqL1xuICBmaWx0ZXI/OiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiBib29sZWFuO1xuICAvKipcbiAgICogUmF3IFNTRSBjaHVua3Mgd3JpdHRlbiB0byBUSElTIHN0cmVhbSBCRUZPUkUgdGhlIHJlcGxheSDigJQgYWZ0ZXIgdGhlXG4gICAqIGBcIjogY29ubmVjdGVkXCJgIHByZWFtYmxlIGFuZCBiZWZvcmUgYGxvZy5zdWJzY3JpYmVgLCBzbyB3aGF0ZXZlciBpdCByZXR1cm5zXG4gICAqIGlzIHRoZSBzdHJlYW0ncyBmaXJzdCBEQVRBIGxpbmUgcmF0aGVyIHRoYW4gYSBmcmFtZSBidXJpZWQgYmVoaW5kIGFcbiAgICogcmVwbGF5ZWQgYmFja2xvZy5cbiAgICpcbiAgICog4puUIElUIElTIEEgUE9TSVRJT04sIFdISUNIIElTIFdIWSBgb25PcGVuYCBDT1VMRCBOT1QgU0VSVkUgKEQ4NSkuIGBvbk9wZW5gXG4gICAqIGZpcmVzIGF0IHRoZSBlbmQgb2YgYHN0YXJ0YCDigJQgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsXG4gICAqIGFmdGVyIGBjbGllbnRzLmFkZGAg4oCUIHNvIGEgY2FsbGVyIHRoYXQgc3VwcGxpZXMgaXRzIG93biBgY2xpZW50c2Agc2V0IGFuZFxuICAgKiBzZW5kcyBmcm9tIHRoZXJlIGxhbmRzIGl0cyBmcmFtZSBBRlRFUiB0aGUgYmFja2xvZy4gVGhhdCBpcyBleHByZXNzaWJsZSBhbmRcbiAgICogaXQgaXMgdGhlIHdyb25nIG9yZGVyLCB3aGljaCBpcyB0aGUgbmVhci1taXNzIHRoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50XG4gICAqIHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogbm90aGluZyBhYm91dCB0aGUgVFlQRVMgcHJldmVudHMgaXQsIGFuZCBhXG4gICAqIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IGNoZWNrIGNhbm5vdCBzZWUgYSBwb3NpdGlvbi5cbiAgICpcbiAgICog4puUIFJFU1RPUkVEIEZST00gVEhFIFNQRUxMIFRISVMgTU9EVUxFIFdBUyBDT05WRVJHRUQgVE9XQVJELCBBTkQgSVQgSVMgQVxuICAgKiBSRVNUT1JBVElPTiBSQVRIRVIgVEhBTiBBIFdJREVOSU5HIE9OIFRXTyBNRUFTVVJFRCBOVU1CRVJTIChENzkvRDg1KS5cbiAgICogbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgIHdyb3RlIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBvbmVcbiAgICogbGluZSBBQk9WRSBgYnVzLnN1YnNjcmliZWA7IHRoaXMgbW9kdWxlJ3MgY29udmVyZ2VuY2UgZHJvcHBlZCB0aGUgcG9zaXRpb24sXG4gICAqIHNvIHRoZSBvbmx5IHByb3BlcnR5IG1pbmQtbWFwcGVyIGNvdWxkIG5vdCBhZG9wdCB3YXMgdGhlIG9yZGVyaW5nLiBBcHBsaWVkLFxuICAgKiB3aXRoIGV2ZXJ5IGtpdC1idW5kbGluZyBzcGVsbCByZWJ1aWx0OiAqKihhKSBzb3VyY2UgZWRpdHMgbmVlZGVkIGF0IHRoZVxuICAgKiBvdGhlciBmaXZlIGFkb3B0ZXJzOiBaRVJPKiog4oCUIHRoZSBmaWVsZCBpcyBvcHRpb25hbCBhbmQgbm9ib2R5IHBhc3NlcyBpdDtcbiAgICogKiooYikgYnl0ZXMgb2YgYW55IG90aGVyIGFkb3B0ZXIncyBXSVJFIHRoYXQgZGlmZmVyOiBaRVJPKiog4oCUIGFzdHJvbGFiZSxcbiAgICogYm91bnR5LCBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllIHdlcmUgZHJpdmVuIHVuZGVyIHRoZWlyIG93biBzdWl0ZXMgYW5kXG4gICAqIHRoZWlyIHJlbGVhc2UgZHJpdmVzLCBhbmQgbm9uZSBvZiB0aGVtIHdyaXRlcyBhdCBvcGVuLiBCb3RoIG51bWJlcnMgemVybyBpc1xuICAgKiB3aGF0IFwidGhlIGtpdCByZW1vdmVkIGl0IHdoZW4gaXQgY29waWVkXCIgbWVhbnMgb3BlcmF0aW9uYWxseS5cbiAgICpcbiAgICog4pqgIEFORCBUSEUgSE9PSyBXQVMgUkVKRUNURUQgT05DRSwgRk9SIEEgUkVBU09OIFRIQVQgRE9FUyBOT1QgUkVBQ0ggVEhJU1xuICAgKiBDQVNFLiBEMzIncyBub3QtdGFrZW4gYXJndWVkIGFnYWluc3QgXCJhIGBzc2VSZXNwb25zZWAgaG9vayB0aGF0IGhhbmRzIHRoZVxuICAgKiBjYWxsZXIgYSByYXcgYHNlbmRgIOKApiB0aGUgY2FsbGVyIHRoZW4gaGFzIHRvIGtlZXAgaXRzIG93biBjb2xsZWN0aW9uIG9mXG4gICAqIHRoZW1cIiDigJQgYWdhaW5zdCBnbGFtb3VyJ3MgcHJlc2VuY2UgQlJPQURDQVNULCB3aGljaCBwdXNoZXMgdG9cbiAgICogYWxyZWFkeS1vcGVuIHN0cmVhbXMgZnJvbSBvdXRzaWRlIGFuZCBkb2VzIG5lZWQgYSBjb2xsZWN0aW9uLiBUaGlzIGlzIG9uZVxuICAgKiBmcmFtZSwgb24gb25lIHN0cmVhbSwgYXQgb3BlbiwgYW5kIHRoZSBjYWxsZXIga2VlcHMgbm8gY29sbGVjdGlvbiBhdCBhbGwuXG4gICAqIEEgcmVqZWN0aW9uIGlzIHNjb3BlZCB0byB0aGUgY2FzZSB0aGF0IHByb2R1Y2VkIGl0LlxuICAgKi9cbiAgb3BlbkZyYW1lcz86ICgpID0+IHN0cmluZ1tdO1xuICAvKiogUnVuIGFmdGVyIHRoZSBzdHJlYW0gaXMgc3Vic2NyaWJlZCAocHJlc2VuY2UgdXAsIGFjdGl2aXR5IHRvdWNoKS4gKi9cbiAgb25PcGVuPzogKCkgPT4gdm9pZDtcbiAgLyoqIFJ1biBleGFjdGx5IG9uY2UsIGZyb20gd2hpY2hldmVyIHRlYXJkb3duIHBhdGggZmlyZXMgZmlyc3QuICovXG4gIG9uQ2xvc2U/OiAoKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3NlUmVzcG9uc2U8VCBleHRlbmRzIG9iamVjdD4ob3B0czogU3NlT3B0aW9uczxUPik6IFJlc3BvbnNlIHtcbiAgY29uc3QgeyBsb2csIHNpbmNlLCBoZWFydGJlYXRNcywgY2xpZW50cywgc2lnbmFsLCBmaWx0ZXIsIG9wZW5GcmFtZXMsIG9uT3Blbiwgb25DbG9zZSB9ID0gb3B0cztcblxuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBUaGUgcmVnaXN0cnkgZW50cnkgZm9yIFRISVMgc3RyZWFtLiBJdHMgbWV0aG9kcyBhcmUgZmlsbGVkIGluIGJ5IGBzdGFydGAsXG4gIC8vIHdoaWNoIGlzIHdoZXJlIHRoZSBjb250cm9sbGVyIGV4aXN0czsgdGhlIG9iamVjdCBpZGVudGl0eSBpcyBzdGFibGUgZnJvbVxuICAvLyBoZXJlIHNvIGB0ZWFyZG93bmAgY2FuIHJlbW92ZSBleGFjdGx5IHRoaXMgZW50cnkuXG4gIGNvbnN0IGNsaWVudDogU3NlQ2xpZW50ID0geyBjbG9zZTogKCkgPT4ge30sIHNlbmQ6ICgpID0+IHt9IH07XG5cbiAgY29uc3QgdGVhcmRvd24gPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgaWYgKGtlZXBhbGl2ZSAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChrZWVwYWxpdmUpO1xuICAgIHVuc3Vic2NyaWJlPy4oKTtcbiAgICBjbGllbnRzPy5kZWxldGUoY2xpZW50KTtcbiAgICBvbkNsb3NlPy4oKTtcbiAgfTtcblxuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xpZW50LmNsb3NlID0gKCkgPT4ge1xuICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogYWxyZWFkeSBjbG9zZWQgYnkgdGhlIHJ1bnRpbWUgKi9cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIC8vIOKblCBgc2VuZGAgR09FUyBUSFJPVUdIIGBzYWZlRW5xdWV1ZWAsIHNvIGFuIG91dC1vZi1iYW5kIGZyYW1lIG9iZXlzIHRoZVxuICAgICAgLy8gc2FtZSBjbG9zZWQtY2hlY2sgYW5kIHRoZSBzYW1lIHRlYXJkb3duLW9uLXRocm93IGFzIGEgbG9nZ2VkIG9uZS4gQVxuICAgICAgLy8gZGFlbW9uIG11c3Qgbm90IGJlIGFibGUgdG8gd3JpdGUgdG8gYSBzdHJlYW0gdGhpcyBtb2R1bGUgaGFzIHRvcm4gZG93bi5cbiAgICAgIGNsaWVudC5zZW5kID0gc2FmZUVucXVldWU7XG5cbiAgICAgIC8vIOKblCBBTiBPUEVOSU5HIENPTU1FTlQsIEJFRk9SRSBBTllUSElORyBFTFNFLiBJdCBmbHVzaGVzIHRoZSByZXNwb25zZVxuICAgICAgLy8gaGVhZGVycyBpbW1lZGlhdGVseTogc29tZSBIVFRQIGNsaWVudHMg4oCUIEJ1bidzIG93biBgZmV0Y2goKWAgaW5jbHVkZWQg4oCUXG4gICAgICAvLyBidWZmZXIgdW50aWwgdGhlIGZpcnN0IGJ5dGUgb2YgYm9keSBhcnJpdmVzLCBzbyBhIGdlbnVpbmVseSBxdWlldCBTU0VcbiAgICAgIC8vIHN0cmVhbSB3b3VsZCBvdGhlcndpc2UgbGVhdmUgdGhlIGNhbGxlcidzIGBmZXRjaCgpYCB1bnJlc29sdmVkLiBFdmVyeVxuICAgICAgLy8gaG91c2UgdGFpbCBjbGllbnQgcmVhZHMgYDpgIGxpbmVzIGFzIGNvbW1lbnRzIGFuZCBkcm9wcyB0aGVtLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcblxuICAgICAgLy8g4puUIEJFRk9SRSBUSEUgUkVQTEFZLCBBTkQgVEhFIE9SREVSIElTIFRIRSBXSE9MRSBQT0lOVCDigJQgc2VlXG4gICAgICAvLyBgb3BlbkZyYW1lc2AgaW4gdGhlIG9wdGlvbnMgYWJvdmUuIEEgZ3JvdW5kaW5nIGZyYW1lIHdyaXR0ZW4gaGVyZSBpc1xuICAgICAgLy8gdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZTsgd3JpdHRlbiBmcm9tIGBvbk9wZW5gIGl0IGFycml2ZXMgYWZ0ZXJcbiAgICAgIC8vIHRoZSByZXBsYXllZCBiYWNrbG9nLCB3aGljaCBpcyBhIGRpZmZlcmVudCBjb250cmFjdCB3ZWFyaW5nIHRoZSBzYW1lXG4gICAgICAvLyB0eXBlcy5cbiAgICAgIGlmIChvcGVuRnJhbWVzKSBmb3IgKGNvbnN0IGNodW5rIG9mIG9wZW5GcmFtZXMoKSkgc2FmZUVucXVldWUoY2h1bmspO1xuXG4gICAgICB1bnN1YnNjcmliZSA9IGxvZy5zdWJzY3JpYmUoc2luY2UsIChmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZmlsdGVyICYmICFmaWx0ZXIoZnJhbWUpKSByZXR1cm47XG4gICAgICAgIHNhZmVFbnF1ZXVlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGZyYW1lKX1cXG5cXG5gKTtcbiAgICAgIH0pO1xuXG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjogaGJcXG5cXG5cIiksIGhlYXJ0YmVhdE1zKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBjbGllbnRzPy5hZGQoY2xpZW50KTtcbiAgICAgIG9uT3Blbj8uKCk7XG4gICAgfSxcbiAgICBjYW5jZWwoKSB7XG4gICAgICB0ZWFyZG93bigpO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgIENvbm5lY3Rpb246IFwia2VlcC1hbGl2ZVwiLFxuICAgIH0sXG4gIH0pO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBUaGUgc2Vzc2lvbiDigJQgdGhlIGRhZW1vbidzIHN0YXRlLCBhbmQgdGhlIG9ubHkgY29kZSB0aGF0IHdyaXRlcyBhIGZpbGUuXG4gKlxuICogRTgncyBzaGFwZSwgdGhlIGhvdXNlJ3MgXCJtYXRlcmlhbGl6ZWQgcGF0aFwiIHBhdHRlcm46IHRoZSBkYWVtb24gb3ducyB0aGVcbiAqIHNlc3Npb24gKGNvbnRleHQsIGRvY3MsIHZlcnNpb25zLCB3aGljaCBpcyBhY3RpdmUsIHRoZSBjaGF0KSBhbmQgcGVyc2lzdHMgaXRcbiAqIGFzIGBtYW5pZmVzdC5qc29uYDsgZXZlcnkgdmVyc2lvbidzIFRFWFQgaXMgYSBmaWxlIGluIHRoZSBzZXNzaW9uIGZvbGRlciwgc29cbiAqIHRoZSBhZ2VudCBlZGl0cyB2ZXJzaW9ucyB3aXRoIGl0cyBvd24gZmlsZSB0b29scy5cbiAqXG4gKiAgICAgJFNDUklQVE9SSVVNX0hPTUUvc2Vzc2lvbnMvPHNlc3Npb25JZD4vXG4gKiAgICAgICBtYW5pZmVzdC5qc29uICAgICAgICAgICAgICB3cml0dGVuIGF0b21pY2FsbHksIG9uIGV2ZXJ5IGNoYW5nZVxuICogICAgICAgZG9jcy88c2x1Zz4vdjEubWQsIHYyLm1kICAgb25lIGZpbGUgcGVyIHZlcnNpb25cbiAqXG4gKiBUaGUgdGhyZWUgd3JpdGUgcnVsZXMsIGVhY2ggYSBkZWNpc2lvbiByYXRoZXIgdGhhbiBhIGhhYml0OlxuICpcbiAqIC0gKipUaGUgb3JpZ2luYWwgaXMgd3JpdHRlbiBPTkxZIGJ5IGBzYXZlYCoqIChFNykuIE9wZW5pbmcgY29waWVzIGl0IHRvIHYxO1xuICogICBub3RoaW5nIGVsc2UgdG91Y2hlcyBpdC5cbiAqIC0gKipFdmVyeSB3cml0ZSB0aGlzIG1vZHVsZSBtYWtlcyBpcyByZW1lbWJlcmVkIGJ5IGNvbnRlbnQgaGFzaCoqICh0aGVcbiAqICAgYG93bmVkYCBtYXApIHNvIHRoZSB3YXRjaGVyIGNhbiB0ZWxsIHRoZSBkYWVtb24ncyBvd24gd3JpdGVzIGZyb20gYW55b25lXG4gKiAgIGVsc2UncyAoaW52ZXN0aWdhdGlvbiDCpzUpLiBBIHdyaXRlIHRvIHRoZSBBQ1RJVkUgdmVyc2lvbiB0aGF0IGlzIG5vdCBvdXJzXG4gKiAgIGlzIGFuIEUyIHZpb2xhdGlvbiB0aGUgZGFlbW9uIGFubm91bmNlcy5cbiAqIC0gKipUaGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSBhY3RpdmUgdmVyc2lvbioqIChFMikg4oCUIGVuZm9yY2VkIHNvY2lhbGx5IGJ5XG4gKiAgIFNLSUxMLm1kIGFuZCBkZXRlY3RlZCBoZXJlLCBub3QgcHJldmVudGVkOiB0aGUgZmlsZSBpcyB0aGUgYWdlbnQncyBtZWRpdW0uXG4gKlxuICogTm90aGluZyBoZXJlIGtub3dzIGFib3V0IHNvY2tldHMsIEhUVFAgb3IgdGhlIGV2ZW50IGxvZy4gVGhlIGRhZW1vbiBjYWxscyBhXG4gKiBtZXRob2QsIGdldHMgYSByZXN1bHQsIGFuZCBkZWNpZGVzIHdoYXQgdG8gYnJvYWRjYXN0OyB0aGF0IHNwbGl0IGlzIHdoYXRcbiAqIGxldHMgdGhlIHVuaXQgY2VsbHMgZHJpdmUgdGhlIHdob2xlIG1vZGVsIHdpdGggYSB0ZW1wIGhvbWUuXG4gKi9cblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIHN0YXRTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENoYXRNZXNzYWdlLFxuICBDaGF0V2hvLFxuICBDb250ZXh0RW50cnksXG4gIERvY1ZpZXcsXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFZlcnNpb24sXG4gIFZlcnNpb25BdXRob3IsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyBlbnRyeUZvclBhdGgsIGlzRG9jTmFtZSwgbG9jYXRlLCBzY2FuVHJlZSB9IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IGNvbnN0IE1BTklGRVNUX0ZPUk1BVCA9IDE7XG5cbnR5cGUgRG9jUmVjb3JkID0ge1xuICBzbHVnOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgb3JpZ2luYWw6IHN0cmluZztcbiAgZW50cnlJZDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsOiBzdHJpbmcgfCBudWxsO1xuICBleHQ6IHN0cmluZztcbiAgdmVyc2lvbnM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+W107XG4gIGFjdGl2ZTogbnVtYmVyO1xuICAvKiogSGFzaCBvZiB0aGUgb3JpZ2luYWwgYXMgd2UgbGFzdCByZWFkIG9yIHdyb3RlIGl0IOKAlCBhdCBvcGVuLCBzYXZlLCByZXZlcnRcbiAgICogIGFuZCByZWxvYWQg4oCUIHNvIGEgcmVzdG9yZSBjYW4gdGVsbCB0aGF0IGl0IGNoYW5nZWQgd2hpbGUgbm8gZGFlbW9uIHdhc1xuICAgKiAgd2F0Y2hpbmcgKHZlcmlmeS1wYXNzIGZpeCAyKS4gKi9cbiAgb3JpZ2luYWxIYXNoOiBzdHJpbmc7XG4gIC8qKiBTZXQgb25seSBieSBgb3BlblBhdGhgLCB3aGljaCBhZG1pdHMgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogIGVudHJ5LiBgc2F2ZWAgd3JpdGVzIG5vIG9yaWdpbmFsIHRoYXQgbGFja3MgaXQgKHZlcmlmeS1wYXNzIGZpeCAxYykuICovXG4gIGFkbWl0dGVkPzogYm9vbGVhbjtcbiAgb3V0c2lkZUNoYW5nZWQ6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgZm9ybWF0OiBudW1iZXI7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgY29udGV4dDogQ29udGV4dEVudHJ5W107XG4gIGRvY3M6IERvY1JlY29yZFtdO1xuICBvcGVuRG9jOiBzdHJpbmcgfCBudWxsO1xuICBjaGF0OiBDaGF0TWVzc2FnZVtdO1xufTtcblxuLyoqIEEgcmVmdXNhbCB0aGUgZGFlbW9uIHR1cm5zIGludG8gYW4gSFRUUCBzdGF0dXMg4oCUIGBjaG9pY2VzYCB3aGVuIHRoZSBzZXQgaXMgaW4gaGFuZCAoQTEpLiAqL1xuZXhwb3J0IGNsYXNzIFNlc3Npb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IHN0YXR1czogNDAwIHwgNDA0IHwgNDA5LFxuICAgIHJlYWRvbmx5IGNob2ljZXM/OiBzdHJpbmdbXSxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IGNvbnRlbnRIYXNoID0gKHRleHQ6IHN0cmluZyk6IHN0cmluZyA9PiBCdW4uaGFzaCh0ZXh0KS50b1N0cmluZygxNik7XG5cbmNvbnN0IHJhbmRIZXggPSAobjogbnVtYmVyKSA9PlxuICBBcnJheS5mcm9tKGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKVxuICAgIC5tYXAoKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSlcbiAgICAuam9pbihcIlwiKTtcblxuZXhwb3J0IGNvbnN0IG5ld1Nlc3Npb25JZCA9ICgpOiBzdHJpbmcgPT4gcmFuZEhleCg0KTtcblxuLyoqIEEgcGF0aCdzIHJlYWxwYXRoLCBvciB0aGUgcGF0aCBpdHNlbGYgd2hlbiBpdCBjYW5ub3QgYmUgcmVzb2x2ZWQgKGdvbmUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWxPcihwOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiByZWFscGF0aFN5bmMocCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBwO1xuICB9XG59XG5cbi8qKiBXaGF0IGEgd2F0Y2hlciBldmVudCB0dXJuZWQgb3V0IHRvIGJlLiBgbnVsbGAgPSBub3RoaW5nIChvdXJzLCBvciBubyBjaGFuZ2UpLiAqL1xuZXhwb3J0IHR5cGUgRmlsZUV2ZW50ID1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgYWN0aXZlOiBmYWxzZSB9XG4gIHwge1xuICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiO1xuICAgICAgZG9jOiBzdHJpbmc7XG4gICAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgICBwYXRoOiBzdHJpbmc7XG4gICAgICAvKiogVGhlIG5ldyBhZ2VudCB2ZXJzaW9uIHRoZSBvdXRzaWRlIHRleHQgd2FzIHByZXNlcnZlZCBhcy4gKi9cbiAgICAgIHByZXNlcnZlZEFzOiBudW1iZXI7XG4gICAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmc7XG4gICAgfVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIjsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJ0cmVlXCI7IGVudHJ5SWQ6IHN0cmluZyB9O1xuXG5leHBvcnQgY2xhc3MgU2Vzc2lvbiB7XG4gIHJlYWRvbmx5IGRpcjogc3RyaW5nO1xuICBwcml2YXRlIG06IE1hbmlmZXN0O1xuICAvKiogcGF0aCDihpIgaGFzaCBvZiB0aGUgZGFlbW9uJ3MgbGFzdCB3cml0ZSB0byBpdC4gKi9cbiAgcHJpdmF0ZSBvd25lZCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiBoYXNoIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIGN1cnJlbnQgdGV4dC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVIYXNoID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgYXMgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIChvciBhZG9wdGVkKVxuICAgKiAgaXQg4oCUIHdoYXQgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gaXMgcmV2ZXJ0ZWQgdG8uICovXG4gIHByaXZhdGUgbGFzdEFjdGl2ZVRleHQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogV2hhdCBhIHJlc3RvcmUgZm91bmQgY2hhbmdlZCBvbiBkaXNrIHdoaWxlIG5vIGRhZW1vbiB3YXMgd2F0Y2hpbmcuICovXG4gIHJlc3RvcmVGaW5kaW5nczogeyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZzsgbWlzc2luZzogYm9vbGVhbiB9W10gPSBbXTtcblxuICBwcml2YXRlIGNvbnN0cnVjdG9yKFxuICAgIHJlYWRvbmx5IGhvbWU6IHN0cmluZyxcbiAgICBtYW5pZmVzdDogTWFuaWZlc3QsXG4gICkge1xuICAgIHRoaXMubSA9IG1hbmlmZXN0O1xuICAgIHRoaXMuZGlyID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIG1hbmlmZXN0LnNlc3Npb25JZCk7XG4gIH1cblxuICBzdGF0aWMgY3JlYXRlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcgPSBuZXdTZXNzaW9uSWQoKSk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCB7XG4gICAgICBmb3JtYXQ6IE1BTklGRVNUX0ZPUk1BVCxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGNvbnRleHQ6IFtdLFxuICAgICAgZG9jczogW10sXG4gICAgICBvcGVuRG9jOiBudWxsLFxuICAgICAgY2hhdDogW10sXG4gICAgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4ocy5kaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICAvKiogUmVsb2FkIGEgc2Vzc2lvbiBmcm9tIGl0cyBtYW5pZmVzdCAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gKS4gKi9cbiAgc3RhdGljIHJlc3RvcmUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgc2Vzc2lvbklkLCBcIm1hbmlmZXN0Lmpzb25cIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzYXZlZCBzZXNzaW9uICR7c2Vzc2lvbklkfWAsIDQwNCk7XG4gICAgY29uc3QgbSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgTWFuaWZlc3Q7XG4gICAgaWYgKG0uZm9ybWF0ICE9PSBNQU5JRkVTVF9GT1JNQVQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBzZXNzaW9uICR7c2Vzc2lvbklkfSBoYXMgbWFuaWZlc3QgZm9ybWF0ICR7bS5mb3JtYXR9YCwgNDA5KTtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwgbSk7XG4gICAgbWtkaXJTeW5jKGpvaW4ocy5kaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gTWlycm9ycyBhcmUgcmUtcmVhZCwgbm90IHRydXN0ZWQ6IHRoZSBmb2xkZXIgbWF5IGhhdmUgY2hhbmdlZCB3aGlsZSBub1xuICAgIC8vIGRhZW1vbiB3YXMgd2F0Y2hpbmcgaXQuXG4gICAgZm9yIChjb25zdCBlIG9mIHMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHMucmVzY2FuKGUuaWQpO1xuICAgIGZvciAoY29uc3QgZCBvZiBzLm0uZG9jcykge1xuICAgICAgY29uc3QgcCA9IHMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpO1xuICAgICAgY29uc3QgdGV4dCA9IGV4aXN0c1N5bmMocCkgPyByZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpIDogXCJcIjtcbiAgICAgIHMuYWRvcHRBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDI6IGFuIG9yaWdpbmFsIGNoYW5nZWQgd2hpbGUgdGhlIHNlc3Npb24gd2FzIGNsb3NlZFxuICAgICAgLy8gd2FzIGludmlzaWJsZSBoZXJlLCBzbyB0aGUgbmV4dCBTYXZlIG92ZXJ3cm90ZSBpdCB1bmFubm91bmNlZC4gVGhlXG4gICAgICAvLyBtYW5pZmVzdCBob2xkcyB0aGUgb3JpZ2luYWwncyBoYXNoIGFzIG9mIHRoZSBsYXN0IG9wZW4vc2F2ZS9yZXZlcnQvXG4gICAgICAvLyByZWxvYWQ7IGEgZGlmZmVyZW50IGhhc2ggbm93IGlzIGFuIG91dHNpZGUgY2hhbmdlLCBtYXJrZWQgZXhhY3RseSBhcyBhXG4gICAgICAvLyBsaXZlIG9uZSB3aXRoIGEgZGlydHkgYnVmZmVyIGlzIOKAlCBhc2tlZCwgbmV2ZXIgbWVyZ2VkIG9yIHJlbG9hZGVkLlxuICAgICAgbGV0IG5vdzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBub3cgPSBjb250ZW50SGFzaChyZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBub3cgPSBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKG5vdyA9PT0gbnVsbCB8fCBub3cgIT09IGQub3JpZ2luYWxIYXNoKSB7XG4gICAgICAgIGQub3V0c2lkZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgICBzLnJlc3RvcmVGaW5kaW5ncy5wdXNoKHsgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsLCBtaXNzaW5nOiBub3cgPT09IG51bGwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChzLnJlc3RvcmVGaW5kaW5ncy5sZW5ndGggPiAwKSBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIHN0YXRpYyBsaXN0U2F2ZWQoaG9tZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhZGRpclN5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIpKS5maWx0ZXIoKGlkKSA9PlxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBpZCwgXCJtYW5pZmVzdC5qc29uXCIpKSxcbiAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgZ2V0IGlkKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS5zZXNzaW9uSWQ7XG4gIH1cblxuICBnZXQgZG9jc0RpcigpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKHRoaXMuZGlyLCBcImRvY3NcIik7XG4gIH1cblxuICBnZXQgb3BlbkRvY1NsdWcoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubS5vcGVuRG9jO1xuICB9XG5cbiAgZ2V0IGNvbnRleHQoKTogcmVhZG9ubHkgQ29udGV4dEVudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBkaXJlY3RvcnkgdGhlIHdhdGNoZXIgbXVzdCBzZWU6IHRoZSBzZXNzaW9uJ3MgZG9jcywgZWFjaCBlbnRyeSByb290LFxuICAgKiBhbmQgdGhlIFJFQUwgZGlyZWN0b3J5IG9mIGV2ZXJ5IG9wZW5lZCBvcmlnaW5hbC5cbiAgICpcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCAzOiBlYWNoIHJvb3QgaXMgd2F0Y2hlZCBhdCBpdHMgUkVBTFBBVEggKGB3YXRjaGApLCBhbmRcbiAgICogYW4gZXZlbnQgaXMgcmVwb3J0ZWQgdW5kZXIgdGhlIHBhdGggZm9ybSB0aGUgc2Vzc2lvbiBzdG9yZXMgKGBwYXRoYCkuIEFcbiAgICogd2F0Y2ggb24gYSBzeW1saW5rZWQgZGlyZWN0b3J5IOKAlCBhIHN5bWxpbmtlZCBob21lLCBhIHN5bWxpbmtlZCBmb2xkZXJcbiAgICogZW50cnkg4oCUIG9yIG9uIHRoZSBsaW5rJ3Mgb3duIGRpcmVjdG9yeSBmb3IgYSBzeW1saW5rZWQgb3JpZ2luYWwgc2F3XG4gICAqIG5vdGhpbmcgd2hlbiB0aGUgVEFSR0VUIGNoYW5nZWQgKEZTRXZlbnRzIHJlcG9ydHMgcmVhbCBwYXRocykuIEEgc3ltbGlua2VkXG4gICAqIG9yaWdpbmFsIGlzIG1hdGNoZWQgYmFjayB0byBpdHMgZG9jIGJ5IHJlYWxwYXRoIGluIGBvbkZpbGVFdmVudGAuXG4gICAqL1xuICB3YXRjaFJvb3RzKCk6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdIHtcbiAgICBjb25zdCByb290czogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10gPSBbXG4gICAgICB7IHBhdGg6IHRoaXMuZG9jc0Rpciwgd2F0Y2g6IHJlYWxPcih0aGlzLmRvY3NEaXIpLCByZWN1cnNpdmU6IHRydWUgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIHJvb3RzLnB1c2goe1xuICAgICAgICBwYXRoOiBlLnJvb3QsXG4gICAgICAgIHdhdGNoOiByZWFsT3IoZS5yb290KSxcbiAgICAgICAgcmVjdXJzaXZlOiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIixcbiAgICAgICAgZW50cnlJZDogZS5pZCxcbiAgICAgIH0pO1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3QgcmVhbERpciA9IGRpcm5hbWUocmVhbE9yKGQub3JpZ2luYWwpKTtcbiAgICAgIGlmIChcbiAgICAgICAgIXJvb3RzLnNvbWUoKHIpID0+IHIud2F0Y2ggPT09IHJlYWxEaXIgJiYgci5yZWN1cnNpdmUgPT09IGZhbHNlKSAmJlxuICAgICAgICAhcm9vdHMuc29tZShcbiAgICAgICAgICAocikgPT4gci5yZWN1cnNpdmUgJiYgKHJlYWxEaXIgPT09IHIud2F0Y2ggfHwgcmVhbERpci5zdGFydHNXaXRoKHIud2F0Y2ggKyBzZXApKSxcbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgICByb290cy5wdXNoKHsgcGF0aDogcmVhbERpciwgd2F0Y2g6IHJlYWxEaXIsIHJlY3Vyc2l2ZTogZmFsc2UgfSk7XG4gICAgfVxuICAgIHJldHVybiByb290cztcbiAgfVxuXG4gIC8vIOKUgOKUgCBwZXJzaXN0ZW5jZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwZXJzaXN0KCk6IHZvaWQge1xuICAgIG1rZGlyU3luYyh0aGlzLmRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGpvaW4odGhpcy5kaXIsIFwibWFuaWZlc3QuanNvblwiKSwgYCR7SlNPTi5zdHJpbmdpZnkodGhpcy5tLCBudWxsLCAyKX1cXG5gKTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVPd25lZChwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBSZW1lbWJlciBCRUZPUkUgd3JpdGluZzogdGhlIHdhdGNoZXIncyBldmVudCBjYW4gYXJyaXZlIGJlZm9yZSB0aGlzXG4gICAgLy8gZnVuY3Rpb24gcmV0dXJucywgYW5kIGl0IG11c3QgZmluZCB0aGUgaGFzaCBhbHJlYWR5IHRoZXJlLlxuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBhZG9wdEFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHAgPSB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICB0aGlzLm93bmVkLnNldChwLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZUFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgLyoqIEtlZXAgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gYXMgYSBORVcgYWdlbnQgdmVyc2lvbi4gKi9cbiAgcHJpdmF0ZSBwcmVzZXJ2ZU91dHNpZGUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiBWZXJzaW9uIHtcbiAgICBjb25zdCBuID0gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgZnJvbTogZC5hY3RpdmUsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBsYWJlbDogYG91dHNpZGUgd3JpdGUgdG8gdiR7ZC5hY3RpdmV9YCxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbikgfTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmZiBgdGV4dGAgYXQgYHBhdGhgIGlzIGV4YWN0bHkgd2hhdCB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgdGhlcmUuICovXG4gIGlzT3duV3JpdGUocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5vd25lZC5nZXQocGF0aCkgPT09IGNvbnRlbnRIYXNoKHRleHQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbnRleHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkQ29udGV4dChyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBDb250ZXh0RW50cnk7IGFkZGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgY29uc3QgcHJvYmUgPSBlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCk7XG4gICAgY29uc3Qgc2FtZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5yb290ID09PSBwcm9iZS5yb290ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gcHJvYmUubWVtYmVyc2hpcCAmJlxuICAgICAgICAocHJvYmUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiIHx8XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgPT09IEpTT04uc3RyaW5naWZ5KHByb2JlLm5vZGVzKSksXG4gICAgKTtcbiAgICBpZiAoc2FtZSkgcmV0dXJuIHsgZW50cnk6IHNhbWUsIGFkZGVkOiBmYWxzZSB9O1xuICAgIHRoaXMubS5jb250ZXh0LnB1c2gocHJvYmUpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IHByb2JlLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgcmVtb3ZlQ29udGV4dChpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaSA9IHRoaXMubS5jb250ZXh0LmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICAgIGlmIChpIDwgMClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7aWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKGUpID0+IGUuaWQpLFxuICAgICAgKTtcbiAgICB0aGlzLm0uY29udGV4dC5zcGxpY2UoaSwgMSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QpO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjaG9pY2VzID0gdGhpcy5tLmRvY3MubWFwKChkKSA9PiBkLnNsdWcpO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICAvLyDim5QgT05MWSBBTiBBQlNPTFVURSBrZXkgaXMgYSBwYXRoICh2ZXJpZnktcGFzcyBmaXggOCk6IHJlc29sdmluZyBhXG4gICAgLy8gcmVsYXRpdmUgb25lIGhlcmUgcmVzb2x2ZWQgaXQgYWdhaW5zdCB0aGUgREFFTU9OJ3MgY3dkLiBUaGUgQ0xJIHJlc29sdmVzXG4gICAgLy8gYWdhaW5zdCBpdHMgb3duIGN3ZCBhbmQgc2VuZHMgYW4gYWJzb2x1dGUgcGF0aC5cbiAgICBpZiAoaXNBYnNvbHV0ZShrZXkpKSB7XG4gICAgICBjb25zdCBieVBhdGggPSB0aGlzLm0uZG9jcy5maW5kKFxuICAgICAgICAoZCkgPT4gZC5vcmlnaW5hbCA9PT0ga2V5IHx8IHJlYWxPcihkLm9yaWdpbmFsKSA9PT0gcmVhbE9yKGtleSksXG4gICAgICApO1xuICAgICAgaWYgKGJ5UGF0aCkgcmV0dXJuIGJ5UGF0aDtcbiAgICB9XG4gICAgY29uc3QgYnlOYW1lID0gdGhpcy5tLmRvY3MuZmlsdGVyKChkKSA9PiBiYXNlbmFtZShkLm9yaWdpbmFsKSA9PT0ga2V5IHx8IGQucmVsID09PSBrZXkpO1xuICAgIHJldHVybiBieU5hbWUubGVuZ3RoID09PSAxID8gYnlOYW1lWzBdIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgcHJpdmF0ZSB2ZXJzaW9uT3JEaWUoZDogRG9jUmVjb3JkLCBuOiBudW1iZXIpOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiB7XG4gICAgY29uc3QgdiA9IGQudmVyc2lvbnMuZmluZCgoeCkgPT4geC5uID09PSBuKTtcbiAgICBpZiAoIXYpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtkLnNsdWd9IGhhcyBubyB2JHtufWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgZC52ZXJzaW9ucy5tYXAoKHgpID0+IGB2JHt4Lm59YCksXG4gICAgICApO1xuICAgIHJldHVybiB2O1xuICB9XG5cbiAgcHJpdmF0ZSBzbHVnRm9yKG9yaWdpbmFsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHN0ZW0gPVxuICAgICAgYmFzZW5hbWUob3JpZ2luYWwsIGV4dG5hbWUob3JpZ2luYWwpKVxuICAgICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgICAucmVwbGFjZSgvW15hLXowLTlfLV0rL2csIFwiLVwiKVxuICAgICAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKSB8fCBcImRvY1wiO1xuICAgIGxldCBzbHVnID0gc3RlbTtcbiAgICBmb3IgKGxldCBpID0gMjsgdGhpcy5tLmRvY3Muc29tZSgoZCkgPT4gZC5zbHVnID09PSBzbHVnKTsgaSsrKSBzbHVnID0gYCR7c3RlbX0tJHtpfWA7XG4gICAgcmV0dXJuIHNsdWc7XG4gIH1cblxuICAvKipcbiAgICogT3BlbiBhIGRvY3VtZW50IGJ5IGl0cyBvcmlnaW5hbCdzIHBhdGg6IHYxIGlzIHdyaXR0ZW4gZnJvbSB0aGUgb3JpZ2luYWxcbiAgICogdGhlIGZpcnN0IHRpbWUuIGBmb2N1czogZmFsc2VgICh0aGUgYWdlbnQncyBpbXBsaWNpdCBvcGVuIHRocm91Z2hcbiAgICogYHZlcnNpb24tbmV3IC0tZG9jIDxwYXRoPmApIGRvZXMgbm90IG1vdmUgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICpcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCAxYiDigJQgQURNSVNTSU9OLiBPbmx5IGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqIGVudHJ5IGlzIGFkbWl0dGVkOyBgY29udGV4dC5hZGRgIHN0YXlzIHRoZSBvbmUgd2F5IGluLiBCZWZvcmUgdGhpcywgYW55XG4gICAqIHBhdGggb2YgYW55IHR5cGUgd2FzIG9wZW5lZCwgYW5kIFNhdmUgdGhlbiB3cm90ZSBpdDogYSBmb3JlaWduIHdlYiBwYWdlXG4gICAqIHdyb3RlIGBjdXJsIGV2aWwgfCBzaGAgaW50byBhIGAucmNgIGZpbGUgb3V0c2lkZSB0aGUgY29udGV4dC5cbiAgICovXG4gIG9wZW5QYXRoKHJhd1BhdGg6IHN0cmluZywgb3B0czogeyBmb2N1cz86IGJvb2xlYW4gfSA9IHt9KTogeyBzbHVnOiBzdHJpbmc7IGNyZWF0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgZm9jdXMgPSBvcHRzLmZvY3VzID8/IHRydWU7XG4gICAgLy8gVGhlIGNvbnRleHQncyBvd24gc3BlbGxpbmcgb2YgdGhlIHBhdGg6IGEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhIHJlYWxwYXRoXG4gICAgLy8gKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBvciB0aHJvdWdoIGEgc3ltbGlua2VkIGZvbGRlcikgbmFtZXMgdGhlIHNhbWVcbiAgICAvLyBmaWxlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIGRvYy5cbiAgICBjb25zdCBhYnMgPSB0aGlzLmNhbm9uaWNhbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IGFicyk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZXhpc3Rpbmcuc2x1ZztcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsgc2x1ZzogZXhpc3Rpbmcuc2x1ZywgY3JlYXRlZDogZmFsc2UgfTtcbiAgICB9XG4gICAgaWYgKCFpc0RvY05hbWUoYWJzKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7YWJzfWAsIDQwMCk7XG4gICAgaWYgKCFsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicykpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHthYnN9IGlzIG5vdCBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0IOKAlCBhZGQgaXQgKG9yIGl0cyBmb2xkZXIpIGZpcnN0YCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXN0YXRTeW5jKGFicykuaXNGaWxlKCkpIHRocm93IG5ldyBFcnJvcihcIm5vdCBhIGZpbGVcIik7XG4gICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgY2Fubm90IG9wZW4gJHthYnN9OiBubyBzdWNoIGZpbGVgLCA0MDQpO1xuICAgIH1cbiAgICBjb25zdCBleHQgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXS5pbmNsdWRlcyhleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKSlcbiAgICAgID8gZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKClcbiAgICAgIDogXCIubWRcIjtcbiAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKTtcbiAgICBjb25zdCBkOiBEb2NSZWNvcmQgPSB7XG4gICAgICBzbHVnOiB0aGlzLnNsdWdGb3IoYWJzKSxcbiAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICBvcmlnaW5hbDogYWJzLFxuICAgICAgZW50cnlJZDogYXQ/LmVudHJ5SWQgPz8gbnVsbCxcbiAgICAgIHJlbDogYXQ/LnJlbCA/PyBudWxsLFxuICAgICAgZXh0LFxuICAgICAgdmVyc2lvbnM6IFt7IG46IDEsIGF1dGhvcjogXCJodW1hblwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfV0sXG4gICAgICBhY3RpdmU6IDEsXG4gICAgICBvcmlnaW5hbEhhc2g6IGNvbnRlbnRIYXNoKHRleHQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGZhbHNlLFxuICAgICAgYWRtaXR0ZWQ6IHRydWUsXG4gICAgfTtcbiAgICB0aGlzLm0uZG9jcy5wdXNoKGQpO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGQuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIGNyZWF0ZWQ6IHRydWUgfTtcbiAgfVxuXG4gIC8qKiBgYWJzYCBhcyB0aGUgY29udGV4dCBzcGVsbHMgaXQsIHdoZW4gaXQgaXMgdGhlIHNhbWUgZmlsZSBieSByZWFscGF0aC4gKi9cbiAgcHJpdmF0ZSBjYW5vbmljYWwoYWJzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicykpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmICghcmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgY29udGludWU7XG4gICAgICBjb25zdCBzcGVsbGVkID0gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBzcGVsbGVkKSkgcmV0dXJuIHNwZWxsZWQ7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBvcGVuU2x1ZyhzbHVnOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLm0ub3BlbkRvYyA9IHRoaXMuZG9jT3JEaWUoc2x1Zykuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIHJlYWRWZXJzaW9uKHNsdWc6IHN0cmluZywgbjogbnVtYmVyKTogeyB0ZXh0OiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBuKTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBuKTtcbiAgICByZXR1cm4geyB0ZXh0OiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLCBwYXRoIH07XG4gIH1cblxuICBhY3RpdmVQYXRoKHNsdWc/OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBkID0gc2x1ZyA/IHRoaXMuZmluZERvYyhzbHVnKSA6IHRoaXMubS5vcGVuRG9jID8gdGhpcy5maW5kRG9jKHRoaXMubS5vcGVuRG9jKSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gZCA/IHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpIDogbnVsbDtcbiAgfVxuXG4gIC8qKiBUaGUgaHVtYW4ncyBidWZmZXIgcmVhY2hlcyB0aGUgQUNUSVZFIHZlcnNpb24ncyBmaWxlIChkZWJvdW5jZWQgYnkgdGhlIHN1cmZhY2UpLiAqL1xuICAvKipcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCA0IOKAlCBDSEVDSyBCRUZPUkUgV1JJVEUuIEJlZm9yZSB0aGUgaHVtYW4ncyBlZGl0IGlzXG4gICAqIHdyaXR0ZW4sIHRoZSBmaWxlIG9uIGRpc2sgaXMgaGFzaGVkOiBpZiBpdCBpcyBub3QgdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAqIHdyaXRlLCBzb21lb25lIGVsc2Ugd3JvdGUgdGhlIGFjdGl2ZSB2ZXJzaW9uIChFMikuIFRoYXQgdGV4dCBpcyBrZXB0IGFzIGFcbiAgICogTkVXIGFnZW50IHZlcnNpb24sIGFuZCBvbmx5IHRoZW4gaXMgdGhlIGVkaXQgd3JpdHRlbi4gRGV0ZWN0aW9uIHVzZWQgdG9cbiAgICogZGVwZW5kIG9uIHRoZSB3YXRjaGVyJ3MgNjAgbXMgc2V0dGxlIHRpbWVyIGZpcmluZyBiZWZvcmUgdGhlIG5leHRcbiAgICoga2V5c3Ryb2tlOyBhIGJ1cnN0IG9mIGVkaXRzIGF0IDMwIG1zIGNsb2JiZXJlZCBhbiBvdXRzaWRlIHdyaXRlXG4gICAqIHVuYW5ub3VuY2VkLiBOb3cgbm90aGluZyBpcyBsb3N0IHdoYXRldmVyIHRoZSB0aW1pbmcg4oCUIHRoZSBvbmUgd2luZG93IGxlZnRcbiAgICogaXMgdGhlIG1pY3Jvc2Vjb25kcyBiZXR3ZWVuIHRoaXMgcmVhZCBhbmQgdGhpcyB3cml0ZS5cbiAgICovXG4gIGVkaXQoXG4gICAgc2x1Zzogc3RyaW5nLFxuICAgIG46IG51bWJlcixcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICk6IHsgZGlydHlDaGFuZ2VkOiBib29sZWFuOyBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGlmIChuICE9PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtufSBpcyBub3QgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSAodiR7ZC5hY3RpdmV9IGlzKSDigJQgb25seSB0aGUgYWN0aXZlIHZlcnNpb24gaXMgZWRpdGFibGVgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHRoaXMuaXNEaXJ0eShkKTtcbiAgICBjb25zdCBwYXRoID0gdGhpcy52ZXJzaW9uUGF0aChkLCBuKTtcbiAgICAvLyBUaGUgZWRpdCBpcyBzdGFnZWQgaW4gYSBzaWJsaW5nIGZpbGUgRklSU1QsIHNvIHRoZSBjaGVjayBiZWxvdyBhbmQgdGhlXG4gICAgLy8gcmVuYW1lIHRoYXQgbGFuZHMgdGhlIGVkaXQgYXJlIGFkamFjZW50IHN5c2NhbGxzOiB0aGUgd2luZG93IGluIHdoaWNoIGFuXG4gICAgLy8gb3V0c2lkZSB3cml0ZSBjb3VsZCBzbGlwIGJldHdlZW4gdGhlbSBpcyBtaWNyb3NlY29uZHMsIG5vdCB0aGUgbGVuZ3RoIG9mXG4gICAgLy8gYSBtdWx0aS1tZWdhYnl0ZSB3cml0ZSDigJQgYW5kIGEgd3JpdGUgbGFuZGluZyBBRlRFUiB0aGUgcmVuYW1lIGdvZXMgdG8gdGhlXG4gICAgLy8gbmV3IGZpbGUsIHdoZXJlIHRoZSB3YXRjaGVyIGZpbmRzIGl0IGFuZCBwcmVzZXJ2ZXMgaXQgdG9vLlxuICAgIGNvbnN0IHN0YWdlZCA9IGAke3BhdGh9LiR7cHJvY2Vzcy5waWR9LmVkaXRgO1xuICAgIHdyaXRlRmlsZVN5bmMoc3RhZ2VkLCB0ZXh0KTtcbiAgICBsZXQgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IG9uRGlzazogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIG9uRGlzayA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICBvbkRpc2sgPSBudWxsO1xuICAgIH1cbiAgICBpZiAob25EaXNrICE9PSBudWxsICYmICF0aGlzLmlzT3duV3JpdGUocGF0aCwgb25EaXNrKSlcbiAgICAgIHByZXNlcnZlZCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIG9uRGlzayk7XG4gICAgdGhpcy5vd25lZC5zZXQocGF0aCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHJlbmFtZVN5bmMoc3RhZ2VkLCBwYXRoKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMubGFzdEFjdGl2ZVRleHQuc2V0KGQuc2x1ZywgdGV4dCk7XG4gICAgcmV0dXJuIHsgZGlydHlDaGFuZ2VkOiBiZWZvcmUgIT09IHRoaXMuaXNEaXJ0eShkKSwgcHJlc2VydmVkIH07XG4gIH1cblxuICAvKiogQ29weSBhIHZlcnNpb24gdG8gYSBuZXcgZmlsZTsgdGhlIGFnZW50IHRoZW4gZWRpdHMgdGhhdCBmaWxlIHdpdGggaXRzIG93biB0b29scy4gKi9cbiAgbmV3VmVyc2lvbihvcHRzOiB7IGRvYz86IHN0cmluZzsgZnJvbT86IG51bWJlcjsgbGFiZWw/OiBzdHJpbmc7IGF1dGhvcjogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBWZXJzaW9uO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgZnJvbSA9IG9wdHMuZnJvbSA/PyBkLmFjdGl2ZTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBmcm9tKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZnJvbSksIFwidXRmOFwiKTtcbiAgICBjb25zdCBuID0gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogb3B0cy5hdXRob3IsXG4gICAgICBmcm9tLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgLi4uKG9wdHMubGFiZWwgPyB7IGxhYmVsOiBvcHRzLmxhYmVsIH0gOiB7fSksXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCB2ZXJzaW9uOiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9IH07XG4gIH1cblxuICBhY3RpdmF0ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0pOiB7IHNsdWc6IHN0cmluZzsgcHJldmlvdXM6IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IGQuYWN0aXZlO1xuICAgIGQuYWN0aXZlID0gb3B0cy52ZXJzaW9uO1xuICAgIC8vIFRoZSBuZXcgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IEFTIElUIElTIE5PVyBpcyB0aGUgYmFzZWxpbmUgdGhlIG5leHRcbiAgICAvLyBjaGVjay1iZWZvcmUtd3JpdGUgY29tcGFyZXMgYWdhaW5zdC5cbiAgICB0aGlzLmFkb3B0QWN0aXZlKGQsIHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHByZXZpb3VzIH07XG4gIH1cblxuICAvKiogU2F2ZTogdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBvdmVyIHRoZSBvcmlnaW5hbC4gVGhlIE9OTFkgd3JpdGUgdG8gaXQgKEU3KS4gKi9cbiAgc2F2ZShzbHVnOiBzdHJpbmcpOiB7IG9yaWdpbmFsOiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDFjOiBTYXZlIHdyaXRlcyBvbmx5IGFuIG9yaWdpbmFsIGFkbWl0dGVkIGJ5XG4gICAgLy8gYG9wZW5QYXRoYCAoYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkpLiBDaGVja2VkIGFnYWluIGhlcmVcbiAgICAvLyBzbyBubyBvdGhlciBwYXRoIGludG8gdGhlIG1hbmlmZXN0IOKAlCBhIGhhbmQtZWRpdGVkIG9uZSwgYSBmdXR1cmUgdmVyYiDigJRcbiAgICAvLyBjYW4gdHVybiBTYXZlIGludG8gXCJ3cml0ZSBhbnkgZmlsZVwiLlxuICAgIGlmICghZC5hZG1pdHRlZCB8fCAhaXNEb2NOYW1lKGQub3JpZ2luYWwpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHJlZnVzaW5nIHRvIHNhdmUgJHtkLm9yaWdpbmFsfTogaXQgd2FzIG5vdCBvcGVuZWQgZnJvbSB0aGUgY29udGV4dGAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgXCJ1dGY4XCIpO1xuICAgIHRoaXMud3JpdGVPd25lZChkLm9yaWdpbmFsLCB0ZXh0KTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBvcmlnaW5hbDogZC5vcmlnaW5hbCwgdmVyc2lvbjogZC5hY3RpdmUgfTtcbiAgfVxuXG4gIC8qKiBSZXZlcnQ6IHRoZSBvcmlnaW5hbCdzIHRleHQgYmFjayBvdmVyIHRoZSBhY3RpdmUgdmVyc2lvbi4gKi9cbiAgcmV2ZXJ0KHNsdWc6IHN0cmluZyk6IHsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhkLm9yaWdpbmFsLCBcInV0ZjhcIik7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyB2ZXJzaW9uOiBkLmFjdGl2ZSwgdGV4dCB9O1xuICB9XG5cbiAgcHJpdmF0ZSBpc0RpcnR5KGQ6IERvY1JlY29yZCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAodGhpcy5hY3RpdmVIYXNoLmdldChkLnNsdWcpID8/IFwiXCIpICE9PSBkLm9yaWdpbmFsSGFzaDtcbiAgfVxuXG4gIC8vIOKUgOKUgCB0aGUgd2F0Y2hlcidzIHF1ZXN0aW9uOiB3aG9zZSB3cml0ZSB3YXMgdGhhdD8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIENsYXNzaWZ5IG9uZSBmaWxlc3lzdGVtIGV2ZW50LiBSZWFkcyB0aGUgZmlsZTsgcmV0dXJucyBgbnVsbGAgd2hlbiBpdCBpc1xuICAgKiB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlLCB1bmNoYW5nZWQsIGdvbmUsIG9yIG5vdCBvdXJzIHRvIGNhcmUgYWJvdXQuXG4gICAqL1xuICBvbkZpbGVFdmVudChhYnM6IHN0cmluZyk6IEZpbGVFdmVudCB8IG51bGwge1xuICAgIC8vIEEgdmVyc2lvbiBmaWxlIHVuZGVyIGRvY3MvPHNsdWc+L3ZOLmV4dD9cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy5kb2NzRGlyICsgc2VwKSkge1xuICAgICAgY29uc3QgcmVzdCA9IGFicy5zbGljZSh0aGlzLmRvY3NEaXIubGVuZ3RoICsgMSkuc3BsaXQoc2VwKTtcbiAgICAgIGlmIChyZXN0Lmxlbmd0aCAhPT0gMikgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBbc2x1ZywgZmlsZV0gPSByZXN0IGFzIFtzdHJpbmcsIHN0cmluZ107XG4gICAgICBjb25zdCBkID0gdGhpcy5tLmRvY3MuZmluZCgoeCkgPT4geC5zbHVnID09PSBzbHVnKTtcbiAgICAgIGNvbnN0IG1hdGNoID0gL152KFxcZCspKFxcLlthLXpdKykkLy5leGVjKGZpbGUpO1xuICAgICAgaWYgKCFkIHx8ICFtYXRjaCB8fCBtYXRjaFsyXSAhPT0gZC5leHQpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgbiA9IE51bWJlcihtYXRjaFsxXSk7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLmlzT3duV3JpdGUoYWJzLCB0ZXh0KSkgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIWQudmVyc2lvbnMuc29tZSgodikgPT4gdi5uID09PSBuKSkge1xuICAgICAgICAvLyBUaGUgYWdlbnQgd3JvdGUgYSB2ZXJzaW9uIGZpbGUgYnkgaGFuZCByYXRoZXIgdGhhbiB0aHJvdWdoXG4gICAgICAgIC8vIGB2ZXJzaW9uLW5ld2Ag4oCUIGFkb3B0IGl0IHJhdGhlciB0aGFuIGxlYXZlIGEgZmlsZSB0aGUgc3VyZmFjZSBjYW5ub3Qgc2VlLlxuICAgICAgICBkLnZlcnNpb25zLnB1c2goeyBuLCBhdXRob3I6IFwiYWdlbnRcIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH0pO1xuICAgICAgICBkLnZlcnNpb25zLnNvcnQoKGEsIGIpID0+IGEubiAtIGIubik7XG4gICAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHBhdGg6IGFicyB9O1xuICAgICAgfVxuICAgICAgaWYgKG4gPT09IGQuYWN0aXZlKSB7XG4gICAgICAgIC8vIEUyLCByZWZ1c2VkIGFuZCBSRS1MQUJFTExFRDogdGhlIG91dHNpZGUgdGV4dCBiZWNvbWVzIGEgbmV3IGFnZW50XG4gICAgICAgIC8vIHZlcnNpb24sIGFuZCB0aGUgYWN0aXZlIHZlcnNpb24gZ29lcyBiYWNrIHRvIHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgICAgICAvLyB0ZXh0IOKAlCBzbyB0aGUgYWN0aXZlIHZlcnNpb24gb25seSBldmVyIGhvbGRzIHdoYXQgdGhlIGh1bWFuIHR5cGVkLFxuICAgICAgICAvLyBhbmQgbm90aGluZyBhbnlvbmUgd3JvdGUgaXMgbG9zdCAodmVyaWZ5LXBhc3MgZml4IDQsIHdhdGNoZXIgaGFsZikuXG4gICAgICAgIGNvbnN0IGtlcHQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCB0ZXh0KTtcbiAgICAgICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0aGlzLmxhc3RBY3RpdmVUZXh0LmdldChkLnNsdWcpID8/IHRleHQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBuLFxuICAgICAgICAgIHBhdGg6IGFicyxcbiAgICAgICAgICBwcmVzZXJ2ZWRBczoga2VwdC5uLFxuICAgICAgICAgIHByZXNlcnZlZFBhdGg6IGtlcHQucGF0aCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHRleHQsIGFjdGl2ZTogZmFsc2UgfTtcbiAgICB9XG5cbiAgICAvLyBBbiBvcGVuZWQgb3JpZ2luYWwg4oCUIGJ5IGl0cyBzdG9yZWQgcGF0aCwgb3IgYnkgcmVhbHBhdGggZm9yIGEgc3ltbGluaz9cbiAgICBjb25zdCBkID0gdGhpcy5tLmRvY3MuZmluZCgoeCkgPT4geC5vcmlnaW5hbCA9PT0gYWJzIHx8IHJlYWxPcih4Lm9yaWdpbmFsKSA9PT0gYWJzKTtcbiAgICBpZiAoZCkge1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBjb25zdCBoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgICBpZiAoaCA9PT0gZC5vcmlnaW5hbEhhc2gpIHJldHVybiBudWxsOyAvLyBvdXIgb3duIHNhdmUsIG9yIG5vIGNoYW5nZVxuICAgICAgY29uc3QgY2xlYW4gPSAhdGhpcy5pc0RpcnR5KGQpO1xuICAgICAgaWYgKGNsZWFuKSB7XG4gICAgICAgIGQub3JpZ2luYWxIYXNoID0gaDtcbiAgICAgICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAoZC5vdXRzaWRlQ2hhbmdlZCkgcmV0dXJuIG51bGw7IC8vIGFscmVhZHkgYXNrZWRcbiAgICAgIGQub3V0c2lkZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCB9O1xuICAgIH1cblxuICAgIC8vIFNvbWV0aGluZyB1bmRlciBhIG1pcnJvcmVkIHJvb3Q6IHRoZSB0cmVlIG1heSBoYXZlIGNoYW5nZWQuXG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiYgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSB7XG4gICAgICAgIHJldHVybiB0aGlzLnJlc2NhbihlLmlkKSA/IHsga2luZDogXCJ0cmVlXCIsIGVudHJ5SWQ6IGUuaWQgfSA6IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNoYXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkTWVzc2FnZShcbiAgICB3aG86IENoYXRXaG8sXG4gICAgdGV4dDogc3RyaW5nLFxuICAgIGV4dHJhOiB7IHNlbGVjdGlvbj86IFNlbGVjdGlvbiB8IG51bGw7IGFjdGl2ZVBhdGg/OiBzdHJpbmcgfCBudWxsIH0gPSB7fSxcbiAgKTogQ2hhdE1lc3NhZ2Uge1xuICAgIGNvbnN0IG1zZzogQ2hhdE1lc3NhZ2UgPSB7IGlkOiBgbS0ke3JhbmRIZXgoNCl9YCwgd2hvLCB0ZXh0LCB0czogRGF0ZS5ub3coKSwgLi4uZXh0cmEgfTtcbiAgICB0aGlzLm0uY2hhdC5wdXNoKG1zZyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCB2aWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBkb2NWaWV3KGQ6IERvY1JlY29yZCk6IERvY1ZpZXcge1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIGVudHJ5SWQ6IGQuZW50cnlJZCxcbiAgICAgIHJlbDogZC5yZWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5tYXAoKHYpID0+ICh7IC4uLnYsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgdi5uKSB9KSksXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgZGlydHk6IHRoaXMuaXNEaXJ0eShkKSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBkLm91dHNpZGVDaGFuZ2VkLFxuICAgIH07XG4gIH1cblxuICBkb2Moc2x1Zzogc3RyaW5nKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHRoaXMuZG9jVmlldyh0aGlzLmRvY09yRGllKHNsdWcpKTtcbiAgfVxuXG4gIHZpZXcobW9kZTogXCJkZXZcIiB8IFwicmVsZWFzZVwiLCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwpOiBQdWJsaWNTdGF0ZSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIG1vZGUsXG4gICAgICBjb250ZXh0OiB0aGlzLm0uY29udGV4dCxcbiAgICAgIGRvY3M6IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gdGhpcy5kb2NWaWV3KGQpKSxcbiAgICAgIG9wZW5Eb2M6IHRoaXMubS5vcGVuRG9jLFxuICAgICAgc2VsZWN0aW9uLFxuICAgICAgY2hhdDogdGhpcy5tLmNoYXQsXG4gICAgfTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmNvbnN0IHRvUG9zaXggPSAocDogc3RyaW5nKSA9PiBwLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG5cbi8qKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4pOiB7IG5vZGVzOiBDb250ZXh0Tm9kZVtdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgY29uc3Qgd2FsayA9IChkaXI6IHN0cmluZyk6IENvbnRleHROb2RlW10gPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXBzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgY29uc3QgZG9jczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcy5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gY2FwKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKHJvb3QsIGFicykpO1xuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHdhbGsoYWJzKTtcbiAgICAgICAgLy8gQW4gZW1wdHkgZ3JvdXAgaXMgc3RpbGwgYSByZWFsIGRpcmVjdG9yeSwgYnV0IGEgbWlycm9yIG9mIGEgZG9jc1xuICAgICAgICAvLyBmb2xkZXIgaXMgbW9yZSB1c2VmdWwgd2l0aG91dCB0d2VudHkgZW1wdHkgYXNzZXQgZm9sZGVycyBpbiBpdC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDApIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG5leHBvcnQgY2xhc3MgUGF0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgY29kZTogXCJtaXNzaW5nXCIgfCBcIm5vdC1hLWRvY1wiLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG4vKipcbiAqIEFuIGVudHJ5IGZvciBhbiBhYnNvbHV0ZSBwYXRoLiBBIGRpcmVjdG9yeSBpcyBgbWlycm9yZWRgOyBhIGRvY3VtZW50IGZpbGUgaXNcbiAqIGBsaXN0ZWRgLCByb290ZWQgYXQgaXRzIHBhcmVudCwgaG9sZGluZyBvbmx5IGl0c2VsZiAoRTE1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudHJ5Rm9yUGF0aChhYnM6IHN0cmluZywgaWQ6IHN0cmluZyk6IENvbnRleHRFbnRyeSB7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHthYnN9YCwgXCJtaXNzaW5nXCIpO1xuICB9XG4gIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShhYnMpO1xuICAgIHJldHVybiB7XG4gICAgICBpZCxcbiAgICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpIHx8IGFicyxcbiAgICAgIHJvb3Q6IGFicyxcbiAgICAgIG1lbWJlcnNoaXA6IFwibWlycm9yZWRcIixcbiAgICAgIG5vZGVzLFxuICAgICAgLi4uKHRydW5jYXRlZCA/IHsgdHJ1bmNhdGVkIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzRG9jTmFtZShhYnMpKSB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihcbiAgICAgIGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2Fic31gLFxuICAgICAgXCJub3QtYS1kb2NcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbGFiZWw6IGJhc2VuYW1lKGFicyksXG4gICAgcm9vdDogZGlybmFtZShhYnMpLFxuICAgIG1lbWJlcnNoaXA6IFwibGlzdGVkXCIsXG4gICAgbm9kZXM6IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUoYWJzKSB9XSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGRvYyBub2RlJ3MgYWJzb2x1dGUgcGF0aCwgZGVwdGgtZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jUGF0aHMoZW50cnk6IENvbnRleHRFbnRyeSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKSA9PiB7XG4gICAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgICBpZiAobi5raW5kID09PSBcImRvY1wiKSBvdXQucHVzaChqb2luKGVudHJ5LnJvb3QsIG4ucmVsKSk7XG4gICAgICBlbHNlIHdhbGsobi5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuICB3YWxrKGVudHJ5Lm5vZGVzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoaWNoIGVudHJ5IChpZiBhbnkpIGhvbGRzIGBhYnNgLCBhbmQgYXQgd2hhdCBgcmVsYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhdGUoXG4gIGVudHJpZXM6IENvbnRleHRFbnRyeVtdLFxuICBhYnM6IHN0cmluZyxcbik6IHsgZW50cnlJZDogc3RyaW5nOyByZWw6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGRvY1BhdGhzKGUpLmluY2x1ZGVzKGFicykpIHJldHVybiB7IGVudHJ5SWQ6IGUuaWQsIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogT25lIGRpcmVjdG9yeSwgZm9yIHRoZSBzdXJmYWNlJ3MgYWRkLWJ5LXBhdGggY29tcGxldGlvbjogc3ViZGlyZWN0b3JpZXMgYW5kXG4gKiBkb2N1bWVudHMgb25seSwgZGlyZWN0b3JpZXMgZmlyc3QuIGB+YCBpcyBleHBhbmRlZCBieSB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdERpcihkaXI6IHN0cmluZyk6IEZzTGlzdEVudHJ5W10ge1xuICBjb25zdCBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gIGNvbnN0IG91dDogRnNMaXN0RW50cnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNEaXIgfHwgaXNEb2NOYW1lKG5hbWUpKSBvdXQucHVzaCh7IG5hbWUsIHBhdGg6IGFicywgZGlyOiBpc0RpciB9KTtcbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IChhLmRpciA9PT0gYi5kaXIgPyBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIDogYS5kaXIgPyAtMSA6IDEpKTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFxREEscUJBQXlCLHlCQUFVO0FBQ25DO0FBQ0Esb0JBQVMsd0JBQVMscUJBQVksa0JBQU07QUFDcEM7QUFDQSxzQkFBUzs7O0FDM0NUO0FBcUJPLFNBQVMsZUFBZSxDQUFDLFFBQWdCLE1BQW9CO0FBQUEsRUFDbEUsTUFBTSxNQUFNLEdBQUcsVUFBVSxRQUFRO0FBQUEsRUFDakMsSUFBSTtBQUFBLElBQ0YsY0FBYyxLQUFLLElBQUk7QUFBQSxJQUN2QixXQUFXLEtBQUssTUFBTTtBQUFBLElBQ3RCLE9BQU8sS0FBSztBQUFBLElBQ1osSUFBSTtBQUFBLE1BQ0YsT0FBTyxLQUFLLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFBQSxNQUMzQixNQUFNO0FBQUEsSUFH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U0FBUztBQUM1QjtBQUdBLGVBQXNCLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQzFELElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFFBQVEsY0FBYyxFQUFFLE1BQU0sTUFBTSxTQUFTLGdCQUFnQixRQUFRLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFJN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYixnQkFBZ0IsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxzQkFBMEIsT0FBTyxLQUN4RixjQUNGLEVBQ0csSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQ25CLEtBQUssR0FBRztBQUFBLENBQ2I7QUFBQSxJQUNBLE9BQU87QUFBQTtBQUFBLEVBRVQsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsSUFBSSxNQUFNLFlBQVk7QUFBQSxNQUNwQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsTUFDeEMsU0FBUyxNQUFNO0FBQUEsTUFDZixVQUFVLE1BQU0sVUFBVSxPQUFPLE1BQU0sT0FBTyxJQUFJO0FBQUEsSUFDcEQsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFFVixNQUFNLFNBQVMsYUFBYSxlQUFlLEVBQUUsU0FBUztBQUFBLElBQ3RELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsSUFBSSxPQUFPLFFBQVEsT0FBTyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxDQUM1RjtBQUFBLElBQ0EsT0FBTyxXQUFXLE1BQU0sSUFBSSxXQUFXLE1BQU0sSUFBSTtBQUFBO0FBQUEsRUFFbkQsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLG9CQUFvQixFQUFFLFFBQVEsTUFBTSxFQUFFLE1BQU0sWUFBWSxFQUFFLFdBQVcsTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLElBQUksQ0FBQztBQUFBLENBQzFIO0FBQUEsRUFDQSxNQUFNLE1BQU0sTUFBTSxFQUFFO0FBQUEsRUFDcEIsTUFBTSxFQUFFO0FBQUEsRUFFUixJQUFJLElBQUksU0FBUyxLQUFLLE1BQU0sS0FBSztBQUFBLElBQy9CLElBQUk7QUFBQSxNQUNGLElBQUksVUFBUyxNQUFNLEdBQUcsRUFBRSxTQUFTO0FBQUEsUUFBRyxZQUFXLE1BQU0sR0FBRztBQUFBLE1BQ3hELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxPQUFPLElBQUk7QUFBQTtBQVFiLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkE1QjZEOEMyNTJCQUI3QkY2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
