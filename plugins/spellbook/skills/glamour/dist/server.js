// @bun
var __require = import.meta.require;

// src/glamour/backend/server.ts
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync as writeFileSync3
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join as join3 } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";

// plugins/spellbook/skills/glamour/shared/types.ts
var AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "item.add",
  "message.user",
  "closed"
]);
function defaultStyleGuide() {
  return [
    {
      key: "understanding",
      label: "Understanding",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "direction",
      label: "Direction",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "palette",
      label: "Palette",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "consistency",
      label: "Consistency",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "prompts",
      label: "Re-cast prompts",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    },
    {
      key: "canonical",
      label: "Canonical images",
      status: "empty",
      content: "",
      prompts: [],
      colors: []
    }
  ];
}
function defaultState(title, intent) {
  return {
    title,
    intent,
    library: [],
    selectedIds: [],
    messages: [],
    styleGuide: defaultStyleGuide(),
    tray: [],
    scope: "all",
    focusSet: [],
    focusOwner: null,
    focusNote: "",
    status: { busy: false, text: "" }
  };
}

// src/glamour/backend/persist.server.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
var EXT_BY_MIME = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};
function saveDataUrl(dir, id, dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !dir)
    return "";
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const body = m[3];
  const buf = m[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(dir, `${safeId}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, buf);
    return path;
  } catch {
    return "";
  }
}
function saveText(dir, id, name, text) {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || `${id}.md`;
  const path = join(dir, `${id}-${safe}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  } catch {
    return "";
  }
}
function materializeItem(filesDir, item) {
  if (item.src) {
    const p = saveDataUrl(filesDir, item.id, item.src);
    if (p)
      item.path = p;
  } else if (item.text) {
    const p = saveText(filesDir, item.id, item.title, item.text);
    if (p)
      item.path = p;
  }
}
function saveSnapshot(snapshotsDir, sessionId, state) {
  try {
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(join(snapshotsDir, `${sessionId}.json`), JSON.stringify(state));
  } catch {}
}
function loadSnapshot(path, title, intent) {
  const snap = JSON.parse(readFileSync(path, "utf8"));
  const merged = { ...defaultState(title, intent), ...snap };
  merged.styleGuide = merged.styleGuide.map((s) => ({
    ...s,
    prompts: s.prompts ?? [],
    colors: s.colors ?? []
  }));
  return merged;
}

