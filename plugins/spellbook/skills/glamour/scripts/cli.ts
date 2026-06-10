#!/usr/bin/env bun

// glamour CLI — thin wrapper around the per-session daemon's HTTP surface
// (server.ts). The agent drives a compose session through these verbs;
// `tail` streams user events as JSONL for Monitor to wrap.
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--intent ..] [--no-open]   # spawn a session
//   bun cli.ts tail                                          # SSE user events → JSONL (Monitor this)
//   bun cli.ts state                                         # full state snapshot
//
// Pushing into the session (POST /cmd):
//   bun cli.ts intent <text...>
//   bun cli.ts read <influenceId> <text...>                  # per-image analysis
//   bun cli.ts phase <gather|analysis|direction|prompts|variants|spec>
//   bun cli.ts direction <text...> [--revision N]
//   bun cli.ts prompts "<prompt 1>" "<prompt 2>" ...
//   bun cli.ts variant (--file <path> | --src <dataurl|url>) [--prompt ..] [--label ..] [--round N]
//   bun cli.ts variants-clear
//   bun cli.ts spec [--understanding ..] [--recreate ..] [--model ..] [--modules "palette=on,motifs=off"]
//   bun cli.ts say <text...>                                 # toast on the surface
//   bun cli.ts close
//   bun cli.ts info | help
//
// All verbs target the most recent session by default; pass --session <id>
// to target a specific one.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const SNAPSHOTS_DIR = join(process.env.GLAMOUR_HOME ?? join(homedir(), ".glamour"), "snapshots");

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

type Session = {
  url: string;
  port: number;
  session_id: string;
  title: string;
  files_dir?: string;
};

