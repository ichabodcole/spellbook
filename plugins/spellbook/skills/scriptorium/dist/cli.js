// @bun
// src/scriptorium/backend/cli.ts
import { spawn } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { parseArgs as nodeParseArgs } from "util";

// src/kit/lib/printJson.ts
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}

// src/kit/wire/errors.ts
var EXIT_FOR = {
  usage: 2,
  internal: 1,
  not_found: 5,
  conflict: 6
};
var currentCommand = null;
function setCurrentCommand(command) {
  currentCommand = command;
}
function errorEnvelope(kind, message, extra) {
  return `${JSON.stringify({
    ok: false,
    error: {
      kind,
      exit_code: EXIT_FOR[kind],
      retryable: false,
      message,
      ...extra?.hint ? { hint: extra.hint } : {},
      ...extra?.choices ? { choices: extra.choices } : {},
      ...extra?.server !== undefined ? { server: extra.server } : {}
    },
    meta: { command: currentCommand }
  })}
`;
}

class CliError extends Error {
  kind;
  extra;
  constructor(kind, message, extra) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    this.extra = extra;
  }
  get exitCode() {
    return EXIT_FOR[this.kind];
  }
}
function die(message, kind = "usage", extra) {
  throw new CliError(kind, message, extra);
}
function reportCliError(e, err = process.stderr) {
  if (!(e instanceof CliError))
    return null;
  err.write(errorEnvelope(e.kind, e.message, e.extra));
  return e.exitCode;
}

// src/kit/wire/tailEvents.ts
var DEFAULT_IDLE_MS = 45000;
var DEFAULT_RETRY = { initialMs: 250, maxMs: 5000 };
function parseSseFrame(block) {
  const comments = [];
  const dataLines = [];
  let event = "message";
  let sawData = false;
  for (const line of block.split(`
`)) {
    if (line === "")
      continue;
    if (line.startsWith(":")) {
      comments.push(line.slice(1));
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" "))
      value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
      sawData = true;
    } else if (field === "event") {
      event = value;
    }
  }
  if (!sawData)
    return { frame: null, comments };
  return { frame: { event, data: dataLines.join(`
`) }, comments };
}
async function tailEvents(opts) {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const cursorPolicy = opts.cursorPolicy ?? "monotonic";
  let cursor = opts.since;
  let epoch = null;
  let everResolved = false;
  let everConnected = false;
  let firstConnect = true;
  let delay = retry.initialMs;
  let code = 0;
  let stopped = false;
  let attempt = null;
  let wakeBackoff = null;
  const stop = (exitCode) => {
    stopped = true;
    code = exitCode;
    attempt?.abort();
    wakeBackoff?.();
  };
  const backoff = (ms) => new Promise((resolveSleep) => {
    if (stopped)
      return resolveSleep();
    const finish = () => {
      clearTimeout(timer);
      wakeBackoff = null;
      resolveSleep();
    };
    const timer = setTimeout(finish, ms);
    wakeBackoff = finish;
  });
  const onSignal = () => stop(0);
  const useSignals = opts.signals !== false;
  if (useSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  const onOutError = (e) => {
    if (e?.code === "EPIPE")
      stop(0);
  };
  const outEmitter = out;
  outEmitter.on?.("error", onOutError);
  const onCallerAbort = () => stop(0);
  opts.signal?.addEventListener("abort", onCallerAbort);
  if (opts.signal?.aborted)
    stop(0);
  const emit = (line) => {
    out.write(`${line}
`);
  };
  const note = (line) => {
    if (line !== null && line !== undefined)
      err.write(`${line}
`);
  };
  try {
    while (!stopped) {
      const base = await opts.resolve();
      if (base === null) {
        const verdict = opts.onUnresolved?.({ everResolved, everConnected }) ?? "retry";
        if (verdict === "stop")
          return code;
        await backoff(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      everResolved = true;
      const params = opts.query?.(cursor, firstConnect) ?? { since: String(cursor) };
      const qs = new URLSearchParams(params).toString();
      const url = `${base}${opts.path}${qs ? `?${qs}` : ""}`;
      attempt = new AbortController;
      const controller = attempt;
      let watchdog = null;
      const resetWatchdog = () => {
        if (idleMs <= 0)
          return;
        if (watchdog !== null)
          clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), idleMs);
      };
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } catch (e) {
        if (watchdog !== null)
          clearTimeout(watchdog);
        attempt = null;
        if (stopped)
          break;
        note(opts.onDisconnect?.({ cause: "connect-failed", error: e }));
        await backoff(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      try {
        if (!res.ok) {
          await opts.onHttpError?.(res);
          await res.body?.cancel().catch(() => {});
          note(opts.onDisconnect?.({ cause: "http", status: res.status }));
          await backoff(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        if (!res.body) {
          note(opts.onDisconnect?.({ cause: "no-body", status: res.status }));
          await backoff(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        everConnected = true;
        firstConnect = false;
        resetWatchdog();
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buf = "";
        while (!stopped) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (!stopped)
              note(opts.onDisconnect?.({ cause: "stream-error", error: e }));
            break;
          }
          if (chunk.done) {
            if (!stopped)
              note(opts.onDisconnect?.({ cause: "stream-end" }));
            break;
          }
          delay = retry.initialMs;
          resetWatchdog();
          buf += decoder.decode(chunk.value, { stream: true });
          for (let sep = buf.indexOf(`

`);sep >= 0; sep = buf.indexOf(`

`)) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const { frame, comments } = parseSseFrame(block);
            for (const text of comments)
              note(opts.onComment?.(text));
            if (!frame)
              continue;
            let ev;
            try {
              ev = JSON.parse(frame.data);
            } catch (e) {
              note(opts.onMalformed?.(frame, e));
              continue;
            }
            if (opts.epochOf) {
              const next = opts.epochOf(ev);
              if (typeof next === "string") {
                if (epoch !== null && next !== epoch) {
                  cursor = 0;
                  const line = opts.onEpochChange?.(next) ?? null;
                  if (line !== null)
                    emit(line);
                }
                epoch = next;
              }
            }
            const n = opts.cursorOf?.(ev);
            if (typeof n === "number" && Number.isFinite(n)) {
              cursor = cursorPolicy === "assign" ? n : Math.max(cursor, n);
            }
            const accepted = opts.accept?.(ev, frame) ?? true;
            const isTerminal = opts.terminal?.(ev) ?? false;
            if (accepted || isTerminal && opts.terminalEmitsFiltered === true) {
              const line = opts.render ? opts.render(ev, frame) : frame.data;
              if (line !== null)
                emit(line);
            }
            if (isTerminal)
              return code;
          }
        }
      } finally {
        if (watchdog !== null)
          clearTimeout(watchdog);
        attempt = null;
      }
      if (stopped)
        break;
      await backoff(delay);
      delay = Math.min(delay * 2, retry.maxMs);
    }
    return code;
  } finally {
    if (useSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    outEmitter.off?.("error", onOutError);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

// src/kit/wire/heartbeat.ts
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/scriptorium/backend/heartbeat.ts
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/scriptorium/backend/tree.ts
var DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];
function isDocName(name) {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
var SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "coverage"]);

// src/scriptorium/backend/cli.ts
function daemonRefused(what, status, data) {
  const kind = status === 400 ? "usage" : status === 404 ? "not_found" : status === 409 ? "conflict" : "internal";
  const body = data ?? {};
  const choices = Array.isArray(body.choices) ? body.choices.map(String) : undefined;
  die(typeof body.error === "string" ? body.error : `${what} failed (HTTP ${status})`, kind, {
    ...choices ? { choices } : {},
    ...data !== null && data !== undefined ? { server: data } : {}
  });
}
var SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "scriptorium");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
function scriptoriumHome() {
  return resolve(process.env.SCRIPTORIUM_HOME ?? join(homedir(), ".scriptorium"));
}
var NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };
function sessionFilePath(session) {
  return join(tmpdir(), session ? `scriptorium-${session}.json` : "scriptorium-latest.json");
}
function readSession(session) {
  const path = sessionFilePath(session);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT")
      return null;
    die(`cannot read the session pointer (${code ?? "unknown error"}): ${path}`, "internal");
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`the session pointer is not valid JSON: ${path}`, "internal");
  }
}
function requireSession(session) {
  const s = readSession(session);
  if (!s)
    die("no running scriptorium session", "not_found", NO_SESSION_HINT);
  return s;
}
async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
async function postCmd(session, msg) {
  const s = requireSession(session);
  let status;
  let data;
  try {
    ({ status, data } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (msg.type === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET")))
      return { ok: true };
    throw err;
  }
  if (status !== 200)
    daemonRefused(String(msg.type), status, data);
  return data;
}
var CLI_OPTIONS = {
  "body-file": { type: "string" },
  by: { type: "string" },
  context: { type: "string" },
  doc: { type: "string" },
  entry: { type: "string" },
  from: { type: "string" },
  full: { type: "boolean" },
  hunks: { type: "string" },
  into: { type: "string" },
  lifecycle: { type: "string" },
  label: { type: "string" },
  "no-open": { type: "boolean" },
  patch: { type: "boolean" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  "start-timeout": { type: "string" },
  status: { type: "string" },
  stdin: { type: "boolean" },
  tag: { type: "string" },
  timeout: { type: "string" },
  type: { type: "string" }
};
var RECOGNIZED_FLAGS = Object.keys(CLI_OPTIONS).map((k) => `--${k}`);

class UsageError extends CliError {
  constructor(message, extra) {
    super("usage", message, extra);
  }
}
function parseArgs(args) {
  try {
    const { values, positionals } = nodeParseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true
    });
    return { pos: positionals, flags: values };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const code = e.code;
    throw new UsageError(detail, {
      hint: "for free text containing dashes, put it after a bare --",
      ...code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? { choices: RECOGNIZED_FLAGS } : {}
    });
  }
}
function parseSince(token) {
  if (!/^-?\d+$/.test(token.trim()))
    die(`--since: "${token}" is not an event id \u2014 give an integer (the id of the last line you saw)`, "usage");
  return Number.parseInt(token, 10);
}
function parseSinceDate(token) {
  const t = token.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t)))
    die(`find --since: "${token}" is not a date \u2014 write it as YYYY-MM-DD`, "usage");
  return t;
}
function parseVersion(token, what) {
  const m = /^v?(\d+)$/.exec(token.trim());
  if (!m || Number(m[1]) < 1)
    die(`${what}: "${token}" is not a version \u2014 write v1, v2, \u2026`, "usage", {
      hint: "run: cli.ts state (each doc lists its versions)"
    });
  return Number(m[1]);
}
function parseCount(token, what) {
  const t = token.trim();
  if (!/^\d+$/.test(t))
    die(`${what}: "${token}" is not a whole number`, "usage");
  return Number(t);
}
function parseSide(token, what) {
  const t = token.trim().toLowerCase();
  if (t === "original" || t === "file")
    return "original";
  return parseVersion(token, what);
}
function contextPaths(pos) {
  const paths = pos.map((p) => resolve(p));
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      die(`no such file or folder: ${p}`, "not_found");
    }
    if (!st.isDirectory() && !isDocName(p))
      die(`not a document scriptorium opens: ${p}`, "usage", {
        hint: "add a folder, or a file with one of these extensions",
        choices: [...DOC_EXTENSIONS]
      });
  }
  return paths;
}
function docArg(token) {
  if (token.includes("/") || existsSync(resolve(token)))
    return resolve(token);
  return token;
}
var LOG_KEEP = 10;
function pruneLogs(logDir) {
  let names = [];
  try {
    names = readdirSync(logDir).filter((n) => /^daemon-\d+-\d+\.log$/.test(n));
  } catch {
    return;
  }
  const byAge = names.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  for (const n of byAge.slice(0, Math.max(0, byAge.length - (LOG_KEEP - 1)))) {
    try {
      unlinkSync(join(logDir, n));
    } catch {}
  }
}
async function cmdOpen(pos, flags) {
  const paths = contextPaths(pos);
  if (typeof flags.restore === "string") {
    const home = scriptoriumHome();
    const manifest = join(home, "sessions", flags.restore, "manifest.json");
    if (!existsSync(manifest)) {
      let saved = [];
      try {
        saved = (await Array.fromAsync(new Bun.Glob("*/manifest.json").scan(join(home, "sessions")))).map((p) => p.split("/")[0]);
      } catch {}
      die(`no saved session "${flags.restore}" under ${home}`, "not_found", {
        choices: saved.sort(),
        ...saved.length === 0 ? { hint: "no saved sessions in this home" } : {}
      });
    }
    const live = readSession(flags.restore);
    if (live) {
      const alive = await api(live.port, "GET", "/state").then((r) => r.status === 200, () => false);
      if (alive)
        die(`session ${flags.restore} is already running at ${live.url}`, "conflict", {
          hint: `use it: cli.ts state --session ${flags.restore}`
        });
    }
  }
  const daemonArgs = ["run", SERVER_SCRIPT];
  if (typeof flags.timeout === "string")
    daemonArgs.push("--timeout", flags.timeout);
  if (typeof flags.restore === "string")
    daemonArgs.push("--restore", flags.restore);
  else
    daemonArgs.push("--workspace", process.cwd());
  const cwd = daemonCwd();
  if (!existsSync(cwd))
    die(`scriptorium cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}`, "internal", {
      hint: "dev mode was resolved (no dist/index.html and no SPELLBOOK_SURFACE_MODE=release), which needs src/scriptorium/ \u2014 reinstall the spell or build it"
    });
  const logDir = join(scriptoriumHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  pruneLogs(logDir);
  const logPath = join(logDir, `daemon-${Date.now()}-${process.pid}.log`);
  daemonArgs.push("--log", logPath);
  const logFd = openSync(logPath, "a");
  const child = spawn("bun", daemonArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", logFd],
    env: process.env
  });
  closeSync(logFd);
  child.unref();
  const startTimeoutMs = typeof flags["start-timeout"] === "string" ? Math.max(5000, Number.parseInt(flags["start-timeout"], 10) * 1000) : 45000;
  const line = await new Promise((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => rej(new Error(`daemon start timeout (${startTimeoutMs / 1000}s) \u2014 pass --start-timeout <seconds>`)), startTimeoutMs);
    child.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf(`
`);
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
  }).catch((err) => {
    let tail = "";
    try {
      tail = readFileSync(logPath, "utf8").trim().slice(-800);
    } catch {}
    die(`scriptorium daemon failed to start: ${err instanceof Error ? err.message : String(err)}`, "internal", { hint: tail ? `daemon log (${logPath}): ${tail}` : `daemon log: ${logPath}` });
  });
  const out = child.stdout;
  if (!out || !("unref" in out) || typeof out.unref !== "function")
    throw new Error("scriptorium: the daemon's stdout pipe has no unref(); `open` would never exit");
  out.unref();
  let hs;
  try {
    hs = JSON.parse(line);
  } catch {
    die(`unexpected output from daemon: ${line}`, "internal");
  }
  if (hs.ok === false)
    daemonRefused("open", hs.status ?? 500, hs);
  let entries = [];
  if (paths.length > 0) {
    const r = await postCmd(hs.session_id, { type: "context.add", paths });
    entries = r.entries ?? [];
  }
  printJson({ ...hs, ...paths.length > 0 ? { entries } : {} });
  if (!flags["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [hs.url], { detached: true, stdio: "ignore" }).unref();
  }
}
async function cmdAdd(pos, session) {
  const paths = contextPaths(pos);
  printJson(await postCmd(session, { type: "context.add", paths }));
}
async function cmdState(session, full) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "?full=1" : ""}`);
  if (status !== 200)
    daemonRefused("state", status, data);
  printJson(data);
}
async function readSayBody(pos, flags) {
  const sources = [
    pos.length > 0,
    flags.stdin === true,
    typeof flags["body-file"] === "string"
  ].filter(Boolean).length;
  if (sources !== 1)
    die(sources === 0 ? "say needs a message" : "say takes its message from exactly one place: arguments, --stdin or --body-file", "usage", {
      hint: "give the text as arguments, or prose through --body-file <path> / --stdin (never an unquoted heredoc)",
      choices: ["--stdin", "--body-file"]
    });
  let text;
  if (flags.stdin === true)
    text = await new Response(Bun.stdin.stream()).text();
  else if (typeof flags["body-file"] === "string")
    text = readFileSync(flags["body-file"], "utf8");
  else
    text = pos.join(" ");
  if (!text.trim())
    die("say: the message is empty", "usage");
  return text.trim();
}
async function cmdTail(session, since) {
  let boundId = session;
  let grounded = false;
  return await tailEvents({
    resolve: () => {
      const s = readSession(boundId);
      if (!s)
        return null;
      if (!boundId)
        boundId = s.session_id;
      if (!grounded) {
        grounded = true;
        process.stdout.write(`${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}
