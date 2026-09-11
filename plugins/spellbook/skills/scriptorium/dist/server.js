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

//# debugId=C2267C98DDBE09A964756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9kaXNjb3ZlcnkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2V2ZW50TG9nLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9ob3VzZWtlZXBpbmcudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3NlcnZlRGlzdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvc3NlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3BpY2tlci50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC9zZXNzaW9uLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIHBlci1zZXNzaW9uIGRhZW1vbiDigJQgdGhlIHByb2Nlc3MgdGhlIHN1cmZhY2UgdGFsa3MgdG8gb3ZlciBhXG4gKiBXZWJTb2NrZXQgYW5kIHRoZSBDTEkgdGFsa3MgdG8gb3ZlciBIVFRQLiBMYXVuY2hlZCBieVxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9zY3JpcHRvcml1bS9zY3JpcHRzL3NlcnZlci50c2AgKHRoZSBsYXVuY2hlciksIHdoaWNoXG4gKiBpbXBvcnRzIHRoZSBCVUlMVCBgZGlzdC9zZXJ2ZXIuanNgLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBgU0tJTExfUk9PVGAvYERJU1RfRElSYCBvbmx5LCBmb3IgdGhlIGtpdCdzIGByZXNvbHZlTW9kZWAgYW5kXG4gKiAgICBgc2VydmVGcm9tRGlzdGAsIGFuZCB0cnVlIGF0IHRoZSBFTUlUVEVEIGFkZHJlc3MgKGBkaXN0L3NlcnZlci5qc2AsIHdob3NlXG4gKiAgICBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIpLiBOb3RoaW5nIGVsc2UgaXMgcGlubmVkIG9mZiBgaW1wb3J0Lm1ldGFgLlxuICogMi4gU2VydmVzOiBZRVMuIGAvYCBpcyB0aGUgYnVpbHQgYGluZGV4Lmh0bWxgIHZpYSBgc2VydmVGcm9tRGlzdGAsIG5vXG4gKiAgICBzdWJzdGl0dXRpb247IHRoZSBvbmx5IHJvdXRlcyBvZiBpdHMgb3duIGFyZSBgL3N0YXRlYCwgYC9jbWRgLCBgL2V2ZW50c2AsXG4gKiAgICBgL3dzYCBhbmQgYC9mcy8qYCAocmVhZC1vbmx5OiBhIHZlcnNpb24ncyB0ZXh0LCBhIGRpcmVjdG9yeSBsaXN0aW5nKS5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIGBjbGkudHNgOyB0aGUgdHdvIHNoYXJlIGAuL2hlYXJ0YmVhdC50c2AuXG4gKiA0LiBMaWZlY3ljbGU6IGxvbmctcnVubmluZywgb25lIGRhZW1vbiBwZXIgc2Vzc2lvbiwgaWRsZS10aW1lb3V0IGxpa2VcbiAqICAgIGdsYW1vdXIgKGxpbmdlciBhZnRlciB0aGUgbGFzdCBzdWJzY3JpYmVyIGxlYXZlczsgZXhpdCAxMjQpLlxuICogNS4gYG1haW4oKWAgcmV0dXJucyB3aGlsZSB0aGUgcHJvY2VzcyBtdXN0IGxpdmU/IE5PIOKAlCBgbWFpbmAgYXdhaXRzIHRoZVxuICogICAgc2Vzc2lvbidzIGVuZCBhbmQgaXRzIG93biBkcmFpbiwgZXhhY3RseSBhcyBnbGFtb3VyJ3Mgc2VydmVyIGRvZXMsIHNvIHRoZVxuICogICAgbGF1bmNoZXIgaXMgVEVSTUlOQUwtRVhJVCAoYHByb2Nlc3MuZXhpdChhd2FpdCBydW4oKSlgKTogb25jZSBgbWFpbmBcbiAqICAgIHJlc29sdmVzIG5vdGhpbmcgbWF5IGtlZXAgdGhlIHByb2Nlc3MgYWxpdmUsIGFuZCBhIHdhdGNoZXIgaGFuZGxlIG9yIGFcbiAqICAgIHN0cmFnZ2xpbmcgc29ja2V0IHdvdWxkLiBEcml2ZW4sIG5vdCByZWFkIChzZWUgdGhlIHNsaWNlLUEgam91cm5hbCkuXG4gKiA2LiBFdmVudCBpZHMgcmVjb3ZlcmVkIGFjcm9zcyByZXN0YXJ0PyBOTyDigJQgdGhlIGxvZyBpcyBpbiBtZW1vcnkgYW5kIGlkc1xuICogICAgcmVzdGFydCBhdCAxLCBldmVuIHVuZGVyIGAtLXJlc3RvcmVgICh3aGljaCByZXN0b3JlcyB0aGUgTUFOSUZFU1QsIG5vdCB0aGVcbiAqICAgIGxvZykuIFNvIHRoZSBsb2cgaXMgc3RhbXBlZCB3aXRoIGEgcGVyLWJvb3QgRVBPQ0ggKG1pbmQtbWFwcGVyJ3Mgc2hhcGUpXG4gKiAgICBhbmQgdGhlIHRhaWwgcmVzZXRzIGl0cyBjdXJzb3Igd2hlbiB0aGUgZXBvY2ggY2hhbmdlcy5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vIOKAlCB0aGUgc2hhcGUgd2FzIGNob3NlbiB0byBiZSB0aGVcbiAqICAgIGtpdCdzLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IE5POiBzY3JpcHRvcml1bVxuICogICAgaXMgdGhlIGZpcnN0IHNwZWxsIHNjYWZmb2xkZWQgYWZ0ZXIgdGhlIGNvbnZlcmdlbmNlLlxuICpcbiAqIOKUgOKUgCBLSVQgVkVSRElDVFMgKHBsYXlib29rIE40KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBlcnJvcnMgU1VCSkVDVCAodGhlIENMSTsgdGhlIGRhZW1vbiBhbnN3ZXJzIEhUVFAgc3RhdHVzZXMgdGhlIENMSSBtYXBzKSDCt1xuICogc2VydmVEaXN0IFNVQkpFQ1QgKGByZXNvbHZlTW9kZWAsIGBzZXJ2ZUZyb21EaXN0YCkgwrcgaG91c2VrZWVwaW5nIFNVQkpFQ1QsIGFsbFxuICogdGhyZWUgZXhwb3J0cyAoYHNob3VsZElkbGVDbG9zZWAgdmlhIGBzdGFydEhvdXNla2VlcGluZ2AncyBpZGxlLWNsb3NlLCB0aGVcbiAqIHNuYXBzaG90IHN3ZWVwIOKAlCBoZXJlIHRoZSBtYW5pZmVzdCBpcyB3cml0dGVuIG9uIGV2ZXJ5IGNoYW5nZSBpbnN0ZWFkLCBzbyB0aGVcbiAqIHN3ZWVwJ3Mgc25hcHNob3QgaG9vayBpcyBkZWxpYmVyYXRlbHkgTk9UIHBhc3NlZCDigJQgYW5kIGBkcmFpbkFuZFN0b3BgKSDCt1xuICogdGFpbEV2ZW50cyBTVUJKRUNUICh0aGUgQ0xJJ3MgYHRhaWxgKSDCtyBoZWFydGJlYXQgU1VCSkVDVCAoYC4vaGVhcnRiZWF0LnRzYCkgwrdcbiAqIGRpc2NvdmVyeSBTVUJKRUNUIChzZXNzaW9uLUpTT04sIEUxMzogYHNjcmlwdG9yaXVtLTxpZD4uanNvbmAgK1xuICogYHNjcmlwdG9yaXVtLWxhdGVzdC5qc29uYCBpbiB0bXBkaXIgdmlhIGB3cml0ZUZpbGVBdG9taWNgL2B1bmxpbmtJZk1hdGNoZXNgKSDCt1xuICogZXZlbnRMb2cgU1VCSkVDVCwgV0lUSCBFUE9DSCAoUTYpIMK3IHNzZSBTVUJKRUNUIChgR0VUIC9ldmVudHNgKSDCt1xuICogbGliL3ByaW50SnNvbiBTVUJKRUNUICh0aGUgQ0xJIHNwZWFrcyB0aGUgYWdlbnQgd2lyZSkuXG4gKlxuICog4pSA4pSAIFRFQVJET1dOIE9SREVSIChyZWdpc3RlciBBNiksIFNUQVRFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBnbGFtb3VyJ3Mgb3JkZXI6IHN0b3AgaG91c2VrZWVwaW5nIOKGkiBjbG9zZSB0aGUgd2F0Y2hlcnMg4oaSIHBlcnNpc3QgdGhlXG4gKiBtYW5pZmVzdCDihpIgdW5saW5rIGRpc2NvdmVyeSDihpIgZW1pdCBgY2xvc2VkYCDihpIgZHJhaW4uIERpc2NvdmVyeSBnb2VzIEJFRk9SRSB0aGVcbiAqIGBjbG9zZWRgIGZyYW1lIHNvIGEgdGFpbCB0aGF0IHNlZXMgYGNsb3NlZGAgYW5kIGEgQ0xJIHZlcmIgdGhhdCBydW5zIHJpZ2h0XG4gKiBhZnRlciBpdCBib3RoIGZpbmQgbm8gcG9pbnRlciB0byBhIGRhZW1vbiB0aGF0IGlzIGxlYXZpbmc7IHRoZSBvdGhlciBvcmRlclxuICogbGVhdmVzIGEgd2luZG93IGluIHdoaWNoIGEgdmVyYiByZXNvbHZlcyBhIHNlc3Npb24gdGhhdCB3aWxsIHJlZnVzZSBpdC5cbiAqL1xuXG5pbXBvcnQgeyB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgdW5saW5rU3luYywgd2F0Y2ggfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyB1bmxpbmtJZk1hdGNoZXMsIHdyaXRlRmlsZUF0b21pYyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9kaXNjb3ZlcnkudHNcIjtcbmltcG9ydCB7IGNyZWF0ZUV2ZW50TG9nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2V2ZW50TG9nLnRzXCI7XG5pbXBvcnQgeyBkcmFpbkFuZFN0b3AsIHN0YXJ0SG91c2VrZWVwaW5nIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hvdXNla2VlcGluZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGUgYXMgcmVzb2x2ZU1vZGVJbiwgc2VydmVGcm9tRGlzdCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9zZXJ2ZURpc3QudHNcIjtcbmltcG9ydCB7IHR5cGUgU3NlQ2xpZW50cywgc3NlUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvc3NlLnRzXCI7XG5pbXBvcnQgeyBJRExFX1RJTUVPVVRfU0VDLCBTU0VfSEVBUlRCRUFUX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyB0eXBlIFBpY2tLaW5kLCBwYXJzZVBpY2tlck91dHB1dCwgcGlja2VyQ29tbWFuZCwgd2FzQ2FuY2VsbGVkIH0gZnJvbSBcIi4vcGlja2VyXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50Q21kLCBDbGllbnRNc2csIFNlbGVjdGlvbiwgU2VydmVyTXNnLCBTdHJ1Y3R1cmVPcCB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQgeyB0eXBlIEZpbGVFdmVudCwgU2Vzc2lvbiwgU2Vzc2lvbkVycm9yIH0gZnJvbSBcIi4vc2Vzc2lvblwiO1xuaW1wb3J0IHsgbGlzdERpciwgUGF0aEVycm9yIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8qKiByZWxlYXNlIGlmZiBgZGlzdC9pbmRleC5odG1sYCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Q7IHRoZSBlbnYgdmFyIG92ZXJyaWRlcyAoQ29udHJhY3QgMSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgcmV0dXJuIHJlc29sdmVNb2RlSW4oRElTVF9ESVIpO1xufVxuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgcmV0dXJuIHNlcnZlRnJvbURpc3QoRElTVF9ESVIsIHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYC4gYHByb21wdHMuanNvbmAgYmVzaWRlIGBzZXNzaW9ucy9gIGlzIHNsaWNlIEIncyAoRTkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbmV4cG9ydCB0eXBlIFN0YXJ0T3B0cyA9IHtcbiAgcG9ydD86IG51bWJlcjtcbiAgcmVzdG9yZT86IHN0cmluZztcbiAgdGltZW91dFM/OiBudW1iZXI7XG4gIC8qKiBFMjM6IGEgTkVXIHNlc3Npb24ncyB3b3Jrc3BhY2Ug4oCUIHRoZSBkaXJlY3RvcnkgYG9wZW5gIHJhbiBpbi4gQSByZXN0b3JlIGtlZXBzIGl0cyBvd24uICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHRhaWwgZnJhbWUncyBwYXlsb2FkLiBUaGUgbG9nIHN0YW1wcyBgaWRgIGFuZCBgZXBvY2hgLiAqL1xudHlwZSBMb2dFdmVudCA9IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyB0eXBlOiBzdHJpbmcgfTtcblxuLyoqIEhvdyBsb25nIGEgYnVyc3Qgb2Ygd2F0Y2hlciBldmVudHMgb24gb25lIHBhdGggc2V0dGxlcyBiZWZvcmUgaXQgaXMgcmVhZC4gKi9cbmNvbnN0IFdBVENIX1NFVFRMRV9NUyA9IDYwO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnREYWVtb24ob3B0czogU3RhcnRPcHRzKSB7XG4gIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgLy8gTW9kZSBCRUZPUkUgYW55IHdyaXRlOiBhIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBtdXN0XG4gIC8vIGRpZSBhdCB0aGUgaW1wb3J0IGhhdmluZyBjcmVhdGVkIG5vdGhpbmcgKGdsYW1vdXIncyBtZWFzdXJlZCBvcmRlcikuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuICBjb25zdCBkZXZJbmRleCA9XG4gICAgbW9kZSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGNvbnN0IHNlc3Npb24gPSBvcHRzLnJlc3RvcmVcbiAgICA/IFNlc3Npb24ucmVzdG9yZShob21lLCBvcHRzLnJlc3RvcmUpXG4gICAgOiBTZXNzaW9uLmNyZWF0ZShob21lLCB1bmRlZmluZWQsIG9wdHMud29ya3NwYWNlKTtcbiAgY29uc3Qgc2Vzc2lvbklkID0gc2Vzc2lvbi5pZDtcbiAgbGV0IHNlbGVjdGlvbjogU2VsZWN0aW9uIHwgbnVsbCA9IG51bGw7XG5cbiAgLy8gLS0tIHByZWZzOiBwZXItdmlld2VyIGNvbnZlbmllbmNlcyB0aGF0IG91dGxpdmUgYSBzZXNzaW9uJ3MgcG9ydCAtLS0tLS0tLS0tLS1cbiAgLy8gQnJvd3NlciBzdG9yYWdlIGlzIGtleWVkIGJ5IG9yaWdpbiwgcG9ydCBpbmNsdWRlZCwgYW5kIGV2ZXJ5IHNlc3Npb24gZ2V0cyBhXG4gIC8vIG5ldyBwb3J0IOKAlCBzbyBhIHBhbmUgc2l6ZSBrZXB0IGluIGxvY2FsU3RvcmFnZSByZXNldHMgYXQgdGhlIG5leHQgYG9wZW5gLlxuICAvLyBUaGV5IGxpdmUgaW4gdGhlIGhvbWUgaW5zdGVhZCwgc2hhcmVkIGJ5IGV2ZXJ5IHNlc3Npb24gb2YgdGhpcyBob21lLlxuICBjb25zdCBwcmVmc0ZpbGUgPSBqb2luKGhvbWUsIFwicHJlZnMuanNvblwiKTtcbiAgY29uc3QgUFJFRl9LRVkgPSAvXlthLXpdW2EtejAtOTouXy1dezAsNjN9JC87XG4gIGNvbnN0IFBSRUZfVkFMVUVfTUFYID0gNDA5NjtcbiAgY29uc3QgUFJFRl9LRVlTX01BWCA9IDY0O1xuICAvKipcbiAgICogUmVhZCB0aGUgaG9tZSdzIHByZWZzIEZSRVNILiBTZXZlcmFsIHNlc3Npb25zIGNhbiBzaGFyZSBvbmUgaG9tZSAoRTEzKSwgZWFjaFxuICAgKiBpdHMgb3duIGRhZW1vbiwgc28gYSBjb3B5IGxvYWRlZCBvbmNlIGF0IGJvb3QgYW5kIHdyaXR0ZW4gYmFjayB3aG9sZSB3b3VsZFxuICAgKiBlcmFzZSBhIGtleSBhbm90aGVyIHNlc3Npb24gd3JvdGUgc2luY2UgKHZlcmlmeSBwYXNzKS4gRXZlcnkgd3JpdGUgaXNcbiAgICogdGhlcmVmb3JlIHJlYWQg4oaSIHNldCBvbmUga2V5IOKGkiB3cml0ZSwgYW5kIGV2ZXJ5IHNuYXBzaG90IHJlYWRzIHRoZSBmaWxlLlxuICAgKiBPbmx5IHdlbGwtZm9ybWVkIGVudHJpZXMgc3Vydml2ZSBhIHJlYWQ7IGEgYmFkIGZpbGUgcmVhZHMgYXMgZW1wdHkgYW5kIGlzXG4gICAqIHJlcGxhY2VkIGJ5IHRoZSBuZXh0IHdyaXRlLlxuICAgKi9cbiAgY29uc3QgcmVhZFByZWZzID0gKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPT4ge1xuICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwcmVmc0ZpbGUsIFwidXRmOFwiKSkgYXMgdW5rbm93bjtcbiAgICAgIGlmIChyYXcgJiYgdHlwZW9mIHJhdyA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHJhdykpXG4gICAgICAgICAgaWYgKFBSRUZfS0VZLnRlc3QoaykgJiYgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi5sZW5ndGggPD0gUFJFRl9WQUxVRV9NQVgpIG91dFtrXSA9IHY7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBwcmVmcyB5ZXQsIG9yIHVucmVhZGFibGUg4oCUIGVtcHR5ICovXG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH07XG4gIGNvbnN0IHVzZXJIb21lID0gaG9tZWRpcigpO1xuICBjb25zdCB2aWV3U3RhdGUgPSAoKSA9PiAoeyAuLi5zZXNzaW9uLnZpZXcobW9kZSwgc2VsZWN0aW9uKSwgcHJlZnM6IHJlYWRQcmVmcygpLCB1c2VySG9tZSB9KTtcblxuICAvLyAtLS0gY2hhbm5lbHMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNvY2tldHMgPSBuZXcgU2V0PGltcG9ydChcImJ1blwiKS5TZXJ2ZXJXZWJTb2NrZXQ8dW5rbm93bj4+KCk7XG4gIGNvbnN0IGxvZyA9IGNyZWF0ZUV2ZW50TG9nPExvZ0V2ZW50Pih7IGVwb2NoOiBjcnlwdG8ucmFuZG9tVVVJRCgpIH0pO1xuICBjb25zdCBzc2VDbGllbnRzOiBTc2VDbGllbnRzID0gbmV3IFNldCgpO1xuICBsZXQgbGFzdEFjdGl2aXR5ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIGNvbnN0IHRvdWNoID0gKCkgPT4ge1xuICAgIGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICB9O1xuXG4gIGNvbnN0IHNlbmQgPSAobXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgY29uc3QgYnJvYWRjYXN0U3RhdGUgPSAoKSA9PiBzZW5kKHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZTogdmlld1N0YXRlKCkgfSk7XG5cbiAgLyoqIEEgc3lzdGVtIGxpbmUgaW4gdGhlIGNoYXQg4oCUIGFuZCwgYmVjYXVzZSB0aGUgYWdlbnQgbXVzdCBrbm93IGl0IHRvbywgb24gdGhlIHRhaWwuICovXG4gIGNvbnN0IGFubm91bmNlID0gKHRleHQ6IHN0cmluZywgZmFjdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSkgPT4ge1xuICAgIGNvbnN0IG0gPSBzZXNzaW9uLmFkZE1lc3NhZ2UoXCJzeXN0ZW1cIiwgdGV4dCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcInN5c3RlbVwiLCB0ZXh0LCB0czogbS50cywgLi4uZmFjdCB9KTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICB9O1xuXG4gIC8vIC0tLSB0aGUgd2F0Y2hlciAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvL1xuICAvLyDimqAgREVWSUFUSU9OIEZST00gVEhFIEJSSUVGLCBXSVRIIElUUyBSRUFTT046IGBub2RlOmZzYCBgd2F0Y2hgIChCdW4nc1xuICAvLyBidWlsdC1pbiksIE5PVCBgQHBhcmNlbC93YXRjaGVyYC4gYEBwYXJjZWwvd2F0Y2hlcmAgaXMgYSBuYXRpdmUgYWRkb24gd2hvc2VcbiAgLy8gbG9hZGVyIGRvZXMgYSBydW50aW1lIGByZXF1aXJlKClgIG9mIGEgcGVyLXBsYXRmb3JtIHBhY2thZ2U7IGJ1bmRsZWQgaW50b1xuICAvLyBgZGlzdC9zZXJ2ZXIuanNgIGl0IGlzIG5vdCBpbmxpbmVkLCBzbyB0aGUgc2hpcHBlZCBkYWVtb24gd291bGQgbmVlZCBhXG4gIC8vIGBub2RlX21vZHVsZXNgIHRoZSBtYXJrZXRwbGFjZSBuZXZlciBjb3BpZXMgKGltcG9ydC1ib3VuZGFyeSB3YXJkIDFiJ3NcbiAgLy8gXCJ0aGUgc2hpcHBlZCBleGVjdXRpb24gcGF0aCBjYXJyaWVzIG5vIGRlcGVuZGVuY2llc1wiKS4gTWVhc3VyZWQgdW5kZXIgQnVuXG4gIC8vIDEuNC4wIG9uIG1hY09TIGJlZm9yZSBjaG9vc2luZzogYSByZWN1cnNpdmUgZGlyZWN0b3J5IHdhdGNoIHJlcG9ydHMgYW5cbiAgLy8gaW4tcGxhY2Ugd3JpdGUsIGFuIGF0b21pYyB0bXArcmVuYW1lIHNhdmUsIGFuZCBib3RoIGFnYWluIGluIGFcbiAgLy8gc3ViZGlyZWN0b3J5IOKAlCB0aGUgZm91ciBjYXNlcyBpbnZlc3RpZ2F0aW9uIMKnNSBkcm92ZSBAcGFyY2VsL3dhdGNoZXIgb24uXG4gIC8vIFRoZSBoYXNoLWNvbXBhcmUgYW5kIHNlbGYtd3JpdGUgc3VwcHJlc3Npb24gYXJlIHVuY2hhbmdlZCAoc2Vzc2lvbi50cykuXG4gIGNvbnN0IHdhdGNoZXJzID0gbmV3IE1hcDxzdHJpbmcsIEZTV2F0Y2hlcj4oKTtcbiAgY29uc3QgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pj4oKTtcbiAgY29uc3Qgb25GcyA9IChhYnM6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHQgPSBwZW5kaW5nLmdldChhYnMpO1xuICAgIGlmICh0KSBjbGVhclRpbWVvdXQodCk7XG4gICAgcGVuZGluZy5zZXQoXG4gICAgICBhYnMsXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcGVuZGluZy5kZWxldGUoYWJzKTtcbiAgICAgICAgbGV0IGV2OiBGaWxlRXZlbnQgfCBudWxsID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBldiA9IHNlc3Npb24ub25GaWxlRXZlbnQoYWJzKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBzY3JpcHRvcml1bTogd2F0Y2hlcjogJHtlfVxcbmApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldikgaGFuZGxlRmlsZUV2ZW50KGV2KTtcbiAgICAgIH0sIFdBVENIX1NFVFRMRV9NUyksXG4gICAgKTtcbiAgfTtcbiAgY29uc3Qgc3luY1dhdGNoZXJzID0gKCkgPT4ge1xuICAgIGNvbnN0IHdhbnQgPSBuZXcgTWFwKFxuICAgICAgc2Vzc2lvbi53YXRjaFJvb3RzKCkubWFwKChyKSA9PiBbYCR7ci5yZWN1cnNpdmUgPyBcIlJcIiA6IFwiRlwifToke3Iud2F0Y2h9PiR7ci5wYXRofWAsIHJdKSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgW2tleSwgd10gb2Ygd2F0Y2hlcnMpXG4gICAgICBpZiAoIXdhbnQuaGFzKGtleSkpIHtcbiAgICAgICAgdy5jbG9zZSgpO1xuICAgICAgICB3YXRjaGVycy5kZWxldGUoa2V5KTtcbiAgICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHJdIG9mIHdhbnQpIHtcbiAgICAgIGlmICh3YXRjaGVycy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBXYXRjaGVkIGF0IHRoZSBSRUFMUEFUSCwgcmVwb3J0ZWQgdW5kZXIgdGhlIHN0b3JlZCBwYXRoIGZvcm1cbiAgICAgICAgLy8gKHZlcmlmeS1wYXNzIGZpeCAzIOKAlCBzZWUgU2Vzc2lvbi53YXRjaFJvb3RzKS5cbiAgICAgICAgY29uc3QgdyA9IHdhdGNoKHIud2F0Y2gsIHsgcmVjdXJzaXZlOiByLnJlY3Vyc2l2ZSB9LCAoX2V2ZW50LCBuYW1lKSA9PiB7XG4gICAgICAgICAgaWYgKG5hbWUpIG9uRnMoam9pbihyLnBhdGgsIG5hbWUudG9TdHJpbmcoKSkpO1xuICAgICAgICAgIGVsc2UgaWYgKHIuZW50cnlJZCkgb25GcyhyLnBhdGgpO1xuICAgICAgICB9KTtcbiAgICAgICAgdy5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICAgICAgICAvKiB0aGUgZGlyZWN0b3J5IHdlbnQgYXdheTsgdGhlIG5leHQgc3luYyBkcm9wcyBpdCAqL1xuICAgICAgICB9KTtcbiAgICAgICAgd2F0Y2hlcnMuc2V0KGtleSwgdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdW53YXRjaGFibGUgKGdvbmUsIHBlcm1pc3Npb25zKSDigJQgb3V0c2lkZSBjaGFuZ2VzIHRoZXJlIGdvIHVuc2VlbiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVGaWxlRXZlbnQgPSAoZXY6IEZpbGVFdmVudCkgPT4ge1xuICAgIHN3aXRjaCAoZXYua2luZCkge1xuICAgICAgY2FzZSBcInZlcnNpb24uY2hhbmdlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwidmVyc2lvbi5jcmVhdGVkXCI6XG4gICAgICAgIGFubm91bmNlKGB2JHtldi52ZXJzaW9ufSBvZiAke2V2LmRvY30gYXBwZWFyZWQgKHdyaXR0ZW4gZGlyZWN0bHkgdG8gJHtldi5wYXRofSlgLCB7XG4gICAgICAgICAgZmFjdDogXCJ2ZXJzaW9uLmNyZWF0ZWRcIixcbiAgICAgICAgICBkb2M6IGV2LmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBldi52ZXJzaW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcImFjdGl2ZS5vdXRzaWRlXCI6XG4gICAgICAgIC8vIEUyOiB0aGUgYWdlbnQgbmV2ZXIgd3JpdGVzIHRoZSB2ZXJzaW9uIHRoZSBodW1hbiBpcyBlZGl0aW5nLiBUaGVcbiAgICAgICAgLy8gb3V0c2lkZSB0ZXh0IGlzIEtFUFQgYXMgYSBuZXcgYWdlbnQgdmVyc2lvbiBhbmQgdGhlIGFjdGl2ZSB2ZXJzaW9uXG4gICAgICAgIC8vIGtlZXBzIHRoZSBodW1hbidzIHRleHQg4oCUIG5vdGhpbmcgaXMgbG9zdCwgYW5kIHRoZSBodW1hbidzIGJ1ZmZlciBpc1xuICAgICAgICAvLyBub3QgdG91Y2hlZCAodmVyaWZ5LXBhc3MgZml4IDQpLlxuICAgICAgICBhbm5vdW5jZU91dHNpZGUoZXYuZG9jLCBldi52ZXJzaW9uLCBldi5wYXRoLCBldi5wcmVzZXJ2ZWRBcywgZXYucHJlc2VydmVkUGF0aCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJvcmlnaW5hbC5yZWxvYWRlZFwiOlxuICAgICAgICBzZW5kKHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICAgIHZlcnNpb246IGV2LnZlcnNpb24sXG4gICAgICAgICAgdGV4dDogZXYudGV4dCxcbiAgICAgICAgICBvcmlnaW46IFwicmVtb3RlXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhbm5vdW5jZShgJHtldi5vcmlnaW5hbH0gY2hhbmdlZCBvbiBkaXNrIOKAlCByZWxvYWRlZCAoeW91IGhhZCBubyB1bnNhdmVkIGVkaXRzKS5gLCB7XG4gICAgICAgICAgZmFjdDogXCJvcmlnaW5hbC5yZWxvYWRlZFwiLFxuICAgICAgICAgIGRvYzogZXYuZG9jLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcIm9yaWdpbmFsLmNvbmZsaWN0XCI6XG4gICAgICAgIGFubm91bmNlKFxuICAgICAgICAgIGAke2V2Lm9yaWdpbmFsfSBjaGFuZ2VkIG9uIGRpc2sgd2hpbGUgeW91IGhhdmUgdW5zYXZlZCBlZGl0cy4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggeW91cnM7IFJldmVydCB0YWtlcyB0aGUgZmlsZSdzIHZlcnNpb24uYCxcbiAgICAgICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBldi5kb2MgfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInRyZWVcIjpcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhbm5vdW5jZU91dHNpZGUgPSAoXG4gICAgZG9jOiBzdHJpbmcsXG4gICAgdmVyc2lvbjogbnVtYmVyLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBwcmVzZXJ2ZWRBczogbnVtYmVyLFxuICAgIHByZXNlcnZlZFBhdGg6IHN0cmluZyxcbiAgKSA9PlxuICAgIGFubm91bmNlKFxuICAgICAgYHYke3ZlcnNpb259IG9mICR7ZG9jfSBpcyB0aGUgQUNUSVZFIHZlcnNpb24gYW5kIHdhcyB3cml0dGVuIGZyb20gb3V0c2lkZSB0aGUgZWRpdG9yLiBUaGF0IHRleHQgaXMga2VwdCBhcyB2JHtwcmVzZXJ2ZWRBc307IHRoZSBhY3RpdmUgdmVyc2lvbiBrZWVwcyB5b3VyIHRleHQuIEFnZW50IGVkaXRzIGJlbG9uZyBpbiBhIG5ldyB2ZXJzaW9uICh2ZXJzaW9uLW5ldykuYCxcbiAgICAgIHsgZmFjdDogXCJhY3RpdmUub3V0c2lkZVwiLCBkb2MsIHZlcnNpb24sIHBhdGgsIHByZXNlcnZlZEFzLCBwcmVzZXJ2ZWRQYXRoIH0sXG4gICAgKTtcblxuICAvLyAtLS0gc2hhcmVkIGFjdHMgKHN1cmZhY2UgYW5kIGFnZW50IHJlYWNoIHRoZSBzYW1lIGNvZGUpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBhZGRQYXRocyA9IChwYXRoczogc3RyaW5nW10pID0+IHtcbiAgICBjb25zdCBhZGRlZCA9IHBhdGhzLm1hcCgocCkgPT4gc2Vzc2lvbi5hZGRDb250ZXh0KHApKTtcbiAgICBzeW5jV2F0Y2hlcnMoKTtcbiAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiBhZGRlZDtcbiAgfTtcblxuICBjb25zdCBhY3RpdmF0ZSA9IChkb2M6IHN0cmluZyB8IHVuZGVmaW5lZCwgdmVyc2lvbjogbnVtYmVyLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKSA9PiB7XG4gICAgY29uc3QgciA9IHNlc3Npb24uYWN0aXZhdGUoeyBkb2MsIHZlcnNpb24gfSk7XG4gICAgY29uc3QgdmlldyA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgY29uc3QgcGF0aCA9IHZpZXcudmVyc2lvbnMuZmluZCgodikgPT4gdi5uID09PSB2ZXJzaW9uKT8ucGF0aCA/PyBudWxsO1xuICAgIHNlbmQoe1xuICAgICAgdHlwZTogXCJ2ZXJzaW9uLnRleHRcIixcbiAgICAgIGRvYzogci5zbHVnLFxuICAgICAgdmVyc2lvbixcbiAgICAgIHRleHQ6IHNlc3Npb24ucmVhZFZlcnNpb24oci5zbHVnLCB2ZXJzaW9uKS50ZXh0LFxuICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFxuICAgICAgXCJzeXN0ZW1cIixcbiAgICAgIGAke2J5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwifSBtYWRlIHYke3ZlcnNpb259IG9mICR7ci5zbHVnfSBhY3RpdmUgKHdhcyB2JHtyLnByZXZpb3VzfSkuYCxcbiAgICApO1xuICAgIGxvZy5lbWl0KHsgdHlwZTogXCJhY3RpdmF0ZWRcIiwgYnksIGRvYzogci5zbHVnLCB2ZXJzaW9uLCBwcmV2aW91czogci5wcmV2aW91cywgcGF0aCwgdHM6IG0udHMgfSk7XG4gICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICByZXR1cm4geyBkb2M6IHIuc2x1ZywgdmVyc2lvbiwgcHJldmlvdXM6IHIucHJldmlvdXMsIHBhdGggfTtcbiAgfTtcblxuICAvKipcbiAgICogRTI0OiBvbmUgc3RydWN0dXJlIGNoYW5nZSwgZnJvbSBlaXRoZXIgcGFydHkg4oCUIHRoZSBzYW1lIHNlc3Npb24gbWV0aG9kLCB0aGVcbiAgICogc2FtZSBhbm5vdW5jZW1lbnQgKG5hbWluZyB3aG8gZGlkIGl0KSwgdGhlIHNhbWUgdGFpbCBmYWN0LiBSZXR1cm5zIHRoZSBwYXRoXG4gICAqIHRoZSBjaGFuZ2UgbGFuZGVkIGF0LCB3aGljaCB0aGUgc3VyZmFjZSB1c2VzIHRvIG9wZW4gb3IgcmVuYW1lIGl0LlxuICAgKi9cbiAgY29uc3QgU1RSVUNUVVJFX09QUyA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gICAgXCJkb2MuY3JlYXRlXCIsXG4gICAgXCJmb2xkZXIuY3JlYXRlXCIsXG4gICAgXCJtb3ZlXCIsXG4gICAgXCJyZW5hbWVcIixcbiAgICBcImhpZGVcIixcbiAgICBcInVuaGlkZVwiLFxuICAgIFwic2V0Lm1ha2VcIixcbiAgICBcImltcG9ydFwiLFxuICAgIFwid29ya3NwYWNlLnNldFwiLFxuICBdIHNhdGlzZmllcyBTdHJ1Y3R1cmVPcFtcInR5cGVcIl1bXSk7XG4gIGNvbnN0IGlzU3RydWN0dXJlT3AgPSAobTogeyB0eXBlOiBzdHJpbmcgfSk6IG0gaXMgU3RydWN0dXJlT3AgPT4gU1RSVUNUVVJFX09QUy5oYXMobS50eXBlKTtcblxuICBjb25zdCBzdHJ1Y3R1cmUgPSAob3A6IFN0cnVjdHVyZU9wLCBieTogXCJodW1hblwiIHwgXCJhZ2VudFwiKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IHdobyA9IGJ5ID09PSBcImFnZW50XCIgPyBcIkFnZW50XCIgOiBcIllvdVwiO1xuICAgIGNvbnN0IHNob3duID0gKHA6IHN0cmluZykgPT4gc2Vzc2lvbi5kaXNwbGF5KHApO1xuICAgIGxldCByOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiAmIHsgcGF0aD86IHN0cmluZyB9O1xuICAgIGxldCBsaW5lOiBzdHJpbmc7XG4gICAgc3dpdGNoIChvcC50eXBlKSB7XG4gICAgICBjYXNlIFwiZG9jLmNyZWF0ZVwiOlxuICAgICAgICByID0gc2Vzc2lvbi5jcmVhdGVEb2Mob3AuZGlyLCBvcC5uYW1lKTtcbiAgICAgICAgbGluZSA9IGAke3dob30gY3JlYXRlZCAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJmb2xkZXIuY3JlYXRlXCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmNyZWF0ZUZvbGRlcihvcC5kaXIsIG9wLm5hbWUpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBjcmVhdGVkIHRoZSBmb2xkZXIgJHtzaG93bihyLnBhdGggYXMgc3RyaW5nKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibW92ZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1vdmUob3AucGF0aCwgb3AuaW50byk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBtb3ZlZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVuYW1lXCI6IHtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24ucmVuYW1lKG9wLnBhdGgsIG9wLm5hbWUpO1xuICAgICAgICByID0gbTtcbiAgICAgICAgbGluZSA9IGAke3dob30gcmVuYW1lZCAke3Nob3duKG0uZnJvbSl9IHRvICR7c2hvd24obS5wYXRoKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaGlkZVwiOiB7XG4gICAgICAgIGNvbnN0IGggPSBzZXNzaW9uLmhpZGUob3AucGF0aCk7XG4gICAgICAgIHIgPSBoO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSByZW1vdmVkICR7c2hvd24oaC5wYXRoKX0gZnJvbSBTY3JpcHRvcml1bSAodGhlIGZpbGUgaXMgc3RpbGwgb24gZGlzaykuYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwidW5oaWRlXCI6IHtcbiAgICAgICAgY29uc3QgdSA9IHNlc3Npb24udW5oaWRlKG9wLmVudHJ5KTtcbiAgICAgICAgciA9IHU7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGJyb3VnaHQgYmFjayAke3UucmVzdG9yZWR9IGhpZGRlbiBpdGVtJHt1LnJlc3RvcmVkID09PSAxID8gXCJcIiA6IFwic1wifS5gO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzZXQubWFrZVwiOiB7XG4gICAgICAgIGNvbnN0IG0gPSBzZXNzaW9uLm1ha2VTZXQob3AucGF0aCk7XG4gICAgICAgIHIgPSBtO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSB0dXJuZWQgJHtiYXNlbmFtZShtLnBhdGgpfSBpbnRvIGEgc2V0OiAke3Nob3duKG0uZm9sZGVyKX0uYDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICAgIHIgPSBzZXNzaW9uLmltcG9ydFRleHQob3AubmFtZSwgb3AudGV4dCwgb3AuaW50byk7XG4gICAgICAgIGxpbmUgPSBgJHt3aG99IGNvcGllZCAke29wLm5hbWV9IGluIGFzICR7c2hvd24oci5wYXRoIGFzIHN0cmluZyl9LmA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndvcmtzcGFjZS5zZXRcIjpcbiAgICAgICAgciA9IHNlc3Npb24uc2V0V29ya3NwYWNlKG9wLnBhdGgpO1xuICAgICAgICBsaW5lID0gYCR7d2hvfSBzZXQgdGhlIHdvcmtzcGFjZSB0byAke3Nob3duKHIucGF0aCBhcyBzdHJpbmcpfS5gO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gICAgc3luY1dhdGNoZXJzKCk7XG4gICAgYW5ub3VuY2UobGluZSwgeyBmYWN0OiBvcC50eXBlLCBieSwgLi4uciB9KTtcbiAgICByZXR1cm4gcjtcbiAgfTtcblxuICAvLyAtLS0gc3VyZmFjZSBtZXNzYWdlcyAoV2ViU29ja2V0KSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCByZXBseSA9ICh3czogaW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPiwgbXNnOiBTZXJ2ZXJNc2cpID0+IHtcbiAgICB0cnkge1xuICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShtc2cpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUgKi9cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2xpZW50TXNnID0gKHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LCBtc2c6IENsaWVudE1zZykgPT4ge1xuICAgIGlmIChpc1N0cnVjdHVyZU9wKG1zZykpIHtcbiAgICAgIGNvbnN0IHIgPSBzdHJ1Y3R1cmUoYW5jaG9yU3VyZmFjZVBhdGhzKG1zZyksIFwiaHVtYW5cIik7XG4gICAgICBpZiAodHlwZW9mIHIucGF0aCA9PT0gXCJzdHJpbmdcIilcbiAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJzdHJ1Y3R1cmUuZG9uZVwiLCBvcDogbXNnLnR5cGUsIHBhdGg6IHIucGF0aCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgICAgY2FzZSBcIm9wZW5cIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5vcGVuUGF0aChtc2cucGF0aCk7XG4gICAgICAgIHN5bmNXYXRjaGVycygpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAvLyBUaGUgb3BlbmVyIGdldHMgdGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBzdHJhaWdodCBhd2F5IOKAlCB0aGUgc3RhdGVcbiAgICAgICAgLy8gc25hcHNob3QgY2FycmllcyBubyB0ZXh0cywgYW5kIGEgdmlld2VyIG11c3Qgbm90IHdhaXQgb24gYSBzZWNvbmQgYXNrLlxuICAgICAgICB7XG4gICAgICAgICAgY29uc3QgZCA9IHNlc3Npb24uZG9jKHIuc2x1Zyk7XG4gICAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgICBkb2M6IHIuc2x1ZyxcbiAgICAgICAgICAgIHZlcnNpb246IGQuYWN0aXZlLFxuICAgICAgICAgICAgdGV4dDogc2Vzc2lvbi5yZWFkVmVyc2lvbihyLnNsdWcsIGQuYWN0aXZlKS50ZXh0LFxuICAgICAgICAgICAgb3JpZ2luOiBcImxvYWRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoci5jcmVhdGVkKVxuICAgICAgICAgIGxvZy5lbWl0KHsgdHlwZTogXCJkb2Mub3BlbmVkXCIsIGRvYzogci5zbHVnLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoci5zbHVnKSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm9wZW4uZG9jXCI6XG4gICAgICAgIHNlc3Npb24ub3BlblNsdWcobXNnLmRvYyk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJlZGl0XCI6IHtcbiAgICAgICAgY29uc3QgciA9IHNlc3Npb24uZWRpdChtc2cuZG9jLCBtc2cudmVyc2lvbiwgbXNnLnRleHQpO1xuICAgICAgICBpZiAoci5wcmVzZXJ2ZWQpIHtcbiAgICAgICAgICBjb25zdCBkID0gc2Vzc2lvbi5kb2MobXNnLmRvYyk7XG4gICAgICAgICAgYW5ub3VuY2VPdXRzaWRlKFxuICAgICAgICAgICAgZC5zbHVnLFxuICAgICAgICAgICAgbXNnLnZlcnNpb24sXG4gICAgICAgICAgICBzZXNzaW9uLmFjdGl2ZVBhdGgoZC5zbHVnKSA/PyBcIlwiLFxuICAgICAgICAgICAgci5wcmVzZXJ2ZWQubixcbiAgICAgICAgICAgIHIucHJlc2VydmVkLnBhdGgsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIGlmIChyLmRpcnR5Q2hhbmdlZCkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcInNlbGVjdFwiOlxuICAgICAgICAvLyBBTUJJRU5UIHN0YXRlOiBzdG9yZWQgYW5kIHNob3duLCBuZXZlciBwdXNoZWQgb250byB0aGUgYWdlbnQncyB0YWlsLlxuICAgICAgICBzZWxlY3Rpb24gPSBtc2cuc2VsZWN0aW9uO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IG1zZy50ZXh0LnRyaW0oKTtcbiAgICAgICAgaWYgKCF0ZXh0KSByZXR1cm47XG4gICAgICAgIGNvbnN0IHNlbCA9IG1zZy53aXRoU2VsZWN0aW9uID8gc2VsZWN0aW9uIDogbnVsbDtcbiAgICAgICAgY29uc3QgYWN0aXZlUGF0aCA9IHNlbCA/IHNlc3Npb24uYWN0aXZlUGF0aChzZWwuZG9jKSA6IHNlc3Npb24uYWN0aXZlUGF0aCgpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiaHVtYW5cIiwgdGV4dCwgeyBzZWxlY3Rpb246IHNlbCwgYWN0aXZlUGF0aCB9KTtcbiAgICAgICAgbG9nLmVtaXQoe1xuICAgICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICAgIG1lc3NhZ2VfaWQ6IG0uaWQsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBzZWxlY3Rpb246IHNlbCxcbiAgICAgICAgICBhY3RpdmU6IGFjdGl2ZU9mKHNlbD8uZG9jKSxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJhY3RpdmF0ZVwiOlxuICAgICAgICBhY3RpdmF0ZShtc2cuZG9jLCBtc2cudmVyc2lvbiwgXCJodW1hblwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInNhdmVcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5zYXZlKG1zZy5kb2MpO1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwic3lzdGVtXCIsIGBTYXZlZCB2JHtyLnZlcnNpb259IHRvICR7ci5vcmlnaW5hbH0uYCk7XG4gICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICB0eXBlOiBcInNhdmVkXCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICBvcmlnaW5hbDogci5vcmlnaW5hbCxcbiAgICAgICAgICB0czogbS50cyxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJyZXZlcnRcIjoge1xuICAgICAgICBjb25zdCByID0gc2Vzc2lvbi5yZXZlcnQobXNnLmRvYyk7XG4gICAgICAgIHNlbmQoe1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi50ZXh0XCIsXG4gICAgICAgICAgZG9jOiBtc2cuZG9jLFxuICAgICAgICAgIHZlcnNpb246IHIudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiByLnRleHQsXG4gICAgICAgICAgb3JpZ2luOiBcInJlbW90ZVwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbSA9IHNlc3Npb24uYWRkTWVzc2FnZShcbiAgICAgICAgICBcInN5c3RlbVwiLFxuICAgICAgICAgIGBSZXZlcnRlZCB2JHtyLnZlcnNpb259IG9mICR7bXNnLmRvY30gdG8gdGhlIHNhdmVkIGZpbGUuYCxcbiAgICAgICAgKTtcbiAgICAgICAgbG9nLmVtaXQoeyB0eXBlOiBcInJldmVydGVkXCIsIGRvYzogbXNnLmRvYywgdmVyc2lvbjogci52ZXJzaW9uLCB0czogbS50cyB9KTtcbiAgICAgICAgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FzZSBcImNvbnRleHQuYWRkXCI6XG4gICAgICAgIGFkZFBhdGhzKFtzdXJmYWNlUGF0aChtc2cucGF0aCldKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBcInJldmVhbFwiOiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBzZXNzaW9uLnNob3duUGF0aChzdXJmYWNlUGF0aChtc2cucGF0aCkpO1xuICAgICAgICAvLyBBbiBhcmd2LCBuZXZlciBhIHNoZWxsIHN0cmluZzogdGhlIHBhdGggaXMgZGF0YSwgd2hhdGV2ZXIgaXQgaG9sZHMuXG4gICAgICAgIGNvbnN0IFtjbWQsIC4uLmFyZ3NdID1cbiAgICAgICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiXG4gICAgICAgICAgICA/IFtcIm9wZW5cIiwgXCItUlwiLCBwYXRoXVxuICAgICAgICAgICAgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCJcbiAgICAgICAgICAgICAgPyBbXCJleHBsb3JlclwiLCBgL3NlbGVjdCwke3BhdGh9YF1cbiAgICAgICAgICAgICAgOiBbXCJ4ZGctb3BlblwiLCBkaXJuYW1lKHBhdGgpXTtcbiAgICAgICAgQnVuLnNwYXduKFtjbWQgYXMgc3RyaW5nLCAuLi5hcmdzXSwgeyBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdIH0pLnVucmVmKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwaWNrXCI6IHtcbiAgICAgICAgdm9pZCBvcGVuUGlja2VyKHdzLCBtc2cud2FudCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb250ZXh0LnJlbW92ZVwiOlxuICAgICAgICBzZXNzaW9uLnJlbW92ZUNvbnRleHQobXNnLmlkKTtcbiAgICAgICAgc3luY1dhdGNoZXJzKCk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgXCJyZWFkXCI6IHtcbiAgICAgICAgcmVwbHkod3MsIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24udGV4dFwiLFxuICAgICAgICAgIGRvYzogbXNnLmRvYyxcbiAgICAgICAgICB2ZXJzaW9uOiBtc2cudmVyc2lvbixcbiAgICAgICAgICB0ZXh0OiBzZXNzaW9uLnJlYWRWZXJzaW9uKG1zZy5kb2MsIG1zZy52ZXJzaW9uKS50ZXh0LFxuICAgICAgICAgIG9yaWdpbjogXCJsb2FkXCIsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJlZnMuc2V0XCI6IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFQUkVGX0tFWS50ZXN0KG1zZy5rZXkpIHx8XG4gICAgICAgICAgdHlwZW9mIG1zZy52YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICAgICAgIG1zZy52YWx1ZS5sZW5ndGggPiBQUkVGX1ZBTFVFX01BWFxuICAgICAgICApXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZWZ1c2VkIHByZWYgJHtKU09OLnN0cmluZ2lmeShtc2cua2V5KX1gKTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHJlYWRQcmVmcygpO1xuICAgICAgICBpZiAoY3VycmVudFttc2cua2V5XSA9PT0gbXNnLnZhbHVlKSByZXR1cm47XG4gICAgICAgIGlmICghKG1zZy5rZXkgaW4gY3VycmVudCkgJiYgT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoID49IFBSRUZfS0VZU19NQVgpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYHJlZnVzZWQgcHJlZiAke0pTT04uc3RyaW5naWZ5KG1zZy5rZXkpfTogJHtQUkVGX0tFWVNfTUFYfSBrZXlzIGFscmVhZHkga2VwdGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgd3JpdGVGaWxlQXRvbWljKFxuICAgICAgICAgIHByZWZzRmlsZSxcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IC4uLmN1cnJlbnQsIFttc2cua2V5XTogbXNnLnZhbHVlIH0sIG51bGwsIDIpfVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmcy5saXN0XCI6IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGV4cGFuZEhvbWUobXNnLnBhdGgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7IHR5cGU6IFwiZnMubGlzdFwiLCBwYXRoOiBtc2cucGF0aCwgZW50cmllczogbGlzdERpcihwYXRoKSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlcGx5KHdzLCB7XG4gICAgICAgICAgICB0eXBlOiBcImZzLmxpc3RcIixcbiAgICAgICAgICAgIHBhdGg6IG1zZy5wYXRoLFxuICAgICAgICAgICAgZW50cmllczogW10sXG4gICAgICAgICAgICBlcnJvcjogU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgbmF0aXZlIHBpY2tlciAob25lIGRpYWxvZyBhdCBhIHRpbWUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvL1xuICAvLyBBIG1vZGFsIGRpYWxvZyBvd25zIHRoZSBodW1hbidzIGF0dGVudGlvbiwgYW5kIGEgc2Vjb25kIG9uZSBiZWhpbmQgdGhlXG4gIC8vIGZpcnN0IGNhbm5vdCBiZSBzZWVuIG9yIGRpc21pc3NlZCDigJQgc28gYSByZXF1ZXN0IHdoaWxlIG9uZSBpcyBvcGVuIGlzXG4gIC8vIHJlZnVzZWQgaW4gd29yZHMgcmF0aGVyIHRoYW4gcXVldWVkLlxuICBsZXQgcGlja2VyT3BlbiA9IGZhbHNlO1xuICBjb25zdCB6ZW5pdHkgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIgPyBCdW4ud2hpY2goXCJ6ZW5pdHlcIikgOiBudWxsO1xuICBjb25zdCBvcGVuUGlja2VyID0gYXN5bmMgKFxuICAgIHdzOiBpbXBvcnQoXCJidW5cIikuU2VydmVyV2ViU29ja2V0PHVua25vd24+LFxuICAgIHdhbnQ6IFwiY29udGV4dC1maWxlXCIgfCBcImNvbnRleHQtZm9sZGVyXCIgfCBcIndvcmtzcGFjZVwiLFxuICApID0+IHtcbiAgICBpZiAocGlja2VyT3Blbikge1xuICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBcImEgZmlsZSBwaWNrZXIgaXMgYWxyZWFkeSBvcGVuXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGtpbmQ6IFBpY2tLaW5kID0gd2FudCA9PT0gXCJjb250ZXh0LWZpbGVcIiA/IFwiZmlsZVwiIDogXCJmb2xkZXJcIjtcbiAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgd2FudCA9PT0gXCJ3b3Jrc3BhY2VcIlxuICAgICAgICA/IFwiQ2hvb3NlIHRoZSB3b3Jrc3BhY2UgZm9sZGVyIGZvciBzY3JpcHRvcml1bVwiXG4gICAgICAgIDogd2FudCA9PT0gXCJjb250ZXh0LWZvbGRlclwiXG4gICAgICAgICAgPyBcIkNob29zZSBhIGZvbGRlciB0byBhZGQgdG8gc2NyaXB0b3JpdW1cIlxuICAgICAgICAgIDogXCJDaG9vc2UgZG9jdW1lbnRzIHRvIGFkZCB0byBzY3JpcHRvcml1bVwiO1xuICAgIGNvbnN0IGNtZCA9IHBpY2tlckNvbW1hbmQocHJvY2Vzcy5wbGF0Zm9ybSwga2luZCwgcHJvbXB0LCB6ZW5pdHkpO1xuICAgIGlmICghY21kKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBubyBmaWxlIHBpY2tlciBvbiB0aGlzIHN5c3RlbSAoJHtwcm9jZXNzLnBsYXRmb3JtfSkg4oCUIHR5cGUgdGhlIHBhdGggaW5zdGVhZGAsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcGlja2VyT3BlbiA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oY21kLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIsIHN0ZGluOiBcImlnbm9yZVwiIH0pO1xuICAgICAgY29uc3QgW291dCwgY29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgICB0b3VjaCgpOyAvLyBhIGh1bWFuIHN0b29kIGF0IGEgZGlhbG9nOyB0aGUgc2Vzc2lvbiBpcyBub3QgaWRsZVxuICAgICAgY29uc3QgcGF0aHMgPSBwYXJzZVBpY2tlck91dHB1dChvdXQpO1xuICAgICAgaWYgKHBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBDYW5jZWxsZWQ6IG5vdGhpbmcgY2hvc2VuLCBub3RoaW5nIHNhaWQuIEEgcmVhbCBmYWlsdXJlIGlzIHNhaWQuXG4gICAgICAgIGlmICghd2FzQ2FuY2VsbGVkKGNvZGUsIG91dCkpXG4gICAgICAgICAgcmVwbHkod3MsIHsgdHlwZTogXCJlcnJvclwiLCBtZXNzYWdlOiBgdGhlIGZpbGUgcGlja2VyIGZhaWxlZCAoZXhpdCAke2NvZGV9KWAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFdoYXQgd2FzIGNob3NlbiBpcyBhZG1pdHRlZCBsaWtlIGFueSBvdGhlciBwYXRoIOKAlCBhIHBpY2tlZCBmaWxlIHRoYXRcbiAgICAgIC8vIHNjcmlwdG9yaXVtIGRvZXMgbm90IG9wZW4gaXMgcmVmdXNlZCBpbiB0aGUgc2lkZWJhcidzIG93biB3b3JkcywgYW5kXG4gICAgICAvLyB0aGF0IHJlZnVzYWwgbXVzdCBub3QgcmVhZCBhcyBcInRoZSBwaWNrZXIgZmFpbGVkXCIuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAod2FudCA9PT0gXCJ3b3Jrc3BhY2VcIilcbiAgICAgICAgICBzdHJ1Y3R1cmUoeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcGF0aHNbMF0gYXMgc3RyaW5nIH0sIFwiaHVtYW5cIik7XG4gICAgICAgIGVsc2UgYWRkUGF0aHMocGF0aHMpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXBseSh3cywge1xuICAgICAgICB0eXBlOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGBjb3VsZCBub3Qgb3BlbiB0aGUgZmlsZSBwaWNrZXI6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcGlja2VyT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBhY3RpdmVPZiA9IChkb2M/OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbHVnID0gZG9jID8/IHNlc3Npb24ub3BlbkRvY1NsdWc7XG4gICAgaWYgKCFzbHVnKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IHNlc3Npb24uZG9jKHNsdWcpO1xuICAgICAgcmV0dXJuIHsgZG9jOiB2LnNsdWcsIHZlcnNpb246IHYuYWN0aXZlLCBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgodi5zbHVnKSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBhZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgaGFuZGxlQWdlbnRDbWQgPSAoY21kOiBBZ2VudENtZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBpZiAoaXNTdHJ1Y3R1cmVPcChjbWQpKSByZXR1cm4gc3RydWN0dXJlKGNtZCwgXCJhZ2VudFwiKTtcbiAgICBzd2l0Y2ggKGNtZC50eXBlKSB7XG4gICAgICBjYXNlIFwiY29udGV4dC5hZGRcIjoge1xuICAgICAgICBjb25zdCBhZGRlZCA9IGFkZFBhdGhzKGNtZC5wYXRocyk7XG4gICAgICAgIHJldHVybiB7IGVudHJpZXM6IGFkZGVkLm1hcCgoYSkgPT4gKHsgLi4uYS5lbnRyeSwgYWRkZWQ6IGEuYWRkZWQgfSkpIH07XG4gICAgICB9XG4gICAgICBjYXNlIFwidmVyc2lvbi5uZXdcIjoge1xuICAgICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDc6IHRoZSBhZ2VudCBtYXkgbmFtZSBhIGRvYyB0aGUgaHVtYW4gaGFzIG5vdFxuICAgICAgICAvLyBvcGVuZWQsIGJ5IEFCU09MVVRFIHBhdGggKHRoZSBDTEkgcmVzb2x2ZXMgaXQgYWdhaW5zdCBpdHMgb3duIGN3ZCk7XG4gICAgICAgIC8vIGl0IGlzIG9wZW5lZCBpbXBsaWNpdGx5IHVuZGVyIHRoZSBzYW1lIGFkbWlzc2lvbiBydWxlIGFzIHRoZVxuICAgICAgICAvLyBzdXJmYWNlJ3MgYG9wZW5gIOKAlCBhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSDigJQgd2l0aG91dFxuICAgICAgICAvLyBtb3ZpbmcgdGhlIGh1bWFuJ3Mgb3BlbiBkb2N1bWVudC5cbiAgICAgICAgaWYgKGNtZC5kb2MgJiYgaXNBYnNvbHV0ZShjbWQuZG9jKSAmJiAhc2Vzc2lvbi5maW5kRG9jKGNtZC5kb2MpKSB7XG4gICAgICAgICAgY29uc3QgbyA9IHNlc3Npb24ub3BlblBhdGgoY21kLmRvYywgeyBmb2N1czogZmFsc2UgfSk7XG4gICAgICAgICAgaWYgKG8uY3JlYXRlZClcbiAgICAgICAgICAgIGxvZy5lbWl0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJkb2Mub3BlbmVkXCIsXG4gICAgICAgICAgICAgIGRvYzogby5zbHVnLFxuICAgICAgICAgICAgICBwYXRoOiBzZXNzaW9uLmFjdGl2ZVBhdGgoby5zbHVnKSxcbiAgICAgICAgICAgICAgYnk6IFwiYWdlbnRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHIgPSBzZXNzaW9uLm5ld1ZlcnNpb24oe1xuICAgICAgICAgIGRvYzogY21kLmRvYyxcbiAgICAgICAgICBmcm9tOiBjbWQuZnJvbSxcbiAgICAgICAgICBsYWJlbDogY21kLmxhYmVsLFxuICAgICAgICAgIGF1dGhvcjogXCJhZ2VudFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYW5ub3VuY2UoXG4gICAgICAgICAgYEFnZW50IGNyZWF0ZWQgdiR7ci52ZXJzaW9uLm59IG9mICR7ci5zbHVnfSBmcm9tIHYke3IudmVyc2lvbi5mcm9tfSR7Y21kLmxhYmVsID8gYCDigJQgJHtjbWQubGFiZWx9YCA6IFwiXCJ9LmAsXG4gICAgICAgICAgeyBmYWN0OiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IHIuc2x1ZywgdmVyc2lvbjogci52ZXJzaW9uLm4gfSxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgZG9jOiByLnNsdWcsIHZlcnNpb246IHIudmVyc2lvbi5uLCBmcm9tOiByLnZlcnNpb24uZnJvbSwgcGF0aDogci52ZXJzaW9uLnBhdGggfTtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgICBjb25zdCBtID0gc2Vzc2lvbi5hZGRNZXNzYWdlKFwiYWdlbnRcIiwgY21kLnRleHQpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICByZXR1cm4geyBpZDogbS5pZCB9O1xuICAgICAgfVxuICAgICAgY2FzZSBcImFjdGl2YXRlXCI6XG4gICAgICAgIHJldHVybiBhY3RpdmF0ZShjbWQuZG9jLCBjbWQudmVyc2lvbiwgXCJhZ2VudFwiKTtcbiAgICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIHJlYXNvbjogXCJjbG9zZVwiIH0pO1xuICAgICAgICByZXR1cm4ge307XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICAgIGB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlICR7SlNPTi5zdHJpbmdpZnkoKGNtZCBhcyB7IHR5cGU/OiB1bmtub3duIH0pLnR5cGUpfSDigJQgbm90aGluZyB3YXMgYXBwbGllZGAsXG4gICAgICAgICAgNDAwLFxuICAgICAgICAgIFtcImNvbnRleHQuYWRkXCIsIFwidmVyc2lvbi5uZXdcIiwgXCJzYXlcIiwgXCJhY3RpdmF0ZVwiLCBcImNsb3NlXCIsIC4uLlNUUlVDVFVSRV9PUFNdLFxuICAgICAgICApO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCByZWZ1c2FsID0gKGU6IHVua25vd24pOiBSZXNwb25zZSA9PiB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBTZXNzaW9uRXJyb3IpXG4gICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgeyBvazogZmFsc2UsIGVycm9yOiBlLm1lc3NhZ2UsIC4uLihlLmNob2ljZXMgPyB7IGNob2ljZXM6IGUuY2hvaWNlcyB9IDoge30pIH0sXG4gICAgICAgIHsgc3RhdHVzOiBlLnN0YXR1cyB9LFxuICAgICAgKTtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFBhdGhFcnJvcilcbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoZSkgfSwgeyBzdGF0dXM6IDUwMCB9KTtcbiAgfTtcblxuICBjb25zdCBldmVudHNSZXNwb25zZSA9IChyZXE6IFJlcXVlc3QsIHVybDogVVJMKTogUmVzcG9uc2UgPT4ge1xuICAgIHRvdWNoKCk7XG4gICAgcmV0dXJuIHNzZVJlc3BvbnNlKHtcbiAgICAgIGxvZyxcbiAgICAgIHNpbmNlOiBOdW1iZXIucGFyc2VJbnQodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzaW5jZVwiKSA/PyBcIi0xXCIsIDEwKSxcbiAgICAgIGhlYXJ0YmVhdE1zOiBTU0VfSEVBUlRCRUFUX01TLFxuICAgICAgY2xpZW50czogc3NlQ2xpZW50cyxcbiAgICAgIHNpZ25hbDogcmVxLnNpZ25hbCxcbiAgICAgIG9uT3BlbjogdG91Y2gsXG4gICAgICBvbkNsb3NlOiB0b3VjaCxcbiAgICB9KTtcbiAgfTtcblxuICAvLyAtLS0gc2VydmUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzZXJ2ZXIgPSBCdW4uc2VydmUoe1xuICAgIHBvcnQ6IG9wdHMucG9ydCA/PyAwLFxuICAgIGhvc3RuYW1lOiBcIjEyNy4wLjAuMVwiLFxuICAgIHJvdXRlcyxcbiAgICBpZGxlVGltZW91dDogSURMRV9USU1FT1VUX1NFQyxcbiAgICBkZXZlbG9wbWVudDogeyBobXI6IG1vZGUgPT09IFwiZGV2XCIgfSxcbiAgICBmZXRjaChyZXEsIHNydikge1xuICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsKTtcbiAgICAgIGNvbnN0IHBhdGggPSB1cmwucGF0aG5hbWU7XG4gICAgICAvLyDim5QgVkVSSUZZLVBBU1MgRklYIDFhIOKAlCBBIEZPUkVJR04gT1JJR0lOIElTIFJFRlVTRUQuIEFueSB3ZWIgcGFnZSB0aGVcbiAgICAgIC8vIGh1bWFuIHZpc2l0cyBjYW4gb3BlbiBhIFdlYlNvY2tldCBvciBQT1NUIHRvIDEyNy4wLjAuMTsgdGhlIGJyb3dzZXJcbiAgICAgIC8vIHNlbmRzIGl0cyBPcmlnaW4sIGFuZCBvbmx5IHRoaXMgZGFlbW9uJ3Mgb3duIHBhZ2UgbWF5IGRyaXZlIGl0LiBUaGVcbiAgICAgIC8vIENMSSdzIGZldGNoIHNlbmRzIG5vIE9yaWdpbiBhdCBhbGwsIHNvIGl0IGlzIHVuYWZmZWN0ZWQuXG4gICAgICBpZiAoXG4gICAgICAgIChwYXRoID09PSBcIi93c1wiIHx8IHBhdGggPT09IFwiL2NtZFwiIHx8IHBhdGguc3RhcnRzV2l0aChcIi9mcy9cIikpICYmXG4gICAgICAgICFzYW1lT3JpZ2luKHJlcSwgc3J2LnBvcnQpXG4gICAgICApXG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJmb3JlaWduIG9yaWdpbiByZWZ1c2VkXCIgfSwgeyBzdGF0dXM6IDQwMyB9KTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSB2aWV3U3RhdGUoKTtcbiAgICAgICAgY29uc3QgZnVsbCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZnVsbFwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAuLi5zdGF0ZSxcbiAgICAgICAgICBjaGF0OiBmdWxsID8gc3RhdGUuY2hhdCA6IHN0YXRlLmNoYXQuc2xpY2UoLTEwKSxcbiAgICAgICAgICBjaGF0VG90YWw6IHN0YXRlLmNoYXQubGVuZ3RoLFxuICAgICAgICAgIGFjdGl2ZTogYWN0aXZlT2YoKSxcbiAgICAgICAgICBjdXJzb3I6IGxvZy5jdXJzb3IoKSxcbiAgICAgICAgICBlcG9jaDogbG9nLmVwb2NoLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2V2ZW50c1wiKSByZXR1cm4gZXZlbnRzUmVzcG9uc2UocmVxLCB1cmwpO1xuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvZnMvdmVyc2lvblwiKSB7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgciA9IHNlc3Npb24ucmVhZFZlcnNpb24oXG4gICAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmdldChcImRvY1wiKSA/PyBcIlwiLFxuICAgICAgICAgICAgTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwidlwiKSA/PyBcIlwiLCAxMCksXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihyKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJldHVybiByZWZ1c2FsKGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9mcy9saXN0XCIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgICBlbnRyaWVzOiBsaXN0RGlyKGV4cGFuZEhvbWUodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJwYXRoXCIpID8/IFwiflwiKSksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSkgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL2NtZFwiKVxuICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgLmpzb24oKVxuICAgICAgICAgIC50aGVuKChiKSA9PiB7XG4gICAgICAgICAgICB0b3VjaCgpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgLi4uaGFuZGxlQWdlbnRDbWQoYiBhcyBBZ2VudENtZCkgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIHJldHVybiByZWZ1c2FsKGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKCgpID0+IFJlc3BvbnNlLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBcImJhZCBqc29uXCIgfSwgeyBzdGF0dXM6IDQwMCB9KSk7XG4gICAgICBpZiAobW9kZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgIGlmIChhc3NldCkgcmV0dXJuIGFzc2V0O1xuICAgICAgfVxuICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBlcnJvcjogXCJub3QgZm91bmRcIiB9LCB7IHN0YXR1czogNDA0IH0pO1xuICAgIH0sXG4gICAgd2Vic29ja2V0OiB7XG4gICAgICBvcGVuKHdzKSB7XG4gICAgICAgIHNvY2tldHMuYWRkKHdzKTtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGU6IHZpZXdTdGF0ZSgpIH0pKTtcbiAgICAgIH0sXG4gICAgICBtZXNzYWdlKHdzLCByYXcpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgbGV0IG1zZzogQ2xpZW50TXNnO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIG1zZyA9IEpTT04ucGFyc2UoXG4gICAgICAgICAgICB0eXBlb2YgcmF3ID09PSBcInN0cmluZ1wiID8gcmF3IDogbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJhdyksXG4gICAgICAgICAgKSBhcyBDbGllbnRNc2c7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgc2NyaXB0b3JpdW06IGJhZCBqc29uIGZyb20gYnJvd3NlcjogJHtlfVxcbmApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyh3cywgbXNnKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIEEgcmVmdXNhbCB0aGUgaHVtYW4gY2F1c2VkIChlZGl0IGEgbm9uLWFjdGl2ZSB2ZXJzaW9uLCBvcGVuIGFcbiAgICAgICAgICAvLyB2YW5pc2hlZCBmaWxlKSByZWFjaGVzIFRIRU0sIGFzIGEgY2hhdC12aXNpYmxlIHN5c3RlbSBsaW5lIHdvdWxkIGJlXG4gICAgICAgICAgLy8gdG9vIGxvdWQgZm9yIGEga2V5c3Ryb2tlIOKAlCBzbyBpdCBpcyBhbiBlcnJvciBmcmFtZSB0aGUgc3VyZmFjZSBzaG93cy5cbiAgICAgICAgICByZXBseSh3cywgeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgYm91bmRQb3J0ID0gc2VydmVyLnBvcnQ7XG4gIC8vIC0tLSBkaXNjb3ZlcnkgKEUxMzogc2Vzc2lvbi1KU09OLCB0aGUgb25seSBjb252ZW50aW9uIHRoYXQgY2FuIGV4cHJlc3Mgc2V2ZXJhbCkgLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgc2NyaXB0b3JpdW0tJHtzZXNzaW9uSWR9Lmpzb25gKTtcbiAgY29uc3QgbGF0ZXN0RmlsZSA9IGpvaW4odG1wZGlyKCksIFwic2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25cIik7XG4gIGNvbnN0IGluZm8gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2JvdW5kUG9ydH1gLFxuICAgIHBvcnQ6IGJvdW5kUG9ydCxcbiAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgaG9tZSxcbiAgICBkaXI6IHNlc3Npb24uZGlyLFxuICAgIG1vZGUsXG4gIH0pO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZUF0b21pYyhzZXNzaW9uRmlsZSwgaW5mbyk7XG4gICAgd3JpdGVGaWxlQXRvbWljKGxhdGVzdEZpbGUsIGluZm8pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBkaXNjb3ZlcnkgaXMgYmVzdC1lZmZvcnQgKi9cbiAgfVxuXG4gIHN5bmNXYXRjaGVycygpO1xuICBsb2cuZW1pdCh7IHR5cGU6IFwicmVhZHlcIiwgbW9kZSwgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLCByZXN0b3JlZDogISFvcHRzLnJlc3RvcmUgfSk7XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCAyOiB3aGF0IGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLlxuICBmb3IgKGNvbnN0IGYgb2Ygc2Vzc2lvbi5yZXN0b3JlRmluZGluZ3MpXG4gICAgYW5ub3VuY2UoXG4gICAgICBmLm1pc3NpbmdcbiAgICAgICAgPyBgJHtmLm9yaWdpbmFsfSBpcyBnb25lIGZyb20gZGlzayBzaW5jZSB0aGlzIHNlc3Npb24gd2FzIGxhc3Qgb3Blbi4gU2F2ZSB3b3VsZCByZWNyZWF0ZSBpdDsgUmV2ZXJ0IGNhbm5vdCBydW4uYFxuICAgICAgICA6IGAke2Yub3JpZ2luYWx9IGNoYW5nZWQgb24gZGlzayB3aGlsZSB0aGlzIHNlc3Npb24gd2FzIGNsb3NlZC4gU2F2ZSBvdmVyd3JpdGVzIGl0IHdpdGggdGhlIGFjdGl2ZSB2ZXJzaW9uOyBSZXZlcnQgdGFrZXMgdGhlIGZpbGUncyB2ZXJzaW9uLmAsXG4gICAgICB7IGZhY3Q6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBmLmRvYywgd2hpbGVDbG9zZWQ6IHRydWUgfSxcbiAgICApO1xuXG4gIGNvbnN0IHN0b3BIb3VzZWtlZXBpbmcgPSBzdGFydEhvdXNla2VlcGluZyh7XG4gICAgc3Vic2NyaWJlckNvdW50OiAoKSA9PiBzb2NrZXRzLnNpemUgKyBzc2VDbGllbnRzLnNpemUsXG4gICAgaWRsZU1zOiAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSxcbiAgICB0b3VjaCxcbiAgICB0aW1lb3V0TXM6IChvcHRzLnRpbWVvdXRTID8/IDE4MDApICogMTAwMCxcbiAgICBvbklkbGVDbG9zZTogKCkgPT4gcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSksXG4gIH0pO1xuXG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgbGV0IHJlc29sdmVTaHV0ZG93biE6ICgpID0+IHZvaWQ7XG4gIGNvbnN0IHNodXRkb3duID0gbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHtcbiAgICByZXNvbHZlU2h1dGRvd24gPSByO1xuICB9KTtcblxuICBjb25zdCBjbGVhbnVwRGlzY292ZXJ5ID0gKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKHNlc3Npb25GaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGdvbmUg4oCUIGZpbmUgKi9cbiAgICB9XG4gICAgdW5saW5rSWZNYXRjaGVzKGxhdGVzdEZpbGUsIHNlc3Npb25JZCwgKHJhdykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaWQgPSAoSlNPTi5wYXJzZShyYXcpIGFzIHsgc2Vzc2lvbl9pZD86IHVua25vd24gfSkuc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBpZCA9PT0gXCJzdHJpbmdcIiA/IGlkIDogbnVsbDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvLyBUaGUgb3JkZXIgaXMgdGhlIGhlYWRlcidzLCBhbmQgdGhlIGhlYWRlciBzYXlzIHdoeS5cbiAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgc3RvcEhvdXNla2VlcGluZygpO1xuICAgIGZvciAoY29uc3QgdyBvZiB3YXRjaGVycy52YWx1ZXMoKSkgdy5jbG9zZSgpO1xuICAgIHdhdGNoZXJzLmNsZWFyKCk7XG4gICAgZm9yIChjb25zdCB0IG9mIHBlbmRpbmcudmFsdWVzKCkpIGNsZWFyVGltZW91dCh0KTtcbiAgICB0cnkge1xuICAgICAgc2Vzc2lvbi5wZXJzaXN0KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgICBjbGVhbnVwRGlzY292ZXJ5KCk7XG4gICAgbG9nLmVtaXQoeyB0eXBlOiBcImNsb3NlZFwiIH0pO1xuICAgIHZvaWQgZHJhaW5BbmRTdG9wKHsgc2VydmVyLCBjbGllbnRzOiBzc2VDbGllbnRzLCBzb2NrZXRzIH0pLnRoZW4ocmVzb2x2ZVNodXRkb3duKTtcbiAgfTtcbiAgZG9uZS50aGVuKCgpID0+IGNsb3NlKCkpO1xuXG4gIHJldHVybiB7IHBvcnQ6IGJvdW5kUG9ydCwgc2Vzc2lvbklkLCBtb2RlLCBkaXI6IHNlc3Npb24uZGlyLCBjbG9zZSwgZG9uZSwgc2h1dGRvd24gfTtcbn1cblxuLyoqIEFuIGFic2VudCBPcmlnaW4gKHRoZSBDTEksIGN1cmwpIG9yIHRoaXMgZGFlbW9uJ3Mgb3duIHBhZ2U7IG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW1lT3JpZ2luKHJlcTogUmVxdWVzdCwgcG9ydDogbnVtYmVyIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGNvbnN0IG9yaWdpbiA9IHJlcS5oZWFkZXJzLmdldChcIm9yaWdpblwiKTtcbiAgaWYgKG9yaWdpbiA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBvcmlnaW4gPT09IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gIHx8IG9yaWdpbiA9PT0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWA7XG59XG5cbi8qKlxuICogQSBwYXRoIHR5cGVkIGluIHRoZSBTVVJGQUNFLiBUaGUgcGFnZSBoYXMgbm8gd29ya2luZyBkaXJlY3RvcnksIHNvIGEgcGF0aFxuICogZnJvbSBpdCBtdXN0IGJlIGFic29sdXRlIG9yIHN0YXJ0IGF0IGB+YCDigJQgd2hpY2ggaXMgZXhwYW5kZWQgSEVSRS4gQmVmb3JlXG4gKiB0aGlzLCBgfi9Eb2N1bWVudHNgIHJlYWNoZWQgYHJlc29sdmUoKWAgYW5kIHdhcyB0YWtlbiBhcyByZWxhdGl2ZSB0byB0aGVcbiAqIGRhZW1vbidzIGN3ZCAodGhlIHNraWxsIGZvbGRlcik6IHRoZSBwYXRoIGJveCBjb21wbGV0ZWQgYH4v4oCmYCAobGlzdGluZ1xuICogZXhwYW5kcyBpdCkgYW5kIHRoZW4gRW50ZXIgZmFpbGVkIHdpdGggXCJubyBzdWNoIGZpbGUgb3IgZm9sZGVyOlxuICog4oCmL3NraWxscy9zY3JpcHRvcml1bS9+L0RvY3VtZW50cy/igKZcIiAoQ29sZSwgMjAyNi0wOS0xMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdXJmYWNlUGF0aChwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0ID0gcC50cmltKCk7XG4gIGlmICh0ID09PSBcIn5cIiB8fCB0LnN0YXJ0c1dpdGgoXCJ+L1wiKSkgcmV0dXJuIGV4cGFuZEhvbWUodCk7XG4gIGlmICghaXNBYnNvbHV0ZSh0KSlcbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBcIiR7cH1cIiBpcyBub3QgYSBmdWxsIHBhdGgg4oCUIHN0YXJ0IGl0IHdpdGggLyBvciB+L2AsIDQwMCk7XG4gIHJldHVybiByZXNvbHZlKHQpO1xufVxuXG4vKiogQSBzdHJ1Y3R1cmUgb3AgZnJvbSB0aGUgc3VyZmFjZSwgd2l0aCBldmVyeSBwYXRoIGZpZWxkIHRocm91Z2ggYHN1cmZhY2VQYXRoYC4gKi9cbmZ1bmN0aW9uIGFuY2hvclN1cmZhY2VQYXRocyhvcDogU3RydWN0dXJlT3ApOiBTdHJ1Y3R1cmVPcCB7XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLm9wIH07XG4gIGZvciAoY29uc3QgayBvZiBbXCJkaXJcIiwgXCJwYXRoXCIsIFwiaW50b1wiXSBhcyBjb25zdClcbiAgICBpZiAodHlwZW9mIG91dFtrXSA9PT0gXCJzdHJpbmdcIikgb3V0W2tdID0gc3VyZmFjZVBhdGgob3V0W2tdIGFzIHN0cmluZyk7XG4gIHJldHVybiBvdXQgYXMgU3RydWN0dXJlT3A7XG59XG5cbmZ1bmN0aW9uIGV4cGFuZEhvbWUocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHAgPT09IFwiflwiKSByZXR1cm4gaG9tZWRpcigpO1xuICBpZiAocC5zdGFydHNXaXRoKFwifi9cIikpIHJldHVybiBqb2luKGhvbWVkaXIoKSwgcC5zbGljZSgyKSk7XG4gIHJldHVybiByZXNvbHZlKHApO1xufVxuXG4vKiogVGhlIGRhZW1vbidzIHByaXZhdGUgYXJndiDigJQgdGhlIENMSSBzcGF3bnMgaXQgd2l0aCBleGFjdGx5IHRoZXNlLiAqL1xuY29uc3QgREFFTU9OX09QVElPTlMgPSB7XG4gIGxvZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHdvcmtzcGFjZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG4vKiogUGFyc2UgdGhlIGRhZW1vbidzIGFyZ3YsIGJvb3QsIHByaW50IHRoZSBoYW5kc2hha2UsIHdhaXQgZm9yIHRoZSBlbmQuIFJldHVybnMgdGhlIGV4aXQgY29kZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICB0cnkge1xuICAgIGZsYWdzID0gbm9kZVBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IERBRU1PTl9PUFRJT05TLCBzdHJpY3Q6IHRydWUgfSkudmFsdWVzIGFzIFJlY29yZDxcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyB8IHVuZGVmaW5lZFxuICAgID47XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBzY3JpcHRvcml1bTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKFxuICAgICAgICBEQUVNT05fT1BUSU9OUyxcbiAgICAgIClcbiAgICAgICAgLm1hcCgoaykgPT4gYC0tJHtrfWApXG4gICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgbGV0IGQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2Ygc3RhcnREYWVtb24+PjtcbiAgdHJ5IHtcbiAgICBkID0gYXdhaXQgc3RhcnREYWVtb24oe1xuICAgICAgcG9ydDogZmxhZ3MucG9ydCA/IE51bWJlcihmbGFncy5wb3J0KSA6IDAsXG4gICAgICByZXN0b3JlOiBmbGFncy5yZXN0b3JlLFxuICAgICAgdGltZW91dFM6IGZsYWdzLnRpbWVvdXQgPyBOdW1iZXIoZmxhZ3MudGltZW91dCkgOiB1bmRlZmluZWQsXG4gICAgICB3b3Jrc3BhY2U6IGZsYWdzLndvcmtzcGFjZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIFRoZSBoYW5kc2hha2UgbGluZSBpcyBKU09OIGVpdGhlciB3YXksIHNvIHRoZSBDTEkgcmVhZHMgT05FIHNoYXBlLlxuICAgIGNvbnN0IHN0YXR1cyA9IGUgaW5zdGFuY2VvZiBTZXNzaW9uRXJyb3IgPyBlLnN0YXR1cyA6IDUwMDtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBzdGF0dXMsIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSl9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiBzdGF0dXMgPT09IDQwNCA/IDUgOiBzdGF0dXMgPT09IDQwOSA/IDYgOiAxO1xuICB9XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2QucG9ydH1gLCBwb3J0OiBkLnBvcnQsIHNlc3Npb25faWQ6IGQuc2Vzc2lvbklkLCBtb2RlOiBkLm1vZGUsIGRpcjogZC5kaXIgfSl9XFxuYCxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZC5kb25lO1xuICBhd2FpdCBkLnNodXRkb3duO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogYSBjbGVhbiBjbG9zZSBsZWF2ZXMgbm8gZW1wdHkgbG9nIGJlaGluZC5cbiAgaWYgKHJlcy5jb2RlID09PSAwICYmIGZsYWdzLmxvZykge1xuICAgIHRyeSB7XG4gICAgICBpZiAoc3RhdFN5bmMoZmxhZ3MubG9nKS5zaXplID09PSAwKSB1bmxpbmtTeW5jKGZsYWdzLmxvZyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlcy5jb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZVxuICogYnVuZGxlLCBzbyB0aGVyZSBpcyBubyBzdWNoIGJsb2NrIGhlcmUsIGFuZCB0aGlzIHRha2VzIG5vIGFyZ3VtZW50czogdGhlXG4gKiBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSB0d28gcHJpbWl0aXZlcyB1bmRlciBCT1RIIG9mIHRoZSBob3VzZSdzIGRhZW1vbi1kaXNjb3ZlcnkgY29udmVudGlvbnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiBEMyBydWxlZCB0aGF0IHRoZSBjb252ZW50aW9ucyB0aGVtc2VsdmVzIOKAlCBwZXItc2Vzc2lvbiB0bXBkaXIgSlNPTiAoYm91bnR5LFxuICogZ2xhbW91ciwgaW1hZ28sIG1hZ3BpZSkgYW5kIHNpbmdsZXRvbiBgJEhPTUUvZGFlbW9uLnBvcnRgICsgYGRhZW1vbi5waWRgXG4gKiAoYXN0cm9sYWJlLCBncmFwZXZpbmUsIG1pbmQtbWFwcGVyKSDigJQgYm90aCBzdXJ2aXZlLCBiZWNhdXNlIHRoZXkgZW5jb2RlXG4gKiBnZW51aW5lbHkgZGlmZmVyZW50IG1vZGVscyAoY29uY3VycmVudCBzZXNzaW9ucyB2cyBhIHN0YW5kaW5nIHNpbmdsZXRvbikgYW5kXG4gKiBwaWNraW5nIG9uZSBpcyBhIHByb2R1Y3QgZGVjaXNpb24sIG5vdCBhIGZhY3RvcmluZyBvbmUuIFdoYXQgSVMgb25lXG4gKiBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgcGFpciBiZWxvdywgd2hpY2ggaXMgYWxzbyBleGFjdGx5IHdoZXJlIGNlbnN1cyBkZWZlY3RcbiAqICoqTDMqKiBsaXZlcy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgdW5saW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5cbi8qKlxuICogV3JpdGUgYHRleHRgIHRvIGB0YXJnZXRgIGF0b21pY2FsbHk6IHdyaXRlIGJlc2lkZSBpdCwgdGhlbiByZW5hbWUuXG4gKlxuICog4puUICoqTDMsIENMT1NFRCBCWSBDT05TVFJVQ1RJT04uKiogQSBiYXJlIGB3cml0ZUZpbGVTeW5jYCBpcyBub3QgYXRvbWljLCBzbyBhXG4gKiBDTEkgcmVhZGluZyB3aGlsZSB0aGUgZGFlbW9uIHdyaXRlcyBjYW4gb2JzZXJ2ZSBhIEhBTEYtV1JJVFRFTiBwb2ludGVyLiBVbmRlclxuICogYSBiZXN0LWVmZm9ydCByZWFkZXIgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiIOKAlCBhYnNlbmNlIHJlcG9ydGVkXG4gKiBmb3Igd2hhdCB3YXMgcmVhbGx5IGEgdG9ybiByZWFkLCB3aGljaCBpcyB0aGUgZXhhY3QgY29uZmxhdGlvbiB0aGUgaG91c2Unc1xuICogYG51bGxgLW5vdC1gMGAgcnVsZSBleGlzdHMgdG8gcHJldmVudC4gUmVuYW1lIHdpdGhpbiBvbmUgZGlyZWN0b3J5IGlzIGF0b21pYyxcbiAqIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLCBuZXZlciBhIHBhcnRpYWxcbiAqIGZpbGUuXG4gKlxuICogRml4ZWQgaW4gZ2xhbW91ciAyMDI2LTA5LTA3LCBmb3VuZCBzdGFuZGluZyBpbiB0aHJlZSBzaWJsaW5ncyB0aGUgbmV4dCBkYXkgYnlcbiAqIHRoZSBkdXBsaWNhdGlvbiByZWNvbiwgYW5kIHJlcGFpcmVkIGluIGFsbCBvZiB0aGVtIHRoZSBvbmx5IHdheSB0aGF0IGRvZXMgbm90XG4gKiBuZWVkIGZpbmRpbmcgYWdhaW46IHRoZXJlIGlzIG5vdyBvbmUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4pqgIFRoZSB0ZW1wIG5hbWUgY2FycmllcyB0aGUgcGlkLCBzbyB0d28gZGFlbW9ucyByYWNpbmcgdG8gcHVibGlzaCB0aGUgc2FtZVxuICogcG9pbnRlciBjYW5ub3QgY2xvYmJlciBlYWNoIG90aGVyJ3MgaW50ZXJtZWRpYXRlIGZpbGUg4oCUIGFuZCBpdCBpcyByZW1vdmVkIG9uXG4gKiBhIGZhaWxlZCB3cml0ZSByYXRoZXIgdGhhbiBsZWZ0IGFzIGxpdHRlciBiZXNpZGUgdGhlIHJlYWwgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVGaWxlQXRvbWljKHRhcmdldDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModG1wLCB0ZXh0KTtcbiAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiB0aGUgdGVtcCBmaWxlIGlzIGFscmVhZHkgZ29uZSwgb3Igd2FzIG5ldmVyIGNyZWF0ZWQgKi9cbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogRGVsZXRlIGBwYXRoYCBpZmYgaXQgc3RpbGwgbmFtZXMgVVMuIFJldHVybnMgd2hldGhlciBpdCB3YXMgZGVsZXRlZC5cbiAqXG4gKiDim5QgKipcIlNUSUxMIE9VUlNcIiBJUyBUSEUgV0hPTEUgRlVOQ1RJT04uKiogQSBkYWVtb24gdGhhdCB1bmxpbmtzIGl0cyBkaXNjb3ZlcnlcbiAqIGZpbGUgdW5jb25kaXRpb25hbGx5IGF0IGV4aXQgZGVsZXRlcyB0aGUgcG9pbnRlciBhIFNVQ0NFU1NPUiBoYXMgYWxyZWFkeVxuICogd3JpdHRlbiDigJQgdGhlIHN1Y2Nlc3NvciBjYW4gdGhlbiBubyBsb25nZXIgYmUgZm91bmQgYW5kIHRoZSBuZXh0IENMSSB2ZXJiIHNwYXducyBhXG4gKiB0aGlyZCBkYWVtb24uIEJvdGggY29udmVudGlvbnMgaGF2ZSB0aGlzIGhhemFyZCBhbmQgYm90aCBleHByZXNzIGl0XG4gKiBkaWZmZXJlbnRseTogYXN0cm9sYWJlIGNvbXBhcmVzIHRoZSBwaWQgZmlsZSdzIGJ5dGVzIHRvIGl0cyBvd24gcGlkLFxuICogbWFncGllIHBhcnNlcyB0aGUgSlNPTiBwb2ludGVyIGFuZCBjb21wYXJlcyBgc2Vzc2lvbl9pZGAuIGBpZGVudGlmeWAgaXMgd2hhdFxuICogbWFrZXMgdGhvc2Ugb25lIGZ1bmN0aW9uIOKAlCBpdCB0dXJucyB0aGUgZmlsZSdzIGJ5dGVzIGludG8gdGhlIGlkZW50aXR5IHRvXG4gKiBjb21wYXJlLCBhbmQgaXQgZGVmYXVsdHMgdG8gdGhlIHRyaW1tZWQgYnl0ZXMgdGhlbXNlbHZlcy5cbiAqXG4gKiDimqAgRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgYW5kIHJlcG9ydGVkIGFzIGBmYWxzZWA6IHRoZSBmaWxlIGJlaW5nIGdvbmUsXG4gKiB1bnJlYWRhYmxlLCBvciB1bnBhcnNlYWJsZSBhbGwgbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlIOKAlCBpdCBpcyBub3Qgb3VycyB0b1xuICogcmVtb3ZlLiBBbiB1bnBhcnNlYWJsZSBwb2ludGVyIGlzIGRlbGliZXJhdGVseSBOT1QgdHJlYXRlZCBhcyBvdXJzLCB3aGljaCBpc1xuICogdGhlIGNvbnNlcnZhdGl2ZSBoYWxmIG9mIHRoZSBzYW1lIGBudWxsYC1ub3QtYDBgIHJ1bGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmxpbmtJZk1hdGNoZXMoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IHN0cmluZyxcbiAgaWRlbnRpZnk6IChyYXc6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbCA9IChyYXcpID0+IHJhdy50cmltKCksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaWRlbnRpZnkocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSkgIT09IGV4cGVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdW5saW5rU3luYyhwYXRoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIGluLXByb2Nlc3MgZXZlbnQgbG9nIOKAlCB0aGUgYXBwZW5kLW9ubHksIHJlcGxheWFibGUgYnVmZmVyXG4gKiBiZWhpbmQgZXZlcnkgc3BlbGwncyBgR0VUIC9ldmVudHNgIFNTRSB0YWlsLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICogQ29udmVyZ2VkIDIwMjYtMDktMDggKFBoYXNlIDFiIGNoYXB0ZXIgMikgVE9XQVJEIG1pbmQtbWFwcGVyJ3NcbiAqIGBzY3JpcHRzL2V2ZW50cy50c2Ag4oCUIHRoZSBjZW5zdXMncyBjb252ZXJnZW5jZSB0YXJnZXQgIzIsIGFuZCB0aGUgb25seSBvbmUgb2ZcbiAqIHRoZSBzaXggY29waWVkLWluLXBsYWNlIGJ1c2VzIHRoYXQgaXMgYSBtb2R1bGUsIGlzIGJvdW5kZWQsIGNhcnJpZXMgYW4gZXBvY2gsIGFuZCBpc1xuICogdW5pdC10ZXN0ZWQuIFRoZSBmaXZlIG90aGVycyBhcmUgdGhlIHNhbWUgdHdlbnR5IGxpbmVzIHdyaXR0ZW4gZml2ZSB0aW1lcy5cbiAqXG4gKiDilIDilIAgVEhFIFRIUkVFIFRISU5HUyBUSElTIEZJWEVTIOKAlCBUV08gQlkgQ09OU1RSVUNUSU9OLCBPTkUgQlkgT1BULUlOIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIOKblCBUSEUgSEVBRElORyBVU0VEIFRPIFNBWSBcIlRIRSBUSFJFRSBUSElOR1MgVEhJUyBGSVhFUyBCWSBDT05TVFJVQ1RJT05cIiBBTkRcbiAqIElURU0gMiBJUyBOT1QgT05FIE9GIFRIRU0uIENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIG1pbmQtbWFwcGVyJ3MgcHJlLXdvcmtcbiAqIChENzkpOiBgZXBvY2hgIGlzIE9QVElPTkFMIGhlcmUsIHNvIEw2IGlzIGNsb3NlZCBvbmx5IGZvciBhIGNhbGxlciB0aGF0IGFza3MuXG4gKiBUaHJlZSBhZG9wdGVycyBoYXZlIHNpbmNlIGRlY2xpbmVkIHRvIOKAlCBpbWFnbyAoRDM5KSwgYm91bnR5IChENDgpIGFuZFxuICogZ3JhcGV2aW5lIChENzApIOKAlCBzbyB0aGUgZGVmZWN0IHRoZSBoZWFkaW5nIGNsYWltZWQgdG8gbWFrZSBpbXBvc3NpYmxlIGlzXG4gKiBsaXZlIGluIHRoZSB0cmVlLCBieSBvcHQtb3V0LCBhbmQgdGhlIG92ZXJjbGFpbSBpcyB3aGF0IGhpZCB0aGF0LiBJdGVtcyAxIGFuZFxuICogMyBBUkUgYnkgY29uc3RydWN0aW9uOiBhIGNhbGxlciBjYW5ub3Qgc3dpdGNoIHRoZSBjYXAgb2ZmIG9yIHJlYWNoIHRoZSBidWZmZXIuXG4gKlxuICog4pqgIEFORCBNSU5ELU1BUFBFUidTIE9XTiBCVVMsIFdISUNIIFRISVMgTU9EVUxFIENPTlZFUkdFRCBUT1dBUkQsIFRZUEVTIFRIRVxuICogRVBPQ0ggQVMgUkVRVUlSRUQgYW5kIHN0YW1wcyBpdCB1bmNvbmRpdGlvbmFsbHkg4oCUIGl0IGlzIHRoZSBzcGVsbCBjZW5zdXMgTDZcbiAqIG5hbWVzIGFzIENPUlJFQ1QuIE1ha2luZyBpdCByZXF1aXJlZCBIRVJFIGlzIG5vdCB0aGUgcmVwYWlyOiBpdCB3b3VsZCByZXZlcnNlXG4gKiBEMzksIEQ0OCBhbmQgRDcwLiBUaGUgaG9uZXN0IHN0YXRlbWVudCBpcyB0aGlzIGhlYWRpbmcuXG4gKlxuICog4puUICoqUkVTT0xWRUQgQVQgVEhBVCBTUEVMTCdTIFBPUlQsIEFORCBUSEUgRElTUE9TSVRJT04gSVMgUkVDT1JERUQgSEVSRVxuICogQkVDQVVTRSBBIExPU1MgVEhBVCBMSVZFUyBPTkxZIElOIEEgSk9VUk5BTCBJUyBBIExPU1MgTk9CT0RZIENBTiBTRUVcbiAqIChENzkvRDg1KS4qKiBtaW5kLW1hcHBlciBhZG9wdGVkIHRoaXMgbW9kdWxlIGluIFBoYXNlIDcgYW5kIGtlcHQgaXRzXG4gKiBndWFyYW50ZWUgV0lUSE9VVCBBIEtJVCBDSEFOR0U6IGl0IHBhc3NlcyBgeyBlcG9jaDogY3J5cHRvLnJhbmRvbVVVSUQoKSB9YCBhdFxuICogaXRzIE9ORSBjb25zdHJ1Y3Rpb24gc2l0ZSBhbmQgcmUtdGlnaHRlbnMgYGVwb2NoYCB0byBSRVFVSVJFRCBpbiBpdHMgb3duXG4gKiBsb2NhbCBmcmFtZSB0eXBlLCBzbyBub3RoaW5nIGl0cyBidXMgZW1pdHMgY2FuIGxhY2sgb25lLiBLaXQgYnl0ZXM6IHplcm8uXG4gKiAqKlNvIHRoZSBlcG9jaCBpcyBhIExPU1NZLUNPUFkgcHJvcGVydHkgd2hvc2UgZGlzcG9zaXRpb24gaXMgS0VFUC1MT0NBTCwgbm90XG4gKiBSRVNUT1JFKiog4oCUIHRoZSBvbmx5IHByb3BlcnR5IG9mIHRoYXQgc3BlbGwncyBvd24gbW9kdWxlIHRoaXMgbW9kdWxlIGNvdWxkXG4gKiBub3QgY2FycnkgYW5kIGRpZCBub3QgbmVlZCB0by4gTDYgaXMgQ0xPU0VEIGZvciB0aGUgdHdvIHNwZWxscyB0aGF0IGFzayBhbmRcbiAqIE9QRU4sIGJ5IG9wdC1vdXQsIGZvciB0aGUgdGhyZWUgdGhhdCBkZWNsaW5lOyB0aGF0IGFzeW1tZXRyeSBpcyB0aGUgaG9uZXN0XG4gKiBzdGF0ZSBhbmQgdGhpcyBoZWFkaW5nIGlzIHdoZXJlIGl0IGlzIHdyaXR0ZW4uXG4gKlxuICog4pqgICoqQU5EIFRIRSBBRE9QVElPTiBSRU5BTUVTIEEgRklFTEQgT04gQU4gQURPUFRFUidTIFBVQkxJU0hFRCBXSVJFLioqIGBpZGBcbiAqIGlzIG5hbWVkIGluIGBGcmFtZTxUPmAgYW5kIGluIHRoZSBlbWl0IGxpdGVyYWwgYmVsb3csIHNvIGEgc3BlbGwgd2hvc2UgYnVzXG4gKiBzcGVsbGVkIHRoZSBjdXJzb3IgYW55dGhpbmcgZWxzZSBwYXlzIGEgcmVuYW1lIGF0IGV2ZXJ5IHJlYWRlciDigJQgZm9yXG4gKiBtaW5kLW1hcHBlciwgMTczIG9jY3VycmVuY2VzIGFjcm9zcyA1IHN1cmZhY2UgZmlsZXMsIH4yMDkgYWNyb3NzIH4zMCBiYWNrZW5kXG4gKiBmaWxlcywgZXZlcnkgSlNPTkwgbGluZSBpdHMgYHRhaWxgIHdyaXRlcyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgYW5kICh0aGUgb25lXG4gKiBub2JvZHkgY291bnRlZCkgdGhlIEZJWFRVUkUgaW4gaXRzIG93biBgdGFpbC50ZXN0LnRzYCwgd2hpY2ggV1JJVEVTIHRoZVxuICogZW52ZWxvcGUgd2hpbGUgc3RhbmRpbmcgaW4gZm9yIHRoZSBkYWVtb24uIFRoZSBORVNUSU5HIGlzIG5vdCBmb3JjZWQg4oCUXG4gKiBgRnJhbWU8VD5gIGlzIGdlbmVyaWMsIGFuZCBtaW5kLW1hcHBlciBrZXB0IGB7a2luZCwgcGF5bG9hZH1gIG5lc3RlZCB3aGVyZSBhbGxcbiAqIGZpdmUgZWFybGllciBhZG9wdGVycyBmbGF0dGVuIGJ5IGlkaW9tLiAqKkFuIGlkaW9tIGZpdmUgc2libGluZ3Mgc2hhcmUgaXNcbiAqIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBjb250cmFjdCB1bnRpbCB5b3Ugb3BlbiB0aGUgdHlwZSoqIChEODEsIEQ4NikuXG4gKlxuICogKioxIMK3IEw1IOKAlCB0aGUgYnVmZmVyIGlzIGJvdW5kZWQuKiogRml2ZSBkYWVtb25zIGFwcGVuZCB0byBhbiBhcnJheSBmb3IgdGhlXG4gKiB3aG9sZSBsaWZlIG9mIHRoZSBwcm9jZXNzLiBUaGUgd2luZG93IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiBkYWVtb24ncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2c7IGEgY2FwIGlzIHRoZSBob25lc3Qgc2hhcGUuXG4gKlxuICogKioyIMK3IEw2IOKAlCBhIGZyYW1lIGNhcnJpZXMgYW4gZXBvY2gsIFdIRU4gVEhFIENBTExFUiBBU0tTIEZPUiBPTkUgKG9wdC1pbixcbiAqIG5vdCBjb25zdHJ1Y3Rpb24g4oCUIHNlZSBhYm92ZSkuKiogQWZ0ZXIgYSByZXN0YXJ0IHRoZSBpZHMgc3RhcnQgYWdhaW4gYXQgMSwgc29cbiAqIGEgcmVzdW1pbmcgY2xpZW50IGNhbm5vdCB0ZWxsIGEgc3RhbGUgd2F0ZXJtYXJrIGZyb20gYSBmcmVzaCBvbmUgYnkgaWQgYWxvbmUuXG4gKlxuICogKiozIMK3IEEgU1RBTEUgV0FURVJNQVJLIFJFUExBWVMgRlJPTSBUSEUgQkVHSU5OSU5HLCBhbmQgdGhpcyBpcyB0aGUgaGFsZiB0aGVcbiAqIGNsaWVudCBjYW5ub3QgZG8uKiogTUVBU1VSRUQgb24gYXN0cm9sYWJlOiBhIHRhaWwgdGhhdCByZXN1bWVzIGF0XG4gKiBgc2luY2U9PGxhc3QgaWQgb2YgdGhlIHByZXZpb3VzIGRhZW1vbj5gIGFnYWluc3QgYSByZXN0YXJ0ZWQgZGFlbW9uIHJlY2VpdmVzXG4gKiBOT1RISU5HIOKAlCB0aGUgbmV3IGRhZW1vbidzIGByZWFkeWAgaXMgaWQgMSwgd2hpY2ggaXMgbm90IGA+IHNpbmNlYCwgc28gdGhlXG4gKiBmaWx0ZXIgZHJvcHMgaXQsIHNvIG5vIGZyYW1lIGFycml2ZXMsIHNvIHRoZSBjbGllbnQncyBlcG9jaCBjaGVjayBuZXZlciBydW5zXG4gKiBhbmQgdGhlIHRhaWwgc2l0cyBjb25uZWN0ZWQgYW5kIHNpbGVudCB1bnRpbCB0aGUgbmV3IGRhZW1vbiBoYXMgZW1pdHRlZCBhc1xuICogbWFueSBldmVudHMgYXMgdGhlIG9sZCBvbmUgZGlkLiBTdGFtcGluZyBhbiBlcG9jaCBhbG9uZSBkb2VzIE5PVCBjbG9zZSB0aGF0XG4gKiBnYXA6IHRoZSBlcG9jaCByaWRlcyBhIGZyYW1lLCBhbmQgdGhlIGJ1ZyBpcyB0aGF0IG5vIGZyYW1lIGlzIHNlbnQuIFNvXG4gKiBgc3Vic2NyaWJlYCB0cmVhdHMgYHNpbmNlID4gY3Vyc29yYCBhcyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYW5vdGhlciBwcm9jZXNzXCJcbiAqIGFuZCByZXBsYXlzIHdob2xlLiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvdGFpbC50ZXN0LnRzYCdzIGVwb2NoIGNlbGwgaXMgdGhlXG4gKiBleGVjdXRhYmxlIHNwZWMgb2YgdGhlIGNsaWVudCBoYWxmIGFuZCBzaG93cyB0aGUgcmVjb25uZWN0IHN0aWxsIGNhcnJ5aW5nIHRoZVxuICogc3RhbGUgY3Vyc29yIOKAlCBkZXRlY3Rpb24gaGFwcGVucyBvbiB3aGF0IGlzIFJFQ0VJVkVELlxuICpcbiAqIOKUgOKUgCDim5QgR1JBUEVWSU5FIERPRVMgTk9UIEFET1BUIFRISVMsIEFORCBUSEUgUkVGVVNBTCBJUyBQQVJUIE9GIFRIRSBSVUxJTkcg4pSA4pSAXG4gKlxuICogUkVKRUNULVNUUlVDVFVSQUwsIHJ1bGVkIGF0IGdyYXBldmluZSdzIHBvcnQgKFBoYXNlIDYsIDIwMjYtMDktMDk7IEQ2OCkuIE5vdFxuICogXCJubyBzdWJqZWN0XCIg4oCUIGdyYXBldmluZSBIQVMgYW4gZXZlbnQgYnVzIGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGVcbiAqIHNwZWxsIOKAlCBidXQgdGhlIHR3byBzaGFwZXMgY2Fubm90IGJlIGNvbnN0cnVjdGVkIGZyb20gZWFjaCBvdGhlcjpcbiAqXG4gKiAgIHRoaXMgbW9kdWxlICBvbmUgcHJvY2Vzcy13aWRlIGFycmF5IGNhcHBlZCBhdCBSRVBMQVlfQlVGRkVSX1NJWkUsIHdpdGggb25lXG4gKiAgICAgICAgICAgICAgICBtb25vdG9uaWMgYHNlcWAsIGFuZCB0aGUgaGVhZGVyIHRocmVlIHBhcmFncmFwaHMgdXAgc2F5cyBpbiBhc1xuICogICAgICAgICAgICAgICAgbWFueSB3b3JkcyB0aGF0IGl0IGlzIGEgUkVQTEFZIHdpbmRvdyBmb3IgcmVjb25uZWN0cyB3aXRoaW4gb25lXG4gKiAgICAgICAgICAgICAgICBkYWVtb24ncyBsaWZldGltZSwgTk9UIGEgZHVyYWJsZSBsb2cuXG4gKiAgIGdyYXBldmluZSAgICBOIGR1cmFibGUgYXBwZW5kLW9ubHkgYC5qc29ubGAgZmlsZXMsIG9uZSBwZXIgbmFtZWQgY2hhbm5lbCxcbiAqICAgICAgICAgICAgICAgIGVhY2ggd2l0aCBpdHMgb3duIGBuZXh0X2lkYCwgcmVwbGF5ZWQgZnJvbSBkaXNrIGJ5XG4gKiAgICAgICAgICAgICAgICBgcmVhZEJhY2tsb2dgLCBzdXJ2aXZpbmcgcmVzdGFydCwgYHJvbGxgLCBhcmNoaXZlIGFuZCBjbGVhci5cbiAqXG4gKiAqKlRoZSByZWFkZXIgdGhhdCBtYWtlcyB0aGVtIGluY29tcGF0aWJsZSwgYXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhbiBhblxuICogYXNzZXJ0aW9uOioqIGdyYXBldmluZSdzIGBsb2FkQ2hhbm5lbCgpYCBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIEhJR0gtV0FURVJcbiAqIE1BUksgb3ZlciBldmVyeSBwYXJzZWFibGUgbGluZSBvZiB0aGUgY2hhbm5lbCdzIGZpbGUgb24gYm9vdC4gVGhlcmUgaXMgbm9cbiAqIGFycmF5IHRvIGJlIHRoYXQgbWFyayBvZiwgYW5kIG5vIGNhcCB0aGF0IHdvdWxkIG5vdCBzaWxlbnRseSBkaXNjYXJkIGhpc3RvcnlcbiAqIGEgY2FsbGVyIGNhbiBzdGlsbCBhc2sgZm9yIGJ5IGlkLiBJdCBpcyB0aGUgdGhpbmcgdGhpcyBtb2R1bGUncyBvd24gaGVhZGVyXG4gKiBzYXlzIGl0IGlzIGRlbGliZXJhdGVseSBub3QuXG4gKlxuICogKipUaGUgd2lkZW5pbmcgTk9UIGRvbmUsIHdpdGggaXRzIGNvc3Q6KiogYWRtaXR0aW5nIGEgcGVyLWNoYW5uZWwgZHVyYWJsZVxuICogc3RvcmUgd291bGQgY2hhbmdlIGBjcmVhdGVFdmVudExvZ2AncyBzdG9yYWdlIGFuZCBpdHMgYHN1YnNjcmliZWAgY29udHJhY3QgZm9yXG4gKiBmaXZlIG90aGVyIGRhZW1vbnMsIHJlLWVtaXR0aW5nIFNJWCBhcnRpZmFjdHMgYWNyb3NzIEZJVkUgc3BlbGxzLCBlYWNoIG93ZWQgYVxuICogZHJpdmUg4oCUIHBhaWQgYnkgcG9ydHMgdGhhdCBhcmUgYWxyZWFkeSBmaW5pc2hlZCBhbmQgYnkgYWdlbnRzIG5vdCBpbiB0aGUgcm9vbS5cbiAqIEEgd2lkZW5pbmcgcmVtYWlucyBhdmFpbGFibGUgYXMgaXRzIG93biBhcmd1ZWQgZGVjaXNpb24gd2l0aCBpdHMgb3duXG4gKiBibGFzdC1yYWRpdXMgY291bnQ7IGl0IGlzIG5ldmVyIGEgc3RlcCBpbnNpZGUgYSBwb3J0LlxuICpcbiAqIOKaoCBBTkQgVEhFIGBlcG9jaGAgQUJPVkUgSVMgVEhFIFNIQVJQRVNUIEhBTEYgT0YgV0hZIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlXG4gKiBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCwgc28gdGhlIGNvbmRpdGlvbiBwYXJhZ3JhcGggMiBkZXNjcmliZXMg4oCUIGlkc1xuICogc3RhcnRpbmcgYWdhaW4gYXQgMSDigJQgY2Fubm90IG9jY3VyIHRoZXJlLCBhbmQgc3RhbXBpbmcgb25lIGFueXdheSBpcyBub3RcbiAqIGluZXJ0OiBgdGFpbEV2ZW50c2AncyBgb25FcG9jaENoYW5nZWAgc2V0cyB0aGUgY3Vyc29yIHRvIDAsIGFuZCBncmFwZXZpbmUnc1xuICogdGFpbCByb3V0ZSBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoIHRoZSBXSE9MRSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhblxuICogYWdlbnQncyBwaXBlLCBvbiBldmVyeSBgcm9sbGAuIFRoZSBlcG9jaCdzIGNsaWVudC1zaWRlIGFjdGlvbiBpcyBcInlvdXIgY3Vyc29yXG4gKiBpcyB3b3J0aGxlc3MsIHN0YXJ0IG92ZXJcIiwgYW5kIHRoYXQgaXMgc2FmZSBvbmx5IHdoZXJlIHN0YXJ0aW5nIG92ZXIgY29zdHMgYVxuICogYm91bmRlZCBpbi1tZW1vcnkgcmVwbGF5IHdpbmRvdy5cbiAqL1xuXG4vKiogVGhlIGRlZmF1bHQgcmVwbGF5IHdpbmRvdywgaW5oZXJpdGVkIGZyb20gbWluZC1tYXBwZXIncyBtZWFzdXJlZCBjYXAuICovXG5leHBvcnQgY29uc3QgUkVQTEFZX0JVRkZFUl9TSVpFID0gMTAwMDtcblxuLyoqIEEgZnJhbWUgYXMgaXQgZ29lcyBvbiB0aGUgd2lyZTogdGhlIGNhbGxlcidzIHBheWxvYWQgcGx1cyBhIG1vbm90b25pYyBgaWRgLFxuICogIHBsdXMgYW4gYGVwb2NoYCB3aGVuIHRoZSBsb2cgd2FzIGdpdmVuIG9uZS4gKi9cbmV4cG9ydCB0eXBlIEZyYW1lPFQ+ID0gVCAmIHsgaWQ6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBFdmVudExvZzxUPiB7XG4gIC8qKiBBcHBlbmQgb25lIGZyYW1lLCBmYW4gaXQgb3V0IHRvIGxpdmUgc3Vic2NyaWJlcnMsIGFuZCByZXR1cm4gaXQuICovXG4gIGVtaXQobXNnOiBUKTogRnJhbWU8VD47XG4gIC8qKlxuICAgKiBSZXBsYXkgZXZlcnl0aGluZyBhZnRlciBgc2luY2VgLCB0aGVuIHN0YXkgc3Vic2NyaWJlZC4gUmV0dXJucyBhblxuICAgKiB1bnN1YnNjcmliZSBmdW5jdGlvbi5cbiAgICpcbiAgICog4puUIFJFUExBWSBBTkQgU1VCU0NSSUJFIEFSRSBPTkUgQ0FMTCBPTiBQVVJQT1NFLiBEb2luZyB0aGVtIGluIHR3byBzdGVwc1xuICAgKiBsZWF2ZXMgYSB3aW5kb3cgaW4gd2hpY2ggYW4gZW1pdCBsYW5kcyBiZXR3ZWVuIHRoZSByZXBsYXkgbG9vcCBhbmQgdGhlXG4gICAqIGBhZGRgLCBhbmQgdGhhdCBmcmFtZSBpcyBkZWxpdmVyZWQgdG8gbm9ib2R5IOKAlCB0aGUgc2hhcGUgZml2ZSBkYWVtb25zIGhhdmUsXG4gICAqIHN1cnZpdmVkIGJ5IG5vdGhpbmcgYnV0IHRoZSBzaW5nbGUtdGhyZWFkZWQgZXZlbnQgbG9vcCBoYXBwZW5pbmcgdG8gY2xvc2VcbiAgICogaXQuIERlcGVuZGluZyBvbiB0aGF0IGlzIGRlcGVuZGluZyBvbiBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgb2YgdGhlXG4gICAqIHJ1bnRpbWUgcmF0aGVyIHRoYW4gb24gdGhlIGNvZGUuXG4gICAqL1xuICBzdWJzY3JpYmUoc2luY2U6IG51bWJlciwgbGlzdGVuZXI6IChmcmFtZTogRnJhbWU8VD4pID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvKiogVGhlIGhpZ2hlc3QgaWQgZW1pdHRlZCBzbyBmYXIg4oCUIHdoYXQgYEdFVCAvc3RhdGVgIHJldHVybnMgYXMgYGN1cnNvcmAuICovXG4gIGN1cnNvcigpOiBudW1iZXI7XG4gIC8qKiBUaGUgZXBvY2ggc3RhbXBlZCBvbiBldmVyeSBmcmFtZSwgb3IgYHVuZGVmaW5lZGAgaWYgbm9uZSB3YXMgY29uZmlndXJlZC4gKi9cbiAgcmVhZG9ubHkgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50TG9nPFQgZXh0ZW5kcyBvYmplY3Q+KFxuICBvcHRzOiB7IGVwb2NoPzogc3RyaW5nOyBidWZmZXJTaXplPzogbnVtYmVyIH0gPSB7fSxcbik6IEV2ZW50TG9nPFQ+IHtcbiAgY29uc3QgYnVmZmVyU2l6ZSA9IG9wdHMuYnVmZmVyU2l6ZSA/PyBSRVBMQVlfQlVGRkVSX1NJWkU7XG4gIGNvbnN0IGVwb2NoID0gb3B0cy5lcG9jaDtcbiAgY29uc3QgYnVmZmVyOiBBcnJheTxGcmFtZTxUPj4gPSBbXTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IFNldDwoZnJhbWU6IEZyYW1lPFQ+KSA9PiB2b2lkPigpO1xuICBsZXQgc2VxID0gMDtcblxuICByZXR1cm4ge1xuICAgIGVwb2NoLFxuXG4gICAgZW1pdChtc2cpIHtcbiAgICAgIHNlcSArPSAxO1xuICAgICAgLy8g4puUIFRIRSBNT05PVE9OSUMgSUQgV0lOUyBPVkVSIEFOWVRISU5HIElOIFRIRSBQQVlMT0FELCBBTkQgVU5USUwgTk9XIElUXG4gICAgICAvLyBPTkxZIENMQUlNRUQgVE8uIEJvdGggYWRvcHRpbmcgZGFlbW9ucyB3cm90ZSBgeyBpZDogKytzZXEsIC4uLm1zZyB9YFxuICAgICAgLy8gdW5kZXIgYSBjb21tZW50IHNheWluZyBcInRoZSBtb25vdG9uaWMgYGlkYCBNVVNUIHdpbiBvdmVyIGFueSBgaWRgIGluXG4gICAgICAvLyB0aGUgcGF5bG9hZCwgc28gY2FsbGVycyBjYXJyeSBhIHByb2plY3QgaWRlbnRpZmllciBhcyBgcHJvamVjdElkYCxcbiAgICAgIC8vIG5ldmVyIGBpZGBcIiDigJQgYnV0IHNwcmVhZCBvcmRlciBtZWFucyBhIHBheWxvYWQgYGlkYCBvdmVycm9kZSB0aGVcbiAgICAgIC8vIGN1cnNvciwgc2lsZW50bHksIGFuZCB0aGUgY29udmVudGlvbiBpbiB0aGUgY29tbWVudCB3YXMgdGhlIG9ubHkgdGhpbmdcbiAgICAgIC8vIGhvbGRpbmcgaXQuIFRoZSBsaXRlcmFsIGtlZXBzIGBpZGAgRklSU1Qgc28gdGhlIHdpcmUga2V5IG9yZGVyIGlzXG4gICAgICAvLyB1bmNoYW5nZWQ7IHRoZSBhc3NpZ25tZW50IGFmdGVyIHRoZSBzcHJlYWQgaXMgd2hhdCBtYWtlcyB0aGUgc2VudGVuY2VcbiAgICAgIC8vIHRydWUuIGBlcG9jaGAgaXMgc3RhbXBlZCB0aGUgc2FtZSB3YXkgYW5kIGZvciB0aGUgc2FtZSByZWFzb24uXG4gICAgICBjb25zdCBmcmFtZSA9IHsgaWQ6IHNlcSwgLi4ubXNnIH0gYXMgRnJhbWU8VD47XG4gICAgICBmcmFtZS5pZCA9IHNlcTtcbiAgICAgIGlmIChlcG9jaCAhPT0gdW5kZWZpbmVkKSBmcmFtZS5lcG9jaCA9IGVwb2NoO1xuXG4gICAgICBidWZmZXIucHVzaChmcmFtZSk7XG4gICAgICBpZiAoYnVmZmVyLmxlbmd0aCA+IGJ1ZmZlclNpemUpIGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCBsaXN0ZW5lciBvZiBsaXN0ZW5lcnMpIGxpc3RlbmVyKGZyYW1lKTtcbiAgICAgIHJldHVybiBmcmFtZTtcbiAgICB9LFxuXG4gICAgc3Vic2NyaWJlKHNpbmNlLCBsaXN0ZW5lcikge1xuICAgICAgLy8gU2VlIHRoZSBoZWFkZXIsIHBvaW50IDM6IGEgY3Vyc29yIGJleW9uZCBvdXIgb3duIGlzIGEgY3Vyc29yIGZyb20gYVxuICAgICAgLy8gUFJJT1IgUFJPQ0VTUywgYW5kIHRoZSBvbmx5IHVzZWZ1bCByZWFkaW5nIG9mIGl0IGlzIFwicmVwbGF5IHdob2xlXCIuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEEgTk9OLUZJTklURSBDVVJTT1IgQUxTTyBNRUFOUyBcIkZST00gVEhFIFNUQVJUXCIsIHdoaWNoIHRoZSBjb3BpZXMgZ290XG4gICAgICAvLyB3cm9uZyBieSBhY2NpZGVudDogdGhleSB3cm90ZSBgcGFyc2VJbnQocGFyYW0gPz8gXCItMVwiKWAgYW5kIGNvbXBhcmVkXG4gICAgICAvLyBgaWQgPiBzaW5jZWAsIHNvIGEgdHlwbydkIGA/c2luY2U9eGAgcHJvZHVjZWQgYE5hTmAsIGV2ZXJ5IGNvbXBhcmlzb25cbiAgICAgIC8vIHdhcyBmYWxzZSwgYW5kIHRoZSB0YWlsIG9wZW5lZCBFTVBUWSBhbmQgc3RheWVkIGNvbm5lY3RlZCDigJQgdGhlIHNhbWVcbiAgICAgIC8vIHNpbGVudC1hbmQtY29ubmVjdGVkIHN5bXB0b20gYXMgdGhlIHN0YWxlIHdhdGVybWFyaywgZnJvbSBhIGRpZmZlcmVudFxuICAgICAgLy8gY2F1c2UuIEFic2VudCBhbmQgdW5wYXJzZWFibGUgYXJlIHRoZSBzYW1lIHJlcXVlc3QgaGVyZS5cbiAgICAgIGNvbnN0IGZyb20gPSAhTnVtYmVyLmlzRmluaXRlKHNpbmNlKSB8fCBzaW5jZSA+IHNlcSA/IC0xIDogc2luY2U7XG4gICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGJ1ZmZlcikge1xuICAgICAgICBpZiAoZnJhbWUuaWQgPiBmcm9tKSBsaXN0ZW5lcihmcmFtZSk7XG4gICAgICB9XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgIGxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgICAgfTtcbiAgICB9LFxuXG4gICAgY3Vyc29yKCkge1xuICAgICAgcmV0dXJuIHNlcTtcbiAgICB9LFxuICB9O1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBkYWVtb24gbGlmZWN5Y2xlIHRhaWw6IHRoZSBpZGxlLWNsb3NlIGRlY2lzaW9uLCB0aGUgc3dlZXBcbiAqIHRoYXQgbWFrZXMgaXQsIGFuZCB0aGUgYm91bmRlZCB0ZWFyZG93bi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBib3VudHkg4oCUIHRoZSBjZW5zdXMnc1xuICogY29udmVyZ2VuY2UgdGFyZ2V0ICMzIOKAlCB3aXRoIGFzdHJvbGFiZSdzIGB0aW1lb3V0TXMgPiAwYCBndWFyZCBmb2xkZWQgaW4sXG4gKiB3aGljaCBpcyB0aGUgb25lIHRoaW5nIGJvdW50eSdzIGNvcHkgZG9lcyBub3QgZXhwcmVzcy5cbiAqXG4gKiDilIDilIAg4puUIEdSQVBFVklORSBBRE9QVFMgYGRyYWluQW5kU3RvcGAgQU5EIE5PVEhJTkcgRUxTRSBIRVJFIOKAlCBTUExJVCBQRVIgRVhQT1JUXG4gKlxuICogUnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KSwgYW5kIGl0IGlzIHdyaXR0ZW4gZG93blxuICogYmVjYXVzZSBhIHJvdyBpcyBhIE1PRFVMRSBhbmQgXCJwYXJ0aWFsXCIgaXMgbm90IGFuIGFuc3dlciB1bnRpbCBpdCBzYXlzIHdoaWNoXG4gKiBleHBvcnRzLiBHcmFwZXZpbmUgaXMgbG9uZy1ydW5uaW5nLCBzbyBub3RoaW5nIGFib3V0IGl0cyBsaWZlY3ljbGUgbWFrZXMgdGhpc1xuICogbW9kdWxlIHJlYWQgYXMgaW5hcHBsaWNhYmxlIOKAlCBhbmQgdHdvIG9mIGl0cyB0aHJlZSBleHBvcnRzIHN0aWxsIGhhdmUgbm9cbiAqIHN1YmplY3QgdGhlcmU6XG4gKlxuICogICBgc2hvdWxkSWRsZUNsb3NlYCAgICAgIE5PIFNVQkpFQ1QuIEdyYXBldmluZSBydW5zIG5vIGlkbGUgc3dlZXAgYW5kIGhhcyBub1xuICogICBgc3RhcnRIb3VzZWtlZXBpbmdgICAgIGAtLXRpbWVvdXRgOyBpdCBpcyBhIGJyb2tlciB0aGF0IHN0YW5kcyB1bnRpbCBgc3RvcGBcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAoYERFTEVURSAvYCkgb3IgYSBzaWduYWwsIGFuZCBpdCB0YWtlcyBubyBzbmFwc2hvdC5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBBZG9wdGluZyB0aGUgcGFpci1tYW5hZ2VyIHdvdWxkIG1lYW4gd3JpdGluZyBhIG5vLW9wXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYHRvdWNoYCBhbmQgYSBgc3Vic2NyaWJlckNvdW50YCB0aGF0IGV4aXN0cyBvbmx5IHRvXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGEgbnVtYmVyIG5vYm9keSBhY3RzIG9uIOKAlCB0d28gbGllcyB0byBnYWluIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgY2xlYXJJbnRlcnZhbGAuXG4gKiAgIGBkcmFpbkFuZFN0b3BgICAgICAgICAgQURPUFRFRCwgYW5kIGl0IGlzIGEgREUtRFVQTElDQVRJT04gcmF0aGVyIHRoYW4gYVxuICogICAgICAgICAgICAgICAgICAgICAgICAgIGdhaW46IGdyYXBldmluZSdzIHRlYXJkb3duIGFscmVhZHkgV0FTXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIDIwMCBtc10pYCwgd2hpY2ggaXNcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBgc3RvcE1zYCBleGFjdGx5LlxuICpcbiAqIOKaoCAqKkFORCBJVCBJUyBDQUxMRUQgV0lUSCBOTyBgY2xpZW50c2AsIFdISUNIIElTIEEgTUVBU1VSRU1FTlQsIE5PVCBBTlxuICogT1ZFUlNJR0hULioqIFRoaXMgbW9kdWxlIGNsb3NlcyBhIGhlbGQgY29ubmVjdGlvbiBieSBjYWxsaW5nIGBjbGllbnQuY2xvc2UoKWA7XG4gKiBncmFwZXZpbmUncyBzdWJzY3JpYmVyIHJlY29yZHMgYXJlIGB7YWxpYXMsIGh1bWFuLCBsdXJrLCBzZW5kfWAgYW5kIGNhcnJ5IG5vXG4gKiBgY2xvc2VgIOKAlCBpdHMgcGVyLXN0cmVhbSB0ZWFyZG93biBpcyBhIGNsb3N1cmUgc3Rhc2hlZCBvbiB0aGUgUmVhZGFibGVTdHJlYW1cbiAqIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb20gYGNhbmNlbCgpYC4gVGhlcmUgaXMgbm90aGluZyB0byBoYW5kIHRoZVxuICogYXJndW1lbnQuIGBzc2UudHNgJ3MgaGVhZGVyIGNhcnJpZXMgdGhlIHJlc3Qgb2YgdGhhdCBydWxpbmcsIGluY2x1ZGluZyB0aGVcbiAqIHdpZGVuaW5nIG5vdCBkb25lIGFuZCBpdHMgY29zdCAoc2l4IGFydGlmYWN0cyBhY3Jvc3MgZml2ZSBzcGVsbHMpLlxuICpcbiAqIOKaoCBHcmFwZXZpbmUgYWxzbyBwYXNzZXMgYGdyYWNlTXM6IDBgLiBOb3QgYSBkaXNhZ3JlZW1lbnQgd2l0aCB0aGUgZ3JhY2VcbiAqIHBlcmlvZDogaXQgZW1pdHMgbm8gZmFyZXdlbGwgZnJhbWUgYXQgZGFlbW9uIHNodXRkb3duLCBhbmQgaXRzIGBERUxFVEUgL2BcbiAqIGFscmVhZHkgcmV0dXJucyB0aGUgcmVzcG9uc2UgYW5kIHNjaGVkdWxlcyB0aGUgdGVhcmRvd24gMTAgbXMgbGF0ZXIsIHNvIGl0c1xuICogZmx1c2ggd2luZG93IHNpdHMgYXQgdGhlIHJvdXRlIHJhdGhlciB0aGFuIGluIHRoZSBkcmFpbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFNzZUNsaWVudHMgfSBmcm9tIFwiLi9zc2UudHNcIjtcblxuLyoqXG4gKiBTaG91bGQgdGhlIGRhZW1vbiBpZGxlLWNsb3NlP1xuICpcbiAqIOKblCAqKmBzdWJzY3JpYmVyQ291bnRgIElTIEEgUkVRVUlSRUQgQVJHVU1FTlQsIEFORCBUSEFUIElTIFRIRSBXSE9MRSBQT0lOVC4qKlxuICogVGhpcyBjbG9zZXMgY2Vuc3VzIGRlZmVjdCAqKkwxKiogYnkgY29uc3RydWN0aW9uOiBnbGFtb3VyLCBpbWFnbyBhbmQgbWFncGllXG4gKiBjb3VudGVkIHRoZWlyIGlkbGUgZmxvb3IgZG93biB3aGlsZSBhbiBhZ2VudCBoZWxkIGEgdGFpbCBvcGVuLCBzbyBhbiBhZ2VudFxuICogd2F0Y2hpbmcgYSBxdWlldCBib2FyZCB3YXMga2lsbGVkIFdJVEggSVRTIENPTk5FQ1RJT04gT1BFTi4gVGhlcmUgaXMgbm9cbiAqIG92ZXJsb2FkIG9mIHRoaXMgZnVuY3Rpb24gdGhhdCBjYW5ub3Qgc2VlIGl0cyBzdWJzY3JpYmVycywgc28gdGhlIGRlZmVjdFxuICogY2Fubm90IGJlIHJlLWV4cHJlc3NlZCBieSBhIGNhbGxlciB3aG8gZm9yZ2V0cy5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNDQVIgSVQgQ0FNRSBXSVRILCByZS1ob21lZCBmcm9tIGJvdW50eSB2ZXJiYXRpbSBpbiBzdWJzdGFuY2U6KipcbiAqIGEgYm9hcmQgb25seSBjb3VudHMgaXRzIGlkbGUgZmxvb3IgZG93biB3aGlsZSBVTldBVENIRUQuIEEgbGl2ZSBzdWJzY3JpYmVyIOKAlFxuICogYSBicm93c2VyIFdlYlNvY2tldCwgb3IgYW4gYWdlbnQgU1NFIHRhaWwgb24gYC9ldmVudHNgIOKAlCBrZWVwcyBpdCBvcGVuXG4gKiBpbmRlZmluaXRlbHkuIFNvIGB0aW1lb3V0YCBtZWFucyBcImxpbmdlciB0aGlzIGxvbmcgYWZ0ZXIgdGhlIExBU1Qgc3Vic2NyaWJlclxuICogbGVhdmVzXCIsIE5PVCBcIm1heGltdW0gaWRsZSB3aGlsZSBjb25uZWN0ZWRcIi4gVGhlIHN3ZWVwIGJlbG93IGFsc28gdG91Y2hlcyB0aGVcbiAqIGFjdGl2aXR5IGNsb2NrIG9uIGV2ZXJ5IHRpY2sgd2hpbGUgd2F0Y2hlZCwgc28gb25jZSB1bndhdGNoZWQgdGhlIGZsb29yXG4gKiBjb3VudHMgZnJvbSB0aGF0IGxhc3QgZGlzY29ubmVjdCBhbmQgbm90IGZyb20gdGhlIGxhc3QgcmVxdWVzdC5cbiAqXG4gKiDimqAgYHRpbWVvdXRNcyA8PSAwYCBtZWFucyBORVZFUiwgd2hpY2ggaXMgYXN0cm9sYWJlJ3Mgc3RhbmRpbmctb2JzZXJ2YXRvcnlcbiAqIGRlZmF1bHQgYW5kIGlzIHdoeSB0aGUgZ3VhcmQgaXMgaGVyZSByYXRoZXIgdGhhbiBhdCBpdHMgb25lIGNhbGwgc2l0ZTogYVxuICogc2luZ2xldG9uIGRhZW1vbiBpcyBtZWFudCB0byBzdGFuZCB1bnRpbCBpdCBpcyBleHBsaWNpdGx5IGNsb3NlZCwgYW5kIGFcbiAqIGA+PSAwYCBjb21wYXJpc29uIHdvdWxkIGNsb3NlIGl0IG9uIHRoZSBmaXJzdCB0aWNrLlxuICpcbiAqIENsb2NrLWZyZWUgYW5kIGZzLWZyZWUsIHNvIGl0IGlzIHRlc3RhYmxlIHdpdGhvdXQgYSBkYWVtb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRJZGxlQ2xvc2UoXG4gIHN1YnNjcmliZXJDb3VudDogbnVtYmVyLFxuICBpZGxlTXM6IG51bWJlcixcbiAgdGltZW91dE1zOiBudW1iZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKHRpbWVvdXRNcyA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzdWJzY3JpYmVyQ291bnQgPiAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpZGxlTXMgPj0gdGltZW91dE1zO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvdXNla2VlcGluZ09wdGlvbnMge1xuICAvKiog4puUIFJFUVVJUkVELiBTZWUgYHNob3VsZElkbGVDbG9zZWAg4oCUIHRoaXMgaXMgd2hhdCBjbG9zZXMgTDEuICovXG4gIHN1YnNjcmliZXJDb3VudDogKCkgPT4gbnVtYmVyO1xuICAvKiogTWlsbGlzZWNvbmRzIHNpbmNlIHRoZSBsYXN0IGFjdGl2aXR5LiAqL1xuICBpZGxlTXM6ICgpID0+IG51bWJlcjtcbiAgLyoqIFJlc2V0IHRoZSBhY3Rpdml0eSBjbG9jay4gQ2FsbGVkIG9uIGV2ZXJ5IHRpY2sgdGhhdCBoYXMgYSBzdWJzY3JpYmVyLiAqL1xuICB0b3VjaDogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBjb25maWd1cmVkIGlkbGUgdGltZW91dCBpbiBtczsgYDBgIChvciBsZXNzKSBtZWFucyBuZXZlci4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBGaXJlZCBvbmNlIHdoZW4gdGhlIGRhZW1vbiBzaG91bGQgY2xvc2UgaXRzZWxmLiAqL1xuICBvbklkbGVDbG9zZTogKCkgPT4gdm9pZDtcbiAgLyoqIFRoZSBkZWJvdW5jZWQgc25hcHNob3QsIGlmIHRoZSBzcGVsbCBoYXMgb25lLiAqL1xuICBzbmFwc2hvdD86IHtcbiAgICBkaXJ0eTogKCkgPT4gYm9vbGVhbjtcbiAgICBjbGVhcjogKCkgPT4gdm9pZDtcbiAgICB3cml0ZTogKCkgPT4gdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIH07XG4gIC8qKiBTd2VlcCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMjUwIG1zLiAqL1xuICB0aWNrTXM/OiBudW1iZXI7XG4gIC8qKiBTbmFwc2hvdCBpbnRlcnZhbDsgYm90aCBhZG9wdGluZyBkYWVtb25zIHVzZWQgMTAwMCBtcy4gKi9cbiAgc25hcHNob3RNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBTdGFydCB0aGUgdHdvIHN0YW5kaW5nIHRpbWVycyBldmVyeSBzZXNzaW9uIGRhZW1vbiBydW5zIOKAlCB0aGUgaWRsZSBzd2VlcCBhbmRcbiAqIHRoZSBkZWJvdW5jZWQgc25hcHNob3Qg4oCUIGFuZCByZXR1cm4gdGhlIGZ1bmN0aW9uIHRoYXQgc3RvcHMgYm90aC5cbiAqXG4gKiBUaGV5IGFyZSBPTkUgY2FsbCBiZWNhdXNlIHRoZXkgaGF2ZSBhbHdheXMgYmVlbiBvbmUgbGlmZXRpbWU6IGV2ZXJ5IGNvcHlcbiAqIGNsZWFyZWQgYm90aCBpbiB0aGUgc2FtZSB0d28gbGluZXMgYWZ0ZXIgYGF3YWl0IGRvbmVgLCBhbmQgdGhlIHBhaXIgdGhhdCBnZXRzXG4gKiBmb3Jnb3R0ZW4gaXMgdGhlIHBhaXIgd2hvc2UgdGltZXJzIGtlZXAgYSBwcm9jZXNzIGFsaXZlIGFmdGVyIHRlYXJkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRIb3VzZWtlZXBpbmcob3B0czogSG91c2VrZWVwaW5nT3B0aW9ucyk6ICgpID0+IHZvaWQge1xuICBjb25zdCB0aWNrTXMgPSBvcHRzLnRpY2tNcyA/PyAyNTA7XG4gIGNvbnN0IHNuYXBzaG90TXMgPSBvcHRzLnNuYXBzaG90TXMgPz8gMTAwMDtcblxuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcHRzLnN1YnNjcmliZXJDb3VudCgpO1xuICAgIGlmIChzdWJzY3JpYmVycyA+IDApIG9wdHMudG91Y2goKTtcbiAgICBpZiAoc2hvdWxkSWRsZUNsb3NlKHN1YnNjcmliZXJzLCBvcHRzLmlkbGVNcygpLCBvcHRzLnRpbWVvdXRNcykpIG9wdHMub25JZGxlQ2xvc2UoKTtcbiAgfSwgdGlja01zKTtcblxuICBjb25zdCBzbmFwID0gb3B0cy5zbmFwc2hvdDtcbiAgY29uc3Qgc25hcFRpbWVyID0gc25hcFxuICAgID8gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoIXNuYXAuZGlydHkoKSkgcmV0dXJuO1xuICAgICAgICBzbmFwLmNsZWFyKCk7XG4gICAgICAgIHZvaWQgc25hcC53cml0ZSgpO1xuICAgICAgfSwgc25hcHNob3RNcylcbiAgICA6IG51bGw7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBjbGVhckludGVydmFsKGlkbGVUaW1lcik7XG4gICAgaWYgKHNuYXBUaW1lciAhPT0gbnVsbCkgY2xlYXJJbnRlcnZhbChzbmFwVGltZXIpO1xuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERyYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgYm91bmQgc2VydmVyLiBUeXBlZCBzdHJ1Y3R1cmFsbHkgc28gdGhlIGtpdCBzdGF5cyBmcmVlIG9mIGBidW5gLiAqL1xuICBzZXJ2ZXI6IHsgc3RvcChjbG9zZUFjdGl2ZUNvbm5lY3Rpb25zPzogYm9vbGVhbik6IHVua25vd24gfTtcbiAgLyoqIExpdmUgU1NFIHRhaWxzOyBldmVyeSByZWdpc3RlcmVkIGNsb3NlciBpcyBpbnZva2VkLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIExpdmUgV2ViU29ja2V0cy4gKi9cbiAgc29ja2V0cz86IEl0ZXJhYmxlPHsgY2xvc2UoKTogdm9pZCB9PjtcbiAgLyoqIEhvdyBsb25nIHF1ZXVlZCBmcmFtZXMgZ2V0IHRvIGZsdXNoIGJlZm9yZSBhbnl0aGluZyBpcyBjbG9zZWQuICovXG4gIGdyYWNlTXM/OiBudW1iZXI7XG4gIC8qKiBIb3cgbG9uZyB0aGUgZ3JhY2VmdWwgc3RvcCBnZXRzIGJlZm9yZSB0ZWFyZG93biBwcm9jZWVkcyByZWdhcmRsZXNzLiAqL1xuICBzdG9wTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2xvc2UgZXZlcnkgaGVsZCBjb25uZWN0aW9uIGFuZCBzdG9wIHRoZSBzZXJ2ZXIsIGluIGJvdW5kZWQgdGltZS5cbiAqXG4gKiDim5QgKipUSEUgR1JBQ0UgUEVSSU9EIElTIE5PVCBQT0xJVEVORVNTLioqIEEgYGNsb3NlZGAgZnJhbWUgZW1pdHRlZCBhbmQgdGhlblxuICogZm9sbG93ZWQgaW1tZWRpYXRlbHkgYnkgYW4gYWdncmVzc2l2ZSBgc2VydmVyLnN0b3AodHJ1ZSlgIGlzIGEgZnJhbWUgdGhlXG4gKiBjbGllbnQgbmV2ZXIgc2VlcyDigJQgdGhlIHF1ZXVlIGdvZXMgd2l0aCB0aGUgc29ja2V0LiBUaGUgMTUwIG1zIGlzIHdoYXQgdHVybnNcbiAqIFwidGhlIGRhZW1vbiB0b2xkIHlvdSB3aHkgaXQgZGllZFwiIGZyb20gYSBob3BlIGludG8gYW4gb2JzZXJ2YXRpb24sIGFuZCBldmVyeVxuICogb25lIG9mIHRoZSBlaWdodCBkYWVtb25zIGNvbnZlcmdlZCBvbiB0aGF0IG51bWJlciBpbmRlcGVuZGVudGx5LlxuICpcbiAqIOKblCAqKkFORCBUSEUgU1RPUCBJUyBSQUNFRCwgQkVDQVVTRSBBIFNMT1cgU09DS0VUIE1VU1QgTk9UIEJFIEFCTEUgVE8gSEFOR1xuICogVEVBUkRPV04uKiogYHNlcnZlci5zdG9wKHRydWUpYCBhd2FpdHMgaXRzIGNvbm5lY3Rpb25zOyBvbmUgd2VkZ2VkIHBlZXIgaXNcbiAqIGVub3VnaCB0byBwYXJrIGl0IGZvcmV2ZXIsIHdoaWNoIGlzIGhvdyBhIDIzLW1pbnV0ZSBoYW5nIHNoaXBwZWQgb25jZS5cbiAqXG4gKiDimqAgKipXSEFUIElTIERFTElCRVJBVEVMWSBOT1QgSEVSRTogYm91bnR5J3Mgc2h1dGRvd24gd2F0Y2hkb2cuKiogQm91bnR5IGFybXNcbiAqIGEgUkVGJ2QgYHNldFRpbWVvdXRgIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgaWYgdGVhcmRvd24gZG9lcyBub3QgZmluaXNoLFxuICogYW5kIHRoZSBjZW5zdXMgaXMgcmlnaHQgdGhhdCBpdCBpcyB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsXG4gKiB0ZXJtaW5hdGlvbiBndWFyYW50ZWUuIEl0IGJlbG9uZ3MgdG8gYm91bnR5J3MgVEVBUkRPV04g4oCUIHRoZSBzdHJldGNoIHdoZXJlXG4gKiBub3RoaW5nIGJvdW5kcyB3aGF0IGlzIGJlaW5nIHdhaXRlZCBvbi4g4puUICoqVEhJUyBQQVJBR1JBUEggU0FJRCBcIlNJR05BTFxuICogUEFUSFwiIFVOVElMIEQ1MywgQU5EIFRIRSBDT0RFIEFHUkVFRCBXSVRIIElULCBXSElDSCBXQVMgVEhFIERFRkVDVC4qKiBCb3VudHlcbiAqIGhhcyBGT1VSIHdheXMgaW50byBvbmUgdGVhcmRvd24gKGEgc2lnbmFsLCBhIGBjbG9zZWAgdmVyYiwgdGhlIGJyb3dzZXInc1xuICogY2xvc2Ugb3ZlciB0aGUgV2ViU29ja2V0LCBhbiBpZGxlIHRpbWVvdXQpIGFuZCBvbmx5IHRoZSBzaWduYWwgb25lIGFybWVkIHRoZVxuICogdGltZXIsIHdoaWxlIHRoZSBjb21tZW50IGFib3ZlIGl0IGNsYWltZWQgdGhlIGVuZGluZyB3YXMgdW5jb25kaXRpb25hbC5cbiAqIERyaXZlbiB3aXRoIGEgcGxhbnRlZCBoYW5nOiB0aGUgb3RoZXIgdGhyZWUgcmFuIHBhc3QgMTAgcywgdGhlIGlkbGUgb25lXG4gKiBpbmNsdWRlZCDigJQgdGhlIG9ycGhhbi1kYWVtb24gY2xhc3MgdGhlIDIzLW1pbnV0ZSBoYW5nIGNhbWUgZnJvbS4gVGhlIGFybWluZ1xuICogbm93IGxpdmVzIGluIHRoZSBSRVNPTFZFIHRoYXQgYWxsIGZvdXIgZW50cmllcyBwYXNzIHRocm91Z2guICoqVGhlIGxlc3NvbiBmb3JcbiAqIGFuIGFkb3B0ZXIgaXMgdGhlIGNvdW50LCBub3QgdGhlIHBsYWNlbWVudDogZW51bWVyYXRlIGV2ZXJ5IGVudHJ5IGludG8gdGhlXG4gKiB0ZWFyZG93biBiZWZvcmUgeW91IGJlbGlldmUgYSBndWFyYW50ZWUgY292ZXJzIGl0LioqIFRoZSB0d29cbiAqIGRhZW1vbnMgYWRvcHRpbmcgdGhpcyBtb2R1bGUgcmVnaXN0ZXIgbm8gc2lnbmFsIGhhbmRsZXJzLCBhbmQgdGhlaXIgd2hvbGVcbiAqIHRlYXJkb3duIGlzIGJvdW5kZWQgYnkgdGhlIHR3byBudW1iZXJzIGFib3ZlOyBhZGRpbmcgYW4gZXhpdCBoZXJlIHdvdWxkIHB1dFxuICogdGhlIGhvdXNlJ3Mgb25seSB1bmNvbmRpdGlvbmFsIGBwcm9jZXNzLmV4aXRgIGluc2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBpc1xuICogYWJvdXQgdG8gYnVuZGxlLCBvbmUgcGhhc2UgYWZ0ZXIgRDggdG9vayBleGFjdGx5IHRoYXQgaGF6YXJkIE9VVCBvZiBgZGllYC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFTlRFTkNFIFRIQVQgVVNFRCBUTyBFTkQgVEhBVCBQQVJBR1JBUEggV0FTIEEgUFJFRElDVElPTiwgV0hJQ0hcbiAqIEJPVU5UWSdTIE9XTiBQT1JUIEZBTFNJRklFRC4qKiBJdCByZWFkOiBcIndoZW4gYSBzcGVsbCB3aXRoIGEgc2lnbmFsIHBhdGhcbiAqIGFkb3B0cyB0aGlzLCB0aGUgd2F0Y2hkb2cgYXJyaXZlcyBhcyBhbiBvcHRpb24gb24gdGhlc2UgYXJndW1lbnRzIGFuZCB0aGVcbiAqIHJlYXNvbmluZyBpcyBhbHJlYWR5IHdyaXR0ZW4gZG93bi5cIiBib3VudHkgYWRvcHRlZCBgZHJhaW5BbmRTdG9wYCBvblxuICogMjAyNi0wOS0wOSAoUGhhc2UgNCkgYW5kIHRoZSBvcHRpb24gd2FzIE5PVCBhZGRlZCwgYmVjYXVzZSB0aGUgd2luZG93IGlzXG4gKiB3cm9uZy4gKipBIGB3YXRjaGRvZ01zYCBvbiB0aGVzZSBhcmd1bWVudHMgd291bGQgYXJtIGF0IERSQUlOIHRpbWU7IGJvdW50eSdzXG4gKiBhcm1zIGF0IFNJR05BTCB0aW1lKiosIGFuZCB0aGUgd2hvbGUgcmVhc29uIGl0IGV4aXN0cyBpcyB0aGUgc3RyZXRjaCBCRVRXRUVOXG4gKiB0aG9zZSB0d28gcG9pbnRzIOKAlCBgYXdhaXQgZG9uZWAsIGFuIGZzIGFwcGVuZCB0byB0aGUgZGFlbW9uIGxvZywgYSBmdWxsXG4gKiBzbmFwc2hvdCB3cml0ZSB0aGF0IGNhbiByb3RhdGUgYW5kIENPUFkgYSBiYWNrdXAgb2YgYSBsYXJnZSBib2FyZCwgYSBgY2xvc2VkYFxuICogZnJhbWUgYW5kIGEgYnJvYWRjYXN0LiBgZHJhaW5BbmRTdG9wYCdzIG93biBib2R5IGlzIGFscmVhZHkgYm91bmRlZCBieSB0aGUgdHdvXG4gKiBudW1iZXJzIGFib3ZlLCBzbyBhIHdhdGNoZG9nIHNjb3BlZCB0byBpdCB3b3VsZCBndWFyZCB0aGUgb25lIHN0cmV0Y2ggdGhhdFxuICogY2Fubm90IGhhbmcgYW5kIGFiYW5kb24gdGhlIHN0cmV0Y2ggdGhhdCBjYW46IGl0IHdvdWxkIFJFQUQgYXMgYWRvcHRpb24gYW5kXG4gKiBCRSBhIG5hcnJvd2luZyBvZiB0aGUgY29ycHVzJ3Mgb25seSB1bmNvbmRpdGlvbmFsIHRlcm1pbmF0aW9uIGd1YXJhbnRlZS4gVGhlXG4gKiAyMy1taW51dGUgaGFuZyB0aGlzIHByb2plY3Qga2VlcHMgY2l0aW5nIGhhcHBlbmVkIGluIHRoZSB1bmJvdW5kZWQgc3RyZXRjaC5cbiAqXG4gKiDimqAgKipTTyBUSEUgUlVMRSBGT1IgVEhFIE5FWFQgU1BFTEwsIFdISUNIIElTIFRIRSBUUkFOU0ZFUkFCTEUgSEFMRjoqKiB0aGVcbiAqIHF1ZXN0aW9uIGlzIG5ldmVyIFwiZG9lcyB0aGlzIG1vZHVsZSBoYXZlIGEgcGxhY2UgdG8gcHV0IGEgd2F0Y2hkb2dcIiBidXRcbiAqIFwiZG9lcyB0aGUgd2F0Y2hkb2cncyB3aW5kb3cgY29pbmNpZGUgd2l0aCB0aGlzIG1vZHVsZSdzXCIuIFdoZXJlIGEgc3BlbGwnc1xuICogdGVhcmRvd24gaGFzIHVuYm91bmRlZCB3b3JrIEJFRk9SRSB0aGUgZHJhaW4sIHRoZSB3YXRjaGRvZyBiZWxvbmdzIGF0IHRoZVxuICogc3BlbGwsIHdyYXBwZWQgYXJvdW5kIGFsbCBvZiBpdCDigJQgYW5kIGFyb3VuZCBFVkVSWSBXQVkgSU4sIHdoaWNoIGlzIHRoZSBoYWxmXG4gKiBENTMgaGFkIHRvIHJlcGFpciBhZnRlciB0aGlzIGhlYWRlciB3YXMgd3JpdHRlbi4gSWYgYSBzcGVsbCBldmVyIGFwcGVhcnMgd2hvc2Ugc2lnbmFsIHBhdGhcbiAqIGVudGVycyBgZHJhaW5BbmRTdG9wYCBpbW1lZGlhdGVseSwgYWRkIHRoZSBvcHRpb24gVEhFTiDigJQgYW5kIHRoZSBvcHRpb24gbXVzdFxuICogdGFrZSBhbiBgb25FeHBpcmVgIGNhbGxiYWNrIHJhdGhlciB0aGFuIGV4aXRpbmcsIHNvIHRoZSBgcHJvY2Vzcy5leGl0YCBzdGF5c1xuICogb3V0c2lkZSBhIG1vZHVsZSBldmVyeSBzcGVsbCBidW5kbGVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZHJhaW5BbmRTdG9wKG9wdHM6IERyYWluT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBncmFjZU1zID0gb3B0cy5ncmFjZU1zID8/IDE1MDtcbiAgY29uc3Qgc3RvcE1zID0gb3B0cy5zdG9wTXMgPz8gMjAwO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIGdyYWNlTXMpKTtcblxuICBpZiAob3B0cy5jbGllbnRzKSB7XG4gICAgZm9yIChjb25zdCBjbGllbnQgb2YgWy4uLm9wdHMuY2xpZW50c10pIGNsaWVudC5jbG9zZSgpO1xuICB9XG4gIGlmIChvcHRzLnNvY2tldHMpIHtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIFsuLi5vcHRzLnNvY2tldHNdKSB7XG4gICAgICB0cnkge1xuICAgICAgICB3cy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgUHJvbWlzZS5yZXNvbHZlKG9wdHMuc2VydmVyLnN0b3AodHJ1ZSkpLFxuICAgIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHN0b3BNcykpLFxuICBdKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgYXNzZXQtc2VydmluZyB0cmlvIGZvciBhIHNwZWxsIGRhZW1vbjogd2hpY2ggc3VyZmFjZSBtb2RlIHdlXG4gKiBhcmUgaW4sIHdoYXQgY29udGVudCB0eXBlIGEgZmlsZSBnZXRzLCBhbmQgaG93IGEgZmlsZSB1bmRlciBgZGlzdC9gIGlzXG4gKiBhbnN3ZXJlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIEV4dHJhY3RlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIGZyb20gdGhlIGVpZ2h0IGBCdW4uc2VydmVgIGJhY2tlbmRzXG4gKiBjZW5zdXNlZCBpbiBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWRhZW1vbi1zcGluZS1jZW5zdXMubWRgLCB3aGljaFxuICogbWVhc3VyZWQgYHJlc29sdmVNb2RlYCBhcyBieXRlLWlkZW50aWNhbCBpbiBhbGwgZWlnaHQgKHRoZSBvbmx5IG1kNSBkaWZmZXJlbmNlXG4gKiBiZWluZyB0aGUgYGV4cG9ydGAga2V5d29yZCksIHRoZSBjb250ZW50LXR5cGUgbWFwIGFzIGRpZmZlcmluZyBpbiBleGFjdGx5XG4gKiBvbmUgY2VsbCwgYW5kIHRoZSBmaWxlIGhhbGYgb2YgYHNlcnZlRGlzdGAgYXMgaWRlbnRpY2FsIGluIGZpdmUuXG4gKlxuICog4pSA4pSAIFdIQVQgREVMSUJFUkFURUxZIERJRCBOT1QgQ09NRSBBTE9ORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKlRoZSBVUkwtdG8tZmlsZW5hbWUgbWFwcGluZyBzdGF5cyBpbiBlYWNoIHJvdXRlci4qKiBUaGUgY2Vuc3VzIG1hcmtlZCB0d29cbiAqIG9mIHRoZSBlaWdodCBgc2VydmVEaXN0YCBkaXZlcmdlbmNlcyBERUxJQkVSQVRFIGFuZCBib3RoIGxpdmUgaW4gdGhhdCBoYWxmOlxuICogZGlnZXN0aWZ5IHN1YnN0aXR1dGVzIGludG8gdGhlIGVudHJ5IEhUTUwgaW4gbWVtb3J5LCBhbmQgZ3JhcGV2aW5lIHNlcnZlcyBpdHNcbiAqIHN1cmZhY2UgYXQgYC93YXRjaGAgcmF0aGVyIHRoYW4gYXQgYC9gLiBBIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmJcbiAqIHRob3NlIHN0b3BzIGJlaW5nIGEgZmlsZSBzZXJ2ZXIgYW5kIGJlY29tZXMgYSByb3V0ZXIuIFNvIHRoZSBjYWxsZXIgZGVjaWRlc1xuICogV0hJQ0ggZmlsZSAoYHBhdGggPT09IFwiL1wiID8gXCJpbmRleC5odG1sXCIgOiBwYXRoLnNsaWNlKDEpYCksIGFuZCB0aGlzIG1vZHVsZVxuICogZGVjaWRlcyB3aGV0aGVyIHRoYXQgZmlsZSBtYXkgYmUgcmVhZCBhbmQgd2hhdCBpdCBpcyBzZXJ2ZWQgYXMuXG4gKlxuICog4pSA4pSAIEFORCBcIldIRVRIRVIgSVQgTUFZIEJFIFJFQURcIiBJUyBOT1cgQSBXSElURUxJU1Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRXh0cmFjdGVkIHdpdGggdGhyZWUgZ3VhcmRzIChlbXB0eSAvIGAuLmAgLyBuZXN0ZWQpIGFuZCBgZXhpc3RzU3luY2AgZm9yIHRoZVxuICogcmVzdCwgd2hpY2ggd2FzIHRydWUgb2YgYSBgZGlzdC9gIHRoYXQgaGVsZCBvbmx5IGEgc3VyZmFjZS4gUGhhc2UgMWIgcHV0IGV2ZXJ5XG4gKiBkYWVtb24ncyBCVU5ETEUgaW4gdGhhdCBzYW1lIGRpcmVjdG9yeSwgYW5kIGFsbCBmaXZlIGFkb3B0ZXJzIHNlcnZlZCBpdDpcbiAqIGAvY2xpLmpzYCwgYC9zZXJ2ZXIuanNgLCBgL2pvaW4uanNgIGF0IDIwMCwgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGNvbW1pdHRlZFxuICogYXJ0aWZhY3RzLCBlbWJlZGRlZCBzb3VyY2VtYXBzIGFuZCBhbGwuIGBzZXJ2ZUZyb21EaXN0YCBub3cgc2VydmVzIG9ubHkgd2hhdCB0aGVcbiAqIGJ1aWx0IGBpbmRleC5odG1sYCB0cmFuc2l0aXZlbHkgbGlua3Mg4oCUIHNlZSBgc3VyZmFjZVdoaXRlbGlzdGAgYmVsb3csIHdoaWNoIGlzXG4gKiB0aGUgc2hhcGUgZGlnZXN0aWZ5IHByb3ZlZCBsb2NhbGx5IGluIGBkOGNiYWZmYCBhbmQgdGhpcyBpcyBpdHMgb25lIGVkaXQgZm9yXG4gKiBmaXZlIHNwZWxscy5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBSZWxlYXNlIGlmZiBgPGRpc3REaXI+L2luZGV4Lmh0bWxgIGV4aXN0czsgZWxzZSBkZXYuIFRoZSBlbnYgb3ZlcnJpZGVcbiAqIChgU1BFTExCT09LX1NVUkZBQ0VfTU9ERWApIHdpbnMgZWl0aGVyIHdheSDigJQgc2VhbXMgQ29udHJhY3QgMS5cbiAqXG4gKiDim5QgKipUSEUgRklMRSwgTkVWRVIgVEhFIERJUkVDVE9SWSwgQU5EIFRIQVQgSVMgQSBTQ0FSIE5PVCBBIFNUWUxFIENIT0lDRS4qKlxuICogUmUtaG9tZWQgZnJvbSBib3VudHkgYW5kIG1hZ3BpZSwgd2hpY2ggZWFybmVkIGl0IGluZGVwZW5kZW50bHk6XG4gKlxuICogLSBtYWdwaWUncyBgZGlzdC9gIEFMUkVBRFkgRVhJU1RFRCBob2xkaW5nIGBjbGkuanNgIGFuZCBubyBgaW5kZXguaHRtbGAsXG4gKiAgIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgaXRzIGRhZW1vbiBzdGF5ZWQgY29ycmVjdGx5IGluIERFViBtb2RlIHRocm91Z2ggdGhlXG4gKiAgIHdob2xlIG9mIFNsaWNlIDIuIGBkaXN0L2AgZXhpc3RpbmcgaXMgbm90IHRoZSBkaXNjcmltaW5hdG9yLlxuICogLSBib3VudHkgc2F5cyB0aGUgc2FtZSB0aGluZyBmcm9tIHRoZSBvdGhlciBzaWRlOiBhIGJ1aWx0IEJBQ0tFTkQgcHV0c1xuICogICBgY2xpLmpzYCAoYW5kIG5vdyBgc2VydmVyLmpzYCkgaW4gYGRpc3QvYCB3aXRoIG5vIHN1cmZhY2UgYW55d2hlcmUgbmVhciBpdC5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBSRURJQ0FURSBJUyBBTiBVTkhBU0hFRCBGSUxFTkFNRSwgV0hJQ0ggSVMgQSBTVEFORElOR1xuICogQVNTVU1QVElPTiBBQk9VVCBUSEUgU1VSRkFDRSBCVUlMRC4qKiBSZWxlYXNlIG1vZGUgaXMgY2hvc2VuIGJ5IE9ORSBsaXRlcmFsXG4gKiBuYW1lLiBBIHN1cmZhY2UgYnVpbGQgdGhhdCBldmVyIGVtaXR0ZWQgYSBjb250ZW50LWhhc2hlZCBlbnRyeSBkb2N1bWVudCB3b3VsZFxuICogbGVhdmUgbm8gYGluZGV4Lmh0bWxgIGhlcmUsIGV2ZXJ5IGRhZW1vbiB3b3VsZCBzaWxlbnRseSByZXNvbHZlIERFViwgYW5kIHRoZVxuICogb25seSBzeW1wdG9tIGFueW9uZSBjYW4gc2VlIGlzIHRoZSBgbW9kZWAgZmllbGQgb24gYSBoYW5kc2hha2Ugbm9ib2R5IHJlYWRzIGluXG4gKiBhbmdlci4gYHNyYy9idWlsZC50c2AgZW1pdHMgdGhlIGVudHJ5IHVuaGFzaGVkIHRvZGF5IChvbmx5IHRoZSBKUyBhbmQgQ1NTXG4gKiBjaHVua3MgY2FycnkgaGFzaGVzKSBhbmQgQ29udHJhY3QgMiBwaW5zIHRoYXQgZmxhdCBsYXlvdXQ7IHRoaXMgY29tbWVudCBpc1xuICogdGhlIG5vdGUgdGhhdCBzYXlzIHdoYXQgdGhlIHBpbiBpcyBsb2FkLWJlYXJpbmcgRk9SLlxuICpcbiAqIOKaoCBOb3RoaW5nIGFubm91bmNlcyB0aGUgZmxpcCBmcm9tIGRldiB0byByZWxlYXNlIGVpdGhlcjogdGhlIGZpcnN0IHN1cmZhY2VcbiAqIGJ1aWxkIHRvIGxhbmQgYW4gYGluZGV4Lmh0bWxgIGJlc2lkZSBhIGRhZW1vbiBmbGlwcyBpdCwgc2lsZW50bHksIG9uIHRoZSBuZXh0XG4gKiBib290LiBUaGF0IGlzIHdoeSBgbW9kZWAgcmlkZXMgdGhlIHJlYWR5IGZyYW1lIOKAlCB3aXRoIHJvb3QgZGVwcyBwcmVzZW50IGEgZGV2XG4gKiBkYWVtb24gcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBzdXJmYWNlLCBzbyBcIml0IGxvb2tzIHJpZ2h0XCIgY2Fubm90XG4gKiB2ZXJpZnkgQ29udHJhY3QgMS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlKGRpc3REaXI6IHN0cmluZyk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKlxuICogVGhlIGNvbnRlbnQgdHlwZXMgYSBidWlsdCBzdXJmYWNlIGFjdHVhbGx5IHNoaXBzLiBFeHRlbnNpb25zIG91dHNpZGUgdGhlXG4gKiBtYXAgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gIOKAlCBhIGRlbGliZXJhdGUgcmVmdXNhbCB0byBndWVzcywgc2luY2VcbiAqIGFueXRoaW5nIG5vdCBpbiB0aGlzIGxpc3QgaXMgbm90IHNvbWV0aGluZyBDb250cmFjdCAyJ3MgYnVpbGQgZW1pdHMuXG4gKlxuICog4pqgICoqYGNoYXJzZXQ9dXRmLThgIE9OIEhUTUwgSVMgVEhFIENFTlNVUydTIE9ORSBESVZFUkdFTkNFLCBSRVNPTFZFRCBUT1dBUkRcbiAqIFRIRSBDT1JSRUNUIENPUFkuKiogVGhyZWUgb2YgdGhlIGVpZ2h0IGRhZW1vbnMgY2FycmllZCBpdCBhbmQgZml2ZSBkaWQgbm90O1xuICogdGhlIGNlbnN1cyBncmFkZWQgdGhhdCBgc3RhbGVgIHdpdGggemVybyBkZXNpZ24gY29udGVudC4gSXQgaXMga2VwdCBiZWNhdXNlXG4gKiBpdCBpcyB0aGUgcmlnaHQgYW5zd2VyIOKAlCBhbiBIVE1MIGRvY3VtZW50IHNlcnZlZCB3aXRoIG5vIGNoYXJzZXQgaXMgZGVjb2RlZFxuICogYnkgdGhlIGJyb3dzZXIncyBndWVzcyDigJQgYW5kIGl0IGlzIHRoZSBvbmUgd2lyZS1vYnNlcnZhYmxlIGNoYW5nZSB0aGlzXG4gKiBjb252ZXJnZW5jZSBtYWtlcyB0byBhIHJlc3BvbnNlIGhlYWRlci4gUmVjb3JkZWQgYXMgRC1ub3RlIGluIHRoZSBwaGFzZSBsb2dcbiAqIHJhdGhlciB0aGFuIHNtdWdnbGVkLlxuICovXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLyoqIFRoZSBjb250ZW50IHR5cGUgZm9yIGEgZmlsZW5hbWUgb3IgYW4gZXh0ZW5zaW9uLiBVbmtub3duIGV4dGVuc2lvbnMsIGFuZFxuICogIG5hbWVzIHdpdGggbm8gZXh0ZW5zaW9uIGF0IGFsbCwgZ2V0IGBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRlbnRUeXBlRm9yKG5hbWVPckV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZG90ID0gbmFtZU9yRXh0Lmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID09PSAtMSA/IFwiXCIgOiBuYW1lT3JFeHQuc2xpY2UoZG90KTtcbiAgcmV0dXJuIFNUQVRJQ19DT05URU5UX1RZUEVTW2V4dF0gPz8gXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIjtcbn1cblxuLyoqXG4gKiBBbnN3ZXIgT05FIGZpbGUgZnJvbSBgZGlzdERpcmAsIG9yIGBudWxsYCBpZiB0aGUgY2FsbGVyIHNob3VsZCBrZWVwIHJvdXRpbmcuXG4gKlxuICogYHJlbGAgaXMgYSBiYXJlIGZpbGVuYW1lIOKAlCB0aGUgZW50cnkgZG9jdW1lbnQgb3Igb25lIGhhc2hlZCBjaHVuay4gQ29udHJhY3RcbiAqIDIncyBidWlsdCBzdXJmYWNlIGlzIEZMQVQgYW5kIGxpbmtzIGl0cyBjaHVua3MgcmVsYXRpdmVseSwgc28gYSBsZWdpdGltYXRlXG4gKiBhc3NldCByZXF1ZXN0IGlzIG5ldmVyIG5lc3RlZCBhbmQgbmV2ZXIgY29udGFpbnMgYC4uYDsgYm90aCBhcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBpbiB0aGUgcm91dGVyLCBiZWNhdXNlIHRoZSBndWFyZCBwcm90ZWN0cyB0aGUgcmVhZCBhbmQgdGhlXG4gKiByZWFkIGlzIHdoYXQgbGl2ZXMgaW4gdGhpcyBmaWxlLlxuICpcbiAqIOKblCBBTkQgYGV4aXN0c1N5bmNgIElTIE5PIExPTkdFUiBUSEUgUEVSTUlTU0lPTi4gQSBmaWxlIHVuZGVyIGBkaXN0RGlyYCBpc1xuICogc2VydmVkIG9ubHkgaWYgaXQgaXMgaW4gYHN1cmZhY2VXaGl0ZWxpc3QoZGlzdERpcilgIOKAlCB3aGF0IHRoZSBidWlsdFxuICogYGluZGV4Lmh0bWxgIHRyYW5zaXRpdmVseSBMSU5LUy4gYGRpc3QvYCBzdG9wcGVkIGJlaW5nIGEgc3VyZmFjZSBkaXJlY3RvcnlcbiAqIHdoZW4gdGhlIGJhY2tlbmQgY29udmVyZ2VuY2UgYnVpbHQgdGhlIGRhZW1vbnMgaW50byBpdCwgYW5kIHRoZSBndWFyZHMgYWJvdmVcbiAqIGRvIG5vdCBkaXN0aW5ndWlzaCBgaW5kZXgtPGhhc2g+LmpzYCBmcm9tIGBzZXJ2ZXIuanNgLiBSZWFkIHRoYXQgZnVuY3Rpb24nc1xuICogaGVhZGVyIGJlZm9yZSB0b3VjaGluZyB0aGlzIGxpbmU7IHRoZSB3aGl0ZWxpc3QgaXMgdGhlIGRlZmVuY2UuXG4gKlxuICog4pqgIFRoZSBuZXN0aW5nIHJlZnVzYWwgaXMgYWxzbyB3aGF0IGtlZXBzIGFuIGFzc2V0IHNlcnZlIGNsZWFyIG9mIGEgc3BlbGwnc1xuICogb3duIHJvdXRlczogbWFncGllLCBib3VudHksIGdsYW1vdXIgYW5kIGltYWdvIGVhY2ggaGF2ZSBhbiBgL2Fzc2V0cy88bmFtZT5gXG4gKiByb3V0ZSBvbmUgbGV2ZWwgZGVlcCwgYW5kIHRoaXMgcmV0dXJuaW5nIGBudWxsYCBvbiBhbnl0aGluZyB3aXRoIGEgc2xhc2ggaW5cbiAqIGl0IGlzIHdoYXQgc3RvcHMgdGhlIHR3byBmaWdodGluZy4gVGhlIHdoaXRlbGlzdCBnb3Zlcm5zIGBkaXN0L2AgcmVhZHMgT05MWVxuICog4oCUIGl0IG5ldmVyIHNlZXMgdGhvc2Ugcm91dGVzIGFuZCBtdXN0IG5ldmVyIGJlIHdpZGVuZWQgaW50byB0aGVtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVGcm9tRGlzdChkaXN0RGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgaWYgKCFyZWwgfHwgcmVsLmluY2x1ZGVzKFwiLi5cIikgfHwgcmVsLmluY2x1ZGVzKFwiL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmICghc3VyZmFjZVdoaXRlbGlzdChkaXN0RGlyKS5oYXMocmVsKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoQnVuLmZpbGUoZmlsZSksIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBjb250ZW50VHlwZUZvcihyZWwpIH0gfSk7XG59XG5cbi8qKiBgc3JjYC9gaHJlZmAgdmFsdWVzIGluIGEgYnVpbHQgZW50cnkgZG9jdW1lbnQsIGAuL2AtcHJlZml4ZWQgb3IgYmFyZS4gKi9cbmNvbnN0IEVOVFJZX1JFRl9SRSA9IC8oPzpzcmN8aHJlZilcXHMqPVxccypcIig/OlxcLlxcLyk/KFteXCJdKylcIi9nO1xuXG4vKiogQSBgLi9gLVBSRUZJWEVEIHNpYmxpbmcgc3BlY2lmaWVyIOKAlCBgXCIuL25hbWVcImAsIGAnLi9uYW1lJ2AsIGAoLi9uYW1lKWAg4oCUIHdoaWNoXG4gKiAgaXMgdGhlIG9ubHkgc2hhcGUgYSBidW5kbGVyIGVtaXRzIGZvciBhIHNpYmxpbmcgY2h1bmsuIFJlcXVpcmluZyB0aGUgYC4vYCBpc1xuICogIHdoYXQga2VlcHMgYSBzdHJpbmcgbGl0ZXJhbCB0aGF0IG1lcmVseSBTQVlTIGBjbGkuanNgIG91dCBvZiB0aGUgc2V0LiAqL1xuY29uc3QgUkVMQVRJVkVfUkVGX1JFID0gL1tcIicoXVxcLlxcLyhbXlwiJygpXFxzXSspW1wiJyldL2c7XG5cbi8qKiBPbmx5IHRleHQgdGhlIGJ1aWxkIGVtaXRzIGFzIHN1cmZhY2UgY29kZSBpcyBzY2FubmVkIGZvciBvbndhcmQgcmVmZXJlbmNlcy5cbiAqICBBIGAucG5nYCBpcyBhIGxlYWY7IG9wZW5pbmcgaXQgd291bGQgYmUgcmVhZGluZyBhIGJpbmFyeSBmb3IgZmlsZW5hbWVzLiAqL1xuY29uc3QgVFJBTlNJVElWRV9FWFRTID0gW1wiLmpzXCIsIFwiLmNzc1wiXTtcblxuLyoqIE9uZSBkZXJpdmF0aW9uIHBlciBgZGlzdC9gLCBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3Mg4oCUIGBkaXN0L2AgaXMgYSBidWlsZFxuICogIGFydGlmYWN0IGFuZCBkb2VzIG5vdCBjaGFuZ2UgdW5kZXIgYSBydW5uaW5nIGRhZW1vbi4gS2V5ZWQgYnkgZGlyZWN0b3J5IHNvXG4gKiAgdHdvIGRhZW1vbnMgaW4gb25lIHByb2Nlc3MgKGFuZCBldmVyeSB0ZXN0IHdpdGggaXRzIG93biB0ZW1wIHRyZWUpIHN0YXlcbiAqICBpbmRlcGVuZGVudC4gKi9cbmNvbnN0IHdoaXRlbGlzdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+KCk7XG5cbmZ1bmN0aW9uIHJlZnNJbih0ZXh0OiBzdHJpbmcsIHJlOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIHJldHVybiAoXG4gICAgWy4uLnRleHQubWF0Y2hBbGwocmUpXVxuICAgICAgLm1hcCgoWywgcmVmXSkgPT4gcmVmKVxuICAgICAgLy8gQSBUWVBFIFBSRURJQ0FURSwgYW5kIGhvbmVzdCBvbmx5IGJlY2F1c2UgaXRzIGZpcnN0IGNsYXVzZSB3YXMgYWxyZWFkeVxuICAgICAgLy8gaGVyZTogYCEhcmVmYCBpcyB0aGUgcnVudGltZSBjaGVjayB0aGF0IG1ha2VzIGByZWYgaXMgc3RyaW5nYCB0cnVlICh0aGVcbiAgICAgIC8vIEZFTEwgc2VudGVuY2UncyBwcmVkaWNhdGUgcm91dGUsIHRha2VuIHdpdGggaXRzIGNsYXVzZSDigJQgdHlwZS1kZWJ0IFQzNikuXG4gICAgICAuZmlsdGVyKFxuICAgICAgICAocmVmKTogcmVmIGlzIHN0cmluZyA9PlxuICAgICAgICAgICEhcmVmICYmXG4gICAgICAgICAgIXJlZi5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiLi5cIikgJiZcbiAgICAgICAgICAhcmVmLmluY2x1ZGVzKFwiOlwiKSAmJlxuICAgICAgICAgICFyZWYuc3RhcnRzV2l0aChcIiNcIikgJiZcbiAgICAgICAgICAhcmVmLnN0YXJ0c1dpdGgoXCI/XCIpLFxuICAgICAgKVxuICApO1xufVxuXG4vKipcbiAqIFRoZSBuYW1lcyB1bmRlciBgZGlzdERpcmAgYSBicm93c2VyIG1heSBmZXRjaDogdGhlIGVudHJ5IGRvY3VtZW50LCBwbHVzIHRoZVxuICogVFJBTlNJVElWRSBjbG9zdXJlIG9mIHdoYXQgaXQgbGlua3MuXG4gKlxuICog4puUICoqQSBXSElURUxJU1QsIEFORCBUSEUgTEVBSyBJVCBSRVBMQUNFRCBJUyBXSFkuKiogVW50aWwgdGhpcyBmaXggdGhlIGZpbGVcbiAqIGhhbGYgb2YgdGhpcyBtb2R1bGUgaGFkIGV4YWN0bHkgdGhyZWUgZ3VhcmRzIOKAlCBlbXB0eSwgYC4uYCwgbmVzdGVkIOKAlCBhbmRcbiAqIGBleGlzdHNTeW5jYCBkZWNpZGVkIHRoZSByZXN0LiBUaGF0IHdhcyBjb3JyZWN0IGZvciBhcyBsb25nIGFzIGBkaXN0L2AgaGVsZFxuICogb25seSBhIHN1cmZhY2UuIFRoZSBiYWNrZW5kIGNvbnZlcmdlbmNlIG1vdmVkIGV2ZXJ5IHNwZWxsJ3MgSU1QTEVNRU5UQVRJT05cbiAqIGludG8gdGhlIHNhbWUgZGlyZWN0b3J5LCBhbmQgdGhlIHNlcnZlIGRpZCB3aGF0IGl0IHdhcyB3cml0dGVuIHRvIGRvOlxuICpcbiAqICAgR0VUIC9jbGkuanMgICAgIDIwMCAgMjQyLDQzMSBCICB0ZXh0L2phdmFzY3JpcHQgICDihpAgYm91bnR5LCBieXRlLWlkZW50aWNhbFxuICogICBHRVQgL3NlcnZlci5qcyAgMjAwICAyNzYsNDE1IEIgIHRleHQvamF2YXNjcmlwdCAgICAgIHRvIHRoZSBjb21taXR0ZWRcbiAqICAgR0VUIC9qb2luLmpzICAgIDIwMCAgIDQ3LDM0OCBCICB0ZXh0L2phdmFzY3JpcHQgICAgICBhcnRpZmFjdHNcbiAqXG4gKiBhbmQgdGhvc2UgYnVuZGxlcyBhcmUgYnVpbHQgd2l0aCB0aGUgc291cmNlbWFwIEVNQkVEREVELCBzbyBlYWNoIG9uZSBjYXJyaWVzXG4gKiB0aGUgY29tcGxldGUgb3JpZ2luYWwgVHlwZVNjcmlwdC4gRml2ZSBzcGVsbHMg4oCUIGFzdHJvbGFiZSwgYm91bnR5LCBnbGFtb3VyLCBpbWFnbywgbWFncGllXG4gKiDigJQgZWxldmVuIGFydGlmYWN0cywgYWxsIHJlYWNoYWJsZSBieSBhbnkgYnJvd3NlciB0aGF0IGNhbiByZWFjaCB0aGUgZGFlbW9uLlxuICogRGlnZXN0aWZ5IGhpdCB0aGUgaWRlbnRpY2FsIGRlZmVjdCBvbmUgYnJhbmNoIGVhcmxpZXIgYW5kIGFuc3dlcmVkIGl0IGxvY2FsbHk7XG4gKiB0aGlzIGlzIHRoYXQgYW5zd2VyIHJlLWhvbWVkIHRvIHRoZSBvbmUgcGxhY2UgYWxsIGZpdmUgY2FsbGVycyBhbHJlYWR5IHNoYXJlLlxuICpcbiAqIOKblCAqKkRFUklWRUQsIE5PVCBFTlVNRVJBVEVELCBBTkQgTk9UIE1BVENIRUQgQlkgU0hBUEUuKiogQSBsaXRlcmFsIG5hbWUgbGlzdFxuICogaXMgd3JvbmcgYXQgdGhlIG5leHQgYnVpbGQgKHRoZSBjaHVua3MgY2FycnkgY29udGVudCBoYXNoZXMpLiBBIHNoYXBlIG1hdGNoXG4gKiAoYGluZGV4LTxoYXNoPi5qc2ApIGlzIHdyb25nIHRoZSBmaXJzdCB0aW1lIHRoZSBidW5kbGVyIHNwbGl0cyBhIGNodW5rLiBBc2tpbmdcbiAqIHRoZSBlbnRyeSBkb2N1bWVudCB3aGF0IGl0IGxvYWRzIGlzIHRoZSBvbmx5IGZvcm11bGF0aW9uIHRoYXQgaXMgdHJ1ZSBvZlxuICogd2hhdGV2ZXIgYGJ1biBydW4gYnVpbGRgIGFjdHVhbGx5IGVtaXR0ZWQuXG4gKlxuICog4puUICoqQU5EIFRIRSBDTE9TVVJFIElTIFRSQU5TSVRJVkUgRk9SIFRIRSBTQU1FIFJFQVNPTi4qKiBgaW5kZXguaHRtbGAgbGlua3NcbiAqIG9uZSBjaHVuayB0b2RheTsgYSBzcGxpdCBidWlsZCBoYXMgdGhhdCBjaHVuayBgaW1wb3J0IFwiLi9jaHVuay08aGFzaD4uanNcImAsXG4gKiB3aGljaCB0aGUgZW50cnkgZG9jdW1lbnQgbmV2ZXIgbmFtZXMuIFNvIGV2ZXJ5IGFkbWl0dGVkIGAuanNgL2AuY3NzYCBpcyBpdHNlbGZcbiAqIHNjYW5uZWQgZm9yIGAuL2AtcHJlZml4ZWQgc2libGluZ3MsIHVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZyDigJQgYSB3aGl0ZWxpc3RcbiAqIHRoYXQgcmVhZCBvbmx5IHRoZSBlbnRyeSB3b3VsZCA0MDQgYSBsZWdpdGltYXRlIGNodW5rIGluIHJlbGVhc2UsIGFuZCBvbmx5IGluXG4gKiByZWxlYXNlLlxuICpcbiAqIOKblCAqKk1FTUJFUlNISVAgSVMgQU4gRVhBQ1QgTUFUQ0gsIFdISUNIIE1BS0VTIFRIRSBSRUZVU0FMIENBU0UtSU5TRU5TSVRJVkUgQllcbiAqIENPTlNUUlVDVElPTi4qKiBBUEZTIGlzIGNhc2UtaW5zZW5zaXRpdmUsIHNvIGAvSU5ERVguSFRNTGAgYW5kIGAvaU5kRXguSHRNbGBcbiAqIHJlc29sdmUgdG8gdGhlIHNhbWUgaW5vZGUgYSBjYXNlLXNlbnNpdGl2ZSBibGFja2xpc3Qgd291bGQgbWlzcyAobWVhc3VyZWQgb25cbiAqIGFsbCBmaXZlIHNwZWxscyBiZWZvcmUgdGhpcyBmaXg6IGZvdXIgdmFyaWFudHMsIGZvdXIgMjAwcywgdGhyZWUgb2YgdGhlbSBhc1xuICogYGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbWAgYmVjYXVzZSB0aGUgY29udGVudC10eXBlIGxvb2t1cCBpcyBjYXNlLXNlbnNpdGl2ZVxuICogdG9vKS4gQSBzZXQgb2YgZXhhY3RseSB0aGUgZW1pdHRlZCBuYW1lcyByZWZ1c2VzIGV2ZXJ5IHZhcmlhbnQgb2YgZXZlcnkgbmFtZVxuICog4oCUIHNlcnZhYmxlIG9yIG5vdCDigJQgd2l0aCBubyBsb3dlci1jYXNlIHBhc3MgYW55d2hlcmUuXG4gKlxuICog4pqgICoqVEhFIFRSQURFOioqIGEgZmlsZSB0aGUgZW50cnkgZ3JhcGggZG9lcyBub3QgcmVmZXJlbmNlIOKAlCBhIGxhemlseSBmZXRjaGVkXG4gKiBjaHVuaywgYSBmb250IHB1bGxlZCBieSBhIENTUyBgdXJsKClgIHRoaXMgc2NhbiBkb2VzIG5vdCBtb2RlbCwgYW4gYXNzZXQgdGhlXG4gKiBidWlsZCBlbWl0cyBidXQgbm90aGluZyBsaW5rcyDigJQgNDA0cyBpbiByZWxlYXNlIHdpdGggbm90aGluZyByZWQuIEVhY2hcbiAqIGFkb3B0ZXIncyBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBob2xkcyB0aGUgaW5zdHJ1bWVudDogYW4gSU5WRU5UT1JZIGNlbGwgdGhhdFxuICogYWNjb3VudHMgZm9yIGV2ZXJ5IGZpbGUgaW4gYGRpc3QvYCBhcyBzZXJ2ZWQgb3IgZGVsaWJlcmF0ZWx5IHJlZnVzZWQsIHNvIGFuXG4gKiB1bmxpbmtlZCBlbWlzc2lvbiBnb2VzIHJlZCBhdCBidWlsZCB0aW1lIHJhdGhlciB0aGFuIHNpbGVudCBhdCBydW50aW1lLlxuICpcbiAqIOKaoCBUaGUgZW50cnkgZG9jdW1lbnQgaXMgSU4gdGhlIHNldCwgYmVjYXVzZSB0aGUgaG91c2UgY2FsbGVyIG1hcHMgYC9gIHRvXG4gKiBgaW5kZXguaHRtbGAgYW5kIHRoYXQgaXMgdGhlIHN1cmZhY2UuIEEgc3BlbGwgdGhhdCBtdXN0IG5ldmVyIGhhbmQgb3ZlciBpdHNcbiAqIG9uLWRpc2sgZW50cnkg4oCUIGRpZ2VzdGlmeSBzdWJzdGl0dXRlcyBhIHBheWxvYWQgaW50byBpdCBpbiBtZW1vcnkg4oCUIHJlZnVzZXNcbiAqIHRoYXQgT05FIG5hbWUgaW4gaXRzIG93biByb3V0ZXIsIGFib3ZlIHRoaXMgY2FsbC4gVGhhdCByZWZ1c2FsIGlzIHRoZSBzcGVsbCdzO1xuICogZXZlcnl0aGluZyBlbHNlIGhlcmUgaXMgdGhlIGtpdCdzLlxuICovXG5mdW5jdGlvbiBzdXJmYWNlV2hpdGVsaXN0KGRpc3REaXI6IHN0cmluZyk6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICBjb25zdCBjYWNoZWQgPSB3aGl0ZWxpc3RDYWNoZS5nZXQoZGlzdERpcik7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZW50cnkgPSBqb2luKGRpc3REaXIsIFwiaW5kZXguaHRtbFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZW50cnkpKSB7XG4gICAgbmFtZXMuYWRkKFwiaW5kZXguaHRtbFwiKTtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGVudHJ5LCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IFsuLi5yZWZzSW4oaHRtbCwgRU5UUllfUkVGX1JFKSwgLi4ucmVmc0luKGh0bWwsIFJFTEFUSVZFX1JFRl9SRSldO1xuICAgIC8vIFVudGlsIHRoZSBzZXQgc3RvcHMgZ3Jvd2luZzogZWFjaCBhZG1pdHRlZCBjaHVuayBtYXkgbmFtZSB0aGUgbmV4dCBvbmUuXG4gICAgd2hpbGUgKHBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmFtZSA9IHBlbmRpbmcucG9wKCkgYXMgc3RyaW5nO1xuICAgICAgaWYgKG5hbWVzLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAvLyDimqAgUkVGRVJFTkNFRCAqKkFORCoqIFBSRVNFTlQuIEEgbWluaWZpZWQgYnVuZGxlIGNhbiBjb250YWluIGEgc3RyaW5nXG4gICAgICAvLyB0aGF0IG1lcmVseSBMT09LUyBsaWtlIG9uZTsgYWRtaXR0aW5nIG9ubHkgbmFtZXMgdGhhdFxuICAgICAgLy8gYXJlIGFjdHVhbGx5IG9uIGRpc2sga2VlcHMgdGhlIHNjYW4gZnJvbSB3aWRlbmluZyB0aGUgc2V0IG9uIGFcbiAgICAgIC8vIGNvaW5jaWRlbmNlLCBhbmQgYSBuYW1lIHRoYXQgaXMgYWJzZW50IDQwNHMgaWRlbnRpY2FsbHkgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKGRpc3REaXIsIG5hbWUpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSBjb250aW51ZTtcbiAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgIGlmICghVFJBTlNJVElWRV9FWFRTLnNvbWUoKGV4dCkgPT4gbmFtZS5lbmRzV2l0aChleHQpKSkgY29udGludWU7XG4gICAgICBwZW5kaW5nLnB1c2goLi4ucmVmc0luKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0ZjhcIiksIFJFTEFUSVZFX1JFRl9SRSkpO1xuICAgIH1cbiAgfVxuXG4gIHdoaXRlbGlzdENhY2hlLnNldChkaXN0RGlyLCBuYW1lcyk7XG4gIHJldHVybiBuYW1lcztcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgc2VydmVyIHNpZGUgb2YgdGhlIFNTRSB0YWlsIOKAlCB0aGUgZGFlbW9uLXNpZGUgdHdpbiBvZlxuICogYHRhaWxFdmVudHMudHNgLiBUaGF0IG1vZHVsZSBkZWNpZGVzIHdoYXQgYSBjYWxsZXIgb2JzZXJ2ZXM7IHRoaXMgb25lIGRlY2lkZXNcbiAqIHdoYXQgYSBjYWxsZXIgaXMgc2VudC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBleGNlcHQgaXRzXG4gKiBvd24gc2libGluZyB0eXBlcywgd2hpY2ggaXMgc3RpbGwgaW5zaWRlIHRoZSBsZWFmLlxuICpcbiAqIENvbnZlcmdlZCAyMDI2LTA5LTA4IChQaGFzZSAxYiBjaGFwdGVyIDIpIFRPV0FSRCBtaW5kLW1hcHBlcidzIGBzc2VSZXNwb25zZWAsXG4gKiB0aGUgY2Vuc3VzJ3MgY29udmVyZ2VuY2UgdGFyZ2V0ICMxOiB0aGUgb25seSBvbmUgb2YgdGhlIHNldmVuIHdpdGggYVxuICogb25jZS1vbmx5IHRlYXJkb3duIGZ1bm5lbCwgdGhlIG9ubHkgb25lIHdpcmVkIHRvIGByZXEuc2lnbmFsYCwgYW5kIHRoZSBvbmx5XG4gKiBvbmUgd2hvc2UgY29tbWVudCByZWNvcmRzIGEgTUVBU1VSRUQgcmVzdWx0IHJhdGhlciB0aGFuIGEgYmVsaWVmLlxuICpcbiAqIOKUgOKUgCDim5QgQU5EIFdIQVQgVEhFIENPUFkgTEVGVCBCRUhJTkQsIFNBSUQgSEVSRSBCRUNBVVNFIEEgTE9TUyBSRUNPUkRFRCBPTkxZIElOXG4gKiAgICBBIFBPUlQnUyBKT1VSTkFMIEdFVFMgUkUtTElUSUdBVEVEIEJZIEVWRVJZIFNQRUxMIEFGVEVSIElUIChENzkvRDg1KSDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgc2VudGVuY2UgYWJvdmUgbmFtZXMgYSBTT1VSQ0UgdGhpcyBtb2R1bGUgaGFkIG5ldmVyIGJlZW4gY2hlY2tlZCBhZ2FpbnN0OlxuICogRDEgcnVsZWQgdGhlIHNwaW5lIGJlIHByb3ZlbiBvbiB0aGUgdHdvIHNwZWxscyB0aGF0IGFscmVhZHkgYnVpbHQsIGFuZCBib3RoIG9mXG4gKiB0aG9zZSBhcmUgZG93bnN0cmVhbSBGT1JLUyBvZiB0aGUgbWluZC1tYXBwZXIgbGluZSwgc28gdGhlIGJvdW5kYXJpZXMgd2VyZVxuICogc2V0dGxlZCBhZ2FpbnN0IHR3byBjb3BpZXMgd2hpbGUgdGhlIG9yaWdpbmFsIHdhcyBub3QgaW4gdGhlIHJvb20uICoqQVxuICogY29udmVyZ2VuY2UgY2FuIG5hbWUgaXRzIHNvdXJjZSBhbmQgc3RpbGwgbmV2ZXIgY29uc3VsdCBpdC4qKlxuICpcbiAqIFdoZW4gaXQgd2FzIGZpbmFsbHkgY29uc3VsdGVkIChQaGFzZSA3LCB0aGUgbGFzdCBwb3J0KSwgZXhhY3RseSBPTkUgcHJvcGVydHlcbiAqIG9mIHRoZSBzb3VyY2Ugd2FzIG1pc3NpbmcgaGVyZSwgYW5kIGl0IG9jY3VwaWVkIG5vIHR5cGU6ICoqbWluZC1tYXBwZXIgd3JvdGVcbiAqIGl0cyBgdGFpbCAtLWluYm91bmRgIGdyb3VuZGluZyBmcmFtZSBCRUZPUkUgdGhlIHJlcGxheSoqIOKAlCBvbmUgbGluZSBhYm92ZVxuICogYGJ1cy5zdWJzY3JpYmVgIOKAlCBzbyBpdCB3YXMgdGhlIHN0cmVhbSdzIGZpcnN0IGRhdGEgbGluZS4gYG9uT3BlbmAgZmlyZXMgYXRcbiAqIHRoZSBFTkQgb2YgYHN0YXJ0YCwgYWZ0ZXIgdGhlIHByZWFtYmxlLCBhZnRlciBgbG9nLnN1YnNjcmliZWAsIGFmdGVyXG4gKiBgY2xpZW50cy5hZGRgLCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVkIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmQgc2VudCBmcm9tXG4gKiB0aGVyZSB3b3VsZCBsYW5kIHRoZSBmcmFtZSBBRlRFUiB0aGUgcmVwbGF5ZWQgYmFja2xvZy4gVGhhdCBpcyBFWFBSRVNTSUJMRSxcbiAqIHdoaWNoIGlzIHdoYXQgbWFrZXMgdGhpcyBhIG1lYXN1cmVtZW50IHJhdGhlciB0aGFuIGFuIGFzc2VydGlvbjogdGhlXG4gKiBwbGF5Ym9vaydzIHR5cGUtdG8tdHlwZSBjb21wYXRpYmlsaXR5IHByb2NlZHVyZSBhbnN3ZXJzIFwicmVwcmVzZW50YWJsZVwiIGhlcmVcbiAqICh0aGUgc3ViamVjdCB0eXBlIGlzIGBTZXQ8U3NlQ2xpZW50PmAsIHRoZSBzcGVsbCBrZWVwcyBubyByZWdpc3RyeSwgc28geW91XG4gKiBwYXNzIGFuIGVtcHR5IHNldCkgYW5kIGEgdHlwZSBjaGVjayBjYW5ub3Qgc2VlIGEgUE9TSVRJT04uXG4gKlxuICogKipUaGUgZGlzcG9zaXRpb24gd2FzIFJFU1RPUkUsIG5vdCBLRUVQLUxPQ0FMIGFuZCBub3QgRklMRSoqIOKAlCBzZWVcbiAqIGBvcGVuRnJhbWVzYCBiZWxvdywgd2hlcmUgdGhlIHR3byBudW1iZXJzIHRoYXQgcGVybWl0IGl0IGFyZSByZWNvcmRlZCBhbmRcbiAqIGRyaXZlbi4gVGhlIGdlbmVyYWxpc2F0aW9uLCB3aGljaCBpcyB0aGUgcGFydCB3b3J0aCBjYXJyeWluZzogd2hlcmUgYVxuICogbW9kdWxlJ3Mgc3ViamVjdCBpcyBhIFNFUVVFTkNFIE9GIFdSSVRFUywgY29tcGFyZSB0aGUgT1JERVIgb2YgaXRzIGhvb2tzXG4gKiBhZ2FpbnN0IHRoZSBvcmRlciB0aGUgYWRvcHRpbmcgc3BlbGwgd3JpdGVzIGluLiBUd28gaG9va3Mgd2l0aCB0aGUgcmlnaHRcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIHdyb25nIG9yZGVyIGFyZSBhcyBpbmNvbXBhdGlibGUgYXMgdHdvIHR5cGVzIHRoYXQgd2lsbCBub3RcbiAqIHVuaWZ5LCBhbmQgb25seSBvbmUgb2YgdGhlIHR3byBjYW4gYmUgU0VFTiBieSBhIGNvbXBhdGliaWxpdHkgY2hlY2suXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqICAgIENMSUVOVC4gTUVBU1VSRUQgT04gQlVOIDEuMy4xNCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBTaXggZGFlbW9ucyB3cml0ZSBhIGhlYXJ0YmVhdCBhcyBgdHJ5IHsgY29udHJvbGxlci5lbnF1ZXVlKC4uLikgfSBjYXRjaCB7fWBcbiAqIHdpdGggYSBjb21tZW50IHNheWluZyB0aGUgY2F0Y2ggaXMgaG93IGEgZGVwYXJ0ZWQgY2xpZW50IGlzIG5vdGljZWQuIEl0IGlzXG4gKiBub3Q6IGVucXVldWUgb24gYW4gb3JwaGFuZWQgc3RyZWFtIEJVRkZFUlMgU0lMRU5UTFkgYW5kIG5ldmVyIHRocm93cywgc28gdGhlXG4gKiBjYXRjaCBuZXZlciBmaXJlcyBhbmQgdGhvc2UgZGFlbW9ucycgZGVhZC1jbGllbnQgZGV0ZWN0aW9uIHJlc3RzIG9uIGFcbiAqIG1lY2hhbmlzbSB0aGVpciBvd24gY29tbWVudHMgZGVzY3JpYmUgaW5jb3JyZWN0bHkuIFdoYXQgYWN0dWFsbHkgcmVjbGFpbXMgdGhlXG4gKiBjb25uZWN0aW9uIGlzIHRoZSBzdHJlYW0ncyBgY2FuY2VsKClgIOKAlCBhbmQsIGZvciBhIGNsaWVudCB0aGF0IG5ldmVyIGNsb3Nlc1xuICogdGhlIHNvY2tldCwgYHJlcS5zaWduYWxgLlxuICpcbiAqIFNvIHRoZSBmdW5uZWwgYmVsb3cgaXMgdGhlIGxvYWQtYmVhcmluZyBwYXJ0LiBgdGVhcmRvd24oKWAgcnVucyBBVCBNT1NUIE9OQ0VcbiAqIGZyb20gZXZlcnkgcGF0aCB0aGVyZSBpcyDigJQgYGNhbmNlbCgpYCwgYW4gYWJvcnQgb24gdGhlIHJlcXVlc3Qgc2lnbmFsLCBhbmRcbiAqIHRoZSBiZWx0LWFuZC1icmFjZXMgZW5xdWV1ZSBjYXRjaCDigJQgYW5kIGl0IGlzIHdoZXJlIHRoZSBzdWJzY3JpYmVyIGNvdW50IGFuZFxuICogYW55IHByZXNlbmNlIGRlY3JlbWVudCByaWRlLiBCb3VuZGluZyBwcmVzZW5jZSBhY2N1cmFjeSBpcyBib3VuZGluZyB0aGF0XG4gKiBmdW5uZWwuXG4gKlxuICog4pqgIEtub3duIGhvbGUsIGFjY2VwdGVkIGFuZCBpbmhlcml0ZWQ6IEJ1bidzIG93biBgZmV0Y2goKWAgcmVhZGVyIGAuY2FuY2VsKClgXG4gKiBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgdGhlIHNlcnZlciBjYW5ub3Qgc2VlIGl0LiBSZWFsIGNsaWVudHMgY2xvc2VcbiAqIHRoZSBzb2NrZXQuXG4gKlxuICog4pSA4pSAIOKblCBHUkFQRVZJTkUgRE9FUyBOT1QgQURPUFQgVEhJUywgQU5EIFRIRSBSRUZVU0FMIElTIFBBUlQgT0YgVEhFIFJVTElORyDilIDilIBcbiAqXG4gKiBSRUpFQ1QtU1RSVUNUVVJBTCwgcnVsZWQgYXQgZ3JhcGV2aW5lJ3MgcG9ydCAoUGhhc2UgNiwgMjAyNi0wOS0wOTsgRDY4KS5cbiAqIEdyYXBldmluZSBIQVMgYW4gU1NFIHJlZ2lzdHJ5IGFuZCBpdCBpcyB0aGUgYnVzaWVzdCB0aGluZyBpbiB0aGUgc3BlbGw7IHRoZVxuICogdHdvIHR5cGVzIHNpbXBseSBjYW5ub3QgYmUgY29uc3RydWN0ZWQgZnJvbSBlYWNoIG90aGVyOlxuICpcbiAqICAgdGhpcyBtb2R1bGUgIGBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD5gIHdoZXJlIGBTc2VDbGllbnQgPSB7Y2xvc2UsIHNlbmR9YFxuICogICAgICAgICAgICAgICAg4oCUIGEgcmVnaXN0cnkgb2YgQU5PTllNT1VTIGNsb3NlcnMsIGFuZCBgc2l6ZWAgaXMgdGhlIG9ubHkgdGhpbmdcbiAqICAgICAgICAgICAgICAgIGFueSBhZG9wdGluZyBkYWVtb24gcmVhZHMgb2ZmIGl0LlxuICogICBncmFwZXZpbmUgICAgYE1hcDxzeW1ib2wsIHthbGlhcywgaHVtYW4sIGx1cmssIHNlbmR9PmAsIHBlciBjaGFubmVsLlxuICpcbiAqICoqVGhlIHJlYWRlcnMgdGhhdCBtYWtlIHRoZW0gaW5jb21wYXRpYmxlLCBjb3VudGVkIHJhdGhlciB0aGFuIGFzc2VydGVkOiBTSVhcbiAqIHJvdXRlcyByZWFkIGBhbGlhc2AvYGh1bWFuYC9gbHVya2AqKiDigJQgYEdFVCAvY2hhbm5lbHNgICh0aHJvdWdoXG4gKiBgbGlzdENoYW5uZWxzYCDihpIgYHZpc2libGVTdWJzYCksIGBHRVQgL3ByZXNlbmNlYCwgYFBPU1QgL2NoYW5uZWxzYCxcbiAqIGBQT1NUIC9hbm5vdW5jZWAsIGBQT1NUIC9jaGFubmVscy86bmFtZS9tZXNzYWdlc2AsIGFuZFxuICogYEdFVCAvY2hhbm5lbHMvOm5hbWUvc3Vic2NyaWJlcnNgLiBgYWxpYXNgIGlzIGEgbmFtZSBhIGh1bWFuIHNlZXMgaW4gYSByb3N0ZXIsXG4gKiBgaHVtYW5gIHRlbGxzIGFuIGFnZW50IGl0IGlzIHRhbGtpbmcgdG8gYSBwZXJzb24sIGFuZCBgbHVya2AgZXhjbHVkZXMgYVxuICogY29ubmVjdGlvbiBmcm9tIGV2ZXJ5IHByZXNlbmNlIGNvdW50LiBUaGVyZSBpcyBubyB3YXkgdG8gcHV0IGFueSBvZiB0aGF0IGludG9cbiAqIGEgc2V0IG9mIGNsb3NlcnMuIEFkb3B0aW5nIHRoaXMgbW9kdWxlIHdvdWxkIG5vdCBiZSBkZWFkIGNvZGU7IGl0IHdvdWxkIGJlIGFcbiAqIHJld3JpdGUgb2Ygd2hhdCBncmFwZXZpbmUgSVMuXG4gKlxuICog4pqgICoqQU5EIFRIRSBMSVNUIElTIERFTElCRVJBVEVMWSBOT1QgVEhFIE9CVklPVVMgT05FLioqIFRoZSBwb3J0J3MgZmlyc3RcbiAqIGNvdW50IG5hbWVkIHRoZSBgcm9sbGAvY2xlYXIgYnJvYWRjYXN0LCB0aGUgYXJjaGl2ZSBsaXZlLWd1YXJkIGFuZCB0d29cbiAqIFJFR0lTVFJBVElPTlMg4oCUIGFuZCBldmVyeSBvbmUgb2YgdGhvc2UgaXMgYSBzaXRlIHRoaXMgbW9kdWxlJ3MgdHlwZSB3b3VsZFxuICogc2VydmUgcGVyZmVjdGx5OiB0aGUgYnJvYWRjYXN0IHJlYWRzIG9ubHkgYHMuc2VuZGAsIHRoZSBsaXZlLWd1YXJkIG9ubHlcbiAqIGBzdWJzY3JpYmVycy5zaXplYCAod2hpY2ggdGhpcyBoZWFkZXIgaXRzZWxmIHNheXMgaXMgYWxsIGFueSBhZG9wdGVyIHJlYWRzKSxcbiAqIGFuZCBhIHJlZ2lzdHJhdGlvbiBXUklURVMgdGhlIHJlY29yZCByYXRoZXIgdGhhbiByZWFkaW5nIGl0LiBUaGUgc2l4IGFib3ZlIGFyZVxuICogdGhlIG9uZXMgdGhhdCByZWFkIGEgZmllbGQgdGhlIGtpdCdzIGBTc2VDbGllbnRgIGRvZXMgbm90IGhhdmU7IHRoZSB3cml0ZXJzXG4gKiAoYC93YWl0YCdzIHByZXNlbmNlIHJlZ2lzdHJhdGlvbiBhbmQgdGhlIHRhaWwncykgYXJlIG5hbWVkIHNlcGFyYXRlbHkgYmVjYXVzZVxuICogYSB3cml0ZXIgaXMgbm90IGV2aWRlbmNlIG9mIGFueXRoaW5nLiBDb3VudGVkIGluIHRoZSBwcmUtcG9ydCBkYWVtb24sXG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2RhZW1vbi50c2Agb24gYGRldmVsb3BgOlxuICogbC40MjEsIDczOS03NDcsIDgyNiwgODg2LTg4NywgMTA0OS0xMDU0LCAxMTgyLTExODgg4oCUIHdyaXRlcnMgYXQgMTExMS0xMTEyIGFuZFxuICogMTMwNy4gKENvcnJlY3RlZCAyMDI2LTA5LTA5IGluIHRoZSByZXBhaXIgY2hhcHRlcjsgRDY4J3MgcmVxdWlyZW1lbnQgaXMgdGhhdFxuICogdGhlIHJlZnVzYWwgYmUgd3JpdHRlbiB3aGVyZSB0aGUgbmV4dCByZWFkZXIgbWVldHMgaXQsIHdoaWNoIG1ha2VzIGFcbiAqIG1pcy1tZWFzdXJlZCBsaXN0IHdvcnNlIHRoYW4gbm9uZS4pXG4gKlxuICog4pqgIEFuZCBncmFwZXZpbmUncyByZWNvcmRzIGNhcnJ5IG5vIGBjbG9zZWAgYXQgYWxsIOKAlCB0aGUgcGVyLXN0cmVhbSB0ZWFyZG93biBpc1xuICogYSBjbG9zdXJlIHN0YXNoZWQgb24gdGhlIFJlYWRhYmxlU3RyZWFtIGNvbnRyb2xsZXIsIHJlYWNoYWJsZSBvbmx5IGZyb21cbiAqIGBjYW5jZWwoKWAg4oCUIHdoaWNoIGlzIGFsc28gd2h5IGBob3VzZWtlZXBpbmdgJ3MgYGRyYWluQW5kU3RvcGAgaXMgYWRvcHRlZFxuICogdGhlcmUgd2l0aCBpdHMgYGNsaWVudHNgIGFyZ3VtZW50IGRlbGliZXJhdGVseSBlbXB0eS5cbiAqXG4gKiAqKlRoZSB3aWRlbmluZyBOT1QgZG9uZSwgd2l0aCBpdHMgY29zdDoqKiBhZG1pdHRpbmcgYW4gYWxpYXMtYmVhcmluZyByZWNvcmRcbiAqIHdvdWxkIGNoYW5nZSB0aGUgdHlwZSBmaXZlIG90aGVyIGRhZW1vbnMgY29tcGlsZSBhZ2FpbnN0IGFuZCByZS1lbWl0IFNJWFxuICogYXJ0aWZhY3RzIGFjcm9zcyBGSVZFIHNwZWxscywgZWFjaCBvd2VkIGEgZHJpdmUuIEl0IHdvdWxkIGFsc28gcmUtY3JlYXRlIHRoZVxuICogdGhpbmcgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gc3RvcCwgYW5kIHRoaXMgZmlsZSdzIG93biBib3VuZGFyeSBwYXJhZ3JhcGhcbiAqIHNheXMgaG93OiBhIHNpZ25hdHVyZSB3aWRlIGVub3VnaCB0byBhYnNvcmIgZXZlcnkgY2FsbGVyJ3Mgc2hhcGUgc3RvcHMgYmVpbmcgYVxuICogcmVnaXN0cnkgYW5kIGJlY29tZXMgYSB1bmlvbi4gVGhlIGNlbnN1cyBjb252ZXJnZWQgY29waWVzIGludG8gb25lIG1vZHVsZSBieVxuICogZmluZGluZyB3aGF0IHRoZXkgU0hBUkVEOyBhIG1vZHVsZSB3aWRlbmVkIHRvIGZpdCB0aGUgb25lIHNwZWxsIHRoYXQgc2hhcmVzXG4gKiBub3RoaW5nIGlzIHRob3NlIGNvcGllcyBhZ2FpbiB3aXRoIGEgdW5pb24gdHlwZSBvdmVyIHRoZSB0b3AuIFRoZSBzcGVsbCBrZWVwc1xuICogaXRzIG93biwgYW5kIGEgd2lkZW5pbmcgcmVtYWlucyBhIHNlcGFyYXRlLCBhcmd1ZWQgZGVjaXNpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmVudExvZywgRnJhbWUgfSBmcm9tIFwiLi9ldmVudExvZy50c1wiO1xuXG4vKipcbiAqIE9uZSBvcGVuIFNTRSBzdHJlYW0sIGFzIHRoZSBkYWVtb24gY2FuIGFjdCBvbiBpdDogZW5kIGl0LCBvciBwdXNoIGEgZnJhbWUgdG9cbiAqIGl0IHRoYXQgZGlkIG5vdCBjb21lIG91dCBvZiB0aGUgbG9nLlxuICpcbiAqIOKblCBJVCBJUyBOT1QgQSBDT05UUk9MTEVSLiBUaGUgY29waWVzIGhlbGRcbiAqIGBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj5gIGFuZCBjbG9zZWQgdGhlbSBkaXJlY3RseSBhdCB0ZWFyZG93bixcbiAqIHdoaWNoIGJ5cGFzc2VzIHRoZSB0ZWFyZG93biBmdW5uZWwgYWJvdmUg4oCUIHRoZSBoZWFydGJlYXQgaW50ZXJ2YWwgZm9yIHRoYXRcbiAqIHN0cmVhbSB3YXMgY2xlYXJlZCBvbmx5IGJlY2F1c2UgYSBzZWNvbmQgYFNldGAgb2YgdGltZXJzIHdhcyBrZXB0IGluIHBhcmFsbGVsXG4gKiBhbmQgc3dlcHQgc2VwYXJhdGVseS4gRXZlcnl0aGluZyBoZXJlIGdvZXMgdGhyb3VnaCB0aGUgZnVubmVsLCBhbmQgYSBgc2VuZGBcbiAqIGFmdGVyIHRlYXJkb3duIGlzIGEgbm8tb3AgcmF0aGVyIHRoYW4gYSB0aHJvdy5cbiAqXG4gKiDimqAgKipgc2VuZGAgQVJSSVZFRCBJTiBQSEFTRSAyLCBGUk9NIFRIRSBGSVJTVCBDT05TVU1FUiBUSEFUIFdBUyBOT1QgT05FIE9GIFRIRVxuICogVFdPIFRISVMgTU9EVUxFIFdBUyBERVNJR05FRCBBR0FJTlNULioqIGFzdHJvbGFiZSBhbmQgbWFncGllIGFubm91bmNlIHByZXNlbmNlXG4gKiBvdmVyIHRoZWlyIGJyb3dzZXIgV0VCU09DS0VULCBzbyBhIHJlZ2lzdHJ5IG9mIGJhcmUgY2xvc2VycyB3YXMgc3VmZmljaWVudCBhbmRcbiAqIHRoZSBib3VuZGFyeSBsb29rZWQgcmlnaHQuIGdsYW1vdXIgYW5ub3VuY2VzIGl0IG9uIHRoZSBBR0VOVCdzIFNTRSB0YWlsIOKAlFxuICogYHt0eXBlOlwiY29ubmVjdGVkXCJ9YCAvIGB7dHlwZTpcImRpc2Nvbm5lY3RlZFwifWAsIGRlbGliZXJhdGVseSB1bmxvZ2dlZCwgc28gYVxuICogcmVjb25uZWN0aW5nIGFnZW50IGRvZXMgbm90IHJlLXNlZSBldmVyeSBwYXN0IGNvbm5lY3QgYW5kIHNvIHRoZSBmcmFtZSBuZXZlclxuICogYWR2YW5jZXMgYSB0YWlsIGN1cnNvci4gVGhhdCBpcyBub3QgYSBnbGFtb3VyIHF1aXJrOyBpdCBpcyB0aGUgZ2VuZXJhbCBzaGFwZVxuICogb2YgXCJ0ZWxsIHRoZSBsaXZlIHN1YnNjcmliZXJzIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBoaXN0b3J5XCIsIGFuZFxuICogYSByZWdpc3RyeSB0aGF0IGNhbiBvbmx5IEVORCBhIHN0cmVhbSBjYW5ub3QgZXhwcmVzcyBpdC4gV2l0aG91dCB0aGlzIHRoZVxuICogc3BlbGwgd291bGQgaGF2ZSBoYWQgdG8ga2VlcCBpdHMgb3duIHBhcmFsbGVsIGBTZXRgIG9mIGNvbnRyb2xsZXJzLCB3aGljaCBpc1xuICogZXhhY3RseSB0aGUgZHJpZnQgdGhpcyByZWdpc3RyeSBleGlzdHMgdG8gcmVtb3ZlLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnQgPSB7XG4gIC8qKiBFbmQgdGhpcyBzdHJlYW0sIHRocm91Z2ggdGhlIHRlYXJkb3duIGZ1bm5lbCwgYXQgbW9zdCBvbmNlLiAqL1xuICBjbG9zZSgpOiB2b2lkO1xuICAvKiogV3JpdGUgb25lIHJhdyBTU0UgY2h1bmsgdG8gdGhpcyBzdHJlYW0uIE5vLW9wIG9uY2UgdG9ybiBkb3duLiAqL1xuICBzZW5kKGNodW5rOiBzdHJpbmcpOiB2b2lkO1xufTtcblxuLyoqXG4gKiBUaGUgbGl2ZS10YWlsIHJlZ2lzdHJ5LiBgc2l6ZWAgaXMgdGhlIGRhZW1vbidzIFNTRSBzdWJzY3JpYmVyIGNvdW50IOKAlCB0aGVcbiAqIG51bWJlciBgc2hvdWxkSWRsZUNsb3NlYCBtdXN0IHNlZSDigJQgYW5kIGNsb3NpbmcgZXZlcnkgZW50cnkgaXMgd2hhdCBhIGRyYWluXG4gKiBkb2VzLlxuICovXG5leHBvcnQgdHlwZSBTc2VDbGllbnRzID0gU2V0PFNzZUNsaWVudD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlT3B0aW9uczxUIGV4dGVuZHMgb2JqZWN0PiB7XG4gIC8qKiBUaGUgbG9nIHRvIHJlcGxheSBmcm9tIGFuZCBzdWJzY3JpYmUgdG8uICovXG4gIGxvZzogRXZlbnRMb2c8VD47XG4gIC8qKiBUaGUgY2FsbGVyJ3MgcmVzdW1lIGN1cnNvci4gQWJzZW50IG9yIHVucGFyc2VhYmxlIHJlcGxheXMgZnJvbSB0aGUgc3RhcnQuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBIZWFydGJlYXQgY29tbWVudCBpbnRlcnZhbC4gTVVTVCBzdGF5IHdlbGwgdW5kZXIgdGhlIHNlcnZlcidzXG4gICAqICBgaWRsZVRpbWVvdXRgIOKAlCBzZWUgYGhlYXJ0YmVhdC50c2AsIHdoaWNoIGlzIHdoZXJlIHRoYXQgcGFpciBsaXZlcy4gKi9cbiAgaGVhcnRiZWF0TXM6IG51bWJlcjtcbiAgLyoqIExpdmVuZXNzIHJlZ2lzdHJ5OyB0aGUgc3RyZWFtIGFkZHMgaXRzZWxmIG9uIG9wZW4gYW5kIHJlbW92ZXMgaXRzZWxmIGluXG4gICAqICB0aGUgdGVhcmRvd24gZnVubmVsLiAqL1xuICBjbGllbnRzPzogU3NlQ2xpZW50cztcbiAgLyoqIGByZXEuc2lnbmFsYCDigJQgdGhlIG9ubHkgdGhpbmcgdGhhdCByZWNsYWltcyBhIGNsaWVudCB0aGF0IHdlbnQgYXdheVxuICAgKiAgd2l0aG91dCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0uICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogU2VydmVyLXNpZGUgZmlsdGVyLiBBIHJlamVjdGVkIGZyYW1lIGlzIG5vdCBzZW50OyB0aGUgY2xpZW50IHN0aWxsXG4gICAqICBhZHZhbmNlcyBpdHMgY3Vyc29yIHBhc3QgaXQsIHdoaWNoIGlzIGB0YWlsRXZlbnRzYCdzIGRvY3VtZW50ZWQgcnVsZS4gKi9cbiAgZmlsdGVyPzogKGZyYW1lOiBGcmFtZTxUPikgPT4gYm9vbGVhbjtcbiAgLyoqXG4gICAqIFJhdyBTU0UgY2h1bmtzIHdyaXR0ZW4gdG8gVEhJUyBzdHJlYW0gQkVGT1JFIHRoZSByZXBsYXkg4oCUIGFmdGVyIHRoZVxuICAgKiBgXCI6IGNvbm5lY3RlZFwiYCBwcmVhbWJsZSBhbmQgYmVmb3JlIGBsb2cuc3Vic2NyaWJlYCwgc28gd2hhdGV2ZXIgaXQgcmV0dXJuc1xuICAgKiBpcyB0aGUgc3RyZWFtJ3MgZmlyc3QgREFUQSBsaW5lIHJhdGhlciB0aGFuIGEgZnJhbWUgYnVyaWVkIGJlaGluZCBhXG4gICAqIHJlcGxheWVkIGJhY2tsb2cuXG4gICAqXG4gICAqIOKblCBJVCBJUyBBIFBPU0lUSU9OLCBXSElDSCBJUyBXSFkgYG9uT3BlbmAgQ09VTEQgTk9UIFNFUlZFIChEODUpLiBgb25PcGVuYFxuICAgKiBmaXJlcyBhdCB0aGUgZW5kIG9mIGBzdGFydGAg4oCUIGFmdGVyIHRoZSBwcmVhbWJsZSwgYWZ0ZXIgYGxvZy5zdWJzY3JpYmVgLFxuICAgKiBhZnRlciBgY2xpZW50cy5hZGRgIOKAlCBzbyBhIGNhbGxlciB0aGF0IHN1cHBsaWVzIGl0cyBvd24gYGNsaWVudHNgIHNldCBhbmRcbiAgICogc2VuZHMgZnJvbSB0aGVyZSBsYW5kcyBpdHMgZnJhbWUgQUZURVIgdGhlIGJhY2tsb2cuIFRoYXQgaXMgZXhwcmVzc2libGUgYW5kXG4gICAqIGl0IGlzIHRoZSB3cm9uZyBvcmRlciwgd2hpY2ggaXMgdGhlIG5lYXItbWlzcyB0aGF0IG1ha2VzIHRoaXMgYSBtZWFzdXJlbWVudFxuICAgKiByYXRoZXIgdGhhbiBhbiBhc3NlcnRpb246IG5vdGhpbmcgYWJvdXQgdGhlIFRZUEVTIHByZXZlbnRzIGl0LCBhbmQgYVxuICAgKiB0eXBlLXRvLXR5cGUgY29tcGF0aWJpbGl0eSBjaGVjayBjYW5ub3Qgc2VlIGEgcG9zaXRpb24uXG4gICAqXG4gICAqIOKblCBSRVNUT1JFRCBGUk9NIFRIRSBTUEVMTCBUSElTIE1PRFVMRSBXQVMgQ09OVkVSR0VEIFRPV0FSRCwgQU5EIElUIElTIEFcbiAgICogUkVTVE9SQVRJT04gUkFUSEVSIFRIQU4gQSBXSURFTklORyBPTiBUV08gTUVBU1VSRUQgTlVNQkVSUyAoRDc5L0Q4NSkuXG4gICAqIG1pbmQtbWFwcGVyJ3MgYHNzZVJlc3BvbnNlYCB3cm90ZSBpdHMgYHRhaWwgLS1pbmJvdW5kYCBncm91bmRpbmcgZnJhbWUgb25lXG4gICAqIGxpbmUgQUJPVkUgYGJ1cy5zdWJzY3JpYmVgOyB0aGlzIG1vZHVsZSdzIGNvbnZlcmdlbmNlIGRyb3BwZWQgdGhlIHBvc2l0aW9uLFxuICAgKiBzbyB0aGUgb25seSBwcm9wZXJ0eSBtaW5kLW1hcHBlciBjb3VsZCBub3QgYWRvcHQgd2FzIHRoZSBvcmRlcmluZy4gQXBwbGllZCxcbiAgICogd2l0aCBldmVyeSBraXQtYnVuZGxpbmcgc3BlbGwgcmVidWlsdDogKiooYSkgc291cmNlIGVkaXRzIG5lZWRlZCBhdCB0aGVcbiAgICogb3RoZXIgZml2ZSBhZG9wdGVyczogWkVSTyoqIOKAlCB0aGUgZmllbGQgaXMgb3B0aW9uYWwgYW5kIG5vYm9keSBwYXNzZXMgaXQ7XG4gICAqICoqKGIpIGJ5dGVzIG9mIGFueSBvdGhlciBhZG9wdGVyJ3MgV0lSRSB0aGF0IGRpZmZlcjogWkVSTyoqIOKAlCBhc3Ryb2xhYmUsXG4gICAqIGJvdW50eSwgZ2xhbW91ciwgaW1hZ28gYW5kIG1hZ3BpZSB3ZXJlIGRyaXZlbiB1bmRlciB0aGVpciBvd24gc3VpdGVzIGFuZFxuICAgKiB0aGVpciByZWxlYXNlIGRyaXZlcywgYW5kIG5vbmUgb2YgdGhlbSB3cml0ZXMgYXQgb3Blbi4gQm90aCBudW1iZXJzIHplcm8gaXNcbiAgICogd2hhdCBcInRoZSBraXQgcmVtb3ZlZCBpdCB3aGVuIGl0IGNvcGllZFwiIG1lYW5zIG9wZXJhdGlvbmFsbHkuXG4gICAqXG4gICAqIOKaoCBBTkQgVEhFIEhPT0sgV0FTIFJFSkVDVEVEIE9OQ0UsIEZPUiBBIFJFQVNPTiBUSEFUIERPRVMgTk9UIFJFQUNIIFRISVNcbiAgICogQ0FTRS4gRDMyJ3Mgbm90LXRha2VuIGFyZ3VlZCBhZ2FpbnN0IFwiYSBgc3NlUmVzcG9uc2VgIGhvb2sgdGhhdCBoYW5kcyB0aGVcbiAgICogY2FsbGVyIGEgcmF3IGBzZW5kYCDigKYgdGhlIGNhbGxlciB0aGVuIGhhcyB0byBrZWVwIGl0cyBvd24gY29sbGVjdGlvbiBvZlxuICAgKiB0aGVtXCIg4oCUIGFnYWluc3QgZ2xhbW91cidzIHByZXNlbmNlIEJST0FEQ0FTVCwgd2hpY2ggcHVzaGVzIHRvXG4gICAqIGFscmVhZHktb3BlbiBzdHJlYW1zIGZyb20gb3V0c2lkZSBhbmQgZG9lcyBuZWVkIGEgY29sbGVjdGlvbi4gVGhpcyBpcyBvbmVcbiAgICogZnJhbWUsIG9uIG9uZSBzdHJlYW0sIGF0IG9wZW4sIGFuZCB0aGUgY2FsbGVyIGtlZXBzIG5vIGNvbGxlY3Rpb24gYXQgYWxsLlxuICAgKiBBIHJlamVjdGlvbiBpcyBzY29wZWQgdG8gdGhlIGNhc2UgdGhhdCBwcm9kdWNlZCBpdC5cbiAgICovXG4gIG9wZW5GcmFtZXM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFJ1biBhZnRlciB0aGUgc3RyZWFtIGlzIHN1YnNjcmliZWQgKHByZXNlbmNlIHVwLCBhY3Rpdml0eSB0b3VjaCkuICovXG4gIG9uT3Blbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBSdW4gZXhhY3RseSBvbmNlLCBmcm9tIHdoaWNoZXZlciB0ZWFyZG93biBwYXRoIGZpcmVzIGZpcnN0LiAqL1xuICBvbkNsb3NlPzogKCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNzZVJlc3BvbnNlPFQgZXh0ZW5kcyBvYmplY3Q+KG9wdHM6IFNzZU9wdGlvbnM8VD4pOiBSZXNwb25zZSB7XG4gIGNvbnN0IHsgbG9nLCBzaW5jZSwgaGVhcnRiZWF0TXMsIGNsaWVudHMsIHNpZ25hbCwgZmlsdGVyLCBvcGVuRnJhbWVzLCBvbk9wZW4sIG9uQ2xvc2UgfSA9IG9wdHM7XG5cbiAgbGV0IHVuc3Vic2NyaWJlOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgbGV0IGtlZXBhbGl2ZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgLy8gVGhlIHJlZ2lzdHJ5IGVudHJ5IGZvciBUSElTIHN0cmVhbS4gSXRzIG1ldGhvZHMgYXJlIGZpbGxlZCBpbiBieSBgc3RhcnRgLFxuICAvLyB3aGljaCBpcyB3aGVyZSB0aGUgY29udHJvbGxlciBleGlzdHM7IHRoZSBvYmplY3QgaWRlbnRpdHkgaXMgc3RhYmxlIGZyb21cbiAgLy8gaGVyZSBzbyBgdGVhcmRvd25gIGNhbiByZW1vdmUgZXhhY3RseSB0aGlzIGVudHJ5LlxuICBjb25zdCBjbGllbnQ6IFNzZUNsaWVudCA9IHsgY2xvc2U6ICgpID0+IHt9LCBzZW5kOiAoKSA9PiB7fSB9O1xuXG4gIGNvbnN0IHRlYXJkb3duID0gKCkgPT4ge1xuICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICBjbG9zZWQgPSB0cnVlO1xuICAgIGlmIChrZWVwYWxpdmUgIT09IG51bGwpIGNsZWFySW50ZXJ2YWwoa2VlcGFsaXZlKTtcbiAgICB1bnN1YnNjcmliZT8uKCk7XG4gICAgY2xpZW50cz8uZGVsZXRlKGNsaWVudCk7XG4gICAgb25DbG9zZT8uKCk7XG4gIH07XG5cbiAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICBzdGFydChjb250cm9sbGVyKSB7XG4gICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICBjb25zdCBzYWZlRW5xdWV1ZSA9IChjaHVuazogc3RyaW5nKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jb2Rlci5lbmNvZGUoY2h1bmspKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5jbG9zZSA9ICgpID0+IHtcbiAgICAgICAgdGVhcmRvd24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb250cm9sbGVyLmNsb3NlKCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIGFscmVhZHkgY2xvc2VkIGJ5IHRoZSBydW50aW1lICovXG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICAvLyDim5QgYHNlbmRgIEdPRVMgVEhST1VHSCBgc2FmZUVucXVldWVgLCBzbyBhbiBvdXQtb2YtYmFuZCBmcmFtZSBvYmV5cyB0aGVcbiAgICAgIC8vIHNhbWUgY2xvc2VkLWNoZWNrIGFuZCB0aGUgc2FtZSB0ZWFyZG93bi1vbi10aHJvdyBhcyBhIGxvZ2dlZCBvbmUuIEFcbiAgICAgIC8vIGRhZW1vbiBtdXN0IG5vdCBiZSBhYmxlIHRvIHdyaXRlIHRvIGEgc3RyZWFtIHRoaXMgbW9kdWxlIGhhcyB0b3JuIGRvd24uXG4gICAgICBjbGllbnQuc2VuZCA9IHNhZmVFbnF1ZXVlO1xuXG4gICAgICAvLyDim5QgQU4gT1BFTklORyBDT01NRU5ULCBCRUZPUkUgQU5ZVEhJTkcgRUxTRS4gSXQgZmx1c2hlcyB0aGUgcmVzcG9uc2VcbiAgICAgIC8vIGhlYWRlcnMgaW1tZWRpYXRlbHk6IHNvbWUgSFRUUCBjbGllbnRzIOKAlCBCdW4ncyBvd24gYGZldGNoKClgIGluY2x1ZGVkIOKAlFxuICAgICAgLy8gYnVmZmVyIHVudGlsIHRoZSBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYSBnZW51aW5lbHkgcXVpZXQgU1NFXG4gICAgICAvLyBzdHJlYW0gd291bGQgb3RoZXJ3aXNlIGxlYXZlIHRoZSBjYWxsZXIncyBgZmV0Y2goKWAgdW5yZXNvbHZlZC4gRXZlcnlcbiAgICAgIC8vIGhvdXNlIHRhaWwgY2xpZW50IHJlYWRzIGA6YCBsaW5lcyBhcyBjb21tZW50cyBhbmQgZHJvcHMgdGhlbS5cbiAgICAgIHNhZmVFbnF1ZXVlKFwiOiBjb25uZWN0ZWRcXG5cXG5cIik7XG5cbiAgICAgIC8vIOKblCBCRUZPUkUgVEhFIFJFUExBWSwgQU5EIFRIRSBPUkRFUiBJUyBUSEUgV0hPTEUgUE9JTlQg4oCUIHNlZVxuICAgICAgLy8gYG9wZW5GcmFtZXNgIGluIHRoZSBvcHRpb25zIGFib3ZlLiBBIGdyb3VuZGluZyBmcmFtZSB3cml0dGVuIGhlcmUgaXNcbiAgICAgIC8vIHRoZSBzdHJlYW0ncyBmaXJzdCBkYXRhIGxpbmU7IHdyaXR0ZW4gZnJvbSBgb25PcGVuYCBpdCBhcnJpdmVzIGFmdGVyXG4gICAgICAvLyB0aGUgcmVwbGF5ZWQgYmFja2xvZywgd2hpY2ggaXMgYSBkaWZmZXJlbnQgY29udHJhY3Qgd2VhcmluZyB0aGUgc2FtZVxuICAgICAgLy8gdHlwZXMuXG4gICAgICBpZiAob3BlbkZyYW1lcykgZm9yIChjb25zdCBjaHVuayBvZiBvcGVuRnJhbWVzKCkpIHNhZmVFbnF1ZXVlKGNodW5rKTtcblxuICAgICAgdW5zdWJzY3JpYmUgPSBsb2cuc3Vic2NyaWJlKHNpbmNlLCAoZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZpbHRlciAmJiAhZmlsdGVyKGZyYW1lKSkgcmV0dXJuO1xuICAgICAgICBzYWZlRW5xdWV1ZShgZGF0YTogJHtKU09OLnN0cmluZ2lmeShmcmFtZSl9XFxuXFxuYCk7XG4gICAgICB9KTtcblxuICAgICAga2VlcGFsaXZlID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2FmZUVucXVldWUoXCI6IGhiXFxuXFxuXCIpLCBoZWFydGJlYXRNcyk7XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCB0ZWFyZG93biwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgY2xpZW50cz8uYWRkKGNsaWVudCk7XG4gICAgICBvbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gbmV3IFJlc3BvbnNlKHN0cmVhbSwge1xuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgIFwiQ2FjaGUtQ29udHJvbFwiOiBcIm5vLWNhY2hlXCIsXG4gICAgICBDb25uZWN0aW9uOiBcImtlZXAtYWxpdmVcIixcbiAgICB9LFxuICB9KTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8qKlxuICogVGhlIE5BVElWRSBmaWxlIHBpY2tlciDigJQgdGhlIGFmZm9yZGFuY2UgYSB3ZWIgcGFnZSBjYW5ub3QgaGF2ZS5cbiAqXG4gKiBBIGJyb3dzZXIncyBvd24gYDxpbnB1dCB0eXBlPVwiZmlsZVwiPmAgYW5kIGBzaG93T3BlbkZpbGVQaWNrZXIoKWAgYm90aCBoYW5kXG4gKiBiYWNrIGZpbGUgQ09OVEVOVCBhbmQgYSBuYW1lLCBuZXZlciBhIHBhdGggKGFuZCBCcmF2ZSwgQ29sZSdzIGJyb3dzZXIsXG4gKiBkaXNhYmxlcyB0aGUgRmlsZSBTeXN0ZW0gQWNjZXNzIEFQSSBvdXRyaWdodCkuIEEgY29weSBpcyBhbGwgYSBwYWdlIGNhbiBkb1xuICogd2l0aCB0aGF0LCB3aGljaCBpcyBleGFjdGx5IHdoYXQgYSBkcm9wIGFscmVhZHkgZG9lcyAoRTIzKS4gQnV0IHNjcmlwdG9yaXVtJ3NcbiAqIGRhZW1vbiBpcyBhIExPQ0FMIFBST0NFU1M6IGl0IGNhbiBhc2sgdGhlIE9TIGZvciBpdHMgb3duIG9wZW4gZGlhbG9nIGFuZCBnZXRcbiAqIGJhY2sgYSByZWFsIGZpbGVzeXN0ZW0gcGF0aCDigJQgc28gXCJDaG9vc2XigKZcIiBsaW5rcyB0aGUgcmVhbCBmaWxlIChFMSkgaW5zdGVhZFxuICogb2YgY29weWluZyBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGhlcmUgaXMgcHVyZTogd2hpY2ggYXJndiB0byBydW4sIGFuZCBob3cgdG8gcmVhZCB3aGF0IGl0IHByaW50ZWQuXG4gKiBUaGUgc3Bhd25pbmcgKGFuZCB0aGUgb25lLWF0LWEtdGltZSBydWxlKSBpcyB0aGUgZGFlbW9uJ3MuXG4gKi9cblxuZXhwb3J0IHR5cGUgUGlja0tpbmQgPSBcImZpbGVcIiB8IFwiZm9sZGVyXCI7XG5cbi8qKiBBbiBBcHBsZVNjcmlwdCB0aGF0IHB1dHMgb25lIFBPU0lYIHBhdGggcGVyIGxpbmUgb24gc3Rkb3V0LiAqL1xuZnVuY3Rpb24gYXBwbGVTY3JpcHQoa2luZDogUGlja0tpbmQsIHByb21wdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcXVvdGVkID0gcHJvbXB0LnJlcGxhY2UoL1tcIlxcXFxdL2csIFwiXCIpO1xuICBjb25zdCBjaG9vc2UgPVxuICAgIGtpbmQgPT09IFwiZmlsZVwiXG4gICAgICA/IGBjaG9vc2UgZmlsZSB3aXRoIHByb21wdCBcIiR7cXVvdGVkfVwiIHdpdGggbXVsdGlwbGUgc2VsZWN0aW9ucyBhbGxvd2VkYFxuICAgICAgOiBge2Nob29zZSBmb2xkZXIgd2l0aCBwcm9tcHQgXCIke3F1b3RlZH1cIn1gO1xuICByZXR1cm4gW1xuICAgIGBzZXQgY2hvc2VuIHRvICR7Y2hvb3NlfWAsXG4gICAgJ3NldCBvdXQgdG8gXCJcIicsXG4gICAgXCJyZXBlYXQgd2l0aCBmIGluIGNob3NlblwiLFxuICAgIFwic2V0IG91dCB0byBvdXQgJiBQT1NJWCBwYXRoIG9mIGYgJiBsaW5lZmVlZFwiLFxuICAgIFwiZW5kIHJlcGVhdFwiLFxuICAgIFwicmV0dXJuIG91dFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIGNvbW1hbmQgdGhhdCBvcGVucyB0aGUgT1MncyBwaWNrZXIsIG9yIG51bGwgd2hlcmUgdGhlcmUgaXMgbm9uZSDigJQgdGhlXG4gKiBjYWxsZXIgdGhlbiBzYXlzIHNvIHJhdGhlciB0aGFuIGhhbmdpbmcgb24gYSBkaWFsb2cgbm9ib2R5IHdpbGwgc2VlLlxuICogYHplbml0eUF0YCBpcyB3aGVyZSBhIExpbnV4IHplbml0eSB3YXMgZm91bmQgKHRoZSBjYWxsZXIgbG9va3MgaXQgdXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja2VyQ29tbWFuZChcbiAgcGxhdGZvcm06IHN0cmluZyxcbiAga2luZDogUGlja0tpbmQsXG4gIHByb21wdDogc3RyaW5nLFxuICB6ZW5pdHlBdD86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAocGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHJldHVybiBbXCJvc2FzY3JpcHRcIiwgXCItZVwiLCBhcHBsZVNjcmlwdChraW5kLCBwcm9tcHQpXTtcbiAgaWYgKHBsYXRmb3JtID09PSBcIndpbjMyXCIpIHJldHVybiBudWxsOyAvLyBQb3dlclNoZWxsJ3MgZGlhbG9nIG5lZWRzIGEgU1RBIGhvc3Q7IG5vdCB3cml0dGVuIHVudGlsIGFza2VkIGZvclxuICBpZiAoemVuaXR5QXQpXG4gICAgcmV0dXJuIFtcbiAgICAgIHplbml0eUF0LFxuICAgICAgXCItLWZpbGUtc2VsZWN0aW9uXCIsXG4gICAgICAuLi4oa2luZCA9PT0gXCJmb2xkZXJcIiA/IFtcIi0tZGlyZWN0b3J5XCJdIDogW1wiLS1tdWx0aXBsZVwiXSksXG4gICAgICBcIi0tc2VwYXJhdG9yPVxcblwiLFxuICAgICAgYC0tdGl0bGU9JHtwcm9tcHR9YCxcbiAgICBdO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBwYXRocyBhIHBpY2tlciBwcmludGVkOiBvbmUgcGVyIGxpbmUsIGJsYW5rcyBkcm9wcGVkLCBvcmRlciBrZXB0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUGlja2VyT3V0cHV0KHN0ZG91dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gc3Rkb3V0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobCkgPT4gbC50cmltKCkpXG4gICAgLmZpbHRlcigobCkgPT4gbC5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAubWFwKChsKSA9PiAobC5sZW5ndGggPiAxICYmIGwuZW5kc1dpdGgoXCIvXCIpID8gbC5zbGljZSgwLCAtMSkgOiBsKSk7XG59XG5cbi8qKiBBIGNhbmNlbGxlZCBkaWFsb2cgaXMgbm90IGEgZmFpbHVyZSDigJQgb3Nhc2NyaXB0IGV4aXRzIDEsIHplbml0eSBleGl0cyAxLCBhbmQgbm90aGluZyB3YXMgY2hvc2VuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhc0NhbmNlbGxlZChleGl0Q29kZTogbnVtYmVyLCBzdGRvdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXhpdENvZGUgIT09IDAgJiYgcGFyc2VQaWNrZXJPdXRwdXQoc3Rkb3V0KS5sZW5ndGggPT09IDA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIHNlc3Npb24g4oCUIHRoZSBkYWVtb24ncyBzdGF0ZSwgYW5kIHRoZSBvbmx5IGNvZGUgdGhhdCB3cml0ZXMgYSBmaWxlLlxuICpcbiAqIEU4J3Mgc2hhcGUsIHRoZSBob3VzZSdzIFwibWF0ZXJpYWxpemVkIHBhdGhcIiBwYXR0ZXJuOiB0aGUgZGFlbW9uIG93bnMgdGhlXG4gKiBzZXNzaW9uIChjb250ZXh0LCBkb2NzLCB2ZXJzaW9ucywgd2hpY2ggaXMgYWN0aXZlLCB0aGUgY2hhdCkgYW5kIHBlcnNpc3RzIGl0XG4gKiBhcyBgbWFuaWZlc3QuanNvbmA7IGV2ZXJ5IHZlcnNpb24ncyBURVhUIGlzIGEgZmlsZSBpbiB0aGUgc2Vzc2lvbiBmb2xkZXIsIHNvXG4gKiB0aGUgYWdlbnQgZWRpdHMgdmVyc2lvbnMgd2l0aCBpdHMgb3duIGZpbGUgdG9vbHMuXG4gKlxuICogICAgICRTQ1JJUFRPUklVTV9IT01FL3Nlc3Npb25zLzxzZXNzaW9uSWQ+L1xuICogICAgICAgbWFuaWZlc3QuanNvbiAgICAgICAgICAgICAgd3JpdHRlbiBhdG9taWNhbGx5LCBvbiBldmVyeSBjaGFuZ2VcbiAqICAgICAgIGRvY3MvPHNsdWc+L3YxLm1kLCB2Mi5tZCAgIG9uZSBmaWxlIHBlciB2ZXJzaW9uXG4gKlxuICogVGhlIHRocmVlIHdyaXRlIHJ1bGVzLCBlYWNoIGEgZGVjaXNpb24gcmF0aGVyIHRoYW4gYSBoYWJpdDpcbiAqXG4gKiAtICoqVGhlIG9yaWdpbmFsIGlzIHdyaXR0ZW4gT05MWSBieSBgc2F2ZWAqKiAoRTcpLiBPcGVuaW5nIGNvcGllcyBpdCB0byB2MTtcbiAqICAgbm90aGluZyBlbHNlIHRvdWNoZXMgaXQuXG4gKiAtICoqRXZlcnkgd3JpdGUgdGhpcyBtb2R1bGUgbWFrZXMgaXMgcmVtZW1iZXJlZCBieSBjb250ZW50IGhhc2gqKiAodGhlXG4gKiAgIGBvd25lZGAgbWFwKSBzbyB0aGUgd2F0Y2hlciBjYW4gdGVsbCB0aGUgZGFlbW9uJ3Mgb3duIHdyaXRlcyBmcm9tIGFueW9uZVxuICogICBlbHNlJ3MgKGludmVzdGlnYXRpb24gwqc1KS4gQSB3cml0ZSB0byB0aGUgQUNUSVZFIHZlcnNpb24gdGhhdCBpcyBub3Qgb3Vyc1xuICogICBpcyBhbiBFMiB2aW9sYXRpb24gdGhlIGRhZW1vbiBhbm5vdW5jZXMuXG4gKiAtICoqVGhlIGFnZW50IG5ldmVyIHdyaXRlcyB0aGUgYWN0aXZlIHZlcnNpb24qKiAoRTIpIOKAlCBlbmZvcmNlZCBzb2NpYWxseSBieVxuICogICBTS0lMTC5tZCBhbmQgZGV0ZWN0ZWQgaGVyZSwgbm90IHByZXZlbnRlZDogdGhlIGZpbGUgaXMgdGhlIGFnZW50J3MgbWVkaXVtLlxuICpcbiAqIE5vdGhpbmcgaGVyZSBrbm93cyBhYm91dCBzb2NrZXRzLCBIVFRQIG9yIHRoZSBldmVudCBsb2cuIFRoZSBkYWVtb24gY2FsbHMgYVxuICogbWV0aG9kLCBnZXRzIGEgcmVzdWx0LCBhbmQgZGVjaWRlcyB3aGF0IHRvIGJyb2FkY2FzdDsgdGhhdCBzcGxpdCBpcyB3aGF0XG4gKiBsZXRzIHRoZSB1bml0IGNlbGxzIGRyaXZlIHRoZSB3aG9sZSBtb2RlbCB3aXRoIGEgdGVtcCBob21lLlxuICovXG5cbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICByZW5hbWVTeW5jLFxuICBzdGF0U3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB3cml0ZUZpbGVBdG9taWMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZGlzY292ZXJ5LnRzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENoYXRNZXNzYWdlLFxuICBDaGF0V2hvLFxuICBDb250ZXh0RW50cnksXG4gIERvY1ZpZXcsXG4gIFB1YmxpY1N0YXRlLFxuICBTZWxlY3Rpb24sXG4gIFZlcnNpb24sXG4gIFZlcnNpb25BdXRob3IsXG59IGZyb20gXCIuL3Byb3RvY29sXCI7XG5pbXBvcnQge1xuICBET0NfRVhURU5TSU9OUyxcbiAgZW50cnlGb3JQYXRoLFxuICBmaW5kTm9kZSxcbiAgaXNEb2NOYW1lLFxuICBsb2NhdGUsXG4gIE1JUlJPUl9OT0RFX0NBUCxcbiAgc2NhblRyZWUsXG4gIHRvUG9zaXgsXG59IGZyb20gXCIuL3RyZWVcIjtcblxuZXhwb3J0IGNvbnN0IE1BTklGRVNUX0ZPUk1BVCA9IDE7XG5cbnR5cGUgRG9jUmVjb3JkID0ge1xuICBzbHVnOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgb3JpZ2luYWw6IHN0cmluZztcbiAgZW50cnlJZDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsOiBzdHJpbmcgfCBudWxsO1xuICBleHQ6IHN0cmluZztcbiAgdmVyc2lvbnM6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+W107XG4gIGFjdGl2ZTogbnVtYmVyO1xuICAvKiogSGFzaCBvZiB0aGUgb3JpZ2luYWwgYXMgd2UgbGFzdCByZWFkIG9yIHdyb3RlIGl0IOKAlCBhdCBvcGVuLCBzYXZlLCByZXZlcnRcbiAgICogIGFuZCByZWxvYWQg4oCUIHNvIGEgcmVzdG9yZSBjYW4gdGVsbCB0aGF0IGl0IGNoYW5nZWQgd2hpbGUgbm8gZGFlbW9uIHdhc1xuICAgKiAgd2F0Y2hpbmcgKHZlcmlmeS1wYXNzIGZpeCAyKS4gKi9cbiAgb3JpZ2luYWxIYXNoOiBzdHJpbmc7XG4gIC8qKiBTZXQgb25seSBieSBgb3BlblBhdGhgLCB3aGljaCBhZG1pdHMgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogIGVudHJ5LiBgc2F2ZWAgd3JpdGVzIG5vIG9yaWdpbmFsIHRoYXQgbGFja3MgaXQgKHZlcmlmeS1wYXNzIGZpeCAxYykuICovXG4gIGFkbWl0dGVkPzogYm9vbGVhbjtcbiAgb3V0c2lkZUNoYW5nZWQ6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgZm9ybWF0OiBudW1iZXI7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgY29udGV4dDogQ29udGV4dEVudHJ5W107XG4gIGRvY3M6IERvY1JlY29yZFtdO1xuICBvcGVuRG9jOiBzdHJpbmcgfCBudWxsO1xuICBjaGF0OiBDaGF0TWVzc2FnZVtdO1xuICAvKiogRTIzJ3Mgd29ya3NwYWNlLiBBYnNlbnQgaW4gYSBtYW5pZmVzdCB3cml0dGVuIGJlZm9yZSBpdCBleGlzdGVkOiB0aGUgdXNlcidzIGhvbWUuICovXG4gIHdvcmtzcGFjZT86IHN0cmluZztcbn07XG5cbi8qKiBBIHJlZnVzYWwgdGhlIGRhZW1vbiB0dXJucyBpbnRvIGFuIEhUVFAgc3RhdHVzIOKAlCBgY2hvaWNlc2Agd2hlbiB0aGUgc2V0IGlzIGluIGhhbmQgKEExKS4gKi9cbmV4cG9ydCBjbGFzcyBTZXNzaW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBzdGF0dXM6IDQwMCB8IDQwNCB8IDQwOSxcbiAgICByZWFkb25seSBjaG9pY2VzPzogc3RyaW5nW10sXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBjb250ZW50SGFzaCA9ICh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgPT4gQnVuLmhhc2godGV4dCkudG9TdHJpbmcoMTYpO1xuXG5jb25zdCByYW5kSGV4ID0gKG46IG51bWJlcikgPT5cbiAgQXJyYXkuZnJvbShjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KG4pKSlcbiAgICAubWFwKChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXG4gICAgLmpvaW4oXCJcIik7XG5cbmV4cG9ydCBjb25zdCBuZXdTZXNzaW9uSWQgPSAoKTogc3RyaW5nID0+IHJhbmRIZXgoNCk7XG5cbi8qKiBBIHBhdGgncyByZWFscGF0aCwgb3IgdGhlIHBhdGggaXRzZWxmIHdoZW4gaXQgY2Fubm90IGJlIHJlc29sdmVkIChnb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFsT3IocDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcDtcbiAgfVxufVxuXG4vKiogV2hhdCBhIHdhdGNoZXIgZXZlbnQgdHVybmVkIG91dCB0byBiZS4gYG51bGxgID0gbm90aGluZyAob3Vycywgb3Igbm8gY2hhbmdlKS4gKi9cbmV4cG9ydCB0eXBlIEZpbGVFdmVudCA9XG4gIHwgeyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiOyBkb2M6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyOyB0ZXh0OiBzdHJpbmc7IGFjdGl2ZTogZmFsc2UgfVxuICB8IHtcbiAgICAgIGtpbmQ6IFwiYWN0aXZlLm91dHNpZGVcIjtcbiAgICAgIGRvYzogc3RyaW5nO1xuICAgICAgdmVyc2lvbjogbnVtYmVyO1xuICAgICAgcGF0aDogc3RyaW5nO1xuICAgICAgLyoqIFRoZSBuZXcgYWdlbnQgdmVyc2lvbiB0aGUgb3V0c2lkZSB0ZXh0IHdhcyBwcmVzZXJ2ZWQgYXMuICovXG4gICAgICBwcmVzZXJ2ZWRBczogbnVtYmVyO1xuICAgICAgcHJlc2VydmVkUGF0aDogc3RyaW5nO1xuICAgIH1cbiAgfCB7IGtpbmQ6IFwidmVyc2lvbi5jcmVhdGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCI7IGRvYzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZzsgb3JpZ2luYWw6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm9yaWdpbmFsLmNvbmZsaWN0XCI7IGRvYzogc3RyaW5nOyBvcmlnaW5hbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidHJlZVwiOyBlbnRyeUlkOiBzdHJpbmcgfTtcblxuZXhwb3J0IGNsYXNzIFNlc3Npb24ge1xuICByZWFkb25seSBkaXI6IHN0cmluZztcbiAgcHJpdmF0ZSBtOiBNYW5pZmVzdDtcbiAgLyoqIHBhdGgg4oaSIGhhc2ggb2YgdGhlIGRhZW1vbidzIGxhc3Qgd3JpdGUgdG8gaXQuICovXG4gIHByaXZhdGUgb3duZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogc2x1ZyDihpIgaGFzaCBvZiB0aGUgYWN0aXZlIHZlcnNpb24ncyBjdXJyZW50IHRleHQuICovXG4gIHByaXZhdGUgYWN0aXZlSGFzaCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIC8qKiBzbHVnIOKGkiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGFzIHRoZSBkYWVtb24gbGFzdCB3cm90ZSAob3IgYWRvcHRlZClcbiAgICogIGl0IOKAlCB3aGF0IGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGlzIHJldmVydGVkIHRvLiAqL1xuICBwcml2YXRlIGxhc3RBY3RpdmVUZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIFdoYXQgYSByZXN0b3JlIGZvdW5kIGNoYW5nZWQgb24gZGlzayB3aGlsZSBubyBkYWVtb24gd2FzIHdhdGNoaW5nLiAqL1xuICByZXN0b3JlRmluZGluZ3M6IHsgZG9jOiBzdHJpbmc7IG9yaWdpbmFsOiBzdHJpbmc7IG1pc3Npbmc6IGJvb2xlYW4gfVtdID0gW107XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBob21lOiBzdHJpbmcsXG4gICAgbWFuaWZlc3Q6IE1hbmlmZXN0LFxuICApIHtcbiAgICB0aGlzLm0gPSBtYW5pZmVzdDtcbiAgICB0aGlzLmRpciA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBtYW5pZmVzdC5zZXNzaW9uSWQpO1xuICB9XG5cbiAgc3RhdGljIGNyZWF0ZShob21lOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nID0gbmV3U2Vzc2lvbklkKCksIHdvcmtzcGFjZT86IHN0cmluZyk6IFNlc3Npb24ge1xuICAgIGNvbnN0IHMgPSBuZXcgU2Vzc2lvbihob21lLCB7XG4gICAgICBmb3JtYXQ6IE1BTklGRVNUX0ZPUk1BVCxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIGNvbnRleHQ6IFtdLFxuICAgICAgZG9jczogW10sXG4gICAgICBvcGVuRG9jOiBudWxsLFxuICAgICAgY2hhdDogW10sXG4gICAgICAuLi4od29ya3NwYWNlID8geyB3b3Jrc3BhY2U6IHJlc29sdmUod29ya3NwYWNlKSB9IDoge30pLFxuICAgIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHMucGVyc2lzdCgpO1xuICAgIHJldHVybiBzO1xuICB9XG5cbiAgLyoqIFJlbG9hZCBhIHNlc3Npb24gZnJvbSBpdHMgbWFuaWZlc3QgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCkuICovXG4gIHN0YXRpYyByZXN0b3JlKGhvbWU6IHN0cmluZywgc2Vzc2lvbklkOiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIHNlc3Npb25JZCwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc2F2ZWQgc2Vzc2lvbiAke3Nlc3Npb25JZH1gLCA0MDQpO1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIE1hbmlmZXN0O1xuICAgIGlmIChtLmZvcm1hdCAhPT0gTUFOSUZFU1RfRk9STUFUKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgc2Vzc2lvbiAke3Nlc3Npb25JZH0gaGFzIG1hbmlmZXN0IGZvcm1hdCAke20uZm9ybWF0fWAsIDQwOSk7XG4gICAgY29uc3QgcyA9IG5ldyBTZXNzaW9uKGhvbWUsIG0pO1xuICAgIG1rZGlyU3luYyhqb2luKHMuZGlyLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE1pcnJvcnMgYXJlIHJlLXJlYWQsIG5vdCB0cnVzdGVkOiB0aGUgZm9sZGVyIG1heSBoYXZlIGNoYW5nZWQgd2hpbGUgbm9cbiAgICAvLyBkYWVtb24gd2FzIHdhdGNoaW5nIGl0LlxuICAgIGZvciAoY29uc3QgZSBvZiBzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSBzLnJlc2NhbihlLmlkKTtcbiAgICBmb3IgKGNvbnN0IGQgb2Ygcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHAgPSBzLnZlcnNpb25QYXRoKGQsIGQuYWN0aXZlKTtcbiAgICAgIGNvbnN0IHRleHQgPSBleGlzdHNTeW5jKHApID8gcmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSA6IFwiXCI7XG4gICAgICBzLmFkb3B0QWN0aXZlKGQsIHRleHQpO1xuICAgICAgLy8g4puUIFZFUklGWS1QQVNTIEZJWCAyOiBhbiBvcmlnaW5hbCBjaGFuZ2VkIHdoaWxlIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWRcbiAgICAgIC8vIHdhcyBpbnZpc2libGUgaGVyZSwgc28gdGhlIG5leHQgU2F2ZSBvdmVyd3JvdGUgaXQgdW5hbm5vdW5jZWQuIFRoZVxuICAgICAgLy8gbWFuaWZlc3QgaG9sZHMgdGhlIG9yaWdpbmFsJ3MgaGFzaCBhcyBvZiB0aGUgbGFzdCBvcGVuL3NhdmUvcmV2ZXJ0L1xuICAgICAgLy8gcmVsb2FkOyBhIGRpZmZlcmVudCBoYXNoIG5vdyBpcyBhbiBvdXRzaWRlIGNoYW5nZSwgbWFya2VkIGV4YWN0bHkgYXMgYVxuICAgICAgLy8gbGl2ZSBvbmUgd2l0aCBhIGRpcnR5IGJ1ZmZlciBpcyDigJQgYXNrZWQsIG5ldmVyIG1lcmdlZCBvciByZWxvYWRlZC5cbiAgICAgIGxldCBub3c6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbm93ID0gY29udGVudEhhc2gocmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbm93ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChub3cgPT09IG51bGwgfHwgbm93ICE9PSBkLm9yaWdpbmFsSGFzaCkge1xuICAgICAgICBkLm91dHNpZGVDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgcy5yZXN0b3JlRmluZGluZ3MucHVzaCh7IGRvYzogZC5zbHVnLCBvcmlnaW5hbDogZC5vcmlnaW5hbCwgbWlzc2luZzogbm93ID09PSBudWxsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocy5yZXN0b3JlRmluZGluZ3MubGVuZ3RoID4gMCkgcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHM7XG4gIH1cblxuICBzdGF0aWMgbGlzdFNhdmVkKGhvbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkuZmlsdGVyKChpZCkgPT5cbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSksXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfVxuXG4gIGdldCBpZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLm0uc2Vzc2lvbklkO1xuICB9XG5cbiAgZ2V0IGRvY3NEaXIoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRpciwgXCJkb2NzXCIpO1xuICB9XG5cbiAgZ2V0IG9wZW5Eb2NTbHVnKCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLm0ub3BlbkRvYztcbiAgfVxuXG4gIGdldCBjb250ZXh0KCk6IHJlYWRvbmx5IENvbnRleHRFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5tLmNvbnRleHQ7XG4gIH1cblxuICAvKipcbiAgICogRXZlcnkgZGlyZWN0b3J5IHRoZSB3YXRjaGVyIG11c3Qgc2VlOiB0aGUgc2Vzc2lvbidzIGRvY3MsIGVhY2ggZW50cnkgcm9vdCxcbiAgICogYW5kIHRoZSBSRUFMIGRpcmVjdG9yeSBvZiBldmVyeSBvcGVuZWQgb3JpZ2luYWwuXG4gICAqXG4gICAqIOKblCBWRVJJRlktUEFTUyBGSVggMzogZWFjaCByb290IGlzIHdhdGNoZWQgYXQgaXRzIFJFQUxQQVRIIChgd2F0Y2hgKSwgYW5kXG4gICAqIGFuIGV2ZW50IGlzIHJlcG9ydGVkIHVuZGVyIHRoZSBwYXRoIGZvcm0gdGhlIHNlc3Npb24gc3RvcmVzIChgcGF0aGApLiBBXG4gICAqIHdhdGNoIG9uIGEgc3ltbGlua2VkIGRpcmVjdG9yeSDigJQgYSBzeW1saW5rZWQgaG9tZSwgYSBzeW1saW5rZWQgZm9sZGVyXG4gICAqIGVudHJ5IOKAlCBvciBvbiB0aGUgbGluaydzIG93biBkaXJlY3RvcnkgZm9yIGEgc3ltbGlua2VkIG9yaWdpbmFsIHNhd1xuICAgKiBub3RoaW5nIHdoZW4gdGhlIFRBUkdFVCBjaGFuZ2VkIChGU0V2ZW50cyByZXBvcnRzIHJlYWwgcGF0aHMpLiBBIHN5bWxpbmtlZFxuICAgKiBvcmlnaW5hbCBpcyBtYXRjaGVkIGJhY2sgdG8gaXRzIGRvYyBieSByZWFscGF0aCBpbiBgb25GaWxlRXZlbnRgLlxuICAgKi9cbiAgd2F0Y2hSb290cygpOiB7IHBhdGg6IHN0cmluZzsgd2F0Y2g6IHN0cmluZzsgcmVjdXJzaXZlOiBib29sZWFuOyBlbnRyeUlkPzogc3RyaW5nIH1bXSB7XG4gICAgY29uc3Qgcm9vdHM6IHsgcGF0aDogc3RyaW5nOyB3YXRjaDogc3RyaW5nOyByZWN1cnNpdmU6IGJvb2xlYW47IGVudHJ5SWQ/OiBzdHJpbmcgfVtdID0gW1xuICAgICAgeyBwYXRoOiB0aGlzLmRvY3NEaXIsIHdhdGNoOiByZWFsT3IodGhpcy5kb2NzRGlyKSwgcmVjdXJzaXZlOiB0cnVlIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpXG4gICAgICByb290cy5wdXNoKHtcbiAgICAgICAgcGF0aDogZS5yb290LFxuICAgICAgICB3YXRjaDogcmVhbE9yKGUucm9vdCksXG4gICAgICAgIHJlY3Vyc2l2ZTogZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIsXG4gICAgICAgIGVudHJ5SWQ6IGUuaWQsXG4gICAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBkaXJuYW1lKHJlYWxPcihkLm9yaWdpbmFsKSk7XG4gICAgICBpZiAoXG4gICAgICAgICFyb290cy5zb21lKChyKSA9PiByLndhdGNoID09PSByZWFsRGlyICYmIHIucmVjdXJzaXZlID09PSBmYWxzZSkgJiZcbiAgICAgICAgIXJvb3RzLnNvbWUoXG4gICAgICAgICAgKHIpID0+IHIucmVjdXJzaXZlICYmIChyZWFsRGlyID09PSByLndhdGNoIHx8IHJlYWxEaXIuc3RhcnRzV2l0aChyLndhdGNoICsgc2VwKSksXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgICAgcm9vdHMucHVzaCh7IHBhdGg6IHJlYWxEaXIsIHdhdGNoOiByZWFsRGlyLCByZWN1cnNpdmU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gcm9vdHM7XG4gIH1cblxuICAvLyDilIDilIAgcGVyc2lzdGVuY2Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcGVyc2lzdCgpOiB2b2lkIHtcbiAgICBta2RpclN5bmModGhpcy5kaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZUF0b21pYyhqb2luKHRoaXMuZGlyLCBcIm1hbmlmZXN0Lmpzb25cIiksIGAke0pTT04uc3RyaW5naWZ5KHRoaXMubSwgbnVsbCwgMil9XFxuYCk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlT3duZWQocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBta2RpclN5bmMoZGlybmFtZShwYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gUmVtZW1iZXIgQkVGT1JFIHdyaXRpbmc6IHRoZSB3YXRjaGVyJ3MgZXZlbnQgY2FuIGFycml2ZSBiZWZvcmUgdGhpc1xuICAgIC8vIGZ1bmN0aW9uIHJldHVybnMsIGFuZCBpdCBtdXN0IGZpbmQgdGhlIGhhc2ggYWxyZWFkeSB0aGVyZS5cbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRvcHRBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwID0gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSk7XG4gICAgdGhpcy5vd25lZC5zZXQocCwgY29udGVudEhhc2godGV4dCkpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIHByaXZhdGUgd3JpdGVBY3RpdmUoZDogRG9jUmVjb3JkLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSksIHRleHQpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgfVxuXG4gIC8qKiBLZWVwIGFuIG91dHNpZGUgd3JpdGUgdG8gdGhlIGFjdGl2ZSB2ZXJzaW9uIGFzIGEgTkVXIGFnZW50IHZlcnNpb24uICovXG4gIHByaXZhdGUgcHJlc2VydmVPdXRzaWRlKGQ6IERvY1JlY29yZCwgdGV4dDogc3RyaW5nKTogVmVyc2lvbiB7XG4gICAgY29uc3QgbiA9IE1hdGgubWF4KC4uLmQudmVyc2lvbnMubWFwKCh2KSA9PiB2Lm4pKSArIDE7XG4gICAgY29uc3QgcmVjOiBPbWl0PFZlcnNpb24sIFwicGF0aFwiPiA9IHtcbiAgICAgIG4sXG4gICAgICBhdXRob3I6IFwiYWdlbnRcIixcbiAgICAgIGZyb206IGQuYWN0aXZlLFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgbGFiZWw6IGBvdXRzaWRlIHdyaXRlIHRvIHYke2QuYWN0aXZlfWAsXG4gICAgfTtcbiAgICBkLnZlcnNpb25zLnB1c2gocmVjKTtcbiAgICB0aGlzLndyaXRlT3duZWQodGhpcy52ZXJzaW9uUGF0aChkLCBuKSwgdGV4dCk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH07XG4gIH1cblxuICAvKiogVHJ1ZSBpZmYgYHRleHRgIGF0IGBwYXRoYCBpcyBleGFjdGx5IHdoYXQgdGhlIGRhZW1vbiBsYXN0IHdyb3RlIHRoZXJlLiAqL1xuICBpc093bldyaXRlKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMub3duZWQuZ2V0KHBhdGgpID09PSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBjb250ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZENvbnRleHQocmF3UGF0aDogc3RyaW5nKTogeyBlbnRyeTogQ29udGV4dEVudHJ5OyBhZGRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHJhd1BhdGgpO1xuICAgIGNvbnN0IHByb2JlID0gZW50cnlGb3JQYXRoKGFicywgYGMtJHtyYW5kSGV4KDMpfWApO1xuICAgIGNvbnN0IHNhbWUgPSB0aGlzLm0uY29udGV4dC5maW5kKFxuICAgICAgKGUpID0+XG4gICAgICAgIGUucm9vdCA9PT0gcHJvYmUucm9vdCAmJlxuICAgICAgICBlLm1lbWJlcnNoaXAgPT09IHByb2JlLm1lbWJlcnNoaXAgJiZcbiAgICAgICAgKHByb2JlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiB8fFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGUubm9kZXMpID09PSBKU09OLnN0cmluZ2lmeShwcm9iZS5ub2RlcykpLFxuICAgICk7XG4gICAgaWYgKHNhbWUpIHJldHVybiB7IGVudHJ5OiBzYW1lLCBhZGRlZDogZmFsc2UgfTtcbiAgICB0aGlzLm0uY29udGV4dC5wdXNoKHByb2JlKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBwcm9iZSwgYWRkZWQ6IHRydWUgfTtcbiAgfVxuXG4gIHJlbW92ZUNvbnRleHQoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGkgPSB0aGlzLm0uY29udGV4dC5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgICBpZiAoaSA8IDApXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgbm8gY29udGV4dCBlbnRyeSAke2lkfWAsXG4gICAgICAgIDQwNCxcbiAgICAgICAgdGhpcy5tLmNvbnRleHQubWFwKChlKSA9PiBlLmlkKSxcbiAgICAgICk7XG4gICAgdGhpcy5tLmNvbnRleHQuc3BsaWNlKGksIDEpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gICAgdGhpcy5jbG9zZU9ycGhhbmVkT3BlbkRvYygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBvcGVuIGRvY3VtZW50IGxlZnQgdGhlIGNvbnRleHQgKGl0cyBlbnRyeSByZW1vdmVkLCBvciB0aGUgZG9jdW1lbnRcbiAgICogaGlkZGVuKTogY2xvc2UgaXQgaW4gdGhlIHZpZXcuIEl0cyB2ZXJzaW9ucyBzdGF5IGluIHRoZSBzZXNzaW9uIOKAlCBub3RoaW5nXG4gICAqIGlzIGRlbGV0ZWQg4oCUIGFuZCBicmluZ2luZyBpdCBiYWNrIGFuZCBvcGVuaW5nIGl0IGFnYWluIGZpbmRzIHRoZW0uXG4gICAqL1xuICBwcml2YXRlIGNsb3NlT3JwaGFuZWRPcGVuRG9jKCk6IHZvaWQge1xuICAgIGNvbnN0IG9wZW4gPSB0aGlzLm0ub3BlbkRvYyA/IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0gdGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIGlmIChvcGVuICYmIG9wZW4uZW50cnlJZCA9PT0gbnVsbCkgdGhpcy5tLm9wZW5Eb2MgPSBudWxsO1xuICB9XG5cbiAgLyoqIFJlLW1pcnJvciBhIGZvbGRlciBlbnRyeS4gUmV0dXJucyB3aGV0aGVyIGl0cyBub2RlcyBjaGFuZ2VkLiAqL1xuICByZXNjYW4oZW50cnlJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmIChlPy5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGUucm9vdCwgTUlSUk9SX05PREVfQ0FQLCBlLmhpZGRlbik7XG4gICAgY29uc3QgY2hhbmdlZCA9XG4gICAgICBKU09OLnN0cmluZ2lmeShub2RlcykgIT09IEpTT04uc3RyaW5naWZ5KGUubm9kZXMpIHx8ICEhdHJ1bmNhdGVkICE9PSAhIWUudHJ1bmNhdGVkO1xuICAgIGUubm9kZXMgPSBub2RlcztcbiAgICBpZiAodHJ1bmNhdGVkKSBlLnRydW5jYXRlZCA9IHRydWU7XG4gICAgZWxzZSBkZWxldGUgZS50cnVuY2F0ZWQ7XG4gICAgaWYgKGNoYW5nZWQpIHRoaXMucmVsaW5rKCk7XG4gICAgcmV0dXJuIGNoYW5nZWQ7XG4gIH1cblxuICBwcml2YXRlIHJlbGluaygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGQgb2YgdGhpcy5tLmRvY3MpIHtcbiAgICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBkLm9yaWdpbmFsKTtcbiAgICAgIGQuZW50cnlJZCA9IGF0Py5lbnRyeUlkID8/IG51bGw7XG4gICAgICBkLnJlbCA9IGF0Py5yZWwgPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgZG9jdW1lbnRzIGFuZCB2ZXJzaW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIHZlcnNpb25QYXRoKGQ6IERvY1JlY29yZCwgbjogbnVtYmVyKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbih0aGlzLmRvY3NEaXIsIGQuc2x1ZywgYHYke259JHtkLmV4dH1gKTtcbiAgfVxuXG4gIHByaXZhdGUgZG9jT3JEaWUoc2x1Zz86IHN0cmluZyk6IERvY1JlY29yZCB7XG4gICAgY29uc3Qgd2FudCA9IHNsdWcgPz8gdGhpcy5tLm9wZW5Eb2MgPz8gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGNob2ljZXMgPSB0aGlzLm0uZG9jcy5tYXAoKGQpID0+IGQuc2x1Zyk7XG4gICAgaWYgKHdhbnQgPT09IHVuZGVmaW5lZClcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXCJubyBkb2N1bWVudCBpcyBvcGVuIOKAlCBuYW1lIG9uZSB3aXRoIC0tZG9jXCIsIDQwOSwgY2hvaWNlcyk7XG4gICAgY29uc3QgZCA9IHRoaXMuZmluZERvYyh3YW50KTtcbiAgICBpZiAoIWQpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYG5vIGRvY3VtZW50IFwiJHt3YW50fVwiIGluIHRoaXMgc2Vzc2lvbmAsIDQwNCwgY2hvaWNlcyk7XG4gICAgcmV0dXJuIGQ7XG4gIH1cblxuICAvKiogQSBkb2MgYnkgc2x1ZywgYnkgb3JpZ2luYWwgcGF0aCwgb3IgYnkgYSB1bmlxdWUgb3JpZ2luYWwgYmFzZW5hbWUuICovXG4gIGZpbmREb2Moa2V5OiBzdHJpbmcpOiBEb2NSZWNvcmQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGJ5U2x1ZyA9IHRoaXMubS5kb2NzLmZpbmQoKGQpID0+IGQuc2x1ZyA9PT0ga2V5KTtcbiAgICBpZiAoYnlTbHVnKSByZXR1cm4gYnlTbHVnO1xuICAgIC8vIOKblCBPTkxZIEFOIEFCU09MVVRFIGtleSBpcyBhIHBhdGggKHZlcmlmeS1wYXNzIGZpeCA4KTogcmVzb2x2aW5nIGFcbiAgICAvLyByZWxhdGl2ZSBvbmUgaGVyZSByZXNvbHZlZCBpdCBhZ2FpbnN0IHRoZSBEQUVNT04ncyBjd2QuIFRoZSBDTEkgcmVzb2x2ZXNcbiAgICAvLyBhZ2FpbnN0IGl0cyBvd24gY3dkIGFuZCBzZW5kcyBhbiBhYnNvbHV0ZSBwYXRoLlxuICAgIGlmIChpc0Fic29sdXRlKGtleSkpIHtcbiAgICAgIGNvbnN0IGJ5UGF0aCA9IHRoaXMubS5kb2NzLmZpbmQoXG4gICAgICAgIChkKSA9PiBkLm9yaWdpbmFsID09PSBrZXkgfHwgcmVhbE9yKGQub3JpZ2luYWwpID09PSByZWFsT3Ioa2V5KSxcbiAgICAgICk7XG4gICAgICBpZiAoYnlQYXRoKSByZXR1cm4gYnlQYXRoO1xuICAgIH1cbiAgICBjb25zdCBieU5hbWUgPSB0aGlzLm0uZG9jcy5maWx0ZXIoKGQpID0+IGJhc2VuYW1lKGQub3JpZ2luYWwpID09PSBrZXkgfHwgZC5yZWwgPT09IGtleSk7XG4gICAgcmV0dXJuIGJ5TmFtZS5sZW5ndGggPT09IDEgPyBieU5hbWVbMF0gOiB1bmRlZmluZWQ7XG4gIH1cblxuICBwcml2YXRlIHZlcnNpb25PckRpZShkOiBEb2NSZWNvcmQsIG46IG51bWJlcik6IE9taXQ8VmVyc2lvbiwgXCJwYXRoXCI+IHtcbiAgICBjb25zdCB2ID0gZC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm4gPT09IG4pO1xuICAgIGlmICghdilcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Quc2x1Z30gaGFzIG5vIHYke259YCxcbiAgICAgICAgNDA0LFxuICAgICAgICBkLnZlcnNpb25zLm1hcCgoeCkgPT4gYHYke3gubn1gKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIHY7XG4gIH1cblxuICBwcml2YXRlIHNsdWdGb3Iob3JpZ2luYWw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlbSA9XG4gICAgICBiYXNlbmFtZShvcmlnaW5hbCwgZXh0bmFtZShvcmlnaW5hbCkpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOV8tXSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpIHx8IFwiZG9jXCI7XG4gICAgbGV0IHNsdWcgPSBzdGVtO1xuICAgIGZvciAobGV0IGkgPSAyOyB0aGlzLm0uZG9jcy5zb21lKChkKSA9PiBkLnNsdWcgPT09IHNsdWcpOyBpKyspIHNsdWcgPSBgJHtzdGVtfS0ke2l9YDtcbiAgICByZXR1cm4gc2x1ZztcbiAgfVxuXG4gIC8qKlxuICAgKiBPcGVuIGEgZG9jdW1lbnQgYnkgaXRzIG9yaWdpbmFsJ3MgcGF0aDogdjEgaXMgd3JpdHRlbiBmcm9tIHRoZSBvcmlnaW5hbFxuICAgKiB0aGUgZmlyc3QgdGltZS4gYGZvY3VzOiBmYWxzZWAgKHRoZSBhZ2VudCdzIGltcGxpY2l0IG9wZW4gdGhyb3VnaFxuICAgKiBgdmVyc2lvbi1uZXcgLS1kb2MgPHBhdGg+YCkgZG9lcyBub3QgbW92ZSB0aGUgaHVtYW4ncyBvcGVuIGRvY3VtZW50LlxuICAgKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDFiIOKAlCBBRE1JU1NJT04uIE9ubHkgYSBkb2MtdHlwZSBmaWxlIElOU0lERSBhIGNvbnRleHRcbiAgICogZW50cnkgaXMgYWRtaXR0ZWQ7IGBjb250ZXh0LmFkZGAgc3RheXMgdGhlIG9uZSB3YXkgaW4uIEJlZm9yZSB0aGlzLCBhbnlcbiAgICogcGF0aCBvZiBhbnkgdHlwZSB3YXMgb3BlbmVkLCBhbmQgU2F2ZSB0aGVuIHdyb3RlIGl0OiBhIGZvcmVpZ24gd2ViIHBhZ2VcbiAgICogd3JvdGUgYGN1cmwgZXZpbCB8IHNoYCBpbnRvIGEgYC5yY2AgZmlsZSBvdXRzaWRlIHRoZSBjb250ZXh0LlxuICAgKi9cbiAgb3BlblBhdGgocmF3UGF0aDogc3RyaW5nLCBvcHRzOiB7IGZvY3VzPzogYm9vbGVhbiB9ID0ge30pOiB7IHNsdWc6IHN0cmluZzsgY3JlYXRlZDogYm9vbGVhbiB9IHtcbiAgICBjb25zdCBmb2N1cyA9IG9wdHMuZm9jdXMgPz8gdHJ1ZTtcbiAgICAvLyBUaGUgY29udGV4dCdzIG93biBzcGVsbGluZyBvZiB0aGUgcGF0aDogYSBjYWxsZXIgd2hvc2UgY3dkIGlzIGEgcmVhbHBhdGhcbiAgICAvLyAoL3ByaXZhdGUvdmFyL+KApiBmb3IgL3Zhci/igKYsIG9yIHRocm91Z2ggYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgIC8vIGZpbGUgZGlmZmVyZW50bHksIGFuZCBpdCBtdXN0IGxhbmQgb24gdGhlIHNhbWUgZG9jLlxuICAgIGNvbnN0IGFicyA9IHRoaXMuY2Fub25pY2FsKHJlc29sdmUocmF3UGF0aCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5tLmRvY3MuZmluZCgoZCkgPT4gZC5vcmlnaW5hbCA9PT0gYWJzKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGlmIChmb2N1cykgdGhpcy5tLm9wZW5Eb2MgPSBleGlzdGluZy5zbHVnO1xuICAgICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgICByZXR1cm4geyBzbHVnOiBleGlzdGluZy5zbHVnLCBjcmVhdGVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAoIWlzRG9jTmFtZShhYnMpKSB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgNDAwKTtcbiAgICBpZiAoIWxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGAke2Fic30gaXMgbm90IGluIHRoaXMgc2Vzc2lvbidzIGNvbnRleHQg4oCUIGFkZCBpdCAob3IgaXRzIGZvbGRlcikgZmlyc3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghc3RhdFN5bmMoYWJzKS5pc0ZpbGUoKSkgdGhyb3cgbmV3IEVycm9yKFwibm90IGEgZmlsZVwiKTtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKGBjYW5ub3Qgb3BlbiAke2Fic306IG5vIHN1Y2ggZmlsZWAsIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGV4dCA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdLmluY2x1ZGVzKGV4dG5hbWUoYWJzKS50b0xvd2VyQ2FzZSgpKVxuICAgICAgPyBleHRuYW1lKGFicykudG9Mb3dlckNhc2UoKVxuICAgICAgOiBcIi5tZFwiO1xuICAgIGNvbnN0IGF0ID0gbG9jYXRlKHRoaXMubS5jb250ZXh0LCBhYnMpO1xuICAgIGNvbnN0IGQ6IERvY1JlY29yZCA9IHtcbiAgICAgIHNsdWc6IHRoaXMuc2x1Z0ZvcihhYnMpLFxuICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIG9yaWdpbmFsOiBhYnMsXG4gICAgICBlbnRyeUlkOiBhdD8uZW50cnlJZCA/PyBudWxsLFxuICAgICAgcmVsOiBhdD8ucmVsID8/IG51bGwsXG4gICAgICBleHQsXG4gICAgICB2ZXJzaW9uczogW3sgbjogMSwgYXV0aG9yOiBcImh1bWFuXCIsIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSB9XSxcbiAgICAgIGFjdGl2ZTogMSxcbiAgICAgIG9yaWdpbmFsSGFzaDogY29udGVudEhhc2godGV4dCksXG4gICAgICBvdXRzaWRlQ2hhbmdlZDogZmFsc2UsXG4gICAgICBhZG1pdHRlZDogdHJ1ZSxcbiAgICB9O1xuICAgIHRoaXMubS5kb2NzLnB1c2goZCk7XG4gICAgdGhpcy53cml0ZUFjdGl2ZShkLCB0ZXh0KTtcbiAgICBpZiAoZm9jdXMpIHRoaXMubS5vcGVuRG9jID0gZC5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgY3JlYXRlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLyoqIGBhYnNgIGFzIHRoZSBjb250ZXh0IHNwZWxscyBpdCwgd2hlbiBpdCBpcyB0aGUgc2FtZSBmaWxlIGJ5IHJlYWxwYXRoLiAqL1xuICBwcml2YXRlIGNhbm9uaWNhbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKGxvY2F0ZSh0aGlzLm0uY29udGV4dCwgYWJzKSkgcmV0dXJuIGFicztcbiAgICBjb25zdCByZWFsID0gcmVhbE9yKGFicyk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBjb25zdCByZWFsUm9vdCA9IHJlYWxPcihlLnJvb3QpO1xuICAgICAgaWYgKCFyZWFsLnN0YXJ0c1dpdGgocmVhbFJvb3QgKyBzZXApKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNwZWxsZWQgPSBqb2luKGUucm9vdCwgcmVsYXRpdmUocmVhbFJvb3QsIHJlYWwpKTtcbiAgICAgIGlmIChsb2NhdGUodGhpcy5tLmNvbnRleHQsIHNwZWxsZWQpKSByZXR1cm4gc3BlbGxlZDtcbiAgICB9XG4gICAgcmV0dXJuIGFicztcbiAgfVxuXG4gIG9wZW5TbHVnKHNsdWc6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMubS5vcGVuRG9jID0gdGhpcy5kb2NPckRpZShzbHVnKS5zbHVnO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICB9XG5cbiAgcmVhZFZlcnNpb24oc2x1Zzogc3RyaW5nLCBuOiBudW1iZXIpOiB7IHRleHQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIG4pO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIHJldHVybiB7IHRleHQ6IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIiksIHBhdGggfTtcbiAgfVxuXG4gIGFjdGl2ZVBhdGgoc2x1Zz86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IGQgPSBzbHVnID8gdGhpcy5maW5kRG9jKHNsdWcpIDogdGhpcy5tLm9wZW5Eb2MgPyB0aGlzLmZpbmREb2ModGhpcy5tLm9wZW5Eb2MpIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBkID8gdGhpcy52ZXJzaW9uUGF0aChkLCBkLmFjdGl2ZSkgOiBudWxsO1xuICB9XG5cbiAgLyoqIFRoZSBodW1hbidzIGJ1ZmZlciByZWFjaGVzIHRoZSBBQ1RJVkUgdmVyc2lvbidzIGZpbGUgKGRlYm91bmNlZCBieSB0aGUgc3VyZmFjZSkuICovXG4gIC8qKlxuICAgKiDim5QgVkVSSUZZLVBBU1MgRklYIDQg4oCUIENIRUNLIEJFRk9SRSBXUklURS4gQmVmb3JlIHRoZSBodW1hbidzIGVkaXQgaXNcbiAgICogd3JpdHRlbiwgdGhlIGZpbGUgb24gZGlzayBpcyBoYXNoZWQ6IGlmIGl0IGlzIG5vdCB0aGUgZGFlbW9uJ3Mgb3duIGxhc3RcbiAgICogd3JpdGUsIHNvbWVvbmUgZWxzZSB3cm90ZSB0aGUgYWN0aXZlIHZlcnNpb24gKEUyKS4gVGhhdCB0ZXh0IGlzIGtlcHQgYXMgYVxuICAgKiBORVcgYWdlbnQgdmVyc2lvbiwgYW5kIG9ubHkgdGhlbiBpcyB0aGUgZWRpdCB3cml0dGVuLiBEZXRlY3Rpb24gdXNlZCB0b1xuICAgKiBkZXBlbmQgb24gdGhlIHdhdGNoZXIncyA2MCBtcyBzZXR0bGUgdGltZXIgZmlyaW5nIGJlZm9yZSB0aGUgbmV4dFxuICAgKiBrZXlzdHJva2U7IGEgYnVyc3Qgb2YgZWRpdHMgYXQgMzAgbXMgY2xvYmJlcmVkIGFuIG91dHNpZGUgd3JpdGVcbiAgICogdW5hbm5vdW5jZWQuIE5vdyBub3RoaW5nIGlzIGxvc3Qgd2hhdGV2ZXIgdGhlIHRpbWluZyDigJQgdGhlIG9uZSB3aW5kb3cgbGVmdFxuICAgKiBpcyB0aGUgbWljcm9zZWNvbmRzIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGlzIHdyaXRlLlxuICAgKi9cbiAgZWRpdChcbiAgICBzbHVnOiBzdHJpbmcsXG4gICAgbjogbnVtYmVyLFxuICAgIHRleHQ6IHN0cmluZyxcbiAgKTogeyBkaXJ0eUNoYW5nZWQ6IGJvb2xlYW47IHByZXNlcnZlZDogVmVyc2lvbiB8IG51bGwgfSB7XG4gICAgY29uc3QgZCA9IHRoaXMuZG9jT3JEaWUoc2x1Zyk7XG4gICAgaWYgKG4gIT09IGQuYWN0aXZlKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYHYke259IGlzIG5vdCB0aGUgYWN0aXZlIHZlcnNpb24gb2YgJHtkLnNsdWd9ICh2JHtkLmFjdGl2ZX0gaXMpIOKAlCBvbmx5IHRoZSBhY3RpdmUgdmVyc2lvbiBpcyBlZGl0YWJsZWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgY29uc3QgYmVmb3JlID0gdGhpcy5pc0RpcnR5KGQpO1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLnZlcnNpb25QYXRoKGQsIG4pO1xuICAgIC8vIFRoZSBlZGl0IGlzIHN0YWdlZCBpbiBhIHNpYmxpbmcgZmlsZSBGSVJTVCwgc28gdGhlIGNoZWNrIGJlbG93IGFuZCB0aGVcbiAgICAvLyByZW5hbWUgdGhhdCBsYW5kcyB0aGUgZWRpdCBhcmUgYWRqYWNlbnQgc3lzY2FsbHM6IHRoZSB3aW5kb3cgaW4gd2hpY2ggYW5cbiAgICAvLyBvdXRzaWRlIHdyaXRlIGNvdWxkIHNsaXAgYmV0d2VlbiB0aGVtIGlzIG1pY3Jvc2Vjb25kcywgbm90IHRoZSBsZW5ndGggb2ZcbiAgICAvLyBhIG11bHRpLW1lZ2FieXRlIHdyaXRlIOKAlCBhbmQgYSB3cml0ZSBsYW5kaW5nIEFGVEVSIHRoZSByZW5hbWUgZ29lcyB0byB0aGVcbiAgICAvLyBuZXcgZmlsZSwgd2hlcmUgdGhlIHdhdGNoZXIgZmluZHMgaXQgYW5kIHByZXNlcnZlcyBpdCB0b28uXG4gICAgY29uc3Qgc3RhZ2VkID0gYCR7cGF0aH0uJHtwcm9jZXNzLnBpZH0uZWRpdGA7XG4gICAgd3JpdGVGaWxlU3luYyhzdGFnZWQsIHRleHQpO1xuICAgIGxldCBwcmVzZXJ2ZWQ6IFZlcnNpb24gfCBudWxsID0gbnVsbDtcbiAgICBsZXQgb25EaXNrOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgb25EaXNrID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIG9uRGlzayA9IG51bGw7XG4gICAgfVxuICAgIGlmIChvbkRpc2sgIT09IG51bGwgJiYgIXRoaXMuaXNPd25Xcml0ZShwYXRoLCBvbkRpc2spKVxuICAgICAgcHJlc2VydmVkID0gdGhpcy5wcmVzZXJ2ZU91dHNpZGUoZCwgb25EaXNrKTtcbiAgICB0aGlzLm93bmVkLnNldChwYXRoLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgcmVuYW1lU3luYyhzdGFnZWQsIHBhdGgpO1xuICAgIHRoaXMuYWN0aXZlSGFzaC5zZXQoZC5zbHVnLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgdGhpcy5sYXN0QWN0aXZlVGV4dC5zZXQoZC5zbHVnLCB0ZXh0KTtcbiAgICByZXR1cm4geyBkaXJ0eUNoYW5nZWQ6IGJlZm9yZSAhPT0gdGhpcy5pc0RpcnR5KGQpLCBwcmVzZXJ2ZWQgfTtcbiAgfVxuXG4gIC8qKiBDb3B5IGEgdmVyc2lvbiB0byBhIG5ldyBmaWxlOyB0aGUgYWdlbnQgdGhlbiBlZGl0cyB0aGF0IGZpbGUgd2l0aCBpdHMgb3duIHRvb2xzLiAqL1xuICBuZXdWZXJzaW9uKG9wdHM6IHsgZG9jPzogc3RyaW5nOyBmcm9tPzogbnVtYmVyOyBsYWJlbD86IHN0cmluZzsgYXV0aG9yOiBWZXJzaW9uQXV0aG9yIH0pOiB7XG4gICAgc2x1Zzogc3RyaW5nO1xuICAgIHZlcnNpb246IFZlcnNpb247XG4gIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICBjb25zdCBmcm9tID0gb3B0cy5mcm9tID8/IGQuYWN0aXZlO1xuICAgIHRoaXMudmVyc2lvbk9yRGllKGQsIGZyb20pO1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmModGhpcy52ZXJzaW9uUGF0aChkLCBmcm9tKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IG4gPSBNYXRoLm1heCguLi5kLnZlcnNpb25zLm1hcCgodikgPT4gdi5uKSkgKyAxO1xuICAgIGNvbnN0IHJlYzogT21pdDxWZXJzaW9uLCBcInBhdGhcIj4gPSB7XG4gICAgICBuLFxuICAgICAgYXV0aG9yOiBvcHRzLmF1dGhvcixcbiAgICAgIGZyb20sXG4gICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAuLi4ob3B0cy5sYWJlbCA/IHsgbGFiZWw6IG9wdHMubGFiZWwgfSA6IHt9KSxcbiAgICB9O1xuICAgIGQudmVyc2lvbnMucHVzaChyZWMpO1xuICAgIHRoaXMud3JpdGVPd25lZCh0aGlzLnZlcnNpb25QYXRoKGQsIG4pLCB0ZXh0KTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBzbHVnOiBkLnNsdWcsIHZlcnNpb246IHsgLi4ucmVjLCBwYXRoOiB0aGlzLnZlcnNpb25QYXRoKGQsIG4pIH0gfTtcbiAgfVxuXG4gIGFjdGl2YXRlKG9wdHM6IHsgZG9jPzogc3RyaW5nOyB2ZXJzaW9uOiBudW1iZXIgfSk6IHsgc2x1Zzogc3RyaW5nOyBwcmV2aW91czogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKG9wdHMuZG9jKTtcbiAgICB0aGlzLnZlcnNpb25PckRpZShkLCBvcHRzLnZlcnNpb24pO1xuICAgIGNvbnN0IHByZXZpb3VzID0gZC5hY3RpdmU7XG4gICAgZC5hY3RpdmUgPSBvcHRzLnZlcnNpb247XG4gICAgLy8gVGhlIG5ldyBhY3RpdmUgdmVyc2lvbidzIHRleHQgQVMgSVQgSVMgTk9XIGlzIHRoZSBiYXNlbGluZSB0aGUgbmV4dFxuICAgIC8vIGNoZWNrLWJlZm9yZS13cml0ZSBjb21wYXJlcyBhZ2FpbnN0LlxuICAgIHRoaXMuYWRvcHRBY3RpdmUoZCwgcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIikpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHNsdWc6IGQuc2x1ZywgcHJldmlvdXMgfTtcbiAgfVxuXG4gIC8qKiBTYXZlOiB0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IG92ZXIgdGhlIG9yaWdpbmFsLiBUaGUgT05MWSB3cml0ZSB0byBpdCAoRTcpLiAqL1xuICBzYXZlKHNsdWc6IHN0cmluZyk6IHsgb3JpZ2luYWw6IHN0cmluZzsgdmVyc2lvbjogbnVtYmVyIH0ge1xuICAgIGNvbnN0IGQgPSB0aGlzLmRvY09yRGllKHNsdWcpO1xuICAgIC8vIOKblCBWRVJJRlktUEFTUyBGSVggMWM6IFNhdmUgd3JpdGVzIG9ubHkgYW4gb3JpZ2luYWwgYWRtaXR0ZWQgYnlcbiAgICAvLyBgb3BlblBhdGhgIChhIGRvYy10eXBlIGZpbGUgaW5zaWRlIGEgY29udGV4dCBlbnRyeSkuIENoZWNrZWQgYWdhaW4gaGVyZVxuICAgIC8vIHNvIG5vIG90aGVyIHBhdGggaW50byB0aGUgbWFuaWZlc3Qg4oCUIGEgaGFuZC1lZGl0ZWQgb25lLCBhIGZ1dHVyZSB2ZXJiIOKAlFxuICAgIC8vIGNhbiB0dXJuIFNhdmUgaW50byBcIndyaXRlIGFueSBmaWxlXCIuXG4gICAgaWYgKCFkLmFkbWl0dGVkIHx8ICFpc0RvY05hbWUoZC5vcmlnaW5hbCkpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gc2F2ZSAke2Qub3JpZ2luYWx9OiBpdCB3YXMgbm90IG9wZW5lZCBmcm9tIHRoZSBjb250ZXh0YCxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKHRoaXMudmVyc2lvblBhdGgoZCwgZC5hY3RpdmUpLCBcInV0ZjhcIik7XG4gICAgdGhpcy53cml0ZU93bmVkKGQub3JpZ2luYWwsIHRleHQpO1xuICAgIGQub3JpZ2luYWxIYXNoID0gY29udGVudEhhc2godGV4dCk7XG4gICAgZC5vdXRzaWRlQ2hhbmdlZCA9IGZhbHNlO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IG9yaWdpbmFsOiBkLm9yaWdpbmFsLCB2ZXJzaW9uOiBkLmFjdGl2ZSB9O1xuICB9XG5cbiAgLyoqIFJldmVydDogdGhlIG9yaWdpbmFsJ3MgdGV4dCBiYWNrIG92ZXIgdGhlIGFjdGl2ZSB2ZXJzaW9uLiAqL1xuICByZXZlcnQoc2x1Zzogc3RyaW5nKTogeyB2ZXJzaW9uOiBudW1iZXI7IHRleHQ6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkID0gdGhpcy5kb2NPckRpZShzbHVnKTtcbiAgICBjb25zdCB0ZXh0ID0gcmVhZEZpbGVTeW5jKGQub3JpZ2luYWwsIFwidXRmOFwiKTtcbiAgICBkLm9yaWdpbmFsSGFzaCA9IGNvbnRlbnRIYXNoKHRleHQpO1xuICAgIGQub3V0c2lkZUNoYW5nZWQgPSBmYWxzZTtcbiAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHZlcnNpb246IGQuYWN0aXZlLCB0ZXh0IH07XG4gIH1cblxuICBwcml2YXRlIGlzRGlydHkoZDogRG9jUmVjb3JkKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICh0aGlzLmFjdGl2ZUhhc2guZ2V0KGQuc2x1ZykgPz8gXCJcIikgIT09IGQub3JpZ2luYWxIYXNoO1xuICB9XG5cbiAgLy8g4pSA4pSAIHRoZSB3YXRjaGVyJ3MgcXVlc3Rpb246IHdob3NlIHdyaXRlIHdhcyB0aGF0PyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ2xhc3NpZnkgb25lIGZpbGVzeXN0ZW0gZXZlbnQuIFJlYWRzIHRoZSBmaWxlOyByZXR1cm5zIGBudWxsYCB3aGVuIGl0IGlzXG4gICAqIHRoZSBkYWVtb24ncyBvd24gd3JpdGUsIHVuY2hhbmdlZCwgZ29uZSwgb3Igbm90IG91cnMgdG8gY2FyZSBhYm91dC5cbiAgICovXG4gIG9uRmlsZUV2ZW50KGFiczogc3RyaW5nKTogRmlsZUV2ZW50IHwgbnVsbCB7XG4gICAgLy8gQSB2ZXJzaW9uIGZpbGUgdW5kZXIgZG9jcy88c2x1Zz4vdk4uZXh0P1xuICAgIGlmIChhYnMuc3RhcnRzV2l0aCh0aGlzLmRvY3NEaXIgKyBzZXApKSB7XG4gICAgICBjb25zdCByZXN0ID0gYWJzLnNsaWNlKHRoaXMuZG9jc0Rpci5sZW5ndGggKyAxKS5zcGxpdChzZXApO1xuICAgICAgaWYgKHJlc3QubGVuZ3RoICE9PSAyKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IFtzbHVnLCBmaWxlXSA9IHJlc3QgYXMgW3N0cmluZywgc3RyaW5nXTtcbiAgICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4LnNsdWcgPT09IHNsdWcpO1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXnYoXFxkKykoXFwuW2Etel0rKSQvLmV4ZWMoZmlsZSk7XG4gICAgICBpZiAoIWQgfHwgIW1hdGNoIHx8IG1hdGNoWzJdICE9PSBkLmV4dCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBuID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgICB0cnkge1xuICAgICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuaXNPd25Xcml0ZShhYnMsIHRleHQpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghZC52ZXJzaW9ucy5zb21lKCh2KSA9PiB2Lm4gPT09IG4pKSB7XG4gICAgICAgIC8vIFRoZSBhZ2VudCB3cm90ZSBhIHZlcnNpb24gZmlsZSBieSBoYW5kIHJhdGhlciB0aGFuIHRocm91Z2hcbiAgICAgICAgLy8gYHZlcnNpb24tbmV3YCDigJQgYWRvcHQgaXQgcmF0aGVyIHRoYW4gbGVhdmUgYSBmaWxlIHRoZSBzdXJmYWNlIGNhbm5vdCBzZWUuXG4gICAgICAgIGQudmVyc2lvbnMucHVzaCh7IG4sIGF1dGhvcjogXCJhZ2VudFwiLCBjcmVhdGVkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgICAgIGQudmVyc2lvbnMuc29ydCgoYSwgYikgPT4gYS5uIC0gYi5uKTtcbiAgICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICAgIHRoaXMucGVyc2lzdCgpO1xuICAgICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY3JlYXRlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgcGF0aDogYWJzIH07XG4gICAgICB9XG4gICAgICBpZiAobiA9PT0gZC5hY3RpdmUpIHtcbiAgICAgICAgLy8gRTIsIHJlZnVzZWQgYW5kIFJFLUxBQkVMTEVEOiB0aGUgb3V0c2lkZSB0ZXh0IGJlY29tZXMgYSBuZXcgYWdlbnRcbiAgICAgICAgLy8gdmVyc2lvbiwgYW5kIHRoZSBhY3RpdmUgdmVyc2lvbiBnb2VzIGJhY2sgdG8gdGhlIGRhZW1vbidzIG93biBsYXN0XG4gICAgICAgIC8vIHRleHQg4oCUIHNvIHRoZSBhY3RpdmUgdmVyc2lvbiBvbmx5IGV2ZXIgaG9sZHMgd2hhdCB0aGUgaHVtYW4gdHlwZWQsXG4gICAgICAgIC8vIGFuZCBub3RoaW5nIGFueW9uZSB3cm90ZSBpcyBsb3N0ICh2ZXJpZnktcGFzcyBmaXggNCwgd2F0Y2hlciBoYWxmKS5cbiAgICAgICAgY29uc3Qga2VwdCA9IHRoaXMucHJlc2VydmVPdXRzaWRlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRoaXMubGFzdEFjdGl2ZVRleHQuZ2V0KGQuc2x1ZykgPz8gdGV4dCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJhY3RpdmUub3V0c2lkZVwiLFxuICAgICAgICAgIGRvYzogZC5zbHVnLFxuICAgICAgICAgIHZlcnNpb246IG4sXG4gICAgICAgICAgcGF0aDogYWJzLFxuICAgICAgICAgIHByZXNlcnZlZEFzOiBrZXB0Lm4sXG4gICAgICAgICAgcHJlc2VydmVkUGF0aDoga2VwdC5wYXRoLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhpcy5vd25lZC5zZXQoYWJzLCBjb250ZW50SGFzaCh0ZXh0KSk7XG4gICAgICByZXR1cm4geyBraW5kOiBcInZlcnNpb24uY2hhbmdlZFwiLCBkb2M6IGQuc2x1ZywgdmVyc2lvbjogbiwgdGV4dCwgYWN0aXZlOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIC8vIEFuIG9wZW5lZCBvcmlnaW5hbCDigJQgYnkgaXRzIHN0b3JlZCBwYXRoLCBvciBieSByZWFscGF0aCBmb3IgYSBzeW1saW5rP1xuICAgIGNvbnN0IGQgPSB0aGlzLm0uZG9jcy5maW5kKCh4KSA9PiB4Lm9yaWdpbmFsID09PSBhYnMgfHwgcmVhbE9yKHgub3JpZ2luYWwpID09PSBhYnMpO1xuICAgIGlmIChkKSB7XG4gICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGV4dCA9IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGggPSBjb250ZW50SGFzaCh0ZXh0KTtcbiAgICAgIGlmIChoID09PSBkLm9yaWdpbmFsSGFzaCkgcmV0dXJuIG51bGw7IC8vIG91ciBvd24gc2F2ZSwgb3Igbm8gY2hhbmdlXG4gICAgICBjb25zdCBjbGVhbiA9ICF0aGlzLmlzRGlydHkoZCk7XG4gICAgICBpZiAoY2xlYW4pIHtcbiAgICAgICAgZC5vcmlnaW5hbEhhc2ggPSBoO1xuICAgICAgICB0aGlzLndyaXRlQWN0aXZlKGQsIHRleHQpO1xuICAgICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBraW5kOiBcIm9yaWdpbmFsLnJlbG9hZGVkXCIsXG4gICAgICAgICAgZG9jOiBkLnNsdWcsXG4gICAgICAgICAgdmVyc2lvbjogZC5hY3RpdmUsXG4gICAgICAgICAgdGV4dCxcbiAgICAgICAgICBvcmlnaW5hbDogZC5vcmlnaW5hbCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkLm91dHNpZGVDaGFuZ2VkKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBhc2tlZFxuICAgICAgZC5vdXRzaWRlQ2hhbmdlZCA9IHRydWU7XG4gICAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwib3JpZ2luYWwuY29uZmxpY3RcIiwgZG9jOiBkLnNsdWcsIG9yaWdpbmFsOiBkLm9yaWdpbmFsIH07XG4gICAgfVxuXG4gICAgLy8gU29tZXRoaW5nIHVuZGVyIGEgbWlycm9yZWQgcm9vdDogdGhlIHRyZWUgbWF5IGhhdmUgY2hhbmdlZC5cbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibWlycm9yZWRcIiAmJiAoYWJzID09PSBlLnJvb3QgfHwgYWJzLnN0YXJ0c1dpdGgoZS5yb290ICsgc2VwKSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzY2FuKGUuaWQpID8geyBraW5kOiBcInRyZWVcIiwgZW50cnlJZDogZS5pZCB9IDogbnVsbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyDilIDilIAgc3RydWN0dXJlIChFMjLigJNFMjQpOiByZWFsIGNoYW5nZXMgb24gZGlzaywgb25lIHBhdGggZm9yIGJvdGggcGFydGllcyDilIDilIBcbiAgLy9cbiAgLy8gRXZlcnkgbWV0aG9kIGJlbG93IGRvZXMgdGhlIGNoYW5nZSBPTiBESVNLIGFuZCB0aGVuIGJyaW5ncyB0aGUgY29udGV4dFxuICAvLyBtb2RlbCBiYWNrIGluIGxpbmUgd2l0aCBpdC4gVGhlIHN1cmZhY2UgcmVhY2hlcyB0aGVtIHRocm91Z2ggbWVudXMgYW5kXG4gIC8vIGRyYWcgYW5kIGRyb3AsIHRoZSBhZ2VudCB0aHJvdWdoIENMSSB2ZXJiczsgdGhlIGRhZW1vbiBhbm5vdW5jZXMgZWFjaCBvbmVcbiAgLy8gdW5kZXIgdGhlIG5hbWUgb2Ygd2hvZXZlciBkaWQgaXQuIFR3byBydWxlcyBob2xkIHRocm91Z2hvdXQ6XG4gIC8vXG4gIC8vIC0gTk9USElORyBJUyBERUxFVEVELiBgaGlkZWAgdGFrZXMgYSBub2RlIG91dCBvZiBTY3JpcHRvcml1bTsgdGhlIGZpbGUgc3RheXMuXG4gIC8vIC0gTk9USElORyBJUyBPVkVSV1JJVFRFTi4gQSBkZXN0aW5hdGlvbiB0aGF0IGV4aXN0cyBpcyByZWZ1c2VkIChhbiBleHBsaWNpdFxuICAvLyAgIG5hbWUpIG9yIGdpdmVuIGEgZnJlZSBuYW1lIChhIGRlZmF1bHQgb25lLCBhIGRyb3ApOyBmaWxlcyBhcmUgY3JlYXRlZFxuICAvLyAgIHdpdGggdGhlIGV4Y2x1c2l2ZSBmbGFnLCBzbyBhIHJhY2UgY2Fubm90IGNsb2JiZXIgZWl0aGVyLlxuXG4gIC8qKiBFMjM6IHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kLiAqL1xuICBnZXQgd29ya3NwYWNlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMubS53b3Jrc3BhY2UgPz8gaG9tZWRpcigpO1xuICB9XG5cbiAgc2V0V29ya3NwYWNlKHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmUocmF3UGF0aCk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgbm8gc3VjaCBmb2xkZXI6ICR7YWJzfWAsIDQwNCk7XG4gICAgfVxuICAgIGlmICghaXNEaXIpIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYHRoZSB3b3Jrc3BhY2UgbXVzdCBiZSBhIGZvbGRlcjogJHthYnN9YCwgNDAwKTtcbiAgICB0aGlzLm0ud29ya3NwYWNlID0gYWJzO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IGFicyB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEhvdyBhIHBhdGggcmVhZHMgaW4gYSBjaGF0IGxpbmU6IGBzZXQvcmVsYCBpbnNpZGUgYSBzZXQsIGEgc2luZ2xlXG4gICAqIGRvY3VtZW50J3MgZmlsZSBuYW1lLCBgd29ya3NwYWNlL+KApmAgaW4gdGhlIHdvcmtzcGFjZSwgZWxzZSBgfi/igKZgLlxuICAgKi9cbiAgZGlzcGxheShhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwID09PSBcIm1pcnJvcmVkXCIpIHtcbiAgICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gZS5sYWJlbDtcbiAgICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHJldHVybiBgJHtlLmxhYmVsfS8ke3RvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKX1gO1xuICAgICAgfSBlbHNlIGlmIChlLm5vZGVzLnNvbWUoKG4pID0+IGpvaW4oZS5yb290LCBuLnJlbCkgPT09IGFicykpIHJldHVybiBlLmxhYmVsO1xuICAgIH1cbiAgICBpZiAoYWJzLnN0YXJ0c1dpdGgodGhpcy53b3Jrc3BhY2UgKyBzZXApKVxuICAgICAgcmV0dXJuIGB3b3Jrc3BhY2UvJHt0b1Bvc2l4KHJlbGF0aXZlKHRoaXMud29ya3NwYWNlLCBhYnMpKX1gO1xuICAgIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG4gICAgcmV0dXJuIGFicyA9PT0gaG9tZSA/IFwiflwiIDogYWJzLnN0YXJ0c1dpdGgoaG9tZSArIHNlcCkgPyBgfiR7YWJzLnNsaWNlKGhvbWUubGVuZ3RoKX1gIDogYWJzO1xuICB9XG5cbiAgLyoqXG4gICAqIGBhYnNgIHNwZWxsZWQgdGhlIHdheSB0aGUgY29udGV4dCBzcGVsbHMgaXQuIEEgY2FsbGVyIHdob3NlIGN3ZCBpcyBhXG4gICAqIHJlYWxwYXRoICgvcHJpdmF0ZS92YXIv4oCmIGZvciAvdmFyL+KApiwgYSBzeW1saW5rZWQgZm9sZGVyKSBuYW1lcyB0aGUgc2FtZVxuICAgKiBwbGFjZSBkaWZmZXJlbnRseSwgYW5kIGl0IG11c3QgbGFuZCBvbiB0aGUgc2FtZSBub2RlLlxuICAgKi9cbiAgcHJpdmF0ZSBzcGVsbChhYnM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMubS5jb250ZXh0LnNvbWUoKGUpID0+IGFicyA9PT0gZS5yb290IHx8IGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpKSByZXR1cm4gYWJzO1xuICAgIGNvbnN0IHJlYWwgPSByZWFsT3IoYWJzKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGNvbnN0IHJlYWxSb290ID0gcmVhbE9yKGUucm9vdCk7XG4gICAgICBpZiAocmVhbCA9PT0gcmVhbFJvb3QpIHJldHVybiBlLnJvb3Q7XG4gICAgICBpZiAocmVhbC5zdGFydHNXaXRoKHJlYWxSb290ICsgc2VwKSkgcmV0dXJuIGpvaW4oZS5yb290LCByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbCkpO1xuICAgIH1cbiAgICByZXR1cm4gYWJzO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1dvcmtzcGFjZShhYnM6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBhYnMgPT09IHRoaXMud29ya3NwYWNlIHx8IHJlYWxPcihhYnMpID09PSByZWFsT3IodGhpcy53b3Jrc3BhY2UpO1xuICB9XG5cbiAgLyoqIFRoZSBtaXJyb3JlZCBlbnRyeSB0aGF0IGNvdmVycyBgYWJzYCAoaXRzIHJvb3QsIG9yIGFueXRoaW5nIHVuZGVyIGl0KSwgaWYgYW55LiAqL1xuICBwcml2YXRlIGNvdmVyaW5nRW50cnkoYWJzOiBzdHJpbmcsIGV4Y2VwdD86IHN0cmluZyk6IENvbnRleHRFbnRyeSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMubS5jb250ZXh0LmZpbmQoXG4gICAgICAoZSkgPT5cbiAgICAgICAgZS5pZCAhPT0gZXhjZXB0ICYmXG4gICAgICAgIGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiICYmXG4gICAgICAgIChhYnMgPT09IGUucm9vdCB8fCBhYnMuc3RhcnRzV2l0aChlLnJvb3QgKyBzZXApKSxcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIEEgZm9sZGVyIHRoaW5ncyBtYXkgYmUgbWFkZSBpbiBvciBtb3ZlZCBpbnRvOiBhIG1pcnJvcmVkIGVudHJ5J3Mgcm9vdCwgYVxuICAgKiB2aXNpYmxlIGZvbGRlciB1bmRlciBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UuIFJldHVybnMgdGhlIGFic29sdXRlIGZvbGRlcjtcbiAgICogcmVmdXNlcyBhbnl0aGluZyBlbHNlIOKAlCB0aGUgY29udGV4dCBzdGF5cyB0aGUgd2F5IGluICh2ZXJpZnktcGFzcyBmaXggMWIpLlxuICAgKi9cbiAgcHJpdmF0ZSBkZXN0aW5hdGlvbk9yRGllKHJhd0Rpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhYnMgPSB0aGlzLnNwZWxsKHJlc29sdmUocmF3RGlyKSk7XG4gICAgZm9yIChjb25zdCBlIG9mIHRoaXMubS5jb250ZXh0KSB7XG4gICAgICBpZiAoZS5tZW1iZXJzaGlwICE9PSBcIm1pcnJvcmVkXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGFicyA9PT0gZS5yb290KSByZXR1cm4gYWJzO1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlPy5raW5kID09PSBcImdyb3VwXCIpIHJldHVybiBhYnM7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICh0aGlzLmlzV29ya3NwYWNlKGFicykpIHJldHVybiB0aGlzLndvcmtzcGFjZTtcbiAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgYCR7YWJzfSBpcyBub3QgYSBmb2xkZXIgaW4gdGhpcyBzZXNzaW9uIOKAlCBuYW1lIGEgc2V0LCBhIGZvbGRlciBpbnNpZGUgb25lLCBvciB0aGUgd29ya3NwYWNlICgke3RoaXMud29ya3NwYWNlfSlgLFxuICAgICAgNDAwLFxuICAgICk7XG4gIH1cblxuICAvKiogQSBkb2N1bWVudCBvciBmb2xkZXIgc2hvd24gaW4gdGhlIGNvbnRleHQsIHdpdGggd2hlcmUgaXQgaXMgc2hvd24uICovXG4gIHByaXZhdGUgaXRlbU9yRGllKHJhd1BhdGg6IHN0cmluZyk6IHtcbiAgICBhYnM6IHN0cmluZztcbiAgICBlbnRyeTogQ29udGV4dEVudHJ5O1xuICAgIC8qKiBUaGUgd2hvbGUgZW50cnkgKGEgc2V0J3Mgb3duIGZvbGRlciwgYSBsaXN0ZWQgZG9jdW1lbnQpLCBvciBhIG5vZGUgaW5zaWRlIGEgc2V0LiAqL1xuICAgIHdob2xlOiBib29sZWFuO1xuICAgIGRpcjogYm9vbGVhbjtcbiAgfSB7XG4gICAgY29uc3QgYWJzID0gdGhpcy5zcGVsbChyZXNvbHZlKHJhd1BhdGgpKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgdGhpcy5tLmNvbnRleHQpIHtcbiAgICAgIGlmIChlLm1lbWJlcnNoaXAgPT09IFwibGlzdGVkXCIpIHtcbiAgICAgICAgY29uc3Qgb25seSA9IGUubm9kZXNbMF07XG4gICAgICAgIGlmIChlLm5vZGVzLmxlbmd0aCA9PT0gMSAmJiBvbmx5Py5raW5kID09PSBcImRvY1wiICYmIGpvaW4oZS5yb290LCBvbmx5LnJlbCkgPT09IGFicylcbiAgICAgICAgICByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogdHJ1ZSwgZGlyOiBmYWxzZSB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhYnMgPT09IGUucm9vdCkgcmV0dXJuIHsgYWJzLCBlbnRyeTogZSwgd2hvbGU6IHRydWUsIGRpcjogdHJ1ZSB9O1xuICAgICAgaWYgKGFicy5zdGFydHNXaXRoKGUucm9vdCArIHNlcCkpIHtcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGUubm9kZXMsIHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSk7XG4gICAgICAgIGlmIChub2RlKSByZXR1cm4geyBhYnMsIGVudHJ5OiBlLCB3aG9sZTogZmFsc2UsIGRpcjogbm9kZS5raW5kID09PSBcImdyb3VwXCIgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihgJHthYnN9IGlzIG5vdCBzaG93biBpbiB0aGlzIHNlc3Npb24ncyBjb250ZXh0YCwgNDA0KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBgcmF3UGF0aGAgaWYgdGhlIGNvbnRleHQgc2hvd3MgaXQg4oCUIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIGEgc2V0LCBhXG4gICAqIGxpc3RlZCBkb2N1bWVudCwgYSBzZXQncyBvd24gZm9sZGVyIOKAlCBvciBpdCBpcyB0aGUgd29ya3NwYWNlOyByZWZ1c2VkXG4gICAqIG90aGVyd2lzZS4gRm9yIGFjdHMgdGhhdCByZWFjaCBvdXRzaWRlIHRoZSBzcGVsbCAocmV2ZWFsaW5nIGEgcGF0aCBpbiB0aGVcbiAgICogZmlsZSBtYW5hZ2VyKSwgc28gYSBwYWdlIGNhbm5vdCBhaW0gdGhlbSBhdCBhbiBhcmJpdHJhcnkgcGF0aC5cbiAgICovXG4gIHNob3duUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGFicyA9IHRoaXMuc3BlbGwocmVzb2x2ZShyYXdQYXRoKSk7XG4gICAgaWYgKHRoaXMuaXRlbUF0KGFicykpIHJldHVybiBhYnM7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3RpbmF0aW9uT3JEaWUoYWJzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBpcyBub3Qgc2hvd24gaW4gdGhpcyBzZXNzaW9uYCwgNDAwKTtcbiAgICB9XG4gIH1cblxuICAvKiogUmVmdXNlIGEgbmFtZSB0aGF0IGlzIG5vdCBvbmUgcGxhaW4gZmlsZSBvciBmb2xkZXIgbmFtZS4gKi9cbiAgcHJpdmF0ZSBuYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gbmFtZS50cmltKCk7XG4gICAgaWYgKFxuICAgICAgbiA9PT0gXCJcIiB8fFxuICAgICAgbiA9PT0gXCIuXCIgfHxcbiAgICAgIG4gPT09IFwiLi5cIiB8fFxuICAgICAgbi5zdGFydHNXaXRoKFwiLlwiKSB8fFxuICAgICAgL1svXFxcXFxcMF0vLnRlc3QobikgfHxcbiAgICAgIG4ubGVuZ3RoID4gMjU1XG4gICAgKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYFwiJHtuYW1lfVwiIGlzIG5vdCBhIHVzYWJsZSBuYW1lIOKAlCBvbmUgcGxhaW4gbmFtZSwgbm8gc2xhc2hlcywgbm90IHN0YXJ0aW5nIHdpdGggYSBkb3RgLFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIHJldHVybiBuO1xuICB9XG5cbiAgLyoqIEEgZG9jdW1lbnQgbmFtZTogYSBuYW1lIHdpdGhvdXQgYSBkb2N1bWVudCBleHRlbnNpb24gZ2V0cyBgLm1kYC4gKi9cbiAgcHJpdmF0ZSBkb2NOYW1lT3JEaWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBuID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgcmV0dXJuIGlzRG9jTmFtZShuKSA/IG4gOiBgJHtufS5tZGA7XG4gIH1cblxuICAvKipcbiAgICogQWZ0ZXIgc29tZXRoaW5nIG1vdmVkIG9uIGRpc2sgZnJvbSBgZnJvbWAgdG8gYHRvYCwgYnJpbmcgdGhlIG1vZGVsIHdpdGggaXQ6XG4gICAqIG9wZW5lZCBkb2N1bWVudHMga2VlcCB0aGVpciB2ZXJzaW9ucyB1bmRlciB0aGUgbmV3IHBhdGgsIGVudHJpZXMgcm9vdGVkIGF0XG4gICAqIG9yIGhvbGRpbmcgdGhlIG1vdmVkIHRoaW5nIGZvbGxvdyBpdCwgYW5kIGV2ZXJ5IG1pcnJvciBpcyByZS1yZWFkLiBBbiBlbnRyeVxuICAgKiB0aGF0IG5vdyBzaXRzIGluc2lkZSBhbm90aGVyIHNldCBpcyBkcm9wcGVkIOKAlCB0aGUgc2V0IHNob3dzIGl0IGFscmVhZHkuXG4gICAqL1xuICBwcml2YXRlIGZvbGxvd01vdmUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgbW92ZWQgPSAocDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCA9PlxuICAgICAgcCA9PT0gZnJvbSA/IHRvIDogcC5zdGFydHNXaXRoKGZyb20gKyBzZXApID8gdG8gKyBwLnNsaWNlKGZyb20ubGVuZ3RoKSA6IG51bGw7XG4gICAgZm9yIChjb25zdCBkIG9mIHRoaXMubS5kb2NzKSB7XG4gICAgICBjb25zdCBub3cgPSBtb3ZlZChkLm9yaWdpbmFsKTtcbiAgICAgIGlmIChub3cpIHtcbiAgICAgICAgZC5vcmlnaW5hbCA9IG5vdztcbiAgICAgICAgZC5uYW1lID0gYmFzZW5hbWUobm93KTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgZHJvcCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkge1xuICAgICAgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJsaXN0ZWRcIikge1xuICAgICAgICBjb25zdCBvbmx5ID0gZS5ub2Rlc1swXTtcbiAgICAgICAgaWYgKG9ubHk/LmtpbmQgIT09IFwiZG9jXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBub3cgPSBtb3ZlZChqb2luKGUucm9vdCwgb25seS5yZWwpKTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBkaXJuYW1lKG5vdyk7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdyk7XG4gICAgICAgICAgZS5ub2RlcyA9IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUobm93KSB9XTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3Qgbm93ID0gbW92ZWQoZS5yb290KTtcbiAgICAgICAgaWYgKCFub3cpIGNvbnRpbnVlO1xuICAgICAgICBpZiAodGhpcy5jb3ZlcmluZ0VudHJ5KG5vdywgZS5pZCkpIGRyb3AuYWRkKGUuaWQpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBlLnJvb3QgPSBub3c7XG4gICAgICAgICAgZS5sYWJlbCA9IGJhc2VuYW1lKG5vdykgfHwgbm93O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMubS5jb250ZXh0ID0gdGhpcy5tLmNvbnRleHQuZmlsdGVyKChlKSA9PiAhZHJvcC5oYXMoZS5pZCkpO1xuICAgIGZvciAoY29uc3QgZSBvZiB0aGlzLm0uY29udGV4dCkgaWYgKGUubWVtYmVyc2hpcCA9PT0gXCJtaXJyb3JlZFwiKSB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICB9XG5cbiAgLyoqIEFmdGVyIGEgZmlsZSBvciBmb2xkZXIgbGFuZGVkIGF0IGBhYnNgOiByZS1yZWFkIHRoZSBzZXQgaXQgaXMgaW4sIG9yIGdpdmUgaXQgYW4gZW50cnkuICovXG4gIHByaXZhdGUgYWRvcHROZXcoYWJzOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBzZXQgPSB0aGlzLmNvdmVyaW5nRW50cnkoYWJzKTtcbiAgICBpZiAoc2V0KSB0aGlzLnJlc2NhbihzZXQuaWQpO1xuICAgIGVsc2UgdGhpcy5tLmNvbnRleHQucHVzaChlbnRyeUZvclBhdGgoYWJzLCBgYy0ke3JhbmRIZXgoMyl9YCkpO1xuICAgIHRoaXMucmVsaW5rKCk7XG4gIH1cblxuICAvKiogQSBuYW1lIGluIGBkaXJgIHRoYXQgaXMgZnJlZTogYG5hbWVgLCBlbHNlIGBzdGVtIDIuZXh0YCwgYHN0ZW0gMy5leHRgLCDigKYgKi9cbiAgcHJpdmF0ZSBmcmVlTmFtZShkaXI6IHN0cmluZywgbmFtZTogc3RyaW5nLCBpc0RpcjogYm9vbGVhbik6IHN0cmluZyB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZGlyLCBuYW1lKSkpIHJldHVybiBuYW1lO1xuICAgIGNvbnN0IGV4dCA9IGlzRGlyID8gXCJcIiA6IGV4dG5hbWUobmFtZSk7XG4gICAgY29uc3Qgc3RlbSA9IGV4dCA/IG5hbWUuc2xpY2UoMCwgLWV4dC5sZW5ndGgpIDogbmFtZTtcbiAgICBmb3IgKGxldCBpID0gMjsgOyBpKyspIHtcbiAgICAgIGNvbnN0IG4gPSBgJHtzdGVtfSAke2l9JHtleHR9YDtcbiAgICAgIGlmICghZXhpc3RzU3luYyhqb2luKGRpciwgbikpKSByZXR1cm4gbjtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlZnVzZUV4aXN0aW5nKGFiczogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKGV4aXN0c1N5bmMoYWJzKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7YWJzfSBhbHJlYWR5IGV4aXN0cyDigJQgbm90aGluZyB3YXMgb3ZlcndyaXR0ZW5gLCA0MDkpO1xuICB9XG5cbiAgY3JlYXRlRG9jKHJhd0Rpcjogc3RyaW5nLCBuYW1lPzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgZGlyID0gdGhpcy5kZXN0aW5hdGlvbk9yRGllKHJhd0Rpcik7XG4gICAgY29uc3QgZmlsZSA9XG4gICAgICBuYW1lID09PSB1bmRlZmluZWQgPyB0aGlzLmZyZWVOYW1lKGRpciwgXCJVbnRpdGxlZC5tZFwiLCBmYWxzZSkgOiB0aGlzLmRvY05hbWVPckRpZShuYW1lKTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgZmlsZSk7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyhhYnMpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCBcIlwiLCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICBjcmVhdGVGb2xkZXIocmF3RGlyOiBzdHJpbmcsIG5hbWU/OiBzdHJpbmcpOiB7IHBhdGg6IHN0cmluZyB9IHtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3RGlyKTtcbiAgICBjb25zdCBmb2xkZXIgPVxuICAgICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gdGhpcy5mcmVlTmFtZShkaXIsIFwiTmV3IGZvbGRlclwiLCB0cnVlKSA6IHRoaXMubmFtZU9yRGllKG5hbWUpO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBmb2xkZXIpO1xuICAgIHRoaXMucmVmdXNlRXhpc3RpbmcoYWJzKTtcbiAgICBta2RpclN5bmMoYWJzKTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICBtb3ZlKHJhd1BhdGg6IHN0cmluZywgcmF3SW50bzogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZyb206IHN0cmluZyB9IHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5pdGVtT3JEaWUocmF3UGF0aCk7XG4gICAgY29uc3QgaW50byA9IHRoaXMuZGVzdGluYXRpb25PckRpZShyYXdJbnRvKTtcbiAgICBpZiAoaW50byA9PT0gaXRlbS5hYnMgfHwgaW50by5zdGFydHNXaXRoKGl0ZW0uYWJzICsgc2VwKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYGNhbm5vdCBtb3ZlICR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaW50byBpdHNlbGZgLCA0MDApO1xuICAgIGlmIChkaXJuYW1lKGl0ZW0uYWJzKSA9PT0gaW50bylcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoYCR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaXMgYWxyZWFkeSBpbiB0aGF0IGZvbGRlcmAsIDQwMCk7XG4gICAgY29uc3QgdG8gPSBqb2luKGludG8sIGJhc2VuYW1lKGl0ZW0uYWJzKSk7XG4gICAgdGhpcy5yZWZ1c2VFeGlzdGluZyh0byk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIGlmICghdGhpcy5pdGVtQXQodG8pKSB0aGlzLmFkb3B0TmV3KHRvKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgfVxuXG4gIHJlbmFtZShyYXdQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBmcm9tOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGxldCBuZXh0ID0gdGhpcy5uYW1lT3JEaWUobmFtZSk7XG4gICAgLy8gQSBkb2N1bWVudCBrZWVwcyBhIGRvY3VtZW50IGV4dGVuc2lvbjogXCJub3Rlc1wiIHJlbmFtZXMgbm90ZXMubWQgdG9cbiAgICAvLyBub3Rlcy5tZCwgbm90IHRvIGFuIGV4dGVuc2lvbmxlc3MgZmlsZSBTY3JpcHRvcml1bSB3b3VsZCBzdG9wIHNob3dpbmcuXG4gICAgaWYgKCFpdGVtLmRpciAmJiAhaXNEb2NOYW1lKG5leHQpKSBuZXh0ICs9IGV4dG5hbWUoaXRlbS5hYnMpIHx8IFwiLm1kXCI7XG4gICAgY29uc3QgdG8gPSBqb2luKGRpcm5hbWUoaXRlbS5hYnMpLCBuZXh0KTtcbiAgICBpZiAodG8gPT09IGl0ZW0uYWJzKSByZXR1cm4geyBwYXRoOiB0bywgZnJvbTogaXRlbS5hYnMgfTtcbiAgICAvLyBBIGNhc2Utb25seSByZW5hbWUgb24gYSBjYXNlLWluc2Vuc2l0aXZlIGRpc2sgZmluZHMgXCJpdHNlbGZcIiBleGlzdGluZy5cbiAgICBpZiAodG8udG9Mb3dlckNhc2UoKSAhPT0gaXRlbS5hYnMudG9Mb3dlckNhc2UoKSkgdGhpcy5yZWZ1c2VFeGlzdGluZyh0byk7XG4gICAgdGhpcy5yZW5hbWVPckRpZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMuZm9sbG93TW92ZShpdGVtLmFicywgdG8pO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IHBhdGg6IHRvLCBmcm9tOiBpdGVtLmFicyB9O1xuICB9XG5cbiAgcHJpdmF0ZSByZW5hbWVPckRpZShmcm9tOiBzdHJpbmcsIHRvOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0cnkge1xuICAgICAgcmVuYW1lU3luYyhmcm9tLCB0byk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGNvZGUgPT09IFwiRVhERVZcIlxuICAgICAgICAgID8gYGNhbm5vdCBtb3ZlICR7ZnJvbX0gdG8gYW5vdGhlciBkaXNrICgke3RvfSkg4oCUIGNvcHkgaXQgaW5zdGVhZGBcbiAgICAgICAgICA6IGBjYW5ub3QgbW92ZSAke2Zyb219IHRvICR7dG99OiAke2NvZGUgPz8gU3RyaW5nKGUpfWAsXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFdoZXRoZXIgYGFic2AgaXMgc2hvd24gYW55d2hlcmUgaW4gdGhlIGNvbnRleHQgbm93LiAqL1xuICBwcml2YXRlIGl0ZW1BdChhYnM6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHRyeSB7XG4gICAgICB0aGlzLml0ZW1PckRpZShhYnMpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIiDigJQgbmV2ZXIgZnJvbSBkaXNrIChFMjQpLiAqL1xuICBoaWRlKHJhd1BhdGg6IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nOyBlbnRyeTogc3RyaW5nOyByZW1vdmVkRW50cnk6IGJvb2xlYW4gfSB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbU9yRGllKHJhd1BhdGgpO1xuICAgIGlmIChpdGVtLndob2xlKSB7XG4gICAgICB0aGlzLnJlbW92ZUNvbnRleHQoaXRlbS5lbnRyeS5pZCk7XG4gICAgICByZXR1cm4geyBwYXRoOiBpdGVtLmFicywgZW50cnk6IGl0ZW0uZW50cnkuaWQsIHJlbW92ZWRFbnRyeTogdHJ1ZSB9O1xuICAgIH1cbiAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKGl0ZW0uZW50cnkucm9vdCwgaXRlbS5hYnMpKTtcbiAgICBpdGVtLmVudHJ5LmhpZGRlbiA9IFsuLi4oaXRlbS5lbnRyeS5oaWRkZW4gPz8gW10pLmZpbHRlcigoaCkgPT4gaCAhPT0gcmVsKSwgcmVsXTtcbiAgICB0aGlzLnJlc2NhbihpdGVtLmVudHJ5LmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMuY2xvc2VPcnBoYW5lZE9wZW5Eb2MoKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4geyBwYXRoOiBpdGVtLmFicywgZW50cnk6IGl0ZW0uZW50cnkuaWQsIHJlbW92ZWRFbnRyeTogZmFsc2UgfTtcbiAgfVxuXG4gIHVuaGlkZShlbnRyeUlkOiBzdHJpbmcpOiB7IGVudHJ5OiBzdHJpbmc7IHJlc3RvcmVkOiBudW1iZXIgfSB7XG4gICAgY29uc3QgZSA9IHRoaXMubS5jb250ZXh0LmZpbmQoKHgpID0+IHguaWQgPT09IGVudHJ5SWQpO1xuICAgIGlmICghZSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBubyBjb250ZXh0IGVudHJ5ICR7ZW50cnlJZH1gLFxuICAgICAgICA0MDQsXG4gICAgICAgIHRoaXMubS5jb250ZXh0Lm1hcCgoeCkgPT4geC5pZCksXG4gICAgICApO1xuICAgIGNvbnN0IHJlc3RvcmVkID0gZS5oaWRkZW4/Lmxlbmd0aCA/PyAwO1xuICAgIGRlbGV0ZSBlLmhpZGRlbjtcbiAgICB0aGlzLnJlc2NhbihlLmlkKTtcbiAgICB0aGlzLnJlbGluaygpO1xuICAgIHRoaXMucGVyc2lzdCgpO1xuICAgIHJldHVybiB7IGVudHJ5OiBlLmlkLCByZXN0b3JlZCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEUyMjogYSBzaW5nbGUgZG9jdW1lbnQgYmVjb21lcyBhIHNldCDigJQgYSBmb2xkZXIgbmFtZWQgZm9yIGl0IGJlc2lkZSBpdCwgdGhlXG4gICAqIGRvY3VtZW50IG1vdmVkIGluLCBhbmQgdGhlIGVudHJ5IChzYW1lIGlkKSBub3cgbWlycm9ycyB0aGF0IGZvbGRlci5cbiAgICovXG4gIG1ha2VTZXQocmF3UGF0aDogc3RyaW5nKTogeyBwYXRoOiBzdHJpbmc7IGZvbGRlcjogc3RyaW5nOyBlbnRyeTogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1PckRpZShyYXdQYXRoKTtcbiAgICBpZiAoaXRlbS5lbnRyeS5tZW1iZXJzaGlwICE9PSBcImxpc3RlZFwiIHx8IGl0ZW0uZGlyKVxuICAgICAgdGhyb3cgbmV3IFNlc3Npb25FcnJvcihcbiAgICAgICAgYCR7dGhpcy5kaXNwbGF5KGl0ZW0uYWJzKX0gaXMgYWxyZWFkeSBpbiBhIHNldCDigJQgbWFrZSBhIGZvbGRlciB0aGVyZSBpbnN0ZWFkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGl0ZW0uYWJzKTtcbiAgICBjb25zdCBzdGVtID0gYmFzZW5hbWUoaXRlbS5hYnMsIGV4dG5hbWUoaXRlbS5hYnMpKSB8fCBcIlVudGl0bGVkXCI7XG4gICAgY29uc3QgZm9sZGVyID0gam9pbihwYXJlbnQsIHRoaXMuZnJlZU5hbWUocGFyZW50LCBzdGVtLCB0cnVlKSk7XG4gICAgbWtkaXJTeW5jKGZvbGRlcik7XG4gICAgY29uc3QgdG8gPSBqb2luKGZvbGRlciwgYmFzZW5hbWUoaXRlbS5hYnMpKTtcbiAgICB0aGlzLnJlbmFtZU9yRGllKGl0ZW0uYWJzLCB0byk7XG4gICAgY29uc3QgZSA9IGl0ZW0uZW50cnk7XG4gICAgZS5tZW1iZXJzaGlwID0gXCJtaXJyb3JlZFwiO1xuICAgIGUucm9vdCA9IGZvbGRlcjtcbiAgICBlLmxhYmVsID0gYmFzZW5hbWUoZm9sZGVyKTtcbiAgICBlLm5vZGVzID0gW107XG4gICAgdGhpcy5mb2xsb3dNb3ZlKGl0ZW0uYWJzLCB0byk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogdG8sIGZvbGRlciwgZW50cnk6IGUuaWQgfTtcbiAgfVxuXG4gIC8qKiBUaGUgbW9zdCB0ZXh0IG9uZSBpbXBvcnQgY2FycmllcyDigJQgYSBkb2N1bWVudCwgbm90IGEgZGF0YSBkdW1wLiAqL1xuICBzdGF0aWMgcmVhZG9ubHkgSU1QT1JUX01BWF9CWVRFUyA9IDggKiAxMDI0ICogMTAyNDtcblxuICAvKipcbiAgICogRTIzJ3MgZHJvcDogYSBDT1BZIG9mIGEgZmlsZSdzIHRleHQsIHdyaXR0ZW4gdW5kZXIgYSBmcmVlIG5hbWUgaW50byBgaW50b2BcbiAgICogKGRlZmF1bHQ6IHRoZSB3b3Jrc3BhY2UpLCB0aGVuIHNob3duIGxpa2UgYW55IG90aGVyIGRvY3VtZW50LlxuICAgKi9cbiAgaW1wb3J0VGV4dChuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgcmF3SW50bz86IHN0cmluZyk6IHsgcGF0aDogc3RyaW5nIH0ge1xuICAgIGNvbnN0IGZpbGUgPSB0aGlzLm5hbWVPckRpZShuYW1lKTtcbiAgICBpZiAoIWlzRG9jTmFtZShmaWxlKSlcbiAgICAgIHRocm93IG5ldyBTZXNzaW9uRXJyb3IoXG4gICAgICAgIGBub3QgYSBkb2N1bWVudCBTY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2ZpbGV9YCxcbiAgICAgICAgNDAwLFxuICAgICAgICBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgKTtcbiAgICBpZiAoQnVmZmVyLmJ5dGVMZW5ndGgodGV4dCkgPiBTZXNzaW9uLklNUE9SVF9NQVhfQllURVMpXG4gICAgICB0aHJvdyBuZXcgU2Vzc2lvbkVycm9yKFxuICAgICAgICBgJHtmaWxlfSBpcyBsYXJnZXIgdGhhbiAke1Nlc3Npb24uSU1QT1JUX01BWF9CWVRFUyAvIDEwMjQgLyAxMDI0fSBNQiDigJQgbm90IGltcG9ydGVkYCxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICBjb25zdCBkaXIgPSB0aGlzLmRlc3RpbmF0aW9uT3JEaWUocmF3SW50byA/PyB0aGlzLndvcmtzcGFjZSk7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIHRoaXMuZnJlZU5hbWUoZGlyLCBmaWxlLCBmYWxzZSkpO1xuICAgIHdyaXRlRmlsZVN5bmMoYWJzLCB0ZXh0LCB7IGZsYWc6IFwid3hcIiB9KTtcbiAgICB0aGlzLmFkb3B0TmV3KGFicyk7XG4gICAgdGhpcy5wZXJzaXN0KCk7XG4gICAgcmV0dXJuIHsgcGF0aDogYWJzIH07XG4gIH1cblxuICAvLyDilIDilIAgY2hhdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhZGRNZXNzYWdlKFxuICAgIHdobzogQ2hhdFdobyxcbiAgICB0ZXh0OiBzdHJpbmcsXG4gICAgZXh0cmE6IHsgc2VsZWN0aW9uPzogU2VsZWN0aW9uIHwgbnVsbDsgYWN0aXZlUGF0aD86IHN0cmluZyB8IG51bGwgfSA9IHt9LFxuICApOiBDaGF0TWVzc2FnZSB7XG4gICAgY29uc3QgbXNnOiBDaGF0TWVzc2FnZSA9IHsgaWQ6IGBtLSR7cmFuZEhleCg0KX1gLCB3aG8sIHRleHQsIHRzOiBEYXRlLm5vdygpLCAuLi5leHRyYSB9O1xuICAgIHRoaXMubS5jaGF0LnB1c2gobXNnKTtcbiAgICB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gbXNnO1xuICB9XG5cbiAgLy8g4pSA4pSAIHZpZXdzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGRvY1ZpZXcoZDogRG9jUmVjb3JkKTogRG9jVmlldyB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNsdWc6IGQuc2x1ZyxcbiAgICAgIG5hbWU6IGQubmFtZSxcbiAgICAgIG9yaWdpbmFsOiBkLm9yaWdpbmFsLFxuICAgICAgZW50cnlJZDogZC5lbnRyeUlkLFxuICAgICAgcmVsOiBkLnJlbCxcbiAgICAgIHZlcnNpb25zOiBkLnZlcnNpb25zLm1hcCgodikgPT4gKHsgLi4udiwgcGF0aDogdGhpcy52ZXJzaW9uUGF0aChkLCB2Lm4pIH0pKSxcbiAgICAgIGFjdGl2ZTogZC5hY3RpdmUsXG4gICAgICBkaXJ0eTogdGhpcy5pc0RpcnR5KGQpLFxuICAgICAgb3V0c2lkZUNoYW5nZWQ6IGQub3V0c2lkZUNoYW5nZWQsXG4gICAgfTtcbiAgfVxuXG4gIGRvYyhzbHVnOiBzdHJpbmcpOiBEb2NWaWV3IHtcbiAgICByZXR1cm4gdGhpcy5kb2NWaWV3KHRoaXMuZG9jT3JEaWUoc2x1ZykpO1xuICB9XG5cbiAgLyoqIFRoZSBzZXNzaW9uJ3MgaGFsZiBvZiBgUHVibGljU3RhdGVgOyB0aGUgZGFlbW9uIGFkZHMgdGhlIGhvbWUtbGV2ZWwgYHByZWZzYCBhbmQgYHVzZXJIb21lYC4gKi9cbiAgdmlldyhcbiAgICBtb2RlOiBcImRldlwiIHwgXCJyZWxlYXNlXCIsXG4gICAgc2VsZWN0aW9uOiBTZWxlY3Rpb24gfCBudWxsLFxuICApOiBPbWl0PFB1YmxpY1N0YXRlLCBcInByZWZzXCIgfCBcInVzZXJIb21lXCI+IHtcbiAgICByZXR1cm4ge1xuICAgICAgc2Vzc2lvbklkOiB0aGlzLm0uc2Vzc2lvbklkLFxuICAgICAgaG9tZTogdGhpcy5ob21lLFxuICAgICAgd29ya3NwYWNlOiB0aGlzLndvcmtzcGFjZSxcbiAgICAgIG1vZGUsXG4gICAgICBjb250ZXh0OiB0aGlzLm0uY29udGV4dCxcbiAgICAgIGRvY3M6IHRoaXMubS5kb2NzLm1hcCgoZCkgPT4gdGhpcy5kb2NWaWV3KGQpKSxcbiAgICAgIG9wZW5Eb2M6IHRoaXMubS5vcGVuRG9jLFxuICAgICAgc2VsZWN0aW9uLFxuICAgICAgY2hhdDogdGhpcy5tLmNoYXQsXG4gICAgfTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBcURBLHlCQUF5QiwyQkFBYyx5QkFBVTtBQUNqRCxvQkFBUztBQUNULHFC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
