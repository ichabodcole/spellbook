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
import { dirname, join, resolve } from "path";
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
  doc: { type: "string" },
  from: { type: "string" },
  full: { type: "boolean" },
  label: { type: "string" },
  "no-open": { type: "boolean" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  "start-timeout": { type: "string" },
  stdin: { type: "boolean" },
  timeout: { type: "string" }
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
function parseVersion(token, what) {
  const m = /^v?(\d+)$/.exec(token.trim());
  if (!m || Number(m[1]) < 1)
    die(`${what}: "${token}" is not a version \u2014 write v1, v2, \u2026`, "usage", {
      hint: "run: cli.ts state (each doc lists its versions)"
    });
  return Number(m[1]);
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
  parseSince,
  parseVersion,
  renderHelp,
  run,
  usageOf,
  verbToken
};

//# debugId=A35D4392E63217B964756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RyZWUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSBDTEkg4oCUIHRoZSBhZ2VudCdzIGhhbGYuIEEgdGhpbiBjbGllbnQgb2YgdGhlIHBlci1zZXNzaW9uIGRhZW1vblxuICogKGBzZXJ2ZXIudHNgKTogYG9wZW5gIHNwYXducyBvbmUsIGV2ZXJ5IG90aGVyIHZlcmIgZmluZHMgaXQgdGhyb3VnaCB0aGVcbiAqIHNlc3Npb24gcG9pbnRlciBpbiB0bXBkaXIgKEUxMykgYW5kIHNwZWFrcyBIVFRQLiBgdGFpbGAgc3RyZWFtcyB0aGUgaHVtYW4nc1xuICogbWVzc2FnZXMgYXMgSlNPTiBsaW5lcyBmb3IgTW9uaXRvciB0byB3cmFwLlxuICpcbiAqIOKUgOKUgCBUSEUgRUlHSFQgUVVFU1RJT05TIChzY2FmZm9sZGluZyBwbGF5Ym9vayBOMSksIEFOU1dFUkVEIEFTIERFU0lHTiDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBBcml0aG1ldGljOiBOT05FIGNhcnJpZWQgYmV5b25kIHdoYXQgaXMgdHJ1ZSBhdCB0aGUgZW1pdHRlZCBhZGRyZXNzLlxuICogICAgRnJvbSBgZGlzdC9jbGkuanNgLCBgLi5gIGlzIHRoZSBza2lsbCBmb2xkZXIsIHNvIHRoZSBkYWVtb24gbGF1bmNoZXIgaXNcbiAqICAgIGAuLi9zY3JpcHRzL3NlcnZlci50c2AgKHVwIGFuZCBiYWNrIGRvd24g4oCUIG5ldmVyIGEgZmxhdCBzaWJsaW5nKSwgYW5kIHRoZVxuICogICAgZGV2IGN3ZCBpcyBgc3JjL3NjcmlwdG9yaXVtL2AgZml2ZSBsZXZlbHMgdXAgKENvbnRyYWN0IDUpLCB1c2VkIG9ubHkgd2hlblxuICogICAgZGV2IG1vZGUgaXMgcmVzb2x2ZWQuXG4gKiAyLiBTZXJ2ZXM6IG5vLlxuICogMy4gU2Vjb25kIGhhbGY6IFlFUyDigJQgc2hhcmVzIGAuL2hlYXJ0YmVhdC50c2Agd2l0aCB0aGUgZGFlbW9uICh0aGUgdGFpbFxuICogICAgd2F0Y2hkb2cgaXMgZGVyaXZlZCBmcm9tIHRoZSBkYWVtb24ncyBoZWFydGJlYXQsIG5ldmVyIGNvcGllZCkuXG4gKiA0LiBMaWZlY3ljbGU6IHNpbmdsZS1zaG90IHBlciB2ZXJiOyBgdGFpbGAgaXMgbG9uZy1ydW5uaW5nIGFuZCByZXR1cm5zIGl0c1xuICogICAgb3duIGV4aXQgY29kZS5cbiAqIDUuIGBtYWluKClgIHJldHVybnMgd2hpbGUgdGhlIHByb2Nlc3MgbXVzdCBsaXZlPyBOTyDihpIgTkFUVVJBTC1SRVRVUk5cbiAqICAgIGxhdW5jaGVyIChgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IHJ1bigpYCk6IHN0ZG91dCBpcyBhIHBpcGUgdGhlIGFnZW50XG4gKiAgICBwYXJzZXMsIGFuZCBhbiBleHBsaWNpdCBleGl0IHRydW5jYXRlcyBpdCBhdCA2NCBLaUIuIGBvcGVuYCByZWxlYXNlcyB0aGVcbiAqICAgIGRhZW1vbidzIHN0ZG91dCBwaXBlIHNvIHRoZSBuYXR1cmFsIHJldHVybiBpcyBub3QgaGVsZCBvcGVuIGJ5IGl0LlxuICogNi4gRXZlbnQgaWRzIGFjcm9zcyByZXN0YXJ0OiB0aGUgZGFlbW9uJ3MgYXJlIHBlci1ib290IGFuZCBlcG9jaC1zdGFtcGVkO1xuICogICAgdGhpcyBzaWRlIHJlc2V0cyBpdHMgY3Vyc29yIG9uIGFuIGVwb2NoIGNoYW5nZSBhbmQgc2F5cyBzbyBpbiBvbmUgbGluZS5cbiAqIDcuIEEga2l0IHN1YmplY3QgaW4gYSBkaWZmZXJlbnQgc2hhcGU/IE5vLlxuICogOC4gQSBraXQgbW9kdWxlIG5hbWVzIHRoaXMgc3BlbGwgYXMgaXRzIHNvdXJjZT8gU3RydWN0dXJhbGx5IG5vLlxuICpcbiAqIOKUgOKUgCBFUlJPUiBDT05UUkFDVCAoYWNjIEwwLCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEV2ZXJ5IGZhaWx1cmUgaXMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyLCBzdGRvdXQgZW1wdHkg4oCUXG4gKiAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbiAqICAgdXNhZ2Ug4oaSIDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IMK3IGNvbmZsaWN0IOKGkiA2XG4gKiBBIGRhZW1vbiByZWZ1c2FsIG1hcHMgb2ZmIGl0cyBIVFRQIHN0YXR1cyAoNDAwIHVzYWdlLCA0MDQgbm90X2ZvdW5kLCA0MDlcbiAqIGNvbmZsaWN0LCBlbHNlIGludGVybmFsKTsgdGhlIGRhZW1vbidzIGJvZHkgcmlkZXMgdmVyYmF0aW0gdW5kZXJcbiAqIGBlcnJvci5zZXJ2ZXJgLCBhbmQgd2hlbiB0aGUgZGFlbW9uIG5hbWVkIHRoZSB2YWxpZCBzZXQgKGEgZG9jIHNsdWcsIGFcbiAqIHZlcnNpb24pIHRoYXQgc2V0IGlzIEFMU08gbGlmdGVkIGludG8gYGNob2ljZXNgIOKAlCBBMTogdGhlIHNldCBpcyBpbiBoYW5kIGF0XG4gKiB0aGUgcmFpc2UsIGJlY2F1c2UgdGhlIGRhZW1vbiBoYW5kZWQgaXQgb3Zlci5cbiAqXG4gKiDim5QgVGhlIGtpdCBjYXJyaWVzIHRoZSBFTlZFTE9QRSwgbm90IHRoZSBDTEFTU0lGSUVSOiBgcmVwb3J0Q2xpRXJyb3JgXG4gKiByZXR1cm5zIG51bGwgZm9yIGEgbm9uLUNsaUVycm9yLCBhbmQgYG1haW5gIGJlbG93IHRyaWFnZXMgRU5PRU5UIChhIG5hbWVkXG4gKiBmaWxlIHRoZSBjYWxsZXIgZ2F2ZSkgaW50byB1c2FnZSBhbmQgZXZlcnl0aGluZyBlbHNlIGludG8gaW50ZXJuYWwuXG4gKlxuICogRDggcmVhY2hhYmlsaXR5LCBhdWRpdGVkIGJ5IGNhbGwgZ3JhcGg6IGV2ZXJ5IGBkaWVgIGhlcmUgaXMgcmVhY2hlZCBmcm9tIGFcbiAqIHZlcmIgaGFuZGxlciBvciBgZGlzcGF0Y2hgLCBub25lIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLiBUaGVcbiAqIHN3YWxsb3dpbmcgY2F0Y2hlcyAoYGFwaWAncyBub24tSlNPTiBib2R5LCBgdmVyc2lvbkluZm9gLCBgcG9zdENtZGAncyBjbG9zZVxuICogRUNPTk5SRVNFVCkgY29udGFpbiBubyBkaWUtcmVhY2hhYmxlIGNhbGwuXG4gKi9cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBjbG9zZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgb3BlblN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHN0YXRTeW5jLFxuICB1bmxpbmtTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuaW1wb3J0IHtcbiAgQ2xpRXJyb3IsXG4gIGRpZSxcbiAgdHlwZSBFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbiAgc2V0Q3VycmVudENvbW1hbmQsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBET0NfRVhURU5TSU9OUywgaXNEb2NOYW1lIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG4vLyDimqAgREVDTEFSRUQgRklSU1QsIEFCT1ZFIEVWRVJZIE9USEVSIEZVTkNUSU9OLCBPTiBQVVJQT1NFLiBUaGUgYGNob2ljZXNgXG4vLyBjZW5zdXMncyByYWlzZXIgcnVsZSAoYSkgKGBncmltb2lyZS9saWIvZXJyb3Itc2l0ZXMudHNgKSBtYXRjaGVzXG4vLyBgZnVuY3Rpb24gTkFNRShgIGxhemlseSB1cCB0byB0aGUgbmV4dCBgKTogbmV2ZXJgIHdpdGhpbiA2MDAgY2hhcmFjdGVycywgc29cbi8vIEFOWSBmdW5jdGlvbiBkZWNsYXJlZCBzaG9ydGx5IGFib3ZlIHRoaXMgb25lIOKAlCBgYXBpYCwgdGhlbiBgcmVxdWlyZVNlc3Npb25gIOKAlFxuLy8gd2FzIHJlYWQgYXMgYSByYWlzZXIgYW5kIGl0cyBjYWxscyBjb3VudGVkIGFzIHJhaXNlIHNpdGVzIChmb3VuZCAyMDI2LTA5LTExLFxuLy8gcmVwb3J0ZWQgaW4gdGhlIHNsaWNlLUEgam91cm5hbCBhcyBhbiBpbnN0cnVtZW50IGRlZmVjdCwgbm90IGZpeGVkIGhlcmUpLlxuZnVuY3Rpb24gZGFlbW9uUmVmdXNlZCh3aGF0OiBzdHJpbmcsIHN0YXR1czogbnVtYmVyLCBkYXRhOiB1bmtub3duKTogbmV2ZXIge1xuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICBzdGF0dXMgPT09IDQwMFxuICAgICAgPyBcInVzYWdlXCJcbiAgICAgIDogc3RhdHVzID09PSA0MDRcbiAgICAgICAgPyBcIm5vdF9mb3VuZFwiXG4gICAgICAgIDogc3RhdHVzID09PSA0MDlcbiAgICAgICAgICA/IFwiY29uZmxpY3RcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICBjb25zdCBib2R5ID0gKGRhdGEgPz8ge30pIGFzIHsgZXJyb3I/OiB1bmtub3duOyBjaG9pY2VzPzogdW5rbm93biB9O1xuICBjb25zdCBjaG9pY2VzID0gQXJyYXkuaXNBcnJheShib2R5LmNob2ljZXMpID8gYm9keS5jaG9pY2VzLm1hcChTdHJpbmcpIDogdW5kZWZpbmVkO1xuICBkaWUodHlwZW9mIGJvZHkuZXJyb3IgPT09IFwic3RyaW5nXCIgPyBib2R5LmVycm9yIDogYCR7d2hhdH0gZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBraW5kLCB7XG4gICAgLi4uKGNob2ljZXMgPyB7IGNob2ljZXMgfSA6IHt9KSxcbiAgICAuLi4oZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoQnVuLmZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcInNjcmlwdG9yaXVtXCIpO1xuXG4vKiogQ29udHJhY3QgNTogYSBkZXYgZGFlbW9uIG11c3QgcnVuIHdpdGggY3dkIGF0IGBzcmMvc2NyaXB0b3JpdW0vYCAoYnVuZmlnLnRvbWwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vKiogYCRTQ1JJUFRPUklVTV9IT01FYCwgZGVmYXVsdCBgfi8uc2NyaXB0b3JpdW1gIOKAlCB0aGUgc2FtZSBydWxlIGFzIHRoZSBkYWVtb24ncy4gKi9cbmZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbnR5cGUgU2Vzc2lvblBvaW50ZXIgPSB7IHVybDogc3RyaW5nOyBwb3J0OiBudW1iZXI7IHNlc3Npb25faWQ6IHN0cmluZzsgaG9tZTogc3RyaW5nOyBkaXI6IHN0cmluZyB9O1xuXG5jb25zdCBOT19TRVNTSU9OX0hJTlQgPSB7IGhpbnQ6IFwicnVuOiBjbGkudHMgb3BlbiAob3IgcGFzcyAtLXNlc3Npb24gPGlkPilcIiB9O1xuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHRtcGRpcigpLCBzZXNzaW9uID8gYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbn0uanNvbmAgOiBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xufVxuXG4vKiogTlVMTCBNRUFOUyBcIk5PIFNFU1NJT05cIiwgQU5EIE5PVEhJTkcgRUxTRSDigJQgRU5PRU5UIGlzIHRoZSBvbmx5IGFic2VuY2UuICovXG5mdW5jdGlvbiByZWFkU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvblBvaW50ZXIgfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gbnVsbDtcbiAgICBkaWUoYGNhbm5vdCByZWFkIHRoZSBzZXNzaW9uIHBvaW50ZXIgKCR7Y29kZSA/PyBcInVua25vd24gZXJyb3JcIn0pOiAke3BhdGh9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykgYXMgU2Vzc2lvblBvaW50ZXI7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgc2NyaXB0b3JpdW0gc2Vzc2lvblwiLCBcIm5vdF9mb3VuZFwiLCBOT19TRVNTSU9OX0hJTlQpO1xuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gYm9keSAqL1xuICB9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGxldCBzdGF0dXM6IG51bWJlcjtcbiAgbGV0IGRhdGE6IHVua25vd247XG4gIHRyeSB7XG4gICAgKHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIG1zZykpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBgY2xvc2VgIHN0b3BzIHRoZSBzZXJ2ZXI7IGEgUkVTRVQgaXMgaXRzIHN1Y2Nlc3MuIEEgcmVmdXNlZCBjb25uZWN0aW9uXG4gICAgLy8gKGEgc3RhbGUgcG9pbnRlcikgaXMgYSB0cmFuc3BvcnQgZmFpbHVyZSBsaWtlIGFueSBvdGhlci5cbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGNvbnN0IGNvZGUgPSBlcnIgJiYgdHlwZW9mIGVyciA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlcnIgPyBTdHJpbmcoZXJyLmNvZGUpIDogXCJcIjtcbiAgICBpZiAobXNnLnR5cGUgPT09IFwiY2xvc2VcIiAmJiAoY29kZSA9PT0gXCJFQ09OTlJFU0VUXCIgfHwgbWVzc2FnZS5pbmNsdWRlcyhcIkVDT05OUkVTRVRcIikpKVxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFN0cmluZyhtc2cudHlwZSksIHN0YXR1cywgZGF0YSk7XG4gIHJldHVybiBkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG4vLyDilIDilIAgdGhlIHBhcnNlciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkb2M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IFJFQ09HTklaRURfRkxBR1MgPSBPYmplY3Qua2V5cyhDTElfT1BUSU9OUykubWFwKChrKSA9PiBgLS0ke2t9YCk7XG5cbmV4cG9ydCBjbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgQ2xpRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkge1xuICAgIHN1cGVyKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFyZ3MoYXJnczogc3RyaW5nW10pOiB7XG4gIHBvczogc3RyaW5nW107XG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbn0ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgdmFsdWVzLCBwb3NpdGlvbmFscyB9ID0gbm9kZVBhcnNlQXJncyh7XG4gICAgICBhcmdzLFxuICAgICAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICAgIHJldHVybiB7IHBvczogcG9zaXRpb25hbHMsIGZsYWdzOiB2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4gfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgeyBjb2RlPzogc3RyaW5nIH0pLmNvZGU7XG4gICAgLy8gT25seSBhbiBVTktOT1dOIG9wdGlvbiBuYW1lcyB0aGUgZmxhZyByb3N0ZXI7IHRoZSBvdGhlciBwYXJzZSBmYWlsdXJlc1xuICAgIC8vIG1lYW4gYSByZWNvZ25pc2VkIGZsYWcgd2FzIG1pc3VzZWQsIGFuZCB0aGUgcm9zdGVyIHdvdWxkIG5hbWUgdGhlIGhhbGZcbiAgICAvLyB0aGF0IHdhcyByaWdodC5cbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihkZXRhaWwsIHtcbiAgICAgIGhpbnQ6IFwiZm9yIGZyZWUgdGV4dCBjb250YWluaW5nIGRhc2hlcywgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLVwiLFxuICAgICAgLi4uKGNvZGUgPT09IFwiRVJSX1BBUlNFX0FSR1NfVU5LTk9XTl9PUFRJT05cIiA/IHsgY2hvaWNlczogUkVDT0dOSVpFRF9GTEFHUyB9IDoge30pLFxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICogYC0tc2luY2VgIGlzIGFuIGV2ZW50IGlkOiBhbiBpbnRlZ2VyLCAtMSBmb3IgXCJldmVyeXRoaW5nXCIuIFZlcmlmeS1wYXNzIGZpeFxuICogOTogYC0tc2luY2UgYWJjYCBwYXJzZWQgdG8gTmFOLCB3aGljaCB0aGUgbG9nIHJlYWRzIGFzIFwiZnJvbSB0aGUgc3RhcnRcIiwgc29cbiAqIGEgdHlwbyByZXBsYXllZCB0aGUgd2hvbGUgYnVmZmVyIGludG8gdGhlIGFnZW50J3MgcGlwZSBhdCBleGl0IDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlKHRva2VuOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdCh0b2tlbi50cmltKCkpKVxuICAgIGRpZShcbiAgICAgIGAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGFuIGV2ZW50IGlkIOKAlCBnaXZlIGFuIGludGVnZXIgKHRoZSBpZCBvZiB0aGUgbGFzdCBsaW5lIHlvdSBzYXcpYCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICApO1xuICByZXR1cm4gTnVtYmVyLnBhcnNlSW50KHRva2VuLCAxMCk7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog4puUIFZFUklGWS1QQVNTIEZJWCA1OiBldmVyeSBwYXRoIGlzIGNoZWNrZWQgSEVSRSwgYmVmb3JlIGFueSBkYWVtb24gZXhpc3RzLlxuICogYG9wZW4gZG9jLm1kIHBpYy5wbmdgIHVzZWQgdG8gc3Bhd24gYSBzZXNzaW9uLCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBwYXRoXG4gKiBpbnNpZGUgaXQg4oCUIGxlYXZpbmcgYSBydW5uaW5nIGRhZW1vbiBhbmQgYSBsaXZlIHBvaW50ZXIgYmVoaW5kIGEgZmFpbGVkXG4gKiBjb21tYW5kLiBBIGZvbGRlciBvciBhIGRvY3VtZW50IGlzIGFjY2VwdGVkOyBhIG1pc3NpbmcgcGF0aCBpcyBub3RfZm91bmQsIGFcbiAqIG5vbi1kb2N1bWVudCBmaWxlIGlzIHVzYWdlIHdpdGggdGhlIGFjY2VwdGVkIGV4dGVuc2lvbnMgYXMgYGNob2ljZXNgLlxuICovXG5mdW5jdGlvbiBjb250ZXh0UGF0aHMocG9zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcGF0aHMgPSBwb3MubWFwKChwKSA9PiByZXNvbHZlKHApKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG4gICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgdHJ5IHtcbiAgICAgIHN0ID0gc3RhdFN5bmMocCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBkaWUoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7cH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICB9XG4gICAgaWYgKCFzdC5pc0RpcmVjdG9yeSgpICYmICFpc0RvY05hbWUocCkpXG4gICAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke3B9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwiYWRkIGEgZm9sZGVyLCBvciBhIGZpbGUgd2l0aCBvbmUgb2YgdGhlc2UgZXh0ZW5zaW9uc1wiLFxuICAgICAgICBjaG9pY2VzOiBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIHBhdGhzO1xufVxuXG4vKipcbiAqIGAtLWRvY2AgYXMgdGhlIENMSSdzIGNhbGxlciBtZWFudCBpdCAodmVyaWZ5LXBhc3MgZml4IDgpOiBhIHRva2VuIHdpdGggYSBwYXRoXG4gKiBzZXBhcmF0b3IsIG9yIG9uZSBuYW1pbmcgYSBmaWxlIGluIFRISVMgcHJvY2VzcydzIGN3ZCwgaXMgcmVzb2x2ZWQgaGVyZSB0byBhblxuICogYWJzb2x1dGUgcGF0aCDigJQgdGhlIGRhZW1vbidzIGN3ZCBpcyBub3QgdGhlIGNhbGxlcidzLiBBbnl0aGluZyBlbHNlIChhIHNsdWcsXG4gKiBhIHVuaXF1ZSBmaWxlIG5hbWUpIGdvZXMgYXMgdHlwZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NBcmcodG9rZW46IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0b2tlbi5pbmNsdWRlcyhcIi9cIikgfHwgZXhpc3RzU3luYyhyZXNvbHZlKHRva2VuKSkpIHJldHVybiByZXNvbHZlKHRva2VuKTtcbiAgcmV0dXJuIHRva2VuO1xufVxuXG4vKiogS2VlcCB0aGUgbmV3ZXN0IGBMT0dfS0VFUCAtIDFgIGRhZW1vbiBsb2dzLCBzbyB0aGUgb25lIGFib3V0IHRvIGJlIHdyaXR0ZW4gbWFrZXMgYExPR19LRUVQYC4gKi9cbmNvbnN0IExPR19LRUVQID0gMTA7XG5mdW5jdGlvbiBwcnVuZUxvZ3MobG9nRGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgbGV0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIG5hbWVzID0gcmVhZGRpclN5bmMobG9nRGlyKS5maWx0ZXIoKG4pID0+IC9eZGFlbW9uLVxcZCstXFxkK1xcLmxvZyQvLnRlc3QobikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYnlBZ2UgPSBuYW1lcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoYS5zcGxpdChcIi1cIilbMV0pIC0gTnVtYmVyKGIuc3BsaXQoXCItXCIpWzFdKSk7XG4gIGZvciAoY29uc3QgbiBvZiBieUFnZS5zbGljZSgwLCBNYXRoLm1heCgwLCBieUFnZS5sZW5ndGggLSAoTE9HX0tFRVAgLSAxKSkpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoam9pbihsb2dEaXIsIG4pKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuXG4gIGlmICh0eXBlb2YgZmxhZ3MucmVzdG9yZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgICBjb25zdCBtYW5pZmVzdCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBmbGFncy5yZXN0b3JlLCBcIm1hbmlmZXN0Lmpzb25cIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKG1hbmlmZXN0KSkge1xuICAgICAgbGV0IHNhdmVkOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgdHJ5IHtcbiAgICAgICAgc2F2ZWQgPSAoXG4gICAgICAgICAgYXdhaXQgQXJyYXkuZnJvbUFzeW5jKG5ldyBCdW4uR2xvYihcIiovbWFuaWZlc3QuanNvblwiKS5zY2FuKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkpXG4gICAgICAgICkubWFwKChwKSA9PiBwLnNwbGl0KFwiL1wiKVswXSBhcyBzdHJpbmcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vIHNlc3Npb25zIGZvbGRlcjogdGhlIHNldCBpcyBlbXB0eSwgYW5kIHNheXMgc28gKi9cbiAgICAgIH1cbiAgICAgIGRpZShgbm8gc2F2ZWQgc2Vzc2lvbiBcIiR7ZmxhZ3MucmVzdG9yZX1cIiB1bmRlciAke2hvbWV9YCwgXCJub3RfZm91bmRcIiwge1xuICAgICAgICBjaG9pY2VzOiBzYXZlZC5zb3J0KCksXG4gICAgICAgIC4uLihzYXZlZC5sZW5ndGggPT09IDAgPyB7IGhpbnQ6IFwibm8gc2F2ZWQgc2Vzc2lvbnMgaW4gdGhpcyBob21lXCIgfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCBsaXZlID0gcmVhZFNlc3Npb24oZmxhZ3MucmVzdG9yZSk7XG4gICAgaWYgKGxpdmUpIHtcbiAgICAgIGNvbnN0IGFsaXZlID0gYXdhaXQgYXBpKGxpdmUucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIikudGhlbihcbiAgICAgICAgKHIpID0+IHIuc3RhdHVzID09PSAyMDAsXG4gICAgICAgICgpID0+IGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGlmIChhbGl2ZSlcbiAgICAgICAgZGllKGBzZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX0gaXMgYWxyZWFkeSBydW5uaW5nIGF0ICR7bGl2ZS51cmx9YCwgXCJjb25mbGljdFwiLCB7XG4gICAgICAgICAgaGludDogYHVzZSBpdDogY2xpLnRzIHN0YXRlIC0tc2Vzc2lvbiAke2ZsYWdzLnJlc3RvcmV9YCxcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZGFlbW9uQXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKHR5cGVvZiBmbGFncy50aW1lb3V0ID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MucmVzdG9yZSA9PT0gXCJzdHJpbmdcIikgZGFlbW9uQXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIGZsYWdzLnJlc3RvcmUpO1xuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSlcbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCB3aGljaCBuZWVkcyBzcmMvc2NyaXB0b3JpdW0vIOKAlCByZWluc3RhbGwgdGhlIHNwZWxsIG9yIGJ1aWxkIGl0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIC8vIFRoZSBkYWVtb24ncyBzdGRlcnIgZ29lcyB0byBhIExPRyBGSUxFLCBub3QgdG8gdGhpcyBDTEkncyBzdGRlcnIuIEFuXG4gIC8vIGluaGVyaXRlZCBzdGRlcnIgb3V0bGl2ZXMgdGhlIENMSSBpbnNpZGUgdGhlIGRldGFjaGVkIGRhZW1vbiwgc28gYW55IGNhbGxlclxuICAvLyB0aGF0IHJlYWRzIGBvcGVuYCdzIHN0ZGVyciB0byBFT0YgKGEgdGVzdCBoYXJuZXNzLCBhIHRvb2wgcnVubmVyKSB3YWl0cyBmb3JcbiAgLy8gdGhlIHdob2xlIHNlc3Npb24g4oCUIG1lYXN1cmVkOiB0aGUgaW50ZWdyYXRpb24gY2VsbCBodW5nIGF0IGl0cyA2MCBzIHRpbWVvdXQuXG4gIC8vIEEgZmlsZSBob2xkcyBubyBwaXBlLCBhbmQgYSBzdGFydCBmYWlsdXJlIGJlbG93IHF1b3RlcyBpdHMgdGFpbC5cbiAgY29uc3QgbG9nRGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJsb2dzXCIpO1xuICBta2RpclN5bmMobG9nRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IHRoZSBsb2dzIHVzZWQgdG8gcGlsZSB1cCwgb25lIHBlciBgb3BlbmAsIGZvcmV2ZXIuXG4gIHBydW5lTG9ncyhsb2dEaXIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihsb2dEaXIsIGBkYWVtb24tJHtEYXRlLm5vdygpfS0ke3Byb2Nlc3MucGlkfS5sb2dgKTtcbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1sb2dcIiwgbG9nUGF0aCk7XG4gIGNvbnN0IGxvZ0ZkID0gb3BlblN5bmMobG9nUGF0aCwgXCJhXCIpO1xuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgbG9nRmRdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjbG9zZVN5bmMobG9nRmQpO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0sIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBsaW5lID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzLCByZWopID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWooXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgcGFzcyAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+YCxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgc3RhcnRUaW1lb3V0TXMsXG4gICAgKTtcbiAgICBjaGlsZC5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWooZXJyKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImV4aXRcIiwgKGNvZGUpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWoobmV3IEVycm9yKGBkYWVtb24gZXhpdGVkIHdpdGggY29kZSAke2NvZGV9IGJlZm9yZSBpdHMgaGFuZHNoYWtlYCkpO1xuICAgIH0pO1xuICB9KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgbGV0IHRhaWwgPSBcIlwiO1xuICAgIHRyeSB7XG4gICAgICB0YWlsID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmOFwiKS50cmltKCkuc2xpY2UoLTgwMCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBsb2cgd3JpdHRlbiAqL1xuICAgIH1cbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gZGFlbW9uIGZhaWxlZCB0byBzdGFydDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHsgaGludDogdGFpbCA/IGBkYWVtb24gbG9nICgke2xvZ1BhdGh9KTogJHt0YWlsfWAgOiBgZGFlbW9uIGxvZzogJHtsb2dQYXRofWAgfSxcbiAgICApO1xuICB9KTtcblxuICAvLyBSZWxlYXNlIHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSwgb3IgdGhpcyBDTEkncyBuYXR1cmFsIHJldHVybiB3YWl0cyBvbiBhXG4gIC8vIHN0cmVhbSB0aGF0IG5ldmVyIGNsb3NlcyAoZ2xhbW91ciBtZWFzdXJlZCA5MSBzIOKGkiAxIHMpLiBDaGVja2VkIGZvciB0aGVcbiAgLy8gTUVUSE9EOiB1bmRlciBCdW4gdGhpcyBwaXBlIGlzIGEgcGxhaW4gUmVhZGFibGUgdGhhdCBub25ldGhlbGVzcyBoYXMgdW5yZWYuXG4gIGNvbnN0IG91dCA9IGNoaWxkLnN0ZG91dDtcbiAgaWYgKCFvdXQgfHwgIShcInVucmVmXCIgaW4gb3V0KSB8fCB0eXBlb2Ygb3V0LnVucmVmICE9PSBcImZ1bmN0aW9uXCIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzY3JpcHRvcml1bTogdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlIGhhcyBubyB1bnJlZigpOyBgb3BlbmAgd291bGQgbmV2ZXIgZXhpdFwiLFxuICAgICk7XG4gIG91dC51bnJlZigpO1xuXG4gIGxldCBoczoge1xuICAgIHVybDogc3RyaW5nO1xuICAgIHBvcnQ6IG51bWJlcjtcbiAgICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gICAgb2s/OiBib29sZWFuO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfTtcbiAgdHJ5IHtcbiAgICBocyA9IEpTT04ucGFyc2UobGluZSk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7bGluZX1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIGlmIChocy5vayA9PT0gZmFsc2UpIGRhZW1vblJlZnVzZWQoXCJvcGVuXCIsIGhzLnN0YXR1cyA/PyA1MDAsIGhzKTtcblxuICBsZXQgZW50cmllczogdW5rbm93bltdID0gW107XG4gIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgciA9IGF3YWl0IHBvc3RDbWQoaHMuc2Vzc2lvbl9pZCwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pO1xuICAgIGVudHJpZXMgPSAoci5lbnRyaWVzIGFzIHVua25vd25bXSkgPz8gW107XG4gIH1cbiAgcHJpbnRKc29uKHsgLi4uaHMsIC4uLihwYXRocy5sZW5ndGggPiAwID8geyBlbnRyaWVzIH0gOiB7fSkgfSk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW2hzLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWRkKHBvczogc3RyaW5nW10sIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZ1bGw6IGJvb2xlYW4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiP2Z1bGw9MVwiIDogXCJcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IFwic2F5IG5lZWRzIGEgbWVzc2FnZVwiXG4gICAgICAgIDogXCJzYXkgdGFrZXMgaXRzIG1lc3NhZ2UgZnJvbSBleGFjdGx5IG9uZSBwbGFjZTogYXJndW1lbnRzLCAtLXN0ZGluIG9yIC0tYm9keS1maWxlXCIsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZ2l2ZSB0aGUgdGV4dCBhcyBhcmd1bWVudHMsIG9yIHByb3NlIHRocm91Z2ggLS1ib2R5LWZpbGUgPHBhdGg+IC8gLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIixcbiAgICAgICAgY2hvaWNlczogW1wiLS1zdGRpblwiLCBcIi0tYm9keS1maWxlXCJdLFxuICAgICAgfSxcbiAgICApO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBpZiAoZmxhZ3Muc3RkaW4gPT09IHRydWUpIHRleHQgPSBhd2FpdCBuZXcgUmVzcG9uc2UoQnVuLnN0ZGluLnN0cmVhbSgpKS50ZXh0KCk7XG4gIGVsc2UgaWYgKHR5cGVvZiBmbGFnc1tcImJvZHktZmlsZVwiXSA9PT0gXCJzdHJpbmdcIikgdGV4dCA9IHJlYWRGaWxlU3luYyhmbGFnc1tcImJvZHktZmlsZVwiXSwgXCJ1dGY4XCIpO1xuICBlbHNlIHRleHQgPSBwb3Muam9pbihcIiBcIik7XG4gIGlmICghdGV4dC50cmltKCkpIGRpZShcInNheTogdGhlIG1lc3NhZ2UgaXMgZW1wdHlcIiwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHRleHQudHJpbSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2U6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0+KHtcbiAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgIH0sXG4gICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgaWYgKGV2ZXJSZXNvbHZlZCkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgfSxcbiAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICBzaW5jZSxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAvLyBBIGRpZmZlcmVudCBlcG9jaCBvbiByZWNvbm5lY3QgPSB0aGUgZGFlbW9uIHJlc3RhcnRlZDsgaWRzIGJlZ2FuIGFnYWluLlxuICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICBvbkNvbW1lbnQ6ICgpID0+IFwiOiBzY3JpcHRvcml1bS1rZWVwYWxpdmVcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8vIOKUgOKUgCBUSEUgQ09NTUFORCBUQUJMRSDigJQgZGlzcGF0Y2gsIGhlbHAsIGBzY2hlbWFgIGFuZCBldmVyeSBgY2hvaWNlc2Agd2FsayBpdCDilIDilIBcblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xudHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG50eXBlIENvbW1hbmRTcGVjID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGZsYWdzOiByZWFkb25seSBGbGFnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICBkZXNjcmliZTogc3RyaW5nO1xuICBydW46IChcbiAgICBwb3M6IHN0cmluZ1tdLFxuICAgIGZsYWdzOiBGbGFncyxcbiAgICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICkgPT4gUHJvbWlzZTxudW1iZXI+IHwgUHJvbWlzZTx2b2lkPiB8IHZvaWQ7XG59O1xuXG5jb25zdCBTRVNTSU9OID0gW1wic2Vzc2lvblwiXSBhcyBjb25zdCBzYXRpc2ZpZXMgcmVhZG9ubHkgRmxhZ1tdO1xuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJuby1vcGVuXCIsIFwicmVzdG9yZVwiLCBcInRpbWVvdXRcIiwgXCJzdGFydC10aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKSwgYWRkaW5nIHBhdGhzOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH1cIixcbiAgICBydW46IChwb3MsIGZsYWdzKSA9PiBjbWRPcGVuKHBvcywgZmxhZ3MpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhZGRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJhZGQgZmlsZXMgb3IgZm9sZGVycyB0byB0aGUgY29udGV4dCBsaXN0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZEFkZChwb3MsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmdWxsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJ0aGUgc2Vzc2lvbjogY29udGV4dCwgZG9jcyArIHZlcnNpb25zICh3aXRoIHBhdGhzKSwgYWN0aXZlLCBkaXJ0eSwgc2VsZWN0aW9uXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInNpbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwidGhlIGh1bWFuJ3MgbWVzc2FnZXMgKHdpdGggc2VsZWN0aW9uICsgYWN0aXZlIHBhdGgpIGFzIEpTT04gbGluZXMg4oCUIHdyYXAgd2l0aCBNb25pdG9yXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBjbWRUYWlsKHNlc3Npb24sIHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlU2luY2UoZmxhZ3Muc2luY2UpIDogLTEpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLW5ld1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJmcm9tXCIsIFwibGFiZWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImNvcHkgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgdG8gYSBuZXcgZmlsZTsgcHJpbnRzIGl0cyBwYXRoIHRvIGVkaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHR5cGVvZiBmbGFncy5mcm9tID09PSBcInN0cmluZ1wiID8gcGFyc2VWZXJzaW9uKGZsYWdzLmZyb20sIFwiLS1mcm9tXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24ubmV3XCIsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgICAuLi4oZnJvbSAhPT0gdW5kZWZpbmVkID8geyBmcm9tIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIiA/IHsgbGFiZWw6IGZsYWdzLmxhYmVsIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJlbWl0IHRoaXMgQ0xJJ3MgYWNjIGRlY2xhcmF0aW9uICh3YWxrZWQgZnJvbSB0aGUgY29tbWFuZCB0YWJsZSlcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2hvdyB0aGlzIG1lc3NhZ2VcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuXTtcblxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG5jb25zdCBmaW5kQ29tbWFuZCA9ICh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQgPT5cbiAgQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbik7XG5cbi8qKiBUaGUgdmVyYiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCAoYSBzdHJpbmcgZmxhZyBjb25zdW1lcyBpdHMgdmFsdWUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmJUb2tlbihhcmd2OiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIGFyZ3ZbaSArIDFdID8/IG51bGw7XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYS5zbGljZSgyKSBhcyBGbGFnO1xuICAgICAgaWYgKGtleSBpbiBDTElfT1BUSU9OUyAmJiBDTElfT1BUSU9OU1trZXldLnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBDT01NQU5EUy5tYXAoKGMpID0+IGMubmFtZSk7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBGbGFnW10+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBDT01NQU5EUy5tYXAoKGMpID0+IFtjLm5hbWUsIGMuZmxhZ3NdKSxcbik7XG5leHBvcnQgY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgWy4uLihmaW5kQ29tbWFuZCh2ZXJiKT8uZmxhZ3MgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbmNvbnN0IHJlbmRlckZsYWcgPSAoazogRmxhZyk6IHN0cmluZyA9PlxuICBDTElfT1BUSU9OU1trXS50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZU9mKHNwZWM6IENvbW1hbmRTcGVjKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBzcGVjLm5hbWUsXG4gICAgLi4uc3BlYy5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgLi4uc3BlYy5mbGFncy5maWx0ZXIoKGspID0+IGsgIT09IFwic2Vzc2lvblwiKS5tYXAocmVuZGVyRmxhZyksXG4gIF0uam9pbihcIiBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWxwKCk6IHN0cmluZyB7XG4gIGNvbnN0IHJvd3MgPSBDT01NQU5EUy5tYXAoKGMpID0+IFt1c2FnZU9mKGMpLCBjLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ucm93cy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICBjb25zdCBib2R5ID0gcm93c1xuICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYHNjcmlwdG9yaXVtIOKAlCBhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93LlxuXG4gIE91dHB1dDogSlNPTiBvbiBzdGRvdXQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlCBleGNlcHQgdGFpbCAob25lIEpTT04gbGluZVxuICBwZXIgZXZlbnQpIGFuZCBoZWxwIChwcm9zZSkuIEZhaWx1cmVzOiBvbmUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXRcbiAgMiA9IHVzYWdlLCAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdC4gdGFpbCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIHJhdGhlciB0aGFuIGZhaWxpbmcsIGFuZCBlbmRzIDAgd2hlbiBpdHMgc2Vzc2lvbiBjbG9zZXMuYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzOiBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdIGFzIHN0cmluZ1tdLFxuICAgICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgICB9KSksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgICAgLi4uQ09NTUFORFMubWFwKChjKSA9PiAoe1xuICAgICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgICAgYXJnczogWy4uLmMuZmxhZ3NdLm1hcChhcmcpLFxuICAgICAgICBwb3NpdGlvbmFsczogYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pKSxcbiAgICBdLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIC8vIFRoZSBraXQgZG9lcyBub3QgdHJpYWdlOyB0aGlzIGRvZXMuIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICAgIC8vICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzOyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gYXJndlswXSk7XG4gIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkIHx8IGFyZ3ZbMF0gPT09IFwidmVyc2lvblwiKSB7XG4gICAgaWYgKChpbnRlcmNlcHRvcj8ucnVucyA/PyBcInZlcnNpb25cIikgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcmludEpzb24odmVyc2lvbkluZm8oKSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBsZXQgY3VycmVudENvbW1hbmQgPSB2ZXJiVG9rZW4oYXJndik7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3MoYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikgfHwgZS5leHRyYT8uY2hvaWNlcyA9PT0gdW5kZWZpbmVkKSB0aHJvdyBlO1xuICAgIGNvbnN0IHNwZWMgPSBjdXJyZW50Q29tbWFuZCA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGZpbmRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgICBpZiAoc3BlYyAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7IGhpbnQ6IGUuZXh0cmE/LmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7XG4gICAgICBoaW50OiBgbm8gdmVyYiBnaXZlbiDigJQgdmVyYnM6ICR7VkVSQlMuam9pbihcIiBcIil9IChydW46IGNsaS50cyBoZWxwKWAsXG4gICAgICBjaG9pY2VzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSksXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgW3ZlcmIsIC4uLnBvc10gPSBwYXJzZWQucG9zO1xuICBjb25zdCBmbGFncyA9IHBhcnNlZC5mbGFncztcbiAgY3VycmVudENvbW1hbmQgPSB2ZXJiID8/IG51bGw7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcblxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBbLi4uVkVSQlNdIH0pO1xuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQodmVyYik7XG4gIGlmIChzcGVjID09PSB1bmRlZmluZWQpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcblxuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KHNwZWMuZmxhZ3MpO1xuICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKGZsYWdzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFjY2VwdGVkID0gZmxhZ3NGb3Ioc3BlYy5uYW1lKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3NwZWMubmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBzY3JpcHRvcml1bSBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgYWNjZXB0ZWQubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogYWNjZXB0ZWQgfSA6IHsgaGludDogYCR7c3BlYy5uYW1lfSB0YWtlcyBubyBmbGFnc2AgfSxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1c2FnZTogJHt1c2FnZU9mKHNwZWMpfWAsIHsgaGludDogc3BlYy5kZXNjcmliZSB9KTtcblxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuICBjb25zdCBjb2RlID0gYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5jb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKiogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEFuIGVtcHR5IGdyb3VwIGlzIHN0aWxsIGEgcmVhbCBkaXJlY3RvcnksIGJ1dCBhIG1pcnJvciBvZiBhIGRvY3NcbiAgICAgICAgLy8gZm9sZGVyIGlzIG1vcmUgdXNlZnVsIHdpdGhvdXQgdHdlbnR5IGVtcHR5IGFzc2V0IGZvbGRlcnMgaW4gaXQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOztBQWdEQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBVUE7QUFDQTtBQUNBLHNCQUFTOzs7QUN0Q0YsU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBOzs7QUM2QjNDLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBYVosU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8sVUFBVSxFQUFFLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQztBQUFBLFNBRS9DLE9BQU8sV0FBVyxZQUFZLEVBQUUsUUFBUSxNQUFNLE9BQU8sSUFBSSxDQUFDO0FBQUEsSUFDaEU7QUFBQSxJQUNBLE1BQU0sRUFBRSxTQUFTLGVBQWU7QUFBQSxFQUNsQyxDQUFDO0FBQUE7QUFBQTtBQUFBO0FBSUksTUFBTSxpQkFBaUIsTUFBTTtBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBRVQsV0FBVyxDQUFDLE1BQWUsU0FBaUIsT0FBa0I7QUFBQSxJQUM1RCxNQUFNLE9BQU87QUFBQSxJ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LFFBQVEsT0FBTztBQUFBLEVBQ3JCLGtCQUFpQixRQUFRO0FBQUEsRUFDekIsa0JBQWtCLGVBQWM7QUFBQSxFQUVoQyxJQUFJLFNBQVM7QUFBQSxJQUNYLE1BQU0sSUFBSSxXQUFXLGlCQUFpQixFQUFFLE1BQU0sb0JBQW9CLFNBQVMsQ0FBQyxHQUFHLEtBQUssRUFBRSxDQUFDO0FBQUEsRUFDekYsTUFBTSxPQUFPLFlBQVksSUFBSTtBQUFBLEVBQzdCLElBQUksU0FBUztBQUFBLElBQ1gsTUFBTSxJQUFJLFdBQVcsaUJBQWlCLFNBQVM7QUFBQSxNQUM3QyxNQUFNO0FBQUEsTUFDTixTQUFTLENBQUMsR0FBRyxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUFBLEVBRUgsTUFBTSxVQUFVLElBQUksSUFBWSxLQUFLLEtBQUs7QUFBQSxFQUMxQyxNQUFNLFFBQVEsT0FBTyxLQUFLLEtBQUssRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFFBQVEsSUFBSSxDQUFDLENBQUM7QUFBQSxFQUM1RCxJQUFJLFVBQVUsV0FBVztBQUFBLElBQ3ZCLE1BQU0sV0FBVyxTQUFTLEtBQUssSUFBSTtBQUFBLElBQ25DLE1BQU0sSUFBSSxXQUNSLEtBQUssOEJBQThCLEtBQUssc0VBQ3hDLFNBQVMsU0FBUyxJQUFJLEVBQUUsU0FBUyxTQUFTLElBQUksRUFBRSxNQUFNLEdBQUcsS0FBSyxzQkFBc0IsQ0FDdEY7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLFdBQVcsS0FBSyxZQUFZLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFO0FBQUEsRUFDNUQsTUFBTSxXQUFXLEtBQUssWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFBQSxFQUN4RCxJQUFJLElBQUksU0FBUyxZQUFhLENBQUMsWUFBWSxJQUFJLFNBQVMsS0FBSyxZQUFZO0FBQUEsSUFDdkUsTUFBTSxJQUFJLFdBQVcsVUFBVSxRQUFRLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxFQUV6RSxNQUFNLFVBQVUsT0FBTyxNQUFNLFlBQVksV0FBVyxNQUFNLFVBQVU7QUFBQSxFQUNwRSxNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksS0FBSyxPQUFPLE9BQU87QUFBQSxFQUMvQyxPQUFPLE9BQU8sU0FBUyxXQUFXLE9BQU87QUFBQTtBQVEzQyxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJBMzVENDM5MkU2MzIxN0I5NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
