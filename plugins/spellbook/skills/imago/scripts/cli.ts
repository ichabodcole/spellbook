#!/usr/bin/env bun

// imago CLI — thin wrapper around the per-session daemon's HTTP surface
// (server.ts). The agent drives a grounded image conversation through these
// verbs; `tail` streams user events as JSONL for Monitor to wrap.
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--no-open]   # spawn a session
//   bun cli.ts tail                            # SSE user events → JSONL (Monitor this)
//   bun cli.ts state [--full]                  # lean state snapshot
//
// Talking + driving the canvas (POST /cmd):
//   bun cli.ts say <text...>                                   # post agent dialogue
//   bun cli.ts propose <prompt...> [--n N]                     # propose a prompt to send
//   bun cli.ts ask <text...> [--options "a|b|c"]               # ask the user (in-thread)
//   bun cli.ts batch [--kind generate|edit] [--prompt ..] [--tag ..]
//                    [--edited-from <variantId>] [--summary ..] <src1> <src2> ...
//                    # each src = an http(s) url, a data: url, or a file path
//   bun cli.ts focus <batchId> <variantId>                    # put an image on the canvas
//   bun cli.ts style <name...> [--description ..] [--image <path|url>]  # define a captured style (look + canonical image)
//   bun cli.ts status on [text...] | status off               # the working spinner
//   bun cli.ts cost <text...>                                  # cumulative spend display
//   bun cli.ts handoff <text...> | handoff --clear            # escalate to a terminal ask
//   bun cli.ts close | info | sessions | help
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
const SNAPSHOTS_DIR = join(process.env.IMAGO_HOME ?? join(homedir(), ".imago"), "snapshots");

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
  process.stderr.write(`imago: ${msg}\n`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session ? join(tmpdir(), `imago-${session}.json`) : join(tmpdir(), "imago-latest.json");
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
  if (!s) die("no running imago session — run: cli.ts open");
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
  if (flags.timeout) args.push("--timeout", String(flags.timeout));
  if (flags.restore) args.push("--restore", String(flags.restore));
  if (flags["no-open"]) args.push("--no-open");

  const prevId = readSession()?.session_id;
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    // Pin cwd to the imago root so Bun finds bunfig.toml (which registers
    // bun-plugin-tailwind for the dev server). Bun reads bunfig.toml from the
    // cwd only — without this, launching from any other directory silently
    // skips Tailwind and serves an unstyled surface.
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
  die("imago server failed to start within 5s");
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
            process.stderr.write(": imago-keepalive\n");
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

// Resolve a variant source argument: an http(s) URL (downloaded + inlined), a
// data: URL (passed through), or a local file path (read + inlined).
async function resolveSrc(arg: string): Promise<string> {
  if (/^https?:\/\//.test(arg)) return urlToDataUrl(arg);
  if (arg.startsWith("data:")) return arg;
  return fileToDataUrl(arg);
}

function cmdInfo(session?: string) {
  const s = readSession(session);
  if (!s) die("no running imago session");
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
  type Row = { id: string; title: string; batches: number; gens: number; mtime: number };
  const rows: Row[] = [];
  for (const f of files) {
    const path = join(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      const batches = (st.batches || []) as Array<{ variants?: unknown[] }>;
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        batches: batches.length,
        gens: batches.reduce((n, b) => n + (b.variants?.length ?? 0), 0),
        mtime: statSync(path).mtimeMs,
      });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.batches} batches · ${r.gens} generations  — ${r.title}\n`);
  }
  if (!rows.length) process.stdout.write("no saved sessions\n");
}

const HELP = `imago — a grounded image conversation.

  open   [--title ..] [--no-open] [--timeout S] [--restore <id|path>]
  sessions                           list saved (resumable) sessions
  tail   [--since N]                  SSE user events → JSONL (wrap with Monitor)
  state  [--full]                    lean state snapshot (add --full for raw incl. base64)
  say    <text...>                   post agent dialogue into the conversation
  propose <prompt...> [--n N]        propose a prompt for the user to send (×N, ≤4)
  ask    <text...> [--options "a|b|c"]   ask the user a question (in-thread)
  batch  [--kind generate|edit] [--prompt ..] [--tag ..] [--edited-from <vid>] [--summary ..] [--models m1,m2,..] <src> ...
                                     add a produced batch; each src = http url, data: url, or file path; --models labels each variant
  focus  <batchId> <variantId>       put an image on the canvas
  select <refId> [off]               point at a reference (highlights it for the user)
  analyze <ref-or-variant-id> <text...>  write your read onto a reference OR an image (durable metadata)
  style  <name...> [--description ..] [--image <path|url>]   define a captured style (look in words + canonical image)
  prompt --label "<name>" --text "<the prompt>"             save a reusable quick-prompt to the library
  status on [text...] | status off   show/hide the "imago working" spinner
  cost   <text...>                   cumulative spend display (e.g. "$0.38 · 8 imgs")
  handoff <text...> | handoff --clear   raise/clear a terminal-ask escalation
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
    case "say":
      if (!pos.length) die("usage: say <text...>");
      await postCmd(session, { type: "say", text: pos.join(" ") });
      break;
    case "propose": {
      if (!pos.length) die("usage: propose <prompt...> [--n N]");
      const msg: Record<string, unknown> = { type: "propose", prompt: pos.join(" ") };
      if (typeof flags.n === "string") msg.n = parseInt(flags.n, 10);
      await postCmd(session, msg);
      break;
    }
    case "ask": {
      if (!pos.length) die('usage: ask <text...> [--options "a|b|c"]');
      const msg: Record<string, unknown> = { type: "ask", text: pos.join(" ") };
      if (typeof flags.options === "string") {
        msg.options = flags.options
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      await postCmd(session, msg);
      break;
    }
    case "batch": {
      if (!pos.length) {
        die(
          "usage: batch [--kind generate|edit] [--prompt ..] [--tag ..] [--edited-from <vid>] [--summary ..] [--models m1,m2,..] <src> ...\n" +
            "  src = an http(s) url, a data: url, or a file path; --models labels each variant in order",
        );
      }
      // optional per-variant model labels, comma-separated, positional to srcs
      const models =
        typeof flags.models === "string" ? flags.models.split(",").map((m) => m.trim()) : [];
      const variants: Array<Record<string, unknown>> = [];
      for (let i = 0; i < pos.length; i++) {
        const v: Record<string, unknown> = { src: await resolveSrc(pos[i]) };
        if (models[i]) v.model = models[i];
        variants.push(v);
      }
      const msg: Record<string, unknown> = {
        type: "batch.add",
        kind: flags.kind === "edit" ? "edit" : "generate",
        prompt: typeof flags.prompt === "string" ? flags.prompt : "",
        variants,
      };
      if (typeof flags.tag === "string") msg.tag = flags.tag;
      if (typeof flags["edited-from"] === "string") msg.editedFromVariantId = flags["edited-from"];
      if (typeof flags.summary === "string") msg.summary = flags.summary;
      await postCmd(session, msg);
      break;
    }
    case "focus":
      if (pos.length < 2) die("usage: focus <batchId> <variantId>");
      await postCmd(session, { type: "focus", batchId: pos[0], variantId: pos[1] });
      break;
    case "select":
      if (!pos.length) die("usage: select <refId> [off]");
      await postCmd(session, { type: "ref.select", id: pos[0], selected: pos[1] !== "off" });
      break;
    case "analyze": {
      if (pos.length < 2) die("usage: analyze <ref-or-variant-id> <text...>");
      const [aid, ...words] = pos;
      // route by id prefix: variants are "v-…", references "ref-…"
      const type = aid.startsWith("v-") ? "variant.analyze" : "ref.analyze";
      await postCmd(session, { type, id: aid, text: words.join(" ") });
      break;
    }
    case "style": {
      if (!pos.length) die("usage: style <name...> [--description ..] [--image <path|url>]");
      const styleMsg: Record<string, unknown> = { type: "style.add", name: pos.join(" ") };
      if (typeof flags.description === "string") styleMsg.description = flags.description;
      // a captured style carries a canonical example image (a variant path/url) →
      // inline it so it's self-contained, like batch srcs
      if (typeof flags.image === "string") styleMsg.image = await resolveSrc(flags.image);
      await postCmd(session, styleMsg);
      break;
    }
    case "prompt": {
      // save a reusable quick-prompt to the library: prompt --label "X" --text "…"
      if (typeof flags.label !== "string" || typeof flags.text !== "string")
        die('usage: prompt --label "<name>" --text "<the prompt>"');
      await postCmd(session, { type: "prompt.add", label: flags.label, text: flags.text });
      break;
    }
    case "status": {
      const on = pos[0] === "on";
      await postCmd(session, { type: "status", busy: on, text: pos.slice(1).join(" ") });
      break;
    }
    case "cost":
      if (!pos.length) die("usage: cost <text...>");
      await postCmd(session, { type: "cost", text: pos.join(" ") });
      break;
    case "handoff":
      await postCmd(session, {
        type: "handoff",
        text: flags.clear === true ? "" : pos.join(" "),
      });
      break;
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