function die(msg: string): never {
  process.stderr.write(`glamour: ${msg}\n`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session
    ? join(tmpdir(), `glamour-${session}.json`)
    : join(tmpdir(), "glamour-latest.json");
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
  if (!s) die("no running glamour session — run: cli.ts open");
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

// ── verbs ───────────────────────────────────────────────────────────

async function cmdOpen(flags: Record<string, string | boolean>) {
  const args = ["run", SERVER_SCRIPT];
  if (flags.title) args.push("--title", String(flags.title));
  if (flags.intent) args.push("--intent", String(flags.intent));
  if (flags.timeout) args.push("--timeout", String(flags.timeout));
  if (flags.restore) args.push("--restore", String(flags.restore));
  if (flags["no-open"]) args.push("--no-open");

  const prevId = readSession()?.session_id;
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
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
  die("glamour server failed to start within 5s");
}

async function cmdState(session?: string, full = false) {
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
            process.stderr.write(": glamour-keepalive\n");
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
    // stream ended — session likely closed; loop will retry or exit.
    await sleep(delay);
  }
}

function fileToDataUrl(path: string): string {
  const buf = readFileSync(path);
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Download an image URL and inline it as a data URL — so a generated variant
// is self-contained (persists in the snapshot, survives presigned-URL expiry).
async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) die(`fetch failed (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function cmdInfo(session?: string) {
  const s = readSession(session);
  if (!s) die("no running glamour session");
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
  type Row = {
    id: string;
    title: string;
    phase: string;
    influences: number;
    prompts: number;
    variants: number;
    mtime: number;
  };
  const rows: Row[] = [];
  for (const f of files) {
    const path = join(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        phase: st.phase,
        influences: (st.influences || []).length,
        prompts: (st.prompts || []).length,
        variants: (st.variants || []).length,
        mtime: statSync(path).mtimeMs,
      });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(
      `${r.id}  [${r.phase}]  ${r.influences} inf · ${r.prompts} prompts · ${r.variants} variants  — ${r.title}\n`,
    );
  }
  if (!rows.length) process.stdout.write("no saved sessions\n");
}

const HELP = `glamour — compose a visual style spec.

  open   [--title ..] [--intent ..] [--no-open] [--timeout S] [--restore <id|path>]
  sessions                           list saved (resumable) sessions
  tail   [--since N]                  SSE user events → JSONL (wrap with Monitor)
  state  [--full]                    lean state snapshot (add --full for raw incl. base64)
  intent <text...>
  read   <influenceId> <text...>      post per-image analysis
  phase  <gather|analysis|direction|prompts|variants|spec>
  direction <text...> [--revision N]
  prompts "<p1>" "<p2>" ...
  variant (--url <url> | --file <path> | --src <dataurl>) [--prompt ..] [--label ..] [--round N]
  variants-clear
  spec   [--understanding ..] [--recreate ..] [--model ..] [--modules "palette=on,motifs=off"]
  status on [text...] | status off       # show/hide the "agent working" spinner
  say    <text...>
  narrate [--kind info|working|result|error] <text...>   # agent→user activity feed
  close | info | help

  Add --session <id> to target a specific session (default: most recent).`;

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
    case "intent":
      if (!pos.length) die("usage: intent <text...>");
      await postCmd(session, { type: "intent", text: pos.join(" ") });
      break;
    case "read": {
      if (pos.length < 2) die("usage: read <influenceId> <text...>");
      const [id, ...words] = pos;
      await postCmd(session, {
        type: "influence.read",
        id,
        read: words.join(" "),
      });
      break;
    }
    case "phase":
      if (!pos[0]) die("usage: phase <phase>");
      await postCmd(session, { type: "phase", phase: pos[0] });
      break;
    case "direction": {
      if (!pos.length) die("usage: direction <text...> [--revision N]");
      const msg: Record<string, unknown> = {
        type: "direction",
        understanding: pos.join(" "),
      };
      if (typeof flags.revision === "string") msg.revision = parseInt(flags.revision, 10);
      await postCmd(session, msg);
      break;
    }
    case "prompts":
      if (!pos.length) die('usage: prompts "<p1>" "<p2>" ...');
      await postCmd(session, {
        type: "prompts",
        prompts: pos.map((text) => ({ text })),
      });
      break;
    case "variant": {
      let src: string;
      if (typeof flags.url === "string") src = await urlToDataUrl(flags.url);
      else if (typeof flags.file === "string") src = fileToDataUrl(flags.file);
      else if (typeof flags.src === "string") src = flags.src;
      else
        die(
          "usage: variant (--url <url> | --file <path> | --src <dataurl>) [--prompt ..] [--label ..]",
        );
      const variant: Record<string, unknown> = { src };
      if (typeof flags.prompt === "string") variant.prompt = flags.prompt;
      if (typeof flags.label === "string") variant.label = flags.label;
      if (typeof flags.round === "string") variant.round = parseInt(flags.round, 10);
      await postCmd(session, { type: "variant.add", variant });
      break;
    }
    case "variants-clear":
      await postCmd(session, { type: "variants.clear" });
      break;
    case "spec": {
      const spec: Record<string, unknown> = {};
      if (typeof flags.understanding === "string") spec.understanding = flags.understanding;
      if (typeof flags.recreate === "string") spec.recreatePrompt = flags.recreate;
      if (typeof flags.model === "string") spec.model = flags.model;
      if (typeof flags.modules === "string") {
        spec.modules = flags.modules
          .split(",")
          .map((kv) => kv.trim())
          .filter(Boolean)
          .map((kv) => {
            const [key, val] = kv.split("=");
            return { key: key.trim(), on: (val ?? "on").trim() !== "off" };
          });
      }
      await postCmd(session, { type: "spec", spec });
      break;
    }
    case "status": {
      // status on [text...]  |  status off
      const on = pos[0] === "on";
      await postCmd(session, {
        type: "status",
        busy: on,
        text: pos.slice(1).join(" "),
      });
      break;
    }
    case "say":
      if (!pos.length) die("usage: say <text...>");
      await postCmd(session, { type: "message", text: pos.join(" ") });
      break;
    case "narrate": {
      if (!pos.length) die("usage: narrate [--kind info|working|result|error] <text...>");
      const kind = typeof flags.kind === "string" ? flags.kind : "info";
      const VALID_KINDS: string[] = ["info", "working", "result", "error"];
      if (!VALID_KINDS.includes(kind)) die(`--kind must be one of: ${VALID_KINDS.join("|")}`);
      await postCmd(session, { type: "narrate", kind, text: pos.join(" ") });
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
