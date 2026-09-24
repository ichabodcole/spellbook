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
  let epoch = opts.sinceEpoch ?? null;
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
      if (stopped)
        break;
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
      const params = opts.query?.(cursor, firstConnect) ?? {
        since: String(cursor)
      };
      const askedSince = cursor;
      let restartNoted = false;
      let fromTop = false;
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
            const n = opts.cursorOf?.(ev);
            let epochReset = false;
            if (opts.epochOf) {
              const next = opts.epochOf(ev);
              if (typeof next === "string") {
                if (epoch !== null && next !== epoch) {
                  cursor = 0;
                  epochReset = true;
                  const line = opts.onEpochChange?.(next) ?? null;
                  if (line !== null)
                    emit(line);
                  if (askedSince > 0 && typeof n === "number" && n > askedSince) {
                    epoch = next;
                    fromTop = true;
                    break;
                  }
                }
                epoch = next;
              }
            }
            if (opts.restartOnReplay === true && !epochReset && !restartNoted && askedSince >= 0 && typeof n === "number" && n <= askedSince) {
              restartNoted = true;
              cursor = 0;
              const line = opts.onEpochChange?.(opts.epochOf?.(ev) ?? "unknown") ?? null;
              if (line !== null)
                emit(line);
            }
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
          if (fromTop) {
            controller.abort();
            break;
          }
        }
      } finally {
        if (watchdog !== null)
          clearTimeout(watchdog);
        attempt = null;
      }
      if (stopped)
        break;
      if (fromTop) {
        delay = retry.initialMs;
        continue;
      }
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
    opts.onEnd?.({ cursor, epoch, reason: ending });
  }
}

