#!/usr/bin/env bun

// astrolabe — a standing observatory daemon: one board showing the live state
// of every project in flight (conjuration). A level ABOVE grapevine/bounty —
// where grapevine is one team's channel and bounty is one team's task board,
// the observatory is the view ACROSS all of them.
//
// SINGLETON per $ASTROLABE_HOME (cf. grapevine): one daemon, one board. cli.ts
// auto-spawns it on the first verb and discovers it via $ASTROLABE_HOME/daemon.*.
//
// The house agent-interface pattern (shared with grapevine + bounty): the
// daemon holds canonical state; the agent drives it through a thin `cli.ts`
// over HTTP, and the browser is wired over WebSocket.
//   - Agent → daemon:  POST /cmd                         (an AgentCommand; write path)
//   - Agent ← daemon:  GET  /state                       ({ state, cursor } read-back)
//                      GET  /events?since=<id>&project=<id>  (SSE tail, resumable)
//   - Browser ↔ daemon: WebSocket /ws                    (full-state push + live events)
//
// PERSISTENCE — the DURABLE REGISTRY ONLY (projects) is snapshotted to
// $ASTROLABE_HOME/registry.json and restored on start. Presence AND status are
// LIVE: a restored daemon starts with every project disconnected and no status
// until agents rejoin and re-post (stale post-restart status would mislead).
//
// PRESENCE = the live connection, not a command. A project's card is "active"
// while an agent holds a `GET /events?project=<id>` tail open (ref-counted, so
// it stays active until the LAST tail closes); the connection dropping (clean
// exit OR crash) flips it idle. So there is no `project.join` /cmd — presence
// can't be asserted without holding the watch.
//
// AgentCommand — POST /cmd body (one of). All carry an optional `as` (caller
// identity → event `by`); /cmd returns {ok, applied, error?}:
//   {"type":"project.add",    "project": Project}                      // register (durable); dedupe-guarded
//   {"type":"project.remove", "id": "..."}
//   {"type":"status",         "id": "...", "summary": "...", "phase"?: "..."}  // REPLACES current status (no history)
//   {"type":"attention",      "id": "...", "raised": bool, "question"?: "..."} // agent → human gate
//   {"type":"poke",           "id": "..."}                             // human → agent: request a fresh status (event only)
//   {"type":"close"}                                                   // dismiss the observatory
//
// Event log — GET /events frames (server → agent), each with a monotonic `id`
// (the resume cursor) and an actor `by`:
//   {id, type:"ready",        url, port, session_id, mode, by:"system"}   // mode: dev|release
//   {id, type:"connected" | "disconnected", by:"user"}                // browser watch presence
//   {id, type:"project.add",  project, by}
//   {id, type:"project.remove", projectId, by}
//   {id, type:"presence",     projectId, connected, by:"system"}      // SSE tail open/close
//   {id, type:"status",       projectId, summary, phase?, by}
//   {id, type:"attention",    projectId, raised, question?, by}
//   {id, type:"poke",         projectId, by}                          // the project's listening agent reacts
//   {id, type:"closed",       reason, by:"system"}                    // reason: user|timeout|close
//
// Exit codes: 0 on any clean dismiss, 2 bad args, 124 idle timeout. The
// observatory is a conjuration — there's no "cancel"/130 discard path.

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import {
  applyAttention,
  applyProjectAdd,
  applyProjectRemove,
  applySetPresence,
  applyStatus,
  emptyState,
  type ObservatoryState,
  type Project,
} from "../../../plugins/spellbook/skills/astrolabe/scripts/state.ts";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";
import { createEventLog } from "../../kit/wire/eventLog.ts";
import { drainAndStop, startHousekeeping } from "../../kit/wire/housekeeping.ts";
import { resolveMode, serveFromDist } from "../../kit/wire/serveDist.ts";
import { type SseClients, sseResponse } from "../../kit/wire/sse.ts";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat.ts";

