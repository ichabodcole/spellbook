/**
 * scriptorium CLI — the agent's half. A thin client of the per-session daemon
 * (`server.ts`): `open` spawns one, every other verb finds it through the
 * session pointer in tmpdir (E13) and speaks HTTP. `tail` streams the human's
 * messages as JSON lines for Monitor to wrap.
 *
 * ── THE EIGHT QUESTIONS (scaffolding playbook N1), ANSWERED AS DESIGN ──────
 *
 * 1. Arithmetic: NONE carried beyond what is true at the emitted address.
 *    From `dist/cli.js`, `..` is the skill folder, so the daemon launcher is
 *    `../scripts/server.ts` (up and back down — never a flat sibling), and the
 *    dev cwd is `src/scriptorium/` five levels up (Contract 5), used only when
 *    dev mode is resolved.
 * 2. Serves: no.
 * 3. Second half: YES — shares `./heartbeat.ts` with the daemon (the tail
 *    watchdog is derived from the daemon's heartbeat, never copied).
 * 4. Lifecycle: single-shot per verb; `tail` is long-running and returns its
 *    own exit code.
 * 5. `main()` returns while the process must live? NO → NATURAL-RETURN
 *    launcher (`process.exitCode = await run()`): stdout is a pipe the agent
 *    parses, and an explicit exit truncates it at 64 KiB. `open` releases the
 *    daemon's stdout pipe so the natural return is not held open by it.
 * 6. Event ids across restart: the daemon's are per-boot and epoch-stamped;
 *    this side resets its cursor on an epoch change and says so in one line.
 * 7. A kit subject in a different shape? No.
 * 8. A kit module names this spell as its source? Structurally no.
 *
 * ── ERROR CONTRACT (acc L0, `src/kit/wire/errors.ts`) ─────────────────────
 *
 * Every failure is ONE JSON envelope on stderr, stdout empty —
 *   {ok:false, error:{kind, exit_code, retryable, message, hint?, choices?, server?}, meta:{command}}
 *   usage → 2 · internal → 1 · not_found → 5 · conflict → 6
 * A daemon refusal maps off its HTTP status (400 usage, 404 not_found, 409
 * conflict, else internal); the daemon's body rides verbatim under
 * `error.server`, and when the daemon named the valid set (a doc slug, a
 * version) that set is ALSO lifted into `choices` — A1: the set is in hand at
 * the raise, because the daemon handed it over.
 *
 * ⛔ The kit carries the ENVELOPE, not the CLASSIFIER: `reportCliError`
 * returns null for a non-CliError, and `main` below triages ENOENT (a named
 * file the caller gave) into usage and everything else into internal.
 *
 * D8 reachability, audited by call graph: every `die` here is reached from a
 * verb handler or `dispatch`, none from inside a swallowing `catch`. The
 * swallowing catches (`api`'s non-JSON body, `versionInfo`, `postCmd`'s close
 * ECONNRESET) contain no die-reachable call.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { printJson } from "../../kit/lib/printJson";
import {
  CliError,
  die,
  type ErrKind,
  reportCliError,
  setCurrentCommand,
} from "../../kit/wire/errors";
import { tailEvents } from "../../kit/wire/tailEvents";
import { TAIL_IDLE_MS } from "./heartbeat";
import { DOC_EXTENSIONS, isDocName } from "./tree";

// ⚠ DECLARED FIRST, ABOVE EVERY OTHER FUNCTION, ON PURPOSE. The `choices`
// census's raiser rule (a) (`grimoire/lib/error-sites.ts`) matches
// `function NAME(` lazily up to the next `): never` within 600 characters, so
// ANY function declared shortly above this one — `api`, then `requireSession` —
// was read as a raiser and its calls counted as raise sites (found 2026-09-11,
// reported in the slice-A journal as an instrument defect, not fixed here).
function daemonRefused(what: string, status: number, data: unknown): never {
  const kind: ErrKind =
    status === 400
      ? "usage"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : "internal";
  const body = (data ?? {}) as { error?: unknown; choices?: unknown };
  const choices = Array.isArray(body.choices) ? body.choices.map(String) : undefined;
  die(typeof body.error === "string" ? body.error : `${what} failed (HTTP ${status})`, kind, {
    ...(choices ? { choices } : {}),
    ...(data !== null && data !== undefined ? { server: data } : {}),
  });
}

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
const SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "scriptorium");

/** Contract 5: a dev daemon must run with cwd at `src/scriptorium/` (bunfig.toml). */
export function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}

