#!/usr/bin/env bun

// mind-mapper — P1 daemon. Real per-project state (sqlite + docs/) replaces
// the spike's stub-JSON /state; dev-mode serve (seams Contract 1) and the
// readDoc envelope shape are kept verbatim from the spike. Backend ships as
// source (Contract 3). No daemon-side intelligence anywhere below (Claim A) —
// this file stores and serves, nothing more.
//
// Surface source lives at src/mind-mapper/surface/ (seams Contract 4); the
// import below is DYNAMIC + dev-only so a future release-mode daemon can boot
// without the surface build graph present (Contract 1's "why it bites").

import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { clearActions, setActions } from "./actions.ts";
import { anchorNode } from "./anchor.ts";
import { openStore } from "./db.ts";
import { CitedError, deleteDoc, setDocKind } from "./docs.ts";
import { createEventBus, type EventBus } from "./events.ts";
import { ingestFile, ingestText } from "./ingest.ts";
import { clearLens, lookHere, setLens } from "./lens.ts";
import { markDoc } from "./marks.ts";
import { neighbors } from "./neighbors.ts";
import {
  createProject,
  listProjects,
  NeedsProjectError,
  type ProjectMeta,
  projectDir,
  resolveProject,
  SLUG_RE,
  UnknownProjectError,
} from "./project.ts";
import {
  type BatchInput,
  batchPropose,
  edgeDraftWarning,
  proposeEdge,
  proposeNode,
} from "./propose.ts";
import { ratify, ZonedError } from "./ratify.ts";
import { search } from "./search.ts";
import { sendMessage } from "./send.ts";
import { readState } from "./state.ts";
import {
  createZone,
  deleteZone,
  listZones,
  moveProposalToZone,
  promote,
  UnknownZoneError,
  ZoneNotEmptyError,
} from "./zones.ts";

