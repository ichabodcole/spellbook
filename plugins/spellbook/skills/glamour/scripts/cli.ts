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
//   bun cli.ts info | help | --version
//
// All verbs target the most recent session by default; pass --session <id>
// to target a specific one.
//
// ERROR CONTRACT (acc L0 — the house taxonomy magpie set and mind-mapper
// adopted): every failure is ONE JSON envelope on stderr with stdout empty —
//   {ok:false, error:{kind, exit_code, retryable, message, hint?, choices?,
//    server?}, meta:{command}}
//   usage → exit 2 · internal → 1 · not_found → 5 · conflict → 6
// A daemon refusal maps off its HTTP status (400 usage, 404 not_found,
// 409 conflict, else internal) and carries the daemon's own body VERBATIM
// under error.server. Branch on `kind`, never on `message` prose.

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

// ── error envelope ───────────────────────────────────────────────────
//
// THROW and let main() catch and RETURN the code — never process.exit inside a
// helper. This CLI ships large stdout payloads (`state --full`), and Bun's
// stdout is asynchronous on a pipe, so an explicit exit truncates whatever has
// not drained (measured at 65,536 bytes; see the drain idiom at the bottom).
type ErrKind = "usage" | "internal" | "not_found" | "conflict";

const EXIT_FOR: Record<ErrKind, number> = {
  usage: 2, // the caller can fix this by changing the command
  internal: 1, // glamour (or its daemon transport) broke; the invocation may have been fine
  not_found: 5, // the named thing does not exist (no session, no item)
  conflict: 6, // a precondition failed
};

// The verb under execution, so the envelope can name it. Set once by dispatch.
let CURRENT_COMMAND: string | null = null;

export class CliError extends Error {
  kind: ErrKind;
  hint?: string;
  choices?: string[];
  server?: unknown;
  constructor(
    kind: ErrKind,
    message: string,
    extra?: { hint?: string; choices?: string[]; server?: unknown },
  ) {
    super(message);
    this.kind = kind;
    this.hint = extra?.hint;
    this.choices = extra?.choices;
    this.server = extra?.server;
  }
}

// `UsageError` is the name the tests and the older call sites know; a usage
// failure is a CliError of kind "usage".
export class UsageError extends CliError {
  constructor(message: string, extra?: { hint?: string; choices?: string[] }) {
    super("usage", message, extra);
  }
}

function die(msg: string, kind: ErrKind = "usage", extra?: { hint?: string }): never {
  throw new CliError(kind, msg, extra);
}