/** `$SCRIPTORIUM_HOME`, default `~/.scriptorium` — the same rule as the daemon's. */
function scriptoriumHome(): string {
  return resolve(process.env.SCRIPTORIUM_HOME ?? join(homedir(), ".scriptorium"));
}

type SessionPointer = { url: string; port: number; session_id: string; home: string; dir: string };

const NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };

function sessionFilePath(session?: string): string {
  return join(tmpdir(), session ? `scriptorium-${session}.json` : "scriptorium-latest.json");
}

/** NULL MEANS "NO SESSION", AND NOTHING ELSE — ENOENT is the only absence. */
function readSession(session?: string): SessionPointer | null {
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
    return JSON.parse(raw) as SessionPointer;
  } catch {
    die(`the session pointer is not valid JSON: ${path}`, "internal");
  }
}

function requireSession(session?: string): SessionPointer {
  const s = readSession(session);
  if (!s) die("no running scriptorium session", "not_found", NO_SESSION_HINT);
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

async function postCmd(session: string | undefined, msg: Record<string, unknown>) {
  const s = requireSession(session);
  let status: number;
  let data: unknown;
  try {
    ({ status, data } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    // `close` stops the server; a RESET is its success. A refused connection
    // (a stale pointer) is a transport failure like any other.
    const message = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (msg.type === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET")))
      return { ok: true };
    throw err;
  }
  if (status !== 200) daemonRefused(String(msg.type), status, data);
  return data as Record<string, unknown>;
}

// ── the parser ─────────────────────────────────────────────────────────

const CLI_OPTIONS = {
  "body-file": { type: "string" },
  doc: { type: "string" },
  from: { type: "string" },
  full: { type: "boolean" },
  into: { type: "string" },
  label: { type: "string" },
  "no-open": { type: "boolean" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  "start-timeout": { type: "string" },
  stdin: { type: "boolean" },
  timeout: { type: "string" },
} as const;

export const RECOGNIZED_FLAGS = Object.keys(CLI_OPTIONS).map((k) => `--${k}`);

export class UsageError extends CliError {
  constructor(message: string, extra?: { hint?: string; choices?: string[] }) {
    super("usage", message, extra);
  }
}

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
    const code = (e as { code?: string }).code;
    // Only an UNKNOWN option names the flag roster; the other parse failures
    // mean a recognised flag was misused, and the roster would name the half
    // that was right.
    throw new UsageError(detail, {
      hint: "for free text containing dashes, put it after a bare --",
      ...(code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? { choices: RECOGNIZED_FLAGS } : {}),
    });
  }
}

/**
 * `--since` is an event id: an integer, -1 for "everything". Verify-pass fix
 * 9: `--since abc` parsed to NaN, which the log reads as "from the start", so
 * a typo replayed the whole buffer into the agent's pipe at exit 0.
 */
export function parseSince(token: string): number {
  if (!/^-?\d+$/.test(token.trim()))
    die(
      `--since: "${token}" is not an event id — give an integer (the id of the last line you saw)`,
      "usage",
    );
  return Number.parseInt(token, 10);
}

/** `v2` or `2` → 2. A version number is an open set, so the rejection carries a hint, not choices. */
export function parseVersion(token: string, what: string): number {
  const m = /^v?(\d+)$/.exec(token.trim());
  if (!m || Number(m[1]) < 1)
    die(`${what}: "${token}" is not a version — write v1, v2, …`, "usage", {
      hint: "run: cli.ts state (each doc lists its versions)",
    });
  return Number(m[1]);
}

// ── verbs ──────────────────────────────────────────────────────────────

/**
 * ⛔ VERIFY-PASS FIX 5: every path is checked HERE, before any daemon exists.
 * `open doc.md pic.png` used to spawn a session, then fail on the second path
 * inside it — leaving a running daemon and a live pointer behind a failed
 * command. A folder or a document is accepted; a missing path is not_found, a
 * non-document file is usage with the accepted extensions as `choices`.
 */
function contextPaths(pos: string[]): string[] {
  const paths = pos.map((p) => resolve(p));
  for (const p of paths) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      die(`no such file or folder: ${p}`, "not_found");
    }
    if (!st.isDirectory() && !isDocName(p))
      die(`not a document scriptorium opens: ${p}`, "usage", {
        hint: "add a folder, or a file with one of these extensions",
        choices: [...DOC_EXTENSIONS],
      });
  }
  return paths;
}