const SCRIPT_DIR = import.meta.dir;
// Absolute skill-root path (not cwd) — seams Contract 1's release-mode
// requirement, so dist/ resolves the same regardless of the daemon's
// working directory.
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// release iff dist/index.html exists at the skill root, else dev; env
// override wins either way (seams Contract 1). Release: zero reads of
// surface/ or bunfig.toml — static files only. Dev: the existing dynamic
// import + Bun's serve-time bundling.
function resolveMode(): "dev" | "release" {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release") return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}

// Round 4 (B1) — the build stamp. Release mode reads dist/build.json ONCE at
// boot (boot-time staleness is honest — routes bake at boot anyway); a
// missing/corrupt stamp is tolerated (pre-stamp dists keep serving, no
// buildInfo). Staleness: iff the surface SOURCE tree exists next to this
// checkout (existsSync-guarded — a source-free marketplace install never
// walks, never warns) and its newest file mtime postdates builtAt, the dist
// is stale — stderr warning + stale:true on the wire. MIND_MAPPER_SRC_DIR is
// a test-only override for the src-tree location.
interface BuildInfo {
  commit: string;
  builtAt: string;
  stale: boolean;
}

const SRC_SURFACE_DIR =
  process.env.MIND_MAPPER_SRC_DIR ??
  join(SKILL_ROOT, "..", "..", "..", "..", "src", "mind-mapper", "surface");

function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtimeMs(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function readBuildInfo(): BuildInfo | null {
  const stampPath = join(DIST_DIR, "build.json");
  if (!existsSync(stampPath)) return null;
  let stamp: { commit?: unknown; builtAt?: unknown };
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8")) as typeof stamp;
  } catch {
    return null;
  }
  if (typeof stamp.commit !== "string" || typeof stamp.builtAt !== "string") return null;
  let stale = false;
  if (existsSync(SRC_SURFACE_DIR)) {
    try {
      stale = newestMtimeMs(SRC_SURFACE_DIR) > Date.parse(stamp.builtAt);
    } catch {
      stale = false; // an unreadable src tree proves nothing
    }
  }
  return { commit: stamp.commit, builtAt: stamp.builtAt, stale };
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
// (Contract 2's flat, relative-href layout). Path traversal guarded (a
// static asset request is always a bare filename, never nested).
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

// Discovery root — cli.ts derives the same path to find (or skip spawning) us.
const HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
const PORT_FILE = join(HOME, "daemon.port");
const PID_FILE = join(HOME, "daemon.pid");

// One open Database + event bus per project, opened lazily and kept open for
// the daemon's lifetime (sqlite connections are cheap to hold, expensive to
// reopen per request). `agents` is Claim C's standing-presence counter — it
// lives HERE (per-project map entry, adjusted at the SSE subscription site)
// because the bus's listener set is transport-blind: only the subscription
// site knows an agent tail from a browser WS.
//
// Round 4 (ACT1): activityState/activitySource track the LIVE activity so
// agent writes can resolve it — "auto" is a daemon-flipped state (the /send
// auto-received, the TTL'd stalled), "explicit" is a POST /activity. All
// in-memory: a restart honestly clears to no-signal.
interface ProjectEntry {
  db: Database;
  bus: EventBus;
  meta: ProjectMeta;
  agents: number;
  activityTimer: ReturnType<typeof setTimeout> | null;
  activityState: string | null;
  activitySource: "auto" | "explicit" | null;
}

const projects = new Map<string, ProjectEntry>();

// A connection WITHOUT ?project= (the browser WS on first mount, an unscoped
// agent tail) resolves through the same default-project path as every other
// unscoped request — attribution to the daemon-resolved default project (IF
// one exists, Round 3 narrowing) is what keeps project-scoped
// presence.changed fan-out honest (plan-v1x, Claim C scoping edge).
//
// Round 3 (Claim P1): no auto-mint, no demo seed — resolveProject throws
// NeedsProjectError on a projectless unscoped request, and the fetch
// handler's projectFailure funnel turns that into the ratified 409. SSE and
// WS both pass through here BEFORE any stream/upgrade exists, so a refused
// connection never touches presence.
function loadProject(id?: string): ProjectEntry {
  const meta = resolveProject(HOME, id);
  const existing = projects.get(meta.id);
  if (existing) return existing;

  const dir = projectDir(HOME, meta.id);
  const db = openStore(join(dir, "store.sqlite"));
  const entry: ProjectEntry = {
    db,
    bus: createEventBus(),
    meta,
    agents: 0,
    activityTimer: null,
    activityState: null,
    activitySource: null,
  };
  projects.set(meta.id, entry);
  return entry;
}

// The one honest shape for "you can't have a board yet" (ratified over a
// 200-marker — a fake ProjectState lies to consumers; one fetch branch is
// honest): 409 {error:"needs-project", projects:[...]} for a projectless
// store, 404 for a named-but-unknown scope. Anything else rethrows.
function projectFailure(e: unknown): Response {
  if (e instanceof NeedsProjectError) {
    return new Response(JSON.stringify({ error: "needs-project", projects: listProjects(HOME) }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (e instanceof UnknownProjectError) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw e;
}

// Presence = who is receiving (the grapevine `who` model): agents-only,
// counted at SSE subscribe/unsubscribe. Accuracy is bounded by the keepalive
// (Claim F): a dead socket only tears down when the next keepalive write
// throws, so the decrement can lag by up to one tick — never dangle.
function adjustAgents(entry: ProjectEntry, delta: number): void {
  entry.agents = Math.max(0, entry.agents + delta);
  entry.bus.emit("presence.changed", { agents: entry.agents });
}

function activityTtlMs(): number {
  const v = Number.parseInt(process.env.MIND_MAPPER_ACTIVITY_TTL_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

// Round 5 (SW1) — the stall window is its own knob now. `received → stalled`
// is a DIFFERENT judgment than `thinking → idle`: it fires while the agent is
// deliberating (a longer, human-paced beat), not while a crashed agent leaves
// "thinking…" stuck. 60s false-fired twice during normal drive-4 deliberation,
// so the received-grace widens to 150s by default while thinking keeps the
// tighter 60s (a stuck spinner should clear fast). The liveness-gate was
// rejected: a connected tail proves transport, not agent liveness (a hung
// agent keeps its tail open).
function stallTtlMs(): number {
  const v = Number.parseInt(process.env.MIND_MAPPER_STALL_TTL_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 150_000;
}

// Claim C's active-attention half, Round 4 (ACT1) supersession of the TTL
// clause: fire-and-forget, no table, no persistence. TTL escalation is
// state-aware now — `received` older than the TTL escalates to a
// daemon-synthesized `stalled` ("agent may be stuck"; persists, NO further
// timer), while `thinking` still decays to a synthetic `idle` (a crashed
// agent can't leave "thinking…" stuck on the surface). `stalled` is
// daemon-only vocabulary — POST /activity rejects it (the epoch.changed
// asymmetry precedent). Every emit rides the normal bus path (seq-consuming
// — the ephemeral-cursor clause holds).
function postActivity(
  entry: ProjectEntry,
  state: "received" | "thinking" | "idle",
  source: "auto" | "explicit",
): void {
  if (entry.activityTimer !== null) {
    clearTimeout(entry.activityTimer);
    entry.activityTimer = null;
  }
  entry.activityState = state === "idle" ? null : state;
  entry.activitySource = state === "idle" ? null : source;
  entry.bus.emit("agent.activity", { state });
  if (state === "received") {
    entry.activityTimer = setTimeout(() => {
      entry.activityTimer = null;
      entry.activityState = "stalled";
      entry.activitySource = "auto"; // resolvable by any agent write, whoever set the received
      entry.bus.emit("agent.activity", { state: "stalled" });
    }, stallTtlMs());
  } else if (state === "thinking") {
    entry.activityTimer = setTimeout(() => {
      entry.activityTimer = null;
      entry.activityState = null;
      entry.activitySource = null;
      entry.bus.emit("agent.activity", { state: "idle" });
    }, activityTtlMs());
  }
}

// ACT1's resolution half: an agent-authored write is evidence the agent is
// alive and acting, so it resolves any AUTO state (received/stalled) to
// idle. A role:"agent" send ALSO resolves explicit `thinking` — a reply is
// the turn's terminal act (closed open-question; re-set thinking explicitly
// for send-then-more-work). Other explicit states stand until an explicit
// idle or the TTL.
function resolveActivity(entry: ProjectEntry, opts: { terminalAct?: boolean } = {}): void {
  const resolvesExplicitThinking =
    opts.terminalAct === true &&
    entry.activitySource === "explicit" &&
    entry.activityState === "thinking";
  if (entry.activitySource === "auto" || resolvesExplicitThinking) {
    postActivity(entry, "idle", "auto");
  }
}

// Seam v2 (vine msgs 13–17): GET /doc/:id → { id, title, kind, content } —
// title/kind/path from the docs table, content from the file at that path,
// both read per-request. JSON 404 for an unknown id OR a missing file.
// Round 4 (K1): kind loosens to string | null — the '' sentinel at rest
// normalizes to null here, same as /state.docs[].
function readDoc(
  db: Database,
  dir: string,
  id: string,
): { id: string; title: string; kind: string | null; content: string } | null {
  // Slug guard — ids are agreed slugs; anything else (path traversal,
  // separators) is not a doc.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const row = db.query("SELECT title, kind, path FROM docs WHERE id = ?").get(id) as {
    title: string;
    kind: string;
    path: string;
  } | null;
  if (!row) return null;
  const file = join(dir, "..", row.path);
  if (!existsSync(file)) return null;
  try {
    return {
      id,
      title: row.title,
      kind: row.kind === "" ? null : row.kind,
      content: readFileSync(file, "utf8"),
    };
  } catch {
    return null;
  }
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

// Keepalive tick (Claim F): a comment frame every ~15s keeps a healthy SSE
// connection observably alive — the cli's idle watchdog is calibrated to ~3
// missed ticks. Env override is for tests only.
//
// Dead-socket detection (measured, Bun 1.3.14 — corrects the ratified
// enqueue-throw mechanism): enqueue on an orphaned stream NEVER throws (it
// buffers silently), but a vanished client — raw socket death or an
// aborted client fetch — fires BOTH req.signal "abort" and the stream's
// cancel(). Teardown therefore listens on the request signal and keeps the
// enqueue try/catch only as belt-and-braces. (Known hole, accepted: Bun's
// own fetch reader.cancel() closes nothing client-side and is invisible to
// the server — real clients close the socket.)
function keepaliveMs(): number {
  const v = Number.parseInt(process.env.MIND_MAPPER_KEEPALIVE_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
}

function sseResponse(
  bus: EventBus,
  since: number,
  hooks: { onOpen?: () => void; onClose?: () => void } = {},
  signal?: AbortSignal,
): Response {
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // Every exit path (clean cancel, enqueue-throw on a dead controller)
  // funnels through here exactly once — Claim C's presence decrement rides
  // hooks.onClose, so this funnel is what bounds presence accuracy.
  const teardown = () => {
    if (closed) return;
    closed = true;
    if (keepalive !== null) clearInterval(keepalive);
    unsubscribe?.();
    hooks.onClose?.();
  };
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      // An opening comment flushes the response headers immediately — some
      // HTTP clients (Bun's own fetch() included) otherwise buffer until the
      // first byte of body arrives, so an SSE stream that's genuinely quiet
      // between events would leave the caller's fetch() unresolved.
      safeEnqueue(": connected\n\n");
      unsubscribe = bus.subscribe(since, (event) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      });
      keepalive = setInterval(() => safeEnqueue(": keepalive\n\n"), keepaliveMs());
      signal?.addEventListener("abort", teardown, { once: true });
      hooks.onOpen?.();
    },
    cancel() {
      teardown();
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

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        "no-open": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const host = parsed.values.host as string;
  const port = Number.parseInt(parsed.values.port as string, 10);

  const mode = resolveMode();

  // B1: read the stamp once at boot (release only). Boot-time staleness is
  // honest — routes bake at boot, so what was true at boot stays the served
  // truth until a restart anyway.
  const buildInfo = mode === "release" ? readBuildInfo() : null;
  if (buildInfo) {
    process.stderr.write(
      `mind-mapper: serving dist built at ${buildInfo.builtAt} (${buildInfo.commit})\n`,
    );
    if (buildInfo.stale) {
      process.stderr.write(
        "mind-mapper: STALE DIST — src/mind-mapper/surface/ has files newer than the dist build; run `bun run src/mind-mapper/build.ts` and restart\n",
      );
    }
  }

  // dev: the dynamic string-literal import keeps the surface graph off the
  // module load path (Contract 1's "why it bites" — a top-level static
  // import would force Bun to resolve it at daemon LOAD, crashing a
  // surface-source-free destination before it could ever serve dist/); Bun
  // bundles .tsx + Tailwind at serve time (bunfig.toml via cwd — cli.ts pins
  // cwd to src/mind-mapper/). hmr on for circe's iteration loop.
  // release: dist/ is static, pre-built (Contract 2) — no surface-graph
  // read at all, so this branch never touches surface/ or bunfig.toml.
  // Bun's Routes type ties the "/" value's type to the literal object shape,
  // so a mode-ternary union confuses its overload resolution — the runtime
  // behavior (HTMLBundle in dev, absent in release) is correct either way.
  const devIndex =
    mode === "dev"
      ? (await import("../../../../../src/mind-mapper/surface/index.html")).default
      : undefined;
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      development: { hmr: mode === "dev" },
      // SSE/WS connections on /events sit idle between emits by design — the
      // default 10s idle timeout would otherwise reset a quiet stream.
      // Bun clamps this to a uint8 (max 255s); 0 disables it for the whole
      // request but also (empirically) stalls the initial response — use the
      // max instead.
      idleTimeout: 255,
      fetch: (req, srv) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const projectId = url.searchParams.get("project") ?? undefined;

        // Every scoped route calls loadProject SYNCHRONOUSLY before any
        // body/stream work, so this one funnel turns a project-resolution
        // failure into the ratified 409/404 everywhere at once — the SSE
        // response is refused pre-stream and the WS upgrade is refused
        // outright (no presence increment on either).
        try {
          if (path === "/events") {
            const entry = loadProject(projectId);
            if (req.headers.get("upgrade") === "websocket") {
              const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
              const ok = srv.upgrade(req, {
                data: { since: Number.isFinite(since) ? since : 0, projectId },
              });
              if (ok) return undefined;
              return new Response("upgrade failed", { status: 500 });
            }
            const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
            // SSE = an agent tail (the browser rides the WS above; presence is
            // agents-only, ruled). The subscription site is the ONE place that
            // knows this, so the presence counter adjusts here.
            return sseResponse(
              entry.bus,
              Number.isFinite(since) ? since : 0,
              {
                onOpen: () => adjustAgents(entry, 1),
                onClose: () => adjustAgents(entry, -1),
              },
              req.signal,
            );
          }

          if (req.method === "GET" && path === "/state") {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const state = readState(db, meta, bus.cursor(), bus.epoch, projectDir(HOME, meta.id));
            // ?zone=<id> narrows proposals[] to that zone — a convenience for
            // focused agent reads (the default response is INCLUSIVE, tagged
            // with zoneId; the main view is zoneId == null at render, ruled).
            const zoneId = url.searchParams.get("zone");
            if (zoneId !== null) {
              if (!state.zones.some((z) => z.id === zoneId)) {
                return new Response(JSON.stringify({ error: `unknown zone: ${zoneId}` }), {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                });
              }
              state.proposals = state.proposals.filter((p) => p.zoneId === zoneId);
            }
            // Round 5 (SG1): ?anchor=<id> is a server-side CLI/agent narrow to
            // one node's submap — the anchor node itself plus its direct
            // children, and the edges among that set. The SURFACE does NOT use
            // this (it consumes the inclusive snapshot + submapChildCount and
            // derives the submap client-side, so the breadcrumb parent-walk
            // stays possible); this is a convenience for context-budgeted agent
            // reads, mirroring ?zone. Unknown anchor id → 404.
            const anchorId = url.searchParams.get("anchor");
            if (anchorId !== null) {
              if (!state.nodes.some((n) => n.id === anchorId)) {
                return new Response(JSON.stringify({ error: `unknown anchor node: ${anchorId}` }), {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                });
              }
              state.nodes = state.nodes.filter(
                (n) => n.anchorNodeId === anchorId || n.id === anchorId,
              );
              const visible = new Set(state.nodes.map((n) => n.id));
              state.edges = state.edges.filter(
                (e) => visible.has(e.source) && visible.has(e.target),
              );
            }
            // buildInfo spreads AT THE HANDLER, not through readState — a
            // daemon-level fact like presence (the exported ProjectState
            // type under-reports the wire here too; Contract 9 as-built
            // note). Release mode only; absent otherwise.
            return Response.json({
              ...state,
              presence: { agents: entry.agents },
              ...(buildInfo ? { buildInfo } : {}),
            });
          }

          if (path === "/zones" && req.method === "GET") {
            const { db } = loadProject(projectId);
            return Response.json({ zones: listZones(db) });
          }
          if (path === "/zones" && req.method === "POST") {
            const { db, bus } = loadProject(projectId);
            return req
              .json()
              .then((body) => {
                const { name } = body as { name?: unknown };
                if (typeof name !== "string") throw new Error("name required");
                return Response.json(createZone(db, bus, name));
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }
          if (req.method === "DELETE" && path.startsWith("/zones/")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/zones/".length);
            const yes = url.searchParams.has("yes");
            try {
              const result = deleteZone(db, bus, id, yes);
              if (!result) {
                return new Response('{"error":"unknown zone"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                });
              }
              return Response.json({ ok: true, id });
            } catch (e) {
              if (e instanceof ZoneNotEmptyError) {
                return new Response(
                  JSON.stringify({ error: "zone-not-empty", proposals: e.proposals }),
                  { status: 409, headers: { "Content-Type": "application/json" } },
                );
              }
              return new Response(
                JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }

          // Round 4 (A1): PUT replaces a target's action slots wholesale
          // (empty array clears), DELETE clears — target is a node or a
          // PENDING proposal, anything else 404s; shape/byte-cap fail 400.
          if ((req.method === "PUT" || req.method === "DELETE") && path.startsWith("/actions/")) {
            const { db, bus } = loadProject(projectId);
            const targetId = path.slice("/actions/".length);
            const handle =
              req.method === "DELETE"
                ? Promise.resolve(clearActions(db, bus, targetId))
                : req.json().then((body) => setActions(db, bus, targetId, body));
            return handle
              .then((result) => {
                if (!result) {
                  return new Response('{"error":"unknown target (node or pending proposal)"}', {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                return Response.json(result);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "POST" && path === "/activity") {
            const entry = loadProject(projectId);
            return req
              .json()
              .then((body) => {
                const { state } = body as { state?: unknown };
                // ACT1: `stalled` is daemon-synthesized vocabulary ONLY —
                // rejecting it here is the epoch.changed asymmetry again (a
                // client may hear it, never say it).
                if (state === "stalled") {
                  throw new Error(
                    "stalled is daemon-synthesized only — post received|thinking|idle",
                  );
                }
                if (state !== "received" && state !== "thinking" && state !== "idle") {
                  throw new Error("state must be received|thinking|idle");
                }
                postActivity(entry, state, "explicit");
                return Response.json({ ok: true, state });
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }
          if (req.method === "GET" && path === "/projects") {
            return Response.json({ projects: listProjects(HOME) });
          }
          if (req.method === "POST" && path === "/projects") {
            return req
              .json()
              .then((body) => {
                const { id, title } = body as { id?: unknown; title?: unknown };
                if (typeof id !== "string" || typeof title !== "string") {
                  return new Response('{"error":"id and title required"}', {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                const meta = createProject(HOME, id, title);
                return Response.json(meta);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    {
                      status: 400,
                      headers: { "Content-Type": "application/json" },
                    },
                  ),
              );
          }
          if (req.method === "POST" && path === "/ingest") {
            const { db, bus, meta } = loadProject(projectId);
            const docsDir = join(projectDir(HOME, meta.id), "docs");
            const contentType = req.headers.get("content-type") ?? "";
            const handle = contentType.includes("multipart/form-data")
              ? req.formData().then(async (form) => {
                  const file = form.get("file");
                  if (!(file instanceof File)) throw new Error("multipart body missing 'file'");
                  const title = (form.get("title") as string | null) ?? file.name;
                  return ingestFile(db, bus, docsDir, title, await file.text());
                })
              : req.json().then((body) => {
                  const { title, text } = body as { title?: unknown; text?: unknown };
                  if (typeof title !== "string" || typeof text !== "string") {
                    throw new Error("title and text required");
                  }
                  return ingestText(db, bus, docsDir, title, text);
                });
            return handle
              .then((doc) => Response.json(doc))
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          // Round 5 (CLI1): batch propose — mint nodes, resolve edge endpoints
          // against the just-minted ids (local refs), insert in ONE
          // transaction, emit per-proposal AFTER commit. Kills the
          // N-subprocess casting script (finding #10). Checked before the
          // exact-match /proposals route below (disjoint path anyway).
          if (req.method === "POST" && path === "/proposals/batch") {
            const entry = loadProject(projectId);
            const { db, bus } = entry;
            return req
              .json()
              .then((body) => {
                const { nodes, edges } = body as { nodes?: unknown; edges?: unknown };
                const result = batchPropose(db, bus, {
                  nodes: Array.isArray(nodes) ? (nodes as BatchInput["nodes"]) : [],
                  edges: Array.isArray(edges) ? (edges as BatchInput["edges"]) : [],
                });
                // A batch is the casting agent's bulk write — an agent-authored
                // proposal in it is evidence of activity (resolves auto states,
                // same as a single agent propose). A wholly user-sketched batch
                // is not the agent's.
                if (result.proposals.some((p) => p.author === "agent")) resolveActivity(entry);
                return Response.json(result);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "POST" && path === "/proposals") {
            const entry = loadProject(projectId);
            const { db, bus } = entry;
            return req
              .json()
              .then((body) => {
                const { kind, draft, evidence, suggestedTier, author, zone } = body as {
                  kind?: unknown;
                  draft?: unknown;
                  evidence?: unknown;
                  suggestedTier?: unknown;
                  author?: unknown;
                  zone?: unknown;
                };
                if (kind !== "node" && kind !== "edge")
                  throw new Error("kind must be node or edge");
                if (author !== undefined && author !== "user" && author !== "agent") {
                  throw new Error("author must be user or agent");
                }
                const input = {
                  draft,
                  evidence:
                    (evidence as
                      | { docId?: string; messageId?: string; span?: string }
                      | undefined) ?? {},
                  suggestedTier: typeof suggestedTier === "string" ? suggestedTier : undefined,
                  author: author as "user" | "agent" | undefined,
                  zone: typeof zone === "string" ? zone : undefined,
                };
                const proposal =
                  kind === "node" ? proposeNode(db, bus, input) : proposeEdge(db, bus, input);
                // Gate rework: an edge draft with missing/wrong endpoint keys
                // is ACCEPTED (opaque intake, Contract 8) but the response
                // carries an additive `warning` naming the expected keys —
                // the cold agent hears about the fumble in the same turn,
                // not at ratify. Never stored, never in /state.
                const warning = kind === "edge" ? edgeDraftWarning(input.draft) : null;
                // ACT1: an AGENT-authored propose (author defaults to agent)
                // is evidence of activity — it resolves auto states; a
                // user-sketched proposal (surface canvas) is not the agent's.
                if (proposal.author === "agent") resolveActivity(entry);
                return Response.json(warning ? { ...proposal, warning } : proposal);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "POST" && path === "/send") {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            return req
              .json()
              .then((body) => {
                const { role, kind, text, ground } = body as {
                  role?: unknown;
                  kind?: unknown;
                  text?: unknown;
                  ground?: unknown;
                };
                if ((role !== "user" && role !== "agent") || typeof text !== "string") {
                  throw new Error("role (user|agent) and text required");
                }
                const message = sendMessage(db, bus, meta.id, {
                  role,
                  kind: typeof kind === "string" ? kind : "turn",
                  text,
                  ground: Array.isArray(ground) ? (ground as string[]) : undefined,
                });
                // ACT1 auto-flip: a human message with an agent tail on this
                // project reads as "received" without the agent saying so —
                // emitted AFTER message.posted (two seqs, ordered). No agent
                // connected → no flip (the presence dot already says nobody's
                // home). An agent send is the turn's terminal act: it
                // resolves auto states AND explicit thinking to idle.
                if (role === "user" && entry.agents >= 1) {
                  postActivity(entry, "received", "auto");
                } else if (role === "agent") {
                  resolveActivity(entry, { terminalAct: true });
                }
                return Response.json(message);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "GET" && path === "/search") {
            const { db } = loadProject(projectId);
            const q = url.searchParams.get("q") ?? "";
            return Response.json({ hits: search(db, q) });
          }

          // Round 5 (CLI1): read one full message by id (grapevine `read`
          // precedent) so the casting agent stops scraping the tail log for a
          // message body. Project-scoped — a message from another project is a
          // 404 here, same as every other scoped read. Ground grammar matches
          // readState (ground_json → string[] | null).
          if (req.method === "GET" && path.startsWith("/message/")) {
            const { db, meta } = loadProject(projectId);
            const id = path.slice("/message/".length);
            const row = db
              .query(
                "SELECT id, seq, role, kind, text, ground_json, ts FROM messages WHERE id = ? AND project_id = ?",
              )
              .get(id, meta.id) as {
              id: string;
              seq: number;
              role: "user" | "agent";
              kind: string;
              text: string;
              ground_json: string | null;
              ts: number;
            } | null;
            if (!row) {
              return new Response('{"error":"unknown message"}', {
                status: 404,
                headers: { "Content-Type": "application/json" },
              });
            }
            return Response.json({
              id: row.id,
              seq: row.seq,
              role: row.role,
              kind: row.kind,
              text: row.text,
              ground: row.ground_json ? (JSON.parse(row.ground_json) as string[]) : null,
              ts: row.ts,
            });
          }

          if (req.method === "GET" && path.startsWith("/neighbors/")) {
            const { db } = loadProject(projectId);
            const depth = Number.parseInt(url.searchParams.get("depth") ?? "1", 10);
            const id = path.slice("/neighbors/".length);
            return Response.json({
              neighbors: neighbors(db, id, Number.isFinite(depth) && depth > 0 ? depth : 1),
            });
          }

          // Round 5 (IC-c): move a PENDING proposal into a zone (or null =
          // to main) — the inverse of promote. Unknown proposal → 404,
          // unknown zone → 404 (typed), non-pending → 400.
          if (req.method === "POST" && path.startsWith("/proposals/") && path.endsWith("/zone")) {
            const { db, bus } = loadProject(projectId);
            const proposalId = path.slice("/proposals/".length, -"/zone".length);
            return req
              .json()
              .then((body) => {
                const { zoneId } = body as { zoneId?: unknown };
                if (zoneId !== null && typeof zoneId !== "string") {
                  throw new Error("zoneId must be a zone id string, or null to move to main");
                }
                const result = moveProposalToZone(db, bus, proposalId, zoneId);
                if (!result) {
                  return new Response('{"error":"unknown proposal"}', {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                return Response.json(result);
              })
              .catch((e) => {
                if (e instanceof UnknownZoneError) {
                  return new Response(JSON.stringify({ error: e.message }), {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                return new Response(
                  JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                  { status: 400, headers: { "Content-Type": "application/json" } },
                );
              });
          }

          if (
            req.method === "POST" &&
            path.startsWith("/proposals/") &&
            path.endsWith("/promote")
          ) {
            const { db, bus } = loadProject(projectId);
            const proposalId = path.slice("/proposals/".length, -"/promote".length);
            try {
              return Response.json(promote(db, bus, proposalId));
            } catch (e) {
              return new Response(
                JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }

          // Round 5 (SG1): anchor a real node under a parent (submap tree), or
          // clear it (parentId: null → top-level). The FIRST /nodes/* route.
          // Cycle guard lives in anchor.ts (ancestor-walk + defensive seen);
          // AnchorError → 400, everything else is the generic 400. Emits
          // node.anchored (thin).
          if (req.method === "POST" && path.startsWith("/nodes/") && path.endsWith("/anchor")) {
            const { db, bus } = loadProject(projectId);
            const nodeId = path.slice("/nodes/".length, -"/anchor".length);
            return req
              .json()
              .then((body) => {
                const { parentId } = body as { parentId?: unknown };
                if (parentId !== null && typeof parentId !== "string") {
                  throw new Error("parentId must be a node id string, or null to clear");
                }
                return Response.json(anchorNode(db, bus, nodeId, parentId));
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "POST" && path.startsWith("/proposals/") && path.endsWith("/ruling")) {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const proposalId = path.slice("/proposals/".length, -"/ruling".length);
            const docsDir = join(projectDir(HOME, meta.id), "docs");
            return req
              .json()
              .then((body) => {
                // docId/span are the additive ratify-time-attach fields (P3
                // gate ruling) — passed through verbatim; ratify() owns every
                // constraint (evidence-less only, node-only, slug, existence).
                const { ruling, docEdit, docId, span } = body as {
                  ruling?: unknown;
                  docEdit?: unknown;
                  docId?: unknown;
                  span?: unknown;
                };
                if (
                  ruling !== "canon" &&
                  ruling !== "thread" &&
                  ruling !== "story-local" &&
                  ruling !== "reject"
                ) {
                  throw new Error("ruling must be canon|thread|story-local|reject");
                }
                const result = ratify(db, bus, docsDir, {
                  proposalId,
                  ruling,
                  docEdit: typeof docEdit === "string" ? docEdit : undefined,
                  docId: typeof docId === "string" ? docId : undefined,
                  span: typeof span === "string" ? span : undefined,
                });
                // ACT1: ratify is on the agent-write list (no authorship on
                // this wire) — it resolves auto states unconditionally.
                resolveActivity(entry);
                return Response.json(result);
              })
              .catch((e) => {
                // R1: the in-zone refusal is typed — 409 {error:"zoned",
                // zoneId} so menus branch without string-matching (the
                // CitedError/ZoneNotEmptyError family).
                if (e instanceof ZonedError) {
                  return new Response(JSON.stringify({ error: "zoned", zoneId: e.zoneId }), {
                    status: 409,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                return new Response(
                  JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                  { status: 400, headers: { "Content-Type": "application/json" } },
                );
              });
          }

          if (req.method === "POST" && path === "/lens") {
            const { db, bus, meta } = loadProject(projectId);
            return req
              .json()
              .then((body) => {
                const { owner, nodeId, depth, docId } = body as {
                  owner?: unknown;
                  nodeId?: unknown;
                  depth?: unknown;
                  docId?: unknown;
                };
                if (typeof owner !== "string") throw new Error("owner required");
                // Claim V2 intake: node XOR doc, exactly one; depth is a
                // node-lens knob only; a doc lens must name a real doc slug
                // (same fail-loud spirit as mark/propose intake).
                const hasNode = typeof nodeId === "string";
                const hasDoc = typeof docId === "string";
                if (hasNode === hasDoc) {
                  throw new Error("lens requires exactly one of nodeId or docId");
                }
                if (hasDoc && depth !== undefined && depth !== null) {
                  throw new Error("depth applies to a node lens only");
                }
                if (hasDoc) {
                  if (!SLUG_RE.test(docId as string)) {
                    throw new Error(`docId is not a valid doc slug: ${String(docId)}`);
                  }
                  if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(docId as string)) {
                    throw new Error(`unknown doc: ${String(docId)}`);
                  }
                }
                const lens = setLens(db, bus, meta.id, {
                  owner,
                  nodeId: hasNode ? (nodeId as string) : null,
                  depth: hasNode && typeof depth === "number" ? depth : null,
                  docId: hasDoc ? (docId as string) : null,
                });
                return Response.json(lens);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }
          if (req.method === "DELETE" && path === "/lens") {
            const { db, bus, meta } = loadProject(projectId);
            clearLens(db, bus, meta.id);
            return Response.json({ ok: true });
          }

          if (req.method === "POST" && path.startsWith("/look-here/")) {
            const { bus } = loadProject(projectId);
            lookHere(bus, path.slice("/look-here/".length));
            return Response.json({ ok: true });
          }

          if (req.method === "DELETE" && path.startsWith("/doc/")) {
            const { db, bus, meta } = loadProject(projectId);
            const id = path.slice("/doc/".length);
            const force = url.searchParams.has("force");
            try {
              const result = deleteDoc(db, bus, projectDir(HOME, meta.id), id, force);
              if (!result) {
                return new Response('{"error":"unknown doc"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                });
              }
              return Response.json({ ok: true, id });
            } catch (e) {
              if (e instanceof CitedError) {
                return new Response(JSON.stringify({ error: "cited", citedBy: e.citedBy }), {
                  status: 409,
                  headers: { "Content-Type": "application/json" },
                });
              }
              return new Response(
                JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }

          // Round 4 (K1) — mark route family: 404-first for unknown/non-slug
          // ids, 400 for a bad payload. kind: null clears (author nulled too).
          if (req.method === "POST" && path.startsWith("/doc/") && path.endsWith("/kind")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/doc/".length, -"/kind".length);
            return req
              .json()
              .then((body) => {
                const { kind, author } = body as { kind?: unknown; author?: unknown };
                if (kind !== null && typeof kind !== "string") {
                  throw new Error("kind must be a string, or null to clear");
                }
                const result = setDocKind(db, bus, {
                  docId: id,
                  kind: kind as string | null,
                  author: typeof author === "string" ? author : undefined,
                });
                if (!result) {
                  return new Response('{"error":"unknown doc"}', {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                  });
                }
                return Response.json(result);
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "POST" && path.startsWith("/doc/") && path.endsWith("/mark")) {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const id = path.slice("/doc/".length, -"/mark".length);
            return req
              .json()
              .then((body) => {
                const { author, note, status } = body as {
                  author?: unknown;
                  note?: unknown;
                  status?: unknown;
                };
                if (typeof status !== "string") throw new Error("mark requires a status string");
                const resolvedAuthor = typeof author === "string" ? author : "agent";
                const mark = markDoc(db, bus, projectDir(HOME, meta.id), {
                  docId: id,
                  author: resolvedAuthor,
                  note: typeof note === "string" ? note : undefined,
                  status,
                });
                // ACT1: an agent-authored mark resolves auto states.
                if (resolvedAuthor === "agent") resolveActivity(entry);
                return Response.json({ docId: id, mark });
              })
              .catch(
                (e) =>
                  new Response(
                    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                    { status: 400, headers: { "Content-Type": "application/json" } },
                  ),
              );
          }

          if (req.method === "GET" && path.startsWith("/doc/")) {
            const { db, meta } = loadProject(projectId);
            const doc = readDoc(
              db,
              join(projectDir(HOME, meta.id), "docs"),
              path.slice("/doc/".length),
            );
            if (doc) return Response.json(doc);
            return new Response('{"error":"unknown doc"}', {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (mode === "release") {
            const asset = serveDist(path);
            if (asset) return asset;
          }
          return new Response('{"error":"not found"}', {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return projectFailure(e);
        }
      },
      websocket: {
        open(ws) {
          const data = ws.data as { since: number; projectId?: string; unsubscribe?: () => void };
          const { bus } = loadProject(data.projectId);
          data.unsubscribe = bus.subscribe(data.since, (event) => {
            ws.send(JSON.stringify(event));
          });
        },
        close(ws) {
          (ws.data as { unsubscribe?: () => void }).unsubscribe?.();
        },
        message() {
          /* the browser only listens on this socket in V1 */
        },
      },
    });
  } catch (e) {
    process.stderr.write(
      `${JSON.stringify({ event: "bind_error", host, port, error: e instanceof Error ? e.message : String(e) })}\n`,
    );
    return 2;
  }

  const url = `http://${host}:${server.port}`;
  try {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(PORT_FILE, String(server.port));
    writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(
      `mind-mapper: could not write discovery files: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ url, port: server.port, mode, ...(buildInfo ? { buildInfo } : {}) })}\n`,
  );
  if (!parsed.values["no-open"]) openBrowser(url);

  // Standing until killed (SIGTERM/SIGINT) — no idle timeout in V1.
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync(PID_FILE);
      unlinkSync(PORT_FILE);
    }
  } catch {
    /* fine */
  }
  for (const { db } of projects.values()) db.close();
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { main, readDoc, sseResponse };