function writeEnvelope(e: CliError): number {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        kind: e.kind,
        exit_code: EXIT_FOR[e.kind],
        // Nothing glamour raises is worth retrying unchanged.
        retryable: false,
        message: e.message,
        ...(e.hint !== undefined ? { hint: e.hint } : {}),
        ...(e.choices !== undefined ? { choices: e.choices } : {}),
        ...(e.server !== undefined ? { server: e.server } : {}),
      },
      meta: { command: CURRENT_COMMAND },
    })}\n`,
  );
  return EXIT_FOR[e.kind];
}

// A daemon refusal: the kind maps off the HTTP status, the daemon's own body
// rides verbatim under error.server so a caller can branch on it.
function daemonRefused(what: string, status: number, data: unknown): never {
  const kind: ErrKind =
    status === 400
      ? "usage"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : "internal";
  throw new CliError(kind, `${what} failed (HTTP ${status})`, {
    ...(data !== null && data !== undefined ? { server: data } : {}),
  });
}

const NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };

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
  if (!s) die("no running glamour session", "not_found", NO_SESSION_HINT);
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

export const RECOGNIZED_FLAGS = Object.keys(CLI_OPTIONS).map((k) => `--${k}`);

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
    // The rejection NAMES its valid set (acc A3's SHOULD): `choices` is the
    // recognized flag registry, so an agent self-corrects without a lookup.
    throw new UsageError(detail, {
      hint: "for free text containing dashes, put it after a bare --",
      choices: RECOGNIZED_FLAGS,
    });
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
    if (!res.ok) die(`gen: failed to fetch --url (HTTP ${res.status})`, "internal");
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
  let data: unknown;
  try {
    ({ status, data } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    // `close` causes Bun.serve to stop immediately — the connection resets
    // before the 200 response is flushed. Treat ECONNRESET on close as success.
    if (msg.type === "close") {
      printJson({ ok: true, sent: "close" });
      return;
    }
    throw err;
  }
  if (status !== 200) daemonRefused("cmd", status, data);
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
    die(`glamour server failed to start: ${msg}`, "internal");
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
    die(`unexpected output from daemon: ${info}`, "internal");
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
  if (status !== 200) daemonRefused("state", status, data);
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
  if (!s) die("no running glamour session", "not_found", NO_SESSION_HINT);
  printJson(s);
}

// The plugin manifest is the one version source; the CLI reads it rather than
// mirroring the number (astrolabe's pattern, via mind-mapper). Layout-dependent,
// so absence degrades to "unknown" instead of inventing one.
function versionInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string") return { name: "glamour", version: pkg.version };
  } catch {
    /* fall through to unknown */
  }
  return { name: "glamour", version: "unknown" };
}

// ── THE COMMAND TABLE, AS A STRUCTURE ────────────────────────────────
//
// The dispatcher, the stage-2 flag check, the rejections' `choices`, the
// help text and the `schema` declaration all walk THIS. It replaced a bare
// `switch`, which only the dispatcher could walk — help and the switch had
// already drifted once (the `open` row lost --start-timeout) — and a schema
// emitted from anything other than the structure that routes the behaviour
// is a document that lies as soon as anyone edits the other side.
//
// `flags` is the verb's OWN accepted set, typed against the registry, so a
// verb cannot name a flag the parser does not define. `session` is listed
// per verb rather than merged as a global: `open` spawns a session instead of
// targeting one, and `help` takes nothing.
type Flag = keyof typeof CLI_OPTIONS;
type Flags = Record<string, string | boolean>;
type PositionalSpec = { name: string; required: boolean; variadic?: boolean };
type CommandSpec = {
  name: string;
  flags: readonly Flag[];
  positionals: PositionalSpec[];
  // The one-line description help prints beside the usage.
  describe: string;
  run: (pos: string[], flags: Flags, session: string | undefined) => Promise<void> | void;
};

const SESSION = ["session"] as const satisfies readonly Flag[];
const P = {
  text: [{ name: "text", required: true, variadic: true }],
  id: [{ name: "id", required: true }],
  idText: [
    { name: "id", required: true },
    { name: "text", required: true, variadic: true },
  ],
  ids: [{ name: "id", required: true, variadic: true }],
  none: [] as PositionalSpec[],
} satisfies Record<string, PositionalSpec[]>;

const COMMANDS: CommandSpec[] = [
  {
    name: "open",
    flags: ["title", "intent", "no-open", "timeout", "start-timeout", "restore"],
    positionals: P.none,
    describe: "spawn a session (opens the browser); prints {url, port, session_id}",
    run: (_pos, flags) => cmdOpen(flags),
  },
  {
    name: "tail",
    flags: [...SESSION, "since"],
    positionals: P.none,
    describe: "SSE user events → JSONL (wrap with Monitor; waits for a session, never exits 5)",
    run: (_pos, flags, session) =>
      cmdTail(session, typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1),
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: P.none,
    describe: "lean state snapshot (--full for raw incl. base64)",
    run: (_pos, flags, session) => cmdState(session, flags.full === true),
  },
  {
    name: "intent",
    flags: SESSION,
    positionals: P.text,
    describe: "update the session intent",
    run: (pos, _flags, session) => postCmd(session, { type: "intent", text: pos.join(" ") }),
  },
  {
    name: "annotate",
    flags: SESSION,
    positionals: P.idText,
    describe: "write agent annotation onto a library item",
    run: (pos, _flags, session) => {
      const [id, ...words] = pos;
      return postCmd(session, { type: "item.annotate", id, agent: words.join(" ") });
    },
  },
  {
    name: "say",
    flags: [...SESSION, "kind"],
    positionals: P.text,
    describe: "post agent dialogue into the conversation (--kind info|working|result|error)",
    run: (pos, flags, session) => postCmd(session, buildSayCmd(pos, flags)),
  },
  {
    name: "section",
    flags: [...SESSION, "status", "content", "prompts", "colors"],
    positionals: [{ name: "key", required: true }],
    describe: 'shape a style-guide section (--prompts a||b; --colors "#hex:Name||#hex:Name")',
    run: (pos, flags, session) => postCmd(session, buildSectionCmd(pos, flags)),
  },
  {
    name: "status",
    flags: SESSION,
    positionals: [
      { name: "on|off", required: true },
      { name: "text", required: false, variadic: true },
    ],
    describe: "show/hide the working spinner",
    run: (pos, _flags, session) => {
      const on = pos[0] === "on";
      const text = pos.slice(1).join(" ") || undefined;
      return postCmd(session, { type: "status", busy: on, ...(text ? { text } : {}) });
    },
  },
  {
    name: "gen",
    flags: [
      ...SESSION,
      "url",
      "file",
      "src",
      "prompt",
      "model",
      "round",
      "seed",
      "cost",
      "label",
      "custom",
    ],
    positionals: P.none,
    describe:
      "post a generated image (one of --url|--file|--src, and --prompt --model --round required)",
    run: async (_pos, flags, session) => {
      if (!flags.prompt || !flags.model || !flags.round)
        die(
          `usage: ${usageOf(findCommand("gen") as CommandSpec)} — --prompt, --model and --round are required`,
        );
      const src = await resolveGenSrc(flags);
      await postCmd(session, buildGenCmd(src, flags));
    },
  },
  {
    name: "gen-cost",
    flags: [...SESSION, "cost"],
    positionals: P.id,
    describe: "backfill a generated image's cost (--cost <n> required)",
    run: (pos, flags, session) => {
      const cost = typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN;
      if (!Number.isFinite(cost))
        die(`usage: ${usageOf(findCommand("gen-cost") as CommandSpec)} — --cost must be a number`);
      return postCmd(session, buildGenCostCmd(pos, flags));
    },
  },
  {
    name: "gen-meta",
    flags: [...SESSION, "prompt", "custom"],
    positionals: P.id,
    describe: "backfill the real prompt / refs onto a gen (--prompt and/or --custom)",
    run: (pos, flags, session) => {
      if (flags.prompt === undefined && flags.custom === undefined)
        die(
          `usage: ${usageOf(findCommand("gen-meta") as CommandSpec)} — give --prompt or --custom`,
        );
      return postCmd(session, buildGenMetaCmd(pos, flags));
    },
  },
  {
    name: "focus",
    flags: [...SESSION, "note"],
    positionals: P.ids,
    describe: "scope the focus lens to these items (+ --note to ask)",
    run: (pos, flags, session) => postCmd(session, buildFocusCmd(pos, flags)),
  },
  {
    name: "style-save",
    flags: SESSION,
    positionals: [{ name: "label", required: true, variadic: true }],
    describe: "codify the current style → project tray",
    run: (pos, _flags, session) => postCmd(session, buildStyleSaveCmd(pos)),
  },
  {
    name: "style-archive",
    flags: [...SESSION, "unarchive"],
    positionals: P.id,
    describe: "archive (or --unarchive) a saved style",
    run: (pos, flags, session) => postCmd(session, buildStyleArchiveCmd(pos, flags)),
  },
  {
    name: "tray",
    flags: SESSION,
    positionals: P.none,
    describe: "list the project's saved styles",
    run: async (_pos, _flags, session) => {
      const s = requireSession(session);
      const { status, data } = await api(s.port, "GET", "/state?lean=1");
      if (status !== 200) daemonRefused("tray", status, data);
      printJson((data as { state?: { tray?: unknown[] } })?.state?.tray ?? []);
    },
  },
  {
    name: "close",
    flags: SESSION,
    positionals: P.none,
    describe: "shut down the session",
    run: (_pos, _flags, session) => postCmd(session, { type: "close" }),
  },
  {
    name: "info",
    flags: SESSION,
    positionals: P.none,
    describe: "print the resolved discovery JSON",
    run: (_pos, _flags, session) => cmdInfo(session),
  },
  {
    name: "schema",
    flags: [],
    positionals: P.none,
    describe: "emit this CLI's acc declaration (walked from the command table)",
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}\n`);
    },
  },
  {
    name: "help",
    flags: [],
    positionals: P.none,
    describe: "show this message",
    run: () => {
      process.stdout.write(`${renderHelp()}\n`);
    },
  },
];

