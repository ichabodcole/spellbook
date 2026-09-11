// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { readFileSync as readFileSync4, statSync as statSync3, unlinkSync as unlinkSync2, watch } from "fs";
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
    const open = this.m.openDoc ? this.m.docs.find((d) => d.slug === this.m.openDoc) : undefined;
    if (open && open.entryId === null)
      this.m.openDoc = null;
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
  const userHome = homedir();
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
        addPaths([msg.path]);
        return;
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

//# debugId=20A4EA680340A7BE64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3Nlc3Npb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdHJlZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgcGVyLXNlc3Npb24gZGFlbW9uIOKAlCB0aGUgcHJvY2VzcyB0aGUgc3VyZmFjZSB0YWxrcyB0byBvdmVyIGFcbiAqIFdlYlNvY2tldCBhbmQgdGhlIENMSSB0YWxrcyB0byBvdmVyIEhUVFAuIExhdW5jaGVkIGJ5XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL3NjcmlwdG9yaXVtL3NjcmlwdHMvc2VydmVyLnRzYCAodGhlIGxhdW5jaGVyKSwgd2hpY2hcbiAqIGltcG9ydHMgdGhlIEJVSUxUIGBkaXN0L3NlcnZlci5qc2AuXG4gKlxuICog4pSA4pSAIFRIRSBFSUdIVCBRVUVTVElPTlMgKHNjYWZmb2xkaW5nIHBsYXlib29rIE4xKSwgQU5TV0VSRUQgQVMgREVTSUdOIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIEFyaXRobWV0aWM6IGBTS0lMTF9ST09UYC9gRElTVF9ESVJgIG9ubHksIGZvciB0aGUga2l0J3MgYHJlc29sdmVNb2RlYCBhbmRcbiAqICAgIGBzZXJ2ZUZyb21EaXN0YCwgYW5kIHRydWUgYXQgdGhlIEVNSVRURUQgYWRkcmVzcyAoYGRpc3Qvc2VydmVyLmpzYCwgd2hvc2VcbiAqICAgIGAuLmAgaXMgdGhlIHNraWxsIGZvbGRlcikuIE5vdGhpbmcgZWxzZSBpcyBwaW5uZWQgb2ZmIGBpbXBvcnQubWV0YWAuXG4gKiAyLiBTZXJ2ZXM6IFlFUy4gYC9gIGlzIHRoZSBidWlsdCBgaW5kZXguaHRtbGAgdmlhIGBzZXJ2ZUZyb21EaXN0YCwgbm9cbiAqICAgIHN1YnN0aXR1dGlvbjsgdGhlIG9ubHkgcm91dGVzIG9mIGl0cyBvd24gYXJlIGAvc3RhdGVgLCBgL2NtZGAsIGAvZXZlbnRzYCxcbiAqICAgIGAvd3NgIGFuZCBgL2ZzLypgIChyZWFkLW9ubHk6IGEgdmVyc2lvbidzIHRleHQsIGEgZGlyZWN0b3J5IGxpc3RpbmcpLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgYGNsaS50c2A7IHRoZSB0d28gc2hhcmUgYC4vaGVhcnRiZWF0LnRzYC5cbiAqIDQuIExpZmVjeWNsZTogbG9uZy1ydW5uaW5nLCBvbmUgZGFlbW9uIHBlciBzZXNzaW9uLCBpZGxlLXRpbWVvdXQgbGlrZVxuICogICAgZ2xhbW91ciAobGluZ2VyIGFmdGVyIHRoZSBsYXN0IHN1YnNjcmliZXIgbGVhdmVzOyBleGl0IDEyNCkuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oCUIGBtYWluYCBhd2FpdHMgdGhlXG4gKiAgICBzZXNzaW9uJ3MgZW5kIGFuZCBpdHMgb3duIGRyYWluLCBleGFjdGx5IGFzIGdsYW1vdXIncyBzZXJ2ZXIgZG9lcywgc28gdGhlXG4gKiAgICBsYXVuY2hlciBpcyBURVJNSU5BTC1FWElUIChgcHJvY2Vzcy5leGl0KGF3YWl0IHJ1bigpKWApOiBvbmNlIGBtYWluYFxuICogICAgcmVzb2x2ZXMgbm90aGluZyBtYXkga2VlcCB0aGUgcHJvY2VzcyBhbGl2ZSwgYW5kIGEgd2F0Y2hlciBoYW5kbGUgb3IgYVxuICogICAgc3RyYWdnbGluZyBzb2NrZXQgd291bGQuIERyaXZlbiwgbm90IHJlYWQgKHNlZSB0aGUgc2xpY2UtQSBqb3VybmFsKS5cbiAqIDYuIEV2ZW50IGlkcyByZWNvdmVyZWQgYWNyb3NzIHJlc3RhcnQ/IE5PIOKAlCB0aGUgbG9nIGlzIGluIG1lbW9yeSBhbmQgaWRzXG4gKiAgICByZXN0YXJ0IGF0IDEsIGV2ZW4gdW5kZXIgYC0tcmVzdG9yZWAgKHdoaWNoIHJlc3RvcmVzIHRoZSBNQU5JRkVTVCwgbm90IHRoZVxuICogICAgbG9nKS4gU28gdGhlIGxvZyBpcyBzdGFtcGVkIHdpdGggYSBwZXItYm9vdCBFUE9DSCAobWluZC1tYXBwZXIncyBzaGFwZSlcbiAqICAgIGFuZCB0aGUgdGFpbCByZXNldHMgaXRzIGN1cnNvciB3aGVuIHRoZSBlcG9jaCBjaGFuZ2VzLlxuICogNy4gQSBraXQgc3ViamVjdCBpbiBhIGRpZmZlcmVudCBzaGFwZT8gTm8g4oCUIHRoZSBzaGFwZSB3YXMgY2hvc2VuIHRvIGJlIHRoZVxuICogICAga2l0J3MuXG4gKiA4LiBBIGtpdCBtb2R1bGUgbmFtZXMgdGhpcyBzcGVsbCBhcyBpdHMgc291cmNlPyBTdHJ1Y3R1cmFsbHkgTk86IHNjcmlwdG9yaXVtXG4gKiAgICBpcyB0aGUgZmlyc3Qgc3BlbGwgc2NhZmZvbGRlZCBhZnRlciB0aGUgY29udmVyZ2VuY2UuXG4gKlxuICog4pSA4pSAIEtJVCBWRVJESUNUUyAocGxheWJvb2sgTjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGVycm9ycyBTVUJKRUNUICh0aGUgQ0xJOyB0aGUgZGFlbW9uIGFuc3dlcnMgSFRUUCBzdGF0dXNlcyB0aGUgQ0xJIG1hcHMpIMK3XG4gKiBzZXJ2ZURpc3QgU1VCSkVDVCAoYHJlc29sdmVNb2RlYCwgYHNlcnZlRnJvbURpc3RgKSDCtyBob3VzZWtlZXBpbmcgU1VCSkVDVCwgYWxsXG4gKiB0aHJlZSBleHBvcnRzIChgc2hvdWxkSWRsZUNsb3NlYCB2aWEgYHN0YXJ0SG91c2VrZWVwaW5nYCdzIGlkbGUtY2xvc2UsIHRoZVxuICogc25hcHNob3Qgc3dlZXAg4oCUIGhlcmUgdGhlIG1hbmlmZXN0IGlzIHdyaXR0ZW4gb24gZXZlcnkgY2hhbmdlIGluc3RlYWQsIHNvIHRoZVxuICogc3dlZXAncyBzbmFwc2hvdCBob29rIGlzIGRlbGliZXJhdGVseSBOT1QgcGFzc2VkIOKAlCBhbmQgYGRyYWluQW5kU3RvcGApIMK3XG4gKiB0YWlsRXZlbnRzIFNVQkpFQ1QgKHRoZSBDTEkncyBgdGFpbGApIMK3IGhlYXJ0YmVhdCBTVUJKRUNUIChgLi9oZWFydGJlYXQudHNgKSDCt1xuICogZGlzY292ZXJ5IFNVQkpFQ1QgKHNlc3Npb24tSlNPTiwgRTEzOiBgc2NyaXB0b3JpdW0tPGlkPi5qc29uYCArXG4gKiBgc2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25gIGluIHRtcGRpciB2aWEgYHdyaXRlRmlsZUF0b21pY2AvYHVubGlua0lmTWF0Y2hlc2ApIMK3XG4gKiBldmVudExvZyBTVUJKRUNULCBXSVRIIEVQT0NIIChRNikgwrcgc3NlIFNVQkpFQ1QgKGBHRVQgL2V2ZW50c2ApIMK3XG4gKiBsaWIvcHJpbnRKc29uIFNVQkpFQ1QgKHRoZSBDTEkgc3BlYWtzIHRoZSBhZ2VudCB3aXJlKS5cbiAqXG4gKiDilIDilIAgVEVBUkRPV04gT1JERVIgKHJlZ2lzdGVyIEE2KSwgU1RBVEVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGdsYW1vdXIncyBvcmRlcjogc3RvcCBob3VzZWtlZXBpbmcg4oaSIGNsb3NlIHRoZSB3YXRjaGVycyDihpIgcGVyc2lzdCB0aGVcbiAqIG1hbmlmZXN0IOKGkiB1bmxpbmsgZGlzY292ZXJ5IOKGkiBlbWl0IGBjbG9zZWRgIOKGkiBkcmFpbi4gRGlzY292ZXJ5IGdvZXMgQkVGT1JFIHRoZVxuICogYGNsb3NlZGAgZnJhbWUgc28gYSB0YWlsIHRoYXQgc2VlcyBgY2xvc2VkYCBhbmQgYSBDTEkgdmVyYiB0aGF0IHJ1bnMgcmlnaHRcbiAqIGFmdGVyIGl0IGJvdGggZmluZCBubyBwb2ludGVyIHRvIGEgZGFlbW9uIHRoYXQgaXMgbGVhdmluZzsgdGhlIG90aGVyIG9yZGVyXG4gKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYSB2ZXJiIHJlc29sdmVzIGEgc2Vzc2lvbiB0aGF0IHdpbGwgcmVmdXNlIGl0LlxuICovXG5cbmltcG9ydCB7IHR5cGUgRlNXYXRjaGVyLCByZWFkRmlsZVN5bmMsIHN0YXRTeW5jLCB1bmxpbmtTeW5jLCB3YXRjaCB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgdW5saW5rSWZNYXRjaGVzLCB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudExvZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ldmVudExvZy50c1wiO1xuaW1wb3J0IHsgZHJhaW5BbmRTdG9wLCBzdGFydEhvdXNla2VlcGluZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlIGFzIHJlc29sdmVNb2RlSW4sIHNlcnZlRnJvbURpc3QgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc2VydmVEaXN0LnRzXCI7XG5pbXBvcnQgeyB0eXBlIFNzZUNsaWVudHMsIHNzZVJlc3BvbnNlIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NzZS50c1wiO1xuaW1wb3J0IHsgSURMRV9USU1FT1VUX1NFQywgU1NFX0hFQVJUQkVBVF9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHR5cGUgeyBBZ2VudENtZCwgQ2xpZW50TXNnLCBTZWxlY3Rpb24sIFNlcnZlck1zZyB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8qKiByZWxlYXNlIGlmZiBgZGlzdC9pbmRleC5odG1sYCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Q7IHRoZSBlbnYgdmFyIG92ZXJyaWRlcyAoQ29udHJhY3QgMSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYC4gYHByb21wdHMuanNvbmAgYmVzaWRlIGBzZXNzaW9ucy9gIGlzIHNsaWNlIEIncyAoRTkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHsgcG9ydD86IG51bWJlcjsgcmVzdG9yZT86IHN0cmluZzsgdGltZW91dFM/OiBudW1iZXIgfTtcblxuLyoqIEEgdGFpbCBmcmFtZSdzIHBheWxvYWQuIFRoZSBsb2cgc3RhbXBzIGBpZGAgYW5kIGBlcG9jaGAuICovXG50eXBlIExvZ0V2ZW50ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHR5cGU6IHN0cmluZyB9O1xuXG4vKiogSG93IGxvbmcgYSBidXJzdCBvZiB3YXRjaGVyIGV2ZW50cyBvbiBvbmUgcGF0aCBzZXR0bGVzIGJlZm9yZSBpdCBpcyByZWFkLiAqL1xuY29uc3QgV0FUQ0hfU0VUVExFX01TID0gNjA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydERhZW1vbihvcHRzOiBTdGFydE9wdHMpIHtcbiAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAvLyBNb2RlIEJFRk9SRSBhbnkgd3JpdGU6IGEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3RcbiAgLy8gZGllIGF0IHRoZSBpbXBvcnQgaGF2aW5nIGNyZWF0ZWQgbm90aGluZyAoZ2xhbW91cidzIG1lYXN1cmVkIG9yZGVyKS5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IG9wdHMucmVzdG9yZSA/IFNlc3Npb24ucmVzdG9yZShob21lLCBvcHRzLnJlc3RvcmUpIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIC0tLSBwcmVmczogcGVyLXZpZXdlciBjb252ZW5pZW5jZXMgdGhhdCBvdXRsaXZlIGEgc2Vzc2lvbidzIHBvcnQgLS0tLS0tLS0tLS0tXG4gIC8vIEJyb3dzZXIgc3RvcmFnZSBpcyBrZXllZCBieSBvcmlnaW4sIHBvcnQgaW5jbHVkZWQsIGFuZCBldmVyeSBzZXNzaW9uIGdldHMgYVxuICAvLyBuZXcgcG9ydCDigJQgc28gYSBwYW5lIHNpemUga2VwdCBpbiBsb2NhbFN0b3JhZ2UgcmVzZXRzIGF0IHRoZSBuZXh0IGBvcGVuYC5cbiAgLy8gVGhleSBsaXZlIGluIHRoZSBob21lIGluc3RlYWQsIHNoYXJlZCBieSBldmVyeSBzZXNzaW9uIG9mIHRoaXMgaG9tZS5cbiAgY29uc3QgcHJlZnNGaWxlID0gam9pbihob21lLCBcInByZWZzLmpzb25cIik7XG4gIGNvbnN0IFBSRUZfS0VZID0gL15bYS16XVthLXowLTk6Ll8tXXswLDYzfSQvO1xuICBjb25zdCBQUkVGX1ZBTFVFX01BWCA9IDQwOTY7XG4gIGNvbnN0IFBSRUZfS0VZU19NQVggPSA2NDtcbiAgLyoqXG4gICAqIFJlYWQgdGhlIGhvbWUncyBwcmVmcyBGUkVTSC4gU2V2ZXJhbCBzZXNzaW9ucyBjYW4gc2hhcmUgb25lIGhvbWUgKEUxMyksIGVhY2hcbiAgICogaXRzIG93biBkYWVtb24sIHNvIGEgY29weSBsb2FkZWQgb25jZSBhdCBib290IGFuZCB3cml0dGVuIGJhY2sgd2hvbGUgd291bGRcbiAgICogZXJhc2UgYSBrZXkgYW5vdGhlciBzZXNzaW9uIHdyb3RlIHNpbmNlICh2ZXJpZnkgcGFzcykuIEV2ZXJ5IHdyaXRlIGlzXG4gICAqIHRoZXJlZm9yZSByZWFkIOKGkiBzZXQgb25lIGtleSDihpIgd3JpdGUsIGFuZCBldmVyeSBzbmFwc2hvdCByZWFkcyB0aGUgZmlsZS5cbiAgICogT25seSB3ZWxsLWZvcm1lZCBlbnRyaWVzIHN1cnZpdmUgYSByZWFkOyBhIGJhZCBmaWxlIHJlYWRzIGFzIGVtcHR5IGFuZCBpc1xuICAgKiByZXBsYWNlZCBieSB0aGUgbmV4dCB3cml0ZS5cbiAgICovXG4gIGNvbnN0IHJlYWRQcmVmcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocHJlZnNGaWxlLCBcInV0ZjhcIikpIGFzIHVua25vd247XG4gICAgICBpZiAocmF3ICYmIHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhyYXcpKVxuICAgICAgICAgIGlmIChQUkVGX0tFWS50ZXN0KGspICYmIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYubGVuZ3RoIDw9IFBSRUZfVkFMVUVfTUFYKSBvdXRba10gPSB2O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gcHJlZnMgeWV0LCBvciB1bnJlYWRhYmxlIOKAlCBlbXB0eSAqL1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9O1xuICBjb25zdCB1c2VySG9tZSA9IGhvbWVkaXIoKTtcbiAgY29uc3Qgdmlld1N0YXRlID0gKCkgPT4gKHsgLi4uc2Vzc2lvbi52aWV3KG1vZGUsIHNlbGVjdGlvbiksIHByZWZzOiByZWFkUHJlZnMoKSwgdXNlckhvbWUgfSk7XG5cbiAgLy8gLS0tIGNoYW5uZWxzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzb2NrZXRzID0gbmV3IFNldDxpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+PigpO1xuICBjb25zdCBsb2cgPSBjcmVhdGVFdmVudExvZzxMb2dFdmVudD4oeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9KTtcbiAgY29uc3Qgc3NlQ2xpZW50czogU3NlQ2xpZW50cyA9IG5ldyBTZXQoKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBzZW5kID0gKG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgY29uc3QgcyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gICAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5zZW5kKHMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNvY2tldCBjbG9zZWQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIGNvbnN0IGJyb2FkY2FzdFN0YXRlID0gKCkgPT4gc2VuZCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pO1xuXG4gIC8qKiBBIHN5c3RlbSBsaW5lIGluIHRoZSBjaGF0IOKAlCBhbmQsIGJlY2F1c2UgdGhlIGFnZW50IG11c3Qga25vdyBpdCB0b28sIG9uIHRoZSB0YWlsLiAqL1xuICBjb25zdCBhbm5vdW5jZSA9ICh0ZXh0OiBzdHJpbmcsIGZhY3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pID0+IHtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIHRleHQpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJzeXN0ZW1cIiwgdGV4dCwgdHM6IG0udHMsIC4uLmZhY3QgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgfTtcblxuICAvLyAtLS0gdGhlIHdhdGNoZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy9cbiAgLy8g4pqgIERFVklBVElPTiBGUk9NIFRIRSBCUklFRiwgV0lUSCBJVFMgUkVBU09OOiBgbm9kZTpmc2AgYHdhdGNoYCAoQnVuJ3NcbiAgLy8gYnVpbHQtaW4pLCBOT1QgYEBwYXJjZWwvd2F0Y2hlcmAuIGBAcGFyY2VsL3dhdGNoZXJgIGlzIGEgbmF0aXZlIGFkZG9uIHdob3NlXG4gIC8vIGxvYWRlciBkb2VzIGEgcnVudGltZSBgcmVxdWlyZSgpYCBvZiBhIHBlci1wbGF0Zm9ybSBwYWNrYWdlOyBidW5kbGVkIGludG9cbiAgLy8gYGRpc3Qvc2VydmVyLmpzYCBpdCBpcyBub3QgaW5saW5lZCwgc28gdGhlIHNoaXBwZWQgZGFlbW9uIHdvdWxkIG5lZWQgYVxuICAvLyBgbm9kZV9tb2R1bGVzYCB0aGUgbWFya2V0cGxhY2UgbmV2ZXIgY29waWVzIChpbXBvcnQtYm91bmRhcnkgd2FyZCAxYidzXG4gIC8vIFwidGhlIHNoaXBwZWQgZXhlY3V0aW9uIHBhdGggY2FycmllcyBubyBkZXBlbmRlbmNpZXNcIikuIE1lYXN1cmVkIHVuZGVyIEJ1blxuICAvLyAxLjQuMCBvbiBtYWNPUyBiZWZvcmUgY2hvb3Npbmc6IGEgcmVjdXJzaXZlIGRpcmVjdG9yeSB3YXRjaCByZXBvcnRzIGFuXG4gIC8vIGluLXBsYWNlIHdyaXRlLCBhbiBhdG9taWMgdG1wK3JlbmFtZSBzYXZlLCBhbmQgYm90aCBhZ2FpbiBpbiBhXG4gIC8vIHN1YmRpcmVjdG9yeSDigJQgdGhlIGZvdXIgY2FzZXMgaW52ZXN0aWdhdGlvbiDCpzUgZHJvdmUgQHBhcmNlbC93YXRjaGVyIG9uLlxuICAvLyBUaGUgaGFzaC1jb21wYXJlIGFuZCBzZWxmLXdyaXRlIHN1cHByZXNzaW9uIGFyZSB1bmNoYW5nZWQgKHNlc3Npb24udHMpLlxuICBjb25zdCB3YXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGU1dhdGNoZXI+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4+KCk7XG4gIGNvbnN0IG9uRnMgPSAoYWJzOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB0ID0gcGVuZGluZy5nZXQoYWJzKTtcbiAgICBpZiAodCkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHBlbmRpbmcuc2V0KFxuICAgICAgYWJzLFxuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHBlbmRpbmcuZGVsZXRlKGFicyk7XG4gICAgICAgIGxldCBldjogRmlsZUV2ZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZXYgPSBzZXNzaW9uLm9uRmlsZUV2ZW50KGFicyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IHdhdGNoZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXYpIGhhbmRsZUZpbGVFdmVudChldik7XG4gICAgICB9LCBXQVRDSF9TRVRUTEVfTVMpLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IHN5bmNXYXRjaGVycyA9ICgpID0+IHtcbiAgICBjb25zdCB3YW50ID0gbmV3IE1hcChcbiAgICAgIHNlc3Npb24ud2F0Y2hSb290cygpLm1hcCgocikgPT4gW2Ake3IucmVjdXJzaXZlID8gXCJSXCIgOiBcIkZcIn06JHtyLndhdGNofT4ke3IucGF0aH1gLCByXSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHddIG9mIHdhdGNoZXJzKVxuICAgICAgaWYgKCF3YW50LmhhcyhrZXkpKSB7XG4gICAgICAgIHcuY2xvc2UoKTtcbiAgICAgICAgd2F0Y2hlcnMuZGVsZXRlKGtleSk7XG4gICAgICB9XG4gICAgZm9yIChjb25zdCBba2V5LCByXSBvZiB3YW50KSB7XG4gICAgICBpZiAod2F0Y2hlcnMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gV2F0Y2hlZCBhdCB0aGUgUkVBTFBBVEgsIHJlcG9ydGVkIHVuZGVyIHRoZSBzdG9yZWQgcGF0aCBmb3JtXG4gICAgICAgIC8vICh2ZXJpZnktcGFzcyBmaXggMyDigJQgc2VlIFNlc3Npb24ud2F0Y2hSb290cykuXG4gICAgICAgIGNvbnN0IHcgPSB3YXRjaChyLndhdGNoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gVGhlXG4gICAgICAgIC8vIG91dHNpZGUgdGV4dCBpcyBLRVBUIGFzIGEgbmV3IGFnZW50IHZlcnNpb24gYW5kIHRoZSBhY3RpdmUgdmVyc2lvblxuICAgICAgICAvLyBrZWVwcyB0aGUgaHVtYW4ncyB0ZXh0IOKAlCBub3RoaW5nIGlzIGxvc3QsIGFuZCB0aGUgaHVtYW4ncyBidWZmZXIgaXNcbiAgICAgICAgLy8gbm90IHRvdWNoZWQgKHZlcmlmeS1wYXNzIGZpeCA0KS5cbiAgICAgICAgYW5ub3VuY2VPdXRzaWRlKGV2LmRvYywgZXYudmVyc2lvbiwgZXYucGF0aCwgZXYucHJlc2VydmVkQXMsIGV2LnByZXNlcnZlZFBhdGgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYW5ub3VuY2VPdXRzaWRlID0gKFxuICAgIGRvYzogc3RyaW5nLFxuICAgIHZlcnNpb246IG51bWJlcixcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgcHJlc2VydmVkQXM6IG51bWJlcixcbiAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmcsXG4gICkgPT5cbiAgICBhbm5vdW5jZShcbiAgICAgIGB2JHt2ZXJzaW9ufSBvZiAke2RvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgdiR7cHJlc2VydmVkQXN9OyB0aGUgYWN0aXZlIHZlcnNpb24ga2VlcHMgeW91ciB0ZXh0LiBBZ2VudCBlZGl0cyBiZWxvbmcgaW4gYSBuZXcgdmVyc2lvbiAodmVyc2lvbi1uZXcpLmAsXG4gICAgICB7IGZhY3Q6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jLCB2ZXJzaW9uLCBwYXRoLCBwcmVzZXJ2ZWRBcywgcHJlc2VydmVkUGF0aCB9LFxuICAgICk7XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwib3BlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm9wZW5QYXRoKG1zZy5wYXRoKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIC8vIFRoZSBvcGVuZXIgZ2V0cyB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IHN0cmFpZ2h0IGF3YXkg4oCUIHRoZSBzdGF0ZVxuICAgICAgICAvLyBzbmFwc2hvdCBjYXJyaWVzIG5vIHRleHRzLCBhbmQgYSB2aWV3ZXIgbXVzdCBub3Qgd2FpdCBvbiBhIHNlY29uZCBhc2suXG4gICAgICAgIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2Moci5zbHVnKTtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICAgIGRvYzogci5zbHVnLFxuICAgICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgZC5hY3RpdmUpLnRleHQsXG4gICAgICAgICAgICBvcmlnaW46IFwibG9hZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyLmNyZWF0ZWQpXG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvYy5vcGVuZWRcIiwgZG9jOiByLnNsdWcsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChyLnNsdWcpIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwib3Blbi5kb2NcIjpcbiAgICAgICAgc2Vzc2lvbi5vcGVuU2x1Zyhtc2cuZG9jKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0KG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBtc2cudGV4dCk7XG4gICAgICAgIGlmIChyLnByZXNlcnZlZCkge1xuICAgICAgICAgIGNvbnN0IGQgPSBzZXNzaW9uLmRvYyhtc2cuZG9jKTtcbiAgICAgICAgICBhbm5vdW5jZU91dHNpZGUoXG4gICAgICAgICAgICBkLnNsdWcsXG4gICAgICAgICAgICBtc2cudmVyc2lvbixcbiAgICAgICAgICAgIHNlc3Npb24uYWN0aXZlUGF0aChkLnNsdWcpID8/IFwiXCIsXG4gICAgICAgICAgICByLnByZXNlcnZlZC5uLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQucGF0aCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHIuZGlydHlDaGFuZ2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwic2VsZWN0XCI6XG4gICAgICAgIC8vIEFNQklFTlQgc3RhdGU6IHN0b3JlZCBhbmQgc2hvd24sIG5ldmVyIHB1c2hlZCBvbnRvIHRoZSBhZ2VudCdzIHRhaWwuXG4gICAgICAgIHNlbGVjdGlvbiA9IG1zZy5zZWxlY3Rpb247XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCB0ZXh0ID0gbXNnLnRleHQudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2VsID0gbXNnLndpdGhTZWxlY3Rpb24gPyBzZWxlY3Rpb24gOiBudWxsO1xuICAgICAgICBjb25zdCBhY3RpdmVQYXRoID0gc2VsID8gc2Vzc2lvbi5hY3RpdmVQYXRoKHNlbC5kb2MpIDogc2Vzc2lvbi5hY3RpdmVQYXRoKCk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJodW1hblwiLCB0ZXh0LCB7IHNlbGVjdGlvbjogc2VsLCBhY3RpdmVQYXRoIH0pO1xuICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgbWVzc2FnZV9pZDogbS5pZCxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIHNlbGVjdGlvbjogc2VsLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2Yoc2VsPy5kb2MpLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIGFjdGl2YXRlKG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBcImh1bWFuXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwic2F2ZVwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnNhdmUobXNnLmRvYyk7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgYFNhdmVkIHYke3IudmVyc2lvbn0gdG8gJHtyLm9yaWdpbmFsfS5gKTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwic2F2ZWRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIG9yaWdpbmFsOiByLm9yaWdpbmFsLFxuICAgICAgICAgIHRzOiBtLnRzLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJldmVydFwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJldmVydChtc2cuZG9jKTtcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IG1zZy5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogci52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IHIudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgICAgIFwic3lzdGVtXCIsXG4gICAgICAgICAgYFJldmVydGVkIHYke3IudmVyc2lvbn0gb2YgJHttc2cuZG9jfSB0byB0aGUgc2F2ZWQgZmlsZS5gLFxuICAgICAgICApO1xuICAgICAgICBsb2cuZW1pdCh7IHR5cGU6IFwicmV2ZXJ0ZWRcIiwgZG9jOiBtc2cuZG9jLCB2ZXJzaW9uOiByLnZlcnNpb24sIHRzOiBtLnRzIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjpcbiAgICAgICAgYWRkUGF0aHMoW21zZy5wYXRoXSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJlZnMuc2V0XCI6IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFQUkVGX0tFWS50ZXN0KG1zZy5rZXkpIHx8XG4gICAgICAgICAgdHlwZW9mIG1zZy52YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgIG1zZy52YWx1ZS5sZW5ndGggPiBQUkVGX1ZBTFVFX01BWFxuICAgICAgICApXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX1gKTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHJlYWRQcmVmcygpO1xuICAgICAgICBpZiAoY3VycmVudFttc2cua2V5XSA9PT0gbXNnLnZhbHVlKSByZXR1cm47XG4gICAgICAgIGlmICghKG1zZy5rZXkgaW4gY3VycmVudCkgJiYgT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoID49IFBSRUZfS0VZU19NQVgpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfTogJHtQUkVGX0tFWVNfTUFYfSBrZXlzIGFscmVhZHkga2VwdGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgd3JpdGVGaWxlQXRvbWljKFxuICAgICAgICAgIHByZWZzRmlsZSxcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IC4uLmN1cnJlbnQsIFttc2cua2V5XTogbXNnLnZhbHVlIH0sIG51bGwsIDIpfVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGFjdGl2ZU9mID0gKGRvYz86IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHNsdWcgPSBkb2MgPz8gc2Vzc2lvbi5vcGVuRG9jU2x1ZztcbiAgICBpZiAoIXNsdWcpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gc2Vzc2lvbi5kb2Moc2x1Zyk7XG4gICAgICByZXR1cm4geyBkb2M6IHYuc2x1ZywgdmVyc2lvbjogdi5hY3RpdmUsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aCh2LnNsdWcpIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIGFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgbGV0IHJlc29sdmVEb25lITogKHY6IHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9KSA9PiB2b2lkO1xuICBjb25zdCBkb25lID0gbmV3IFByb21pc2U8eyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0+KChyKSA9PiB7XG4gICAgcmVzb2x2ZURvbmUgPSByO1xuICB9KTtcblxuICBjb25zdCBoYW5kbGVBZ2VudENtZCA9IChjbWQ6IEFnZW50Q21kKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIHN3aXRjaCAoY21kLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJjb250ZXh0LmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGFkZGVkID0gYWRkUGF0aHMoY21kLnBhdGhzKTtcbiAgICAgICAgcmV0dXJuIHsgZW50cmllczogYWRkZWQubWFwKChhKSA9PiAoeyAuLi5hLmVudHJ5LCBhZGRlZDogYS5hZGRlZCB9KSkgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLm5ld1wiOiB7XG4gICAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggNzogdGhlIGFnZW50IG1heSBuYW1lIGEgZG9jIHRoZSBodW1hbiBoYXMgbm90XG4gICAgICAgIC8vIG9wZW5lZCwgYnkgQUJTT0xVVEUgcGF0aCAodGhlIENMSSByZXNvbHZlcyBpdCBhZ2FpbnN0IGl0cyBvd24gY3dkKTtcbiAgICAgICAgLy8gaXQgaXMgb3BlbmVkIGltcGxpY2l0bHkgdW5kZXIgdGhlIHNhbWUgYWRtaXNzaW9uIHJ1bGUgYXMgdGhlXG4gICAgICAgIC8vIHN1cmZhY2UncyBgb3BlbmAg4oCUIGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5IOKAlCB3aXRob3V0XG4gICAgICAgIC8vIG1vdmluZyB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgICAgICBpZiAoY21kLmRvYyAmJiBpc0Fic29sdXRlKGNtZC5kb2MpICYmICFzZXNzaW9uLmZpbmREb2MoY21kLmRvYykpIHtcbiAgICAgICAgICBjb25zdCBvID0gc2Vzc2lvbi5vcGVuUGF0aChjbWQuZG9jLCB7IGZvY3VzOiBmYWxzZSB9KTtcbiAgICAgICAgICBpZiAoby5jcmVhdGVkKVxuICAgICAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgICAgICB0eXBlOiBcImRvYy5vcGVuZWRcIixcbiAgICAgICAgICAgICAgZG9jOiBvLnNsdWcsXG4gICAgICAgICAgICAgIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChvLnNsdWcpLFxuICAgICAgICAgICAgICBieTogXCJhZ2VudFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24ubmV3VmVyc2lvbih7XG4gICAgICAgICAgZG9jOiBjbWQuZG9jLFxuICAgICAgICAgIGZyb206IGNtZC5mcm9tLFxuICAgICAgICAgIGxhYmVsOiBjbWQubGFiZWwsXG4gICAgICAgICAgYXV0aG9yOiBcImFnZW50XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgQWdlbnQgY3JlYXRlZCB2JHtyLnZlcnNpb24ubn0gb2YgJHtyLnNsdWd9IGZyb20gdiR7ci52ZXJzaW9uLmZyb219JHtjbWQubGFiZWwgPyBgIOKAlCAke2NtZC5sYWJlbH1gIDogXCJcIn0uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4sIGZyb206IHIudmVyc2lvbi5mcm9tLCBwYXRoOiByLnZlcnNpb24ucGF0aCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInNheVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJhZ2VudFwiLCBjbWQudGV4dCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybiB7IGlkOiBtLmlkIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwiYWN0aXZhdGVcIjpcbiAgICAgICAgcmV0dXJuIGFjdGl2YXRlKGNtZC5kb2MsIGNtZC52ZXJzaW9uLCBcImFnZW50XCIpO1xuICAgICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICAgIHJldHVybiB7fTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgICAgYHVucmVjb2duaXNlZCBjb21tYW5kIHR5cGUgJHtKU09OLnN0cmluZ2lmeSgoY21kIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSl9IOKAlCBub3RoaW5nIHdhcyBhcHBsaWVkYCxcbiAgICAgICAgICA0MDAsXG4gICAgICAgICAgW1wiY29udGV4dC5hZGRcIiwgXCJ2ZXJzaW9uLm5ld1wiLCBcInNheVwiLCBcImFjdGl2YXRlXCIsIFwiY2xvc2VcIl0sXG4gICAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlZnVzYWwgPSAoZTogdW5rbm93bik6IFJlc3BvbnNlID0+IHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFNlc3Npb25FcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKFxuICAgICAgICB7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSwgLi4uKGUuY2hvaWNlcyA/IHsgY2hvaWNlczogZS5jaG9pY2VzIH0gOiB7fSkgfSxcbiAgICAgICAgeyBzdGF0dXM6IGUuc3RhdHVzIH0sXG4gICAgICApO1xuICAgIGlmIChlIGluc3RhbmNlb2YgUGF0aEVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlKSB9LCB7IHN0YXR1czogNTAwIH0pO1xuICB9O1xuXG4gIGNvbnN0IGV2ZW50c1Jlc3BvbnNlID0gKHJlcTogUmVxdWVzdCwgdXJsOiBVUkwpOiBSZXNwb25zZSA9PiB7XG4gICAgdG91Y2goKTtcbiAgICByZXR1cm4gc3NlUmVzcG9uc2Uoe1xuICAgICAgbG9nLFxuICAgICAgc2luY2U6IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiLTFcIiwgMTApLFxuICAgICAgaGVhcnRiZWF0TXM6IFNTRV9IRUFSVEJFQVRfTVMsXG4gICAgICBjbGllbnRzOiBzc2VDbGllbnRzLFxuICAgICAgc2lnbmFsOiByZXEuc2lnbmFsLFxuICAgICAgb25PcGVuOiB0b3VjaCxcbiAgICAgIG9uQ2xvc2U6IHRvdWNoLFxuICAgIH0pO1xuICB9O1xuXG4gIC8vIC0tLSBzZXJ2ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNlcnZlciA9IEJ1bi5zZXJ2ZSh7XG4gICAgcG9ydDogb3B0cy5wb3J0ID8/IDAsXG4gICAgaG9zdG5hbWU6IFwiMTI3LjAuMC4xXCIsXG4gICAgcm91dGVzLFxuICAgIGlkbGVUaW1lb3V0OiBJRExFX1RJTUVPVVRfU0VDLFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWEg4oCUIEEgRk9SRUlHTiBPUklHSU4gSVMgUkVGVVNFRC4gQW55IHdlYiBwYWdlIHRoZVxuICAgICAgLy8gaHVtYW4gdmlzaXRzIGNhbiBvcGVuIGEgV2ViU29ja2V0IG9yIFBPU1QgdG8gMTI3LjAuMC4xOyB0aGUgYnJvd3NlclxuICAgICAgLy8gc2VuZHMgaXRzIE9yaWdpbiwgYW5kIG9ubHkgdGhpcyBkYWVtb24ncyBvd24gcGFnZSBtYXkgZHJpdmUgaXQuIFRoZVxuICAgICAgLy8gQ0xJJ3MgZmV0Y2ggc2VuZHMgbm8gT3JpZ2luIGF0IGFsbCwgc28gaXQgaXMgdW5hZmZlY3RlZC5cbiAgICAgIGlmIChcbiAgICAgICAgKHBhdGggPT09IFwiL3dzXCIgfHwgcGF0aCA9PT0gXCIvY21kXCIgfHwgcGF0aC5zdGFydHNXaXRoKFwiL2ZzL1wiKSkgJiZcbiAgICAgICAgIXNhbWVPcmlnaW4ocmVxLCBzcnYucG9ydClcbiAgICAgIClcbiAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBcImZvcmVpZ24gb3JpZ2luIHJlZnVzZWRcIiB9LCB7IHN0YXR1czogNDAzIH0pO1xuICAgICAgaWYgKHBhdGggPT09IFwiL3dzXCIpXG4gICAgICAgIHJldHVybiBzcnYudXBncmFkZShyZXEpID8gdW5kZWZpbmVkIDogbmV3IFJlc3BvbnNlKFwidXBncmFkZSByZXF1aXJlZFwiLCB7IHN0YXR1czogNDI2IH0pO1xuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvc3RhdGVcIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICBjb25zdCBzdGF0ZSA9IHZpZXdTdGF0ZSgpO1xuICAgICAgICBjb25zdCBmdWxsID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJmdWxsXCIpID09PSBcIjFcIjtcbiAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgIC4uLnN0YXRlLFxuICAgICAgICAgIGNoYXQ6IGZ1bGwgPyBzdGF0ZS5jaGF0IDogc3RhdGUuY2hhdC5zbGljZSgtMTApLFxuICAgICAgICAgIGNoYXRUb3RhbDogc3RhdGUuY2hhdC5sZW5ndGgsXG4gICAgICAgICAgYWN0aXZlOiBhY3RpdmVPZigpLFxuICAgICAgICAgIGN1cnNvcjogbG9nLmN1cnNvcigpLFxuICAgICAgICAgIGVwb2NoOiBsb2cuZXBvY2gsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZXZlbnRzXCIpIHJldHVybiBldmVudHNSZXNwb25zZShyZXEsIHVybCk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9mcy92ZXJzaW9uXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZWFkVmVyc2lvbihcbiAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZG9jXCIpID8/IFwiXCIsXG4gICAgICAgICAgICBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJ2XCIpID8/IFwiXCIsIDEwKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHIpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIHJlZnVzYWwoZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL2xpc3RcIikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAgIGVudHJpZXM6IGxpc3REaXIoZXhwYW5kSG9tZSh1cmwuc2VhcmNoUGFyYW1zLmdldChcInBhdGhcIikgPz8gXCJ+XCIpKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvY21kXCIpXG4gICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgLnRoZW4oKGIpID0+IHtcbiAgICAgICAgICAgIHRvdWNoKCk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlLCAuLi5oYW5kbGVBZ2VudENtZChiIGFzIEFnZW50Q21kKSB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzYWwoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goKCkgPT4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICBjb25zdCBhc3NldCA9IHNlcnZlRGlzdChwYXRoKTtcbiAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gYXNzZXQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgfSxcbiAgICB3ZWJzb2NrZXQ6IHtcbiAgICAgIG9wZW4od3MpIHtcbiAgICAgICAgc29ja2V0cy5hZGQod3MpO1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSkpO1xuICAgICAgfSxcbiAgICAgIG1lc3NhZ2Uod3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICBsZXQgbXNnOiBDbGllbnRNc2c7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbXNnID0gSlNPTi5wYXJzZShcbiAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICApIGFzIENsaWVudE1zZztcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogYmFkIGpzb24gZnJvbSBicm93c2VyOiAke2V9XFxuYCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaGFuZGxlQ2xpZW50TXNnKHdzLCBtc2cpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gQSByZWZ1c2FsIHRoZSBodW1hbiBjYXVzZWQgKGVkaXQgYSBub24tYWN0aXZlIHZlcnNpb24sIG9wZW4gYVxuICAgICAgICAgIC8vIHZhbmlzaGVkIGZpbGUpIHJlYWNoZXMgVEhFTSwgYXMgYSBjaGF0LXZpc2libGUgc3lzdGVtIGxpbmUgd291bGQgYmVcbiAgICAgICAgICAvLyB0b28gbG91ZCBmb3IgYSBrZXlzdHJva2Ug4oCUIHNvIGl0IGlzIGFuIGVycm9yIGZyYW1lIHRoZSBzdXJmYWNlIHNob3dzLlxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgY2xvc2Uod3MpIHtcbiAgICAgICAgc29ja2V0cy5kZWxldGUod3MpO1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBib3VuZFBvcnQgPSBzZXJ2ZXIucG9ydDtcbiAgLy8gLS0tIGRpc2NvdmVyeSAoRTEzOiBzZXNzaW9uLUpTT04sIHRoZSBvbmx5IGNvbnZlbnRpb24gdGhhdCBjYW4gZXhwcmVzcyBzZXZlcmFsKSAtLVxuICBjb25zdCBzZXNzaW9uRmlsZSA9IGpvaW4odG1wZGlyKCksIGBzY3JpcHRvcml1bS0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7Ym91bmRQb3J0fWAsXG4gICAgcG9ydDogYm91bmRQb3J0LFxuICAgIHNlc3Npb25faWQ6IHNlc3Npb25JZCxcbiAgICBob21lLFxuICAgIGRpcjogc2Vzc2lvbi5kaXIsXG4gICAgbW9kZSxcbiAgfSk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlQXRvbWljKHNlc3Npb25GaWxlLCBpbmZvKTtcbiAgICB3cml0ZUZpbGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgc3luY1dhdGNoZXJzKCk7XG4gIGxvZy5lbWl0KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlLCBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsIHJlc3RvcmVkOiAhIW9wdHMucmVzdG9yZSB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDI6IHdoYXQgY2hhbmdlZCBvbiBkaXNrIHdoaWxlIG5vIGRhZW1vbiB3YXMgd2F0Y2hpbmcuXG4gIGZvciAoY29uc3QgZiBvZiBzZXNzaW9uLnJlc3RvcmVGaW5kaW5ncylcbiAgICBhbm5vdW5jZShcbiAgICAgIGYubWlzc2luZ1xuICAgICAgICA/IGAke2Yub3JpZ2luYWx9IGlzIGdvbmUgZnJvbSBkaXNrIHNpbmNlIHRoaXMgc2Vzc2lvbiB3YXMgbGFzdCBvcGVuLiBTYXZlIHdvdWxkIHJlY3JlYXRlIGl0OyBSZXZlcnQgY2Fubm90IHJ1bi5gXG4gICAgICAgIDogYCR7Zi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHRoaXMgc2Vzc2lvbiB3YXMgY2xvc2VkLiBTYXZlIG92ZXJ3cml0ZXMgaXQgd2l0aCB0aGUgYWN0aXZlIHZlcnNpb247IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgIHsgZmFjdDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGYuZG9jLCB3aGlsZUNsb3NlZDogdHJ1ZSB9LFxuICAgICk7XG5cbiAgY29uc3Qgc3RvcEhvdXNla2VlcGluZyA9IHN0YXJ0SG91c2VrZWVwaW5nKHtcbiAgICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IHNvY2tldHMuc2l6ZSArIHNzZUNsaWVudHMuc2l6ZSxcbiAgICBpZGxlTXM6ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC0gbGFzdEFjdGl2aXR5LFxuICAgIHRvdWNoLFxuICAgIHRpbWVvdXRNczogKG9wdHMudGltZW91dFMgPz8gMTgwMCkgKiAxMDAwLFxuICAgIG9uSWRsZUNsb3NlOiAoKSA9PiByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgcmVhc29uOiBcInRpbWVvdXRcIiB9KSxcbiAgfSk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICBsZXQgcmVzb2x2ZVNodXRkb3duITogKCkgPT4gdm9pZDtcbiAgY29uc3Qgc2h1dGRvd24gPSBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4ge1xuICAgIHJlc29sdmVTaHV0ZG93biA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGNsZWFudXBEaXNjb3ZlcnkgPSAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogZ29uZSDigJQgZmluZSAqL1xuICAgIH1cbiAgICB1bmxpbmtJZk1hdGNoZXMobGF0ZXN0RmlsZSwgc2Vzc2lvbklkLCAocmF3KSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpZCA9IChKU09OLnBhcnNlKHJhdykgYXMgeyBzZXNzaW9uX2lkPzogdW5rbm93biB9KS5zZXNzaW9uX2lkO1xuICAgICAgICByZXR1cm4gdHlwZW9mIGlkID09PSBcInN0cmluZ1wiID8gaWQgOiBudWxsO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuXG4gIC8vIFRoZSBvcmRlciBpcyB0aGUgaGVhZGVyJ3MsIGFuZCB0aGUgaGVhZGVyIHNheXMgd2h5LlxuICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBzdG9wSG91c2VrZWVwaW5nKCk7XG4gICAgZm9yIChjb25zdCB3IG9mIHdhdGNoZXJzLnZhbHVlcygpKSB3LmNsb3NlKCk7XG4gICAgd2F0Y2hlcnMuY2xlYXIoKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgcGVuZGluZy52YWx1ZXMoKSkgY2xlYXJUaW1lb3V0KHQpO1xuICAgIHRyeSB7XG4gICAgICBzZXNzaW9uLnBlcnNpc3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgfVxuICAgIGNsZWFudXBEaXNjb3ZlcnkoKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiY2xvc2VkXCIgfSk7XG4gICAgdm9pZCBkcmFpbkFuZFN0b3AoeyBzZXJ2ZXIsIGNsaWVudHM6IHNzZUNsaWVudHMsIHNvY2tldHMgfSkudGhlbihyZXNvbHZlU2h1dGRvd24pO1xuICB9O1xuICBkb25lLnRoZW4oKCkgPT4gY2xvc2UoKSk7XG5cbiAgcmV0dXJuIHsgcG9ydDogYm91bmRQb3J0LCBzZXNzaW9uSWQsIG1vZGUsIGRpcjogc2Vzc2lvbi5kaXIsIGNsb3NlLCBkb25lLCBzaHV0ZG93biB9O1xufVxuXG4vKiogQW4gYWJzZW50IE9yaWdpbiAodGhlIENMSSwgY3VybCkgb3IgdGhpcyBkYWVtb24ncyBvd24gcGFnZTsgbm90aGluZyBlbHNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhbWVPcmlnaW4ocmVxOiBSZXF1ZXN0LCBwb3J0OiBudW1iZXIgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgY29uc3Qgb3JpZ2luID0gcmVxLmhlYWRlcnMuZ2V0KFwib3JpZ2luXCIpO1xuICBpZiAob3JpZ2luID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIG9yaWdpbiA9PT0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWAgfHwgb3JpZ2luID09PSBgaHR0cDovL2xvY2FsaG9zdDoke3BvcnR9YDtcbn1cblxuZnVuY3Rpb24gZXhwYW5kSG9tZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAocCA9PT0gXCJ+XCIpIHJldHVybiBob21lZGlyKCk7XG4gIGlmIChwLnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCBwLnNsaWNlKDIpKTtcbiAgcmV0dXJuIHJlc29sdmUocCk7XG59XG5cbi8qKiBUaGUgZGFlbW9uJ3MgcHJpdmF0ZSBhcmd2IOKAlCB0aGUgQ0xJIHNwYXducyBpdCB3aXRoIGV4YWN0bHkgdGhlc2UuICovXG5jb25zdCBEQUVNT05fT1BUSU9OUyA9IHtcbiAgbG9nOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBQYXJzZSB0aGUgZGFlbW9uJ3MgYXJndiwgYm9vdCwgcHJpbnQgdGhlIGhhbmRzaGFrZSwgd2FpdCBmb3IgdGhlIGVuZC4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD47XG4gIHRyeSB7XG4gICAgZmxhZ3MgPSBub2RlUGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogREFFTU9OX09QVElPTlMsIHN0cmljdDogdHJ1ZSB9KS52YWx1ZXMgYXMgUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgPjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYHNjcmlwdG9yaXVtOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG4gIHJlY29nbml6ZWQgZmxhZ3M6ICR7T2JqZWN0LmtleXMoXG4gICAgICAgIERBRU1PTl9PUFRJT05TLFxuICAgICAgKVxuICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBsZXQgZDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBzdGFydERhZW1vbj4+O1xuICB0cnkge1xuICAgIGQgPSBhd2FpdCBzdGFydERhZW1vbih7XG4gICAgICBwb3J0OiBmbGFncy5wb3J0ID8gTnVtYmVyKGZsYWdzLnBvcnQpIDogMCxcbiAgICAgIHJlc3RvcmU6IGZsYWdzLnJlc3RvcmUsXG4gICAgICB0aW1lb3V0UzogZmxhZ3MudGltZW91dCA/IE51bWJlcihmbGFncy50aW1lb3V0KSA6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIFRoZSBoYW5kc2hha2UgbGluZSBpcyBKU09OIGVpdGhlciB3YXksIHNvIHRoZSBDTEkgcmVhZHMgT05FIHNoYXBlLlxuICAgIGNvbnN0IHN0YXR1cyA9IGUgaW5zdGFuY2VvZiBTZXNzaW9uRXJyb3IgPyBlLnN0YXR1cyA6IDUwMDtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBzdGF0dXMsIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSl9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiBzdGF0dXMgPT09IDQwNCA/IDUgOiBzdGF0dXMgPT09IDQwOSA/IDYgOiAxO1xuICB9XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2QucG9ydH1gLCBwb3J0OiBkLnBvcnQsIHNlc3Npb25faWQ6IGQuc2Vzc2lvbklkLCBtb2RlOiBkLm1vZGUsIGRpcjogZC5kaXIgfSl9XFxuYCxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZC5kb25lO1xuICBhd2FpdCBkLnNodXRkb3duO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogYSBjbGVhbiBjbG9zZSBsZWF2ZXMgbm8gZW1wdHkgbG9nIGJlaGluZC5cbiAgaWYgKHJlcy5jb2RlID09PSAwICYmIGZsYWdzLmxvZykge1xuICAgIHRyeSB7XG4gICAgICBpZiAoc3RhdFN5bmMoZmxhZ3MubG9nKS5zaXplID09PSAwKSB1bmxpbmtTeW5jKGZsYWdzLmxvZyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlcy5jb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZVxuICogYnVuZGxlLCBzbyB0aGVyZSBpcyBubyBzdWNoIGJsb2NrIGhlcmUsIGFuZCB0aGlzIHRha2VzIG5vIGFyZ3VtZW50czogdGhlXG4gKiBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSB0d28gcHJpbWl0aXZlcyB1bmRlciBCT1RIIG9mIHRoZSBob3VzZSdzIGRhZW1vbi1kaXNjb3ZlcnkgY29udmVudGlvbnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBEMyBydWxlZCB0aGF0IHRoZSBjb252ZW50aW9ucyB0aGVtc2VsdmVzIOKAlCBwZXItc2Vzc2lvbiB0bXBkaXIgSlNPTiAoYm91bnR5LFxuICogZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZSkgYW5kIHNpbmdsZXRvbiBgJEhPTUUvZGFlbW9uLnBvcnRgICsgYGRhZW1vbi5waWRgXG4gKiAoYXN0cm9sYWJlLCBncmFwZXZpbmUsIG1pbmQtbWFwcGVyKSDigJQgYm90aCBzdXJ2aXZlLCBiZWNhdXNlIHRoZXkgZW5jb2RlXG4gKiBnZW51aW5lbHkgZGlmZmVyZW50IG1vZGVscyAoY29uY3VycmVudCBzZXNzaW9ucyB2cyBhIHN0YW5kaW5nIHNpbmdsZXRvbikgYW5kXG4gKiBwaWNraW5nIG9uZSBpcyBhIHByb2R1Y3QgZGVjaXNpb24sIG5vdCBhIGZhY3RvcmluZyBvbmUuIFdoYXQgSVMgb25lXG4gKiBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgcGFpciBiZWxvdywgd2hpY2ggaXMgYWxzbyBleGFjdGx5IHdoZXJlIGNlbnN1cyBkZWZlY3RcbiAqICoqTDMqKiBsaXZlcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKlxuICogV3JpdGUgYHRleHRgIHRvIGB0YXJnZXRgIGF0b21pY2FsbHk6IHdyaXRlIGJlc2lkZSBpdCwgdGhlbiByZW5hbWUuXG4gKlxuICog4puUICoqTDMsIENMT1NFRCBCWSBDT05TVFJVQ1RJT04uKiogQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljLCBzbyBhXG4gKiBDTEkgcmVhZGluZyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIEhBTEYtV1JJVFRFTiBwb2ludGVyLiBVbmRlclxuICogYSBiZXN0LWVmZm9ydCByZWFkZXIgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiIOKAlCBhYnNlbmNlIHJlcG9ydGVkXG4gKiBmb3Igd2hhdCB3YXMgcmVhbGx5IGEgdG9ybiByZWFkLCB3aGljaCBpcyB0aGUgZXhhY3QgY29uZmxhdGlvbiB0aGUgaG91c2Unc1xuICogYG51bGxgLW5vdC1gMGAgcnVsZSBleGlzdHMgdG8gcHJldmVudC4gUmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYyxcbiAqIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLCBuZXZlciBhIHBhcnRpYWxcbiAqIGZpbGUuXG4gKlxuICogRml4ZWQgaW4gZ2xhbW91ciAyMDI2LTA5LTA3LCBmb3VuZCBzdGFuZGluZyBpbiB0aHJlZSBzaWJsaW5ncyB0aGUgbmV4dCBkYXkgYnlcbiAqIHRoZSBkdXBsaWNhdGlvbiByZWNvbiwgYW5kIHJlcGFpcmVkIGluIGFsbCBvZiB0aGVtIHRoZSBvbmx5IHdheSB0aGF0IGRvZXMgbm90XG4gKiBuZWVkIGZpbmRpbmcgYWdhaW46IHRoZXJlIGlzIG5vdyBvbmUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4pqgIFRoZSB0ZW1wIG5hbWUgY2FycmllcyB0aGUgcGlkLCBzbyB0d28gZGFlbW9ucyByYWNpbmcgdG8gcHVibGlzaCB0aGUgc2FtZVxuICogcG9pbnRlciBjYW5ub3QgY2xvYmJlciBlYWNoIG90aGVyJ3MgaW50ZXJtZWRpYXRlIGZpbGUg4oCUIGFuZCBpdCBpcyByZW1vdmVkIG9uXG4gKiBhIGZhaWxlZCB3cml0ZSByYXRoZXIgdGhhbiBsZWZ0IGFzIGxpdHRlciBiZXNpZGUgdGhlIHJlYWwgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVGaWxlQXRvbWljKHRhcmdldDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModG1wLCB0ZXh0KTtcbiAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiB0aGUgdGVtcCBmaWxlIGlzIGFscmVhZHkgZ29uZSwgb3Igd2FzIG5ldmVyIGNyZWF0ZWQgKi9cbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogRGVsZXRlIGBwYXRoYCBpZmYgaXQgc3RpbGwgbmFtZXMgVVMuIFJldHVybnMgd2hldGhlciBpdCB3YXMgZGVsZXRlZC5cbiAqXG4gKiDim5QgKipcIlNUSUxMIE9VUlNcIiBJUyBUSEUgV0hPTEUgRlVOQ1RJT04uKiogQSBkYWVtb24gdGhhdCB1bmxpbmtzIGl0cyBkaXNjb3ZlcnlcbiAqIGZpbGUgdW5jb25kaXRpb25hbGx5IGF0IGV4aXQgZGVsZXRlcyB0aGUgcG9pbnRlciBhIFNVQ0NFU1NPUiBoYXMgYWxyZWFkeVxuICogd3JpdHRlbiDigJQgdGhlIHN1Y2Nlc3NvciBjYW4gdGhlbiBubyBsb25nZXIgYmUgZm91bmQgYW5kIHRoZSBuZXh0IENMSSB2ZXJiIHNwYXducyBhXG4gKiB0aGlyZCBkYWVtb24uIEJvdGggY29udmVudGlvbnMgaGF2ZSB0aGlzIGhhemFyZCBhbmQgYm90aCBleHByZXNzIGl0XG4gKiBkaWZmZXJlbnRseTogYXN0cm9sYWJlIGNvbXBhcmVzIHRoZSBwaWQgZmlsZSdzIGJ5dGVzIHRvIGl0cyBvd24gcGlkLFxuICogbWFncGllIHBhcnNlcyB0aGUgSlNPTiBwb2ludGVyIGFuZCBjb21wYXJlcyBgc2Vzc2lvbl9pZGAuIGBpZGVudGlmeWAgaXMgd2hhdFxuICogbWFrZXMgdGhvc2Ugb25lIGZ1bmN0aW9uIOKAlCBpdCB0dXJucyB0aGUgZmlsZSdzIGJ5dGVzIGludG8gdGhlIGlkZW50aXR5IHRvXG4gKiBjb21wYXJlLCBhbmQgaXQgZGVmYXVsdHMgdG8gdGhlIHRyaW1tZWQgYnl0ZXMgdGhlbXNlbHZlcy5cbiAqXG4gKiDimqAgRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgYW5kIHJlcG9ydGVkIGFzIGBmYWxzZWA6IHRoZSBmaWxlIGJlaW5nIGdvbmUsXG4gKiB1bnJlYWRhYmxlLCBvciB1bnBhcnNlYWJsZSBhbGwgbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlIOKAlCBpdCBpcyBub3Qgb3VycyB0b1xuICogcmVtb3ZlLiBBbiB1bnBhcnNlYWJsZSBwb2ludGVyIGlzIGRlbGliZXJhdGVseSBOT1QgdHJlYXRlZCBhcyBvdXJzLCB3aGljaCBpc1xuICogdGhlIGNvbnNlcnZhdGl2ZSBoYWxmIG9mIHRoZSBzYW1lIGBudWxsYC1ub3QtYDBgIHJ1bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxpbmtJZk1hdGNoZXMoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IHN0cmluZyxcbiAgaWRlbnRpZnk6IChyYXc6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbCA9IChyYXcpID0+IHJhdy50cmltKCksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaWRlbnRpZnkocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgIT09IGV4cGVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdW5saW5rU3luYyhwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGluLXByb2Nlc3MgZXZlbnQgbG9nIOKAlCB0aGUgYXBwZW5kLW9ubHksIHJlcGxheWFibGUgYnVmZmVyXG4gKiBiZWhpbmQgZXZlcnkgc3BlbGwncyBgR0VUIC9ldmVudHNgIFNTRSB0YWlsLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3NcbiAqIGBzY3JpcHRzL2V2ZW50cy50c2Ag4oCUIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzIsIGFuZCB0aGUgb25seSBvbmUgb2ZcbiAqIHRoZSBzaXggY29waWVkLWluLXBsYWNlIGJ1c2VzIHRoYXQgaXMgYSBtb2R1bGUsIGlzIGJvdW5kZWQsIGNhcnJpZXMgYW4gZXBvY2gsIGFuZCBpc1xuICogdW5pdC10ZXN0ZWQuIFRoZSBmaXZlIG90aGVycyBhcmUgdGhlIHNhbWUgdHdlbnR5IGxpbmVzIHdyaXR0ZW4gZml2ZSB0aW1lcy5cbiAqXG4gKiDilIDilIAgVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIOKAlCBUV08gQlkgQ09OU1RSVUNUSU9OLCBPTkUgQlkgT1BULUlOIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIOKblCBUSEUgSEVBRElORyBVU0VEIFRPIFNBWSBcIlRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyBCWSBDT05TVFJVQ1RJT05cIiBBTkRcbiAqIElURU0gMiBJUyBOT1QgT05FIE9GIFRIRU0uIENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIG1pbmQtbWFwcGVyJ3MgcHJlLXdvcmtcbiAqIChENzkpOiBgZXBvY2hgIGlzIE9QVElPTkFMIGhlcmUsIHNvIEw2IGlzIGNsb3NlZCBvbmx5IGZvciBhIGNhbGxlciB0aGF0IGFza3MuXG4gKiBUaHJlZSBhZG9wdGVycyBoYXZlIHNpbmNlIGRlY2xpbmVkIHRvIOKAlCBpbWFnbyAoRDM5KSwgYm91bnR5IChENDgpIGFuZFxuICogZ3JhcGV2aW5lIChENzApIOKAlCBzbyB0aGUgZGVmZWN0IHRoZSBoZWFkaW5nIGNsYWltZWQgdG8gbWFrZSBpbXBvc3NpYmxlIGlzXG4gKiBsaXZlIGluIHRoZSB0cmVlLCBieSBvcHQtb3V0LCBhbmQgdGhlIG92ZXJjbGFpbSBpcyB3aGF0IGhpZCB0aGF0LiBJdGVtcyAxIGFuZFxuICogMyBBUkUgYnkgY29uc3RydWN0aW9uOiBhIGNhbGxlciBjYW5ub3Qgc3dpdGNoIHRoZSBjYXAgb2ZmIG9yIHJlYWNoIHRoZSBidWZmZXIuXG4gKlxuICog4pqgIEFORCBNSU5ELU1BUFBFUidTIE9XTiBCVVMsIFdISUNIIFRISVMgTU9EVUxFIENPTlZFUkdFRCBUT1dBUkQsIFRZUEVTIFRIRVxuICogRVBPQ0ggQVMgUkVRVUlSRUQgYW5kIHN0YW1wcyBpdCB1bmNvbmRpdGlvbmFsbHkg4oCUIGl0IGlzIHRoZSBzcGVsbCBjZW5zdXMgTDZcbiAqIG5hbWVzIGFzIENPUlJFQ1QuIE1ha2luZyBpdCByZXF1aXJlZCBIRVJFIGlzIG5vdCB0aGUgcmVwYWlyOiBpdCB3b3VsZCByZXZlcnNlXG4gKiBEMzksIEQ0OCBhbmQgRDcwLiBUaGUgaG9uZXN0IHN0YXRlbWVudCBpcyB0aGlzIGhlYWRpbmcuXG4gKlxuICog4puUICoqUkVTT0xWRUQgQVQgVEhBVCBTUEVMTCdTIFBPUlQsIEFORCBUSEUgRElTUE9TSVRJT04gSVMgUkVDT1JERUQgSEVSRVxuICogQkVDQVVTRSBBIExPU1MgVEhBVCBMSVZFUyBPTkxZIElOIEEgSk9VUk5BTCBJUyBBIExPU1MgTk9CT0RZIENBTiBTRUVcbiAqIChENzkvRDg1KS4qKiBtaW5kLW1hcHBlciBhZG9wdGVkIHRoaXMgbW9kdWxlIGluIFBoYXNlIDcgYW5kIGtlcHQgaXRzXG4gKiBndWFyYW50ZWUgV0lUSE9VVCBBIEtJVCBDSEFOR0U6IGl0IHBhc3NlcyBgeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9YCBhdFxuICogaXRzIE9ORSBjb25zdHJ1Y3Rpb24gc2l0ZSBhbmQgcmUtdGlnaHRlbnMgYGVwb2NoYCB0byBSRVFVSVJFRCBpbiBpdHMgb3duXG4gKiBsb2NhbCBmcmFtZSB0eXBlLCBzbyBub3RoaW5nIGl0cyBidXMgZW1pdHMgY2FuIGxhY2sgb25lLiBLaXQgYnl0ZXM6IHplcm8uXG4gKiAqKlNvIHRoZSBlcG9jaCBpcyBhIExPU1NZLUNPUFkgcHJvcGVydHkgd2hvc2UgZGlzcG9zaXRpb24gaXMgS0VFUC1MT0NBTCwgbm90XG4gKiBSRVNUT1JFKiog4oCUIHRoZSBvbmx5IHByb3BlcnR5IG9mIHRoYXQgc3BlbGwncyBvd24gbW9kdWxlIHRoaXMgbW9kdWxlIGNvdWxkXG4gKiBub3QgY2FycnkgYW5kIGRpZCBub3QgbmVlZCB0by4gTDYgaXMgQ0xPU0VEIGZvciB0aGUgdHdvIHNwZWxscyB0aGF0IGFzayBhbmRcbiAqIE9QRU4sIGJ5IG9wdC1vdXQsIGZvciB0aGUgdGhyZWUgdGhhdCBkZWNsaW5lOyB0aGF0IGFzeW1tZXRyeSBpcyB0aGUgaG9uZXN0XG4gKiBzdGF0ZSBhbmQgdGhpcyBoZWFkaW5nIGlzIHdoZXJlIGl0IGlzIHdyaXR0ZW4uXG4gKlxuICog4pqgICoqQU5EIFRIRSBBRE9QVElPTiBSRU5BTUVTIEEgRklFTEQgT04gQU4gQURPUFRFUidTIFBVQkxJU0hFRCBXSVJFLioqIGBpZGBcbiAqIGlzIG5hbWVkIGluIGBGcmFtZTxUPmAgYW5kIGluIHRoZSBlbWl0IGxpdGVyYWwgYmVsb3csIHNvIGEgc3BlbGwgd2hvc2UgYnVzXG4gKiBzcGVsbGVkIHRoZSBjdXJzb3IgYW55dGhpbmcgZWxzZSBwYXlzIGEgcmVuYW1lIGF0IGV2ZXJ5IHJlYWRlciDigJQgZm9yXG4gKiBtaW5kLW1hcHBlciwgMTczIG9jY3VycmVuY2VzIGFjcm9zcyA1IHN1cmZhY2UgZmlsZXMsIH4yMDkgYWNyb3NzIH4zMCBiYWNrZW5kXG4gKiBmaWxlcywgZXZlcnkgSlNPTkwgbGluZSBpdHMgYHRhaWxgIHdyaXRlcyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgYW5kICh0aGUgb25lXG4gKiBub2JvZHkgY291bnRlZCkgdGhlIEZJWFRVUkUgaW4gaXRzIG93biBgdGFpbC50ZXN0LnRzYCwgd2hpY2ggV1JJVEVTIHRoZVxuICogZW52ZWxvcGUgd2hpbGUgc3RhbmRpbmcgaW4gZm9yIHRoZSBkYWVtb24uIFRoZSBORVNUSU5HIGlzIG5vdCBmb3JjZWQg4oCUXG4gKiBgRnJhbWU8VD5gIGlzIGdlbmVyaWMsIGFuZCBtaW5kLW1hcHBlciBrZXB0IGB7a2luZCwgcGF5bG9hZH1gIG5lc3RlZCB3aGVyZSBhbGxcbiAqIGZpdmUgZWFybGllciBhZG9wdGVycyBmbGF0dGVuIGJ5IGlkaW9tLiAqKkFuIGlkaW9tIGZpdmUgc2libGluZ3Mgc2hhcmUgaXNcbiAqIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBjb250cmFjdCB1bnRpbCB5b3Ugb3BlbiB0aGUgdHlwZSoqIChEODEsIEQ4NikuXG4gKlxuICogKioxIMK3IEw1IOKAlCB0aGUgYnVmZmVyIGlzIGJvdW5kZWQuKiogRml2ZSBkYWVtb25zIGFwcGVuZCB0byBhbiBhcnJheSBmb3IgdGhlXG4gKiB3aG9sZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBUaGUgd2luZG93IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiBkYWVtb24ncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2c7IGEgY2FwIGlzIHRoZSBob25lc3Qgc2hhcGUuXG4gKlxuICogKioyIMK3IEw2IOKAlCBhIGZyYW1lIGNhcnJpZXMgYW4gZXBvY2gsIFdIRU4gVEhFIENBTExFUiBBU0tTIEZPUiBPTkUgKG9wdC1pbixcbiAqIG5vdCBjb25zdHJ1Y3Rpb24g4oCUIHNlZSBhYm92ZSkuKiogQWZ0ZXIgYSByZXN0YXJ0IHRoZSBpZHMgc3RhcnQgYWdhaW4gYXQgMSwgc29cbiAqIGEgcmVzdW1pbmcgY2xpZW50IGNhbm5vdCB0ZWxsIGEgc3RhbGUgd2F0ZXJtYXJrIGZyb20gYSBmcmVzaCBvbmUgYnkgaWQgYWxvbmUuXG4gKlxuICogKiozIMK3IEEgU1RBTEUgV0FURVJNQVJLIFJFUExBWVMgRlJPTSBUSEUgQkVHSU5OSU5HLCBhbmQgdGhpcyBpcyB0aGUgaGFsZiB0aGVcbiAqIGNsaWVudCBjYW5ub3QgZG8uKiogTUVBU1VSRUQgb24gYXN0cm9sYWJlOiBhIHRhaWwgdGhhdCByZXN1bWVzIGF0XG4gKiBgc2luY2U9PGxhc3QgaWQgb2YgdGhlIHByZXZpb3VzIGRhZW1vbj5gIGFnYWluc3QgYSByZXN0YXJ0ZWQgZGFlbW9uIHJlY2VpdmVzXG4gKiBOT1RISU5HIOKAlCB0aGUgbmV3IGRhZW1vbidzIGByZWFkeWAgaXMgaWQgMSwgd2hpY2ggaXMgbm90IGA+IHNpbmNlYCwgc28gdGhlXG4gKiBmaWx0ZXIgZHJvcHMgaXQsIHNvIG5vIGZyYW1lIGFycml2ZXMsIHNvIHRoZSBjbGllbnQncyBlcG9jaCBjaGVjayBuZXZlciBydW5zXG4gKiBhbmQgdGhlIHRhaWwgc2l0cyBjb25uZWN0ZWQgYW5kIHNpbGVudCB1bnRpbCB0aGUgbmV3IGRhZW1vbiBoYXMgZW1pdHRlZCBhc1xuICogbWFueSBldmVudHMgYXMgdGhlIG9sZCBvbmUgZGlkLiBTdGFtcGluZyBhbiBlcG9jaCBhbG9uZSBkb2VzIE5PVCBjbG9zZSB0aGF0XG4gKiBnYXA6IHRoZSBlcG9jaCByaWRlcyBhIGZyYW1lLCBhbmQgdGhlIGJ1ZyBpcyB0aGF0IG5vIGZyYW1lIGlzIHNlbnQuIFNvXG4gKiBgc3Vic2NyaWJlYCB0cmVhdHMgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYW5vdGhlciBwcm9jZXNzXCJcbiAqIGFuZCByZXBsYXlzIHdob2xlLiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuIE5vdFxuICogXCJubyBzdWJqZWN0XCIg4oCUIGdyYXBldmluZSBIQVMgYW4gZXZlbnQgYnVzIGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGVcbiAqIHNwZWxsIOKAlCBidXQgdGhlIHR3byBzaGFwZXMgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBvbmUgcHJvY2Vzcy13aWRlIGFycmF5IGNhcHBlZCBhdCBSRVBMQVlfQlVGRkVSX1NJWkUsIHdpdGggb25lXG4gKiAgICAgICAgICAgICAgICBtb25vdG9uaWMgYHNlcWAsIGFuZCB0aGUgaGVhZGVyIHRocmVlIHBhcmFncmFwaHMgdXAgc2F5cyBpbiBhc1xuICogICAgICAgICAgICAgICAgbWFueSB3b3JkcyB0aGF0IGl0IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiAgICAgICAgICAgICAgICBkYWVtb24ncyBsaWZldGltZSwgTk9UIGEgZHVyYWJsZSBsb2cuXG4gKiAgIGdyYXBldmluZSAgICBOIGR1cmFibGUgYXBwZW5kLW9ubHkgYC5qc29ubGAgZmlsZXMsIG9uZSBwZXIgbmFtZWQgY2hhbm5lbCxcbiAqICAgICAgICAgICAgICAgIGVhY2ggd2l0aCBpdHMgb3duIGBuZXh0X2lkYCwgcmVwbGF5ZWQgZnJvbSBkaXNrIGJ5XG4gKiAgICAgICAgICAgICAgICBgcmVhZEJhY2tsb2dgLCBzdXJ2aXZpbmcgcmVzdGFydCwgYHJvbGxgLCBhcmNoaXZlIGFuZCBjbGVhci5cbiAqXG4gKiAqKlRoZSByZWFkZXIgdGhhdCBtYWtlcyB0aGVtIGluY29tcGF0aWJsZSwgYXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhblxuICogYXNzZXJ0aW9uOioqIGdyYXBldmluZSdzIGBsb2FkQ2hhbm5lbCgpYCBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIEhJR0gtV0FURVJcbiAqIE1BUksgb3ZlciBldmVyeSBwYXJzZWFibGUgbGluZSBvZiB0aGUgY2hhbm5lbCdzIGZpbGUgb24gYm9vdC4gVGhlcmUgaXMgbm9cbiAqIGFycmF5IHRvIGJlIHRoYXQgbWFyayBvZiwgYW5kIG5vIGNhcCB0aGF0IHdvdWxkIG5vdCBzaWxlbnRseSBkaXNjYXJkIGhpc3RvcnlcbiAqIGEgY2FsbGVyIGNhbiBzdGlsbCBhc2sgZm9yIGJ5IGlkLiBJdCBpcyB0aGUgdGhpbmcgdGhpcyBtb2R1bGUncyBvd24gaGVhZGVyXG4gKiBzYXlzIGl0IGlzIGRlbGliZXJhdGVseSBub3QuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGEgcGVyLWNoYW5uZWwgZHVyYWJsZVxuICogc3RvcmUgd291bGQgY2hhbmdlIGBjcmVhdGVFdmVudExvZ2AncyBzdG9yYWdlIGFuZCBpdHMgYHN1YnNjcmliZWAgY29udHJhY3QgZm9yXG4gKiBmaXZlIG90aGVyIGRhZW1vbnMsIHJlLWVtaXR0aW5nIFNJWCBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYVxuICogZHJpdmUg4oCUIHBhaWQgYnkgcG9ydHMgdGhhdCBhcmUgYWxyZWFkeSBmaW5pc2hlZCBhbmQgYnkgYWdlbnRzIG5vdCBpbiB0aGUgcm9vbS5cbiAqIEEgd2lkZW5pbmcgcmVtYWlucyBhdmFpbGFibGUgYXMgaXRzIG93biBhcmd1ZWQgZGVjaXNpb24gd2l0aCBpdHMgb3duXG4gKiBibGFzdC1yYWRpdXMgY291bnQ7IGl0IGlzIG5ldmVyIGEgc3RlcCBpbnNpZGUgYSBwb3J0LlxuICpcbiAqIOKaoCBBTkQgVEhFIGBlcG9jaGAgQUJPVkUgSVMgVEhFIFNIQVJQRVNUIEhBTEYgT0YgV0hZIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlXG4gKiBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCwgc28gdGhlIGNvbmRpdGlvbiBwYXJhZ3JhcGggMiBkZXNjcmliZXMg4oCUIGlkc1xuICogc3RhcnRpbmcgYWdhaW4gYXQgMSDigJQgY2Fubm90IG9jY3VyIHRoZXJlLCBhbmQgc3RhbXBpbmcgb25lIGFueXdheSBpcyBub3RcbiAqIGluZXJ0OiBgdGFpbEV2ZW50c2AncyBgb25FcG9jaENoYW5nZWAgc2V0cyB0aGUgY3Vyc29yIHRvIDAsIGFuZCBncmFwZXZpbmUnc1xuICogdGFpbCByb3V0ZSBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoIHRoZSBXSE9MRSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhblxuICogYWdlbnQncyBwaXBlLCBvbiBldmVyeSBgcm9sbGAuIFRoZSBlcG9jaCdzIGNsaWVudC1zaWRlIGFjdGlvbiBpcyBcInlvdXIgY3Vyc29yXG4gKiBpcyB3b3J0aGxlc3MsIHN0YXJ0IG92ZXJcIiwgYW5kIHRoYXQgaXMgc2FmZSBvbmx5IHdoZXJlIHN0YXJ0aW5nIG92ZXIgY29zdHMgYVxuICogYm91bmRlZCBpbi1tZW1vcnkgcmVwbGF5IHdpbmRvdy5cbiAqL1xuXG4vKiogVGhlIGRlZmF1bHQgcmVwbGF5IHdpbmRvdywgaW5oZXJpdGVkIGZyb20gbWluZC1tYXBwZXIncyBtZWFzdXJlZCBjYXAuICovXG5leHBvcnQgY29uc3QgUkVQTEFZX0JVRkZFUl9TSVpFID0gMTAwMDtcblxuLyoqIEEgZnJhbWUgYXMgaXQgZ29lcyBvbiB0aGUgd2lyZTogdGhlIGNhbGxlcidzIHBheWxvYWQgcGx1cyBhIG1vbm90b25pYyBgaWRgLFxuICogIHBsdXMgYW4gYGVwb2NoYCB3aGVuIHRoZSBsb2cgd2FzIGdpdmVuIG9uZS4gKi9cbmV4cG9ydCB0eXBlIEZyYW1lPFQ+ID0gVCAmIHsgaWQ6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBFdmVudExvZzxUPiB7XG4gIC8qKiBBcHBlbmQgb25lIGZyYW1lLCBmYW4gaXQgb3V0IHRvIGxpdmUgc3Vic2NyaWJlcnMsIGFuZCByZXR1cm4gaXQuICovXG4gIGVtaXQobXNnOiBUKTogRnJhbWU8VD47XG4gIC8qKlxuICAgKiBSZXBsYXkgZXZlcnl0aGluZyBhZnRlciBgc2luY2VgLCB0aGVuIHN0YXkgc3Vic2NyaWJlZC4gUmV0dXJucyBhblxuICAgKiB1bnN1YnNjcmliZSBmdW5jdGlvbi5cbiAgICpcbiAgICog4puUIFJFUExBWSBBTkQgU1VCU0NSSUJFIEFSRSBPTkUgQ0FMTCBPTiBQVVJQT1NFLiBEb2luZyB0aGVtIGluIHR3byBzdGVwc1xuICAgKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYW4gZW1pdCBsYW5kcyBiZXR3ZWVuIHRoZSByZXBsYXkgbG9vcCBhbmQgdGhlXG4gICAqIGBhZGRgLCBhbmQgdGhhdCBmcmFtZSBpcyBkZWxpdmVyZWQgdG8gbm9ib2R5IOKAlCB0aGUgc2hhcGUgZml2ZSBkYWVtb25zIGhhdmUsXG4gICAqIHN1cnZpdmVkIGJ5IG5vdGhpbmcgYnV0IHRoZSBzaW5nbGUtdGhyZWFkZWQgZXZlbnQgbG9vcCBoYXBwZW5pbmcgdG8gY2xvc2VcbiAgICogaXQuIERlcGVuZGluZyBvbiB0aGF0IGlzIGRlcGVuZGluZyBvbiBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgb2YgdGhlXG4gICAqIHJ1bnRpbWUgcmF0aGVyIHRoYW4gb24gdGhlIGNvZGUuXG4gICAqL1xuICBzdWJzY3JpYmUoc2luY2U6IG51bWJlciwgbGlzdGVuZXI6IChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGhpZ2hlc3QgaWQgZW1pdHRlZCBzbyBmYXIg4oCUIHdoYXQgYEdFVCAvc3RhdGVgIHJldHVybnMgYXMgYGN1cnNvcmAuICovXG4gIGN1cnNvcigpOiBudW1iZXI7XG4gIC8qKiBUaGUgZXBvY2ggc3RhbXBlZCBvbiBldmVyeSBmcmFtZSwgb3IgYHVuZGVmaW5lZGAgaWYgbm9uZSB3YXMgY29uZmlndXJlZC4gKi9cbiAgcmVhZG9ubHkgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50TG9nPFQgZXh0ZW5kcyBvYmplY3Q+KFxuICBvcHRzOiB7IGVwb2NoPzogc3RyaW5nOyBidWZmZXJTaXplPzogbnVtYmVyIH0gPSB7fSxcbik6IEV2ZW50TG9nPFQ+IHtcbiAgY29uc3QgYnVmZmVyU2l6ZSA9IG9wdHMuYnVmZmVyU2l6ZSA/PyBSRVBMQVlfQlVGRkVSX1NJWkU7XG4gIGNvbnN0IGVwb2NoID0gb3B0cy5lcG9jaDtcbiAgY29uc3QgYnVmZmVyOiBBcnJheTxGcmFtZTxUPj4gPSBbXTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IFNldDwoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkPigpO1xuICBsZXQgc2VxID0gMDtcblxuICByZXR1cm4ge1xuICAgIGVwb2NoLFxuXG4gICAgZW1pdChtc2cpIHtcbiAgICAgIHNlcSArPSAxO1xuICAgICAgLy8g4puUIFRIRSBNT05PVE9OSUMgSUQgV0lOUyBPVkVSIEFOWVRISU5HIElOIFRIRSBQQVlMT0FELCBBTkQgVU5USUwgTk9XIElUXG4gICAgICAvLyBPTkxZIENMQUlNRUQgVE8uIEJvdGggYWRvcHRpbmcgZGFlbW9ucyB3cm90ZSBgeyBpZDogKytzZXEsIC4uLm1zZyB9YFxuICAgICAgLy8gdW5kZXIgYSBjb21tZW50IHNheWluZyBcInRoZSBtb25vdG9uaWMgYGlkYCBNVVNUIHdpbiBvdmVyIGFueSBgaWRgIGluXG4gICAgICAvLyB0aGUgcGF5bG9hZCwgc28gY2FsbGVycyBjYXJyeSBhIHByb2plY3QgaWRlbnRpZmllciBhcyBgcHJvamVjdElkYCxcbiAgICAgIC8vIG5ldmVyIGBpZGBcIiDigJQgYnV0IHNwcmVhZCBvcmRlciBtZWFucyBhIHBheWxvYWQgYGlkYCBvdmVycm9kZSB0aGVcbiAgICAgIC8vIGN1cnNvciwgc2lsZW50bHksIGFuZCB0aGUgY29udmVudGlvbiBpbiB0aGUgY29tbWVudCB3YXMgdGhlIG9ubHkgdGhpbmdcbiAgICAgIC8vIGhvbGRpbmcgaXQuIFRoZSBsaXRlcmFsIGtlZXBzIGBpZGAgRklSU1Qgc28gdGhlIHdpcmUga2V5IG9yZGVyIGlzXG4gICAgICAvLyB1bmNoYW5nZWQ7IHRoZSBhc3NpZ25tZW50IGFmdGVyIHRoZSBzcHJlYWQgaXMgd2hhdCBtYWtlcyB0aGUgc2VudGVuY2VcbiAgICAgIC8vIHRydWUuIGBlcG9jaGAgaXMgc3RhbXBlZCB0aGUgc2FtZSB3YXkgYW5kIGZvciB0aGUgc2FtZSByZWFzb24uXG4gICAgICBjb25zdCBmcmFtZSA9IHsgaWQ6IHNlcSwgLi4ubXNnIH0gYXMgRnJhbWU8VD47XG4gICAgICBmcmFtZS5pZCA9IHNlcTtcbiAgICAgIGlmIChlcG9jaCAhPT0gdW5kZWZpbmVkKSBmcmFtZS5lcG9jaCA9IGVwb2NoO1xuXG4gICAgICBidWZmZXIucHVzaChmcmFtZSk7XG4gICAgICBpZiAoYnVmZmVyLmxlbmd0aCA+IGJ1ZmZlclNpemUpIGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCBsaXN0ZW5lciBvZiBsaXN0ZW5lcnMpIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIHJldHVybiBmcmFtZTtcbiAgICB9LFxuXG4gICAgc3Vic2NyaWJlKHNpbmNlLCBsaXN0ZW5lcikge1xuICAgICAgLy8gU2VlIHRoZSBoZWFkZXIsIHBvaW50IDM6IGEgY3Vyc29yIGJleW9uZCBvdXIgb3duIGlzIGEgY3Vyc29yIGZyb20gYVxuICAgICAgLy8gUFJJT1IgUFJPQ0VTUywgYW5kIHRoZSBvbmx5IHVzZWZ1bCByZWFkaW5nIG9mIGl0IGlzIFwicmVwbGF5IHdob2xlXCIuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEEgTk9OLUZJTklURSBDVVJTT1IgQUxTTyBNRUFOUyBcIkZST00gVEhFIFNUQVJUXCIsIHdoaWNoIHRoZSBjb3BpZXMgZ290XG4gICAgICAvLyB3cm9uZyBieSBhY2NpZGVudDogdGhleSB3cm90ZSBgcGFyc2VJbnQocGFyYW0gPz8gXCItMVwiKWAgYW5kIGNvbXBhcmVkXG4gICAgICAvLyBgaWQgPiBzaW5jZWAsIHNvIGEgdHlwbydkIGA/c2luY2U9eGAgcHJvZHVjZWQgYE5hTmAsIGV2ZXJ5IGNvbXBhcmlzb25cbiAgICAgIC8vIHdhcyBmYWxzZSwgYW5kIHRoZSB0YWlsIG9wZW5lZCBFTVBUWSBhbmQgc3RheWVkIGNvbm5lY3RlZCDigJQgdGhlIHNhbWVcbiAgICAgIC8vIHNpbGVudC1hbmQtY29ubmVjdGVkIHN5bXB0b20gYXMgdGhlIHN0YWxlIHdhdGVybWFyaywgZnJvbSBhIGRpZmZlcmVudFxuICAgICAgLy8gY2F1c2UuIEFic2VudCBhbmQgdW5wYXJzZWFibGUgYXJlIHRoZSBzYW1lIHJlcXVlc3QgaGVyZS5cbiAgICAgIGNvbnN0IGZyb20gPSAhTnVtYmVyLmlzRmluaXRlKHNpbmNlKSB8fCBzaW5jZSA+IHNlcSA/IC0xIDogc2luY2U7XG4gICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGJ1ZmZlcikge1xuICAgICAgICBpZiAoZnJhbWUuaWQgPiBmcm9tKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICB9XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgIGxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgICAgfTtcbiAgICB9LFxuXG4gICAgY3Vyc29yKCkge1xuICAgICAgcmV0dXJuIHNlcTtcbiAgICB9LFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBkYWVtb24gbGlmZWN5Y2xlIHRhaWw6IHRoZSBpZGxlLWNsb3NlIGRlY2lzaW9uLCB0aGUgc3dlZXBcbiAqIHRoYXQgbWFrZXMgaXQsIGFuZCB0aGUgYm91bmRlZCB0ZWFyZG93bi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBib3VudHkg4oCUIHRoZSBjZW5zdXMnc1xuICogY29udmVyZ2VuY2UgdGFyZ2V0ICMzIOKAlCB3aXRoIGFzdHJvbGFiZSdzIGB0aW1lb3V0TXMgPiAwYCBndWFyZCBmb2xkZWQgaW4sXG4gKiB3aGljaCBpcyB0aGUgb25lIHRoaW5nIGJvdW50eSdzIGNvcHkgZG9lcyBub3QgZXhwcmVzcy5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBBRE9QVFMgYGRyYWluQW5kU3RvcGAgQU5EIE5PVEhJTkcgRUxTRSBIRVJFIOKAlCBTUExJVCBQRVIgRVhQT1JUXG4gKlxuICogUnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KSwgYW5kIGl0IGlzIHdyaXR0ZW4gZG93blxuICogYmVjYXVzZSBhIHJvdyBpcyBhIE1PRFVMRSBhbmQgXCJwYXJ0aWFsXCIgaXMgbm90IGFuIGFuc3dlciB1bnRpbCBpdCBzYXlzIHdoaWNoXG4gKiBleHBvcnRzLiBHcmFwZXZpbmUgaXMgbG9uZy1ydW5uaW5nLCBzbyBub3RoaW5nIGFib3V0IGl0cyBsaWZlY3ljbGUgbWFrZXMgdGhpc1xuICogbW9kdWxlIHJlYWQgYXMgaW5hcHBsaWNhYmxlIOKAlCBhbmQgdHdvIG9mIGl0cyB0aHJlZSBleHBvcnRzIHN0aWxsIGhhdmUgbm9cbiAqIHN1YmplY3QgdGhlcmU6XG4gKlxuICogICBgc2hvdWxkSWRsZUNsb3NlYCAgICAgIE5PIFNVQkpFQ1QuIEdyYXBldmluZSBydW5zIG5vIGlkbGUgc3dlZXAgYW5kIGhhcyBub1xuICogICBgc3RhcnRIb3VzZWtlZXBpbmdgICAgIGAtLXRpbWVvdXRgOyBpdCBpcyBhIGJyb2tlciB0aGF0IHN0YW5kcyB1bnRpbCBgc3RvcGBcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAoYERFTEVURSAvYCkgb3IgYSBzaWduYWwsIGFuZCBpdCB0YWtlcyBubyBzbmFwc2hvdC5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBBZG9wdGluZyB0aGUgcGFpci1tYW5hZ2VyIHdvdWxkIG1lYW4gd3JpdGluZyBhIG5vLW9wXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHRvdWNoYCBhbmQgYSBgc3Vic2NyaWJlckNvdW50YCB0aGF0IGV4aXN0cyBvbmx5IHRvXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGEgbnVtYmVyIG5vYm9keSBhY3RzIG9uIOKAlCB0d28gbGllcyB0byBnYWluIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgY2xlYXJJbnRlcnZhbGAuXG4gKiAgIGBkcmFpbkFuZFN0b3BgICAgICAgICAgQURPUFRFRCwgYW5kIGl0IGlzIGEgREUtRFVQTElDQVRJT04gcmF0aGVyIHRoYW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGdhaW46IGdyYXBldmluZSdzIHRlYXJkb3duIGFscmVhZHkgV0FTXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIDIwMCBtc10pYCwgd2hpY2ggaXNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgc3RvcE1zYCBleGFjdGx5LlxuICpcbiAqIOKaoCAqKkFORCBJVCBJUyBDQUxMRUQgV0lUSCBOTyBgY2xpZW50c2AsIFdISUNIIElTIEEgTUVBU1VSRU1FTlQsIE5PVCBBTlxuICogT1ZFUlNJR0hULioqIFRoaXMgbW9kdWxlIGNsb3NlcyBhIGhlbGQgY29ubmVjdGlvbiBieSBjYWxsaW5nIGBjbGllbnQuY2xvc2UoKWA7XG4gKiBncmFwZXZpbmUncyBzdWJzY3JpYmVyIHJlY29yZHMgYXJlIGB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfWAgYW5kIGNhcnJ5IG5vXG4gKiBgY2xvc2VgIOKAlCBpdHMgcGVyLXN0cmVhbSB0ZWFyZG93biBpcyBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW1cbiAqIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb20gYGNhbmNlbCgpYC4gVGhlcmUgaXMgbm90aGluZyB0byBoYW5kIHRoZVxuICogYXJndW1lbnQuIGBzc2UudHNgJ3MgaGVhZGVyIGNhcnJpZXMgdGhlIHJlc3Qgb2YgdGhhdCBydWxpbmcsIGluY2x1ZGluZyB0aGVcbiAqIHdpZGVuaW5nIG5vdCBkb25lIGFuZCBpdHMgY29zdCAoc2l4IGFydGlmYWN0cyBhY3Jvc3MgZml2ZSBzcGVsbHMpLlxuICpcbiAqIOKaoCBHcmFwZXZpbmUgYWxzbyBwYXNzZXMgYGdyYWNlTXM6IDBgLiBOb3QgYSBkaXNhZ3JlZW1lbnQgd2l0aCB0aGUgZ3JhY2VcbiAqIHBlcmlvZDogaXQgZW1pdHMgbm8gZmFyZXdlbGwgZnJhbWUgYXQgZGFlbW9uIHNodXRkb3duLCBhbmQgaXRzIGBERUxFVEUgL2BcbiAqIGFscmVhZHkgcmV0dXJucyB0aGUgcmVzcG9uc2UgYW5kIHNjaGVkdWxlcyB0aGUgdGVhcmRvd24gMTAgbXMgbGF0ZXIsIHNvIGl0c1xuICogZmx1c2ggd2luZG93IHNpdHMgYXQgdGhlIHJvdXRlIHJhdGhlciB0aGFuIGluIHRoZSBkcmFpbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFNzZUNsaWVudHMgfSBmcm9tIFwiLi9zc2UudHNcIjtcblxuLyoqXG4gKiBTaG91bGQgdGhlIGRhZW1vbiBpZGxlLWNsb3NlP1xuICpcbiAqIOKblCAqKmBzdWJzY3JpYmVyQ291bnRgIElTIEEgUkVRVUlSRUQgQVJHVU1FTlQsIEFORCBUSEFUIElTIFRIRSBXSE9MRSBQT0lOVC4qKlxuICogVGhpcyBjbG9zZXMgY2Vuc3VzIGRlZmVjdCAqKkwxKiogYnkgY29uc3RydWN0aW9uOiBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllXG4gKiBjb3VudGVkIHRoZWlyIGlkbGUgZmxvb3IgZG93biB3aGlsZSBhbiBhZ2VudCBoZWxkIGEgdGFpbCBvcGVuLCBzbyBhbiBhZ2VudFxuICogd2F0Y2hpbmcgYSBxdWlldCBib2FyZCB3YXMga2lsbGVkIFdJVEggSVRTIENPTk5FQ1RJT04gT1BFTi4gVGhlcmUgaXMgbm9cbiAqIG92ZXJsb2FkIG9mIHRoaXMgZnVuY3Rpb24gdGhhdCBjYW5ub3Qgc2VlIGl0cyBzdWJzY3JpYmVycywgc28gdGhlIGRlZmVjdFxuICogY2Fubm90IGJlIHJlLWV4cHJlc3NlZCBieSBhIGNhbGxlciB3aG8gZm9yZ2V0cy5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNDQVIgSVQgQ0FNRSBXSVRILCByZS1ob21lZCBmcm9tIGJvdW50eSB2ZXJiYXRpbSBpbiBzdWJzdGFuY2U6KipcbiAqIGEgYm9hcmQgb25seSBjb3VudHMgaXRzIGlkbGUgZmxvb3IgZG93biB3aGlsZSBVTldBVENIRUQuIEEgbGl2ZSBzdWJzY3JpYmVyIOKAlFxuICogYSBicm93c2VyIFdlYlNvY2tldCwgb3IgYW4gYWdlbnQgU1NFIHRhaWwgb24gYC9ldmVudHNgIOKAlCBrZWVwcyBpdCBvcGVuXG4gKiBpbmRlZmluaXRlbHkuIFNvIGB0aW1lb3V0YCBtZWFucyBcImxpbmdlciB0aGlzIGxvbmcgYWZ0ZXIgdGhlIExBU1Qgc3Vic2NyaWJlclxuICogbGVhdmVzXCIsIE5PVCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi4gVGhlIHN3ZWVwIGJlbG93IGFsc28gdG91Y2hlcyB0aGVcbiAqIGFjdGl2aXR5IGNsb2NrIG9uIGV2ZXJ5IHRpY2sgd2hpbGUgd2F0Y2hlZCwgc28gb25jZSB1bndhdGNoZWQgdGhlIGZsb29yXG4gKiBjb3VudHMgZnJvbSB0aGF0IGxhc3QgZGlzY29ubmVjdCBhbmQgbm90IGZyb20gdGhlIGxhc3QgcmVxdWVzdC5cbiAqXG4gKiDimqAgYHRpbWVvdXRNcyA8PSAwYCBtZWFucyBORVZFUiwgd2hpY2ggaXMgYXN0cm9sYWJlJ3Mgc3RhbmRpbmctb2JzZXJ2YXRvcnlcbiAqIGRlZmF1bHQgYW5kIGlzIHdoeSB0aGUgZ3VhcmQgaXMgaGVyZSByYXRoZXIgdGhhbiBhdCBpdHMgb25lIGNhbGwgc2l0ZTogYVxuICogc2luZ2xldG9uIGRhZW1vbiBpcyBtZWFudCB0byBzdGFuZCB1bnRpbCBpdCBpcyBleHBsaWNpdGx5IGNsb3NlZCwgYW5kIGFcbiAqIGA+PSAwYCBjb21wYXJpc29uIHdvdWxkIGNsb3NlIGl0IG9uIHRoZSBmaXJzdCB0aWNrLlxuICpcbiAqIENsb2NrLWZyZWUgYW5kIGZzLWZyZWUsIHNvIGl0IGlzIHRlc3RhYmxlIHdpdGhvdXQgYSBkYWVtb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRJZGxlQ2xvc2UoXG4gIHN1YnNjcmliZXJDb3VudDogbnVtYmVyLFxuICBpZGxlTXM6IG51bWJlcixcbiAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKHRpbWVvdXRNcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvdXNla2VlcGluZ09wdGlvbnMge1xuICAvKiog4puUIFJFUVVJUkVELiBTZWUgYHNob3VsZElkbGVDbG9zZWAg4oCUIHRoaXMgaXMgd2hhdCBjbG9zZXMgTDEuICovXG4gIHN1YnNjcmliZXJDb3VudDogKCkgPT4gbnVtYmVyO1xuICAvKiogTWlsbGlzZWNvbmRzIHNpbmNlIHRoZSBsYXN0IGFjdGl2aXR5LiAqL1xuICBpZGxlTXM6ICgpID0+IG51bWJlcjtcbiAgLyoqIFJlc2V0IHRoZSBhY3Rpdml0eSBjbG9jay4gQ2FsbGVkIG9uIGV2ZXJ5IHRpY2sgdGhhdCBoYXMgYSBzdWJzY3JpYmVyLiAqL1xuICB0b3VjaDogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBjb25maWd1cmVkIGlkbGUgdGltZW91dCBpbiBtczsgYDBgIChvciBsZXNzKSBtZWFucyBuZXZlci4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBGaXJlZCBvbmNlIHdoZW4gdGhlIGRhZW1vbiBzaG91bGQgY2xvc2UgaXRzZWxmLiAqL1xuICBvbklkbGVDbG9zZTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBkZWJvdW5jZWQgc25hcHNob3QsIGlmIHRoZSBzcGVsbCBoYXMgb25lLiAqL1xuICBzbmFwc2hvdD86IHtcbiAgICBkaXJ0eTogKCkgPT4gYm9vbGVhbjtcbiAgICBjbGVhcjogKCkgPT4gdm9pZDtcbiAgICB3cml0ZTogKCkgPT4gdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIH07XG4gIC8qKiBTd2VlcCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMjUwIG1zLiAqL1xuICB0aWNrTXM/OiBudW1iZXI7XG4gIC8qKiBTbmFwc2hvdCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMTAwMCBtcy4gKi9cbiAgc25hcHNob3RNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBTdGFydCB0aGUgdHdvIHN0YW5kaW5nIHRpbWVycyBldmVyeSBzZXNzaW9uIGRhZW1vbiBydW5zIOKAlCB0aGUgaWRsZSBzd2VlcCBhbmRcbiAqIHRoZSBkZWJvdW5jZWQgc25hcHNob3Qg4oCUIGFuZCByZXR1cm4gdGhlIGZ1bmN0aW9uIHRoYXQgc3RvcHMgYm90aC5cbiAqXG4gKiBUaGV5IGFyZSBPTkUgY2FsbCBiZWNhdXNlIHRoZXkgaGF2ZSBhbHdheXMgYmVlbiBvbmUgbGlmZXRpbWU6IGV2ZXJ5IGNvcHlcbiAqIGNsZWFyZWQgYm90aCBpbiB0aGUgc2FtZSB0d28gbGluZXMgYWZ0ZXIgYGF3YWl0IGRvbmVgLCBhbmQgdGhlIHBhaXIgdGhhdCBnZXRzXG4gKiBmb3Jnb3R0ZW4gaXMgdGhlIHBhaXIgd2hvc2UgdGltZXJzIGtlZXAgYSBwcm9jZXNzIGFsaXZlIGFmdGVyIHRlYXJkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRIb3VzZWtlZXBpbmcob3B0czogSG91c2VrZWVwaW5nT3B0aW9ucyk6ICgpID0+IHZvaWQge1xuICBjb25zdCB0aWNrTXMgPSBvcHRzLnRpY2tNcyA/PyAyNTA7XG4gIGNvbnN0IHNuYXBzaG90TXMgPSBvcHRzLnNuYXBzaG90TXMgPz8gMTAwMDtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcHRzLnN1YnNjcmliZXJDb3VudCgpO1xuICAgIGlmIChzdWJzY3JpYmVycyA+IDApIG9wdHMudG91Y2goKTtcbiAgICBpZiAoc2hvdWxkSWRsZUNsb3NlKHN1YnNjcmliZXJzLCBvcHRzLmlkbGVNcygpLCBvcHRzLnRpbWVvdXRNcykpIG9wdHMub25JZGxlQ2xvc2UoKTtcbiAgfSwgdGlja01zKTtcblxuICBjb25zdCBzbmFwID0gb3B0cy5zbmFwc2hvdDtcbiAgY29uc3Qgc25hcFRpbWVyID0gc25hcFxuICAgID8gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoIXNuYXAuZGlydHkoKSkgcmV0dXJuO1xuICAgICAgICBzbmFwLmNsZWFyKCk7XG4gICAgICAgIHZvaWQgc25hcC53cml0ZSgpO1xuICAgICAgfSwgc25hcHNob3RNcylcbiAgICA6IG51bGw7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBjbGVhckludGVydmFsKGlkbGVUaW1lcik7XG4gICAgaWYgKHNuYXBUaW1lciAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChzbmFwVGltZXIpO1xuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERyYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgYm91bmQgc2VydmVyLiBUeXBlZCBzdHJ1Y3R1cmFsbHkgc28gdGhlIGtpdCBzdGF5cyBmcmVlIG9mIGBidW5gLiAqL1xuICBzZXJ2ZXI6IHsgc3RvcChjbG9zZUFjdGl2ZUNvbm5lY3Rpb25zPzogYm9vbGVhbik6IHVua25vd24gfTtcbiAgLyoqIExpdmUgU1NFIHRhaWxzOyBldmVyeSByZWdpc3RlcmVkIGNsb3NlciBpcyBpbnZva2VkLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIExpdmUgV2ViU29ja2V0cy4gKi9cbiAgc29ja2V0cz86IEl0ZXJhYmxlPHsgY2xvc2UoKTogdm9pZCB9PjtcbiAgLyoqIEhvdyBsb25nIHF1ZXVlZCBmcmFtZXMgZ2V0IHRvIGZsdXNoIGJlZm9yZSBhbnl0aGluZyBpcyBjbG9zZWQuICovXG4gIGdyYWNlTXM/OiBudW1iZXI7XG4gIC8qKiBIb3cgbG9uZyB0aGUgZ3JhY2VmdWwgc3RvcCBnZXRzIGJlZm9yZSB0ZWFyZG93biBwcm9jZWVkcyByZWdhcmRsZXNzLiAqL1xuICBzdG9wTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvc2UgZXZlcnkgaGVsZCBjb25uZWN0aW9uIGFuZCBzdG9wIHRoZSBzZXJ2ZXIsIGluIGJvdW5kZWQgdGltZS5cbiAqXG4gKiDim5QgKipUSEUgR1JBQ0UgUEVSSU9EIElTIE5PVCBQT0xJVEVORVNTLioqIEEgYGNsb3NlZGAgZnJhbWUgZW1pdHRlZCBhbmQgdGhlblxuICogZm9sbG93ZWQgaW1tZWRpYXRlbHkgYnkgYW4gYWdncmVzc2l2ZSBgc2VydmVyLnN0b3AodHJ1ZSlgIGlzIGEgZnJhbWUgdGhlXG4gKiBjbGllbnQgbmV2ZXIgc2VlcyDigJQgdGhlIHF1ZXVlIGdvZXMgd2l0aCB0aGUgc29ja2V0LiBUaGUgMTUwIG1zIGlzIHdoYXQgdHVybnNcbiAqIFwidGhlIGRhZW1vbiB0b2xkIHlvdSB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24sIGFuZCBldmVyeVxuICogb25lIG9mIHRoZSBlaWdodCBkYWVtb25zIGNvbnZlcmdlZCBvbiB0aGF0IG51bWJlciBpbmRlcGVuZGVudGx5LlxuICpcbiAqIOKblCAqKkFORCBUSEUgU1RPUCBJUyBSQUNFRCwgQkVDQVVTRSBBIFNMT1cgU09DS0VUIE1VU1QgTk9UIEJFIEFCTEUgVE8gSEFOR1xuICogVEVBUkRPV04uKiogYHNlcnZlci5zdG9wKHRydWUpYCBhd2FpdHMgaXRzIGNvbm5lY3Rpb25zOyBvbmUgd2VkZ2VkIHBlZXIgaXNcbiAqIGVub3VnaCB0byBwYXJrIGl0IGZvcmV2ZXIsIHdoaWNoIGlzIGhvdyBhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZS5cbiAqXG4gKiDimqAgKipXSEFUIElTIERFTElCRVJBVEVMWSBOT1QgSEVSRTogYm91bnR5J3Mgc2h1dGRvd24gd2F0Y2hkb2cuKiogQm91bnR5IGFybXNcbiAqIGEgUkVGJ2QgYHNldFRpbWVvdXRgIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgaWYgdGVhcmRvd24gZG9lcyBub3QgZmluaXNoLFxuICogYW5kIHRoZSBjZW5zdXMgaXMgcmlnaHQgdGhhdCBpdCBpcyB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsXG4gKiB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIEl0IGJlbG9uZ3MgdG8gYm91bnR5J3MgVEVBUkRPV04g4oCUIHRoZSBzdHJldGNoIHdoZXJlXG4gKiBub3RoaW5nIGJvdW5kcyB3aGF0IGlzIGJlaW5nIHdhaXRlZCBvbi4g4puUICoqVEhJUyBQQVJBR1JBUEggU0FJRCBcIlNJR05BTFxuICogUEFUSFwiIFVOVElMIEQ1MywgQU5EIFRIRSBDT0RFIEFHUkVFRCBXSVRIIElULCBXSElDSCBXQVMgVEhFIERFRkVDVC4qKiBCb3VudHlcbiAqIGhhcyBGT1VSIHdheXMgaW50byBvbmUgdGVhcmRvd24gKGEgc2lnbmFsLCBhIGBjbG9zZWAgdmVyYiwgdGhlIGJyb3dzZXInc1xuICogY2xvc2Ugb3ZlciB0aGUgV2ViU29ja2V0LCBhbiBpZGxlIHRpbWVvdXQpIGFuZCBvbmx5IHRoZSBzaWduYWwgb25lIGFybWVkIHRoZVxuICogdGltZXIsIHdoaWxlIHRoZSBjb21tZW50IGFib3ZlIGl0IGNsYWltZWQgdGhlIGVuZGluZyB3YXMgdW5jb25kaXRpb25hbC5cbiAqIERyaXZlbiB3aXRoIGEgcGxhbnRlZCBoYW5nOiB0aGUgb3RoZXIgdGhyZWUgcmFuIHBhc3QgMTAgcywgdGhlIGlkbGUgb25lXG4gKiBpbmNsdWRlZCDigJQgdGhlIG9ycGhhbi1kYWVtb24gY2xhc3MgdGhlIDIzLW1pbnV0ZSBoYW5nIGNhbWUgZnJvbS4gVGhlIGFybWluZ1xuICogbm93IGxpdmVzIGluIHRoZSBSRVNPTFZFIHRoYXQgYWxsIGZvdXIgZW50cmllcyBwYXNzIHRocm91Z2guICoqVGhlIGxlc3NvbiBmb3JcbiAqIGFuIGFkb3B0ZXIgaXMgdGhlIGNvdW50LCBub3QgdGhlIHBsYWNlbWVudDogZW51bWVyYXRlIGV2ZXJ5IGVudHJ5IGludG8gdGhlXG4gKiB0ZWFyZG93biBiZWZvcmUgeW91IGJlbGlldmUgYSBndWFyYW50ZWUgY292ZXJzIGl0LioqIFRoZSB0d29cbiAqIGRhZW1vbnMgYWRvcHRpbmcgdGhpcyBtb2R1bGUgcmVnaXN0ZXIgbm8gc2lnbmFsIGhhbmRsZXJzLCBhbmQgdGhlaXIgd2hvbGVcbiAqIHRlYXJkb3duIGlzIGJvdW5kZWQgYnkgdGhlIHR3byBudW1iZXJzIGFib3ZlOyBhZGRpbmcgYW4gZXhpdCBoZXJlIHdvdWxkIHB1dFxuICogdGhlIGhvdXNlJ3Mgb25seSB1bmNvbmRpdGlvbmFsIGBwcm9jZXNzLmV4aXRgIGluc2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBpc1xuICogYWJvdXQgdG8gYnVuZGxlLCBvbmUgcGhhc2UgYWZ0ZXIgRDggdG9vayBleGFjdGx5IHRoYXQgaGF6YXJkIE9VVCBvZiBgZGllYC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFTlRFTkNFIFRIQVQgVVNFRCBUTyBFTkQgVEhBVCBQQVJBR1JBUEggV0FTIEEgUFJFRElDVElPTiwgV0hJQ0hcbiAqIEJPVU5UWSdTIE9XTiBQT1JUIEZBTFNJRklFRC4qKiBJdCByZWFkOiBcIndoZW4gYSBzcGVsbCB3aXRoIGEgc2lnbmFsIHBhdGhcbiAqIGFkb3B0cyB0aGlzLCB0aGUgd2F0Y2hkb2cgYXJyaXZlcyBhcyBhbiBvcHRpb24gb24gdGhlc2UgYXJndW1lbnRzIGFuZCB0aGVcbiAqIHJlYXNvbmluZyBpcyBhbHJlYWR5IHdyaXR0ZW4gZG93bi5cIiBib3VudHkgYWRvcHRlZCBgZHJhaW5BbmRTdG9wYCBvblxuICogMjAyNi0wOS0wOSAoUGhhc2UgNCkgYW5kIHRoZSBvcHRpb24gd2FzIE5PVCBhZGRlZCwgYmVjYXVzZSB0aGUgd2luZG93IGlzXG4gKiB3cm9uZy4gKipBIGB3YXRjaGRvZ01zYCBvbiB0aGVzZSBhcmd1bWVudHMgd291bGQgYXJtIGF0IERSQUlOIHRpbWU7IGJvdW50eSdzXG4gKiBhcm1zIGF0IFNJR05BTCB0aW1lKiosIGFuZCB0aGUgd2hvbGUgcmVhc29uIGl0IGV4aXN0cyBpcyB0aGUgc3RyZXRjaCBCRVRXRUVOXG4gKiB0aG9zZSB0d28gcG9pbnRzIOKAlCBgYXdhaXQgZG9uZWAsIGFuIGZzIGFwcGVuZCB0byB0aGUgZGFlbW9uIGxvZywgYSBmdWxsXG4gKiBzbmFwc2hvdCB3cml0ZSB0aGF0IGNhbiByb3RhdGUgYW5kIENPUFkgYSBiYWNrdXAgb2YgYSBsYXJnZSBib2FyZCwgYSBgY2xvc2VkYFxuICogZnJhbWUgYW5kIGEgYnJvYWRjYXN0LiBgZHJhaW5BbmRTdG9wYCdzIG93biBib2R5IGlzIGFscmVhZHkgYm91bmRlZCBieSB0aGUgdHdvXG4gKiBudW1iZXJzIGFib3ZlLCBzbyBhIHdhdGNoZG9nIHNjb3BlZCB0byBpdCB3b3VsZCBndWFyZCB0aGUgb25lIHN0cmV0Y2ggdGhhdFxuICogY2Fubm90IGhhbmcgYW5kIGFiYW5kb24gdGhlIHN0cmV0Y2ggdGhhdCBjYW46IGl0IHdvdWxkIFJFQUQgYXMgYWRvcHRpb24gYW5kXG4gKiBCRSBhIG5hcnJvd2luZyBvZiB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gVGhlXG4gKiAyMy1taW51dGUgaGFuZyB0aGlzIHByb2plY3Qga2VlcHMgY2l0aW5nIGhhcHBlbmVkIGluIHRoZSB1bmJvdW5kZWQgc3RyZXRjaC5cbiAqXG4gKiDimqAgKipTTyBUSEUgUlVMRSBGT1IgVEhFIE5FWFQgU1BFTEwsIFdISUNIIElTIFRIRSBUUkFOU0ZFUkFCTEUgSEFMRjoqKiB0aGVcbiAqIHF1ZXN0aW9uIGlzIG5ldmVyIFwiZG9lcyB0aGlzIG1vZHVsZSBoYXZlIGEgcGxhY2UgdG8gcHV0IGEgd2F0Y2hkb2dcIiBidXRcbiAqIFwiZG9lcyB0aGUgd2F0Y2hkb2cncyB3aW5kb3cgY29pbmNpZGUgd2l0aCB0aGlzIG1vZHVsZSdzXCIuIFdoZXJlIGEgc3BlbGwnc1xuICogdGVhcmRvd24gaGFzIHVuYm91bmRlZCB3b3JrIEJFRk9SRSB0aGUgZHJhaW4sIHRoZSB3YXRjaGRvZyBiZWxvbmdzIGF0IHRoZVxuICogc3BlbGwsIHdyYXBwZWQgYXJvdW5kIGFsbCBvZiBpdCDigJQgYW5kIGFyb3VuZCBFVkVSWSBXQVkgSU4sIHdoaWNoIGlzIHRoZSBoYWxmXG4gKiBENTMgaGFkIHRvIHJlcGFpciBhZnRlciB0aGlzIGhlYWRlciB3YXMgd3JpdHRlbi4gSWYgYSBzcGVsbCBldmVyIGFwcGVhcnMgd2hvc2Ugc2lnbmFsIHBhdGhcbiAqIGVudGVycyBgZHJhaW5BbmRTdG9wYCBpbW1lZGlhdGVseSwgYWRkIHRoZSBvcHRpb24gVEhFTiDigJQgYW5kIHRoZSBvcHRpb24gbXVzdFxuICogdGFrZSBhbiBgb25FeHBpcmVgIGNhbGxiYWNrIHJhdGhlciB0aGFuIGV4aXRpbmcsIHNvIHRoZSBgcHJvY2Vzcy5leGl0YCBzdGF5c1xuICogb3V0c2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBidW5kbGVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZHJhaW5BbmRTdG9wKG9wdHM6IERyYWluT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBncmFjZU1zID0gb3B0cy5ncmFjZU1zID8/IDE1MDtcbiAgY29uc3Qgc3RvcE1zID0gb3B0cy5zdG9wTXMgPz8gMjAwO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIGdyYWNlTXMpKTtcblxuICBpZiAob3B0cy5jbGllbnRzKSB7XG4gICAgZm9yIChjb25zdCBjbGllbnQgb2YgWy4uLm9wdHMuY2xpZW50c10pIGNsaWVudC5jbG9zZSgpO1xuICB9XG4gIGlmIChvcHRzLnNvY2tldHMpIHtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIFsuLi5vcHRzLnNvY2tldHNdKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgUHJvbWlzZS5yZXNvbHZlKG9wdHMuc2VydmVyLnN0b3AodHJ1ZSkpLFxuICAgIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHN0b3BNcykpLFxuICBdKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKlxuICog4pSA4pSAIEFORCBcIldIRVRIRVIgSVQgTUFZIEJFIFJFQURcIiBJUyBOT1cgQSBXSElURUxJU1Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRXh0cmFjdGVkIHdpdGggdGhyZWUgZ3VhcmRzIChlbXB0eSAvIGAuLmAgLyBuZXN0ZWQpIGFuZCBgZXhpc3RzU3luY2AgZm9yIHRoZVxuICogcmVzdCwgd2hpY2ggd2FzIHRydWUgb2YgYSBgZGlzdC9gIHRoYXQgaGVsZCBvbmx5IGEgc3VyZmFjZS4gUGhhc2UgMWIgcHV0IGV2ZXJ5XG4gKiBkYWVtb24ncyBCVU5ETEUgaW4gdGhhdCBzYW1lIGRpcmVjdG9yeSwgYW5kIGFsbCBmaXZlIGFkb3B0ZXJzIHNlcnZlZCBpdDpcbiAqIGAvY2xpLmpzYCwgYC9zZXJ2ZXIuanNgLCBgL2pvaW4uanNgIGF0IDIwMCwgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGNvbW1pdHRlZFxuICogYXJ0aWZhY3RzLCBlbWJlZGRlZCBzb3VyY2VtYXBzIGFuZCBhbGwuIGBzZXJ2ZUZyb21EaXN0YCBub3cgc2VydmVzIG9ubHkgd2hhdCB0aGVcbiAqIGJ1aWx0IGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgbGlua3Mg4oCUIHNlZSBgc3VyZmFjZVdoaXRlbGlzdGAgYmVsb3csIHdoaWNoIGlzXG4gKiB0aGUgc2hhcGUgZGlnZXN0aWZ5IHByb3ZlZCBsb2NhbGx5IGluIGBkOGNiYWZmYCBhbmQgdGhpcyBpcyBpdHMgb25lIGVkaXQgZm9yXG4gKiBmaXZlIHNwZWxscy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKblCBBTkQgYGV4aXN0c1N5bmNgIElTIE5PIExPTkdFUiBUSEUgUEVSTUlTU0lPTi4gQSBmaWxlIHVuZGVyIGBkaXN0RGlyYCBpc1xuICogc2VydmVkIG9ubHkgaWYgaXQgaXMgaW4gYHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcilgIOKAlCB3aGF0IHRoZSBidWlsdFxuICogYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBMSU5LUy4gYGRpc3QvYCBzdG9wcGVkIGJlaW5nIGEgc3VyZmFjZSBkaXJlY3RvcnlcbiAqIHdoZW4gdGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgYnVpbHQgdGhlIGRhZW1vbnMgaW50byBpdCwgYW5kIHRoZSBndWFyZHMgYWJvdmVcbiAqIGRvIG5vdCBkaXN0aW5ndWlzaCBgaW5kZXgtPGhhc2g+LmpzYCBmcm9tIGBzZXJ2ZXIuanNgLiBSZWFkIHRoYXQgZnVuY3Rpb24nc1xuICogaGVhZGVyIGJlZm9yZSB0b3VjaGluZyB0aGlzIGxpbmU7IHRoZSB3aGl0ZWxpc3QgaXMgdGhlIGRlZmVuY2UuXG4gKlxuICog4pqgIFRoZSBuZXN0aW5nIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwnc1xuICogb3duIHJvdXRlczogbWFncGllLCBib3VudHksIGdsYW1vdXIgYW5kIGltYWdvIGVhY2ggaGF2ZSBhbiBgL2Fzc2V0cy88bmFtZT5gXG4gKiByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXMgcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW5cbiAqIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3byBmaWdodGluZy4gVGhlIHdoaXRlbGlzdCBnb3Zlcm5zIGBkaXN0L2AgcmVhZHMgT05MWVxuICog4oCUIGl0IG5ldmVyIHNlZXMgdGhvc2Ugcm91dGVzIGFuZCBtdXN0IG5ldmVyIGJlIHdpZGVuZWQgaW50byB0aGVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmICghc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKS5oYXMocmVsKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG5cbi8qKiBgc3JjYC9gaHJlZmAgdmFsdWVzIGluIGEgYnVpbHQgZW50cnkgZG9jdW1lbnQsIGAuL2AtcHJlZml4ZWQgb3IgYmFyZS4gKi9cbmNvbnN0IEVOVFJZX1JFRl9SRSA9IC8oPzpzcmN8aHJlZilcXHMqPVxccypcIig/OlxcLlxcLyk/KFteXCJdKylcIi9nO1xuXG4vKiogQSBgLi9gLVBSRUZJWEVEIHNpYmxpbmcgc3BlY2lmaWVyIOKAlCBgXCIuL25hbWVcImAsIGAnLi9uYW1lJ2AsIGAoLi9uYW1lKWAg4oCUIHdoaWNoXG4gKiAgaXMgdGhlIG9ubHkgc2hhcGUgYSBidW5kbGVyIGVtaXRzIGZvciBhIHNpYmxpbmcgY2h1bmsuIFJlcXVpcmluZyB0aGUgYC4vYCBpc1xuICogIHdoYXQga2VlcHMgYSBzdHJpbmcgbGl0ZXJhbCB0aGF0IG1lcmVseSBTQVlTIGBjbGkuanNgIG91dCBvZiB0aGUgc2V0LiAqL1xuY29uc3QgUkVMQVRJVkVfUkVGX1JFID0gL1tcIicoXVxcLlxcLyhbXlwiJygpXFxzXSspW1wiJyldL2c7XG5cbi8qKiBPbmx5IHRleHQgdGhlIGJ1aWxkIGVtaXRzIGFzIHN1cmZhY2UgY29kZSBpcyBzY2FubmVkIGZvciBvbndhcmQgcmVmZXJlbmNlcy5cbiAqICBBIGAucG5nYCBpcyBhIGxlYWY7IG9wZW5pbmcgaXQgd291bGQgYmUgcmVhZGluZyBhIGJpbmFyeSBmb3IgZmlsZW5hbWVzLiAqL1xuY29uc3QgVFJBTlNJVElWRV9FWFRTID0gW1wiLmpzXCIsIFwiLmNzc1wiXTtcblxuLyoqIE9uZSBkZXJpdmF0aW9uIHBlciBgZGlzdC9gLCBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3Mg4oCUIGBkaXN0L2AgaXMgYSBidWlsZFxuICogIGFydGlmYWN0IGFuZCBkb2VzIG5vdCBjaGFuZ2UgdW5kZXIgYSBydW5uaW5nIGRhZW1vbi4gS2V5ZWQgYnkgZGlyZWN0b3J5IHNvXG4gKiAgdHdvIGRhZW1vbnMgaW4gb25lIHByb2Nlc3MgKGFuZCBldmVyeSB0ZXN0IHdpdGggaXRzIG93biB0ZW1wIHRyZWUpIHN0YXlcbiAqICBpbmRlcGVuZGVudC4gKi9cbmNvbnN0IHdoaXRlbGlzdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+KCk7XG5cbmZ1bmN0aW9uIHJlZnNJbih0ZXh0OiBzdHJpbmcsIHJlOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIHJldHVybiAoXG4gICAgWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgICAgLm1hcCgoWywgcmVmXSkgPT4gcmVmKVxuICAgICAgLy8gQSBUWVBFIFBSRURJQ0FURSwgYW5kIGhvbmVzdCBvbmx5IGJlY2F1c2UgaXRzIGZpcnN0IGNsYXVzZSB3YXMgYWxyZWFkeVxuICAgICAgLy8gaGVyZTogYCEhcmVmYCBpcyB0aGUgcnVudGltZSBjaGVjayB0aGF0IG1ha2VzIGByZWYgaXMgc3RyaW5nYCB0cnVlICh0aGVcbiAgICAgIC8vIEZFTEwgc2VudGVuY2UncyBwcmVkaWNhdGUgcm91dGUsIHRha2VuIHdpdGggaXRzIGNsYXVzZSDigJQgdHlwZS1kZWJ0IFQzNikuXG4gICAgICAuZmlsdGVyKFxuICAgICAgICAocmVmKTogcmVmIGlzIHN0cmluZyA9PlxuICAgICAgICAgICEhcmVmICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiLi5cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiOlwiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCI/XCIpLFxuICAgICAgKVxuICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICByZW5hbWVTeW5jLFxuICBzdGF0U3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHR5cGUge1xuICBDaGF0TWVzc2FnZSxcbiAgQ2hhdFdobyxcbiAgQ29udGV4dEVudHJ5LFxuICBEb2NWaWV3LFxuICBQdWJsaWNTdGF0ZSxcbiAgU2VsZWN0aW9uLFxuICBWZXJzaW9uLFxuICBWZXJzaW9uQXV0aG9yLFxufSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuaW1wb3J0IHsgZW50cnlGb3JQYXRoLCBpc0RvY05hbWUsIGxvY2F0ZSwgc2NhblRyZWUgfSBmcm9tIFwiLi90cmVlXCI7XG5cbmV4cG9ydCBjb25zdCBNQU5JRkVTVF9GT1JNQVQgPSAxO1xuXG50eXBlIERvY1JlY29yZCA9IHtcbiAgc2x1Zzogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIG9yaWdpbmFsOiBzdHJpbmc7XG4gIGVudHJ5SWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlbDogc3RyaW5nIHwgbnVsbDtcbiAgZXh0OiBzdHJpbmc7XG4gIHZlcnNpb25zOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPltdO1xuICBhY3RpdmU6IG51bWJlcjtcbiAgLyoqIEhhc2ggb2YgdGhlIG9yaWdpbmFsIGFzIHdlIGxhc3QgcmVhZCBvciB3cm90ZSBpdCDigJQgYXQgb3Blbiwgc2F2ZSwgcmV2ZXJ0XG4gICAqICBhbmQgcmVsb2FkIOKAlCBzbyBhIHJlc3RvcmUgY2FuIHRlbGwgdGhhdCBpdCBjaGFuZ2VkIHdoaWxlIG5vIGRhZW1vbiB3YXNcbiAgICogIHdhdGNoaW5nICh2ZXJpZnktcGFzcyBmaXggMikuICovXG4gIG9yaWdpbmFsSGFzaDogc3RyaW5nO1xuICAvKiogU2V0IG9ubHkgYnkgYG9wZW5QYXRoYCwgd2hpY2ggYWRtaXRzIGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqICBlbnRyeS4gYHNhdmVgIHdyaXRlcyBubyBvcmlnaW5hbCB0aGF0IGxhY2tzIGl0ICh2ZXJpZnktcGFzcyBmaXggMWMpLiAqL1xuICBhZG1pdHRlZD86IGJvb2xlYW47XG4gIG91dHNpZGVDaGFuZ2VkOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIGZvcm1hdDogbnVtYmVyO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGNvbnRleHQ6IENvbnRleHRFbnRyeVtdO1xuICBkb2NzOiBEb2NSZWNvcmRbXTtcbiAgb3BlbkRvYzogc3RyaW5nIHwgbnVsbDtcbiAgY2hhdDogQ2hhdE1lc3NhZ2VbXTtcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBBIHBhdGgncyByZWFscGF0aCwgb3IgdGhlIHBhdGggaXRzZWxmIHdoZW4gaXQgY2Fubm90IGJlIHJlc29sdmVkIChnb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFsT3IocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcDtcbiAgfVxufVxuXG4vKiogV2hhdCBhIHdhdGNoZXIgZXZlbnQgdHVybmVkIG91dCB0byBiZS4gYG51bGxgID0gbm90aGluZyAob3Vycywgb3Igbm8gY2hhbmdlKS4gKi9cbmV4cG9ydCB0eXBlIEZpbGVFdmVudCA9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IGFjdGl2ZTogZmFsc2UgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIjtcbiAgICAgIGRvYzogc3RyaW5nO1xuICAgICAgdmVyc2lvbjogbnVtYmVyO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgLyoqIFRoZSBuZXcgYWdlbnQgdmVyc2lvbiB0aGUgb3V0c2lkZSB0ZXh0IHdhcyBwcmVzZXJ2ZWQgYXMuICovXG4gICAgICBwcmVzZXJ2ZWRBczogbnVtYmVyO1xuICAgICAgcHJlc2VydmVkUGF0aDogc3RyaW5nO1xuICAgIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGFzIHRoZSBkYWVtb24gbGFzdCB3cm90ZSAob3IgYWRvcHRlZClcbiAgICogIGl0IOKAlCB3aGF0IGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIHJldmVydGVkIHRvLiAqL1xuICBwcml2YXRlIGxhc3RBY3RpdmVUZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFdoYXQgYSByZXN0b3JlIGZvdW5kIGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLiAqL1xuICByZXN0b3JlRmluZGluZ3M6IHsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IG1pc3Npbmc6IGJvb2xlYW4gfVtdID0gW107XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCkpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIGNvbnN0IHRleHQgPSBleGlzdHNTeW5jKHApID8gcmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSA6IFwiXCI7XG4gICAgICBzLmFkb3B0QWN0aXZlKGQsIHRleHQpO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAyOiBhbiBvcmlnaW5hbCBjaGFuZ2VkIHdoaWxlIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWRcbiAgICAgIC8vIHdhcyBpbnZpc2libGUgaGVyZSwgc28gdGhlIG5leHQgU2F2ZSBvdmVyd3JvdGUgaXQgdW5hbm5vdW5jZWQuIFRoZVxuICAgICAgLy8gbWFuaWZlc3QgaG9sZHMgdGhlIG9yaWdpbmFsJ3MgaGFzaCBhcyBvZiB0aGUgbGFzdCBvcGVuL3NhdmUvcmV2ZXJ0L1xuICAgICAgLy8gcmVsb2FkOyBhIGRpZmZlcmVudCBoYXNoIG5vdyBpcyBhbiBvdXRzaWRlIGNoYW5nZSwgbWFya2VkIGV4YWN0bHkgYXMgYVxuICAgICAgLy8gbGl2ZSBvbmUgd2l0aCBhIGRpcnR5IGJ1ZmZlciBpcyDigJQgYXNrZWQsIG5ldmVyIG1lcmdlZCBvciByZWxvYWRlZC5cbiAgICAgIGxldCBub3c6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbm93ID0gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbm93ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChub3cgPT09IG51bGwgfHwgbm93ICE9PSBkLm9yaWdpbmFsSGFzaCkge1xuICAgICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgcy5yZXN0b3JlRmluZGluZ3MucHVzaCh7IGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCwgbWlzc2luZzogbm93ID09PSBudWxsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocy5yZXN0b3JlRmluZGluZ3MubGVuZ3RoID4gMCkgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGVhY2ggZW50cnkgcm9vdCxcbiAgICogYW5kIHRoZSBSRUFMIGRpcmVjdG9yeSBvZiBldmVyeSBvcGVuZWQgb3JpZ2luYWwuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMzogZWFjaCByb290IGlzIHdhdGNoZWQgYXQgaXRzIFJFQUxQQVRIIChgd2F0Y2hgKSwgYW5kXG4gICAqIGFuIGV2ZW50IGlzIHJlcG9ydGVkIHVuZGVyIHRoZSBwYXRoIGZvcm0gdGhlIHNlc3Npb24gc3RvcmVzIChgcGF0aGApLiBBXG4gICAqIHdhdGNoIG9uIGEgc3ltbGlua2VkIGRpcmVjdG9yeSDigJQgYSBzeW1saW5rZWQgaG9tZSwgYSBzeW1saW5rZWQgZm9sZGVyXG4gICAqIGVudHJ5IOKAlCBvciBvbiB0aGUgbGluaydzIG93biBkaXJlY3RvcnkgZm9yIGEgc3ltbGlua2VkIG9yaWdpbmFsIHNhd1xuICAgKiBub3RoaW5nIHdoZW4gdGhlIFRBUkdFVCBjaGFuZ2VkIChGU0V2ZW50cyByZXBvcnRzIHJlYWwgcGF0aHMpLiBBIHN5bWxpbmtlZFxuICAgKiBvcmlnaW5hbCBpcyBtYXRjaGVkIGJhY2sgdG8gaXRzIGRvYyBieSByZWFscGF0aCBpbiBgb25GaWxlRXZlbnRgLlxuICAgKi9cbiAgd2F0Y2hSb290cygpOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSB7XG4gICAgY29uc3Qgcm9vdHM6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdID0gW1xuICAgICAgeyBwYXRoOiB0aGlzLmRvY3NEaXIsIHdhdGNoOiByZWFsT3IodGhpcy5kb2NzRGlyKSwgcmVjdXJzaXZlOiB0cnVlIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICByb290cy5wdXNoKHtcbiAgICAgICAgcGF0aDogZS5yb290LFxuICAgICAgICB3YXRjaDogcmVhbE9yKGUucm9vdCksXG4gICAgICAgIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsXG4gICAgICAgIGVudHJ5SWQ6IGUuaWQsXG4gICAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBkaXJuYW1lKHJlYWxPcihkLm9yaWdpbmFsKSk7XG4gICAgICBpZiAoXG4gICAgICAgICFyb290cy5zb21lKChyKSA9PiByLndhdGNoID09PSByZWFsRGlyICYmIHIucmVjdXJzaXZlID09PSBmYWxzZSkgJiZcbiAgICAgICAgIXJvb3RzLnNvbWUoXG4gICAgICAgICAgKHIpID0+IHIucmVjdXJzaXZlICYmIChyZWFsRGlyID09PSByLndhdGNoIHx8IHJlYWxEaXIuc3RhcnRzV2l0aChyLndhdGNoICsgc2VwKSksXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgcm9vdHMucHVzaCh7IHBhdGg6IHJlYWxEaXIsIHdhdGNoOiByZWFsRGlyLCByZWN1cnNpdmU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRvcHRBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgdGhpcy5vd25lZC5zZXQocCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBLZWVwIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFzIGEgTkVXIGFnZW50IHZlcnNpb24uICovXG4gIHByaXZhdGUgcHJlc2VydmVPdXRzaWRlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogVmVyc2lvbiB7XG4gICAgY29uc3QgbiA9IE1hdGgubWF4KC4uLmQudmVyc2lvbnMubWFwKCh2KSA9PiB2Lm4pKSArIDE7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgIGZyb206IGQuYWN0aXZlLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbGFiZWw6IGBvdXRzaWRlIHdyaXRlIHRvIHYke2QuYWN0aXZlfWAsXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH07XG4gIH1cblxuICAvKiogVHJ1ZSBpZmYgYHRleHRgIGF0IGBwYXRoYCBpcyBleGFjdGx5IHdoYXQgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIHRoZXJlLiAqL1xuICBpc093bldyaXRlKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMub3duZWQuZ2V0KHBhdGgpID09PSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb250ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZENvbnRleHQocmF3UGF0aDogc3RyaW5nKTogeyBlbnRyeTogQ29udGV4dEVudHJ5OyBhZGRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGNvbnN0IHByb2JlID0gZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApO1xuICAgIGNvbnN0IHNhbWUgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUucm9vdCA9PT0gcHJvYmUucm9vdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IHByb2JlLm1lbWJlcnNoaXAgJiZcbiAgICAgICAgKHByb2JlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiB8fFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGUubm9kZXMpID09PSBKU09OLnN0cmluZ2lmeShwcm9iZS5ub2RlcykpLFxuICAgICk7XG4gICAgaWYgKHNhbWUpIHJldHVybiB7IGVudHJ5OiBzYW1lLCBhZGRlZDogZmFsc2UgfTtcbiAgICB0aGlzLm0uY29udGV4dC5wdXNoKHByb2JlKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBwcm9iZSwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIHJlbW92ZUNvbnRleHQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGkgPSB0aGlzLm0uY29udGV4dC5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgICBpZiAoaSA8IDApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKChlKSA9PiBlLmlkKSxcbiAgICAgICk7XG4gICAgdGhpcy5tLmNvbnRleHQuc3BsaWNlKGksIDEpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgLy8gVGhlIG9wZW4gZG9jdW1lbnQgbGVmdCB0aGUgY29udGV4dCB3aXRoIGl0cyBlbnRyeTogY2xvc2UgaXQgaW4gdGhlIHZpZXcuXG4gICAgLy8gSXRzIHZlcnNpb25zIHN0YXkgaW4gdGhlIHNlc3Npb24gKG5vdGhpbmcgaXMgZGVsZXRlZCk7IHJlLWFkZGluZyB0aGVcbiAgICAvLyBlbnRyeSBhbmQgb3BlbmluZyBpdCBhZ2FpbiBmaW5kcyB0aGVtLlxuICAgIGNvbnN0IG9wZW4gPSB0aGlzLm0ub3BlbkRvYyA/IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIGlmIChvcGVuICYmIG9wZW4uZW50cnlJZCA9PT0gbnVsbCkgdGhpcy5tLm9wZW5Eb2MgPSBudWxsO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgLyoqIFJlLW1pcnJvciBhIGZvbGRlciBlbnRyeS4gUmV0dXJucyB3aGV0aGVyIGl0cyBub2RlcyBjaGFuZ2VkLiAqL1xuICByZXNjYW4oZW50cnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmIChlPy5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGUucm9vdCk7XG4gICAgY29uc3QgY2hhbmdlZCA9XG4gICAgICBKU09OLnN0cmluZ2lmeShub2RlcykgIT09IEpTT04uc3RyaW5naWZ5KGUubm9kZXMpIHx8ICEhdHJ1bmNhdGVkICE9PSAhIWUudHJ1bmNhdGVkO1xuICAgIGUubm9kZXMgPSBub2RlcztcbiAgICBpZiAodHJ1bmNhdGVkKSBlLnRydW5jYXRlZCA9IHRydWU7XG4gICAgZWxzZSBkZWxldGUgZS50cnVuY2F0ZWQ7XG4gICAgaWYgKGNoYW5nZWQpIHRoaXMucmVsaW5rKCk7XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG4gIH1cblxuICBwcml2YXRlIHJlbGluaygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBkLm9yaWdpbmFsKTtcbiAgICAgIGQuZW50cnlJZCA9IGF0Py5lbnRyeUlkID8/IG51bGw7XG4gICAgICBkLnJlbCA9IGF0Py5yZWwgPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgZG9jdW1lbnRzIGFuZCB2ZXJzaW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIHZlcnNpb25QYXRoKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRvY3NEaXIsIGQuc2x1ZywgYHYke259JHtkLmV4dH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgZG9jT3JEaWUoc2x1Zz86IHN0cmluZyk6IERvY1JlY29yZCB7XG4gICAgY29uc3Qgd2FudCA9IHNsdWcgPz8gdGhpcy5tLm9wZW5Eb2MgPz8gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGNob2ljZXMgPSB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IGQuc2x1Zyk7XG4gICAgaWYgKHdhbnQgPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJubyBkb2N1bWVudCBpcyBvcGVuIOKAlCBuYW1lIG9uZSB3aXRoIC0tZG9jXCIsIDQwOSwgY2hvaWNlcyk7XG4gICAgY29uc3QgZCA9IHRoaXMuZmluZERvYyh3YW50KTtcbiAgICBpZiAoIWQpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIGRvY3VtZW50IFwiJHt3YW50fVwiIGluIHRoaXMgc2Vzc2lvbmAsIDQwNCwgY2hvaWNlcyk7XG4gICAgcmV0dXJuIGQ7XG4gIH1cblxuICAvKiogQSBkb2MgYnkgc2x1ZywgYnkgb3JpZ2luYWwgcGF0aCwgb3IgYnkgYSB1bmlxdWUgb3JpZ2luYWwgYmFzZW5hbWUuICovXG4gIGZpbmREb2Moa2V5OiBzdHJpbmcpOiBEb2NSZWNvcmQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGJ5U2x1ZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0ga2V5KTtcbiAgICBpZiAoYnlTbHVnKSByZXR1cm4gYnlTbHVnO1xuICAgIC8vIOKblCBPTkxZIEFOIEFCU09MVVRFIGtleSBpcyBhIHBhdGggKHZlcmlmeS1wYXNzIGZpeCA4KTogcmVzb2x2aW5nIGFcbiAgICAvLyByZWxhdGl2ZSBvbmUgaGVyZSByZXNvbHZlZCBpdCBhZ2FpbnN0IHRoZSBEQUVNT04ncyBjd2QuIFRoZSBDTEkgcmVzb2x2ZXNcbiAgICAvLyBhZ2FpbnN0IGl0cyBvd24gY3dkIGFuZCBzZW5kcyBhbiBhYnNvbHV0ZSBwYXRoLlxuICAgIGlmIChpc0Fic29sdXRlKGtleSkpIHtcbiAgICAgIGNvbnN0IGJ5UGF0aCA9IHRoaXMubS5kb2NzLmZpbmQoXG4gICAgICAgIChkKSA9PiBkLm9yaWdpbmFsID09PSBrZXkgfHwgcmVhbE9yKGQub3JpZ2luYWwpID09PSByZWFsT3Ioa2V5KSxcbiAgICAgICk7XG4gICAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIH1cbiAgICBjb25zdCBieU5hbWUgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+IGJhc2VuYW1lKGQub3JpZ2luYWwpID09PSBrZXkgfHwgZC5yZWwgPT09IGtleSk7XG4gICAgcmV0dXJuIGJ5TmFtZS5sZW5ndGggPT09IDEgPyBieU5hbWVbMF0gOiB1bmRlZmluZWQ7XG4gIH1cblxuICBwcml2YXRlIHZlcnNpb25PckRpZShkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+IHtcbiAgICBjb25zdCB2ID0gZC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm4gPT09IG4pO1xuICAgIGlmICghdilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIHYke259YCxcbiAgICAgICAgNDA0LFxuICAgICAgICBkLnZlcnNpb25zLm1hcCgoeCkgPT4gYHYke3gubn1gKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHY7XG4gIH1cblxuICBwcml2YXRlIHNsdWdGb3Iob3JpZ2luYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlbSA9XG4gICAgICBiYXNlbmFtZShvcmlnaW5hbCwgZXh0bmFtZShvcmlnaW5hbCkpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOV8tXSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwiZG9jXCI7XG4gICAgbGV0IHNsdWcgPSBzdGVtO1xuICAgIGZvciAobGV0IGkgPSAyOyB0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHNsdWcpOyBpKyspIHNsdWcgPSBgJHtzdGVtfS0ke2l9YDtcbiAgICByZXR1cm4gc2x1ZztcbiAgfVxuXG4gIC8qKlxuICAgKiBPcGVuIGEgZG9jdW1lbnQgYnkgaXRzIG9yaWdpbmFsJ3MgcGF0aDogdjEgaXMgd3JpdHRlbiBmcm9tIHRoZSBvcmlnaW5hbFxuICAgKiB0aGUgZmlyc3QgdGltZS4gYGZvY3VzOiBmYWxzZWAgKHRoZSBhZ2VudCdzIGltcGxpY2l0IG9wZW4gdGhyb3VnaFxuICAgKiBgdmVyc2lvbi1uZXcgLS1kb2MgPHBhdGg+YCkgZG9lcyBub3QgbW92ZSB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IGZvY3VzPzogYm9vbGVhbiB9ID0ge30pOiB7IHNsdWc6IHN0cmluZzsgY3JlYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBmb2N1cyA9IG9wdHMuZm9jdXMgPz8gdHJ1ZTtcbiAgICAvLyBUaGUgY29udGV4dCdzIG93biBzcGVsbGluZyBvZiB0aGUgcGF0aDogYSBjYWxsZXIgd2hvc2UgY3dkIGlzIGEgcmVhbHBhdGhcbiAgICAvLyAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIG9yIHRocm91Z2ggYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgIC8vIGZpbGUgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgZG9jLlxuICAgIGNvbnN0IGFicyA9IHRoaXMuY2Fub25pY2FsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBleGlzdGluZy5zbHVnO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBzbHVnOiBleGlzdGluZy5zbHVnLCBjcmVhdGVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoIWlzRG9jTmFtZShhYnMpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgNDAwKTtcbiAgICBpZiAoIWxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Fic30gaXMgbm90IGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQg4oCUIGFkZCBpdCAob3IgaXRzIGZvbGRlcikgZmlyc3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghc3RhdFN5bmMoYWJzKS5pc0ZpbGUoKSkgdGhyb3cgbmV3IEVycm9yKFwibm90IGEgZmlsZVwiKTtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3Qgb3BlbiAke2Fic306IG5vIHN1Y2ggZmlsZWAsIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGV4dCA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdLmluY2x1ZGVzKGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpKVxuICAgICAgPyBleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKVxuICAgICAgOiBcIi5tZFwiO1xuICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpO1xuICAgIGNvbnN0IGQ6IERvY1JlY29yZCA9IHtcbiAgICAgIHNsdWc6IHRoaXMuc2x1Z0ZvcihhYnMpLFxuICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIG9yaWdpbmFsOiBhYnMsXG4gICAgICBlbnRyeUlkOiBhdD8uZW50cnlJZCA/PyBudWxsLFxuICAgICAgcmVsOiBhdD8ucmVsID8/IG51bGwsXG4gICAgICBleHQsXG4gICAgICB2ZXJzaW9uczogW3sgbjogMSwgYXV0aG9yOiBcImh1bWFuXCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9XSxcbiAgICAgIGFjdGl2ZTogMSxcbiAgICAgIG9yaWdpbmFsSGFzaDogY29udGVudEhhc2godGV4dCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZmFsc2UsXG4gICAgICBhZG1pdHRlZDogdHJ1ZSxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzLnB1c2goZCk7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZC5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgY3JlYXRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIGBhYnNgIGFzIHRoZSBjb250ZXh0IHNwZWxscyBpdCwgd2hlbiBpdCBpcyB0aGUgc2FtZSBmaWxlIGJ5IHJlYWxwYXRoLiAqL1xuICBwcml2YXRlIGNhbm9uaWNhbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKCFyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNwZWxsZWQgPSBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIHNwZWxsZWQpKSByZXR1cm4gc3BlbGxlZDtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIC8qKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDQg4oCUIENIRUNLIEJFRk9SRSBXUklURS4gQmVmb3JlIHRoZSBodW1hbidzIGVkaXQgaXNcbiAgICogd3JpdHRlbiwgdGhlIGZpbGUgb24gZGlzayBpcyBoYXNoZWQ6IGlmIGl0IGlzIG5vdCB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICogd3JpdGUsIHNvbWVvbmUgZWxzZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb24gKEUyKS4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgYVxuICAgKiBORVcgYWdlbnQgdmVyc2lvbiwgYW5kIG9ubHkgdGhlbiBpcyB0aGUgZWRpdCB3cml0dGVuLiBEZXRlY3Rpb24gdXNlZCB0b1xuICAgKiBkZXBlbmQgb24gdGhlIHdhdGNoZXIncyA2MCBtcyBzZXR0bGUgdGltZXIgZmlyaW5nIGJlZm9yZSB0aGUgbmV4dFxuICAgKiBrZXlzdHJva2U7IGEgYnVyc3Qgb2YgZWRpdHMgYXQgMzAgbXMgY2xvYmJlcmVkIGFuIG91dHNpZGUgd3JpdGVcbiAgICogdW5hbm5vdW5jZWQuIE5vdyBub3RoaW5nIGlzIGxvc3Qgd2hhdGV2ZXIgdGhlIHRpbWluZyDigJQgdGhlIG9uZSB3aW5kb3cgbGVmdFxuICAgKiBpcyB0aGUgbWljcm9zZWNvbmRzIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGlzIHdyaXRlLlxuICAgKi9cbiAgZWRpdChcbiAgICBzbHVnOiBzdHJpbmcsXG4gICAgbjogbnVtYmVyLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgKTogeyBkaXJ0eUNoYW5nZWQ6IGJvb2xlYW47IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgaWYgKG4gIT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke259IGlzIG5vdCB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9ICh2JHtkLmFjdGl2ZX0gaXMpIOKAlCBvbmx5IHRoZSBhY3RpdmUgdmVyc2lvbiBpcyBlZGl0YWJsZWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0RpcnR5KGQpO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIC8vIFRoZSBlZGl0IGlzIHN0YWdlZCBpbiBhIHNpYmxpbmcgZmlsZSBGSVJTVCwgc28gdGhlIGNoZWNrIGJlbG93IGFuZCB0aGVcbiAgICAvLyByZW5hbWUgdGhhdCBsYW5kcyB0aGUgZWRpdCBhcmUgYWRqYWNlbnQgc3lzY2FsbHM6IHRoZSB3aW5kb3cgaW4gd2hpY2ggYW5cbiAgICAvLyBvdXRzaWRlIHdyaXRlIGNvdWxkIHNsaXAgYmV0d2VlbiB0aGVtIGlzIG1pY3Jvc2Vjb25kcywgbm90IHRoZSBsZW5ndGggb2ZcbiAgICAvLyBhIG11bHRpLW1lZ2FieXRlIHdyaXRlIOKAlCBhbmQgYSB3cml0ZSBsYW5kaW5nIEFGVEVSIHRoZSByZW5hbWUgZ29lcyB0byB0aGVcbiAgICAvLyBuZXcgZmlsZSwgd2hlcmUgdGhlIHdhdGNoZXIgZmluZHMgaXQgYW5kIHByZXNlcnZlcyBpdCB0b28uXG4gICAgY29uc3Qgc3RhZ2VkID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0uZWRpdGA7XG4gICAgd3JpdGVGaWxlU3luYyhzdGFnZWQsIHRleHQpO1xuICAgIGxldCBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb25EaXNrOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgb25EaXNrID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIG9uRGlzayA9IG51bGw7XG4gICAgfVxuICAgIGlmIChvbkRpc2sgIT09IG51bGwgJiYgIXRoaXMuaXNPd25Xcml0ZShwYXRoLCBvbkRpc2spKVxuICAgICAgcHJlc2VydmVkID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgb25EaXNrKTtcbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgcmVuYW1lU3luYyhzdGFnZWQsIHBhdGgpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpLCBwcmVzZXJ2ZWQgfTtcbiAgfVxuXG4gIC8qKiBDb3B5IGEgdmVyc2lvbiB0byBhIG5ldyBmaWxlOyB0aGUgYWdlbnQgdGhlbiBlZGl0cyB0aGF0IGZpbGUgd2l0aCBpdHMgb3duIHRvb2xzLiAqL1xuICBuZXdWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBmcm9tPzogbnVtYmVyOyBsYWJlbD86IHN0cmluZzsgYXV0aG9yOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IFZlcnNpb247XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBmcm9tID0gb3B0cy5mcm9tID8/IGQuYWN0aXZlO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIGZyb20pO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBmcm9tKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IG4gPSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBvcHRzLmF1dGhvcixcbiAgICAgIGZyb20sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAuLi4ob3B0cy5sYWJlbCA/IHsgbGFiZWw6IG9wdHMubGFiZWwgfSA6IHt9KSxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIGFjdGl2YXRlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHsgc2x1Zzogc3RyaW5nOyBwcmV2aW91czogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGNvbnN0IHByZXZpb3VzID0gZC5hY3RpdmU7XG4gICAgZC5hY3RpdmUgPSBvcHRzLnZlcnNpb247XG4gICAgLy8gVGhlIG5ldyBhY3RpdmUgdmVyc2lvbidzIHRleHQgQVMgSVQgSVMgTk9XIGlzIHRoZSBiYXNlbGluZSB0aGUgbmV4dFxuICAgIC8vIGNoZWNrLWJlZm9yZS13cml0ZSBjb21wYXJlcyBhZ2FpbnN0LlxuICAgIHRoaXMuYWRvcHRBY3RpdmUoZCwgcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8qKiBTYXZlOiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IG92ZXIgdGhlIG9yaWdpbmFsLiBUaGUgT05MWSB3cml0ZSB0byBpdCAoRTcpLiAqL1xuICBzYXZlKHNsdWc6IHN0cmluZyk6IHsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWM6IFNhdmUgd3JpdGVzIG9ubHkgYW4gb3JpZ2luYWwgYWRtaXR0ZWQgYnlcbiAgICAvLyBgb3BlblBhdGhgIChhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSkuIENoZWNrZWQgYWdhaW4gaGVyZVxuICAgIC8vIHNvIG5vIG90aGVyIHBhdGggaW50byB0aGUgbWFuaWZlc3Qg4oCUIGEgaGFuZC1lZGl0ZWQgb25lLCBhIGZ1dHVyZSB2ZXJiIOKAlFxuICAgIC8vIGNhbiB0dXJuIFNhdmUgaW50byBcIndyaXRlIGFueSBmaWxlXCIuXG4gICAgaWYgKCFkLmFkbWl0dGVkIHx8ICFpc0RvY05hbWUoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gc2F2ZSAke2Qub3JpZ2luYWx9OiBpdCB3YXMgbm90IG9wZW5lZCBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgdGhpcy53cml0ZU93bmVkKGQub3JpZ2luYWwsIHRleHQpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IG9yaWdpbmFsOiBkLm9yaWdpbmFsLCB2ZXJzaW9uOiBkLmFjdGl2ZSB9O1xuICB9XG5cbiAgLyoqIFJldmVydDogdGhlIG9yaWdpbmFsJ3MgdGV4dCBiYWNrIG92ZXIgdGhlIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuICByZXZlcnQoc2x1Zzogc3RyaW5nKTogeyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHZlcnNpb246IGQuYWN0aXZlLCB0ZXh0IH07XG4gIH1cblxuICBwcml2YXRlIGlzRGlydHkoZDogRG9jUmVjb3JkKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICh0aGlzLmFjdGl2ZUhhc2guZ2V0KGQuc2x1ZykgPz8gXCJcIikgIT09IGQub3JpZ2luYWxIYXNoO1xuICB9XG5cbiAgLy8g4pSA4pSAIHRoZSB3YXRjaGVyJ3MgcXVlc3Rpb246IHdob3NlIHdyaXRlIHdhcyB0aGF0PyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ2xhc3NpZnkgb25lIGZpbGVzeXN0ZW0gZXZlbnQuIFJlYWRzIHRoZSBmaWxlOyByZXR1cm5zIGBudWxsYCB3aGVuIGl0IGlzXG4gICAqIHRoZSBkYWVtb24ncyBvd24gd3JpdGUsIHVuY2hhbmdlZCwgZ29uZSwgb3Igbm90IG91cnMgdG8gY2FyZSBhYm91dC5cbiAgICovXG4gIG9uRmlsZUV2ZW50KGFiczogc3RyaW5nKTogRmlsZUV2ZW50IHwgbnVsbCB7XG4gICAgLy8gQSB2ZXJzaW9uIGZpbGUgdW5kZXIgZG9jcy88c2x1Zz4vdk4uZXh0P1xuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLmRvY3NEaXIgKyBzZXApKSB7XG4gICAgICBjb25zdCByZXN0ID0gYWJzLnNsaWNlKHRoaXMuZG9jc0Rpci5sZW5ndGggKyAxKS5zcGxpdChzZXApO1xuICAgICAgaWYgKHJlc3QubGVuZ3RoICE9PSAyKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IFtzbHVnLCBmaWxlXSA9IHJlc3QgYXMgW3N0cmluZywgc3RyaW5nXTtcbiAgICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4LnNsdWcgPT09IHNsdWcpO1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXnYoXFxkKykoXFwuW2Etel0rKSQvLmV4ZWMoZmlsZSk7XG4gICAgICBpZiAoIWQgfHwgIW1hdGNoIHx8IG1hdGNoWzJdICE9PSBkLmV4dCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBuID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuaXNPd25Xcml0ZShhYnMsIHRleHQpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghZC52ZXJzaW9ucy5zb21lKCh2KSA9PiB2Lm4gPT09IG4pKSB7XG4gICAgICAgIC8vIFRoZSBhZ2VudCB3cm90ZSBhIHZlcnNpb24gZmlsZSBieSBoYW5kIHJhdGhlciB0aGFuIHRocm91Z2hcbiAgICAgICAgLy8gYHZlcnNpb24tbmV3YCDigJQgYWRvcHQgaXQgcmF0aGVyIHRoYW4gbGVhdmUgYSBmaWxlIHRoZSBzdXJmYWNlIGNhbm5vdCBzZWUuXG4gICAgICAgIGQudmVyc2lvbnMucHVzaCh7IG4sIGF1dGhvcjogXCJhZ2VudFwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgICAgIGQudmVyc2lvbnMuc29ydCgoYSwgYikgPT4gYS5uIC0gYi5uKTtcbiAgICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgcGF0aDogYWJzIH07XG4gICAgICB9XG4gICAgICBpZiAobiA9PT0gZC5hY3RpdmUpIHtcbiAgICAgICAgLy8gRTIsIHJlZnVzZWQgYW5kIFJFLUxBQkVMTEVEOiB0aGUgb3V0c2lkZSB0ZXh0IGJlY29tZXMgYSBuZXcgYWdlbnRcbiAgICAgICAgLy8gdmVyc2lvbiwgYW5kIHRoZSBhY3RpdmUgdmVyc2lvbiBnb2VzIGJhY2sgdG8gdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAgICAgIC8vIHRleHQg4oCUIHNvIHRoZSBhY3RpdmUgdmVyc2lvbiBvbmx5IGV2ZXIgaG9sZHMgd2hhdCB0aGUgaHVtYW4gdHlwZWQsXG4gICAgICAgIC8vIGFuZCBub3RoaW5nIGFueW9uZSB3cm90ZSBpcyBsb3N0ICh2ZXJpZnktcGFzcyBmaXggNCwgd2F0Y2hlciBoYWxmKS5cbiAgICAgICAgY29uc3Qga2VwdCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRoaXMubGFzdEFjdGl2ZVRleHQuZ2V0KGQuc2x1ZykgPz8gdGV4dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IG4sXG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIHByZXNlcnZlZEFzOiBrZXB0Lm4sXG4gICAgICAgICAgcHJlc2VydmVkUGF0aDoga2VwdC5wYXRoLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgdGV4dCwgYWN0aXZlOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIC8vIEFuIG9wZW5lZCBvcmlnaW5hbCDigJQgYnkgaXRzIHN0b3JlZCBwYXRoLCBvciBieSByZWFscGF0aCBmb3IgYSBzeW1saW5rP1xuICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4Lm9yaWdpbmFsID09PSBhYnMgfHwgcmVhbE9yKHgub3JpZ2luYWwpID09PSBhYnMpO1xuICAgIGlmIChkKSB7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICAgIGlmIChoID09PSBkLm9yaWdpbmFsSGFzaCkgcmV0dXJuIG51bGw7IC8vIG91ciBvd24gc2F2ZSwgb3Igbm8gY2hhbmdlXG4gICAgICBjb25zdCBjbGVhbiA9ICF0aGlzLmlzRGlydHkoZCk7XG4gICAgICBpZiAoY2xlYW4pIHtcbiAgICAgICAgZC5vcmlnaW5hbEhhc2ggPSBoO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkLm91dHNpZGVDaGFuZ2VkKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBhc2tlZFxuICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsIH07XG4gICAgfVxuXG4gICAgLy8gU29tZXRoaW5nIHVuZGVyIGEgbWlycm9yZWQgcm9vdDogdGhlIHRyZWUgbWF5IGhhdmUgY2hhbmdlZC5cbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzY2FuKGUuaWQpID8geyBraW5kOiBcInRyZWVcIiwgZW50cnlJZDogZS5pZCB9IDogbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyDilIDilIAgY2hhdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhZGRNZXNzYWdlKFxuICAgIHdobzogQ2hhdFdobyxcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgZXh0cmE6IHsgc2VsZWN0aW9uPzogU2VsZWN0aW9uIHwgbnVsbDsgYWN0aXZlUGF0aD86IHN0cmluZyB8IG51bGwgfSA9IHt9LFxuICApOiBDaGF0TWVzc2FnZSB7XG4gICAgY29uc3QgbXNnOiBDaGF0TWVzc2FnZSA9IHsgaWQ6IGBtLSR7cmFuZEhleCg0KX1gLCB3aG8sIHRleHQsIHRzOiBEYXRlLm5vdygpLCAuLi5leHRyYSB9O1xuICAgIHRoaXMubS5jaGF0LnB1c2gobXNnKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gbXNnO1xuICB9XG5cbiAgLy8g4pSA4pSAIHZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGRvY1ZpZXcoZDogRG9jUmVjb3JkKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgZW50cnlJZDogZC5lbnRyeUlkLFxuICAgICAgcmVsOiBkLnJlbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLm1hcCgodikgPT4gKHsgLi4udiwgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCB2Lm4pIH0pKSxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBkaXJ0eTogdGhpcy5pc0RpcnR5KGQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGQub3V0c2lkZUNoYW5nZWQsXG4gICAgfTtcbiAgfVxuXG4gIGRvYyhzbHVnOiBzdHJpbmcpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4gdGhpcy5kb2NWaWV3KHRoaXMuZG9jT3JEaWUoc2x1ZykpO1xuICB9XG5cbiAgLyoqIFRoZSBzZXNzaW9uJ3MgaGFsZiBvZiBgUHVibGljU3RhdGVgOyB0aGUgZGFlbW9uIGFkZHMgdGhlIGhvbWUtbGV2ZWwgYHByZWZzYCBhbmQgYHVzZXJIb21lYC4gKi9cbiAgdmlldyhcbiAgICBtb2RlOiBcImRldlwiIHwgXCJyZWxlYXNlXCIsXG4gICAgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsLFxuICApOiBPbWl0PFB1YmxpY1N0YXRlLCBcInByZWZzXCIgfCBcInVzZXJIb21lXCI+IHtcbiAgICByZXR1cm4ge1xuICAgICAgc2Vzc2lvbklkOiB0aGlzLm0uc2Vzc2lvbklkLFxuICAgICAgaG9tZTogdGhpcy5ob21lLFxuICAgICAgbW9kZSxcbiAgICAgIGNvbnRleHQ6IHRoaXMubS5jb250ZXh0LFxuICAgICAgZG9jczogdGhpcy5tLmRvY3MubWFwKChkKSA9PiB0aGlzLmRvY1ZpZXcoZCkpLFxuICAgICAgb3BlbkRvYzogdGhpcy5tLm9wZW5Eb2MsXG4gICAgICBzZWxlY3Rpb24sXG4gICAgICBjaGF0OiB0aGlzLm0uY2hhdCxcbiAgICB9O1xuICB9XG59XG4iLAogICAgIi8qKlxuICogQ29udGV4dCBlbnRyaWVzIG9uIGRpc2sg4oCUIGJ1aWxkaW5nIGFuIGVudHJ5IGZyb20gYSBwYXRoIChFMTUncyBvbmUgbW9kZWwpLFxuICogbWlycm9yaW5nIGEgZm9sZGVyIGludG8gYSBub2RlIHRyZWUsIGFuZCBsaXN0aW5nIGEgZGlyZWN0b3J5IGZvciB0aGVcbiAqIHN1cmZhY2UncyBwYXRoIGNvbXBsZXRpb24gKGBmcy5saXN0YCkuXG4gKlxuICogUHVyZSBvdmVyIHRoZSBmaWxlc3lzdGVtOiBubyBkYWVtb24gc3RhdGUsIHNvIHRoZSB1bml0IGNlbGxzIGRyaXZlIGl0IHdpdGggYVxuICogdGVtcCBkaXJlY3RvcnkgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRleHRFbnRyeSwgQ29udGV4dE5vZGUsIEZzTGlzdEVudHJ5IH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIFdoYXQgc2NyaXB0b3JpdW0gb3BlbnMgYXMgYSBkb2N1bWVudC4gRXZlcnl0aGluZyBlbHNlIGlzIG5vdCBzaG93bi4gKi9cbmV4cG9ydCBjb25zdCBET0NfRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNEb2NOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIERPQ19FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSk7XG59XG5cbi8qKiBEaXJlY3RvcmllcyBhIG1pcnJvciBuZXZlciBkZXNjZW5kcyBpbnRvIOKAlCBub2lzZSwgbm90IGRvY3VtZW50cy4gKi9cbmNvbnN0IFNLSVBfRElSUyA9IG5ldyBTZXQoW1wibm9kZV9tb2R1bGVzXCIsIFwiLmdpdFwiLCBcImRpc3RcIiwgXCJvdXRcIiwgXCJjb3ZlcmFnZVwiXSk7XG5cbi8qKlxuICogVGhlIG1vc3Qgbm9kZXMgb25lIG1pcnJvcmVkIHNjYW4gd2lsbCBob2xkLiBBIGZvbGRlciBlbnRyeSBwb2ludGVkIGF0IGEgaHVnZVxuICogdHJlZSBtdXN0IG5vdCBzdGFsbCB0aGUgZGFlbW9uIG9yIGZsb29kIGV2ZXJ5IHN0YXRlIGJyb2FkY2FzdDsgaGl0dGluZyB0aGVcbiAqIGNhcCBzZXRzIGB0cnVuY2F0ZWRgIG9uIHRoZSBlbnRyeSBzbyB0aGUgc3VyZmFjZSBjYW4gU0FZIHRoZSBsaXN0IGlzIHNob3J0XG4gKiByYXRoZXIgdGhhbiByZW5kZXIgYSBzaG9ydCBsaXN0IGFzIGEgY29tcGxldGUgb25lLlxuICovXG5leHBvcnQgY29uc3QgTUlSUk9SX05PREVfQ0FQID0gMjAwMDtcblxuY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBbiBlbXB0eSBncm91cCBpcyBzdGlsbCBhIHJlYWwgZGlyZWN0b3J5LCBidXQgYSBtaXJyb3Igb2YgYSBkb2NzXG4gICAgICAgIC8vIGZvbGRlciBpcyBtb3JlIHVzZWZ1bCB3aXRob3V0IHR3ZW50eSBlbXB0eSBhc3NldCBmb2xkZXJzIGluIGl0LlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCkgZ3JvdXBzLnB1c2goeyBraW5kOiBcImdyb3VwXCIsIHJlbCwgY2hpbGRyZW4gfSk7XG4gICAgICB9IGVsc2UgaWYgKHN0LmlzRmlsZSgpICYmIGlzRG9jTmFtZShuYW1lKSkge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBkb2NzLnB1c2goeyBraW5kOiBcImRvY1wiLCByZWwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbLi4uZ3JvdXBzLCAuLi5kb2NzXTtcbiAgfTtcbiAgY29uc3Qgbm9kZXMgPSB3YWxrKHJvb3QpO1xuICByZXR1cm4geyBub2RlcywgdHJ1bmNhdGVkIH07XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXFEQSx5QkFBeUIsMkJBQWMseUJBQVU7QUFDakQ7QUFDQSxvQkFBUyx3QkFBUyxxQkFBWSxrQkFBTTtBQUNwQztBQUNBLHNCQUFTOzs7QUMzQ1Q7QUFxQk8sU0FBUyxlQUFlLENBQUMsUUFBZ0IsTUFBb0I7QUFBQSxFQUNsRSxNQUFNLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixjQUFjLEtBQUssSUFBSTtBQUFBLElBQ3ZCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDdEIsT0FBTyxLQUFLO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzNCLE1BQU07QUFBQSxJQUdSLE1BQU07QUFBQTtBQUFBO0FBcUJILFNBQVMsZUFBZSxDQUM3QixNQUNBLFVBQ0EsV0FBMkMs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