/**
 * `--doc` as the CLI's caller meant it (verify-pass fix 8): a token with a path
 * separator, or one naming a file in THIS process's cwd, is resolved here to an
 * absolute path — the daemon's cwd is not the caller's. Anything else (a slug,
 * a unique file name) goes as typed.
 */
export function docArg(token: string): string {
  if (token.includes("/") || existsSync(resolve(token))) return resolve(token);
  return token;
}

/** Keep the newest `LOG_KEEP - 1` daemon logs, so the one about to be written makes `LOG_KEEP`. */
const LOG_KEEP = 10;
function pruneLogs(logDir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(logDir).filter((n) => /^daemon-\d+-\d+\.log$/.test(n));
  } catch {
    return;
  }
  const byAge = names.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  for (const n of byAge.slice(0, Math.max(0, byAge.length - (LOG_KEEP - 1)))) {
    try {
      unlinkSync(join(logDir, n));
    } catch {
      /* already gone */
    }
  }
}

async function cmdOpen(pos: string[], flags: Record<string, string | boolean>) {
  const paths = contextPaths(pos);

  if (typeof flags.restore === "string") {
    const home = scriptoriumHome();
    const manifest = join(home, "sessions", flags.restore, "manifest.json");
    if (!existsSync(manifest)) {
      let saved: string[] = [];
      try {
        saved = (
          await Array.fromAsync(new Bun.Glob("*/manifest.json").scan(join(home, "sessions")))
        ).map((p) => p.split("/")[0] as string);
      } catch {
        /* no sessions folder: the set is empty, and says so */
      }
      die(`no saved session "${flags.restore}" under ${home}`, "not_found", {
        choices: saved.sort(),
        ...(saved.length === 0 ? { hint: "no saved sessions in this home" } : {}),
      });
    }
    const live = readSession(flags.restore);
    if (live) {
      const alive = await api(live.port, "GET", "/state").then(
        (r) => r.status === 200,
        () => false,
      );
      if (alive)
        die(`session ${flags.restore} is already running at ${live.url}`, "conflict", {
          hint: `use it: cli.ts state --session ${flags.restore}`,
        });
    }
  }

  const daemonArgs = ["run", SERVER_SCRIPT];
  if (typeof flags.timeout === "string") daemonArgs.push("--timeout", flags.timeout);
  if (typeof flags.restore === "string") daemonArgs.push("--restore", flags.restore);
  // E23: a new session's workspace is where `open` ran. A restored one keeps its own.
  else daemonArgs.push("--workspace", process.cwd());

  const cwd = daemonCwd();
  if (!existsSync(cwd))
    die(
      `scriptorium cannot start its daemon: the working directory it needs is missing — ${cwd}`,
      "internal",
      {
        hint: "dev mode was resolved (no dist/index.html and no SPELLBOOK_SURFACE_MODE=release), which needs src/scriptorium/ — reinstall the spell or build it",
      },
    );
  // The daemon's stderr goes to a LOG FILE, not to this CLI's stderr. An
  // inherited stderr outlives the CLI inside the detached daemon, so any caller
  // that reads `open`'s stderr to EOF (a test harness, a tool runner) waits for
  // the whole session — measured: the integration cell hung at its 60 s timeout.
  // A file holds no pipe, and a start failure below quotes its tail.
  const logDir = join(scriptoriumHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  // Verify-pass fix 6: the logs used to pile up, one per `open`, forever.
  pruneLogs(logDir);
  const logPath = join(logDir, `daemon-${Date.now()}-${process.pid}.log`);
  daemonArgs.push("--log", logPath);
  const logFd = openSync(logPath, "a");
  const child = spawn("bun", daemonArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();

  const startTimeoutMs =
    typeof flags["start-timeout"] === "string"
      ? Math.max(5000, Number.parseInt(flags["start-timeout"], 10) * 1000)
      : 45000;
  const line = await new Promise<string>((res, rej) => {
    let buf = "";
    const timer = setTimeout(
      () =>
        rej(
          new Error(
            `daemon start timeout (${startTimeoutMs / 1000}s) — pass --start-timeout <seconds>`,
          ),
        ),
      startTimeoutMs,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        res(buf.slice(0, nl).trim());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`daemon exited with code ${code} before its handshake`));
    });
  }).catch((err: unknown) => {
    let tail = "";
    try {
      tail = readFileSync(logPath, "utf8").trim().slice(-800);
    } catch {
      /* no log written */
    }
    die(
      `scriptorium daemon failed to start: ${err instanceof Error ? err.message : String(err)}`,
      "internal",
      { hint: tail ? `daemon log (${logPath}): ${tail}` : `daemon log: ${logPath}` },
    );
  });

  // Release the daemon's stdout pipe, or this CLI's natural return waits on a
  // stream that never closes (glamour measured 91 s → 1 s). Checked for the
  // METHOD: under Bun this pipe is a plain Readable that nonetheless has unref.
  const out = child.stdout;
  if (!out || !("unref" in out) || typeof out.unref !== "function")
    throw new Error(
      "scriptorium: the daemon's stdout pipe has no unref(); `open` would never exit",
    );
  out.unref();

  let hs: {
    url: string;
    port: number;
    session_id: string;
    ok?: boolean;
    status?: number;
    error?: string;
  };
  try {
    hs = JSON.parse(line);
  } catch {
    die(`unexpected output from daemon: ${line}`, "internal");
  }
  if (hs.ok === false) daemonRefused("open", hs.status ?? 500, hs);

  let entries: unknown[] = [];
  if (paths.length > 0) {
    const r = await postCmd(hs.session_id, { type: "context.add", paths });
    entries = (r.entries as unknown[]) ?? [];
  }
  printJson({ ...hs, ...(paths.length > 0 ? { entries } : {}) });

  if (!flags["no-open"]) {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [hs.url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function cmdAdd(pos: string[], session: string | undefined) {
  const paths = contextPaths(pos);
  printJson(await postCmd(session, { type: "context.add", paths }));
}

async function cmdState(session: string | undefined, full: boolean) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "?full=1" : ""}`);
  if (status !== 200) daemonRefused("state", status, data);
  printJson(data);
}

async function readSayBody(
  pos: string[],
  flags: Record<string, string | boolean>,
): Promise<string> {
  const sources = [
    pos.length > 0,
    flags.stdin === true,
    typeof flags["body-file"] === "string",
  ].filter(Boolean).length;
  if (sources !== 1)
    die(
      sources === 0
        ? "say needs a message"
        : "say takes its message from exactly one place: arguments, --stdin or --body-file",
      "usage",
      {
        hint: "give the text as arguments, or prose through --body-file <path> / --stdin (never an unquoted heredoc)",
        choices: ["--stdin", "--body-file"],
      },
    );
  let text: string;
  if (flags.stdin === true) text = await new Response(Bun.stdin.stream()).text();
  else if (typeof flags["body-file"] === "string") text = readFileSync(flags["body-file"], "utf8");
  else text = pos.join(" ");
  if (!text.trim()) die("say: the message is empty", "usage");
  return text.trim();
}

async function cmdTail(session: string | undefined, since: number): Promise<number> {
  let boundId = session;
  let grounded = false;
  return await tailEvents<{ id?: number; epoch?: string; type?: string }>({
    resolve: () => {
      const s = readSession(boundId);
      if (!s) return null;
      if (!boundId) boundId = s.session_id;
      if (!grounded) {
        grounded = true;
        process.stdout.write(
          `${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}\n`,
        );
      }
      return `http://127.0.0.1:${s.port}`;
    },
    onUnresolved: ({ everResolved }) => {
      if (everResolved) return "stop";
      process.stderr.write("# no session yet, retrying…\n");
      return "retry";
    },
    path: "/events",
    since,
    cursorOf: (ev) => (typeof ev.id === "number" ? ev.id : undefined),
    epochOf: (ev) => (typeof ev.epoch === "string" ? ev.epoch : undefined),
    // A different epoch on reconnect = the daemon restarted; ids began again.
    onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
    terminal: (ev) => ev.type === "closed",
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": scriptorium-keepalive",
  });
}

function versionInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string") return { name: "scriptorium", version: pkg.version };
  } catch {
    /* fall through */
  }
  return { name: "scriptorium", version: "unknown" };
}

/**
 * E24's verbs: the agent's half of the structure ops the human reaches by menus
 * and drag and drop. Each resolves its paths against THIS process's cwd and
 * posts one op; the daemon does the change and announces it in the chat.
 */
async function structureCmd(session: string | undefined, op: Record<string, unknown>) {
  printJson(await postCmd(session, op));
}

/** `import <file>`: the file's TEXT is sent, so the daemon writes a copy (E23). */
async function cmdImport(file: string, into: string | undefined, session: string | undefined) {
  const abs = resolve(file);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    die(`no such file: ${abs}`, "not_found");
  }
  if (!st.isFile() || !isDocName(abs))
    die(`not a document scriptorium opens: ${abs}`, "usage", { choices: [...DOC_EXTENSIONS] });
  await structureCmd(session, {
    type: "import",
    name: abs.split("/").pop() as string,
    text: readFileSync(abs, "utf8"),
    ...(into !== undefined ? { into: resolve(into) } : {}),
  });
}

/** `workspace` alone prints it; `workspace <dir>` sets it. */
async function cmdWorkspace(dir: string | undefined, session: string | undefined) {
  if (dir !== undefined)
    return structureCmd(session, { type: "workspace.set", path: resolve(dir) });
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200) daemonRefused("workspace", status, data);
  printJson({ workspace: (data as { workspace?: unknown }).workspace });
}