// Root interceptors — tokens the ROOT answers itself, before any verb. Not
// commands and not registry flags, so they are declared explicitly at
// path [] rather than walked past.
const ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" },
] as const;

const findCommand = (token: string): CommandSpec | undefined =>
  COMMANDS.find((c) => c.name === token);

// The derived views the tests and the rejections read. VERBS is the roster;
// VERB_SPEC is each verb's accepted flags; flagsFor renders one row as the
// `choices` a rejection carries.
export const VERBS: readonly string[] = COMMANDS.map((c) => c.name);
export const VERB_SPEC: Record<string, readonly Flag[]> = Object.fromEntries(
  COMMANDS.map((c) => [c.name, c.flags]),
);
export const flagsFor = (verb: string): string[] =>
  [...(findCommand(verb)?.flags ?? [])].map((k) => `--${k}`).sort();

// ── help and the declaration, both walked from COMMANDS ─────────────

const renderFlag = (k: Flag): string =>
  CLI_OPTIONS[k].type === "boolean" ? `[--${k}]` : `[--${k} ..]`;

const renderPositional = (p: PositionalSpec): string => {
  const inner = p.variadic ? `${p.name}...` : p.name;
  return p.required ? `<${inner}>` : `[${inner}]`;
};

// The usage line: verb, positionals, then the verb's own flags (session is
// rendered once in the footer, not on every row).
export function usageOf(spec: CommandSpec): string {
  const parts = [
    spec.name,
    ...spec.positionals.map(renderPositional),
    ...spec.flags.filter((k) => k !== "session").map(renderFlag),
  ];
  return parts.join(" ");
}

