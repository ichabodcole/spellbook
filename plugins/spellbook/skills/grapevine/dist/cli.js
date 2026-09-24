#!/usr/bin/env bun
// @bun

// src/grapevine/backend/cli.ts
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";

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
  const id = min < 0 ? "an event id (an integer; --since=-1 for everything)" : `an event id (an integer, ${min} or more)`;
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
var MAX_IDLE_TIMEOUT_SEC = 255;
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
var MIN_HEARTBEAT_MS = 500;
function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function idleTimeoutSec(raw, fallback = MAX_IDLE_TIMEOUT_SEC) {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}
function heartbeatMs(raw, idleSec, fallback = DEFAULT_HEARTBEAT_MS) {
  const ceiling = Math.max(MIN_HEARTBEAT_MS, Math.floor(idleSec * 1000 / 2));
  return Math.min(Math.max(intOr(raw, fallback), MIN_HEARTBEAT_MS), ceiling);
}
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/grapevine/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.GRAPEVINE_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var DEFAULT_SSE_HEARTBEAT_MS = 3000;
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.GRAPEVINE_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_SSE_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/grapevine/backend/cli.ts
var DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
var PORT_FILE = join(DATA_DIR, "daemon.port");
var PID_FILE = join(DATA_DIR, "daemon.pid");
var HOLD_FILE = join(DATA_DIR, "daemon.hold");
var CONFIG_FILE = join(DATA_DIR, "config.json");
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var DAEMON_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "daemon.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "grapevine");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
function readPluginVersion() {
  try {
    const pluginJsonPath = join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf-8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var _versionCheckDone = false;
async function maybeWarnOnVersionMismatch(port) {
  if (_versionCheckDone)
    return;
  _versionCheckDone = true;
  if (!PLUGIN_VERSION)
    return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    if (!res.ok)
      return;
    const data = await res.json();
    const daemonVersion = data?.version ?? null;
    if (daemonVersion === null) {
      process.stderr.write(`# grapevine: daemon is older than this CLI (no version reported). ` + `CLI is v${PLUGIN_VERSION}. Some features may silently degrade. ` + `Restart the daemon (drop tails, then \`stop\`, then any verb) to upgrade.
`);
    } else if (daemonVersion !== PLUGIN_VERSION) {
      process.stderr.write(`# grapevine: daemon version (v${daemonVersion}) differs from CLI version (v${PLUGIN_VERSION}). ` + `Some features may silently degrade. Restart the daemon to align.
`);
    }
  } catch {}
}
var DEFAULT_ALIAS = process.env.GRAPEVINE_FROM ?? undefined;
function resolveAlias(flags) {
  return flags.from ?? flags.as ?? DEFAULT_ALIAS;
}
var TRUNCATION_HINT_THRESHOLD = parseInt(process.env.GRAPEVINE_TRUNCATION_HINT_THRESHOLD ?? "2000", 10);
function resolveTailMax(flag) {
  const raw = typeof flag === "string" ? flag : process.env.GRAPEVINE_TAIL_MAX;
  if (raw === undefined)
    return;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function die2(msg, kind = "usage", extra) {
  die(msg, kind, extra);
}
function kindForStatus(status) {
  if (status === 404)
    return "not_found";
  if (status === 409)
    return "conflict";
  if (status >= 400 && status < 500)
    return "usage";
  return "internal";
}
async function readDaemonPort() {
  if (!existsSync(PORT_FILE))
    return null;
  const raw = readFileSync(PORT_FILE, "utf-8").trim();
  const port = parseInt(raw, 10);
  if (!port)
    return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    if (res.ok) {
      maybeWarnOnVersionMismatch(port);
      return port;
    }
  } catch {}
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  return null;
}
function holdActive() {
  try {
    if (!existsSync(HOLD_FILE))
      return null;
    const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now())
      return until;
    try {
      unlinkSync(HOLD_FILE);
    } catch {}
    return null;
  } catch {
    return null;
  }
}
function releaseHold() {
  try {
    if (existsSync(HOLD_FILE))
      unlinkSync(HOLD_FILE);
  } catch {}
}
async function ensureDaemon() {
  let port = await readDaemonPort();
  if (port)
    return port;
  if (holdActive())
    die2("daemon is held (respawn suppressed) \u2014 wait for the hold to clear or run `grapevine roll`", "conflict");
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    die2(`grapevine cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}. ` + "No dist/index.html was found (or SPELLBOOK_SURFACE_MODE=dev is set), so the daemon " + "must run from src/grapevine/ to bundle the watch surface, which a source-free install " + "does not have. Either the shipped dist/ is missing (reinstall the spell) or you are in " + "a checkout without src/grapevine/.", "internal");
  }
  const proc = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd
  });
  proc.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    port = await readDaemonPort();
    if (port)
      return port;
  }
  die2("daemon failed to start within 3s", "internal", {
    hint: "three unrelated causes report this one sentence: the daemon's launcher shape, " + "a wrong spawn path, and a dev-mode daemon dying at its surface import. " + "Run the daemon launcher alone to tell them apart \u2014 it is the launcher shape " + "iff it prints `listening on \u2026` and returns at exit 0. An empty " + "GRAPEVINE_HOME (no `channels/`) means the daemon never bound at all."
  });
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
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function invocationPrefix() {
  const entry = process.argv[1];
  return entry ? `bun ${entry}` : "";
}
function dieApi(data, status) {
  const msg = data?.error ?? `HTTP ${status}`;
  const prefix = invocationPrefix();
  const hint = data?.hint ? prefix ? `try: ${prefix} ${data.hint}` : `try the \`${data.hint}\` verb` : undefined;
  die2(msg, kindForStatus(status), {
    ...hint ? { hint } : {},
    ...data !== null ? { server: data } : {}
  });
}
async function requireChannel(port, name) {
  const { status, data } = await api(port, "GET", `/channels/${name}/topic`);
  if (status >= 400)
    dieApi(data, status);
}
async function cmdOpen(name, opts) {
  if (!name)
    die2("usage: grapevine open <name> [--topic <text>] [--fresh]");
  const port = await ensureDaemon();
  const body = { name, explicit: true };
  if (opts.topic !== undefined)
    body.topic = opts.topic;
  if (opts.from !== undefined)
    body.from = opts.from;
  if (opts.fresh)
    body.fresh = true;
  const { status, data } = await api(port, "POST", "/channels", body);
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true, channel: data });
}
async function cmdTopic(name, text, from) {
  if (!name)
    die2("usage: grapevine topic <channel> [<text>]");
  const port = await ensureDaemon();
  if (text === undefined) {
    const { status: status2, data: data2 } = await api(port, "GET", `/channels/${name}/topic`);
    if (status2 >= 400)
      dieApi(data2, status2);
    printJson({ ok: true, channel: name, topic: data2?.topic });
    return;
  }
  const ensure = await api(port, "POST", "/channels", { name });
  if (ensure.status >= 400)
    dieApi(ensure.data, ensure.status);
  const { status, data } = await api(port, "PUT", `/channels/${name}/topic`, {
    topic: text,
    from: from ?? "system"
  });
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true, channel: name, topic: data?.topic, id: data?.id });
}
async function cmdList() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { data } = await api(port, "GET", "/channels");
  printJson({ ok: true, daemon: true, ...data });
}
async function cmdSend(name, from, text, opts) {
  if (!name || !from || !text)
    die2("usage: grapevine send <name> --from <alias> <text...>");
  const port = await ensureDaemon();
  const body = {
    from,
    text
  };
  if (opts.inReplyTo !== undefined)
    body.in_reply_to = opts.inReplyTo;
  const { status, data } = await api(port, "POST", `/channels/${name}/messages`, body);
  if (status >= 400 || !data)
    dieApi(data, status);
  const recip = data.recipients !== undefined ? `${data.recipients} recipient(s)` : `${data.subscribers ?? 0} subscriber(s)`;
  process.stderr.write(`# \u2192 ${data.channel} \xB7 ${recip}
`);
  if (opts.quiet)
    return;
  const out = {
    ok: true,
    id: data.id,
    channel: data.channel,
    subscribers: data.subscribers ?? 0
  };
  if (data.recipients !== undefined)
    out.recipients = data.recipients;
  if (data.subscribers === 0)
    out.warning = "channel has no subscribers";
  else if (data.recipients === 0)
    out.warning = "only you are subscribed";
  if (opts.verbose)
    out.subscriber_aliases = data.subscriber_aliases ?? [];
  printJson(out);
}
async function cmdAnnounce(from, text, channels, opts) {
  if (!from || !text)
    die2("usage: grapevine announce --from <alias> <text...>");
  const port = await ensureDaemon();
  const body = { from, text };
  if (channels?.length)
    body.channels = channels;
  const { status, data } = await api(port, "POST", "/announce", body);
  if (status >= 400 || !data)
    dieApi(data, status);
  process.stderr.write(`# announced \u2192 ${data.channels.length} channel(s) \xB7 ${data.total_recipients} recipient(s)
`);
  if (opts.quiet)
    return;
  const out = {
    ok: true,
    channels: data.channels,
    total_recipients: data.total_recipients
  };
  if (data.skipped?.length)
    out.skipped = data.skipped;
  if (data.channels.length === 0)
    out.warning = "no active channels to announce to";
  printJson(out);
}
async function cmdPull(name, since, opts = {}) {
  if (!name)
    die2("usage: grapevine pull <channel> [--since <id>] [--status <value>]");
  const port = await ensureDaemon();
  if (opts.status !== undefined) {
    await requireChannel(port, name);
    const badged = loadChannelMessagesBadged(name);
    const filtered = badged.filter((m) => {
      const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
      return opts.status === "open" ? m.kind === "message" && isOpen(dispArg) : m.disposition === opts.status;
    });
    const lastId = filtered.at(-1)?.id ?? 0;
    printJson({ ok: true, messages: filtered, cursor: lastId });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${since}`);
  if (status >= 400)
    dieApi(data, status);
  const rawMsgs = data?.messages ?? [];
  const cursor = rawMsgs.at(-1)?.id ?? since;
  const disp = foldDispositions(name);
  const annotated = rawMsgs.filter((m) => !isDispositionFrame(m)).map((m) => {
    const d = disp.get(m.id);
    return d ? { ...m, disposition: d.disposition, reopens: d.reopens } : m;
  });
  printJson({ ok: true, messages: annotated, cursor });
}
async function cmdRead(name, id, opts) {
  if (!name || !Number.isFinite(id))
    die2("usage: grapevine read <channel> <id> [--text]");
  const port = await ensureDaemon();
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${id - 1}`);
  if (status >= 400)
    dieApi(data, status);
  const msg = (data?.messages ?? []).find((m) => m.id === id);
  if (!msg)
    die2(`message ${id} not found in ${name}`, "not_found");
  const dispMap = foldDispositions(name);
  const d = dispMap.get(id);
  const annotatedMsg = d ? { ...msg, disposition: d.disposition, reopens: d.reopens } : msg;
  if (opts.text) {
    const ts = new Date(msg.ts).toISOString();
    const dispPrefix = d ? d.reopens > 0 ? `[${d.disposition} \u21BB${d.reopens}] ` : `[${d.disposition}] ` : "";
    process.stdout.write(`${dispPrefix}[${msg.id}] ${msg.from} \xB7 ${ts}
${msg.text}
`);
    return;
  }
  printJson({ ok: true, message: annotatedMsg });
}
async function cmdWait(name, since, timeoutS, alias) {
  if (!name)
    die2("usage: grapevine wait <channel> [--as <alias>] [--since <id>] [--timeout <s>]");
  const port = await ensureDaemon();
  const asParam = alias ? `&as=${encodeURIComponent(alias)}` : "";
  const url = `http://127.0.0.1:${port}/channels/${name}/wait?since=${since}&timeout=${timeoutS}${asParam}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout((timeoutS + 5) * 1000)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok)
    dieApi(data, res.status);
  printJson({
    ok: true,
    messages: data?.messages ?? [],
    cursor: data?.cursor ?? since,
    timed_out: !!data?.timed_out
  });
}
async function cmdWho(name) {
  if (!name)
    die2("usage: grapevine who <channel>");
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channel: name, subscribers: [] });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/subscribers`);
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true, ...data });
}
async function cmdWhoAll() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { status, data } = await api(port, "GET", "/presence");
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true, ...data });
}
async function cmdAlias(name) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  if (name === undefined) {
    const alias = typeof cfg.alias === "string" && cfg.alias.trim() ? cfg.alias.trim() : null;
    printJson({ ok: true, alias });
    return;
  }
  const trimmed = name.trim();
  cfg.alias = trimmed;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}
`);
  printJson({ ok: true, alias: trimmed || null });
}
async function cmdTail(name, opts) {
  if (!name)
    die2("usage: grapevine tail <name> [--as <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]");
  const myAlias = opts.lurk ? undefined : opts.as;
  const since = opts.fromStart ? 0 : opts.since ?? -1;
  let grounded = opts.since !== undefined;
  let seedFromMarker = since < 0 && opts.last === undefined;
  const again = (at) => commandLine([
    "tail",
    name,
    ...opts.lurk ? ["--lurk"] : myAlias ? ["--as", myAlias] : [],
    ...opts.human && !opts.lurk ? ["--human"] : [],
    ...opts.max !== undefined ? ["--max", String(opts.max)] : [],
    ...at >= 0 ? ["--since", String(at)] : []
  ]);
  return await tailWithHandoff({
    resolve: async () => `http://127.0.0.1:${await ensureDaemon()}`,
    path: `/channels/${name}/tail`,
    since,
    query: (cursor, firstConnect) => {
      const q = { since: String(cursor) };
      if (opts.last !== undefined && firstConnect)
        q.last = String(opts.last);
      if (myAlias)
        q.as = myAlias;
      if (opts.human && !opts.lurk)
        q.human = "1";
      if (opts.lurk)
        q.lurk = "1";
      return q;
    },
    cursorOf: (ev) => {
      if (typeof ev.id === "number")
        return ev.id;
      if (seedFromMarker && typeof ev.latest_id === "number") {
        seedFromMarker = false;
        return ev.latest_id;
      }
      return;
    },
    accept: (ev, frame) => {
      if (frame.event === "subscribed")
        return true;
      if (isDispositionFrame(ev))
        return false;
      if (myAlias && ev.from === myAlias)
        return false;
      return true;
    },
    render: (payload, frame) => {
      if (frame.event === "subscribed")
        return renderSubscribed(payload);
      const readRef = `read ${name} ${payload.id}`;
      if (typeof payload.text === "string" && payload.text.length > (opts.max ?? TRUNCATION_HINT_THRESHOLD)) {
        const truncation_hint = `+${payload.text.length} chars \u2014 full: ${readRef}`;
        const text = opts.max !== undefined ? payload.text.slice(0, opts.max) : payload.text;
        return JSON.stringify({ truncation_hint, ...payload, text });
      }
      return JSON.stringify({ full: readRef, ...payload });
    },
    onComment: (text) => text.trimStart().startsWith("hb") ? ": grapevine-keepalive" : null,
    onMalformed: (_frame, e) => `# bad sse data: ${e instanceof Error ? e.message : String(e)}`,
    onDisconnect: (info) => {
      switch (info.cause) {
        case "connect-failed":
          return `# connect failed: ${info.error instanceof Error ? info.error.message : String(info.error)}, retrying\u2026`;
        case "http":
        case "no-body":
          return `# tail HTTP ${info.status}, retrying\u2026`;
        case "stream-error":
          return `# stream dropped: ${info.error instanceof Error ? info.error.message : String(info.error)}, reconnecting\u2026`;
        case "stream-end":
          return "# stream closed, reconnecting\u2026";
      }
    },
    idleMs: TAIL_IDLE_MS
  }, {
    spell: "grapevine",
    mode: "watch",
    presence: true,
    ...opts.human ? { windowMs: 0 } : {},
    counts: (_ev, frame) => frame.event !== "subscribed",
    commands: {
      tail: ({ since: at }) => again(at),
      comeBack: () => commandLine(["doctor"])
    }
  });
  function renderSubscribed(payload) {
    process.stderr.write(`# subscribed to ${payload.channel} (since=${payload.since})
`);
    if (payload.topic)
      process.stderr.write(`# topic: ${payload.topic}
`);
    if (payload.created)
      process.stderr.write(`# created ${payload.channel} \u2014 this tail brought it into being (check the name)
`);
    if (payload.archived)
      process.stderr.write(`# ${payload.channel} is archived \u2014 read-only; a send will be rejected
`);
    if (grounded)
      return null;
    grounded = true;
    const latest = typeof payload.latest_id === "number" ? payload.latest_id : 0;
    const earlier = since < 0 ? latest : Math.max(0, Math.min(since, latest));
    const hints = [];
    if (earlier > 0)
      hints.push(`${earlier} earlier message(s) exist \u2014 use --from-start or --since <id> to backfill`);
    if (payload.created)
      hints.push(`this tail created ${payload.channel} \u2014 no such channel existed; check the name, or another party has yet to open it`);
    if (payload.archived)
      hints.push(`${payload.channel} is archived \u2014 read-only; a send will be rejected until someone unarchives it`);
    if (!(earlier > 0 || payload.topic || payload.created || payload.archived))
      return null;
    const grounding = {
      kind: "grounding",
      channel: payload.channel,
      joined_at: since < 0 ? latest : Math.min(since, latest),
      earlier
    };
    if (payload.topic)
      grounding.topic = payload.topic;
    if (payload.created)
      grounding.created = true;
    if (payload.archived)
      grounding.archived = true;
    if (hints.length)
      grounding.hint = hints.join(" \xB7 ");
    return JSON.stringify(grounding);
  }
}
function foldDispositions(name) {
  const map = new Map;
  const path = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(path))
    return map;
  for (const line of readFileSync(path, "utf-8").split(`
`)) {
    if (!line.trim())
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind !== "status" || typeof m.target !== "number" || typeof m.disposition !== "string")
      continue;
    const prev = map.get(m.target);
    const reopens = (prev?.reopens ?? 0) + (m.disposition === "open" && prev && prev.disposition !== "open" ? 1 : 0);
    map.set(m.target, {
      disposition: m.disposition,
      from: m.from,
      ts: m.ts,
      note: m.text,
      reopens
    });
  }
  return map;
}
function isDispositionFrame(m) {
  return m.kind === "status" && typeof m.disposition === "string";
}
function isOpen(d) {
  return !d || d.disposition === "open";
}
function loadChannelMessagesBadged(name) {
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath))
    return [];
  const disp = foldDispositions(name);
  const messages = [];
  for (const line of readFileSync(logPath, "utf-8").split(`
`)) {
    if (!line.trim())
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind === "status")
      continue;
    const d = disp.get(m.id);
    if (d) {
      messages.push({ ...m, disposition: d.disposition, reopens: d.reopens });
    } else {
      messages.push(m);
    }
  }
  return messages;
}
function renderTriageHuman(name, open, by_status) {
  const line = (m) => {
    const ts = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
    const reopen = m.reopens && m.reopens > 0 ? ` \u21BB${m.reopens}` : "";
    const nl = m.text.indexOf(`
`);
    const head = nl === -1 ? m.text : m.text.slice(0, nl);
    const preview = head.length > 100 ? `${head.slice(0, 99)}\u2026` : head;
    return `  [${m.id}${reopen}] ${m.from} \xB7 ${ts} \xB7 ${preview}`;
  };
  const sections = [`${name} \xB7 triage
`, `OPEN (${open.length})`];
  sections.push(open.length ? open.map(line).join(`
`) : "  \u2014");
  for (const [status, items] of Object.entries(by_status)) {
    sections.push(`
${status.toUpperCase()} (${items.length})`, items.map(line).join(`
`));
  }
  return `${sections.join(`
`)}
`;
}
async function cmdTriage(name, opts = {}) {
  if (!name)
    die2("usage: grapevine triage <channel> [--human]");
  const port = await ensureDaemon();
  await requireChannel(port, name);
  const badged = loadChannelMessagesBadged(name);
  const open = [];
  const by_status = {};
  for (const m of badged) {
    const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
    if (isOpen(dispArg)) {
      if (m.kind === "message")
        open.push(m);
    } else {
      const key = m.disposition ?? "unknown";
      if (!by_status[key])
        by_status[key] = [];
      by_status[key].push(m);
    }
  }
  if (opts.human) {
    process.stdout.write(renderTriageHuman(name, open, by_status));
    return;
  }
  printJson({ ok: true, open, by_status });
}
async function cmdGrep(name, pattern, opts) {
  if (!name || !pattern)
    die2("usage: grapevine grep <channel> <pattern> [--literal|-F] [--from <alias>]");
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath)) {
    printJson({ ok: true, messages: [] });
    return;
  }
  let matcher;
  if (opts.literal) {
    const needle = pattern.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(needle);
  } else {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      die2(`invalid regex: ${e instanceof Error ? e.message : String(e)}`, "usage");
    }
    matcher = (text) => re.test(text);
  }
  const raw = readFileSync(logPath, "utf-8");
  const messages = [];
  for (const line of raw.split(`
`)) {
    if (!line)
      continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.text !== "string")
      continue;
    if (opts.from && msg.from !== opts.from)
      continue;
    if (!matcher(msg.text))
      continue;
    messages.push(msg);
  }
  printJson({ ok: true, messages });
}
async function cmdClose(name) {
  if (!name)
    die2("usage: grapevine close <name>");
  const port = await readDaemonPort();
  if (!port)
    die2("no daemon running", "not_found");
  const { status, data } = await api(port, "DELETE", `/channels/${name}`);
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true });
}
async function cmdReset(name, opts) {
  if (!name)
    die2("usage: grapevine reset <name> [--force]");
  const port = await ensureDaemon();
  const body = {};
  if (opts.force)
    body.force = true;
  const { status, data } = await api(port, "POST", `/channels/${name}/reset`, body);
  if (status === 409 && data?.error === "live") {
    die2(`channel has ${data.subscribers} live subscriber(s) \u2014 refusing to clear a live session. Re-run with --force to clear anyway (the log is snapshotted first).`, "conflict");
  }
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true, ...data });
}
async function cmdMark(name, id, disposition, from, opts) {
  if (!name || !Number.isFinite(id) || !disposition)
    die2("usage: grapevine mark <channel> <id> <disposition> [--note <text>] [--as <alias>]");
  const port = await ensureDaemon();
  const body = { from, target: id, disposition };
  if (opts.note !== undefined)
    body.note = opts.note;
  const { status, data } = await api(port, "POST", `/channels/${name}/status`, body);
  if (status >= 400 || !data)
    dieApi(data, status);
  printJson(data);
}
async function cmdArchive(name, unarchive, from) {
  const verb = unarchive ? "unarchive" : "archive";
  if (!name)
    die2(`usage: grapevine ${verb} <channel>`);
  const port = await ensureDaemon();
  const { status, data } = await api(port, "POST", `/channels/${name}/${verb}`, from ? { from } : undefined);
  if (status >= 400)
    dieApi(data, status);
  printJson({ ok: true, ...data });
}
async function cmdStop(opts = {}) {
  let heldUntil;
  if (opts.holdSeconds && opts.holdSeconds > 0) {
    heldUntil = Date.now() + opts.holdSeconds * 1000;
    try {
      writeFileSync(HOLD_FILE, String(heldUntil));
    } catch {}
  }
  const port = await readDaemonPort();
  if (!port) {
    printJson({
      ok: true,
      daemon: false,
      ...heldUntil !== undefined ? { held_until: heldUntil } : {}
    });
    return;
  }
  try {
    await api(port, "DELETE", "/");
  } catch {}
  printJson({
    ok: true,
    stopped: true,
    ...heldUntil !== undefined ? { held_until: heldUntil } : {}
  });
}
async function fetchActiveSubscribers(port) {
  let total = 0;
  const channels = [];
  try {
    const { data } = await api(port, "GET", "/presence");
    for (const ch of data?.channels ?? []) {
      total += ch.connections;
      if (ch.connections > 0)
        channels.push({ name: ch.name, connections: ch.connections });
    }
  } catch {}
  return { total, channels };
}
async function cmdStart() {
  const existing = await readDaemonPort();
  if (!existing && holdActive()) {
    printJson({ ok: true, held: true, port: null });
    return;
  }
  const port = existing ?? await ensureDaemon();
  printJson({ ok: true, port, already_running: existing !== null });
}
async function cmdRestart(opts) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh2 = await ensureDaemon();
    printJson({ ok: true, restarted: true, port: fresh2, previous_pid: null });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die2(`restart: ${total} active subscriber(s) across ${channels.length} channel(s) \u2014 ${where}. ` + "A restart would force them all to reconnect. Re-run with --force (or --yes) to proceed anyway.", "conflict");
  }
  let previousPid = null;
  try {
    const { data } = await api(port, "GET", "/");
    previousPid = data?.pid ?? null;
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      break;
  }
  const fresh = await ensureDaemon();
  printJson({ ok: true, restarted: true, port: fresh, previous_pid: previousPid });
}
async function probeVersion(port) {
  try {
    const v = (await api(port, "GET", "/")).data?.version ?? null;
    if (v === null) {
      return {
        version: null,
        version_ok: null,
        version_unchecked_reason: "the daemon answered but reported no version"
      };
    }
    return { version: v, version_ok: v === PLUGIN_VERSION, version_unchecked_reason: null };
  } catch (e) {
    return {
      version: null,
      version_ok: null,
      version_unchecked_reason: `could not reach the daemon to verify: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
async function cmdRoll(opts) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh2 = await ensureDaemon();
    printJson({
      ok: true,
      rolled: true,
      previous_pid: null,
      port: fresh2,
      ...await probeVersion(fresh2)
    });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die2(`roll: ${total} active subscriber(s) \u2014 ${where}. They'll auto-reconnect across the roll. Re-run with --force to proceed.`, "conflict");
  }
  let previousPid = null;
  try {
    previousPid = (await api(port, "GET", "/")).data?.pid ?? null;
  } catch {}
  const holdMs = 4000;
  try {
    writeFileSync(HOLD_FILE, String(Date.now() + holdMs));
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      break;
  }
  releaseHold();
  const fresh = await ensureDaemon();
  let pid = null;
  try {
    pid = (await api(fresh, "GET", "/")).data?.pid ?? null;
  } catch {}
  printJson({
    ok: true,
    rolled: true,
    previous_pid: previousPid,
    pid,
    port: fresh,
    ...await probeVersion(fresh)
  });
}
async function cmdWatch(name) {
  const channel = name?.trim() ? name.trim() : "lobby";
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name: channel });
  const url = `http://127.0.0.1:${port}/watch#${encodeURIComponent(channel)}`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const p = spawn(opener, [url], {
      detached: true,
      stdio: "ignore"
    });
    p.unref();
  } catch {}
  printJson({ ok: true, channel, url });
}
async function cmdDoctor() {
  const port = await readDaemonPort();
  let authoritative = null;
  let totalSubscribers = 0;
  const busyChannels = [];
  if (port) {
    try {
      const { data } = await api(port, "GET", "/");
      authoritative = { port, ...data };
    } catch {}
    try {
      const { data: presData } = await api(port, "GET", "/presence");
      for (const ch of presData?.channels ?? []) {
        totalSubscribers += ch.connections;
        busyChannels.push({
          name: ch.name,
          subscribers: ch.connections,
          connections: ch.connections,
          named: ch.named,
          anonymous: ch.anonymous
        });
      }
    } catch {}
  }
  const otherDaemons = [];
  const selfPid = authoritative?.pid;
  try {
    for (const pid of await listGrapevineDaemonPids()) {
      if (selfPid && pid === selfPid)
        continue;
      otherDaemons.push(await classifyDaemon(pid));
    }
  } catch {}
  const channelsOnDisk = [];
  try {
    const channelsDir = join(DATA_DIR, "channels");
    if (existsSync(channelsDir)) {
      for (const f of readdirSync(channelsDir)) {
        if (f.endsWith(".jsonl"))
          channelsOnDisk.push(f.replace(/\.jsonl$/, ""));
      }
    }
  } catch {}
  const hints = [];
  if (!authoritative) {
    hints.push("No authoritative daemon running for this HOME. Run any verb (e.g. `cli.ts list`) to spawn one.");
  }
  if (otherDaemons.length > 0) {
    hints.push(`Found ${otherDaemons.length} other grapevine daemon process(es) on this machine. ` + "They may be zombies from past runs OR daemons serving other HOMEs (different GRAPEVINE_HOME).");
    const reapableCount = otherDaemons.filter((d) => d.reapable).length;
    if (reapableCount > 0) {
      hints.push(`Found ${reapableCount} reapable orphan daemon(s). Run \`grapevine reap\` to clear them safely.`);
    }
    if (otherDaemons.some((d) => d.status === "unresponsive")) {
      hints.push("Some daemons are unresponsive; `grapevine reap --force` includes them.");
    }
  }
  if (authoritative && PLUGIN_VERSION && typeof authoritative.version === "string" && authoritative.version !== PLUGIN_VERSION) {
    hints.push(`Authoritative daemon version (${authoritative.version}) differs from this CLI's version (${PLUGIN_VERSION}). ` + "Restart the daemon to align \u2014 drop active tails, then `stop`, then any verb.");
  }
  if (authoritative && (authoritative.version === null || authoritative.version === undefined)) {
    hints.push("Authoritative daemon predates version reporting (pre-V1.6.2). Restart to align.");
  }
  if (totalSubscribers > 0) {
    hints.push(`${totalSubscribers} active subscriber(s) across ${busyChannels.length} channel(s). ` + "Daemon restart would force them to auto-reconnect (works, but disruptive) \u2014 coordinate first.");
  } else if (authoritative) {
    hints.push("No active subscribers \u2014 daemon restart is non-disruptive.");
  }
  for (const ch of busyChannels) {
    if (ch.anonymous > 0) {
      hints.push(`${ch.name}: ${ch.connections} connection(s), ${ch.named} named agent(s) + ` + `${ch.anonymous} anonymous (e.g. a watch tab). The count over the name list is expected, not a ghost.`);
    }
  }
  printJson({
    ok: true,
    home: DATA_DIR,
    cli_version: PLUGIN_VERSION,
    authoritative,
    active_subscribers: {
      total: totalSubscribers,
      busy_channels: busyChannels
    },
    other_daemons_on_machine: otherDaemons,
    channels_on_disk: channelsOnDisk,
    hints
  });
}
async function cmdInfo() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false });
    return;
  }
  const { data } = await api(port, "GET", "/");
  printJson({ ok: true, daemon: true, ...data });
}
async function listGrapevineDaemonPids() {
  const pids = [];
  try {
    const proc = spawn("ps", ["-eo", "pid,command"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    proc.stdout?.on("data", (b) => chunks.push(b));
    await new Promise((resolve) => proc.on("exit", () => resolve()));
    const out = Buffer.concat(chunks).toString("utf-8");
    for (const line of out.split(`
`)) {
      if (!line.includes("daemon.ts"))
        continue;
      if (!line.toLowerCase().includes("grapevine"))
        continue;
      const digits = line.match(/^\s*(\d+)\s+/)?.[1];
      if (digits === undefined)
        continue;
      const pid = parseInt(digits, 10);
      if (pid)
        pids.push(pid);
    }
  } catch {}
  return pids;
}
async function lsofListenPort(pid) {
  try {
    const proc = spawn("lsof", ["-aiTCP", "-sTCP:LISTEN", "-p", String(pid), "-P", "-n"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    proc.stdout?.on("data", (b) => chunks.push(b));
    await new Promise((r) => proc.on("exit", () => r()));
    const digits = Buffer.concat(chunks).toString("utf-8").match(/127\.0\.0\.1:(\d+)/)?.[1];
    return digits === undefined ? null : parseInt(digits, 10);
  } catch {
    return null;
  }
}
async function classifyDaemon(pid) {
  const port = await lsofListenPort(pid);
  if (!port)
    return { pid, port: null, status: "unknown", reapable: false };
  let info = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800)
    });
    if (res.ok)
      info = await res.json();
  } catch {}
  if (!info)
    return { pid, port, status: "unresponsive", reapable: false };
  const home = info.data_dir;
  let owns = false;
  try {
    const op = readFileSync(join(home, "daemon.port"), "utf-8").trim();
    const oi = readFileSync(join(home, "daemon.pid"), "utf-8").trim();
    owns = op === String(port) && oi === String(pid);
  } catch {}
  return owns ? {
    pid,
    port,
    home,
    version: info.version ?? null,
    status: "authoritative",
    reapable: false
  } : {
    pid,
    port,
    home,
    version: info.version ?? null,
    status: "orphan",
    reapable: true
  };
}
async function cmdReap(opts) {
  const selfPort = await readDaemonPort();
  let selfPid = null;
  if (selfPort) {
    try {
      selfPid = (await api(selfPort, "GET", "/")).data?.pid ?? null;
    } catch {}
  }
  const pids = await listGrapevineDaemonPids();
  const kept = [], reaped = [], skipped = [];
  for (const pid of pids) {
    const c = await classifyDaemon(pid);
    const isSelf = pid === selfPid;
    const shouldReap = !isSelf && (c.reapable || c.status === "unresponsive" && opts.force === true);
    if (!shouldReap) {
      kept.push(c);
      continue;
    }
    if (opts.dryRun) {
      skipped.push({ ...c, note: "dry-run" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(c);
    } catch {
      skipped.push({ ...c, note: "kill failed" });
    }
  }
  printJson({ ok: true, dry_run: !!opts.dryRun, kept, reaped, skipped });
}
var LEAKED_SEND_RE = /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\b(?:send|announce)\b/;
function looksLikeLeakedSend(text) {
  return LEAKED_SEND_RE.test(text);
}
var SHELL_METACHAR_RE = /`|\$\(|\$\{/;
function looksShellRisky(text) {
  return SHELL_METACHAR_RE.test(text);
}
var CLI_OPTIONS = {
  as: { type: "string" },
  "body-file": { type: "string" },
  channels: { type: "string" },
  from: { type: "string" },
  hold: { type: "string" },
  "in-reply-to": { type: "string" },
  last: { type: "string" },
  max: { type: "string" },
  note: { type: "string" },
  since: { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  topic: { type: "string" },
  all: { type: "boolean" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  fresh: { type: "boolean" },
  "from-start": { type: "boolean" },
  human: { type: "boolean" },
  literal: { type: "boolean" },
  lurk: { type: "boolean" },
  quiet: { type: "boolean" },
  stdin: { type: "boolean" },
  text: { type: "boolean" },
  verbose: { type: "boolean" },
  yes: { type: "boolean" }
};

class UsageError extends Error {
  extra;
  constructor(message, extra) {
    super(message);
    this.name = "UsageError";
    this.extra = extra;
  }
}
var GLOBAL_FLAGS = ["as", "from"];
function sinceOrDie(token) {
  const r = readSince(token, { epoch: false, min: 0 });
  if (!r.ok)
    die2(`tail: ${r.message}`, "usage");
  return r.since;
}
function numericFlag(verb, name, raw, fallback) {
  if (raw === undefined)
    return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    die2(`${verb}: --${name} expects a non-negative number, got ${JSON.stringify(String(raw))}`);
  return n;
}
async function resolveBody(verb, inline, flags) {
  if (flags["body-file"]) {
    const path = flags["body-file"];
    const file = Bun.file(path);
    if (!await file.exists())
      die2(`${verb}: --body-file not found: ${path}`, "not_found");
    return { text: (await file.text()).replace(/\n$/, ""), fromInline: false };
  }
  if (flags.stdin || inline.length === 0 && !process.stdin.isTTY) {
    const buf = [];
    for await (const chunk of process.stdin)
      buf.push(chunk);
    return {
      text: Buffer.concat(buf).toString("utf-8").replace(/\n$/, ""),
      fromInline: false
    };
  }
  return { text: inline.join(" "), fromInline: true };
}
function guardBody(verb, text, fromInline, force) {
  if (!force && looksLikeLeakedSend(text)) {
    die2(`${verb}: that body looks like a leaked grapevine invocation (a fumbled ` + "heredoc?). Nothing was sent. Pipe the real body via --stdin or " + "--body-file <path>, or pass --force to send it anyway.");
  }
  if (fromInline && looksShellRisky(text)) {
    process.stderr.write("# \u26A0 inline body contains shell metacharacters (backtick, $(), curly-brace vars). " + "It was sent as-is, but the shell can command-substitute these before " + `grapevine sees them \u2014 use --body-file or --stdin for code-bearing messages.
`);
  }
}
var identityRequired = (verb) => die2(`${verb}: identity required`, "usage", {
  hint: `pass ${GLOBAL_FLAGS.map((f) => `--${f}`).join("/")} <alias>, or set GRAPEVINE_FROM`,
  choices: GLOBAL_FLAGS.map((f) => `--${f}`)
});
var COMMANDS = [
  {
    name: "open",
    flags: ["topic", "fresh"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdOpen(positional[0], {
        topic: flags.topic,
        from: resolveAlias(flags),
        fresh: flags.fresh === true
      });
    }
  },
  {
    name: "topic",
    flags: [],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdTopic(positional[0], positional.length > 1 ? positional.slice(1).join(" ") : undefined, resolveAlias(flags));
    }
  },
  {
    name: "list",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdList();
    }
  },
  {
    name: "send",
    flags: ["body-file", "stdin", "quiet", "verbose", "force", "in-reply-to"],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true }
    ],
    run: async (positional, flags) => {
      const name = positional[0];
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("send", positional.slice(1), flags);
      if (!from)
        identityRequired("send");
      guardBody("send", text, fromInline, !!flags.force);
      await cmdSend(name, from, text, {
        quiet: !!flags.quiet,
        verbose: !!flags.verbose,
        inReplyTo: flags["in-reply-to"] ? numericFlag("send", "in-reply-to", flags["in-reply-to"], 0) : undefined
      });
    }
  },
  {
    name: "announce",
    flags: ["body-file", "stdin", "quiet", "force", "channels"],
    positionals: [{ name: "text", required: false, variadic: true }],
    run: async (positional, flags) => {
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("announce", positional, flags);
      if (!from)
        identityRequired("announce");
      guardBody("announce", text, fromInline, !!flags.force);
      const channels = flags.channels ? flags.channels.split(",").map((c) => c.trim()).filter(Boolean) : undefined;
      await cmdAnnounce(from, text, channels, { quiet: !!flags.quiet });
    }
  },
  {
    name: "pull",
    flags: ["since", "status"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("pull", "since", flags.since, 0);
      await cmdPull(positional[0], since, { status: flags.status });
    }
  },
  {
    name: "triage",
    flags: ["human"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdTriage(positional[0], { human: !!flags.human });
    }
  },
  {
    name: "read",
    flags: ["text"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true }
    ],
    run: async (positional, flags) => {
      const id = positional[1] ? parseInt(positional[1], 10) : NaN;
      await cmdRead(positional[0], id, { text: !!flags.text });
    }
  },
  {
    name: "wait",
    flags: ["since", "timeout"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("wait", "since", flags.since, 0);
      const timeout = numericFlag("wait", "timeout", flags.timeout, 30);
      await cmdWait(positional[0], since, timeout, resolveAlias(flags));
    }
  },
  {
    name: "who",
    flags: ["all"],
    positionals: [{ name: "name", required: false }],
    run: async (positional, flags) => {
      if (flags.all)
        await cmdWhoAll();
      else
        await cmdWho(positional[0]);
    }
  },
  {
    name: "alias",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdAlias(positional[0]);
    }
  },
  {
    name: "tail",
    flags: ["since", "from-start", "last", "human", "lurk", "max"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      return await cmdTail(positional[0], {
        since: flags.since !== undefined ? sinceOrDie(String(flags.since)) : undefined,
        fromStart: !!flags["from-start"],
        last: flags.last !== undefined ? numericFlag("tail", "last", flags.last, 0) : undefined,
        as: resolveAlias(flags),
        human: !!flags.human,
        lurk: !!flags.lurk,
        max: resolveTailMax(flags.max)
      });
    }
  },
  {
    name: "grep",
    flags: ["literal"],
    positionals: [
      { name: "name", required: true },
      { name: "pattern", required: true, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdGrep(positional[0], positional.slice(1).join(" "), {
        literal: !!flags.literal,
        from: flags.from
      });
    }
  },
  {
    name: "close",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional) => {
      await cmdClose(positional[0]);
    }
  },
  {
    name: "reset",
    flags: ["force"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdReset(positional[0], { force: flags.force === true });
    }
  },
  {
    name: "mark",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true },
      { name: "disposition", required: true, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdMark(positional[0], positional[1] === undefined ? Number.NaN : parseInt(positional[1], 10), positional.slice(2).join(" "), resolveAlias(flags) ?? identityRequired("mark"), { note: flags.note });
    }
  },
  {
    name: "reopen",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true }
    ],
    run: async (positional, flags) => {
      await cmdMark(positional[0], positional[1] === undefined ? Number.NaN : parseInt(positional[1], 10), "open", resolveAlias(flags) ?? identityRequired("reopen"), { note: flags.note });
    }
  },
  {
    name: "archive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdArchive(positional[0], false, resolveAlias(flags));
    }
  },
  {
    name: "unarchive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdArchive(positional[0], true, resolveAlias(flags));
    }
  },
  {
    name: "start",
    aliases: ["up"],
    flags: [],
    positionals: [],
    run: async () => {
      await cmdStart();
    }
  },
  {
    name: "restart",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRestart({ force: !!flags.force || !!flags.yes });
    }
  },
  {
    name: "roll",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRoll({ force: flags.force === true || flags.yes === true });
    }
  },
  {
    name: "stop",
    flags: ["hold"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdStop({
        holdSeconds: flags.hold !== undefined ? numericFlag("stop", "hold", flags.hold, 0) : undefined
      });
    }
  },
  {
    name: "watch",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdWatch(positional[0]);
    }
  },
  {
    name: "reap",
    aliases: ["prune"],
    flags: ["force", "dry-run"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdReap({ force: flags.force === true, dryRun: flags["dry-run"] === true });
    }
  },
  {
    name: "info",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdInfo();
    }
  },
  {
    name: "doctor",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdDoctor();
    }
  },
  {
    name: "version",
    flags: ["human"],
    positionals: [],
    run: (_positional, flags) => {
      if (PLUGIN_VERSION === null)
        die2("version unavailable \u2014 could not read plugin.json", "internal");
      if (flags.human === true)
        process.stdout.write(`grapevine v${PLUGIN_VERSION}
`);
      else
        printJson({ name: "grapevine", version: PLUGIN_VERSION });
    }
  },
  {
    name: "schema",
    flags: [],
    positionals: [],
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}
`);
    }
  },
  {
    name: "help",
    flags: [],
    positionals: [],
    run: () => {
      printHelp();
    }
  }
];
function findCommand(token) {
  return COMMANDS.find((c) => c.name === token || c.aliases?.includes(token));
}
function acceptedFlags(spec) {
  const own = new Set([...GLOBAL_FLAGS, ...spec.flags]);
  return Object.keys(CLI_OPTIONS).filter((k) => own.has(k));
}
var ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" }
];
function buildDeclaration() {
  const arg = (k) => ({
    name: `--${k}`,
    type: CLI_OPTIONS[k].type,
    status: "valid"
  });
  const commands = [
    {
      path: [],
      args: ROOT_INTERCEPTORS.map((i) => ({
        name: i.name,
        type: "boolean",
        status: "valid"
      })),
      positionals: [{ name: "command", required: true }]
    }
  ];
  for (const spec of COMMANDS) {
    for (const name of [spec.name, ...spec.aliases ?? []]) {
      commands.push({
        path: [name],
        args: acceptedFlags(spec).map((k) => arg(k)),
        positionals: spec.positionals
      });
    }
  }
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands
  };
}
function parseFlags(argv, spec) {
  const accepted = acceptedFlags(spec);
  const options = Object.fromEntries(accepted.map((k) => [k, CLI_OPTIONS[k]]));
  try {
    const { values, positionals } = nodeParseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: true
    });
    return {
      positional: positionals,
      flags: values
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const bodyHint = spec.name === "send" || spec.name === "announce" ? "for a message body containing dashes, use --stdin or --body-file, " + "or put it after a bare --" : "";
    throw new UsageError(`${spec.name}: ${detail}`, {
      choices: accepted.map((k) => `--${k}`),
      ...bodyHint ? { hint: bodyHint } : {}
    });
  }
}
function commandTokens() {
  return COMMANDS.flatMap((c) => [c.name, ...c.aliases ?? []]);
}
function printHelp() {
  process.stdout.write(`grapevine \u2014 agent-to-agent walkie-talkie

Usage:
  grapevine open <name> [--topic <text>] [--fresh]   open/create (auto-unarchives; --fresh clears a dormant channel)
  grapevine list
  grapevine send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--body-file <path>] [--force] [--in-reply-to <id>] [<text...>]
                                    # body: inline text, --stdin, --body-file, or piped stdin (default when no inline text)
  grapevine announce [--from/--as <alias>] [--channels a,b,c] [--stdin] [--body-file <path>] [--quiet] [<text...>]
                                    # broadcast one message to every active channel (or --channels)
  grapevine tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]
                                    # ${WINDOW_HELP} (--human never ends by itself)
       # --last <n>: backfill the most recent n messages then go live (bounded catch-up for a cold joiner)
  grapevine pull <name> [--since <id>] [--status <value>]   # --status = full-scan filter (open|wontfix|incorporated|\u2026)
  grapevine triage <name>             # full-scan: open messages on top + grouped by_status
  grapevine mark <name> <id> <disposition> [--note <text>]  # set disposition (incorporated|wontfix|deferred|\u2026)
  grapevine reopen <name> <id>        # bounce a message back to open
  grapevine read <name> <id> [--text]   # one full message by id (--text = prose)
  grapevine wait <name> [--since <id>] [--timeout <s>]
  grapevine grep <name> <pattern> [--literal] [--from <alias>]
  grapevine topic <name> [<text>]   # no text \u2192 read current; with text \u2192 update
  grapevine who <name>              # roster; the humans field lists humans
  grapevine alias [<name>]          # set/show your persisted alias (config.json)
  grapevine watch [<name>]          # open browser tab; live chat-bubble view
  grapevine reset <name> [--force]           snapshot the log \u2192 ~/.grapevine/archive, then clear it
  grapevine archive <name>          # read-only: keep history, reject sends
  grapevine unarchive <name>        # bring an archived channel back
  grapevine close <name>            # destructive: delete the message log
  grapevine start                   # ensure the daemon is running (alias: up); no channel
  grapevine restart [--force|--yes] # stop + respawn fresh; --force to override the live-fleet guard
  grapevine roll [--force]          # safe restart (stop+hold+respawn) + version verify \u2014 the recommended deploy step
  grapevine stop [--hold <seconds>] # kill the daemon; --hold suppresses auto-respawn for <s> seconds (upgrade window)
  grapevine info
  grapevine doctor                  # health check \u2014 labels each daemon: authoritative / orphan / unresponsive / unknown
  grapevine reap [--force] [--dry-run]  # kill orphan daemons; --force also kills unresponsive; alias: prune

  grapevine schema                  # this CLI's machine-readable interface description (acc declaration v0)
  grapevine --version               # this CLI's version (alias: -V, version)
  grapevine help                    # this usage (alias: --help, -h)

Output:
  Data commands emit JSON on stdout by DEFAULT; pass --human for prose where a
  command offers it. Diagnostics and warnings go to stderr, never stdout.
  Usage errors exit 2. Each command accepts its OWN flags (plus --as/--from,
  which are global) \u2014 an unknown flag for a verb enumerates that verb's set.

Env:
  GRAPEVINE_FROM   Default identity alias (--from/--as are interchangeable).
  GRAPEVINE_HOME   Data dir (default ~/.grapevine).
`);
}
async function dispatch(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    die2("expected a command", "usage", {
      choices: commandTokens(),
      hint: "run `grapevine help` (or --help) for usage"
    });
  }
  if (cmd.startsWith("-")) {
    const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === cmd);
    if (!interceptor) {
      die2(`unknown flag at the root: ${cmd}`, "usage", {
        choices: [...ROOT_INTERCEPTORS.map((i) => i.name)].sort((a, b) => Number(b.startsWith("--")) - Number(a.startsWith("--"))),
        hint: `commands (each takes its own flags): ${commandTokens().join(" ")}`
      });
    }
    return await runCommand(findCommand(interceptor.runs), rest);
  }
  const spec = findCommand(cmd);
  if (!spec) {
    die2(`unknown command: ${cmd}`, "usage", { choices: commandTokens() });
  }
  return await runCommand(spec, rest);
}
async function runCommand(spec, rest) {
  let positional;
  let flags;
  try {
    ({ positional, flags } = parseFlags(rest, spec));
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    die2(e.message, "usage", e.extra);
  }
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (positional.length < required) {
    const missing = spec.positionals[positional.length];
    die2(`${spec.name}: missing required <${missing?.name ?? "argument"}>`, "usage", {
      hint: `expects: ${spec.name} ${spec.positionals.map((p) => p.required ? `<${p.name}>` : `[${p.name}]`).join(" ")}`
    });
  }
  if (!variadic && positional.length > spec.positionals.length) {
    die2(`${spec.name}: unexpected argument ${JSON.stringify(positional[spec.positionals.length])}`, "usage", {
      hint: `expects: ${spec.name} ${spec.positionals.map((p) => p.required ? `<${p.name}>` : `[${p.name}]`).join(" ") || "(no arguments)"}`
    });
  }
  const outcome = await spec.run(positional, flags);
  return typeof outcome === "number" ? outcome : 0;
}
async function main(argv) {
  setCurrentCommand(argv[0] ?? null);
  try {
    return await dispatch(argv);
  } catch (e) {
    const code = reportCliError(e);
    if (code !== null)
      return code;
    throw e;
  }
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  classifyDaemon,
  daemonCwd,
  looksShellRisky,
  probeVersion,
  releaseHold,
  run
};

//# debugId=BB401FF3204C516E64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9ncmFwZXZpbmUvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGdyYXBldmluZSBDTEkg4oCUIHRoaW4gd3JhcHBlciBhcm91bmQgdGhlIGRhZW1vbidzIEhUVFAgc3VyZmFjZS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIGxpc3Rcbi8vICAgYnVuIGNsaS50cyBzZW5kIDxuYW1lPiAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyB0YWlsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl1cbi8vICAgYnVuIGNsaS50cyByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdXG4vLyAgIGJ1biBjbGkudHMgY2xvc2UgPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgc3RvcFxuLy8gICBidW4gY2xpLnRzIGluZm9cbi8vXG4vLyBgdGFpbGAgd3JpdGVzIGVhY2ggaW5jb21pbmcgbWVzc2FnZSBhcyBvbmUgSlNPTkwgbGluZSBvbiBzdGRvdXQuIFBpcGVcbi8vIG9yIHdyYXAgd2l0aCBNb25pdG9yLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBFcnJFeHRyYSxcbiAgdHlwZSBFcnJLaW5kLFxuICBkaWUgYXMgcmFpc2UsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHJlYWRTaW5jZSxcbiAgdGFpbFdpdGhIYW5kb2ZmLFxuICBXSU5ET1dfSEVMUCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmLnRzXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXQudHNcIjtcblxuY29uc3QgREFUQV9ESVIgPSBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ3JhcGV2aW5lXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihEQVRBX0RJUiwgXCJkYWVtb24ucG9ydFwiKTtcbmNvbnN0IFBJRF9GSUxFID0gam9pbihEQVRBX0RJUiwgXCJkYWVtb24ucGlkXCIpO1xuY29uc3QgSE9MRF9GSUxFID0gam9pbihEQVRBX0RJUiwgXCJkYWVtb24uaG9sZFwiKTtcbi8vIFBlcnNpc3RlZCBpZGVudGl0eSBjb25maWcgKFYxLjcpIOKAlCBgZ3JhcGV2aW5lIGFsaWFzIDxuYW1lPmAgd3JpdGVzIGl0OyB0aGVcbi8vIGRhZW1vbiBzZXJ2ZXMgaXQgdG8gdGhlIHdhdGNoIHZpYSBHRVQgL2lkZW50aXR5LlxuY29uc3QgQ09ORklHX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImNvbmZpZy5qc29uXCIpO1xuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBORVZFUiBBIEZMQVQgU0lCTElORyAocGxheWJvb2sgQjQpLiBUaGlzIHJlYWRcbi8vIGBqb2luKFNDUklQVF9ESVIsIFwiZGFlbW9uLnRzXCIpYCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IOKAlCB3aGljaCB3YXNcbi8vIHRydWUgZm9yIGV4YWN0bHkgYXMgbG9uZyBhcyB0aGUgQ0xJIGFuZCB0aGUgZGFlbW9uIHNoYXJlZCBhIGZvbGRlci4gRnJvbVxuLy8gYGRpc3QvYCB0aGF0IHJlc29sdmVzIHRvIGBkaXN0L2RhZW1vbi50c2AsIGEgZmlsZSB0aGF0IGRvZXMgbm90IGFuZCBtdXN0IG5vdFxuLy8gZXhpc3QuIFRoZSBzeW1wdG9tIGlzIG5vdCBhIGNyYXNoOiB0aGUgc3Bhd24gZmFpbHMgc2lsZW50bHkgKHRoZSBkYWVtb24nc1xuLy8gc3RkaW8gaXMgaWdub3JlZCksIG5vIHBvcnQgZmlsZSBldmVyIGFwcGVhcnMsIGFuZCB0aGUgMyBzIHBvbGwgbG9vcCBiZWxvd1xuLy8gcmVwb3J0cyBgZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NgIOKAlCB3aGljaCBpcyBBTFNPIHdoYXQgYSBsYXVuY2hlclxuLy8gdGhhdCBleGl0cyBhIGxpdmUgZGFlbW9uIHJlcG9ydHMgKEQ2OSkgYW5kIEFMU08gd2hhdCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZ1xuLy8gYXQgaXRzIHN1cmZhY2UgaW1wb3J0IHJlcG9ydHMgKHNlZSBgZW5zdXJlRGFlbW9uYCkuIFRocmVlIGRlZmVjdCBjbGFzc2VzLCBvbmVcbi8vIHNlbnRlbmNlOyB0aGlzIGlzIHRoZSBmaXJzdCBvZiB0aGUgdGhyZWUuXG4vLyBgZ3JpbW9pcmUvc3Bhd24tcGF0aC13YXJkLnRlc3QudHNgIHJlc29sdmVzIHRoaXMgYXJpdGhtZXRpYyB0aGUgd2F5IHRoZVxuLy8gcnVudGltZSB3aWxsLCBmcm9tIHRoZSBFTUlUVEVEIGZpbGUncyBvd24gZGlyZWN0b3J5LCBhbmQgYXNzZXJ0cyB0aGUgZmlsZSBpc1xuLy8gdGhlcmUuXG5jb25zdCBEQUVNT05fU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcImRhZW1vbi50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gVGhlIHdhdGNoIHN1cmZhY2UgaXMgYnVpbHQgKHNyYy9ncmFwZXZpbmUvc3VyZmFjZSDihpIgZGlzdC8pLiBCdW4gcmVhZHNcbi8vIGJ1bmZpZy50b21sICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyBpbiBERVYgbW9kZSB0aGUgZGFlbW9uJ3Ncbi8vIGN3ZCBNVVNUIGJlIHNyYy9ncmFwZXZpbmUvIChzZWFtcyBDb250cmFjdCA1KSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgYW5kIHRoZSBwYWdlIGZhaWxzIChtZWFzdXJlZCBvblxuLy8gZ2xhbW91cjogSFRUUCA1MDAsIG5vIHN0eWxlc2hlZXQgbGluaykuIEluIFJFTEVBU0UgbW9kZSBkaXN0LyBpcyBzdGF0aWMgYW5kXG4vLyBwcmUtYnVpbHQsIG5vIGJ1bmZpZyBpcyByZWFkLCBhbmQgc3JjL2dyYXBldmluZS8gbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhXG4vLyBzb3VyY2UtZnJlZSBtYXJrZXRwbGFjZSBjbG9uZSBoYXMgbm8gdG9wLWxldmVsIHNyYy8pIOKAlCBzbyB0aGUgY3dkIHN0YXlzIGF0XG4vLyB0aGUgc2tpbGwgcm9vdC4gU2FtZSBzaGFwZSBhcyBnbGFtb3VyJ3MgZGFlbW9uQ3dkKCkuIEV4cG9ydGVkIGZvciB0ZXN0cy5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJncmFwZXZpbmVcIik7XG5cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLy8g4pSA4pSAIERhZW1vbiBIVFRQIHByb3RvY29sIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gUmVzcG9uc2Ugc2hhcGVzIHRoZSBkYWVtb24gZW1pdHMuIEFueSBlbmRwb2ludCBjYW4gYWxzbyByZXR1cm4gYW4gZXJyb3Jcbi8vIGJvZHkgd2l0aCBhIDR4eC81eHggc3RhdHVzLCBzbyBlYWNoIGNhcnJpZXMgYW4gb3B0aW9uYWwgYGVycm9yYC5cblxudHlwZSBNZXNzYWdlID0ge1xuICBpZDogbnVtYmVyO1xuICBjaGFubmVsOiBzdHJpbmc7XG4gIGZyb206IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICB0czogbnVtYmVyO1xuICBraW5kOiBcIm1lc3NhZ2VcIiB8IFwidG9waWNcIiB8IFwiYW5ub3VuY2VtZW50XCIgfCBcInN0YXR1c1wiO1xuICBpbl9yZXBseV90bz86IG51bWJlcjtcbiAgdGFyZ2V0PzogbnVtYmVyO1xuICBkaXNwb3NpdGlvbj86IHN0cmluZztcbiAgLy8gQ2hhbm5lbC1sZXZlbCBsaWZlY3ljbGUgZmFjdCAoYXJjaGl2ZSAvIHVuYXJjaGl2ZSkuIEEga2luZDpcInN0YXR1c1wiIGZyYW1lXG4gIC8vIGNhcnJ5aW5nIGBldmVudGAgYW5kIG5vIGBkaXNwb3NpdGlvbmAg4oCUIHNlZSBpc0Rpc3Bvc2l0aW9uRnJhbWUuXG4gIGV2ZW50PzogXCJhcmNoaXZlZFwiIHwgXCJ1bmFyY2hpdmVkXCI7XG59O1xuXG4vLyBHRVQgLyDigJQgZGFlbW9uIGxpdmVuZXNzL2luZm8uXG50eXBlIFJvb3RJbmZvID0ge1xuICBvaz86IGJvb2xlYW47XG4gIHBpZD86IG51bWJlcjtcbiAgc3RhcnRlZF9hdD86IG51bWJlcjtcbiAgY2hhbm5lbHM/OiBudW1iZXI7XG4gIGRhdGFfZGlyPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9jaGFubmVscy88bmFtZT4vbWVzc2FnZXMg4oCUIG1lc3NhZ2UgcmVjZWlwdCB3aXRoIGRlbGl2ZXJ5IGFjY291bnRpbmcuXG50eXBlIFNlbmRSZWNlaXB0ID0gTWVzc2FnZSAmIHtcbiAgc3Vic2NyaWJlcnM/OiBudW1iZXI7XG4gIHJlY2lwaWVudHM/OiBudW1iZXI7XG4gIHN1YnNjcmliZXJfYWxpYXNlcz86IHN0cmluZ1tdO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2Fubm91bmNlIOKAlCBjcm9zcy1jaGFubmVsIGJyb2FkY2FzdCByZWNlaXB0LlxudHlwZSBBbm5vdW5jZVJlY2VpcHQgPSB7XG4gIG9rOiBib29sZWFuO1xuICBjaGFubmVsczogeyBuYW1lOiBzdHJpbmc7IHJlY2lwaWVudHM6IG51bWJlciB9W107XG4gIHNraXBwZWQ6IHsgbmFtZTogc3RyaW5nOyByZWFzb246IHN0cmluZyB9W107XG4gIHRvdGFsX3JlY2lwaWVudHM6IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzIOKAlCBjaGFubmVsIGRpcmVjdG9yeSBsaXN0aW5nLlxudHlwZSBDaGFubmVsU3VtbWFyeSA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAvLyBudWxsID0gdGhlIGRhZW1vbiBjb3VsZCBub3QgZXN0YWJsaXNoIGEgY291bnQgKHVucmVhZGFibGUgZmlsZSksIE5FVkVSIDAuXG4gIC8vIDAgbWVhbnMgXCJ0aGlzIGNoYW5uZWwgaXMgZ2VudWluZWx5IGVtcHR5XCIgYW5kIG5vdGhpbmcgZWxzZSDigJQgYjUuXG4gIG1lc3NhZ2VfY291bnQ6IG51bWJlciB8IG51bGw7XG4gIGxhc3RfYWN0aXZpdHk6IG51bWJlcjtcbiAgbG9hZGVkOiBib29sZWFuO1xufTtcbnR5cGUgQ2hhbm5lbHNSZXNwb25zZSA9IHsgY2hhbm5lbHM/OiBDaGFubmVsU3VtbWFyeVtdOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBBbnkgZW5kcG9pbnQgbWF5IHJlcGx5IHdpdGgganVzdCBhbiBlcnJvci9vayBlbnZlbG9wZS5cbnR5cGUgU3RhdHVzUmVzcG9uc2UgPSB7IG9rPzogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vbWVzc2FnZXMgYW5kID9zaW5jZT0gcmFuZ2VzLlxudHlwZSBNZXNzYWdlc1Jlc3BvbnNlID0geyBtZXNzYWdlcz86IE1lc3NhZ2VbXTsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vd2FpdCDigJQgbG9uZy1wb2xsIGJhdGNoLlxudHlwZSBXYWl0UmVzcG9uc2UgPSB7XG4gIG1lc3NhZ2VzPzogTWVzc2FnZVtdO1xuICBjdXJzb3I/OiBudW1iZXI7XG4gIHRpbWVkX291dD86IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xuICAvLyBBIHJlZnVzYWwgbmFtZXMgdGhlIGFjdCB0aGF0IHJlY292ZXJzIGZyb20gaXQgKDQwNCBvbiBhIG1pc3NpbmcgY2hhbm5lbCkuXG4gIGhpbnQ/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9jaGFubmVscyDigJQgb3Blbi9lbnN1cmUgYSBjaGFubmVsLlxudHlwZSBPcGVuUmVzcG9uc2UgPSB7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGNyZWF0ZWRfYXQ/OiBudW1iZXI7XG4gIG1lc3NhZ2VfY291bnQ/OiBudW1iZXI7XG4gIHN1YnNjcmliZXJzPzogbnVtYmVyO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIHVuYXJjaGl2ZWQ/OiBib29sZWFuO1xuICBjbGVhcmVkPzogYm9vbGVhbjtcbiAgc25hcHNob3Q/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3RvcGljIGFuZCBQVVQgL2NoYW5uZWxzLzxuYW1lPi90b3BpYy5cbnR5cGUgVG9waWNSZXNwb25zZSA9IHtcbiAgb2s/OiBib29sZWFuO1xuICBjaGFubmVsPzogc3RyaW5nO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIGlkPzogbnVtYmVyO1xuICBlcnJvcj86IHN0cmluZztcbiAgaGludD86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3N1YnNjcmliZXJzIOKAlCBzaW5nbGUtY2hhbm5lbCByb3N0ZXIuXG50eXBlIFN1YnNjcmliZXJzUmVzcG9uc2UgPSB7XG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzPzogc3RyaW5nW107XG4gIGh1bWFucz86IHN0cmluZ1tdO1xuICBjb3VudD86IG51bWJlcjtcbiAgY29ubmVjdGlvbnM/OiBudW1iZXI7XG4gIG5hbWVkPzogbnVtYmVyO1xuICBhbm9ueW1vdXM/OiBudW1iZXI7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQZXItY2hhbm5lbCBwcmVzZW5jZSBlbnRyeSBmcm9tIEdFVCAvcHJlc2VuY2UuXG50eXBlIFByZXNlbmNlQ2hhbm5lbCA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBzdWJzY3JpYmVyczogc3RyaW5nW107XG4gIGh1bWFucz86IHN0cmluZ1tdO1xuICBjb25uZWN0aW9uczogbnVtYmVyO1xuICBuYW1lZDogbnVtYmVyO1xuICBhbm9ueW1vdXM6IG51bWJlcjtcbn07XG50eXBlIFByZXNlbmNlUmVzcG9uc2UgPSB7IGNoYW5uZWxzPzogUHJlc2VuY2VDaGFubmVsW107IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIFNTRSBmcmFtZXMgcHVzaGVkIG9uIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3RhaWwuIFR3byBmcmFtZSBraW5kcyBhcnJpdmUgb25cbi8vIHRoZSBzYW1lIGBkYXRhOmAgbGluZSDigJQgYSBgc3Vic2NyaWJlZGAgZXZlbnQgYW5kIHBlci1tZXNzYWdlIGZyYW1lcyDigJQgc28gdGhlXG4vLyBkZWNvZGVkIHBheWxvYWQgaXMgYSB1bmlvbi4gQWxsIGZpZWxkcyBvcHRpb25hbCBiZWNhdXNlIHRoZSBmcmFtZSBpc1xuLy8gdW50cnVzdGVkIHdpcmUgZGF0YSBuYXJyb3dlZCBhdCB0aGUgdXNlIHNpdGUuXG50eXBlIFRhaWxQYXlsb2FkID0ge1xuICAvLyBzdWJzY3JpYmVkLWV2ZW50IGZpZWxkc1xuICBzaW5jZT86IG51bWJlcjtcbiAgYXM/OiBzdHJpbmcgfCBudWxsO1xuICBsYXRlc3RfaWQ/OiBudW1iZXI7XG4gIC8vIFRydWUgd2hlbiBUSElTIHN1YnNjcmliZSBjcmVhdGVkIHRoZSBjaGFubmVsIOKAlCB0aGUgc2lnbmFsIHRoYXQgc2VwYXJhdGVzXG4gIC8vIFwicXVpZXQgY2hhbm5lbFwiIGZyb20gXCJ5b3UgdGFpbGVkIGEgbmFtZSB0aGF0IGRpZCBub3QgZXhpc3RcIi5cbiAgY3JlYXRlZD86IGJvb2xlYW47XG4gIC8vIFRydWUgd2hlbiB0aGUgY2hhbm5lbCBpcyBhbHJlYWR5IGFyY2hpdmVkIChyZWFkLW9ubHkpIGF0IHN1YnNjcmliZSB0aW1lIOKAlFxuICAvLyB0aGUgc2lnbmFsIGZvciBhIExBVEUgam9pbmVyLCB3aG8gd291bGQgb3RoZXJ3aXNlIGxlYXJuIGl0IGZyb20gYSByZWplY3RlZFxuICAvLyBzZW5kLiBUaGUgbGlmZWN5Y2xlIGZyYW1lIG9ubHkgcmVhY2hlcyBhbiBhZ2VudCB0aGF0IHdhcyBjb25uZWN0ZWQgYXQgdGhlXG4gIC8vIG1vbWVudCwgb3IgdGhhdCBwdWxscyBoaXN0b3J5LlxuICBhcmNoaXZlZD86IGJvb2xlYW47XG4gIC8vIG1lc3NhZ2UgZmllbGRzXG4gIGlkPzogbnVtYmVyO1xuICBmcm9tPzogc3RyaW5nO1xuICB0ZXh0Pzogc3RyaW5nO1xuICB0cz86IG51bWJlcjtcbiAga2luZD86IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIC8vIHNoYXJlZFxuICBjaGFubmVsPzogc3RyaW5nO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG59O1xuXG4vLyBPdXIgcGx1Z2luIHZlcnNpb24gKGZyb20gcGx1Z2luLmpzb24pLiBVc2VkIHRvIGRldGVjdCBjYWNoZS1waW5uaW5nXG4vLyBtaXNtYXRjaGVzIHdoZW4gd2UgdGFsayB0byBhIGRhZW1vbiBzcGF3bmVkIGZyb20gYSBkaWZmZXJlbnQgY2FjaGVkXG4vLyBwYXRoLiBCZXN0LWVmZm9ydDsgbnVsbCBpZiByZWFkIGZhaWxzLlxuZnVuY3Rpb24gcmVhZFBsdWdpblZlcnNpb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGx1Z2luSnNvblBhdGggPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKTtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocGx1Z2luSnNvblBhdGgsIFwidXRmLThcIik7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KS52ZXJzaW9uID8/IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5jb25zdCBQTFVHSU5fVkVSU0lPTiA9IHJlYWRQbHVnaW5WZXJzaW9uKCk7XG5cbi8vIE9uZS1zaG90IHZlcnNpb24tbWlzbWF0Y2ggY2hlY2suIFRoZSBkYWVtb24gbWF5IGJlIGZyb20gYSBkaWZmZXJlbnRcbi8vIGNhY2hlZCBwbHVnaW4gcGF0aCB0aGFuIHRoaXMgQ0xJIChleGlzdGluZyB0YWlsIHByb2Nlc3NlcycgYXV0by1yZWNvbm5lY3Rcbi8vIGNhbiByYWNlIGEgYHN0b3BgIGFuZCByZXNwYXduIHRoZSBvbGQgZGFlbW9uKS4gV2FybiBvbmNlIHBlciBpbnZvY2F0aW9uXG4vLyBzbyB0aGUgdXNlciBoYXMgYSBzaWduYWwgaW5zdGVhZCBvZiBzaWxlbnRseSBkZWdyYWRlZCBiZWhhdmlvci5cbmxldCBfdmVyc2lvbkNoZWNrRG9uZSA9IGZhbHNlO1xuYXN5bmMgZnVuY3Rpb24gbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydDogbnVtYmVyKSB7XG4gIGlmIChfdmVyc2lvbkNoZWNrRG9uZSkgcmV0dXJuO1xuICBfdmVyc2lvbkNoZWNrRG9uZSA9IHRydWU7XG4gIGlmICghUExVR0lOX1ZFUlNJT04pIHJldHVybjsgLy8gY2FuJ3QgY29tcGFyZSBpZiB3ZSBkb24ndCBrbm93IG91ciBvd24gdmVyc2lvblxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDUwMCksXG4gICAgfSk7XG4gICAgaWYgKCFyZXMub2spIHJldHVybjtcbiAgICBjb25zdCBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJvb3RJbmZvO1xuICAgIGNvbnN0IGRhZW1vblZlcnNpb24gPSBkYXRhPy52ZXJzaW9uID8/IG51bGw7XG4gICAgaWYgKGRhZW1vblZlcnNpb24gPT09IG51bGwpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBncmFwZXZpbmU6IGRhZW1vbiBpcyBvbGRlciB0aGFuIHRoaXMgQ0xJIChubyB2ZXJzaW9uIHJlcG9ydGVkKS4gYCArXG4gICAgICAgICAgYENMSSBpcyB2JHtQTFVHSU5fVkVSU0lPTn0uIFNvbWUgZmVhdHVyZXMgbWF5IHNpbGVudGx5IGRlZ3JhZGUuIGAgK1xuICAgICAgICAgIGBSZXN0YXJ0IHRoZSBkYWVtb24gKGRyb3AgdGFpbHMsIHRoZW4gXFxgc3RvcFxcYCwgdGhlbiBhbnkgdmVyYikgdG8gdXBncmFkZS5cXG5gLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKGRhZW1vblZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgZ3JhcGV2aW5lOiBkYWVtb24gdmVyc2lvbiAodiR7ZGFlbW9uVmVyc2lvbn0pIGRpZmZlcnMgZnJvbSBDTEkgdmVyc2lvbiAodiR7UExVR0lOX1ZFUlNJT059KS4gYCArXG4gICAgICAgICAgYFNvbWUgZmVhdHVyZXMgbWF5IHNpbGVudGx5IGRlZ3JhZGUuIFJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbi5cXG5gLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGJlc3QtZWZmb3J0XG4gIH1cbn1cbi8vIEdSQVBFVklORV9GUk9NIHNldHMgdGhlIGRlZmF1bHQgLS1mcm9tIC8gLS1hcyBhbGlhcyBzbyBhZ2VudHMgZG9uJ3QgaGF2ZVxuLy8gdG8gcmVwZWF0IHRoZWlyIGlkZW50aXR5IG9uIGV2ZXJ5IHZlcmIuIFBlci12ZXJiIGZsYWdzIHN0aWxsIG92ZXJyaWRlLlxuY29uc3QgREVGQVVMVF9BTElBUyA9IHByb2Nlc3MuZW52LkdSQVBFVklORV9GUk9NID8/IHVuZGVmaW5lZDtcblxuLy8gSWRlbnRpdHkgZmxhZ3MgYXJlIGludGVyY2hhbmdlYWJsZSBhY3Jvc3MgdmVyYnMuIGBzZW5kYCBoaXN0b3JpY2FsbHkgdG9va1xuLy8gYC0tZnJvbWAgd2hpbGUgYHRhaWxgL2B3YWl0YCB0b29rIGAtLWFzYCDigJQgc2FtZSBjb25jZXB0ICh3aG8gYW0gSSksIGFuZCB0aGVcbi8vIGFzeW1tZXRyeSB0cmlwcyB5b3UgbWlkLWZsb3cuIEFjY2VwdCBlaXRoZXIgZXZlcnl3aGVyZSBpZGVudGl0eSBpcyBtZWFudCxcbi8vIGZhbGxpbmcgYmFjayB0byBHUkFQRVZJTkVfRlJPTS4gKGdyZXAncyBgLS1mcm9tYCBpcyBhIGRpZmZlcmVudCB0aGluZyDigJQgYW5cbi8vIGF1dGhvciAqZmlsdGVyKiwgbm90IGlkZW50aXR5IOKAlCBzbyBpdCBkb2Vzbid0IHVzZSB0aGlzLilcbmZ1bmN0aW9uIHJlc29sdmVBbGlhcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gKGZsYWdzLmZyb20gYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyAoZmxhZ3MuYXMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBERUZBVUxUX0FMSUFTO1xufVxuLy8gVHJ1bmNhdGlvbi1oaW50IHRocmVzaG9sZC4gTWVzc2FnZXMgbG9uZ2VyIHRoYW4gdGhpcyBnZXQgYSBgdHJ1bmNhdGlvbl9oaW50YFxuLy8gZmllbGQgb24gdGhlIHRhaWwgSlNPTiBzbyBjb25zdW1lcnMgKGUuZy4gTW9uaXRvcikga25vdyB0aGUgbm90aWZpY2F0aW9uXG4vLyBwcmV2aWV3IGlzIGluY29tcGxldGUgYW5kIHNob3VsZCBgcmVhZGAgdGhlIGZ1bGwgYm9keS4gSW4gYWdlbnQtdG8tYWdlbnRcbi8vIHRyYWZmaWMsIGxvbmcgbWVzc2FnZXMgYXJlIHRoZSBOT1JNICh0aGUgVjEuNiByb3VuZHRhYmxlIHNhdyBtb3N0IHN1YnN0YW50aXZlXG4vLyBtZXNzYWdlcyBleGNlZWQgODAwKSwgc28gYW4gODAwIGRlZmF1bHQgZmlyZWQgb24gbmVhcmx5IGV2ZXJ5dGhpbmcgYW5kIHRoZVxuLy8gcmVjb3ZlcnkgcGF0aCBiZWNhbWUgdGhlIG1haW4gcGF0aC4gRGVmYXVsdCByYWlzZWQgdG8gMjAwMCBzbyB0aGUgaGludCBtYXJrc1xuLy8gdGhlIGdlbnVpbmVseS1sb25nIG91dGxpZXJzLiBPdmVycmlkYWJsZSB2aWEgZW52IHZhciBmb3IgdHVuaW5nLlxuY29uc3QgVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRCA9IHBhcnNlSW50KFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRCA/PyBcIjIwMDBcIixcbiAgMTAsXG4pO1xuXG4vLyBPcHRpb25hbCBpbmxpbmUtYm9keSBjYXAgZm9yIGB0YWlsYCAob3B0LWluIHZpYSAtLW1heCA8bj4gb3IgR1JBUEVWSU5FX1RBSUxfTUFYKS5cbi8vIFdoZW4gc2V0LCBhIGJvZHkgbG9uZ2VyIHRoYW4gdGhlIGNhcCBpcyB0cnVuY2F0ZWQgdG8gYG5gIGNoYXJzIGluIHRoZSB0YWlsXG4vLyBmcmFtZSAocGx1cyB0aGUgcmVhZC1wb2ludGVyIGhpbnQpLCBzbyBhIHB1c2ggY29uc3VtZXIgY2FuIGhhbmQgaXRzXG4vLyBub3RpZmljYXRpb24gc3VyZmFjZSBhIGRlbGliZXJhdGVseS1zaXplZCBsaW5lLiBUaGUgRlVMTCBtZXNzYWdlIGlzIGFsd2F5c1xuLy8gcmV0cmlldmFibGUgdmlhIGByZWFkIDxjaGFubmVsPiA8aWQ+YC4gVW5kZWZpbmVkID0gbm8gY2FwIChmdWxsIHRleHQgaW5saW5lIOKAlFxuLy8gdG9kYXkncyBkZWZhdWx0KS4gTm90ZTogdGhlIGhhcmQgY2xpcCBhIGNvbnN1bWVyIHVsdGltYXRlbHkgc2VlcyBpcyBzdGlsbCB0aGVcbi8vIE1vbml0b3Ivbm90aWZpY2F0aW9uIGxheWVyJ3M7IC0tbWF4IG9ubHkgYm91bmRzIHRoZSBsaW5lIGdyYXBldmluZSBlbWl0cy5cbi8vIFJlamVjdHMgbmVnYXRpdmUgLyBub24tbnVtZXJpYy5cbmZ1bmN0aW9uIHJlc29sdmVUYWlsTWF4KGZsYWc6IHVua25vd24pOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBjb25zdCByYXcgPSB0eXBlb2YgZmxhZyA9PT0gXCJzdHJpbmdcIiA/IGZsYWcgOiBwcm9jZXNzLmVudi5HUkFQRVZJTkVfVEFJTF9NQVg7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID49IDAgPyBuIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZSDigJQgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgJ3MgYGRpZWAsIHVuZGVyIHRoaXNcbiAqIHNwZWxsJ3Mgb3duIG5hbWUgc28gNDYgY2FsbCBzaXRlcyBkaWQgbm90IGVhY2ggaGF2ZSB0byBiZSByZS1zcGVsbGVkLlxuICpcbiAqIOKblCAqKklUIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgQSBDQUxMRVItVklTSUJMRSBDSEFOR0UqKlxuICogKFBoYXNlIDYgY2hhcHRlciAyOyB0aGUgZGVsdGEgaXMgZHJpdmVuIGFuZCByZWNvcmRlZCBpbiB0aGUgam91cm5hbCkuIFRoaXNcbiAqIGZ1bmN0aW9uIHdhcyBgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXFxgZ3JhcGV2aW5lOiAke21zZ31cXG5cXGApOyBwcm9jZXNzLmV4aXQoY29kZSlgXG4gKiDigJQgUFJPU0UgYXQgZXhpdCAyIGZvciBldmVyeSBmYWlsdXJlIGdyYXBldmluZSBjb3VsZCBwcm9kdWNlLCB3aXRoIHR3byBzaXRlc1xuICogcGFzc2luZyAxLiBBZnRlciB0aGUgYWRvcHRpb24gaXQgaXMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIGFuZCB0aGVcbiAqIGFjYyB0YXhvbm9teSdzIGNvZGVzOiB1c2FnZSAyLCBpbnRlcm5hbCAxLCBub3RfZm91bmQgNSwgY29uZmxpY3QgNi4gQW4gYWdlbnRcbiAqIHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGU7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24gYW5kIHJld29yZGluZ1xuICogaXQgbXVzdCBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZGlkIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZWQgcHJvc2UuXG4gKlxuICog4puUICoqQU5EIFRIRSBFTlVNRVJBVElPTlMgTU9WRUQgRlJPTSBQUk9TRSBJTlRPIGBjaG9pY2VzYC4qKiBncmFwZXZpbmUnc1xuICogcmVqZWN0aW9ucyB3ZXJlIHNoYXBlZCBmb3IgYWNjJ3MgZmxhZy1zZXQgZXh0cmFjdG9ycyDigJQgYHJlY29nbml6ZWQgZmxhZ3M6IC0tYVxuICogLS1iYCwgd2l0aCBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXQgYSBxdWFsaWZpZXIgYmV0d2VlbiB0aGUgbm91biBhbmQgdGhlIGNvbG9uXG4gKiBcInJlYWRzIGFzIHByb3NlLCBub3QgYSBzZXRcIi4gV3JhcHBlZCBpbiBKU09OIHRoYXQgbWFya2VyIGJlY29tZXMgYSBzdWJzdHJpbmcgb2ZcbiAqIGFuIGVzY2FwZWQgc3RyaW5nLCBzbyBpdCBkb2VzIG5vdCBzdGF5IGluIHByb3NlOiBldmVyeSBlbnVtZXJhdGlvbiBpcyBub3cgYVxuICogYGNob2ljZXNgIGFycmF5LCB3aGljaCBpcyB3aGF0IGdsYW1vdXIgKENPTkZPUk1BTlQgTDApIHB1Ymxpc2hlcyBhbmQgd2hhdCB0aGVcbiAqIGVudmVsb3BlIGhhcyBhIGZpZWxkIGZvci4gVGhlIHJ1bm5hYmxlIHJlY292ZXJ5IOKAlCBgdHJ5OiBidW4g4oCmL2NsaS50cyBvcGVuIHhgIOKAlFxuICogbW92ZWQgaW50byBgaGludGAgZm9yIHRoZSBzYW1lIHJlYXNvbiwgYW5kIGEgY2FsbGVyIG5vdyByZWFkcyBhIGZpZWxkIGluc3RlYWRcbiAqIG9mIHNwbGl0dGluZyBhIHNlbnRlbmNlLlxuICpcbiAqIOKaoCBgZGllYCBpcyBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIHN3YWxsb3dzLCBhbmQgdGhhdCBpc1xuICogbm93IGEgc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIEF1ZGl0ZWQgYnkgY2FsbCBncmFwaCBhdCB0aGVcbiAqIGFkb3B0aW9uIChwbGF5Ym9vayBCOSk7IHRoZSBjb3VudCBpcyBpbiB0aGUgam91cm5hbC5cbiAqL1xuZnVuY3Rpb24gZGllKG1zZzogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICByYWlzZShtc2csIGtpbmQsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBUaGUgdGF4b25vbXkgYGtpbmRgIGZvciBhbiBIVFRQIHN0YXR1cyB0aGUgZGFlbW9uIGFuc3dlcmVkIHdpdGguXG4gKlxuICog4puUIE9ORSBNQVBQSU5HLCBOT1QgQSBKVURHRU1FTlQgUEVSIFNJVEUuIFR3ZW50eSBvZiBncmFwZXZpbmUncyByYWlzZSBzaXRlc1xuICogYXJlIFwidGhlIGRhZW1vbiBzYWlkIG5vXCI7IGJlZm9yZSB0aGUgYWRvcHRpb24gZXZlcnkgb25lIG9mIHRoZW0gY29sbGFwc2VkIHRvXG4gKiBleGl0IDIsIHNvIGEgbWlzc2luZyBjaGFubmVsLCBhIGxpdmUtc2Vzc2lvbiByZWZ1c2FsIGFuZCBhIGJyb2tlbiBkYWVtb24gd2VyZVxuICogb25lIG51bWJlciB0byBhbiBhZ2VudC4gVGhlIGRhZW1vbiBhbHJlYWR5IGRpc3Rpbmd1aXNoZXMgdGhlbSBieSBzdGF0dXMg4oCUXG4gKiA0MDQgZm9yIGEgY2hhbm5lbCB0aGF0IGRvZXMgbm90IGV4aXN0LCA0MDkgZm9yIGFyY2hpdmVkIC8gbGl2ZSAvIGFscmVhZHktb3BlblxuICog4oCUIHNvIHRoZSBtYXBwaW5nIGlzIGEgcmUtcmVhZGluZyBvZiB3aGF0IHdhcyBvbiB0aGUgd2lyZSwgbm90IGEgbmV3IG9waW5pb24uXG4gKi9cbmZ1bmN0aW9uIGtpbmRGb3JTdGF0dXMoc3RhdHVzOiBudW1iZXIpOiBFcnJLaW5kIHtcbiAgaWYgKHN0YXR1cyA9PT0gNDA0KSByZXR1cm4gXCJub3RfZm91bmRcIjtcbiAgaWYgKHN0YXR1cyA9PT0gNDA5KSByZXR1cm4gXCJjb25mbGljdFwiO1xuICBpZiAoc3RhdHVzID49IDQwMCAmJiBzdGF0dXMgPCA1MDApIHJldHVybiBcInVzYWdlXCI7XG4gIHJldHVybiBcImludGVybmFsXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWREYWVtb25Qb3J0KCk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICBpZiAoIWV4aXN0c1N5bmMoUE9SVF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhQT1JUX0ZJTEUsIFwidXRmLThcIikudHJpbSgpO1xuICBjb25zdCBwb3J0ID0gcGFyc2VJbnQocmF3LCAxMCk7XG4gIGlmICghcG9ydCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICB9KTtcbiAgICBpZiAocmVzLm9rKSB7XG4gICAgICAvLyBGaXJlLWFuZC1mb3JnZXQgbWlzbWF0Y2ggY2hlY2sgKHdvbid0IGJsb2NrIHRoZSB2ZXJiKS5cbiAgICAgIG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKHBvcnQpO1xuICAgICAgcmV0dXJuIHBvcnQ7XG4gICAgfVxuICB9IGNhdGNoIHt9XG4gIC8vIFN0YWxlIOKAlCBjbGVhbiB1cC5cbiAgdHJ5IHtcbiAgICB1bmxpbmtTeW5jKFBPUlRfRklMRSk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICB1bmxpbmtTeW5jKFBJRF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gaG9sZEFjdGl2ZSgpOiBudW1iZXIgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgdW50aWwgPSBwYXJzZUludChyZWFkRmlsZVN5bmMoSE9MRF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKSwgMTApO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUodW50aWwpICYmIHVudGlsID4gRGF0ZS5ub3coKSkgcmV0dXJuIHVudGlsO1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKEhPTERfRklMRSk7XG4gICAgfSBjYXRjaCB7fSAvLyBleHBpcmVkIOKGkiBjbGVhblxuICAgIHJldHVybiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIHJlbGVhc2VIb2xkKCkge1xuICB0cnkge1xuICAgIGlmIChleGlzdHNTeW5jKEhPTERfRklMRSkpIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIGlmIChob2xkQWN0aXZlKCkpXG4gICAgZGllKFxuICAgICAgXCJkYWVtb24gaXMgaGVsZCAocmVzcGF3biBzdXBwcmVzc2VkKSDigJQgd2FpdCBmb3IgdGhlIGhvbGQgdG8gY2xlYXIgb3IgcnVuIGBncmFwZXZpbmUgcm9sbGBcIixcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICAvLyBDaGVjayB0aGUgY3dkIEVYSVNUUyBiZWZvcmUgc3Bhd25pbmc6IHRoZSBkYWVtb24ncyBzdGRpbyBpcyBpZ25vcmVkLCBzbyBhXG4gIC8vIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQgd291bGQgb3RoZXJ3aXNlIHN1cmZhY2Ugb25seSBhc1xuICAvLyBcImZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiDigJQgYW5kIG5vZGUgcmVwb3J0cyBhIG1pc3NpbmcgY3dkIGFzIEVOT0VOVCBvblxuICAvLyB0aGUgZXhlY3V0YWJsZSwgd2hpY2ggcmVhZHMgYXMgXCJidW4gaXMgbWlzc2luZ1wiLlxuICBjb25zdCBjd2QgPSBkYWVtb25Dd2QoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGN3ZCkpIHtcbiAgICBkaWUoXG4gICAgICBgZ3JhcGV2aW5lIGNhbm5vdCBzdGFydCBpdHMgZGFlbW9uOiB0aGUgd29ya2luZyBkaXJlY3RvcnkgaXQgbmVlZHMgaXMgbWlzc2luZyDigJQgJHtjd2R9LiBgICtcbiAgICAgICAgXCJObyBkaXN0L2luZGV4Lmh0bWwgd2FzIGZvdW5kIChvciBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPWRldiBpcyBzZXQpLCBzbyB0aGUgZGFlbW9uIFwiICtcbiAgICAgICAgXCJtdXN0IHJ1biBmcm9tIHNyYy9ncmFwZXZpbmUvIHRvIGJ1bmRsZSB0aGUgd2F0Y2ggc3VyZmFjZSwgd2hpY2ggYSBzb3VyY2UtZnJlZSBpbnN0YWxsIFwiICtcbiAgICAgICAgXCJkb2VzIG5vdCBoYXZlLiBFaXRoZXIgdGhlIHNoaXBwZWQgZGlzdC8gaXMgbWlzc2luZyAocmVpbnN0YWxsIHRoZSBzcGVsbCkgb3IgeW91IGFyZSBpbiBcIiArXG4gICAgICAgIFwiYSBjaGVja291dCB3aXRob3V0IHNyYy9ncmFwZXZpbmUvLlwiLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICk7XG4gIH1cbiAgLy8gU3Bhd24gZGV0YWNoZWQgc28gdGhlIGRhZW1vbiBzdXJ2aXZlcyB0aGlzIENMSSBwcm9jZXNzIGV4aXQuXG4gIGNvbnN0IHByb2MgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbREFFTU9OX1NDUklQVF0sIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgY3dkLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBXYWl0IHVwIHRvIDNzIGZvciB0aGUgcG9ydCBmaWxlIHRvIGFwcGVhciBhbmQgcmVzcG9uZC5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgMzAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gICAgaWYgKHBvcnQpIHJldHVybiBwb3J0O1xuICB9XG4gIGRpZShcImRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzXCIsIFwiaW50ZXJuYWxcIiwge1xuICAgIGhpbnQ6XG4gICAgICBcInRocmVlIHVucmVsYXRlZCBjYXVzZXMgcmVwb3J0IHRoaXMgb25lIHNlbnRlbmNlOiB0aGUgZGFlbW9uJ3MgbGF1bmNoZXIgc2hhcGUsIFwiICtcbiAgICAgIFwiYSB3cm9uZyBzcGF3biBwYXRoLCBhbmQgYSBkZXYtbW9kZSBkYWVtb24gZHlpbmcgYXQgaXRzIHN1cmZhY2UgaW1wb3J0LiBcIiArXG4gICAgICBcIlJ1biB0aGUgZGFlbW9uIGxhdW5jaGVyIGFsb25lIHRvIHRlbGwgdGhlbSBhcGFydCDigJQgaXQgaXMgdGhlIGxhdW5jaGVyIHNoYXBlIFwiICtcbiAgICAgIFwiaWZmIGl0IHByaW50cyBgbGlzdGVuaW5nIG9uIOKApmAgYW5kIHJldHVybnMgYXQgZXhpdCAwLiBBbiBlbXB0eSBcIiArXG4gICAgICBcIkdSQVBFVklORV9IT01FIChubyBgY2hhbm5lbHMvYCkgbWVhbnMgdGhlIGRhZW1vbiBuZXZlciBib3VuZCBhdCBhbGwuXCIsXG4gIH0pO1xufVxuXG4vLyBHZW5lcmljIG92ZXIgdGhlIGV4cGVjdGVkIHN1Y2Nlc3MgYm9keS4gYGRhdGFgIG1heSBiZSBudWxsIGlmIHRoZSByZXNwb25zZVxuLy8gaGFkIG5vIEpTT04gYm9keSwgc28gY2FsbGVycyBzZWUgYFQgfCBudWxsYC5cbmFzeW5jIGZ1bmN0aW9uIGFwaTxUID0gdW5rbm93bj4oXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IFQgfCBudWxsIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiBUIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBUO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG5mdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bikge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cblxuLy8gSG93IFRISVMgQ0xJIHdhcyBpbnZva2VkLCBhcyBhIHJ1bm5hYmxlIHByZWZpeC4gYHByb2Nlc3MuYXJndlsxXWAgaXMgdGhlXG4vLyBhYnNvbHV0ZSBwYXRoIG9mIGNsaS50cyB1bmRlciBgYnVuIOKApi9jbGkudHMgPHZlcmI+YCwgd2hpY2ggaXMgU0tJTEwubWQnc1xuLy8gY2Fub25pY2FsIGludm9jYXRpb24g4oCUIHNvIHRoZSBsaW5lIHdlIHByaW50IGNhbiBhY3R1YWxseSBiZSBwYXN0ZWQuIEZhbGxzXG4vLyBiYWNrIHRvIHRoZSBiYXJlIHZlcmIgaWYgYXJndiBpcyBub3Qgc2hhcGVkIGFzIGV4cGVjdGVkLCB3aGljaCBpcyBhIHZlcmJcbi8vIHJlZmVyZW5jZSByYXRoZXIgdGhhbiBhIGNvbW1hbmQgdGhhdCBsaWVzIGFib3V0IGJlaW5nIG9uZS5cbmZ1bmN0aW9uIGludm9jYXRpb25QcmVmaXgoKTogc3RyaW5nIHtcbiAgY29uc3QgZW50cnkgPSBwcm9jZXNzLmFyZ3ZbMV07XG4gIHJldHVybiBlbnRyeSA/IGBidW4gJHtlbnRyeX1gIDogXCJcIjtcbn1cblxuLy8gQSBkYWVtb24gcmVmdXNhbCBjYXJyaWVzIGBoaW50YCDigJQgdGhlIGFjdCB0aGF0IHJlY292ZXJzIGZyb20gaXQgKGEgNDA0IG9uIGFcbi8vIHJlYWQgbmFtZXMgdGhlIGBvcGVuYCB0aGF0IHdvdWxkIGNyZWF0ZSB0aGUgY2hhbm5lbCkuXG4vL1xuLy8g4pqgIGBoaW50YCBpcyBhIFZFUkIgSU5WT0NBVElPTiwgbm90IGEgc2hlbGwgY29tbWFuZDogdGhlIGRhZW1vbiBjYW5ub3Qga25vd1xuLy8gaG93IGl0cyBjbGllbnQgd2FzIGludm9rZWQsIHNvIGl0IG5hbWVzIHRoZSBhY3QgYW5kIHdlIHJlbmRlciBpdC4gSXQgdXNlZCB0b1xuLy8gYXJyaXZlIGFzIGBncmFwZXZpbmUgb3BlbiA8bmFtZT5gIGFuZCBiZSBwcmludGVkIHZlcmJhdGltIGFmdGVyIGB0cnk6YCwgd2hpY2hcbi8vIHJlYWRzIGFzIHNvbWV0aGluZyB0byBwYXN0ZSDigJQgYW5kIHBhc3RpbmcgaXQgZ2V0cyBgY29tbWFuZCBub3QgZm91bmRgLFxuLy8gYmVjYXVzZSBub3RoaW5nIGluc3RhbGxzIGEgYGdyYXBldmluZWAgYmluYXJ5LiBSdWxpbmcgMiBhc2tlZCB0aGF0IGEgcmVmdXNhbFxuLy8gbmFtZSB0aGUgbmV4dCBhY3Q7IGEgcmVjb3ZlcnkgdGhhdCBmYWlscyB3aGVuIHlvdSBydW4gaXQgZG9lcyBub3QuXG5mdW5jdGlvbiBkaWVBcGkoZGF0YTogeyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9IHwgbnVsbCwgc3RhdHVzOiBudW1iZXIpOiBuZXZlciB7XG4gIGNvbnN0IG1zZyA9IGRhdGE/LmVycm9yID8/IGBIVFRQICR7c3RhdHVzfWA7XG4gIGNvbnN0IHByZWZpeCA9IGludm9jYXRpb25QcmVmaXgoKTtcbiAgLy8g4puUIFRIRSBSRUNPVkVSWSBJUyBBIEZJRUxEIE5PVywgTk9UIEEgU0VOVEVOQ0UuIEl0IHVzZWQgdG8gYmUgYXBwZW5kZWQgdG8gdGhlXG4gIC8vIG1lc3NhZ2UgYXMgYOKAlCB0cnk6IDxjbWQ+YCwgd2hpY2ggYSBjYWxsZXIgaGFkIHRvIHJlY292ZXIgYnkgc3BsaXR0aW5nIG9uXG4gIC8vIFwidHJ5OiBcIiAob25lIG9mIGdyYXBldmluZSdzIG93biBjZWxscyBkaWQgZXhhY3RseSB0aGF0LCBhbmQgcmFuIHdoYXQgaXRcbiAgLy8gZm91bmQpLiBgaGludGAgaXMgd2hlcmUgdGhlIGVudmVsb3BlIGNhcnJpZXMgaXQsIHNvIHRoZSBzYW1lIGNlbGwgbm93IHJlYWRzXG4gIC8vIGEgZmllbGQgYW5kIHJ1bnMgaXQg4oCUIHRoZSBwcm9wZXJ0eSBpcyB1bmNoYW5nZWQgYW5kIHRoZSBwYXJzZSBpcyBub3QgYSBwYXJzZS5cbiAgY29uc3QgaGludCA9IGRhdGE/LmhpbnRcbiAgICA/IHByZWZpeFxuICAgICAgPyBgdHJ5OiAke3ByZWZpeH0gJHtkYXRhLmhpbnR9YFxuICAgICAgOiBgdHJ5IHRoZSBcXGAke2RhdGEuaGludH1cXGAgdmVyYmBcbiAgICA6IHVuZGVmaW5lZDtcbiAgZGllKG1zZywga2luZEZvclN0YXR1cyhzdGF0dXMpLCB7XG4gICAgLi4uKGhpbnQgPyB7IGhpbnQgfSA6IHt9KSxcbiAgICAvLyBUaGUgdXBzdHJlYW0ncyBib2R5IFZFUkJBVElNLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHdoYXQgdGhlIGRhZW1vblxuICAgIC8vIGFjdHVhbGx5IHNhaWQgcmF0aGVyIHRoYW4gb24gdGhpcyBDTEkncyBwcm9zZSBhYm91dCBpdC5cbiAgICAuLi4oZGF0YSAhPT0gbnVsbCA/IHsgc2VydmVyOiBkYXRhIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBFeGlzdGVuY2UgcHJvYmUgZm9yIHRoZSByZWFkIHZlcmJzIHRoYXQgYW5zd2VyIGZyb20gdGhlIExPRyBGSUxFIHJhdGhlciB0aGFuXG4vLyBmcm9tIGEgcm91dGUgKGB0cmlhZ2VgLCBgcHVsbCAtLXN0YXR1c2ApLiBUaG9zZSBjYW5ub3QgNDA0IG9uIHRoZWlyIG93bjogYVxuLy8gbWlzc2luZyBsb2cgaXMgYW4gZW1wdHkgYXJyYXksIHdoaWNoIGlzIHRoZSBzYW1lIHNpbGVudCBsaWUgdGhlIGRhZW1vbiBndWFyZFxuLy8gZXhpc3RzIHRvIGtpbGwuIEdFVCAvdG9waWMgaXMgdGhlIGNoZWFwZXN0IGd1YXJkZWQgcm91dGUsIHNvIGl0IGlzIHRoZSBwcm9iZS5cbmFzeW5jIGZ1bmN0aW9uIHJlcXVpcmVDaGFubmVsKHBvcnQ6IG51bWJlciwgbmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9PihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG9wdHM6IHsgdG9waWM/OiBzdHJpbmc7IGZyb20/OiBzdHJpbmc7IGZyZXNoPzogYm9vbGVhbiB9LFxuKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiA9IHsgbmFtZSwgZXhwbGljaXQ6IHRydWUgfTtcbiAgaWYgKG9wdHMudG9waWMgIT09IHVuZGVmaW5lZCkgYm9keS50b3BpYyA9IG9wdHMudG9waWM7XG4gIGlmIChvcHRzLmZyb20gIT09IHVuZGVmaW5lZCkgYm9keS5mcm9tID0gb3B0cy5mcm9tO1xuICBpZiAob3B0cy5mcmVzaCkgYm9keS5mcmVzaCA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8T3BlblJlc3BvbnNlPihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IGRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRvcGljKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHRleHQ6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgZnJvbTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB0b3BpYyA8Y2hhbm5lbD4gWzx0ZXh0Pl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgaWYgKHRleHQgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIGB0b3BpYyA8bmFtZT5gIHdpdGggbm8gdGV4dCBpcyBhIFJFQUQg4oCUIGl0IGFza3Mgd2hhdCB0aGUgdG9waWMgaXMsIGFuZCBhXG4gICAgLy8gbWlzc2luZyBjaGFubmVsIGFuc3dlcnMgdGhhdCBxdWVzdGlvbiBieSBiZWluZyBtaXNzaW5nLiBObyBlbnN1cmU6IHRoZVxuICAgIC8vIGVuc3VyZSB3YXMgd2hhdCByZXN1cnJlY3RlZCBhIGNsb3NlZCBjaGFubmVsIGZyb20gYSByZWFkIHZlcmIuXG4gICAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgKTtcbiAgICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gYHRvcGljIDxuYW1lPiA8dGV4dD5gIGlzIGEgV1JJVEUsIHNvIGl0IG1heSBjcmVhdGUg4oCUIGJ1dCBpdCBtdXN0IG5vdCB3cml0ZVxuICAvLyB0byBhbiBBUkNISVZFRCBjaGFubmVsLiBUaGUgUFVUIGVuZm9yY2VzIHRoYXQgaXRzZWxmIG5vdzsgdGhpcyBlbnN1cmUgc3RheXNcbiAgLy8gYmVjYXVzZSBESVNDQVJESU5HIElUUyBTVEFUVVMgaXMgcHJlY2lzZWx5IHRoZSBidWcgYmVpbmcgZml4ZWQgaGVyZS4gQmVmb3JlXG4gIC8vIHRvZGF5IHRoZSA0MDkgdGhhdCBhbnN3ZXJzIGZvciBhbiBhcmNoaXZlZCBuYW1lIHdhcyB0aHJvd24gYXdheSBhbmQgdGhlIFBVVFxuICAvLyB0aGF0IGZvbGxvd2VkIGxhbmRlZDogYGFyY2hpdmUgeDsgdG9waWMgeCBcInRcImAgcmV0dXJuZWQgb2s6dHJ1ZSwgZXhpdCAwLlxuICBjb25zdCBlbnN1cmUgPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9Pihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lIH0pO1xuICBpZiAoZW5zdXJlLnN0YXR1cyA+PSA0MDApIGRpZUFwaShlbnN1cmUuZGF0YSwgZW5zdXJlLnN0YXR1cyk7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8VG9waWNSZXNwb25zZT4ocG9ydCwgXCJQVVRcIiwgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCwge1xuICAgIHRvcGljOiB0ZXh0LFxuICAgIGZyb206IGZyb20gPz8gXCJzeXN0ZW1cIixcbiAgfSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYywgaWQ6IGRhdGE/LmlkIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRMaXN0KCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWxzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Q2hhbm5lbHNSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvY2hhbm5lbHNcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFNlbmQoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIG9wdHM6IHsgcXVpZXQ/OiBib29sZWFuOyB2ZXJib3NlPzogYm9vbGVhbjsgaW5SZXBseVRvPzogbnVtYmVyIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFmcm9tIHx8ICF0ZXh0KSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHNlbmQgPG5hbWU+IC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiB7IGZyb206IHN0cmluZzsgdGV4dDogc3RyaW5nOyBpbl9yZXBseV90bz86IG51bWJlciB9ID0ge1xuICAgIGZyb20sXG4gICAgdGV4dCxcbiAgfTtcbiAgaWYgKG9wdHMuaW5SZXBseVRvICE9PSB1bmRlZmluZWQpIGJvZHkuaW5fcmVwbHlfdG8gPSBvcHRzLmluUmVwbHlUbztcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTZW5kUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlc2AsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIC8vIFRhcmdldCBlY2hvIG9uIHN0ZGVyciDigJQgY29uZmlybXMgV0hFUkUgdGhlIG1lc3NhZ2UgbGFuZGVkIHNvIGEgbWlzcm91dGVkXG4gIC8vIHJlcGx5IChyaWdodCBwcm9tcHQsIHdyb25nIGNoYW5uZWwpIGlzIGNhdWdodCB0aGUgaW5zdGFudCBpdCBoYXBwZW5zIChGOSkuXG4gIC8vIE9uIHN0ZGVyciBzbyBpdCBuZXZlciBwb2xsdXRlcyB0aGUgc3Rkb3V0IEpTT04gcmVjZWlwdCwgYW5kIGl0IGZpcmVzIGV2ZW5cbiAgLy8gdW5kZXIgLS1xdWlldCAodGhlIHNhZmV0eSBzaWduYWwgc2hvdWxkbid0IGJlIHNpbGVuY2VkKS5cbiAgY29uc3QgcmVjaXAgPVxuICAgIGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkXG4gICAgICA/IGAke2RhdGEucmVjaXBpZW50c30gcmVjaXBpZW50KHMpYFxuICAgICAgOiBgJHtkYXRhLnN1YnNjcmliZXJzID8/IDB9IHN1YnNjcmliZXIocylgO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyDihpIgJHtkYXRhLmNoYW5uZWx9IMK3ICR7cmVjaXB9XFxuYCk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIC8vIFRlcnNlIGRlZmF1bHQ6IGlkICsgc3Vic2NyaWJlciBjb3VudCArIHZvaWQgd2FybmluZy4gLS12ZXJib3NlIGFsc29cbiAgLy8gaW5jbHVkZXMgdGhlIHN1YnNjcmliZXIgYWxpYXMgbGlzdCAoc2FtZSBkYXRhIGFzIHRoZSBgd2hvYCB2ZXJiLFxuICAvLyBwaWdneWJhY2tlZCB0byBhdm9pZCBhbiBleHRyYSByb3VuZC10cmlwIHdoZW4gdGhlIHNlbmRlciBjYXJlcykuXG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgaWQ6IGRhdGEuaWQsXG4gICAgY2hhbm5lbDogZGF0YS5jaGFubmVsLFxuICAgIHN1YnNjcmliZXJzOiBkYXRhLnN1YnNjcmliZXJzID8/IDAsXG4gIH07XG4gIC8vIE9ubHkgc3VyZmFjZSByZWNpcGllbnRzIGlmIHRoZSBkYWVtb24gYWN0dWFsbHkgY29tcHV0ZWQgaXQuIERlZmF1bHRpbmdcbiAgLy8gdG8gMCB3YXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBcInJlYWxseSAwXCIgYW5kIGhpZCBzaWxlbnQgVjEuNS1kYWVtb25cbiAgLy8gZGVncmFkYXRpb24gZHVyaW5nIGNyb3NzLXZlcnNpb24gc2Vzc2lvbnM7IG1pc3NpbmctbWVhbnMtbWlzc2luZyBpcyB0aGVcbiAgLy8gaG9uZXN0IHNpZ25hbC5cbiAgaWYgKGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkKSBvdXQucmVjaXBpZW50cyA9IGRhdGEucmVjaXBpZW50cztcbiAgaWYgKGRhdGEuc3Vic2NyaWJlcnMgPT09IDApIG91dC53YXJuaW5nID0gXCJjaGFubmVsIGhhcyBubyBzdWJzY3JpYmVyc1wiO1xuICBlbHNlIGlmIChkYXRhLnJlY2lwaWVudHMgPT09IDApIG91dC53YXJuaW5nID0gXCJvbmx5IHlvdSBhcmUgc3Vic2NyaWJlZFwiO1xuICBpZiAob3B0cy52ZXJib3NlKSBvdXQuc3Vic2NyaWJlcl9hbGlhc2VzID0gZGF0YS5zdWJzY3JpYmVyX2FsaWFzZXMgPz8gW107XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBbm5vdW5jZShcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNoYW5uZWxzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW4gfSxcbikge1xuICBpZiAoIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgYW5ub3VuY2UgLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGNoYW5uZWxzPzogc3RyaW5nW10gfSA9IHsgZnJvbSwgdGV4dCB9O1xuICBpZiAoY2hhbm5lbHM/Lmxlbmd0aCkgYm9keS5jaGFubmVscyA9IGNoYW5uZWxzO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPEFubm91bmNlUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIFwiL2Fubm91bmNlXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgIGAjIGFubm91bmNlZCDihpIgJHtkYXRhLmNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKSDCtyAke2RhdGEudG90YWxfcmVjaXBpZW50c30gcmVjaXBpZW50KHMpXFxuYCxcbiAgKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBjaGFubmVsczogZGF0YS5jaGFubmVscyxcbiAgICB0b3RhbF9yZWNpcGllbnRzOiBkYXRhLnRvdGFsX3JlY2lwaWVudHMsXG4gIH07XG4gIGlmIChkYXRhLnNraXBwZWQ/Lmxlbmd0aCkgb3V0LnNraXBwZWQgPSBkYXRhLnNraXBwZWQ7XG4gIGlmIChkYXRhLmNoYW5uZWxzLmxlbmd0aCA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm5vIGFjdGl2ZSBjaGFubmVscyB0byBhbm5vdW5jZSB0b1wiO1xuICBwcmludEpzb24ob3V0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUHVsbChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlOiBudW1iZXIsIG9wdHM6IHsgc3RhdHVzPzogc3RyaW5nIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcHVsbCA8Y2hhbm5lbD4gWy0tc2luY2UgPGlkPl0gWy0tc3RhdHVzIDx2YWx1ZT5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG5cbiAgaWYgKG9wdHMuc3RhdHVzICE9PSB1bmRlZmluZWQpIHtcbiAgICAvLyBUaGlzIGJyYW5jaCBhbnN3ZXJzIGZyb20gdGhlIGxvZyBmaWxlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24uXG4gICAgYXdhaXQgcmVxdWlyZUNoYW5uZWwocG9ydCwgbmFtZSk7XG4gICAgLy8gRnVsbC1jaGFubmVsIHNjYW46IGZpbHRlciBieSBsYXRlc3QgZGlzcG9zaXRpb24sIHN0YXR1cyBmcmFtZXMgZXhjbHVkZWQuXG4gICAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgICBjb25zdCBmaWx0ZXJlZCA9IGJhZGdlZC5maWx0ZXIoKG0pID0+IHtcbiAgICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgICAvLyBgLS1zdGF0dXMgb3BlbmAgbWlycm9ycyB0cmlhZ2UncyBvcGVuIGJ1Y2tldDogc2lnbmFsLW9ubHksIHNvIG5vbi1tZXNzYWdlXG4gICAgICAvLyBGWUlzICh0b3BpYy9hbm5vdW5jZW1lbnQpIGFyZSBleGNsdWRlZCBmcm9tIHRoZSBhY3Rpb25hYmxlIHF1ZXVlLlxuICAgICAgcmV0dXJuIG9wdHMuc3RhdHVzID09PSBcIm9wZW5cIlxuICAgICAgICA/IG0ua2luZCA9PT0gXCJtZXNzYWdlXCIgJiYgaXNPcGVuKGRpc3BBcmcpXG4gICAgICAgIDogbS5kaXNwb3NpdGlvbiA9PT0gb3B0cy5zdGF0dXM7XG4gICAgfSk7XG4gICAgY29uc3QgbGFzdElkID0gZmlsdGVyZWQuYXQoLTEpPy5pZCA/PyAwO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogZmlsdGVyZWQsIGN1cnNvcjogbGFzdElkIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpbmNlLXdpbmRvdyBwYXRoICh1bmNoYW5nZWQgZnJvbSBUYXNrIDIpLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtzaW5jZX1gLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIGNvbnN0IHJhd01zZ3MgPSBkYXRhPy5tZXNzYWdlcyA/PyBbXTtcbiAgY29uc3QgY3Vyc29yID0gcmF3TXNncy5hdCgtMSk/LmlkID8/IHNpbmNlO1xuICBjb25zdCBkaXNwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgYW5ub3RhdGVkID0gcmF3TXNnc1xuICAgIC8vIERpc3Bvc2l0aW9uIGZyYW1lcyBvbmx5IOKAlCBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHN0YXlzIGluXG4gICAgLy8gdGhlIGhpc3RvcnkgYW4gYWdlbnQgcHVsbHM7IGl0IGlzIGhvdyBpdCBsZWFybnMgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQuXG4gICAgLmZpbHRlcigobSkgPT4gIWlzRGlzcG9zaXRpb25GcmFtZShtKSlcbiAgICAubWFwKChtKSA9PiB7XG4gICAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgICByZXR1cm4gZCA/IHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbTtcbiAgICB9KTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBhbm5vdGF0ZWQsIGN1cnNvciB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhZChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIGlkOiBudW1iZXIsIG9wdHM6IHsgdGV4dD86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVhZCA8Y2hhbm5lbD4gPGlkPiBbLS10ZXh0XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBCdWlsdCBvbiB0aGUgZXhpc3RpbmcgcmFuZ2UgZmV0Y2gg4oCUIGBzaW5jZT1pZC0xYCByZXR1cm5zIGlkIGFuZCBiZXlvbmQ7XG4gIC8vIHdlIHBpY2sgdGhlIGV4YWN0IGlkLiBObyBkYWVtb24gQVBJIGNoYW5nZS4gVGhpcyBpcyB0aGUgdGFyZ2V0ZWRcbiAgLy8gXCJnaXZlIG1lIG1lc3NhZ2UgTiBpbiBmdWxsXCIgdmVyYiB0aGF0IHJlY292ZXJzIGEgY2xpcHBlZCB0YWlsIHByZXZpZXdcbiAgLy8gd2l0aG91dCB0aGUgcHVsbC1yYW5nZSArIGpxIGRhbmNlLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtpZCAtIDF9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBjb25zdCBtc2cgPSAoZGF0YT8ubWVzc2FnZXMgPz8gW10pLmZpbmQoKG0pID0+IG0uaWQgPT09IGlkKTtcbiAgaWYgKCFtc2cpIGRpZShgbWVzc2FnZSAke2lkfSBub3QgZm91bmQgaW4gJHtuYW1lfWAsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCBkaXNwTWFwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgZCA9IGRpc3BNYXAuZ2V0KGlkKTtcbiAgY29uc3QgYW5ub3RhdGVkTXNnID0gZCA/IHsgLi4ubXNnLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0gOiBtc2c7XG4gIGlmIChvcHRzLnRleHQpIHtcbiAgICAvLyBQcm9zZSBtb2RlOiBoZWFkZXIgKyBib2R5LCBubyBKU09OIGVudmVsb3BlLCBzbyBhIGh1bWFuIChvciBhbiBhZ2VudFxuICAgIC8vIHJlY292ZXJpbmcgYSB0cnVuY2F0ZWQgbm90aWZpY2F0aW9uKSBjYW4gcmVhZCBpdCBkaXJlY3RseS5cbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG1zZy50cykudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCBkaXNwUHJlZml4ID0gZFxuICAgICAgPyBkLnJlb3BlbnMgPiAwXG4gICAgICAgID8gYFske2QuZGlzcG9zaXRpb259IOKGuyR7ZC5yZW9wZW5zfV0gYFxuICAgICAgICA6IGBbJHtkLmRpc3Bvc2l0aW9ufV0gYFxuICAgICAgOiBcIlwiO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2Rpc3BQcmVmaXh9WyR7bXNnLmlkfV0gJHttc2cuZnJvbX0gwrcgJHt0c31cXG4ke21zZy50ZXh0fVxcbmApO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZTogYW5ub3RhdGVkTXNnIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXYWl0KFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHNpbmNlOiBudW1iZXIsXG4gIHRpbWVvdXRTOiBudW1iZXIsXG4gIGFsaWFzOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdhaXQgPGNoYW5uZWw+IFstLWFzIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBHaXZlIHRoZSBIVFRQIGZldGNoIGEgc2xpZ2h0bHkgaGlnaGVyIGFib3J0IHRpbWVvdXQgdGhhbiB0aGUgZGFlbW9uJ3NcbiAgLy8gbG9uZy1wb2xsIHRpbWVvdXQgc28gdGhlIGRhZW1vbiBhbHdheXMgd2lucyB0aGUgdGltZW91dCByYWNlLlxuICAvLyBgP2FzPTxhbGlhcz5gIHJlZ2lzdGVycyBwcmVzZW5jZSBvbiB0aGUgY2hhbm5lbCBmb3IgdGhlIHdhaXQgZHVyYXRpb24g4oCUXG4gIC8vIHdhaXQgaXMgbG9uZy1wb2xsIChwdXNoLXNoYXBlZCB3aXRoIGEgZGVhZGxpbmUpIHNvIGl0IGRlc2VydmVzIHByZXNlbmNlLlxuICBjb25zdCBhc1BhcmFtID0gYWxpYXMgPyBgJmFzPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGFsaWFzKX1gIDogXCJcIjtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFubmVscy8ke25hbWV9L3dhaXQ/c2luY2U9JHtzaW5jZX0mdGltZW91dD0ke3RpbWVvdXRTfSR7YXNQYXJhbX1gO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcbiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoKHRpbWVvdXRTICsgNSkgKiAxMDAwKSxcbiAgfSk7XG4gIGxldCBkYXRhOiBXYWl0UmVzcG9uc2UgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFdhaXRSZXNwb25zZTtcbiAgfSBjYXRjaCB7fVxuICBpZiAoIXJlcy5vaykgZGllQXBpKGRhdGEsIHJlcy5zdGF0dXMpO1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIG1lc3NhZ2VzOiBkYXRhPy5tZXNzYWdlcyA/PyBbXSxcbiAgICBjdXJzb3I6IGRhdGE/LmN1cnNvciA/PyBzaW5jZSxcbiAgICB0aW1lZF9vdXQ6ICEhZGF0YT8udGltZWRfb3V0LFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2hvIDxjaGFubmVsPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsOiBuYW1lLCBzdWJzY3JpYmVyczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3Vic2NyaWJlcnNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9zdWJzY3JpYmVyc2AsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdob0FsbCgpIHtcbiAgLy8gQ3Jvc3MtY2hhbm5lbCByb3N0ZXIg4oCUIG5hbWVzIMOXIGNoYW5uZWwgaW4gb25lIGNhbGwsIHNvIHlvdSBkb24ndCBmYW4gb3V0XG4gIC8vIE4gYHdob2AgY2FsbHMgKyBhIG1hbnVhbCBqb2luIHRvIGFuc3dlciBcIndobyBpcyBvbiB3aGljaCB2aW5lP1wiLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWxzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gR2V0IG9yIHNldCB0aGUgcGVyc2lzdGVkIGRlZmF1bHQgYWxpYXMgKFYxLjcpLiBXaXRoIG5vIGFyZ3VtZW50LCBwcmludHMgdGhlXG4vLyBjdXJyZW50IGFsaWFzOyB3aXRoIG9uZSwgd3JpdGVzIGl0IHRvIGNvbmZpZy5qc29uLiBQdXJlIGZpbGUgSS9PIOKAlCB3b3Jrc1xuLy8gd2l0aG91dCBhIHJ1bm5pbmcgZGFlbW9uLiBUaGUgd2F0Y2ggc3VyZmFjZSByZWFkcyBpdCB2aWEgR0VUIC9pZGVudGl0eSBzbyB0aGVcbi8vIGh1bWFuIGhhcyBhIGNvbnNpc3RlbnQgbmFtZSBhY3Jvc3MgZXZlcnkgZ3JhcGV2aW5lLlxuYXN5bmMgZnVuY3Rpb24gY21kQWxpYXMobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGxldCBjZmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHRyeSB7XG4gICAgY2ZnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoQ09ORklHX0ZJTEUsIFwidXRmLThcIikpO1xuICB9IGNhdGNoIHt9XG4gIGlmIChuYW1lID09PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBhbGlhcyA9IHR5cGVvZiBjZmcuYWxpYXMgPT09IFwic3RyaW5nXCIgJiYgY2ZnLmFsaWFzLnRyaW0oKSA/IGNmZy5hbGlhcy50cmltKCkgOiBudWxsO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhcyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgdHJpbW1lZCA9IG5hbWUudHJpbSgpO1xuICBjZmcuYWxpYXMgPSB0cmltbWVkO1xuICBta2RpclN5bmMoREFUQV9ESVIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKENPTkZJR19GSUxFLCBgJHtKU09OLnN0cmluZ2lmeShjZmcsIG51bGwsIDIpfVxcbmApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgYWxpYXM6IHRyaW1tZWQgfHwgbnVsbCB9KTtcbn1cblxuLyoqXG4gKiBUaGUgc3RhbmRpbmcgdGFpbCDigJQgYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCwgYWRvcHRlZCBhdCBQaGFzZSA2IGNoYXB0ZXIgMi5cbiAqXG4gKiDim5QgV0hBVCBUSElTIFJFUExBQ0VELCBBTkQgV0hBVCBJVCBCT1VHSFQuIFRoaXMgdmVyYiB3YXMgMjIwIGxpbmVzIG9mXG4gKiBoYW5kLXdyaXR0ZW4gcmVjb25uZWN0IGxvb3A6IHRocmVlIG5lc3RlZCBsb29wcyAocmVjb25uZWN0IC8gcmVhZCAvIGZyYW1lXG4gKiBkcmFpbiksIGl0cyBvd24gU1NFIHNwbGl0dGVyLCBpdHMgb3duIGJhY2tvZmYsIGFuZCBhIGBwcm9jZXNzLmV4aXQoMClgIGluIGFcbiAqIHNpZ25hbCBoYW5kbGVyIHNldmVuIGxpbmVzIGluLiBUaGUgc2hhcmVkIGNsaWVudCBpcyB0aGUgc2FtZSBkZXNpZ24sIG9uY2UsIGFuZFxuICogdGhyZWUgdGhpbmdzIGFycml2ZSB3aXRoIGl0IHRoYXQgZ3JhcGV2aW5lIGRpZCBub3QgaGF2ZTpcbiAqXG4gKiAgIDEuICoqQU4gSURMRSBXQVRDSERPRyDigJQgZ3JhcGV2aW5lIGhhZCBOT05FLioqIGBhd2FpdCByZWFkZXIucmVhZCgpYCB3YXNcbiAqICAgICAgdW5ib3VuZGVkLCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYVxuICogICAgICBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSLCBhbmQgYSBwYXJrZWQgdGFpbCBpc1xuICogICAgICBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgcXVpZXQgY2hhbm5lbC4gYFRBSUxfSURMRV9NU2AgaXMgdGhyZWUgb2YgVEhJU1xuICogICAgICBzcGVsbCdzIDMgcyBiZWF0cyAoYC4vaGVhcnRiZWF0LnRzYCksIG5ldmVyIGEgY29waWVkIDQ1LDAwMC5cbiAqICAgMi4gKipBIFNQRUMtQ09SUkVDVCBGUkFNRSBQQVJTRVIuKiogVGhlIGhhbmQtd3JpdHRlbiBvbmUgZGlkXG4gKiAgICAgIGBsaW5lLnNsaWNlKDUpLnRyaW0oKWAsIHdoaWNoIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiB0aGUgb25lXG4gKiAgICAgIGxlYWRpbmcgc3BhY2UgdGhlIHNwZWMgcmVtb3ZlcyDigJQgaXQgd291bGQgY29ycnVwdCBhIG1lc3NhZ2UgYm9keSB3aG9zZVxuICogICAgICBmaXJzdCBsaW5lIGlzIGluZGVudGVkLiBOb3RoaW5nIGluIHRoZSByb3N0ZXIgZW1pdHMgb25lIHRvZGF5OyB0aGUgcGFyc2VcbiAqICAgICAgaXMgcmlnaHQgYW55d2F5IG5vdy5cbiAqICAgMy4gKipBIFNJR05BTCBQQVRIIFRIQVQgRFJBSU5TLioqIFRoZSBvbGQgaGFuZGxlciB3YXNcbiAqICAgICAgYHN0b3BwZWQgPSB0cnVlOyBwcm9jZXNzLmV4aXQoMClgIOKAlCB0aGUgUDBmIGRlZmVjdCBleGFjdGx5LCBhcHBsaWVkIHRvXG4gKiAgICAgIHRoZSB0ZXJtaW5hbCBmcmFtZSBpbiBmaXZlIHNwZWxscyBhbmQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmVcbiAqICAgICAgbGluZXMgYWJvdmUgaXQuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkXG4gKiAgICAgIHN0ZG91dC4gVGhlIGNsaWVudCBSRVRVUk5TIGFuIGV4aXQgY29kZTsgYG1haW5gIGFzc2lnbnMgaXQgYW5kIHJldHVybnNcbiAqICAgICAgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zLlxuICpcbiAqIOKblCBOTyBgZXBvY2hPZmAgLyBgb25FcG9jaENoYW5nZWAsIEFORCBUSEFUIElTIEEgUlVMSU5HLCBOT1QgQU4gT01JU1NJT05cbiAqIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0IOKAlCBgbG9hZENoYW5uZWwoKWBcbiAqIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgaGlnaC13YXRlciBtYXJrIG92ZXIgdGhlIGR1cmFibGUgYC5qc29ubGAg4oCUIHNvIGFcbiAqIHJlY29ubmVjdGluZyBjdXJzb3IgaXMgc3RpbGwgdmFsaWQgYW5kIHRoZSBjb25kaXRpb24gYW4gZXBvY2ggZGV0ZWN0cyBjYW5ub3RcbiAqIG9jY3VyIGhlcmUuIFdpcmluZyBvbmUgd291bGQgYmUgYSBSRUdSRVNTSU9OIHdpdGggYSBtZWFzdXJlZCBtZWNoYW5pc206XG4gKiBgb25FcG9jaENoYW5nZWAgc2V0cyBgY3Vyc29yID0gMGAsIGFuZCB0aGlzIGRhZW1vbiBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoXG4gKiBgcmVhZEJhY2tsb2cobmFtZSwgMClgIOKAlCB0aGUgd2hvbGUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW4gYWdlbnQncyBwaXBlLFxuICogb24gZXZlcnkgYGdyYXBldmluZSByb2xsYC5cbiAqXG4gKiDimqAgYHJlc29sdmVgIENBTExTIGBlbnN1cmVEYWVtb25gLCBXSElDSCBDQU4gUkFJU0Ug4oCUIGRlbGliZXJhdGVseSwgYW5kIHRoZSBraXRcbiAqIGRvY3VtZW50cyB0aGUgcHJvcGVydHkgdGhpcyBkZXBlbmRzIG9uOiBpdHMgb3V0ZXIgYmxvY2sgaXMgYSBgdHJ5YC9gZmluYWxseWBcbiAqIHdpdGggTk8gYGNhdGNoYCwgc28gYSBgQ2xpRXJyb3JgIGZyb20gdGhyZWUgZnJhbWVzIGRvd24gcHJvcGFnYXRlcyBpbnRvXG4gKiBgbWFpbmAgaW5zdGVhZCBvZiBiZWluZyByZWFkIGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZCByZXRyaWVkIGZvcmV2ZXIuXG4gKiBDaGVja2VkIGF0IHRoZSBhZG9wdGlvbiByYXRoZXIgdGhhbiBhc3N1bWVkIChwbGF5Ym9vayBCOSBzdGVwIDUpLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG9wdHM6IHtcbiAgICBzaW5jZT86IG51bWJlcjtcbiAgICBmcm9tU3RhcnQ/OiBib29sZWFuO1xuICAgIGxhc3Q/OiBudW1iZXI7XG4gICAgYXM/OiBzdHJpbmc7XG4gICAgaHVtYW4/OiBib29sZWFuO1xuICAgIGx1cms/OiBib29sZWFuO1xuICAgIG1heD86IG51bWJlcjtcbiAgfSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghbmFtZSlcbiAgICBkaWUoXG4gICAgICBcInVzYWdlOiBncmFwZXZpbmUgdGFpbCA8bmFtZT4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVwiLFxuICAgICk7XG4gIC8vIC0tbHVyayByZWNlaXZlcyBtZXNzYWdlcyBidXQgcmVnaXN0ZXJzIG5vIHByZXNlbmNlIOKAlCBhbiBpbnZpc2libGUgb2JzZXJ2ZXIuXG4gIC8vIEl0IG92ZXJyaWRlcyBpZGVudGl0eSBmbGFncyAoYSBsdXJrZXIgaGFzIG5vIG5hbWUgdG8gc2hvdykuXG4gIGNvbnN0IG15QWxpYXMgPSBvcHRzLmx1cmsgPyB1bmRlZmluZWQgOiBvcHRzLmFzO1xuICBjb25zdCBzaW5jZSA9IG9wdHMuZnJvbVN0YXJ0ID8gMCA6IChvcHRzLnNpbmNlID8/IC0xKTtcbiAgLy8gRW1pdCB0aGUgZ3JvdW5kaW5nIGxpbmUgb25seSBvbiB0aGUgZmlyc3Qgc3Vic2NyaWJlLCBuZXZlciBvbiByZWNvbm5lY3RzXG4gIC8vIChhIHJlY29ubmVjdCByZXN1bWVzIGZyb20gdGhlIGN1cnNvciDigJQgdGhlcmUgaXMgbm8gdW5zZWVuIGhpc3RvcnkgdGhlbikuXG4gIC8vIOKblCBBTkQgTkVWRVIgT04gQSBgLS1zaW5jZWAgUkUtQVJNIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBBMyk6IHRoZVxuICAvLyBhZ2VudCBhbHJlYWR5IGtub3dzIHRoZSBjaGFubmVsLCBhbmQgdGhlIGhpc3RvcnkgaGludCB3b3VsZCBiZSBub2lzZS5cbiAgbGV0IGdyb3VuZGVkID0gb3B0cy5zaW5jZSAhPT0gdW5kZWZpbmVkO1xuICAvLyDim5QgVEhFIEJPT0tNQVJLIEZPUiBBIExJVkUtT05MWSBUQUlMLiBgc2luY2UgPSAtMWAgYXNrcyBmb3Igbm8gaGlzdG9yeSwgc28gYVxuICAvLyB0YWlsIHRoYXQgc2VlcyBubyBtZXNzYWdlIGhhcyBubyBpZCB0byBoYW5kIGl0cyByZS1hcm0sIGFuZCB0aGUgcmUtYXJtXG4gIC8vIHdvdWxkIG1pc3MgZXZlcnl0aGluZyBzZW50IGluIHRoZSBnYXAuIFRoZSBgc3Vic2NyaWJlZGAgbWFya2VyIGNhcnJpZXMgdGhlXG4gIC8vIGNoYW5uZWwncyBgbGF0ZXN0X2lkYDogc2VlZGluZyB0aGUgY3Vyc29yIGZyb20gaXQgbWFrZXMgdGhlIGhhbmRvZmYnc1xuICAvLyBgLS1zaW5jZWAgZXhhY3QuIE9ubHkgZm9yIGEgbGl2ZS1vbmx5IHN0YXJ0IOKAlCBhIGJhY2tmaWxsaW5nIG9uZSAoYC0tbGFzdGAsXG4gIC8vIGAtLWZyb20tc3RhcnRgLCBgLS1zaW5jZWApIGlzIHN0aWxsIHJlYWRpbmcgaWRzIGF0IG9yIGJlbG93IGl0LCBhbmQgYVxuICAvLyByZWNvbm5lY3QgbWlkLWJhY2tmaWxsIG11c3Qgbm90IHNraXAgcGFzdCB0aGVtLlxuICAvLyBPbmNlOiBhIGxhdGVyIG1hcmtlciAoYSByZWNvbm5lY3QpIG11c3Qgbm90IGp1bXAgdGhlIGN1cnNvciBwYXN0IG1lc3NhZ2VzXG4gIC8vIGl0cyBvd24gYmFja2xvZyBpcyBhYm91dCB0byByZXBsYXkuXG4gIGxldCBzZWVkRnJvbU1hcmtlciA9IHNpbmNlIDwgMCAmJiBvcHRzLmxhc3QgPT09IHVuZGVmaW5lZDtcblxuICAvLyDim5QgQSBQUkVTRU5DRSBTUEVMTDogdGhlIGNvbm5lY3Rpb24gSVMgYHdob2AncyBwcmVzZW5jZSwgc28gdGhlIHdpbmRvd1xuICAvLyBhbHdheXMgbmFtZXMgdGhlIE1vbml0b3IgcmUtYXJtLCBuZXZlciB0aGUgc3RvcC1zdGFydCBgLS1vbmNlYCwgYW5kIGEgbG9zdFxuICAvLyBkYWVtb24gaXMgcmV0cmllZCAoYHJlc29sdmVgIHJlc3Bhd25zIGl0KSwgbm90IHJlcG9ydGVkLlxuICBjb25zdCBhZ2FpbiA9IChhdDogbnVtYmVyKSA9PlxuICAgIGNvbW1hbmRMaW5lKFtcbiAgICAgIFwidGFpbFwiLFxuICAgICAgbmFtZSxcbiAgICAgIC4uLihvcHRzLmx1cmsgPyBbXCItLWx1cmtcIl0gOiBteUFsaWFzID8gW1wiLS1hc1wiLCBteUFsaWFzXSA6IFtdKSxcbiAgICAgIC4uLihvcHRzLmh1bWFuICYmICFvcHRzLmx1cmsgPyBbXCItLWh1bWFuXCJdIDogW10pLFxuICAgICAgLi4uKG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBbXCItLW1heFwiLCBTdHJpbmcob3B0cy5tYXgpXSA6IFtdKSxcbiAgICAgIC8vIGAtLXNpbmNlYCB0YWtlcyBubyBuZWdhdGl2ZSBoZXJlOyBhIHRhaWwgdGhhdCBuZXZlciBsZWFybmVkIGFuIGlkXG4gICAgICAvLyByZS1hcm1zIGxpdmUtb25seSwgd2hpY2ggaXMgd2hhdCAtMSBtZWFudC5cbiAgICAgIC4uLihhdCA+PSAwID8gW1wiLS1zaW5jZVwiLCBTdHJpbmcoYXQpXSA6IFtdKSxcbiAgICBdKTtcblxuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPFRhaWxQYXlsb2FkPihcbiAgICB7XG4gICAgICAvLyDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVELiBBIHRhaWwgb3V0bGl2ZXNcbiAgICAgIC8vIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0IOKAlCBgcm9sbGAgYW5kIGByZXN0YXJ0YCBib3RoIHJlcGxhY2UgaXQg4oCUIGFuZFxuICAgICAgLy8gYGVuc3VyZURhZW1vbmAgcmUtcmVhZHMgdGhlIHBvcnQgZmlsZSBhbmQgcmVzcGF3bnMsIHNvIGEgcmVjb25uZWN0IGFmdGVyIGFcbiAgICAgIC8vIHJvbGwgbGFuZHMgb24gdGhlIE5FVyBkYWVtb24gcmF0aGVyIHRoYW4gc3Bpbm5pbmcgYWdhaW5zdCBhIGRlYWQgcG9ydC5cbiAgICAgIHJlc29sdmU6IGFzeW5jICgpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7YXdhaXQgZW5zdXJlRGFlbW9uKCl9YCxcbiAgICAgIHBhdGg6IGAvY2hhbm5lbHMvJHtuYW1lfS90YWlsYCxcbiAgICAgIHNpbmNlLFxuICAgICAgLy8g4pqgIE5PIGVuc3VyZSBjYWxsIGJlZm9yZSB0aGUgc3Vic2NyaWJlLiBBIGZyZXNoIGB0YWlsIG5hbWVgIHN0aWxsIHdvcmtzXG4gICAgICAvLyB3aXRob3V0IGFuIGV4cGxpY2l0IG9wZW4g4oCUIEdFVCDigKYvdGFpbCBjcmVhdGVzIHRoZSBjaGFubmVsIGl0c2VsZiDigJQgYW5kXG4gICAgICAvLyB0aGF0IGlzIHRoZSBPTkxZIHdheSB0aGUgc3Vic2NyaWJlZCBldmVudCdzIGBjcmVhdGVkYCBmbGFnIGNhbiBldmVyIGJlXG4gICAgICAvLyB0cnVlOiBhbiBlbnN1cmUgc2VudCBmaXJzdCBjcmVhdGVzIHRoZSBjaGFubmVsLCBzbyB0aGUgc3Vic2NyaWJlIHRoYXRcbiAgICAgIC8vIGZvbGxvd3MgYWx3YXlzIHJlcG9ydHMgYGNyZWF0ZWQ6ZmFsc2VgIGFuZCB0aGUgbWlzdHlwZWQtbmFtZSBzaWduYWwgbmV2ZXJcbiAgICAgIC8vIGZpcmVzLlxuICAgICAgcXVlcnk6IChjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPT4ge1xuICAgICAgICBjb25zdCBxOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgICAgLy8gIzY4IOKAlCBgLS1sYXN0IE5gIHJpZGVzIHRoZSBGSVJTVCBjb25uZWN0aW9uIG9ubHkuIE9uY2UgYW55IG1lc3NhZ2VcbiAgICAgICAgLy8gbGFuZHMgdGhlIGN1cnNvciBhZHZhbmNlcyBhbmQgYSByZWNvbm5lY3QgcmVzdW1lcyBmcm9tIGl0IHZpYSBgc2luY2VgLFxuICAgICAgICAvLyBuZXZlciByZS1iYWNrZmlsbGluZyB0aGUgd2luZG93LiBgZmlyc3RDb25uZWN0YCBpcyB0aGUga2l0J3MgcGFyYW1ldGVyXG4gICAgICAgIC8vIGZvciBleGFjdGx5IHRoaXM7IHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCBzcGVsbGVkIGl0IGBoaWdoZXN0U2VlbiA8IDBgLFxuICAgICAgICAvLyB3aGljaCB3YXMgdGhlIHNhbWUgdGVzdCBieSBhY2NpZGVudCBvZiB0aGUgc2VudGluZWwuXG4gICAgICAgIGlmIChvcHRzLmxhc3QgIT09IHVuZGVmaW5lZCAmJiBmaXJzdENvbm5lY3QpIHEubGFzdCA9IFN0cmluZyhvcHRzLmxhc3QpO1xuICAgICAgICBpZiAobXlBbGlhcykgcS5hcyA9IG15QWxpYXM7XG4gICAgICAgIGlmIChvcHRzLmh1bWFuICYmICFvcHRzLmx1cmspIHEuaHVtYW4gPSBcIjFcIjtcbiAgICAgICAgaWYgKG9wdHMubHVyaykgcS5sdXJrID0gXCIxXCI7XG4gICAgICAgIHJldHVybiBxO1xuICAgICAgfSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIikgcmV0dXJuIGV2LmlkO1xuICAgICAgICBpZiAoc2VlZEZyb21NYXJrZXIgJiYgdHlwZW9mIGV2LmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgIHNlZWRGcm9tTWFya2VyID0gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIGV2LmxhdGVzdF9pZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfSxcbiAgICAgIGFjY2VwdDogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICAvLyBUaGUgc3Vic2NyaWJlZCBtYXJrZXIgaXMgbm90IGEgbWVzc2FnZTsgYHJlbmRlcmAgYW5zd2VycyBpdC5cbiAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHRydWU7XG4gICAgICAgIC8vIERyb3AgRElTUE9TSVRJT04gZnJhbWVzIOKAlCB0aGV5IGFyZSBtZXRhZGF0YSBhYm91dCBhbm90aGVyIG1lc3NhZ2UuIEFcbiAgICAgICAgLy8gbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgcGFzc2VzIHRocm91Z2g6IGFuIGFnZW50IHRhaWxpbmcgYVxuICAgICAgICAvLyBjaGFubmVsIGNvdWxkIG5vdCBwcmV2aW91c2x5IHNlZSBlaXRoZXIgcGFydHkgcmV0aXJlIGl0LCBhbmQgZm91bmQgb3V0XG4gICAgICAgIC8vIHdoZW4gaXRzIG5leHQgc2VuZCB3YXMgcmVqZWN0ZWQuXG4gICAgICAgIGlmIChpc0Rpc3Bvc2l0aW9uRnJhbWUoZXYpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIC8vIFN1cHByZXNzIHNlbGYtZWNobzogd2hlbiAtLWFzIGlzIHNldCwgZHJvcCBtZXNzYWdlcyB3ZSBzZW50IG91cnNlbHZlcy5cbiAgICAgICAgLy8gVGhlIHNlbmRlciBhbHJlYWR5IGdvdCB0aGUgcmVjZWlwdCBhcyB0aGUgUE9TVCByZXNwb25zZSwgc28gcmUtZW1pdHRpbmdcbiAgICAgICAgLy8gaXQgb24gdGFpbCBpcyBwdXJlIG5vaXNlLlxuICAgICAgICBpZiAobXlBbGlhcyAmJiBldi5mcm9tID09PSBteUFsaWFzKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKHBheWxvYWQsIGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiByZW5kZXJTdWJzY3JpYmVkKHBheWxvYWQpO1xuICAgICAgICAvLyAjNjcg4oCUIGZyb250LWxvYWQgYSByZWNvdmVyeSBwb2ludGVyIG9uIEVWRVJZIG1lc3NhZ2UgZnJhbWUsIHNvIHRoZSByZWFkXG4gICAgICAgIC8vIGNvb3JkaW5hdGVzIHN1cnZpdmUgYSBkb3duc3RyZWFtIG5vdGlmaWNhdGlvbiBjbGlwLiBNb25pdG9yIHRydW5jYXRlcyBhdFxuICAgICAgICAvLyBpdHMgT1dOIGNhcCAoYmVsb3cgb3VyIGhpbnQgdGhyZXNob2xkLCBhbmQgb25lIHdlIGNhbm5vdCBvYnNlcnZlIGhlcmUpOyBhXG4gICAgICAgIC8vIG1lc3NhZ2UgaXQgY2xpcHMgd291bGQgb3RoZXJ3aXNlIGxvc2UgaXRzIHRyYWlsaW5nIGBpZGAgYW5kIGJlY29tZVxuICAgICAgICAvLyB1bnJlY292ZXJhYmxlIOKAlCB0aGUgcmVhZGVyIGlzIGxlZnQgaW5mZXJyaW5nIHRoZSBpZC4gRXZlcnkgZnJhbWVcbiAgICAgICAgLy8gdGhlcmVmb3JlIGNhcnJpZXMgYSBGUk9OVC1sb2FkZWQgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLCBlaXRoZXIgYXMgdGhlXG4gICAgICAgIC8vIHJpY2hlciBgdHJ1bmNhdGlvbl9oaW50YCAoZ2VudWluZWx5LWxvbmcgbWVzc2FnZXMg4oCUIHRoZSBcIitOIGNoYXJzLFxuICAgICAgICAvLyB5b3UncmUgZGVmaW5pdGVseSBtaXNzaW5nIGNvbnRlbnRcIiBhbGFybSkgb3IgYXMgdGhlIGNvbXBhY3QgYGZ1bGxgXG4gICAgICAgIC8vIHBvaW50ZXIuIFNlcmlhbGl6aW5nIGl0IGJlZm9yZSB0aGUgbG9uZyBgLnRleHRgIGlzIHdoYXQgbWFrZXMgaXQgc3Vydml2ZVxuICAgICAgICAvLyB0aGUgY2xpcCAoRjE3KS5cbiAgICAgICAgY29uc3QgcmVhZFJlZiA9IGByZWFkICR7bmFtZX0gJHtwYXlsb2FkLmlkfWA7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgcGF5bG9hZC50ZXh0ID09PSBcInN0cmluZ1wiICYmXG4gICAgICAgICAgcGF5bG9hZC50ZXh0Lmxlbmd0aCA+IChvcHRzLm1heCA/PyBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEKVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB0cnVuY2F0aW9uX2hpbnQgPSBgKyR7cGF5bG9hZC50ZXh0Lmxlbmd0aH0gY2hhcnMg4oCUIGZ1bGw6ICR7cmVhZFJlZn1gO1xuICAgICAgICAgIC8vIENhcCB0aGUgSU5MSU5FIGJvZHkgd2hlbiAtLW1heCBpcyBzZXQgKHRoZSBmdWxsIG1lc3NhZ2Ugc3RheXMgb24gZGlza1xuICAgICAgICAgIC8vIOKGkiBgcmVhZGApOyB3aXRob3V0IC0tbWF4LCBlbWl0IHRoZSBmdWxsIHRleHQgKHRvZGF5J3MgZGVmYXVsdCkuXG4gICAgICAgICAgY29uc3QgdGV4dCA9IG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBwYXlsb2FkLnRleHQuc2xpY2UoMCwgb3B0cy5tYXgpIDogcGF5bG9hZC50ZXh0O1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHRydW5jYXRpb25faGludCwgLi4ucGF5bG9hZCwgdGV4dCB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBmdWxsOiByZWFkUmVmLCAuLi5wYXlsb2FkIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIERhZW1vbiBsaXZlbmVzcyBoZWFydGJlYXQgKGA6IGhiIDx0cz5gKS4gU3VyZmFjZSBhIHJlY29nbml6YWJsZSBzZW50aW5lbFxuICAgICAgLy8gb24gc3RkZXJyIHNvIGEgYDI+JjFgIGNvbnN1bWVyIGNhbiB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiAoRjYpLiBLZXB0XG4gICAgICAvLyBvZmYgc3Rkb3V0IOKAlCB0aGUgSlNPTkwgc3RyZWFtIHN0YXlzIHB1cmUuXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiAodGV4dC50cmltU3RhcnQoKS5zdGFydHNXaXRoKFwiaGJcIikgPyBcIjogZ3JhcGV2aW5lLWtlZXBhbGl2ZVwiIDogbnVsbCksXG4gICAgICBvbk1hbGZvcm1lZDogKF9mcmFtZSwgZSkgPT4gYCMgYmFkIHNzZSBkYXRhOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgLy8gVGhlIGZvdXIgbGluZXMgdGhlIGhhbmQtd3JpdHRlbiBsb29wIHdyb3RlLCBwcmVzZXJ2ZWQgdmVyYmF0aW0g4oCUIGEgdGFpbFxuICAgICAgLy8gdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBvbmUgdGhhdCBpcyB3b3JraW5nLlxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBzd2l0Y2ggKGluZm8uY2F1c2UpIHtcbiAgICAgICAgICBjYXNlIFwiY29ubmVjdC1mYWlsZWRcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBjb25uZWN0IGZhaWxlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZXRyeWluZ+KApmA7XG4gICAgICAgICAgY2FzZSBcImh0dHBcIjpcbiAgICAgICAgICBjYXNlIFwibm8tYm9keVwiOlxuICAgICAgICAgICAgcmV0dXJuIGAjIHRhaWwgSFRUUCAke2luZm8uc3RhdHVzfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZXJyb3JcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBzdHJlYW0gZHJvcHBlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZWNvbm5lY3RpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZW5kXCI6XG4gICAgICAgICAgICByZXR1cm4gXCIjIHN0cmVhbSBjbG9zZWQsIHJlY29ubmVjdGluZ+KAplwiO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJncmFwZXZpbmVcIixcbiAgICAgIG1vZGU6IFwid2F0Y2hcIixcbiAgICAgIHByZXNlbmNlOiB0cnVlLFxuICAgICAgLy8gRDQ6IGEgaHVtYW4gYXQgYSB0ZXJtaW5hbCAoYC0taHVtYW5gKSBpcyBub3QgYW4gYWdlbnQgdW5kZXJcbiAgICAgIC8vIE1vbml0b3IncyBjYXAsIHNvIHRoZWlyIHdhdGNoIG5ldmVyIGVuZHMgYnkgaXRzZWxmLlxuICAgICAgLi4uKG9wdHMuaHVtYW4gPyB7IHdpbmRvd01zOiAwIH0gOiB7fSksXG4gICAgICAvLyBUaGUgYHN1YnNjcmliZWRgIG1hcmtlciAoYW5kIHRoZSBncm91bmRpbmcgbGluZSBpdCByZW5kZXJzKSBpcyBub3QgYVxuICAgICAgLy8gbWVzc2FnZSBvbiB0aGUgY2hhbm5lbC5cbiAgICAgIGNvdW50czogKF9ldiwgZnJhbWUpID0+IGZyYW1lLmV2ZW50ICE9PSBcInN1YnNjcmliZWRcIixcbiAgICAgIGNvbW1hbmRzOiB7XG4gICAgICAgIHRhaWw6ICh7IHNpbmNlOiBhdCB9KSA9PiBhZ2FpbihhdCksXG4gICAgICAgIGNvbWVCYWNrOiAoKSA9PiBjb21tYW5kTGluZShbXCJkb2N0b3JcIl0pLFxuICAgICAgfSxcbiAgICB9LFxuICApO1xuXG4gIC8qKiBUaGUgYHN1YnNjcmliZWRgIG1hcmtlcjogc3RkZXJyIGNvbnRleHQsIHBsdXMgYSBzdHJ1Y3R1cmVkIGdyb3VuZGluZyBsaW5lXG4gICAqICBvbiBzdGRvdXQgdGhlIEZJUlNUIHRpbWUgb25seS4gKi9cbiAgZnVuY3Rpb24gcmVuZGVyU3Vic2NyaWJlZChwYXlsb2FkOiBUYWlsUGF5bG9hZCk6IHN0cmluZyB8IG51bGwge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHN1YnNjcmliZWQgdG8gJHtwYXlsb2FkLmNoYW5uZWx9IChzaW5jZT0ke3BheWxvYWQuc2luY2V9KVxcbmApO1xuICAgIGlmIChwYXlsb2FkLnRvcGljKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB0b3BpYzogJHtwYXlsb2FkLnRvcGljfVxcbmApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIHRoaXMgdGFpbCBicm91Z2h0IGl0IGludG8gYmVpbmcgKGNoZWNrIHRoZSBuYW1lKVxcbmAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjICR7cGF5bG9hZC5jaGFubmVsfSBpcyBhcmNoaXZlZCDigJQgcmVhZC1vbmx5OyBhIHNlbmQgd2lsbCBiZSByZWplY3RlZFxcbmAsXG4gICAgICApO1xuICAgIC8vIFN0cnVjdHVyZWQgZ3JvdW5kaW5nIG9uIHN0ZG91dCAoRjMvRjcpIOKAlCB1bmRlciB0aGUgZGVmYXVsdCBXaXJpbmctQlxuICAgIC8vIE1vbml0b3IsIHN0ZG91dCBzdXJmYWNlcyBhcyBub3RpZmljYXRpb25zLCBzbyBhIGZyZXNoIHN1YnNjcmliZXIgYWN0dWFsbHlcbiAgICAvLyBzZWVzIHRoZSB0b3BpYyArIHRoYXQgZWFybGllciBoaXN0b3J5IGV4aXN0cy4gR2F0ZWQ6IG9ubHkgd2hlbiB0aGVyZSdzXG4gICAgLy8gc29tZXRoaW5nIHRvIGdyb3VuZCAodW5zZWVuIGhpc3Rvcnkgb3IgYSB0b3BpYyksIGFuZCBvbmx5IG9uIHRoZSBmaXJzdFxuICAgIC8vIHN1YnNjcmliZSAobm90IHJlY29ubmVjdHMpLlxuICAgIGlmIChncm91bmRlZCkgcmV0dXJuIG51bGw7XG4gICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgIGNvbnN0IGxhdGVzdCA9IHR5cGVvZiBwYXlsb2FkLmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIiA/IHBheWxvYWQubGF0ZXN0X2lkIDogMDtcbiAgICBjb25zdCBlYXJsaWVyID0gc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5tYXgoMCwgTWF0aC5taW4oc2luY2UsIGxhdGVzdCkpO1xuICAgIC8vIGBjcmVhdGVkYCBhbmQgYGFyY2hpdmVkYCBqb2luIHRoZSBnYXRlIG9uIHB1cnBvc2UuIEEgY2hhbm5lbCB0aGlzXG4gICAgLy8gc3Vic2NyaWJlIGp1c3QgbWFkZSBoYXMgbm8gdG9waWMgYW5kIG5vIGhpc3RvcnksIHNvIHRoZSBvbGQgY29uZGl0aW9uXG4gICAgLy8gKGBlYXJsaWVyID4gMCB8fCB0b3BpY2ApIGlzIGV4YWN0bHkgdGhlIGNhc2UgdGhhdCBlbWl0cyBOT1RISU5HOyBhbmQgYW5cbiAgICAvLyBBUkNISVZFRCBjaGFubmVsJ3MgZ3JvdW5kaW5nIGxpbmUgd2FzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBoZWFsdGh5XG4gICAgLy8gb25lJ3MsIHNvIGEgbGF0ZSBqb2luZXIgc3RpbGwgbGVhcm5lZCB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZCBvbmx5IHdoZW5cbiAgICAvLyBpdHMgc2VuZCBib3VuY2VkLlxuICAgIC8vXG4gICAgLy8g4pqgIFRoZSBoaW50cyBBQ0NVTVVMQVRFIGludG8gYSBsaXN0IHJhdGhlciB0aGFuIGFzc2lnbmluZyB0byBvbmUgZmllbGQuXG4gICAgLy8gVGhleSB1c2VkIHRvIGJlIHRocmVlIGFzc2lnbm1lbnRzIHRvIGBncm91bmRpbmcuaGludGAsIG9yZGVyZWQgc28gdGhlIG1vc3RcbiAgICAvLyBpbXBvcnRhbnQgd29uIOKAlCB3aGljaCBpcyBhIGhpbnQgdGhhdCBjYW4gc2lsZW50bHkgbG9zZSB0byBhbm90aGVyIGhpbnQsXG4gICAgLy8gdGhlIGZhaWx1cmUgbW9kZSB0aGlzIHdob2xlIGJyYW5jaCBpcyBhYm91dCwgc2l0dGluZyBpbiB0aGUgZml4IGZvciBpdC4gQVxuICAgIC8vIGxpc3QgY2Fubm90IG92ZXJ3cml0ZTogYW4gYXJjaGl2ZWQgY2hhbm5lbCBXSVRIIGhpc3Rvcnkgbm93IHNheXMgYm90aC5cbiAgICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoZWFybGllciA+IDApXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtlYXJsaWVyfSBlYXJsaWVyIG1lc3NhZ2UocykgZXhpc3Qg4oCUIHVzZSAtLWZyb20tc3RhcnQgb3IgLS1zaW5jZSA8aWQ+IHRvIGJhY2tmaWxsYCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGB0aGlzIHRhaWwgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIG5vIHN1Y2ggY2hhbm5lbCBleGlzdGVkOyBjaGVjayB0aGUgbmFtZSwgb3IgYW5vdGhlciBwYXJ0eSBoYXMgeWV0IHRvIG9wZW4gaXRgLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWQgdW50aWwgc29tZW9uZSB1bmFyY2hpdmVzIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKCEoZWFybGllciA+IDAgfHwgcGF5bG9hZC50b3BpYyB8fCBwYXlsb2FkLmNyZWF0ZWQgfHwgcGF5bG9hZC5hcmNoaXZlZCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGdyb3VuZGluZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICBraW5kOiBcImdyb3VuZGluZ1wiLFxuICAgICAgY2hhbm5lbDogcGF5bG9hZC5jaGFubmVsLFxuICAgICAgam9pbmVkX2F0OiBzaW5jZSA8IDAgPyBsYXRlc3QgOiBNYXRoLm1pbihzaW5jZSwgbGF0ZXN0KSxcbiAgICAgIGVhcmxpZXIsXG4gICAgfTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgZ3JvdW5kaW5nLnRvcGljID0gcGF5bG9hZC50b3BpYztcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKSBncm91bmRpbmcuY3JlYXRlZCA9IHRydWU7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpIGdyb3VuZGluZy5hcmNoaXZlZCA9IHRydWU7XG4gICAgaWYgKGhpbnRzLmxlbmd0aCkgZ3JvdW5kaW5nLmhpbnQgPSBoaW50cy5qb2luKFwiIMK3IFwiKTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZ3JvdW5kaW5nKTtcbiAgfVxufVxuZnVuY3Rpb24gZm9sZERpc3Bvc2l0aW9ucyhuYW1lOiBzdHJpbmcpIHtcbiAgY29uc3QgbWFwID0gbmV3IE1hcDxcbiAgICBudW1iZXIsXG4gICAge1xuICAgICAgZGlzcG9zaXRpb246IHN0cmluZztcbiAgICAgIGZyb206IHN0cmluZztcbiAgICAgIHRzOiBudW1iZXI7XG4gICAgICBub3RlOiBzdHJpbmc7XG4gICAgICByZW9wZW5zOiBudW1iZXI7XG4gICAgfVxuICA+KCk7XG4gIGNvbnN0IHBhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIG1hcDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCAhPT0gXCJzdGF0dXNcIiB8fCB0eXBlb2YgbS50YXJnZXQgIT09IFwibnVtYmVyXCIgfHwgdHlwZW9mIG0uZGlzcG9zaXRpb24gIT09IFwic3RyaW5nXCIpXG4gICAgICBjb250aW51ZTtcbiAgICBjb25zdCBwcmV2ID0gbWFwLmdldChtLnRhcmdldCk7XG4gICAgY29uc3QgcmVvcGVucyA9XG4gICAgICAocHJldj8ucmVvcGVucyA/PyAwKSArXG4gICAgICAobS5kaXNwb3NpdGlvbiA9PT0gXCJvcGVuXCIgJiYgcHJldiAmJiBwcmV2LmRpc3Bvc2l0aW9uICE9PSBcIm9wZW5cIiA/IDEgOiAwKTtcbiAgICBtYXAuc2V0KG0udGFyZ2V0LCB7XG4gICAgICBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbixcbiAgICAgIGZyb206IG0uZnJvbSxcbiAgICAgIHRzOiBtLnRzLFxuICAgICAgbm90ZTogbS50ZXh0LFxuICAgICAgcmVvcGVucyxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gbWFwO1xufVxuLy8gVFdPIHRoaW5ncyBub3cgd2VhciBraW5kOlwic3RhdHVzXCIuIEEgRElTUE9TSVRJT04gZnJhbWUgYWN0cyBvbiBhIHNwZWNpZmljXG4vLyBtZXNzYWdlIChgdGFyZ2V0YCArIGBkaXNwb3NpdGlvbmApIGFuZCBpcyBtZXRhZGF0YSDigJQgYHB1bGxgIGFuZCBgdGFpbGAgZm9sZFxuLy8gaXQgYXdheSBhbmQgYmFkZ2UgdGhlIG1lc3NhZ2UgaXQgcG9pbnRzIGF0IGluc3RlYWQuIEEgTElGRUNZQ0xFIGZyYW1lXG4vLyAoYXJjaGl2ZSAvIHVuYXJjaGl2ZSkgaXMgYSBmYWN0IGFib3V0IHRoZSBDSEFOTkVMOiBpdCB0YXJnZXRzIG5vdGhpbmcsIGFuZCBpdFxuLy8gaXMgdGhlIHdob2xlIHBvaW50IHRoYXQgYSByZWFkZXIgc2VlcyBpdC4gRGlzY3JpbWluYXRpbmcgb24gYGRpc3Bvc2l0aW9uYFxuLy8gcmF0aGVyIHRoYW4gb24gYGV2ZW50YCBrZWVwcyBhIGZyYW1lIGZyb20gc29tZSBmdXR1cmUgZW1pdHRlciB2aXNpYmxlIGJ5XG4vLyBkZWZhdWx0IOKAlCB0aGUgZmFpbHVyZSBtb2RlIGhlcmUgaXMgc3dhbGxvd2luZyBhIHNpZ25hbCwgbm90IHNob3dpbmcgb25lLlxuZnVuY3Rpb24gaXNEaXNwb3NpdGlvbkZyYW1lKG06IHsga2luZD86IHN0cmluZzsgZGlzcG9zaXRpb24/OiBzdHJpbmcgfSk6IGJvb2xlYW4ge1xuICByZXR1cm4gbS5raW5kID09PSBcInN0YXR1c1wiICYmIHR5cGVvZiBtLmRpc3Bvc2l0aW9uID09PSBcInN0cmluZ1wiO1xufVxuXG4vLyBcIm9wZW5cIiA9IG5vIGVudHJ5LCBvciBsYXRlc3QgZGlzcG9zaXRpb24gaXMgXCJvcGVuXCJcbmZ1bmN0aW9uIGlzT3BlbihkPzogeyBkaXNwb3NpdGlvbjogc3RyaW5nIH0pIHtcbiAgcmV0dXJuICFkIHx8IGQuZGlzcG9zaXRpb24gPT09IFwib3BlblwiO1xufVxuXG4vLyBSZWFkcyB0aGUgZnVsbCBjaGFubmVsIGxvZywgZHJvcHMgRVZFUlkga2luZDpcInN0YXR1c1wiIGZyYW1lLCBhbmQgYmFkZ2VzIGVhY2hcbi8vIHJlbWFpbmluZyBtZXNzYWdlIHdpdGggaXRzIGxhdGVzdCBkaXNwb3NpdGlvbiB2aWEgZm9sZERpc3Bvc2l0aW9ucy5cbi8vXG4vLyBFdmVyeSBvbmUsIGRlbGliZXJhdGVseSDigJQgaW5jbHVkaW5nIGEgbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSksXG4vLyB3aGljaCBgcHVsbGAgYW5kIGB0YWlsYCBkbyBsZXQgdGhyb3VnaC4gVGhpcyBmZWVkcyBgdHJpYWdlYCwgd2hvc2Ugb3BlbiBxdWV1ZVxuLy8gaXMgXCJ3aGF0IGlzIGxlZnQgdG8gYWN0IG9uXCIsIGFuZCBhbiBhcmNoaXZlIGlzIGFuIEZZSSwgbm90IGEgd29yayBpdGVtLiBTYW1lXG4vLyByZWFzb24gYHRvcGljYCBhbmQgYGFubm91bmNlbWVudGAgYXJlIGZvbGRlZCBvdXQgb2YgdGhlIG9wZW4gYnVja2V0IGJlbG93LlxuZnVuY3Rpb24gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChcbiAgbmFtZTogc3RyaW5nLFxuKTogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10ge1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHJldHVybiBbXTtcbiAgY29uc3QgZGlzcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IG1lc3NhZ2VzOiAoTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfSlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIikuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgbTogTWVzc2FnZTtcbiAgICB0cnkge1xuICAgICAgbSA9IEpTT04ucGFyc2UobGluZSkgYXMgTWVzc2FnZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobS5raW5kID09PSBcInN0YXR1c1wiKSBjb250aW51ZTtcbiAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgaWYgKGQpIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2goeyAuLi5tLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWVzc2FnZXM7XG59XG5cbnR5cGUgQmFkZ2VkTWVzc2FnZSA9IE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH07XG5cbi8vIERhc2hib2FyZCByZW5kZXIgb2YgYSB0cmlhZ2Ugc2NhbjogdGhlIG9wZW4gcXVldWUgb24gdG9wLCB0aGVuIGVhY2hcbi8vIGRpc3Bvc2l0aW9uIGdyb3VwLCBvbmUgc2Nhbm5hYmxlIGxpbmUgcGVyIG1lc3NhZ2UuIE1pcnJvcnMgYHJlYWQgLS10ZXh0YFxuLy8gcHJvc2UgbW9kZSBzbyBhIGh1bWFuIChvciBhbiBhZ2VudCkgcmVhZHMgaXQgd2l0aG91dCBwYXJzaW5nIEpTT04uXG5mdW5jdGlvbiByZW5kZXJUcmlhZ2VIdW1hbihcbiAgbmFtZTogc3RyaW5nLFxuICBvcGVuOiBCYWRnZWRNZXNzYWdlW10sXG4gIGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmUgPSAobTogQmFkZ2VkTWVzc2FnZSkgPT4ge1xuICAgIGNvbnN0IHRzID0gbmV3IERhdGUobS50cykudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxNikucmVwbGFjZShcIlRcIiwgXCIgXCIpO1xuICAgIGNvbnN0IHJlb3BlbiA9IG0ucmVvcGVucyAmJiBtLnJlb3BlbnMgPiAwID8gYCDihrske20ucmVvcGVuc31gIDogXCJcIjtcbiAgICAvLyBUaGUgZmlyc3QgbGluZSwgd2l0aG91dCBhbiBpbmRleCByZWFkIGBzcGxpdGAgd291bGQgbWFrZSB0aGUgY29tcGlsZXJcbiAgICAvLyBkb3VidDogYHNwbGl0YCBuZXZlciByZXR1cm5zIGFuIGVtcHR5IGFycmF5LCBhbmQgdGhpcyBzYXlzIHRoZSBzYW1lIHRoaW5nLlxuICAgIGNvbnN0IG5sID0gbS50ZXh0LmluZGV4T2YoXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZCA9IG5sID09PSAtMSA/IG0udGV4dCA6IG0udGV4dC5zbGljZSgwLCBubCk7XG4gICAgY29uc3QgcHJldmlldyA9IGhlYWQubGVuZ3RoID4gMTAwID8gYCR7aGVhZC5zbGljZSgwLCA5OSl94oCmYCA6IGhlYWQ7XG4gICAgcmV0dXJuIGAgIFske20uaWR9JHtyZW9wZW59XSAke20uZnJvbX0gwrcgJHt0c30gwrcgJHtwcmV2aWV3fWA7XG4gIH07XG4gIGNvbnN0IHNlY3Rpb25zID0gW2Ake25hbWV9IMK3IHRyaWFnZVxcbmAsIGBPUEVOICgke29wZW4ubGVuZ3RofSlgXTtcbiAgc2VjdGlvbnMucHVzaChvcGVuLmxlbmd0aCA/IG9wZW4ubWFwKGxpbmUpLmpvaW4oXCJcXG5cIikgOiBcIiAg4oCUXCIpO1xuICBmb3IgKGNvbnN0IFtzdGF0dXMsIGl0ZW1zXSBvZiBPYmplY3QuZW50cmllcyhieV9zdGF0dXMpKSB7XG4gICAgc2VjdGlvbnMucHVzaChgXFxuJHtzdGF0dXMudG9VcHBlckNhc2UoKX0gKCR7aXRlbXMubGVuZ3RofSlgLCBpdGVtcy5tYXAobGluZSkuam9pbihcIlxcblwiKSk7XG4gIH1cbiAgcmV0dXJuIGAke3NlY3Rpb25zLmpvaW4oXCJcXG5cIil9XFxuYDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVHJpYWdlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgb3B0czogeyBodW1hbj86IGJvb2xlYW4gfSA9IHt9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB0cmlhZ2UgPGNoYW5uZWw+IFstLWh1bWFuXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyB0cmlhZ2UgcmVhZHMgdGhlIGxvZyBmaWxlLCBub3QgYSByb3V0ZSwgc28gaXQgY2Fubm90IDQwNCBvbiBpdHMgb3duIOKAlCBhbmRcbiAgLy8gYW4gZW1wdHkgZGFzaGJvYXJkIGZvciBhIGNoYW5uZWwgdGhhdCBkb2VzIG5vdCBleGlzdCBpcyB0aGUgc2FtZSBzaWxlbnQgbGllXG4gIC8vIGFzIGFuIGVtcHR5IGBwdWxsYC5cbiAgYXdhaXQgcmVxdWlyZUNoYW5uZWwocG9ydCwgbmFtZSk7XG4gIGNvbnN0IGJhZGdlZCA9IGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQobmFtZSk7XG4gIGNvbnN0IG9wZW46IEJhZGdlZE1lc3NhZ2VbXSA9IFtdO1xuICBjb25zdCBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4gPSB7fTtcbiAgZm9yIChjb25zdCBtIG9mIGJhZGdlZCkge1xuICAgIC8vIGlzT3BlbiBleHBlY3RzIGEgZGlzcG9zaXRpb24gZW50cnkgb2JqZWN0IChvciB1bmRlZmluZWQgZm9yIG5vIGVudHJ5KS5cbiAgICBjb25zdCBkaXNwQXJnID0gbS5kaXNwb3NpdGlvbiAhPT0gdW5kZWZpbmVkID8geyBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbiB9IDogdW5kZWZpbmVkO1xuICAgIGlmIChpc09wZW4oZGlzcEFyZykpIHtcbiAgICAgIC8vIFRoZSBvcGVuIHF1ZXVlIGlzIHNpZ25hbC1vbmx5OiBza2lwIG5vbi1hY3Rpb25hYmxlIGZyYW1lcyAodG9waWMvXG4gICAgICAvLyBhbm5vdW5jZW1lbnQgRllJcyBjYW4gbmV2ZXIgY2FycnkgYSBkaXNwb3NpdGlvbiwgc28gdGhleSdkIG90aGVyd2lzZVxuICAgICAgLy8gcGFkIFwid2hhdCdzIGxlZnQ/XCIgZm9yZXZlcikuXG4gICAgICBpZiAobS5raW5kID09PSBcIm1lc3NhZ2VcIikgb3Blbi5wdXNoKG0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBrZXkgPSBtLmRpc3Bvc2l0aW9uID8/IFwidW5rbm93blwiO1xuICAgICAgaWYgKCFieV9zdGF0dXNba2V5XSkgYnlfc3RhdHVzW2tleV0gPSBbXTtcbiAgICAgIGJ5X3N0YXR1c1trZXldLnB1c2gobSk7XG4gICAgfVxuICB9XG4gIGlmIChvcHRzLmh1bWFuKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUocmVuZGVyVHJpYWdlSHVtYW4obmFtZSwgb3BlbiwgYnlfc3RhdHVzKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBvcGVuLCBieV9zdGF0dXMgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEdyZXAoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcGF0dGVybjogc3RyaW5nLFxuICBvcHRzOiB7IGxpdGVyYWw/OiBib29sZWFuOyBmcm9tPzogc3RyaW5nIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFwYXR0ZXJuKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgZ3JlcCA8Y2hhbm5lbD4gPHBhdHRlcm4+IFstLWxpdGVyYWx8LUZdIFstLWZyb20gPGFsaWFzPl1cIik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhsb2dQYXRoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCBtYXRjaGVyOiAodGV4dDogc3RyaW5nKSA9PiBib29sZWFuO1xuICBpZiAob3B0cy5saXRlcmFsKSB7XG4gICAgY29uc3QgbmVlZGxlID0gcGF0dGVybi50b0xvd2VyQ2FzZSgpO1xuICAgIG1hdGNoZXIgPSAodGV4dCkgPT4gdGV4dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5lZWRsZSk7XG4gIH0gZWxzZSB7XG4gICAgbGV0IHJlOiBSZWdFeHA7XG4gICAgdHJ5IHtcbiAgICAgIHJlID0gbmV3IFJlZ0V4cChwYXR0ZXJuLCBcImlcIik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGllKGBpbnZhbGlkIHJlZ2V4OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLCBcInVzYWdlXCIpO1xuICAgIH1cbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHJlLnRlc3QodGV4dCk7XG4gIH1cbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IG1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJhdy5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZSkgY29udGludWU7XG4gICAgbGV0IG1zZzogUGFydGlhbDxNZXNzYWdlPjtcbiAgICB0cnkge1xuICAgICAgbXNnID0gSlNPTi5wYXJzZShsaW5lKSBhcyBQYXJ0aWFsPE1lc3NhZ2U+O1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuICAgIGlmIChvcHRzLmZyb20gJiYgbXNnLmZyb20gIT09IG9wdHMuZnJvbSkgY29udGludWU7XG4gICAgaWYgKCFtYXRjaGVyKG1zZy50ZXh0KSkgY29udGludWU7XG4gICAgbWVzc2FnZXMucHVzaChtc2cpO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlcyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQ2xvc2UobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBjbG9zZSA8bmFtZT5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIGRpZShcIm5vIGRhZW1vbiBydW5uaW5nXCIsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihwb3J0LCBcIkRFTEVURVwiLCBgL2NoYW5uZWxzLyR7bmFtZX1gKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzZXQobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+ID0ge307XG4gIGlmIChvcHRzLmZvcmNlKSBib2R5LmZvcmNlID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBzdWJzY3JpYmVycz86IG51bWJlciB9PihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9yZXNldGAsXG4gICAgYm9keSxcbiAgKTtcbiAgaWYgKHN0YXR1cyA9PT0gNDA5ICYmIGRhdGE/LmVycm9yID09PSBcImxpdmVcIikge1xuICAgIGRpZShcbiAgICAgIGBjaGFubmVsIGhhcyAke2RhdGEuc3Vic2NyaWJlcnN9IGxpdmUgc3Vic2NyaWJlcihzKSDigJQgcmVmdXNpbmcgdG8gY2xlYXIgYSBsaXZlIHNlc3Npb24uIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gY2xlYXIgYW55d2F5ICh0aGUgbG9nIGlzIHNuYXBzaG90dGVkIGZpcnN0KS5gLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gQXJjaGl2ZSAocmVhZC1vbmx5KSBvciB1bmFyY2hpdmUgYSBjaGFubmVsIChWMS43KSDigJQgdGhlIG5vbi1kZXN0cnVjdGl2ZVxuLy8gYWx0ZXJuYXRpdmUgdG8gY2xvc2U6IGhpc3RvcnkgaXMgcHJlc2VydmVkLCBzZW5kcyBhcmUgcmVqZWN0ZWQsIGFuZCB0aGUgbmFtZVxuLy8gaXMgbG9ja2VkIGZyb20gcmUtb3BlbiB1bnRpbCB1bmFyY2hpdmVkLlxuYXN5bmMgZnVuY3Rpb24gY21kTWFyayhcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZDogbnVtYmVyLFxuICBkaXNwb3NpdGlvbjogc3RyaW5nLFxuICBmcm9tOiBzdHJpbmcsXG4gIG9wdHM6IHsgbm90ZT86IHN0cmluZyB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGlkKSB8fCAhZGlzcG9zaXRpb24pXG4gICAgZGllKFwidXNhZ2U6IGdyYXBldmluZSBtYXJrIDxjaGFubmVsPiA8aWQ+IDxkaXNwb3NpdGlvbj4gWy0tbm90ZSA8dGV4dD5dIFstLWFzIDxhbGlhcz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBmcm9tLCB0YXJnZXQ6IGlkLCBkaXNwb3NpdGlvbiB9O1xuICBpZiAob3B0cy5ub3RlICE9PSB1bmRlZmluZWQpIGJvZHkubm90ZSA9IG9wdHMubm90ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlPihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L3N0YXR1c2AsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEgYXMgeyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9IHwgbnVsbCwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBcmNoaXZlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgdW5hcmNoaXZlOiBib29sZWFuLCBmcm9tPzogc3RyaW5nKSB7XG4gIGNvbnN0IHZlcmIgPSB1bmFyY2hpdmUgPyBcInVuYXJjaGl2ZVwiIDogXCJhcmNoaXZlXCI7XG4gIGlmICghbmFtZSkgZGllKGB1c2FnZTogZ3JhcGV2aW5lICR7dmVyYn0gPGNoYW5uZWw+YCk7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQm90aCByb3V0ZXMgYXBwZW5kIGEga2luZDpcInN0YXR1c1wiIGZyYW1lIHRvIHRoZSBsb2csIHNvIHdobyBkaWQgaXQgaXMgd29ydGhcbiAgLy8gcmVjb3JkaW5nIHdoZW4gdGhlIGNhbGxlciB0b2xkIHVzLiBJZGVudGl0eSBpcyBvcHRpb25hbCBoZXJlIChpdCBpcyBvbiB0aGVcbiAgLy8gZ2xvYmFsbHktYWNjZXB0ZWQgLS1hcy8tLWZyb20pLCBhbmQgdGhlIGRhZW1vbiBzaWducyBcInN5c3RlbVwiIHdpdGhvdXQgaXQuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJQT1NUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9LyR7dmVyYn1gLFxuICAgIGZyb20gPyB7IGZyb20gfSA6IHVuZGVmaW5lZCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RvcChvcHRzOiB7IGhvbGRTZWNvbmRzPzogbnVtYmVyIH0gPSB7fSkge1xuICBsZXQgaGVsZFVudGlsOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGlmIChvcHRzLmhvbGRTZWNvbmRzICYmIG9wdHMuaG9sZFNlY29uZHMgPiAwKSB7XG4gICAgaGVsZFVudGlsID0gRGF0ZS5ub3coKSArIG9wdHMuaG9sZFNlY29uZHMgKiAxMDAwO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKGhlbGRVbnRpbCkpO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgZGFlbW9uOiBmYWxzZSxcbiAgICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHN0b3BwZWQ6IHRydWUsXG4gICAgLi4uKGhlbGRVbnRpbCAhPT0gdW5kZWZpbmVkID8geyBoZWxkX3VudGlsOiBoZWxkVW50aWwgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIFBlci1jaGFubmVsIGxpdmUtY29ubmVjdGlvbiBzdW1tYXJ5IOKAlCB0aGUgcmVzdGFydC1zYWZldHkgcmVhZC4gTWlycm9ycyB3aGF0XG4vLyBgZG9jdG9yYCByZXBvcnRzIHVuZGVyIGFjdGl2ZV9zdWJzY3JpYmVyczsgb25seSBwb3B1bGF0ZWQgY2hhbm5lbHMgYXJlIGxpc3RlZC5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoQWN0aXZlU3Vic2NyaWJlcnMoXG4gIHBvcnQ6IG51bWJlcixcbik6IFByb21pc2U8eyB0b3RhbDogbnVtYmVyOyBjaGFubmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbm5lY3Rpb25zOiBudW1iZXIgfT4gfT4ge1xuICBsZXQgdG90YWwgPSAwO1xuICBjb25zdCBjaGFubmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbm5lY3Rpb25zOiBudW1iZXIgfT4gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICBmb3IgKGNvbnN0IGNoIG9mIGRhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICB0b3RhbCArPSBjaC5jb25uZWN0aW9ucztcbiAgICAgIGlmIChjaC5jb25uZWN0aW9ucyA+IDApIGNoYW5uZWxzLnB1c2goeyBuYW1lOiBjaC5uYW1lLCBjb25uZWN0aW9uczogY2guY29ubmVjdGlvbnMgfSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydCDigJQgYSBwcmVzZW5jZSBoaWNjdXAgc2hvdWxkbid0IGNyYXNoIGEgbGlmZWN5Y2xlIHZlcmJcbiAgfVxuICByZXR1cm4geyB0b3RhbCwgY2hhbm5lbHMgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhcnQoKSB7XG4gIC8vIEVuc3VyZS1ydW5uaW5nLCBubyBjaGFubmVsIHNpZGUtZWZmZWN0LiBJZGVtcG90ZW50OiByZXBvcnQgYW4gZXhpc3RpbmdcbiAgLy8gZGFlbW9uLCBvciBzcGF3biBhIGZyZXNoIG9uZS4gVGhlIGV4cGxpY2l0IFwiYnJpbmcgaXQgdXBcIiB2ZXJiIOKAlCBkaWFnbm9zdGljc1xuICAvLyAoZG9jdG9yL2luZm8vbGlzdCkgc3RheSByZWFkLW9ubHkgYW5kIG5ldmVyIHNwYXduLlxuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghZXhpc3RpbmcgJiYgaG9sZEFjdGl2ZSgpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGhlbGQ6IHRydWUsIHBvcnQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBvcnQgPSBleGlzdGluZyA/PyAoYXdhaXQgZW5zdXJlRGFlbW9uKCkpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcG9ydCwgYWxyZWFkeV9ydW5uaW5nOiBleGlzdGluZyAhPT0gbnVsbCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzdGFydChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICAvLyBOb3RoaW5nIHRvIHRlYXIgZG93biDigJQganVzdCBicmluZyBhIGZyZXNoIGRhZW1vbiB1cC5cbiAgICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCByZXN0YXJ0ZWQ6IHRydWUsIHBvcnQ6IGZyZXNoLCBwcmV2aW91c19waWQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFNBRkVUWTogYSByZXN0YXJ0IGZvcmNlcyBldmVyeSBjb25uZWN0ZWQgY2xpZW50IHRvIGF1dG8tcmVjb25uZWN0LiBSZWZ1c2UgdG9cbiAgLy8gdGVhciBkb3duIGEgd29ya2luZyBmbGVldCB1bmxlc3MgZXhwbGljaXRseSBmb3JjZWQg4oCUIG5ldmVyIHNpbGVudGx5IGRyb3AgaXQuXG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByZXN0YXJ0OiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSBhY3Jvc3MgJHtjaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykg4oCUICR7d2hlcmV9LiBgICtcbiAgICAgICAgXCJBIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSBhbGwgdG8gcmVjb25uZWN0LiBSZS1ydW4gd2l0aCAtLWZvcmNlIChvciAtLXllcykgdG8gcHJvY2VlZCBhbnl3YXkuXCIsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgfVxuICAvLyBDYXB0dXJlIHRoZSBwaWQgd2UncmUgcmVwbGFjaW5nLCBmb3IgdGhlIHJlY2VpcHQuXG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICBwcmV2aW91c1BpZCA9IGRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3AsIHRoZW4gd2FpdCBmb3IgdGhlIG9sZCBkYWVtb24gdG8gYWN0dWFsbHkgZ28gYXdheSDigJQgaXQgdW5saW5rcyBpdHNcbiAgLy8gcG9ydC9waWQgZmlsZXMgb24gc2h1dGRvd24sIHNvIGVuc3VyZURhZW1vbiBzcGF3bnMgZnJlc2ggcmF0aGVyIHRoYW5cbiAgLy8gcmUtZGlzY292ZXJpbmcgdGhlIGR5aW5nIG9uZS5cbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGkocG9ydCwgXCJERUxFVEVcIiwgXCIvXCIpO1xuICB9IGNhdGNoIHt9XG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIGlmICgoYXdhaXQgcmVhZERhZW1vblBvcnQoKSkgPT09IG51bGwpIGJyZWFrO1xuICB9XG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCByZXN0YXJ0ZWQ6IHRydWUsIHBvcnQ6IGZyZXNoLCBwcmV2aW91c19waWQ6IHByZXZpb3VzUGlkIH0pO1xufVxuXG4vLyBiMyDigJQgVEhFIFZFUlNJT04gVkVSSUZZLCBBUyBPTkUgU09VUkNFIEZPUiBCT1RIIFBBVEhTLlxuLy9cbi8vIGByb2xsYCBpcyBkb2N1bWVudGVkIGFzIFwidGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwIOKApiArIHZlcnNpb24gdmVyaWZ5XCIsIGFuZFxuLy8gdGhlIHZlcmlmeSBoYWQgdHdvIHdheXMgdG8gc2F5IG5vdGhpbmc6XG4vL1xuLy8gICBDT0xEIFBBVEgg4oCUIG5vIGRhZW1vbiBydW5uaW5nOiBpdCBzcGF3bmVkIG9uZSBhbmQgcHJpbnRlZCBuZWl0aGVyIGB2ZXJzaW9uYFxuLy8gICBub3IgYHZlcnNpb25fb2tgLiBUaGUgZmllbGRzIHdlcmUgQUJTRU5ULCBzbyBhIGNhbGxlciBjaGVja2luZyB0aGUgdmVyaWZ5XG4vLyAgIGdvdCBgdW5kZWZpbmVkYCBvbiB0aGUgZXhhY3QgcGF0aCB3aGVyZSB0aGUgdmVyaWZ5IG5ldmVyIGhhcHBlbmVkLlxuLy9cbi8vICAgV0FSTSBQQVRIIOKAlCB0aGUgcHJvYmUgd2FzIHdyYXBwZWQgaW4gYGNhdGNoIHt9YCwgbGVhdmluZyBgdmVyc2lvbiA9IG51bGxgLFxuLy8gICBhbmQgYHZlcnNpb25fb2s6IG51bGwgPT09IFBMVUdJTl9WRVJTSU9OYCBldmFsdWF0ZXMgdG8gRkFMU0UuIFwiSSBjb3VsZCBub3Rcbi8vICAgY2hlY2tcIiB3YXMgcmVwb3J0ZWQgYXMgXCJ0aGUgdmVyc2lvbiBpcyBXUk9OR1wiIOKAlCBhIGJvb2xlYW4gdGhhdCBjYW5ub3Qgc2F5XG4vLyAgIFwidW5rbm93blwiIGlzIHRoZSBjYW5vbmljYWwgc2hhcGUgb2YgdGhpcyBzcHJpbnQncyBkZWZlY3QsIGFuZCBmYWxzZSBpcyB0aGVcbi8vICAgd29yc3QgYXZhaWxhYmxlIGFuc3dlciBiZWNhdXNlIGl0IGlzIGFjdGlvbmFibGUgYW5kIGluY29ycmVjdC5cbi8vXG4vLyBTbyBgdmVyc2lvbl9va2AgaXMgbm93IGBib29sZWFuIHwgbnVsbGA6IG51bGwgbWVhbnMgVU5DSEVDS0VELCBuZXZlciBmYWxzZS5cbi8vIGB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb25gIGlzIHByZXNlbnQtYW5kLW51bGwgYmVzaWRlIGl0LCBiZWNhdXNlIGEgYmFyZSBudWxsXG4vLyB0ZWxscyBhIGNhbGxlciB0aGUgY2hlY2sgZGlkIG5vdCBoYXBwZW4gYW5kIG5vdCB3aHkuXG4vL1xuLy8gT25lIGhlbHBlciByYXRoZXIgdGhhbiB0d28gY2FsbCBzaXRlczogYSBzZWNvbmQgY29weSBvZiB0aGlzIGxvZ2ljIG9uIHRoZSBjb2xkXG4vLyBwYXRoIGlzIHRoZSBtaXJyb3ItZHJpZnQgdHJhcCwgYW5kIHRoZSBjb2xkIHBhdGggaXMgcHJlY2lzZWx5IHRoZSBvbmUgbm9ib2R5XG4vLyByZS1yZWFkcy5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZVZlcnNpb24ocG9ydDogbnVtYmVyKTogUHJvbWlzZTx7XG4gIHZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHZlcnNpb25fb2s6IGJvb2xlYW4gfCBudWxsO1xuICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IHN0cmluZyB8IG51bGw7XG59PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdiA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmICh2ID09PSBudWxsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgICB2ZXJzaW9uX29rOiBudWxsLFxuICAgICAgICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IFwidGhlIGRhZW1vbiBhbnN3ZXJlZCBidXQgcmVwb3J0ZWQgbm8gdmVyc2lvblwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogdiwgdmVyc2lvbl9vazogdiA9PT0gUExVR0lOX1ZFUlNJT04sIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogbnVsbCB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHZlcnNpb246IG51bGwsXG4gICAgICB2ZXJzaW9uX29rOiBudWxsLFxuICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBgY291bGQgbm90IHJlYWNoIHRoZSBkYWVtb24gdG8gdmVyaWZ5OiAke1xuICAgICAgICBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSlcbiAgICAgIH1gLFxuICAgIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUm9sbChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICAvLyBDT0xEIFBBVEgg4oCUIG5vdGhpbmcgd2FzIHJ1bm5pbmcsIHNvIHRoaXMgaXMgYSBzdGFydCByYXRoZXIgdGhhbiBhIHJvbGwuXG4gICAgLy8gSXQgc3RpbGwgcmVwb3J0cyB0aGUgdmVyaWZ5LCBiZWNhdXNlIFwibm8gZGFlbW9uIHdhcyB1cFwiIGlzIG5vdCBhIHJlYXNvbiB0b1xuICAgIC8vIHN0YXkgc2lsZW50IGFib3V0IHdoaWNoIHZlcnNpb24gaXMgbm93IHNlcnZpbmcuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oe1xuICAgICAgb2s6IHRydWUsXG4gICAgICByb2xsZWQ6IHRydWUsXG4gICAgICBwcmV2aW91c19waWQ6IG51bGwsXG4gICAgICBwb3J0OiBmcmVzaCxcbiAgICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyB0b3RhbCwgY2hhbm5lbHMgfSA9IGF3YWl0IGZldGNoQWN0aXZlU3Vic2NyaWJlcnMocG9ydCk7XG4gIGlmICh0b3RhbCA+IDAgJiYgIW9wdHMuZm9yY2UpIHtcbiAgICBjb25zdCB3aGVyZSA9IGNoYW5uZWxzLm1hcCgoYykgPT4gYCR7Yy5uYW1lfSAoJHtjLmNvbm5lY3Rpb25zfSlgKS5qb2luKFwiLCBcIik7XG4gICAgZGllKFxuICAgICAgYHJvbGw6ICR7dG90YWx9IGFjdGl2ZSBzdWJzY3JpYmVyKHMpIOKAlCAke3doZXJlfS4gVGhleSdsbCBhdXRvLXJlY29ubmVjdCBhY3Jvc3MgdGhlIHJvbGwuIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gcHJvY2VlZC5gLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgbGV0IHByZXZpb3VzUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBwcmV2aW91c1BpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RvcCB3aXRoIGEgc2hvcnQgaG9sZCBzbyBhIHN0YWxlIENMSSBjYW4ndCB3aW4gdGhlIHJlc3Bhd24gcmFjZTsgd2UgaG9sZCB0aGUgc3Bhd24gb3Vyc2VsdmVzLlxuICBjb25zdCBob2xkTXMgPSA0MDAwO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoSE9MRF9GSUxFLCBTdHJpbmcoRGF0ZS5ub3coKSArIGhvbGRNcykpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICByZWxlYXNlSG9sZCgpOyAvLyBvdXIgdHVybiB0byBzcGF3biB0aGUgbmV3IHZlcnNpb25cbiAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgbGV0IHBpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4oZnJlc2gsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICByb2xsZWQ6IHRydWUsXG4gICAgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCxcbiAgICBwaWQsXG4gICAgcG9ydDogZnJlc2gsXG4gICAgLi4uKGF3YWl0IHByb2JlVmVyc2lvbihmcmVzaCkpLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2F0Y2gobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIC8vIENoYW5uZWwgbmFtZSBpcyBvcHRpb25hbCDigJQgdGhlIHBhZ2UgcmVhZHMgaXQgZnJvbSB0aGUgVVJMIGhhc2ggYW5kXG4gIC8vIGRlZmF1bHRzIHRvIFwibG9iYnlcIiBpZiBhYnNlbnQuIFdlIHBhc3MgdGhyb3VnaCB3aGF0ZXZlciB0aGUgdXNlciBnYXZlXG4gIC8vIChvciBcImxvYmJ5XCIpIGFuZCBvcGVuIHRoZSBicm93c2VyLiBEYWVtb24gaXMgZW5zdXJlZCBzbyB0aGUgc2VydmVkXG4gIC8vIC93YXRjaCBIVE1MIGlzIHJlYWNoYWJsZS5cbiAgY29uc3QgY2hhbm5lbCA9IG5hbWU/LnRyaW0oKSA/IG5hbWUudHJpbSgpIDogXCJsb2JieVwiO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEVuc3VyZSB0aGUgY2hhbm5lbCBleGlzdHMgc28gdGhlIHBhZ2Ugc2VlcyBhIHZhbGlkIGJhY2tsb2cvdG9waWMuXG4gIGF3YWl0IGFwaShwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lOiBjaGFubmVsIH0pO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3dhdGNoIyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNoYW5uZWwpfWA7XG4gIC8vIE9wZW4gdGhlIGJyb3dzZXIgdmlhIHRoZSBwbGF0Zm9ybSdzIGRlZmF1bHQgb3BlbmVyLiBCZXN0LWVmZm9ydCDigJRcbiAgLy8gcHJpbnQgdGhlIFVSTCBzbyB0aGUgdXNlciBjYW4gY2xpY2sgaXQgaWYgYXV0by1vcGVuIGZhaWxzLlxuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwiZXhwbG9yZXJcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gc3Bhd24ob3BlbmVyLCBbdXJsXSwge1xuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICBzdGRpbzogXCJpZ25vcmVcIixcbiAgICB9KTtcbiAgICBwLnVucmVmKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG9wZW5lciBtaXNzaW5nIOKAlCBqdXN0IHByaW50ICovXG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWwsIHVybCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kRG9jdG9yKCkge1xuICAvLyBSZWFkLW9ubHkgZGlhZ25vc3RpYy4gUmVwb3J0cyB0aGUgYXV0aG9yaXRhdGl2ZSBkYWVtb24gKGlmIGFueSksIG90aGVyXG4gIC8vIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzc2VzIHZpc2libGUgb24gdGhlIG1hY2hpbmUsIGNoYW5uZWwgZmlsZXMgb25cbiAgLy8gZGlzaywgYW5kIHN1cmZhY2VzIGhpbnRzLiBEb2VzIE5PVCB0YWtlIGRlc3RydWN0aXZlIGFjdGlvbiDigJQgY2xlYW51cFxuICAvLyBpcyB0aGUgb3BlcmF0b3IncyBjYWxsLCB3aXRoIHN0b2NrIHVuaXggdG9vbHMuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBsZXQgYXV0aG9yaXRhdGl2ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsID0gbnVsbDtcbiAgLy8gUGVyLWNoYW5uZWwgc3Vic2NyaWJlciBzdW1tYXJ5IOKAlCBhbnN3ZXJzIFwiaXMgaXQgc2FmZSB0byByZXN0YXJ0IHRoZVxuICAvLyBkYWVtb24gcmlnaHQgbm93P1wiIHdpdGhvdXQgbmVlZGluZyB0byBhbHNvIHJ1biBgbGlzdGAgYW5kIHJlYWQgdGhlXG4gIC8vIG91dHB1dC4gRW1wdHkgaWYgbm8gZGFlbW9uIGlzIHJ1bm5pbmcuXG4gIGxldCB0b3RhbFN1YnNjcmliZXJzID0gMDtcbiAgY29uc3QgYnVzeUNoYW5uZWxzOiBBcnJheTx7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gICAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgICBuYW1lZDogbnVtYmVyO1xuICAgIGFub255bW91czogbnVtYmVyO1xuICB9PiA9IFtdO1xuICBpZiAocG9ydCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpO1xuICAgICAgYXV0aG9yaXRhdGl2ZSA9IHsgcG9ydCwgLi4uZGF0YSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gZGFlbW9uIHdlbnQgYXdheSBiZXR3ZWVuIHBvcnQgY2hlY2sgYW5kIGFwaSBjYWxsXG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAvLyAvcHJlc2VuY2UgZ2l2ZXMgdGhlIGhvbmVzdCBwZXItY2hhbm5lbCBicmVha2Rvd24gKGNvbm5lY3Rpb25zIHZzIG5hbWVkXG4gICAgICAvLyB2cyBhbm9ueW1vdXMpIOKAlCBzbyB0aGUgcmVzdGFydC1zYWZldHkgdG90YWwgaXNuJ3QgYSBteXN0ZXJ5IGFuZCBhblxuICAgICAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiByZWFkcyBhcyBhIHdhdGNoZXIsIG5vdCBhIGdob3N0LlxuICAgICAgY29uc3QgeyBkYXRhOiBwcmVzRGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICAgICAgZm9yIChjb25zdCBjaCBvZiBwcmVzRGF0YT8uY2hhbm5lbHMgPz8gW10pIHtcbiAgICAgICAgdG90YWxTdWJzY3JpYmVycyArPSBjaC5jb25uZWN0aW9ucztcbiAgICAgICAgYnVzeUNoYW5uZWxzLnB1c2goe1xuICAgICAgICAgIG5hbWU6IGNoLm5hbWUsXG4gICAgICAgICAgc3Vic2NyaWJlcnM6IGNoLmNvbm5lY3Rpb25zLCAvLyBiYWNrLWNvbXBhdDogcHJldmlvdXNseSB0aGUgcmF3IGNvdW50XG4gICAgICAgICAgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zLFxuICAgICAgICAgIG5hbWVkOiBjaC5uYW1lZCxcbiAgICAgICAgICBhbm9ueW1vdXM6IGNoLmFub255bW91cyxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBiZXN0LWVmZm9ydFxuICAgIH1cbiAgfVxuXG4gIC8vIEVudW1lcmF0ZSBvdGhlciBkYWVtb24gcHJvY2Vzc2VzIHZpYSB0aGUgc2hhcmVkIGNsYXNzaWZpZXIuIEVhY2ggZW50cnlcbiAgLy8gZ2FpbnMgcG9ydC9ob21lL3ZlcnNpb24vc3RhdHVzL3JlYXBhYmxlIHNvIHRoZSBvcGVyYXRvciBoYXMgdGhlIGZ1bGxcbiAgLy8gcGljdHVyZSB3aXRob3V0IG5lZWRpbmcgYSBzZXBhcmF0ZSBgcmVhcCAtLWRyeS1ydW5gLlxuICBjb25zdCBvdGhlckRhZW1vbnM6IEFycmF5PEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlEYWVtb24+PiAmIHsgY29tbWFuZD86IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBzZWxmUGlkID0gYXV0aG9yaXRhdGl2ZT8ucGlkIGFzIG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IHBpZCBvZiBhd2FpdCBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpKSB7XG4gICAgICBpZiAoc2VsZlBpZCAmJiBwaWQgPT09IHNlbGZQaWQpIGNvbnRpbnVlO1xuICAgICAgb3RoZXJEYWVtb25zLnB1c2goYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwcyB1bmF2YWlsYWJsZTsgY2Fycnkgb24gd2l0aCBlbXB0eSBsaXN0XG4gIH1cblxuICAvLyBDaGFubmVscyBvbiBkaXNrIHVuZGVyIHRoaXMgSE9NRS5cbiAgY29uc3QgY2hhbm5lbHNPbkRpc2s6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgY2hhbm5lbHNEaXIgPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKGNoYW5uZWxzRGlyKSkge1xuICAgICAgZm9yIChjb25zdCBmIG9mIHJlYWRkaXJTeW5jKGNoYW5uZWxzRGlyKSkge1xuICAgICAgICBpZiAoZi5lbmRzV2l0aChcIi5qc29ubFwiKSkgY2hhbm5lbHNPbkRpc2sucHVzaChmLnJlcGxhY2UoL1xcLmpzb25sJC8sIFwiXCIpKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge31cblxuICAvLyBIaW50cyDigJQgc3VyZmFjZSB0aGUgbW9zdCBhY3Rpb25hYmxlIHNpZ25hbHMuXG4gIGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoIWF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgXCJObyBhdXRob3JpdGF0aXZlIGRhZW1vbiBydW5uaW5nIGZvciB0aGlzIEhPTUUuIFJ1biBhbnkgdmVyYiAoZS5nLiBgY2xpLnRzIGxpc3RgKSB0byBzcGF3biBvbmUuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAob3RoZXJEYWVtb25zLmxlbmd0aCA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYEZvdW5kICR7b3RoZXJEYWVtb25zLmxlbmd0aH0gb3RoZXIgZ3JhcGV2aW5lIGRhZW1vbiBwcm9jZXNzKGVzKSBvbiB0aGlzIG1hY2hpbmUuIGAgK1xuICAgICAgICBcIlRoZXkgbWF5IGJlIHpvbWJpZXMgZnJvbSBwYXN0IHJ1bnMgT1IgZGFlbW9ucyBzZXJ2aW5nIG90aGVyIEhPTUVzIChkaWZmZXJlbnQgR1JBUEVWSU5FX0hPTUUpLlwiLFxuICAgICk7XG4gICAgY29uc3QgcmVhcGFibGVDb3VudCA9IG90aGVyRGFlbW9ucy5maWx0ZXIoKGQpID0+IGQucmVhcGFibGUpLmxlbmd0aDtcbiAgICBpZiAocmVhcGFibGVDb3VudCA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGBGb3VuZCAke3JlYXBhYmxlQ291bnR9IHJlYXBhYmxlIG9ycGhhbiBkYWVtb24ocykuIFJ1biBcXGBncmFwZXZpbmUgcmVhcFxcYCB0byBjbGVhciB0aGVtIHNhZmVseS5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG90aGVyRGFlbW9ucy5zb21lKChkKSA9PiBkLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIikpIHtcbiAgICAgIGhpbnRzLnB1c2goXCJTb21lIGRhZW1vbnMgYXJlIHVucmVzcG9uc2l2ZTsgYGdyYXBldmluZSByZWFwIC0tZm9yY2VgIGluY2x1ZGVzIHRoZW0uXCIpO1xuICAgIH1cbiAgfVxuICBpZiAoXG4gICAgYXV0aG9yaXRhdGl2ZSAmJlxuICAgIFBMVUdJTl9WRVJTSU9OICYmXG4gICAgdHlwZW9mIGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIGF1dGhvcml0YXRpdmUudmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT05cbiAgKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBBdXRob3JpdGF0aXZlIGRhZW1vbiB2ZXJzaW9uICgke2F1dGhvcml0YXRpdmUudmVyc2lvbn0pIGRpZmZlcnMgZnJvbSB0aGlzIENMSSdzIHZlcnNpb24gKCR7UExVR0lOX1ZFUlNJT059KS4gYCArXG4gICAgICAgIFwiUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduIOKAlCBkcm9wIGFjdGl2ZSB0YWlscywgdGhlbiBgc3RvcGAsIHRoZW4gYW55IHZlcmIuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoYXV0aG9yaXRhdGl2ZSAmJiAoYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSBudWxsIHx8IGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gdW5kZWZpbmVkKSkge1xuICAgIGhpbnRzLnB1c2goXCJBdXRob3JpdGF0aXZlIGRhZW1vbiBwcmVkYXRlcyB2ZXJzaW9uIHJlcG9ydGluZyAocHJlLVYxLjYuMikuIFJlc3RhcnQgdG8gYWxpZ24uXCIpO1xuICB9XG4gIGlmICh0b3RhbFN1YnNjcmliZXJzID4gMCkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgJHt0b3RhbFN1YnNjcmliZXJzfSBhY3RpdmUgc3Vic2NyaWJlcihzKSBhY3Jvc3MgJHtidXN5Q2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpLiBgICtcbiAgICAgICAgXCJEYWVtb24gcmVzdGFydCB3b3VsZCBmb3JjZSB0aGVtIHRvIGF1dG8tcmVjb25uZWN0ICh3b3JrcywgYnV0IGRpc3J1cHRpdmUpIOKAlCBjb29yZGluYXRlIGZpcnN0LlwiLFxuICAgICk7XG4gIH0gZWxzZSBpZiAoYXV0aG9yaXRhdGl2ZSkge1xuICAgIGhpbnRzLnB1c2goXCJObyBhY3RpdmUgc3Vic2NyaWJlcnMg4oCUIGRhZW1vbiByZXN0YXJ0IGlzIG5vbi1kaXNydXB0aXZlLlwiKTtcbiAgfVxuICAvLyBFeHBsYWluIGFueSBjaGFubmVsIHdoZXJlIHRoZSBjb25uZWN0aW9uIGNvdW50IGV4Y2VlZHMgbmFtZWQgYWdlbnRzIOKAlCBhblxuICAvLyBhbm9ueW1vdXMgd2F0Y2ggdGFiIGluZmxhdGVzIGBjb3VudGAvYGNvbm5lY3Rpb25zYCBidXQgaXNuJ3QgYSBnaG9zdC5cbiAgZm9yIChjb25zdCBjaCBvZiBidXN5Q2hhbm5lbHMpIHtcbiAgICBpZiAoY2guYW5vbnltb3VzID4gMCkge1xuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7Y2gubmFtZX06ICR7Y2guY29ubmVjdGlvbnN9IGNvbm5lY3Rpb24ocyksICR7Y2gubmFtZWR9IG5hbWVkIGFnZW50KHMpICsgYCArXG4gICAgICAgICAgYCR7Y2guYW5vbnltb3VzfSBhbm9ueW1vdXMgKGUuZy4gYSB3YXRjaCB0YWIpLiBUaGUgY291bnQgb3ZlciB0aGUgbmFtZSBsaXN0IGlzIGV4cGVjdGVkLCBub3QgYSBnaG9zdC5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIGhvbWU6IERBVEFfRElSLFxuICAgIGNsaV92ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTixcbiAgICBhdXRob3JpdGF0aXZlLFxuICAgIGFjdGl2ZV9zdWJzY3JpYmVyczoge1xuICAgICAgdG90YWw6IHRvdGFsU3Vic2NyaWJlcnMsXG4gICAgICBidXN5X2NoYW5uZWxzOiBidXN5Q2hhbm5lbHMsXG4gICAgfSxcbiAgICBvdGhlcl9kYWVtb25zX29uX21hY2hpbmU6IG90aGVyRGFlbW9ucyxcbiAgICBjaGFubmVsc19vbl9kaXNrOiBjaGFubmVsc09uRGlzayxcbiAgICBoaW50cyxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEluZm8oKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8g4pSA4pSAIERhZW1vbiBlbnVtZXJhdGlvbiArIGNsYXNzaWZpZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKiBBbGwgZ3JhcGV2aW5lIGRhZW1vbi50cyBwaWRzIHZpc2libGUgb24gdGhpcyBtYWNoaW5lICh2aWEgYHBzYCkuICovXG5hc3luYyBmdW5jdGlvbiBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpOiBQcm9taXNlPG51bWJlcltdPiB7XG4gIGNvbnN0IHBpZHM6IG51bWJlcltdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgcHJvYyA9IHNwYXduKFwicHNcIiwgW1wiLWVvXCIsIFwicGlkLGNvbW1hbmRcIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByZXNvbHZlKCkpKTtcbiAgICBjb25zdCBvdXQgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygb3V0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBpZiAoIWxpbmUuaW5jbHVkZXMoXCJkYWVtb24udHNcIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFsaW5lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJncmFwZXZpbmVcIikpIGNvbnRpbnVlO1xuICAgICAgLy8gVGhlIHBpZCBncm91cCBpcyBtYW5kYXRvcnk7IGFuIHVubWF0Y2hlZCBsaW5lIGlzIHNraXBwZWQsIGFzIGJlZm9yZS5cbiAgICAgIGNvbnN0IGRpZ2l0cyA9IGxpbmUubWF0Y2goL15cXHMqKFxcZCspXFxzKy8pPy5bMV07XG4gICAgICBpZiAoZGlnaXRzID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcGlkID0gcGFyc2VJbnQoZGlnaXRzLCAxMCk7XG4gICAgICBpZiAocGlkKSBwaWRzLnB1c2gocGlkKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIHBzIHVuYXZhaWxhYmxlOyByZXR1cm4gZW1wdHlcbiAgfVxuICByZXR1cm4gcGlkcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gbHNvZkxpc3RlblBvcnQocGlkOiBudW1iZXIpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9jID0gc3Bhd24oXCJsc29mXCIsIFtcIi1haVRDUFwiLCBcIi1zVENQOkxJU1RFTlwiLCBcIi1wXCIsIFN0cmluZyhwaWQpLCBcIi1QXCIsIFwiLW5cIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByKCkpKTtcbiAgICAvLyBUaGUgcG9ydCBncm91cCBpcyBtYW5kYXRvcnk7IG5vIG1hdGNoIGlzIHRoaXMgZnVuY3Rpb24ncyBvd24gYG51bGxgLlxuICAgIGNvbnN0IGRpZ2l0cyA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKVxuICAgICAgLnRvU3RyaW5nKFwidXRmLThcIilcbiAgICAgIC5tYXRjaCgvMTI3XFwuMFxcLjBcXC4xOihcXGQrKS8pPy5bMV07XG4gICAgcmV0dXJuIGRpZ2l0cyA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IHBhcnNlSW50KGRpZ2l0cywgMTApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgdHlwZSBEYWVtb25TdGF0dXMgPSBcImF1dGhvcml0YXRpdmVcIiB8IFwib3JwaGFuXCIgfCBcInVucmVzcG9uc2l2ZVwiIHwgXCJ1bmtub3duXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGFzc2lmeURhZW1vbihwaWQ6IG51bWJlcik6IFByb21pc2U8e1xuICBwaWQ6IG51bWJlcjtcbiAgcG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgaG9tZT86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogRGFlbW9uU3RhdHVzO1xuICByZWFwYWJsZTogYm9vbGVhbjtcbn0+IHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGxzb2ZMaXN0ZW5Qb3J0KHBpZCk7XG4gIGlmICghcG9ydCkgcmV0dXJuIHsgcGlkLCBwb3J0OiBudWxsLCBzdGF0dXM6IFwidW5rbm93blwiLCByZWFwYWJsZTogZmFsc2UgfTtcbiAgbGV0IGluZm86IFJvb3RJbmZvIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoODAwKSxcbiAgICB9KTtcbiAgICBpZiAocmVzLm9rKSBpbmZvID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJvb3RJbmZvO1xuICB9IGNhdGNoIHt9XG4gIGlmICghaW5mbykgcmV0dXJuIHsgcGlkLCBwb3J0LCBzdGF0dXM6IFwidW5yZXNwb25zaXZlXCIsIHJlYXBhYmxlOiBmYWxzZSB9OyAvLyByZWFwIG9ubHkgd2l0aCAtLWZvcmNlIChoYW5kbGVkIGluIGNtZFJlYXApXG4gIGNvbnN0IGhvbWUgPSBpbmZvLmRhdGFfZGlyIGFzIHN0cmluZztcbiAgbGV0IG93bnMgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBvcCA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBvcnRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIGNvbnN0IG9pID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucGlkXCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBvd25zID0gb3AgPT09IFN0cmluZyhwb3J0KSAmJiBvaSA9PT0gU3RyaW5nKHBpZCk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG93bnNcbiAgICA/IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcImF1dGhvcml0YXRpdmVcIixcbiAgICAgICAgcmVhcGFibGU6IGZhbHNlLFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwib3JwaGFuXCIsXG4gICAgICAgIHJlYXBhYmxlOiB0cnVlLFxuICAgICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhcChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbjsgZHJ5UnVuPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHNlbGZQb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTsgLy8gY3VycmVudCBIT01FIGF1dGhvcml0YXRpdmUgKG5ldmVyIHJlYXApXG4gIGxldCBzZWxmUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgaWYgKHNlbGZQb3J0KSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGZQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihzZWxmUG9ydCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcGlkcyA9IGF3YWl0IGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCk7XG4gIGNvbnN0IGtlcHQ6IHVua25vd25bXSA9IFtdLFxuICAgIHJlYXBlZDogdW5rbm93bltdID0gW10sXG4gICAgc2tpcHBlZDogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgcGlkIG9mIHBpZHMpIHtcbiAgICBjb25zdCBjID0gYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKTtcbiAgICBjb25zdCBpc1NlbGYgPSBwaWQgPT09IHNlbGZQaWQ7XG4gICAgY29uc3Qgc2hvdWxkUmVhcCA9XG4gICAgICAhaXNTZWxmICYmIChjLnJlYXBhYmxlIHx8IChjLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIiAmJiBvcHRzLmZvcmNlID09PSB0cnVlKSk7XG4gICAgaWYgKCFzaG91bGRSZWFwKSB7XG4gICAgICBrZXB0LnB1c2goYyk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG9wdHMuZHJ5UnVuKSB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImRyeS1ydW5cIiB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5raWxsKHBpZCwgXCJTSUdURVJNXCIpO1xuICAgICAgcmVhcGVkLnB1c2goYyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImtpbGwgZmFpbGVkXCIgfSk7XG4gICAgfVxuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkcnlfcnVuOiAhIW9wdHMuZHJ5UnVuLCBrZXB0LCByZWFwZWQsIHNraXBwZWQgfSk7XG59XG5cbi8vIChCT09MRUFOX0ZMQUdTIHdhcyBoZXJlLiBJdCBsaXN0ZWQgd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZSDigJQgaGFsZiBhXG4vLyByZWdpc3RyeSwgY29uc3VsdGVkIGJ5IHRoZSBoYW5kLXJvbGxlZCBwYXJzZXIuIEl0cyAxMyBlbnRyaWVzIG5vdyBsaXZlIGluXG4vLyBDTElfT1BUSU9OUyBiZWxvdyBhcyBge3R5cGU6XCJib29sZWFuXCJ9YCwgdmVyaWZpZWQgMTMtZm9yLTEzIGFnYWluc3QgdGhvdGgnc1xuLy8gaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0IGJlZm9yZSB0aGUgbW92ZS4gRGVsZXRlZCByYXRoZXIgdGhhbiBsZWZ0XG4vLyBiZXNpZGUgaXRzIHJlcGxhY2VtZW50OiBhIHNlY29uZCBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSBzYW1lIGZhY3QgaXMgdGhlXG4vLyBkcmlmdCBidWcgdGhpcyBsYW5lIGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCB3b3VsZCBubyBsb25nZXIgYmUgY29uc3VsdGVkXG4vLyBieSBhbnl0aGluZy4pXG5cbi8vIFNpZ25hdHVyZSBvZiBhIGhlcmVkb2MgZnVtYmxlOiBhIGxpbmUgdGhhdCBpcyAob3IgYmVnaW5zIHdpdGgpIGFcbi8vIGBidW4g4oCmIGNsaS50cyDigKYgc2VuZGAgaW52b2NhdGlvbi4gV2hlbiBhIGBzZW5kIC0tc3RkaW4gPDxFT0ZgIGlzIGJvdGNoZWQsIHRoZVxuLy8gc2hlbGwgcGlwZXMgdGhlIGxpdGVyYWwgY29tbWFuZCBsaW5lIGluIGFzIHRoZSBib2R5LCB3aGljaCB0aGVuIGdldHMgcG9zdGVkIOKAlFxuLy8gY29ycnVwdGluZyB0aGUgY2hhbm5lbCB3aXRoIGBidW4gL+KApi9jbGkudHMgc2VuZCA8Y2hhbm5lbD4gLS1hcyDigKYgPHRleHQ+YC5cbi8vIFdlIHJlZnVzZSB0byBwb3N0IHN1Y2ggYSBib2R5IHVubGVzcyAtLWZvcmNlIGlzIHBhc3NlZC5cbmNvbnN0IExFQUtFRF9TRU5EX1JFID0gLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxiKD86c2VuZHxhbm5vdW5jZSlcXGIvO1xuZnVuY3Rpb24gbG9va3NMaWtlTGVha2VkU2VuZCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIExFQUtFRF9TRU5EX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vIFNoZWxsLW1ldGFjaGFyYWN0ZXIgZm9vdGd1biAoIzYwKTogYSBib2R5IHBhc3NlZCBhcyBhbiBJTkxJTkUgcG9zaXRpb25hbCBhcmdcbi8vIGlzIGV4cG9zZWQgdG8gdGhlIGNhbGxlcidzIHNoZWxsLCB3aGljaCBjb21tYW5kLXN1YnN0aXR1dGVzIGJhY2t0aWNrcyAvXG4vLyBgJCguLi4pYCAvIGAkey4uLn1gIEJFRk9SRSBncmFwZXZpbmUgc2VlcyBpdCDigJQgY29ycnVwdGluZyBvciBwYXJ0aWFsbHlcbi8vIGV4ZWN1dGluZyBjb2RlLWJlYXJpbmcgbWVzc2FnZXMuIFRoZSBDTEkgY2FuJ3QgdW4tc3Vic3RpdHV0ZSB3aGF0IHRoZSBzaGVsbFxuLy8gYWxyZWFkeSBhdGU7IHRoZSBob25lc3QgZml4IGlzIHRvIHN0ZWVyIGNhbGxlcnMgdG8gdGhlIHNoZWxsLWZyZWUgcGF0aHNcbi8vICgtLWJvZHktZmlsZSAvIC0tc3RkaW4gLyBkZWZhdWx0LXN0ZGluKS4gV2hlbiBtZXRhY2hhcmFjdGVycyBTVVJWSVZFIGludG8gYW5cbi8vIGlubGluZSBib2R5IChlLmcuIHRoZSBjYWxsZXIgaGFwcGVuZWQgdG8gc2luZ2xlLXF1b3RlKSwgdGhleSdyZSBpbnRhY3QgdGhpc1xuLy8gdGltZSDigJQgYnV0IHRoZSBwYXR0ZXJuIGlzIGEgbGF0ZW50IGZvb3RndW4sIHNvIHdlIHdhcm4gKG5ldmVyIGJsb2NrOiB0aGVcbi8vIG1lc3NhZ2UgaXMgZmluZSBhcyByZWNlaXZlZCkuIEFic2VudC1tZXRhY2hhciBpbmxpbmUgYm9kaWVzIGFyZSBlaXRoZXIgcGxhaW5cbi8vIHRleHQgKHNhZmUpIG9yIGFscmVhZHktc3Vic3RpdHV0ZWQgKHVuZGV0ZWN0YWJsZSkg4oCUIHNvIHdlIG9ubHkgd2FybiBvbiB0aGVcbi8vIGRldGVjdGFibGUgcmlza3kgcGF0dGVybi5cbmNvbnN0IFNIRUxMX01FVEFDSEFSX1JFID0gL2B8XFwkXFwofFxcJFxcey87XG5leHBvcnQgZnVuY3Rpb24gbG9va3NTaGVsbFJpc2t5KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gU0hFTExfTUVUQUNIQVJfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIGdyYXBldmluZSBhbHJlYWR5IGhhZCBIQUxGIGEgcmVnaXN0cnk6IGBCT09MRUFOX0ZMQUdTYCBhYm92ZSB0b2xkIHRoZSBwYXJzZXJcbi8vIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUuIFdoYXQgaXQgaGFkIG5vIG5vdGlvbiBvZiB3YXMgd2hpY2ggZmxhZ3MgRVhJU1QsIHNvXG4vLyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2Vcbi8vIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXMgc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC5cbi8vXG4vLyDimqAgZ3JhcGV2aW5lIGlzIHRoZSBPVVRMSUVSIG9mIHRoZSBzaXgsIGFuZCBpdCBpcyB3b3J0aCBzYXlpbmcgd2h5IHNvIG5vYm9keVxuLy8gcmVhZHMgaXQgYXMgbWVyZWx5IGJlaGluZDogaXQgdHlwZXMgaXRzIHZhbHVlIGZsYWdzIHdpdGggYSBDQVNUXG4vLyAoYGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZGApIHdoZXJlIHRoZSBvdGhlciBlbnRyeSBwb2ludHMgdXNlIGFcbi8vIGB0eXBlb2ZgIGd1YXJkLiBBIGNhc3QgaXMgYSBjbGFpbSB3aXRoIE5PIFJVTlRJTUUgQ0hFQ0ssIHNvIGdyYXBldmluZSBjYXJyaWVkXG4vLyBhIGNsYXNzIG9mIGxhdGVudCB0eXBlLWxpZSB0aGUgb3RoZXJzIHdlcmUgZ3VhcmRlZCBhZ2FpbnN0IOKAlCBhbmQgYmFyZSB2YWx1ZVxuLy8gZmxhZ3MgcHJvZHVjZWQgc2lsZW50IHdyb25nIHZhbHVlcyByYXRoZXIgdGhhbiBlcnJvcnM6XG4vL1xuLy8gICAtLWxhc3QgICBiYXJlICAtPiAgcGFyc2VJbnQodHJ1ZSwgMTApICAtPiAgTmFOLCBzaWxlbnRseVxuLy8gICAtLXRvcGljICBiYXJlICAtPiAgYHRydWVgIGluIGEgZmllbGQgREVDTEFSRUQgYHN0cmluZ2Bcbi8vXG4vLyBgc3RyaWN0OiB0cnVlYCB0dXJucyBlYWNoIG9mIHRob3NlIGZyb20gYSBzaWxlbnQgd3JvbmcgdmFsdWUgaW50byBhXG4vLyBjYWxsZXItZmFjaW5nIGVycm9yLCB3aGljaCBpcyB0aGUgbGFuZSdzIHdob2xlIHB1cnBvc2UgYW5kIHRoZSBsYXJnZXN0XG4vLyBiZWhhdmlvdXIgZGVsdGEgb2YgdGhlIHNpeCBlbnRyeSBwb2ludHMuXG4vL1xuLy8gVGhlIGJvb2xlYW4gc2V0IGJlbG93IGlzIEJPT0xFQU5fRkxBR1MsIHVuY2hhbmdlZCDigJQgZXh0cmFjdGVkIGZyb20gdGhpcyBmaWxlXG4vLyBhbmQgZGlmZmVkIGFnYWluc3QgdGhvdGgncyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3Q6IDEzIGZvciAxMywgZXhhY3QsXG4vLyB6ZXJvIGRpdmVyZ2VuY2UgaW4gZWl0aGVyIGRpcmVjdGlvbi5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjaGFubmVsczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBob2xkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJpbi1yZXBseS10b1wiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFzdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1heDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0b3BpYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGFsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImRyeS1ydW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmb3JjZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmcmVzaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImZyb20tc3RhcnRcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW1hbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsaXRlcmFsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGx1cms6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVpZXQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGV4dDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB2ZXJib3NlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHllczogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxufSBhcyBjb25zdDtcblxuLyoqXG4gKiBBIHBhcnNlLXN0YWdlIHJlamVjdGlvbiwgY2FycnlpbmcgdGhlIGVudW1lcmF0aW9uIGl0IHdhbnRzIHRvIHB1Ymxpc2guXG4gKlxuICog4puUIFRIRSBgZXh0cmFgIElTIFdIWSBUSElTIENMQVNTIFNVUlZJVkVEIFRIRSBgZXJyb3JzLnRzYCBBRE9QVElPTi4gVGhlXG4gKiByZWplY3Rpb24gaGFzIHRvIE5BTUUgaXRzIHZhbGlkIHNldCDigJQgdGhhdCBpcyB0aGUgd2hvbGUgcmVhc29uIGdyYXBldmluZSdzXG4gKiBwYXJzZXIgZXJyb3JzIHdlcmUgc2hhcGVkIHRoZSB3YXkgdGhleSB3ZXJlIOKAlCBhbmQgdGhlIHRocm93IGhhcHBlbnMgdHdvIGZyYW1lc1xuICogYmVsb3cgdGhlIHBsYWNlIHRoYXQga25vd3MgdGhlIHNldC4gYGNob2ljZXNgIGlzIHdoZXJlIHRoZSBob3VzZSBlbnZlbG9wZVxuICogY2FycmllcyBhbiBlbnVtZXJhdGlvbiwgc28gdGhlIGNsYXNzIGhvbGRzIGl0IHVudGlsIGBydW5Db21tYW5kYCByYWlzZXMuXG4gKi9cbmNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiVXNhZ2VFcnJvclwiO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxufVxuXG50eXBlIEZsYWdOYW1lID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuXG4vLyBJZGVudGl0eSBpcyBjb250cmFjdHVhbGx5IEdMT0JBTDogU0tJTEwubWQgdGVsbHMgYWdlbnRzIHRvIHBhc3MgLS1hcy8tLWZyb21cbi8vIG9uIEVWRVJZIHZlcmIgKGEgZnJlc2ggc2hlbGwgcGVyIGNvbW1hbmQgbWVhbnMgR1JBUEVWSU5FX0ZST00gbmV2ZXJcbi8vIHBlcnNpc3RzKSwgc28gZXZlcnkgY29tbWFuZCBhY2NlcHRzIGJvdGgg4oCUIGV2ZW4gd2hlcmUgYSB2ZXJiIGhhcyBubyB1c2UgZm9yXG4vLyBpZGVudGl0eSwgYSBjYWxsZXIgZm9sbG93aW5nIG91ciBvd24gZG9jcyBtdXN0IG5vdCBiZSByZWplY3RlZCBmb3Igb2JleWluZ1xuLy8gdGhlbS4gT24gYGdyZXBgLCBgLS1mcm9tYCBpcyBhbiBhdXRob3IgRklMVEVSIHJhdGhlciB0aGFuIGlkZW50aXR5OiBkaWZmZXJlbnRcbi8vIHNlbWFudGljcywgc2FtZSBhY2NlcHRhbmNlLlxuY29uc3QgR0xPQkFMX0ZMQUdTOiBGbGFnTmFtZVtdID0gW1wiYXNcIiwgXCJmcm9tXCJdO1xuXG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcblxuLy8gVEhFIENPTU1BTkQgVEFCTEUsIEFTIEEgU1RSVUNUVVJFIOKAlCB0aGUgcGFyc2VyLCB0aGUgZGlzcGF0Y2hlciwgdGhlIHNjaGVtYVxuLy8gZW1pdHRlciBhbmQgdGhlIHJvb3QgcmVqZWN0aW9uIGFsbCB3YWxrIFRISVMuIEl0IHJlcGxhY2VkIGEgYmFyZSBgc3dpdGNoYCxcbi8vIHdoaWNoIG9ubHkgdGhlIGRpc3BhdGNoZXIgY291bGQgd2FsazogYSBzY2hlbWEgZW1pdHRlZCBmcm9tIGFueXRoaW5nIG90aGVyXG4vLyB0aGFuIHRoZSBzdHJ1Y3R1cmUgdGhhdCByb3V0ZXMgdGhlIGJlaGF2aW91ciBpcyBhIGRvY3VtZW50IHRoYXQgbGllcyBhcyBzb29uXG4vLyBhcyBhbnlvbmUgZWRpdHMgdGhlIG90aGVyIHNpZGUgKGFjYyBTVEFOREFSRC5tZCBQYXJ0IDEgwqcyOyBvdXIgb3duICM4MS9ENFxuLy8gbGFuZSBsZWFybmVkIHRoZSBzYW1lIGxlc3NvbiBvbmUgYWx0aXR1ZGUgZG93biB3aXRoIEJPT0xFQU5fRkxBR1MpLlxuLy9cbi8vIGBmbGFnc2AgaXMgdGhlIHZlcmIncyBPV04gYWNjZXB0ZWQgc2V0IChHTE9CQUxfRkxBR1MgYXJlIG1lcmdlZCBpbiBieVxuLy8gYGFjY2VwdGVkRmxhZ3NgKS4gQSBmbGFnIG5vdCBsaXN0ZWQgaGVyZSBpcyBSRUpFQ1RFRCBmb3IgdGhpcyB2ZXJiIHdpdGggdGhlXG4vLyB2ZXJiJ3Mgb3duIHNldCBlbnVtZXJhdGVkIOKAlCBhY2NlcHRlZC1hbmQtaWdub3JlZCBpcyB0aGUgZGlzZWFzZSB0aGlzIHRhYmxlXG4vLyBleGlzdHMgdG8gY3VyZSAoYWNjIERULTE6IGFudGhpbGwgYWNjZXB0aW5nIGEgcm9vdCBgLS1mb3JtYXRgIGl0IHNpbGVudGx5XG4vLyBkaXNjYXJkczsgZ3JhcGV2aW5lIGFjY2VwdGluZyBgc2VuZCAtLWRyeS1ydW5gIGFuZCBkb2luZyBub3RoaW5nIHdhcyB0aGVcbi8vIHNhbWUgZXZlbnQgd2l0aCBhIGRpZmZlcmVudCBzcGVsbGluZykuXG50eXBlIENvbW1hbmRTcGVjID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdOYW1lW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICAvKipcbiAgICog4pqgIE1BWSBSRVRVUk4gQU4gRVhJVCBDT0RFLCBBTkQgRVhBQ1RMWSBPTkUgVkVSQiBET0VTLiBgdGFpbGAgcnVucyB0aGUgc2hhcmVkXG4gICAqIGNsaWVudCAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoaWNoIFJFVFVSTlMgYSBjb2RlIHJhdGhlciB0aGFuXG4gICAqIGVuZGluZyB0aGUgcHJvY2VzcyBmcm9tIGluc2lkZSB0aHJlZSBuZXN0ZWQgbG9vcHMg4oCUIHNvIHRoZSBjb2RlIGhhcyB0byByZWFjaFxuICAgKiBgbWFpbmAsIGFuZCB0aGlzIGlzIHRoZSBzZWFtIGl0IGNyb3NzZXMuIEFueXRoaW5nIHRoYXQgaXMgbm90IGEgbnVtYmVyIG1lYW5zXG4gICAqIDAsIHdoaWNoIGlzIHdoYXQgdGhlIG90aGVyIHR3ZW50eS1vZGQgdmVyYnMgcmV0dXJuLlxuICAgKlxuICAgKiDimqAgVHlwZWQgYHVua25vd25gIHJhdGhlciB0aGFuIGEgdW5pb24gd2l0aCBgdm9pZGA6IGEgdW5pb24gaXMgd2hhdCBhIHJlYWRlclxuICAgKiB3b3VsZCB3cml0ZSBmaXJzdCwgYW5kIGV2ZXJ5IGBhc3luY2AgdmVyYiB0aGF0IGVuZHMgd2l0aG91dCBhIGByZXR1cm5gIGlzXG4gICAqIGBQcm9taXNlPHZvaWQ+YCwgd2hpY2ggaXMgTk9UIGFzc2lnbmFibGUgdG8gYFByb21pc2U8bnVtYmVyIHwgdW5kZWZpbmVkPmAuXG4gICAqIFRoZSB3aWRlbmluZyBoYXBwZW5zIGF0IHRoZSBvbmUgcGxhY2UgdGhhdCByZWFkcyB0aGUgdmFsdWUsIGJlbG93LlxuICAgKi9cbiAgcnVuOiAocG9zaXRpb25hbDogc3RyaW5nW10sIGZsYWdzOiBGbGFncykgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBgdGFpbCAtLXNpbmNlYCB0aHJvdWdoIHRoZSBraXQncyBvbmUgcmVhZGVyIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLFxuICogIGByZWFkU2luY2VgKTogYW4gaWQgb2YgMCBvciBtb3JlOyBhbiBlcG9jaCBib29rbWFyayBwcmludGVkIGJ5IGFub3RoZXJcbiAqICBzcGVsbCdzIGhhbmRvZmYgbGluZSBpcyByZWZ1c2VkIHdpdGggdGhlIGFjY2VwdGVkIGZvcm1zIG5hbWVkLiAqL1xuZnVuY3Rpb24gc2luY2VPckRpZSh0b2tlbjogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgciA9IHJlYWRTaW5jZSh0b2tlbiwgeyBlcG9jaDogZmFsc2UsIG1pbjogMCB9KTtcbiAgLy8gVGhlIGB0YWlsOmAgcHJlZml4IGV2ZXJ5IG90aGVyIGdyYXBldmluZSBmbGFnIHJlZnVzYWwgY2Fycmllcy5cbiAgaWYgKCFyLm9rKSBkaWUoYHRhaWw6ICR7ci5tZXNzYWdlfWAsIFwidXNhZ2VcIik7XG4gIHJldHVybiByLnNpbmNlO1xufVxuXG4vLyBBIGRlY2xhcmVkIHZhbHVlIGZsYWcgdGhhdCBjYXJyaWVzIGEgbnVtYmVyIG11c3QgUkVKRUNUIGEgbm9uLW51bWJlciBhcyBhXG4vLyB1c2FnZSBlcnJvciAoZXhpdCAyKSwgbm90IGNyYXNoIG9uIGl0IGRvd25zdHJlYW0g4oCUIGBzY2hlbWFgIHB1Ymxpc2hlcyB0aGVcbi8vIGZsYWcgYXMgdmFsaWQsIHNvIHRoZSBwYXJzZSBib3VuZGFyeSBpcyB3aGVyZSBhIGJhZCB2YWx1ZSBnZXRzIGl0c1xuLy8gY2FsbGVyLWZhY2luZyBhbnN3ZXIuIChgd2FpdCAtLXRpbWVvdXQgbm90YW51bWJlcmAgdXNlZCB0byB0aHJvdyBhblxuLy8gdW5oYW5kbGVkIFJhbmdlRXJyb3IgYXQgZXhpdCAxLCBzdGFjayB0cmFjZSBhbmQgYWxsLilcbmZ1bmN0aW9uIG51bWVyaWNGbGFnKHZlcmI6IHN0cmluZywgbmFtZTogc3RyaW5nLCByYXc6IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxsYmFjaztcbiAgY29uc3QgbiA9IE51bWJlcihyYXcpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSB8fCBuIDwgMClcbiAgICBkaWUoYCR7dmVyYn06IC0tJHtuYW1lfSBleHBlY3RzIGEgbm9uLW5lZ2F0aXZlIG51bWJlciwgZ290ICR7SlNPTi5zdHJpbmdpZnkoU3RyaW5nKHJhdykpfWApO1xuICByZXR1cm4gbjtcbn1cblxuLy8gQm9keSByZXNvbHV0aW9uIHNoYXJlZCBieSBzZW5kL2Fubm91bmNlIOKAlCBmaXJzdCBtYXRjaCB3aW5zOiAtLWJvZHktZmlsZSxcbi8vIC0tc3RkaW4sIGlubGluZSBwb3NpdGlvbmFscywgZGVmYXVsdC1zdGRpbiB3aGVuIHBpcGVkLiBTZWUgdGhlIHBlci12ZXJiXG4vLyBjb21tZW50cyBhdCB0aGUgb3JpZ2luYWwgc2l0ZXMgKFYxLjYvIzYwKTsgYmVoYXZpb3VyIHVuY2hhbmdlZC5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVCb2R5KFxuICB2ZXJiOiBcInNlbmRcIiB8IFwiYW5ub3VuY2VcIixcbiAgaW5saW5lOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IEZsYWdzLFxuKTogUHJvbWlzZTx7IHRleHQ6IHN0cmluZzsgZnJvbUlubGluZTogYm9vbGVhbiB9PiB7XG4gIGlmIChmbGFnc1tcImJvZHktZmlsZVwiXSkge1xuICAgIGNvbnN0IHBhdGggPSBmbGFnc1tcImJvZHktZmlsZVwiXSBhcyBzdHJpbmc7XG4gICAgY29uc3QgZmlsZSA9IEJ1bi5maWxlKHBhdGgpO1xuICAgIGlmICghKGF3YWl0IGZpbGUuZXhpc3RzKCkpKSBkaWUoYCR7dmVyYn06IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwYXRofWAsIFwibm90X2ZvdW5kXCIpO1xuICAgIHJldHVybiB7IHRleHQ6IChhd2FpdCBmaWxlLnRleHQoKSkucmVwbGFjZSgvXFxuJC8sIFwiXCIpLCBmcm9tSW5saW5lOiBmYWxzZSB9O1xuICB9XG4gIGlmIChmbGFncy5zdGRpbiB8fCAoaW5saW5lLmxlbmd0aCA9PT0gMCAmJiAhcHJvY2Vzcy5zdGRpbi5pc1RUWSkpIHtcbiAgICBjb25zdCBidWY6IEJ1ZmZlcltdID0gW107XG4gICAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBwcm9jZXNzLnN0ZGluKSBidWYucHVzaChjaHVuayBhcyBCdWZmZXIpO1xuICAgIHJldHVybiB7XG4gICAgICB0ZXh0OiBCdWZmZXIuY29uY2F0KGJ1ZikudG9TdHJpbmcoXCJ1dGYtOFwiKS5yZXBsYWNlKC9cXG4kLywgXCJcIiksXG4gICAgICBmcm9tSW5saW5lOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IHRleHQ6IGlubGluZS5qb2luKFwiIFwiKSwgZnJvbUlubGluZTogdHJ1ZSB9O1xufVxuXG4vLyBUaGUgdHdvIGJvZHkgZ3VhcmRzIHNoYXJlZCBieSBzZW5kL2Fubm91bmNlOiByZWZ1c2UgYSBsZWFrZWQgaW52b2NhdGlvblxuLy8gKGZ1bWJsZWQgaGVyZWRvYykgdW5sZXNzIC0tZm9yY2UsIGFuZCB3YXJuIG9uIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIHRoYXRcbi8vIHN1cnZpdmVkIGFuIGlubGluZSBib2R5ICgjNjAg4oCUIHdhcm4sIG5ldmVyIGJsb2NrKS5cbmZ1bmN0aW9uIGd1YXJkQm9keSh2ZXJiOiBcInNlbmRcIiB8IFwiYW5ub3VuY2VcIiwgdGV4dDogc3RyaW5nLCBmcm9tSW5saW5lOiBib29sZWFuLCBmb3JjZTogYm9vbGVhbikge1xuICBpZiAoIWZvcmNlICYmIGxvb2tzTGlrZUxlYWtlZFNlbmQodGV4dCkpIHtcbiAgICBkaWUoXG4gICAgICBgJHt2ZXJifTogdGhhdCBib2R5IGxvb2tzIGxpa2UgYSBsZWFrZWQgZ3JhcGV2aW5lIGludm9jYXRpb24gKGEgZnVtYmxlZCBgICtcbiAgICAgICAgXCJoZXJlZG9jPykuIE5vdGhpbmcgd2FzIHNlbnQuIFBpcGUgdGhlIHJlYWwgYm9keSB2aWEgLS1zdGRpbiBvciBcIiArXG4gICAgICAgIFwiLS1ib2R5LWZpbGUgPHBhdGg+LCBvciBwYXNzIC0tZm9yY2UgdG8gc2VuZCBpdCBhbnl3YXkuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZnJvbUlubGluZSAmJiBsb29rc1NoZWxsUmlza3kodGV4dCkpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIFwiIyDimqAgaW5saW5lIGJvZHkgY29udGFpbnMgc2hlbGwgbWV0YWNoYXJhY3RlcnMgKGJhY2t0aWNrLCAkKCksIGN1cmx5LWJyYWNlIHZhcnMpLiBcIiArXG4gICAgICAgIFwiSXQgd2FzIHNlbnQgYXMtaXMsIGJ1dCB0aGUgc2hlbGwgY2FuIGNvbW1hbmQtc3Vic3RpdHV0ZSB0aGVzZSBiZWZvcmUgXCIgK1xuICAgICAgICBcImdyYXBldmluZSBzZWVzIHRoZW0g4oCUIHVzZSAtLWJvZHktZmlsZSBvciAtLXN0ZGluIGZvciBjb2RlLWJlYXJpbmcgbWVzc2FnZXMuXFxuXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIOKblCBSRUdJU1RFUiBBMSDigJQgYGNob2ljZXNgIElTIGBHTE9CQUxfRkxBR1NgLCBUSEUgU0VUIGByZXNvbHZlQWxpYXNgIFJFQURTLlxuICogVGhpcyBpcyBhIERJU0pVTkNUSU9OIChlaXRoZXIgZmxhZyBzYXRpc2ZpZXMgaXQpLCBzbyB0aGUgY2FsbGVyIGhhcyB0byBwaWNrLFxuICogYW5kIGl0IGlzIHRoZSBvbmUgaWRlbnRpdHkgcmVmdXNhbCBmb3VyIHZlcmJzIHNoYXJlLiBUaGUgZW52IHZhciBzdGF5cyBpblxuICogYGhpbnRgIGFuZCBkZWxpYmVyYXRlbHkgTk9UIGluIGBjaG9pY2VzYDogYGNob2ljZXNgIGVudW1lcmF0ZXMgQ09NTUFORFxuICogVE9LRU5TIOKAlCB3aGF0IHdvdWxkIGhhdmUgYmVlbiBhY2NlcHRlZCBJTiBUSEUgSU5WT0NBVElPTiDigJQgYW5kIHB1dHRpbmcgYW5cbiAqIGVudmlyb25tZW50IG5hbWUgaW4gdGhlIHNhbWUgYXJyYXkgd291bGQgZ2l2ZSBhIGNhbGxlciBhIFwiY2hvaWNlXCIgaXQgY2Fubm90XG4gKiBwYXNzIG9uIHRoZSBjb21tYW5kIGxpbmUuXG4gKi9cbmNvbnN0IGlkZW50aXR5UmVxdWlyZWQgPSAodmVyYjogc3RyaW5nKTogbmV2ZXIgPT5cbiAgZGllKGAke3ZlcmJ9OiBpZGVudGl0eSByZXF1aXJlZGAsIFwidXNhZ2VcIiwge1xuICAgIGhpbnQ6IGBwYXNzICR7R0xPQkFMX0ZMQUdTLm1hcCgoZikgPT4gYC0tJHtmfWApLmpvaW4oXCIvXCIpfSA8YWxpYXM+LCBvciBzZXQgR1JBUEVWSU5FX0ZST01gLFxuICAgIGNob2ljZXM6IEdMT0JBTF9GTEFHUy5tYXAoKGYpID0+IGAtLSR7Zn1gKSxcbiAgfSk7XG5cbi8vIOKaoCBFVkVSWSBDT01NQU5EIEZVTkNUSU9OIEJFTE9XIFJFRlVTRVMgQSBNSVNTSU5HIFBPU0lUSU9OQUwgT04gSVRTIE9XTiBGSVJTVFxuLy8gTElORSAoYSB1c2FnZSByZWZ1c2FsIHdoZW4gdGhlIG5hbWUgaXMgZmFsc3kpLCBhbmQgZWFjaCBub3cgZGVjbGFyZXMgdGhhdCBwYXJhbWV0ZXJcbi8vIGBzdHJpbmcgfCB1bmRlZmluZWRgIHNvIGl0cyBzaWduYXR1cmUgc2F5cyB3aGF0IHRoYXQgbGluZSBkb2VzICh0eXBlLWRlYnRcbi8vIFQzNSkuIEFyaXR5IGRpc3BhdGNoIHJlZnVzZXMgYSBtaXNzaW5nIHJlcXVpcmVkIHBvc2l0aW9uYWwgYmVmb3JlIGFueSBvZlxuLy8gdGhlbSBydW5zLCBzbyB0aGUgZ3VhcmRzIGFyZSB0aGUgc2Vjb25kIGxpbmUgb2YgZGVmZW5jZSwgbm90IHRoZSBmaXJzdC5cbmNvbnN0IENPTU1BTkRTOiBDb21tYW5kU3BlY1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcInRvcGljXCIsIFwiZnJlc2hcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kT3Blbihwb3NpdGlvbmFsWzBdLCB7XG4gICAgICAgIHRvcGljOiBmbGFncy50b3BpYyBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICAgIGZyb206IHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICAgIGZyZXNoOiBmbGFncy5mcmVzaCA9PT0gdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRvcGljXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRvcGljKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICBwb3NpdGlvbmFsLmxlbmd0aCA+IDEgPyBwb3NpdGlvbmFsLnNsaWNlKDEpLmpvaW4oXCIgXCIpIDogdW5kZWZpbmVkLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJsaXN0XCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZExpc3QoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZW5kXCIsXG4gICAgZmxhZ3M6IFtcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwicXVpZXRcIiwgXCJ2ZXJib3NlXCIsIFwiZm9yY2VcIiwgXCJpbi1yZXBseS10b1wiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBuYW1lID0gcG9zaXRpb25hbFswXTtcbiAgICAgIGNvbnN0IGZyb20gPSByZXNvbHZlQWxpYXMoZmxhZ3MpO1xuICAgICAgY29uc3QgeyB0ZXh0LCBmcm9tSW5saW5lIH0gPSBhd2FpdCByZXNvbHZlQm9keShcInNlbmRcIiwgcG9zaXRpb25hbC5zbGljZSgxKSwgZmxhZ3MpO1xuICAgICAgaWYgKCFmcm9tKSBpZGVudGl0eVJlcXVpcmVkKFwic2VuZFwiKTtcbiAgICAgIGd1YXJkQm9keShcInNlbmRcIiwgdGV4dCwgZnJvbUlubGluZSwgISFmbGFncy5mb3JjZSk7XG4gICAgICBhd2FpdCBjbWRTZW5kKG5hbWUsIGZyb20gYXMgc3RyaW5nLCB0ZXh0LCB7XG4gICAgICAgIHF1aWV0OiAhIWZsYWdzLnF1aWV0LFxuICAgICAgICB2ZXJib3NlOiAhIWZsYWdzLnZlcmJvc2UsXG4gICAgICAgIGluUmVwbHlUbzogZmxhZ3NbXCJpbi1yZXBseS10b1wiXVxuICAgICAgICAgID8gbnVtZXJpY0ZsYWcoXCJzZW5kXCIsIFwiaW4tcmVwbHktdG9cIiwgZmxhZ3NbXCJpbi1yZXBseS10b1wiXSwgMClcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFubm91bmNlXCIsXG4gICAgZmxhZ3M6IFtcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwicXVpZXRcIiwgXCJmb3JjZVwiLCBcImNoYW5uZWxzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHJlc29sdmVBbGlhcyhmbGFncyk7XG4gICAgICBjb25zdCB7IHRleHQsIGZyb21JbmxpbmUgfSA9IGF3YWl0IHJlc29sdmVCb2R5KFwiYW5ub3VuY2VcIiwgcG9zaXRpb25hbCwgZmxhZ3MpO1xuICAgICAgaWYgKCFmcm9tKSBpZGVudGl0eVJlcXVpcmVkKFwiYW5ub3VuY2VcIik7XG4gICAgICBndWFyZEJvZHkoXCJhbm5vdW5jZVwiLCB0ZXh0LCBmcm9tSW5saW5lLCAhIWZsYWdzLmZvcmNlKTtcbiAgICAgIGNvbnN0IGNoYW5uZWxzID0gZmxhZ3MuY2hhbm5lbHNcbiAgICAgICAgPyAoZmxhZ3MuY2hhbm5lbHMgYXMgc3RyaW5nKVxuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgoYykgPT4gYy50cmltKCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgYXdhaXQgY21kQW5ub3VuY2UoZnJvbSBhcyBzdHJpbmcsIHRleHQsIGNoYW5uZWxzLCB7IHF1aWV0OiAhIWZsYWdzLnF1aWV0IH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInB1bGxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJzdGF0dXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3Qgc2luY2UgPSBudW1lcmljRmxhZyhcInB1bGxcIiwgXCJzaW5jZVwiLCBmbGFncy5zaW5jZSwgMCk7XG4gICAgICBhd2FpdCBjbWRQdWxsKHBvc2l0aW9uYWxbMF0sIHNpbmNlLCB7IHN0YXR1czogZmxhZ3Muc3RhdHVzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0cmlhZ2VcIixcbiAgICBmbGFnczogW1wiaHVtYW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kVHJpYWdlKHBvc2l0aW9uYWxbMF0sIHsgaHVtYW46ICEhZmxhZ3MuaHVtYW4gfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhZFwiLFxuICAgIGZsYWdzOiBbXCJ0ZXh0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgaWQgPSBwb3NpdGlvbmFsWzFdID8gcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApIDogTmFOO1xuICAgICAgYXdhaXQgY21kUmVhZChwb3NpdGlvbmFsWzBdLCBpZCwgeyB0ZXh0OiAhIWZsYWdzLnRleHQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2FpdFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcInRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3Qgc2luY2UgPSBudW1lcmljRmxhZyhcIndhaXRcIiwgXCJzaW5jZVwiLCBmbGFncy5zaW5jZSwgMCk7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gbnVtZXJpY0ZsYWcoXCJ3YWl0XCIsIFwidGltZW91dFwiLCBmbGFncy50aW1lb3V0LCAzMCk7XG4gICAgICBhd2FpdCBjbWRXYWl0KHBvc2l0aW9uYWxbMF0sIHNpbmNlLCB0aW1lb3V0LCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3aG9cIixcbiAgICBmbGFnczogW1wiYWxsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBpZiAoZmxhZ3MuYWxsKSBhd2FpdCBjbWRXaG9BbGwoKTtcbiAgICAgIGVsc2UgYXdhaXQgY21kV2hvKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFsaWFzXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFsaWFzKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJmcm9tLXN0YXJ0XCIsIFwibGFzdFwiLCBcImh1bWFuXCIsIFwibHVya1wiLCBcIm1heFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICByZXR1cm4gYXdhaXQgY21kVGFpbChwb3NpdGlvbmFsWzBdLCB7XG4gICAgICAgIHNpbmNlOiBmbGFncy5zaW5jZSAhPT0gdW5kZWZpbmVkID8gc2luY2VPckRpZShTdHJpbmcoZmxhZ3Muc2luY2UpKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbVN0YXJ0OiAhIWZsYWdzW1wiZnJvbS1zdGFydFwiXSxcbiAgICAgICAgbGFzdDogZmxhZ3MubGFzdCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJ0YWlsXCIsIFwibGFzdFwiLCBmbGFncy5sYXN0LCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgYXM6IHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICAgIGh1bWFuOiAhIWZsYWdzLmh1bWFuLFxuICAgICAgICBsdXJrOiAhIWZsYWdzLmx1cmssXG4gICAgICAgIG1heDogcmVzb2x2ZVRhaWxNYXgoZmxhZ3MubWF4KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdyZXBcIixcbiAgICBmbGFnczogW1wibGl0ZXJhbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJwYXR0ZXJuXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEdyZXAocG9zaXRpb25hbFswXSwgcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSwge1xuICAgICAgICBsaXRlcmFsOiAhIWZsYWdzLmxpdGVyYWwsXG4gICAgICAgIGZyb206IGZsYWdzLmZyb20gYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiY2xvc2VcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRDbG9zZShwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXNldFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZXNldChwb3NpdGlvbmFsWzBdLCB7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtYXJrXCIsXG4gICAgZmxhZ3M6IFtcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJkaXNwb3NpdGlvblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRNYXJrKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICAvLyBOYU4gZm9yIGEgbWlzc2luZyBpZCwgZXhhY3RseSB3aGF0IGBwYXJzZUludCh1bmRlZmluZWQpYCBnYXZlIOKAlCBhbmRcbiAgICAgICAgLy8gYGNtZE1hcmtgIHJlZnVzZXMgYSBub24tZmluaXRlIGlkIG9uIGl0cyBmaXJzdCBsaW5lLlxuICAgICAgICBwb3NpdGlvbmFsWzFdID09PSB1bmRlZmluZWQgPyBOdW1iZXIuTmFOIDogcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBwb3NpdGlvbmFsLnNsaWNlKDIpLmpvaW4oXCIgXCIpLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJtYXJrXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlb3BlblwiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgLy8gTmFOIGZvciBhIG1pc3NpbmcgaWQsIGV4YWN0bHkgd2hhdCBgcGFyc2VJbnQodW5kZWZpbmVkKWAgZ2F2ZSDigJQgYW5kXG4gICAgICAgIC8vIGBjbWRNYXJrYCByZWZ1c2VzIGEgbm9uLWZpbml0ZSBpZCBvbiBpdHMgZmlyc3QgbGluZS5cbiAgICAgICAgcG9zaXRpb25hbFsxXSA9PT0gdW5kZWZpbmVkID8gTnVtYmVyLk5hTiA6IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSxcbiAgICAgICAgXCJvcGVuXCIsXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncykgPz8gaWRlbnRpdHlSZXF1aXJlZChcInJlb3BlblwiKSxcbiAgICAgICAgeyBub3RlOiBmbGFncy5ub3RlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9LFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFyY2hpdmUocG9zaXRpb25hbFswXSwgZmFsc2UsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInVuYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBcmNoaXZlKHBvc2l0aW9uYWxbMF0sIHRydWUsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXJ0XCIsXG4gICAgYWxpYXNlczogW1widXBcIl0sXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZFN0YXJ0KCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzdGFydFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcInllc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZXN0YXJ0KHsgZm9yY2U6ICEhZmxhZ3MuZm9yY2UgfHwgISFmbGFncy55ZXMgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicm9sbFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcInllc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSb2xsKHsgZm9yY2U6IGZsYWdzLmZvcmNlID09PSB0cnVlIHx8IGZsYWdzLnllcyA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdG9wXCIsXG4gICAgZmxhZ3M6IFtcImhvbGRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kU3RvcCh7XG4gICAgICAgIGhvbGRTZWNvbmRzOlxuICAgICAgICAgIGZsYWdzLmhvbGQgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwic3RvcFwiLCBcImhvbGRcIiwgZmxhZ3MuaG9sZCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3YXRjaFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRXYXRjaChwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZWFwXCIsXG4gICAgYWxpYXNlczogW1wicHJ1bmVcIl0sXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwiZHJ5LXJ1blwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZWFwKHsgZm9yY2U6IGZsYWdzLmZvcmNlID09PSB0cnVlLCBkcnlSdW46IGZsYWdzW1wiZHJ5LXJ1blwiXSA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbmZvXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZEluZm8oKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2N0b3JcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kRG9jdG9yKCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgIGZsYWdzOiBbXCJodW1hblwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICAvLyBUaGUgQ0xJIGNhbiBiZSBBU0tFRCB3aGF0IGl0IGlzLiBncmFwZXZpbmUgYWxyZWFkeSBjYXJyaWVzXG4gICAgICAvLyBQTFVHSU5fVkVSU0lPTiB0byB3YXJuIHRoYXQgYSBkYWVtb24gaXMgZnJvbSBhIGRpZmZlcmVudCBjYWNoZWQgcGx1Z2luXG4gICAgICAvLyBwYXRoIHRoYW4gdGhpcyBDTEkgKG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKSDigJQgYnV0IGEgY2FsbGVyIHRoYXQgaGl0XG4gICAgICAvLyB0aGF0IHdhcm5pbmcsIG9yIHRoYXQgcnVucyBgcm9sbGAgZm9yIGl0cyB2ZXJzaW9uIHZlcmlmeSwgaGFkIG5vIHdheSB0b1xuICAgICAgLy8gYXNrIHRoaXMgc2lkZSB3aGF0IGl0IGlzIGhvbGRpbmcuIFRoZSB2YWx1ZSB3YXMgYWxyZWFkeSBpbiBtZW1vcnk7IG9ubHlcbiAgICAgIC8vIHRoZSBxdWVzdGlvbiB3YXMgbWlzc2luZy5cbiAgICAgIC8vIEpTT04gYnkgZGVmYXVsdCwgbWF0Y2hpbmcgZXZlcnkgZGF0YSBjb21tYW5kOyAtLWh1bWFuIGZvciBwcm9zZS5cbiAgICAgIGlmIChQTFVHSU5fVkVSU0lPTiA9PT0gbnVsbClcbiAgICAgICAgZGllKFwidmVyc2lvbiB1bmF2YWlsYWJsZSDigJQgY291bGQgbm90IHJlYWQgcGx1Z2luLmpzb25cIiwgXCJpbnRlcm5hbFwiKTtcbiAgICAgIGlmIChmbGFncy5odW1hbiA9PT0gdHJ1ZSkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYGdyYXBldmluZSB2JHtQTFVHSU5fVkVSU0lPTn1cXG5gKTtcbiAgICAgIGVsc2UgcHJpbnRKc29uKHsgbmFtZTogXCJncmFwZXZpbmVcIiwgdmVyc2lvbjogUExVR0lOX1ZFUlNJT04gfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46ICgpID0+IHtcbiAgICAgIC8vIEVtaXQgdGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSBkZXNjcmlwdGlvbiDigJQgZ2VuZXJhdGVkIGJ5XG4gICAgICAvLyBXQUxLSU5HIENPTU1BTkRTIGFuZCBDTElfT1BUSU9OUywgdGhlIHNhbWUgc3RydWN0dXJlcyB0aGUgcGFyc2VyIGFuZFxuICAgICAgLy8gZGlzcGF0Y2hlciBjb25zdW1lLCBhdCBhbnN3ZXIgdGltZS4gTm8gZGFlbW9uLCBubyBjb25maWcsIG5vXG4gICAgICAvLyBjcmVkZW50aWFsczsgc3Rkb3V0LCBleGl0IDAuIFRoZSBzaGFwZSBpcyBhY2MgZGVjbGFyYXRpb24gZm9ybWF0IHYwXG4gICAgICAvLyBleGFjdGx5LCBzbyB0aGUgb3V0cHV0IHBpcGVzIHN0cmFpZ2h0IGludG9cbiAgICAgIC8vIGBhY2MgY2hlY2sgPGNsaT4gLS1kZWNsYXJhdGlvbiA8KGdyYXBldmluZSBzY2hlbWEpYCB3aXRoIG5vIGFkYXB0ZXIuXG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShidWlsZERlY2xhcmF0aW9uKCksIG51bGwsIDIpfVxcbmApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhlbHBcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJpbnRIZWxwKCk7XG4gICAgfSxcbiAgfSxcbl07XG5cbmZ1bmN0aW9uIGZpbmRDb21tYW5kKHRva2VuOiBzdHJpbmcpOiBDb21tYW5kU3BlYyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBDT01NQU5EUy5maW5kKChjKSA9PiBjLm5hbWUgPT09IHRva2VuIHx8IGMuYWxpYXNlcz8uaW5jbHVkZXModG9rZW4pKTtcbn1cblxuLy8gVGhlIHZlcmIncyBmdWxsIGFjY2VwdGVkIHNldDogaXRzIG93biBmbGFncyBwbHVzIHRoZSBjb250cmFjdHVhbGx5LWdsb2JhbFxuLy8gaWRlbnRpdHkgcGFpciwgaW4gcmVnaXN0cnkgb3JkZXIuXG5mdW5jdGlvbiBhY2NlcHRlZEZsYWdzKHNwZWM6IENvbW1hbmRTcGVjKTogRmxhZ05hbWVbXSB7XG4gIGNvbnN0IG93biA9IG5ldyBTZXQ8RmxhZ05hbWU+KFsuLi5HTE9CQUxfRkxBR1MsIC4uLnNwZWMuZmxhZ3NdKTtcbiAgcmV0dXJuIChPYmplY3Qua2V5cyhDTElfT1BUSU9OUykgYXMgRmxhZ05hbWVbXSkuZmlsdGVyKChrKSA9PiBvd24uaGFzKGspKTtcbn1cblxuLy8gUm9vdCBpbnRlcmNlcHRvcnMg4oCUIGZsYWdzIHRoZSBST09UIGFuc3dlcnMgaXRzZWxmLCBiZWZvcmUgYW55IHZlcmIuIFRoZXNlIGFyZVxuLy8gbm90IGNvbW1hbmRzLCB3aGljaCBpcyBleGFjdGx5IHdoeSBhIGdlbmVyYXRvciB3YWxraW5nIFwidGhlIGNvbW1hbmRzXCIgd2Fsa3Ncbi8vIHBhc3QgdGhlbSAoYWNjIERULTYpOyB0aGV5IGFyZSBkZWNsYXJlZCBleHBsaWNpdGx5IGF0IGBwYXRoOiBbXWAuXG5jb25zdCBST09UX0lOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbi8vIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjAgKHNlZSBhZ2VudC1jbGktY29uZm9ybWFuY2Ugc3JjL2FjYy9raXQvZGVjbGFyYXRpb24udHMpOlxuLy8geyBmb3JtYXRWZXJzaW9uLCBwcm92ZW5hbmNlLCBzZWxmRGVzY3JpcHRpb24sIGNvbW1hbmRzOiBbeyBwYXRoLCBhcmdzLCBwb3NpdGlvbmFscyB9XSB9LlxuLy8gdjAgcmVmdXNlcyB1bmtub3duIGtleXMsIHNvIG5vdGhpbmcgcmljaGVyIChlZmZlY3RzLCBzdW1tYXJpZXMsIHZlcnNpb25zKVxuLy8gcmlkZXMgYWxvbmcg4oCUIHRob3NlIHdhaXQgZm9yIGEgdjEgd2l0aCBzbG90cyBmb3IgdGhlbS5cbmZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIC8vIEV2ZXJ5IHJlZ2lzdHJ5IGZsYWcgaXMgYWNjZXB0ZWQgdG9kYXk7IGEgcmVmdXNhbCBsaXN0IHdvdWxkIGFkZFxuICAvLyBzdGF0dXM6IFwicmVmdXNlZFwiIGVudHJpZXMgaGVyZSB0aGUgZGF5IGEgdmVyYiByZWNvZ25pc2VzLWFuZC1kZWNsaW5lcyBvbmUuXG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnTmFtZSkgPT4gKHtcbiAgICBuYW1lOiBgLS0ke2t9YCxcbiAgICB0eXBlOiBDTElfT1BUSU9OU1trXS50eXBlLFxuICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICB9KTtcbiAgY29uc3QgY29tbWFuZHM6IHtcbiAgICBwYXRoOiBzdHJpbmdbXTtcbiAgICBhcmdzOiB7IG5hbWU6IHN0cmluZzsgdHlwZTogXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiOyBzdGF0dXM6IHN0cmluZyB9W107XG4gICAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIH1bXSA9IFtcbiAgICB7XG4gICAgICAvLyBgcGF0aDogW11gIElTIHRoZSByb290LiBJdHMgZ3JhbW1hcjogb25lIHJlcXVpcmVkIHRva2VuIHNlbGVjdGluZyBhXG4gICAgICAvLyBjb21tYW5kLCBvciBhbiBpbnRlcmNlcHRvciBmbGFnIHRoZSByb290IGFuc3dlcnMgaXRzZWxmLlxuICAgICAgcGF0aDogW10sXG4gICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgIG5hbWU6IGkubmFtZSxcbiAgICAgICAgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsXG4gICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgfSkpLFxuICAgICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiY29tbWFuZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IHNwZWMgb2YgQ09NTUFORFMpIHtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgW3NwZWMubmFtZSwgLi4uKHNwZWMuYWxpYXNlcyA/PyBbXSldKSB7XG4gICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgcGF0aDogW25hbWVdLFxuICAgICAgICBhcmdzOiBhY2NlcHRlZEZsYWdzKHNwZWMpLm1hcCgoaykgPT4gYXJnKGspKSxcbiAgICAgICAgcG9zaXRpb25hbHM6IHNwZWMucG9zaXRpb25hbHMsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW1wic2NoZW1hXCJdIH0sXG4gICAgY29tbWFuZHMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlRmxhZ3MoXG4gIGFyZ3Y6IHN0cmluZ1tdLFxuICBzcGVjOiBDb21tYW5kU3BlYyxcbik6IHtcbiAgcG9zaXRpb25hbDogc3RyaW5nW107XG4gIGZsYWdzOiBGbGFncztcbn0ge1xuICBjb25zdCBhY2NlcHRlZCA9IGFjY2VwdGVkRmxhZ3Moc3BlYyk7XG4gIGNvbnN0IG9wdGlvbnMgPSBPYmplY3QuZnJvbUVudHJpZXMoYWNjZXB0ZWQubWFwKChrKSA9PiBbaywgQ0xJX09QVElPTlNba11dKSk7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IGFyZ3YsXG4gICAgICBvcHRpb25zLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgcG9zaXRpb25hbDogcG9zaXRpb25hbHMsXG4gICAgICBmbGFnczogdmFsdWVzIGFzIEZsYWdzLFxuICAgIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBkZXRhaWwgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgY29uc3QgYm9keUhpbnQgPVxuICAgICAgc3BlYy5uYW1lID09PSBcInNlbmRcIiB8fCBzcGVjLm5hbWUgPT09IFwiYW5ub3VuY2VcIlxuICAgICAgICA/IFwiZm9yIGEgbWVzc2FnZSBib2R5IGNvbnRhaW5pbmcgZGFzaGVzLCB1c2UgLS1zdGRpbiBvciAtLWJvZHktZmlsZSwgXCIgK1xuICAgICAgICAgIFwib3IgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLVwiXG4gICAgICAgIDogXCJcIjtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihgJHtzcGVjLm5hbWV9OiAke2RldGFpbH1gLCB7XG4gICAgICAvLyDim5QgVEhFIFNFVCBJUyBgY2hvaWNlc2AgTk9XLCBOT1QgQSBQUk9TRSBNQVJLRVIuIEl0IHVzZWQgdG8gYmUgYSBzZWNvbmRcbiAgICAgIC8vIGxpbmUgcmVhZGluZyBgcmVjb2duaXplZCBmbGFnczogLS1hIC0tYmAsIHNwZWxsZWQgd2l0aCB0aGUgY29sb25cbiAgICAgIC8vIHN0cmFpZ2h0IGFmdGVyIHRoZSBub3VuIGJlY2F1c2UgdGhhdCBpcyB0aGUgbWFya2VyIHNoYXBlIGEgZmxhZy1zZXRcbiAgICAgIC8vIGV4dHJhY3RvciBtYXRjaGVzLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBTkQgTk9UIEJFQ0FVU0UgVEhFIE1BUktFUiBXT1VMRCBIQVZFIFNUT1BQRUQgV09SS0lORyDigJQgdGhhdCByZWFzb25cbiAgICAgIC8vIHdhcyB3cml0dGVuIGhlcmUgYW5kIGluIEQ3MSwgYW5kIGl0IGlzIEZBTFNFLiBhY2MgcGFyc2VzIHRoZSB3aG9sZVxuICAgICAgLy8gZW52ZWxvcGUsIHRoZW4gd2Fsa3MgYHN0cmluZ1ZhbHVlc09mKGRvY3VtZW50KWAgYW5kIHJ1bnMgdGhlIFNBTUUgcHJvc2VcbiAgICAgIC8vIE1BUktFUiByZWdleCBvdmVyIGV2ZXJ5IHN0cmluZyBpbnNpZGUgaXQsIGZvciBleGFjdGx5IHRoaXMgY2FzZVxuICAgICAgLy8gKGBhZ2VudC1jbGktY29uZm9ybWFuY2Uvc3JjL2FjYy9raXQvc3VyZmFjZS50czo2NTMtNjU2YCwgd2hvc2UgZG9jXG4gICAgICAvLyBjb21tZW50IG5hbWVzIGFudGhpbGwncyBgXCJWYWxpZCBmbGFnczogLS1mb3JtYXRcImAgaW5zaWRlIGFuIGBlcnJvcmBcbiAgICAgIC8vIHN0cmluZykuIEEgbWFya2VyIGVtYmVkZGVkIGluIHRoZSBlbnZlbG9wZSB3b3VsZCBzdGlsbCBoYXZlIGJlZW4gcmVhZC5cbiAgICAgIC8vXG4gICAgICAvLyBUaGUgbW92ZSBpcyByaWdodCBmb3IgcmVhc29ucyB0aGF0IHN1cnZpdmUgdGhhdCBjb3JyZWN0aW9uOiBgY2hvaWNlc2AgaXNcbiAgICAgIC8vIHRoZSBlbnZlbG9wZSdzIG93biBmaWVsZCBmb3IgdGhlIGFjY2VwdGVkIHNldCwgaXQgaXMgd2hhdCBnbGFtb3VyXG4gICAgICAvLyBwdWJsaXNoZXMgYXQgQ09ORk9STUFOVCBMMCwgYW4gQVJSQVkgY2Fubm90IGJlIHRydW5jYXRlZCBieSBhIHJlYWRlclxuICAgICAgLy8gdGhhdCBzdG9wcyBhdCB0aGUgZmlyc3QgdG9rZW4gd2hpY2ggaXMgbm90IGEgYC0tbG9uZ2AgZmxhZywgYW5kIG9uZVxuICAgICAgLy8gc3BlbGxpbmcgb2Ygb25lIHNldCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgb3RoZXIuXG4gICAgICBjaG9pY2VzOiBhY2NlcHRlZC5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICAgIC4uLihib2R5SGludCA/IHsgaGludDogYm9keUhpbnQgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb21tYW5kVG9rZW5zKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIENPTU1BTkRTLmZsYXRNYXAoKGMpID0+IFtjLm5hbWUsIC4uLihjLmFsaWFzZXMgPz8gW10pXSk7XG59XG5cbmZ1bmN0aW9uIHByaW50SGVscCgpIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYGdyYXBldmluZSDigJQgYWdlbnQtdG8tYWdlbnQgd2Fsa2llLXRhbGtpZVxuXG5Vc2FnZTpcbiAgZ3JhcGV2aW5lIG9wZW4gPG5hbWU+IFstLXRvcGljIDx0ZXh0Pl0gWy0tZnJlc2hdICAgb3Blbi9jcmVhdGUgKGF1dG8tdW5hcmNoaXZlczsgLS1mcmVzaCBjbGVhcnMgYSBkb3JtYW50IGNoYW5uZWwpXG4gIGdyYXBldmluZSBsaXN0XG4gIGdyYXBldmluZSBzZW5kIDxuYW1lPiBbLS1mcm9tLy0tYXMgPGFsaWFzPl0gWy0tcXVpZXRdIFstLXZlcmJvc2VdIFstLXN0ZGluXSBbLS1ib2R5LWZpbGUgPHBhdGg+XSBbLS1mb3JjZV0gWy0taW4tcmVwbHktdG8gPGlkPl0gWzx0ZXh0Li4uPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgYm9keTogaW5saW5lIHRleHQsIC0tc3RkaW4sIC0tYm9keS1maWxlLCBvciBwaXBlZCBzdGRpbiAoZGVmYXVsdCB3aGVuIG5vIGlubGluZSB0ZXh0KVxuICBncmFwZXZpbmUgYW5ub3VuY2UgWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLWNoYW5uZWxzIGEsYixjXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tcXVpZXRdIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJyb2FkY2FzdCBvbmUgbWVzc2FnZSB0byBldmVyeSBhY3RpdmUgY2hhbm5lbCAob3IgLS1jaGFubmVscylcbiAgZ3JhcGV2aW5lIHRhaWwgPG5hbWU+IFstLWFzLy0tZnJvbSA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjICR7V0lORE9XX0hFTFB9ICgtLWh1bWFuIG5ldmVyIGVuZHMgYnkgaXRzZWxmKVxuICAgICAgICMgLS1sYXN0IDxuPjogYmFja2ZpbGwgdGhlIG1vc3QgcmVjZW50IG4gbWVzc2FnZXMgdGhlbiBnbyBsaXZlIChib3VuZGVkIGNhdGNoLXVwIGZvciBhIGNvbGQgam9pbmVyKVxuICBncmFwZXZpbmUgcHVsbCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tc3RhdHVzIDx2YWx1ZT5dICAgIyAtLXN0YXR1cyA9IGZ1bGwtc2NhbiBmaWx0ZXIgKG9wZW58d29udGZpeHxpbmNvcnBvcmF0ZWR84oCmKVxuICBncmFwZXZpbmUgdHJpYWdlIDxuYW1lPiAgICAgICAgICAgICAjIGZ1bGwtc2Nhbjogb3BlbiBtZXNzYWdlcyBvbiB0b3AgKyBncm91cGVkIGJ5X3N0YXR1c1xuICBncmFwZXZpbmUgbWFyayA8bmFtZT4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSAgIyBzZXQgZGlzcG9zaXRpb24gKGluY29ycG9yYXRlZHx3b250Zml4fGRlZmVycmVkfOKApilcbiAgZ3JhcGV2aW5lIHJlb3BlbiA8bmFtZT4gPGlkPiAgICAgICAgIyBib3VuY2UgYSBtZXNzYWdlIGJhY2sgdG8gb3BlblxuICBncmFwZXZpbmUgcmVhZCA8bmFtZT4gPGlkPiBbLS10ZXh0XSAgICMgb25lIGZ1bGwgbWVzc2FnZSBieSBpZCAoLS10ZXh0ID0gcHJvc2UpXG4gIGdyYXBldmluZSB3YWl0IDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS10aW1lb3V0IDxzPl1cbiAgZ3JhcGV2aW5lIGdyZXAgPG5hbWU+IDxwYXR0ZXJuPiBbLS1saXRlcmFsXSBbLS1mcm9tIDxhbGlhcz5dXG4gIGdyYXBldmluZSB0b3BpYyA8bmFtZT4gWzx0ZXh0Pl0gICAjIG5vIHRleHQg4oaSIHJlYWQgY3VycmVudDsgd2l0aCB0ZXh0IOKGkiB1cGRhdGVcbiAgZ3JhcGV2aW5lIHdobyA8bmFtZT4gICAgICAgICAgICAgICMgcm9zdGVyOyB0aGUgaHVtYW5zIGZpZWxkIGxpc3RzIGh1bWFuc1xuICBncmFwZXZpbmUgYWxpYXMgWzxuYW1lPl0gICAgICAgICAgIyBzZXQvc2hvdyB5b3VyIHBlcnNpc3RlZCBhbGlhcyAoY29uZmlnLmpzb24pXG4gIGdyYXBldmluZSB3YXRjaCBbPG5hbWU+XSAgICAgICAgICAjIG9wZW4gYnJvd3NlciB0YWI7IGxpdmUgY2hhdC1idWJibGUgdmlld1xuICBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXSAgICAgICAgICAgc25hcHNob3QgdGhlIGxvZyDihpIgfi8uZ3JhcGV2aW5lL2FyY2hpdmUsIHRoZW4gY2xlYXIgaXRcbiAgZ3JhcGV2aW5lIGFyY2hpdmUgPG5hbWU+ICAgICAgICAgICMgcmVhZC1vbmx5OiBrZWVwIGhpc3RvcnksIHJlamVjdCBzZW5kc1xuICBncmFwZXZpbmUgdW5hcmNoaXZlIDxuYW1lPiAgICAgICAgIyBicmluZyBhbiBhcmNoaXZlZCBjaGFubmVsIGJhY2tcbiAgZ3JhcGV2aW5lIGNsb3NlIDxuYW1lPiAgICAgICAgICAgICMgZGVzdHJ1Y3RpdmU6IGRlbGV0ZSB0aGUgbWVzc2FnZSBsb2dcbiAgZ3JhcGV2aW5lIHN0YXJ0ICAgICAgICAgICAgICAgICAgICMgZW5zdXJlIHRoZSBkYWVtb24gaXMgcnVubmluZyAoYWxpYXM6IHVwKTsgbm8gY2hhbm5lbFxuICBncmFwZXZpbmUgcmVzdGFydCBbLS1mb3JjZXwtLXllc10gIyBzdG9wICsgcmVzcGF3biBmcmVzaDsgLS1mb3JjZSB0byBvdmVycmlkZSB0aGUgbGl2ZS1mbGVldCBndWFyZFxuICBncmFwZXZpbmUgcm9sbCBbLS1mb3JjZV0gICAgICAgICAgIyBzYWZlIHJlc3RhcnQgKHN0b3AraG9sZCtyZXNwYXduKSArIHZlcnNpb24gdmVyaWZ5IOKAlCB0aGUgcmVjb21tZW5kZWQgZGVwbG95IHN0ZXBcbiAgZ3JhcGV2aW5lIHN0b3AgWy0taG9sZCA8c2Vjb25kcz5dICMga2lsbCB0aGUgZGFlbW9uOyAtLWhvbGQgc3VwcHJlc3NlcyBhdXRvLXJlc3Bhd24gZm9yIDxzPiBzZWNvbmRzICh1cGdyYWRlIHdpbmRvdylcbiAgZ3JhcGV2aW5lIGluZm9cbiAgZ3JhcGV2aW5lIGRvY3RvciAgICAgICAgICAgICAgICAgICMgaGVhbHRoIGNoZWNrIOKAlCBsYWJlbHMgZWFjaCBkYWVtb246IGF1dGhvcml0YXRpdmUgLyBvcnBoYW4gLyB1bnJlc3BvbnNpdmUgLyB1bmtub3duXG4gIGdyYXBldmluZSByZWFwIFstLWZvcmNlXSBbLS1kcnktcnVuXSAgIyBraWxsIG9ycGhhbiBkYWVtb25zOyAtLWZvcmNlIGFsc28ga2lsbHMgdW5yZXNwb25zaXZlOyBhbGlhczogcHJ1bmVcblxuICBncmFwZXZpbmUgc2NoZW1hICAgICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIChhY2MgZGVjbGFyYXRpb24gdjApXG4gIGdyYXBldmluZSAtLXZlcnNpb24gICAgICAgICAgICAgICAjIHRoaXMgQ0xJJ3MgdmVyc2lvbiAoYWxpYXM6IC1WLCB2ZXJzaW9uKVxuICBncmFwZXZpbmUgaGVscCAgICAgICAgICAgICAgICAgICAgIyB0aGlzIHVzYWdlIChhbGlhczogLS1oZWxwLCAtaClcblxuT3V0cHV0OlxuICBEYXRhIGNvbW1hbmRzIGVtaXQgSlNPTiBvbiBzdGRvdXQgYnkgREVGQVVMVDsgcGFzcyAtLWh1bWFuIGZvciBwcm9zZSB3aGVyZSBhXG4gIGNvbW1hbmQgb2ZmZXJzIGl0LiBEaWFnbm9zdGljcyBhbmQgd2FybmluZ3MgZ28gdG8gc3RkZXJyLCBuZXZlciBzdGRvdXQuXG4gIFVzYWdlIGVycm9ycyBleGl0IDIuIEVhY2ggY29tbWFuZCBhY2NlcHRzIGl0cyBPV04gZmxhZ3MgKHBsdXMgLS1hcy8tLWZyb20sXG4gIHdoaWNoIGFyZSBnbG9iYWwpIOKAlCBhbiB1bmtub3duIGZsYWcgZm9yIGEgdmVyYiBlbnVtZXJhdGVzIHRoYXQgdmVyYidzIHNldC5cblxuRW52OlxuICBHUkFQRVZJTkVfRlJPTSAgIERlZmF1bHQgaWRlbnRpdHkgYWxpYXMgKC0tZnJvbS8tLWFzIGFyZSBpbnRlcmNoYW5nZWFibGUpLlxuICBHUkFQRVZJTkVfSE9NRSAgIERhdGEgZGlyIChkZWZhdWx0IH4vLmdyYXBldmluZSkuXG5gKTtcbn1cblxuLyoqXG4gKiBUaGUgdmVyYiByb3V0ZXIuIEV2ZXJ5IHJlamVjdGlvbiBoZXJlIFJBSVNFUzsgbm90aGluZyB3cml0ZXMgaXRzIG93biBwcm9zZS5cbiAqXG4gKiDim5QgVEhJUyBGVU5DVElPTiBVU0VEIFRPIEJFIGBtYWluYCwgQU5EIElUUyBGT1VSIFJFSkVDVElPTlMgVVNFRCBUTyBCRVxuICogYHByb2Nlc3Muc3RkZXJyLndyaXRlKC4uLik7IHJldHVybiAyYCDigJQgYSBTRUNPTkQgZXJyb3IgY29udHJhY3QgYmVzaWRlIGBkaWVgLFxuICogd2l0aCBpdHMgb3duIHdvcmRpbmcsIGl0cyBvd24gbWFya2VycyBhbmQgbm8gYGtpbmRgIG9uIHRoZSB3aXJlLiBBIGdyZXAgZm9yXG4gKiBgZGllKGAgd291bGQgaGF2ZSByZXBvcnRlZCBcInRoZSBlcnJvciBjb250cmFjdCBpcyA0NiBzaXRlc1wiOyBpdCB3YXMgNDYgcGx1c1xuICogdGhlc2UsIGFuZCB0aGVzZSBhcmUgdGhlIG9uZXMgYW4gYWdlbnQgbWVldHMgZmlyc3QgKHBsYXlib29rIEI4OiBsb29rIGZvciB0aGVcbiAqIFJBSVNFLCBub3QgZm9yIHRoZSBoZWxwZXIpLiBUaGV5IG5vdyByYWlzZSB0aGUgc2FtZSBlbnZlbG9wZSBhcyB0aGUgcmVzdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbY21kLCAuLi5yZXN0XSA9IGFyZ3Y7XG5cbiAgLy8gQkFSRSBJTlZPQ0FUSU9OIElTIEEgVVNBR0UgRVJST1Ig4oCUIGV4aXQgMiwgdXNhZ2UgcG9pbnRlciBvbiBzdGRlcnIg4oCUIG5vdCBhXG4gIC8vIGhlbHAgcmVxdWVzdCBhdCBleGl0IDAuIGdyYXBldmluZSdzIGNhbGxlcnMgYXJlIGFnZW50czogYSBiYXJlIGNhbGwgaXMgYW5cbiAgLy8gdW5zZXQgc2hlbGwgdmFyaWFibGUgZXhwYW5kaW5nIHRvIG5vdGhpbmcsIG9yIGEgbWlzdGFrZSwgYW5kIGFuc3dlcmluZyBpdFxuICAvLyB3aXRoIDIuOUtCIG9mIGhlbHAgYXQgZXhpdCAwIHJlcG9ydHMgc3VjY2VzcyBmb3IgYSBjb21tYW5kIHRoYXQgYXNrZWQgZm9yXG4gIC8vIG5vdGhpbmcuIGBoZWxwYCAvIGAtLWhlbHBgIHJlbWFpbiBvbmUgdG9rZW4gYXdheSBhdCBleGl0IDAgKGFjYyBEMiDigJRcbiAgLy8gY29uZm9ybWVkIGZvciB0aGF0IHJlYXNvbiwgbm90IGJlY2F1c2UgdGhlIHJ1bGUgc2FpZCBzbykuXG4gIGlmIChjbWQgPT09IHVuZGVmaW5lZCkge1xuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IGNvbW1hbmRUb2tlbnMoKSxcbiAgICAgIGhpbnQ6IFwicnVuIGBncmFwZXZpbmUgaGVscGAgKG9yIC0taGVscCkgZm9yIHVzYWdlXCIsXG4gICAgfSk7XG4gIH1cblxuICAvLyBST09UIEZMQUcgUk9VVElORy4gQSBsZWFkaW5nIC0tdG9rZW4gdXNlZCB0byBiZSBjb25zdW1lZCBhcyB0aGUgQ09NTUFORFxuICAvLyB0b2tlbiBhbmQgcmVqZWN0ZWQgYXMgYHVua25vd24gY29tbWFuZDogLS1ub3BlYCDigJQgYSBmbGFnIHJlYWNoaW5nIHRoZSB2ZXJiXG4gIC8vIHBhcnNlcidzIGVycm9yIHBhdGgsIHdoZXJlIHRoZSByZWplY3Rpb24gY291bGQgbm90IGVudW1lcmF0ZSB0aGUgZmxhZyBzZXRcbiAgLy8gKGZvdW5kIHZpYSBhY2MncyByb290LW9ubHkgc3VyZmFjZSBjYXB0dXJlKS4gVGhlIHJvb3QncyBhY2NlcHRlZCBmbGFncyBhcmVcbiAgLy8gdGhlIGludGVyY2VwdG9yczsgYW55dGhpbmcgZWxzZSBkYXNoZWQgaXMgcmVqZWN0ZWQgQVMgQSBGTEFHLCBlbnVtZXJhdGluZ1xuICAvLyB0aGUgcm9vdCdzIG93biBzZXQuXG4gIGlmIChjbWQuc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gY21kKTtcbiAgICBpZiAoIWludGVyY2VwdG9yKSB7XG4gICAgICAvLyDimqAgVEhFIFNPUlQgU1VSVklWRVMgVEhFIE1PVkUgSU5UTyBgY2hvaWNlc2AsIEFORCBJVCBJUyBOT1QgREVDT1JBVElPTi5cbiAgICAgIC8vIExvbmcgZmxhZ3MgZmlyc3QsIGJlY2F1c2UgYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZHMgdGhlIGxpc3RcbiAgICAgIC8vIGxlZnQtdG8tcmlnaHQgYW5kIHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcsXG4gICAgICAvLyBzbyBhIHNob3J0IGFsaWFzIG1pZC1saXN0IHRydW5jYXRlcyB3aGF0IGl0IHNlZXMuIEFuIGFycmF5IGlzIG5vdFxuICAgICAgLy8gdnVsbmVyYWJsZSB0byB0aGF0IOKAlCBidXQgdGhlIG9yZGVyIGlzIGZyZWUgYW5kIHRoZSBwcm9wZXJ0eSBpcyByZWFsIGZvclxuICAgICAgLy8gYW55IGNvbnN1bWVyIHRoYXQgZmxhdHRlbnMgaXQgYmFjayB0byBhIGxpbmUuXG4gICAgICBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtjbWR9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGNob2ljZXM6IFsuLi5ST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSldLnNvcnQoXG4gICAgICAgICAgKGEsIGIpID0+IE51bWJlcihiLnN0YXJ0c1dpdGgoXCItLVwiKSkgLSBOdW1iZXIoYS5zdGFydHNXaXRoKFwiLS1cIikpLFxuICAgICAgICApLFxuICAgICAgICBoaW50OiBgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7Y29tbWFuZFRva2VucygpLmpvaW4oXCIgXCIpfWAsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGF3YWl0IHJ1bkNvbW1hbmQoZmluZENvbW1hbmQoaW50ZXJjZXB0b3IucnVucykgYXMgQ29tbWFuZFNwZWMsIHJlc3QpO1xuICB9XG5cbiAgY29uc3Qgc3BlYyA9IGZpbmRDb21tYW5kKGNtZCk7XG4gIGlmICghc3BlYykge1xuICAgIC8vIFRoZSB1bmtub3duLXZlcmIgcmVqZWN0aW9uIGVudW1lcmF0ZXMgdGhlIHZhbGlkIHNldCwgZXhhY3RseSBhcyB0aGVcbiAgICAvLyB1bmtub3duLWZsYWcgcmVqZWN0aW9uIGRvZXMg4oCUIHRoZSBwYXJzZXIncyBvd24gYWNjb3VudCBvZiB3aGF0IGl0XG4gICAgLy8gYWNjZXB0cywgcHJvZHVjZWQgYnkgdGhlIHBhcnNlciAoYWNjIFNUQU5EQVJELm1kLCBcInRoZSBjaGVhcGVzdCB2ZXJzaW9uXG4gICAgLy8gb2YgY2hlY2tlZFwiKS5cbiAgICBkaWUoYHVua25vd24gY29tbWFuZDogJHtjbWR9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXM6IGNvbW1hbmRUb2tlbnMoKSB9KTtcbiAgfVxuICByZXR1cm4gYXdhaXQgcnVuQ29tbWFuZChzcGVjLCByZXN0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuQ29tbWFuZChzcGVjOiBDb21tYW5kU3BlYywgcmVzdDogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9zaXRpb25hbDogc3RyaW5nW107XG4gIGxldCBmbGFnczogRmxhZ3M7XG4gIHRyeSB7XG4gICAgKHsgcG9zaXRpb25hbCwgZmxhZ3MgfSA9IHBhcnNlRmxhZ3MocmVzdCwgc3BlYykpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKCEoZSBpbnN0YW5jZW9mIFVzYWdlRXJyb3IpKSB0aHJvdyBlO1xuICAgIGRpZShlLm1lc3NhZ2UsIFwidXNhZ2VcIiwgZS5leHRyYSk7XG4gIH1cbiAgLy8gQXJpdHksIGVuZm9yY2VkIEZST00gVEhFIERFQ0xBUkVEIFNIQVBFIOKAlCB0aGUgcmVnaXN0cnkncyBwb3NpdGlvbmFsIHNwZWMgaXNcbiAgLy8gd2hhdCBgc2NoZW1hYCBwdWJsaXNoZXMsIHNvIGVuZm9yY2luZyBpdCBoZXJlIGlzIHdoYXQga2VlcHMgdGhlIGRlY2xhcmF0aW9uXG4gIC8vIHRydWUgYnkgY29uc3RydWN0aW9uOiBhIG1pc3NpbmcgcmVxdWlyZWQgcG9zaXRpb25hbCBlcnJvcnMgYmVmb3JlIHRoZSB2ZXJiXG4gIC8vIHJ1bnMsIGFuZCBhbiBFWENFU1MgcG9zaXRpb25hbCBpcyByZWplY3RlZCByYXRoZXIgdGhhbiBzaWxlbnRseSBzd2FsbG93ZWRcbiAgLy8gKGFjYyBBNCdzIHNoYXBlIOKAlCB0aGUgZGVmZWN0IG5vIGV4dGVybmFsIGNoZWNrIGNhbiBzZWUpLlxuICBjb25zdCByZXF1aXJlZCA9IHNwZWMucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gIGNvbnN0IHZhcmlhZGljID0gc3BlYy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgaWYgKHBvc2l0aW9uYWwubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICBjb25zdCBtaXNzaW5nID0gc3BlYy5wb3NpdGlvbmFsc1twb3NpdGlvbmFsLmxlbmd0aF07XG4gICAgZGllKGAke3NwZWMubmFtZX06IG1pc3NpbmcgcmVxdWlyZWQgPCR7bWlzc2luZz8ubmFtZSA/PyBcImFyZ3VtZW50XCJ9PmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogYGV4cGVjdHM6ICR7c3BlYy5uYW1lfSAke3NwZWMucG9zaXRpb25hbHNcbiAgICAgICAgLm1hcCgocCkgPT4gKHAucmVxdWlyZWQgPyBgPCR7cC5uYW1lfT5gIDogYFske3AubmFtZX1dYCkpXG4gICAgICAgIC5qb2luKFwiIFwiKX1gLFxuICAgIH0pO1xuICB9XG4gIGlmICghdmFyaWFkaWMgJiYgcG9zaXRpb25hbC5sZW5ndGggPiBzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aCkge1xuICAgIGRpZShcbiAgICAgIGAke3NwZWMubmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsW3NwZWMucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogYGV4cGVjdHM6ICR7c3BlYy5uYW1lfSAke1xuICAgICAgICAgIHNwZWMucG9zaXRpb25hbHMubWFwKChwKSA9PiAocC5yZXF1aXJlZCA/IGA8JHtwLm5hbWV9PmAgOiBgWyR7cC5uYW1lfV1gKSkuam9pbihcIiBcIikgfHxcbiAgICAgICAgICBcIihubyBhcmd1bWVudHMpXCJcbiAgICAgICAgfWAsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHNwZWMucnVuKHBvc2l0aW9uYWwsIGZsYWdzKTtcbiAgcmV0dXJuIHR5cGVvZiBvdXRjb21lID09PSBcIm51bWJlclwiID8gb3V0Y29tZSA6IDA7XG59XG5cbi8qKlxuICogVGhlIG9uZSBwbGFjZSB0aGlzIENMSSBjYW4gZW5kLCBhbmQgdGhlIG9uZSBwbGFjZSBhIGBDbGlFcnJvcmAgYmVjb21lcyBhblxuICogZXhpdCBjb2RlLlxuICpcbiAqIOKblCBBRERFRCBBVCBQSEFTRSA2IENIQVBURVIgMiwgQU5EIElUIElTIFdIQVQgTUFLRVMgYGRpZWAgU0FGRSBUTyBUSFJPVy5cbiAqIGByZXBvcnRDbGlFcnJvcmAgd3JpdGVzIHRoZSBlbnZlbG9wZSBhbmQgaGFuZHMgYmFjayB0aGUgdGF4b25vbXkgY29kZTsgYVxuICogdGhyb3cgaXQgZG9lcyBOT1QgcmVjb2duaXNlIGlzIHJlLXRocm93biwgYmVjYXVzZSBzd2FsbG93aW5nIGFuIHVua25vd24gb25lXG4gKiBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGVcbiAqIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICpcbiAqIOKaoCBBTkQgYHNldEN1cnJlbnRDb21tYW5kYCBJUyBOT1QgREVDT1JBVElPTiDigJQgaXQgaXMgdGhlIGBtZXRhLmNvbW1hbmRgIGZpZWxkXG4gKiBvZiBldmVyeSBlbnZlbG9wZSB0aGlzIENMSSBlbWl0cywgd2hpY2ggaXMgaG93IGEgY2FsbGVyIHJvdXRpbmcgb24gYGtpbmRgXG4gKiBrbm93cyBXSElDSCB2ZXJiIHByb2R1Y2VkIGl0LiBTZXQgZnJvbSB0aGUgcmF3IHRva2VuIHNvIGFuIHVua25vd24gdmVyYiBzdGlsbFxuICogbmFtZXMgaXRzZWxmIGluIGl0cyBvd24gcmVqZWN0aW9uLlxuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKGNvZGUgIT09IG51bGwpIHJldHVybiBjb2RlO1xuICAgIHRocm93IGU7XG4gIH1cbn1cblxuLy8g4puUIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIElUUyBBQlNFTkNFIElTIFRIRSBTVEVQIChwbGF5Ym9vayBCMykuXG4vLyBgZGlzdC9jbGkuanNgIGlzIElNUE9SVEVEIGJ5IGBzY3JpcHRzL2NsaS50c2AsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzXG4vLyBlbnRyeSwgc28gdGhlIGd1YXJkIHdvdWxkIG5ldmVyIHJ1biBhbmQgZXZlcnkgdmVyYiB3b3VsZCBwcmludCBub3RoaW5nIGFuZFxuLy8gZXhpdCAwLiBOb3IgbWF5IHRoaXMgZmlsZSBvZmZlciBhIHNlY29uZCBlbnRyeSBmcm9tIGl0cyBhdXRob3JpbmcgYWRkcmVzczpcbi8vIGBTS0lMTF9ST09UYCwgYERJU1RfRElSYCwgYFNVUkZBQ0VfQ1dEYCBhbmQgYERBRU1PTl9TQ1JJUFRgIGFib3ZlIGFyZSBhbGxcbi8vIGNvbXB1dGVkIGZyb20gYFNDUklQVF9ESVJgIGFuZCBhcmUgY29ycmVjdCBvbmx5IGZyb20gYGRpc3QvYC5cbi8vXG4vLyBUaGUgZHJhaW4gY29udHJhY3QgbGl2ZXMgYXQgdGhlIGxhdW5jaGVyIG5vdyDigJQgYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4vLyByZXR1cm4sIG5ldmVyIGFuIGV4cGxpY2l0IGV4aXQsIGJlY2F1c2UgQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhXG4vLyBwaXBlIGFuZCBgdGFpbGAgd3JpdGVzIEpTT05MIGEgY2FsbGVyIHBhcnNlcy4gU2VlXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2NsaS50c2AgZm9yIHRoZSBmdWxsIGFjY291bnQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLlxuICAgKlxuICAgKiAg4puUIEFORCBXSEVOIFRIRSBORVcgTE9HIFdBUyBBTFJFQURZIFBBU1QgVEhFIEJPT0tNQVJLLCBUSEUgQ0xJRU5UXG4gICAqICBSRUNPTk5FQ1RTIEZST00gSVRTIFNUQVJULiBBIGRhZW1vbiB0aGF0IGJlbGlldmVzIHRoZSBjdXJzb3Igc2VuZHMgb25seVxuICAgKiAgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hbiBtZXNzYWdlIGF0XG4gICAqICBuZXcgaWQgMiB1bmRlciBhbiBvbGQgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHNpbGVudGx5LiBFdmVyeXRoaW5nIGluXG4gICAqICBhIG5ldyBlcG9jaCBpcyBuZXcgdG8gdGhpcyByZWFkZXIsIHNvIHRoZSBhdHRlbXB0IGlzIGRyb3BwZWQgYW5kIHJlLW1hZGVcbiAgICogIGZyb20gMCBhdCBvbmNlIChubyBiYWNrb2ZmKS4gQSBmcmFtZSBBVCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIG1lYW5zXG4gICAqICB0aGUgZGFlbW9uIGlzIGFscmVhZHkgcmVwbGF5aW5nIHdob2xlLCBhbmQgaXMga2VwdC4gKFJldmlld2VyJ3MgRDIgZ2FwLFxuICAgKiAgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYuKSAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBlcG9jaCB0aGUgc3RhcnRpbmcgYHNpbmNlYCBjYW1lIGZyb20sIHdoZW4gdGhlIGNhbGxlciBoYXMgb25lIChhXG4gICAqICBib29rbWFyayBwcmludGVkIGFzIGBOQDxlcG9jaD5gLCBgLi90YWlsSGFuZG9mZi50c2ApLiBUaGUgZmlyc3QgZnJhbWUgb2YgYVxuICAgKiAgZGlmZmVyZW50IGVwb2NoIGlzIHRoZW4gYW4gZXBvY2ggY2hhbmdlIGxpa2UgYW55IG90aGVyIOKAlCB3aGljaCBpcyB3aGF0XG4gICAqICBzdG9wcyBhIGJvb2ttYXJrIG91dGxpdmluZyBpdHMgbG9nIGFjcm9zcyBwcm9jZXNzZXMuICovXG4gIHNpbmNlRXBvY2g/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSZWFkIGEgZnJhbWUgd2hvc2UgaWQgaXMgQVQgT1IgQkVMT1cgdGhlIGN1cnNvciB0aGlzIGNvbm5lY3Rpb24gYXNrZWRcbiAgICogZnJvbSBhcyBcInRoZSBsb2cgcmVzdGFydGVkXCIsIHJlc2V0IHRoZSBjdXJzb3IgdG8gMCwgYW5kIGNhbGxcbiAgICogYG9uRXBvY2hDaGFuZ2VgICh3aXRoIHRoZSBmcmFtZSdzIGVwb2NoLCBvciBgXCJ1bmtub3duXCJgKS4gRGVmYXVsdCBmYWxzZS5cbiAgICpcbiAgICog4puUIFdIWSBJVCBJUyBIT05FU1Q6IHRoZSBraXQncyBldmVudCBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93blxuICAgKiBieSByZXBsYXlpbmcgV0hPTEUgKGAuL2V2ZW50TG9nLnRzYCwgcG9pbnQgMyksIGFuZCBvdGhlcndpc2Ugc2VuZHMgb25seVxuICAgKiBpZHMgYWJvdmUgdGhlIGN1cnNvci4gU28gYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGV4aXN0cyBvbmx5XG4gICAqIHdoZW4gdGhlIGRhZW1vbiBqdWRnZWQgdGhlIGN1cnNvciBmb3JlaWduIOKAlCBhIHJlc3RhcnRlZCBkYWVtb24sIHdob3NlIGlkc1xuICAgKiBiZWdhbiBhZ2FpbiBhdCAxLiBUaGUgZXBvY2ggY2F0Y2hlcyB0aGF0IFdJVEhJTiBvbmUgcHJvY2VzczsgdGhpcyBjYXRjaGVzXG4gICAqIGl0IEFDUk9TUyBwcm9jZXNzZXMsIHdoZXJlIGEgcmUtYXJtZWQgdGFpbCBjYXJyaWVzIGEgYm9va21hcmsgZnJvbSBhIGxvZ1xuICAgKiB0aGF0IG5vIGxvbmdlciBleGlzdHMgYW5kLCB3aXRob3V0IGl0LCBrZXB0IHRoYXQgYm9va21hcmsgZm9yZXZlcjogZXZlcnlcbiAgICogcmUtYXJtIHJlcGxheWVkIHRoZSB3aG9sZSBuZXcgbG9nLCBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcFxuICAgKiAoZm91bmQgYnkgdGhlIHZlcmlmaWVyIG9uIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCBhZnRlciBgdGFpbC5sb3N0YCDihpJcbiAgICogYG9wZW4gLS1yZXN0b3JlYCkuXG4gICAqXG4gICAqIOKaoCBPTkxZIEZPUiBBIERBRU1PTiBPTiBUSEUgS0lUJ1MgRVZFTlQgTE9HLiBHcmFwZXZpbmUncyBpZHMgYXJlIHJlY292ZXJlZFxuICAgKiBhY3Jvc3MgYSByZXN0YXJ0IGFuZCBpdHMgYC0tbGFzdGAgcXVlcnkgb3ZlcnJpZGVzIGBzaW5jZWAsIHNvIGl0IGxlYXZlc1xuICAgKiB0aGlzIG9mZi4gQW5kIHRoZSBibGluZCBzcG90IGlzIHN0YXRlZDogYSBib29rbWFyayB0aGF0IGhhcHBlbnMgdG8gYmUgYXRcbiAgICogb3IgYmVsb3cgdGhlIFJFU1RBUlRFRCBsb2cncyBvd24gbGVuZ3RoIGxvb2tzIHZhbGlkIHRvIHRoZSBkYWVtb24sIHdoaWNoXG4gICAqIHRoZW4gc2VuZHMgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQuIFRoZSBjb21lLWJhY2sgcGF0aCB0aGVyZWZvcmUgZHJvcHNcbiAgICogdGhlIGJvb2ttYXJrIGFsdG9nZXRoZXIgKGAuL3RhaWxIYW5kb2ZmLnRzYCwgRDIpLCBzbyB0aGlzIGlzIHRoZSBuZXQsIG5vdFxuICAgKiB0aGUgcnVsZS5cbiAgICovXG4gIHJlc3RhcnRPblJlcGxheT86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gYGFjY2VwdGVkYCBpcyBgYWNjZXB0YCdzXG4gICAqICB2ZXJkaWN0IG9uIHRoaXMgZnJhbWUsIHdoaWNoIGlzIHdoYXQgbGV0cyBgdGFpbCAtLW9uY2VgIGVuZCBvbiB0aGUgZmlyc3RcbiAgICogIGZyYW1lIGl0IGFjdHVhbGx5IERFTElWRVJTIChgLi90YWlsSGFuZG9mZi50c2ApLlxuICAgKlxuICAgKiAg4puUIEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OIGJlZm9yZSB0aGUgY2xpZW50IHJldHVybnMuIEl0XG4gICAqICB1c2VkIHRvIHJldHVybiBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIHdpdGggdGhlIFNTRSBzdHJlYW0gc3RpbGwgb3BlbixcbiAgICogIHdoaWNoIGtlcHQgdGhlIHByb2Nlc3MgYWxpdmUg4oCUIHVuc2VlbiBmb3IgYGNsb3NlZGAsIGJlY2F1c2UgdGhlIHNlcnZlclxuICAgKiAgZW5kcyB0aGF0IHN0cmVhbSBpdHNlbGYsIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFza1xuICAgKiAgd291bGQgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQuIChBZGp1c3RtZW50IDEgb2YgdGhlXG4gICAqICBNb25pdG9yLWV4cGlyeSBzcGlrZTsgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lLCBhY2NlcHRlZDogYm9vbGVhbikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBhcyB0aGUgdGFpbCBlbmRzLCB3aXRoIHRoZSBmaW5hbCBjdXJzb3IgKHRoZSBib29rbWFyayBhIHJlLWFybVxuICAgKiBwYXNzZXMgYXMgYC0tc2luY2VgKSBhbmQgd2h5IGl0IGVuZGVkLiBBIFJFUE9SVCBTSU5LIGxpa2UgYG9uRGlzY29ubmVjdGAsXG4gICAqIG5vdCBhIGJlaGF2aW91cmFsIGhhdGNoOiBpdCBjaGFuZ2VzIG5vdGhpbmcgdGhlIGNsaWVudCBkb2VzLiBJdCBleGlzdHNcbiAgICogZm9yIGAuL3RhaWxIYW5kb2ZmLnRzYCwgd2hvc2UgbGFzdCBsaW5lIG5hbWVzIHRoZSByZS1hcm0gYW5kIG11c3QgY2FycnlcbiAgICogdGhlIGN1cnNvciBleGFjdGx5IGFzIHRoaXMgbG9vcCBsZWZ0IGl0LCBlcG9jaCByZXNldHMgaW5jbHVkZWQuXG4gICAqL1xuICBvbkVuZD86IChlbmQ6IHtcbiAgICBjdXJzb3I6IG51bWJlcjtcbiAgICAvKiogVGhlIGVwb2NoIG9mIHRoZSBsb2cgdGhlIGN1cnNvciBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZS4gKi9cbiAgICBlcG9jaDogc3RyaW5nIHwgbnVsbDtcbiAgICByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCI7XG4gIH0pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7XG4gIGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7XG4gIGNvbW1lbnRzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBvcHRzLnNpbmNlRXBvY2ggPz8gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG4gIGxldCBlbmRpbmc6IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgPSBcInN0b3BwZWRcIjtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIC8vIOKblCBBIFNUT1AgVEhBVCBMQU5ERUQgV0hJTEUgYHJlc29sdmVgIFdBUyBBV0FJVEVEICh0aGUgaGFuZG9mZidzIHdpbmRvdyxcbiAgICAgIC8vIGEgc2lnbmFsKSBmb3VuZCBubyBhdHRlbXB0IHRvIGFib3J0LiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlIGxvb3Agd2VudFxuICAgICAgLy8gb24gdG8gZmV0Y2gsIHNraXBwZWQgdGhlIHJlYWQsIGFuZCByZXR1cm5lZCB3aXRoIHRoYXQgc3RyZWFtIHN0aWxsXG4gICAgICAvLyBvcGVuIOKAlCB3aGljaCBrZWVwcyBhIHByb2Nlc3MgYWxpdmUgZXhhY3RseSBsaWtlIHRoZSB0ZXJtaW5hbC1mcmFtZVxuICAgICAgLy8gaGFuZy4gKFN1c3BlY3RlZCBieSB0aGUgcmV2aWV3ZXIsIHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKVxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHtcbiAgICAgICAgc2luY2U6IFN0cmluZyhjdXJzb3IpLFxuICAgICAgfTtcbiAgICAgIC8vIFdoYXQgdGhpcyBjb25uZWN0aW9uIGFza2VkIGZyb20sIGZvciBgcmVzdGFydE9uUmVwbGF5YC5cbiAgICAgIGNvbnN0IGFza2VkU2luY2UgPSBjdXJzb3I7XG4gICAgICBsZXQgcmVzdGFydE5vdGVkID0gZmFsc2U7XG4gICAgICAvLyBTZXQgd2hlbiBhbiBlcG9jaCBjaGFuZ2UgZmluZHMgdGhlIG5ldyBsb2cgcGFzdCB0aGUgYm9va21hcmsuXG4gICAgICBsZXQgZnJvbVRvcCA9IGZhbHNlO1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcblxuICAgICAgICAgICAgbGV0IGVwb2NoUmVzZXQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGVwb2NoUmVzZXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICAgIC8vIFRoZSBuZXcgbG9nIGlzIHBhc3QgdGhlIGJvb2ttYXJrOiBpdHMgc3RhcnQgd2FzIHNraXBwZWQuXG4gICAgICAgICAgICAgICAgICAvLyBEcm9wIHRoaXMgYXR0ZW1wdCBhbmQgcmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIDAuXG4gICAgICAgICAgICAgICAgICBpZiAoYXNrZWRTaW5jZSA+IDAgJiYgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgbiA+IGFza2VkU2luY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICAgICAgICBmcm9tVG9wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBvcHRzLnJlc3RhcnRPblJlcGxheSA9PT0gdHJ1ZSAmJlxuICAgICAgICAgICAgICAhZXBvY2hSZXNldCAmJlxuICAgICAgICAgICAgICAhcmVzdGFydE5vdGVkICYmXG4gICAgICAgICAgICAgIGFza2VkU2luY2UgPj0gMCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICBuIDw9IGFza2VkU2luY2VcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyBUaGUgZGFlbW9uIHJlcGxheWVkIFdIT0xFOiBpdHMgbG9nIHJlc3RhcnRlZCAoc2VlIHRoZSBvcHRpb24pLlxuICAgICAgICAgICAgICByZXN0YXJ0Tm90ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4ob3B0cy5lcG9jaE9mPy4oZXYpID8/IFwidW5rbm93blwiKSA/PyBudWxsO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgIC8vIFJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSBpdHMgc3RhcnQsIG5vdzogbm90aGluZyBmYWlsZWQuXG4gICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gICAgb3B0cy5vbkVuZD8uKHsgY3Vyc29yLCBlcG9jaCwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvYmFja2xvZy8yMDI2LTA5LTIyLXNjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTIyLW1vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgYWx3YXlzIGdldHMgYHRhaWwud2luZG93YDogYSBzdG9wLXN0YXJ0IHRhaWxcbiAqICAgICB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHMgY29ubmVjdGlvbiBjYXJyaWVzLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMpLCBlYWNoIG5hbWluZyBob3cgdG8gY29tZSBiYWNrXG4gKiBpbnN0ZWFkIG9mIGEgcmUtYXJtLiBBIHNpZ25hbCBvciBhIGNhbGxlcidzIGFib3J0IHByaW50cyBub3RoaW5nLlxuICpcbiAqIEV2ZXJ5IHJlLWFybSBjYXJyaWVzIGAtLXNpbmNlIDxjdXJzb3I+YCwgc28gbm90aGluZyByZXBsYXlzOyB0aGUgZGFlbW9uJ3NcbiAqIGJ1ZmZlciBjb3ZlcnMgd2hhdGV2ZXIgbGFuZHMgYmV0d2VlbiBvbmUgd2F0Y2gncyBleGl0IGFuZCB0aGUgbmV4dCdzIGFybS5cbiAqXG4gKiDilIDilIAgREVDSVNJT04gTE9HIChmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogS2l0IGRlY2lzaW9ucyBsaXZlIGluIG1vZHVsZSBoZWFkZXJzICh0aGUgYXJjaGl0ZWN0dXJlIGRvYydzIMKnNCBydWxlOiBcImVhY2hcbiAqIG1vZHVsZSdzIGhlYWRlciBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhY2NvdW50XCIpLiBSdWxlZCBieSBDb2xlOiB0aGUgaHlicmlkLFxuICogdGhlIGFsd2F5cy1ib29rbWFyaywgcHJlc2VuY2Ugc3BlbGxzIGFsd2F5cyByZS1hcm0gTW9uaXRvciwgYm91bnR5J3MgZXhhbXBsZVxuICogZml4ZWQuIFRoZSBmb3VyIGFkanVzdG1lbnRzIHdlcmUgdGhlIHNwaWtlJ3MgcmVxdWlyZW1lbnRzLiBUaGUgcmVzdCBhcmUgdGhlXG4gKiBpbXBsZW1lbnRlcidzIHJ1bGluZ3MsIG1hcmtlZCDimpYgd2l0aCB0aGUgb3B0aW9ucyBub3QgdGFrZW4uXG4gKlxuICogQTEgwrcgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04uIGB0YWlsRXZlbnRzYCBub3cgYWJvcnRzIHRoZVxuICogICAgICBpbi1mbGlnaHQgZmV0Y2ggYmVmb3JlIGl0IHJldHVybnMgb24gYSB0ZXJtaW5hbCBmcmFtZS4gQmVmb3JlLCBpdFxuICogICAgICByZXR1cm5lZCBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIGFuZCBsZWZ0IHRoZSBTU0Ugc3RyZWFtIG9wZW4sIHNvIHRoZVxuICogICAgICBwcm9jZXNzIHN0YXllZCBhbGl2ZTogdW5zZWVuIGZvciBgY2xvc2VkYCAodGhlIHNlcnZlciBlbmRzIHRoYXRcbiAqICAgICAgc3RyZWFtIGl0c2VsZikgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrIHdvdWxkXG4gKiAgICAgIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LCBzaWxlbnRseS4gUGlubmVkIGluXG4gKiAgICAgIGB0YWlsSGFuZG9mZi50ZXN0LnRzYCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQga2VlcHMgdGhlIHN0cmVhbSBvcGVuLlxuICpcbiAqIEEyIMK3IFRIRSBORVhUIEFDVCBERVBFTkRTIE9OIFNUQVRFLiBgaGFuZG9mZigpYCBiZWxvdyBpcyB0aGUgcHVyZSBkZWNpc2lvbjpcbiAqICAgICAgcXVpZXQg4oaSIGJhY2tncm91bmQsIGFjdGl2ZSBvciBwcmVzZW5jZSDihpIgTW9uaXRvciwgd29rZSDihpIgTW9uaXRvcixcbiAqICAgICAgY2xvc2VkIOKGkiBjb21lIGJhY2ssIGxvc3Qg4oaSIGNvbWUgYmFjay4gQ29tZSBiYWNrIGlzIHRoZSBzcGVsbCdzIG93biB2ZXJiXG4gKiAgICAgIChgb3BlbiAtLXJlc3RvcmUgPGlkPmAgZm9yIHRoZSBzZXNzaW9uIHNwZWxscykuXG4gKiAgICAgIOKaliBUSEUgRElTQ09OTkVDVCBERUNJU0lPTjogZm9yIGEgc2Vzc2lvbiBzcGVsbCwgYSBMT1NUIGRhZW1vbiBlbmRzIHRoZVxuICogICAgICB0YWlsIGluIEJPVEggbW9kZXMgd2l0aCBhIHN0ZG91dCBgdGFpbC5sb3N0YCBsaW5lLiBNb25pdG9yIG5vdGlmaWVzIG9ubHlcbiAqICAgICAgb24gc3Rkb3V0LCBzbyB0aGUgb2xkIHN0ZGVyci1vbmx5IGB0YWlsLmRpc2Nvbm5lY3RlZGAgbGVmdCBhXG4gKiAgICAgIE1vbml0b3Itd3JhcHBlZCBhZ2VudCB1bmF3YXJlIG9mIGEgYGtpbGwgLTlgIChFNTUncyBwdXJwb3NlIHVubWV0KSwgYW5kXG4gKiAgICAgIGEgYC0tb25jZWAgb24gYSBkZWFkIGRhZW1vbiB3b3VsZCBoYXZlIHNsZXB0IGZvcmV2ZXIuIFwiTG9zdFwiIGlzXG4gKiAgICAgIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBjb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93LCBuZXZlciBhIGRyb3BwZWRcbiAqICAgICAgc3RyZWFtIGFsb25lOiBhIGxhcHRvcCB0aGF0IHNsZWVwcyBkcm9wcyB0aGUgc3RyZWFtLCByZWNvbm5lY3RzIG9uIHRoZVxuICogICAgICBmaXJzdCB0cnksIGFuZCBtdXN0IHN0YXkgc2lsZW50LlxuICogICAgICAgIE5vdCB0YWtlbjogKGEpIGtlZXAgcmV0cnlpbmcgYW5kIG9ubHkgTU9WRSB0aGUgZGlzY29ubmVjdCBsaW5lIHRvXG4gKiAgICAgICAgc3Rkb3V0IOKAlCBhIHNlc3Npb24gZGFlbW9uIGlzIG5ldmVyIHJlc3Bhd25lZCBieSBpdHMgdGFpbCwgc28gdGhlXG4gKiAgICAgICAgcmV0cmllcyBidXkgbm90aGluZyBhbmQgdGhlIGFnZW50IGlzIHdva2VuIHRvIGJlIHRvbGQgdG8gd2FpdDsgKGIpXG4gKiAgICAgICAgbGVhdmUgaXQgb24gc3RkZXJyIOKAlCB0aGUgZGVmZWN0LlxuICogICAgICDimpYgUHJlc2VuY2Ugc3BlbGxzIGtlZXAgcmV0cnlpbmcsIGFzIGJlZm9yZTogZ3JhcGV2aW5lJ3MgdGFpbCByZXNwYXduc1xuICogICAgICBpdHMgZGFlbW9uIGFuZCBhc3Ryb2xhYmUncyBgam9pbmAgd2FpdHMgZm9yIHRoZSBodW1hbiB0byByZW9wZW4gdGhlXG4gKiAgICAgIGJvYXJkLCBib3RoIGJ5IGRlc2lnbi4gVGhlaXIgZGlzY29ubmVjdCBub3RlcyBzdGF5IHdoZXJlIHRoZXkgd2VyZS5cbiAqXG4gKiBBMyDCtyBRVUlFVCBJUyBUSEUgVEFJTCdTIE9XTiBDT1VOVC4gYGV2ZW50c2AgY291bnRzIHRoZSBsb2cgZnJhbWVzIHRoaXNcbiAqICAgICAgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQuIFRoZSBncm91bmRpbmcgbGluZSwgYSBzcGVsbCdzIGBzdWJzY3JpYmVkYFxuICogICAgICBtYXJrZXIsIGBlcG9jaC5jaGFuZ2VkYCBhbmQgdGhlIGhhbmRvZmYgbGluZSBpdHNlbGYgYXJlIG5vdCBsb2cgZnJhbWVzXG4gKiAgICAgIGFuZCBhcmUgbm90IGNvdW50ZWQ6IGEgZnJhbWUgY291bnRzIG9ubHkgaWYgaXQgY2FycmllcyBhIGxvZyBpZCAoRDMpLFxuICogICAgICBhbmQgYGNvdW50c2AgbGV0cyBhIHNwZWxsIGV4Y2x1ZGUgYSBmcmFtZSB0aGF0IGRvZXMgKGdyYXBldmluZSdzXG4gKiAgICAgIGBzdWJzY3JpYmVkYCBtYXJrZXIsIHdoaWNoIHNlZWRzIHRoZSBib29rbWFyayBmcm9tIGBsYXRlc3RfaWRgKS4gQW55IGxvZyBmcmFtZSBjb3VudHMsIHRoZSBkYWVtb24ncyBgd2FpdGluZ2AgcmVtaW5kZXJcbiAqICAgICAgaW5jbHVkZWQsIHNvIFwicXVpZXRcIiBtZWFucyBub3RoaW5nIG9uIHRoZSBsb2cuXG4gKiAgICAgIOKaliBBIGZyYW1lIHRoZSB0YWlsJ3Mgb3duIGZpbHRlciByZWplY3RzIChib3VudHkncyBvd25lciBzY29wZSwgYVxuICogICAgICBzZWxmLWVjaG8pIGlzIE5PVCBjb3VudGVkIGFuZCBkb2VzIG5vdCBlbmQgYSBgLS1vbmNlYDogaXQgd2FzIG5ldmVyXG4gKiAgICAgIGRlbGl2ZXJlZCwgYW5kIHdha2luZyBvbiBpdCB3b3VsZCBiZSBhIHdha2Ugd2l0aCBub3RoaW5nIHRvIGFjdCBvbiDigJRcbiAqICAgICAgdGhlIGRlZmVjdCB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcmVtb3ZlLiBUaGUgY3Vyc29yIHN0aWxsIGFkdmFuY2VzXG4gKiAgICAgIHBhc3QgaXQgKHRhaWxFdmVudHMnIHJ1bGUpLCBzbyBpdCBuZXZlciByZXBsYXlzIGVpdGhlci5cbiAqICAgICAgQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTsgdGhhdCBoYWxmIGxpdmVzIGluIGVhY2hcbiAqICAgICAgc3BlbGwncyBgdGFpbGAsIHdoaWNoIGtub3dzIHdoZXRoZXIgYC0tc2luY2VgIHdhcyBnaXZlbi5cbiAqXG4gKiBBNCDCtyBUSEUgV0lORE9XLiBgREVGQVVMVF9XSU5ET1dfTVNgID0gdGhlIGNhcCBtaW51cyBgV0lORE9XX01BUkdJTl9NU2BcbiAqICAgICAgKDYwIHMpLCBzbyAxLDc0MCwwMDAgbXMuIFRoZSBtYXJnaW4gaGFzIHRvIGNvdmVyIHRoZSBnYXAgYmV0d2VlbiB0aGVcbiAqICAgICAgaGFybmVzcyBzdGFydGluZyBpdHMgY2xvY2sgYW5kIHRoaXMgcHJvY2VzcyBzdGFydGluZyBpdHMgb3duIChCdW5cbiAqICAgICAgc3RhcnQtdXAsIGEgc2Vzc2lvbiBsb29rdXAsIGEgZGFlbW9uIHNwYXduIG9uIHRoZSBzcGVsbHMgd2hvc2UgYHJlc29sdmVgXG4gKiAgICAgIHNwYXducyBvbmUg4oCUIGJvdW5kZWQgYnkgdGhlaXIgc3RhcnQgdGltZW91dHMsIHdoaWNoIGFyZSBzZWNvbmRzKSBwbHVzXG4gKiAgICAgIHRoZSBsYXN0IGxpbmUncyBmbHVzaCBhbmQgTW9uaXRvcidzIDIwMCBtcyBiYXRjaGluZy4gQSBtaW51dGUgY292ZXJzXG4gKiAgICAgIGFsbCBvZiB0aGF0IG1hbnkgdGltZXMgb3Zlci4gVGhlIHNwaWtlIG1lYXN1cmVkIGEgMTIgc1xuICogICAgICB3aW5kb3cgdW5kZXIgYSAyMCBzIGNhcCBlbmRpbmcgY2xlYW5seTsgbm90aGluZyBoZXJlIGRlcGVuZHMgb24gYVxuICogICAgICBtYXJnaW4gdGhhdCB0aWdodC4gSWYgdGhlIGNhcCB3aW5zIGFueXdheSwgdGhlIGFnZW50IGdldHMgTW9uaXRvcidzXG4gKiAgICAgIGJhcmUgZXhwaXJ5IG5vdGljZSBhbmQgcmUtYXJtcyBzaWxlbnRseSBmcm9tIHRoZSBsYXN0IGlkIGl0IHNhdyDigJQgdGhlXG4gKiAgICAgIHJ1bGluZydzIGZhbGxiYWNrLCBzdGF0ZWQgaW4gZXZlcnkgc2tpbGwuXG4gKiAgICAgIOKaliBUaGUgd2luZG93IGlzIGluamVjdGFibGUgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gdGhyb3VnaFxuICogICAgICBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TYCAoYSBjb3VudCBvZiBtczsgYDBgIHR1cm5zIHRoZSB3aW5kb3cgb2ZmLFxuICogICAgICBmb3IgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsKS4gQW4gZW52IHZhciBhbmQgbm90IGEgZmxhZzogaXQgaXNcbiAqICAgICAgbm90IGFuIGFnZW50J3MgYWN0LCBzbyBpdCBzdGF5cyBvdXQgb2YgZWlnaHQgdmVyYnMnIHNjaGVtYXMuXG4gKlxuICog4pSA4pSAIFRIRSBWRVJJRklFUidTIERFRkVDVFMsIEZJWEVEIE9OIFRIRSBTQU1FIEJSQU5DSCAoMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIG5vLXN0YWtlIHZlcmlmaWVyIHJhbiBldmVyeSBzcGVsbCdzIHJlYWwgdGFpbCBhbmQgZm91bmQgZm91ciB3YXlzIHRoZVxuICogbG9vcCBicm9rZS4gRWFjaCBoYXMgYSBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYDsgRDEgYW5kIEQyIGFsc28gaGF2ZSBhXG4gKiByZWFsLWRhZW1vbiBjZWxsIGluIGBzcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90YWlsLWhhbmRvZmYuaW50ZWdyYXRpb24udGVzdC50c2AuXG4gKlxuICogRDEgwrcgQSBSRS1BUk0gQVQgQSBTRVNTSU9OIFRIQVQgQ0xPU0VEIElOIFRIRSBHQVAgRU5EUyBgdGFpbC5jbG9zZWRgLiBUaGVcbiAqICAgICAgdHJpZ2dlciBpcyBvcmRpbmFyeTogdGhlIGh1bWFuIHByZXNzZXMgQ2xvc2Ugd2hpbGUgdGhlIGFnZW50IGhhbmRsZXNcbiAqICAgICAgYHRhaWwud29rZWAuIFRoZSBzZXNzaW9uIHNwZWxscyBzdG9wcGVkIG9ubHkgd2hlbiBUSElTIHByb2Nlc3MgaGFkXG4gKiAgICAgIG9uY2UgcmVhY2hlZCB0aGUgc2Vzc2lvbiwgc28gdGhlIHJlLWFybSByZXRyaWVkIFwibm8gc2Vzc2lvbiB5ZXRcIiBvblxuICogICAgICBzdGRlcnIgZm9yZXZlciDigJQgYW5kIGl0cyBgLS1vbmNlYCBuZXZlciBleGl0ZWQuIFJ1bGU6IGEgdGFpbCBnaXZlblxuICogICAgICBgLS1zZXNzaW9uYCBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElORyBzZXNzaW9uLCBzbyBub3RcbiAqICAgICAgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQ7IHRoZSBzcGVsbCdzIGBvblVucmVzb2x2ZWRgIHNheXMgXCJzdG9wXCJcbiAqICAgICAgYW5kIHRoaXMgbW9kdWxlIHJlYWRzIEFOWSBzdG9wIGFzIGNsb3NlZC4gQSBiYXJlIGZpcnN0IGFybSBzdGlsbFxuICogICAgICB3YWl0cyBmb3IgYSBzZXNzaW9uIHRvIGFwcGVhci4g4pqgIFwiR2l2ZW5cIiBtZWFucyBPTiBUSEUgQ09NTUFORCBMSU5FXG4gKiAgICAgIChyZXZpZXcgQjEpOiBib3VudHkgYWxzbyByZXNvbHZlcyBhIHNlc3Npb24gZnJvbVxuICogICAgICBgJEJPVU5UWV9TRVNTSU9OX0tFWWAsIGAkQk9VTlRZX1NFU1NJT05gIG9yIGEgYC5ib3VudHktc2Vzc2lvbmAgZmlsZSxcbiAqICAgICAgd2hpY2ggZXZlcnkgYW50aGlsbCBzZWF0IGhhcywgYW5kIGEgc2VhdCdzIGZpcnN0IGFybSBtdXN0IHdhaXQuIEFcbiAqICAgICAga2V5ZWQgYm91bnR5IGJvYXJkIGNvbWVzIGJhY2sgYnkgaXRzIGtleSAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCk7XG4gKiAgICAgIHJlc3RvcmluZyBpdCBieSBpZCBzcGF3bnMgYW4gdW5rZXllZCBzdHJheS5cbiAqIEQyIMK3IEEgQk9PS01BUksgQ0FOTk9UIE9VVExJVkUgSVRTIExPRy4gQSByZXN0b3JlZCBkYWVtb24ncyBpZHMgYmVnaW4gYXQgMSxcbiAqICAgICAgYW5kIHRoZSBraXQncyBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93biBieSByZXBsYXlpbmcgd2hvbGU7XG4gKiAgICAgIHRoZSB0YWlsIGtlcHQgaXRzIGhpZ2hlciBjdXJzb3IsIHNvIGV2ZXJ5IHJlLWFybSByZXBsYXllZCB0aGUgbmV3IGxvZ1xuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVHdvIGhhbHZlczpcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFRocmVlIHBhcnRzOlxuICogICAgICAgIChhKSB0aGUgbmV0IOKAlCBgdGFpbEV2ZW50c2AnIGByZXN0YXJ0T25SZXBsYXlgLCBvbiBmb3IgZXZlcnkgc3BlbGwsXG4gKiAgICAgICAgICAgIHJlYWRzIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBhcyBhIHJlc3RhcnRlZCBsb2dcbiAqICAgICAgICAgICAgYW5kIHJlc2V0cyB0aGUgY3Vyc29yO1xuICogICAgICAgIChiKSB0aGUgcnVsZSDigJQgdGhlIGB0YWlsLmNsb3NlZGAvYHRhaWwubG9zdGAgaGludCwgYW5kIGV2ZXJ5IHNraWxsLFxuICogICAgICAgICAgICBzYXk6IHJ1biB0aGUgY29tbWFuZCB0aGUgbGluZSBuYW1lcywgdGhlbiB0YWlsIFdJVEggTk9cbiAqICAgICAgICAgICAgYC0tc2luY2VgIChhIHJlc3RvcmVkIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nOyBib3VudHkncyByZXN0b3JlXG4gKiAgICAgICAgICAgIGV2ZW4gbWludHMgYSBuZXcgaWQpO1xuICogICAgICAgIChjKSBUSEUgRVBPQ0ggSU4gVEhFIEJPT0tNQVJLIOKAlCDimpYgQSBSRVZFUlNBTC4gVGhlIGZpcnN0IHZlcnNpb24gb2ZcbiAqICAgICAgICAgICAgdGhpcyBlbnRyeSBsaXN0ZWQgXCJjYXJyeSB0aGUgZXBvY2ggaW4gdGhlIGJvb2ttYXJrXCIgYXMgbm90IHRha2VuXG4gKiAgICAgICAgICAgIChhIG5ldyBmbGFnIG9uIGVpZ2h0IHZlcmJzOyBhbiBlcG9jaCBzZWVuIG9ubHkgb25jZSBhIGZyYW1lXG4gKiAgICAgICAgICAgIGFycml2ZXMpLiBUaGUgcmV2aWV3ZXIgdGhlbiBzaG93ZWQgKGEpJ3MgYmxpbmQgc3BvdCBMSVZFOiBhbiBvbGRcbiAqICAgICAgICAgICAgYm9va21hcmsgYXQgb3IgYmVsb3cgdGhlIE5FVyBsb2cncyBsZW5ndGggbWFrZXMgdGhlIGRhZW1vbiBzZW5kXG4gKiAgICAgICAgICAgIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hblxuICogICAgICAgICAgICBtZXNzYWdlIGF0IG5ldyBpZCAyIHVuZGVyIGEgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHdpdGggbm9cbiAqICAgICAgICAgICAgbm90aWNlLiBUaHJlZSBwYXRocyByZWFjaCBpdDogY29taW5nIGJhY2sgd2l0aG91dCBmb2xsb3dpbmcgKGIpO1xuICogICAgICAgICAgICB0aGUgTW9uaXRvci1jYXAgZmFsbGJhY2sgKFwicmUtYXJtIGZyb20gdGhlIGxhc3QgaWQgeW91IHNhd1wiKVxuICogICAgICAgICAgICBhY3Jvc3MgYSByZXN0YXJ0OyBhbmQgYSBwcmVzZW5jZSB0YWlsIChhc3Ryb2xhYmUsIG1pbmQtbWFwcGVyKVxuICogICAgICAgICAgICB3aG9zZSBmaXJzdCBmcmFtZSBhZnRlciBhIHJlc3RhcnQgaXMgYWxyZWFkeSBwYXN0IGl0cyBib29rbWFyay5cbiAqICAgICAgICAgICAgVGhlIGZpeCBuZWVkcyBubyBuZXcgZmxhZyBhbmQgbm8gd2lyZSBjaGFuZ2U6IHRoZSBib29rbWFyayBpc1xuICogICAgICAgICAgICBwcmludGVkIGAtLXNpbmNlIE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCksIHRoZSBjbGllbnQgc3RhcnRzXG4gKiAgICAgICAgICAgIHdpdGggdGhhdCBlcG9jaCAoYHNpbmNlRXBvY2hgKSwgYW5kIGFuIGVwb2NoIGNoYW5nZSB3aG9zZSBmcmFtZVxuICogICAgICAgICAgICBpcyBwYXN0IHRoZSBhc2tlZCBjdXJzb3IgcmUtcmVhZHMgdGhlIG5ldyBsb2cgZnJvbSAwLiBUaGUgc2FtZVxuICogICAgICAgICAgICByZWNvbm5lY3QgY292ZXJzIHRoZSBpbi1wcm9jZXNzIHByZXNlbmNlIGNhc2UuXG4gKiAgICAgIOKaoCBTVEFURUQgTElNSVQ6IG9ubHkgZGFlbW9ucyB0aGF0IHN0YW1wIGFuIGVwb2NoIGdldCAoYykg4oCUXG4gKiAgICAgIHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUgYW5kIG1pbmQtbWFwcGVyLiBHbGFtb3VyLCBpbWFnbywgbWFncGllIGFuZFxuICogICAgICBib3VudHkgc3RhbXAgbm9uZSAoc2Vzc2lvbi1zY29wZWQgbG9ncywgcnVsZWQgc28gaW4gRDM5L0I4OyBib3VudHknc1xuICogICAgICBzZXJ2ZXIgaGVhZGVyIG5hbWVzIHRoaXMgcmVzaWR1ZSksIHNvIGZvciB0aGVtIHRoZSBnYXAgc3RheXMgb3BlbiBvblxuICogICAgICB0aGUgZmFsbGJhY2sgcGF0aCwgKGEpIGNvdmVycyB0aGUgd2hvbGUtcmVwbGF5IGNhc2UgYW5kIChiKSB0aGVcbiAqICAgICAgY29tZS1iYWNrIHBhdGguIENsb3NpbmcgaXQgdGhlcmUgaXMgYSBkYWVtb24gY2hhbmdlOiBhbiBlcG9jaCBvblxuICogICAgICBgY3JlYXRlRXZlbnRMb2dgLiBFdmVyeSBzcGVsbCBwcmludHMgdGhlIG5ldCdzIHJlc2V0IGFzXG4gKiAgICAgIGBlcG9jaC5jaGFuZ2VkYCAoYFwiZXBvY2hcIjogXCJ1bmtub3duXCJgIHdoZXJlIHRoZXJlIGlzIG5vbmUpLlxuICogRDMgwrcgT05MWSBBIEZSQU1FIFdJVEggQSBMT0cgSUQgQ09VTlRTLiBHbGFtb3VyJ3MgYW5kIGltYWdvJ3MgdGFiIHBpbmdzXG4gKiAgICAgIChgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCkgY2Fycnkgbm8gaWQ6IG5vdCBvbiB0aGUgbG9nLCBzbyBhIGxhcHRvcFxuICogICAgICBsaWQgbm8gbG9uZ2VyIHdha2VzIGEgYC0tb25jZWAsIGFuZCBpbWFnbydzIGdyZXAgbm8gbG9uZ2VyIHNob3dzIGFcbiAqICAgICAgYHRhaWwud29rZWAgd2l0aCBub3RoaW5nIGFib3ZlIGl0LlxuICogRDQgwrcgQSBIVU1BTidTIFdBVENIIEhBUyBOTyBXSU5ET1cuIGBncmFwZXZpbmUgdGFpbCAtLWh1bWFuYCBwYXNzZXNcbiAqICAgICAgYHdpbmRvd01zOiAwYDsgbm8gb3RoZXIgc3BlbGwgaGFzIGEgaHVtYW4gbW9kZS4gRXZlcnkgYHRhaWxgJ3MgaGVscFxuICogICAgICBjYXJyaWVzIGBXSU5ET1dfSEVMUGAsIHdoaWNoIG5hbWVzIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MGAuXG4gKiBBbHNvOiBldmVyeSBjb21lLWJhY2sgY29tbWFuZCBjYXJyaWVzIGAtLW5vLW9wZW5gLCBzbyBydW5uaW5nIGl0IG9wZW5zIG5vXG4gKiBicm93c2VyIHRhYi5cbiAqXG4gKiDimqAgS05PV04gRURHRSwgTk9UIEZJWEVEIChmb3VuZCBieSB0aGUgcmUtcmV2aWV3KTogYSBrZXllZCBib3VudHkgRklSU1QgYXJtXG4gKiAgIChhbiBhbnRoaWxsIHNlYXQpIHdob3NlIHdpbmRvdyBlbmRzIGJlZm9yZSBpdHMgYm9hcmQgZXZlciBvcGVucyBwcmludHMgYVxuICogICByZS1hcm0gcGlubmVkIHRvIHRoZSBkZXJpdmVkIGlkIHdpdGggYW4gZW1wdHkgYm9va21hcmtcbiAqICAgKGAtLXNlc3Npb24gay3igKYgLS1zaW5jZT0tMSAtLW9uY2VgKS4gVGhhdCByZS1hcm0gaXMgYSByZS1hcm0gYnkgRDEncyBydWxlLFxuICogICBzbyBpZiB0aGUgYm9hcmQgaXMgc3RpbGwgbm90IHVwIOKAlCB0aGUgbGVhZCBtb3JlIHRoYW4gb25lIHdpbmRvdyAoMjkgbWluKVxuICogICBsYXRlIOKAlCB0aGUgc2VhdCBnZXRzIGB0YWlsLmNsb3NlZGAgaW5zdGVhZCBvZiB3YWl0aW5nLiBNaW5vcjogdGhlXG4gKiAgIGNvbWUtYmFjayBpdCBuYW1lcyAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCkgaXMgdGhlIHJpZ2h0IG5leHQgc3RlcCBhbnl3YXkuXG4gKlxuICog4pSA4pSAIFRIRSBDT01NQU5EIE5BTUVTIE5PIFBBVEggKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBsaW5lJ3MgYGNvbW1hbmRgIGlzIHRoZSBWRVJCIEFORCBJVFMgQVJHVU1FTlRTIE9OTFlcbiAqIChgdGFpbCAtLXNlc3Npb24gWCAtLXNpbmNlIE5ARSAtLW9uY2VgKSwgcGx1cyBgc3BlbGxgLCBhbmQgdGhlIGFnZW50IHJ1bnMgaXRcbiAqIHdpdGggSVRTIE9XTiBsYXVuY2hlciwgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHNgLiBJdCB1c2VkXG4gKiB0byBiZSBydW5uYWJsZSBhcyBwcmludGVkLCBoZWFkZWQgYnkgYGJ1biA8YXJndlsxXT5gIOKAlCBhbmQgZm9yIGFuIGluc3RhbGxlZFxuICogcGx1Z2luIGBhcmd2WzFdYCBpcyBpbnNpZGUgYSBWRVJTSU9ORUQgY2FjaGUgZGlyZWN0b3J5LiBBbiB1cGdyYWRlIG1hcmtzIHRoZVxuICogb2xkIGRpcmVjdG9yeSBvcnBoYW5lZCBhbmQgZGVsZXRlcyBpdCBsYXRlciAobWVhc3VyZWQgaW5cbiAqIGBkb2NzL2JhY2tsb2cvMjAyNi0wOS0yNC10YWlsLXJlYXJtLWNvbW1hbmQtbmFtZXMtYS12ZXJzaW9uZWQtcGx1Z2luLXBhdGgubWRgKSxcbiAqIHNvIGEgbGluZSBwcmludGVkIGJlZm9yZSBhbiB1cGdyYWRlIGZpcnN0IHJhbiBTVEFMRSBjb2RlIGFnYWluc3QgYSBuZXdlclxuICogZGFlbW9uLCB0aGVuIGZhaWxlZCB3aXRoIFwibW9kdWxlIG5vdCBmb3VuZFwiIG9uY2UgdGhlIGRpcmVjdG9yeSB3YXMgZ29uZS4gTm9cbiAqIHN0YWJsZSBwYXRoIGV4aXN0cyB0byBwcmludCBpbnN0ZWFkOiB0aGUgY2FjaGUsIGAkQ0xBVURFX1BMVUdJTl9ST09UYCBhbmQgdGhlXG4gKiBpbnN0YWxsIHJlY29yZCBhcmUgYWxsIHZlcnNpb25lZC5cbiAqICAgVGhlIHNraWxsJ3MgbGF1bmNoZXIgaXMgYWx3YXlzIHRoZSB2ZXJzaW9uIHRoZSBzZXNzaW9uIGxvYWRlZC4gQ29sZSdzXG4gKiByZWFzb25pbmc6IHRoZSB3b3JzdCBjYXNlIGlzIHRoYXQgdGhlIENMSSBjaGFuZ2VkIGFuZCB0aGUgYWdlbnQgZ2V0cyBhblxuICogZXJyb3Ig4oCUIGFuZCBpZiB0aGUgdG9vbHMgYXJlIGRlc2lnbmVkIHJpZ2h0LCB0aGF0IGVycm9yIHNheXMgd2hhdCB3ZW50XG4gKiB3cm9uZy4gU28gdGhlIHBhcnNlcnMgYXJlIHRoZSBvdGhlciBoYWxmIG9mIHRoaXMgcnVsaW5nOiBgcmVhZFNpbmNlYCByZWZ1c2VzXG4gKiBhbnkgYC0tc2luY2VgIGZvcm0gYSB0YWlsIGRvZXMgbm90IGFjY2VwdCB3aXRoIGEgdXNhZ2UgZXJyb3IgTkFNSU5HIHRoZVxuICogZm9ybXMgaXQgZG9lcywgdGhlIHNhbWUgd2F5IG9uIGFsbCBlaWdodCB0YWlscywgaW5zdGVhZCBvZiBtaXNwYXJzaW5nIGl0LlxuICogICBOb3QgdGFrZW46IHByaW50aW5nIHRoZSBwYXRoIEFORCB0aGUgYXJncyAob3B0aW9uIEEgb2YgdGhlIGl0ZW0g4oCUIHR3b1xuICogY29tbWFuZHMgd2hlcmUgb25lIGlzIHdyb25nIGFmdGVyIGFuIHVwZ3JhZGUpOyBhIGxhdW5jaGVyIHRoYXQgbm90aWNlcyBpdCBpc1xuICogb3JwaGFuZWQgYW5kIHJlLWV4ZWNzIGEgbmV3ZXIgc2libGluZyAoQiDigJQgaXQgbGVhbnMgb24gYSBDbGF1ZGUgQ29kZVxuICogaW50ZXJuYWwgbWFya2VyIGFuZCBkb2VzIG5vdGhpbmcgb25jZSB0aGUgZGlyZWN0b3J5IGlzIGRlbGV0ZWQpOyB2ZXJzaW9uXG4gKiBuZWdvdGlhdGlvbi5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBDT01QTEVURSBCVVQgRk9SIFRIRSBMQVVOQ0hFUjogcGlubmVkIHRvIHRoZVxuICogICBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGUgc2tpbGxzIG5hbWUgdGhlXG4gKiAgIHJ1bGUgb25jZSwgbGF1bmNoZXIgZm9ybSBpbmNsdWRlZDsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBUaGUgb25lIHNlbnRlbmNlIGV2ZXJ5IGB0YWlsYCdzIGhlbHAgY2Fycmllcywgc28gYSBodW1hbiB3YXRjaGluZyBpbiBhXG4gKiAgdGVybWluYWwgZmluZHMgdGhlIGVzY2FwZSBoYXRjaCB3aGVyZSB0aGV5IGxvb2sgKEQ0KS4gV29yZGVkIG9uY2UgaGVyZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfSEVMUCA9XG4gIFwiZW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyAzMC1taW51dGUgY2FwIHdpdGggYSBsaW5lIG5hbWluZyB0aGUgbmV4dCBhY3Q7IGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCBrZWVwcyBpdCBvcGVuIHdpdGggU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBcIjtcblxuLyoqIENvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3cgdGhhdCBtYWtlIHRoZSBkYWVtb24gXCJsb3N0XCIgKHNlZSBBMikuIFRocmVlXG4gKiAgc3BhbiBhYm91dCAwLjc1IHMgdW5kZXIgdGhlIGtpdCdzIGRlZmF1bHQgYmFja29mZiAoMjUwICsgNTAwIG1zIGJldHdlZW5cbiAqICB0aGVtKTogYSBsaXZlIGRhZW1vbiBuZXZlciByZWZ1c2VzIGl0cyBvd24gcG9ydCwgYW5kIHRoZSB0d28gZXh0cmEgYXR0ZW1wdHNcbiAqICBvbmx5IGJ1eSB0b2xlcmFuY2UgZm9yIGEgcmVzdGFydCB0aGF0IHJlYmluZHMgdGhlIHNhbWUgcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBMT1NUX0FGVEVSX1JFRlVTQUxTID0gMztcblxuLyoqIFRoZSB3aW5kb3cgbGVuZ3RoOiB0aGUgZW52IHZhbHVlIHdoZW4gaXQgaXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZWxzZSB0aGVcbiAqICBkZWZhdWx0LiBgMGAgbWVhbnMgbm8gd2luZG93LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXaW5kb3dNcyhyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcudHJpbSgpID09PSBcIlwiKSByZXR1cm4gREVGQVVMVF9XSU5ET1dfTVM7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIobikgJiYgbiA+PSAwID8gbiA6IERFRkFVTFRfV0lORE9XX01TO1xufVxuXG5leHBvcnQgdHlwZSBUYWlsTW9kZSA9IFwid2F0Y2hcIiB8IFwib25jZVwiO1xuXG4vKiogSG93IGEgdGFpbCBlbmRlZC4gYHdpbmRvd2AgaXMgb3VyIG93biBkZWFkbGluZSwgYGV2ZW50YCBpcyBhIGAtLW9uY2VgJ3NcbiAqICBmaXJzdCBmcmFtZSwgYGNsb3NlZGAgaXMgdGhlIHNlc3Npb24gZW5kaW5nIChhIGBjbG9zZWRgIGZyYW1lIG9yIHRoZSBwaW5uZWRcbiAqICBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcpLCBgbG9zdGAgaXMgdGhlIGRhZW1vbiByZWZ1c2luZyBjb25uZWN0aW9ucyxcbiAqICBhbmQgYHN0b3BwZWRgIGlzIGEgc2lnbmFsLCBhIGNhbGxlcidzIGFib3J0IG9yIGEgY2xvc2VkIHN0ZG91dC4gKi9cbmV4cG9ydCB0eXBlIFRhaWxFbmQgPSBcIndpbmRvd1wiIHwgXCJldmVudFwiIHwgXCJjbG9zZWRcIiB8IFwibG9zdFwiIHwgXCJzdG9wcGVkXCI7XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZJbnB1dCA9IHtcbiAgLyoqIFRoZSBzcGVsbCB3aG9zZSB0YWlsIHRoaXMgaXMsIHNvIHRoZSBhZ2VudCBrbm93cyB3aG9zZSBsYXVuY2hlciBydW5zIGl0LiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBlbmQ6IFRhaWxFbmQ7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogVGhlIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaC4gKi9cbiAgZXBvY2g/OiBzdHJpbmc7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiBgZXBvY2hgIGlzIHRoZVxuICAgKiAgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZTogYSBzcGVsbCB3aG9zZVxuICAgKiAgYC0tc2luY2VgIHBhcnNlcyBgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSBwcmludHMgaXQuICovXG4gIHRhaWw6IChvOiB7IHNpbmNlOiBudW1iZXI7IG9uY2U6IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIC8qKiBXaG9zZSBsYXVuY2hlciBydW5zIGBjb21tYW5kYC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZXZlbnRzOiBudW1iZXI7XG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogYG1vbml0b3JgOiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYC5cbiAgICogIGBiYWNrZ3JvdW5kYDogcnVuIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrLlxuICAgKiAgYHN0b3BgOiBub3RoaW5nIHRvIHdhdGNoOyBgY29tbWFuZGAgaXMgaG93IHRvIGNvbWUgYmFjaywgaWYgd2FudGVkLiAqL1xuICBuZXh0OiBcIm1vbml0b3JcIiB8IFwiYmFja2dyb3VuZFwiIHwgXCJzdG9wXCI7XG4gIC8qKiBUaGUgdmVyYiBhbmQgaXRzIGFyZ3VtZW50cyBPTkxZIOKAlCBubyBsYXVuY2hlciwgbm8gcGF0aC4gVGhlIGFnZW50IHJ1bnNcbiAgICogIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPmAuICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgaGludDogc3RyaW5nO1xufTtcblxuLyoqIEhvdyB0aGUgYWdlbnQgcnVucyBhIHByaW50ZWQgYGNvbW1hbmRgOiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIG5ldmVyIGEgcGF0aFxuICogIHRoaXMgcHJvY2VzcyBuYW1lcyAodGhlIHJ1bGluZyBvbiB0aGUgdmVyc2lvbmVkIHBsdWdpbiBwYXRoLCBpbiB0aGUgaGVhZGVyKS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fV0lUSF9MQVVOQ0hFUiA9IFwiYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5cIjtcblxuLyoqIFRoZSBjb21lLWJhY2sgaGludCwgd2l0aCBob3cgdG8gUkVTVU1FIGFmdGVyIGNvbWluZyBiYWNrIChEMik6IGEgcmVzdG9yZWRcbiAqICBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBtZWFucyBub3RoaW5nIHRoZXJlLiAqL1xuY29uc3QgQ09NRV9CQUNLID0gKHdoeTogc3RyaW5nKSA9PlxuICBgJHt3aHl9IFRvIGJyaW5nIGl0IGJhY2ssIHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfTsgdGhlbiBhcm0gdGhlIHRhaWwgYWdhaW4gd2l0aCBubyAtLXNpbmNlLCBvbiB0aGUgc2Vzc2lvbiBpZCBpdCBwcmludHMgd2hlcmUgdGhlcmUgaXMgb25lIChhIHJlc3RhcnRlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBkb2VzIG5vdCBhcHBseSlgO1xuXG4vKipcbiAqIFRIRSBERUNJU0lPTjogZ2l2ZW4gaG93IHRoZSB0YWlsIGVuZGVkLCB3aGljaCBsaW5lIGl0IHByaW50cy4gUHVyZSwgc28gZXZlcnlcbiAqIHN0YXRlIGlzIGEgbGl0ZXJhbCBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4gUmV0dXJucyBudWxsIGZvciBgc3RvcHBlZGA6XG4gKiBhIGh1bWFuJ3MgQ3RybC1DIG9yIGEgY2FsbGVyJ3MgYWJvcnQgaXMgbm90IGEgaGFuZG9mZi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhbmRvZmYoczogSGFuZG9mZklucHV0LCBjbWQ6IEhhbmRvZmZDb21tYW5kcyk6IEhhbmRvZmZMaW5lIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSB7IHNwZWxsOiBzLnNwZWxsLCBldmVudHM6IHMuZXZlbnRzLCBjdXJzb3I6IHMuY3Vyc29yIH07XG4gIHN3aXRjaCAocy5lbmQpIHtcbiAgICBjYXNlIFwic3RvcHBlZFwiOlxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgY2FzZSBcImNsb3NlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmNsb3NlZFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoe1xuICAgICAgICAgICAgc2luY2U6IHMuY3Vyc29yLFxuICAgICAgICAgICAgb25jZTogZmFsc2UsXG4gICAgICAgICAgICAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoaW50OiBgdGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYG5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9IGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2sgKHJ1bl9pbl9iYWNrZ3JvdW5kKSDigJQgaXQgZXhpdHMgb24gdGhlIG5leHQgZXZlbnRgLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQgYWZ0ZXIgdGhlIGFnZW50J3Mgb3duIGxhdW5jaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoZWxsUXVvdGUoYXJnOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bQS1aYS16MC05X0AlKz06LC4vLV0rJC8udGVzdChhcmcpID8gYXJnIDogYCcke2FyZy5yZXBsYWNlQWxsKFwiJ1wiLCBgJ1xcXFwnJ2ApfSdgO1xufVxuXG4vKipcbiAqIFJlYWQgYSBgLS1zaW5jZWAgdmFsdWU6IGFuIGV2ZW50IGlkLCBvcHRpb25hbGx5IGNhcnJ5aW5nIHRoZSBlcG9jaCBvZiB0aGVcbiAqIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgRDIpLiBOdWxsIHdoZW4gdGhlIGlkIGlzIG5vdCBhbiBpbnRlZ2VyLlxuICogRm9yIHRoZSBzcGVsbHMgd2hvc2UgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaDsgdGhlIHJlc3QgdGFrZSBhIHBsYWluIGlkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCb29rbWFyayh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGF0ID0gdG9rZW4uaW5kZXhPZihcIkBcIik7XG4gIGNvbnN0IGlkID0gYXQgPT09IC0xID8gdG9rZW4gOiB0b2tlbi5zbGljZSgwLCBhdCk7XG4gIGNvbnN0IGVwb2NoID0gYXQgPT09IC0xID8gXCJcIiA6IHRva2VuLnNsaWNlKGF0ICsgMSk7XG4gIGlmICghL14tP1xcZCskLy50ZXN0KGlkLnRyaW0oKSkpIHJldHVybiBudWxsO1xuICBpZiAoYXQgIT09IC0xICYmIGVwb2NoID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc2luY2U6IE51bWJlci5wYXJzZUludChpZCwgMTApLCAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSkgfTtcbn1cblxuLyoqXG4gKiBFdmVyeSB0YWlsJ3MgYC0tc2luY2VgLCByZWFkIHRoZSBzYW1lIHdheTogYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cywgb3IgYVxuICogcmVmdXNhbCB0aGF0IE5BTUVTIHRoZSBhY2NlcHRlZCBmb3Jtcy4g4puUIE5FVkVSIEEgU0lMRU5UIE1JU1BBUlNFLiBUaGUgZm91clxuICogbm8tZXBvY2ggc3BlbGxzIHVzZWQgYHBhcnNlSW50YCwgd2hpY2ggcmVhZCBhbiBlcG9jaCBib29rbWFyayAoYDRAZTFgLCBmcm9tXG4gKiBhIGhhbmRvZmYgbGluZSBhbm90aGVyIHZlcnNpb24gb3Igc3BlbGwgcHJpbnRlZCkgYXMgYDRgIGFuZCBkcm9wcGVkIHRoZVxuICogcmVzdCB3aXRob3V0IGEgd29yZDsgbWluZC1tYXBwZXIgcmVhZCBqdW5rIGFzIDAgYW5kIGFzdHJvbGFiZSBhcyAtMSwgYm90aCBhXG4gKiB3aG9sZSByZXBsYXkuIEEgcHJpbnRlZCBjb21tYW5kIG91dGxpdmVzIHRoZSBDTEkgdGhhdCBwcmludGVkIGl0ICh0aGVcbiAqIGxhdW5jaGVyLWZyZWUgcnVsaW5nLCBpbiB0aGUgaGVhZGVyKSwgc28gdGhlIHBhcnNlciBpcyB3aGVyZSBhbiBvbGRlciBvclxuICogbmV3ZXIgZm9ybSBtdXN0IHNheSB3aGF0IHdlbnQgd3JvbmcuXG4gKlxuICogYGVwb2NoYDogd2hldGhlciB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBvbmUgKHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUsXG4gKiBtaW5kLW1hcHBlcikuIGBtaW5gOiB0aGUgc21hbGxlc3QgaWQgYWNjZXB0ZWQgKGdyYXBldmluZSB0YWtlcyBubyAtMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkU2luY2UoXG4gIHRva2VuOiBzdHJpbmcsXG4gIG86IHsgZXBvY2g6IGJvb2xlYW47IG1pbj86IG51bWJlciB9LFxuKTogeyBvazogdHJ1ZTsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IHsgb2s6IGZhbHNlOyBtZXNzYWdlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1pbiA9IG8ubWluID8/IC0xO1xuICBjb25zdCBiID0gcGFyc2VCb29rbWFyayh0b2tlbik7XG4gIGlmIChiICE9PSBudWxsICYmIGIuc2luY2UgPj0gbWluICYmIChiLmVwb2NoID09PSB1bmRlZmluZWQgfHwgby5lcG9jaCkpXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNpbmNlOiBiLnNpbmNlLCAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSB9O1xuICBjb25zdCBpZCA9XG4gICAgbWluIDwgMFxuICAgICAgPyBcImFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyOyAtLXNpbmNlPS0xIGZvciBldmVyeXRoaW5nKVwiXG4gICAgICA6IGBhbiBldmVudCBpZCAoYW4gaW50ZWdlciwgJHttaW59IG9yIG1vcmUpYDtcbiAgY29uc3QgZm9ybXMgPSBvLmVwb2NoID8gYCR7aWR9LCBvciA8aWQ+QDxlcG9jaD4gYXMgYSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0YCA6IGlkO1xuICBjb25zdCB3aHkgPVxuICAgICFvLmVwb2NoICYmIHRva2VuLmluY2x1ZGVzKFwiQFwiKVxuICAgICAgPyBgOyB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBubyBlcG9jaCwgc28gcGFzcyB0aGUgaWQgd2l0aG91dCB0aGUgXCJA4oCmXCIgcGFydGBcbiAgICAgIDogXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgbWVzc2FnZTogYC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cyDigJQgZ2l2ZSAke2Zvcm1zfSR7d2h5fWAsXG4gIH07XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogVGhlIHJlLWFybSBmb3IgYSBzcGVsbCB3aG9zZSB0YWlsIGlzIGA8cHJlZml44oCmPiAtLXNpbmNlIE5bQGVwb2NoXSBbLS1vbmNlXWAuXG4gKiAgUGFzcyBgZXBvY2hgIG9ubHkgZm9yIGEgc3BlbGwgd2hvc2UgYC0tc2luY2VgIHBhcnNlcyBpdCAoYHBhcnNlQm9va21hcmtgKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChcbiAgcHJlZml4OiByZWFkb25seSBzdHJpbmdbXSxcbiAgc2luY2U6IG51bWJlcixcbiAgb25jZTogYm9vbGVhbixcbiAgZXBvY2g/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICAvLyDimqAgQSBuZWdhdGl2ZSBib29rbWFyayAobm90aGluZyBzZWVuIHlldCkgaXMgc3BlbGxlZCBgLS1zaW5jZT0tMWA6IHRoZVxuICAvLyBwYXJzZXJzIHJlYWQgYSBiYXJlIGAtMWAgYWZ0ZXIgYSBmbGFnIGFzIGFub3RoZXIgZmxhZyBhbmQgcmVmdXNlIGl0LlxuICBjb25zdCBtYXJrID0gZXBvY2ggPyBgJHtzaW5jZX1AJHtlcG9jaH1gIDogU3RyaW5nKHNpbmNlKTtcbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHttYXJrfWBdIDogW1wiLS1zaW5jZVwiLCBtYXJrXTtcbiAgcmV0dXJuIGNvbW1hbmRMaW5lKFsuLi5wcmVmaXgsIC4uLmF0LCAuLi4ob25jZSA/IFtcIi0tb25jZVwiXSA6IFtdKV0pO1xufVxuXG5leHBvcnQgdHlwZSBIYW5kb2ZmT3B0aW9uczxFdj4gPSB7XG4gIC8qKiBUaGUgc3BlbGwncyBuYW1lLCBjYXJyaWVkIG9uIHRoZSBsaW5lICh3aG9zZSBsYXVuY2hlciBydW5zIGl0KS4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgY29tbWFuZHM6IEhhbmRvZmZDb21tYW5kcztcbn07XG5cbi8qKlxuICogUnVuIGB0YWlsRXZlbnRzYCB3aXRoIHRoZSBoYW5kb2ZmOiB0aGUgd2luZG93LCBgLS1vbmNlYCwgdGhlIGxvc3QgcnVsZSwgYW5kXG4gKiB0aGUgZmluYWwgbGluZS4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLCBsaWtlIGB0YWlsRXZlbnRzYCwgYW5kIG5ldmVyIGV4aXRzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbFdpdGhIYW5kb2ZmPEV2PihcbiAgdGFpbDogVGFpbE9wdGlvbnM8RXY+LFxuICBoOiBIYW5kb2ZmT3B0aW9uczxFdj4sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSB0YWlsLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3Qgd2luZG93TXMgPSBoLndpbmRvd01zID8/IHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSk7XG4gIGNvbnN0IGNvdW50cyA9IGguY291bnRzID8/ICgoKSA9PiB0cnVlKTtcbiAgY29uc3QgZW5kT25Mb3N0ID0gIWgucHJlc2VuY2U7XG5cbiAgY29uc3QgYWMgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBhYy5hYm9ydCgpO1xuICB0YWlsLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAodGFpbC5zaWduYWw/LmFib3J0ZWQpIGFjLmFib3J0KCk7XG5cbiAgbGV0IGV2ZW50cyA9IDA7XG4gIGxldCBjdXJzb3IgPSB0YWlsLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZCA9IHRhaWwuc2luY2VFcG9jaDtcbiAgbGV0IGZyYW1lSGFzSWQgPSBmYWxzZTtcbiAgLyoqIEEzICsgRDM6IGEgZnJhbWUgY291bnRzLCBhbmQgd2FrZXMgYSBgLS1vbmNlYCwgb25seSB3aGVuIGl0IGlzIE9OIFRIRVxuICAgKiAgTE9HIOKAlCBpdCBjYXJyaWVzIGEgbG9nIGlkIOKAlCBhbmQgdGhlIHNwZWxsJ3Mgb3duIGBjb3VudHNgIGFncmVlcy4gQSB0YWInc1xuICAgKiAgaWQtbGVzcyBgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCBwaW5nIGlzIG5vdCBvbiB0aGUgbG9nLiAqL1xuICBjb25zdCBpc0xvZ0ZyYW1lID0gKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBmcmFtZUhhc0lkICYmIGNvdW50cyhldiwgZnJhbWUpO1xuICBsZXQgZW5kOiBUYWlsRW5kIHwgbnVsbCA9IG51bGw7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICAvLyBEMidzIG5ldC4gT24gZm9yIGV2ZXJ5IHNwZWxsOiBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3JcbiAgICAgIC8vIG1lYW5zIGEgd2hvbGUgcmVwbGF5IG9uIHRoZSBraXQncyBsb2csIGFuZCBvbiBncmFwZXZpbmUncyBkdXJhYmxlIGxvZ1xuICAgICAgLy8gaXQgaGFwcGVucyBvbmx5IHdoZW4gYC0tbGFzdGAgcmVhY2hlcyBiZWxvdyBgLS1zaW5jZWAsIHdoZXJlXG4gICAgICAvLyByZS1yZWFkaW5nIHRoZSBjdXJzb3IgZnJvbSB0aGUgZnJhbWVzIGlzIHRoZSBtb3JlIGNvcnJlY3QgYW5zd2VyLlxuICAgICAgcmVzdGFydE9uUmVwbGF5OiB0cnVlLFxuICAgICAgLy8gRDM6IHJlbWVtYmVyIHdoZXRoZXIgVEhJUyBmcmFtZSBjYXJyaWVzIGEgbG9nIGlkLiBgdGFpbEV2ZW50c2AgcmVhZHNcbiAgICAgIC8vIHRoZSBjdXJzb3Igb25jZSBwZXIgZnJhbWUsIGJlZm9yZSBgYWNjZXB0YCwgYHRlcm1pbmFsYCBhbmQgYHJlbmRlcmAuXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGNvbnN0IG4gPSB0YWlsLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICBmcmFtZUhhc0lkID0gdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pO1xuICAgICAgICByZXR1cm4gbjtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCB0aGF0IGdpdmVzIHVwIG9uIGZpbmRpbmcgaXRzIHNlc3Npb24gaXMgd2F0Y2hpbmcgYVxuICAgICAgICAvLyBzZXNzaW9uIHRoYXQgaXMgZ29uZSDigJQgd2hldGhlciB0aGlzIHByb2Nlc3MgZXZlciByZWFjaGVkIGl0IChpdHNcbiAgICAgICAgLy8gcG9pbnRlciB2YW5pc2hlZCkgb3IgaXQgd2FzIHJlLWFybWVkIGF0IG9uZSB0aGF0IGNsb3NlZCBpbiB0aGUgZ2FwLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgZW5kID09PSBudWxsKSBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSBldmVudHMgKz0gMTtcbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgdGVybWluYWw6IChldiwgZnJhbWUsIGFjY2VwdGVkKSA9PiB7XG4gICAgICAgIGlmICh0YWlsLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSAoaC5pc0Nsb3NlZCA/PyAoKCkgPT4gdHJ1ZSkpKGV2KSA/IFwiY2xvc2VkXCIgOiBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGgubW9kZSA9PT0gXCJvbmNlXCIgJiYgYWNjZXB0ZWQgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgcmV0dXJuIHRhaWwub25Db21tZW50Py4odGV4dCkgPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLm9uRGlzY29ubmVjdD8uKGluZm8pID8/IG51bGw7XG4gICAgICAgIGlmIChpbmZvLmNhdXNlID09PSBcImNvbm5lY3QtZmFpbGVkXCIpIHtcbiAgICAgICAgICByZWZ1c2FscyArPSAxO1xuICAgICAgICAgIGlmIChlbmRPbkxvc3QgJiYgcmVmdXNhbHMgPj0gTE9TVF9BRlRFUl9SRUZVU0FMUykgZmluaXNoKFwibG9zdFwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUaGUgZGFlbW9uIGFuc3dlcmVkIChhIHN0YXR1cywgb3IgYSBzdHJlYW0gdGhhdCBvcGVuZWQgYW5kIHRoZW5cbiAgICAgICAgICAvLyBlbmRlZCk6IGl0IGlzIGFsaXZlLCBzbyB0aGUgcmVmdXNhbHMgd2VyZSBub3QgaW4gYSByb3cuXG4gICAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIG9uRW5kOiAocykgPT4ge1xuICAgICAgICBjdXJzb3IgPSBzLmN1cnNvcjtcbiAgICAgICAgZXBvY2ggPSBzLmVwb2NoID8/IHVuZGVmaW5lZDtcbiAgICAgICAgdGFpbC5vbkVuZD8uKHMpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaW5lID0gaGFuZG9mZihcbiAgICAgIHtcbiAgICAgICAgZW5kOiBlbmQgPz8gXCJzdG9wcGVkXCIsXG4gICAgICAgIG1vZGU6IGgubW9kZSxcbiAgICAgICAgZXZlbnRzLFxuICAgICAgICBjdXJzb3IsXG4gICAgICAgIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgcHJlc2VuY2U6IGgucHJlc2VuY2UsXG4gICAgICAgIHNwZWxsOiBoLnNwZWxsLFxuICAgICAgfSxcbiAgICAgIGguY29tbWFuZHMsXG4gICAgKTtcbiAgICBpZiAobGluZSAhPT0gbnVsbCkgb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGxpbmUpfVxcbmApO1xuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0YWlsLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBHcmFwZXZpbmUncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIG9mIHRoZSBzcGVsbCwgYW5kIFRIRSBPTkUgUExBQ0UgVEhFIEVOViBJUyBSRUFELlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0sIEFORCBGT1IgR1JBUEVWSU5FIFRIRSBTRUFNIElTIFJFQUwg4oCUIHRoZSBmaXJzdCB0aW1lXG4gKiBpbiBmb3VyIHBvcnRzIChwbGF5Ym9vayBCOCwgZW50cnktYmxvY2sgcXVlc3Rpb24gMykuIEJlZm9yZSBQaGFzZSA2IHRoZVxuICogaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDMwMDBgIGluc2lkZSBgZGFlbW9uLnRzYCdzIFNTRSBzdHJlYW0sIGBpZGxlVGltZW91dDpcbiAqIDI1NWAgd2FzIGEgc2Vjb25kIGxpdGVyYWwgdGVuIGxpbmVzIGF3YXkgd2l0aCB0aGUgcmVsYXRpb25zaGlwIHdyaXR0ZW4gb25seSBpblxuICogcHJvc2UsIGFuZCBgY2xpLnRzYCdzIHRhaWwgaGFkIE5PIHdhdGNoZG9nIGF0IGFsbCDigJQgaXQgYmxvY2tlZCBvblxuICogYHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIHRoZSBraXQncyB3YXRjaGRvZyBleGlzdHMgdG9cbiAqIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uXG4gKiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHNcbiAqIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqIEEgdmFsdWUgdGhhdCBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBHUkFQRVZJTkUnUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgdGhlIHJ1bGUgYXN0cm9sYWJlIHBhaWQgZm9yOiBhIGhhcmQtY29kZWQgNDUgc1xuICogd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcyxcbiAqICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZVxuICogYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4g4pqgIEdyYXBldmluZSBpcyB0aGUgc3BlbGwgdGhhdFxuICogbWFrZXMgdGhlIHBvaW50IHNoYXJwZXN0OiBpdCBiZWF0cyBhdCAqKjMgcyoqLCBhIGZpZnRoIG9mIHRoZSBob3VzZSBkZWZhdWx0LFxuICogc28gYSBjb3BpZWQgNDUsMDAwIHdvdWxkIHRvbGVyYXRlIEZJRlRFRU4gbWlzc2VkIGJlYXRzIHdoZXJlIGV2ZXJ5IHNpYmxpbmdcbiAqIHRvbGVyYXRlcyB0aHJlZS4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBiZWF0IGl0XG4gKiBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDim5QgKipBTkQgXCJXSEFURVZFUiBUSEUgQkVBVCBCRUNPTUVTXCIgSVMgV0hZIFRIRSBFTlYgSVMgUkVTT0xWRUQgSEVSRSBBTkRcbiAqIE5PV0hFUkUgRUxTRSAoRDc1KS4gVEhFIFBPUlQgUkUtQ1JFQVRFRCBBU1RST0xBQkUnUyBERUZFQ1QgSU4gVEhJUyBGSUxFLioqXG4gKiBDaGFwdGVyIDIgc2hpcHBlZCBgSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMocHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hFQVJUQkVBVF9NUyxcbiAqIOKApilgIGF0IGBkYWVtb24udHM6MTEyYCB3aGlsZSB0aGlzIGZpbGUga2VwdCBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWBcbiAqIGFnYWluc3QgdGhlIExJVEVSQUwgMywwMDA6IHRoZSBkYWVtb24ncyBiZWF0IHdhcyB0dW5hYmxlIGFuZCB0aGUgQ0xJJ3NcbiAqIHdhdGNoZG9nIHdhcyBub3QsIHNvICoqYW55IHZhbHVlIGFib3ZlIDMsMDAwIGJyb2tlIGV2ZXJ5IHRhaWwuKiogTUVBU1VSRUQgYXRcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTIwMDAwYCBhZ2FpbnN0IGEgaGVhbHRoeSBkYWVtb24sIGJlZm9yZSB0aGUgcmVwYWlyOiBhXG4gKiByZWFsIGBjbGkudHMgdGFpbGAgcmUtc3Vic2NyaWJlZCAqKjQgdGltZXMgaW4gMzAgcyoqICh+OSBzIGFwYXJ0LCBpdHMgd2F0Y2hkb2dcbiAqIGZpcmluZyBiZWZvcmUgYSBzaW5nbGUgMjAgcyBiZWF0IGNvdWxkIGxhbmQg4oCUICoqMCBrZWVwYWxpdmVzIGFycml2ZWQqKiksIGFuZFxuICogYC9jaGFubmVscy93ZC9zdWJzY3JpYmVyc2AgcmVwb3J0ZWQgYGNvdW50OiAyLCBjb25uZWN0aW9uczogMiwgbmFtZWQ6IDJgIGZvclxuICogKipvbmUqKiBsaXZlIHRhaWwsIGJlY2F1c2UgdGhlIGFiYW5kb25lZCBzdHJlYW1zIGFyZSBub3QgcmVhcGVkIHVudGlsIHRoZVxuICogbm93LTIwIHMgYmVhdCBmYWlscyB0byBlbnF1ZXVlLiBUaGF0IGlzIHRoZSBhc3Ryb2xhYmUgc2NhciB0d28gcGFyYWdyYXBocyB1cCxcbiAqIHJlLWNyZWF0ZWQgaW5zaWRlIHRoZSBmaWxlIHRoYXQgZG9jdW1lbnRzIGl0LiAqKk9uZSBoYWxmIG9mIHRoZSBwYWlyIHR1bmFibGVcbiAqIGFuZCB0aGUgb3RoZXIgYSBjb25zdGFudCBJUyB0aGUgZGVmZWN0Kiog4oCUIHRoZSBkZXJpdmF0aW9uIG9ubHkgaG9sZHMgaWYgaXRcbiAqIGRlcml2ZXMgZnJvbSB0aGUgdmFsdWUgdGhhdCBhY3R1YWxseSBzaGlwcGVkLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqIGBwcm9jZXNzLmVudmAgaXMgbm90IHN1Y2ggYW4gaW1wb3J0OiBpdCBpcyBhbWJpZW50IGluIGJvdGggaGFsdmVzLCB3aGljaCBpc1xuICogZXhhY3RseSB3aHkgdGhpcyBmaWxlIOKAlCBhbmQgbm90IGBkYWVtb24udHNgIOKAlCBjYW4gaG9sZCB0aGUgcmVzb2x1dGlvbi4gKFRoaXNcbiAqIGlzIGJvdW50eSdzIHNoYXBlLCB1bmNoYW5nZWQ6IGBzcmMvYm91bnR5L2JhY2tlbmQvaGVhcnRiZWF0LnRzYCByZXNvbHZlc1xuICogYEJPVU5UWV9JRExFX1RJTUVPVVRfU0VDYCBhbmQgYEJPVU5UWV9IRUFSVEJFQVRfTVNgIGluIHRoZSBzZWFtIGZpbGUgZm9yIHRoZVxuICogc2FtZSByZWFzb24uKVxuICovXG5cbmltcG9ydCB7XG4gIGhlYXJ0YmVhdE1zLFxuICBpZGxlVGltZW91dFNlYyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtLCBpbiBzZWNvbmRzLiBHcmFwZXZpbmUncyBvd24gbWVhc3VyZWQgdmFsdWUsIG5vdCBhbiBpbmhlcml0ZWRcbiAqIG9uZTogYGRhZW1vbi50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50IHJlY29yZGluZyB0aGF0XG4gKiBCdW4ncyBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhc1xuICogc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcyDigJQgYW5kIHRoYXQgYDBgIGlzIG5vdCBcImRpc2FibGVkXCIsIGl0IGlzIHRoZVxuICogZGVmYXVsdC5cbiAqXG4gKiDimqAgYEdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDYCBpcyBhY2NlcHRlZCBzbyB0aGUgUEFJUiBjYW4gYmUgdHVuZWQgdG9nZXRoZXIsXG4gKiBhbmQgdGhlIGNsYW1wIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuIChUaGlzIGZpbGUgdXNlZCB0byBzYXlcbiAqIGdyYXBldmluZSBcImRvZXMgbm90IGVudi10dW5lIGl0XCIgd2hpbGUgYGRhZW1vbi50c2AgZW52LXR1bmVkIGl0IHRlbiBsaW5lcyBmcm9tXG4gKiB3aGVyZSBpdCBpbXBvcnRlZCB0aGlzIGNvbnN0YW50IOKAlCB0aGUgc2FtZSBvbmUtaGFsZi10dW5hYmxlIHNwbGl0IGFzIHRoZSBiZWF0LFxuICogYW5kIGNvcnJlY3RlZCBpbiB0aGUgc2FtZSBjaGFwdGVyLilcbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBpZGxlVGltZW91dFNlYyhcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqXG4gKiBUaGUgU1NFIGtlZXBhbGl2ZSwgaW4gbXMg4oCUIHRoZSBERUZBVUxULCBiZWZvcmUgdGhlIGVudiBpcyBjb25zdWx0ZWQuXG4gKiDimqAgKiozIHMsIGFuZCBpdCBpcyBOT1QgdGhlIGhvdXNlIGRlZmF1bHQgb2YgMTUgcyoqIOKAlCBncmFwZXZpbmUgaXMgdGhlIG9ubHlcbiAqIHNwZWxsIGluIHRoZSByb3N0ZXIgdGhhdCBiZWF0cyB0aGlzIGZhc3QsIGFuZCB0aGUgbnVtYmVyIGlzIGxvYWQtYmVhcmluZ1xuICogcmF0aGVyIHRoYW4gaW5jaWRlbnRhbDogdGhlIGJlYXQgaXMgYWxzbyBncmFwZXZpbmUncyBkZWFkLXN1YnNjcmliZXIgcHJvYmUuIEFcbiAqIHRhaWwgd2hvc2Ugc29ja2V0IGhhcyBnb25lIGF3YXkgaXMgZGlzY292ZXJlZCB3aGVuIHRoZSBlbnF1ZXVlIGZhaWxzLCBhbmRcbiAqIHVudGlsIGl0IGlzIGRpc2NvdmVyZWQgYHdob2AsIGAvcHJlc2VuY2VgIGFuZCBldmVyeSBzZW5kJ3MgcmVjaXBpZW50IGNvdW50XG4gKiByZXBvcnQgYSBnaG9zdC4gRXZlcnkgb3RoZXIgc3BlbGwncyBoZWFydGJlYXQgb25seSBoYXMgdG8ga2VlcCBhIGNvbm5lY3Rpb25cbiAqIG9wZW47IHRoaXMgb25lIGFsc28gaGFzIHRvIGtlZXAgYSBST1NURVIgaG9uZXN0LCB3aGljaCBpcyBhIGh1bWFuLXZpc2libGVcbiAqIG51bWJlciBpbiB0aGUgd2F0Y2ggc3VyZmFjZS4g4puUICoqU28gcmFpc2luZyB0aGlzIGtub2IgbWFrZXMgcHJlc2VuY2VcbiAqIHN0YWxlciwgbm90IGp1c3QgcXVpZXRlcioqIOKAlCBpdCBpcyB0aGUgb25lIHRoaW5nIGFuIG9wZXJhdG9yIHR1bmluZyBpdCBzaG91bGRcbiAqIGtub3cuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMgPSAzXzAwMDtcblxuLyoqXG4gKiBUaGUgYmVhdCBhcyBpdCB3aWxsIGFjdHVhbGx5IGJlIHVzZWQsIGVudi1yZXNvbHZlZCBhbmQgY2xhbXBlZCBhdCBib3RoIGVuZHMgYnlcbiAqIHRoZSBraXQ6IG5ldmVyIGFib3ZlIGBJRExFX1RJTUVPVVRfU0VDIC8gMmAgKG9yIEJ1biBjbG9zZXMgdGhlIGNvbm5lY3Rpb24gdGhlXG4gKiBrZWVwYWxpdmUgd2FzIHByZXNlcnZpbmcpLCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICog4puUIFRIRSBGTE9PUiBJUyBOT1QgREVDT1JBVElPTiAoRDc2KS4gYGludE9yYCBwYXJzZXMgd2l0aCBgcGFyc2VJbnRgLCB3aGljaFxuICogcmVhZHMgYFwiMWU5XCJgIOKAlCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0IGh1Z2VcIiDigJQgYXMgKioxKiouXG4gKiBEcml2ZW4gYmVmb3JlIHRoZSBmbG9vciBleGlzdGVkOiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4XG4gKiBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRSBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAg4oaSIDMgbXMgYW5kXG4gKiBgXCI1YWJjXCJgIOKGkiA1IG1zIGFycml2ZSB0aGUgc2FtZSB3YXkuIFRoZSBmbG9vciBsaXZlcyBpbiB0aGUga2l0J3NcbiAqIGBoZWFydGJlYXRNc2AgYmVzaWRlIHRoZSBjZWlsaW5nIGl0IGNhbm5vdCBjcm9zcywgTk9UIGluIGBpbnRPcmAsIHdoaWNoIGV2ZXJ5XG4gKiBvdGhlciBrbm9iIGluIHRoZSBob3VzZSBzaGFyZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC4gOSwwMDAgbXMgYXQgdGhlIGRlZmF1bHQuXG4gKlxuICog4puUICoqVEhFIFRBSUwgSEFEIE5PIFdBVENIRE9HIEFUIEFMTCBCRUZPUkUgVEhJUy4qKiBgY21kVGFpbGAncyBpbm5lciBsb29wXG4gKiBhd2FpdGVkIGByZWFkZXIucmVhZCgpYCB3aXRoIG5vdGhpbmcgYm91bmRpbmcgaXQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlclxuICogbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYSBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSIOKAlCBhbmRcbiAqIGEgcGFya2VkIHRhaWwgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHF1aWV0IGNoYW5uZWwsIHdoaWNoIGlzIHRoZSBzdGF0ZVxuICogZ3JhcGV2aW5lJ3MgY2FsbGVycyBzcGVuZCBtb3N0IG9mIHRoZWlyIHRpbWUgaW4uXG4gKlxuICog4pqgIDkgcyBpcyBhZ2dyZXNzaXZlIGJ5IGhvdXNlIHN0YW5kYXJkcyAoNDUgcyBldmVyeXdoZXJlIGVsc2UpIGFuZCB0aGF0IGlzIHRoZVxuICogZGVyaXZhdGlvbiB3b3JraW5nLCBub3QgYSBtaXN0YWtlOiBpdCBpcyB0aHJlZSBvZiBUSElTIHNwZWxsJ3MgYmVhdHMuIEhvbGRpbmdcbiAqIHRoZSBjb25uZWN0aW9uIG9wZW4gSVMgYSB0YWlsJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzXG4gKiBhIG5hbWUgaW4gYSBodW1hbidzIHJvc3RlciDigJQgd2hpY2ggaXMgd2h5IGl0IGlzIHRocmVlIGJlYXRzIGFuZCBub3QgdHdvLlxuICpcbiAqIOKblCBERVJJVkVEIEZST00gVEhFIFJFU09MVkVEIEJFQVQsIE5FVkVSIEZST00gVEhFIERFRkFVTFQuIEl0IGlzXG4gKiBgU1NFX0hFQVJUQkVBVF9NU2AgYWJvdmUgYW5kIG5vdCBgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TYCBvbiBwdXJwb3NlOyB0aGVcbiAqIHJlcGFpciBjaGFwdGVyIGlzIHdoYXQgdGhlIGRpZmZlcmVuY2UgY29zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVB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QUFJO0FBQUE7QUFHcEMsZUFBZSxVQUFVLENBQUMsTUFBbUIsTUFBaUM7QUFBQSxFQUM1RSxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsS0FDRCxFQUFFLFlBQVksTUFBTSxJQUFJLFdBQVcsTUFBTSxJQUFJO0FBQUEsSUFDOUMsT0FBTyxHQUFHO0FBQUEsSUFDVixJQUFJLEVBQUUsYUFBYTtBQUFBLE1BQWEsTUFBTTtBQUFBLElBQ3RDLEtBQUksRUFBRSxTQUFTLFNBQVMsRUFBRSxLQUFLO0FBQUE7QUFBQSxFQU9qQyxNQUFNLFdBQVcsS0FBSyxZQUFZLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFO0FBQUEsRUFDNUQsTUFBTSxXQUFXLEtBQUssWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFBQSxFQUN4RCxJQUFJLFdBQVcsU0FBUyxVQUFVO0FBQUEsSUFDaEMsTUFBTSxVQUFVLEtBQUssWUFBWSxXQUFXO0FBQUEsSUFDNUMsS0FBSSxHQUFHLEtBQUssMkJBQTJCLFNBQVMsUUFBUSxlQUFlLFNBQVM7QUFBQSxNQUM5RSxNQUFNLFlBQVksS0FBSyxRQUFRLEtBQUssWUFDakMsSUFBSSxDQUFDLE1BQU8sRUFBRSxXQUFXLElBQUksRUFBRSxVQUFVLElBQUksRUFBRSxPQUFRLEVBQ3ZELEtBQUssR0FBRztBQUFBLElBQ2IsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUNBLElBQUksQ0FBQyxZQUFZLFdBQVcsU0FBUyxLQUFLLFlBQVksUUFBUTtBQUFBLElBQzVELEtBQ0UsR0FBRyxLQUFLLDZCQUE2QixLQUFLLFVBQVUsV0FBVyxLQUFLLFlBQVksT0FBTyxLQUN2RixTQUNBO0FBQUEsTUFDRSxNQUFNLFlBQVksS0FBSyxRQUNyQixLQUFLLFlBQVksSUFBSSxDQUFDLE1BQU8sRUFBRSxXQUFXLElBQUksRUFBRSxVQUFVLElBQUksRUFBRSxPQUFRLEVBQUUsS0FBSyxHQUFHLEtBQ2xGO0FBQUEsSUFFSixDQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTSxVQUFVLE1BQU0sS0FBSyxJQUFJLFlBQVksS0FBSztBQUFBLEVBQ2hELE9BQU8sT0FBTyxZQUFZLFdBQVcsVUFBVTtBQUFBO0FBa0JqRCxlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELGtCQUFrQixLQUFLLE1BQU0sSUFBSTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxTQUFTLElBQUk7QUFBQSxJQUMxQixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sT0FBTyxlQUFlLENBQUM7QUFBQSxJQUM3QixJQUFJLFNBQVM7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUMxQixNQUFNO0FBQUE7QUFBQTtBQWVWLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkJCNDAxRkYzMjA0QzUxNkU2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
