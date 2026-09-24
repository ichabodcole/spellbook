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
var RUN_WITH_LAUNCHER = "bun <this skill's directory>/scripts/cli.ts <command>";
var COME_BACK = (why) => `${why} To bring it back, run ${RUN_WITH_LAUNCHER}; then arm the tail again with no --since, on the session id it prints where there is one (a restarted daemon starts a new event log, so the old bookmark does not apply)`;
function handoff(s, cmd) {
  const base = { spell: s.spell, events: s.events, cursor: s.cursor };
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
        hint: `handle the event above, then arm Monitor (timeout_ms 1800000) running ${RUN_WITH_LAUNCHER}`
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
          hint: `the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) running ${RUN_WITH_LAUNCHER}`
        };
      return {
        type: "tail.quiet",
        ...base,
        next: "background",
        command: cmd.tail({ since: s.cursor, once: true, ...s.epoch ? { epoch: s.epoch } : {} }),
        hint: `nothing on the log this window; run ${RUN_WITH_LAUNCHER} as a background Bash task (run_in_background) \u2014 it exits on the next event`
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
function readSince(token, o) {
  const min = o.min ?? -1;
  const b = parseBookmark(token);
  if (b !== null && b.since >= min && (b.epoch === undefined || o.epoch))
    return { ok: true, since: b.since, ...b.epoch ? { epoch: b.epoch } : {} };
  const id = min < 0 ? "an event id (an integer; -1 for everything)" : `an event id (an integer, ${min} or more)`;
  const forms = o.epoch ? `${id}, or <id>@<epoch> as a handoff line prints it` : id;
  const why = !o.epoch && token.includes("@") ? `; this spell's log stamps no epoch, so pass the id without the "@\u2026" part` : "";
  return {
    ok: false,
    message: `--since: "${token}" is not a bookmark this tail accepts \u2014 give ${forms}${why}`
  };
}
function commandLine(argv) {
  return argv.map(shellQuote).join(" ");
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
      presence: h.presence,
      spell: h.spell
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
  const r = readSince(token, { epoch: true });
  if (!r.ok)
    die(r.message, "usage");
  return r.epoch ? { since: r.since, epoch: r.epoch } : { since: r.since };
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
    spell: "scriptorium",
    mode: o.once ? "once" : "watch",
    presence: false,
    commands: {
      tail: ({ since: at, once, epoch }) => tailCommand(["tail", ...pin()], at, once, epoch),
      comeBack: () => commandLine(["open", "--restore", boundId ?? "<id>", "--no-open"])
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

//# debugId=AAD18D8C7774A4C464756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgb3IgYGRpc3BhdGNoYCwgbm9uZSBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYC4gVGhlXG4gKiBzd2FsbG93aW5nIGNhdGNoZXMgKGBhcGlgJ3Mgbm9uLUpTT04gYm9keSwgYHZlcnNpb25JbmZvYCwgYHBvc3RDbWRgJ3MgY2xvc2VcbiAqIEVDT05OUkVTRVQpIGNvbnRhaW4gbm8gZGllLXJlYWNoYWJsZSBjYWxsLlxuICovXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgY2xvc2VTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG9wZW5TeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQge1xuICBDbGlFcnJvcixcbiAgZGllLFxuICB0eXBlIEVycktpbmQsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9yc1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHJlYWRTaW5jZSxcbiAgdGFpbENvbW1hbmQsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZlwiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBET0NfRVhURU5TSU9OUywgaXNEb2NOYW1lIH0gZnJvbSBcIi4vdHJlZVwiO1xuXG4vLyDimqAgREVDTEFSRUQgRklSU1QsIEFCT1ZFIEVWRVJZIE9USEVSIEZVTkNUSU9OLCBPTiBQVVJQT1NFLiBUaGUgYGNob2ljZXNgXG4vLyBjZW5zdXMncyByYWlzZXIgcnVsZSAoYSkgKGBncmltb2lyZS9saWIvZXJyb3Itc2l0ZXMudHNgKSBtYXRjaGVzXG4vLyBgZnVuY3Rpb24gTkFNRShgIGxhemlseSB1cCB0byB0aGUgbmV4dCBgKTogbmV2ZXJgIHdpdGhpbiA2MDAgY2hhcmFjdGVycywgc29cbi8vIEFOWSBmdW5jdGlvbiBkZWNsYXJlZCBzaG9ydGx5IGFib3ZlIHRoaXMgb25lIOKAlCBgYXBpYCwgdGhlbiBgcmVxdWlyZVNlc3Npb25gIOKAlFxuLy8gd2FzIHJlYWQgYXMgYSByYWlzZXIgYW5kIGl0cyBjYWxscyBjb3VudGVkIGFzIHJhaXNlIHNpdGVzIChmb3VuZCAyMDI2LTA5LTExLFxuLy8gcmVwb3J0ZWQgaW4gdGhlIHNsaWNlLUEgam91cm5hbCBhcyBhbiBpbnN0cnVtZW50IGRlZmVjdCwgbm90IGZpeGVkIGhlcmUpLlxuZnVuY3Rpb24gZGFlbW9uUmVmdXNlZCh3aGF0OiBzdHJpbmcsIHN0YXR1czogbnVtYmVyLCBkYXRhOiB1bmtub3duKTogbmV2ZXIge1xuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICBzdGF0dXMgPT09IDQwMFxuICAgICAgPyBcInVzYWdlXCJcbiAgICAgIDogc3RhdHVzID09PSA0MDRcbiAgICAgICAgPyBcIm5vdF9mb3VuZFwiXG4gICAgICAgIDogc3RhdHVzID09PSA0MDlcbiAgICAgICAgICA/IFwiY29uZmxpY3RcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICBjb25zdCBib2R5ID0gKGRhdGEgPz8ge30pIGFzIHsgZXJyb3I/OiB1bmtub3duOyBjaG9pY2VzPzogdW5rbm93bjsgaGludD86IHVua25vd24gfTtcbiAgY29uc3QgY2hvaWNlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5jaG9pY2VzKSA/IGJvZHkuY2hvaWNlcy5tYXAoU3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgLy8g4pqgIFRoZSBkYWVtb24ncyBvd24gaGludCwgZm9yd2FyZGVkLiBBIHJlZnVzYWwgdGhhdCBrbm93cyB3aGF0IHRvIGRvIG5leHRcbiAgLy8gdXNlZCB0byBkcm9wIHRoYXQga25vd2xlZGdlIG9uIHRoZSBmbG9vciBhdCB0aGlzIGxpbmUuXG4gIGNvbnN0IGhpbnQgPSB0eXBlb2YgYm9keS5oaW50ID09PSBcInN0cmluZ1wiID8gYm9keS5oaW50IDogdW5kZWZpbmVkO1xuICBkaWUodHlwZW9mIGJvZHkuZXJyb3IgPT09IFwic3RyaW5nXCIgPyBib2R5LmVycm9yIDogYCR7d2hhdH0gZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBraW5kLCB7XG4gICAgLi4uKGhpbnQgPyB7IGhpbnQgfSA6IHt9KSxcbiAgICAuLi4oY2hvaWNlcyA/IHsgY2hvaWNlcyB9IDoge30pLFxuICAgIC4uLihkYXRhICE9PSBudWxsICYmIGRhdGEgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBkYXRhIH0gOiB7fSksXG4gIH0pO1xufVxuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShCdW4uZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwic2NyaXB0b3JpdW1cIik7XG5cbi8qKiBDb250cmFjdCA1OiBhIGRldiBkYWVtb24gbXVzdCBydW4gd2l0aCBjd2QgYXQgYHNyYy9zY3JpcHRvcml1bS9gIChidW5maWcudG9tbCkuICovXG5leHBvcnQgZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8qKiBgJFNDUklQVE9SSVVNX0hPTUVgLCBkZWZhdWx0IGB+Ly5zY3JpcHRvcml1bWAg4oCUIHRoZSBzYW1lIHJ1bGUgYXMgdGhlIGRhZW1vbidzLiAqL1xuZnVuY3Rpb24gc2NyaXB0b3JpdW1Ib21lKCk6IHN0cmluZyB7XG4gIHJldHVybiByZXNvbHZlKHByb2Nlc3MuZW52LlNDUklQVE9SSVVNX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLnNjcmlwdG9yaXVtXCIpKTtcbn1cblxudHlwZSBTZXNzaW9uUG9pbnRlciA9IHsgdXJsOiBzdHJpbmc7IHBvcnQ6IG51bWJlcjsgc2Vzc2lvbl9pZDogc3RyaW5nOyBob21lOiBzdHJpbmc7IGRpcjogc3RyaW5nIH07XG5cbi8qKlxuICogU2Vzc2lvbnMgd2hvc2Ugd29yayBpcyBzdGlsbCBvbiBkaXNrLCBuZXdlc3QgZmlyc3QgKEU1NikuXG4gKlxuICog4puUIEEgREVBRCBTRVNTSU9OIElTIE5PVCBBIExPU1QgT05FLCBhbmQgdGhlIENMSSB1c2VkIHRvIGltcGx5IG90aGVyd2lzZS4gVGhlXG4gKiBtYW5pZmVzdCBhbmQgZXZlcnkgdmVyc2lvbiBmaWxlIGxpdmUgdW5kZXIgdGhlIGhvbWUsIHNvIGEgZGFlbW9uIHRoYXQgaGFzXG4gKiBleGl0ZWQg4oCUIHRoZSAzMC1taW51dGUgaWRsZSB0aW1lb3V0LCBhIGNyYXNoLCBhIHJlYm9vdCDigJQgY29zdHMgdGhlIFVSTCBhbmRcbiAqIG5vdGhpbmcgZWxzZS4gQ29sZSBoaXQgZXhhY3RseSB0aGlzIChcInRoYXQgbGluayBkb2Vzbid0IHNlZW0gdG8gYmUgbGl2ZVxuICogYW55bW9yZVwiKSBhbmQgdGhlIG9ubHkgdGhpbmcgdGhlIHRvb2xpbmcgc2FpZCB3YXMgXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtXG4gKiBzZXNzaW9uXCIsIHdoaWNoIHJlYWRzIGxpa2UgdGhlIHdvcmsgaXMgZ29uZS5cbiAqL1xuZnVuY3Rpb24gcmVzdG9yYWJsZSgpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGRpciA9IGpvaW4oc2NyaXB0b3JpdW1Ib21lKCksIFwic2Vzc2lvbnNcIik7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pXG4gICAgICAuZmlsdGVyKChlKSA9PiBlLmlzRGlyZWN0b3J5KCkgJiYgZXhpc3RzU3luYyhqb2luKGRpciwgZS5uYW1lLCBcIm1hbmlmZXN0Lmpzb25cIikpKVxuICAgICAgLm1hcCgoZSkgPT4gKHsgaWQ6IGUubmFtZSwgYXQ6IHN0YXRTeW5jKGpvaW4oZGlyLCBlLm5hbWUsIFwibWFuaWZlc3QuanNvblwiKSkubXRpbWVNcyB9KSlcbiAgICAgIC5zb3J0KChhLCBiKSA9PiBiLmF0IC0gYS5hdClcbiAgICAgIC5tYXAoKGUpID0+IGUuaWQpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFdoYXQgdG8gc2F5IHdoZW4gbm8gZGFlbW9uIGFuc3dlcnMg4oCUIGluY2x1ZGluZyB0aGUgd2F5IGJhY2ssIHdoZW4gdGhlcmUgaXMgb25lLiAqL1xuZnVuY3Rpb24gbm9TZXNzaW9uSGludCgpOiB7IGhpbnQ6IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0ge1xuICBjb25zdCBpZHMgPSByZXN0b3JhYmxlKCk7XG4gIGNvbnN0IG5ld2VzdCA9IGlkc1swXTtcbiAgaWYgKG5ld2VzdCA9PT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiB7IGhpbnQ6IFwibm8gc2Vzc2lvbiBoYXMgYmVlbiBvcGVuZWQgaW4gdGhpcyBob21lIHlldCDigJQgcnVuOiBjbGkudHMgb3BlbiA8cGF0aD5cIiB9O1xuICByZXR1cm4ge1xuICAgIC8vIOKaoCBUaGUgQ09NTUFORCwgd2l0aCB0aGUgaWQgYWxyZWFkeSBpbiBpdC4gQSBoaW50IHRoYXQgc2F5cyBcInlvdSBjYW5cbiAgICAvLyByZXN0b3JlIGEgc2Vzc2lvblwiIGxlYXZlcyB0aGUgcmVhZGVyIHRvIGZpbmQgdGhlIGlkIGFuZCBndWVzcyB0aGUgZmxhZy5cbiAgICBoaW50OiBgbm8gZGFlbW9uIGlzIHJ1bm5pbmcsIGJ1dCB0aGUgd29yayBpcyBvbiBkaXNrIOKAlCBicmluZyBpdCBiYWNrIHdpdGg6IGNsaS50cyBvcGVuIC0tcmVzdG9yZSAke25ld2VzdH1gLFxuICAgIGNob2ljZXM6IGlkcy5zbGljZSgwLCAxMCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4odG1wZGlyKCksIHNlc3Npb24gPyBgc2NyaXB0b3JpdW0tJHtzZXNzaW9ufS5qc29uYCA6IFwic2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25cIik7XG59XG5cbi8qKiBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFIOKAlCBFTk9FTlQgaXMgdGhlIG9ubHkgYWJzZW5jZS4gKi9cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uUG9pbnRlcjtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB0aGUgc2Vzc2lvbiBwb2ludGVyIGlzIG5vdCB2YWxpZCBKU09OOiAke3BhdGh9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXF1aXJlU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvblBvaW50ZXIge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBzY3JpcHRvcml1bSBzZXNzaW9uXCIsIFwibm90X2ZvdW5kXCIsIG5vU2Vzc2lvbkhpbnQoKSk7XG4gIHJldHVybiBzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBub24tSlNPTiBib2R5ICovXG4gIH1cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgbGV0IHN0YXR1czogbnVtYmVyO1xuICBsZXQgZGF0YTogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICAoeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgbXNnKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIGBjbG9zZWAgc3RvcHMgdGhlIHNlcnZlcjsgYSBSRVNFVCBpcyBpdHMgc3VjY2Vzcy4gQSByZWZ1c2VkIGNvbm5lY3Rpb25cbiAgICAvLyAoYSBzdGFsZSBwb2ludGVyKSBpcyBhIHRyYW5zcG9ydCBmYWlsdXJlIGxpa2UgYW55IG90aGVyLlxuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY29uc3QgY29kZSA9IGVyciAmJiB0eXBlb2YgZXJyID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGVyciA/IFN0cmluZyhlcnIuY29kZSkgOiBcIlwiO1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiICYmIChjb2RlID09PSBcIkVDT05OUkVTRVRcIiB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiRUNPTk5SRVNFVFwiKSkpXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIHRocm93IGVycjtcbiAgfVxuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoU3RyaW5nKG1zZy50eXBlKSwgc3RhdHVzLCBkYXRhKTtcbiAgcmV0dXJuIGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbi8vIOKUgOKUgCB0aGUgcGFyc2VyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJ5OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY29udGV4dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRvYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGVudHJ5OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZm9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVvdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZW9wZW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgaHVua3M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbnRvOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGlmZWN5Y2xlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGltaXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIG9uY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcGF0Y2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlc3Npb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwic3RhcnQtdGltZW91dFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGFnOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHR5cGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IFJFQ09HTklaRURfRkxBR1MgPSBPYmplY3Qua2V5cyhDTElfT1BUSU9OUykubWFwKChrKSA9PiBgLS0ke2t9YCk7XG5cbmV4cG9ydCBjbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgQ2xpRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkge1xuICAgIHN1cGVyKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFyZ3MoYXJnczogc3RyaW5nW10pOiB7XG4gIHBvczogc3RyaW5nW107XG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbn0ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgdmFsdWVzLCBwb3NpdGlvbmFscyB9ID0gbm9kZVBhcnNlQXJncyh7XG4gICAgICBhcmdzLFxuICAgICAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICAgIHJldHVybiB7IHBvczogcG9zaXRpb25hbHMsIGZsYWdzOiB2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4gfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgeyBjb2RlPzogc3RyaW5nIH0pLmNvZGU7XG4gICAgLy8gT25seSBhbiBVTktOT1dOIG9wdGlvbiBuYW1lcyB0aGUgZmxhZyByb3N0ZXI7IHRoZSBvdGhlciBwYXJzZSBmYWlsdXJlc1xuICAgIC8vIG1lYW4gYSByZWNvZ25pc2VkIGZsYWcgd2FzIG1pc3VzZWQsIGFuZCB0aGUgcm9zdGVyIHdvdWxkIG5hbWUgdGhlIGhhbGZcbiAgICAvLyB0aGF0IHdhcyByaWdodC5cbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihkZXRhaWwsIHtcbiAgICAgIGhpbnQ6IFwiZm9yIGZyZWUgdGV4dCBjb250YWluaW5nIGRhc2hlcywgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLVwiLFxuICAgICAgLi4uKGNvZGUgPT09IFwiRVJSX1BBUlNFX0FSR1NfVU5LTk9XTl9PUFRJT05cIiA/IHsgY2hvaWNlczogUkVDT0dOSVpFRF9GTEFHUyB9IDoge30pLFxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICogYHRhaWwgLS1zaW5jZWAgaXMgYSBCT09LTUFSSzogYW4gZXZlbnQgaWQgKC0xIGZvciBcImV2ZXJ5dGhpbmdcIiksIG9wdGlvbmFsbHlcbiAqIHdpdGggdGhlIGVwb2NoIG9mIHRoZSBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIGFzIHRoZSB0YWlsJ3Mgb3duIGhhbmRvZmYgbGluZSBwcmludHMgaXQg4oCUXG4gKiBga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBEMikuIFRoZSBlcG9jaCBpcyB3aGF0IGxldHMgdGhlIHRhaWwgbm90aWNlIGFcbiAqIHJlc3RhcnRlZCBkYWVtb24gd2hvc2UgbmV3IGxvZyBpcyBhbHJlYWR5IHBhc3QgdGhlIGlkLiBWZXJpZnktcGFzcyBmaXggOVxuICogc3RpbGwgaG9sZHM6IGAtLXNpbmNlIGFiY2AgdXNlZCB0byBwYXJzZSB0byBOYU4sIHdoaWNoIHRoZSBsb2cgcmVhZHMgYXMgXCJmcm9tXG4gKiB0aGUgc3RhcnRcIiwgc28gYSB0eXBvIHJlcGxheWVkIHRoZSB3aG9sZSBidWZmZXIgYXQgZXhpdCAwIOKAlCBpdCBpcyByZWZ1c2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUYWlsU2luY2UodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHIgPSByZWFkU2luY2UodG9rZW4sIHsgZXBvY2g6IHRydWUgfSk7XG4gIGlmICghci5vaykgZGllKHIubWVzc2FnZSwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHIuZXBvY2ggPyB7IHNpbmNlOiByLnNpbmNlLCBlcG9jaDogci5lcG9jaCB9IDogeyBzaW5jZTogci5zaW5jZSB9O1xufVxuXG4vKipcbiAqIGBmaW5kIC0tc2luY2VgIGlzIGEgREFURSwgd2hlcmUgYHRhaWwgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQg4oCUIHRoZSBmbGFnIGlzXG4gKiBzaGFyZWQsIHRoZSBtZWFuaW5nIGlzIHRoZSB2ZXJiJ3MsIGFuZCBwZG9jcyBzcGVsbHMgdGhpcyBvbmUgYC0tc2luY2VgIHRvby5cbiAqIEEgdHlwbyBtdXN0IG5vdCBzaWxlbnRseSB3aWRlbiB0aGUgc2VhcmNoLCBzbyBhIG5vbi1kYXRlIGlzIGEgdXNhZ2UgZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlRGF0ZSh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh0KSB8fCBOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZSh0KSkpXG4gICAgZGllKGBmaW5kIC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBkYXRlIOKAlCB3cml0ZSBpdCBhcyBZWVlZLU1NLUREYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHQ7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vKiogQSBub24tbmVnYXRpdmUgd2hvbGUgbnVtYmVyIGZyb20gYSBmbGFnLCByZWZ1c2VkIHJhdGhlciB0aGFuIGNvZXJjZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb3VudCh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QodCkpIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHdob2xlIG51bWJlcmAsIFwidXNhZ2VcIik7XG4gIHJldHVybiBOdW1iZXIodCk7XG59XG5cbi8qKlxuICogQSBjb21wYXJpc29uIHNpZGU6IGEgdmVyc2lvbiwgb3IgdGhlIGZpbGUgb2YgcmVjb3JkLiBgb3JpZ2luYWxgIGlzIHNwZWxsZWRcbiAqIG91dCByYXRoZXIgdGhhbiBvZmZlcmVkIGFzIGB2MGAg4oCUIGEgemVyb3RoIHZlcnNpb24gd291bGQgcmVhZCBsaWtlIHRoZVxuICogZWFybGllc3Qgb25lLCBhbmQgdGhlIG9yaWdpbmFsIGlzIG5vdCBwYXJ0IG9mIHRoZSB2ZXJzaW9uIGxpbmUgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaWRlKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB8IFwib3JpZ2luYWxcIiB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgLy8gYHNhdmVkYCBpcyB0aGUgd29yZCB0aGUgU1VSRkFDRSB1c2VzIGZvciB0aGlzIHNpZGUgKEU0Myk7IGBvcmlnaW5hbGAgYW5kXG4gIC8vIGBmaWxlYCBrZWVwIHdvcmtpbmcgYmVjYXVzZSB0aGV5IGFyZSB3aGF0IGVhcmxpZXIgc2Vzc2lvbnMgYW5kIG5vdGVzIHNheS5cbiAgaWYgKHQgPT09IFwib3JpZ2luYWxcIiB8fCB0ID09PSBcImZpbGVcIiB8fCB0ID09PSBcInNhdmVkXCIpIHJldHVybiBcIm9yaWdpbmFsXCI7XG4gIHJldHVybiBwYXJzZVZlcnNpb24odG9rZW4sIHdoYXQpO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog4puUIFZFUklGWS1QQVNTIEZJWCA1OiBldmVyeSBwYXRoIGlzIGNoZWNrZWQgSEVSRSwgYmVmb3JlIGFueSBkYWVtb24gZXhpc3RzLlxuICogYG9wZW4gZG9jLm1kIHBpYy5wbmdgIHVzZWQgdG8gc3Bhd24gYSBzZXNzaW9uLCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBwYXRoXG4gKiBpbnNpZGUgaXQg4oCUIGxlYXZpbmcgYSBydW5uaW5nIGRhZW1vbiBhbmQgYSBsaXZlIHBvaW50ZXIgYmVoaW5kIGEgZmFpbGVkXG4gKiBjb21tYW5kLiBBIGZvbGRlciBvciBhIGRvY3VtZW50IGlzIGFjY2VwdGVkOyBhIG1pc3NpbmcgcGF0aCBpcyBub3RfZm91bmQsIGFcbiAqIG5vbi1kb2N1bWVudCBmaWxlIGlzIHVzYWdlIHdpdGggdGhlIGFjY2VwdGVkIGV4dGVuc2lvbnMgYXMgYGNob2ljZXNgLlxuICovXG5mdW5jdGlvbiBjb250ZXh0UGF0aHMocG9zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcGF0aHMgPSBwb3MubWFwKChwKSA9PiByZXNvbHZlKHApKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG4gICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgdHJ5IHtcbiAgICAgIHN0ID0gc3RhdFN5bmMocCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBkaWUoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7cH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICB9XG4gICAgaWYgKCFzdC5pc0RpcmVjdG9yeSgpICYmICFpc0RvY05hbWUocCkpXG4gICAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke3B9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwiYWRkIGEgZm9sZGVyLCBvciBhIGZpbGUgd2l0aCBvbmUgb2YgdGhlc2UgZXh0ZW5zaW9uc1wiLFxuICAgICAgICBjaG9pY2VzOiBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIHBhdGhzO1xufVxuXG4vKipcbiAqIGAtLWRvY2AgYXMgdGhlIENMSSdzIGNhbGxlciBtZWFudCBpdCAodmVyaWZ5LXBhc3MgZml4IDgpOiBhIHRva2VuIHdpdGggYSBwYXRoXG4gKiBzZXBhcmF0b3IsIG9yIG9uZSBuYW1pbmcgYSBmaWxlIGluIFRISVMgcHJvY2VzcydzIGN3ZCwgaXMgcmVzb2x2ZWQgaGVyZSB0byBhblxuICogYWJzb2x1dGUgcGF0aCDigJQgdGhlIGRhZW1vbidzIGN3ZCBpcyBub3QgdGhlIGNhbGxlcidzLiBBbnl0aGluZyBlbHNlIChhIHNsdWcsXG4gKiBhIHVuaXF1ZSBmaWxlIG5hbWUpIGdvZXMgYXMgdHlwZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NBcmcodG9rZW46IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0b2tlbi5pbmNsdWRlcyhcIi9cIikgfHwgZXhpc3RzU3luYyhyZXNvbHZlKHRva2VuKSkpIHJldHVybiByZXNvbHZlKHRva2VuKTtcbiAgcmV0dXJuIHRva2VuO1xufVxuXG4vKiogS2VlcCB0aGUgbmV3ZXN0IGBMT0dfS0VFUCAtIDFgIGRhZW1vbiBsb2dzLCBzbyB0aGUgb25lIGFib3V0IHRvIGJlIHdyaXR0ZW4gbWFrZXMgYExPR19LRUVQYC4gKi9cbmNvbnN0IExPR19LRUVQID0gMTA7XG5mdW5jdGlvbiBwcnVuZUxvZ3MobG9nRGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgbGV0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIG5hbWVzID0gcmVhZGRpclN5bmMobG9nRGlyKS5maWx0ZXIoKG4pID0+IC9eZGFlbW9uLVxcZCstXFxkK1xcLmxvZyQvLnRlc3QobikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYnlBZ2UgPSBuYW1lcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoYS5zcGxpdChcIi1cIilbMV0pIC0gTnVtYmVyKGIuc3BsaXQoXCItXCIpWzFdKSk7XG4gIGZvciAoY29uc3QgbiBvZiBieUFnZS5zbGljZSgwLCBNYXRoLm1heCgwLCBieUFnZS5sZW5ndGggLSAoTE9HX0tFRVAgLSAxKSkpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoam9pbihsb2dEaXIsIG4pKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgZ29uZSAqL1xuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuXG4gIGlmICh0eXBlb2YgZmxhZ3MucmVzdG9yZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IGhvbWUgPSBzY3JpcHRvcml1bUhvbWUoKTtcbiAgICBjb25zdCBtYW5pZmVzdCA9IGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiLCBmbGFncy5yZXN0b3JlLCBcIm1hbmlmZXN0Lmpzb25cIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKG1hbmlmZXN0KSkge1xuICAgICAgbGV0IHNhdmVkOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgdHJ5IHtcbiAgICAgICAgc2F2ZWQgPSAoXG4gICAgICAgICAgYXdhaXQgQXJyYXkuZnJvbUFzeW5jKG5ldyBCdW4uR2xvYihcIiovbWFuaWZlc3QuanNvblwiKS5zY2FuKGpvaW4oaG9tZSwgXCJzZXNzaW9uc1wiKSkpXG4gICAgICAgICkubWFwKChwKSA9PiBwLnNwbGl0KFwiL1wiKVswXSBhcyBzdHJpbmcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vIHNlc3Npb25zIGZvbGRlcjogdGhlIHNldCBpcyBlbXB0eSwgYW5kIHNheXMgc28gKi9cbiAgICAgIH1cbiAgICAgIGRpZShgbm8gc2F2ZWQgc2Vzc2lvbiBcIiR7ZmxhZ3MucmVzdG9yZX1cIiB1bmRlciAke2hvbWV9YCwgXCJub3RfZm91bmRcIiwge1xuICAgICAgICBjaG9pY2VzOiBzYXZlZC5zb3J0KCksXG4gICAgICAgIC4uLihzYXZlZC5sZW5ndGggPT09IDAgPyB7IGhpbnQ6IFwibm8gc2F2ZWQgc2Vzc2lvbnMgaW4gdGhpcyBob21lXCIgfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCBsaXZlID0gcmVhZFNlc3Npb24oZmxhZ3MucmVzdG9yZSk7XG4gICAgaWYgKGxpdmUpIHtcbiAgICAgIGNvbnN0IGFsaXZlID0gYXdhaXQgYXBpKGxpdmUucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIikudGhlbihcbiAgICAgICAgKHIpID0+IHIuc3RhdHVzID09PSAyMDAsXG4gICAgICAgICgpID0+IGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGlmIChhbGl2ZSlcbiAgICAgICAgZGllKGBzZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX0gaXMgYWxyZWFkeSBydW5uaW5nIGF0ICR7bGl2ZS51cmx9YCwgXCJjb25mbGljdFwiLCB7XG4gICAgICAgICAgaGludDogYHVzZSBpdDogY2xpLnRzIHN0YXRlIC0tc2Vzc2lvbiAke2ZsYWdzLnJlc3RvcmV9YCxcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZGFlbW9uQXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKHR5cGVvZiBmbGFncy50aW1lb3V0ID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MucmVzdG9yZSA9PT0gXCJzdHJpbmdcIikgZGFlbW9uQXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIGZsYWdzLnJlc3RvcmUpO1xuICAvLyBFMjM6IGEgbmV3IHNlc3Npb24ncyB3b3Jrc3BhY2UgaXMgd2hlcmUgYG9wZW5gIHJhbi4gQSByZXN0b3JlZCBvbmUga2VlcHMgaXRzIG93bi5cbiAgZWxzZSBkYWVtb25BcmdzLnB1c2goXCItLXdvcmtzcGFjZVwiLCBwcm9jZXNzLmN3ZCgpKTtcblxuICBjb25zdCBjd2QgPSBkYWVtb25Dd2QoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGN3ZCkpXG4gICAgZGllKFxuICAgICAgYHNjcmlwdG9yaXVtIGNhbm5vdCBzdGFydCBpdHMgZGFlbW9uOiB0aGUgd29ya2luZyBkaXJlY3RvcnkgaXQgbmVlZHMgaXMgbWlzc2luZyDigJQgJHtjd2R9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogXCJkZXYgbW9kZSB3YXMgcmVzb2x2ZWQgKG5vIGRpc3QvaW5kZXguaHRtbCBhbmQgbm8gU1BFTExCT09LX1NVUkZBQ0VfTU9ERT1yZWxlYXNlKSwgd2hpY2ggbmVlZHMgc3JjL3NjcmlwdG9yaXVtLyDigJQgcmVpbnN0YWxsIHRoZSBzcGVsbCBvciBidWlsZCBpdFwiLFxuICAgICAgfSxcbiAgICApO1xuICAvLyBUaGUgZGFlbW9uJ3Mgc3RkZXJyIGdvZXMgdG8gYSBMT0cgRklMRSwgbm90IHRvIHRoaXMgQ0xJJ3Mgc3RkZXJyLiBBblxuICAvLyBpbmhlcml0ZWQgc3RkZXJyIG91dGxpdmVzIHRoZSBDTEkgaW5zaWRlIHRoZSBkZXRhY2hlZCBkYWVtb24sIHNvIGFueSBjYWxsZXJcbiAgLy8gdGhhdCByZWFkcyBgb3BlbmAncyBzdGRlcnIgdG8gRU9GIChhIHRlc3QgaGFybmVzcywgYSB0b29sIHJ1bm5lcikgd2FpdHMgZm9yXG4gIC8vIHRoZSB3aG9sZSBzZXNzaW9uIOKAlCBtZWFzdXJlZDogdGhlIGludGVncmF0aW9uIGNlbGwgaHVuZyBhdCBpdHMgNjAgcyB0aW1lb3V0LlxuICAvLyBBIGZpbGUgaG9sZHMgbm8gcGlwZSwgYW5kIGEgc3RhcnQgZmFpbHVyZSBiZWxvdyBxdW90ZXMgaXRzIHRhaWwuXG4gIGNvbnN0IGxvZ0RpciA9IGpvaW4oc2NyaXB0b3JpdW1Ib21lKCksIFwibG9nc1wiKTtcbiAgbWtkaXJTeW5jKGxvZ0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIC8vIFZlcmlmeS1wYXNzIGZpeCA2OiB0aGUgbG9ncyB1c2VkIHRvIHBpbGUgdXAsIG9uZSBwZXIgYG9wZW5gLCBmb3JldmVyLlxuICBwcnVuZUxvZ3MobG9nRGlyKTtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4obG9nRGlyLCBgZGFlbW9uLSR7RGF0ZS5ub3coKX0tJHtwcm9jZXNzLnBpZH0ubG9nYCk7XG4gIGRhZW1vbkFyZ3MucHVzaChcIi0tbG9nXCIsIGxvZ1BhdGgpO1xuICBjb25zdCBsb2dGZCA9IG9wZW5TeW5jKGxvZ1BhdGgsIFwiYVwiKTtcbiAgY29uc3QgY2hpbGQgPSBzcGF3bihcImJ1blwiLCBkYWVtb25BcmdzLCB7XG4gICAgY3dkLFxuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIGxvZ0ZkXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICB9KTtcbiAgY2xvc2VTeW5jKGxvZ0ZkKTtcbiAgY2hpbGQudW5yZWYoKTtcblxuICBjb25zdCBzdGFydFRpbWVvdXRNcyA9XG4gICAgdHlwZW9mIGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBNYXRoLm1heCg1MDAwLCBOdW1iZXIucGFyc2VJbnQoZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdLCAxMCkgKiAxMDAwKVxuICAgICAgOiA0NTAwMDtcbiAgY29uc3QgbGluZSA9IGF3YWl0IG5ldyBQcm9taXNlPHN0cmluZz4oKHJlcywgcmVqKSA9PiB7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KFxuICAgICAgKCkgPT5cbiAgICAgICAgcmVqKFxuICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBkYWVtb24gc3RhcnQgdGltZW91dCAoJHtzdGFydFRpbWVvdXRNcyAvIDEwMDB9cykg4oCUIHBhc3MgLS1zdGFydC10aW1lb3V0IDxzZWNvbmRzPmAsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgIHN0YXJ0VGltZW91dE1zLFxuICAgICk7XG4gICAgY2hpbGQuc3Rkb3V0Py5vbihcImRhdGFcIiwgKGNodW5rOiBCdWZmZXIpID0+IHtcbiAgICAgIGJ1ZiArPSBjaHVuay50b1N0cmluZygpO1xuICAgICAgY29uc3QgbmwgPSBidWYuaW5kZXhPZihcIlxcblwiKTtcbiAgICAgIGlmIChubCA+PSAwKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHJlcyhidWYuc2xpY2UoMCwgbmwpLnRyaW0oKSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJlcnJvclwiLCAoZXJyKSA9PiB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgcmVqKGVycik7XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJleGl0XCIsIChjb2RlKSA9PiB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgcmVqKG5ldyBFcnJvcihgZGFlbW9uIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfSBiZWZvcmUgaXRzIGhhbmRzaGFrZWApKTtcbiAgICB9KTtcbiAgfSkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICAgIGxldCB0YWlsID0gXCJcIjtcbiAgICB0cnkge1xuICAgICAgdGFpbCA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0ZjhcIikudHJpbSgpLnNsaWNlKC04MDApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm8gbG9nIHdyaXR0ZW4gKi9cbiAgICB9XG4gICAgZGllKFxuICAgICAgYHNjcmlwdG9yaXVtIGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgICB7IGhpbnQ6IHRhaWwgPyBgZGFlbW9uIGxvZyAoJHtsb2dQYXRofSk6ICR7dGFpbH1gIDogYGRhZW1vbiBsb2c6ICR7bG9nUGF0aH1gIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gUmVsZWFzZSB0aGUgZGFlbW9uJ3Mgc3Rkb3V0IHBpcGUsIG9yIHRoaXMgQ0xJJ3MgbmF0dXJhbCByZXR1cm4gd2FpdHMgb24gYVxuICAvLyBzdHJlYW0gdGhhdCBuZXZlciBjbG9zZXMgKGdsYW1vdXIgbWVhc3VyZWQgOTEgcyDihpIgMSBzKS4gQ2hlY2tlZCBmb3IgdGhlXG4gIC8vIE1FVEhPRDogdW5kZXIgQnVuIHRoaXMgcGlwZSBpcyBhIHBsYWluIFJlYWRhYmxlIHRoYXQgbm9uZXRoZWxlc3MgaGFzIHVucmVmLlxuICBjb25zdCBvdXQgPSBjaGlsZC5zdGRvdXQ7XG4gIGlmICghb3V0IHx8ICEoXCJ1bnJlZlwiIGluIG91dCkgfHwgdHlwZW9mIG91dC51bnJlZiAhPT0gXCJmdW5jdGlvblwiKVxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwic2NyaXB0b3JpdW06IHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSBoYXMgbm8gdW5yZWYoKTsgYG9wZW5gIHdvdWxkIG5ldmVyIGV4aXRcIixcbiAgICApO1xuICBvdXQudW5yZWYoKTtcblxuICBsZXQgaHM6IHtcbiAgICB1cmw6IHN0cmluZztcbiAgICBwb3J0OiBudW1iZXI7XG4gICAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICAgIG9rPzogYm9vbGVhbjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gIH07XG4gIHRyeSB7XG4gICAgaHMgPSBKU09OLnBhcnNlKGxpbmUpO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHVuZXhwZWN0ZWQgb3V0cHV0IGZyb20gZGFlbW9uOiAke2xpbmV9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuICBpZiAoaHMub2sgPT09IGZhbHNlKSBkYWVtb25SZWZ1c2VkKFwib3BlblwiLCBocy5zdGF0dXMgPz8gNTAwLCBocyk7XG5cbiAgbGV0IGVudHJpZXM6IHVua25vd25bXSA9IFtdO1xuICBpZiAocGF0aHMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHIgPSBhd2FpdCBwb3N0Q21kKGhzLnNlc3Npb25faWQsIHsgdHlwZTogXCJjb250ZXh0LmFkZFwiLCBwYXRocyB9KTtcbiAgICBlbnRyaWVzID0gKHIuZW50cmllcyBhcyB1bmtub3duW10pID8/IFtdO1xuICB9XG4gIHByaW50SnNvbih7IC4uLmhzLCAuLi4ocGF0aHMubGVuZ3RoID4gMCA/IHsgZW50cmllcyB9IDoge30pIH0pO1xuXG4gIGlmICghZmxhZ3NbXCJuby1vcGVuXCJdKSB7XG4gICAgY29uc3Qgb3BlbmVyID1cbiAgICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgICBzcGF3bihvcGVuZXIsIFtocy51cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFkZChwb3M6IHN0cmluZ1tdLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgY29uc3QgcGF0aHMgPSBjb250ZXh0UGF0aHMocG9zKTtcbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmdWxsOiBib29sZWFuKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIGAvc3RhdGUke2Z1bGwgPyBcIj9mdWxsPTFcIiA6IFwiXCJ9YCk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcInN0YXRlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFNheUJvZHkoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHNvdXJjZXMgPSBbXG4gICAgcG9zLmxlbmd0aCA+IDAsXG4gICAgZmxhZ3Muc3RkaW4gPT09IHRydWUsXG4gICAgdHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiLFxuICBdLmZpbHRlcihCb29sZWFuKS5sZW5ndGg7XG4gIGlmIChzb3VyY2VzICE9PSAxKVxuICAgIGRpZShcbiAgICAgIHNvdXJjZXMgPT09IDBcbiAgICAgICAgPyBcInNheSBuZWVkcyBhIG1lc3NhZ2VcIlxuICAgICAgICA6IFwic2F5IHRha2VzIGl0cyBtZXNzYWdlIGZyb20gZXhhY3RseSBvbmUgcGxhY2U6IGFyZ3VtZW50cywgLS1zdGRpbiBvciAtLWJvZHktZmlsZVwiLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImdpdmUgdGhlIHRleHQgYXMgYXJndW1lbnRzLCBvciBwcm9zZSB0aHJvdWdoIC0tYm9keS1maWxlIDxwYXRoPiAvIC0tc3RkaW4gKG5ldmVyIGFuIHVucXVvdGVkIGhlcmVkb2MpXCIsXG4gICAgICAgIGNob2ljZXM6IFtcIi0tc3RkaW5cIiwgXCItLWJvZHktZmlsZVwiXSxcbiAgICAgIH0sXG4gICAgKTtcbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgaWYgKGZsYWdzLnN0ZGluID09PSB0cnVlKSB0ZXh0ID0gYXdhaXQgbmV3IFJlc3BvbnNlKEJ1bi5zdGRpbi5zdHJlYW0oKSkudGV4dCgpO1xuICBlbHNlIGlmICh0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIpIHRleHQgPSByZWFkRmlsZVN5bmMoZmxhZ3NbXCJib2R5LWZpbGVcIl0sIFwidXRmOFwiKTtcbiAgZWxzZSB0ZXh0ID0gcG9zLmpvaW4oXCIgXCIpO1xuICBpZiAoIXRleHQudHJpbSgpKSBkaWUoXCJzYXk6IHRoZSBtZXNzYWdlIGlzIGVtcHR5XCIsIFwidXNhZ2VcIik7XG4gIHJldHVybiB0ZXh0LnRyaW0oKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRoZSB0YWlsIGhhcyBhbHJlYWR5IHJlcG9ydGVkIHRoYXQgaXQgbG9zdCB0aGUgZGFlbW9uIChFNTUpLiBNb2R1bGVcbiAqIHNjb3BlIGJlY2F1c2UgYSB0YWlsIGlzIG9uZSBwcm9jZXNzIGRvaW5nIG9uZSB0aGluZywgYW5kIHRoZSB0d28gaG9va3MgdGhhdFxuICogcmVhZCBpdCBhcmUgaGFuZGVkIHRvIGEgY2xpZW50IHRoYXQgb3ducyBpdHMgb3duIGxvb3AuXG4gKi9cbmxldCBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcblxuLyoqXG4gKiBUaGUgd2F0Y2guIEVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgY2FwIHdpdGggb25lIGxpbmUgbmFtaW5nIHRoZSBuZXh0XG4gKiBhY3QgKGBzcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgKTogcmUtYXJtIE1vbml0b3IsIGdvIHRvIGEgYmFja2dyb3VuZFxuICogYC0tb25jZWAsIG9yIGNvbWUgYmFjayBmcm9tIGEgY2xvc2VkIG9yIGxvc3Qgc2Vzc2lvbiB3aXRoIGBvcGVuIC0tcmVzdG9yZWAuXG4gKiBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOiB0aGUgYWdlbnQgYWxyZWFkeSBrbm93cyB0aGVcbiAqIHNlc3Npb24sIGFuZCB0aGUgbGluZSB3b3VsZCBjb3VudCBhcyBub2lzZSBpbiB0aGUgd2luZG93J3Mgd2FrZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICBvOiB7IG9uY2U6IGJvb2xlYW47IHNpbmNlR2l2ZW46IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGNvbnN0IHJlQXJtID0gc2Vzc2lvbiAhPT0gdW5kZWZpbmVkIHx8IG8uc2luY2VHaXZlbjtcbiAgbGV0IGdyb3VuZGVkID0gby5zaW5jZUdpdmVuO1xuICBjb25zdCBwaW4gPSAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gW1wiLS1zZXNzaW9uXCIsIGJvdW5kSWRdIDogW10pO1xuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0+KFxuICAgIHtcbiAgICAgIHJlc29sdmU6ICgpID0+IHtcbiAgICAgICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgICBpZiAoIWJvdW5kSWQpIGJvdW5kSWQgPSBzLnNlc3Npb25faWQ7XG4gICAgICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZ3JvdW5kaW5nXCIsIHNlc3Npb25faWQ6IHMuc2Vzc2lvbl9pZCwgcG9ydDogcy5wb3J0IH0pfVxcbmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYGh0dHA6Ly8xMjcuMC4wLjE6JHtzLnBvcnR9YDtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6ICh7IGV2ZXJSZXNvbHZlZCB9KSA9PiB7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgZ2l2ZW4gLS1zZXNzaW9uIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HXG4gICAgICAgIC8vIHNlc3Npb24sIHNvIG5vdCBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZCAoaW4gdGhlIGdhcCwgc2F5KSDigJQgdGhlXG4gICAgICAgIC8vIGhhbmRvZmYgc2F5cyBgdGFpbC5jbG9zZWRgLCBuZXZlciBhIHNpbGVudCByZXRyeS1mb3JldmVyLlxuICAgICAgICBpZiAoZXZlclJlc29sdmVkIHx8IHJlQXJtKSByZXR1cm4gXCJzdG9wXCI7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZSxcbiAgICAgIC4uLihvLmVwb2NoID8geyBzaW5jZUVwb2NoOiBvLmVwb2NoIH0gOiB7fSksXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgICAgZXBvY2hPZjogKGV2KSA9PiAodHlwZW9mIGV2LmVwb2NoID09PSBcInN0cmluZ1wiID8gZXYuZXBvY2ggOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSBkaWZmZXJlbnQgZXBvY2ggb24gcmVjb25uZWN0ID0gdGhlIGRhZW1vbiByZXN0YXJ0ZWQ7IGlkcyBiZWdhbiBhZ2Fpbi5cbiAgICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgICB0ZXJtaW5hbDogKGV2KSA9PiBldi50eXBlID09PSBcImNsb3NlZFwiLFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgICAvLyDim5QgQSBLRUVQQUxJVkUgSVMgUFJPT0YgT0YgTElGRSwgc28gaXQgaXMgYWxzbyB3aGF0IGNsZWFycyBhIHJlcG9ydGVkXG4gICAgICAvLyBkaXNjb25uZWN0aW9uLiBUaGVyZSBpcyBubyBgb25Db25uZWN0YCBob29rIGFuZCB0aGlzIGlzIHRoZSBob25lc3RcbiAgICAgIC8vIHN1YnN0aXR1dGU6IHRoZSBkYWVtb24gb25seSBzZW5kcyBjb21tZW50cyBkb3duIGEgbGl2ZSBzdHJlYW0uXG4gICAgICBvbkNvbW1lbnQ6ICgpID0+IHtcbiAgICAgICAgaWYgKCFkaXNjb25uZWN0ZWQpIHJldHVybiBcIjogc2NyaXB0b3JpdW0ta2VlcGFsaXZlXCI7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcInRhaWwucmVjb25uZWN0ZWRcIiB9KTtcbiAgICAgIH0sXG4gICAgICAvLyDim5QgT05FIExJTkUgUEVSIEVQSVNPREUsIE5PVCBQRVIgQVRURU1QVC4gVGhlIGNsaWVudCByZWNvbm5lY3RzIHdpdGhcbiAgICAgIC8vIGJhY2tvZmYgZm9yZXZlciwgc28gYSBob29rIHRoYXQgc3Bva2UgZXZlcnkgdGltZSB3b3VsZCBlbWl0IGEgbGluZSBldmVyeVxuICAgICAgLy8gZmV3IHNlY29uZHMgZm9yIGFzIGxvbmcgYXMgdGhlIGRhZW1vbiBzdGF5ZWQgZG93biDigJQgd2hpY2ggaXMgaG93IGFcbiAgICAgIC8vIHdhdGNoZXIgZ2V0cyBtdXRlZCwgYW5kIHRoZW4gbm9ib2R5IGhlYXJzIHRoZSBuZXh0IHJlYWwgdGhpbmcuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIFdIWSBUSElTIEVYSVNUUyBBVCBBTEw6IHdpdGhvdXQgaXQgYSBERUFEIGRhZW1vbiBhbmQgYSBRVUlFVCBvbmUgYXJlXG4gICAgICAvLyB0aGUgc2FtZSB0aGluZyBmcm9tIG91dCBoZXJlLiBBIGdyYWNlZnVsIGNsb3NlIGVtaXRzIGBjbG9zZWRgIGFuZCBlbmRzXG4gICAgICAvLyB0aGUgdGFpbDsgYSBjcmFzaCwgYSBraWxsIC05IG9yIGEgc2xlZXBpbmcgbGFwdG9wIGVtaXRzIG5vdGhpbmcsIHRoZVxuICAgICAgLy8gY2xpZW50IHJldHJpZXMgaW4gc2lsZW5jZSwgYW5kIHRoZSBhYnNlbmNlIG9mIGV2ZW50cyBpcyBub3QgYW4gZXZlbnQuIEFcbiAgICAgIC8vIHdhdGNoZXIgd2FpdGluZyBmb3IgdGhlIGh1bWFuJ3MgbmV4dCBtZXNzYWdlIHdvdWxkIHdhaXQgZm9yZXZlciBhbmRcbiAgICAgIC8vIG5ldmVyIGxlYXJuIGl0IGhhZCBzdG9wcGVkIGxpc3RlbmluZy4gKEZvdW5kIDIwMjYtMDktMTQgd2hpbGUgYW5zd2VyaW5nXG4gICAgICAvLyBDb2xlJ3MgcXVlc3Rpb24gYWJvdXQgd2hldGhlciBhIHRpbWVvdXQgd291bGQgbm90aWZ5IG1lLiBJdCB3b3VsZCBub3QuKVxuICAgICAgb25EaXNjb25uZWN0OiAoeyBjYXVzZSwgc3RhdHVzIH0pID0+IHtcbiAgICAgICAgaWYgKGRpc2Nvbm5lY3RlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLmRpc2Nvbm5lY3RlZFwiLFxuICAgICAgICAgIGNhdXNlLFxuICAgICAgICAgIC4uLihzdGF0dXMgIT09IHVuZGVmaW5lZCA/IHsgc3RhdHVzIH0gOiB7fSksXG4gICAgICAgICAgbm90ZTogXCJyZXRyeWluZzsgdGhlIHNlc3Npb24gbWF5IGhhdmUgY2xvc2VkIG9yIGNyYXNoZWRcIixcbiAgICAgICAgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgc3BlbGw6IFwic2NyaXB0b3JpdW1cIixcbiAgICAgIG1vZGU6IG8ub25jZSA/IFwib25jZVwiIDogXCJ3YXRjaFwiLFxuICAgICAgcHJlc2VuY2U6IGZhbHNlLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2U6IGF0LCBvbmNlLCBlcG9jaCB9KSA9PiB0YWlsQ29tbWFuZChbXCJ0YWlsXCIsIC4uLnBpbigpXSwgYXQsIG9uY2UsIGVwb2NoKSxcbiAgICAgICAgY29tZUJhY2s6ICgpID0+IGNvbW1hbmRMaW5lKFtcIm9wZW5cIiwgXCItLXJlc3RvcmVcIiwgYm91bmRJZCA/PyBcIjxpZD5cIiwgXCItLW5vLW9wZW5cIl0pLFxuICAgICAgfSxcbiAgICB9LFxuICApO1xufVxuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKFNLSUxMX1JPT1QsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIiksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwic2NyaXB0b3JpdW1cIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoICovXG4gIH1cbiAgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vKipcbiAqIEUyNCdzIHZlcmJzOiB0aGUgYWdlbnQncyBoYWxmIG9mIHRoZSBzdHJ1Y3R1cmUgb3BzIHRoZSBodW1hbiByZWFjaGVzIGJ5IG1lbnVzXG4gKiBhbmQgZHJhZyBhbmQgZHJvcC4gRWFjaCByZXNvbHZlcyBpdHMgcGF0aHMgYWdhaW5zdCBUSElTIHByb2Nlc3MncyBjd2QgYW5kXG4gKiBwb3N0cyBvbmUgb3A7IHRoZSBkYWVtb24gZG9lcyB0aGUgY2hhbmdlIGFuZCBhbm5vdW5jZXMgaXQgaW4gdGhlIGNoYXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0cnVjdHVyZUNtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCBvcCkpO1xufVxuXG4vKiogYGltcG9ydCA8ZmlsZT5gOiB0aGUgZmlsZSdzIFRFWFQgaXMgc2VudCwgc28gdGhlIGRhZW1vbiB3cml0ZXMgYSBjb3B5IChFMjMpLiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kSW1wb3J0KGZpbGU6IHN0cmluZywgaW50bzogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgY29uc3QgYWJzID0gcmVzb2x2ZShmaWxlKTtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYG5vIHN1Y2ggZmlsZTogJHthYnN9YCwgXCJub3RfZm91bmRcIik7XG4gIH1cbiAgaWYgKCFzdC5pc0ZpbGUoKSB8fCAhaXNEb2NOYW1lKGFicykpXG4gICAgZGllKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHthYnN9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXM6IFsuLi5ET0NfRVhURU5TSU9OU10gfSk7XG4gIGF3YWl0IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7XG4gICAgdHlwZTogXCJpbXBvcnRcIixcbiAgICBuYW1lOiBhYnMuc3BsaXQoXCIvXCIpLnBvcCgpIGFzIHN0cmluZyxcbiAgICB0ZXh0OiByZWFkRmlsZVN5bmMoYWJzLCBcInV0ZjhcIiksXG4gICAgLi4uKGludG8gIT09IHVuZGVmaW5lZCA/IHsgaW50bzogcmVzb2x2ZShpbnRvKSB9IDoge30pLFxuICB9KTtcbn1cblxuLyoqIGB3b3Jrc3BhY2VgIGFsb25lIHByaW50cyBpdDsgYHdvcmtzcGFjZSA8ZGlyPmAgc2V0cyBpdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFdvcmtzcGFjZShkaXI6IHN0cmluZyB8IHVuZGVmaW5lZCwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmIChkaXIgIT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJ3b3Jrc3BhY2Uuc2V0XCIsIHBhdGg6IHJlc29sdmUoZGlyKSB9KTtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIik7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcIndvcmtzcGFjZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oeyB3b3Jrc3BhY2U6IChkYXRhIGFzIHsgd29ya3NwYWNlPzogdW5rbm93biB9KS53b3Jrc3BhY2UgfSk7XG59XG5cbi8vIOKUgOKUgCBUSEUgQ09NTUFORCBUQUJMRSDigJQgZGlzcGF0Y2gsIGhlbHAsIGBzY2hlbWFgIGFuZCBldmVyeSBgY2hvaWNlc2Agd2FsayBpdCDilIDilIBcblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xudHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG50eXBlIENvbW1hbmRTcGVjID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGZsYWdzOiByZWFkb25seSBGbGFnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICBkZXNjcmliZTogc3RyaW5nO1xuICBydW46IChcbiAgICBwb3M6IHN0cmluZ1tdLFxuICAgIGZsYWdzOiBGbGFncyxcbiAgICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICkgPT4gUHJvbWlzZTxudW1iZXI+IHwgUHJvbWlzZTx2b2lkPiB8IHZvaWQ7XG59O1xuXG5jb25zdCBTRVNTSU9OID0gW1wic2Vzc2lvblwiXSBhcyBjb25zdCBzYXRpc2ZpZXMgcmVhZG9ubHkgRmxhZ1tdO1xuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJuby1vcGVuXCIsIFwicmVzdG9yZVwiLCBcInRpbWVvdXRcIiwgXCJzdGFydC10aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic3Bhd24gYSBzZXNzaW9uIChvcGVucyB0aGUgYnJvd3NlciksIGFkZGluZyBwYXRoczsgcHJpbnRzIHt1cmwsIHBvcnQsIHNlc3Npb25faWR9LiAtLXRpbWVvdXQgPHNlY29uZHM+IHNldHMgdGhlIGlkbGUgY2xvc2UgKGRlZmF1bHQgMTgwMCk7IC0tdGltZW91dCAwIHN0YW5kcyB1bnRpbCBjbG9zZWRcIixcbiAgICBydW46IChwb3MsIGZsYWdzKSA9PiBjbWRPcGVuKHBvcywgZmxhZ3MpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhZGRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJhZGQgZmlsZXMgb3IgZm9sZGVycyB0byB0aGUgY29udGV4dCBsaXN0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZEFkZChwb3MsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmdWxsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJ0aGUgc2Vzc2lvbjogY29udGV4dCwgZG9jcyArIHZlcnNpb25zICh3aXRoIHBhdGhzKSwgYWN0aXZlLCBkaXJ0eSwgc2VsZWN0aW9uXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInNpbmNlXCIsIFwib25jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInRoZSBodW1hbidzIG1lc3NhZ2VzICh3aXRoIHNlbGVjdGlvbiArIGFjdGl2ZSBwYXRoKSBhcyBKU09OIGxpbmVzIOKAlCB3cmFwIHdpdGggTW9uaXRvcjsgaXRzIGxhc3QgbGluZSBuYW1lcyB0aGUgbmV4dCBhY3RcIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYiA9IHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlVGFpbFNpbmNlKGZsYWdzLnNpbmNlKSA6IHsgc2luY2U6IC0xIH07XG4gICAgICByZXR1cm4gY21kVGFpbChzZXNzaW9uLCBiLnNpbmNlLCB7XG4gICAgICAgIG9uY2U6IGZsYWdzLm9uY2UgPT09IHRydWUsXG4gICAgICAgIHNpbmNlR2l2ZW46IHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIixcbiAgICAgICAgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLW5ld1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJmcm9tXCIsIFwibGFiZWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImNvcHkgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgdG8gYSBuZXcgZmlsZTsgcHJpbnRzIGl0cyBwYXRoIHRvIGVkaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHR5cGVvZiBmbGFncy5mcm9tID09PSBcInN0cmluZ1wiID8gcGFyc2VWZXJzaW9uKGZsYWdzLmZyb20sIFwiLS1mcm9tXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24ubmV3XCIsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgICAuLi4oZnJvbSAhPT0gdW5kZWZpbmVkID8geyBmcm9tIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIiA/IHsgbGFiZWw6IGZsYWdzLmxhYmVsIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLWRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgdmVyc2lvbiBhbmQgaXRzIGZpbGUgKG5ldmVyIHRoZSBhY3RpdmUgb25lIOKAlCBhY3RpdmF0ZSBhbm90aGVyIGZpcnN0KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJ2ZXJzaW9uLWRlbGV0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBoYXZlIHN0YXJ0ZWQgc29tZXRoaW5nOyBwcmludHMgdGhlIGlkIHRvIGZpbmlzaCBpdCB3aXRoXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnN0YXJ0XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MpIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXN0YXR1c1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJzdGF0dXNcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzYXkgd2hhdCBzdGVwIGEgdGFzayBpcyBvbiAoZm9yIHdvcmsgd29ydGggd2F0Y2hpbmcpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ0YXNrLnN0YXR1c1wiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHN0YXR1czogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1kb25lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcIm91dGNvbWVcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibWFyayBhIHRhc2sgZmluaXNoZWQsIG9wdGlvbmFsbHkgc2F5aW5nIHdoYXQgY2FtZSBvZiBpdFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBvdXRjb21lID0gcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ0YXNrLmRvbmVcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICAuLi4ob3V0Y29tZSA/IHsgb3V0Y29tZSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1yZW1vdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJmb3JnZXQgYSB0YXNrIGVudGlyZWx5IOKAlCBmb3Igb25lIHN0YXJ0ZWQgYnkgbWlzdGFrZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5yZW1vdmVcIiwgaWQ6IHBvc1swXSBhcyBzdHJpbmcgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2tzLWNsZWFyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBldmVyeSBmaW5pc2hlZCB0YXNrOyBvdXRzdGFuZGluZyBvbmVzIGFyZSBsZWZ0IGFsb25lXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFza3MuY2xlYXJcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid29ya2luZ1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmb3JcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInNheSB5b3UgYXJlIHN0aWxsIG9uIGl0IOKAlCBzaWxlbmNlcyB0aGUgd2FpdGluZyBudWRnZSwga2VlcHMgdGhlIGh1bWFuJ3MgcHVsc2VcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3Qgc2Vjb25kcyA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5mb3IgPT09IFwic3RyaW5nXCIgPyBwYXJzZUNvdW50KGZsYWdzLmZvciwgXCJ3b3JraW5nIC0tZm9yXCIpIDogdW5kZWZpbmVkO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIndvcmtpbmdcIixcbiAgICAgICAgICAuLi4oc2Vjb25kcyAhPT0gdW5kZWZpbmVkID8geyBzZWNvbmRzIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInF1b3RlXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJub3RlIGEgcGFzc2FnZSBvZiB0aGUgYWN0aXZlIHZlcnNpb24gKC0tcXVvdGUgJ2V4YWN0IHRleHQnOyBwcm9zZTogLS1ib2R5LWZpbGUgb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLnF1b3RlICE9PSBcInN0cmluZ1wiIHx8IGZsYWdzLnF1b3RlLnRyaW0oKSA9PT0gXCJcIilcbiAgICAgICAgZGllKFwibm90ZTogLS1xdW90ZSBpcyByZXF1aXJlZCDigJQgdGhlIGV4YWN0IHRleHQgdGhlIG5vdGUgaXMgYWJvdXRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAtLWZ1bGwgKHRoZSBhY3RpdmUgdmVyc2lvbidzIHRleHQgaXMgb24gZGlzazsgcXVvdGUgZnJvbSBpdClcIixcbiAgICAgICAgfSk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibm90ZS5hZGRcIixcbiAgICAgICAgICBxdW90ZTogZmxhZ3MucXVvdGUsXG4gICAgICAgICAgYm9keTogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBub3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLWZ1bGwgaW5jbHVkZXMgcmVzb2x2ZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3Rlc1wiLFxuICAgICAgICAgIC4uLihmbGFncy5mdWxsID8geyBhbGw6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1lZGl0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInJld3JpdGUgd2hhdCBhIG5vdGUgc2F5cyAoaXRzIHBhc3NhZ2UgaXMgdW5jaGFuZ2VkKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmVkaXRcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3Muc2xpY2UoMSksIGZsYWdzKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1yZXNvbHZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInJlb3BlblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgbm90ZSBkZWFsdCB3aXRoICgtLXJlb3BlbiBwdXRzIGl0IGJhY2spXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVzb2x2ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHJlc29sdmVkOiAhZmxhZ3MucmVvcGVuLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgbm90ZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLnJlbW92ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdzYXZlZCcgZm9yIHRoZSBmaWxlIG9uIGRpc2spOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VhcmNoXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImxpbWl0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInF1ZXJ5XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic2VhcmNoIHRoZSBjb250ZXh0OiBmdXp6eSBvbiBuYW1lcywgZXhhY3QgaW4gdGV4dCDigJQgc2VhcmNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uIG9mIG9wZW4gZG9jdW1lbnRzLCB3aGljaCBncmVwIGNhbm5vdCBzZWVcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5saW1pdCA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MubGltaXQsIFwic2VhcmNoIC0tbGltaXRcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICAgICAgcXVlcnk6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgICAgICAuLi4obGltaXQgIT09IHVuZGVmaW5lZCA/IHsgbGltaXQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwid2hhdCBpcyB3b3J0aCBsb29raW5nIGF0IGluIHRoaXMgc2Vzc2lvbiDigJQgZWFjaCBmaW5kaW5nIG5hbWVzIHRoZSB2ZXJiIHRoYXQgZml4ZXMgaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2N0b3JcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9yZ2V0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKHJlZnVzZWQgd2hpbGUgdGhlIGZpbGUgZXhpc3RzIOKAlCB1c2UgaGlkZSB0byB0YWtlIG9uZSBvdXQgb2YgdGhlIGNvbnRleHQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJmb3JnZXRcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZGFuZ2xpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImxpbmtzIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCBmaWxlLCBsaW5lLCBhbmQgdGhlIHRhcmdldCBhcyB3cml0dGVuXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJkYW5nbGluZ1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJlbWl0IHRoaXMgQ0xJJ3MgYWNjIGRlY2xhcmF0aW9uICh3YWxrZWQgZnJvbSB0aGUgY29tbWFuZCB0YWJsZSlcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2hvdyB0aGlzIG1lc3NhZ2VcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuXTtcblxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG5jb25zdCBmaW5kQ29tbWFuZCA9ICh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQgPT5cbiAgQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbik7XG5cbi8qKiBUaGUgdmVyYiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCAoYSBzdHJpbmcgZmxhZyBjb25zdW1lcyBpdHMgdmFsdWUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmJUb2tlbihhcmd2OiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIGFyZ3ZbaSArIDFdID8/IG51bGw7XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYS5zbGljZSgyKSBhcyBGbGFnO1xuICAgICAgaWYgKGtleSBpbiBDTElfT1BUSU9OUyAmJiBDTElfT1BUSU9OU1trZXldLnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBDT01NQU5EUy5tYXAoKGMpID0+IGMubmFtZSk7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBGbGFnW10+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBDT01NQU5EUy5tYXAoKGMpID0+IFtjLm5hbWUsIGMuZmxhZ3NdKSxcbik7XG5leHBvcnQgY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgWy4uLihmaW5kQ29tbWFuZCh2ZXJiKT8uZmxhZ3MgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbmNvbnN0IHJlbmRlckZsYWcgPSAoazogRmxhZyk6IHN0cmluZyA9PlxuICBDTElfT1BUSU9OU1trXS50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZU9mKHNwZWM6IENvbW1hbmRTcGVjKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBzcGVjLm5hbWUsXG4gICAgLi4uc3BlYy5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgLi4uc3BlYy5mbGFncy5maWx0ZXIoKGspID0+IGsgIT09IFwic2Vzc2lvblwiKS5tYXAocmVuZGVyRmxhZyksXG4gIF0uam9pbihcIiBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWxwKCk6IHN0cmluZyB7XG4gIGNvbnN0IHJvd3MgPSBDT01NQU5EUy5tYXAoKGMpID0+IFt1c2FnZU9mKGMpLCBjLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ucm93cy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICBjb25zdCBib2R5ID0gcm93c1xuICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYHNjcmlwdG9yaXVtIOKAlCBhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93LlxuXG4gIE91dHB1dDogSlNPTiBvbiBzdGRvdXQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlCBleGNlcHQgdGFpbCAob25lIEpTT04gbGluZVxuICBwZXIgZXZlbnQpIGFuZCBoZWxwIChwcm9zZSkuIEZhaWx1cmVzOiBvbmUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXRcbiAgMiA9IHVzYWdlLCAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdC4gdGFpbCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIHJhdGhlciB0aGFuIGZhaWxpbmcsIGFuZCBlbmRzIDAgd2hlbiBpdHMgc2Vzc2lvbiBjbG9zZXMuIHRhaWxcbiAgJHtXSU5ET1dfSEVMUH0uYDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzOiBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdIGFzIHN0cmluZ1tdLFxuICAgICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgICB9KSksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgICAgLi4uQ09NTUFORFMubWFwKChjKSA9PiAoe1xuICAgICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgICAgYXJnczogWy4uLmMuZmxhZ3NdLm1hcChhcmcpLFxuICAgICAgICBwb3NpdGlvbmFsczogYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pKSxcbiAgICBdLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIC8vIFRoZSBraXQgZG9lcyBub3QgdHJpYWdlOyB0aGlzIGRvZXMuIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICAgIC8vICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzOyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gYXJndlswXSk7XG4gIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkIHx8IGFyZ3ZbMF0gPT09IFwidmVyc2lvblwiKSB7XG4gICAgaWYgKChpbnRlcmNlcHRvcj8ucnVucyA/PyBcInZlcnNpb25cIikgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcmludEpzb24odmVyc2lvbkluZm8oKSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBsZXQgY3VycmVudENvbW1hbmQgPSB2ZXJiVG9rZW4oYXJndik7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3MoYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikgfHwgZS5leHRyYT8uY2hvaWNlcyA9PT0gdW5kZWZpbmVkKSB0aHJvdyBlO1xuICAgIGNvbnN0IHNwZWMgPSBjdXJyZW50Q29tbWFuZCA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGZpbmRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgICBpZiAoc3BlYyAhPT0gdW5kZWZpbmVkKVxuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7IGhpbnQ6IGUuZXh0cmE/LmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7XG4gICAgICBoaW50OiBgbm8gdmVyYiBnaXZlbiDigJQgdmVyYnM6ICR7VkVSQlMuam9pbihcIiBcIil9IChydW46IGNsaS50cyBoZWxwKWAsXG4gICAgICBjaG9pY2VzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSksXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgW3ZlcmIsIC4uLnBvc10gPSBwYXJzZWQucG9zO1xuICBjb25zdCBmbGFncyA9IHBhcnNlZC5mbGFncztcbiAgY3VycmVudENvbW1hbmQgPSB2ZXJiID8/IG51bGw7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcblxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBbLi4uVkVSQlNdIH0pO1xuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQodmVyYik7XG4gIGlmIChzcGVjID09PSB1bmRlZmluZWQpXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcblxuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KHNwZWMuZmxhZ3MpO1xuICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKGZsYWdzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFjY2VwdGVkID0gZmxhZ3NGb3Ioc3BlYy5uYW1lKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3NwZWMubmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBzY3JpcHRvcml1bSBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgYWNjZXB0ZWQubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogYWNjZXB0ZWQgfSA6IHsgaGludDogYCR7c3BlYy5uYW1lfSB0YWtlcyBubyBmbGFnc2AgfSxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKVxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1c2FnZTogJHt1c2FnZU9mKHNwZWMpfWAsIHsgaGludDogc3BlYy5kZXNjcmliZSB9KTtcblxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuICBjb25zdCBjb2RlID0gYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2JhY2tsb2cvMjAyNi0wOS0yMi1zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0yMi1tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIGFsd2F5cyBnZXRzIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsXG4gKiAgICAgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzIGNvbm5lY3Rpb24gY2Fycmllcy5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzKSwgZWFjaCBuYW1pbmcgaG93IHRvIGNvbWUgYmFja1xuICogaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmUgYVxuICogcmVhbC1kYWVtb24gY2VsbCBpbiBgc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdGFpbC1oYW5kb2ZmLmludGVncmF0aW9uLnRlc3QudHNgLlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgcHJlc2VuY2UgdGFpbCAoYXN0cm9sYWJlLCBtaW5kLW1hcHBlcilcbiAqICAgICAgICAgICAgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHkgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBvcGVucyBub1xuICogYnJvd3NlciB0YWIuXG4gKlxuICog4pqgIEtOT1dOIEVER0UsIE5PVCBGSVhFRCAoZm91bmQgYnkgdGhlIHJlLXJldmlldyk6IGEga2V5ZWQgYm91bnR5IEZJUlNUIGFybVxuICogICAoYW4gYW50aGlsbCBzZWF0KSB3aG9zZSB3aW5kb3cgZW5kcyBiZWZvcmUgaXRzIGJvYXJkIGV2ZXIgb3BlbnMgcHJpbnRzIGFcbiAqICAgcmUtYXJtIHBpbm5lZCB0byB0aGUgZGVyaXZlZCBpZCB3aXRoIGFuIGVtcHR5IGJvb2ttYXJrXG4gKiAgIChgLS1zZXNzaW9uIGst4oCmIC0tc2luY2U9LTEgLS1vbmNlYCkuIFRoYXQgcmUtYXJtIGlzIGEgcmUtYXJtIGJ5IEQxJ3MgcnVsZSxcbiAqICAgc28gaWYgdGhlIGJvYXJkIGlzIHN0aWxsIG5vdCB1cCDigJQgdGhlIGxlYWQgbW9yZSB0aGFuIG9uZSB3aW5kb3cgKDI5IG1pbilcbiAqICAgbGF0ZSDigJQgdGhlIHNlYXQgZ2V0cyBgdGFpbC5jbG9zZWRgIGluc3RlYWQgb2Ygd2FpdGluZy4gTWlub3I6IHRoZVxuICogICBjb21lLWJhY2sgaXQgbmFtZXMgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApIGlzIHRoZSByaWdodCBuZXh0IHN0ZXAgYW55d2F5LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09NTUFORCBOQU1FUyBOTyBQQVRIIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbGluZSdzIGBjb21tYW5kYCBpcyB0aGUgVkVSQiBBTkQgSVRTIEFSR1VNRU5UUyBPTkxZXG4gKiAoYHRhaWwgLS1zZXNzaW9uIFggLS1zaW5jZSBOQEUgLS1vbmNlYCksIHBsdXMgYHNwZWxsYCwgYW5kIHRoZSBhZ2VudCBydW5zIGl0XG4gKiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzYC4gSXQgdXNlZFxuICogdG8gYmUgcnVubmFibGUgYXMgcHJpbnRlZCwgaGVhZGVkIGJ5IGBidW4gPGFyZ3ZbMV0+YCDigJQgYW5kIGZvciBhbiBpbnN0YWxsZWRcbiAqIHBsdWdpbiBgYXJndlsxXWAgaXMgaW5zaWRlIGEgVkVSU0lPTkVEIGNhY2hlIGRpcmVjdG9yeS4gQW4gdXBncmFkZSBtYXJrcyB0aGVcbiAqIG9sZCBkaXJlY3Rvcnkgb3JwaGFuZWQgYW5kIGRlbGV0ZXMgaXQgbGF0ZXIgKG1lYXN1cmVkIGluXG4gKiBgZG9jcy9iYWNrbG9nLzIwMjYtMDktMjQtdGFpbC1yZWFybS1jb21tYW5kLW5hbWVzLWEtdmVyc2lvbmVkLXBsdWdpbi1wYXRoLm1kYCksXG4gKiBzbyBhIGxpbmUgcHJpbnRlZCBiZWZvcmUgYW4gdXBncmFkZSBmaXJzdCByYW4gU1RBTEUgY29kZSBhZ2FpbnN0IGEgbmV3ZXJcbiAqIGRhZW1vbiwgdGhlbiBmYWlsZWQgd2l0aCBcIm1vZHVsZSBub3QgZm91bmRcIiBvbmNlIHRoZSBkaXJlY3Rvcnkgd2FzIGdvbmUuIE5vXG4gKiBzdGFibGUgcGF0aCBleGlzdHMgdG8gcHJpbnQgaW5zdGVhZDogdGhlIGNhY2hlLCBgJENMQVVERV9QTFVHSU5fUk9PVGAgYW5kIHRoZVxuICogaW5zdGFsbCByZWNvcmQgYXJlIGFsbCB2ZXJzaW9uZWQuXG4gKiAgIFRoZSBza2lsbCdzIGxhdW5jaGVyIGlzIGFsd2F5cyB0aGUgdmVyc2lvbiB0aGUgc2Vzc2lvbiBsb2FkZWQuIENvbGUnc1xuICogcmVhc29uaW5nOiB0aGUgd29yc3QgY2FzZSBpcyB0aGF0IHRoZSBDTEkgY2hhbmdlZCBhbmQgdGhlIGFnZW50IGdldHMgYW5cbiAqIGVycm9yIOKAlCBhbmQgaWYgdGhlIHRvb2xzIGFyZSBkZXNpZ25lZCByaWdodCwgdGhhdCBlcnJvciBzYXlzIHdoYXQgd2VudFxuICogd3JvbmcuIFNvIHRoZSBwYXJzZXJzIGFyZSB0aGUgb3RoZXIgaGFsZiBvZiB0aGlzIHJ1bGluZzogYHJlYWRTaW5jZWAgcmVmdXNlc1xuICogYW55IGAtLXNpbmNlYCBmb3JtIGEgdGFpbCBkb2VzIG5vdCBhY2NlcHQgd2l0aCBhIHVzYWdlIGVycm9yIE5BTUlORyB0aGVcbiAqIGZvcm1zIGl0IGRvZXMsIHRoZSBzYW1lIHdheSBvbiBhbGwgZWlnaHQgdGFpbHMsIGluc3RlYWQgb2YgbWlzcGFyc2luZyBpdC5cbiAqICAgTm90IHRha2VuOiBwcmludGluZyB0aGUgcGF0aCBBTkQgdGhlIGFyZ3MgKG9wdGlvbiBBIG9mIHRoZSBpdGVtIOKAlCB0d29cbiAqIGNvbW1hbmRzIHdoZXJlIG9uZSBpcyB3cm9uZyBhZnRlciBhbiB1cGdyYWRlKTsgYSBsYXVuY2hlciB0aGF0IG5vdGljZXMgaXQgaXNcbiAqIG9ycGhhbmVkIGFuZCByZS1leGVjcyBhIG5ld2VyIHNpYmxpbmcgKEIg4oCUIGl0IGxlYW5zIG9uIGEgQ2xhdWRlIENvZGVcbiAqIGludGVybmFsIG1hcmtlciBhbmQgZG9lcyBub3RoaW5nIG9uY2UgdGhlIGRpcmVjdG9yeSBpcyBkZWxldGVkKTsgdmVyc2lvblxuICogbmVnb3RpYXRpb24uXG4gKlxuICog4pqWIGAtLW9uY2VgIEVORFMgT04gVEhFIEZJUlNUIEZSQU1FLCB3aXRoIG5vIGRyYWluLiBBIGJ1cnN0IGFycml2ZXMgc3BsaXQ6IHRoZVxuICogICBmaXJzdCBldmVudCBvbiB0aGUgb25lLXNob3QsIHRoZSByZXN0IG9uIHRoZSBNb25pdG9yIHJlLWFybSwgd2hpY2ggbG9zZXNcbiAqICAgbm90aGluZyBiZWNhdXNlIG9mIHRoZSBib29rbWFyay4gVGhlIHNwaWtlIG9mZmVyZWQgYSB+MjAwIG1zIGRyYWluIGFzIGFuXG4gKiAgIG9wdGlvbiwgbm90IGEgcmVxdWlyZW1lbnQ7IG5vdCB0YWtlbiwgYmVjYXVzZSBpdCBhZGRzIGEgdGltZXIgdG8gdGhlXG4gKiAgIGV4aXQgcGF0aCB3aG9zZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byBtYWtlIGltcG9zc2libGUuXG4gKiDimpYgVEhFIExJTkUnUyBgY29tbWFuZGAgSVMgQ09NUExFVEUgQlVUIEZPUiBUSEUgTEFVTkNIRVI6IHBpbm5lZCB0byB0aGVcbiAqICAgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlIHNraWxscyBuYW1lIHRoZVxuICogICBydWxlIG9uY2UsIGxhdW5jaGVyIGZvcm0gaW5jbHVkZWQ7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICAvKiogVGhlIHZlcmIgYW5kIGl0cyBhcmd1bWVudHMgT05MWSDigJQgbm8gbGF1bmNoZXIsIG5vIHBhdGguIFRoZSBhZ2VudCBydW5zXG4gICAqICBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5gLiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKiBIb3cgdGhlIGFnZW50IHJ1bnMgYSBwcmludGVkIGBjb21tYW5kYDogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBuZXZlciBhIHBhdGhcbiAqICB0aGlzIHByb2Nlc3MgbmFtZXMgKHRoZSBydWxpbmcgb24gdGhlIHZlcnNpb25lZCBwbHVnaW4gcGF0aCwgaW4gdGhlIGhlYWRlcikuICovXG5leHBvcnQgY29uc3QgUlVOX1dJVEhfTEFVTkNIRVIgPSBcImJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+XCI7XG5cbi8qKiBUaGUgY29tZS1iYWNrIGhpbnQsIHdpdGggaG93IHRvIFJFU1VNRSBhZnRlciBjb21pbmcgYmFjayAoRDIpOiBhIHJlc3RvcmVkXG4gKiAgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgbWVhbnMgbm90aGluZyB0aGVyZS4gKi9cbmNvbnN0IENPTUVfQkFDSyA9ICh3aHk6IHN0cmluZykgPT5cbiAgYCR7d2h5fSBUbyBicmluZyBpdCBiYWNrLCBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn07IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBzcGVsbDogcy5zcGVsbCwgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLTEgZm9yIGV2ZXJ5dGhpbmcpXCJcbiAgICAgIDogYGFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyLCAke21pbn0gb3IgbW9yZSlgO1xuICBjb25zdCBmb3JtcyA9IG8uZXBvY2ggPyBgJHtpZH0sIG9yIDxpZD5APGVwb2NoPiBhcyBhIGhhbmRvZmYgbGluZSBwcmludHMgaXRgIDogaWQ7XG4gIGNvbnN0IHdoeSA9XG4gICAgIW8uZXBvY2ggJiYgdG9rZW4uaW5jbHVkZXMoXCJAXCIpXG4gICAgICA/IGA7IHRoaXMgc3BlbGwncyBsb2cgc3RhbXBzIG5vIGVwb2NoLCBzbyBwYXNzIHRoZSBpZCB3aXRob3V0IHRoZSBcIkDigKZcIiBwYXJ0YFxuICAgICAgOiBcIlwiO1xuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBtZXNzYWdlOiBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhIGJvb2ttYXJrIHRoaXMgdGFpbCBhY2NlcHRzIOKAlCBnaXZlICR7Zm9ybXN9JHt3aHl9YCxcbiAgfTtcbn1cblxuLyoqIEpvaW4gYW4gYXJndiBpbnRvIG9uZSBydW5uYWJsZSBjb21tYW5kIGxpbmUuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZExpbmUoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYXJndi5tYXAoc2hlbGxRdW90ZSkuam9pbihcIiBcIik7XG59XG5cbi8qKiBUaGUgcmUtYXJtIGZvciBhIHNwZWxsIHdob3NlIHRhaWwgaXMgYDxwcmVmaXjigKY+IC0tc2luY2UgTltAZXBvY2hdIFstLW9uY2VdYC5cbiAqICBQYXNzIGBlcG9jaGAgb25seSBmb3IgYSBzcGVsbCB3aG9zZSBgLS1zaW5jZWAgcGFyc2VzIGl0IChgcGFyc2VCb29rbWFya2ApLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxDb21tYW5kKFxuICBwcmVmaXg6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBzaW5jZTogbnVtYmVyLFxuICBvbmNlOiBib29sZWFuLFxuICBlcG9jaD86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIC8vIOKaoCBBIG5lZ2F0aXZlIGJvb2ttYXJrIChub3RoaW5nIHNlZW4geWV0KSBpcyBzcGVsbGVkIGAtLXNpbmNlPS0xYDogdGhlXG4gIC8vIHBhcnNlcnMgcmVhZCBhIGJhcmUgYC0xYCBhZnRlciBhIGZsYWcgYXMgYW5vdGhlciBmbGFnIGFuZCByZWZ1c2UgaXQuXG4gIGNvbnN0IG1hcmsgPSBlcG9jaCA/IGAke3NpbmNlfUAke2Vwb2NofWAgOiBTdHJpbmcoc2luY2UpO1xuICBjb25zdCBhdCA9IHNpbmNlIDwgMCA/IFtgLS1zaW5jZT0ke21hcmt9YF0gOiBbXCItLXNpbmNlXCIsIG1hcmtdO1xuICByZXR1cm4gY29tbWFuZExpbmUoWy4uLnByZWZpeCwgLi4uYXQsIC4uLihvbmNlID8gW1wiLS1vbmNlXCJdIDogW10pXSk7XG59XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZPcHRpb25zPEV2PiA9IHtcbiAgLyoqIFRoZSBzcGVsbCdzIG5hbWUsIGNhcnJpZWQgb24gdGhlIGxpbmUgKHdob3NlIGxhdW5jaGVyIHJ1bnMgaXQpLiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIEEgcHJlc2VuY2Ugc3BlbGw6IGFsd2F5cyBgdGFpbC53aW5kb3dgIGF0IHRoZSB3aW5kb3cncyBlbmQsIG5ldmVyIGxvc3QuICovXG4gIHByZXNlbmNlOiBib29sZWFuO1xuICAvKiogRGVmYXVsdDogYHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSlgLiBgMGAgPSBubyB3aW5kb3cuICovXG4gIHdpbmRvd01zPzogbnVtYmVyO1xuICAvKiogV2hldGhlciBhbiBlbWl0dGVkIGZyYW1lIGlzIGEgTE9HIGZyYW1lIChBMykuIERlZmF1bHQ6IGV2ZXJ5IG9uZS4gKi9cbiAgY291bnRzPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogV2hpY2ggdGVybWluYWwgZnJhbWUgbWVhbnMgdGhlIHNlc3Npb24gY2xvc2VkLiBEZWZhdWx0OiBldmVyeSB0ZXJtaW5hbC4gKi9cbiAgaXNDbG9zZWQ/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gdGFpbC5zaW5jZUVwb2NoO1xuICBsZXQgZnJhbWVIYXNJZCA9IGZhbHNlO1xuICAvKiogQTMgKyBEMzogYSBmcmFtZSBjb3VudHMsIGFuZCB3YWtlcyBhIGAtLW9uY2VgLCBvbmx5IHdoZW4gaXQgaXMgT04gVEhFXG4gICAqICBMT0cg4oCUIGl0IGNhcnJpZXMgYSBsb2cgaWQg4oCUIGFuZCB0aGUgc3BlbGwncyBvd24gYGNvdW50c2AgYWdyZWVzLiBBIHRhYidzXG4gICAqICBpZC1sZXNzIGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgIHBpbmcgaXMgbm90IG9uIHRoZSBsb2cuICovXG4gIGNvbnN0IGlzTG9nRnJhbWUgPSAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGZyYW1lSGFzSWQgJiYgY291bnRzKGV2LCBmcmFtZSk7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlZnVzYWxzID0gMDtcblxuICBjb25zdCBmaW5pc2ggPSAoZTogVGFpbEVuZCkgPT4ge1xuICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IGU7XG4gICAgYWMuYWJvcnQoKTtcbiAgfTtcbiAgY29uc3QgdGltZXIgPVxuICAgIGgubW9kZSA9PT0gXCJ3YXRjaFwiICYmIHdpbmRvd01zID4gMCA/IHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKFwid2luZG93XCIpLCB3aW5kb3dNcykgOiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29kZSA9IGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICAgIC4uLnRhaWwsXG4gICAgICBzaWduYWw6IGFjLnNpZ25hbCxcbiAgICAgIC8vIEQyJ3MgbmV0LiBPbiBmb3IgZXZlcnkgc3BlbGw6IGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvclxuICAgICAgLy8gbWVhbnMgYSB3aG9sZSByZXBsYXkgb24gdGhlIGtpdCdzIGxvZywgYW5kIG9uIGdyYXBldmluZSdzIGR1cmFibGUgbG9nXG4gICAgICAvLyBpdCBoYXBwZW5zIG9ubHkgd2hlbiBgLS1sYXN0YCByZWFjaGVzIGJlbG93IGAtLXNpbmNlYCwgd2hlcmVcbiAgICAgIC8vIHJlLXJlYWRpbmcgdGhlIGN1cnNvciBmcm9tIHRoZSBmcmFtZXMgaXMgdGhlIG1vcmUgY29ycmVjdCBhbnN3ZXIuXG4gICAgICByZXN0YXJ0T25SZXBsYXk6IHRydWUsXG4gICAgICAvLyBEMzogcmVtZW1iZXIgd2hldGhlciBUSElTIGZyYW1lIGNhcnJpZXMgYSBsb2cgaWQuIGB0YWlsRXZlbnRzYCByZWFkc1xuICAgICAgLy8gdGhlIGN1cnNvciBvbmNlIHBlciBmcmFtZSwgYmVmb3JlIGBhY2NlcHRgLCBgdGVybWluYWxgIGFuZCBgcmVuZGVyYC5cbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgY29uc3QgbiA9IHRhaWwuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgIGZyYW1lSGFzSWQgPSB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobik7XG4gICAgICAgIHJldHVybiBuO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBEMTogYSB0YWlsIHRoYXQgZ2l2ZXMgdXAgb24gZmluZGluZyBpdHMgc2Vzc2lvbiBpcyB3YXRjaGluZyBhXG4gICAgICAgIC8vIHNlc3Npb24gdGhhdCBpcyBnb25lIOKAlCB3aGV0aGVyIHRoaXMgcHJvY2VzcyBldmVyIHJlYWNoZWQgaXQgKGl0c1xuICAgICAgICAvLyBwb2ludGVyIHZhbmlzaGVkKSBvciBpdCB3YXMgcmUtYXJtZWQgYXQgb25lIHRoYXQgY2xvc2VkIGluIHRoZSBnYXAuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBlbmQgPT09IG51bGwpIGVuZCA9IFwiY2xvc2VkXCI7XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaC5tb2RlID09PSBcIm9uY2VcIiAmJiBhY2NlcHRlZCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIG9uQ29tbWVudDogKHRleHQpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICByZXR1cm4gdGFpbC5vbkNvbW1lbnQ/Lih0ZXh0KSA/PyBudWxsO1xuICAgICAgfSxcbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwub25EaXNjb25uZWN0Py4oaW5mbykgPz8gbnVsbDtcbiAgICAgICAgaWYgKGluZm8uY2F1c2UgPT09IFwiY29ubmVjdC1mYWlsZWRcIikge1xuICAgICAgICAgIHJlZnVzYWxzICs9IDE7XG4gICAgICAgICAgaWYgKGVuZE9uTG9zdCAmJiByZWZ1c2FscyA+PSBMT1NUX0FGVEVSX1JFRlVTQUxTKSBmaW5pc2goXCJsb3N0XCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRoZSBkYWVtb24gYW5zd2VyZWQgKGEgc3RhdHVzLCBvciBhIHN0cmVhbSB0aGF0IG9wZW5lZCBhbmQgdGhlblxuICAgICAgICAgIC8vIGVuZGVkKTogaXQgaXMgYWxpdmUsIHNvIHRoZSByZWZ1c2FscyB3ZXJlIG5vdCBpbiBhIHJvdy5cbiAgICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgb25FbmQ6IChzKSA9PiB7XG4gICAgICAgIGN1cnNvciA9IHMuY3Vyc29yO1xuICAgICAgICBlcG9jaCA9IHMuZXBvY2ggPz8gdW5kZWZpbmVkO1xuICAgICAgICB0YWlsLm9uRW5kPy4ocyk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGxpbmUgPSBoYW5kb2ZmKFxuICAgICAge1xuICAgICAgICBlbmQ6IGVuZCA/PyBcInN0b3BwZWRcIixcbiAgICAgICAgbW9kZTogaC5tb2RlLFxuICAgICAgICBldmVudHMsXG4gICAgICAgIGN1cnNvcixcbiAgICAgICAgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pLFxuICAgICAgICBwcmVzZW5jZTogaC5wcmVzZW5jZSxcbiAgICAgICAgc3BlbGw6IGguc3BlbGwsXG4gICAgICB9LFxuICAgICAgaC5jb21tYW5kcyxcbiAgICApO1xuICAgIGlmIChsaW5lICE9PSBudWxsKSBvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkobGluZSl9XFxuYCk7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHRhaWwuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8qKlxuICogQ29udGV4dCBlbnRyaWVzIG9uIGRpc2sg4oCUIGJ1aWxkaW5nIGFuIGVudHJ5IGZyb20gYSBwYXRoIChFMTUncyBvbmUgbW9kZWwpLFxuICogbWlycm9yaW5nIGEgZm9sZGVyIGludG8gYSBub2RlIHRyZWUsIGFuZCBsaXN0aW5nIGEgZGlyZWN0b3J5IGZvciB0aGVcbiAqIHN1cmZhY2UncyBwYXRoIGNvbXBsZXRpb24gKGBmcy5saXN0YCkuXG4gKlxuICogUHVyZSBvdmVyIHRoZSBmaWxlc3lzdGVtOiBubyBkYWVtb24gc3RhdGUsIHNvIHRoZSB1bml0IGNlbGxzIGRyaXZlIGl0IHdpdGggYVxuICogdGVtcCBkaXJlY3RvcnkgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRleHRFbnRyeSwgQ29udGV4dE5vZGUsIEZzTGlzdEVudHJ5IH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIFdoYXQgc2NyaXB0b3JpdW0gb3BlbnMgYXMgYSBkb2N1bWVudC4gRXZlcnl0aGluZyBlbHNlIGlzIG5vdCBzaG93bi4gKi9cbmV4cG9ydCBjb25zdCBET0NfRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNEb2NOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIERPQ19FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSk7XG59XG5cbi8qKiBEaXJlY3RvcmllcyBhIG1pcnJvciBuZXZlciBkZXNjZW5kcyBpbnRvIOKAlCBub2lzZSwgbm90IGRvY3VtZW50cy4gKi9cbmNvbnN0IFNLSVBfRElSUyA9IG5ldyBTZXQoW1wibm9kZV9tb2R1bGVzXCIsIFwiLmdpdFwiLCBcImRpc3RcIiwgXCJvdXRcIiwgXCJjb3ZlcmFnZVwiXSk7XG5cbi8qKlxuICogVGhlIG1vc3Qgbm9kZXMgb25lIG1pcnJvcmVkIHNjYW4gd2lsbCBob2xkLiBBIGZvbGRlciBlbnRyeSBwb2ludGVkIGF0IGEgaHVnZVxuICogdHJlZSBtdXN0IG5vdCBzdGFsbCB0aGUgZGFlbW9uIG9yIGZsb29kIGV2ZXJ5IHN0YXRlIGJyb2FkY2FzdDsgaGl0dGluZyB0aGVcbiAqIGNhcCBzZXRzIGB0cnVuY2F0ZWRgIG9uIHRoZSBlbnRyeSBzbyB0aGUgc3VyZmFjZSBjYW4gU0FZIHRoZSBsaXN0IGlzIHNob3J0XG4gKiByYXRoZXIgdGhhbiByZW5kZXIgYSBzaG9ydCBsaXN0IGFzIGEgY29tcGxldGUgb25lLlxuICovXG5leHBvcnQgY29uc3QgTUlSUk9SX05PREVfQ0FQID0gMjAwMDtcblxuZXhwb3J0IGNvbnN0IHRvUG9zaXggPSAocDogc3RyaW5nKSA9PiBwLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG5cbi8qKlxuICogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuXG4gKiBgaGlkZGVuYCByZWxzIChFMjQncyBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIpIGFyZSBza2lwcGVkLCBhIGZvbGRlciB3aXRoXG4gKiBldmVyeXRoaW5nIHVuZGVyIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuICBoaWRkZW46IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4pOiB7IG5vZGVzOiBDb250ZXh0Tm9kZVtdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoaGlkZGVuKTtcbiAgY29uc3Qgd2FsayA9IChkaXI6IHN0cmluZyk6IENvbnRleHROb2RlW10gPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXBzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgY29uc3QgZG9jczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcy5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gY2FwKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKHJvb3QsIGFicykpO1xuICAgICAgaWYgKHNraXAuaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHdhbGsoYWJzKTtcbiAgICAgICAgLy8gQSBmb2xkZXIgaG9sZGluZyBvbmx5IG5vbi1kb2N1bWVudHMgKGltYWdlcywgYXNzZXRzKSBpcyBub2lzZSBpbiBhXG4gICAgICAgIC8vIGRvY3MgbWlycm9yIGFuZCBpcyBsZWZ0IG91dC4gQSBUUlVMWSBFTVBUWSBmb2xkZXIgaXMga2VwdDogaXQgaXMgb25lXG4gICAgICAgIC8vIHNvbWVib2R5IGp1c3QgbWFkZSB0byBwdXQgZG9jdW1lbnRzIGluIChcIk5ldyBmb2xkZXJcIiwgRTI0KSwgYW5kXG4gICAgICAgIC8vIGxlYXZpbmcgaXQgb3V0IG1hZGUgaXQgdmFuaXNoIHRoZSBtb21lbnQgaXQgd2FzIGNyZWF0ZWQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwIHx8IGlzRW1wdHlEaXIoYWJzKSkgZ3JvdXBzLnB1c2goeyBraW5kOiBcImdyb3VwXCIsIHJlbCwgY2hpbGRyZW4gfSk7XG4gICAgICB9IGVsc2UgaWYgKHN0LmlzRmlsZSgpICYmIGlzRG9jTmFtZShuYW1lKSkge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBkb2NzLnB1c2goeyBraW5kOiBcImRvY1wiLCByZWwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbLi4uZ3JvdXBzLCAuLi5kb2NzXTtcbiAgfTtcbiAgY29uc3Qgbm9kZXMgPSB3YWxrKHJvb3QpO1xuICByZXR1cm4geyBub2RlcywgdHJ1bmNhdGVkIH07XG59XG5cbi8qKiBOb3RoaW5nIGluIGl0IGJ1dCBkb3RmaWxlcyAoYSBgLkRTX1N0b3JlYCBkb2VzIG5vdCBtYWtlIGEgZm9sZGVyIGZ1bGwpLiAqL1xuZnVuY3Rpb24gaXNFbXB0eURpcihkaXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIpLmV2ZXJ5KChuKSA9PiBuLnN0YXJ0c1dpdGgoXCIuXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUaGUgbm9kZSBhdCBgcmVsYCBpbiBhIHRyZWUsIG9yIHVuZGVmaW5lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTm9kZShub2RlczogcmVhZG9ubHkgQ29udGV4dE5vZGVbXSwgcmVsOiBzdHJpbmcpOiBDb250ZXh0Tm9kZSB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgIGlmIChuLnJlbCA9PT0gcmVsKSByZXR1cm4gbjtcbiAgICBpZiAobi5raW5kID09PSBcImdyb3VwXCIgJiYgcmVsLnN0YXJ0c1dpdGgoYCR7bi5yZWx9L2ApKSByZXR1cm4gZmluZE5vZGUobi5jaGlsZHJlbiwgcmVsKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgY2xhc3MgUGF0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgY29kZTogXCJtaXNzaW5nXCIgfCBcIm5vdC1hLWRvY1wiLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG4vKipcbiAqIEFuIGVudHJ5IGZvciBhbiBhYnNvbHV0ZSBwYXRoLiBBIGRpcmVjdG9yeSBpcyBgbWlycm9yZWRgOyBhIGRvY3VtZW50IGZpbGUgaXNcbiAqIGBsaXN0ZWRgLCByb290ZWQgYXQgaXRzIHBhcmVudCwgaG9sZGluZyBvbmx5IGl0c2VsZiAoRTE1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudHJ5Rm9yUGF0aChhYnM6IHN0cmluZywgaWQ6IHN0cmluZyk6IENvbnRleHRFbnRyeSB7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHthYnN9YCwgXCJtaXNzaW5nXCIpO1xuICB9XG4gIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShhYnMpO1xuICAgIHJldHVybiB7XG4gICAgICBpZCxcbiAgICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpIHx8IGFicyxcbiAgICAgIHJvb3Q6IGFicyxcbiAgICAgIG1lbWJlcnNoaXA6IFwibWlycm9yZWRcIixcbiAgICAgIG5vZGVzLFxuICAgICAgLi4uKHRydW5jYXRlZCA/IHsgdHJ1bmNhdGVkIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzRG9jTmFtZShhYnMpKSB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihcbiAgICAgIGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2Fic31gLFxuICAgICAgXCJub3QtYS1kb2NcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbGFiZWw6IGJhc2VuYW1lKGFicyksXG4gICAgcm9vdDogZGlybmFtZShhYnMpLFxuICAgIG1lbWJlcnNoaXA6IFwibGlzdGVkXCIsXG4gICAgbm9kZXM6IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUoYWJzKSB9XSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGRvYyBub2RlJ3MgYWJzb2x1dGUgcGF0aCwgZGVwdGgtZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jUGF0aHMoZW50cnk6IENvbnRleHRFbnRyeSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKSA9PiB7XG4gICAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgICBpZiAobi5raW5kID09PSBcImRvY1wiKSBvdXQucHVzaChqb2luKGVudHJ5LnJvb3QsIG4ucmVsKSk7XG4gICAgICBlbHNlIHdhbGsobi5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuICB3YWxrKGVudHJ5Lm5vZGVzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoaWNoIGVudHJ5IChpZiBhbnkpIGhvbGRzIGBhYnNgLCBhbmQgYXQgd2hhdCBgcmVsYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhdGUoXG4gIGVudHJpZXM6IENvbnRleHRFbnRyeVtdLFxuICBhYnM6IHN0cmluZyxcbik6IHsgZW50cnlJZDogc3RyaW5nOyByZWw6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGRvY1BhdGhzKGUpLmluY2x1ZGVzKGFicykpIHJldHVybiB7IGVudHJ5SWQ6IGUuaWQsIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogT25lIGRpcmVjdG9yeSwgZm9yIHRoZSBzdXJmYWNlJ3MgYWRkLWJ5LXBhdGggY29tcGxldGlvbjogc3ViZGlyZWN0b3JpZXMgYW5kXG4gKiBkb2N1bWVudHMgb25seSwgZGlyZWN0b3JpZXMgZmlyc3QuIGB+YCBpcyBleHBhbmRlZCBieSB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdERpcihkaXI6IHN0cmluZyk6IEZzTGlzdEVudHJ5W10ge1xuICBjb25zdCBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gIGNvbnN0IG91dDogRnNMaXN0RW50cnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNEaXIgfHwgaXNEb2NOYW1lKG5hbWUpKSBvdXQucHVzaCh7IG5hbWUsIHBhdGg6IGFicywgZGlyOiBpc0RpciB9KTtcbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IChhLmRpciA9PT0gYi5kaXIgPyBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIDogYS5kaXIgPyAtMSA6IDEpKTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7O0FBZ0RBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFVQTtBQUNBO0FBQ0Esc0JBQVM7OztBQ3RDRixT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QUFZLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFO0FBQUEsRUFDNUQsTUFBTSxXQUFXLEtBQUssWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFBQSxFQUN4RCxJQUFJLElBQUksU0FBUyxZQUFhLENBQUMsWUFBWSxJQUFJLFNBQVMsS0FBSyxZQUFZO0FBQUEsSUFDdkUsTUFBTSxJQUFJLFdBQVcsVUFBVSxRQUFRLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxFQUV6RSxNQUFNLFVBQVUsT0FBTyxNQUFNLFlBQVksV0FBVyxNQUFNLFVBQVU7QUFBQSxFQUNwRSxNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksS0FBSyxPQUFPLE9BQU87QUFBQSxFQUMvQyxPQUFPLE9BQU8sU0FBUyxXQUFXLE9BQU87QUFBQTtBQVEzQyxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJBQUQxOEQ4Qzc3NzRBNEM0NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
