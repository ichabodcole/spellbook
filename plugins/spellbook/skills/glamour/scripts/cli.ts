#!/usr/bin/env bun

// glamour CLI — thin wrapper around the per-session daemon's HTTP surface
// (server.ts). The agent drives a glamour session through these verbs;
// `tail` streams user events as JSONL for Monitor to wrap.
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--intent ..] [--no-open]   # spawn a session
//   bun cli.ts tail [--since N]                               # SSE events → JSONL (Monitor this)
//   bun cli.ts state [--full]                                 # lean state snapshot
//
// Agent commands (POST /cmd):
//   bun cli.ts intent <text...>
//   bun cli.ts annotate <id> <text...>
//   bun cli.ts say <text...>
//   bun cli.ts status on [text...] | status off
//   bun cli.ts close
//   bun cli.ts info | help
//
// All verbs target the most recent session by default; pass --session <id>
// to target a specific one.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { optimizeImageDataUrl } from "../surface/state/imageOptimize.server";

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const SKILL_ROOT = join(SCRIPT_DIR, ".."); // glamour root — pin as cwd for Tailwind/bunfig

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
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
}

// Split argv into positionals + flags. `--flag value` or boolean `--flag`.
// #81 / D4 — THE RECOGNIZED SET, AT PARSER ALTITUDE.
//
// This parser already split on the first `=`. What it lacked was a REGISTRY:
// an unknown flag was accepted at exit 0 and the verb ran anyway, and free
// prose containing a `--word` was silently truncated at that word. `node:util`
// strict supplies rejection and the `--` terminator alongside the `=` handling.
//
// ⚠ `--restore` HAD NO CORRECT TYPE and this is the sprint's one genuine design
// blocker, RULED BY COLE. It was BOOLEAN in `style-archive` (`archived:
// flags.restore !== true`) and STRING in `open`'s daemon spawn — one flag name,
// two incompatible types, one options map. Declaring it boolean sends `open`'s
// id to positionals and forwards `--restore true`, so the daemon hunts a
// snapshot named "true"; declaring it string makes `style-archive <id>
// --restore` swallow the next positional, which is this sprint's own defect
// class re-introduced by its fix.
//
// Ruled: rename the BOOLEAN one. `--restore` keeps the house-wide string
// spelling it shares with bounty, imago, magpie and glamour's own server.ts;
// `style-archive` takes `--unarchive`, which names the inverse of archive
// better anyway. It also kills a live bug BY CONSTRUCTION: `flags.restore !==
// true` meant `style-archive <id> --restore foo` ARCHIVED instead of restoring,
// at exit 0, with no signal.
const CLI_OPTIONS = {
  colors: { type: "string" },
  content: { type: "string" },
  cost: { type: "string" },
  custom: { type: "string" },
  file: { type: "string" },
  intent: { type: "string" },
  kind: { type: "string" },
  label: { type: "string" },
  model: { type: "string" },
  note: { type: "string" },
  prompt: { type: "string" },
  prompts: { type: "string" },
  restore: { type: "string" },
  round: { type: "string" },
  seed: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  src: { type: "string" },
  "start-timeout": { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  url: { type: "string" },
  full: { type: "boolean" },
  "no-open": { type: "boolean" },
  unarchive: { type: "boolean" },
} as const;

export class UsageError extends Error {}

export function parseArgs(args: string[]): {
  pos: string[];
  flags: Record<string, string | boolean>;
} {
  try {
    const { values, positionals } = nodeParseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
    return { pos: positionals, flags: values as Record<string, string | boolean> };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new UsageError(
      `${detail}\n` +
        `  recognized flags: ${Object.keys(CLI_OPTIONS)
          .map((k) => `--${k}`)
          .join(" ")}\n` +
        `  for free text containing dashes, put it after a bare --`,
    );
  }
}

export function buildSayCmd(
  pos: string[],
  flags: Record<string, string | boolean>,
): { type: "say"; text: string; kind?: string } {
  const cmd: { type: "say"; text: string; kind?: string } = {
    type: "say",
    text: pos.join(" "),
  };
  if (typeof flags.kind === "string") cmd.kind = flags.kind;
  return cmd;
}

export function buildSectionCmd(
  pos: string[],
  flags: Record<string, string | boolean>,
): {
  type: "section";
  key: string;
  status?: string;
  content?: string;
  prompts?: string[];
  colors?: Array<{ hex: string; name?: string }>;
} {
  const cmd: {
    type: "section";
    key: string;
    status?: string;
    content?: string;
    prompts?: string[];
    colors?: Array<{ hex: string; name?: string }>;
  } = { type: "section", key: pos[0] };
  if (typeof flags.status === "string") cmd.status = flags.status;
  if (typeof flags.content === "string") cmd.content = flags.content;
  if (typeof flags.prompts === "string")
    cmd.prompts = flags.prompts.split("||").map((p) => p.trim());
  // --colors "#FACC3E:Treasure Gold||#293D36:Sunken Charcoal" → structured swatches
  if (typeof flags.colors === "string")
    cmd.colors = flags.colors
      .split("||")
      .map((s) => {
        const i = s.indexOf(":");
        return i >= 0
          ? { hex: s.slice(0, i).trim(), name: s.slice(i + 1).trim() }
          : { hex: s.trim() };
      })
      .filter((c) => c.hex);
  return cmd;
}

export function parseCustom(v: string | boolean | undefined): Record<string, string> | undefined {
  if (typeof v !== "string") return undefined;
  const out: Record<string, string> = {};
  for (const pair of v.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function buildGenCmd(
  src: string,
  flags: Record<string, string | boolean>,
): {
  type: "gen.add";
  src: string;
  prompt: string;
  model: string;
  round: number;
  seed?: number;
  cost?: number;
  label?: string;
  custom?: Record<string, string>;
} {
  const cmd: ReturnType<typeof buildGenCmd> = {
    type: "gen.add",
    src,
    prompt: typeof flags.prompt === "string" ? flags.prompt : "",
    model: typeof flags.model === "string" ? flags.model : "",
    round: typeof flags.round === "string" ? Number.parseInt(flags.round, 10) : 0,
  };
  if (typeof flags.seed === "string") cmd.seed = Number.parseInt(flags.seed, 10);
  if (typeof flags.cost === "string") cmd.cost = Number.parseFloat(flags.cost);
  if (typeof flags.label === "string") cmd.label = flags.label;
  const custom = parseCustom(flags.custom);
  if (custom) cmd.custom = custom;
  return cmd;
}

export function buildGenCostCmd(
  pos: string[],
  flags: Record<string, string | boolean>,
): { type: "gen.cost"; id: string; cost: number } {
  return {
    type: "gen.cost",
    id: pos[0],
    cost: typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN,
  };
}

export function buildGenMetaCmd(
  pos: string[],
  flags: Record<string, string | boolean>,
): { type: "gen.meta"; id: string; prompt?: string; custom?: Record<string, string> } {
  const cmd: { type: "gen.meta"; id: string; prompt?: string; custom?: Record<string, string> } = {
    type: "gen.meta",
    id: pos[0],
  };
  if (typeof flags.prompt === "string") cmd.prompt = flags.prompt;
  const custom = parseCustom(flags.custom);
  if (custom) cmd.custom = custom;
  return cmd;
}

export function buildStyleSaveCmd(pos: string[]): {
  type: "style.save";
  label: string;
} {
  return { type: "style.save", label: pos.join(" ") };
}

export function buildStyleArchiveCmd(
  pos: string[],
  flags: Record<string, string | boolean>,
): { type: "style.archive"; id: string; archived: boolean } {
  return {
    type: "style.archive",
    id: pos[0],
    archived: !flags.unarchive,
  };
}

export function buildFocusCmd(
  pos: string[],
  flags: Record<string, string | boolean>,
): { type: "focus.push"; ids: string[]; note?: string } {
  const cmd: { type: "focus.push"; ids: string[]; note?: string } = {
    type: "focus.push",
    ids: pos,
  };
  if (typeof flags.note === "string") cmd.note = flags.note;
  return cmd;
}

// Resolve a gen image source to an OPTIMIZED webp data-URL (the daemon stores
// it as-is). --url downloads; --file reads; --src is an existing data-URL.
async function resolveGenSrc(flags: Record<string, string | boolean>): Promise<string> {
  if (typeof flags.url === "string") {
    const res = await fetch(flags.url);
    if (!res.ok) die(`gen: failed to fetch --url (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const mime = res.headers.get("content-type") ?? "image/png";
    return optimizeImageDataUrl(`data:${mime};base64,${btoa(bin)}`);
  }
  if (typeof flags.file === "string") {
    const bytes = new Uint8Array(await Bun.file(flags.file).arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return optimizeImageDataUrl(`data:image/png;base64,${btoa(bin)}`);
  }
  if (typeof flags.src === "string") return optimizeImageDataUrl(flags.src);
  die("gen: one of --url, --file, or --src is required");
}

async function postCmd(session: string | undefined, msg: Record<string, unknown>) {
  const s = requireSession(session);
  let status: number;
  try {
    ({ status } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    // `close` causes Bun.serve to stop immediately — the connection resets
    // before the 200 response is flushed. Treat ECONNRESET on close as success.
    if (msg.type === "close") {
      printJson({ ok: true, sent: "close" });
      return;
    }
    throw err;
  }
  if (status !== 200) die(`cmd failed (HTTP ${status}) — is the session still alive?`);
  printJson({ ok: true, sent: msg.type });
}

// ── verbs ───────────────────────────────────────────────────────────

async function cmdOpen(flags: Record<string, string | boolean>) {
  const daemonArgs = ["run", SERVER_SCRIPT];
  if (flags.title) daemonArgs.push("--title", String(flags.title));
  if (flags.intent) daemonArgs.push("--intent", String(flags.intent));
  if (flags.timeout) daemonArgs.push("--timeout", String(flags.timeout));
  if (flags.restore) daemonArgs.push("--restore", String(flags.restore));
  // The user's project dir — captured here because the daemon spawns with
  // cwd pinned to SKILL_ROOT (Tailwind), so it can't read the real cwd itself.
  daemonArgs.push("--project", process.cwd());

  // node:child_process (not Bun.spawn) is deliberate: the daemon must SURVIVE
  // this CLI process exiting, which needs `detached: true` + `unref()`.
  // cwd: SKILL_ROOT is mandatory — Bun reads bunfig.toml (Tailwind plugin) from
  // the cwd only; launching from any other directory silently skips Tailwind.
  const child = spawn("bun", daemonArgs, {
    cwd: SKILL_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  child.unref();

  // Read the daemon's first stdout line — it prints {url, port, session_id}.
  // Generous default: the first bundle build of the React surface can take tens
  // of seconds cold, and a too-short handshake makes `open` report failure while
  // the daemon actually comes up fine. Override with --start-timeout <seconds>.
  const startTimeoutMs =
    typeof flags["start-timeout"] === "string"
      ? Math.max(5000, Number.parseInt(String(flags["start-timeout"]), 10) * 1000)
      : 45000;
  const info = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `daemon start timeout (${startTimeoutMs / 1000}s) — first bundle build can be slow; retry or pass --start-timeout <seconds>`,
          ),
        ),
      startTimeoutMs,
    );
    // biome-ignore lint/style/noNonNullAssertion: stdio "pipe" guarantees stdout
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timeout);
        resolve(buf.slice(0, nl).trim());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`daemon exited with code ${code}`));
      }
    });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    die(`glamour server failed to start: ${msg}`);
  });

  // ⚠ RELEASE THE DAEMON'S STDOUT PIPE, or this CLI never exits.
  //
  // `child.unref()` above releases the CHILD PROCESS handle. The piped stdout is
  // a SEPARATE reffed handle, and the daemon runs forever — so once `open` stops
  // force-exiting, the parent's event loop waits on a stream that will never
  // close. Measured: `open --no-open` still running at 91s; with this line, 1s.
  //
  // This became live when P0 replaced `process.exit(code)` with `process.exitCode`
  // + a natural return: `process.exit` had been doing DOUBLE DUTY, draining stdout
  // (broken — it truncated at 65,536) AND terminating despite a live child pipe
  // (load-bearing, and unnoticed). Removing it fixed the first and exposed the
  // second. `join.ts` has the same shape and is deliberately NOT converted.
  //
  // `unref()` rather than `destroy()`: both measured clean, and unref is the
  // conservative one — it leaves the stream usable and only stops it holding the
  // loop. The handshake is the sole read, so nothing downstream needs it.
  // biome-ignore lint/style/noNonNullAssertion: stdio "pipe" guarantees stdout
  child.stdout!.unref();

  let parsed: { url: string; port: number; session_id: string };
  try {
    parsed = JSON.parse(info) as typeof parsed;
  } catch {
    die(`unexpected output from daemon: ${info}`);
  }

  printJson(parsed);

  if (!flags["no-open"]) {
    // Platform opener — open the browser
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [parsed.url], { detached: true, stdio: "ignore" }).unref();
  }
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
  // Pin the session: resolve once, then RECONNECT to the SAME session on every
  // retry — never silently hop to a new "most recent" daemon.
  let boundId = session;
  let grounded = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    const s = readSession(boundId);
    if (!s) {
      if (grounded) process.exit(0); // pinned session went away → done
      process.stderr.write("# no session yet, retrying…\n");
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!boundId) boundId = s.session_id; // pin to the first resolved session
    if (!grounded) {
      grounded = true;
      // grounding line — parseable in Monitor, names the binding so a wrong
      // session/port is obvious instead of silent.
      process.stdout.write(
        `${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}\n`,
      );
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!res.ok) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    delay = 250;
    if (!res.body) {
      await sleep(delay);
      continue;
    }
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
          if (ev.type === "closed") {
            // P0f — SHAPE B: the drain callback rides THIS write, so it fires
            // on this write's completion. NOT a trailing `write("", cb)` — a
            // drain callback covers only its own write and is not a barrier
            // (measured byte-for-byte as broken as no fix), and that is exactly
            // the helper this write-then-exit shape invites.
            //
            // PER-SITE PRECONDITION, read at THIS site rather than carried over
            // from a sibling: the exit sits inside `while (!stopped)` ->
            // `while (true)` -> the frame loop, so `process.exitCode` + a
            // natural return (shape D) does NOT leave the tail — it falls
            // through and the loops go round again. The explicit `return` is
            // what exits the loops; the callback is what drains. Both, for
            // different reasons.
            process.stdout.write(`${payload}\n`, () => process.exit(0));
            stopped = true;
            return;
          }
          process.stdout.write(`${payload}\n`);
        } catch {
          /* skip malformed frame */
        }
      }
    }
    // stream ended — session likely closed; loop will retry or exit.
    await sleep(delay);
  }
}

function cmdInfo(session?: string) {
  const s = readSession(session);
  if (!s) die("no running glamour session");
  printJson(s);
}

const HELP = `glamour — a grounded visual conversation surface.

  open   [--title ..] [--intent ..] [--no-open] [--timeout S] [--restore <id|path>]
  tail   [--since N]                 SSE user events → JSONL (wrap with Monitor)
  state  [--full]                    lean state snapshot (add --full for raw)
  intent <text...>                   update the session intent
  annotate <id> <text...>            write agent annotation onto a library item
  say    <text...> [--kind ..]        post agent dialogue into the conversation
  section <key> [--status ..] [--content ..] [--prompts a||b] [--colors "#hex:Name||#hex:Name"]
                                     shape a style-guide section (--colors → palette swatches)
  status on [text...] | status off   show/hide the working spinner
  gen    (--url|--file|--src) --prompt .. --model .. --round N [--seed N] [--cost N] [--label ..] [--custom k=v,..]
                                     post a generated image (optimized client-side)
  gen-cost <id> --cost <n>           backfill a generated image's cost
  gen-meta <id> [--prompt <text>] [--custom k=v,..]
                                     backfill the real prompt / refs onto a gen
  focus  <id...> [--note ..]         scope the focus lens to these items + ask
  style-save <label...>              codify the current style → project tray
  style-archive <id> [--restore]     archive (or --restore) a saved style
  tray                               list the project's saved styles
  close                              shut down the session
  info                               print the resolved discovery JSON
  help                               show this message

  Add --session <id> to target a specific session (default: most recent).`;

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  // A usage failure returns 2 rather than exiting, so the runtime drains stdout
  // — an explicit process.exit is the drained-exit defect the sibling lanes of
  // this sprint exist to remove. Uncaught, it would also surface as a raw stack
  // trace at exit 1, which is not a usage error to anyone reading it.
  let pos: string[];
  let flags: Record<string, string | boolean>;
  try {
    ({ pos, flags } = parseArgs(rest));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`glamour: ${e.message}\n`);
    return 2;
  }
  const session = typeof flags.session === "string" ? flags.session : undefined;

  switch (verb) {
    case "open":
      await cmdOpen(flags);
      break;
    case "tail":
      await cmdTail(
        session,
        typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1,
      );
      break;
    case "state":
      await cmdState(session, flags.full === true);
      break;
    case "intent":
      if (!pos.length) die("usage: intent <text...>");
      await postCmd(session, { type: "intent", text: pos.join(" ") });
      break;
    case "annotate": {
      if (pos.length < 2) die("usage: annotate <id> <text...>");
      const [id, ...words] = pos;
      await postCmd(session, { type: "item.annotate", id, agent: words.join(" ") });
      break;
    }
    case "say":
      if (!pos.length) die("usage: say <text...> [--kind info|working|result|error]");
      await postCmd(session, buildSayCmd(pos, flags));
      break;
    case "section":
      if (!pos.length) die("usage: section <key> [--status ..] [--content ..] [--prompts a||b]");
      await postCmd(session, buildSectionCmd(pos, flags));
      break;
    case "status": {
      const on = pos[0] === "on";
      const text = pos.slice(1).join(" ") || undefined;
      await postCmd(session, { type: "status", busy: on, ...(text ? { text } : {}) });
      break;
    }
    case "gen": {
      if (!flags.prompt || !flags.model || !flags.round)
        die(
          "usage: gen (--url|--file|--src) --prompt .. --model .. --round N [--seed N] [--cost N] [--label ..] [--custom k=v,..]",
        );
      const src = await resolveGenSrc(flags);
      await postCmd(session, buildGenCmd(src, flags));
      break;
    }
    case "gen-cost": {
      const cost = typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN;
      if (!pos.length || !Number.isFinite(cost)) die("usage: gen-cost <id> --cost <n>");
      await postCmd(session, buildGenCostCmd(pos, flags));
      break;
    }
    case "gen-meta": {
      if (!pos.length || (flags.prompt === undefined && flags.custom === undefined))
        die(
          "usage: gen-meta <id> [--prompt <text>] [--custom k=v,..]  (backfill real prompt/refs)",
        );
      await postCmd(session, buildGenMetaCmd(pos, flags));
      break;
    }
    case "focus":
      if (!pos.length) die("usage: focus <id...> [--note ..]");
      await postCmd(session, buildFocusCmd(pos, flags));
      break;
    case "style-save":
      if (!pos.length) die("usage: style-save <label...>");
      await postCmd(session, buildStyleSaveCmd(pos));
      break;
    case "style-archive":
      if (!pos.length) die("usage: style-archive <id> [--restore]");
      await postCmd(session, buildStyleArchiveCmd(pos, flags));
      break;
    case "tray": {
      const s = requireSession(session);
      const { data } = await api(s.port, "GET", "/state?lean=1");
      const tray = (data as { state?: { tray?: unknown[] } })?.state?.tray ?? [];
      printJson(tray);
      break;
    }
    case "close":
      await postCmd(session, { type: "close" });
      break;
    case "info":
      cmdInfo(session);
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
  // `process.exitCode` + a natural return, NEVER `process.exit(code)`: Bun's
  // stdout is ASYNCHRONOUS on a pipe (synchronous on a TTY or file), so an
  // explicit exit discards whatever has not drained — measured at exactly
  // 65,536 bytes. The payload is complete and only the write is lost, so the
  // caller gets well-formed-looking JSON that stops mid-string. Reproduced,
  // fixed and gated in bounty first (P0, #77/#78); same shape, same reason.
  // Do not tidy this back into an explicit exit.
  process.exitCode = await main(process.argv.slice(2));
}

export { main };