// src/kit/wire/tailHandoff.ts
var MONITOR_CAP_MS = 1800000;
var WINDOW_MARGIN_MS = 60000;
var DEFAULT_WINDOW_MS = MONITOR_CAP_MS - WINDOW_MARGIN_MS;
var WINDOW_ENV = "SPELLBOOK_TAIL_WINDOW_MS";
var WINDOW_HELP = "ends itself before Monitor's 30-minute cap with a line naming the next act; a human watching a terminal keeps it open with SPELLBOOK_TAIL_WINDOW_MS=0";
var LOST_AFTER_REFUSALS = 3;
function resolveWindowMs(raw) {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WINDOW_MS;
}
var COME_BACK = (why) => `${why} To bring it back, run command; then arm the tail again with no --since, on the session id it prints where there is one (a restarted daemon starts a new event log, so the old bookmark does not apply)`;
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
        hint: COME_BACK("the session closed; there is nothing left to watch.")
      };
    case "lost":
      return {
        type: "tail.lost",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: COME_BACK("lost the daemon (it crashed or was killed); nothing is listening.")
      };
    case "event":
      return {
        type: "tail.woke",
        ...base,
        next: "monitor",
        command: cmd.tail({ since: s.cursor, once: false, ...s.epoch ? { epoch: s.epoch } : {} }),
        hint: "handle the event above, then arm Monitor (timeout_ms 1800000) with command"
      };
    case "window":
      if (s.presence || s.events > 0)
        return {
          type: "tail.window",
          ...base,
          next: "monitor",
          command: cmd.tail({
            since: s.cursor,
            once: false,
            ...s.epoch ? { epoch: s.epoch } : {}
          }),
          hint: "the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) with command"
        };
      return {
        type: "tail.quiet",
        ...base,
        next: "background",
        command: cmd.tail({ since: s.cursor, once: true, ...s.epoch ? { epoch: s.epoch } : {} }),
        hint: "nothing on the log this window; run command as a background Bash task (run_in_background) \u2014 it exits on the next event"
      };
  }
}
function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
function parseBookmark(token) {
  const at = token.indexOf("@");
  const id = at === -1 ? token : token.slice(0, at);
  const epoch = at === -1 ? "" : token.slice(at + 1);
  if (!/^-?\d+$/.test(id.trim()))
    return null;
  if (at !== -1 && epoch === "")
    return null;
  return { since: Number.parseInt(id, 10), ...epoch ? { epoch } : {} };
}
function commandLine(argv) {
  return argv.map(shellQuote).join(" ");
}
function selfCommand() {
  return ["bun", process.argv[1] ?? "cli.ts"];
}
function tailCommand(prefix, since, once, epoch) {
  const mark = epoch ? `${since}@${epoch}` : String(since);
  const at = since < 0 ? [`--since=${mark}`] : ["--since", mark];
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
  let epoch = tail.sinceEpoch;
  let frameHasId = false;
  const isLogFrame = (ev, frame) => frameHasId && counts(ev, frame);
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
      restartOnReplay: true,
      cursorOf: (ev) => {
        const n = tail.cursorOf?.(ev);
        frameHasId = typeof n === "number" && Number.isFinite(n);
        return n;
      },
      onUnresolved: (s) => {
        const verdict = tail.onUnresolved?.(s) ?? "retry";
        if (verdict === "stop" && end === null)
          end = "closed";
        return verdict;
      },
      render: (ev, frame) => {
        refusals = 0;
        const line2 = tail.render ? tail.render(ev, frame) : frame.data;
        if (line2 !== null && isLogFrame(ev, frame))
          events += 1;
        return line2;
      },
      terminal: (ev, frame, accepted) => {
        if (tail.terminal?.(ev, frame, accepted)) {
          if (end === null)
            end = (h.isClosed ?? (() => true))(ev) ? "closed" : "event";
          return true;
        }
        if (h.mode === "once" && accepted && isLogFrame(ev, frame)) {
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
        epoch = s.epoch ?? undefined;
        tail.onEnd?.(s);
      }
    });
    const line = handoff({
      end: end ?? "stopped",
      mode: h.mode,
      events,
      cursor,
      ...epoch ? { epoch } : {},
      presence: h.presence
    }, h.commands);
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
function parseTailSince(token) {
  const b = parseBookmark(token);
  if (b === null)
    die(`--since: "${token}" is not an event id \u2014 give an integer (the id of the last line you saw), optionally as <id>@<epoch>`, "usage");
  return b;
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
  const reArm = session !== undefined || o.sinceGiven;
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
      if (everResolved || reArm)
        return "stop";
      process.stderr.write(`# no session yet, retrying\u2026
`);
      return "retry";
    },
    path: "/events",
    since,
    ...o.epoch ? { sinceEpoch: o.epoch } : {},
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
      tail: ({ since: at, once, epoch }) => tailCommand([...selfCommand(), "tail", ...pin()], at, once, epoch),
      comeBack: () => commandLine([...selfCommand(), "open", "--restore", boundId ?? "<id>", "--no-open"])
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
    run: (_pos, flags, session) => {
      const b = typeof flags.since === "string" ? parseTailSince(flags.since) : { since: -1 };
      return cmdTail(session, b.since, {
        once: flags.once === true,
        sinceGiven: typeof flags.since === "string",
        ...b.epoch ? { epoch: b.epoch } : {}
      });
    }
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
  session rather than failing, and ends 0 when its session closes. tail
  ${WINDOW_HELP}.`;
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
  parseSinceDate,
  parseTailSince,
  parseVersion,
  renderHelp,
  run,
  usageOf,
  verbToken
};

//# debugId=B8B2BD9C963AA37C64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgb3IgYGRpc3BhdGNoYCwgbm9uZSBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYC4gVGhlXG4gKiBzd2FsbG93aW5nIGNhdGNoZXMgKGBhcGlgJ3Mgbm9uLUpTT04gYm9keSwgYHZlcnNpb25JbmZvYCwgYHBvc3RDbWRgJ3MgY2xvc2VcbiAqIEVDT05OUkVTRVQpIGNvbnRhaW4gbm8gZGllLXJlYWNoYWJsZSBjYWxsLlxuICovXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgY2xvc2VTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG9wZW5TeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQge1xuICBDbGlFcnJvcixcbiAgZGllLFxuICB0eXBlIEVycktpbmQsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9yc1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHBhcnNlQm9va21hcmssXG4gIHNlbGZDb21tYW5kLFxuICB0YWlsQ29tbWFuZCxcbiAgdGFpbFdpdGhIYW5kb2ZmLFxuICBXSU5ET1dfSEVMUCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IERPQ19FWFRFTlNJT05TLCBpc0RvY05hbWUgfSBmcm9tIFwiLi90cmVlXCI7XG5cbi8vIOKaoCBERUNMQVJFRCBGSVJTVCwgQUJPVkUgRVZFUlkgT1RIRVIgRlVOQ1RJT04sIE9OIFBVUlBPU0UuIFRoZSBgY2hvaWNlc2Bcbi8vIGNlbnN1cydzIHJhaXNlciBydWxlIChhKSAoYGdyaW1vaXJlL2xpYi9lcnJvci1zaXRlcy50c2ApIG1hdGNoZXNcbi8vIGBmdW5jdGlvbiBOQU1FKGAgbGF6aWx5IHVwIHRvIHRoZSBuZXh0IGApOiBuZXZlcmAgd2l0aGluIDYwMCBjaGFyYWN0ZXJzLCBzb1xuLy8gQU5ZIGZ1bmN0aW9uIGRlY2xhcmVkIHNob3J0bHkgYWJvdmUgdGhpcyBvbmUg4oCUIGBhcGlgLCB0aGVuIGByZXF1aXJlU2Vzc2lvbmAg4oCUXG4vLyB3YXMgcmVhZCBhcyBhIHJhaXNlciBhbmQgaXRzIGNhbGxzIGNvdW50ZWQgYXMgcmFpc2Ugc2l0ZXMgKGZvdW5kIDIwMjYtMDktMTEsXG4vLyByZXBvcnRlZCBpbiB0aGUgc2xpY2UtQSBqb3VybmFsIGFzIGFuIGluc3RydW1lbnQgZGVmZWN0LCBub3QgZml4ZWQgaGVyZSkuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGNvbnN0IGJvZHkgPSAoZGF0YSA/PyB7fSkgYXMgeyBlcnJvcj86IHVua25vd247IGNob2ljZXM/OiB1bmtub3duOyBoaW50PzogdW5rbm93biB9O1xuICBjb25zdCBjaG9pY2VzID0gQXJyYXkuaXNBcnJheShib2R5LmNob2ljZXMpID8gYm9keS5jaG9pY2VzLm1hcChTdHJpbmcpIDogdW5kZWZpbmVkO1xuICAvLyDimqAgVGhlIGRhZW1vbidzIG93biBoaW50LCBmb3J3YXJkZWQuIEEgcmVmdXNhbCB0aGF0IGtub3dzIHdoYXQgdG8gZG8gbmV4dFxuICAvLyB1c2VkIHRvIGRyb3AgdGhhdCBrbm93bGVkZ2Ugb24gdGhlIGZsb29yIGF0IHRoaXMgbGluZS5cbiAgY29uc3QgaGludCA9IHR5cGVvZiBib2R5LmhpbnQgPT09IFwic3RyaW5nXCIgPyBib2R5LmhpbnQgOiB1bmRlZmluZWQ7XG4gIGRpZSh0eXBlb2YgYm9keS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuZXJyb3IgOiBgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBTZXNzaW9ucyB3aG9zZSB3b3JrIGlzIHN0aWxsIG9uIGRpc2ssIG5ld2VzdCBmaXJzdCAoRTU2KS5cbiAqXG4gKiDim5QgQSBERUFEIFNFU1NJT04gSVMgTk9UIEEgTE9TVCBPTkUsIGFuZCB0aGUgQ0xJIHVzZWQgdG8gaW1wbHkgb3RoZXJ3aXNlLiBUaGVcbiAqIG1hbmlmZXN0IGFuZCBldmVyeSB2ZXJzaW9uIGZpbGUgbGl2ZSB1bmRlciB0aGUgaG9tZSwgc28gYSBkYWVtb24gdGhhdCBoYXNcbiAqIGV4aXRlZCDigJQgdGhlIDMwLW1pbnV0ZSBpZGxlIHRpbWVvdXQsIGEgY3Jhc2gsIGEgcmVib290IOKAlCBjb3N0cyB0aGUgVVJMIGFuZFxuICogbm90aGluZyBlbHNlLiBDb2xlIGhpdCBleGFjdGx5IHRoaXMgKFwidGhhdCBsaW5rIGRvZXNuJ3Qgc2VlbSB0byBiZSBsaXZlXG4gKiBhbnltb3JlXCIpIGFuZCB0aGUgb25seSB0aGluZyB0aGUgdG9vbGluZyBzYWlkIHdhcyBcIm5vIHJ1bm5pbmcgc2NyaXB0b3JpdW1cbiAqIHNlc3Npb25cIiwgd2hpY2ggcmVhZHMgbGlrZSB0aGUgd29yayBpcyBnb25lLlxuICovXG5mdW5jdGlvbiByZXN0b3JhYmxlKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoKGUpID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCBlLm5hbWUsIFwibWFuaWZlc3QuanNvblwiKSkpXG4gICAgICAubWFwKChlKSA9PiAoeyBpZDogZS5uYW1lLCBhdDogc3RhdFN5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKS5tdGltZU1zIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYXQgLSBhLmF0KVxuICAgICAgLm1hcCgoZSkgPT4gZS5pZCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogV2hhdCB0byBzYXkgd2hlbiBubyBkYWVtb24gYW5zd2VycyDigJQgaW5jbHVkaW5nIHRoZSB3YXkgYmFjaywgd2hlbiB0aGVyZSBpcyBvbmUuICovXG5mdW5jdGlvbiBub1Nlc3Npb25IaW50KCk6IHsgaGludDogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGlkcyA9IHJlc3RvcmFibGUoKTtcbiAgY29uc3QgbmV3ZXN0ID0gaWRzWzBdO1xuICBpZiAobmV3ZXN0ID09PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHsgaGludDogXCJubyBzZXNzaW9uIGhhcyBiZWVuIG9wZW5lZCBpbiB0aGlzIGhvbWUgeWV0IOKAlCBydW46IGNsaS50cyBvcGVuIDxwYXRoPlwiIH07XG4gIHJldHVybiB7XG4gICAgLy8g4pqgIFRoZSBDT01NQU5ELCB3aXRoIHRoZSBpZCBhbHJlYWR5IGluIGl0LiBBIGhpbnQgdGhhdCBzYXlzIFwieW91IGNhblxuICAgIC8vIHJlc3RvcmUgYSBzZXNzaW9uXCIgbGVhdmVzIHRoZSByZWFkZXIgdG8gZmluZCB0aGUgaWQgYW5kIGd1ZXNzIHRoZSBmbGFnLlxuICAgIGhpbnQ6IGBubyBkYWVtb24gaXMgcnVubmluZywgYnV0IHRoZSB3b3JrIGlzIG9uIGRpc2sg4oCUIGJyaW5nIGl0IGJhY2sgd2l0aDogY2xpLnRzIG9wZW4gLS1yZXN0b3JlICR7bmV3ZXN0fWAsXG4gICAgY2hvaWNlczogaWRzLnNsaWNlKDAsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbih0bXBkaXIoKSwgc2Vzc2lvbiA/IGBzY3JpcHRvcml1bS0ke3Nlc3Npb259Lmpzb25gIDogXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0Ug4oCUIEVOT0VOVCBpcyB0aGUgb25seSBhYnNlbmNlLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb25Qb2ludGVyO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgbm9TZXNzaW9uSGludCgpKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBsZXQgc3RhdHVzOiBudW1iZXI7XG4gIGxldCBkYXRhOiB1bmtub3duO1xuICB0cnkge1xuICAgICh7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYGNsb3NlYCBzdG9wcyB0aGUgc2VydmVyOyBhIFJFU0VUIGlzIGl0cyBzdWNjZXNzLiBBIHJlZnVzZWQgY29ubmVjdGlvblxuICAgIC8vIChhIHN0YWxlIHBvaW50ZXIpIGlzIGEgdHJhbnNwb3J0IGZhaWx1cmUgbGlrZSBhbnkgb3RoZXIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zdCBjb2RlID0gZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyID8gU3RyaW5nKGVyci5jb2RlKSA6IFwiXCI7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSlcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChTdHJpbmcobXNnLnR5cGUpLCBzdGF0dXMsIGRhdGEpO1xuICByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuLy8g4pSA4pSAIHRoZSBwYXJzZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjb250ZXh0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZW50cnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmb3I6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBxdW90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlb3BlbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW5rczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaWZlY3ljbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaW1pdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgb25jZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBwYXRjaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJzdGFydC10aW1lb3V0XCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB0YWc6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdHlwZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUyA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKS5tYXAoKGspID0+IGAtLSR7a31gKTtcblxuZXhwb3J0IGNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBDbGlFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSB7XG4gICAgc3VwZXIoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyB7IGNvZGU/OiBzdHJpbmcgfSkuY29kZTtcbiAgICAvLyBPbmx5IGFuIFVOS05PV04gb3B0aW9uIG5hbWVzIHRoZSBmbGFnIHJvc3RlcjsgdGhlIG90aGVyIHBhcnNlIGZhaWx1cmVzXG4gICAgLy8gbWVhbiBhIHJlY29nbmlzZWQgZmxhZyB3YXMgbWlzdXNlZCwgYW5kIHRoZSByb3N0ZXIgd291bGQgbmFtZSB0aGUgaGFsZlxuICAgIC8vIHRoYXQgd2FzIHJpZ2h0LlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGRldGFpbCwge1xuICAgICAgaGludDogXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCIsXG4gICAgICAuLi4oY29kZSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiID8geyBjaG9pY2VzOiBSRUNPR05JWkVEX0ZMQUdTIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbn1cblxuLyoqXG4gKiBgdGFpbCAtLXNpbmNlYCBpcyBhIEJPT0tNQVJLOiBhbiBldmVudCBpZCAoLTEgZm9yIFwiZXZlcnl0aGluZ1wiKSwgb3B0aW9uYWxseVxuICogd2l0aCB0aGUgZXBvY2ggb2YgdGhlIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgYXMgdGhlIHRhaWwncyBvd24gaGFuZG9mZiBsaW5lIHByaW50cyBpdCDigJRcbiAqIGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsIEQyKS4gVGhlIGVwb2NoIGlzIHdoYXQgbGV0cyB0aGUgdGFpbCBub3RpY2UgYVxuICogcmVzdGFydGVkIGRhZW1vbiB3aG9zZSBuZXcgbG9nIGlzIGFscmVhZHkgcGFzdCB0aGUgaWQuIFZlcmlmeS1wYXNzIGZpeCA5XG4gKiBzdGlsbCBob2xkczogYC0tc2luY2UgYWJjYCB1c2VkIHRvIHBhcnNlIHRvIE5hTiwgd2hpY2ggdGhlIGxvZyByZWFkcyBhcyBcImZyb21cbiAqIHRoZSBzdGFydFwiLCBzbyBhIHR5cG8gcmVwbGF5ZWQgdGhlIHdob2xlIGJ1ZmZlciBhdCBleGl0IDAg4oCUIGl0IGlzIHJlZnVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVRhaWxTaW5jZSh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiA9PT0gbnVsbClcbiAgICBkaWUoXG4gICAgICBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhbiBldmVudCBpZCDigJQgZ2l2ZSBhbiBpbnRlZ2VyICh0aGUgaWQgb2YgdGhlIGxhc3QgbGluZSB5b3Ugc2F3KSwgb3B0aW9uYWxseSBhcyA8aWQ+QDxlcG9jaD5gLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICk7XG4gIHJldHVybiBiO1xufVxuXG4vKipcbiAqIGBmaW5kIC0tc2luY2VgIGlzIGEgREFURSwgd2hlcmUgYHRhaWwgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQg4oCUIHRoZSBmbGFnIGlzXG4gKiBzaGFyZWQsIHRoZSBtZWFuaW5nIGlzIHRoZSB2ZXJiJ3MsIGFuZCBwZG9jcyBzcGVsbHMgdGhpcyBvbmUgYC0tc2luY2VgIHRvby5cbiAqIEEgdHlwbyBtdXN0IG5vdCBzaWxlbnRseSB3aWRlbiB0aGUgc2VhcmNoLCBzbyBhIG5vbi1kYXRlIGlzIGEgdXNhZ2UgZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlRGF0ZSh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh0KSB8fCBOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZSh0KSkpXG4gICAgZGllKGBmaW5kIC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBkYXRlIOKAlCB3cml0ZSBpdCBhcyBZWVlZLU1NLUREYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHQ7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vKiogQSBub24tbmVnYXRpdmUgd2hvbGUgbnVtYmVyIGZyb20gYSBmbGFnLCByZWZ1c2VkIHJhdGhlciB0aGFuIGNvZXJjZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb3VudCh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QodCkpIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHdob2xlIG51bWJlcmAsIFwidXNhZ2VcIik7XG4gIHJldHVybiBOdW1iZXIodCk7XG59XG5cbi8qKlxuICogQSBjb21wYXJpc29uIHNpZGU6IGEgdmVyc2lvbiwgb3IgdGhlIGZpbGUgb2YgcmVjb3JkLiBgb3JpZ2luYWxgIGlzIHNwZWxsZWRcbiAqIG91dCByYXRoZXIgdGhhbiBvZmZlcmVkIGFzIGB2MGAg4oCUIGEgemVyb3RoIHZlcnNpb24gd291bGQgcmVhZCBsaWtlIHRoZVxuICogZWFybGllc3Qgb25lLCBhbmQgdGhlIG9yaWdpbmFsIGlzIG5vdCBwYXJ0IG9mIHRoZSB2ZXJzaW9uIGxpbmUgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaWRlKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB8IFwib3JpZ2luYWxcIiB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgLy8gYHNhdmVkYCBpcyB0aGUgd29yZCB0aGUgU1VSRkFDRSB1c2VzIGZvciB0aGlzIHNpZGUgKEU0Myk7IGBvcmlnaW5hbGAgYW5kXG4gIC8vIGBmaWxlYCBrZWVwIHdvcmtpbmcgYmVjYXVzZSB0aGV5IGFyZSB3aGF0IGVhcmxpZXIgc2Vzc2lvbnMgYW5kIG5vdGVzIHNheS5cbiAgaWYgKHQgPT09IFwib3JpZ2luYWxcIiB8fCB0ID09PSBcImZpbGVcIiB8fCB0ID09PSBcInNhdmVkXCIpIHJldHVybiBcIm9yaWdpbmFsXCI7XG4gIHJldHVybiBwYXJzZVZlcnNpb24odG9rZW4sIHdoYXQpO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog4puUIFZFUklGWS1QQVNTIEZJWCA1OiBldmVyeSBwYXRoIGlzIGNoZWNrZWQgSEVSRSwgYmVmb3JlIGFueSBkYWVtb24gZXhpc3RzLlxuICogYG9wZW4gZG9jLm1kIHBpYy5wbmdgIHVzZWQgdG8gc3Bhd24gYSBzZXNzaW9uLCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBwYXRoXG4gKiBpbnNpZGUgaXQg4oCUIGxlYXZpbmcgYSBydW5uaW5nIGRhZW1vbiBhbmQgYSBsaXZlIHBvaW50ZXIgYmVoaW5kIGEgZmFpbGVkXG4gKiBjb21tYW5kLiBBIGZvbGRlciBvciBhIGRvY3VtZW50IGlzIGFjY2VwdGVkOyBhIG1pc3NpbmcgcGF0aCBpcyBub3RfZm91bmQsIGFcbiAqIG5vbi1kb2N1bWVudCBmaWxlIGlzIHVzYWdlIHdpdGggdGhlIGFjY2VwdGVkIGV4dGVuc2lvbnMgYXMgYGNob2ljZXNgLlxuICovXG5mdW5jdGlvbiBjb250ZXh0UGF0aHMocG9zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcGF0aHMgPSBwb3MubWFwKChwKSA9PiByZXNvbHZlKHApKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG4gICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgdHJ5IHtcbiAgICAgIHN0ID0gc3RhdFN5bmMocCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBkaWUoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7cH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICB9XG4gICAgaWYgKCFzdC5pc0RpcmVjdG9yeSgpICYmICFpc0RvY05hbWUocCkpXG4gICAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke3B9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwiYWRkIGEgZm9sZGVyLCBvciBhIGZpbGUgd2l0aCBvbmUgb2YgdGhlc2UgZXh0ZW5zaW9uc1wiLFxuICAgICAgICBjaG9pY2VzOiBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIHBhdGhzO1xufVxuXG4vKipcbiAqIGAtLWRvY2AgYXMgdGhlIENMSSdzIGNhbGxlciBtZWFudCBpdCAodmVyaWZ5LXBhc3MgZml4IDgpOiBhIHRva2VuIHdpdGggYSBwYXRoXG4gKiBzZXBhcmF0b3IsIG9yIG9uZSBuYW1pbmcgYSBmaWxlIGluIFRISVMgcHJvY2VzcydzIGN3ZCwgaXMgcmVzb2x2ZWQgaGVyZSB0byBhblxuICogYWJzb2x1dGUgcGF0aCDigJQgdGhlIGRhZW1vbidzIGN3ZCBpcyBub3QgdGhlIGNhbGxlcidzLiBBbnl0aGluZyBlbHNlIChhIHNsdWcsXG4gKiBhIHVuaXF1ZSBmaWxlIG5hbWUpIGdvZXMgYXMgdHlwZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NBcmcodG9rZW46IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0b2tlbi5pbmNsdWRlcyhcIi9cIikgfHwgZXhpc3RzU3luYyhyZXNvbHZlKHRva2VuKSkpIHJldHVybiByZXNvbHZlKHRva2VuKTtcbiAgcmV0dXJuIHRva2VuO1xufVxuXG4vKiogS2VlcCB0aGUgbmV3ZXN0IGBMT0dfS0VFUCAtIDFgIGRhZW1vbiBsb2dzLCBzbyB0aGUgb25lIGFib3V0IHRvIGJlIHdyaXR0ZW4gbWFrZXMgYExPR19LRUVQYC4gKi9cbmNvbnN0IExPR19LRUVQID0gMTA7XG5mdW5jdGlvbiBwcnVuZUxvZ3MobG9nRGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgbGV0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIG5hbWVzID0gcmVhZGRpclN5bmMobG9nRGlyKS5maWx0ZXIoKG4pID0+IC9eZGFlbW9uLVxcZCstXFxkK1xcLmxvZyQvLnRlc3QobikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYnlBZ2UgPSBuYW1lcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoYS5zcGxpdChcIi1cIilbMV0pIC0gTnVtYmVyKGIuc3BsaXQoXCItXCIpWzFdKSk7XG4gIGZvciAoY29uc3QgbiBvZiBieUFnZS5zbGljZSgwLCBNYXRoLm1heCgwLCBieUFnZS5sZW5ndGggLSAoTE9HX0tFRVAgLSAxKSkpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoam9pbihsb2dEaXIsIG4pKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuXG4gIGlmICh0eXBlb2YgZmxhZ3MucmVzdG9yZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgICBjb25zdCBtYW5pZmVzdCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBmbGFncy5yZXN0b3JlLCBcIm1hbmlmZXN0Lmpzb25cIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKG1hbmlmZXN0KSkge1xuICAgICAgbGV0IHNhdmVkOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgdHJ5IHtcbiAgICAgICAgc2F2ZWQgPSAoXG4gICAgICAgICAgYXdhaXQgQXJyYXkuZnJvbUFzeW5jKG5ldyBCdW4uR2xvYihcIiovbWFuaWZlc3QuanNvblwiKS5zY2FuKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkpXG4gICAgICAgICkubWFwKChwKSA9PiBwLnNwbGl0KFwiL1wiKVswXSBhcyBzdHJpbmcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vIHNlc3Npb25zIGZvbGRlcjogdGhlIHNldCBpcyBlbXB0eSwgYW5kIHNheXMgc28gKi9cbiAgICAgIH1cbiAgICAgIGRpZShgbm8gc2F2ZWQgc2Vzc2lvbiBcIiR7ZmxhZ3MucmVzdG9yZX1cIiB1bmRlciAke2hvbWV9YCwgXCJub3RfZm91bmRcIiwge1xuICAgICAgICBjaG9pY2VzOiBzYXZlZC5zb3J0KCksXG4gICAgICAgIC4uLihzYXZlZC5sZW5ndGggPT09IDAgPyB7IGhpbnQ6IFwibm8gc2F2ZWQgc2Vzc2lvbnMgaW4gdGhpcyBob21lXCIgfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCBsaXZlID0gcmVhZFNlc3Npb24oZmxhZ3MucmVzdG9yZSk7XG4gICAgaWYgKGxpdmUpIHtcbiAgICAgIGNvbnN0IGFsaXZlID0gYXdhaXQgYXBpKGxpdmUucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIikudGhlbihcbiAgICAgICAgKHIpID0+IHIuc3RhdHVzID09PSAyMDAsXG4gICAgICAgICgpID0+IGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGlmIChhbGl2ZSlcbiAgICAgICAgZGllKGBzZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX0gaXMgYWxyZWFkeSBydW5uaW5nIGF0ICR7bGl2ZS51cmx9YCwgXCJjb25mbGljdFwiLCB7XG4gICAgICAgICAgaGludDogYHVzZSBpdDogY2xpLnRzIHN0YXRlIC0tc2Vzc2lvbiAke2ZsYWdzLnJlc3RvcmV9YCxcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZGFlbW9uQXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKHR5cGVvZiBmbGFncy50aW1lb3V0ID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MucmVzdG9yZSA9PT0gXCJzdHJpbmdcIikgZGFlbW9uQXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIGZsYWdzLnJlc3RvcmUpO1xuICAvLyBFMjM6IGEgbmV3IHNlc3Npb24ncyB3b3Jrc3BhY2UgaXMgd2hlcmUgYG9wZW5gIHJhbi4gQSByZXN0b3JlZCBvbmUga2VlcHMgaXRzIG93bi5cbiAgZWxzZSBkYWVtb25BcmdzLnB1c2goXCItLXdvcmtzcGFjZVwiLCBwcm9jZXNzLmN3ZCgpKTtcblxuICBjb25zdCBjd2QgPSBkYWVtb25Dd2QoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGN3ZCkpXG4gICAgZGllKFxuICAgICAgYHNjcmlwdG9yaXVtIGNhbm5vdCBzdGFydCBpdHMgZGFlbW9uOiB0aGUgd29ya2luZyBkaXJlY3RvcnkgaXQgbmVlZHMgaXMgbWlzc2luZyDigJQgJHtjd2R9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogXCJkZXYgbW9kZSB3YXMgcmVzb2x2ZWQgKG5vIGRpc3QvaW5kZXguaHRtbCBhbmQgbm8gU1BFTExCT09LX1NVUkZBQ0VfTU9ERT1yZWxlYXNlKSwgd2hpY2ggbmVlZHMgc3JjL3NjcmlwdG9yaXVtLyDigJQgcmVpbnN0YWxsIHRoZSBzcGVsbCBvciBidWlsZCBpdFwiLFxuICAgICAgfSxcbiAgICApO1xuICAvLyBUaGUgZGFlbW9uJ3Mgc3RkZXJyIGdvZXMgdG8gYSBMT0cgRklMRSwgbm90IHRvIHRoaXMgQ0xJJ3Mgc3RkZXJyLiBBblxuICAvLyBpbmhlcml0ZWQgc3RkZXJyIG91dGxpdmVzIHRoZSBDTEkgaW5zaWRlIHRoZSBkZXRhY2hlZCBkYWVtb24sIHNvIGFueSBjYWxsZXJcbiAgLy8gdGhhdCByZWFkcyBgb3BlbmAncyBzdGRlcnIgdG8gRU9GIChhIHRlc3QgaGFybmVzcywgYSB0b29sIHJ1bm5lcikgd2FpdHMgZm9yXG4gIC8vIHRoZSB3aG9sZSBzZXNzaW9uIOKAlCBtZWFzdXJlZDogdGhlIGludGVncmF0aW9uIGNlbGwgaHVuZyBhdCBpdHMgNjAgcyB0aW1lb3V0LlxuICAvLyBBIGZpbGUgaG9sZHMgbm8gcGlwZSwgYW5kIGEgc3RhcnQgZmFpbHVyZSBiZWxvdyBxdW90ZXMgaXRzIHRhaWwuXG4gIGNvbnN0IGxvZ0RpciA9IGpvaW4oc2NyaXB0b3JpdW1Ib21lKCksIFwibG9nc1wiKTtcbiAgbWtkaXJTeW5jKGxvZ0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiB0aGUgbG9ncyB1c2VkIHRvIHBpbGUgdXAsIG9uZSBwZXIgYG9wZW5gLCBmb3JldmVyLlxuICBwcnVuZUxvZ3MobG9nRGlyKTtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4obG9nRGlyLCBgZGFlbW9uLSR7RGF0ZS5ub3coKX0tJHtwcm9jZXNzLnBpZH0ubG9nYCk7XG4gIGRhZW1vbkFyZ3MucHVzaChcIi0tbG9nXCIsIGxvZ1BhdGgpO1xuICBjb25zdCBsb2dGZCA9IG9wZW5TeW5jKGxvZ1BhdGgsIFwiYVwiKTtcbiAgY29uc3QgY2hpbGQgPSBzcGF3bihcImJ1blwiLCBkYWVtb25BcmdzLCB7XG4gICAgY3dkLFxuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIGxvZ0ZkXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICB9KTtcbiAgY2xvc2VTeW5jKGxvZ0ZkKTtcbiAgY2hpbGQudW5yZWYoKTtcblxuICBjb25zdCBzdGFydFRpbWVvdXRNcyA9XG4gICAgdHlwZW9mIGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBNYXRoLm1heCg1MDAwLCBOdW1iZXIucGFyc2VJbnQoZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdLCAxMCkgKiAxMDAwKVxuICAgICAgOiA0NTAwMDtcbiAgY29uc3QgbGluZSA9IGF3YWl0IG5ldyBQcm9taXNlPHN0cmluZz4oKHJlcywgcmVqKSA9PiB7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KFxuICAgICAgKCkgPT5cbiAgICAgICAgcmVqKFxuICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBkYWVtb24gc3RhcnQgdGltZW91dCAoJHtzdGFydFRpbWVvdXRNcyAvIDEwMDB9cykg4oCUIHBhc3MgLS1zdGFydC10aW1lb3V0IDxzZWNvbmRzPmAsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgIHN0YXJ0VGltZW91dE1zLFxuICAgICk7XG4gICAgY2hpbGQuc3Rkb3V0Py5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IHtcbiAgICAgIGJ1ZiArPSBjaHVuay50b1N0cmluZygpO1xuICAgICAgY29uc3QgbmwgPSBidWYuaW5kZXhPZihcIlxcblwiKTtcbiAgICAgIGlmIChubCA+PSAwKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHJlcyhidWYuc2xpY2UoMCwgbmwpLnRyaW0oKSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJlcnJvclwiLCAoZXJyKSA9PiB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgcmVqKGVycik7XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJleGl0XCIsIChjb2RlKSA9PiB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgcmVqKG5ldyBFcnJvcihgZGFlbW9uIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfSBiZWZvcmUgaXRzIGhhbmRzaGFrZWApKTtcbiAgICB9KTtcbiAgfSkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICAgIGxldCB0YWlsID0gXCJcIjtcbiAgICB0cnkge1xuICAgICAgdGFpbCA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0ZjhcIikudHJpbSgpLnNsaWNlKC04MDApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gbG9nIHdyaXR0ZW4gKi9cbiAgICB9XG4gICAgZGllKFxuICAgICAgYHNjcmlwdG9yaXVtIGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgICB7IGhpbnQ6IHRhaWwgPyBgZGFlbW9uIGxvZyAoJHtsb2dQYXRofSk6ICR7dGFpbH1gIDogYGRhZW1vbiBsb2c6ICR7bG9nUGF0aH1gIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gUmVsZWFzZSB0aGUgZGFlbW9uJ3Mgc3Rkb3V0IHBpcGUsIG9yIHRoaXMgQ0xJJ3MgbmF0dXJhbCByZXR1cm4gd2FpdHMgb24gYVxuICAvLyBzdHJlYW0gdGhhdCBuZXZlciBjbG9zZXMgKGdsYW1vdXIgbWVhc3VyZWQgOTEgcyDihpIgMSBzKS4gQ2hlY2tlZCBmb3IgdGhlXG4gIC8vIE1FVEhPRDogdW5kZXIgQnVuIHRoaXMgcGlwZSBpcyBhIHBsYWluIFJlYWRhYmxlIHRoYXQgbm9uZXRoZWxlc3MgaGFzIHVucmVmLlxuICBjb25zdCBvdXQgPSBjaGlsZC5zdGRvdXQ7XG4gIGlmICghb3V0IHx8ICEoXCJ1bnJlZlwiIGluIG91dCkgfHwgdHlwZW9mIG91dC51bnJlZiAhPT0gXCJmdW5jdGlvblwiKVxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwic2NyaXB0b3JpdW06IHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSBoYXMgbm8gdW5yZWYoKTsgYG9wZW5gIHdvdWxkIG5ldmVyIGV4aXRcIixcbiAgICApO1xuICBvdXQudW5yZWYoKTtcblxuICBsZXQgaHM6IHtcbiAgICB1cmw6IHN0cmluZztcbiAgICBwb3J0OiBudW1iZXI7XG4gICAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICAgIG9rPzogYm9vbGVhbjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gIH07XG4gIHRyeSB7XG4gICAgaHMgPSBKU09OLnBhcnNlKGxpbmUpO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHVuZXhwZWN0ZWQgb3V0cHV0IGZyb20gZGFlbW9uOiAke2xpbmV9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuICBpZiAoaHMub2sgPT09IGZhbHNlKSBkYWVtb25SZWZ1c2VkKFwib3BlblwiLCBocy5zdGF0dXMgPz8gNTAwLCBocyk7XG5cbiAgbGV0IGVudHJpZXM6IHVua25vd25bXSA9IFtdO1xuICBpZiAocGF0aHMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHIgPSBhd2FpdCBwb3N0Q21kKGhzLnNlc3Npb25faWQsIHsgdHlwZTogXCJjb250ZXh0LmFkZFwiLCBwYXRocyB9KTtcbiAgICBlbnRyaWVzID0gKHIuZW50cmllcyBhcyB1bmtub3duW10pID8/IFtdO1xuICB9XG4gIHByaW50SnNvbih7IC4uLmhzLCAuLi4ocGF0aHMubGVuZ3RoID4gMCA/IHsgZW50cmllcyB9IDoge30pIH0pO1xuXG4gIGlmICghZmxhZ3NbXCJuby1vcGVuXCJdKSB7XG4gICAgY29uc3Qgb3BlbmVyID1cbiAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgICBzcGF3bihvcGVuZXIsIFtocy51cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFkZChwb3M6IHN0cmluZ1tdLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgY29uc3QgcGF0aHMgPSBjb250ZXh0UGF0aHMocG9zKTtcbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmdWxsOiBib29sZWFuKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIGAvc3RhdGUke2Z1bGwgPyBcIj9mdWxsPTFcIiA6IFwiXCJ9YCk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcInN0YXRlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFNheUJvZHkoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHNvdXJjZXMgPSBbXG4gICAgcG9zLmxlbmd0aCA+IDAsXG4gICAgZmxhZ3Muc3RkaW4gPT09IHRydWUsXG4gICAgdHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiLFxuICBdLmZpbHRlcihCb29sZWFuKS5sZW5ndGg7XG4gIGlmIChzb3VyY2VzICE9PSAxKVxuICAgIGRpZShcbiAgICAgIHNvdXJjZXMgPT09IDBcbiAgICAgICAgPyBcInNheSBuZWVkcyBhIG1lc3NhZ2VcIlxuICAgICAgICA6IFwic2F5IHRha2VzIGl0cyBtZXNzYWdlIGZyb20gZXhhY3RseSBvbmUgcGxhY2U6IGFyZ3VtZW50cywgLS1zdGRpbiBvciAtLWJvZHktZmlsZVwiLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImdpdmUgdGhlIHRleHQgYXMgYXJndW1lbnRzLCBvciBwcm9zZSB0aHJvdWdoIC0tYm9keS1maWxlIDxwYXRoPiAvIC0tc3RkaW4gKG5ldmVyIGFuIHVucXVvdGVkIGhlcmVkb2MpXCIsXG4gICAgICAgIGNob2ljZXM6IFtcIi0tc3RkaW5cIiwgXCItLWJvZHktZmlsZVwiXSxcbiAgICAgIH0sXG4gICAgKTtcbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgaWYgKGZsYWdzLnN0ZGluID09PSB0cnVlKSB0ZXh0ID0gYXdhaXQgbmV3IFJlc3BvbnNlKEJ1bi5zdGRpbi5zdHJlYW0oKSkudGV4dCgpO1xuICBlbHNlIGlmICh0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIpIHRleHQgPSByZWFkRmlsZVN5bmMoZmxhZ3NbXCJib2R5LWZpbGVcIl0sIFwidXRmOFwiKTtcbiAgZWxzZSB0ZXh0ID0gcG9zLmpvaW4oXCIgXCIpO1xuICBpZiAoIXRleHQudHJpbSgpKSBkaWUoXCJzYXk6IHRoZSBtZXNzYWdlIGlzIGVtcHR5XCIsIFwidXNhZ2VcIik7XG4gIHJldHVybiB0ZXh0LnRyaW0oKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRoZSB0YWlsIGhhcyBhbHJlYWR5IHJlcG9ydGVkIHRoYXQgaXQgbG9zdCB0aGUgZGFlbW9uIChFNTUpLiBNb2R1bGVcbiAqIHNjb3BlIGJlY2F1c2UgYSB0YWlsIGlzIG9uZSBwcm9jZXNzIGRvaW5nIG9uZSB0aGluZywgYW5kIHRoZSB0d28gaG9va3MgdGhhdFxuICogcmVhZCBpdCBhcmUgaGFuZGVkIHRvIGEgY2xpZW50IHRoYXQgb3ducyBpdHMgb3duIGxvb3AuXG4gKi9cbmxldCBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcblxuLyoqXG4gKiBUaGUgd2F0Y2guIEVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgY2FwIHdpdGggb25lIGxpbmUgbmFtaW5nIHRoZSBuZXh0XG4gKiBhY3QgKGBzcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgKTogcmUtYXJtIE1vbml0b3IsIGdvIHRvIGEgYmFja2dyb3VuZFxuICogYC0tb25jZWAsIG9yIGNvbWUgYmFjayBmcm9tIGEgY2xvc2VkIG9yIGxvc3Qgc2Vzc2lvbiB3aXRoIGBvcGVuIC0tcmVzdG9yZWAuXG4gKiBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOiB0aGUgYWdlbnQgYWxyZWFkeSBrbm93cyB0aGVcbiAqIHNlc3Npb24sIGFuZCB0aGUgbGluZSB3b3VsZCBjb3VudCBhcyBub2lzZSBpbiB0aGUgd2luZG93J3Mgd2FrZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICBvOiB7IG9uY2U6IGJvb2xlYW47IHNpbmNlR2l2ZW46IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGNvbnN0IHJlQXJtID0gc2Vzc2lvbiAhPT0gdW5kZWZpbmVkIHx8IG8uc2luY2VHaXZlbjtcbiAgbGV0IGdyb3VuZGVkID0gby5zaW5jZUdpdmVuO1xuICBjb25zdCBwaW4gPSAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gW1wiLS1zZXNzaW9uXCIsIGJvdW5kSWRdIDogW10pO1xuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0+KFxuICAgIHtcbiAgICAgIHJlc29sdmU6ICgpID0+IHtcbiAgICAgICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgICBpZiAoIWJvdW5kSWQpIGJvdW5kSWQgPSBzLnNlc3Npb25faWQ7XG4gICAgICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZ3JvdW5kaW5nXCIsIHNlc3Npb25faWQ6IHMuc2Vzc2lvbl9pZCwgcG9ydDogcy5wb3J0IH0pfVxcbmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYGh0dHA6Ly8xMjcuMC4wLjE6JHtzLnBvcnR9YDtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6ICh7IGV2ZXJSZXNvbHZlZCB9KSA9PiB7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgZ2l2ZW4gLS1zZXNzaW9uIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HXG4gICAgICAgIC8vIHNlc3Npb24sIHNvIG5vdCBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZCAoaW4gdGhlIGdhcCwgc2F5KSDigJQgdGhlXG4gICAgICAgIC8vIGhhbmRvZmYgc2F5cyBgdGFpbC5jbG9zZWRgLCBuZXZlciBhIHNpbGVudCByZXRyeS1mb3JldmVyLlxuICAgICAgICBpZiAoZXZlclJlc29sdmVkIHx8IHJlQXJtKSByZXR1cm4gXCJzdG9wXCI7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZSxcbiAgICAgIC4uLihvLmVwb2NoID8geyBzaW5jZUVwb2NoOiBvLmVwb2NoIH0gOiB7fSksXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgICAgZXBvY2hPZjogKGV2KSA9PiAodHlwZW9mIGV2LmVwb2NoID09PSBcInN0cmluZ1wiID8gZXYuZXBvY2ggOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSBkaWZmZXJlbnQgZXBvY2ggb24gcmVjb25uZWN0ID0gdGhlIGRhZW1vbiByZXN0YXJ0ZWQ7IGlkcyBiZWdhbiBhZ2Fpbi5cbiAgICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgICB0ZXJtaW5hbDogKGV2KSA9PiBldi50eXBlID09PSBcImNsb3NlZFwiLFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgICAvLyDim5QgQSBLRUVQQUxJVkUgSVMgUFJPT0YgT0YgTElGRSwgc28gaXQgaXMgYWxzbyB3aGF0IGNsZWFycyBhIHJlcG9ydGVkXG4gICAgICAvLyBkaXNjb25uZWN0aW9uLiBUaGVyZSBpcyBubyBgb25Db25uZWN0YCBob29rIGFuZCB0aGlzIGlzIHRoZSBob25lc3RcbiAgICAgIC8vIHN1YnN0aXR1dGU6IHRoZSBkYWVtb24gb25seSBzZW5kcyBjb21tZW50cyBkb3duIGEgbGl2ZSBzdHJlYW0uXG4gICAgICBvbkNvbW1lbnQ6ICgpID0+IHtcbiAgICAgICAgaWYgKCFkaXNjb25uZWN0ZWQpIHJldHVybiBcIjogc2NyaXB0b3JpdW0ta2VlcGFsaXZlXCI7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInRhaWwucmVjb25uZWN0ZWRcIiB9KTtcbiAgICAgIH0sXG4gICAgICAvLyDim5QgT05FIExJTkUgUEVSIEVQSVNPREUsIE5PVCBQRVIgQVRURU1QVC4gVGhlIGNsaWVudCByZWNvbm5lY3RzIHdpdGhcbiAgICAgIC8vIGJhY2tvZmYgZm9yZXZlciwgc28gYSBob29rIHRoYXQgc3Bva2UgZXZlcnkgdGltZSB3b3VsZCBlbWl0IGEgbGluZSBldmVyeVxuICAgICAgLy8gZmV3IHNlY29uZHMgZm9yIGFzIGxvbmcgYXMgdGhlIGRhZW1vbiBzdGF5ZWQgZG93biDigJQgd2hpY2ggaXMgaG93IGFcbiAgICAgIC8vIHdhdGNoZXIgZ2V0cyBtdXRlZCwgYW5kIHRoZW4gbm9ib2R5IGhlYXJzIHRoZSBuZXh0IHJlYWwgdGhpbmcuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIFdIWSBUSElTIEVYSVNUUyBBVCBBTEw6IHdpdGhvdXQgaXQgYSBERUFEIGRhZW1vbiBhbmQgYSBRVUlFVCBvbmUgYXJlXG4gICAgICAvLyB0aGUgc2FtZSB0aGluZyBmcm9tIG91dCBoZXJlLiBBIGdyYWNlZnVsIGNsb3NlIGVtaXRzIGBjbG9zZWRgIGFuZCBlbmRzXG4gICAgICAvLyB0aGUgdGFpbDsgYSBjcmFzaCwgYSBraWxsIC05IG9yIGEgc2xlZXBpbmcgbGFwdG9wIGVtaXRzIG5vdGhpbmcsIHRoZVxuICAgICAgLy8gY2xpZW50IHJldHJpZXMgaW4gc2lsZW5jZSwgYW5kIHRoZSBhYnNlbmNlIG9mIGV2ZW50cyBpcyBub3QgYW4gZXZlbnQuIEFcbiAgICAgIC8vIHdhdGNoZXIgd2FpdGluZyBmb3IgdGhlIGh1bWFuJ3MgbmV4dCBtZXNzYWdlIHdvdWxkIHdhaXQgZm9yZXZlciBhbmRcbiAgICAgIC8vIG5ldmVyIGxlYXJuIGl0IGhhZCBzdG9wcGVkIGxpc3RlbmluZy4gKEZvdW5kIDIwMjYtMDktMTQgd2hpbGUgYW5zd2VyaW5nXG4gICAgICAvLyBDb2xlJ3MgcXVlc3Rpb24gYWJvdXQgd2hldGhlciBhIHRpbWVvdXQgd291bGQgbm90aWZ5IG1lLiBJdCB3b3VsZCBub3QuKVxuICAgICAgb25EaXNjb25uZWN0OiAoeyBjYXVzZSwgc3RhdHVzIH0pID0+IHtcbiAgICAgICAgaWYgKGRpc2Nvbm5lY3RlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLmRpc2Nvbm5lY3RlZFwiLFxuICAgICAgICAgIGNhdXNlLFxuICAgICAgICAgIC4uLihzdGF0dXMgIT09IHVuZGVmaW5lZCA/IHsgc3RhdHVzIH0gOiB7fSksXG4gICAgICAgICAgbm90ZTogXCJyZXRyeWluZzsgdGhlIHNlc3Npb24gbWF5IGhhdmUgY2xvc2VkIG9yIGNyYXNoZWRcIixcbiAgICAgICAgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbW9kZTogby5vbmNlID8gXCJvbmNlXCIgOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogZmFsc2UsXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQsIG9uY2UsIGVwb2NoIH0pID0+XG4gICAgICAgICAgdGFpbENvbW1hbmQoWy4uLnNlbGZDb21tYW5kKCksIFwidGFpbFwiLCAuLi5waW4oKV0sIGF0LCBvbmNlLCBlcG9jaCksXG4gICAgICAgIGNvbWVCYWNrOiAoKSA9PlxuICAgICAgICAgIGNvbW1hbmRMaW5lKFsuLi5zZWxmQ29tbWFuZCgpLCBcIm9wZW5cIiwgXCItLXJlc3RvcmVcIiwgYm91bmRJZCA/PyBcIjxpZD5cIiwgXCItLW5vLW9wZW5cIl0pLFxuICAgICAgfSxcbiAgICB9LFxuICApO1xufVxuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKFNLSUxMX1JPT1QsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIiksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwic2NyaXB0b3JpdW1cIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoICovXG4gIH1cbiAgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vKipcbiAqIEUyNCdzIHZlcmJzOiB0aGUgYWdlbnQncyBoYWxmIG9mIHRoZSBzdHJ1Y3R1cmUgb3BzIHRoZSBodW1hbiByZWFjaGVzIGJ5IG1lbnVzXG4gKiBhbmQgZHJhZyBhbmQgZHJvcC4gRWFjaCByZXNvbHZlcyBpdHMgcGF0aHMgYWdhaW5zdCBUSElTIHByb2Nlc3MncyBjd2QgYW5kXG4gKiBwb3N0cyBvbmUgb3A7IHRoZSBkYWVtb24gZG9lcyB0aGUgY2hhbmdlIGFuZCBhbm5vdW5jZXMgaXQgaW4gdGhlIGNoYXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0cnVjdHVyZUNtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCBvcCkpO1xufVxuXG4vKiogYGltcG9ydCA8ZmlsZT5gOiB0aGUgZmlsZSdzIFRFWFQgaXMgc2VudCwgc28gdGhlIGRhZW1vbiB3cml0ZXMgYSBjb3B5IChFMjMpLiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kSW1wb3J0KGZpbGU6IHN0cmluZywgaW50bzogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgY29uc3QgYWJzID0gcmVzb2x2ZShmaWxlKTtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYG5vIHN1Y2ggZmlsZTogJHthYnN9YCwgXCJub3RfZm91bmRcIik7XG4gIH1cbiAgaWYgKCFzdC5pc0ZpbGUoKSB8fCAhaXNEb2NOYW1lKGFicykpXG4gICAgZGllKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXM6IFsuLi5ET0NfRVhURU5TSU9OU10gfSk7XG4gIGF3YWl0IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7XG4gICAgdHlwZTogXCJpbXBvcnRcIixcbiAgICBuYW1lOiBhYnMuc3BsaXQoXCIvXCIpLnBvcCgpIGFzIHN0cmluZyxcbiAgICB0ZXh0OiByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIiksXG4gICAgLi4uKGludG8gIT09IHVuZGVmaW5lZCA/IHsgaW50bzogcmVzb2x2ZShpbnRvKSB9IDoge30pLFxuICB9KTtcbn1cblxuLyoqIGB3b3Jrc3BhY2VgIGFsb25lIHByaW50cyBpdDsgYHdvcmtzcGFjZSA8ZGlyPmAgc2V0cyBpdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFdvcmtzcGFjZShkaXI6IHN0cmluZyB8IHVuZGVmaW5lZCwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmIChkaXIgIT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJ3b3Jrc3BhY2Uuc2V0XCIsIHBhdGg6IHJlc29sdmUoZGlyKSB9KTtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIik7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcIndvcmtzcGFjZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oeyB3b3Jrc3BhY2U6IChkYXRhIGFzIHsgd29ya3NwYWNlPzogdW5rbm93biB9KS53b3Jrc3BhY2UgfSk7XG59XG5cbi8vIOKUgOKUgCBUSEUgQ09NTUFORCBUQUJMRSDigJQgZGlzcGF0Y2gsIGhlbHAsIGBzY2hlbWFgIGFuZCBldmVyeSBgY2hvaWNlc2Agd2FsayBpdCDilIDilIBcblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xudHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG50eXBlIENvbW1hbmRTcGVjID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGZsYWdzOiByZWFkb25seSBGbGFnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICBkZXNjcmliZTogc3RyaW5nO1xuICBydW46IChcbiAgICBwb3M6IHN0cmluZ1tdLFxuICAgIGZsYWdzOiBGbGFncyxcbiAgICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICkgPT4gUHJvbWlzZTxudW1iZXI+IHwgUHJvbWlzZTx2b2lkPiB8IHZvaWQ7XG59O1xuXG5jb25zdCBTRVNTSU9OID0gW1wic2Vzc2lvblwiXSBhcyBjb25zdCBzYXRpc2ZpZXMgcmVhZG9ubHkgRmxhZ1tdO1xuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJuby1vcGVuXCIsIFwicmVzdG9yZVwiLCBcInRpbWVvdXRcIiwgXCJzdGFydC10aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic3Bhd24gYSBzZXNzaW9uIChvcGVucyB0aGUgYnJvd3NlciksIGFkZGluZyBwYXRoczsgcHJpbnRzIHt1cmwsIHBvcnQsIHNlc3Npb25faWR9LiAtLXRpbWVvdXQgPHNlY29uZHM+IHNldHMgdGhlIGlkbGUgY2xvc2UgKGRlZmF1bHQgMTgwMCk7IC0tdGltZW91dCAwIHN0YW5kcyB1bnRpbCBjbG9zZWRcIixcbiAgICBydW46IChwb3MsIGZsYWdzKSA9PiBjbWRPcGVuKHBvcywgZmxhZ3MpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhZGRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJhZGQgZmlsZXMgb3IgZm9sZGVycyB0byB0aGUgY29udGV4dCBsaXN0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZEFkZChwb3MsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmdWxsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJ0aGUgc2Vzc2lvbjogY29udGV4dCwgZG9jcyArIHZlcnNpb25zICh3aXRoIHBhdGhzKSwgYWN0aXZlLCBkaXJ0eSwgc2VsZWN0aW9uXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInNpbmNlXCIsIFwib25jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInRoZSBodW1hbidzIG1lc3NhZ2VzICh3aXRoIHNlbGVjdGlvbiArIGFjdGl2ZSBwYXRoKSBhcyBKU09OIGxpbmVzIOKAlCB3cmFwIHdpdGggTW9uaXRvcjsgaXRzIGxhc3QgbGluZSBuYW1lcyB0aGUgbmV4dCBhY3RcIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYiA9IHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlVGFpbFNpbmNlKGZsYWdzLnNpbmNlKSA6IHsgc2luY2U6IC0xIH07XG4gICAgICByZXR1cm4gY21kVGFpbChzZXNzaW9uLCBiLnNpbmNlLCB7XG4gICAgICAgIG9uY2U6IGZsYWdzLm9uY2UgPT09IHRydWUsXG4gICAgICAgIHNpbmNlR2l2ZW46IHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIixcbiAgICAgICAgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLW5ld1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJmcm9tXCIsIFwibGFiZWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImNvcHkgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgdG8gYSBuZXcgZmlsZTsgcHJpbnRzIGl0cyBwYXRoIHRvIGVkaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHR5cGVvZiBmbGFncy5mcm9tID09PSBcInN0cmluZ1wiID8gcGFyc2VWZXJzaW9uKGZsYWdzLmZyb20sIFwiLS1mcm9tXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24ubmV3XCIsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgICAuLi4oZnJvbSAhPT0gdW5kZWZpbmVkID8geyBmcm9tIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIiA/IHsgbGFiZWw6IGZsYWdzLmxhYmVsIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLWRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgdmVyc2lvbiBhbmQgaXRzIGZpbGUgKG5ldmVyIHRoZSBhY3RpdmUgb25lIOKAlCBhY3RpdmF0ZSBhbm90aGVyIGZpcnN0KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJ2ZXJzaW9uLWRlbGV0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBoYXZlIHN0YXJ0ZWQgc29tZXRoaW5nOyBwcmludHMgdGhlIGlkIHRvIGZpbmlzaCBpdCB3aXRoXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnN0YXJ0XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXN0YXR1c1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJzdGF0dXNcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzYXkgd2hhdCBzdGVwIGEgdGFzayBpcyBvbiAoZm9yIHdvcmsgd29ydGggd2F0Y2hpbmcpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ0YXNrLnN0YXR1c1wiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHN0YXR1czogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1kb25lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcIm91dGNvbWVcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibWFyayBhIHRhc2sgZmluaXNoZWQsIG9wdGlvbmFsbHkgc2F5aW5nIHdoYXQgY2FtZSBvZiBpdFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBvdXRjb21lID0gcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICAuLi4ob3V0Y29tZSA/IHsgb3V0Y29tZSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1yZW1vdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJmb3JnZXQgYSB0YXNrIGVudGlyZWx5IOKAlCBmb3Igb25lIHN0YXJ0ZWQgYnkgbWlzdGFrZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5yZW1vdmVcIiwgaWQ6IHBvc1swXSBhcyBzdHJpbmcgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2tzLWNsZWFyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBldmVyeSBmaW5pc2hlZCB0YXNrOyBvdXRzdGFuZGluZyBvbmVzIGFyZSBsZWZ0IGFsb25lXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFza3MuY2xlYXJcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid29ya2luZ1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmb3JcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInNheSB5b3UgYXJlIHN0aWxsIG9uIGl0IOKAlCBzaWxlbmNlcyB0aGUgd2FpdGluZyBudWRnZSwga2VlcHMgdGhlIGh1bWFuJ3MgcHVsc2VcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3Qgc2Vjb25kcyA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5mb3IgPT09IFwic3RyaW5nXCIgPyBwYXJzZUNvdW50KGZsYWdzLmZvciwgXCJ3b3JraW5nIC0tZm9yXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIndvcmtpbmdcIixcbiAgICAgICAgICAuLi4oc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8geyBzZWNvbmRzIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInF1b3RlXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJub3RlIGEgcGFzc2FnZSBvZiB0aGUgYWN0aXZlIHZlcnNpb24gKC0tcXVvdGUgJ2V4YWN0IHRleHQnOyBwcm9zZTogLS1ib2R5LWZpbGUgb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLnF1b3RlICE9PSBcInN0cmluZ1wiIHx8IGZsYWdzLnF1b3RlLnRyaW0oKSA9PT0gXCJcIilcbiAgICAgICAgZGllKFwibm90ZTogLS1xdW90ZSBpcyByZXF1aXJlZCDigJQgdGhlIGV4YWN0IHRleHQgdGhlIG5vdGUgaXMgYWJvdXRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAtLWZ1bGwgKHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgaXMgb24gZGlzazsgcXVvdGUgZnJvbSBpdClcIixcbiAgICAgICAgfSk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibm90ZS5hZGRcIixcbiAgICAgICAgICBxdW90ZTogZmxhZ3MucXVvdGUsXG4gICAgICAgICAgYm9keTogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBub3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLWZ1bGwgaW5jbHVkZXMgcmVzb2x2ZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3Rlc1wiLFxuICAgICAgICAgIC4uLihmbGFncy5mdWxsID8geyBhbGw6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1lZGl0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInJld3JpdGUgd2hhdCBhIG5vdGUgc2F5cyAoaXRzIHBhc3NhZ2UgaXMgdW5jaGFuZ2VkKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmVkaXRcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3Muc2xpY2UoMSksIGZsYWdzKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1yZXNvbHZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInJlb3BlblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgbm90ZSBkZWFsdCB3aXRoICgtLXJlb3BlbiBwdXRzIGl0IGJhY2spXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVzb2x2ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHJlc29sdmVkOiAhZmxhZ3MucmVvcGVuLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgbm90ZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLnJlbW92ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdzYXZlZCcgZm9yIHRoZSBmaWxlIG9uIGRpc2spOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VhcmNoXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImxpbWl0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInF1ZXJ5XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic2VhcmNoIHRoZSBjb250ZXh0OiBmdXp6eSBvbiBuYW1lcywgZXhhY3QgaW4gdGV4dCDigJQgc2VhcmNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uIG9mIG9wZW4gZG9jdW1lbnRzLCB3aGljaCBncmVwIGNhbm5vdCBzZWVcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5saW1pdCA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MubGltaXQsIFwic2VhcmNoIC0tbGltaXRcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICAgICAgcXVlcnk6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgICAgICAuLi4obGltaXQgIT09IHVuZGVmaW5lZCA/IHsgbGltaXQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwid2hhdCBpcyB3b3J0aCBsb29raW5nIGF0IGluIHRoaXMgc2Vzc2lvbiDigJQgZWFjaCBmaW5kaW5nIG5hbWVzIHRoZSB2ZXJiIHRoYXQgZml4ZXMgaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2N0b3JcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9yZ2V0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKHJlZnVzZWQgd2hpbGUgdGhlIGZpbGUgZXhpc3RzIOKAlCB1c2UgaGlkZSB0byB0YWtlIG9uZSBvdXQgb2YgdGhlIGNvbnRleHQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJmb3JnZXRcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZGFuZ2xpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImxpbmtzIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCBmaWxlLCBsaW5lLCBhbmQgdGhlIHRhcmdldCBhcyB3cml0dGVuXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJkYW5nbGluZ1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJlbWl0IHRoaXMgQ0xJJ3MgYWNjIGRlY2xhcmF0aW9uICh3YWxrZWQgZnJvbSB0aGUgY29tbWFuZCB0YWJsZSlcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2hvdyB0aGlzIG1lc3NhZ2VcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuXTtcblxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG5jb25zdCBmaW5kQ29tbWFuZCA9ICh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQgPT5cbiAgQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbik7XG5cbi8qKiBUaGUgdmVyYiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCAoYSBzdHJpbmcgZmxhZyBjb25zdW1lcyBpdHMgdmFsdWUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmJUb2tlbihhcmd2OiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIGFyZ3ZbaSArIDFdID8/IG51bGw7XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYS5zbGljZSgyKSBhcyBGbGFnO1xuICAgICAgaWYgKGtleSBpbiBDTElfT1BUSU9OUyAmJiBDTElfT1BUSU9OU1trZXldLnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBDT01NQU5EUy5tYXAoKGMpID0+IGMubmFtZSk7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBGbGFnW10+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBDT01NQU5EUy5tYXAoKGMpID0+IFtjLm5hbWUsIGMuZmxhZ3NdKSxcbik7XG5leHBvcnQgY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgWy4uLihmaW5kQ29tbWFuZCh2ZXJiKT8uZmxhZ3MgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbmNvbnN0IHJlbmRlckZsYWcgPSAoazogRmxhZyk6IHN0cmluZyA9PlxuICBDTElfT1BUSU9OU1trXS50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZU9mKHNwZWM6IENvbW1hbmRTcGVjKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBzcGVjLm5hbWUsXG4gICAgLi4uc3BlYy5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgLi4uc3BlYy5mbGFncy5maWx0ZXIoKGspID0+IGsgIT09IFwic2Vzc2lvblwiKS5tYXAocmVuZGVyRmxhZyksXG4gIF0uam9pbihcIiBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWxwKCk6IHN0cmluZyB7XG4gIGNvbnN0IHJvd3MgPSBDT01NQU5EUy5tYXAoKGMpID0+IFt1c2FnZU9mKGMpLCBjLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ucm93cy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICBjb25zdCBib2R5ID0gcm93c1xuICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYHNjcmlwdG9yaXVtIOKAlCBhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93LlxuXG4gIE91dHB1dDogSlNPTiBvbiBzdGRvdXQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlCBleGNlcHQgdGFpbCAob25lIEpTT04gbGluZVxuICBwZXIgZXZlbnQpIGFuZCBoZWxwIChwcm9zZSkuIEZhaWx1cmVzOiBvbmUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXRcbiAgMiA9IHVzYWdlLCAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdC4gdGFpbCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIHJhdGhlciB0aGFuIGZhaWxpbmcsIGFuZCBlbmRzIDAgd2hlbiBpdHMgc2Vzc2lvbiBjbG9zZXMuIHRhaWxcbiAgJHtXSU5ET1dfSEVMUH0uYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzOiBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdIGFzIHN0cmluZ1tdLFxuICAgICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgICB9KSksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgICAgLi4uQ09NTUFORFMubWFwKChjKSA9PiAoe1xuICAgICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgICAgYXJnczogWy4uLmMuZmxhZ3NdLm1hcChhcmcpLFxuICAgICAgICBwb3NpdGlvbmFsczogYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pKSxcbiAgICBdLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIC8vIFRoZSBraXQgZG9lcyBub3QgdHJpYWdlOyB0aGlzIGRvZXMuIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICAgIC8vICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzOyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gYXJndlswXSk7XG4gIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkIHx8IGFyZ3ZbMF0gPT09IFwidmVyc2lvblwiKSB7XG4gICAgaWYgKChpbnRlcmNlcHRvcj8ucnVucyA/PyBcInZlcnNpb25cIikgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcmludEpzb24odmVyc2lvbkluZm8oKSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBsZXQgY3VycmVudENvbW1hbmQgPSB2ZXJiVG9rZW4oYXJndik7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3MoYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikgfHwgZS5leHRyYT8uY2hvaWNlcyA9PT0gdW5kZWZpbmVkKSB0aHJvdyBlO1xuICAgIGNvbnN0IHNwZWMgPSBjdXJyZW50Q29tbWFuZCA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGZpbmRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgICBpZiAoc3BlYyAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7IGhpbnQ6IGUuZXh0cmE/LmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7XG4gICAgICBoaW50OiBgbm8gdmVyYiBnaXZlbiDigJQgdmVyYnM6ICR7VkVSQlMuam9pbihcIiBcIil9IChydW46IGNsaS50cyBoZWxwKWAsXG4gICAgICBjaG9pY2VzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSksXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgW3ZlcmIsIC4uLnBvc10gPSBwYXJzZWQucG9zO1xuICBjb25zdCBmbGFncyA9IHBhcnNlZC5mbGFncztcbiAgY3VycmVudENvbW1hbmQgPSB2ZXJiID8/IG51bGw7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcblxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBbLi4uVkVSQlNdIH0pO1xuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQodmVyYik7XG4gIGlmIChzcGVjID09PSB1bmRlZmluZWQpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcblxuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KHNwZWMuZmxhZ3MpO1xuICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKGZsYWdzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFjY2VwdGVkID0gZmxhZ3NGb3Ioc3BlYy5uYW1lKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3NwZWMubmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBzY3JpcHRvcml1bSBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgYWNjZXB0ZWQubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogYWNjZXB0ZWQgfSA6IHsgaGludDogYCR7c3BlYy5uYW1lfSB0YWtlcyBubyBmbGFnc2AgfSxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1c2FnZTogJHt1c2FnZU9mKHNwZWMpfWAsIHsgaGludDogc3BlYy5kZXNjcmliZSB9KTtcblxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuICBjb25zdCBjb2RlID0gYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2JhY2tsb2cvMjAyNi0wOS0yMi1zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0yMi1tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIGFsd2F5cyBnZXRzIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsXG4gKiAgICAgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzIGNvbm5lY3Rpb24gY2Fycmllcy5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzKSwgZWFjaCBuYW1pbmcgaG93IHRvIGNvbWUgYmFja1xuICogaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmUgYVxuICogcmVhbC1kYWVtb24gY2VsbCBpbiBgc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdGFpbC1oYW5kb2ZmLmludGVncmF0aW9uLnRlc3QudHNgLlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgcHJlc2VuY2UgdGFpbCAoYXN0cm9sYWJlLCBtaW5kLW1hcHBlcilcbiAqICAgICAgICAgICAgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHkgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBhcyBwcmludGVkXG4gKiBvcGVucyBubyBicm93c2VyIHRhYi5cbiAqXG4gKiDimqAgS05PV04gRURHRSwgTk9UIEZJWEVEIChmb3VuZCBieSB0aGUgcmUtcmV2aWV3KTogYSBrZXllZCBib3VudHkgRklSU1QgYXJtXG4gKiAgIChhbiBhbnRoaWxsIHNlYXQpIHdob3NlIHdpbmRvdyBlbmRzIGJlZm9yZSBpdHMgYm9hcmQgZXZlciBvcGVucyBwcmludHMgYVxuICogICByZS1hcm0gcGlubmVkIHRvIHRoZSBkZXJpdmVkIGlkIHdpdGggYW4gZW1wdHkgYm9va21hcmtcbiAqICAgKGAtLXNlc3Npb24gay3igKYgLS1zaW5jZT0tMSAtLW9uY2VgKS4gVGhhdCByZS1hcm0gaXMgYSByZS1hcm0gYnkgRDEncyBydWxlLFxuICogICBzbyBpZiB0aGUgYm9hcmQgaXMgc3RpbGwgbm90IHVwIOKAlCB0aGUgbGVhZCBtb3JlIHRoYW4gb25lIHdpbmRvdyAoMjkgbWluKVxuICogICBsYXRlIOKAlCB0aGUgc2VhdCBnZXRzIGB0YWlsLmNsb3NlZGAgaW5zdGVhZCBvZiB3YWl0aW5nLiBNaW5vcjogdGhlXG4gKiAgIGNvbWUtYmFjayBpdCBuYW1lcyAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCkgaXMgdGhlIHJpZ2h0IG5leHQgc3RlcCBhbnl3YXkuXG4gKlxuICog4pqgIEtOT1dOIExJTUlULCBOT1QgRklYRUQ6IHRoZSBwcmludGVkIGBjb21tYW5kYCBuYW1lcyB0aGUgbGF1bmNoZXIgYnkgaXRzXG4gKiAgIGZ1bGwgcGF0aCwgd2hpY2ggZm9yIGFuIGluc3RhbGxlZCBwbHVnaW4gaW5jbHVkZXMgaXRzIFZFUlNJT05FRCBjYWNoZVxuICogICBkaXJlY3RvcnkuIEFjcm9zcyBhIHBsdWdpbiB1cGdyYWRlIGEgcmUtYXJtIGtlZXBzIHJ1bm5pbmcgdGhlIG9sZCB2ZXJzaW9uXG4gKiAgIHVudGlsIHRoZSBhZ2VudCBuZXh0IGFybXMgZnJvbSB0aGUgc2tpbGwncyBvd24gcGF0aC4gTm90ZWQsIG5vdCByZWRlc2lnbmVkLlxuICpcbiAqIOKaliBgLS1vbmNlYCBFTkRTIE9OIFRIRSBGSVJTVCBGUkFNRSwgd2l0aCBubyBkcmFpbi4gQSBidXJzdCBhcnJpdmVzIHNwbGl0OiB0aGVcbiAqICAgZmlyc3QgZXZlbnQgb24gdGhlIG9uZS1zaG90LCB0aGUgcmVzdCBvbiB0aGUgTW9uaXRvciByZS1hcm0sIHdoaWNoIGxvc2VzXG4gKiAgIG5vdGhpbmcgYmVjYXVzZSBvZiB0aGUgYm9va21hcmsuIFRoZSBzcGlrZSBvZmZlcmVkIGEgfjIwMCBtcyBkcmFpbiBhcyBhblxuICogICBvcHRpb24sIG5vdCBhIHJlcXVpcmVtZW50OyBub3QgdGFrZW4sIGJlY2F1c2UgaXQgYWRkcyBhIHRpbWVyIHRvIHRoZVxuICogICBleGl0IHBhdGggd2hvc2UgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gbWFrZSBpbXBvc3NpYmxlLlxuICog4pqWIFRIRSBMSU5FJ1MgYGNvbW1hbmRgIElTIFJVTk5BQkxFIEFTIFBSSU5URUQ6IGBidW4gPHRoaXMgY2xpJ3MgcGF0aD4g4oCmYCxcbiAqICAgcGlubmVkIHRvIHRoZSBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGVcbiAqICAgc2tpbGxzIG5hbWUgdGhlIHJ1bGUgb25jZTsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBUaGUgb25lIHNlbnRlbmNlIGV2ZXJ5IGB0YWlsYCdzIGhlbHAgY2Fycmllcywgc28gYSBodW1hbiB3YXRjaGluZyBpbiBhXG4gKiAgdGVybWluYWwgZmluZHMgdGhlIGVzY2FwZSBoYXRjaCB3aGVyZSB0aGV5IGxvb2sgKEQ0KS4gV29yZGVkIG9uY2UgaGVyZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfSEVMUCA9XG4gIFwiZW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyAzMC1taW51dGUgY2FwIHdpdGggYSBsaW5lIG5hbWluZyB0aGUgbmV4dCBhY3Q7IGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCBrZWVwcyBpdCBvcGVuIHdpdGggU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBcIjtcblxuLyoqIENvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3cgdGhhdCBtYWtlIHRoZSBkYWVtb24gXCJsb3N0XCIgKHNlZSBBMikuIFRocmVlXG4gKiAgc3BhbiBhYm91dCAwLjc1IHMgdW5kZXIgdGhlIGtpdCdzIGRlZmF1bHQgYmFja29mZiAoMjUwICsgNTAwIG1zIGJldHdlZW5cbiAqICB0aGVtKTogYSBsaXZlIGRhZW1vbiBuZXZlciByZWZ1c2VzIGl0cyBvd24gcG9ydCwgYW5kIHRoZSB0d28gZXh0cmEgYXR0ZW1wdHNcbiAqICBvbmx5IGJ1eSB0b2xlcmFuY2UgZm9yIGEgcmVzdGFydCB0aGF0IHJlYmluZHMgdGhlIHNhbWUgcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBMT1NUX0FGVEVSX1JFRlVTQUxTID0gMztcblxuLyoqIFRoZSB3aW5kb3cgbGVuZ3RoOiB0aGUgZW52IHZhbHVlIHdoZW4gaXQgaXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZWxzZSB0aGVcbiAqICBkZWZhdWx0LiBgMGAgbWVhbnMgbm8gd2luZG93LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXaW5kb3dNcyhyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcudHJpbSgpID09PSBcIlwiKSByZXR1cm4gREVGQVVMVF9XSU5ET1dfTVM7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIobikgJiYgbiA+PSAwID8gbiA6IERFRkFVTFRfV0lORE9XX01TO1xufVxuXG5leHBvcnQgdHlwZSBUYWlsTW9kZSA9IFwid2F0Y2hcIiB8IFwib25jZVwiO1xuXG4vKiogSG93IGEgdGFpbCBlbmRlZC4gYHdpbmRvd2AgaXMgb3VyIG93biBkZWFkbGluZSwgYGV2ZW50YCBpcyBhIGAtLW9uY2VgJ3NcbiAqICBmaXJzdCBmcmFtZSwgYGNsb3NlZGAgaXMgdGhlIHNlc3Npb24gZW5kaW5nIChhIGBjbG9zZWRgIGZyYW1lIG9yIHRoZSBwaW5uZWRcbiAqICBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcpLCBgbG9zdGAgaXMgdGhlIGRhZW1vbiByZWZ1c2luZyBjb25uZWN0aW9ucyxcbiAqICBhbmQgYHN0b3BwZWRgIGlzIGEgc2lnbmFsLCBhIGNhbGxlcidzIGFib3J0IG9yIGEgY2xvc2VkIHN0ZG91dC4gKi9cbmV4cG9ydCB0eXBlIFRhaWxFbmQgPSBcIndpbmRvd1wiIHwgXCJldmVudFwiIHwgXCJjbG9zZWRcIiB8IFwibG9zdFwiIHwgXCJzdG9wcGVkXCI7XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZJbnB1dCA9IHtcbiAgZW5kOiBUYWlsRW5kO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICBldmVudHM6IG51bWJlcjtcbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBgbW9uaXRvcmA6IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggYGNvbW1hbmRgLlxuICAgKiAgYGJhY2tncm91bmRgOiBydW4gYGNvbW1hbmRgIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2suXG4gICAqICBgc3RvcGA6IG5vdGhpbmcgdG8gd2F0Y2g7IGBjb21tYW5kYCBpcyBob3cgdG8gY29tZSBiYWNrLCBpZiB3YW50ZWQuICovXG4gIG5leHQ6IFwibW9uaXRvclwiIHwgXCJiYWNrZ3JvdW5kXCIgfCBcInN0b3BcIjtcbiAgY29tbWFuZDogc3RyaW5nO1xuICBoaW50OiBzdHJpbmc7XG59O1xuXG4vKiogVGhlIGNvbWUtYmFjayBoaW50LCB3aXRoIGhvdyB0byBSRVNVTUUgYWZ0ZXIgY29taW5nIGJhY2sgKEQyKTogYSByZXN0b3JlZFxuICogIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIG1lYW5zIG5vdGhpbmcgdGhlcmUuICovXG5jb25zdCBDT01FX0JBQ0sgPSAod2h5OiBzdHJpbmcpID0+XG4gIGAke3doeX0gVG8gYnJpbmcgaXQgYmFjaywgcnVuIGNvbW1hbmQ7IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBldmVudHM6IHMuZXZlbnRzLCBjdXJzb3I6IHMuY3Vyc29yIH07XG4gIHN3aXRjaCAocy5lbmQpIHtcbiAgICBjYXNlIFwic3RvcHBlZFwiOlxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgY2FzZSBcImNsb3NlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmNsb3NlZFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IFwiaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIGNvbW1hbmRcIixcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogXCJ0aGUgd2luZG93IGVuZGVkIGJlZm9yZSBNb25pdG9yJ3MgY2FwOyBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIGNvbW1hbmRcIixcbiAgICAgICAgfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5xdWlldFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcImJhY2tncm91bmRcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IHRydWUsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBcIm5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuIGNvbW1hbmQgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpIOKAlCBpdCBleGl0cyBvbiB0aGUgbmV4dCBldmVudFwiLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2hlbGxRdW90ZShhcmc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltBLVphLXowLTlfQCUrPTosLi8tXSskLy50ZXN0KGFyZykgPyBhcmcgOiBgJyR7YXJnLnJlcGxhY2VBbGwoXCInXCIsIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKlxuICogUmVhZCBhIGAtLXNpbmNlYCB2YWx1ZTogYW4gZXZlbnQgaWQsIG9wdGlvbmFsbHkgY2FycnlpbmcgdGhlIGVwb2NoIG9mIHRoZVxuICogbG9nIGl0IGNhbWUgZnJvbSAoYDEyQDxlcG9jaD5gLCBEMikuIE51bGwgd2hlbiB0aGUgaWQgaXMgbm90IGFuIGludGVnZXIuXG4gKiBGb3IgdGhlIHNwZWxscyB3aG9zZSBkYWVtb24gc3RhbXBzIGFuIGVwb2NoOyB0aGUgcmVzdCB0YWtlIGEgcGxhaW4gaWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJvb2ttYXJrKHRva2VuOiBzdHJpbmcpOiB7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgYXQgPSB0b2tlbi5pbmRleE9mKFwiQFwiKTtcbiAgY29uc3QgaWQgPSBhdCA9PT0gLTEgPyB0b2tlbiA6IHRva2VuLnNsaWNlKDAsIGF0KTtcbiAgY29uc3QgZXBvY2ggPSBhdCA9PT0gLTEgPyBcIlwiIDogdG9rZW4uc2xpY2UoYXQgKyAxKTtcbiAgaWYgKCEvXi0/XFxkKyQvLnRlc3QoaWQudHJpbSgpKSkgcmV0dXJuIG51bGw7XG4gIGlmIChhdCAhPT0gLTEgJiYgZXBvY2ggPT09IFwiXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBzaW5jZTogTnVtYmVyLnBhcnNlSW50KGlkLCAxMCksIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSB9O1xufVxuXG4vKiogSm9pbiBhbiBhcmd2IGludG8gb25lIHJ1bm5hYmxlIGNvbW1hbmQgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kTGluZShhcmd2OiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBhcmd2Lm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcbn1cblxuLyoqIEhvdyBUSElTIHByb2Nlc3Mgd2FzIGludm9rZWQsIGFzIHRoZSBoZWFkIG9mIGEgY29tbWFuZCB0aGF0IHJ1bnMgaXQgYWdhaW46XG4gKiAgYGJ1biA8dGhlIGxhdW5jaGVyJ3MgZnVsbCBwYXRoPmAuIEJ1biBoYW5kcyBgYXJndlsxXWAgb3ZlciBhcyBhIGZ1bGwgcGF0aC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWxmQ29tbWFuZCgpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbXCJidW5cIiwgcHJvY2Vzcy5hcmd2WzFdID8/IFwiY2xpLnRzXCJdO1xufVxuXG4vKiogVGhlIHJlLWFybSBmb3IgYSBzcGVsbCB3aG9zZSB0YWlsIGlzIGA8cHJlZml44oCmPiAtLXNpbmNlIE5bQGVwb2NoXSBbLS1vbmNlXWAuXG4gKiAgUGFzcyBgZXBvY2hgIG9ubHkgZm9yIGEgc3BlbGwgd2hvc2UgYC0tc2luY2VgIHBhcnNlcyBpdCAoYHBhcnNlQm9va21hcmtgKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChcbiAgcHJlZml4OiByZWFkb25seSBzdHJpbmdbXSxcbiAgc2luY2U6IG51bWJlcixcbiAgb25jZTogYm9vbGVhbixcbiAgZXBvY2g/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICAvLyDimqAgQSBuZWdhdGl2ZSBib29rbWFyayAobm90aGluZyBzZWVuIHlldCkgaXMgc3BlbGxlZCBgLS1zaW5jZT0tMWA6IHRoZVxuICAvLyBwYXJzZXJzIHJlYWQgYSBiYXJlIGAtMWAgYWZ0ZXIgYSBmbGFnIGFzIGFub3RoZXIgZmxhZyBhbmQgcmVmdXNlIGl0LlxuICBjb25zdCBtYXJrID0gZXBvY2ggPyBgJHtzaW5jZX1AJHtlcG9jaH1gIDogU3RyaW5nKHNpbmNlKTtcbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHttYXJrfWBdIDogW1wiLS1zaW5jZVwiLCBtYXJrXTtcbiAgcmV0dXJuIGNvbW1hbmRMaW5lKFsuLi5wcmVmaXgsIC4uLmF0LCAuLi4ob25jZSA/IFtcIi0tb25jZVwiXSA6IFtdKV0pO1xufVxuXG5leHBvcnQgdHlwZSBIYW5kb2ZmT3B0aW9uczxFdj4gPSB7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogQSBwcmVzZW5jZSBzcGVsbDogYWx3YXlzIGB0YWlsLndpbmRvd2AgYXQgdGhlIHdpbmRvdydzIGVuZCwgbmV2ZXIgbG9zdC4gKi9cbiAgcHJlc2VuY2U6IGJvb2xlYW47XG4gIC8qKiBEZWZhdWx0OiBgcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKWAuIGAwYCA9IG5vIHdpbmRvdy4gKi9cbiAgd2luZG93TXM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIGFuIGVtaXR0ZWQgZnJhbWUgaXMgYSBMT0cgZnJhbWUgKEEzKS4gRGVmYXVsdDogZXZlcnkgb25lLiAqL1xuICBjb3VudHM/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBXaGljaCB0ZXJtaW5hbCBmcmFtZSBtZWFucyB0aGUgc2Vzc2lvbiBjbG9zZWQuIERlZmF1bHQ6IGV2ZXJ5IHRlcm1pbmFsLiAqL1xuICBpc0Nsb3NlZD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIGNvbW1hbmRzOiBIYW5kb2ZmQ29tbWFuZHM7XG59O1xuXG4vKipcbiAqIFJ1biBgdGFpbEV2ZW50c2Agd2l0aCB0aGUgaGFuZG9mZjogdGhlIHdpbmRvdywgYC0tb25jZWAsIHRoZSBsb3N0IHJ1bGUsIGFuZFxuICogdGhlIGZpbmFsIGxpbmUuIFJldHVybnMgdGhlIGV4aXQgY29kZSwgbGlrZSBgdGFpbEV2ZW50c2AsIGFuZCBuZXZlciBleGl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxXaXRoSGFuZG9mZjxFdj4oXG4gIHRhaWw6IFRhaWxPcHRpb25zPEV2PixcbiAgaDogSGFuZG9mZk9wdGlvbnM8RXY+LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gdGFpbC5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IHdpbmRvd01zID0gaC53aW5kb3dNcyA/PyByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pO1xuICBjb25zdCBjb3VudHMgPSBoLmNvdW50cyA/PyAoKCkgPT4gdHJ1ZSk7XG4gIGNvbnN0IGVuZE9uTG9zdCA9ICFoLnByZXNlbmNlO1xuXG4gIGNvbnN0IGFjID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gYWMuYWJvcnQoKTtcbiAgdGFpbC5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKHRhaWwuc2lnbmFsPy5hYm9ydGVkKSBhYy5hYm9ydCgpO1xuXG4gIGxldCBldmVudHMgPSAwO1xuICBsZXQgY3Vyc29yID0gdGFpbC5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB0YWlsLnNpbmNlRXBvY2g7XG4gIGxldCBmcmFtZUhhc0lkID0gZmFsc2U7XG4gIC8qKiBBMyArIEQzOiBhIGZyYW1lIGNvdW50cywgYW5kIHdha2VzIGEgYC0tb25jZWAsIG9ubHkgd2hlbiBpdCBpcyBPTiBUSEVcbiAgICogIExPRyDigJQgaXQgY2FycmllcyBhIGxvZyBpZCDigJQgYW5kIHRoZSBzcGVsbCdzIG93biBgY291bnRzYCBhZ3JlZXMuIEEgdGFiJ3NcbiAgICogIGlkLWxlc3MgYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGAgcGluZyBpcyBub3Qgb24gdGhlIGxvZy4gKi9cbiAgY29uc3QgaXNMb2dGcmFtZSA9IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gZnJhbWVIYXNJZCAmJiBjb3VudHMoZXYsIGZyYW1lKTtcbiAgbGV0IGVuZDogVGFpbEVuZCB8IG51bGwgPSBudWxsO1xuICBsZXQgcmVmdXNhbHMgPSAwO1xuXG4gIGNvbnN0IGZpbmlzaCA9IChlOiBUYWlsRW5kKSA9PiB7XG4gICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gZTtcbiAgICBhYy5hYm9ydCgpO1xuICB9O1xuICBjb25zdCB0aW1lciA9XG4gICAgaC5tb2RlID09PSBcIndhdGNoXCIgJiYgd2luZG93TXMgPiAwID8gc2V0VGltZW91dCgoKSA9PiBmaW5pc2goXCJ3aW5kb3dcIiksIHdpbmRvd01zKSA6IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gYXdhaXQgdGFpbEV2ZW50czxFdj4oe1xuICAgICAgLi4udGFpbCxcbiAgICAgIHNpZ25hbDogYWMuc2lnbmFsLFxuICAgICAgLy8gRDIncyBuZXQuIE9uIGZvciBldmVyeSBzcGVsbDogYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yXG4gICAgICAvLyBtZWFucyBhIHdob2xlIHJlcGxheSBvbiB0aGUga2l0J3MgbG9nLCBhbmQgb24gZ3JhcGV2aW5lJ3MgZHVyYWJsZSBsb2dcbiAgICAgIC8vIGl0IGhhcHBlbnMgb25seSB3aGVuIGAtLWxhc3RgIHJlYWNoZXMgYmVsb3cgYC0tc2luY2VgLCB3aGVyZVxuICAgICAgLy8gcmUtcmVhZGluZyB0aGUgY3Vyc29yIGZyb20gdGhlIGZyYW1lcyBpcyB0aGUgbW9yZSBjb3JyZWN0IGFuc3dlci5cbiAgICAgIHJlc3RhcnRPblJlcGxheTogdHJ1ZSxcbiAgICAgIC8vIEQzOiByZW1lbWJlciB3aGV0aGVyIFRISVMgZnJhbWUgY2FycmllcyBhIGxvZyBpZC4gYHRhaWxFdmVudHNgIHJlYWRzXG4gICAgICAvLyB0aGUgY3Vyc29yIG9uY2UgcGVyIGZyYW1lLCBiZWZvcmUgYGFjY2VwdGAsIGB0ZXJtaW5hbGAgYW5kIGByZW5kZXJgLlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4ge1xuICAgICAgICBjb25zdCBuID0gdGFpbC5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgZnJhbWVIYXNJZCA9IHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKTtcbiAgICAgICAgcmV0dXJuIG47XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAocykgPT4ge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gdGFpbC5vblVucmVzb2x2ZWQ/LihzKSA/PyBcInJldHJ5XCI7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgdGhhdCBnaXZlcyB1cCBvbiBmaW5kaW5nIGl0cyBzZXNzaW9uIGlzIHdhdGNoaW5nIGFcbiAgICAgICAgLy8gc2Vzc2lvbiB0aGF0IGlzIGdvbmUg4oCUIHdoZXRoZXIgdGhpcyBwcm9jZXNzIGV2ZXIgcmVhY2hlZCBpdCAoaXRzXG4gICAgICAgIC8vIHBvaW50ZXIgdmFuaXNoZWQpIG9yIGl0IHdhcyByZS1hcm1lZCBhdCBvbmUgdGhhdCBjbG9zZWQgaW4gdGhlIGdhcC5cbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiICYmIGVuZCA9PT0gbnVsbCkgZW5kID0gXCJjbG9zZWRcIjtcbiAgICAgICAgcmV0dXJuIHZlcmRpY3Q7XG4gICAgICB9LFxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwucmVuZGVyID8gdGFpbC5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgIGlmIChsaW5lICE9PSBudWxsICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkgZXZlbnRzICs9IDE7XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIHRlcm1pbmFsOiAoZXYsIGZyYW1lLCBhY2NlcHRlZCkgPT4ge1xuICAgICAgICBpZiAodGFpbC50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gKGguaXNDbG9zZWQgPz8gKCgpID0+IHRydWUpKShldikgPyBcImNsb3NlZFwiIDogXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIGVwb2NoID0gcy5lcG9jaCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSksXG4gICAgICAgIHByZXNlbmNlOiBoLnByZXNlbmNlLFxuICAgICAgfSxcbiAgICAgIGguY29tbWFuZHMsXG4gICAgKTtcbiAgICBpZiAobGluZSAhPT0gbnVsbCkgb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGxpbmUpfVxcbmApO1xuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0YWlsLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwK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
