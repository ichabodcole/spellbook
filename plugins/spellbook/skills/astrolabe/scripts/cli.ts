#!/usr/bin/env bun

// astrolabe CLI — thin, stateless wrapper around the standing observatory
// daemon's HTTP surface (server.ts). The agent drives the board through these
// verbs; `join`/`tail` stream events as JSONL for Monitor to wrap.
//
// Discovery + lifecycle: a SINGLETON daemon per $ASTROLABE_HOME. The first verb
// that needs it auto-spawns it (detached, survives this CLI); it's found via
// $ASTROLABE_HOME/daemon.{port,pid}.
//
//   bun cli.ts open [--no-open] [--timeout S]    # ensure the daemon is up + open the board
//   bun cli.ts add <name> --path <p> [--description ..] [--avatar ..] [--id ..] [--stdin]
//   bun cli.ts remove <id>                       # unregister a project (durable)
//   bun cli.ts join <id> [--as <name>] [--since N]   # scoped /events tail — ACTIVATES the card + receives pokes (wrap with Monitor)
//   bun cli.ts status <id> <summary...> [--phase ..] [--stdin]   # replace the current status
//   bun cli.ts attention <id> [--clear] [--question ...]         # raise / clear the human gate
//   bun cli.ts poke <id>                         # request a fresh status from the project's agent
//   bun cli.ts state                             # read-back: project cards
//   bun cli.ts tail [--since N] [--as <name>]    # unscoped event tail → JSONL (no presence)
//   bun cli.ts list | close | info | help
//
// `join` is the listening loop a project's agent runs: holding the scoped
// `/events?project=<id>` tail open is what marks the card active (per the daemon
// contract — presence IS the live connection), and the same tail delivers pokes.
//
// Identity: --as / --from (or $ASTROLABE_AS) stamps the event `by` and drives
// self-echo suppression. --stdin reads free text (description/summary) from
// stdin (bypasses shell quoting). Discipline: structured JSON on stdout (one
// line); liveness, echoes, diagnostics on stderr — never merge them. Exit 2 on
// bad args OR a rejected command (dedupe / unknown id); 0 on success; a tail
// exits 0 on the daemon's `closed` frame.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join(homedir(), ".astrolabe");
const PORT_FILE = join(ASTROLABE_HOME, "daemon.port");

function die(msg: string): never {
  process.stderr.write(`astrolabe: ${msg}\n`);
  process.exit(2);
}
const printJson = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// id + avatar are DERIVED by the daemon (state.ts) from the project name, so the
// cli passes id/avatar through only when the caller gave them explicitly — one
// source of truth, no slug/avatar mirror to drift.

function resolveAs(flags: Record<string, string | boolean>): string | undefined {
  const v = flags.as ?? flags.from;
  if (typeof v === "string" && v.trim()) return v.trim();
  const env = process.env.ASTROLABE_AS;
  return env?.trim() ? env.trim() : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// ── daemon discovery + HTTP ──────────────────────────────────────────

async function readPort(): Promise<number | null> {
  try {
    const p = Number.parseInt((await Bun.file(PORT_FILE).text()).trim(), 10);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function isUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/state`)).ok;
  } catch {
    return false;
  }
}

// Find the running daemon, or auto-spawn one (detached so it outlives this CLI —
// node:child_process, not Bun.spawn, which can't detach a surviving daemon).
async function ensureDaemon(): Promise<{ base: string; port: number }> {
  const existing = await readPort();
  if (existing && (await isUp(existing))) {
    return { base: `http://127.0.0.1:${existing}`, port: existing };
  }
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    // cwd MUST be the skill root: the daemon serves a Bun-bundled React surface,
    // and Bun reads bunfig.toml (the Tailwind plugin) from cwd ONLY — launched
    // from anywhere else, Tailwind is silently skipped and the board is unstyled.
    cwd: join(SCRIPT_DIR, ".."),
  });
  proc.unref();
  // The daemon BINDS fast and answers /state as soon as it's listening (the
  // cold Tailwind+React bundle is lazy, on the first GET "/"), so this handshake
  // usually returns quickly. The wide deadline covers a cold machine where
  // module load + first serve runs slow (glamour uses the same ~45s budget).
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(80);
    const p = await readPort();
    if (p && (await isUp(p))) return { base: `http://127.0.0.1:${p}`, port: p };
  }
  die("astrolabe daemon failed to start within 45s");
}

// A read-only verb requires a live daemon but must not spawn one (nothing to
// observe yet) — so `state`/`list`/`info` on a cold machine report cleanly.
async function runningBase(): Promise<string | null> {
  const p = await readPort();
  return p ? `http://127.0.0.1:${p}` : null;
}

