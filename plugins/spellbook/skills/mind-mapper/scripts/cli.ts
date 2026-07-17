#!/usr/bin/env bun

// mind-mapper — P1+P2+P3 cli, the full V1 verb set:
//   open          spawn (or find) the daemon, print its url, open the browser
//   state         GET /state → the real project snapshot on stdout
//                 --skeleton returns ids/titles/degree only (context budgeting)
//   tail          Monitor-shaped: GET /events?since=<cursor> SSE → one JSON
//                 line per event on stdout
//   projects      list saved projects; --create <title> makes a new one
//   ingest        --title T (--file P | --stdin) → POST /ingest
//   propose-node  --stdin JSON {draft, evidence, suggestedTier?} → POST /proposals
//   propose-edge  same shape, kind: "edge" (source/target may be a real node
//                 id OR a pending proposal's id — ratify resolves the latter)
//   doc <id>      GET /doc/:id → the doc envelope on stdout
//   search <q...> GET /search → {hits: [{kind: node|doc|message, ...}]}
//   neighbors <id> [--depth 1]  GET /neighbors/:id → local hood + edge reasons
//   ratify <id> --ruling canon|thread|story-local|reject [--doc-edit <file>]
//   lens set --node <id> [--depth n] | lens clear
//   look-here <nodeId>  fire-once attention nudge, not persisted
//   send          <text...> [--role user|agent] [--kind] [--ground a,b] → POST /send
//
// --project <id> is accepted by every verb above except open (scopes to a
// non-default project; omit for the default project).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SCRIPT_DIR = import.meta.dir;
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
// dev: the daemon serves a Bun-bundled React surface; Bun reads bunfig.toml
// (the Tailwind plugin) from cwd ONLY, so the daemon's cwd MUST be
// src/mind-mapper/ (seams Contract 5 cwd-pin) — launched elsewhere, Tailwind
// is silently skipped. release: dist/ is pre-built and static — no bunfig
// read, so this path need not exist at all (a source-free marketplace clone
// has no top-level src/), and pinning cwd there anyway would break spawn.
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");

function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}

const HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
const PORT_FILE = join(HOME, "daemon.port");
const PID_FILE = join(HOME, "daemon.pid");

function livePort(): number | null {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE)) return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  const port = Number.parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || !Number.isFinite(port)) return null;
  try {
    process.kill(pid, 0); // liveness probe, no signal delivered
    return port;
  } catch {
    return null; // stale discovery files
  }
}

async function ensureDaemon(): Promise<number> {
  const running = livePort();
  if (running !== null) return running;
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open"], {
    detached: true,
    stdio: "ignore",
    cwd: daemonCwd(),
  });
  proc.unref();
  // Poll discovery until the daemon writes its port (cold Bun bundle can lag).
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const port = livePort();
    if (port !== null) return port;
  }
  throw new Error("daemon did not come up within 10s");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function requireDaemon(): number {
  const port = livePort();
  if (port === null) {
    process.stderr.write("mind-mapper: no daemon running (use `open` first)\n");
    process.exit(2);
  }
  return port;
}

// Skeleton projection — ids/titles/degree only, no synopsis/content. Kept as
// a client-side transform (the daemon stays dumb and always serves the full
// snapshot; skeleton is a courtesy shape for context-budgeted agent reads).
function toSkeleton(state: {
  nodes: Array<{ id: string; title: string; kind: string; tier: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
}) {
  const degree = new Map<string, number>();
  for (const e of state.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: state.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      tier: n.tier,
      degree: degree.get(n.id) ?? 0,
    })),
  };
}

