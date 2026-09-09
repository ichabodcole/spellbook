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
//   bun cli.ts context <kind> <name...> [--content "<text>"] [--image <path|url>]
//                    [--link active|quickPrompts] [--tags a,b,c]
//                    # add/upsert a Context Library entry (kind: prompt|style|skill|context)
//   bun cli.ts status on [text...] | status off               # the working spinner
//   bun cli.ts cost <text...>                                  # cumulative spend display
//   bun cli.ts handoff <text...> | handoff --clear            # escalate to a terminal ask
//   bun cli.ts close | info | sessions | help
//
// All verbs target the most recent session by default; pass --session <id>
// to target a specific one.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  CliError,
  die,
  type ErrKind,
  reportCliError,
  setCurrentCommand,
} from "../../kit/wire/errors.ts";
import { tailEvents } from "../../kit/wire/tailEvents.ts";
import { TAIL_IDLE_MS } from "./heartbeat.ts";

// ⛔ EVERY PATH BELOW IS RESOLVED FROM THE EMITTED BUNDLE, NEVER FROM THIS FILE.
// This module is authored here and SHIPS BUILT at
// `plugins/spellbook/skills/imago/dist/cli.js`, imported by the launcher at
// `../scripts/cli.ts` (backend convergence Phase 3; seams Contract 4's
// built-backend amendment). `import.meta.url` therefore names `dist/cli.js`,
// so `SCRIPT_DIR` is `<skill>/dist/` and `SKILL_ROOT` is the skill root — which
// is what the two lines below already meant from `scripts/`, unchanged, because
// `dist/` sits at the same depth as the `scripts/` it replaced. ⚠ THAT IS A
// COINCIDENCE OF DEPTH, NOT A PROPERTY: `release-serve.test.ts` asserts it
// rather than trusting it.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
// ⛔ UP AND BACK DOWN, NEVER `join(SCRIPT_DIR, "server.ts")`. The daemon is
// spawned by PATH, and the path is the LAUNCHER at `<skill>/scripts/server.ts`
// — a real `.ts` file that imports `../dist/server.js`. The sibling spelling
// this line used to carry was correct only while the CLI itself lived in
// `scripts/`; from `dist/` it resolves to `dist/server.ts`, a file that does
// not and must not exist, and the symptom is not a crash — `open` waits out its
// start deadline and reports a timeout, which reads like a slow first build.
// glamour shipped exactly that defect in Phase 2 (playbook B4).
// `grimoire/spawn-path-ward.test.ts` is the instrument that catches a
// regression here; confirm its coverage row names imago with a non-zero pin
// count, because a ward whose population is derived is not thereby COVERED.
const SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
// dev: the daemon serves a Bun-bundled React surface, and Bun reads bunfig.toml
// (the Tailwind plugin) from cwd ONLY, so the daemon's cwd MUST be src/imago/
// (seams Contract 5 cwd-pin) — launched anywhere else the dev bundler cannot
// compile the stylesheet (measured on glamour: the PAGE 500s with no stylesheet
// link; not "unstyled at 200" — that sentence was never run; imago's own failure
// shape is unmeasured). release: dist/ is pre-built and
// static — no bunfig read, so this path need not exist at all (a source-free
// marketplace clone has no top-level src/), and pinning cwd there anyway would
// break the spawn.
// ⚠ The five `..` are counted from `<skill>/dist/`, which is where this line
// EXECUTES — not from `src/imago/backend/`, where it is written. Read as an
// ordinary relative path of the file it sits in it would climb out of the repo.
// It is the same string as before the relocation only because `dist/` and
// `scripts/` sit at the same depth (D11's coincidence-of-depth, again).
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "imago");

function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
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
  /** The daemon's resolved surface mode (Contract 1). Additive-optional: a
   *  session file written by an older daemon has no `mode`, and absent means
   *  "unknown", never "dev". */
  mode?: "dev" | "release";
};

/**
 * ⛔ `die` IS NOW THE HOUSE'S (`src/kit/wire/errors.ts`) AND IT THROWS RATHER
 * THAN EXITS — and for imago that is a CALLER-VISIBLE CHANGE, stated here
 * rather than absorbed. The function this replaces wrote `imago: <msg>` to
 * stderr as PROSE and exited **2 for every failure**: a missing session, an
 * unreachable daemon, a bad flag and an internal fault were one number. A
 * failure now emits ONE JSON envelope on stderr and the exit code comes from
 * the taxonomy — usage 2, internal 1, not_found 5, conflict 6 — so an agent can
 * route on `kind` instead of matching prose. See decision D38.
 *
 * The THROW is the other half, and it is why B9's audit had to be run: Bun's
 * stdout is asynchronous on a pipe, so an exit from three frames down discards
 * whatever has not drained. Every failure now leaves through `main`'s funnel.
 *
 * ⚠ A `die` REACHABLE from inside a `try` whose `catch` SWALLOWS is a silent
 * continue rather than an exit. Audited by call graph, not by grep — the count
 * and the classification are in the phase 3 journal.
 */
const NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };

/** A refusal from imago's own daemon, carried VERBATIM under `error.server` so
 *  a caller can branch on what the other side actually said rather than on this
 *  CLI's prose about it. The status→kind map is the house's. */
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session ? join(tmpdir(), `imago-${session}.json`) : join(tmpdir(), "imago-latest.json");
}

/** ⛔ NULL MEANS "NO SESSION", AND NOTHING ELSE.
 *
 *  This caught every error from the read and returned null, so a corrupt
 *  pointer, an EACCES, and any transient the OS raises under load all arrived
 *  at the callers wearing absence's clothes — and the callers act on absence:
 *  they report "no running session", and a tail loop reads it as "the pinned
 *  session went away" and exits 0. A resource failure was therefore reported
 *  as a SUCCESSFUL end of watch.
 *
 *  Measured in glamour, whose copy of this function is byte-identical: its CLI
 *  contract cell failed once under the full gate with the not_found exit where
 *  the contract said usage, and passed alone and on re-run. Fixed there
 *  2026-09-07; found still standing here 2026-09-08 by the backend duplication
 *  recon (docs/investigations/2026-09-08-backend-duplication-recon.md).
 *
 *  ENOENT is the only honest absence. Everything else says what it was.
 *
 *  ⚠ The daemon writes this file atomically (server.ts), which is what lets
 *  unparseable content count as corruption rather than a half-written read. */
function readSession(session?: string): Session | null {
  const path = sessionFilePath(session);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    die(`cannot read the session pointer (${code ?? "unknown error"}): ${path}`, "internal");
  }
  try {
    return JSON.parse(raw) as Session;
  } catch {
    die(`the session pointer is not valid JSON: ${path}`, "internal");
  }
}

function requireSession(session?: string): Session {
  const s = readSession(session);
  if (!s) die("no running imago session", "not_found", NO_SESSION_HINT);
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
// #81 / D4 — THE RECOGNIZED SET, AT PARSER ALTITUDE.
//
// The hand-rolled parser had no registry, so an unknown flag was accepted at
// exit 0 and the verb ran anyway, and free prose containing a `--word` was
// silently truncated at that word. `node:util` strict supplies rejection, the
// `=` form and the `--` terminator from the standard library.
//
// Types are thoth's audited artifact (17 string · 3 boolean), each settled by
// unambiguous evidence at every consumption site. Getting one wrong is not a
// no-op: a "string" that should be boolean SWALLOWS THE NEXT POSITIONAL, and a
// "boolean" that should be string breaks the space form.//
// `kind` is STRING despite reading as `flags.kind === "edit"` — it is compared
// to a string literal, not tested for presence. Declaring it boolean there
// would make `--kind edit` push "edit" into positionals and the comparison
// would never match: a silent no-op, not a crash.
const CLI_OPTIONS = {
  content: { type: "string" },
  "edited-from": { type: "string" },
  image: { type: "string" },
  kind: { type: "string" },
  link: { type: "string" },
  models: { type: "string" },
  n: { type: "string" },
  options: { type: "string" },
  prompt: { type: "string" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  summary: { type: "string" },
  tag: { type: "string" },
  tags: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  clear: { type: "boolean" },
  full: { type: "boolean" },
  "no-open": { type: "boolean" },
} as const;

class UsageError extends Error {}

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
        `  for free text containing dashes, use --stdin, or put it after a bare --`,
    );
  }
}

