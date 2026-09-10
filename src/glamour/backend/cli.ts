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
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  CliError,
  die,
  type ErrKind,
  reportCliError,
  setCurrentCommand,
} from "../../kit/wire/errors";
import { tailEvents } from "../../kit/wire/tailEvents";
import { TAIL_IDLE_MS } from "./heartbeat";
import { optimizeImageDataUrl } from "./imageOptimize.server";

// ⛔ EVERY PATH HERE IS RESOLVED FROM THE EMITTED LOCATION, `dist/`, NOT FROM
// THIS SOURCE FILE. This module is bundled to
// `plugins/spellbook/skills/glamour/dist/cli.js` and the launcher at
// `../scripts/cli.ts` imports it, so `import.meta.url` names the BUNDLE. `dist/`
// happens to sit at the same depth as the `scripts/` this file used to live in,
// so `SKILL_ROOT`, `DIST_DIR` and `SURFACE_CWD` are unchanged — but that is a
// COINCIDENCE OF DEPTH, not a property, which is why the ward asserts them
// rather than trusting this paragraph.
const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
// ⛔ UP AND BACK DOWN, AND THIS LINE IS THE ONE THE RELOCATION BROKE. It read
// `join(SCRIPT_DIR, "server.ts")` — the daemon beside the CLI — which was true
// for exactly as long as both lived in `scripts/`. From `dist/` it resolves to
// `dist/server.ts`, a file that does not exist and must not: `dist/` holds the
// BUNDLE (`server.js`), and the spawnable entry is the launcher one directory
// over. The symptom of getting it wrong is not a crash — `open` waits out its
// 45-second handshake and reports a start timeout, which reads like a slow first
// bundle build. `grimoire/spawn-path-ward.test.ts` is what names it in 0.4s
// instead, and it named this one. Astrolabe and magpie were already written this
// way and paid nothing for the move; glamour is where the shape earned itself.
const SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
// Bun reads bunfig.toml (the Tailwind plugin) from cwd ONLY, so the daemon's cwd
// MUST be src/glamour/ in dev (seams Contract 5). Launched elsewhere the dev
// bundler cannot compile the stylesheet — measured on glamour the PAGE 500s with
// no stylesheet link (not "unstyled at 200"; that sentence was never run). Assert
// the invariant: the utility never reaches the browser when the cwd is wrong.
// release: dist/ is pre-built and static — no bunfig read, so src/glamour/ need
// not exist at all (a source-free marketplace clone has no top-level src/), and
// pinning cwd there anyway would break the spawn. Exported for the test.
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "glamour");

export function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
export const SKILL_ROOT_FOR_TEST = SKILL_ROOT;

type Session = {
  url: string;
  port: number;
  session_id: string;
  title: string;
  files_dir?: string;
};

// ── error envelope ───────────────────────────────────────────────────
//
// ⛔ THE CONTRACT IS NOW THE HOUSE'S ONE COPY (`src/kit/wire/errors.ts`) and
// glamour's fourth was deleted. The taxonomy, the exit codes, the envelope's key
// order and `die`'s throw-not-exit shape all come from there — and glamour is
// where two of them were first written, so nothing about the wire changed. THROW
// and let main() catch and RETURN the code, never `process.exit` inside a
// helper: this CLI ships large stdout payloads (`state --full`), Bun's stdout is
// asynchronous on a pipe, and an explicit exit truncates whatever has not
// drained (measured at 65,536 bytes).
//
// ⚠ ONE FIELD WENT THE OTHER WAY. `error.server` — the daemon's own body,
// verbatim — existed only here, because astrolabe's and magpie's copies keep the
// HTTP status and discard what the daemon said. It is now part of the kit's
// `ErrExtra`, so the shared contract got WIDER by adopting glamour rather than
// glamour getting narrower to fit it. See that module's note on the field.
//
// ⛔ AND THE ADOPTION REQUIRED THE D8 REACHABILITY AUDIT, WHICH WAS PERFORMED.
// A `die` REACHABLE from inside a `try` whose `catch` swallows is a silent
// continue, and the site that dies can be three frames below the site that looks
// safe. Audited by following the call graph, not by grepping: 12 `die` call
// sites, 25 further invocation edges of the ten functions that reach one
// transitively (`readSession`, `requireSession`, `resolveGenSrc`, `cmdOpen`,
// `cmdInfo`, `cmdState`, `cmdTail`, `postCmd`, `dispatch`, `main`, plus fifteen
// COMMANDS[].run closures), 37 audited positions, ZERO inside a `try`. The three
// swallowing catches in this file (`api`'s non-JSON body, `versionInfo`'s
// degrade-to-unknown, the tail's malformed-frame skip) have no die-reachable
// call inside them. The one to watch is flagged at `postCmd`.