// ── THE COMMAND TABLE — dispatch, help, `schema` and every `choices` walk it ──

type Flag = keyof typeof CLI_OPTIONS;
type Flags = Record<string, string | boolean>;
type PositionalSpec = { name: string; required: boolean; variadic?: boolean };
type CommandSpec = {
  name: string;
  flags: readonly Flag[];
  positionals: PositionalSpec[];
  describe: string;
  run: (
    pos: string[],
    flags: Flags,
    session: string | undefined,
  ) => Promise<number> | Promise<void> | void;
};

const SESSION = ["session"] as const satisfies readonly Flag[];

const COMMANDS: CommandSpec[] = [
  {
    name: "open",
    flags: ["no-open", "restore", "timeout", "start-timeout"],
    positionals: [{ name: "path", required: false, variadic: true }],
    describe: "spawn a session (opens the browser), adding paths; prints {url, port, session_id}",
    run: (pos, flags) => cmdOpen(pos, flags),
  },
  {
    name: "add",
    flags: SESSION,
    positionals: [{ name: "path", required: true, variadic: true }],
    describe: "add files or folders to the context list",
    run: (pos, _flags, session) => cmdAdd(pos, session),
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: [],
    describe: "the session: context, docs + versions (with paths), active, dirty, selection",
    run: (_pos, flags, session) => cmdState(session, flags.full === true),
  },
  {
    name: "tail",
    flags: [...SESSION, "since"],
    positionals: [],
    describe:
      "the human's messages (with selection + active path) as JSON lines — wrap with Monitor",
    run: (_pos, flags, session) =>
      cmdTail(session, typeof flags.since === "string" ? parseSince(flags.since) : -1),
  },
  {
    name: "version-new",
    flags: [...SESSION, "doc", "from", "label"],
    positionals: [],
    describe: "copy a version (default: the active one) to a new file; prints its path to edit",
    run: async (_pos, flags, session) => {
      const from = typeof flags.from === "string" ? parseVersion(flags.from, "--from") : undefined;
      printJson(
        await postCmd(session, {
          type: "version.new",
          ...(typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(typeof flags.label === "string" ? { label: flags.label } : {}),
        }),
      );
    },
  },
  {
    name: "say",
    flags: [...SESSION, "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "post a chat message from the agent (prose: --body-file <path> or --stdin)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, { type: "say", text: await readSayBody(pos, flags) }));
    },
  },
  {
    name: "activate",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "vN", required: true }],
    describe: "make a version the active one (the one the human edits and Save writes)",
    run: async (pos, flags, session) => {
      printJson(
        await postCmd(session, {
          type: "activate",
          version: parseVersion(pos[0] ?? "", "activate"),
          ...(typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}),
        }),
      );
    },
  },
  {
    name: "new-doc",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe:
      "create an empty document (its folder must be a set, a folder in one, or the workspace)",
    run: (pos, _flags, session) => {
      const abs = resolve(pos[0] as string);
      return structureCmd(session, { type: "doc.create", dir: dirname(abs), name: basename(abs) });
    },
  },
  {
    name: "new-folder",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "create a folder — inside a set, or in the workspace as a new set",
    run: (pos, _flags, session) => {
      const abs = resolve(pos[0] as string);
      return structureCmd(session, {
        type: "folder.create",
        dir: dirname(abs),
        name: basename(abs),
      });
    },
  },
  {
    name: "move",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "into", required: true },
    ],
    describe: "move a document or folder into another folder (a real move on disk)",
    run: (pos, _flags, session) =>
      structureCmd(session, {
        type: "move",
        path: resolve(pos[0] as string),
        into: resolve(pos[1] as string),
      }),
  },
  {
    name: "rename",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "name", required: true },
    ],
    describe: "rename a document or folder in place",
    run: (pos, _flags, session) =>
      structureCmd(session, { type: "rename", path: resolve(pos[0] as string), name: pos[1] }),
  },
  {
    name: "hide",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "remove a document, folder or set from Scriptorium — the files stay on disk",
    run: (pos, _flags, session) =>
      structureCmd(session, { type: "hide", path: resolve(pos[0] as string) }),
  },
  {
    name: "unhide",
    flags: SESSION,
    positionals: [{ name: "entry", required: true }],
    describe: "bring back everything hidden in a set (its entry id, from state)",
    run: (pos, _flags, session) => structureCmd(session, { type: "unhide", entry: pos[0] }),
  },
  {
    name: "make-set",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "turn a single document into a set: a folder named for it, the document moved in",
    run: (pos, _flags, session) =>
      structureCmd(session, { type: "set.make", path: resolve(pos[0] as string) }),
  },
  {
    name: "import",
    flags: [...SESSION, "into"],
    positionals: [{ name: "file", required: true }],
    describe: "copy a document in (default: into the workspace) and show the copy",
    run: (pos, flags, session) =>
      cmdImport(pos[0] as string, typeof flags.into === "string" ? flags.into : undefined, session),
  },
  {
    name: "workspace",
    flags: SESSION,
    positionals: [{ name: "dir", required: false }],
    describe: "print the workspace (where drops and new top-level documents land), or set it",
    run: (pos, _flags, session) => cmdWorkspace(pos[0], session),
  },
  {
    name: "info",
    flags: SESSION,
    positionals: [],
    describe: "print the resolved session pointer",
    run: (_pos, _flags, session) => {
      printJson(requireSession(session));
    },
  },
  {
    name: "close",
    flags: SESSION,
    positionals: [],
    describe: "shut the session down (the manifest stays, for open --restore)",
    run: async (_pos, _flags, session) => {
      await postCmd(session, { type: "close" });
      printJson({ ok: true, sent: "close" });
    },
  },
  {
    name: "schema",
    flags: [],
    positionals: [],
    describe: "emit this CLI's acc declaration (walked from the command table)",
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}\n`);
    },
  },
  {
    name: "help",
    flags: [],
    positionals: [],
    describe: "show this message",
    run: () => {
      process.stdout.write(`${renderHelp()}\n`);
    },
  },
];

const ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" },
] as const;

const findCommand = (token: string): CommandSpec | undefined =>
  COMMANDS.find((c) => c.name === token);

/** The verb in a raw argv, found the way the parser will (a string flag consumes its value). */
export function verbToken(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return argv[i + 1] ?? null;
    if (a.startsWith("--")) {
      if (a.includes("=")) continue;
      const key = a.slice(2) as Flag;
      if (key in CLI_OPTIONS && CLI_OPTIONS[key].type === "string") i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

export const VERBS: readonly string[] = COMMANDS.map((c) => c.name);
export const VERB_SPEC: Record<string, readonly Flag[]> = Object.fromEntries(
  COMMANDS.map((c) => [c.name, c.flags]),
);
export const flagsFor = (verb: string): string[] =>
  [...(findCommand(verb)?.flags ?? [])].map((k) => `--${k}`).sort();

const renderFlag = (k: Flag): string =>
  CLI_OPTIONS[k].type === "boolean" ? `[--${k}]` : `[--${k} ..]`;
const renderPositional = (p: PositionalSpec): string => {
  const inner = p.variadic ? `${p.name}...` : p.name;
  return p.required ? `<${inner}>` : `[${inner}]`;
};

export function usageOf(spec: CommandSpec): string {
  return [
    spec.name,
    ...spec.positionals.map(renderPositional),
    ...spec.flags.filter((k) => k !== "session").map(renderFlag),
  ].join(" ");
}

export function renderHelp(): string {
  const rows = COMMANDS.map((c) => [usageOf(c), c.describe] as const);
  const width = Math.min(Math.max(...rows.map(([u]) => u.length)), 44);
  const body = rows
    .map(([u, d]) =>
      u.length <= width ? `  ${u.padEnd(width)}  ${d}` : `  ${u}\n  ${"".padEnd(width)}  ${d}`,
    )
    .join("\n");
  return `scriptorium — a co-present markdown editor: the human edits, you write new versions.

