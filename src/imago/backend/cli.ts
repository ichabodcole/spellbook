#!/usr/bin/env bun

// imago CLI — thin wrapper around the per-session daemon's HTTP surface
// (server.ts). The agent drives a grounded image conversation through these
// verbs; `tail` streams user events as JSONL for Monitor to wrap.
//
// The verbs, their flags and their arity live in ONE table (`ROWS`, below) on
// the kit registry (`src/kit/cli/registry.ts`), which drives the parser, the
// rejections' `choices`, `help`, `--version` and `schema`. `help` prints it.
//
// All verbs target the most recent session by default; pass --session <id>
// (after the verb) to target a specific one.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandSpec, defineCli, type Invocation } from "../../kit/cli/registry.ts";
import { CliError, die, type ErrKind, reportCliError } from "../../kit/wire/errors.ts";
import {
  commandLine,
  readSince,
  tailCommand,
  tailWithHandoff,
  WINDOW_HELP,
} from "../../kit/wire/tailHandoff.ts";
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
 *  recon (docs/items/backend-duplication-recon/write-up.md).
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

// ── THE RECOGNIZED SET (#81 / D4), NOW THE KIT REGISTRY'S OPTIONS TABLE ──────
//
// The hand-rolled parser had no registry, so an unknown flag was accepted at
// exit 0 and the verb ran anyway, and free prose containing a `--word` was
// silently truncated at that word. The kit registry (`src/kit/cli/registry.ts`)
// parses strict against THIS table, per row: a flag imago does not know is
// refused as unknown, one it knows but this verb does not take as misplaced,
// and both rejections carry the verb's own accepted set as `choices`.
//
// Types are thoth's audited artifact, each settled by unambiguous evidence at
// every consumption site. Getting one wrong is not a no-op: a "string" that
// should be boolean SWALLOWS THE NEXT POSITIONAL, and a "boolean" that should
// be string breaks the space form.
//
// `kind` is STRING despite reading as `flags.kind === "edit"` — it is compared
// to a string literal, not tested for presence. Declaring it boolean there
// would make `--kind edit` push "edit" into positionals and the comparison
// would never match: a silent no-op, not a crash.
//
// ⚠ EXPORTED BY NAME AT THE FOOT OF THE FILE, NOT HERE. `export const … = {`
// followed by the `"edited-from": { type: "` key reads to the import scanner
// (`grimoire/lib/import-graph.ts`, STATIC_RE) as `export … from "…"`, a
// re-export of the module `: { type: `.
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
  once: { type: "boolean" },
  summary: { type: "string" },
  tag: { type: "string" },
  tags: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  clear: { type: "boolean" },
  full: { type: "boolean" },
  human: { type: "boolean" },
  "no-open": { type: "boolean" },
} as const;

type Flag = keyof typeof CLI_OPTIONS;
type Flags = Record<string, string | boolean>;

/**
 * `context <kind>`'s and `--link`'s accepted values — the two ENUMERATED types
 * in this CLI. Hoisted out of the `context` row so the rejection and the check
 * read one array (they were two copies: a `VALID_*` const for the test and the
 * same members re-typed into the message's prose).
 */
export const VALID_CONTEXT_KINDS = ["prompt", "style", "skill", "context"] as const;
export const VALID_CONTEXT_LINKS = ["active", "quickPrompts"] as const;

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

/** `--since` through the kit's one reader (`kit/wire/tailHandoff.ts`,
 *  `readSince`): a form this tail does not accept — an epoch bookmark from
 *  another spell's or version's handoff line — is refused with the accepted
 *  forms named, never misparsed. */