export type {
  ObservatoryState,
  Project,
} from "../../../plugins/spellbook/skills/astrolabe/scripts/state.ts";

// ── surface mode (seams Contract 1) ─────────────────────────────────────────
//
// The surface reaches the daemon two ways and ONLY ONE of them may sit on the
// module load path. `import index from "../surface/index.html"` used to be a
// top-level STATIC import here: that forces Bun to resolve the whole .tsx +
// Tailwind build graph when the module LOADS, so a destination that ships
// `dist/` and no `surface/` — the published artifact — dies before it can serve
// the dist it does have. The dev import below is therefore dynamic and inside
// the release branch's `else`, exactly as mind-mapper/scripts/server.ts does it.
//
// Paths are anchored at the SKILL ROOT, never at cwd: cli.ts pins the daemon's
// cwd for bunfig.toml's sake (Contract 5), so cwd is not a stable base for
// dist/.
//
// ⛔ `import.meta.dir` HERE IS THE DIRECTORY OF THE EMITTED BUNDLE, NOT OF THIS
// FILE. This module is AUTHORED at `src/astrolabe/backend/server.ts` and
// EXECUTES as `plugins/spellbook/skills/astrolabe/dist/server.js` (Phase 1b).
// `dist/` sits at the SAME DEPTH as `scripts/`, so every ANCESTOR-relative path
// below is unchanged by the move — the same "up and back down is correct from
// BOTH locations" trick `cli.ts` records. A SIBLING-relative path would NOT be;
// see `magpie/backend/backend.ts`'s remove.py, which is where that went wrong
// for real. Asserted in `server.test.ts`, not reasoned about.
const SCRIPT_DIR = import.meta.dir;
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// Serves dist/ verbatim — entry index.html plus the hashed JS and CSS chunks
// (Contract 2's flat, relative-href layout). THE URL-TO-FILENAME MAPPING IS
// THIS SPELL'S; the file read, the traversal guard and the content type are
// `src/kit/wire/serveDist.ts` — which is the split the census asked for, since
// two of the eight daemons diverge in this mapping and none diverges below it.
function serveDist(path: string): Response | null {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}

// Persistence + discovery root. cli.ts derives the same path, so overriding
// ASTROLABE_HOME relocates both the registry snapshot and the daemon.* files.
const ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join(homedir(), ".astrolabe");
const REGISTRY_FILE = join(ASTROLABE_HOME, "registry.json");
const PORT_FILE = join(ASTROLABE_HOME, "daemon.port");
const PID_FILE = join(ASTROLABE_HOME, "daemon.pid");

// Connection keepalive (presence-flap fix). Bun.serve closes a connection idle
// for `idleTimeout` seconds; a held `join` SSE that only heartbeats SLOWER than
// that gets closed at the timeout, the cli reconnects, and the reconnect flips
// presence disconnect→connect — flickering the card every idle window and
// flooding the event log. The pair now lives in `./heartbeat.ts`, imported by
// BOTH this daemon and `cli.ts`; the reasoning is in `kit/wire/heartbeat.ts`.
//
// How long to defer a presence idle-flip; a reconnect within this window cancels
// it (see idleTimers). Tunable for tests.
const PRESENCE_DEBOUNCE_MS =
  Number.parseInt(process.env.ASTROLABE_PRESENCE_DEBOUNCE_MS ?? "2500", 10) || 2500;

type DoneResult = { code: number; reason: string };
// b2/#85 — `outcome` carries a benign no-op's NOUN (already-connected,
// already-raised, …). A no-op has no `error`; the two together are what let a
// caller tell "the state was already what I asked for" from "I was rejected".
type ApplyResult = {
  ok: boolean;
  applied: boolean;
  error?: string;
  id?: string;
  outcome?: string;
};

// ── pure helpers ─────────────────────────────────────────────────────

