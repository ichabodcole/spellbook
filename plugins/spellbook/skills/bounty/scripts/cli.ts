#!/usr/bin/env bun

// bounty CLI — thin, stateless wrapper around the per-session daemon's HTTP
// surface (server.ts). The agent drives the board through these verbs; `tail`
// streams board events as JSONL for Monitor to wrap.
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--timeout S] [--no-open] [--restore <id>]  # spawn a daemon
//   bun cli.ts tail [--since N]                              # SSE events → JSONL (Monitor this)
//   bun cli.ts state [--full]                               # read-back: { state, cursor }
//
// Driving the board (POST /cmd):
//   bun cli.ts add <title...> [--status ..] [--notes ..] [--id ..] [--stdin]
//   bun cli.ts update <id> [--status ..] [--title ..] [--notes ..] [--stdin]
//   bun cli.ts remove <id>
//   bun cli.ts message <text...> [--stdin]                  # toast
//   bun cli.ts init [--title ..] [--stdin-tasks]            # seed the board
//   bun cli.ts close | info | sessions | help
//
// --stdin reads the title from stdin (bypasses shell quoting — apostrophes,
// quotes, ampersands, angle brackets all land verbatim). All verbs target the
// most recent session by default; pass --session <id> to target a specific one.
//
// Discipline: structured payload on stdout (one JSON line); liveness, echoes,
// and diagnostics on stderr — never merge them. Exit 2 on bad args, 0 on a
// successful verb; `tail` exits 0 on the daemon's `closed` event.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const SNAPSHOTS_DIR = join(process.env.BOUNTY_HOME ?? join(homedir(), ".bounty"), "snapshots");

type TaskStatus = "todo" | "doing" | "review" | "done";
const VALID_STATUS: TaskStatus[] = ["todo", "doing", "review", "done"];

type Session = {
  url: string;
  port: number;
  session_id: string;
  title: string;
};

function die(msg: string): never {
  process.stderr.write(`bounty: ${msg}\n`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session ? join(tmpdir(), `bounty-${session}.json`) : join(tmpdir(), "bounty-latest.json");
}

function readSession(session?: string): Session | null {
  try {
    return JSON.parse(readFileSync(sessionFilePath(session), "utf8")) as Session;
  } catch {
    return null;
  }
}

function requireSession(session?: string): Session {
  const s = readSession(session);
  if (!s) die("no running bounty session — run: cli.ts open");
  return s;
}

async function api(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

// Split argv into positionals + flags. `--flag value` or boolean `--flag`.
function parseArgs(args: string[]): {
  pos: string[];
  flags: Record<string, string | boolean>;
} {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

async function postCmd(session: string | undefined, msg: Record<string, unknown>) {
  const s = requireSession(session);
  const { status } = await api(s.port, "POST", "/cmd", msg);
  if (status !== 200) die(`cmd failed (HTTP ${status}) — is the session still alive?`);
  printJson({ ok: true, sent: msg.type });
}

function newTaskId(): string {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}

// ── verbs ───────────────────────────────────────────────────────────

async function cmdOpen(flags: Record<string, string | boolean>) {
  const args = ["run", SERVER_SCRIPT];
  if (flags.title) args.push("--title", String(flags.title));
  if (flags.timeout) args.push("--timeout", String(flags.timeout));
  if (flags.restore) args.push("--restore", String(flags.restore));
  if (flags["no-open"]) args.push("--no-open");

  const prevId = readSession()?.session_id;
  // node:child_process (not Bun.spawn) is deliberate + matches imago/grapevine:
  // the daemon must SURVIVE this CLI process exiting, which needs detached:true
  // + unref(). Bun.spawn can't detach a surviving daemon.
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd: join(SCRIPT_DIR, ".."),
  });
  proc.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(80);
    const s = readSession();
    if (s && s.session_id !== prevId) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/state`);
        if (r.ok) {
          printJson(s);
          return;
        }
      } catch {
        /* not up yet */
      }
    }
  }
  die("bounty daemon failed to start within 5s");
}

async function cmdState(session: string | undefined, full: boolean) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200) die(`state failed (HTTP ${status})`);
  printJson(data);
}

async function cmdTail(session: string | undefined, sinceArg: number) {
  let since = sinceArg;
  let delay = 250;
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    const s = readSession(session);
    if (!s) {
      process.stderr.write("# no session yet, retrying…\n");
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
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
    while (true) {
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
            process.stderr.write(": bounty-keepalive\n");
            continue;
          }
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join("\n");
        try {
          const ev = JSON.parse(payload) as { id?: number; type?: string };
          if (typeof ev.id === "number" && ev.id > since) since = ev.id;
          process.stdout.write(`${payload}\n`);
          if (ev.type === "closed") process.exit(0);
        } catch {
          /* skip malformed frame */
        }
      }
    }
    // stream ended — daemon likely closed; loop will retry or exit.
    await sleep(delay);
  }
}

function cmdInfo(session?: string) {
  const s = readSession(session);
  if (!s) die("no running bounty session");
  printJson(s);
}

function cmdSessions() {
  let files: string[];
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    process.stdout.write("no saved sessions\n");
    return;
  }
  type Row = { id: string; title: string; tasks: number; mtime: number };
  const rows: Row[] = [];
  for (const f of files) {
    const path = join(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        tasks: Array.isArray(st.tasks) ? st.tasks.length : 0,
        mtime: statSync(path).mtimeMs,
      });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.tasks} tasks  — ${r.title}\n`);
  }
  if (!rows.length) process.stdout.write("no saved sessions\n");
}