function sinceOrDie(token: string): number {
  const r = readSince(token, { epoch: false });
  if (!r.ok) die(r.message, "usage");
  return r.since;
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
 * instead of silent, and a pointer that
 * disappears AFTER we were bound ends the watch at 0 with a `tail.closed` line
 * naming the way back (`kit/wire/tailHandoff.ts`). A pointer that never
 * appeared keeps retrying on a FIRST arm; a re-arm (`--session` or `--since`)
 * that cannot find its session ends `tail.closed` at once (D1), because a
 * session named by a bookmark existed. A first arm's retry says
 * `# no session yet, retrying…` on stderr.
 */
async function cmdTail(
  session: string | undefined,
  sinceArg: number,
  o: { once: boolean; sinceGiven: boolean },
): Promise<number> {
  let boundId = session;
  const reArm = session !== undefined || o.sinceGiven;
  // A `--since` re-arm prints no grounding line (`kit/wire/tailHandoff.ts`, A3).
  let grounded = o.sinceGiven;
  const pin = () => (boundId !== undefined ? ["--session", boundId] : []);

  return await tailWithHandoff<{ id?: number; type?: string }>(
    {
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
        // D1: a tail given --session or a bookmark is re-arming an EXISTING
        // session, so not finding it means it closed (in the gap, say) — the
        // handoff says `tail.closed`, never a silent retry-forever.
        if (everResolved || reArm) return "stop";
        process.stderr.write("# no session yet, retrying…\n");
        return "retry";
      },
      path: "/events",
      since: sinceArg,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      idleMs: TAIL_IDLE_MS,
      onComment: () => ": imago-keepalive",
      // This daemon stamps no epoch, so the only way its log is seen to
      // restart is the kit's whole-replay net (`kit/wire/tailHandoff.ts`,
      // D2); it says so on stdout, like the spells that do stamp one.
      onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
    },
    {
      spell: "imago",
      mode: o.once ? "once" : "watch",
      presence: false,
      commands: {
        tail: ({ since, once }) => tailCommand(["tail", ...pin()], since, once),
        comeBack: () => commandLine(["open", "--restore", boundId ?? "<id>", "--no-open"]),
      },
    },
  );
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

/**
 * The saved, resumable sessions. JSON by default (decision #16: spell CLIs are
 * agent-facing), one document: `{sessions: [{id, title, batches, generations,
 * updatedAt}]}`, newest first. `--human` keeps the one-line-per-session prose.
 * A missing snapshots folder is an empty list, not an error.
 */
function cmdSessions(human: boolean) {
  let files: string[] = [];
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    /* no snapshots folder yet: no saved sessions */
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
  if (!human) {
    printJson({
      sessions: rows.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        batches: r.batches,
        generations: r.gens,
        updatedAt: new Date(r.mtime).toISOString(),
      })),
    });
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.batches} batches · ${r.gens} generations  — ${r.title}\n`);
  }
  if (!rows.length) process.stdout.write("no saved sessions\n");
}

// The plugin manifest is the one version source; the CLI reads it rather than
// mirroring the number (glamour's pattern, via astrolabe and mind-mapper).
// Layout-dependent, so absence degrades to "unknown" instead of inventing one.
function versionInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string") return { name: "imago", version: pkg.version };
  } catch {
    /* fall through to unknown */
  }
  return { name: "imago", version: "unknown" };
}

// ── THE COMMAND TABLE, ON THE KIT REGISTRY ───────────────────────────
//
// The dispatcher, the per-verb flag check, the rejections' `choices`, the help
// text, `--version` and the `schema` declaration all walk THIS, through the
// house's one registry (`src/kit/cli/registry.ts`). A verb added here is
// dispatched, listed in help and published by `schema` at once; there is no
// second list to forget.

type PositionalSpec = { name: string; required: boolean; variadic?: boolean };

/** A handler written against `(pos, flags, session)`. A returned number is the
 *  exit code (only `tail` has one: the signal that ended the watch). */
type Handler = (pos: string[], flags: Flags, session: string | undefined) => unknown;

/** Adapts a handler to the kit's `run(inv)`. imago declares no `multiple`
 *  flag, so every value is a string or a boolean. */
const on =
  (h: Handler) =>
  (inv: Invocation<Flag>): unknown => {
    const flags = inv.flags as Flags;
    return h(inv.pos, flags, typeof flags.session === "string" ? flags.session : undefined);
  };

/** The hint every flag rejection carries: the one repair for prose in which a
 *  word happens to start with `--`. */
const DASH_HINT = "for free text containing dashes, put it after a bare --";

const SESSION = ["session"] as const satisfies readonly Flag[];
const text = (name: string): PositionalSpec[] => [{ name, required: true, variadic: true }];
const NONE: PositionalSpec[] = [];

const ROWS: CommandSpec<Flag>[] = [
  {
    name: "open",
    flags: ["title", "no-open", "timeout", "restore"],
    positionals: NONE,
    describe: "spawn a session (opens the browser); prints the session JSON",
    run: on((_pos, flags) => cmdOpen(flags)),
  },
  {
    name: "tail",
    flags: [...SESSION, "since", "once"],
    positionals: NONE,
    describe: `SSE user events → JSONL (wrap with Monitor); ${WINDOW_HELP}`,
    run: on((_pos, flags, session) =>
      cmdTail(session, typeof flags.since === "string" ? sinceOrDie(flags.since) : -1, {
        once: flags.once === true,
        sinceGiven: typeof flags.since === "string",
      }),
    ),
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: NONE,
    describe: "lean state snapshot (--full for raw, incl. base64)",
    run: on((_pos, flags, session) => cmdState(session, flags.full === true)),
  },
  {
    name: "say",
    flags: SESSION,
    positionals: text("text"),
    describe: "post agent dialogue into the conversation",
    run: on((pos, _flags, session) => postCmd(session, { type: "say", text: pos.join(" ") })),
  },
  {
    name: "propose",
    flags: [...SESSION, "n"],
    positionals: text("prompt"),
    describe: "propose a prompt for the user to send (×N, ≤4)",
    run: on((pos, flags, session) => {
      const msg: Record<string, unknown> = { type: "propose", prompt: pos.join(" ") };
      if (typeof flags.n === "string") msg.n = parseInt(flags.n, 10);
      return postCmd(session, msg);
    }),
  },
  {
    name: "ask",
    flags: [...SESSION, "options"],
    positionals: text("text"),
    describe: 'ask the user a question, in-thread (--options "a|b|c")',
    run: on((pos, flags, session) => {
      const msg: Record<string, unknown> = { type: "ask", text: pos.join(" ") };
      if (typeof flags.options === "string") {
        msg.options = flags.options
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return postCmd(session, msg);
    }),
  },
  {
    name: "batch",
    flags: [...SESSION, "kind", "prompt", "tag", "edited-from", "summary", "models"],
    positionals: text("src"),
    describe:
      "add a produced batch; each src = http url, data: url, or file path (--kind generate|edit; --models m1,m2 labels each variant in order)",
    run: on(async (pos, flags, session) => {
      // optional per-variant model labels, comma-separated, positional to srcs
      const models =
        typeof flags.models === "string" ? flags.models.split(",").map((m) => m.trim()) : [];
      const variants: Array<Record<string, unknown>> = [];
      for (const [i, p] of pos.entries()) {
        const v: Record<string, unknown> = { src: await resolveSrc(p) };
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
      return postCmd(session, msg);
    }),
  },
  {
    name: "focus",
    flags: SESSION,
    positionals: [
      { name: "batchId", required: true },
      { name: "variantId", required: true },
    ],
    describe: "put an image on the canvas",
    run: on((pos, _flags, session) =>
      postCmd(session, { type: "focus", batchId: pos[0], variantId: pos[1] }),
    ),
  },
  {
    name: "select",
    flags: SESSION,
    positionals: [
      { name: "variantId", required: true },
      { name: "off", required: false },
    ],
    describe: "point a variant at the next gen as a reference (`off` releases it)",
    run: on((pos, _flags, session) =>
      postCmd(session, { type: "ref.select", id: pos[0], selected: pos[1] !== "off" }),
    ),
  },
  {
    name: "analyze",
    flags: SESSION,
    positionals: [{ name: "variantId", required: true }, ...text("text")],
    describe: "write your read onto an image (durable metadata)",
    // refs are variants now → one verb writes a read onto any image (incl.
    // migrated refs that kept their old "ref-…" id)
    run: on((pos, _flags, session) => {
      const [aid, ...words] = pos;
      return postCmd(session, { type: "variant.analyze", id: aid, text: words.join(" ") });
    }),
  },
  {
    name: "context",
    flags: [...SESSION, "content", "image", "link", "tags"],
    positionals: [{ name: "kind", required: true }, ...text("name")],
    describe:
      "add/upsert a Context Library entry (kind: prompt|style|skill|context; --link active|quickPrompts; --tags a,b,c)",
    run: on(async (pos, flags, session) => {
      type ContextKind = (typeof VALID_CONTEXT_KINDS)[number];
      const [kindArg, ...nameWords] = pos;
      if (!kindArg || !VALID_CONTEXT_KINDS.includes(kindArg as ContextKind)) {
        // ⛔ AN ENUMERATED POSITIONAL — the one class of positional that DOES
        // qualify for `choices`, because its accepted set is closed and in
        // hand. A free-text positional (a name, a prompt) has no such set and
        // gets none; see the ward's header for why that line is drawn here.
        die(`context: unknown kind "${kindArg}"`, "usage", {
          hint: "kind is the first positional",
          choices: [...VALID_CONTEXT_KINDS],
        });
      }
      if (
        typeof flags.link === "string" &&
        !VALID_CONTEXT_LINKS.includes(flags.link as (typeof VALID_CONTEXT_LINKS)[number])
      ) {
        // The set was already a const HERE and still went out as `join(", ")`
        // inside the sentence — the exact shape A1 names: told the human, never
        // the agent. Same array, now as data.
        die(`invalid --link '${flags.link}'`, "usage", { choices: [...VALID_CONTEXT_LINKS] });
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
      return postCmd(session, ctxMsg);
    }),
  },
  {
    name: "status",
    flags: SESSION,
    positionals: [
      { name: "on|off", required: false },
      { name: "text", required: false, variadic: true },
    ],
    describe: 'show (on [text...]) or hide (off) the "imago working" spinner',
    run: on((pos, _flags, session) =>
      postCmd(session, { type: "status", busy: pos[0] === "on", text: pos.slice(1).join(" ") }),
    ),
  },
  {
    name: "cost",
    flags: SESSION,
    positionals: text("text"),
    describe: 'cumulative spend display (e.g. "$0.38 · 8 imgs")',
    run: on((pos, _flags, session) => postCmd(session, { type: "cost", text: pos.join(" ") })),
  },
  {
    name: "handoff",
    flags: [...SESSION, "clear"],
    // ⚠ FLAG-DEPENDENT ARITY: `handoff <text...>` raises, `handoff --clear`
    // clears and takes no text. The declaration cannot say "required unless
    // --clear", so it can only mark <text> optional; `check` enforces the rest.
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "raise (<text...>) or clear (--clear) a terminal-ask escalation",
    check: (inv) => {
      const clear = inv.flags.clear === true;
      if (clear && inv.pos.length > 0) return "--clear takes no <text>";
      if (!clear && inv.pos.length === 0) return "missing required <text> (or pass --clear)";
      return undefined;
    },
    run: on((pos, flags, session) =>
      postCmd(session, { type: "handoff", text: flags.clear === true ? "" : pos.join(" ") }),
    ),
  },
  {
    name: "close",
    flags: SESSION,
    positionals: NONE,
    describe: "end the session",
    run: on((_pos, _flags, session) => postCmd(session, { type: "close" })),
  },
  {
    name: "info",
    flags: SESSION,
    positionals: NONE,
    describe: "print the session JSON",
    run: on((_pos, _flags, session) => cmdInfo(session)),
  },
  {
    name: "sessions",
    flags: ["human"],
    positionals: NONE,
    describe: "list saved (resumable) sessions as JSON (--human: one line each)",
    run: on((_pos, flags) => cmdSessions(flags.human === true)),
  },
];

// ⛔ BUILDING THE TABLE HAS NO SIDE EFFECTS. `defineCli` only validates and
// indexes; nothing is parsed, printed or read until `main` runs. So a grimoire
// ward, or a test, can import this module and read `cli.recognizedFlags`,
// `cli.flagsFor` and `cli.declaration()` without running the CLI.
export const cli = defineCli({
  name: "imago",
  summary: "a grounded image conversation.",
  options: CLI_OPTIONS,
  commands: ROWS.map((r) => ({ ...r, rejectHint: DASH_HINT })),
  // The verb is the first argument: `imago --session x say hi` is refused as an
  // unknown root flag. A bare `--` makes the next token the verb (acc A6).
  grammar: "verb-first",
  usageHides: ["session"],
  version: versionInfo,
  helpFooter: `  Add --session <id> after the verb to target a specific session (default:
  most recent). Each verb accepts only the flags on its row; a recognized flag
  on the wrong verb is refused, and the rejection lists the verb's own flags.

  Output: every verb prints JSON on stdout by default, one document per answer —
  except tail, a stream that prints one JSON line per event, sessions --human,
  and help, which are prose. Failures are one JSON envelope on stderr and exit
  non-zero (2 = usage, 1 = internal, 5 = not found, 6 = conflict).`,
});

// The derived views the tests read. VERBS is the roster (the module's own
// `version`, `schema` and `help` rows included).
export const VERBS: readonly string[] = cli.verbs;
export const RECOGNIZED_FLAGS: readonly string[] = cli.recognizedFlags;

/**
 * THE ONE PLACE A FAILURE BECOMES AN EXIT CODE.
 *
 * `die` THROWS (`src/kit/wire/errors.ts`), so every raise in this file — and
 * every raise in a helper reachable from it — arrives here, is written as ONE
 * JSON envelope on stderr, and becomes a taxonomy exit code. That is what lets
 * a failure three frames down stop truncating its own stdout: nothing exits
 * from inside a verb any more.
 *
 * `cli.dispatch`, not the registry's `main`, because imago triages one throw
 * the registry cannot know about: a caller-supplied path that is not there.
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
    return await cli.dispatch(argv);
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

export { CLI_OPTIONS, main };
