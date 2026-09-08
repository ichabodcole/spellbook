import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  type AgentCommand,
  type ClientToServer,
  defaultState,
  type GlamourState,
} from "../shared/types";
import { loadSnapshot, materializeItem, saveSnapshot } from "./persist.server";
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
} from "./reduce";
import {
  loadTray,
  materializeCanon,
  projectKey,
  saveStyle,
  setStyleArchived,
} from "./styles.server";

// The surface's HTML entry used to be a top-level static import here. A static
// import forces Bun to resolve the whole .tsx + Tailwind graph when this module
// LOADS, so a destination that ships dist/ and no surface source — the published
// artifact — dies before it can serve the dist it does have. The dev import is
// therefore dynamic and reached only on the dev branch below (seams Contract 1),
// as astrolabe, imago and mind-mapper do it.
//
// Paths anchor at the SKILL ROOT, never at cwd: cli.ts pins the daemon's cwd for
// bunfig.toml's sake in dev (Contract 5), so cwd is not a stable base for dist/.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// release iff dist/index.html exists at the skill root — the FILE, never the
// directory (a built backend can put cli.js in dist/ with no surface there) —
// else dev; the env override wins either way (Contract 1). Release: zero reads
// of surface source or bunfig.toml — static files only.
export function resolveMode(): "dev" | "release" {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release") return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Serves dist/ verbatim — entry index.html, hashed chunk-*.js/css by path
// (Contract 2's flat, relative-href layout). A static asset request is always a
// bare filename, never nested: the guard is what keeps this one level deep and
// disjoint from glamour's own GET /assets/<name> session-files route above it
// (every /assets/ path is nested, so it is refused here and falls through).
function serveDist(path: string): Response | null {
  const rel = path === "/" ? "index.html" : path.slice(1);
  if (rel.includes("..") || rel.includes("/")) return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file)) return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
}

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
  // --- mode, resolved BEFORE any filesystem write -----------------------------
  // A forced-dev boot at a surface-free destination must die HERE, at the import,
  // having written nothing: no session-files dir, no discovery pointer. Measured
  // in the local-sim: with this block placed after the session-files mkdir, a
  // dying daemon left `$TMPDIR/glamour-<id>-files/` behind on every failed boot.
  const mode = resolveMode();
  // dev: the dynamic string-literal import keeps the surface graph off the module
  // load path (Contract 1) — Bun bundles the .tsx graph + Tailwind at serve time,
  // reading bunfig.toml from cwd, which cli.ts pins to src/glamour/ (Contract 5).
  // release: dist/ is static and pre-built (Contract 2) — "/" is answered by
  // serveDist() in the fetch fall-through, so this branch never touches surface
  // source or bunfig.toml and never needs either to exist. Bun's Routes type ties
  // the "/" value's type to the literal object shape, so the mode-ternary union
  // is cast; the runtime behaviour (HTMLBundle in dev, absent in release) is
  // correct either way. This is the ONE src/-naming specifier in the deployed
  // spell (plan S2, ratified at the specifier grain).
  const devIndex =
    mode === "dev"
      ? (await import("../../../../../src/glamour/surface/index.html")).default
      : undefined;
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;
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

  // #84 — RETURNS A VERDICT. Previously void, so the /cmd route had nothing to
  // report and answered a literal {ok:true} to every command including ones it
  // dropped. Note the defect is NOT a missing `await`: this handler is
  // synchronous, and imago's twin IS correctly awaited and was broken anyway.
  // The fix is that a decision exists at all.
  // Contract 13: the verdict originates in the code owning the recognised set.
  // b12 widens the RETURN without widening the CONTRACT — a command may answer
  // with a result object carrying its own payload instead of the boolean. Every
  // other command still returns a bare boolean and its response is
  // byte-identical. Same shape as imago's context.add (5e6aacd).
  type AgentVerdict = boolean | { recognised: true; ok: true; detail: Record<string, unknown> };
  const handleAgentMsg = (msg: AgentCommand): AgentVerdict => {
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
          round: msg.round,
        },
      });
      materializeItem(sessionFilesDir, it);
      // b12 + #87 (third spell) — `if (addItem(state, it)) broadcastState()`
      // dropped the mutator's outcome into control flow and answered ok:true
      // either way. Two things were wrong and only one is what the card said:
      //
      //   REACHABLE, every call: the minted id was DISCARDED, so the agent that
      //   just created an item could not reference it. That is #87's defect in a
      //   third codebase (imago context.add, and this).
      //
      //   NOT REACHABLE in practice: the "silent dedupe". `id` is minted HERE
      //   (`gen-${randHex(4)}`) and the caller cannot supply one — `buildGenCmd`
      //   has no id field, and this line ignores any that arrived — so addItem
      //   returns false only on a 2^32 collision. The branch was dead, not
      //   dangerous. It is reported honestly now rather than removed, because a
      //   collision that DID happen would otherwise be the silent case.
      const added = addItem(state, it);
      if (added) broadcastState();
      return {
        recognised: true,
        ok: true,
        detail: { id: it.id, outcome: added ? "created" : "already-recorded" },
      };
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
      return true;
    }
    if (msg.type === "style.archive") {
      setStyleArchived(GLAMOUR_HOME, PROJECT_KEY, msg.id, msg.archived);
      applyAgentMsg(state, msg); // flips the in-memory tray entry
      broadcastState();
      return true;
    }
    // The fallthrough is the only path that can be UNRECOGNISED, and the
    // reducer is what knows: it owns the case list, so the verdict comes from
    // there rather than from a second enumeration here.
    const recognised = applyAgentMsg(state, msg);
    if (recognised) broadcastState();
    return recognised;
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
    routes,
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
          cursor: eventSeq,
        });
      }
      if (req.method === "GET" && path === "/events") return sseResponse(url);
      if (req.method === "POST" && path === "/cmd")
        return req
          .json()
          .then((b) => {
            touch();
            // #84 — propagate the handler's verdict instead of a literal
            // {ok:true}. `applied` is the field bounty already uses
            // (server.ts ApplyResult); no new vocabulary is minted here.
            const verdict = handleAgentMsg(b as AgentCommand);
            // A command that answered with its own result carries its payload;
            // the boolean path below is unchanged.
            if (typeof verdict === "object")
              return Response.json({ ok: true, applied: true, ...verdict.detail });
            const applied = verdict;
            if (!applied) {
              return Response.json(
                {
                  ok: false,
                  applied: false,
                  error: `unrecognised command type ${JSON.stringify(
                    (b as { type?: unknown })?.type,
                  )} — nothing was applied`,
                },
                { status: 400 },
              );
            }
            return Response.json({ ok: true, applied: true });
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
      // release: "/" and the hashed chunk-*.js/css are static dist reads. Dev
      // never reaches here for "/" — the routes table above answers it first.
      // This sits AFTER /assets/, which serves session files, not dist ones.
      if (mode === "release") {
        const asset = serveDist(path);
        if (asset) return asset;
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
    mode,
  });
  // ⚠ ATOMIC, because cli.ts's readSession now treats unparseable content as
  // corruption rather than absence. A bare writeFileSync is not atomic: a CLI
  // reading while the daemon writes can observe a half-written pointer, and
  // under the old best-effort read that surfaced as "no running glamour
  // session". Write beside the target and rename — rename within one directory
  // is atomic, so a reader sees either the previous pointer or the new one.
  const writeAtomic = (target: string, text: string) => {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, target);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp file is already gone, or was never created */
      }
      throw new Error(`could not publish ${target}`);
    }
  };
  try {
    writeAtomic(sessionFile, info);
    writeAtomic(latestFile, info);
  } catch {
    /* discovery is best-effort */
  }

  // Contract 1: the daemon EMITS its resolved mode — a dev daemon with root deps
  // present renders an identical-looking board, so `mode` is the only thing that
  // tells a verifier which path served it. glamour has THREE transports (imago
  // has two): this event, the discovery file above, and the stdout handshake in
  // import.meta.main below. All three carry it.
  emitEvent({ type: "ready", mode });

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

  return { port: boundPort, sessionId, mode, close, done, shutdown };
}