`);
      }
      return `http://127.0.0.1:${s.port}`;
    },
    onUnresolved: ({ everResolved }) => {
      if (everResolved)
        return "stop";
      process.stderr.write(`# no session yet, retrying\u2026
`);
      return "retry";
    },
    path: "/events",
    since,
    cursorOf: (ev) => typeof ev.id === "number" ? ev.id : undefined,
    epochOf: (ev) => typeof ev.epoch === "string" ? ev.epoch : undefined,
    onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
    terminal: (ev) => ev.type === "closed",
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": scriptorium-keepalive"
  });
}
function versionInfo() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "scriptorium", version: pkg.version };
  } catch {}
  return { name: "scriptorium", version: "unknown" };
}
async function structureCmd(session, op) {
  printJson(await postCmd(session, op));
}
async function cmdImport(file, into, session) {
  const abs = resolve(file);
  let st;
  try {
    st = statSync(abs);
  } catch {
    die(`no such file: ${abs}`, "not_found");
  }
  if (!st.isFile() || !isDocName(abs))
    die(`not a document scriptorium opens: ${abs}`, "usage", { choices: [...DOC_EXTENSIONS] });
  await structureCmd(session, {
    type: "import",
    name: abs.split("/").pop(),
    text: readFileSync(abs, "utf8"),
    ...into !== undefined ? { into: resolve(into) } : {}
  });
}
async function cmdWorkspace(dir, session) {
  if (dir !== undefined)
    return structureCmd(session, { type: "workspace.set", path: resolve(dir) });
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    daemonRefused("workspace", status, data);
  printJson({ workspace: data.workspace });
}
var SESSION = ["session"];
var COMMANDS = [
  {
    name: "open",
    flags: ["no-open", "restore", "timeout", "start-timeout"],
    positionals: [{ name: "path", required: false, variadic: true }],
    describe: "spawn a session (opens the browser), adding paths; prints {url, port, session_id}",
    run: (pos, flags) => cmdOpen(pos, flags)
  },
  {
    name: "add",
    flags: SESSION,
    positionals: [{ name: "path", required: true, variadic: true }],
    describe: "add files or folders to the context list",
    run: (pos, _flags, session) => cmdAdd(pos, session)
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: [],
    describe: "the session: context, docs + versions (with paths), active, dirty, selection",
    run: (_pos, flags, session) => cmdState(session, flags.full === true)
  },
  {
    name: "tail",
    flags: [...SESSION, "since"],
    positionals: [],
    describe: "the human's messages (with selection + active path) as JSON lines \u2014 wrap with Monitor",
    run: (_pos, flags, session) => cmdTail(session, typeof flags.since === "string" ? parseSince(flags.since) : -1)
  },
  {
    name: "version-new",
    flags: [...SESSION, "doc", "from", "label"],
    positionals: [],
    describe: "copy a version (default: the active one) to a new file; prints its path to edit",
    run: async (_pos, flags, session) => {
      const from = typeof flags.from === "string" ? parseVersion(flags.from, "--from") : undefined;
      printJson(await postCmd(session, {
        type: "version.new",
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {},
        ...from !== undefined ? { from } : {},
        ...typeof flags.label === "string" ? { label: flags.label } : {}
      }));
    }
  },
  {
    name: "say",
    flags: [...SESSION, "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "post a chat message from the agent (prose: --body-file <path> or --stdin)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, { type: "say", text: await readSayBody(pos, flags) }));
    }
  },
  {
    name: "diff",
    flags: [...SESSION, "doc", "context", "patch"],
    positionals: [{ name: "against", required: true }],
    describe: "compare the active version with another (vN or 'original'); --patch for plain unified text",
    run: async (pos, flags, session) => {
      const r = await postCmd(session, {
        type: "diff",
        against: parseSide(pos[0] ?? "", "diff"),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {},
        ...typeof flags.context === "string" ? { context: parseCount(flags.context, "--context") } : {}
      });
      if (flags.patch)
        process.stdout.write(String(r.unified ?? ""));
      else
        printJson(r);
    }
  },
  {
    name: "merge",
    flags: [...SESSION, "doc", "hunks"],
    positionals: [{ name: "against", required: true }],
    describe: "take changes from another version into the active one (--hunks 1,3; default: all of them)",
    run: async (pos, flags, session) => {
      const against = parseSide(pos[0] ?? "", "merge");
      const listed = typeof flags.hunks === "string" ? flags.hunks.split(",").map((h) => parseCount(h, "--hunks")) : null;
      const hunks = listed ?? (await postCmd(session, {
        type: "diff",
        against,
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      })).hunks?.map((h) => h.id) ?? [];
      printJson(await postCmd(session, {
        type: "merge",
        against,
        hunks,
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "activate",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "vN", required: true }],
    describe: "make a version the active one (the one the human edits and Save writes)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "activate",
        version: parseVersion(pos[0] ?? "", "activate"),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "new-doc",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "create an empty document (its folder must be a set, a folder in one, or the workspace)",
    run: (pos, _flags, session) => {
      const abs = resolve(pos[0]);
      return structureCmd(session, { type: "doc.create", dir: dirname(abs), name: basename(abs) });
    }
  },
  {
    name: "new-folder",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "create a folder \u2014 inside a set, or in the workspace as a new set",
    run: (pos, _flags, session) => {
      const abs = resolve(pos[0]);
      return structureCmd(session, {
        type: "folder.create",
        dir: dirname(abs),
        name: basename(abs)
      });
    }
  },
  {
    name: "move",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "into", required: true }
    ],
    describe: "move a document or folder into another folder (a real move on disk)",
    run: (pos, _flags, session) => structureCmd(session, {
      type: "move",
      path: resolve(pos[0]),
      into: resolve(pos[1])
    })
  },
  {
    name: "rename",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "name", required: true }
    ],
    describe: "rename a document or folder in place",
    run: (pos, _flags, session) => structureCmd(session, { type: "rename", path: resolve(pos[0]), name: pos[1] })
  },
  {
    name: "hide",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "remove a document, folder or set from Scriptorium \u2014 the files stay on disk",
    run: (pos, _flags, session) => structureCmd(session, { type: "hide", path: resolve(pos[0]) })
  },
  {
    name: "unhide",
    flags: SESSION,
    positionals: [{ name: "entry", required: true }],
    describe: "bring back everything hidden in a set (its entry id, from state)",
    run: (pos, _flags, session) => structureCmd(session, { type: "unhide", entry: pos[0] })
  },
  {
    name: "make-set",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "turn a single document into a set: a folder named for it, the document moved in",
    run: (pos, _flags, session) => structureCmd(session, { type: "set.make", path: resolve(pos[0]) })
  },
  {
    name: "import",
    flags: [...SESSION, "into"],
    positionals: [{ name: "file", required: true }],
    describe: "copy a document in (default: into the workspace) and show the copy",
    run: (pos, flags, session) => cmdImport(pos[0], typeof flags.into === "string" ? flags.into : undefined, session)
  },
  {
    name: "workspace",
    flags: SESSION,
    positionals: [{ name: "dir", required: false }],
    describe: "print the workspace (where drops and new top-level documents land), or set it",
    run: (pos, _flags, session) => cmdWorkspace(pos[0], session)
  },
  {
    name: "meta",
    flags: SESSION,
    positionals: [{ name: "path", required: false }],
    describe: "a document's frontmatter as the daemon read it (no path: every context document)",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, {
        type: "meta",
        ...pos[0] !== undefined ? { path: resolve(pos[0]) } : {}
      }));
    }
  },
  {
    name: "find",
    flags: [...SESSION, "type", "status", "lifecycle", "tag", "since"],
    positionals: [],
    describe: "documents by frontmatter \u2014 filters AND, all optional; an empty result is an answer (count)",
    run: async (_pos, flags, session) => {
      const filter = {};
      for (const k of ["type", "status", "lifecycle", "tag"])
        if (typeof flags[k] === "string")
          filter[k] = flags[k];
      if (typeof flags.since === "string")
        filter.since = parseSinceDate(flags.since);
      printJson(await postCmd(session, { type: "find", filter }));
    }
  },
  {
    name: "graph",
    flags: [...SESSION, "entry"],
    positionals: [],
    describe: "a set's map as JSON \u2014 nodes, edges (body links and frontmatter kept apart), dangling",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "graph",
        ...typeof flags.entry === "string" ? { entry: flags.entry } : {}
      }));
    }
  },
  {
    name: "backlinks",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "what cites a document \u2014 `related` (frontmatter) and `links` (body), kept apart",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, { type: "backlinks", path: resolve(pos[0]) }));
    }
  },
  {
    name: "meta-init",
    flags: [...SESSION, "type", "by"],
    positionals: [{ name: "path", required: true }],
    describe: "add a frontmatter block to a document that has none (type guessed from its neighbours)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "meta.init",
        path: resolve(pos[0]),
        ...typeof flags.type === "string" ? { metaType: flags.type } : {},
        ...typeof flags.by === "string" ? { by: flags.by } : {}
      }));
    }
  },
  {
    name: "meta-set",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "key=value", required: true, variadic: true }
    ],
    describe: "set frontmatter keys \u2014 one line edit each, everything else untouched",
    run: async (pos, _flags, session) => {
      const fields = {};
      for (const pair of pos.slice(1)) {
        const eq = pair.indexOf("=");
        if (eq <= 0)
          die(`"${pair}" is not key=value`, "usage", {
            hint: "meta-set <path> status=stable lifecycle=live"
          });
        fields[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      printJson(await postCmd(session, { type: "meta.set", path: resolve(pos[0]), fields }));
    }
  },
  {
    name: "info",
    flags: SESSION,
    positionals: [],
    describe: "print the resolved session pointer",
    run: (_pos, _flags, session) => {
      printJson(requireSession(session));
    }
  },
  {
    name: "close",
    flags: SESSION,
    positionals: [],
    describe: "shut the session down (the manifest stays, for open --restore)",
    run: async (_pos, _flags, session) => {
      await postCmd(session, { type: "close" });
      printJson({ ok: true, sent: "close" });
    }
  },
  {
    name: "schema",
    flags: [],
    positionals: [],
    describe: "emit this CLI's acc declaration (walked from the command table)",
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}
`);
    }
  },
  {
    name: "help",
    flags: [],
    positionals: [],
    describe: "show this message",
    run: () => {
      process.stdout.write(`${renderHelp()}
`);
    }
  }
];
var ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" }
];
var findCommand = (token) => COMMANDS.find((c) => c.name === token);
function verbToken(argv) {
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--")
      return argv[i + 1] ?? null;
    if (a.startsWith("--")) {
      if (a.includes("="))
        continue;
      const key = a.slice(2);
      if (key in CLI_OPTIONS && CLI_OPTIONS[key].type === "string")
        i++;
      continue;
    }
    if (a.startsWith("-"))
      continue;
    return a;
  }
  return null;
}
var VERBS = COMMANDS.map((c) => c.name);
var VERB_SPEC = Object.fromEntries(COMMANDS.map((c) => [c.name, c.flags]));
var flagsFor = (verb) => [...findCommand(verb)?.flags ?? []].map((k) => `--${k}`).sort();
var renderFlag = (k) => CLI_OPTIONS[k].type === "boolean" ? `[--${k}]` : `[--${k} ..]`;
var renderPositional = (p) => {
  const inner = p.variadic ? `${p.name}...` : p.name;
  return p.required ? `<${inner}>` : `[${inner}]`;
};
function usageOf(spec) {
  return [
    spec.name,
    ...spec.positionals.map(renderPositional),
    ...spec.flags.filter((k) => k !== "session").map(renderFlag)
  ].join(" ");
}
function renderHelp() {
  const rows = COMMANDS.map((c) => [usageOf(c), c.describe]);
  const width = Math.min(Math.max(...rows.map(([u]) => u.length)), 44);
  const body = rows.map(([u, d]) => u.length <= width ? `  ${u.padEnd(width)}  ${d}` : `  ${u}
  ${"".padEnd(width)}  ${d}`).join(`
`);
  return `scriptorium \u2014 a co-present markdown editor: the human edits, you write new versions.

${body}
  ${ROOT_INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON

  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row.

  Output: JSON on stdout, one document per answer \u2014 except tail (one JSON line
  per event) and help (prose). Failures: one JSON envelope on stderr, exit
  2 = usage, 1 = internal, 5 = not found, 6 = conflict. tail waits for a
  session rather than failing, and ends 0 when its session closes.`;
}
function buildDeclaration() {
  const arg = (k) => ({ name: `--${k}`, type: CLI_OPTIONS[k].type, status: "valid" });
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands: [
      {
        path: [],
        args: ROOT_INTERCEPTORS.map((i) => ({
          name: i.name,
          type: "boolean",
          status: "valid"
        })),
        positionals: [{ name: "verb", required: true }]
      },
      ...COMMANDS.map((c) => ({
        path: [c.name],
        args: [...c.flags].map(arg),
        positionals: c.positionals
      }))
    ]
  };
}
async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (e) {
    const reported = reportCliError(e);
    if (reported !== null)
      return reported;
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "ENOENT")
      return reportCliError(new UsageError(msg)) ?? 2;
    return reportCliError(new CliError("internal", msg)) ?? 1;
  }
}
async function dispatch(argv) {
  const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === argv[0]);
  if (interceptor !== undefined || argv[0] === "version") {
    if ((interceptor?.runs ?? "version") === "help")
      process.stdout.write(`${renderHelp()}
`);
    else
      printJson(versionInfo());
    return 0;
  }
  let currentCommand2 = verbToken(argv);
  setCurrentCommand(currentCommand2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError) || e.extra?.choices === undefined)
      throw e;
    const spec2 = currentCommand2 === null ? undefined : findCommand(currentCommand2);
    if (spec2 !== undefined)
      throw new UsageError(e.message, { hint: e.extra?.hint, choices: flagsFor(spec2.name) });
    throw new UsageError(e.message, {
      hint: `no verb given \u2014 verbs: ${VERBS.join(" ")} (run: cli.ts help)`,
      choices: ROOT_INTERCEPTORS.map((i) => i.name)
    });
  }
  const [verb, ...pos] = parsed.pos;
  const flags = parsed.flags;
  currentCommand2 = verb ?? null;
  setCurrentCommand(currentCommand2);
  if (verb === undefined)
    throw new UsageError("no verb given", { hint: "run: cli.ts help", choices: [...VERBS] });
  const spec = findCommand(verb);
  if (spec === undefined)
    throw new UsageError(`unknown verb "${verb}"`, {
      hint: "run: cli.ts help",
      choices: [...VERBS]
    });
  const allowed = new Set(spec.flags);
  const stray = Object.keys(flags).find((k) => !allowed.has(k));
  if (stray !== undefined) {
    const accepted = flagsFor(spec.name);
    throw new UsageError(`--${stray} is not accepted by \`${spec.name}\` (it is a recognized scriptorium flag, just not this verb's)`, accepted.length > 0 ? { choices: accepted } : { hint: `${spec.name} takes no flags` });
  }
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (pos.length < required || !variadic && pos.length > spec.positionals.length)
    throw new UsageError(`usage: ${usageOf(spec)}`, { hint: spec.describe });
  const session = typeof flags.session === "string" ? flags.session : undefined;
  const code = await spec.run(pos, flags, session);
  return typeof code === "number" ? code : 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  RECOGNIZED_FLAGS,
  UsageError,
  VERBS,
  VERB_SPEC,
  buildDeclaration,
  daemonCwd,
  docArg,
  flagsFor,
  main,
  parseArgs,
  parseCount,
  parseSide,
  parseSince,
  parseSinceDate,
  parseVersion,
  renderHelp,
  run,
  usageOf,
  verbToken
};

