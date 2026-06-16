#!/usr/bin/env bun

// bounty CLI — thin, stateless wrapper around the per-session daemon's HTTP
// surface (server.ts). The agent drives the board through these verbs; `tail`
// streams board events as JSONL for Monitor to wrap.
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--timeout S] [--no-open] [--restore <id>]  # spawn a daemon
//   bun cli.ts tail [--since N] [--owner <name> | --mine] [--as <name>]  # scoped SSE → JSONL
//   bun cli.ts state [--full] [--owner <name> | --mine] [--as <name>]    # scoped read-back
//     Each task carries derived `blocked` + `liveBlockers:[{id,title,status}]`
//     (the not-done blockers), so a filtered blocked task stays actionable.
//
// Driving the board (POST /cmd):
//   bun cli.ts add <title...> [--status ..] [--notes ..] [--owner ..] [--id ..] [--stdin]
//   bun cli.ts update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--stdin]
//   bun cli.ts claim <id> [--as <name>]                     # self-claim an unowned task
//   bun cli.ts block <id> --on <id>[,<id>...]               # add blocker edges (cycle-guarded)
//   bun cli.ts unblock <id> --on <id>[,<id>...]             # remove blocker edges
//   bun cli.ts remove <id>
//   bun cli.ts message <text...> [--stdin]                  # toast
//   bun cli.ts init [--title ..] [--stdin-tasks]            # seed the board
//   bun cli.ts close | info | sessions | help
//
// Identity: --as <name> (or $BOUNTY_AS) stamps the event `by`, drives self-echo
// suppression + claim/--mine. Ownership: --owner assigns; tail --owner/--mine
// scopes a worker's wake-set to its own + claimable tasks (client-side filter).
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

type CmdResult = { ok?: boolean; applied?: boolean; error?: string };

// The caller's identity, stamped onto the event `by` so a scoped tail can
// filter + suppress self-echo. --as wins, else $BOUNTY_AS, else undefined.
function resolveAs(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags.as === "string") return flags.as;
  return process.env.BOUNTY_AS || undefined;
}

// POST a command; merge the caller's `as` identity in; return the apply-result.
// Pass `quiet` for verbs that print their own outcome (e.g. claim).
async function postCmd(
  session: string | undefined,
  msg: Record<string, unknown>,
  opts: { as?: string; quiet?: boolean } = {},
): Promise<CmdResult> {
  const s = requireSession(session);
  const body = opts.as ? { ...msg, as: opts.as } : msg;
  const { status, data } = await api(s.port, "POST", "/cmd", body);
  if (status !== 200) die(`cmd failed (HTTP ${status}) — is the session still alive?`);
  if (!opts.quiet) printJson({ ok: true, sent: msg.type });
  return (data ?? {}) as CmdResult;
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

async function cmdState(
  session: string | undefined,
  full: boolean,
  scope: { owner?: string; mine?: boolean; as?: string } = {},
) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200) die(`state failed (HTTP ${status})`);
  // Scoped readback (mirrors `tail` semantics): --owner X = X's tasks; --mine =
  // own + claimable (unowned). Each retained task keeps its computed
  // `liveBlockers`, so a blocked task stays actionable even when the blocker is
  // owned by someone else and thus filtered out of this view.
  if (scope.owner || scope.mine) {
    const d = data as { state?: { tasks?: Array<{ owner?: string }> } };
    if (d.state?.tasks) {
      d.state.tasks = d.state.tasks.filter((t) =>
        scope.owner ? t.owner === scope.owner : t.owner === scope.as || !t.owner,
      );
    }
  }
  printJson(data);
}

