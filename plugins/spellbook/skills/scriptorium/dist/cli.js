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
  let ending = "stopped";
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
        if (verdict === "stop") {
          ending = "unresolved";
          return code;
        }
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
            const isTerminal = opts.terminal?.(ev, frame, accepted) ?? false;
            if (accepted || isTerminal && opts.terminalEmitsFiltered === true) {
              const line = opts.render ? opts.render(ev, frame) : frame.data;
              if (line !== null)
                emit(line);
            }
            if (isTerminal) {
              controller.abort();
              ending = "terminal";
              return code;
            }
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
    opts.onEnd?.({ cursor, reason: ending });
  }
}

// src/kit/wire/tailHandoff.ts
var MONITOR_CAP_MS = 1800000;
var WINDOW_MARGIN_MS = 60000;
var DEFAULT_WINDOW_MS = MONITOR_CAP_MS - WINDOW_MARGIN_MS;
var WINDOW_ENV = "SPELLBOOK_TAIL_WINDOW_MS";
var LOST_AFTER_REFUSALS = 3;
function resolveWindowMs(raw) {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WINDOW_MS;
}
function handoff(s, cmd) {
  const base = { events: s.events, cursor: s.cursor };
  switch (s.end) {
    case "stopped":
      return null;
    case "closed":
      return {
        type: "tail.closed",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: "the session closed; there is nothing left to watch. To bring it back, run command"
      };
    case "lost":
      return {
        type: "tail.lost",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: "lost the daemon (it crashed or was killed); nothing is listening. To come back, run command"
      };
    case "event":
      return {
        type: "tail.woke",
        ...base,
        next: "monitor",
        command: cmd.tail({ since: s.cursor, once: false }),
        hint: "handle the event above, then arm Monitor (timeout_ms 1800000) with command"
      };
    case "window":
      if (s.presence || s.events > 0)
        return {
          type: "tail.window",
          ...base,
          next: "monitor",
          command: cmd.tail({ since: s.cursor, once: false }),
          hint: "the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) with command"
        };
      return {
        type: "tail.quiet",
        ...base,
        next: "background",
        command: cmd.tail({ since: s.cursor, once: true }),
        hint: "nothing on the log this window; run command as a background Bash task (run_in_background) \u2014 it exits on the next event"
      };
  }
}
function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
function commandLine(argv) {
  return argv.map(shellQuote).join(" ");
}
function selfCommand() {
  return ["bun", process.argv[1] ?? "cli.ts"];
}
function tailCommand(prefix, since, once) {
  const at = since < 0 ? [`--since=${since}`] : ["--since", String(since)];
  return commandLine([...prefix, ...at, ...once ? ["--once"] : []]);
}
async function tailWithHandoff(tail, h) {
  const out = tail.out ?? process.stdout;
  const windowMs = h.windowMs ?? resolveWindowMs(process.env[WINDOW_ENV]);
  const counts = h.counts ?? (() => true);
  const endOnLost = !h.presence;
  const ac = new AbortController;
  const onCallerAbort = () => ac.abort();
  tail.signal?.addEventListener("abort", onCallerAbort);
  if (tail.signal?.aborted)
    ac.abort();
  let events = 0;
  let cursor = tail.since;
  let end = null;
  let refusals = 0;
  const finish = (e) => {
    if (end === null)
      end = e;
    ac.abort();
  };
  const timer = h.mode === "watch" && windowMs > 0 ? setTimeout(() => finish("window"), windowMs) : null;
  try {
    const code = await tailEvents({
      ...tail,
      signal: ac.signal,
      onUnresolved: (s) => {
        const verdict = tail.onUnresolved?.(s) ?? "retry";
        if (verdict === "stop" && s.everResolved && end === null)
          end = "closed";
        return verdict;
      },
      render: (ev, frame) => {
        refusals = 0;
        const line2 = tail.render ? tail.render(ev, frame) : frame.data;
        if (line2 !== null && counts(ev, frame))
          events += 1;
        return line2;
      },
      terminal: (ev, frame, accepted) => {
        if (tail.terminal?.(ev, frame, accepted)) {
          if (end === null)
            end = (h.isClosed ?? (() => true))(ev) ? "closed" : "event";
          return true;
        }
        if (h.mode === "once" && accepted && counts(ev, frame)) {
          if (end === null)
            end = "event";
          return true;
        }
        return false;
      },
      onComment: (text) => {
        refusals = 0;
        return tail.onComment?.(text) ?? null;
      },
      onDisconnect: (info) => {
        const line2 = tail.onDisconnect?.(info) ?? null;
        if (info.cause === "connect-failed") {
          refusals += 1;
          if (endOnLost && refusals >= LOST_AFTER_REFUSALS)
            finish("lost");
        } else {
          refusals = 0;
        }
        return line2;
      },
      onEnd: (s) => {
        cursor = s.cursor;
        tail.onEnd?.(s);
      }
    });
    const line = handoff({ end: end ?? "stopped", mode: h.mode, events, cursor, presence: h.presence }, h.commands);
    if (line !== null)
      out.write(`${JSON.stringify(line)}
`);
    return code;
  } finally {
    if (timer !== null)
      clearTimeout(timer);
    tail.signal?.removeEventListener("abort", onCallerAbort);
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
  const hint = typeof body.hint === "string" ? body.hint : undefined;
  die(typeof body.error === "string" ? body.error : `${what} failed (HTTP ${status})`, kind, {
    ...hint ? { hint } : {},
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
function restorable() {
  const dir = join(scriptoriumHome(), "sessions");
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "manifest.json"))).map((e) => ({ id: e.name, at: statSync(join(dir, e.name, "manifest.json")).mtimeMs })).sort((a, b) => b.at - a.at).map((e) => e.id);
  } catch {
    return [];
  }
}
function noSessionHint() {
  const ids = restorable();
  const newest = ids[0];
  if (newest === undefined)
    return { hint: "no session has been opened in this home yet \u2014 run: cli.ts open <path>" };
  return {
    hint: `no daemon is running, but the work is on disk \u2014 bring it back with: cli.ts open --restore ${newest}`,
    choices: ids.slice(0, 10)
  };
}
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
    die("no running scriptorium session", "not_found", noSessionHint());
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
  for: { type: "string" },
  from: { type: "string" },
  full: { type: "boolean" },
  quote: { type: "string" },
  reopen: { type: "boolean" },
  hunks: { type: "string" },
  into: { type: "string" },
  lifecycle: { type: "string" },
  limit: { type: "string" },
  label: { type: "string" },
  "no-open": { type: "boolean" },
  once: { type: "boolean" },
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
  if (t === "original" || t === "file" || t === "saved")
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
var disconnected = false;
async function cmdTail(session, since, o) {
  let boundId = session;
  let grounded = o.sinceGiven;
  const pin = () => boundId !== undefined ? ["--session", boundId] : [];
  return await tailWithHandoff({
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
    onComment: () => {
      if (!disconnected)
        return ": scriptorium-keepalive";
      disconnected = false;
      return JSON.stringify({ type: "tail.reconnected" });
    },
    onDisconnect: ({ cause, status }) => {
      if (disconnected)
        return null;
      disconnected = true;
      return JSON.stringify({
        type: "tail.disconnected",
        cause,
        ...status !== undefined ? { status } : {},
        note: "retrying; the session may have closed or crashed"
      });
    }
  }, {
    mode: o.once ? "once" : "watch",
    presence: false,
    commands: {
      tail: ({ since: at, once }) => tailCommand([...selfCommand(), "tail", ...pin()], at, once),
      comeBack: () => commandLine([...selfCommand(), "open", "--restore", boundId ?? "<id>"])
    }
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
    describe: "spawn a session (opens the browser), adding paths; prints {url, port, session_id}. --timeout <seconds> sets the idle close (default 1800); --timeout 0 stands until closed",
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
    flags: [...SESSION, "since", "once"],
    positionals: [],
    describe: "the human's messages (with selection + active path) as JSON lines \u2014 wrap with Monitor; its last line names the next act",
    run: (_pos, flags, session) => cmdTail(session, typeof flags.since === "string" ? parseSince(flags.since) : -1, {
      once: flags.once === true,
      sinceGiven: typeof flags.since === "string"
    })
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
    name: "task",
    flags: [...SESSION, "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "say you have started something; prints the id to finish it with",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, { type: "task.start", text: await readSayBody(pos, flags) }));
    }
  },
  {
    name: "task-status",
    flags: SESSION,
    positionals: [
      { name: "id", required: true },
      { name: "status", required: true, variadic: true }
    ],
    describe: "say what step a task is on (for work worth watching)",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, {
        type: "task.status",
        id: pos[0],
        status: pos.slice(1).join(" ")
      }));
    }
  },
  {
    name: "task-done",
    flags: SESSION,
    positionals: [
      { name: "id", required: true },
      { name: "outcome", required: false, variadic: true }
    ],
    describe: "mark a task finished, optionally saying what came of it",
    run: async (pos, _flags, session) => {
      const outcome = pos.slice(1).join(" ").trim();
      printJson(await postCmd(session, {
        type: "task.done",
        id: pos[0],
        ...outcome ? { outcome } : {}
      }));
    }
  },
  {
    name: "task-remove",
    flags: SESSION,
    positionals: [{ name: "id", required: true }],
    describe: "forget a task entirely \u2014 for one started by mistake",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, { type: "task.remove", id: pos[0] }));
    }
  },
  {
    name: "tasks-clear",
    flags: SESSION,
    positionals: [],
    describe: "forget every finished task; outstanding ones are left alone",
    run: async (_pos, _flags, session) => {
      printJson(await postCmd(session, { type: "tasks.clear" }));
    }
  },
  {
    name: "working",
    flags: [...SESSION, "for"],
    positionals: [],
    describe: "say you are still on it \u2014 silences the waiting nudge, keeps the human's pulse",
    run: async (_pos, flags, session) => {
      const seconds = typeof flags.for === "string" ? parseCount(flags.for, "working --for") : undefined;
      printJson(await postCmd(session, {
        type: "working",
        ...seconds !== undefined ? { seconds } : {}
      }));
    }
  },
  {
    name: "note",
    flags: [...SESSION, "doc", "quote", "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "note a passage of the active version (--quote 'exact text'; prose: --body-file or --stdin)",
    run: async (pos, flags, session) => {
      if (typeof flags.quote !== "string" || flags.quote.trim() === "")
        die("note: --quote is required \u2014 the exact text the note is about", "usage", {
          hint: "run: cli.ts state --full (the active version's text is on disk; quote from it)"
        });
      printJson(await postCmd(session, {
        type: "note.add",
        quote: flags.quote,
        body: await readSayBody(pos, flags),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "notes",
    flags: [...SESSION, "doc", "full"],
    positionals: [],
    describe: "the notes on a document, placed in the active version (--full includes resolved)",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "notes",
        ...flags.full ? { all: true } : {},
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "note-edit",
    flags: [...SESSION, "doc", "stdin", "body-file"],
    positionals: [
      { name: "id", required: true },
      { name: "text", required: false, variadic: true }
    ],
    describe: "rewrite what a note says (its passage is unchanged)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "note.edit",
        id: pos[0],
        body: await readSayBody(pos.slice(1), flags),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "note-resolve",
    flags: [...SESSION, "doc", "reopen"],
    positionals: [{ name: "id", required: true }],
    describe: "mark a note dealt with (--reopen puts it back)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "note.resolve",
        id: pos[0],
        resolved: !flags.reopen,
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "note-remove",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "id", required: true }],
    describe: "delete a note",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "note.remove",
        id: pos[0],
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "diff",
    flags: [...SESSION, "doc", "context", "patch"],
    positionals: [{ name: "against", required: true }],
    describe: "compare the active version with another (vN or 'saved' for the file on disk); --patch for plain unified text",
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
    name: "search",
    flags: [...SESSION, "limit"],
    positionals: [{ name: "query", required: true, variadic: true }],
    describe: "search the context: fuzzy on names, exact in text \u2014 searches the ACTIVE version of open documents, which grep cannot see",
    run: async (pos, flags, session) => {
      const limit = typeof flags.limit === "string" ? parseCount(flags.limit, "search --limit") : undefined;
      printJson(await postCmd(session, {
        type: "search",
        query: pos.join(" "),
        ...limit !== undefined ? { limit } : {}
      }));
    }
  },
  {
    name: "doctor",
    flags: SESSION,
    positionals: [],
    describe: "what is worth looking at in this session \u2014 each finding names the verb that fixes it",
    run: async (_pos, _flags, session) => {
      printJson(await postCmd(session, { type: "doctor" }));
    }
  },
  {
    name: "forget",
    flags: [...SESSION, "doc"],
    positionals: [],
    describe: "forget a document whose file of record is gone (refused while the file exists \u2014 use hide to take one out of the context)",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "forget",
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "dangling",
    flags: [...SESSION, "entry"],
    positionals: [],
    describe: "links in a set that nothing answers \u2014 file, line, and the target as written",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "dangling",
        ...typeof flags.entry === "string" ? { entry: flags.entry } : {}
      }));
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

//# debugId=90CD82871AADE86B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgb3IgYGRpc3BhdGNoYCwgbm9uZSBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYC4gVGhlXG4gKiBzd2FsbG93aW5nIGNhdGNoZXMgKGBhcGlgJ3Mgbm9uLUpTT04gYm9keSwgYHZlcnNpb25JbmZvYCwgYHBvc3RDbWRgJ3MgY2xvc2VcbiAqIEVDT05OUkVTRVQpIGNvbnRhaW4gbm8gZGllLXJlYWNoYWJsZSBjYWxsLlxuICovXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgY2xvc2VTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG9wZW5TeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQge1xuICBDbGlFcnJvcixcbiAgZGllLFxuICB0eXBlIEVycktpbmQsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9yc1wiO1xuaW1wb3J0IHsgY29tbWFuZExpbmUsIHNlbGZDb21tYW5kLCB0YWlsQ29tbWFuZCwgdGFpbFdpdGhIYW5kb2ZmIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IERPQ19FWFRFTlNJT05TLCBpc0RvY05hbWUgfSBmcm9tIFwiLi90cmVlXCI7XG5cbi8vIOKaoCBERUNMQVJFRCBGSVJTVCwgQUJPVkUgRVZFUlkgT1RIRVIgRlVOQ1RJT04sIE9OIFBVUlBPU0UuIFRoZSBgY2hvaWNlc2Bcbi8vIGNlbnN1cydzIHJhaXNlciBydWxlIChhKSAoYGdyaW1vaXJlL2xpYi9lcnJvci1zaXRlcy50c2ApIG1hdGNoZXNcbi8vIGBmdW5jdGlvbiBOQU1FKGAgbGF6aWx5IHVwIHRvIHRoZSBuZXh0IGApOiBuZXZlcmAgd2l0aGluIDYwMCBjaGFyYWN0ZXJzLCBzb1xuLy8gQU5ZIGZ1bmN0aW9uIGRlY2xhcmVkIHNob3J0bHkgYWJvdmUgdGhpcyBvbmUg4oCUIGBhcGlgLCB0aGVuIGByZXF1aXJlU2Vzc2lvbmAg4oCUXG4vLyB3YXMgcmVhZCBhcyBhIHJhaXNlciBhbmQgaXRzIGNhbGxzIGNvdW50ZWQgYXMgcmFpc2Ugc2l0ZXMgKGZvdW5kIDIwMjYtMDktMTEsXG4vLyByZXBvcnRlZCBpbiB0aGUgc2xpY2UtQSBqb3VybmFsIGFzIGFuIGluc3RydW1lbnQgZGVmZWN0LCBub3QgZml4ZWQgaGVyZSkuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGNvbnN0IGJvZHkgPSAoZGF0YSA/PyB7fSkgYXMgeyBlcnJvcj86IHVua25vd247IGNob2ljZXM/OiB1bmtub3duOyBoaW50PzogdW5rbm93biB9O1xuICBjb25zdCBjaG9pY2VzID0gQXJyYXkuaXNBcnJheShib2R5LmNob2ljZXMpID8gYm9keS5jaG9pY2VzLm1hcChTdHJpbmcpIDogdW5kZWZpbmVkO1xuICAvLyDimqAgVGhlIGRhZW1vbidzIG93biBoaW50LCBmb3J3YXJkZWQuIEEgcmVmdXNhbCB0aGF0IGtub3dzIHdoYXQgdG8gZG8gbmV4dFxuICAvLyB1c2VkIHRvIGRyb3AgdGhhdCBrbm93bGVkZ2Ugb24gdGhlIGZsb29yIGF0IHRoaXMgbGluZS5cbiAgY29uc3QgaGludCA9IHR5cGVvZiBib2R5LmhpbnQgPT09IFwic3RyaW5nXCIgPyBib2R5LmhpbnQgOiB1bmRlZmluZWQ7XG4gIGRpZSh0eXBlb2YgYm9keS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuZXJyb3IgOiBgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBTZXNzaW9ucyB3aG9zZSB3b3JrIGlzIHN0aWxsIG9uIGRpc2ssIG5ld2VzdCBmaXJzdCAoRTU2KS5cbiAqXG4gKiDim5QgQSBERUFEIFNFU1NJT04gSVMgTk9UIEEgTE9TVCBPTkUsIGFuZCB0aGUgQ0xJIHVzZWQgdG8gaW1wbHkgb3RoZXJ3aXNlLiBUaGVcbiAqIG1hbmlmZXN0IGFuZCBldmVyeSB2ZXJzaW9uIGZpbGUgbGl2ZSB1bmRlciB0aGUgaG9tZSwgc28gYSBkYWVtb24gdGhhdCBoYXNcbiAqIGV4aXRlZCDigJQgdGhlIDMwLW1pbnV0ZSBpZGxlIHRpbWVvdXQsIGEgY3Jhc2gsIGEgcmVib290IOKAlCBjb3N0cyB0aGUgVVJMIGFuZFxuICogbm90aGluZyBlbHNlLiBDb2xlIGhpdCBleGFjdGx5IHRoaXMgKFwidGhhdCBsaW5rIGRvZXNuJ3Qgc2VlbSB0byBiZSBsaXZlXG4gKiBhbnltb3JlXCIpIGFuZCB0aGUgb25seSB0aGluZyB0aGUgdG9vbGluZyBzYWlkIHdhcyBcIm5vIHJ1bm5pbmcgc2NyaXB0b3JpdW1cbiAqIHNlc3Npb25cIiwgd2hpY2ggcmVhZHMgbGlrZSB0aGUgd29yayBpcyBnb25lLlxuICovXG5mdW5jdGlvbiByZXN0b3JhYmxlKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoKGUpID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCBlLm5hbWUsIFwibWFuaWZlc3QuanNvblwiKSkpXG4gICAgICAubWFwKChlKSA9PiAoeyBpZDogZS5uYW1lLCBhdDogc3RhdFN5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKS5tdGltZU1zIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYXQgLSBhLmF0KVxuICAgICAgLm1hcCgoZSkgPT4gZS5pZCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogV2hhdCB0byBzYXkgd2hlbiBubyBkYWVtb24gYW5zd2VycyDigJQgaW5jbHVkaW5nIHRoZSB3YXkgYmFjaywgd2hlbiB0aGVyZSBpcyBvbmUuICovXG5mdW5jdGlvbiBub1Nlc3Npb25IaW50KCk6IHsgaGludDogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGlkcyA9IHJlc3RvcmFibGUoKTtcbiAgY29uc3QgbmV3ZXN0ID0gaWRzWzBdO1xuICBpZiAobmV3ZXN0ID09PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHsgaGludDogXCJubyBzZXNzaW9uIGhhcyBiZWVuIG9wZW5lZCBpbiB0aGlzIGhvbWUgeWV0IOKAlCBydW46IGNsaS50cyBvcGVuIDxwYXRoPlwiIH07XG4gIHJldHVybiB7XG4gICAgLy8g4pqgIFRoZSBDT01NQU5ELCB3aXRoIHRoZSBpZCBhbHJlYWR5IGluIGl0LiBBIGhpbnQgdGhhdCBzYXlzIFwieW91IGNhblxuICAgIC8vIHJlc3RvcmUgYSBzZXNzaW9uXCIgbGVhdmVzIHRoZSByZWFkZXIgdG8gZmluZCB0aGUgaWQgYW5kIGd1ZXNzIHRoZSBmbGFnLlxuICAgIGhpbnQ6IGBubyBkYWVtb24gaXMgcnVubmluZywgYnV0IHRoZSB3b3JrIGlzIG9uIGRpc2sg4oCUIGJyaW5nIGl0IGJhY2sgd2l0aDogY2xpLnRzIG9wZW4gLS1yZXN0b3JlICR7bmV3ZXN0fWAsXG4gICAgY2hvaWNlczogaWRzLnNsaWNlKDAsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbih0bXBkaXIoKSwgc2Vzc2lvbiA/IGBzY3JpcHRvcml1bS0ke3Nlc3Npb259Lmpzb25gIDogXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0Ug4oCUIEVOT0VOVCBpcyB0aGUgb25seSBhYnNlbmNlLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb25Qb2ludGVyO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgbm9TZXNzaW9uSGludCgpKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBsZXQgc3RhdHVzOiBudW1iZXI7XG4gIGxldCBkYXRhOiB1bmtub3duO1xuICB0cnkge1xuICAgICh7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYGNsb3NlYCBzdG9wcyB0aGUgc2VydmVyOyBhIFJFU0VUIGlzIGl0cyBzdWNjZXNzLiBBIHJlZnVzZWQgY29ubmVjdGlvblxuICAgIC8vIChhIHN0YWxlIHBvaW50ZXIpIGlzIGEgdHJhbnNwb3J0IGZhaWx1cmUgbGlrZSBhbnkgb3RoZXIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zdCBjb2RlID0gZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyID8gU3RyaW5nKGVyci5jb2RlKSA6IFwiXCI7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSlcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChTdHJpbmcobXNnLnR5cGUpLCBzdGF0dXMsIGRhdGEpO1xuICByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuLy8g4pSA4pSAIHRoZSBwYXJzZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjb250ZXh0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZW50cnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmb3I6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBxdW90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlb3BlbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW5rczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaWZlY3ljbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaW1pdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgb25jZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBwYXRjaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJzdGFydC10aW1lb3V0XCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB0YWc6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdHlwZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUyA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKS5tYXAoKGspID0+IGAtLSR7a31gKTtcblxuZXhwb3J0IGNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBDbGlFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSB7XG4gICAgc3VwZXIoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyB7IGNvZGU/OiBzdHJpbmcgfSkuY29kZTtcbiAgICAvLyBPbmx5IGFuIFVOS05PV04gb3B0aW9uIG5hbWVzIHRoZSBmbGFnIHJvc3RlcjsgdGhlIG90aGVyIHBhcnNlIGZhaWx1cmVzXG4gICAgLy8gbWVhbiBhIHJlY29nbmlzZWQgZmxhZyB3YXMgbWlzdXNlZCwgYW5kIHRoZSByb3N0ZXIgd291bGQgbmFtZSB0aGUgaGFsZlxuICAgIC8vIHRoYXQgd2FzIHJpZ2h0LlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGRldGFpbCwge1xuICAgICAgaGludDogXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCIsXG4gICAgICAuLi4oY29kZSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiID8geyBjaG9pY2VzOiBSRUNPR05JWkVEX0ZMQUdTIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbn1cblxuLyoqXG4gKiBgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQ6IGFuIGludGVnZXIsIC0xIGZvciBcImV2ZXJ5dGhpbmdcIi4gVmVyaWZ5LXBhc3MgZml4XG4gKiA5OiBgLS1zaW5jZSBhYmNgIHBhcnNlZCB0byBOYU4sIHdoaWNoIHRoZSBsb2cgcmVhZHMgYXMgXCJmcm9tIHRoZSBzdGFydFwiLCBzb1xuICogYSB0eXBvIHJlcGxheWVkIHRoZSB3aG9sZSBidWZmZXIgaW50byB0aGUgYWdlbnQncyBwaXBlIGF0IGV4aXQgMC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2luY2UodG9rZW46IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICghL14tP1xcZCskLy50ZXN0KHRva2VuLnRyaW0oKSkpXG4gICAgZGllKFxuICAgICAgYC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYW4gZXZlbnQgaWQg4oCUIGdpdmUgYW4gaW50ZWdlciAodGhlIGlkIG9mIHRoZSBsYXN0IGxpbmUgeW91IHNhdylgLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICk7XG4gIHJldHVybiBOdW1iZXIucGFyc2VJbnQodG9rZW4sIDEwKTtcbn1cblxuLyoqXG4gKiBgZmluZCAtLXNpbmNlYCBpcyBhIERBVEUsIHdoZXJlIGB0YWlsIC0tc2luY2VgIGlzIGFuIGV2ZW50IGlkIOKAlCB0aGUgZmxhZyBpc1xuICogc2hhcmVkLCB0aGUgbWVhbmluZyBpcyB0aGUgdmVyYidzLCBhbmQgcGRvY3Mgc3BlbGxzIHRoaXMgb25lIGAtLXNpbmNlYCB0b28uXG4gKiBBIHR5cG8gbXVzdCBub3Qgc2lsZW50bHkgd2lkZW4gdGhlIHNlYXJjaCwgc28gYSBub24tZGF0ZSBpcyBhIHVzYWdlIGVycm9yLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaW5jZURhdGUodG9rZW46IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCk7XG4gIGlmICghL15cXGR7NH0tXFxkezJ9LVxcZHsyfSQvLnRlc3QodCkgfHwgTnVtYmVyLmlzTmFOKERhdGUucGFyc2UodCkpKVxuICAgIGRpZShgZmluZCAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgZGF0ZSDigJQgd3JpdGUgaXQgYXMgWVlZWS1NTS1ERGAsIFwidXNhZ2VcIik7XG4gIHJldHVybiB0O1xufVxuXG4vKiogYHYyYCBvciBgMmAg4oaSIDIuIEEgdmVyc2lvbiBudW1iZXIgaXMgYW4gb3BlbiBzZXQsIHNvIHRoZSByZWplY3Rpb24gY2FycmllcyBhIGhpbnQsIG5vdCBjaG9pY2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVmVyc2lvbih0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBtID0gL152PyhcXGQrKSQvLmV4ZWModG9rZW4udHJpbSgpKTtcbiAgaWYgKCFtIHx8IE51bWJlcihtWzFdKSA8IDEpXG4gICAgZGllKGAke3doYXR9OiBcIiR7dG9rZW59XCIgaXMgbm90IGEgdmVyc2lvbiDigJQgd3JpdGUgdjEsIHYyLCDigKZgLCBcInVzYWdlXCIsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgc3RhdGUgKGVhY2ggZG9jIGxpc3RzIGl0cyB2ZXJzaW9ucylcIixcbiAgICB9KTtcbiAgcmV0dXJuIE51bWJlcihtWzFdKTtcbn1cblxuLyoqIEEgbm9uLW5lZ2F0aXZlIHdob2xlIG51bWJlciBmcm9tIGEgZmxhZywgcmVmdXNlZCByYXRoZXIgdGhhbiBjb2VyY2VkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ291bnQodG9rZW46IHN0cmluZywgd2hhdDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZCskLy50ZXN0KHQpKSBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB3aG9sZSBudW1iZXJgLCBcInVzYWdlXCIpO1xuICByZXR1cm4gTnVtYmVyKHQpO1xufVxuXG4vKipcbiAqIEEgY29tcGFyaXNvbiBzaWRlOiBhIHZlcnNpb24sIG9yIHRoZSBmaWxlIG9mIHJlY29yZC4gYG9yaWdpbmFsYCBpcyBzcGVsbGVkXG4gKiBvdXQgcmF0aGVyIHRoYW4gb2ZmZXJlZCBhcyBgdjBgIOKAlCBhIHplcm90aCB2ZXJzaW9uIHdvdWxkIHJlYWQgbGlrZSB0aGVcbiAqIGVhcmxpZXN0IG9uZSwgYW5kIHRoZSBvcmlnaW5hbCBpcyBub3QgcGFydCBvZiB0aGUgdmVyc2lvbiBsaW5lIGF0IGFsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2lkZSh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIgfCBcIm9yaWdpbmFsXCIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIC8vIGBzYXZlZGAgaXMgdGhlIHdvcmQgdGhlIFNVUkZBQ0UgdXNlcyBmb3IgdGhpcyBzaWRlIChFNDMpOyBgb3JpZ2luYWxgIGFuZFxuICAvLyBgZmlsZWAga2VlcCB3b3JraW5nIGJlY2F1c2UgdGhleSBhcmUgd2hhdCBlYXJsaWVyIHNlc3Npb25zIGFuZCBub3RlcyBzYXkuXG4gIGlmICh0ID09PSBcIm9yaWdpbmFsXCIgfHwgdCA9PT0gXCJmaWxlXCIgfHwgdCA9PT0gXCJzYXZlZFwiKSByZXR1cm4gXCJvcmlnaW5hbFwiO1xuICByZXR1cm4gcGFyc2VWZXJzaW9uKHRva2VuLCB3aGF0KTtcbn1cblxuLy8g4pSA4pSAIHZlcmJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIOKblCBWRVJJRlktUEFTUyBGSVggNTogZXZlcnkgcGF0aCBpcyBjaGVja2VkIEhFUkUsIGJlZm9yZSBhbnkgZGFlbW9uIGV4aXN0cy5cbiAqIGBvcGVuIGRvYy5tZCBwaWMucG5nYCB1c2VkIHRvIHNwYXduIGEgc2Vzc2lvbiwgdGhlbiBmYWlsIG9uIHRoZSBzZWNvbmQgcGF0aFxuICogaW5zaWRlIGl0IOKAlCBsZWF2aW5nIGEgcnVubmluZyBkYWVtb24gYW5kIGEgbGl2ZSBwb2ludGVyIGJlaGluZCBhIGZhaWxlZFxuICogY29tbWFuZC4gQSBmb2xkZXIgb3IgYSBkb2N1bWVudCBpcyBhY2NlcHRlZDsgYSBtaXNzaW5nIHBhdGggaXMgbm90X2ZvdW5kLCBhXG4gKiBub24tZG9jdW1lbnQgZmlsZSBpcyB1c2FnZSB3aXRoIHRoZSBhY2NlcHRlZCBleHRlbnNpb25zIGFzIGBjaG9pY2VzYC5cbiAqL1xuZnVuY3Rpb24gY29udGV4dFBhdGhzKHBvczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHBhdGhzID0gcG9zLm1hcCgocCkgPT4gcmVzb2x2ZShwKSk7XG4gIGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKHApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgZGllKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke3B9YCwgXCJub3RfZm91bmRcIik7XG4gICAgfVxuICAgIGlmICghc3QuaXNEaXJlY3RvcnkoKSAmJiAhaXNEb2NOYW1lKHApKVxuICAgICAgZGllKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHtwfWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBcImFkZCBhIGZvbGRlciwgb3IgYSBmaWxlIHdpdGggb25lIG9mIHRoZXNlIGV4dGVuc2lvbnNcIixcbiAgICAgICAgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSxcbiAgICAgIH0pO1xuICB9XG4gIHJldHVybiBwYXRocztcbn1cblxuLyoqXG4gKiBgLS1kb2NgIGFzIHRoZSBDTEkncyBjYWxsZXIgbWVhbnQgaXQgKHZlcmlmeS1wYXNzIGZpeCA4KTogYSB0b2tlbiB3aXRoIGEgcGF0aFxuICogc2VwYXJhdG9yLCBvciBvbmUgbmFtaW5nIGEgZmlsZSBpbiBUSElTIHByb2Nlc3MncyBjd2QsIGlzIHJlc29sdmVkIGhlcmUgdG8gYW5cbiAqIGFic29sdXRlIHBhdGgg4oCUIHRoZSBkYWVtb24ncyBjd2QgaXMgbm90IHRoZSBjYWxsZXIncy4gQW55dGhpbmcgZWxzZSAoYSBzbHVnLFxuICogYSB1bmlxdWUgZmlsZSBuYW1lKSBnb2VzIGFzIHR5cGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jQXJnKHRva2VuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodG9rZW4uaW5jbHVkZXMoXCIvXCIpIHx8IGV4aXN0c1N5bmMocmVzb2x2ZSh0b2tlbikpKSByZXR1cm4gcmVzb2x2ZSh0b2tlbik7XG4gIHJldHVybiB0b2tlbjtcbn1cblxuLyoqIEtlZXAgdGhlIG5ld2VzdCBgTE9HX0tFRVAgLSAxYCBkYWVtb24gbG9ncywgc28gdGhlIG9uZSBhYm91dCB0byBiZSB3cml0dGVuIG1ha2VzIGBMT0dfS0VFUGAuICovXG5jb25zdCBMT0dfS0VFUCA9IDEwO1xuZnVuY3Rpb24gcHJ1bmVMb2dzKGxvZ0Rpcjogc3RyaW5nKTogdm9pZCB7XG4gIGxldCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGxvZ0RpcikuZmlsdGVyKChuKSA9PiAvXmRhZW1vbi1cXGQrLVxcZCtcXC5sb2ckLy50ZXN0KG4pKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGJ5QWdlID0gbmFtZXMuc29ydCgoYSwgYikgPT4gTnVtYmVyKGEuc3BsaXQoXCItXCIpWzFdKSAtIE51bWJlcihiLnNwbGl0KFwiLVwiKVsxXSkpO1xuICBmb3IgKGNvbnN0IG4gb2YgYnlBZ2Uuc2xpY2UoMCwgTWF0aC5tYXgoMCwgYnlBZ2UubGVuZ3RoIC0gKExPR19LRUVQIC0gMSkpKSkge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKGpvaW4obG9nRGlyLCBuKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kT3Blbihwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcGF0aHMgPSBjb250ZXh0UGF0aHMocG9zKTtcblxuICBpZiAodHlwZW9mIGZsYWdzLnJlc3RvcmUgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gICAgY29uc3QgbWFuaWZlc3QgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgZmxhZ3MucmVzdG9yZSwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhtYW5pZmVzdCkpIHtcbiAgICAgIGxldCBzYXZlZDogc3RyaW5nW10gPSBbXTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHNhdmVkID0gKFxuICAgICAgICAgIGF3YWl0IEFycmF5LmZyb21Bc3luYyhuZXcgQnVuLkdsb2IoXCIqL21hbmlmZXN0Lmpzb25cIikuc2Nhbihqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpKVxuICAgICAgICApLm1hcCgocCkgPT4gcC5zcGxpdChcIi9cIilbMF0gYXMgc3RyaW5nKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBubyBzZXNzaW9ucyBmb2xkZXI6IHRoZSBzZXQgaXMgZW1wdHksIGFuZCBzYXlzIHNvICovXG4gICAgICB9XG4gICAgICBkaWUoYG5vIHNhdmVkIHNlc3Npb24gXCIke2ZsYWdzLnJlc3RvcmV9XCIgdW5kZXIgJHtob21lfWAsIFwibm90X2ZvdW5kXCIsIHtcbiAgICAgICAgY2hvaWNlczogc2F2ZWQuc29ydCgpLFxuICAgICAgICAuLi4oc2F2ZWQubGVuZ3RoID09PSAwID8geyBoaW50OiBcIm5vIHNhdmVkIHNlc3Npb25zIGluIHRoaXMgaG9tZVwiIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9XG4gICAgY29uc3QgbGl2ZSA9IHJlYWRTZXNzaW9uKGZsYWdzLnJlc3RvcmUpO1xuICAgIGlmIChsaXZlKSB7XG4gICAgICBjb25zdCBhbGl2ZSA9IGF3YWl0IGFwaShsaXZlLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpLnRoZW4oXG4gICAgICAgIChyKSA9PiByLnN0YXR1cyA9PT0gMjAwLFxuICAgICAgICAoKSA9PiBmYWxzZSxcbiAgICAgICk7XG4gICAgICBpZiAoYWxpdmUpXG4gICAgICAgIGRpZShgc2Vzc2lvbiAke2ZsYWdzLnJlc3RvcmV9IGlzIGFscmVhZHkgcnVubmluZyBhdCAke2xpdmUudXJsfWAsIFwiY29uZmxpY3RcIiwge1xuICAgICAgICAgIGhpbnQ6IGB1c2UgaXQ6IGNsaS50cyBzdGF0ZSAtLXNlc3Npb24gJHtmbGFncy5yZXN0b3JlfWAsXG4gICAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGRhZW1vbkFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmICh0eXBlb2YgZmxhZ3MudGltZW91dCA9PT0gXCJzdHJpbmdcIikgZGFlbW9uQXJncy5wdXNoKFwiLS10aW1lb3V0XCIsIGZsYWdzLnRpbWVvdXQpO1xuICBpZiAodHlwZW9mIGZsYWdzLnJlc3RvcmUgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBmbGFncy5yZXN0b3JlKTtcbiAgLy8gRTIzOiBhIG5ldyBzZXNzaW9uJ3Mgd29ya3NwYWNlIGlzIHdoZXJlIGBvcGVuYCByYW4uIEEgcmVzdG9yZWQgb25lIGtlZXBzIGl0cyBvd24uXG4gIGVsc2UgZGFlbW9uQXJncy5wdXNoKFwiLS13b3Jrc3BhY2VcIiwgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfWAsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZGV2IG1vZGUgd2FzIHJlc29sdmVkIChubyBkaXN0L2luZGV4Lmh0bWwgYW5kIG5vIFNQRUxMQk9PS19TVVJGQUNFX01PREU9cmVsZWFzZSksIHdoaWNoIG5lZWRzIHNyYy9zY3JpcHRvcml1bS8g4oCUIHJlaW5zdGFsbCB0aGUgc3BlbGwgb3IgYnVpbGQgaXRcIixcbiAgICAgIH0sXG4gICAgKTtcbiAgLy8gVGhlIGRhZW1vbidzIHN0ZGVyciBnb2VzIHRvIGEgTE9HIEZJTEUsIG5vdCB0byB0aGlzIENMSSdzIHN0ZGVyci4gQW5cbiAgLy8gaW5oZXJpdGVkIHN0ZGVyciBvdXRsaXZlcyB0aGUgQ0xJIGluc2lkZSB0aGUgZGV0YWNoZWQgZGFlbW9uLCBzbyBhbnkgY2FsbGVyXG4gIC8vIHRoYXQgcmVhZHMgYG9wZW5gJ3Mgc3RkZXJyIHRvIEVPRiAoYSB0ZXN0IGhhcm5lc3MsIGEgdG9vbCBydW5uZXIpIHdhaXRzIGZvclxuICAvLyB0aGUgd2hvbGUgc2Vzc2lvbiDigJQgbWVhc3VyZWQ6IHRoZSBpbnRlZ3JhdGlvbiBjZWxsIGh1bmcgYXQgaXRzIDYwIHMgdGltZW91dC5cbiAgLy8gQSBmaWxlIGhvbGRzIG5vIHBpcGUsIGFuZCBhIHN0YXJ0IGZhaWx1cmUgYmVsb3cgcXVvdGVzIGl0cyB0YWlsLlxuICBjb25zdCBsb2dEaXIgPSBqb2luKHNjcmlwdG9yaXVtSG9tZSgpLCBcImxvZ3NcIik7XG4gIG1rZGlyU3luYyhsb2dEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogdGhlIGxvZ3MgdXNlZCB0byBwaWxlIHVwLCBvbmUgcGVyIGBvcGVuYCwgZm9yZXZlci5cbiAgcHJ1bmVMb2dzKGxvZ0Rpcik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKGxvZ0RpciwgYGRhZW1vbi0ke0RhdGUubm93KCl9LSR7cHJvY2Vzcy5waWR9LmxvZ2ApO1xuICBkYWVtb25BcmdzLnB1c2goXCItLWxvZ1wiLCBsb2dQYXRoKTtcbiAgY29uc3QgbG9nRmQgPSBvcGVuU3luYyhsb2dQYXRoLCBcImFcIik7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJidW5cIiwgZGFlbW9uQXJncywge1xuICAgIGN3ZCxcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBsb2dGZF0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgfSk7XG4gIGNsb3NlU3luYyhsb2dGZCk7XG4gIGNoaWxkLnVucmVmKCk7XG5cbiAgY29uc3Qgc3RhcnRUaW1lb3V0TXMgPVxuICAgIHR5cGVvZiBmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0gPT09IFwic3RyaW5nXCJcbiAgICAgID8gTWF0aC5tYXgoNTAwMCwgTnVtYmVyLnBhcnNlSW50KGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSwgMTApICogMTAwMClcbiAgICAgIDogNDUwMDA7XG4gIGNvbnN0IGxpbmUgPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXMsIHJlaikgPT4ge1xuICAgIGxldCBidWYgPSBcIlwiO1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChcbiAgICAgICgpID0+XG4gICAgICAgIHJlaihcbiAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgZGFlbW9uIHN0YXJ0IHRpbWVvdXQgKCR7c3RhcnRUaW1lb3V0TXMgLyAxMDAwfXMpIOKAlCBwYXNzIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz5gLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICBzdGFydFRpbWVvdXRNcyxcbiAgICApO1xuICAgIGNoaWxkLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICBidWYgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IG5sID0gYnVmLmluZGV4T2YoXCJcXG5cIik7XG4gICAgICBpZiAobmwgPj0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICByZXMoYnVmLnNsaWNlKDAsIG5sKS50cmltKCkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihlcnIpO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihuZXcgRXJyb3IoYGRhZW1vbiBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0gYmVmb3JlIGl0cyBoYW5kc2hha2VgKSk7XG4gICAgfSk7XG4gIH0pLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICBsZXQgdGFpbCA9IFwiXCI7XG4gICAgdHJ5IHtcbiAgICAgIHRhaWwgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGY4XCIpLnRyaW0oKS5zbGljZSgtODAwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIGxvZyB3cml0dGVuICovXG4gICAgfVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAgeyBoaW50OiB0YWlsID8gYGRhZW1vbiBsb2cgKCR7bG9nUGF0aH0pOiAke3RhaWx9YCA6IGBkYWVtb24gbG9nOiAke2xvZ1BhdGh9YCB9LFxuICAgICk7XG4gIH0pO1xuXG4gIC8vIFJlbGVhc2UgdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlLCBvciB0aGlzIENMSSdzIG5hdHVyYWwgcmV0dXJuIHdhaXRzIG9uIGFcbiAgLy8gc3RyZWFtIHRoYXQgbmV2ZXIgY2xvc2VzIChnbGFtb3VyIG1lYXN1cmVkIDkxIHMg4oaSIDEgcykuIENoZWNrZWQgZm9yIHRoZVxuICAvLyBNRVRIT0Q6IHVuZGVyIEJ1biB0aGlzIHBpcGUgaXMgYSBwbGFpbiBSZWFkYWJsZSB0aGF0IG5vbmV0aGVsZXNzIGhhcyB1bnJlZi5cbiAgY29uc3Qgb3V0ID0gY2hpbGQuc3Rkb3V0O1xuICBpZiAoIW91dCB8fCAhKFwidW5yZWZcIiBpbiBvdXQpIHx8IHR5cGVvZiBvdXQudW5yZWYgIT09IFwiZnVuY3Rpb25cIilcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInNjcmlwdG9yaXVtOiB0aGUgZGFlbW9uJ3Mgc3Rkb3V0IHBpcGUgaGFzIG5vIHVucmVmKCk7IGBvcGVuYCB3b3VsZCBuZXZlciBleGl0XCIsXG4gICAgKTtcbiAgb3V0LnVucmVmKCk7XG5cbiAgbGV0IGhzOiB7XG4gICAgdXJsOiBzdHJpbmc7XG4gICAgcG9ydDogbnVtYmVyO1xuICAgIHNlc3Npb25faWQ6IHN0cmluZztcbiAgICBvaz86IGJvb2xlYW47XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9O1xuICB0cnkge1xuICAgIGhzID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB1bmV4cGVjdGVkIG91dHB1dCBmcm9tIGRhZW1vbjogJHtsaW5lfWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgaWYgKGhzLm9rID09PSBmYWxzZSkgZGFlbW9uUmVmdXNlZChcIm9wZW5cIiwgaHMuc3RhdHVzID8/IDUwMCwgaHMpO1xuXG4gIGxldCBlbnRyaWVzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCByID0gYXdhaXQgcG9zdENtZChocy5zZXNzaW9uX2lkLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSk7XG4gICAgZW50cmllcyA9IChyLmVudHJpZXMgYXMgdW5rbm93bltdKSA/PyBbXTtcbiAgfVxuICBwcmludEpzb24oeyAuLi5ocywgLi4uKHBhdGhzLmxlbmd0aCA+IDAgPyB7IGVudHJpZXMgfSA6IHt9KSB9KTtcblxuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkge1xuICAgIGNvbnN0IG9wZW5lciA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gICAgc3Bhd24ob3BlbmVyLCBbaHMudXJsXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86IFwiaWdub3JlXCIgfSkudW5yZWYoKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjb250ZXh0LmFkZFwiLCBwYXRocyB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZnVsbDogYm9vbGVhbikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCI/ZnVsbD0xXCIgOiBcIlwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJzdGF0ZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRTYXlCb2R5KFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBzb3VyY2VzID0gW1xuICAgIHBvcy5sZW5ndGggPiAwLFxuICAgIGZsYWdzLnN0ZGluID09PSB0cnVlLFxuICAgIHR5cGVvZiBmbGFnc1tcImJvZHktZmlsZVwiXSA9PT0gXCJzdHJpbmdcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikubGVuZ3RoO1xuICBpZiAoc291cmNlcyAhPT0gMSlcbiAgICBkaWUoXG4gICAgICBzb3VyY2VzID09PSAwXG4gICAgICAgID8gXCJzYXkgbmVlZHMgYSBtZXNzYWdlXCJcbiAgICAgICAgOiBcInNheSB0YWtlcyBpdHMgbWVzc2FnZSBmcm9tIGV4YWN0bHkgb25lIHBsYWNlOiBhcmd1bWVudHMsIC0tc3RkaW4gb3IgLS1ib2R5LWZpbGVcIixcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogXCJnaXZlIHRoZSB0ZXh0IGFzIGFyZ3VtZW50cywgb3IgcHJvc2UgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gLyAtLXN0ZGluIChuZXZlciBhbiB1bnF1b3RlZCBoZXJlZG9jKVwiLFxuICAgICAgICBjaG9pY2VzOiBbXCItLXN0ZGluXCIsIFwiLS1ib2R5LWZpbGVcIl0sXG4gICAgICB9LFxuICAgICk7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIGlmIChmbGFncy5zdGRpbiA9PT0gdHJ1ZSkgdGV4dCA9IGF3YWl0IG5ldyBSZXNwb25zZShCdW4uc3RkaW4uc3RyZWFtKCkpLnRleHQoKTtcbiAgZWxzZSBpZiAodHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiKSB0ZXh0ID0gcmVhZEZpbGVTeW5jKGZsYWdzW1wiYm9keS1maWxlXCJdLCBcInV0ZjhcIik7XG4gIGVsc2UgdGV4dCA9IHBvcy5qb2luKFwiIFwiKTtcbiAgaWYgKCF0ZXh0LnRyaW0oKSkgZGllKFwic2F5OiB0aGUgbWVzc2FnZSBpcyBlbXB0eVwiLCBcInVzYWdlXCIpO1xuICByZXR1cm4gdGV4dC50cmltKCk7XG59XG5cbi8qKlxuICogV2hldGhlciB0aGUgdGFpbCBoYXMgYWxyZWFkeSByZXBvcnRlZCB0aGF0IGl0IGxvc3QgdGhlIGRhZW1vbiAoRTU1KS4gTW9kdWxlXG4gKiBzY29wZSBiZWNhdXNlIGEgdGFpbCBpcyBvbmUgcHJvY2VzcyBkb2luZyBvbmUgdGhpbmcsIGFuZCB0aGUgdHdvIGhvb2tzIHRoYXRcbiAqIHJlYWQgaXQgYXJlIGhhbmRlZCB0byBhIGNsaWVudCB0aGF0IG93bnMgaXRzIG93biBsb29wLlxuICovXG5sZXQgZGlzY29ubmVjdGVkID0gZmFsc2U7XG5cbi8qKlxuICogVGhlIHdhdGNoLiBFbmRzIGl0c2VsZiBiZWZvcmUgTW9uaXRvcidzIGNhcCB3aXRoIG9uZSBsaW5lIG5hbWluZyB0aGUgbmV4dFxuICogYWN0IChgc3JjL2tpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCk6IHJlLWFybSBNb25pdG9yLCBnbyB0byBhIGJhY2tncm91bmRcbiAqIGAtLW9uY2VgLCBvciBjb21lIGJhY2sgZnJvbSBhIGNsb3NlZCBvciBsb3N0IHNlc3Npb24gd2l0aCBgb3BlbiAtLXJlc3RvcmVgLlxuICogQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTogdGhlIGFnZW50IGFscmVhZHkga25vd3MgdGhlXG4gKiBzZXNzaW9uLCBhbmQgdGhlIGxpbmUgd291bGQgY291bnQgYXMgbm9pc2UgaW4gdGhlIHdpbmRvdydzIHdha2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgc2luY2U6IG51bWJlcixcbiAgbzogeyBvbmNlOiBib29sZWFuOyBzaW5jZUdpdmVuOiBib29sZWFuIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGxldCBncm91bmRlZCA9IG8uc2luY2VHaXZlbjtcbiAgY29uc3QgcGluID0gKCkgPT4gKGJvdW5kSWQgIT09IHVuZGVmaW5lZCA/IFtcIi0tc2Vzc2lvblwiLCBib3VuZElkXSA6IFtdKTtcbiAgcmV0dXJuIGF3YWl0IHRhaWxXaXRoSGFuZG9mZjx7IGlkPzogbnVtYmVyOyBlcG9jaD86IHN0cmluZzsgdHlwZT86IHN0cmluZyB9PihcbiAgICB7XG4gICAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgICBpZiAoZXZlclJlc29sdmVkKSByZXR1cm4gXCJzdG9wXCI7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+ICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgPyBldi5pZCA6IHVuZGVmaW5lZCksXG4gICAgICBlcG9jaE9mOiAoZXYpID0+ICh0eXBlb2YgZXYuZXBvY2ggPT09IFwic3RyaW5nXCIgPyBldi5lcG9jaCA6IHVuZGVmaW5lZCksXG4gICAgICAvLyBBIGRpZmZlcmVudCBlcG9jaCBvbiByZWNvbm5lY3QgPSB0aGUgZGFlbW9uIHJlc3RhcnRlZDsgaWRzIGJlZ2FuIGFnYWluLlxuICAgICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICAgIC8vIOKblCBBIEtFRVBBTElWRSBJUyBQUk9PRiBPRiBMSUZFLCBzbyBpdCBpcyBhbHNvIHdoYXQgY2xlYXJzIGEgcmVwb3J0ZWRcbiAgICAgIC8vIGRpc2Nvbm5lY3Rpb24uIFRoZXJlIGlzIG5vIGBvbkNvbm5lY3RgIGhvb2sgYW5kIHRoaXMgaXMgdGhlIGhvbmVzdFxuICAgICAgLy8gc3Vic3RpdHV0ZTogdGhlIGRhZW1vbiBvbmx5IHNlbmRzIGNvbW1lbnRzIGRvd24gYSBsaXZlIHN0cmVhbS5cbiAgICAgIG9uQ29tbWVudDogKCkgPT4ge1xuICAgICAgICBpZiAoIWRpc2Nvbm5lY3RlZCkgcmV0dXJuIFwiOiBzY3JpcHRvcml1bS1rZWVwYWxpdmVcIjtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwidGFpbC5yZWNvbm5lY3RlZFwiIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIOKblCBPTkUgTElORSBQRVIgRVBJU09ERSwgTk9UIFBFUiBBVFRFTVBULiBUaGUgY2xpZW50IHJlY29ubmVjdHMgd2l0aFxuICAgICAgLy8gYmFja29mZiBmb3JldmVyLCBzbyBhIGhvb2sgdGhhdCBzcG9rZSBldmVyeSB0aW1lIHdvdWxkIGVtaXQgYSBsaW5lIGV2ZXJ5XG4gICAgICAvLyBmZXcgc2Vjb25kcyBmb3IgYXMgbG9uZyBhcyB0aGUgZGFlbW9uIHN0YXllZCBkb3duIOKAlCB3aGljaCBpcyBob3cgYVxuICAgICAgLy8gd2F0Y2hlciBnZXRzIG11dGVkLCBhbmQgdGhlbiBub2JvZHkgaGVhcnMgdGhlIG5leHQgcmVhbCB0aGluZy5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgV0hZIFRISVMgRVhJU1RTIEFUIEFMTDogd2l0aG91dCBpdCBhIERFQUQgZGFlbW9uIGFuZCBhIFFVSUVUIG9uZSBhcmVcbiAgICAgIC8vIHRoZSBzYW1lIHRoaW5nIGZyb20gb3V0IGhlcmUuIEEgZ3JhY2VmdWwgY2xvc2UgZW1pdHMgYGNsb3NlZGAgYW5kIGVuZHNcbiAgICAgIC8vIHRoZSB0YWlsOyBhIGNyYXNoLCBhIGtpbGwgLTkgb3IgYSBzbGVlcGluZyBsYXB0b3AgZW1pdHMgbm90aGluZywgdGhlXG4gICAgICAvLyBjbGllbnQgcmV0cmllcyBpbiBzaWxlbmNlLCBhbmQgdGhlIGFic2VuY2Ugb2YgZXZlbnRzIGlzIG5vdCBhbiBldmVudC4gQVxuICAgICAgLy8gd2F0Y2hlciB3YWl0aW5nIGZvciB0aGUgaHVtYW4ncyBuZXh0IG1lc3NhZ2Ugd291bGQgd2FpdCBmb3JldmVyIGFuZFxuICAgICAgLy8gbmV2ZXIgbGVhcm4gaXQgaGFkIHN0b3BwZWQgbGlzdGVuaW5nLiAoRm91bmQgMjAyNi0wOS0xNCB3aGlsZSBhbnN3ZXJpbmdcbiAgICAgIC8vIENvbGUncyBxdWVzdGlvbiBhYm91dCB3aGV0aGVyIGEgdGltZW91dCB3b3VsZCBub3RpZnkgbWUuIEl0IHdvdWxkIG5vdC4pXG4gICAgICBvbkRpc2Nvbm5lY3Q6ICh7IGNhdXNlLCBzdGF0dXMgfSkgPT4ge1xuICAgICAgICBpZiAoZGlzY29ubmVjdGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwuZGlzY29ubmVjdGVkXCIsXG4gICAgICAgICAgY2F1c2UsXG4gICAgICAgICAgLi4uKHN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBzdGF0dXMgfSA6IHt9KSxcbiAgICAgICAgICBub3RlOiBcInJldHJ5aW5nOyB0aGUgc2Vzc2lvbiBtYXkgaGF2ZSBjbG9zZWQgb3IgY3Jhc2hlZFwiLFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBtb2RlOiBvLm9uY2UgPyBcIm9uY2VcIiA6IFwid2F0Y2hcIixcbiAgICAgIHByZXNlbmNlOiBmYWxzZSxcbiAgICAgIGNvbW1hbmRzOiB7XG4gICAgICAgIHRhaWw6ICh7IHNpbmNlOiBhdCwgb25jZSB9KSA9PiB0YWlsQ29tbWFuZChbLi4uc2VsZkNvbW1hbmQoKSwgXCJ0YWlsXCIsIC4uLnBpbigpXSwgYXQsIG9uY2UpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoWy4uLnNlbGZDb21tYW5kKCksIFwib3BlblwiLCBcIi0tcmVzdG9yZVwiLCBib3VuZElkID8/IFwiPGlkPlwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuXG50eXBlIEZsYWcgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgZmxhZ3M6IHJlYWRvbmx5IEZsYWdbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIHJ1bjogKFxuICAgIHBvczogc3RyaW5nW10sXG4gICAgZmxhZ3M6IEZsYWdzLFxuICAgIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgKSA9PiBQcm9taXNlPG51bWJlcj4gfCBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcbn07XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IENPTU1BTkRTOiBDb21tYW5kU3BlY1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKSwgYWRkaW5nIHBhdGhzOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH0uIC0tdGltZW91dCA8c2Vjb25kcz4gc2V0cyB0aGUgaWRsZSBjbG9zZSAoZGVmYXVsdCAxODAwKTsgLS10aW1lb3V0IDAgc3RhbmRzIHVudGlsIGNsb3NlZFwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIiwgXCJvbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwidGhlIGh1bWFuJ3MgbWVzc2FnZXMgKHdpdGggc2VsZWN0aW9uICsgYWN0aXZlIHBhdGgpIGFzIEpTT04gbGluZXMg4oCUIHdyYXAgd2l0aCBNb25pdG9yOyBpdHMgbGFzdCBsaW5lIG5hbWVzIHRoZSBuZXh0IGFjdFwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgY21kVGFpbChzZXNzaW9uLCB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBwYXJzZVNpbmNlKGZsYWdzLnNpbmNlKSA6IC0xLCB7XG4gICAgICAgIG9uY2U6IGZsYWdzLm9uY2UgPT09IHRydWUsXG4gICAgICAgIHNpbmNlR2l2ZW46IHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIixcbiAgICAgIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLW5ld1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJmcm9tXCIsIFwibGFiZWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImNvcHkgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgdG8gYSBuZXcgZmlsZTsgcHJpbnRzIGl0cyBwYXRoIHRvIGVkaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHR5cGVvZiBmbGFncy5mcm9tID09PSBcInN0cmluZ1wiID8gcGFyc2VWZXJzaW9uKGZsYWdzLmZyb20sIFwiLS1mcm9tXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24ubmV3XCIsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgICAuLi4oZnJvbSAhPT0gdW5kZWZpbmVkID8geyBmcm9tIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIiA/IHsgbGFiZWw6IGZsYWdzLmxhYmVsIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLWRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgdmVyc2lvbiBhbmQgaXRzIGZpbGUgKG5ldmVyIHRoZSBhY3RpdmUgb25lIOKAlCBhY3RpdmF0ZSBhbm90aGVyIGZpcnN0KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJ2ZXJzaW9uLWRlbGV0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBoYXZlIHN0YXJ0ZWQgc29tZXRoaW5nOyBwcmludHMgdGhlIGlkIHRvIGZpbmlzaCBpdCB3aXRoXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnN0YXJ0XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXN0YXR1c1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJzdGF0dXNcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzYXkgd2hhdCBzdGVwIGEgdGFzayBpcyBvbiAoZm9yIHdvcmsgd29ydGggd2F0Y2hpbmcpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ0YXNrLnN0YXR1c1wiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHN0YXR1czogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1kb25lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcIm91dGNvbWVcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibWFyayBhIHRhc2sgZmluaXNoZWQsIG9wdGlvbmFsbHkgc2F5aW5nIHdoYXQgY2FtZSBvZiBpdFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBvdXRjb21lID0gcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICAuLi4ob3V0Y29tZSA/IHsgb3V0Y29tZSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1yZW1vdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJmb3JnZXQgYSB0YXNrIGVudGlyZWx5IOKAlCBmb3Igb25lIHN0YXJ0ZWQgYnkgbWlzdGFrZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5yZW1vdmVcIiwgaWQ6IHBvc1swXSBhcyBzdHJpbmcgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2tzLWNsZWFyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBldmVyeSBmaW5pc2hlZCB0YXNrOyBvdXRzdGFuZGluZyBvbmVzIGFyZSBsZWZ0IGFsb25lXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFza3MuY2xlYXJcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid29ya2luZ1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmb3JcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInNheSB5b3UgYXJlIHN0aWxsIG9uIGl0IOKAlCBzaWxlbmNlcyB0aGUgd2FpdGluZyBudWRnZSwga2VlcHMgdGhlIGh1bWFuJ3MgcHVsc2VcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3Qgc2Vjb25kcyA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5mb3IgPT09IFwic3RyaW5nXCIgPyBwYXJzZUNvdW50KGZsYWdzLmZvciwgXCJ3b3JraW5nIC0tZm9yXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIndvcmtpbmdcIixcbiAgICAgICAgICAuLi4oc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8geyBzZWNvbmRzIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInF1b3RlXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJub3RlIGEgcGFzc2FnZSBvZiB0aGUgYWN0aXZlIHZlcnNpb24gKC0tcXVvdGUgJ2V4YWN0IHRleHQnOyBwcm9zZTogLS1ib2R5LWZpbGUgb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLnF1b3RlICE9PSBcInN0cmluZ1wiIHx8IGZsYWdzLnF1b3RlLnRyaW0oKSA9PT0gXCJcIilcbiAgICAgICAgZGllKFwibm90ZTogLS1xdW90ZSBpcyByZXF1aXJlZCDigJQgdGhlIGV4YWN0IHRleHQgdGhlIG5vdGUgaXMgYWJvdXRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAtLWZ1bGwgKHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgaXMgb24gZGlzazsgcXVvdGUgZnJvbSBpdClcIixcbiAgICAgICAgfSk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibm90ZS5hZGRcIixcbiAgICAgICAgICBxdW90ZTogZmxhZ3MucXVvdGUsXG4gICAgICAgICAgYm9keTogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBub3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLWZ1bGwgaW5jbHVkZXMgcmVzb2x2ZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3Rlc1wiLFxuICAgICAgICAgIC4uLihmbGFncy5mdWxsID8geyBhbGw6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1lZGl0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInJld3JpdGUgd2hhdCBhIG5vdGUgc2F5cyAoaXRzIHBhc3NhZ2UgaXMgdW5jaGFuZ2VkKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmVkaXRcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3Muc2xpY2UoMSksIGZsYWdzKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1yZXNvbHZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInJlb3BlblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgbm90ZSBkZWFsdCB3aXRoICgtLXJlb3BlbiBwdXRzIGl0IGJhY2spXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVzb2x2ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHJlc29sdmVkOiAhZmxhZ3MucmVvcGVuLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgbm90ZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLnJlbW92ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdzYXZlZCcgZm9yIHRoZSBmaWxlIG9uIGRpc2spOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VhcmNoXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImxpbWl0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInF1ZXJ5XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic2VhcmNoIHRoZSBjb250ZXh0OiBmdXp6eSBvbiBuYW1lcywgZXhhY3QgaW4gdGV4dCDigJQgc2VhcmNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uIG9mIG9wZW4gZG9jdW1lbnRzLCB3aGljaCBncmVwIGNhbm5vdCBzZWVcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5saW1pdCA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MubGltaXQsIFwic2VhcmNoIC0tbGltaXRcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICAgICAgcXVlcnk6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgICAgICAuLi4obGltaXQgIT09IHVuZGVmaW5lZCA/IHsgbGltaXQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwid2hhdCBpcyB3b3J0aCBsb29raW5nIGF0IGluIHRoaXMgc2Vzc2lvbiDigJQgZWFjaCBmaW5kaW5nIG5hbWVzIHRoZSB2ZXJiIHRoYXQgZml4ZXMgaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2N0b3JcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9yZ2V0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKHJlZnVzZWQgd2hpbGUgdGhlIGZpbGUgZXhpc3RzIOKAlCB1c2UgaGlkZSB0byB0YWtlIG9uZSBvdXQgb2YgdGhlIGNvbnRleHQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJmb3JnZXRcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZGFuZ2xpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImxpbmtzIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCBmaWxlLCBsaW5lLCBhbmQgdGhlIHRhcmdldCBhcyB3cml0dGVuXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJkYW5nbGluZ1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJlbWl0IHRoaXMgQ0xJJ3MgYWNjIGRlY2xhcmF0aW9uICh3YWxrZWQgZnJvbSB0aGUgY29tbWFuZCB0YWJsZSlcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2hvdyB0aGlzIG1lc3NhZ2VcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuXTtcblxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG5jb25zdCBmaW5kQ29tbWFuZCA9ICh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQgPT5cbiAgQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbik7XG5cbi8qKiBUaGUgdmVyYiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCAoYSBzdHJpbmcgZmxhZyBjb25zdW1lcyBpdHMgdmFsdWUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmJUb2tlbihhcmd2OiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIGFyZ3ZbaSArIDFdID8/IG51bGw7XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYS5zbGljZSgyKSBhcyBGbGFnO1xuICAgICAgaWYgKGtleSBpbiBDTElfT1BUSU9OUyAmJiBDTElfT1BUSU9OU1trZXldLnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBDT01NQU5EUy5tYXAoKGMpID0+IGMubmFtZSk7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBGbGFnW10+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBDT01NQU5EUy5tYXAoKGMpID0+IFtjLm5hbWUsIGMuZmxhZ3NdKSxcbik7XG5leHBvcnQgY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgWy4uLihmaW5kQ29tbWFuZCh2ZXJiKT8uZmxhZ3MgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbmNvbnN0IHJlbmRlckZsYWcgPSAoazogRmxhZyk6IHN0cmluZyA9PlxuICBDTElfT1BUSU9OU1trXS50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZU9mKHNwZWM6IENvbW1hbmRTcGVjKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBzcGVjLm5hbWUsXG4gICAgLi4uc3BlYy5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgLi4uc3BlYy5mbGFncy5maWx0ZXIoKGspID0+IGsgIT09IFwic2Vzc2lvblwiKS5tYXAocmVuZGVyRmxhZyksXG4gIF0uam9pbihcIiBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWxwKCk6IHN0cmluZyB7XG4gIGNvbnN0IHJvd3MgPSBDT01NQU5EUy5tYXAoKGMpID0+IFt1c2FnZU9mKGMpLCBjLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ucm93cy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICBjb25zdCBib2R5ID0gcm93c1xuICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYHNjcmlwdG9yaXVtIOKAlCBhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93LlxuXG4gIE91dHB1dDogSlNPTiBvbiBzdGRvdXQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlCBleGNlcHQgdGFpbCAob25lIEpTT04gbGluZVxuICBwZXIgZXZlbnQpIGFuZCBoZWxwIChwcm9zZSkuIEZhaWx1cmVzOiBvbmUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXRcbiAgMiA9IHVzYWdlLCAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdC4gdGFpbCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIHJhdGhlciB0aGFuIGZhaWxpbmcsIGFuZCBlbmRzIDAgd2hlbiBpdHMgc2Vzc2lvbiBjbG9zZXMuYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzOiBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdIGFzIHN0cmluZ1tdLFxuICAgICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgICB9KSksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgICAgLi4uQ09NTUFORFMubWFwKChjKSA9PiAoe1xuICAgICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgICAgYXJnczogWy4uLmMuZmxhZ3NdLm1hcChhcmcpLFxuICAgICAgICBwb3NpdGlvbmFsczogYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pKSxcbiAgICBdLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIC8vIFRoZSBraXQgZG9lcyBub3QgdHJpYWdlOyB0aGlzIGRvZXMuIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICAgIC8vICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzOyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gYXJndlswXSk7XG4gIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkIHx8IGFyZ3ZbMF0gPT09IFwidmVyc2lvblwiKSB7XG4gICAgaWYgKChpbnRlcmNlcHRvcj8ucnVucyA/PyBcInZlcnNpb25cIikgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcmludEpzb24odmVyc2lvbkluZm8oKSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBsZXQgY3VycmVudENvbW1hbmQgPSB2ZXJiVG9rZW4oYXJndik7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3MoYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikgfHwgZS5leHRyYT8uY2hvaWNlcyA9PT0gdW5kZWZpbmVkKSB0aHJvdyBlO1xuICAgIGNvbnN0IHNwZWMgPSBjdXJyZW50Q29tbWFuZCA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGZpbmRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgICBpZiAoc3BlYyAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7IGhpbnQ6IGUuZXh0cmE/LmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7XG4gICAgICBoaW50OiBgbm8gdmVyYiBnaXZlbiDigJQgdmVyYnM6ICR7VkVSQlMuam9pbihcIiBcIil9IChydW46IGNsaS50cyBoZWxwKWAsXG4gICAgICBjaG9pY2VzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSksXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgW3ZlcmIsIC4uLnBvc10gPSBwYXJzZWQucG9zO1xuICBjb25zdCBmbGFncyA9IHBhcnNlZC5mbGFncztcbiAgY3VycmVudENvbW1hbmQgPSB2ZXJiID8/IG51bGw7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcblxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBbLi4uVkVSQlNdIH0pO1xuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQodmVyYik7XG4gIGlmIChzcGVjID09PSB1bmRlZmluZWQpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcblxuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KHNwZWMuZmxhZ3MpO1xuICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKGZsYWdzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFjY2VwdGVkID0gZmxhZ3NGb3Ioc3BlYy5uYW1lKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3NwZWMubmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBzY3JpcHRvcml1bSBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgYWNjZXB0ZWQubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogYWNjZXB0ZWQgfSA6IHsgaGludDogYCR7c3BlYy5uYW1lfSB0YWtlcyBubyBmbGFnc2AgfSxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1c2FnZTogJHt1c2FnZU9mKHNwZWMpfWAsIHsgaGludDogc3BlYy5kZXNjcmliZSB9KTtcblxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuICBjb25zdCBjb2RlID0gYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gYGFjY2VwdGVkYCBpcyBgYWNjZXB0YCdzXG4gICAqICB2ZXJkaWN0IG9uIHRoaXMgZnJhbWUsIHdoaWNoIGlzIHdoYXQgbGV0cyBgdGFpbCAtLW9uY2VgIGVuZCBvbiB0aGUgZmlyc3RcbiAgICogIGZyYW1lIGl0IGFjdHVhbGx5IERFTElWRVJTIChgLi90YWlsSGFuZG9mZi50c2ApLlxuICAgKlxuICAgKiAg4puUIEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OIGJlZm9yZSB0aGUgY2xpZW50IHJldHVybnMuIEl0XG4gICAqICB1c2VkIHRvIHJldHVybiBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIHdpdGggdGhlIFNTRSBzdHJlYW0gc3RpbGwgb3BlbixcbiAgICogIHdoaWNoIGtlcHQgdGhlIHByb2Nlc3MgYWxpdmUg4oCUIHVuc2VlbiBmb3IgYGNsb3NlZGAsIGJlY2F1c2UgdGhlIHNlcnZlclxuICAgKiAgZW5kcyB0aGF0IHN0cmVhbSBpdHNlbGYsIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFza1xuICAgKiAgd291bGQgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQuIChBZGp1c3RtZW50IDEgb2YgdGhlXG4gICAqICBNb25pdG9yLWV4cGlyeSBzcGlrZTsgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lLCBhY2NlcHRlZDogYm9vbGVhbikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBhcyB0aGUgdGFpbCBlbmRzLCB3aXRoIHRoZSBmaW5hbCBjdXJzb3IgKHRoZSBib29rbWFyayBhIHJlLWFybVxuICAgKiBwYXNzZXMgYXMgYC0tc2luY2VgKSBhbmQgd2h5IGl0IGVuZGVkLiBBIFJFUE9SVCBTSU5LIGxpa2UgYG9uRGlzY29ubmVjdGAsXG4gICAqIG5vdCBhIGJlaGF2aW91cmFsIGhhdGNoOiBpdCBjaGFuZ2VzIG5vdGhpbmcgdGhlIGNsaWVudCBkb2VzLiBJdCBleGlzdHNcbiAgICogZm9yIGAuL3RhaWxIYW5kb2ZmLnRzYCwgd2hvc2UgbGFzdCBsaW5lIG5hbWVzIHRoZSByZS1hcm0gYW5kIG11c3QgY2FycnlcbiAgICogdGhlIGN1cnNvciBleGFjdGx5IGFzIHRoaXMgbG9vcCBsZWZ0IGl0LCBlcG9jaCByZXNldHMgaW5jbHVkZWQuXG4gICAqL1xuICBvbkVuZD86IChlbmQ6IHsgY3Vyc29yOiBudW1iZXI7IHJlYXNvbjogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIiB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKTogeyBmcmFtZTogU3NlRnJhbWUgfCBudWxsOyBjb21tZW50czogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikge1xuICAgICAgICAgIGVuZGluZyA9IFwidW5yZXNvbHZlZFwiO1xuICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHtcbiAgICAgICAgICAgICAgLy8g4puUIENMT1NFIFRIRSBDT05ORUNUSU9OLiBTZWUgYHRlcm1pbmFsYCdzIGRvYzogd2l0aG91dCB0aGlzIHRoZVxuICAgICAgICAgICAgICAvLyBvcGVuIHN0cmVhbSBrZWVwcyB0aGUgcHJvY2VzcyBhbGl2ZSBhZnRlciB3ZSByZXR1cm4uXG4gICAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgICAgZW5kaW5nID0gXCJ0ZXJtaW5hbFwiO1xuICAgICAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gICAgb3B0cy5vbkVuZD8uKHsgY3Vyc29yLCByZWFzb246IGVuZGluZyB9KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSB0YWlsJ3MgSEFORE9GRjogaG93IGEgc3BlbGwncyBgdGFpbGAgZW5kcyBpdHMgb3duIHdhdGNoIGp1c3QgYmVmb3JlIHRoZVxuICogaGFybmVzcydzIE1vbml0b3IgY2FwLCBhbmQgdGhlIG9uZSBzdGRvdXQgbGluZSB0aGF0IG5hbWVzIHRoZSBhZ2VudCdzIG5leHRcbiAqIGFjdCwgYm9va21hcmsgaW5jbHVkZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBUaGlzIG1vZHVsZSBpbXBvcnRzIG9ubHkgaXRzIHNpYmxpbmcgYC4vdGFpbEV2ZW50c2AuXG4gKlxuICogQnVpbHQgb24gYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0byBDb2xlJ3MgcnVsaW5nIG9mIDIwMjYtMDktMjMgKHRoZVxuICogXCJSdWxpbmdcIiBzZWN0aW9uIG9mXG4gKiBgZG9jcy9iYWNrbG9nLzIwMjYtMDktMjItc2NyaXB0b3JpdW0tdGFpbC1tb25pdG9yLWV4cGlyeS13YWtlcy10aGUtYWdlbnQtZm9yLW5vdGhpbmcubWRgKVxuICogYW5kIHRoZSBmb3VyIGFkanVzdG1lbnRzIG9mIGl0cyBmZWFzaWJpbGl0eSBzcGlrZVxuICogKGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMjItbW9uaXRvci1leHBpcnktYW5kLXRoZS10YWlsLm1kYCkuXG4gKlxuICog4pSA4pSAIFRIRSBQUk9CTEVNLCBPTkUgUEFSQUdSQVBIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBraWxscyBldmVyeSB3YXRjaCBhdCAxLDgwMCwwMDAgbXMuIEV2ZXJ5IHNwZWxsIHRlbGxzXG4gKiB0aGUgYWdlbnQgdG8gd3JhcCBgdGFpbGAgaW4gTW9uaXRvciwgc28gYW4gaWRsZSBzZXNzaW9uIHdva2UgdGhlIGFnZW50IGV2ZXJ5XG4gKiAzMCBtaW51dGVzIHRvIHJlLWFybSwgYW5kIGEgYmFyZSByZS1hcm0gcmVwbGF5ZWQgdXAgdG8gdGhlIGxhc3QgMTAwMCBldmVudHMsXG4gKiBhbnN3ZXJlZCBodW1hbiBtZXNzYWdlcyBpbmNsdWRlZC4gVGhlIHJlcGxheSBpcyBhIGNvcnJlY3RuZXNzIGJ1ZzsgdGhlIGlkbGVcbiAqIHdha2VzIGFyZSBhIGNvc3QgQ29sZSBydWxlZCBhZ2FpbnN0LlxuICpcbiAqIOKUgOKUgCBUSEUgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVHdvIG1vZGVzLCBvbmUgbGluZSBhdCB0aGUgZW5kIG9mIGVhY2g6XG4gKlxuICogICDigKIgYHdhdGNoYCAodGhlIGRlZmF1bHQsIHJ1biB1bmRlciBNb25pdG9yKTogc3RyZWFtcyB1bnRpbCBpdHMgV0lORE9XIGVuZHMsXG4gKiAgICAgdGhlbiBwcmludHMgYHRhaWwud2luZG93YCAoaXQgc2F3IGV2ZW50cyDihpIgcmUtYXJtIE1vbml0b3IpIG9yXG4gKiAgICAgYHRhaWwucXVpZXRgIChpdCBzYXcgbm9uZSDihpIgcnVuIGB0YWlsIC0tb25jZWAgYXMgYSBiYWNrZ3JvdW5kIEJhc2hcbiAqICAgICB0YXNrKS4gQSBQUkVTRU5DRSBzcGVsbCBhbHdheXMgZ2V0cyBgdGFpbC53aW5kb3dgOiBhIHN0b3Atc3RhcnQgdGFpbFxuICogICAgIHdvdWxkIGZsaWNrZXIgdGhlIHByZXNlbmNlIGl0cyBjb25uZWN0aW9uIGNhcnJpZXMuXG4gKiAgIOKAoiBgb25jZWAgKHJ1biBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrKTogc2xlZXBzIHVudGlsIHRoZSBmaXJzdCBsb2cgZXZlbnQsXG4gKiAgICAgcHJpbnRzIGl0LCBwcmludHMgYHRhaWwud29rZWAgKOKGkiBiYWNrIHRvIE1vbml0b3IpIGFuZCBFWElUUywgd2hpY2ggaXNcbiAqICAgICB3aGF0IHdha2VzIHRoZSBhZ2VudC5cbiAqXG4gKiBFaXRoZXIgbW9kZSBlbmRzIHdpdGggYHRhaWwuY2xvc2VkYCB3aGVuIHRoZSBzZXNzaW9uIGNsb3NlcyBhbmQgYHRhaWwubG9zdGBcbiAqIHdoZW4gdGhlIGRhZW1vbiBpcyBnb25lIChzZXNzaW9uIHNwZWxscyksIGVhY2ggbmFtaW5nIGhvdyB0byBjb21lIGJhY2tcbiAqIGluc3RlYWQgb2YgYSByZS1hcm0uIEEgc2lnbmFsIG9yIGEgY2FsbGVyJ3MgYWJvcnQgcHJpbnRzIG5vdGhpbmcuXG4gKlxuICogRXZlcnkgcmUtYXJtIGNhcnJpZXMgYC0tc2luY2UgPGN1cnNvcj5gLCBzbyBub3RoaW5nIHJlcGxheXM7IHRoZSBkYWVtb24nc1xuICogYnVmZmVyIGNvdmVycyB3aGF0ZXZlciBsYW5kcyBiZXR3ZWVuIG9uZSB3YXRjaCdzIGV4aXQgYW5kIHRoZSBuZXh0J3MgYXJtLlxuICpcbiAqIOKUgOKUgCBERUNJU0lPTiBMT0cgKGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCAyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBLaXQgZGVjaXNpb25zIGxpdmUgaW4gbW9kdWxlIGhlYWRlcnMgKHRoZSBhcmNoaXRlY3R1cmUgZG9jJ3Mgwqc0IHJ1bGU6IFwiZWFjaFxuICogbW9kdWxlJ3MgaGVhZGVyIGlzIHRoZSBhdXRob3JpdGF0aXZlIGFjY291bnRcIikuIFJ1bGVkIGJ5IENvbGU6IHRoZSBoeWJyaWQsXG4gKiB0aGUgYWx3YXlzLWJvb2ttYXJrLCBwcmVzZW5jZSBzcGVsbHMgYWx3YXlzIHJlLWFybSBNb25pdG9yLCBib3VudHkncyBleGFtcGxlXG4gKiBmaXhlZC4gVGhlIGZvdXIgYWRqdXN0bWVudHMgd2VyZSB0aGUgc3Bpa2UncyByZXF1aXJlbWVudHMuIFRoZSByZXN0IGFyZSB0aGVcbiAqIGltcGxlbWVudGVyJ3MgcnVsaW5ncywgbWFya2VkIOKaliB3aXRoIHRoZSBvcHRpb25zIG5vdCB0YWtlbi5cbiAqXG4gKiBBMSDCtyBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTi4gYHRhaWxFdmVudHNgIG5vdyBhYm9ydHMgdGhlXG4gKiAgICAgIGluLWZsaWdodCBmZXRjaCBiZWZvcmUgaXQgcmV0dXJucyBvbiBhIHRlcm1pbmFsIGZyYW1lLiBCZWZvcmUsIGl0XG4gKiAgICAgIHJldHVybmVkIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3AgYW5kIGxlZnQgdGhlIFNTRSBzdHJlYW0gb3Blbiwgc28gdGhlXG4gKiAgICAgIHByb2Nlc3Mgc3RheWVkIGFsaXZlOiB1bnNlZW4gZm9yIGBjbG9zZWRgICh0aGUgc2VydmVyIGVuZHMgdGhhdFxuICogICAgICBzdHJlYW0gaXRzZWxmKSBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2sgd291bGRcbiAqICAgICAgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQsIHNpbGVudGx5LiBQaW5uZWQgaW5cbiAqICAgICAgYHRhaWxIYW5kb2ZmLnRlc3QudHNgIGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBrZWVwcyB0aGUgc3RyZWFtIG9wZW4uXG4gKlxuICogQTIgwrcgVEhFIE5FWFQgQUNUIERFUEVORFMgT04gU1RBVEUuIGBoYW5kb2ZmKClgIGJlbG93IGlzIHRoZSBwdXJlIGRlY2lzaW9uOlxuICogICAgICBxdWlldCDihpIgYmFja2dyb3VuZCwgYWN0aXZlIG9yIHByZXNlbmNlIOKGkiBNb25pdG9yLCB3b2tlIOKGkiBNb25pdG9yLFxuICogICAgICBjbG9zZWQg4oaSIGNvbWUgYmFjaywgbG9zdCDihpIgY29tZSBiYWNrLiBDb21lIGJhY2sgaXMgdGhlIHNwZWxsJ3Mgb3duIHZlcmJcbiAqICAgICAgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCBmb3IgdGhlIHNlc3Npb24gc3BlbGxzKS5cbiAqICAgICAg4pqWIFRIRSBESVNDT05ORUNUIERFQ0lTSU9OOiBmb3IgYSBzZXNzaW9uIHNwZWxsLCBhIExPU1QgZGFlbW9uIGVuZHMgdGhlXG4gKiAgICAgIHRhaWwgaW4gQk9USCBtb2RlcyB3aXRoIGEgc3Rkb3V0IGB0YWlsLmxvc3RgIGxpbmUuIE1vbml0b3Igbm90aWZpZXMgb25seVxuICogICAgICBvbiBzdGRvdXQsIHNvIHRoZSBvbGQgc3RkZXJyLW9ubHkgYHRhaWwuZGlzY29ubmVjdGVkYCBsZWZ0IGFcbiAqICAgICAgTW9uaXRvci13cmFwcGVkIGFnZW50IHVuYXdhcmUgb2YgYSBga2lsbCAtOWAgKEU1NSdzIHB1cnBvc2UgdW5tZXQpLCBhbmRcbiAqICAgICAgYSBgLS1vbmNlYCBvbiBhIGRlYWQgZGFlbW9uIHdvdWxkIGhhdmUgc2xlcHQgZm9yZXZlci4gXCJMb3N0XCIgaXNcbiAqICAgICAgYExPU1RfQUZURVJfUkVGVVNBTFNgIGNvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3csIG5ldmVyIGEgZHJvcHBlZFxuICogICAgICBzdHJlYW0gYWxvbmU6IGEgbGFwdG9wIHRoYXQgc2xlZXBzIGRyb3BzIHRoZSBzdHJlYW0sIHJlY29ubmVjdHMgb24gdGhlXG4gKiAgICAgIGZpcnN0IHRyeSwgYW5kIG11c3Qgc3RheSBzaWxlbnQuXG4gKiAgICAgICAgTm90IHRha2VuOiAoYSkga2VlcCByZXRyeWluZyBhbmQgb25seSBNT1ZFIHRoZSBkaXNjb25uZWN0IGxpbmUgdG9cbiAqICAgICAgICBzdGRvdXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24gaXMgbmV2ZXIgcmVzcGF3bmVkIGJ5IGl0cyB0YWlsLCBzbyB0aGVcbiAqICAgICAgICByZXRyaWVzIGJ1eSBub3RoaW5nIGFuZCB0aGUgYWdlbnQgaXMgd29rZW4gdG8gYmUgdG9sZCB0byB3YWl0OyAoYilcbiAqICAgICAgICBsZWF2ZSBpdCBvbiBzdGRlcnIg4oCUIHRoZSBkZWZlY3QuXG4gKiAgICAgIOKaliBQcmVzZW5jZSBzcGVsbHMga2VlcCByZXRyeWluZywgYXMgYmVmb3JlOiBncmFwZXZpbmUncyB0YWlsIHJlc3Bhd25zXG4gKiAgICAgIGl0cyBkYWVtb24gYW5kIGFzdHJvbGFiZSdzIGBqb2luYCB3YWl0cyBmb3IgdGhlIGh1bWFuIHRvIHJlb3BlbiB0aGVcbiAqICAgICAgYm9hcmQsIGJvdGggYnkgZGVzaWduLiBUaGVpciBkaXNjb25uZWN0IG5vdGVzIHN0YXkgd2hlcmUgdGhleSB3ZXJlLlxuICpcbiAqIEEzIMK3IFFVSUVUIElTIFRIRSBUQUlMJ1MgT1dOIENPVU5ULiBgZXZlbnRzYCBjb3VudHMgdGhlIGxvZyBmcmFtZXMgdGhpc1xuICogICAgICBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dC4gVGhlIGdyb3VuZGluZyBsaW5lLCBhIHNwZWxsJ3MgYHN1YnNjcmliZWRgXG4gKiAgICAgIG1hcmtlciwgYGVwb2NoLmNoYW5nZWRgIGFuZCB0aGUgaGFuZG9mZiBsaW5lIGl0c2VsZiBhcmUgbm90IGxvZyBmcmFtZXNcbiAqICAgICAgYW5kIGFyZSBub3QgY291bnRlZCAoYGNvdW50c2AgbGV0cyBhIHNwZWxsIGV4Y2x1ZGUgYSBzZXJ2ZXItc2VudFxuICogICAgICBncm91bmRpbmcgZnJhbWUpLiBBbnkgbG9nIGZyYW1lIGNvdW50cywgdGhlIGRhZW1vbidzIGB3YWl0aW5nYCByZW1pbmRlclxuICogICAgICBpbmNsdWRlZCwgc28gXCJxdWlldFwiIG1lYW5zIG5vdGhpbmcgb24gdGhlIGxvZy5cbiAqICAgICAg4pqWIEEgZnJhbWUgdGhlIHRhaWwncyBvd24gZmlsdGVyIHJlamVjdHMgKGJvdW50eSdzIG93bmVyIHNjb3BlLCBhXG4gKiAgICAgIHNlbGYtZWNobykgaXMgTk9UIGNvdW50ZWQgYW5kIGRvZXMgbm90IGVuZCBhIGAtLW9uY2VgOiBpdCB3YXMgbmV2ZXJcbiAqICAgICAgZGVsaXZlcmVkLCBhbmQgd2FraW5nIG9uIGl0IHdvdWxkIGJlIGEgd2FrZSB3aXRoIG5vdGhpbmcgdG8gYWN0IG9uIOKAlFxuICogICAgICB0aGUgZGVmZWN0IHRoaXMgbW9kdWxlIGV4aXN0cyB0byByZW1vdmUuIFRoZSBjdXJzb3Igc3RpbGwgYWR2YW5jZXNcbiAqICAgICAgcGFzdCBpdCAodGFpbEV2ZW50cycgcnVsZSksIHNvIGl0IG5ldmVyIHJlcGxheXMgZWl0aGVyLlxuICogICAgICBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOyB0aGF0IGhhbGYgbGl2ZXMgaW4gZWFjaFxuICogICAgICBzcGVsbCdzIGB0YWlsYCwgd2hpY2gga25vd3Mgd2hldGhlciBgLS1zaW5jZWAgd2FzIGdpdmVuLlxuICpcbiAqIEE0IMK3IFRIRSBXSU5ET1cuIGBERUZBVUxUX1dJTkRPV19NU2AgPSB0aGUgY2FwIG1pbnVzIGBXSU5ET1dfTUFSR0lOX01TYFxuICogICAgICAoNjAgcyksIHNvIDEsNzQwLDAwMCBtcy4gVGhlIG1hcmdpbiBoYXMgdG8gY292ZXIgdGhlIGdhcCBiZXR3ZWVuIHRoZVxuICogICAgICBoYXJuZXNzIHN0YXJ0aW5nIGl0cyBjbG9jayBhbmQgdGhpcyBwcm9jZXNzIHN0YXJ0aW5nIGl0cyBvd24gKEJ1blxuICogICAgICBzdGFydC11cCwgYSBzZXNzaW9uIGxvb2t1cCwgYSBkYWVtb24gc3Bhd24gb24gdGhlIHNwZWxscyB3aG9zZSBgcmVzb2x2ZWBcbiAqICAgICAgc3Bhd25zIG9uZSDigJQgYm91bmRlZCBieSB0aGVpciBzdGFydCB0aW1lb3V0cywgd2hpY2ggYXJlIHNlY29uZHMpIHBsdXNcbiAqICAgICAgdGhlIGxhc3QgbGluZSdzIGZsdXNoIGFuZCBNb25pdG9yJ3MgMjAwIG1zIGJhdGNoaW5nLiBBIG1pbnV0ZSBjb3ZlcnNcbiAqICAgICAgYWxsIG9mIHRoYXQgbWFueSB0aW1lcyBvdmVyIGFuZCBjb3N0cyAzJSBvZiB0aGUgd2luZG93LCBvbmUgZXh0cmFcbiAqICAgICAgcmUtYXJtIGFib3V0IGV2ZXJ5IDE0LjUgaG91cnMgb2YgYWN0aXZpdHkuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKaliBgLS1vbmNlYCBFTkRTIE9OIFRIRSBGSVJTVCBGUkFNRSwgd2l0aCBubyBkcmFpbi4gQSBidXJzdCBhcnJpdmVzIHNwbGl0OiB0aGVcbiAqICAgZmlyc3QgZXZlbnQgb24gdGhlIG9uZS1zaG90LCB0aGUgcmVzdCBvbiB0aGUgTW9uaXRvciByZS1hcm0sIHdoaWNoIGxvc2VzXG4gKiAgIG5vdGhpbmcgYmVjYXVzZSBvZiB0aGUgYm9va21hcmsuIFRoZSBzcGlrZSBvZmZlcmVkIGEgfjIwMCBtcyBkcmFpbiBhcyBhblxuICogICBvcHRpb24sIG5vdCBhIHJlcXVpcmVtZW50OyBub3QgdGFrZW4sIGJlY2F1c2UgaXQgYWRkcyBhIHRpbWVyIHRvIHRoZVxuICogICBleGl0IHBhdGggd2hvc2UgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gbWFrZSBpbXBvc3NpYmxlLlxuICog4pqWIFRIRSBMSU5FJ1MgYGNvbW1hbmRgIElTIFJVTk5BQkxFIEFTIFBSSU5URUQ6IGBidW4gPHRoaXMgY2xpJ3MgcGF0aD4g4oCmYCxcbiAqICAgcGlubmVkIHRvIHRoZSBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGVcbiAqICAgc2tpbGxzIG5hbWUgdGhlIHJ1bGUgb25jZTsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIGVuZDogVGFpbEVuZDtcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBMb2cgZnJhbWVzIHRoaXMgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQgKEEzKS4gKi9cbiAgZXZlbnRzOiBudW1iZXI7XG4gIC8qKiBUaGUgYm9va21hcms6IHRoZSBoaWdoZXN0IGlkIHRoaXMgcHJvY2VzcyBoYXMgc2Vlbi4gKi9cbiAgY3Vyc29yOiBudW1iZXI7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKlxuICogVEhFIERFQ0lTSU9OOiBnaXZlbiBob3cgdGhlIHRhaWwgZW5kZWQsIHdoaWNoIGxpbmUgaXQgcHJpbnRzLiBQdXJlLCBzbyBldmVyeVxuICogc3RhdGUgaXMgYSBsaXRlcmFsIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLiBSZXR1cm5zIG51bGwgZm9yIGBzdG9wcGVkYDpcbiAqIGEgaHVtYW4ncyBDdHJsLUMgb3IgYSBjYWxsZXIncyBhYm9ydCBpcyBub3QgYSBoYW5kb2ZmLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFuZG9mZihzOiBIYW5kb2ZmSW5wdXQsIGNtZDogSGFuZG9mZkNvbW1hbmRzKTogSGFuZG9mZkxpbmUgfCBudWxsIHtcbiAgY29uc3QgYmFzZSA9IHsgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLiBUbyBicmluZyBpdCBiYWNrLCBydW4gY29tbWFuZFwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwibG9zdFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmxvc3RcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuIFRvIGNvbWUgYmFjaywgcnVuIGNvbW1hbmRcIixcbiAgICAgIH07XG4gICAgY2FzZSBcImV2ZW50XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwud29rZVwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IGZhbHNlIH0pLFxuICAgICAgICBoaW50OiBcImhhbmRsZSB0aGUgZXZlbnQgYWJvdmUsIHRoZW4gYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCBjb21tYW5kXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJ3aW5kb3dcIjpcbiAgICAgIGlmIChzLnByZXNlbmNlIHx8IHMuZXZlbnRzID4gMClcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwud2luZG93XCIsXG4gICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UgfSksXG4gICAgICAgICAgaGludDogXCJ0aGUgd2luZG93IGVuZGVkIGJlZm9yZSBNb25pdG9yJ3MgY2FwOyBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIGNvbW1hbmRcIixcbiAgICAgICAgfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5xdWlldFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcImJhY2tncm91bmRcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IHRydWUgfSksXG4gICAgICAgIGhpbnQ6IFwibm90aGluZyBvbiB0aGUgbG9nIHRoaXMgd2luZG93OyBydW4gY29tbWFuZCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50XCIsXG4gICAgICB9O1xuICB9XG59XG5cbi8qKiBQT1NJWCBzaW5nbGUtcXVvdGUgYW4gYXJndW1lbnQgd2hlbiBpdCBuZWVkcyBpdCwgc28gYSBwcmludGVkIGBjb21tYW5kYFxuICogIHJ1bnMgYXMgcHJpbnRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqIEpvaW4gYW4gYXJndiBpbnRvIG9uZSBydW5uYWJsZSBjb21tYW5kIGxpbmUuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZExpbmUoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYXJndi5tYXAoc2hlbGxRdW90ZSkuam9pbihcIiBcIik7XG59XG5cbi8qKiBIb3cgVEhJUyBwcm9jZXNzIHdhcyBpbnZva2VkLCBhcyB0aGUgaGVhZCBvZiBhIGNvbW1hbmQgdGhhdCBydW5zIGl0IGFnYWluOlxuICogIGBidW4gPHRoZSBsYXVuY2hlcidzIGZ1bGwgcGF0aD5gLiBCdW4gaGFuZHMgYGFyZ3ZbMV1gIG92ZXIgYXMgYSBmdWxsIHBhdGguICovXG5leHBvcnQgZnVuY3Rpb24gc2VsZkNvbW1hbmQoKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1wiYnVuXCIsIHByb2Nlc3MuYXJndlsxXSA/PyBcImNsaS50c1wiXTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOIFstLW9uY2VdYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChwcmVmaXg6IHJlYWRvbmx5IHN0cmluZ1tdLCBzaW5jZTogbnVtYmVyLCBvbmNlOiBib29sZWFuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHtzaW5jZX1gXSA6IFtcIi0tc2luY2VcIiwgU3RyaW5nKHNpbmNlKV07XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIEEgcHJlc2VuY2Ugc3BlbGw6IGFsd2F5cyBgdGFpbC53aW5kb3dgIGF0IHRoZSB3aW5kb3cncyBlbmQsIG5ldmVyIGxvc3QuICovXG4gIHByZXNlbmNlOiBib29sZWFuO1xuICAvKiogRGVmYXVsdDogYHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSlgLiBgMGAgPSBubyB3aW5kb3cuICovXG4gIHdpbmRvd01zPzogbnVtYmVyO1xuICAvKiogV2hldGhlciBhbiBlbWl0dGVkIGZyYW1lIGlzIGEgTE9HIGZyYW1lIChBMykuIERlZmF1bHQ6IGV2ZXJ5IG9uZS4gKi9cbiAgY291bnRzPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogV2hpY2ggdGVybWluYWwgZnJhbWUgbWVhbnMgdGhlIHNlc3Npb24gY2xvc2VkLiBEZWZhdWx0OiBldmVyeSB0ZXJtaW5hbC4gKi9cbiAgaXNDbG9zZWQ/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlZnVzYWxzID0gMDtcblxuICBjb25zdCBmaW5pc2ggPSAoZTogVGFpbEVuZCkgPT4ge1xuICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IGU7XG4gICAgYWMuYWJvcnQoKTtcbiAgfTtcbiAgY29uc3QgdGltZXIgPVxuICAgIGgubW9kZSA9PT0gXCJ3YXRjaFwiICYmIHdpbmRvd01zID4gMCA/IHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKFwid2luZG93XCIpLCB3aW5kb3dNcykgOiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29kZSA9IGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICAgIC4uLnRhaWwsXG4gICAgICBzaWduYWw6IGFjLnNpZ25hbCxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBBIHBpbm5lZCBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcgYWZ0ZXIgd2UgaGFkIGl0OiBpdCBjbG9zZWQuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBzLmV2ZXJSZXNvbHZlZCAmJiBlbmQgPT09IG51bGwpIGVuZCA9IFwiY2xvc2VkXCI7XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBjb3VudHMoZXYsIGZyYW1lKSkgZXZlbnRzICs9IDE7XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIHRlcm1pbmFsOiAoZXYsIGZyYW1lLCBhY2NlcHRlZCkgPT4ge1xuICAgICAgICBpZiAodGFpbC50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gKGguaXNDbG9zZWQgPz8gKCgpID0+IHRydWUpKShldikgPyBcImNsb3NlZFwiIDogXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGNvdW50cyhldiwgZnJhbWUpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgcmV0dXJuIHRhaWwub25Db21tZW50Py4odGV4dCkgPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLm9uRGlzY29ubmVjdD8uKGluZm8pID8/IG51bGw7XG4gICAgICAgIGlmIChpbmZvLmNhdXNlID09PSBcImNvbm5lY3QtZmFpbGVkXCIpIHtcbiAgICAgICAgICByZWZ1c2FscyArPSAxO1xuICAgICAgICAgIGlmIChlbmRPbkxvc3QgJiYgcmVmdXNhbHMgPj0gTE9TVF9BRlRFUl9SRUZVU0FMUykgZmluaXNoKFwibG9zdFwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUaGUgZGFlbW9uIGFuc3dlcmVkIChhIHN0YXR1cywgb3IgYSBzdHJlYW0gdGhhdCBvcGVuZWQgYW5kIHRoZW5cbiAgICAgICAgICAvLyBlbmRlZCk6IGl0IGlzIGFsaXZlLCBzbyB0aGUgcmVmdXNhbHMgd2VyZSBub3QgaW4gYSByb3cuXG4gICAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIG9uRW5kOiAocykgPT4ge1xuICAgICAgICBjdXJzb3IgPSBzLmN1cnNvcjtcbiAgICAgICAgdGFpbC5vbkVuZD8uKHMpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaW5lID0gaGFuZG9mZihcbiAgICAgIHsgZW5kOiBlbmQgPz8gXCJzdG9wcGVkXCIsIG1vZGU6IGgubW9kZSwgZXZlbnRzLCBjdXJzb3IsIHByZXNlbmNlOiBoLnByZXNlbmNlIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7QUFnREE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVVBO0FBQ0E7QUFDQSxzQkFBUzs7O0FDdENGLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUlJLE1BQU0saUJBQWlCLE1BQU07QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUVULFdBQVcsQ0FB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LElBQUksV0FBVyxpQkFBaUIsRUFBRSxNQUFNLG9CQUFvQixTQUFTLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQztBQUFBLEVBQ3pGLE1BQU0sT0FBTyxZQUFZLElBQUk7QUFBQSxFQUM3QixJQUFJLFNBQVM7QUFBQSxJQUNYLE1BQU0sSUFBSSxXQUFXLGlCQUFpQixTQUFTO0FBQUEsTUFDN0MsTUFBTTtBQUFBLE1BQ04sU0FBUyxDQUFDLEdBQUcsS0FBSztBQUFBLElBQ3BCLENBQUM7QUFBQSxFQUVILE1BQU0sVUFBVSxJQUFJLElBQVksS0FBSyxLQUFLO0FBQUEsRUFDMUMsTUFBTSxRQUFRLE9BQU8sS0FBSyxLQUFLLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDNUQsSUFBSSxVQUFVLFdBQVc7QUFBQSxJQUN2QixNQUFNLFdBQVcsU0FBUyxLQUFLLElBQUk7QUFBQSxJQUNuQyxNQUFNLElBQUksV0FDUixLQUFLLDhCQUE4QixLQUFLLHNFQUN4QyxTQUFTLFNBQVMsSUFBSSxFQUFFLFNBQVMsU0FBUyxJQUFJLEVBQUUsTUFBTSxHQUFHLEtBQUssc0JBQXNCLENBQ3RGO0FBQUEsRUFDRjtBQUFBLEVBRUEsTUFBTSxXQUFXLEtBQUssWUFBWSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLEVBQzVELE1BQU0sV0FBVyxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsRUFDeEQsSUFBSSxJQUFJLFNBQVMsWUFBYSxDQUFDLFlBQVksSUFBSSxTQUFTLEtBQUssWUFBWTtBQUFBLElBQ3ZFLE1BQU0sSUFBSSxXQUFXLFVBQVUsUUFBUSxJQUFJLEtBQUssRUFBRSxNQUFNLEtBQUssU0FBUyxDQUFDO0FBQUEsRUFFekUsTUFBTSxVQUFVLE9BQU8sTUFBTSxZQUFZLFdBQVcsTUFBTSxVQUFVO0FBQUEsRUFDcEUsTUFBTSxPQUFPLE1BQU0sS0FBSyxJQUFJLEtBQUssT0FBTyxPQUFPO0FBQUEsRUFDL0MsT0FBTyxPQUFPLFNBQVMsV0FBVyxPQUFPO0FBQUE7QUFRM0MsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiOTBDRDgyODcxQUFERTg2QjY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