export function renderHelp(): string {
  const rows = COMMANDS.map((c) => [usageOf(c), c.describe] as const);
  const width = Math.min(Math.max(...rows.map(([u]) => u.length)), 44);
  const body = rows
    .map(([usage, describe]) =>
      usage.length <= width
        ? `  ${usage.padEnd(width)}  ${describe}`
        : `  ${usage}\n  ${"".padEnd(width)}  ${describe}`,
    )
    .join("\n");
  return `glamour — a grounded visual conversation surface.

${body}
  ${ROOT_INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON

  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row; a recognized flag on the wrong
  verb is refused, and the rejection lists the verb's own flags.

  Output: every verb prints JSON on stdout by default, one document per answer —
  except tail, a stream that prints one JSON line per event, and help, which is
  prose. Failures are one JSON envelope on stderr and exit non-zero (2 = usage,
  1 = internal, 5 = not found, 6 = conflict) — except tail, which waits for a
  session instead of failing and writes its retry/keepalive notes to stderr as
  '#'-prefixed prose.`;
}

// acc declaration format v0, generated by WALKING COMMANDS and CLI_OPTIONS —
// the same structures the parser and dispatcher consume — at answer time, so
// `provenance: "emitted"` is true rather than claimed. Pipes straight into
// `acc check <cli.ts> --declaration <(cli.ts schema)`.
export function buildDeclaration() {
  // Every registry flag is accepted today; a refusal list would add
  // status: "refused" entries here the day a verb recognises-and-declines one.
  const arg = (k: Flag) => ({ name: `--${k}`, type: CLI_OPTIONS[k].type, status: "valid" });
  const commands: {
    path: string[];
    args: { name: string; type: "string" | "boolean"; status: string }[];
    positionals: PositionalSpec[];
  }[] = [
    {
      // path [] IS the root: one required token selecting a verb, or an
      // interceptor the root answers itself.
      path: [],
      args: ROOT_INTERCEPTORS.map((i) => ({
        name: i.name,
        type: "boolean" as const,
        status: "valid",
      })),
      positionals: [{ name: "verb", required: true }],
    },
    ...COMMANDS.map((c) => ({
      path: [c.name],
      args: [...c.flags].map(arg),
      positionals: c.positionals,
    })),
  ];
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands,
  };
}