async function postCmd(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; applied: boolean; error?: string };
}

// Apply a /cmd, surface a rejection on stderr + non-zero exit (exit-code
// contract), and echo the structured result on stdout on success.
async function cmd(base: string, body: Record<string, unknown>) {
  const r = await postCmd(base, body);
  if (!r.applied) die(r.error ?? `command '${String(body.type)}' was not applied`);
  printJson(r);
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}

// SSE reader: stream the event log as JSONL on stdout, resumable + reconnecting.
// `scopeId` (set by `join`) filters to this project's frames + lifecycle; an
// unscoped tail passes everything. Self-echo (frames the caller's own --as
// caused) is suppressed. `:` keepalives ride stderr; exits 0 on `closed`.
async function streamEvents(
  base: string,
  opts: { since: number; project?: string; scopeId?: string; self?: string },
) {
  let since = opts.since;
  let delay = 250;
  const stop = () => process.exit(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const inScope = (ev: { type?: string; projectId?: string }) => {
    if (!opts.scopeId) return true;
    if (ev.type === "ready" || ev.type === "closed") return true;
    return ev.projectId === opts.scopeId;
  };

  for (;;) {
    const projectQ = opts.project ? `&project=${encodeURIComponent(opts.project)}` : "";
    let res: Response;
    try {
      res = await fetch(`${base}/events?since=${since}${projectQ}`);
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!res.ok || !res.body) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    delay = 250;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            process.stderr.write(": astrolabe-keepalive\n");
            continue;
          }
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join("\n");
        try {
          const ev = JSON.parse(payload) as {
            id?: number;
            type?: string;
            by?: string;
            projectId?: string;
          };
          if (typeof ev.id === "number" && ev.id > since) since = ev.id;
          const selfEcho = opts.self !== undefined && ev.by === opts.self;
          if (inScope(ev) && !selfEcho) process.stdout.write(`${payload}\n`);
          if (ev.type === "closed") process.exit(0);
        } catch {
          /* skip malformed frame */
        }
      }
    }
    await sleep(delay);
  }
}

// ── verbs ────────────────────────────────────────────────────────────

async function cmdOpen(flags: Record<string, string | boolean>) {
  const { port } = await ensureDaemon();
  if (!flags["no-open"]) openBrowser(`http://127.0.0.1:${port}`);
  printJson({ ok: true, url: `http://127.0.0.1:${port}`, port });
}

async function cmdAdd(pos: string[], flags: Record<string, string | boolean>) {
  const name = pos.join(" ").trim();
  if (!name) die("usage: add <name> --path <p> [--description ..] [--avatar ..] [--id ..]");
  const path = typeof flags.path === "string" ? flags.path.trim() : "";
  if (!path) die("add requires --path <p>");
  const description = flags.stdin
    ? await readStdin()
    : typeof flags.description === "string"
      ? flags.description
      : undefined;
  // id + avatar are optional — the daemon derives both from the name when omitted.
  const avatar = typeof flags.avatar === "string" ? flags.avatar : undefined;
  const id = typeof flags.id === "string" && flags.id.trim() ? flags.id.trim() : undefined;
  const { base } = await ensureDaemon();
  await cmd(base, {
    type: "project.add",
    project: { id, name, path, description, avatar },
    as: resolveAs(flags),
  });
}

async function cmdRemove(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: remove <id>");
  const { base } = await ensureDaemon();
  await cmd(base, { type: "project.remove", id, as: resolveAs(flags) });
}

async function cmdStatus(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: status <id> <summary...> [--phase ..] [--stdin]");
  const summary = flags.stdin ? await readStdin() : pos.slice(1).join(" ").trim();
  if (!summary) die("status requires a summary (positional or --stdin)");
  const phase = typeof flags.phase === "string" ? flags.phase : undefined;
  const { base } = await ensureDaemon();
  await cmd(base, { type: "status", id, summary, phase, as: resolveAs(flags) });
}

async function cmdAttention(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: attention <id> [--clear] [--question ...]");
  const raised = flags.clear !== true;
  const question =
    typeof flags.question === "string"
      ? flags.question
      : pos.slice(1).join(" ").trim() || undefined;
  const { base } = await ensureDaemon();
  await cmd(base, { type: "attention", id, raised, question, as: resolveAs(flags) });
}

async function cmdPoke(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: poke <id>");
  const { base } = await ensureDaemon();
  await cmd(base, { type: "poke", id, as: resolveAs(flags) });
}