// Read all of stdin as a single string. Used by --stdin so free text (titles,
// notes) lands verbatim regardless of shell metacharacters.
async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/\n$/, "");
}

const HELP = `bounty — an agent-driven task board.

  open   [--title ..] [--timeout S] [--no-open] [--restore <id>]   spawn a board daemon
  state  [--full]                    read-back: { state, cursor } (default lean)
  tail   [--since N]                 SSE board events → JSONL (wrap with Monitor)
  add    <title...> [--status ..] [--notes ..] [--id ..] [--stdin]   add a task
  update <id> [--status ..] [--title ..] [--notes ..] [--stdin]      patch a task
  remove <id>                        delete a task
  message <text...> [--stdin]        show a toast on the board
  init   [--title ..] [--stdin-tasks]   seed the board (tasks = JSON array on stdin)
  close | info | sessions | help

  --stdin reads the title from stdin (verbatim — survives apostrophes, quotes,
  &, <, >). Add --session <id> to target a specific session (default: most recent).`;

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  const session = typeof flags.session === "string" ? flags.session : undefined;

  switch (verb) {
    case "open":
      await cmdOpen(flags);
      break;
    case "tail":
      await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1);
      break;
    case "state":
      await cmdState(session, flags.full === true);
      break;
    case "add": {
      const title = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!title) die("usage: add <title...> [--status ..] [--notes ..] [--stdin]");
      const status =
        typeof flags.status === "string" && VALID_STATUS.includes(flags.status as TaskStatus)
          ? (flags.status as TaskStatus)
          : "todo";
      const task: Record<string, unknown> = {
        id: typeof flags.id === "string" ? flags.id : newTaskId(),
        title,
        status,
      };
      if (typeof flags.notes === "string") task.notes = flags.notes;
      await postCmd(session, { type: "task.add", task });
      break;
    }
    case "update": {
      const id = pos[0];
      if (!id) die("usage: update <id> [--status ..] [--title ..] [--notes ..] [--stdin]");
      const patch: Record<string, unknown> = {};
      if (flags.stdin === true) patch.title = await readStdin();
      else if (typeof flags.title === "string") patch.title = flags.title;
      if (typeof flags.status === "string") patch.status = flags.status;
      if (typeof flags.notes === "string") patch.notes = flags.notes;
      if (Object.keys(patch).length === 0)
        die("update: nothing to change (give --status/--title/--notes/--stdin)");
      await postCmd(session, { type: "task.update", id, patch });
      break;
    }
    case "remove":
      if (!pos[0]) die("usage: remove <id>");
      await postCmd(session, { type: "task.remove", id: pos[0] });
      break;
    case "message": {
      const text = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!text) die("usage: message <text...> [--stdin]");
      await postCmd(session, { type: "message", text });
      break;
    }
    case "init": {
      const msg: Record<string, unknown> = { type: "init" };
      if (typeof flags.title === "string") msg.title = flags.title;
      if (flags["stdin-tasks"] === true) {
        const raw = await readStdin();
        try {
          const tasks = JSON.parse(raw);
          if (!Array.isArray(tasks)) die("init --stdin-tasks: stdin must be a JSON array of tasks");
          msg.tasks = tasks;
        } catch (e) {
          if (e instanceof Error && e.message.includes("JSON array")) throw e;
          die("init --stdin-tasks: invalid JSON on stdin");
        }
      }
      await postCmd(session, msg);
      break;
    }
    case "close":
      await postCmd(session, { type: "close" });
      break;
    case "info":
      cmdInfo(session);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      break;
    default:
      die(`unknown verb "${verb}" — run: cli.ts help`);
  }
  return 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

export { main };