/** `UsageError` is the name the tests and the older call sites know; a usage
 *  failure is a `CliError` of kind "usage". Kept as a subclass rather than
 *  inlined because `dispatch` branches on it to distinguish a PARSE rejection
 *  (which it reshapes with a path-scoped `choices`) from anything else, and
 *  `instanceof` is the only honest way to ask that. */
export class UsageError extends CliError {
  constructor(message: string, extra?: { hint?: string; choices?: string[] }) {
    super("usage", message, extra);
  }
}

export { CliError };

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
  die(`${what} failed (HTTP ${status})`, kind, {
    ...(data !== null && data !== undefined ? { server: data } : {}),
  });
}

const NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session
    ? join(tmpdir(), `glamour-${session}.json`)
    : join(tmpdir(), "glamour-latest.json");
}

/** ⛔ NULL MEANS "NO SESSION", AND NOTHING ELSE.
 *
 *  This used to `catch { return null }` over the whole read, so EVERY failure —
 *  a corrupt pointer, EACCES, and any transient the OS raises under load —
 *  arrived at the callers wearing absence's clothes. Three of them act on that:
 *  `requireSession` dies `not_found` (exit 5), `cmdInfo` the same, and the watch
 *  loop treats it as "the pinned session went away" and exits **0**. A resource
 *  failure was therefore reported as a SUCCESSFUL end of watch.
 *
 *  Measured consequence: `tests/cli-contract.test.ts`'s HTTP-400 row failed once
 *  under the full 146-file gate with exit **5** where the contract says 2, and
 *  passed alone and on re-run (filed 2026-09-07, digestify's Phase 0 baseline).
 *  5 is not a spawn crash — it is this function's `not_found`, which is why the
 *  cell could not tell "the contract broke" from "the machine was busy".
 *
 *  So: ENOENT is the only absence. Everything else throws and names itself. */
