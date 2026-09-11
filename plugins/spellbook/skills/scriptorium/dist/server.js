// @bun
var __require = import.meta.require;

// src/scriptorium/backend/server.ts
import { unlinkSync as unlinkSync2, watch } from "fs";
import { homedir, tmpdir } from "os";
import { dirname as dirname3, join as join4, resolve as resolve2 } from "path";
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
import { existsSync as existsSync3, mkdirSync, readdirSync as readdirSync2, readFileSync as readFileSync3, statSync as statSync2, writeFileSync as writeFileSync2 } from "fs";
import { basename as basename2, dirname as dirname2, extname, join as join3, resolve, sep as sep2 } from "path";

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

class Session {
  home;
  dir;
  m;
  owned = new Map;
  activeHash = new Map;
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
      s.activeHash.set(d.slug, existsSync3(p) ? contentHash(readFileSync3(p, "utf8")) : "");
    }
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
      { path: this.docsDir, recursive: true }
    ];
    for (const e of this.m.context)
      roots.push({ path: e.root, recursive: e.membership === "mirrored", entryId: e.id });
    for (const d of this.m.docs)
      if (!roots.some((r) => r.path === dirname2(d.original)))
        roots.push({ path: dirname2(d.original), recursive: false });
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
    const abs = resolve(key);
    const byPath = this.m.docs.find((d) => d.original === abs);
    if (byPath)
      return byPath;
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
  openPath(rawPath) {
    const abs = resolve(rawPath);
    const existing = this.m.docs.find((d2) => d2.original === abs);
    if (existing) {
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
    this.writeOwned(this.versionPath(d, 1), text);
    this.activeHash.set(d.slug, contentHash(text));
    this.m.openDoc = d.slug;
    this.persist();
    return { slug: d.slug, created: true };
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
    this.writeOwned(this.versionPath(d, n), text);
    this.activeHash.set(d.slug, contentHash(text));
    return { dirtyChanged: before !== this.isDirty(d) };
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
    const p = this.versionPath(d, d.active);
    this.activeHash.set(d.slug, contentHash(readFileSync3(p, "utf8")));
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
    this.writeOwned(this.versionPath(d, d.active), text);
    this.activeHash.set(d.slug, contentHash(text));
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
      this.owned.set(abs, contentHash(text));
      if (n === d2.active) {
        this.activeHash.set(d2.slug, contentHash(text));
        return { kind: "active.outside", doc: d2.slug, version: n, text, path: abs };
      }
      return { kind: "version.changed", doc: d2.slug, version: n, text, active: false };
    }
    const d = this.m.docs.find((x) => x.original === abs);
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
        this.writeOwned(this.versionPath(d, d.active), text);
        this.activeHash.set(d.slug, h);
        this.persist();
        return {
          kind: "original.reloaded",
          doc: d.slug,
          version: d.active,
          text,
          original: abs
        };
      }
      if (d.outsideChanged)
        return null;
      d.outsideChanged = true;
      this.persist();
      return { kind: "original.conflict", doc: d.slug, original: abs };
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
    const want = new Map(session.watchRoots().map((r) => [`${r.recursive ? "R" : "F"}:${r.path}`, r]));
    for (const [key, w] of watchers)
      if (!want.has(key)) {
        w.close();
        watchers.delete(key);
      }
    for (const [key, r] of want) {
      if (watchers.has(key))
        continue;
      try {
        const w = watch(r.path, { recursive: r.recursive }, (_event, name) => {
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
        send({
          type: "version.text",
          doc: ev.doc,
          version: ev.version,
          text: ev.text,
          origin: "remote"
        });
        announce(`v${ev.version} of ${ev.doc} is the ACTIVE version and was written from outside the editor. Agent edits belong in a new version (version-new).`, { fact: "active.outside", doc: ev.doc, version: ev.version, path: ev.path });
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
        if (r.dirtyChanged)
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

//# debugId=524FEFCE6034AFF864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3Nlc3Npb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdHJlZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgcGVyLXNlc3Npb24gZGFlbW9uIOKAlCB0aGUgcHJvY2VzcyB0aGUgc3VyZmFjZSB0YWxrcyB0byBvdmVyIGFcbiAqIFdlYlNvY2tldCBhbmQgdGhlIENMSSB0YWxrcyB0byBvdmVyIEhUVFAuIExhdW5jaGVkIGJ5XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL3NjcmlwdG9yaXVtL3NjcmlwdHMvc2VydmVyLnRzYCAodGhlIGxhdW5jaGVyKSwgd2hpY2hcbiAqIGltcG9ydHMgdGhlIEJVSUxUIGBkaXN0L3NlcnZlci5qc2AuXG4gKlxuICog4pSA4pSAIFRIRSBFSUdIVCBRVUVTVElPTlMgKHNjYWZmb2xkaW5nIHBsYXlib29rIE4xKSwgQU5TV0VSRUQgQVMgREVTSUdOIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIEFyaXRobWV0aWM6IGBTS0lMTF9ST09UYC9gRElTVF9ESVJgIG9ubHksIGZvciB0aGUga2l0J3MgYHJlc29sdmVNb2RlYCBhbmRcbiAqICAgIGBzZXJ2ZUZyb21EaXN0YCwgYW5kIHRydWUgYXQgdGhlIEVNSVRURUQgYWRkcmVzcyAoYGRpc3Qvc2VydmVyLmpzYCwgd2hvc2VcbiAqICAgIGAuLmAgaXMgdGhlIHNraWxsIGZvbGRlcikuIE5vdGhpbmcgZWxzZSBpcyBwaW5uZWQgb2ZmIGBpbXBvcnQubWV0YWAuXG4gKiAyLiBTZXJ2ZXM6IFlFUy4gYC9gIGlzIHRoZSBidWlsdCBgaW5kZXguaHRtbGAgdmlhIGBzZXJ2ZUZyb21EaXN0YCwgbm9cbiAqICAgIHN1YnN0aXR1dGlvbjsgdGhlIG9ubHkgcm91dGVzIG9mIGl0cyBvd24gYXJlIGAvc3RhdGVgLCBgL2NtZGAsIGAvZXZlbnRzYCxcbiAqICAgIGAvd3NgIGFuZCBgL2ZzLypgIChyZWFkLW9ubHk6IGEgdmVyc2lvbidzIHRleHQsIGEgZGlyZWN0b3J5IGxpc3RpbmcpLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgYGNsaS50c2A7IHRoZSB0d28gc2hhcmUgYC4vaGVhcnRiZWF0LnRzYC5cbiAqIDQuIExpZmVjeWNsZTogbG9uZy1ydW5uaW5nLCBvbmUgZGFlbW9uIHBlciBzZXNzaW9uLCBpZGxlLXRpbWVvdXQgbGlrZVxuICogICAgZ2xhbW91ciAobGluZ2VyIGFmdGVyIHRoZSBsYXN0IHN1YnNjcmliZXIgbGVhdmVzOyBleGl0IDEyNCkuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oCUIGBtYWluYCBhd2FpdHMgdGhlXG4gKiAgICBzZXNzaW9uJ3MgZW5kIGFuZCBpdHMgb3duIGRyYWluLCBleGFjdGx5IGFzIGdsYW1vdXIncyBzZXJ2ZXIgZG9lcywgc28gdGhlXG4gKiAgICBsYXVuY2hlciBpcyBURVJNSU5BTC1FWElUIChgcHJvY2Vzcy5leGl0KGF3YWl0IHJ1bigpKWApOiBvbmNlIGBtYWluYFxuICogICAgcmVzb2x2ZXMgbm90aGluZyBtYXkga2VlcCB0aGUgcHJvY2VzcyBhbGl2ZSwgYW5kIGEgd2F0Y2hlciBoYW5kbGUgb3IgYVxuICogICAgc3RyYWdnbGluZyBzb2NrZXQgd291bGQuIERyaXZlbiwgbm90IHJlYWQgKHNlZSB0aGUgc2xpY2UtQSBqb3VybmFsKS5cbiAqIDYuIEV2ZW50IGlkcyByZWNvdmVyZWQgYWNyb3NzIHJlc3RhcnQ/IE5PIOKAlCB0aGUgbG9nIGlzIGluIG1lbW9yeSBhbmQgaWRzXG4gKiAgICByZXN0YXJ0IGF0IDEsIGV2ZW4gdW5kZXIgYC0tcmVzdG9yZWAgKHdoaWNoIHJlc3RvcmVzIHRoZSBNQU5JRkVTVCwgbm90IHRoZVxuICogICAgbG9nKS4gU28gdGhlIGxvZyBpcyBzdGFtcGVkIHdpdGggYSBwZXItYm9vdCBFUE9DSCAobWluZC1tYXBwZXIncyBzaGFwZSlcbiAqICAgIGFuZCB0aGUgdGFpbCByZXNldHMgaXRzIGN1cnNvciB3aGVuIHRoZSBlcG9jaCBjaGFuZ2VzLlxuICogNy4gQSBraXQgc3ViamVjdCBpbiBhIGRpZmZlcmVudCBzaGFwZT8gTm8g4oCUIHRoZSBzaGFwZSB3YXMgY2hvc2VuIHRvIGJlIHRoZVxuICogICAga2l0J3MuXG4gKiA4LiBBIGtpdCBtb2R1bGUgbmFtZXMgdGhpcyBzcGVsbCBhcyBpdHMgc291cmNlPyBTdHJ1Y3R1cmFsbHkgTk86IHNjcmlwdG9yaXVtXG4gKiAgICBpcyB0aGUgZmlyc3Qgc3BlbGwgc2NhZmZvbGRlZCBhZnRlciB0aGUgY29udmVyZ2VuY2UuXG4gKlxuICog4pSA4pSAIEtJVCBWRVJESUNUUyAocGxheWJvb2sgTjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGVycm9ycyBTVUJKRUNUICh0aGUgQ0xJOyB0aGUgZGFlbW9uIGFuc3dlcnMgSFRUUCBzdGF0dXNlcyB0aGUgQ0xJIG1hcHMpIMK3XG4gKiBzZXJ2ZURpc3QgU1VCSkVDVCAoYHJlc29sdmVNb2RlYCwgYHNlcnZlRnJvbURpc3RgKSDCtyBob3VzZWtlZXBpbmcgU1VCSkVDVCwgYWxsXG4gKiB0aHJlZSBleHBvcnRzIChgc2hvdWxkSWRsZUNsb3NlYCB2aWEgYHN0YXJ0SG91c2VrZWVwaW5nYCdzIGlkbGUtY2xvc2UsIHRoZVxuICogc25hcHNob3Qgc3dlZXAg4oCUIGhlcmUgdGhlIG1hbmlmZXN0IGlzIHdyaXR0ZW4gb24gZXZlcnkgY2hhbmdlIGluc3RlYWQsIHNvIHRoZVxuICogc3dlZXAncyBzbmFwc2hvdCBob29rIGlzIGRlbGliZXJhdGVseSBOT1QgcGFzc2VkIOKAlCBhbmQgYGRyYWluQW5kU3RvcGApIMK3XG4gKiB0YWlsRXZlbnRzIFNVQkpFQ1QgKHRoZSBDTEkncyBgdGFpbGApIMK3IGhlYXJ0YmVhdCBTVUJKRUNUIChgLi9oZWFydGJlYXQudHNgKSDCt1xuICogZGlzY292ZXJ5IFNVQkpFQ1QgKHNlc3Npb24tSlNPTiwgRTEzOiBgc2NyaXB0b3JpdW0tPGlkPi5qc29uYCArXG4gKiBgc2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25gIGluIHRtcGRpciB2aWEgYHdyaXRlRmlsZUF0b21pY2AvYHVubGlua0lmTWF0Y2hlc2ApIMK3XG4gKiBldmVudExvZyBTVUJKRUNULCBXSVRIIEVQT0NIIChRNikgwrcgc3NlIFNVQkpFQ1QgKGBHRVQgL2V2ZW50c2ApIMK3XG4gKiBsaWIvcHJpbnRKc29uIFNVQkpFQ1QgKHRoZSBDTEkgc3BlYWtzIHRoZSBhZ2VudCB3aXJlKS5cbiAqXG4gKiDilIDilIAgVEVBUkRPV04gT1JERVIgKHJlZ2lzdGVyIEE2KSwgU1RBVEVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGdsYW1vdXIncyBvcmRlcjogc3RvcCBob3VzZWtlZXBpbmcg4oaSIGNsb3NlIHRoZSB3YXRjaGVycyDihpIgcGVyc2lzdCB0aGVcbiAqIG1hbmlmZXN0IOKGkiB1bmxpbmsgZGlzY292ZXJ5IOKGkiBlbWl0IGBjbG9zZWRgIOKGkiBkcmFpbi4gRGlzY292ZXJ5IGdvZXMgQkVGT1JFIHRoZVxuICogYGNsb3NlZGAgZnJhbWUgc28gYSB0YWlsIHRoYXQgc2VlcyBgY2xvc2VkYCBhbmQgYSBDTEkgdmVyYiB0aGF0IHJ1bnMgcmlnaHRcbiAqIGFmdGVyIGl0IGJvdGggZmluZCBubyBwb2ludGVyIHRvIGEgZGFlbW9uIHRoYXQgaXMgbGVhdmluZzsgdGhlIG90aGVyIG9yZGVyXG4gKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYSB2ZXJiIHJlc29sdmVzIGEgc2Vzc2lvbiB0aGF0IHdpbGwgcmVmdXNlIGl0LlxuICovXG5cbmltcG9ydCB7IHR5cGUgRlNXYXRjaGVyLCB1bmxpbmtTeW5jLCB3YXRjaCB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgdW5saW5rSWZNYXRjaGVzLCB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudExvZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ldmVudExvZy50c1wiO1xuaW1wb3J0IHsgZHJhaW5BbmRTdG9wLCBzdGFydEhvdXNla2VlcGluZyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlIGFzIHJlc29sdmVNb2RlSW4sIHNlcnZlRnJvbURpc3QgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc2VydmVEaXN0LnRzXCI7XG5pbXBvcnQgeyB0eXBlIFNzZUNsaWVudHMsIHNzZVJlc3BvbnNlIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3NzZS50c1wiO1xuaW1wb3J0IHsgSURMRV9USU1FT1VUX1NFQywgU1NFX0hFQVJUQkVBVF9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHR5cGUgeyBBZ2VudENtZCwgQ2xpZW50TXNnLCBTZWxlY3Rpb24sIFNlcnZlck1zZyB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8qKiByZWxlYXNlIGlmZiBgZGlzdC9pbmRleC5odG1sYCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Q7IHRoZSBlbnYgdmFyIG92ZXJyaWRlcyAoQ29udHJhY3QgMSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYC4gYHByb21wdHMuanNvbmAgYmVzaWRlIGBzZXNzaW9ucy9gIGlzIHNsaWNlIEIncyAoRTkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHsgcG9ydD86IG51bWJlcjsgcmVzdG9yZT86IHN0cmluZzsgdGltZW91dFM/OiBudW1iZXIgfTtcblxuLyoqIEEgdGFpbCBmcmFtZSdzIHBheWxvYWQuIFRoZSBsb2cgc3RhbXBzIGBpZGAgYW5kIGBlcG9jaGAuICovXG50eXBlIExvZ0V2ZW50ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gJiB7IHR5cGU6IHN0cmluZyB9O1xuXG4vKiogSG93IGxvbmcgYSBidXJzdCBvZiB3YXRjaGVyIGV2ZW50cyBvbiBvbmUgcGF0aCBzZXR0bGVzIGJlZm9yZSBpdCBpcyByZWFkLiAqL1xuY29uc3QgV0FUQ0hfU0VUVExFX01TID0gNjA7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydERhZW1vbihvcHRzOiBTdGFydE9wdHMpIHtcbiAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAvLyBNb2RlIEJFRk9SRSBhbnkgd3JpdGU6IGEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3RcbiAgLy8gZGllIGF0IHRoZSBpbXBvcnQgaGF2aW5nIGNyZWF0ZWQgbm90aGluZyAoZ2xhbW91cidzIG1lYXN1cmVkIG9yZGVyKS5cbiAgY29uc3QgbW9kZSA9IHJlc29sdmVNb2RlKCk7XG4gIGNvbnN0IGRldkluZGV4ID1cbiAgICBtb2RlID09PSBcImRldlwiXG4gICAgICA/IChhd2FpdCBpbXBvcnQoXCIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vc3VyZmFjZS9pbmRleC5odG1sXCIpKS5kZWZhdWx0XG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgcm91dGVzID0gKGRldkluZGV4ID8geyBcIi9cIjogZGV2SW5kZXggfSA6IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBuZXZlcj47XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IG9wdHMucmVzdG9yZSA/IFNlc3Npb24ucmVzdG9yZShob21lLCBvcHRzLnJlc3RvcmUpIDogU2Vzc2lvbi5jcmVhdGUoaG9tZSk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IHNlc3Npb24uaWQ7XG4gIGxldCBzZWxlY3Rpb246IFNlbGVjdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIC0tLSBjaGFubmVscyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8aW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPj4oKTtcbiAgY29uc3QgbG9nID0gY3JlYXRlRXZlbnRMb2c8TG9nRXZlbnQ+KHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfSk7XG4gIGNvbnN0IHNzZUNsaWVudHM6IFNzZUNsaWVudHMgPSBuZXcgU2V0KCk7XG4gIGxldCBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3QgdG91Y2ggPSAoKSA9PiB7XG4gICAgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIH07XG5cbiAgY29uc3Qgc2VuZCA9IChtc2c6IFNlcnZlck1zZykgPT4ge1xuICAgIGNvbnN0IHMgPSBKU09OLnN0cmluZ2lmeShtc2cpO1xuICAgIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3Muc2VuZChzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBzb2NrZXQgY2xvc2VkICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHNlbmQoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiBzZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSB9KTtcblxuICAvKiogQSBzeXN0ZW0gbGluZSBpbiB0aGUgY2hhdCDigJQgYW5kLCBiZWNhdXNlIHRoZSBhZ2VudCBtdXN0IGtub3cgaXQgdG9vLCBvbiB0aGUgdGFpbC4gKi9cbiAgY29uc3QgYW5ub3VuY2UgPSAodGV4dDogc3RyaW5nLCBmYWN0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9KSA9PiB7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcInN5c3RlbVwiLCB0ZXh0KTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwic3lzdGVtXCIsIHRleHQsIHRzOiBtLnRzLCAuLi5mYWN0IH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gIH07XG5cbiAgLy8gLS0tIHRoZSB3YXRjaGVyIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vXG4gIC8vIOKaoCBERVZJQVRJT04gRlJPTSBUSEUgQlJJRUYsIFdJVEggSVRTIFJFQVNPTjogYG5vZGU6ZnNgIGB3YXRjaGAgKEJ1bidzXG4gIC8vIGJ1aWx0LWluKSwgTk9UIGBAcGFyY2VsL3dhdGNoZXJgLiBgQHBhcmNlbC93YXRjaGVyYCBpcyBhIG5hdGl2ZSBhZGRvbiB3aG9zZVxuICAvLyBsb2FkZXIgZG9lcyBhIHJ1bnRpbWUgYHJlcXVpcmUoKWAgb2YgYSBwZXItcGxhdGZvcm0gcGFja2FnZTsgYnVuZGxlZCBpbnRvXG4gIC8vIGBkaXN0L3NlcnZlci5qc2AgaXQgaXMgbm90IGlubGluZWQsIHNvIHRoZSBzaGlwcGVkIGRhZW1vbiB3b3VsZCBuZWVkIGFcbiAgLy8gYG5vZGVfbW9kdWxlc2AgdGhlIG1hcmtldHBsYWNlIG5ldmVyIGNvcGllcyAoaW1wb3J0LWJvdW5kYXJ5IHdhcmQgMWInc1xuICAvLyBcInRoZSBzaGlwcGVkIGV4ZWN1dGlvbiBwYXRoIGNhcnJpZXMgbm8gZGVwZW5kZW5jaWVzXCIpLiBNZWFzdXJlZCB1bmRlciBCdW5cbiAgLy8gMS40LjAgb24gbWFjT1MgYmVmb3JlIGNob29zaW5nOiBhIHJlY3Vyc2l2ZSBkaXJlY3Rvcnkgd2F0Y2ggcmVwb3J0cyBhblxuICAvLyBpbi1wbGFjZSB3cml0ZSwgYW4gYXRvbWljIHRtcCtyZW5hbWUgc2F2ZSwgYW5kIGJvdGggYWdhaW4gaW4gYVxuICAvLyBzdWJkaXJlY3Rvcnkg4oCUIHRoZSBmb3VyIGNhc2VzIGludmVzdGlnYXRpb24gwqc1IGRyb3ZlIEBwYXJjZWwvd2F0Y2hlciBvbi5cbiAgLy8gVGhlIGhhc2gtY29tcGFyZSBhbmQgc2VsZi13cml0ZSBzdXBwcmVzc2lvbiBhcmUgdW5jaGFuZ2VkIChzZXNzaW9uLnRzKS5cbiAgY29uc3Qgd2F0Y2hlcnMgPSBuZXcgTWFwPHN0cmluZywgRlNXYXRjaGVyPigpO1xuICBjb25zdCBwZW5kaW5nID0gbmV3IE1hcDxzdHJpbmcsIFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+PigpO1xuICBjb25zdCBvbkZzID0gKGFiczogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgdCA9IHBlbmRpbmcuZ2V0KGFicyk7XG4gICAgaWYgKHQpIGNsZWFyVGltZW91dCh0KTtcbiAgICBwZW5kaW5nLnNldChcbiAgICAgIGFicyxcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBwZW5kaW5nLmRlbGV0ZShhYnMpO1xuICAgICAgICBsZXQgZXY6IEZpbGVFdmVudCB8IG51bGwgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGV2ID0gc2Vzc2lvbi5vbkZpbGVFdmVudChhYnMpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiB3YXRjaGVyOiAke2V9XFxuYCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV2KSBoYW5kbGVGaWxlRXZlbnQoZXYpO1xuICAgICAgfSwgV0FUQ0hfU0VUVExFX01TKSxcbiAgICApO1xuICB9O1xuICBjb25zdCBzeW5jV2F0Y2hlcnMgPSAoKSA9PiB7XG4gICAgY29uc3Qgd2FudCA9IG5ldyBNYXAoXG4gICAgICBzZXNzaW9uLndhdGNoUm9vdHMoKS5tYXAoKHIpID0+IFtgJHtyLnJlY3Vyc2l2ZSA/IFwiUlwiIDogXCJGXCJ9OiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB3ID0gd2F0Y2goci5wYXRoLCB7IHJlY3Vyc2l2ZTogci5yZWN1cnNpdmUgfSwgKF9ldmVudCwgbmFtZSkgPT4ge1xuICAgICAgICAgIGlmIChuYW1lKSBvbkZzKGpvaW4oci5wYXRoLCBuYW1lLnRvU3RyaW5nKCkpKTtcbiAgICAgICAgICBlbHNlIGlmIChyLmVudHJ5SWQpIG9uRnMoci5wYXRoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHcub24oXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICAgICAgLyogdGhlIGRpcmVjdG9yeSB3ZW50IGF3YXk7IHRoZSBuZXh0IHN5bmMgZHJvcHMgaXQgKi9cbiAgICAgICAgfSk7XG4gICAgICAgIHdhdGNoZXJzLnNldChrZXksIHcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHVud2F0Y2hhYmxlIChnb25lLCBwZXJtaXNzaW9ucykg4oCUIG91dHNpZGUgY2hhbmdlcyB0aGVyZSBnbyB1bnNlZW4gKi9cbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlRmlsZUV2ZW50ID0gKGV2OiBGaWxlRXZlbnQpID0+IHtcbiAgICBzd2l0Y2ggKGV2LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJ2ZXJzaW9uLmNoYW5nZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInZlcnNpb24uY3JlYXRlZFwiOlxuICAgICAgICBhbm5vdW5jZShgdiR7ZXYudmVyc2lvbn0gb2YgJHtldi5kb2N9IGFwcGVhcmVkICh3cml0dGVuIGRpcmVjdGx5IHRvICR7ZXYucGF0aH0pYCwge1xuICAgICAgICAgIGZhY3Q6IFwidmVyc2lvbi5jcmVhdGVkXCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJhY3RpdmUub3V0c2lkZVwiOlxuICAgICAgICAvLyBFMjogdGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgdmVyc2lvbiB0aGUgaHVtYW4gaXMgZWRpdGluZy4gSXQgaXNcbiAgICAgICAgLy8gZGV0ZWN0ZWQsIEFOTk9VTkNFRCwgYW5kIGFkb3B0ZWQg4oCUIHRoZSBmaWxlIGlzIHRoZSB0cnV0aCBub3csIGFuZCB0aGVcbiAgICAgICAgLy8gc3VyZmFjZSBhcHBsaWVzIGl0IGFzIGEgcmVtb3RlIGNoYW5nZSBvdXRzaWRlIHRoZSBodW1hbidzIHVuZG8uXG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBldi5kb2MsXG4gICAgICAgICAgdmVyc2lvbjogZXYudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBldi50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJyZW1vdGVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gaXMgdGhlIEFDVElWRSB2ZXJzaW9uIGFuZCB3YXMgd3JpdHRlbiBmcm9tIG91dHNpZGUgdGhlIGVkaXRvci4gQWdlbnQgZWRpdHMgYmVsb25nIGluIGEgbmV3IHZlcnNpb24gKHZlcnNpb24tbmV3KS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLCBkb2M6IGV2LmRvYywgdmVyc2lvbjogZXYudmVyc2lvbiwgcGF0aDogZXYucGF0aCB9LFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwib3JpZ2luYWwucmVsb2FkZWRcIjpcbiAgICAgICAgc2VuZCh7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICAgIHRleHQ6IGV2LnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoYCR7ZXYub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayDigJQgcmVsb2FkZWQgKHlvdSBoYWQgbm8gdW5zYXZlZCBlZGl0cykuYCwge1xuICAgICAgICAgIGZhY3Q6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5jb25mbGljdFwiOlxuICAgICAgICBhbm5vdW5jZShcbiAgICAgICAgICBgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIHdoaWxlIHlvdSBoYXZlIHVuc2F2ZWQgZWRpdHMuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHlvdXJzOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZXYuZG9jIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJ0cmVlXCI6XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gIH07XG5cbiAgLy8gLS0tIHNoYXJlZCBhY3RzIChzdXJmYWNlIGFuZCBhZ2VudCByZWFjaCB0aGUgc2FtZSBjb2RlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgYWRkUGF0aHMgPSAocGF0aHM6IHN0cmluZ1tdKSA9PiB7XG4gICAgY29uc3QgYWRkZWQgPSBwYXRocy5tYXAoKHApID0+IHNlc3Npb24uYWRkQ29udGV4dChwKSk7XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4gYWRkZWQ7XG4gIH07XG5cbiAgY29uc3QgYWN0aXZhdGUgPSAoZG9jOiBzdHJpbmcgfCB1bmRlZmluZWQsIHZlcnNpb246IG51bWJlciwgYnk6IFwiaHVtYW5cIiB8IFwiYWdlbnRcIikgPT4ge1xuICAgIGNvbnN0IHIgPSBzZXNzaW9uLmFjdGl2YXRlKHsgZG9jLCB2ZXJzaW9uIH0pO1xuICAgIGNvbnN0IHZpZXcgPSBzZXNzaW9uLmRvYyhyLnNsdWcpO1xuICAgIGNvbnN0IHBhdGggPSB2aWV3LnZlcnNpb25zLmZpbmQoKHYpID0+IHYubiA9PT0gdmVyc2lvbik/LnBhdGggPz8gbnVsbDtcbiAgICBzZW5kKHtcbiAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKHIuc2x1ZywgdmVyc2lvbikudGV4dCxcbiAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgIFwic3lzdGVtXCIsXG4gICAgICBgJHtieSA9PT0gXCJhZ2VudFwiID8gXCJBZ2VudFwiIDogXCJZb3VcIn0gbWFkZSB2JHt2ZXJzaW9ufSBvZiAke3Iuc2x1Z30gYWN0aXZlICh3YXMgdiR7ci5wcmV2aW91c30pLmAsXG4gICAgKTtcbiAgICBsb2cuZW1pdCh7IHR5cGU6IFwiYWN0aXZhdGVkXCIsIGJ5LCBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGgsIHRzOiBtLnRzIH0pO1xuICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb24sIHByZXZpb3VzOiByLnByZXZpb3VzLCBwYXRoIH07XG4gIH07XG5cbiAgLy8gLS0tIHN1cmZhY2UgbWVzc2FnZXMgKFdlYlNvY2tldCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3QgcmVwbHkgPSAod3M6IGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4sIG1zZzogU2VydmVyTXNnKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkobXNnKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNsaWVudE1zZyA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBDbGllbnRNc2cpID0+IHtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwib3BlblwiOiB7XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm9wZW5QYXRoKG1zZy5wYXRoKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGlmIChyLmNyZWF0ZWQpXG4gICAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcImRvYy5vcGVuZWRcIiwgZG9jOiByLnNsdWcsIHBhdGg6IHNlc3Npb24uYWN0aXZlUGF0aChyLnNsdWcpIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwib3Blbi5kb2NcIjpcbiAgICAgICAgc2Vzc2lvbi5vcGVuU2x1Zyhtc2cuZG9jKTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImVkaXRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5lZGl0KG1zZy5kb2MsIG1zZy52ZXJzaW9uLCBtc2cudGV4dCk7XG4gICAgICAgIGlmIChyLmRpcnR5Q2hhbmdlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNlbGVjdFwiOlxuICAgICAgICAvLyBBTUJJRU5UIHN0YXRlOiBzdG9yZWQgYW5kIHNob3duLCBuZXZlciBwdXNoZWQgb250byB0aGUgYWdlbnQncyB0YWlsLlxuICAgICAgICBzZWxlY3Rpb24gPSBtc2cuc2VsZWN0aW9uO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IG1zZy50ZXh0LnRyaW0oKTtcbiAgICAgICAgaWYgKCF0ZXh0KSByZXR1cm47XG4gICAgICAgIGNvbnN0IHNlbCA9IG1zZy53aXRoU2VsZWN0aW9uID8gc2VsZWN0aW9uIDogbnVsbDtcbiAgICAgICAgY29uc3QgYWN0aXZlUGF0aCA9IHNlbCA/IHNlc3Npb24uYWN0aXZlUGF0aChzZWwuZG9jKSA6IHNlc3Npb24uYWN0aXZlUGF0aCgpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiaHVtYW5cIiwgdGV4dCwgeyBzZWxlY3Rpb246IHNlbCwgYWN0aXZlUGF0aCB9KTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICAgIG1lc3NhZ2VfaWQ6IG0uaWQsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBzZWxlY3Rpb246IHNlbCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKHNlbD8uZG9jKSxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICBhY3RpdmF0ZShtc2cuZG9jLCBtc2cudmVyc2lvbiwgXCJodW1hblwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFttc2cucGF0aF0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiY29udGV4dC5yZW1vdmVcIjpcbiAgICAgICAgc2Vzc2lvbi5yZW1vdmVDb250ZXh0KG1zZy5pZCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwiZnMubGlzdFwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBleHBhbmRIb21lKG1zZy5wYXRoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImZzLmxpc3RcIiwgcGF0aDogbXNnLnBhdGgsIGVudHJpZXM6IGxpc3REaXIocGF0aCkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJmcy5saXN0XCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVudHJpZXM6IFtdLFxuICAgICAgICAgICAgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgaGFuZGxlQWdlbnRDbWQgPSAoY21kOiBBZ2VudENtZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBzd2l0Y2ggKGNtZC50eXBlKSB7XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCBhZGRlZCA9IGFkZFBhdGhzKGNtZC5wYXRocyk7XG4gICAgICAgIHJldHVybiB7IGVudHJpZXM6IGFkZGVkLm1hcCgoYSkgPT4gKHsgLi4uYS5lbnRyeSwgYWRkZWQ6IGEuYWRkZWQgfSkpIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IGNtZC5kb2MsXG4gICAgICAgICAgZnJvbTogY21kLmZyb20sXG4gICAgICAgICAgbGFiZWw6IGNtZC5sYWJlbCxcbiAgICAgICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBjcmVhdGVkIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke2NtZC5sYWJlbCA/IGAg4oCUICR7Y21kLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiwgZnJvbTogci52ZXJzaW9uLmZyb20sIHBhdGg6IHIudmVyc2lvbi5wYXRoIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImFnZW50XCIsIGNtZC50ZXh0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgaWQ6IG0uaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICByZXR1cm4gYWN0aXZhdGUoY21kLmRvYywgY21kLnZlcnNpb24sIFwiYWdlbnRcIik7XG4gICAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KChjbWQgYXMgeyB0eXBlPzogdW5rbm93biB9KS50eXBlKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgICBbXCJjb250ZXh0LmFkZFwiLCBcInZlcnNpb24ubmV3XCIsIFwic2F5XCIsIFwiYWN0aXZhdGVcIiwgXCJjbG9zZVwiXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gc2Vzc2lvbi52aWV3KG1vZGUsIHNlbGVjdGlvbik7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiBzZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgbG9nLmVtaXQoeyB0eXBlOiBcInJlYWR5XCIsIG1vZGUsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlIH0pO1xuXG4gIGNvbnN0IHN0b3BIb3VzZWtlZXBpbmcgPSBzdGFydEhvdXNla2VlcGluZyh7XG4gICAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUsXG4gICAgaWRsZU1zOiAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSxcbiAgICB0b3VjaCxcbiAgICB0aW1lb3V0TXM6IChvcHRzLnRpbWVvdXRTID8/IDE4MDApICogMTAwMCxcbiAgICBvbklkbGVDbG9zZTogKCkgPT4gcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSksXG4gIH0pO1xuXG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgbGV0IHJlc29sdmVTaHV0ZG93biE6ICgpID0+IHZvaWQ7XG4gIGNvbnN0IHNodXRkb3duID0gbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHtcbiAgICByZXNvbHZlU2h1dGRvd24gPSByO1xuICB9KTtcblxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvLyBUaGUgb3JkZXIgaXMgdGhlIGhlYWRlcidzLCBhbmQgdGhlIGhlYWRlciBzYXlzIHdoeS5cbiAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgc3RvcEhvdXNla2VlcGluZygpO1xuICAgIGZvciAoY29uc3QgdyBvZiB3YXRjaGVycy52YWx1ZXMoKSkgdy5jbG9zZSgpO1xuICAgIHdhdGNoZXJzLmNsZWFyKCk7XG4gICAgZm9yIChjb25zdCB0IG9mIHBlbmRpbmcudmFsdWVzKCkpIGNsZWFyVGltZW91dCh0KTtcbiAgICB0cnkge1xuICAgICAgc2Vzc2lvbi5wZXJzaXN0KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBkaXI6IHNlc3Npb24uZGlyLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLyoqIEFuIGFic2VudCBPcmlnaW4gKHRoZSBDTEksIGN1cmwpIG9yIHRoaXMgZGFlbW9uJ3Mgb3duIHBhZ2U7IG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW1lT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGNvbnN0IG9yaWdpbiA9IHJlcS5oZWFkZXJzLmdldChcIm9yaWdpblwiKTtcbiAgaWYgKG9yaWdpbiA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBvcmlnaW4gPT09IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gIHx8IG9yaWdpbiA9PT0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWA7XG59XG5cbmZ1bmN0aW9uIGV4cGFuZEhvbWUocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHAgPT09IFwiflwiKSByZXR1cm4gaG9tZWRpcigpO1xuICBpZiAocC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBqb2luKGhvbWVkaXIoKSwgcC5zbGljZSgyKSk7XG4gIHJldHVybiByZXNvbHZlKHApO1xufVxuXG4vKiogVGhlIGRhZW1vbidzIHByaXZhdGUgYXJndiDigJQgdGhlIENMSSBzcGF3bnMgaXQgd2l0aCBleGFjdGx5IHRoZXNlLiAqL1xuY29uc3QgREFFTU9OX09QVElPTlMgPSB7XG4gIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG4vKiogUGFyc2UgdGhlIGRhZW1vbidzIGFyZ3YsIGJvb3QsIHByaW50IHRoZSBoYW5kc2hha2UsIHdhaXQgZm9yIHRoZSBlbmQuIFJldHVybnMgdGhlIGV4aXQgY29kZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICB0cnkge1xuICAgIGZsYWdzID0gbm9kZVBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IERBRU1PTl9PUFRJT05TLCBzdHJpY3Q6IHRydWUgfSkudmFsdWVzIGFzIFJlY29yZDxcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyB8IHVuZGVmaW5lZFxuICAgID47XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBzY3JpcHRvcml1bTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKFxuICAgICAgICBEQUVNT05fT1BUSU9OUyxcbiAgICAgIClcbiAgICAgICAgLm1hcCgoaykgPT4gYC0tJHtrfWApXG4gICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgbGV0IGQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2Ygc3RhcnREYWVtb24+PjtcbiAgdHJ5IHtcbiAgICBkID0gYXdhaXQgc3RhcnREYWVtb24oe1xuICAgICAgcG9ydDogZmxhZ3MucG9ydCA/IE51bWJlcihmbGFncy5wb3J0KSA6IDAsXG4gICAgICByZXN0b3JlOiBmbGFncy5yZXN0b3JlLFxuICAgICAgdGltZW91dFM6IGZsYWdzLnRpbWVvdXQgPyBOdW1iZXIoZmxhZ3MudGltZW91dCkgOiB1bmRlZmluZWQsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgcmV0dXJuIHJlcy5jb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZVxuICogYnVuZGxlLCBzbyB0aGVyZSBpcyBubyBzdWNoIGJsb2NrIGhlcmUsIGFuZCB0aGlzIHRha2VzIG5vIGFyZ3VtZW50czogdGhlXG4gKiBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSB0d28gcHJpbWl0aXZlcyB1bmRlciBCT1RIIG9mIHRoZSBob3VzZSdzIGRhZW1vbi1kaXNjb3ZlcnkgY29udmVudGlvbnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBEMyBydWxlZCB0aGF0IHRoZSBjb252ZW50aW9ucyB0aGVtc2VsdmVzIOKAlCBwZXItc2Vzc2lvbiB0bXBkaXIgSlNPTiAoYm91bnR5LFxuICogZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZSkgYW5kIHNpbmdsZXRvbiBgJEhPTUUvZGFlbW9uLnBvcnRgICsgYGRhZW1vbi5waWRgXG4gKiAoYXN0cm9sYWJlLCBncmFwZXZpbmUsIG1pbmQtbWFwcGVyKSDigJQgYm90aCBzdXJ2aXZlLCBiZWNhdXNlIHRoZXkgZW5jb2RlXG4gKiBnZW51aW5lbHkgZGlmZmVyZW50IG1vZGVscyAoY29uY3VycmVudCBzZXNzaW9ucyB2cyBhIHN0YW5kaW5nIHNpbmdsZXRvbikgYW5kXG4gKiBwaWNraW5nIG9uZSBpcyBhIHByb2R1Y3QgZGVjaXNpb24sIG5vdCBhIGZhY3RvcmluZyBvbmUuIFdoYXQgSVMgb25lXG4gKiBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgcGFpciBiZWxvdywgd2hpY2ggaXMgYWxzbyBleGFjdGx5IHdoZXJlIGNlbnN1cyBkZWZlY3RcbiAqICoqTDMqKiBsaXZlcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKlxuICogV3JpdGUgYHRleHRgIHRvIGB0YXJnZXRgIGF0b21pY2FsbHk6IHdyaXRlIGJlc2lkZSBpdCwgdGhlbiByZW5hbWUuXG4gKlxuICog4puUICoqTDMsIENMT1NFRCBCWSBDT05TVFJVQ1RJT04uKiogQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljLCBzbyBhXG4gKiBDTEkgcmVhZGluZyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIEhBTEYtV1JJVFRFTiBwb2ludGVyLiBVbmRlclxuICogYSBiZXN0LWVmZm9ydCByZWFkZXIgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiIOKAlCBhYnNlbmNlIHJlcG9ydGVkXG4gKiBmb3Igd2hhdCB3YXMgcmVhbGx5IGEgdG9ybiByZWFkLCB3aGljaCBpcyB0aGUgZXhhY3QgY29uZmxhdGlvbiB0aGUgaG91c2Unc1xuICogYG51bGxgLW5vdC1gMGAgcnVsZSBleGlzdHMgdG8gcHJldmVudC4gUmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYyxcbiAqIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLCBuZXZlciBhIHBhcnRpYWxcbiAqIGZpbGUuXG4gKlxuICogRml4ZWQgaW4gZ2xhbW91ciAyMDI2LTA5LTA3LCBmb3VuZCBzdGFuZGluZyBpbiB0aHJlZSBzaWJsaW5ncyB0aGUgbmV4dCBkYXkgYnlcbiAqIHRoZSBkdXBsaWNhdGlvbiByZWNvbiwgYW5kIHJlcGFpcmVkIGluIGFsbCBvZiB0aGVtIHRoZSBvbmx5IHdheSB0aGF0IGRvZXMgbm90XG4gKiBuZWVkIGZpbmRpbmcgYWdhaW46IHRoZXJlIGlzIG5vdyBvbmUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4pqgIFRoZSB0ZW1wIG5hbWUgY2FycmllcyB0aGUgcGlkLCBzbyB0d28gZGFlbW9ucyByYWNpbmcgdG8gcHVibGlzaCB0aGUgc2FtZVxuICogcG9pbnRlciBjYW5ub3QgY2xvYmJlciBlYWNoIG90aGVyJ3MgaW50ZXJtZWRpYXRlIGZpbGUg4oCUIGFuZCBpdCBpcyByZW1vdmVkIG9uXG4gKiBhIGZhaWxlZCB3cml0ZSByYXRoZXIgdGhhbiBsZWZ0IGFzIGxpdHRlciBiZXNpZGUgdGhlIHJlYWwgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVGaWxlQXRvbWljKHRhcmdldDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModG1wLCB0ZXh0KTtcbiAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiB0aGUgdGVtcCBmaWxlIGlzIGFscmVhZHkgZ29uZSwgb3Igd2FzIG5ldmVyIGNyZWF0ZWQgKi9cbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogRGVsZXRlIGBwYXRoYCBpZmYgaXQgc3RpbGwgbmFtZXMgVVMuIFJldHVybnMgd2hldGhlciBpdCB3YXMgZGVsZXRlZC5cbiAqXG4gKiDim5QgKipcIlNUSUxMIE9VUlNcIiBJUyBUSEUgV0hPTEUgRlVOQ1RJT04uKiogQSBkYWVtb24gdGhhdCB1bmxpbmtzIGl0cyBkaXNjb3ZlcnlcbiAqIGZpbGUgdW5jb25kaXRpb25hbGx5IGF0IGV4aXQgZGVsZXRlcyB0aGUgcG9pbnRlciBhIFNVQ0NFU1NPUiBoYXMgYWxyZWFkeVxuICogd3JpdHRlbiDigJQgdGhlIHN1Y2Nlc3NvciBjYW4gdGhlbiBubyBsb25nZXIgYmUgZm91bmQgYW5kIHRoZSBuZXh0IENMSSB2ZXJiIHNwYXducyBhXG4gKiB0aGlyZCBkYWVtb24uIEJvdGggY29udmVudGlvbnMgaGF2ZSB0aGlzIGhhemFyZCBhbmQgYm90aCBleHByZXNzIGl0XG4gKiBkaWZmZXJlbnRseTogYXN0cm9sYWJlIGNvbXBhcmVzIHRoZSBwaWQgZmlsZSdzIGJ5dGVzIHRvIGl0cyBvd24gcGlkLFxuICogbWFncGllIHBhcnNlcyB0aGUgSlNPTiBwb2ludGVyIGFuZCBjb21wYXJlcyBgc2Vzc2lvbl9pZGAuIGBpZGVudGlmeWAgaXMgd2hhdFxuICogbWFrZXMgdGhvc2Ugb25lIGZ1bmN0aW9uIOKAlCBpdCB0dXJucyB0aGUgZmlsZSdzIGJ5dGVzIGludG8gdGhlIGlkZW50aXR5IHRvXG4gKiBjb21wYXJlLCBhbmQgaXQgZGVmYXVsdHMgdG8gdGhlIHRyaW1tZWQgYnl0ZXMgdGhlbXNlbHZlcy5cbiAqXG4gKiDimqAgRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgYW5kIHJlcG9ydGVkIGFzIGBmYWxzZWA6IHRoZSBmaWxlIGJlaW5nIGdvbmUsXG4gKiB1bnJlYWRhYmxlLCBvciB1bnBhcnNlYWJsZSBhbGwgbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlIOKAlCBpdCBpcyBub3Qgb3VycyB0b1xuICogcmVtb3ZlLiBBbiB1bnBhcnNlYWJsZSBwb2ludGVyIGlzIGRlbGliZXJhdGVseSBOT1QgdHJlYXRlZCBhcyBvdXJzLCB3aGljaCBpc1xuICogdGhlIGNvbnNlcnZhdGl2ZSBoYWxmIG9mIHRoZSBzYW1lIGBudWxsYC1ub3QtYDBgIHJ1bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxpbmtJZk1hdGNoZXMoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IHN0cmluZyxcbiAgaWRlbnRpZnk6IChyYXc6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbCA9IChyYXcpID0+IHJhdy50cmltKCksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaWRlbnRpZnkocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgIT09IGV4cGVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdW5saW5rU3luYyhwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGluLXByb2Nlc3MgZXZlbnQgbG9nIOKAlCB0aGUgYXBwZW5kLW9ubHksIHJlcGxheWFibGUgYnVmZmVyXG4gKiBiZWhpbmQgZXZlcnkgc3BlbGwncyBgR0VUIC9ldmVudHNgIFNTRSB0YWlsLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3NcbiAqIGBzY3JpcHRzL2V2ZW50cy50c2Ag4oCUIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzIsIGFuZCB0aGUgb25seSBvbmUgb2ZcbiAqIHRoZSBzaXggY29waWVkLWluLXBsYWNlIGJ1c2VzIHRoYXQgaXMgYSBtb2R1bGUsIGlzIGJvdW5kZWQsIGNhcnJpZXMgYW4gZXBvY2gsIGFuZCBpc1xuICogdW5pdC10ZXN0ZWQuIFRoZSBmaXZlIG90aGVycyBhcmUgdGhlIHNhbWUgdHdlbnR5IGxpbmVzIHdyaXR0ZW4gZml2ZSB0aW1lcy5cbiAqXG4gKiDilIDilIAgVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIOKAlCBUV08gQlkgQ09OU1RSVUNUSU9OLCBPTkUgQlkgT1BULUlOIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIOKblCBUSEUgSEVBRElORyBVU0VEIFRPIFNBWSBcIlRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyBCWSBDT05TVFJVQ1RJT05cIiBBTkRcbiAqIElURU0gMiBJUyBOT1QgT05FIE9GIFRIRU0uIENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIG1pbmQtbWFwcGVyJ3MgcHJlLXdvcmtcbiAqIChENzkpOiBgZXBvY2hgIGlzIE9QVElPTkFMIGhlcmUsIHNvIEw2IGlzIGNsb3NlZCBvbmx5IGZvciBhIGNhbGxlciB0aGF0IGFza3MuXG4gKiBUaHJlZSBhZG9wdGVycyBoYXZlIHNpbmNlIGRlY2xpbmVkIHRvIOKAlCBpbWFnbyAoRDM5KSwgYm91bnR5IChENDgpIGFuZFxuICogZ3JhcGV2aW5lIChENzApIOKAlCBzbyB0aGUgZGVmZWN0IHRoZSBoZWFkaW5nIGNsYWltZWQgdG8gbWFrZSBpbXBvc3NpYmxlIGlzXG4gKiBsaXZlIGluIHRoZSB0cmVlLCBieSBvcHQtb3V0LCBhbmQgdGhlIG92ZXJjbGFpbSBpcyB3aGF0IGhpZCB0aGF0LiBJdGVtcyAxIGFuZFxuICogMyBBUkUgYnkgY29uc3RydWN0aW9uOiBhIGNhbGxlciBjYW5ub3Qgc3dpdGNoIHRoZSBjYXAgb2ZmIG9yIHJlYWNoIHRoZSBidWZmZXIuXG4gKlxuICog4pqgIEFORCBNSU5ELU1BUFBFUidTIE9XTiBCVVMsIFdISUNIIFRISVMgTU9EVUxFIENPTlZFUkdFRCBUT1dBUkQsIFRZUEVTIFRIRVxuICogRVBPQ0ggQVMgUkVRVUlSRUQgYW5kIHN0YW1wcyBpdCB1bmNvbmRpdGlvbmFsbHkg4oCUIGl0IGlzIHRoZSBzcGVsbCBjZW5zdXMgTDZcbiAqIG5hbWVzIGFzIENPUlJFQ1QuIE1ha2luZyBpdCByZXF1aXJlZCBIRVJFIGlzIG5vdCB0aGUgcmVwYWlyOiBpdCB3b3VsZCByZXZlcnNlXG4gKiBEMzksIEQ0OCBhbmQgRDcwLiBUaGUgaG9uZXN0IHN0YXRlbWVudCBpcyB0aGlzIGhlYWRpbmcuXG4gKlxuICog4puUICoqUkVTT0xWRUQgQVQgVEhBVCBTUEVMTCdTIFBPUlQsIEFORCBUSEUgRElTUE9TSVRJT04gSVMgUkVDT1JERUQgSEVSRVxuICogQkVDQVVTRSBBIExPU1MgVEhBVCBMSVZFUyBPTkxZIElOIEEgSk9VUk5BTCBJUyBBIExPU1MgTk9CT0RZIENBTiBTRUVcbiAqIChENzkvRDg1KS4qKiBtaW5kLW1hcHBlciBhZG9wdGVkIHRoaXMgbW9kdWxlIGluIFBoYXNlIDcgYW5kIGtlcHQgaXRzXG4gKiBndWFyYW50ZWUgV0lUSE9VVCBBIEtJVCBDSEFOR0U6IGl0IHBhc3NlcyBgeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9YCBhdFxuICogaXRzIE9ORSBjb25zdHJ1Y3Rpb24gc2l0ZSBhbmQgcmUtdGlnaHRlbnMgYGVwb2NoYCB0byBSRVFVSVJFRCBpbiBpdHMgb3duXG4gKiBsb2NhbCBmcmFtZSB0eXBlLCBzbyBub3RoaW5nIGl0cyBidXMgZW1pdHMgY2FuIGxhY2sgb25lLiBLaXQgYnl0ZXM6IHplcm8uXG4gKiAqKlNvIHRoZSBlcG9jaCBpcyBhIExPU1NZLUNPUFkgcHJvcGVydHkgd2hvc2UgZGlzcG9zaXRpb24gaXMgS0VFUC1MT0NBTCwgbm90XG4gKiBSRVNUT1JFKiog4oCUIHRoZSBvbmx5IHByb3BlcnR5IG9mIHRoYXQgc3BlbGwncyBvd24gbW9kdWxlIHRoaXMgbW9kdWxlIGNvdWxkXG4gKiBub3QgY2FycnkgYW5kIGRpZCBub3QgbmVlZCB0by4gTDYgaXMgQ0xPU0VEIGZvciB0aGUgdHdvIHNwZWxscyB0aGF0IGFzayBhbmRcbiAqIE9QRU4sIGJ5IG9wdC1vdXQsIGZvciB0aGUgdGhyZWUgdGhhdCBkZWNsaW5lOyB0aGF0IGFzeW1tZXRyeSBpcyB0aGUgaG9uZXN0XG4gKiBzdGF0ZSBhbmQgdGhpcyBoZWFkaW5nIGlzIHdoZXJlIGl0IGlzIHdyaXR0ZW4uXG4gKlxuICog4pqgICoqQU5EIFRIRSBBRE9QVElPTiBSRU5BTUVTIEEgRklFTEQgT04gQU4gQURPUFRFUidTIFBVQkxJU0hFRCBXSVJFLioqIGBpZGBcbiAqIGlzIG5hbWVkIGluIGBGcmFtZTxUPmAgYW5kIGluIHRoZSBlbWl0IGxpdGVyYWwgYmVsb3csIHNvIGEgc3BlbGwgd2hvc2UgYnVzXG4gKiBzcGVsbGVkIHRoZSBjdXJzb3IgYW55dGhpbmcgZWxzZSBwYXlzIGEgcmVuYW1lIGF0IGV2ZXJ5IHJlYWRlciDigJQgZm9yXG4gKiBtaW5kLW1hcHBlciwgMTczIG9jY3VycmVuY2VzIGFjcm9zcyA1IHN1cmZhY2UgZmlsZXMsIH4yMDkgYWNyb3NzIH4zMCBiYWNrZW5kXG4gKiBmaWxlcywgZXZlcnkgSlNPTkwgbGluZSBpdHMgYHRhaWxgIHdyaXRlcyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgYW5kICh0aGUgb25lXG4gKiBub2JvZHkgY291bnRlZCkgdGhlIEZJWFRVUkUgaW4gaXRzIG93biBgdGFpbC50ZXN0LnRzYCwgd2hpY2ggV1JJVEVTIHRoZVxuICogZW52ZWxvcGUgd2hpbGUgc3RhbmRpbmcgaW4gZm9yIHRoZSBkYWVtb24uIFRoZSBORVNUSU5HIGlzIG5vdCBmb3JjZWQg4oCUXG4gKiBgRnJhbWU8VD5gIGlzIGdlbmVyaWMsIGFuZCBtaW5kLW1hcHBlciBrZXB0IGB7a2luZCwgcGF5bG9hZH1gIG5lc3RlZCB3aGVyZSBhbGxcbiAqIGZpdmUgZWFybGllciBhZG9wdGVycyBmbGF0dGVuIGJ5IGlkaW9tLiAqKkFuIGlkaW9tIGZpdmUgc2libGluZ3Mgc2hhcmUgaXNcbiAqIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBjb250cmFjdCB1bnRpbCB5b3Ugb3BlbiB0aGUgdHlwZSoqIChEODEsIEQ4NikuXG4gKlxuICogKioxIMK3IEw1IOKAlCB0aGUgYnVmZmVyIGlzIGJvdW5kZWQuKiogRml2ZSBkYWVtb25zIGFwcGVuZCB0byBhbiBhcnJheSBmb3IgdGhlXG4gKiB3aG9sZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBUaGUgd2luZG93IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiBkYWVtb24ncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2c7IGEgY2FwIGlzIHRoZSBob25lc3Qgc2hhcGUuXG4gKlxuICogKioyIMK3IEw2IOKAlCBhIGZyYW1lIGNhcnJpZXMgYW4gZXBvY2gsIFdIRU4gVEhFIENBTExFUiBBU0tTIEZPUiBPTkUgKG9wdC1pbixcbiAqIG5vdCBjb25zdHJ1Y3Rpb24g4oCUIHNlZSBhYm92ZSkuKiogQWZ0ZXIgYSByZXN0YXJ0IHRoZSBpZHMgc3RhcnQgYWdhaW4gYXQgMSwgc29cbiAqIGEgcmVzdW1pbmcgY2xpZW50IGNhbm5vdCB0ZWxsIGEgc3RhbGUgd2F0ZXJtYXJrIGZyb20gYSBmcmVzaCBvbmUgYnkgaWQgYWxvbmUuXG4gKlxuICogKiozIMK3IEEgU1RBTEUgV0FURVJNQVJLIFJFUExBWVMgRlJPTSBUSEUgQkVHSU5OSU5HLCBhbmQgdGhpcyBpcyB0aGUgaGFsZiB0aGVcbiAqIGNsaWVudCBjYW5ub3QgZG8uKiogTUVBU1VSRUQgb24gYXN0cm9sYWJlOiBhIHRhaWwgdGhhdCByZXN1bWVzIGF0XG4gKiBgc2luY2U9PGxhc3QgaWQgb2YgdGhlIHByZXZpb3VzIGRhZW1vbj5gIGFnYWluc3QgYSByZXN0YXJ0ZWQgZGFlbW9uIHJlY2VpdmVzXG4gKiBOT1RISU5HIOKAlCB0aGUgbmV3IGRhZW1vbidzIGByZWFkeWAgaXMgaWQgMSwgd2hpY2ggaXMgbm90IGA+IHNpbmNlYCwgc28gdGhlXG4gKiBmaWx0ZXIgZHJvcHMgaXQsIHNvIG5vIGZyYW1lIGFycml2ZXMsIHNvIHRoZSBjbGllbnQncyBlcG9jaCBjaGVjayBuZXZlciBydW5zXG4gKiBhbmQgdGhlIHRhaWwgc2l0cyBjb25uZWN0ZWQgYW5kIHNpbGVudCB1bnRpbCB0aGUgbmV3IGRhZW1vbiBoYXMgZW1pdHRlZCBhc1xuICogbWFueSBldmVudHMgYXMgdGhlIG9sZCBvbmUgZGlkLiBTdGFtcGluZyBhbiBlcG9jaCBhbG9uZSBkb2VzIE5PVCBjbG9zZSB0aGF0XG4gKiBnYXA6IHRoZSBlcG9jaCByaWRlcyBhIGZyYW1lLCBhbmQgdGhlIGJ1ZyBpcyB0aGF0IG5vIGZyYW1lIGlzIHNlbnQuIFNvXG4gKiBgc3Vic2NyaWJlYCB0cmVhdHMgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYW5vdGhlciBwcm9jZXNzXCJcbiAqIGFuZCByZXBsYXlzIHdob2xlLiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuIE5vdFxuICogXCJubyBzdWJqZWN0XCIg4oCUIGdyYXBldmluZSBIQVMgYW4gZXZlbnQgYnVzIGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGVcbiAqIHNwZWxsIOKAlCBidXQgdGhlIHR3byBzaGFwZXMgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBvbmUgcHJvY2Vzcy13aWRlIGFycmF5IGNhcHBlZCBhdCBSRVBMQVlfQlVGRkVSX1NJWkUsIHdpdGggb25lXG4gKiAgICAgICAgICAgICAgICBtb25vdG9uaWMgYHNlcWAsIGFuZCB0aGUgaGVhZGVyIHRocmVlIHBhcmFncmFwaHMgdXAgc2F5cyBpbiBhc1xuICogICAgICAgICAgICAgICAgbWFueSB3b3JkcyB0aGF0IGl0IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiAgICAgICAgICAgICAgICBkYWVtb24ncyBsaWZldGltZSwgTk9UIGEgZHVyYWJsZSBsb2cuXG4gKiAgIGdyYXBldmluZSAgICBOIGR1cmFibGUgYXBwZW5kLW9ubHkgYC5qc29ubGAgZmlsZXMsIG9uZSBwZXIgbmFtZWQgY2hhbm5lbCxcbiAqICAgICAgICAgICAgICAgIGVhY2ggd2l0aCBpdHMgb3duIGBuZXh0X2lkYCwgcmVwbGF5ZWQgZnJvbSBkaXNrIGJ5XG4gKiAgICAgICAgICAgICAgICBgcmVhZEJhY2tsb2dgLCBzdXJ2aXZpbmcgcmVzdGFydCwgYHJvbGxgLCBhcmNoaXZlIGFuZCBjbGVhci5cbiAqXG4gKiAqKlRoZSByZWFkZXIgdGhhdCBtYWtlcyB0aGVtIGluY29tcGF0aWJsZSwgYXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhblxuICogYXNzZXJ0aW9uOioqIGdyYXBldmluZSdzIGBsb2FkQ2hhbm5lbCgpYCBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIEhJR0gtV0FURVJcbiAqIE1BUksgb3ZlciBldmVyeSBwYXJzZWFibGUgbGluZSBvZiB0aGUgY2hhbm5lbCdzIGZpbGUgb24gYm9vdC4gVGhlcmUgaXMgbm9cbiAqIGFycmF5IHRvIGJlIHRoYXQgbWFyayBvZiwgYW5kIG5vIGNhcCB0aGF0IHdvdWxkIG5vdCBzaWxlbnRseSBkaXNjYXJkIGhpc3RvcnlcbiAqIGEgY2FsbGVyIGNhbiBzdGlsbCBhc2sgZm9yIGJ5IGlkLiBJdCBpcyB0aGUgdGhpbmcgdGhpcyBtb2R1bGUncyBvd24gaGVhZGVyXG4gKiBzYXlzIGl0IGlzIGRlbGliZXJhdGVseSBub3QuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGEgcGVyLWNoYW5uZWwgZHVyYWJsZVxuICogc3RvcmUgd291bGQgY2hhbmdlIGBjcmVhdGVFdmVudExvZ2AncyBzdG9yYWdlIGFuZCBpdHMgYHN1YnNjcmliZWAgY29udHJhY3QgZm9yXG4gKiBmaXZlIG90aGVyIGRhZW1vbnMsIHJlLWVtaXR0aW5nIFNJWCBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYVxuICogZHJpdmUg4oCUIHBhaWQgYnkgcG9ydHMgdGhhdCBhcmUgYWxyZWFkeSBmaW5pc2hlZCBhbmQgYnkgYWdlbnRzIG5vdCBpbiB0aGUgcm9vbS5cbiAqIEEgd2lkZW5pbmcgcmVtYWlucyBhdmFpbGFibGUgYXMgaXRzIG93biBhcmd1ZWQgZGVjaXNpb24gd2l0aCBpdHMgb3duXG4gKiBibGFzdC1yYWRpdXMgY291bnQ7IGl0IGlzIG5ldmVyIGEgc3RlcCBpbnNpZGUgYSBwb3J0LlxuICpcbiAqIOKaoCBBTkQgVEhFIGBlcG9jaGAgQUJPVkUgSVMgVEhFIFNIQVJQRVNUIEhBTEYgT0YgV0hZIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlXG4gKiBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCwgc28gdGhlIGNvbmRpdGlvbiBwYXJhZ3JhcGggMiBkZXNjcmliZXMg4oCUIGlkc1xuICogc3RhcnRpbmcgYWdhaW4gYXQgMSDigJQgY2Fubm90IG9jY3VyIHRoZXJlLCBhbmQgc3RhbXBpbmcgb25lIGFueXdheSBpcyBub3RcbiAqIGluZXJ0OiBgdGFpbEV2ZW50c2AncyBgb25FcG9jaENoYW5nZWAgc2V0cyB0aGUgY3Vyc29yIHRvIDAsIGFuZCBncmFwZXZpbmUnc1xuICogdGFpbCByb3V0ZSBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoIHRoZSBXSE9MRSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhblxuICogYWdlbnQncyBwaXBlLCBvbiBldmVyeSBgcm9sbGAuIFRoZSBlcG9jaCdzIGNsaWVudC1zaWRlIGFjdGlvbiBpcyBcInlvdXIgY3Vyc29yXG4gKiBpcyB3b3J0aGxlc3MsIHN0YXJ0IG92ZXJcIiwgYW5kIHRoYXQgaXMgc2FmZSBvbmx5IHdoZXJlIHN0YXJ0aW5nIG92ZXIgY29zdHMgYVxuICogYm91bmRlZCBpbi1tZW1vcnkgcmVwbGF5IHdpbmRvdy5cbiAqL1xuXG4vKiogVGhlIGRlZmF1bHQgcmVwbGF5IHdpbmRvdywgaW5oZXJpdGVkIGZyb20gbWluZC1tYXBwZXIncyBtZWFzdXJlZCBjYXAuICovXG5leHBvcnQgY29uc3QgUkVQTEFZX0JVRkZFUl9TSVpFID0gMTAwMDtcblxuLyoqIEEgZnJhbWUgYXMgaXQgZ29lcyBvbiB0aGUgd2lyZTogdGhlIGNhbGxlcidzIHBheWxvYWQgcGx1cyBhIG1vbm90b25pYyBgaWRgLFxuICogIHBsdXMgYW4gYGVwb2NoYCB3aGVuIHRoZSBsb2cgd2FzIGdpdmVuIG9uZS4gKi9cbmV4cG9ydCB0eXBlIEZyYW1lPFQ+ID0gVCAmIHsgaWQ6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBFdmVudExvZzxUPiB7XG4gIC8qKiBBcHBlbmQgb25lIGZyYW1lLCBmYW4gaXQgb3V0IHRvIGxpdmUgc3Vic2NyaWJlcnMsIGFuZCByZXR1cm4gaXQuICovXG4gIGVtaXQobXNnOiBUKTogRnJhbWU8VD47XG4gIC8qKlxuICAgKiBSZXBsYXkgZXZlcnl0aGluZyBhZnRlciBgc2luY2VgLCB0aGVuIHN0YXkgc3Vic2NyaWJlZC4gUmV0dXJucyBhblxuICAgKiB1bnN1YnNjcmliZSBmdW5jdGlvbi5cbiAgICpcbiAgICog4puUIFJFUExBWSBBTkQgU1VCU0NSSUJFIEFSRSBPTkUgQ0FMTCBPTiBQVVJQT1NFLiBEb2luZyB0aGVtIGluIHR3byBzdGVwc1xuICAgKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYW4gZW1pdCBsYW5kcyBiZXR3ZWVuIHRoZSByZXBsYXkgbG9vcCBhbmQgdGhlXG4gICAqIGBhZGRgLCBhbmQgdGhhdCBmcmFtZSBpcyBkZWxpdmVyZWQgdG8gbm9ib2R5IOKAlCB0aGUgc2hhcGUgZml2ZSBkYWVtb25zIGhhdmUsXG4gICAqIHN1cnZpdmVkIGJ5IG5vdGhpbmcgYnV0IHRoZSBzaW5nbGUtdGhyZWFkZWQgZXZlbnQgbG9vcCBoYXBwZW5pbmcgdG8gY2xvc2VcbiAgICogaXQuIERlcGVuZGluZyBvbiB0aGF0IGlzIGRlcGVuZGluZyBvbiBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgb2YgdGhlXG4gICAqIHJ1bnRpbWUgcmF0aGVyIHRoYW4gb24gdGhlIGNvZGUuXG4gICAqL1xuICBzdWJzY3JpYmUoc2luY2U6IG51bWJlciwgbGlzdGVuZXI6IChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGhpZ2hlc3QgaWQgZW1pdHRlZCBzbyBmYXIg4oCUIHdoYXQgYEdFVCAvc3RhdGVgIHJldHVybnMgYXMgYGN1cnNvcmAuICovXG4gIGN1cnNvcigpOiBudW1iZXI7XG4gIC8qKiBUaGUgZXBvY2ggc3RhbXBlZCBvbiBldmVyeSBmcmFtZSwgb3IgYHVuZGVmaW5lZGAgaWYgbm9uZSB3YXMgY29uZmlndXJlZC4gKi9cbiAgcmVhZG9ubHkgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50TG9nPFQgZXh0ZW5kcyBvYmplY3Q+KFxuICBvcHRzOiB7IGVwb2NoPzogc3RyaW5nOyBidWZmZXJTaXplPzogbnVtYmVyIH0gPSB7fSxcbik6IEV2ZW50TG9nPFQ+IHtcbiAgY29uc3QgYnVmZmVyU2l6ZSA9IG9wdHMuYnVmZmVyU2l6ZSA/PyBSRVBMQVlfQlVGRkVSX1NJWkU7XG4gIGNvbnN0IGVwb2NoID0gb3B0cy5lcG9jaDtcbiAgY29uc3QgYnVmZmVyOiBBcnJheTxGcmFtZTxUPj4gPSBbXTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IFNldDwoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkPigpO1xuICBsZXQgc2VxID0gMDtcblxuICByZXR1cm4ge1xuICAgIGVwb2NoLFxuXG4gICAgZW1pdChtc2cpIHtcbiAgICAgIHNlcSArPSAxO1xuICAgICAgLy8g4puUIFRIRSBNT05PVE9OSUMgSUQgV0lOUyBPVkVSIEFOWVRISU5HIElOIFRIRSBQQVlMT0FELCBBTkQgVU5USUwgTk9XIElUXG4gICAgICAvLyBPTkxZIENMQUlNRUQgVE8uIEJvdGggYWRvcHRpbmcgZGFlbW9ucyB3cm90ZSBgeyBpZDogKytzZXEsIC4uLm1zZyB9YFxuICAgICAgLy8gdW5kZXIgYSBjb21tZW50IHNheWluZyBcInRoZSBtb25vdG9uaWMgYGlkYCBNVVNUIHdpbiBvdmVyIGFueSBgaWRgIGluXG4gICAgICAvLyB0aGUgcGF5bG9hZCwgc28gY2FsbGVycyBjYXJyeSBhIHByb2plY3QgaWRlbnRpZmllciBhcyBgcHJvamVjdElkYCxcbiAgICAgIC8vIG5ldmVyIGBpZGBcIiDigJQgYnV0IHNwcmVhZCBvcmRlciBtZWFucyBhIHBheWxvYWQgYGlkYCBvdmVycm9kZSB0aGVcbiAgICAgIC8vIGN1cnNvciwgc2lsZW50bHksIGFuZCB0aGUgY29udmVudGlvbiBpbiB0aGUgY29tbWVudCB3YXMgdGhlIG9ubHkgdGhpbmdcbiAgICAgIC8vIGhvbGRpbmcgaXQuIFRoZSBsaXRlcmFsIGtlZXBzIGBpZGAgRklSU1Qgc28gdGhlIHdpcmUga2V5IG9yZGVyIGlzXG4gICAgICAvLyB1bmNoYW5nZWQ7IHRoZSBhc3NpZ25tZW50IGFmdGVyIHRoZSBzcHJlYWQgaXMgd2hhdCBtYWtlcyB0aGUgc2VudGVuY2VcbiAgICAgIC8vIHRydWUuIGBlcG9jaGAgaXMgc3RhbXBlZCB0aGUgc2FtZSB3YXkgYW5kIGZvciB0aGUgc2FtZSByZWFzb24uXG4gICAgICBjb25zdCBmcmFtZSA9IHsgaWQ6IHNlcSwgLi4ubXNnIH0gYXMgRnJhbWU8VD47XG4gICAgICBmcmFtZS5pZCA9IHNlcTtcbiAgICAgIGlmIChlcG9jaCAhPT0gdW5kZWZpbmVkKSBmcmFtZS5lcG9jaCA9IGVwb2NoO1xuXG4gICAgICBidWZmZXIucHVzaChmcmFtZSk7XG4gICAgICBpZiAoYnVmZmVyLmxlbmd0aCA+IGJ1ZmZlclNpemUpIGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCBsaXN0ZW5lciBvZiBsaXN0ZW5lcnMpIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIHJldHVybiBmcmFtZTtcbiAgICB9LFxuXG4gICAgc3Vic2NyaWJlKHNpbmNlLCBsaXN0ZW5lcikge1xuICAgICAgLy8gU2VlIHRoZSBoZWFkZXIsIHBvaW50IDM6IGEgY3Vyc29yIGJleW9uZCBvdXIgb3duIGlzIGEgY3Vyc29yIGZyb20gYVxuICAgICAgLy8gUFJJT1IgUFJPQ0VTUywgYW5kIHRoZSBvbmx5IHVzZWZ1bCByZWFkaW5nIG9mIGl0IGlzIFwicmVwbGF5IHdob2xlXCIuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEEgTk9OLUZJTklURSBDVVJTT1IgQUxTTyBNRUFOUyBcIkZST00gVEhFIFNUQVJUXCIsIHdoaWNoIHRoZSBjb3BpZXMgZ290XG4gICAgICAvLyB3cm9uZyBieSBhY2NpZGVudDogdGhleSB3cm90ZSBgcGFyc2VJbnQocGFyYW0gPz8gXCItMVwiKWAgYW5kIGNvbXBhcmVkXG4gICAgICAvLyBgaWQgPiBzaW5jZWAsIHNvIGEgdHlwbydkIGA/c2luY2U9eGAgcHJvZHVjZWQgYE5hTmAsIGV2ZXJ5IGNvbXBhcmlzb25cbiAgICAgIC8vIHdhcyBmYWxzZSwgYW5kIHRoZSB0YWlsIG9wZW5lZCBFTVBUWSBhbmQgc3RheWVkIGNvbm5lY3RlZCDigJQgdGhlIHNhbWVcbiAgICAgIC8vIHNpbGVudC1hbmQtY29ubmVjdGVkIHN5bXB0b20gYXMgdGhlIHN0YWxlIHdhdGVybWFyaywgZnJvbSBhIGRpZmZlcmVudFxuICAgICAgLy8gY2F1c2UuIEFic2VudCBhbmQgdW5wYXJzZWFibGUgYXJlIHRoZSBzYW1lIHJlcXVlc3QgaGVyZS5cbiAgICAgIGNvbnN0IGZyb20gPSAhTnVtYmVyLmlzRmluaXRlKHNpbmNlKSB8fCBzaW5jZSA+IHNlcSA/IC0xIDogc2luY2U7XG4gICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGJ1ZmZlcikge1xuICAgICAgICBpZiAoZnJhbWUuaWQgPiBmcm9tKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICB9XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgIGxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgICAgfTtcbiAgICB9LFxuXG4gICAgY3Vyc29yKCkge1xuICAgICAgcmV0dXJuIHNlcTtcbiAgICB9LFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBkYWVtb24gbGlmZWN5Y2xlIHRhaWw6IHRoZSBpZGxlLWNsb3NlIGRlY2lzaW9uLCB0aGUgc3dlZXBcbiAqIHRoYXQgbWFrZXMgaXQsIGFuZCB0aGUgYm91bmRlZCB0ZWFyZG93bi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBib3VudHkg4oCUIHRoZSBjZW5zdXMnc1xuICogY29udmVyZ2VuY2UgdGFyZ2V0ICMzIOKAlCB3aXRoIGFzdHJvbGFiZSdzIGB0aW1lb3V0TXMgPiAwYCBndWFyZCBmb2xkZWQgaW4sXG4gKiB3aGljaCBpcyB0aGUgb25lIHRoaW5nIGJvdW50eSdzIGNvcHkgZG9lcyBub3QgZXhwcmVzcy5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBBRE9QVFMgYGRyYWluQW5kU3RvcGAgQU5EIE5PVEhJTkcgRUxTRSBIRVJFIOKAlCBTUExJVCBQRVIgRVhQT1JUXG4gKlxuICogUnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KSwgYW5kIGl0IGlzIHdyaXR0ZW4gZG93blxuICogYmVjYXVzZSBhIHJvdyBpcyBhIE1PRFVMRSBhbmQgXCJwYXJ0aWFsXCIgaXMgbm90IGFuIGFuc3dlciB1bnRpbCBpdCBzYXlzIHdoaWNoXG4gKiBleHBvcnRzLiBHcmFwZXZpbmUgaXMgbG9uZy1ydW5uaW5nLCBzbyBub3RoaW5nIGFib3V0IGl0cyBsaWZlY3ljbGUgbWFrZXMgdGhpc1xuICogbW9kdWxlIHJlYWQgYXMgaW5hcHBsaWNhYmxlIOKAlCBhbmQgdHdvIG9mIGl0cyB0aHJlZSBleHBvcnRzIHN0aWxsIGhhdmUgbm9cbiAqIHN1YmplY3QgdGhlcmU6XG4gKlxuICogICBgc2hvdWxkSWRsZUNsb3NlYCAgICAgIE5PIFNVQkpFQ1QuIEdyYXBldmluZSBydW5zIG5vIGlkbGUgc3dlZXAgYW5kIGhhcyBub1xuICogICBgc3RhcnRIb3VzZWtlZXBpbmdgICAgIGAtLXRpbWVvdXRgOyBpdCBpcyBhIGJyb2tlciB0aGF0IHN0YW5kcyB1bnRpbCBgc3RvcGBcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAoYERFTEVURSAvYCkgb3IgYSBzaWduYWwsIGFuZCBpdCB0YWtlcyBubyBzbmFwc2hvdC5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBBZG9wdGluZyB0aGUgcGFpci1tYW5hZ2VyIHdvdWxkIG1lYW4gd3JpdGluZyBhIG5vLW9wXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHRvdWNoYCBhbmQgYSBgc3Vic2NyaWJlckNvdW50YCB0aGF0IGV4aXN0cyBvbmx5IHRvXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGEgbnVtYmVyIG5vYm9keSBhY3RzIG9uIOKAlCB0d28gbGllcyB0byBnYWluIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgY2xlYXJJbnRlcnZhbGAuXG4gKiAgIGBkcmFpbkFuZFN0b3BgICAgICAgICAgQURPUFRFRCwgYW5kIGl0IGlzIGEgREUtRFVQTElDQVRJT04gcmF0aGVyIHRoYW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGdhaW46IGdyYXBldmluZSdzIHRlYXJkb3duIGFscmVhZHkgV0FTXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIDIwMCBtc10pYCwgd2hpY2ggaXNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgc3RvcE1zYCBleGFjdGx5LlxuICpcbiAqIOKaoCAqKkFORCBJVCBJUyBDQUxMRUQgV0lUSCBOTyBgY2xpZW50c2AsIFdISUNIIElTIEEgTUVBU1VSRU1FTlQsIE5PVCBBTlxuICogT1ZFUlNJR0hULioqIFRoaXMgbW9kdWxlIGNsb3NlcyBhIGhlbGQgY29ubmVjdGlvbiBieSBjYWxsaW5nIGBjbGllbnQuY2xvc2UoKWA7XG4gKiBncmFwZXZpbmUncyBzdWJzY3JpYmVyIHJlY29yZHMgYXJlIGB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfWAgYW5kIGNhcnJ5IG5vXG4gKiBgY2xvc2VgIOKAlCBpdHMgcGVyLXN0cmVhbSB0ZWFyZG93biBpcyBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW1cbiAqIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb20gYGNhbmNlbCgpYC4gVGhlcmUgaXMgbm90aGluZyB0byBoYW5kIHRoZVxuICogYXJndW1lbnQuIGBzc2UudHNgJ3MgaGVhZGVyIGNhcnJpZXMgdGhlIHJlc3Qgb2YgdGhhdCBydWxpbmcsIGluY2x1ZGluZyB0aGVcbiAqIHdpZGVuaW5nIG5vdCBkb25lIGFuZCBpdHMgY29zdCAoc2l4IGFydGlmYWN0cyBhY3Jvc3MgZml2ZSBzcGVsbHMpLlxuICpcbiAqIOKaoCBHcmFwZXZpbmUgYWxzbyBwYXNzZXMgYGdyYWNlTXM6IDBgLiBOb3QgYSBkaXNhZ3JlZW1lbnQgd2l0aCB0aGUgZ3JhY2VcbiAqIHBlcmlvZDogaXQgZW1pdHMgbm8gZmFyZXdlbGwgZnJhbWUgYXQgZGFlbW9uIHNodXRkb3duLCBhbmQgaXRzIGBERUxFVEUgL2BcbiAqIGFscmVhZHkgcmV0dXJucyB0aGUgcmVzcG9uc2UgYW5kIHNjaGVkdWxlcyB0aGUgdGVhcmRvd24gMTAgbXMgbGF0ZXIsIHNvIGl0c1xuICogZmx1c2ggd2luZG93IHNpdHMgYXQgdGhlIHJvdXRlIHJhdGhlciB0aGFuIGluIHRoZSBkcmFpbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFNzZUNsaWVudHMgfSBmcm9tIFwiLi9zc2UudHNcIjtcblxuLyoqXG4gKiBTaG91bGQgdGhlIGRhZW1vbiBpZGxlLWNsb3NlP1xuICpcbiAqIOKblCAqKmBzdWJzY3JpYmVyQ291bnRgIElTIEEgUkVRVUlSRUQgQVJHVU1FTlQsIEFORCBUSEFUIElTIFRIRSBXSE9MRSBQT0lOVC4qKlxuICogVGhpcyBjbG9zZXMgY2Vuc3VzIGRlZmVjdCAqKkwxKiogYnkgY29uc3RydWN0aW9uOiBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllXG4gKiBjb3VudGVkIHRoZWlyIGlkbGUgZmxvb3IgZG93biB3aGlsZSBhbiBhZ2VudCBoZWxkIGEgdGFpbCBvcGVuLCBzbyBhbiBhZ2VudFxuICogd2F0Y2hpbmcgYSBxdWlldCBib2FyZCB3YXMga2lsbGVkIFdJVEggSVRTIENPTk5FQ1RJT04gT1BFTi4gVGhlcmUgaXMgbm9cbiAqIG92ZXJsb2FkIG9mIHRoaXMgZnVuY3Rpb24gdGhhdCBjYW5ub3Qgc2VlIGl0cyBzdWJzY3JpYmVycywgc28gdGhlIGRlZmVjdFxuICogY2Fubm90IGJlIHJlLWV4cHJlc3NlZCBieSBhIGNhbGxlciB3aG8gZm9yZ2V0cy5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNDQVIgSVQgQ0FNRSBXSVRILCByZS1ob21lZCBmcm9tIGJvdW50eSB2ZXJiYXRpbSBpbiBzdWJzdGFuY2U6KipcbiAqIGEgYm9hcmQgb25seSBjb3VudHMgaXRzIGlkbGUgZmxvb3IgZG93biB3aGlsZSBVTldBVENIRUQuIEEgbGl2ZSBzdWJzY3JpYmVyIOKAlFxuICogYSBicm93c2VyIFdlYlNvY2tldCwgb3IgYW4gYWdlbnQgU1NFIHRhaWwgb24gYC9ldmVudHNgIOKAlCBrZWVwcyBpdCBvcGVuXG4gKiBpbmRlZmluaXRlbHkuIFNvIGB0aW1lb3V0YCBtZWFucyBcImxpbmdlciB0aGlzIGxvbmcgYWZ0ZXIgdGhlIExBU1Qgc3Vic2NyaWJlclxuICogbGVhdmVzXCIsIE5PVCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi4gVGhlIHN3ZWVwIGJlbG93IGFsc28gdG91Y2hlcyB0aGVcbiAqIGFjdGl2aXR5IGNsb2NrIG9uIGV2ZXJ5IHRpY2sgd2hpbGUgd2F0Y2hlZCwgc28gb25jZSB1bndhdGNoZWQgdGhlIGZsb29yXG4gKiBjb3VudHMgZnJvbSB0aGF0IGxhc3QgZGlzY29ubmVjdCBhbmQgbm90IGZyb20gdGhlIGxhc3QgcmVxdWVzdC5cbiAqXG4gKiDimqAgYHRpbWVvdXRNcyA8PSAwYCBtZWFucyBORVZFUiwgd2hpY2ggaXMgYXN0cm9sYWJlJ3Mgc3RhbmRpbmctb2JzZXJ2YXRvcnlcbiAqIGRlZmF1bHQgYW5kIGlzIHdoeSB0aGUgZ3VhcmQgaXMgaGVyZSByYXRoZXIgdGhhbiBhdCBpdHMgb25lIGNhbGwgc2l0ZTogYVxuICogc2luZ2xldG9uIGRhZW1vbiBpcyBtZWFudCB0byBzdGFuZCB1bnRpbCBpdCBpcyBleHBsaWNpdGx5IGNsb3NlZCwgYW5kIGFcbiAqIGA+PSAwYCBjb21wYXJpc29uIHdvdWxkIGNsb3NlIGl0IG9uIHRoZSBmaXJzdCB0aWNrLlxuICpcbiAqIENsb2NrLWZyZWUgYW5kIGZzLWZyZWUsIHNvIGl0IGlzIHRlc3RhYmxlIHdpdGhvdXQgYSBkYWVtb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRJZGxlQ2xvc2UoXG4gIHN1YnNjcmliZXJDb3VudDogbnVtYmVyLFxuICBpZGxlTXM6IG51bWJlcixcbiAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKHRpbWVvdXRNcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvdXNla2VlcGluZ09wdGlvbnMge1xuICAvKiog4puUIFJFUVVJUkVELiBTZWUgYHNob3VsZElkbGVDbG9zZWAg4oCUIHRoaXMgaXMgd2hhdCBjbG9zZXMgTDEuICovXG4gIHN1YnNjcmliZXJDb3VudDogKCkgPT4gbnVtYmVyO1xuICAvKiogTWlsbGlzZWNvbmRzIHNpbmNlIHRoZSBsYXN0IGFjdGl2aXR5LiAqL1xuICBpZGxlTXM6ICgpID0+IG51bWJlcjtcbiAgLyoqIFJlc2V0IHRoZSBhY3Rpdml0eSBjbG9jay4gQ2FsbGVkIG9uIGV2ZXJ5IHRpY2sgdGhhdCBoYXMgYSBzdWJzY3JpYmVyLiAqL1xuICB0b3VjaDogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBjb25maWd1cmVkIGlkbGUgdGltZW91dCBpbiBtczsgYDBgIChvciBsZXNzKSBtZWFucyBuZXZlci4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBGaXJlZCBvbmNlIHdoZW4gdGhlIGRhZW1vbiBzaG91bGQgY2xvc2UgaXRzZWxmLiAqL1xuICBvbklkbGVDbG9zZTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBkZWJvdW5jZWQgc25hcHNob3QsIGlmIHRoZSBzcGVsbCBoYXMgb25lLiAqL1xuICBzbmFwc2hvdD86IHtcbiAgICBkaXJ0eTogKCkgPT4gYm9vbGVhbjtcbiAgICBjbGVhcjogKCkgPT4gdm9pZDtcbiAgICB3cml0ZTogKCkgPT4gdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIH07XG4gIC8qKiBTd2VlcCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMjUwIG1zLiAqL1xuICB0aWNrTXM/OiBudW1iZXI7XG4gIC8qKiBTbmFwc2hvdCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMTAwMCBtcy4gKi9cbiAgc25hcHNob3RNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBTdGFydCB0aGUgdHdvIHN0YW5kaW5nIHRpbWVycyBldmVyeSBzZXNzaW9uIGRhZW1vbiBydW5zIOKAlCB0aGUgaWRsZSBzd2VlcCBhbmRcbiAqIHRoZSBkZWJvdW5jZWQgc25hcHNob3Qg4oCUIGFuZCByZXR1cm4gdGhlIGZ1bmN0aW9uIHRoYXQgc3RvcHMgYm90aC5cbiAqXG4gKiBUaGV5IGFyZSBPTkUgY2FsbCBiZWNhdXNlIHRoZXkgaGF2ZSBhbHdheXMgYmVlbiBvbmUgbGlmZXRpbWU6IGV2ZXJ5IGNvcHlcbiAqIGNsZWFyZWQgYm90aCBpbiB0aGUgc2FtZSB0d28gbGluZXMgYWZ0ZXIgYGF3YWl0IGRvbmVgLCBhbmQgdGhlIHBhaXIgdGhhdCBnZXRzXG4gKiBmb3Jnb3R0ZW4gaXMgdGhlIHBhaXIgd2hvc2UgdGltZXJzIGtlZXAgYSBwcm9jZXNzIGFsaXZlIGFmdGVyIHRlYXJkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRIb3VzZWtlZXBpbmcob3B0czogSG91c2VrZWVwaW5nT3B0aW9ucyk6ICgpID0+IHZvaWQge1xuICBjb25zdCB0aWNrTXMgPSBvcHRzLnRpY2tNcyA/PyAyNTA7XG4gIGNvbnN0IHNuYXBzaG90TXMgPSBvcHRzLnNuYXBzaG90TXMgPz8gMTAwMDtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcHRzLnN1YnNjcmliZXJDb3VudCgpO1xuICAgIGlmIChzdWJzY3JpYmVycyA+IDApIG9wdHMudG91Y2goKTtcbiAgICBpZiAoc2hvdWxkSWRsZUNsb3NlKHN1YnNjcmliZXJzLCBvcHRzLmlkbGVNcygpLCBvcHRzLnRpbWVvdXRNcykpIG9wdHMub25JZGxlQ2xvc2UoKTtcbiAgfSwgdGlja01zKTtcblxuICBjb25zdCBzbmFwID0gb3B0cy5zbmFwc2hvdDtcbiAgY29uc3Qgc25hcFRpbWVyID0gc25hcFxuICAgID8gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoIXNuYXAuZGlydHkoKSkgcmV0dXJuO1xuICAgICAgICBzbmFwLmNsZWFyKCk7XG4gICAgICAgIHZvaWQgc25hcC53cml0ZSgpO1xuICAgICAgfSwgc25hcHNob3RNcylcbiAgICA6IG51bGw7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBjbGVhckludGVydmFsKGlkbGVUaW1lcik7XG4gICAgaWYgKHNuYXBUaW1lciAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChzbmFwVGltZXIpO1xuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERyYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgYm91bmQgc2VydmVyLiBUeXBlZCBzdHJ1Y3R1cmFsbHkgc28gdGhlIGtpdCBzdGF5cyBmcmVlIG9mIGBidW5gLiAqL1xuICBzZXJ2ZXI6IHsgc3RvcChjbG9zZUFjdGl2ZUNvbm5lY3Rpb25zPzogYm9vbGVhbik6IHVua25vd24gfTtcbiAgLyoqIExpdmUgU1NFIHRhaWxzOyBldmVyeSByZWdpc3RlcmVkIGNsb3NlciBpcyBpbnZva2VkLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIExpdmUgV2ViU29ja2V0cy4gKi9cbiAgc29ja2V0cz86IEl0ZXJhYmxlPHsgY2xvc2UoKTogdm9pZCB9PjtcbiAgLyoqIEhvdyBsb25nIHF1ZXVlZCBmcmFtZXMgZ2V0IHRvIGZsdXNoIGJlZm9yZSBhbnl0aGluZyBpcyBjbG9zZWQuICovXG4gIGdyYWNlTXM/OiBudW1iZXI7XG4gIC8qKiBIb3cgbG9uZyB0aGUgZ3JhY2VmdWwgc3RvcCBnZXRzIGJlZm9yZSB0ZWFyZG93biBwcm9jZWVkcyByZWdhcmRsZXNzLiAqL1xuICBzdG9wTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvc2UgZXZlcnkgaGVsZCBjb25uZWN0aW9uIGFuZCBzdG9wIHRoZSBzZXJ2ZXIsIGluIGJvdW5kZWQgdGltZS5cbiAqXG4gKiDim5QgKipUSEUgR1JBQ0UgUEVSSU9EIElTIE5PVCBQT0xJVEVORVNTLioqIEEgYGNsb3NlZGAgZnJhbWUgZW1pdHRlZCBhbmQgdGhlblxuICogZm9sbG93ZWQgaW1tZWRpYXRlbHkgYnkgYW4gYWdncmVzc2l2ZSBgc2VydmVyLnN0b3AodHJ1ZSlgIGlzIGEgZnJhbWUgdGhlXG4gKiBjbGllbnQgbmV2ZXIgc2VlcyDigJQgdGhlIHF1ZXVlIGdvZXMgd2l0aCB0aGUgc29ja2V0LiBUaGUgMTUwIG1zIGlzIHdoYXQgdHVybnNcbiAqIFwidGhlIGRhZW1vbiB0b2xkIHlvdSB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24sIGFuZCBldmVyeVxuICogb25lIG9mIHRoZSBlaWdodCBkYWVtb25zIGNvbnZlcmdlZCBvbiB0aGF0IG51bWJlciBpbmRlcGVuZGVudGx5LlxuICpcbiAqIOKblCAqKkFORCBUSEUgU1RPUCBJUyBSQUNFRCwgQkVDQVVTRSBBIFNMT1cgU09DS0VUIE1VU1QgTk9UIEJFIEFCTEUgVE8gSEFOR1xuICogVEVBUkRPV04uKiogYHNlcnZlci5zdG9wKHRydWUpYCBhd2FpdHMgaXRzIGNvbm5lY3Rpb25zOyBvbmUgd2VkZ2VkIHBlZXIgaXNcbiAqIGVub3VnaCB0byBwYXJrIGl0IGZvcmV2ZXIsIHdoaWNoIGlzIGhvdyBhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZS5cbiAqXG4gKiDimqAgKipXSEFUIElTIERFTElCRVJBVEVMWSBOT1QgSEVSRTogYm91bnR5J3Mgc2h1dGRvd24gd2F0Y2hkb2cuKiogQm91bnR5IGFybXNcbiAqIGEgUkVGJ2QgYHNldFRpbWVvdXRgIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgaWYgdGVhcmRvd24gZG9lcyBub3QgZmluaXNoLFxuICogYW5kIHRoZSBjZW5zdXMgaXMgcmlnaHQgdGhhdCBpdCBpcyB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsXG4gKiB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIEl0IGJlbG9uZ3MgdG8gYm91bnR5J3MgVEVBUkRPV04g4oCUIHRoZSBzdHJldGNoIHdoZXJlXG4gKiBub3RoaW5nIGJvdW5kcyB3aGF0IGlzIGJlaW5nIHdhaXRlZCBvbi4g4puUICoqVEhJUyBQQVJBR1JBUEggU0FJRCBcIlNJR05BTFxuICogUEFUSFwiIFVOVElMIEQ1MywgQU5EIFRIRSBDT0RFIEFHUkVFRCBXSVRIIElULCBXSElDSCBXQVMgVEhFIERFRkVDVC4qKiBCb3VudHlcbiAqIGhhcyBGT1VSIHdheXMgaW50byBvbmUgdGVhcmRvd24gKGEgc2lnbmFsLCBhIGBjbG9zZWAgdmVyYiwgdGhlIGJyb3dzZXInc1xuICogY2xvc2Ugb3ZlciB0aGUgV2ViU29ja2V0LCBhbiBpZGxlIHRpbWVvdXQpIGFuZCBvbmx5IHRoZSBzaWduYWwgb25lIGFybWVkIHRoZVxuICogdGltZXIsIHdoaWxlIHRoZSBjb21tZW50IGFib3ZlIGl0IGNsYWltZWQgdGhlIGVuZGluZyB3YXMgdW5jb25kaXRpb25hbC5cbiAqIERyaXZlbiB3aXRoIGEgcGxhbnRlZCBoYW5nOiB0aGUgb3RoZXIgdGhyZWUgcmFuIHBhc3QgMTAgcywgdGhlIGlkbGUgb25lXG4gKiBpbmNsdWRlZCDigJQgdGhlIG9ycGhhbi1kYWVtb24gY2xhc3MgdGhlIDIzLW1pbnV0ZSBoYW5nIGNhbWUgZnJvbS4gVGhlIGFybWluZ1xuICogbm93IGxpdmVzIGluIHRoZSBSRVNPTFZFIHRoYXQgYWxsIGZvdXIgZW50cmllcyBwYXNzIHRocm91Z2guICoqVGhlIGxlc3NvbiBmb3JcbiAqIGFuIGFkb3B0ZXIgaXMgdGhlIGNvdW50LCBub3QgdGhlIHBsYWNlbWVudDogZW51bWVyYXRlIGV2ZXJ5IGVudHJ5IGludG8gdGhlXG4gKiB0ZWFyZG93biBiZWZvcmUgeW91IGJlbGlldmUgYSBndWFyYW50ZWUgY292ZXJzIGl0LioqIFRoZSB0d29cbiAqIGRhZW1vbnMgYWRvcHRpbmcgdGhpcyBtb2R1bGUgcmVnaXN0ZXIgbm8gc2lnbmFsIGhhbmRsZXJzLCBhbmQgdGhlaXIgd2hvbGVcbiAqIHRlYXJkb3duIGlzIGJvdW5kZWQgYnkgdGhlIHR3byBudW1iZXJzIGFib3ZlOyBhZGRpbmcgYW4gZXhpdCBoZXJlIHdvdWxkIHB1dFxuICogdGhlIGhvdXNlJ3Mgb25seSB1bmNvbmRpdGlvbmFsIGBwcm9jZXNzLmV4aXRgIGluc2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBpc1xuICogYWJvdXQgdG8gYnVuZGxlLCBvbmUgcGhhc2UgYWZ0ZXIgRDggdG9vayBleGFjdGx5IHRoYXQgaGF6YXJkIE9VVCBvZiBgZGllYC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFTlRFTkNFIFRIQVQgVVNFRCBUTyBFTkQgVEhBVCBQQVJBR1JBUEggV0FTIEEgUFJFRElDVElPTiwgV0hJQ0hcbiAqIEJPVU5UWSdTIE9XTiBQT1JUIEZBTFNJRklFRC4qKiBJdCByZWFkOiBcIndoZW4gYSBzcGVsbCB3aXRoIGEgc2lnbmFsIHBhdGhcbiAqIGFkb3B0cyB0aGlzLCB0aGUgd2F0Y2hkb2cgYXJyaXZlcyBhcyBhbiBvcHRpb24gb24gdGhlc2UgYXJndW1lbnRzIGFuZCB0aGVcbiAqIHJlYXNvbmluZyBpcyBhbHJlYWR5IHdyaXR0ZW4gZG93bi5cIiBib3VudHkgYWRvcHRlZCBgZHJhaW5BbmRTdG9wYCBvblxuICogMjAyNi0wOS0wOSAoUGhhc2UgNCkgYW5kIHRoZSBvcHRpb24gd2FzIE5PVCBhZGRlZCwgYmVjYXVzZSB0aGUgd2luZG93IGlzXG4gKiB3cm9uZy4gKipBIGB3YXRjaGRvZ01zYCBvbiB0aGVzZSBhcmd1bWVudHMgd291bGQgYXJtIGF0IERSQUlOIHRpbWU7IGJvdW50eSdzXG4gKiBhcm1zIGF0IFNJR05BTCB0aW1lKiosIGFuZCB0aGUgd2hvbGUgcmVhc29uIGl0IGV4aXN0cyBpcyB0aGUgc3RyZXRjaCBCRVRXRUVOXG4gKiB0aG9zZSB0d28gcG9pbnRzIOKAlCBgYXdhaXQgZG9uZWAsIGFuIGZzIGFwcGVuZCB0byB0aGUgZGFlbW9uIGxvZywgYSBmdWxsXG4gKiBzbmFwc2hvdCB3cml0ZSB0aGF0IGNhbiByb3RhdGUgYW5kIENPUFkgYSBiYWNrdXAgb2YgYSBsYXJnZSBib2FyZCwgYSBgY2xvc2VkYFxuICogZnJhbWUgYW5kIGEgYnJvYWRjYXN0LiBgZHJhaW5BbmRTdG9wYCdzIG93biBib2R5IGlzIGFscmVhZHkgYm91bmRlZCBieSB0aGUgdHdvXG4gKiBudW1iZXJzIGFib3ZlLCBzbyBhIHdhdGNoZG9nIHNjb3BlZCB0byBpdCB3b3VsZCBndWFyZCB0aGUgb25lIHN0cmV0Y2ggdGhhdFxuICogY2Fubm90IGhhbmcgYW5kIGFiYW5kb24gdGhlIHN0cmV0Y2ggdGhhdCBjYW46IGl0IHdvdWxkIFJFQUQgYXMgYWRvcHRpb24gYW5kXG4gKiBCRSBhIG5hcnJvd2luZyBvZiB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gVGhlXG4gKiAyMy1taW51dGUgaGFuZyB0aGlzIHByb2plY3Qga2VlcHMgY2l0aW5nIGhhcHBlbmVkIGluIHRoZSB1bmJvdW5kZWQgc3RyZXRjaC5cbiAqXG4gKiDimqAgKipTTyBUSEUgUlVMRSBGT1IgVEhFIE5FWFQgU1BFTEwsIFdISUNIIElTIFRIRSBUUkFOU0ZFUkFCTEUgSEFMRjoqKiB0aGVcbiAqIHF1ZXN0aW9uIGlzIG5ldmVyIFwiZG9lcyB0aGlzIG1vZHVsZSBoYXZlIGEgcGxhY2UgdG8gcHV0IGEgd2F0Y2hkb2dcIiBidXRcbiAqIFwiZG9lcyB0aGUgd2F0Y2hkb2cncyB3aW5kb3cgY29pbmNpZGUgd2l0aCB0aGlzIG1vZHVsZSdzXCIuIFdoZXJlIGEgc3BlbGwnc1xuICogdGVhcmRvd24gaGFzIHVuYm91bmRlZCB3b3JrIEJFRk9SRSB0aGUgZHJhaW4sIHRoZSB3YXRjaGRvZyBiZWxvbmdzIGF0IHRoZVxuICogc3BlbGwsIHdyYXBwZWQgYXJvdW5kIGFsbCBvZiBpdCDigJQgYW5kIGFyb3VuZCBFVkVSWSBXQVkgSU4sIHdoaWNoIGlzIHRoZSBoYWxmXG4gKiBENTMgaGFkIHRvIHJlcGFpciBhZnRlciB0aGlzIGhlYWRlciB3YXMgd3JpdHRlbi4gSWYgYSBzcGVsbCBldmVyIGFwcGVhcnMgd2hvc2Ugc2lnbmFsIHBhdGhcbiAqIGVudGVycyBgZHJhaW5BbmRTdG9wYCBpbW1lZGlhdGVseSwgYWRkIHRoZSBvcHRpb24gVEhFTiDigJQgYW5kIHRoZSBvcHRpb24gbXVzdFxuICogdGFrZSBhbiBgb25FeHBpcmVgIGNhbGxiYWNrIHJhdGhlciB0aGFuIGV4aXRpbmcsIHNvIHRoZSBgcHJvY2Vzcy5leGl0YCBzdGF5c1xuICogb3V0c2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBidW5kbGVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZHJhaW5BbmRTdG9wKG9wdHM6IERyYWluT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBncmFjZU1zID0gb3B0cy5ncmFjZU1zID8/IDE1MDtcbiAgY29uc3Qgc3RvcE1zID0gb3B0cy5zdG9wTXMgPz8gMjAwO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIGdyYWNlTXMpKTtcblxuICBpZiAob3B0cy5jbGllbnRzKSB7XG4gICAgZm9yIChjb25zdCBjbGllbnQgb2YgWy4uLm9wdHMuY2xpZW50c10pIGNsaWVudC5jbG9zZSgpO1xuICB9XG4gIGlmIChvcHRzLnNvY2tldHMpIHtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIFsuLi5vcHRzLnNvY2tldHNdKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgUHJvbWlzZS5yZXNvbHZlKG9wdHMuc2VydmVyLnN0b3AodHJ1ZSkpLFxuICAgIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHN0b3BNcykpLFxuICBdKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKlxuICog4pSA4pSAIEFORCBcIldIRVRIRVIgSVQgTUFZIEJFIFJFQURcIiBJUyBOT1cgQSBXSElURUxJU1Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRXh0cmFjdGVkIHdpdGggdGhyZWUgZ3VhcmRzIChlbXB0eSAvIGAuLmAgLyBuZXN0ZWQpIGFuZCBgZXhpc3RzU3luY2AgZm9yIHRoZVxuICogcmVzdCwgd2hpY2ggd2FzIHRydWUgb2YgYSBgZGlzdC9gIHRoYXQgaGVsZCBvbmx5IGEgc3VyZmFjZS4gUGhhc2UgMWIgcHV0IGV2ZXJ5XG4gKiBkYWVtb24ncyBCVU5ETEUgaW4gdGhhdCBzYW1lIGRpcmVjdG9yeSwgYW5kIGFsbCBmaXZlIGFkb3B0ZXJzIHNlcnZlZCBpdDpcbiAqIGAvY2xpLmpzYCwgYC9zZXJ2ZXIuanNgLCBgL2pvaW4uanNgIGF0IDIwMCwgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGNvbW1pdHRlZFxuICogYXJ0aWZhY3RzLCBlbWJlZGRlZCBzb3VyY2VtYXBzIGFuZCBhbGwuIGBzZXJ2ZUZyb21EaXN0YCBub3cgc2VydmVzIG9ubHkgd2hhdCB0aGVcbiAqIGJ1aWx0IGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgbGlua3Mg4oCUIHNlZSBgc3VyZmFjZVdoaXRlbGlzdGAgYmVsb3csIHdoaWNoIGlzXG4gKiB0aGUgc2hhcGUgZGlnZXN0aWZ5IHByb3ZlZCBsb2NhbGx5IGluIGBkOGNiYWZmYCBhbmQgdGhpcyBpcyBpdHMgb25lIGVkaXQgZm9yXG4gKiBmaXZlIHNwZWxscy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKblCBBTkQgYGV4aXN0c1N5bmNgIElTIE5PIExPTkdFUiBUSEUgUEVSTUlTU0lPTi4gQSBmaWxlIHVuZGVyIGBkaXN0RGlyYCBpc1xuICogc2VydmVkIG9ubHkgaWYgaXQgaXMgaW4gYHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcilgIOKAlCB3aGF0IHRoZSBidWlsdFxuICogYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBMSU5LUy4gYGRpc3QvYCBzdG9wcGVkIGJlaW5nIGEgc3VyZmFjZSBkaXJlY3RvcnlcbiAqIHdoZW4gdGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgYnVpbHQgdGhlIGRhZW1vbnMgaW50byBpdCwgYW5kIHRoZSBndWFyZHMgYWJvdmVcbiAqIGRvIG5vdCBkaXN0aW5ndWlzaCBgaW5kZXgtPGhhc2g+LmpzYCBmcm9tIGBzZXJ2ZXIuanNgLiBSZWFkIHRoYXQgZnVuY3Rpb24nc1xuICogaGVhZGVyIGJlZm9yZSB0b3VjaGluZyB0aGlzIGxpbmU7IHRoZSB3aGl0ZWxpc3QgaXMgdGhlIGRlZmVuY2UuXG4gKlxuICog4pqgIFRoZSBuZXN0aW5nIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwnc1xuICogb3duIHJvdXRlczogbWFncGllLCBib3VudHksIGdsYW1vdXIgYW5kIGltYWdvIGVhY2ggaGF2ZSBhbiBgL2Fzc2V0cy88bmFtZT5gXG4gKiByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXMgcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW5cbiAqIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3byBmaWdodGluZy4gVGhlIHdoaXRlbGlzdCBnb3Zlcm5zIGBkaXN0L2AgcmVhZHMgT05MWVxuICog4oCUIGl0IG5ldmVyIHNlZXMgdGhvc2Ugcm91dGVzIGFuZCBtdXN0IG5ldmVyIGJlIHdpZGVuZWQgaW50byB0aGVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmICghc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKS5oYXMocmVsKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG5cbi8qKiBgc3JjYC9gaHJlZmAgdmFsdWVzIGluIGEgYnVpbHQgZW50cnkgZG9jdW1lbnQsIGAuL2AtcHJlZml4ZWQgb3IgYmFyZS4gKi9cbmNvbnN0IEVOVFJZX1JFRl9SRSA9IC8oPzpzcmN8aHJlZilcXHMqPVxccypcIig/OlxcLlxcLyk/KFteXCJdKylcIi9nO1xuXG4vKiogQSBgLi9gLVBSRUZJWEVEIHNpYmxpbmcgc3BlY2lmaWVyIOKAlCBgXCIuL25hbWVcImAsIGAnLi9uYW1lJ2AsIGAoLi9uYW1lKWAg4oCUIHdoaWNoXG4gKiAgaXMgdGhlIG9ubHkgc2hhcGUgYSBidW5kbGVyIGVtaXRzIGZvciBhIHNpYmxpbmcgY2h1bmsuIFJlcXVpcmluZyB0aGUgYC4vYCBpc1xuICogIHdoYXQga2VlcHMgYSBzdHJpbmcgbGl0ZXJhbCB0aGF0IG1lcmVseSBTQVlTIGBjbGkuanNgIG91dCBvZiB0aGUgc2V0LiAqL1xuY29uc3QgUkVMQVRJVkVfUkVGX1JFID0gL1tcIicoXVxcLlxcLyhbXlwiJygpXFxzXSspW1wiJyldL2c7XG5cbi8qKiBPbmx5IHRleHQgdGhlIGJ1aWxkIGVtaXRzIGFzIHN1cmZhY2UgY29kZSBpcyBzY2FubmVkIGZvciBvbndhcmQgcmVmZXJlbmNlcy5cbiAqICBBIGAucG5nYCBpcyBhIGxlYWY7IG9wZW5pbmcgaXQgd291bGQgYmUgcmVhZGluZyBhIGJpbmFyeSBmb3IgZmlsZW5hbWVzLiAqL1xuY29uc3QgVFJBTlNJVElWRV9FWFRTID0gW1wiLmpzXCIsIFwiLmNzc1wiXTtcblxuLyoqIE9uZSBkZXJpdmF0aW9uIHBlciBgZGlzdC9gLCBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3Mg4oCUIGBkaXN0L2AgaXMgYSBidWlsZFxuICogIGFydGlmYWN0IGFuZCBkb2VzIG5vdCBjaGFuZ2UgdW5kZXIgYSBydW5uaW5nIGRhZW1vbi4gS2V5ZWQgYnkgZGlyZWN0b3J5IHNvXG4gKiAgdHdvIGRhZW1vbnMgaW4gb25lIHByb2Nlc3MgKGFuZCBldmVyeSB0ZXN0IHdpdGggaXRzIG93biB0ZW1wIHRyZWUpIHN0YXlcbiAqICBpbmRlcGVuZGVudC4gKi9cbmNvbnN0IHdoaXRlbGlzdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+KCk7XG5cbmZ1bmN0aW9uIHJlZnNJbih0ZXh0OiBzdHJpbmcsIHJlOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIHJldHVybiAoXG4gICAgWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgICAgLm1hcCgoWywgcmVmXSkgPT4gcmVmKVxuICAgICAgLy8gQSBUWVBFIFBSRURJQ0FURSwgYW5kIGhvbmVzdCBvbmx5IGJlY2F1c2UgaXRzIGZpcnN0IGNsYXVzZSB3YXMgYWxyZWFkeVxuICAgICAgLy8gaGVyZTogYCEhcmVmYCBpcyB0aGUgcnVudGltZSBjaGVjayB0aGF0IG1ha2VzIGByZWYgaXMgc3RyaW5nYCB0cnVlICh0aGVcbiAgICAgIC8vIEZFTEwgc2VudGVuY2UncyBwcmVkaWNhdGUgcm91dGUsIHRha2VuIHdpdGggaXRzIGNsYXVzZSDigJQgdHlwZS1kZWJ0IFQzNikuXG4gICAgICAuZmlsdGVyKFxuICAgICAgICAocmVmKTogcmVmIGlzIHN0cmluZyA9PlxuICAgICAgICAgICEhcmVmICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiLi5cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiOlwiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCI/XCIpLFxuICAgICAgKVxuICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGpvaW4sIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2hhdE1lc3NhZ2UsXG4gIENoYXRXaG8sXG4gIENvbnRleHRFbnRyeSxcbiAgRG9jVmlldyxcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgVmVyc2lvbixcbiAgVmVyc2lvbkF1dGhvcixcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7IGVudHJ5Rm9yUGF0aCwgaXNEb2NOYW1lLCBsb2NhdGUsIHNjYW5UcmVlIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgY29uc3QgTUFOSUZFU1RfRk9STUFUID0gMTtcblxudHlwZSBEb2NSZWNvcmQgPSB7XG4gIHNsdWc6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBvcmlnaW5hbDogc3RyaW5nO1xuICBlbnRyeUlkOiBzdHJpbmcgfCBudWxsO1xuICByZWw6IHN0cmluZyB8IG51bGw7XG4gIGV4dDogc3RyaW5nO1xuICB2ZXJzaW9uczogT21pdDxWZXJzaW9uLCBcInBhdGhcIj5bXTtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIC8qKiBIYXNoIG9mIHRoZSBvcmlnaW5hbCBhcyB3ZSBsYXN0IHJlYWQgb3Igd3JvdGUgaXQuICovXG4gIG9yaWdpbmFsSGFzaDogc3RyaW5nO1xuICAvKiogU2V0IG9ubHkgYnkgYG9wZW5QYXRoYCwgd2hpY2ggYWRtaXRzIGEgZG9jLXR5cGUgZmlsZSBJTlNJREUgYSBjb250ZXh0XG4gICAqICBlbnRyeS4gYHNhdmVgIHdyaXRlcyBubyBvcmlnaW5hbCB0aGF0IGxhY2tzIGl0ICh2ZXJpZnktcGFzcyBmaXggMWMpLiAqL1xuICBhZG1pdHRlZD86IGJvb2xlYW47XG4gIG91dHNpZGVDaGFuZ2VkOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIGZvcm1hdDogbnVtYmVyO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIGNvbnRleHQ6IENvbnRleHRFbnRyeVtdO1xuICBkb2NzOiBEb2NSZWNvcmRbXTtcbiAgb3BlbkRvYzogc3RyaW5nIHwgbnVsbDtcbiAgY2hhdDogQ2hhdE1lc3NhZ2VbXTtcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBXaGF0IGEgd2F0Y2hlciBldmVudCB0dXJuZWQgb3V0IHRvIGJlLiBgbnVsbGAgPSBub3RoaW5nIChvdXJzLCBvciBubyBjaGFuZ2UpLiAqL1xuZXhwb3J0IHR5cGUgRmlsZUV2ZW50ID1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgYWN0aXZlOiBmYWxzZSB9XG4gIHwgeyBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCkpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwge1xuICAgICAgZm9ybWF0OiBNQU5JRkVTVF9GT1JNQVQsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBjb250ZXh0OiBbXSxcbiAgICAgIGRvY3M6IFtdLFxuICAgICAgb3BlbkRvYzogbnVsbCxcbiAgICAgIGNoYXQ6IFtdLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIHMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBleGlzdHNTeW5jKHApID8gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkgOiBcIlwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKiogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGFuZCBlYWNoIGVudHJ5IHJvb3QuICovXG4gIHdhdGNoUm9vdHMoKTogeyBwYXRoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10ge1xuICAgIGNvbnN0IHJvb3RzOiB7IHBhdGg6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSA9IFtcbiAgICAgIHsgcGF0aDogdGhpcy5kb2NzRGlyLCByZWN1cnNpdmU6IHRydWUgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIHJvb3RzLnB1c2goeyBwYXRoOiBlLnJvb3QsIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsIGVudHJ5SWQ6IGUuaWQgfSk7XG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIG91dHNpZGUgZXZlcnkgZW50cnkgKGl0cyBlbnRyeSB3YXMgcmVtb3ZlZCkgc3RpbGxcbiAgICAvLyBuZWVkcyBpdHMgb3V0c2lkZSBjaGFuZ2VzIHNlZW4uXG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKVxuICAgICAgaWYgKCFyb290cy5zb21lKChyKSA9PiByLnBhdGggPT09IGRpcm5hbWUoZC5vcmlnaW5hbCkpKVxuICAgICAgICByb290cy5wdXNoKHsgcGF0aDogZGlybmFtZShkLm9yaWdpbmFsKSwgcmVjdXJzaXZlOiBmYWxzZSB9KTtcbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmZiBgdGV4dGAgYXQgYHBhdGhgIGlzIGV4YWN0bHkgd2hhdCB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgdGhlcmUuICovXG4gIGlzT3duV3JpdGUocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5vd25lZC5nZXQocGF0aCkgPT09IGNvbnRlbnRIYXNoKHRleHQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbnRleHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkQ29udGV4dChyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBDb250ZXh0RW50cnk7IGFkZGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgY29uc3QgcHJvYmUgPSBlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCk7XG4gICAgY29uc3Qgc2FtZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5yb290ID09PSBwcm9iZS5yb290ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gcHJvYmUubWVtYmVyc2hpcCAmJlxuICAgICAgICAocHJvYmUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiIHx8XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgPT09IEpTT04uc3RyaW5naWZ5KHByb2JlLm5vZGVzKSksXG4gICAgKTtcbiAgICBpZiAoc2FtZSkgcmV0dXJuIHsgZW50cnk6IHNhbWUsIGFkZGVkOiBmYWxzZSB9O1xuICAgIHRoaXMubS5jb250ZXh0LnB1c2gocHJvYmUpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IHByb2JlLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgcmVtb3ZlQ29udGV4dChpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaSA9IHRoaXMubS5jb250ZXh0LmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICAgIGlmIChpIDwgMClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7aWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKGUpID0+IGUuaWQpLFxuICAgICAgKTtcbiAgICB0aGlzLm0uY29udGV4dC5zcGxpY2UoaSwgMSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgfVxuXG4gIC8qKiBSZS1taXJyb3IgYSBmb2xkZXIgZW50cnkuIFJldHVybnMgd2hldGhlciBpdHMgbm9kZXMgY2hhbmdlZC4gKi9cbiAgcmVzY2FuKGVudHJ5SWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoZT8ubWVtYmVyc2hpcCAhPT0gXCJtaXJyb3JlZFwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShlLnJvb3QpO1xuICAgIGNvbnN0IGNoYW5nZWQgPVxuICAgICAgSlNPTi5zdHJpbmdpZnkobm9kZXMpICE9PSBKU09OLnN0cmluZ2lmeShlLm5vZGVzKSB8fCAhIXRydW5jYXRlZCAhPT0gISFlLnRydW5jYXRlZDtcbiAgICBlLm5vZGVzID0gbm9kZXM7XG4gICAgaWYgKHRydW5jYXRlZCkgZS50cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGVsc2UgZGVsZXRlIGUudHJ1bmNhdGVkO1xuICAgIGlmIChjaGFuZ2VkKSB0aGlzLnJlbGluaygpO1xuICAgIHJldHVybiBjaGFuZ2VkO1xuICB9XG5cbiAgcHJpdmF0ZSByZWxpbmsoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBhdCA9IGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgZC5vcmlnaW5hbCk7XG4gICAgICBkLmVudHJ5SWQgPSBhdD8uZW50cnlJZCA/PyBudWxsO1xuICAgICAgZC5yZWwgPSBhdD8ucmVsID8/IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIGRvY3VtZW50cyBhbmQgdmVyc2lvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSB2ZXJzaW9uUGF0aChkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4odGhpcy5kb2NzRGlyLCBkLnNsdWcsIGB2JHtufSR7ZC5leHR9YCk7XG4gIH1cblxuICBwcml2YXRlIGRvY09yRGllKHNsdWc/OiBzdHJpbmcpOiBEb2NSZWNvcmQge1xuICAgIGNvbnN0IHdhbnQgPSBzbHVnID8/IHRoaXMubS5vcGVuRG9jID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjaG9pY2VzID0gdGhpcy5tLmRvY3MubWFwKChkKSA9PiBkLnNsdWcpO1xuICAgIGlmICh3YW50ID09PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFwibm8gZG9jdW1lbnQgaXMgb3BlbiDigJQgbmFtZSBvbmUgd2l0aCAtLWRvY1wiLCA0MDksIGNob2ljZXMpO1xuICAgIGNvbnN0IGQgPSB0aGlzLmZpbmREb2Mod2FudCk7XG4gICAgaWYgKCFkKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBkb2N1bWVudCBcIiR7d2FudH1cIiBpbiB0aGlzIHNlc3Npb25gLCA0MDQsIGNob2ljZXMpO1xuICAgIHJldHVybiBkO1xuICB9XG5cbiAgLyoqIEEgZG9jIGJ5IHNsdWcsIGJ5IG9yaWdpbmFsIHBhdGgsIG9yIGJ5IGEgdW5pcXVlIG9yaWdpbmFsIGJhc2VuYW1lLiAqL1xuICBmaW5kRG9jKGtleTogc3RyaW5nKTogRG9jUmVjb3JkIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBieVNsdWcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLnNsdWcgPT09IGtleSk7XG4gICAgaWYgKGJ5U2x1ZykgcmV0dXJuIGJ5U2x1ZztcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKGtleSk7XG4gICAgY29uc3QgYnlQYXRoID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIGNvbnN0IGJ5TmFtZSA9IHRoaXMubS5kb2NzLmZpbHRlcigoZCkgPT4gYmFzZW5hbWUoZC5vcmlnaW5hbCkgPT09IGtleSB8fCBkLnJlbCA9PT0ga2V5KTtcbiAgICByZXR1cm4gYnlOYW1lLmxlbmd0aCA9PT0gMSA/IGJ5TmFtZVswXSA6IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHByaXZhdGUgdmVyc2lvbk9yRGllKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4ge1xuICAgIGNvbnN0IHYgPSBkLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubiA9PT0gbik7XG4gICAgaWYgKCF2KVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gdiR7bn1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIGQudmVyc2lvbnMubWFwKCh4KSA9PiBgdiR7eC5ufWApLFxuICAgICAgKTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHByaXZhdGUgc2x1Z0ZvcihvcmlnaW5hbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzdGVtID1cbiAgICAgIGJhc2VuYW1lKG9yaWdpbmFsLCBleHRuYW1lKG9yaWdpbmFsKSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05Xy1dKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIikgfHwgXCJkb2NcIjtcbiAgICBsZXQgc2x1ZyA9IHN0ZW07XG4gICAgZm9yIChsZXQgaSA9IDI7IHRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gc2x1Zyk7IGkrKykgc2x1ZyA9IGAke3N0ZW19LSR7aX1gO1xuICAgIHJldHVybiBzbHVnO1xuICB9XG5cbiAgLyoqXG4gICAqIE9wZW4gYSBkb2N1bWVudCBieSBpdHMgb3JpZ2luYWwncyBwYXRoOiB2MSBpcyB3cml0dGVuIGZyb20gdGhlIG9yaWdpbmFsXG4gICAqIHRoZSBmaXJzdCB0aW1lLlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nKTogeyBzbHVnOiBzdHJpbmc7IGNyZWF0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQub3JpZ2luYWwgPT09IGFicyk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICB0aGlzLm0ub3BlbkRvYyA9IGV4aXN0aW5nLnNsdWc7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IHNsdWc6IGV4aXN0aW5nLnNsdWcsIGNyZWF0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmICghaXNEb2NOYW1lKGFicykpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCA0MDApO1xuICAgIGlmICghbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7YWJzfSBpcyBub3QgaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dCDigJQgYWRkIGl0IChvciBpdHMgZm9sZGVyKSBmaXJzdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSBmaWxlXCIpO1xuICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBvcGVuICR7YWJzfTogbm8gc3VjaCBmaWxlYCwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgZXh0ID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0uaW5jbHVkZXMoZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKCkpXG4gICAgICA/IGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpXG4gICAgICA6IFwiLm1kXCI7XG4gICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicyk7XG4gICAgY29uc3QgZDogRG9jUmVjb3JkID0ge1xuICAgICAgc2x1ZzogdGhpcy5zbHVnRm9yKGFicyksXG4gICAgICBuYW1lOiBiYXNlbmFtZShhYnMpLFxuICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgIGVudHJ5SWQ6IGF0Py5lbnRyeUlkID8/IG51bGwsXG4gICAgICByZWw6IGF0Py5yZWwgPz8gbnVsbCxcbiAgICAgIGV4dCxcbiAgICAgIHZlcnNpb25zOiBbeyBuOiAxLCBhdXRob3I6IFwiaHVtYW5cIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH1dLFxuICAgICAgYWN0aXZlOiAxLFxuICAgICAgb3JpZ2luYWxIYXNoOiBjb250ZW50SGFzaCh0ZXh0KSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFkbWl0dGVkOiB0cnVlLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MucHVzaChkKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCAxKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLm0ub3BlbkRvYyA9IGQuc2x1ZztcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIGNyZWF0ZWQ6IHRydWUgfTtcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIGVkaXQoc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIsIHRleHQ6IHN0cmluZyk6IHsgZGlydHlDaGFuZ2VkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGlmIChuICE9PSBkLmFjdGl2ZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGB2JHtufSBpcyBub3QgdGhlIGFjdGl2ZSB2ZXJzaW9uIG9mICR7ZC5zbHVnfSAodiR7ZC5hY3RpdmV9IGlzKSDigJQgb25seSB0aGUgYWN0aXZlIHZlcnNpb24gaXMgZWRpdGFibGVgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IGJlZm9yZSA9IHRoaXMuaXNEaXJ0eShkKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpIH07XG4gIH1cblxuICAvKiogQ29weSBhIHZlcnNpb24gdG8gYSBuZXcgZmlsZTsgdGhlIGFnZW50IHRoZW4gZWRpdHMgdGhhdCBmaWxlIHdpdGggaXRzIG93biB0b29scy4gKi9cbiAgbmV3VmVyc2lvbihvcHRzOiB7IGRvYz86IHN0cmluZzsgZnJvbT86IG51bWJlcjsgbGFiZWw/OiBzdHJpbmc7IGF1dGhvcjogVmVyc2lvbkF1dGhvciB9KToge1xuICAgIHNsdWc6IHN0cmluZztcbiAgICB2ZXJzaW9uOiBWZXJzaW9uO1xuICB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgY29uc3QgZnJvbSA9IG9wdHMuZnJvbSA/PyBkLmFjdGl2ZTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBmcm9tKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZnJvbSksIFwidXRmOFwiKTtcbiAgICBjb25zdCBuID0gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogb3B0cy5hdXRob3IsXG4gICAgICBmcm9tLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgLi4uKG9wdHMubGFiZWwgPyB7IGxhYmVsOiBvcHRzLmxhYmVsIH0gOiB7fSksXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCB2ZXJzaW9uOiB7IC4uLnJlYywgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCBuKSB9IH07XG4gIH1cblxuICBhY3RpdmF0ZShvcHRzOiB7IGRvYz86IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0pOiB7IHNsdWc6IHN0cmluZzsgcHJldmlvdXM6IG51bWJlciB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShvcHRzLmRvYyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgb3B0cy52ZXJzaW9uKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IGQuYWN0aXZlO1xuICAgIGQuYWN0aXZlID0gb3B0cy52ZXJzaW9uO1xuICAgIGNvbnN0IHAgPSB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICB0aGlzLmFjdGl2ZUhhc2guc2V0KGQuc2x1ZywgY29udGVudEhhc2gocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8qKiBTYXZlOiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IG92ZXIgdGhlIG9yaWdpbmFsLiBUaGUgT05MWSB3cml0ZSB0byBpdCAoRTcpLiAqL1xuICBzYXZlKHNsdWc6IHN0cmluZyk6IHsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWM6IFNhdmUgd3JpdGVzIG9ubHkgYW4gb3JpZ2luYWwgYWRtaXR0ZWQgYnlcbiAgICAvLyBgb3BlblBhdGhgIChhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSkuIENoZWNrZWQgYWdhaW4gaGVyZVxuICAgIC8vIHNvIG5vIG90aGVyIHBhdGggaW50byB0aGUgbWFuaWZlc3Qg4oCUIGEgaGFuZC1lZGl0ZWQgb25lLCBhIGZ1dHVyZSB2ZXJiIOKAlFxuICAgIC8vIGNhbiB0dXJuIFNhdmUgaW50byBcIndyaXRlIGFueSBmaWxlXCIuXG4gICAgaWYgKCFkLmFkbWl0dGVkIHx8ICFpc0RvY05hbWUoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gc2F2ZSAke2Qub3JpZ2luYWx9OiBpdCB3YXMgbm90IG9wZW5lZCBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgdGhpcy53cml0ZU93bmVkKGQub3JpZ2luYWwsIHRleHQpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IG9yaWdpbmFsOiBkLm9yaWdpbmFsLCB2ZXJzaW9uOiBkLmFjdGl2ZSB9O1xuICB9XG5cbiAgLyoqIFJldmVydDogdGhlIG9yaWdpbmFsJ3MgdGV4dCBiYWNrIG92ZXIgdGhlIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuICByZXZlcnQoc2x1Zzogc3RyaW5nKTogeyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIHRoaXMub3duZWQuc2V0KGFicywgY29udGVudEhhc2godGV4dCkpO1xuICAgICAgaWYgKG4gPT09IGQuYWN0aXZlKSB7XG4gICAgICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHRleHQsIHBhdGg6IGFicyB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsga2luZDogXCJ2ZXJzaW9uLmNoYW5nZWRcIiwgZG9jOiBkLnNsdWcsIHZlcnNpb246IG4sIHRleHQsIGFjdGl2ZTogZmFsc2UgfTtcbiAgICB9XG5cbiAgICAvLyBBbiBvcGVuZWQgb3JpZ2luYWw/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBoKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgIHRleHQsXG4gICAgICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkLm91dHNpZGVDaGFuZ2VkKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBhc2tlZFxuICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBhYnMgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjaGF0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZE1lc3NhZ2UoXG4gICAgd2hvOiBDaGF0V2hvLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgICBleHRyYTogeyBzZWxlY3Rpb24/OiBTZWxlY3Rpb24gfCBudWxsOyBhY3RpdmVQYXRoPzogc3RyaW5nIHwgbnVsbCB9ID0ge30sXG4gICk6IENoYXRNZXNzYWdlIHtcbiAgICBjb25zdCBtc2c6IENoYXRNZXNzYWdlID0geyBpZDogYG0tJHtyYW5kSGV4KDQpfWAsIHdobywgdGV4dCwgdHM6IERhdGUubm93KCksIC4uLmV4dHJhIH07XG4gICAgdGhpcy5tLmNoYXQucHVzaChtc2cpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiBtc2c7XG4gIH1cblxuICAvLyDilIDilIAgdmlld3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgZG9jVmlldyhkOiBEb2NSZWNvcmQpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4ge1xuICAgICAgc2x1ZzogZC5zbHVnLFxuICAgICAgbmFtZTogZC5uYW1lLFxuICAgICAgb3JpZ2luYWw6IGQub3JpZ2luYWwsXG4gICAgICBlbnRyeUlkOiBkLmVudHJ5SWQsXG4gICAgICByZWw6IGQucmVsLFxuICAgICAgdmVyc2lvbnM6IGQudmVyc2lvbnMubWFwKCh2KSA9PiAoeyAuLi52LCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIHYubikgfSkpLFxuICAgICAgYWN0aXZlOiBkLmFjdGl2ZSxcbiAgICAgIGRpcnR5OiB0aGlzLmlzRGlydHkoZCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZC5vdXRzaWRlQ2hhbmdlZCxcbiAgICB9O1xuICB9XG5cbiAgZG9jKHNsdWc6IHN0cmluZyk6IERvY1ZpZXcge1xuICAgIHJldHVybiB0aGlzLmRvY1ZpZXcodGhpcy5kb2NPckRpZShzbHVnKSk7XG4gIH1cblxuICB2aWV3KG1vZGU6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiwgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsKTogUHVibGljU3RhdGUge1xuICAgIHJldHVybiB7XG4gICAgICBzZXNzaW9uSWQ6IHRoaXMubS5zZXNzaW9uSWQsXG4gICAgICBob21lOiB0aGlzLmhvbWUsXG4gICAgICBtb2RlLFxuICAgICAgY29udGV4dDogdGhpcy5tLmNvbnRleHQsXG4gICAgICBkb2NzOiB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IHRoaXMuZG9jVmlldyhkKSksXG4gICAgICBvcGVuRG9jOiB0aGlzLm0ub3BlbkRvYyxcbiAgICAgIHNlbGVjdGlvbixcbiAgICAgIGNoYXQ6IHRoaXMubS5jaGF0LFxuICAgIH07XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5jb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKiogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEFuIGVtcHR5IGdyb3VwIGlzIHN0aWxsIGEgcmVhbCBkaXJlY3RvcnksIGJ1dCBhIG1pcnJvciBvZiBhIGRvY3NcbiAgICAgICAgLy8gZm9sZGVyIGlzIG1vcmUgdXNlZnVsIHdpdGhvdXQgdHdlbnR5IGVtcHR5IGFzc2V0IGZvbGRlcnMgaW4gaXQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBcURBLHVCQUF5QjtBQUN6QjtBQUNBLG9CQUFTLGtCQUFTLGtCQUFNO0FBQ3hCO0FBQ0Esc0JBQVM7OztBQzNDVDtBQXFCTyxTQUFTLGVBQWUsQ0FBQyxRQUFnQixNQUFvQjtBQUFBLEVBQ2xFLE1BQU0sTUFBTSxHQUFHLFVBQVUsUUFBUTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLGNBQWMsS0FBSyxJQUFJO0FBQUEsSUFDdkIsV0FBVyxLQUFL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
