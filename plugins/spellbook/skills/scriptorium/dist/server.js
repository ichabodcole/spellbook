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
  movePlan(rawPath, rawInto) {
    const item = this.itemOrDie(rawPath);
    const into = this.destinationOrDie(rawInto);
    const fromRepo = gitRootOf(dirname2(item.abs));
    const intoRepo = gitRootOf(into);
    return {
      from: item.abs,
      into,
      name: basename2(item.abs),
      folder: item.dir,
      docs: item.dir ? countDocs(item.abs) : 1,
      repo: fromRepo ? basename2(fromRepo) : null,
      leavesRepo: fromRepo !== null && fromRepo !== intoRepo
    };
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
function gitRootOf(dir) {
  let at = dir;
  for (;; ) {
    if (existsSync3(join3(at, ".git")))
      return at;
    const up = dirname2(at);
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
      const abs = join3(at, name);
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

//# debugId=5AB33C70DF9EA64864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZXNzaW9uLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIHBlci1zZXNzaW9uIGRhZW1vbiDigJQgdGhlIHByb2Nlc3MgdGhlIHN1cmZhY2UgdGFsa3MgdG8gb3ZlciBhXG4gKiBXZWJTb2NrZXQgYW5kIHRoZSBDTEkgdGFsa3MgdG8gb3ZlciBIVFRQLiBMYXVuY2hlZCBieVxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9zY3JpcHRvcml1bS9zY3JpcHRzL3NlcnZlci50c2AgKHRoZSBsYXVuY2hlciksIHdoaWNoXG4gKiBpbXBvcnRzIHRoZSBCVUlMVCBgZGlzdC9zZXJ2ZXIuanNgLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBgU0tJTExfUk9PVGAvYERJU1RfRElSYCBvbmx5LCBmb3IgdGhlIGtpdCdzIGByZXNvbHZlTW9kZWAgYW5kXG4gKiAgICBgc2VydmVGcm9tRGlzdGAsIGFuZCB0cnVlIGF0IHRoZSBFTUlUVEVEIGFkZHJlc3MgKGBkaXN0L3NlcnZlci5qc2AsIHdob3NlXG4gKiAgICBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIpLiBOb3RoaW5nIGVsc2UgaXMgcGlubmVkIG9mZiBgaW1wb3J0Lm1ldGFgLlxuICogMi4gU2VydmVzOiBZRVMuIGAvYCBpcyB0aGUgYnVpbHQgYGluZGV4Lmh0bWxgIHZpYSBgc2VydmVGcm9tRGlzdGAsIG5vXG4gKiAgICBzdWJzdGl0dXRpb247IHRoZSBvbmx5IHJvdXRlcyBvZiBpdHMgb3duIGFyZSBgL3N0YXRlYCwgYC9jbWRgLCBgL2V2ZW50c2AsXG4gKiAgICBgL3dzYCBhbmQgYC9mcy8qYCAocmVhZC1vbmx5OiBhIHZlcnNpb24ncyB0ZXh0LCBhIGRpcmVjdG9yeSBsaXN0aW5nKS5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIGBjbGkudHNgOyB0aGUgdHdvIHNoYXJlIGAuL2hlYXJ0YmVhdC50c2AuXG4gKiA0LiBMaWZlY3ljbGU6IGxvbmctcnVubmluZywgb25lIGRhZW1vbiBwZXIgc2Vzc2lvbiwgaWRsZS10aW1lb3V0IGxpa2VcbiAqICAgIGdsYW1vdXIgKGxpbmdlciBhZnRlciB0aGUgbGFzdCBzdWJzY3JpYmVyIGxlYXZlczsgZXhpdCAxMjQpLlxuICogNS4gYG1haW4oKWAgcmV0dXJucyB3aGlsZSB0aGUgcHJvY2VzcyBtdXN0IGxpdmU/IE5PIOKAlCBgbWFpbmAgYXdhaXRzIHRoZVxuICogICAgc2Vzc2lvbidzIGVuZCBhbmQgaXRzIG93biBkcmFpbiwgZXhhY3RseSBhcyBnbGFtb3VyJ3Mgc2VydmVyIGRvZXMsIHNvIHRoZVxuICogICAgbGF1bmNoZXIgaXMgVEVSTUlOQUwtRVhJVCAoYHByb2Nlc3MuZXhpdChhd2FpdCBydW4oKSlgKTogb25jZSBgbWFpbmBcbiAqICAgIHJlc29sdmVzIG5vdGhpbmcgbWF5IGtlZXAgdGhlIHByb2Nlc3MgYWxpdmUsIGFuZCBhIHdhdGNoZXIgaGFuZGxlIG9yIGFcbiAqICAgIHN0cmFnZ2xpbmcgc29ja2V0IHdvdWxkLiBEcml2ZW4sIG5vdCByZWFkIChzZWUgdGhlIHNsaWNlLUEgam91cm5hbCkuXG4gKiA2LiBFdmVudCBpZHMgcmVjb3ZlcmVkIGFjcm9zcyByZXN0YXJ0PyBOTyDigJQgdGhlIGxvZyBpcyBpbiBtZW1vcnkgYW5kIGlkc1xuICogICAgcmVzdGFydCBhdCAxLCBldmVuIHVuZGVyIGAtLXJlc3RvcmVgICh3aGljaCByZXN0b3JlcyB0aGUgTUFOSUZFU1QsIG5vdCB0aGVcbiAqICAgIGxvZykuIFNvIHRoZSBsb2cgaXMgc3RhbXBlZCB3aXRoIGEgcGVyLWJvb3QgRVBPQ0ggKG1pbmQtbWFwcGVyJ3Mgc2hhcGUpXG4gKiAgICBhbmQgdGhlIHRhaWwgcmVzZXRzIGl0cyBjdXJzb3Igd2hlbiB0aGUgZXBvY2ggY2hhbmdlcy5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vIOKAlCB0aGUgc2hhcGUgd2FzIGNob3NlbiB0byBiZSB0aGVcbiAqICAgIGtpdCdzLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IE5POiBzY3JpcHRvcml1bVxuICogICAgaXMgdGhlIGZpcnN0IHNwZWxsIHNjYWZmb2xkZWQgYWZ0ZXIgdGhlIGNvbnZlcmdlbmNlLlxuICpcbiAqIOKUgOKUgCBLSVQgVkVSRElDVFMgKHBsYXlib29rIE40KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBlcnJvcnMgU1VCSkVDVCAodGhlIENMSTsgdGhlIGRhZW1vbiBhbnN3ZXJzIEhUVFAgc3RhdHVzZXMgdGhlIENMSSBtYXBzKSDCt1xuICogc2VydmVEaXN0IFNVQkpFQ1QgKGByZXNvbHZlTW9kZWAsIGBzZXJ2ZUZyb21EaXN0YCkgwrcgaG91c2VrZWVwaW5nIFNVQkpFQ1QsIGFsbFxuICogdGhyZWUgZXhwb3J0cyAoYHNob3VsZElkbGVDbG9zZWAgdmlhIGBzdGFydEhvdXNla2VlcGluZ2AncyBpZGxlLWNsb3NlLCB0aGVcbiAqIHNuYXBzaG90IHN3ZWVwIOKAlCBoZXJlIHRoZSBtYW5pZmVzdCBpcyB3cml0dGVuIG9uIGV2ZXJ5IGNoYW5nZSBpbnN0ZWFkLCBzbyB0aGVcbiAqIHN3ZWVwJ3Mgc25hcHNob3QgaG9vayBpcyBkZWxpYmVyYXRlbHkgTk9UIHBhc3NlZCDigJQgYW5kIGBkcmFpbkFuZFN0b3BgKSDCt1xuICogdGFpbEV2ZW50cyBTVUJKRUNUICh0aGUgQ0xJJ3MgYHRhaWxgKSDCtyBoZWFydGJlYXQgU1VCSkVDVCAoYC4vaGVhcnRiZWF0LnRzYCkgwrdcbiAqIGRpc2NvdmVyeSBTVUJKRUNUIChzZXNzaW9uLUpTT04sIEUxMzogYHNjcmlwdG9yaXVtLTxpZD4uanNvbmAgK1xuICogYHNjcmlwdG9yaXVtLWxhdGVzdC5qc29uYCBpbiB0bXBkaXIgdmlhIGB3cml0ZUZpbGVBdG9taWNgL2B1bmxpbmtJZk1hdGNoZXNgKSDCt1xuICogZXZlbnRMb2cgU1VCSkVDVCwgV0lUSCBFUE9DSCAoUTYpIMK3IHNzZSBTVUJKRUNUIChgR0VUIC9ldmVudHNgKSDCt1xuICogbGliL3ByaW50SnNvbiBTVUJKRUNUICh0aGUgQ0xJIHNwZWFrcyB0aGUgYWdlbnQgd2lyZSkuXG4gKlxuICog4pSA4pSAIFRFQVJET1dOIE9SREVSIChyZWdpc3RlciBBNiksIFNUQVRFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBnbGFtb3VyJ3Mgb3JkZXI6IHN0b3AgaG91c2VrZWVwaW5nIOKGkiBjbG9zZSB0aGUgd2F0Y2hlcnMg4oaSIHBlcnNpc3QgdGhlXG4gKiBtYW5pZmVzdCDihpIgdW5saW5rIGRpc2NvdmVyeSDihpIgZW1pdCBgY2xvc2VkYCDihpIgZHJhaW4uIERpc2NvdmVyeSBnb2VzIEJFRk9SRSB0aGVcbiAqIGBjbG9zZWRgIGZyYW1lIHNvIGEgdGFpbCB0aGF0IHNlZXMgYGNsb3NlZGAgYW5kIGEgQ0xJIHZlcmIgdGhhdCBydW5zIHJpZ2h0XG4gKiBhZnRlciBpdCBib3RoIGZpbmQgbm8gcG9pbnRlciB0byBhIGRhZW1vbiB0aGF0IGlzIGxlYXZpbmc7IHRoZSBvdGhlciBvcmRlclxuICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGEgdmVyYiByZXNvbHZlcyBhIHNlc3Npb24gdGhhdCB3aWxsIHJlZnVzZSBpdC5cbiAqL1xuXG5pbXBvcnQgeyB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyB0eXBlIFBpY2tLaW5kLCBwYXJzZVBpY2tlck91dHB1dCwgcGlja2VyQ29tbWFuZCwgd2FzQ2FuY2VsbGVkIH0gZnJvbSBcIi4vcGlja2VyXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50Q21kLCBDbGllbnRNc2csIFNlbGVjdGlvbiwgU2VydmVyTXNnLCBTdHJ1Y3R1cmVPcCB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8qKiByZWxlYXNlIGlmZiBgZGlzdC9pbmRleC5odG1sYCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Q7IHRoZSBlbnYgdmFyIG92ZXJyaWRlcyAoQ29udHJhY3QgMSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYC4gYHByb21wdHMuanNvbmAgYmVzaWRlIGBzZXNzaW9ucy9gIGlzIHNsaWNlIEIncyAoRTkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIC8qKiBFMjM6IGEgTkVXIHNlc3Npb24ncyB3b3Jrc3BhY2Ug4oCUIHRoZSBkaXJlY3RvcnkgYG9wZW5gIHJhbiBpbi4gQSByZXN0b3JlIGtlZXBzIGl0cyBvd24uICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHRhaWwgZnJhbWUncyBwYXlsb2FkLiBUaGUgbG9nIHN0YW1wcyBgaWRgIGFuZCBgZXBvY2hgLiAqL1xudHlwZSBMb2dFdmVudCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyB0eXBlOiBzdHJpbmcgfTtcblxuLyoqIEhvdyBsb25nIGEgYnVyc3Qgb2Ygd2F0Y2hlciBldmVudHMgb24gb25lIHBhdGggc2V0dGxlcyBiZWZvcmUgaXQgaXMgcmVhZC4gKi9cbmNvbnN0IFdBVENIX1NFVFRMRV9NUyA9IDYwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgLy8gTW9kZSBCRUZPUkUgYW55IHdyaXRlOiBhIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0XG4gIC8vIGRpZSBhdCB0aGUgaW1wb3J0IGhhdmluZyBjcmVhdGVkIG5vdGhpbmcgKGdsYW1vdXIncyBtZWFzdXJlZCBvcmRlcikuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuICBjb25zdCBkZXZJbmRleCA9XG4gICAgbW9kZSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGNvbnN0IHNlc3Npb24gPSBvcHRzLnJlc3RvcmVcbiAgICA/IFNlc3Npb24ucmVzdG9yZShob21lLCBvcHRzLnJlc3RvcmUpXG4gICAgOiBTZXNzaW9uLmNyZWF0ZShob21lLCB1bmRlZmluZWQsIG9wdHMud29ya3NwYWNlKTtcbiAgY29uc3Qgc2Vzc2lvbklkID0gc2Vzc2lvbi5pZDtcbiAgbGV0IHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCA9IG51bGw7XG5cbiAgLy8gLS0tIHByZWZzOiBwZXItdmlld2VyIGNvbnZlbmllbmNlcyB0aGF0IG91dGxpdmUgYSBzZXNzaW9uJ3MgcG9ydCAtLS0tLS0tLS0tLS1cbiAgLy8gQnJvd3NlciBzdG9yYWdlIGlzIGtleWVkIGJ5IG9yaWdpbiwgcG9ydCBpbmNsdWRlZCwgYW5kIGV2ZXJ5IHNlc3Npb24gZ2V0cyBhXG4gIC8vIG5ldyBwb3J0IOKAlCBzbyBhIHBhbmUgc2l6ZSBrZXB0IGluIGxvY2FsU3RvcmFnZSByZXNldHMgYXQgdGhlIG5leHQgYG9wZW5gLlxuICAvLyBUaGV5IGxpdmUgaW4gdGhlIGhvbWUgaW5zdGVhZCwgc2hhcmVkIGJ5IGV2ZXJ5IHNlc3Npb24gb2YgdGhpcyBob21lLlxuICBjb25zdCBwcmVmc0ZpbGUgPSBqb2luKGhvbWUsIFwicHJlZnMuanNvblwiKTtcbiAgY29uc3QgUFJFRl9LRVkgPSAvXlthLXpdW2EtejAtOTouXy1dezAsNjN9JC87XG4gIGNvbnN0IFBSRUZfVkFMVUVfTUFYID0gNDA5NjtcbiAgY29uc3QgUFJFRl9LRVlTX01BWCA9IDY0O1xuICAvKipcbiAgICogUmVhZCB0aGUgaG9tZSdzIHByZWZzIEZSRVNILiBTZXZlcmFsIHNlc3Npb25zIGNhbiBzaGFyZSBvbmUgaG9tZSAoRTEzKSwgZWFjaFxuICAgKiBpdHMgb3duIGRhZW1vbiwgc28gYSBjb3B5IGxvYWRlZCBvbmNlIGF0IGJvb3QgYW5kIHdyaXR0ZW4gYmFjayB3aG9sZSB3b3VsZFxuICAgKiBlcmFzZSBhIGtleSBhbm90aGVyIHNlc3Npb24gd3JvdGUgc2luY2UgKHZlcmlmeSBwYXNzKS4gRXZlcnkgd3JpdGUgaXNcbiAgICogdGhlcmVmb3JlIHJlYWQg4oaSIHNldCBvbmUga2V5IOKGkiB3cml0ZSwgYW5kIGV2ZXJ5IHNuYXBzaG90IHJlYWRzIHRoZSBmaWxlLlxuICAgKiBPbmx5IHdlbGwtZm9ybWVkIGVudHJpZXMgc3Vydml2ZSBhIHJlYWQ7IGEgYmFkIGZpbGUgcmVhZHMgYXMgZW1wdHkgYW5kIGlzXG4gICAqIHJlcGxhY2VkIGJ5IHRoZSBuZXh0IHdyaXRlLlxuICAgKi9cbiAgY29uc3QgcmVhZFByZWZzID0gKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwcmVmc0ZpbGUsIFwidXRmOFwiKSkgYXMgdW5rbm93bjtcbiAgICAgIGlmIChyYXcgJiYgdHlwZW9mIHJhdyA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHJhdykpXG4gICAgICAgICAgaWYgKFBSRUZfS0VZLnRlc3QoaykgJiYgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi5sZW5ndGggPD0gUFJFRl9WQUxVRV9NQVgpIG91dFtrXSA9IHY7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBwcmVmcyB5ZXQsIG9yIHVucmVhZGFibGUg4oCUIGVtcHR5ICovXG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH07XG4gIGNvbnN0IHVzZXJIb21lID0gaG9tZWRpcigpO1xuICBjb25zdCB2aWV3U3RhdGUgPSAoKSA9PiAoeyAuLi5zZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSwgcHJlZnM6IHJlYWRQcmVmcygpLCB1c2VySG9tZSB9KTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIGNvbnN0IGxvZyA9IGNyZWF0ZUV2ZW50TG9nPExvZ0V2ZW50Pih7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH0pO1xuICBjb25zdCBzc2VDbGllbnRzOiBTc2VDbGllbnRzID0gbmV3IFNldCgpO1xuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGNvbnN0IHNlbmQgPSAobXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiBzZW5kKHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSk7XG5cbiAgLyoqIEEgc3lzdGVtIGxpbmUgaW4gdGhlIGNoYXQg4oCUIGFuZCwgYmVjYXVzZSB0aGUgYWdlbnQgbXVzdCBrbm93IGl0IHRvbywgb24gdGhlIHRhaWwuICovXG4gIGNvbnN0IGFubm91bmNlID0gKHRleHQ6IHN0cmluZywgZmFjdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSkgPT4ge1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgdGV4dCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcInN5c3RlbVwiLCB0ZXh0LCB0czogbS50cywgLi4uZmFjdCB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICB9O1xuXG4gIC8vIC0tLSB0aGUgd2F0Y2hlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDimqAgREVWSUFUSU9OIEZST00gVEhFIEJSSUVGLCBXSVRIIElUUyBSRUFTT046IGBub2RlOmZzYCBgd2F0Y2hgIChCdW4nc1xuICAvLyBidWlsdC1pbiksIE5PVCBgQHBhcmNlbC93YXRjaGVyYC4gYEBwYXJjZWwvd2F0Y2hlcmAgaXMgYSBuYXRpdmUgYWRkb24gd2hvc2VcbiAgLy8gbG9hZGVyIGRvZXMgYSBydW50aW1lIGByZXF1aXJlKClgIG9mIGEgcGVyLXBsYXRmb3JtIHBhY2thZ2U7IGJ1bmRsZWQgaW50b1xuICAvLyBgZGlzdC9zZXJ2ZXIuanNgIGl0IGlzIG5vdCBpbmxpbmVkLCBzbyB0aGUgc2hpcHBlZCBkYWVtb24gd291bGQgbmVlZCBhXG4gIC8vIGBub2RlX21vZHVsZXNgIHRoZSBtYXJrZXRwbGFjZSBuZXZlciBjb3BpZXMgKGltcG9ydC1ib3VuZGFyeSB3YXJkIDFiJ3NcbiAgLy8gXCJ0aGUgc2hpcHBlZCBleGVjdXRpb24gcGF0aCBjYXJyaWVzIG5vIGRlcGVuZGVuY2llc1wiKS4gTWVhc3VyZWQgdW5kZXIgQnVuXG4gIC8vIDEuNC4wIG9uIG1hY09TIGJlZm9yZSBjaG9vc2luZzogYSByZWN1cnNpdmUgZGlyZWN0b3J5IHdhdGNoIHJlcG9ydHMgYW5cbiAgLy8gaW4tcGxhY2Ugd3JpdGUsIGFuIGF0b21pYyB0bXArcmVuYW1lIHNhdmUsIGFuZCBib3RoIGFnYWluIGluIGFcbiAgLy8gc3ViZGlyZWN0b3J5IOKAlCB0aGUgZm91ciBjYXNlcyBpbnZlc3RpZ2F0aW9uIMKnNSBkcm92ZSBAcGFyY2VsL3dhdGNoZXIgb24uXG4gIC8vIFRoZSBoYXNoLWNvbXBhcmUgYW5kIHNlbGYtd3JpdGUgc3VwcHJlc3Npb24gYXJlIHVuY2hhbmdlZCAoc2Vzc2lvbi50cykuXG4gIGNvbnN0IHdhdGNoZXJzID0gbmV3IE1hcDxzdHJpbmcsIEZTV2F0Y2hlcj4oKTtcbiAgY29uc3QgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pj4oKTtcbiAgY29uc3Qgb25GcyA9IChhYnM6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHQgPSBwZW5kaW5nLmdldChhYnMpO1xuICAgIGlmICh0KSBjbGVhclRpbWVvdXQodCk7XG4gICAgcGVuZGluZy5zZXQoXG4gICAgICBhYnMsXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcGVuZGluZy5kZWxldGUoYWJzKTtcbiAgICAgICAgbGV0IGV2OiBGaWxlRXZlbnQgfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBldiA9IHNlc3Npb24ub25GaWxlRXZlbnQoYWJzKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogd2F0Y2hlcjogJHtlfVxcbmApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldikgaGFuZGxlRmlsZUV2ZW50KGV2KTtcbiAgICAgIH0sIFdBVENIX1NFVFRMRV9NUyksXG4gICAgKTtcbiAgfTtcbiAgY29uc3Qgc3luY1dhdGNoZXJzID0gKCkgPT4ge1xuICAgIGNvbnN0IHdhbnQgPSBuZXcgTWFwKFxuICAgICAgc2Vzc2lvbi53YXRjaFJvb3RzKCkubWFwKChyKSA9PiBbYCR7ci5yZWN1cnNpdmUgPyBcIlJcIiA6IFwiRlwifToke3Iud2F0Y2h9PiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBXYXRjaGVkIGF0IHRoZSBSRUFMUEFUSCwgcmVwb3J0ZWQgdW5kZXIgdGhlIHN0b3JlZCBwYXRoIGZvcm1cbiAgICAgICAgLy8gKHZlcmlmeS1wYXNzIGZpeCAzIOKAlCBzZWUgU2Vzc2lvbi53YXRjaFJvb3RzKS5cbiAgICAgICAgY29uc3QgdyA9IHdhdGNoKHIud2F0Y2gsIHsgcmVjdXJzaXZlOiByLnJlY3Vyc2l2ZSB9LCAoX2V2ZW50LCBuYW1lKSA9PiB7XG4gICAgICAgICAgaWYgKG5hbWUpIG9uRnMoam9pbihyLnBhdGgsIG5hbWUudG9TdHJpbmcoKSkpO1xuICAgICAgICAgIGVsc2UgaWYgKHIuZW50cnlJZCkgb25GcyhyLnBhdGgpO1xuICAgICAgICB9KTtcbiAgICAgICAgdy5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICAgICAgICAvKiB0aGUgZGlyZWN0b3J5IHdlbnQgYXdheTsgdGhlIG5leHQgc3luYyBkcm9wcyBpdCAqL1xuICAgICAgICB9KTtcbiAgICAgICAgd2F0Y2hlcnMuc2V0KGtleSwgdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW53YXRjaGFibGUgKGdvbmUsIHBlcm1pc3Npb25zKSDigJQgb3V0c2lkZSBjaGFuZ2VzIHRoZXJlIGdvIHVuc2VlbiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVGaWxlRXZlbnQgPSAoZXY6IEZpbGVFdmVudCkgPT4ge1xuICAgIHN3aXRjaCAoZXYua2luZCkge1xuICAgICAgY2FzZSBcInZlcnNpb24uY2hhbmdlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidmVyc2lvbi5jcmVhdGVkXCI6XG4gICAgICAgIGFubm91bmNlKGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gYXBwZWFyZWQgKHdyaXR0ZW4gZGlyZWN0bHkgdG8gJHtldi5wYXRofSlgLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImFjdGl2ZS5vdXRzaWRlXCI6XG4gICAgICAgIC8vIEUyOiB0aGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSB2ZXJzaW9uIHRoZSBodW1hbiBpcyBlZGl0aW5nLiBUaGVcbiAgICAgICAgLy8gb3V0c2lkZSB0ZXh0IGlzIEtFUFQgYXMgYSBuZXcgYWdlbnQgdmVyc2lvbiBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uXG4gICAgICAgIC8vIGtlZXBzIHRoZSBodW1hbidzIHRleHQg4oCUIG5vdGhpbmcgaXMgbG9zdCwgYW5kIHRoZSBodW1hbidzIGJ1ZmZlciBpc1xuICAgICAgICAvLyBub3QgdG91Y2hlZCAodmVyaWZ5LXBhc3MgZml4IDQpLlxuICAgICAgICBhbm5vdW5jZU91dHNpZGUoZXYuZG9jLCBldi52ZXJzaW9uLCBldi5wYXRoLCBldi5wcmVzZXJ2ZWRBcywgZXYucHJlc2VydmVkUGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5yZWxvYWRlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIOKAlCByZWxvYWRlZCAoeW91IGhhZCBubyB1bnNhdmVkIGVkaXRzKS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLmNvbmZsaWN0XCI6XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgeW91IGhhdmUgdW5zYXZlZCBlZGl0cy4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggeW91cnM7IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBldi5kb2MgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInRyZWVcIjpcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhbm5vdW5jZU91dHNpZGUgPSAoXG4gICAgZG9jOiBzdHJpbmcsXG4gICAgdmVyc2lvbjogbnVtYmVyLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBwcmVzZXJ2ZWRBczogbnVtYmVyLFxuICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZyxcbiAgKSA9PlxuICAgIGFubm91bmNlKFxuICAgICAgYHYke3ZlcnNpb259IG9mICR7ZG9jfSBpcyB0aGUgQUNUSVZFIHZlcnNpb24gYW5kIHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yLiBUaGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc307IHRoZSBhY3RpdmUgdmVyc2lvbiBrZWVwcyB5b3VyIHRleHQuIEFnZW50IGVkaXRzIGJlbG9uZyBpbiBhIG5ldyB2ZXJzaW9uICh2ZXJzaW9uLW5ldykuYCxcbiAgICAgIHsgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLCBkb2MsIHZlcnNpb24sIHBhdGgsIHByZXNlcnZlZEFzLCBwcmVzZXJ2ZWRQYXRoIH0sXG4gICAgKTtcblxuICAvLyAtLS0gc2hhcmVkIGFjdHMgKHN1cmZhY2UgYW5kIGFnZW50IHJlYWNoIHRoZSBzYW1lIGNvZGUpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBhZGRQYXRocyA9IChwYXRoczogc3RyaW5nW10pID0+IHtcbiAgICBjb25zdCBhZGRlZCA9IHBhdGhzLm1hcCgocCkgPT4gc2Vzc2lvbi5hZGRDb250ZXh0KHApKTtcbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiBhZGRlZDtcbiAgfTtcblxuICBjb25zdCBhY3RpdmF0ZSA9IChkb2M6IHN0cmluZyB8IHVuZGVmaW5lZCwgdmVyc2lvbjogbnVtYmVyLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKSA9PiB7XG4gICAgY29uc3QgciA9IHNlc3Npb24uYWN0aXZhdGUoeyBkb2MsIHZlcnNpb24gfSk7XG4gICAgY29uc3QgdmlldyA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgY29uc3QgcGF0aCA9IHZpZXcudmVyc2lvbnMuZmluZCgodikgPT4gdi5uID09PSB2ZXJzaW9uKT8ucGF0aCA/PyBudWxsO1xuICAgIHNlbmQoe1xuICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgIGRvYzogci5zbHVnLFxuICAgICAgdmVyc2lvbixcbiAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCB2ZXJzaW9uKS50ZXh0LFxuICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgXCJzeXN0ZW1cIixcbiAgICAgIGAke2J5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwifSBtYWRlIHYke3ZlcnNpb259IG9mICR7ci5zbHVnfSBhY3RpdmUgKHdhcyB2JHtyLnByZXZpb3VzfSkuYCxcbiAgICApO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJhY3RpdmF0ZWRcIiwgYnksIGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCwgdHM6IG0udHMgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGggfTtcbiAgfTtcblxuICAvKipcbiAgICogRTI0OiBvbmUgc3RydWN0dXJlIGNoYW5nZSwgZnJvbSBlaXRoZXIgcGFydHkg4oCUIHRoZSBzYW1lIHNlc3Npb24gbWV0aG9kLCB0aGVcbiAgICogc2FtZSBhbm5vdW5jZW1lbnQgKG5hbWluZyB3aG8gZGlkIGl0KSwgdGhlIHNhbWUgdGFpbCBmYWN0LiBSZXR1cm5zIHRoZSBwYXRoXG4gICAqIHRoZSBjaGFuZ2UgbGFuZGVkIGF0LCB3aGljaCB0aGUgc3VyZmFjZSB1c2VzIHRvIG9wZW4gb3IgcmVuYW1lIGl0LlxuICAgKi9cbiAgY29uc3QgU1RSVUNUVVJFX09QUyA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gICAgXCJkb2MuY3JlYXRlXCIsXG4gICAgXCJmb2xkZXIuY3JlYXRlXCIsXG4gICAgXCJtb3ZlXCIsXG4gICAgXCJyZW5hbWVcIixcbiAgICBcImhpZGVcIixcbiAgICBcInVuaGlkZVwiLFxuICAgIFwic2V0Lm1ha2VcIixcbiAgICBcImltcG9ydFwiLFxuICAgIFwid29ya3NwYWNlLnNldFwiLFxuICBdIHNhdGlzZmllcyBTdHJ1Y3R1cmVPcFtcInR5cGVcIl1bXSk7XG4gIGNvbnN0IGlzU3RydWN0dXJlT3AgPSAobTogeyB0eXBlOiBzdHJpbmcgfSk6IG0gaXMgU3RydWN0dXJlT3AgPT4gU1RSVUNUVVJFX09QUy5oYXMobS50eXBlKTtcblxuICBjb25zdCBzdHJ1Y3R1cmUgPSAob3A6IFN0cnVjdHVyZU9wLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IHdobyA9IGJ5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwiO1xuICAgIGNvbnN0IHNob3duID0gKHA6IHN0cmluZykgPT4gc2Vzc2lvbi5kaXNwbGF5KHApO1xuICAgIGxldCByOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgcGF0aD86IHN0cmluZyB9O1xuICAgIGxldCBsaW5lOiBzdHJpbmc7XG4gICAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVEb2Mob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZUZvbGRlcihvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkIHRoZSBmb2xkZXIgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUob3AucGF0aCwgb3AuaW50byk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBtb3ZlZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKG9wLnBhdGgsIG9wLm5hbWUpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVuYW1lZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IGggPSBzZXNzaW9uLmhpZGUob3AucGF0aCk7XG4gICAgICAgIHIgPSBoO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAodGhlIGZpbGUgaXMgc3RpbGwgb24gZGlzaykuYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgICAgY29uc3QgdSA9IHNlc3Npb24udW5oaWRlKG9wLmVudHJ5KTtcbiAgICAgICAgciA9IHU7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGJyb3VnaHQgYmFjayAke3UucmVzdG9yZWR9IGhpZGRlbiBpdGVtJHt1LnJlc3RvcmVkID09PSAxID8gXCJcIiA6IFwic1wifS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZXQubWFrZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1ha2VTZXQob3AucGF0aCk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSB0dXJuZWQgJHtiYXNlbmFtZShtLnBhdGgpfSBpbnRvIGEgc2V0OiAke3Nob3duKG0uZm9sZGVyKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmltcG9ydFRleHQob3AubmFtZSwgb3AudGV4dCwgb3AuaW50byk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNvcGllZCAke29wLm5hbWV9IGluIGFzICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uc2V0V29ya3NwYWNlKG9wLnBhdGgpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBzZXQgdGhlIHdvcmtzcGFjZSB0byAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYW5ub3VuY2UobGluZSwgeyBmYWN0OiBvcC50eXBlLCBieSwgLi4uciB9KTtcbiAgICByZXR1cm4gcjtcbiAgfTtcblxuICAvLyAtLS0gc3VyZmFjZSBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCByZXBseSA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICB0cnkge1xuICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShtc2cpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUgKi9cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IENsaWVudE1zZykgPT4ge1xuICAgIGlmIChpc1N0cnVjdHVyZU9wKG1zZykpIHtcbiAgICAgIGNvbnN0IHIgPSBzdHJ1Y3R1cmUoYW5jaG9yU3VyZmFjZVBhdGhzKG1zZyksIFwiaHVtYW5cIik7XG4gICAgICBpZiAodHlwZW9mIHIucGF0aCA9PT0gXCJzdHJpbmdcIilcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzdHJ1Y3R1cmUuZG9uZVwiLCBvcDogbXNnLnR5cGUsIHBhdGg6IHIucGF0aCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgICAgY2FzZSBcIm9wZW5cIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5vcGVuUGF0aChtc2cucGF0aCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAvLyBUaGUgb3BlbmVyIGdldHMgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBzdHJhaWdodCBhd2F5IOKAlCB0aGUgc3RhdGVcbiAgICAgICAgLy8gc25hcHNob3QgY2FycmllcyBubyB0ZXh0cywgYW5kIGEgdmlld2VyIG11c3Qgbm90IHdhaXQgb24gYSBzZWNvbmQgYXNrLlxuICAgICAgICB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihyLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoci5jcmVhdGVkKVxuICAgICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJkb2Mub3BlbmVkXCIsIGRvYzogci5zbHVnLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoci5zbHVnKSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm9wZW4uZG9jXCI6XG4gICAgICAgIHNlc3Npb24ub3BlblNsdWcobXNnLmRvYyk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJlZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdChtc2cuZG9jLCBtc2cudmVyc2lvbiwgbXNnLnRleHQpO1xuICAgICAgICBpZiAoci5wcmVzZXJ2ZWQpIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2MobXNnLmRvYyk7XG4gICAgICAgICAgYW5ub3VuY2VPdXRzaWRlKFxuICAgICAgICAgICAgZC5zbHVnLFxuICAgICAgICAgICAgbXNnLnZlcnNpb24sXG4gICAgICAgICAgICBzZXNzaW9uLmFjdGl2ZVBhdGgoZC5zbHVnKSA/PyBcIlwiLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQubixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLnBhdGgsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIGlmIChyLmRpcnR5Q2hhbmdlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNlbGVjdFwiOlxuICAgICAgICAvLyBBTUJJRU5UIHN0YXRlOiBzdG9yZWQgYW5kIHNob3duLCBuZXZlciBwdXNoZWQgb250byB0aGUgYWdlbnQncyB0YWlsLlxuICAgICAgICBzZWxlY3Rpb24gPSBtc2cuc2VsZWN0aW9uO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IG1zZy50ZXh0LnRyaW0oKTtcbiAgICAgICAgaWYgKCF0ZXh0KSByZXR1cm47XG4gICAgICAgIGNvbnN0IHNlbCA9IG1zZy53aXRoU2VsZWN0aW9uID8gc2VsZWN0aW9uIDogbnVsbDtcbiAgICAgICAgY29uc3QgYWN0aXZlUGF0aCA9IHNlbCA/IHNlc3Npb24uYWN0aXZlUGF0aChzZWwuZG9jKSA6IHNlc3Npb24uYWN0aXZlUGF0aCgpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiaHVtYW5cIiwgdGV4dCwgeyBzZWxlY3Rpb246IHNlbCwgYWN0aXZlUGF0aCB9KTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICAgIG1lc3NhZ2VfaWQ6IG0uaWQsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBzZWxlY3Rpb246IHNlbCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKHNlbD8uZG9jKSxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICBhY3RpdmF0ZShtc2cuZG9jLCBtc2cudmVyc2lvbiwgXCJodW1hblwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBzZXNzaW9uLnNob3duUGF0aChzdXJmYWNlUGF0aChtc2cucGF0aCkpO1xuICAgICAgICAvLyBBbiBhcmd2LCBuZXZlciBhIHNoZWxsIHN0cmluZzogdGhlIHBhdGggaXMgZGF0YSwgd2hhdGV2ZXIgaXQgaG9sZHMuXG4gICAgICAgIGNvbnN0IFtjbWQsIC4uLmFyZ3NdID1cbiAgICAgICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgICAgICA/IFtcIm9wZW5cIiwgXCItUlwiLCBwYXRoXVxuICAgICAgICAgICAgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCJcbiAgICAgICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICAgICAgOiBbXCJ4ZGctb3BlblwiLCBkaXJuYW1lKHBhdGgpXTtcbiAgICAgICAgQnVuLnNwYXduKFtjbWQgYXMgc3RyaW5nLCAuLi5hcmdzXSwgeyBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdIH0pLnVucmVmKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJlZnMuc2V0XCI6IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFQUkVGX0tFWS50ZXN0KG1zZy5rZXkpIHx8XG4gICAgICAgICAgdHlwZW9mIG1zZy52YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgIG1zZy52YWx1ZS5sZW5ndGggPiBQUkVGX1ZBTFVFX01BWFxuICAgICAgICApXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX1gKTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHJlYWRQcmVmcygpO1xuICAgICAgICBpZiAoY3VycmVudFttc2cua2V5XSA9PT0gbXNnLnZhbHVlKSByZXR1cm47XG4gICAgICAgIGlmICghKG1zZy5rZXkgaW4gY3VycmVudCkgJiYgT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoID49IFBSRUZfS0VZU19NQVgpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfTogJHtQUkVGX0tFWVNfTUFYfSBrZXlzIGFscmVhZHkga2VwdGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgd3JpdGVGaWxlQXRvbWljKFxuICAgICAgICAgIHByZWZzRmlsZSxcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IC4uLmN1cnJlbnQsIFttc2cua2V5XTogbXNnLnZhbHVlIH0sIG51bGwsIDIpfVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtb3ZlLnBsYW5cIjoge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcIm1vdmUucGxhblwiLFxuICAgICAgICAgICAgcGF0aDogbXNnLnBhdGgsXG4gICAgICAgICAgICBpbnRvOiBtc2cuaW50byxcbiAgICAgICAgICAgIHBsYW46IHNlc3Npb24ubW92ZVBsYW4oc3VyZmFjZVBhdGgobXNnLnBhdGgpLCBzdXJmYWNlUGF0aChtc2cuaW50bykpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwibW92ZS5wbGFuXCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGludG86IG1zZy5pbnRvLFxuICAgICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwiZnMubGlzdFwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBleHBhbmRIb21lKG1zZy5wYXRoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImZzLmxpc3RcIiwgcGF0aDogbXNnLnBhdGgsIGVudHJpZXM6IGxpc3REaXIocGF0aCkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXBseSh3cywge1xuICAgICAgICAgICAgdHlwZTogXCJmcy5saXN0XCIsXG4gICAgICAgICAgICBwYXRoOiBtc2cucGF0aCxcbiAgICAgICAgICAgIGVudHJpZXM6IFtdLFxuICAgICAgICAgICAgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyDilIDilIAgdGhlIG5hdGl2ZSBwaWNrZXIgKG9uZSBkaWFsb2cgYXQgYSB0aW1lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLy9cbiAgLy8gQSBtb2RhbCBkaWFsb2cgb3ducyB0aGUgaHVtYW4ncyBhdHRlbnRpb24sIGFuZCBhIHNlY29uZCBvbmUgYmVoaW5kIHRoZVxuICAvLyBmaXJzdCBjYW5ub3QgYmUgc2VlbiBvciBkaXNtaXNzZWQg4oCUIHNvIGEgcmVxdWVzdCB3aGlsZSBvbmUgaXMgb3BlbiBpc1xuICAvLyByZWZ1c2VkIGluIHdvcmRzIHJhdGhlciB0aGFuIHF1ZXVlZC5cbiAgbGV0IHBpY2tlck9wZW4gPSBmYWxzZTtcbiAgY29uc3QgemVuaXR5ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJsaW51eFwiID8gQnVuLndoaWNoKFwiemVuaXR5XCIpIDogbnVsbDtcbiAgY29uc3Qgb3BlblBpY2tlciA9IGFzeW5jIChcbiAgICB3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPixcbiAgICB3YW50OiBcImNvbnRleHQtZmlsZVwiIHwgXCJjb250ZXh0LWZvbGRlclwiIHwgXCJ3b3Jrc3BhY2VcIixcbiAgKSA9PiB7XG4gICAgaWYgKHBpY2tlck9wZW4pIHtcbiAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogXCJhIGZpbGUgcGlja2VyIGlzIGFscmVhZHkgb3BlblwiIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBraW5kOiBQaWNrS2luZCA9IHdhbnQgPT09IFwiY29udGV4dC1maWxlXCIgPyBcImZpbGVcIiA6IFwiZm9sZGVyXCI7XG4gICAgY29uc3QgcHJvbXB0ID1cbiAgICAgIHdhbnQgPT09IFwid29ya3NwYWNlXCJcbiAgICAgICAgPyBcIkNob29zZSB0aGUgd29ya3NwYWNlIGZvbGRlciBmb3Igc2NyaXB0b3JpdW1cIlxuICAgICAgICA6IHdhbnQgPT09IFwiY29udGV4dC1mb2xkZXJcIlxuICAgICAgICAgID8gXCJDaG9vc2UgYSBmb2xkZXIgdG8gYWRkIHRvIHNjcmlwdG9yaXVtXCJcbiAgICAgICAgICA6IFwiQ2hvb3NlIGRvY3VtZW50cyB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIjtcbiAgICBjb25zdCBjbWQgPSBwaWNrZXJDb21tYW5kKHByb2Nlc3MucGxhdGZvcm0sIGtpbmQsIHByb21wdCwgemVuaXR5KTtcbiAgICBpZiAoIWNtZCkge1xuICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgdHlwZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgbm8gZmlsZSBwaWNrZXIgb24gdGhpcyBzeXN0ZW0gKCR7cHJvY2Vzcy5wbGF0Zm9ybX0pIOKAlCB0eXBlIHRoZSBwYXRoIGluc3RlYWRgLFxuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHBpY2tlck9wZW4gPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKGNtZCwgeyBzdGRvdXQ6IFwicGlwZVwiLCBzdGRlcnI6IFwicGlwZVwiLCBzdGRpbjogXCJpZ25vcmVcIiB9KTtcbiAgICAgIGNvbnN0IFtvdXQsIGNvZGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW25ldyBSZXNwb25zZShwcm9jLnN0ZG91dCkudGV4dCgpLCBwcm9jLmV4aXRlZF0pO1xuICAgICAgdG91Y2goKTsgLy8gYSBodW1hbiBzdG9vZCBhdCBhIGRpYWxvZzsgdGhlIHNlc3Npb24gaXMgbm90IGlkbGVcbiAgICAgIGNvbnN0IHBhdGhzID0gcGFyc2VQaWNrZXJPdXRwdXQob3V0KTtcbiAgICAgIGlmIChwYXRocy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgLy8gQ2FuY2VsbGVkOiBub3RoaW5nIGNob3Nlbiwgbm90aGluZyBzYWlkLiBBIHJlYWwgZmFpbHVyZSBpcyBzYWlkLlxuICAgICAgICBpZiAoIXdhc0NhbmNlbGxlZChjb2RlLCBvdXQpKVxuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYHRoZSBmaWxlIHBpY2tlciBmYWlsZWQgKGV4aXQgJHtjb2RlfSlgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBXaGF0IHdhcyBjaG9zZW4gaXMgYWRtaXR0ZWQgbGlrZSBhbnkgb3RoZXIgcGF0aCDigJQgYSBwaWNrZWQgZmlsZSB0aGF0XG4gICAgICAvLyBzY3JpcHRvcml1bSBkb2VzIG5vdCBvcGVuIGlzIHJlZnVzZWQgaW4gdGhlIHNpZGViYXIncyBvd24gd29yZHMsIGFuZFxuICAgICAgLy8gdGhhdCByZWZ1c2FsIG11c3Qgbm90IHJlYWQgYXMgXCJ0aGUgcGlja2VyIGZhaWxlZFwiLlxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKHdhbnQgPT09IFwid29ya3NwYWNlXCIpXG4gICAgICAgICAgc3RydWN0dXJlKHsgdHlwZTogXCJ3b3Jrc3BhY2Uuc2V0XCIsIHBhdGg6IHBhdGhzWzBdIGFzIHN0cmluZyB9LCBcImh1bWFuXCIpO1xuICAgICAgICBlbHNlIGFkZFBhdGhzKHBhdGhzKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgdHlwZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlOiBgY291bGQgbm90IG9wZW4gdGhlIGZpbGUgcGlja2VyOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHBpY2tlck9wZW4gPSBmYWxzZTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYWN0aXZlT2YgPSAoZG9jPzogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qgc2x1ZyA9IGRvYyA/PyBzZXNzaW9uLm9wZW5Eb2NTbHVnO1xuICAgIGlmICghc2x1ZykgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBzZXNzaW9uLmRvYyhzbHVnKTtcbiAgICAgIHJldHVybiB7IGRvYzogdi5zbHVnLCB2ZXJzaW9uOiB2LmFjdGl2ZSwgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKHYuc2x1ZykgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gYWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgcmVzb2x2ZURvbmUhOiAodjogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gIGNvbnN0IGRvbmUgPSBuZXcgUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfT4oKHIpID0+IHtcbiAgICByZXNvbHZlRG9uZSA9IHI7XG4gIH0pO1xuXG4gIGNvbnN0IGhhbmRsZUFnZW50Q21kID0gKGNtZDogQWdlbnRDbWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgaWYgKGlzU3RydWN0dXJlT3AoY21kKSkgcmV0dXJuIHN0cnVjdHVyZShjbWQsIFwiYWdlbnRcIik7XG4gICAgc3dpdGNoIChjbWQudHlwZSkge1xuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6IHtcbiAgICAgICAgY29uc3QgYWRkZWQgPSBhZGRQYXRocyhjbWQucGF0aHMpO1xuICAgICAgICByZXR1cm4geyBlbnRyaWVzOiBhZGRlZC5tYXAoKGEpID0+ICh7IC4uLmEuZW50cnksIGFkZGVkOiBhLmFkZGVkIH0pKSB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcInZlcnNpb24ubmV3XCI6IHtcbiAgICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCA3OiB0aGUgYWdlbnQgbWF5IG5hbWUgYSBkb2MgdGhlIGh1bWFuIGhhcyBub3RcbiAgICAgICAgLy8gb3BlbmVkLCBieSBBQlNPTFVURSBwYXRoICh0aGUgQ0xJIHJlc29sdmVzIGl0IGFnYWluc3QgaXRzIG93biBjd2QpO1xuICAgICAgICAvLyBpdCBpcyBvcGVuZWQgaW1wbGljaXRseSB1bmRlciB0aGUgc2FtZSBhZG1pc3Npb24gcnVsZSBhcyB0aGVcbiAgICAgICAgLy8gc3VyZmFjZSdzIGBvcGVuYCDigJQgYSBkb2MtdHlwZSBmaWxlIGluc2lkZSBhIGNvbnRleHQgZW50cnkg4oCUIHdpdGhvdXRcbiAgICAgICAgLy8gbW92aW5nIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAgICAgIGlmIChjbWQuZG9jICYmIGlzQWJzb2x1dGUoY21kLmRvYykgJiYgIXNlc3Npb24uZmluZERvYyhjbWQuZG9jKSkge1xuICAgICAgICAgIGNvbnN0IG8gPSBzZXNzaW9uLm9wZW5QYXRoKGNtZC5kb2MsIHsgZm9jdXM6IGZhbHNlIH0pO1xuICAgICAgICAgIGlmIChvLmNyZWF0ZWQpXG4gICAgICAgICAgICBsb2cuZW1pdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9jLm9wZW5lZFwiLFxuICAgICAgICAgICAgICBkb2M6IG8uc2x1ZyxcbiAgICAgICAgICAgICAgcGF0aDogc2Vzc2lvbi5hY3RpdmVQYXRoKG8uc2x1ZyksXG4gICAgICAgICAgICAgIGJ5OiBcImFnZW50XCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5uZXdWZXJzaW9uKHtcbiAgICAgICAgICBkb2M6IGNtZC5kb2MsXG4gICAgICAgICAgZnJvbTogY21kLmZyb20sXG4gICAgICAgICAgbGFiZWw6IGNtZC5sYWJlbCxcbiAgICAgICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGBBZ2VudCBjcmVhdGVkIHYke3IudmVyc2lvbi5ufSBvZiAke3Iuc2x1Z30gZnJvbSB2JHtyLnZlcnNpb24uZnJvbX0ke2NtZC5sYWJlbCA/IGAg4oCUICR7Y21kLmxhYmVsfWAgOiBcIlwifS5gLFxuICAgICAgICAgIHsgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIiwgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uIH0sXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGRvYzogci5zbHVnLCB2ZXJzaW9uOiByLnZlcnNpb24ubiwgZnJvbTogci52ZXJzaW9uLmZyb20sIHBhdGg6IHIudmVyc2lvbi5wYXRoIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcImFnZW50XCIsIGNtZC50ZXh0KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgaWQ6IG0uaWQgfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICByZXR1cm4gYWN0aXZhdGUoY21kLmRvYywgY21kLnZlcnNpb24sIFwiYWdlbnRcIik7XG4gICAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAwLCByZWFzb246IFwiY2xvc2VcIiB9KTtcbiAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgICBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KChjbWQgYXMgeyB0eXBlPzogdW5rbm93biB9KS50eXBlKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgIDQwMCxcbiAgICAgICAgICBbXCJjb250ZXh0LmFkZFwiLCBcInZlcnNpb24ubmV3XCIsIFwic2F5XCIsIFwiYWN0aXZhdGVcIiwgXCJjbG9zZVwiLCAuLi5TVFJVQ1RVUkVfT1BTXSxcbiAgICAgICAgKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVmdXNhbCA9IChlOiB1bmtub3duKTogUmVzcG9uc2UgPT4ge1xuICAgIGlmIChlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yKVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oXG4gICAgICAgIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlLCAuLi4oZS5jaG9pY2VzID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSB9LFxuICAgICAgICB7IHN0YXR1czogZS5zdGF0dXMgfSxcbiAgICAgICk7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBQYXRoRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGUubWVzc2FnZSB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0sIHsgc3RhdHVzOiA1MDAgfSk7XG4gIH07XG5cbiAgY29uc3QgZXZlbnRzUmVzcG9uc2UgPSAocmVxOiBSZXF1ZXN0LCB1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIHJldHVybiBzc2VSZXNwb25zZSh7XG4gICAgICBsb2csXG4gICAgICBzaW5jZTogTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCksXG4gICAgICBoZWFydGJlYXRNczogU1NFX0hFQVJUQkVBVF9NUyxcbiAgICAgIGNsaWVudHM6IHNzZUNsaWVudHMsXG4gICAgICBzaWduYWw6IHJlcS5zaWduYWwsXG4gICAgICBvbk9wZW46IHRvdWNoLFxuICAgICAgb25DbG9zZTogdG91Y2gsXG4gICAgfSk7XG4gIH07XG5cbiAgLy8gLS0tIHNlcnZlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogXCIxMjcuMC4wLjFcIixcbiAgICByb3V0ZXMsXG4gICAgaWRsZVRpbWVvdXQ6IElETEVfVElNRU9VVF9TRUMsXG4gICAgZGV2ZWxvcG1lbnQ6IHsgaG1yOiBtb2RlID09PSBcImRldlwiIH0sXG4gICAgZmV0Y2gocmVxLCBzcnYpIHtcbiAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCk7XG4gICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYSDigJQgQSBGT1JFSUdOIE9SSUdJTiBJUyBSRUZVU0VELiBBbnkgd2ViIHBhZ2UgdGhlXG4gICAgICAvLyBodW1hbiB2aXNpdHMgY2FuIG9wZW4gYSBXZWJTb2NrZXQgb3IgUE9TVCB0byAxMjcuMC4wLjE7IHRoZSBicm93c2VyXG4gICAgICAvLyBzZW5kcyBpdHMgT3JpZ2luLCBhbmQgb25seSB0aGlzIGRhZW1vbidzIG93biBwYWdlIG1heSBkcml2ZSBpdC4gVGhlXG4gICAgICAvLyBDTEkncyBmZXRjaCBzZW5kcyBubyBPcmlnaW4gYXQgYWxsLCBzbyBpdCBpcyB1bmFmZmVjdGVkLlxuICAgICAgaWYgKFxuICAgICAgICAocGF0aCA9PT0gXCIvd3NcIiB8fCBwYXRoID09PSBcIi9jbWRcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIvZnMvXCIpKSAmJlxuICAgICAgICAhc2FtZU9yaWdpbihyZXEsIHNydi5wb3J0KVxuICAgICAgKVxuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFwiZm9yZWlnbiBvcmlnaW4gcmVmdXNlZFwiIH0sIHsgc3RhdHVzOiA0MDMgfSk7XG4gICAgICBpZiAocGF0aCA9PT0gXCIvd3NcIilcbiAgICAgICAgcmV0dXJuIHNydi51cGdyYWRlKHJlcSkgPyB1bmRlZmluZWQgOiBuZXcgUmVzcG9uc2UoXCJ1cGdyYWRlIHJlcXVpcmVkXCIsIHsgc3RhdHVzOiA0MjYgfSk7XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zdGF0ZVwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gdmlld1N0YXRlKCk7XG4gICAgICAgIGNvbnN0IGZ1bGwgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImZ1bGxcIikgPT09IFwiMVwiO1xuICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgY2hhdDogZnVsbCA/IHN0YXRlLmNoYXQgOiBzdGF0ZS5jaGF0LnNsaWNlKC0xMCksXG4gICAgICAgICAgY2hhdFRvdGFsOiBzdGF0ZS5jaGF0Lmxlbmd0aCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKCksXG4gICAgICAgICAgY3Vyc29yOiBsb2cuY3Vyc29yKCksXG4gICAgICAgICAgZXBvY2g6IGxvZy5lcG9jaCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9ldmVudHNcIikgcmV0dXJuIGV2ZW50c1Jlc3BvbnNlKHJlcSwgdXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2ZzL3ZlcnNpb25cIikge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLnJlYWRWZXJzaW9uKFxuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJkb2NcIikgPz8gXCJcIixcbiAgICAgICAgICAgIE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInZcIikgPz8gXCJcIiwgMTApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvbGlzdFwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgZW50cmllczogbGlzdERpcihleHBhbmRIb21lKHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwicGF0aFwiKSA/PyBcIn5cIikpLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UpIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIC4uLmhhbmRsZUFnZW50Q21kKGIgYXMgQWdlbnRDbWQpIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gcmVmdXNhbChlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJiYWQganNvblwiIH0sIHsgc3RhdHVzOiA0MDAgfSkpO1xuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInN0YXRlXCIsIHN0YXRlOiB2aWV3U3RhdGUoKSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZSh3cywgcmF3KSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGxldCBtc2c6IENsaWVudE1zZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtc2cgPSBKU09OLnBhcnNlKFxuICAgICAgICAgICAgdHlwZW9mIHJhdyA9PT0gXCJzdHJpbmdcIiA/IHJhdyA6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyYXcpLFxuICAgICAgICAgICkgYXMgQ2xpZW50TXNnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYHNjcmlwdG9yaXVtOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBoYW5kbGVDbGllbnRNc2cod3MsIG1zZyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBBIHJlZnVzYWwgdGhlIGh1bWFuIGNhdXNlZCAoZWRpdCBhIG5vbi1hY3RpdmUgdmVyc2lvbiwgb3BlbiBhXG4gICAgICAgICAgLy8gdmFuaXNoZWQgZmlsZSkgcmVhY2hlcyBUSEVNLCBhcyBhIGNoYXQtdmlzaWJsZSBzeXN0ZW0gbGluZSB3b3VsZCBiZVxuICAgICAgICAgIC8vIHRvbyBsb3VkIGZvciBhIGtleXN0cm9rZSDigJQgc28gaXQgaXMgYW4gZXJyb3IgZnJhbWUgdGhlIHN1cmZhY2Ugc2hvd3MuXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjbG9zZSh3cykge1xuICAgICAgICBzb2NrZXRzLmRlbGV0ZSh3cyk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IChFMTM6IHNlc3Npb24tSlNPTiwgdGhlIG9ubHkgY29udmVudGlvbiB0aGF0IGNhbiBleHByZXNzIHNldmVyYWwpIC0tXG4gIGNvbnN0IHNlc3Npb25GaWxlID0gam9pbih0bXBkaXIoKSwgYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbklkfS5qc29uYCk7XG4gIGNvbnN0IGxhdGVzdEZpbGUgPSBqb2luKHRtcGRpcigpLCBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xuICBjb25zdCBpbmZvID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIGhvbWUsXG4gICAgZGlyOiBzZXNzaW9uLmRpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVBdG9taWMoc2Vzc2lvbkZpbGUsIGluZm8pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhsYXRlc3RGaWxlLCBpbmZvKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZGlzY292ZXJ5IGlzIGJlc3QtZWZmb3J0ICovXG4gIH1cblxuICBzeW5jV2F0Y2hlcnMoKTtcbiAgbG9nLmVtaXQoeyB0eXBlOiBcInJlYWR5XCIsIG1vZGUsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgcmVzdG9yZWQ6ICEhb3B0cy5yZXN0b3JlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggMjogd2hhdCBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgbm8gZGFlbW9uIHdhcyB3YXRjaGluZy5cbiAgZm9yIChjb25zdCBmIG9mIHNlc3Npb24ucmVzdG9yZUZpbmRpbmdzKVxuICAgIGFubm91bmNlKFxuICAgICAgZi5taXNzaW5nXG4gICAgICAgID8gYCR7Zi5vcmlnaW5hbH0gaXMgZ29uZSBmcm9tIGRpc2sgc2luY2UgdGhpcyBzZXNzaW9uIHdhcyBsYXN0IG9wZW4uIFNhdmUgd291bGQgcmVjcmVhdGUgaXQ7IFJldmVydCBjYW5ub3QgcnVuLmBcbiAgICAgICAgOiBgJHtmLm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgdGhpcyBzZXNzaW9uIHdhcyBjbG9zZWQuIFNhdmUgb3ZlcndyaXRlcyBpdCB3aXRoIHRoZSBhY3RpdmUgdmVyc2lvbjsgUmV2ZXJ0IHRha2VzIHRoZSBmaWxlJ3MgdmVyc2lvbi5gLFxuICAgICAgeyBmYWN0OiBcIm9yaWdpbmFsLmNvbmZsaWN0XCIsIGRvYzogZi5kb2MsIHdoaWxlQ2xvc2VkOiB0cnVlIH0sXG4gICAgKTtcblxuICBjb25zdCBzdG9wSG91c2VrZWVwaW5nID0gc3RhcnRIb3VzZWtlZXBpbmcoe1xuICAgIHN1YnNjcmliZXJDb3VudDogKCkgPT4gc29ja2V0cy5zaXplICsgc3NlQ2xpZW50cy5zaXplLFxuICAgIGlkbGVNczogKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLSBsYXN0QWN0aXZpdHksXG4gICAgdG91Y2gsXG4gICAgdGltZW91dE1zOiAob3B0cy50aW1lb3V0UyA/PyAxODAwKSAqIDEwMDAsXG4gICAgb25JZGxlQ2xvc2U6ICgpID0+IHJlc29sdmVEb25lKHsgY29kZTogMTI0LCByZWFzb246IFwidGltZW91dFwiIH0pLFxuICB9KTtcblxuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xlYW51cERpc2NvdmVyeSA9ICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhzZXNzaW9uRmlsZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBnb25lIOKAlCBmaW5lICovXG4gICAgfVxuICAgIHVubGlua0lmTWF0Y2hlcyhsYXRlc3RGaWxlLCBzZXNzaW9uSWQsIChyYXcpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlkID0gKEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiB1bmtub3duIH0pLnNlc3Npb25faWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGhlIG9yZGVyIGlzIHRoZSBoZWFkZXIncywgYW5kIHRoZSBoZWFkZXIgc2F5cyB3aHkuXG4gIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIHN0b3BIb3VzZWtlZXBpbmcoKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2F0Y2hlcnMudmFsdWVzKCkpIHcuY2xvc2UoKTtcbiAgICB3YXRjaGVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdCBvZiBwZW5kaW5nLnZhbHVlcygpKSBjbGVhclRpbWVvdXQodCk7XG4gICAgdHJ5IHtcbiAgICAgIHNlc3Npb24ucGVyc2lzdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgY2xlYW51cERpc2NvdmVyeSgpO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJjbG9zZWRcIiB9KTtcbiAgICB2b2lkIGRyYWluQW5kU3RvcCh7IHNlcnZlciwgY2xpZW50czogc3NlQ2xpZW50cywgc29ja2V0cyB9KS50aGVuKHJlc29sdmVTaHV0ZG93bik7XG4gIH07XG4gIGRvbmUudGhlbigoKSA9PiBjbG9zZSgpKTtcblxuICByZXR1cm4geyBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25JZCwgbW9kZSwgZGlyOiBzZXNzaW9uLmRpciwgY2xvc2UsIGRvbmUsIHNodXRkb3duIH07XG59XG5cbi8qKiBBbiBhYnNlbnQgT3JpZ2luICh0aGUgQ0xJLCBjdXJsKSBvciB0aGlzIGRhZW1vbidzIG93biBwYWdlOyBub3RoaW5nIGVsc2UuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtZU9yaWdpbihyZXE6IFJlcXVlc3QsIHBvcnQ6IG51bWJlciB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBjb25zdCBvcmlnaW4gPSByZXEuaGVhZGVycy5nZXQoXCJvcmlnaW5cIik7XG4gIGlmIChvcmlnaW4gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gb3JpZ2luID09PSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCB8fCBvcmlnaW4gPT09IGBodHRwOi8vbG9jYWxob3N0OiR7cG9ydH1gO1xufVxuXG4vKipcbiAqIEEgcGF0aCB0eXBlZCBpbiB0aGUgU1VSRkFDRS4gVGhlIHBhZ2UgaGFzIG5vIHdvcmtpbmcgZGlyZWN0b3J5LCBzbyBhIHBhdGhcbiAqIGZyb20gaXQgbXVzdCBiZSBhYnNvbHV0ZSBvciBzdGFydCBhdCBgfmAg4oCUIHdoaWNoIGlzIGV4cGFuZGVkIEhFUkUuIEJlZm9yZVxuICogdGhpcywgYH4vRG9jdW1lbnRzYCByZWFjaGVkIGByZXNvbHZlKClgIGFuZCB3YXMgdGFrZW4gYXMgcmVsYXRpdmUgdG8gdGhlXG4gKiBkYWVtb24ncyBjd2QgKHRoZSBza2lsbCBmb2xkZXIpOiB0aGUgcGF0aCBib3ggY29tcGxldGVkIGB+L+KApmAgKGxpc3RpbmdcbiAqIGV4cGFuZHMgaXQpIGFuZCB0aGVuIEVudGVyIGZhaWxlZCB3aXRoIFwibm8gc3VjaCBmaWxlIG9yIGZvbGRlcjpcbiAqIOKApi9za2lsbHMvc2NyaXB0b3JpdW0vfi9Eb2N1bWVudHMv4oCmXCIgKENvbGUsIDIwMjYtMDktMTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VyZmFjZVBhdGgocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHAudHJpbSgpO1xuICBpZiAodCA9PT0gXCJ+XCIgfHwgdC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBleHBhbmRIb21lKHQpO1xuICBpZiAoIWlzQWJzb2x1dGUodCkpXG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgXCIke3B9XCIgaXMgbm90IGEgZnVsbCBwYXRoIOKAlCBzdGFydCBpdCB3aXRoIC8gb3Igfi9gLCA0MDApO1xuICByZXR1cm4gcmVzb2x2ZSh0KTtcbn1cblxuLyoqIEEgc3RydWN0dXJlIG9wIGZyb20gdGhlIHN1cmZhY2UsIHdpdGggZXZlcnkgcGF0aCBmaWVsZCB0aHJvdWdoIGBzdXJmYWNlUGF0aGAuICovXG5mdW5jdGlvbiBhbmNob3JTdXJmYWNlUGF0aHMob3A6IFN0cnVjdHVyZU9wKTogU3RydWN0dXJlT3Age1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5vcCB9O1xuICBmb3IgKGNvbnN0IGsgb2YgW1wiZGlyXCIsIFwicGF0aFwiLCBcImludG9cIl0gYXMgY29uc3QpXG4gICAgaWYgKHR5cGVvZiBvdXRba10gPT09IFwic3RyaW5nXCIpIG91dFtrXSA9IHN1cmZhY2VQYXRoKG91dFtrXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gb3V0IGFzIFN0cnVjdHVyZU9wO1xufVxuXG5mdW5jdGlvbiBleHBhbmRIb21lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwID09PSBcIn5cIikgcmV0dXJuIGhvbWVkaXIoKTtcbiAgaWYgKHAuc3RhcnRzV2l0aChcIn4vXCIpKSByZXR1cm4gam9pbihob21lZGlyKCksIHAuc2xpY2UoMikpO1xuICByZXR1cm4gcmVzb2x2ZShwKTtcbn1cblxuLyoqIFRoZSBkYWVtb24ncyBwcml2YXRlIGFyZ3Yg4oCUIHRoZSBDTEkgc3Bhd25zIGl0IHdpdGggZXhhY3RseSB0aGVzZS4gKi9cbmNvbnN0IERBRU1PTl9PUFRJT05TID0ge1xuICBsb2c6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB3b3Jrc3BhY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuLyoqIFBhcnNlIHRoZSBkYWVtb24ncyBhcmd2LCBib290LCBwcmludCB0aGUgaGFuZHNoYWtlLCB3YWl0IGZvciB0aGUgZW5kLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPjtcbiAgdHJ5IHtcbiAgICBmbGFncyA9IG5vZGVQYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBEQUVNT05fT1BUSU9OUywgc3RyaWN0OiB0cnVlIH0pLnZhbHVlcyBhcyBSZWNvcmQ8XG4gICAgICBzdHJpbmcsXG4gICAgICBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICA+O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgc2NyaXB0b3JpdW06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbiAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhcbiAgICAgICAgREFFTU9OX09QVElPTlMsXG4gICAgICApXG4gICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBkOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHN0YXJ0RGFlbW9uPj47XG4gIHRyeSB7XG4gICAgZCA9IGF3YWl0IHN0YXJ0RGFlbW9uKHtcbiAgICAgIHBvcnQ6IGZsYWdzLnBvcnQgPyBOdW1iZXIoZmxhZ3MucG9ydCkgOiAwLFxuICAgICAgcmVzdG9yZTogZmxhZ3MucmVzdG9yZSxcbiAgICAgIHRpbWVvdXRTOiBmbGFncy50aW1lb3V0ID8gTnVtYmVyKGZsYWdzLnRpbWVvdXQpIDogdW5kZWZpbmVkLFxuICAgICAgd29ya3NwYWNlOiBmbGFncy53b3Jrc3BhY2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaGFuZHNoYWtlIGxpbmUgaXMgSlNPTiBlaXRoZXIgd2F5LCBzbyB0aGUgQ0xJIHJlYWRzIE9ORSBzaGFwZS5cbiAgICBjb25zdCBzdGF0dXMgPSBlIGluc3RhbmNlb2YgU2Vzc2lvbkVycm9yID8gZS5zdGF0dXMgOiA1MDA7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgc3RhdHVzLCBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gc3RhdHVzID09PSA0MDQgPyA1IDogc3RhdHVzID09PSA0MDkgPyA2IDogMTtcbiAgfVxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9YCwgcG9ydDogZC5wb3J0LCBzZXNzaW9uX2lkOiBkLnNlc3Npb25JZCwgbW9kZTogZC5tb2RlLCBkaXI6IGQuZGlyIH0pfVxcbmAsXG4gICk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGQuZG9uZTtcbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IGEgY2xlYW4gY2xvc2UgbGVhdmVzIG5vIGVtcHR5IGxvZyBiZWhpbmQuXG4gIGlmIChyZXMuY29kZSA9PT0gMCAmJiBmbGFncy5sb2cpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHN0YXRTeW5jKGZsYWdzLmxvZykuc2l6ZSA9PT0gMCkgdW5saW5rU3luYyhmbGFncy5sb2cpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG4gIHJldHVybiByZXMuY29kZTtcbn1cblxuLyoqXG4gKiBUaGUgZGFlbW9uJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGVcbiAqIGJ1bmRsZSwgc28gdGhlcmUgaXMgbm8gc3VjaCBibG9jayBoZXJlLCBhbmQgdGhpcyB0YWtlcyBubyBhcmd1bWVudHM6IHRoZVxuICogY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdHdvIHByaW1pdGl2ZXMgdW5kZXIgQk9USCBvZiB0aGUgaG91c2UncyBkYWVtb24tZGlzY292ZXJ5IGNvbnZlbnRpb25zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogRDMgcnVsZWQgdGhhdCB0aGUgY29udmVudGlvbnMgdGhlbXNlbHZlcyDigJQgcGVyLXNlc3Npb24gdG1wZGlyIEpTT04gKGJvdW50eSxcbiAqIGdsYW1vdXIsIGltYWdvLCBtYWdwaWUpIGFuZCBzaW5nbGV0b24gYCRIT01FL2RhZW1vbi5wb3J0YCArIGBkYWVtb24ucGlkYFxuICogKGFzdHJvbGFiZSwgZ3JhcGV2aW5lLCBtaW5kLW1hcHBlcikg4oCUIGJvdGggc3Vydml2ZSwgYmVjYXVzZSB0aGV5IGVuY29kZVxuICogZ2VudWluZWx5IGRpZmZlcmVudCBtb2RlbHMgKGNvbmN1cnJlbnQgc2Vzc2lvbnMgdnMgYSBzdGFuZGluZyBzaW5nbGV0b24pIGFuZFxuICogcGlja2luZyBvbmUgaXMgYSBwcm9kdWN0IGRlY2lzaW9uLCBub3QgYSBmYWN0b3Jpbmcgb25lLiBXaGF0IElTIG9uZVxuICogaW1wbGVtZW50YXRpb24gaXMgdGhlIHBhaXIgYmVsb3csIHdoaWNoIGlzIGFsc28gZXhhY3RseSB3aGVyZSBjZW5zdXMgZGVmZWN0XG4gKiAqKkwzKiogbGl2ZXMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG4vKipcbiAqIFdyaXRlIGB0ZXh0YCB0byBgdGFyZ2V0YCBhdG9taWNhbGx5OiB3cml0ZSBiZXNpZGUgaXQsIHRoZW4gcmVuYW1lLlxuICpcbiAqIOKblCAqKkwzLCBDTE9TRUQgQlkgQ09OU1RSVUNUSU9OLioqIEEgYmFyZSBgd3JpdGVGaWxlU3luY2AgaXMgbm90IGF0b21pYywgc28gYVxuICogQ0xJIHJlYWRpbmcgd2hpbGUgdGhlIGRhZW1vbiB3cml0ZXMgY2FuIG9ic2VydmUgYSBIQUxGLVdSSVRURU4gcG9pbnRlci4gVW5kZXJcbiAqIGEgYmVzdC1lZmZvcnQgcmVhZGVyIHRoYXQgc3VyZmFjZWQgYXMgXCJubyBydW5uaW5nIHNlc3Npb25cIiDigJQgYWJzZW5jZSByZXBvcnRlZFxuICogZm9yIHdoYXQgd2FzIHJlYWxseSBhIHRvcm4gcmVhZCwgd2hpY2ggaXMgdGhlIGV4YWN0IGNvbmZsYXRpb24gdGhlIGhvdXNlJ3NcbiAqIGBudWxsYC1ub3QtYDBgIHJ1bGUgZXhpc3RzIHRvIHByZXZlbnQuIFJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeSBpcyBhdG9taWMsXG4gKiBzbyBhIHJlYWRlciBzZWVzIGVpdGhlciB0aGUgcHJldmlvdXMgcG9pbnRlciBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYSBwYXJ0aWFsXG4gKiBmaWxlLlxuICpcbiAqIEZpeGVkIGluIGdsYW1vdXIgMjAyNi0wOS0wNywgZm91bmQgc3RhbmRpbmcgaW4gdGhyZWUgc2libGluZ3MgdGhlIG5leHQgZGF5IGJ5XG4gKiB0aGUgZHVwbGljYXRpb24gcmVjb24sIGFuZCByZXBhaXJlZCBpbiBhbGwgb2YgdGhlbSB0aGUgb25seSB3YXkgdGhhdCBkb2VzIG5vdFxuICogbmVlZCBmaW5kaW5nIGFnYWluOiB0aGVyZSBpcyBub3cgb25lIGltcGxlbWVudGF0aW9uLlxuICpcbiAqIOKaoCBUaGUgdGVtcCBuYW1lIGNhcnJpZXMgdGhlIHBpZCwgc28gdHdvIGRhZW1vbnMgcmFjaW5nIHRvIHB1Ymxpc2ggdGhlIHNhbWVcbiAqIHBvaW50ZXIgY2Fubm90IGNsb2JiZXIgZWFjaCBvdGhlcidzIGludGVybWVkaWF0ZSBmaWxlIOKAlCBhbmQgaXQgaXMgcmVtb3ZlZCBvblxuICogYSBmYWlsZWQgd3JpdGUgcmF0aGVyIHRoYW4gbGVmdCBhcyBsaXR0ZXIgYmVzaWRlIHRoZSByZWFsIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlRmlsZUF0b21pYyh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRtcCA9IGAke3RhcmdldH0uJHtwcm9jZXNzLnBpZH0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgcmVuYW1lU3luYyh0bXAsIHRhcmdldCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBybVN5bmModG1wLCB7IGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZSBgcGF0aGAgaWZmIGl0IHN0aWxsIG5hbWVzIFVTLiBSZXR1cm5zIHdoZXRoZXIgaXQgd2FzIGRlbGV0ZWQuXG4gKlxuICog4puUICoqXCJTVElMTCBPVVJTXCIgSVMgVEhFIFdIT0xFIEZVTkNUSU9OLioqIEEgZGFlbW9uIHRoYXQgdW5saW5rcyBpdHMgZGlzY292ZXJ5XG4gKiBmaWxlIHVuY29uZGl0aW9uYWxseSBhdCBleGl0IGRlbGV0ZXMgdGhlIHBvaW50ZXIgYSBTVUNDRVNTT1IgaGFzIGFscmVhZHlcbiAqIHdyaXR0ZW4g4oCUIHRoZSBzdWNjZXNzb3IgY2FuIHRoZW4gbm8gbG9uZ2VyIGJlIGZvdW5kIGFuZCB0aGUgbmV4dCBDTEkgdmVyYiBzcGF3bnMgYVxuICogdGhpcmQgZGFlbW9uLiBCb3RoIGNvbnZlbnRpb25zIGhhdmUgdGhpcyBoYXphcmQgYW5kIGJvdGggZXhwcmVzcyBpdFxuICogZGlmZmVyZW50bHk6IGFzdHJvbGFiZSBjb21wYXJlcyB0aGUgcGlkIGZpbGUncyBieXRlcyB0byBpdHMgb3duIHBpZCxcbiAqIG1hZ3BpZSBwYXJzZXMgdGhlIEpTT04gcG9pbnRlciBhbmQgY29tcGFyZXMgYHNlc3Npb25faWRgLiBgaWRlbnRpZnlgIGlzIHdoYXRcbiAqIG1ha2VzIHRob3NlIG9uZSBmdW5jdGlvbiDigJQgaXQgdHVybnMgdGhlIGZpbGUncyBieXRlcyBpbnRvIHRoZSBpZGVudGl0eSB0b1xuICogY29tcGFyZSwgYW5kIGl0IGRlZmF1bHRzIHRvIHRoZSB0cmltbWVkIGJ5dGVzIHRoZW1zZWx2ZXMuXG4gKlxuICog4pqgIEV2ZXJ5IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGFuZCByZXBvcnRlZCBhcyBgZmFsc2VgOiB0aGUgZmlsZSBiZWluZyBnb25lLFxuICogdW5yZWFkYWJsZSwgb3IgdW5wYXJzZWFibGUgYWxsIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZSDigJQgaXQgaXMgbm90IG91cnMgdG9cbiAqIHJlbW92ZS4gQW4gdW5wYXJzZWFibGUgcG9pbnRlciBpcyBkZWxpYmVyYXRlbHkgTk9UIHRyZWF0ZWQgYXMgb3Vycywgd2hpY2ggaXNcbiAqIHRoZSBjb25zZXJ2YXRpdmUgaGFsZiBvZiB0aGUgc2FtZSBgbnVsbGAtbm90LWAwYCBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5saW5rSWZNYXRjaGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIGlkZW50aWZ5OiAocmF3OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGwgPSAocmF3KSA9PiByYXcudHJpbSgpLFxuKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlkZW50aWZ5KHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpICE9PSBleHBlY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBpbi1wcm9jZXNzIGV2ZW50IGxvZyDigJQgdGhlIGFwcGVuZC1vbmx5LCByZXBsYXlhYmxlIGJ1ZmZlclxuICogYmVoaW5kIGV2ZXJ5IHNwZWxsJ3MgYEdFVCAvZXZlbnRzYCBTU0UgdGFpbC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzXG4gKiBgc2NyaXB0cy9ldmVudHMudHNgIOKAlCB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMyLCBhbmQgdGhlIG9ubHkgb25lIG9mXG4gKiB0aGUgc2l4IGNvcGllZC1pbi1wbGFjZSBidXNlcyB0aGF0IGlzIGEgbW9kdWxlLCBpcyBib3VuZGVkLCBjYXJyaWVzIGFuIGVwb2NoLCBhbmQgaXNcbiAqIHVuaXQtdGVzdGVkLiBUaGUgZml2ZSBvdGhlcnMgYXJlIHRoZSBzYW1lIHR3ZW50eSBsaW5lcyB3cml0dGVuIGZpdmUgdGltZXMuXG4gKlxuICog4pSA4pSAIFRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyDigJQgVFdPIEJZIENPTlNUUlVDVElPTiwgT05FIEJZIE9QVC1JTiDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiDim5QgVEhFIEhFQURJTkcgVVNFRCBUTyBTQVkgXCJUSEUgVEhSRUUgVEhJTkdTIFRISVMgRklYRVMgQlkgQ09OU1RSVUNUSU9OXCIgQU5EXG4gKiBJVEVNIDIgSVMgTk9UIE9ORSBPRiBUSEVNLiBDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiBtaW5kLW1hcHBlcidzIHByZS13b3JrXG4gKiAoRDc5KTogYGVwb2NoYCBpcyBPUFRJT05BTCBoZXJlLCBzbyBMNiBpcyBjbG9zZWQgb25seSBmb3IgYSBjYWxsZXIgdGhhdCBhc2tzLlxuICogVGhyZWUgYWRvcHRlcnMgaGF2ZSBzaW5jZSBkZWNsaW5lZCB0byDigJQgaW1hZ28gKEQzOSksIGJvdW50eSAoRDQ4KSBhbmRcbiAqIGdyYXBldmluZSAoRDcwKSDigJQgc28gdGhlIGRlZmVjdCB0aGUgaGVhZGluZyBjbGFpbWVkIHRvIG1ha2UgaW1wb3NzaWJsZSBpc1xuICogbGl2ZSBpbiB0aGUgdHJlZSwgYnkgb3B0LW91dCwgYW5kIHRoZSBvdmVyY2xhaW0gaXMgd2hhdCBoaWQgdGhhdC4gSXRlbXMgMSBhbmRcbiAqIDMgQVJFIGJ5IGNvbnN0cnVjdGlvbjogYSBjYWxsZXIgY2Fubm90IHN3aXRjaCB0aGUgY2FwIG9mZiBvciByZWFjaCB0aGUgYnVmZmVyLlxuICpcbiAqIOKaoCBBTkQgTUlORC1NQVBQRVInUyBPV04gQlVTLCBXSElDSCBUSElTIE1PRFVMRSBDT05WRVJHRUQgVE9XQVJELCBUWVBFUyBUSEVcbiAqIEVQT0NIIEFTIFJFUVVJUkVEIGFuZCBzdGFtcHMgaXQgdW5jb25kaXRpb25hbGx5IOKAlCBpdCBpcyB0aGUgc3BlbGwgY2Vuc3VzIEw2XG4gKiBuYW1lcyBhcyBDT1JSRUNULiBNYWtpbmcgaXQgcmVxdWlyZWQgSEVSRSBpcyBub3QgdGhlIHJlcGFpcjogaXQgd291bGQgcmV2ZXJzZVxuICogRDM5LCBENDggYW5kIEQ3MC4gVGhlIGhvbmVzdCBzdGF0ZW1lbnQgaXMgdGhpcyBoZWFkaW5nLlxuICpcbiAqIOKblCAqKlJFU09MVkVEIEFUIFRIQVQgU1BFTEwnUyBQT1JULCBBTkQgVEhFIERJU1BPU0lUSU9OIElTIFJFQ09SREVEIEhFUkVcbiAqIEJFQ0FVU0UgQSBMT1NTIFRIQVQgTElWRVMgT05MWSBJTiBBIEpPVVJOQUwgSVMgQSBMT1NTIE5PQk9EWSBDQU4gU0VFXG4gKiAoRDc5L0Q4NSkuKiogbWluZC1tYXBwZXIgYWRvcHRlZCB0aGlzIG1vZHVsZSBpbiBQaGFzZSA3IGFuZCBrZXB0IGl0c1xuICogZ3VhcmFudGVlIFdJVEhPVVQgQSBLSVQgQ0hBTkdFOiBpdCBwYXNzZXMgYHsgZXBvY2g6IGNyeXB0by5yYW5kb21VVUlEKCkgfWAgYXRcbiAqIGl0cyBPTkUgY29uc3RydWN0aW9uIHNpdGUgYW5kIHJlLXRpZ2h0ZW5zIGBlcG9jaGAgdG8gUkVRVUlSRUQgaW4gaXRzIG93blxuICogbG9jYWwgZnJhbWUgdHlwZSwgc28gbm90aGluZyBpdHMgYnVzIGVtaXRzIGNhbiBsYWNrIG9uZS4gS2l0IGJ5dGVzOiB6ZXJvLlxuICogKipTbyB0aGUgZXBvY2ggaXMgYSBMT1NTWS1DT1BZIHByb3BlcnR5IHdob3NlIGRpc3Bvc2l0aW9uIGlzIEtFRVAtTE9DQUwsIG5vdFxuICogUkVTVE9SRSoqIOKAlCB0aGUgb25seSBwcm9wZXJ0eSBvZiB0aGF0IHNwZWxsJ3Mgb3duIG1vZHVsZSB0aGlzIG1vZHVsZSBjb3VsZFxuICogbm90IGNhcnJ5IGFuZCBkaWQgbm90IG5lZWQgdG8uIEw2IGlzIENMT1NFRCBmb3IgdGhlIHR3byBzcGVsbHMgdGhhdCBhc2sgYW5kXG4gKiBPUEVOLCBieSBvcHQtb3V0LCBmb3IgdGhlIHRocmVlIHRoYXQgZGVjbGluZTsgdGhhdCBhc3ltbWV0cnkgaXMgdGhlIGhvbmVzdFxuICogc3RhdGUgYW5kIHRoaXMgaGVhZGluZyBpcyB3aGVyZSBpdCBpcyB3cml0dGVuLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgQURPUFRJT04gUkVOQU1FUyBBIEZJRUxEIE9OIEFOIEFET1BURVInUyBQVUJMSVNIRUQgV0lSRS4qKiBgaWRgXG4gKiBpcyBuYW1lZCBpbiBgRnJhbWU8VD5gIGFuZCBpbiB0aGUgZW1pdCBsaXRlcmFsIGJlbG93LCBzbyBhIHNwZWxsIHdob3NlIGJ1c1xuICogc3BlbGxlZCB0aGUgY3Vyc29yIGFueXRoaW5nIGVsc2UgcGF5cyBhIHJlbmFtZSBhdCBldmVyeSByZWFkZXIg4oCUIGZvclxuICogbWluZC1tYXBwZXIsIDE3MyBvY2N1cnJlbmNlcyBhY3Jvc3MgNSBzdXJmYWNlIGZpbGVzLCB+MjA5IGFjcm9zcyB+MzAgYmFja2VuZFxuICogZmlsZXMsIGV2ZXJ5IEpTT05MIGxpbmUgaXRzIGB0YWlsYCB3cml0ZXMgaW50byBhbiBhZ2VudCdzIHBpcGUsIGFuZCAodGhlIG9uZVxuICogbm9ib2R5IGNvdW50ZWQpIHRoZSBGSVhUVVJFIGluIGl0cyBvd24gYHRhaWwudGVzdC50c2AsIHdoaWNoIFdSSVRFUyB0aGVcbiAqIGVudmVsb3BlIHdoaWxlIHN0YW5kaW5nIGluIGZvciB0aGUgZGFlbW9uLiBUaGUgTkVTVElORyBpcyBub3QgZm9yY2VkIOKAlFxuICogYEZyYW1lPFQ+YCBpcyBnZW5lcmljLCBhbmQgbWluZC1tYXBwZXIga2VwdCBge2tpbmQsIHBheWxvYWR9YCBuZXN0ZWQgd2hlcmUgYWxsXG4gKiBmaXZlIGVhcmxpZXIgYWRvcHRlcnMgZmxhdHRlbiBieSBpZGlvbS4gKipBbiBpZGlvbSBmaXZlIHNpYmxpbmdzIHNoYXJlIGlzXG4gKiBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY29udHJhY3QgdW50aWwgeW91IG9wZW4gdGhlIHR5cGUqKiAoRDgxLCBEODYpLlxuICpcbiAqICoqMSDCtyBMNSDigJQgdGhlIGJ1ZmZlciBpcyBib3VuZGVkLioqIEZpdmUgZGFlbW9ucyBhcHBlbmQgdG8gYW4gYXJyYXkgZm9yIHRoZVxuICogd2hvbGUgbGlmZSBvZiB0aGUgcHJvY2Vzcy4gVGhlIHdpbmRvdyBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogZGFlbW9uJ3MgbGlmZXRpbWUsIG5vdCBhIGR1cmFibGUgbG9nOyBhIGNhcCBpcyB0aGUgaG9uZXN0IHNoYXBlLlxuICpcbiAqICoqMiDCtyBMNiDigJQgYSBmcmFtZSBjYXJyaWVzIGFuIGVwb2NoLCBXSEVOIFRIRSBDQUxMRVIgQVNLUyBGT1IgT05FIChvcHQtaW4sXG4gKiBub3QgY29uc3RydWN0aW9uIOKAlCBzZWUgYWJvdmUpLioqIEFmdGVyIGEgcmVzdGFydCB0aGUgaWRzIHN0YXJ0IGFnYWluIGF0IDEsIHNvXG4gKiBhIHJlc3VtaW5nIGNsaWVudCBjYW5ub3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5IGlkIGFsb25lLlxuICpcbiAqICoqMyDCtyBBIFNUQUxFIFdBVEVSTUFSSyBSRVBMQVlTIEZST00gVEhFIEJFR0lOTklORywgYW5kIHRoaXMgaXMgdGhlIGhhbGYgdGhlXG4gKiBjbGllbnQgY2Fubm90IGRvLioqIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogYSB0YWlsIHRoYXQgcmVzdW1lcyBhdFxuICogYHNpbmNlPTxsYXN0IGlkIG9mIHRoZSBwcmV2aW91cyBkYWVtb24+YCBhZ2FpbnN0IGEgcmVzdGFydGVkIGRhZW1vbiByZWNlaXZlc1xuICogTk9USElORyDigJQgdGhlIG5ldyBkYWVtb24ncyBgcmVhZHlgIGlzIGlkIDEsIHdoaWNoIGlzIG5vdCBgPiBzaW5jZWAsIHNvIHRoZVxuICogZmlsdGVyIGRyb3BzIGl0LCBzbyBubyBmcmFtZSBhcnJpdmVzLCBzbyB0aGUgY2xpZW50J3MgZXBvY2ggY2hlY2sgbmV2ZXIgcnVuc1xuICogYW5kIHRoZSB0YWlsIHNpdHMgY29ubmVjdGVkIGFuZCBzaWxlbnQgdW50aWwgdGhlIG5ldyBkYWVtb24gaGFzIGVtaXR0ZWQgYXNcbiAqIG1hbnkgZXZlbnRzIGFzIHRoZSBvbGQgb25lIGRpZC4gU3RhbXBpbmcgYW4gZXBvY2ggYWxvbmUgZG9lcyBOT1QgY2xvc2UgdGhhdFxuICogZ2FwOiB0aGUgZXBvY2ggcmlkZXMgYSBmcmFtZSwgYW5kIHRoZSBidWcgaXMgdGhhdCBubyBmcmFtZSBpcyBzZW50LiBTb1xuICogYHN1YnNjcmliZWAgdHJlYXRzIGBzaW5jZSA+IGN1cnNvcmAgYXMgXCJ0aGlzIGN1cnNvciBpcyBmcm9tIGFub3RoZXIgcHJvY2Vzc1wiXG4gKiBhbmQgcmVwbGF5cyB3aG9sZS4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3RhaWwudGVzdC50c2AncyBlcG9jaCBjZWxsIGlzIHRoZVxuICogZXhlY3V0YWJsZSBzcGVjIG9mIHRoZSBjbGllbnQgaGFsZiBhbmQgc2hvd3MgdGhlIHJlY29ubmVjdCBzdGlsbCBjYXJyeWluZyB0aGVcbiAqIHN0YWxlIGN1cnNvciDigJQgZGV0ZWN0aW9uIGhhcHBlbnMgb24gd2hhdCBpcyBSRUNFSVZFRC5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBET0VTIE5PVCBBRE9QVCBUSElTLCBBTkQgVEhFIFJFRlVTQUwgSVMgUEFSVCBPRiBUSEUgUlVMSU5HIOKUgOKUgFxuICpcbiAqIFJFSkVDVC1TVFJVQ1RVUkFMLCBydWxlZCBhdCBncmFwZXZpbmUncyBwb3J0IChQaGFzZSA2LCAyMDI2LTA5LTA5OyBENjgpLiBOb3RcbiAqIFwibm8gc3ViamVjdFwiIOKAlCBncmFwZXZpbmUgSEFTIGFuIGV2ZW50IGJ1cyBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlXG4gKiBzcGVsbCDigJQgYnV0IHRoZSB0d28gc2hhcGVzIGNhbm5vdCBiZSBjb25zdHJ1Y3RlZCBmcm9tIGVhY2ggb3RoZXI6XG4gKlxuICogICB0aGlzIG1vZHVsZSAgb25lIHByb2Nlc3Mtd2lkZSBhcnJheSBjYXBwZWQgYXQgUkVQTEFZX0JVRkZFUl9TSVpFLCB3aXRoIG9uZVxuICogICAgICAgICAgICAgICAgbW9ub3RvbmljIGBzZXFgLCBhbmQgdGhlIGhlYWRlciB0aHJlZSBwYXJhZ3JhcGhzIHVwIHNheXMgaW4gYXNcbiAqICAgICAgICAgICAgICAgIG1hbnkgd29yZHMgdGhhdCBpdCBpcyBhIFJFUExBWSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuICogICAgICAgICAgICAgICAgZGFlbW9uJ3MgbGlmZXRpbWUsIE5PVCBhIGR1cmFibGUgbG9nLlxuICogICBncmFwZXZpbmUgICAgTiBkdXJhYmxlIGFwcGVuZC1vbmx5IGAuanNvbmxgIGZpbGVzLCBvbmUgcGVyIG5hbWVkIGNoYW5uZWwsXG4gKiAgICAgICAgICAgICAgICBlYWNoIHdpdGggaXRzIG93biBgbmV4dF9pZGAsIHJlcGxheWVkIGZyb20gZGlzayBieVxuICogICAgICAgICAgICAgICAgYHJlYWRCYWNrbG9nYCwgc3Vydml2aW5nIHJlc3RhcnQsIGByb2xsYCwgYXJjaGl2ZSBhbmQgY2xlYXIuXG4gKlxuICogKipUaGUgcmVhZGVyIHRoYXQgbWFrZXMgdGhlbSBpbmNvbXBhdGlibGUsIGFzIGEgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYW5cbiAqIGFzc2VydGlvbjoqKiBncmFwZXZpbmUncyBgbG9hZENoYW5uZWwoKWAgZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBISUdILVdBVEVSXG4gKiBNQVJLIG92ZXIgZXZlcnkgcGFyc2VhYmxlIGxpbmUgb2YgdGhlIGNoYW5uZWwncyBmaWxlIG9uIGJvb3QuIFRoZXJlIGlzIG5vXG4gKiBhcnJheSB0byBiZSB0aGF0IG1hcmsgb2YsIGFuZCBubyBjYXAgdGhhdCB3b3VsZCBub3Qgc2lsZW50bHkgZGlzY2FyZCBoaXN0b3J5XG4gKiBhIGNhbGxlciBjYW4gc3RpbGwgYXNrIGZvciBieSBpZC4gSXQgaXMgdGhlIHRoaW5nIHRoaXMgbW9kdWxlJ3Mgb3duIGhlYWRlclxuICogc2F5cyBpdCBpcyBkZWxpYmVyYXRlbHkgbm90LlxuICpcbiAqICoqVGhlIHdpZGVuaW5nIE5PVCBkb25lLCB3aXRoIGl0cyBjb3N0OioqIGFkbWl0dGluZyBhIHBlci1jaGFubmVsIGR1cmFibGVcbiAqIHN0b3JlIHdvdWxkIGNoYW5nZSBgY3JlYXRlRXZlbnRMb2dgJ3Mgc3RvcmFnZSBhbmQgaXRzIGBzdWJzY3JpYmVgIGNvbnRyYWN0IGZvclxuICogZml2ZSBvdGhlciBkYWVtb25zLCByZS1lbWl0dGluZyBTSVggYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGFcbiAqIGRyaXZlIOKAlCBwYWlkIGJ5IHBvcnRzIHRoYXQgYXJlIGFscmVhZHkgZmluaXNoZWQgYW5kIGJ5IGFnZW50cyBub3QgaW4gdGhlIHJvb20uXG4gKiBBIHdpZGVuaW5nIHJlbWFpbnMgYXZhaWxhYmxlIGFzIGl0cyBvd24gYXJndWVkIGRlY2lzaW9uIHdpdGggaXRzIG93blxuICogYmxhc3QtcmFkaXVzIGNvdW50OyBpdCBpcyBuZXZlciBhIHN0ZXAgaW5zaWRlIGEgcG9ydC5cbiAqXG4gKiDimqAgQU5EIFRIRSBgZXBvY2hgIEFCT1ZFIElTIFRIRSBTSEFSUEVTVCBIQUxGIE9GIFdIWSAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZVxuICogUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQsIHNvIHRoZSBjb25kaXRpb24gcGFyYWdyYXBoIDIgZGVzY3JpYmVzIOKAlCBpZHNcbiAqIHN0YXJ0aW5nIGFnYWluIGF0IDEg4oCUIGNhbm5vdCBvY2N1ciB0aGVyZSwgYW5kIHN0YW1waW5nIG9uZSBhbnl3YXkgaXMgbm90XG4gKiBpbmVydDogYHRhaWxFdmVudHNgJ3MgYG9uRXBvY2hDaGFuZ2VgIHNldHMgdGhlIGN1cnNvciB0byAwLCBhbmQgZ3JhcGV2aW5lJ3NcbiAqIHRhaWwgcm91dGUgYW5zd2VycyBgc2luY2U9MGAgd2l0aCB0aGUgV0hPTEUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW5cbiAqIGFnZW50J3MgcGlwZSwgb24gZXZlcnkgYHJvbGxgLiBUaGUgZXBvY2gncyBjbGllbnQtc2lkZSBhY3Rpb24gaXMgXCJ5b3VyIGN1cnNvclxuICogaXMgd29ydGhsZXNzLCBzdGFydCBvdmVyXCIsIGFuZCB0aGF0IGlzIHNhZmUgb25seSB3aGVyZSBzdGFydGluZyBvdmVyIGNvc3RzIGFcbiAqIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cuXG4gKi9cblxuLyoqIFRoZSBkZWZhdWx0IHJlcGxheSB3aW5kb3csIGluaGVyaXRlZCBmcm9tIG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgY2FwLiAqL1xuZXhwb3J0IGNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8qKiBBIGZyYW1lIGFzIGl0IGdvZXMgb24gdGhlIHdpcmU6IHRoZSBjYWxsZXIncyBwYXlsb2FkIHBsdXMgYSBtb25vdG9uaWMgYGlkYCxcbiAqICBwbHVzIGFuIGBlcG9jaGAgd2hlbiB0aGUgbG9nIHdhcyBnaXZlbiBvbmUuICovXG5leHBvcnQgdHlwZSBGcmFtZTxUPiA9IFQgJiB7IGlkOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRMb2c8VD4ge1xuICAvKiogQXBwZW5kIG9uZSBmcmFtZSwgZmFuIGl0IG91dCB0byBsaXZlIHN1YnNjcmliZXJzLCBhbmQgcmV0dXJuIGl0LiAqL1xuICBlbWl0KG1zZzogVCk6IEZyYW1lPFQ+O1xuICAvKipcbiAgICogUmVwbGF5IGV2ZXJ5dGhpbmcgYWZ0ZXIgYHNpbmNlYCwgdGhlbiBzdGF5IHN1YnNjcmliZWQuIFJldHVybnMgYW5cbiAgICogdW5zdWJzY3JpYmUgZnVuY3Rpb24uXG4gICAqXG4gICAqIOKblCBSRVBMQVkgQU5EIFNVQlNDUklCRSBBUkUgT05FIENBTEwgT04gUFVSUE9TRS4gRG9pbmcgdGhlbSBpbiB0d28gc3RlcHNcbiAgICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGFuIGVtaXQgbGFuZHMgYmV0d2VlbiB0aGUgcmVwbGF5IGxvb3AgYW5kIHRoZVxuICAgKiBgYWRkYCwgYW5kIHRoYXQgZnJhbWUgaXMgZGVsaXZlcmVkIHRvIG5vYm9keSDigJQgdGhlIHNoYXBlIGZpdmUgZGFlbW9ucyBoYXZlLFxuICAgKiBzdXJ2aXZlZCBieSBub3RoaW5nIGJ1dCB0aGUgc2luZ2xlLXRocmVhZGVkIGV2ZW50IGxvb3AgaGFwcGVuaW5nIHRvIGNsb3NlXG4gICAqIGl0LiBEZXBlbmRpbmcgb24gdGhhdCBpcyBkZXBlbmRpbmcgb24gYW4gaW1wbGVtZW50YXRpb24gZGV0YWlsIG9mIHRoZVxuICAgKiBydW50aW1lIHJhdGhlciB0aGFuIG9uIHRoZSBjb2RlLlxuICAgKi9cbiAgc3Vic2NyaWJlKHNpbmNlOiBudW1iZXIsIGxpc3RlbmVyOiAoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkKTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBoaWdoZXN0IGlkIGVtaXR0ZWQgc28gZmFyIOKAlCB3aGF0IGBHRVQgL3N0YXRlYCByZXR1cm5zIGFzIGBjdXJzb3JgLiAqL1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICAvKiogVGhlIGVwb2NoIHN0YW1wZWQgb24gZXZlcnkgZnJhbWUsIG9yIGB1bmRlZmluZWRgIGlmIG5vbmUgd2FzIGNvbmZpZ3VyZWQuICovXG4gIHJlYWRvbmx5IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFdmVudExvZzxUIGV4dGVuZHMgb2JqZWN0PihcbiAgb3B0czogeyBlcG9jaD86IHN0cmluZzsgYnVmZmVyU2l6ZT86IG51bWJlciB9ID0ge30sXG4pOiBFdmVudExvZzxUPiB7XG4gIGNvbnN0IGJ1ZmZlclNpemUgPSBvcHRzLmJ1ZmZlclNpemUgPz8gUkVQTEFZX0JVRkZFUl9TSVpFO1xuICBjb25zdCBlcG9jaCA9IG9wdHMuZXBvY2g7XG4gIGNvbnN0IGJ1ZmZlcjogQXJyYXk8RnJhbWU8VD4+ID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8KGZyYW1lOiBGcmFtZTxUPikgPT4gdm9pZD4oKTtcbiAgbGV0IHNlcSA9IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcblxuICAgIGVtaXQobXNnKSB7XG4gICAgICBzZXEgKz0gMTtcbiAgICAgIC8vIOKblCBUSEUgTU9OT1RPTklDIElEIFdJTlMgT1ZFUiBBTllUSElORyBJTiBUSEUgUEFZTE9BRCwgQU5EIFVOVElMIE5PVyBJVFxuICAgICAgLy8gT05MWSBDTEFJTUVEIFRPLiBCb3RoIGFkb3B0aW5nIGRhZW1vbnMgd3JvdGUgYHsgaWQ6ICsrc2VxLCAuLi5tc2cgfWBcbiAgICAgIC8vIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJ0aGUgbW9ub3RvbmljIGBpZGAgTVVTVCB3aW4gb3ZlciBhbnkgYGlkYCBpblxuICAgICAgLy8gdGhlIHBheWxvYWQsIHNvIGNhbGxlcnMgY2FycnkgYSBwcm9qZWN0IGlkZW50aWZpZXIgYXMgYHByb2plY3RJZGAsXG4gICAgICAvLyBuZXZlciBgaWRgXCIg4oCUIGJ1dCBzcHJlYWQgb3JkZXIgbWVhbnMgYSBwYXlsb2FkIGBpZGAgb3ZlcnJvZGUgdGhlXG4gICAgICAvLyBjdXJzb3IsIHNpbGVudGx5LCBhbmQgdGhlIGNvbnZlbnRpb24gaW4gdGhlIGNvbW1lbnQgd2FzIHRoZSBvbmx5IHRoaW5nXG4gICAgICAvLyBob2xkaW5nIGl0LiBUaGUgbGl0ZXJhbCBrZWVwcyBgaWRgIEZJUlNUIHNvIHRoZSB3aXJlIGtleSBvcmRlciBpc1xuICAgICAgLy8gdW5jaGFuZ2VkOyB0aGUgYXNzaWdubWVudCBhZnRlciB0aGUgc3ByZWFkIGlzIHdoYXQgbWFrZXMgdGhlIHNlbnRlbmNlXG4gICAgICAvLyB0cnVlLiBgZXBvY2hgIGlzIHN0YW1wZWQgdGhlIHNhbWUgd2F5IGFuZCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICAgICAgY29uc3QgZnJhbWUgPSB7IGlkOiBzZXEsIC4uLm1zZyB9IGFzIEZyYW1lPFQ+O1xuICAgICAgZnJhbWUuaWQgPSBzZXE7XG4gICAgICBpZiAoZXBvY2ggIT09IHVuZGVmaW5lZCkgZnJhbWUuZXBvY2ggPSBlcG9jaDtcblxuICAgICAgYnVmZmVyLnB1c2goZnJhbWUpO1xuICAgICAgaWYgKGJ1ZmZlci5sZW5ndGggPiBidWZmZXJTaXplKSBidWZmZXIuc2hpZnQoKTtcbiAgICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgbGlzdGVuZXJzKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICByZXR1cm4gZnJhbWU7XG4gICAgfSxcblxuICAgIHN1YnNjcmliZShzaW5jZSwgbGlzdGVuZXIpIHtcbiAgICAgIC8vIFNlZSB0aGUgaGVhZGVyLCBwb2ludCAzOiBhIGN1cnNvciBiZXlvbmQgb3VyIG93biBpcyBhIGN1cnNvciBmcm9tIGFcbiAgICAgIC8vIFBSSU9SIFBST0NFU1MsIGFuZCB0aGUgb25seSB1c2VmdWwgcmVhZGluZyBvZiBpdCBpcyBcInJlcGxheSB3aG9sZVwiLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBIE5PTi1GSU5JVEUgQ1VSU09SIEFMU08gTUVBTlMgXCJGUk9NIFRIRSBTVEFSVFwiLCB3aGljaCB0aGUgY29waWVzIGdvdFxuICAgICAgLy8gd3JvbmcgYnkgYWNjaWRlbnQ6IHRoZXkgd3JvdGUgYHBhcnNlSW50KHBhcmFtID8/IFwiLTFcIilgIGFuZCBjb21wYXJlZFxuICAgICAgLy8gYGlkID4gc2luY2VgLCBzbyBhIHR5cG8nZCBgP3NpbmNlPXhgIHByb2R1Y2VkIGBOYU5gLCBldmVyeSBjb21wYXJpc29uXG4gICAgICAvLyB3YXMgZmFsc2UsIGFuZCB0aGUgdGFpbCBvcGVuZWQgRU1QVFkgYW5kIHN0YXllZCBjb25uZWN0ZWQg4oCUIHRoZSBzYW1lXG4gICAgICAvLyBzaWxlbnQtYW5kLWNvbm5lY3RlZCBzeW1wdG9tIGFzIHRoZSBzdGFsZSB3YXRlcm1hcmssIGZyb20gYSBkaWZmZXJlbnRcbiAgICAgIC8vIGNhdXNlLiBBYnNlbnQgYW5kIHVucGFyc2VhYmxlIGFyZSB0aGUgc2FtZSByZXF1ZXN0IGhlcmUuXG4gICAgICBjb25zdCBmcm9tID0gIU51bWJlci5pc0Zpbml0ZShzaW5jZSkgfHwgc2luY2UgPiBzZXEgPyAtMSA6IHNpbmNlO1xuICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGZyYW1lLmlkID4gZnJvbSkgbGlzdGVuZXIoZnJhbWUpO1xuICAgICAgfVxuICAgICAgbGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICAgIH07XG4gICAgfSxcblxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgZGFlbW9uIGxpZmVjeWNsZSB0YWlsOiB0aGUgaWRsZS1jbG9zZSBkZWNpc2lvbiwgdGhlIHN3ZWVwXG4gKiB0aGF0IG1ha2VzIGl0LCBhbmQgdGhlIGJvdW5kZWQgdGVhcmRvd24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgYm91bnR5IOKAlCB0aGUgY2Vuc3VzJ3NcbiAqIGNvbnZlcmdlbmNlIHRhcmdldCAjMyDigJQgd2l0aCBhc3Ryb2xhYmUncyBgdGltZW91dE1zID4gMGAgZ3VhcmQgZm9sZGVkIGluLFxuICogd2hpY2ggaXMgdGhlIG9uZSB0aGluZyBib3VudHkncyBjb3B5IGRvZXMgbm90IGV4cHJlc3MuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgQURPUFRTIGBkcmFpbkFuZFN0b3BgIEFORCBOT1RISU5HIEVMU0UgSEVSRSDigJQgU1BMSVQgUEVSIEVYUE9SVFxuICpcbiAqIFJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCksIGFuZCBpdCBpcyB3cml0dGVuIGRvd25cbiAqIGJlY2F1c2UgYSByb3cgaXMgYSBNT0RVTEUgYW5kIFwicGFydGlhbFwiIGlzIG5vdCBhbiBhbnN3ZXIgdW50aWwgaXQgc2F5cyB3aGljaFxuICogZXhwb3J0cy4gR3JhcGV2aW5lIGlzIGxvbmctcnVubmluZywgc28gbm90aGluZyBhYm91dCBpdHMgbGlmZWN5Y2xlIG1ha2VzIHRoaXNcbiAqIG1vZHVsZSByZWFkIGFzIGluYXBwbGljYWJsZSDigJQgYW5kIHR3byBvZiBpdHMgdGhyZWUgZXhwb3J0cyBzdGlsbCBoYXZlIG5vXG4gKiBzdWJqZWN0IHRoZXJlOlxuICpcbiAqICAgYHNob3VsZElkbGVDbG9zZWAgICAgICBOTyBTVUJKRUNULiBHcmFwZXZpbmUgcnVucyBubyBpZGxlIHN3ZWVwIGFuZCBoYXMgbm9cbiAqICAgYHN0YXJ0SG91c2VrZWVwaW5nYCAgICBgLS10aW1lb3V0YDsgaXQgaXMgYSBicm9rZXIgdGhhdCBzdGFuZHMgdW50aWwgYHN0b3BgXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgKGBERUxFVEUgL2ApIG9yIGEgc2lnbmFsLCBhbmQgaXQgdGFrZXMgbm8gc25hcHNob3QuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgQWRvcHRpbmcgdGhlIHBhaXItbWFuYWdlciB3b3VsZCBtZWFuIHdyaXRpbmcgYSBuby1vcFxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGB0b3VjaGAgYW5kIGEgYHN1YnNjcmliZXJDb3VudGAgdGhhdCBleGlzdHMgb25seSB0b1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhIG51bWJlciBub2JvZHkgYWN0cyBvbiDigJQgdHdvIGxpZXMgdG8gZ2FpbiBhXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYGNsZWFySW50ZXJ2YWxgLlxuICogICBgZHJhaW5BbmRTdG9wYCAgICAgICAgIEFET1BURUQsIGFuZCBpdCBpcyBhIERFLURVUExJQ0FUSU9OIHJhdGhlciB0aGFuIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBnYWluOiBncmFwZXZpbmUncyB0ZWFyZG93biBhbHJlYWR5IFdBU1xuICogICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9taXNlLnJhY2UoW3NlcnZlci5zdG9wKHRydWUpLCAyMDAgbXNdKWAsIHdoaWNoIGlzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHN0b3BNc2AgZXhhY3RseS5cbiAqXG4gKiDimqAgKipBTkQgSVQgSVMgQ0FMTEVEIFdJVEggTk8gYGNsaWVudHNgLCBXSElDSCBJUyBBIE1FQVNVUkVNRU5ULCBOT1QgQU5cbiAqIE9WRVJTSUdIVC4qKiBUaGlzIG1vZHVsZSBjbG9zZXMgYSBoZWxkIGNvbm5lY3Rpb24gYnkgY2FsbGluZyBgY2xpZW50LmNsb3NlKClgO1xuICogZ3JhcGV2aW5lJ3Mgc3Vic2NyaWJlciByZWNvcmRzIGFyZSBge2FsaWFzLCBodW1hbiwgbHVyaywgc2VuZH1gIGFuZCBjYXJyeSBub1xuICogYGNsb3NlYCDigJQgaXRzIHBlci1zdHJlYW0gdGVhcmRvd24gaXMgYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtXG4gKiBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tIGBjYW5jZWwoKWAuIFRoZXJlIGlzIG5vdGhpbmcgdG8gaGFuZCB0aGVcbiAqIGFyZ3VtZW50LiBgc3NlLnRzYCdzIGhlYWRlciBjYXJyaWVzIHRoZSByZXN0IG9mIHRoYXQgcnVsaW5nLCBpbmNsdWRpbmcgdGhlXG4gKiB3aWRlbmluZyBub3QgZG9uZSBhbmQgaXRzIGNvc3QgKHNpeCBhcnRpZmFjdHMgYWNyb3NzIGZpdmUgc3BlbGxzKS5cbiAqXG4gKiDimqAgR3JhcGV2aW5lIGFsc28gcGFzc2VzIGBncmFjZU1zOiAwYC4gTm90IGEgZGlzYWdyZWVtZW50IHdpdGggdGhlIGdyYWNlXG4gKiBwZXJpb2Q6IGl0IGVtaXRzIG5vIGZhcmV3ZWxsIGZyYW1lIGF0IGRhZW1vbiBzaHV0ZG93biwgYW5kIGl0cyBgREVMRVRFIC9gXG4gKiBhbHJlYWR5IHJldHVybnMgdGhlIHJlc3BvbnNlIGFuZCBzY2hlZHVsZXMgdGhlIHRlYXJkb3duIDEwIG1zIGxhdGVyLCBzbyBpdHNcbiAqIGZsdXNoIHdpbmRvdyBzaXRzIGF0IHRoZSByb3V0ZSByYXRoZXIgdGhhbiBpbiB0aGUgZHJhaW4uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTc2VDbGllbnRzIH0gZnJvbSBcIi4vc3NlLnRzXCI7XG5cbi8qKlxuICogU2hvdWxkIHRoZSBkYWVtb24gaWRsZS1jbG9zZT9cbiAqXG4gKiDim5QgKipgc3Vic2NyaWJlckNvdW50YCBJUyBBIFJFUVVJUkVEIEFSR1VNRU5ULCBBTkQgVEhBVCBJUyBUSEUgV0hPTEUgUE9JTlQuKipcbiAqIFRoaXMgY2xvc2VzIGNlbnN1cyBkZWZlY3QgKipMMSoqIGJ5IGNvbnN0cnVjdGlvbjogZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZVxuICogY291bnRlZCB0aGVpciBpZGxlIGZsb29yIGRvd24gd2hpbGUgYW4gYWdlbnQgaGVsZCBhIHRhaWwgb3Blbiwgc28gYW4gYWdlbnRcbiAqIHdhdGNoaW5nIGEgcXVpZXQgYm9hcmQgd2FzIGtpbGxlZCBXSVRIIElUUyBDT05ORUNUSU9OIE9QRU4uIFRoZXJlIGlzIG5vXG4gKiBvdmVybG9hZCBvZiB0aGlzIGZ1bmN0aW9uIHRoYXQgY2Fubm90IHNlZSBpdHMgc3Vic2NyaWJlcnMsIHNvIHRoZSBkZWZlY3RcbiAqIGNhbm5vdCBiZSByZS1leHByZXNzZWQgYnkgYSBjYWxsZXIgd2hvIGZvcmdldHMuXG4gKlxuICog4puUICoqQU5EIFRIRSBTQ0FSIElUIENBTUUgV0lUSCwgcmUtaG9tZWQgZnJvbSBib3VudHkgdmVyYmF0aW0gaW4gc3Vic3RhbmNlOioqXG4gKiBhIGJvYXJkIG9ubHkgY291bnRzIGl0cyBpZGxlIGZsb29yIGRvd24gd2hpbGUgVU5XQVRDSEVELiBBIGxpdmUgc3Vic2NyaWJlciDigJRcbiAqIGEgYnJvd3NlciBXZWJTb2NrZXQsIG9yIGFuIGFnZW50IFNTRSB0YWlsIG9uIGAvZXZlbnRzYCDigJQga2VlcHMgaXQgb3BlblxuICogaW5kZWZpbml0ZWx5LiBTbyBgdGltZW91dGAgbWVhbnMgXCJsaW5nZXIgdGhpcyBsb25nIGFmdGVyIHRoZSBMQVNUIHN1YnNjcmliZXJcbiAqIGxlYXZlc1wiLCBOT1QgXCJtYXhpbXVtIGlkbGUgd2hpbGUgY29ubmVjdGVkXCIuIFRoZSBzd2VlcCBiZWxvdyBhbHNvIHRvdWNoZXMgdGhlXG4gKiBhY3Rpdml0eSBjbG9jayBvbiBldmVyeSB0aWNrIHdoaWxlIHdhdGNoZWQsIHNvIG9uY2UgdW53YXRjaGVkIHRoZSBmbG9vclxuICogY291bnRzIGZyb20gdGhhdCBsYXN0IGRpc2Nvbm5lY3QgYW5kIG5vdCBmcm9tIHRoZSBsYXN0IHJlcXVlc3QuXG4gKlxuICog4pqgIGB0aW1lb3V0TXMgPD0gMGAgbWVhbnMgTkVWRVIsIHdoaWNoIGlzIGFzdHJvbGFiZSdzIHN0YW5kaW5nLW9ic2VydmF0b3J5XG4gKiBkZWZhdWx0IGFuZCBpcyB3aHkgdGhlIGd1YXJkIGlzIGhlcmUgcmF0aGVyIHRoYW4gYXQgaXRzIG9uZSBjYWxsIHNpdGU6IGFcbiAqIHNpbmdsZXRvbiBkYWVtb24gaXMgbWVhbnQgdG8gc3RhbmQgdW50aWwgaXQgaXMgZXhwbGljaXRseSBjbG9zZWQsIGFuZCBhXG4gKiBgPj0gMGAgY29tcGFyaXNvbiB3b3VsZCBjbG9zZSBpdCBvbiB0aGUgZmlyc3QgdGljay5cbiAqXG4gKiBDbG9jay1mcmVlIGFuZCBmcy1mcmVlLCBzbyBpdCBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZGFlbW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkSWRsZUNsb3NlKFxuICBzdWJzY3JpYmVyQ291bnQ6IG51bWJlcixcbiAgaWRsZU1zOiBudW1iZXIsXG4gIHRpbWVvdXRNczogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIGlmICh0aW1lb3V0TXMgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoc3Vic2NyaWJlckNvdW50ID4gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaWRsZU1zID49IHRpbWVvdXRNcztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3VzZWtlZXBpbmdPcHRpb25zIHtcbiAgLyoqIOKblCBSRVFVSVJFRC4gU2VlIGBzaG91bGRJZGxlQ2xvc2VgIOKAlCB0aGlzIGlzIHdoYXQgY2xvc2VzIEwxLiAqL1xuICBzdWJzY3JpYmVyQ291bnQ6ICgpID0+IG51bWJlcjtcbiAgLyoqIE1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgbGFzdCBhY3Rpdml0eS4gKi9cbiAgaWRsZU1zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXNldCB0aGUgYWN0aXZpdHkgY2xvY2suIENhbGxlZCBvbiBldmVyeSB0aWNrIHRoYXQgaGFzIGEgc3Vic2NyaWJlci4gKi9cbiAgdG91Y2g6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgY29uZmlndXJlZCBpZGxlIHRpbWVvdXQgaW4gbXM7IGAwYCAob3IgbGVzcykgbWVhbnMgbmV2ZXIuICovXG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICAvKiogRmlyZWQgb25jZSB3aGVuIHRoZSBkYWVtb24gc2hvdWxkIGNsb3NlIGl0c2VsZi4gKi9cbiAgb25JZGxlQ2xvc2U6ICgpID0+IHZvaWQ7XG4gIC8qKiBUaGUgZGVib3VuY2VkIHNuYXBzaG90LCBpZiB0aGUgc3BlbGwgaGFzIG9uZS4gKi9cbiAgc25hcHNob3Q/OiB7XG4gICAgZGlydHk6ICgpID0+IGJvb2xlYW47XG4gICAgY2xlYXI6ICgpID0+IHZvaWQ7XG4gICAgd3JpdGU6ICgpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICB9O1xuICAvKiogU3dlZXAgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDI1MCBtcy4gKi9cbiAgdGlja01zPzogbnVtYmVyO1xuICAvKiogU25hcHNob3QgaW50ZXJ2YWw7IGJvdGggYWRvcHRpbmcgZGFlbW9ucyB1c2VkIDEwMDAgbXMuICovXG4gIHNuYXBzaG90TXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RhcnQgdGhlIHR3byBzdGFuZGluZyB0aW1lcnMgZXZlcnkgc2Vzc2lvbiBkYWVtb24gcnVucyDigJQgdGhlIGlkbGUgc3dlZXAgYW5kXG4gKiB0aGUgZGVib3VuY2VkIHNuYXBzaG90IOKAlCBhbmQgcmV0dXJuIHRoZSBmdW5jdGlvbiB0aGF0IHN0b3BzIGJvdGguXG4gKlxuICogVGhleSBhcmUgT05FIGNhbGwgYmVjYXVzZSB0aGV5IGhhdmUgYWx3YXlzIGJlZW4gb25lIGxpZmV0aW1lOiBldmVyeSBjb3B5XG4gKiBjbGVhcmVkIGJvdGggaW4gdGhlIHNhbWUgdHdvIGxpbmVzIGFmdGVyIGBhd2FpdCBkb25lYCwgYW5kIHRoZSBwYWlyIHRoYXQgZ2V0c1xuICogZm9yZ290dGVuIGlzIHRoZSBwYWlyIHdob3NlIHRpbWVycyBrZWVwIGEgcHJvY2VzcyBhbGl2ZSBhZnRlciB0ZWFyZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0SG91c2VrZWVwaW5nKG9wdHM6IEhvdXNla2VlcGluZ09wdGlvbnMpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgdGlja01zID0gb3B0cy50aWNrTXMgPz8gMjUwO1xuICBjb25zdCBzbmFwc2hvdE1zID0gb3B0cy5zbmFwc2hvdE1zID8/IDEwMDA7XG5cbiAgY29uc3QgaWRsZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3B0cy5zdWJzY3JpYmVyQ291bnQoKTtcbiAgICBpZiAoc3Vic2NyaWJlcnMgPiAwKSBvcHRzLnRvdWNoKCk7XG4gICAgaWYgKHNob3VsZElkbGVDbG9zZShzdWJzY3JpYmVycywgb3B0cy5pZGxlTXMoKSwgb3B0cy50aW1lb3V0TXMpKSBvcHRzLm9uSWRsZUNsb3NlKCk7XG4gIH0sIHRpY2tNcyk7XG5cbiAgY29uc3Qgc25hcCA9IG9wdHMuc25hcHNob3Q7XG4gIGNvbnN0IHNuYXBUaW1lciA9IHNuYXBcbiAgICA/IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKCFzbmFwLmRpcnR5KCkpIHJldHVybjtcbiAgICAgICAgc25hcC5jbGVhcigpO1xuICAgICAgICB2b2lkIHNuYXAud3JpdGUoKTtcbiAgICAgIH0sIHNuYXBzaG90TXMpXG4gICAgOiBudWxsO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2xlYXJJbnRlcnZhbChpZGxlVGltZXIpO1xuICAgIGlmIChzbmFwVGltZXIgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoc25hcFRpbWVyKTtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcmFpbk9wdGlvbnMge1xuICAvKiogVGhlIGJvdW5kIHNlcnZlci4gVHlwZWQgc3RydWN0dXJhbGx5IHNvIHRoZSBraXQgc3RheXMgZnJlZSBvZiBgYnVuYC4gKi9cbiAgc2VydmVyOiB7IHN0b3AoY2xvc2VBY3RpdmVDb25uZWN0aW9ucz86IGJvb2xlYW4pOiB1bmtub3duIH07XG4gIC8qKiBMaXZlIFNTRSB0YWlsczsgZXZlcnkgcmVnaXN0ZXJlZCBjbG9zZXIgaXMgaW52b2tlZC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBMaXZlIFdlYlNvY2tldHMuICovXG4gIHNvY2tldHM/OiBJdGVyYWJsZTx7IGNsb3NlKCk6IHZvaWQgfT47XG4gIC8qKiBIb3cgbG9uZyBxdWV1ZWQgZnJhbWVzIGdldCB0byBmbHVzaCBiZWZvcmUgYW55dGhpbmcgaXMgY2xvc2VkLiAqL1xuICBncmFjZU1zPzogbnVtYmVyO1xuICAvKiogSG93IGxvbmcgdGhlIGdyYWNlZnVsIHN0b3AgZ2V0cyBiZWZvcmUgdGVhcmRvd24gcHJvY2VlZHMgcmVnYXJkbGVzcy4gKi9cbiAgc3RvcE1zPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIENsb3NlIGV2ZXJ5IGhlbGQgY29ubmVjdGlvbiBhbmQgc3RvcCB0aGUgc2VydmVyLCBpbiBib3VuZGVkIHRpbWUuXG4gKlxuICog4puUICoqVEhFIEdSQUNFIFBFUklPRCBJUyBOT1QgUE9MSVRFTkVTUy4qKiBBIGBjbG9zZWRgIGZyYW1lIGVtaXR0ZWQgYW5kIHRoZW5cbiAqIGZvbGxvd2VkIGltbWVkaWF0ZWx5IGJ5IGFuIGFnZ3Jlc3NpdmUgYHNlcnZlci5zdG9wKHRydWUpYCBpcyBhIGZyYW1lIHRoZVxuICogY2xpZW50IG5ldmVyIHNlZXMg4oCUIHRoZSBxdWV1ZSBnb2VzIHdpdGggdGhlIHNvY2tldC4gVGhlIDE1MCBtcyBpcyB3aGF0IHR1cm5zXG4gKiBcInRoZSBkYWVtb24gdG9sZCB5b3Ugd2h5IGl0IGRpZWRcIiBmcm9tIGEgaG9wZSBpbnRvIGFuIG9ic2VydmF0aW9uLCBhbmQgZXZlcnlcbiAqIG9uZSBvZiB0aGUgZWlnaHQgZGFlbW9ucyBjb252ZXJnZWQgb24gdGhhdCBudW1iZXIgaW5kZXBlbmRlbnRseS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNUT1AgSVMgUkFDRUQsIEJFQ0FVU0UgQSBTTE9XIFNPQ0tFVCBNVVNUIE5PVCBCRSBBQkxFIFRPIEhBTkdcbiAqIFRFQVJET1dOLioqIGBzZXJ2ZXIuc3RvcCh0cnVlKWAgYXdhaXRzIGl0cyBjb25uZWN0aW9uczsgb25lIHdlZGdlZCBwZWVyIGlzXG4gKiBlbm91Z2ggdG8gcGFyayBpdCBmb3JldmVyLCB3aGljaCBpcyBob3cgYSAyMy1taW51dGUgaGFuZyBzaGlwcGVkIG9uY2UuXG4gKlxuICog4pqgICoqV0hBVCBJUyBERUxJQkVSQVRFTFkgTk9UIEhFUkU6IGJvdW50eSdzIHNodXRkb3duIHdhdGNoZG9nLioqIEJvdW50eSBhcm1zXG4gKiBhIFJFRidkIGBzZXRUaW1lb3V0YCB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGlmIHRlYXJkb3duIGRvZXMgbm90IGZpbmlzaCxcbiAqIGFuZCB0aGUgY2Vuc3VzIGlzIHJpZ2h0IHRoYXQgaXQgaXMgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbFxuICogdGVybWluYXRpb24gZ3VhcmFudGVlLiBJdCBiZWxvbmdzIHRvIGJvdW50eSdzIFRFQVJET1dOIOKAlCB0aGUgc3RyZXRjaCB3aGVyZVxuICogbm90aGluZyBib3VuZHMgd2hhdCBpcyBiZWluZyB3YWl0ZWQgb24uIOKblCAqKlRISVMgUEFSQUdSQVBIIFNBSUQgXCJTSUdOQUxcbiAqIFBBVEhcIiBVTlRJTCBENTMsIEFORCBUSEUgQ09ERSBBR1JFRUQgV0lUSCBJVCwgV0hJQ0ggV0FTIFRIRSBERUZFQ1QuKiogQm91bnR5XG4gKiBoYXMgRk9VUiB3YXlzIGludG8gb25lIHRlYXJkb3duIChhIHNpZ25hbCwgYSBgY2xvc2VgIHZlcmIsIHRoZSBicm93c2VyJ3NcbiAqIGNsb3NlIG92ZXIgdGhlIFdlYlNvY2tldCwgYW4gaWRsZSB0aW1lb3V0KSBhbmQgb25seSB0aGUgc2lnbmFsIG9uZSBhcm1lZCB0aGVcbiAqIHRpbWVyLCB3aGlsZSB0aGUgY29tbWVudCBhYm92ZSBpdCBjbGFpbWVkIHRoZSBlbmRpbmcgd2FzIHVuY29uZGl0aW9uYWwuXG4gKiBEcml2ZW4gd2l0aCBhIHBsYW50ZWQgaGFuZzogdGhlIG90aGVyIHRocmVlIHJhbiBwYXN0IDEwIHMsIHRoZSBpZGxlIG9uZVxuICogaW5jbHVkZWQg4oCUIHRoZSBvcnBoYW4tZGFlbW9uIGNsYXNzIHRoZSAyMy1taW51dGUgaGFuZyBjYW1lIGZyb20uIFRoZSBhcm1pbmdcbiAqIG5vdyBsaXZlcyBpbiB0aGUgUkVTT0xWRSB0aGF0IGFsbCBmb3VyIGVudHJpZXMgcGFzcyB0aHJvdWdoLiAqKlRoZSBsZXNzb24gZm9yXG4gKiBhbiBhZG9wdGVyIGlzIHRoZSBjb3VudCwgbm90IHRoZSBwbGFjZW1lbnQ6IGVudW1lcmF0ZSBldmVyeSBlbnRyeSBpbnRvIHRoZVxuICogdGVhcmRvd24gYmVmb3JlIHlvdSBiZWxpZXZlIGEgZ3VhcmFudGVlIGNvdmVycyBpdC4qKiBUaGUgdHdvXG4gKiBkYWVtb25zIGFkb3B0aW5nIHRoaXMgbW9kdWxlIHJlZ2lzdGVyIG5vIHNpZ25hbCBoYW5kbGVycywgYW5kIHRoZWlyIHdob2xlXG4gKiB0ZWFyZG93biBpcyBib3VuZGVkIGJ5IHRoZSB0d28gbnVtYmVycyBhYm92ZTsgYWRkaW5nIGFuIGV4aXQgaGVyZSB3b3VsZCBwdXRcbiAqIHRoZSBob3VzZSdzIG9ubHkgdW5jb25kaXRpb25hbCBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgaXNcbiAqIGFib3V0IHRvIGJ1bmRsZSwgb25lIHBoYXNlIGFmdGVyIEQ4IHRvb2sgZXhhY3RseSB0aGF0IGhhemFyZCBPVVQgb2YgYGRpZWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBTRU5URU5DRSBUSEFUIFVTRUQgVE8gRU5EIFRIQVQgUEFSQUdSQVBIIFdBUyBBIFBSRURJQ1RJT04sIFdISUNIXG4gKiBCT1VOVFknUyBPV04gUE9SVCBGQUxTSUZJRUQuKiogSXQgcmVhZDogXCJ3aGVuIGEgc3BlbGwgd2l0aCBhIHNpZ25hbCBwYXRoXG4gKiBhZG9wdHMgdGhpcywgdGhlIHdhdGNoZG9nIGFycml2ZXMgYXMgYW4gb3B0aW9uIG9uIHRoZXNlIGFyZ3VtZW50cyBhbmQgdGhlXG4gKiByZWFzb25pbmcgaXMgYWxyZWFkeSB3cml0dGVuIGRvd24uXCIgYm91bnR5IGFkb3B0ZWQgYGRyYWluQW5kU3RvcGAgb25cbiAqIDIwMjYtMDktMDkgKFBoYXNlIDQpIGFuZCB0aGUgb3B0aW9uIHdhcyBOT1QgYWRkZWQsIGJlY2F1c2UgdGhlIHdpbmRvdyBpc1xuICogd3JvbmcuICoqQSBgd2F0Y2hkb2dNc2Agb24gdGhlc2UgYXJndW1lbnRzIHdvdWxkIGFybSBhdCBEUkFJTiB0aW1lOyBib3VudHknc1xuICogYXJtcyBhdCBTSUdOQUwgdGltZSoqLCBhbmQgdGhlIHdob2xlIHJlYXNvbiBpdCBleGlzdHMgaXMgdGhlIHN0cmV0Y2ggQkVUV0VFTlxuICogdGhvc2UgdHdvIHBvaW50cyDigJQgYGF3YWl0IGRvbmVgLCBhbiBmcyBhcHBlbmQgdG8gdGhlIGRhZW1vbiBsb2csIGEgZnVsbFxuICogc25hcHNob3Qgd3JpdGUgdGhhdCBjYW4gcm90YXRlIGFuZCBDT1BZIGEgYmFja3VwIG9mIGEgbGFyZ2UgYm9hcmQsIGEgYGNsb3NlZGBcbiAqIGZyYW1lIGFuZCBhIGJyb2FkY2FzdC4gYGRyYWluQW5kU3RvcGAncyBvd24gYm9keSBpcyBhbHJlYWR5IGJvdW5kZWQgYnkgdGhlIHR3b1xuICogbnVtYmVycyBhYm92ZSwgc28gYSB3YXRjaGRvZyBzY29wZWQgdG8gaXQgd291bGQgZ3VhcmQgdGhlIG9uZSBzdHJldGNoIHRoYXRcbiAqIGNhbm5vdCBoYW5nIGFuZCBhYmFuZG9uIHRoZSBzdHJldGNoIHRoYXQgY2FuOiBpdCB3b3VsZCBSRUFEIGFzIGFkb3B0aW9uIGFuZFxuICogQkUgYSBuYXJyb3dpbmcgb2YgdGhlIGNvcnB1cydzIG9ubHkgdW5jb25kaXRpb25hbCB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIFRoZVxuICogMjMtbWludXRlIGhhbmcgdGhpcyBwcm9qZWN0IGtlZXBzIGNpdGluZyBoYXBwZW5lZCBpbiB0aGUgdW5ib3VuZGVkIHN0cmV0Y2guXG4gKlxuICog4pqgICoqU08gVEhFIFJVTEUgRk9SIFRIRSBORVhUIFNQRUxMLCBXSElDSCBJUyBUSEUgVFJBTlNGRVJBQkxFIEhBTEY6KiogdGhlXG4gKiBxdWVzdGlvbiBpcyBuZXZlciBcImRvZXMgdGhpcyBtb2R1bGUgaGF2ZSBhIHBsYWNlIHRvIHB1dCBhIHdhdGNoZG9nXCIgYnV0XG4gKiBcImRvZXMgdGhlIHdhdGNoZG9nJ3Mgd2luZG93IGNvaW5jaWRlIHdpdGggdGhpcyBtb2R1bGUnc1wiLiBXaGVyZSBhIHNwZWxsJ3NcbiAqIHRlYXJkb3duIGhhcyB1bmJvdW5kZWQgd29yayBCRUZPUkUgdGhlIGRyYWluLCB0aGUgd2F0Y2hkb2cgYmVsb25ncyBhdCB0aGVcbiAqIHNwZWxsLCB3cmFwcGVkIGFyb3VuZCBhbGwgb2YgaXQg4oCUIGFuZCBhcm91bmQgRVZFUlkgV0FZIElOLCB3aGljaCBpcyB0aGUgaGFsZlxuICogRDUzIGhhZCB0byByZXBhaXIgYWZ0ZXIgdGhpcyBoZWFkZXIgd2FzIHdyaXR0ZW4uIElmIGEgc3BlbGwgZXZlciBhcHBlYXJzIHdob3NlIHNpZ25hbCBwYXRoXG4gKiBlbnRlcnMgYGRyYWluQW5kU3RvcGAgaW1tZWRpYXRlbHksIGFkZCB0aGUgb3B0aW9uIFRIRU4g4oCUIGFuZCB0aGUgb3B0aW9uIG11c3RcbiAqIHRha2UgYW4gYG9uRXhwaXJlYCBjYWxsYmFjayByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgYHByb2Nlc3MuZXhpdGAgc3RheXNcbiAqIG91dHNpZGUgYSBtb2R1bGUgZXZlcnkgc3BlbGwgYnVuZGxlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRyYWluQW5kU3RvcChvcHRzOiBEcmFpbk9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZ3JhY2VNcyA9IG9wdHMuZ3JhY2VNcyA/PyAxNTA7XG4gIGNvbnN0IHN0b3BNcyA9IG9wdHMuc3RvcE1zID8/IDIwMDtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBncmFjZU1zKSk7XG5cbiAgaWYgKG9wdHMuY2xpZW50cykge1xuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIFsuLi5vcHRzLmNsaWVudHNdKSBjbGllbnQuY2xvc2UoKTtcbiAgfVxuICBpZiAob3B0cy5zb2NrZXRzKSB7XG4gICAgZm9yIChjb25zdCB3cyBvZiBbLi4ub3B0cy5zb2NrZXRzXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3MuY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgIFByb21pc2UucmVzb2x2ZShvcHRzLnNlcnZlci5zdG9wKHRydWUpKSxcbiAgICBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBzdG9wTXMpKSxcbiAgXSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGFzc2V0LXNlcnZpbmcgdHJpbyBmb3IgYSBzcGVsbCBkYWVtb246IHdoaWNoIHN1cmZhY2UgbW9kZSB3ZVxuICogYXJlIGluLCB3aGF0IGNvbnRlbnQgdHlwZSBhIGZpbGUgZ2V0cywgYW5kIGhvdyBhIGZpbGUgdW5kZXIgYGRpc3QvYCBpc1xuICogYW5zd2VyZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBFeHRyYWN0ZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBmcm9tIHRoZSBlaWdodCBgQnVuLnNlcnZlYCBiYWNrZW5kc1xuICogY2Vuc3VzZWQgaW4gYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1kYWVtb24tc3BpbmUtY2Vuc3VzLm1kYCwgd2hpY2hcbiAqIG1lYXN1cmVkIGByZXNvbHZlTW9kZWAgYXMgYnl0ZS1pZGVudGljYWwgaW4gYWxsIGVpZ2h0ICh0aGUgb25seSBtZDUgZGlmZmVyZW5jZVxuICogYmVpbmcgdGhlIGBleHBvcnRgIGtleXdvcmQpLCB0aGUgY29udGVudC10eXBlIG1hcCBhcyBkaWZmZXJpbmcgaW4gZXhhY3RseVxuICogb25lIGNlbGwsIGFuZCB0aGUgZmlsZSBoYWxmIG9mIGBzZXJ2ZURpc3RgIGFzIGlkZW50aWNhbCBpbiBmaXZlLlxuICpcbiAqIOKUgOKUgCBXSEFUIERFTElCRVJBVEVMWSBESUQgTk9UIENPTUUgQUxPTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKipUaGUgVVJMLXRvLWZpbGVuYW1lIG1hcHBpbmcgc3RheXMgaW4gZWFjaCByb3V0ZXIuKiogVGhlIGNlbnN1cyBtYXJrZWQgdHdvXG4gKiBvZiB0aGUgZWlnaHQgYHNlcnZlRGlzdGAgZGl2ZXJnZW5jZXMgREVMSUJFUkFURSBhbmQgYm90aCBsaXZlIGluIHRoYXQgaGFsZjpcbiAqIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBpbnRvIHRoZSBlbnRyeSBIVE1MIGluIG1lbW9yeSwgYW5kIGdyYXBldmluZSBzZXJ2ZXMgaXRzXG4gKiBzdXJmYWNlIGF0IGAvd2F0Y2hgIHJhdGhlciB0aGFuIGF0IGAvYC4gQSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiXG4gKiB0aG9zZSBzdG9wcyBiZWluZyBhIGZpbGUgc2VydmVyIGFuZCBiZWNvbWVzIGEgcm91dGVyLiBTbyB0aGUgY2FsbGVyIGRlY2lkZXNcbiAqIFdISUNIIGZpbGUgKGBwYXRoID09PSBcIi9cIiA/IFwiaW5kZXguaHRtbFwiIDogcGF0aC5zbGljZSgxKWApLCBhbmQgdGhpcyBtb2R1bGVcbiAqIGRlY2lkZXMgd2hldGhlciB0aGF0IGZpbGUgbWF5IGJlIHJlYWQgYW5kIHdoYXQgaXQgaXMgc2VydmVkIGFzLlxuICpcbiAqIOKUgOKUgCBBTkQgXCJXSEVUSEVSIElUIE1BWSBCRSBSRUFEXCIgSVMgTk9XIEEgV0hJVEVMSVNUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV4dHJhY3RlZCB3aXRoIHRocmVlIGd1YXJkcyAoZW1wdHkgLyBgLi5gIC8gbmVzdGVkKSBhbmQgYGV4aXN0c1N5bmNgIGZvciB0aGVcbiAqIHJlc3QsIHdoaWNoIHdhcyB0cnVlIG9mIGEgYGRpc3QvYCB0aGF0IGhlbGQgb25seSBhIHN1cmZhY2UuIFBoYXNlIDFiIHB1dCBldmVyeVxuICogZGFlbW9uJ3MgQlVORExFIGluIHRoYXQgc2FtZSBkaXJlY3RvcnksIGFuZCBhbGwgZml2ZSBhZG9wdGVycyBzZXJ2ZWQgaXQ6XG4gKiBgL2NsaS5qc2AsIGAvc2VydmVyLmpzYCwgYC9qb2luLmpzYCBhdCAyMDAsIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBjb21taXR0ZWRcbiAqIGFydGlmYWN0cywgZW1iZWRkZWQgc291cmNlbWFwcyBhbmQgYWxsLiBgc2VydmVGcm9tRGlzdGAgbm93IHNlcnZlcyBvbmx5IHdoYXQgdGhlXG4gKiBidWlsdCBgaW5kZXguaHRtbGAgdHJhbnNpdGl2ZWx5IGxpbmtzIOKAlCBzZWUgYHN1cmZhY2VXaGl0ZWxpc3RgIGJlbG93LCB3aGljaCBpc1xuICogdGhlIHNoYXBlIGRpZ2VzdGlmeSBwcm92ZWQgbG9jYWxseSBpbiBgZDhjYmFmZmAgYW5kIHRoaXMgaXMgaXRzIG9uZSBlZGl0IGZvclxuICogZml2ZSBzcGVsbHMuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogUmVsZWFzZSBpZmYgYDxkaXN0RGlyPi9pbmRleC5odG1sYCBleGlzdHM7IGVsc2UgZGV2LiBUaGUgZW52IG92ZXJyaWRlXG4gKiAoYFNQRUxMQk9PS19TVVJGQUNFX01PREVgKSB3aW5zIGVpdGhlciB3YXkg4oCUIHNlYW1zIENvbnRyYWN0IDEuXG4gKlxuICog4puUICoqVEhFIEZJTEUsIE5FVkVSIFRIRSBESVJFQ1RPUlksIEFORCBUSEFUIElTIEEgU0NBUiBOT1QgQSBTVFlMRSBDSE9JQ0UuKipcbiAqIFJlLWhvbWVkIGZyb20gYm91bnR5IGFuZCBtYWdwaWUsIHdoaWNoIGVhcm5lZCBpdCBpbmRlcGVuZGVudGx5OlxuICpcbiAqIC0gbWFncGllJ3MgYGRpc3QvYCBBTFJFQURZIEVYSVNURUQgaG9sZGluZyBgY2xpLmpzYCBhbmQgbm8gYGluZGV4Lmh0bWxgLFxuICogICB3aGljaCBpcyBwcmVjaXNlbHkgd2h5IGl0cyBkYWVtb24gc3RheWVkIGNvcnJlY3RseSBpbiBERVYgbW9kZSB0aHJvdWdoIHRoZVxuICogICB3aG9sZSBvZiBTbGljZSAyLiBgZGlzdC9gIGV4aXN0aW5nIGlzIG5vdCB0aGUgZGlzY3JpbWluYXRvci5cbiAqIC0gYm91bnR5IHNheXMgdGhlIHNhbWUgdGhpbmcgZnJvbSB0aGUgb3RoZXIgc2lkZTogYSBidWlsdCBCQUNLRU5EIHB1dHNcbiAqICAgYGNsaS5qc2AgKGFuZCBub3cgYHNlcnZlci5qc2ApIGluIGBkaXN0L2Agd2l0aCBubyBzdXJmYWNlIGFueXdoZXJlIG5lYXIgaXQuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQUkVESUNBVEUgSVMgQU4gVU5IQVNIRUQgRklMRU5BTUUsIFdISUNIIElTIEEgU1RBTkRJTkdcbiAqIEFTU1VNUFRJT04gQUJPVVQgVEhFIFNVUkZBQ0UgQlVJTEQuKiogUmVsZWFzZSBtb2RlIGlzIGNob3NlbiBieSBPTkUgbGl0ZXJhbFxuICogbmFtZS4gQSBzdXJmYWNlIGJ1aWxkIHRoYXQgZXZlciBlbWl0dGVkIGEgY29udGVudC1oYXNoZWQgZW50cnkgZG9jdW1lbnQgd291bGRcbiAqIGxlYXZlIG5vIGBpbmRleC5odG1sYCBoZXJlLCBldmVyeSBkYWVtb24gd291bGQgc2lsZW50bHkgcmVzb2x2ZSBERVYsIGFuZCB0aGVcbiAqIG9ubHkgc3ltcHRvbSBhbnlvbmUgY2FuIHNlZSBpcyB0aGUgYG1vZGVgIGZpZWxkIG9uIGEgaGFuZHNoYWtlIG5vYm9keSByZWFkcyBpblxuICogYW5nZXIuIGBzcmMvYnVpbGQudHNgIGVtaXRzIHRoZSBlbnRyeSB1bmhhc2hlZCB0b2RheSAob25seSB0aGUgSlMgYW5kIENTU1xuICogY2h1bmtzIGNhcnJ5IGhhc2hlcykgYW5kIENvbnRyYWN0IDIgcGlucyB0aGF0IGZsYXQgbGF5b3V0OyB0aGlzIGNvbW1lbnQgaXNcbiAqIHRoZSBub3RlIHRoYXQgc2F5cyB3aGF0IHRoZSBwaW4gaXMgbG9hZC1iZWFyaW5nIEZPUi5cbiAqXG4gKiDimqAgTm90aGluZyBhbm5vdW5jZXMgdGhlIGZsaXAgZnJvbSBkZXYgdG8gcmVsZWFzZSBlaXRoZXI6IHRoZSBmaXJzdCBzdXJmYWNlXG4gKiBidWlsZCB0byBsYW5kIGFuIGBpbmRleC5odG1sYCBiZXNpZGUgYSBkYWVtb24gZmxpcHMgaXQsIHNpbGVudGx5LCBvbiB0aGUgbmV4dFxuICogYm9vdC4gVGhhdCBpcyB3aHkgYG1vZGVgIHJpZGVzIHRoZSByZWFkeSBmcmFtZSDigJQgd2l0aCByb290IGRlcHMgcHJlc2VudCBhIGRldlxuICogZGFlbW9uIHJlbmRlcnMgYW4gaWRlbnRpY2FsLWxvb2tpbmcgc3VyZmFjZSwgc28gXCJpdCBsb29rcyByaWdodFwiIGNhbm5vdFxuICogdmVyaWZ5IENvbnRyYWN0IDEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZShkaXN0RGlyOiBzdHJpbmcpOiBcImRldlwiIHwgXCJyZWxlYXNlXCIge1xuICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREU7XG4gIGlmIChvdmVycmlkZSA9PT0gXCJkZXZcIiB8fCBvdmVycmlkZSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBvdmVycmlkZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG4vKipcbiAqIFRoZSBjb250ZW50IHR5cGVzIGEgYnVpbHQgc3VyZmFjZSBhY3R1YWxseSBzaGlwcy4gRXh0ZW5zaW9ucyBvdXRzaWRlIHRoZVxuICogbWFwIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYCDigJQgYSBkZWxpYmVyYXRlIHJlZnVzYWwgdG8gZ3Vlc3MsIHNpbmNlXG4gKiBhbnl0aGluZyBub3QgaW4gdGhpcyBsaXN0IGlzIG5vdCBzb21ldGhpbmcgQ29udHJhY3QgMidzIGJ1aWxkIGVtaXRzLlxuICpcbiAqIOKaoCAqKmBjaGFyc2V0PXV0Zi04YCBPTiBIVE1MIElTIFRIRSBDRU5TVVMnUyBPTkUgRElWRVJHRU5DRSwgUkVTT0xWRUQgVE9XQVJEXG4gKiBUSEUgQ09SUkVDVCBDT1BZLioqIFRocmVlIG9mIHRoZSBlaWdodCBkYWVtb25zIGNhcnJpZWQgaXQgYW5kIGZpdmUgZGlkIG5vdDtcbiAqIHRoZSBjZW5zdXMgZ3JhZGVkIHRoYXQgYHN0YWxlYCB3aXRoIHplcm8gZGVzaWduIGNvbnRlbnQuIEl0IGlzIGtlcHQgYmVjYXVzZVxuICogaXQgaXMgdGhlIHJpZ2h0IGFuc3dlciDigJQgYW4gSFRNTCBkb2N1bWVudCBzZXJ2ZWQgd2l0aCBubyBjaGFyc2V0IGlzIGRlY29kZWRcbiAqIGJ5IHRoZSBicm93c2VyJ3MgZ3Vlc3Mg4oCUIGFuZCBpdCBpcyB0aGUgb25lIHdpcmUtb2JzZXJ2YWJsZSBjaGFuZ2UgdGhpc1xuICogY29udmVyZ2VuY2UgbWFrZXMgdG8gYSByZXNwb25zZSBoZWFkZXIuIFJlY29yZGVkIGFzIEQtbm90ZSBpbiB0aGUgcGhhc2UgbG9nXG4gKiByYXRoZXIgdGhhbiBzbXVnZ2xlZC5cbiAqL1xuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8qKiBUaGUgY29udGVudCB0eXBlIGZvciBhIGZpbGVuYW1lIG9yIGFuIGV4dGVuc2lvbi4gVW5rbm93biBleHRlbnNpb25zLCBhbmRcbiAqICBuYW1lcyB3aXRoIG5vIGV4dGVuc2lvbiBhdCBhbGwsIGdldCBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250ZW50VHlwZUZvcihuYW1lT3JFeHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRvdCA9IG5hbWVPckV4dC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA9PT0gLTEgPyBcIlwiIDogbmFtZU9yRXh0LnNsaWNlKGRvdCk7XG4gIHJldHVybiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbi8qKlxuICogQW5zd2VyIE9ORSBmaWxlIGZyb20gYGRpc3REaXJgLCBvciBgbnVsbGAgaWYgdGhlIGNhbGxlciBzaG91bGQga2VlcCByb3V0aW5nLlxuICpcbiAqIGByZWxgIGlzIGEgYmFyZSBmaWxlbmFtZSDigJQgdGhlIGVudHJ5IGRvY3VtZW50IG9yIG9uZSBoYXNoZWQgY2h1bmsuIENvbnRyYWN0XG4gKiAyJ3MgYnVpbHQgc3VyZmFjZSBpcyBGTEFUIGFuZCBsaW5rcyBpdHMgY2h1bmtzIHJlbGF0aXZlbHksIHNvIGEgbGVnaXRpbWF0ZVxuICogYXNzZXQgcmVxdWVzdCBpcyBuZXZlciBuZXN0ZWQgYW5kIG5ldmVyIGNvbnRhaW5zIGAuLmA7IGJvdGggYXJlIHJlZnVzZWRcbiAqIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIHJvdXRlciwgYmVjYXVzZSB0aGUgZ3VhcmQgcHJvdGVjdHMgdGhlIHJlYWQgYW5kIHRoZVxuICogcmVhZCBpcyB3aGF0IGxpdmVzIGluIHRoaXMgZmlsZS5cbiAqXG4gKiDim5QgQU5EIGBleGlzdHNTeW5jYCBJUyBOTyBMT05HRVIgVEhFIFBFUk1JU1NJT04uIEEgZmlsZSB1bmRlciBgZGlzdERpcmAgaXNcbiAqIHNlcnZlZCBvbmx5IGlmIGl0IGlzIGluIGBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXIpYCDigJQgd2hhdCB0aGUgYnVpbHRcbiAqIGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgTElOS1MuIGBkaXN0L2Agc3RvcHBlZCBiZWluZyBhIHN1cmZhY2UgZGlyZWN0b3J5XG4gKiB3aGVuIHRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIGJ1aWx0IHRoZSBkYWVtb25zIGludG8gaXQsIGFuZCB0aGUgZ3VhcmRzIGFib3ZlXG4gKiBkbyBub3QgZGlzdGluZ3Vpc2ggYGluZGV4LTxoYXNoPi5qc2AgZnJvbSBgc2VydmVyLmpzYC4gUmVhZCB0aGF0IGZ1bmN0aW9uJ3NcbiAqIGhlYWRlciBiZWZvcmUgdG91Y2hpbmcgdGhpcyBsaW5lOyB0aGUgd2hpdGVsaXN0IGlzIHRoZSBkZWZlbmNlLlxuICpcbiAqIOKaoCBUaGUgbmVzdGluZyByZWZ1c2FsIGlzIGFsc28gd2hhdCBrZWVwcyBhbiBhc3NldCBzZXJ2ZSBjbGVhciBvZiBhIHNwZWxsJ3NcbiAqIG93biByb3V0ZXM6IG1hZ3BpZSwgYm91bnR5LCBnbGFtb3VyIGFuZCBpbWFnbyBlYWNoIGhhdmUgYW4gYC9hc3NldHMvPG5hbWU+YFxuICogcm91dGUgb25lIGxldmVsIGRlZXAsIGFuZCB0aGlzIHJldHVybmluZyBgbnVsbGAgb24gYW55dGhpbmcgd2l0aCBhIHNsYXNoIGluXG4gKiBpdCBpcyB3aGF0IHN0b3BzIHRoZSB0d28gZmlnaHRpbmcuIFRoZSB3aGl0ZWxpc3QgZ292ZXJucyBgZGlzdC9gIHJlYWRzIE9OTFlcbiAqIOKAlCBpdCBuZXZlciBzZWVzIHRob3NlIHJvdXRlcyBhbmQgbXVzdCBuZXZlciBiZSB3aWRlbmVkIGludG8gdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlRnJvbURpc3QoZGlzdERpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFJlc3BvbnNlIHwgbnVsbCB7XG4gIGlmICghcmVsIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoIXN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcikuaGFzKHJlbCkpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCByZWwpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogY29udGVudFR5cGVGb3IocmVsKSB9IH0pO1xufVxuXG4vKiogYHNyY2AvYGhyZWZgIHZhbHVlcyBpbiBhIGJ1aWx0IGVudHJ5IGRvY3VtZW50LCBgLi9gLXByZWZpeGVkIG9yIGJhcmUuICovXG5jb25zdCBFTlRSWV9SRUZfUkUgPSAvKD86c3JjfGhyZWYpXFxzKj1cXHMqXCIoPzpcXC5cXC8pPyhbXlwiXSspXCIvZztcblxuLyoqIEEgYC4vYC1QUkVGSVhFRCBzaWJsaW5nIHNwZWNpZmllciDigJQgYFwiLi9uYW1lXCJgLCBgJy4vbmFtZSdgLCBgKC4vbmFtZSlgIOKAlCB3aGljaFxuICogIGlzIHRoZSBvbmx5IHNoYXBlIGEgYnVuZGxlciBlbWl0cyBmb3IgYSBzaWJsaW5nIGNodW5rLiBSZXF1aXJpbmcgdGhlIGAuL2AgaXNcbiAqICB3aGF0IGtlZXBzIGEgc3RyaW5nIGxpdGVyYWwgdGhhdCBtZXJlbHkgU0FZUyBgY2xpLmpzYCBvdXQgb2YgdGhlIHNldC4gKi9cbmNvbnN0IFJFTEFUSVZFX1JFRl9SRSA9IC9bXCInKF1cXC5cXC8oW15cIicoKVxcc10rKVtcIicpXS9nO1xuXG4vKiogT25seSB0ZXh0IHRoZSBidWlsZCBlbWl0cyBhcyBzdXJmYWNlIGNvZGUgaXMgc2Nhbm5lZCBmb3Igb253YXJkIHJlZmVyZW5jZXMuXG4gKiAgQSBgLnBuZ2AgaXMgYSBsZWFmOyBvcGVuaW5nIGl0IHdvdWxkIGJlIHJlYWRpbmcgYSBiaW5hcnkgZm9yIGZpbGVuYW1lcy4gKi9cbmNvbnN0IFRSQU5TSVRJVkVfRVhUUyA9IFtcIi5qc1wiLCBcIi5jc3NcIl07XG5cbi8qKiBPbmUgZGVyaXZhdGlvbiBwZXIgYGRpc3QvYCwgZm9yIHRoZSBsaWZlIG9mIHRoZSBwcm9jZXNzIOKAlCBgZGlzdC9gIGlzIGEgYnVpbGRcbiAqICBhcnRpZmFjdCBhbmQgZG9lcyBub3QgY2hhbmdlIHVuZGVyIGEgcnVubmluZyBkYWVtb24uIEtleWVkIGJ5IGRpcmVjdG9yeSBzb1xuICogIHR3byBkYWVtb25zIGluIG9uZSBwcm9jZXNzIChhbmQgZXZlcnkgdGVzdCB3aXRoIGl0cyBvd24gdGVtcCB0cmVlKSBzdGF5XG4gKiAgaW5kZXBlbmRlbnQuICovXG5jb25zdCB3aGl0ZWxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PigpO1xuXG5mdW5jdGlvbiByZWZzSW4odGV4dDogc3RyaW5nLCByZTogUmVnRXhwKTogc3RyaW5nW10ge1xuICByZXR1cm4gKFxuICAgIFsuLi50ZXh0Lm1hdGNoQWxsKHJlKV1cbiAgICAgIC5tYXAoKFssIHJlZl0pID0+IHJlZilcbiAgICAgIC8vIEEgVFlQRSBQUkVESUNBVEUsIGFuZCBob25lc3Qgb25seSBiZWNhdXNlIGl0cyBmaXJzdCBjbGF1c2Ugd2FzIGFscmVhZHlcbiAgICAgIC8vIGhlcmU6IGAhIXJlZmAgaXMgdGhlIHJ1bnRpbWUgY2hlY2sgdGhhdCBtYWtlcyBgcmVmIGlzIHN0cmluZ2AgdHJ1ZSAodGhlXG4gICAgICAvLyBGRUxMIHNlbnRlbmNlJ3MgcHJlZGljYXRlIHJvdXRlLCB0YWtlbiB3aXRoIGl0cyBjbGF1c2Ug4oCUIHR5cGUtZGVidCBUMzYpLlxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKHJlZik6IHJlZiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICAhIXJlZiAmJlxuICAgICAgICAgICFyZWYuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi4uXCIpICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIjpcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCIjXCIpICYmXG4gICAgICAgICAgIXJlZi5zdGFydHNXaXRoKFwiP1wiKSxcbiAgICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgdW5kZXIgYGRpc3REaXJgIGEgYnJvd3NlciBtYXkgZmV0Y2g6IHRoZSBlbnRyeSBkb2N1bWVudCwgcGx1cyB0aGVcbiAqIFRSQU5TSVRJVkUgY2xvc3VyZSBvZiB3aGF0IGl0IGxpbmtzLlxuICpcbiAqIOKblCAqKkEgV0hJVEVMSVNULCBBTkQgVEhFIExFQUsgSVQgUkVQTEFDRUQgSVMgV0hZLioqIFVudGlsIHRoaXMgZml4IHRoZSBmaWxlXG4gKiBoYWxmIG9mIHRoaXMgbW9kdWxlIGhhZCBleGFjdGx5IHRocmVlIGd1YXJkcyDigJQgZW1wdHksIGAuLmAsIG5lc3RlZCDigJQgYW5kXG4gKiBgZXhpc3RzU3luY2AgZGVjaWRlZCB0aGUgcmVzdC4gVGhhdCB3YXMgY29ycmVjdCBmb3IgYXMgbG9uZyBhcyBgZGlzdC9gIGhlbGRcbiAqIG9ubHkgYSBzdXJmYWNlLiBUaGUgYmFja2VuZCBjb252ZXJnZW5jZSBtb3ZlZCBldmVyeSBzcGVsbCdzIElNUExFTUVOVEFUSU9OXG4gKiBpbnRvIHRoZSBzYW1lIGRpcmVjdG9yeSwgYW5kIHRoZSBzZXJ2ZSBkaWQgd2hhdCBpdCB3YXMgd3JpdHRlbiB0byBkbzpcbiAqXG4gKiAgIEdFVCAvY2xpLmpzICAgICAyMDAgIDI0Miw0MzEgQiAgdGV4dC9qYXZhc2NyaXB0ICAg4oaQIGJvdW50eSwgYnl0ZS1pZGVudGljYWxcbiAqICAgR0VUIC9zZXJ2ZXIuanMgIDIwMCAgMjc2LDQxNSBCICB0ZXh0L2phdmFzY3JpcHQgICAgICB0byB0aGUgY29tbWl0dGVkXG4gKiAgIEdFVCAvam9pbi5qcyAgICAyMDAgICA0NywzNDggQiAgdGV4dC9qYXZhc2NyaXB0ICAgICAgYXJ0aWZhY3RzXG4gKlxuICogYW5kIHRob3NlIGJ1bmRsZXMgYXJlIGJ1aWx0IHdpdGggdGhlIHNvdXJjZW1hcCBFTUJFRERFRCwgc28gZWFjaCBvbmUgY2Fycmllc1xuICogdGhlIGNvbXBsZXRlIG9yaWdpbmFsIFR5cGVTY3JpcHQuIEZpdmUgc3BlbGxzIOKAlCBhc3Ryb2xhYmUsIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZVxuICog4oCUIGVsZXZlbiBhcnRpZmFjdHMsIGFsbCByZWFjaGFibGUgYnkgYW55IGJyb3dzZXIgdGhhdCBjYW4gcmVhY2ggdGhlIGRhZW1vbi5cbiAqIERpZ2VzdGlmeSBoaXQgdGhlIGlkZW50aWNhbCBkZWZlY3Qgb25lIGJyYW5jaCBlYXJsaWVyIGFuZCBhbnN3ZXJlZCBpdCBsb2NhbGx5O1xuICogdGhpcyBpcyB0aGF0IGFuc3dlciByZS1ob21lZCB0byB0aGUgb25lIHBsYWNlIGFsbCBmaXZlIGNhbGxlcnMgYWxyZWFkeSBzaGFyZS5cbiAqXG4gKiDim5QgKipERVJJVkVELCBOT1QgRU5VTUVSQVRFRCwgQU5EIE5PVCBNQVRDSEVEIEJZIFNIQVBFLioqIEEgbGl0ZXJhbCBuYW1lIGxpc3RcbiAqIGlzIHdyb25nIGF0IHRoZSBuZXh0IGJ1aWxkICh0aGUgY2h1bmtzIGNhcnJ5IGNvbnRlbnQgaGFzaGVzKS4gQSBzaGFwZSBtYXRjaFxuICogKGBpbmRleC08aGFzaD4uanNgKSBpcyB3cm9uZyB0aGUgZmlyc3QgdGltZSB0aGUgYnVuZGxlciBzcGxpdHMgYSBjaHVuay4gQXNraW5nXG4gKiB0aGUgZW50cnkgZG9jdW1lbnQgd2hhdCBpdCBsb2FkcyBpcyB0aGUgb25seSBmb3JtdWxhdGlvbiB0aGF0IGlzIHRydWUgb2ZcbiAqIHdoYXRldmVyIGBidW4gcnVuIGJ1aWxkYCBhY3R1YWxseSBlbWl0dGVkLlxuICpcbiAqIOKblCAqKkFORCBUSEUgQ0xPU1VSRSBJUyBUUkFOU0lUSVZFIEZPUiBUSEUgU0FNRSBSRUFTT04uKiogYGluZGV4Lmh0bWxgIGxpbmtzXG4gKiBvbmUgY2h1bmsgdG9kYXk7IGEgc3BsaXQgYnVpbGQgaGFzIHRoYXQgY2h1bmsgYGltcG9ydCBcIi4vY2h1bmstPGhhc2g+LmpzXCJgLFxuICogd2hpY2ggdGhlIGVudHJ5IGRvY3VtZW50IG5ldmVyIG5hbWVzLiBTbyBldmVyeSBhZG1pdHRlZCBgLmpzYC9gLmNzc2AgaXMgaXRzZWxmXG4gKiBzY2FubmVkIGZvciBgLi9gLXByZWZpeGVkIHNpYmxpbmdzLCB1bnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmcg4oCUIGEgd2hpdGVsaXN0XG4gKiB0aGF0IHJlYWQgb25seSB0aGUgZW50cnkgd291bGQgNDA0IGEgbGVnaXRpbWF0ZSBjaHVuayBpbiByZWxlYXNlLCBhbmQgb25seSBpblxuICogcmVsZWFzZS5cbiAqXG4gKiDim5QgKipNRU1CRVJTSElQIElTIEFOIEVYQUNUIE1BVENILCBXSElDSCBNQUtFUyBUSEUgUkVGVVNBTCBDQVNFLUlOU0VOU0lUSVZFIEJZXG4gKiBDT05TVFJVQ1RJT04uKiogQVBGUyBpcyBjYXNlLWluc2Vuc2l0aXZlLCBzbyBgL0lOREVYLkhUTUxgIGFuZCBgL2lOZEV4Lkh0TWxgXG4gKiByZXNvbHZlIHRvIHRoZSBzYW1lIGlub2RlIGEgY2FzZS1zZW5zaXRpdmUgYmxhY2tsaXN0IHdvdWxkIG1pc3MgKG1lYXN1cmVkIG9uXG4gKiBhbGwgZml2ZSBzcGVsbHMgYmVmb3JlIHRoaXMgZml4OiBmb3VyIHZhcmlhbnRzLCBmb3VyIDIwMHMsIHRocmVlIG9mIHRoZW0gYXNcbiAqIGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIGJlY2F1c2UgdGhlIGNvbnRlbnQtdHlwZSBsb29rdXAgaXMgY2FzZS1zZW5zaXRpdmVcbiAqIHRvbykuIEEgc2V0IG9mIGV4YWN0bHkgdGhlIGVtaXR0ZWQgbmFtZXMgcmVmdXNlcyBldmVyeSB2YXJpYW50IG9mIGV2ZXJ5IG5hbWVcbiAqIOKAlCBzZXJ2YWJsZSBvciBub3Qg4oCUIHdpdGggbm8gbG93ZXItY2FzZSBwYXNzIGFueXdoZXJlLlxuICpcbiAqIOKaoCAqKlRIRSBUUkFERToqKiBhIGZpbGUgdGhlIGVudHJ5IGdyYXBoIGRvZXMgbm90IHJlZmVyZW5jZSDigJQgYSBsYXppbHkgZmV0Y2hlZFxuICogY2h1bmssIGEgZm9udCBwdWxsZWQgYnkgYSBDU1MgYHVybCgpYCB0aGlzIHNjYW4gZG9lcyBub3QgbW9kZWwsIGFuIGFzc2V0IHRoZVxuICogYnVpbGQgZW1pdHMgYnV0IG5vdGhpbmcgbGlua3Mg4oCUIDQwNHMgaW4gcmVsZWFzZSB3aXRoIG5vdGhpbmcgcmVkLiBFYWNoXG4gKiBhZG9wdGVyJ3MgYHJlbGVhc2Utc2VydmUudGVzdC50c2AgaG9sZHMgdGhlIGluc3RydW1lbnQ6IGFuIElOVkVOVE9SWSBjZWxsIHRoYXRcbiAqIGFjY291bnRzIGZvciBldmVyeSBmaWxlIGluIGBkaXN0L2AgYXMgc2VydmVkIG9yIGRlbGliZXJhdGVseSByZWZ1c2VkLCBzbyBhblxuICogdW5saW5rZWQgZW1pc3Npb24gZ29lcyByZWQgYXQgYnVpbGQgdGltZSByYXRoZXIgdGhhbiBzaWxlbnQgYXQgcnVudGltZS5cbiAqXG4gKiDimqAgVGhlIGVudHJ5IGRvY3VtZW50IGlzIElOIHRoZSBzZXQsIGJlY2F1c2UgdGhlIGhvdXNlIGNhbGxlciBtYXBzIGAvYCB0b1xuICogYGluZGV4Lmh0bWxgIGFuZCB0aGF0IGlzIHRoZSBzdXJmYWNlLiBBIHNwZWxsIHRoYXQgbXVzdCBuZXZlciBoYW5kIG92ZXIgaXRzXG4gKiBvbi1kaXNrIGVudHJ5IOKAlCBkaWdlc3RpZnkgc3Vic3RpdHV0ZXMgYSBwYXlsb2FkIGludG8gaXQgaW4gbWVtb3J5IOKAlCByZWZ1c2VzXG4gKiB0aGF0IE9ORSBuYW1lIGluIGl0cyBvd24gcm91dGVyLCBhYm92ZSB0aGlzIGNhbGwuIFRoYXQgcmVmdXNhbCBpcyB0aGUgc3BlbGwncztcbiAqIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIGlzIHRoZSBraXQncy5cbiAqL1xuZnVuY3Rpb24gc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyOiBzdHJpbmcpOiBSZWFkb25seVNldDxzdHJpbmc+IHtcbiAgY29uc3QgY2FjaGVkID0gd2hpdGVsaXN0Q2FjaGUuZ2V0KGRpc3REaXIpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGVudHJ5ID0gam9pbihkaXN0RGlyLCBcImluZGV4Lmh0bWxcIik7XG4gIGlmIChleGlzdHNTeW5jKGVudHJ5KSkge1xuICAgIG5hbWVzLmFkZChcImluZGV4Lmh0bWxcIik7XG4gICAgY29uc3QgaHRtbCA9IHJlYWRGaWxlU3luYyhlbnRyeSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBbLi4ucmVmc0luKGh0bWwsIEVOVFJZX1JFRl9SRSksIC4uLnJlZnNJbihodG1sLCBSRUxBVElWRV9SRUZfUkUpXTtcbiAgICAvLyBVbnRpbCB0aGUgc2V0IHN0b3BzIGdyb3dpbmc6IGVhY2ggYWRtaXR0ZWQgY2h1bmsgbWF5IG5hbWUgdGhlIG5leHQgb25lLlxuICAgIHdoaWxlIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwZW5kaW5nLnBvcCgpIGFzIHN0cmluZztcbiAgICAgIGlmIChuYW1lcy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgLy8g4pqgIFJFRkVSRU5DRUQgKipBTkQqKiBQUkVTRU5ULiBBIG1pbmlmaWVkIGJ1bmRsZSBjYW4gY29udGFpbiBhIHN0cmluZ1xuICAgICAgLy8gdGhhdCBtZXJlbHkgTE9PS1MgbGlrZSBvbmU7IGFkbWl0dGluZyBvbmx5IG5hbWVzIHRoYXRcbiAgICAgIC8vIGFyZSBhY3R1YWxseSBvbiBkaXNrIGtlZXBzIHRoZSBzY2FuIGZyb20gd2lkZW5pbmcgdGhlIHNldCBvbiBhXG4gICAgICAvLyBjb2luY2lkZW5jZSwgYW5kIGEgbmFtZSB0aGF0IGlzIGFic2VudCA0MDRzIGlkZW50aWNhbGx5IGVpdGhlciB3YXkuXG4gICAgICBjb25zdCBmaWxlID0gam9pbihkaXN0RGlyLCBuYW1lKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhmaWxlKSkgY29udGludWU7XG4gICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICBpZiAoIVRSQU5TSVRJVkVfRVhUUy5zb21lKChleHQpID0+IG5hbWUuZW5kc1dpdGgoZXh0KSkpIGNvbnRpbnVlO1xuICAgICAgcGVuZGluZy5wdXNoKC4uLnJlZnNJbihyZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLCBSRUxBVElWRV9SRUZfUkUpKTtcbiAgICB9XG4gIH1cblxuICB3aGl0ZWxpc3RDYWNoZS5zZXQoZGlzdERpciwgbmFtZXMpO1xuICByZXR1cm4gbmFtZXM7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIHNlcnZlciBzaWRlIG9mIHRoZSBTU0UgdGFpbCDigJQgdGhlIGRhZW1vbi1zaWRlIHR3aW4gb2ZcbiAqIGB0YWlsRXZlbnRzLnRzYC4gVGhhdCBtb2R1bGUgZGVjaWRlcyB3aGF0IGEgY2FsbGVyIG9ic2VydmVzOyB0aGlzIG9uZSBkZWNpZGVzXG4gKiB3aGF0IGEgY2FsbGVyIGlzIHNlbnQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgZXhjZXB0IGl0c1xuICogb3duIHNpYmxpbmcgdHlwZXMsIHdoaWNoIGlzIHN0aWxsIGluc2lkZSB0aGUgbGVhZi5cbiAqXG4gKiBDb252ZXJnZWQgMjAyNi0wOS0wOCAoUGhhc2UgMWIgY2hhcHRlciAyKSBUT1dBUkQgbWluZC1tYXBwZXIncyBgc3NlUmVzcG9uc2VgLFxuICogdGhlIGNlbnN1cydzIGNvbnZlcmdlbmNlIHRhcmdldCAjMTogdGhlIG9ubHkgb25lIG9mIHRoZSBzZXZlbiB3aXRoIGFcbiAqIG9uY2Utb25seSB0ZWFyZG93biBmdW5uZWwsIHRoZSBvbmx5IG9uZSB3aXJlZCB0byBgcmVxLnNpZ25hbGAsIGFuZCB0aGUgb25seVxuICogb25lIHdob3NlIGNvbW1lbnQgcmVjb3JkcyBhIE1FQVNVUkVEIHJlc3VsdCByYXRoZXIgdGhhbiBhIGJlbGllZi5cbiAqXG4gKiDilIDilIAg4puUIEFORCBXSEFUIFRIRSBDT1BZIExFRlQgQkVISU5ELCBTQUlEIEhFUkUgQkVDQVVTRSBBIExPU1MgUkVDT1JERUQgT05MWSBJTlxuICogICAgQSBQT1JUJ1MgSk9VUk5BTCBHRVRTIFJFLUxJVElHQVRFRCBCWSBFVkVSWSBTUEVMTCBBRlRFUiBJVCAoRDc5L0Q4NSkg4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHNlbnRlbmNlIGFib3ZlIG5hbWVzIGEgU09VUkNFIHRoaXMgbW9kdWxlIGhhZCBuZXZlciBiZWVuIGNoZWNrZWQgYWdhaW5zdDpcbiAqIEQxIHJ1bGVkIHRoZSBzcGluZSBiZSBwcm92ZW4gb24gdGhlIHR3byBzcGVsbHMgdGhhdCBhbHJlYWR5IGJ1aWx0LCBhbmQgYm90aCBvZlxuICogdGhvc2UgYXJlIGRvd25zdHJlYW0gRk9SS1Mgb2YgdGhlIG1pbmQtbWFwcGVyIGxpbmUsIHNvIHRoZSBib3VuZGFyaWVzIHdlcmVcbiAqIHNldHRsZWQgYWdhaW5zdCB0d28gY29waWVzIHdoaWxlIHRoZSBvcmlnaW5hbCB3YXMgbm90IGluIHRoZSByb29tLiAqKkFcbiAqIGNvbnZlcmdlbmNlIGNhbiBuYW1lIGl0cyBzb3VyY2UgYW5kIHN0aWxsIG5ldmVyIGNvbnN1bHQgaXQuKipcbiAqXG4gKiBXaGVuIGl0IHdhcyBmaW5hbGx5IGNvbnN1bHRlZCAoUGhhc2UgNywgdGhlIGxhc3QgcG9ydCksIGV4YWN0bHkgT05FIHByb3BlcnR5XG4gKiBvZiB0aGUgc291cmNlIHdhcyBtaXNzaW5nIGhlcmUsIGFuZCBpdCBvY2N1cGllZCBubyB0eXBlOiAqKm1pbmQtbWFwcGVyIHdyb3RlXG4gKiBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgQkVGT1JFIHRoZSByZXBsYXkqKiDigJQgb25lIGxpbmUgYWJvdmVcbiAqIGBidXMuc3Vic2NyaWJlYCDigJQgc28gaXQgd2FzIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmUuIGBvbk9wZW5gIGZpcmVzIGF0XG4gKiB0aGUgRU5EIG9mIGBzdGFydGAsIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLCBhZnRlclxuICogYGNsaWVudHMuYWRkYCwgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllZCBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kIHNlbnQgZnJvbVxuICogdGhlcmUgd291bGQgbGFuZCB0aGUgZnJhbWUgQUZURVIgdGhlIHJlcGxheWVkIGJhY2tsb2cuIFRoYXQgaXMgRVhQUkVTU0lCTEUsXG4gKiB3aGljaCBpcyB3aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IHRoZVxuICogcGxheWJvb2sncyB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBwcm9jZWR1cmUgYW5zd2VycyBcInJlcHJlc2VudGFibGVcIiBoZXJlXG4gKiAodGhlIHN1YmplY3QgdHlwZSBpcyBgU2V0PFNzZUNsaWVudD5gLCB0aGUgc3BlbGwga2VlcHMgbm8gcmVnaXN0cnksIHNvIHlvdVxuICogcGFzcyBhbiBlbXB0eSBzZXQpIGFuZCBhIHR5cGUgY2hlY2sgY2Fubm90IHNlZSBhIFBPU0lUSU9OLlxuICpcbiAqICoqVGhlIGRpc3Bvc2l0aW9uIHdhcyBSRVNUT1JFLCBub3QgS0VFUC1MT0NBTCBhbmQgbm90IEZJTEUqKiDigJQgc2VlXG4gKiBgb3BlbkZyYW1lc2AgYmVsb3csIHdoZXJlIHRoZSB0d28gbnVtYmVycyB0aGF0IHBlcm1pdCBpdCBhcmUgcmVjb3JkZWQgYW5kXG4gKiBkcml2ZW4uIFRoZSBnZW5lcmFsaXNhdGlvbiwgd2hpY2ggaXMgdGhlIHBhcnQgd29ydGggY2Fycnlpbmc6IHdoZXJlIGFcbiAqIG1vZHVsZSdzIHN1YmplY3QgaXMgYSBTRVFVRU5DRSBPRiBXUklURVMsIGNvbXBhcmUgdGhlIE9SREVSIG9mIGl0cyBob29rc1xuICogYWdhaW5zdCB0aGUgb3JkZXIgdGhlIGFkb3B0aW5nIHNwZWxsIHdyaXRlcyBpbi4gVHdvIGhvb2tzIHdpdGggdGhlIHJpZ2h0XG4gKiBzaWduYXR1cmVzIGluIHRoZSB3cm9uZyBvcmRlciBhcmUgYXMgaW5jb21wYXRpYmxlIGFzIHR3byB0eXBlcyB0aGF0IHdpbGwgbm90XG4gKiB1bmlmeSwgYW5kIG9ubHkgb25lIG9mIHRoZSB0d28gY2FuIGJlIFNFRU4gYnkgYSBjb21wYXRpYmlsaXR5IGNoZWNrLlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiAgICBDTElFTlQuIE1FQVNVUkVEIE9OIEJVTiAxLjMuMTQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogU2l4IGRhZW1vbnMgd3JpdGUgYSBoZWFydGJlYXQgYXMgYHRyeSB7IGNvbnRyb2xsZXIuZW5xdWV1ZSguLi4pIH0gY2F0Y2gge31gXG4gKiB3aXRoIGEgY29tbWVudCBzYXlpbmcgdGhlIGNhdGNoIGlzIGhvdyBhIGRlcGFydGVkIGNsaWVudCBpcyBub3RpY2VkLiBJdCBpc1xuICogbm90OiBlbnF1ZXVlIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBCVUZGRVJTIFNJTEVOVExZIGFuZCBuZXZlciB0aHJvd3MsIHNvIHRoZVxuICogY2F0Y2ggbmV2ZXIgZmlyZXMgYW5kIHRob3NlIGRhZW1vbnMnIGRlYWQtY2xpZW50IGRldGVjdGlvbiByZXN0cyBvbiBhXG4gKiBtZWNoYW5pc20gdGhlaXIgb3duIGNvbW1lbnRzIGRlc2NyaWJlIGluY29ycmVjdGx5LiBXaGF0IGFjdHVhbGx5IHJlY2xhaW1zIHRoZVxuICogY29ubmVjdGlvbiBpcyB0aGUgc3RyZWFtJ3MgYGNhbmNlbCgpYCDigJQgYW5kLCBmb3IgYSBjbGllbnQgdGhhdCBuZXZlciBjbG9zZXNcbiAqIHRoZSBzb2NrZXQsIGByZXEuc2lnbmFsYC5cbiAqXG4gKiBTbyB0aGUgZnVubmVsIGJlbG93IGlzIHRoZSBsb2FkLWJlYXJpbmcgcGFydC4gYHRlYXJkb3duKClgIHJ1bnMgQVQgTU9TVCBPTkNFXG4gKiBmcm9tIGV2ZXJ5IHBhdGggdGhlcmUgaXMg4oCUIGBjYW5jZWwoKWAsIGFuIGFib3J0IG9uIHRoZSByZXF1ZXN0IHNpZ25hbCwgYW5kXG4gKiB0aGUgYmVsdC1hbmQtYnJhY2VzIGVucXVldWUgY2F0Y2gg4oCUIGFuZCBpdCBpcyB3aGVyZSB0aGUgc3Vic2NyaWJlciBjb3VudCBhbmRcbiAqIGFueSBwcmVzZW5jZSBkZWNyZW1lbnQgcmlkZS4gQm91bmRpbmcgcHJlc2VuY2UgYWNjdXJhY3kgaXMgYm91bmRpbmcgdGhhdFxuICogZnVubmVsLlxuICpcbiAqIOKaoCBLbm93biBob2xlLCBhY2NlcHRlZCBhbmQgaW5oZXJpdGVkOiBCdW4ncyBvd24gYGZldGNoKClgIHJlYWRlciBgLmNhbmNlbCgpYFxuICogY2xvc2VzIG5vdGhpbmcgY2xpZW50LXNpZGUgYW5kIHRoZSBzZXJ2ZXIgY2Fubm90IHNlZSBpdC4gUmVhbCBjbGllbnRzIGNsb3NlXG4gKiB0aGUgc29ja2V0LlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuXG4gKiBHcmFwZXZpbmUgSEFTIGFuIFNTRSByZWdpc3RyeSBhbmQgaXQgaXMgdGhlIGJ1c2llc3QgdGhpbmcgaW4gdGhlIHNwZWxsOyB0aGVcbiAqIHR3byB0eXBlcyBzaW1wbHkgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+YCB3aGVyZSBgU3NlQ2xpZW50ID0ge2Nsb3NlLCBzZW5kfWBcbiAqICAgICAgICAgICAgICAgIOKAlCBhIHJlZ2lzdHJ5IG9mIEFOT05ZTU9VUyBjbG9zZXJzLCBhbmQgYHNpemVgIGlzIHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgICAgICAgICAgICBhbnkgYWRvcHRpbmcgZGFlbW9uIHJlYWRzIG9mZiBpdC5cbiAqICAgZ3JhcGV2aW5lICAgIGBNYXA8c3ltYm9sLCB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfT5gLCBwZXIgY2hhbm5lbC5cbiAqXG4gKiAqKlRoZSByZWFkZXJzIHRoYXQgbWFrZSB0aGVtIGluY29tcGF0aWJsZSwgY291bnRlZCByYXRoZXIgdGhhbiBhc3NlcnRlZDogU0lYXG4gKiByb3V0ZXMgcmVhZCBgYWxpYXNgL2BodW1hbmAvYGx1cmtgKiog4oCUIGBHRVQgL2NoYW5uZWxzYCAodGhyb3VnaFxuICogYGxpc3RDaGFubmVsc2Ag4oaSIGB2aXNpYmxlU3Vic2ApLCBgR0VUIC9wcmVzZW5jZWAsIGBQT1NUIC9jaGFubmVsc2AsXG4gKiBgUE9TVCAvYW5ub3VuY2VgLCBgUE9TVCAvY2hhbm5lbHMvOm5hbWUvbWVzc2FnZXNgLCBhbmRcbiAqIGBHRVQgL2NoYW5uZWxzLzpuYW1lL3N1YnNjcmliZXJzYC4gYGFsaWFzYCBpcyBhIG5hbWUgYSBodW1hbiBzZWVzIGluIGEgcm9zdGVyLFxuICogYGh1bWFuYCB0ZWxscyBhbiBhZ2VudCBpdCBpcyB0YWxraW5nIHRvIGEgcGVyc29uLCBhbmQgYGx1cmtgIGV4Y2x1ZGVzIGFcbiAqIGNvbm5lY3Rpb24gZnJvbSBldmVyeSBwcmVzZW5jZSBjb3VudC4gVGhlcmUgaXMgbm8gd2F5IHRvIHB1dCBhbnkgb2YgdGhhdCBpbnRvXG4gKiBhIHNldCBvZiBjbG9zZXJzLiBBZG9wdGluZyB0aGlzIG1vZHVsZSB3b3VsZCBub3QgYmUgZGVhZCBjb2RlOyBpdCB3b3VsZCBiZSBhXG4gKiByZXdyaXRlIG9mIHdoYXQgZ3JhcGV2aW5lIElTLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgTElTVCBJUyBERUxJQkVSQVRFTFkgTk9UIFRIRSBPQlZJT1VTIE9ORS4qKiBUaGUgcG9ydCdzIGZpcnN0XG4gKiBjb3VudCBuYW1lZCB0aGUgYHJvbGxgL2NsZWFyIGJyb2FkY2FzdCwgdGhlIGFyY2hpdmUgbGl2ZS1ndWFyZCBhbmQgdHdvXG4gKiBSRUdJU1RSQVRJT05TIOKAlCBhbmQgZXZlcnkgb25lIG9mIHRob3NlIGlzIGEgc2l0ZSB0aGlzIG1vZHVsZSdzIHR5cGUgd291bGRcbiAqIHNlcnZlIHBlcmZlY3RseTogdGhlIGJyb2FkY2FzdCByZWFkcyBvbmx5IGBzLnNlbmRgLCB0aGUgbGl2ZS1ndWFyZCBvbmx5XG4gKiBgc3Vic2NyaWJlcnMuc2l6ZWAgKHdoaWNoIHRoaXMgaGVhZGVyIGl0c2VsZiBzYXlzIGlzIGFsbCBhbnkgYWRvcHRlciByZWFkcyksXG4gKiBhbmQgYSByZWdpc3RyYXRpb24gV1JJVEVTIHRoZSByZWNvcmQgcmF0aGVyIHRoYW4gcmVhZGluZyBpdC4gVGhlIHNpeCBhYm92ZSBhcmVcbiAqIHRoZSBvbmVzIHRoYXQgcmVhZCBhIGZpZWxkIHRoZSBraXQncyBgU3NlQ2xpZW50YCBkb2VzIG5vdCBoYXZlOyB0aGUgd3JpdGVyc1xuICogKGAvd2FpdGAncyBwcmVzZW5jZSByZWdpc3RyYXRpb24gYW5kIHRoZSB0YWlsJ3MpIGFyZSBuYW1lZCBzZXBhcmF0ZWx5IGJlY2F1c2VcbiAqIGEgd3JpdGVyIGlzIG5vdCBldmlkZW5jZSBvZiBhbnl0aGluZy4gQ291bnRlZCBpbiB0aGUgcHJlLXBvcnQgZGFlbW9uLFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9kYWVtb24udHNgIG9uIGBkZXZlbG9wYDpcbiAqIGwuNDIxLCA3MzktNzQ3LCA4MjYsIDg4Ni04ODcsIDEwNDktMTA1NCwgMTE4Mi0xMTg4IOKAlCB3cml0ZXJzIGF0IDExMTEtMTExMiBhbmRcbiAqIDEzMDcuIChDb3JyZWN0ZWQgMjAyNi0wOS0wOSBpbiB0aGUgcmVwYWlyIGNoYXB0ZXI7IEQ2OCdzIHJlcXVpcmVtZW50IGlzIHRoYXRcbiAqIHRoZSByZWZ1c2FsIGJlIHdyaXR0ZW4gd2hlcmUgdGhlIG5leHQgcmVhZGVyIG1lZXRzIGl0LCB3aGljaCBtYWtlcyBhXG4gKiBtaXMtbWVhc3VyZWQgbGlzdCB3b3JzZSB0aGFuIG5vbmUuKVxuICpcbiAqIOKaoCBBbmQgZ3JhcGV2aW5lJ3MgcmVjb3JkcyBjYXJyeSBubyBgY2xvc2VgIGF0IGFsbCDigJQgdGhlIHBlci1zdHJlYW0gdGVhcmRvd24gaXNcbiAqIGEgY2xvc3VyZSBzdGFzaGVkIG9uIHRoZSBSZWFkYWJsZVN0cmVhbSBjb250cm9sbGVyLCByZWFjaGFibGUgb25seSBmcm9tXG4gKiBgY2FuY2VsKClgIOKAlCB3aGljaCBpcyBhbHNvIHdoeSBgaG91c2VrZWVwaW5nYCdzIGBkcmFpbkFuZFN0b3BgIGlzIGFkb3B0ZWRcbiAqIHRoZXJlIHdpdGggaXRzIGBjbGllbnRzYCBhcmd1bWVudCBkZWxpYmVyYXRlbHkgZW1wdHkuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGFuIGFsaWFzLWJlYXJpbmcgcmVjb3JkXG4gKiB3b3VsZCBjaGFuZ2UgdGhlIHR5cGUgZml2ZSBvdGhlciBkYWVtb25zIGNvbXBpbGUgYWdhaW5zdCBhbmQgcmUtZW1pdCBTSVhcbiAqIGFydGlmYWN0cyBhY3Jvc3MgRklWRSBzcGVsbHMsIGVhY2ggb3dlZCBhIGRyaXZlLiBJdCB3b3VsZCBhbHNvIHJlLWNyZWF0ZSB0aGVcbiAqIHRoaW5nIHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHN0b3AsIGFuZCB0aGlzIGZpbGUncyBvd24gYm91bmRhcnkgcGFyYWdyYXBoXG4gKiBzYXlzIGhvdzogYSBzaWduYXR1cmUgd2lkZSBlbm91Z2ggdG8gYWJzb3JiIGV2ZXJ5IGNhbGxlcidzIHNoYXBlIHN0b3BzIGJlaW5nIGFcbiAqIHJlZ2lzdHJ5IGFuZCBiZWNvbWVzIGEgdW5pb24uIFRoZSBjZW5zdXMgY29udmVyZ2VkIGNvcGllcyBpbnRvIG9uZSBtb2R1bGUgYnlcbiAqIGZpbmRpbmcgd2hhdCB0aGV5IFNIQVJFRDsgYSBtb2R1bGUgd2lkZW5lZCB0byBmaXQgdGhlIG9uZSBzcGVsbCB0aGF0IHNoYXJlc1xuICogbm90aGluZyBpcyB0aG9zZSBjb3BpZXMgYWdhaW4gd2l0aCBhIHVuaW9uIHR5cGUgb3ZlciB0aGUgdG9wLiBUaGUgc3BlbGwga2VlcHNcbiAqIGl0cyBvd24sIGFuZCBhIHdpZGVuaW5nIHJlbWFpbnMgYSBzZXBhcmF0ZSwgYXJndWVkIGRlY2lzaW9uLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZlbnRMb2csIEZyYW1lIH0gZnJvbSBcIi4vZXZlbnRMb2cudHNcIjtcblxuLyoqXG4gKiBPbmUgb3BlbiBTU0Ugc3RyZWFtLCBhcyB0aGUgZGFlbW9uIGNhbiBhY3Qgb24gaXQ6IGVuZCBpdCwgb3IgcHVzaCBhIGZyYW1lIHRvXG4gKiBpdCB0aGF0IGRpZCBub3QgY29tZSBvdXQgb2YgdGhlIGxvZy5cbiAqXG4gKiDim5QgSVQgSVMgTk9UIEEgQ09OVFJPTExFUi4gVGhlIGNvcGllcyBoZWxkXG4gKiBgU2V0PFJlYWRhYmxlU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI+YCBhbmQgY2xvc2VkIHRoZW0gZGlyZWN0bHkgYXQgdGVhcmRvd24sXG4gKiB3aGljaCBieXBhc3NlcyB0aGUgdGVhcmRvd24gZnVubmVsIGFib3ZlIOKAlCB0aGUgaGVhcnRiZWF0IGludGVydmFsIGZvciB0aGF0XG4gKiBzdHJlYW0gd2FzIGNsZWFyZWQgb25seSBiZWNhdXNlIGEgc2Vjb25kIGBTZXRgIG9mIHRpbWVycyB3YXMga2VwdCBpbiBwYXJhbGxlbFxuICogYW5kIHN3ZXB0IHNlcGFyYXRlbHkuIEV2ZXJ5dGhpbmcgaGVyZSBnb2VzIHRocm91Z2ggdGhlIGZ1bm5lbCwgYW5kIGEgYHNlbmRgXG4gKiBhZnRlciB0ZWFyZG93biBpcyBhIG5vLW9wIHJhdGhlciB0aGFuIGEgdGhyb3cuXG4gKlxuICog4pqgICoqYHNlbmRgIEFSUklWRUQgSU4gUEhBU0UgMiwgRlJPTSBUSEUgRklSU1QgQ09OU1VNRVIgVEhBVCBXQVMgTk9UIE9ORSBPRiBUSEVcbiAqIFRXTyBUSElTIE1PRFVMRSBXQVMgREVTSUdORUQgQUdBSU5TVC4qKiBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSBhbm5vdW5jZSBwcmVzZW5jZVxuICogb3ZlciB0aGVpciBicm93c2VyIFdFQlNPQ0tFVCwgc28gYSByZWdpc3RyeSBvZiBiYXJlIGNsb3NlcnMgd2FzIHN1ZmZpY2llbnQgYW5kXG4gKiB0aGUgYm91bmRhcnkgbG9va2VkIHJpZ2h0LiBnbGFtb3VyIGFubm91bmNlcyBpdCBvbiB0aGUgQUdFTlQncyBTU0UgdGFpbCDigJRcbiAqIGB7dHlwZTpcImNvbm5lY3RlZFwifWAgLyBge3R5cGU6XCJkaXNjb25uZWN0ZWRcIn1gLCBkZWxpYmVyYXRlbHkgdW5sb2dnZWQsIHNvIGFcbiAqIHJlY29ubmVjdGluZyBhZ2VudCBkb2VzIG5vdCByZS1zZWUgZXZlcnkgcGFzdCBjb25uZWN0IGFuZCBzbyB0aGUgZnJhbWUgbmV2ZXJcbiAqIGFkdmFuY2VzIGEgdGFpbCBjdXJzb3IuIFRoYXQgaXMgbm90IGEgZ2xhbW91ciBxdWlyazsgaXQgaXMgdGhlIGdlbmVyYWwgc2hhcGVcbiAqIG9mIFwidGVsbCB0aGUgbGl2ZSBzdWJzY3JpYmVycyBzb21ldGhpbmcgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgaGlzdG9yeVwiLCBhbmRcbiAqIGEgcmVnaXN0cnkgdGhhdCBjYW4gb25seSBFTkQgYSBzdHJlYW0gY2Fubm90IGV4cHJlc3MgaXQuIFdpdGhvdXQgdGhpcyB0aGVcbiAqIHNwZWxsIHdvdWxkIGhhdmUgaGFkIHRvIGtlZXAgaXRzIG93biBwYXJhbGxlbCBgU2V0YCBvZiBjb250cm9sbGVycywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVnaXN0cnkgZXhpc3RzIHRvIHJlbW92ZS5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50ID0ge1xuICAvKiogRW5kIHRoaXMgc3RyZWFtLCB0aHJvdWdoIHRoZSB0ZWFyZG93biBmdW5uZWwsIGF0IG1vc3Qgb25jZS4gKi9cbiAgY2xvc2UoKTogdm9pZDtcbiAgLyoqIFdyaXRlIG9uZSByYXcgU1NFIGNodW5rIHRvIHRoaXMgc3RyZWFtLiBOby1vcCBvbmNlIHRvcm4gZG93bi4gKi9cbiAgc2VuZChjaHVuazogc3RyaW5nKTogdm9pZDtcbn07XG5cbi8qKlxuICogVGhlIGxpdmUtdGFpbCByZWdpc3RyeS4gYHNpemVgIGlzIHRoZSBkYWVtb24ncyBTU0Ugc3Vic2NyaWJlciBjb3VudCDigJQgdGhlXG4gKiBudW1iZXIgYHNob3VsZElkbGVDbG9zZWAgbXVzdCBzZWUg4oCUIGFuZCBjbG9zaW5nIGV2ZXJ5IGVudHJ5IGlzIHdoYXQgYSBkcmFpblxuICogZG9lcy5cbiAqL1xuZXhwb3J0IHR5cGUgU3NlQ2xpZW50cyA9IFNldDxTc2VDbGllbnQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZU9wdGlvbnM8VCBleHRlbmRzIG9iamVjdD4ge1xuICAvKiogVGhlIGxvZyB0byByZXBsYXkgZnJvbSBhbmQgc3Vic2NyaWJlIHRvLiAqL1xuICBsb2c6IEV2ZW50TG9nPFQ+O1xuICAvKiogVGhlIGNhbGxlcidzIHJlc3VtZSBjdXJzb3IuIEFic2VudCBvciB1bnBhcnNlYWJsZSByZXBsYXlzIGZyb20gdGhlIHN0YXJ0LiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogSGVhcnRiZWF0IGNvbW1lbnQgaW50ZXJ2YWwuIE1VU1Qgc3RheSB3ZWxsIHVuZGVyIHRoZSBzZXJ2ZXInc1xuICAgKiAgYGlkbGVUaW1lb3V0YCDigJQgc2VlIGBoZWFydGJlYXQudHNgLCB3aGljaCBpcyB3aGVyZSB0aGF0IHBhaXIgbGl2ZXMuICovXG4gIGhlYXJ0YmVhdE1zOiBudW1iZXI7XG4gIC8qKiBMaXZlbmVzcyByZWdpc3RyeTsgdGhlIHN0cmVhbSBhZGRzIGl0c2VsZiBvbiBvcGVuIGFuZCByZW1vdmVzIGl0c2VsZiBpblxuICAgKiAgdGhlIHRlYXJkb3duIGZ1bm5lbC4gKi9cbiAgY2xpZW50cz86IFNzZUNsaWVudHM7XG4gIC8qKiBgcmVxLnNpZ25hbGAg4oCUIHRoZSBvbmx5IHRoaW5nIHRoYXQgcmVjbGFpbXMgYSBjbGllbnQgdGhhdCB3ZW50IGF3YXlcbiAgICogIHdpdGhvdXQgY2FuY2VsbGluZyB0aGUgc3RyZWFtLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFNlcnZlci1zaWRlIGZpbHRlci4gQSByZWplY3RlZCBmcmFtZSBpcyBub3Qgc2VudDsgdGhlIGNsaWVudCBzdGlsbFxuICAgKiAgYWR2YW5jZXMgaXRzIGN1cnNvciBwYXN0IGl0LCB3aGljaCBpcyBgdGFpbEV2ZW50c2AncyBkb2N1bWVudGVkIHJ1bGUuICovXG4gIGZpbHRlcj86IChmcmFtZTogRnJhbWU8VD4pID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBSYXcgU1NFIGNodW5rcyB3cml0dGVuIHRvIFRISVMgc3RyZWFtIEJFRk9SRSB0aGUgcmVwbGF5IOKAlCBhZnRlciB0aGVcbiAgICogYFwiOiBjb25uZWN0ZWRcImAgcHJlYW1ibGUgYW5kIGJlZm9yZSBgbG9nLnN1YnNjcmliZWAsIHNvIHdoYXRldmVyIGl0IHJldHVybnNcbiAgICogaXMgdGhlIHN0cmVhbSdzIGZpcnN0IERBVEEgbGluZSByYXRoZXIgdGhhbiBhIGZyYW1lIGJ1cmllZCBiZWhpbmQgYVxuICAgKiByZXBsYXllZCBiYWNrbG9nLlxuICAgKlxuICAgKiDim5QgSVQgSVMgQSBQT1NJVElPTiwgV0hJQ0ggSVMgV0hZIGBvbk9wZW5gIENPVUxEIE5PVCBTRVJWRSAoRDg1KS4gYG9uT3BlbmBcbiAgICogZmlyZXMgYXQgdGhlIGVuZCBvZiBgc3RhcnRgIOKAlCBhZnRlciB0aGUgcHJlYW1ibGUsIGFmdGVyIGBsb2cuc3Vic2NyaWJlYCxcbiAgICogYWZ0ZXIgYGNsaWVudHMuYWRkYCDigJQgc28gYSBjYWxsZXIgdGhhdCBzdXBwbGllcyBpdHMgb3duIGBjbGllbnRzYCBzZXQgYW5kXG4gICAqIHNlbmRzIGZyb20gdGhlcmUgbGFuZHMgaXRzIGZyYW1lIEFGVEVSIHRoZSBiYWNrbG9nLiBUaGF0IGlzIGV4cHJlc3NpYmxlIGFuZFxuICAgKiBpdCBpcyB0aGUgd3Jvbmcgb3JkZXIsIHdoaWNoIGlzIHRoZSBuZWFyLW1pc3MgdGhhdCBtYWtlcyB0aGlzIGEgbWVhc3VyZW1lbnRcbiAgICogcmF0aGVyIHRoYW4gYW4gYXNzZXJ0aW9uOiBub3RoaW5nIGFib3V0IHRoZSBUWVBFUyBwcmV2ZW50cyBpdCwgYW5kIGFcbiAgICogdHlwZS10by10eXBlIGNvbXBhdGliaWxpdHkgY2hlY2sgY2Fubm90IHNlZSBhIHBvc2l0aW9uLlxuICAgKlxuICAgKiDim5QgUkVTVE9SRUQgRlJPTSBUSEUgU1BFTEwgVEhJUyBNT0RVTEUgV0FTIENPTlZFUkdFRCBUT1dBUkQsIEFORCBJVCBJUyBBXG4gICAqIFJFU1RPUkFUSU9OIFJBVEhFUiBUSEFOIEEgV0lERU5JTkcgT04gVFdPIE1FQVNVUkVEIE5VTUJFUlMgKEQ3OS9EODUpLlxuICAgKiBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAgd3JvdGUgaXRzIGB0YWlsIC0taW5ib3VuZGAgZ3JvdW5kaW5nIGZyYW1lIG9uZVxuICAgKiBsaW5lIEFCT1ZFIGBidXMuc3Vic2NyaWJlYDsgdGhpcyBtb2R1bGUncyBjb252ZXJnZW5jZSBkcm9wcGVkIHRoZSBwb3NpdGlvbixcbiAgICogc28gdGhlIG9ubHkgcHJvcGVydHkgbWluZC1tYXBwZXIgY291bGQgbm90IGFkb3B0IHdhcyB0aGUgb3JkZXJpbmcuIEFwcGxpZWQsXG4gICAqIHdpdGggZXZlcnkga2l0LWJ1bmRsaW5nIHNwZWxsIHJlYnVpbHQ6ICoqKGEpIHNvdXJjZSBlZGl0cyBuZWVkZWQgYXQgdGhlXG4gICAqIG90aGVyIGZpdmUgYWRvcHRlcnM6IFpFUk8qKiDigJQgdGhlIGZpZWxkIGlzIG9wdGlvbmFsIGFuZCBub2JvZHkgcGFzc2VzIGl0O1xuICAgKiAqKihiKSBieXRlcyBvZiBhbnkgb3RoZXIgYWRvcHRlcidzIFdJUkUgdGhhdCBkaWZmZXI6IFpFUk8qKiDigJQgYXN0cm9sYWJlLFxuICAgKiBib3VudHksIGdsYW1vdXIsIGltYWdvIGFuZCBtYWdwaWUgd2VyZSBkcml2ZW4gdW5kZXIgdGhlaXIgb3duIHN1aXRlcyBhbmRcbiAgICogdGhlaXIgcmVsZWFzZSBkcml2ZXMsIGFuZCBub25lIG9mIHRoZW0gd3JpdGVzIGF0IG9wZW4uIEJvdGggbnVtYmVycyB6ZXJvIGlzXG4gICAqIHdoYXQgXCJ0aGUga2l0IHJlbW92ZWQgaXQgd2hlbiBpdCBjb3BpZWRcIiBtZWFucyBvcGVyYXRpb25hbGx5LlxuICAgKlxuICAgKiDimqAgQU5EIFRIRSBIT09LIFdBUyBSRUpFQ1RFRCBPTkNFLCBGT1IgQSBSRUFTT04gVEhBVCBET0VTIE5PVCBSRUFDSCBUSElTXG4gICAqIENBU0UuIEQzMidzIG5vdC10YWtlbiBhcmd1ZWQgYWdhaW5zdCBcImEgYHNzZVJlc3BvbnNlYCBob29rIHRoYXQgaGFuZHMgdGhlXG4gICAqIGNhbGxlciBhIHJhdyBgc2VuZGAg4oCmIHRoZSBjYWxsZXIgdGhlbiBoYXMgdG8ga2VlcCBpdHMgb3duIGNvbGxlY3Rpb24gb2ZcbiAgICogdGhlbVwiIOKAlCBhZ2FpbnN0IGdsYW1vdXIncyBwcmVzZW5jZSBCUk9BRENBU1QsIHdoaWNoIHB1c2hlcyB0b1xuICAgKiBhbHJlYWR5LW9wZW4gc3RyZWFtcyBmcm9tIG91dHNpZGUgYW5kIGRvZXMgbmVlZCBhIGNvbGxlY3Rpb24uIFRoaXMgaXMgb25lXG4gICAqIGZyYW1lLCBvbiBvbmUgc3RyZWFtLCBhdCBvcGVuLCBhbmQgdGhlIGNhbGxlciBrZWVwcyBubyBjb2xsZWN0aW9uIGF0IGFsbC5cbiAgICogQSByZWplY3Rpb24gaXMgc2NvcGVkIHRvIHRoZSBjYXNlIHRoYXQgcHJvZHVjZWQgaXQuXG4gICAqL1xuICBvcGVuRnJhbWVzPzogKCkgPT4gc3RyaW5nW107XG4gIC8qKiBSdW4gYWZ0ZXIgdGhlIHN0cmVhbSBpcyBzdWJzY3JpYmVkIChwcmVzZW5jZSB1cCwgYWN0aXZpdHkgdG91Y2gpLiAqL1xuICBvbk9wZW4/OiAoKSA9PiB2b2lkO1xuICAvKiogUnVuIGV4YWN0bHkgb25jZSwgZnJvbSB3aGljaGV2ZXIgdGVhcmRvd24gcGF0aCBmaXJlcyBmaXJzdC4gKi9cbiAgb25DbG9zZT86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzc2VSZXNwb25zZTxUIGV4dGVuZHMgb2JqZWN0PihvcHRzOiBTc2VPcHRpb25zPFQ+KTogUmVzcG9uc2Uge1xuICBjb25zdCB7IGxvZywgc2luY2UsIGhlYXJ0YmVhdE1zLCBjbGllbnRzLCBzaWduYWwsIGZpbHRlciwgb3BlbkZyYW1lcywgb25PcGVuLCBvbkNsb3NlIH0gPSBvcHRzO1xuXG4gIGxldCB1bnN1YnNjcmliZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGxldCBrZWVwYWxpdmU6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gIC8vIFRoZSByZWdpc3RyeSBlbnRyeSBmb3IgVEhJUyBzdHJlYW0uIEl0cyBtZXRob2RzIGFyZSBmaWxsZWQgaW4gYnkgYHN0YXJ0YCxcbiAgLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGNvbnRyb2xsZXIgZXhpc3RzOyB0aGUgb2JqZWN0IGlkZW50aXR5IGlzIHN0YWJsZSBmcm9tXG4gIC8vIGhlcmUgc28gYHRlYXJkb3duYCBjYW4gcmVtb3ZlIGV4YWN0bHkgdGhpcyBlbnRyeS5cbiAgY29uc3QgY2xpZW50OiBTc2VDbGllbnQgPSB7IGNsb3NlOiAoKSA9PiB7fSwgc2VuZDogKCkgPT4ge30gfTtcblxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGNsaWVudHM/LmRlbGV0ZShjbGllbnQpO1xuICAgIG9uQ2xvc2U/LigpO1xuICB9O1xuXG4gIGNvbnN0IHN0cmVhbSA9IG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICAgICAgY29uc3Qgc2FmZUVucXVldWUgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGVuY29kZXIuZW5jb2RlKGNodW5rKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGllbnQuY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIHRlYXJkb3duKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29udHJvbGxlci5jbG9zZSgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBhbHJlYWR5IGNsb3NlZCBieSB0aGUgcnVudGltZSAqL1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8g4puUIGBzZW5kYCBHT0VTIFRIUk9VR0ggYHNhZmVFbnF1ZXVlYCwgc28gYW4gb3V0LW9mLWJhbmQgZnJhbWUgb2JleXMgdGhlXG4gICAgICAvLyBzYW1lIGNsb3NlZC1jaGVjayBhbmQgdGhlIHNhbWUgdGVhcmRvd24tb24tdGhyb3cgYXMgYSBsb2dnZWQgb25lLiBBXG4gICAgICAvLyBkYWVtb24gbXVzdCBub3QgYmUgYWJsZSB0byB3cml0ZSB0byBhIHN0cmVhbSB0aGlzIG1vZHVsZSBoYXMgdG9ybiBkb3duLlxuICAgICAgY2xpZW50LnNlbmQgPSBzYWZlRW5xdWV1ZTtcblxuICAgICAgLy8g4puUIEFOIE9QRU5JTkcgQ09NTUVOVCwgQkVGT1JFIEFOWVRISU5HIEVMU0UuIEl0IGZsdXNoZXMgdGhlIHJlc3BvbnNlXG4gICAgICAvLyBoZWFkZXJzIGltbWVkaWF0ZWx5OiBzb21lIEhUVFAgY2xpZW50cyDigJQgQnVuJ3Mgb3duIGBmZXRjaCgpYCBpbmNsdWRlZCDigJRcbiAgICAgIC8vIGJ1ZmZlciB1bnRpbCB0aGUgZmlyc3QgYnl0ZSBvZiBib2R5IGFycml2ZXMsIHNvIGEgZ2VudWluZWx5IHF1aWV0IFNTRVxuICAgICAgLy8gc3RyZWFtIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSB0aGUgY2FsbGVyJ3MgYGZldGNoKClgIHVucmVzb2x2ZWQuIEV2ZXJ5XG4gICAgICAvLyBob3VzZSB0YWlsIGNsaWVudCByZWFkcyBgOmAgbGluZXMgYXMgY29tbWVudHMgYW5kIGRyb3BzIHRoZW0uXG4gICAgICBzYWZlRW5xdWV1ZShcIjogY29ubmVjdGVkXFxuXFxuXCIpO1xuXG4gICAgICAvLyDim5QgQkVGT1JFIFRIRSBSRVBMQVksIEFORCBUSEUgT1JERVIgSVMgVEhFIFdIT0xFIFBPSU5UIOKAlCBzZWVcbiAgICAgIC8vIGBvcGVuRnJhbWVzYCBpbiB0aGUgb3B0aW9ucyBhYm92ZS4gQSBncm91bmRpbmcgZnJhbWUgd3JpdHRlbiBoZXJlIGlzXG4gICAgICAvLyB0aGUgc3RyZWFtJ3MgZmlyc3QgZGF0YSBsaW5lOyB3cml0dGVuIGZyb20gYG9uT3BlbmAgaXQgYXJyaXZlcyBhZnRlclxuICAgICAgLy8gdGhlIHJlcGxheWVkIGJhY2tsb2csIHdoaWNoIGlzIGEgZGlmZmVyZW50IGNvbnRyYWN0IHdlYXJpbmcgdGhlIHNhbWVcbiAgICAgIC8vIHR5cGVzLlxuICAgICAgaWYgKG9wZW5GcmFtZXMpIGZvciAoY29uc3QgY2h1bmsgb2Ygb3BlbkZyYW1lcygpKSBzYWZlRW5xdWV1ZShjaHVuayk7XG5cbiAgICAgIHVuc3Vic2NyaWJlID0gbG9nLnN1YnNjcmliZShzaW5jZSwgKGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmaWx0ZXIgJiYgIWZpbHRlcihmcmFtZSkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZnJhbWUpfVxcblxcbmApO1xuICAgICAgfSk7XG5cbiAgICAgIGtlZXBhbGl2ZSA9IHNldEludGVydmFsKCgpID0+IHNhZmVFbnF1ZXVlKFwiOiBoYlxcblxcblwiKSwgaGVhcnRiZWF0TXMpO1xuICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgdGVhcmRvd24sIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIGNsaWVudHM/LmFkZChjbGllbnQpO1xuICAgICAgb25PcGVuPy4oKTtcbiAgICB9LFxuICAgIGNhbmNlbCgpIHtcbiAgICAgIHRlYXJkb3duKCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvKipcbiAqIFRoZSBOQVRJVkUgZmlsZSBwaWNrZXIg4oCUIHRoZSBhZmZvcmRhbmNlIGEgd2ViIHBhZ2UgY2Fubm90IGhhdmUuXG4gKlxuICogQSBicm93c2VyJ3Mgb3duIGA8aW5wdXQgdHlwZT1cImZpbGVcIj5gIGFuZCBgc2hvd09wZW5GaWxlUGlja2VyKClgIGJvdGggaGFuZFxuICogYmFjayBmaWxlIENPTlRFTlQgYW5kIGEgbmFtZSwgbmV2ZXIgYSBwYXRoIChhbmQgQnJhdmUsIENvbGUncyBicm93c2VyLFxuICogZGlzYWJsZXMgdGhlIEZpbGUgU3lzdGVtIEFjY2VzcyBBUEkgb3V0cmlnaHQpLiBBIGNvcHkgaXMgYWxsIGEgcGFnZSBjYW4gZG9cbiAqIHdpdGggdGhhdCwgd2hpY2ggaXMgZXhhY3RseSB3aGF0IGEgZHJvcCBhbHJlYWR5IGRvZXMgKEUyMykuIEJ1dCBzY3JpcHRvcml1bSdzXG4gKiBkYWVtb24gaXMgYSBMT0NBTCBQUk9DRVNTOiBpdCBjYW4gYXNrIHRoZSBPUyBmb3IgaXRzIG93biBvcGVuIGRpYWxvZyBhbmQgZ2V0XG4gKiBiYWNrIGEgcmVhbCBmaWxlc3lzdGVtIHBhdGgg4oCUIHNvIFwiQ2hvb3Nl4oCmXCIgbGlua3MgdGhlIHJlYWwgZmlsZSAoRTEpIGluc3RlYWRcbiAqIG9mIGNvcHlpbmcgaXQuXG4gKlxuICogRXZlcnl0aGluZyBoZXJlIGlzIHB1cmU6IHdoaWNoIGFyZ3YgdG8gcnVuLCBhbmQgaG93IHRvIHJlYWQgd2hhdCBpdCBwcmludGVkLlxuICogVGhlIHNwYXduaW5nIChhbmQgdGhlIG9uZS1hdC1hLXRpbWUgcnVsZSkgaXMgdGhlIGRhZW1vbidzLlxuICovXG5cbmV4cG9ydCB0eXBlIFBpY2tLaW5kID0gXCJmaWxlXCIgfCBcImZvbGRlclwiO1xuXG4vKiogQW4gQXBwbGVTY3JpcHQgdGhhdCBwdXRzIG9uZSBQT1NJWCBwYXRoIHBlciBsaW5lIG9uIHN0ZG91dC4gKi9cbmZ1bmN0aW9uIGFwcGxlU2NyaXB0KGtpbmQ6IFBpY2tLaW5kLCBwcm9tcHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHF1b3RlZCA9IHByb21wdC5yZXBsYWNlKC9bXCJcXFxcXS9nLCBcIlwiKTtcbiAgY29uc3QgY2hvb3NlID1cbiAgICBraW5kID09PSBcImZpbGVcIlxuICAgICAgPyBgY2hvb3NlIGZpbGUgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIiB3aXRoIG11bHRpcGxlIHNlbGVjdGlvbnMgYWxsb3dlZGBcbiAgICAgIDogYHtjaG9vc2UgZm9sZGVyIHdpdGggcHJvbXB0IFwiJHtxdW90ZWR9XCJ9YDtcbiAgcmV0dXJuIFtcbiAgICBgc2V0IGNob3NlbiB0byAke2Nob29zZX1gLFxuICAgICdzZXQgb3V0IHRvIFwiXCInLFxuICAgIFwicmVwZWF0IHdpdGggZiBpbiBjaG9zZW5cIixcbiAgICBcInNldCBvdXQgdG8gb3V0ICYgUE9TSVggcGF0aCBvZiBmICYgbGluZWZlZWRcIixcbiAgICBcImVuZCByZXBlYXRcIixcbiAgICBcInJldHVybiBvdXRcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBjb21tYW5kIHRoYXQgb3BlbnMgdGhlIE9TJ3MgcGlja2VyLCBvciBudWxsIHdoZXJlIHRoZXJlIGlzIG5vbmUg4oCUIHRoZVxuICogY2FsbGVyIHRoZW4gc2F5cyBzbyByYXRoZXIgdGhhbiBoYW5naW5nIG9uIGEgZGlhbG9nIG5vYm9keSB3aWxsIHNlZS5cbiAqIGB6ZW5pdHlBdGAgaXMgd2hlcmUgYSBMaW51eCB6ZW5pdHkgd2FzIGZvdW5kICh0aGUgY2FsbGVyIGxvb2tzIGl0IHVwKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpY2tlckNvbW1hbmQoXG4gIHBsYXRmb3JtOiBzdHJpbmcsXG4gIGtpbmQ6IFBpY2tLaW5kLFxuICBwcm9tcHQ6IHN0cmluZyxcbiAgemVuaXR5QXQ/OiBzdHJpbmcgfCBudWxsLFxuKTogc3RyaW5nW10gfCBudWxsIHtcbiAgaWYgKHBsYXRmb3JtID09PSBcImRhcndpblwiKSByZXR1cm4gW1wib3Nhc2NyaXB0XCIsIFwiLWVcIiwgYXBwbGVTY3JpcHQoa2luZCwgcHJvbXB0KV07XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSByZXR1cm4gbnVsbDsgLy8gUG93ZXJTaGVsbCdzIGRpYWxvZyBuZWVkcyBhIFNUQSBob3N0OyBub3Qgd3JpdHRlbiB1bnRpbCBhc2tlZCBmb3JcbiAgaWYgKHplbml0eUF0KVxuICAgIHJldHVybiBbXG4gICAgICB6ZW5pdHlBdCxcbiAgICAgIFwiLS1maWxlLXNlbGVjdGlvblwiLFxuICAgICAgLi4uKGtpbmQgPT09IFwiZm9sZGVyXCIgPyBbXCItLWRpcmVjdG9yeVwiXSA6IFtcIi0tbXVsdGlwbGVcIl0pLFxuICAgICAgXCItLXNlcGFyYXRvcj1cXG5cIixcbiAgICAgIGAtLXRpdGxlPSR7cHJvbXB0fWAsXG4gICAgXTtcbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBUaGUgcGF0aHMgYSBwaWNrZXIgcHJpbnRlZDogb25lIHBlciBsaW5lLCBibGFua3MgZHJvcHBlZCwgb3JkZXIga2VwdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVBpY2tlck91dHB1dChzdGRvdXQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHN0ZG91dFxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5tYXAoKGwpID0+IGwudHJpbSgpKVxuICAgIC5maWx0ZXIoKGwpID0+IGwuc3RhcnRzV2l0aChcIi9cIikpXG4gICAgLm1hcCgobCkgPT4gKGwubGVuZ3RoID4gMSAmJiBsLmVuZHNXaXRoKFwiL1wiKSA/IGwuc2xpY2UoMCwgLTEpIDogbCkpO1xufVxuXG4vKiogQSBjYW5jZWxsZWQgZGlhbG9nIGlzIG5vdCBhIGZhaWx1cmUg4oCUIG9zYXNjcmlwdCBleGl0cyAxLCB6ZW5pdHkgZXhpdHMgMSwgYW5kIG5vdGhpbmcgd2FzIGNob3Nlbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YXNDYW5jZWxsZWQoZXhpdENvZGU6IG51bWJlciwgc3Rkb3V0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGV4aXRDb2RlICE9PSAwICYmIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dCkubGVuZ3RoID09PSAwO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBzZXNzaW9uIOKAlCB0aGUgZGFlbW9uJ3Mgc3RhdGUsIGFuZCB0aGUgb25seSBjb2RlIHRoYXQgd3JpdGVzIGEgZmlsZS5cbiAqXG4gKiBFOCdzIHNoYXBlLCB0aGUgaG91c2UncyBcIm1hdGVyaWFsaXplZCBwYXRoXCIgcGF0dGVybjogdGhlIGRhZW1vbiBvd25zIHRoZVxuICogc2Vzc2lvbiAoY29udGV4dCwgZG9jcywgdmVyc2lvbnMsIHdoaWNoIGlzIGFjdGl2ZSwgdGhlIGNoYXQpIGFuZCBwZXJzaXN0cyBpdFxuICogYXMgYG1hbmlmZXN0Lmpzb25gOyBldmVyeSB2ZXJzaW9uJ3MgVEVYVCBpcyBhIGZpbGUgaW4gdGhlIHNlc3Npb24gZm9sZGVyLCBzb1xuICogdGhlIGFnZW50IGVkaXRzIHZlcnNpb25zIHdpdGggaXRzIG93biBmaWxlIHRvb2xzLlxuICpcbiAqICAgICAkU0NSSVBUT1JJVU1fSE9NRS9zZXNzaW9ucy88c2Vzc2lvbklkPi9cbiAqICAgICAgIG1hbmlmZXN0Lmpzb24gICAgICAgICAgICAgIHdyaXR0ZW4gYXRvbWljYWxseSwgb24gZXZlcnkgY2hhbmdlXG4gKiAgICAgICBkb2NzLzxzbHVnPi92MS5tZCwgdjIubWQgICBvbmUgZmlsZSBwZXIgdmVyc2lvblxuICpcbiAqIFRoZSB0aHJlZSB3cml0ZSBydWxlcywgZWFjaCBhIGRlY2lzaW9uIHJhdGhlciB0aGFuIGEgaGFiaXQ6XG4gKlxuICogLSAqKlRoZSBvcmlnaW5hbCBpcyB3cml0dGVuIE9OTFkgYnkgYHNhdmVgKiogKEU3KS4gT3BlbmluZyBjb3BpZXMgaXQgdG8gdjE7XG4gKiAgIG5vdGhpbmcgZWxzZSB0b3VjaGVzIGl0LlxuICogLSAqKkV2ZXJ5IHdyaXRlIHRoaXMgbW9kdWxlIG1ha2VzIGlzIHJlbWVtYmVyZWQgYnkgY29udGVudCBoYXNoKiogKHRoZVxuICogICBgb3duZWRgIG1hcCkgc28gdGhlIHdhdGNoZXIgY2FuIHRlbGwgdGhlIGRhZW1vbidzIG93biB3cml0ZXMgZnJvbSBhbnlvbmVcbiAqICAgZWxzZSdzIChpbnZlc3RpZ2F0aW9uIMKnNSkuIEEgd3JpdGUgdG8gdGhlIEFDVElWRSB2ZXJzaW9uIHRoYXQgaXMgbm90IG91cnNcbiAqICAgaXMgYW4gRTIgdmlvbGF0aW9uIHRoZSBkYWVtb24gYW5ub3VuY2VzLlxuICogLSAqKlRoZSBhZ2VudCBuZXZlciB3cml0ZXMgdGhlIGFjdGl2ZSB2ZXJzaW9uKiogKEUyKSDigJQgZW5mb3JjZWQgc29jaWFsbHkgYnlcbiAqICAgU0tJTEwubWQgYW5kIGRldGVjdGVkIGhlcmUsIG5vdCBwcmV2ZW50ZWQ6IHRoZSBmaWxlIGlzIHRoZSBhZ2VudCdzIG1lZGl1bS5cbiAqXG4gKiBOb3RoaW5nIGhlcmUga25vd3MgYWJvdXQgc29ja2V0cywgSFRUUCBvciB0aGUgZXZlbnQgbG9nLiBUaGUgZGFlbW9uIGNhbGxzIGFcbiAqIG1ldGhvZCwgZ2V0cyBhIHJlc3VsdCwgYW5kIGRlY2lkZXMgd2hhdCB0byBicm9hZGNhc3Q7IHRoYXQgc3BsaXQgaXMgd2hhdFxuICogbGV0cyB0aGUgdW5pdCBjZWxscyBkcml2ZSB0aGUgd2hvbGUgbW9kZWwgd2l0aCBhIHRlbXAgaG9tZS5cbiAqL1xuXG5pbXBvcnQge1xuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgc3RhdFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgd3JpdGVGaWxlQXRvbWljIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Rpc2NvdmVyeS50c1wiO1xuaW1wb3J0IHR5cGUge1xuICBDaGF0TWVzc2FnZSxcbiAgQ2hhdFdobyxcbiAgQ29udGV4dEVudHJ5LFxuICBEb2NWaWV3LFxuICBNb3ZlUGxhbixcbiAgUHVibGljU3RhdGUsXG4gIFNlbGVjdGlvbixcbiAgVmVyc2lvbixcbiAgVmVyc2lvbkF1dGhvcixcbn0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcbmltcG9ydCB7XG4gIERPQ19FWFRFTlNJT05TLFxuICBlbnRyeUZvclBhdGgsXG4gIGZpbmROb2RlLFxuICBpc0RvY05hbWUsXG4gIGxvY2F0ZSxcbiAgTUlSUk9SX05PREVfQ0FQLFxuICBzY2FuVHJlZSxcbiAgdG9Qb3NpeCxcbn0gZnJvbSBcIi4vdHJlZVwiO1xuXG5leHBvcnQgY29uc3QgTUFOSUZFU1RfRk9STUFUID0gMTtcblxudHlwZSBEb2NSZWNvcmQgPSB7XG4gIHNsdWc6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBvcmlnaW5hbDogc3RyaW5nO1xuICBlbnRyeUlkOiBzdHJpbmcgfCBudWxsO1xuICByZWw6IHN0cmluZyB8IG51bGw7XG4gIGV4dDogc3RyaW5nO1xuICB2ZXJzaW9uczogT21pdDxWZXJzaW9uLCBcInBhdGhcIj5bXTtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIC8qKiBIYXNoIG9mIHRoZSBvcmlnaW5hbCBhcyB3ZSBsYXN0IHJlYWQgb3Igd3JvdGUgaXQg4oCUIGF0IG9wZW4sIHNhdmUsIHJldmVydFxuICAgKiAgYW5kIHJlbG9hZCDigJQgc28gYSByZXN0b3JlIGNhbiB0ZWxsIHRoYXQgaXQgY2hhbmdlZCB3aGlsZSBubyBkYWVtb24gd2FzXG4gICAqICB3YXRjaGluZyAodmVyaWZ5LXBhc3MgZml4IDIpLiAqL1xuICBvcmlnaW5hbEhhc2g6IHN0cmluZztcbiAgLyoqIFNldCBvbmx5IGJ5IGBvcGVuUGF0aGAsIHdoaWNoIGFkbWl0cyBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiAgZW50cnkuIGBzYXZlYCB3cml0ZXMgbm8gb3JpZ2luYWwgdGhhdCBsYWNrcyBpdCAodmVyaWZ5LXBhc3MgZml4IDFjKS4gKi9cbiAgYWRtaXR0ZWQ/OiBib29sZWFuO1xuICBvdXRzaWRlQ2hhbmdlZDogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIE1hbmlmZXN0ID0ge1xuICBmb3JtYXQ6IG51bWJlcjtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBjb250ZXh0OiBDb250ZXh0RW50cnlbXTtcbiAgZG9jczogRG9jUmVjb3JkW107XG4gIG9wZW5Eb2M6IHN0cmluZyB8IG51bGw7XG4gIGNoYXQ6IENoYXRNZXNzYWdlW107XG4gIC8qKiBFMjMncyB3b3Jrc3BhY2UuIEFic2VudCBpbiBhIG1hbmlmZXN0IHdyaXR0ZW4gYmVmb3JlIGl0IGV4aXN0ZWQ6IHRoZSB1c2VyJ3MgaG9tZS4gKi9cbiAgd29ya3NwYWNlPzogc3RyaW5nO1xufTtcblxuLyoqIEEgcmVmdXNhbCB0aGUgZGFlbW9uIHR1cm5zIGludG8gYW4gSFRUUCBzdGF0dXMg4oCUIGBjaG9pY2VzYCB3aGVuIHRoZSBzZXQgaXMgaW4gaGFuZCAoQTEpLiAqL1xuZXhwb3J0IGNsYXNzIFNlc3Npb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IHN0YXR1czogNDAwIHwgNDA0IHwgNDA5LFxuICAgIHJlYWRvbmx5IGNob2ljZXM/OiBzdHJpbmdbXSxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IGNvbnRlbnRIYXNoID0gKHRleHQ6IHN0cmluZyk6IHN0cmluZyA9PiBCdW4uaGFzaCh0ZXh0KS50b1N0cmluZygxNik7XG5cbmNvbnN0IHJhbmRIZXggPSAobjogbnVtYmVyKSA9PlxuICBBcnJheS5mcm9tKGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKVxuICAgIC5tYXAoKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSlcbiAgICAuam9pbihcIlwiKTtcblxuZXhwb3J0IGNvbnN0IG5ld1Nlc3Npb25JZCA9ICgpOiBzdHJpbmcgPT4gcmFuZEhleCg0KTtcblxuLyoqIEEgcGF0aCdzIHJlYWxwYXRoLCBvciB0aGUgcGF0aCBpdHNlbGYgd2hlbiBpdCBjYW5ub3QgYmUgcmVzb2x2ZWQgKGdvbmUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWxPcihwOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiByZWFscGF0aFN5bmMocCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBwO1xuICB9XG59XG5cbi8qKiBXaGF0IGEgd2F0Y2hlciBldmVudCB0dXJuZWQgb3V0IHRvIGJlLiBgbnVsbGAgPSBub3RoaW5nIChvdXJzLCBvciBubyBjaGFuZ2UpLiAqL1xuZXhwb3J0IHR5cGUgRmlsZUV2ZW50ID1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgYWN0aXZlOiBmYWxzZSB9XG4gIHwge1xuICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiO1xuICAgICAgZG9jOiBzdHJpbmc7XG4gICAgICB2ZXJzaW9uOiBudW1iZXI7XG4gICAgICBwYXRoOiBzdHJpbmc7XG4gICAgICAvKiogVGhlIG5ldyBhZ2VudCB2ZXJzaW9uIHRoZSBvdXRzaWRlIHRleHQgd2FzIHByZXNlcnZlZCBhcy4gKi9cbiAgICAgIHByZXNlcnZlZEFzOiBudW1iZXI7XG4gICAgICBwcmVzZXJ2ZWRQYXRoOiBzdHJpbmc7XG4gICAgfVxuICB8IHsga2luZDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIjsgZG9jOiBzdHJpbmc7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIjsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJ0cmVlXCI7IGVudHJ5SWQ6IHN0cmluZyB9O1xuXG5leHBvcnQgY2xhc3MgU2Vzc2lvbiB7XG4gIHJlYWRvbmx5IGRpcjogc3RyaW5nO1xuICBwcml2YXRlIG06IE1hbmlmZXN0O1xuICAvKiogcGF0aCDihpIgaGFzaCBvZiB0aGUgZGFlbW9uJ3MgbGFzdCB3cml0ZSB0byBpdC4gKi9cbiAgcHJpdmF0ZSBvd25lZCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiBoYXNoIG9mIHRoZSBhY3RpdmUgdmVyc2lvbidzIGN1cnJlbnQgdGV4dC4gKi9cbiAgcHJpdmF0ZSBhY3RpdmVIYXNoID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNsdWcg4oaSIHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgYXMgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIChvciBhZG9wdGVkKVxuICAgKiAgaXQg4oCUIHdoYXQgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gaXMgcmV2ZXJ0ZWQgdG8uICovXG4gIHByaXZhdGUgbGFzdEFjdGl2ZVRleHQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogV2hhdCBhIHJlc3RvcmUgZm91bmQgY2hhbmdlZCBvbiBkaXNrIHdoaWxlIG5vIGRhZW1vbiB3YXMgd2F0Y2hpbmcuICovXG4gIHJlc3RvcmVGaW5kaW5nczogeyBkb2M6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZzsgbWlzc2luZzogYm9vbGVhbiB9W10gPSBbXTtcblxuICBwcml2YXRlIGNvbnN0cnVjdG9yKFxuICAgIHJlYWRvbmx5IGhvbWU6IHN0cmluZyxcbiAgICBtYW5pZmVzdDogTWFuaWZlc3QsXG4gICkge1xuICAgIHRoaXMubSA9IG1hbmlmZXN0O1xuICAgIHRoaXMuZGlyID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIG1hbmlmZXN0LnNlc3Npb25JZCk7XG4gIH1cblxuICBzdGF0aWMgY3JlYXRlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcgPSBuZXdTZXNzaW9uSWQoKSwgd29ya3NwYWNlPzogc3RyaW5nKTogU2Vzc2lvbiB7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIHtcbiAgICAgIGZvcm1hdDogTUFOSUZFU1RfRk9STUFULFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgY29udGV4dDogW10sXG4gICAgICBkb2NzOiBbXSxcbiAgICAgIG9wZW5Eb2M6IG51bGwsXG4gICAgICBjaGF0OiBbXSxcbiAgICAgIC4uLih3b3Jrc3BhY2UgPyB7IHdvcmtzcGFjZTogcmVzb2x2ZSh3b3Jrc3BhY2UpIH0gOiB7fSksXG4gICAgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4ocy5kaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICAvKiogUmVsb2FkIGEgc2Vzc2lvbiBmcm9tIGl0cyBtYW5pZmVzdCAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gKS4gKi9cbiAgc3RhdGljIHJlc3RvcmUoaG9tZTogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgc2Vzc2lvbklkLCBcIm1hbmlmZXN0Lmpzb25cIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzYXZlZCBzZXNzaW9uICR7c2Vzc2lvbklkfWAsIDQwNCk7XG4gICAgY29uc3QgbSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgYXMgTWFuaWZlc3Q7XG4gICAgaWYgKG0uZm9ybWF0ICE9PSBNQU5JRkVTVF9GT1JNQVQpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBzZXNzaW9uICR7c2Vzc2lvbklkfSBoYXMgbWFuaWZlc3QgZm9ybWF0ICR7bS5mb3JtYXR9YCwgNDA5KTtcbiAgICBjb25zdCBzID0gbmV3IFNlc3Npb24oaG9tZSwgbSk7XG4gICAgbWtkaXJTeW5jKGpvaW4ocy5kaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gTWlycm9ycyBhcmUgcmUtcmVhZCwgbm90IHRydXN0ZWQ6IHRoZSBmb2xkZXIgbWF5IGhhdmUgY2hhbmdlZCB3aGlsZSBub1xuICAgIC8vIGRhZW1vbiB3YXMgd2F0Y2hpbmcgaXQuXG4gICAgZm9yIChjb25zdCBlIG9mIHMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHMucmVzY2FuKGUuaWQpO1xuICAgIGZvciAoY29uc3QgZCBvZiBzLm0uZG9jcykge1xuICAgICAgY29uc3QgcCA9IHMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpO1xuICAgICAgY29uc3QgdGV4dCA9IGV4aXN0c1N5bmMocCkgPyByZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpIDogXCJcIjtcbiAgICAgIHMuYWRvcHRBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDI6IGFuIG9yaWdpbmFsIGNoYW5nZWQgd2hpbGUgdGhlIHNlc3Npb24gd2FzIGNsb3NlZFxuICAgICAgLy8gd2FzIGludmlzaWJsZSBoZXJlLCBzbyB0aGUgbmV4dCBTYXZlIG92ZXJ3cm90ZSBpdCB1bmFubm91bmNlZC4gVGhlXG4gICAgICAvLyBtYW5pZmVzdCBob2xkcyB0aGUgb3JpZ2luYWwncyBoYXNoIGFzIG9mIHRoZSBsYXN0IG9wZW4vc2F2ZS9yZXZlcnQvXG4gICAgICAvLyByZWxvYWQ7IGEgZGlmZmVyZW50IGhhc2ggbm93IGlzIGFuIG91dHNpZGUgY2hhbmdlLCBtYXJrZWQgZXhhY3RseSBhcyBhXG4gICAgICAvLyBsaXZlIG9uZSB3aXRoIGEgZGlydHkgYnVmZmVyIGlzIOKAlCBhc2tlZCwgbmV2ZXIgbWVyZ2VkIG9yIHJlbG9hZGVkLlxuICAgICAgbGV0IG5vdzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBub3cgPSBjb250ZW50SGFzaChyZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBub3cgPSBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKG5vdyA9PT0gbnVsbCB8fCBub3cgIT09IGQub3JpZ2luYWxIYXNoKSB7XG4gICAgICAgIGQub3V0c2lkZUNoYW5nZWQgPSB0cnVlO1xuICAgICAgICBzLnJlc3RvcmVGaW5kaW5ncy5wdXNoKHsgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsLCBtaXNzaW5nOiBub3cgPT09IG51bGwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChzLnJlc3RvcmVGaW5kaW5ncy5sZW5ndGggPiAwKSBzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gcztcbiAgfVxuXG4gIHN0YXRpYyBsaXN0U2F2ZWQoaG9tZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhZGRpclN5bmMoam9pbihob21lLCBcInNlc3Npb25zXCIpKS5maWx0ZXIoKGlkKSA9PlxuICAgICAgICBleGlzdHNTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBpZCwgXCJtYW5pZmVzdC5qc29uXCIpKSxcbiAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICB9XG5cbiAgZ2V0IGlkKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS5zZXNzaW9uSWQ7XG4gIH1cblxuICBnZXQgZG9jc0RpcigpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKHRoaXMuZGlyLCBcImRvY3NcIik7XG4gIH1cblxuICBnZXQgb3BlbkRvY1NsdWcoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubS5vcGVuRG9jO1xuICB9XG5cbiAgZ2V0IGNvbnRleHQoKTogcmVhZG9ubHkgQ29udGV4dEVudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLm0uY29udGV4dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBFdmVyeSBkaXJlY3RvcnkgdGhlIHdhdGNoZXIgbXVzdCBzZWU6IHRoZSBzZXNzaW9uJ3MgZG9jcywgZWFjaCBlbnRyeSByb290LFxuICAgKiBhbmQgdGhlIFJFQUwgZGlyZWN0b3J5IG9mIGV2ZXJ5IG9wZW5lZCBvcmlnaW5hbC5cbiAgICpcbiAgICog4puUIFZFUklGWS1QQVNTIEZJWCAzOiBlYWNoIHJvb3QgaXMgd2F0Y2hlZCBhdCBpdHMgUkVBTFBBVEggKGB3YXRjaGApLCBhbmRcbiAgICogYW4gZXZlbnQgaXMgcmVwb3J0ZWQgdW5kZXIgdGhlIHBhdGggZm9ybSB0aGUgc2Vzc2lvbiBzdG9yZXMgKGBwYXRoYCkuIEFcbiAgICogd2F0Y2ggb24gYSBzeW1saW5rZWQgZGlyZWN0b3J5IOKAlCBhIHN5bWxpbmtlZCBob21lLCBhIHN5bWxpbmtlZCBmb2xkZXJcbiAgICogZW50cnkg4oCUIG9yIG9uIHRoZSBsaW5rJ3Mgb3duIGRpcmVjdG9yeSBmb3IgYSBzeW1saW5rZWQgb3JpZ2luYWwgc2F3XG4gICAqIG5vdGhpbmcgd2hlbiB0aGUgVEFSR0VUIGNoYW5nZWQgKEZTRXZlbnRzIHJlcG9ydHMgcmVhbCBwYXRocykuIEEgc3ltbGlua2VkXG4gICAqIG9yaWdpbmFsIGlzIG1hdGNoZWQgYmFjayB0byBpdHMgZG9jIGJ5IHJlYWxwYXRoIGluIGBvbkZpbGVFdmVudGAuXG4gICAqL1xuICB3YXRjaFJvb3RzKCk6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdIHtcbiAgICBjb25zdCByb290czogeyBwYXRoOiBzdHJpbmc7IHdhdGNoOiBzdHJpbmc7IHJlY3Vyc2l2ZTogYm9vbGVhbjsgZW50cnlJZD86IHN0cmluZyB9W10gPSBbXG4gICAgICB7IHBhdGg6IHRoaXMuZG9jc0Rpciwgd2F0Y2g6IHJlYWxPcih0aGlzLmRvY3NEaXIpLCByZWN1cnNpdmU6IHRydWUgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dClcbiAgICAgIHJvb3RzLnB1c2goe1xuICAgICAgICBwYXRoOiBlLnJvb3QsXG4gICAgICAgIHdhdGNoOiByZWFsT3IoZS5yb290KSxcbiAgICAgICAgcmVjdXJzaXZlOiBlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIixcbiAgICAgICAgZW50cnlJZDogZS5pZCxcbiAgICAgIH0pO1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3QgcmVhbERpciA9IGRpcm5hbWUocmVhbE9yKGQub3JpZ2luYWwpKTtcbiAgICAgIGlmIChcbiAgICAgICAgIXJvb3RzLnNvbWUoKHIpID0+IHIud2F0Y2ggPT09IHJlYWxEaXIgJiYgci5yZWN1cnNpdmUgPT09IGZhbHNlKSAmJlxuICAgICAgICAhcm9vdHMuc29tZShcbiAgICAgICAgICAocikgPT4gci5yZWN1cnNpdmUgJiYgKHJlYWxEaXIgPT09IHIud2F0Y2ggfHwgcmVhbERpci5zdGFydHNXaXRoKHIud2F0Y2ggKyBzZXApKSxcbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgICByb290cy5wdXNoKHsgcGF0aDogcmVhbERpciwgd2F0Y2g6IHJlYWxEaXIsIHJlY3Vyc2l2ZTogZmFsc2UgfSk7XG4gICAgfVxuICAgIHJldHVybiByb290cztcbiAgfVxuXG4gIC8vIOKUgOKUgCBwZXJzaXN0ZW5jZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwZXJzaXN0KCk6IHZvaWQge1xuICAgIG1rZGlyU3luYyh0aGlzLmRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGpvaW4odGhpcy5kaXIsIFwibWFuaWZlc3QuanNvblwiKSwgYCR7SlNPTi5zdHJpbmdpZnkodGhpcy5tLCBudWxsLCAyKX1cXG5gKTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVPd25lZChwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBSZW1lbWJlciBCRUZPUkUgd3JpdGluZzogdGhlIHdhdGNoZXIncyBldmVudCBjYW4gYXJyaXZlIGJlZm9yZSB0aGlzXG4gICAgLy8gZnVuY3Rpb24gcmV0dXJucywgYW5kIGl0IG11c3QgZmluZCB0aGUgaGFzaCBhbHJlYWR5IHRoZXJlLlxuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBhZG9wdEFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHAgPSB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICB0aGlzLm93bmVkLnNldChwLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSB3cml0ZUFjdGl2ZShkOiBEb2NSZWNvcmQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSwgdGV4dCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICB9XG5cbiAgLyoqIEtlZXAgYW4gb3V0c2lkZSB3cml0ZSB0byB0aGUgYWN0aXZlIHZlcnNpb24gYXMgYSBORVcgYWdlbnQgdmVyc2lvbi4gKi9cbiAgcHJpdmF0ZSBwcmVzZXJ2ZU91dHNpZGUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiBWZXJzaW9uIHtcbiAgICBjb25zdCBuID0gTWF0aC5tYXgoLi4uZC52ZXJzaW9ucy5tYXAoKHYpID0+IHYubikpICsgMTtcbiAgICBjb25zdCByZWM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+ID0ge1xuICAgICAgbixcbiAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgZnJvbTogZC5hY3RpdmUsXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICBsYWJlbDogYG91dHNpZGUgd3JpdGUgdG8gdiR7ZC5hY3RpdmV9YCxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbikgfTtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmZiBgdGV4dGAgYXQgYHBhdGhgIGlzIGV4YWN0bHkgd2hhdCB0aGUgZGFlbW9uIGxhc3Qgd3JvdGUgdGhlcmUuICovXG4gIGlzT3duV3JpdGUocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5vd25lZC5nZXQocGF0aCkgPT09IGNvbnRlbnRIYXNoKHRleHQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIGNvbnRleHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkQ29udGV4dChyYXdQYXRoOiBzdHJpbmcpOiB7IGVudHJ5OiBDb250ZXh0RW50cnk7IGFkZGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgY29uc3QgcHJvYmUgPSBlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCk7XG4gICAgY29uc3Qgc2FtZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5yb290ID09PSBwcm9iZS5yb290ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gcHJvYmUubWVtYmVyc2hpcCAmJlxuICAgICAgICAocHJvYmUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiIHx8XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgPT09IEpTT04uc3RyaW5naWZ5KHByb2JlLm5vZGVzKSksXG4gICAgKTtcbiAgICBpZiAoc2FtZSkgcmV0dXJuIHsgZW50cnk6IHNhbWUsIGFkZGVkOiBmYWxzZSB9O1xuICAgIHRoaXMubS5jb250ZXh0LnB1c2gocHJvYmUpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgZW50cnk6IHByb2JlLCBhZGRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgcmVtb3ZlQ29udGV4dChpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaSA9IHRoaXMubS5jb250ZXh0LmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICAgIGlmIChpIDwgMClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7aWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKGUpID0+IGUuaWQpLFxuICAgICAgKTtcbiAgICB0aGlzLm0uY29udGV4dC5zcGxpY2UoaSwgMSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIG9wZW4gZG9jdW1lbnQgbGVmdCB0aGUgY29udGV4dCAoaXRzIGVudHJ5IHJlbW92ZWQsIG9yIHRoZSBkb2N1bWVudFxuICAgKiBoaWRkZW4pOiBjbG9zZSBpdCBpbiB0aGUgdmlldy4gSXRzIHZlcnNpb25zIHN0YXkgaW4gdGhlIHNlc3Npb24g4oCUIG5vdGhpbmdcbiAgICogaXMgZGVsZXRlZCDigJQgYW5kIGJyaW5naW5nIGl0IGJhY2sgYW5kIG9wZW5pbmcgaXQgYWdhaW4gZmluZHMgdGhlbS5cbiAgICovXG4gIHByaXZhdGUgY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTogdm9pZCB7XG4gICAgY29uc3Qgb3BlbiA9IHRoaXMubS5vcGVuRG9jID8gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5zbHVnID09PSB0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgaWYgKG9wZW4gJiYgb3Blbi5lbnRyeUlkID09PSBudWxsKSB0aGlzLm0ub3BlbkRvYyA9IG51bGw7XG4gIH1cblxuICAvKiogUmUtbWlycm9yIGEgZm9sZGVyIGVudHJ5LiBSZXR1cm5zIHdoZXRoZXIgaXRzIG5vZGVzIGNoYW5nZWQuICovXG4gIHJlc2NhbihlbnRyeUlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBjb25zdCBlID0gdGhpcy5tLmNvbnRleHQuZmluZCgoeCkgPT4geC5pZCA9PT0gZW50cnlJZCk7XG4gICAgaWYgKGU/Lm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoZS5yb290LCBNSVJST1JfTk9ERV9DQVAsIGUuaGlkZGVuKTtcbiAgICBjb25zdCBjaGFuZ2VkID1cbiAgICAgIEpTT04uc3RyaW5naWZ5KG5vZGVzKSAhPT0gSlNPTi5zdHJpbmdpZnkoZS5ub2RlcykgfHwgISF0cnVuY2F0ZWQgIT09ICEhZS50cnVuY2F0ZWQ7XG4gICAgZS5ub2RlcyA9IG5vZGVzO1xuICAgIGlmICh0cnVuY2F0ZWQpIGUudHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICBlbHNlIGRlbGV0ZSBlLnRydW5jYXRlZDtcbiAgICBpZiAoY2hhbmdlZCkgdGhpcy5yZWxpbmsoKTtcbiAgICByZXR1cm4gY2hhbmdlZDtcbiAgfVxuXG4gIHByaXZhdGUgcmVsaW5rKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgZCBvZiB0aGlzLm0uZG9jcykge1xuICAgICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGQub3JpZ2luYWwpO1xuICAgICAgZC5lbnRyeUlkID0gYXQ/LmVudHJ5SWQgPz8gbnVsbDtcbiAgICAgIGQucmVsID0gYXQ/LnJlbCA/PyBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBkb2N1bWVudHMgYW5kIHZlcnNpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIHByaXZhdGUgdmVyc2lvblBhdGgoZDogRG9jUmVjb3JkLCBuOiBudW1iZXIpOiBzdHJpbmcge1xuICAgIHJldHVybiBqb2luKHRoaXMuZG9jc0RpciwgZC5zbHVnLCBgdiR7bn0ke2QuZXh0fWApO1xuICB9XG5cbiAgcHJpdmF0ZSBkb2NPckRpZShzbHVnPzogc3RyaW5nKTogRG9jUmVjb3JkIHtcbiAgICBjb25zdCB3YW50ID0gc2x1ZyA/PyB0aGlzLm0ub3BlbkRvYyA/PyB1bmRlZmluZWQ7XG4gICAgY29uc3QgY2hvaWNlcyA9IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gZC5zbHVnKTtcbiAgICBpZiAod2FudCA9PT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcIm5vIGRvY3VtZW50IGlzIG9wZW4g4oCUIG5hbWUgb25lIHdpdGggLS1kb2NcIiwgNDA5LCBjaG9pY2VzKTtcbiAgICBjb25zdCBkID0gdGhpcy5maW5kRG9jKHdhbnQpO1xuICAgIGlmICghZCkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gZG9jdW1lbnQgXCIke3dhbnR9XCIgaW4gdGhpcyBzZXNzaW9uYCwgNDA0LCBjaG9pY2VzKTtcbiAgICByZXR1cm4gZDtcbiAgfVxuXG4gIC8qKiBBIGRvYyBieSBzbHVnLCBieSBvcmlnaW5hbCBwYXRoLCBvciBieSBhIHVuaXF1ZSBvcmlnaW5hbCBiYXNlbmFtZS4gKi9cbiAgZmluZERvYyhrZXk6IHN0cmluZyk6IERvY1JlY29yZCB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgYnlTbHVnID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5zbHVnID09PSBrZXkpO1xuICAgIGlmIChieVNsdWcpIHJldHVybiBieVNsdWc7XG4gICAgLy8g4puUIE9OTFkgQU4gQUJTT0xVVEUga2V5IGlzIGEgcGF0aCAodmVyaWZ5LXBhc3MgZml4IDgpOiByZXNvbHZpbmcgYVxuICAgIC8vIHJlbGF0aXZlIG9uZSBoZXJlIHJlc29sdmVkIGl0IGFnYWluc3QgdGhlIERBRU1PTidzIGN3ZC4gVGhlIENMSSByZXNvbHZlc1xuICAgIC8vIGFnYWluc3QgaXRzIG93biBjd2QgYW5kIHNlbmRzIGFuIGFic29sdXRlIHBhdGguXG4gICAgaWYgKGlzQWJzb2x1dGUoa2V5KSkge1xuICAgICAgY29uc3QgYnlQYXRoID0gdGhpcy5tLmRvY3MuZmluZChcbiAgICAgICAgKGQpID0+IGQub3JpZ2luYWwgPT09IGtleSB8fCByZWFsT3IoZC5vcmlnaW5hbCkgPT09IHJlYWxPcihrZXkpLFxuICAgICAgKTtcbiAgICAgIGlmIChieVBhdGgpIHJldHVybiBieVBhdGg7XG4gICAgfVxuICAgIGNvbnN0IGJ5TmFtZSA9IHRoaXMubS5kb2NzLmZpbHRlcigoZCkgPT4gYmFzZW5hbWUoZC5vcmlnaW5hbCkgPT09IGtleSB8fCBkLnJlbCA9PT0ga2V5KTtcbiAgICByZXR1cm4gYnlOYW1lLmxlbmd0aCA9PT0gMSA/IGJ5TmFtZVswXSA6IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHByaXZhdGUgdmVyc2lvbk9yRGllKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4ge1xuICAgIGNvbnN0IHYgPSBkLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubiA9PT0gbik7XG4gICAgaWYgKCF2KVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZC5zbHVnfSBoYXMgbm8gdiR7bn1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIGQudmVyc2lvbnMubWFwKCh4KSA9PiBgdiR7eC5ufWApLFxuICAgICAgKTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHByaXZhdGUgc2x1Z0ZvcihvcmlnaW5hbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzdGVtID1cbiAgICAgIGJhc2VuYW1lKG9yaWdpbmFsLCBleHRuYW1lKG9yaWdpbmFsKSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05Xy1dKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIikgfHwgXCJkb2NcIjtcbiAgICBsZXQgc2x1ZyA9IHN0ZW07XG4gICAgZm9yIChsZXQgaSA9IDI7IHRoaXMubS5kb2NzLnNvbWUoKGQpID0+IGQuc2x1ZyA9PT0gc2x1Zyk7IGkrKykgc2x1ZyA9IGAke3N0ZW19LSR7aX1gO1xuICAgIHJldHVybiBzbHVnO1xuICB9XG5cbiAgLyoqXG4gICAqIE9wZW4gYSBkb2N1bWVudCBieSBpdHMgb3JpZ2luYWwncyBwYXRoOiB2MSBpcyB3cml0dGVuIGZyb20gdGhlIG9yaWdpbmFsXG4gICAqIHRoZSBmaXJzdCB0aW1lLiBgZm9jdXM6IGZhbHNlYCAodGhlIGFnZW50J3MgaW1wbGljaXQgb3BlbiB0aHJvdWdoXG4gICAqIGB2ZXJzaW9uLW5ldyAtLWRvYyA8cGF0aD5gKSBkb2VzIG5vdCBtb3ZlIHRoZSBodW1hbidzIG9wZW4gZG9jdW1lbnQuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMWIg4oCUIEFETUlTU0lPTi4gT25seSBhIGRvYy10eXBlIGZpbGUgSU5TSURFIGEgY29udGV4dFxuICAgKiBlbnRyeSBpcyBhZG1pdHRlZDsgYGNvbnRleHQuYWRkYCBzdGF5cyB0aGUgb25lIHdheSBpbi4gQmVmb3JlIHRoaXMsIGFueVxuICAgKiBwYXRoIG9mIGFueSB0eXBlIHdhcyBvcGVuZWQsIGFuZCBTYXZlIHRoZW4gd3JvdGUgaXQ6IGEgZm9yZWlnbiB3ZWIgcGFnZVxuICAgKiB3cm90ZSBgY3VybCBldmlsIHwgc2hgIGludG8gYSBgLnJjYCBmaWxlIG91dHNpZGUgdGhlIGNvbnRleHQuXG4gICAqL1xuICBvcGVuUGF0aChyYXdQYXRoOiBzdHJpbmcsIG9wdHM6IHsgZm9jdXM/OiBib29sZWFuIH0gPSB7fSk6IHsgc2x1Zzogc3RyaW5nOyBjcmVhdGVkOiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGZvY3VzID0gb3B0cy5mb2N1cyA/PyB0cnVlO1xuICAgIC8vIFRoZSBjb250ZXh0J3Mgb3duIHNwZWxsaW5nIG9mIHRoZSBwYXRoOiBhIGNhbGxlciB3aG9zZSBjd2QgaXMgYSByZWFscGF0aFxuICAgIC8vICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgb3IgdGhyb3VnaCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAgLy8gZmlsZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBkb2MuXG4gICAgY29uc3QgYWJzID0gdGhpcy5jYW5vbmljYWwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLm0uZG9jcy5maW5kKChkKSA9PiBkLm9yaWdpbmFsID09PSBhYnMpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgaWYgKGZvY3VzKSB0aGlzLm0ub3BlbkRvYyA9IGV4aXN0aW5nLnNsdWc7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IHNsdWc6IGV4aXN0aW5nLnNsdWcsIGNyZWF0ZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmICghaXNEb2NOYW1lKGFicykpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCA0MDApO1xuICAgIGlmICghbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7YWJzfSBpcyBub3QgaW4gdGhpcyBzZXNzaW9uJ3MgY29udGV4dCDigJQgYWRkIGl0IChvciBpdHMgZm9sZGVyKSBmaXJzdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgaWYgKCFzdGF0U3luYyhhYnMpLmlzRmlsZSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSBmaWxlXCIpO1xuICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBvcGVuICR7YWJzfTogbm8gc3VjaCBmaWxlYCwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgZXh0ID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0uaW5jbHVkZXMoZXh0bmFtZShhYnMpLnRvTG93ZXJDYXNlKCkpXG4gICAgICA/IGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpXG4gICAgICA6IFwiLm1kXCI7XG4gICAgY29uc3QgYXQgPSBsb2NhdGUodGhpcy5tLmNvbnRleHQsIGFicyk7XG4gICAgY29uc3QgZDogRG9jUmVjb3JkID0ge1xuICAgICAgc2x1ZzogdGhpcy5zbHVnRm9yKGFicyksXG4gICAgICBuYW1lOiBiYXNlbmFtZShhYnMpLFxuICAgICAgb3JpZ2luYWw6IGFicyxcbiAgICAgIGVudHJ5SWQ6IGF0Py5lbnRyeUlkID8/IG51bGwsXG4gICAgICByZWw6IGF0Py5yZWwgPz8gbnVsbCxcbiAgICAgIGV4dCxcbiAgICAgIHZlcnNpb25zOiBbeyBuOiAxLCBhdXRob3I6IFwiaHVtYW5cIiwgY3JlYXRlZEF0OiBEYXRlLm5vdygpIH1dLFxuICAgICAgYWN0aXZlOiAxLFxuICAgICAgb3JpZ2luYWxIYXNoOiBjb250ZW50SGFzaCh0ZXh0KSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGFkbWl0dGVkOiB0cnVlLFxuICAgIH07XG4gICAgdGhpcy5tLmRvY3MucHVzaChkKTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBkLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBjcmVhdGVkOiB0cnVlIH07XG4gIH1cblxuICAvKiogYGFic2AgYXMgdGhlIGNvbnRleHQgc3BlbGxzIGl0LCB3aGVuIGl0IGlzIHRoZSBzYW1lIGZpbGUgYnkgcmVhbHBhdGguICovXG4gIHByaXZhdGUgY2Fub25pY2FsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAobG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAoIXJlYWwuc3RhcnRzV2l0aChyZWFsUm9vdCArIHNlcCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3BlbGxlZCA9IGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgc3BlbGxlZCkpIHJldHVybiBzcGVsbGVkO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgb3BlblNsdWcoc2x1Zzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5tLm9wZW5Eb2MgPSB0aGlzLmRvY09yRGllKHNsdWcpLnNsdWc7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gIH1cblxuICByZWFkVmVyc2lvbihzbHVnOiBzdHJpbmcsIG46IG51bWJlcik6IHsgdGV4dDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgbik7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgcmV0dXJuIHsgdGV4dDogcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSwgcGF0aCB9O1xuICB9XG5cbiAgYWN0aXZlUGF0aChzbHVnPzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgZCA9IHNsdWcgPyB0aGlzLmZpbmREb2Moc2x1ZykgOiB0aGlzLm0ub3BlbkRvYyA/IHRoaXMuZmluZERvYyh0aGlzLm0ub3BlbkRvYykgOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIGQgPyB0aGlzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKSA6IG51bGw7XG4gIH1cblxuICAvKiogVGhlIGh1bWFuJ3MgYnVmZmVyIHJlYWNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uJ3MgZmlsZSAoZGVib3VuY2VkIGJ5IHRoZSBzdXJmYWNlKS4gKi9cbiAgLyoqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggNCDigJQgQ0hFQ0sgQkVGT1JFIFdSSVRFLiBCZWZvcmUgdGhlIGh1bWFuJ3MgZWRpdCBpc1xuICAgKiB3cml0dGVuLCB0aGUgZmlsZSBvbiBkaXNrIGlzIGhhc2hlZDogaWYgaXQgaXMgbm90IHRoZSBkYWVtb24ncyBvd24gbGFzdFxuICAgKiB3cml0ZSwgc29tZW9uZSBlbHNlIHdyb3RlIHRoZSBhY3RpdmUgdmVyc2lvbiAoRTIpLiBUaGF0IHRleHQgaXMga2VwdCBhcyBhXG4gICAqIE5FVyBhZ2VudCB2ZXJzaW9uLCBhbmQgb25seSB0aGVuIGlzIHRoZSBlZGl0IHdyaXR0ZW4uIERldGVjdGlvbiB1c2VkIHRvXG4gICAqIGRlcGVuZCBvbiB0aGUgd2F0Y2hlcidzIDYwIG1zIHNldHRsZSB0aW1lciBmaXJpbmcgYmVmb3JlIHRoZSBuZXh0XG4gICAqIGtleXN0cm9rZTsgYSBidXJzdCBvZiBlZGl0cyBhdCAzMCBtcyBjbG9iYmVyZWQgYW4gb3V0c2lkZSB3cml0ZVxuICAgKiB1bmFubm91bmNlZC4gTm93IG5vdGhpbmcgaXMgbG9zdCB3aGF0ZXZlciB0aGUgdGltaW5nIOKAlCB0aGUgb25lIHdpbmRvdyBsZWZ0XG4gICAqIGlzIHRoZSBtaWNyb3NlY29uZHMgYmV0d2VlbiB0aGlzIHJlYWQgYW5kIHRoaXMgd3JpdGUuXG4gICAqL1xuICBlZGl0KFxuICAgIHNsdWc6IHN0cmluZyxcbiAgICBuOiBudW1iZXIsXG4gICAgdGV4dDogc3RyaW5nLFxuICApOiB7IGRpcnR5Q2hhbmdlZDogYm9vbGVhbjsgcHJlc2VydmVkOiBWZXJzaW9uIHwgbnVsbCB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBpZiAobiAhPT0gZC5hY3RpdmUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgdiR7bn0gaXMgbm90IHRoZSBhY3RpdmUgdmVyc2lvbiBvZiAke2Quc2x1Z30gKHYke2QuYWN0aXZlfSBpcykg4oCUIG9ubHkgdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIGVkaXRhYmxlYCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCBiZWZvcmUgPSB0aGlzLmlzRGlydHkoZCk7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMudmVyc2lvblBhdGgoZCwgbik7XG4gICAgLy8gVGhlIGVkaXQgaXMgc3RhZ2VkIGluIGEgc2libGluZyBmaWxlIEZJUlNULCBzbyB0aGUgY2hlY2sgYmVsb3cgYW5kIHRoZVxuICAgIC8vIHJlbmFtZSB0aGF0IGxhbmRzIHRoZSBlZGl0IGFyZSBhZGphY2VudCBzeXNjYWxsczogdGhlIHdpbmRvdyBpbiB3aGljaCBhblxuICAgIC8vIG91dHNpZGUgd3JpdGUgY291bGQgc2xpcCBiZXR3ZWVuIHRoZW0gaXMgbWljcm9zZWNvbmRzLCBub3QgdGhlIGxlbmd0aCBvZlxuICAgIC8vIGEgbXVsdGktbWVnYWJ5dGUgd3JpdGUg4oCUIGFuZCBhIHdyaXRlIGxhbmRpbmcgQUZURVIgdGhlIHJlbmFtZSBnb2VzIHRvIHRoZVxuICAgIC8vIG5ldyBmaWxlLCB3aGVyZSB0aGUgd2F0Y2hlciBmaW5kcyBpdCBhbmQgcHJlc2VydmVzIGl0IHRvby5cbiAgICBjb25zdCBzdGFnZWQgPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS5lZGl0YDtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YWdlZCwgdGV4dCk7XG4gICAgbGV0IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgPSBudWxsO1xuICAgIGxldCBvbkRpc2s6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBvbkRpc2sgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgb25EaXNrID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKG9uRGlzayAhPT0gbnVsbCAmJiAhdGhpcy5pc093bldyaXRlKHBhdGgsIG9uRGlzaykpXG4gICAgICBwcmVzZXJ2ZWQgPSB0aGlzLnByZXNlcnZlT3V0c2lkZShkLCBvbkRpc2spO1xuICAgIHRoaXMub3duZWQuc2V0KHBhdGgsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICByZW5hbWVTeW5jKHN0YWdlZCwgcGF0aCk7XG4gICAgdGhpcy5hY3RpdmVIYXNoLnNldChkLnNsdWcsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICB0aGlzLmxhc3RBY3RpdmVUZXh0LnNldChkLnNsdWcsIHRleHQpO1xuICAgIHJldHVybiB7IGRpcnR5Q2hhbmdlZDogYmVmb3JlICE9PSB0aGlzLmlzRGlydHkoZCksIHByZXNlcnZlZCB9O1xuICB9XG5cbiAgLyoqIENvcHkgYSB2ZXJzaW9uIHRvIGEgbmV3IGZpbGU7IHRoZSBhZ2VudCB0aGVuIGVkaXRzIHRoYXQgZmlsZSB3aXRoIGl0cyBvd24gdG9vbHMuICovXG4gIG5ld1ZlcnNpb24ob3B0czogeyBkb2M/OiBzdHJpbmc7IGZyb20/OiBudW1iZXI7IGxhYmVsPzogc3RyaW5nOyBhdXRob3I6IFZlcnNpb25BdXRob3IgfSk6IHtcbiAgICBzbHVnOiBzdHJpbmc7XG4gICAgdmVyc2lvbjogVmVyc2lvbjtcbiAgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIGNvbnN0IGZyb20gPSBvcHRzLmZyb20gPz8gZC5hY3RpdmU7XG4gICAgdGhpcy52ZXJzaW9uT3JEaWUoZCwgZnJvbSk7XG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyh0aGlzLnZlcnNpb25QYXRoKGQsIGZyb20pLCBcInV0ZjhcIik7XG4gICAgY29uc3QgbiA9IE1hdGgubWF4KC4uLmQudmVyc2lvbnMubWFwKCh2KSA9PiB2Lm4pKSArIDE7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IG9wdHMuYXV0aG9yLFxuICAgICAgZnJvbSxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIC4uLihvcHRzLmxhYmVsID8geyBsYWJlbDogb3B0cy5sYWJlbCB9IDoge30pLFxuICAgIH07XG4gICAgZC52ZXJzaW9ucy5wdXNoKHJlYyk7XG4gICAgdGhpcy53cml0ZU93bmVkKHRoaXMudmVyc2lvblBhdGgoZCwgbiksIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgdmVyc2lvbjogeyAuLi5yZWMsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgbikgfSB9O1xuICB9XG5cbiAgYWN0aXZhdGUob3B0czogeyBkb2M/OiBzdHJpbmc7IHZlcnNpb246IG51bWJlciB9KTogeyBzbHVnOiBzdHJpbmc7IHByZXZpb3VzOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUob3B0cy5kb2MpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG9wdHMudmVyc2lvbik7XG4gICAgY29uc3QgcHJldmlvdXMgPSBkLmFjdGl2ZTtcbiAgICBkLmFjdGl2ZSA9IG9wdHMudmVyc2lvbjtcbiAgICAvLyBUaGUgbmV3IGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBBUyBJVCBJUyBOT1cgaXMgdGhlIGJhc2VsaW5lIHRoZSBuZXh0XG4gICAgLy8gY2hlY2stYmVmb3JlLXdyaXRlIGNvbXBhcmVzIGFnYWluc3QuXG4gICAgdGhpcy5hZG9wdEFjdGl2ZShkLCByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKSk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgc2x1ZzogZC5zbHVnLCBwcmV2aW91cyB9O1xuICB9XG5cbiAgLyoqIFNhdmU6IHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgb3ZlciB0aGUgb3JpZ2luYWwuIFRoZSBPTkxZIHdyaXRlIHRvIGl0IChFNykuICovXG4gIHNhdmUoc2x1Zzogc3RyaW5nKTogeyBvcmlnaW5hbDogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAxYzogU2F2ZSB3cml0ZXMgb25seSBhbiBvcmlnaW5hbCBhZG1pdHRlZCBieVxuICAgIC8vIGBvcGVuUGF0aGAgKGEgZG9jLXR5cGUgZmlsZSBpbnNpZGUgYSBjb250ZXh0IGVudHJ5KS4gQ2hlY2tlZCBhZ2FpbiBoZXJlXG4gICAgLy8gc28gbm8gb3RoZXIgcGF0aCBpbnRvIHRoZSBtYW5pZmVzdCDigJQgYSBoYW5kLWVkaXRlZCBvbmUsIGEgZnV0dXJlIHZlcmIg4oCUXG4gICAgLy8gY2FuIHR1cm4gU2F2ZSBpbnRvIFwid3JpdGUgYW55IGZpbGVcIi5cbiAgICBpZiAoIWQuYWRtaXR0ZWQgfHwgIWlzRG9jTmFtZShkLm9yaWdpbmFsKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyB0byBzYXZlICR7ZC5vcmlnaW5hbH06IGl0IHdhcyBub3Qgb3BlbmVkIGZyb20gdGhlIGNvbnRleHRgLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIFwidXRmOFwiKTtcbiAgICB0aGlzLndyaXRlT3duZWQoZC5vcmlnaW5hbCwgdGV4dCk7XG4gICAgZC5vcmlnaW5hbEhhc2ggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICBkLm91dHNpZGVDaGFuZ2VkID0gZmFsc2U7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgb3JpZ2luYWw6IGQub3JpZ2luYWwsIHZlcnNpb246IGQuYWN0aXZlIH07XG4gIH1cblxuICAvKiogUmV2ZXJ0OiB0aGUgb3JpZ2luYWwncyB0ZXh0IGJhY2sgb3ZlciB0aGUgYWN0aXZlIHZlcnNpb24uICovXG4gIHJldmVydChzbHVnOiBzdHJpbmcpOiB7IHZlcnNpb246IG51bWJlcjsgdGV4dDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoZC5vcmlnaW5hbCwgXCJ1dGY4XCIpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogZC5hY3RpdmUsIHRleHQgfTtcbiAgfVxuXG4gIHByaXZhdGUgaXNEaXJ0eShkOiBEb2NSZWNvcmQpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYWN0aXZlSGFzaC5nZXQoZC5zbHVnKSA/PyBcIlwiKSAhPT0gZC5vcmlnaW5hbEhhc2g7XG4gIH1cblxuICAvLyDilIDilIAgdGhlIHdhdGNoZXIncyBxdWVzdGlvbjogd2hvc2Ugd3JpdGUgd2FzIHRoYXQ/IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBDbGFzc2lmeSBvbmUgZmlsZXN5c3RlbSBldmVudC4gUmVhZHMgdGhlIGZpbGU7IHJldHVybnMgYG51bGxgIHdoZW4gaXQgaXNcbiAgICogdGhlIGRhZW1vbidzIG93biB3cml0ZSwgdW5jaGFuZ2VkLCBnb25lLCBvciBub3Qgb3VycyB0byBjYXJlIGFib3V0LlxuICAgKi9cbiAgb25GaWxlRXZlbnQoYWJzOiBzdHJpbmcpOiBGaWxlRXZlbnQgfCBudWxsIHtcbiAgICAvLyBBIHZlcnNpb24gZmlsZSB1bmRlciBkb2NzLzxzbHVnPi92Ti5leHQ/XG4gICAgaWYgKGFicy5zdGFydHNXaXRoKHRoaXMuZG9jc0RpciArIHNlcCkpIHtcbiAgICAgIGNvbnN0IHJlc3QgPSBhYnMuc2xpY2UodGhpcy5kb2NzRGlyLmxlbmd0aCArIDEpLnNwbGl0KHNlcCk7XG4gICAgICBpZiAocmVzdC5sZW5ndGggIT09IDIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgW3NsdWcsIGZpbGVdID0gcmVzdCBhcyBbc3RyaW5nLCBzdHJpbmddO1xuICAgICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHguc2x1ZyA9PT0gc2x1Zyk7XG4gICAgICBjb25zdCBtYXRjaCA9IC9edihcXGQrKShcXC5bYS16XSspJC8uZXhlYyhmaWxlKTtcbiAgICAgIGlmICghZCB8fCAhbWF0Y2ggfHwgbWF0Y2hbMl0gIT09IGQuZXh0KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIobWF0Y2hbMV0pO1xuICAgICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICAgIHRyeSB7XG4gICAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5pc093bldyaXRlKGFicywgdGV4dCkpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFkLnZlcnNpb25zLnNvbWUoKHYpID0+IHYubiA9PT0gbikpIHtcbiAgICAgICAgLy8gVGhlIGFnZW50IHdyb3RlIGEgdmVyc2lvbiBmaWxlIGJ5IGhhbmQgcmF0aGVyIHRoYW4gdGhyb3VnaFxuICAgICAgICAvLyBgdmVyc2lvbi1uZXdgIOKAlCBhZG9wdCBpdCByYXRoZXIgdGhhbiBsZWF2ZSBhIGZpbGUgdGhlIHN1cmZhY2UgY2Fubm90IHNlZS5cbiAgICAgICAgZC52ZXJzaW9ucy5wdXNoKHsgbiwgYXV0aG9yOiBcImFnZW50XCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgZC52ZXJzaW9ucy5zb3J0KChhLCBiKSA9PiBhLm4gLSBiLm4pO1xuICAgICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCBwYXRoOiBhYnMgfTtcbiAgICAgIH1cbiAgICAgIGlmIChuID09PSBkLmFjdGl2ZSkge1xuICAgICAgICAvLyBFMiwgcmVmdXNlZCBhbmQgUkUtTEFCRUxMRUQ6IHRoZSBvdXRzaWRlIHRleHQgYmVjb21lcyBhIG5ldyBhZ2VudFxuICAgICAgICAvLyB2ZXJzaW9uLCBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uIGdvZXMgYmFjayB0byB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICAgICAgLy8gdGV4dCDigJQgc28gdGhlIGFjdGl2ZSB2ZXJzaW9uIG9ubHkgZXZlciBob2xkcyB3aGF0IHRoZSBodW1hbiB0eXBlZCxcbiAgICAgICAgLy8gYW5kIG5vdGhpbmcgYW55b25lIHdyb3RlIGlzIGxvc3QgKHZlcmlmeS1wYXNzIGZpeCA0LCB3YXRjaGVyIGhhbGYpLlxuICAgICAgICBjb25zdCBrZXB0ID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGhpcy5sYXN0QWN0aXZlVGV4dC5nZXQoZC5zbHVnKSA/PyB0ZXh0KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcImFjdGl2ZS5vdXRzaWRlXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogbixcbiAgICAgICAgICBwYXRoOiBhYnMsXG4gICAgICAgICAgcHJlc2VydmVkQXM6IGtlcHQubixcbiAgICAgICAgICBwcmVzZXJ2ZWRQYXRoOiBrZXB0LnBhdGgsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICB0aGlzLm93bmVkLnNldChhYnMsIGNvbnRlbnRIYXNoKHRleHQpKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwidmVyc2lvbi5jaGFuZ2VkXCIsIGRvYzogZC5zbHVnLCB2ZXJzaW9uOiBuLCB0ZXh0LCBhY3RpdmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgLy8gQW4gb3BlbmVkIG9yaWdpbmFsIOKAlCBieSBpdHMgc3RvcmVkIHBhdGgsIG9yIGJ5IHJlYWxwYXRoIGZvciBhIHN5bWxpbms/XG4gICAgY29uc3QgZCA9IHRoaXMubS5kb2NzLmZpbmQoKHgpID0+IHgub3JpZ2luYWwgPT09IGFicyB8fCByZWFsT3IoeC5vcmlnaW5hbCkgPT09IGFicyk7XG4gICAgaWYgKGQpIHtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgY29uc3QgaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgICAgaWYgKGggPT09IGQub3JpZ2luYWxIYXNoKSByZXR1cm4gbnVsbDsgLy8gb3VyIG93biBzYXZlLCBvciBubyBjaGFuZ2VcbiAgICAgIGNvbnN0IGNsZWFuID0gIXRoaXMuaXNEaXJ0eShkKTtcbiAgICAgIGlmIChjbGVhbikge1xuICAgICAgICBkLm9yaWdpbmFsSGFzaCA9IGg7XG4gICAgICAgIHRoaXMud3JpdGVBY3RpdmUoZCwgdGV4dCk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwib3JpZ2luYWwucmVsb2FkZWRcIixcbiAgICAgICAgICBkb2M6IGQuc2x1ZyxcbiAgICAgICAgICB2ZXJzaW9uOiBkLmFjdGl2ZSxcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGQub3V0c2lkZUNoYW5nZWQpIHJldHVybiBudWxsOyAvLyBhbHJlYWR5IGFza2VkXG4gICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgcmV0dXJuIHsga2luZDogXCJvcmlnaW5hbC5jb25mbGljdFwiLCBkb2M6IGQuc2x1Zywgb3JpZ2luYWw6IGQub3JpZ2luYWwgfTtcbiAgICB9XG5cbiAgICAvLyBTb21ldGhpbmcgdW5kZXIgYSBtaXJyb3JlZCByb290OiB0aGUgdHJlZSBtYXkgaGF2ZSBjaGFuZ2VkLlxuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZXNjYW4oZS5pZCkgPyB7IGtpbmQ6IFwidHJlZVwiLCBlbnRyeUlkOiBlLmlkIH0gOiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBzdHJ1Y3R1cmUgKEUyMuKAk0UyNCk6IHJlYWwgY2hhbmdlcyBvbiBkaXNrLCBvbmUgcGF0aCBmb3IgYm90aCBwYXJ0aWVzIOKUgOKUgFxuICAvL1xuICAvLyBFdmVyeSBtZXRob2QgYmVsb3cgZG9lcyB0aGUgY2hhbmdlIE9OIERJU0sgYW5kIHRoZW4gYnJpbmdzIHRoZSBjb250ZXh0XG4gIC8vIG1vZGVsIGJhY2sgaW4gbGluZSB3aXRoIGl0LiBUaGUgc3VyZmFjZSByZWFjaGVzIHRoZW0gdGhyb3VnaCBtZW51cyBhbmRcbiAgLy8gZHJhZyBhbmQgZHJvcCwgdGhlIGFnZW50IHRocm91Z2ggQ0xJIHZlcmJzOyB0aGUgZGFlbW9uIGFubm91bmNlcyBlYWNoIG9uZVxuICAvLyB1bmRlciB0aGUgbmFtZSBvZiB3aG9ldmVyIGRpZCBpdC4gVHdvIHJ1bGVzIGhvbGQgdGhyb3VnaG91dDpcbiAgLy9cbiAgLy8gLSBOT1RISU5HIElTIERFTEVURUQuIGBoaWRlYCB0YWtlcyBhIG5vZGUgb3V0IG9mIFNjcmlwdG9yaXVtOyB0aGUgZmlsZSBzdGF5cy5cbiAgLy8gLSBOT1RISU5HIElTIE9WRVJXUklUVEVOLiBBIGRlc3RpbmF0aW9uIHRoYXQgZXhpc3RzIGlzIHJlZnVzZWQgKGFuIGV4cGxpY2l0XG4gIC8vICAgbmFtZSkgb3IgZ2l2ZW4gYSBmcmVlIG5hbWUgKGEgZGVmYXVsdCBvbmUsIGEgZHJvcCk7IGZpbGVzIGFyZSBjcmVhdGVkXG4gIC8vICAgd2l0aCB0aGUgZXhjbHVzaXZlIGZsYWcsIHNvIGEgcmFjZSBjYW5ub3QgY2xvYmJlciBlaXRoZXIuXG5cbiAgLyoqIEUyMzogd2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQuICovXG4gIGdldCB3b3Jrc3BhY2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5tLndvcmtzcGFjZSA/PyBob21lZGlyKCk7XG4gIH1cblxuICBzZXRXb3Jrc3BhY2UocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgYWJzID0gcmVzb2x2ZShyYXdQYXRoKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBubyBzdWNoIGZvbGRlcjogJHthYnN9YCwgNDA0KTtcbiAgICB9XG4gICAgaWYgKCFpc0RpcikgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgdGhlIHdvcmtzcGFjZSBtdXN0IGJlIGEgZm9sZGVyOiAke2Fic31gLCA0MDApO1xuICAgIHRoaXMubS53b3Jrc3BhY2UgPSBhYnM7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvKipcbiAgICogSG93IGEgcGF0aCByZWFkcyBpbiBhIGNoYXQgbGluZTogYHNldC9yZWxgIGluc2lkZSBhIHNldCwgYSBzaW5nbGVcbiAgICogZG9jdW1lbnQncyBmaWxlIG5hbWUsIGB3b3Jrc3BhY2Uv4oCmYCBpbiB0aGUgd29ya3NwYWNlLCBlbHNlIGB+L+KApmAuXG4gICAqL1xuICBkaXNwbGF5KGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIikge1xuICAgICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBlLmxhYmVsO1xuICAgICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkgcmV0dXJuIGAke2UubGFiZWx9LyR7dG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpfWA7XG4gICAgICB9IGVsc2UgaWYgKGUubm9kZXMuc29tZSgobikgPT4gam9pbihlLnJvb3QsIG4ucmVsKSA9PT0gYWJzKSkgcmV0dXJuIGUubGFiZWw7XG4gICAgfVxuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLndvcmtzcGFjZSArIHNlcCkpXG4gICAgICByZXR1cm4gYHdvcmtzcGFjZS8ke3RvUG9zaXgocmVsYXRpdmUodGhpcy53b3Jrc3BhY2UsIGFicykpfWA7XG4gICAgY29uc3QgaG9tZSA9IGhvbWVkaXIoKTtcbiAgICByZXR1cm4gYWJzID09PSBob21lID8gXCJ+XCIgOiBhYnMuc3RhcnRzV2l0aChob21lICsgc2VwKSA/IGB+JHthYnMuc2xpY2UoaG9tZS5sZW5ndGgpfWAgOiBhYnM7XG4gIH1cblxuICAvKipcbiAgICogYGFic2Agc3BlbGxlZCB0aGUgd2F5IHRoZSBjb250ZXh0IHNwZWxscyBpdC4gQSBjYWxsZXIgd2hvc2UgY3dkIGlzIGFcbiAgICogcmVhbHBhdGggKC9wcml2YXRlL3Zhci/igKYgZm9yIC92YXIv4oCmLCBhIHN5bWxpbmtlZCBmb2xkZXIpIG5hbWVzIHRoZSBzYW1lXG4gICAqIHBsYWNlIGRpZmZlcmVudGx5LCBhbmQgaXQgbXVzdCBsYW5kIG9uIHRoZSBzYW1lIG5vZGUuXG4gICAqL1xuICBwcml2YXRlIHNwZWxsKGFiczogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5tLmNvbnRleHQuc29tZSgoZSkgPT4gYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHJldHVybiBhYnM7XG4gICAgY29uc3QgcmVhbCA9IHJlYWxPcihhYnMpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgY29uc3QgcmVhbFJvb3QgPSByZWFsT3IoZS5yb290KTtcbiAgICAgIGlmIChyZWFsID09PSByZWFsUm9vdCkgcmV0dXJuIGUucm9vdDtcbiAgICAgIGlmIChyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSByZXR1cm4gam9pbihlLnJvb3QsIHJlbGF0aXZlKHJlYWxSb290LCByZWFsKSk7XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cblxuICBwcml2YXRlIGlzV29ya3NwYWNlKGFiczogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGFicyA9PT0gdGhpcy53b3Jrc3BhY2UgfHwgcmVhbE9yKGFicykgPT09IHJlYWxPcih0aGlzLndvcmtzcGFjZSk7XG4gIH1cblxuICAvKiogVGhlIG1pcnJvcmVkIGVudHJ5IHRoYXQgY292ZXJzIGBhYnNgIChpdHMgcm9vdCwgb3IgYW55dGhpbmcgdW5kZXIgaXQpLCBpZiBhbnkuICovXG4gIHByaXZhdGUgY292ZXJpbmdFbnRyeShhYnM6IHN0cmluZywgZXhjZXB0Pzogc3RyaW5nKTogQ29udGV4dEVudHJ5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQuZmluZChcbiAgICAgIChlKSA9PlxuICAgICAgICBlLmlkICE9PSBleGNlcHQgJiZcbiAgICAgICAgZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIgJiZcbiAgICAgICAgKGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQSBmb2xkZXIgdGhpbmdzIG1heSBiZSBtYWRlIGluIG9yIG1vdmVkIGludG86IGEgbWlycm9yZWQgZW50cnkncyByb290LCBhXG4gICAqIHZpc2libGUgZm9sZGVyIHVuZGVyIG9uZSwgb3IgdGhlIHdvcmtzcGFjZS4gUmV0dXJucyB0aGUgYWJzb2x1dGUgZm9sZGVyO1xuICAgKiByZWZ1c2VzIGFueXRoaW5nIGVsc2Ug4oCUIHRoZSBjb250ZXh0IHN0YXlzIHRoZSB3YXkgaW4gKHZlcmlmeS1wYXNzIGZpeCAxYikuXG4gICAqL1xuICBwcml2YXRlIGRlc3RpbmF0aW9uT3JEaWUocmF3RGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdEaXIpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgIT09IFwibWlycm9yZWRcIikgY29udGludWU7XG4gICAgICBpZiAoYWJzID09PSBlLnJvb3QpIHJldHVybiBhYnM7XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGU/LmtpbmQgPT09IFwiZ3JvdXBcIikgcmV0dXJuIGFicztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMuaXNXb3Jrc3BhY2UoYWJzKSkgcmV0dXJuIHRoaXMud29ya3NwYWNlO1xuICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICBgJHthYnN9IGlzIG5vdCBhIGZvbGRlciBpbiB0aGlzIHNlc3Npb24g4oCUIG5hbWUgYSBzZXQsIGEgZm9sZGVyIGluc2lkZSBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UgKCR7dGhpcy53b3Jrc3BhY2V9KWAsXG4gICAgICA0MDAsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBBIGRvY3VtZW50IG9yIGZvbGRlciBzaG93biBpbiB0aGUgY29udGV4dCwgd2l0aCB3aGVyZSBpdCBpcyBzaG93bi4gKi9cbiAgcHJpdmF0ZSBpdGVtT3JEaWUocmF3UGF0aDogc3RyaW5nKToge1xuICAgIGFiczogc3RyaW5nO1xuICAgIGVudHJ5OiBDb250ZXh0RW50cnk7XG4gICAgLyoqIFRoZSB3aG9sZSBlbnRyeSAoYSBzZXQncyBvd24gZm9sZGVyLCBhIGxpc3RlZCBkb2N1bWVudCksIG9yIGEgbm9kZSBpbnNpZGUgYSBzZXQuICovXG4gICAgd2hvbGU6IGJvb2xlYW47XG4gICAgZGlyOiBib29sZWFuO1xuICB9IHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKGUubm9kZXMubGVuZ3RoID09PSAxICYmIG9ubHk/LmtpbmQgPT09IFwiZG9jXCIgJiYgam9pbihlLnJvb3QsIG9ubHkucmVsKSA9PT0gYWJzKVxuICAgICAgICAgIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiB0cnVlLCBkaXI6IGZhbHNlIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiB0cnVlIH07XG4gICAgICBpZiAoYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkge1xuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoZS5ub2RlcywgdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpKTtcbiAgICAgICAgaWYgKG5vZGUpIHJldHVybiB7IGFicywgZW50cnk6IGUsIHdob2xlOiBmYWxzZSwgZGlyOiBub2RlLmtpbmQgPT09IFwiZ3JvdXBcIiB9O1xuICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke2Fic30gaXMgbm90IHNob3duIGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHRgLCA0MDQpO1xuICB9XG5cbiAgLyoqXG4gICAqIGByYXdQYXRoYCBpZiB0aGUgY29udGV4dCBzaG93cyBpdCDigJQgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gYSBzZXQsIGFcbiAgICogbGlzdGVkIGRvY3VtZW50LCBhIHNldCdzIG93biBmb2xkZXIg4oCUIG9yIGl0IGlzIHRoZSB3b3Jrc3BhY2U7IHJlZnVzZWRcbiAgICogb3RoZXJ3aXNlLiBGb3IgYWN0cyB0aGF0IHJlYWNoIG91dHNpZGUgdGhlIHNwZWxsIChyZXZlYWxpbmcgYSBwYXRoIGluIHRoZVxuICAgKiBmaWxlIG1hbmFnZXIpLCBzbyBhIHBhZ2UgY2Fubm90IGFpbSB0aGVtIGF0IGFuIGFyYml0cmFyeSBwYXRoLlxuICAgKi9cbiAgc2hvd25QYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBpZiAodGhpcy5pdGVtQXQoYWJzKSkgcmV0dXJuIGFicztcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdGluYXRpb25PckRpZShhYnMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb25gLCA0MDApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZWZ1c2UgYSBuYW1lIHRoYXQgaXMgbm90IG9uZSBwbGFpbiBmaWxlIG9yIGZvbGRlciBuYW1lLiAqL1xuICBwcml2YXRlIG5hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgICBpZiAoXG4gICAgICBuID09PSBcIlwiIHx8XG4gICAgICBuID09PSBcIi5cIiB8fFxuICAgICAgbiA9PT0gXCIuLlwiIHx8XG4gICAgICBuLnN0YXJ0c1dpdGgoXCIuXCIpIHx8XG4gICAgICAvWy9cXFxcXFwwXS8udGVzdChuKSB8fFxuICAgICAgbi5sZW5ndGggPiAyNTVcbiAgICApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgXCIke25hbWV9XCIgaXMgbm90IGEgdXNhYmxlIG5hbWUg4oCUIG9uZSBwbGFpbiBuYW1lLCBubyBzbGFzaGVzLCBub3Qgc3RhcnRpbmcgd2l0aCBhIGRvdGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgcmV0dXJuIG47XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBuYW1lOiBhIG5hbWUgd2l0aG91dCBhIGRvY3VtZW50IGV4dGVuc2lvbiBnZXRzIGAubWRgLiAqL1xuICBwcml2YXRlIGRvY05hbWVPckRpZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG4gPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICByZXR1cm4gaXNEb2NOYW1lKG4pID8gbiA6IGAke259Lm1kYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciBzb21ldGhpbmcgbW92ZWQgb24gZGlzayBmcm9tIGBmcm9tYCB0byBgdG9gLCBicmluZyB0aGUgbW9kZWwgd2l0aCBpdDpcbiAgICogb3BlbmVkIGRvY3VtZW50cyBrZWVwIHRoZWlyIHZlcnNpb25zIHVuZGVyIHRoZSBuZXcgcGF0aCwgZW50cmllcyByb290ZWQgYXRcbiAgICogb3IgaG9sZGluZyB0aGUgbW92ZWQgdGhpbmcgZm9sbG93IGl0LCBhbmQgZXZlcnkgbWlycm9yIGlzIHJlLXJlYWQuIEFuIGVudHJ5XG4gICAqIHRoYXQgbm93IHNpdHMgaW5zaWRlIGFub3RoZXIgc2V0IGlzIGRyb3BwZWQg4oCUIHRoZSBzZXQgc2hvd3MgaXQgYWxyZWFkeS5cbiAgICovXG4gIHByaXZhdGUgZm9sbG93TW92ZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBtb3ZlZCA9IChwOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+XG4gICAgICBwID09PSBmcm9tID8gdG8gOiBwLnN0YXJ0c1dpdGgoZnJvbSArIHNlcCkgPyB0byArIHAuc2xpY2UoZnJvbS5sZW5ndGgpIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGQub3JpZ2luYWwpO1xuICAgICAgaWYgKG5vdykge1xuICAgICAgICBkLm9yaWdpbmFsID0gbm93O1xuICAgICAgICBkLm5hbWUgPSBiYXNlbmFtZShub3cpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBkcm9wID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcImxpc3RlZFwiKSB7XG4gICAgICAgIGNvbnN0IG9ubHkgPSBlLm5vZGVzWzBdO1xuICAgICAgICBpZiAob25seT8ua2luZCAhPT0gXCJkb2NcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG5vdyA9IG1vdmVkKGpvaW4oZS5yb290LCBvbmx5LnJlbCkpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IGRpcm5hbWUobm93KTtcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KTtcbiAgICAgICAgICBlLm5vZGVzID0gW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShub3cpIH1dO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChlLnJvb3QpO1xuICAgICAgICBpZiAoIW5vdykgY29udGludWU7XG4gICAgICAgIGlmICh0aGlzLmNvdmVyaW5nRW50cnkobm93LCBlLmlkKSkgZHJvcC5hZGQoZS5pZCk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGUucm9vdCA9IG5vdztcbiAgICAgICAgICBlLmxhYmVsID0gYmFzZW5hbWUobm93KSB8fCBub3c7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5tLmNvbnRleHQgPSB0aGlzLm0uY29udGV4dC5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHRoaXMucmVzY2FuKGUuaWQpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQWZ0ZXIgYSBmaWxlIG9yIGZvbGRlciBsYW5kZWQgYXQgYGFic2A6IHJlLXJlYWQgdGhlIHNldCBpdCBpcyBpbiwgb3IgZ2l2ZSBpdCBhbiBlbnRyeS4gKi9cbiAgcHJpdmF0ZSBhZG9wdE5ldyhhYnM6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHNldCA9IHRoaXMuY292ZXJpbmdFbnRyeShhYnMpO1xuICAgIGlmIChzZXQpIHRoaXMucmVzY2FuKHNldC5pZCk7XG4gICAgZWxzZSB0aGlzLm0uY29udGV4dC5wdXNoKGVudHJ5Rm9yUGF0aChhYnMsIGBjLSR7cmFuZEhleCgzKX1gKSk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgfVxuXG4gIC8qKiBBIG5hbWUgaW4gYGRpcmAgdGhhdCBpcyBmcmVlOiBgbmFtZWAsIGVsc2UgYHN0ZW0gMi5leHRgLCBgc3RlbSAzLmV4dGAsIOKApiAqL1xuICBwcml2YXRlIGZyZWVOYW1lKGRpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGlzRGlyOiBib29sZWFuKTogc3RyaW5nIHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoam9pbihkaXIsIG5hbWUpKSkgcmV0dXJuIG5hbWU7XG4gICAgY29uc3QgZXh0ID0gaXNEaXIgPyBcIlwiIDogZXh0bmFtZShuYW1lKTtcbiAgICBjb25zdCBzdGVtID0gZXh0ID8gbmFtZS5zbGljZSgwLCAtZXh0Lmxlbmd0aCkgOiBuYW1lO1xuICAgIGZvciAobGV0IGkgPSAyOyA7IGkrKykge1xuICAgICAgY29uc3QgbiA9IGAke3N0ZW19ICR7aX0ke2V4dH1gO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuKSkpIHJldHVybiBuO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVmdXNlRXhpc3RpbmcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoZXhpc3RzU3luYyhhYnMpKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGFscmVhZHkgZXhpc3RzIOKAlCBub3RoaW5nIHdhcyBvdmVyd3JpdHRlbmAsIDQwOSk7XG4gIH1cblxuICBjcmVhdGVEb2MocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmaWxlID1cbiAgICAgIG5hbWUgPT09IHVuZGVmaW5lZCA/IHRoaXMuZnJlZU5hbWUoZGlyLCBcIlVudGl0bGVkLm1kXCIsIGZhbHNlKSA6IHRoaXMuZG9jTmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmaWxlKTtcbiAgICB0aGlzLnJlZnVzZUV4aXN0aW5nKGFicyk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIFwiXCIsIHsgZmxhZzogXCJ3eFwiIH0pO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIGNyZWF0ZUZvbGRlcihyYXdEaXI6IHN0cmluZywgbmFtZT86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGRpciA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdEaXIpO1xuICAgIGNvbnN0IGZvbGRlciA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJOZXcgZm9sZGVyXCIsIHRydWUpIDogdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIGZvbGRlcik7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIG1rZGlyU3luYyhhYnMpO1xuICAgIHRoaXMuYWRvcHROZXcoYWJzKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBhYnMgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjY6IHdoYXQgYSBtb3ZlIFdPVUxEIGRvLCBmb3IgdGhlIGNvbmZpcm1hdGlvbiB0aGUgc3VyZmFjZSBzaG93cyBiZWZvcmVcbiAgICogbW92aW5nIGEgRk9MREVSLiBSZWFkcyBub3RoaW5nIGJ1dCB0aGUgZGlzayBhbmQgcmVmdXNlcyBleGFjdGx5IHdoYXRcbiAgICogYG1vdmVgIHdvdWxkIHJlZnVzZSwgc28gYSBjb25maXJtZWQgbW92ZSBjYW5ub3QgdGhlbiBmYWlsIG9uIGFkbWlzc2lvbi5cbiAgICpcbiAgICogVGhlIGdpdCBoYWxmIGlzIGhlcmUgYmVjYXVzZSBvbmx5IHRoZSBkYWVtb24gY2FuIHNlZSBhIGAuZ2l0YDogYSBmb2xkZXJcbiAgICogZHJhZ2dlZCBvdXQgb2YgYSByZXBvc2l0b3J5IGlzIHRoZSBjYXNlIHdoZXJlIHRoZSBjb25zZXF1ZW5jZSByZWFjaGVzIHBhc3RcbiAgICogc2NyaXB0b3JpdW0gKENvbGUgbW92ZWQgdGhpcyBwcm9qZWN0J3Mgb3duIGRvY3MgZm9sZGVyIGludG8gaGlzIHdvcmtzcGFjZSxcbiAgICogYW5kIGdpdCBzYXcgc2l4IGRlbGV0ZWQgZmlsZXMpLlxuICAgKi9cbiAgbW92ZVBsYW4ocmF3UGF0aDogc3RyaW5nLCByYXdJbnRvOiBzdHJpbmcpOiBNb3ZlUGxhbiB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgY29uc3QgZnJvbVJlcG8gPSBnaXRSb290T2YoZGlybmFtZShpdGVtLmFicykpO1xuICAgIGNvbnN0IGludG9SZXBvID0gZ2l0Um9vdE9mKGludG8pO1xuICAgIHJldHVybiB7XG4gICAgICBmcm9tOiBpdGVtLmFicyxcbiAgICAgIGludG8sXG4gICAgICBuYW1lOiBiYXNlbmFtZShpdGVtLmFicyksXG4gICAgICBmb2xkZXI6IGl0ZW0uZGlyLFxuICAgICAgZG9jczogaXRlbS5kaXIgPyBjb3VudERvY3MoaXRlbS5hYnMpIDogMSxcbiAgICAgIHJlcG86IGZyb21SZXBvID8gYmFzZW5hbWUoZnJvbVJlcG8pIDogbnVsbCxcbiAgICAgIGxlYXZlc1JlcG86IGZyb21SZXBvICE9PSBudWxsICYmIGZyb21SZXBvICE9PSBpbnRvUmVwbyxcbiAgICB9O1xuICB9XG5cbiAgbW92ZShyYXdQYXRoOiBzdHJpbmcsIHJhd0ludG86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGNvbnN0IGludG8gPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byk7XG4gICAgaWYgKGludG8gPT09IGl0ZW0uYWJzIHx8IGludG8uc3RhcnRzV2l0aChpdGVtLmFicyArIHNlcCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3QgbW92ZSAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGludG8gaXRzZWxmYCwgNDAwKTtcbiAgICBpZiAoZGlybmFtZShpdGVtLmFicykgPT09IGludG8pXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gdGhhdCBmb2xkZXJgLCA0MDApO1xuICAgIGNvbnN0IHRvID0gam9pbihpbnRvLCBiYXNlbmFtZShpdGVtLmFicykpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICBpZiAoIXRoaXMuaXRlbUF0KHRvKSkgdGhpcy5hZG9wdE5ldyh0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gIH1cblxuICByZW5hbWUocmF3UGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZnJvbTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBsZXQgbmV4dCA9IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIC8vIEEgZG9jdW1lbnQga2VlcHMgYSBkb2N1bWVudCBleHRlbnNpb246IFwibm90ZXNcIiByZW5hbWVzIG5vdGVzLm1kIHRvXG4gICAgLy8gbm90ZXMubWQsIG5vdCB0byBhbiBleHRlbnNpb25sZXNzIGZpbGUgU2NyaXB0b3JpdW0gd291bGQgc3RvcCBzaG93aW5nLlxuICAgIGlmICghaXRlbS5kaXIgJiYgIWlzRG9jTmFtZShuZXh0KSkgbmV4dCArPSBleHRuYW1lKGl0ZW0uYWJzKSB8fCBcIi5tZFwiO1xuICAgIGNvbnN0IHRvID0gam9pbihkaXJuYW1lKGl0ZW0uYWJzKSwgbmV4dCk7XG4gICAgaWYgKHRvID09PSBpdGVtLmFicykgcmV0dXJuIHsgcGF0aDogdG8sIGZyb206IGl0ZW0uYWJzIH07XG4gICAgLy8gQSBjYXNlLW9ubHkgcmVuYW1lIG9uIGEgY2FzZS1pbnNlbnNpdGl2ZSBkaXNrIGZpbmRzIFwiaXRzZWxmXCIgZXhpc3RpbmcuXG4gICAgaWYgKHRvLnRvTG93ZXJDYXNlKCkgIT09IGl0ZW0uYWJzLnRvTG93ZXJDYXNlKCkpIHRoaXMucmVmdXNlRXhpc3RpbmcodG8pO1xuICAgIHRoaXMucmVuYW1lT3JEaWUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLmZvbGxvd01vdmUoaXRlbS5hYnMsIHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHByaXZhdGUgcmVuYW1lT3JEaWUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIHJlbmFtZVN5bmMoZnJvbSwgdG8pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBjb2RlID09PSBcIkVYREVWXCJcbiAgICAgICAgICA/IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvIGFub3RoZXIgZGlzayAoJHt0b30pIOKAlCBjb3B5IGl0IGluc3RlYWRgXG4gICAgICAgICAgOiBgY2Fubm90IG1vdmUgJHtmcm9tfSB0byAke3RvfTogJHtjb2RlID8/IFN0cmluZyhlKX1gLFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBXaGV0aGVyIGBhYnNgIGlzIHNob3duIGFueXdoZXJlIGluIHRoZSBjb250ZXh0IG5vdy4gKi9cbiAgcHJpdmF0ZSBpdGVtQXQoYWJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5pdGVtT3JEaWUoYWJzKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIg4oCUIG5ldmVyIGZyb20gZGlzayAoRTI0KS4gKi9cbiAgaGlkZShyYXdQYXRoOiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZzsgZW50cnk6IHN0cmluZzsgcmVtb3ZlZEVudHJ5OiBib29sZWFuIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS53aG9sZSkge1xuICAgICAgdGhpcy5yZW1vdmVDb250ZXh0KGl0ZW0uZW50cnkuaWQpO1xuICAgICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IHRydWUgfTtcbiAgICB9XG4gICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShpdGVtLmVudHJ5LnJvb3QsIGl0ZW0uYWJzKSk7XG4gICAgaXRlbS5lbnRyeS5oaWRkZW4gPSBbLi4uKGl0ZW0uZW50cnkuaGlkZGVuID8/IFtdKS5maWx0ZXIoKGgpID0+IGggIT09IHJlbCksIHJlbF07XG4gICAgdGhpcy5yZXNjYW4oaXRlbS5lbnRyeS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLmNsb3NlT3JwaGFuZWRPcGVuRG9jKCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogaXRlbS5hYnMsIGVudHJ5OiBpdGVtLmVudHJ5LmlkLCByZW1vdmVkRW50cnk6IGZhbHNlIH07XG4gIH1cblxuICB1bmhpZGUoZW50cnlJZDogc3RyaW5nKTogeyBlbnRyeTogc3RyaW5nOyByZXN0b3JlZDogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGUgPSB0aGlzLm0uY29udGV4dC5maW5kKCh4KSA9PiB4LmlkID09PSBlbnRyeUlkKTtcbiAgICBpZiAoIWUpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2VudHJ5SWR9YCxcbiAgICAgICAgNDA0LFxuICAgICAgICB0aGlzLm0uY29udGV4dC5tYXAoKHgpID0+IHguaWQpLFxuICAgICAgKTtcbiAgICBjb25zdCByZXN0b3JlZCA9IGUuaGlkZGVuPy5sZW5ndGggPz8gMDtcbiAgICBkZWxldGUgZS5oaWRkZW47XG4gICAgdGhpcy5yZXNjYW4oZS5pZCk7XG4gICAgdGhpcy5yZWxpbmsoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBlbnRyeTogZS5pZCwgcmVzdG9yZWQgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFMjI6IGEgc2luZ2xlIGRvY3VtZW50IGJlY29tZXMgYSBzZXQg4oCUIGEgZm9sZGVyIG5hbWVkIGZvciBpdCBiZXNpZGUgaXQsIHRoZVxuICAgKiBkb2N1bWVudCBtb3ZlZCBpbiwgYW5kIHRoZSBlbnRyeSAoc2FtZSBpZCkgbm93IG1pcnJvcnMgdGhhdCBmb2xkZXIuXG4gICAqL1xuICBtYWtlU2V0KHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmb2xkZXI6IHN0cmluZzsgZW50cnk6IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgaWYgKGl0ZW0uZW50cnkubWVtYmVyc2hpcCAhPT0gXCJsaXN0ZWRcIiB8fCBpdGVtLmRpcilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke3RoaXMuZGlzcGxheShpdGVtLmFicyl9IGlzIGFscmVhZHkgaW4gYSBzZXQg4oCUIG1ha2UgYSBmb2xkZXIgdGhlcmUgaW5zdGVhZGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShpdGVtLmFicyk7XG4gICAgY29uc3Qgc3RlbSA9IGJhc2VuYW1lKGl0ZW0uYWJzLCBleHRuYW1lKGl0ZW0uYWJzKSkgfHwgXCJVbnRpdGxlZFwiO1xuICAgIGNvbnN0IGZvbGRlciA9IGpvaW4ocGFyZW50LCB0aGlzLmZyZWVOYW1lKHBhcmVudCwgc3RlbSwgdHJ1ZSkpO1xuICAgIG1rZGlyU3luYyhmb2xkZXIpO1xuICAgIGNvbnN0IHRvID0gam9pbihmb2xkZXIsIGJhc2VuYW1lKGl0ZW0uYWJzKSk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIGNvbnN0IGUgPSBpdGVtLmVudHJ5O1xuICAgIGUubWVtYmVyc2hpcCA9IFwibWlycm9yZWRcIjtcbiAgICBlLnJvb3QgPSBmb2xkZXI7XG4gICAgZS5sYWJlbCA9IGJhc2VuYW1lKGZvbGRlcik7XG4gICAgZS5ub2RlcyA9IFtdO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmb2xkZXIsIGVudHJ5OiBlLmlkIH07XG4gIH1cblxuICAvKiogVGhlIG1vc3QgdGV4dCBvbmUgaW1wb3J0IGNhcnJpZXMg4oCUIGEgZG9jdW1lbnQsIG5vdCBhIGRhdGEgZHVtcC4gKi9cbiAgc3RhdGljIHJlYWRvbmx5IElNUE9SVF9NQVhfQllURVMgPSA4ICogMTAyNCAqIDEwMjQ7XG5cbiAgLyoqXG4gICAqIEUyMydzIGRyb3A6IGEgQ09QWSBvZiBhIGZpbGUncyB0ZXh0LCB3cml0dGVuIHVuZGVyIGEgZnJlZSBuYW1lIGludG8gYGludG9gXG4gICAqIChkZWZhdWx0OiB0aGUgd29ya3NwYWNlKSwgdGhlbiBzaG93biBsaWtlIGFueSBvdGhlciBkb2N1bWVudC5cbiAgICovXG4gIGltcG9ydFRleHQobmFtZTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIHJhd0ludG8/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBmaWxlID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgaWYgKCFpc0RvY05hbWUoZmlsZSkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm90IGEgZG9jdW1lbnQgU2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHtmaWxlfWAsXG4gICAgICAgIDQwMCxcbiAgICAgICAgWy4uLkRPQ19FWFRFTlNJT05TXSxcbiAgICAgICk7XG4gICAgaWYgKEJ1ZmZlci5ieXRlTGVuZ3RoKHRleHQpID4gU2Vzc2lvbi5JTVBPUlRfTUFYX0JZVEVTKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7ZmlsZX0gaXMgbGFyZ2VyIHRoYW4gJHtTZXNzaW9uLklNUE9SVF9NQVhfQllURVMgLyAxMDI0IC8gMTAyNH0gTUIg4oCUIG5vdCBpbXBvcnRlZGAsXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0ludG8gPz8gdGhpcy53b3Jrc3BhY2UpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCB0aGlzLmZyZWVOYW1lKGRpciwgZmlsZSwgZmFsc2UpKTtcbiAgICB3cml0ZUZpbGVTeW5jKGFicywgdGV4dCwgeyBmbGFnOiBcInd4XCIgfSk7XG4gICAgdGhpcy5hZG9wdE5ldyhhYnMpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIGNoYXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkTWVzc2FnZShcbiAgICB3aG86IENoYXRXaG8sXG4gICAgdGV4dDogc3RyaW5nLFxuICAgIGV4dHJhOiB7IHNlbGVjdGlvbj86IFNlbGVjdGlvbiB8IG51bGw7IGFjdGl2ZVBhdGg/OiBzdHJpbmcgfCBudWxsIH0gPSB7fSxcbiAgKTogQ2hhdE1lc3NhZ2Uge1xuICAgIGNvbnN0IG1zZzogQ2hhdE1lc3NhZ2UgPSB7IGlkOiBgbS0ke3JhbmRIZXgoNCl9YCwgd2hvLCB0ZXh0LCB0czogRGF0ZS5ub3coKSwgLi4uZXh0cmEgfTtcbiAgICB0aGlzLm0uY2hhdC5wdXNoKG1zZyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIG1zZztcbiAgfVxuXG4gIC8vIOKUgOKUgCB2aWV3cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBkb2NWaWV3KGQ6IERvY1JlY29yZCk6IERvY1ZpZXcge1xuICAgIHJldHVybiB7XG4gICAgICBzbHVnOiBkLnNsdWcsXG4gICAgICBuYW1lOiBkLm5hbWUsXG4gICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgIGVudHJ5SWQ6IGQuZW50cnlJZCxcbiAgICAgIHJlbDogZC5yZWwsXG4gICAgICB2ZXJzaW9uczogZC52ZXJzaW9ucy5tYXAoKHYpID0+ICh7IC4uLnYsIHBhdGg6IHRoaXMudmVyc2lvblBhdGgoZCwgdi5uKSB9KSksXG4gICAgICBhY3RpdmU6IGQuYWN0aXZlLFxuICAgICAgZGlydHk6IHRoaXMuaXNEaXJ0eShkKSxcbiAgICAgIG91dHNpZGVDaGFuZ2VkOiBkLm91dHNpZGVDaGFuZ2VkLFxuICAgIH07XG4gIH1cblxuICBkb2Moc2x1Zzogc3RyaW5nKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHRoaXMuZG9jVmlldyh0aGlzLmRvY09yRGllKHNsdWcpKTtcbiAgfVxuXG4gIC8qKiBUaGUgc2Vzc2lvbidzIGhhbGYgb2YgYFB1YmxpY1N0YXRlYDsgdGhlIGRhZW1vbiBhZGRzIHRoZSBob21lLWxldmVsIGBwcmVmc2AgYW5kIGB1c2VySG9tZWAuICovXG4gIHZpZXcoXG4gICAgbW9kZTogXCJkZXZcIiB8IFwicmVsZWFzZVwiLFxuICAgIHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCxcbiAgKTogT21pdDxQdWJsaWNTdGF0ZSwgXCJwcmVmc1wiIHwgXCJ1c2VySG9tZVwiPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5tLnNlc3Npb25JZCxcbiAgICAgIGhvbWU6IHRoaXMuaG9tZSxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy53b3Jrc3BhY2UsXG4gICAgICBtb2RlLFxuICAgICAgY29udGV4dDogdGhpcy5tLmNvbnRleHQsXG4gICAgICBkb2NzOiB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IHRoaXMuZG9jVmlldyhkKSksXG4gICAgICBvcGVuRG9jOiB0aGlzLm0ub3BlbkRvYyxcbiAgICAgIHNlbGVjdGlvbixcbiAgICAgIGNoYXQ6IHRoaXMubS5jaGF0LFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgZ2l0IHdvcmtpbmcgdHJlZSBgZGlyYCBpcyBpbiwgb3IgbnVsbC4gQSBgLmdpdGAgRU5UUlksIG5vdCBhIGRpcmVjdG9yeVxuICogdGVzdDogYSB3b3JrdHJlZSBhbmQgYSBzdWJtb2R1bGUgYm90aCBoYXZlIGAuZ2l0YCBhcyBhIEZJTEUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnaXRSb290T2YoZGlyOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgbGV0IGF0ID0gZGlyO1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihhdCwgXCIuZ2l0XCIpKSkgcmV0dXJuIGF0O1xuICAgIGNvbnN0IHVwID0gZGlybmFtZShhdCk7XG4gICAgaWYgKHVwID09PSBhdCkgcmV0dXJuIG51bGw7XG4gICAgYXQgPSB1cDtcbiAgfVxufVxuXG4vKiogRG9jdW1lbnRzIHVuZGVyIGEgZm9sZGVyLCBmb3Igc2F5aW5nIGhvdyBtdWNoIGEgbW92ZSBtb3Zlcy4gKi9cbmZ1bmN0aW9uIGNvdW50RG9jcyhkaXI6IHN0cmluZyk6IG51bWJlciB7XG4gIGxldCBuID0gMDtcbiAgY29uc3Qgd2FsayA9IChhdDogc3RyaW5nKSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhhdCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgYWJzID0gam9pbihhdCwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB3YWxrKGFicyk7XG4gICAgICBlbHNlIGlmIChpc0RvY05hbWUobmFtZSkpIG4rKztcbiAgICB9XG4gIH07XG4gIHdhbGsoZGlyKTtcbiAgcmV0dXJuIG47XG59XG4iLAogICAgIi8qKlxuICogQ29udGV4dCBlbnRyaWVzIG9uIGRpc2sg4oCUIGJ1aWxkaW5nIGFuIGVudHJ5IGZyb20gYSBwYXRoIChFMTUncyBvbmUgbW9kZWwpLFxuICogbWlycm9yaW5nIGEgZm9sZGVyIGludG8gYSBub2RlIHRyZWUsIGFuZCBsaXN0aW5nIGEgZGlyZWN0b3J5IGZvciB0aGVcbiAqIHN1cmZhY2UncyBwYXRoIGNvbXBsZXRpb24gKGBmcy5saXN0YCkuXG4gKlxuICogUHVyZSBvdmVyIHRoZSBmaWxlc3lzdGVtOiBubyBkYWVtb24gc3RhdGUsIHNvIHRoZSB1bml0IGNlbGxzIGRyaXZlIGl0IHdpdGggYVxuICogdGVtcCBkaXJlY3RvcnkgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRleHRFbnRyeSwgQ29udGV4dE5vZGUsIEZzTGlzdEVudHJ5IH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIFdoYXQgc2NyaXB0b3JpdW0gb3BlbnMgYXMgYSBkb2N1bWVudC4gRXZlcnl0aGluZyBlbHNlIGlzIG5vdCBzaG93bi4gKi9cbmV4cG9ydCBjb25zdCBET0NfRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNEb2NOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIERPQ19FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSk7XG59XG5cbi8qKiBEaXJlY3RvcmllcyBhIG1pcnJvciBuZXZlciBkZXNjZW5kcyBpbnRvIOKAlCBub2lzZSwgbm90IGRvY3VtZW50cy4gKi9cbmNvbnN0IFNLSVBfRElSUyA9IG5ldyBTZXQoW1wibm9kZV9tb2R1bGVzXCIsIFwiLmdpdFwiLCBcImRpc3RcIiwgXCJvdXRcIiwgXCJjb3ZlcmFnZVwiXSk7XG5cbi8qKlxuICogVGhlIG1vc3Qgbm9kZXMgb25lIG1pcnJvcmVkIHNjYW4gd2lsbCBob2xkLiBBIGZvbGRlciBlbnRyeSBwb2ludGVkIGF0IGEgaHVnZVxuICogdHJlZSBtdXN0IG5vdCBzdGFsbCB0aGUgZGFlbW9uIG9yIGZsb29kIGV2ZXJ5IHN0YXRlIGJyb2FkY2FzdDsgaGl0dGluZyB0aGVcbiAqIGNhcCBzZXRzIGB0cnVuY2F0ZWRgIG9uIHRoZSBlbnRyeSBzbyB0aGUgc3VyZmFjZSBjYW4gU0FZIHRoZSBsaXN0IGlzIHNob3J0XG4gKiByYXRoZXIgdGhhbiByZW5kZXIgYSBzaG9ydCBsaXN0IGFzIGEgY29tcGxldGUgb25lLlxuICovXG5leHBvcnQgY29uc3QgTUlSUk9SX05PREVfQ0FQID0gMjAwMDtcblxuZXhwb3J0IGNvbnN0IHRvUG9zaXggPSAocDogc3RyaW5nKSA9PiBwLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG5cbi8qKlxuICogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuXG4gKiBgaGlkZGVuYCByZWxzIChFMjQncyBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIpIGFyZSBza2lwcGVkLCBhIGZvbGRlciB3aXRoXG4gKiBldmVyeXRoaW5nIHVuZGVyIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuICBoaWRkZW46IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4pOiB7IG5vZGVzOiBDb250ZXh0Tm9kZVtdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoaGlkZGVuKTtcbiAgY29uc3Qgd2FsayA9IChkaXI6IHN0cmluZyk6IENvbnRleHROb2RlW10gPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXBzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgY29uc3QgZG9jczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcy5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gY2FwKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKHJvb3QsIGFicykpO1xuICAgICAgaWYgKHNraXAuaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHdhbGsoYWJzKTtcbiAgICAgICAgLy8gQSBmb2xkZXIgaG9sZGluZyBvbmx5IG5vbi1kb2N1bWVudHMgKGltYWdlcywgYXNzZXRzKSBpcyBub2lzZSBpbiBhXG4gICAgICAgIC8vIGRvY3MgbWlycm9yIGFuZCBpcyBsZWZ0IG91dC4gQSBUUlVMWSBFTVBUWSBmb2xkZXIgaXMga2VwdDogaXQgaXMgb25lXG4gICAgICAgIC8vIHNvbWVib2R5IGp1c3QgbWFkZSB0byBwdXQgZG9jdW1lbnRzIGluIChcIk5ldyBmb2xkZXJcIiwgRTI0KSwgYW5kXG4gICAgICAgIC8vIGxlYXZpbmcgaXQgb3V0IG1hZGUgaXQgdmFuaXNoIHRoZSBtb21lbnQgaXQgd2FzIGNyZWF0ZWQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwIHx8IGlzRW1wdHlEaXIoYWJzKSkgZ3JvdXBzLnB1c2goeyBraW5kOiBcImdyb3VwXCIsIHJlbCwgY2hpbGRyZW4gfSk7XG4gICAgICB9IGVsc2UgaWYgKHN0LmlzRmlsZSgpICYmIGlzRG9jTmFtZShuYW1lKSkge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBkb2NzLnB1c2goeyBraW5kOiBcImRvY1wiLCByZWwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbLi4uZ3JvdXBzLCAuLi5kb2NzXTtcbiAgfTtcbiAgY29uc3Qgbm9kZXMgPSB3YWxrKHJvb3QpO1xuICByZXR1cm4geyBub2RlcywgdHJ1bmNhdGVkIH07XG59XG5cbi8qKiBOb3RoaW5nIGluIGl0IGJ1dCBkb3RmaWxlcyAoYSBgLkRTX1N0b3JlYCBkb2VzIG5vdCBtYWtlIGEgZm9sZGVyIGZ1bGwpLiAqL1xuZnVuY3Rpb24gaXNFbXB0eURpcihkaXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIpLmV2ZXJ5KChuKSA9PiBuLnN0YXJ0c1dpdGgoXCIuXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUaGUgbm9kZSBhdCBgcmVsYCBpbiBhIHRyZWUsIG9yIHVuZGVmaW5lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTm9kZShub2RlczogcmVhZG9ubHkgQ29udGV4dE5vZGVbXSwgcmVsOiBzdHJpbmcpOiBDb250ZXh0Tm9kZSB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgIGlmIChuLnJlbCA9PT0gcmVsKSByZXR1cm4gbjtcbiAgICBpZiAobi5raW5kID09PSBcImdyb3VwXCIgJiYgcmVsLnN0YXJ0c1dpdGgoYCR7bi5yZWx9L2ApKSByZXR1cm4gZmluZE5vZGUobi5jaGlsZHJlbiwgcmVsKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgY2xhc3MgUGF0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgY29kZTogXCJtaXNzaW5nXCIgfCBcIm5vdC1hLWRvY1wiLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG4vKipcbiAqIEFuIGVudHJ5IGZvciBhbiBhYnNvbHV0ZSBwYXRoLiBBIGRpcmVjdG9yeSBpcyBgbWlycm9yZWRgOyBhIGRvY3VtZW50IGZpbGUgaXNcbiAqIGBsaXN0ZWRgLCByb290ZWQgYXQgaXRzIHBhcmVudCwgaG9sZGluZyBvbmx5IGl0c2VsZiAoRTE1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudHJ5Rm9yUGF0aChhYnM6IHN0cmluZywgaWQ6IHN0cmluZyk6IENvbnRleHRFbnRyeSB7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHthYnN9YCwgXCJtaXNzaW5nXCIpO1xuICB9XG4gIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShhYnMpO1xuICAgIHJldHVybiB7XG4gICAgICBpZCxcbiAgICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpIHx8IGFicyxcbiAgICAgIHJvb3Q6IGFicyxcbiAgICAgIG1lbWJlcnNoaXA6IFwibWlycm9yZWRcIixcbiAgICAgIG5vZGVzLFxuICAgICAgLi4uKHRydW5jYXRlZCA/IHsgdHJ1bmNhdGVkIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzRG9jTmFtZShhYnMpKSB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihcbiAgICAgIGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2Fic31gLFxuICAgICAgXCJub3QtYS1kb2NcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbGFiZWw6IGJhc2VuYW1lKGFicyksXG4gICAgcm9vdDogZGlybmFtZShhYnMpLFxuICAgIG1lbWJlcnNoaXA6IFwibGlzdGVkXCIsXG4gICAgbm9kZXM6IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUoYWJzKSB9XSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGRvYyBub2RlJ3MgYWJzb2x1dGUgcGF0aCwgZGVwdGgtZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jUGF0aHMoZW50cnk6IENvbnRleHRFbnRyeSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKSA9PiB7XG4gICAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgICBpZiAobi5raW5kID09PSBcImRvY1wiKSBvdXQucHVzaChqb2luKGVudHJ5LnJvb3QsIG4ucmVsKSk7XG4gICAgICBlbHNlIHdhbGsobi5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuICB3YWxrKGVudHJ5Lm5vZGVzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoaWNoIGVudHJ5IChpZiBhbnkpIGhvbGRzIGBhYnNgLCBhbmQgYXQgd2hhdCBgcmVsYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhdGUoXG4gIGVudHJpZXM6IENvbnRleHRFbnRyeVtdLFxuICBhYnM6IHN0cmluZyxcbik6IHsgZW50cnlJZDogc3RyaW5nOyByZWw6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGRvY1BhdGhzKGUpLmluY2x1ZGVzKGFicykpIHJldHVybiB7IGVudHJ5SWQ6IGUuaWQsIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogT25lIGRpcmVjdG9yeSwgZm9yIHRoZSBzdXJmYWNlJ3MgYWRkLWJ5LXBhdGggY29tcGxldGlvbjogc3ViZGlyZWN0b3JpZXMgYW5kXG4gKiBkb2N1bWVudHMgb25seSwgZGlyZWN0b3JpZXMgZmlyc3QuIGB+YCBpcyBleHBhbmRlZCBieSB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdERpcihkaXI6IHN0cmluZyk6IEZzTGlzdEVudHJ5W10ge1xuICBjb25zdCBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gIGNvbnN0IG91dDogRnNMaXN0RW50cnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNEaXIgfHwgaXNEb2NOYW1lKG5hbWUpKSBvdXQucHVzaCh7IG5hbWUsIHBhdGg6IGFicywgZGlyOiBpc0RpciB9KTtcbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IChhLmRpciA9PT0gYi5kaXIgPyBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIDogYS5kaXIgPyAtMSA6IDEpKTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFxREEseUJBQXlCLDJCQUFjLHlCQUFVO0FBQ2pELG9CQUFTO0FBQ1QscUJBQVMsc0JBQVUsd0JBQVMscUJBQVksa0JBQU07QUFDOUM7QUFDQSxzQkFBUzs7O0FDM0NUO0FBcUJPLFNBQVMsZUFBZSxDQUFDLFFBQWdCLE1BQW9CO0FBQUEsRUFDbEUsTUFBTSxNQUFN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QUFNLElBQUk7QUFBQTtBQUFBLEVBRW5ELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsS0FBSyxvQkFBb0IsRUFBRSxRQUFRLE1BQU0sRUFBRSxNQUFNLFlBQVksRUFBRSxXQUFXLE1BQU0sRUFBRSxNQUFNLEtBQUssRUFBRSxJQUFJLENBQUM7QUFBQSxDQUMxSDtBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sRUFBRTtBQUFBLEVBQ3BCLE1BQU0sRUFBRTtBQUFBLEVBRVIsSUFBSSxJQUFJLFNBQVMsS0FBSyxNQUFNLEtBQUs7QUFBQSxJQUMvQixJQUFJO0FBQUEsTUFDRixJQUFJLFVBQVMsTUFBTSxHQUFHLEVBQUUsU0FBUztBQUFBLFFBQUcsWUFBVyxNQUFNLEdBQUc7QUFBQSxNQUN4RCxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsT0FBTyxJQUFJO0FBQUE7QUFRYixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI1QUIzM0M3MERGOUVBNjQ4NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