// #81 / D4 — THE RECOGNIZED SET, AT PARSER ALTITUDE. The SIXTH entry point.
//
// ⚠ THIS ONE HAS ZERO `flags.` READS, so a `flags.`-pattern audit returns zero
// here — and a zero reads identically to "no drift". It was a LOOKUP parser:
// `const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0
// ? args[i + 1] : undefined; }`. It also read `Bun.argv`, not `process.argv`,
// which is the synonym that has made this repo's greps lie before.
//
// It had a LATENT, PRE-EXISTING bug the conversion fixes as a side effect, noted
// so the change is not mistaken for a regression: `flag()` returned `args[i+1]`
// UNCONDITIONALLY, so `--restore --title X` yielded `restore === "--title"` —
// the next FLAG silently consumed as the previous flag's VALUE.
//
// All six are string by construction (the old helper returned the next argv
// element). `port` and `timeout` are Number()-coerced at the call site, which is
// a value read, not a boolean one. The daemon takes no positionals, so strict's
// default rejection of them is correct.
//
// Verified before converting: `cli.ts` spawns this daemon with exactly --title,
// --intent, --timeout, --restore and --project, all inside this set — so strict
// cannot refuse the daemon's own launch.
const DAEMON_OPTIONS = {
  intent: { type: "string" },
  port: { type: "string" },
  project: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
} as const;

if (import.meta.main) {
  let flags: Record<string, string | undefined> | null = null;
  try {
    flags = nodeParseArgs({ args: Bun.argv.slice(2), options: DAEMON_OPTIONS, strict: true })
      .values as Record<string, string | undefined>;
  } catch (e) {
    process.stderr.write(
      `glamour: ${e instanceof Error ? e.message : String(e)}\n` +
        `  recognized flags: ${Object.keys(DAEMON_OPTIONS)
          .map((k) => `--${k}`)
          .join(" ")}\n`,
    );
    // exitCode + natural end, never process.exit — the drained-exit discipline.
    process.exitCode = 2;
  }
  if (flags) {
    const d = await startDaemon({
      port: flags.port ? Number(flags.port) : 0,
      title: flags.title,
      intent: flags.intent,
      restore: flags.restore,
      timeoutS: flags.timeout ? Number(flags.timeout) : undefined,
      project: flags.project,
    });
    process.stdout.write(
      `${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId, mode: d.mode })}\n`,
    );
    const res = await d.done;
    // Wait for the closed SSE event to flush before exiting.
    await d.shutdown;
    process.exit(res.code);
  }
}
