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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openStore } from "./db.ts";
import { createEventBus, type EventBus } from "./events.ts";
import { ingestFile, ingestText } from "./ingest.ts";
import { clearLens, lookHere, setLens } from "./lens.ts";
import { neighbors } from "./neighbors.ts";
import {
  createProject,
  listProjects,
  type ProjectMeta,
  projectDir,
  resolveProject,
} from "./project.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { ratify } from "./ratify.ts";
import { search } from "./search.ts";
import { seedDefaultProject } from "./seed.ts";
import { sendMessage } from "./send.ts";
import { readState } from "./state.ts";

const SCRIPT_DIR = import.meta.dir;
const STUB_DATA_DIR = join(SCRIPT_DIR, "..", "data");
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
// reopen per request).
const projects = new Map<string, { db: Database; bus: EventBus; meta: ProjectMeta }>();

function loadProject(id?: string): { db: Database; bus: EventBus; meta: ProjectMeta } {
  const meta = resolveProject(HOME, id);
  const existing = projects.get(meta.id);
  if (existing) return existing;

  const dir = projectDir(HOME, meta.id);
  const db = openStore(join(dir, "store.sqlite"));
  if (meta.id === "default") {
    const isFresh = (db.query("SELECT COUNT(*) as n FROM docs").get() as { n: number }).n === 0;
    if (isFresh) seedDefaultProject(db, join(dir, "docs"), STUB_DATA_DIR);
  }
  const entry = { db, bus: createEventBus(), meta };
  projects.set(meta.id, entry);
  return entry;
}

// Seam v2 (vine msgs 13–17): GET /doc/:id → { id, title, kind, content } —
// title/kind/path from the docs table, content from the file at that path,
// both read per-request. JSON 404 for an unknown id OR a missing file.
function readDoc(
  db: Database,
  dir: string,
  id: string,
): { id: string; title: string; kind: string; content: string } | null {
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
    return { id, title: row.title, kind: row.kind, content: readFileSync(file, "utf8") };
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

function sseResponse(bus: EventBus, since: number): Response {
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // An opening comment flushes the response headers immediately — some
      // HTTP clients (Bun's own fetch() included) otherwise buffer until the
      // first byte of body arrives, so an SSE stream that's genuinely quiet
      // between events would leave the caller's fetch() unresolved.
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = bus.subscribe(since, (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });
    },
    cancel() {
      unsubscribe?.();
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

        if (path === "/events") {
          const { bus } = loadProject(projectId);
          if (req.headers.get("upgrade") === "websocket") {
            const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
            const ok = srv.upgrade(req, {
              data: { since: Number.isFinite(since) ? since : 0, projectId },
            });
            if (ok) return undefined;
            return new Response("upgrade failed", { status: 500 });
          }
          const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
          return sseResponse(bus, Number.isFinite(since) ? since : 0);
        }

        if (req.method === "GET" && path === "/state") {
          const { db, bus, meta } = loadProject(projectId);
          return Response.json(readState(db, meta, bus.cursor(), bus.epoch));
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

        if (req.method === "POST" && path === "/proposals") {
          const { db, bus } = loadProject(projectId);
          return req
            .json()
            .then((body) => {
              const { kind, draft, evidence, suggestedTier } = body as {
                kind?: unknown;
                draft?: unknown;
                evidence?: unknown;
                suggestedTier?: unknown;
              };
              if (kind !== "node" && kind !== "edge") throw new Error("kind must be node or edge");
              const input = {
                draft,
                evidence: (evidence as { docId?: string; span?: string } | undefined) ?? {},
                suggestedTier: typeof suggestedTier === "string" ? suggestedTier : undefined,
              };
              const proposal =
                kind === "node" ? proposeNode(db, bus, input) : proposeEdge(db, bus, input);
              return Response.json(proposal);
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
          const { db, bus, meta } = loadProject(projectId);
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

        if (req.method === "GET" && path.startsWith("/neighbors/")) {
          const { db } = loadProject(projectId);
          const depth = Number.parseInt(url.searchParams.get("depth") ?? "1", 10);
          const id = path.slice("/neighbors/".length);
          return Response.json({
            neighbors: neighbors(db, id, Number.isFinite(depth) && depth > 0 ? depth : 1),
          });
        }

        if (req.method === "POST" && path.startsWith("/proposals/") && path.endsWith("/ruling")) {
          const { db, bus, meta } = loadProject(projectId);
          const proposalId = path.slice("/proposals/".length, -"/ruling".length);
          const docsDir = join(projectDir(HOME, meta.id), "docs");
          return req
            .json()
            .then((body) => {
              const { ruling, docEdit } = body as { ruling?: unknown; docEdit?: unknown };
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
              });
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

        if (req.method === "POST" && path === "/lens") {
          const { db, bus, meta } = loadProject(projectId);
          return req
            .json()
            .then((body) => {
              const { owner, nodeId, depth } = body as {
                owner?: unknown;
                nodeId?: unknown;
                depth?: unknown;
              };
              if (typeof owner !== "string") throw new Error("owner required");
              const lens = setLens(db, bus, meta.id, {
                owner,
                nodeId: typeof nodeId === "string" ? nodeId : null,
                depth: typeof depth === "number" ? depth : null,
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
  process.stdout.write(`${JSON.stringify({ url, port: server.port, mode })}\n`);
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

export { main, readDoc };