//# debugId=D7FF4C2C1E97AFBB64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSBDTEkg4oCUIHRoZSBhZ2VudCdzIGhhbGYuIEEgdGhpbiBjbGllbnQgb2YgdGhlIHBlci1zZXNzaW9uIGRhZW1vblxuICogKGBzZXJ2ZXIudHNgKTogYG9wZW5gIHNwYXducyBvbmUsIGV2ZXJ5IG90aGVyIHZlcmIgZmluZHMgaXQgdGhyb3VnaCB0aGVcbiAqIHNlc3Npb24gcG9pbnRlciBpbiB0bXBkaXIgKEUxMykgYW5kIHNwZWFrcyBIVFRQLiBgdGFpbGAgc3RyZWFtcyB0aGUgaHVtYW4nc1xuICogbWVzc2FnZXMgYXMgSlNPTiBsaW5lcyBmb3IgTW9uaXRvciB0byB3cmFwLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBOT05FIGNhcnJpZWQgYmV5b25kIHdoYXQgaXMgdHJ1ZSBhdCB0aGUgZW1pdHRlZCBhZGRyZXNzLlxuICogICAgRnJvbSBgZGlzdC9jbGkuanNgLCBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIsIHNvIHRoZSBkYWVtb24gbGF1bmNoZXIgaXNcbiAqICAgIGAuLi9zY3JpcHRzL3NlcnZlci50c2AgKHVwIGFuZCBiYWNrIGRvd24g4oCUIG5ldmVyIGEgZmxhdCBzaWJsaW5nKSwgYW5kIHRoZVxuICogICAgZGV2IGN3ZCBpcyBgc3JjL3NjcmlwdG9yaXVtL2AgZml2ZSBsZXZlbHMgdXAgKENvbnRyYWN0IDUpLCB1c2VkIG9ubHkgd2hlblxuICogICAgZGV2IG1vZGUgaXMgcmVzb2x2ZWQuXG4gKiAyLiBTZXJ2ZXM6IG5vLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgc2hhcmVzIGAuL2hlYXJ0YmVhdC50c2Agd2l0aCB0aGUgZGFlbW9uICh0aGUgdGFpbFxuICogICAgd2F0Y2hkb2cgaXMgZGVyaXZlZCBmcm9tIHRoZSBkYWVtb24ncyBoZWFydGJlYXQsIG5ldmVyIGNvcGllZCkuXG4gKiA0LiBMaWZlY3ljbGU6IHNpbmdsZS1zaG90IHBlciB2ZXJiOyBgdGFpbGAgaXMgbG9uZy1ydW5uaW5nIGFuZCByZXR1cm5zIGl0c1xuICogICAgb3duIGV4aXQgY29kZS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDihpIgTkFUVVJBTC1SRVRVUk5cbiAqICAgIGxhdW5jaGVyIChgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IHJ1bigpYCk6IHN0ZG91dCBpcyBhIHBpcGUgdGhlIGFnZW50XG4gKiAgICBwYXJzZXMsIGFuZCBhbiBleHBsaWNpdCBleGl0IHRydW5jYXRlcyBpdCBhdCA2NCBLaUIuIGBvcGVuYCByZWxlYXNlcyB0aGVcbiAqICAgIGRhZW1vbidzIHN0ZG91dCBwaXBlIHNvIHRoZSBuYXR1cmFsIHJldHVybiBpcyBub3QgaGVsZCBvcGVuIGJ5IGl0LlxuICogNi4gRXZlbnQgaWRzIGFjcm9zcyByZXN0YXJ0OiB0aGUgZGFlbW9uJ3MgYXJlIHBlci1ib290IGFuZCBlcG9jaC1zdGFtcGVkO1xuICogICAgdGhpcyBzaWRlIHJlc2V0cyBpdHMgY3Vyc29yIG9uIGFuIGVwb2NoIGNoYW5nZSBhbmQgc2F5cyBzbyBpbiBvbmUgbGluZS5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IG5vLlxuICpcbiAqIOKUgOKUgCBFUlJPUiBDT05UUkFDVCAoYWNjIEwwLCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV2ZXJ5IGZhaWx1cmUgaXMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyLCBzdGRvdXQgZW1wdHkg4oCUXG4gKiAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbiAqICAgdXNhZ2Ug4oaSIDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IMK3IGNvbmZsaWN0IOKGkiA2XG4gKiBBIGRhZW1vbiByZWZ1c2FsIG1hcHMgb2ZmIGl0cyBIVFRQIHN0YXR1cyAoNDAwIHVzYWdlLCA0MDQgbm90X2ZvdW5kLCA0MDlcbiAqIGNvbmZsaWN0LCBlbHNlIGludGVybmFsKTsgdGhlIGRhZW1vbidzIGJvZHkgcmlkZXMgdmVyYmF0aW0gdW5kZXJcbiAqIGBlcnJvci5zZXJ2ZXJgLCBhbmQgd2hlbiB0aGUgZGFlbW9uIG5hbWVkIHRoZSB2YWxpZCBzZXQgKGEgZG9jIHNsdWcsIGFcbiAqIHZlcnNpb24pIHRoYXQgc2V0IGlzIEFMU08gbGlmdGVkIGludG8gYGNob2ljZXNgIOKAlCBBMTogdGhlIHNldCBpcyBpbiBoYW5kIGF0XG4gKiB0aGUgcmFpc2UsIGJlY2F1c2UgdGhlIGRhZW1vbiBoYW5kZWQgaXQgb3Zlci5cbiAqXG4gKiDim5QgVGhlIGtpdCBjYXJyaWVzIHRoZSBFTlZFTE9QRSwgbm90IHRoZSBDTEFTU0lGSUVSOiBgcmVwb3J0Q2xpRXJyb3JgXG4gKiByZXR1cm5zIG51bGwgZm9yIGEgbm9uLUNsaUVycm9yLCBhbmQgYG1haW5gIGJlbG93IHRyaWFnZXMgRU5PRU5UIChhIG5hbWVkXG4gKiBmaWxlIHRoZSBjYWxsZXIgZ2F2ZSkgaW50byB1c2FnZSBhbmQgZXZlcnl0aGluZyBlbHNlIGludG8gaW50ZXJuYWwuXG4gKlxuICogRDggcmVhY2hhYmlsaXR5LCBhdWRpdGVkIGJ5IGNhbGwgZ3JhcGg6IGV2ZXJ5IGBkaWVgIGhlcmUgaXMgcmVhY2hlZCBmcm9tIGFcbiAqIHZlcmIgaGFuZGxlciBvciBgZGlzcGF0Y2hgLCBub25lIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLiBUaGVcbiAqIHN3YWxsb3dpbmcgY2F0Y2hlcyAoYGFwaWAncyBub24tSlNPTiBib2R5LCBgdmVyc2lvbkluZm9gLCBgcG9zdENtZGAncyBjbG9zZVxuICogRUNPTk5SRVNFVCkgY29udGFpbiBubyBkaWUtcmVhY2hhYmxlIGNhbGwuXG4gKi9cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBjbG9zZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgb3BlblN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHN0YXRTeW5jLFxuICB1bmxpbmtTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyBwcmludEpzb24gfSBmcm9tIFwiLi4vLi4va2l0L2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7XG4gIENsaUVycm9yLFxuICBkaWUsXG4gIHR5cGUgRXJyS2luZCxcbiAgcmVwb3J0Q2xpRXJyb3IsXG4gIHNldEN1cnJlbnRDb21tYW5kLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQgeyB0YWlsRXZlbnRzIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxFdmVudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgRE9DX0VYVEVOU0lPTlMsIGlzRG9jTmFtZSB9IGZyb20gXCIuL3RyZWVcIjtcblxuLy8g4pqgIERFQ0xBUkVEIEZJUlNULCBBQk9WRSBFVkVSWSBPVEhFUiBGVU5DVElPTiwgT04gUFVSUE9TRS4gVGhlIGBjaG9pY2VzYFxuLy8gY2Vuc3VzJ3MgcmFpc2VyIHJ1bGUgKGEpIChgZ3JpbW9pcmUvbGliL2Vycm9yLXNpdGVzLnRzYCkgbWF0Y2hlc1xuLy8gYGZ1bmN0aW9uIE5BTUUoYCBsYXppbHkgdXAgdG8gdGhlIG5leHQgYCk6IG5ldmVyYCB3aXRoaW4gNjAwIGNoYXJhY3RlcnMsIHNvXG4vLyBBTlkgZnVuY3Rpb24gZGVjbGFyZWQgc2hvcnRseSBhYm92ZSB0aGlzIG9uZSDigJQgYGFwaWAsIHRoZW4gYHJlcXVpcmVTZXNzaW9uYCDigJRcbi8vIHdhcyByZWFkIGFzIGEgcmFpc2VyIGFuZCBpdHMgY2FsbHMgY291bnRlZCBhcyByYWlzZSBzaXRlcyAoZm91bmQgMjAyNi0wOS0xMSxcbi8vIHJlcG9ydGVkIGluIHRoZSBzbGljZS1BIGpvdXJuYWwgYXMgYW4gaW5zdHJ1bWVudCBkZWZlY3QsIG5vdCBmaXhlZCBoZXJlKS5cbmZ1bmN0aW9uIGRhZW1vblJlZnVzZWQod2hhdDogc3RyaW5nLCBzdGF0dXM6IG51bWJlciwgZGF0YTogdW5rbm93bik6IG5ldmVyIHtcbiAgY29uc3Qga2luZDogRXJyS2luZCA9XG4gICAgc3RhdHVzID09PSA0MDBcbiAgICAgID8gXCJ1c2FnZVwiXG4gICAgICA6IHN0YXR1cyA9PT0gNDA0XG4gICAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgICA6IHN0YXR1cyA9PT0gNDA5XG4gICAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgICA6IFwiaW50ZXJuYWxcIjtcbiAgY29uc3QgYm9keSA9IChkYXRhID8/IHt9KSBhcyB7IGVycm9yPzogdW5rbm93bjsgY2hvaWNlcz86IHVua25vd24gfTtcbiAgY29uc3QgY2hvaWNlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5jaG9pY2VzKSA/IGJvZHkuY2hvaWNlcy5tYXAoU3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgZGllKHR5cGVvZiBib2R5LmVycm9yID09PSBcInN0cmluZ1wiID8gYm9keS5lcnJvciA6IGAke3doYXR9IGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwga2luZCwge1xuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbih0bXBkaXIoKSwgc2Vzc2lvbiA/IGBzY3JpcHRvcml1bS0ke3Nlc3Npb259Lmpzb25gIDogXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0Ug4oCUIEVOT0VOVCBpcyB0aGUgb25seSBhYnNlbmNlLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb25Qb2ludGVyO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBsZXQgc3RhdHVzOiBudW1iZXI7XG4gIGxldCBkYXRhOiB1bmtub3duO1xuICB0cnkge1xuICAgICh7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYGNsb3NlYCBzdG9wcyB0aGUgc2VydmVyOyBhIFJFU0VUIGlzIGl0cyBzdWNjZXNzLiBBIHJlZnVzZWQgY29ubmVjdGlvblxuICAgIC8vIChhIHN0YWxlIHBvaW50ZXIpIGlzIGEgdHJhbnNwb3J0IGZhaWx1cmUgbGlrZSBhbnkgb3RoZXIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zdCBjb2RlID0gZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyID8gU3RyaW5nKGVyci5jb2RlKSA6IFwiXCI7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSlcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChTdHJpbmcobXNnLnR5cGUpLCBzdGF0dXMsIGRhdGEpO1xuICByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuLy8g4pSA4pSAIHRoZSBwYXJzZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjb250ZXh0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZW50cnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW5rczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaWZlY3ljbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHBhdGNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0eXBlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBSRUNPR05JWkVEX0ZMQUdTID0gT2JqZWN0LmtleXMoQ0xJX09QVElPTlMpLm1hcCgoaykgPT4gYC0tJHtrfWApO1xuXG5leHBvcnQgY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0pIHtcbiAgICBzdXBlcihcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3M6IHN0cmluZ1tdKToge1xuICBwb3M6IHN0cmluZ1tdO1xuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG59IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJncyxcbiAgICAgIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4geyBwb3M6IHBvc2l0aW9uYWxzLCBmbGFnczogdmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+IH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBkZXRhaWwgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIHsgY29kZT86IHN0cmluZyB9KS5jb2RlO1xuICAgIC8vIE9ubHkgYW4gVU5LTk9XTiBvcHRpb24gbmFtZXMgdGhlIGZsYWcgcm9zdGVyOyB0aGUgb3RoZXIgcGFyc2UgZmFpbHVyZXNcbiAgICAvLyBtZWFuIGEgcmVjb2duaXNlZCBmbGFnIHdhcyBtaXN1c2VkLCBhbmQgdGhlIHJvc3RlciB3b3VsZCBuYW1lIHRoZSBoYWxmXG4gICAgLy8gdGhhdCB3YXMgcmlnaHQuXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZGV0YWlsLCB7XG4gICAgICBoaW50OiBcImZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMsIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1cIixcbiAgICAgIC4uLihjb2RlID09PSBcIkVSUl9QQVJTRV9BUkdTX1VOS05PV05fT1BUSU9OXCIgPyB7IGNob2ljZXM6IFJFQ09HTklaRURfRkxBR1MgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxufVxuXG4vKipcbiAqIGAtLXNpbmNlYCBpcyBhbiBldmVudCBpZDogYW4gaW50ZWdlciwgLTEgZm9yIFwiZXZlcnl0aGluZ1wiLiBWZXJpZnktcGFzcyBmaXhcbiAqIDk6IGAtLXNpbmNlIGFiY2AgcGFyc2VkIHRvIE5hTiwgd2hpY2ggdGhlIGxvZyByZWFkcyBhcyBcImZyb20gdGhlIHN0YXJ0XCIsIHNvXG4gKiBhIHR5cG8gcmVwbGF5ZWQgdGhlIHdob2xlIGJ1ZmZlciBpbnRvIHRoZSBhZ2VudCdzIHBpcGUgYXQgZXhpdCAwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaW5jZSh0b2tlbjogc3RyaW5nKTogbnVtYmVyIHtcbiAgaWYgKCEvXi0/XFxkKyQvLnRlc3QodG9rZW4udHJpbSgpKSlcbiAgICBkaWUoXG4gICAgICBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhbiBldmVudCBpZCDigJQgZ2l2ZSBhbiBpbnRlZ2VyICh0aGUgaWQgb2YgdGhlIGxhc3QgbGluZSB5b3Ugc2F3KWAsXG4gICAgICBcInVzYWdlXCIsXG4gICAgKTtcbiAgcmV0dXJuIE51bWJlci5wYXJzZUludCh0b2tlbiwgMTApO1xufVxuXG4vKipcbiAqIGBmaW5kIC0tc2luY2VgIGlzIGEgREFURSwgd2hlcmUgYHRhaWwgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQg4oCUIHRoZSBmbGFnIGlzXG4gKiBzaGFyZWQsIHRoZSBtZWFuaW5nIGlzIHRoZSB2ZXJiJ3MsIGFuZCBwZG9jcyBzcGVsbHMgdGhpcyBvbmUgYC0tc2luY2VgIHRvby5cbiAqIEEgdHlwbyBtdXN0IG5vdCBzaWxlbnRseSB3aWRlbiB0aGUgc2VhcmNoLCBzbyBhIG5vbi1kYXRlIGlzIGEgdXNhZ2UgZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlRGF0ZSh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh0KSB8fCBOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZSh0KSkpXG4gICAgZGllKGBmaW5kIC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBkYXRlIOKAlCB3cml0ZSBpdCBhcyBZWVlZLU1NLUREYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHQ7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vKiogQSBub24tbmVnYXRpdmUgd2hvbGUgbnVtYmVyIGZyb20gYSBmbGFnLCByZWZ1c2VkIHJhdGhlciB0aGFuIGNvZXJjZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb3VudCh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QodCkpIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHdob2xlIG51bWJlcmAsIFwidXNhZ2VcIik7XG4gIHJldHVybiBOdW1iZXIodCk7XG59XG5cbi8qKlxuICogQSBjb21wYXJpc29uIHNpZGU6IGEgdmVyc2lvbiwgb3IgdGhlIGZpbGUgb2YgcmVjb3JkLiBgb3JpZ2luYWxgIGlzIHNwZWxsZWRcbiAqIG91dCByYXRoZXIgdGhhbiBvZmZlcmVkIGFzIGB2MGAg4oCUIGEgemVyb3RoIHZlcnNpb24gd291bGQgcmVhZCBsaWtlIHRoZVxuICogZWFybGllc3Qgb25lLCBhbmQgdGhlIG9yaWdpbmFsIGlzIG5vdCBwYXJ0IG9mIHRoZSB2ZXJzaW9uIGxpbmUgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaWRlKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB8IFwib3JpZ2luYWxcIiB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKHQgPT09IFwib3JpZ2luYWxcIiB8fCB0ID09PSBcImZpbGVcIikgcmV0dXJuIFwib3JpZ2luYWxcIjtcbiAgcmV0dXJuIHBhcnNlVmVyc2lvbih0b2tlbiwgd2hhdCk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqXG4gKiDim5QgVkVSSUZZLVBBU1MgRklYIDU6IGV2ZXJ5IHBhdGggaXMgY2hlY2tlZCBIRVJFLCBiZWZvcmUgYW55IGRhZW1vbiBleGlzdHMuXG4gKiBgb3BlbiBkb2MubWQgcGljLnBuZ2AgdXNlZCB0byBzcGF3biBhIHNlc3Npb24sIHRoZW4gZmFpbCBvbiB0aGUgc2Vjb25kIHBhdGhcbiAqIGluc2lkZSBpdCDigJQgbGVhdmluZyBhIHJ1bm5pbmcgZGFlbW9uIGFuZCBhIGxpdmUgcG9pbnRlciBiZWhpbmQgYSBmYWlsZWRcbiAqIGNvbW1hbmQuIEEgZm9sZGVyIG9yIGEgZG9jdW1lbnQgaXMgYWNjZXB0ZWQ7IGEgbWlzc2luZyBwYXRoIGlzIG5vdF9mb3VuZCwgYVxuICogbm9uLWRvY3VtZW50IGZpbGUgaXMgdXNhZ2Ugd2l0aCB0aGUgYWNjZXB0ZWQgZXh0ZW5zaW9ucyBhcyBgY2hvaWNlc2AuXG4gKi9cbmZ1bmN0aW9uIGNvbnRleHRQYXRocyhwb3M6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBwYXRocyA9IHBvcy5tYXAoKHApID0+IHJlc29sdmUocCkpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcbiAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICB0cnkge1xuICAgICAgc3QgPSBzdGF0U3luYyhwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGRpZShgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHtwfWAsIFwibm90X2ZvdW5kXCIpO1xuICAgIH1cbiAgICBpZiAoIXN0LmlzRGlyZWN0b3J5KCkgJiYgIWlzRG9jTmFtZShwKSlcbiAgICAgIGRpZShgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7cH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogXCJhZGQgYSBmb2xkZXIsIG9yIGEgZmlsZSB3aXRoIG9uZSBvZiB0aGVzZSBleHRlbnNpb25zXCIsXG4gICAgICAgIGNob2ljZXM6IFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gcGF0aHM7XG59XG5cbi8qKlxuICogYC0tZG9jYCBhcyB0aGUgQ0xJJ3MgY2FsbGVyIG1lYW50IGl0ICh2ZXJpZnktcGFzcyBmaXggOCk6IGEgdG9rZW4gd2l0aCBhIHBhdGhcbiAqIHNlcGFyYXRvciwgb3Igb25lIG5hbWluZyBhIGZpbGUgaW4gVEhJUyBwcm9jZXNzJ3MgY3dkLCBpcyByZXNvbHZlZCBoZXJlIHRvIGFuXG4gKiBhYnNvbHV0ZSBwYXRoIOKAlCB0aGUgZGFlbW9uJ3MgY3dkIGlzIG5vdCB0aGUgY2FsbGVyJ3MuIEFueXRoaW5nIGVsc2UgKGEgc2x1ZyxcbiAqIGEgdW5pcXVlIGZpbGUgbmFtZSkgZ29lcyBhcyB0eXBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY0FyZyh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHRva2VuLmluY2x1ZGVzKFwiL1wiKSB8fCBleGlzdHNTeW5jKHJlc29sdmUodG9rZW4pKSkgcmV0dXJuIHJlc29sdmUodG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbi8qKiBLZWVwIHRoZSBuZXdlc3QgYExPR19LRUVQIC0gMWAgZGFlbW9uIGxvZ3MsIHNvIHRoZSBvbmUgYWJvdXQgdG8gYmUgd3JpdHRlbiBtYWtlcyBgTE9HX0tFRVBgLiAqL1xuY29uc3QgTE9HX0tFRVAgPSAxMDtcbmZ1bmN0aW9uIHBydW5lTG9ncyhsb2dEaXI6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgbmFtZXMgPSByZWFkZGlyU3luYyhsb2dEaXIpLmZpbHRlcigobikgPT4gL15kYWVtb24tXFxkKy1cXGQrXFwubG9nJC8udGVzdChuKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBieUFnZSA9IG5hbWVzLnNvcnQoKGEsIGIpID0+IE51bWJlcihhLnNwbGl0KFwiLVwiKVsxXSkgLSBOdW1iZXIoYi5zcGxpdChcIi1cIilbMV0pKTtcbiAgZm9yIChjb25zdCBuIG9mIGJ5QWdlLnNsaWNlKDAsIE1hdGgubWF4KDAsIGJ5QWdlLmxlbmd0aCAtIChMT0dfS0VFUCAtIDEpKSkpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhqb2luKGxvZ0RpciwgbikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG5cbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIGZsYWdzLnJlc3RvcmUsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWFuaWZlc3QpKSB7XG4gICAgICBsZXQgc2F2ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICB0cnkge1xuICAgICAgICBzYXZlZCA9IChcbiAgICAgICAgICBhd2FpdCBBcnJheS5mcm9tQXN5bmMobmV3IEJ1bi5HbG9iKFwiKi9tYW5pZmVzdC5qc29uXCIpLnNjYW4oam9pbihob21lLCBcInNlc3Npb25zXCIpKSlcbiAgICAgICAgKS5tYXAoKHApID0+IHAuc3BsaXQoXCIvXCIpWzBdIGFzIHN0cmluZyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm8gc2Vzc2lvbnMgZm9sZGVyOiB0aGUgc2V0IGlzIGVtcHR5LCBhbmQgc2F5cyBzbyAqL1xuICAgICAgfVxuICAgICAgZGllKGBubyBzYXZlZCBzZXNzaW9uIFwiJHtmbGFncy5yZXN0b3JlfVwiIHVuZGVyICR7aG9tZX1gLCBcIm5vdF9mb3VuZFwiLCB7XG4gICAgICAgIGNob2ljZXM6IHNhdmVkLnNvcnQoKSxcbiAgICAgICAgLi4uKHNhdmVkLmxlbmd0aCA9PT0gMCA/IHsgaGludDogXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWVcIiB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxpdmUgPSByZWFkU2Vzc2lvbihmbGFncy5yZXN0b3JlKTtcbiAgICBpZiAobGl2ZSkge1xuICAgICAgY29uc3QgYWxpdmUgPSBhd2FpdCBhcGkobGl2ZS5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKS50aGVuKFxuICAgICAgICAocikgPT4gci5zdGF0dXMgPT09IDIwMCxcbiAgICAgICAgKCkgPT4gZmFsc2UsXG4gICAgICApO1xuICAgICAgaWYgKGFsaXZlKVxuICAgICAgICBkaWUoYHNlc3Npb24gJHtmbGFncy5yZXN0b3JlfSBpcyBhbHJlYWR5IHJ1bm5pbmcgYXQgJHtsaXZlLnVybH1gLCBcImNvbmZsaWN0XCIsIHtcbiAgICAgICAgICBoaW50OiBgdXNlIGl0OiBjbGkudHMgc3RhdGUgLS1zZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX1gLFxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBkYWVtb25BcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAodHlwZW9mIGZsYWdzLnRpbWVvdXQgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBmbGFncy50aW1lb3V0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgZmxhZ3MucmVzdG9yZSk7XG4gIC8vIEUyMzogYSBuZXcgc2Vzc2lvbidzIHdvcmtzcGFjZSBpcyB3aGVyZSBgb3BlbmAgcmFuLiBBIHJlc3RvcmVkIG9uZSBrZWVwcyBpdHMgb3duLlxuICBlbHNlIGRhZW1vbkFyZ3MucHVzaChcIi0td29ya3NwYWNlXCIsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSlcbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCB3aGljaCBuZWVkcyBzcmMvc2NyaXB0b3JpdW0vIOKAlCByZWluc3RhbGwgdGhlIHNwZWxsIG9yIGJ1aWxkIGl0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIC8vIFRoZSBkYWVtb24ncyBzdGRlcnIgZ29lcyB0byBhIExPRyBGSUxFLCBub3QgdG8gdGhpcyBDTEkncyBzdGRlcnIuIEFuXG4gIC8vIGluaGVyaXRlZCBzdGRlcnIgb3V0bGl2ZXMgdGhlIENMSSBpbnNpZGUgdGhlIGRldGFjaGVkIGRhZW1vbiwgc28gYW55IGNhbGxlclxuICAvLyB0aGF0IHJlYWRzIGBvcGVuYCdzIHN0ZGVyciB0byBFT0YgKGEgdGVzdCBoYXJuZXNzLCBhIHRvb2wgcnVubmVyKSB3YWl0cyBmb3JcbiAgLy8gdGhlIHdob2xlIHNlc3Npb24g4oCUIG1lYXN1cmVkOiB0aGUgaW50ZWdyYXRpb24gY2VsbCBodW5nIGF0IGl0cyA2MCBzIHRpbWVvdXQuXG4gIC8vIEEgZmlsZSBob2xkcyBubyBwaXBlLCBhbmQgYSBzdGFydCBmYWlsdXJlIGJlbG93IHF1b3RlcyBpdHMgdGFpbC5cbiAgY29uc3QgbG9nRGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJsb2dzXCIpO1xuICBta2RpclN5bmMobG9nRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IHRoZSBsb2dzIHVzZWQgdG8gcGlsZSB1cCwgb25lIHBlciBgb3BlbmAsIGZvcmV2ZXIuXG4gIHBydW5lTG9ncyhsb2dEaXIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihsb2dEaXIsIGBkYWVtb24tJHtEYXRlLm5vdygpfS0ke3Byb2Nlc3MucGlkfS5sb2dgKTtcbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1sb2dcIiwgbG9nUGF0aCk7XG4gIGNvbnN0IGxvZ0ZkID0gb3BlblN5bmMobG9nUGF0aCwgXCJhXCIpO1xuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgbG9nRmRdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjbG9zZVN5bmMobG9nRmQpO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0sIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBsaW5lID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzLCByZWopID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWooXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgcGFzcyAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+YCxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgc3RhcnRUaW1lb3V0TXMsXG4gICAgKTtcbiAgICBjaGlsZC5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWooZXJyKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImV4aXRcIiwgKGNvZGUpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWoobmV3IEVycm9yKGBkYWVtb24gZXhpdGVkIHdpdGggY29kZSAke2NvZGV9IGJlZm9yZSBpdHMgaGFuZHNoYWtlYCkpO1xuICAgIH0pO1xuICB9KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgbGV0IHRhaWwgPSBcIlwiO1xuICAgIHRyeSB7XG4gICAgICB0YWlsID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmOFwiKS50cmltKCkuc2xpY2UoLTgwMCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBsb2cgd3JpdHRlbiAqL1xuICAgIH1cbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gZGFlbW9uIGZhaWxlZCB0byBzdGFydDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHsgaGludDogdGFpbCA/IGBkYWVtb24gbG9nICgke2xvZ1BhdGh9KTogJHt0YWlsfWAgOiBgZGFlbW9uIGxvZzogJHtsb2dQYXRofWAgfSxcbiAgICApO1xuICB9KTtcblxuICAvLyBSZWxlYXNlIHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSwgb3IgdGhpcyBDTEkncyBuYXR1cmFsIHJldHVybiB3YWl0cyBvbiBhXG4gIC8vIHN0cmVhbSB0aGF0IG5ldmVyIGNsb3NlcyAoZ2xhbW91ciBtZWFzdXJlZCA5MSBzIOKGkiAxIHMpLiBDaGVja2VkIGZvciB0aGVcbiAgLy8gTUVUSE9EOiB1bmRlciBCdW4gdGhpcyBwaXBlIGlzIGEgcGxhaW4gUmVhZGFibGUgdGhhdCBub25ldGhlbGVzcyBoYXMgdW5yZWYuXG4gIGNvbnN0IG91dCA9IGNoaWxkLnN0ZG91dDtcbiAgaWYgKCFvdXQgfHwgIShcInVucmVmXCIgaW4gb3V0KSB8fCB0eXBlb2Ygb3V0LnVucmVmICE9PSBcImZ1bmN0aW9uXCIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzY3JpcHRvcml1bTogdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlIGhhcyBubyB1bnJlZigpOyBgb3BlbmAgd291bGQgbmV2ZXIgZXhpdFwiLFxuICAgICk7XG4gIG91dC51bnJlZigpO1xuXG4gIGxldCBoczoge1xuICAgIHVybDogc3RyaW5nO1xuICAgIHBvcnQ6IG51bWJlcjtcbiAgICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gICAgb2s/OiBib29sZWFuO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfTtcbiAgdHJ5IHtcbiAgICBocyA9IEpTT04ucGFyc2UobGluZSk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7bGluZX1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIGlmIChocy5vayA9PT0gZmFsc2UpIGRhZW1vblJlZnVzZWQoXCJvcGVuXCIsIGhzLnN0YXR1cyA/PyA1MDAsIGhzKTtcblxuICBsZXQgZW50cmllczogdW5rbm93bltdID0gW107XG4gIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgciA9IGF3YWl0IHBvc3RDbWQoaHMuc2Vzc2lvbl9pZCwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pO1xuICAgIGVudHJpZXMgPSAoci5lbnRyaWVzIGFzIHVua25vd25bXSkgPz8gW107XG4gIH1cbiAgcHJpbnRKc29uKHsgLi4uaHMsIC4uLihwYXRocy5sZW5ndGggPiAwID8geyBlbnRyaWVzIH0gOiB7fSkgfSk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW2hzLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWRkKHBvczogc3RyaW5nW10sIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZ1bGw6IGJvb2xlYW4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiP2Z1bGw9MVwiIDogXCJcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IFwic2F5IG5lZWRzIGEgbWVzc2FnZVwiXG4gICAgICAgIDogXCJzYXkgdGFrZXMgaXRzIG1lc3NhZ2UgZnJvbSBleGFjdGx5IG9uZSBwbGFjZTogYXJndW1lbnRzLCAtLXN0ZGluIG9yIC0tYm9keS1maWxlXCIsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZ2l2ZSB0aGUgdGV4dCBhcyBhcmd1bWVudHMsIG9yIHByb3NlIHRocm91Z2ggLS1ib2R5LWZpbGUgPHBhdGg+IC8gLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIixcbiAgICAgICAgY2hvaWNlczogW1wiLS1zdGRpblwiLCBcIi0tYm9keS1maWxlXCJdLFxuICAgICAgfSxcbiAgICApO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBpZiAoZmxhZ3Muc3RkaW4gPT09IHRydWUpIHRleHQgPSBhd2FpdCBuZXcgUmVzcG9uc2UoQnVuLnN0ZGluLnN0cmVhbSgpKS50ZXh0KCk7XG4gIGVsc2UgaWYgKHR5cGVvZiBmbGFnc1tcImJvZHktZmlsZVwiXSA9PT0gXCJzdHJpbmdcIikgdGV4dCA9IHJlYWRGaWxlU3luYyhmbGFnc1tcImJvZHktZmlsZVwiXSwgXCJ1dGY4XCIpO1xuICBlbHNlIHRleHQgPSBwb3Muam9pbihcIiBcIik7XG4gIGlmICghdGV4dC50cmltKCkpIGRpZShcInNheTogdGhlIG1lc3NhZ2UgaXMgZW1wdHlcIiwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHRleHQudHJpbSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2U6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0+KHtcbiAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgIH0sXG4gICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgaWYgKGV2ZXJSZXNvbHZlZCkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgfSxcbiAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICBzaW5jZSxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAvLyBBIGRpZmZlcmVudCBlcG9jaCBvbiByZWNvbm5lY3QgPSB0aGUgZGFlbW9uIHJlc3RhcnRlZDsgaWRzIGJlZ2FuIGFnYWluLlxuICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICBvbkNvbW1lbnQ6ICgpID0+IFwiOiBzY3JpcHRvcml1bS1rZWVwYWxpdmVcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuXG50eXBlIEZsYWcgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgZmxhZ3M6IHJlYWRvbmx5IEZsYWdbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIHJ1bjogKFxuICAgIHBvczogc3RyaW5nW10sXG4gICAgZmxhZ3M6IEZsYWdzLFxuICAgIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgKSA9PiBQcm9taXNlPG51bWJlcj4gfCBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcbn07XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IENPTU1BTkRTOiBDb21tYW5kU3BlY1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInNwYXduIGEgc2Vzc2lvbiAob3BlbnMgdGhlIGJyb3dzZXIpLCBhZGRpbmcgcGF0aHM7IHByaW50cyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0aGUgaHVtYW4ncyBtZXNzYWdlcyAod2l0aCBzZWxlY3Rpb24gKyBhY3RpdmUgcGF0aCkgYXMgSlNPTiBsaW5lcyDigJQgd3JhcCB3aXRoIE1vbml0b3JcIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZFRhaWwoc2Vzc2lvbiwgdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VTaW5jZShmbGFncy5zaW5jZSkgOiAtMSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tbmV3XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZyb21cIiwgXCJsYWJlbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIHZlcnNpb24gKGRlZmF1bHQ6IHRoZSBhY3RpdmUgb25lKSB0byBhIG5ldyBmaWxlOyBwcmludHMgaXRzIHBhdGggdG8gZWRpdFwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gdHlwZW9mIGZsYWdzLmZyb20gPT09IFwic3RyaW5nXCIgPyBwYXJzZVZlcnNpb24oZmxhZ3MuZnJvbSwgXCItLWZyb21cIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIC4uLihmcm9tICE9PSB1bmRlZmluZWQgPyB7IGZyb20gfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8geyBsYWJlbDogZmxhZ3MubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNheVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicG9zdCBhIGNoYXQgbWVzc2FnZSBmcm9tIHRoZSBhZ2VudCAocHJvc2U6IC0tYm9keS1maWxlIDxwYXRoPiBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzYXlcIiwgdGV4dDogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncykgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRpZmZcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwiY29udGV4dFwiLCBcInBhdGNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImFnYWluc3RcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImNvbXBhcmUgdGhlIGFjdGl2ZSB2ZXJzaW9uIHdpdGggYW5vdGhlciAodk4gb3IgJ29yaWdpbmFsJyk7IC0tcGF0Y2ggZm9yIHBsYWluIHVuaWZpZWQgdGV4dFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiZGlmZlwiLFxuICAgICAgICBhZ2FpbnN0OiBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwiZGlmZlwiKSxcbiAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5jb250ZXh0ID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgPyB7IGNvbnRleHQ6IHBhcnNlQ291bnQoZmxhZ3MuY29udGV4dCwgXCItLWNvbnRleHRcIikgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSkpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgaWYgKGZsYWdzLnBhdGNoKSBwcm9jZXNzLnN0ZG91dC53cml0ZShTdHJpbmcoci51bmlmaWVkID8/IFwiXCIpKTtcbiAgICAgIGVsc2UgcHJpbnRKc29uKHIpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1lcmdlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImh1bmtzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImFnYWluc3RcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInRha2UgY2hhbmdlcyBmcm9tIGFub3RoZXIgdmVyc2lvbiBpbnRvIHRoZSBhY3RpdmUgb25lICgtLWh1bmtzIDEsMzsgZGVmYXVsdDogYWxsIG9mIHRoZW0pXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWdhaW5zdCA9IHBhcnNlU2lkZShwb3NbMF0gPz8gXCJcIiwgXCJtZXJnZVwiKTtcbiAgICAgIC8vIOKblCBXaXRob3V0IC0taHVua3MgdGhpcyB0YWtlcyBFVkVSWSBodW5rLCB3aGljaCBpcyB0aGUgd2hvbGUtZG9jdW1lbnRcbiAgICAgIC8vIG1lcmdlLiBUaGUgaWRzIGNvbWUgZnJvbSBgZGlmZmAgYW5kIGFyZSBvbmx5IHZhbGlkIGFnYWluc3QgdGhlIHRleHQgaXRcbiAgICAgIC8vIHNhdzogdGhlIGRhZW1vbiByZS1kaWZmcyBhbmQgcmVmdXNlcyBpZHMgaXQgY2Fubm90IGZpbmQgcmF0aGVyIHRoYW5cbiAgICAgIC8vIGFwcGx5aW5nIGEgbnVtYmVyIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbW92ZWQgdW5kZXJuZWF0aCBpdC5cbiAgICAgIGNvbnN0IGxpc3RlZCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5odW5rcyA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8gZmxhZ3MuaHVua3Muc3BsaXQoXCIsXCIpLm1hcCgoaCkgPT4gcGFyc2VDb3VudChoLCBcIi0taHVua3NcIikpXG4gICAgICAgICAgOiBudWxsO1xuICAgICAgY29uc3QgaHVua3MgPVxuICAgICAgICBsaXN0ZWQgPz9cbiAgICAgICAgKFxuICAgICAgICAgIChhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZGlmZlwiLFxuICAgICAgICAgICAgYWdhaW5zdCxcbiAgICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgICAgfSkpIGFzIHsgaHVua3M/OiB7IGlkOiBudW1iZXIgfVtdIH1cbiAgICAgICAgKS5odW5rcz8ubWFwKChoKSA9PiBoLmlkKSA/P1xuICAgICAgICBbXTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJtZXJnZVwiLFxuICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgaHVua3MsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGl2YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ2TlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYWtlIGEgdmVyc2lvbiB0aGUgYWN0aXZlIG9uZSAodGhlIG9uZSB0aGUgaHVtYW4gZWRpdHMgYW5kIFNhdmUgd3JpdGVzKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJhY3RpdmF0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJhY3RpdmF0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibmV3LWRvY1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImNyZWF0ZSBhbiBlbXB0eSBkb2N1bWVudCAoaXRzIGZvbGRlciBtdXN0IGJlIGEgc2V0LCBhIGZvbGRlciBpbiBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFicyA9IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyk7XG4gICAgICByZXR1cm4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2MuY3JlYXRlXCIsIGRpcjogZGlybmFtZShhYnMpLCBuYW1lOiBiYXNlbmFtZShhYnMpIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1mb2xkZXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImNyZWF0ZSBhIGZvbGRlciDigJQgaW5zaWRlIGEgc2V0LCBvciBpbiB0aGUgd29ya3NwYWNlIGFzIGEgbmV3IHNldFwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgICAgICBkaXI6IGRpcm5hbWUoYWJzKSxcbiAgICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1vdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpbnRvXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtb3ZlIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGludG8gYW5vdGhlciBmb2xkZXIgKGEgcmVhbCBtb3ZlIG9uIGRpc2spXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcIm1vdmVcIixcbiAgICAgICAgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSxcbiAgICAgICAgaW50bzogcmVzb2x2ZShwb3NbMV0gYXMgc3RyaW5nKSxcbiAgICAgIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZW5hbWVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJyZW5hbWUgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gcGxhY2VcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwicmVuYW1lXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksIG5hbWU6IHBvc1sxXSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGlkZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgZG9jdW1lbnQsIGZvbGRlciBvciBzZXQgZnJvbSBTY3JpcHRvcml1bSDigJQgdGhlIGZpbGVzIHN0YXkgb24gZGlza1wiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJoaWRlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInVuaGlkZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImVudHJ5XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImJyaW5nIGJhY2sgZXZlcnl0aGluZyBoaWRkZW4gaW4gYSBzZXQgKGl0cyBlbnRyeSBpZCwgZnJvbSBzdGF0ZSlcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJ1bmhpZGVcIiwgZW50cnk6IHBvc1swXSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFrZS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInR1cm4gYSBzaW5nbGUgZG9jdW1lbnQgaW50byBhIHNldDogYSBmb2xkZXIgbmFtZWQgZm9yIGl0LCB0aGUgZG9jdW1lbnQgbW92ZWQgaW5cIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwic2V0Lm1ha2VcIiwgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW1wb3J0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImludG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiZmlsZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjb3B5IGEgZG9jdW1lbnQgaW4gKGRlZmF1bHQ6IGludG8gdGhlIHdvcmtzcGFjZSkgYW5kIHNob3cgdGhlIGNvcHlcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgY21kSW1wb3J0KHBvc1swXSBhcyBzdHJpbmcsIHR5cGVvZiBmbGFncy5pbnRvID09PSBcInN0cmluZ1wiID8gZmxhZ3MuaW50byA6IHVuZGVmaW5lZCwgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndvcmtzcGFjZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImRpclwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHdvcmtzcGFjZSAod2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQpLCBvciBzZXQgaXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kV29ya3NwYWNlKHBvc1swXSwgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ldGFcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBkZXNjcmliZTogXCJhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgYXMgdGhlIGRhZW1vbiByZWFkIGl0IChubyBwYXRoOiBldmVyeSBjb250ZXh0IGRvY3VtZW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWV0YVwiLFxuICAgICAgICAgIC4uLihwb3NbMF0gIT09IHVuZGVmaW5lZCA/IHsgcGF0aDogcmVzb2x2ZShwb3NbMF0pIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmaW5kXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInR5cGVcIiwgXCJzdGF0dXNcIiwgXCJsaWZlY3ljbGVcIiwgXCJ0YWdcIiwgXCJzaW5jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImRvY3VtZW50cyBieSBmcm9udG1hdHRlciDigJQgZmlsdGVycyBBTkQsIGFsbCBvcHRpb25hbDsgYW4gZW1wdHkgcmVzdWx0IGlzIGFuIGFuc3dlciAoY291bnQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpbHRlcjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrIG9mIFtcInR5cGVcIiwgXCJzdGF0dXNcIiwgXCJsaWZlY3ljbGVcIiwgXCJ0YWdcIl0gYXMgY29uc3QpXG4gICAgICAgIGlmICh0eXBlb2YgZmxhZ3Nba10gPT09IFwic3RyaW5nXCIpIGZpbHRlcltrXSA9IGZsYWdzW2tdO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIikgZmlsdGVyLnNpbmNlID0gcGFyc2VTaW5jZURhdGUoZmxhZ3Muc2luY2UpO1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImZpbmRcIiwgZmlsdGVyIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmFwaFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJlbnRyeVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImEgc2V0J3MgbWFwIGFzIEpTT04g4oCUIG5vZGVzLCBlZGdlcyAoYm9keSBsaW5rcyBhbmQgZnJvbnRtYXR0ZXIga2VwdCBhcGFydCksIGRhbmdsaW5nXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYmFja2xpbmtzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ3aGF0IGNpdGVzIGEgZG9jdW1lbnQg4oCUIGByZWxhdGVkYCAoZnJvbnRtYXR0ZXIpIGFuZCBgbGlua3NgIChib2R5KSwga2VwdCBhcGFydFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiYmFja2xpbmtzXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ldGEtaW5pdFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwiYnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwiYWRkIGEgZnJvbnRtYXR0ZXIgYmxvY2sgdG8gYSBkb2N1bWVudCB0aGF0IGhhcyBub25lICh0eXBlIGd1ZXNzZWQgZnJvbSBpdHMgbmVpZ2hib3VycylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLnR5cGUgPT09IFwic3RyaW5nXCIgPyB7IG1ldGFUeXBlOiBmbGFncy50eXBlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5ieSA9PT0gXCJzdHJpbmdcIiA/IHsgYnk6IGZsYWdzLmJ5IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLXNldFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImtleT12YWx1ZVwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNldCBmcm9udG1hdHRlciBrZXlzIOKAlCBvbmUgbGluZSBlZGl0IGVhY2gsIGV2ZXJ5dGhpbmcgZWxzZSB1bnRvdWNoZWRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgICBmb3IgKGNvbnN0IHBhaXIgb2YgcG9zLnNsaWNlKDEpKSB7XG4gICAgICAgIGNvbnN0IGVxID0gcGFpci5pbmRleE9mKFwiPVwiKTtcbiAgICAgICAgaWYgKGVxIDw9IDApXG4gICAgICAgICAgZGllKGBcIiR7cGFpcn1cIiBpcyBub3Qga2V5PXZhbHVlYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBoaW50OiBcIm1ldGEtc2V0IDxwYXRoPiBzdGF0dXM9c3RhYmxlIGxpZmVjeWNsZT1saXZlXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGZpZWxkc1twYWlyLnNsaWNlKDAsIGVxKV0gPSBwYWlyLnNsaWNlKGVxICsgMSk7XG4gICAgICB9XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIm1ldGEuc2V0XCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksIGZpZWxkcyB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJwcmludCB0aGUgcmVzb2x2ZWQgc2Vzc2lvbiBwb2ludGVyXCIsXG4gICAgcnVuOiAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24ocmVxdWlyZVNlc3Npb24oc2Vzc2lvbikpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInNodXQgdGhlIHNlc3Npb24gZG93biAodGhlIG1hbmlmZXN0IHN0YXlzLCBmb3Igb3BlbiAtLXJlc3RvcmUpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pO1xuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IFwiY2xvc2VcIiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImVtaXQgdGhpcyBDTEkncyBhY2MgZGVjbGFyYXRpb24gKHdhbGtlZCBmcm9tIHRoZSBjb21tYW5kIHRhYmxlKVwiLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoYnVpbGREZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJoZWxwXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZVwiLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVySGVscCgpfVxcbmApO1xuICAgIH0sXG4gIH0sXG5dO1xuXG5jb25zdCBST09UX0lOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbmNvbnN0IGZpbmRDb21tYW5kID0gKHRva2VuOiBzdHJpbmcpOiBDb21tYW5kU3BlYyB8IHVuZGVmaW5lZCA9PlxuICBDT01NQU5EUy5maW5kKChjKSA9PiBjLm5hbWUgPT09IHRva2VuKTtcblxuLyoqIFRoZSB2ZXJiIGluIGEgcmF3IGFyZ3YsIGZvdW5kIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsIChhIHN0cmluZyBmbGFnIGNvbnN1bWVzIGl0cyB2YWx1ZSkuICovXG5leHBvcnQgZnVuY3Rpb24gdmVyYlRva2VuKGFyZ3Y6IHN0cmluZ1tdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJndi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGEgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gYXJndltpICsgMV0gPz8gbnVsbDtcbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgIGlmIChhLmluY2x1ZGVzKFwiPVwiKSkgY29udGludWU7XG4gICAgICBjb25zdCBrZXkgPSBhLnNsaWNlKDIpIGFzIEZsYWc7XG4gICAgICBpZiAoa2V5IGluIENMSV9PUFRJT05TICYmIENMSV9PUFRJT05TW2tleV0udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpKSBjb250aW51ZTtcbiAgICByZXR1cm4gYTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IENPTU1BTkRTLm1hcCgoYykgPT4gYy5uYW1lKTtcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IEZsYWdbXT4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gIENPTU1BTkRTLm1hcCgoYykgPT4gW2MubmFtZSwgYy5mbGFnc10pLFxuKTtcbmV4cG9ydCBjb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICBbLi4uKGZpbmRDb21tYW5kKHZlcmIpPy5mbGFncyA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuY29uc3QgcmVuZGVyRmxhZyA9IChrOiBGbGFnKTogc3RyaW5nID0+XG4gIENMSV9PUFRJT05TW2tdLnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG5jb25zdCByZW5kZXJQb3NpdGlvbmFsID0gKHA6IFBvc2l0aW9uYWxTcGVjKTogc3RyaW5nID0+IHtcbiAgY29uc3QgaW5uZXIgPSBwLnZhcmlhZGljID8gYCR7cC5uYW1lfS4uLmAgOiBwLm5hbWU7XG4gIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHVzYWdlT2Yoc3BlYzogQ29tbWFuZFNwZWMpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgIHNwZWMubmFtZSxcbiAgICAuLi5zcGVjLnBvc2l0aW9uYWxzLm1hcChyZW5kZXJQb3NpdGlvbmFsKSxcbiAgICAuLi5zcGVjLmZsYWdzLmZpbHRlcigoaykgPT4gayAhPT0gXCJzZXNzaW9uXCIpLm1hcChyZW5kZXJGbGFnKSxcbiAgXS5qb2luKFwiIFwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckhlbHAoKTogc3RyaW5nIHtcbiAgY29uc3Qgcm93cyA9IENPTU1BTkRTLm1hcCgoYykgPT4gW3VzYWdlT2YoYyksIGMuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihNYXRoLm1heCguLi5yb3dzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gIGNvbnN0IGJvZHkgPSByb3dzXG4gICAgLm1hcCgoW3UsIGRdKSA9PlxuICAgICAgdS5sZW5ndGggPD0gd2lkdGggPyBgICAke3UucGFkRW5kKHdpZHRoKX0gICR7ZH1gIDogYCAgJHt1fVxcbiAgJHtcIlwiLnBhZEVuZCh3aWR0aCl9ICAke2R9YCxcbiAgICApXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIHJldHVybiBgc2NyaXB0b3JpdW0g4oCUIGEgY28tcHJlc2VudCBtYXJrZG93biBlZGl0b3I6IHRoZSBodW1hbiBlZGl0cywgeW91IHdyaXRlIG5ldyB2ZXJzaW9ucy5cblxuJHtib2R5fVxuICAke1JPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OXG5cbiAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIGFueSB2ZXJiIHRoYXQgdGFsa3MgdG8gYSBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuXG4gIEVhY2ggdmVyYiBhY2NlcHRzIG9ubHkgdGhlIGZsYWdzIG9uIGl0cyByb3cuXG5cbiAgT3V0cHV0OiBKU09OIG9uIHN0ZG91dCwgb25lIGRvY3VtZW50IHBlciBhbnN3ZXIg4oCUIGV4Y2VwdCB0YWlsIChvbmUgSlNPTiBsaW5lXG4gIHBlciBldmVudCkgYW5kIGhlbHAgKHByb3NlKS4gRmFpbHVyZXM6IG9uZSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgZXhpdFxuICAyID0gdXNhZ2UsIDEgPSBpbnRlcm5hbCwgNSA9IG5vdCBmb3VuZCwgNiA9IGNvbmZsaWN0LiB0YWlsIHdhaXRzIGZvciBhXG4gIHNlc3Npb24gcmF0aGVyIHRoYW4gZmFpbGluZywgYW5kIGVuZHMgMCB3aGVuIGl0cyBzZXNzaW9uIGNsb3Nlcy5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGREZWNsYXJhdGlvbigpIHtcbiAgY29uc3QgYXJnID0gKGs6IEZsYWcpID0+ICh7IG5hbWU6IGAtLSR7a31gLCB0eXBlOiBDTElfT1BUSU9OU1trXS50eXBlLCBzdGF0dXM6IFwidmFsaWRcIiB9KTtcbiAgcmV0dXJuIHtcbiAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW1wic2NoZW1hXCJdIH0sXG4gICAgY29tbWFuZHM6IFtcbiAgICAgIHtcbiAgICAgICAgcGF0aDogW10gYXMgc3RyaW5nW10sXG4gICAgICAgIGFyZ3M6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsXG4gICAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgICAgIH0pKSxcbiAgICAgICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidmVyYlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICAgIH0sXG4gICAgICAuLi5DT01NQU5EUy5tYXAoKGMpID0+ICh7XG4gICAgICAgIHBhdGg6IFtjLm5hbWVdLFxuICAgICAgICBhcmdzOiBbLi4uYy5mbGFnc10ubWFwKGFyZyksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLFxuICAgICAgfSkpLFxuICAgIF0sXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgLy8gVGhlIGtpdCBkb2VzIG5vdCB0cmlhZ2U7IHRoaXMgZG9lcy4gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlXG4gICAgLy8gKC0tYm9keS1maWxlKSBpcyB0aGUgY2FsbGVyJ3M7IGV2ZXJ5dGhpbmcgZWxzZSBpcyBvdXJzLlxuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IFVzYWdlRXJyb3IobXNnKSkgPz8gMjtcbiAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgbXNnKSkgPz8gMTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGludGVyY2VwdG9yID0gUk9PVF9JTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBhcmd2WzBdKTtcbiAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQgfHwgYXJndlswXSA9PT0gXCJ2ZXJzaW9uXCIpIHtcbiAgICBpZiAoKGludGVyY2VwdG9yPy5ydW5zID8/IFwidmVyc2lvblwiKSA9PT0gXCJoZWxwXCIpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICBlbHNlIHByaW50SnNvbih2ZXJzaW9uSW5mbygpKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGxldCBjdXJyZW50Q29tbWFuZCA9IHZlcmJUb2tlbihhcmd2KTtcbiAgc2V0Q3VycmVudENvbW1hbmQoY3VycmVudENvbW1hbmQpO1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyhhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSB8fCBlLmV4dHJhPy5jaG9pY2VzID09PSB1bmRlZmluZWQpIHRocm93IGU7XG4gICAgY29uc3Qgc3BlYyA9IGN1cnJlbnRDb21tYW5kID09PSBudWxsID8gdW5kZWZpbmVkIDogZmluZENvbW1hbmQoY3VycmVudENvbW1hbmQpO1xuICAgIGlmIChzcGVjICE9PSB1bmRlZmluZWQpXG4gICAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlLm1lc3NhZ2UsIHsgaGludDogZS5leHRyYT8uaGludCwgY2hvaWNlczogZmxhZ3NGb3Ioc3BlYy5uYW1lKSB9KTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlLm1lc3NhZ2UsIHtcbiAgICAgIGhpbnQ6IGBubyB2ZXJiIGdpdmVuIOKAlCB2ZXJiczogJHtWRVJCUy5qb2luKFwiIFwiKX0gKHJ1bjogY2xpLnRzIGhlbHApYCxcbiAgICAgIGNob2ljZXM6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKSxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBbdmVyYiwgLi4ucG9zXSA9IHBhcnNlZC5wb3M7XG4gIGNvbnN0IGZsYWdzID0gcGFyc2VkLmZsYWdzO1xuICBjdXJyZW50Q29tbWFuZCA9IHZlcmIgPz8gbnVsbDtcbiAgc2V0Q3VycmVudENvbW1hbmQoY3VycmVudENvbW1hbmQpO1xuXG4gIGlmICh2ZXJiID09PSB1bmRlZmluZWQpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoXCJubyB2ZXJiIGdpdmVuXCIsIHsgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsIGNob2ljZXM6IFsuLi5WRVJCU10gfSk7XG4gIGNvbnN0IHNwZWMgPSBmaW5kQ29tbWFuZCh2ZXJiKTtcbiAgaWYgKHNwZWMgPT09IHVuZGVmaW5lZClcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihgdW5rbm93biB2ZXJiIFwiJHt2ZXJifVwiYCwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsXG4gICAgICBjaG9pY2VzOiBbLi4uVkVSQlNdLFxuICAgIH0pO1xuXG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oc3BlYy5mbGFncyk7XG4gIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXMoZmxhZ3MpLmZpbmQoKGspID0+ICFhbGxvd2VkLmhhcyhrKSk7XG4gIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBmbGFnc0ZvcihzcGVjLm5hbWUpO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7c3BlYy5uYW1lfVxcYCAoaXQgaXMgYSByZWNvZ25pemVkIHNjcmlwdG9yaXVtIGZsYWcsIGp1c3Qgbm90IHRoaXMgdmVyYidzKWAsXG4gICAgICBhY2NlcHRlZC5sZW5ndGggPiAwID8geyBjaG9pY2VzOiBhY2NlcHRlZCB9IDogeyBoaW50OiBgJHtzcGVjLm5hbWV9IHRha2VzIG5vIGZsYWdzYCB9LFxuICAgICk7XG4gIH1cblxuICBjb25zdCByZXF1aXJlZCA9IHNwZWMucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gIGNvbnN0IHZhcmlhZGljID0gc3BlYy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgaWYgKHBvcy5sZW5ndGggPCByZXF1aXJlZCB8fCAoIXZhcmlhZGljICYmIHBvcy5sZW5ndGggPiBzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aCkpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVzYWdlOiAke3VzYWdlT2Yoc3BlYyl9YCwgeyBoaW50OiBzcGVjLmRlc2NyaWJlIH0pO1xuXG4gIGNvbnN0IHNlc3Npb24gPSB0eXBlb2YgZmxhZ3Muc2Vzc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnNlc3Npb24gOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBzcGVjLnJ1bihwb3MsIGZsYWdzLCBzZXNzaW9uKTtcbiAgcmV0dXJuIHR5cGVvZiBjb2RlID09PSBcIm51bWJlclwiID8gY29kZSA6IDA7XG59XG5cbi8qKlxuICogVGhlIENMSSdzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSLiBSZXR1cm5zIHRoZSBjb2RlIHJhdGhlciB0aGFuIGV4aXRpbmdcbiAqIChzdGRvdXQgaXMgYSBwaXBlOyBhbiBleHBsaWNpdCBleGl0IHRydW5jYXRlcyBpdCksIGFuZCB0YWtlcyBubyBhcmd1bWVudHNcbiAqICh0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBwYXJzZXMgaXQpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7IG1haW4gfTtcbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRlcGVuZGVuY3ktZnJlZSBhbmQgZGVsaWJlcmF0ZWx5IGR1bGw6IGl0IGlzIGJ1bmRsZWQgSU5UTyBlYWNoXG4gKiBzcGVsbCdzIGVtaXR0ZWQgQ0xJIChDb250cmFjdCA0J3MgYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLCBzbyBhbnl0aGluZyBpdFxuICogcmVhY2hlZCBmb3Igd291bGQgYmVjb21lIGEgZGVwZW5kZW5jeSBvZiB0d28gc2hpcHBlZCBhcnRpZmFjdHMgYXQgb25jZS5cbiAqXG4gKiBUaGUgd2lyZSBjb250cmFjdCBpdCBlbmNvZGVzOiBleGFjdGx5IG9uZSBKU09OIGRvY3VtZW50LCBvbmUgdHJhaWxpbmdcbiAqIG5ld2xpbmUsIG5vdGhpbmcgZWxzZSBvbiBzdGRvdXQuIEEgY2FsbGVyIHJlYWRpbmcgb3VyIHN0ZG91dCB3aXRoIGFcbiAqIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBkZXBlbmRzIG9uIHRoYXQgbmV3bGluZTsgYSBjYWxsZXIgcmVhZGluZyB0byBFT0ZcbiAqIGRlcGVuZHMgb24gdGhlcmUgYmVpbmcgbm8gc2Vjb25kIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pOiB2b2lkIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLiAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiAqL1xuICB0ZXJtaW5hbD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKTogeyBmcmFtZTogU3NlRnJhbWUgfCBudWxsOyBjb21tZW50czogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHJldHVybiBjb2RlO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2KSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOztBQWdEQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBVUE7QUFDQTtBQUNBLHNCQUFTOzs7QUN0Q0YsU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBOzs7QUM2QjNDLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFB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