// The single project-shape trust boundary — the agent /cmd path and a restored
// registry both pass untrusted objects through here (filter-and-keep-valid).
function validateProject(p: unknown): Project | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.trim() === "") return null;
  if (typeof o.path !== "string" || o.path.trim() === "") return null;
  // id is optional on the way in — applyProjectAdd derives it from the name when
  // absent (a restored registry entry already carries one).
  const out: Project = { id: typeof o.id === "string" ? o.id : "", name: o.name, path: o.path };
  if (typeof o.description === "string") out.description = o.description;
  if (typeof o.avatar === "string") out.avatar = o.avatar;
  return out;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best-effort */
  }
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Observatory" },
        timeout: { type: "string", default: "0" }, // 0 = standing (never idle-close)
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const v = parsed.values;
  const timeout = Number.parseFloat(v.timeout as string);
  const port = Number.parseInt(v.port as string, 10);
  const host = v.host as string;

  // Initial state — the durable registry restored (merge-over-defaults so an
  // older snapshot gains new fields without crashing; each project runs through
  // validateProject so a malformed entry is dropped, not fatal). Presence and
  // status start EMPTY (live layers — never persisted).
  let state: ObservatoryState = emptyState(v.title as string);
  if (existsSync(REGISTRY_FILE)) {
    try {
      const snap = JSON.parse(await Bun.file(REGISTRY_FILE).text()) as Partial<ObservatoryState>;
      if (typeof snap.title === "string") state.title = snap.title;
      if (Array.isArray(snap.projects)) {
        for (const raw of snap.projects) {
          const p = validateProject(raw);
          if (p) state = applyProjectAdd(state, p).state; // dedupe-guarded on the way in
        }
      }
    } catch (e) {
      process.stderr.write(
        `astrolabe: registry restore failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  const sockets = new Set<ServerWebSocket<unknown>>();

  // Append-only event log for the agent SSE tail (GET /events). Monotonic `id`
  // is the resume cursor (?since=<id>); `cursor` in GET /state is the log's
  // cursor.
  //
  // ⛔ AND IT STAMPS AN EPOCH — a fresh one per daemon boot. Astrolabe is a
  // SINGLETON that `cli.ts` respawns on demand, and its ids restart at 1 after
  // every restart, so a `join` resuming at `since=<last id it saw>` could not
  // tell a stale watermark from a fresh one. The client half
  // (`kit/wire/tailEvents.ts`'s `epochOf` / `onEpochChange`) has been able to
  // act on this since Phase 1a and had nothing to read. The log's OTHER half of
  // the repair — replaying whole when `since` is beyond our own cursor — is
  // what makes the epoch reachable at all; see `kit/wire/eventLog.ts`.
  const log = createEventLog<Record<string, unknown>>({ epoch: crypto.randomUUID() });
  const sseClients: SseClients = new Set();

  // Per-project SSE connection counts → presence is connected while ≥1 tail is
  // open, idle once the last closes (ref-counted so two watchers don't fight).
  const projectConns = new Map<string, number>();
  // Pending idle-flip timers (presence-disconnect debounce). A long-lived join's
  // SSE is reconnected periodically (Bun closes a connection idle past
  // idleTimeout, and server heartbeats don't reset that), so the idle flip is
  // DEFERRED — a reconnect within the window cancels it and the card never
  // flickers active↔idle. Also absorbs transient network drops.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Debounced persistence of the DURABLE REGISTRY ONLY. Only project.add /
  // project.remove dirty it; status/attention/presence are live, never saved.
  let snapDirty = false;
  const saveRegistry = async () => {
    try {
      mkdirSync(ASTROLABE_HOME, { recursive: true });
      await Bun.write(
        REGISTRY_FILE,
        JSON.stringify({ title: state.title, projects: state.projects }),
      );
    } catch {
      /* persistence is best-effort */
    }
  };
  const DIRTYING = new Set(["project.add", "project.remove"]);

  let resolveDone!: (val: DoneResult) => void;
  let settled = false;
  const done = new Promise<DoneResult>((res) => {
    resolveDone = (val) => {
      if (settled) return;
      settled = true;
      res(val);
    };
  });

  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  // The /state projection — merges the three layers into agent-facing cards
  // (readback-parity: an agent reading `state` sees what the surface renders).
  // `zone` is the coarse floor (attention > active > quiet); t5's surface
  // refines idle/stale/done from `connected` + `lastUpdated`.
  function projectCards() {
    return state.projects.map((p) => {
      const connected = state.presence[p.id]?.connected ?? false;
      const st = state.status[p.id];
      const needsAttention = st?.needsAttention ?? false;
      return {
        ...p,
        connected,
        needsAttention,
        question: needsAttention ? st?.question : undefined,
        status: st ? { summary: st.summary, phase: st.phase, lastUpdated: st.lastUpdated } : null,
        zone: needsAttention ? "attention" : connected ? "active" : "quiet",
      };
    });
  }
  const projectState = () => ({ title: state.title, projects: projectCards() });

  function broadcastState() {
    const s = JSON.stringify({ type: "state", ...projectState() });
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* socket closed */
      }
    }
  }

  // Append a frame to the agent event log + push to live SSE tails. The
  // monotonic `id` MUST win over any `id` in the payload, so callers carry a
  // project identifier as `projectId`, never `id` — and the log now ENFORCES
  // that rather than asking for it.
  function emitEvent(msg: Record<string, unknown>) {
    if (typeof msg.type === "string" && DIRTYING.has(msg.type)) snapDirty = true;
    log.emit(msg);
  }

  // A scoped tail opening/closing drives presence (ref-counted). On the 0→1
  // edge the project goes connected; on 1→0 the idle flip is DEBOUNCED.
  function presenceConnect(projectId: string) {
    // A (re)connect cancels any pending idle flip — so a reconnect inside the
    // debounce window leaves the card connected (no flicker).
    const pending = idleTimers.get(projectId);
    if (pending) {
      clearTimeout(pending);
      idleTimers.delete(projectId);
    }
    const n = (projectConns.get(projectId) ?? 0) + 1;
    projectConns.set(projectId, n);
    if (n === 1) {
      const r = applySetPresence(state, projectId, true);
      if (r.applied) {
        state = r.state;
        emitEvent({ type: "presence", projectId, connected: true, by: "system" });
        broadcastState();
      }
    }
  }
  function presenceDisconnect(projectId: string) {
    const n = Math.max(0, (projectConns.get(projectId) ?? 0) - 1);
    if (n === 0) projectConns.delete(projectId);
    else projectConns.set(projectId, n);
    if (n !== 0) return;
    // Defer the idle flip — a reconnect within PRESENCE_DEBOUNCE_MS cancels it.
    if (idleTimers.has(projectId)) return;
    const timer = setTimeout(() => {
      idleTimers.delete(projectId);
      if ((projectConns.get(projectId) ?? 0) !== 0) return; // reconnected meanwhile
      const r = applySetPresence(state, projectId, false);
      if (r.applied) {
        state = r.state;
        emitEvent({ type: "presence", projectId, connected: false, by: "system" });
        broadcastState();
      }
    }, PRESENCE_DEBOUNCE_MS);
    idleTimers.set(projectId, timer);
  }

  // GET /events?since=<id>&project=<id> — replay, then stay open for live frames
  // plus a heartbeat comment. A `project` param binds PRESENCE to this
  // connection's lifetime, which is this spell's whole reason for having a
  // scoped tail: presence cannot be asserted without holding the watch. Ride it
  // on the kit's open/close hooks, which fire exactly once each.
  function eventsResponse(req: Request, url: URL): Response {
    touch();
    const projectId = url.searchParams.get("project") ?? undefined;
    const bind =
      projectId && state.projects.some((p) => p.id === projectId) ? projectId : undefined;
    return sseResponse({
      log,
      since: Number.parseInt(url.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: bind ? () => presenceConnect(bind) : undefined,
      onClose: bind ? () => presenceDisconnect(bind) : undefined,
    });
  }

  // Single dispatch point for an AgentCommand. Threads canonical state through a
  // pure t2 reducer; on applied:true commits the new state, broadcasts to the
  // browser, and appends an event frame. On applied:false returns the reducer's
  // error so the CLI can surface a dedupe rejection / unknown id.
  function handleAgentMsg(msg: Record<string, unknown>): ApplyResult {
    const by = typeof msg.as === "string" ? msg.as : "agent";
    const type = msg.type;

    if (type === "project.add") {
      const project = validateProject(msg.project);
      if (!project) return { ok: true, applied: false, error: "invalid project" };
      const r = applyProjectAdd(state, project);
      if (!r.applied) return { ok: true, applied: false, error: r.error, outcome: r.outcome };
      state = r.state;
      // emit the REGISTERED project (with the derived id + avatar), not the raw input
      const registered = state.projects.find((p) => p.id === r.id);
      emitEvent({ type: "project.add", project: registered, by });
      broadcastState();
      return { ok: true, applied: true, id: r.id };
    }

    if (type === "project.remove") {
      const id = String(msg.id ?? "");
      const r = applyProjectRemove(state, id);
      if (!r.applied) return { ok: true, applied: false, error: r.error, outcome: r.outcome };
      state = r.state;
      projectConns.delete(id);
      const pendingIdle = idleTimers.get(id);
      if (pendingIdle) {
        clearTimeout(pendingIdle);
        idleTimers.delete(id);
      }
      emitEvent({ type: "project.remove", projectId: id, by });
      broadcastState();
      return { ok: true, applied: true };
    }

    if (type === "status") {
      const id = String(msg.id ?? "");
      const summary = typeof msg.summary === "string" ? msg.summary : "";
      const phase = typeof msg.phase === "string" ? msg.phase : undefined;
      const r = applyStatus(state, id, { summary, phase }, Date.now());
      if (!r.applied) return { ok: true, applied: false, error: r.error, outcome: r.outcome };
      state = r.state;
      emitEvent({ type: "status", projectId: id, summary, phase, by });
      broadcastState();
      return { ok: true, applied: true };
    }

    if (type === "attention") {
      const id = String(msg.id ?? "");
      const raised = msg.raised !== false; // default to raising
      const question = typeof msg.question === "string" ? msg.question : undefined;
      const r = applyAttention(state, id, raised, question, Date.now());
      if (!r.applied) return { ok: true, applied: false, error: r.error, outcome: r.outcome };
      state = r.state;
      emitEvent({ type: "attention", projectId: id, raised, question, by });
      broadcastState();
      return { ok: true, applied: true };
    }

    if (type === "poke") {
      const id = String(msg.id ?? "");
      if (!state.projects.some((p) => p.id === id)) {
        return { ok: true, applied: false, error: `unknown project '${id}'` };
      }
      // A poke mutates no state — it's a signal to the project's listening agent
      // to post a fresh status. Emit the event only (no broadcast, no snapshot).
      emitEvent({ type: "poke", projectId: id, by });
      return { ok: true, applied: true };
    }

    if (type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return { ok: true, applied: true };
    }

    return { ok: true, applied: false, error: `unknown command '${String(type)}'` };
  }

  const mode = resolveMode(DIST_DIR);

  // dev: the dynamic string-literal import keeps the surface graph off the
  // module load path (Contract 1) — Bun bundles the .tsx graph + Tailwind at
  // serve time on the first GET "/" (lazy; a cold build can take seconds), and
  // reads bunfig.toml from cwd, which cli.ts pins to src/astrolabe/ (Contract
  // 5). hmr on for circe's iteration loop.
  // release: dist/ is static and pre-built (Contract 2) — "/" is answered by
  // serveDist() in the fetch fall-through below, so this branch never touches
  // surface/ or bunfig.toml and never needs either to exist.
  // Bun's Routes type ties the "/" value's type to the literal object shape, so
  // a mode-ternary union confuses its overload resolution — the runtime
  // behavior (HTMLBundle in dev, absent in release) is correct either way.
  // ⛔ THIS SPECIFIER IS RESOLVED FROM `dist/`, NOT FROM THIS FILE. `src/build.ts`
  // passes `external: ["*/surface/index.html"]`, so the bundler does not follow
  // this import and leaves the string in `dist/server.js` BYTE-FOR-BYTE. The
  // five `..` therefore count up from
  // `plugins/spellbook/skills/astrolabe/dist/` — dist → astrolabe → skills →
  // spellbook → plugins → repo root — and NOT from `src/astrolabe/backend/`,
  // where the same string would climb out of the repo. Reading it as a normal
  // relative import of this file is the mistake to make here, and release mode
  // never executes the line, so nothing but booting a DEV daemon can catch it.
  // `grimoire/import-boundary-wards.test.ts` pins it at the emitted address for
  // exactly that reason.
  const devIndex =
    mode === "dev"
      ? (await import("../../../../../src/astrolabe/surface/index.html")).default
      : undefined;
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      idleTimeout: IDLE_TIMEOUT_SEC, // keep held SSE/WS connections alive (see SSE_HEARTBEAT_MS)
      routes,
      development: { hmr: mode === "dev" },
      fetch: (req, srv) => {
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === "/ws") {
          const upgraded = srv.upgrade(req);
          if (upgraded) return undefined;
          return new Response("upgrade required", { status: 426 });
        }
        if (req.method === "GET" && path === "/state") {
          touch();
          return new Response(JSON.stringify({ state: projectState(), cursor: log.cursor() }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (req.method === "GET" && path === "/events") {
          return eventsResponse(req, url);
        }
        if (req.method === "POST" && path === "/cmd") {
          return req
            .json()
            .then((body) => {
              touch();
              const result = handleAgentMsg(body as Record<string, unknown>);
              return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json" },
              });
            })
            .catch(
              () =>
                new Response('{"error":"bad json"}', {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                }),
            );
        }
        // release: "/" and the hashed chunk-*.js/css are static dist reads. Dev
        // never reaches here for "/" — the routes table above answers it first.
        if (mode === "release") {
          const asset = serveDist(path);
          if (asset) return asset;
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          touch();
          emitEvent({ type: "connected", by: "user" });
          ws.send(JSON.stringify({ type: "state", ...projectState() }));
        },
        message(_ws, raw) {
          touch();
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(
              `astrolabe: bad json from browser: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            return;
          }
          // The human's board affordances over WS: nudge (poke) a project, or
          // dismiss the observatory. (Add-project from the surface is a separate
          // POST /cmd — see AddProjectModal — not a WS message.)
          if (msg.type === "poke" || msg.type === "close") {
            handleAgentMsg({ ...msg, as: "user" });
          }
        },
        close(ws) {
          sockets.delete(ws);
          emitEvent({ type: "disconnected", by: "user" });
        },
      },
    });
  } catch (e) {
    process.stderr.write(
      `${JSON.stringify({
        event: "bind_error",
        host,
        port,
        error: e instanceof Error ? e.message : String(e),
      })}\n`,
    );
    return 2;
  }

  const boundPort = server.port;
  const url = `http://${host}:${boundPort}`;
  // `mode` on the ready frame is the ONLY thing that discriminates a release
  // daemon from a dev one: with root deps present a dev daemon renders an
  // identical-looking board, so "it looks right" cannot verify Contract 1.
  emitEvent({
    type: "ready",
    url,
    port: boundPort,
    session_id: "astrolabe",
    mode,
    by: "system",
  });

  // Discovery: a singleton daemon writes its port + pid so cli.ts can find (or
  // skip auto-spawning) it. Cleaned up on close only if they still name us.
  //
  // ⚠ ATOMIC SINCE PHASE 1b — census defect L3. These two were bare
  // `writeFileSync`s, so a CLI reading `daemon.port` while the daemon wrote it
  // could observe a partial file and report "no running daemon" for what was a
  // torn read. The session spells had fixed this in their own convention a day
  // earlier; the singleton convention had not. One implementation, in
  // `kit/wire/discovery.ts`, is why it is fixed in both.
  try {
    mkdirSync(ASTROLABE_HOME, { recursive: true });
    writeFileAtomic(PORT_FILE, String(boundPort));
    writeFileAtomic(PID_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(
      `astrolabe: could not write discovery files: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  // The pid file is the IDENTITY and the port file rides its verdict: if the pid
  // no longer names us a successor has already published, and removing either
  // file would make that successor invisible.
  const cleanupDiscovery = () => {
    if (!unlinkIfMatches(PID_FILE, String(process.pid))) return;
    try {
      unlinkSync(PORT_FILE);
    } catch {
      /* gone already — fine */
    }
  };

  // Print the bound URL on stdout so a foreground launch is discoverable.
  // `mode` rides this line as well as the ready EVENT above: mind-mapper's
  // release-serve gate reads the handshake line, and a foreground launch that
  // never opens a tail still needs to be able to say which mode it got.
  process.stdout.write(
    `${JSON.stringify({ url, port: boundPort, session_id: "astrolabe", mode })}\n`,
  );

  if (!v["no-open"]) openBrowser(url);

  // The idle sweep + the debounced registry snapshot. `subscriberCount` is a
  // REQUIRED argument of the shared housekeeper, which is what makes L1
  // unexpressible: a daemon cannot idle-close out from under a held tail.
  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: timeout * 1000, // 0 = standing; the observatory's default
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
    snapshot: {
      dirty: () => snapDirty,
      clear: () => {
        snapDirty = false;
      },
      write: saveRegistry,
    },
  });

  const { code, reason } = await done;
  stopHousekeeping();
  await saveRegistry(); // final registry write
  emitEvent({ type: "closed", reason, by: "system" });
  broadcastState();
  // The presence debounce timers are astrolabe's own and outlive nothing — they
  // are cleared here, before the shared drain closes the connections whose
  // teardown would otherwise re-arm them.
  for (const t of idleTimers.values()) clearTimeout(t);
  await drainAndStop({ server, clients: sseClients, sockets });
  cleanupDiscovery();
  return code;
}

/**
 * The daemon's entry, for the LAUNCHER at
 * `plugins/spellbook/skills/astrolabe/scripts/server.ts`.
 *
 * ⛔ `import.meta.main` IS FALSE IN THE BUNDLE. `dist/server.js` is IMPORTED by
 * the launcher, never executed as the process entry, so the old
 * `if (import.meta.main)` block would simply never run — the daemon would boot,
 * serve nothing and exit 0. That is the failure this export exists to prevent.
 *
 * ⛔ AND IT TAKES NO ARGUMENTS, for the same reason `cli.ts`'s `run()` does not:
 * the command line belongs to the file that PARSES it. A launcher that touched
 * `process.argv` would match `grimoire/lib/entry-points.ts`'s arg-parsing
 * predicate and the wards would judge this daemon's flags against a file that
 * recognises none.
 *
 * The terminal `process.exit(exitCode)` stays where it always was — at the site
 * that is the process entry, which is now the launcher. It is family E-terminal
 * in `grimoire/exit-site-inventory.test.ts` (teardown has already run inside
 * `main`), it is a DAEMON's exit and not a CLI's, and D8's `die`-throws ruling
 * deliberately does not reach it.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}

export { main, validateProject };
