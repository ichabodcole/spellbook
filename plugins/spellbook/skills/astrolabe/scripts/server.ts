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
//   {id, type:"ready",        url, port, session_id, by:"system"}
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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
// The bundled React surface. Bun bundles the .tsx graph + Tailwind (via
// bunfig.toml) at RUNTIME on first request — no build step, nothing committed.
// REQUIRES the daemon's cwd = skill root so Bun finds bunfig.toml (cli.ts pins
// it); launched elsewhere, Tailwind is silently skipped → unstyled board.
import index from "../surface/index.html";
import {
  applyAttention,
  applyProjectAdd,
  applyProjectRemove,
  applySetPresence,
  applyStatus,
  emptyState,
  type ObservatoryState,
  type Project,
} from "./state.ts";

export type { ObservatoryState, Project } from "./state.ts";

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
// flooding the event log. So the heartbeat MUST stay well under idleTimeout.
// Both are env-tunable (tests drive a short window); the heartbeat is clamped
// to ≤ half the idle timeout so the invariant holds for any configured value.
const IDLE_TIMEOUT_SEC = Math.max(
  1,
  Math.min(255, Number.parseInt(process.env.ASTROLABE_IDLE_TIMEOUT ?? "255", 10) || 255),
);
const SSE_HEARTBEAT_MS = Math.min(
  Number.parseInt(process.env.ASTROLABE_HEARTBEAT_MS ?? "10000", 10) || 10000,
  Math.max(500, Math.floor((IDLE_TIMEOUT_SEC * 1000) / 2)),
);
// How long to defer a presence idle-flip; a reconnect within this window cancels
// it (see idleTimers). Tunable for tests.
const PRESENCE_DEBOUNCE_MS =
  Number.parseInt(process.env.ASTROLABE_PRESENCE_DEBOUNCE_MS ?? "2500", 10) || 2500;

type DoneResult = { code: number; reason: string };
type ApplyResult = { ok: boolean; applied: boolean; error?: string; id?: string };

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

// Should the standing daemon idle-close? Only once the LAST subscriber has left
// AND a positive timeout is configured (default 0 = never; a singleton
// observatory is meant to stand until explicitly closed).
function shouldIdleClose(subscriberCount: number, idleMs: number, timeoutMs: number): boolean {
  return timeoutMs > 0 && subscriberCount === 0 && idleMs >= timeoutMs;
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
  // is the resume cursor (?since=<id>); `cursor` in GET /state is the current
  // eventSeq.
  const events: Array<Record<string, unknown>> = [];
  let eventSeq = 0;
  const enc = new TextEncoder();
  const sseClients = new Set<ReadableStreamDefaultController>();
  const sseTimers = new Set<ReturnType<typeof setInterval>>();

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
  // project identifier as `projectId`, never `id`.
  function emitEvent(msg: Record<string, unknown>) {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    if (typeof msg.type === "string" && DIRTYING.has(msg.type)) snapDirty = true;
    const frame = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {
        /* client gone */
      }
    }
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

  // GET /events?since=<id>&project=<id> — replay buffered frames with id > since,
  // then stay open for live frames + a 15s heartbeat comment. A `project` param
  // binds presence to this connection's lifetime.
  function sseResponse(url: URL): Response {
    touch();
    const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
    const projectId = url.searchParams.get("project") ?? undefined;
    const bind =
      projectId && state.projects.some((p) => p.id === projectId) ? projectId : undefined;
    let ref: ReadableStreamDefaultController | null = null;
    let hb: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if ((ev.id as number) > since) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
        }
        sseClients.add(controller);
        if (bind) presenceConnect(bind);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb\n\n`));
          } catch {
            /* gone */
          }
        }, SSE_HEARTBEAT_MS);
        sseTimers.add(hb);
      },
      cancel() {
        if (hb) {
          clearInterval(hb);
          sseTimers.delete(hb);
        }
        if (ref) sseClients.delete(ref);
        if (bind) presenceDisconnect(bind);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
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
      if (!r.applied) return { ok: true, applied: false, error: r.error };
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
      if (!r.applied) return { ok: true, applied: false, error: r.error };
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
      if (!r.applied) return { ok: true, applied: false, error: r.error };
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
      if (!r.applied) return { ok: true, applied: false, error: r.error };
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

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      idleTimeout: IDLE_TIMEOUT_SEC, // keep held SSE/WS connections alive (see SSE_HEARTBEAT_MS)
      // "/" serves the bundled React surface — Bun bundles the .tsx graph +
      // Tailwind on first request (lazy; cold build can take seconds). Every
      // other path falls through to fetch() below.
      routes: { "/": index },
      development: { hmr: true },
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
          return new Response(JSON.stringify({ state: projectState(), cursor: eventSeq }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (req.method === "GET" && path === "/events") {
          return sseResponse(url);
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
  emitEvent({ type: "ready", url, port: boundPort, session_id: "astrolabe", by: "system" });

  // Discovery: a singleton daemon writes its port + pid so cli.ts can find (or
  // skip auto-spawning) it. Cleaned up on close only if they still name us.
  try {
    mkdirSync(ASTROLABE_HOME, { recursive: true });
    writeFileSync(PORT_FILE, String(boundPort));
    writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(
      `astrolabe: could not write discovery files: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  const cleanupDiscovery = () => {
    try {
      if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
        unlinkSync(PID_FILE);
        unlinkSync(PORT_FILE);
      }
    } catch {
      /* files gone or unreadable — fine */
    }
  };

  // Print the bound URL on stdout so a foreground launch is discoverable.
  process.stdout.write(`${JSON.stringify({ url, port: boundPort, session_id: "astrolabe" })}\n`);

  if (!v["no-open"]) openBrowser(url);

  const idleTimer = setInterval(() => {
    const subscriberCount = sockets.size + sseClients.size;
    if (subscriberCount > 0) touch();
    if (shouldIdleClose(subscriberCount, performance.now() - lastActivity, timeout * 1000)) {
      resolveDone({ code: 124, reason: "timeout" });
    }
  }, 250);

  const snapTimer = setInterval(async () => {
    if (snapDirty) {
      snapDirty = false;
      await saveRegistry();
    }
  }, 1000);

  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  await saveRegistry(); // final registry write
  emitEvent({ type: "closed", reason, by: "system" });
  broadcastState();
  // Grace period so queued frames flush before the aggressive stop (Bun gotcha).
  await new Promise((r) => setTimeout(r, 150));
  for (const t of sseTimers) clearInterval(t);
  for (const t of idleTimers.values()) clearTimeout(t);
  for (const c of sseClients) {
    try {
      c.close();
    } catch {}
  }
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  cleanupDiscovery();
  return code;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}

export { main, shouldIdleClose, validateProject };
