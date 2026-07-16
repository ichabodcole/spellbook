#!/usr/bin/env bun

// mind-mapper — Phase 0 SPIKE daemon. Deliberately thin: serves the surface in
// dev mode (seams Contract 1) and answers GET /state with the stub map JSON,
// verbatim, no envelope (mini-seam ratified on the vine, msgs 3–6). NO
// persistence, NO /cmd, NO events — the real daemon is V1 business.
//
// Surface source lives at src/mind-mapper/surface/ (seams Contract 4); the
// import below is DYNAMIC + dev-only so a future release-mode daemon can boot
// without the surface build graph present (Contract 1's "why it bites").
// Backend ships as source (Contract 3).
//
// The stub map is authored by circe at ../data/stub-map.json and re-read per
// request, so dataset edits show up without a daemon restart. Until that file
// lands, a 2-node inline placeholder keeps the wire testable.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SCRIPT_DIR = import.meta.dir;
const STUB_FILE = join(SCRIPT_DIR, "..", "data", "stub-map.json");
const DOCS_DIR = join(SCRIPT_DIR, "..", "data", "docs");

// Discovery root — cli.ts derives the same path to find (or skip spawning) us.
const HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
const PORT_FILE = join(HOME, "daemon.port");
const PID_FILE = join(HOME, "daemon.pid");

// Inline fallback until circe's dataset lands — same StubMap shape, ratified
// on the vine: tier → node styling, provenance → edge styling, pending →
// staging overlay, no positions in the data.
const PLACEHOLDER = {
  nodes: [
    {
      id: "maren",
      title: "Maren",
      kind: "cast",
      tier: "canon",
      synopsis: "Placeholder canon node — replaced by data/stub-map.json when it lands.",
    },
    {
      id: "the-hollow",
      title: "The Hollow",
      kind: "place",
      tier: "thread",
      synopsis: "Placeholder thread-tier node.",
      pending: true,
    },
  ],
  edges: [
    {
      id: "e-maren-hollow",
      source: "maren",
      target: "the-hollow",
      label: "keeps returning to",
      provenance: "asserted",
    },
  ],
};

function readStubMap(): unknown {
  if (existsSync(STUB_FILE)) {
    try {
      return JSON.parse(readFileSync(STUB_FILE, "utf8"));
    } catch (e) {
      process.stderr.write(
        `mind-mapper: stub-map.json unreadable, serving placeholder: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }
  return PLACEHOLDER;
}

// Seam v2 (vine msgs 13–17): GET /doc/:id → { id, title, kind, content } —
// title/kind from the doc's stub-map entry, content from data/docs/<id>.md,
// both read per-request. JSON 404 for an unknown id OR a missing file.
function readDoc(id: string): { id: string; title: string; kind: string; content: string } | null {
  // Slug guard — ids are vine-agreed slugs; anything else (path traversal,
  // separators) is not a doc.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const map = readStubMap() as { docs?: Array<{ id?: unknown; title?: unknown; kind?: unknown }> };
  const entry = Array.isArray(map.docs) ? map.docs.find((d) => d.id === id) : undefined;
  if (!entry) return null;
  const file = join(DOCS_DIR, `${id}.md`);
  if (!existsSync(file)) return null;
  try {
    return {
      id,
      title: typeof entry.title === "string" ? entry.title : id,
      kind: typeof entry.kind === "string" ? entry.kind : "story",
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

  // Contract 1, spike edition: dev mode only (no dist/ exists in Phase 0). The
  // dynamic string-literal import keeps the surface graph off the module load
  // path; Bun bundles .tsx + Tailwind at serve time (bunfig.toml via cwd —
  // cli.ts pins cwd to src/mind-mapper/). hmr on for circe's iteration loop.
  const index = (await import("../../../../../src/mind-mapper/surface/index.html")).default;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes: { "/": index },
      development: { hmr: true },
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/state") {
          return Response.json(readStubMap());
        }
        if (req.method === "GET" && path.startsWith("/doc/")) {
          const doc = readDoc(path.slice("/doc/".length));
          if (doc) return Response.json(doc);
          return new Response('{"error":"unknown doc"}', {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
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
  process.stdout.write(`${JSON.stringify({ url, port: server.port, mode: "dev" })}\n`);
  if (!parsed.values["no-open"]) openBrowser(url);

  // Standing until killed (SIGTERM/SIGINT) — no idle timeout in the spike.
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
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { main, readDoc, readStubMap };