// Every failure funnels through here and RETURNS its code, so the runtime
// drains stdout. Uncaught, a failure would surface as a raw stack trace at exit
// 1, which is not a usage error to anyone reading it.
async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (e) {
    if (e instanceof CliError) return writeEnvelope(e);
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    // A named file that is not there (--file paths) — the caller's.
    if (code === "ENOENT") return writeEnvelope(new UsageError(msg));
    // Everything else is glamour's own fault: one INTERNAL envelope, never a
    // stack trace — the process contract is JSON on stderr for EVERY failure.
    return writeEnvelope(new CliError("internal", msg));
  }
}

async function dispatch(argv: string[]): Promise<number> {
  // ROOT INTERCEPTORS FIRST, before any flag parsing (magpie/astrolabe
  // pattern). They are not commands and not registry flags — `state --version`
  // stays refused — which is why they are declared explicitly at path [] and
  // why a generator walking "the commands" would walk past them.
  const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === argv[0]);
  if (interceptor !== undefined || argv[0] === "version") {
    const runs = interceptor?.runs ?? "version";
    if (runs === "help") process.stdout.write(`${renderHelp()}\n`);
    else process.stdout.write(`${JSON.stringify(versionInfo())}\n`);
    return 0;
  }

  // The WHOLE argv is parsed, verb included, so a bare `--` is honoured at
  // the root (acc A6): `-- --x` yields the positional "--x", which is then an
  // unknown verb — not an unknown option.
  // Name the verb BEFORE parsing, so a parser rejection's envelope still says
  // what was being run (the first non-dash token is the verb under every
  // grammar this parser accepts).
  CURRENT_COMMAND = argv.find((a) => !a.startsWith("-")) ?? null;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    // An unknown flag's rejection names the set AT THIS PATH, not the whole
    // registry: the verb's own flags when the verb is one of ours, the verb
    // roster when there is no verb yet (the root accepts no flags of its own).
    // This is what a recorded-surface census reads, path by path.
    const spec = CURRENT_COMMAND === null ? undefined : findCommand(CURRENT_COMMAND);
    if (spec !== undefined) {
      throw new UsageError(e.message, { hint: e.hint, choices: flagsFor(spec.name) });
    }
    // At the root the flags the tool accepts are the interceptors, and that is
    // the set named — the same array `schema` declares at path [], so the
    // root is diffable. The verb roster rides the hint: the next act is a verb.
    throw new UsageError(e.message, {
      hint: `no verb given — verbs: ${VERBS.join(" ")} (run: cli.ts help)`,
      choices: ROOT_INTERCEPTORS.map((i) => i.name),
    });
  }
  const [verb, ...pos] = parsed.pos;
  const flags = parsed.flags;
  CURRENT_COMMAND = verb ?? null;

  if (verb === undefined) {
    // Bare invocation is a usage error (acc D2), and the rejection names
    // the roster so the caller's next command can be right.
    throw new UsageError("no verb given", { hint: "run: cli.ts help", choices: [...VERBS] });
  }
  const spec = findCommand(verb);
  if (spec === undefined) {
    throw new UsageError(`unknown verb "${verb}"`, {
      hint: "run: cli.ts help",
      choices: [...VERBS],
    });
  }

  // Stage 2: a recognized flag this verb does not take — MISPLACED, not
  // unknown. An agent told a real flag is unknown goes hunting a typo it did
  // not make. The verb is resolved first because which flags are legal is a
  // question about the verb.
  const allowed = new Set<string>(spec.flags);
  const stray = Object.keys(flags).find((k) => !allowed.has(k));
  if (stray !== undefined) {
    const accepted = flagsFor(spec.name);
    throw new UsageError(
      `--${stray} is not accepted by \`${spec.name}\` (it is a recognized glamour flag, just not this verb's)`,
      accepted.length > 0 ? { choices: accepted } : { hint: `${spec.name} takes no flags` },
    );
  }

  // Arity, enforced FROM THE DECLARED SHAPE: the table's positional spec is
  // what `schema` publishes and what help prints, so enforcing it here keeps
  // both true by construction. A verb's own finer checks (a numeric --cost,
  // a required flag) live in its handler and name the same usage line.
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (pos.length < required || (!variadic && pos.length > spec.positionals.length)) {
    throw new UsageError(`usage: ${usageOf(spec)}`, { hint: spec.describe });
  }

  const session = typeof flags.session === "string" ? flags.session : undefined;
  await spec.run(pos, flags, session);
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
