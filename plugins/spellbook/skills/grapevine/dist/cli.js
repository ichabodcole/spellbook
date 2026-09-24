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
    die2(r.message, "usage");
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

//# debugId=5C7118EA9AFF80A564756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9ncmFwZXZpbmUvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGdyYXBldmluZSBDTEkg4oCUIHRoaW4gd3JhcHBlciBhcm91bmQgdGhlIGRhZW1vbidzIEhUVFAgc3VyZmFjZS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIGxpc3Rcbi8vICAgYnVuIGNsaS50cyBzZW5kIDxuYW1lPiAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyB0YWlsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl1cbi8vICAgYnVuIGNsaS50cyByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdXG4vLyAgIGJ1biBjbGkudHMgY2xvc2UgPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgc3RvcFxuLy8gICBidW4gY2xpLnRzIGluZm9cbi8vXG4vLyBgdGFpbGAgd3JpdGVzIGVhY2ggaW5jb21pbmcgbWVzc2FnZSBhcyBvbmUgSlNPTkwgbGluZSBvbiBzdGRvdXQuIFBpcGVcbi8vIG9yIHdyYXAgd2l0aCBNb25pdG9yLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBFcnJFeHRyYSxcbiAgdHlwZSBFcnJLaW5kLFxuICBkaWUgYXMgcmFpc2UsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHJlYWRTaW5jZSxcbiAgdGFpbFdpdGhIYW5kb2ZmLFxuICBXSU5ET1dfSEVMUCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmLnRzXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXQudHNcIjtcblxuY29uc3QgREFUQV9ESVIgPSBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuZ3JhcGV2aW5lXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihEQVRBX0RJUiwgXCJkYWVtb24ucG9ydFwiKTtcbmNvbnN0IFBJRF9GSUxFID0gam9pbihEQVRBX0RJUiwgXCJkYWVtb24ucGlkXCIpO1xuY29uc3QgSE9MRF9GSUxFID0gam9pbihEQVRBX0RJUiwgXCJkYWVtb24uaG9sZFwiKTtcbi8vIFBlcnNpc3RlZCBpZGVudGl0eSBjb25maWcgKFYxLjcpIOKAlCBgZ3JhcGV2aW5lIGFsaWFzIDxuYW1lPmAgd3JpdGVzIGl0OyB0aGVcbi8vIGRhZW1vbiBzZXJ2ZXMgaXQgdG8gdGhlIHdhdGNoIHZpYSBHRVQgL2lkZW50aXR5LlxuY29uc3QgQ09ORklHX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImNvbmZpZy5qc29uXCIpO1xuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBORVZFUiBBIEZMQVQgU0lCTElORyAocGxheWJvb2sgQjQpLiBUaGlzIHJlYWRcbi8vIGBqb2luKFNDUklQVF9ESVIsIFwiZGFlbW9uLnRzXCIpYCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IOKAlCB3aGljaCB3YXNcbi8vIHRydWUgZm9yIGV4YWN0bHkgYXMgbG9uZyBhcyB0aGUgQ0xJIGFuZCB0aGUgZGFlbW9uIHNoYXJlZCBhIGZvbGRlci4gRnJvbVxuLy8gYGRpc3QvYCB0aGF0IHJlc29sdmVzIHRvIGBkaXN0L2RhZW1vbi50c2AsIGEgZmlsZSB0aGF0IGRvZXMgbm90IGFuZCBtdXN0IG5vdFxuLy8gZXhpc3QuIFRoZSBzeW1wdG9tIGlzIG5vdCBhIGNyYXNoOiB0aGUgc3Bhd24gZmFpbHMgc2lsZW50bHkgKHRoZSBkYWVtb24nc1xuLy8gc3RkaW8gaXMgaWdub3JlZCksIG5vIHBvcnQgZmlsZSBldmVyIGFwcGVhcnMsIGFuZCB0aGUgMyBzIHBvbGwgbG9vcCBiZWxvd1xuLy8gcmVwb3J0cyBgZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NgIOKAlCB3aGljaCBpcyBBTFNPIHdoYXQgYSBsYXVuY2hlclxuLy8gdGhhdCBleGl0cyBhIGxpdmUgZGFlbW9uIHJlcG9ydHMgKEQ2OSkgYW5kIEFMU08gd2hhdCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZ1xuLy8gYXQgaXRzIHN1cmZhY2UgaW1wb3J0IHJlcG9ydHMgKHNlZSBgZW5zdXJlRGFlbW9uYCkuIFRocmVlIGRlZmVjdCBjbGFzc2VzLCBvbmVcbi8vIHNlbnRlbmNlOyB0aGlzIGlzIHRoZSBmaXJzdCBvZiB0aGUgdGhyZWUuXG4vLyBgZ3JpbW9pcmUvc3Bhd24tcGF0aC13YXJkLnRlc3QudHNgIHJlc29sdmVzIHRoaXMgYXJpdGhtZXRpYyB0aGUgd2F5IHRoZVxuLy8gcnVudGltZSB3aWxsLCBmcm9tIHRoZSBFTUlUVEVEIGZpbGUncyBvd24gZGlyZWN0b3J5LCBhbmQgYXNzZXJ0cyB0aGUgZmlsZSBpc1xuLy8gdGhlcmUuXG5jb25zdCBEQUVNT05fU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcImRhZW1vbi50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gVGhlIHdhdGNoIHN1cmZhY2UgaXMgYnVpbHQgKHNyYy9ncmFwZXZpbmUvc3VyZmFjZSDihpIgZGlzdC8pLiBCdW4gcmVhZHNcbi8vIGJ1bmZpZy50b21sICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyBpbiBERVYgbW9kZSB0aGUgZGFlbW9uJ3Ncbi8vIGN3ZCBNVVNUIGJlIHNyYy9ncmFwZXZpbmUvIChzZWFtcyBDb250cmFjdCA1KSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgYW5kIHRoZSBwYWdlIGZhaWxzIChtZWFzdXJlZCBvblxuLy8gZ2xhbW91cjogSFRUUCA1MDAsIG5vIHN0eWxlc2hlZXQgbGluaykuIEluIFJFTEVBU0UgbW9kZSBkaXN0LyBpcyBzdGF0aWMgYW5kXG4vLyBwcmUtYnVpbHQsIG5vIGJ1bmZpZyBpcyByZWFkLCBhbmQgc3JjL2dyYXBldmluZS8gbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhXG4vLyBzb3VyY2UtZnJlZSBtYXJrZXRwbGFjZSBjbG9uZSBoYXMgbm8gdG9wLWxldmVsIHNyYy8pIOKAlCBzbyB0aGUgY3dkIHN0YXlzIGF0XG4vLyB0aGUgc2tpbGwgcm9vdC4gU2FtZSBzaGFwZSBhcyBnbGFtb3VyJ3MgZGFlbW9uQ3dkKCkuIEV4cG9ydGVkIGZvciB0ZXN0cy5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJncmFwZXZpbmVcIik7XG5cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLy8g4pSA4pSAIERhZW1vbiBIVFRQIHByb3RvY29sIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gUmVzcG9uc2Ugc2hhcGVzIHRoZSBkYWVtb24gZW1pdHMuIEFueSBlbmRwb2ludCBjYW4gYWxzbyByZXR1cm4gYW4gZXJyb3Jcbi8vIGJvZHkgd2l0aCBhIDR4eC81eHggc3RhdHVzLCBzbyBlYWNoIGNhcnJpZXMgYW4gb3B0aW9uYWwgYGVycm9yYC5cblxudHlwZSBNZXNzYWdlID0ge1xuICBpZDogbnVtYmVyO1xuICBjaGFubmVsOiBzdHJpbmc7XG4gIGZyb206IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICB0czogbnVtYmVyO1xuICBraW5kOiBcIm1lc3NhZ2VcIiB8IFwidG9waWNcIiB8IFwiYW5ub3VuY2VtZW50XCIgfCBcInN0YXR1c1wiO1xuICBpbl9yZXBseV90bz86IG51bWJlcjtcbiAgdGFyZ2V0PzogbnVtYmVyO1xuICBkaXNwb3NpdGlvbj86IHN0cmluZztcbiAgLy8gQ2hhbm5lbC1sZXZlbCBsaWZlY3ljbGUgZmFjdCAoYXJjaGl2ZSAvIHVuYXJjaGl2ZSkuIEEga2luZDpcInN0YXR1c1wiIGZyYW1lXG4gIC8vIGNhcnJ5aW5nIGBldmVudGAgYW5kIG5vIGBkaXNwb3NpdGlvbmAg4oCUIHNlZSBpc0Rpc3Bvc2l0aW9uRnJhbWUuXG4gIGV2ZW50PzogXCJhcmNoaXZlZFwiIHwgXCJ1bmFyY2hpdmVkXCI7XG59O1xuXG4vLyBHRVQgLyDigJQgZGFlbW9uIGxpdmVuZXNzL2luZm8uXG50eXBlIFJvb3RJbmZvID0ge1xuICBvaz86IGJvb2xlYW47XG4gIHBpZD86IG51bWJlcjtcbiAgc3RhcnRlZF9hdD86IG51bWJlcjtcbiAgY2hhbm5lbHM/OiBudW1iZXI7XG4gIGRhdGFfZGlyPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9jaGFubmVscy88bmFtZT4vbWVzc2FnZXMg4oCUIG1lc3NhZ2UgcmVjZWlwdCB3aXRoIGRlbGl2ZXJ5IGFjY291bnRpbmcuXG50eXBlIFNlbmRSZWNlaXB0ID0gTWVzc2FnZSAmIHtcbiAgc3Vic2NyaWJlcnM/OiBudW1iZXI7XG4gIHJlY2lwaWVudHM/OiBudW1iZXI7XG4gIHN1YnNjcmliZXJfYWxpYXNlcz86IHN0cmluZ1tdO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2Fubm91bmNlIOKAlCBjcm9zcy1jaGFubmVsIGJyb2FkY2FzdCByZWNlaXB0LlxudHlwZSBBbm5vdW5jZVJlY2VpcHQgPSB7XG4gIG9rOiBib29sZWFuO1xuICBjaGFubmVsczogeyBuYW1lOiBzdHJpbmc7IHJlY2lwaWVudHM6IG51bWJlciB9W107XG4gIHNraXBwZWQ6IHsgbmFtZTogc3RyaW5nOyByZWFzb246IHN0cmluZyB9W107XG4gIHRvdGFsX3JlY2lwaWVudHM6IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzIOKAlCBjaGFubmVsIGRpcmVjdG9yeSBsaXN0aW5nLlxudHlwZSBDaGFubmVsU3VtbWFyeSA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAvLyBudWxsID0gdGhlIGRhZW1vbiBjb3VsZCBub3QgZXN0YWJsaXNoIGEgY291bnQgKHVucmVhZGFibGUgZmlsZSksIE5FVkVSIDAuXG4gIC8vIDAgbWVhbnMgXCJ0aGlzIGNoYW5uZWwgaXMgZ2VudWluZWx5IGVtcHR5XCIgYW5kIG5vdGhpbmcgZWxzZSDigJQgYjUuXG4gIG1lc3NhZ2VfY291bnQ6IG51bWJlciB8IG51bGw7XG4gIGxhc3RfYWN0aXZpdHk6IG51bWJlcjtcbiAgbG9hZGVkOiBib29sZWFuO1xufTtcbnR5cGUgQ2hhbm5lbHNSZXNwb25zZSA9IHsgY2hhbm5lbHM/OiBDaGFubmVsU3VtbWFyeVtdOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBBbnkgZW5kcG9pbnQgbWF5IHJlcGx5IHdpdGgganVzdCBhbiBlcnJvci9vayBlbnZlbG9wZS5cbnR5cGUgU3RhdHVzUmVzcG9uc2UgPSB7IG9rPzogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vbWVzc2FnZXMgYW5kID9zaW5jZT0gcmFuZ2VzLlxudHlwZSBNZXNzYWdlc1Jlc3BvbnNlID0geyBtZXNzYWdlcz86IE1lc3NhZ2VbXTsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vd2FpdCDigJQgbG9uZy1wb2xsIGJhdGNoLlxudHlwZSBXYWl0UmVzcG9uc2UgPSB7XG4gIG1lc3NhZ2VzPzogTWVzc2FnZVtdO1xuICBjdXJzb3I/OiBudW1iZXI7XG4gIHRpbWVkX291dD86IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xuICAvLyBBIHJlZnVzYWwgbmFtZXMgdGhlIGFjdCB0aGF0IHJlY292ZXJzIGZyb20gaXQgKDQwNCBvbiBhIG1pc3NpbmcgY2hhbm5lbCkuXG4gIGhpbnQ/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9jaGFubmVscyDigJQgb3Blbi9lbnN1cmUgYSBjaGFubmVsLlxudHlwZSBPcGVuUmVzcG9uc2UgPSB7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGNyZWF0ZWRfYXQ/OiBudW1iZXI7XG4gIG1lc3NhZ2VfY291bnQ/OiBudW1iZXI7XG4gIHN1YnNjcmliZXJzPzogbnVtYmVyO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIHVuYXJjaGl2ZWQ/OiBib29sZWFuO1xuICBjbGVhcmVkPzogYm9vbGVhbjtcbiAgc25hcHNob3Q/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3RvcGljIGFuZCBQVVQgL2NoYW5uZWxzLzxuYW1lPi90b3BpYy5cbnR5cGUgVG9waWNSZXNwb25zZSA9IHtcbiAgb2s/OiBib29sZWFuO1xuICBjaGFubmVsPzogc3RyaW5nO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIGlkPzogbnVtYmVyO1xuICBlcnJvcj86IHN0cmluZztcbiAgaGludD86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3N1YnNjcmliZXJzIOKAlCBzaW5nbGUtY2hhbm5lbCByb3N0ZXIuXG50eXBlIFN1YnNjcmliZXJzUmVzcG9uc2UgPSB7XG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzPzogc3RyaW5nW107XG4gIGh1bWFucz86IHN0cmluZ1tdO1xuICBjb3VudD86IG51bWJlcjtcbiAgY29ubmVjdGlvbnM/OiBudW1iZXI7XG4gIG5hbWVkPzogbnVtYmVyO1xuICBhbm9ueW1vdXM/OiBudW1iZXI7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQZXItY2hhbm5lbCBwcmVzZW5jZSBlbnRyeSBmcm9tIEdFVCAvcHJlc2VuY2UuXG50eXBlIFByZXNlbmNlQ2hhbm5lbCA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBzdWJzY3JpYmVyczogc3RyaW5nW107XG4gIGh1bWFucz86IHN0cmluZ1tdO1xuICBjb25uZWN0aW9uczogbnVtYmVyO1xuICBuYW1lZDogbnVtYmVyO1xuICBhbm9ueW1vdXM6IG51bWJlcjtcbn07XG50eXBlIFByZXNlbmNlUmVzcG9uc2UgPSB7IGNoYW5uZWxzPzogUHJlc2VuY2VDaGFubmVsW107IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIFNTRSBmcmFtZXMgcHVzaGVkIG9uIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3RhaWwuIFR3byBmcmFtZSBraW5kcyBhcnJpdmUgb25cbi8vIHRoZSBzYW1lIGBkYXRhOmAgbGluZSDigJQgYSBgc3Vic2NyaWJlZGAgZXZlbnQgYW5kIHBlci1tZXNzYWdlIGZyYW1lcyDigJQgc28gdGhlXG4vLyBkZWNvZGVkIHBheWxvYWQgaXMgYSB1bmlvbi4gQWxsIGZpZWxkcyBvcHRpb25hbCBiZWNhdXNlIHRoZSBmcmFtZSBpc1xuLy8gdW50cnVzdGVkIHdpcmUgZGF0YSBuYXJyb3dlZCBhdCB0aGUgdXNlIHNpdGUuXG50eXBlIFRhaWxQYXlsb2FkID0ge1xuICAvLyBzdWJzY3JpYmVkLWV2ZW50IGZpZWxkc1xuICBzaW5jZT86IG51bWJlcjtcbiAgYXM/OiBzdHJpbmcgfCBudWxsO1xuICBsYXRlc3RfaWQ/OiBudW1iZXI7XG4gIC8vIFRydWUgd2hlbiBUSElTIHN1YnNjcmliZSBjcmVhdGVkIHRoZSBjaGFubmVsIOKAlCB0aGUgc2lnbmFsIHRoYXQgc2VwYXJhdGVzXG4gIC8vIFwicXVpZXQgY2hhbm5lbFwiIGZyb20gXCJ5b3UgdGFpbGVkIGEgbmFtZSB0aGF0IGRpZCBub3QgZXhpc3RcIi5cbiAgY3JlYXRlZD86IGJvb2xlYW47XG4gIC8vIFRydWUgd2hlbiB0aGUgY2hhbm5lbCBpcyBhbHJlYWR5IGFyY2hpdmVkIChyZWFkLW9ubHkpIGF0IHN1YnNjcmliZSB0aW1lIOKAlFxuICAvLyB0aGUgc2lnbmFsIGZvciBhIExBVEUgam9pbmVyLCB3aG8gd291bGQgb3RoZXJ3aXNlIGxlYXJuIGl0IGZyb20gYSByZWplY3RlZFxuICAvLyBzZW5kLiBUaGUgbGlmZWN5Y2xlIGZyYW1lIG9ubHkgcmVhY2hlcyBhbiBhZ2VudCB0aGF0IHdhcyBjb25uZWN0ZWQgYXQgdGhlXG4gIC8vIG1vbWVudCwgb3IgdGhhdCBwdWxscyBoaXN0b3J5LlxuICBhcmNoaXZlZD86IGJvb2xlYW47XG4gIC8vIG1lc3NhZ2UgZmllbGRzXG4gIGlkPzogbnVtYmVyO1xuICBmcm9tPzogc3RyaW5nO1xuICB0ZXh0Pzogc3RyaW5nO1xuICB0cz86IG51bWJlcjtcbiAga2luZD86IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIC8vIHNoYXJlZFxuICBjaGFubmVsPzogc3RyaW5nO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG59O1xuXG4vLyBPdXIgcGx1Z2luIHZlcnNpb24gKGZyb20gcGx1Z2luLmpzb24pLiBVc2VkIHRvIGRldGVjdCBjYWNoZS1waW5uaW5nXG4vLyBtaXNtYXRjaGVzIHdoZW4gd2UgdGFsayB0byBhIGRhZW1vbiBzcGF3bmVkIGZyb20gYSBkaWZmZXJlbnQgY2FjaGVkXG4vLyBwYXRoLiBCZXN0LWVmZm9ydDsgbnVsbCBpZiByZWFkIGZhaWxzLlxuZnVuY3Rpb24gcmVhZFBsdWdpblZlcnNpb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGx1Z2luSnNvblBhdGggPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKTtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocGx1Z2luSnNvblBhdGgsIFwidXRmLThcIik7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KS52ZXJzaW9uID8/IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5jb25zdCBQTFVHSU5fVkVSU0lPTiA9IHJlYWRQbHVnaW5WZXJzaW9uKCk7XG5cbi8vIE9uZS1zaG90IHZlcnNpb24tbWlzbWF0Y2ggY2hlY2suIFRoZSBkYWVtb24gbWF5IGJlIGZyb20gYSBkaWZmZXJlbnRcbi8vIGNhY2hlZCBwbHVnaW4gcGF0aCB0aGFuIHRoaXMgQ0xJIChleGlzdGluZyB0YWlsIHByb2Nlc3NlcycgYXV0by1yZWNvbm5lY3Rcbi8vIGNhbiByYWNlIGEgYHN0b3BgIGFuZCByZXNwYXduIHRoZSBvbGQgZGFlbW9uKS4gV2FybiBvbmNlIHBlciBpbnZvY2F0aW9uXG4vLyBzbyB0aGUgdXNlciBoYXMgYSBzaWduYWwgaW5zdGVhZCBvZiBzaWxlbnRseSBkZWdyYWRlZCBiZWhhdmlvci5cbmxldCBfdmVyc2lvbkNoZWNrRG9uZSA9IGZhbHNlO1xuYXN5bmMgZnVuY3Rpb24gbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydDogbnVtYmVyKSB7XG4gIGlmIChfdmVyc2lvbkNoZWNrRG9uZSkgcmV0dXJuO1xuICBfdmVyc2lvbkNoZWNrRG9uZSA9IHRydWU7XG4gIGlmICghUExVR0lOX1ZFUlNJT04pIHJldHVybjsgLy8gY2FuJ3QgY29tcGFyZSBpZiB3ZSBkb24ndCBrbm93IG91ciBvd24gdmVyc2lvblxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDUwMCksXG4gICAgfSk7XG4gICAgaWYgKCFyZXMub2spIHJldHVybjtcbiAgICBjb25zdCBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJvb3RJbmZvO1xuICAgIGNvbnN0IGRhZW1vblZlcnNpb24gPSBkYXRhPy52ZXJzaW9uID8/IG51bGw7XG4gICAgaWYgKGRhZW1vblZlcnNpb24gPT09IG51bGwpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBncmFwZXZpbmU6IGRhZW1vbiBpcyBvbGRlciB0aGFuIHRoaXMgQ0xJIChubyB2ZXJzaW9uIHJlcG9ydGVkKS4gYCArXG4gICAgICAgICAgYENMSSBpcyB2JHtQTFVHSU5fVkVSU0lPTn0uIFNvbWUgZmVhdHVyZXMgbWF5IHNpbGVudGx5IGRlZ3JhZGUuIGAgK1xuICAgICAgICAgIGBSZXN0YXJ0IHRoZSBkYWVtb24gKGRyb3AgdGFpbHMsIHRoZW4gXFxgc3RvcFxcYCwgdGhlbiBhbnkgdmVyYikgdG8gdXBncmFkZS5cXG5gLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKGRhZW1vblZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgZ3JhcGV2aW5lOiBkYWVtb24gdmVyc2lvbiAodiR7ZGFlbW9uVmVyc2lvbn0pIGRpZmZlcnMgZnJvbSBDTEkgdmVyc2lvbiAodiR7UExVR0lOX1ZFUlNJT059KS4gYCArXG4gICAgICAgICAgYFNvbWUgZmVhdHVyZXMgbWF5IHNpbGVudGx5IGRlZ3JhZGUuIFJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbi5cXG5gLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGJlc3QtZWZmb3J0XG4gIH1cbn1cbi8vIEdSQVBFVklORV9GUk9NIHNldHMgdGhlIGRlZmF1bHQgLS1mcm9tIC8gLS1hcyBhbGlhcyBzbyBhZ2VudHMgZG9uJ3QgaGF2ZVxuLy8gdG8gcmVwZWF0IHRoZWlyIGlkZW50aXR5IG9uIGV2ZXJ5IHZlcmIuIFBlci12ZXJiIGZsYWdzIHN0aWxsIG92ZXJyaWRlLlxuY29uc3QgREVGQVVMVF9BTElBUyA9IHByb2Nlc3MuZW52LkdSQVBFVklORV9GUk9NID8/IHVuZGVmaW5lZDtcblxuLy8gSWRlbnRpdHkgZmxhZ3MgYXJlIGludGVyY2hhbmdlYWJsZSBhY3Jvc3MgdmVyYnMuIGBzZW5kYCBoaXN0b3JpY2FsbHkgdG9va1xuLy8gYC0tZnJvbWAgd2hpbGUgYHRhaWxgL2B3YWl0YCB0b29rIGAtLWFzYCDigJQgc2FtZSBjb25jZXB0ICh3aG8gYW0gSSksIGFuZCB0aGVcbi8vIGFzeW1tZXRyeSB0cmlwcyB5b3UgbWlkLWZsb3cuIEFjY2VwdCBlaXRoZXIgZXZlcnl3aGVyZSBpZGVudGl0eSBpcyBtZWFudCxcbi8vIGZhbGxpbmcgYmFjayB0byBHUkFQRVZJTkVfRlJPTS4gKGdyZXAncyBgLS1mcm9tYCBpcyBhIGRpZmZlcmVudCB0aGluZyDigJQgYW5cbi8vIGF1dGhvciAqZmlsdGVyKiwgbm90IGlkZW50aXR5IOKAlCBzbyBpdCBkb2Vzbid0IHVzZSB0aGlzLilcbmZ1bmN0aW9uIHJlc29sdmVBbGlhcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gKGZsYWdzLmZyb20gYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyAoZmxhZ3MuYXMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBERUZBVUxUX0FMSUFTO1xufVxuLy8gVHJ1bmNhdGlvbi1oaW50IHRocmVzaG9sZC4gTWVzc2FnZXMgbG9uZ2VyIHRoYW4gdGhpcyBnZXQgYSBgdHJ1bmNhdGlvbl9oaW50YFxuLy8gZmllbGQgb24gdGhlIHRhaWwgSlNPTiBzbyBjb25zdW1lcnMgKGUuZy4gTW9uaXRvcikga25vdyB0aGUgbm90aWZpY2F0aW9uXG4vLyBwcmV2aWV3IGlzIGluY29tcGxldGUgYW5kIHNob3VsZCBgcmVhZGAgdGhlIGZ1bGwgYm9keS4gSW4gYWdlbnQtdG8tYWdlbnRcbi8vIHRyYWZmaWMsIGxvbmcgbWVzc2FnZXMgYXJlIHRoZSBOT1JNICh0aGUgVjEuNiByb3VuZHRhYmxlIHNhdyBtb3N0IHN1YnN0YW50aXZlXG4vLyBtZXNzYWdlcyBleGNlZWQgODAwKSwgc28gYW4gODAwIGRlZmF1bHQgZmlyZWQgb24gbmVhcmx5IGV2ZXJ5dGhpbmcgYW5kIHRoZVxuLy8gcmVjb3ZlcnkgcGF0aCBiZWNhbWUgdGhlIG1haW4gcGF0aC4gRGVmYXVsdCByYWlzZWQgdG8gMjAwMCBzbyB0aGUgaGludCBtYXJrc1xuLy8gdGhlIGdlbnVpbmVseS1sb25nIG91dGxpZXJzLiBPdmVycmlkYWJsZSB2aWEgZW52IHZhciBmb3IgdHVuaW5nLlxuY29uc3QgVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRCA9IHBhcnNlSW50KFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRCA/PyBcIjIwMDBcIixcbiAgMTAsXG4pO1xuXG4vLyBPcHRpb25hbCBpbmxpbmUtYm9keSBjYXAgZm9yIGB0YWlsYCAob3B0LWluIHZpYSAtLW1heCA8bj4gb3IgR1JBUEVWSU5FX1RBSUxfTUFYKS5cbi8vIFdoZW4gc2V0LCBhIGJvZHkgbG9uZ2VyIHRoYW4gdGhlIGNhcCBpcyB0cnVuY2F0ZWQgdG8gYG5gIGNoYXJzIGluIHRoZSB0YWlsXG4vLyBmcmFtZSAocGx1cyB0aGUgcmVhZC1wb2ludGVyIGhpbnQpLCBzbyBhIHB1c2ggY29uc3VtZXIgY2FuIGhhbmQgaXRzXG4vLyBub3RpZmljYXRpb24gc3VyZmFjZSBhIGRlbGliZXJhdGVseS1zaXplZCBsaW5lLiBUaGUgRlVMTCBtZXNzYWdlIGlzIGFsd2F5c1xuLy8gcmV0cmlldmFibGUgdmlhIGByZWFkIDxjaGFubmVsPiA8aWQ+YC4gVW5kZWZpbmVkID0gbm8gY2FwIChmdWxsIHRleHQgaW5saW5lIOKAlFxuLy8gdG9kYXkncyBkZWZhdWx0KS4gTm90ZTogdGhlIGhhcmQgY2xpcCBhIGNvbnN1bWVyIHVsdGltYXRlbHkgc2VlcyBpcyBzdGlsbCB0aGVcbi8vIE1vbml0b3Ivbm90aWZpY2F0aW9uIGxheWVyJ3M7IC0tbWF4IG9ubHkgYm91bmRzIHRoZSBsaW5lIGdyYXBldmluZSBlbWl0cy5cbi8vIFJlamVjdHMgbmVnYXRpdmUgLyBub24tbnVtZXJpYy5cbmZ1bmN0aW9uIHJlc29sdmVUYWlsTWF4KGZsYWc6IHVua25vd24pOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBjb25zdCByYXcgPSB0eXBlb2YgZmxhZyA9PT0gXCJzdHJpbmdcIiA/IGZsYWcgOiBwcm9jZXNzLmVudi5HUkFQRVZJTkVfVEFJTF9NQVg7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID49IDAgPyBuIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZSDigJQgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgJ3MgYGRpZWAsIHVuZGVyIHRoaXNcbiAqIHNwZWxsJ3Mgb3duIG5hbWUgc28gNDYgY2FsbCBzaXRlcyBkaWQgbm90IGVhY2ggaGF2ZSB0byBiZSByZS1zcGVsbGVkLlxuICpcbiAqIOKblCAqKklUIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgQSBDQUxMRVItVklTSUJMRSBDSEFOR0UqKlxuICogKFBoYXNlIDYgY2hhcHRlciAyOyB0aGUgZGVsdGEgaXMgZHJpdmVuIGFuZCByZWNvcmRlZCBpbiB0aGUgam91cm5hbCkuIFRoaXNcbiAqIGZ1bmN0aW9uIHdhcyBgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXFxgZ3JhcGV2aW5lOiAke21zZ31cXG5cXGApOyBwcm9jZXNzLmV4aXQoY29kZSlgXG4gKiDigJQgUFJPU0UgYXQgZXhpdCAyIGZvciBldmVyeSBmYWlsdXJlIGdyYXBldmluZSBjb3VsZCBwcm9kdWNlLCB3aXRoIHR3byBzaXRlc1xuICogcGFzc2luZyAxLiBBZnRlciB0aGUgYWRvcHRpb24gaXQgaXMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIGFuZCB0aGVcbiAqIGFjYyB0YXhvbm9teSdzIGNvZGVzOiB1c2FnZSAyLCBpbnRlcm5hbCAxLCBub3RfZm91bmQgNSwgY29uZmxpY3QgNi4gQW4gYWdlbnRcbiAqIHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGU7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24gYW5kIHJld29yZGluZ1xuICogaXQgbXVzdCBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZGlkIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZWQgcHJvc2UuXG4gKlxuICog4puUICoqQU5EIFRIRSBFTlVNRVJBVElPTlMgTU9WRUQgRlJPTSBQUk9TRSBJTlRPIGBjaG9pY2VzYC4qKiBncmFwZXZpbmUnc1xuICogcmVqZWN0aW9ucyB3ZXJlIHNoYXBlZCBmb3IgYWNjJ3MgZmxhZy1zZXQgZXh0cmFjdG9ycyDigJQgYHJlY29nbml6ZWQgZmxhZ3M6IC0tYVxuICogLS1iYCwgd2l0aCBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXQgYSBxdWFsaWZpZXIgYmV0d2VlbiB0aGUgbm91biBhbmQgdGhlIGNvbG9uXG4gKiBcInJlYWRzIGFzIHByb3NlLCBub3QgYSBzZXRcIi4gV3JhcHBlZCBpbiBKU09OIHRoYXQgbWFya2VyIGJlY29tZXMgYSBzdWJzdHJpbmcgb2ZcbiAqIGFuIGVzY2FwZWQgc3RyaW5nLCBzbyBpdCBkb2VzIG5vdCBzdGF5IGluIHByb3NlOiBldmVyeSBlbnVtZXJhdGlvbiBpcyBub3cgYVxuICogYGNob2ljZXNgIGFycmF5LCB3aGljaCBpcyB3aGF0IGdsYW1vdXIgKENPTkZPUk1BTlQgTDApIHB1Ymxpc2hlcyBhbmQgd2hhdCB0aGVcbiAqIGVudmVsb3BlIGhhcyBhIGZpZWxkIGZvci4gVGhlIHJ1bm5hYmxlIHJlY292ZXJ5IOKAlCBgdHJ5OiBidW4g4oCmL2NsaS50cyBvcGVuIHhgIOKAlFxuICogbW92ZWQgaW50byBgaGludGAgZm9yIHRoZSBzYW1lIHJlYXNvbiwgYW5kIGEgY2FsbGVyIG5vdyByZWFkcyBhIGZpZWxkIGluc3RlYWRcbiAqIG9mIHNwbGl0dGluZyBhIHNlbnRlbmNlLlxuICpcbiAqIOKaoCBgZGllYCBpcyBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIHN3YWxsb3dzLCBhbmQgdGhhdCBpc1xuICogbm93IGEgc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIEF1ZGl0ZWQgYnkgY2FsbCBncmFwaCBhdCB0aGVcbiAqIGFkb3B0aW9uIChwbGF5Ym9vayBCOSk7IHRoZSBjb3VudCBpcyBpbiB0aGUgam91cm5hbC5cbiAqL1xuZnVuY3Rpb24gZGllKG1zZzogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICByYWlzZShtc2csIGtpbmQsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBUaGUgdGF4b25vbXkgYGtpbmRgIGZvciBhbiBIVFRQIHN0YXR1cyB0aGUgZGFlbW9uIGFuc3dlcmVkIHdpdGguXG4gKlxuICog4puUIE9ORSBNQVBQSU5HLCBOT1QgQSBKVURHRU1FTlQgUEVSIFNJVEUuIFR3ZW50eSBvZiBncmFwZXZpbmUncyByYWlzZSBzaXRlc1xuICogYXJlIFwidGhlIGRhZW1vbiBzYWlkIG5vXCI7IGJlZm9yZSB0aGUgYWRvcHRpb24gZXZlcnkgb25lIG9mIHRoZW0gY29sbGFwc2VkIHRvXG4gKiBleGl0IDIsIHNvIGEgbWlzc2luZyBjaGFubmVsLCBhIGxpdmUtc2Vzc2lvbiByZWZ1c2FsIGFuZCBhIGJyb2tlbiBkYWVtb24gd2VyZVxuICogb25lIG51bWJlciB0byBhbiBhZ2VudC4gVGhlIGRhZW1vbiBhbHJlYWR5IGRpc3Rpbmd1aXNoZXMgdGhlbSBieSBzdGF0dXMg4oCUXG4gKiA0MDQgZm9yIGEgY2hhbm5lbCB0aGF0IGRvZXMgbm90IGV4aXN0LCA0MDkgZm9yIGFyY2hpdmVkIC8gbGl2ZSAvIGFscmVhZHktb3BlblxuICog4oCUIHNvIHRoZSBtYXBwaW5nIGlzIGEgcmUtcmVhZGluZyBvZiB3aGF0IHdhcyBvbiB0aGUgd2lyZSwgbm90IGEgbmV3IG9waW5pb24uXG4gKi9cbmZ1bmN0aW9uIGtpbmRGb3JTdGF0dXMoc3RhdHVzOiBudW1iZXIpOiBFcnJLaW5kIHtcbiAgaWYgKHN0YXR1cyA9PT0gNDA0KSByZXR1cm4gXCJub3RfZm91bmRcIjtcbiAgaWYgKHN0YXR1cyA9PT0gNDA5KSByZXR1cm4gXCJjb25mbGljdFwiO1xuICBpZiAoc3RhdHVzID49IDQwMCAmJiBzdGF0dXMgPCA1MDApIHJldHVybiBcInVzYWdlXCI7XG4gIHJldHVybiBcImludGVybmFsXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWREYWVtb25Qb3J0KCk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICBpZiAoIWV4aXN0c1N5bmMoUE9SVF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhQT1JUX0ZJTEUsIFwidXRmLThcIikudHJpbSgpO1xuICBjb25zdCBwb3J0ID0gcGFyc2VJbnQocmF3LCAxMCk7XG4gIGlmICghcG9ydCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICB9KTtcbiAgICBpZiAocmVzLm9rKSB7XG4gICAgICAvLyBGaXJlLWFuZC1mb3JnZXQgbWlzbWF0Y2ggY2hlY2sgKHdvbid0IGJsb2NrIHRoZSB2ZXJiKS5cbiAgICAgIG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKHBvcnQpO1xuICAgICAgcmV0dXJuIHBvcnQ7XG4gICAgfVxuICB9IGNhdGNoIHt9XG4gIC8vIFN0YWxlIOKAlCBjbGVhbiB1cC5cbiAgdHJ5IHtcbiAgICB1bmxpbmtTeW5jKFBPUlRfRklMRSk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICB1bmxpbmtTeW5jKFBJRF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gaG9sZEFjdGl2ZSgpOiBudW1iZXIgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgdW50aWwgPSBwYXJzZUludChyZWFkRmlsZVN5bmMoSE9MRF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKSwgMTApO1xuICAgIGlmIChOdW1iZXIuaXNGaW5pdGUodW50aWwpICYmIHVudGlsID4gRGF0ZS5ub3coKSkgcmV0dXJuIHVudGlsO1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKEhPTERfRklMRSk7XG4gICAgfSBjYXRjaCB7fSAvLyBleHBpcmVkIOKGkiBjbGVhblxuICAgIHJldHVybiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIHJlbGVhc2VIb2xkKCkge1xuICB0cnkge1xuICAgIGlmIChleGlzdHNTeW5jKEhPTERfRklMRSkpIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIGlmIChob2xkQWN0aXZlKCkpXG4gICAgZGllKFxuICAgICAgXCJkYWVtb24gaXMgaGVsZCAocmVzcGF3biBzdXBwcmVzc2VkKSDigJQgd2FpdCBmb3IgdGhlIGhvbGQgdG8gY2xlYXIgb3IgcnVuIGBncmFwZXZpbmUgcm9sbGBcIixcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICAvLyBDaGVjayB0aGUgY3dkIEVYSVNUUyBiZWZvcmUgc3Bhd25pbmc6IHRoZSBkYWVtb24ncyBzdGRpbyBpcyBpZ25vcmVkLCBzbyBhXG4gIC8vIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQgd291bGQgb3RoZXJ3aXNlIHN1cmZhY2Ugb25seSBhc1xuICAvLyBcImZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiDigJQgYW5kIG5vZGUgcmVwb3J0cyBhIG1pc3NpbmcgY3dkIGFzIEVOT0VOVCBvblxuICAvLyB0aGUgZXhlY3V0YWJsZSwgd2hpY2ggcmVhZHMgYXMgXCJidW4gaXMgbWlzc2luZ1wiLlxuICBjb25zdCBjd2QgPSBkYWVtb25Dd2QoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGN3ZCkpIHtcbiAgICBkaWUoXG4gICAgICBgZ3JhcGV2aW5lIGNhbm5vdCBzdGFydCBpdHMgZGFlbW9uOiB0aGUgd29ya2luZyBkaXJlY3RvcnkgaXQgbmVlZHMgaXMgbWlzc2luZyDigJQgJHtjd2R9LiBgICtcbiAgICAgICAgXCJObyBkaXN0L2luZGV4Lmh0bWwgd2FzIGZvdW5kIChvciBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPWRldiBpcyBzZXQpLCBzbyB0aGUgZGFlbW9uIFwiICtcbiAgICAgICAgXCJtdXN0IHJ1biBmcm9tIHNyYy9ncmFwZXZpbmUvIHRvIGJ1bmRsZSB0aGUgd2F0Y2ggc3VyZmFjZSwgd2hpY2ggYSBzb3VyY2UtZnJlZSBpbnN0YWxsIFwiICtcbiAgICAgICAgXCJkb2VzIG5vdCBoYXZlLiBFaXRoZXIgdGhlIHNoaXBwZWQgZGlzdC8gaXMgbWlzc2luZyAocmVpbnN0YWxsIHRoZSBzcGVsbCkgb3IgeW91IGFyZSBpbiBcIiArXG4gICAgICAgIFwiYSBjaGVja291dCB3aXRob3V0IHNyYy9ncmFwZXZpbmUvLlwiLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICk7XG4gIH1cbiAgLy8gU3Bhd24gZGV0YWNoZWQgc28gdGhlIGRhZW1vbiBzdXJ2aXZlcyB0aGlzIENMSSBwcm9jZXNzIGV4aXQuXG4gIGNvbnN0IHByb2MgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbREFFTU9OX1NDUklQVF0sIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgY3dkLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBXYWl0IHVwIHRvIDNzIGZvciB0aGUgcG9ydCBmaWxlIHRvIGFwcGVhciBhbmQgcmVzcG9uZC5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgMzAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gICAgaWYgKHBvcnQpIHJldHVybiBwb3J0O1xuICB9XG4gIGRpZShcImRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzXCIsIFwiaW50ZXJuYWxcIiwge1xuICAgIGhpbnQ6XG4gICAgICBcInRocmVlIHVucmVsYXRlZCBjYXVzZXMgcmVwb3J0IHRoaXMgb25lIHNlbnRlbmNlOiB0aGUgZGFlbW9uJ3MgbGF1bmNoZXIgc2hhcGUsIFwiICtcbiAgICAgIFwiYSB3cm9uZyBzcGF3biBwYXRoLCBhbmQgYSBkZXYtbW9kZSBkYWVtb24gZHlpbmcgYXQgaXRzIHN1cmZhY2UgaW1wb3J0LiBcIiArXG4gICAgICBcIlJ1biB0aGUgZGFlbW9uIGxhdW5jaGVyIGFsb25lIHRvIHRlbGwgdGhlbSBhcGFydCDigJQgaXQgaXMgdGhlIGxhdW5jaGVyIHNoYXBlIFwiICtcbiAgICAgIFwiaWZmIGl0IHByaW50cyBgbGlzdGVuaW5nIG9uIOKApmAgYW5kIHJldHVybnMgYXQgZXhpdCAwLiBBbiBlbXB0eSBcIiArXG4gICAgICBcIkdSQVBFVklORV9IT01FIChubyBgY2hhbm5lbHMvYCkgbWVhbnMgdGhlIGRhZW1vbiBuZXZlciBib3VuZCBhdCBhbGwuXCIsXG4gIH0pO1xufVxuXG4vLyBHZW5lcmljIG92ZXIgdGhlIGV4cGVjdGVkIHN1Y2Nlc3MgYm9keS4gYGRhdGFgIG1heSBiZSBudWxsIGlmIHRoZSByZXNwb25zZVxuLy8gaGFkIG5vIEpTT04gYm9keSwgc28gY2FsbGVycyBzZWUgYFQgfCBudWxsYC5cbmFzeW5jIGZ1bmN0aW9uIGFwaTxUID0gdW5rbm93bj4oXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IFQgfCBudWxsIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiBUIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBUO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG5mdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bikge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cblxuLy8gSG93IFRISVMgQ0xJIHdhcyBpbnZva2VkLCBhcyBhIHJ1bm5hYmxlIHByZWZpeC4gYHByb2Nlc3MuYXJndlsxXWAgaXMgdGhlXG4vLyBhYnNvbHV0ZSBwYXRoIG9mIGNsaS50cyB1bmRlciBgYnVuIOKApi9jbGkudHMgPHZlcmI+YCwgd2hpY2ggaXMgU0tJTEwubWQnc1xuLy8gY2Fub25pY2FsIGludm9jYXRpb24g4oCUIHNvIHRoZSBsaW5lIHdlIHByaW50IGNhbiBhY3R1YWxseSBiZSBwYXN0ZWQuIEZhbGxzXG4vLyBiYWNrIHRvIHRoZSBiYXJlIHZlcmIgaWYgYXJndiBpcyBub3Qgc2hhcGVkIGFzIGV4cGVjdGVkLCB3aGljaCBpcyBhIHZlcmJcbi8vIHJlZmVyZW5jZSByYXRoZXIgdGhhbiBhIGNvbW1hbmQgdGhhdCBsaWVzIGFib3V0IGJlaW5nIG9uZS5cbmZ1bmN0aW9uIGludm9jYXRpb25QcmVmaXgoKTogc3RyaW5nIHtcbiAgY29uc3QgZW50cnkgPSBwcm9jZXNzLmFyZ3ZbMV07XG4gIHJldHVybiBlbnRyeSA/IGBidW4gJHtlbnRyeX1gIDogXCJcIjtcbn1cblxuLy8gQSBkYWVtb24gcmVmdXNhbCBjYXJyaWVzIGBoaW50YCDigJQgdGhlIGFjdCB0aGF0IHJlY292ZXJzIGZyb20gaXQgKGEgNDA0IG9uIGFcbi8vIHJlYWQgbmFtZXMgdGhlIGBvcGVuYCB0aGF0IHdvdWxkIGNyZWF0ZSB0aGUgY2hhbm5lbCkuXG4vL1xuLy8g4pqgIGBoaW50YCBpcyBhIFZFUkIgSU5WT0NBVElPTiwgbm90IGEgc2hlbGwgY29tbWFuZDogdGhlIGRhZW1vbiBjYW5ub3Qga25vd1xuLy8gaG93IGl0cyBjbGllbnQgd2FzIGludm9rZWQsIHNvIGl0IG5hbWVzIHRoZSBhY3QgYW5kIHdlIHJlbmRlciBpdC4gSXQgdXNlZCB0b1xuLy8gYXJyaXZlIGFzIGBncmFwZXZpbmUgb3BlbiA8bmFtZT5gIGFuZCBiZSBwcmludGVkIHZlcmJhdGltIGFmdGVyIGB0cnk6YCwgd2hpY2hcbi8vIHJlYWRzIGFzIHNvbWV0aGluZyB0byBwYXN0ZSDigJQgYW5kIHBhc3RpbmcgaXQgZ2V0cyBgY29tbWFuZCBub3QgZm91bmRgLFxuLy8gYmVjYXVzZSBub3RoaW5nIGluc3RhbGxzIGEgYGdyYXBldmluZWAgYmluYXJ5LiBSdWxpbmcgMiBhc2tlZCB0aGF0IGEgcmVmdXNhbFxuLy8gbmFtZSB0aGUgbmV4dCBhY3Q7IGEgcmVjb3ZlcnkgdGhhdCBmYWlscyB3aGVuIHlvdSBydW4gaXQgZG9lcyBub3QuXG5mdW5jdGlvbiBkaWVBcGkoZGF0YTogeyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9IHwgbnVsbCwgc3RhdHVzOiBudW1iZXIpOiBuZXZlciB7XG4gIGNvbnN0IG1zZyA9IGRhdGE/LmVycm9yID8/IGBIVFRQICR7c3RhdHVzfWA7XG4gIGNvbnN0IHByZWZpeCA9IGludm9jYXRpb25QcmVmaXgoKTtcbiAgLy8g4puUIFRIRSBSRUNPVkVSWSBJUyBBIEZJRUxEIE5PVywgTk9UIEEgU0VOVEVOQ0UuIEl0IHVzZWQgdG8gYmUgYXBwZW5kZWQgdG8gdGhlXG4gIC8vIG1lc3NhZ2UgYXMgYOKAlCB0cnk6IDxjbWQ+YCwgd2hpY2ggYSBjYWxsZXIgaGFkIHRvIHJlY292ZXIgYnkgc3BsaXR0aW5nIG9uXG4gIC8vIFwidHJ5OiBcIiAob25lIG9mIGdyYXBldmluZSdzIG93biBjZWxscyBkaWQgZXhhY3RseSB0aGF0LCBhbmQgcmFuIHdoYXQgaXRcbiAgLy8gZm91bmQpLiBgaGludGAgaXMgd2hlcmUgdGhlIGVudmVsb3BlIGNhcnJpZXMgaXQsIHNvIHRoZSBzYW1lIGNlbGwgbm93IHJlYWRzXG4gIC8vIGEgZmllbGQgYW5kIHJ1bnMgaXQg4oCUIHRoZSBwcm9wZXJ0eSBpcyB1bmNoYW5nZWQgYW5kIHRoZSBwYXJzZSBpcyBub3QgYSBwYXJzZS5cbiAgY29uc3QgaGludCA9IGRhdGE/LmhpbnRcbiAgICA/IHByZWZpeFxuICAgICAgPyBgdHJ5OiAke3ByZWZpeH0gJHtkYXRhLmhpbnR9YFxuICAgICAgOiBgdHJ5IHRoZSBcXGAke2RhdGEuaGludH1cXGAgdmVyYmBcbiAgICA6IHVuZGVmaW5lZDtcbiAgZGllKG1zZywga2luZEZvclN0YXR1cyhzdGF0dXMpLCB7XG4gICAgLi4uKGhpbnQgPyB7IGhpbnQgfSA6IHt9KSxcbiAgICAvLyBUaGUgdXBzdHJlYW0ncyBib2R5IFZFUkJBVElNLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHdoYXQgdGhlIGRhZW1vblxuICAgIC8vIGFjdHVhbGx5IHNhaWQgcmF0aGVyIHRoYW4gb24gdGhpcyBDTEkncyBwcm9zZSBhYm91dCBpdC5cbiAgICAuLi4oZGF0YSAhPT0gbnVsbCA/IHsgc2VydmVyOiBkYXRhIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBFeGlzdGVuY2UgcHJvYmUgZm9yIHRoZSByZWFkIHZlcmJzIHRoYXQgYW5zd2VyIGZyb20gdGhlIExPRyBGSUxFIHJhdGhlciB0aGFuXG4vLyBmcm9tIGEgcm91dGUgKGB0cmlhZ2VgLCBgcHVsbCAtLXN0YXR1c2ApLiBUaG9zZSBjYW5ub3QgNDA0IG9uIHRoZWlyIG93bjogYVxuLy8gbWlzc2luZyBsb2cgaXMgYW4gZW1wdHkgYXJyYXksIHdoaWNoIGlzIHRoZSBzYW1lIHNpbGVudCBsaWUgdGhlIGRhZW1vbiBndWFyZFxuLy8gZXhpc3RzIHRvIGtpbGwuIEdFVCAvdG9waWMgaXMgdGhlIGNoZWFwZXN0IGd1YXJkZWQgcm91dGUsIHNvIGl0IGlzIHRoZSBwcm9iZS5cbmFzeW5jIGZ1bmN0aW9uIHJlcXVpcmVDaGFubmVsKHBvcnQ6IG51bWJlciwgbmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9PihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG9wdHM6IHsgdG9waWM/OiBzdHJpbmc7IGZyb20/OiBzdHJpbmc7IGZyZXNoPzogYm9vbGVhbiB9LFxuKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiA9IHsgbmFtZSwgZXhwbGljaXQ6IHRydWUgfTtcbiAgaWYgKG9wdHMudG9waWMgIT09IHVuZGVmaW5lZCkgYm9keS50b3BpYyA9IG9wdHMudG9waWM7XG4gIGlmIChvcHRzLmZyb20gIT09IHVuZGVmaW5lZCkgYm9keS5mcm9tID0gb3B0cy5mcm9tO1xuICBpZiAob3B0cy5mcmVzaCkgYm9keS5mcmVzaCA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8T3BlblJlc3BvbnNlPihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IGRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRvcGljKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHRleHQ6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgZnJvbTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB0b3BpYyA8Y2hhbm5lbD4gWzx0ZXh0Pl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgaWYgKHRleHQgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIGB0b3BpYyA8bmFtZT5gIHdpdGggbm8gdGV4dCBpcyBhIFJFQUQg4oCUIGl0IGFza3Mgd2hhdCB0aGUgdG9waWMgaXMsIGFuZCBhXG4gICAgLy8gbWlzc2luZyBjaGFubmVsIGFuc3dlcnMgdGhhdCBxdWVzdGlvbiBieSBiZWluZyBtaXNzaW5nLiBObyBlbnN1cmU6IHRoZVxuICAgIC8vIGVuc3VyZSB3YXMgd2hhdCByZXN1cnJlY3RlZCBhIGNsb3NlZCBjaGFubmVsIGZyb20gYSByZWFkIHZlcmIuXG4gICAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgKTtcbiAgICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gYHRvcGljIDxuYW1lPiA8dGV4dD5gIGlzIGEgV1JJVEUsIHNvIGl0IG1heSBjcmVhdGUg4oCUIGJ1dCBpdCBtdXN0IG5vdCB3cml0ZVxuICAvLyB0byBhbiBBUkNISVZFRCBjaGFubmVsLiBUaGUgUFVUIGVuZm9yY2VzIHRoYXQgaXRzZWxmIG5vdzsgdGhpcyBlbnN1cmUgc3RheXNcbiAgLy8gYmVjYXVzZSBESVNDQVJESU5HIElUUyBTVEFUVVMgaXMgcHJlY2lzZWx5IHRoZSBidWcgYmVpbmcgZml4ZWQgaGVyZS4gQmVmb3JlXG4gIC8vIHRvZGF5IHRoZSA0MDkgdGhhdCBhbnN3ZXJzIGZvciBhbiBhcmNoaXZlZCBuYW1lIHdhcyB0aHJvd24gYXdheSBhbmQgdGhlIFBVVFxuICAvLyB0aGF0IGZvbGxvd2VkIGxhbmRlZDogYGFyY2hpdmUgeDsgdG9waWMgeCBcInRcImAgcmV0dXJuZWQgb2s6dHJ1ZSwgZXhpdCAwLlxuICBjb25zdCBlbnN1cmUgPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9Pihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lIH0pO1xuICBpZiAoZW5zdXJlLnN0YXR1cyA+PSA0MDApIGRpZUFwaShlbnN1cmUuZGF0YSwgZW5zdXJlLnN0YXR1cyk7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8VG9waWNSZXNwb25zZT4ocG9ydCwgXCJQVVRcIiwgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCwge1xuICAgIHRvcGljOiB0ZXh0LFxuICAgIGZyb206IGZyb20gPz8gXCJzeXN0ZW1cIixcbiAgfSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYywgaWQ6IGRhdGE/LmlkIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRMaXN0KCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWxzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Q2hhbm5lbHNSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvY2hhbm5lbHNcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFNlbmQoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIG9wdHM6IHsgcXVpZXQ/OiBib29sZWFuOyB2ZXJib3NlPzogYm9vbGVhbjsgaW5SZXBseVRvPzogbnVtYmVyIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFmcm9tIHx8ICF0ZXh0KSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHNlbmQgPG5hbWU+IC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiB7IGZyb206IHN0cmluZzsgdGV4dDogc3RyaW5nOyBpbl9yZXBseV90bz86IG51bWJlciB9ID0ge1xuICAgIGZyb20sXG4gICAgdGV4dCxcbiAgfTtcbiAgaWYgKG9wdHMuaW5SZXBseVRvICE9PSB1bmRlZmluZWQpIGJvZHkuaW5fcmVwbHlfdG8gPSBvcHRzLmluUmVwbHlUbztcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTZW5kUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlc2AsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIC8vIFRhcmdldCBlY2hvIG9uIHN0ZGVyciDigJQgY29uZmlybXMgV0hFUkUgdGhlIG1lc3NhZ2UgbGFuZGVkIHNvIGEgbWlzcm91dGVkXG4gIC8vIHJlcGx5IChyaWdodCBwcm9tcHQsIHdyb25nIGNoYW5uZWwpIGlzIGNhdWdodCB0aGUgaW5zdGFudCBpdCBoYXBwZW5zIChGOSkuXG4gIC8vIE9uIHN0ZGVyciBzbyBpdCBuZXZlciBwb2xsdXRlcyB0aGUgc3Rkb3V0IEpTT04gcmVjZWlwdCwgYW5kIGl0IGZpcmVzIGV2ZW5cbiAgLy8gdW5kZXIgLS1xdWlldCAodGhlIHNhZmV0eSBzaWduYWwgc2hvdWxkbid0IGJlIHNpbGVuY2VkKS5cbiAgY29uc3QgcmVjaXAgPVxuICAgIGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkXG4gICAgICA/IGAke2RhdGEucmVjaXBpZW50c30gcmVjaXBpZW50KHMpYFxuICAgICAgOiBgJHtkYXRhLnN1YnNjcmliZXJzID8/IDB9IHN1YnNjcmliZXIocylgO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyDihpIgJHtkYXRhLmNoYW5uZWx9IMK3ICR7cmVjaXB9XFxuYCk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIC8vIFRlcnNlIGRlZmF1bHQ6IGlkICsgc3Vic2NyaWJlciBjb3VudCArIHZvaWQgd2FybmluZy4gLS12ZXJib3NlIGFsc29cbiAgLy8gaW5jbHVkZXMgdGhlIHN1YnNjcmliZXIgYWxpYXMgbGlzdCAoc2FtZSBkYXRhIGFzIHRoZSBgd2hvYCB2ZXJiLFxuICAvLyBwaWdneWJhY2tlZCB0byBhdm9pZCBhbiBleHRyYSByb3VuZC10cmlwIHdoZW4gdGhlIHNlbmRlciBjYXJlcykuXG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgaWQ6IGRhdGEuaWQsXG4gICAgY2hhbm5lbDogZGF0YS5jaGFubmVsLFxuICAgIHN1YnNjcmliZXJzOiBkYXRhLnN1YnNjcmliZXJzID8/IDAsXG4gIH07XG4gIC8vIE9ubHkgc3VyZmFjZSByZWNpcGllbnRzIGlmIHRoZSBkYWVtb24gYWN0dWFsbHkgY29tcHV0ZWQgaXQuIERlZmF1bHRpbmdcbiAgLy8gdG8gMCB3YXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBcInJlYWxseSAwXCIgYW5kIGhpZCBzaWxlbnQgVjEuNS1kYWVtb25cbiAgLy8gZGVncmFkYXRpb24gZHVyaW5nIGNyb3NzLXZlcnNpb24gc2Vzc2lvbnM7IG1pc3NpbmctbWVhbnMtbWlzc2luZyBpcyB0aGVcbiAgLy8gaG9uZXN0IHNpZ25hbC5cbiAgaWYgKGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkKSBvdXQucmVjaXBpZW50cyA9IGRhdGEucmVjaXBpZW50cztcbiAgaWYgKGRhdGEuc3Vic2NyaWJlcnMgPT09IDApIG91dC53YXJuaW5nID0gXCJjaGFubmVsIGhhcyBubyBzdWJzY3JpYmVyc1wiO1xuICBlbHNlIGlmIChkYXRhLnJlY2lwaWVudHMgPT09IDApIG91dC53YXJuaW5nID0gXCJvbmx5IHlvdSBhcmUgc3Vic2NyaWJlZFwiO1xuICBpZiAob3B0cy52ZXJib3NlKSBvdXQuc3Vic2NyaWJlcl9hbGlhc2VzID0gZGF0YS5zdWJzY3JpYmVyX2FsaWFzZXMgPz8gW107XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBbm5vdW5jZShcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNoYW5uZWxzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW4gfSxcbikge1xuICBpZiAoIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgYW5ub3VuY2UgLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGNoYW5uZWxzPzogc3RyaW5nW10gfSA9IHsgZnJvbSwgdGV4dCB9O1xuICBpZiAoY2hhbm5lbHM/Lmxlbmd0aCkgYm9keS5jaGFubmVscyA9IGNoYW5uZWxzO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPEFubm91bmNlUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIFwiL2Fubm91bmNlXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgIGAjIGFubm91bmNlZCDihpIgJHtkYXRhLmNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKSDCtyAke2RhdGEudG90YWxfcmVjaXBpZW50c30gcmVjaXBpZW50KHMpXFxuYCxcbiAgKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBjaGFubmVsczogZGF0YS5jaGFubmVscyxcbiAgICB0b3RhbF9yZWNpcGllbnRzOiBkYXRhLnRvdGFsX3JlY2lwaWVudHMsXG4gIH07XG4gIGlmIChkYXRhLnNraXBwZWQ/Lmxlbmd0aCkgb3V0LnNraXBwZWQgPSBkYXRhLnNraXBwZWQ7XG4gIGlmIChkYXRhLmNoYW5uZWxzLmxlbmd0aCA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm5vIGFjdGl2ZSBjaGFubmVscyB0byBhbm5vdW5jZSB0b1wiO1xuICBwcmludEpzb24ob3V0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUHVsbChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlOiBudW1iZXIsIG9wdHM6IHsgc3RhdHVzPzogc3RyaW5nIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcHVsbCA8Y2hhbm5lbD4gWy0tc2luY2UgPGlkPl0gWy0tc3RhdHVzIDx2YWx1ZT5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG5cbiAgaWYgKG9wdHMuc3RhdHVzICE9PSB1bmRlZmluZWQpIHtcbiAgICAvLyBUaGlzIGJyYW5jaCBhbnN3ZXJzIGZyb20gdGhlIGxvZyBmaWxlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24uXG4gICAgYXdhaXQgcmVxdWlyZUNoYW5uZWwocG9ydCwgbmFtZSk7XG4gICAgLy8gRnVsbC1jaGFubmVsIHNjYW46IGZpbHRlciBieSBsYXRlc3QgZGlzcG9zaXRpb24sIHN0YXR1cyBmcmFtZXMgZXhjbHVkZWQuXG4gICAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgICBjb25zdCBmaWx0ZXJlZCA9IGJhZGdlZC5maWx0ZXIoKG0pID0+IHtcbiAgICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgICAvLyBgLS1zdGF0dXMgb3BlbmAgbWlycm9ycyB0cmlhZ2UncyBvcGVuIGJ1Y2tldDogc2lnbmFsLW9ubHksIHNvIG5vbi1tZXNzYWdlXG4gICAgICAvLyBGWUlzICh0b3BpYy9hbm5vdW5jZW1lbnQpIGFyZSBleGNsdWRlZCBmcm9tIHRoZSBhY3Rpb25hYmxlIHF1ZXVlLlxuICAgICAgcmV0dXJuIG9wdHMuc3RhdHVzID09PSBcIm9wZW5cIlxuICAgICAgICA/IG0ua2luZCA9PT0gXCJtZXNzYWdlXCIgJiYgaXNPcGVuKGRpc3BBcmcpXG4gICAgICAgIDogbS5kaXNwb3NpdGlvbiA9PT0gb3B0cy5zdGF0dXM7XG4gICAgfSk7XG4gICAgY29uc3QgbGFzdElkID0gZmlsdGVyZWQuYXQoLTEpPy5pZCA/PyAwO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogZmlsdGVyZWQsIGN1cnNvcjogbGFzdElkIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpbmNlLXdpbmRvdyBwYXRoICh1bmNoYW5nZWQgZnJvbSBUYXNrIDIpLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtzaW5jZX1gLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIGNvbnN0IHJhd01zZ3MgPSBkYXRhPy5tZXNzYWdlcyA/PyBbXTtcbiAgY29uc3QgY3Vyc29yID0gcmF3TXNncy5hdCgtMSk/LmlkID8/IHNpbmNlO1xuICBjb25zdCBkaXNwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgYW5ub3RhdGVkID0gcmF3TXNnc1xuICAgIC8vIERpc3Bvc2l0aW9uIGZyYW1lcyBvbmx5IOKAlCBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHN0YXlzIGluXG4gICAgLy8gdGhlIGhpc3RvcnkgYW4gYWdlbnQgcHVsbHM7IGl0IGlzIGhvdyBpdCBsZWFybnMgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQuXG4gICAgLmZpbHRlcigobSkgPT4gIWlzRGlzcG9zaXRpb25GcmFtZShtKSlcbiAgICAubWFwKChtKSA9PiB7XG4gICAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgICByZXR1cm4gZCA/IHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbTtcbiAgICB9KTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBhbm5vdGF0ZWQsIGN1cnNvciB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhZChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIGlkOiBudW1iZXIsIG9wdHM6IHsgdGV4dD86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVhZCA8Y2hhbm5lbD4gPGlkPiBbLS10ZXh0XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBCdWlsdCBvbiB0aGUgZXhpc3RpbmcgcmFuZ2UgZmV0Y2gg4oCUIGBzaW5jZT1pZC0xYCByZXR1cm5zIGlkIGFuZCBiZXlvbmQ7XG4gIC8vIHdlIHBpY2sgdGhlIGV4YWN0IGlkLiBObyBkYWVtb24gQVBJIGNoYW5nZS4gVGhpcyBpcyB0aGUgdGFyZ2V0ZWRcbiAgLy8gXCJnaXZlIG1lIG1lc3NhZ2UgTiBpbiBmdWxsXCIgdmVyYiB0aGF0IHJlY292ZXJzIGEgY2xpcHBlZCB0YWlsIHByZXZpZXdcbiAgLy8gd2l0aG91dCB0aGUgcHVsbC1yYW5nZSArIGpxIGRhbmNlLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtpZCAtIDF9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBjb25zdCBtc2cgPSAoZGF0YT8ubWVzc2FnZXMgPz8gW10pLmZpbmQoKG0pID0+IG0uaWQgPT09IGlkKTtcbiAgaWYgKCFtc2cpIGRpZShgbWVzc2FnZSAke2lkfSBub3QgZm91bmQgaW4gJHtuYW1lfWAsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCBkaXNwTWFwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgZCA9IGRpc3BNYXAuZ2V0KGlkKTtcbiAgY29uc3QgYW5ub3RhdGVkTXNnID0gZCA/IHsgLi4ubXNnLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0gOiBtc2c7XG4gIGlmIChvcHRzLnRleHQpIHtcbiAgICAvLyBQcm9zZSBtb2RlOiBoZWFkZXIgKyBib2R5LCBubyBKU09OIGVudmVsb3BlLCBzbyBhIGh1bWFuIChvciBhbiBhZ2VudFxuICAgIC8vIHJlY292ZXJpbmcgYSB0cnVuY2F0ZWQgbm90aWZpY2F0aW9uKSBjYW4gcmVhZCBpdCBkaXJlY3RseS5cbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG1zZy50cykudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCBkaXNwUHJlZml4ID0gZFxuICAgICAgPyBkLnJlb3BlbnMgPiAwXG4gICAgICAgID8gYFske2QuZGlzcG9zaXRpb259IOKGuyR7ZC5yZW9wZW5zfV0gYFxuICAgICAgICA6IGBbJHtkLmRpc3Bvc2l0aW9ufV0gYFxuICAgICAgOiBcIlwiO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2Rpc3BQcmVmaXh9WyR7bXNnLmlkfV0gJHttc2cuZnJvbX0gwrcgJHt0c31cXG4ke21zZy50ZXh0fVxcbmApO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZTogYW5ub3RhdGVkTXNnIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXYWl0KFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHNpbmNlOiBudW1iZXIsXG4gIHRpbWVvdXRTOiBudW1iZXIsXG4gIGFsaWFzOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdhaXQgPGNoYW5uZWw+IFstLWFzIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBHaXZlIHRoZSBIVFRQIGZldGNoIGEgc2xpZ2h0bHkgaGlnaGVyIGFib3J0IHRpbWVvdXQgdGhhbiB0aGUgZGFlbW9uJ3NcbiAgLy8gbG9uZy1wb2xsIHRpbWVvdXQgc28gdGhlIGRhZW1vbiBhbHdheXMgd2lucyB0aGUgdGltZW91dCByYWNlLlxuICAvLyBgP2FzPTxhbGlhcz5gIHJlZ2lzdGVycyBwcmVzZW5jZSBvbiB0aGUgY2hhbm5lbCBmb3IgdGhlIHdhaXQgZHVyYXRpb24g4oCUXG4gIC8vIHdhaXQgaXMgbG9uZy1wb2xsIChwdXNoLXNoYXBlZCB3aXRoIGEgZGVhZGxpbmUpIHNvIGl0IGRlc2VydmVzIHByZXNlbmNlLlxuICBjb25zdCBhc1BhcmFtID0gYWxpYXMgPyBgJmFzPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGFsaWFzKX1gIDogXCJcIjtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFubmVscy8ke25hbWV9L3dhaXQ/c2luY2U9JHtzaW5jZX0mdGltZW91dD0ke3RpbWVvdXRTfSR7YXNQYXJhbX1gO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcbiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoKHRpbWVvdXRTICsgNSkgKiAxMDAwKSxcbiAgfSk7XG4gIGxldCBkYXRhOiBXYWl0UmVzcG9uc2UgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFdhaXRSZXNwb25zZTtcbiAgfSBjYXRjaCB7fVxuICBpZiAoIXJlcy5vaykgZGllQXBpKGRhdGEsIHJlcy5zdGF0dXMpO1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIG1lc3NhZ2VzOiBkYXRhPy5tZXNzYWdlcyA/PyBbXSxcbiAgICBjdXJzb3I6IGRhdGE/LmN1cnNvciA/PyBzaW5jZSxcbiAgICB0aW1lZF9vdXQ6ICEhZGF0YT8udGltZWRfb3V0LFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2hvIDxjaGFubmVsPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsOiBuYW1lLCBzdWJzY3JpYmVyczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3Vic2NyaWJlcnNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9zdWJzY3JpYmVyc2AsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdob0FsbCgpIHtcbiAgLy8gQ3Jvc3MtY2hhbm5lbCByb3N0ZXIg4oCUIG5hbWVzIMOXIGNoYW5uZWwgaW4gb25lIGNhbGwsIHNvIHlvdSBkb24ndCBmYW4gb3V0XG4gIC8vIE4gYHdob2AgY2FsbHMgKyBhIG1hbnVhbCBqb2luIHRvIGFuc3dlciBcIndobyBpcyBvbiB3aGljaCB2aW5lP1wiLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWxzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gR2V0IG9yIHNldCB0aGUgcGVyc2lzdGVkIGRlZmF1bHQgYWxpYXMgKFYxLjcpLiBXaXRoIG5vIGFyZ3VtZW50LCBwcmludHMgdGhlXG4vLyBjdXJyZW50IGFsaWFzOyB3aXRoIG9uZSwgd3JpdGVzIGl0IHRvIGNvbmZpZy5qc29uLiBQdXJlIGZpbGUgSS9PIOKAlCB3b3Jrc1xuLy8gd2l0aG91dCBhIHJ1bm5pbmcgZGFlbW9uLiBUaGUgd2F0Y2ggc3VyZmFjZSByZWFkcyBpdCB2aWEgR0VUIC9pZGVudGl0eSBzbyB0aGVcbi8vIGh1bWFuIGhhcyBhIGNvbnNpc3RlbnQgbmFtZSBhY3Jvc3MgZXZlcnkgZ3JhcGV2aW5lLlxuYXN5bmMgZnVuY3Rpb24gY21kQWxpYXMobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGxldCBjZmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHRyeSB7XG4gICAgY2ZnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoQ09ORklHX0ZJTEUsIFwidXRmLThcIikpO1xuICB9IGNhdGNoIHt9XG4gIGlmIChuYW1lID09PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBhbGlhcyA9IHR5cGVvZiBjZmcuYWxpYXMgPT09IFwic3RyaW5nXCIgJiYgY2ZnLmFsaWFzLnRyaW0oKSA/IGNmZy5hbGlhcy50cmltKCkgOiBudWxsO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhcyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgdHJpbW1lZCA9IG5hbWUudHJpbSgpO1xuICBjZmcuYWxpYXMgPSB0cmltbWVkO1xuICBta2RpclN5bmMoREFUQV9ESVIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKENPTkZJR19GSUxFLCBgJHtKU09OLnN0cmluZ2lmeShjZmcsIG51bGwsIDIpfVxcbmApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgYWxpYXM6IHRyaW1tZWQgfHwgbnVsbCB9KTtcbn1cblxuLyoqXG4gKiBUaGUgc3RhbmRpbmcgdGFpbCDigJQgYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCwgYWRvcHRlZCBhdCBQaGFzZSA2IGNoYXB0ZXIgMi5cbiAqXG4gKiDim5QgV0hBVCBUSElTIFJFUExBQ0VELCBBTkQgV0hBVCBJVCBCT1VHSFQuIFRoaXMgdmVyYiB3YXMgMjIwIGxpbmVzIG9mXG4gKiBoYW5kLXdyaXR0ZW4gcmVjb25uZWN0IGxvb3A6IHRocmVlIG5lc3RlZCBsb29wcyAocmVjb25uZWN0IC8gcmVhZCAvIGZyYW1lXG4gKiBkcmFpbiksIGl0cyBvd24gU1NFIHNwbGl0dGVyLCBpdHMgb3duIGJhY2tvZmYsIGFuZCBhIGBwcm9jZXNzLmV4aXQoMClgIGluIGFcbiAqIHNpZ25hbCBoYW5kbGVyIHNldmVuIGxpbmVzIGluLiBUaGUgc2hhcmVkIGNsaWVudCBpcyB0aGUgc2FtZSBkZXNpZ24sIG9uY2UsIGFuZFxuICogdGhyZWUgdGhpbmdzIGFycml2ZSB3aXRoIGl0IHRoYXQgZ3JhcGV2aW5lIGRpZCBub3QgaGF2ZTpcbiAqXG4gKiAgIDEuICoqQU4gSURMRSBXQVRDSERPRyDigJQgZ3JhcGV2aW5lIGhhZCBOT05FLioqIGBhd2FpdCByZWFkZXIucmVhZCgpYCB3YXNcbiAqICAgICAgdW5ib3VuZGVkLCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYVxuICogICAgICBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSLCBhbmQgYSBwYXJrZWQgdGFpbCBpc1xuICogICAgICBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgcXVpZXQgY2hhbm5lbC4gYFRBSUxfSURMRV9NU2AgaXMgdGhyZWUgb2YgVEhJU1xuICogICAgICBzcGVsbCdzIDMgcyBiZWF0cyAoYC4vaGVhcnRiZWF0LnRzYCksIG5ldmVyIGEgY29waWVkIDQ1LDAwMC5cbiAqICAgMi4gKipBIFNQRUMtQ09SUkVDVCBGUkFNRSBQQVJTRVIuKiogVGhlIGhhbmQtd3JpdHRlbiBvbmUgZGlkXG4gKiAgICAgIGBsaW5lLnNsaWNlKDUpLnRyaW0oKWAsIHdoaWNoIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiB0aGUgb25lXG4gKiAgICAgIGxlYWRpbmcgc3BhY2UgdGhlIHNwZWMgcmVtb3ZlcyDigJQgaXQgd291bGQgY29ycnVwdCBhIG1lc3NhZ2UgYm9keSB3aG9zZVxuICogICAgICBmaXJzdCBsaW5lIGlzIGluZGVudGVkLiBOb3RoaW5nIGluIHRoZSByb3N0ZXIgZW1pdHMgb25lIHRvZGF5OyB0aGUgcGFyc2VcbiAqICAgICAgaXMgcmlnaHQgYW55d2F5IG5vdy5cbiAqICAgMy4gKipBIFNJR05BTCBQQVRIIFRIQVQgRFJBSU5TLioqIFRoZSBvbGQgaGFuZGxlciB3YXNcbiAqICAgICAgYHN0b3BwZWQgPSB0cnVlOyBwcm9jZXNzLmV4aXQoMClgIOKAlCB0aGUgUDBmIGRlZmVjdCBleGFjdGx5LCBhcHBsaWVkIHRvXG4gKiAgICAgIHRoZSB0ZXJtaW5hbCBmcmFtZSBpbiBmaXZlIHNwZWxscyBhbmQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmVcbiAqICAgICAgbGluZXMgYWJvdmUgaXQuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkXG4gKiAgICAgIHN0ZG91dC4gVGhlIGNsaWVudCBSRVRVUk5TIGFuIGV4aXQgY29kZTsgYG1haW5gIGFzc2lnbnMgaXQgYW5kIHJldHVybnNcbiAqICAgICAgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zLlxuICpcbiAqIOKblCBOTyBgZXBvY2hPZmAgLyBgb25FcG9jaENoYW5nZWAsIEFORCBUSEFUIElTIEEgUlVMSU5HLCBOT1QgQU4gT01JU1NJT05cbiAqIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0IOKAlCBgbG9hZENoYW5uZWwoKWBcbiAqIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgaGlnaC13YXRlciBtYXJrIG92ZXIgdGhlIGR1cmFibGUgYC5qc29ubGAg4oCUIHNvIGFcbiAqIHJlY29ubmVjdGluZyBjdXJzb3IgaXMgc3RpbGwgdmFsaWQgYW5kIHRoZSBjb25kaXRpb24gYW4gZXBvY2ggZGV0ZWN0cyBjYW5ub3RcbiAqIG9jY3VyIGhlcmUuIFdpcmluZyBvbmUgd291bGQgYmUgYSBSRUdSRVNTSU9OIHdpdGggYSBtZWFzdXJlZCBtZWNoYW5pc206XG4gKiBgb25FcG9jaENoYW5nZWAgc2V0cyBgY3Vyc29yID0gMGAsIGFuZCB0aGlzIGRhZW1vbiBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoXG4gKiBgcmVhZEJhY2tsb2cobmFtZSwgMClgIOKAlCB0aGUgd2hvbGUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW4gYWdlbnQncyBwaXBlLFxuICogb24gZXZlcnkgYGdyYXBldmluZSByb2xsYC5cbiAqXG4gKiDimqAgYHJlc29sdmVgIENBTExTIGBlbnN1cmVEYWVtb25gLCBXSElDSCBDQU4gUkFJU0Ug4oCUIGRlbGliZXJhdGVseSwgYW5kIHRoZSBraXRcbiAqIGRvY3VtZW50cyB0aGUgcHJvcGVydHkgdGhpcyBkZXBlbmRzIG9uOiBpdHMgb3V0ZXIgYmxvY2sgaXMgYSBgdHJ5YC9gZmluYWxseWBcbiAqIHdpdGggTk8gYGNhdGNoYCwgc28gYSBgQ2xpRXJyb3JgIGZyb20gdGhyZWUgZnJhbWVzIGRvd24gcHJvcGFnYXRlcyBpbnRvXG4gKiBgbWFpbmAgaW5zdGVhZCBvZiBiZWluZyByZWFkIGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZCByZXRyaWVkIGZvcmV2ZXIuXG4gKiBDaGVja2VkIGF0IHRoZSBhZG9wdGlvbiByYXRoZXIgdGhhbiBhc3N1bWVkIChwbGF5Ym9vayBCOSBzdGVwIDUpLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG9wdHM6IHtcbiAgICBzaW5jZT86IG51bWJlcjtcbiAgICBmcm9tU3RhcnQ/OiBib29sZWFuO1xuICAgIGxhc3Q/OiBudW1iZXI7XG4gICAgYXM/OiBzdHJpbmc7XG4gICAgaHVtYW4/OiBib29sZWFuO1xuICAgIGx1cms/OiBib29sZWFuO1xuICAgIG1heD86IG51bWJlcjtcbiAgfSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghbmFtZSlcbiAgICBkaWUoXG4gICAgICBcInVzYWdlOiBncmFwZXZpbmUgdGFpbCA8bmFtZT4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVwiLFxuICAgICk7XG4gIC8vIC0tbHVyayByZWNlaXZlcyBtZXNzYWdlcyBidXQgcmVnaXN0ZXJzIG5vIHByZXNlbmNlIOKAlCBhbiBpbnZpc2libGUgb2JzZXJ2ZXIuXG4gIC8vIEl0IG92ZXJyaWRlcyBpZGVudGl0eSBmbGFncyAoYSBsdXJrZXIgaGFzIG5vIG5hbWUgdG8gc2hvdykuXG4gIGNvbnN0IG15QWxpYXMgPSBvcHRzLmx1cmsgPyB1bmRlZmluZWQgOiBvcHRzLmFzO1xuICBjb25zdCBzaW5jZSA9IG9wdHMuZnJvbVN0YXJ0ID8gMCA6IChvcHRzLnNpbmNlID8/IC0xKTtcbiAgLy8gRW1pdCB0aGUgZ3JvdW5kaW5nIGxpbmUgb25seSBvbiB0aGUgZmlyc3Qgc3Vic2NyaWJlLCBuZXZlciBvbiByZWNvbm5lY3RzXG4gIC8vIChhIHJlY29ubmVjdCByZXN1bWVzIGZyb20gdGhlIGN1cnNvciDigJQgdGhlcmUgaXMgbm8gdW5zZWVuIGhpc3RvcnkgdGhlbikuXG4gIC8vIOKblCBBTkQgTkVWRVIgT04gQSBgLS1zaW5jZWAgUkUtQVJNIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBBMyk6IHRoZVxuICAvLyBhZ2VudCBhbHJlYWR5IGtub3dzIHRoZSBjaGFubmVsLCBhbmQgdGhlIGhpc3RvcnkgaGludCB3b3VsZCBiZSBub2lzZS5cbiAgbGV0IGdyb3VuZGVkID0gb3B0cy5zaW5jZSAhPT0gdW5kZWZpbmVkO1xuICAvLyDim5QgVEhFIEJPT0tNQVJLIEZPUiBBIExJVkUtT05MWSBUQUlMLiBgc2luY2UgPSAtMWAgYXNrcyBmb3Igbm8gaGlzdG9yeSwgc28gYVxuICAvLyB0YWlsIHRoYXQgc2VlcyBubyBtZXNzYWdlIGhhcyBubyBpZCB0byBoYW5kIGl0cyByZS1hcm0sIGFuZCB0aGUgcmUtYXJtXG4gIC8vIHdvdWxkIG1pc3MgZXZlcnl0aGluZyBzZW50IGluIHRoZSBnYXAuIFRoZSBgc3Vic2NyaWJlZGAgbWFya2VyIGNhcnJpZXMgdGhlXG4gIC8vIGNoYW5uZWwncyBgbGF0ZXN0X2lkYDogc2VlZGluZyB0aGUgY3Vyc29yIGZyb20gaXQgbWFrZXMgdGhlIGhhbmRvZmYnc1xuICAvLyBgLS1zaW5jZWAgZXhhY3QuIE9ubHkgZm9yIGEgbGl2ZS1vbmx5IHN0YXJ0IOKAlCBhIGJhY2tmaWxsaW5nIG9uZSAoYC0tbGFzdGAsXG4gIC8vIGAtLWZyb20tc3RhcnRgLCBgLS1zaW5jZWApIGlzIHN0aWxsIHJlYWRpbmcgaWRzIGF0IG9yIGJlbG93IGl0LCBhbmQgYVxuICAvLyByZWNvbm5lY3QgbWlkLWJhY2tmaWxsIG11c3Qgbm90IHNraXAgcGFzdCB0aGVtLlxuICAvLyBPbmNlOiBhIGxhdGVyIG1hcmtlciAoYSByZWNvbm5lY3QpIG11c3Qgbm90IGp1bXAgdGhlIGN1cnNvciBwYXN0IG1lc3NhZ2VzXG4gIC8vIGl0cyBvd24gYmFja2xvZyBpcyBhYm91dCB0byByZXBsYXkuXG4gIGxldCBzZWVkRnJvbU1hcmtlciA9IHNpbmNlIDwgMCAmJiBvcHRzLmxhc3QgPT09IHVuZGVmaW5lZDtcblxuICAvLyDim5QgQSBQUkVTRU5DRSBTUEVMTDogdGhlIGNvbm5lY3Rpb24gSVMgYHdob2AncyBwcmVzZW5jZSwgc28gdGhlIHdpbmRvd1xuICAvLyBhbHdheXMgbmFtZXMgdGhlIE1vbml0b3IgcmUtYXJtLCBuZXZlciB0aGUgc3RvcC1zdGFydCBgLS1vbmNlYCwgYW5kIGEgbG9zdFxuICAvLyBkYWVtb24gaXMgcmV0cmllZCAoYHJlc29sdmVgIHJlc3Bhd25zIGl0KSwgbm90IHJlcG9ydGVkLlxuICBjb25zdCBhZ2FpbiA9IChhdDogbnVtYmVyKSA9PlxuICAgIGNvbW1hbmRMaW5lKFtcbiAgICAgIFwidGFpbFwiLFxuICAgICAgbmFtZSxcbiAgICAgIC4uLihvcHRzLmx1cmsgPyBbXCItLWx1cmtcIl0gOiBteUFsaWFzID8gW1wiLS1hc1wiLCBteUFsaWFzXSA6IFtdKSxcbiAgICAgIC4uLihvcHRzLmh1bWFuICYmICFvcHRzLmx1cmsgPyBbXCItLWh1bWFuXCJdIDogW10pLFxuICAgICAgLi4uKG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBbXCItLW1heFwiLCBTdHJpbmcob3B0cy5tYXgpXSA6IFtdKSxcbiAgICAgIC8vIGAtLXNpbmNlYCB0YWtlcyBubyBuZWdhdGl2ZSBoZXJlOyBhIHRhaWwgdGhhdCBuZXZlciBsZWFybmVkIGFuIGlkXG4gICAgICAvLyByZS1hcm1zIGxpdmUtb25seSwgd2hpY2ggaXMgd2hhdCAtMSBtZWFudC5cbiAgICAgIC4uLihhdCA+PSAwID8gW1wiLS1zaW5jZVwiLCBTdHJpbmcoYXQpXSA6IFtdKSxcbiAgICBdKTtcblxuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPFRhaWxQYXlsb2FkPihcbiAgICB7XG4gICAgICAvLyDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVELiBBIHRhaWwgb3V0bGl2ZXNcbiAgICAgIC8vIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0IOKAlCBgcm9sbGAgYW5kIGByZXN0YXJ0YCBib3RoIHJlcGxhY2UgaXQg4oCUIGFuZFxuICAgICAgLy8gYGVuc3VyZURhZW1vbmAgcmUtcmVhZHMgdGhlIHBvcnQgZmlsZSBhbmQgcmVzcGF3bnMsIHNvIGEgcmVjb25uZWN0IGFmdGVyIGFcbiAgICAgIC8vIHJvbGwgbGFuZHMgb24gdGhlIE5FVyBkYWVtb24gcmF0aGVyIHRoYW4gc3Bpbm5pbmcgYWdhaW5zdCBhIGRlYWQgcG9ydC5cbiAgICAgIHJlc29sdmU6IGFzeW5jICgpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7YXdhaXQgZW5zdXJlRGFlbW9uKCl9YCxcbiAgICAgIHBhdGg6IGAvY2hhbm5lbHMvJHtuYW1lfS90YWlsYCxcbiAgICAgIHNpbmNlLFxuICAgICAgLy8g4pqgIE5PIGVuc3VyZSBjYWxsIGJlZm9yZSB0aGUgc3Vic2NyaWJlLiBBIGZyZXNoIGB0YWlsIG5hbWVgIHN0aWxsIHdvcmtzXG4gICAgICAvLyB3aXRob3V0IGFuIGV4cGxpY2l0IG9wZW4g4oCUIEdFVCDigKYvdGFpbCBjcmVhdGVzIHRoZSBjaGFubmVsIGl0c2VsZiDigJQgYW5kXG4gICAgICAvLyB0aGF0IGlzIHRoZSBPTkxZIHdheSB0aGUgc3Vic2NyaWJlZCBldmVudCdzIGBjcmVhdGVkYCBmbGFnIGNhbiBldmVyIGJlXG4gICAgICAvLyB0cnVlOiBhbiBlbnN1cmUgc2VudCBmaXJzdCBjcmVhdGVzIHRoZSBjaGFubmVsLCBzbyB0aGUgc3Vic2NyaWJlIHRoYXRcbiAgICAgIC8vIGZvbGxvd3MgYWx3YXlzIHJlcG9ydHMgYGNyZWF0ZWQ6ZmFsc2VgIGFuZCB0aGUgbWlzdHlwZWQtbmFtZSBzaWduYWwgbmV2ZXJcbiAgICAgIC8vIGZpcmVzLlxuICAgICAgcXVlcnk6IChjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPT4ge1xuICAgICAgICBjb25zdCBxOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgICAgLy8gIzY4IOKAlCBgLS1sYXN0IE5gIHJpZGVzIHRoZSBGSVJTVCBjb25uZWN0aW9uIG9ubHkuIE9uY2UgYW55IG1lc3NhZ2VcbiAgICAgICAgLy8gbGFuZHMgdGhlIGN1cnNvciBhZHZhbmNlcyBhbmQgYSByZWNvbm5lY3QgcmVzdW1lcyBmcm9tIGl0IHZpYSBgc2luY2VgLFxuICAgICAgICAvLyBuZXZlciByZS1iYWNrZmlsbGluZyB0aGUgd2luZG93LiBgZmlyc3RDb25uZWN0YCBpcyB0aGUga2l0J3MgcGFyYW1ldGVyXG4gICAgICAgIC8vIGZvciBleGFjdGx5IHRoaXM7IHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCBzcGVsbGVkIGl0IGBoaWdoZXN0U2VlbiA8IDBgLFxuICAgICAgICAvLyB3aGljaCB3YXMgdGhlIHNhbWUgdGVzdCBieSBhY2NpZGVudCBvZiB0aGUgc2VudGluZWwuXG4gICAgICAgIGlmIChvcHRzLmxhc3QgIT09IHVuZGVmaW5lZCAmJiBmaXJzdENvbm5lY3QpIHEubGFzdCA9IFN0cmluZyhvcHRzLmxhc3QpO1xuICAgICAgICBpZiAobXlBbGlhcykgcS5hcyA9IG15QWxpYXM7XG4gICAgICAgIGlmIChvcHRzLmh1bWFuICYmICFvcHRzLmx1cmspIHEuaHVtYW4gPSBcIjFcIjtcbiAgICAgICAgaWYgKG9wdHMubHVyaykgcS5sdXJrID0gXCIxXCI7XG4gICAgICAgIHJldHVybiBxO1xuICAgICAgfSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIikgcmV0dXJuIGV2LmlkO1xuICAgICAgICBpZiAoc2VlZEZyb21NYXJrZXIgJiYgdHlwZW9mIGV2LmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgIHNlZWRGcm9tTWFya2VyID0gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIGV2LmxhdGVzdF9pZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfSxcbiAgICAgIGFjY2VwdDogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICAvLyBUaGUgc3Vic2NyaWJlZCBtYXJrZXIgaXMgbm90IGEgbWVzc2FnZTsgYHJlbmRlcmAgYW5zd2VycyBpdC5cbiAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHRydWU7XG4gICAgICAgIC8vIERyb3AgRElTUE9TSVRJT04gZnJhbWVzIOKAlCB0aGV5IGFyZSBtZXRhZGF0YSBhYm91dCBhbm90aGVyIG1lc3NhZ2UuIEFcbiAgICAgICAgLy8gbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgcGFzc2VzIHRocm91Z2g6IGFuIGFnZW50IHRhaWxpbmcgYVxuICAgICAgICAvLyBjaGFubmVsIGNvdWxkIG5vdCBwcmV2aW91c2x5IHNlZSBlaXRoZXIgcGFydHkgcmV0aXJlIGl0LCBhbmQgZm91bmQgb3V0XG4gICAgICAgIC8vIHdoZW4gaXRzIG5leHQgc2VuZCB3YXMgcmVqZWN0ZWQuXG4gICAgICAgIGlmIChpc0Rpc3Bvc2l0aW9uRnJhbWUoZXYpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIC8vIFN1cHByZXNzIHNlbGYtZWNobzogd2hlbiAtLWFzIGlzIHNldCwgZHJvcCBtZXNzYWdlcyB3ZSBzZW50IG91cnNlbHZlcy5cbiAgICAgICAgLy8gVGhlIHNlbmRlciBhbHJlYWR5IGdvdCB0aGUgcmVjZWlwdCBhcyB0aGUgUE9TVCByZXNwb25zZSwgc28gcmUtZW1pdHRpbmdcbiAgICAgICAgLy8gaXQgb24gdGFpbCBpcyBwdXJlIG5vaXNlLlxuICAgICAgICBpZiAobXlBbGlhcyAmJiBldi5mcm9tID09PSBteUFsaWFzKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKHBheWxvYWQsIGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiByZW5kZXJTdWJzY3JpYmVkKHBheWxvYWQpO1xuICAgICAgICAvLyAjNjcg4oCUIGZyb250LWxvYWQgYSByZWNvdmVyeSBwb2ludGVyIG9uIEVWRVJZIG1lc3NhZ2UgZnJhbWUsIHNvIHRoZSByZWFkXG4gICAgICAgIC8vIGNvb3JkaW5hdGVzIHN1cnZpdmUgYSBkb3duc3RyZWFtIG5vdGlmaWNhdGlvbiBjbGlwLiBNb25pdG9yIHRydW5jYXRlcyBhdFxuICAgICAgICAvLyBpdHMgT1dOIGNhcCAoYmVsb3cgb3VyIGhpbnQgdGhyZXNob2xkLCBhbmQgb25lIHdlIGNhbm5vdCBvYnNlcnZlIGhlcmUpOyBhXG4gICAgICAgIC8vIG1lc3NhZ2UgaXQgY2xpcHMgd291bGQgb3RoZXJ3aXNlIGxvc2UgaXRzIHRyYWlsaW5nIGBpZGAgYW5kIGJlY29tZVxuICAgICAgICAvLyB1bnJlY292ZXJhYmxlIOKAlCB0aGUgcmVhZGVyIGlzIGxlZnQgaW5mZXJyaW5nIHRoZSBpZC4gRXZlcnkgZnJhbWVcbiAgICAgICAgLy8gdGhlcmVmb3JlIGNhcnJpZXMgYSBGUk9OVC1sb2FkZWQgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLCBlaXRoZXIgYXMgdGhlXG4gICAgICAgIC8vIHJpY2hlciBgdHJ1bmNhdGlvbl9oaW50YCAoZ2VudWluZWx5LWxvbmcgbWVzc2FnZXMg4oCUIHRoZSBcIitOIGNoYXJzLFxuICAgICAgICAvLyB5b3UncmUgZGVmaW5pdGVseSBtaXNzaW5nIGNvbnRlbnRcIiBhbGFybSkgb3IgYXMgdGhlIGNvbXBhY3QgYGZ1bGxgXG4gICAgICAgIC8vIHBvaW50ZXIuIFNlcmlhbGl6aW5nIGl0IGJlZm9yZSB0aGUgbG9uZyBgLnRleHRgIGlzIHdoYXQgbWFrZXMgaXQgc3Vydml2ZVxuICAgICAgICAvLyB0aGUgY2xpcCAoRjE3KS5cbiAgICAgICAgY29uc3QgcmVhZFJlZiA9IGByZWFkICR7bmFtZX0gJHtwYXlsb2FkLmlkfWA7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgcGF5bG9hZC50ZXh0ID09PSBcInN0cmluZ1wiICYmXG4gICAgICAgICAgcGF5bG9hZC50ZXh0Lmxlbmd0aCA+IChvcHRzLm1heCA/PyBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEKVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB0cnVuY2F0aW9uX2hpbnQgPSBgKyR7cGF5bG9hZC50ZXh0Lmxlbmd0aH0gY2hhcnMg4oCUIGZ1bGw6ICR7cmVhZFJlZn1gO1xuICAgICAgICAgIC8vIENhcCB0aGUgSU5MSU5FIGJvZHkgd2hlbiAtLW1heCBpcyBzZXQgKHRoZSBmdWxsIG1lc3NhZ2Ugc3RheXMgb24gZGlza1xuICAgICAgICAgIC8vIOKGkiBgcmVhZGApOyB3aXRob3V0IC0tbWF4LCBlbWl0IHRoZSBmdWxsIHRleHQgKHRvZGF5J3MgZGVmYXVsdCkuXG4gICAgICAgICAgY29uc3QgdGV4dCA9IG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBwYXlsb2FkLnRleHQuc2xpY2UoMCwgb3B0cy5tYXgpIDogcGF5bG9hZC50ZXh0O1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHRydW5jYXRpb25faGludCwgLi4ucGF5bG9hZCwgdGV4dCB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBmdWxsOiByZWFkUmVmLCAuLi5wYXlsb2FkIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIERhZW1vbiBsaXZlbmVzcyBoZWFydGJlYXQgKGA6IGhiIDx0cz5gKS4gU3VyZmFjZSBhIHJlY29nbml6YWJsZSBzZW50aW5lbFxuICAgICAgLy8gb24gc3RkZXJyIHNvIGEgYDI+JjFgIGNvbnN1bWVyIGNhbiB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiAoRjYpLiBLZXB0XG4gICAgICAvLyBvZmYgc3Rkb3V0IOKAlCB0aGUgSlNPTkwgc3RyZWFtIHN0YXlzIHB1cmUuXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiAodGV4dC50cmltU3RhcnQoKS5zdGFydHNXaXRoKFwiaGJcIikgPyBcIjogZ3JhcGV2aW5lLWtlZXBhbGl2ZVwiIDogbnVsbCksXG4gICAgICBvbk1hbGZvcm1lZDogKF9mcmFtZSwgZSkgPT4gYCMgYmFkIHNzZSBkYXRhOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgLy8gVGhlIGZvdXIgbGluZXMgdGhlIGhhbmQtd3JpdHRlbiBsb29wIHdyb3RlLCBwcmVzZXJ2ZWQgdmVyYmF0aW0g4oCUIGEgdGFpbFxuICAgICAgLy8gdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBvbmUgdGhhdCBpcyB3b3JraW5nLlxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBzd2l0Y2ggKGluZm8uY2F1c2UpIHtcbiAgICAgICAgICBjYXNlIFwiY29ubmVjdC1mYWlsZWRcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBjb25uZWN0IGZhaWxlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZXRyeWluZ+KApmA7XG4gICAgICAgICAgY2FzZSBcImh0dHBcIjpcbiAgICAgICAgICBjYXNlIFwibm8tYm9keVwiOlxuICAgICAgICAgICAgcmV0dXJuIGAjIHRhaWwgSFRUUCAke2luZm8uc3RhdHVzfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZXJyb3JcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBzdHJlYW0gZHJvcHBlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZWNvbm5lY3RpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZW5kXCI6XG4gICAgICAgICAgICByZXR1cm4gXCIjIHN0cmVhbSBjbG9zZWQsIHJlY29ubmVjdGluZ+KAplwiO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJncmFwZXZpbmVcIixcbiAgICAgIG1vZGU6IFwid2F0Y2hcIixcbiAgICAgIHByZXNlbmNlOiB0cnVlLFxuICAgICAgLy8gRDQ6IGEgaHVtYW4gYXQgYSB0ZXJtaW5hbCAoYC0taHVtYW5gKSBpcyBub3QgYW4gYWdlbnQgdW5kZXJcbiAgICAgIC8vIE1vbml0b3IncyBjYXAsIHNvIHRoZWlyIHdhdGNoIG5ldmVyIGVuZHMgYnkgaXRzZWxmLlxuICAgICAgLi4uKG9wdHMuaHVtYW4gPyB7IHdpbmRvd01zOiAwIH0gOiB7fSksXG4gICAgICAvLyBUaGUgYHN1YnNjcmliZWRgIG1hcmtlciAoYW5kIHRoZSBncm91bmRpbmcgbGluZSBpdCByZW5kZXJzKSBpcyBub3QgYVxuICAgICAgLy8gbWVzc2FnZSBvbiB0aGUgY2hhbm5lbC5cbiAgICAgIGNvdW50czogKF9ldiwgZnJhbWUpID0+IGZyYW1lLmV2ZW50ICE9PSBcInN1YnNjcmliZWRcIixcbiAgICAgIGNvbW1hbmRzOiB7XG4gICAgICAgIHRhaWw6ICh7IHNpbmNlOiBhdCB9KSA9PiBhZ2FpbihhdCksXG4gICAgICAgIGNvbWVCYWNrOiAoKSA9PiBjb21tYW5kTGluZShbXCJkb2N0b3JcIl0pLFxuICAgICAgfSxcbiAgICB9LFxuICApO1xuXG4gIC8qKiBUaGUgYHN1YnNjcmliZWRgIG1hcmtlcjogc3RkZXJyIGNvbnRleHQsIHBsdXMgYSBzdHJ1Y3R1cmVkIGdyb3VuZGluZyBsaW5lXG4gICAqICBvbiBzdGRvdXQgdGhlIEZJUlNUIHRpbWUgb25seS4gKi9cbiAgZnVuY3Rpb24gcmVuZGVyU3Vic2NyaWJlZChwYXlsb2FkOiBUYWlsUGF5bG9hZCk6IHN0cmluZyB8IG51bGwge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHN1YnNjcmliZWQgdG8gJHtwYXlsb2FkLmNoYW5uZWx9IChzaW5jZT0ke3BheWxvYWQuc2luY2V9KVxcbmApO1xuICAgIGlmIChwYXlsb2FkLnRvcGljKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB0b3BpYzogJHtwYXlsb2FkLnRvcGljfVxcbmApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIHRoaXMgdGFpbCBicm91Z2h0IGl0IGludG8gYmVpbmcgKGNoZWNrIHRoZSBuYW1lKVxcbmAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjICR7cGF5bG9hZC5jaGFubmVsfSBpcyBhcmNoaXZlZCDigJQgcmVhZC1vbmx5OyBhIHNlbmQgd2lsbCBiZSByZWplY3RlZFxcbmAsXG4gICAgICApO1xuICAgIC8vIFN0cnVjdHVyZWQgZ3JvdW5kaW5nIG9uIHN0ZG91dCAoRjMvRjcpIOKAlCB1bmRlciB0aGUgZGVmYXVsdCBXaXJpbmctQlxuICAgIC8vIE1vbml0b3IsIHN0ZG91dCBzdXJmYWNlcyBhcyBub3RpZmljYXRpb25zLCBzbyBhIGZyZXNoIHN1YnNjcmliZXIgYWN0dWFsbHlcbiAgICAvLyBzZWVzIHRoZSB0b3BpYyArIHRoYXQgZWFybGllciBoaXN0b3J5IGV4aXN0cy4gR2F0ZWQ6IG9ubHkgd2hlbiB0aGVyZSdzXG4gICAgLy8gc29tZXRoaW5nIHRvIGdyb3VuZCAodW5zZWVuIGhpc3Rvcnkgb3IgYSB0b3BpYyksIGFuZCBvbmx5IG9uIHRoZSBmaXJzdFxuICAgIC8vIHN1YnNjcmliZSAobm90IHJlY29ubmVjdHMpLlxuICAgIGlmIChncm91bmRlZCkgcmV0dXJuIG51bGw7XG4gICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgIGNvbnN0IGxhdGVzdCA9IHR5cGVvZiBwYXlsb2FkLmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIiA/IHBheWxvYWQubGF0ZXN0X2lkIDogMDtcbiAgICBjb25zdCBlYXJsaWVyID0gc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5tYXgoMCwgTWF0aC5taW4oc2luY2UsIGxhdGVzdCkpO1xuICAgIC8vIGBjcmVhdGVkYCBhbmQgYGFyY2hpdmVkYCBqb2luIHRoZSBnYXRlIG9uIHB1cnBvc2UuIEEgY2hhbm5lbCB0aGlzXG4gICAgLy8gc3Vic2NyaWJlIGp1c3QgbWFkZSBoYXMgbm8gdG9waWMgYW5kIG5vIGhpc3RvcnksIHNvIHRoZSBvbGQgY29uZGl0aW9uXG4gICAgLy8gKGBlYXJsaWVyID4gMCB8fCB0b3BpY2ApIGlzIGV4YWN0bHkgdGhlIGNhc2UgdGhhdCBlbWl0cyBOT1RISU5HOyBhbmQgYW5cbiAgICAvLyBBUkNISVZFRCBjaGFubmVsJ3MgZ3JvdW5kaW5nIGxpbmUgd2FzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBoZWFsdGh5XG4gICAgLy8gb25lJ3MsIHNvIGEgbGF0ZSBqb2luZXIgc3RpbGwgbGVhcm5lZCB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZCBvbmx5IHdoZW5cbiAgICAvLyBpdHMgc2VuZCBib3VuY2VkLlxuICAgIC8vXG4gICAgLy8g4pqgIFRoZSBoaW50cyBBQ0NVTVVMQVRFIGludG8gYSBsaXN0IHJhdGhlciB0aGFuIGFzc2lnbmluZyB0byBvbmUgZmllbGQuXG4gICAgLy8gVGhleSB1c2VkIHRvIGJlIHRocmVlIGFzc2lnbm1lbnRzIHRvIGBncm91bmRpbmcuaGludGAsIG9yZGVyZWQgc28gdGhlIG1vc3RcbiAgICAvLyBpbXBvcnRhbnQgd29uIOKAlCB3aGljaCBpcyBhIGhpbnQgdGhhdCBjYW4gc2lsZW50bHkgbG9zZSB0byBhbm90aGVyIGhpbnQsXG4gICAgLy8gdGhlIGZhaWx1cmUgbW9kZSB0aGlzIHdob2xlIGJyYW5jaCBpcyBhYm91dCwgc2l0dGluZyBpbiB0aGUgZml4IGZvciBpdC4gQVxuICAgIC8vIGxpc3QgY2Fubm90IG92ZXJ3cml0ZTogYW4gYXJjaGl2ZWQgY2hhbm5lbCBXSVRIIGhpc3Rvcnkgbm93IHNheXMgYm90aC5cbiAgICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoZWFybGllciA+IDApXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtlYXJsaWVyfSBlYXJsaWVyIG1lc3NhZ2UocykgZXhpc3Qg4oCUIHVzZSAtLWZyb20tc3RhcnQgb3IgLS1zaW5jZSA8aWQ+IHRvIGJhY2tmaWxsYCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGB0aGlzIHRhaWwgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIG5vIHN1Y2ggY2hhbm5lbCBleGlzdGVkOyBjaGVjayB0aGUgbmFtZSwgb3IgYW5vdGhlciBwYXJ0eSBoYXMgeWV0IHRvIG9wZW4gaXRgLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWQgdW50aWwgc29tZW9uZSB1bmFyY2hpdmVzIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKCEoZWFybGllciA+IDAgfHwgcGF5bG9hZC50b3BpYyB8fCBwYXlsb2FkLmNyZWF0ZWQgfHwgcGF5bG9hZC5hcmNoaXZlZCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGdyb3VuZGluZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICBraW5kOiBcImdyb3VuZGluZ1wiLFxuICAgICAgY2hhbm5lbDogcGF5bG9hZC5jaGFubmVsLFxuICAgICAgam9pbmVkX2F0OiBzaW5jZSA8IDAgPyBsYXRlc3QgOiBNYXRoLm1pbihzaW5jZSwgbGF0ZXN0KSxcbiAgICAgIGVhcmxpZXIsXG4gICAgfTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgZ3JvdW5kaW5nLnRvcGljID0gcGF5bG9hZC50b3BpYztcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKSBncm91bmRpbmcuY3JlYXRlZCA9IHRydWU7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpIGdyb3VuZGluZy5hcmNoaXZlZCA9IHRydWU7XG4gICAgaWYgKGhpbnRzLmxlbmd0aCkgZ3JvdW5kaW5nLmhpbnQgPSBoaW50cy5qb2luKFwiIMK3IFwiKTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZ3JvdW5kaW5nKTtcbiAgfVxufVxuZnVuY3Rpb24gZm9sZERpc3Bvc2l0aW9ucyhuYW1lOiBzdHJpbmcpIHtcbiAgY29uc3QgbWFwID0gbmV3IE1hcDxcbiAgICBudW1iZXIsXG4gICAge1xuICAgICAgZGlzcG9zaXRpb246IHN0cmluZztcbiAgICAgIGZyb206IHN0cmluZztcbiAgICAgIHRzOiBudW1iZXI7XG4gICAgICBub3RlOiBzdHJpbmc7XG4gICAgICByZW9wZW5zOiBudW1iZXI7XG4gICAgfVxuICA+KCk7XG4gIGNvbnN0IHBhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIG1hcDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCAhPT0gXCJzdGF0dXNcIiB8fCB0eXBlb2YgbS50YXJnZXQgIT09IFwibnVtYmVyXCIgfHwgdHlwZW9mIG0uZGlzcG9zaXRpb24gIT09IFwic3RyaW5nXCIpXG4gICAgICBjb250aW51ZTtcbiAgICBjb25zdCBwcmV2ID0gbWFwLmdldChtLnRhcmdldCk7XG4gICAgY29uc3QgcmVvcGVucyA9XG4gICAgICAocHJldj8ucmVvcGVucyA/PyAwKSArXG4gICAgICAobS5kaXNwb3NpdGlvbiA9PT0gXCJvcGVuXCIgJiYgcHJldiAmJiBwcmV2LmRpc3Bvc2l0aW9uICE9PSBcIm9wZW5cIiA/IDEgOiAwKTtcbiAgICBtYXAuc2V0KG0udGFyZ2V0LCB7XG4gICAgICBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbixcbiAgICAgIGZyb206IG0uZnJvbSxcbiAgICAgIHRzOiBtLnRzLFxuICAgICAgbm90ZTogbS50ZXh0LFxuICAgICAgcmVvcGVucyxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gbWFwO1xufVxuLy8gVFdPIHRoaW5ncyBub3cgd2VhciBraW5kOlwic3RhdHVzXCIuIEEgRElTUE9TSVRJT04gZnJhbWUgYWN0cyBvbiBhIHNwZWNpZmljXG4vLyBtZXNzYWdlIChgdGFyZ2V0YCArIGBkaXNwb3NpdGlvbmApIGFuZCBpcyBtZXRhZGF0YSDigJQgYHB1bGxgIGFuZCBgdGFpbGAgZm9sZFxuLy8gaXQgYXdheSBhbmQgYmFkZ2UgdGhlIG1lc3NhZ2UgaXQgcG9pbnRzIGF0IGluc3RlYWQuIEEgTElGRUNZQ0xFIGZyYW1lXG4vLyAoYXJjaGl2ZSAvIHVuYXJjaGl2ZSkgaXMgYSBmYWN0IGFib3V0IHRoZSBDSEFOTkVMOiBpdCB0YXJnZXRzIG5vdGhpbmcsIGFuZCBpdFxuLy8gaXMgdGhlIHdob2xlIHBvaW50IHRoYXQgYSByZWFkZXIgc2VlcyBpdC4gRGlzY3JpbWluYXRpbmcgb24gYGRpc3Bvc2l0aW9uYFxuLy8gcmF0aGVyIHRoYW4gb24gYGV2ZW50YCBrZWVwcyBhIGZyYW1lIGZyb20gc29tZSBmdXR1cmUgZW1pdHRlciB2aXNpYmxlIGJ5XG4vLyBkZWZhdWx0IOKAlCB0aGUgZmFpbHVyZSBtb2RlIGhlcmUgaXMgc3dhbGxvd2luZyBhIHNpZ25hbCwgbm90IHNob3dpbmcgb25lLlxuZnVuY3Rpb24gaXNEaXNwb3NpdGlvbkZyYW1lKG06IHsga2luZD86IHN0cmluZzsgZGlzcG9zaXRpb24/OiBzdHJpbmcgfSk6IGJvb2xlYW4ge1xuICByZXR1cm4gbS5raW5kID09PSBcInN0YXR1c1wiICYmIHR5cGVvZiBtLmRpc3Bvc2l0aW9uID09PSBcInN0cmluZ1wiO1xufVxuXG4vLyBcIm9wZW5cIiA9IG5vIGVudHJ5LCBvciBsYXRlc3QgZGlzcG9zaXRpb24gaXMgXCJvcGVuXCJcbmZ1bmN0aW9uIGlzT3BlbihkPzogeyBkaXNwb3NpdGlvbjogc3RyaW5nIH0pIHtcbiAgcmV0dXJuICFkIHx8IGQuZGlzcG9zaXRpb24gPT09IFwib3BlblwiO1xufVxuXG4vLyBSZWFkcyB0aGUgZnVsbCBjaGFubmVsIGxvZywgZHJvcHMgRVZFUlkga2luZDpcInN0YXR1c1wiIGZyYW1lLCBhbmQgYmFkZ2VzIGVhY2hcbi8vIHJlbWFpbmluZyBtZXNzYWdlIHdpdGggaXRzIGxhdGVzdCBkaXNwb3NpdGlvbiB2aWEgZm9sZERpc3Bvc2l0aW9ucy5cbi8vXG4vLyBFdmVyeSBvbmUsIGRlbGliZXJhdGVseSDigJQgaW5jbHVkaW5nIGEgbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSksXG4vLyB3aGljaCBgcHVsbGAgYW5kIGB0YWlsYCBkbyBsZXQgdGhyb3VnaC4gVGhpcyBmZWVkcyBgdHJpYWdlYCwgd2hvc2Ugb3BlbiBxdWV1ZVxuLy8gaXMgXCJ3aGF0IGlzIGxlZnQgdG8gYWN0IG9uXCIsIGFuZCBhbiBhcmNoaXZlIGlzIGFuIEZZSSwgbm90IGEgd29yayBpdGVtLiBTYW1lXG4vLyByZWFzb24gYHRvcGljYCBhbmQgYGFubm91bmNlbWVudGAgYXJlIGZvbGRlZCBvdXQgb2YgdGhlIG9wZW4gYnVja2V0IGJlbG93LlxuZnVuY3Rpb24gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChcbiAgbmFtZTogc3RyaW5nLFxuKTogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10ge1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHJldHVybiBbXTtcbiAgY29uc3QgZGlzcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IG1lc3NhZ2VzOiAoTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfSlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIikuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgbTogTWVzc2FnZTtcbiAgICB0cnkge1xuICAgICAgbSA9IEpTT04ucGFyc2UobGluZSkgYXMgTWVzc2FnZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobS5raW5kID09PSBcInN0YXR1c1wiKSBjb250aW51ZTtcbiAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgaWYgKGQpIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2goeyAuLi5tLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWVzc2FnZXM7XG59XG5cbnR5cGUgQmFkZ2VkTWVzc2FnZSA9IE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH07XG5cbi8vIERhc2hib2FyZCByZW5kZXIgb2YgYSB0cmlhZ2Ugc2NhbjogdGhlIG9wZW4gcXVldWUgb24gdG9wLCB0aGVuIGVhY2hcbi8vIGRpc3Bvc2l0aW9uIGdyb3VwLCBvbmUgc2Nhbm5hYmxlIGxpbmUgcGVyIG1lc3NhZ2UuIE1pcnJvcnMgYHJlYWQgLS10ZXh0YFxuLy8gcHJvc2UgbW9kZSBzbyBhIGh1bWFuIChvciBhbiBhZ2VudCkgcmVhZHMgaXQgd2l0aG91dCBwYXJzaW5nIEpTT04uXG5mdW5jdGlvbiByZW5kZXJUcmlhZ2VIdW1hbihcbiAgbmFtZTogc3RyaW5nLFxuICBvcGVuOiBCYWRnZWRNZXNzYWdlW10sXG4gIGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmUgPSAobTogQmFkZ2VkTWVzc2FnZSkgPT4ge1xuICAgIGNvbnN0IHRzID0gbmV3IERhdGUobS50cykudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxNikucmVwbGFjZShcIlRcIiwgXCIgXCIpO1xuICAgIGNvbnN0IHJlb3BlbiA9IG0ucmVvcGVucyAmJiBtLnJlb3BlbnMgPiAwID8gYCDihrske20ucmVvcGVuc31gIDogXCJcIjtcbiAgICAvLyBUaGUgZmlyc3QgbGluZSwgd2l0aG91dCBhbiBpbmRleCByZWFkIGBzcGxpdGAgd291bGQgbWFrZSB0aGUgY29tcGlsZXJcbiAgICAvLyBkb3VidDogYHNwbGl0YCBuZXZlciByZXR1cm5zIGFuIGVtcHR5IGFycmF5LCBhbmQgdGhpcyBzYXlzIHRoZSBzYW1lIHRoaW5nLlxuICAgIGNvbnN0IG5sID0gbS50ZXh0LmluZGV4T2YoXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZCA9IG5sID09PSAtMSA/IG0udGV4dCA6IG0udGV4dC5zbGljZSgwLCBubCk7XG4gICAgY29uc3QgcHJldmlldyA9IGhlYWQubGVuZ3RoID4gMTAwID8gYCR7aGVhZC5zbGljZSgwLCA5OSl94oCmYCA6IGhlYWQ7XG4gICAgcmV0dXJuIGAgIFske20uaWR9JHtyZW9wZW59XSAke20uZnJvbX0gwrcgJHt0c30gwrcgJHtwcmV2aWV3fWA7XG4gIH07XG4gIGNvbnN0IHNlY3Rpb25zID0gW2Ake25hbWV9IMK3IHRyaWFnZVxcbmAsIGBPUEVOICgke29wZW4ubGVuZ3RofSlgXTtcbiAgc2VjdGlvbnMucHVzaChvcGVuLmxlbmd0aCA/IG9wZW4ubWFwKGxpbmUpLmpvaW4oXCJcXG5cIikgOiBcIiAg4oCUXCIpO1xuICBmb3IgKGNvbnN0IFtzdGF0dXMsIGl0ZW1zXSBvZiBPYmplY3QuZW50cmllcyhieV9zdGF0dXMpKSB7XG4gICAgc2VjdGlvbnMucHVzaChgXFxuJHtzdGF0dXMudG9VcHBlckNhc2UoKX0gKCR7aXRlbXMubGVuZ3RofSlgLCBpdGVtcy5tYXAobGluZSkuam9pbihcIlxcblwiKSk7XG4gIH1cbiAgcmV0dXJuIGAke3NlY3Rpb25zLmpvaW4oXCJcXG5cIil9XFxuYDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVHJpYWdlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgb3B0czogeyBodW1hbj86IGJvb2xlYW4gfSA9IHt9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB0cmlhZ2UgPGNoYW5uZWw+IFstLWh1bWFuXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyB0cmlhZ2UgcmVhZHMgdGhlIGxvZyBmaWxlLCBub3QgYSByb3V0ZSwgc28gaXQgY2Fubm90IDQwNCBvbiBpdHMgb3duIOKAlCBhbmRcbiAgLy8gYW4gZW1wdHkgZGFzaGJvYXJkIGZvciBhIGNoYW5uZWwgdGhhdCBkb2VzIG5vdCBleGlzdCBpcyB0aGUgc2FtZSBzaWxlbnQgbGllXG4gIC8vIGFzIGFuIGVtcHR5IGBwdWxsYC5cbiAgYXdhaXQgcmVxdWlyZUNoYW5uZWwocG9ydCwgbmFtZSk7XG4gIGNvbnN0IGJhZGdlZCA9IGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQobmFtZSk7XG4gIGNvbnN0IG9wZW46IEJhZGdlZE1lc3NhZ2VbXSA9IFtdO1xuICBjb25zdCBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4gPSB7fTtcbiAgZm9yIChjb25zdCBtIG9mIGJhZGdlZCkge1xuICAgIC8vIGlzT3BlbiBleHBlY3RzIGEgZGlzcG9zaXRpb24gZW50cnkgb2JqZWN0IChvciB1bmRlZmluZWQgZm9yIG5vIGVudHJ5KS5cbiAgICBjb25zdCBkaXNwQXJnID0gbS5kaXNwb3NpdGlvbiAhPT0gdW5kZWZpbmVkID8geyBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbiB9IDogdW5kZWZpbmVkO1xuICAgIGlmIChpc09wZW4oZGlzcEFyZykpIHtcbiAgICAgIC8vIFRoZSBvcGVuIHF1ZXVlIGlzIHNpZ25hbC1vbmx5OiBza2lwIG5vbi1hY3Rpb25hYmxlIGZyYW1lcyAodG9waWMvXG4gICAgICAvLyBhbm5vdW5jZW1lbnQgRllJcyBjYW4gbmV2ZXIgY2FycnkgYSBkaXNwb3NpdGlvbiwgc28gdGhleSdkIG90aGVyd2lzZVxuICAgICAgLy8gcGFkIFwid2hhdCdzIGxlZnQ/XCIgZm9yZXZlcikuXG4gICAgICBpZiAobS5raW5kID09PSBcIm1lc3NhZ2VcIikgb3Blbi5wdXNoKG0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBrZXkgPSBtLmRpc3Bvc2l0aW9uID8/IFwidW5rbm93blwiO1xuICAgICAgaWYgKCFieV9zdGF0dXNba2V5XSkgYnlfc3RhdHVzW2tleV0gPSBbXTtcbiAgICAgIGJ5X3N0YXR1c1trZXldLnB1c2gobSk7XG4gICAgfVxuICB9XG4gIGlmIChvcHRzLmh1bWFuKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUocmVuZGVyVHJpYWdlSHVtYW4obmFtZSwgb3BlbiwgYnlfc3RhdHVzKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBvcGVuLCBieV9zdGF0dXMgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEdyZXAoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcGF0dGVybjogc3RyaW5nLFxuICBvcHRzOiB7IGxpdGVyYWw/OiBib29sZWFuOyBmcm9tPzogc3RyaW5nIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFwYXR0ZXJuKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgZ3JlcCA8Y2hhbm5lbD4gPHBhdHRlcm4+IFstLWxpdGVyYWx8LUZdIFstLWZyb20gPGFsaWFzPl1cIik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhsb2dQYXRoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCBtYXRjaGVyOiAodGV4dDogc3RyaW5nKSA9PiBib29sZWFuO1xuICBpZiAob3B0cy5saXRlcmFsKSB7XG4gICAgY29uc3QgbmVlZGxlID0gcGF0dGVybi50b0xvd2VyQ2FzZSgpO1xuICAgIG1hdGNoZXIgPSAodGV4dCkgPT4gdGV4dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5lZWRsZSk7XG4gIH0gZWxzZSB7XG4gICAgbGV0IHJlOiBSZWdFeHA7XG4gICAgdHJ5IHtcbiAgICAgIHJlID0gbmV3IFJlZ0V4cChwYXR0ZXJuLCBcImlcIik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGllKGBpbnZhbGlkIHJlZ2V4OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLCBcInVzYWdlXCIpO1xuICAgIH1cbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHJlLnRlc3QodGV4dCk7XG4gIH1cbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IG1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJhdy5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZSkgY29udGludWU7XG4gICAgbGV0IG1zZzogUGFydGlhbDxNZXNzYWdlPjtcbiAgICB0cnkge1xuICAgICAgbXNnID0gSlNPTi5wYXJzZShsaW5lKSBhcyBQYXJ0aWFsPE1lc3NhZ2U+O1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuICAgIGlmIChvcHRzLmZyb20gJiYgbXNnLmZyb20gIT09IG9wdHMuZnJvbSkgY29udGludWU7XG4gICAgaWYgKCFtYXRjaGVyKG1zZy50ZXh0KSkgY29udGludWU7XG4gICAgbWVzc2FnZXMucHVzaChtc2cpO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlcyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQ2xvc2UobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBjbG9zZSA8bmFtZT5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIGRpZShcIm5vIGRhZW1vbiBydW5uaW5nXCIsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihwb3J0LCBcIkRFTEVURVwiLCBgL2NoYW5uZWxzLyR7bmFtZX1gKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzZXQobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+ID0ge307XG4gIGlmIChvcHRzLmZvcmNlKSBib2R5LmZvcmNlID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBzdWJzY3JpYmVycz86IG51bWJlciB9PihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9yZXNldGAsXG4gICAgYm9keSxcbiAgKTtcbiAgaWYgKHN0YXR1cyA9PT0gNDA5ICYmIGRhdGE/LmVycm9yID09PSBcImxpdmVcIikge1xuICAgIGRpZShcbiAgICAgIGBjaGFubmVsIGhhcyAke2RhdGEuc3Vic2NyaWJlcnN9IGxpdmUgc3Vic2NyaWJlcihzKSDigJQgcmVmdXNpbmcgdG8gY2xlYXIgYSBsaXZlIHNlc3Npb24uIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gY2xlYXIgYW55d2F5ICh0aGUgbG9nIGlzIHNuYXBzaG90dGVkIGZpcnN0KS5gLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gQXJjaGl2ZSAocmVhZC1vbmx5KSBvciB1bmFyY2hpdmUgYSBjaGFubmVsIChWMS43KSDigJQgdGhlIG5vbi1kZXN0cnVjdGl2ZVxuLy8gYWx0ZXJuYXRpdmUgdG8gY2xvc2U6IGhpc3RvcnkgaXMgcHJlc2VydmVkLCBzZW5kcyBhcmUgcmVqZWN0ZWQsIGFuZCB0aGUgbmFtZVxuLy8gaXMgbG9ja2VkIGZyb20gcmUtb3BlbiB1bnRpbCB1bmFyY2hpdmVkLlxuYXN5bmMgZnVuY3Rpb24gY21kTWFyayhcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZDogbnVtYmVyLFxuICBkaXNwb3NpdGlvbjogc3RyaW5nLFxuICBmcm9tOiBzdHJpbmcsXG4gIG9wdHM6IHsgbm90ZT86IHN0cmluZyB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGlkKSB8fCAhZGlzcG9zaXRpb24pXG4gICAgZGllKFwidXNhZ2U6IGdyYXBldmluZSBtYXJrIDxjaGFubmVsPiA8aWQ+IDxkaXNwb3NpdGlvbj4gWy0tbm90ZSA8dGV4dD5dIFstLWFzIDxhbGlhcz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBmcm9tLCB0YXJnZXQ6IGlkLCBkaXNwb3NpdGlvbiB9O1xuICBpZiAob3B0cy5ub3RlICE9PSB1bmRlZmluZWQpIGJvZHkubm90ZSA9IG9wdHMubm90ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlPihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L3N0YXR1c2AsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEgYXMgeyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9IHwgbnVsbCwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBcmNoaXZlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgdW5hcmNoaXZlOiBib29sZWFuLCBmcm9tPzogc3RyaW5nKSB7XG4gIGNvbnN0IHZlcmIgPSB1bmFyY2hpdmUgPyBcInVuYXJjaGl2ZVwiIDogXCJhcmNoaXZlXCI7XG4gIGlmICghbmFtZSkgZGllKGB1c2FnZTogZ3JhcGV2aW5lICR7dmVyYn0gPGNoYW5uZWw+YCk7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQm90aCByb3V0ZXMgYXBwZW5kIGEga2luZDpcInN0YXR1c1wiIGZyYW1lIHRvIHRoZSBsb2csIHNvIHdobyBkaWQgaXQgaXMgd29ydGhcbiAgLy8gcmVjb3JkaW5nIHdoZW4gdGhlIGNhbGxlciB0b2xkIHVzLiBJZGVudGl0eSBpcyBvcHRpb25hbCBoZXJlIChpdCBpcyBvbiB0aGVcbiAgLy8gZ2xvYmFsbHktYWNjZXB0ZWQgLS1hcy8tLWZyb20pLCBhbmQgdGhlIGRhZW1vbiBzaWducyBcInN5c3RlbVwiIHdpdGhvdXQgaXQuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJQT1NUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9LyR7dmVyYn1gLFxuICAgIGZyb20gPyB7IGZyb20gfSA6IHVuZGVmaW5lZCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RvcChvcHRzOiB7IGhvbGRTZWNvbmRzPzogbnVtYmVyIH0gPSB7fSkge1xuICBsZXQgaGVsZFVudGlsOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGlmIChvcHRzLmhvbGRTZWNvbmRzICYmIG9wdHMuaG9sZFNlY29uZHMgPiAwKSB7XG4gICAgaGVsZFVudGlsID0gRGF0ZS5ub3coKSArIG9wdHMuaG9sZFNlY29uZHMgKiAxMDAwO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKGhlbGRVbnRpbCkpO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgZGFlbW9uOiBmYWxzZSxcbiAgICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHN0b3BwZWQ6IHRydWUsXG4gICAgLi4uKGhlbGRVbnRpbCAhPT0gdW5kZWZpbmVkID8geyBoZWxkX3VudGlsOiBoZWxkVW50aWwgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIFBlci1jaGFubmVsIGxpdmUtY29ubmVjdGlvbiBzdW1tYXJ5IOKAlCB0aGUgcmVzdGFydC1zYWZldHkgcmVhZC4gTWlycm9ycyB3aGF0XG4vLyBgZG9jdG9yYCByZXBvcnRzIHVuZGVyIGFjdGl2ZV9zdWJzY3JpYmVyczsgb25seSBwb3B1bGF0ZWQgY2hhbm5lbHMgYXJlIGxpc3RlZC5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoQWN0aXZlU3Vic2NyaWJlcnMoXG4gIHBvcnQ6IG51bWJlcixcbik6IFByb21pc2U8eyB0b3RhbDogbnVtYmVyOyBjaGFubmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbm5lY3Rpb25zOiBudW1iZXIgfT4gfT4ge1xuICBsZXQgdG90YWwgPSAwO1xuICBjb25zdCBjaGFubmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbm5lY3Rpb25zOiBudW1iZXIgfT4gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICBmb3IgKGNvbnN0IGNoIG9mIGRhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICB0b3RhbCArPSBjaC5jb25uZWN0aW9ucztcbiAgICAgIGlmIChjaC5jb25uZWN0aW9ucyA+IDApIGNoYW5uZWxzLnB1c2goeyBuYW1lOiBjaC5uYW1lLCBjb25uZWN0aW9uczogY2guY29ubmVjdGlvbnMgfSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydCDigJQgYSBwcmVzZW5jZSBoaWNjdXAgc2hvdWxkbid0IGNyYXNoIGEgbGlmZWN5Y2xlIHZlcmJcbiAgfVxuICByZXR1cm4geyB0b3RhbCwgY2hhbm5lbHMgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhcnQoKSB7XG4gIC8vIEVuc3VyZS1ydW5uaW5nLCBubyBjaGFubmVsIHNpZGUtZWZmZWN0LiBJZGVtcG90ZW50OiByZXBvcnQgYW4gZXhpc3RpbmdcbiAgLy8gZGFlbW9uLCBvciBzcGF3biBhIGZyZXNoIG9uZS4gVGhlIGV4cGxpY2l0IFwiYnJpbmcgaXQgdXBcIiB2ZXJiIOKAlCBkaWFnbm9zdGljc1xuICAvLyAoZG9jdG9yL2luZm8vbGlzdCkgc3RheSByZWFkLW9ubHkgYW5kIG5ldmVyIHNwYXduLlxuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghZXhpc3RpbmcgJiYgaG9sZEFjdGl2ZSgpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGhlbGQ6IHRydWUsIHBvcnQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBvcnQgPSBleGlzdGluZyA/PyAoYXdhaXQgZW5zdXJlRGFlbW9uKCkpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcG9ydCwgYWxyZWFkeV9ydW5uaW5nOiBleGlzdGluZyAhPT0gbnVsbCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzdGFydChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICAvLyBOb3RoaW5nIHRvIHRlYXIgZG93biDigJQganVzdCBicmluZyBhIGZyZXNoIGRhZW1vbiB1cC5cbiAgICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCByZXN0YXJ0ZWQ6IHRydWUsIHBvcnQ6IGZyZXNoLCBwcmV2aW91c19waWQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFNBRkVUWTogYSByZXN0YXJ0IGZvcmNlcyBldmVyeSBjb25uZWN0ZWQgY2xpZW50IHRvIGF1dG8tcmVjb25uZWN0LiBSZWZ1c2UgdG9cbiAgLy8gdGVhciBkb3duIGEgd29ya2luZyBmbGVldCB1bmxlc3MgZXhwbGljaXRseSBmb3JjZWQg4oCUIG5ldmVyIHNpbGVudGx5IGRyb3AgaXQuXG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByZXN0YXJ0OiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSBhY3Jvc3MgJHtjaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykg4oCUICR7d2hlcmV9LiBgICtcbiAgICAgICAgXCJBIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSBhbGwgdG8gcmVjb25uZWN0LiBSZS1ydW4gd2l0aCAtLWZvcmNlIChvciAtLXllcykgdG8gcHJvY2VlZCBhbnl3YXkuXCIsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgfVxuICAvLyBDYXB0dXJlIHRoZSBwaWQgd2UncmUgcmVwbGFjaW5nLCBmb3IgdGhlIHJlY2VpcHQuXG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICBwcmV2aW91c1BpZCA9IGRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3AsIHRoZW4gd2FpdCBmb3IgdGhlIG9sZCBkYWVtb24gdG8gYWN0dWFsbHkgZ28gYXdheSDigJQgaXQgdW5saW5rcyBpdHNcbiAgLy8gcG9ydC9waWQgZmlsZXMgb24gc2h1dGRvd24sIHNvIGVuc3VyZURhZW1vbiBzcGF3bnMgZnJlc2ggcmF0aGVyIHRoYW5cbiAgLy8gcmUtZGlzY292ZXJpbmcgdGhlIGR5aW5nIG9uZS5cbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGkocG9ydCwgXCJERUxFVEVcIiwgXCIvXCIpO1xuICB9IGNhdGNoIHt9XG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIGlmICgoYXdhaXQgcmVhZERhZW1vblBvcnQoKSkgPT09IG51bGwpIGJyZWFrO1xuICB9XG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCByZXN0YXJ0ZWQ6IHRydWUsIHBvcnQ6IGZyZXNoLCBwcmV2aW91c19waWQ6IHByZXZpb3VzUGlkIH0pO1xufVxuXG4vLyBiMyDigJQgVEhFIFZFUlNJT04gVkVSSUZZLCBBUyBPTkUgU09VUkNFIEZPUiBCT1RIIFBBVEhTLlxuLy9cbi8vIGByb2xsYCBpcyBkb2N1bWVudGVkIGFzIFwidGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwIOKApiArIHZlcnNpb24gdmVyaWZ5XCIsIGFuZFxuLy8gdGhlIHZlcmlmeSBoYWQgdHdvIHdheXMgdG8gc2F5IG5vdGhpbmc6XG4vL1xuLy8gICBDT0xEIFBBVEgg4oCUIG5vIGRhZW1vbiBydW5uaW5nOiBpdCBzcGF3bmVkIG9uZSBhbmQgcHJpbnRlZCBuZWl0aGVyIGB2ZXJzaW9uYFxuLy8gICBub3IgYHZlcnNpb25fb2tgLiBUaGUgZmllbGRzIHdlcmUgQUJTRU5ULCBzbyBhIGNhbGxlciBjaGVja2luZyB0aGUgdmVyaWZ5XG4vLyAgIGdvdCBgdW5kZWZpbmVkYCBvbiB0aGUgZXhhY3QgcGF0aCB3aGVyZSB0aGUgdmVyaWZ5IG5ldmVyIGhhcHBlbmVkLlxuLy9cbi8vICAgV0FSTSBQQVRIIOKAlCB0aGUgcHJvYmUgd2FzIHdyYXBwZWQgaW4gYGNhdGNoIHt9YCwgbGVhdmluZyBgdmVyc2lvbiA9IG51bGxgLFxuLy8gICBhbmQgYHZlcnNpb25fb2s6IG51bGwgPT09IFBMVUdJTl9WRVJTSU9OYCBldmFsdWF0ZXMgdG8gRkFMU0UuIFwiSSBjb3VsZCBub3Rcbi8vICAgY2hlY2tcIiB3YXMgcmVwb3J0ZWQgYXMgXCJ0aGUgdmVyc2lvbiBpcyBXUk9OR1wiIOKAlCBhIGJvb2xlYW4gdGhhdCBjYW5ub3Qgc2F5XG4vLyAgIFwidW5rbm93blwiIGlzIHRoZSBjYW5vbmljYWwgc2hhcGUgb2YgdGhpcyBzcHJpbnQncyBkZWZlY3QsIGFuZCBmYWxzZSBpcyB0aGVcbi8vICAgd29yc3QgYXZhaWxhYmxlIGFuc3dlciBiZWNhdXNlIGl0IGlzIGFjdGlvbmFibGUgYW5kIGluY29ycmVjdC5cbi8vXG4vLyBTbyBgdmVyc2lvbl9va2AgaXMgbm93IGBib29sZWFuIHwgbnVsbGA6IG51bGwgbWVhbnMgVU5DSEVDS0VELCBuZXZlciBmYWxzZS5cbi8vIGB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb25gIGlzIHByZXNlbnQtYW5kLW51bGwgYmVzaWRlIGl0LCBiZWNhdXNlIGEgYmFyZSBudWxsXG4vLyB0ZWxscyBhIGNhbGxlciB0aGUgY2hlY2sgZGlkIG5vdCBoYXBwZW4gYW5kIG5vdCB3aHkuXG4vL1xuLy8gT25lIGhlbHBlciByYXRoZXIgdGhhbiB0d28gY2FsbCBzaXRlczogYSBzZWNvbmQgY29weSBvZiB0aGlzIGxvZ2ljIG9uIHRoZSBjb2xkXG4vLyBwYXRoIGlzIHRoZSBtaXJyb3ItZHJpZnQgdHJhcCwgYW5kIHRoZSBjb2xkIHBhdGggaXMgcHJlY2lzZWx5IHRoZSBvbmUgbm9ib2R5XG4vLyByZS1yZWFkcy5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZVZlcnNpb24ocG9ydDogbnVtYmVyKTogUHJvbWlzZTx7XG4gIHZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHZlcnNpb25fb2s6IGJvb2xlYW4gfCBudWxsO1xuICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IHN0cmluZyB8IG51bGw7XG59PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdiA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmICh2ID09PSBudWxsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgICB2ZXJzaW9uX29rOiBudWxsLFxuICAgICAgICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IFwidGhlIGRhZW1vbiBhbnN3ZXJlZCBidXQgcmVwb3J0ZWQgbm8gdmVyc2lvblwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogdiwgdmVyc2lvbl9vazogdiA9PT0gUExVR0lOX1ZFUlNJT04sIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogbnVsbCB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHZlcnNpb246IG51bGwsXG4gICAgICB2ZXJzaW9uX29rOiBudWxsLFxuICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBgY291bGQgbm90IHJlYWNoIHRoZSBkYWVtb24gdG8gdmVyaWZ5OiAke1xuICAgICAgICBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSlcbiAgICAgIH1gLFxuICAgIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUm9sbChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICAvLyBDT0xEIFBBVEgg4oCUIG5vdGhpbmcgd2FzIHJ1bm5pbmcsIHNvIHRoaXMgaXMgYSBzdGFydCByYXRoZXIgdGhhbiBhIHJvbGwuXG4gICAgLy8gSXQgc3RpbGwgcmVwb3J0cyB0aGUgdmVyaWZ5LCBiZWNhdXNlIFwibm8gZGFlbW9uIHdhcyB1cFwiIGlzIG5vdCBhIHJlYXNvbiB0b1xuICAgIC8vIHN0YXkgc2lsZW50IGFib3V0IHdoaWNoIHZlcnNpb24gaXMgbm93IHNlcnZpbmcuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oe1xuICAgICAgb2s6IHRydWUsXG4gICAgICByb2xsZWQ6IHRydWUsXG4gICAgICBwcmV2aW91c19waWQ6IG51bGwsXG4gICAgICBwb3J0OiBmcmVzaCxcbiAgICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyB0b3RhbCwgY2hhbm5lbHMgfSA9IGF3YWl0IGZldGNoQWN0aXZlU3Vic2NyaWJlcnMocG9ydCk7XG4gIGlmICh0b3RhbCA+IDAgJiYgIW9wdHMuZm9yY2UpIHtcbiAgICBjb25zdCB3aGVyZSA9IGNoYW5uZWxzLm1hcCgoYykgPT4gYCR7Yy5uYW1lfSAoJHtjLmNvbm5lY3Rpb25zfSlgKS5qb2luKFwiLCBcIik7XG4gICAgZGllKFxuICAgICAgYHJvbGw6ICR7dG90YWx9IGFjdGl2ZSBzdWJzY3JpYmVyKHMpIOKAlCAke3doZXJlfS4gVGhleSdsbCBhdXRvLXJlY29ubmVjdCBhY3Jvc3MgdGhlIHJvbGwuIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gcHJvY2VlZC5gLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgbGV0IHByZXZpb3VzUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBwcmV2aW91c1BpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RvcCB3aXRoIGEgc2hvcnQgaG9sZCBzbyBhIHN0YWxlIENMSSBjYW4ndCB3aW4gdGhlIHJlc3Bhd24gcmFjZTsgd2UgaG9sZCB0aGUgc3Bhd24gb3Vyc2VsdmVzLlxuICBjb25zdCBob2xkTXMgPSA0MDAwO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoSE9MRF9GSUxFLCBTdHJpbmcoRGF0ZS5ub3coKSArIGhvbGRNcykpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICByZWxlYXNlSG9sZCgpOyAvLyBvdXIgdHVybiB0byBzcGF3biB0aGUgbmV3IHZlcnNpb25cbiAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgbGV0IHBpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4oZnJlc2gsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICByb2xsZWQ6IHRydWUsXG4gICAgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCxcbiAgICBwaWQsXG4gICAgcG9ydDogZnJlc2gsXG4gICAgLi4uKGF3YWl0IHByb2JlVmVyc2lvbihmcmVzaCkpLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2F0Y2gobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIC8vIENoYW5uZWwgbmFtZSBpcyBvcHRpb25hbCDigJQgdGhlIHBhZ2UgcmVhZHMgaXQgZnJvbSB0aGUgVVJMIGhhc2ggYW5kXG4gIC8vIGRlZmF1bHRzIHRvIFwibG9iYnlcIiBpZiBhYnNlbnQuIFdlIHBhc3MgdGhyb3VnaCB3aGF0ZXZlciB0aGUgdXNlciBnYXZlXG4gIC8vIChvciBcImxvYmJ5XCIpIGFuZCBvcGVuIHRoZSBicm93c2VyLiBEYWVtb24gaXMgZW5zdXJlZCBzbyB0aGUgc2VydmVkXG4gIC8vIC93YXRjaCBIVE1MIGlzIHJlYWNoYWJsZS5cbiAgY29uc3QgY2hhbm5lbCA9IG5hbWU/LnRyaW0oKSA/IG5hbWUudHJpbSgpIDogXCJsb2JieVwiO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEVuc3VyZSB0aGUgY2hhbm5lbCBleGlzdHMgc28gdGhlIHBhZ2Ugc2VlcyBhIHZhbGlkIGJhY2tsb2cvdG9waWMuXG4gIGF3YWl0IGFwaShwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lOiBjaGFubmVsIH0pO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3dhdGNoIyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNoYW5uZWwpfWA7XG4gIC8vIE9wZW4gdGhlIGJyb3dzZXIgdmlhIHRoZSBwbGF0Zm9ybSdzIGRlZmF1bHQgb3BlbmVyLiBCZXN0LWVmZm9ydCDigJRcbiAgLy8gcHJpbnQgdGhlIFVSTCBzbyB0aGUgdXNlciBjYW4gY2xpY2sgaXQgaWYgYXV0by1vcGVuIGZhaWxzLlxuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwiZXhwbG9yZXJcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gc3Bhd24ob3BlbmVyLCBbdXJsXSwge1xuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICBzdGRpbzogXCJpZ25vcmVcIixcbiAgICB9KTtcbiAgICBwLnVucmVmKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG9wZW5lciBtaXNzaW5nIOKAlCBqdXN0IHByaW50ICovXG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWwsIHVybCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kRG9jdG9yKCkge1xuICAvLyBSZWFkLW9ubHkgZGlhZ25vc3RpYy4gUmVwb3J0cyB0aGUgYXV0aG9yaXRhdGl2ZSBkYWVtb24gKGlmIGFueSksIG90aGVyXG4gIC8vIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzc2VzIHZpc2libGUgb24gdGhlIG1hY2hpbmUsIGNoYW5uZWwgZmlsZXMgb25cbiAgLy8gZGlzaywgYW5kIHN1cmZhY2VzIGhpbnRzLiBEb2VzIE5PVCB0YWtlIGRlc3RydWN0aXZlIGFjdGlvbiDigJQgY2xlYW51cFxuICAvLyBpcyB0aGUgb3BlcmF0b3IncyBjYWxsLCB3aXRoIHN0b2NrIHVuaXggdG9vbHMuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBsZXQgYXV0aG9yaXRhdGl2ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsID0gbnVsbDtcbiAgLy8gUGVyLWNoYW5uZWwgc3Vic2NyaWJlciBzdW1tYXJ5IOKAlCBhbnN3ZXJzIFwiaXMgaXQgc2FmZSB0byByZXN0YXJ0IHRoZVxuICAvLyBkYWVtb24gcmlnaHQgbm93P1wiIHdpdGhvdXQgbmVlZGluZyB0byBhbHNvIHJ1biBgbGlzdGAgYW5kIHJlYWQgdGhlXG4gIC8vIG91dHB1dC4gRW1wdHkgaWYgbm8gZGFlbW9uIGlzIHJ1bm5pbmcuXG4gIGxldCB0b3RhbFN1YnNjcmliZXJzID0gMDtcbiAgY29uc3QgYnVzeUNoYW5uZWxzOiBBcnJheTx7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gICAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgICBuYW1lZDogbnVtYmVyO1xuICAgIGFub255bW91czogbnVtYmVyO1xuICB9PiA9IFtdO1xuICBpZiAocG9ydCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpO1xuICAgICAgYXV0aG9yaXRhdGl2ZSA9IHsgcG9ydCwgLi4uZGF0YSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gZGFlbW9uIHdlbnQgYXdheSBiZXR3ZWVuIHBvcnQgY2hlY2sgYW5kIGFwaSBjYWxsXG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAvLyAvcHJlc2VuY2UgZ2l2ZXMgdGhlIGhvbmVzdCBwZXItY2hhbm5lbCBicmVha2Rvd24gKGNvbm5lY3Rpb25zIHZzIG5hbWVkXG4gICAgICAvLyB2cyBhbm9ueW1vdXMpIOKAlCBzbyB0aGUgcmVzdGFydC1zYWZldHkgdG90YWwgaXNuJ3QgYSBteXN0ZXJ5IGFuZCBhblxuICAgICAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiByZWFkcyBhcyBhIHdhdGNoZXIsIG5vdCBhIGdob3N0LlxuICAgICAgY29uc3QgeyBkYXRhOiBwcmVzRGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICAgICAgZm9yIChjb25zdCBjaCBvZiBwcmVzRGF0YT8uY2hhbm5lbHMgPz8gW10pIHtcbiAgICAgICAgdG90YWxTdWJzY3JpYmVycyArPSBjaC5jb25uZWN0aW9ucztcbiAgICAgICAgYnVzeUNoYW5uZWxzLnB1c2goe1xuICAgICAgICAgIG5hbWU6IGNoLm5hbWUsXG4gICAgICAgICAgc3Vic2NyaWJlcnM6IGNoLmNvbm5lY3Rpb25zLCAvLyBiYWNrLWNvbXBhdDogcHJldmlvdXNseSB0aGUgcmF3IGNvdW50XG4gICAgICAgICAgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zLFxuICAgICAgICAgIG5hbWVkOiBjaC5uYW1lZCxcbiAgICAgICAgICBhbm9ueW1vdXM6IGNoLmFub255bW91cyxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBiZXN0LWVmZm9ydFxuICAgIH1cbiAgfVxuXG4gIC8vIEVudW1lcmF0ZSBvdGhlciBkYWVtb24gcHJvY2Vzc2VzIHZpYSB0aGUgc2hhcmVkIGNsYXNzaWZpZXIuIEVhY2ggZW50cnlcbiAgLy8gZ2FpbnMgcG9ydC9ob21lL3ZlcnNpb24vc3RhdHVzL3JlYXBhYmxlIHNvIHRoZSBvcGVyYXRvciBoYXMgdGhlIGZ1bGxcbiAgLy8gcGljdHVyZSB3aXRob3V0IG5lZWRpbmcgYSBzZXBhcmF0ZSBgcmVhcCAtLWRyeS1ydW5gLlxuICBjb25zdCBvdGhlckRhZW1vbnM6IEFycmF5PEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlEYWVtb24+PiAmIHsgY29tbWFuZD86IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBzZWxmUGlkID0gYXV0aG9yaXRhdGl2ZT8ucGlkIGFzIG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IHBpZCBvZiBhd2FpdCBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpKSB7XG4gICAgICBpZiAoc2VsZlBpZCAmJiBwaWQgPT09IHNlbGZQaWQpIGNvbnRpbnVlO1xuICAgICAgb3RoZXJEYWVtb25zLnB1c2goYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwcyB1bmF2YWlsYWJsZTsgY2Fycnkgb24gd2l0aCBlbXB0eSBsaXN0XG4gIH1cblxuICAvLyBDaGFubmVscyBvbiBkaXNrIHVuZGVyIHRoaXMgSE9NRS5cbiAgY29uc3QgY2hhbm5lbHNPbkRpc2s6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgY2hhbm5lbHNEaXIgPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKGNoYW5uZWxzRGlyKSkge1xuICAgICAgZm9yIChjb25zdCBmIG9mIHJlYWRkaXJTeW5jKGNoYW5uZWxzRGlyKSkge1xuICAgICAgICBpZiAoZi5lbmRzV2l0aChcIi5qc29ubFwiKSkgY2hhbm5lbHNPbkRpc2sucHVzaChmLnJlcGxhY2UoL1xcLmpzb25sJC8sIFwiXCIpKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge31cblxuICAvLyBIaW50cyDigJQgc3VyZmFjZSB0aGUgbW9zdCBhY3Rpb25hYmxlIHNpZ25hbHMuXG4gIGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoIWF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgXCJObyBhdXRob3JpdGF0aXZlIGRhZW1vbiBydW5uaW5nIGZvciB0aGlzIEhPTUUuIFJ1biBhbnkgdmVyYiAoZS5nLiBgY2xpLnRzIGxpc3RgKSB0byBzcGF3biBvbmUuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAob3RoZXJEYWVtb25zLmxlbmd0aCA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYEZvdW5kICR7b3RoZXJEYWVtb25zLmxlbmd0aH0gb3RoZXIgZ3JhcGV2aW5lIGRhZW1vbiBwcm9jZXNzKGVzKSBvbiB0aGlzIG1hY2hpbmUuIGAgK1xuICAgICAgICBcIlRoZXkgbWF5IGJlIHpvbWJpZXMgZnJvbSBwYXN0IHJ1bnMgT1IgZGFlbW9ucyBzZXJ2aW5nIG90aGVyIEhPTUVzIChkaWZmZXJlbnQgR1JBUEVWSU5FX0hPTUUpLlwiLFxuICAgICk7XG4gICAgY29uc3QgcmVhcGFibGVDb3VudCA9IG90aGVyRGFlbW9ucy5maWx0ZXIoKGQpID0+IGQucmVhcGFibGUpLmxlbmd0aDtcbiAgICBpZiAocmVhcGFibGVDb3VudCA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGBGb3VuZCAke3JlYXBhYmxlQ291bnR9IHJlYXBhYmxlIG9ycGhhbiBkYWVtb24ocykuIFJ1biBcXGBncmFwZXZpbmUgcmVhcFxcYCB0byBjbGVhciB0aGVtIHNhZmVseS5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG90aGVyRGFlbW9ucy5zb21lKChkKSA9PiBkLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIikpIHtcbiAgICAgIGhpbnRzLnB1c2goXCJTb21lIGRhZW1vbnMgYXJlIHVucmVzcG9uc2l2ZTsgYGdyYXBldmluZSByZWFwIC0tZm9yY2VgIGluY2x1ZGVzIHRoZW0uXCIpO1xuICAgIH1cbiAgfVxuICBpZiAoXG4gICAgYXV0aG9yaXRhdGl2ZSAmJlxuICAgIFBMVUdJTl9WRVJTSU9OICYmXG4gICAgdHlwZW9mIGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIGF1dGhvcml0YXRpdmUudmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT05cbiAgKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBBdXRob3JpdGF0aXZlIGRhZW1vbiB2ZXJzaW9uICgke2F1dGhvcml0YXRpdmUudmVyc2lvbn0pIGRpZmZlcnMgZnJvbSB0aGlzIENMSSdzIHZlcnNpb24gKCR7UExVR0lOX1ZFUlNJT059KS4gYCArXG4gICAgICAgIFwiUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduIOKAlCBkcm9wIGFjdGl2ZSB0YWlscywgdGhlbiBgc3RvcGAsIHRoZW4gYW55IHZlcmIuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoYXV0aG9yaXRhdGl2ZSAmJiAoYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSBudWxsIHx8IGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gdW5kZWZpbmVkKSkge1xuICAgIGhpbnRzLnB1c2goXCJBdXRob3JpdGF0aXZlIGRhZW1vbiBwcmVkYXRlcyB2ZXJzaW9uIHJlcG9ydGluZyAocHJlLVYxLjYuMikuIFJlc3RhcnQgdG8gYWxpZ24uXCIpO1xuICB9XG4gIGlmICh0b3RhbFN1YnNjcmliZXJzID4gMCkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgJHt0b3RhbFN1YnNjcmliZXJzfSBhY3RpdmUgc3Vic2NyaWJlcihzKSBhY3Jvc3MgJHtidXN5Q2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpLiBgICtcbiAgICAgICAgXCJEYWVtb24gcmVzdGFydCB3b3VsZCBmb3JjZSB0aGVtIHRvIGF1dG8tcmVjb25uZWN0ICh3b3JrcywgYnV0IGRpc3J1cHRpdmUpIOKAlCBjb29yZGluYXRlIGZpcnN0LlwiLFxuICAgICk7XG4gIH0gZWxzZSBpZiAoYXV0aG9yaXRhdGl2ZSkge1xuICAgIGhpbnRzLnB1c2goXCJObyBhY3RpdmUgc3Vic2NyaWJlcnMg4oCUIGRhZW1vbiByZXN0YXJ0IGlzIG5vbi1kaXNydXB0aXZlLlwiKTtcbiAgfVxuICAvLyBFeHBsYWluIGFueSBjaGFubmVsIHdoZXJlIHRoZSBjb25uZWN0aW9uIGNvdW50IGV4Y2VlZHMgbmFtZWQgYWdlbnRzIOKAlCBhblxuICAvLyBhbm9ueW1vdXMgd2F0Y2ggdGFiIGluZmxhdGVzIGBjb3VudGAvYGNvbm5lY3Rpb25zYCBidXQgaXNuJ3QgYSBnaG9zdC5cbiAgZm9yIChjb25zdCBjaCBvZiBidXN5Q2hhbm5lbHMpIHtcbiAgICBpZiAoY2guYW5vbnltb3VzID4gMCkge1xuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7Y2gubmFtZX06ICR7Y2guY29ubmVjdGlvbnN9IGNvbm5lY3Rpb24ocyksICR7Y2gubmFtZWR9IG5hbWVkIGFnZW50KHMpICsgYCArXG4gICAgICAgICAgYCR7Y2guYW5vbnltb3VzfSBhbm9ueW1vdXMgKGUuZy4gYSB3YXRjaCB0YWIpLiBUaGUgY291bnQgb3ZlciB0aGUgbmFtZSBsaXN0IGlzIGV4cGVjdGVkLCBub3QgYSBnaG9zdC5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIGhvbWU6IERBVEFfRElSLFxuICAgIGNsaV92ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTixcbiAgICBhdXRob3JpdGF0aXZlLFxuICAgIGFjdGl2ZV9zdWJzY3JpYmVyczoge1xuICAgICAgdG90YWw6IHRvdGFsU3Vic2NyaWJlcnMsXG4gICAgICBidXN5X2NoYW5uZWxzOiBidXN5Q2hhbm5lbHMsXG4gICAgfSxcbiAgICBvdGhlcl9kYWVtb25zX29uX21hY2hpbmU6IG90aGVyRGFlbW9ucyxcbiAgICBjaGFubmVsc19vbl9kaXNrOiBjaGFubmVsc09uRGlzayxcbiAgICBoaW50cyxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEluZm8oKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8g4pSA4pSAIERhZW1vbiBlbnVtZXJhdGlvbiArIGNsYXNzaWZpZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKiBBbGwgZ3JhcGV2aW5lIGRhZW1vbi50cyBwaWRzIHZpc2libGUgb24gdGhpcyBtYWNoaW5lICh2aWEgYHBzYCkuICovXG5hc3luYyBmdW5jdGlvbiBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpOiBQcm9taXNlPG51bWJlcltdPiB7XG4gIGNvbnN0IHBpZHM6IG51bWJlcltdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgcHJvYyA9IHNwYXduKFwicHNcIiwgW1wiLWVvXCIsIFwicGlkLGNvbW1hbmRcIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByZXNvbHZlKCkpKTtcbiAgICBjb25zdCBvdXQgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygb3V0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBpZiAoIWxpbmUuaW5jbHVkZXMoXCJkYWVtb24udHNcIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFsaW5lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJncmFwZXZpbmVcIikpIGNvbnRpbnVlO1xuICAgICAgLy8gVGhlIHBpZCBncm91cCBpcyBtYW5kYXRvcnk7IGFuIHVubWF0Y2hlZCBsaW5lIGlzIHNraXBwZWQsIGFzIGJlZm9yZS5cbiAgICAgIGNvbnN0IGRpZ2l0cyA9IGxpbmUubWF0Y2goL15cXHMqKFxcZCspXFxzKy8pPy5bMV07XG4gICAgICBpZiAoZGlnaXRzID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcGlkID0gcGFyc2VJbnQoZGlnaXRzLCAxMCk7XG4gICAgICBpZiAocGlkKSBwaWRzLnB1c2gocGlkKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIHBzIHVuYXZhaWxhYmxlOyByZXR1cm4gZW1wdHlcbiAgfVxuICByZXR1cm4gcGlkcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gbHNvZkxpc3RlblBvcnQocGlkOiBudW1iZXIpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9jID0gc3Bhd24oXCJsc29mXCIsIFtcIi1haVRDUFwiLCBcIi1zVENQOkxJU1RFTlwiLCBcIi1wXCIsIFN0cmluZyhwaWQpLCBcIi1QXCIsIFwiLW5cIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByKCkpKTtcbiAgICAvLyBUaGUgcG9ydCBncm91cCBpcyBtYW5kYXRvcnk7IG5vIG1hdGNoIGlzIHRoaXMgZnVuY3Rpb24ncyBvd24gYG51bGxgLlxuICAgIGNvbnN0IGRpZ2l0cyA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKVxuICAgICAgLnRvU3RyaW5nKFwidXRmLThcIilcbiAgICAgIC5tYXRjaCgvMTI3XFwuMFxcLjBcXC4xOihcXGQrKS8pPy5bMV07XG4gICAgcmV0dXJuIGRpZ2l0cyA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IHBhcnNlSW50KGRpZ2l0cywgMTApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgdHlwZSBEYWVtb25TdGF0dXMgPSBcImF1dGhvcml0YXRpdmVcIiB8IFwib3JwaGFuXCIgfCBcInVucmVzcG9uc2l2ZVwiIHwgXCJ1bmtub3duXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGFzc2lmeURhZW1vbihwaWQ6IG51bWJlcik6IFByb21pc2U8e1xuICBwaWQ6IG51bWJlcjtcbiAgcG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgaG9tZT86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogRGFlbW9uU3RhdHVzO1xuICByZWFwYWJsZTogYm9vbGVhbjtcbn0+IHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGxzb2ZMaXN0ZW5Qb3J0KHBpZCk7XG4gIGlmICghcG9ydCkgcmV0dXJuIHsgcGlkLCBwb3J0OiBudWxsLCBzdGF0dXM6IFwidW5rbm93blwiLCByZWFwYWJsZTogZmFsc2UgfTtcbiAgbGV0IGluZm86IFJvb3RJbmZvIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoODAwKSxcbiAgICB9KTtcbiAgICBpZiAocmVzLm9rKSBpbmZvID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJvb3RJbmZvO1xuICB9IGNhdGNoIHt9XG4gIGlmICghaW5mbykgcmV0dXJuIHsgcGlkLCBwb3J0LCBzdGF0dXM6IFwidW5yZXNwb25zaXZlXCIsIHJlYXBhYmxlOiBmYWxzZSB9OyAvLyByZWFwIG9ubHkgd2l0aCAtLWZvcmNlIChoYW5kbGVkIGluIGNtZFJlYXApXG4gIGNvbnN0IGhvbWUgPSBpbmZvLmRhdGFfZGlyIGFzIHN0cmluZztcbiAgbGV0IG93bnMgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBvcCA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBvcnRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIGNvbnN0IG9pID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucGlkXCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBvd25zID0gb3AgPT09IFN0cmluZyhwb3J0KSAmJiBvaSA9PT0gU3RyaW5nKHBpZCk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG93bnNcbiAgICA/IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcImF1dGhvcml0YXRpdmVcIixcbiAgICAgICAgcmVhcGFibGU6IGZhbHNlLFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwib3JwaGFuXCIsXG4gICAgICAgIHJlYXBhYmxlOiB0cnVlLFxuICAgICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhcChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbjsgZHJ5UnVuPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHNlbGZQb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTsgLy8gY3VycmVudCBIT01FIGF1dGhvcml0YXRpdmUgKG5ldmVyIHJlYXApXG4gIGxldCBzZWxmUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgaWYgKHNlbGZQb3J0KSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGZQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihzZWxmUG9ydCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcGlkcyA9IGF3YWl0IGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCk7XG4gIGNvbnN0IGtlcHQ6IHVua25vd25bXSA9IFtdLFxuICAgIHJlYXBlZDogdW5rbm93bltdID0gW10sXG4gICAgc2tpcHBlZDogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgcGlkIG9mIHBpZHMpIHtcbiAgICBjb25zdCBjID0gYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKTtcbiAgICBjb25zdCBpc1NlbGYgPSBwaWQgPT09IHNlbGZQaWQ7XG4gICAgY29uc3Qgc2hvdWxkUmVhcCA9XG4gICAgICAhaXNTZWxmICYmIChjLnJlYXBhYmxlIHx8IChjLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIiAmJiBvcHRzLmZvcmNlID09PSB0cnVlKSk7XG4gICAgaWYgKCFzaG91bGRSZWFwKSB7XG4gICAgICBrZXB0LnB1c2goYyk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG9wdHMuZHJ5UnVuKSB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImRyeS1ydW5cIiB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5raWxsKHBpZCwgXCJTSUdURVJNXCIpO1xuICAgICAgcmVhcGVkLnB1c2goYyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImtpbGwgZmFpbGVkXCIgfSk7XG4gICAgfVxuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkcnlfcnVuOiAhIW9wdHMuZHJ5UnVuLCBrZXB0LCByZWFwZWQsIHNraXBwZWQgfSk7XG59XG5cbi8vIChCT09MRUFOX0ZMQUdTIHdhcyBoZXJlLiBJdCBsaXN0ZWQgd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZSDigJQgaGFsZiBhXG4vLyByZWdpc3RyeSwgY29uc3VsdGVkIGJ5IHRoZSBoYW5kLXJvbGxlZCBwYXJzZXIuIEl0cyAxMyBlbnRyaWVzIG5vdyBsaXZlIGluXG4vLyBDTElfT1BUSU9OUyBiZWxvdyBhcyBge3R5cGU6XCJib29sZWFuXCJ9YCwgdmVyaWZpZWQgMTMtZm9yLTEzIGFnYWluc3QgdGhvdGgnc1xuLy8gaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0IGJlZm9yZSB0aGUgbW92ZS4gRGVsZXRlZCByYXRoZXIgdGhhbiBsZWZ0XG4vLyBiZXNpZGUgaXRzIHJlcGxhY2VtZW50OiBhIHNlY29uZCBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSBzYW1lIGZhY3QgaXMgdGhlXG4vLyBkcmlmdCBidWcgdGhpcyBsYW5lIGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCB3b3VsZCBubyBsb25nZXIgYmUgY29uc3VsdGVkXG4vLyBieSBhbnl0aGluZy4pXG5cbi8vIFNpZ25hdHVyZSBvZiBhIGhlcmVkb2MgZnVtYmxlOiBhIGxpbmUgdGhhdCBpcyAob3IgYmVnaW5zIHdpdGgpIGFcbi8vIGBidW4g4oCmIGNsaS50cyDigKYgc2VuZGAgaW52b2NhdGlvbi4gV2hlbiBhIGBzZW5kIC0tc3RkaW4gPDxFT0ZgIGlzIGJvdGNoZWQsIHRoZVxuLy8gc2hlbGwgcGlwZXMgdGhlIGxpdGVyYWwgY29tbWFuZCBsaW5lIGluIGFzIHRoZSBib2R5LCB3aGljaCB0aGVuIGdldHMgcG9zdGVkIOKAlFxuLy8gY29ycnVwdGluZyB0aGUgY2hhbm5lbCB3aXRoIGBidW4gL+KApi9jbGkudHMgc2VuZCA8Y2hhbm5lbD4gLS1hcyDigKYgPHRleHQ+YC5cbi8vIFdlIHJlZnVzZSB0byBwb3N0IHN1Y2ggYSBib2R5IHVubGVzcyAtLWZvcmNlIGlzIHBhc3NlZC5cbmNvbnN0IExFQUtFRF9TRU5EX1JFID0gLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxiKD86c2VuZHxhbm5vdW5jZSlcXGIvO1xuZnVuY3Rpb24gbG9va3NMaWtlTGVha2VkU2VuZCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIExFQUtFRF9TRU5EX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vIFNoZWxsLW1ldGFjaGFyYWN0ZXIgZm9vdGd1biAoIzYwKTogYSBib2R5IHBhc3NlZCBhcyBhbiBJTkxJTkUgcG9zaXRpb25hbCBhcmdcbi8vIGlzIGV4cG9zZWQgdG8gdGhlIGNhbGxlcidzIHNoZWxsLCB3aGljaCBjb21tYW5kLXN1YnN0aXR1dGVzIGJhY2t0aWNrcyAvXG4vLyBgJCguLi4pYCAvIGAkey4uLn1gIEJFRk9SRSBncmFwZXZpbmUgc2VlcyBpdCDigJQgY29ycnVwdGluZyBvciBwYXJ0aWFsbHlcbi8vIGV4ZWN1dGluZyBjb2RlLWJlYXJpbmcgbWVzc2FnZXMuIFRoZSBDTEkgY2FuJ3QgdW4tc3Vic3RpdHV0ZSB3aGF0IHRoZSBzaGVsbFxuLy8gYWxyZWFkeSBhdGU7IHRoZSBob25lc3QgZml4IGlzIHRvIHN0ZWVyIGNhbGxlcnMgdG8gdGhlIHNoZWxsLWZyZWUgcGF0aHNcbi8vICgtLWJvZHktZmlsZSAvIC0tc3RkaW4gLyBkZWZhdWx0LXN0ZGluKS4gV2hlbiBtZXRhY2hhcmFjdGVycyBTVVJWSVZFIGludG8gYW5cbi8vIGlubGluZSBib2R5IChlLmcuIHRoZSBjYWxsZXIgaGFwcGVuZWQgdG8gc2luZ2xlLXF1b3RlKSwgdGhleSdyZSBpbnRhY3QgdGhpc1xuLy8gdGltZSDigJQgYnV0IHRoZSBwYXR0ZXJuIGlzIGEgbGF0ZW50IGZvb3RndW4sIHNvIHdlIHdhcm4gKG5ldmVyIGJsb2NrOiB0aGVcbi8vIG1lc3NhZ2UgaXMgZmluZSBhcyByZWNlaXZlZCkuIEFic2VudC1tZXRhY2hhciBpbmxpbmUgYm9kaWVzIGFyZSBlaXRoZXIgcGxhaW5cbi8vIHRleHQgKHNhZmUpIG9yIGFscmVhZHktc3Vic3RpdHV0ZWQgKHVuZGV0ZWN0YWJsZSkg4oCUIHNvIHdlIG9ubHkgd2FybiBvbiB0aGVcbi8vIGRldGVjdGFibGUgcmlza3kgcGF0dGVybi5cbmNvbnN0IFNIRUxMX01FVEFDSEFSX1JFID0gL2B8XFwkXFwofFxcJFxcey87XG5leHBvcnQgZnVuY3Rpb24gbG9va3NTaGVsbFJpc2t5KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gU0hFTExfTUVUQUNIQVJfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIGdyYXBldmluZSBhbHJlYWR5IGhhZCBIQUxGIGEgcmVnaXN0cnk6IGBCT09MRUFOX0ZMQUdTYCBhYm92ZSB0b2xkIHRoZSBwYXJzZXJcbi8vIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUuIFdoYXQgaXQgaGFkIG5vIG5vdGlvbiBvZiB3YXMgd2hpY2ggZmxhZ3MgRVhJU1QsIHNvXG4vLyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2Vcbi8vIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXMgc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC5cbi8vXG4vLyDimqAgZ3JhcGV2aW5lIGlzIHRoZSBPVVRMSUVSIG9mIHRoZSBzaXgsIGFuZCBpdCBpcyB3b3J0aCBzYXlpbmcgd2h5IHNvIG5vYm9keVxuLy8gcmVhZHMgaXQgYXMgbWVyZWx5IGJlaGluZDogaXQgdHlwZXMgaXRzIHZhbHVlIGZsYWdzIHdpdGggYSBDQVNUXG4vLyAoYGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZGApIHdoZXJlIHRoZSBvdGhlciBlbnRyeSBwb2ludHMgdXNlIGFcbi8vIGB0eXBlb2ZgIGd1YXJkLiBBIGNhc3QgaXMgYSBjbGFpbSB3aXRoIE5PIFJVTlRJTUUgQ0hFQ0ssIHNvIGdyYXBldmluZSBjYXJyaWVkXG4vLyBhIGNsYXNzIG9mIGxhdGVudCB0eXBlLWxpZSB0aGUgb3RoZXJzIHdlcmUgZ3VhcmRlZCBhZ2FpbnN0IOKAlCBhbmQgYmFyZSB2YWx1ZVxuLy8gZmxhZ3MgcHJvZHVjZWQgc2lsZW50IHdyb25nIHZhbHVlcyByYXRoZXIgdGhhbiBlcnJvcnM6XG4vL1xuLy8gICAtLWxhc3QgICBiYXJlICAtPiAgcGFyc2VJbnQodHJ1ZSwgMTApICAtPiAgTmFOLCBzaWxlbnRseVxuLy8gICAtLXRvcGljICBiYXJlICAtPiAgYHRydWVgIGluIGEgZmllbGQgREVDTEFSRUQgYHN0cmluZ2Bcbi8vXG4vLyBgc3RyaWN0OiB0cnVlYCB0dXJucyBlYWNoIG9mIHRob3NlIGZyb20gYSBzaWxlbnQgd3JvbmcgdmFsdWUgaW50byBhXG4vLyBjYWxsZXItZmFjaW5nIGVycm9yLCB3aGljaCBpcyB0aGUgbGFuZSdzIHdob2xlIHB1cnBvc2UgYW5kIHRoZSBsYXJnZXN0XG4vLyBiZWhhdmlvdXIgZGVsdGEgb2YgdGhlIHNpeCBlbnRyeSBwb2ludHMuXG4vL1xuLy8gVGhlIGJvb2xlYW4gc2V0IGJlbG93IGlzIEJPT0xFQU5fRkxBR1MsIHVuY2hhbmdlZCDigJQgZXh0cmFjdGVkIGZyb20gdGhpcyBmaWxlXG4vLyBhbmQgZGlmZmVkIGFnYWluc3QgdGhvdGgncyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3Q6IDEzIGZvciAxMywgZXhhY3QsXG4vLyB6ZXJvIGRpdmVyZ2VuY2UgaW4gZWl0aGVyIGRpcmVjdGlvbi5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjaGFubmVsczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBob2xkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJpbi1yZXBseS10b1wiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFzdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1heDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0b3BpYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGFsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImRyeS1ydW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmb3JjZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmcmVzaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImZyb20tc3RhcnRcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW1hbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsaXRlcmFsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGx1cms6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVpZXQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGV4dDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB2ZXJib3NlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHllczogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxufSBhcyBjb25zdDtcblxuLyoqXG4gKiBBIHBhcnNlLXN0YWdlIHJlamVjdGlvbiwgY2FycnlpbmcgdGhlIGVudW1lcmF0aW9uIGl0IHdhbnRzIHRvIHB1Ymxpc2guXG4gKlxuICog4puUIFRIRSBgZXh0cmFgIElTIFdIWSBUSElTIENMQVNTIFNVUlZJVkVEIFRIRSBgZXJyb3JzLnRzYCBBRE9QVElPTi4gVGhlXG4gKiByZWplY3Rpb24gaGFzIHRvIE5BTUUgaXRzIHZhbGlkIHNldCDigJQgdGhhdCBpcyB0aGUgd2hvbGUgcmVhc29uIGdyYXBldmluZSdzXG4gKiBwYXJzZXIgZXJyb3JzIHdlcmUgc2hhcGVkIHRoZSB3YXkgdGhleSB3ZXJlIOKAlCBhbmQgdGhlIHRocm93IGhhcHBlbnMgdHdvIGZyYW1lc1xuICogYmVsb3cgdGhlIHBsYWNlIHRoYXQga25vd3MgdGhlIHNldC4gYGNob2ljZXNgIGlzIHdoZXJlIHRoZSBob3VzZSBlbnZlbG9wZVxuICogY2FycmllcyBhbiBlbnVtZXJhdGlvbiwgc28gdGhlIGNsYXNzIGhvbGRzIGl0IHVudGlsIGBydW5Db21tYW5kYCByYWlzZXMuXG4gKi9cbmNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiVXNhZ2VFcnJvclwiO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxufVxuXG50eXBlIEZsYWdOYW1lID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuXG4vLyBJZGVudGl0eSBpcyBjb250cmFjdHVhbGx5IEdMT0JBTDogU0tJTEwubWQgdGVsbHMgYWdlbnRzIHRvIHBhc3MgLS1hcy8tLWZyb21cbi8vIG9uIEVWRVJZIHZlcmIgKGEgZnJlc2ggc2hlbGwgcGVyIGNvbW1hbmQgbWVhbnMgR1JBUEVWSU5FX0ZST00gbmV2ZXJcbi8vIHBlcnNpc3RzKSwgc28gZXZlcnkgY29tbWFuZCBhY2NlcHRzIGJvdGgg4oCUIGV2ZW4gd2hlcmUgYSB2ZXJiIGhhcyBubyB1c2UgZm9yXG4vLyBpZGVudGl0eSwgYSBjYWxsZXIgZm9sbG93aW5nIG91ciBvd24gZG9jcyBtdXN0IG5vdCBiZSByZWplY3RlZCBmb3Igb2JleWluZ1xuLy8gdGhlbS4gT24gYGdyZXBgLCBgLS1mcm9tYCBpcyBhbiBhdXRob3IgRklMVEVSIHJhdGhlciB0aGFuIGlkZW50aXR5OiBkaWZmZXJlbnRcbi8vIHNlbWFudGljcywgc2FtZSBhY2NlcHRhbmNlLlxuY29uc3QgR0xPQkFMX0ZMQUdTOiBGbGFnTmFtZVtdID0gW1wiYXNcIiwgXCJmcm9tXCJdO1xuXG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcblxuLy8gVEhFIENPTU1BTkQgVEFCTEUsIEFTIEEgU1RSVUNUVVJFIOKAlCB0aGUgcGFyc2VyLCB0aGUgZGlzcGF0Y2hlciwgdGhlIHNjaGVtYVxuLy8gZW1pdHRlciBhbmQgdGhlIHJvb3QgcmVqZWN0aW9uIGFsbCB3YWxrIFRISVMuIEl0IHJlcGxhY2VkIGEgYmFyZSBgc3dpdGNoYCxcbi8vIHdoaWNoIG9ubHkgdGhlIGRpc3BhdGNoZXIgY291bGQgd2FsazogYSBzY2hlbWEgZW1pdHRlZCBmcm9tIGFueXRoaW5nIG90aGVyXG4vLyB0aGFuIHRoZSBzdHJ1Y3R1cmUgdGhhdCByb3V0ZXMgdGhlIGJlaGF2aW91ciBpcyBhIGRvY3VtZW50IHRoYXQgbGllcyBhcyBzb29uXG4vLyBhcyBhbnlvbmUgZWRpdHMgdGhlIG90aGVyIHNpZGUgKGFjYyBTVEFOREFSRC5tZCBQYXJ0IDEgwqcyOyBvdXIgb3duICM4MS9ENFxuLy8gbGFuZSBsZWFybmVkIHRoZSBzYW1lIGxlc3NvbiBvbmUgYWx0aXR1ZGUgZG93biB3aXRoIEJPT0xFQU5fRkxBR1MpLlxuLy9cbi8vIGBmbGFnc2AgaXMgdGhlIHZlcmIncyBPV04gYWNjZXB0ZWQgc2V0IChHTE9CQUxfRkxBR1MgYXJlIG1lcmdlZCBpbiBieVxuLy8gYGFjY2VwdGVkRmxhZ3NgKS4gQSBmbGFnIG5vdCBsaXN0ZWQgaGVyZSBpcyBSRUpFQ1RFRCBmb3IgdGhpcyB2ZXJiIHdpdGggdGhlXG4vLyB2ZXJiJ3Mgb3duIHNldCBlbnVtZXJhdGVkIOKAlCBhY2NlcHRlZC1hbmQtaWdub3JlZCBpcyB0aGUgZGlzZWFzZSB0aGlzIHRhYmxlXG4vLyBleGlzdHMgdG8gY3VyZSAoYWNjIERULTE6IGFudGhpbGwgYWNjZXB0aW5nIGEgcm9vdCBgLS1mb3JtYXRgIGl0IHNpbGVudGx5XG4vLyBkaXNjYXJkczsgZ3JhcGV2aW5lIGFjY2VwdGluZyBgc2VuZCAtLWRyeS1ydW5gIGFuZCBkb2luZyBub3RoaW5nIHdhcyB0aGVcbi8vIHNhbWUgZXZlbnQgd2l0aCBhIGRpZmZlcmVudCBzcGVsbGluZykuXG50eXBlIENvbW1hbmRTcGVjID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdOYW1lW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICAvKipcbiAgICog4pqgIE1BWSBSRVRVUk4gQU4gRVhJVCBDT0RFLCBBTkQgRVhBQ1RMWSBPTkUgVkVSQiBET0VTLiBgdGFpbGAgcnVucyB0aGUgc2hhcmVkXG4gICAqIGNsaWVudCAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoaWNoIFJFVFVSTlMgYSBjb2RlIHJhdGhlciB0aGFuXG4gICAqIGVuZGluZyB0aGUgcHJvY2VzcyBmcm9tIGluc2lkZSB0aHJlZSBuZXN0ZWQgbG9vcHMg4oCUIHNvIHRoZSBjb2RlIGhhcyB0byByZWFjaFxuICAgKiBgbWFpbmAsIGFuZCB0aGlzIGlzIHRoZSBzZWFtIGl0IGNyb3NzZXMuIEFueXRoaW5nIHRoYXQgaXMgbm90IGEgbnVtYmVyIG1lYW5zXG4gICAqIDAsIHdoaWNoIGlzIHdoYXQgdGhlIG90aGVyIHR3ZW50eS1vZGQgdmVyYnMgcmV0dXJuLlxuICAgKlxuICAgKiDimqAgVHlwZWQgYHVua25vd25gIHJhdGhlciB0aGFuIGEgdW5pb24gd2l0aCBgdm9pZGA6IGEgdW5pb24gaXMgd2hhdCBhIHJlYWRlclxuICAgKiB3b3VsZCB3cml0ZSBmaXJzdCwgYW5kIGV2ZXJ5IGBhc3luY2AgdmVyYiB0aGF0IGVuZHMgd2l0aG91dCBhIGByZXR1cm5gIGlzXG4gICAqIGBQcm9taXNlPHZvaWQ+YCwgd2hpY2ggaXMgTk9UIGFzc2lnbmFibGUgdG8gYFByb21pc2U8bnVtYmVyIHwgdW5kZWZpbmVkPmAuXG4gICAqIFRoZSB3aWRlbmluZyBoYXBwZW5zIGF0IHRoZSBvbmUgcGxhY2UgdGhhdCByZWFkcyB0aGUgdmFsdWUsIGJlbG93LlxuICAgKi9cbiAgcnVuOiAocG9zaXRpb25hbDogc3RyaW5nW10sIGZsYWdzOiBGbGFncykgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBgdGFpbCAtLXNpbmNlYCB0aHJvdWdoIHRoZSBraXQncyBvbmUgcmVhZGVyIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLFxuICogIGByZWFkU2luY2VgKTogYW4gaWQgb2YgMCBvciBtb3JlOyBhbiBlcG9jaCBib29rbWFyayBwcmludGVkIGJ5IGFub3RoZXJcbiAqICBzcGVsbCdzIGhhbmRvZmYgbGluZSBpcyByZWZ1c2VkIHdpdGggdGhlIGFjY2VwdGVkIGZvcm1zIG5hbWVkLiAqL1xuZnVuY3Rpb24gc2luY2VPckRpZSh0b2tlbjogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgciA9IHJlYWRTaW5jZSh0b2tlbiwgeyBlcG9jaDogZmFsc2UsIG1pbjogMCB9KTtcbiAgaWYgKCFyLm9rKSBkaWUoci5tZXNzYWdlLCBcInVzYWdlXCIpO1xuICByZXR1cm4gci5zaW5jZTtcbn1cblxuLy8gQSBkZWNsYXJlZCB2YWx1ZSBmbGFnIHRoYXQgY2FycmllcyBhIG51bWJlciBtdXN0IFJFSkVDVCBhIG5vbi1udW1iZXIgYXMgYVxuLy8gdXNhZ2UgZXJyb3IgKGV4aXQgMiksIG5vdCBjcmFzaCBvbiBpdCBkb3duc3RyZWFtIOKAlCBgc2NoZW1hYCBwdWJsaXNoZXMgdGhlXG4vLyBmbGFnIGFzIHZhbGlkLCBzbyB0aGUgcGFyc2UgYm91bmRhcnkgaXMgd2hlcmUgYSBiYWQgdmFsdWUgZ2V0cyBpdHNcbi8vIGNhbGxlci1mYWNpbmcgYW5zd2VyLiAoYHdhaXQgLS10aW1lb3V0IG5vdGFudW1iZXJgIHVzZWQgdG8gdGhyb3cgYW5cbi8vIHVuaGFuZGxlZCBSYW5nZUVycm9yIGF0IGV4aXQgMSwgc3RhY2sgdHJhY2UgYW5kIGFsbC4pXG5mdW5jdGlvbiBudW1lcmljRmxhZyh2ZXJiOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmF3OiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8IDApXG4gICAgZGllKGAke3ZlcmJ9OiAtLSR7bmFtZX0gZXhwZWN0cyBhIG5vbi1uZWdhdGl2ZSBudW1iZXIsIGdvdCAke0pTT04uc3RyaW5naWZ5KFN0cmluZyhyYXcpKX1gKTtcbiAgcmV0dXJuIG47XG59XG5cbi8vIEJvZHkgcmVzb2x1dGlvbiBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZSDigJQgZmlyc3QgbWF0Y2ggd2luczogLS1ib2R5LWZpbGUsXG4vLyAtLXN0ZGluLCBpbmxpbmUgcG9zaXRpb25hbHMsIGRlZmF1bHQtc3RkaW4gd2hlbiBwaXBlZC4gU2VlIHRoZSBwZXItdmVyYlxuLy8gY29tbWVudHMgYXQgdGhlIG9yaWdpbmFsIHNpdGVzIChWMS42LyM2MCk7IGJlaGF2aW91ciB1bmNoYW5nZWQuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQm9keShcbiAgdmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsXG4gIGlubGluZTogc3RyaW5nW10sXG4gIGZsYWdzOiBGbGFncyxcbik6IFByb21pc2U8eyB0ZXh0OiBzdHJpbmc7IGZyb21JbmxpbmU6IGJvb2xlYW4gfT4ge1xuICBpZiAoZmxhZ3NbXCJib2R5LWZpbGVcIl0pIHtcbiAgICBjb25zdCBwYXRoID0gZmxhZ3NbXCJib2R5LWZpbGVcIl0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICByZXR1cm4geyB0ZXh0OiAoYXdhaXQgZmlsZS50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSwgZnJvbUlubGluZTogZmFsc2UgfTtcbiAgfVxuICBpZiAoZmxhZ3Muc3RkaW4gfHwgKGlubGluZS5sZW5ndGggPT09IDAgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpKSB7XG4gICAgY29uc3QgYnVmOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcHJvY2Vzcy5zdGRpbikgYnVmLnB1c2goY2h1bmsgYXMgQnVmZmVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGV4dDogQnVmZmVyLmNvbmNhdChidWYpLnRvU3RyaW5nKFwidXRmLThcIikucmVwbGFjZSgvXFxuJC8sIFwiXCIpLFxuICAgICAgZnJvbUlubGluZTogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyB0ZXh0OiBpbmxpbmUuam9pbihcIiBcIiksIGZyb21JbmxpbmU6IHRydWUgfTtcbn1cblxuLy8gVGhlIHR3byBib2R5IGd1YXJkcyBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZTogcmVmdXNlIGEgbGVha2VkIGludm9jYXRpb25cbi8vIChmdW1ibGVkIGhlcmVkb2MpIHVubGVzcyAtLWZvcmNlLCBhbmQgd2FybiBvbiBzaGVsbCBtZXRhY2hhcmFjdGVycyB0aGF0XG4vLyBzdXJ2aXZlZCBhbiBpbmxpbmUgYm9keSAoIzYwIOKAlCB3YXJuLCBuZXZlciBibG9jaykuXG5mdW5jdGlvbiBndWFyZEJvZHkodmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsIHRleHQ6IHN0cmluZywgZnJvbUlubGluZTogYm9vbGVhbiwgZm9yY2U6IGJvb2xlYW4pIHtcbiAgaWYgKCFmb3JjZSAmJiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQpKSB7XG4gICAgZGllKFxuICAgICAgYCR7dmVyYn06IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGdyYXBldmluZSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgYCArXG4gICAgICAgIFwiaGVyZWRvYz8pLiBOb3RoaW5nIHdhcyBzZW50LiBQaXBlIHRoZSByZWFsIGJvZHkgdmlhIC0tc3RkaW4gb3IgXCIgK1xuICAgICAgICBcIi0tYm9keS1maWxlIDxwYXRoPiwgb3IgcGFzcyAtLWZvcmNlIHRvIHNlbmQgaXQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZyb21JbmxpbmUgJiYgbG9va3NTaGVsbFJpc2t5KHRleHQpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBcIiMg4pqgIGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgYmVmb3JlIFwiICtcbiAgICAgICAgXCJncmFwZXZpbmUgc2VlcyB0aGVtIOKAlCB1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiDim5QgUkVHSVNURVIgQTEg4oCUIGBjaG9pY2VzYCBJUyBgR0xPQkFMX0ZMQUdTYCwgVEhFIFNFVCBgcmVzb2x2ZUFsaWFzYCBSRUFEUy5cbiAqIFRoaXMgaXMgYSBESVNKVU5DVElPTiAoZWl0aGVyIGZsYWcgc2F0aXNmaWVzIGl0KSwgc28gdGhlIGNhbGxlciBoYXMgdG8gcGljayxcbiAqIGFuZCBpdCBpcyB0aGUgb25lIGlkZW50aXR5IHJlZnVzYWwgZm91ciB2ZXJicyBzaGFyZS4gVGhlIGVudiB2YXIgc3RheXMgaW5cbiAqIGBoaW50YCBhbmQgZGVsaWJlcmF0ZWx5IE5PVCBpbiBgY2hvaWNlc2A6IGBjaG9pY2VzYCBlbnVtZXJhdGVzIENPTU1BTkRcbiAqIFRPS0VOUyDigJQgd2hhdCB3b3VsZCBoYXZlIGJlZW4gYWNjZXB0ZWQgSU4gVEhFIElOVk9DQVRJT04g4oCUIGFuZCBwdXR0aW5nIGFuXG4gKiBlbnZpcm9ubWVudCBuYW1lIGluIHRoZSBzYW1lIGFycmF5IHdvdWxkIGdpdmUgYSBjYWxsZXIgYSBcImNob2ljZVwiIGl0IGNhbm5vdFxuICogcGFzcyBvbiB0aGUgY29tbWFuZCBsaW5lLlxuICovXG5jb25zdCBpZGVudGl0eVJlcXVpcmVkID0gKHZlcmI6IHN0cmluZyk6IG5ldmVyID0+XG4gIGRpZShgJHt2ZXJifTogaWRlbnRpdHkgcmVxdWlyZWRgLCBcInVzYWdlXCIsIHtcbiAgICBoaW50OiBgcGFzcyAke0dMT0JBTF9GTEFHUy5tYXAoKGYpID0+IGAtLSR7Zn1gKS5qb2luKFwiL1wiKX0gPGFsaWFzPiwgb3Igc2V0IEdSQVBFVklORV9GUk9NYCxcbiAgICBjaG9pY2VzOiBHTE9CQUxfRkxBR1MubWFwKChmKSA9PiBgLS0ke2Z9YCksXG4gIH0pO1xuXG4vLyDimqAgRVZFUlkgQ09NTUFORCBGVU5DVElPTiBCRUxPVyBSRUZVU0VTIEEgTUlTU0lORyBQT1NJVElPTkFMIE9OIElUUyBPV04gRklSU1Rcbi8vIExJTkUgKGEgdXNhZ2UgcmVmdXNhbCB3aGVuIHRoZSBuYW1lIGlzIGZhbHN5KSwgYW5kIGVhY2ggbm93IGRlY2xhcmVzIHRoYXQgcGFyYW1ldGVyXG4vLyBgc3RyaW5nIHwgdW5kZWZpbmVkYCBzbyBpdHMgc2lnbmF0dXJlIHNheXMgd2hhdCB0aGF0IGxpbmUgZG9lcyAodHlwZS1kZWJ0XG4vLyBUMzUpLiBBcml0eSBkaXNwYXRjaCByZWZ1c2VzIGEgbWlzc2luZyByZXF1aXJlZCBwb3NpdGlvbmFsIGJlZm9yZSBhbnkgb2Zcbi8vIHRoZW0gcnVucywgc28gdGhlIGd1YXJkcyBhcmUgdGhlIHNlY29uZCBsaW5lIG9mIGRlZmVuY2UsIG5vdCB0aGUgZmlyc3QuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJ0b3BpY1wiLCBcImZyZXNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE9wZW4ocG9zaXRpb25hbFswXSwge1xuICAgICAgICB0b3BpYzogZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgICBmcm9tOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBmcmVzaDogZmxhZ3MuZnJlc2ggPT09IHRydWUsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0b3BpY1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUb3BpYyhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcG9zaXRpb25hbC5sZW5ndGggPiAxID8gcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGlzdFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRMaXN0KCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwidmVyYm9zZVwiLCBcImZvcmNlXCIsIFwiaW4tcmVwbHktdG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgbmFtZSA9IHBvc2l0aW9uYWxbMF07XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJzZW5kXCIsIHBvc2l0aW9uYWwuc2xpY2UoMSksIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcInNlbmRcIik7XG4gICAgICBndWFyZEJvZHkoXCJzZW5kXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgYXdhaXQgY21kU2VuZChuYW1lLCBmcm9tIGFzIHN0cmluZywgdGV4dCwge1xuICAgICAgICBxdWlldDogISFmbGFncy5xdWlldCxcbiAgICAgICAgdmVyYm9zZTogISFmbGFncy52ZXJib3NlLFxuICAgICAgICBpblJlcGx5VG86IGZsYWdzW1wiaW4tcmVwbHktdG9cIl1cbiAgICAgICAgICA/IG51bWVyaWNGbGFnKFwic2VuZFwiLCBcImluLXJlcGx5LXRvXCIsIGZsYWdzW1wiaW4tcmVwbHktdG9cIl0sIDApXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbm5vdW5jZVwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwiZm9yY2VcIiwgXCJjaGFubmVsc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSByZXNvbHZlQWxpYXMoZmxhZ3MpO1xuICAgICAgY29uc3QgeyB0ZXh0LCBmcm9tSW5saW5lIH0gPSBhd2FpdCByZXNvbHZlQm9keShcImFubm91bmNlXCIsIHBvc2l0aW9uYWwsIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcImFubm91bmNlXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwiYW5ub3VuY2VcIiwgdGV4dCwgZnJvbUlubGluZSwgISFmbGFncy5mb3JjZSk7XG4gICAgICBjb25zdCBjaGFubmVscyA9IGZsYWdzLmNoYW5uZWxzXG4gICAgICAgID8gKGZsYWdzLmNoYW5uZWxzIGFzIHN0cmluZylcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKGMpID0+IGMudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGF3YWl0IGNtZEFubm91bmNlKGZyb20gYXMgc3RyaW5nLCB0ZXh0LCBjaGFubmVscywgeyBxdWlldDogISFmbGFncy5xdWlldCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwdWxsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwic3RhdHVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJwdWxsXCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgYXdhaXQgY21kUHVsbChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgeyBzdGF0dXM6IGZsYWdzLnN0YXR1cyBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidHJpYWdlXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRyaWFnZShwb3NpdGlvbmFsWzBdLCB7IGh1bWFuOiAhIWZsYWdzLmh1bWFuIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYWRcIixcbiAgICBmbGFnczogW1widGV4dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zaXRpb25hbFsxXSA/IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSA6IE5hTjtcbiAgICAgIGF3YWl0IGNtZFJlYWQocG9zaXRpb25hbFswXSwgaWQsIHsgdGV4dDogISFmbGFncy50ZXh0IH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhaXRcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJ0aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJ3YWl0XCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgY29uc3QgdGltZW91dCA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCwgMzApO1xuICAgICAgYXdhaXQgY21kV2FpdChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgdGltZW91dCwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2hvXCIsXG4gICAgZmxhZ3M6IFtcImFsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgaWYgKGZsYWdzLmFsbCkgYXdhaXQgY21kV2hvQWxsKCk7XG4gICAgICBlbHNlIGF3YWl0IGNtZFdobyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbGlhc1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBbGlhcyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwiZnJvbS1zdGFydFwiLCBcImxhc3RcIiwgXCJodW1hblwiLCBcImx1cmtcIiwgXCJtYXhcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgcmV0dXJuIGF3YWl0IGNtZFRhaWwocG9zaXRpb25hbFswXSwge1xuICAgICAgICBzaW5jZTogZmxhZ3Muc2luY2UgIT09IHVuZGVmaW5lZCA/IHNpbmNlT3JEaWUoU3RyaW5nKGZsYWdzLnNpbmNlKSkgOiB1bmRlZmluZWQsXG4gICAgICAgIGZyb21TdGFydDogISFmbGFnc1tcImZyb20tc3RhcnRcIl0sXG4gICAgICAgIGxhc3Q6IGZsYWdzLmxhc3QgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcImxhc3RcIiwgZmxhZ3MubGFzdCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGFzOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBodW1hbjogISFmbGFncy5odW1hbixcbiAgICAgICAgbHVyazogISFmbGFncy5sdXJrLFxuICAgICAgICBtYXg6IHJlc29sdmVUYWlsTWF4KGZsYWdzLm1heCksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmVwXCIsXG4gICAgZmxhZ3M6IFtcImxpdGVyYWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwicGF0dGVyblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRHcmVwKHBvc2l0aW9uYWxbMF0sIHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIiksIHtcbiAgICAgICAgbGl0ZXJhbDogISFmbGFncy5saXRlcmFsLFxuICAgICAgICBmcm9tOiBmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQ2xvc2UocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzZXRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzZXQocG9zaXRpb25hbFswXSwgeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFya1wiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiZGlzcG9zaXRpb25cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgLy8gTmFOIGZvciBhIG1pc3NpbmcgaWQsIGV4YWN0bHkgd2hhdCBgcGFyc2VJbnQodW5kZWZpbmVkKWAgZ2F2ZSDigJQgYW5kXG4gICAgICAgIC8vIGBjbWRNYXJrYCByZWZ1c2VzIGEgbm9uLWZpbml0ZSBpZCBvbiBpdHMgZmlyc3QgbGluZS5cbiAgICAgICAgcG9zaXRpb25hbFsxXSA9PT0gdW5kZWZpbmVkID8gTnVtYmVyLk5hTiA6IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSxcbiAgICAgICAgcG9zaXRpb25hbC5zbGljZSgyKS5qb2luKFwiIFwiKSxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwibWFya1wiKSxcbiAgICAgICAgeyBub3RlOiBmbGFncy5ub3RlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9LFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZW9wZW5cIixcbiAgICBmbGFnczogW1wibm90ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE1hcmsoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIC8vIE5hTiBmb3IgYSBtaXNzaW5nIGlkLCBleGFjdGx5IHdoYXQgYHBhcnNlSW50KHVuZGVmaW5lZClgIGdhdmUg4oCUIGFuZFxuICAgICAgICAvLyBgY21kTWFya2AgcmVmdXNlcyBhIG5vbi1maW5pdGUgaWQgb24gaXRzIGZpcnN0IGxpbmUuXG4gICAgICAgIHBvc2l0aW9uYWxbMV0gPT09IHVuZGVmaW5lZCA/IE51bWJlci5OYU4gOiBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIFwib3BlblwiLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJyZW9wZW5cIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBcmNoaXZlKHBvc2l0aW9uYWxbMF0sIGZhbHNlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCB0cnVlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGFydFwiLFxuICAgIGFsaWFzZXM6IFtcInVwXCJdLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdGFydCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlc3RhcnRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzdGFydCh7IGZvcmNlOiAhIWZsYWdzLmZvcmNlIHx8ICEhZmxhZ3MueWVzIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJvbGxcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUm9sbCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB8fCBmbGFncy55ZXMgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RvcFwiLFxuICAgIGZsYWdzOiBbXCJob2xkXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFN0b3Aoe1xuICAgICAgICBob2xkU2Vjb25kczpcbiAgICAgICAgICBmbGFncy5ob2xkICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInN0b3BcIiwgXCJob2xkXCIsIGZsYWdzLmhvbGQsIDApIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2F0Y2hcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kV2F0Y2gocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhcFwiLFxuICAgIGFsaWFzZXM6IFtcInBydW5lXCJdLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcImRyeS1ydW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVhcCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSwgZHJ5UnVuOiBmbGFnc1tcImRyeS1ydW5cIl0gPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRJbmZvKCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9jdG9yXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZERvY3RvcigpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICBmbGFnczogW1wiaHVtYW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgLy8gVGhlIENMSSBjYW4gYmUgQVNLRUQgd2hhdCBpdCBpcy4gZ3JhcGV2aW5lIGFscmVhZHkgY2Fycmllc1xuICAgICAgLy8gUExVR0lOX1ZFUlNJT04gdG8gd2FybiB0aGF0IGEgZGFlbW9uIGlzIGZyb20gYSBkaWZmZXJlbnQgY2FjaGVkIHBsdWdpblxuICAgICAgLy8gcGF0aCB0aGFuIHRoaXMgQ0xJIChtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaCkg4oCUIGJ1dCBhIGNhbGxlciB0aGF0IGhpdFxuICAgICAgLy8gdGhhdCB3YXJuaW5nLCBvciB0aGF0IHJ1bnMgYHJvbGxgIGZvciBpdHMgdmVyc2lvbiB2ZXJpZnksIGhhZCBubyB3YXkgdG9cbiAgICAgIC8vIGFzayB0aGlzIHNpZGUgd2hhdCBpdCBpcyBob2xkaW5nLiBUaGUgdmFsdWUgd2FzIGFscmVhZHkgaW4gbWVtb3J5OyBvbmx5XG4gICAgICAvLyB0aGUgcXVlc3Rpb24gd2FzIG1pc3NpbmcuXG4gICAgICAvLyBKU09OIGJ5IGRlZmF1bHQsIG1hdGNoaW5nIGV2ZXJ5IGRhdGEgY29tbWFuZDsgLS1odW1hbiBmb3IgcHJvc2UuXG4gICAgICBpZiAoUExVR0lOX1ZFUlNJT04gPT09IG51bGwpXG4gICAgICAgIGRpZShcInZlcnNpb24gdW5hdmFpbGFibGUg4oCUIGNvdWxkIG5vdCByZWFkIHBsdWdpbi5qc29uXCIsIFwiaW50ZXJuYWxcIik7XG4gICAgICBpZiAoZmxhZ3MuaHVtYW4gPT09IHRydWUpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBncmFwZXZpbmUgdiR7UExVR0lOX1ZFUlNJT059XFxuYCk7XG4gICAgICBlbHNlIHByaW50SnNvbih7IG5hbWU6IFwiZ3JhcGV2aW5lXCIsIHZlcnNpb246IFBMVUdJTl9WRVJTSU9OIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICAvLyBFbWl0IHRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgZGVzY3JpcHRpb24g4oCUIGdlbmVyYXRlZCBieVxuICAgICAgLy8gV0FMS0lORyBDT01NQU5EUyBhbmQgQ0xJX09QVElPTlMsIHRoZSBzYW1lIHN0cnVjdHVyZXMgdGhlIHBhcnNlciBhbmRcbiAgICAgIC8vIGRpc3BhdGNoZXIgY29uc3VtZSwgYXQgYW5zd2VyIHRpbWUuIE5vIGRhZW1vbiwgbm8gY29uZmlnLCBub1xuICAgICAgLy8gY3JlZGVudGlhbHM7IHN0ZG91dCwgZXhpdCAwLiBUaGUgc2hhcGUgaXMgYWNjIGRlY2xhcmF0aW9uIGZvcm1hdCB2MFxuICAgICAgLy8gZXhhY3RseSwgc28gdGhlIG91dHB1dCBwaXBlcyBzdHJhaWdodCBpbnRvXG4gICAgICAvLyBgYWNjIGNoZWNrIDxjbGk+IC0tZGVjbGFyYXRpb24gPChncmFwZXZpbmUgc2NoZW1hKWAgd2l0aCBubyBhZGFwdGVyLlxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoYnVpbGREZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJoZWxwXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByaW50SGVscCgpO1xuICAgIH0sXG4gIH0sXG5dO1xuXG5mdW5jdGlvbiBmaW5kQ29tbWFuZCh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQge1xuICByZXR1cm4gQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbiB8fCBjLmFsaWFzZXM/LmluY2x1ZGVzKHRva2VuKSk7XG59XG5cbi8vIFRoZSB2ZXJiJ3MgZnVsbCBhY2NlcHRlZCBzZXQ6IGl0cyBvd24gZmxhZ3MgcGx1cyB0aGUgY29udHJhY3R1YWxseS1nbG9iYWxcbi8vIGlkZW50aXR5IHBhaXIsIGluIHJlZ2lzdHJ5IG9yZGVyLlxuZnVuY3Rpb24gYWNjZXB0ZWRGbGFncyhzcGVjOiBDb21tYW5kU3BlYyk6IEZsYWdOYW1lW10ge1xuICBjb25zdCBvd24gPSBuZXcgU2V0PEZsYWdOYW1lPihbLi4uR0xPQkFMX0ZMQUdTLCAuLi5zcGVjLmZsYWdzXSk7XG4gIHJldHVybiAoT2JqZWN0LmtleXMoQ0xJX09QVElPTlMpIGFzIEZsYWdOYW1lW10pLmZpbHRlcigoaykgPT4gb3duLmhhcyhrKSk7XG59XG5cbi8vIFJvb3QgaW50ZXJjZXB0b3JzIOKAlCBmbGFncyB0aGUgUk9PVCBhbnN3ZXJzIGl0c2VsZiwgYmVmb3JlIGFueSB2ZXJiLiBUaGVzZSBhcmVcbi8vIG5vdCBjb21tYW5kcywgd2hpY2ggaXMgZXhhY3RseSB3aHkgYSBnZW5lcmF0b3Igd2Fsa2luZyBcInRoZSBjb21tYW5kc1wiIHdhbGtzXG4vLyBwYXN0IHRoZW0gKGFjYyBEVC02KTsgdGhleSBhcmUgZGVjbGFyZWQgZXhwbGljaXRseSBhdCBgcGF0aDogW11gLlxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vLyBhY2MgZGVjbGFyYXRpb24gZm9ybWF0IHYwIChzZWUgYWdlbnQtY2xpLWNvbmZvcm1hbmNlIHNyYy9hY2Mva2l0L2RlY2xhcmF0aW9uLnRzKTpcbi8vIHsgZm9ybWF0VmVyc2lvbiwgcHJvdmVuYW5jZSwgc2VsZkRlc2NyaXB0aW9uLCBjb21tYW5kczogW3sgcGF0aCwgYXJncywgcG9zaXRpb25hbHMgfV0gfS5cbi8vIHYwIHJlZnVzZXMgdW5rbm93biBrZXlzLCBzbyBub3RoaW5nIHJpY2hlciAoZWZmZWN0cywgc3VtbWFyaWVzLCB2ZXJzaW9ucylcbi8vIHJpZGVzIGFsb25nIOKAlCB0aG9zZSB3YWl0IGZvciBhIHYxIHdpdGggc2xvdHMgZm9yIHRoZW0uXG5mdW5jdGlvbiBidWlsZERlY2xhcmF0aW9uKCkge1xuICAvLyBFdmVyeSByZWdpc3RyeSBmbGFnIGlzIGFjY2VwdGVkIHRvZGF5OyBhIHJlZnVzYWwgbGlzdCB3b3VsZCBhZGRcbiAgLy8gc3RhdHVzOiBcInJlZnVzZWRcIiBlbnRyaWVzIGhlcmUgdGhlIGRheSBhIHZlcmIgcmVjb2duaXNlcy1hbmQtZGVjbGluZXMgb25lLlxuICBjb25zdCBhcmcgPSAoazogRmxhZ05hbWUpID0+ICh7XG4gICAgbmFtZTogYC0tJHtrfWAsXG4gICAgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSxcbiAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgfSk7XG4gIGNvbnN0IGNvbW1hbmRzOiB7XG4gICAgcGF0aDogc3RyaW5nW107XG4gICAgYXJnczogeyBuYW1lOiBzdHJpbmc7IHR5cGU6IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjsgc3RhdHVzOiBzdHJpbmcgfVtdO1xuICAgIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICB9W10gPSBbXG4gICAge1xuICAgICAgLy8gYHBhdGg6IFtdYCBJUyB0aGUgcm9vdC4gSXRzIGdyYW1tYXI6IG9uZSByZXF1aXJlZCB0b2tlbiBzZWxlY3RpbmcgYVxuICAgICAgLy8gY29tbWFuZCwgb3IgYW4gaW50ZXJjZXB0b3IgZmxhZyB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi5cbiAgICAgIHBhdGg6IFtdLFxuICAgICAgYXJnczogUk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiAoe1xuICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgICAgIH0pKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImNvbW1hbmRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgfSxcbiAgXTtcbiAgZm9yIChjb25zdCBzcGVjIG9mIENPTU1BTkRTKSB7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFtzcGVjLm5hbWUsIC4uLihzcGVjLmFsaWFzZXMgPz8gW10pXSkge1xuICAgICAgY29tbWFuZHMucHVzaCh7XG4gICAgICAgIHBhdGg6IFtuYW1lXSxcbiAgICAgICAgYXJnczogYWNjZXB0ZWRGbGFncyhzcGVjKS5tYXAoKGspID0+IGFyZyhrKSksXG4gICAgICAgIHBvc2l0aW9uYWxzOiBzcGVjLnBvc2l0aW9uYWxzLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUZsYWdzKFxuICBhcmd2OiBzdHJpbmdbXSxcbiAgc3BlYzogQ29tbWFuZFNwZWMsXG4pOiB7XG4gIHBvc2l0aW9uYWw6IHN0cmluZ1tdO1xuICBmbGFnczogRmxhZ3M7XG59IHtcbiAgY29uc3QgYWNjZXB0ZWQgPSBhY2NlcHRlZEZsYWdzKHNwZWMpO1xuICBjb25zdCBvcHRpb25zID0gT2JqZWN0LmZyb21FbnRyaWVzKGFjY2VwdGVkLm1hcCgoaykgPT4gW2ssIENMSV9PUFRJT05TW2tdXSkpO1xuICB0cnkge1xuICAgIGNvbnN0IHsgdmFsdWVzLCBwb3NpdGlvbmFscyB9ID0gbm9kZVBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9ucyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBvc2l0aW9uYWw6IHBvc2l0aW9uYWxzLFxuICAgICAgZmxhZ3M6IHZhbHVlcyBhcyBGbGFncyxcbiAgICB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIGNvbnN0IGJvZHlIaW50ID1cbiAgICAgIHNwZWMubmFtZSA9PT0gXCJzZW5kXCIgfHwgc3BlYy5uYW1lID09PSBcImFubm91bmNlXCJcbiAgICAgICAgPyBcImZvciBhIG1lc3NhZ2UgYm9keSBjb250YWluaW5nIGRhc2hlcywgdXNlIC0tc3RkaW4gb3IgLS1ib2R5LWZpbGUsIFwiICtcbiAgICAgICAgICBcIm9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1cIlxuICAgICAgICA6IFwiXCI7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYCR7c3BlYy5uYW1lfTogJHtkZXRhaWx9YCwge1xuICAgICAgLy8g4puUIFRIRSBTRVQgSVMgYGNob2ljZXNgIE5PVywgTk9UIEEgUFJPU0UgTUFSS0VSLiBJdCB1c2VkIHRvIGJlIGEgc2Vjb25kXG4gICAgICAvLyBsaW5lIHJlYWRpbmcgYHJlY29nbml6ZWQgZmxhZ3M6IC0tYSAtLWJgLCBzcGVsbGVkIHdpdGggdGhlIGNvbG9uXG4gICAgICAvLyBzdHJhaWdodCBhZnRlciB0aGUgbm91biBiZWNhdXNlIHRoYXQgaXMgdGhlIG1hcmtlciBzaGFwZSBhIGZsYWctc2V0XG4gICAgICAvLyBleHRyYWN0b3IgbWF0Y2hlcy5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgQU5EIE5PVCBCRUNBVVNFIFRIRSBNQVJLRVIgV09VTEQgSEFWRSBTVE9QUEVEIFdPUktJTkcg4oCUIHRoYXQgcmVhc29uXG4gICAgICAvLyB3YXMgd3JpdHRlbiBoZXJlIGFuZCBpbiBENzEsIGFuZCBpdCBpcyBGQUxTRS4gYWNjIHBhcnNlcyB0aGUgd2hvbGVcbiAgICAgIC8vIGVudmVsb3BlLCB0aGVuIHdhbGtzIGBzdHJpbmdWYWx1ZXNPZihkb2N1bWVudClgIGFuZCBydW5zIHRoZSBTQU1FIHByb3NlXG4gICAgICAvLyBNQVJLRVIgcmVnZXggb3ZlciBldmVyeSBzdHJpbmcgaW5zaWRlIGl0LCBmb3IgZXhhY3RseSB0aGlzIGNhc2VcbiAgICAgIC8vIChgYWdlbnQtY2xpLWNvbmZvcm1hbmNlL3NyYy9hY2Mva2l0L3N1cmZhY2UudHM6NjUzLTY1NmAsIHdob3NlIGRvY1xuICAgICAgLy8gY29tbWVudCBuYW1lcyBhbnRoaWxsJ3MgYFwiVmFsaWQgZmxhZ3M6IC0tZm9ybWF0XCJgIGluc2lkZSBhbiBgZXJyb3JgXG4gICAgICAvLyBzdHJpbmcpLiBBIG1hcmtlciBlbWJlZGRlZCBpbiB0aGUgZW52ZWxvcGUgd291bGQgc3RpbGwgaGF2ZSBiZWVuIHJlYWQuXG4gICAgICAvL1xuICAgICAgLy8gVGhlIG1vdmUgaXMgcmlnaHQgZm9yIHJlYXNvbnMgdGhhdCBzdXJ2aXZlIHRoYXQgY29ycmVjdGlvbjogYGNob2ljZXNgIGlzXG4gICAgICAvLyB0aGUgZW52ZWxvcGUncyBvd24gZmllbGQgZm9yIHRoZSBhY2NlcHRlZCBzZXQsIGl0IGlzIHdoYXQgZ2xhbW91clxuICAgICAgLy8gcHVibGlzaGVzIGF0IENPTkZPUk1BTlQgTDAsIGFuIEFSUkFZIGNhbm5vdCBiZSB0cnVuY2F0ZWQgYnkgYSByZWFkZXJcbiAgICAgIC8vIHRoYXQgc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHdoaWNoIGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcsIGFuZCBvbmVcbiAgICAgIC8vIHNwZWxsaW5nIG9mIG9uZSBzZXQgY2Fubm90IGRyaWZ0IGZyb20gdGhlIG90aGVyLlxuICAgICAgY2hvaWNlczogYWNjZXB0ZWQubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgICAuLi4oYm9keUhpbnQgPyB7IGhpbnQ6IGJvZHlIaW50IH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29tbWFuZFRva2VucygpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBDT01NQU5EUy5mbGF0TWFwKChjKSA9PiBbYy5uYW1lLCAuLi4oYy5hbGlhc2VzID8/IFtdKV0pO1xufVxuXG5mdW5jdGlvbiBwcmludEhlbHAoKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBncmFwZXZpbmUg4oCUIGFnZW50LXRvLWFnZW50IHdhbGtpZS10YWxraWVcblxuVXNhZ2U6XG4gIGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXSAgIG9wZW4vY3JlYXRlIChhdXRvLXVuYXJjaGl2ZXM7IC0tZnJlc2ggY2xlYXJzIGEgZG9ybWFudCBjaGFubmVsKVxuICBncmFwZXZpbmUgbGlzdFxuICBncmFwZXZpbmUgc2VuZCA8bmFtZT4gWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLXF1aWV0XSBbLS12ZXJib3NlXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tZm9yY2VdIFstLWluLXJlcGx5LXRvIDxpZD5dIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJvZHk6IGlubGluZSB0ZXh0LCAtLXN0ZGluLCAtLWJvZHktZmlsZSwgb3IgcGlwZWQgc3RkaW4gKGRlZmF1bHQgd2hlbiBubyBpbmxpbmUgdGV4dClcbiAgZ3JhcGV2aW5lIGFubm91bmNlIFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1jaGFubmVscyBhLGIsY10gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLXF1aWV0XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBicm9hZGNhc3Qgb25lIG1lc3NhZ2UgdG8gZXZlcnkgYWN0aXZlIGNoYW5uZWwgKG9yIC0tY2hhbm5lbHMpXG4gIGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcy8tLWZyb20gPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyAke1dJTkRPV19IRUxQfSAoLS1odW1hbiBuZXZlciBlbmRzIGJ5IGl0c2VsZilcbiAgICAgICAjIC0tbGFzdCA8bj46IGJhY2tmaWxsIHRoZSBtb3N0IHJlY2VudCBuIG1lc3NhZ2VzIHRoZW4gZ28gbGl2ZSAoYm91bmRlZCBjYXRjaC11cCBmb3IgYSBjb2xkIGpvaW5lcilcbiAgZ3JhcGV2aW5lIHB1bGwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XSAgICMgLS1zdGF0dXMgPSBmdWxsLXNjYW4gZmlsdGVyIChvcGVufHdvbnRmaXh8aW5jb3Jwb3JhdGVkfOKApilcbiAgZ3JhcGV2aW5lIHRyaWFnZSA8bmFtZT4gICAgICAgICAgICAgIyBmdWxsLXNjYW46IG9wZW4gbWVzc2FnZXMgb24gdG9wICsgZ3JvdXBlZCBieV9zdGF0dXNcbiAgZ3JhcGV2aW5lIG1hcmsgPG5hbWU+IDxpZD4gPGRpc3Bvc2l0aW9uPiBbLS1ub3RlIDx0ZXh0Pl0gICMgc2V0IGRpc3Bvc2l0aW9uIChpbmNvcnBvcmF0ZWR8d29udGZpeHxkZWZlcnJlZHzigKYpXG4gIGdyYXBldmluZSByZW9wZW4gPG5hbWU+IDxpZD4gICAgICAgICMgYm91bmNlIGEgbWVzc2FnZSBiYWNrIHRvIG9wZW5cbiAgZ3JhcGV2aW5lIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF0gICAjIG9uZSBmdWxsIG1lc3NhZ2UgYnkgaWQgKC0tdGV4dCA9IHByb3NlKVxuICBncmFwZXZpbmUgd2FpdCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXG4gIGdyYXBldmluZSBncmVwIDxuYW1lPiA8cGF0dGVybj4gWy0tbGl0ZXJhbF0gWy0tZnJvbSA8YWxpYXM+XVxuICBncmFwZXZpbmUgdG9waWMgPG5hbWU+IFs8dGV4dD5dICAgIyBubyB0ZXh0IOKGkiByZWFkIGN1cnJlbnQ7IHdpdGggdGV4dCDihpIgdXBkYXRlXG4gIGdyYXBldmluZSB3aG8gPG5hbWU+ICAgICAgICAgICAgICAjIHJvc3RlcjsgdGhlIGh1bWFucyBmaWVsZCBsaXN0cyBodW1hbnNcbiAgZ3JhcGV2aW5lIGFsaWFzIFs8bmFtZT5dICAgICAgICAgICMgc2V0L3Nob3cgeW91ciBwZXJzaXN0ZWQgYWxpYXMgKGNvbmZpZy5qc29uKVxuICBncmFwZXZpbmUgd2F0Y2ggWzxuYW1lPl0gICAgICAgICAgIyBvcGVuIGJyb3dzZXIgdGFiOyBsaXZlIGNoYXQtYnViYmxlIHZpZXdcbiAgZ3JhcGV2aW5lIHJlc2V0IDxuYW1lPiBbLS1mb3JjZV0gICAgICAgICAgIHNuYXBzaG90IHRoZSBsb2cg4oaSIH4vLmdyYXBldmluZS9hcmNoaXZlLCB0aGVuIGNsZWFyIGl0XG4gIGdyYXBldmluZSBhcmNoaXZlIDxuYW1lPiAgICAgICAgICAjIHJlYWQtb25seToga2VlcCBoaXN0b3J5LCByZWplY3Qgc2VuZHNcbiAgZ3JhcGV2aW5lIHVuYXJjaGl2ZSA8bmFtZT4gICAgICAgICMgYnJpbmcgYW4gYXJjaGl2ZWQgY2hhbm5lbCBiYWNrXG4gIGdyYXBldmluZSBjbG9zZSA8bmFtZT4gICAgICAgICAgICAjIGRlc3RydWN0aXZlOiBkZWxldGUgdGhlIG1lc3NhZ2UgbG9nXG4gIGdyYXBldmluZSBzdGFydCAgICAgICAgICAgICAgICAgICAjIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHJ1bm5pbmcgKGFsaWFzOiB1cCk7IG5vIGNoYW5uZWxcbiAgZ3JhcGV2aW5lIHJlc3RhcnQgWy0tZm9yY2V8LS15ZXNdICMgc3RvcCArIHJlc3Bhd24gZnJlc2g7IC0tZm9yY2UgdG8gb3ZlcnJpZGUgdGhlIGxpdmUtZmxlZXQgZ3VhcmRcbiAgZ3JhcGV2aW5lIHJvbGwgWy0tZm9yY2VdICAgICAgICAgICMgc2FmZSByZXN0YXJ0IChzdG9wK2hvbGQrcmVzcGF3bikgKyB2ZXJzaW9uIHZlcmlmeSDigJQgdGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwXG4gIGdyYXBldmluZSBzdG9wIFstLWhvbGQgPHNlY29uZHM+XSAjIGtpbGwgdGhlIGRhZW1vbjsgLS1ob2xkIHN1cHByZXNzZXMgYXV0by1yZXNwYXduIGZvciA8cz4gc2Vjb25kcyAodXBncmFkZSB3aW5kb3cpXG4gIGdyYXBldmluZSBpbmZvXG4gIGdyYXBldmluZSBkb2N0b3IgICAgICAgICAgICAgICAgICAjIGhlYWx0aCBjaGVjayDigJQgbGFiZWxzIGVhY2ggZGFlbW9uOiBhdXRob3JpdGF0aXZlIC8gb3JwaGFuIC8gdW5yZXNwb25zaXZlIC8gdW5rbm93blxuICBncmFwZXZpbmUgcmVhcCBbLS1mb3JjZV0gWy0tZHJ5LXJ1bl0gICMga2lsbCBvcnBoYW4gZGFlbW9uczsgLS1mb3JjZSBhbHNvIGtpbGxzIHVucmVzcG9uc2l2ZTsgYWxpYXM6IHBydW5lXG5cbiAgZ3JhcGV2aW5lIHNjaGVtYSAgICAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSBkZXNjcmlwdGlvbiAoYWNjIGRlY2xhcmF0aW9uIHYwKVxuICBncmFwZXZpbmUgLS12ZXJzaW9uICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIHZlcnNpb24gKGFsaWFzOiAtViwgdmVyc2lvbilcbiAgZ3JhcGV2aW5lIGhlbHAgICAgICAgICAgICAgICAgICAgICMgdGhpcyB1c2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXG5cbk91dHB1dDpcbiAgRGF0YSBjb21tYW5kcyBlbWl0IEpTT04gb24gc3Rkb3V0IGJ5IERFRkFVTFQ7IHBhc3MgLS1odW1hbiBmb3IgcHJvc2Ugd2hlcmUgYVxuICBjb21tYW5kIG9mZmVycyBpdC4gRGlhZ25vc3RpY3MgYW5kIHdhcm5pbmdzIGdvIHRvIHN0ZGVyciwgbmV2ZXIgc3Rkb3V0LlxuICBVc2FnZSBlcnJvcnMgZXhpdCAyLiBFYWNoIGNvbW1hbmQgYWNjZXB0cyBpdHMgT1dOIGZsYWdzIChwbHVzIC0tYXMvLS1mcm9tLFxuICB3aGljaCBhcmUgZ2xvYmFsKSDigJQgYW4gdW5rbm93biBmbGFnIGZvciBhIHZlcmIgZW51bWVyYXRlcyB0aGF0IHZlcmIncyBzZXQuXG5cbkVudjpcbiAgR1JBUEVWSU5FX0ZST00gICBEZWZhdWx0IGlkZW50aXR5IGFsaWFzICgtLWZyb20vLS1hcyBhcmUgaW50ZXJjaGFuZ2VhYmxlKS5cbiAgR1JBUEVWSU5FX0hPTUUgICBEYXRhIGRpciAoZGVmYXVsdCB+Ly5ncmFwZXZpbmUpLlxuYCk7XG59XG5cbi8qKlxuICogVGhlIHZlcmIgcm91dGVyLiBFdmVyeSByZWplY3Rpb24gaGVyZSBSQUlTRVM7IG5vdGhpbmcgd3JpdGVzIGl0cyBvd24gcHJvc2UuXG4gKlxuICog4puUIFRISVMgRlVOQ1RJT04gVVNFRCBUTyBCRSBgbWFpbmAsIEFORCBJVFMgRk9VUiBSRUpFQ1RJT05TIFVTRUQgVE8gQkVcbiAqIGBwcm9jZXNzLnN0ZGVyci53cml0ZSguLi4pOyByZXR1cm4gMmAg4oCUIGEgU0VDT05EIGVycm9yIGNvbnRyYWN0IGJlc2lkZSBgZGllYCxcbiAqIHdpdGggaXRzIG93biB3b3JkaW5nLCBpdHMgb3duIG1hcmtlcnMgYW5kIG5vIGBraW5kYCBvbiB0aGUgd2lyZS4gQSBncmVwIGZvclxuICogYGRpZShgIHdvdWxkIGhhdmUgcmVwb3J0ZWQgXCJ0aGUgZXJyb3IgY29udHJhY3QgaXMgNDYgc2l0ZXNcIjsgaXQgd2FzIDQ2IHBsdXNcbiAqIHRoZXNlLCBhbmQgdGhlc2UgYXJlIHRoZSBvbmVzIGFuIGFnZW50IG1lZXRzIGZpcnN0IChwbGF5Ym9vayBCODogbG9vayBmb3IgdGhlXG4gKiBSQUlTRSwgbm90IGZvciB0aGUgaGVscGVyKS4gVGhleSBub3cgcmFpc2UgdGhlIHNhbWUgZW52ZWxvcGUgYXMgdGhlIHJlc3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgW2NtZCwgLi4ucmVzdF0gPSBhcmd2O1xuXG4gIC8vIEJBUkUgSU5WT0NBVElPTiBJUyBBIFVTQUdFIEVSUk9SIOKAlCBleGl0IDIsIHVzYWdlIHBvaW50ZXIgb24gc3RkZXJyIOKAlCBub3QgYVxuICAvLyBoZWxwIHJlcXVlc3QgYXQgZXhpdCAwLiBncmFwZXZpbmUncyBjYWxsZXJzIGFyZSBhZ2VudHM6IGEgYmFyZSBjYWxsIGlzIGFuXG4gIC8vIHVuc2V0IHNoZWxsIHZhcmlhYmxlIGV4cGFuZGluZyB0byBub3RoaW5nLCBvciBhIG1pc3Rha2UsIGFuZCBhbnN3ZXJpbmcgaXRcbiAgLy8gd2l0aCAyLjlLQiBvZiBoZWxwIGF0IGV4aXQgMCByZXBvcnRzIHN1Y2Nlc3MgZm9yIGEgY29tbWFuZCB0aGF0IGFza2VkIGZvclxuICAvLyBub3RoaW5nLiBgaGVscGAgLyBgLS1oZWxwYCByZW1haW4gb25lIHRva2VuIGF3YXkgYXQgZXhpdCAwIChhY2MgRDIg4oCUXG4gIC8vIGNvbmZvcm1lZCBmb3IgdGhhdCByZWFzb24sIG5vdCBiZWNhdXNlIHRoZSBydWxlIHNhaWQgc28pLlxuICBpZiAoY21kID09PSB1bmRlZmluZWQpIHtcbiAgICBkaWUoXCJleHBlY3RlZCBhIGNvbW1hbmRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICBjaG9pY2VzOiBjb21tYW5kVG9rZW5zKCksXG4gICAgICBoaW50OiBcInJ1biBgZ3JhcGV2aW5lIGhlbHBgIChvciAtLWhlbHApIGZvciB1c2FnZVwiLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gUk9PVCBGTEFHIFJPVVRJTkcuIEEgbGVhZGluZyAtLXRva2VuIHVzZWQgdG8gYmUgY29uc3VtZWQgYXMgdGhlIENPTU1BTkRcbiAgLy8gdG9rZW4gYW5kIHJlamVjdGVkIGFzIGB1bmtub3duIGNvbW1hbmQ6IC0tbm9wZWAg4oCUIGEgZmxhZyByZWFjaGluZyB0aGUgdmVyYlxuICAvLyBwYXJzZXIncyBlcnJvciBwYXRoLCB3aGVyZSB0aGUgcmVqZWN0aW9uIGNvdWxkIG5vdCBlbnVtZXJhdGUgdGhlIGZsYWcgc2V0XG4gIC8vIChmb3VuZCB2aWEgYWNjJ3Mgcm9vdC1vbmx5IHN1cmZhY2UgY2FwdHVyZSkuIFRoZSByb290J3MgYWNjZXB0ZWQgZmxhZ3MgYXJlXG4gIC8vIHRoZSBpbnRlcmNlcHRvcnM7IGFueXRoaW5nIGVsc2UgZGFzaGVkIGlzIHJlamVjdGVkIEFTIEEgRkxBRywgZW51bWVyYXRpbmdcbiAgLy8gdGhlIHJvb3QncyBvd24gc2V0LlxuICBpZiAoY21kLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBST09UX0lOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGNtZCk7XG4gICAgaWYgKCFpbnRlcmNlcHRvcikge1xuICAgICAgLy8g4pqgIFRIRSBTT1JUIFNVUlZJVkVTIFRIRSBNT1ZFIElOVE8gYGNob2ljZXNgLCBBTkQgSVQgSVMgTk9UIERFQ09SQVRJT04uXG4gICAgICAvLyBMb25nIGZsYWdzIGZpcnN0LCBiZWNhdXNlIGEgZmxhZy1zZXQgZXh0cmFjdG9yIHJlYWRzIHRoZSBsaXN0XG4gICAgICAvLyBsZWZ0LXRvLXJpZ2h0IGFuZCBzdG9wcyBhdCB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLFxuICAgICAgLy8gc28gYSBzaG9ydCBhbGlhcyBtaWQtbGlzdCB0cnVuY2F0ZXMgd2hhdCBpdCBzZWVzLiBBbiBhcnJheSBpcyBub3RcbiAgICAgIC8vIHZ1bG5lcmFibGUgdG8gdGhhdCDigJQgYnV0IHRoZSBvcmRlciBpcyBmcmVlIGFuZCB0aGUgcHJvcGVydHkgaXMgcmVhbCBmb3JcbiAgICAgIC8vIGFueSBjb25zdW1lciB0aGF0IGZsYXR0ZW5zIGl0IGJhY2sgdG8gYSBsaW5lLlxuICAgICAgZGllKGB1bmtub3duIGZsYWcgYXQgdGhlIHJvb3Q6ICR7Y21kfWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4uUk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpXS5zb3J0KFxuICAgICAgICAgIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbiAgICAgICAgKSxcbiAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke2NvbW1hbmRUb2tlbnMoKS5qb2luKFwiIFwiKX1gLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBydW5Db21tYW5kKGZpbmRDb21tYW5kKGludGVyY2VwdG9yLnJ1bnMpIGFzIENvbW1hbmRTcGVjLCByZXN0KTtcbiAgfVxuXG4gIGNvbnN0IHNwZWMgPSBmaW5kQ29tbWFuZChjbWQpO1xuICBpZiAoIXNwZWMpIHtcbiAgICAvLyBUaGUgdW5rbm93bi12ZXJiIHJlamVjdGlvbiBlbnVtZXJhdGVzIHRoZSB2YWxpZCBzZXQsIGV4YWN0bHkgYXMgdGhlXG4gICAgLy8gdW5rbm93bi1mbGFnIHJlamVjdGlvbiBkb2VzIOKAlCB0aGUgcGFyc2VyJ3Mgb3duIGFjY291bnQgb2Ygd2hhdCBpdFxuICAgIC8vIGFjY2VwdHMsIHByb2R1Y2VkIGJ5IHRoZSBwYXJzZXIgKGFjYyBTVEFOREFSRC5tZCwgXCJ0aGUgY2hlYXBlc3QgdmVyc2lvblxuICAgIC8vIG9mIGNoZWNrZWRcIikuXG4gICAgZGllKGB1bmtub3duIGNvbW1hbmQ6ICR7Y21kfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzOiBjb21tYW5kVG9rZW5zKCkgfSk7XG4gIH1cbiAgcmV0dXJuIGF3YWl0IHJ1bkNvbW1hbmQoc3BlYywgcmVzdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkNvbW1hbmQoc3BlYzogQ29tbWFuZFNwZWMsIHJlc3Q6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBvc2l0aW9uYWw6IHN0cmluZ1tdO1xuICBsZXQgZmxhZ3M6IEZsYWdzO1xuICB0cnkge1xuICAgICh7IHBvc2l0aW9uYWwsIGZsYWdzIH0gPSBwYXJzZUZsYWdzKHJlc3QsIHNwZWMpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICBkaWUoZS5tZXNzYWdlLCBcInVzYWdlXCIsIGUuZXh0cmEpO1xuICB9XG4gIC8vIEFyaXR5LCBlbmZvcmNlZCBGUk9NIFRIRSBERUNMQVJFRCBTSEFQRSDigJQgdGhlIHJlZ2lzdHJ5J3MgcG9zaXRpb25hbCBzcGVjIGlzXG4gIC8vIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLCBzbyBlbmZvcmNpbmcgaXQgaGVyZSBpcyB3aGF0IGtlZXBzIHRoZSBkZWNsYXJhdGlvblxuICAvLyB0cnVlIGJ5IGNvbnN0cnVjdGlvbjogYSBtaXNzaW5nIHJlcXVpcmVkIHBvc2l0aW9uYWwgZXJyb3JzIGJlZm9yZSB0aGUgdmVyYlxuICAvLyBydW5zLCBhbmQgYW4gRVhDRVNTIHBvc2l0aW9uYWwgaXMgcmVqZWN0ZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgc3dhbGxvd2VkXG4gIC8vIChhY2MgQTQncyBzaGFwZSDigJQgdGhlIGRlZmVjdCBubyBleHRlcm5hbCBjaGVjayBjYW4gc2VlKS5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3NpdGlvbmFsLmxlbmd0aCA8IHJlcXVpcmVkKSB7XG4gICAgY29uc3QgbWlzc2luZyA9IHNwZWMucG9zaXRpb25hbHNbcG9zaXRpb25hbC5sZW5ndGhdO1xuICAgIGRpZShgJHtzcGVjLm5hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIDwke21pc3Npbmc/Lm5hbWUgPz8gXCJhcmd1bWVudFwifT5gLCBcInVzYWdlXCIsIHtcbiAgICAgIGhpbnQ6IGBleHBlY3RzOiAke3NwZWMubmFtZX0gJHtzcGVjLnBvc2l0aW9uYWxzXG4gICAgICAgIC5tYXAoKHApID0+IChwLnJlcXVpcmVkID8gYDwke3AubmFtZX0+YCA6IGBbJHtwLm5hbWV9XWApKVxuICAgICAgICAuam9pbihcIiBcIil9YCxcbiAgICB9KTtcbiAgfVxuICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWwubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICBkaWUoXG4gICAgICBgJHtzcGVjLm5hbWV9OiB1bmV4cGVjdGVkIGFyZ3VtZW50ICR7SlNPTi5zdHJpbmdpZnkocG9zaXRpb25hbFtzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aF0pfWAsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IGBleHBlY3RzOiAke3NwZWMubmFtZX0gJHtcbiAgICAgICAgICBzcGVjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHAucmVxdWlyZWQgPyBgPCR7cC5uYW1lfT5gIDogYFske3AubmFtZX1dYCkpLmpvaW4oXCIgXCIpIHx8XG4gICAgICAgICAgXCIobm8gYXJndW1lbnRzKVwiXG4gICAgICAgIH1gLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBzcGVjLnJ1bihwb3NpdGlvbmFsLCBmbGFncyk7XG4gIHJldHVybiB0eXBlb2Ygb3V0Y29tZSA9PT0gXCJudW1iZXJcIiA/IG91dGNvbWUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBvbmUgcGxhY2UgdGhpcyBDTEkgY2FuIGVuZCwgYW5kIHRoZSBvbmUgcGxhY2UgYSBgQ2xpRXJyb3JgIGJlY29tZXMgYW5cbiAqIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgQURERUQgQVQgUEhBU0UgNiBDSEFQVEVSIDIsIEFORCBJVCBJUyBXSEFUIE1BS0VTIGBkaWVgIFNBRkUgVE8gVEhST1cuXG4gKiBgcmVwb3J0Q2xpRXJyb3JgIHdyaXRlcyB0aGUgZW52ZWxvcGUgYW5kIGhhbmRzIGJhY2sgdGhlIHRheG9ub215IGNvZGU7IGFcbiAqIHRocm93IGl0IGRvZXMgTk9UIHJlY29nbmlzZSBpcyByZS10aHJvd24sIGJlY2F1c2Ugc3dhbGxvd2luZyBhbiB1bmtub3duIG9uZVxuICogaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5IHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlXG4gKiBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqXG4gKiDimqAgQU5EIGBzZXRDdXJyZW50Q29tbWFuZGAgSVMgTk9UIERFQ09SQVRJT04g4oCUIGl0IGlzIHRoZSBgbWV0YS5jb21tYW5kYCBmaWVsZFxuICogb2YgZXZlcnkgZW52ZWxvcGUgdGhpcyBDTEkgZW1pdHMsIHdoaWNoIGlzIGhvdyBhIGNhbGxlciByb3V0aW5nIG9uIGBraW5kYFxuICoga25vd3MgV0hJQ0ggdmVyYiBwcm9kdWNlZCBpdC4gU2V0IGZyb20gdGhlIHJhdyB0b2tlbiBzbyBhbiB1bmtub3duIHZlcmIgc3RpbGxcbiAqIG5hbWVzIGl0c2VsZiBpbiBpdHMgb3duIHJlamVjdGlvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHNldEN1cnJlbnRDb21tYW5kKGFyZ3ZbMF0gPz8gbnVsbCk7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlICE9PSBudWxsKSByZXR1cm4gY29kZTtcbiAgICB0aHJvdyBlO1xuICB9XG59XG5cbi8vIOKblCBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBJVFMgQUJTRU5DRSBJUyBUSEUgU1RFUCAocGxheWJvb2sgQjMpLlxuLy8gYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSBgc2NyaXB0cy9jbGkudHNgLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuLy8gZW50cnksIHNvIHRoZSBndWFyZCB3b3VsZCBuZXZlciBydW4gYW5kIGV2ZXJ5IHZlcmIgd291bGQgcHJpbnQgbm90aGluZyBhbmRcbi8vIGV4aXQgMC4gTm9yIG1heSB0aGlzIGZpbGUgb2ZmZXIgYSBzZWNvbmQgZW50cnkgZnJvbSBpdHMgYXV0aG9yaW5nIGFkZHJlc3M6XG4vLyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAsIGBTVVJGQUNFX0NXRGAgYW5kIGBEQUVNT05fU0NSSVBUYCBhYm92ZSBhcmUgYWxsXG4vLyBjb21wdXRlZCBmcm9tIGBTQ1JJUFRfRElSYCBhbmQgYXJlIGNvcnJlY3Qgb25seSBmcm9tIGBkaXN0L2AuXG4vL1xuLy8gVGhlIGRyYWluIGNvbnRyYWN0IGxpdmVzIGF0IHRoZSBsYXVuY2hlciBub3cg4oCUIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbFxuLy8gcmV0dXJuLCBuZXZlciBhbiBleHBsaWNpdCBleGl0LCBiZWNhdXNlIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYVxuLy8gcGlwZSBhbmQgYHRhaWxgIHdyaXRlcyBKU09OTCBhIGNhbGxlciBwYXJzZXMuIFNlZVxuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9jbGkudHNgIGZvciB0aGUgZnVsbCBhY2NvdW50LlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2JhY2tsb2cvMjAyNi0wOS0yMi1zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0yMi1tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIGFsd2F5cyBnZXRzIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsXG4gKiAgICAgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzIGNvbm5lY3Rpb24gY2Fycmllcy5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzKSwgZWFjaCBuYW1pbmcgaG93IHRvIGNvbWUgYmFja1xuICogaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmUgYVxuICogcmVhbC1kYWVtb24gY2VsbCBpbiBgc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdGFpbC1oYW5kb2ZmLmludGVncmF0aW9uLnRlc3QudHNgLlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgcHJlc2VuY2UgdGFpbCAoYXN0cm9sYWJlLCBtaW5kLW1hcHBlcilcbiAqICAgICAgICAgICAgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHkgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBvcGVucyBub1xuICogYnJvd3NlciB0YWIuXG4gKlxuICog4pqgIEtOT1dOIEVER0UsIE5PVCBGSVhFRCAoZm91bmQgYnkgdGhlIHJlLXJldmlldyk6IGEga2V5ZWQgYm91bnR5IEZJUlNUIGFybVxuICogICAoYW4gYW50aGlsbCBzZWF0KSB3aG9zZSB3aW5kb3cgZW5kcyBiZWZvcmUgaXRzIGJvYXJkIGV2ZXIgb3BlbnMgcHJpbnRzIGFcbiAqICAgcmUtYXJtIHBpbm5lZCB0byB0aGUgZGVyaXZlZCBpZCB3aXRoIGFuIGVtcHR5IGJvb2ttYXJrXG4gKiAgIChgLS1zZXNzaW9uIGst4oCmIC0tc2luY2U9LTEgLS1vbmNlYCkuIFRoYXQgcmUtYXJtIGlzIGEgcmUtYXJtIGJ5IEQxJ3MgcnVsZSxcbiAqICAgc28gaWYgdGhlIGJvYXJkIGlzIHN0aWxsIG5vdCB1cCDigJQgdGhlIGxlYWQgbW9yZSB0aGFuIG9uZSB3aW5kb3cgKDI5IG1pbilcbiAqICAgbGF0ZSDigJQgdGhlIHNlYXQgZ2V0cyBgdGFpbC5jbG9zZWRgIGluc3RlYWQgb2Ygd2FpdGluZy4gTWlub3I6IHRoZVxuICogICBjb21lLWJhY2sgaXQgbmFtZXMgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApIGlzIHRoZSByaWdodCBuZXh0IHN0ZXAgYW55d2F5LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09NTUFORCBOQU1FUyBOTyBQQVRIIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbGluZSdzIGBjb21tYW5kYCBpcyB0aGUgVkVSQiBBTkQgSVRTIEFSR1VNRU5UUyBPTkxZXG4gKiAoYHRhaWwgLS1zZXNzaW9uIFggLS1zaW5jZSBOQEUgLS1vbmNlYCksIHBsdXMgYHNwZWxsYCwgYW5kIHRoZSBhZ2VudCBydW5zIGl0XG4gKiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzYC4gSXQgdXNlZFxuICogdG8gYmUgcnVubmFibGUgYXMgcHJpbnRlZCwgaGVhZGVkIGJ5IGBidW4gPGFyZ3ZbMV0+YCDigJQgYW5kIGZvciBhbiBpbnN0YWxsZWRcbiAqIHBsdWdpbiBgYXJndlsxXWAgaXMgaW5zaWRlIGEgVkVSU0lPTkVEIGNhY2hlIGRpcmVjdG9yeS4gQW4gdXBncmFkZSBtYXJrcyB0aGVcbiAqIG9sZCBkaXJlY3Rvcnkgb3JwaGFuZWQgYW5kIGRlbGV0ZXMgaXQgbGF0ZXIgKG1lYXN1cmVkIGluXG4gKiBgZG9jcy9iYWNrbG9nLzIwMjYtMDktMjQtdGFpbC1yZWFybS1jb21tYW5kLW5hbWVzLWEtdmVyc2lvbmVkLXBsdWdpbi1wYXRoLm1kYCksXG4gKiBzbyBhIGxpbmUgcHJpbnRlZCBiZWZvcmUgYW4gdXBncmFkZSBmaXJzdCByYW4gU1RBTEUgY29kZSBhZ2FpbnN0IGEgbmV3ZXJcbiAqIGRhZW1vbiwgdGhlbiBmYWlsZWQgd2l0aCBcIm1vZHVsZSBub3QgZm91bmRcIiBvbmNlIHRoZSBkaXJlY3Rvcnkgd2FzIGdvbmUuIE5vXG4gKiBzdGFibGUgcGF0aCBleGlzdHMgdG8gcHJpbnQgaW5zdGVhZDogdGhlIGNhY2hlLCBgJENMQVVERV9QTFVHSU5fUk9PVGAgYW5kIHRoZVxuICogaW5zdGFsbCByZWNvcmQgYXJlIGFsbCB2ZXJzaW9uZWQuXG4gKiAgIFRoZSBza2lsbCdzIGxhdW5jaGVyIGlzIGFsd2F5cyB0aGUgdmVyc2lvbiB0aGUgc2Vzc2lvbiBsb2FkZWQuIENvbGUnc1xuICogcmVhc29uaW5nOiB0aGUgd29yc3QgY2FzZSBpcyB0aGF0IHRoZSBDTEkgY2hhbmdlZCBhbmQgdGhlIGFnZW50IGdldHMgYW5cbiAqIGVycm9yIOKAlCBhbmQgaWYgdGhlIHRvb2xzIGFyZSBkZXNpZ25lZCByaWdodCwgdGhhdCBlcnJvciBzYXlzIHdoYXQgd2VudFxuICogd3JvbmcuIFNvIHRoZSBwYXJzZXJzIGFyZSB0aGUgb3RoZXIgaGFsZiBvZiB0aGlzIHJ1bGluZzogYHJlYWRTaW5jZWAgcmVmdXNlc1xuICogYW55IGAtLXNpbmNlYCBmb3JtIGEgdGFpbCBkb2VzIG5vdCBhY2NlcHQgd2l0aCBhIHVzYWdlIGVycm9yIE5BTUlORyB0aGVcbiAqIGZvcm1zIGl0IGRvZXMsIHRoZSBzYW1lIHdheSBvbiBhbGwgZWlnaHQgdGFpbHMsIGluc3RlYWQgb2YgbWlzcGFyc2luZyBpdC5cbiAqICAgTm90IHRha2VuOiBwcmludGluZyB0aGUgcGF0aCBBTkQgdGhlIGFyZ3MgKG9wdGlvbiBBIG9mIHRoZSBpdGVtIOKAlCB0d29cbiAqIGNvbW1hbmRzIHdoZXJlIG9uZSBpcyB3cm9uZyBhZnRlciBhbiB1cGdyYWRlKTsgYSBsYXVuY2hlciB0aGF0IG5vdGljZXMgaXQgaXNcbiAqIG9ycGhhbmVkIGFuZCByZS1leGVjcyBhIG5ld2VyIHNpYmxpbmcgKEIg4oCUIGl0IGxlYW5zIG9uIGEgQ2xhdWRlIENvZGVcbiAqIGludGVybmFsIG1hcmtlciBhbmQgZG9lcyBub3RoaW5nIG9uY2UgdGhlIGRpcmVjdG9yeSBpcyBkZWxldGVkKTsgdmVyc2lvblxuICogbmVnb3RpYXRpb24uXG4gKlxuICog4pqWIGAtLW9uY2VgIEVORFMgT04gVEhFIEZJUlNUIEZSQU1FLCB3aXRoIG5vIGRyYWluLiBBIGJ1cnN0IGFycml2ZXMgc3BsaXQ6IHRoZVxuICogICBmaXJzdCBldmVudCBvbiB0aGUgb25lLXNob3QsIHRoZSByZXN0IG9uIHRoZSBNb25pdG9yIHJlLWFybSwgd2hpY2ggbG9zZXNcbiAqICAgbm90aGluZyBiZWNhdXNlIG9mIHRoZSBib29rbWFyay4gVGhlIHNwaWtlIG9mZmVyZWQgYSB+MjAwIG1zIGRyYWluIGFzIGFuXG4gKiAgIG9wdGlvbiwgbm90IGEgcmVxdWlyZW1lbnQ7IG5vdCB0YWtlbiwgYmVjYXVzZSBpdCBhZGRzIGEgdGltZXIgdG8gdGhlXG4gKiAgIGV4aXQgcGF0aCB3aG9zZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byBtYWtlIGltcG9zc2libGUuXG4gKiDimpYgVEhFIExJTkUnUyBgY29tbWFuZGAgSVMgQ09NUExFVEUgQlVUIEZPUiBUSEUgTEFVTkNIRVI6IHBpbm5lZCB0byB0aGVcbiAqICAgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlIHNraWxscyBuYW1lIHRoZVxuICogICBydWxlIG9uY2UsIGxhdW5jaGVyIGZvcm0gaW5jbHVkZWQ7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICAvKiogVGhlIHZlcmIgYW5kIGl0cyBhcmd1bWVudHMgT05MWSDigJQgbm8gbGF1bmNoZXIsIG5vIHBhdGguIFRoZSBhZ2VudCBydW5zXG4gICAqICBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5gLiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKiBIb3cgdGhlIGFnZW50IHJ1bnMgYSBwcmludGVkIGBjb21tYW5kYDogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBuZXZlciBhIHBhdGhcbiAqICB0aGlzIHByb2Nlc3MgbmFtZXMgKHRoZSBydWxpbmcgb24gdGhlIHZlcnNpb25lZCBwbHVnaW4gcGF0aCwgaW4gdGhlIGhlYWRlcikuICovXG5leHBvcnQgY29uc3QgUlVOX1dJVEhfTEFVTkNIRVIgPSBcImJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+XCI7XG5cbi8qKiBUaGUgY29tZS1iYWNrIGhpbnQsIHdpdGggaG93IHRvIFJFU1VNRSBhZnRlciBjb21pbmcgYmFjayAoRDIpOiBhIHJlc3RvcmVkXG4gKiAgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgbWVhbnMgbm90aGluZyB0aGVyZS4gKi9cbmNvbnN0IENPTUVfQkFDSyA9ICh3aHk6IHN0cmluZykgPT5cbiAgYCR7d2h5fSBUbyBicmluZyBpdCBiYWNrLCBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn07IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBzcGVsbDogcy5zcGVsbCwgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLTEgZm9yIGV2ZXJ5dGhpbmcpXCJcbiAgICAgIDogYGFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyLCAke21pbn0gb3IgbW9yZSlgO1xuICBjb25zdCBmb3JtcyA9IG8uZXBvY2ggPyBgJHtpZH0sIG9yIDxpZD5APGVwb2NoPiBhcyBhIGhhbmRvZmYgbGluZSBwcmludHMgaXRgIDogaWQ7XG4gIGNvbnN0IHdoeSA9XG4gICAgIW8uZXBvY2ggJiYgdG9rZW4uaW5jbHVkZXMoXCJAXCIpXG4gICAgICA/IGA7IHRoaXMgc3BlbGwncyBsb2cgc3RhbXBzIG5vIGVwb2NoLCBzbyBwYXNzIHRoZSBpZCB3aXRob3V0IHRoZSBcIkDigKZcIiBwYXJ0YFxuICAgICAgOiBcIlwiO1xuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBtZXNzYWdlOiBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhIGJvb2ttYXJrIHRoaXMgdGFpbCBhY2NlcHRzIOKAlCBnaXZlICR7Zm9ybXN9JHt3aHl9YCxcbiAgfTtcbn1cblxuLyoqIEpvaW4gYW4gYXJndiBpbnRvIG9uZSBydW5uYWJsZSBjb21tYW5kIGxpbmUuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZExpbmUoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYXJndi5tYXAoc2hlbGxRdW90ZSkuam9pbihcIiBcIik7XG59XG5cbi8qKiBUaGUgcmUtYXJtIGZvciBhIHNwZWxsIHdob3NlIHRhaWwgaXMgYDxwcmVmaXjigKY+IC0tc2luY2UgTltAZXBvY2hdIFstLW9uY2VdYC5cbiAqICBQYXNzIGBlcG9jaGAgb25seSBmb3IgYSBzcGVsbCB3aG9zZSBgLS1zaW5jZWAgcGFyc2VzIGl0IChgcGFyc2VCb29rbWFya2ApLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxDb21tYW5kKFxuICBwcmVmaXg6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBzaW5jZTogbnVtYmVyLFxuICBvbmNlOiBib29sZWFuLFxuICBlcG9jaD86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIC8vIOKaoCBBIG5lZ2F0aXZlIGJvb2ttYXJrIChub3RoaW5nIHNlZW4geWV0KSBpcyBzcGVsbGVkIGAtLXNpbmNlPS0xYDogdGhlXG4gIC8vIHBhcnNlcnMgcmVhZCBhIGJhcmUgYC0xYCBhZnRlciBhIGZsYWcgYXMgYW5vdGhlciBmbGFnIGFuZCByZWZ1c2UgaXQuXG4gIGNvbnN0IG1hcmsgPSBlcG9jaCA/IGAke3NpbmNlfUAke2Vwb2NofWAgOiBTdHJpbmcoc2luY2UpO1xuICBjb25zdCBhdCA9IHNpbmNlIDwgMCA/IFtgLS1zaW5jZT0ke21hcmt9YF0gOiBbXCItLXNpbmNlXCIsIG1hcmtdO1xuICByZXR1cm4gY29tbWFuZExpbmUoWy4uLnByZWZpeCwgLi4uYXQsIC4uLihvbmNlID8gW1wiLS1vbmNlXCJdIDogW10pXSk7XG59XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZPcHRpb25zPEV2PiA9IHtcbiAgLyoqIFRoZSBzcGVsbCdzIG5hbWUsIGNhcnJpZWQgb24gdGhlIGxpbmUgKHdob3NlIGxhdW5jaGVyIHJ1bnMgaXQpLiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIEEgcHJlc2VuY2Ugc3BlbGw6IGFsd2F5cyBgdGFpbC53aW5kb3dgIGF0IHRoZSB3aW5kb3cncyBlbmQsIG5ldmVyIGxvc3QuICovXG4gIHByZXNlbmNlOiBib29sZWFuO1xuICAvKiogRGVmYXVsdDogYHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSlgLiBgMGAgPSBubyB3aW5kb3cuICovXG4gIHdpbmRvd01zPzogbnVtYmVyO1xuICAvKiogV2hldGhlciBhbiBlbWl0dGVkIGZyYW1lIGlzIGEgTE9HIGZyYW1lIChBMykuIERlZmF1bHQ6IGV2ZXJ5IG9uZS4gKi9cbiAgY291bnRzPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogV2hpY2ggdGVybWluYWwgZnJhbWUgbWVhbnMgdGhlIHNlc3Npb24gY2xvc2VkLiBEZWZhdWx0OiBldmVyeSB0ZXJtaW5hbC4gKi9cbiAgaXNDbG9zZWQ/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gdGFpbC5zaW5jZUVwb2NoO1xuICBsZXQgZnJhbWVIYXNJZCA9IGZhbHNlO1xuICAvKiogQTMgKyBEMzogYSBmcmFtZSBjb3VudHMsIGFuZCB3YWtlcyBhIGAtLW9uY2VgLCBvbmx5IHdoZW4gaXQgaXMgT04gVEhFXG4gICAqICBMT0cg4oCUIGl0IGNhcnJpZXMgYSBsb2cgaWQg4oCUIGFuZCB0aGUgc3BlbGwncyBvd24gYGNvdW50c2AgYWdyZWVzLiBBIHRhYidzXG4gICAqICBpZC1sZXNzIGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgIHBpbmcgaXMgbm90IG9uIHRoZSBsb2cuICovXG4gIGNvbnN0IGlzTG9nRnJhbWUgPSAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGZyYW1lSGFzSWQgJiYgY291bnRzKGV2LCBmcmFtZSk7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlZnVzYWxzID0gMDtcblxuICBjb25zdCBmaW5pc2ggPSAoZTogVGFpbEVuZCkgPT4ge1xuICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IGU7XG4gICAgYWMuYWJvcnQoKTtcbiAgfTtcbiAgY29uc3QgdGltZXIgPVxuICAgIGgubW9kZSA9PT0gXCJ3YXRjaFwiICYmIHdpbmRvd01zID4gMCA/IHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKFwid2luZG93XCIpLCB3aW5kb3dNcykgOiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29kZSA9IGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICAgIC4uLnRhaWwsXG4gICAgICBzaWduYWw6IGFjLnNpZ25hbCxcbiAgICAgIC8vIEQyJ3MgbmV0LiBPbiBmb3IgZXZlcnkgc3BlbGw6IGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvclxuICAgICAgLy8gbWVhbnMgYSB3aG9sZSByZXBsYXkgb24gdGhlIGtpdCdzIGxvZywgYW5kIG9uIGdyYXBldmluZSdzIGR1cmFibGUgbG9nXG4gICAgICAvLyBpdCBoYXBwZW5zIG9ubHkgd2hlbiBgLS1sYXN0YCByZWFjaGVzIGJlbG93IGAtLXNpbmNlYCwgd2hlcmVcbiAgICAgIC8vIHJlLXJlYWRpbmcgdGhlIGN1cnNvciBmcm9tIHRoZSBmcmFtZXMgaXMgdGhlIG1vcmUgY29ycmVjdCBhbnN3ZXIuXG4gICAgICByZXN0YXJ0T25SZXBsYXk6IHRydWUsXG4gICAgICAvLyBEMzogcmVtZW1iZXIgd2hldGhlciBUSElTIGZyYW1lIGNhcnJpZXMgYSBsb2cgaWQuIGB0YWlsRXZlbnRzYCByZWFkc1xuICAgICAgLy8gdGhlIGN1cnNvciBvbmNlIHBlciBmcmFtZSwgYmVmb3JlIGBhY2NlcHRgLCBgdGVybWluYWxgIGFuZCBgcmVuZGVyYC5cbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgY29uc3QgbiA9IHRhaWwuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgIGZyYW1lSGFzSWQgPSB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobik7XG4gICAgICAgIHJldHVybiBuO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBEMTogYSB0YWlsIHRoYXQgZ2l2ZXMgdXAgb24gZmluZGluZyBpdHMgc2Vzc2lvbiBpcyB3YXRjaGluZyBhXG4gICAgICAgIC8vIHNlc3Npb24gdGhhdCBpcyBnb25lIOKAlCB3aGV0aGVyIHRoaXMgcHJvY2VzcyBldmVyIHJlYWNoZWQgaXQgKGl0c1xuICAgICAgICAvLyBwb2ludGVyIHZhbmlzaGVkKSBvciBpdCB3YXMgcmUtYXJtZWQgYXQgb25lIHRoYXQgY2xvc2VkIGluIHRoZSBnYXAuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBlbmQgPT09IG51bGwpIGVuZCA9IFwiY2xvc2VkXCI7XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaC5tb2RlID09PSBcIm9uY2VcIiAmJiBhY2NlcHRlZCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIG9uQ29tbWVudDogKHRleHQpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICByZXR1cm4gdGFpbC5vbkNvbW1lbnQ/Lih0ZXh0KSA/PyBudWxsO1xuICAgICAgfSxcbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwub25EaXNjb25uZWN0Py4oaW5mbykgPz8gbnVsbDtcbiAgICAgICAgaWYgKGluZm8uY2F1c2UgPT09IFwiY29ubmVjdC1mYWlsZWRcIikge1xuICAgICAgICAgIHJlZnVzYWxzICs9IDE7XG4gICAgICAgICAgaWYgKGVuZE9uTG9zdCAmJiByZWZ1c2FscyA+PSBMT1NUX0FGVEVSX1JFRlVTQUxTKSBmaW5pc2goXCJsb3N0XCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRoZSBkYWVtb24gYW5zd2VyZWQgKGEgc3RhdHVzLCBvciBhIHN0cmVhbSB0aGF0IG9wZW5lZCBhbmQgdGhlblxuICAgICAgICAgIC8vIGVuZGVkKTogaXQgaXMgYWxpdmUsIHNvIHRoZSByZWZ1c2FscyB3ZXJlIG5vdCBpbiBhIHJvdy5cbiAgICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgb25FbmQ6IChzKSA9PiB7XG4gICAgICAgIGN1cnNvciA9IHMuY3Vyc29yO1xuICAgICAgICBlcG9jaCA9IHMuZXBvY2ggPz8gdW5kZWZpbmVkO1xuICAgICAgICB0YWlsLm9uRW5kPy4ocyk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGxpbmUgPSBoYW5kb2ZmKFxuICAgICAge1xuICAgICAgICBlbmQ6IGVuZCA/PyBcInN0b3BwZWRcIixcbiAgICAgICAgbW9kZTogaC5tb2RlLFxuICAgICAgICBldmVudHMsXG4gICAgICAgIGN1cnNvcixcbiAgICAgICAgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pLFxuICAgICAgICBwcmVzZW5jZTogaC5wcmVzZW5jZSxcbiAgICAgICAgc3BlbGw6IGguc3BlbGwsXG4gICAgICB9LFxuICAgICAgaC5jb21tYW5kcyxcbiAgICApO1xuICAgIGlmIChsaW5lICE9PSBudWxsKSBvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkobGluZSl9XFxuYCk7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHRhaWwuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEdyYXBldmluZSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgb2YgdGhlIHNwZWxsLCBhbmQgVEhFIE9ORSBQTEFDRSBUSEUgRU5WIElTIFJFQUQuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTSwgQU5EIEZPUiBHUkFQRVZJTkUgVEhFIFNFQU0gSVMgUkVBTCDigJQgdGhlIGZpcnN0IHRpbWVcbiAqIGluIGZvdXIgcG9ydHMgKHBsYXlib29rIEI4LCBlbnRyeS1ibG9jayBxdWVzdGlvbiAzKS4gQmVmb3JlIFBoYXNlIDYgdGhlXG4gKiBoZWFydGJlYXQgd2FzIGEgTElURVJBTCBgMzAwMGAgaW5zaWRlIGBkYWVtb24udHNgJ3MgU1NFIHN0cmVhbSwgYGlkbGVUaW1lb3V0OlxuICogMjU1YCB3YXMgYSBzZWNvbmQgbGl0ZXJhbCB0ZW4gbGluZXMgYXdheSB3aXRoIHRoZSByZWxhdGlvbnNoaXAgd3JpdHRlbiBvbmx5IGluXG4gKiBwcm9zZSwgYW5kIGBjbGkudHNgJ3MgdGFpbCBoYWQgTk8gd2F0Y2hkb2cgYXQgYWxsIOKAlCBpdCBibG9ja2VkIG9uXG4gKiBgcmVhZGVyLnJlYWQoKWAgZm9yZXZlciwgd2hpY2ggaXMgdGhlIGZhaWx1cmUgdGhlIGtpdCdzIHdhdGNoZG9nIGV4aXN0cyB0b1xuICogZW5kLiBOZWl0aGVyIGZpbGUgY291bGQgaW1wb3J0IHRoZSBvdGhlcjogdGhlIENMSSByZWFjaGluZyBpbnRvIHRoZSBkYWVtb25cbiAqIHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIEEgbW9kdWxlIHdpdGggbm8gaW1wb3J0c1xuICogYnV0IHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaCBncmFwaCwgc28gYm90aCBoYWx2ZXMgaW1wb3J0IHRoaXMgb25lLlxuICogQSB2YWx1ZSB0aGF0IGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICpcbiAqIOKblCAqKkFORCBUSEUgV0FUQ0hET0cgSVMgREVSSVZFRCBGUk9NIEdSQVBFVklORSdTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyB0aGUgcnVsZSBhc3Ryb2xhYmUgcGFpZCBmb3I6IGEgaGFyZC1jb2RlZCA0NSBzXG4gKiB3YXRjaGRvZyBhZ2FpbnN0IGFuIGVudi10dW5lZCBoZWFydGJlYXQgcHJvZHVjZWQgcmVjb25uZWN0cyBhdCArNDcuNCBzLFxuICogKzkyLjYgcyBhbmQgKzEzNy45IHMgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbiwgaGFybWxlc3Mgb25seSBiZWNhdXNlXG4gKiBhbiB1bnJlbGF0ZWQgdGhpcmQgY29uc3RhbnQgYWJzb3JiZWQgdGhlIGNodXJuLiDimqAgR3JhcGV2aW5lIGlzIHRoZSBzcGVsbCB0aGF0XG4gKiBtYWtlcyB0aGUgcG9pbnQgc2hhcnBlc3Q6IGl0IGJlYXRzIGF0ICoqMyBzKiosIGEgZmlmdGggb2YgdGhlIGhvdXNlIGRlZmF1bHQsXG4gKiBzbyBhIGNvcGllZCA0NSwwMDAgd291bGQgdG9sZXJhdGUgRklGVEVFTiBtaXNzZWQgYmVhdHMgd2hlcmUgZXZlcnkgc2libGluZ1xuICogdG9sZXJhdGVzIHRocmVlLiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb20gdGhlIGJlYXQgaXRcbiAqIGlzIHdhdGNoaW5nLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKblCAqKkFORCBcIldIQVRFVkVSIFRIRSBCRUFUIEJFQ09NRVNcIiBJUyBXSFkgVEhFIEVOViBJUyBSRVNPTFZFRCBIRVJFIEFORFxuICogTk9XSEVSRSBFTFNFIChENzUpLiBUSEUgUE9SVCBSRS1DUkVBVEVEIEFTVFJPTEFCRSdTIERFRkVDVCBJTiBUSElTIEZJTEUuKipcbiAqIENoYXB0ZXIgMiBzaGlwcGVkIGBIRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhwcm9jZXNzLmVudi5HUkFQRVZJTkVfSEVBUlRCRUFUX01TLFxuICog4oCmKWAgYXQgYGRhZW1vbi50czoxMTJgIHdoaWxlIHRoaXMgZmlsZSBrZXB0IGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYFxuICogYWdhaW5zdCB0aGUgTElURVJBTCAzLDAwMDogdGhlIGRhZW1vbidzIGJlYXQgd2FzIHR1bmFibGUgYW5kIHRoZSBDTEknc1xuICogd2F0Y2hkb2cgd2FzIG5vdCwgc28gKiphbnkgdmFsdWUgYWJvdmUgMywwMDAgYnJva2UgZXZlcnkgdGFpbC4qKiBNRUFTVVJFRCBhdFxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MjAwMDBgIGFnYWluc3QgYSBoZWFsdGh5IGRhZW1vbiwgYmVmb3JlIHRoZSByZXBhaXI6IGFcbiAqIHJlYWwgYGNsaS50cyB0YWlsYCByZS1zdWJzY3JpYmVkICoqNCB0aW1lcyBpbiAzMCBzKiogKH45IHMgYXBhcnQsIGl0cyB3YXRjaGRvZ1xuICogZmlyaW5nIGJlZm9yZSBhIHNpbmdsZSAyMCBzIGJlYXQgY291bGQgbGFuZCDigJQgKiowIGtlZXBhbGl2ZXMgYXJyaXZlZCoqKSwgYW5kXG4gKiBgL2NoYW5uZWxzL3dkL3N1YnNjcmliZXJzYCByZXBvcnRlZCBgY291bnQ6IDIsIGNvbm5lY3Rpb25zOiAyLCBuYW1lZDogMmAgZm9yXG4gKiAqKm9uZSoqIGxpdmUgdGFpbCwgYmVjYXVzZSB0aGUgYWJhbmRvbmVkIHN0cmVhbXMgYXJlIG5vdCByZWFwZWQgdW50aWwgdGhlXG4gKiBub3ctMjAgcyBiZWF0IGZhaWxzIHRvIGVucXVldWUuIFRoYXQgaXMgdGhlIGFzdHJvbGFiZSBzY2FyIHR3byBwYXJhZ3JhcGhzIHVwLFxuICogcmUtY3JlYXRlZCBpbnNpZGUgdGhlIGZpbGUgdGhhdCBkb2N1bWVudHMgaXQuICoqT25lIGhhbGYgb2YgdGhlIHBhaXIgdHVuYWJsZVxuICogYW5kIHRoZSBvdGhlciBhIGNvbnN0YW50IElTIHRoZSBkZWZlY3QqKiDigJQgdGhlIGRlcml2YXRpb24gb25seSBob2xkcyBpZiBpdFxuICogZGVyaXZlcyBmcm9tIHRoZSB2YWx1ZSB0aGF0IGFjdHVhbGx5IHNoaXBwZWQuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICogYHByb2Nlc3MuZW52YCBpcyBub3Qgc3VjaCBhbiBpbXBvcnQ6IGl0IGlzIGFtYmllbnQgaW4gYm90aCBoYWx2ZXMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHdoeSB0aGlzIGZpbGUg4oCUIGFuZCBub3QgYGRhZW1vbi50c2Ag4oCUIGNhbiBob2xkIHRoZSByZXNvbHV0aW9uLiAoVGhpc1xuICogaXMgYm91bnR5J3Mgc2hhcGUsIHVuY2hhbmdlZDogYHNyYy9ib3VudHkvYmFja2VuZC9oZWFydGJlYXQudHNgIHJlc29sdmVzXG4gKiBgQk9VTlRZX0lETEVfVElNRU9VVF9TRUNgIGFuZCBgQk9VTlRZX0hFQVJUQkVBVF9NU2AgaW4gdGhlIHNlYW0gZmlsZSBmb3IgdGhlXG4gKiBzYW1lIHJlYXNvbi4pXG4gKi9cblxuaW1wb3J0IHtcbiAgaGVhcnRiZWF0TXMsXG4gIGlkbGVUaW1lb3V0U2VjLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEJ1bidzIG1heGltdW0sIGluIHNlY29uZHMuIEdyYXBldmluZSdzIG93biBtZWFzdXJlZCB2YWx1ZSwgbm90IGFuIGluaGVyaXRlZFxuICogb25lOiBgZGFlbW9uLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB1bmRlciBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXRcbiAqIEJ1bidzIGRlZmF1bHQgMTAgcyBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZSB0aGUga2VlcGFsaXZlIHRoYXQgd2FzXG4gKiBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzIOKAlCBhbmQgdGhhdCBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiwgaXQgaXMgdGhlXG4gKiBkZWZhdWx0LlxuICpcbiAqIOKaoCBgR1JBUEVWSU5FX0lETEVfVElNRU9VVF9TRUNgIGlzIGFjY2VwdGVkIHNvIHRoZSBQQUlSIGNhbiBiZSB0dW5lZCB0b2dldGhlcixcbiAqIGFuZCB0aGUgY2xhbXAgYmVsb3cgaXMgd2hhdCBrZWVwcyB0aGVtIGEgcGFpci4gKFRoaXMgZmlsZSB1c2VkIHRvIHNheVxuICogZ3JhcGV2aW5lIFwiZG9lcyBub3QgZW52LXR1bmUgaXRcIiB3aGlsZSBgZGFlbW9uLnRzYCBlbnYtdHVuZWQgaXQgdGVuIGxpbmVzIGZyb21cbiAqIHdoZXJlIGl0IGltcG9ydGVkIHRoaXMgY29uc3RhbnQg4oCUIHRoZSBzYW1lIG9uZS1oYWxmLXR1bmFibGUgc3BsaXQgYXMgdGhlIGJlYXQsXG4gKiBhbmQgY29ycmVjdGVkIGluIHRoZSBzYW1lIGNoYXB0ZXIuKVxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSURMRV9USU1FT1VUX1NFQyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4pO1xuXG4vKipcbiAqIFRoZSBTU0Uga2VlcGFsaXZlLCBpbiBtcyDigJQgdGhlIERFRkFVTFQsIGJlZm9yZSB0aGUgZW52IGlzIGNvbnN1bHRlZC5cbiAqIOKaoCAqKjMgcywgYW5kIGl0IGlzIE5PVCB0aGUgaG91c2UgZGVmYXVsdCBvZiAxNSBzKiog4oCUIGdyYXBldmluZSBpcyB0aGUgb25seVxuICogc3BlbGwgaW4gdGhlIHJvc3RlciB0aGF0IGJlYXRzIHRoaXMgZmFzdCwgYW5kIHRoZSBudW1iZXIgaXMgbG9hZC1iZWFyaW5nXG4gKiByYXRoZXIgdGhhbiBpbmNpZGVudGFsOiB0aGUgYmVhdCBpcyBhbHNvIGdyYXBldmluZSdzIGRlYWQtc3Vic2NyaWJlciBwcm9iZS4gQVxuICogdGFpbCB3aG9zZSBzb2NrZXQgaGFzIGdvbmUgYXdheSBpcyBkaXNjb3ZlcmVkIHdoZW4gdGhlIGVucXVldWUgZmFpbHMsIGFuZFxuICogdW50aWwgaXQgaXMgZGlzY292ZXJlZCBgd2hvYCwgYC9wcmVzZW5jZWAgYW5kIGV2ZXJ5IHNlbmQncyByZWNpcGllbnQgY291bnRcbiAqIHJlcG9ydCBhIGdob3N0LiBFdmVyeSBvdGhlciBzcGVsbCdzIGhlYXJ0YmVhdCBvbmx5IGhhcyB0byBrZWVwIGEgY29ubmVjdGlvblxuICogb3BlbjsgdGhpcyBvbmUgYWxzbyBoYXMgdG8ga2VlcCBhIFJPU1RFUiBob25lc3QsIHdoaWNoIGlzIGEgaHVtYW4tdmlzaWJsZVxuICogbnVtYmVyIGluIHRoZSB3YXRjaCBzdXJmYWNlLiDim5QgKipTbyByYWlzaW5nIHRoaXMga25vYiBtYWtlcyBwcmVzZW5jZVxuICogc3RhbGVyLCBub3QganVzdCBxdWlldGVyKiog4oCUIGl0IGlzIHRoZSBvbmUgdGhpbmcgYW4gb3BlcmF0b3IgdHVuaW5nIGl0IHNob3VsZFxuICoga25vdy5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyA9IDNfMDAwO1xuXG4vKipcbiAqIFRoZSBiZWF0IGFzIGl0IHdpbGwgYWN0dWFsbHkgYmUgdXNlZCwgZW52LXJlc29sdmVkIGFuZCBjbGFtcGVkIGF0IGJvdGggZW5kcyBieVxuICogdGhlIGtpdDogbmV2ZXIgYWJvdmUgYElETEVfVElNRU9VVF9TRUMgLyAyYCAob3IgQnVuIGNsb3NlcyB0aGUgY29ubmVjdGlvbiB0aGVcbiAqIGtlZXBhbGl2ZSB3YXMgcHJlc2VydmluZyksIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiDim5QgVEhFIEZMT09SIElTIE5PVCBERUNPUkFUSU9OIChENzYpLiBgaW50T3JgIHBhcnNlcyB3aXRoIGBwYXJzZUludGAsIHdoaWNoXG4gKiByZWFkcyBgXCIxZTlcImAg4oCUIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXQgaHVnZVwiIOKAlCBhcyAqKjEqKi5cbiAqIERyaXZlbiBiZWZvcmUgdGhlIGZsb29yIGV4aXN0ZWQ6IGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41MjhcbiAqIGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCDihpIgMyBtcyBhbmRcbiAqIGBcIjVhYmNcImAg4oaSIDUgbXMgYXJyaXZlIHRoZSBzYW1lIHdheS4gVGhlIGZsb29yIGxpdmVzIGluIHRoZSBraXQnc1xuICogYGhlYXJ0YmVhdE1zYCBiZXNpZGUgdGhlIGNlaWxpbmcgaXQgY2Fubm90IGNyb3NzLCBOT1QgaW4gYGludE9yYCwgd2hpY2ggZXZlcnlcbiAqIG90aGVyIGtub2IgaW4gdGhlIGhvdXNlIHNoYXJlcy5cbiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hFQVJUQkVBVF9NUyxcbiAgSURMRV9USU1FT1VUX1NFQyxcbiAgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TLFxuKTtcblxuLyoqXG4gKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzLCBERVJJVkVELiA5LDAwMCBtcyBhdCB0aGUgZGVmYXVsdC5cbiAqXG4gKiDim5QgKipUSEUgVEFJTCBIQUQgTk8gV0FUQ0hET0cgQVQgQUxMIEJFRk9SRSBUSElTLioqIGBjbWRUYWlsYCdzIGlubmVyIGxvb3BcbiAqIGF3YWl0ZWQgYHJlYWRlci5yZWFkKClgIHdpdGggbm90aGluZyBib3VuZGluZyBpdCwgc28gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyXG4gKiBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIEZPUkVWRVIg4oCUIGFuZFxuICogYSBwYXJrZWQgdGFpbCBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgcXVpZXQgY2hhbm5lbCwgd2hpY2ggaXMgdGhlIHN0YXRlXG4gKiBncmFwZXZpbmUncyBjYWxsZXJzIHNwZW5kIG1vc3Qgb2YgdGhlaXIgdGltZSBpbi5cbiAqXG4gKiDimqAgOSBzIGlzIGFnZ3Jlc3NpdmUgYnkgaG91c2Ugc3RhbmRhcmRzICg0NSBzIGV2ZXJ5d2hlcmUgZWxzZSkgYW5kIHRoYXQgaXMgdGhlXG4gKiBkZXJpdmF0aW9uIHdvcmtpbmcsIG5vdCBhIG1pc3Rha2U6IGl0IGlzIHRocmVlIG9mIFRISVMgc3BlbGwncyBiZWF0cy4gSG9sZGluZ1xuICogdGhlIGNvbm5lY3Rpb24gb3BlbiBJUyBhIHRhaWwncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHNcbiAqIGEgbmFtZSBpbiBhIGh1bWFuJ3Mgcm9zdGVyIOKAlCB3aGljaCBpcyB3aHkgaXQgaXMgdGhyZWUgYmVhdHMgYW5kIG5vdCB0d28uXG4gKlxuICog4puUIERFUklWRUQgRlJPTSBUSEUgUkVTT0xWRUQgQkVBVCwgTkVWRVIgRlJPTSBUSEUgREVGQVVMVC4gSXQgaXNcbiAqIGBTU0VfSEVBUlRCRUFUX01TYCBhYm92ZSBhbmQgbm90IGBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVNgIG9uIHB1cnBvc2U7IHRoZVxuICogcmVwYWlyIGNoYXB0ZXIgaXMgd2hhdCB0aGUgZGlmZmVyZW5jZSBjb3N0LlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFpQkE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBUUE7QUFD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S0FDRCxFQUFFLFlBQVksTUFBTSxJQUFJLFdBQVcsTUFBTSxJQUFJO0FBQUEsSUFDOUMsT0FBTyxHQUFHO0FBQUEsSUFDVixJQUFJLEVBQUUsYUFBYTtBQUFBLE1BQWEsTUFBTTtBQUFBLElBQ3RDLEtBQUksRUFBRSxTQUFTLFNBQVMsRUFBRSxLQUFLO0FBQUE7QUFBQSxFQU9qQyxNQUFNLFdBQVcsS0FBSyxZQUFZLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFO0FBQUEsRUFDNUQsTUFBTSxXQUFXLEtBQUssWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFBQSxFQUN4RCxJQUFJLFdBQVcsU0FBUyxVQUFVO0FBQUEsSUFDaEMsTUFBTSxVQUFVLEtBQUssWUFBWSxXQUFXO0FBQUEsSUFDNUMsS0FBSSxHQUFHLEtBQUssMkJBQTJCLFNBQVMsUUFBUSxlQUFlLFNBQVM7QUFBQSxNQUM5RSxNQUFNLFlBQVksS0FBSyxRQUFRLEtBQUssWUFDakMsSUFBSSxDQUFDLE1BQU8sRUFBRSxXQUFXLElBQUksRUFBRSxVQUFVLElBQUksRUFBRSxPQUFRLEVBQ3ZELEtBQUssR0FBRztBQUFBLElBQ2IsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUNBLElBQUksQ0FBQyxZQUFZLFdBQVcsU0FBUyxLQUFLLFlBQVksUUFBUTtBQUFBLElBQzVELEtBQ0UsR0FBRyxLQUFLLDZCQUE2QixLQUFLLFVBQVUsV0FBVyxLQUFLLFlBQVksT0FBTyxLQUN2RixTQUNBO0FBQUEsTUFDRSxNQUFNLFlBQVksS0FBSyxRQUNyQixLQUFLLFlBQVksSUFBSSxDQUFDLE1BQU8sRUFBRSxXQUFXLElBQUksRUFBRSxVQUFVLElBQUksRUFBRSxPQUFRLEVBQUUsS0FBSyxHQUFHLEtBQ2xGO0FBQUEsSUFFSixDQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTSxVQUFVLE1BQU0sS0FBSyxJQUFJLFlBQVksS0FBSztBQUFBLEVBQ2hELE9BQU8sT0FBTyxZQUFZLFdBQVcsVUFBVTtBQUFBO0FBa0JqRCxlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELGtCQUFrQixLQUFLLE1BQU0sSUFBSTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxTQUFTLElBQUk7QUFBQSxJQUMxQixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sT0FBTyxlQUFlLENBQUM7QUFBQSxJQUM3QixJQUFJLFNBQVM7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUMxQixNQUFNO0FBQUE7QUFBQTtBQWVWLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjVDNzExOEVBOUFGRjgwQTU2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