function readSession(session?: string): Session | null {
  const path = sessionFilePath(session);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // the one honest absence
    die(`cannot read the session pointer (${code ?? "unknown error"}): ${path}`, "internal");
  }
  try {
    return JSON.parse(raw) as Session;
  } catch {
    // The daemon writes this file atomically (server.ts), so a half-written
    // pointer is not reachable and unparseable content is real corruption.
    die(`the session pointer is not valid JSON: ${path}`, "internal");
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
/**
 * ── `gen`'s TWO ACCEPTED SETS (register A1) ─────────────────────────────────
 *
 * `GEN_SRC_FLAGS` is a DISJUNCTION — any one satisfies `resolveGenSrc`.
 * `GEN_REQUIRED_FLAGS` is a CONJUNCTION — all three must be present — and the
 * rejection below filters it, so its `choices` names the ones actually MISSING
 * rather than the whole roster. Both are derived at the site that enforces
 * them; neither is re-typed into a message.
 */
const GEN_SRC_FLAGS = ["url", "file", "src"] as const;
const GEN_REQUIRED_FLAGS = ["prompt", "model", "round"] as const;
/** `gen-meta`'s disjunction — either one satisfies it. */
const GEN_META_FLAGS = ["prompt", "custom"] as const;

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
  // ⛔ REGISTER A1 — THE DISJUNCTION IS `choices`, NOT A SENTENCE. Three flags
  // any ONE of which satisfies this is exactly a routing decision: the caller
  // (usually an agent) has to pick one, and picking from prose means parsing
  // prose. `GEN_SRC_FLAGS` is the set the branches above read, and
  // `cli.test.ts` binds the two so a fourth source cannot be added to one.
  die("gen: a source is required", "usage", {
    hint: `pass one of ${GEN_SRC_FLAGS.map((k) => `--${k}`).join(" ")}`,
    choices: GEN_SRC_FLAGS.map((k) => `--${k}`),
  });
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
    // ONLY a reset: a refused connection (stale pointer, daemon already gone)
    // is a transport failure like any other and rides the internal envelope —
    // the review found the old catch-all reporting {ok:true} against a dead port.
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    const message = err instanceof Error ? err.message : String(err);
    if (msg.type === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET"))) {
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
  // The user's project dir — captured here because the daemon spawns with a
  // pinned cwd (daemonCwd()), so it can't read the real cwd itself.
  daemonArgs.push("--project", process.cwd());

  // node:child_process (not Bun.spawn) is deliberate: the daemon must SURVIVE
  // this CLI process exiting, which needs `detached: true` + `unref()`.
  // Contract 5 — see daemonCwd(). And check the cwd EXISTS before spawning:
  // node reports a missing cwd as `ENOENT … posix_spawn 'bun'`, which names the
  // one thing that is fine. Measured by cassandra at a deps-free destination
  // with dist/index.html removed (comms #1265): a cold agent reads that and
  // reinstalls bun. Name the real absence instead.
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    die(
      `glamour cannot start its daemon: the working directory it needs is missing — ${cwd}`,
      "internal",
      {
        hint:
          "dev mode was resolved (no dist/index.html at the skill root and no SPELLBOOK_SURFACE_MODE=release), " +
          "so the daemon must run from src/glamour/, which a source-free install does not have. " +
          "Either the shipped dist/ is missing (reinstall the spell) or you are in a checkout without src/glamour/.",
      },
    );
  }
  const child = spawn("bun", daemonArgs, {
    cwd,
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

/**
 * The event tail — ONE CALL into the house's shared SSE client
 * (`src/kit/wire/tailEvents.ts`), where the reconnect loop, the spec-correct
 * frame parser, the backoff, the idle watchdog and the drained exit live once
 * for every spell.
 *
 * ⛔ **THIS IS WHERE CENSUS DEFECT B5 DIES BY CONSTRUCTION.** The loop this
 * replaces set `let delay = 250` (`cli.ts:623` before the port) and then reset
 * it to 250 on every SUCCESSFUL OPEN (`:667`) — so a daemon that accepts a
 * connection and immediately drops it was reconnected against at a CONSTANT
 * 250 ms, forever, with no growth: a reconnect storm that looks like a healthy
 * retry. Three sites did grow the delay (`:642`, `:659`, `:664`) and one did
 * not, which is precisely why a hand-written loop cannot be reasoned about from
 * one of its branches. **It cannot be re-expressed here, because there is no
 * loop left to put it in** — there is one backoff, it doubles on every failed
 * attempt, and Phase 1a's second door (the reset belongs at the FIRST BYTE, not
 * at a successful open) is closed by the same single implementation.
 *
 * ⛔ `resolve` RE-READS THE SESSION POINTER ON EVERY ATTEMPT, which is what
 * glamour's own loop did and what the shared client makes structural: the daemon
 * binds an ephemeral port, so a captured base is a tail that survives exactly one
 * daemon.
 *
 * ⛔ AND IT GAINED A WATCHDOG IT DID NOT HAVE. The old loop had none: it blocked
 * on `await reader.read()` forever, so a half-open socket after laptop sleep, a
 * NAT rebind or a SIGKILLed daemon parked the tail in silence with no way out.
 * `TAIL_IDLE_MS` is DERIVED from glamour's own heartbeat (`./heartbeat.ts`),
 * never copied from a sibling — astrolabe measured what a copied number costs.
 *
 * The pin, the grounding anchor and the "our session went away" exit are all
 * preserved verbatim: the FIRST resolved session is pinned for the life of the
 * watch, the grounding line names that binding once, and a pointer that
 * disappears AFTER we were bound ends the watch at 0 — a completed watch, not a
 * failure. A pointer that never appeared keeps retrying, which is what `tail`'s
 * own help promises ("waits for a session, never exits 5").
 */
async function cmdTail(session: string | undefined, sinceArg: number): Promise<number> {
  let boundId = session;
  let grounded = false;

  return await tailEvents<{ id?: number; type?: string }>({
    resolve: () => {
      // readSession dies on a CORRUPT pointer and returns null only for a
      // genuinely absent one — the ENOENT rule. That `die` now THROWS, and the
      // throw leaves the tail through main's funnel instead of exiting from three
      // frames down inside a reconnect loop. It is D8's audit paying for itself:
      // this is the one die-reachable call the shared client invokes on a schedule.
      const s = readSession(boundId);
      if (!s) return null;
      if (!boundId) boundId = s.session_id; // pin to the first session we resolved
      if (!grounded) {
        grounded = true;
        // grounding line — parseable in Monitor, names the binding so a wrong
        // session/port is obvious instead of silent.
        process.stdout.write(
          `${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}\n`,
        );
      }
      return `http://127.0.0.1:${s.port}`;
    },
    onUnresolved: ({ everResolved }) => {
      if (everResolved) return "stop"; // our pinned session went away → done
      process.stderr.write("# no session yet, retrying…\n");
      return "retry";
    },
    path: "/events",
    since: sinceArg,
    cursorOf: (ev) => ev.id,
    terminal: (ev) => ev.type === "closed",
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": glamour-keepalive",
  });
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
  // ⛔ A VERB MAY RETURN AN EXIT CODE, and exactly one does. `tail` is a WATCH:
  // it ends when the daemon says `closed`, when its pinned session goes away, or
  // when a signal arrives, and the shared client (`kit/wire/tailEvents.ts`)
  // RETURNS that code rather than calling `process.exit` from inside its own
  // loop — which is the whole of the P0f drain scar. `void` therefore has to mean
  // "0", not "no opinion": dispatch coerces below, so every other row is
  // unchanged and only the verb that has a code has to say so.
  run: (
    pos: string[],
    flags: Flags,
    session: string | undefined,
  ) => Promise<number | undefined> | number | undefined;
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
      // ⛔ `choices` NAMES WHAT IS MISSING, FILTERED FROM THE REQUIRED SET —
      // so the set the message asserts and the set the check enforces cannot
      // be two lists. `gen --prompt p --model m` answers `["--round"]`, which
      // is one repair rather than three to re-read.
      const missingGen = GEN_REQUIRED_FLAGS.filter((k) => !flags[k]).map((k) => `--${k}`);
      if (missingGen.length > 0)
        die(`usage: ${usageOf(findCommand("gen") as CommandSpec)}`, "usage", {
          hint: `missing required ${missingGen.join(" ")}`,
          choices: missingGen,
        });
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
      // A DISJUNCTION, so `choices` is the whole set rather than the missing
      // half: either one satisfies this, and the caller picks.
      if (!GEN_META_FLAGS.some((k) => flags[k] !== undefined))
        die(`usage: ${usageOf(findCommand("gen-meta") as CommandSpec)}`, "usage", {
          hint: `give one of ${GEN_META_FLAGS.map((k) => `--${k}`).join(" ")}`,
          choices: GEN_META_FLAGS.map((k) => `--${k}`),
        });
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

// The verb token in a raw argv, found the way the parser will find it: a
// string flag CONSUMES the next token (`--session abc say` → "say", not
// "abc"), `--key=value` consumes nothing, a bare `--` ends flag parsing, and
// the first token left standing is the verb. Used only to name the verb on a
// rejection raised BEFORE the parse succeeds (a stray flag) — the parse's own
// positionals are the truth afterwards. A naive "first non-dash token" was
// the review's finding: it named a flag's value as the verb.
export function verbToken(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return argv[i + 1] ?? null;
    if (a.startsWith("--")) {
      if (a.includes("=")) continue;
      const key = a.slice(2) as keyof typeof CLI_OPTIONS;
      if (key in CLI_OPTIONS && CLI_OPTIONS[key].type === "string") i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

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
    // The house funnel: `reportCliError` writes the envelope and hands back the
    // taxonomy exit code, or `null` when the throw was not a CliError.
    const reported = reportCliError(e);
    if (reported !== null) return reported;
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    // A named file that is not there (--file paths) — the caller's.
    if (code === "ENOENT") return reportCliError(new UsageError(msg)) ?? 2;
    // Everything else is glamour's own fault: one INTERNAL envelope, never a
    // stack trace — the process contract is JSON on stderr for EVERY failure.
    return reportCliError(new CliError("internal", msg)) ?? 1;
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
  // what was being run.
  // The verb, named BEFORE parsing, so a parser rejection's envelope still says
  // what was being run. It lives in the kit now — one module owns the envelope,
  // so it owns the field the envelope prints.
  let currentCommand = verbToken(argv);
  setCurrentCommand(currentCommand);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    // An unknown flag's rejection names the set AT THIS PATH, not the whole
    // registry: the verb's own flags when the verb is one of ours, the verb
    // roster when there is no verb yet (the root accepts no flags of its own).
    // This is what a recorded-surface census reads, path by path.
    const spec = currentCommand === null ? undefined : findCommand(currentCommand);
    if (spec !== undefined) {
      throw new UsageError(e.message, { hint: e.extra?.hint, choices: flagsFor(spec.name) });
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
  currentCommand = verb ?? null;
  setCurrentCommand(currentCommand);

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
  // `void` means 0 — a verb that completed and had nothing to say about the exit.
  // A number means the verb OWNS its code, which today is `tail` and only `tail`.
  const code = await spec.run(pos, flags, session);
  return typeof code === "number" ? code : 0;
}

/**
 * The CLI's entry, for the LAUNCHER at
 * `plugins/spellbook/skills/glamour/scripts/cli.ts`.
 *
 * ⛔ `import.meta.main` IS FALSE IN THE BUNDLE — `dist/cli.js` is IMPORTED by
 * the launcher, never executed as the process entry, so an `if (import.meta.main)`
 * block here would never run: the CLI would print nothing and exit 0 for every
 * verb. This export is what replaces it.
 *
 * ⛔ IT RETURNS THE CODE RATHER THAN SETTING IT. `process.exitCode` + a natural
 * return, NEVER `process.exit(code)`: Bun's stdout is ASYNCHRONOUS on a pipe
 * (synchronous on a TTY or file), so an explicit exit discards whatever has not
 * drained — measured at exactly 65,536 bytes. The payload is complete and only
 * the write is lost, so the caller gets well-formed-looking JSON that stops
 * mid-string. glamour's `state --full` ships base64 payloads far past that
 * boundary, so this is not theoretical here. Reproduced, fixed and gated in
 * bounty first (P0, #77/#78). The assignment happens once, in the launcher.
 *
 * ⛔ AND IT TAKES NO ARGUMENTS: the command line belongs to the file that PARSES
 * it. A launcher reading `process.argv` would match the arg-parsing predicate in
 * `grimoire/lib/entry-points.ts` and the flag ward would judge this spell's
 * documented flags against a file that recognises none.
 *
 * ⚠ UNLIKE THE DAEMON, THE SOURCE KEEPS NO SECOND ENTRY AND NEEDS NONE (D12):
 * `SCRIPT_DIR`'s consumers here are all ancestor-relative and correct from either
 * address, but the source has no `import.meta.main` block either, so there is one
 * entry and it is this one.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}

export { main };
