import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  type AgentCommand,
  type ClientToServer,
  defaultState,
  type GlamourState,
} from "../../../plugins/spellbook/skills/glamour/shared/types";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";
import { createEventLog } from "../../kit/wire/eventLog.ts";
import { drainAndStop, startHousekeeping } from "../../kit/wire/housekeeping.ts";
import { resolveMode as resolveModeIn, serveFromDist } from "../../kit/wire/serveDist.ts";
import { type SseClients, sseResponse } from "../../kit/wire/sse.ts";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat";
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
//
// The predicate and the scar it carries are now `src/kit/wire/serveDist.ts`;
// what stays here is WHICH directory glamour resolves against. Exported because
// this spell's own suites ask it.
export function resolveMode(): "dev" | "release" {
  return resolveModeIn(DIST_DIR);
}

// Serves dist/ verbatim — entry index.html, hashed chunks by path (Contract 2's
// flat, relative-href layout). ⛔ THE URL→FILENAME MAPPING STAYS HERE ON PURPOSE:
// the kit decides whether a file may be read and what content type it gets, and
// the CALLER decides which file — because two spells route this differently and a
// signature wide enough for both stops being a file server. glamour's own
// `GET /assets/<name>` session-files route sits ABOVE this in the fetch chain,
// and `serveFromDist` refusing anything with a slash in it is what keeps the two
// disjoint (every /assets/ path is nested, so it is refused here and falls
// through).
function serveDist(path: string): Response | null {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}

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
  // The replay log behind `GET /events?since=<id>` — shared
  // (`kit/wire/eventLog.ts`), so glamour inherits the bounded buffer, the
  // monotonic id that actually WINS over a payload `id`, and the stale-watermark
  // replay that lets a tail resuming against a restarted daemon receive anything
  // at all. glamour stamps NO EPOCH: a session is identified by `session_id`, a
  // restart is a different session, and a resuming tail is already talking to a
  // different daemon by name (D19's reasoning for magpie, and it is glamour's too).
  const log = createEventLog<Record<string, unknown>>();
  const sseClients: SseClients = new Set();
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
  const emitEvent = (msg: Record<string, unknown>) => log.emit(msg);

  // Presence is transient: stream to live SSE clients but DO NOT store it in
  // the replay log (a reconnecting agent should not re-see every past
  // connect/disconnect). No id is assigned, so it never advances a tail cursor.
  //
  // ⛔ THIS IS THE ONE THING THE SHARED SSE MODULE COULD NOT DO, AND IT WAS
  // WIDENED RATHER THAN WORKED AROUND. `SseClients` held bare closers, because
  // astrolabe and magpie announce presence over their browser WEBSOCKET and never
  // needed to push an unlogged frame at the agent's tail. Keeping a second,
  // parallel `Set<ReadableStreamDefaultController>` here would have re-created
  // exactly the drift the registry exists to remove — and it is the drift that
  // module's own header warns about, where a per-stream timer was swept from a
  // second set and could fall out of step. So the registry entry gained `send`,
  // which routes through the same closed-check and teardown funnel as every other
  // write. Reported as a finding about the module, per the phase brief.
  const emitTransient = (msg: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of sseClients) c.send(frame);
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

  // GET /events?since=<id> — replay, then stay open for live frames plus a
  // heartbeat comment. One call into `kit/wire/sse.ts`, which is where the
  // teardown funnel lives: `cancel()`, `req.signal` and a failed enqueue all
  // reach it, at most once, and that funnel is what bounds the subscriber count
  // the idle sweep reads. The old copy here relied on `try { enqueue } catch` to
  // notice a departed client, which was MEASURED on Bun 1.3.14 not to work —
  // enqueue on an orphaned stream buffers silently and never throws — and it was
  // not wired to `req.signal` at all, so a client that vanished without
  // cancelling was counted as present for the life of the daemon.
  //
  // ⚠ AND THE HEARTBEAT IS NO LONGER A LITERAL. It was `15000`, hard-coded here,
  // beside a `Bun.serve` `idleTimeout: 255` and a comment explaining that the two
  // are chained. They now come from `./heartbeat.ts`, which derives the pair — so
  // the invariant holds for any value, not only for the two that happened to be
  // written.
  const eventsResponse = (req: Request, url: URL): Response => {
    touch();
    return sseResponse({
      log,
      since: Number.parseInt(url.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: touch,
      onClose: touch,
    });
  };

  // --- serve ------------------------------------------------------------------
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.host ?? "127.0.0.1",
    routes,
    // ⛔ HELD SSE CONNECTIONS DIE WITHOUT THIS. Bun's default request
    // idleTimeout is 10s and a server-sent heartbeat does NOT reset it, so an
    // SSE client is closed before the 15s `: hb` below ever fires — the
    // keepalive arrives five seconds after the thing it was keeping alive is
    // gone, which is why raising the heartbeat rate would not have helped.
    // 255 is Bun's maximum (0 is not "disabled"), matching bounty, grapevine
    // and mind-mapper; astrolabe env-tunes it and clamps the heartbeat to half.
    // Found 2026-09-08 by the backend duplication recon: four spells had hit
    // this and fixed it, three had not, because the daemon spine is one design
    // implemented six times.
    idleTimeout: IDLE_TIMEOUT_SEC,
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
          cursor: log.cursor(),
        });
      }
      if (req.method === "GET" && path === "/events") return eventsResponse(req, url);
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
  // ⚠ ATOMIC, because cli.ts's readSession treats unparseable content as
  // corruption rather than absence — and this implementation is now
  // `kit/wire/discovery.ts`, shared with the singleton convention D3 kept alive
  // beside this one. glamour is where the defect (L3) was found and fixed on
  // 2026-09-07; what stayed here is WHICH files glamour writes.
  try {
    writeFileAtomic(sessionFile, info);
    writeFileAtomic(latestFile, info);
  } catch {
    /* discovery is best-effort */
  }

  // Contract 1: the daemon EMITS its resolved mode — a dev daemon with root deps
  // present renders an identical-looking board, so `mode` is the only thing that
  // tells a verifier which path served it. glamour has THREE transports (imago
  // has two): this event, the discovery file above, and the stdout handshake in
  // import.meta.main below. All three carry it.
  emitEvent({ type: "ready", mode });

  // --- snapshot debounce + idle sweep ----------------------------------------
  //
  // ⛔ THE SWEEP NOW SEES ITS SUBSCRIBERS — census defect L1, closed by the shared
  // housekeeper REQUIRING a `subscriberCount` rather than by anyone remembering.
  // The expression here read `(now - lastActivity)/1000 >= timeout` and nothing
  // else, so an agent holding a `/events` tail on a quiet session was killed WITH
  // ITS CONNECTION OPEN at the 30-minute floor — glamour, imago and magpie all
  // had it. `timeout` now means "linger this long after the LAST subscriber
  // leaves", not "maximum idle while connected".
  const saveNow = () => saveSnapshot(SNAPSHOTS_DIR, sessionId, state);
  if (restored) saveNow();
  const timeoutS = opts.timeoutS ?? 1800;
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: timeoutS * 1000,
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
    snapshot: {
      dirty: () => snapDirty,
      clear: () => {
        snapDirty = false;
      },
      write: saveNow,
    },
  });

  let closed = false;
  // Resolves once the SSE flush + server.stop have been scheduled; callers
  // that need to wait (e.g. import.meta.main before process.exit) can await this.
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((r) => {
    resolveShutdown = r;
  });

  // The session pointer is unconditionally ours; `glamour-latest.json` is NOT —
  // a newer session may already have claimed it, and unlinking that would make
  // the live daemon invisible to the next verb. `unlinkIfMatches`'s `identify`
  // hook is what lets ONE shared predicate serve both this JSON pointer and
  // astrolabe's bare pid file (`kit/wire/discovery.ts`).
  const cleanupDiscovery = () => {
    try {
      unlinkSync(sessionFile);
    } catch {
      /* gone — fine */
    }
    unlinkIfMatches(latestFile, sessionId, (raw) => {
      try {
        const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    });
    try {
      rmSync(sessionFilesDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  };

  // ⛔ STAYS SYNCHRONOUS AND IDEMPOTENT, because `done.then(() => close())` and
  // the suites' `afterAll(() => d.close())` both call it as a statement. The
  // DRAIN is what became async: `drainAndStop` waits its grace period, closes
  // every registered tail through the funnel, closes the sockets, then RACES
  // `server.stop(true)` — because that call awaits its connections and one wedged
  // peer is enough to park teardown forever (a 23-minute hang shipped once).
  //
  // ⚠ THE GRACE PERIOD IS 150 ms, NOT GLAMOUR'S OLD 50, and that is a deliberate
  // wire-observable change rather than an oversight: 150 is the number all eight
  // daemons converged on independently, and it is what turns "the daemon told you
  // why it died" from a hope into an observation. glamour's `closed` frame is the
  // one the CLI's tail watches for.
  const close = () => {
    if (closed) return;
    closed = true;
    stopHousekeeping();
    saveNow();
    cleanupDiscovery();
    emitEvent({ type: "closed" });
    void drainAndStop({ server, clients: sseClients, sockets }).then(resolveShutdown);
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

/** Parse the daemon's argv, boot, print the handshake, and wait for the end.
 *  Returns the process exit code; it does NOT exit — the launcher does. */
export async function main(argv: string[]): Promise<number> {
  let flags: Record<string, string | undefined>;
  try {
    flags = nodeParseArgs({ args: argv, options: DAEMON_OPTIONS, strict: true }).values as Record<
      string,
      string | undefined
    >;
  } catch (e) {
    process.stderr.write(
      `glamour: ${e instanceof Error ? e.message : String(e)}\n` +
        `  recognized flags: ${Object.keys(DAEMON_OPTIONS)
          .map((k) => `--${k}`)
          .join(" ")}\n`,
    );
    return 2;
  }
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
  return res.code;
}

/**
 * The daemon's entry, for the LAUNCHER at
 * `plugins/spellbook/skills/glamour/scripts/server.ts`.
 *
 * ⛔ `import.meta.main` IS FALSE IN THE BUNDLE. `dist/server.js` is IMPORTED by
 * the launcher, never executed as the process entry, so the old
 * `if (import.meta.main)` block would simply never run — the daemon would boot,
 * serve nothing and exit 0, and every test would fail as "the daemon never bound
 * a port", which reads like flake. That is the failure this export exists to
 * prevent, and it is the first thing that breaks on every backend relocation.
 *
 * ⛔ AND THERE IS NO `import.meta.main` BLOCK LEFT, deliberately (D12). Run from
 * `src/glamour/backend/`, `SKILL_ROOT` computes to `src/glamour/`, which holds no
 * `dist/index.html` — so the daemon would silently choose DEV mode and then fail
 * the dev import from the wrong anchor. Offering that entry would be offering a
 * wrong daemon.
 *
 * ⛔ AND IT TAKES NO ARGUMENTS, for the same reason `cli.ts`'s `run()` does not:
 * the command line belongs to the file that PARSES it. A launcher that touched
 * `process.argv` would match `grimoire/lib/entry-points.ts`'s arg-parsing
 * predicate and the wards would judge this daemon's flags against a file that
 * recognises none.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}