async function postCmd(session: string | undefined, msg: Record<string, unknown>) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "POST", "/cmd", msg);
  if (status !== 200) daemonRefused("cmd", status, data);
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
  // node:child_process (not Bun.spawn) is deliberate + matches grapevine/bounty:
  // the daemon must SURVIVE this CLI process exiting, which needs `detached: true`
  // + `unref()`. Bun.spawn can't detach a surviving daemon — so the house pattern
  // for spawning a standing daemon is node's spawn. (CLAUDE.md's Bun-spawn pref
  // applies to in-process child commands, not detached daemons.)
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    // Contract 5 — see daemonCwd(). A wrong cwd skips bunfig.toml's Tailwind
    // plugin; on glamour that fails the page outright (500). Assert the invariant,
    // not the status: the utility never reaches the browser when cwd is wrong.
    cwd: daemonCwd(),
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
  die("imago server failed to start within 5s", "internal", {
    hint: "the daemon writes its discovery pointer once it has bound; check for a stale $TMPDIR/imago-latest.json",
  });
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
 * ⛔ **THE HAND-ROLLED LOOP THIS REPLACES HAD THE CONSTANT-BACKOFF DEFECT, AND
 * IMAGO'S COPY WAS WORSE THAN THE ONE GLAMOUR PAID FOR.** It set `delay = 250`,
 * doubled it on three failure branches — and RESET IT TO 250 on every successful
 * OPEN, before reading a byte. A daemon that accepts a connection and
 * immediately drops it was therefore reconnected against at a constant 250 ms,
 * forever, with no growth: a reconnect storm that reads as a healthy retry.
 * ⚠ AND IMAGO HAD A FOURTH SITE THE OTHERS DID NOT — `await sleep(delay)` at the
 * BOTTOM of the outer loop, after the stream ended, using whatever `delay` the
 * successful open had just reset. It cannot be re-expressed here, because there
 * is no loop left to put it in.
 *
 * ⛔ AND IT GAINED A WATCHDOG IT DID NOT HAVE. The old loop blocked on
 * `await reader.read()` forever, so a half-open socket after laptop sleep, a NAT
 * rebind or a SIGKILLed daemon parked the tail in silence with no way out.
 * `TAIL_IDLE_MS` is DERIVED from imago's own heartbeat (`./heartbeat.ts`), never
 * copied from a sibling.
 *
 * ⛔ `resolve` RE-READS THE SESSION POINTER ON EVERY ATTEMPT — which the old
 * loop did too, and which the shared client makes structural: the daemon binds
 * an ephemeral port, so a captured base is a tail that survives one daemon.
 *
 * PRESERVED VERBATIM, because they are imago's own contract and not the shared
 * client's: the FIRST resolved session is pinned for the life of the watch, the
 * grounding line names that binding once so a wrong session/port is obvious
 * instead of silent, a pointer that disappears AFTER we were bound ends the
 * watch at 0 (a completed watch, not a failure), and one that never appeared
 * keeps retrying with `# no session yet, retrying…` on stderr.
 */
