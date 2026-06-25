import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import index from "../surface/index.html";
import { loadSnapshot, materializeItem, saveSnapshot } from "../surface/state/persist.server";
import {
  addItem,
  addMessage,
  annotate,
  applyAgentMsg,
  buildStyleItem,
  clearFocus,
  leanItem,
  leanState,
  makeItem,
  selectItems,
  setCanonical,
  setFocus,
  setItemArchived,
  setLike,
  setStar,
} from "../surface/state/reduce";
import {
  loadTray,
  materializeCanon,
  projectKey,
  saveStyle,
  setStyleArchived,
} from "../surface/state/styles.server";
import {
  type AgentCommand,
  type ClientToServer,
  defaultState,
  type GlamourState,
} from "../surface/state/types";

const enc = new TextEncoder();
const randHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export type StartOpts = {
  port?: number;
  host?: string;
  title?: string;
  intent?: string;
  restore?: string;
  timeoutS?: number;
  project?: string;
};

export async function startDaemon(opts: StartOpts) {
  const GLAMOUR_HOME = process.env.GLAMOUR_HOME ?? join(homedir(), ".glamour");
  const SNAPSHOTS_DIR = join(GLAMOUR_HOME, "snapshots");
  let state: GlamourState = defaultState(opts.title ?? "", opts.intent ?? "");
  let restored = false;
  if (opts.restore) {
    const path = existsSync(opts.restore)
      ? opts.restore
      : join(SNAPSHOTS_DIR, `${opts.restore}.json`);
    try {
      state = loadSnapshot(path, opts.title ?? "", opts.intent ?? "");
      restored = true;
    } catch (e) {
      process.stderr.write(`glamour: restore failed (${path}): ${e}\n`);
    }
  }
  const PROJECT_KEY = projectKey(opts.project ?? process.cwd());
  // Load the project's saved styles into the tray (metadata only — NOT the
  // library). Do this after restore so a restored snapshot's stale tray is
  // replaced by the authoritative on-disk set.
  state.tray = loadTray(GLAMOUR_HOME, PROJECT_KEY);

  // --- channels ---------------------------------------------------------------
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
  const events: Array<Record<string, unknown>> = [];
  let eventSeq = 0;
  const sseClients = new Set<ReadableStreamDefaultController>();
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  const broadcast = (msg: object) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* socket closed */
      }
    }
  };
  let snapDirty = false;
  const broadcastState = () => {
    snapDirty = true;
    broadcast({ type: "state", state });
  };
  const emitEvent = (msg: Record<string, unknown>) => {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    const frame = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {
        /* gone */
      }
    }
  };

  // Presence is transient: stream to live SSE clients but DO NOT store it in
  // the replay log (a reconnecting agent should not re-see every past
  // connect/disconnect). No id is assigned, so it never advances a tail cursor.
  const emitTransient = (msg: Record<string, unknown>) => {
    const frame = enc.encode(`data: ${JSON.stringify(msg)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {
        /* gone */
      }
    }
  };

  // --- session files ----------------------------------------------------------
  const sessionId = `glamour-${randHex(4)}`;
  const sessionFilesDir = join(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync(sessionFilesDir, { recursive: true });
  } catch {
    /* fall back to no paths */
  }
  if (restored) {
    for (const it of state.library) materializeItem(sessionFilesDir, it);
  }

  // --- agent commands (POST /cmd) --------------------------------------------
  let resolveDone!: (v: { code: number; reason: string }) => void;
  const done = new Promise<{ code: number; reason: string }>((r) => {
    resolveDone = r;
  });

  const handleAgentMsg = (msg: AgentCommand) => {
    if (msg.type === "say") {
      addMessage(state, {
        id: `m-${randHex(4)}`,
        who: "agent",
        kind: msg.kind ?? "info",
        text: msg.text,
        ground: [],
        ts: Date.now(),
      });
      broadcastState();
      return;
    }
    if (msg.type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return;
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
          round: msg.round,
        },
      });
      materializeItem(sessionFilesDir, it);
      if (addItem(state, it)) broadcastState();
      return;
    }
    if (msg.type === "style.save") {
      const canonicalItems = state.library.filter((i) => i.canonical && !i.archived);
      const agreed = state.styleGuide.filter((s) => s.status !== "empty" && s.content);
      const text = agreed
        .map((s) => s.content)
        .join(" · ")
        .slice(0, 280);
      const style = saveStyle(GLAMOUR_HOME, PROJECT_KEY, {
        id: `style-${randHex(4)}`,
        label: msg.label,
        text,
        sections: state.styleGuide,
        canonicalItems,
        createdAt: Date.now(),
      });
      state.tray.push(style);
      broadcastState();
      return;
    }
    if (msg.type === "style.archive") {
      setStyleArchived(GLAMOUR_HOME, PROJECT_KEY, msg.id, msg.archived);
      applyAgentMsg(state, msg); // flips the in-memory tray entry
      broadcastState();
      return;
    }
    applyAgentMsg(state, msg);
    broadcastState();
  };

  // --- browser messages (WebSocket) ------------------------------------------
  const handleClientMsg = (msg: ClientToServer) => {
    switch (msg.type) {
      case "item.add": {
        const it = makeItem({
          id: `${msg.item.kind}-${randHex(4)}`,
          kind: msg.item.kind,
          title: msg.item.title,
          src: msg.item.src,
          text: msg.item.text,
          mime: msg.item.mime ?? "",
          createdAt: Date.now(),
        });
        materializeItem(sessionFilesDir, it);
        if (addItem(state, it)) {
          broadcastState();
          emitEvent({
            type: "item.add",
            item: leanItem(it),
            selectedIds: state.selectedIds,
          });
        }
        break;
      }
      case "item.select":
        selectItems(state, msg.ids);
        broadcastState();
        break;
      case "item.star":
        if (setStar(state, msg.id, msg.starred)) broadcastState();
        break;
      case "item.like":
        if (setLike(state, msg.id, msg.liked)) broadcastState();
        break;
      case "item.annotate":
        // Ambient: the human's per-item note is stored + UI-synced + persisted,
        // and the agent reads it on demand from state when it looks at the image.
        // It is NOT pushed as an agent event — a sticky note, not a real-time
        // signal (see the event-volume lesson; avoids interrupting the agent on
        // every blur).
        if (annotate(state, msg.id, "human", msg.human)) broadcastState();
        break;
      case "message.send": {
        const ground = [...state.selectedIds];
        addMessage(state, {
          id: `m-${randHex(4)}`,
          who: "user",
          kind: "info",
          text: msg.text,
          ground,
          ts: Date.now(),
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
        if (setCanonical(state, msg.id, msg.canonical)) broadcastState();
        break;
      case "item.archive":
        if (setItemArchived(state, msg.id, msg.archived)) broadcastState();
        break;
      case "style.bringIn": {
        const style = state.tray.find((s) => s.id === msg.id);
        if (!style) break;
        const itemId = `style-${style.id}`;
        if (state.library.some((i) => i.id === itemId)) break; // idempotent
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

  // --- SSE response (replay by id + heartbeat) -------------------------------
  const sseResponse = (url: URL): Response => {
    touch();
    const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
    let ref: ReadableStreamDefaultController | null = null;
    let hb: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if ((ev.id as number) > since)
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
        sseClients.add(controller);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb\n\n`));
          } catch {
            /* gone */
          }
        }, 15000);
      },
      cancel() {
        if (hb) clearInterval(hb);
        if (ref) sseClients.delete(ref);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  // --- serve ------------------------------------------------------------------
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.host ?? "127.0.0.1",
    routes: { "/": index },
    development: { hmr: true },
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
          cursor: eventSeq,
        });
      }
      if (req.method === "GET" && path === "/events") return sseResponse(url);
      if (req.method === "POST" && path === "/cmd")
        return req
          .json()
          .then((b) => {
            touch();
            handleAgentMsg(b as AgentCommand);
            return Response.json({ ok: true });
          })
          .catch(() => Response.json({ error: "bad json" }, { status: 400 }));
      if (req.method === "GET" && path.startsWith("/assets/")) {
        const name = decodeURIComponent(path.slice("/assets/".length));
        if (name.includes("..") || name.startsWith("/"))
          return Response.json({ error: "not found" }, { status: 404 });
        const f = Bun.file(join(sessionFilesDir, name));
        return f
          .exists()
          .then((ok) =>
            ok ? new Response(f) : Response.json({ error: "not found" }, { status: 404 }),
          );
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
          handleClientMsg(
            JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw),
            ) as ClientToServer,
          );
        } catch (e) {
          process.stderr.write(`glamour: bad json from browser: ${e}\n`);
        }
      },
      close(ws) {
        sockets.delete(ws);
        emitTransient({ type: "disconnected" });
      },
    },
  });

  const boundPort = server.port;
  // --- discovery files (cli.ts reads these) ----------------------------------
  const sessionFile = join(tmpdir(), `glamour-${sessionId}.json`);
  const latestFile = join(tmpdir(), `glamour-latest.json`);
  const info = JSON.stringify({
    url: `http://${opts.host ?? "127.0.0.1"}:${boundPort}`,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
  });
  try {
    writeFileSync(sessionFile, info);
    writeFileSync(latestFile, info);
  } catch {
    /* discovery is best-effort */
  }

  emitEvent({ type: "ready" });

  // --- snapshot debounce + idle timeout --------------------------------------
  const saveNow = () => saveSnapshot(SNAPSHOTS_DIR, sessionId, state);
  if (restored) saveNow();
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
  // Resolves once the SSE flush + server.stop have been scheduled; callers
  // that need to wait (e.g. import.meta.main before process.exit) can await this.
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((r) => {
    resolveShutdown = r;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(snapTimer);
    clearInterval(idleTimer);
    saveNow();
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      const raw = readFileSync(latestFile, "utf8");
      const parsed = JSON.parse(raw) as { session_id?: string };
      if (parsed.session_id === sessionId) unlinkSync(latestFile);
    } catch {
      /* best-effort */
    }
    try {
      rmSync(sessionFilesDir, { recursive: true, force: true });
    } catch {}
    emitEvent({ type: "closed" });
    // Close each SSE controller so Bun flushes the queued frame to the client
    // before tearing down the TCP connections.
    for (const c of sseClients) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    sseClients.clear();
    // Give Bun a tick to drain the final SSE frames, then stop the server.
    setTimeout(() => {
      server.stop(true);
      resolveShutdown();
    }, 50);
  };
  done.then(() => close());

  return { port: boundPort, sessionId, close, done, shutdown };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const d = await startDaemon({
    port: flag("port") ? Number(flag("port")) : 0,
    title: flag("title"),
    intent: flag("intent"),
    restore: flag("restore"),
    timeoutS: flag("timeout") ? Number(flag("timeout")) : undefined,
    project: flag("project"),
  });
  process.stdout.write(
    `${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId })}\n`,
  );
  const res = await d.done;
  // Wait for the closed SSE event to flush before exiting.
  await d.shutdown;
  process.exit(res.code);
}