async function cmdTail(
  session: string | undefined,
  sinceArg: number,
  scope: { owner?: string; mine?: boolean; as?: string } = {},
) {
  let since = sinceArg;
  let delay = 250;
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Client-side scope filter (the daemon streams ALL events). Lifecycle frames
  // (ready/connected/disconnected/closed) always pass — only task.* frames are
  // owner-scoped. `--mine` also passes claimable (unowned) tasks.
  const owner = scope.owner;
  const self = scope.as;
  // Owner-scoped frames: task.* mutations AND `unblocked` (it carries an owner,
  // so it must be scoped — else every worker wakes on every unblock). Lifecycle
  // (ready/connected/disconnected/closed) always passes.
  const scopeable = (t?: string) =>
    typeof t === "string" && (t.startsWith("task.") || t === "unblocked");
  const inScope = (ev: { type?: string; owner?: string }) => {
    if (!scopeable(ev.type)) return true;
    if (owner) return ev.owner === owner;
    if (scope.mine) return ev.owner === self || !ev.owner;
    return true;
  };
  // Self-echo suppression: drop frames the caller's own identity caused (applied
  // after the scope filter). Notice rides stderr, never stdout.
  if (owner) process.stderr.write(`# scoped to owner=${owner}\n`);
  else if (scope.mine)
    process.stderr.write(`# scoped to --mine (owner=${self ?? "?"} + claimable)\n`);

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
          const ev = JSON.parse(payload) as {
            id?: number;
            type?: string;
            by?: string;
            owner?: string;
          };
          // Advance the cursor on EVERY event (even filtered ones) so resume is
          // correct regardless of scope.
          if (typeof ev.id === "number" && ev.id > since) since = ev.id;
          // Scope filter, then self-echo suppression. `closed` is lifecycle, so
          // it always passes — but guard the exit outside the filter regardless.
          const selfEcho = self !== undefined && ev.by === self;
          if (inScope(ev) && !selfEcho) process.stdout.write(`${payload}\n`);
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
  state  [--full] [--mine | --owner <name>] [--as <name>]   read-back: { state, cursor }
  tail   [--since N] [--owner <name> | --mine] [--as <name>]   SSE events → JSONL (Monitor)
  add    <title...> [--status ..] [--notes ..] [--owner ..] [--id ..] [--complexity ..] [--stdin]   add a task
  update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--complexity ..] [--stdin]      patch a task
  claim  <id> [--as <name>]          self-claim an UNOWNED task (rejected if owned by another)
  block  <id> --on <id>[,<id>...]    mark <id> blocked on other task(s) (rejected on a cycle)
  unblock <id> --on <id>[,<id>...]   remove blocker edge(s)
  remove <id>                        delete a task
  message <text...> [--stdin]        show a toast on the board
  init   [--title ..] [--stdin-tasks]   seed the board (tasks = JSON array on stdin)
  close | info | sessions | help

  --as <name> (or $BOUNTY_AS) is your identity — stamped on events (for scoped
  tail + self-echo suppression) and used by claim/--mine. --owner assigns a task.
  --stdin reads the title from stdin (verbatim — survives apostrophes, quotes,
  &, <, >). Add --session <id> to target a specific session (default: most recent).`;

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  const session = typeof flags.session === "string" ? flags.session : undefined;
  const as = resolveAs(flags);

  switch (verb) {
    case "open":
      await cmdOpen(flags);
      break;
    case "tail": {
      const mine = flags.mine === true;
      if (mine && !as) die("--mine needs an identity — pass --as <name> or set BOUNTY_AS");
      await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1, {
        owner: typeof flags.owner === "string" ? flags.owner : undefined,
        mine,
        as,
      });
      break;
    }
    case "state": {
      const mine = flags.mine === true;
      if (mine && !as) die("--mine needs an identity — pass --as <name> or set BOUNTY_AS");
      await cmdState(session, flags.full === true, {
        owner: typeof flags.owner === "string" ? flags.owner : undefined,
        mine,
        as,
      });
      break;
    }
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
      if (typeof flags.owner === "string") task.owner = flags.owner;
      if (typeof flags.complexity === "string") {
        if (!["S", "M", "L"].includes(flags.complexity)) {
          die("add: --complexity must be S, M, or L");
        }
        task.complexity = flags.complexity;
      }
      await postCmd(session, { type: "task.add", task }, { as });
      break;
    }
    case "update": {
      const id = pos[0];
      if (!id)
        die(
          "usage: update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--complexity ..] [--stdin]",
        );
      const patch: Record<string, unknown> = {};
      if (flags.stdin === true) patch.title = await readStdin();
      else if (typeof flags.title === "string") patch.title = flags.title;
      if (typeof flags.status === "string") patch.status = flags.status;
      if (typeof flags.notes === "string") patch.notes = flags.notes;
      if (typeof flags.owner === "string") patch.owner = flags.owner; // lead reassignment
      if (typeof flags.complexity === "string") {
        if (!["S", "M", "L"].includes(flags.complexity)) {
          die("update: --complexity must be S, M, or L");
        }
        patch.complexity = flags.complexity;
      }
      if (Object.keys(patch).length === 0)
        die(
          "update: nothing to change (give --status/--title/--notes/--owner/--complexity/--stdin)",
        );
      await postCmd(session, { type: "task.update", id, patch }, { as });
      break;
    }
    case "claim": {
      // Cooperative self-claim: take ownership of an UNOWNED task. Rejected (and
      // surfaced) if someone else already owns it — never a silent steal.
      const id = pos[0];
      if (!id) die("usage: claim <id> [--as <name>]");
      if (!as) die("claim needs an identity — pass --as <name> or set BOUNTY_AS");
      const res = await postCmd(
        session,
        { type: "task.update", id, patch: { owner: as }, claim: true },
        { as, quiet: true },
      );
      if (res.applied) {
        printJson({ ok: true, claimed: id, owner: as });
      } else {
        // Visible rejection — nonzero exit so the agent can't mistake a rejected
        // claim for ownership (the daemon returned applied:false).
        process.stderr.write(`bounty: ${res.error ?? `could not claim ${id}`}\n`);
        return 1;
      }
      break;
    }
    case "block":
    case "unblock": {
      const id = pos[0];
      if (!id || typeof flags.on !== "string") {
        die(`usage: ${verb} <id> --on <id>[,<id>...]`);
      }
      const on = flags.on
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (!on.length) die(`${verb}: --on needs at least one task id`);
      const res = await postCmd(
        session,
        { type: verb === "block" ? "task.block" : "task.unblock", id, on },
        { as, quiet: true },
      );
      if (res.applied) {
        printJson({ ok: true, [verb === "block" ? "blocked" : "unblocked"]: id, on });
      } else {
        // Visible rejection (e.g. a cycle) — nonzero exit, like a rejected claim.
        process.stderr.write(`bounty: ${res.error ?? `could not ${verb} ${id}`}\n`);
        return 1;
      }
      break;
    }
    case "remove":
      if (!pos[0]) die("usage: remove <id>");
      await postCmd(session, { type: "task.remove", id: pos[0] }, { as });
      break;
    case "message": {
      const text = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!text) die("usage: message <text...> [--stdin]");
      await postCmd(session, { type: "message", text }, { as });
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
      await postCmd(session, msg, { as });
      break;
    }
    case "close":
      await postCmd(session, { type: "close" }, { as });
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