${body}
  ${ROOT_INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON

  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row.

  Output: JSON on stdout, one document per answer — except tail (one JSON line
  per event) and help (prose). Failures: one JSON envelope on stderr, exit
  2 = usage, 1 = internal, 5 = not found, 6 = conflict. tail waits for a
  session rather than failing, and ends 0 when its session closes.`;
}

export function buildDeclaration() {
  const arg = (k: Flag) => ({ name: `--${k}`, type: CLI_OPTIONS[k].type, status: "valid" });
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands: [
      {
        path: [] as string[],
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
    ],
  };
}

async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (e) {
    const reported = reportCliError(e);
    if (reported !== null) return reported;
    // The kit does not triage; this does. A named file that is not there
    // (--body-file) is the caller's; everything else is ours.
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "ENOENT") return reportCliError(new UsageError(msg)) ?? 2;
    return reportCliError(new CliError("internal", msg)) ?? 1;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === argv[0]);
  if (interceptor !== undefined || argv[0] === "version") {
    if ((interceptor?.runs ?? "version") === "help") process.stdout.write(`${renderHelp()}\n`);
    else printJson(versionInfo());
    return 0;
  }

  let currentCommand = verbToken(argv);
  setCurrentCommand(currentCommand);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError) || e.extra?.choices === undefined) throw e;
    const spec = currentCommand === null ? undefined : findCommand(currentCommand);
    if (spec !== undefined)
      throw new UsageError(e.message, { hint: e.extra?.hint, choices: flagsFor(spec.name) });
    throw new UsageError(e.message, {
      hint: `no verb given — verbs: ${VERBS.join(" ")} (run: cli.ts help)`,
      choices: ROOT_INTERCEPTORS.map((i) => i.name),
    });
  }
  const [verb, ...pos] = parsed.pos;
  const flags = parsed.flags;
  currentCommand = verb ?? null;
  setCurrentCommand(currentCommand);

  if (verb === undefined)
    throw new UsageError("no verb given", { hint: "run: cli.ts help", choices: [...VERBS] });
  const spec = findCommand(verb);
  if (spec === undefined)
    throw new UsageError(`unknown verb "${verb}"`, {
      hint: "run: cli.ts help",
      choices: [...VERBS],
    });

  const allowed = new Set<string>(spec.flags);
  const stray = Object.keys(flags).find((k) => !allowed.has(k));
  if (stray !== undefined) {
    const accepted = flagsFor(spec.name);
    throw new UsageError(
      `--${stray} is not accepted by \`${spec.name}\` (it is a recognized scriptorium flag, just not this verb's)`,
      accepted.length > 0 ? { choices: accepted } : { hint: `${spec.name} takes no flags` },
    );
  }

  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (pos.length < required || (!variadic && pos.length > spec.positionals.length))
    throw new UsageError(`usage: ${usageOf(spec)}`, { hint: spec.describe });

  const session = typeof flags.session === "string" ? flags.session : undefined;
  const code = await spec.run(pos, flags, session);
  return typeof code === "number" ? code : 0;
}

/**
 * The CLI's entry, for the LAUNCHER. Returns the code rather than exiting
 * (stdout is a pipe; an explicit exit truncates it), and takes no arguments
 * (the command line belongs to the file that parses it).
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}

export { main };