// src/glamour/backend/reduce.ts
function makeItem(p) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    src: p.src ?? "",
    path: p.path ?? "",
    text: p.text ?? "",
    mime: p.mime ?? "",
    tags: p.tags ?? [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon: [],
    archived: false,
    createdAt: p.createdAt,
    gen: p.gen ?? null
  };
}
function addItem(state, item) {
  if (state.library.some((i) => i.id === item.id))
    return false;
  state.library.push(item);
  return true;
}
function selectItems(state, ids) {
  state.selectedIds = [...ids];
}
function setStar(state, id, starred) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.starred = starred;
  return true;
}
function setLike(state, id, liked) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.liked = liked;
  return true;
}
function annotate(state, id, who, text) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.annotations[who] = text;
  return true;
}
function addMessage(state, m) {
  state.messages.push(m);
}
function updateSection(state, key, patch) {
  const sec = state.styleGuide.find((s) => s.key === key);
  if (!sec)
    return false;
  if (patch.content !== undefined)
    sec.content = patch.content;
  if (patch.status !== undefined)
    sec.status = patch.status;
  if (patch.prompts !== undefined)
    sec.prompts = patch.prompts;
  if (patch.colors !== undefined)
    sec.colors = patch.colors;
  return true;
}
function setFocus(state, ids, owner, note = "") {
  state.scope = "focus";
  state.focusSet = [...ids];
  state.focusOwner = owner;
  state.focusNote = note;
}
function clearFocus(state) {
  state.scope = "all";
  state.focusSet = [];
  state.focusOwner = null;
  state.focusNote = "";
}
function setCanonical(state, id, canonical) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.canonical = canonical;
  return true;
}
function archiveTrayStyle(state, id, archived) {
  const st = state.tray.find((s) => s.id === id);
  if (!st)
    return false;
  st.archived = archived;
  return true;
}
function buildStyleItem(style, canon, createdAt) {
  return {
    id: `style-${style.id}`,
    kind: "style",
    title: style.label,
    src: "",
    path: "",
    text: style.text,
    mime: "",
    tags: [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon,
    archived: false,
    createdAt,
    gen: null
  };
}
function setItemArchived(state, id, archived) {
  const it = state.library.find((i) => i.id === id);
  if (!it)
    return false;
  it.archived = archived;
  return true;
}
function setGenCost(state, id, cost) {
  const it = state.library.find((i) => i.id === id);
  if (!it?.gen)
    return false;
  it.gen.cost = cost;
  return true;
}
function setGenMeta(state, id, patch) {
  const it = state.library.find((i) => i.id === id);
  if (!it?.gen)
    return false;
  if (typeof patch.prompt === "string")
    it.gen.prompt = patch.prompt;
  if (patch.custom)
    it.gen.custom = { ...it.gen.custom ?? {}, ...patch.custom };
  return true;
}
function leanItem(it) {
  const { src: _s, text: _t, canon: _c, ...rest } = it;
  return rest;
}
function leanState(s) {
  return { ...s, library: s.library.map(leanItem) };
}
var AMBIENT_CLIENT = new Set([
  "item.select",
  "item.star",
  "item.like",
  "focus.set",
  "focus.clear",
  "item.canonical",
  "item.archive",
  "item.annotate"
]);
function applyAgentMsg(state, msg) {
  switch (msg.type) {
    case "init":
      if (typeof msg.title === "string")
        state.title = msg.title;
      if (typeof msg.intent === "string")
        state.intent = msg.intent;
      break;
    case "intent":
      state.intent = msg.text;
      break;
    case "item.annotate": {
      const it = state.library.find((i) => i.id === msg.id);
      if (it)
        it.annotations.agent = msg.agent;
      break;
    }
    case "section":
      updateSection(state, msg.key, {
        content: msg.content,
        status: msg.status,
        prompts: msg.prompts,
        colors: msg.colors
      });
      break;
    case "focus.push":
      setFocus(state, msg.ids, "agent", msg.note ?? "");
      break;
    case "gen.cost":
      setGenCost(state, msg.id, msg.cost);
      break;
    case "gen.meta":
      setGenMeta(state, msg.id, { prompt: msg.prompt, custom: msg.custom });
      break;
    case "status":
      state.status = { busy: msg.busy, text: msg.text ?? "" };
      break;
    case "style.archive":
      archiveTrayStyle(state, msg.id, msg.archived);
      break;
    case "say":
    case "close":
      break;
    default:
      return false;
  }
  return true;
}

// src/glamour/backend/styles.server.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { basename, join as join2 } from "path";
var EXT_BY_MIME2 = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};
function projectKey(projectDir) {
  const base = basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  let h = 5381;
  for (let i = 0;i < projectDir.length; i++)
    h = (h << 5) + h + projectDir.charCodeAt(i) >>> 0;
  return `${base}-${h.toString(36)}`;
}
function stylesDir(home, key) {
  return join2(home, "styles", key);
}
function saveStyle(home, key, args) {
  const dir = stylesDir(home, key);
  mkdirSync2(dir, { recursive: true });
  const canonical = [];
  for (const it of args.canonicalItems) {
    if (!it.path || !existsSync(it.path))
      continue;
    const ext = EXT_BY_MIME2[it.mime] ?? "bin";
    const file = `${args.id}-${it.id}.${ext}`;
    try {
      writeFileSync2(join2(dir, file), readFileSync2(it.path));
      canonical.push({ id: it.id, title: it.title, file, mime: it.mime });
    } catch {}
  }
  const style = {
    id: args.id,
    label: args.label,
    text: args.text,
    sections: args.sections,
    canonical,
    createdAt: args.createdAt,
    archived: false
  };
  writeFileSync2(join2(dir, `${args.id}.json`), JSON.stringify(style));
  return style;
}
function loadTray(home, key) {
  const dir = stylesDir(home, key);
  if (!existsSync(dir))
    return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json"))
      continue;
    try {
      out.push(JSON.parse(readFileSync2(join2(dir, name), "utf8")));
    } catch {}
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
function setStyleArchived(home, key, id, archived) {
  const path = join2(stylesDir(home, key), `${id}.json`);
  if (!existsSync(path))
    return false;
  try {
    const style = JSON.parse(readFileSync2(path, "utf8"));
    style.archived = archived;
    writeFileSync2(path, JSON.stringify(style));
    return true;
  } catch {
    return false;
  }
}
function materializeCanon(home, key, style) {
  const dir = stylesDir(home, key);
  const out = [];
  for (const ref of style.canonical) {
    try {
      const bytes = readFileSync2(join2(dir, ref.file));
      out.push({
        title: ref.title,
        src: `data:${ref.mime};base64,${bytes.toString("base64")}`
      });
    } catch {}
  }
  return out;
}

// src/glamour/backend/server.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join3(SCRIPT_DIR, "..");
var DIST_DIR = join3(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync2(join3(DIST_DIR, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function serveDist(path) {
  const rel = path === "/" ? "index.html" : path.slice(1);
  if (rel.includes("..") || rel.includes("/"))
    return null;
  const file = join3(DIST_DIR, rel);
  if (!existsSync2(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
}
var enc = new TextEncoder;
var randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
async function startDaemon(opts) {
  const GLAMOUR_HOME = process.env.GLAMOUR_HOME ?? join3(homedir(), ".glamour");
  const SNAPSHOTS_DIR = join3(GLAMOUR_HOME, "snapshots");
  let state = defaultState(opts.title ?? "", opts.intent ?? "");
  let restored = false;
  if (opts.restore) {
    const path = existsSync2(opts.restore) ? opts.restore : join3(SNAPSHOTS_DIR, `${opts.restore}.json`);
    try {
      state = loadSnapshot(path, opts.title ?? "", opts.intent ?? "");
      restored = true;
    } catch (e) {
      process.stderr.write(`glamour: restore failed (${path}): ${e}
`);
    }
  }
  const PROJECT_KEY = projectKey(opts.project ?? process.cwd());
  const mode = resolveMode();
  const devIndex = mode === "dev" ? (await import("../../../../../src/glamour/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  state.tray = loadTray(GLAMOUR_HOME, PROJECT_KEY);
  const sockets = new Set;
  const events = [];
  let eventSeq = 0;
  const sseClients = new Set;
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  const broadcast = (msg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {}
    }
  };
  let snapDirty = false;
  const broadcastState = () => {
    snapDirty = true;
    broadcast({ type: "state", state });
  };
  const emitEvent = (msg) => {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    const frame = enc.encode(`data: ${JSON.stringify(ev)}

`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {}
    }
  };
  const emitTransient = (msg) => {
    const frame = enc.encode(`data: ${JSON.stringify(msg)}

`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {}
    }
  };
  const sessionId = `glamour-${randHex(4)}`;
  const sessionFilesDir = join3(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync3(sessionFilesDir, { recursive: true });
  } catch {}
  if (restored) {
    for (const it of state.library)
      materializeItem(sessionFilesDir, it);
  }
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const handleAgentMsg = (msg) => {
    if (msg.type === "say") {
      addMessage(state, {
        id: `m-${randHex(4)}`,
        who: "agent",
        kind: msg.kind ?? "info",
        text: msg.text,
        ground: [],
        ts: Date.now()
      });
      broadcastState();
      return true;
    }
    if (msg.type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return true;
    }
    if (msg.type === "gen.add") {
      const it = makeItem({
        id: `gen-${randHex(4)}`,
        kind: "gen",
        title: msg.label ?? `round ${msg.round}`,
        src: msg.src,
        mime: "image/webp",
        createdAt: Date.now(),
        gen: {
          model: msg.model,
          prompt: msg.prompt,
          seed: msg.seed ?? null,
          cost: msg.cost ?? null,
          custom: msg.custom ?? {},
          round: msg.round
        }
      });
      materializeItem(sessionFilesDir, it);
      const added = addItem(state, it);
      if (added)
        broadcastState();
      return {
        recognised: true,
        ok: true,
        detail: { id: it.id, outcome: added ? "created" : "already-recorded" }
      };
    }
    if (msg.type === "style.save") {
      const canonicalItems = state.library.filter((i) => i.canonical && !i.archived);
      const agreed = state.styleGuide.filter((s) => s.status !== "empty" && s.content);
      const text = agreed.map((s) => s.content).join(" \xB7 ").slice(0, 280);
      const style = saveStyle(GLAMOUR_HOME, PROJECT_KEY, {
        id: `style-${randHex(4)}`,
        label: msg.label,
        text,
        sections: state.styleGuide,
        canonicalItems,
        createdAt: Date.now()
      });
      state.tray.push(style);
      broadcastState();
      return true;
    }
    if (msg.type === "style.archive") {
      setStyleArchived(GLAMOUR_HOME, PROJECT_KEY, msg.id, msg.archived);
      applyAgentMsg(state, msg);
      broadcastState();
      return true;
    }
    const recognised = applyAgentMsg(state, msg);
    if (recognised)
      broadcastState();
    return recognised;
  };
  const handleClientMsg = (msg) => {
    switch (msg.type) {
      case "item.add": {
        const it = makeItem({
          id: `${msg.item.kind}-${randHex(4)}`,
          kind: msg.item.kind,
          title: msg.item.title,
          src: msg.item.src,
          text: msg.item.text,
          mime: msg.item.mime ?? "",
          createdAt: Date.now()
        });
        materializeItem(sessionFilesDir, it);
        if (addItem(state, it)) {
          broadcastState();
          emitEvent({
            type: "item.add",
            item: leanItem(it),
            selectedIds: state.selectedIds
          });
        }
        break;
      }
      case "item.select":
        selectItems(state, msg.ids);
        broadcastState();
        break;
      case "item.star":
        if (setStar(state, msg.id, msg.starred))
          broadcastState();
        break;
      case "item.like":
        if (setLike(state, msg.id, msg.liked))
          broadcastState();
        break;
      case "item.annotate":
        if (annotate(state, msg.id, "human", msg.human))
          broadcastState();
        break;
      case "message.send": {
        const ground = [...state.selectedIds];
        addMessage(state, {
          id: `m-${randHex(4)}`,
          who: "user",
          kind: "info",
          text: msg.text,
          ground,
          ts: Date.now()
        });
        broadcastState();
        emitEvent({ type: "message.user", text: msg.text, ground });
        break;
      }
      case "focus.set":
        setFocus(state, msg.ids, "you");
        broadcastState();
        break;
      case "focus.clear":
        clearFocus(state);
        broadcastState();
        break;
      case "item.canonical":
        if (setCanonical(state, msg.id, msg.canonical))
          broadcastState();
        break;
      case "item.archive":
        if (setItemArchived(state, msg.id, msg.archived))
          broadcastState();
        break;
      case "style.bringIn": {
        const style = state.tray.find((s) => s.id === msg.id);
        if (!style)
          break;
        const itemId = `style-${style.id}`;
        if (state.library.some((i) => i.id === itemId))
          break;
        const canon = materializeCanon(GLAMOUR_HOME, PROJECT_KEY, style);
        const it = buildStyleItem(style, canon, Date.now());
        if (addItem(state, it)) {
          broadcastState();
          emitEvent({ type: "item.add", item: leanItem(it), selectedIds: state.selectedIds });
        }
        break;
      }
    }
  };
  const sseResponse = (url) => {
    touch();
    const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
    let ref = null;
    let hb = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if (ev.id > since)
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}

`));
        }
        sseClients.add(controller);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb

`));
          } catch {}
        }, 15000);
      },
      cancel() {
        if (hb)
          clearInterval(hb);
        if (ref)
          sseClients.delete(ref);
      }
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  };
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.host ?? "127.0.0.1",
    routes,
    idleTimeout: 255,
    development: { hmr: mode === "dev" },
    fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/ws")
        return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
      if (req.method === "GET" && path === "/state") {
        touch();
        const lean = url.searchParams.get("lean") === "1";
        return Response.json({
          state: lean ? leanState(state) : state,
          cursor: eventSeq
        });
      }
      if (req.method === "GET" && path === "/events")
        return sseResponse(url);
      if (req.method === "POST" && path === "/cmd")
        return req.json().then((b) => {
          touch();
          const verdict = handleAgentMsg(b);
          if (typeof verdict === "object")
            return Response.json({ ok: true, applied: true, ...verdict.detail });
          const applied = verdict;
          if (!applied) {
            return Response.json({
              ok: false,
              applied: false,
              error: `unrecognised command type ${JSON.stringify(b?.type)} \u2014 nothing was applied`
            }, { status: 400 });
          }
          return Response.json({ ok: true, applied: true });
        }).catch(() => Response.json({ error: "bad json" }, { status: 400 }));
      if (req.method === "GET" && path.startsWith("/assets/")) {
        const name = decodeURIComponent(path.slice("/assets/".length));
        if (name.includes("..") || name.startsWith("/"))
          return Response.json({ error: "not found" }, { status: 404 });
        const f = Bun.file(join3(sessionFilesDir, name));
        return f.exists().then((ok) => ok ? new Response(f) : Response.json({ error: "not found" }, { status: 404 }));
      }
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
        emitTransient({ type: "connected" });
        ws.send(JSON.stringify({ type: "state", state }));
      },
      message(_ws, raw) {
        touch();
        try {
          handleClientMsg(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
        } catch (e) {
          process.stderr.write(`glamour: bad json from browser: ${e}
`);
        }
      },
      close(ws) {
        sockets.delete(ws);
        emitTransient({ type: "disconnected" });
      }
    }
  });
  const boundPort = server.port;
  const sessionFile = join3(tmpdir(), `glamour-${sessionId}.json`);
  const latestFile = join3(tmpdir(), `glamour-latest.json`);
  const info = JSON.stringify({
    url: `http://${opts.host ?? "127.0.0.1"}:${boundPort}`,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
    mode
  });
  const writeAtomic = (target, text) => {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync3(tmp, text);
      renameSync(tmp, target);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      throw new Error(`could not publish ${target}`);
    }
  };
  try {
    writeAtomic(sessionFile, info);
    writeAtomic(latestFile, info);
  } catch {}
  emitEvent({ type: "ready", mode });
  const saveNow = () => saveSnapshot(SNAPSHOTS_DIR, sessionId, state);
  if (restored)
    saveNow();
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveNow();
    }
  }, 1000);
  const timeoutS = opts.timeoutS ?? 1800;
  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeoutS)
      resolveDone({ code: 124, reason: "timeout" });
  }, 250);
  let closed = false;
  let resolveShutdown;
  const shutdown = new Promise((r) => {
    resolveShutdown = r;
  });
  const close = () => {
    if (closed)
      return;
    closed = true;
    clearInterval(snapTimer);
    clearInterval(idleTimer);
    saveNow();
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      const raw = readFileSync3(latestFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.session_id === sessionId)
        unlinkSync(latestFile);
    } catch {}
    try {
      rmSync(sessionFilesDir, { recursive: true, force: true });
    } catch {}
    emitEvent({ type: "closed" });
    for (const c of sseClients) {
      try {
        c.close();
      } catch {}
    }
    sseClients.clear();
    setTimeout(() => {
      server.stop(true);
      resolveShutdown();
    }, 50);
  };
  done.then(() => close());
  return { port: boundPort, sessionId, mode, close, done, shutdown };
}
var DAEMON_OPTIONS = {
  intent: { type: "string" },
  port: { type: "string" },
  project: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" }
};
async function main(argv) {
  let flags;
  try {
    flags = nodeParseArgs({ args: argv, options: DAEMON_OPTIONS, strict: true }).values;
  } catch (e) {
    process.stderr.write(`glamour: ${e instanceof Error ? e.message : String(e)}
  recognized flags: ${Object.keys(DAEMON_OPTIONS).map((k) => `--${k}`).join(" ")}
`);
    return 2;
  }
  const d = await startDaemon({
    port: flags.port ? Number(flags.port) : 0,
    title: flags.title,
    intent: flags.intent,
    restore: flags.restore,
    timeoutS: flags.timeout ? Number(flags.timeout) : undefined,
    project: flags.project
  });
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId, mode: d.mode })}
`);
  const res = await d.done;
  await d.shutdown;
  return res.code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  startDaemon,
  run,
  resolveMode,
  main
};

//# debugId=76FF5F070D1DBEC564756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zZXJ2ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9nbGFtb3VyL2JhY2tlbmQvcGVyc2lzdC5zZXJ2ZXIudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9yZWR1Y2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9zdHlsZXMuc2VydmVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgImltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZW5hbWVTeW5jLFxuICBybVN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBBZ2VudENvbW1hbmQsXG4gIHR5cGUgQ2xpZW50VG9TZXJ2ZXIsXG4gIGRlZmF1bHRTdGF0ZSxcbiAgdHlwZSBHbGFtb3VyU3RhdGUsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvdHlwZXNcIjtcbmltcG9ydCB7IGxvYWRTbmFwc2hvdCwgbWF0ZXJpYWxpemVJdGVtLCBzYXZlU25hcHNob3QgfSBmcm9tIFwiLi9wZXJzaXN0LnNlcnZlclwiO1xuaW1wb3J0IHtcbiAgYWRkSXRlbSxcbiAgYWRkTWVzc2FnZSxcbiAgYW5ub3RhdGUsXG4gIGFwcGx5QWdlbnRNc2csXG4gIGJ1aWxkU3R5bGVJdGVtLFxuICBjbGVhckZvY3VzLFxuICBsZWFuSXRlbSxcbiAgbGVhblN0YXRlLFxuICBtYWtlSXRlbSxcbiAgc2VsZWN0SXRlbXMsXG4gIHNldENhbm9uaWNhbCxcbiAgc2V0Rm9jdXMsXG4gIHNldEl0ZW1BcmNoaXZlZCxcbiAgc2V0TGlrZSxcbiAgc2V0U3Rhcixcbn0gZnJvbSBcIi4vcmVkdWNlXCI7XG5pbXBvcnQge1xuICBsb2FkVHJheSxcbiAgbWF0ZXJpYWxpemVDYW5vbixcbiAgcHJvamVjdEtleSxcbiAgc2F2ZVN0eWxlLFxuICBzZXRTdHlsZUFyY2hpdmVkLFxufSBmcm9tIFwiLi9zdHlsZXMuc2VydmVyXCI7XG5cbi8vIFRoZSBzdXJmYWNlJ3MgSFRNTCBlbnRyeSB1c2VkIHRvIGJlIGEgdG9wLWxldmVsIHN0YXRpYyBpbXBvcnQgaGVyZS4gQSBzdGF0aWNcbi8vIGltcG9ydCBmb3JjZXMgQnVuIHRvIHJlc29sdmUgdGhlIHdob2xlIC50c3ggKyBUYWlsd2luZCBncmFwaCB3aGVuIHRoaXMgbW9kdWxlXG4vLyBMT0FEUywgc28gYSBkZXN0aW5hdGlvbiB0aGF0IHNoaXBzIGRpc3QvIGFuZCBubyBzdXJmYWNlIHNvdXJjZSDigJQgdGhlIHB1Ymxpc2hlZFxuLy8gYXJ0aWZhY3Qg4oCUIGRpZXMgYmVmb3JlIGl0IGNhbiBzZXJ2ZSB0aGUgZGlzdCBpdCBkb2VzIGhhdmUuIFRoZSBkZXYgaW1wb3J0IGlzXG4vLyB0aGVyZWZvcmUgZHluYW1pYyBhbmQgcmVhY2hlZCBvbmx5IG9uIHRoZSBkZXYgYnJhbmNoIGJlbG93IChzZWFtcyBDb250cmFjdCAxKSxcbi8vIGFzIGFzdHJvbGFiZSwgaW1hZ28gYW5kIG1pbmQtbWFwcGVyIGRvIGl0LlxuLy9cbi8vIFBhdGhzIGFuY2hvciBhdCB0aGUgU0tJTEwgUk9PVCwgbmV2ZXIgYXQgY3dkOiBjbGkudHMgcGlucyB0aGUgZGFlbW9uJ3MgY3dkIGZvclxuLy8gYnVuZmlnLnRvbWwncyBzYWtlIGluIGRldiAoQ29udHJhY3QgNSksIHNvIGN3ZCBpcyBub3QgYSBzdGFibGUgYmFzZSBmb3IgZGlzdC8uXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8vIHJlbGVhc2UgaWZmIGRpc3QvaW5kZXguaHRtbCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Qg4oCUIHRoZSBGSUxFLCBuZXZlciB0aGVcbi8vIGRpcmVjdG9yeSAoYSBidWlsdCBiYWNrZW5kIGNhbiBwdXQgY2xpLmpzIGluIGRpc3QvIHdpdGggbm8gc3VyZmFjZSB0aGVyZSkg4oCUXG4vLyBlbHNlIGRldjsgdGhlIGVudiBvdmVycmlkZSB3aW5zIGVpdGhlciB3YXkgKENvbnRyYWN0IDEpLiBSZWxlYXNlOiB6ZXJvIHJlYWRzXG4vLyBvZiBzdXJmYWNlIHNvdXJjZSBvciBidW5maWcudG9tbCDigJQgc3RhdGljIGZpbGVzIG9ubHkuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbmNvbnN0IFNUQVRJQ19DT05URU5UX1RZUEVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sXCIsXG4gIFwiLmpzXCI6IFwidGV4dC9qYXZhc2NyaXB0XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzXCIsXG4gIFwiLmpzb25cIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG4vLyBTZXJ2ZXMgZGlzdC8gdmVyYmF0aW0g4oCUIGVudHJ5IGluZGV4Lmh0bWwsIGhhc2hlZCBjaHVuay0qLmpzL2NzcyBieSBwYXRoXG4vLyAoQ29udHJhY3QgMidzIGZsYXQsIHJlbGF0aXZlLWhyZWYgbGF5b3V0KS4gQSBzdGF0aWMgYXNzZXQgcmVxdWVzdCBpcyBhbHdheXMgYVxuLy8gYmFyZSBmaWxlbmFtZSwgbmV2ZXIgbmVzdGVkOiB0aGUgZ3VhcmQgaXMgd2hhdCBrZWVwcyB0aGlzIG9uZSBsZXZlbCBkZWVwIGFuZFxuLy8gZGlzam9pbnQgZnJvbSBnbGFtb3VyJ3Mgb3duIEdFVCAvYXNzZXRzLzxuYW1lPiBzZXNzaW9uLWZpbGVzIHJvdXRlIGFib3ZlIGl0XG4vLyAoZXZlcnkgL2Fzc2V0cy8gcGF0aCBpcyBuZXN0ZWQsIHNvIGl0IGlzIHJlZnVzZWQgaGVyZSBhbmQgZmFsbHMgdGhyb3VnaCkuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgY29uc3QgcmVsID0gcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSk7XG4gIGlmIChyZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oRElTVF9ESVIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGV4dCA9IHJlbC5zbGljZShyZWwubGFzdEluZGV4T2YoXCIuXCIpKTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwge1xuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiIH0sXG4gIH0pO1xufVxuXG5jb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKTtcbmNvbnN0IHJhbmRIZXggPSAobjogbnVtYmVyKSA9PlxuICBBcnJheS5mcm9tKGNyeXB0by5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkobikpKVxuICAgIC5tYXAoKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSlcbiAgICAuam9pbihcIlwiKTtcblxuZXhwb3J0IHR5cGUgU3RhcnRPcHRzID0ge1xuICBwb3J0PzogbnVtYmVyO1xuICBob3N0Pzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgaW50ZW50Pzogc3RyaW5nO1xuICByZXN0b3JlPzogc3RyaW5nO1xuICB0aW1lb3V0Uz86IG51bWJlcjtcbiAgcHJvamVjdD86IHN0cmluZztcbn07XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydERhZW1vbihvcHRzOiBTdGFydE9wdHMpIHtcbiAgY29uc3QgR0xBTU9VUl9IT01FID0gcHJvY2Vzcy5lbnYuR0xBTU9VUl9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5nbGFtb3VyXCIpO1xuICBjb25zdCBTTkFQU0hPVFNfRElSID0gam9pbihHTEFNT1VSX0hPTUUsIFwic25hcHNob3RzXCIpO1xuICBsZXQgc3RhdGU6IEdsYW1vdXJTdGF0ZSA9IGRlZmF1bHRTdGF0ZShvcHRzLnRpdGxlID8/IFwiXCIsIG9wdHMuaW50ZW50ID8/IFwiXCIpO1xuICBsZXQgcmVzdG9yZWQgPSBmYWxzZTtcbiAgaWYgKG9wdHMucmVzdG9yZSkge1xuICAgIGNvbnN0IHBhdGggPSBleGlzdHNTeW5jKG9wdHMucmVzdG9yZSlcbiAgICAgID8gb3B0cy5yZXN0b3JlXG4gICAgICA6IGpvaW4oU05BUFNIT1RTX0RJUiwgYCR7b3B0cy5yZXN0b3JlfS5qc29uYCk7XG4gICAgdHJ5IHtcbiAgICAgIHN0YXRlID0gbG9hZFNuYXBzaG90KHBhdGgsIG9wdHMudGl0bGUgPz8gXCJcIiwgb3B0cy5pbnRlbnQgPz8gXCJcIik7XG4gICAgICByZXN0b3JlZCA9IHRydWU7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGdsYW1vdXI6IHJlc3RvcmUgZmFpbGVkICgke3BhdGh9KTogJHtlfVxcbmApO1xuICAgIH1cbiAgfVxuICBjb25zdCBQUk9KRUNUX0tFWSA9IHByb2plY3RLZXkob3B0cy5wcm9qZWN0ID8/IHByb2Nlc3MuY3dkKCkpO1xuICAvLyAtLS0gbW9kZSwgcmVzb2x2ZWQgQkVGT1JFIGFueSBmaWxlc3lzdGVtIHdyaXRlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIEEgZm9yY2VkLWRldiBib290IGF0IGEgc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG11c3QgZGllIEhFUkUsIGF0IHRoZSBpbXBvcnQsXG4gIC8vIGhhdmluZyB3cml0dGVuIG5vdGhpbmc6IG5vIHNlc3Npb24tZmlsZXMgZGlyLCBubyBkaXNjb3ZlcnkgcG9pbnRlci4gTWVhc3VyZWRcbiAgLy8gaW4gdGhlIGxvY2FsLXNpbTogd2l0aCB0aGlzIGJsb2NrIHBsYWNlZCBhZnRlciB0aGUgc2Vzc2lvbi1maWxlcyBta2RpciwgYVxuICAvLyBkeWluZyBkYWVtb24gbGVmdCBgJFRNUERJUi9nbGFtb3VyLTxpZD4tZmlsZXMvYCBiZWhpbmQgb24gZXZlcnkgZmFpbGVkIGJvb3QuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuICAvLyBkZXY6IHRoZSBkeW5hbWljIHN0cmluZy1saXRlcmFsIGltcG9ydCBrZWVwcyB0aGUgc3VyZmFjZSBncmFwaCBvZmYgdGhlIG1vZHVsZVxuICAvLyBsb2FkIHBhdGggKENvbnRyYWN0IDEpIOKAlCBCdW4gYnVuZGxlcyB0aGUgLnRzeCBncmFwaCArIFRhaWx3aW5kIGF0IHNlcnZlIHRpbWUsXG4gIC8vIHJlYWRpbmcgYnVuZmlnLnRvbWwgZnJvbSBjd2QsIHdoaWNoIGNsaS50cyBwaW5zIHRvIHNyYy9nbGFtb3VyLyAoQ29udHJhY3QgNSkuXG4gIC8vIHJlbGVhc2U6IGRpc3QvIGlzIHN0YXRpYyBhbmQgcHJlLWJ1aWx0IChDb250cmFjdCAyKSDigJQgXCIvXCIgaXMgYW5zd2VyZWQgYnlcbiAgLy8gc2VydmVEaXN0KCkgaW4gdGhlIGZldGNoIGZhbGwtdGhyb3VnaCwgc28gdGhpcyBicmFuY2ggbmV2ZXIgdG91Y2hlcyBzdXJmYWNlXG4gIC8vIHNvdXJjZSBvciBidW5maWcudG9tbCBhbmQgbmV2ZXIgbmVlZHMgZWl0aGVyIHRvIGV4aXN0LiBCdW4ncyBSb3V0ZXMgdHlwZSB0aWVzXG4gIC8vIHRoZSBcIi9cIiB2YWx1ZSdzIHR5cGUgdG8gdGhlIGxpdGVyYWwgb2JqZWN0IHNoYXBlLCBzbyB0aGUgbW9kZS10ZXJuYXJ5IHVuaW9uXG4gIC8vIGlzIGNhc3Q7IHRoZSBydW50aW1lIGJlaGF2aW91ciAoSFRNTEJ1bmRsZSBpbiBkZXYsIGFic2VudCBpbiByZWxlYXNlKSBpc1xuICAvLyBjb3JyZWN0IGVpdGhlciB3YXkuIFRoaXMgaXMgdGhlIE9ORSBzcmMvLW5hbWluZyBzcGVjaWZpZXIgaW4gdGhlIGRlcGxveWVkXG4gIC8vIHNwZWxsIChwbGFuIFMyLCByYXRpZmllZCBhdCB0aGUgc3BlY2lmaWVyIGdyYWluKS5cbiAgY29uc3QgZGV2SW5kZXggPVxuICAgIG1vZGUgPT09IFwiZGV2XCJcbiAgICAgID8gKGF3YWl0IGltcG9ydChcIi4uLy4uLy4uLy4uLy4uL3NyYy9nbGFtb3VyL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuICAvLyBMb2FkIHRoZSBwcm9qZWN0J3Mgc2F2ZWQgc3R5bGVzIGludG8gdGhlIHRyYXkgKG1ldGFkYXRhIG9ubHkg4oCUIE5PVCB0aGVcbiAgLy8gbGlicmFyeSkuIERvIHRoaXMgYWZ0ZXIgcmVzdG9yZSBzbyBhIHJlc3RvcmVkIHNuYXBzaG90J3Mgc3RhbGUgdHJheSBpc1xuICAvLyByZXBsYWNlZCBieSB0aGUgYXV0aG9yaXRhdGl2ZSBvbi1kaXNrIHNldC5cbiAgc3RhdGUudHJheSA9IGxvYWRUcmF5KEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVkpO1xuXG4gIC8vIC0tLSBjaGFubmVscyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc29ja2V0cyA9IG5ldyBTZXQ8aW1wb3J0KFwiYnVuXCIpLlNlcnZlcldlYlNvY2tldDx1bmtub3duPj4oKTtcbiAgY29uc3QgZXZlbnRzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgbGV0IGV2ZW50U2VxID0gMDtcbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8UmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlcj4oKTtcbiAgbGV0IGxhc3RBY3Rpdml0eSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICBjb25zdCB0b3VjaCA9ICgpID0+IHtcbiAgICBsYXN0QWN0aXZpdHkgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgfTtcblxuICBjb25zdCBicm9hZGNhc3QgPSAobXNnOiBvYmplY3QpID0+IHtcbiAgICBjb25zdCBzID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcbiAgICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdzLnNlbmQocyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc29ja2V0IGNsb3NlZCAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcbiAgbGV0IHNuYXBEaXJ0eSA9IGZhbHNlO1xuICBjb25zdCBicm9hZGNhc3RTdGF0ZSA9ICgpID0+IHtcbiAgICBzbmFwRGlydHkgPSB0cnVlO1xuICAgIGJyb2FkY2FzdCh7IHR5cGU6IFwic3RhdGVcIiwgc3RhdGUgfSk7XG4gIH07XG4gIGNvbnN0IGVtaXRFdmVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZXYgPSB7IGlkOiArK2V2ZW50U2VxLCAuLi5tc2cgfTtcbiAgICBldmVudHMucHVzaChldik7XG4gICAgY29uc3QgZnJhbWUgPSBlbmMuZW5jb2RlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGV2KX1cXG5cXG5gKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYy5lbnF1ZXVlKGZyYW1lKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBnb25lICovXG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIFByZXNlbmNlIGlzIHRyYW5zaWVudDogc3RyZWFtIHRvIGxpdmUgU1NFIGNsaWVudHMgYnV0IERPIE5PVCBzdG9yZSBpdCBpblxuICAvLyB0aGUgcmVwbGF5IGxvZyAoYSByZWNvbm5lY3RpbmcgYWdlbnQgc2hvdWxkIG5vdCByZS1zZWUgZXZlcnkgcGFzdFxuICAvLyBjb25uZWN0L2Rpc2Nvbm5lY3QpLiBObyBpZCBpcyBhc3NpZ25lZCwgc28gaXQgbmV2ZXIgYWR2YW5jZXMgYSB0YWlsIGN1cnNvci5cbiAgY29uc3QgZW1pdFRyYW5zaWVudCA9IChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgY29uc3QgZnJhbWUgPSBlbmMuZW5jb2RlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KG1zZyl9XFxuXFxuYCk7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGMuZW5xdWV1ZShmcmFtZSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogZ29uZSAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICAvLyAtLS0gc2Vzc2lvbiBmaWxlcyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHNlc3Npb25JZCA9IGBnbGFtb3VyLSR7cmFuZEhleCg0KX1gO1xuICBjb25zdCBzZXNzaW9uRmlsZXNEaXIgPSBqb2luKHRtcGRpcigpLCBgJHtzZXNzaW9uSWR9LWZpbGVzYCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNlc3Npb25GaWxlc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGZhbGwgYmFjayB0byBubyBwYXRocyAqL1xuICB9XG4gIGlmIChyZXN0b3JlZCkge1xuICAgIGZvciAoY29uc3QgaXQgb2Ygc3RhdGUubGlicmFyeSkgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICB9XG5cbiAgLy8gLS0tIGFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGxldCByZXNvbHZlRG9uZSE6ICh2OiB7IGNvZGU6IG51bWJlcjsgcmVhc29uOiBzdHJpbmcgfSkgPT4gdm9pZDtcbiAgY29uc3QgZG9uZSA9IG5ldyBQcm9taXNlPHsgY29kZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PigocikgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcjtcbiAgfSk7XG5cbiAgLy8gIzg0IOKAlCBSRVRVUk5TIEEgVkVSRElDVC4gUHJldmlvdXNseSB2b2lkLCBzbyB0aGUgL2NtZCByb3V0ZSBoYWQgbm90aGluZyB0b1xuICAvLyByZXBvcnQgYW5kIGFuc3dlcmVkIGEgbGl0ZXJhbCB7b2s6dHJ1ZX0gdG8gZXZlcnkgY29tbWFuZCBpbmNsdWRpbmcgb25lcyBpdFxuICAvLyBkcm9wcGVkLiBOb3RlIHRoZSBkZWZlY3QgaXMgTk9UIGEgbWlzc2luZyBgYXdhaXRgOiB0aGlzIGhhbmRsZXIgaXNcbiAgLy8gc3luY2hyb25vdXMsIGFuZCBpbWFnbydzIHR3aW4gSVMgY29ycmVjdGx5IGF3YWl0ZWQgYW5kIHdhcyBicm9rZW4gYW55d2F5LlxuICAvLyBUaGUgZml4IGlzIHRoYXQgYSBkZWNpc2lvbiBleGlzdHMgYXQgYWxsLlxuICAvLyBDb250cmFjdCAxMzogdGhlIHZlcmRpY3Qgb3JpZ2luYXRlcyBpbiB0aGUgY29kZSBvd25pbmcgdGhlIHJlY29nbmlzZWQgc2V0LlxuICAvLyBiMTIgd2lkZW5zIHRoZSBSRVRVUk4gd2l0aG91dCB3aWRlbmluZyB0aGUgQ09OVFJBQ1Qg4oCUIGEgY29tbWFuZCBtYXkgYW5zd2VyXG4gIC8vIHdpdGggYSByZXN1bHQgb2JqZWN0IGNhcnJ5aW5nIGl0cyBvd24gcGF5bG9hZCBpbnN0ZWFkIG9mIHRoZSBib29sZWFuLiBFdmVyeVxuICAvLyBvdGhlciBjb21tYW5kIHN0aWxsIHJldHVybnMgYSBiYXJlIGJvb2xlYW4gYW5kIGl0cyByZXNwb25zZSBpc1xuICAvLyBieXRlLWlkZW50aWNhbC4gU2FtZSBzaGFwZSBhcyBpbWFnbydzIGNvbnRleHQuYWRkICg1ZTZhYWNkKS5cbiAgdHlwZSBBZ2VudFZlcmRpY3QgPSBib29sZWFuIHwgeyByZWNvZ25pc2VkOiB0cnVlOyBvazogdHJ1ZTsgZGV0YWlsOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9O1xuICBjb25zdCBoYW5kbGVBZ2VudE1zZyA9IChtc2c6IEFnZW50Q29tbWFuZCk6IEFnZW50VmVyZGljdCA9PiB7XG4gICAgaWYgKG1zZy50eXBlID09PSBcInNheVwiKSB7XG4gICAgICBhZGRNZXNzYWdlKHN0YXRlLCB7XG4gICAgICAgIGlkOiBgbS0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAgd2hvOiBcImFnZW50XCIsXG4gICAgICAgIGtpbmQ6IG1zZy5raW5kID8/IFwiaW5mb1wiLFxuICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgZ3JvdW5kOiBbXSxcbiAgICAgICAgdHM6IERhdGUubm93KCksXG4gICAgICB9KTtcbiAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIpIHtcbiAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMCwgcmVhc29uOiBcImNsb3NlXCIgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSBcImdlbi5hZGRcIikge1xuICAgICAgY29uc3QgaXQgPSBtYWtlSXRlbSh7XG4gICAgICAgIGlkOiBgZ2VuLSR7cmFuZEhleCg0KX1gLFxuICAgICAgICBraW5kOiBcImdlblwiLFxuICAgICAgICB0aXRsZTogbXNnLmxhYmVsID8/IGByb3VuZCAke21zZy5yb3VuZH1gLFxuICAgICAgICBzcmM6IG1zZy5zcmMsXG4gICAgICAgIG1pbWU6IFwiaW1hZ2Uvd2VicFwiLFxuICAgICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgIGdlbjoge1xuICAgICAgICAgIG1vZGVsOiBtc2cubW9kZWwsXG4gICAgICAgICAgcHJvbXB0OiBtc2cucHJvbXB0LFxuICAgICAgICAgIHNlZWQ6IG1zZy5zZWVkID8/IG51bGwsXG4gICAgICAgICAgY29zdDogbXNnLmNvc3QgPz8gbnVsbCxcbiAgICAgICAgICBjdXN0b206IG1zZy5jdXN0b20gPz8ge30sXG4gICAgICAgICAgcm91bmQ6IG1zZy5yb3VuZCxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgbWF0ZXJpYWxpemVJdGVtKHNlc3Npb25GaWxlc0RpciwgaXQpO1xuICAgICAgLy8gYjEyICsgIzg3ICh0aGlyZCBzcGVsbCkg4oCUIGBpZiAoYWRkSXRlbShzdGF0ZSwgaXQpKSBicm9hZGNhc3RTdGF0ZSgpYFxuICAgICAgLy8gZHJvcHBlZCB0aGUgbXV0YXRvcidzIG91dGNvbWUgaW50byBjb250cm9sIGZsb3cgYW5kIGFuc3dlcmVkIG9rOnRydWVcbiAgICAgIC8vIGVpdGhlciB3YXkuIFR3byB0aGluZ3Mgd2VyZSB3cm9uZyBhbmQgb25seSBvbmUgaXMgd2hhdCB0aGUgY2FyZCBzYWlkOlxuICAgICAgLy9cbiAgICAgIC8vICAgUkVBQ0hBQkxFLCBldmVyeSBjYWxsOiB0aGUgbWludGVkIGlkIHdhcyBESVNDQVJERUQsIHNvIHRoZSBhZ2VudCB0aGF0XG4gICAgICAvLyAgIGp1c3QgY3JlYXRlZCBhbiBpdGVtIGNvdWxkIG5vdCByZWZlcmVuY2UgaXQuIFRoYXQgaXMgIzg3J3MgZGVmZWN0IGluIGFcbiAgICAgIC8vICAgdGhpcmQgY29kZWJhc2UgKGltYWdvIGNvbnRleHQuYWRkLCBhbmQgdGhpcykuXG4gICAgICAvL1xuICAgICAgLy8gICBOT1QgUkVBQ0hBQkxFIGluIHByYWN0aWNlOiB0aGUgXCJzaWxlbnQgZGVkdXBlXCIuIGBpZGAgaXMgbWludGVkIEhFUkVcbiAgICAgIC8vICAgKGBnZW4tJHtyYW5kSGV4KDQpfWApIGFuZCB0aGUgY2FsbGVyIGNhbm5vdCBzdXBwbHkgb25lIOKAlCBgYnVpbGRHZW5DbWRgXG4gICAgICAvLyAgIGhhcyBubyBpZCBmaWVsZCwgYW5kIHRoaXMgbGluZSBpZ25vcmVzIGFueSB0aGF0IGFycml2ZWQg4oCUIHNvIGFkZEl0ZW1cbiAgICAgIC8vICAgcmV0dXJucyBmYWxzZSBvbmx5IG9uIGEgMl4zMiBjb2xsaXNpb24uIFRoZSBicmFuY2ggd2FzIGRlYWQsIG5vdFxuICAgICAgLy8gICBkYW5nZXJvdXMuIEl0IGlzIHJlcG9ydGVkIGhvbmVzdGx5IG5vdyByYXRoZXIgdGhhbiByZW1vdmVkLCBiZWNhdXNlIGFcbiAgICAgIC8vICAgY29sbGlzaW9uIHRoYXQgRElEIGhhcHBlbiB3b3VsZCBvdGhlcndpc2UgYmUgdGhlIHNpbGVudCBjYXNlLlxuICAgICAgY29uc3QgYWRkZWQgPSBhZGRJdGVtKHN0YXRlLCBpdCk7XG4gICAgICBpZiAoYWRkZWQpIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZWNvZ25pc2VkOiB0cnVlLFxuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgZGV0YWlsOiB7IGlkOiBpdC5pZCwgb3V0Y29tZTogYWRkZWQgPyBcImNyZWF0ZWRcIiA6IFwiYWxyZWFkeS1yZWNvcmRlZFwiIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09IFwic3R5bGUuc2F2ZVwiKSB7XG4gICAgICBjb25zdCBjYW5vbmljYWxJdGVtcyA9IHN0YXRlLmxpYnJhcnkuZmlsdGVyKChpKSA9PiBpLmNhbm9uaWNhbCAmJiAhaS5hcmNoaXZlZCk7XG4gICAgICBjb25zdCBhZ3JlZWQgPSBzdGF0ZS5zdHlsZUd1aWRlLmZpbHRlcigocykgPT4gcy5zdGF0dXMgIT09IFwiZW1wdHlcIiAmJiBzLmNvbnRlbnQpO1xuICAgICAgY29uc3QgdGV4dCA9IGFncmVlZFxuICAgICAgICAubWFwKChzKSA9PiBzLmNvbnRlbnQpXG4gICAgICAgIC5qb2luKFwiIMK3IFwiKVxuICAgICAgICAuc2xpY2UoMCwgMjgwKTtcbiAgICAgIGNvbnN0IHN0eWxlID0gc2F2ZVN0eWxlKEdMQU1PVVJfSE9NRSwgUFJPSkVDVF9LRVksIHtcbiAgICAgICAgaWQ6IGBzdHlsZS0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAgbGFiZWw6IG1zZy5sYWJlbCxcbiAgICAgICAgdGV4dCxcbiAgICAgICAgc2VjdGlvbnM6IHN0YXRlLnN0eWxlR3VpZGUsXG4gICAgICAgIGNhbm9uaWNhbEl0ZW1zLFxuICAgICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICB9KTtcbiAgICAgIHN0YXRlLnRyYXkucHVzaChzdHlsZSk7XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtc2cudHlwZSA9PT0gXCJzdHlsZS5hcmNoaXZlXCIpIHtcbiAgICAgIHNldFN0eWxlQXJjaGl2ZWQoR0xBTU9VUl9IT01FLCBQUk9KRUNUX0tFWSwgbXNnLmlkLCBtc2cuYXJjaGl2ZWQpO1xuICAgICAgYXBwbHlBZ2VudE1zZyhzdGF0ZSwgbXNnKTsgLy8gZmxpcHMgdGhlIGluLW1lbW9yeSB0cmF5IGVudHJ5XG4gICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIC8vIFRoZSBmYWxsdGhyb3VnaCBpcyB0aGUgb25seSBwYXRoIHRoYXQgY2FuIGJlIFVOUkVDT0dOSVNFRCwgYW5kIHRoZVxuICAgIC8vIHJlZHVjZXIgaXMgd2hhdCBrbm93czogaXQgb3ducyB0aGUgY2FzZSBsaXN0LCBzbyB0aGUgdmVyZGljdCBjb21lcyBmcm9tXG4gICAgLy8gdGhlcmUgcmF0aGVyIHRoYW4gZnJvbSBhIHNlY29uZCBlbnVtZXJhdGlvbiBoZXJlLlxuICAgIGNvbnN0IHJlY29nbmlzZWQgPSBhcHBseUFnZW50TXNnKHN0YXRlLCBtc2cpO1xuICAgIGlmIChyZWNvZ25pc2VkKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgIHJldHVybiByZWNvZ25pc2VkO1xuICB9O1xuXG4gIC8vIC0tLSBicm93c2VyIG1lc3NhZ2VzIChXZWJTb2NrZXQpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBoYW5kbGVDbGllbnRNc2cgPSAobXNnOiBDbGllbnRUb1NlcnZlcikgPT4ge1xuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJpdGVtLmFkZFwiOiB7XG4gICAgICAgIGNvbnN0IGl0ID0gbWFrZUl0ZW0oe1xuICAgICAgICAgIGlkOiBgJHttc2cuaXRlbS5raW5kfS0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAgICBraW5kOiBtc2cuaXRlbS5raW5kLFxuICAgICAgICAgIHRpdGxlOiBtc2cuaXRlbS50aXRsZSxcbiAgICAgICAgICBzcmM6IG1zZy5pdGVtLnNyYyxcbiAgICAgICAgICB0ZXh0OiBtc2cuaXRlbS50ZXh0LFxuICAgICAgICAgIG1pbWU6IG1zZy5pdGVtLm1pbWUgPz8gXCJcIixcbiAgICAgICAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgIH0pO1xuICAgICAgICBtYXRlcmlhbGl6ZUl0ZW0oc2Vzc2lvbkZpbGVzRGlyLCBpdCk7XG4gICAgICAgIGlmIChhZGRJdGVtKHN0YXRlLCBpdCkpIHtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAgIGVtaXRFdmVudCh7XG4gICAgICAgICAgICB0eXBlOiBcIml0ZW0uYWRkXCIsXG4gICAgICAgICAgICBpdGVtOiBsZWFuSXRlbShpdCksXG4gICAgICAgICAgICBzZWxlY3RlZElkczogc3RhdGUuc2VsZWN0ZWRJZHMsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiaXRlbS5zZWxlY3RcIjpcbiAgICAgICAgc2VsZWN0SXRlbXMoc3RhdGUsIG1zZy5pZHMpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJpdGVtLnN0YXJcIjpcbiAgICAgICAgaWYgKHNldFN0YXIoc3RhdGUsIG1zZy5pZCwgbXNnLnN0YXJyZWQpKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJpdGVtLmxpa2VcIjpcbiAgICAgICAgaWYgKHNldExpa2Uoc3RhdGUsIG1zZy5pZCwgbXNnLmxpa2VkKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaXRlbS5hbm5vdGF0ZVwiOlxuICAgICAgICAvLyBBbWJpZW50OiB0aGUgaHVtYW4ncyBwZXItaXRlbSBub3RlIGlzIHN0b3JlZCArIFVJLXN5bmNlZCArIHBlcnNpc3RlZCxcbiAgICAgICAgLy8gYW5kIHRoZSBhZ2VudCByZWFkcyBpdCBvbiBkZW1hbmQgZnJvbSBzdGF0ZSB3aGVuIGl0IGxvb2tzIGF0IHRoZSBpbWFnZS5cbiAgICAgICAgLy8gSXQgaXMgTk9UIHB1c2hlZCBhcyBhbiBhZ2VudCBldmVudCDigJQgYSBzdGlja3kgbm90ZSwgbm90IGEgcmVhbC10aW1lXG4gICAgICAgIC8vIHNpZ25hbCAoc2VlIHRoZSBldmVudC12b2x1bWUgbGVzc29uOyBhdm9pZHMgaW50ZXJydXB0aW5nIHRoZSBhZ2VudCBvblxuICAgICAgICAvLyBldmVyeSBibHVyKS5cbiAgICAgICAgaWYgKGFubm90YXRlKHN0YXRlLCBtc2cuaWQsIFwiaHVtYW5cIiwgbXNnLmh1bWFuKSkgYnJvYWRjYXN0U3RhdGUoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWVzc2FnZS5zZW5kXCI6IHtcbiAgICAgICAgY29uc3QgZ3JvdW5kID0gWy4uLnN0YXRlLnNlbGVjdGVkSWRzXTtcbiAgICAgICAgYWRkTWVzc2FnZShzdGF0ZSwge1xuICAgICAgICAgIGlkOiBgbS0ke3JhbmRIZXgoNCl9YCxcbiAgICAgICAgICB3aG86IFwidXNlclwiLFxuICAgICAgICAgIGtpbmQ6IFwiaW5mb1wiLFxuICAgICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICAgIGdyb3VuZCxcbiAgICAgICAgICB0czogRGF0ZS5ub3coKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwibWVzc2FnZS51c2VyXCIsIHRleHQ6IG1zZy50ZXh0LCBncm91bmQgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZvY3VzLnNldFwiOlxuICAgICAgICBzZXRGb2N1cyhzdGF0ZSwgbXNnLmlkcywgXCJ5b3VcIik7XG4gICAgICAgIGJyb2FkY2FzdFN0YXRlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImZvY3VzLmNsZWFyXCI6XG4gICAgICAgIGNsZWFyRm9jdXMoc3RhdGUpO1xuICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJpdGVtLmNhbm9uaWNhbFwiOlxuICAgICAgICBpZiAoc2V0Q2Fub25pY2FsKHN0YXRlLCBtc2cuaWQsIG1zZy5jYW5vbmljYWwpKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJpdGVtLmFyY2hpdmVcIjpcbiAgICAgICAgaWYgKHNldEl0ZW1BcmNoaXZlZChzdGF0ZSwgbXNnLmlkLCBtc2cuYXJjaGl2ZWQpKSBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJzdHlsZS5icmluZ0luXCI6IHtcbiAgICAgICAgY29uc3Qgc3R5bGUgPSBzdGF0ZS50cmF5LmZpbmQoKHMpID0+IHMuaWQgPT09IG1zZy5pZCk7XG4gICAgICAgIGlmICghc3R5bGUpIGJyZWFrO1xuICAgICAgICBjb25zdCBpdGVtSWQgPSBgc3R5bGUtJHtzdHlsZS5pZH1gO1xuICAgICAgICBpZiAoc3RhdGUubGlicmFyeS5zb21lKChpKSA9PiBpLmlkID09PSBpdGVtSWQpKSBicmVhazsgLy8gaWRlbXBvdGVudFxuICAgICAgICBjb25zdCBjYW5vbiA9IG1hdGVyaWFsaXplQ2Fub24oR0xBTU9VUl9IT01FLCBQUk9KRUNUX0tFWSwgc3R5bGUpO1xuICAgICAgICBjb25zdCBpdCA9IGJ1aWxkU3R5bGVJdGVtKHN0eWxlLCBjYW5vbiwgRGF0ZS5ub3coKSk7XG4gICAgICAgIGlmIChhZGRJdGVtKHN0YXRlLCBpdCkpIHtcbiAgICAgICAgICBicm9hZGNhc3RTdGF0ZSgpO1xuICAgICAgICAgIGVtaXRFdmVudCh7IHR5cGU6IFwiaXRlbS5hZGRcIiwgaXRlbTogbGVhbkl0ZW0oaXQpLCBzZWxlY3RlZElkczogc3RhdGUuc2VsZWN0ZWRJZHMgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIC0tLSBTU0UgcmVzcG9uc2UgKHJlcGxheSBieSBpZCArIGhlYXJ0YmVhdCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzc2VSZXNwb25zZSA9ICh1cmw6IFVSTCk6IFJlc3BvbnNlID0+IHtcbiAgICB0b3VjaCgpO1xuICAgIGNvbnN0IHNpbmNlID0gTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCItMVwiLCAxMCk7XG4gICAgbGV0IHJlZjogUmVhZGFibGVTdHJlYW1EZWZhdWx0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICAgIGxldCBoYjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gICAgY29uc3Qgc3RyZWFtID0gbmV3IFJlYWRhYmxlU3RyZWFtKHtcbiAgICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgICAgcmVmID0gY29udHJvbGxlcjtcbiAgICAgICAgZm9yIChjb25zdCBldiBvZiBldmVudHMpIHtcbiAgICAgICAgICBpZiAoKGV2LmlkIGFzIG51bWJlcikgPiBzaW5jZSlcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmMuZW5jb2RlKGBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGV2KX1cXG5cXG5gKSk7XG4gICAgICAgIH1cbiAgICAgICAgc3NlQ2xpZW50cy5hZGQoY29udHJvbGxlcik7XG4gICAgICAgIGhiID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmVucXVldWUoZW5jLmVuY29kZShgOiBoYlxcblxcbmApKTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIGdvbmUgKi9cbiAgICAgICAgICB9XG4gICAgICAgIH0sIDE1MDAwKTtcbiAgICAgIH0sXG4gICAgICBjYW5jZWwoKSB7XG4gICAgICAgIGlmIChoYikgY2xlYXJJbnRlcnZhbChoYik7XG4gICAgICAgIGlmIChyZWYpIHNzZUNsaWVudHMuZGVsZXRlKHJlZik7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIHJldHVybiBuZXcgUmVzcG9uc2Uoc3RyZWFtLCB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9ldmVudC1zdHJlYW1cIixcbiAgICAgICAgXCJDYWNoZS1Db250cm9sXCI6IFwibm8tY2FjaGVcIixcbiAgICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgICB9LFxuICAgIH0pO1xuICB9O1xuXG4gIC8vIC0tLSBzZXJ2ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICBwb3J0OiBvcHRzLnBvcnQgPz8gMCxcbiAgICBob3N0bmFtZTogb3B0cy5ob3N0ID8/IFwiMTI3LjAuMC4xXCIsXG4gICAgcm91dGVzLFxuICAgIC8vIOKblCBIRUxEIFNTRSBDT05ORUNUSU9OUyBESUUgV0lUSE9VVCBUSElTLiBCdW4ncyBkZWZhdWx0IHJlcXVlc3RcbiAgICAvLyBpZGxlVGltZW91dCBpcyAxMHMgYW5kIGEgc2VydmVyLXNlbnQgaGVhcnRiZWF0IGRvZXMgTk9UIHJlc2V0IGl0LCBzbyBhblxuICAgIC8vIFNTRSBjbGllbnQgaXMgY2xvc2VkIGJlZm9yZSB0aGUgMTVzIGA6IGhiYCBiZWxvdyBldmVyIGZpcmVzIOKAlCB0aGVcbiAgICAvLyBrZWVwYWxpdmUgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhcyBrZWVwaW5nIGFsaXZlIGlzXG4gICAgLy8gZ29uZSwgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCByYXRlIHdvdWxkIG5vdCBoYXZlIGhlbHBlZC5cbiAgICAvLyAyNTUgaXMgQnVuJ3MgbWF4aW11bSAoMCBpcyBub3QgXCJkaXNhYmxlZFwiKSwgbWF0Y2hpbmcgYm91bnR5LCBncmFwZXZpbmVcbiAgICAvLyBhbmQgbWluZC1tYXBwZXI7IGFzdHJvbGFiZSBlbnYtdHVuZXMgaXQgYW5kIGNsYW1wcyB0aGUgaGVhcnRiZWF0IHRvIGhhbGYuXG4gICAgLy8gRm91bmQgMjAyNi0wOS0wOCBieSB0aGUgYmFja2VuZCBkdXBsaWNhdGlvbiByZWNvbjogZm91ciBzcGVsbHMgaGFkIGhpdFxuICAgIC8vIHRoaXMgYW5kIGZpeGVkIGl0LCB0aHJlZSBoYWQgbm90LCBiZWNhdXNlIHRoZSBkYWVtb24gc3BpbmUgaXMgb25lIGRlc2lnblxuICAgIC8vIGltcGxlbWVudGVkIHNpeCB0aW1lcy5cbiAgICBpZGxlVGltZW91dDogMjU1LFxuICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgIGZldGNoKHJlcSwgc3J2KSB7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgIGlmIChwYXRoID09PSBcIi93c1wiKVxuICAgICAgICByZXR1cm4gc3J2LnVwZ3JhZGUocmVxKSA/IHVuZGVmaW5lZCA6IG5ldyBSZXNwb25zZShcInVwZ3JhZGUgcmVxdWlyZWRcIiwgeyBzdGF0dXM6IDQyNiB9KTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL3N0YXRlXCIpIHtcbiAgICAgICAgdG91Y2goKTtcbiAgICAgICAgY29uc3QgbGVhbiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwibGVhblwiKSA9PT0gXCIxXCI7XG4gICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICBzdGF0ZTogbGVhbiA/IGxlYW5TdGF0ZShzdGF0ZSkgOiBzdGF0ZSxcbiAgICAgICAgICBjdXJzb3I6IGV2ZW50U2VxLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL2V2ZW50c1wiKSByZXR1cm4gc3NlUmVzcG9uc2UodXJsKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jbWRcIilcbiAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAudGhlbigoYikgPT4ge1xuICAgICAgICAgICAgdG91Y2goKTtcbiAgICAgICAgICAgIC8vICM4NCDigJQgcHJvcGFnYXRlIHRoZSBoYW5kbGVyJ3MgdmVyZGljdCBpbnN0ZWFkIG9mIGEgbGl0ZXJhbFxuICAgICAgICAgICAgLy8ge29rOnRydWV9LiBgYXBwbGllZGAgaXMgdGhlIGZpZWxkIGJvdW50eSBhbHJlYWR5IHVzZXNcbiAgICAgICAgICAgIC8vIChzZXJ2ZXIudHMgQXBwbHlSZXN1bHQpOyBubyBuZXcgdm9jYWJ1bGFyeSBpcyBtaW50ZWQgaGVyZS5cbiAgICAgICAgICAgIGNvbnN0IHZlcmRpY3QgPSBoYW5kbGVBZ2VudE1zZyhiIGFzIEFnZW50Q29tbWFuZCk7XG4gICAgICAgICAgICAvLyBBIGNvbW1hbmQgdGhhdCBhbnN3ZXJlZCB3aXRoIGl0cyBvd24gcmVzdWx0IGNhcnJpZXMgaXRzIHBheWxvYWQ7XG4gICAgICAgICAgICAvLyB0aGUgYm9vbGVhbiBwYXRoIGJlbG93IGlzIHVuY2hhbmdlZC5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmVyZGljdCA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSwgLi4udmVyZGljdC5kZXRhaWwgfSk7XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmVyZGljdDtcbiAgICAgICAgICAgIGlmICghYXBwbGllZCkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICBhcHBsaWVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBgdW5yZWNvZ25pc2VkIGNvbW1hbmQgdHlwZSAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgICAgICAgICAgICAoYiBhcyB7IHR5cGU/OiB1bmtub3duIH0pPy50eXBlLFxuICAgICAgICAgICAgICAgICAgKX0g4oCUIG5vdGhpbmcgd2FzIGFwcGxpZWRgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCB9LFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogdHJ1ZSB9KTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwiYmFkIGpzb25cIiB9LCB7IHN0YXR1czogNDAwIH0pKTtcbiAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9hc3NldHMvXCIpKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgIGlmIChuYW1lLmluY2x1ZGVzKFwiLi5cIikgfHwgbmFtZS5zdGFydHNXaXRoKFwiL1wiKSlcbiAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICAgIGNvbnN0IGYgPSBCdW4uZmlsZShqb2luKHNlc3Npb25GaWxlc0RpciwgbmFtZSkpO1xuICAgICAgICByZXR1cm4gZlxuICAgICAgICAgIC5leGlzdHMoKVxuICAgICAgICAgIC50aGVuKChvaykgPT5cbiAgICAgICAgICAgIG9rID8gbmV3IFJlc3BvbnNlKGYpIDogUmVzcG9uc2UuanNvbih7IGVycm9yOiBcIm5vdCBmb3VuZFwiIH0sIHsgc3RhdHVzOiA0MDQgfSksXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIHJlbGVhc2U6IFwiL1wiIGFuZCB0aGUgaGFzaGVkIGNodW5rLSouanMvY3NzIGFyZSBzdGF0aWMgZGlzdCByZWFkcy4gRGV2XG4gICAgICAvLyBuZXZlciByZWFjaGVzIGhlcmUgZm9yIFwiL1wiIOKAlCB0aGUgcm91dGVzIHRhYmxlIGFib3ZlIGFuc3dlcnMgaXQgZmlyc3QuXG4gICAgICAvLyBUaGlzIHNpdHMgQUZURVIgL2Fzc2V0cy8sIHdoaWNoIHNlcnZlcyBzZXNzaW9uIGZpbGVzLCBub3QgZGlzdCBvbmVzLlxuICAgICAgaWYgKG1vZGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgZXJyb3I6IFwibm90IGZvdW5kXCIgfSwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICB9LFxuICAgIHdlYnNvY2tldDoge1xuICAgICAgb3Blbih3cykge1xuICAgICAgICBzb2NrZXRzLmFkZCh3cyk7XG4gICAgICAgIHRvdWNoKCk7XG4gICAgICAgIGVtaXRUcmFuc2llbnQoeyB0eXBlOiBcImNvbm5lY3RlZFwiIH0pO1xuICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJzdGF0ZVwiLCBzdGF0ZSB9KSk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZShfd3MsIHJhdykge1xuICAgICAgICB0b3VjaCgpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGhhbmRsZUNsaWVudE1zZyhcbiAgICAgICAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgICAgICAgIHR5cGVvZiByYXcgPT09IFwic3RyaW5nXCIgPyByYXcgOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmF3KSxcbiAgICAgICAgICAgICkgYXMgQ2xpZW50VG9TZXJ2ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnbGFtb3VyOiBiYWQganNvbiBmcm9tIGJyb3dzZXI6ICR7ZX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNsb3NlKHdzKSB7XG4gICAgICAgIHNvY2tldHMuZGVsZXRlKHdzKTtcbiAgICAgICAgZW1pdFRyYW5zaWVudCh7IHR5cGU6IFwiZGlzY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGJvdW5kUG9ydCA9IHNlcnZlci5wb3J0O1xuICAvLyAtLS0gZGlzY292ZXJ5IGZpbGVzIChjbGkudHMgcmVhZHMgdGhlc2UpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgY29uc3Qgc2Vzc2lvbkZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb25JZH0uanNvbmApO1xuICBjb25zdCBsYXRlc3RGaWxlID0gam9pbih0bXBkaXIoKSwgYGdsYW1vdXItbGF0ZXN0Lmpzb25gKTtcbiAgY29uc3QgaW5mbyA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICB1cmw6IGBodHRwOi8vJHtvcHRzLmhvc3QgPz8gXCIxMjcuMC4wLjFcIn06JHtib3VuZFBvcnR9YCxcbiAgICBwb3J0OiBib3VuZFBvcnQsXG4gICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgIHRpdGxlOiBzdGF0ZS50aXRsZSxcbiAgICBmaWxlc19kaXI6IHNlc3Npb25GaWxlc0RpcixcbiAgICBtb2RlLFxuICB9KTtcbiAgLy8g4pqgIEFUT01JQywgYmVjYXVzZSBjbGkudHMncyByZWFkU2Vzc2lvbiBub3cgdHJlYXRzIHVucGFyc2VhYmxlIGNvbnRlbnQgYXNcbiAgLy8gY29ycnVwdGlvbiByYXRoZXIgdGhhbiBhYnNlbmNlLiBBIGJhcmUgd3JpdGVGaWxlU3luYyBpcyBub3QgYXRvbWljOiBhIENMSVxuICAvLyByZWFkaW5nIHdoaWxlIHRoZSBkYWVtb24gd3JpdGVzIGNhbiBvYnNlcnZlIGEgaGFsZi13cml0dGVuIHBvaW50ZXIsIGFuZFxuICAvLyB1bmRlciB0aGUgb2xkIGJlc3QtZWZmb3J0IHJlYWQgdGhhdCBzdXJmYWNlZCBhcyBcIm5vIHJ1bm5pbmcgZ2xhbW91clxuICAvLyBzZXNzaW9uXCIuIFdyaXRlIGJlc2lkZSB0aGUgdGFyZ2V0IGFuZCByZW5hbWUg4oCUIHJlbmFtZSB3aXRoaW4gb25lIGRpcmVjdG9yeVxuICAvLyBpcyBhdG9taWMsIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBwcmV2aW91cyBwb2ludGVyIG9yIHRoZSBuZXcgb25lLlxuICBjb25zdCB3cml0ZUF0b21pYyA9ICh0YXJnZXQ6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgdG1wID0gYCR7dGFyZ2V0fS4ke3Byb2Nlc3MucGlkfS50bXBgO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKHRtcCwgdGV4dCk7XG4gICAgICByZW5hbWVTeW5jKHRtcCwgdGFyZ2V0KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJtU3luYyh0bXAsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogdGhlIHRlbXAgZmlsZSBpcyBhbHJlYWR5IGdvbmUsIG9yIHdhcyBuZXZlciBjcmVhdGVkICovXG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGNvdWxkIG5vdCBwdWJsaXNoICR7dGFyZ2V0fWApO1xuICAgIH1cbiAgfTtcbiAgdHJ5IHtcbiAgICB3cml0ZUF0b21pYyhzZXNzaW9uRmlsZSwgaW5mbyk7XG4gICAgd3JpdGVBdG9taWMobGF0ZXN0RmlsZSwgaW5mbyk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGRpc2NvdmVyeSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG5cbiAgLy8gQ29udHJhY3QgMTogdGhlIGRhZW1vbiBFTUlUUyBpdHMgcmVzb2x2ZWQgbW9kZSDigJQgYSBkZXYgZGFlbW9uIHdpdGggcm9vdCBkZXBzXG4gIC8vIHByZXNlbnQgcmVuZGVycyBhbiBpZGVudGljYWwtbG9va2luZyBib2FyZCwgc28gYG1vZGVgIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXRcbiAgLy8gdGVsbHMgYSB2ZXJpZmllciB3aGljaCBwYXRoIHNlcnZlZCBpdC4gZ2xhbW91ciBoYXMgVEhSRUUgdHJhbnNwb3J0cyAoaW1hZ29cbiAgLy8gaGFzIHR3byk6IHRoaXMgZXZlbnQsIHRoZSBkaXNjb3ZlcnkgZmlsZSBhYm92ZSwgYW5kIHRoZSBzdGRvdXQgaGFuZHNoYWtlIGluXG4gIC8vIGltcG9ydC5tZXRhLm1haW4gYmVsb3cuIEFsbCB0aHJlZSBjYXJyeSBpdC5cbiAgZW1pdEV2ZW50KHsgdHlwZTogXCJyZWFkeVwiLCBtb2RlIH0pO1xuXG4gIC8vIC0tLSBzbmFwc2hvdCBkZWJvdW5jZSArIGlkbGUgdGltZW91dCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBjb25zdCBzYXZlTm93ID0gKCkgPT4gc2F2ZVNuYXBzaG90KFNOQVBTSE9UU19ESVIsIHNlc3Npb25JZCwgc3RhdGUpO1xuICBpZiAocmVzdG9yZWQpIHNhdmVOb3coKTtcbiAgY29uc3Qgc25hcFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIGlmIChzbmFwRGlydHkpIHtcbiAgICAgIHNuYXBEaXJ0eSA9IGZhbHNlO1xuICAgICAgc2F2ZU5vdygpO1xuICAgIH1cbiAgfSwgMTAwMCk7XG4gIGNvbnN0IHRpbWVvdXRTID0gb3B0cy50aW1lb3V0UyA/PyAxODAwO1xuICBjb25zdCBpZGxlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgaWYgKChwZXJmb3JtYW5jZS5ub3coKSAtIGxhc3RBY3Rpdml0eSkgLyAxMDAwID49IHRpbWVvdXRTKVxuICAgICAgcmVzb2x2ZURvbmUoeyBjb2RlOiAxMjQsIHJlYXNvbjogXCJ0aW1lb3V0XCIgfSk7XG4gIH0sIDI1MCk7XG5cbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBSZXNvbHZlcyBvbmNlIHRoZSBTU0UgZmx1c2ggKyBzZXJ2ZXIuc3RvcCBoYXZlIGJlZW4gc2NoZWR1bGVkOyBjYWxsZXJzXG4gIC8vIHRoYXQgbmVlZCB0byB3YWl0IChlLmcuIGltcG9ydC5tZXRhLm1haW4gYmVmb3JlIHByb2Nlc3MuZXhpdCkgY2FuIGF3YWl0IHRoaXMuXG4gIGxldCByZXNvbHZlU2h1dGRvd24hOiAoKSA9PiB2b2lkO1xuICBjb25zdCBzaHV0ZG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiB7XG4gICAgcmVzb2x2ZVNodXRkb3duID0gcjtcbiAgfSk7XG5cbiAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgIGNsb3NlZCA9IHRydWU7XG4gICAgY2xlYXJJbnRlcnZhbChzbmFwVGltZXIpO1xuICAgIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgICBzYXZlTm93KCk7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoc2Vzc2lvbkZpbGUpO1xuICAgIH0gY2F0Y2gge31cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGxhdGVzdEZpbGUsIFwidXRmOFwiKTtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHNlc3Npb25faWQ/OiBzdHJpbmcgfTtcbiAgICAgIGlmIChwYXJzZWQuc2Vzc2lvbl9pZCA9PT0gc2Vzc2lvbklkKSB1bmxpbmtTeW5jKGxhdGVzdEZpbGUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhzZXNzaW9uRmlsZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHt9XG4gICAgZW1pdEV2ZW50KHsgdHlwZTogXCJjbG9zZWRcIiB9KTtcbiAgICAvLyBDbG9zZSBlYWNoIFNTRSBjb250cm9sbGVyIHNvIEJ1biBmbHVzaGVzIHRoZSBxdWV1ZWQgZnJhbWUgdG8gdGhlIGNsaWVudFxuICAgIC8vIGJlZm9yZSB0ZWFyaW5nIGRvd24gdGhlIFRDUCBjb25uZWN0aW9ucy5cbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYy5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGFscmVhZHkgY2xvc2VkICovXG4gICAgICB9XG4gICAgfVxuICAgIHNzZUNsaWVudHMuY2xlYXIoKTtcbiAgICAvLyBHaXZlIEJ1biBhIHRpY2sgdG8gZHJhaW4gdGhlIGZpbmFsIFNTRSBmcmFtZXMsIHRoZW4gc3RvcCB0aGUgc2VydmVyLlxuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgc2VydmVyLnN0b3AodHJ1ZSk7XG4gICAgICByZXNvbHZlU2h1dGRvd24oKTtcbiAgICB9LCA1MCk7XG4gIH07XG4gIGRvbmUudGhlbigoKSA9PiBjbG9zZSgpKTtcblxuICByZXR1cm4geyBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25JZCwgbW9kZSwgY2xvc2UsIGRvbmUsIHNodXRkb3duIH07XG59XG5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS4gVGhlIFNJWFRIIGVudHJ5IHBvaW50LlxuLy9cbi8vIOKaoCBUSElTIE9ORSBIQVMgWkVSTyBgZmxhZ3MuYCBSRUFEUywgc28gYSBgZmxhZ3MuYC1wYXR0ZXJuIGF1ZGl0IHJldHVybnMgemVyb1xuLy8gaGVyZSDigJQgYW5kIGEgemVybyByZWFkcyBpZGVudGljYWxseSB0byBcIm5vIGRyaWZ0XCIuIEl0IHdhcyBhIExPT0tVUCBwYXJzZXI6XG4vLyBgY29uc3QgZmxhZyA9IChuYW1lKSA9PiB7IGNvbnN0IGkgPSBhcmdzLmluZGV4T2YoYC0tJHtuYW1lfWApOyByZXR1cm4gaSA+PSAwXG4vLyA/IGFyZ3NbaSArIDFdIDogdW5kZWZpbmVkOyB9YC4gSXQgYWxzbyByZWFkIGBCdW4uYXJndmAsIG5vdCBgcHJvY2Vzcy5hcmd2YCxcbi8vIHdoaWNoIGlzIHRoZSBzeW5vbnltIHRoYXQgaGFzIG1hZGUgdGhpcyByZXBvJ3MgZ3JlcHMgbGllIGJlZm9yZS5cbi8vXG4vLyBJdCBoYWQgYSBMQVRFTlQsIFBSRS1FWElTVElORyBidWcgdGhlIGNvbnZlcnNpb24gZml4ZXMgYXMgYSBzaWRlIGVmZmVjdCwgbm90ZWRcbi8vIHNvIHRoZSBjaGFuZ2UgaXMgbm90IG1pc3Rha2VuIGZvciBhIHJlZ3Jlc3Npb246IGBmbGFnKClgIHJldHVybmVkIGBhcmdzW2krMV1gXG4vLyBVTkNPTkRJVElPTkFMTFksIHNvIGAtLXJlc3RvcmUgLS10aXRsZSBYYCB5aWVsZGVkIGByZXN0b3JlID09PSBcIi0tdGl0bGVcImAg4oCUXG4vLyB0aGUgbmV4dCBGTEFHIHNpbGVudGx5IGNvbnN1bWVkIGFzIHRoZSBwcmV2aW91cyBmbGFnJ3MgVkFMVUUuXG4vL1xuLy8gQWxsIHNpeCBhcmUgc3RyaW5nIGJ5IGNvbnN0cnVjdGlvbiAodGhlIG9sZCBoZWxwZXIgcmV0dXJuZWQgdGhlIG5leHQgYXJndlxuLy8gZWxlbWVudCkuIGBwb3J0YCBhbmQgYHRpbWVvdXRgIGFyZSBOdW1iZXIoKS1jb2VyY2VkIGF0IHRoZSBjYWxsIHNpdGUsIHdoaWNoIGlzXG4vLyBhIHZhbHVlIHJlYWQsIG5vdCBhIGJvb2xlYW4gb25lLiBUaGUgZGFlbW9uIHRha2VzIG5vIHBvc2l0aW9uYWxzLCBzbyBzdHJpY3Qnc1xuLy8gZGVmYXVsdCByZWplY3Rpb24gb2YgdGhlbSBpcyBjb3JyZWN0LlxuLy9cbi8vIFZlcmlmaWVkIGJlZm9yZSBjb252ZXJ0aW5nOiBgY2xpLnRzYCBzcGF3bnMgdGhpcyBkYWVtb24gd2l0aCBleGFjdGx5IC0tdGl0bGUsXG4vLyAtLWludGVudCwgLS10aW1lb3V0LCAtLXJlc3RvcmUgYW5kIC0tcHJvamVjdCwgYWxsIGluc2lkZSB0aGlzIHNldCDigJQgc28gc3RyaWN0XG4vLyBjYW5ub3QgcmVmdXNlIHRoZSBkYWVtb24ncyBvd24gbGF1bmNoLlxuY29uc3QgREFFTU9OX09QVElPTlMgPSB7XG4gIGludGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwcm9qZWN0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG4vKiogUGFyc2UgdGhlIGRhZW1vbidzIGFyZ3YsIGJvb3QsIHByaW50IHRoZSBoYW5kc2hha2UsIGFuZCB3YWl0IGZvciB0aGUgZW5kLlxuICogIFJldHVybnMgdGhlIHByb2Nlc3MgZXhpdCBjb2RlOyBpdCBkb2VzIE5PVCBleGl0IOKAlCB0aGUgbGF1bmNoZXIgZG9lcy4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICB0cnkge1xuICAgIGZsYWdzID0gbm9kZVBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IERBRU1PTl9PUFRJT05TLCBzdHJpY3Q6IHRydWUgfSkudmFsdWVzIGFzIFJlY29yZDxcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyB8IHVuZGVmaW5lZFxuICAgID47XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBnbGFtb3VyOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gICtcbiAgICAgICAgYCAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhEQUVNT05fT1BUSU9OUylcbiAgICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgICAuam9pbihcIiBcIil9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IGQgPSBhd2FpdCBzdGFydERhZW1vbih7XG4gICAgcG9ydDogZmxhZ3MucG9ydCA/IE51bWJlcihmbGFncy5wb3J0KSA6IDAsXG4gICAgdGl0bGU6IGZsYWdzLnRpdGxlLFxuICAgIGludGVudDogZmxhZ3MuaW50ZW50LFxuICAgIHJlc3RvcmU6IGZsYWdzLnJlc3RvcmUsXG4gICAgdGltZW91dFM6IGZsYWdzLnRpbWVvdXQgPyBOdW1iZXIoZmxhZ3MudGltZW91dCkgOiB1bmRlZmluZWQsXG4gICAgcHJvamVjdDogZmxhZ3MucHJvamVjdCxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke2QucG9ydH1gLCBwb3J0OiBkLnBvcnQsIHNlc3Npb25faWQ6IGQuc2Vzc2lvbklkLCBtb2RlOiBkLm1vZGUgfSl9XFxuYCxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZC5kb25lO1xuICAvLyBXYWl0IGZvciB0aGUgY2xvc2VkIFNTRSBldmVudCB0byBmbHVzaCBiZWZvcmUgZXhpdGluZy5cbiAgYXdhaXQgZC5zaHV0ZG93bjtcbiAgcmV0dXJuIHJlcy5jb2RlO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUiBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NjcmlwdHMvc2VydmVyLnRzYC5cbiAqXG4gKiDim5QgYGltcG9ydC5tZXRhLm1haW5gIElTIEZBTFNFIElOIFRIRSBCVU5ETEUuIGBkaXN0L3NlcnZlci5qc2AgaXMgSU1QT1JURUQgYnlcbiAqIHRoZSBsYXVuY2hlciwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3MgZW50cnksIHNvIHRoZSBvbGRcbiAqIGBpZiAoaW1wb3J0Lm1ldGEubWFpbilgIGJsb2NrIHdvdWxkIHNpbXBseSBuZXZlciBydW4g4oCUIHRoZSBkYWVtb24gd291bGQgYm9vdCxcbiAqIHNlcnZlIG5vdGhpbmcgYW5kIGV4aXQgMCwgYW5kIGV2ZXJ5IHRlc3Qgd291bGQgZmFpbCBhcyBcInRoZSBkYWVtb24gbmV2ZXIgYm91bmRcbiAqIGEgcG9ydFwiLCB3aGljaCByZWFkcyBsaWtlIGZsYWtlLiBUaGF0IGlzIHRoZSBmYWlsdXJlIHRoaXMgZXhwb3J0IGV4aXN0cyB0b1xuICogcHJldmVudCwgYW5kIGl0IGlzIHRoZSBmaXJzdCB0aGluZyB0aGF0IGJyZWFrcyBvbiBldmVyeSBiYWNrZW5kIHJlbG9jYXRpb24uXG4gKlxuICog4puUIEFORCBUSEVSRSBJUyBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0sgTEVGVCwgZGVsaWJlcmF0ZWx5IChEMTIpLiBSdW4gZnJvbVxuICogYHNyYy9nbGFtb3VyL2JhY2tlbmQvYCwgYFNLSUxMX1JPT1RgIGNvbXB1dGVzIHRvIGBzcmMvZ2xhbW91ci9gLCB3aGljaCBob2xkcyBub1xuICogYGRpc3QvaW5kZXguaHRtbGAg4oCUIHNvIHRoZSBkYWVtb24gd291bGQgc2lsZW50bHkgY2hvb3NlIERFViBtb2RlIGFuZCB0aGVuIGZhaWxcbiAqIHRoZSBkZXYgaW1wb3J0IGZyb20gdGhlIHdyb25nIGFuY2hvci4gT2ZmZXJpbmcgdGhhdCBlbnRyeSB3b3VsZCBiZSBvZmZlcmluZyBhXG4gKiB3cm9uZyBkYWVtb24uXG4gKlxuICog4puUIEFORCBJVCBUQUtFUyBOTyBBUkdVTUVOVFMsIGZvciB0aGUgc2FtZSByZWFzb24gYGNsaS50c2AncyBgcnVuKClgIGRvZXMgbm90OlxuICogdGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgUEFSU0VTIGl0LiBBIGxhdW5jaGVyIHRoYXQgdG91Y2hlZFxuICogYHByb2Nlc3MuYXJndmAgd291bGQgbWF0Y2ggYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgJ3MgYXJnLXBhcnNpbmdcbiAqIHByZWRpY2F0ZSBhbmQgdGhlIHdhcmRzIHdvdWxkIGp1ZGdlIHRoaXMgZGFlbW9uJ3MgZmxhZ3MgYWdhaW5zdCBhIGZpbGUgdGhhdFxuICogcmVjb2duaXNlcyBub25lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8vIFRoZSBzaW5nbGUgc2hhcmVkIGNvbnRyYWN0IOKAlCBpbXBvcnRlZCBieSBzZXJ2ZXIudHMsIGNsaS50cywgYW5kIHRoZSBzdXJmYWNlLlxuXG5leHBvcnQgdHlwZSBJdGVtS2luZCA9IFwicmVmXCIgfCBcImNvbnRleHRcIiB8IFwiZ2VuXCIgfCBcInN0eWxlXCI7XG5leHBvcnQgY29uc3QgVkFMSURfS0lORDogcmVhZG9ubHkgSXRlbUtpbmRbXSA9IFtcInJlZlwiLCBcImNvbnRleHRcIiwgXCJnZW5cIiwgXCJzdHlsZVwiXSBhcyBjb25zdDtcblxuLy8gR2VuZXJhdGlvbiBtZXRhZGF0YSAoRzEpLiBGdWxseSBwb3B1bGF0ZWQgZm9yIGtpbmQgPT09IFwiZ2VuXCIgaW4gU2xpY2UgMztcbi8vIHRoZSBmaWVsZCBleGlzdHMgbm93IHNvIHRoZSBjb250cmFjdCBhbmQgdGhlIGRldGFpbHMgZmx5LW91dCBhcmUgc3RhYmxlLlxuZXhwb3J0IHR5cGUgR2VuTWV0YSA9IHtcbiAgbW9kZWw6IHN0cmluZztcbiAgcHJvbXB0OiBzdHJpbmc7XG4gIHNlZWQ6IG51bWJlciB8IG51bGw7XG4gIGNvc3Q6IG51bWJlciB8IG51bGw7XG4gIGN1c3RvbTogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgcm91bmQ6IG51bWJlcjsgLy8gYmF0Y2ggaW5kZXggdGhlIGFnZW50IHN0YW1wczsgVUkgZ3JvdXBzIGdlbiBpdGVtcyBieSBpdFxufTtcblxuLy8gT25lIGNhdGFsb2cgZW50cnkuIFNoYXBlIGZvbGxvd3MgaW1hZ28ncyBDb250ZXh0RW50cnkgY29udmVudGlvbnM6XG4vLyBibG9icyAoYHNyY2AsIGB0ZXh0YCkgYXJlIHN0cmlwcGVkIGluIHRoZSBsZWFuIGFnZW50IHByb2plY3Rpb247IHRoZSBhZ2VudFxuLy8gcmVhZHMgYHBhdGhgLiBBcmNoaXZhbCBpcyBub24tZGVzdHJ1Y3RpdmUgKHRoZSBgYXJjaGl2ZWRgIGZsYWc7IHRoZSBpdGVtXG4vLyBzdXJ2aXZlcyBpbiB0aGUgbGlicmFyeSkuXG5leHBvcnQgdHlwZSBMaWJyYXJ5SXRlbSA9IHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogSXRlbUtpbmQ7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHNyYzogc3RyaW5nOyAvLyBpbWFnZSBkYXRhLVVSTCAocmVmL2dlbik7IFwiXCIgb3RoZXJ3aXNlIOKAlCBzdHJpcHBlZCBpbiBsZWFuXG4gIHBhdGg6IHN0cmluZzsgLy8gb24tZGlzayBtYXRlcmlhbGl6ZWQgYmxvYiB0aGUgYWdlbnQgY2FuIFJlYWQ7IFwiXCIgaWYgbm9uZVxuICB0ZXh0OiBzdHJpbmc7IC8vIGNvbnRleHQgYm9keTsgXCJcIiBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgbWltZTogc3RyaW5nOyAvLyBlLmcuIFwiaW1hZ2Uvd2VicFwiLCBcInRleHQvbWFya2Rvd25cIlxuICB0YWdzOiBzdHJpbmdbXTtcbiAgc3RhcnJlZDogYm9vbGVhbjtcbiAgbGlrZWQ6IGJvb2xlYW47XG4gIGFubm90YXRpb25zOiB7IGFnZW50OiBzdHJpbmc7IGh1bWFuOiBzdHJpbmcgfTtcbiAgY2Fub25pY2FsOiBib29sZWFuOyAvLyBtYXJrZWQgY2Fub25pY2FsIGZvciB0aGUgc3R5bGUgYmVpbmcgYnVpbHQgKG11bHRpLCBub3Qgc2luZ2xlLXNlbGVjdClcbiAgY2Fub246IENhbm9uSW1nW107IC8vIGEga2luZDpcInN0eWxlXCIgaXRlbSdzIGNhbm9uaWNhbCB0aHVtYm5haWxzOyBbXSBvdGhlcndpc2Ug4oCUIHN0cmlwcGVkIGluIGxlYW5cbiAgYXJjaGl2ZWQ6IGJvb2xlYW47XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBnZW46IEdlbk1ldGEgfCBudWxsO1xufTtcblxuLy8gQ29udmVyc2F0aW9uLiBBZ2VudCBtZXNzYWdlIGtpbmRzIGNhcnJ5IFYxJ3MgbmFycmF0aW9uIHNlbWFudGljc1xuLy8gKGluZm8gfCB3b3JraW5nIHwgcmVzdWx0IHwgZXJyb3IpOyB1c2VyIG1lc3NhZ2VzIGFyZSBhbHdheXMgXCJpbmZvXCIuXG5leHBvcnQgdHlwZSBNZXNzYWdlS2luZCA9IFwiaW5mb1wiIHwgXCJ3b3JraW5nXCIgfCBcInJlc3VsdFwiIHwgXCJlcnJvclwiO1xuZXhwb3J0IHR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IHN0cmluZztcbiAgd2hvOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAga2luZDogTWVzc2FnZUtpbmQ7XG4gIHRleHQ6IHN0cmluZztcbiAgZ3JvdW5kOiBzdHJpbmdbXTsgLy8gaXRlbSBpZHMgZ3JvdW5kaW5nIHRoaXMgbWVzc2FnZSAoc25hcHNob3Qgb2Ygc2VsZWN0ZWRJZHMpOyBbXSBpZiBub25lXG4gIHRzOiBudW1iZXI7XG59O1xuXG4vLyBBIGJyb3VnaHQtaW4gc3R5bGUncyBjYW5vbmljYWwgdGh1bWJuYWlsIChkYXRhLVVSTCBgc3JjYCDigJQgc3RyaXBwZWQgaW4gbGVhbikuXG5leHBvcnQgdHlwZSBDYW5vbkltZyA9IHsgdGl0bGU6IHN0cmluZzsgc3JjOiBzdHJpbmcgfTtcblxuLy8gQSBjYW5vbmljYWwgaW1hZ2UgaW5zaWRlIGEgU2F2ZWRTdHlsZTogdGhlIGJsb2IgaXMgY29waWVkIGludG8gdGhlIHN0eWxlJ3Ncbi8vIGRpciBvbiBzYXZlIGFuZCByZWZlcmVuY2VkIGJ5IGBmaWxlYCAoc28gdGhlIHNhdmVkIHN0eWxlIGlzIHNlbGYtY29udGFpbmVkKS5cbmV4cG9ydCB0eXBlIENhbm9uaWNhbFJlZiA9IHtcbiAgaWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZmlsZTogc3RyaW5nO1xuICBtaW1lOiBzdHJpbmc7XG59O1xuXG4vLyBBIHN0eWxlIHNhdmVkIHRvIHRoZSBwcm9qZWN0IHRyYXkg4oCUIGEgY29tcG91bmQgXCJjYW5vbmljYWwgc2hhcGVcIjogdGhlIGNvZGlmaWVkXG4vLyBzdHlsZS1ndWlkZSBzZWN0aW9ucyAodGV4dCkgKyBjYW5vbmljYWwgaW1hZ2VzLiBQcm9qZWN0LXNjb3BlZCwgbm9uLWRlc3RydWN0aXZlLlxuZXhwb3J0IHR5cGUgU2F2ZWRTdHlsZSA9IHtcbiAgaWQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nOyAvLyBzaG9ydCBodW1hbiBkZXNjcmlwdGlvbiAoZS5nLiB0aGUgVW5kZXJzdGFuZGluZy9EaXJlY3Rpb24gZ2lzdClcbiAgc2VjdGlvbnM6IFN0eWxlU2VjdGlvbltdOyAvLyB0aGUgY29kaWZpZWQgc3R5bGUgZ3VpZGUgYXQgc2F2ZSB0aW1lXG4gIGNhbm9uaWNhbDogQ2Fub25pY2FsUmVmW107XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBhcmNoaXZlZDogYm9vbGVhbjtcbn07XG5cbi8vIFRoZSBhZ2VudC1hc3NlbWJsZWQgc3R5bGUgZ3VpZGUuIFNlY3Rpb24gc2V0ICsgbGFiZWxzIGFyZSB0aGUgbW9ja3VwJ3Ncbi8vICh0aGUgY29udmVyZ2VkIHN1cmZhY2UpLiBTZWN0aW9ucyBmaWxsIGluOiBlbXB0eSDihpIgZm9ybWluZyDihpIgYWdyZWVkLlxuZXhwb3J0IHR5cGUgU2VjdGlvblN0YXR1cyA9IFwiZW1wdHlcIiB8IFwiZm9ybWluZ1wiIHwgXCJhZ3JlZWRcIjtcbmV4cG9ydCB0eXBlIFNlY3Rpb25LZXkgPVxuICB8IFwidW5kZXJzdGFuZGluZ1wiXG4gIHwgXCJkaXJlY3Rpb25cIlxuICB8IFwicGFsZXR0ZVwiXG4gIHwgXCJjb25zaXN0ZW5jeVwiXG4gIHwgXCJwcm9tcHRzXCJcbiAgfCBcImNhbm9uaWNhbFwiO1xuLy8gQSBwYWxldHRlIHN3YXRjaCDigJQgc3RydWN0dXJlZCBjb2xvciBmb3IgdGhlIFwicGFsZXR0ZVwiIHNlY3Rpb24uXG5leHBvcnQgdHlwZSBTd2F0Y2ggPSB7IGhleDogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH07XG5leHBvcnQgdHlwZSBTdHlsZVNlY3Rpb24gPSB7XG4gIGtleTogU2VjdGlvbktleTtcbiAgbGFiZWw6IHN0cmluZztcbiAgc3RhdHVzOiBTZWN0aW9uU3RhdHVzO1xuICBjb250ZW50OiBzdHJpbmc7IC8vIHByb3NlXG4gIHByb21wdHM6IHN0cmluZ1tdOyAvLyBwb3B1bGF0ZWQgZm9yIHRoZSBcInByb21wdHNcIiBzZWN0aW9uOyBbXSBlbHNld2hlcmVcbiAgY29sb3JzOiBTd2F0Y2hbXTsgLy8gcG9wdWxhdGVkIGZvciB0aGUgXCJwYWxldHRlXCIgc2VjdGlvbjsgW10gZWxzZXdoZXJlXG59O1xuXG4vLyBUaGUgem9vbS9mb2N1cyBjby1wcmVzZW5jZSBsZW5zLiBFaXRoZXIgcGFydHkgY2FuIHNjb3BlIHRoZSBzZXQuXG5leHBvcnQgdHlwZSBGb2N1c1Njb3BlID0gXCJhbGxcIiB8IFwiZm9jdXNcIjtcbmV4cG9ydCB0eXBlIEZvY3VzT3duZXIgPSBcInlvdVwiIHwgXCJhZ2VudFwiIHwgbnVsbDtcblxuZXhwb3J0IHR5cGUgR2xhbW91clN0YXRlID0ge1xuICB0aXRsZTogc3RyaW5nO1xuICBpbnRlbnQ6IHN0cmluZztcbiAgbGlicmFyeTogTGlicmFyeUl0ZW1bXTtcbiAgc2VsZWN0ZWRJZHM6IHN0cmluZ1tdOyAvLyBsaW5rZWQgc2V0IOKAlCB0aGUgZ3JvdW5kaW5nIHNldCAodW5zZWxlY3Qg4omgIGRlbGV0ZSlcbiAgbWVzc2FnZXM6IE1lc3NhZ2VbXTtcbiAgc3R5bGVHdWlkZTogU3R5bGVTZWN0aW9uW107XG4gIHRyYXk6IFNhdmVkU3R5bGVbXTtcbiAgc2NvcGU6IEZvY3VzU2NvcGU7XG4gIGZvY3VzU2V0OiBzdHJpbmdbXTsgLy8gaXRlbSBpZHMgaW4gdGhlIGZvY3VzZWQgc2V0OyBlbXB0eSB3aGVuIHNjb3BlID09PSBcImFsbFwiXG4gIGZvY3VzT3duZXI6IEZvY3VzT3duZXI7IC8vIHdobyBzY29wZWQgdGhlIGZvY3VzXG4gIGZvY3VzTm90ZTogc3RyaW5nOyAvLyBhZ2VudCdzIGNvbnRleHR1YWwgcXVlc3Rpb24gZm9yIHRoZSBmb2N1cyBkcmF3ZXI7IFwiXCIgb3RoZXJ3aXNlXG4gIHN0YXR1czogeyBidXN5OiBib29sZWFuOyB0ZXh0OiBzdHJpbmcgfTtcbn07XG5cbi8vIExlYW4gcHJvamVjdGlvbiBzZW50IHRvIHRoZSBhZ2VudDogYmxvYnMgc3RyaXBwZWQsIHBhdGhzIGtlcHQuXG5leHBvcnQgdHlwZSBMZWFuSXRlbSA9IE9taXQ8TGlicmFyeUl0ZW0sIFwic3JjXCIgfCBcInRleHRcIiB8IFwiY2Fub25cIj47XG5leHBvcnQgdHlwZSBMZWFuU3RhdGUgPSBPbWl0PEdsYW1vdXJTdGF0ZSwgXCJsaWJyYXJ5XCI+ICYge1xuICBsaWJyYXJ5OiBMZWFuSXRlbVtdO1xufTtcblxuLy8gU2VydmVyIOKGkiBicm93c2VyIChXZWJTb2NrZXQpLiBGdWxsLXN0YXRlIGJyb2FkY2FzdCBpcyB0aGUgb25seSBmcmFtZS5cbmV4cG9ydCB0eXBlIFNlcnZlclRvQ2xpZW50ID0geyB0eXBlOiBcInN0YXRlXCI7IHN0YXRlOiBHbGFtb3VyU3RhdGUgfTtcblxuLy8gQnJvd3NlciDihpIgc2VydmVyIChXZWJTb2NrZXQpLlxuZXhwb3J0IHR5cGUgQ2xpZW50VG9TZXJ2ZXIgPVxuICB8IHtcbiAgICAgIHR5cGU6IFwiaXRlbS5hZGRcIjtcbiAgICAgIGl0ZW06IHtcbiAgICAgICAga2luZDogXCJyZWZcIiB8IFwiY29udGV4dFwiO1xuICAgICAgICB0aXRsZTogc3RyaW5nO1xuICAgICAgICBzcmM/OiBzdHJpbmc7XG4gICAgICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgICAgIG1pbWU/OiBzdHJpbmc7XG4gICAgICB9O1xuICAgIH1cbiAgfCB7IHR5cGU6IFwiaXRlbS5zZWxlY3RcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5zdGFyXCI7IGlkOiBzdHJpbmc7IHN0YXJyZWQ6IGJvb2xlYW4gfSAvLyBhbWJpZW50XG4gIHwgeyB0eXBlOiBcIml0ZW0ubGlrZVwiOyBpZDogc3RyaW5nOyBsaWtlZDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiOyBpZDogc3RyaW5nOyBodW1hbjogc3RyaW5nIH0gLy8gYW1iaWVudCDigJQgc3RvcmVkICsgcmVhZCBvbiBkZW1hbmQsIG5vdCBwdXNoZWQgYXMgYW4gZXZlbnRcbiAgfCB7IHR5cGU6IFwibWVzc2FnZS5zZW5kXCI7IHRleHQ6IHN0cmluZyB9IC8vIGltcGVyYXRpdmVcbiAgfCB7IHR5cGU6IFwiZm9jdXMuc2V0XCI7IGlkczogc3RyaW5nW10gfSAvLyBhbWJpZW50IOKAlCBodW1hbiBzY29wZXMgYSBmb2N1cyBzZXRcbiAgfCB7IHR5cGU6IFwiZm9jdXMuY2xlYXJcIiB9IC8vIGFtYmllbnQg4oCUIGh1bWFuIHpvb21zIGJhY2sgb3V0XG4gIHwgeyB0eXBlOiBcIml0ZW0uY2Fub25pY2FsXCI7IGlkOiBzdHJpbmc7IGNhbm9uaWNhbDogYm9vbGVhbiB9IC8vIGFtYmllbnRcbiAgfCB7IHR5cGU6IFwiaXRlbS5hcmNoaXZlXCI7IGlkOiBzdHJpbmc7IGFyY2hpdmVkOiBib29sZWFuIH0gLy8gYW1iaWVudFxuICB8IHsgdHlwZTogXCJzdHlsZS5icmluZ0luXCI7IGlkOiBzdHJpbmcgfTsgLy8gaW1wZXJhdGl2ZSDigJQgYWRkcyBhIGtpbmQ6XCJzdHlsZVwiIGl0ZW1cblxuLy8gQWdlbnQg4oaSIHNlcnZlciAoSFRUUCBQT1NUIC9jbWQpLlxuZXhwb3J0IHR5cGUgQWdlbnRDb21tYW5kID1cbiAgfCB7IHR5cGU6IFwiaW5pdFwiOyB0aXRsZT86IHN0cmluZzsgaW50ZW50Pzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiaW50ZW50XCI7IHRleHQ6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcIml0ZW0uYW5ub3RhdGVcIjsgaWQ6IHN0cmluZzsgYWdlbnQ6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmc7IGtpbmQ/OiBNZXNzYWdlS2luZCB9XG4gIHwge1xuICAgICAgdHlwZTogXCJzZWN0aW9uXCI7XG4gICAgICBrZXk6IFNlY3Rpb25LZXk7XG4gICAgICBjb250ZW50Pzogc3RyaW5nO1xuICAgICAgc3RhdHVzPzogU2VjdGlvblN0YXR1cztcbiAgICAgIHByb21wdHM/OiBzdHJpbmdbXTtcbiAgICAgIGNvbG9ycz86IFN3YXRjaFtdO1xuICAgIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcImdlbi5hZGRcIjtcbiAgICAgIHNyYzogc3RyaW5nOyAvLyBhbiBBTFJFQURZLW9wdGltaXplZCB3ZWJwIGRhdGEtVVJMIChDTEkgZG9lcyB0aGUgb3B0aW1pemF0aW9uKVxuICAgICAgcHJvbXB0OiBzdHJpbmc7XG4gICAgICBtb2RlbDogc3RyaW5nO1xuICAgICAgcm91bmQ6IG51bWJlcjtcbiAgICAgIHNlZWQ/OiBudW1iZXI7XG4gICAgICBjb3N0PzogbnVtYmVyO1xuICAgICAgbGFiZWw/OiBzdHJpbmc7XG4gICAgICBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIH1cbiAgfCB7IHR5cGU6IFwiZ2VuLmNvc3RcIjsgaWQ6IHN0cmluZzsgY29zdDogbnVtYmVyIH0gLy8gYmFja2ZpbGwgY29zdCBvbmNlIG1lZGlhLWZvcmdlIGZpbmFsaXplcyBpdFxuICB8IHsgdHlwZTogXCJnZW4ubWV0YVwiOyBpZDogc3RyaW5nOyBwcm9tcHQ/OiBzdHJpbmc7IGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSAvLyBiYWNrZmlsbCB0aGUgcmVhbCBwcm9tcHQgLyByZWZzIG9udG8gYSBnZW5cbiAgfCB7IHR5cGU6IFwiZm9jdXMucHVzaFwiOyBpZHM6IHN0cmluZ1tdOyBub3RlPzogc3RyaW5nIH0gLy8gYWdlbnQgc2NvcGVzIGEgZm9jdXMgc2V0ICsgYXNrc1xuICB8IHsgdHlwZTogXCJzdHlsZS5zYXZlXCI7IGxhYmVsOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJzdHlsZS5hcmNoaXZlXCI7IGlkOiBzdHJpbmc7IGFyY2hpdmVkOiBib29sZWFuIH1cbiAgfCB7IHR5cGU6IFwic3RhdHVzXCI7IGJ1c3k6IGJvb2xlYW47IHRleHQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjbG9zZVwiIH07XG5cbi8vIFRoZSBjb21wbGV0ZSBhZ2VudC1ldmVudCBzZXQgKHNlcnZlciDihpIgYWdlbnQgU1NFKS4gT25seSB0aGVzZSBhcmUgZW1pdHRlZC5cbi8vIEltcGVyYXRpdmVzIG9ubHkg4oCUIGJvYXJkIG1vdmVzIChzZWxlY3Qvc3Rhci9saWtlKSBhcmUgYW1iaWVudC5cbmV4cG9ydCBjb25zdCBBR0VOVF9FVkVOVF9UWVBFUyA9IE9iamVjdC5mcmVlemUoW1xuICBcInJlYWR5XCIsXG4gIFwiY29ubmVjdGVkXCIsXG4gIFwiZGlzY29ubmVjdGVkXCIsXG4gIFwiaXRlbS5hZGRcIixcbiAgXCJtZXNzYWdlLnVzZXJcIixcbiAgXCJjbG9zZWRcIixcbl0gYXMgY29uc3QpO1xuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFR5cGUgPSAodHlwZW9mIEFHRU5UX0VWRU5UX1RZUEVTKVtudW1iZXJdO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0eWxlR3VpZGUoKTogU3R5bGVTZWN0aW9uW10ge1xuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIGtleTogXCJ1bmRlcnN0YW5kaW5nXCIsXG4gICAgICBsYWJlbDogXCJVbmRlcnN0YW5kaW5nXCIsXG4gICAgICBzdGF0dXM6IFwiZW1wdHlcIixcbiAgICAgIGNvbnRlbnQ6IFwiXCIsXG4gICAgICBwcm9tcHRzOiBbXSxcbiAgICAgIGNvbG9yczogW10sXG4gICAgfSxcbiAgICB7XG4gICAgICBrZXk6IFwiZGlyZWN0aW9uXCIsXG4gICAgICBsYWJlbDogXCJEaXJlY3Rpb25cIixcbiAgICAgIHN0YXR1czogXCJlbXB0eVwiLFxuICAgICAgY29udGVudDogXCJcIixcbiAgICAgIHByb21wdHM6IFtdLFxuICAgICAgY29sb3JzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGtleTogXCJwYWxldHRlXCIsXG4gICAgICBsYWJlbDogXCJQYWxldHRlXCIsXG4gICAgICBzdGF0dXM6IFwiZW1wdHlcIixcbiAgICAgIGNvbnRlbnQ6IFwiXCIsXG4gICAgICBwcm9tcHRzOiBbXSxcbiAgICAgIGNvbG9yczogW10sXG4gICAgfSxcbiAgICB7XG4gICAgICBrZXk6IFwiY29uc2lzdGVuY3lcIixcbiAgICAgIGxhYmVsOiBcIkNvbnNpc3RlbmN5XCIsXG4gICAgICBzdGF0dXM6IFwiZW1wdHlcIixcbiAgICAgIGNvbnRlbnQ6IFwiXCIsXG4gICAgICBwcm9tcHRzOiBbXSxcbiAgICAgIGNvbG9yczogW10sXG4gICAgfSxcbiAgICB7XG4gICAgICBrZXk6IFwicHJvbXB0c1wiLFxuICAgICAgbGFiZWw6IFwiUmUtY2FzdCBwcm9tcHRzXCIsXG4gICAgICBzdGF0dXM6IFwiZW1wdHlcIixcbiAgICAgIGNvbnRlbnQ6IFwiXCIsXG4gICAgICBwcm9tcHRzOiBbXSxcbiAgICAgIGNvbG9yczogW10sXG4gICAgfSxcbiAgICB7XG4gICAgICBrZXk6IFwiY2Fub25pY2FsXCIsXG4gICAgICBsYWJlbDogXCJDYW5vbmljYWwgaW1hZ2VzXCIsXG4gICAgICBzdGF0dXM6IFwiZW1wdHlcIixcbiAgICAgIGNvbnRlbnQ6IFwiXCIsXG4gICAgICBwcm9tcHRzOiBbXSxcbiAgICAgIGNvbG9yczogW10sXG4gICAgfSxcbiAgXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSh0aXRsZTogc3RyaW5nLCBpbnRlbnQ6IHN0cmluZyk6IEdsYW1vdXJTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgdGl0bGUsXG4gICAgaW50ZW50LFxuICAgIGxpYnJhcnk6IFtdLFxuICAgIHNlbGVjdGVkSWRzOiBbXSxcbiAgICBtZXNzYWdlczogW10sXG4gICAgc3R5bGVHdWlkZTogZGVmYXVsdFN0eWxlR3VpZGUoKSxcbiAgICB0cmF5OiBbXSxcbiAgICBzY29wZTogXCJhbGxcIixcbiAgICBmb2N1c1NldDogW10sXG4gICAgZm9jdXNPd25lcjogbnVsbCxcbiAgICBmb2N1c05vdGU6IFwiXCIsXG4gICAgc3RhdHVzOiB7IGJ1c3k6IGZhbHNlLCB0ZXh0OiBcIlwiIH0sXG4gIH07XG59XG4iLAogICAgImltcG9ydCB7IG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICBkZWZhdWx0U3RhdGUsXG4gIHR5cGUgR2xhbW91clN0YXRlLFxuICB0eXBlIExpYnJhcnlJdGVtLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5cbmNvbnN0IEVYVF9CWV9NSU1FOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcImltYWdlL3dlYnBcIjogXCJ3ZWJwXCIsXG4gIFwiaW1hZ2UvcG5nXCI6IFwicG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcImpwZ1wiLFxuICBcImltYWdlL2dpZlwiOiBcImdpZlwiLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVEYXRhVXJsKGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBkYXRhVXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gL15kYXRhOihbXjssXSspPyg7YmFzZTY0KT8sKC4qKSQvcy5leGVjKGRhdGFVcmwpO1xuICBpZiAoIW0gfHwgIWRpcikgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IG1pbWUgPSAobVsxXSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiKS50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBib2R5ID0gbVszXTtcbiAgY29uc3QgYnVmID0gbVsyXSA/IEJ1ZmZlci5mcm9tKGJvZHksIFwiYmFzZTY0XCIpIDogQnVmZmVyLmZyb20oZGVjb2RlVVJJQ29tcG9uZW50KGJvZHkpLCBcInV0ZjhcIik7XG4gIGNvbnN0IGV4dCA9IEVYVF9CWV9NSU1FW21pbWVdID8/IFwiYmluXCI7XG4gIGNvbnN0IHNhZmVJZCA9IGlkLnJlcGxhY2UoL1teYS16QS1aMC05Xy1dL2csIFwiX1wiKTtcbiAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBgJHtzYWZlSWR9LiR7ZXh0fWApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgYnVmKTtcbiAgICByZXR1cm4gcGF0aDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNhdmVUZXh0KGRpcjogc3RyaW5nLCBpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHNhZmUgPSBuYW1lLnJlcGxhY2UoL1teYS16QS1aMC05Ll8tXS9nLCBcIl9cIikgfHwgYCR7aWR9Lm1kYDtcbiAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBgJHtpZH0tJHtzYWZlfWApO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgdGV4dCwgXCJ1dGY4XCIpO1xuICAgIHJldHVybiBwYXRoO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVJdGVtKGZpbGVzRGlyOiBzdHJpbmcsIGl0ZW06IExpYnJhcnlJdGVtKTogdm9pZCB7XG4gIGlmIChpdGVtLnNyYykge1xuICAgIGNvbnN0IHAgPSBzYXZlRGF0YVVybChmaWxlc0RpciwgaXRlbS5pZCwgaXRlbS5zcmMpO1xuICAgIGlmIChwKSBpdGVtLnBhdGggPSBwO1xuICB9IGVsc2UgaWYgKGl0ZW0udGV4dCkge1xuICAgIGNvbnN0IHAgPSBzYXZlVGV4dChmaWxlc0RpciwgaXRlbS5pZCwgaXRlbS50aXRsZSwgaXRlbS50ZXh0KTtcbiAgICBpZiAocCkgaXRlbS5wYXRoID0gcDtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVNuYXBzaG90KHNuYXBzaG90c0Rpcjogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZywgc3RhdGU6IEdsYW1vdXJTdGF0ZSk6IHZvaWQge1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhzbmFwc2hvdHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbmFwc2hvdHNEaXIsIGAke3Nlc3Npb25JZH0uanNvbmApLCBKU09OLnN0cmluZ2lmeShzdGF0ZSkpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBwZXJzaXN0ZW5jZSBpcyBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkU25hcHNob3QocGF0aDogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBpbnRlbnQ6IHN0cmluZyk6IEdsYW1vdXJTdGF0ZSB7XG4gIGNvbnN0IHNuYXAgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpIGFzIFBhcnRpYWw8R2xhbW91clN0YXRlPjtcbiAgLy8gTWVyZ2Ugb3ZlciBkZWZhdWx0cyBzbyBvbGRlciBzbmFwc2hvdHMgZ2FpbiBuZXcgdG9wLWxldmVsIGZpZWxkcy5cbiAgY29uc3QgbWVyZ2VkID0geyAuLi5kZWZhdWx0U3RhdGUodGl0bGUsIGludGVudCksIC4uLnNuYXAgfSBhcyBHbGFtb3VyU3RhdGU7XG4gIC8vIE5vcm1hbGl6ZSBzdHlsZS1ndWlkZSBzZWN0aW9ucyBzbyBzbmFwc2hvdHMgcHJlZGF0aW5nIG5ld2VyIHBlci1zZWN0aW9uXG4gIC8vIGZpZWxkcyAocHJvbXB0cywgY29sb3JzKSBzdGlsbCBzYXRpc2Z5IHRoZSBjdXJyZW50IHNoYXBlLlxuICBtZXJnZWQuc3R5bGVHdWlkZSA9IG1lcmdlZC5zdHlsZUd1aWRlLm1hcCgocykgPT4gKHtcbiAgICAuLi5zLFxuICAgIHByb21wdHM6IHMucHJvbXB0cyA/PyBbXSxcbiAgICBjb2xvcnM6IHMuY29sb3JzID8/IFtdLFxuICB9KSk7XG4gIHJldHVybiBtZXJnZWQ7XG59XG4iLAogICAgImltcG9ydCB0eXBlIHtcbiAgQWdlbnRDb21tYW5kLFxuICBDYW5vbkltZyxcbiAgR2VuTWV0YSxcbiAgR2xhbW91clN0YXRlLFxuICBJdGVtS2luZCxcbiAgTGVhbkl0ZW0sXG4gIExlYW5TdGF0ZSxcbiAgTGlicmFyeUl0ZW0sXG4gIE1lc3NhZ2UsXG4gIFNhdmVkU3R5bGUsXG4gIFNlY3Rpb25LZXksXG4gIFNlY3Rpb25TdGF0dXMsXG4gIFN3YXRjaCxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC90eXBlc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gbWFrZUl0ZW0ocDoge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBJdGVtS2luZDtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3JjPzogc3RyaW5nO1xuICBwYXRoPzogc3RyaW5nO1xuICB0ZXh0Pzogc3RyaW5nO1xuICBtaW1lPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICBnZW4/OiBHZW5NZXRhIHwgbnVsbDtcbn0pOiBMaWJyYXJ5SXRlbSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IHAuaWQsXG4gICAga2luZDogcC5raW5kLFxuICAgIHRpdGxlOiBwLnRpdGxlLFxuICAgIHNyYzogcC5zcmMgPz8gXCJcIixcbiAgICBwYXRoOiBwLnBhdGggPz8gXCJcIixcbiAgICB0ZXh0OiBwLnRleHQgPz8gXCJcIixcbiAgICBtaW1lOiBwLm1pbWUgPz8gXCJcIixcbiAgICB0YWdzOiBwLnRhZ3MgPz8gW10sXG4gICAgc3RhcnJlZDogZmFsc2UsXG4gICAgbGlrZWQ6IGZhbHNlLFxuICAgIGFubm90YXRpb25zOiB7IGFnZW50OiBcIlwiLCBodW1hbjogXCJcIiB9LFxuICAgIGNhbm9uaWNhbDogZmFsc2UsXG4gICAgY2Fub246IFtdLFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgICBjcmVhdGVkQXQ6IHAuY3JlYXRlZEF0LFxuICAgIGdlbjogcC5nZW4gPz8gbnVsbCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEl0ZW0oc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaXRlbTogTGlicmFyeUl0ZW0pOiBib29sZWFuIHtcbiAgaWYgKHN0YXRlLmxpYnJhcnkuc29tZSgoaSkgPT4gaS5pZCA9PT0gaXRlbS5pZCkpIHJldHVybiBmYWxzZTtcbiAgc3RhdGUubGlicmFyeS5wdXNoKGl0ZW0pO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdEl0ZW1zKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkczogc3RyaW5nW10pOiB2b2lkIHtcbiAgc3RhdGUuc2VsZWN0ZWRJZHMgPSBbLi4uaWRzXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0YXIoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgc3RhcnJlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0KSByZXR1cm4gZmFsc2U7XG4gIGl0LnN0YXJyZWQgPSBzdGFycmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldExpa2Uoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgbGlrZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IGlkKTtcbiAgaWYgKCFpdCkgcmV0dXJuIGZhbHNlO1xuICBpdC5saWtlZCA9IGxpa2VkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFubm90YXRlKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZDogc3RyaW5nLFxuICB3aG86IFwiYWdlbnRcIiB8IFwiaHVtYW5cIixcbiAgdGV4dDogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuYW5ub3RhdGlvbnNbd2hvXSA9IHRleHQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTWVzc2FnZShzdGF0ZTogR2xhbW91clN0YXRlLCBtOiBNZXNzYWdlKTogdm9pZCB7XG4gIHN0YXRlLm1lc3NhZ2VzLnB1c2gobSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZWN0aW9uKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBrZXk6IFNlY3Rpb25LZXksXG4gIHBhdGNoOiB7IGNvbnRlbnQ/OiBzdHJpbmc7IHN0YXR1cz86IFNlY3Rpb25TdGF0dXM7IHByb21wdHM/OiBzdHJpbmdbXTsgY29sb3JzPzogU3dhdGNoW10gfSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBzZWMgPSBzdGF0ZS5zdHlsZUd1aWRlLmZpbmQoKHMpID0+IHMua2V5ID09PSBrZXkpO1xuICBpZiAoIXNlYykgcmV0dXJuIGZhbHNlO1xuICBpZiAocGF0Y2guY29udGVudCAhPT0gdW5kZWZpbmVkKSBzZWMuY29udGVudCA9IHBhdGNoLmNvbnRlbnQ7XG4gIGlmIChwYXRjaC5zdGF0dXMgIT09IHVuZGVmaW5lZCkgc2VjLnN0YXR1cyA9IHBhdGNoLnN0YXR1cztcbiAgaWYgKHBhdGNoLnByb21wdHMgIT09IHVuZGVmaW5lZCkgc2VjLnByb21wdHMgPSBwYXRjaC5wcm9tcHRzO1xuICBpZiAocGF0Y2guY29sb3JzICE9PSB1bmRlZmluZWQpIHNlYy5jb2xvcnMgPSBwYXRjaC5jb2xvcnM7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0Rm9jdXMoXG4gIHN0YXRlOiBHbGFtb3VyU3RhdGUsXG4gIGlkczogc3RyaW5nW10sXG4gIG93bmVyOiBcInlvdVwiIHwgXCJhZ2VudFwiLFxuICBub3RlID0gXCJcIixcbik6IHZvaWQge1xuICBzdGF0ZS5zY29wZSA9IFwiZm9jdXNcIjtcbiAgc3RhdGUuZm9jdXNTZXQgPSBbLi4uaWRzXTtcbiAgc3RhdGUuZm9jdXNPd25lciA9IG93bmVyO1xuICBzdGF0ZS5mb2N1c05vdGUgPSBub3RlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJGb2N1cyhzdGF0ZTogR2xhbW91clN0YXRlKTogdm9pZCB7XG4gIHN0YXRlLnNjb3BlID0gXCJhbGxcIjtcbiAgc3RhdGUuZm9jdXNTZXQgPSBbXTtcbiAgc3RhdGUuZm9jdXNPd25lciA9IG51bGw7XG4gIHN0YXRlLmZvY3VzTm90ZSA9IFwiXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDYW5vbmljYWwoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgY2Fub25pY2FsOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuY2Fub25pY2FsID0gY2Fub25pY2FsO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFyY2hpdmVUcmF5U3R5bGUoc3RhdGU6IEdsYW1vdXJTdGF0ZSwgaWQ6IHN0cmluZywgYXJjaGl2ZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc3QgPSBzdGF0ZS50cmF5LmZpbmQoKHMpID0+IHMuaWQgPT09IGlkKTtcbiAgaWYgKCFzdCkgcmV0dXJuIGZhbHNlO1xuICBzdC5hcmNoaXZlZCA9IGFyY2hpdmVkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU3R5bGVJdGVtKFxuICBzdHlsZTogU2F2ZWRTdHlsZSxcbiAgY2Fub246IENhbm9uSW1nW10sXG4gIGNyZWF0ZWRBdDogbnVtYmVyLFxuKTogTGlicmFyeUl0ZW0ge1xuICByZXR1cm4ge1xuICAgIGlkOiBgc3R5bGUtJHtzdHlsZS5pZH1gLFxuICAgIGtpbmQ6IFwic3R5bGVcIixcbiAgICB0aXRsZTogc3R5bGUubGFiZWwsXG4gICAgc3JjOiBcIlwiLFxuICAgIHBhdGg6IFwiXCIsXG4gICAgdGV4dDogc3R5bGUudGV4dCxcbiAgICBtaW1lOiBcIlwiLFxuICAgIHRhZ3M6IFtdLFxuICAgIHN0YXJyZWQ6IGZhbHNlLFxuICAgIGxpa2VkOiBmYWxzZSxcbiAgICBhbm5vdGF0aW9uczogeyBhZ2VudDogXCJcIiwgaHVtYW46IFwiXCIgfSxcbiAgICBjYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uLFxuICAgIGFyY2hpdmVkOiBmYWxzZSxcbiAgICBjcmVhdGVkQXQsXG4gICAgZ2VuOiBudWxsLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0SXRlbUFyY2hpdmVkKHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGFyY2hpdmVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGl0ID0gc3RhdGUubGlicmFyeS5maW5kKChpKSA9PiBpLmlkID09PSBpZCk7XG4gIGlmICghaXQpIHJldHVybiBmYWxzZTtcbiAgaXQuYXJjaGl2ZWQgPSBhcmNoaXZlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRHZW5Db3N0KHN0YXRlOiBHbGFtb3VyU3RhdGUsIGlkOiBzdHJpbmcsIGNvc3Q6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0Py5nZW4pIHJldHVybiBmYWxzZTtcbiAgaXQuZ2VuLmNvc3QgPSBjb3N0O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gQmFja2ZpbGwgdGhlIHJlYWwgcHJvbXB0IGFuZC9vciByZWZzIG9udG8gYSBnZW4gYWZ0ZXIgdGhlIGZhY3QsIHNvIGl0cyBzdG9yZWRcbi8vIG1ldGFkYXRhIGlzIHRoZSByZXByb2R1Y2libGUgcHJvbXB0IChub3QgYSBsYWJlbCkg4oCUIG5vIHNlc3Npb24gYm91bmNlIG5lZWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBzZXRHZW5NZXRhKFxuICBzdGF0ZTogR2xhbW91clN0YXRlLFxuICBpZDogc3RyaW5nLFxuICBwYXRjaDogeyBwcm9tcHQ/OiBzdHJpbmc7IGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBpdCA9IHN0YXRlLmxpYnJhcnkuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0Py5nZW4pIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiBwYXRjaC5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGl0Lmdlbi5wcm9tcHQgPSBwYXRjaC5wcm9tcHQ7XG4gIGlmIChwYXRjaC5jdXN0b20pIGl0Lmdlbi5jdXN0b20gPSB7IC4uLihpdC5nZW4uY3VzdG9tID8/IHt9KSwgLi4ucGF0Y2guY3VzdG9tIH07XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGVhbkl0ZW0oaXQ6IExpYnJhcnlJdGVtKTogTGVhbkl0ZW0ge1xuICBjb25zdCB7IHNyYzogX3MsIHRleHQ6IF90LCBjYW5vbjogX2MsIC4uLnJlc3QgfSA9IGl0O1xuICByZXR1cm4gcmVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5TdGF0ZShzOiBHbGFtb3VyU3RhdGUpOiBMZWFuU3RhdGUge1xuICByZXR1cm4geyAuLi5zLCBsaWJyYXJ5OiBzLmxpYnJhcnkubWFwKGxlYW5JdGVtKSB9O1xufVxuXG4vLyBCb2FyZCBtb3ZlcyB0aGF0IG11dGF0ZSBzdGF0ZSArIGJyb2FkY2FzdCBidXQgZW1pdCBOTyBhZ2VudCBldmVudC5cbmV4cG9ydCBjb25zdCBBTUJJRU5UX0NMSUVOVCA9IG5ldyBTZXQ8c3RyaW5nPihbXG4gIFwiaXRlbS5zZWxlY3RcIixcbiAgXCJpdGVtLnN0YXJcIixcbiAgXCJpdGVtLmxpa2VcIixcbiAgXCJmb2N1cy5zZXRcIixcbiAgXCJmb2N1cy5jbGVhclwiLFxuICBcIml0ZW0uY2Fub25pY2FsXCIsXG4gIFwiaXRlbS5hcmNoaXZlXCIsXG4gIFwiaXRlbS5hbm5vdGF0ZVwiLCAvLyBhIHBlci1pdGVtIG5vdGU6IHN0b3JlZCArIHJlYWQgb24gZGVtYW5kLCBub3QgcHVzaGVkIGFzIGFuIGV2ZW50XG5dKTtcbmV4cG9ydCBmdW5jdGlvbiBpc0ltcGVyYXRpdmUodHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAhQU1CSUVOVF9DTElFTlQuaGFzKHR5cGUpO1xufVxuXG4vLyBSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbW1hbmQgdHlwZSB3YXMgUkVDT0dOSVNFRCDigJQgdGhlIHZlcmRpY3QgdGhlIC9jbWQgcm91dGVcbi8vIHByb3BhZ2F0ZXMgKCM4NCkuIFJlY29nbmlzZWQtYW5kLWFwcGxpZWQgaXMgYHRydWVgOyBhbiB1bmtub3duIHR5cGUgaXNcbi8vIGBmYWxzZWAuIFRoaXMgaXMgZGVsaWJlcmF0ZWx5IG5vdCBcImRpZCBzdGF0ZSBjaGFuZ2VcIjogYSByZWNvZ25pc2VkIGNvbW1hbmRcbi8vIHRoYXQgaXMgYSBsZWdpdGltYXRlIG5vLW9wIHN0aWxsIGFwcGxpZWQuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlBZ2VudE1zZyhzdGF0ZTogR2xhbW91clN0YXRlLCBtc2c6IEFnZW50Q29tbWFuZCk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgY2FzZSBcImluaXRcIjpcbiAgICAgIGlmICh0eXBlb2YgbXNnLnRpdGxlID09PSBcInN0cmluZ1wiKSBzdGF0ZS50aXRsZSA9IG1zZy50aXRsZTtcbiAgICAgIGlmICh0eXBlb2YgbXNnLmludGVudCA9PT0gXCJzdHJpbmdcIikgc3RhdGUuaW50ZW50ID0gbXNnLmludGVudDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpbnRlbnRcIjpcbiAgICAgIHN0YXRlLmludGVudCA9IG1zZy50ZXh0O1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcIml0ZW0uYW5ub3RhdGVcIjoge1xuICAgICAgY29uc3QgaXQgPSBzdGF0ZS5saWJyYXJ5LmZpbmQoKGkpID0+IGkuaWQgPT09IG1zZy5pZCk7XG4gICAgICBpZiAoaXQpIGl0LmFubm90YXRpb25zLmFnZW50ID0gbXNnLmFnZW50O1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJzZWN0aW9uXCI6XG4gICAgICB1cGRhdGVTZWN0aW9uKHN0YXRlLCBtc2cua2V5LCB7XG4gICAgICAgIGNvbnRlbnQ6IG1zZy5jb250ZW50LFxuICAgICAgICBzdGF0dXM6IG1zZy5zdGF0dXMsXG4gICAgICAgIHByb21wdHM6IG1zZy5wcm9tcHRzLFxuICAgICAgICBjb2xvcnM6IG1zZy5jb2xvcnMsXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJmb2N1cy5wdXNoXCI6XG4gICAgICBzZXRGb2N1cyhzdGF0ZSwgbXNnLmlkcywgXCJhZ2VudFwiLCBtc2cubm90ZSA/PyBcIlwiKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJnZW4uY29zdFwiOlxuICAgICAgc2V0R2VuQ29zdChzdGF0ZSwgbXNnLmlkLCBtc2cuY29zdCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZ2VuLm1ldGFcIjpcbiAgICAgIHNldEdlbk1ldGEoc3RhdGUsIG1zZy5pZCwgeyBwcm9tcHQ6IG1zZy5wcm9tcHQsIGN1c3RvbTogbXNnLmN1c3RvbSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIHN0YXRlLnN0YXR1cyA9IHsgYnVzeTogbXNnLmJ1c3ksIHRleHQ6IG1zZy50ZXh0ID8/IFwiXCIgfTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdHlsZS5hcmNoaXZlXCI6XG4gICAgICBhcmNoaXZlVHJheVN0eWxlKHN0YXRlLCBtc2cuaWQsIG1zZy5hcmNoaXZlZCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2F5XCI6XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBicmVhazsgLy8gaGFuZGxlZCBieSB0aGUgc2VydmVyIChhcHBlbmRlZCB0byBjb252ZXJzYXRpb24gLyBzaHV0ZG93bilcbiAgICBkZWZhdWx0OlxuICAgICAgLy8gIzg0IOKAlCB0aGUgc3dpdGNoIGhhZCBOTyBkZWZhdWx0LCBzbyBhbiB1bnJlY29nbmlzZWQgY29tbWFuZCB0eXBlIGRpZFxuICAgICAgLy8gbm90aGluZyBhbmQgdGhlIC9jbWQgcm91dGUgc3RpbGwgYW5zd2VyZWQge29rOnRydWV9OiBhIGJvZ3VzIHR5cGUgd2FzXG4gICAgICAvLyBieXRlLWlkZW50aWNhbCB0byBhbiBleGVjdXRlZCBvbmUuIFRoZSB2ZXJkaWN0IGhhcyB0byBiZSBwcm9kdWNlZCBIRVJFLFxuICAgICAgLy8gYnkgdGhlIGNvZGUgdGhhdCBhY3R1YWxseSBrbm93cyB0aGUgcmVjb2duaXNlZCBzZXQsIGFuZCBub3QgbWlycm9yZWRcbiAgICAgIC8vIGludG8gYSBsaXN0IGJlc2lkZSB0aGUgc3dpdGNoIOKAlCBhIGhhbmQtbWFpbnRhaW5lZCBtaXJyb3Igb2YgYSBjYXNlIGxpc3RcbiAgICAgIC8vIGRyaWZ0cyBzaWxlbnRseSB0aGUgbW9tZW50IGEgY2FzZSBpcyBhZGRlZCwgd2hpY2ggaXMgYSBkZWZlY3QgdGhpcyByZXBvXG4gICAgICAvLyBoYXMgYWxyZWFkeSBzaGlwcGVkIHR3aWNlLlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuIiwKICAgICIvLyBTZXJ2ZXIvQ0xJLW9ubHk6IHRoZSBwcm9qZWN0LXNjb3BlZCBzdHlsZSBzdG9yZS4gRG8gTk9UIGltcG9ydCBmcm9tIGJyb3dzZXJcbi8vIGNvZGUgKGZpbGVzeXN0ZW0gYWNjZXNzKS4gU3R5bGVzIGxpdmUgdW5kZXIgJHtob21lfS9zdHlsZXMvJHtwcm9qZWN0S2V5fS8sXG4vLyBrZXllZCB0byB0aGUgY2hlY2tvdXQgd2hlcmUgdGhlIHNwZWxsIHdhcyBjYXN0LlxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUge1xuICBDYW5vbkltZyxcbiAgQ2Fub25pY2FsUmVmLFxuICBMaWJyYXJ5SXRlbSxcbiAgU2F2ZWRTdHlsZSxcbiAgU3R5bGVTZWN0aW9uLFxufSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL3R5cGVzXCI7XG5cbmNvbnN0IEVYVF9CWV9NSU1FOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcImltYWdlL3dlYnBcIjogXCJ3ZWJwXCIsXG4gIFwiaW1hZ2UvcG5nXCI6IFwicG5nXCIsXG4gIFwiaW1hZ2UvanBlZ1wiOiBcImpwZ1wiLFxuICBcImltYWdlL2dpZlwiOiBcImdpZlwiLFxufTtcblxuLy8gQSBzdGFibGUsIGZpbGVzeXN0ZW0tc2FmZSBrZXk6IHNhbml0aXplZCBiYXNlIG5hbWUgKyBhIHNob3J0IGhhc2ggb2YgdGhlIGZ1bGxcbi8vIGFic29sdXRlIHBhdGggKHNvIHR3byBjaGVja291dHMgd2l0aCB0aGUgc2FtZSBmb2xkZXIgbmFtZSBkb24ndCBjb2xsaWRlKS5cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0S2V5KHByb2plY3REaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBiYXNlbmFtZShwcm9qZWN0RGlyKS5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIikgfHwgXCJyb290XCI7XG4gIGxldCBoID0gNTM4MTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwcm9qZWN0RGlyLmxlbmd0aDsgaSsrKSBoID0gKChoIDw8IDUpICsgaCArIHByb2plY3REaXIuY2hhckNvZGVBdChpKSkgPj4+IDA7XG4gIHJldHVybiBgJHtiYXNlfS0ke2gudG9TdHJpbmcoMzYpfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdHlsZXNEaXIoaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGhvbWUsIFwic3R5bGVzXCIsIGtleSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYXZlU3R5bGUoXG4gIGhvbWU6IHN0cmluZyxcbiAga2V5OiBzdHJpbmcsXG4gIGFyZ3M6IHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGxhYmVsOiBzdHJpbmc7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIHNlY3Rpb25zOiBTdHlsZVNlY3Rpb25bXTtcbiAgICBjYW5vbmljYWxJdGVtczogTGlicmFyeUl0ZW1bXTtcbiAgICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgfSxcbik6IFNhdmVkU3R5bGUge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNhbm9uaWNhbDogQ2Fub25pY2FsUmVmW10gPSBbXTtcbiAgZm9yIChjb25zdCBpdCBvZiBhcmdzLmNhbm9uaWNhbEl0ZW1zKSB7XG4gICAgaWYgKCFpdC5wYXRoIHx8ICFleGlzdHNTeW5jKGl0LnBhdGgpKSBjb250aW51ZTtcbiAgICBjb25zdCBleHQgPSBFWFRfQllfTUlNRVtpdC5taW1lXSA/PyBcImJpblwiO1xuICAgIGNvbnN0IGZpbGUgPSBgJHthcmdzLmlkfS0ke2l0LmlkfS4ke2V4dH1gO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBmaWxlKSwgcmVhZEZpbGVTeW5jKGl0LnBhdGgpKTtcbiAgICAgIGNhbm9uaWNhbC5wdXNoKHsgaWQ6IGl0LmlkLCB0aXRsZTogaXQudGl0bGUsIGZpbGUsIG1pbWU6IGl0Lm1pbWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBza2lwIGFuIHVucmVhZGFibGUgYmxvYiAqL1xuICAgIH1cbiAgfVxuICBjb25zdCBzdHlsZTogU2F2ZWRTdHlsZSA9IHtcbiAgICBpZDogYXJncy5pZCxcbiAgICBsYWJlbDogYXJncy5sYWJlbCxcbiAgICB0ZXh0OiBhcmdzLnRleHQsXG4gICAgc2VjdGlvbnM6IGFyZ3Muc2VjdGlvbnMsXG4gICAgY2Fub25pY2FsLFxuICAgIGNyZWF0ZWRBdDogYXJncy5jcmVhdGVkQXQsXG4gICAgYXJjaGl2ZWQ6IGZhbHNlLFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHthcmdzLmlkfS5qc29uYCksIEpTT04uc3RyaW5naWZ5KHN0eWxlKSk7XG4gIHJldHVybiBzdHlsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRUcmF5KGhvbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBTYXZlZFN0eWxlW10ge1xuICBjb25zdCBkaXIgPSBzdHlsZXNEaXIoaG9tZSwga2V5KTtcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHJldHVybiBbXTtcbiAgY29uc3Qgb3V0OiBTYXZlZFN0eWxlW10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKGRpcikpIHtcbiAgICBpZiAoIW5hbWUuZW5kc1dpdGgoXCIuanNvblwiKSkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIG91dC5wdXNoKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBuYW1lKSwgXCJ1dGY4XCIpKSBhcyBTYXZlZFN0eWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgYSBjb3JydXB0IHJlY29yZCAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IGEuY3JlYXRlZEF0IC0gYi5jcmVhdGVkQXQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U3R5bGVBcmNoaXZlZChcbiAgaG9tZTogc3RyaW5nLFxuICBrZXk6IHN0cmluZyxcbiAgaWQ6IHN0cmluZyxcbiAgYXJjaGl2ZWQ6IGJvb2xlYW4sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgcGF0aCA9IGpvaW4oc3R5bGVzRGlyKGhvbWUsIGtleSksIGAke2lkfS5qc29uYCk7XG4gIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHN0eWxlID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKSBhcyBTYXZlZFN0eWxlO1xuICAgIHN0eWxlLmFyY2hpdmVkID0gYXJjaGl2ZWQ7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCBKU09OLnN0cmluZ2lmeShzdHlsZSkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGVyaWFsaXplQ2Fub24oaG9tZTogc3RyaW5nLCBrZXk6IHN0cmluZywgc3R5bGU6IFNhdmVkU3R5bGUpOiBDYW5vbkltZ1tdIHtcbiAgY29uc3QgZGlyID0gc3R5bGVzRGlyKGhvbWUsIGtleSk7XG4gIGNvbnN0IG91dDogQ2Fub25JbWdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJlZiBvZiBzdHlsZS5jYW5vbmljYWwpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYnl0ZXMgPSByZWFkRmlsZVN5bmMoam9pbihkaXIsIHJlZi5maWxlKSk7XG4gICAgICBvdXQucHVzaCh7XG4gICAgICAgIHRpdGxlOiByZWYudGl0bGUsXG4gICAgICAgIHNyYzogYGRhdGE6JHtyZWYubWltZX07YmFzZTY0LCR7Ynl0ZXMudG9TdHJpbmcoXCJiYXNlNjRcIil9YCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhIG1pc3NpbmcgYmxvYiAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQUFBO0FBQUEsZ0JBQ0U7QUFBQSxlQUNBO0FBQUEsa0JBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQSxtQkFJQTtBQUFBO0FBRUY7QUFDQSwwQkFBa0I7QUFDbEI7QUFDQSxzQkFBUzs7O0FDMEtGLElBQU0sb0JBQW9CLE9BQU8sT0FBTztBQUFBLEVBQzdDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFVO0FBR0gsU0FBUyxpQkFBaUIsR0FBbUI7QUFBQSxFQUNsRCxPQUFPO0FBQUEsSUFDTDtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsSUFDQTtBQUFBLE1BQ0UsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLE1BQ1QsU0FBUyxDQUFDO0FBQUEsTUFDVixRQUFRLENBQUM7QUFBQSxJQUNYO0FBQUEsRUFDRjtBQUFBO0FBR0ssU0FBUyxZQUFZLENBQUMsT0FBZSxRQUE4QjtBQUFBLEVBQ3hFLE9BQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0EsU0FBUyxDQUFDO0FBQUEsSUFDVixhQUFhLENBQUM7QUFBQSxJQUNkLFVBQVUsQ0FBQztBQUFBLElBQ1gsWUFBWSxrQkFBa0I7QUFBQSxJQUM5QixNQUFNLENBQUM7QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLFVBQVUsQ0FBQztBQUFBLElBQ1gsWUFBWTtBQUFBLElBQ1osV0FBVztBQUFBLElBQ1gsUUFBUSxFQUFFLE1BQU0sT0FBTyxNQUFNLEdBQUc7QUFBQSxFQUNsQztBQUFBOzs7QUNuUUY7QUFDQTtBQU9BLElBQU0sY0FBc0M7QUFBQSxFQUMxQyxjQUFjO0FBQUEsRUFDZCxhQUFhO0FBQUEsRUFDYixjQUFjO0FBQUEsRUFDZCxhQUFhO0FBQ2Y7QUFFTyxTQUFTLFdBQVcsQ0FBQyxLQUFhLElBQVksU0FBeUI7QUFBQSxFQUM1RSxNQUFNLElBQUksbUNBQW1DLEtBQUssT0FBTztBQUFBLEVBQ3pELElBQUksQ0FBQyxLQUFLLENBQUM7QUFBQSxJQUFLLE9BQU87QUFBQSxFQUN2QixNQUFNLFFBQVEsRUFBRSxNQUFNLDRCQUE0QixZQUFZO0FBQUEsRUFDOUQsTUFBTSxPQUFPLEVBQUU7QUFBQSxFQUNmLE1BQU0sTUFBTSxFQUFFLEtBQUssT0FBTyxLQUFLLE1BQU0sUUFBUSxJQUFJLE9BQU8sS0FBSyxtQkFBbUIsSUFBSSxHQUFHLE1BQU07QUFBQSxFQUM3RixNQUFNLE1BQU0sWUFBWSxTQUFTO0FBQUEsRUFDakMsTUFBTSxTQUFTLEdBQUcsUUFBUSxtQkFBbUIsR0FBRztBQUFBLEVBQ2hELE1BQU0sT0FBTyxLQUFLLEtBQUssR0FBRyxVQUFVLEtBQUs7QUFBQSxFQUN6QyxJQUFJO0FBQUEsSUFDRixVQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLElBQ2xDLGNBQWMsTUFBTSxHQUFHO0FBQUEsSUFDdkIsT0FBTztBQUFBLElBQ1AsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBO0FBQUE7QUFJSixTQUFTLFFBQVEsQ0FBQyxLQUFhLElBQVksTUFBYyxNQUFzQjtBQUFBLEVBQ3BGLE1BQU0sT0FBTyxLQUFLLFFBQVEsb0JBQW9CLEdBQUcsS0FBSyxHQUFHO0FBQUEsRUFDekQsTUFBTSxPQUFPLEtBQUssS0FBSyxHQUFHLE1BQU0sTUFBTTtBQUFBLEVBQ3RDLElBQUk7QUFBQSxJQUNGLFVBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsSUFDbEMsY0FBYyxNQUFNLE1BQU0sTUFBTTtBQUFBLElBQ2hDLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBO0FBSUosU0FBUyxlQUFlLENBQUMsVUFBa0IsTUFBeUI7QUFBQSxFQUN6RSxJQUFJLEtBQUssS0FBSztBQUFBLElBQ1osTUFBTSxJQUFJLFlBQVksVUFBVSxLQUFLLElBQUksS0FBSyxHQUFHO0FBQUEsSUFDakQsSUFBSTtBQUFBLE1BQUcsS0FBSyxPQUFPO0FBQUEsRUFDckIsRUFBTyxTQUFJLEtBQUssTUFBTTtBQUFBLElBQ3BCLE1BQU0sSUFBSSxTQUFTLFVBQVUsS0FBSyxJQUFJLEtBQUssT0FBTyxLQUFLLElBQUk7QUFBQSxJQUMzRCxJQUFJO0FBQUEsTUFBRyxLQUFLLE9BQU87QUFBQSxFQUNyQjtBQUFBO0FBR0ssU0FBUyxZQUFZLENBQUMsY0FBc0IsV0FBbUIsT0FBMkI7QUFBQSxFQUMvRixJQUFJO0FBQUEsSUFDRixVQUFVLGNBQWMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLElBQzNDLGNBQWMsS0FBSyxjQUFjLEdBQUcsZ0JBQWdCLEdBQUcsS0FBSyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzVFLE1BQU07QUFBQTtBQUtILFNBQVMsWUFBWSxDQUFDLE1BQWMsT0FBZSxRQUE4QjtBQUFBLEVBQ3RGLE1BQU0sT0FBTyxLQUFLLE1BQU0sYUFBYSxNQUFNLE1BQU0sQ0FBQztBQUFBLEVBRWxELE1BQU0sU0FBUyxLQUFLLGFBQWEsT0FBTyxNQUFNLE1BQU0sS0FBSztBQUFBLEVBR3pELE9BQU8sYUFBYSxPQUFPLFdBQVcsSUFBSSxDQUFDLE9BQU87QUFBQSxPQUM3QztBQUFBLElBQ0gsU0FBUyxFQUFFLFdBQVcsQ0FBQztBQUFBLElBQ3ZCLFFBQVEsRUFBRSxVQUFVLENBQUM7QUFBQSxFQUN2QixFQUFFO0FBQUEsRUFDRixPQUFPO0FBQUE7OztBQzNERixTQUFTLFFBQVEsQ0FBQyxHQVdUO0FBQUEsRUFDZCxPQUFPO0FBQUEsSUFDTCxJQUFJLEVBQUU7QUFBQSxJQUNOLE1BQU0sRUFBRTtBQUFBLElBQ1IsT0FBTyxFQUFFO0FBQUEsSUFDVCxLQUFLLEVBQUUsT0FBTztBQUFBLElBQ2QsTUFBTSxFQUFFLFFBQVE7QUFBQSxJQUNoQixNQUFNLEVBQUUsUUFBUTtBQUFBLElBQ2hCLE1BQU0sRUFBRSxRQUFRO0FBQUEsSUFDaEIsTUFBTSxFQUFFLFFBQVEsQ0FBQztBQUFBLElBQ2pCLFNBQVM7QUFBQSxJQUNULE9BQU87QUFBQSxJQUNQLGFBQWEsRUFBRSxPQUFPLElBQUksT0FBTyxHQUFHO0FBQUEsSUFDcEMsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDO0FBQUEsSUFDUixVQUFVO0FBQUEsSUFDVixXQUFXLEVBQUU7QUFBQSxJQUNiLEtBQUssRUFBRSxPQUFPO0FBQUEsRUFDaEI7QUFBQTtBQUdLLFNBQVMsT0FBTyxDQUFDLE9BQXFCLE1BQTRCO0FBQUEsRUFDdkUsSUFBSSxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEtBQUssRUFBRTtBQUFBLElBQUcsT0FBTztBQUFBLEVBQ3hELE1BQU0sUUFBUSxLQUFLLElBQUk7QUFBQSxFQUN2QixPQUFPO0FBQUE7QUFHRixTQUFTLFdBQVcsQ0FBQyxPQUFxQixLQUFxQjtBQUFBLEVBQ3BFLE1BQU0sY0FBYyxDQUFDLEdBQUcsR0FBRztBQUFBO0FBR3RCLFNBQVMsT0FBTyxDQUFDLE9BQXFCLElBQVksU0FBMkI7QUFBQSxFQUNsRixNQUFNLEtBQUssTUFBTSxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDaEQsSUFBSSxDQUFDO0FBQUEsSUFBSSxPQUFPO0FBQUEsRUFDaEIsR0FBRyxVQUFVO0FBQUEsRUFDYixPQUFPO0FBQUE7QUFHRixTQUFTLE9BQU8sQ0FBQyxPQUFxQixJQUFZLE9BQXlCO0FBQUEsRUFDaEYsTUFBTSxLQUFLLE1BQU0sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQ2hELElBQUksQ0FBQztBQUFBLElBQUksT0FBTztBQUFBLEVBQ2hCLEdBQUcsUUFBUTtBQUFBLEVBQ1gsT0FBTztBQUFBO0FBR0YsU0FBUyxRQUFRLENBQ3RCLE9BQ0EsSUFDQSxLQUNBLE1BQ1M7QUFBQSxFQUNULE1BQU0sS0FBSyxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUNoRCxJQUFJLENBQUM7QUFBQSxJQUFJLE9BQU87QUFBQSxFQUNoQixHQUFHLFlBQVksT0FBTztBQUFBLEVBQ3RCLE9BQU87QUFBQTtBQUdGLFNBQVMsVUFBVSxDQUFDLE9BQXFCLEdBQWtCO0FBQUEsRUFDaEUsTUFBTSxTQUFTLEtBQUssQ0FBQztBQUFBO0FBR2hCLFNBQVMsYUFBYSxDQUMzQixPQUNBLEtBQ0EsT0FDUztBQUFBLEVBQ1QsTUFBTSxNQUFNLE1BQU0sV0FBVyxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVEsR0FBRztBQUFBLEVBQ3RELElBQUksQ0FBQztBQUFBLElBQUssT0FBTztBQUFBLEVBQ2pCLElBQUksTUFBTSxZQUFZO0FBQUEsSUFBVyxJQUFJLFVBQVUsTUFBTTtBQUFBLEVBQ3JELElBQUksTUFBTSxXQUFXO0FBQUEsSUFBVyxJQUFJLFNBQVMsTUFBTTtBQUFBLEVBQ25ELElBQUksTUFBTSxZQUFZO0FBQUEsSUFBVyxJQUFJLFVBQVUsTUFBTTtBQUFBLEVBQ3JELElBQUksTUFBTSxXQUFXO0FBQUEsSUFBVyxJQUFJLFNBQVMsTUFBTTtBQUFBLEVBQ25ELE9BQU87QUFBQTtBQUdGLFNBQVMsUUFBUSxDQUN0QixPQUNBLEtBQ0EsT0FDQSxPQUFPLElBQ0Q7QUFBQSxFQUNOLE1BQU0sUUFBUTtBQUFBLEVBQ2QsTUFBTSxXQUFXLENBQUMsR0FBRyxHQUFHO0FBQUEsRUFDeEIsTUFBTSxhQUFhO0FBQUEsRUFDbkIsTUFBTSxZQUFZO0FBQUE7QUFHYixTQUFTLFVBQVUsQ0FBQyxPQUEyQjtBQUFBLEVBQ3BELE1BQU0sUUFBUTtBQUFBLEVBQ2QsTUFBTSxXQUFXLENBQUM7QUFBQSxFQUNsQixNQUFNLGFBQWE7QUFBQSxFQUNuQixNQUFNLFlBQVk7QUFBQTtBQUdiLFNBQVMsWUFBWSxDQUFDLE9BQXFCLElBQVksV0FBNkI7QUFBQSxFQUN6RixNQUFNLEtBQUssTUFBTSxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDaEQsSUFBSSxDQUFDO0FBQUEsSUFBSSxPQUFPO0FBQUEsRUFDaEIsR0FBRyxZQUFZO0FBQUEsRUFDZixPQUFPO0FBQUE7QUFHRixTQUFTLGdCQUFnQixDQUFDLE9BQXFCLElBQVksVUFBNEI7QUFBQSxFQUM1RixNQUFNLEtBQUssTUFBTSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDN0MsSUFBSSxDQUFDO0FBQUEsSUFBSSxPQUFPO0FBQUEsRUFDaEIsR0FBRyxXQUFXO0FBQUEsRUFDZCxPQUFPO0FBQUE7QUFHRixTQUFTLGNBQWMsQ0FDNUIsT0FDQSxPQUNBLFdBQ2E7QUFBQSxFQUNiLE9BQU87QUFBQSxJQUNMLElBQUksU0FBUyxNQUFNO0FBQUEsSUFDbkIsTUFBTTtBQUFBLElBQ04sT0FBTyxNQUFNO0FBQUEsSUFDYixLQUFLO0FBQUEsSUFDTCxNQUFNO0FBQUEsSUFDTixNQUFNLE1BQU07QUFBQSxJQUNaLE1BQU07QUFBQSxJQUNOLE1BQU0sQ0FBQztBQUFBLElBQ1AsU0FBUztBQUFBLElBQ1QsT0FBTztBQUFBLElBQ1AsYUFBYSxFQUFFLE9BQU8sSUFBSSxPQUFPLEdBQUc7QUFBQSxJQUNwQyxXQUFXO0FBQUEsSUFDWDtBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1Y7QUFBQSxJQUNBLEtBQUs7QUFBQSxFQUNQO0FBQUE7QUFHSyxTQUFTLGVBQWUsQ0FBQyxPQUFxQixJQUFZLFVBQTRCO0FBQUEsRUFDM0YsTUFBTSxLQUFLLE1BQU0sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQ2hELElBQUksQ0FBQztBQUFBLElBQUksT0FBTztBQUFBLEVBQ2hCLEdBQUcsV0FBVztBQUFBLEVBQ2QsT0FBTztBQUFBO0FBR0YsU0FBUyxVQUFVLENBQUMsT0FBcUIsSUFBWSxNQUF1QjtBQUFBLEVBQ2pGLE1BQU0sS0FBSyxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUNoRCxJQUFJLENBQUMsSUFBSTtBQUFBLElBQUssT0FBTztBQUFBLEVBQ3JCLEdBQUcsSUFBSSxPQUFPO0FBQUEsRUFDZCxPQUFPO0FBQUE7QUFLRixTQUFTLFVBQVUsQ0FDeEIsT0FDQSxJQUNBLE9BQ1M7QUFBQSxFQUNULE1BQU0sS0FBSyxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUNoRCxJQUFJLENBQUMsSUFBSTtBQUFBLElBQUssT0FBTztBQUFBLEVBQ3JCLElBQUksT0FBTyxNQUFNLFdBQVc7QUFBQSxJQUFVLEdBQUcsSUFBSSxTQUFTLE1BQU07QUFBQSxFQUM1RCxJQUFJLE1BQU07QUFBQSxJQUFRLEdBQUcsSUFBSSxTQUFTLEtBQU0sR0FBRyxJQUFJLFVBQVUsQ0FBQyxNQUFPLE1BQU0sT0FBTztBQUFBLEVBQzlFLE9BQU87QUFBQTtBQUdGLFNBQVMsUUFBUSxDQUFDLElBQTJCO0FBQUEsRUFDbEQsUUFBUSxLQUFLLElBQUksTUFBTSxJQUFJLE9BQU8sT0FBTyxTQUFTO0FBQUEsRUFDbEQsT0FBTztBQUFBO0FBR0YsU0FBUyxTQUFTLENBQUMsR0FBNEI7QUFBQSxFQUNwRCxPQUFPLEtBQUssR0FBRyxTQUFTLEVBQUUsUUFBUSxJQUFJLFFBQVEsRUFBRTtBQUFBO0FBSTNDLElBQU0saUJBQWlCLElBQUksSUFBWTtBQUFBLEVBQzVDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQUM7QUFTTSxTQUFTLGFBQWEsQ0FBQyxPQUFxQixLQUE0QjtBQUFBLEVBQzdFLFFBQVEsSUFBSTtBQUFBLFNBQ0w7QUFBQSxNQUNILElBQUksT0FBTyxJQUFJLFVBQVU7QUFBQSxRQUFVLE1BQU0sUUFBUSxJQUFJO0FBQUEsTUFDckQsSUFBSSxPQUFPLElBQUksV0FBVztBQUFBLFFBQVUsTUFBTSxTQUFTLElBQUk7QUFBQSxNQUN2RDtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sU0FBUyxJQUFJO0FBQUEsTUFDbkI7QUFBQSxTQUNHLGlCQUFpQjtBQUFBLE1BQ3BCLE1BQU0sS0FBSyxNQUFNLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksRUFBRTtBQUFBLE1BQ3BELElBQUk7QUFBQSxRQUFJLEdBQUcsWUFBWSxRQUFRLElBQUk7QUFBQSxNQUNuQztBQUFBLElBQ0Y7QUFBQSxTQUNLO0FBQUEsTUFDSCxjQUFjLE9BQU8sSUFBSSxLQUFLO0FBQUEsUUFDNUIsU0FBUyxJQUFJO0FBQUEsUUFDYixRQUFRLElBQUk7QUFBQSxRQUNaLFNBQVMsSUFBSTtBQUFBLFFBQ2IsUUFBUSxJQUFJO0FBQUEsTUFDZCxDQUFDO0FBQUEsTUFDRDtBQUFBLFNBQ0c7QUFBQSxNQUNILFNBQVMsT0FBTyxJQUFJLEtBQUssU0FBUyxJQUFJLFFBQVEsRUFBRTtBQUFBLE1BQ2hEO0FBQUEsU0FDRztBQUFBLE1BQ0gsV0FBVyxPQUFPLElBQUksSUFBSSxJQUFJLElBQUk7QUFBQSxNQUNsQztBQUFBLFNBQ0c7QUFBQSxNQUNILFdBQVcsT0FBTyxJQUFJLElBQUksRUFBRSxRQUFRLElBQUksUUFBUSxRQUFRLElBQUksT0FBTyxDQUFDO0FBQUEsTUFDcEU7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFNBQVMsRUFBRSxNQUFNLElBQUksTUFBTSxNQUFNLElBQUksUUFBUSxHQUFHO0FBQUEsTUFDdEQ7QUFBQSxTQUNHO0FBQUEsTUFDSCxpQkFBaUIsT0FBTyxJQUFJLElBQUksSUFBSSxRQUFRO0FBQUEsTUFDNUM7QUFBQSxTQUNHO0FBQUEsU0FDQTtBQUFBLE1BQ0g7QUFBQTtBQUFBLE1BU0EsT0FBTztBQUFBO0FBQUEsRUFFWCxPQUFPO0FBQUE7OztBQ3ZRVCxrQ0FBcUIseUNBQXdCLGdDQUFjO0FBQzNELDJCQUFtQjtBQVNuQixJQUFNLGVBQXNDO0FBQUEsRUFDMUMsY0FBYztBQUFBLEVBQ2QsYUFBYTtBQUFBLEVBQ2IsY0FBYztBQUFBLEVBQ2QsYUFBYTtBQUNmO0FBSU8sU0FBUyxVQUFVLENBQUMsWUFBNEI7QUFBQSxFQUNyRCxNQUFNLE9BQU8sU0FBUyxVQUFVLEVBQUUsUUFBUSxtQkFBbUIsR0FBRyxLQUFLO0FBQUEsRUFDckUsSUFBSSxJQUFJO0FBQUEsRUFDUixTQUFTLElBQUksRUFBRyxJQUFJLFdBQVcsUUFBUTtBQUFBLElBQUssS0FBTSxLQUFLLEtBQUssSUFBSSxXQUFXLFdBQVcsQ0FBQyxNQUFPO0FBQUEsRUFDOUYsT0FBTyxHQUFHLFFBQVEsRUFBRSxTQUFTLEVBQUU7QUFBQTtBQUcxQixTQUFTLFNBQVMsQ0FBQyxNQUFjLEtBQXFCO0FBQUEsRUFDM0QsT0FBTyxNQUFLLE1BQU0sVUFBVSxHQUFHO0FBQUE7QUFHMUIsU0FBUyxTQUFTLENBQ3ZCLE1BQ0EsS0FDQSxNQVFZO0FBQUEsRUFDWixNQUFNLE1BQU0sVUFBVSxNQUFNLEdBQUc7QUFBQSxFQUMvQixXQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLEVBQ2xDLE1BQU0sWUFBNEIsQ0FBQztBQUFBLEVBQ25DLFdBQVcsTUFBTSxLQUFLLGdCQUFnQjtBQUFBLElBQ3BDLElBQUksQ0FBQyxHQUFHLFFBQVEsQ0FBQyxXQUFXLEdBQUcsSUFBSTtBQUFBLE1BQUc7QUFBQSxJQUN0QyxNQUFNLE1BQU0sYUFBWSxHQUFHLFNBQVM7QUFBQSxJQUNwQyxNQUFNLE9BQU8sR0FBRyxLQUFLLE1BQU0sR0FBRyxNQUFNO0FBQUEsSUFDcEMsSUFBSTtBQUFBLE1BQ0YsZUFBYyxNQUFLLEtBQUssSUFBSSxHQUFHLGNBQWEsR0FBRyxJQUFJLENBQUM7QUFBQSxNQUNwRCxVQUFVLEtBQUssRUFBRSxJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsT0FBTyxNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUM7QUFBQSxNQUNsRSxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsTUFBTSxRQUFvQjtBQUFBLElBQ3hCLElBQUksS0FBSztBQUFBLElBQ1QsT0FBTyxLQUFLO0FBQUEsSUFDWixNQUFNLEtBQUs7QUFBQSxJQUNYLFVBQVUsS0FBSztBQUFBLElBQ2Y7QUFBQSxJQUNBLFdBQVcsS0FBSztBQUFBLElBQ2hCLFVBQVU7QUFBQSxFQUNaO0FBQUEsRUFDQSxlQUFjLE1BQUssS0FBSyxHQUFHLEtBQUssU0FBUyxHQUFHLEtBQUssVUFBVSxLQUFLLENBQUM7QUFBQSxFQUNqRSxPQUFPO0FBQUE7QUFHRixTQUFTLFFBQVEsQ0FBQyxNQUFjLEtBQTJCO0FBQUEsRUFDaEUsTUFBTSxNQUFNLFVBQVUsTUFBTSxHQUFHO0FBQUEsRUFDL0IsSUFBSSxDQUFDLFdBQVcsR0FBRztBQUFBLElBQUcsT0FBTyxDQUFDO0FBQUEsRUFDOUIsTUFBTSxNQUFvQixDQUFDO0FBQUEsRUFDM0IsV0FBVyxRQUFRLFlBQVksR0FBRyxHQUFHO0FBQUEsSUFDbkMsSUFBSSxDQUFDLEtBQUssU0FBUyxPQUFPO0FBQUEsTUFBRztBQUFBLElBQzdCLElBQUk7QUFBQSxNQUNGLElBQUksS0FBSyxLQUFLLE1BQU0sY0FBYSxNQUFLLEtBQUssSUFBSSxHQUFHLE1BQU0sQ0FBQyxDQUFlO0FBQUEsTUFDeEUsTUFBTTtBQUFBLEVBR1Y7QUFBQSxFQUNBLE9BQU8sSUFBSSxLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsWUFBWSxFQUFFLFNBQVM7QUFBQTtBQUc5QyxTQUFTLGdCQUFnQixDQUM5QixNQUNBLEtBQ0EsSUFDQSxVQUNTO0FBQUEsRUFDVCxNQUFNLE9BQU8sTUFBSyxVQUFVLE1BQU0sR0FBRyxHQUFHLEdBQUcsU0FBUztBQUFBLEVBQ3BELElBQUksQ0FBQyxXQUFXLElBQUk7QUFBQSxJQUFHLE9BQU87QUFBQSxFQUM5QixJQUFJO0FBQUEsSUFDRixNQUFNLFFBQVEsS0FBSyxNQUFNLGNBQWEsTUFBTSxNQUFNLENBQUM7QUFBQSxJQUNuRCxNQUFNLFdBQVc7QUFBQSxJQUNqQixlQUFjLE1BQU0sS0FBSyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQ3pDLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBO0FBSUosU0FBUyxnQkFBZ0IsQ0FBQyxNQUFjLEtBQWEsT0FBK0I7QUFBQSxFQUN6RixNQUFNLE1BQU0sVUFBVSxNQUFNLEdBQUc7QUFBQSxFQUMvQixNQUFNLE1BQWtCLENBQUM7QUFBQSxFQUN6QixXQUFXLE9BQU8sTUFBTSxXQUFXO0FBQUEsSUFDakMsSUFBSTtBQUFBLE1BQ0YsTUFBTSxRQUFRLGNBQWEsTUFBSyxLQUFLLElBQUksSUFBSSxDQUFDO0FBQUEsTUFDOUMsSUFBSSxLQUFLO0FBQUEsUUFDUCxPQUFPLElBQUk7QUFBQSxRQUNYLEtBQUssUUFBUSxJQUFJLGVBQWUsTUFBTSxTQUFTLFFBQVE7QUFBQSxNQUN6RCxDQUFDO0FBQUEsTUFDRCxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsT0FBTztBQUFBOzs7QUpqRVQsSUFBTSxhQUFhLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUN6RCxJQUFNLGFBQWEsTUFBSyxZQUFZLElBQUk7QUFDeEMsSUFBTSxXQUFXLE1BQUssWUFBWSxNQUFNO0FBTWpDLFNBQVMsV0FBVyxHQUFzQjtBQUFBLEVBQy9DLE1BQU0sV0FBVyxRQUFRLElBQUk7QUFBQSxFQUM3QixJQUFJLGFBQWEsU0FBUyxhQUFhO0FBQUEsSUFBVyxPQUFPO0FBQUEsRUFDekQsT0FBTyxZQUFXLE1BQUssVUFBVSxZQUFZLENBQUMsSUFBSSxZQUFZO0FBQUE7QUFHaEUsSUFBTSx1QkFBK0M7QUFBQSxFQUNuRCxTQUFTO0FBQUEsRUFDVCxPQUFPO0FBQUEsRUFDUCxRQUFRO0FBQUEsRUFDUixTQUFTO0FBQUEsRUFDVCxRQUFRO0FBQUEsRUFDUixRQUFRO0FBQ1Y7QUFPQSxTQUFTLFNBQVMsQ0FBQyxNQUErQjtBQUFBLEVBQ2hELE1BQU0sTUFBTSxTQUFTLE1BQU0sZUFBZSxLQUFLLE1BQU0sQ0FBQztBQUFBLEVBQ3RELElBQUksSUFBSSxTQUFTLElBQUksS0FBSyxJQUFJLFNBQVMsR0FBRztBQUFBLElBQUcsT0FBTztBQUFBLEVBQ3BELE1BQU0sT0FBTyxNQUFLLFVBQVUsR0FBRztBQUFBLEVBQy9CLElBQUksQ0FBQyxZQUFXLElBQUk7QUFBQSxJQUFHLE9BQU87QUFBQSxFQUM5QixNQUFNLE1BQU0sSUFBSSxNQUFNLElBQUksWUFBWSxHQUFHLENBQUM7QUFBQSxFQUMxQyxPQUFPLElBQUksU0FBUyxJQUFJLEtBQUssSUFBSSxHQUFHO0FBQUEsSUFDbEMsU0FBUyxFQUFFLGdCQUFnQixxQkFBcUIsUUFBUSwyQkFBMkI7QUFBQSxFQUNyRixDQUFDO0FBQUE7QUFHSCxJQUFNLE1BQU0sSUFBSTtBQUNoQixJQUFNLFVBQVUsQ0FBQyxNQUNmLE1BQU0sS0FBSyxPQUFPLGdCQUFnQixJQUFJLFdBQVcsQ0FBQyxDQUFDLENBQUMsRUFDakQsSUFBSSxDQUFDLE1BQU0sRUFBRSxTQUFTLEVBQUUsRUFBRSxTQUFTLEdBQUcsR0FBRyxDQUFDLEVBQzFDLEtBQUssRUFBRTtBQVlaLGVBQXNCLFdBQVcsQ0FBQyxNQUFpQjtBQUFBLEVBQ2pELE1BQU0sZUFBZSxRQUFRLElBQUksZ0JBQWdCLE1BQUssUUFBUSxHQUFHLFVBQVU7QUFBQSxFQUMzRSxNQUFNLGdCQUFnQixNQUFLLGNBQWMsV0FBVztBQUFBLEVBQ3BELElBQUksUUFBc0IsYUFBYSxLQUFLLFNBQVMsSUFBSSxLQUFLLFVBQVUsRUFBRTtBQUFBLEVBQzFFLElBQUksV0FBVztBQUFBLEVBQ2YsSUFBSSxLQUFLLFNBQVM7QUFBQSxJQUNoQixNQUFNLE9BQU8sWUFBVyxLQUFLLE9BQU8sSUFDaEMsS0FBSyxVQUNMLE1BQUssZUFBZSxHQUFHLEtBQUssY0FBYztBQUFBLElBQzlDLElBQUk7QUFBQSxNQUNGLFFBQVEsYUFBYSxNQUFNLEtBQUssU0FBUyxJQUFJLEtBQUssVUFBVSxFQUFFO0FBQUEsTUFDOUQsV0FBVztBQUFBLE1BQ1gsT0FBTyxHQUFHO0FBQUEsTUFDVixRQUFRLE9BQU8sTUFBTSw0QkFBNEIsVUFBVTtBQUFBLENBQUs7QUFBQTtBQUFBLEVBRXBFO0FBQUEsRUFDQSxNQUFNLGNBQWMsV0FBVyxLQUFLLFdBQVcsUUFBUSxJQUFJLENBQUM7QUFBQSxFQU01RCxNQUFNLE9BQU8sWUFBWTtBQUFBLEVBV3pCLE1BQU0sV0FDSixTQUFTLFNBQ0osTUFBYSx5REFBa0QsVUFDaEU7QUFBQSxFQUNOLE1BQU0sU0FBVSxXQUFXLEVBQUUsS0FBSyxTQUFTLElBQUksQ0FBQztBQUFBLEVBSWhELE1BQU0sT0FBTyxTQUFTLGNBQWMsV0FBVztBQUFBLEVBRy9DLE1BQU0sVUFBVSxJQUFJO0FBQUEsRUFDcEIsTUFBTSxTQUF5QyxDQUFDO0FBQUEsRUFDaEQsSUFBSSxXQUFXO0FBQUEsRUFDZixNQUFNLGFBQWEsSUFBSTtBQUFBLEVBQ3ZCLElBQUksZUFBZSxZQUFZLElBQUk7QUFBQSxFQUNuQyxNQUFNLFFBQVEsTUFBTTtBQUFBLElBQ2xCLGVBQWUsWUFBWSxJQUFJO0FBQUE7QUFBQSxFQUdqQyxNQUFNLFlBQVksQ0FBQyxRQUFnQjtBQUFBLElBQ2pDLE1BQU0sSUFBSSxLQUFLLFVBQVUsR0FBRztBQUFBLElBQzVCLFdBQVcsTUFBTSxTQUFTO0FBQUEsTUFDeEIsSUFBSTtBQUFBLFFBQ0YsR0FBRyxLQUFLLENBQUM7QUFBQSxRQUNULE1BQU07QUFBQSxJQUdWO0FBQUE7QUFBQSxFQUVGLElBQUksWUFBWTtBQUFBLEVBQ2hCLE1BQU0saUJBQWlCLE1BQU07QUFBQSxJQUMzQixZQUFZO0FBQUEsSUFDWixVQUFVLEVBQUUsTUFBTSxTQUFTLE1BQU0sQ0FBQztBQUFBO0FBQUEsRUFFcEMsTUFBTSxZQUFZLENBQUMsUUFBaUM7QUFBQSxJQUNsRCxNQUFNLEtBQUssRUFBRSxJQUFJLEVBQUUsYUFBYSxJQUFJO0FBQUEsSUFDcEMsT0FBTyxLQUFLLEVBQUU7QUFBQSxJQUNkLE1BQU0sUUFBUSxJQUFJLE9BQU8sU0FBUyxLQUFLLFVBQVUsRUFBRTtBQUFBO0FBQUEsQ0FBTztBQUFBLElBQzFELFdBQVcsS0FBSyxZQUFZO0FBQUEsTUFDMUIsSUFBSTtBQUFBLFFBQ0YsRUFBRSxRQUFRLEtBQUs7QUFBQSxRQUNmLE1BQU07QUFBQSxJQUdWO0FBQUE7QUFBQSxFQU1GLE1BQU0sZ0JBQWdCLENBQUMsUUFBaUM7QUFBQSxJQUN0RCxNQUFNLFFBQVEsSUFBSSxPQUFPLFNBQVMsS0FBSyxVQUFVLEdBQUc7QUFBQTtBQUFBLENBQU87QUFBQSxJQUMzRCxXQUFXLEtBQUssWUFBWTtBQUFBLE1BQzFCLElBQUk7QUFBQSxRQUNGLEVBQUUsUUFBUSxLQUFLO0FBQUEsUUFDZixNQUFNO0FBQUEsSUFHVjtBQUFBO0FBQUEsRUFJRixNQUFNLFlBQVksV0FBVyxRQUFRLENBQUM7QUFBQSxFQUN0QyxNQUFNLGtCQUFrQixNQUFLLE9BQU8sR0FBRyxHQUFHLGlCQUFpQjtBQUFBLEVBQzNELElBQUk7QUFBQSxJQUNGLFdBQVUsaUJBQWlCLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFBQSxJQUM5QyxNQUFNO0FBQUEsRUFHUixJQUFJLFVBQVU7QUFBQSxJQUNaLFdBQVcsTUFBTSxNQUFNO0FBQUEsTUFBUyxnQkFBZ0IsaUJBQWlCLEVBQUU7QUFBQSxFQUNyRTtBQUFBLEVBR0EsSUFBSTtBQUFBLEVBQ0osTUFBTSxPQUFPLElBQUksUUFBMEMsQ0FBQyxNQUFNO0FBQUEsSUFDaEUsY0FBYztBQUFBLEdBQ2Y7QUFBQSxFQWFELE1BQU0saUJBQWlCLENBQUMsUUFBb0M7QUFBQSxJQUMxRCxJQUFJLElBQUksU0FBUyxPQUFPO0FBQUEsTUFDdEIsV0FBVyxPQUFPO0FBQUEsUUFDaEIsSUFBSSxLQUFLLFFBQVEsQ0FBQztBQUFBLFFBQ2xCLEtBQUs7QUFBQSxRQUNMLE1BQU0sSUFBSSxRQUFRO0FBQUEsUUFDbEIsTUFBTSxJQUFJO0FBQUEsUUFDVixRQUFRLENBQUM7QUFBQSxRQUNULElBQUksS0FBSyxJQUFJO0FBQUEsTUFDZixDQUFDO0FBQUEsTUFDRCxlQUFlO0FBQUEsTUFDZixPQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsSUFBSSxJQUFJLFNBQVMsU0FBUztBQUFBLE1BQ3hCLFlBQVksRUFBRSxNQUFNLEdBQUcsUUFBUSxRQUFRLENBQUM7QUFBQSxNQUN4QyxPQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsSUFBSSxJQUFJLFNBQVMsV0FBVztBQUFBLE1BQzFCLE1BQU0sS0FBSyxTQUFTO0FBQUEsUUFDbEIsSUFBSSxPQUFPLFFBQVEsQ0FBQztBQUFBLFFBQ3BCLE1BQU07QUFBQSxRQUNOLE9BQU8sSUFBSSxTQUFTLFNBQVMsSUFBSTtBQUFBLFFBQ2pDLEtBQUssSUFBSTtBQUFBLFFBQ1QsTUFBTTtBQUFBLFFBQ04sV0FBVyxLQUFLLElBQUk7QUFBQSxRQUNwQixLQUFLO0FBQUEsVUFDSCxPQUFPLElBQUk7QUFBQSxVQUNYLFFBQVEsSUFBSTtBQUFBLFVBQ1osTUFBTSxJQUFJLFFBQVE7QUFBQSxVQUNsQixNQUFNLElBQUksUUFBUTtBQUFBLFVBQ2xCLFFBQVEsSUFBSSxVQUFVLENBQUM7QUFBQSxVQUN2QixPQUFPLElBQUk7QUFBQSxRQUNiO0FBQUEsTUFDRixDQUFDO0FBQUEsTUFDRCxnQkFBZ0IsaUJBQWlCLEVBQUU7QUFBQSxNQWVuQyxNQUFNLFFBQVEsUUFBUSxPQUFPLEVBQUU7QUFBQSxNQUMvQixJQUFJO0FBQUEsUUFBTyxlQUFlO0FBQUEsTUFDMUIsT0FBTztBQUFBLFFBQ0wsWUFBWTtBQUFBLFFBQ1osSUFBSTtBQUFBLFFBQ0osUUFBUSxFQUFFLElBQUksR0FBRyxJQUFJLFNBQVMsUUFBUSxZQUFZLG1CQUFtQjtBQUFBLE1BQ3ZFO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSSxJQUFJLFNBQVMsY0FBYztBQUFBLE1BQzdCLE1BQU0saUJBQWlCLE1BQU0sUUFBUSxPQUFPLENBQUMsTUFBTSxFQUFFLGFBQWEsQ0FBQyxFQUFFLFFBQVE7QUFBQSxNQUM3RSxNQUFNLFNBQVMsTUFBTSxXQUFXLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxXQUFXLEVBQUUsT0FBTztBQUFBLE1BQy9FLE1BQU0sT0FBTyxPQUNWLElBQUksQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUNwQixLQUFLLFFBQUksRUFDVCxNQUFNLEdBQUcsR0FBRztBQUFBLE1BQ2YsTUFBTSxRQUFRLFVBQVUsY0FBYyxhQUFhO0FBQUEsUUFDakQsSUFBSSxTQUFTLFFBQVEsQ0FBQztBQUFBLFFBQ3RCLE9BQU8sSUFBSTtBQUFBLFFBQ1g7QUFBQSxRQUNBLFVBQVUsTUFBTTtBQUFBLFFBQ2hCO0FBQUEsUUFDQSxXQUFXLEtBQUssSUFBSTtBQUFBLE1BQ3RCLENBQUM7QUFBQSxNQUNELE1BQU0sS0FBSyxLQUFLLEtBQUs7QUFBQSxNQUNyQixlQUFlO0FBQUEsTUFDZixPQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsSUFBSSxJQUFJLFNBQVMsaUJBQWlCO0FBQUEsTUFDaEMsaUJBQWlCLGNBQWMsYUFBYSxJQUFJLElBQUksSUFBSSxRQUFRO0FBQUEsTUFDaEUsY0FBYyxPQUFPLEdBQUc7QUFBQSxNQUN4QixlQUFlO0FBQUEsTUFDZixPQUFPO0FBQUEsSUFDVDtBQUFBLElBSUEsTUFBTSxhQUFhLGNBQWMsT0FBTyxHQUFHO0FBQUEsSUFDM0MsSUFBSTtBQUFBLE1BQVksZUFBZTtBQUFBLElBQy9CLE9BQU87QUFBQTtBQUFBLEVBSVQsTUFBTSxrQkFBa0IsQ0FBQyxRQUF3QjtBQUFBLElBQy9DLFFBQVEsSUFBSTtBQUFBLFdBQ0wsWUFBWTtBQUFBLFFBQ2YsTUFBTSxLQUFLLFNBQVM7QUFBQSxVQUNsQixJQUFJLEdBQUcsSUFBSSxLQUFLLFFBQVEsUUFBUSxDQUFDO0FBQUEsVUFDakMsTUFBTSxJQUFJLEtBQUs7QUFBQSxVQUNmLE9BQU8sSUFBSSxLQUFLO0FBQUEsVUFDaEIsS0FBSyxJQUFJLEtBQUs7QUFBQSxVQUNkLE1BQU0sSUFBSSxLQUFLO0FBQUEsVUFDZixNQUFNLElBQUksS0FBSyxRQUFRO0FBQUEsVUFDdkIsV0FBVyxLQUFLLElBQUk7QUFBQSxRQUN0QixDQUFDO0FBQUEsUUFDRCxnQkFBZ0IsaUJBQWlCLEVBQUU7QUFBQSxRQUNuQyxJQUFJLFFBQVEsT0FBTyxFQUFFLEdBQUc7QUFBQSxVQUN0QixlQUFlO0FBQUEsVUFDZixVQUFVO0FBQUEsWUFDUixNQUFNO0FBQUEsWUFDTixNQUFNLFNBQVMsRUFBRTtBQUFBLFlBQ2pCLGFBQWEsTUFBTTtBQUFBLFVBQ3JCLENBQUM7QUFBQSxRQUNIO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxXQUNLO0FBQUEsUUFDSCxZQUFZLE9BQU8sSUFBSSxHQUFHO0FBQUEsUUFDMUIsZUFBZTtBQUFBLFFBQ2Y7QUFBQSxXQUNHO0FBQUEsUUFDSCxJQUFJLFFBQVEsT0FBTyxJQUFJLElBQUksSUFBSSxPQUFPO0FBQUEsVUFBRyxlQUFlO0FBQUEsUUFDeEQ7QUFBQSxXQUNHO0FBQUEsUUFDSCxJQUFJLFFBQVEsT0FBTyxJQUFJLElBQUksSUFBSSxLQUFLO0FBQUEsVUFBRyxlQUFlO0FBQUEsUUFDdEQ7QUFBQSxXQUNHO0FBQUEsUUFNSCxJQUFJLFNBQVMsT0FBTyxJQUFJLElBQUksU0FBUyxJQUFJLEtBQUs7QUFBQSxVQUFHLGVBQWU7QUFBQSxRQUNoRTtBQUFBLFdBQ0csZ0JBQWdCO0FBQUEsUUFDbkIsTUFBTSxTQUFTLENBQUMsR0FBRyxNQUFNLFdBQVc7QUFBQSxRQUNwQyxXQUFXLE9BQU87QUFBQSxVQUNoQixJQUFJLEtBQUssUUFBUSxDQUFDO0FBQUEsVUFDbEIsS0FBSztBQUFBLFVBQ0wsTUFBTTtBQUFBLFVBQ04sTUFBTSxJQUFJO0FBQUEsVUFDVjtBQUFBLFVBQ0EsSUFBSSxLQUFLLElBQUk7QUFBQSxRQUNmLENBQUM7QUFBQSxRQUNELGVBQWU7QUFBQSxRQUNmLFVBQVUsRUFBRSxNQUFNLGdCQUFnQixNQUFNLElBQUksTUFBTSxPQUFPLENBQUM7QUFBQSxRQUMxRDtBQUFBLE1BQ0Y7QUFBQSxXQUNLO0FBQUEsUUFDSCxTQUFTLE9BQU8sSUFBSSxLQUFLLEtBQUs7QUFBQSxRQUM5QixlQUFlO0FBQUEsUUFDZjtBQUFBLFdBQ0c7QUFBQSxRQUNILFdBQVcsS0FBSztBQUFBLFFBQ2hCLGVBQWU7QUFBQSxRQUNmO0FBQUEsV0FDRztBQUFBLFFBQ0gsSUFBSSxhQUFhLE9BQU8sSUFBSSxJQUFJLElBQUksU0FBUztBQUFBLFVBQUcsZUFBZTtBQUFBLFFBQy9EO0FBQUEsV0FDRztBQUFBLFFBQ0gsSUFBSSxnQkFBZ0IsT0FBTyxJQUFJLElBQUksSUFBSSxRQUFRO0FBQUEsVUFBRyxlQUFlO0FBQUEsUUFDakU7QUFBQSxXQUNHLGlCQUFpQjtBQUFBLFFBQ3BCLE1BQU0sUUFBUSxNQUFNLEtBQUssS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksRUFBRTtBQUFBLFFBQ3BELElBQUksQ0FBQztBQUFBLFVBQU87QUFBQSxRQUNaLE1BQU0sU0FBUyxTQUFTLE1BQU07QUFBQSxRQUM5QixJQUFJLE1BQU0sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUFBLFVBQUc7QUFBQSxRQUNoRCxNQUFNLFFBQVEsaUJBQWlCLGNBQWMsYUFBYSxLQUFLO0FBQUEsUUFDL0QsTUFBTSxLQUFLLGVBQWUsT0FBTyxPQUFPLEtBQUssSUFBSSxDQUFDO0FBQUEsUUFDbEQsSUFBSSxRQUFRLE9BQU8sRUFBRSxHQUFHO0FBQUEsVUFDdEIsZUFBZTtBQUFBLFVBQ2YsVUFBVSxFQUFFLE1BQU0sWUFBWSxNQUFNLFNBQVMsRUFBRSxHQUFHLGFBQWEsTUFBTSxZQUFZLENBQUM7QUFBQSxRQUNwRjtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUE7QUFBQTtBQUFBLEVBS0osTUFBTSxjQUFjLENBQUMsUUFBdUI7QUFBQSxJQUMxQyxNQUFNO0FBQUEsSUFDTixNQUFNLFFBQVEsT0FBTyxTQUFTLElBQUksYUFBYSxJQUFJLE9BQU8sS0FBSyxNQUFNLEVBQUU7QUFBQSxJQUN2RSxJQUFJLE1BQThDO0FBQUEsSUFDbEQsSUFBSSxLQUE0QztBQUFBLElBQ2hELE1BQU0sU0FBUyxJQUFJLGVBQWU7QUFBQSxNQUNoQyxLQUFLLENBQUMsWUFBWTtBQUFBLFFBQ2hCLE1BQU07QUFBQSxRQUNOLFdBQVcsTUFBTSxRQUFRO0FBQUEsVUFDdkIsSUFBSyxHQUFHLEtBQWdCO0FBQUEsWUFDdEIsV0FBVyxRQUFRLElBQUksT0FBTyxTQUFTLEtBQUssVUFBVSxFQUFFO0FBQUE7QUFBQSxDQUFPLENBQUM7QUFBQSxRQUNwRTtBQUFBLFFBQ0EsV0FBVyxJQUFJLFVBQVU7QUFBQSxRQUN6QixLQUFLLFlBQVksTUFBTTtBQUFBLFVBQ3JCLElBQUk7QUFBQSxZQUNGLFdBQVcsUUFBUSxJQUFJLE9BQU87QUFBQTtBQUFBLENBQVUsQ0FBQztBQUFBLFlBQ3pDLE1BQU07QUFBQSxXQUdQLEtBQUs7QUFBQTtBQUFBLE1BRVYsTUFBTSxHQUFHO0FBQUEsUUFDUCxJQUFJO0FBQUEsVUFBSSxjQUFjLEVBQUU7QUFBQSxRQUN4QixJQUFJO0FBQUEsVUFBSyxXQUFXLE9BQU8sR0FBRztBQUFBO0FBQUEsSUFFbEMsQ0FBQztBQUFBLElBQ0QsT0FBTyxJQUFJLFNBQVMsUUFBUTtBQUFBLE1BQzFCLFNBQVM7QUFBQSxRQUNQLGdCQUFnQjtBQUFBLFFBQ2hCLGlCQUFpQjtBQUFBLFFBQ2pCLFlBQVk7QUFBQSxNQUNkO0FBQUEsSUFDRixDQUFDO0FBQUE7QUFBQSxFQUlILE1BQU0sU0FBUyxJQUFJLE1BQU07QUFBQSxJQUN2QixNQUFNLEtBQUssUUFBUTtBQUFBLElBQ25CLFVBQVUsS0FBSyxRQUFRO0FBQUEsSUFDdkI7QUFBQSxJQVdBLGFBQWE7QUFBQSxJQUNiLGFBQWEsRUFBRSxLQUFLLFNBQVMsTUFBTTtBQUFBLElBQ25DLEtBQUssQ0FBQyxLQUFLLEtBQUs7QUFBQSxNQUNkLE1BQU0sTUFBTSxJQUFJLElBQUksSUFBSSxHQUFHO0FBQUEsTUFDM0IsTUFBTSxPQUFPLElBQUk7QUFBQSxNQUNqQixJQUFJLFNBQVM7QUFBQSxRQUNYLE9BQU8sSUFBSSxRQUFRLEdBQUcsSUFBSSxZQUFZLElBQUksU0FBUyxvQkFBb0IsRUFBRSxRQUFRLElBQUksQ0FBQztBQUFBLE1BQ3hGLElBQUksSUFBSSxXQUFXLFNBQVMsU0FBUyxVQUFVO0FBQUEsUUFDN0MsTUFBTTtBQUFBLFFBQ04sTUFBTSxPQUFPLElBQUksYUFBYSxJQUFJLE1BQU0sTUFBTTtBQUFBLFFBQzlDLE9BQU8sU0FBUyxLQUFLO0FBQUEsVUFDbkIsT0FBTyxPQUFPLFVBQVUsS0FBSyxJQUFJO0FBQUEsVUFDakMsUUFBUTtBQUFBLFFBQ1YsQ0FBQztBQUFBLE1BQ0g7QUFBQSxNQUNBLElBQUksSUFBSSxXQUFXLFNBQVMsU0FBUztBQUFBLFFBQVcsT0FBTyxZQUFZLEdBQUc7QUFBQSxNQUN0RSxJQUFJLElBQUksV0FBVyxVQUFVLFNBQVM7QUFBQSxRQUNwQyxPQUFPLElBQ0osS0FBSyxFQUNMLEtBQUssQ0FBQyxNQUFNO0FBQUEsVUFDWCxNQUFNO0FBQUEsVUFJTixNQUFNLFVBQVUsZUFBZSxDQUFpQjtBQUFBLFVBR2hELElBQUksT0FBTyxZQUFZO0FBQUEsWUFDckIsT0FBTyxTQUFTLEtBQUssRUFBRSxJQUFJLE1BQU0sU0FBUyxTQUFTLFFBQVEsT0FBTyxDQUFDO0FBQUEsVUFDckUsTUFBTSxVQUFVO0FBQUEsVUFDaEIsSUFBSSxDQUFDLFNBQVM7QUFBQSxZQUNaLE9BQU8sU0FBUyxLQUNkO0FBQUEsY0FDRSxJQUFJO0FBQUEsY0FDSixTQUFTO0FBQUEsY0FDVCxPQUFPLDZCQUE2QixLQUFLLFVBQ3RDLEdBQTBCLElBQzdCO0FBQUEsWUFDRixHQUNBLEVBQUUsUUFBUSxJQUFJLENBQ2hCO0FBQUEsVUFDRjtBQUFBLFVBQ0EsT0FBTyxTQUFTLEtBQUssRUFBRSxJQUFJLE1BQU0sU0FBUyxLQUFLLENBQUM7QUFBQSxTQUNqRCxFQUNBLE1BQU0sTUFBTSxTQUFTLEtBQUssRUFBRSxPQUFPLFdBQVcsR0FBRyxFQUFFLFFBQVEsSUFBSSxDQUFDLENBQUM7QUFBQSxNQUN0RSxJQUFJLElBQUksV0FBVyxTQUFTLEtBQUssV0FBVyxVQUFVLEdBQUc7QUFBQSxRQUN2RCxNQUFNLE9BQU8sbUJBQW1CLEtBQUssTUFBTSxXQUFXLE1BQU0sQ0FBQztBQUFBLFFBQzdELElBQUksS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLFdBQVcsR0FBRztBQUFBLFVBQzVDLE9BQU8sU0FBUyxLQUFLLEVBQUUsT0FBTyxZQUFZLEdBQUcsRUFBRSxRQUFRLElBQUksQ0FBQztBQUFBLFFBQzlELE1BQU0sSUFBSSxJQUFJLEtBQUssTUFBSyxpQkFBaUIsSUFBSSxDQUFDO0FBQUEsUUFDOUMsT0FBTyxFQUNKLE9BQU8sRUFDUCxLQUFLLENBQUMsT0FDTCxLQUFLLElBQUksU0FBUyxDQUFDLElBQUksU0FBUyxLQUFLLEVBQUUsT0FBTyxZQUFZLEdBQUcsRUFBRSxRQUFRLElBQUksQ0FBQyxDQUM5RTtBQUFBLE1BQ0o7QUFBQSxNQUlBLElBQUksU0FBUyxXQUFXO0FBQUEsUUFDdEIsTUFBTSxRQUFRLFVBQVUsSUFBSTtBQUFBLFFBQzVCLElBQUk7QUFBQSxVQUFPLE9BQU87QUFBQSxNQUNwQjtBQUFBLE1BQ0EsT0FBTyxTQUFTLEtBQUssRUFBRSxPQUFPLFlBQVksR0FBRyxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUE7QUFBQSxJQUU5RCxXQUFXO0FBQUEsTUFDVCxJQUFJLENBQUMsSUFBSTtBQUFBLFFBQ1AsUUFBUSxJQUFJLEVBQUU7QUFBQSxRQUNkLE1BQU07QUFBQSxRQUNOLGNBQWMsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUFBLFFBQ25DLEdBQUcsS0FBSyxLQUFLLFVBQVUsRUFBRSxNQUFNLFNBQVMsTUFBTSxDQUFDLENBQUM7QUFBQTtBQUFBLE1BRWxELE9BQU8sQ0FBQyxLQUFLLEtBQUs7QUFBQSxRQUNoQixNQUFNO0FBQUEsUUFDTixJQUFJO0FBQUEsVUFDRixnQkFDRSxLQUFLLE1BQ0gsT0FBTyxRQUFRLFdBQVcsTUFBTSxJQUFJLFlBQVksRUFBRSxPQUFPLEdBQUcsQ0FDOUQsQ0FDRjtBQUFBLFVBQ0EsT0FBTyxHQUFHO0FBQUEsVUFDVixRQUFRLE9BQU8sTUFBTSxtQ0FBbUM7QUFBQSxDQUFLO0FBQUE7QUFBQTtBQUFBLE1BR2pFLEtBQUssQ0FBQyxJQUFJO0FBQUEsUUFDUixRQUFRLE9BQU8sRUFBRTtBQUFBLFFBQ2pCLGNBQWMsRUFBRSxNQUFNLGVBQWUsQ0FBQztBQUFBO0FBQUEsSUFFMUM7QUFBQSxFQUNGLENBQUM7QUFBQSxFQUVELE1BQU0sWUFBWSxPQUFPO0FBQUEsRUFFekIsTUFBTSxjQUFjLE1BQUssT0FBTyxHQUFHLFdBQVcsZ0JBQWdCO0FBQUEsRUFDOUQsTUFBTSxhQUFhLE1BQUssT0FBTyxHQUFHLHFCQUFxQjtBQUFBLEVBQ3ZELE1BQU0sT0FBTyxLQUFLLFVBQVU7QUFBQSxJQUMxQixLQUFLLFVBQVUsS0FBSyxRQUFRLGVBQWU7QUFBQSxJQUMzQyxNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsSUFDWixPQUFPLE1BQU07QUFBQSxJQUNiLFdBQVc7QUFBQSxJQUNYO0FBQUEsRUFDRixDQUFDO0FBQUEsRUFPRCxNQUFNLGNBQWMsQ0FBQyxRQUFnQixTQUFpQjtBQUFBLElBQ3BELE1BQU0sTUFBTSxHQUFHLFVBQVUsUUFBUTtBQUFBLElBQ2pDLElBQUk7QUFBQSxNQUNGLGVBQWMsS0FBSyxJQUFJO0FBQUEsTUFDdkIsV0FBVyxLQUFLLE1BQU07QUFBQSxNQUN0QixNQUFNO0FBQUEsTUFDTixJQUFJO0FBQUEsUUFDRixPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssQ0FBQztBQUFBLFFBQzNCLE1BQU07QUFBQSxNQUdSLE1BQU0sSUFBSSxNQUFNLHFCQUFxQixRQUFRO0FBQUE7QUFBQTtBQUFBLEVBR2pELElBQUk7QUFBQSxJQUNGLFlBQVksYUFBYSxJQUFJO0FBQUEsSUFDN0IsWUFBWSxZQUFZLElBQUk7QUFBQSxJQUM1QixNQUFNO0FBQUEsRUFTUixVQUFVLEVBQUUsTUFBTSxTQUFTLEtBQUssQ0FBQztBQUFBLEVBR2pDLE1BQU0sVUFBVSxNQUFNLGFBQWEsZUFBZSxXQUFXLEtBQUs7QUFBQSxFQUNsRSxJQUFJO0FBQUEsSUFBVSxRQUFRO0FBQUEsRUFDdEIsTUFBTSxZQUFZLFlBQVksTUFBTTtBQUFBLElBQ2xDLElBQUksV0FBVztBQUFBLE1BQ2IsWUFBWTtBQUFBLE1BQ1osUUFBUTtBQUFBLElBQ1Y7QUFBQSxLQUNDLElBQUk7QUFBQSxFQUNQLE1BQU0sV0FBVyxLQUFLLFlBQVk7QUFBQSxFQUNsQyxNQUFNLFlBQVksWUFBWSxNQUFNO0FBQUEsSUFDbEMsS0FBSyxZQUFZLElBQUksSUFBSSxnQkFBZ0IsUUFBUTtBQUFBLE1BQy9DLFlBQVksRUFBRSxNQUFNLEtBQUssUUFBUSxVQUFVLENBQUM7QUFBQSxLQUM3QyxHQUFHO0FBQUEsRUFFTixJQUFJLFNBQVM7QUFBQSxFQUdiLElBQUk7QUFBQSxFQUNKLE1BQU0sV0FBVyxJQUFJLFFBQWMsQ0FBQyxNQUFNO0FBQUEsSUFDeEMsa0JBQWtCO0FBQUEsR0FDbkI7QUFBQSxFQUVELE1BQU0sUUFBUSxNQUFNO0FBQUEsSUFDbEIsSUFBSTtBQUFBLE1BQVE7QUFBQSxJQUNaLFNBQVM7QUFBQSxJQUNULGNBQWMsU0FBUztBQUFBLElBQ3ZCLGNBQWMsU0FBUztBQUFBLElBQ3ZCLFFBQVE7QUFBQSxJQUNSLElBQUk7QUFBQSxNQUNGLFdBQVcsV0FBVztBQUFBLE1BQ3RCLE1BQU07QUFBQSxJQUNSLElBQUk7QUFBQSxNQUNGLE1BQU0sTUFBTSxjQUFhLFlBQVksTUFBTTtBQUFBLE1BQzNDLE1BQU0sU0FBUyxLQUFLLE1BQU0sR0FBRztBQUFBLE1BQzdCLElBQUksT0FBTyxlQUFlO0FBQUEsUUFBVyxXQUFXLFVBQVU7QUFBQSxNQUMxRCxNQUFNO0FBQUEsSUFHUixJQUFJO0FBQUEsTUFDRixPQUFPLGlCQUFpQixFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQ3hELE1BQU07QUFBQSxJQUNSLFVBQVUsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUFBLElBRzVCLFdBQVcsS0FBSyxZQUFZO0FBQUEsTUFDMUIsSUFBSTtBQUFBLFFBQ0YsRUFBRSxNQUFNO0FBQUEsUUFDUixNQUFNO0FBQUEsSUFHVjtBQUFBLElBQ0EsV0FBVyxNQUFNO0FBQUEsSUFFakIsV0FBVyxNQUFNO0FBQUEsTUFDZixPQUFPLEtBQUssSUFBSTtBQUFBLE1BQ2hCLGdCQUFnQjtBQUFBLE9BQ2YsRUFBRTtBQUFBO0FBQUEsRUFFUCxLQUFLLEtBQUssTUFBTSxNQUFNLENBQUM7QUFBQSxFQUV2QixPQUFPLEVBQUUsTUFBTSxXQUFXLFdBQVcsTUFBTSxPQUFPLE1BQU0sU0FBUztBQUFBO0FBd0JuRSxJQUFNLGlCQUFpQjtBQUFBLEVBQ3JCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUMxQjtBQUlBLGVBQXNCLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQzFELElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFFBQVEsY0FBYyxFQUFFLE1BQU0sTUFBTSxTQUFTLGdCQUFnQixRQUFRLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFJN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixRQUFRLE9BQU8sTUFDYixZQUFZLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsc0JBQzVCLE9BQU8sS0FBSyxjQUFjLEVBQzlDLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRyxFQUNuQixLQUFLLEdBQUc7QUFBQSxDQUNmO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUVULE1BQU0sSUFBSSxNQUFNLFlBQVk7QUFBQSxJQUMxQixNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxJQUFJO0FBQUEsSUFDeEMsT0FBTyxNQUFNO0FBQUEsSUFDYixRQUFRLE1BQU07QUFBQSxJQUNkLFNBQVMsTUFBTTtBQUFBLElBQ2YsVUFBVSxNQUFNLFVBQVUsT0FBTyxNQUFNLE9BQU8sSUFBSTtBQUFBLElBQ2xELFNBQVMsTUFBTTtBQUFBLEVBQ2pCLENBQUM7QUFBQSxFQUNELFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsS0FBSyxvQkFBb0IsRUFBRSxRQUFRLE1BQU0sRUFBRSxNQUFNLFlBQVksRUFBRSxXQUFXLE1BQU0sRUFBRSxLQUFLLENBQUM7QUFBQSxDQUM5RztBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sRUFBRTtBQUFBLEVBRXBCLE1BQU0sRUFBRTtBQUFBLEVBQ1IsT0FBTyxJQUFJO0FBQUE7QUEwQmIsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiNzZGRjVGMDcwRDFEQkVDNTY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