async function cmdTail(session: string | undefined, sinceArg: number): Promise<number> {
  let boundId = session;
  let grounded = false;

  return await tailEvents<{ id?: number; type?: string }>({
    resolve: () => {
      // `readSession` dies on a CORRUPT pointer and returns null only for a
      // genuinely absent one — the ENOENT rule. That `die` now THROWS, and the
      // throw leaves the tail through main's funnel instead of exiting from
      // three frames down inside a reconnect loop. It is B9's audit paying for
      // itself: this is the one die-reachable call the shared client invokes on
      // a schedule.
      const s = readSession(boundId);
      if (!s) return null;
      if (!boundId) boundId = s.session_id; // pin to the first session we resolved
      if (!grounded) {
        grounded = true;
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
    onComment: () => ": imago-keepalive",
  });
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
  if (!res.ok) die(`fetch failed (HTTP ${res.status}): ${url}`, "usage");
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
  if (!s) die("no running imago session", "not_found", NO_SESSION_HINT);
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
  select <variantId> [off]           point a variant at the next gen as a reference (highlights it for the user)
  analyze <variantId> <text...>      write your read onto an image (durable metadata)
  context <kind> <name...> [--content "<text>"] [--image <path|url>] [--link active|quickPrompts] [--tags a,b,c]
                                     add/upsert a Context Library entry (kind: prompt|style|skill|context)
  status on [text...] | status off   show/hide the "imago working" spinner
  cost   <text...>                   cumulative spend display (e.g. "$0.38 · 8 imgs")
  handoff <text...> | handoff --clear   raise/clear a terminal-ask escalation
  close | info | help

  Add --session <id> to target a specific session (default: most recent).`;

async function dispatch(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  // Names the verb in every envelope's `meta.command`, so a caller reading a
  // failure knows which invocation produced it without correlating.
  setCurrentCommand(typeof verb === "string" ? verb : null);
  // A usage failure RETURNS rather than exiting, so the runtime drains stdout.
  let pos: string[];
  let flags: Record<string, string | boolean>;
  try {
    ({ pos, flags } = parseArgs(rest));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    // The parser's own error class, converted at the boundary into the house
    // envelope. `UsageError` stays because it carries the recognised-flag list
    // that `parseArgs` builds; what changed is that the message no longer goes
    // out as bare prose.
    die(e.message, "usage");
  }
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
      if (!pos.length) die("usage: select <variantId> [off]");
      await postCmd(session, { type: "ref.select", id: pos[0], selected: pos[1] !== "off" });
      break;
    case "analyze": {
      if (pos.length < 2) die("usage: analyze <image-id> <text...>");
      const [aid, ...words] = pos;
      // refs are variants now → one verb writes a read onto any image (incl.
      // migrated refs that kept their old "ref-…" id)
      await postCmd(session, { type: "variant.analyze", id: aid, text: words.join(" ") });
      break;
    }
    case "context": {
      const VALID_KINDS = ["prompt", "style", "skill", "context"] as const;
      type ContextKind = (typeof VALID_KINDS)[number];
      const VALID_LINKS = ["active", "quickPrompts"] as const;
      const [kindArg, ...nameWords] = pos;
      if (!kindArg || !VALID_KINDS.includes(kindArg as ContextKind)) {
        die(
          `usage: context <kind> <name...> [--content "<text>"] [--image <path|url>] [--link active|quickPrompts] [--tags a,b,c]\n` +
            `  kind must be one of: ${VALID_KINDS.join(", ")}`,
        );
      }
      if (!nameWords.length)
        die("usage: context <kind> <name...> — at least one name word required");
      if (
        typeof flags.link === "string" &&
        !VALID_LINKS.includes(flags.link as (typeof VALID_LINKS)[number])
      ) {
        die(`--link must be one of: ${VALID_LINKS.join(", ")}`);
      }
      const ctxMsg: Record<string, unknown> = {
        type: "context.add",
        kind: kindArg as ContextKind,
        name: nameWords.join(" "),
        content: typeof flags.content === "string" ? flags.content : "",
      };
      // a captured style carries a canonical example image (a variant path/url) →
      // inline it so it's self-contained, like batch srcs
      if (typeof flags.image === "string") ctxMsg.image = await resolveSrc(flags.image);
      if (typeof flags.tags === "string") {
        ctxMsg.tags = flags.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (typeof flags.link === "string") ctxMsg.link = flags.link;
      await postCmd(session, ctxMsg);
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

/**
 * THE ONE PLACE A FAILURE BECOMES AN EXIT CODE.
 *
 * `die` THROWS (`src/kit/wire/errors.ts`), so every raise in this file — and
 * every raise in a helper reachable from it — arrives here, is written as ONE
 * JSON envelope on stderr, and becomes a taxonomy exit code. That is what lets
 * a failure three frames down stop truncating its own stdout: nothing exits
 * from inside a verb any more.
 *
 * ⛔ A NON-`CliError` IS NOT SWALLOWED INTO THE TAXONOMY. `reportCliError`
 * returns `null` for a throw it does not recognise, and the branch below turns
 * it into an INTERNAL envelope rather than a stack trace — the process contract
 * is JSON on stderr for EVERY failure — but it does so knowingly, in one place,
 * instead of by a catch-all that would report an unexpected fault as a tidy
 * usage error.
 */
async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (e) {
    const reported = reportCliError(e);
    if (reported !== null) return reported;
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    // A named file that is not there — `batch <path>` and `context --image
    // <path>` both read caller-supplied paths, so ENOENT here is the caller's.
    if (code === "ENOENT") return reportCliError(new CliError("usage", msg)) ?? 2;
    return reportCliError(new CliError("internal", msg)) ?? 1;
  }
}

/**
 * The CLI's ONE entry, and it is the LAUNCHER's to call.
 *
 * ⛔ THERE IS NO `import.meta.main` BLOCK, AND THAT IS THE FIRST THING A
 * BUNDLE BREAKS. `dist/cli.js` is IMPORTED by `<skill>/scripts/cli.ts`, never
 * executed as the process entry, so `import.meta.main` is FALSE there and the
 * block that used to sit here would never run — the CLI would print nothing
 * and exit 0 for every verb, which reads like an empty result rather than a
 * dead binary (playbook B3).
 *
 * ⚠ THE DRAINED EXIT MOVED TO THE LAUNCHER, IT DID NOT GO AWAY. `run()` hands
 * back a code and the launcher assigns `process.exitCode`; it must NEVER be
 * tidied into `process.exit(code)`. Bun's stdout is ASYNCHRONOUS on a pipe
 * (synchronous on a TTY or file), so an explicit exit discards whatever has not
 * drained — measured at exactly 65,536 bytes, and imago ships large stdout
 * payloads (`state --full` inlines base64 images), so the caller would get
 * well-formed-LOOKING JSON that stops mid-string. Reproduced, fixed and gated
 * in bounty first (P0, #77/#78).
 *
 * `run()` takes NO ARGUMENTS: the command line belongs to the file that parses
 * it, which is this one. A forwarder that read `process.argv` itself would
 * match the roster enumerator's arg-parsing predicate and the flag ward would
 * then judge imago's documented flags against a file that recognises none.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}

export { main };