async function cmdState() {
  const base = await runningBase();
  if (!base || !(await isUp(Number.parseInt(base.split(":").pop() as string, 10)))) {
    printJson({ ok: true, running: false, state: { title: "Observatory", projects: [] } });
    return;
  }
  const res = await fetch(`${base}/state`);
  if (!res.ok) die(`state failed (HTTP ${res.status})`);
  printJson(await res.json());
}

async function cmdList() {
  const base = await runningBase();
  // Guard with isUp() before fetching (mirrors cmdState): a STALE daemon.port
  // from a crashed daemon would otherwise throw ECONNREFUSED here instead of the
  // clean running:false path.
  if (!base || !(await isUp(Number.parseInt(base.split(":").pop() as string, 10)))) {
    printJson({ ok: true, running: false, projects: [] });
    return;
  }
  const { state } = (await (await fetch(`${base}/state`)).json()) as {
    state: { projects: Array<Record<string, unknown>> };
  };
  printJson({
    ok: true,
    running: true,
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      zone: p.zone,
      connected: p.connected,
    })),
  });
}

async function cmdClose(flags: Record<string, string | boolean>) {
  const base = await runningBase();
  if (!base) {
    printJson({ ok: true, applied: false, error: "no daemon running" });
    return;
  }
  printJson(await postCmd(base, { type: "close", as: resolveAs(flags) }));
}

async function cmdInfo() {
  const port = await readPort();
  if (port && (await isUp(port))) {
    printJson({ ok: true, running: true, url: `http://127.0.0.1:${port}`, port });
  } else {
    printJson({ ok: true, running: false });
  }
}

const HELP = `astrolabe — a standing observatory board for projects in flight.

  open [--no-open]
      ensure the daemon is up + open the board in the browser
  add <name> --path <p> [--description ..] [--avatar ..] [--id ..] [--stdin]
      register a project (dedupe-guarded; id + avatar derived from the name when omitted).
      the response echoes the derived id — you need it for join/status/attention/remove.
  remove <id>
      unregister a project
  join <id> [--as <name>] [--since N]
      activate the card + listen for pokes (scoped tail; wrap with Monitor). end it to idle the card.
  status <id> <summary...> [--phase ..] [--stdin]
      replace a project's current status
  attention <id> [--clear] [--question ...]
      raise / clear the needs-you gate (--question attaches the prompt)
  poke <id>
      request a fresh status from the project's agent
  state
      read-back: project cards (each carries a derived zone: attention | active | quiet)
  tail [--since N] [--as <name>]
      unscoped event tail as JSONL (no presence)
  list | close | info | help

  Identity: --as / --from (or $ASTROLABE_AS) stamps the actor + suppresses self-echo.
  --stdin reads a description/summary from stdin (shell-quoting-safe).`;

async function main(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        as: { type: "string" },
        from: { type: "string" },
        path: { type: "string" },
        description: { type: "string" },
        avatar: { type: "string" },
        id: { type: "string" },
        phase: { type: "string" },
        question: { type: "string" },
        since: { type: "string" },
        timeout: { type: "string" },
        clear: { type: "boolean", default: false },
        stdin: { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  const flags = parsed.values as Record<string, string | boolean>;
  const pos = parsed.positionals as string[];
  const since = typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1;

  switch (verb) {
    case "open":
      await cmdOpen(flags);
      return 0;
    case "add":
      await cmdAdd(pos, flags);
      return 0;
    case "remove":
      await cmdRemove(pos, flags);
      return 0;
    case "status":
      await cmdStatus(pos, flags);
      return 0;
    case "attention":
      await cmdAttention(pos, flags);
      return 0;
    case "poke":
      await cmdPoke(pos, flags);
      return 0;
    case "state":
      await cmdState();
      return 0;
    case "list":
      await cmdList();
      return 0;
    case "close":
      await cmdClose(flags);
      return 0;
    case "info":
      await cmdInfo();
      return 0;
    case "join": {
      const id = pos[0];
      if (!id) die("usage: join <id> [--as <name>] [--since N]");
      const { base } = await ensureDaemon();
      // Confirm the project exists before holding the watch (a typo'd id would
      // otherwise bind no presence and silently stream nothing useful).
      const { state } = (await (await fetch(`${base}/state`)).json()) as {
        state: { projects: Array<{ id: string }> };
      };
      if (!state.projects.some((p) => p.id === id))
        die(`unknown project '${id}' — register it first`);
      await streamEvents(base, { since, project: id, scopeId: id, self: resolveAs(flags) });
      return 0;
    }
    case "tail": {
      const { base } = await ensureDaemon();
      await streamEvents(base, { since, self: resolveAs(flags) });
      return 0;
    }
    default:
      die(`unknown verb '${verb}' — try 'help'`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
