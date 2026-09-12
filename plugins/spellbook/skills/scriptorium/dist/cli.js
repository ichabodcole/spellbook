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
    name: "version-delete",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "vN", required: true }],
    describe: "remove a version and its file (never the active one \u2014 activate another first)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "version.delete",
        version: parseVersion(pos[0] ?? "", "version-delete"),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
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

//# debugId=3444B220D55DF6EF64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSBDTEkg4oCUIHRoZSBhZ2VudCdzIGhhbGYuIEEgdGhpbiBjbGllbnQgb2YgdGhlIHBlci1zZXNzaW9uIGRhZW1vblxuICogKGBzZXJ2ZXIudHNgKTogYG9wZW5gIHNwYXducyBvbmUsIGV2ZXJ5IG90aGVyIHZlcmIgZmluZHMgaXQgdGhyb3VnaCB0aGVcbiAqIHNlc3Npb24gcG9pbnRlciBpbiB0bXBkaXIgKEUxMykgYW5kIHNwZWFrcyBIVFRQLiBgdGFpbGAgc3RyZWFtcyB0aGUgaHVtYW4nc1xuICogbWVzc2FnZXMgYXMgSlNPTiBsaW5lcyBmb3IgTW9uaXRvciB0byB3cmFwLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBOT05FIGNhcnJpZWQgYmV5b25kIHdoYXQgaXMgdHJ1ZSBhdCB0aGUgZW1pdHRlZCBhZGRyZXNzLlxuICogICAgRnJvbSBgZGlzdC9jbGkuanNgLCBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIsIHNvIHRoZSBkYWVtb24gbGF1bmNoZXIgaXNcbiAqICAgIGAuLi9zY3JpcHRzL3NlcnZlci50c2AgKHVwIGFuZCBiYWNrIGRvd24g4oCUIG5ldmVyIGEgZmxhdCBzaWJsaW5nKSwgYW5kIHRoZVxuICogICAgZGV2IGN3ZCBpcyBgc3JjL3NjcmlwdG9yaXVtL2AgZml2ZSBsZXZlbHMgdXAgKENvbnRyYWN0IDUpLCB1c2VkIG9ubHkgd2hlblxuICogICAgZGV2IG1vZGUgaXMgcmVzb2x2ZWQuXG4gKiAyLiBTZXJ2ZXM6IG5vLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgc2hhcmVzIGAuL2hlYXJ0YmVhdC50c2Agd2l0aCB0aGUgZGFlbW9uICh0aGUgdGFpbFxuICogICAgd2F0Y2hkb2cgaXMgZGVyaXZlZCBmcm9tIHRoZSBkYWVtb24ncyBoZWFydGJlYXQsIG5ldmVyIGNvcGllZCkuXG4gKiA0LiBMaWZlY3ljbGU6IHNpbmdsZS1zaG90IHBlciB2ZXJiOyBgdGFpbGAgaXMgbG9uZy1ydW5uaW5nIGFuZCByZXR1cm5zIGl0c1xuICogICAgb3duIGV4aXQgY29kZS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDihpIgTkFUVVJBTC1SRVRVUk5cbiAqICAgIGxhdW5jaGVyIChgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IHJ1bigpYCk6IHN0ZG91dCBpcyBhIHBpcGUgdGhlIGFnZW50XG4gKiAgICBwYXJzZXMsIGFuZCBhbiBleHBsaWNpdCBleGl0IHRydW5jYXRlcyBpdCBhdCA2NCBLaUIuIGBvcGVuYCByZWxlYXNlcyB0aGVcbiAqICAgIGRhZW1vbidzIHN0ZG91dCBwaXBlIHNvIHRoZSBuYXR1cmFsIHJldHVybiBpcyBub3QgaGVsZCBvcGVuIGJ5IGl0LlxuICogNi4gRXZlbnQgaWRzIGFjcm9zcyByZXN0YXJ0OiB0aGUgZGFlbW9uJ3MgYXJlIHBlci1ib290IGFuZCBlcG9jaC1zdGFtcGVkO1xuICogICAgdGhpcyBzaWRlIHJlc2V0cyBpdHMgY3Vyc29yIG9uIGFuIGVwb2NoIGNoYW5nZSBhbmQgc2F5cyBzbyBpbiBvbmUgbGluZS5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IG5vLlxuICpcbiAqIOKUgOKUgCBFUlJPUiBDT05UUkFDVCAoYWNjIEwwLCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV2ZXJ5IGZhaWx1cmUgaXMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyLCBzdGRvdXQgZW1wdHkg4oCUXG4gKiAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbiAqICAgdXNhZ2Ug4oaSIDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IMK3IGNvbmZsaWN0IOKGkiA2XG4gKiBBIGRhZW1vbiByZWZ1c2FsIG1hcHMgb2ZmIGl0cyBIVFRQIHN0YXR1cyAoNDAwIHVzYWdlLCA0MDQgbm90X2ZvdW5kLCA0MDlcbiAqIGNvbmZsaWN0LCBlbHNlIGludGVybmFsKTsgdGhlIGRhZW1vbidzIGJvZHkgcmlkZXMgdmVyYmF0aW0gdW5kZXJcbiAqIGBlcnJvci5zZXJ2ZXJgLCBhbmQgd2hlbiB0aGUgZGFlbW9uIG5hbWVkIHRoZSB2YWxpZCBzZXQgKGEgZG9jIHNsdWcsIGFcbiAqIHZlcnNpb24pIHRoYXQgc2V0IGlzIEFMU08gbGlmdGVkIGludG8gYGNob2ljZXNgIOKAlCBBMTogdGhlIHNldCBpcyBpbiBoYW5kIGF0XG4gKiB0aGUgcmFpc2UsIGJlY2F1c2UgdGhlIGRhZW1vbiBoYW5kZWQgaXQgb3Zlci5cbiAqXG4gKiDim5QgVGhlIGtpdCBjYXJyaWVzIHRoZSBFTlZFTE9QRSwgbm90IHRoZSBDTEFTU0lGSUVSOiBgcmVwb3J0Q2xpRXJyb3JgXG4gKiByZXR1cm5zIG51bGwgZm9yIGEgbm9uLUNsaUVycm9yLCBhbmQgYG1haW5gIGJlbG93IHRyaWFnZXMgRU5PRU5UIChhIG5hbWVkXG4gKiBmaWxlIHRoZSBjYWxsZXIgZ2F2ZSkgaW50byB1c2FnZSBhbmQgZXZlcnl0aGluZyBlbHNlIGludG8gaW50ZXJuYWwuXG4gKlxuICogRDggcmVhY2hhYmlsaXR5LCBhdWRpdGVkIGJ5IGNhbGwgZ3JhcGg6IGV2ZXJ5IGBkaWVgIGhlcmUgaXMgcmVhY2hlZCBmcm9tIGFcbiAqIHZlcmIgaGFuZGxlciBvciBgZGlzcGF0Y2hgLCBub25lIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLiBUaGVcbiAqIHN3YWxsb3dpbmcgY2F0Y2hlcyAoYGFwaWAncyBub24tSlNPTiBib2R5LCBgdmVyc2lvbkluZm9gLCBgcG9zdENtZGAncyBjbG9zZVxuICogRUNPTk5SRVNFVCkgY29udGFpbiBubyBkaWUtcmVhY2hhYmxlIGNhbGwuXG4gKi9cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBjbG9zZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgb3BlblN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHN0YXRTeW5jLFxuICB1bmxpbmtTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyBwcmludEpzb24gfSBmcm9tIFwiLi4vLi4va2l0L2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7XG4gIENsaUVycm9yLFxuICBkaWUsXG4gIHR5cGUgRXJyS2luZCxcbiAgcmVwb3J0Q2xpRXJyb3IsXG4gIHNldEN1cnJlbnRDb21tYW5kLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQgeyB0YWlsRXZlbnRzIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxFdmVudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgRE9DX0VYVEVOU0lPTlMsIGlzRG9jTmFtZSB9IGZyb20gXCIuL3RyZWVcIjtcblxuLy8g4pqgIERFQ0xBUkVEIEZJUlNULCBBQk9WRSBFVkVSWSBPVEhFUiBGVU5DVElPTiwgT04gUFVSUE9TRS4gVGhlIGBjaG9pY2VzYFxuLy8gY2Vuc3VzJ3MgcmFpc2VyIHJ1bGUgKGEpIChgZ3JpbW9pcmUvbGliL2Vycm9yLXNpdGVzLnRzYCkgbWF0Y2hlc1xuLy8gYGZ1bmN0aW9uIE5BTUUoYCBsYXppbHkgdXAgdG8gdGhlIG5leHQgYCk6IG5ldmVyYCB3aXRoaW4gNjAwIGNoYXJhY3RlcnMsIHNvXG4vLyBBTlkgZnVuY3Rpb24gZGVjbGFyZWQgc2hvcnRseSBhYm92ZSB0aGlzIG9uZSDigJQgYGFwaWAsIHRoZW4gYHJlcXVpcmVTZXNzaW9uYCDigJRcbi8vIHdhcyByZWFkIGFzIGEgcmFpc2VyIGFuZCBpdHMgY2FsbHMgY291bnRlZCBhcyByYWlzZSBzaXRlcyAoZm91bmQgMjAyNi0wOS0xMSxcbi8vIHJlcG9ydGVkIGluIHRoZSBzbGljZS1BIGpvdXJuYWwgYXMgYW4gaW5zdHJ1bWVudCBkZWZlY3QsIG5vdCBmaXhlZCBoZXJlKS5cbmZ1bmN0aW9uIGRhZW1vblJlZnVzZWQod2hhdDogc3RyaW5nLCBzdGF0dXM6IG51bWJlciwgZGF0YTogdW5rbm93bik6IG5ldmVyIHtcbiAgY29uc3Qga2luZDogRXJyS2luZCA9XG4gICAgc3RhdHVzID09PSA0MDBcbiAgICAgID8gXCJ1c2FnZVwiXG4gICAgICA6IHN0YXR1cyA9PT0gNDA0XG4gICAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgICA6IHN0YXR1cyA9PT0gNDA5XG4gICAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgICA6IFwiaW50ZXJuYWxcIjtcbiAgY29uc3QgYm9keSA9IChkYXRhID8/IHt9KSBhcyB7IGVycm9yPzogdW5rbm93bjsgY2hvaWNlcz86IHVua25vd24gfTtcbiAgY29uc3QgY2hvaWNlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5jaG9pY2VzKSA/IGJvZHkuY2hvaWNlcy5tYXAoU3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgZGllKHR5cGVvZiBib2R5LmVycm9yID09PSBcInN0cmluZ1wiID8gYm9keS5lcnJvciA6IGAke3doYXR9IGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwga2luZCwge1xuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbih0bXBkaXIoKSwgc2Vzc2lvbiA/IGBzY3JpcHRvcml1bS0ke3Nlc3Npb259Lmpzb25gIDogXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0Ug4oCUIEVOT0VOVCBpcyB0aGUgb25seSBhYnNlbmNlLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb25Qb2ludGVyO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBsZXQgc3RhdHVzOiBudW1iZXI7XG4gIGxldCBkYXRhOiB1bmtub3duO1xuICB0cnkge1xuICAgICh7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYGNsb3NlYCBzdG9wcyB0aGUgc2VydmVyOyBhIFJFU0VUIGlzIGl0cyBzdWNjZXNzLiBBIHJlZnVzZWQgY29ubmVjdGlvblxuICAgIC8vIChhIHN0YWxlIHBvaW50ZXIpIGlzIGEgdHJhbnNwb3J0IGZhaWx1cmUgbGlrZSBhbnkgb3RoZXIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zdCBjb2RlID0gZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyID8gU3RyaW5nKGVyci5jb2RlKSA6IFwiXCI7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSlcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChTdHJpbmcobXNnLnR5cGUpLCBzdGF0dXMsIGRhdGEpO1xuICByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuLy8g4pSA4pSAIHRoZSBwYXJzZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjb250ZXh0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZW50cnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW5rczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaWZlY3ljbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHBhdGNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0eXBlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBSRUNPR05JWkVEX0ZMQUdTID0gT2JqZWN0LmtleXMoQ0xJX09QVElPTlMpLm1hcCgoaykgPT4gYC0tJHtrfWApO1xuXG5leHBvcnQgY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0pIHtcbiAgICBzdXBlcihcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3M6IHN0cmluZ1tdKToge1xuICBwb3M6IHN0cmluZ1tdO1xuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG59IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJncyxcbiAgICAgIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4geyBwb3M6IHBvc2l0aW9uYWxzLCBmbGFnczogdmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+IH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBkZXRhaWwgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIHsgY29kZT86IHN0cmluZyB9KS5jb2RlO1xuICAgIC8vIE9ubHkgYW4gVU5LTk9XTiBvcHRpb24gbmFtZXMgdGhlIGZsYWcgcm9zdGVyOyB0aGUgb3RoZXIgcGFyc2UgZmFpbHVyZXNcbiAgICAvLyBtZWFuIGEgcmVjb2duaXNlZCBmbGFnIHdhcyBtaXN1c2VkLCBhbmQgdGhlIHJvc3RlciB3b3VsZCBuYW1lIHRoZSBoYWxmXG4gICAgLy8gdGhhdCB3YXMgcmlnaHQuXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZGV0YWlsLCB7XG4gICAgICBoaW50OiBcImZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMsIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1cIixcbiAgICAgIC4uLihjb2RlID09PSBcIkVSUl9QQVJTRV9BUkdTX1VOS05PV05fT1BUSU9OXCIgPyB7IGNob2ljZXM6IFJFQ09HTklaRURfRkxBR1MgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxufVxuXG4vKipcbiAqIGAtLXNpbmNlYCBpcyBhbiBldmVudCBpZDogYW4gaW50ZWdlciwgLTEgZm9yIFwiZXZlcnl0aGluZ1wiLiBWZXJpZnktcGFzcyBmaXhcbiAqIDk6IGAtLXNpbmNlIGFiY2AgcGFyc2VkIHRvIE5hTiwgd2hpY2ggdGhlIGxvZyByZWFkcyBhcyBcImZyb20gdGhlIHN0YXJ0XCIsIHNvXG4gKiBhIHR5cG8gcmVwbGF5ZWQgdGhlIHdob2xlIGJ1ZmZlciBpbnRvIHRoZSBhZ2VudCdzIHBpcGUgYXQgZXhpdCAwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaW5jZSh0b2tlbjogc3RyaW5nKTogbnVtYmVyIHtcbiAgaWYgKCEvXi0/XFxkKyQvLnRlc3QodG9rZW4udHJpbSgpKSlcbiAgICBkaWUoXG4gICAgICBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhbiBldmVudCBpZCDigJQgZ2l2ZSBhbiBpbnRlZ2VyICh0aGUgaWQgb2YgdGhlIGxhc3QgbGluZSB5b3Ugc2F3KWAsXG4gICAgICBcInVzYWdlXCIsXG4gICAgKTtcbiAgcmV0dXJuIE51bWJlci5wYXJzZUludCh0b2tlbiwgMTApO1xufVxuXG4vKipcbiAqIGBmaW5kIC0tc2luY2VgIGlzIGEgREFURSwgd2hlcmUgYHRhaWwgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQg4oCUIHRoZSBmbGFnIGlzXG4gKiBzaGFyZWQsIHRoZSBtZWFuaW5nIGlzIHRoZSB2ZXJiJ3MsIGFuZCBwZG9jcyBzcGVsbHMgdGhpcyBvbmUgYC0tc2luY2VgIHRvby5cbiAqIEEgdHlwbyBtdXN0IG5vdCBzaWxlbnRseSB3aWRlbiB0aGUgc2VhcmNoLCBzbyBhIG5vbi1kYXRlIGlzIGEgdXNhZ2UgZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlRGF0ZSh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh0KSB8fCBOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZSh0KSkpXG4gICAgZGllKGBmaW5kIC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBkYXRlIOKAlCB3cml0ZSBpdCBhcyBZWVlZLU1NLUREYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHQ7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vKiogQSBub24tbmVnYXRpdmUgd2hvbGUgbnVtYmVyIGZyb20gYSBmbGFnLCByZWZ1c2VkIHJhdGhlciB0aGFuIGNvZXJjZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb3VudCh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QodCkpIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHdob2xlIG51bWJlcmAsIFwidXNhZ2VcIik7XG4gIHJldHVybiBOdW1iZXIodCk7XG59XG5cbi8qKlxuICogQSBjb21wYXJpc29uIHNpZGU6IGEgdmVyc2lvbiwgb3IgdGhlIGZpbGUgb2YgcmVjb3JkLiBgb3JpZ2luYWxgIGlzIHNwZWxsZWRcbiAqIG91dCByYXRoZXIgdGhhbiBvZmZlcmVkIGFzIGB2MGAg4oCUIGEgemVyb3RoIHZlcnNpb24gd291bGQgcmVhZCBsaWtlIHRoZVxuICogZWFybGllc3Qgb25lLCBhbmQgdGhlIG9yaWdpbmFsIGlzIG5vdCBwYXJ0IG9mIHRoZSB2ZXJzaW9uIGxpbmUgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaWRlKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB8IFwib3JpZ2luYWxcIiB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKHQgPT09IFwib3JpZ2luYWxcIiB8fCB0ID09PSBcImZpbGVcIikgcmV0dXJuIFwib3JpZ2luYWxcIjtcbiAgcmV0dXJuIHBhcnNlVmVyc2lvbih0b2tlbiwgd2hhdCk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqXG4gKiDim5QgVkVSSUZZLVBBU1MgRklYIDU6IGV2ZXJ5IHBhdGggaXMgY2hlY2tlZCBIRVJFLCBiZWZvcmUgYW55IGRhZW1vbiBleGlzdHMuXG4gKiBgb3BlbiBkb2MubWQgcGljLnBuZ2AgdXNlZCB0byBzcGF3biBhIHNlc3Npb24sIHRoZW4gZmFpbCBvbiB0aGUgc2Vjb25kIHBhdGhcbiAqIGluc2lkZSBpdCDigJQgbGVhdmluZyBhIHJ1bm5pbmcgZGFlbW9uIGFuZCBhIGxpdmUgcG9pbnRlciBiZWhpbmQgYSBmYWlsZWRcbiAqIGNvbW1hbmQuIEEgZm9sZGVyIG9yIGEgZG9jdW1lbnQgaXMgYWNjZXB0ZWQ7IGEgbWlzc2luZyBwYXRoIGlzIG5vdF9mb3VuZCwgYVxuICogbm9uLWRvY3VtZW50IGZpbGUgaXMgdXNhZ2Ugd2l0aCB0aGUgYWNjZXB0ZWQgZXh0ZW5zaW9ucyBhcyBgY2hvaWNlc2AuXG4gKi9cbmZ1bmN0aW9uIGNvbnRleHRQYXRocyhwb3M6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBwYXRocyA9IHBvcy5tYXAoKHApID0+IHJlc29sdmUocCkpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcbiAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICB0cnkge1xuICAgICAgc3QgPSBzdGF0U3luYyhwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGRpZShgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHtwfWAsIFwibm90X2ZvdW5kXCIpO1xuICAgIH1cbiAgICBpZiAoIXN0LmlzRGlyZWN0b3J5KCkgJiYgIWlzRG9jTmFtZShwKSlcbiAgICAgIGRpZShgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7cH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogXCJhZGQgYSBmb2xkZXIsIG9yIGEgZmlsZSB3aXRoIG9uZSBvZiB0aGVzZSBleHRlbnNpb25zXCIsXG4gICAgICAgIGNob2ljZXM6IFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gcGF0aHM7XG59XG5cbi8qKlxuICogYC0tZG9jYCBhcyB0aGUgQ0xJJ3MgY2FsbGVyIG1lYW50IGl0ICh2ZXJpZnktcGFzcyBmaXggOCk6IGEgdG9rZW4gd2l0aCBhIHBhdGhcbiAqIHNlcGFyYXRvciwgb3Igb25lIG5hbWluZyBhIGZpbGUgaW4gVEhJUyBwcm9jZXNzJ3MgY3dkLCBpcyByZXNvbHZlZCBoZXJlIHRvIGFuXG4gKiBhYnNvbHV0ZSBwYXRoIOKAlCB0aGUgZGFlbW9uJ3MgY3dkIGlzIG5vdCB0aGUgY2FsbGVyJ3MuIEFueXRoaW5nIGVsc2UgKGEgc2x1ZyxcbiAqIGEgdW5pcXVlIGZpbGUgbmFtZSkgZ29lcyBhcyB0eXBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY0FyZyh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHRva2VuLmluY2x1ZGVzKFwiL1wiKSB8fCBleGlzdHNTeW5jKHJlc29sdmUodG9rZW4pKSkgcmV0dXJuIHJlc29sdmUodG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbi8qKiBLZWVwIHRoZSBuZXdlc3QgYExPR19LRUVQIC0gMWAgZGFlbW9uIGxvZ3MsIHNvIHRoZSBvbmUgYWJvdXQgdG8gYmUgd3JpdHRlbiBtYWtlcyBgTE9HX0tFRVBgLiAqL1xuY29uc3QgTE9HX0tFRVAgPSAxMDtcbmZ1bmN0aW9uIHBydW5lTG9ncyhsb2dEaXI6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgbmFtZXMgPSByZWFkZGlyU3luYyhsb2dEaXIpLmZpbHRlcigobikgPT4gL15kYWVtb24tXFxkKy1cXGQrXFwubG9nJC8udGVzdChuKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBieUFnZSA9IG5hbWVzLnNvcnQoKGEsIGIpID0+IE51bWJlcihhLnNwbGl0KFwiLVwiKVsxXSkgLSBOdW1iZXIoYi5zcGxpdChcIi1cIilbMV0pKTtcbiAgZm9yIChjb25zdCBuIG9mIGJ5QWdlLnNsaWNlKDAsIE1hdGgubWF4KDAsIGJ5QWdlLmxlbmd0aCAtIChMT0dfS0VFUCAtIDEpKSkpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhqb2luKGxvZ0RpciwgbikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG5cbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIGZsYWdzLnJlc3RvcmUsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWFuaWZlc3QpKSB7XG4gICAgICBsZXQgc2F2ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICB0cnkge1xuICAgICAgICBzYXZlZCA9IChcbiAgICAgICAgICBhd2FpdCBBcnJheS5mcm9tQXN5bmMobmV3IEJ1bi5HbG9iKFwiKi9tYW5pZmVzdC5qc29uXCIpLnNjYW4oam9pbihob21lLCBcInNlc3Npb25zXCIpKSlcbiAgICAgICAgKS5tYXAoKHApID0+IHAuc3BsaXQoXCIvXCIpWzBdIGFzIHN0cmluZyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm8gc2Vzc2lvbnMgZm9sZGVyOiB0aGUgc2V0IGlzIGVtcHR5LCBhbmQgc2F5cyBzbyAqL1xuICAgICAgfVxuICAgICAgZGllKGBubyBzYXZlZCBzZXNzaW9uIFwiJHtmbGFncy5yZXN0b3JlfVwiIHVuZGVyICR7aG9tZX1gLCBcIm5vdF9mb3VuZFwiLCB7XG4gICAgICAgIGNob2ljZXM6IHNhdmVkLnNvcnQoKSxcbiAgICAgICAgLi4uKHNhdmVkLmxlbmd0aCA9PT0gMCA/IHsgaGludDogXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWVcIiB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxpdmUgPSByZWFkU2Vzc2lvbihmbGFncy5yZXN0b3JlKTtcbiAgICBpZiAobGl2ZSkge1xuICAgICAgY29uc3QgYWxpdmUgPSBhd2FpdCBhcGkobGl2ZS5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKS50aGVuKFxuICAgICAgICAocikgPT4gci5zdGF0dXMgPT09IDIwMCxcbiAgICAgICAgKCkgPT4gZmFsc2UsXG4gICAgICApO1xuICAgICAgaWYgKGFsaXZlKVxuICAgICAgICBkaWUoYHNlc3Npb24gJHtmbGFncy5yZXN0b3JlfSBpcyBhbHJlYWR5IHJ1bm5pbmcgYXQgJHtsaXZlLnVybH1gLCBcImNvbmZsaWN0XCIsIHtcbiAgICAgICAgICBoaW50OiBgdXNlIGl0OiBjbGkudHMgc3RhdGUgLS1zZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX1gLFxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBkYWVtb25BcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAodHlwZW9mIGZsYWdzLnRpbWVvdXQgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBmbGFncy50aW1lb3V0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgZmxhZ3MucmVzdG9yZSk7XG4gIC8vIEUyMzogYSBuZXcgc2Vzc2lvbidzIHdvcmtzcGFjZSBpcyB3aGVyZSBgb3BlbmAgcmFuLiBBIHJlc3RvcmVkIG9uZSBrZWVwcyBpdHMgb3duLlxuICBlbHNlIGRhZW1vbkFyZ3MucHVzaChcIi0td29ya3NwYWNlXCIsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSlcbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCB3aGljaCBuZWVkcyBzcmMvc2NyaXB0b3JpdW0vIOKAlCByZWluc3RhbGwgdGhlIHNwZWxsIG9yIGJ1aWxkIGl0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIC8vIFRoZSBkYWVtb24ncyBzdGRlcnIgZ29lcyB0byBhIExPRyBGSUxFLCBub3QgdG8gdGhpcyBDTEkncyBzdGRlcnIuIEFuXG4gIC8vIGluaGVyaXRlZCBzdGRlcnIgb3V0bGl2ZXMgdGhlIENMSSBpbnNpZGUgdGhlIGRldGFjaGVkIGRhZW1vbiwgc28gYW55IGNhbGxlclxuICAvLyB0aGF0IHJlYWRzIGBvcGVuYCdzIHN0ZGVyciB0byBFT0YgKGEgdGVzdCBoYXJuZXNzLCBhIHRvb2wgcnVubmVyKSB3YWl0cyBmb3JcbiAgLy8gdGhlIHdob2xlIHNlc3Npb24g4oCUIG1lYXN1cmVkOiB0aGUgaW50ZWdyYXRpb24gY2VsbCBodW5nIGF0IGl0cyA2MCBzIHRpbWVvdXQuXG4gIC8vIEEgZmlsZSBob2xkcyBubyBwaXBlLCBhbmQgYSBzdGFydCBmYWlsdXJlIGJlbG93IHF1b3RlcyBpdHMgdGFpbC5cbiAgY29uc3QgbG9nRGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJsb2dzXCIpO1xuICBta2RpclN5bmMobG9nRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IHRoZSBsb2dzIHVzZWQgdG8gcGlsZSB1cCwgb25lIHBlciBgb3BlbmAsIGZvcmV2ZXIuXG4gIHBydW5lTG9ncyhsb2dEaXIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihsb2dEaXIsIGBkYWVtb24tJHtEYXRlLm5vdygpfS0ke3Byb2Nlc3MucGlkfS5sb2dgKTtcbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1sb2dcIiwgbG9nUGF0aCk7XG4gIGNvbnN0IGxvZ0ZkID0gb3BlblN5bmMobG9nUGF0aCwgXCJhXCIpO1xuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgbG9nRmRdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjbG9zZVN5bmMobG9nRmQpO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0sIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBsaW5lID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzLCByZWopID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWooXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgcGFzcyAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+YCxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgc3RhcnRUaW1lb3V0TXMsXG4gICAgKTtcbiAgICBjaGlsZC5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWooZXJyKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImV4aXRcIiwgKGNvZGUpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWoobmV3IEVycm9yKGBkYWVtb24gZXhpdGVkIHdpdGggY29kZSAke2NvZGV9IGJlZm9yZSBpdHMgaGFuZHNoYWtlYCkpO1xuICAgIH0pO1xuICB9KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgbGV0IHRhaWwgPSBcIlwiO1xuICAgIHRyeSB7XG4gICAgICB0YWlsID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmOFwiKS50cmltKCkuc2xpY2UoLTgwMCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBsb2cgd3JpdHRlbiAqL1xuICAgIH1cbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gZGFlbW9uIGZhaWxlZCB0byBzdGFydDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHsgaGludDogdGFpbCA/IGBkYWVtb24gbG9nICgke2xvZ1BhdGh9KTogJHt0YWlsfWAgOiBgZGFlbW9uIGxvZzogJHtsb2dQYXRofWAgfSxcbiAgICApO1xuICB9KTtcblxuICAvLyBSZWxlYXNlIHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSwgb3IgdGhpcyBDTEkncyBuYXR1cmFsIHJldHVybiB3YWl0cyBvbiBhXG4gIC8vIHN0cmVhbSB0aGF0IG5ldmVyIGNsb3NlcyAoZ2xhbW91ciBtZWFzdXJlZCA5MSBzIOKGkiAxIHMpLiBDaGVja2VkIGZvciB0aGVcbiAgLy8gTUVUSE9EOiB1bmRlciBCdW4gdGhpcyBwaXBlIGlzIGEgcGxhaW4gUmVhZGFibGUgdGhhdCBub25ldGhlbGVzcyBoYXMgdW5yZWYuXG4gIGNvbnN0IG91dCA9IGNoaWxkLnN0ZG91dDtcbiAgaWYgKCFvdXQgfHwgIShcInVucmVmXCIgaW4gb3V0KSB8fCB0eXBlb2Ygb3V0LnVucmVmICE9PSBcImZ1bmN0aW9uXCIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzY3JpcHRvcml1bTogdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlIGhhcyBubyB1bnJlZigpOyBgb3BlbmAgd291bGQgbmV2ZXIgZXhpdFwiLFxuICAgICk7XG4gIG91dC51bnJlZigpO1xuXG4gIGxldCBoczoge1xuICAgIHVybDogc3RyaW5nO1xuICAgIHBvcnQ6IG51bWJlcjtcbiAgICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gICAgb2s/OiBib29sZWFuO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfTtcbiAgdHJ5IHtcbiAgICBocyA9IEpTT04ucGFyc2UobGluZSk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7bGluZX1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIGlmIChocy5vayA9PT0gZmFsc2UpIGRhZW1vblJlZnVzZWQoXCJvcGVuXCIsIGhzLnN0YXR1cyA/PyA1MDAsIGhzKTtcblxuICBsZXQgZW50cmllczogdW5rbm93bltdID0gW107XG4gIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgciA9IGF3YWl0IHBvc3RDbWQoaHMuc2Vzc2lvbl9pZCwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pO1xuICAgIGVudHJpZXMgPSAoci5lbnRyaWVzIGFzIHVua25vd25bXSkgPz8gW107XG4gIH1cbiAgcHJpbnRKc29uKHsgLi4uaHMsIC4uLihwYXRocy5sZW5ndGggPiAwID8geyBlbnRyaWVzIH0gOiB7fSkgfSk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW2hzLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWRkKHBvczogc3RyaW5nW10sIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZ1bGw6IGJvb2xlYW4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiP2Z1bGw9MVwiIDogXCJcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IFwic2F5IG5lZWRzIGEgbWVzc2FnZVwiXG4gICAgICAgIDogXCJzYXkgdGFrZXMgaXRzIG1lc3NhZ2UgZnJvbSBleGFjdGx5IG9uZSBwbGFjZTogYXJndW1lbnRzLCAtLXN0ZGluIG9yIC0tYm9keS1maWxlXCIsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZ2l2ZSB0aGUgdGV4dCBhcyBhcmd1bWVudHMsIG9yIHByb3NlIHRocm91Z2ggLS1ib2R5LWZpbGUgPHBhdGg+IC8gLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIixcbiAgICAgICAgY2hvaWNlczogW1wiLS1zdGRpblwiLCBcIi0tYm9keS1maWxlXCJdLFxuICAgICAgfSxcbiAgICApO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBpZiAoZmxhZ3Muc3RkaW4gPT09IHRydWUpIHRleHQgPSBhd2FpdCBuZXcgUmVzcG9uc2UoQnVuLnN0ZGluLnN0cmVhbSgpKS50ZXh0KCk7XG4gIGVsc2UgaWYgKHR5cGVvZiBmbGFnc1tcImJvZHktZmlsZVwiXSA9PT0gXCJzdHJpbmdcIikgdGV4dCA9IHJlYWRGaWxlU3luYyhmbGFnc1tcImJvZHktZmlsZVwiXSwgXCJ1dGY4XCIpO1xuICBlbHNlIHRleHQgPSBwb3Muam9pbihcIiBcIik7XG4gIGlmICghdGV4dC50cmltKCkpIGRpZShcInNheTogdGhlIG1lc3NhZ2UgaXMgZW1wdHlcIiwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHRleHQudHJpbSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2U6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0+KHtcbiAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgIH0sXG4gICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgaWYgKGV2ZXJSZXNvbHZlZCkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgfSxcbiAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICBzaW5jZSxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAvLyBBIGRpZmZlcmVudCBlcG9jaCBvbiByZWNvbm5lY3QgPSB0aGUgZGFlbW9uIHJlc3RhcnRlZDsgaWRzIGJlZ2FuIGFnYWluLlxuICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICBvbkNvbW1lbnQ6ICgpID0+IFwiOiBzY3JpcHRvcml1bS1rZWVwYWxpdmVcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuXG50eXBlIEZsYWcgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgZmxhZ3M6IHJlYWRvbmx5IEZsYWdbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIHJ1bjogKFxuICAgIHBvczogc3RyaW5nW10sXG4gICAgZmxhZ3M6IEZsYWdzLFxuICAgIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgKSA9PiBQcm9taXNlPG51bWJlcj4gfCBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcbn07XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IENPTU1BTkRTOiBDb21tYW5kU3BlY1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInNwYXduIGEgc2Vzc2lvbiAob3BlbnMgdGhlIGJyb3dzZXIpLCBhZGRpbmcgcGF0aHM7IHByaW50cyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0aGUgaHVtYW4ncyBtZXNzYWdlcyAod2l0aCBzZWxlY3Rpb24gKyBhY3RpdmUgcGF0aCkgYXMgSlNPTiBsaW5lcyDigJQgd3JhcCB3aXRoIE1vbml0b3JcIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZFRhaWwoc2Vzc2lvbiwgdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VTaW5jZShmbGFncy5zaW5jZSkgOiAtMSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tbmV3XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZyb21cIiwgXCJsYWJlbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIHZlcnNpb24gKGRlZmF1bHQ6IHRoZSBhY3RpdmUgb25lKSB0byBhIG5ldyBmaWxlOyBwcmludHMgaXRzIHBhdGggdG8gZWRpdFwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gdHlwZW9mIGZsYWdzLmZyb20gPT09IFwic3RyaW5nXCIgPyBwYXJzZVZlcnNpb24oZmxhZ3MuZnJvbSwgXCItLWZyb21cIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIC4uLihmcm9tICE9PSB1bmRlZmluZWQgPyB7IGZyb20gfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8geyBsYWJlbDogZmxhZ3MubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNheVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicG9zdCBhIGNoYXQgbWVzc2FnZSBmcm9tIHRoZSBhZ2VudCAocHJvc2U6IC0tYm9keS1maWxlIDxwYXRoPiBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzYXlcIiwgdGV4dDogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncykgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ2TlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJyZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAobmV2ZXIgdGhlIGFjdGl2ZSBvbmUg4oCUIGFjdGl2YXRlIGFub3RoZXIgZmlyc3QpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24uZGVsZXRlXCIsXG4gICAgICAgICAgdmVyc2lvbjogcGFyc2VWZXJzaW9uKHBvc1swXSA/PyBcIlwiLCBcInZlcnNpb24tZGVsZXRlXCIpLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdvcmlnaW5hbCcpOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJlbWl0IHRoaXMgQ0xJJ3MgYWNjIGRlY2xhcmF0aW9uICh3YWxrZWQgZnJvbSB0aGUgY29tbWFuZCB0YWJsZSlcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2hvdyB0aGlzIG1lc3NhZ2VcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuXTtcblxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG5jb25zdCBmaW5kQ29tbWFuZCA9ICh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQgPT5cbiAgQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbik7XG5cbi8qKiBUaGUgdmVyYiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCAoYSBzdHJpbmcgZmxhZyBjb25zdW1lcyBpdHMgdmFsdWUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmJUb2tlbihhcmd2OiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIGFyZ3ZbaSArIDFdID8/IG51bGw7XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYS5zbGljZSgyKSBhcyBGbGFnO1xuICAgICAgaWYgKGtleSBpbiBDTElfT1BUSU9OUyAmJiBDTElfT1BUSU9OU1trZXldLnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBDT01NQU5EUy5tYXAoKGMpID0+IGMubmFtZSk7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBGbGFnW10+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBDT01NQU5EUy5tYXAoKGMpID0+IFtjLm5hbWUsIGMuZmxhZ3NdKSxcbik7XG5leHBvcnQgY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgWy4uLihmaW5kQ29tbWFuZCh2ZXJiKT8uZmxhZ3MgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbmNvbnN0IHJlbmRlckZsYWcgPSAoazogRmxhZyk6IHN0cmluZyA9PlxuICBDTElfT1BUSU9OU1trXS50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZU9mKHNwZWM6IENvbW1hbmRTcGVjKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBzcGVjLm5hbWUsXG4gICAgLi4uc3BlYy5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgLi4uc3BlYy5mbGFncy5maWx0ZXIoKGspID0+IGsgIT09IFwic2Vzc2lvblwiKS5tYXAocmVuZGVyRmxhZyksXG4gIF0uam9pbihcIiBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWxwKCk6IHN0cmluZyB7XG4gIGNvbnN0IHJvd3MgPSBDT01NQU5EUy5tYXAoKGMpID0+IFt1c2FnZU9mKGMpLCBjLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ucm93cy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICBjb25zdCBib2R5ID0gcm93c1xuICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYHNjcmlwdG9yaXVtIOKAlCBhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93LlxuXG4gIE91dHB1dDogSlNPTiBvbiBzdGRvdXQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlCBleGNlcHQgdGFpbCAob25lIEpTT04gbGluZVxuICBwZXIgZXZlbnQpIGFuZCBoZWxwIChwcm9zZSkuIEZhaWx1cmVzOiBvbmUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXRcbiAgMiA9IHVzYWdlLCAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdC4gdGFpbCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIHJhdGhlciB0aGFuIGZhaWxpbmcsIGFuZCBlbmRzIDAgd2hlbiBpdHMgc2Vzc2lvbiBjbG9zZXMuYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzOiBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdIGFzIHN0cmluZ1tdLFxuICAgICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgICB9KSksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgICAgLi4uQ09NTUFORFMubWFwKChjKSA9PiAoe1xuICAgICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgICAgYXJnczogWy4uLmMuZmxhZ3NdLm1hcChhcmcpLFxuICAgICAgICBwb3NpdGlvbmFsczogYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pKSxcbiAgICBdLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIC8vIFRoZSBraXQgZG9lcyBub3QgdHJpYWdlOyB0aGlzIGRvZXMuIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICAgIC8vICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzOyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gYXJndlswXSk7XG4gIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkIHx8IGFyZ3ZbMF0gPT09IFwidmVyc2lvblwiKSB7XG4gICAgaWYgKChpbnRlcmNlcHRvcj8ucnVucyA/PyBcInZlcnNpb25cIikgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcmludEpzb24odmVyc2lvbkluZm8oKSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBsZXQgY3VycmVudENvbW1hbmQgPSB2ZXJiVG9rZW4oYXJndik7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3MoYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikgfHwgZS5leHRyYT8uY2hvaWNlcyA9PT0gdW5kZWZpbmVkKSB0aHJvdyBlO1xuICAgIGNvbnN0IHNwZWMgPSBjdXJyZW50Q29tbWFuZCA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGZpbmRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgICBpZiAoc3BlYyAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7IGhpbnQ6IGUuZXh0cmE/LmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7XG4gICAgICBoaW50OiBgbm8gdmVyYiBnaXZlbiDigJQgdmVyYnM6ICR7VkVSQlMuam9pbihcIiBcIil9IChydW46IGNsaS50cyBoZWxwKWAsXG4gICAgICBjaG9pY2VzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSksXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgW3ZlcmIsIC4uLnBvc10gPSBwYXJzZWQucG9zO1xuICBjb25zdCBmbGFncyA9IHBhcnNlZC5mbGFncztcbiAgY3VycmVudENvbW1hbmQgPSB2ZXJiID8/IG51bGw7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcblxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBbLi4uVkVSQlNdIH0pO1xuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQodmVyYik7XG4gIGlmIChzcGVjID09PSB1bmRlZmluZWQpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcblxuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KHNwZWMuZmxhZ3MpO1xuICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKGZsYWdzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFjY2VwdGVkID0gZmxhZ3NGb3Ioc3BlYy5uYW1lKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3NwZWMubmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBzY3JpcHRvcml1bSBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgYWNjZXB0ZWQubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogYWNjZXB0ZWQgfSA6IHsgaGludDogYCR7c3BlYy5uYW1lfSB0YWtlcyBubyBmbGFnc2AgfSxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1c2FnZTogJHt1c2FnZU9mKHNwZWMpfWAsIHsgaGludDogc3BlYy5kZXNjcmliZSB9KTtcblxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuICBjb25zdCBjb2RlID0gYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7QUFnREE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVVBO0FBQ0E7QUFDQSxzQkFBUzs7O0FDdENGLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUlJLE1BQU0saUJBQWlCLE1BQU07QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUVULFdBQVcsQ0FBQyxNQUFlLFNBQWlCLE9BQWtCO0FBQUEsSUFDNUQsTUFBTSxPQUFPO0FBQUEsSUFDYixLQUFLLE9BQU87QUFBQSxJQUNaLEtBQUssT0FBTztBQUFBLElBQ1osS0FBSyxRQUFRO0FBQUE7QUFBQSxNQUdYLFFBQVEsR0FBVztBQUFBLElBQ3JCLE9BQU8sU0FBUyxLQUFLO0FBQUE7QUFFekI7QUFLTyxTQUFTLEdBQUcsQ0FBQyxTQUFpQixPQUFnQixTQUFTLE9BQXlCO0FBQUEsRUFDckYsTUFBTSxJQUFJLFNBQVMsTUFBTSxTQUFTLEtBQUs7QUFBQTtBQVNsQyxTQUFTLGNBQWMsQ0FDNUIsR0FDQSxNQUF5QyxRQUFRLFFBQ2xDO0FBQUEsRUFDZixJQUFJLEVBQUUsYUFBYTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQ3JDLElBQUksTUFBTSxjQUFjLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUNuRCxPQUFPLEVBQUU7QUFBQTs7O0FDaUhYLElBQU0sa0JBQWtCO0FBQ3hCLElBQU0sZ0JBQWdCLEVBQUUsV0FBVyxLQUFLLE9BQU8sS0FBSztBQVU3QyxTQUFTLGFBQWEsQ0FBQyxPQUErRDtBQUFBLEVBQzNGLE1BQU0sV0FBcUIsQ0FBQztBQUFBLEVBQzVCLE1BQU0sWUFBc0IsQ0FBQztBQUFBLEVBQzdCLElBQUksUUFBUTtBQUFBLEVBQ1osSUFBSSxVQUFVO0FBQUEsRUFFZCxXQUFXLFFBQVEsTUFBTSxNQUFNO0FBQUEsQ0FBSSxHQUFHO0FBQUEsSUFDcEMsSUFBSSxTQUFTO0FBQUEsTUFBSTtBQUFBLElBQ2pCLElBQUksS0FBSyxXQUFXLEdBQUcsR0FBRztBQUFBLE1BQ3hCLFNBQVMsS0FBSyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDM0I7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLFFBQVEsS0FBSyxRQUFRLEdBQUc7QUFBQSxJQUM5QixNQUFNLFFBQVEsVUFBVSxLQUFLLE9BQU8sS0FBSyxNQUFNLEdBQUcsS0FBSztBQUFBLElBQ3ZELElBQUksUUFBUSxVQUFVLEtBQUssS0FBSyxLQUFLLE1BQU0sUUFBUSxDQUFDO0FBQUEsSUFDcEQsSUFBSSxNQUFNLFdBQVcsR0FBRztBQUFBLE1BQUcsUUFBUSxNQUFNLE1BQU0sQ0FBQztBQUFBLElBQ2hELElBQUksVUFBVSxRQUFRO0FBQUEsTUFDcEIsVUFBVSxLQUFLLEtBQUs7QUFBQSxNQUNwQixVQUFVO0FBQUEsSUFDWixFQUFPLFNBQUksVUFBVSxTQUFTO0FBQUEsTUFDNUIsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUVGO0FBQUEsRUFFQSxJQUFJLENBQUM7QUFBQSxJQUFTLE9BQU8sRUFBRSxPQUFPLE1BQU0sU0FBUztBQUFBLEVBQzdDLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxNQUFNLFVBQVUsS0FBSztBQUFBLENBQUksRUFBRSxHQUFHLFNBQVM7QUFBQTtBQVVsRSxlQUFzQixVQUFjLENBQUMsTUFBd0M7QUFBQSxFQUMzRSxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLFNBQVMsS0FBSyxVQUFVO0FBQUEsRUFDOUIsTUFBTSxRQUFRLEtBQUssU0FBUztBQUFBLEVBQzVCLE1BQU0sZUFBZSxLQUFLLGdCQUFnQjtBQUFBLEVBRTFDLElBQUksU0FBUyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxRQUF1QjtBQUFBLEVBQzNCLElBQUksZUFBZTtBQUFBLEVBQ25CLElBQUksZ0JBQWdCO0FBQUEsRUFDcEIsSUFBSSxlQUFlO0FBQUEsRUFDbkIsSUFBSSxRQUFRLE1BQU07QUFBQSxFQUNsQixJQUFJLE9BQU87QUFBQSxFQWdCWCxJQUFJLFVBQVU7QUFBQSxFQUNkLElBQUksVUFBa0M7QUFBQSxFQUN0QyxJQUFJLGNBQW1DO0FBQUEsRUFDdkMsTUFBTSxPQUFPLENBQUMsYUFBcUI7QUFBQSxJQUNqQyxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxTQUFTLE1BQU07QUFBQSxJQUNmLGNBQWM7QUFBQTtBQUFBLEVBSWhCLE1BQU0sVUFBVSxDQUFDLE9BQ2YsSUFBSSxRQUFjLENBQUMsaUJBQWlCO0FBQUEsSUFDbEMsSUFBSTtBQUFBLE1BQVMsT0FBTyxhQUFhO0FBQUEsSUFDakMsTUFBTSxTQUFTLE1BQU07QUFBQSxNQUNuQixhQUFhLEtBQUs7QUFBQSxNQUNsQixjQUFjO0FBQUEsTUFDZCxhQUFhO0FBQUE7QUFBQSxJQUVmLE1BQU0sUUFBUSxXQUFXLFFBQVEsRUFBRTtBQUFBLElBQ25DLGNBQWM7QUFBQSxHQUNmO0FBQUEsRUFFSCxNQUFNLFdBQVcsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUM3QixNQUFNLGFBQWEsS0FBSyxZQUFZO0FBQUEsRUFDcEMsSUFBSSxZQUFZO0FBQUEsSUFDZCxRQUFRLEdBQUcsVUFBVSxRQUFRO0FBQUEsSUFDN0IsUUFBUSxHQUFHLFdBQVcsUUFBUTtBQUFBLEVBQ2hDO0FBQUEsRUFJQSxNQUFNLGFBQWEsQ0FBQyxNQUFlO0FBQUEsSUFDakMsSUFBSyxHQUF5QyxTQUFTO0FBQUEsTUFBUyxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRXhFLE1BQU0sYUFBYTtBQUFBLEVBSW5CLFdBQVcsS0FBSyxTQUFTLFVBQVU7QUFBQSxFQUVuQyxNQUFNLGdCQUFnQixNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ2xDLEtBQUssUUFBUSxpQkFBaUIsU0FBUyxhQUFhO0FBQUEsRUFDcEQsSUFBSSxLQUFLLFFBQVE7QUFBQSxJQUFTLEtBQUssQ0FBQztBQUFBLEVBRWhDLE1BQU0sT0FBTyxDQUFDLFNBQWlCO0FBQUEsSUFDN0IsSUFBSSxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUE7QUFBQSxFQUl2QixNQUFNLE9BQU8sQ0FBQyxTQUFvQztBQUFBLElBQ2hELElBQUksU0FBUyxRQUFRLFNBQVM7QUFBQSxNQUFXLElBQUksTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBO0FBQUEsRUFHaEUsSUFBSTtBQUFBLElBQ0YsT0FBTyxDQUFDLFNBQVM7QUFBQSxNQU1mLE1BQU0sT0FBTyxNQUFNLEtBQUssUUFBUTtBQUFBLE1BQ2hDLElBQUksU0FBUyxNQUFNO0FBQUEsUUFDakIsTUFBTSxVQUFVLEtBQUssZUFBZSxFQUFFLGNBQWMsY0FBYyxDQUFDLEtBQUs7QUFBQSxRQUN4RSxJQUFJLFlBQVk7QUFBQSxVQUFRLE9BQU87QUFBQSxRQUMvQixNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxRQUN2QztBQUFBLE1BQ0Y7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUVmLE1BQU0sU0FBUyxLQUFLLFFBQVEsUUFBUSxZQUFZLEtBQUssRUFBRSxPQUFPLE9BQU8sTUFBTSxFQUFFO0FBQUEsTUFDN0UsTUFBTSxLQUFLLElBQUksZ0JBQWdCLE1BQU0sRUFBRSxTQUFTO0FBQUEsTUFDaEQsTUFBTSxNQUFNLEdBQUcsT0FBTyxLQUFLLE9BQU8sS0FBSyxJQUFJLE9BQU87QUFBQSxNQUVsRCxVQUFVLElBQUk7QUFBQSxNQUNkLE1BQU0sYUFBYTtBQUFBLE1BQ25CLElBQUksV0FBaUQ7QUFBQSxNQUNyRCxNQUFNLGdCQUFnQixNQUFNO0FBQUEsUUFDMUIsSUFBSSxVQUFVO0FBQUEsVUFBRztBQUFBLFFBQ2pCLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsV0FBVyxXQUFXLE1BQU0sV0FBVyxNQUFNLEdBQUcsTUFBTTtBQUFBO0FBQUEsTUFVeEQsSUFBSTtBQUFBLE1BQ0osSUFBSTtBQUFBLFFBQ0YsTUFBTSxNQUFNLE1BQU0sS0FBSyxFQUFFLFFBQVEsV0FBVyxPQUFPLENBQUM7QUFBQSxRQUNwRCxPQUFPLEdBQUc7QUFBQSxRQUNWLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsVUFBVTtBQUFBLFFBQ1YsSUFBSTtBQUFBLFVBQVM7QUFBQSxRQUNiLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxrQkFBa0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFFBQy9ELE1BQU0sUUFBUSxLQUFLO0FBQUEsUUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFFBQ3ZDO0FBQUE7QUFBQSxNQUdGLElBQUk7QUFBQSxRQUNGLElBQUksQ0FBQyxJQUFJLElBQUk7QUFBQSxVQUVYLE1BQU0sS0FBSyxjQUFjLEdBQUc7QUFBQSxVQUs1QixNQUFNLElBQUksTUFBTSxPQUFPLEVBQUUsTUFBTSxNQUFNLEVBQUU7QUFBQSxVQUN2QyxLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sUUFBUSxRQUFRLElBQUksT0FBTyxDQUFDLENBQUM7QUFBQSxVQUMvRCxNQUFNLFFBQVEsS0FBSztBQUFBLFVBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxVQUN2QztBQUFBLFFBQ0Y7QUFBQSxRQUNBLElBQUksQ0FBQyxJQUFJLE1BQU07QUFBQSxVQUliLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxXQUFXLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQztBQUFBLFVBQ2xFLE1BQU0sUUFBUSxLQUFLO0FBQUEsVUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFVBQ3ZDO0FBQUEsUUFDRjtBQUFBLFFBRUEsZ0JBQWdCO0FBQUEsUUFDaEIsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLFFBRWQsTUFBTSxTQUFTLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDbEMsTUFBTSxVQUFVLElBQUk7QUFBQSxRQUNwQixJQUFJLE1BQU07QUFBQSxRQUVWLE9BQU8sQ0FBQyxTQUFTO0FBQUEsVUFDZixJQUFJO0FBQUEsVUFDSixJQUFJO0FBQUEsWUFDRixRQUFRLE1BQU0sT0FBTyxLQUFLO0FBQUEsWUFDMUIsT0FBTyxHQUFHO0FBQUEsWUFHVixJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxnQkFBZ0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFlBQzNFO0FBQUE7QUFBQSxVQUVGLElBQUksTUFBTSxNQUFNO0FBQUEsWUFDZCxJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxhQUFhLENBQUMsQ0FBQztBQUFBLFlBQy9EO0FBQUEsVUFDRjtBQUFBLFVBVUEsUUFBUSxNQUFNO0FBQUEsVUFLZCxjQUFjO0FBQUEsVUFDZCxPQUFPLFFBQVEsT0FBTyxNQUFNLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUFBLFVBRW5ELFNBQVMsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sRUFBRyxPQUFPLEdBQUcsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sR0FBRztBQUFBLFlBQ3ZFLE1BQU0sUUFBUSxJQUFJLE1BQU0sR0FBRyxHQUFHO0FBQUEsWUFDOUIsTUFBTSxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQUEsWUFDdkIsUUFBUSxPQUFPLGFBQWEsY0FBYyxLQUFLO0FBQUEsWUFDL0MsV0FBVyxRQUFRO0FBQUEsY0FBVSxLQUFLLEtBQUssWUFBWSxJQUFJLENBQUM7QUFBQSxZQUN4RCxJQUFJLENBQUM7QUFBQSxjQUFPO0FBQUEsWUFFWixJQUFJO0FBQUEsWUFDSixJQUFJO0FBQUEsY0FDRixLQUFLLEtBQUssTUFBTSxNQUFNLElBQUk7QUFBQSxjQUMxQixPQUFPLEdBQUc7QUFBQSxjQUNWLEtBQUssS0FBSyxjQUFjLE9BQU8sQ0FBQyxDQUFDO0FBQUEsY0FDakM7QUFBQTtBQUFBLFlBR0YsSUFBSSxLQUFLLFNBQVM7QUFBQSxjQUNoQixNQUFNLE9BQU8sS0FBSyxRQUFRLEVBQUU7QUFBQSxjQUM1QixJQUFJLE9BQU8sU0FBUyxVQUFVO0FBQUEsZ0JBQzVCLElBQUksVUFBVSxRQUFRLFNBQVMsT0FBTztBQUFBLGtCQUNwQyxTQUFTO0FBQUEsa0JBQ1QsTUFBTSxPQUFPLEtBQUssZ0JBQWdCLElBQUksS0FBSztBQUFBLGtCQUMzQyxJQUFJLFNBQVM7QUFBQSxvQkFBTSxLQUFLLElBQUk7QUFBQSxnQkFDOUI7QUFBQSxnQkFDQSxRQUFRO0FBQUEsY0FDVjtBQUFBLFlBQ0Y7QUFBQSxZQU1BLE1BQU0sSUFBSSxLQUFLLFdBQVcsRUFBRTtBQUFBLFlBQzVCLElBQUksT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLENBQUMsR0FBRztBQUFBLGNBQy9DLFNBQVMsaUJBQWlCLFdBQVcsSUFBSSxLQUFLLElBQUksUUFBUSxDQUFDO0FBQUEsWUFDN0Q7QUFBQSxZQUVBLE1BQU0sV0FBVyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUs7QUFBQSxZQUM3QyxNQUFNLGFBQWEsS0FBSyxXQUFXLEVBQUUsS0FBSztBQUFBLFlBRTFDLElBQUksWUFBYSxjQUFjLEtBQUssMEJBQTBCLE1BQU87QUFBQSxjQUNuRSxNQUFNLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxJQUFJLEtBQUssSUFBSSxNQUFNO0FBQUEsY0FDMUQsSUFBSSxTQUFTO0FBQUEsZ0JBQU0sS0FBSyxJQUFJO0FBQUEsWUFDOUI7QUFBQSxZQUNBLElBQUk7QUFBQSxjQUFZLE9BQU87QUFBQSxVQUN6QjtBQUFBLFFBQ0Y7QUFBQSxnQkFDQTtBQUFBLFFBQ0EsSUFBSSxhQUFhO0FBQUEsVUFBTSxhQUFhLFFBQVE7QUFBQSxRQUM1QyxVQUFVO0FBQUE7QUFBQSxNQUdaLElBQUk7QUFBQSxRQUFTO0FBQUEsTUFRYixNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxJQUN6QztBQUFBLElBQ0EsT0FBTztBQUFBLFlBQ1A7QUFBQSxJQUNBLElBQUksWUFBWTtBQUFBLE1BQ2QsUUFBUSxJQUFJLFVBQVUsUUFBUTtBQUFBLE1BQzlCLFFBQVEsSUFBSSxXQUFXLFFBQVE7QUFBQSxJQUNqQztBQUFBLElBQ0EsV0FBVyxNQUFNLFNBQVMsVUFBVTtBQUFBLElBQ3BDLEtBQUssUUFBUSxvQkFBb0IsU0FBUyxhQUFhO0FBQUE7QUFBQTs7O0FDeGhCcEQsSUFBTSx1QkFBdUI7QUFPN0IsSUFBTSxlQUFlO0FBZ0VyQixTQUFTLFVBQVUsQ0FBQyxRQUF3QjtBQUFBLEVBQ2pELE9BQU8sU0FBUztBQUFBOzs7QUMxRlgsSUFBTSxtQkFBbUI7QUFHekIsSUFBTSxlQUFlLFdBQVcsZ0JBQWdCOzs7QUNYaEQsSUFBTSxpQkFBaUIsQ0FBQyxPQUFPLGFBQWEsUUFBUSxNQUFNO0FBRTFELFNBQVMsU0FBUyxDQUFDLE1BQXVCO0FBQUEsRUFDL0MsTUFBTSxRQUFRLEtBQUssWUFBWTtBQUFBLEVBQy9CLE9BQU8sZUFBZSxLQUFLLENBQUMsUUFBUSxNQUFNLFNBQVMsR0FBRyxDQUFDO0FBQUE7QUFJekQsSUFBTSxZQUFZLElBQUksSUFBSSxDQUFDLGdCQUFnQixRQUFRLFFBQVEsT0FBTyxVQUFVLENBQUM7OztBTjBEN0UsU0FBUyxhQUFhLENBQUMsTUFBYyxRQUFnQixNQUFzQjtBQUFBLEVBQ3pFLE1BQU0sT0FDSixXQUFXLE1BQ1AsVUFDQSxXQUFXLE1BQ1QsY0FDQSxXQUFXLE1BQ1QsYUFDQTtBQUFBLEVBQ1YsTUFBTSxPQUFRLFFBQVEsQ0FBQztBQUFBLEVBQ3ZCLE1BQU0sVUFBVSxNQUFNLFFBQVEsS0FBSyxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksTUFBTSxJQUFJO0FBQUEsRUFDekUsSUFBSSxPQUFPLEtBQUssVUFBVSxXQUFXLEtBQUssUUFBUSxHQUFHLHFCQUFxQixXQUFXLE1BQU07QUFBQSxPQUNyRixVQUFVLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFBQSxPQUN6QixTQUFTLFFBQVEsU0FBUyxZQUFZLEVBQUUsUUFBUSxLQUFLLElBQUksQ0FBQztBQUFBLEVBQ2hFLENBQUM7QUFBQTtBQUdILElBQU0sYUFBYSxRQUFRLElBQUksY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxJQUFNLGFBQWEsS0FBSyxZQUFZLElBQUk7QUFDeEMsSUFBTSxXQUFXLEtBQUssWUFBWSxNQUFNO0FBQ3hDLElBQU0sZ0JBQWdCLEtBQUssWUFBWSxNQUFNLFdBQVcsV0FBVztBQUNuRSxJQUFNLGNBQWMsS0FBSyxZQUFZLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxPQUFPLGFBQWE7QUFHaEYsU0FBUyxTQUFTLEdBQVc7QUFBQSxFQUNsQyxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFXLE9BQU87QUFBQSxFQUM3RCxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFPLE9BQU87QUFBQSxFQUN6RCxPQUFPLFdBQVcsS0FBSyxVQUFVLFlBQVksQ0FBQyxJQUFJLGFBQWE7QUFBQTtBQUlqRSxTQUFTLGVBQWUsR0FBVztBQUFBLEVBQ2pDLE9BQU8sUUFBUSxRQUFRLElBQUksb0JBQW9CLEtBQUssUUFBUSxHQUFHLGNBQWMsQ0FBQztBQUFBO0FBS2hGLElBQU0sa0JBQWtCLEVBQUUsTUFBTSw0Q0FBNEM7QUFFNUUsU0FBUyxlQUFlLENBQUMsU0FBMEI7QUFBQSxFQUNqRCxPQUFPLEtBQUssT0FBTyxHQUFHLFVBQVUsZUFBZSxpQkFBaUIseUJBQXlCO0FBQUE7QUFJM0YsU0FBUyxXQUFXLENBQUMsU0FBeUM7QUFBQSxFQUM1RCxNQUFNLE9BQU8sZ0JBQWdCLE9BQU87QUFBQSxFQUNwQyxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixNQUFNLGFBQWEsTUFBTSxNQUFNO0FBQUEsSUFDL0IsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQVEsRUFBNEI7QUFBQSxJQUMxQyxJQUFJLFNBQVM7QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5QixJQUFJLG9DQUFvQyxRQUFRLHFCQUFxQixRQUFRLFVBQVU7QUFBQTtBQUFBLEVBRXpGLElBQUk7QUFBQSxJQUNGLE9BQU8sS0FBSyxNQUFNLEdBQUc7QUFBQSxJQUNyQixNQUFNO0FBQUEsSUFDTixJQUFJLDBDQUEwQyxRQUFRLFVBQVU7QUFBQTtBQUFBO0FBSXBFLFNBQVMsY0FBYyxDQUFDLFNBQWtDO0FBQUEsRUFDeEQsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLEVBQzdCLElBQUksQ0FBQztBQUFBLElBQUcsSUFBSSxrQ0FBa0MsYUFBYSxlQUFlO0FBQUEsRUFDMUUsT0FBTztBQUFBO0FBR1QsZUFBZSxHQUFHLENBQ2hCLE1BQ0EsUUFDQSxNQUNBLE1BQzRDO0FBQUEsRUFDNUMsTUFBTSxNQUFNLE1BQU0sTUFBTSxvQkFBb0IsT0FBTyxRQUFRO0FBQUEsSUFDekQ7QUFBQSxJQUNBLFNBQVMsU0FBUyxZQUFZLEVBQUUsZ0JBQWdCLG1CQUFtQixJQUFJO0FBQUEsSUFDdkUsTUFBTSxTQUFTLFlBQVksS0FBSyxVQUFVLElBQUksSUFBSTtBQUFBLEVBQ3BELENBQUM7QUFBQSxFQUNELElBQUksT0FBZ0I7QUFBQSxFQUNwQixJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sSUFBSSxLQUFLO0FBQUEsSUFDdEIsTUFBTTtBQUFBLEVBR1IsT0FBTyxFQUFFLFFBQVEsSUFBSSxRQUFRLEtBQUs7QUFBQTtBQUdwQyxlQUFlLE9BQU8sQ0FBQyxTQUE2QixLQUE4QjtBQUFBLEVBQ2hGLE1BQU0sSUFBSSxlQUFlLE9BQU87QUFBQSxFQUNoQyxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsS0FDRCxFQUFFLFFBQVEsS0FBSyxJQUFJLE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRLEdBQUc7QUFBQSxJQUN6RCxPQUFPLEtBQUs7QUFBQSxJQUdaLE1BQU0sVUFBVSxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUFBLElBQy9ELE1BQU0sT0FBTyxPQUFPLE9BQU8sUUFBUSxZQUFZLFVBQVUsTUFBTSxPQUFPLElBQUksSUFBSSxJQUFJO0FBQUEsSUFDbEYsSUFBSSxJQUFJLFNBQVMsWUFBWSxTQUFTLGdCQUFnQixRQUFRLFNBQVMsWUFBWTtBQUFBLE1BQ2pGLE9BQU8sRUFBRSxJQUFJLEtBQUs7QUFBQSxJQUNwQixNQUFNO0FBQUE7QUFBQSxFQUVSLElBQUksV0FBVztBQUFBLElBQUssY0FBYyxPQUFPLElBQUksSUFBSSxHQUFHLFFBQVEsSUFBSTtBQUFBLEVBQ2hFLE9BQU87QUFBQTtBQUtULElBQU0sY0FBYztBQUFBLEVBQ2xCLGFBQWEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUM5QixJQUFJLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDckIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLE1BQU0sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN4QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLFdBQVcsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUM1QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsV0FBVyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQzdCLE9BQU8sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN6QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixpQkFBaUIsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUNsQyxRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUN6QjtBQUVPLElBQU0sbUJBQW1CLE9BQU8sS0FBSyxXQUFXLEVBQUUsSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHO0FBQUE7QUFFckUsTUFBTSxtQkFBbUIsU0FBUztBQUFBLEVBQ3ZDLFdBQVcsQ0FBQyxTQUFpQixPQUErQztBQUFBLElBQzFFLE1BQU0sU0FBUyxTQUFTLEtBQUs7QUFBQTtBQUVqQztBQUVPLFNBQVMsU0FBUyxDQUFDLE1BR3hCO0FBQUEsRUFDQSxJQUFJO0FBQUEsSUFDRixRQUFRLFFBQVEsZ0JBQWdCLGNBQWM7QUFBQSxNQUM1QztBQUFBLE1BQ0EsU0FBUztBQUFBLE1BQ1QsUUFBUTtBQUFBLE1BQ1Isa0JBQWtCO0FBQUEsSUFDcEIsQ0FBQztBQUFBLElBQ0QsT0FBTyxFQUFFLEtBQUssYUFBYSxPQUFPLE9BQTJDO0FBQUEsSUFDN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLFNBQVMsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxJQUN4RCxNQUFNLE9BQVEsRUFBd0I7QUFBQSxJQUl0QyxNQUFNLElBQUksV0FBVyxRQUFRO0FBQUEsTUFDM0IsTUFBTTtBQUFBLFNBQ0YsU0FBUyxrQ0FBa0MsRUFBRSxTQUFTLGlCQUFpQixJQUFJLENBQUM7QUFBQSxJQUNsRixDQUFDO0FBQUE7QUFBQTtBQVNFLFNBQVMsVUFBVSxDQUFDLE9BQXVCO0FBQUEsRUFDaEQsSUFBSSxDQUFDLFVBQVUsS0FBSyxNQUFNLEtBQUssQ0FBQztBQUFBLElBQzlCLElBQ0UsYUFBYSxzRkFDYixPQUNGO0FBQUEsRUFDRixPQUFPLE9BQU8sU0FBUyxPQUFPLEVBQUU7QUFBQTtBQVEzQixTQUFTLGNBQWMsQ0FBQyxPQUF1QjtBQUFBLEVBQ3BELE1BQU0sSUFBSSxNQUFNLEtBQUs7QUFBQSxFQUNyQixJQUFJLENBQUMsc0JBQXNCLEtBQUssQ0FBQyxLQUFLLE9BQU8sTUFBTSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsSUFDOUQsSUFBSSxrQkFBa0Isc0RBQWlELE9BQU87QUFBQSxFQUNoRixPQUFPO0FBQUE7QUFJRixTQUFTLFlBQVksQ0FBQyxPQUFlLE1BQXNCO0FBQUEsRUFDaEUsTUFBTSxJQUFJLFlBQVksS0FBSyxNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ3ZDLElBQUksQ0FBQyxLQUFLLE9BQU8sRUFBRSxFQUFFLElBQUk7QUFBQSxJQUN2QixJQUFJLEdBQUcsVUFBVSx1REFBNkMsU0FBUztBQUFBLE1BQ3JFLE1BQU07QUFBQSxJQUNSLENBQUM7QUFBQSxFQUNILE9BQU8sT0FBTyxFQUFFLEVBQUU7QUFBQTtBQUliLFNBQVMsVUFBVSxDQUFDLE9BQWUsTUFBc0I7QUFBQSxFQUM5RCxNQUFNLElBQUksTUFBTSxLQUFLO0FBQUEsRUFDckIsSUFBSSxDQUFDLFFBQVEsS0FBSyxDQUFDO0FBQUEsSUFBRyxJQUFJLEdBQUcsVUFBVSxnQ0FBZ0MsT0FBTztBQUFBLEVBQzlFLE9BQU8sT0FBTyxDQUFDO0FBQUE7QUFRVixTQUFTLFNBQVMsQ0FBQyxPQUFlLE1BQW1DO0FBQUEsRUFDMUUsTUFBTSxJQUFJLE1BQU0sS0FBSyxFQUFFLFlBQVk7QUFBQSxFQUNuQyxJQUFJLE1BQU0sY0FBYyxNQUFNO0FBQUEsSUFBUSxPQUFPO0FBQUEsRUFDN0MsT0FBTyxhQUFhLE9BQU8sSUFBSTtBQUFBO0FBWWpDLFNBQVMsWUFBWSxDQUFDLEtBQXlCO0FBQUEsRUFDN0MsTUFBTSxRQUFRLElBQUksSUFBSSxDQUFDLE1BQU0sUUFBUSxDQUFDLENBQUM7QUFBQSxFQUN2QyxXQUFXLEtBQUssT0FBTztBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxNQUNGLEtBQUssU0FBUyxDQUFDO0FBQUEsTUFDZixNQUFNO0FBQUEsTUFDTixJQUFJLDJCQUEyQixLQUFLLFdBQVc7QUFBQTtBQUFBLElBRWpELElBQUksQ0FBQyxHQUFHLFlBQVksS0FBSyxDQUFDLFVBQVUsQ0FBQztBQUFBLE1BQ25DLElBQUkscUNBQXFDLEtBQUssU0FBUztBQUFBLFFBQ3JELE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQyxHQUFHLGNBQWM7QUFBQSxNQUM3QixDQUFDO0FBQUEsRUFDTDtBQUFBLEVBQ0EsT0FBTztBQUFBO0FBU0YsU0FBUyxNQUFNLENBQUMsT0FBdUI7QUFBQSxFQUM1QyxJQUFJLE1BQU0sU0FBUyxHQUFHLEtBQUssV0FBVyxRQUFRLEtBQUssQ0FBQztBQUFBLElBQUcsT0FBTyxRQUFRLEtBQUs7QUFBQSxFQUMzRSxPQUFPO0FBQUE7QUFJVCxJQUFNLFdBQVc7QUFDakIsU0FBUyxTQUFTLENBQUMsUUFBc0I7QUFBQSxFQUN2QyxJQUFJLFFBQWtCLENBQUM7QUFBQSxFQUN2QixJQUFJO0FBQUEsSUFDRixRQUFRLFlBQVksTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNLHdCQUF3QixLQUFLLENBQUMsQ0FBQztBQUFBLElBQ3pFLE1BQU07QUFBQSxJQUNOO0FBQUE7QUFBQSxFQUVGLE1BQU0sUUFBUSxNQUFNLEtBQUssQ0FBQyxHQUFHLE1BQU0sT0FBTyxFQUFFLE1BQU0sR0FBRyxFQUFFLEVBQUUsSUFBSSxPQUFPLEVBQUUsTUFBTSxHQUFHLEVBQUUsRUFBRSxDQUFDO0FBQUEsRUFDcEYsV0FBVyxLQUFLLE1BQU0sTUFBTSxHQUFHLEtBQUssSUFBSSxHQUFHLE1BQU0sVUFBVSxXQUFXLEVBQUUsQ0FBQyxHQUFHO0FBQUEsSUFDMUUsSUFBSTtBQUFBLE1BQ0YsV0FBVyxLQUFLLFFBQVEsQ0FBQyxDQUFDO0FBQUEsTUFDMUIsTUFBTTtBQUFBLEVBR1Y7QUFBQTtBQUdGLGVBQWUsT0FBTyxDQUFDLEtBQWUsT0FBeUM7QUFBQSxFQUM3RSxNQUFNLFFBQVEsYUFBYSxHQUFHO0FBQUEsRUFFOUIsSUFBSSxPQUFPLE1BQU0sWUFBWSxVQUFVO0FBQUEsSUFDckMsTUFBTSxPQUFPLGdCQUFnQjtBQUFBLElBQzdCLE1BQU0sV0FBVyxLQUFLLE1BQU0sWUFBWSxNQUFNLFNBQVMsZUFBZTtBQUFBLElBQ3RFLElBQUksQ0FBQyxXQUFXLFFBQVEsR0FBRztBQUFBLE1BQ3pCLElBQUksUUFBa0IsQ0FBQztBQUFBLE1BQ3ZCLElBQUk7QUFBQSxRQUNGLFNBQ0UsTUFBTSxNQUFNLFVBQVUsSUFBSSxJQUFJLEtBQUssaUJBQWlCLEVBQUUsS0FBSyxLQUFLLE1BQU0sVUFBVSxDQUFDLENBQUMsR0FDbEYsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEdBQUcsRUFBRSxFQUFZO0FBQUEsUUFDdEMsTUFBTTtBQUFBLE1BR1IsSUFBSSxxQkFBcUIsTUFBTSxrQkFBa0IsUUFBUSxhQUFhO0FBQUEsUUFDcEUsU0FBUyxNQUFNLEtBQUs7QUFBQSxXQUNoQixNQUFNLFdBQVcsSUFBSSxFQUFFLE1BQU0saUNBQWlDLElBQUksQ0FBQztBQUFBLE1BQ3pFLENBQUM7QUFBQSxJQUNIO0FBQUEsSUFDQSxNQUFNLE9BQU8sWUFBWSxNQUFNLE9BQU87QUFBQSxJQUN0QyxJQUFJLE1BQU07QUFBQSxNQUNSLE1BQU0sUUFBUSxNQUFNLElBQUksS0FBSyxNQUFNLE9BQU8sUUFBUSxFQUFFLEtBQ2xELENBQUMsTUFBTSxFQUFFLFdBQVcsS0FDcEIsTUFBTSxLQUNSO0FBQUEsTUFDQSxJQUFJO0FBQUEsUUFDRixJQUFJLFdBQVcsTUFBTSxpQ0FBaUMsS0FBSyxPQUFPLFlBQVk7QUFBQSxVQUM1RSxNQUFNLGtDQUFrQyxNQUFNO0FBQUEsUUFDaEQsQ0FBQztBQUFBLElBQ0w7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLGFBQWEsQ0FBQyxPQUFPLGFBQWE7QUFBQSxFQUN4QyxJQUFJLE9BQU8sTUFBTSxZQUFZO0FBQUEsSUFBVSxXQUFXLEtBQUssYUFBYSxNQUFNLE9BQU87QUFBQSxFQUNqRixJQUFJLE9BQU8sTUFBTSxZQUFZO0FBQUEsSUFBVSxXQUFXLEtBQUssYUFBYSxNQUFNLE9BQU87QUFBQSxFQUU1RTtBQUFBLGVBQVcsS0FBSyxlQUFlLFFBQVEsSUFBSSxDQUFDO0FBQUEsRUFFakQsTUFBTSxNQUFNLFVBQVU7QUFBQSxFQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHO0FBQUEsSUFDakIsSUFDRSx5RkFBb0YsT0FDcEYsWUFDQTtBQUFBLE1BQ0UsTUFBTTtBQUFBLElBQ1IsQ0FDRjtBQUFBLEVBTUYsTUFBTSxTQUFTLEtBQUssZ0JBQWdCLEdBQUcsTUFBTTtBQUFBLEVBQzdDLFVBQVUsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsRUFFckMsVUFBVSxNQUFNO0FBQUEsRUFDaEIsTUFBTSxVQUFVLEtBQUssUUFBUSxVQUFVLEtBQUssSUFBSSxLQUFLLFFBQVEsU0FBUztBQUFBLEVBQ3RFLFdBQVcsS0FBSyxTQUFTLE9BQU87QUFBQSxFQUNoQyxNQUFNLFFBQVEsU0FBUyxTQUFTLEdBQUc7QUFBQSxFQUNuQyxNQUFNLFFBQVEsTUFBTSxPQUFPLFlBQVk7QUFBQSxJQUNyQztBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsT0FBTyxDQUFDLFVBQVUsUUFBUSxLQUFLO0FBQUEsSUFDL0IsS0FBSyxRQUFRO0FBQUEsRUFDZixDQUFDO0FBQUEsRUFDRCxVQUFVLEtBQUs7QUFBQSxFQUNmLE1BQU0sTUFBTTtBQUFBLEVBRVosTUFBTSxpQkFDSixPQUFPLE1BQU0scUJBQXFCLFdBQzlCLEtBQUssSUFBSSxNQUFNLE9BQU8sU0FBUyxNQUFNLGtCQUFrQixFQUFFLElBQUksSUFBSSxJQUNqRTtBQUFBLEVBQ04sTUFBTSxPQUFPLE1BQU0sSUFBSSxRQUFnQixDQUFDLEtBQUssUUFBUTtBQUFBLElBQ25ELElBQUksTUFBTTtBQUFBLElBQ1YsTUFBTSxRQUFRLFdBQ1osTUFDRSxJQUNFLElBQUksTUFDRix5QkFBeUIsaUJBQWlCLDhDQUM1QyxDQUNGLEdBQ0YsY0FDRjtBQUFBLElBQ0EsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQUEsTUFDMUMsT0FBTyxNQUFNLFNBQVM7QUFBQSxNQUN0QixNQUFNLEtBQUssSUFBSSxRQUFRO0FBQUEsQ0FBSTtBQUFBLE1BQzNCLElBQUksTUFBTSxHQUFHO0FBQUEsUUFDWCxhQUFhLEtBQUs7QUFBQSxRQUNsQixJQUFJLElBQUksTUFBTSxHQUFHLEVBQUUsRUFBRSxLQUFLLENBQUM7QUFBQSxNQUM3QjtBQUFBLEtBQ0Q7QUFBQSxJQUNELE1BQU0sR0FBRyxTQUFTLENBQUMsUUFBUTtBQUFBLE1BQ3pCLGFBQWEsS0FBSztBQUFBLE1BQ2xCLElBQUksR0FBRztBQUFBLEtBQ1I7QUFBQSxJQUNELE1BQU0sR0FBRyxRQUFRLENBQUMsU0FBUztBQUFBLE1BQ3pCLGFBQWEsS0FBSztBQUFBLE1BQ2xCLElBQUksSUFBSSxNQUFNLDJCQUEyQiwyQkFBMkIsQ0FBQztBQUFBLEtBQ3RFO0FBQUEsR0FDRixFQUFFLE1BQU0sQ0FBQyxRQUFpQjtBQUFBLElBQ3pCLElBQUksT0FBTztBQUFBLElBQ1gsSUFBSTtBQUFBLE1BQ0YsT0FBTyxhQUFhLFNBQVMsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLElBQUk7QUFBQSxNQUN0RCxNQUFNO0FBQUEsSUFHUixJQUNFLHVDQUF1QyxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRyxLQUN0RixZQUNBLEVBQUUsTUFBTSxPQUFPLGVBQWUsYUFBYSxTQUFTLGVBQWUsVUFBVSxDQUMvRTtBQUFBLEdBQ0Q7QUFBQSxFQUtELE1BQU0sTUFBTSxNQUFNO0FBQUEsRUFDbEIsSUFBSSxDQUFDLE9BQU8sRUFBRSxXQUFXLFFBQVEsT0FBTyxJQUFJLFVBQVU7QUFBQSxJQUNwRCxNQUFNLElBQUksTUFDUiwrRUFDRjtBQUFBLEVBQ0YsSUFBSSxNQUFNO0FBQUEsRUFFVixJQUFJO0FBQUEsRUFRSixJQUFJO0FBQUEsSUFDRixLQUFLLEtBQUssTUFBTSxJQUFJO0FBQUEsSUFDcEIsTUFBTTtBQUFBLElBQ04sSUFBSSxrQ0FBa0MsUUFBUSxVQUFVO0FBQUE7QUFBQSxFQUUxRCxJQUFJLEdBQUcsT0FBTztBQUFBLElBQU8sY0FBYyxRQUFRLEdBQUcsVUFBVSxLQUFLLEVBQUU7QUFBQSxFQUUvRCxJQUFJLFVBQXFCLENBQUM7QUFBQSxFQUMxQixJQUFJLE1BQU0sU0FBUyxHQUFHO0FBQUEsSUFDcEIsTUFBTSxJQUFJLE1BQU0sUUFBUSxHQUFHLFlBQVksRUFBRSxNQUFNLGVBQWUsTUFBTSxDQUFDO0FBQUEsSUFDckUsVUFBVyxFQUFFLFdBQXlCLENBQUM7QUFBQSxFQUN6QztBQUFBLEVBQ0EsVUFBVSxLQUFLLE9BQVEsTUFBTSxTQUFTLElBQUksRUFBRSxRQUFRLElBQUksQ0FBQyxFQUFHLENBQUM7QUFBQSxFQUU3RCxJQUFJLENBQUMsTUFBTSxZQUFZO0FBQUEsSUFDckIsTUFBTSxTQUNKLFFBQVEsYUFBYSxXQUFXLFNBQVMsUUFBUSxhQUFhLFVBQVUsVUFBVTtBQUFBLElBQ3BGLE1BQU0sUUFBUSxDQUFDLEdBQUcsR0FBRyxHQUFHLEVBQUUsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsTUFBTTtBQUFBLEVBQ3JFO0FBQUE7QUFHRixlQUFlLE1BQU0sQ0FBQyxLQUFlLFNBQTZCO0FBQUEsRUFDaEUsTUFBTSxRQUFRLGFBQWEsR0FBRztBQUFBLEVBQzlCLFVBQVUsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGVBQWUsTUFBTSxDQUFDLENBQUM7QUFBQTtBQUdsRSxlQUFlLFFBQVEsQ0FBQyxTQUE2QixNQUFlO0FBQUEsRUFDbEUsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE1BQU0sT0FBTyxTQUFTLE9BQU8sWUFBWSxJQUFJO0FBQUEsRUFDbEYsSUFBSSxXQUFXO0FBQUEsSUFBSyxjQUFjLFNBQVMsUUFBUSxJQUFJO0FBQUEsRUFDdkQsVUFBVSxJQUFJO0FBQUE7QUFHaEIsZUFBZSxXQUFXLENBQ3hCLEtBQ0EsT0FDaUI7QUFBQSxFQUNqQixNQUFNLFVBQVU7QUFBQSxJQUNkLElBQUksU0FBUztBQUFBLElBQ2IsTUFBTSxVQUFVO0FBQUEsSUFDaEIsT0FBTyxNQUFNLGlCQUFpQjtBQUFBLEVBQ2hDLEVBQUUsT0FBTyxPQUFPLEVBQUU7QUFBQSxFQUNsQixJQUFJLFlBQVk7QUFBQSxJQUNkLElBQ0UsWUFBWSxJQUNSLHdCQUNBLG1GQUNKLFNBQ0E7QUFBQSxNQUNFLE1BQU07QUFBQSxNQUNOLFNBQVMsQ0FBQyxXQUFXLGFBQWE7QUFBQSxJQUNwQyxDQUNGO0FBQUEsRUFDRixJQUFJO0FBQUEsRUFDSixJQUFJLE1BQU0sVUFBVTtBQUFBLElBQU0sT0FBTyxNQUFNLElBQUksU0FBUyxJQUFJLE1BQU0sT0FBTyxDQUFDLEVBQUUsS0FBSztBQUFBLEVBQ3hFLFNBQUksT0FBTyxNQUFNLGlCQUFpQjtBQUFBLElBQVUsT0FBTyxhQUFhLE1BQU0sY0FBYyxNQUFNO0FBQUEsRUFDMUY7QUFBQSxXQUFPLElBQUksS0FBSyxHQUFHO0FBQUEsRUFDeEIsSUFBSSxDQUFDLEtBQUssS0FBSztBQUFBLElBQUcsSUFBSSw2QkFBNkIsT0FBTztBQUFBLEVBQzFELE9BQU8sS0FBSyxLQUFLO0FBQUE7QUFHbkIsZUFBZSxPQUFPLENBQUMsU0FBNkIsT0FBZ0M7QUFBQSxFQUNsRixJQUFJLFVBQVU7QUFBQSxFQUNkLElBQUksV0FBVztBQUFBLEVBQ2YsT0FBTyxNQUFNLFdBQTJEO0FBQUEsSUFDdEUsU0FBUyxNQUFNO0FBQUEsTUFDYixNQUFNLElBQUksWUFBWSxPQUFPO0FBQUEsTUFDN0IsSUFBSSxDQUFDO0FBQUEsUUFBRyxPQUFPO0FBQUEsTUFDZixJQUFJLENBQUM7QUFBQSxRQUFTLFVBQVUsRUFBRTtBQUFBLE1BQzFCLElBQUksQ0FBQyxVQUFVO0FBQUEsUUFDYixXQUFXO0FBQUEsUUFDWCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLE1BQU0sYUFBYSxZQUFZLEVBQUUsWUFBWSxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQUEsQ0FDakY7QUFBQSxNQUNGO0FBQUEsTUFDQSxPQUFPLG9CQUFvQixFQUFFO0FBQUE7QUFBQSxJQUUvQixjQUFjLEdBQUcsbUJBQW1CO0FBQUEsTUFDbEMsSUFBSTtBQUFBLFFBQWMsT0FBTztBQUFBLE1BQ3pCLFFBQVEsT0FBTyxNQUFNO0FBQUEsQ0FBK0I7QUFBQSxNQUNwRCxPQUFPO0FBQUE7QUFBQSxJQUVULE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQSxVQUFVLENBQUMsT0FBUSxPQUFPLEdBQUcsT0FBTyxXQUFXLEdBQUcsS0FBSztBQUFBLElBQ3ZELFNBQVMsQ0FBQyxPQUFRLE9BQU8sR0FBRyxVQUFVLFdBQVcsR0FBRyxRQUFRO0FBQUEsSUFFNUQsZUFBZSxDQUFDLFVBQVUsS0FBSyxVQUFVLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxDQUFDO0FBQUEsSUFDekUsVUFBVSxDQUFDLE9BQU8sR0FBRyxTQUFTO0FBQUEsSUFDOUIsUUFBUTtBQUFBLElBQ1IsV0FBVyxNQUFNO0FBQUEsRUFDbkIsQ0FBQztBQUFBO0FBR0gsU0FBUyxXQUFXLEdBQXNDO0FBQUEsRUFDeEQsSUFBSTtBQUFBLElBQ0YsTUFBTSxNQUFNLGFBQWEsS0FBSyxZQUFZLE1BQU0sTUFBTSxrQkFBa0IsYUFBYSxHQUFHLE1BQU07QUFBQSxJQUM5RixNQUFNLE1BQU0sS0FBSyxNQUFNLEdBQUc7QUFBQSxJQUMxQixJQUFJLE9BQU8sSUFBSSxZQUFZO0FBQUEsTUFBVSxPQUFPLEVBQUUsTUFBTSxlQUFlLFNBQVMsSUFBSSxRQUFRO0FBQUEsSUFDeEYsTUFBTTtBQUFBLEVBR1IsT0FBTyxFQUFFLE1BQU0sZUFBZSxTQUFTLFVBQVU7QUFBQTtBQVFuRCxlQUFlLFlBQVksQ0FBQyxTQUE2QixJQUE2QjtBQUFBLEVBQ3BGLFVBQVUsTUFBTSxRQUFRLFNBQVMsRUFBRSxDQUFDO0FBQUE7QUFJdEMsZUFBZSxTQUFTLENBQUMsTUFBYyxNQUEwQixTQUE2QjtBQUFBLEVBQzVGLE1BQU0sTUFBTSxRQUFRLElBQUk7QUFBQSxFQUN4QixJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixLQUFLLFNBQVMsR0FBRztBQUFBLElBQ2pCLE1BQU07QUFBQSxJQUNOLElBQUksaUJBQWlCLE9BQU8sV0FBVztBQUFBO0FBQUEsRUFFekMsSUFBSSxDQUFDLEdBQUcsT0FBTyxLQUFLLENBQUMsVUFBVSxHQUFHO0FBQUEsSUFDaEMsSUFBSSxxQ0FBcUMsT0FBTyxTQUFTLEVBQUUsU0FBUyxDQUFDLEdBQUcsY0FBYyxFQUFFLENBQUM7QUFBQSxFQUMzRixNQUFNLGFBQWEsU0FBUztBQUFBLElBQzFCLE1BQU07QUFBQSxJQUNOLE1BQU0sSUFBSSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQUEsSUFDekIsTUFBTSxhQUFhLEtBQUssTUFBTTtBQUFBLE9BQzFCLFNBQVMsWUFBWSxFQUFFLE1BQU0sUUFBUSxJQUFJLEVBQUUsSUFBSSxDQUFDO0FBQUEsRUFDdEQsQ0FBQztBQUFBO0FBSUgsZUFBZSxZQUFZLENBQUMsS0FBeUIsU0FBNkI7QUFBQSxFQUNoRixJQUFJLFFBQVE7QUFBQSxJQUNWLE9BQU8sYUFBYSxTQUFTLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQUEsRUFDNUUsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE1BQU0sT0FBTyxRQUFRO0FBQUEsRUFDMUQsSUFBSSxXQUFXO0FBQUEsSUFBSyxjQUFjLGFBQWEsUUFBUSxJQUFJO0FBQUEsRUFDM0QsVUFBVSxFQUFFLFdBQVksS0FBaUMsVUFBVSxDQUFDO0FBQUE7QUFvQnRFLElBQU0sVUFBVSxDQUFDLFNBQVM7QUFFMUIsSUFBTSxXQUEwQjtBQUFBLEVBQzlCO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsV0FBVyxXQUFXLFdBQVcsZUFBZTtBQUFBLElBQ3hELGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLE9BQU8sVUFBVSxLQUFLLENBQUM7QUFBQSxJQUMvRCxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxVQUFVLFFBQVEsS0FBSyxLQUFLO0FBQUEsRUFDekM7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxNQUFNLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUQsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUFZLE9BQU8sS0FBSyxPQUFPO0FBQUEsRUFDcEQ7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE1BQU07QUFBQSxJQUMxQixhQUFhLENBQUM7QUFBQSxJQUNkLFVBQVU7QUFBQSxJQUNWLEtBQUssQ0FBQyxNQUFNLE9BQU8sWUFBWSxTQUFTLFNBQVMsTUFBTSxTQUFTLElBQUk7QUFBQSxFQUN0RTtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsT0FBTztBQUFBLElBQzNCLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFDRTtBQUFBLElBQ0YsS0FBSyxDQUFDLE1BQU0sT0FBTyxZQUNqQixRQUFRLFNBQVMsT0FBTyxNQUFNLFVBQVUsV0FBVyxXQUFXLE1BQU0sS0FBSyxJQUFJLEVBQUU7QUFBQSxFQUNuRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsT0FBTyxRQUFRLE9BQU87QUFBQSxJQUMxQyxhQUFhLENBQUM7QUFBQSxJQUNkLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQ25DLE1BQU0sT0FBTyxPQUFPLE1BQU0sU0FBUyxXQUFXLGFBQWEsTUFBTSxNQUFNLFFBQVEsSUFBSTtBQUFBLE1BQ25GLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsV0FDRixPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLFdBQzlELFNBQVMsWUFBWSxFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsV0FDakMsT0FBTyxNQUFNLFVBQVUsV0FBVyxFQUFFLE9BQU8sTUFBTSxNQUFNLElBQUksQ0FBQztBQUFBLE1BQ2xFLENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsU0FBUyxXQUFXO0FBQUEsSUFDeEMsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsT0FBTyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQy9ELFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLFVBQVUsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLE9BQU8sTUFBTSxNQUFNLFlBQVksS0FBSyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUUxRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsS0FBSztBQUFBLElBQ3pCLGFBQWEsQ0FBQyxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzVDLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixTQUFTLGFBQWEsSUFBSSxNQUFNLElBQUksZ0JBQWdCO0FBQUEsV0FDaEQsT0FBTyxNQUFNLFFBQVEsV0FBVyxFQUFFLEtBQUssT0FBTyxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUNwRSxDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE9BQU8sV0FBVyxPQUFPO0FBQUEsSUFDN0MsYUFBYSxDQUFDLEVBQUUsTUFBTSxXQUFXLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDakQsVUFDRTtBQUFBLElBQ0YsS0FBSyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFDbEMsTUFBTSxJQUFLLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDaEMsTUFBTTtBQUFBLFFBQ04sU0FBUyxVQUFVLElBQUksTUFBTSxJQUFJLE1BQU07QUFBQSxXQUNuQyxPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLFdBQzlELE9BQU8sTUFBTSxZQUFZLFdBQ3pCLEVBQUUsU0FBUyxXQUFXLE1BQU0sU0FBUyxXQUFXLEVBQUUsSUFDbEQsQ0FBQztBQUFBLE1BQ1AsQ0FBQztBQUFBLE1BQ0QsSUFBSSxNQUFNO0FBQUEsUUFBTyxRQUFRLE9BQU8sTUFBTSxPQUFPLEVBQUUsV0FBVyxFQUFFLENBQUM7QUFBQSxNQUN4RDtBQUFBLGtCQUFVLENBQUM7QUFBQTtBQUFBLEVBRXBCO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxPQUFPLE9BQU87QUFBQSxJQUNsQyxhQUFhLENBQUMsRUFBRSxNQUFNLFdBQVcsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUNqRCxVQUNFO0FBQUEsSUFDRixLQUFLLE9BQU8sS0FBSyxPQUFPLFlBQVk7QUFBQSxNQUNsQyxNQUFNLFVBQVUsVUFBVSxJQUFJLE1BQU0sSUFBSSxPQUFPO0FBQUEsTUFLL0MsTUFBTSxTQUNKLE9BQU8sTUFBTSxVQUFVLFdBQ25CLE1BQU0sTUFBTSxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUMsTUFBTSxXQUFXLEdBQUcsU0FBUyxDQUFDLElBQzFEO0FBQUEsTUFDTixNQUFNLFFBQ0osV0FFRyxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3RCLE1BQU07QUFBQSxRQUNOO0FBQUEsV0FDSSxPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ3BFLENBQUMsR0FDRCxPQUFPLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxLQUN4QixDQUFDO0FBQUEsTUFDSCxVQUNFLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ047QUFBQSxRQUNBO0FBQUEsV0FDSSxPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ3BFLENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsS0FBSztBQUFBLElBQ3pCLGFBQWEsQ0FBQyxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzVDLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixTQUFTLGFBQWEsSUFBSSxNQUFNLElBQUksVUFBVTtBQUFBLFdBQzFDLE9BQU8sTUFBTSxRQUFRLFdBQVcsRUFBRSxLQUFLLE9BQU8sTUFBTSxHQUFHLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDcEUsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFDRTtBQUFBLElBQ0YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUFZO0FBQUEsTUFDN0IsTUFBTSxNQUFNLFFBQVEsSUFBSSxFQUFZO0FBQUEsTUFDcEMsT0FBTyxhQUFhLFNBQVMsRUFBRSxNQUFNLGNBQWMsS0FBSyxRQUFRLEdBQUcsR0FBRyxNQUFNLFNBQVMsR0FBRyxFQUFFLENBQUM7QUFBQTtBQUFBLEVBRS9GO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUFZO0FBQUEsTUFDN0IsTUFBTSxNQUFNLFFBQVEsSUFBSSxFQUFZO0FBQUEsTUFDcEMsT0FBTyxhQUFhLFNBQVM7QUFBQSxRQUMzQixNQUFNO0FBQUEsUUFDTixLQUFLLFFBQVEsR0FBRztBQUFBLFFBQ2hCLE1BQU0sU0FBUyxHQUFHO0FBQUEsTUFDcEIsQ0FBQztBQUFBO0FBQUEsRUFFTDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLE1BQy9CLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLElBQ2pDO0FBQUEsSUFDQSxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxRQUFRLFlBQ2pCLGFBQWEsU0FBUztBQUFBLE1BQ3BCLE1BQU07QUFBQSxNQUNOLE1BQU0sUUFBUSxJQUFJLEVBQVk7QUFBQSxNQUM5QixNQUFNLFFBQVEsSUFBSSxFQUFZO0FBQUEsSUFDaEMsQ0FBQztBQUFBLEVBQ0w7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsTUFDWCxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUs7QUFBQSxNQUMvQixFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUs7QUFBQSxJQUNqQztBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUNqQixhQUFhLFNBQVMsRUFBRSxNQUFNLFVBQVUsTUFBTSxRQUFRLElBQUksRUFBWSxHQUFHLE1BQU0sSUFBSSxHQUFHLENBQUM7QUFBQSxFQUMzRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLFVBQVU7QUFBQSxJQUNWLEtBQUssQ0FBQyxLQUFLLFFBQVEsWUFDakIsYUFBYSxTQUFTLEVBQUUsTUFBTSxRQUFRLE1BQU0sUUFBUSxJQUFJLEVBQVksRUFBRSxDQUFDO0FBQUEsRUFDM0U7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUMsRUFBRSxNQUFNLFNBQVMsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUMvQyxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxRQUFRLFlBQVksYUFBYSxTQUFTLEVBQUUsTUFBTSxVQUFVLE9BQU8sSUFBSSxHQUFHLENBQUM7QUFBQSxFQUN4RjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLFVBQVU7QUFBQSxJQUNWLEtBQUssQ0FBQyxLQUFLLFFBQVEsWUFDakIsYUFBYSxTQUFTLEVBQUUsTUFBTSxZQUFZLE1BQU0sUUFBUSxJQUFJLEVBQVksRUFBRSxDQUFDO0FBQUEsRUFDL0U7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE1BQU07QUFBQSxJQUMxQixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5QyxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxPQUFPLFlBQ2hCLFVBQVUsSUFBSSxJQUFjLE9BQU8sTUFBTSxTQUFTLFdBQVcsTUFBTSxPQUFPLFdBQVcsT0FBTztBQUFBLEVBQ2hHO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDLEVBQUUsTUFBTSxPQUFPLFVBQVUsTUFBTSxDQUFDO0FBQUEsSUFDOUMsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUFZLGFBQWEsSUFBSSxJQUFJLE9BQU87QUFBQSxFQUM3RDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLE1BQU0sQ0FBQztBQUFBLElBQy9DLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQ25DLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsV0FDRixJQUFJLE9BQU8sWUFBWSxFQUFFLE1BQU0sUUFBUSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUMxRCxDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLFFBQVEsVUFBVSxhQUFhLE9BQU8sT0FBTztBQUFBLElBQ2pFLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFDRTtBQUFBLElBQ0YsS0FBSyxPQUFPLE1BQU0sT0FBTyxZQUFZO0FBQUEsTUFDbkMsTUFBTSxTQUFpQyxDQUFDO0FBQUEsTUFDeEMsV0FBVyxLQUFLLENBQUMsUUFBUSxVQUFVLGFBQWEsS0FBSztBQUFBLFFBQ25ELElBQUksT0FBTyxNQUFNLE9BQU87QUFBQSxVQUFVLE9BQU8sS0FBSyxNQUFNO0FBQUEsTUFDdEQsSUFBSSxPQUFPLE1BQU0sVUFBVTtBQUFBLFFBQVUsT0FBTyxRQUFRLGVBQWUsTUFBTSxLQUFLO0FBQUEsTUFDOUUsVUFBVSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sUUFBUSxPQUFPLENBQUMsQ0FBQztBQUFBO0FBQUEsRUFFOUQ7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE9BQU87QUFBQSxJQUMzQixhQUFhLENBQUM7QUFBQSxJQUNkLFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQ25DLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsV0FDRixPQUFPLE1BQU0sVUFBVSxXQUFXLEVBQUUsT0FBTyxNQUFNLE1BQU0sSUFBSSxDQUFDO0FBQUEsTUFDbEUsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLEtBQUssUUFBUSxZQUFZO0FBQUEsTUFDbkMsVUFBVSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sYUFBYSxNQUFNLFFBQVEsSUFBSSxFQUFZLEVBQUUsQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUU1RjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsUUFBUSxJQUFJO0FBQUEsSUFDaEMsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFDRTtBQUFBLElBQ0YsS0FBSyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFDbEMsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxRQUNOLE1BQU0sUUFBUSxJQUFJLEVBQVk7QUFBQSxXQUMxQixPQUFPLE1BQU0sU0FBUyxXQUFXLEVBQUUsVUFBVSxNQUFNLEtBQUssSUFBSSxDQUFDO0FBQUEsV0FDN0QsT0FBTyxNQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksTUFBTSxHQUFHLElBQUksQ0FBQztBQUFBLE1BQ3pELENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLE1BQy9CLEVBQUUsTUFBTSxhQUFhLFVBQVUsTUFBTSxVQUFVLEtBQUs7QUFBQSxJQUN0RDtBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLEtBQUssUUFBUSxZQUFZO0FBQUEsTUFDbkMsTUFBTSxTQUFpQyxDQUFDO0FBQUEsTUFDeEMsV0FBVyxRQUFRLElBQUksTUFBTSxDQUFDLEdBQUc7QUFBQSxRQUMvQixNQUFNLEtBQUssS0FBSyxRQUFRLEdBQUc7QUFBQSxRQUMzQixJQUFJLE1BQU07QUFBQSxVQUNSLElBQUksSUFBSSwwQkFBMEIsU0FBUztBQUFBLFlBQ3pDLE1BQU07QUFBQSxVQUNSLENBQUM7QUFBQSxRQUNILE9BQU8sS0FBSyxNQUFNLEdBQUcsRUFBRSxLQUFLLEtBQUssTUFBTSxLQUFLLENBQUM7QUFBQSxNQUMvQztBQUFBLE1BQ0EsVUFDRSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sWUFBWSxNQUFNLFFBQVEsSUFBSSxFQUFZLEdBQUcsT0FBTyxDQUFDLENBQ3RGO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDO0FBQUEsSUFDZCxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsTUFBTSxRQUFRLFlBQVk7QUFBQSxNQUM5QixVQUFVLGVBQWUsT0FBTyxDQUFDO0FBQUE7QUFBQSxFQUVyQztBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLE1BQU0sUUFBUSxZQUFZO0FBQUEsTUFDcEMsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUFBLE1BQ3hDLFVBQVUsRUFBRSxJQUFJLE1BQU0sTUFBTSxRQUFRLENBQUM7QUFBQTtBQUFBLEVBRXpDO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDO0FBQUEsSUFDUixhQUFhLENBQUM7QUFBQSxJQUNkLFVBQVU7QUFBQSxJQUNWLEtBQUssTUFBTTtBQUFBLE1BQ1QsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsaUJBQWlCLEdBQUcsTUFBTSxDQUFDO0FBQUEsQ0FBSztBQUFBO0FBQUEsRUFFM0U7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUM7QUFBQSxJQUNSLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxNQUFNO0FBQUEsTUFDVCxRQUFRLE9BQU8sTUFBTSxHQUFHLFdBQVc7QUFBQSxDQUFLO0FBQUE7QUFBQSxFQUU1QztBQUNGO0FBRUEsSUFBTSxvQkFBb0I7QUFBQSxFQUN4QixFQUFFLE1BQU0sVUFBVSxNQUFNLE9BQU87QUFBQSxFQUMvQixFQUFFLE1BQU0sTUFBTSxNQUFNLE9BQU87QUFBQSxFQUMzQixFQUFFLE1BQU0sYUFBYSxNQUFNLFVBQVU7QUFBQSxFQUNyQyxFQUFFLE1BQU0sTUFBTSxNQUFNLFVBQVU7QUFDaEM7QUFFQSxJQUFNLGNBQWMsQ0FBQyxVQUNuQixTQUFTLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxLQUFLO0FBR2hDLFNBQVMsU0FBUyxDQUFDLE1BQStCO0FBQUEsRUFDdkQsU0FBUyxJQUFJLEVBQUcsSUFBSSxLQUFLLFFBQVEsS0FBSztBQUFBLElBQ3BDLE1BQU0sSUFBSSxLQUFLO0FBQUEsSUFDZixJQUFJLE1BQU07QUFBQSxNQUFNLE9BQU8sS0FBSyxJQUFJLE1BQU07QUFBQSxJQUN0QyxJQUFJLEVBQUUsV0FBVyxJQUFJLEdBQUc7QUFBQSxNQUN0QixJQUFJLEVBQUUsU0FBUyxHQUFHO0FBQUEsUUFBRztBQUFBLE1BQ3JCLE1BQU0sTUFBTSxFQUFFLE1BQU0sQ0FBQztBQUFBLE1BQ3JCLElBQUksT0FBTyxlQUFlLFlBQVksS0FBSyxTQUFTO0FBQUEsUUFBVTtBQUFBLE1BQzlEO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSSxFQUFFLFdBQVcsR0FBRztBQUFBLE1BQUc7QUFBQSxJQUN2QixPQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsT0FBTztBQUFBO0FBR0YsSUFBTSxRQUEyQixTQUFTLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSTtBQUMzRCxJQUFNLFlBQTZDLE9BQU8sWUFDL0QsU0FBUyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUN2QztBQUNPLElBQU0sV0FBVyxDQUFDLFNBQ3ZCLENBQUMsR0FBSSxZQUFZLElBQUksR0FBRyxTQUFTLENBQUMsQ0FBRSxFQUFFLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRyxFQUFFLEtBQUs7QUFFbEUsSUFBTSxhQUFhLENBQUMsTUFDbEIsWUFBWSxHQUFHLFNBQVMsWUFBWSxNQUFNLE9BQU8sTUFBTTtBQUN6RCxJQUFNLG1CQUFtQixDQUFDLE1BQThCO0FBQUEsRUFDdEQsTUFBTSxRQUFRLEVBQUUsV0FBVyxHQUFHLEVBQUUsWUFBWSxFQUFFO0FBQUEsRUFDOUMsT0FBTyxFQUFFLFdBQVcsSUFBSSxXQUFXLElBQUk7QUFBQTtBQUdsQyxTQUFTLE9BQU8sQ0FBQyxNQUEyQjtBQUFBLEVBQ2pELE9BQU87QUFBQSxJQUNMLEtBQUs7QUFBQSxJQUNMLEdBQUcsS0FBSyxZQUFZLElBQUksZ0JBQWdCO0FBQUEsSUFDeEMsR0FBRyxLQUFLLE1BQU0sT0FBTyxDQUFDLE1BQU0sTUFBTSxTQUFTLEVBQUUsSUFBSSxVQUFVO0FBQUEsRUFDN0QsRUFBRSxLQUFLLEdBQUc7QUFBQTtBQUdMLFNBQVMsVUFBVSxHQUFXO0FBQUEsRUFDbkMsTUFBTSxPQUFPLFNBQVMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBVTtBQUFBLEVBQ2xFLE1BQU0sUUFBUSxLQUFLLElBQUksS0FBSyxJQUFJLEdBQUcsS0FBSyxJQUFJLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxHQUFHLEVBQUU7QUFBQSxFQUNuRSxNQUFNLE9BQU8sS0FDVixJQUFJLEVBQUUsR0FBRyxPQUNSLEVBQUUsVUFBVSxRQUFRLEtBQUssRUFBRSxPQUFPLEtBQUssTUFBTSxNQUFNLEtBQUs7QUFBQSxJQUFRLEdBQUcsT0FBTyxLQUFLLE1BQU0sR0FDdkYsRUFDQyxLQUFLO0FBQUEsQ0FBSTtBQUFBLEVBQ1osT0FBTztBQUFBO0FBQUEsRUFFUDtBQUFBLElBQ0Usa0JBQWtCLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLEtBQUssS0FBSztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVc1QyxTQUFTLGdCQUFnQixHQUFHO0FBQUEsRUFDakMsTUFBTSxNQUFNLENBQUMsT0FBYSxFQUFFLE1BQU0sS0FBSyxLQUFLLE1BQU0sWUFBWSxHQUFHLE1BQU0sUUFBUSxRQUFRO0FBQUEsRUFDdkYsT0FBTztBQUFBLElBQ0wsZUFBZTtBQUFBLElBQ2YsWUFBWTtBQUFBLElBQ1osaUJBQWlCLEVBQUUsTUFBTSxDQUFDLFFBQVEsRUFBRTtBQUFBLElBQ3BDLFVBQVU7QUFBQSxNQUNSO0FBQUEsUUFDRSxNQUFNLENBQUM7QUFBQSxRQUNQLE1BQU0sa0JBQWtCLElBQUksQ0FBQyxPQUFPO0FBQUEsVUFDbEMsTUFBTSxFQUFFO0FBQUEsVUFDUixNQUFNO0FBQUEsVUFDTixRQUFRO0FBQUEsUUFDVixFQUFFO0FBQUEsUUFDRixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxNQUNoRDtBQUFBLE1BQ0EsR0FBRyxTQUFTLElBQUksQ0FBQyxPQUFPO0FBQUEsUUFDdEIsTUFBTSxDQUFDLEVBQUUsSUFBSTtBQUFBLFFBQ2IsTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsSUFBSSxHQUFHO0FBQUEsUUFDMUIsYUFBYSxFQUFFO0FBQUEsTUFDakIsRUFBRTtBQUFBLElBQ0o7QUFBQSxFQUNGO0FBQUE7QUFHRixlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxTQUFTLElBQUk7QUFBQSxJQUMxQixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sV0FBVyxlQUFlLENBQUM7QUFBQSxJQUNqQyxJQUFJLGFBQWE7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUc5QixNQUFNLE9BQ0osS0FBSyxPQUFPLE1BQU0sWUFBWSxVQUFVLElBQUksT0FBUSxFQUF3QixJQUFJLElBQUk7QUFBQSxJQUN0RixNQUFNLE1BQU0sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxJQUNyRCxJQUFJLFNBQVM7QUFBQSxNQUFVLE9BQU8sZUFBZSxJQUFJLFdBQVcsR0FBRyxDQUFDLEtBQUs7QUFBQSxJQUNyRSxPQUFPLGVBQWUsSUFBSSxTQUFTLFlBQVksR0FBRyxDQUFDLEtBQUs7QUFBQTtBQUFBO0FBSTVELGVBQWUsUUFBUSxDQUFDLE1BQWlDO0FBQUEsRUFDdkQsTUFBTSxjQUFjLGtCQUFrQixLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsS0FBSyxFQUFFO0FBQUEsRUFDcEUsSUFBSSxnQkFBZ0IsYUFBYSxLQUFLLE9BQU8sV0FBVztBQUFBLElBQ3RELEtBQUssYUFBYSxRQUFRLGVBQWU7QUFBQSxNQUFRLFFBQVEsT0FBTyxNQUFNLEdBQUcsV0FBVztBQUFBLENBQUs7QUFBQSxJQUNwRjtBQUFBLGdCQUFVLFlBQVksQ0FBQztBQUFBLElBQzVCLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxJQUFJLGtCQUFpQixVQUFVLElBQUk7QUFBQSxFQUNuQyxrQkFBa0IsZUFBYztBQUFBLEVBQ2hDLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFNBQVMsVUFBVSxJQUFJO0FBQUEsSUFDdkIsT0FBTyxHQUFHO0FBQUEsSUFDVixJQUFJLEVBQUUsYUFBYSxlQUFlLEVBQUUsT0FBTyxZQUFZO0FBQUEsTUFBVyxNQUFNO0FBQUEsSUFDeEUsTUFBTSxRQUFPLG9CQUFtQixPQUFPLFlBQVksWUFBWSxlQUFjO0FBQUEsSUFDN0UsSUFBSSxVQUFTO0FBQUEsTUFDWCxNQUFNLElBQUksV0FBVyxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUUsT0FBTyxNQUFNLFNBQVMsU0FBUyxNQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsSUFDdkYsTUFBTSxJQUFJLFdBQVcsRUFBRSxTQUFTO0FBQUEsTUFDOUIsTUFBTSwrQkFBMEIsTUFBTSxLQUFLLEdBQUc7QUFBQSxNQUM5QyxTQUFTLGtCQUFrQixJQUFJLENBQUMsTUFBTSxFQUFFLElBQUk7QUFBQSxJQUM5QyxDQUFDO0FBQUE7QUFBQSxFQUVILE9BQU8sU0FBUyxPQUFPLE9BQU87QUFBQSxFQUM5QixNQUFNLFFBQVEsT0FBTztBQUFBLEVBQ3JCLGtCQUFpQixRQUFRO0FBQUEsRUFDekIsa0JBQWtCLGVBQWM7QUFBQSxFQUVoQyxJQUFJLFNBQVM7QUFBQSxJQUNYLE1BQU0sSUFBSSxXQUFXLGlCQUFpQixFQUFFLE1BQU0sb0JBQW9CLFNBQVMsQ0FBQyxHQUFHLEtBQUssRUFBRSxDQUFDO0FBQUEsRUFDekYsTUFBTSxPQUFPLFlBQVksSUFBSTtBQUFBLEVBQzdCLElBQUksU0FBUztBQUFBLElBQ1gsTUFBTSxJQUFJLFdBQVcsaUJBQWlCLFNBQVM7QUFBQSxNQUM3QyxNQUFNO0FBQUEsTUFDTixTQUFTLENBQUMsR0FBRyxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUFBLEVBRUgsTUFBTSxVQUFVLElBQUksSUFBWSxLQUFLLEtBQUs7QUFBQSxFQUMxQyxNQUFNLFFBQVEsT0FBTyxLQUFLLEtBQUssRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFFBQVEsSUFBSSxDQUFDLENBQUM7QUFBQSxFQUM1RCxJQUFJLFVBQVUsV0FBVztBQUFBLElBQ3ZCLE1BQU0sV0FBVyxTQUFTLEtBQUssSUFBSTtBQUFBLElBQ25DLE1BQU0sSUFBSSxXQUNSLEtBQUssOEJBQThCLEtBQUssc0VBQ3hDLFNBQVMsU0FBUyxJQUFJLEVBQUUsU0FBUyxTQUFTLElBQUksRUFBRSxNQUFNLEdBQUcsS0FBSyxzQkFBc0IsQ0FDdEY7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLFdBQVcsS0FBSyxZQUFZLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFO0FBQUEsRUFDNUQsTUFBTSxXQUFXLEtBQUssWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFBQSxFQUN4RCxJQUFJLElBQUksU0FBUyxZQUFhLENBQUMsWUFBWSxJQUFJLFNBQVMsS0FBSyxZQUFZO0FBQUEsSUFDdkUsTUFBTSxJQUFJLFdBQVcsVUFBVSxRQUFRLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxFQUV6RSxNQUFNLFVBQVUsT0FBTyxNQUFNLFlBQVksV0FBVyxNQUFNLFVBQVU7QUFBQSxFQUNwRSxNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksS0FBSyxPQUFPLE9BQU87QUFBQSxFQUMvQyxPQUFPLE9BQU8sU0FBUyxXQUFXLE9BQU87QUFBQTtBQVEzQyxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICIzNDQ0QjIyMEQ1NURGNkVGNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