// parseArgs throws (ERR_PARSE_ARGS_UNKNOWN_OPTION etc.) on an unrecognized
// flag like a stray --help — uncaught, that's a stack-trace crash instead of
// a usage message (cassandra's P2 gate finding). Every verb's parseArgs call
// funnels through here so a bad flag always exits 2 with a one-line error.
async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    if (code.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`mind-mapper: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    throw e;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const verb = argv[0];
  const rest = argv.slice(1);

  if (verb === "open") {
    const parsed = parseArgs({
      args: rest,
      options: { "no-open": { type: "boolean", default: false } },
      strict: true,
      allowPositionals: false,
    });
    const port = await ensureDaemon();
    const url = `http://127.0.0.1:${port}`;
    if (!parsed.values["no-open"]) openBrowser(url);
    process.stdout.write(`${JSON.stringify({ ok: true, url })}\n`);
    return 0;
  }

  if (verb === "state") {
    const parsed = parseArgs({
      args: rest,
      options: { skeleton: { type: "boolean", default: false }, project: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/state${qs}`);
    if (parsed.values.skeleton) {
      const state = (await res.json()) as Parameters<typeof toSkeleton>[0];
      process.stdout.write(`${JSON.stringify(toSkeleton(state))}\n`);
    } else {
      process.stdout.write(`${await res.text()}\n`);
    }
    return 0;
  }

  if (verb === "tail") {
    const parsed = parseArgs({
      args: rest,
      options: { since: { type: "string", default: "0" }, project: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    const port = requireDaemon();
    const params = new URLSearchParams({ since: parsed.values.since as string });
    if (parsed.values.project) params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/events?${params}`);
    if (!res.body) return 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let idx = buf.indexOf("\n\n"); idx !== -1; idx = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) process.stdout.write(`${dataLine.slice("data: ".length)}\n`);
      }
    }
    return 0;
  }

  if (verb === "projects") {
    const parsed = parseArgs({
      args: rest,
      options: { create: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    const port = requireDaemon();
    if (parsed.values.create) {
      const title = parsed.values.create;
      const id = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        body: JSON.stringify({ id, title }),
      });
      process.stdout.write(`${await res.text()}\n`);
      return res.ok ? 0 : 2;
    }
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    process.stdout.write(`${await res.text()}\n`);
    return 0;
  }

  if (verb === "ingest") {
    const parsed = parseArgs({
      args: rest,
      options: {
        title: { type: "string" },
        file: { type: "string" },
        stdin: { type: "boolean", default: false },
        project: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!parsed.values.title) {
      process.stderr.write("mind-mapper: ingest requires --title\n");
      return 2;
    }
    const text = parsed.values.file
      ? readFileSync(parsed.values.file, "utf8")
      : parsed.values.stdin
        ? await Bun.stdin.text()
        : (() => {
            process.stderr.write("mind-mapper: ingest requires --file <path> or --stdin\n");
            return null;
          })();
    if (text === null) return 2;
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/ingest${qs}`, {
      method: "POST",
      body: JSON.stringify({ title: parsed.values.title, text }),
    });
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "propose-node" || verb === "propose-edge") {
    const parsed = parseArgs({
      args: rest,
      options: { stdin: { type: "boolean", default: false }, project: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (!parsed.values.stdin) {
      process.stderr.write(`mind-mapper: ${verb} requires --stdin JSON {draft, evidence}\n`);
      return 2;
    }
    const input = JSON.parse(await Bun.stdin.text()) as {
      draft: unknown;
      evidence?: { docId?: string; span?: string };
      suggestedTier?: string;
    };
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals${qs}`, {
      method: "POST",
      body: JSON.stringify({
        kind: verb === "propose-node" ? "node" : "edge",
        draft: input.draft,
        evidence: input.evidence ?? {},
        suggestedTier: input.suggestedTier,
      }),
    });
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "doc") {
    const parsed = parseArgs({
      args: rest,
      options: { project: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = parsed.positionals[0];
    if (!id) {
      process.stderr.write("usage: cli.ts doc <id> [--project <id>]\n");
      return 2;
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/doc/${id}${qs}`);
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "search") {
    const parsed = parseArgs({
      args: rest,
      options: { project: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const query = parsed.positionals.join(" ");
    if (!query) {
      process.stderr.write("usage: cli.ts search <query...>\n");
      return 2;
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ q: query });
    if (parsed.values.project) params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/search?${params}`);
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "neighbors") {
    const parsed = parseArgs({
      args: rest,
      options: { depth: { type: "string", default: "1" }, project: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = parsed.positionals[0];
    if (!id) {
      process.stderr.write("usage: cli.ts neighbors <nodeId> [--depth 1]\n");
      return 2;
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ depth: parsed.values.depth as string });
    if (parsed.values.project) params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/neighbors/${id}?${params}`);
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "ratify") {
    const parsed = parseArgs({
      args: rest,
      options: {
        ruling: { type: "string" },
        "doc-edit": { type: "string" },
        project: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    const proposalId = parsed.positionals[0];
    if (!proposalId || !parsed.values.ruling) {
      process.stderr.write("usage: cli.ts ratify <proposalId> --ruling <r> [--doc-edit <file>]\n");
      return 2;
    }
    const docEdit = parsed.values["doc-edit"]
      ? readFileSync(parsed.values["doc-edit"], "utf8")
      : undefined;
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${proposalId}/ruling${qs}`, {
      method: "POST",
      body: JSON.stringify({ ruling: parsed.values.ruling, docEdit }),
    });
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "lens") {
    const sub = rest[0];
    const parsed = parseArgs({
      args: rest.slice(1),
      options: {
        node: { type: "string" },
        depth: { type: "string" },
        owner: { type: "string", default: "agent" },
        project: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "set") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, {
        method: "POST",
        body: JSON.stringify({
          owner: parsed.values.owner,
          nodeId: parsed.values.node,
          depth: parsed.values.depth ? Number.parseInt(parsed.values.depth, 10) : undefined,
        }),
      });
      process.stdout.write(`${await res.text()}\n`);
      return res.ok ? 0 : 2;
    }
    if (sub === "clear") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, { method: "DELETE" });
      process.stdout.write(`${await res.text()}\n`);
      return res.ok ? 0 : 2;
    }
    process.stderr.write("usage: cli.ts lens <set --node <id> [--depth n] | clear>\n");
    return 2;
  }

  if (verb === "look-here") {
    const parsed = parseArgs({
      args: rest,
      options: { project: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = parsed.positionals[0];
    if (!id) {
      process.stderr.write("usage: cli.ts look-here <nodeId>\n");
      return 2;
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/look-here/${id}${qs}`, { method: "POST" });
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  if (verb === "send") {
    const parsed = parseArgs({
      args: rest,
      options: {
        role: { type: "string", default: "agent" },
        kind: { type: "string", default: "turn" },
        ground: { type: "string" },
        project: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    const text = parsed.positionals.join(" ");
    if (!text) {
      process.stderr.write("usage: cli.ts send <text...>\n");
      return 2;
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/send${qs}`, {
      method: "POST",
      body: JSON.stringify({
        role: parsed.values.role,
        kind: parsed.values.kind,
        text,
        ground: parsed.values.ground ? parsed.values.ground.split(",") : undefined,
      }),
    });
    process.stdout.write(`${await res.text()}\n`);
    return res.ok ? 0 : 2;
  }

  process.stderr.write(
    "usage: cli.ts <open|state|tail|projects|ingest|propose-node|propose-edge|doc|search|neighbors|ratify|lens|look-here|send>\n",
  );
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
