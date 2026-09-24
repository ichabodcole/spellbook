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
      const params = opts.query?.(cursor, firstConnect) ?? {
        since: String(cursor)
      };
      const askedSince = cursor;
      let restartNoted = false;
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
                }
                epoch = next;
              }
            }
            const n = opts.cursorOf?.(ev);
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
var WINDOW_HELP = "ends itself before Monitor's 30-minute cap with a line naming the next act; a human watching a terminal keeps it open with SPELLBOOK_TAIL_WINDOW_MS=0";
var LOST_AFTER_REFUSALS = 3;
function resolveWindowMs(raw) {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WINDOW_MS;
}
var COME_BACK = (why) => `${why} To bring it back, run command; then tail the session id it prints, with no --since (a restored session starts a new event log, so the old bookmark does not apply)`;
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
      restartOnReplay: h.eventLog ?? true,
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
        tail.onEnd?.(s);
      }
    });
    const line = handoff({
      end: end ?? "stopped",
      mode: h.mode,
      events,
      cursor,
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
    ...selfCommand(),
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
    mode: "watch",
    presence: true,
    ...opts.human ? { windowMs: 0 } : {},
    eventLog: false,
    counts: (_ev, frame) => frame.event !== "subscribed",
    commands: {
      tail: ({ since: at }) => again(at),
      comeBack: () => commandLine([...selfCommand(), "doctor"])
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
        since: flags.since !== undefined ? numericFlag("tail", "since", flags.since, 0) : undefined,
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

//# debugId=DD6D4A1689B8B01D64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9ncmFwZXZpbmUvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGdyYXBldmluZSBDTEkg4oCUIHRoaW4gd3JhcHBlciBhcm91bmQgdGhlIGRhZW1vbidzIEhUVFAgc3VyZmFjZS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIGxpc3Rcbi8vICAgYnVuIGNsaS50cyBzZW5kIDxuYW1lPiAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyB0YWlsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl1cbi8vICAgYnVuIGNsaS50cyByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdXG4vLyAgIGJ1biBjbGkudHMgY2xvc2UgPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgc3RvcFxuLy8gICBidW4gY2xpLnRzIGluZm9cbi8vXG4vLyBgdGFpbGAgd3JpdGVzIGVhY2ggaW5jb21pbmcgbWVzc2FnZSBhcyBvbmUgSlNPTkwgbGluZSBvbiBzdGRvdXQuIFBpcGVcbi8vIG9yIHdyYXAgd2l0aCBNb25pdG9yLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBFcnJFeHRyYSxcbiAgdHlwZSBFcnJLaW5kLFxuICBkaWUgYXMgcmFpc2UsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHNlbGZDb21tYW5kLFxuICB0YWlsV2l0aEhhbmRvZmYsXG4gIFdJTkRPV19IRUxQLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEhhbmRvZmYudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG5jb25zdCBEQVRBX0RJUiA9IHByb2Nlc3MuZW52LkdSQVBFVklORV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5ncmFwZXZpbmVcIik7XG5jb25zdCBQT1JUX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5waWRcIik7XG5jb25zdCBIT0xEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5ob2xkXCIpO1xuLy8gUGVyc2lzdGVkIGlkZW50aXR5IGNvbmZpZyAoVjEuNykg4oCUIGBncmFwZXZpbmUgYWxpYXMgPG5hbWU+YCB3cml0ZXMgaXQ7IHRoZVxuLy8gZGFlbW9uIHNlcnZlcyBpdCB0byB0aGUgd2F0Y2ggdmlhIEdFVCAvaWRlbnRpdHkuXG5jb25zdCBDT05GSUdfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiY29uZmlnLmpzb25cIik7XG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIE5FVkVSIEEgRkxBVCBTSUJMSU5HIChwbGF5Ym9vayBCNCkuIFRoaXMgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJkYWVtb24udHNcIilgIOKAlCBnbGFtb3VyJ3MgZXhhY3Qgc2hpcHBlZCBkZWZlY3Qg4oCUIHdoaWNoIHdhc1xuLy8gdHJ1ZSBmb3IgZXhhY3RseSBhcyBsb25nIGFzIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tXG4vLyBgZGlzdC9gIHRoYXQgcmVzb2x2ZXMgdG8gYGRpc3QvZGFlbW9uLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgYW5kIG11c3Qgbm90XG4vLyBleGlzdC4gVGhlIHN5bXB0b20gaXMgbm90IGEgY3Jhc2g6IHRoZSBzcGF3biBmYWlscyBzaWxlbnRseSAodGhlIGRhZW1vbidzXG4vLyBzdGRpbyBpcyBpZ25vcmVkKSwgbm8gcG9ydCBmaWxlIGV2ZXIgYXBwZWFycywgYW5kIHRoZSAzIHMgcG9sbCBsb29wIGJlbG93XG4vLyByZXBvcnRzIGBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc2Ag4oCUIHdoaWNoIGlzIEFMU08gd2hhdCBhIGxhdW5jaGVyXG4vLyB0aGF0IGV4aXRzIGEgbGl2ZSBkYWVtb24gcmVwb3J0cyAoRDY5KSBhbmQgQUxTTyB3aGF0IGEgZGV2LW1vZGUgZGFlbW9uIGR5aW5nXG4vLyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQgcmVwb3J0cyAoc2VlIGBlbnN1cmVEYWVtb25gKS4gVGhyZWUgZGVmZWN0IGNsYXNzZXMsIG9uZVxuLy8gc2VudGVuY2U7IHRoaXMgaXMgdGhlIGZpcnN0IG9mIHRoZSB0aHJlZS5cbi8vIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgcmVzb2x2ZXMgdGhpcyBhcml0aG1ldGljIHRoZSB3YXkgdGhlXG4vLyBydW50aW1lIHdpbGwsIGZyb20gdGhlIEVNSVRURUQgZmlsZSdzIG93biBkaXJlY3RvcnksIGFuZCBhc3NlcnRzIHRoZSBmaWxlIGlzXG4vLyB0aGVyZS5cbmNvbnN0IERBRU1PTl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwiZGFlbW9uLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBUaGUgd2F0Y2ggc3VyZmFjZSBpcyBidWlsdCAoc3JjL2dyYXBldmluZS9zdXJmYWNlIOKGkiBkaXN0LykuIEJ1biByZWFkc1xuLy8gYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIGluIERFViBtb2RlIHRoZSBkYWVtb24nc1xuLy8gY3dkIE1VU1QgYmUgc3JjL2dyYXBldmluZS8gKHNlYW1zIENvbnRyYWN0IDUpIOKAlCBsYXVuY2hlZCBlbHNld2hlcmUgdGhlIGRldlxuLy8gYnVuZGxlciBjYW5ub3QgY29tcGlsZSB0aGUgc3R5bGVzaGVldCBhbmQgdGhlIHBhZ2UgZmFpbHMgKG1lYXN1cmVkIG9uXG4vLyBnbGFtb3VyOiBIVFRQIDUwMCwgbm8gc3R5bGVzaGVldCBsaW5rKS4gSW4gUkVMRUFTRSBtb2RlIGRpc3QvIGlzIHN0YXRpYyBhbmRcbi8vIHByZS1idWlsdCwgbm8gYnVuZmlnIGlzIHJlYWQsIGFuZCBzcmMvZ3JhcGV2aW5lLyBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLykg4oCUIHNvIHRoZSBjd2Qgc3RheXMgYXRcbi8vIHRoZSBza2lsbCByb290LiBTYW1lIHNoYXBlIGFzIGdsYW1vdXIncyBkYWVtb25Dd2QoKS4gRXhwb3J0ZWQgZm9yIHRlc3RzLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcImdyYXBldmluZVwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vLyDilIDilIAgRGFlbW9uIEhUVFAgcHJvdG9jb2wg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBSZXNwb25zZSBzaGFwZXMgdGhlIGRhZW1vbiBlbWl0cy4gQW55IGVuZHBvaW50IGNhbiBhbHNvIHJldHVybiBhbiBlcnJvclxuLy8gYm9keSB3aXRoIGEgNHh4LzV4eCBzdGF0dXMsIHNvIGVhY2ggY2FycmllcyBhbiBvcHRpb25hbCBgZXJyb3JgLlxuXG50eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBudW1iZXI7XG4gIGNoYW5uZWw6IHN0cmluZztcbiAgZnJvbTogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIGtpbmQ6IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIGluX3JlcGx5X3RvPzogbnVtYmVyO1xuICB0YXJnZXQ/OiBudW1iZXI7XG4gIGRpc3Bvc2l0aW9uPzogc3RyaW5nO1xuICAvLyBDaGFubmVsLWxldmVsIGxpZmVjeWNsZSBmYWN0IChhcmNoaXZlIC8gdW5hcmNoaXZlKS4gQSBraW5kOlwic3RhdHVzXCIgZnJhbWVcbiAgLy8gY2FycnlpbmcgYGV2ZW50YCBhbmQgbm8gYGRpc3Bvc2l0aW9uYCDigJQgc2VlIGlzRGlzcG9zaXRpb25GcmFtZS5cbiAgZXZlbnQ/OiBcImFyY2hpdmVkXCIgfCBcInVuYXJjaGl2ZWRcIjtcbn07XG5cbi8vIEdFVCAvIOKAlCBkYWVtb24gbGl2ZW5lc3MvaW5mby5cbnR5cGUgUm9vdEluZm8gPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgcGlkPzogbnVtYmVyO1xuICBzdGFydGVkX2F0PzogbnVtYmVyO1xuICBjaGFubmVscz86IG51bWJlcjtcbiAgZGF0YV9kaXI/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyDigJQgbWVzc2FnZSByZWNlaXB0IHdpdGggZGVsaXZlcnkgYWNjb3VudGluZy5cbnR5cGUgU2VuZFJlY2VpcHQgPSBNZXNzYWdlICYge1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgcmVjaXBpZW50cz86IG51bWJlcjtcbiAgc3Vic2NyaWJlcl9hbGlhc2VzPzogc3RyaW5nW107XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvYW5ub3VuY2Ug4oCUIGNyb3NzLWNoYW5uZWwgYnJvYWRjYXN0IHJlY2VpcHQuXG50eXBlIEFubm91bmNlUmVjZWlwdCA9IHtcbiAgb2s6IGJvb2xlYW47XG4gIGNoYW5uZWxzOiB7IG5hbWU6IHN0cmluZzsgcmVjaXBpZW50czogbnVtYmVyIH1bXTtcbiAgc2tpcHBlZDogeyBuYW1lOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH1bXTtcbiAgdG90YWxfcmVjaXBpZW50czogbnVtYmVyO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMg4oCUIGNoYW5uZWwgZGlyZWN0b3J5IGxpc3RpbmcuXG50eXBlIENoYW5uZWxTdW1tYXJ5ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gIC8vIG51bGwgPSB0aGUgZGFlbW9uIGNvdWxkIG5vdCBlc3RhYmxpc2ggYSBjb3VudCAodW5yZWFkYWJsZSBmaWxlKSwgTkVWRVIgMC5cbiAgLy8gMCBtZWFucyBcInRoaXMgY2hhbm5lbCBpcyBnZW51aW5lbHkgZW1wdHlcIiBhbmQgbm90aGluZyBlbHNlIOKAlCBiNS5cbiAgbWVzc2FnZV9jb3VudDogbnVtYmVyIHwgbnVsbDtcbiAgbGFzdF9hY3Rpdml0eTogbnVtYmVyO1xuICBsb2FkZWQ6IGJvb2xlYW47XG59O1xudHlwZSBDaGFubmVsc1Jlc3BvbnNlID0geyBjaGFubmVscz86IENoYW5uZWxTdW1tYXJ5W107IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEFueSBlbmRwb2ludCBtYXkgcmVwbHkgd2l0aCBqdXN0IGFuIGVycm9yL29rIGVudmVsb3BlLlxudHlwZSBTdGF0dXNSZXNwb25zZSA9IHsgb2s/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyBhbmQgP3NpbmNlPSByYW5nZXMuXG50eXBlIE1lc3NhZ2VzUmVzcG9uc2UgPSB7IG1lc3NhZ2VzPzogTWVzc2FnZVtdOyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi93YWl0IOKAlCBsb25nLXBvbGwgYmF0Y2guXG50eXBlIFdhaXRSZXNwb25zZSA9IHtcbiAgbWVzc2FnZXM/OiBNZXNzYWdlW107XG4gIGN1cnNvcj86IG51bWJlcjtcbiAgdGltZWRfb3V0PzogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIC8vIEEgcmVmdXNhbCBuYW1lcyB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoNDA0IG9uIGEgbWlzc2luZyBjaGFubmVsKS5cbiAgaGludD86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzIOKAlCBvcGVuL2Vuc3VyZSBhIGNoYW5uZWwuXG50eXBlIE9wZW5SZXNwb25zZSA9IHtcbiAgbmFtZT86IHN0cmluZztcbiAgY3JlYXRlZF9hdD86IG51bWJlcjtcbiAgbWVzc2FnZV9jb3VudD86IG51bWJlcjtcbiAgc3Vic2NyaWJlcnM/OiBudW1iZXI7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgdW5hcmNoaXZlZD86IGJvb2xlYW47XG4gIGNsZWFyZWQ/OiBib29sZWFuO1xuICBzbmFwc2hvdD86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vdG9waWMgYW5kIFBVVCAvY2hhbm5lbHMvPG5hbWU+L3RvcGljLlxudHlwZSBUb3BpY1Jlc3BvbnNlID0ge1xuICBvaz86IGJvb2xlYW47XG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgaWQ/OiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vc3Vic2NyaWJlcnMg4oCUIHNpbmdsZS1jaGFubmVsIHJvc3Rlci5cbnR5cGUgU3Vic2NyaWJlcnNSZXNwb25zZSA9IHtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgc3Vic2NyaWJlcnM/OiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvdW50PzogbnVtYmVyO1xuICBjb25uZWN0aW9ucz86IG51bWJlcjtcbiAgbmFtZWQ/OiBudW1iZXI7XG4gIGFub255bW91cz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBlci1jaGFubmVsIHByZXNlbmNlIGVudHJ5IGZyb20gR0VUIC9wcmVzZW5jZS5cbnR5cGUgUHJlc2VuY2VDaGFubmVsID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gIG5hbWVkOiBudW1iZXI7XG4gIGFub255bW91czogbnVtYmVyO1xufTtcbnR5cGUgUHJlc2VuY2VSZXNwb25zZSA9IHsgY2hhbm5lbHM/OiBQcmVzZW5jZUNoYW5uZWxbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gU1NFIGZyYW1lcyBwdXNoZWQgb24gR0VUIC9jaGFubmVscy88bmFtZT4vdGFpbC4gVHdvIGZyYW1lIGtpbmRzIGFycml2ZSBvblxuLy8gdGhlIHNhbWUgYGRhdGE6YCBsaW5lIOKAlCBhIGBzdWJzY3JpYmVkYCBldmVudCBhbmQgcGVyLW1lc3NhZ2UgZnJhbWVzIOKAlCBzbyB0aGVcbi8vIGRlY29kZWQgcGF5bG9hZCBpcyBhIHVuaW9uLiBBbGwgZmllbGRzIG9wdGlvbmFsIGJlY2F1c2UgdGhlIGZyYW1lIGlzXG4vLyB1bnRydXN0ZWQgd2lyZSBkYXRhIG5hcnJvd2VkIGF0IHRoZSB1c2Ugc2l0ZS5cbnR5cGUgVGFpbFBheWxvYWQgPSB7XG4gIC8vIHN1YnNjcmliZWQtZXZlbnQgZmllbGRzXG4gIHNpbmNlPzogbnVtYmVyO1xuICBhcz86IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdF9pZD86IG51bWJlcjtcbiAgLy8gVHJ1ZSB3aGVuIFRISVMgc3Vic2NyaWJlIGNyZWF0ZWQgdGhlIGNoYW5uZWwg4oCUIHRoZSBzaWduYWwgdGhhdCBzZXBhcmF0ZXNcbiAgLy8gXCJxdWlldCBjaGFubmVsXCIgZnJvbSBcInlvdSB0YWlsZWQgYSBuYW1lIHRoYXQgZGlkIG5vdCBleGlzdFwiLlxuICBjcmVhdGVkPzogYm9vbGVhbjtcbiAgLy8gVHJ1ZSB3aGVuIHRoZSBjaGFubmVsIGlzIGFscmVhZHkgYXJjaGl2ZWQgKHJlYWQtb25seSkgYXQgc3Vic2NyaWJlIHRpbWUg4oCUXG4gIC8vIHRoZSBzaWduYWwgZm9yIGEgTEFURSBqb2luZXIsIHdobyB3b3VsZCBvdGhlcndpc2UgbGVhcm4gaXQgZnJvbSBhIHJlamVjdGVkXG4gIC8vIHNlbmQuIFRoZSBsaWZlY3ljbGUgZnJhbWUgb25seSByZWFjaGVzIGFuIGFnZW50IHRoYXQgd2FzIGNvbm5lY3RlZCBhdCB0aGVcbiAgLy8gbW9tZW50LCBvciB0aGF0IHB1bGxzIGhpc3RvcnkuXG4gIGFyY2hpdmVkPzogYm9vbGVhbjtcbiAgLy8gbWVzc2FnZSBmaWVsZHNcbiAgaWQ/OiBudW1iZXI7XG4gIGZyb20/OiBzdHJpbmc7XG4gIHRleHQ/OiBzdHJpbmc7XG4gIHRzPzogbnVtYmVyO1xuICBraW5kPzogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgLy8gc2hhcmVkXG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIE91ciBwbHVnaW4gdmVyc2lvbiAoZnJvbSBwbHVnaW4uanNvbikuIFVzZWQgdG8gZGV0ZWN0IGNhY2hlLXBpbm5pbmdcbi8vIG1pc21hdGNoZXMgd2hlbiB3ZSB0YWxrIHRvIGEgZGFlbW9uIHNwYXduZWQgZnJvbSBhIGRpZmZlcmVudCBjYWNoZWRcbi8vIHBhdGguIEJlc3QtZWZmb3J0OyBudWxsIGlmIHJlYWQgZmFpbHMuXG5mdW5jdGlvbiByZWFkUGx1Z2luVmVyc2lvbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbHVnaW5Kc29uUGF0aCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwbHVnaW5Kc29uUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpLnZlcnNpb24gPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmNvbnN0IFBMVUdJTl9WRVJTSU9OID0gcmVhZFBsdWdpblZlcnNpb24oKTtcblxuLy8gT25lLXNob3QgdmVyc2lvbi1taXNtYXRjaCBjaGVjay4gVGhlIGRhZW1vbiBtYXkgYmUgZnJvbSBhIGRpZmZlcmVudFxuLy8gY2FjaGVkIHBsdWdpbiBwYXRoIHRoYW4gdGhpcyBDTEkgKGV4aXN0aW5nIHRhaWwgcHJvY2Vzc2VzJyBhdXRvLXJlY29ubmVjdFxuLy8gY2FuIHJhY2UgYSBgc3RvcGAgYW5kIHJlc3Bhd24gdGhlIG9sZCBkYWVtb24pLiBXYXJuIG9uY2UgcGVyIGludm9jYXRpb25cbi8vIHNvIHRoZSB1c2VyIGhhcyBhIHNpZ25hbCBpbnN0ZWFkIG9mIHNpbGVudGx5IGRlZ3JhZGVkIGJlaGF2aW9yLlxubGV0IF92ZXJzaW9uQ2hlY2tEb25lID0gZmFsc2U7XG5hc3luYyBmdW5jdGlvbiBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0OiBudW1iZXIpIHtcbiAgaWYgKF92ZXJzaW9uQ2hlY2tEb25lKSByZXR1cm47XG4gIF92ZXJzaW9uQ2hlY2tEb25lID0gdHJ1ZTtcbiAgaWYgKCFQTFVHSU5fVkVSU0lPTikgcmV0dXJuOyAvLyBjYW4ndCBjb21wYXJlIGlmIHdlIGRvbid0IGtub3cgb3VyIG93biB2ZXJzaW9uXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICB9KTtcbiAgICBpZiAoIXJlcy5vaykgcmV0dXJuO1xuICAgIGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gICAgY29uc3QgZGFlbW9uVmVyc2lvbiA9IGRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAoZGFlbW9uVmVyc2lvbiA9PT0gbnVsbCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIGlzIG9sZGVyIHRoYW4gdGhpcyBDTEkgKG5vIHZlcnNpb24gcmVwb3J0ZWQpLiBgICtcbiAgICAgICAgICBgQ0xJIGlzIHYke1BMVUdJTl9WRVJTSU9OfS4gU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gYCArXG4gICAgICAgICAgYFJlc3RhcnQgdGhlIGRhZW1vbiAoZHJvcCB0YWlscywgdGhlbiBcXGBzdG9wXFxgLCB0aGVuIGFueSB2ZXJiKSB0byB1cGdyYWRlLlxcbmAsXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZGFlbW9uVmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT04pIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBncmFwZXZpbmU6IGRhZW1vbiB2ZXJzaW9uICh2JHtkYWVtb25WZXJzaW9ufSkgZGlmZmVycyBmcm9tIENMSSB2ZXJzaW9uICh2JHtQTFVHSU5fVkVSU0lPTn0pLiBgICtcbiAgICAgICAgICBgU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduLlxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxufVxuLy8gR1JBUEVWSU5FX0ZST00gc2V0cyB0aGUgZGVmYXVsdCAtLWZyb20gLyAtLWFzIGFsaWFzIHNvIGFnZW50cyBkb24ndCBoYXZlXG4vLyB0byByZXBlYXQgdGhlaXIgaWRlbnRpdHkgb24gZXZlcnkgdmVyYi4gUGVyLXZlcmIgZmxhZ3Mgc3RpbGwgb3ZlcnJpZGUuXG5jb25zdCBERUZBVUxUX0FMSUFTID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0ZST00gPz8gdW5kZWZpbmVkO1xuXG4vLyBJZGVudGl0eSBmbGFncyBhcmUgaW50ZXJjaGFuZ2VhYmxlIGFjcm9zcyB2ZXJicy4gYHNlbmRgIGhpc3RvcmljYWxseSB0b29rXG4vLyBgLS1mcm9tYCB3aGlsZSBgdGFpbGAvYHdhaXRgIHRvb2sgYC0tYXNgIOKAlCBzYW1lIGNvbmNlcHQgKHdobyBhbSBJKSwgYW5kIHRoZVxuLy8gYXN5bW1ldHJ5IHRyaXBzIHlvdSBtaWQtZmxvdy4gQWNjZXB0IGVpdGhlciBldmVyeXdoZXJlIGlkZW50aXR5IGlzIG1lYW50LFxuLy8gZmFsbGluZyBiYWNrIHRvIEdSQVBFVklORV9GUk9NLiAoZ3JlcCdzIGAtLWZyb21gIGlzIGEgZGlmZmVyZW50IHRoaW5nIOKAlCBhblxuLy8gYXV0aG9yICpmaWx0ZXIqLCBub3QgaWRlbnRpdHkg4oCUIHNvIGl0IGRvZXNuJ3QgdXNlIHRoaXMuKVxuZnVuY3Rpb24gcmVzb2x2ZUFsaWFzKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiAoZmxhZ3MuZnJvbSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IChmbGFncy5hcyBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IERFRkFVTFRfQUxJQVM7XG59XG4vLyBUcnVuY2F0aW9uLWhpbnQgdGhyZXNob2xkLiBNZXNzYWdlcyBsb25nZXIgdGhhbiB0aGlzIGdldCBhIGB0cnVuY2F0aW9uX2hpbnRgXG4vLyBmaWVsZCBvbiB0aGUgdGFpbCBKU09OIHNvIGNvbnN1bWVycyAoZS5nLiBNb25pdG9yKSBrbm93IHRoZSBub3RpZmljYXRpb25cbi8vIHByZXZpZXcgaXMgaW5jb21wbGV0ZSBhbmQgc2hvdWxkIGByZWFkYCB0aGUgZnVsbCBib2R5LiBJbiBhZ2VudC10by1hZ2VudFxuLy8gdHJhZmZpYywgbG9uZyBtZXNzYWdlcyBhcmUgdGhlIE5PUk0gKHRoZSBWMS42IHJvdW5kdGFibGUgc2F3IG1vc3Qgc3Vic3RhbnRpdmVcbi8vIG1lc3NhZ2VzIGV4Y2VlZCA4MDApLCBzbyBhbiA4MDAgZGVmYXVsdCBmaXJlZCBvbiBuZWFybHkgZXZlcnl0aGluZyBhbmQgdGhlXG4vLyByZWNvdmVyeSBwYXRoIGJlY2FtZSB0aGUgbWFpbiBwYXRoLiBEZWZhdWx0IHJhaXNlZCB0byAyMDAwIHNvIHRoZSBoaW50IG1hcmtzXG4vLyB0aGUgZ2VudWluZWx5LWxvbmcgb3V0bGllcnMuIE92ZXJyaWRhYmxlIHZpYSBlbnYgdmFyIGZvciB0dW5pbmcuXG5jb25zdCBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID0gcGFyc2VJbnQoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9UUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID8/IFwiMjAwMFwiLFxuICAxMCxcbik7XG5cbi8vIE9wdGlvbmFsIGlubGluZS1ib2R5IGNhcCBmb3IgYHRhaWxgIChvcHQtaW4gdmlhIC0tbWF4IDxuPiBvciBHUkFQRVZJTkVfVEFJTF9NQVgpLlxuLy8gV2hlbiBzZXQsIGEgYm9keSBsb25nZXIgdGhhbiB0aGUgY2FwIGlzIHRydW5jYXRlZCB0byBgbmAgY2hhcnMgaW4gdGhlIHRhaWxcbi8vIGZyYW1lIChwbHVzIHRoZSByZWFkLXBvaW50ZXIgaGludCksIHNvIGEgcHVzaCBjb25zdW1lciBjYW4gaGFuZCBpdHNcbi8vIG5vdGlmaWNhdGlvbiBzdXJmYWNlIGEgZGVsaWJlcmF0ZWx5LXNpemVkIGxpbmUuIFRoZSBGVUxMIG1lc3NhZ2UgaXMgYWx3YXlzXG4vLyByZXRyaWV2YWJsZSB2aWEgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLiBVbmRlZmluZWQgPSBubyBjYXAgKGZ1bGwgdGV4dCBpbmxpbmUg4oCUXG4vLyB0b2RheSdzIGRlZmF1bHQpLiBOb3RlOiB0aGUgaGFyZCBjbGlwIGEgY29uc3VtZXIgdWx0aW1hdGVseSBzZWVzIGlzIHN0aWxsIHRoZVxuLy8gTW9uaXRvci9ub3RpZmljYXRpb24gbGF5ZXInczsgLS1tYXggb25seSBib3VuZHMgdGhlIGxpbmUgZ3JhcGV2aW5lIGVtaXRzLlxuLy8gUmVqZWN0cyBuZWdhdGl2ZSAvIG5vbi1udW1lcmljLlxuZnVuY3Rpb24gcmVzb2x2ZVRhaWxNYXgoZmxhZzogdW5rbm93bik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBmbGFnID09PSBcInN0cmluZ1wiID8gZmxhZyA6IHByb2Nlc3MuZW52LkdSQVBFVklORV9UQUlMX01BWDtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdywgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPj0gMCA/IG4gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlIOKAlCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2AncyBgZGllYCwgdW5kZXIgdGhpc1xuICogc3BlbGwncyBvd24gbmFtZSBzbyA0NiBjYWxsIHNpdGVzIGRpZCBub3QgZWFjaCBoYXZlIHRvIGJlIHJlLXNwZWxsZWQuXG4gKlxuICog4puUICoqSVQgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBBIENBTExFUi1WSVNJQkxFIENIQU5HRSoqXG4gKiAoUGhhc2UgNiBjaGFwdGVyIDI7IHRoZSBkZWx0YSBpcyBkcml2ZW4gYW5kIHJlY29yZGVkIGluIHRoZSBqb3VybmFsKS4gVGhpc1xuICogZnVuY3Rpb24gd2FzIGBwcm9jZXNzLnN0ZGVyci53cml0ZShcXGBncmFwZXZpbmU6ICR7bXNnfVxcblxcYCk7IHByb2Nlc3MuZXhpdChjb2RlKWBcbiAqIOKAlCBQUk9TRSBhdCBleGl0IDIgZm9yIGV2ZXJ5IGZhaWx1cmUgZ3JhcGV2aW5lIGNvdWxkIHByb2R1Y2UsIHdpdGggdHdvIHNpdGVzXG4gKiBwYXNzaW5nIDEuIEFmdGVyIHRoZSBhZG9wdGlvbiBpdCBpcyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIHRoZVxuICogYWNjIHRheG9ub215J3MgY29kZXM6IHVzYWdlIDIsIGludGVybmFsIDEsIG5vdF9mb3VuZCA1LCBjb25mbGljdCA2LiBBbiBhZ2VudFxuICogcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZTsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbiBhbmQgcmV3b3JkaW5nXG4gKiBpdCBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkaWQgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlZCBwcm9zZS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIEVOVU1FUkFUSU9OUyBNT1ZFRCBGUk9NIFBST1NFIElOVE8gYGNob2ljZXNgLioqIGdyYXBldmluZSdzXG4gKiByZWplY3Rpb25zIHdlcmUgc2hhcGVkIGZvciBhY2MncyBmbGFnLXNldCBleHRyYWN0b3JzIOKAlCBgcmVjb2duaXplZCBmbGFnczogLS1hXG4gKiAtLWJgLCB3aXRoIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdCBhIHF1YWxpZmllciBiZXR3ZWVuIHRoZSBub3VuIGFuZCB0aGUgY29sb25cbiAqIFwicmVhZHMgYXMgcHJvc2UsIG5vdCBhIHNldFwiLiBXcmFwcGVkIGluIEpTT04gdGhhdCBtYXJrZXIgYmVjb21lcyBhIHN1YnN0cmluZyBvZlxuICogYW4gZXNjYXBlZCBzdHJpbmcsIHNvIGl0IGRvZXMgbm90IHN0YXkgaW4gcHJvc2U6IGV2ZXJ5IGVudW1lcmF0aW9uIGlzIG5vdyBhXG4gKiBgY2hvaWNlc2AgYXJyYXksIHdoaWNoIGlzIHdoYXQgZ2xhbW91ciAoQ09ORk9STUFOVCBMMCkgcHVibGlzaGVzIGFuZCB3aGF0IHRoZVxuICogZW52ZWxvcGUgaGFzIGEgZmllbGQgZm9yLiBUaGUgcnVubmFibGUgcmVjb3Zlcnkg4oCUIGB0cnk6IGJ1biDigKYvY2xpLnRzIG9wZW4geGAg4oCUXG4gKiBtb3ZlZCBpbnRvIGBoaW50YCBmb3IgdGhlIHNhbWUgcmVhc29uLCBhbmQgYSBjYWxsZXIgbm93IHJlYWRzIGEgZmllbGQgaW5zdGVhZFxuICogb2Ygc3BsaXR0aW5nIGEgc2VudGVuY2UuXG4gKlxuICog4pqgIGBkaWVgIGlzIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgc3dhbGxvd3MsIGFuZCB0aGF0IGlzXG4gKiBub3cgYSBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4gQXVkaXRlZCBieSBjYWxsIGdyYXBoIGF0IHRoZVxuICogYWRvcHRpb24gKHBsYXlib29rIEI5KTsgdGhlIGNvdW50IGlzIGluIHRoZSBqb3VybmFsLlxuICovXG5mdW5jdGlvbiBkaWUobXNnOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHJhaXNlKG1zZywga2luZCwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFRoZSB0YXhvbm9teSBga2luZGAgZm9yIGFuIEhUVFAgc3RhdHVzIHRoZSBkYWVtb24gYW5zd2VyZWQgd2l0aC5cbiAqXG4gKiDim5QgT05FIE1BUFBJTkcsIE5PVCBBIEpVREdFTUVOVCBQRVIgU0lURS4gVHdlbnR5IG9mIGdyYXBldmluZSdzIHJhaXNlIHNpdGVzXG4gKiBhcmUgXCJ0aGUgZGFlbW9uIHNhaWQgbm9cIjsgYmVmb3JlIHRoZSBhZG9wdGlvbiBldmVyeSBvbmUgb2YgdGhlbSBjb2xsYXBzZWQgdG9cbiAqIGV4aXQgMiwgc28gYSBtaXNzaW5nIGNoYW5uZWwsIGEgbGl2ZS1zZXNzaW9uIHJlZnVzYWwgYW5kIGEgYnJva2VuIGRhZW1vbiB3ZXJlXG4gKiBvbmUgbnVtYmVyIHRvIGFuIGFnZW50LiBUaGUgZGFlbW9uIGFscmVhZHkgZGlzdGluZ3Vpc2hlcyB0aGVtIGJ5IHN0YXR1cyDigJRcbiAqIDQwNCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QsIDQwOSBmb3IgYXJjaGl2ZWQgLyBsaXZlIC8gYWxyZWFkeS1vcGVuXG4gKiDigJQgc28gdGhlIG1hcHBpbmcgaXMgYSByZS1yZWFkaW5nIG9mIHdoYXQgd2FzIG9uIHRoZSB3aXJlLCBub3QgYSBuZXcgb3Bpbmlvbi5cbiAqL1xuZnVuY3Rpb24ga2luZEZvclN0YXR1cyhzdGF0dXM6IG51bWJlcik6IEVycktpbmQge1xuICBpZiAoc3RhdHVzID09PSA0MDQpIHJldHVybiBcIm5vdF9mb3VuZFwiO1xuICBpZiAoc3RhdHVzID09PSA0MDkpIHJldHVybiBcImNvbmZsaWN0XCI7XG4gIGlmIChzdGF0dXMgPj0gNDAwICYmIHN0YXR1cyA8IDUwMCkgcmV0dXJuIFwidXNhZ2VcIjtcbiAgcmV0dXJuIFwiaW50ZXJuYWxcIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZERhZW1vblBvcnQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKFBPUlRfRklMRSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChyYXcsIDEwKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIC8vIEZpcmUtYW5kLWZvcmdldCBtaXNtYXRjaCBjaGVjayAod29uJ3QgYmxvY2sgdGhlIHZlcmIpLlxuICAgICAgbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydCk7XG4gICAgICByZXR1cm4gcG9ydDtcbiAgICB9XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RhbGUg4oCUIGNsZWFuIHVwLlxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUE9SVF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUElEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBob2xkQWN0aXZlKCk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB1bnRpbCA9IHBhcnNlSW50KHJlYWRGaWxlU3luYyhIT0xEX0ZJTEUsIFwidXRmLThcIikudHJpbSgpLCAxMCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh1bnRpbCkgJiYgdW50aWwgPiBEYXRlLm5vdygpKSByZXR1cm4gdW50aWw7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9IGNhdGNoIHt9IC8vIGV4cGlyZWQg4oaSIGNsZWFuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgZnVuY3Rpb24gcmVsZWFzZUhvbGQoKSB7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgaWYgKGhvbGRBY3RpdmUoKSlcbiAgICBkaWUoXG4gICAgICBcImRhZW1vbiBpcyBoZWxkIChyZXNwYXduIHN1cHByZXNzZWQpIOKAlCB3YWl0IGZvciB0aGUgaG9sZCB0byBjbGVhciBvciBydW4gYGdyYXBldmluZSByb2xsYFwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIC8vIENoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzogdGhlIGRhZW1vbidzIHN0ZGlvIGlzIGlnbm9yZWQsIHNvIGFcbiAgLy8gZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydCB3b3VsZCBvdGhlcndpc2Ugc3VyZmFjZSBvbmx5IGFzXG4gIC8vIFwiZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiIOKAlCBhbmQgbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgRU5PRU5UIG9uXG4gIC8vIHRoZSBleGVjdXRhYmxlLCB3aGljaCByZWFkcyBhcyBcImJ1biBpcyBtaXNzaW5nXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBncmFwZXZpbmUgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH0uIGAgK1xuICAgICAgICBcIk5vIGRpc3QvaW5kZXguaHRtbCB3YXMgZm91bmQgKG9yIFNQRUxMQk9PS19TVVJGQUNFX01PREU9ZGV2IGlzIHNldCksIHNvIHRoZSBkYWVtb24gXCIgK1xuICAgICAgICBcIm11c3QgcnVuIGZyb20gc3JjL2dyYXBldmluZS8gdG8gYnVuZGxlIHRoZSB3YXRjaCBzdXJmYWNlLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgXCIgK1xuICAgICAgICBcImRvZXMgbm90IGhhdmUuIEVpdGhlciB0aGUgc2hpcHBlZCBkaXN0LyBpcyBtaXNzaW5nIChyZWluc3RhbGwgdGhlIHNwZWxsKSBvciB5b3UgYXJlIGluIFwiICtcbiAgICAgICAgXCJhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dyYXBldmluZS8uXCIsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgKTtcbiAgfVxuICAvLyBTcGF3biBkZXRhY2hlZCBzbyB0aGUgZGFlbW9uIHN1cnZpdmVzIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdC5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtEQUVNT05fU0NSSVBUXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2QsXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFdhaXQgdXAgdG8gM3MgZm9yIHRoZSBwb3J0IGZpbGUgdG8gYXBwZWFyIGFuZCByZXNwb25kLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIH1cbiAgZGllKFwiZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiwgXCJpbnRlcm5hbFwiLCB7XG4gICAgaGludDpcbiAgICAgIFwidGhyZWUgdW5yZWxhdGVkIGNhdXNlcyByZXBvcnQgdGhpcyBvbmUgc2VudGVuY2U6IHRoZSBkYWVtb24ncyBsYXVuY2hlciBzaGFwZSwgXCIgK1xuICAgICAgXCJhIHdyb25nIHNwYXduIHBhdGgsIGFuZCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQuIFwiICtcbiAgICAgIFwiUnVuIHRoZSBkYWVtb24gbGF1bmNoZXIgYWxvbmUgdG8gdGVsbCB0aGVtIGFwYXJ0IOKAlCBpdCBpcyB0aGUgbGF1bmNoZXIgc2hhcGUgXCIgK1xuICAgICAgXCJpZmYgaXQgcHJpbnRzIGBsaXN0ZW5pbmcgb24g4oCmYCBhbmQgcmV0dXJucyBhdCBleGl0IDAuIEFuIGVtcHR5IFwiICtcbiAgICAgIFwiR1JBUEVWSU5FX0hPTUUgKG5vIGBjaGFubmVscy9gKSBtZWFucyB0aGUgZGFlbW9uIG5ldmVyIGJvdW5kIGF0IGFsbC5cIixcbiAgfSk7XG59XG5cbi8vIEdlbmVyaWMgb3ZlciB0aGUgZXhwZWN0ZWQgc3VjY2VzcyBib2R5LiBgZGF0YWAgbWF5IGJlIG51bGwgaWYgdGhlIHJlc3BvbnNlXG4vLyBoYWQgbm8gSlNPTiBib2R5LCBzbyBjYWxsZXJzIHNlZSBgVCB8IG51bGxgLlxuYXN5bmMgZnVuY3Rpb24gYXBpPFQgPSB1bmtub3duPihcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogVCB8IG51bGwgfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IFQgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFQ7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG4vLyBIb3cgVEhJUyBDTEkgd2FzIGludm9rZWQsIGFzIGEgcnVubmFibGUgcHJlZml4LiBgcHJvY2Vzcy5hcmd2WzFdYCBpcyB0aGVcbi8vIGFic29sdXRlIHBhdGggb2YgY2xpLnRzIHVuZGVyIGBidW4g4oCmL2NsaS50cyA8dmVyYj5gLCB3aGljaCBpcyBTS0lMTC5tZCdzXG4vLyBjYW5vbmljYWwgaW52b2NhdGlvbiDigJQgc28gdGhlIGxpbmUgd2UgcHJpbnQgY2FuIGFjdHVhbGx5IGJlIHBhc3RlZC4gRmFsbHNcbi8vIGJhY2sgdG8gdGhlIGJhcmUgdmVyYiBpZiBhcmd2IGlzIG5vdCBzaGFwZWQgYXMgZXhwZWN0ZWQsIHdoaWNoIGlzIGEgdmVyYlxuLy8gcmVmZXJlbmNlIHJhdGhlciB0aGFuIGEgY29tbWFuZCB0aGF0IGxpZXMgYWJvdXQgYmVpbmcgb25lLlxuZnVuY3Rpb24gaW52b2NhdGlvblByZWZpeCgpOiBzdHJpbmcge1xuICBjb25zdCBlbnRyeSA9IHByb2Nlc3MuYXJndlsxXTtcbiAgcmV0dXJuIGVudHJ5ID8gYGJ1biAke2VudHJ5fWAgOiBcIlwiO1xufVxuXG4vLyBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgYGhpbnRgIOKAlCB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoYSA0MDQgb24gYVxuLy8gcmVhZCBuYW1lcyB0aGUgYG9wZW5gIHRoYXQgd291bGQgY3JlYXRlIHRoZSBjaGFubmVsKS5cbi8vXG4vLyDimqAgYGhpbnRgIGlzIGEgVkVSQiBJTlZPQ0FUSU9OLCBub3QgYSBzaGVsbCBjb21tYW5kOiB0aGUgZGFlbW9uIGNhbm5vdCBrbm93XG4vLyBob3cgaXRzIGNsaWVudCB3YXMgaW52b2tlZCwgc28gaXQgbmFtZXMgdGhlIGFjdCBhbmQgd2UgcmVuZGVyIGl0LiBJdCB1c2VkIHRvXG4vLyBhcnJpdmUgYXMgYGdyYXBldmluZSBvcGVuIDxuYW1lPmAgYW5kIGJlIHByaW50ZWQgdmVyYmF0aW0gYWZ0ZXIgYHRyeTpgLCB3aGljaFxuLy8gcmVhZHMgYXMgc29tZXRoaW5nIHRvIHBhc3RlIOKAlCBhbmQgcGFzdGluZyBpdCBnZXRzIGBjb21tYW5kIG5vdCBmb3VuZGAsXG4vLyBiZWNhdXNlIG5vdGhpbmcgaW5zdGFsbHMgYSBgZ3JhcGV2aW5lYCBiaW5hcnkuIFJ1bGluZyAyIGFza2VkIHRoYXQgYSByZWZ1c2FsXG4vLyBuYW1lIHRoZSBuZXh0IGFjdDsgYSByZWNvdmVyeSB0aGF0IGZhaWxzIHdoZW4geW91IHJ1biBpdCBkb2VzIG5vdC5cbmZ1bmN0aW9uIGRpZUFwaShkYXRhOiB7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0gfCBudWxsLCBzdGF0dXM6IG51bWJlcik6IG5ldmVyIHtcbiAgY29uc3QgbXNnID0gZGF0YT8uZXJyb3IgPz8gYEhUVFAgJHtzdGF0dXN9YDtcbiAgY29uc3QgcHJlZml4ID0gaW52b2NhdGlvblByZWZpeCgpO1xuICAvLyDim5QgVEhFIFJFQ09WRVJZIElTIEEgRklFTEQgTk9XLCBOT1QgQSBTRU5URU5DRS4gSXQgdXNlZCB0byBiZSBhcHBlbmRlZCB0byB0aGVcbiAgLy8gbWVzc2FnZSBhcyBg4oCUIHRyeTogPGNtZD5gLCB3aGljaCBhIGNhbGxlciBoYWQgdG8gcmVjb3ZlciBieSBzcGxpdHRpbmcgb25cbiAgLy8gXCJ0cnk6IFwiIChvbmUgb2YgZ3JhcGV2aW5lJ3Mgb3duIGNlbGxzIGRpZCBleGFjdGx5IHRoYXQsIGFuZCByYW4gd2hhdCBpdFxuICAvLyBmb3VuZCkuIGBoaW50YCBpcyB3aGVyZSB0aGUgZW52ZWxvcGUgY2FycmllcyBpdCwgc28gdGhlIHNhbWUgY2VsbCBub3cgcmVhZHNcbiAgLy8gYSBmaWVsZCBhbmQgcnVucyBpdCDigJQgdGhlIHByb3BlcnR5IGlzIHVuY2hhbmdlZCBhbmQgdGhlIHBhcnNlIGlzIG5vdCBhIHBhcnNlLlxuICBjb25zdCBoaW50ID0gZGF0YT8uaGludFxuICAgID8gcHJlZml4XG4gICAgICA/IGB0cnk6ICR7cHJlZml4fSAke2RhdGEuaGludH1gXG4gICAgICA6IGB0cnkgdGhlIFxcYCR7ZGF0YS5oaW50fVxcYCB2ZXJiYFxuICAgIDogdW5kZWZpbmVkO1xuICBkaWUobXNnLCBraW5kRm9yU3RhdHVzKHN0YXR1cyksIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC8vIFRoZSB1cHN0cmVhbSdzIGJvZHkgVkVSQkFUSU0sIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gd2hhdCB0aGUgZGFlbW9uXG4gICAgLy8gYWN0dWFsbHkgc2FpZCByYXRoZXIgdGhhbiBvbiB0aGlzIENMSSdzIHByb3NlIGFib3V0IGl0LlxuICAgIC4uLihkYXRhICE9PSBudWxsID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIEV4aXN0ZW5jZSBwcm9iZSBmb3IgdGhlIHJlYWQgdmVyYnMgdGhhdCBhbnN3ZXIgZnJvbSB0aGUgTE9HIEZJTEUgcmF0aGVyIHRoYW5cbi8vIGZyb20gYSByb3V0ZSAoYHRyaWFnZWAsIGBwdWxsIC0tc3RhdHVzYCkuIFRob3NlIGNhbm5vdCA0MDQgb24gdGhlaXIgb3duOiBhXG4vLyBtaXNzaW5nIGxvZyBpcyBhbiBlbXB0eSBhcnJheSwgd2hpY2ggaXMgdGhlIHNhbWUgc2lsZW50IGxpZSB0aGUgZGFlbW9uIGd1YXJkXG4vLyBleGlzdHMgdG8ga2lsbC4gR0VUIC90b3BpYyBpcyB0aGUgY2hlYXBlc3QgZ3VhcmRlZCByb3V0ZSwgc28gaXQgaXMgdGhlIHByb2JlLlxuYXN5bmMgZnVuY3Rpb24gcmVxdWlyZUNoYW5uZWwocG9ydDogbnVtYmVyLCBuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyB0b3BpYz86IHN0cmluZzsgZnJvbT86IHN0cmluZzsgZnJlc2g/OiBib29sZWFuIH0sXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIG9wZW4gPG5hbWU+IFstLXRvcGljIDx0ZXh0Pl0gWy0tZnJlc2hdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+ID0geyBuYW1lLCBleHBsaWNpdDogdHJ1ZSB9O1xuICBpZiAob3B0cy50b3BpYyAhPT0gdW5kZWZpbmVkKSBib2R5LnRvcGljID0gb3B0cy50b3BpYztcbiAgaWYgKG9wdHMuZnJvbSAhPT0gdW5kZWZpbmVkKSBib2R5LmZyb20gPSBvcHRzLmZyb207XG4gIGlmIChvcHRzLmZyZXNoKSBib2R5LmZyZXNoID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxPcGVuUmVzcG9uc2U+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVG9waWMoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgdGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBmcm9tOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRvcGljIDxjaGFubmVsPiBbPHRleHQ+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBpZiAodGV4dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gYHRvcGljIDxuYW1lPmAgd2l0aCBubyB0ZXh0IGlzIGEgUkVBRCDigJQgaXQgYXNrcyB3aGF0IHRoZSB0b3BpYyBpcywgYW5kIGFcbiAgICAvLyBtaXNzaW5nIGNoYW5uZWwgYW5zd2VycyB0aGF0IHF1ZXN0aW9uIGJ5IGJlaW5nIG1pc3NpbmcuIE5vIGVuc3VyZTogdGhlXG4gICAgLy8gZW5zdXJlIHdhcyB3aGF0IHJlc3VycmVjdGVkIGEgY2xvc2VkIGNoYW5uZWwgZnJvbSBhIHJlYWQgdmVyYi5cbiAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2ApO1xuICAgIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBgdG9waWMgPG5hbWU+IDx0ZXh0PmAgaXMgYSBXUklURSwgc28gaXQgbWF5IGNyZWF0ZSDigJQgYnV0IGl0IG11c3Qgbm90IHdyaXRlXG4gIC8vIHRvIGFuIEFSQ0hJVkVEIGNoYW5uZWwuIFRoZSBQVVQgZW5mb3JjZXMgdGhhdCBpdHNlbGYgbm93OyB0aGlzIGVuc3VyZSBzdGF5c1xuICAvLyBiZWNhdXNlIERJU0NBUkRJTkcgSVRTIFNUQVRVUyBpcyBwcmVjaXNlbHkgdGhlIGJ1ZyBiZWluZyBmaXhlZCBoZXJlLiBCZWZvcmVcbiAgLy8gdG9kYXkgdGhlIDQwOSB0aGF0IGFuc3dlcnMgZm9yIGFuIGFyY2hpdmVkIG5hbWUgd2FzIHRocm93biBhd2F5IGFuZCB0aGUgUFVUXG4gIC8vIHRoYXQgZm9sbG93ZWQgbGFuZGVkOiBgYXJjaGl2ZSB4OyB0b3BpYyB4IFwidFwiYCByZXR1cm5lZCBvazp0cnVlLCBleGl0IDAuXG4gIGNvbnN0IGVuc3VyZSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCB7IG5hbWUgfSk7XG4gIGlmIChlbnN1cmUuc3RhdHVzID49IDQwMCkgZGllQXBpKGVuc3VyZS5kYXRhLCBlbnN1cmUuc3RhdHVzKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIlBVVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLCB7XG4gICAgdG9waWM6IHRleHQsXG4gICAgZnJvbTogZnJvbSA/PyBcInN5c3RlbVwiLFxuICB9KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljLCBpZDogZGF0YT8uaWQgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxDaGFubmVsc1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9jaGFubmVsc1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW47IHZlcmJvc2U/OiBib29sZWFuOyBpblJlcGx5VG8/OiBudW1iZXIgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGluX3JlcGx5X3RvPzogbnVtYmVyIH0gPSB7XG4gICAgZnJvbSxcbiAgICB0ZXh0LFxuICB9O1xuICBpZiAob3B0cy5pblJlcGx5VG8gIT09IHVuZGVmaW5lZCkgYm9keS5pbl9yZXBseV90byA9IG9wdHMuaW5SZXBseVRvO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFNlbmRSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgLy8gVGFyZ2V0IGVjaG8gb24gc3RkZXJyIOKAlCBjb25maXJtcyBXSEVSRSB0aGUgbWVzc2FnZSBsYW5kZWQgc28gYSBtaXNyb3V0ZWRcbiAgLy8gcmVwbHkgKHJpZ2h0IHByb21wdCwgd3JvbmcgY2hhbm5lbCkgaXMgY2F1Z2h0IHRoZSBpbnN0YW50IGl0IGhhcHBlbnMgKEY5KS5cbiAgLy8gT24gc3RkZXJyIHNvIGl0IG5ldmVyIHBvbGx1dGVzIHRoZSBzdGRvdXQgSlNPTiByZWNlaXB0LCBhbmQgaXQgZmlyZXMgZXZlblxuICAvLyB1bmRlciAtLXF1aWV0ICh0aGUgc2FmZXR5IHNpZ25hbCBzaG91bGRuJ3QgYmUgc2lsZW5jZWQpLlxuICBjb25zdCByZWNpcCA9XG4gICAgZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWRcbiAgICAgID8gYCR7ZGF0YS5yZWNpcGllbnRzfSByZWNpcGllbnQocylgXG4gICAgICA6IGAke2RhdGEuc3Vic2NyaWJlcnMgPz8gMH0gc3Vic2NyaWJlcihzKWA7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIOKGkiAke2RhdGEuY2hhbm5lbH0gwrcgJHtyZWNpcH1cXG5gKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgLy8gVGVyc2UgZGVmYXVsdDogaWQgKyBzdWJzY3JpYmVyIGNvdW50ICsgdm9pZCB3YXJuaW5nLiAtLXZlcmJvc2UgYWxzb1xuICAvLyBpbmNsdWRlcyB0aGUgc3Vic2NyaWJlciBhbGlhcyBsaXN0IChzYW1lIGRhdGEgYXMgdGhlIGB3aG9gIHZlcmIsXG4gIC8vIHBpZ2d5YmFja2VkIHRvIGF2b2lkIGFuIGV4dHJhIHJvdW5kLXRyaXAgd2hlbiB0aGUgc2VuZGVyIGNhcmVzKS5cbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBpZDogZGF0YS5pZCxcbiAgICBjaGFubmVsOiBkYXRhLmNoYW5uZWwsXG4gICAgc3Vic2NyaWJlcnM6IGRhdGEuc3Vic2NyaWJlcnMgPz8gMCxcbiAgfTtcbiAgLy8gT25seSBzdXJmYWNlIHJlY2lwaWVudHMgaWYgdGhlIGRhZW1vbiBhY3R1YWxseSBjb21wdXRlZCBpdC4gRGVmYXVsdGluZ1xuICAvLyB0byAwIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIFwicmVhbGx5IDBcIiBhbmQgaGlkIHNpbGVudCBWMS41LWRhZW1vblxuICAvLyBkZWdyYWRhdGlvbiBkdXJpbmcgY3Jvc3MtdmVyc2lvbiBzZXNzaW9uczsgbWlzc2luZy1tZWFucy1taXNzaW5nIGlzIHRoZVxuICAvLyBob25lc3Qgc2lnbmFsLlxuICBpZiAoZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWQpIG91dC5yZWNpcGllbnRzID0gZGF0YS5yZWNpcGllbnRzO1xuICBpZiAoZGF0YS5zdWJzY3JpYmVycyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcImNoYW5uZWwgaGFzIG5vIHN1YnNjcmliZXJzXCI7XG4gIGVsc2UgaWYgKGRhdGEucmVjaXBpZW50cyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm9ubHkgeW91IGFyZSBzdWJzY3JpYmVkXCI7XG4gIGlmIChvcHRzLnZlcmJvc2UpIG91dC5zdWJzY3JpYmVyX2FsaWFzZXMgPSBkYXRhLnN1YnNjcmliZXJfYWxpYXNlcyA/PyBbXTtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFubm91bmNlKFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgY2hhbm5lbHM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7IHF1aWV0PzogYm9vbGVhbiB9LFxuKSB7XG4gIGlmICghZnJvbSB8fCAhdGV4dCkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBhbm5vdW5jZSAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogeyBmcm9tOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgY2hhbm5lbHM/OiBzdHJpbmdbXSB9ID0geyBmcm9tLCB0ZXh0IH07XG4gIGlmIChjaGFubmVscz8ubGVuZ3RoKSBib2R5LmNoYW5uZWxzID0gY2hhbm5lbHM7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8QW5ub3VuY2VSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgXCIvYW5ub3VuY2VcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgYCMgYW5ub3VuY2VkIOKGkiAke2RhdGEuY2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIMK3ICR7ZGF0YS50b3RhbF9yZWNpcGllbnRzfSByZWNpcGllbnQocylcXG5gLFxuICApO1xuICBpZiAob3B0cy5xdWlldCkgcmV0dXJuO1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG9rOiB0cnVlLFxuICAgIGNoYW5uZWxzOiBkYXRhLmNoYW5uZWxzLFxuICAgIHRvdGFsX3JlY2lwaWVudHM6IGRhdGEudG90YWxfcmVjaXBpZW50cyxcbiAgfTtcbiAgaWYgKGRhdGEuc2tpcHBlZD8ubGVuZ3RoKSBvdXQuc2tpcHBlZCA9IGRhdGEuc2tpcHBlZDtcbiAgaWYgKGRhdGEuY2hhbm5lbHMubGVuZ3RoID09PSAwKSBvdXQud2FybmluZyA9IFwibm8gYWN0aXZlIGNoYW5uZWxzIHRvIGFubm91bmNlIHRvXCI7XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQdWxsKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2U6IG51bWJlciwgb3B0czogeyBzdGF0dXM/OiBzdHJpbmcgfSA9IHt9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBwdWxsIDxjaGFubmVsPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcblxuICBpZiAob3B0cy5zdGF0dXMgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFRoaXMgYnJhbmNoIGFuc3dlcnMgZnJvbSB0aGUgbG9nIGZpbGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93bi5cbiAgICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgICAvLyBGdWxsLWNoYW5uZWwgc2NhbjogZmlsdGVyIGJ5IGxhdGVzdCBkaXNwb3NpdGlvbiwgc3RhdHVzIGZyYW1lcyBleGNsdWRlZC5cbiAgICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICAgIGNvbnN0IGZpbHRlcmVkID0gYmFkZ2VkLmZpbHRlcigobSkgPT4ge1xuICAgICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICAgIC8vIGAtLXN0YXR1cyBvcGVuYCBtaXJyb3JzIHRyaWFnZSdzIG9wZW4gYnVja2V0OiBzaWduYWwtb25seSwgc28gbm9uLW1lc3NhZ2VcbiAgICAgIC8vIEZZSXMgKHRvcGljL2Fubm91bmNlbWVudCkgYXJlIGV4Y2x1ZGVkIGZyb20gdGhlIGFjdGlvbmFibGUgcXVldWUuXG4gICAgICByZXR1cm4gb3B0cy5zdGF0dXMgPT09IFwib3BlblwiXG4gICAgICAgID8gbS5raW5kID09PSBcIm1lc3NhZ2VcIiAmJiBpc09wZW4oZGlzcEFyZylcbiAgICAgICAgOiBtLmRpc3Bvc2l0aW9uID09PSBvcHRzLnN0YXR1cztcbiAgICB9KTtcbiAgICBjb25zdCBsYXN0SWQgPSBmaWx0ZXJlZC5hdCgtMSk/LmlkID8/IDA7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBmaWx0ZXJlZCwgY3Vyc29yOiBsYXN0SWQgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU2luY2Utd2luZG93IHBhdGggKHVuY2hhbmdlZCBmcm9tIFRhc2sgMikuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke3NpbmNlfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgcmF3TXNncyA9IGRhdGE/Lm1lc3NhZ2VzID8/IFtdO1xuICBjb25zdCBjdXJzb3IgPSByYXdNc2dzLmF0KC0xKT8uaWQgPz8gc2luY2U7XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBhbm5vdGF0ZWQgPSByYXdNc2dzXG4gICAgLy8gRGlzcG9zaXRpb24gZnJhbWVzIG9ubHkg4oCUIGEgbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgc3RheXMgaW5cbiAgICAvLyB0aGUgaGlzdG9yeSBhbiBhZ2VudCBwdWxsczsgaXQgaXMgaG93IGl0IGxlYXJucyB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZC5cbiAgICAuZmlsdGVyKChtKSA9PiAhaXNEaXNwb3NpdGlvbkZyYW1lKG0pKVxuICAgIC5tYXAoKG0pID0+IHtcbiAgICAgIGNvbnN0IGQgPSBkaXNwLmdldChtLmlkKTtcbiAgICAgIHJldHVybiBkID8geyAuLi5tLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0gOiBtO1xuICAgIH0pO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IGFubm90YXRlZCwgY3Vyc29yIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZWFkKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgaWQ6IG51bWJlciwgb3B0czogeyB0ZXh0PzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGlkKSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZWFkIDxjaGFubmVsPiA8aWQ+IFstLXRleHRdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJ1aWx0IG9uIHRoZSBleGlzdGluZyByYW5nZSBmZXRjaCDigJQgYHNpbmNlPWlkLTFgIHJldHVybnMgaWQgYW5kIGJleW9uZDtcbiAgLy8gd2UgcGljayB0aGUgZXhhY3QgaWQuIE5vIGRhZW1vbiBBUEkgY2hhbmdlLiBUaGlzIGlzIHRoZSB0YXJnZXRlZFxuICAvLyBcImdpdmUgbWUgbWVzc2FnZSBOIGluIGZ1bGxcIiB2ZXJiIHRoYXQgcmVjb3ZlcnMgYSBjbGlwcGVkIHRhaWwgcHJldmlld1xuICAvLyB3aXRob3V0IHRoZSBwdWxsLXJhbmdlICsganEgZGFuY2UuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke2lkIC0gMX1gLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIGNvbnN0IG1zZyA9IChkYXRhPy5tZXNzYWdlcyA/PyBbXSkuZmluZCgobSkgPT4gbS5pZCA9PT0gaWQpO1xuICBpZiAoIW1zZykgZGllKGBtZXNzYWdlICR7aWR9IG5vdCBmb3VuZCBpbiAke25hbWV9YCwgXCJub3RfZm91bmRcIik7XG4gIGNvbnN0IGRpc3BNYXAgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBkID0gZGlzcE1hcC5nZXQoaWQpO1xuICBjb25zdCBhbm5vdGF0ZWRNc2cgPSBkID8geyAuLi5tc2csIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSA6IG1zZztcbiAgaWYgKG9wdHMudGV4dCkge1xuICAgIC8vIFByb3NlIG1vZGU6IGhlYWRlciArIGJvZHksIG5vIEpTT04gZW52ZWxvcGUsIHNvIGEgaHVtYW4gKG9yIGFuIGFnZW50XG4gICAgLy8gcmVjb3ZlcmluZyBhIHRydW5jYXRlZCBub3RpZmljYXRpb24pIGNhbiByZWFkIGl0IGRpcmVjdGx5LlxuICAgIGNvbnN0IHRzID0gbmV3IERhdGUobXNnLnRzKS50b0lTT1N0cmluZygpO1xuICAgIGNvbnN0IGRpc3BQcmVmaXggPSBkXG4gICAgICA/IGQucmVvcGVucyA+IDBcbiAgICAgICAgPyBgWyR7ZC5kaXNwb3NpdGlvbn0g4oa7JHtkLnJlb3BlbnN9XSBgXG4gICAgICAgIDogYFske2QuZGlzcG9zaXRpb259XSBgXG4gICAgICA6IFwiXCI7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7ZGlzcFByZWZpeH1bJHttc2cuaWR9XSAke21zZy5mcm9tfSDCtyAke3RzfVxcbiR7bXNnLnRleHR9XFxuYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlOiBhbm5vdGF0ZWRNc2cgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhaXQoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgc2luY2U6IG51bWJlcixcbiAgdGltZW91dFM6IG51bWJlcixcbiAgYWxpYXM6IHN0cmluZyB8IHVuZGVmaW5lZCxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2FpdCA8Y2hhbm5lbD4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEdpdmUgdGhlIEhUVFAgZmV0Y2ggYSBzbGlnaHRseSBoaWdoZXIgYWJvcnQgdGltZW91dCB0aGFuIHRoZSBkYWVtb24nc1xuICAvLyBsb25nLXBvbGwgdGltZW91dCBzbyB0aGUgZGFlbW9uIGFsd2F5cyB3aW5zIHRoZSB0aW1lb3V0IHJhY2UuXG4gIC8vIGA/YXM9PGFsaWFzPmAgcmVnaXN0ZXJzIHByZXNlbmNlIG9uIHRoZSBjaGFubmVsIGZvciB0aGUgd2FpdCBkdXJhdGlvbiDigJRcbiAgLy8gd2FpdCBpcyBsb25nLXBvbGwgKHB1c2gtc2hhcGVkIHdpdGggYSBkZWFkbGluZSkgc28gaXQgZGVzZXJ2ZXMgcHJlc2VuY2UuXG4gIGNvbnN0IGFzUGFyYW0gPSBhbGlhcyA/IGAmYXM9JHtlbmNvZGVVUklDb21wb25lbnQoYWxpYXMpfWAgOiBcIlwiO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5uZWxzLyR7bmFtZX0vd2FpdD9zaW5jZT0ke3NpbmNlfSZ0aW1lb3V0PSR7dGltZW91dFN9JHthc1BhcmFtfWA7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgodGltZW91dFMgKyA1KSAqIDEwMDApLFxuICB9KTtcbiAgbGV0IGRhdGE6IFdhaXRSZXNwb25zZSB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgV2FpdFJlc3BvbnNlO1xuICB9IGNhdGNoIHt9XG4gIGlmICghcmVzLm9rKSBkaWVBcGkoZGF0YSwgcmVzLnN0YXR1cyk7XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgbWVzc2FnZXM6IGRhdGE/Lm1lc3NhZ2VzID8/IFtdLFxuICAgIGN1cnNvcjogZGF0YT8uY3Vyc29yID8/IHNpbmNlLFxuICAgIHRpbWVkX291dDogISFkYXRhPy50aW1lZF9vdXQsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXaG8obmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB3aG8gPGNoYW5uZWw+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWw6IG5hbWUsIHN1YnNjcmliZXJzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdWJzY3JpYmVyc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3N1YnNjcmliZXJzYCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvQWxsKCkge1xuICAvLyBDcm9zcy1jaGFubmVsIHJvc3RlciDigJQgbmFtZXMgw5cgY2hhbm5lbCBpbiBvbmUgY2FsbCwgc28geW91IGRvbid0IGZhbiBvdXRcbiAgLy8gTiBgd2hvYCBjYWxscyArIGEgbWFudWFsIGpvaW4gdG8gYW5zd2VyIFwid2hvIGlzIG9uIHdoaWNoIHZpbmU/XCIuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyBHZXQgb3Igc2V0IHRoZSBwZXJzaXN0ZWQgZGVmYXVsdCBhbGlhcyAoVjEuNykuIFdpdGggbm8gYXJndW1lbnQsIHByaW50cyB0aGVcbi8vIGN1cnJlbnQgYWxpYXM7IHdpdGggb25lLCB3cml0ZXMgaXQgdG8gY29uZmlnLmpzb24uIFB1cmUgZmlsZSBJL08g4oCUIHdvcmtzXG4vLyB3aXRob3V0IGEgcnVubmluZyBkYWVtb24uIFRoZSB3YXRjaCBzdXJmYWNlIHJlYWRzIGl0IHZpYSBHRVQgL2lkZW50aXR5IHNvIHRoZVxuLy8gaHVtYW4gaGFzIGEgY29uc2lzdGVudCBuYW1lIGFjcm9zcyBldmVyeSBncmFwZXZpbmUuXG5hc3luYyBmdW5jdGlvbiBjbWRBbGlhcyhuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgbGV0IGNmZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgdHJ5IHtcbiAgICBjZmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhDT05GSUdfRklMRSwgXCJ1dGYtOFwiKSk7XG4gIH0gY2F0Y2gge31cbiAgaWYgKG5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFsaWFzID0gdHlwZW9mIGNmZy5hbGlhcyA9PT0gXCJzdHJpbmdcIiAmJiBjZmcuYWxpYXMudHJpbSgpID8gY2ZnLmFsaWFzLnRyaW0oKSA6IG51bGw7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFsaWFzIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB0cmltbWVkID0gbmFtZS50cmltKCk7XG4gIGNmZy5hbGlhcyA9IHRyaW1tZWQ7XG4gIG1rZGlyU3luYyhEQVRBX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoQ09ORklHX0ZJTEUsIGAke0pTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMil9XFxuYCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhczogdHJpbW1lZCB8fCBudWxsIH0pO1xufVxuXG4vKipcbiAqIFRoZSBzdGFuZGluZyB0YWlsIOKAlCBgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgLCBhZG9wdGVkIGF0IFBoYXNlIDYgY2hhcHRlciAyLlxuICpcbiAqIOKblCBXSEFUIFRISVMgUkVQTEFDRUQsIEFORCBXSEFUIElUIEJPVUdIVC4gVGhpcyB2ZXJiIHdhcyAyMjAgbGluZXMgb2ZcbiAqIGhhbmQtd3JpdHRlbiByZWNvbm5lY3QgbG9vcDogdGhyZWUgbmVzdGVkIGxvb3BzIChyZWNvbm5lY3QgLyByZWFkIC8gZnJhbWVcbiAqIGRyYWluKSwgaXRzIG93biBTU0Ugc3BsaXR0ZXIsIGl0cyBvd24gYmFja29mZiwgYW5kIGEgYHByb2Nlc3MuZXhpdCgwKWAgaW4gYVxuICogc2lnbmFsIGhhbmRsZXIgc2V2ZW4gbGluZXMgaW4uIFRoZSBzaGFyZWQgY2xpZW50IGlzIHRoZSBzYW1lIGRlc2lnbiwgb25jZSwgYW5kXG4gKiB0aHJlZSB0aGluZ3MgYXJyaXZlIHdpdGggaXQgdGhhdCBncmFwZXZpbmUgZGlkIG5vdCBoYXZlOlxuICpcbiAqICAgMS4gKipBTiBJRExFIFdBVENIRE9HIOKAlCBncmFwZXZpbmUgaGFkIE5PTkUuKiogYGF3YWl0IHJlYWRlci5yZWFkKClgIHdhc1xuICogICAgICB1bmJvdW5kZWQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhXG4gKiAgICAgIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIEZPUkVWRVIsIGFuZCBhIHBhcmtlZCB0YWlsIGlzXG4gKiAgICAgIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLiBgVEFJTF9JRExFX01TYCBpcyB0aHJlZSBvZiBUSElTXG4gKiAgICAgIHNwZWxsJ3MgMyBzIGJlYXRzIChgLi9oZWFydGJlYXQudHNgKSwgbmV2ZXIgYSBjb3BpZWQgNDUsMDAwLlxuICogICAyLiAqKkEgU1BFQy1DT1JSRUNUIEZSQU1FIFBBUlNFUi4qKiBUaGUgaGFuZC13cml0dGVuIG9uZSBkaWRcbiAqICAgICAgYGxpbmUuc2xpY2UoNSkudHJpbSgpYCwgd2hpY2ggc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIHRoZSBvbmVcbiAqICAgICAgbGVhZGluZyBzcGFjZSB0aGUgc3BlYyByZW1vdmVzIOKAlCBpdCB3b3VsZCBjb3JydXB0IGEgbWVzc2FnZSBib2R5IHdob3NlXG4gKiAgICAgIGZpcnN0IGxpbmUgaXMgaW5kZW50ZWQuIE5vdGhpbmcgaW4gdGhlIHJvc3RlciBlbWl0cyBvbmUgdG9kYXk7IHRoZSBwYXJzZVxuICogICAgICBpcyByaWdodCBhbnl3YXkgbm93LlxuICogICAzLiAqKkEgU0lHTkFMIFBBVEggVEhBVCBEUkFJTlMuKiogVGhlIG9sZCBoYW5kbGVyIHdhc1xuICogICAgICBgc3RvcHBlZCA9IHRydWU7IHByb2Nlc3MuZXhpdCgwKWAg4oCUIHRoZSBQMGYgZGVmZWN0IGV4YWN0bHksIGFwcGxpZWQgdG9cbiAqICAgICAgdGhlIHRlcm1pbmFsIGZyYW1lIGluIGZpdmUgc3BlbGxzIGFuZCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZVxuICogICAgICBsaW5lcyBhYm92ZSBpdC4gQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWRcbiAqICAgICAgc3Rkb3V0LiBUaGUgY2xpZW50IFJFVFVSTlMgYW4gZXhpdCBjb2RlOyBgbWFpbmAgYXNzaWducyBpdCBhbmQgcmV0dXJuc1xuICogICAgICBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMuXG4gKlxuICog4puUIE5PIGBlcG9jaE9mYCAvIGBvbkVwb2NoQ2hhbmdlYCwgQU5EIFRIQVQgSVMgQSBSVUxJTkcsIE5PVCBBTiBPTUlTU0lPTlxuICogKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmUgUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQg4oCUIGBsb2FkQ2hhbm5lbCgpYFxuICogZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBoaWdoLXdhdGVyIG1hcmsgb3ZlciB0aGUgZHVyYWJsZSBgLmpzb25sYCDigJQgc28gYVxuICogcmVjb25uZWN0aW5nIGN1cnNvciBpcyBzdGlsbCB2YWxpZCBhbmQgdGhlIGNvbmRpdGlvbiBhbiBlcG9jaCBkZXRlY3RzIGNhbm5vdFxuICogb2NjdXIgaGVyZS4gV2lyaW5nIG9uZSB3b3VsZCBiZSBhIFJFR1JFU1NJT04gd2l0aCBhIG1lYXN1cmVkIG1lY2hhbmlzbTpcbiAqIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIGBjdXJzb3IgPSAwYCwgYW5kIHRoaXMgZGFlbW9uIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGhcbiAqIGByZWFkQmFja2xvZyhuYW1lLCAwKWAg4oCUIHRoZSB3aG9sZSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhbiBhZ2VudCdzIHBpcGUsXG4gKiBvbiBldmVyeSBgZ3JhcGV2aW5lIHJvbGxgLlxuICpcbiAqIOKaoCBgcmVzb2x2ZWAgQ0FMTFMgYGVuc3VyZURhZW1vbmAsIFdISUNIIENBTiBSQUlTRSDigJQgZGVsaWJlcmF0ZWx5LCBhbmQgdGhlIGtpdFxuICogZG9jdW1lbnRzIHRoZSBwcm9wZXJ0eSB0aGlzIGRlcGVuZHMgb246IGl0cyBvdXRlciBibG9jayBpcyBhIGB0cnlgL2BmaW5hbGx5YFxuICogd2l0aCBOTyBgY2F0Y2hgLCBzbyBhIGBDbGlFcnJvcmAgZnJvbSB0aHJlZSBmcmFtZXMgZG93biBwcm9wYWdhdGVzIGludG9cbiAqIGBtYWluYCBpbnN0ZWFkIG9mIGJlaW5nIHJlYWQgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kIHJldHJpZWQgZm9yZXZlci5cbiAqIENoZWNrZWQgYXQgdGhlIGFkb3B0aW9uIHJhdGhlciB0aGFuIGFzc3VtZWQgKHBsYXlib29rIEI5IHN0ZXAgNSkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgb3B0czoge1xuICAgIHNpbmNlPzogbnVtYmVyO1xuICAgIGZyb21TdGFydD86IGJvb2xlYW47XG4gICAgbGFzdD86IG51bWJlcjtcbiAgICBhcz86IHN0cmluZztcbiAgICBodW1hbj86IGJvb2xlYW47XG4gICAgbHVyaz86IGJvb2xlYW47XG4gICAgbWF4PzogbnVtYmVyO1xuICB9LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFuYW1lKVxuICAgIGRpZShcbiAgICAgIFwidXNhZ2U6IGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXCIsXG4gICAgKTtcbiAgLy8gLS1sdXJrIHJlY2VpdmVzIG1lc3NhZ2VzIGJ1dCByZWdpc3RlcnMgbm8gcHJlc2VuY2Ug4oCUIGFuIGludmlzaWJsZSBvYnNlcnZlci5cbiAgLy8gSXQgb3ZlcnJpZGVzIGlkZW50aXR5IGZsYWdzIChhIGx1cmtlciBoYXMgbm8gbmFtZSB0byBzaG93KS5cbiAgY29uc3QgbXlBbGlhcyA9IG9wdHMubHVyayA/IHVuZGVmaW5lZCA6IG9wdHMuYXM7XG4gIGNvbnN0IHNpbmNlID0gb3B0cy5mcm9tU3RhcnQgPyAwIDogKG9wdHMuc2luY2UgPz8gLTEpO1xuICAvLyBFbWl0IHRoZSBncm91bmRpbmcgbGluZSBvbmx5IG9uIHRoZSBmaXJzdCBzdWJzY3JpYmUsIG5ldmVyIG9uIHJlY29ubmVjdHNcbiAgLy8gKGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSB0aGUgY3Vyc29yIOKAlCB0aGVyZSBpcyBubyB1bnNlZW4gaGlzdG9yeSB0aGVuKS5cbiAgLy8g4puUIEFORCBORVZFUiBPTiBBIGAtLXNpbmNlYCBSRS1BUk0gKGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsIEEzKTogdGhlXG4gIC8vIGFnZW50IGFscmVhZHkga25vd3MgdGhlIGNoYW5uZWwsIGFuZCB0aGUgaGlzdG9yeSBoaW50IHdvdWxkIGJlIG5vaXNlLlxuICBsZXQgZ3JvdW5kZWQgPSBvcHRzLnNpbmNlICE9PSB1bmRlZmluZWQ7XG4gIC8vIOKblCBUSEUgQk9PS01BUksgRk9SIEEgTElWRS1PTkxZIFRBSUwuIGBzaW5jZSA9IC0xYCBhc2tzIGZvciBubyBoaXN0b3J5LCBzbyBhXG4gIC8vIHRhaWwgdGhhdCBzZWVzIG5vIG1lc3NhZ2UgaGFzIG5vIGlkIHRvIGhhbmQgaXRzIHJlLWFybSwgYW5kIHRoZSByZS1hcm1cbiAgLy8gd291bGQgbWlzcyBldmVyeXRoaW5nIHNlbnQgaW4gdGhlIGdhcC4gVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXIgY2FycmllcyB0aGVcbiAgLy8gY2hhbm5lbCdzIGBsYXRlc3RfaWRgOiBzZWVkaW5nIHRoZSBjdXJzb3IgZnJvbSBpdCBtYWtlcyB0aGUgaGFuZG9mZidzXG4gIC8vIGAtLXNpbmNlYCBleGFjdC4gT25seSBmb3IgYSBsaXZlLW9ubHkgc3RhcnQg4oCUIGEgYmFja2ZpbGxpbmcgb25lIChgLS1sYXN0YCxcbiAgLy8gYC0tZnJvbS1zdGFydGAsIGAtLXNpbmNlYCkgaXMgc3RpbGwgcmVhZGluZyBpZHMgYXQgb3IgYmVsb3cgaXQsIGFuZCBhXG4gIC8vIHJlY29ubmVjdCBtaWQtYmFja2ZpbGwgbXVzdCBub3Qgc2tpcCBwYXN0IHRoZW0uXG4gIC8vIE9uY2U6IGEgbGF0ZXIgbWFya2VyIChhIHJlY29ubmVjdCkgbXVzdCBub3QganVtcCB0aGUgY3Vyc29yIHBhc3QgbWVzc2FnZXNcbiAgLy8gaXRzIG93biBiYWNrbG9nIGlzIGFib3V0IHRvIHJlcGxheS5cbiAgbGV0IHNlZWRGcm9tTWFya2VyID0gc2luY2UgPCAwICYmIG9wdHMubGFzdCA9PT0gdW5kZWZpbmVkO1xuXG4gIC8vIOKblCBBIFBSRVNFTkNFIFNQRUxMOiB0aGUgY29ubmVjdGlvbiBJUyBgd2hvYCdzIHByZXNlbmNlLCBzbyB0aGUgd2luZG93XG4gIC8vIGFsd2F5cyBuYW1lcyB0aGUgTW9uaXRvciByZS1hcm0sIG5ldmVyIHRoZSBzdG9wLXN0YXJ0IGAtLW9uY2VgLCBhbmQgYSBsb3N0XG4gIC8vIGRhZW1vbiBpcyByZXRyaWVkIChgcmVzb2x2ZWAgcmVzcGF3bnMgaXQpLCBub3QgcmVwb3J0ZWQuXG4gIGNvbnN0IGFnYWluID0gKGF0OiBudW1iZXIpID0+XG4gICAgY29tbWFuZExpbmUoW1xuICAgICAgLi4uc2VsZkNvbW1hbmQoKSxcbiAgICAgIFwidGFpbFwiLFxuICAgICAgbmFtZSxcbiAgICAgIC4uLihvcHRzLmx1cmsgPyBbXCItLWx1cmtcIl0gOiBteUFsaWFzID8gW1wiLS1hc1wiLCBteUFsaWFzXSA6IFtdKSxcbiAgICAgIC4uLihvcHRzLmh1bWFuICYmICFvcHRzLmx1cmsgPyBbXCItLWh1bWFuXCJdIDogW10pLFxuICAgICAgLi4uKG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBbXCItLW1heFwiLCBTdHJpbmcob3B0cy5tYXgpXSA6IFtdKSxcbiAgICAgIC8vIGAtLXNpbmNlYCB0YWtlcyBubyBuZWdhdGl2ZSBoZXJlOyBhIHRhaWwgdGhhdCBuZXZlciBsZWFybmVkIGFuIGlkXG4gICAgICAvLyByZS1hcm1zIGxpdmUtb25seSwgd2hpY2ggaXMgd2hhdCAtMSBtZWFudC5cbiAgICAgIC4uLihhdCA+PSAwID8gW1wiLS1zaW5jZVwiLCBTdHJpbmcoYXQpXSA6IFtdKSxcbiAgICBdKTtcblxuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPFRhaWxQYXlsb2FkPihcbiAgICB7XG4gICAgICAvLyDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVELiBBIHRhaWwgb3V0bGl2ZXNcbiAgICAgIC8vIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0IOKAlCBgcm9sbGAgYW5kIGByZXN0YXJ0YCBib3RoIHJlcGxhY2UgaXQg4oCUIGFuZFxuICAgICAgLy8gYGVuc3VyZURhZW1vbmAgcmUtcmVhZHMgdGhlIHBvcnQgZmlsZSBhbmQgcmVzcGF3bnMsIHNvIGEgcmVjb25uZWN0IGFmdGVyIGFcbiAgICAgIC8vIHJvbGwgbGFuZHMgb24gdGhlIE5FVyBkYWVtb24gcmF0aGVyIHRoYW4gc3Bpbm5pbmcgYWdhaW5zdCBhIGRlYWQgcG9ydC5cbiAgICAgIHJlc29sdmU6IGFzeW5jICgpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7YXdhaXQgZW5zdXJlRGFlbW9uKCl9YCxcbiAgICAgIHBhdGg6IGAvY2hhbm5lbHMvJHtuYW1lfS90YWlsYCxcbiAgICAgIHNpbmNlLFxuICAgICAgLy8g4pqgIE5PIGVuc3VyZSBjYWxsIGJlZm9yZSB0aGUgc3Vic2NyaWJlLiBBIGZyZXNoIGB0YWlsIG5hbWVgIHN0aWxsIHdvcmtzXG4gICAgICAvLyB3aXRob3V0IGFuIGV4cGxpY2l0IG9wZW4g4oCUIEdFVCDigKYvdGFpbCBjcmVhdGVzIHRoZSBjaGFubmVsIGl0c2VsZiDigJQgYW5kXG4gICAgICAvLyB0aGF0IGlzIHRoZSBPTkxZIHdheSB0aGUgc3Vic2NyaWJlZCBldmVudCdzIGBjcmVhdGVkYCBmbGFnIGNhbiBldmVyIGJlXG4gICAgICAvLyB0cnVlOiBhbiBlbnN1cmUgc2VudCBmaXJzdCBjcmVhdGVzIHRoZSBjaGFubmVsLCBzbyB0aGUgc3Vic2NyaWJlIHRoYXRcbiAgICAgIC8vIGZvbGxvd3MgYWx3YXlzIHJlcG9ydHMgYGNyZWF0ZWQ6ZmFsc2VgIGFuZCB0aGUgbWlzdHlwZWQtbmFtZSBzaWduYWwgbmV2ZXJcbiAgICAgIC8vIGZpcmVzLlxuICAgICAgcXVlcnk6IChjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPT4ge1xuICAgICAgICBjb25zdCBxOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgICAgLy8gIzY4IOKAlCBgLS1sYXN0IE5gIHJpZGVzIHRoZSBGSVJTVCBjb25uZWN0aW9uIG9ubHkuIE9uY2UgYW55IG1lc3NhZ2VcbiAgICAgICAgLy8gbGFuZHMgdGhlIGN1cnNvciBhZHZhbmNlcyBhbmQgYSByZWNvbm5lY3QgcmVzdW1lcyBmcm9tIGl0IHZpYSBgc2luY2VgLFxuICAgICAgICAvLyBuZXZlciByZS1iYWNrZmlsbGluZyB0aGUgd2luZG93LiBgZmlyc3RDb25uZWN0YCBpcyB0aGUga2l0J3MgcGFyYW1ldGVyXG4gICAgICAgIC8vIGZvciBleGFjdGx5IHRoaXM7IHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCBzcGVsbGVkIGl0IGBoaWdoZXN0U2VlbiA8IDBgLFxuICAgICAgICAvLyB3aGljaCB3YXMgdGhlIHNhbWUgdGVzdCBieSBhY2NpZGVudCBvZiB0aGUgc2VudGluZWwuXG4gICAgICAgIGlmIChvcHRzLmxhc3QgIT09IHVuZGVmaW5lZCAmJiBmaXJzdENvbm5lY3QpIHEubGFzdCA9IFN0cmluZyhvcHRzLmxhc3QpO1xuICAgICAgICBpZiAobXlBbGlhcykgcS5hcyA9IG15QWxpYXM7XG4gICAgICAgIGlmIChvcHRzLmh1bWFuICYmICFvcHRzLmx1cmspIHEuaHVtYW4gPSBcIjFcIjtcbiAgICAgICAgaWYgKG9wdHMubHVyaykgcS5sdXJrID0gXCIxXCI7XG4gICAgICAgIHJldHVybiBxO1xuICAgICAgfSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIikgcmV0dXJuIGV2LmlkO1xuICAgICAgICBpZiAoc2VlZEZyb21NYXJrZXIgJiYgdHlwZW9mIGV2LmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgIHNlZWRGcm9tTWFya2VyID0gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIGV2LmxhdGVzdF9pZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfSxcbiAgICAgIGFjY2VwdDogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICAvLyBUaGUgc3Vic2NyaWJlZCBtYXJrZXIgaXMgbm90IGEgbWVzc2FnZTsgYHJlbmRlcmAgYW5zd2VycyBpdC5cbiAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHRydWU7XG4gICAgICAgIC8vIERyb3AgRElTUE9TSVRJT04gZnJhbWVzIOKAlCB0aGV5IGFyZSBtZXRhZGF0YSBhYm91dCBhbm90aGVyIG1lc3NhZ2UuIEFcbiAgICAgICAgLy8gbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgcGFzc2VzIHRocm91Z2g6IGFuIGFnZW50IHRhaWxpbmcgYVxuICAgICAgICAvLyBjaGFubmVsIGNvdWxkIG5vdCBwcmV2aW91c2x5IHNlZSBlaXRoZXIgcGFydHkgcmV0aXJlIGl0LCBhbmQgZm91bmQgb3V0XG4gICAgICAgIC8vIHdoZW4gaXRzIG5leHQgc2VuZCB3YXMgcmVqZWN0ZWQuXG4gICAgICAgIGlmIChpc0Rpc3Bvc2l0aW9uRnJhbWUoZXYpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIC8vIFN1cHByZXNzIHNlbGYtZWNobzogd2hlbiAtLWFzIGlzIHNldCwgZHJvcCBtZXNzYWdlcyB3ZSBzZW50IG91cnNlbHZlcy5cbiAgICAgICAgLy8gVGhlIHNlbmRlciBhbHJlYWR5IGdvdCB0aGUgcmVjZWlwdCBhcyB0aGUgUE9TVCByZXNwb25zZSwgc28gcmUtZW1pdHRpbmdcbiAgICAgICAgLy8gaXQgb24gdGFpbCBpcyBwdXJlIG5vaXNlLlxuICAgICAgICBpZiAobXlBbGlhcyAmJiBldi5mcm9tID09PSBteUFsaWFzKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKHBheWxvYWQsIGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiByZW5kZXJTdWJzY3JpYmVkKHBheWxvYWQpO1xuICAgICAgICAvLyAjNjcg4oCUIGZyb250LWxvYWQgYSByZWNvdmVyeSBwb2ludGVyIG9uIEVWRVJZIG1lc3NhZ2UgZnJhbWUsIHNvIHRoZSByZWFkXG4gICAgICAgIC8vIGNvb3JkaW5hdGVzIHN1cnZpdmUgYSBkb3duc3RyZWFtIG5vdGlmaWNhdGlvbiBjbGlwLiBNb25pdG9yIHRydW5jYXRlcyBhdFxuICAgICAgICAvLyBpdHMgT1dOIGNhcCAoYmVsb3cgb3VyIGhpbnQgdGhyZXNob2xkLCBhbmQgb25lIHdlIGNhbm5vdCBvYnNlcnZlIGhlcmUpOyBhXG4gICAgICAgIC8vIG1lc3NhZ2UgaXQgY2xpcHMgd291bGQgb3RoZXJ3aXNlIGxvc2UgaXRzIHRyYWlsaW5nIGBpZGAgYW5kIGJlY29tZVxuICAgICAgICAvLyB1bnJlY292ZXJhYmxlIOKAlCB0aGUgcmVhZGVyIGlzIGxlZnQgaW5mZXJyaW5nIHRoZSBpZC4gRXZlcnkgZnJhbWVcbiAgICAgICAgLy8gdGhlcmVmb3JlIGNhcnJpZXMgYSBGUk9OVC1sb2FkZWQgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLCBlaXRoZXIgYXMgdGhlXG4gICAgICAgIC8vIHJpY2hlciBgdHJ1bmNhdGlvbl9oaW50YCAoZ2VudWluZWx5LWxvbmcgbWVzc2FnZXMg4oCUIHRoZSBcIitOIGNoYXJzLFxuICAgICAgICAvLyB5b3UncmUgZGVmaW5pdGVseSBtaXNzaW5nIGNvbnRlbnRcIiBhbGFybSkgb3IgYXMgdGhlIGNvbXBhY3QgYGZ1bGxgXG4gICAgICAgIC8vIHBvaW50ZXIuIFNlcmlhbGl6aW5nIGl0IGJlZm9yZSB0aGUgbG9uZyBgLnRleHRgIGlzIHdoYXQgbWFrZXMgaXQgc3Vydml2ZVxuICAgICAgICAvLyB0aGUgY2xpcCAoRjE3KS5cbiAgICAgICAgY29uc3QgcmVhZFJlZiA9IGByZWFkICR7bmFtZX0gJHtwYXlsb2FkLmlkfWA7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgcGF5bG9hZC50ZXh0ID09PSBcInN0cmluZ1wiICYmXG4gICAgICAgICAgcGF5bG9hZC50ZXh0Lmxlbmd0aCA+IChvcHRzLm1heCA/PyBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEKVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB0cnVuY2F0aW9uX2hpbnQgPSBgKyR7cGF5bG9hZC50ZXh0Lmxlbmd0aH0gY2hhcnMg4oCUIGZ1bGw6ICR7cmVhZFJlZn1gO1xuICAgICAgICAgIC8vIENhcCB0aGUgSU5MSU5FIGJvZHkgd2hlbiAtLW1heCBpcyBzZXQgKHRoZSBmdWxsIG1lc3NhZ2Ugc3RheXMgb24gZGlza1xuICAgICAgICAgIC8vIOKGkiBgcmVhZGApOyB3aXRob3V0IC0tbWF4LCBlbWl0IHRoZSBmdWxsIHRleHQgKHRvZGF5J3MgZGVmYXVsdCkuXG4gICAgICAgICAgY29uc3QgdGV4dCA9IG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBwYXlsb2FkLnRleHQuc2xpY2UoMCwgb3B0cy5tYXgpIDogcGF5bG9hZC50ZXh0O1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHRydW5jYXRpb25faGludCwgLi4ucGF5bG9hZCwgdGV4dCB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBmdWxsOiByZWFkUmVmLCAuLi5wYXlsb2FkIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIERhZW1vbiBsaXZlbmVzcyBoZWFydGJlYXQgKGA6IGhiIDx0cz5gKS4gU3VyZmFjZSBhIHJlY29nbml6YWJsZSBzZW50aW5lbFxuICAgICAgLy8gb24gc3RkZXJyIHNvIGEgYDI+JjFgIGNvbnN1bWVyIGNhbiB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiAoRjYpLiBLZXB0XG4gICAgICAvLyBvZmYgc3Rkb3V0IOKAlCB0aGUgSlNPTkwgc3RyZWFtIHN0YXlzIHB1cmUuXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiAodGV4dC50cmltU3RhcnQoKS5zdGFydHNXaXRoKFwiaGJcIikgPyBcIjogZ3JhcGV2aW5lLWtlZXBhbGl2ZVwiIDogbnVsbCksXG4gICAgICBvbk1hbGZvcm1lZDogKF9mcmFtZSwgZSkgPT4gYCMgYmFkIHNzZSBkYXRhOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgLy8gVGhlIGZvdXIgbGluZXMgdGhlIGhhbmQtd3JpdHRlbiBsb29wIHdyb3RlLCBwcmVzZXJ2ZWQgdmVyYmF0aW0g4oCUIGEgdGFpbFxuICAgICAgLy8gdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBvbmUgdGhhdCBpcyB3b3JraW5nLlxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBzd2l0Y2ggKGluZm8uY2F1c2UpIHtcbiAgICAgICAgICBjYXNlIFwiY29ubmVjdC1mYWlsZWRcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBjb25uZWN0IGZhaWxlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZXRyeWluZ+KApmA7XG4gICAgICAgICAgY2FzZSBcImh0dHBcIjpcbiAgICAgICAgICBjYXNlIFwibm8tYm9keVwiOlxuICAgICAgICAgICAgcmV0dXJuIGAjIHRhaWwgSFRUUCAke2luZm8uc3RhdHVzfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZXJyb3JcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBzdHJlYW0gZHJvcHBlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZWNvbm5lY3RpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZW5kXCI6XG4gICAgICAgICAgICByZXR1cm4gXCIjIHN0cmVhbSBjbG9zZWQsIHJlY29ubmVjdGluZ+KAplwiO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgfSxcbiAgICB7XG4gICAgICBtb2RlOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogdHJ1ZSxcbiAgICAgIC8vIEQ0OiBhIGh1bWFuIGF0IGEgdGVybWluYWwgKGAtLWh1bWFuYCkgaXMgbm90IGFuIGFnZW50IHVuZGVyXG4gICAgICAvLyBNb25pdG9yJ3MgY2FwLCBzbyB0aGVpciB3YXRjaCBuZXZlciBlbmRzIGJ5IGl0c2VsZi5cbiAgICAgIC4uLihvcHRzLmh1bWFuID8geyB3aW5kb3dNczogMCB9IDoge30pLFxuICAgICAgLy8gSWRzIGFyZSByZWNvdmVyZWQgYWNyb3NzIGEgcmVzdGFydCAoRDcwKSwgc28gYSBmcmFtZSBhdCBvciBiZWxvdyB0aGVcbiAgICAgIC8vIGJvb2ttYXJrIG5ldmVyIG1lYW5zIGEgcmVzdGFydGVkIGxvZyBoZXJlLlxuICAgICAgZXZlbnRMb2c6IGZhbHNlLFxuICAgICAgLy8gVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXIgKGFuZCB0aGUgZ3JvdW5kaW5nIGxpbmUgaXQgcmVuZGVycykgaXMgbm90IGFcbiAgICAgIC8vIG1lc3NhZ2Ugb24gdGhlIGNoYW5uZWwuXG4gICAgICBjb3VudHM6IChfZXYsIGZyYW1lKSA9PiBmcmFtZS5ldmVudCAhPT0gXCJzdWJzY3JpYmVkXCIsXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQgfSkgPT4gYWdhaW4oYXQpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoWy4uLnNlbGZDb21tYW5kKCksIFwiZG9jdG9yXCJdKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcblxuICAvKiogVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXI6IHN0ZGVyciBjb250ZXh0LCBwbHVzIGEgc3RydWN0dXJlZCBncm91bmRpbmcgbGluZVxuICAgKiAgb24gc3Rkb3V0IHRoZSBGSVJTVCB0aW1lIG9ubHkuICovXG4gIGZ1bmN0aW9uIHJlbmRlclN1YnNjcmliZWQocGF5bG9hZDogVGFpbFBheWxvYWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyBzdWJzY3JpYmVkIHRvICR7cGF5bG9hZC5jaGFubmVsfSAoc2luY2U9JHtwYXlsb2FkLnNpbmNlfSlcXG5gKTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgdG9waWM6ICR7cGF5bG9hZC50b3BpY31cXG5gKTtcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCB0aGlzIHRhaWwgYnJvdWdodCBpdCBpbnRvIGJlaW5nIChjaGVjayB0aGUgbmFtZSlcXG5gLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWRcXG5gLFxuICAgICAgKTtcbiAgICAvLyBTdHJ1Y3R1cmVkIGdyb3VuZGluZyBvbiBzdGRvdXQgKEYzL0Y3KSDigJQgdW5kZXIgdGhlIGRlZmF1bHQgV2lyaW5nLUJcbiAgICAvLyBNb25pdG9yLCBzdGRvdXQgc3VyZmFjZXMgYXMgbm90aWZpY2F0aW9ucywgc28gYSBmcmVzaCBzdWJzY3JpYmVyIGFjdHVhbGx5XG4gICAgLy8gc2VlcyB0aGUgdG9waWMgKyB0aGF0IGVhcmxpZXIgaGlzdG9yeSBleGlzdHMuIEdhdGVkOiBvbmx5IHdoZW4gdGhlcmUnc1xuICAgIC8vIHNvbWV0aGluZyB0byBncm91bmQgKHVuc2VlbiBoaXN0b3J5IG9yIGEgdG9waWMpLCBhbmQgb25seSBvbiB0aGUgZmlyc3RcbiAgICAvLyBzdWJzY3JpYmUgKG5vdCByZWNvbm5lY3RzKS5cbiAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICBjb25zdCBsYXRlc3QgPSB0eXBlb2YgcGF5bG9hZC5sYXRlc3RfaWQgPT09IFwibnVtYmVyXCIgPyBwYXlsb2FkLmxhdGVzdF9pZCA6IDA7XG4gICAgY29uc3QgZWFybGllciA9IHNpbmNlIDwgMCA/IGxhdGVzdCA6IE1hdGgubWF4KDAsIE1hdGgubWluKHNpbmNlLCBsYXRlc3QpKTtcbiAgICAvLyBgY3JlYXRlZGAgYW5kIGBhcmNoaXZlZGAgam9pbiB0aGUgZ2F0ZSBvbiBwdXJwb3NlLiBBIGNoYW5uZWwgdGhpc1xuICAgIC8vIHN1YnNjcmliZSBqdXN0IG1hZGUgaGFzIG5vIHRvcGljIGFuZCBubyBoaXN0b3J5LCBzbyB0aGUgb2xkIGNvbmRpdGlvblxuICAgIC8vIChgZWFybGllciA+IDAgfHwgdG9waWNgKSBpcyBleGFjdGx5IHRoZSBjYXNlIHRoYXQgZW1pdHMgTk9USElORzsgYW5kIGFuXG4gICAgLy8gQVJDSElWRUQgY2hhbm5lbCdzIGdyb3VuZGluZyBsaW5lIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgaGVhbHRoeVxuICAgIC8vIG9uZSdzLCBzbyBhIGxhdGUgam9pbmVyIHN0aWxsIGxlYXJuZWQgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQgb25seSB3aGVuXG4gICAgLy8gaXRzIHNlbmQgYm91bmNlZC5cbiAgICAvL1xuICAgIC8vIOKaoCBUaGUgaGludHMgQUNDVU1VTEFURSBpbnRvIGEgbGlzdCByYXRoZXIgdGhhbiBhc3NpZ25pbmcgdG8gb25lIGZpZWxkLlxuICAgIC8vIFRoZXkgdXNlZCB0byBiZSB0aHJlZSBhc3NpZ25tZW50cyB0byBgZ3JvdW5kaW5nLmhpbnRgLCBvcmRlcmVkIHNvIHRoZSBtb3N0XG4gICAgLy8gaW1wb3J0YW50IHdvbiDigJQgd2hpY2ggaXMgYSBoaW50IHRoYXQgY2FuIHNpbGVudGx5IGxvc2UgdG8gYW5vdGhlciBoaW50LFxuICAgIC8vIHRoZSBmYWlsdXJlIG1vZGUgdGhpcyB3aG9sZSBicmFuY2ggaXMgYWJvdXQsIHNpdHRpbmcgaW4gdGhlIGZpeCBmb3IgaXQuIEFcbiAgICAvLyBsaXN0IGNhbm5vdCBvdmVyd3JpdGU6IGFuIGFyY2hpdmVkIGNoYW5uZWwgV0lUSCBoaXN0b3J5IG5vdyBzYXlzIGJvdGguXG4gICAgY29uc3QgaGludHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKGVhcmxpZXIgPiAwKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7ZWFybGllcn0gZWFybGllciBtZXNzYWdlKHMpIGV4aXN0IOKAlCB1c2UgLS1mcm9tLXN0YXJ0IG9yIC0tc2luY2UgPGlkPiB0byBiYWNrZmlsbGAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgdGhpcyB0YWlsIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCBubyBzdWNoIGNoYW5uZWwgZXhpc3RlZDsgY2hlY2sgdGhlIG5hbWUsIG9yIGFub3RoZXIgcGFydHkgaGFzIHlldCB0byBvcGVuIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkIHVudGlsIHNvbWVvbmUgdW5hcmNoaXZlcyBpdGAsXG4gICAgICApO1xuICAgIGlmICghKGVhcmxpZXIgPiAwIHx8IHBheWxvYWQudG9waWMgfHwgcGF5bG9hZC5jcmVhdGVkIHx8IHBheWxvYWQuYXJjaGl2ZWQpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBncm91bmRpbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAga2luZDogXCJncm91bmRpbmdcIixcbiAgICAgIGNoYW5uZWw6IHBheWxvYWQuY2hhbm5lbCxcbiAgICAgIGpvaW5lZF9hdDogc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5taW4oc2luY2UsIGxhdGVzdCksXG4gICAgICBlYXJsaWVyLFxuICAgIH07XG4gICAgaWYgKHBheWxvYWQudG9waWMpIGdyb3VuZGluZy50b3BpYyA9IHBheWxvYWQudG9waWM7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZCkgZ3JvdW5kaW5nLmNyZWF0ZWQgPSB0cnVlO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKSBncm91bmRpbmcuYXJjaGl2ZWQgPSB0cnVlO1xuICAgIGlmIChoaW50cy5sZW5ndGgpIGdyb3VuZGluZy5oaW50ID0gaGludHMuam9pbihcIiDCtyBcIik7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGdyb3VuZGluZyk7XG4gIH1cbn1cbmZ1bmN0aW9uIGZvbGREaXNwb3NpdGlvbnMobmFtZTogc3RyaW5nKSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8XG4gICAgbnVtYmVyLFxuICAgIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBzdHJpbmc7XG4gICAgICBmcm9tOiBzdHJpbmc7XG4gICAgICB0czogbnVtYmVyO1xuICAgICAgbm90ZTogc3RyaW5nO1xuICAgICAgcmVvcGVuczogbnVtYmVyO1xuICAgIH1cbiAgPigpO1xuICBjb25zdCBwYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBtYXA7XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgIT09IFwic3RhdHVzXCIgfHwgdHlwZW9mIG0udGFyZ2V0ICE9PSBcIm51bWJlclwiIHx8IHR5cGVvZiBtLmRpc3Bvc2l0aW9uICE9PSBcInN0cmluZ1wiKVxuICAgICAgY29udGludWU7XG4gICAgY29uc3QgcHJldiA9IG1hcC5nZXQobS50YXJnZXQpO1xuICAgIGNvbnN0IHJlb3BlbnMgPVxuICAgICAgKHByZXY/LnJlb3BlbnMgPz8gMCkgK1xuICAgICAgKG0uZGlzcG9zaXRpb24gPT09IFwib3BlblwiICYmIHByZXYgJiYgcHJldi5kaXNwb3NpdGlvbiAhPT0gXCJvcGVuXCIgPyAxIDogMCk7XG4gICAgbWFwLnNldChtLnRhcmdldCwge1xuICAgICAgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24sXG4gICAgICBmcm9tOiBtLmZyb20sXG4gICAgICB0czogbS50cyxcbiAgICAgIG5vdGU6IG0udGV4dCxcbiAgICAgIHJlb3BlbnMsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cbi8vIFRXTyB0aGluZ3Mgbm93IHdlYXIga2luZDpcInN0YXR1c1wiLiBBIERJU1BPU0lUSU9OIGZyYW1lIGFjdHMgb24gYSBzcGVjaWZpY1xuLy8gbWVzc2FnZSAoYHRhcmdldGAgKyBgZGlzcG9zaXRpb25gKSBhbmQgaXMgbWV0YWRhdGEg4oCUIGBwdWxsYCBhbmQgYHRhaWxgIGZvbGRcbi8vIGl0IGF3YXkgYW5kIGJhZGdlIHRoZSBtZXNzYWdlIGl0IHBvaW50cyBhdCBpbnN0ZWFkLiBBIExJRkVDWUNMRSBmcmFtZVxuLy8gKGFyY2hpdmUgLyB1bmFyY2hpdmUpIGlzIGEgZmFjdCBhYm91dCB0aGUgQ0hBTk5FTDogaXQgdGFyZ2V0cyBub3RoaW5nLCBhbmQgaXRcbi8vIGlzIHRoZSB3aG9sZSBwb2ludCB0aGF0IGEgcmVhZGVyIHNlZXMgaXQuIERpc2NyaW1pbmF0aW5nIG9uIGBkaXNwb3NpdGlvbmBcbi8vIHJhdGhlciB0aGFuIG9uIGBldmVudGAga2VlcHMgYSBmcmFtZSBmcm9tIHNvbWUgZnV0dXJlIGVtaXR0ZXIgdmlzaWJsZSBieVxuLy8gZGVmYXVsdCDigJQgdGhlIGZhaWx1cmUgbW9kZSBoZXJlIGlzIHN3YWxsb3dpbmcgYSBzaWduYWwsIG5vdCBzaG93aW5nIG9uZS5cbmZ1bmN0aW9uIGlzRGlzcG9zaXRpb25GcmFtZShtOiB7IGtpbmQ/OiBzdHJpbmc7IGRpc3Bvc2l0aW9uPzogc3RyaW5nIH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG0ua2luZCA9PT0gXCJzdGF0dXNcIiAmJiB0eXBlb2YgbS5kaXNwb3NpdGlvbiA9PT0gXCJzdHJpbmdcIjtcbn1cblxuLy8gXCJvcGVuXCIgPSBubyBlbnRyeSwgb3IgbGF0ZXN0IGRpc3Bvc2l0aW9uIGlzIFwib3BlblwiXG5mdW5jdGlvbiBpc09wZW4oZD86IHsgZGlzcG9zaXRpb246IHN0cmluZyB9KSB7XG4gIHJldHVybiAhZCB8fCBkLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIjtcbn1cblxuLy8gUmVhZHMgdGhlIGZ1bGwgY2hhbm5lbCBsb2csIGRyb3BzIEVWRVJZIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSwgYW5kIGJhZGdlcyBlYWNoXG4vLyByZW1haW5pbmcgbWVzc2FnZSB3aXRoIGl0cyBsYXRlc3QgZGlzcG9zaXRpb24gdmlhIGZvbGREaXNwb3NpdGlvbnMuXG4vL1xuLy8gRXZlcnkgb25lLCBkZWxpYmVyYXRlbHkg4oCUIGluY2x1ZGluZyBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpLFxuLy8gd2hpY2ggYHB1bGxgIGFuZCBgdGFpbGAgZG8gbGV0IHRocm91Z2guIFRoaXMgZmVlZHMgYHRyaWFnZWAsIHdob3NlIG9wZW4gcXVldWVcbi8vIGlzIFwid2hhdCBpcyBsZWZ0IHRvIGFjdCBvblwiLCBhbmQgYW4gYXJjaGl2ZSBpcyBhbiBGWUksIG5vdCBhIHdvcmsgaXRlbS4gU2FtZVxuLy8gcmVhc29uIGB0b3BpY2AgYW5kIGBhbm5vdW5jZW1lbnRgIGFyZSBmb2xkZWQgb3V0IG9mIHRoZSBvcGVuIGJ1Y2tldCBiZWxvdy5cbmZ1bmN0aW9uIGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQoXG4gIG5hbWU6IHN0cmluZyxcbik6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdIHtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSByZXR1cm4gW107XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBtZXNzYWdlczogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCA9PT0gXCJzdGF0dXNcIikgY29udGludWU7XG4gICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgIGlmIChkKSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWVzc2FnZXMucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1lc3NhZ2VzO1xufVxuXG50eXBlIEJhZGdlZE1lc3NhZ2UgPSBNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9O1xuXG4vLyBEYXNoYm9hcmQgcmVuZGVyIG9mIGEgdHJpYWdlIHNjYW46IHRoZSBvcGVuIHF1ZXVlIG9uIHRvcCwgdGhlbiBlYWNoXG4vLyBkaXNwb3NpdGlvbiBncm91cCwgb25lIHNjYW5uYWJsZSBsaW5lIHBlciBtZXNzYWdlLiBNaXJyb3JzIGByZWFkIC0tdGV4dGBcbi8vIHByb3NlIG1vZGUgc28gYSBodW1hbiAob3IgYW4gYWdlbnQpIHJlYWRzIGl0IHdpdGhvdXQgcGFyc2luZyBKU09OLlxuZnVuY3Rpb24gcmVuZGVyVHJpYWdlSHVtYW4oXG4gIG5hbWU6IHN0cmluZyxcbiAgb3BlbjogQmFkZ2VkTWVzc2FnZVtdLFxuICBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4sXG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lID0gKG06IEJhZGdlZE1lc3NhZ2UpID0+IHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG0udHMpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKTtcbiAgICBjb25zdCByZW9wZW4gPSBtLnJlb3BlbnMgJiYgbS5yZW9wZW5zID4gMCA/IGAg4oa7JHttLnJlb3BlbnN9YCA6IFwiXCI7XG4gICAgLy8gVGhlIGZpcnN0IGxpbmUsIHdpdGhvdXQgYW4gaW5kZXggcmVhZCBgc3BsaXRgIHdvdWxkIG1ha2UgdGhlIGNvbXBpbGVyXG4gICAgLy8gZG91YnQ6IGBzcGxpdGAgbmV2ZXIgcmV0dXJucyBhbiBlbXB0eSBhcnJheSwgYW5kIHRoaXMgc2F5cyB0aGUgc2FtZSB0aGluZy5cbiAgICBjb25zdCBubCA9IG0udGV4dC5pbmRleE9mKFwiXFxuXCIpO1xuICAgIGNvbnN0IGhlYWQgPSBubCA9PT0gLTEgPyBtLnRleHQgOiBtLnRleHQuc2xpY2UoMCwgbmwpO1xuICAgIGNvbnN0IHByZXZpZXcgPSBoZWFkLmxlbmd0aCA+IDEwMCA/IGAke2hlYWQuc2xpY2UoMCwgOTkpfeKApmAgOiBoZWFkO1xuICAgIHJldHVybiBgICBbJHttLmlkfSR7cmVvcGVufV0gJHttLmZyb219IMK3ICR7dHN9IMK3ICR7cHJldmlld31gO1xuICB9O1xuICBjb25zdCBzZWN0aW9ucyA9IFtgJHtuYW1lfSDCtyB0cmlhZ2VcXG5gLCBgT1BFTiAoJHtvcGVuLmxlbmd0aH0pYF07XG4gIHNlY3Rpb25zLnB1c2gob3Blbi5sZW5ndGggPyBvcGVuLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpIDogXCIgIOKAlFwiKTtcbiAgZm9yIChjb25zdCBbc3RhdHVzLCBpdGVtc10gb2YgT2JqZWN0LmVudHJpZXMoYnlfc3RhdHVzKSkge1xuICAgIHNlY3Rpb25zLnB1c2goYFxcbiR7c3RhdHVzLnRvVXBwZXJDYXNlKCl9ICgke2l0ZW1zLmxlbmd0aH0pYCwgaXRlbXMubWFwKGxpbmUpLmpvaW4oXCJcXG5cIikpO1xuICB9XG4gIHJldHVybiBgJHtzZWN0aW9ucy5qb2luKFwiXFxuXCIpfVxcbmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRyaWFnZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdHM6IHsgaHVtYW4/OiBib29sZWFuIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgdHJpYWdlIDxjaGFubmVsPiBbLS1odW1hbl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gdHJpYWdlIHJlYWRzIHRoZSBsb2cgZmlsZSwgbm90IGEgcm91dGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93biDigJQgYW5kXG4gIC8vIGFuIGVtcHR5IGRhc2hib2FyZCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QgaXMgdGhlIHNhbWUgc2lsZW50IGxpZVxuICAvLyBhcyBhbiBlbXB0eSBgcHVsbGAuXG4gIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICBjb25zdCBvcGVuOiBCYWRnZWRNZXNzYWdlW10gPSBbXTtcbiAgY29uc3QgYnlfc3RhdHVzOiBSZWNvcmQ8c3RyaW5nLCBCYWRnZWRNZXNzYWdlW10+ID0ge307XG4gIGZvciAoY29uc3QgbSBvZiBiYWRnZWQpIHtcbiAgICAvLyBpc09wZW4gZXhwZWN0cyBhIGRpc3Bvc2l0aW9uIGVudHJ5IG9iamVjdCAob3IgdW5kZWZpbmVkIGZvciBubyBlbnRyeSkuXG4gICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICBpZiAoaXNPcGVuKGRpc3BBcmcpKSB7XG4gICAgICAvLyBUaGUgb3BlbiBxdWV1ZSBpcyBzaWduYWwtb25seTogc2tpcCBub24tYWN0aW9uYWJsZSBmcmFtZXMgKHRvcGljL1xuICAgICAgLy8gYW5ub3VuY2VtZW50IEZZSXMgY2FuIG5ldmVyIGNhcnJ5IGEgZGlzcG9zaXRpb24sIHNvIHRoZXknZCBvdGhlcndpc2VcbiAgICAgIC8vIHBhZCBcIndoYXQncyBsZWZ0P1wiIGZvcmV2ZXIpLlxuICAgICAgaWYgKG0ua2luZCA9PT0gXCJtZXNzYWdlXCIpIG9wZW4ucHVzaChtKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qga2V5ID0gbS5kaXNwb3NpdGlvbiA/PyBcInVua25vd25cIjtcbiAgICAgIGlmICghYnlfc3RhdHVzW2tleV0pIGJ5X3N0YXR1c1trZXldID0gW107XG4gICAgICBieV9zdGF0dXNba2V5XS5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICBpZiAob3B0cy5odW1hbikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHJlbmRlclRyaWFnZUh1bWFuKG5hbWUsIG9wZW4sIGJ5X3N0YXR1cykpO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgb3BlbiwgYnlfc3RhdHVzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRHcmVwKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHBhdHRlcm46IHN0cmluZyxcbiAgb3B0czogeyBsaXRlcmFsPzogYm9vbGVhbjsgZnJvbT86IHN0cmluZyB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhcGF0dGVybilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGdyZXAgPGNoYW5uZWw+IDxwYXR0ZXJuPiBbLS1saXRlcmFsfC1GXSBbLS1mcm9tIDxhbGlhcz5dXCIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgbWF0Y2hlcjogKHRleHQ6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgaWYgKG9wdHMubGl0ZXJhbCkge1xuICAgIGNvbnN0IG5lZWRsZSA9IHBhdHRlcm4udG9Mb3dlckNhc2UoKTtcbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUpO1xuICB9IGVsc2Uge1xuICAgIGxldCByZTogUmVnRXhwO1xuICAgIHRyeSB7XG4gICAgICByZSA9IG5ldyBSZWdFeHAocGF0dGVybiwgXCJpXCIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRpZShgaW52YWxpZCByZWdleDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCwgXCJ1c2FnZVwiKTtcbiAgICB9XG4gICAgbWF0Y2hlciA9ICh0ZXh0KSA9PiByZS50ZXN0KHRleHQpO1xuICB9XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpO1xuICBjb25zdCBtZXNzYWdlczogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGxldCBtc2c6IFBhcnRpYWw8TWVzc2FnZT47XG4gICAgdHJ5IHtcbiAgICAgIG1zZyA9IEpTT04ucGFyc2UobGluZSkgYXMgUGFydGlhbDxNZXNzYWdlPjtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAob3B0cy5mcm9tICYmIG1zZy5mcm9tICE9PSBvcHRzLmZyb20pIGNvbnRpbnVlO1xuICAgIGlmICghbWF0Y2hlcihtc2cudGV4dCkpIGNvbnRpbnVlO1xuICAgIG1lc3NhZ2VzLnB1c2gobXNnKTtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXMgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZENsb3NlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgY2xvc2UgPG5hbWU+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSBkaWUoXCJubyBkYWVtb24gcnVubmluZ1wiLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdGF0dXNSZXNwb25zZT4ocG9ydCwgXCJERUxFVEVcIiwgYC9jaGFubmVscy8ke25hbWV9YCk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc2V0KG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgb3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9O1xuICBpZiAob3B0cy5mb3JjZSkgYm9keS5mb3JjZSA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgc3Vic2NyaWJlcnM/OiBudW1iZXIgfT4oXG4gICAgcG9ydCxcbiAgICBcIlBPU1RcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vcmVzZXRgLFxuICAgIGJvZHksXG4gICk7XG4gIGlmIChzdGF0dXMgPT09IDQwOSAmJiBkYXRhPy5lcnJvciA9PT0gXCJsaXZlXCIpIHtcbiAgICBkaWUoXG4gICAgICBgY2hhbm5lbCBoYXMgJHtkYXRhLnN1YnNjcmliZXJzfSBsaXZlIHN1YnNjcmliZXIocykg4oCUIHJlZnVzaW5nIHRvIGNsZWFyIGEgbGl2ZSBzZXNzaW9uLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIGNsZWFyIGFueXdheSAodGhlIGxvZyBpcyBzbmFwc2hvdHRlZCBmaXJzdCkuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEFyY2hpdmUgKHJlYWQtb25seSkgb3IgdW5hcmNoaXZlIGEgY2hhbm5lbCAoVjEuNykg4oCUIHRoZSBub24tZGVzdHJ1Y3RpdmVcbi8vIGFsdGVybmF0aXZlIHRvIGNsb3NlOiBoaXN0b3J5IGlzIHByZXNlcnZlZCwgc2VuZHMgYXJlIHJlamVjdGVkLCBhbmQgdGhlIG5hbWVcbi8vIGlzIGxvY2tlZCBmcm9tIHJlLW9wZW4gdW50aWwgdW5hcmNoaXZlZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZE1hcmsoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWQ6IG51bWJlcixcbiAgZGlzcG9zaXRpb246IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICBvcHRzOiB7IG5vdGU/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkgfHwgIWRpc3Bvc2l0aW9uKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgbWFyayA8Y2hhbm5lbD4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSBbLS1hcyA8YWxpYXM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgZnJvbSwgdGFyZ2V0OiBpZCwgZGlzcG9zaXRpb24gfTtcbiAgaWYgKG9wdHMubm90ZSAhPT0gdW5kZWZpbmVkKSBib2R5Lm5vdGUgPSBvcHRzLm5vdGU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZT4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9zdGF0dXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhIGFzIHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1cyk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQXJjaGl2ZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIHVuYXJjaGl2ZTogYm9vbGVhbiwgZnJvbT86IHN0cmluZykge1xuICBjb25zdCB2ZXJiID0gdW5hcmNoaXZlID8gXCJ1bmFyY2hpdmVcIiA6IFwiYXJjaGl2ZVwiO1xuICBpZiAoIW5hbWUpIGRpZShgdXNhZ2U6IGdyYXBldmluZSAke3ZlcmJ9IDxjaGFubmVsPmApO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJvdGggcm91dGVzIGFwcGVuZCBhIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSB0byB0aGUgbG9nLCBzbyB3aG8gZGlkIGl0IGlzIHdvcnRoXG4gIC8vIHJlY29yZGluZyB3aGVuIHRoZSBjYWxsZXIgdG9sZCB1cy4gSWRlbnRpdHkgaXMgb3B0aW9uYWwgaGVyZSAoaXQgaXMgb24gdGhlXG4gIC8vIGdsb2JhbGx5LWFjY2VwdGVkIC0tYXMvLS1mcm9tKSwgYW5kIHRoZSBkYWVtb24gc2lnbnMgXCJzeXN0ZW1cIiB3aXRob3V0IGl0LlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS8ke3ZlcmJ9YCxcbiAgICBmcm9tID8geyBmcm9tIH0gOiB1bmRlZmluZWQsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0b3Aob3B0czogeyBob2xkU2Vjb25kcz86IG51bWJlciB9ID0ge30pIHtcbiAgbGV0IGhlbGRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBpZiAob3B0cy5ob2xkU2Vjb25kcyAmJiBvcHRzLmhvbGRTZWNvbmRzID4gMCkge1xuICAgIGhlbGRVbnRpbCA9IERhdGUubm93KCkgKyBvcHRzLmhvbGRTZWNvbmRzICogMTAwMDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhIT0xEX0ZJTEUsIFN0cmluZyhoZWxkVW50aWwpKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGRhZW1vbjogZmFsc2UsXG4gICAgICAuLi4oaGVsZFVudGlsICE9PSB1bmRlZmluZWQgPyB7IGhlbGRfdW50aWw6IGhlbGRVbnRpbCB9IDoge30pLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wcGVkOiB0cnVlLFxuICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBQZXItY2hhbm5lbCBsaXZlLWNvbm5lY3Rpb24gc3VtbWFyeSDigJQgdGhlIHJlc3RhcnQtc2FmZXR5IHJlYWQuIE1pcnJvcnMgd2hhdFxuLy8gYGRvY3RvcmAgcmVwb3J0cyB1bmRlciBhY3RpdmVfc3Vic2NyaWJlcnM7IG9ubHkgcG9wdWxhdGVkIGNoYW5uZWxzIGFyZSBsaXN0ZWQuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKFxuICBwb3J0OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgdG90YWw6IG51bWJlcjsgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+IH0+IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgY29uc3QgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgZm9yIChjb25zdCBjaCBvZiBkYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgdG90YWwgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICBpZiAoY2guY29ubmVjdGlvbnMgPiAwKSBjaGFubmVscy5wdXNoKHsgbmFtZTogY2gubmFtZSwgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zIH0pO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnQg4oCUIGEgcHJlc2VuY2UgaGljY3VwIHNob3VsZG4ndCBjcmFzaCBhIGxpZmVjeWNsZSB2ZXJiXG4gIH1cbiAgcmV0dXJuIHsgdG90YWwsIGNoYW5uZWxzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXJ0KCkge1xuICAvLyBFbnN1cmUtcnVubmluZywgbm8gY2hhbm5lbCBzaWRlLWVmZmVjdC4gSWRlbXBvdGVudDogcmVwb3J0IGFuIGV4aXN0aW5nXG4gIC8vIGRhZW1vbiwgb3Igc3Bhd24gYSBmcmVzaCBvbmUuIFRoZSBleHBsaWNpdCBcImJyaW5nIGl0IHVwXCIgdmVyYiDigJQgZGlhZ25vc3RpY3NcbiAgLy8gKGRvY3Rvci9pbmZvL2xpc3QpIHN0YXkgcmVhZC1vbmx5IGFuZCBuZXZlciBzcGF3bi5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIWV4aXN0aW5nICYmIGhvbGRBY3RpdmUoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBoZWxkOiB0cnVlLCBwb3J0OiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwb3J0ID0gZXhpc3RpbmcgPz8gKGF3YWl0IGVuc3VyZURhZW1vbigpKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHBvcnQsIGFscmVhZHlfcnVubmluZzogZXhpc3RpbmcgIT09IG51bGwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc3RhcnQob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gTm90aGluZyB0byB0ZWFyIGRvd24g4oCUIGp1c3QgYnJpbmcgYSBmcmVzaCBkYWVtb24gdXAuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTQUZFVFk6IGEgcmVzdGFydCBmb3JjZXMgZXZlcnkgY29ubmVjdGVkIGNsaWVudCB0byBhdXRvLXJlY29ubmVjdC4gUmVmdXNlIHRvXG4gIC8vIHRlYXIgZG93biBhIHdvcmtpbmcgZmxlZXQgdW5sZXNzIGV4cGxpY2l0bHkgZm9yY2VkIOKAlCBuZXZlciBzaWxlbnRseSBkcm9wIGl0LlxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcmVzdGFydDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7Y2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIOKAlCAke3doZXJlfS4gYCArXG4gICAgICAgIFwiQSByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gYWxsIHRvIHJlY29ubmVjdC4gUmUtcnVuIHdpdGggLS1mb3JjZSAob3IgLS15ZXMpIHRvIHByb2NlZWQgYW55d2F5LlwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FwdHVyZSB0aGUgcGlkIHdlJ3JlIHJlcGxhY2luZywgZm9yIHRoZSByZWNlaXB0LlxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgcHJldmlvdXNQaWQgPSBkYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wLCB0aGVuIHdhaXQgZm9yIHRoZSBvbGQgZGFlbW9uIHRvIGFjdHVhbGx5IGdvIGF3YXkg4oCUIGl0IHVubGlua3MgaXRzXG4gIC8vIHBvcnQvcGlkIGZpbGVzIG9uIHNodXRkb3duLCBzbyBlbnN1cmVEYWVtb24gc3Bhd25zIGZyZXNoIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRpc2NvdmVyaW5nIHRoZSBkeWluZyBvbmUuXG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCB9KTtcbn1cblxuLy8gYjMg4oCUIFRIRSBWRVJTSU9OIFZFUklGWSwgQVMgT05FIFNPVVJDRSBGT1IgQk9USCBQQVRIUy5cbi8vXG4vLyBgcm9sbGAgaXMgZG9jdW1lbnRlZCBhcyBcInRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcCDigKYgKyB2ZXJzaW9uIHZlcmlmeVwiLCBhbmRcbi8vIHRoZSB2ZXJpZnkgaGFkIHR3byB3YXlzIHRvIHNheSBub3RoaW5nOlxuLy9cbi8vICAgQ09MRCBQQVRIIOKAlCBubyBkYWVtb24gcnVubmluZzogaXQgc3Bhd25lZCBvbmUgYW5kIHByaW50ZWQgbmVpdGhlciBgdmVyc2lvbmBcbi8vICAgbm9yIGB2ZXJzaW9uX29rYC4gVGhlIGZpZWxkcyB3ZXJlIEFCU0VOVCwgc28gYSBjYWxsZXIgY2hlY2tpbmcgdGhlIHZlcmlmeVxuLy8gICBnb3QgYHVuZGVmaW5lZGAgb24gdGhlIGV4YWN0IHBhdGggd2hlcmUgdGhlIHZlcmlmeSBuZXZlciBoYXBwZW5lZC5cbi8vXG4vLyAgIFdBUk0gUEFUSCDigJQgdGhlIHByb2JlIHdhcyB3cmFwcGVkIGluIGBjYXRjaCB7fWAsIGxlYXZpbmcgYHZlcnNpb24gPSBudWxsYCxcbi8vICAgYW5kIGB2ZXJzaW9uX29rOiBudWxsID09PSBQTFVHSU5fVkVSU0lPTmAgZXZhbHVhdGVzIHRvIEZBTFNFLiBcIkkgY291bGQgbm90XG4vLyAgIGNoZWNrXCIgd2FzIHJlcG9ydGVkIGFzIFwidGhlIHZlcnNpb24gaXMgV1JPTkdcIiDigJQgYSBib29sZWFuIHRoYXQgY2Fubm90IHNheVxuLy8gICBcInVua25vd25cIiBpcyB0aGUgY2Fub25pY2FsIHNoYXBlIG9mIHRoaXMgc3ByaW50J3MgZGVmZWN0LCBhbmQgZmFsc2UgaXMgdGhlXG4vLyAgIHdvcnN0IGF2YWlsYWJsZSBhbnN3ZXIgYmVjYXVzZSBpdCBpcyBhY3Rpb25hYmxlIGFuZCBpbmNvcnJlY3QuXG4vL1xuLy8gU28gYHZlcnNpb25fb2tgIGlzIG5vdyBgYm9vbGVhbiB8IG51bGxgOiBudWxsIG1lYW5zIFVOQ0hFQ0tFRCwgbmV2ZXIgZmFsc2UuXG4vLyBgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uYCBpcyBwcmVzZW50LWFuZC1udWxsIGJlc2lkZSBpdCwgYmVjYXVzZSBhIGJhcmUgbnVsbFxuLy8gdGVsbHMgYSBjYWxsZXIgdGhlIGNoZWNrIGRpZCBub3QgaGFwcGVuIGFuZCBub3Qgd2h5LlxuLy9cbi8vIE9uZSBoZWxwZXIgcmF0aGVyIHRoYW4gdHdvIGNhbGwgc2l0ZXM6IGEgc2Vjb25kIGNvcHkgb2YgdGhpcyBsb2dpYyBvbiB0aGUgY29sZFxuLy8gcGF0aCBpcyB0aGUgbWlycm9yLWRyaWZ0IHRyYXAsIGFuZCB0aGUgY29sZCBwYXRoIGlzIHByZWNpc2VseSB0aGUgb25lIG5vYm9keVxuLy8gcmUtcmVhZHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVWZXJzaW9uKHBvcnQ6IG51bWJlcik6IFByb21pc2U8e1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB2ZXJzaW9uX29rOiBib29sZWFuIHwgbnVsbDtcbiAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBzdHJpbmcgfCBudWxsO1xufT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHYgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAodiA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBcInRoZSBkYWVtb24gYW5zd2VyZWQgYnV0IHJlcG9ydGVkIG5vIHZlcnNpb25cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IHZlcnNpb246IHYsIHZlcnNpb25fb2s6IHYgPT09IFBMVUdJTl9WRVJTSU9OLCB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IG51bGwgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogYGNvdWxkIG5vdCByZWFjaCB0aGUgZGFlbW9uIHRvIHZlcmlmeTogJHtcbiAgICAgICAgZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJvbGwob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gQ09MRCBQQVRIIOKAlCBub3RoaW5nIHdhcyBydW5uaW5nLCBzbyB0aGlzIGlzIGEgc3RhcnQgcmF0aGVyIHRoYW4gYSByb2xsLlxuICAgIC8vIEl0IHN0aWxsIHJlcG9ydHMgdGhlIHZlcmlmeSwgYmVjYXVzZSBcIm5vIGRhZW1vbiB3YXMgdXBcIiBpcyBub3QgYSByZWFzb24gdG9cbiAgICAvLyBzdGF5IHNpbGVudCBhYm91dCB3aGljaCB2ZXJzaW9uIGlzIG5vdyBzZXJ2aW5nLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgcm9sbGVkOiB0cnVlLFxuICAgICAgcHJldmlvdXNfcGlkOiBudWxsLFxuICAgICAgcG9ydDogZnJlc2gsXG4gICAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByb2xsOiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSDigJQgJHt3aGVyZX0uIFRoZXknbGwgYXV0by1yZWNvbm5lY3QgYWNyb3NzIHRoZSByb2xsLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIHByb2NlZWQuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcHJldmlvdXNQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3Agd2l0aCBhIHNob3J0IGhvbGQgc28gYSBzdGFsZSBDTEkgY2FuJ3Qgd2luIHRoZSByZXNwYXduIHJhY2U7IHdlIGhvbGQgdGhlIHNwYXduIG91cnNlbHZlcy5cbiAgY29uc3QgaG9sZE1zID0gNDAwMDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKERhdGUubm93KCkgKyBob2xkTXMpKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgaWYgKChhd2FpdCByZWFkRGFlbW9uUG9ydCgpKSA9PT0gbnVsbCkgYnJlYWs7XG4gIH1cbiAgcmVsZWFzZUhvbGQoKTsgLy8gb3VyIHR1cm4gdG8gc3Bhd24gdGhlIG5ldyB2ZXJzaW9uXG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGxldCBwaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIHBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KGZyZXNoLCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgcm9sbGVkOiB0cnVlLFxuICAgIHByZXZpb3VzX3BpZDogcHJldmlvdXNQaWQsXG4gICAgcGlkLFxuICAgIHBvcnQ6IGZyZXNoLFxuICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhdGNoKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAvLyBDaGFubmVsIG5hbWUgaXMgb3B0aW9uYWwg4oCUIHRoZSBwYWdlIHJlYWRzIGl0IGZyb20gdGhlIFVSTCBoYXNoIGFuZFxuICAvLyBkZWZhdWx0cyB0byBcImxvYmJ5XCIgaWYgYWJzZW50LiBXZSBwYXNzIHRocm91Z2ggd2hhdGV2ZXIgdGhlIHVzZXIgZ2F2ZVxuICAvLyAob3IgXCJsb2JieVwiKSBhbmQgb3BlbiB0aGUgYnJvd3Nlci4gRGFlbW9uIGlzIGVuc3VyZWQgc28gdGhlIHNlcnZlZFxuICAvLyAvd2F0Y2ggSFRNTCBpcyByZWFjaGFibGUuXG4gIGNvbnN0IGNoYW5uZWwgPSBuYW1lPy50cmltKCkgPyBuYW1lLnRyaW0oKSA6IFwibG9iYnlcIjtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBFbnN1cmUgdGhlIGNoYW5uZWwgZXhpc3RzIHNvIHRoZSBwYWdlIHNlZXMgYSB2YWxpZCBiYWNrbG9nL3RvcGljLlxuICBhd2FpdCBhcGkocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZTogY2hhbm5lbCB9KTtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS93YXRjaCMke2VuY29kZVVSSUNvbXBvbmVudChjaGFubmVsKX1gO1xuICAvLyBPcGVuIHRoZSBicm93c2VyIHZpYSB0aGUgcGxhdGZvcm0ncyBkZWZhdWx0IG9wZW5lci4gQmVzdC1lZmZvcnQg4oCUXG4gIC8vIHByaW50IHRoZSBVUkwgc28gdGhlIHVzZXIgY2FuIGNsaWNrIGl0IGlmIGF1dG8tb3BlbiBmYWlscy5cbiAgY29uc3Qgb3BlbmVyID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcImV4cGxvcmVyXCIgOiBcInhkZy1vcGVuXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgcCA9IHNwYXduKG9wZW5lciwgW3VybF0sIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgfSk7XG4gICAgcC51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBvcGVuZXIgbWlzc2luZyDigJQganVzdCBwcmludCAqL1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsLCB1cmwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZERvY3RvcigpIHtcbiAgLy8gUmVhZC1vbmx5IGRpYWdub3N0aWMuIFJlcG9ydHMgdGhlIGF1dGhvcml0YXRpdmUgZGFlbW9uIChpZiBhbnkpLCBvdGhlclxuICAvLyBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3NlcyB2aXNpYmxlIG9uIHRoZSBtYWNoaW5lLCBjaGFubmVsIGZpbGVzIG9uXG4gIC8vIGRpc2ssIGFuZCBzdXJmYWNlcyBoaW50cy4gRG9lcyBOT1QgdGFrZSBkZXN0cnVjdGl2ZSBhY3Rpb24g4oCUIGNsZWFudXBcbiAgLy8gaXMgdGhlIG9wZXJhdG9yJ3MgY2FsbCwgd2l0aCBzdG9jayB1bml4IHRvb2xzLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgbGV0IGF1dGhvcml0YXRpdmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gIC8vIFBlci1jaGFubmVsIHN1YnNjcmliZXIgc3VtbWFyeSDigJQgYW5zd2VycyBcImlzIGl0IHNhZmUgdG8gcmVzdGFydCB0aGVcbiAgLy8gZGFlbW9uIHJpZ2h0IG5vdz9cIiB3aXRob3V0IG5lZWRpbmcgdG8gYWxzbyBydW4gYGxpc3RgIGFuZCByZWFkIHRoZVxuICAvLyBvdXRwdXQuIEVtcHR5IGlmIG5vIGRhZW1vbiBpcyBydW5uaW5nLlxuICBsZXQgdG90YWxTdWJzY3JpYmVycyA9IDA7XG4gIGNvbnN0IGJ1c3lDaGFubmVsczogQXJyYXk8e1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAgIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gICAgbmFtZWQ6IG51bWJlcjtcbiAgICBhbm9ueW1vdXM6IG51bWJlcjtcbiAgfT4gPSBbXTtcbiAgaWYgKHBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICAgIGF1dGhvcml0YXRpdmUgPSB7IHBvcnQsIC4uLmRhdGEgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGRhZW1vbiB3ZW50IGF3YXkgYmV0d2VlbiBwb3J0IGNoZWNrIGFuZCBhcGkgY2FsbFxuICAgIH1cbiAgICB0cnkge1xuICAgICAgLy8gL3ByZXNlbmNlIGdpdmVzIHRoZSBob25lc3QgcGVyLWNoYW5uZWwgYnJlYWtkb3duIChjb25uZWN0aW9ucyB2cyBuYW1lZFxuICAgICAgLy8gdnMgYW5vbnltb3VzKSDigJQgc28gdGhlIHJlc3RhcnQtc2FmZXR5IHRvdGFsIGlzbid0IGEgbXlzdGVyeSBhbmQgYW5cbiAgICAgIC8vIGFub255bW91cyB3YXRjaCB0YWIgcmVhZHMgYXMgYSB3YXRjaGVyLCBub3QgYSBnaG9zdC5cbiAgICAgIGNvbnN0IHsgZGF0YTogcHJlc0RhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgcHJlc0RhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICAgIHRvdGFsU3Vic2NyaWJlcnMgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICAgIGJ1c3lDaGFubmVscy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBjaC5uYW1lLFxuICAgICAgICAgIHN1YnNjcmliZXJzOiBjaC5jb25uZWN0aW9ucywgLy8gYmFjay1jb21wYXQ6IHByZXZpb3VzbHkgdGhlIHJhdyBjb3VudFxuICAgICAgICAgIGNvbm5lY3Rpb25zOiBjaC5jb25uZWN0aW9ucyxcbiAgICAgICAgICBuYW1lZDogY2gubmFtZWQsXG4gICAgICAgICAgYW5vbnltb3VzOiBjaC5hbm9ueW1vdXMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gYmVzdC1lZmZvcnRcbiAgICB9XG4gIH1cblxuICAvLyBFbnVtZXJhdGUgb3RoZXIgZGFlbW9uIHByb2Nlc3NlcyB2aWEgdGhlIHNoYXJlZCBjbGFzc2lmaWVyLiBFYWNoIGVudHJ5XG4gIC8vIGdhaW5zIHBvcnQvaG9tZS92ZXJzaW9uL3N0YXR1cy9yZWFwYWJsZSBzbyB0aGUgb3BlcmF0b3IgaGFzIHRoZSBmdWxsXG4gIC8vIHBpY3R1cmUgd2l0aG91dCBuZWVkaW5nIGEgc2VwYXJhdGUgYHJlYXAgLS1kcnktcnVuYC5cbiAgY29uc3Qgb3RoZXJEYWVtb25zOiBBcnJheTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGNsYXNzaWZ5RGFlbW9uPj4gJiB7IGNvbW1hbmQ/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3Qgc2VsZlBpZCA9IGF1dGhvcml0YXRpdmU/LnBpZCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBwaWQgb2YgYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKSkge1xuICAgICAgaWYgKHNlbGZQaWQgJiYgcGlkID09PSBzZWxmUGlkKSBjb250aW51ZTtcbiAgICAgIG90aGVyRGFlbW9ucy5wdXNoKGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCkpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IGNhcnJ5IG9uIHdpdGggZW1wdHkgbGlzdFxuICB9XG5cbiAgLy8gQ2hhbm5lbHMgb24gZGlzayB1bmRlciB0aGlzIEhPTUUuXG4gIGNvbnN0IGNoYW5uZWxzT25EaXNrOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGNoYW5uZWxzRGlyID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZiBvZiByZWFkZGlyU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgICAgaWYgKGYuZW5kc1dpdGgoXCIuanNvbmxcIikpIGNoYW5uZWxzT25EaXNrLnB1c2goZi5yZXBsYWNlKC9cXC5qc29ubCQvLCBcIlwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHt9XG5cbiAgLy8gSGludHMg4oCUIHN1cmZhY2UgdGhlIG1vc3QgYWN0aW9uYWJsZSBzaWduYWxzLlxuICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIFwiTm8gYXV0aG9yaXRhdGl2ZSBkYWVtb24gcnVubmluZyBmb3IgdGhpcyBIT01FLiBSdW4gYW55IHZlcmIgKGUuZy4gYGNsaS50cyBsaXN0YCkgdG8gc3Bhd24gb25lLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG90aGVyRGFlbW9ucy5sZW5ndGggPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBGb3VuZCAke290aGVyRGFlbW9ucy5sZW5ndGh9IG90aGVyIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzcyhlcykgb24gdGhpcyBtYWNoaW5lLiBgICtcbiAgICAgICAgXCJUaGV5IG1heSBiZSB6b21iaWVzIGZyb20gcGFzdCBydW5zIE9SIGRhZW1vbnMgc2VydmluZyBvdGhlciBIT01FcyAoZGlmZmVyZW50IEdSQVBFVklORV9IT01FKS5cIixcbiAgICApO1xuICAgIGNvbnN0IHJlYXBhYmxlQ291bnQgPSBvdGhlckRhZW1vbnMuZmlsdGVyKChkKSA9PiBkLnJlYXBhYmxlKS5sZW5ndGg7XG4gICAgaWYgKHJlYXBhYmxlQ291bnQgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgRm91bmQgJHtyZWFwYWJsZUNvdW50fSByZWFwYWJsZSBvcnBoYW4gZGFlbW9uKHMpLiBSdW4gXFxgZ3JhcGV2aW5lIHJlYXBcXGAgdG8gY2xlYXIgdGhlbSBzYWZlbHkuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvdGhlckRhZW1vbnMuc29tZSgoZCkgPT4gZC5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIpKSB7XG4gICAgICBoaW50cy5wdXNoKFwiU29tZSBkYWVtb25zIGFyZSB1bnJlc3BvbnNpdmU7IGBncmFwZXZpbmUgcmVhcCAtLWZvcmNlYCBpbmNsdWRlcyB0aGVtLlwiKTtcbiAgICB9XG4gIH1cbiAgaWYgKFxuICAgIGF1dGhvcml0YXRpdmUgJiZcbiAgICBQTFVHSU5fVkVSU0lPTiAmJlxuICAgIHR5cGVvZiBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IFwic3RyaW5nXCIgJiZcbiAgICBhdXRob3JpdGF0aXZlLnZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OXG4gICkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgQXV0aG9yaXRhdGl2ZSBkYWVtb24gdmVyc2lvbiAoJHthdXRob3JpdGF0aXZlLnZlcnNpb259KSBkaWZmZXJzIGZyb20gdGhpcyBDTEkncyB2ZXJzaW9uICgke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICBcIlJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbiDigJQgZHJvcCBhY3RpdmUgdGFpbHMsIHRoZW4gYHN0b3BgLCB0aGVuIGFueSB2ZXJiLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGF1dGhvcml0YXRpdmUgJiYgKGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gbnVsbCB8fCBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IHVuZGVmaW5lZCkpIHtcbiAgICBoaW50cy5wdXNoKFwiQXV0aG9yaXRhdGl2ZSBkYWVtb24gcHJlZGF0ZXMgdmVyc2lvbiByZXBvcnRpbmcgKHByZS1WMS42LjIpLiBSZXN0YXJ0IHRvIGFsaWduLlwiKTtcbiAgfVxuICBpZiAodG90YWxTdWJzY3JpYmVycyA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYCR7dG90YWxTdWJzY3JpYmVyc30gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7YnVzeUNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKS4gYCArXG4gICAgICAgIFwiRGFlbW9uIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSB0byBhdXRvLXJlY29ubmVjdCAod29ya3MsIGJ1dCBkaXNydXB0aXZlKSDigJQgY29vcmRpbmF0ZSBmaXJzdC5cIixcbiAgICApO1xuICB9IGVsc2UgaWYgKGF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFwiTm8gYWN0aXZlIHN1YnNjcmliZXJzIOKAlCBkYWVtb24gcmVzdGFydCBpcyBub24tZGlzcnVwdGl2ZS5cIik7XG4gIH1cbiAgLy8gRXhwbGFpbiBhbnkgY2hhbm5lbCB3aGVyZSB0aGUgY29ubmVjdGlvbiBjb3VudCBleGNlZWRzIG5hbWVkIGFnZW50cyDigJQgYW5cbiAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiBpbmZsYXRlcyBgY291bnRgL2Bjb25uZWN0aW9uc2AgYnV0IGlzbid0IGEgZ2hvc3QuXG4gIGZvciAoY29uc3QgY2ggb2YgYnVzeUNoYW5uZWxzKSB7XG4gICAgaWYgKGNoLmFub255bW91cyA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2NoLm5hbWV9OiAke2NoLmNvbm5lY3Rpb25zfSBjb25uZWN0aW9uKHMpLCAke2NoLm5hbWVkfSBuYW1lZCBhZ2VudChzKSArIGAgK1xuICAgICAgICAgIGAke2NoLmFub255bW91c30gYW5vbnltb3VzIChlLmcuIGEgd2F0Y2ggdGFiKS4gVGhlIGNvdW50IG92ZXIgdGhlIG5hbWUgbGlzdCBpcyBleHBlY3RlZCwgbm90IGEgZ2hvc3QuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBob21lOiBEQVRBX0RJUixcbiAgICBjbGlfdmVyc2lvbjogUExVR0lOX1ZFUlNJT04sXG4gICAgYXV0aG9yaXRhdGl2ZSxcbiAgICBhY3RpdmVfc3Vic2NyaWJlcnM6IHtcbiAgICAgIHRvdGFsOiB0b3RhbFN1YnNjcmliZXJzLFxuICAgICAgYnVzeV9jaGFubmVsczogYnVzeUNoYW5uZWxzLFxuICAgIH0sXG4gICAgb3RoZXJfZGFlbW9uc19vbl9tYWNoaW5lOiBvdGhlckRhZW1vbnMsXG4gICAgY2hhbm5lbHNfb25fZGlzazogY2hhbm5lbHNPbkRpc2ssXG4gICAgaGludHMsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRJbmZvKCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gZW51bWVyYXRpb24gKyBjbGFzc2lmaWVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogQWxsIGdyYXBldmluZSBkYWVtb24udHMgcGlkcyB2aXNpYmxlIG9uIHRoaXMgbWFjaGluZSAodmlhIGBwc2ApLiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuICBjb25zdCBwaWRzOiBudW1iZXJbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcInBzXCIsIFtcIi1lb1wiLCBcInBpZCxjb21tYW5kXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY29uc3Qgb3V0ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmLThcIik7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKFwiZGFlbW9uLnRzXCIpKSBjb250aW51ZTtcbiAgICAgIGlmICghbGluZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZ3JhcGV2aW5lXCIpKSBjb250aW51ZTtcbiAgICAgIC8vIFRoZSBwaWQgZ3JvdXAgaXMgbWFuZGF0b3J5OyBhbiB1bm1hdGNoZWQgbGluZSBpcyBza2lwcGVkLCBhcyBiZWZvcmUuXG4gICAgICBjb25zdCBkaWdpdHMgPSBsaW5lLm1hdGNoKC9eXFxzKihcXGQrKVxccysvKT8uWzFdO1xuICAgICAgaWYgKGRpZ2l0cyA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBpZCA9IHBhcnNlSW50KGRpZ2l0cywgMTApO1xuICAgICAgaWYgKHBpZCkgcGlkcy5wdXNoKHBpZCk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwcyB1bmF2YWlsYWJsZTsgcmV0dXJuIGVtcHR5XG4gIH1cbiAgcmV0dXJuIHBpZHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxzb2ZMaXN0ZW5Qb3J0KHBpZDogbnVtYmVyKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcHJvYyA9IHNwYXduKFwibHNvZlwiLCBbXCItYWlUQ1BcIiwgXCItc1RDUDpMSVNURU5cIiwgXCItcFwiLCBTdHJpbmcocGlkKSwgXCItUFwiLCBcIi1uXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcigpKSk7XG4gICAgLy8gVGhlIHBvcnQgZ3JvdXAgaXMgbWFuZGF0b3J5OyBubyBtYXRjaCBpcyB0aGlzIGZ1bmN0aW9uJ3Mgb3duIGBudWxsYC5cbiAgICBjb25zdCBkaWdpdHMgPSBCdWZmZXIuY29uY2F0KGNodW5rcylcbiAgICAgIC50b1N0cmluZyhcInV0Zi04XCIpXG4gICAgICAubWF0Y2goLzEyN1xcLjBcXC4wXFwuMTooXFxkKykvKT8uWzFdO1xuICAgIHJldHVybiBkaWdpdHMgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBwYXJzZUludChkaWdpdHMsIDEwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IHR5cGUgRGFlbW9uU3RhdHVzID0gXCJhdXRob3JpdGF0aXZlXCIgfCBcIm9ycGhhblwiIHwgXCJ1bnJlc3BvbnNpdmVcIiB8IFwidW5rbm93blwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnlEYWVtb24ocGlkOiBudW1iZXIpOiBQcm9taXNlPHtcbiAgcGlkOiBudW1iZXI7XG4gIHBvcnQ6IG51bWJlciB8IG51bGw7XG4gIGhvbWU/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IERhZW1vblN0YXR1cztcbiAgcmVhcGFibGU6IGJvb2xlYW47XG59PiB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBsc29mTGlzdGVuUG9ydChwaWQpO1xuICBpZiAoIXBvcnQpIHJldHVybiB7IHBpZCwgcG9ydDogbnVsbCwgc3RhdHVzOiBcInVua25vd25cIiwgcmVhcGFibGU6IGZhbHNlIH07XG4gIGxldCBpbmZvOiBSb290SW5mbyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDgwMCksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykgaW5mbyA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgfSBjYXRjaCB7fVxuICBpZiAoIWluZm8pIHJldHVybiB7IHBpZCwgcG9ydCwgc3RhdHVzOiBcInVucmVzcG9uc2l2ZVwiLCByZWFwYWJsZTogZmFsc2UgfTsgLy8gcmVhcCBvbmx5IHdpdGggLS1mb3JjZSAoaGFuZGxlZCBpbiBjbWRSZWFwKVxuICBjb25zdCBob21lID0gaW5mby5kYXRhX2RpciBhcyBzdHJpbmc7XG4gIGxldCBvd25zID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3AgPSByZWFkRmlsZVN5bmMoam9pbihob21lLCBcImRhZW1vbi5wb3J0XCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBjb25zdCBvaSA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBpZFwiKSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgb3ducyA9IG9wID09PSBTdHJpbmcocG9ydCkgJiYgb2kgPT09IFN0cmluZyhwaWQpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBvd25zXG4gICAgPyB7XG4gICAgICAgIHBpZCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgaG9tZSxcbiAgICAgICAgdmVyc2lvbjogaW5mby52ZXJzaW9uID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogXCJhdXRob3JpdGF0aXZlXCIsXG4gICAgICAgIHJlYXBhYmxlOiBmYWxzZSxcbiAgICAgIH1cbiAgICA6IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcIm9ycGhhblwiLFxuICAgICAgICByZWFwYWJsZTogdHJ1ZSxcbiAgICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYXAob3B0czogeyBmb3JjZT86IGJvb2xlYW47IGRyeVJ1bj86IGJvb2xlYW4gfSkge1xuICBjb25zdCBzZWxmUG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7IC8vIGN1cnJlbnQgSE9NRSBhdXRob3JpdGF0aXZlIChuZXZlciByZWFwKVxuICBsZXQgc2VsZlBpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGlmIChzZWxmUG9ydCkge1xuICAgIHRyeSB7XG4gICAgICBzZWxmUGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4oc2VsZlBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGNvbnN0IHBpZHMgPSBhd2FpdCBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpO1xuICBjb25zdCBrZXB0OiB1bmtub3duW10gPSBbXSxcbiAgICByZWFwZWQ6IHVua25vd25bXSA9IFtdLFxuICAgIHNraXBwZWQ6IHVua25vd25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBpZCBvZiBwaWRzKSB7XG4gICAgY29uc3QgYyA9IGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCk7XG4gICAgY29uc3QgaXNTZWxmID0gcGlkID09PSBzZWxmUGlkO1xuICAgIGNvbnN0IHNob3VsZFJlYXAgPVxuICAgICAgIWlzU2VsZiAmJiAoYy5yZWFwYWJsZSB8fCAoYy5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIgJiYgb3B0cy5mb3JjZSA9PT0gdHJ1ZSkpO1xuICAgIGlmICghc2hvdWxkUmVhcCkge1xuICAgICAga2VwdC5wdXNoKGMpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChvcHRzLmRyeVJ1bikge1xuICAgICAgc2tpcHBlZC5wdXNoKHsgLi4uYywgbm90ZTogXCJkcnktcnVuXCIgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3Mua2lsbChwaWQsIFwiU0lHVEVSTVwiKTtcbiAgICAgIHJlYXBlZC5wdXNoKGMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgc2tpcHBlZC5wdXNoKHsgLi4uYywgbm90ZTogXCJraWxsIGZhaWxlZFwiIH0pO1xuICAgIH1cbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZHJ5X3J1bjogISFvcHRzLmRyeVJ1biwga2VwdCwgcmVhcGVkLCBza2lwcGVkIH0pO1xufVxuXG4vLyAoQk9PTEVBTl9GTEFHUyB3YXMgaGVyZS4gSXQgbGlzdGVkIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUg4oCUIGhhbGYgYVxuLy8gcmVnaXN0cnksIGNvbnN1bHRlZCBieSB0aGUgaGFuZC1yb2xsZWQgcGFyc2VyLiBJdHMgMTMgZW50cmllcyBub3cgbGl2ZSBpblxuLy8gQ0xJX09QVElPTlMgYmVsb3cgYXMgYHt0eXBlOlwiYm9vbGVhblwifWAsIHZlcmlmaWVkIDEzLWZvci0xMyBhZ2FpbnN0IHRob3RoJ3Ncbi8vIGluZGVwZW5kZW50bHktZGVyaXZlZCBhcnRpZmFjdCBiZWZvcmUgdGhlIG1vdmUuIERlbGV0ZWQgcmF0aGVyIHRoYW4gbGVmdFxuLy8gYmVzaWRlIGl0cyByZXBsYWNlbWVudDogYSBzZWNvbmQgc291cmNlIG9mIHRydXRoIGZvciB0aGUgc2FtZSBmYWN0IGlzIHRoZVxuLy8gZHJpZnQgYnVnIHRoaXMgbGFuZSBleGlzdHMgdG8gcmVtb3ZlLCBhbmQgaXQgd291bGQgbm8gbG9uZ2VyIGJlIGNvbnN1bHRlZFxuLy8gYnkgYW55dGhpbmcuKVxuXG4vLyBTaWduYXR1cmUgb2YgYSBoZXJlZG9jIGZ1bWJsZTogYSBsaW5lIHRoYXQgaXMgKG9yIGJlZ2lucyB3aXRoKSBhXG4vLyBgYnVuIOKApiBjbGkudHMg4oCmIHNlbmRgIGludm9jYXRpb24uIFdoZW4gYSBgc2VuZCAtLXN0ZGluIDw8RU9GYCBpcyBib3RjaGVkLCB0aGVcbi8vIHNoZWxsIHBpcGVzIHRoZSBsaXRlcmFsIGNvbW1hbmQgbGluZSBpbiBhcyB0aGUgYm9keSwgd2hpY2ggdGhlbiBnZXRzIHBvc3RlZCDigJRcbi8vIGNvcnJ1cHRpbmcgdGhlIGNoYW5uZWwgd2l0aCBgYnVuIC/igKYvY2xpLnRzIHNlbmQgPGNoYW5uZWw+IC0tYXMg4oCmIDx0ZXh0PmAuXG4vLyBXZSByZWZ1c2UgdG8gcG9zdCBzdWNoIGEgYm9keSB1bmxlc3MgLS1mb3JjZSBpcyBwYXNzZWQuXG5jb25zdCBMRUFLRURfU0VORF9SRSA9IC8oPzpefFxcbilbIFxcdF0qYnVuXFxiW15cXG5dKlxcYmNsaVxcLnRzXFxiW15cXG5dKlxcYig/OnNlbmR8YW5ub3VuY2UpXFxiLztcbmZ1bmN0aW9uIGxvb2tzTGlrZUxlYWtlZFNlbmQodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBMRUFLRURfU0VORF9SRS50ZXN0KHRleHQpO1xufVxuXG4vLyBTaGVsbC1tZXRhY2hhcmFjdGVyIGZvb3RndW4gKCM2MCk6IGEgYm9keSBwYXNzZWQgYXMgYW4gSU5MSU5FIHBvc2l0aW9uYWwgYXJnXG4vLyBpcyBleHBvc2VkIHRvIHRoZSBjYWxsZXIncyBzaGVsbCwgd2hpY2ggY29tbWFuZC1zdWJzdGl0dXRlcyBiYWNrdGlja3MgL1xuLy8gYCQoLi4uKWAgLyBgJHsuLi59YCBCRUZPUkUgZ3JhcGV2aW5lIHNlZXMgaXQg4oCUIGNvcnJ1cHRpbmcgb3IgcGFydGlhbGx5XG4vLyBleGVjdXRpbmcgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLiBUaGUgQ0xJIGNhbid0IHVuLXN1YnN0aXR1dGUgd2hhdCB0aGUgc2hlbGxcbi8vIGFscmVhZHkgYXRlOyB0aGUgaG9uZXN0IGZpeCBpcyB0byBzdGVlciBjYWxsZXJzIHRvIHRoZSBzaGVsbC1mcmVlIHBhdGhzXG4vLyAoLS1ib2R5LWZpbGUgLyAtLXN0ZGluIC8gZGVmYXVsdC1zdGRpbikuIFdoZW4gbWV0YWNoYXJhY3RlcnMgU1VSVklWRSBpbnRvIGFuXG4vLyBpbmxpbmUgYm9keSAoZS5nLiB0aGUgY2FsbGVyIGhhcHBlbmVkIHRvIHNpbmdsZS1xdW90ZSksIHRoZXkncmUgaW50YWN0IHRoaXNcbi8vIHRpbWUg4oCUIGJ1dCB0aGUgcGF0dGVybiBpcyBhIGxhdGVudCBmb290Z3VuLCBzbyB3ZSB3YXJuIChuZXZlciBibG9jazogdGhlXG4vLyBtZXNzYWdlIGlzIGZpbmUgYXMgcmVjZWl2ZWQpLiBBYnNlbnQtbWV0YWNoYXIgaW5saW5lIGJvZGllcyBhcmUgZWl0aGVyIHBsYWluXG4vLyB0ZXh0IChzYWZlKSBvciBhbHJlYWR5LXN1YnN0aXR1dGVkICh1bmRldGVjdGFibGUpIOKAlCBzbyB3ZSBvbmx5IHdhcm4gb24gdGhlXG4vLyBkZXRlY3RhYmxlIHJpc2t5IHBhdHRlcm4uXG5jb25zdCBTSEVMTF9NRVRBQ0hBUl9SRSA9IC9gfFxcJFxcKHxcXCRcXHsvO1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzU2hlbGxSaXNreSh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFNIRUxMX01FVEFDSEFSX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS5cbi8vXG4vLyBncmFwZXZpbmUgYWxyZWFkeSBoYWQgSEFMRiBhIHJlZ2lzdHJ5OiBgQk9PTEVBTl9GTEFHU2AgYWJvdmUgdG9sZCB0aGUgcGFyc2VyXG4vLyB3aGljaCBmbGFncyB0YWtlIG5vIHZhbHVlLiBXaGF0IGl0IGhhZCBubyBub3Rpb24gb2Ygd2FzIHdoaWNoIGZsYWdzIEVYSVNULCBzb1xuLy8gYW4gdW5rbm93biBmbGFnIHdhcyBhY2NlcHRlZCBhdCBleGl0IDAgYW5kIHRoZSB2ZXJiIHJhbiBhbnl3YXksIGFuZCBmcmVlIHByb3NlXG4vLyBjb250YWluaW5nIGEgYC0td29yZGAgd2FzIHNpbGVudGx5IHRydW5jYXRlZCBhdCB0aGF0IHdvcmQuXG4vL1xuLy8g4pqgIGdyYXBldmluZSBpcyB0aGUgT1VUTElFUiBvZiB0aGUgc2l4LCBhbmQgaXQgaXMgd29ydGggc2F5aW5nIHdoeSBzbyBub2JvZHlcbi8vIHJlYWRzIGl0IGFzIG1lcmVseSBiZWhpbmQ6IGl0IHR5cGVzIGl0cyB2YWx1ZSBmbGFncyB3aXRoIGEgQ0FTVFxuLy8gKGBmbGFncy50b3BpYyBhcyBzdHJpbmcgfCB1bmRlZmluZWRgKSB3aGVyZSB0aGUgb3RoZXIgZW50cnkgcG9pbnRzIHVzZSBhXG4vLyBgdHlwZW9mYCBndWFyZC4gQSBjYXN0IGlzIGEgY2xhaW0gd2l0aCBOTyBSVU5USU1FIENIRUNLLCBzbyBncmFwZXZpbmUgY2FycmllZFxuLy8gYSBjbGFzcyBvZiBsYXRlbnQgdHlwZS1saWUgdGhlIG90aGVycyB3ZXJlIGd1YXJkZWQgYWdhaW5zdCDigJQgYW5kIGJhcmUgdmFsdWVcbi8vIGZsYWdzIHByb2R1Y2VkIHNpbGVudCB3cm9uZyB2YWx1ZXMgcmF0aGVyIHRoYW4gZXJyb3JzOlxuLy9cbi8vICAgLS1sYXN0ICAgYmFyZSAgLT4gIHBhcnNlSW50KHRydWUsIDEwKSAgLT4gIE5hTiwgc2lsZW50bHlcbi8vICAgLS10b3BpYyAgYmFyZSAgLT4gIGB0cnVlYCBpbiBhIGZpZWxkIERFQ0xBUkVEIGBzdHJpbmdgXG4vL1xuLy8gYHN0cmljdDogdHJ1ZWAgdHVybnMgZWFjaCBvZiB0aG9zZSBmcm9tIGEgc2lsZW50IHdyb25nIHZhbHVlIGludG8gYVxuLy8gY2FsbGVyLWZhY2luZyBlcnJvciwgd2hpY2ggaXMgdGhlIGxhbmUncyB3aG9sZSBwdXJwb3NlIGFuZCB0aGUgbGFyZ2VzdFxuLy8gYmVoYXZpb3VyIGRlbHRhIG9mIHRoZSBzaXggZW50cnkgcG9pbnRzLlxuLy9cbi8vIFRoZSBib29sZWFuIHNldCBiZWxvdyBpcyBCT09MRUFOX0ZMQUdTLCB1bmNoYW5nZWQg4oCUIGV4dHJhY3RlZCBmcm9tIHRoaXMgZmlsZVxuLy8gYW5kIGRpZmZlZCBhZ2FpbnN0IHRob3RoJ3MgaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0OiAxMyBmb3IgMTMsIGV4YWN0LFxuLy8gemVybyBkaXZlcmdlbmNlIGluIGVpdGhlciBkaXJlY3Rpb24uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hhbm5lbHM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaG9sZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiaW4tcmVwbHktdG9cIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBtYXg6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBub3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdG9waWM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBhbGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJkcnktcnVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZm9yY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZnJlc2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJmcm9tLXN0YXJ0XCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgaHVtYW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbGl0ZXJhbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsdXJrOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHF1aWV0OiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRleHQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdmVyYm9zZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB5ZXM6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogQSBwYXJzZS1zdGFnZSByZWplY3Rpb24sIGNhcnJ5aW5nIHRoZSBlbnVtZXJhdGlvbiBpdCB3YW50cyB0byBwdWJsaXNoLlxuICpcbiAqIOKblCBUSEUgYGV4dHJhYCBJUyBXSFkgVEhJUyBDTEFTUyBTVVJWSVZFRCBUSEUgYGVycm9ycy50c2AgQURPUFRJT04uIFRoZVxuICogcmVqZWN0aW9uIGhhcyB0byBOQU1FIGl0cyB2YWxpZCBzZXQg4oCUIHRoYXQgaXMgdGhlIHdob2xlIHJlYXNvbiBncmFwZXZpbmUnc1xuICogcGFyc2VyIGVycm9ycyB3ZXJlIHNoYXBlZCB0aGUgd2F5IHRoZXkgd2VyZSDigJQgYW5kIHRoZSB0aHJvdyBoYXBwZW5zIHR3byBmcmFtZXNcbiAqIGJlbG93IHRoZSBwbGFjZSB0aGF0IGtub3dzIHRoZSBzZXQuIGBjaG9pY2VzYCBpcyB3aGVyZSB0aGUgaG91c2UgZW52ZWxvcGVcbiAqIGNhcnJpZXMgYW4gZW51bWVyYXRpb24sIHNvIHRoZSBjbGFzcyBob2xkcyBpdCB1bnRpbCBgcnVuQ29tbWFuZGAgcmFpc2VzLlxuICovXG5jbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIlVzYWdlRXJyb3JcIjtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cbn1cblxudHlwZSBGbGFnTmFtZSA9IGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUztcbnR5cGUgRmxhZ3MgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcblxuLy8gSWRlbnRpdHkgaXMgY29udHJhY3R1YWxseSBHTE9CQUw6IFNLSUxMLm1kIHRlbGxzIGFnZW50cyB0byBwYXNzIC0tYXMvLS1mcm9tXG4vLyBvbiBFVkVSWSB2ZXJiIChhIGZyZXNoIHNoZWxsIHBlciBjb21tYW5kIG1lYW5zIEdSQVBFVklORV9GUk9NIG5ldmVyXG4vLyBwZXJzaXN0cyksIHNvIGV2ZXJ5IGNvbW1hbmQgYWNjZXB0cyBib3RoIOKAlCBldmVuIHdoZXJlIGEgdmVyYiBoYXMgbm8gdXNlIGZvclxuLy8gaWRlbnRpdHksIGEgY2FsbGVyIGZvbGxvd2luZyBvdXIgb3duIGRvY3MgbXVzdCBub3QgYmUgcmVqZWN0ZWQgZm9yIG9iZXlpbmdcbi8vIHRoZW0uIE9uIGBncmVwYCwgYC0tZnJvbWAgaXMgYW4gYXV0aG9yIEZJTFRFUiByYXRoZXIgdGhhbiBpZGVudGl0eTogZGlmZmVyZW50XG4vLyBzZW1hbnRpY3MsIHNhbWUgYWNjZXB0YW5jZS5cbmNvbnN0IEdMT0JBTF9GTEFHUzogRmxhZ05hbWVbXSA9IFtcImFzXCIsIFwiZnJvbVwiXTtcblxudHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbi8vIFRIRSBDT01NQU5EIFRBQkxFLCBBUyBBIFNUUlVDVFVSRSDigJQgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsIHRoZSBzY2hlbWFcbi8vIGVtaXR0ZXIgYW5kIHRoZSByb290IHJlamVjdGlvbiBhbGwgd2FsayBUSElTLiBJdCByZXBsYWNlZCBhIGJhcmUgYHN3aXRjaGAsXG4vLyB3aGljaCBvbmx5IHRoZSBkaXNwYXRjaGVyIGNvdWxkIHdhbGs6IGEgc2NoZW1hIGVtaXR0ZWQgZnJvbSBhbnl0aGluZyBvdGhlclxuLy8gdGhhbiB0aGUgc3RydWN0dXJlIHRoYXQgcm91dGVzIHRoZSBiZWhhdmlvdXIgaXMgYSBkb2N1bWVudCB0aGF0IGxpZXMgYXMgc29vblxuLy8gYXMgYW55b25lIGVkaXRzIHRoZSBvdGhlciBzaWRlIChhY2MgU1RBTkRBUkQubWQgUGFydCAxIMKnMjsgb3VyIG93biAjODEvRDRcbi8vIGxhbmUgbGVhcm5lZCB0aGUgc2FtZSBsZXNzb24gb25lIGFsdGl0dWRlIGRvd24gd2l0aCBCT09MRUFOX0ZMQUdTKS5cbi8vXG4vLyBgZmxhZ3NgIGlzIHRoZSB2ZXJiJ3MgT1dOIGFjY2VwdGVkIHNldCAoR0xPQkFMX0ZMQUdTIGFyZSBtZXJnZWQgaW4gYnlcbi8vIGBhY2NlcHRlZEZsYWdzYCkuIEEgZmxhZyBub3QgbGlzdGVkIGhlcmUgaXMgUkVKRUNURUQgZm9yIHRoaXMgdmVyYiB3aXRoIHRoZVxuLy8gdmVyYidzIG93biBzZXQgZW51bWVyYXRlZCDigJQgYWNjZXB0ZWQtYW5kLWlnbm9yZWQgaXMgdGhlIGRpc2Vhc2UgdGhpcyB0YWJsZVxuLy8gZXhpc3RzIHRvIGN1cmUgKGFjYyBEVC0xOiBhbnRoaWxsIGFjY2VwdGluZyBhIHJvb3QgYC0tZm9ybWF0YCBpdCBzaWxlbnRseVxuLy8gZGlzY2FyZHM7IGdyYXBldmluZSBhY2NlcHRpbmcgYHNlbmQgLS1kcnktcnVuYCBhbmQgZG9pbmcgbm90aGluZyB3YXMgdGhlXG4vLyBzYW1lIGV2ZW50IHdpdGggYSBkaWZmZXJlbnQgc3BlbGxpbmcpLlxudHlwZSBDb21tYW5kU3BlYyA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBhbGlhc2VzPzogc3RyaW5nW107XG4gIGZsYWdzOiBGbGFnTmFtZVtdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqXG4gICAqIOKaoCBNQVkgUkVUVVJOIEFOIEVYSVQgQ09ERSwgQU5EIEVYQUNUTFkgT05FIFZFUkIgRE9FUy4gYHRhaWxgIHJ1bnMgdGhlIHNoYXJlZFxuICAgKiBjbGllbnQgKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLCB3aGljaCBSRVRVUk5TIGEgY29kZSByYXRoZXIgdGhhblxuICAgKiBlbmRpbmcgdGhlIHByb2Nlc3MgZnJvbSBpbnNpZGUgdGhyZWUgbmVzdGVkIGxvb3BzIOKAlCBzbyB0aGUgY29kZSBoYXMgdG8gcmVhY2hcbiAgICogYG1haW5gLCBhbmQgdGhpcyBpcyB0aGUgc2VhbSBpdCBjcm9zc2VzLiBBbnl0aGluZyB0aGF0IGlzIG5vdCBhIG51bWJlciBtZWFuc1xuICAgKiAwLCB3aGljaCBpcyB3aGF0IHRoZSBvdGhlciB0d2VudHktb2RkIHZlcmJzIHJldHVybi5cbiAgICpcbiAgICog4pqgIFR5cGVkIGB1bmtub3duYCByYXRoZXIgdGhhbiBhIHVuaW9uIHdpdGggYHZvaWRgOiBhIHVuaW9uIGlzIHdoYXQgYSByZWFkZXJcbiAgICogd291bGQgd3JpdGUgZmlyc3QsIGFuZCBldmVyeSBgYXN5bmNgIHZlcmIgdGhhdCBlbmRzIHdpdGhvdXQgYSBgcmV0dXJuYCBpc1xuICAgKiBgUHJvbWlzZTx2b2lkPmAsIHdoaWNoIGlzIE5PVCBhc3NpZ25hYmxlIHRvIGBQcm9taXNlPG51bWJlciB8IHVuZGVmaW5lZD5gLlxuICAgKiBUaGUgd2lkZW5pbmcgaGFwcGVucyBhdCB0aGUgb25lIHBsYWNlIHRoYXQgcmVhZHMgdGhlIHZhbHVlLCBiZWxvdy5cbiAgICovXG4gIHJ1bjogKHBvc2l0aW9uYWw6IHN0cmluZ1tdLCBmbGFnczogRmxhZ3MpID0+IHVua25vd247XG59O1xuXG4vLyBBIGRlY2xhcmVkIHZhbHVlIGZsYWcgdGhhdCBjYXJyaWVzIGEgbnVtYmVyIG11c3QgUkVKRUNUIGEgbm9uLW51bWJlciBhcyBhXG4vLyB1c2FnZSBlcnJvciAoZXhpdCAyKSwgbm90IGNyYXNoIG9uIGl0IGRvd25zdHJlYW0g4oCUIGBzY2hlbWFgIHB1Ymxpc2hlcyB0aGVcbi8vIGZsYWcgYXMgdmFsaWQsIHNvIHRoZSBwYXJzZSBib3VuZGFyeSBpcyB3aGVyZSBhIGJhZCB2YWx1ZSBnZXRzIGl0c1xuLy8gY2FsbGVyLWZhY2luZyBhbnN3ZXIuIChgd2FpdCAtLXRpbWVvdXQgbm90YW51bWJlcmAgdXNlZCB0byB0aHJvdyBhblxuLy8gdW5oYW5kbGVkIFJhbmdlRXJyb3IgYXQgZXhpdCAxLCBzdGFjayB0cmFjZSBhbmQgYWxsLilcbmZ1bmN0aW9uIG51bWVyaWNGbGFnKHZlcmI6IHN0cmluZywgbmFtZTogc3RyaW5nLCByYXc6IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxsYmFjaztcbiAgY29uc3QgbiA9IE51bWJlcihyYXcpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSB8fCBuIDwgMClcbiAgICBkaWUoYCR7dmVyYn06IC0tJHtuYW1lfSBleHBlY3RzIGEgbm9uLW5lZ2F0aXZlIG51bWJlciwgZ290ICR7SlNPTi5zdHJpbmdpZnkoU3RyaW5nKHJhdykpfWApO1xuICByZXR1cm4gbjtcbn1cblxuLy8gQm9keSByZXNvbHV0aW9uIHNoYXJlZCBieSBzZW5kL2Fubm91bmNlIOKAlCBmaXJzdCBtYXRjaCB3aW5zOiAtLWJvZHktZmlsZSxcbi8vIC0tc3RkaW4sIGlubGluZSBwb3NpdGlvbmFscywgZGVmYXVsdC1zdGRpbiB3aGVuIHBpcGVkLiBTZWUgdGhlIHBlci12ZXJiXG4vLyBjb21tZW50cyBhdCB0aGUgb3JpZ2luYWwgc2l0ZXMgKFYxLjYvIzYwKTsgYmVoYXZpb3VyIHVuY2hhbmdlZC5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVCb2R5KFxuICB2ZXJiOiBcInNlbmRcIiB8IFwiYW5ub3VuY2VcIixcbiAgaW5saW5lOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IEZsYWdzLFxuKTogUHJvbWlzZTx7IHRleHQ6IHN0cmluZzsgZnJvbUlubGluZTogYm9vbGVhbiB9PiB7XG4gIGlmIChmbGFnc1tcImJvZHktZmlsZVwiXSkge1xuICAgIGNvbnN0IHBhdGggPSBmbGFnc1tcImJvZHktZmlsZVwiXSBhcyBzdHJpbmc7XG4gICAgY29uc3QgZmlsZSA9IEJ1bi5maWxlKHBhdGgpO1xuICAgIGlmICghKGF3YWl0IGZpbGUuZXhpc3RzKCkpKSBkaWUoYCR7dmVyYn06IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwYXRofWAsIFwibm90X2ZvdW5kXCIpO1xuICAgIHJldHVybiB7IHRleHQ6IChhd2FpdCBmaWxlLnRleHQoKSkucmVwbGFjZSgvXFxuJC8sIFwiXCIpLCBmcm9tSW5saW5lOiBmYWxzZSB9O1xuICB9XG4gIGlmIChmbGFncy5zdGRpbiB8fCAoaW5saW5lLmxlbmd0aCA9PT0gMCAmJiAhcHJvY2Vzcy5zdGRpbi5pc1RUWSkpIHtcbiAgICBjb25zdCBidWY6IEJ1ZmZlcltdID0gW107XG4gICAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBwcm9jZXNzLnN0ZGluKSBidWYucHVzaChjaHVuayBhcyBCdWZmZXIpO1xuICAgIHJldHVybiB7XG4gICAgICB0ZXh0OiBCdWZmZXIuY29uY2F0KGJ1ZikudG9TdHJpbmcoXCJ1dGYtOFwiKS5yZXBsYWNlKC9cXG4kLywgXCJcIiksXG4gICAgICBmcm9tSW5saW5lOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IHRleHQ6IGlubGluZS5qb2luKFwiIFwiKSwgZnJvbUlubGluZTogdHJ1ZSB9O1xufVxuXG4vLyBUaGUgdHdvIGJvZHkgZ3VhcmRzIHNoYXJlZCBieSBzZW5kL2Fubm91bmNlOiByZWZ1c2UgYSBsZWFrZWQgaW52b2NhdGlvblxuLy8gKGZ1bWJsZWQgaGVyZWRvYykgdW5sZXNzIC0tZm9yY2UsIGFuZCB3YXJuIG9uIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIHRoYXRcbi8vIHN1cnZpdmVkIGFuIGlubGluZSBib2R5ICgjNjAg4oCUIHdhcm4sIG5ldmVyIGJsb2NrKS5cbmZ1bmN0aW9uIGd1YXJkQm9keSh2ZXJiOiBcInNlbmRcIiB8IFwiYW5ub3VuY2VcIiwgdGV4dDogc3RyaW5nLCBmcm9tSW5saW5lOiBib29sZWFuLCBmb3JjZTogYm9vbGVhbikge1xuICBpZiAoIWZvcmNlICYmIGxvb2tzTGlrZUxlYWtlZFNlbmQodGV4dCkpIHtcbiAgICBkaWUoXG4gICAgICBgJHt2ZXJifTogdGhhdCBib2R5IGxvb2tzIGxpa2UgYSBsZWFrZWQgZ3JhcGV2aW5lIGludm9jYXRpb24gKGEgZnVtYmxlZCBgICtcbiAgICAgICAgXCJoZXJlZG9jPykuIE5vdGhpbmcgd2FzIHNlbnQuIFBpcGUgdGhlIHJlYWwgYm9keSB2aWEgLS1zdGRpbiBvciBcIiArXG4gICAgICAgIFwiLS1ib2R5LWZpbGUgPHBhdGg+LCBvciBwYXNzIC0tZm9yY2UgdG8gc2VuZCBpdCBhbnl3YXkuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZnJvbUlubGluZSAmJiBsb29rc1NoZWxsUmlza3kodGV4dCkpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIFwiIyDimqAgaW5saW5lIGJvZHkgY29udGFpbnMgc2hlbGwgbWV0YWNoYXJhY3RlcnMgKGJhY2t0aWNrLCAkKCksIGN1cmx5LWJyYWNlIHZhcnMpLiBcIiArXG4gICAgICAgIFwiSXQgd2FzIHNlbnQgYXMtaXMsIGJ1dCB0aGUgc2hlbGwgY2FuIGNvbW1hbmQtc3Vic3RpdHV0ZSB0aGVzZSBiZWZvcmUgXCIgK1xuICAgICAgICBcImdyYXBldmluZSBzZWVzIHRoZW0g4oCUIHVzZSAtLWJvZHktZmlsZSBvciAtLXN0ZGluIGZvciBjb2RlLWJlYXJpbmcgbWVzc2FnZXMuXFxuXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIOKblCBSRUdJU1RFUiBBMSDigJQgYGNob2ljZXNgIElTIGBHTE9CQUxfRkxBR1NgLCBUSEUgU0VUIGByZXNvbHZlQWxpYXNgIFJFQURTLlxuICogVGhpcyBpcyBhIERJU0pVTkNUSU9OIChlaXRoZXIgZmxhZyBzYXRpc2ZpZXMgaXQpLCBzbyB0aGUgY2FsbGVyIGhhcyB0byBwaWNrLFxuICogYW5kIGl0IGlzIHRoZSBvbmUgaWRlbnRpdHkgcmVmdXNhbCBmb3VyIHZlcmJzIHNoYXJlLiBUaGUgZW52IHZhciBzdGF5cyBpblxuICogYGhpbnRgIGFuZCBkZWxpYmVyYXRlbHkgTk9UIGluIGBjaG9pY2VzYDogYGNob2ljZXNgIGVudW1lcmF0ZXMgQ09NTUFORFxuICogVE9LRU5TIOKAlCB3aGF0IHdvdWxkIGhhdmUgYmVlbiBhY2NlcHRlZCBJTiBUSEUgSU5WT0NBVElPTiDigJQgYW5kIHB1dHRpbmcgYW5cbiAqIGVudmlyb25tZW50IG5hbWUgaW4gdGhlIHNhbWUgYXJyYXkgd291bGQgZ2l2ZSBhIGNhbGxlciBhIFwiY2hvaWNlXCIgaXQgY2Fubm90XG4gKiBwYXNzIG9uIHRoZSBjb21tYW5kIGxpbmUuXG4gKi9cbmNvbnN0IGlkZW50aXR5UmVxdWlyZWQgPSAodmVyYjogc3RyaW5nKTogbmV2ZXIgPT5cbiAgZGllKGAke3ZlcmJ9OiBpZGVudGl0eSByZXF1aXJlZGAsIFwidXNhZ2VcIiwge1xuICAgIGhpbnQ6IGBwYXNzICR7R0xPQkFMX0ZMQUdTLm1hcCgoZikgPT4gYC0tJHtmfWApLmpvaW4oXCIvXCIpfSA8YWxpYXM+LCBvciBzZXQgR1JBUEVWSU5FX0ZST01gLFxuICAgIGNob2ljZXM6IEdMT0JBTF9GTEFHUy5tYXAoKGYpID0+IGAtLSR7Zn1gKSxcbiAgfSk7XG5cbi8vIOKaoCBFVkVSWSBDT01NQU5EIEZVTkNUSU9OIEJFTE9XIFJFRlVTRVMgQSBNSVNTSU5HIFBPU0lUSU9OQUwgT04gSVRTIE9XTiBGSVJTVFxuLy8gTElORSAoYSB1c2FnZSByZWZ1c2FsIHdoZW4gdGhlIG5hbWUgaXMgZmFsc3kpLCBhbmQgZWFjaCBub3cgZGVjbGFyZXMgdGhhdCBwYXJhbWV0ZXJcbi8vIGBzdHJpbmcgfCB1bmRlZmluZWRgIHNvIGl0cyBzaWduYXR1cmUgc2F5cyB3aGF0IHRoYXQgbGluZSBkb2VzICh0eXBlLWRlYnRcbi8vIFQzNSkuIEFyaXR5IGRpc3BhdGNoIHJlZnVzZXMgYSBtaXNzaW5nIHJlcXVpcmVkIHBvc2l0aW9uYWwgYmVmb3JlIGFueSBvZlxuLy8gdGhlbSBydW5zLCBzbyB0aGUgZ3VhcmRzIGFyZSB0aGUgc2Vjb25kIGxpbmUgb2YgZGVmZW5jZSwgbm90IHRoZSBmaXJzdC5cbmNvbnN0IENPTU1BTkRTOiBDb21tYW5kU3BlY1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcInRvcGljXCIsIFwiZnJlc2hcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kT3Blbihwb3NpdGlvbmFsWzBdLCB7XG4gICAgICAgIHRvcGljOiBmbGFncy50b3BpYyBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICAgIGZyb206IHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICAgIGZyZXNoOiBmbGFncy5mcmVzaCA9PT0gdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRvcGljXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRvcGljKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICBwb3NpdGlvbmFsLmxlbmd0aCA+IDEgPyBwb3NpdGlvbmFsLnNsaWNlKDEpLmpvaW4oXCIgXCIpIDogdW5kZWZpbmVkLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJsaXN0XCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZExpc3QoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZW5kXCIsXG4gICAgZmxhZ3M6IFtcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwicXVpZXRcIiwgXCJ2ZXJib3NlXCIsIFwiZm9yY2VcIiwgXCJpbi1yZXBseS10b1wiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBuYW1lID0gcG9zaXRpb25hbFswXTtcbiAgICAgIGNvbnN0IGZyb20gPSByZXNvbHZlQWxpYXMoZmxhZ3MpO1xuICAgICAgY29uc3QgeyB0ZXh0LCBmcm9tSW5saW5lIH0gPSBhd2FpdCByZXNvbHZlQm9keShcInNlbmRcIiwgcG9zaXRpb25hbC5zbGljZSgxKSwgZmxhZ3MpO1xuICAgICAgaWYgKCFmcm9tKSBpZGVudGl0eVJlcXVpcmVkKFwic2VuZFwiKTtcbiAgICAgIGd1YXJkQm9keShcInNlbmRcIiwgdGV4dCwgZnJvbUlubGluZSwgISFmbGFncy5mb3JjZSk7XG4gICAgICBhd2FpdCBjbWRTZW5kKG5hbWUsIGZyb20gYXMgc3RyaW5nLCB0ZXh0LCB7XG4gICAgICAgIHF1aWV0OiAhIWZsYWdzLnF1aWV0LFxuICAgICAgICB2ZXJib3NlOiAhIWZsYWdzLnZlcmJvc2UsXG4gICAgICAgIGluUmVwbHlUbzogZmxhZ3NbXCJpbi1yZXBseS10b1wiXVxuICAgICAgICAgID8gbnVtZXJpY0ZsYWcoXCJzZW5kXCIsIFwiaW4tcmVwbHktdG9cIiwgZmxhZ3NbXCJpbi1yZXBseS10b1wiXSwgMClcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFubm91bmNlXCIsXG4gICAgZmxhZ3M6IFtcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwicXVpZXRcIiwgXCJmb3JjZVwiLCBcImNoYW5uZWxzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHJlc29sdmVBbGlhcyhmbGFncyk7XG4gICAgICBjb25zdCB7IHRleHQsIGZyb21JbmxpbmUgfSA9IGF3YWl0IHJlc29sdmVCb2R5KFwiYW5ub3VuY2VcIiwgcG9zaXRpb25hbCwgZmxhZ3MpO1xuICAgICAgaWYgKCFmcm9tKSBpZGVudGl0eVJlcXVpcmVkKFwiYW5ub3VuY2VcIik7XG4gICAgICBndWFyZEJvZHkoXCJhbm5vdW5jZVwiLCB0ZXh0LCBmcm9tSW5saW5lLCAhIWZsYWdzLmZvcmNlKTtcbiAgICAgIGNvbnN0IGNoYW5uZWxzID0gZmxhZ3MuY2hhbm5lbHNcbiAgICAgICAgPyAoZmxhZ3MuY2hhbm5lbHMgYXMgc3RyaW5nKVxuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgoYykgPT4gYy50cmltKCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgYXdhaXQgY21kQW5ub3VuY2UoZnJvbSBhcyBzdHJpbmcsIHRleHQsIGNoYW5uZWxzLCB7IHF1aWV0OiAhIWZsYWdzLnF1aWV0IH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInB1bGxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJzdGF0dXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3Qgc2luY2UgPSBudW1lcmljRmxhZyhcInB1bGxcIiwgXCJzaW5jZVwiLCBmbGFncy5zaW5jZSwgMCk7XG4gICAgICBhd2FpdCBjbWRQdWxsKHBvc2l0aW9uYWxbMF0sIHNpbmNlLCB7IHN0YXR1czogZmxhZ3Muc3RhdHVzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0cmlhZ2VcIixcbiAgICBmbGFnczogW1wiaHVtYW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kVHJpYWdlKHBvc2l0aW9uYWxbMF0sIHsgaHVtYW46ICEhZmxhZ3MuaHVtYW4gfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhZFwiLFxuICAgIGZsYWdzOiBbXCJ0ZXh0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgaWQgPSBwb3NpdGlvbmFsWzFdID8gcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApIDogTmFOO1xuICAgICAgYXdhaXQgY21kUmVhZChwb3NpdGlvbmFsWzBdLCBpZCwgeyB0ZXh0OiAhIWZsYWdzLnRleHQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2FpdFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcInRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3Qgc2luY2UgPSBudW1lcmljRmxhZyhcIndhaXRcIiwgXCJzaW5jZVwiLCBmbGFncy5zaW5jZSwgMCk7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gbnVtZXJpY0ZsYWcoXCJ3YWl0XCIsIFwidGltZW91dFwiLCBmbGFncy50aW1lb3V0LCAzMCk7XG4gICAgICBhd2FpdCBjbWRXYWl0KHBvc2l0aW9uYWxbMF0sIHNpbmNlLCB0aW1lb3V0LCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3aG9cIixcbiAgICBmbGFnczogW1wiYWxsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBpZiAoZmxhZ3MuYWxsKSBhd2FpdCBjbWRXaG9BbGwoKTtcbiAgICAgIGVsc2UgYXdhaXQgY21kV2hvKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFsaWFzXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFsaWFzKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJmcm9tLXN0YXJ0XCIsIFwibGFzdFwiLCBcImh1bWFuXCIsIFwibHVya1wiLCBcIm1heFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICByZXR1cm4gYXdhaXQgY21kVGFpbChwb3NpdGlvbmFsWzBdLCB7XG4gICAgICAgIHNpbmNlOiBmbGFncy5zaW5jZSAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJ0YWlsXCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApIDogdW5kZWZpbmVkLFxuICAgICAgICBmcm9tU3RhcnQ6ICEhZmxhZ3NbXCJmcm9tLXN0YXJ0XCJdLFxuICAgICAgICBsYXN0OiBmbGFncy5sYXN0ICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInRhaWxcIiwgXCJsYXN0XCIsIGZsYWdzLmxhc3QsIDApIDogdW5kZWZpbmVkLFxuICAgICAgICBhczogcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICAgaHVtYW46ICEhZmxhZ3MuaHVtYW4sXG4gICAgICAgIGx1cms6ICEhZmxhZ3MubHVyayxcbiAgICAgICAgbWF4OiByZXNvbHZlVGFpbE1heChmbGFncy5tYXgpLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JlcFwiLFxuICAgIGZsYWdzOiBbXCJsaXRlcmFsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInBhdHRlcm5cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kR3JlcChwb3NpdGlvbmFsWzBdLCBwb3NpdGlvbmFsLnNsaWNlKDEpLmpvaW4oXCIgXCIpLCB7XG4gICAgICAgIGxpdGVyYWw6ICEhZmxhZ3MubGl0ZXJhbCxcbiAgICAgICAgZnJvbTogZmxhZ3MuZnJvbSBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZENsb3NlKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlc2V0XCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlc2V0KHBvc2l0aW9uYWxbMF0sIHsgZm9yY2U6IGZsYWdzLmZvcmNlID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1hcmtcIixcbiAgICBmbGFnczogW1wibm90ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImRpc3Bvc2l0aW9uXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE1hcmsoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIC8vIE5hTiBmb3IgYSBtaXNzaW5nIGlkLCBleGFjdGx5IHdoYXQgYHBhcnNlSW50KHVuZGVmaW5lZClgIGdhdmUg4oCUIGFuZFxuICAgICAgICAvLyBgY21kTWFya2AgcmVmdXNlcyBhIG5vbi1maW5pdGUgaWQgb24gaXRzIGZpcnN0IGxpbmUuXG4gICAgICAgIHBvc2l0aW9uYWxbMV0gPT09IHVuZGVmaW5lZCA/IE51bWJlci5OYU4gOiBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIHBvc2l0aW9uYWwuc2xpY2UoMikuam9pbihcIiBcIiksXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncykgPz8gaWRlbnRpdHlSZXF1aXJlZChcIm1hcmtcIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRNYXJrKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICAvLyBOYU4gZm9yIGEgbWlzc2luZyBpZCwgZXhhY3RseSB3aGF0IGBwYXJzZUludCh1bmRlZmluZWQpYCBnYXZlIOKAlCBhbmRcbiAgICAgICAgLy8gYGNtZE1hcmtgIHJlZnVzZXMgYSBub24tZmluaXRlIGlkIG9uIGl0cyBmaXJzdCBsaW5lLlxuICAgICAgICBwb3NpdGlvbmFsWzFdID09PSB1bmRlZmluZWQgPyBOdW1iZXIuTmFOIDogcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBcIm9wZW5cIixcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwicmVvcGVuXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCBmYWxzZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidW5hcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFyY2hpdmUocG9zaXRpb25hbFswXSwgdHJ1ZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhcnRcIixcbiAgICBhbGlhc2VzOiBbXCJ1cFwiXSxcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kU3RhcnQoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXN0YXJ0XCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlc3RhcnQoeyBmb3JjZTogISFmbGFncy5mb3JjZSB8fCAhIWZsYWdzLnllcyB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyb2xsXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJvbGwoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfHwgZmxhZ3MueWVzID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0b3BcIixcbiAgICBmbGFnczogW1wiaG9sZFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdG9wKHtcbiAgICAgICAgaG9sZFNlY29uZHM6XG4gICAgICAgICAgZmxhZ3MuaG9sZCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJzdG9wXCIsIFwiaG9sZFwiLCBmbGFncy5ob2xkLCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhdGNoXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZFdhdGNoKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYXBcIixcbiAgICBhbGlhc2VzOiBbXCJwcnVuZVwiXSxcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJkcnktcnVuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlYXAoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUsIGRyeVJ1bjogZmxhZ3NbXCJkcnktcnVuXCJdID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kSW5mbygpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWREb2N0b3IoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIC8vIFRoZSBDTEkgY2FuIGJlIEFTS0VEIHdoYXQgaXQgaXMuIGdyYXBldmluZSBhbHJlYWR5IGNhcnJpZXNcbiAgICAgIC8vIFBMVUdJTl9WRVJTSU9OIHRvIHdhcm4gdGhhdCBhIGRhZW1vbiBpcyBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZCBwbHVnaW5cbiAgICAgIC8vIHBhdGggdGhhbiB0aGlzIENMSSAobWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gpIOKAlCBidXQgYSBjYWxsZXIgdGhhdCBoaXRcbiAgICAgIC8vIHRoYXQgd2FybmluZywgb3IgdGhhdCBydW5zIGByb2xsYCBmb3IgaXRzIHZlcnNpb24gdmVyaWZ5LCBoYWQgbm8gd2F5IHRvXG4gICAgICAvLyBhc2sgdGhpcyBzaWRlIHdoYXQgaXQgaXMgaG9sZGluZy4gVGhlIHZhbHVlIHdhcyBhbHJlYWR5IGluIG1lbW9yeTsgb25seVxuICAgICAgLy8gdGhlIHF1ZXN0aW9uIHdhcyBtaXNzaW5nLlxuICAgICAgLy8gSlNPTiBieSBkZWZhdWx0LCBtYXRjaGluZyBldmVyeSBkYXRhIGNvbW1hbmQ7IC0taHVtYW4gZm9yIHByb3NlLlxuICAgICAgaWYgKFBMVUdJTl9WRVJTSU9OID09PSBudWxsKVxuICAgICAgICBkaWUoXCJ2ZXJzaW9uIHVuYXZhaWxhYmxlIOKAlCBjb3VsZCBub3QgcmVhZCBwbHVnaW4uanNvblwiLCBcImludGVybmFsXCIpO1xuICAgICAgaWYgKGZsYWdzLmh1bWFuID09PSB0cnVlKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIHYke1BMVUdJTl9WRVJTSU9OfVxcbmApO1xuICAgICAgZWxzZSBwcmludEpzb24oeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgLy8gRW1pdCB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIOKAlCBnZW5lcmF0ZWQgYnlcbiAgICAgIC8vIFdBTEtJTkcgQ09NTUFORFMgYW5kIENMSV9PUFRJT05TLCB0aGUgc2FtZSBzdHJ1Y3R1cmVzIHRoZSBwYXJzZXIgYW5kXG4gICAgICAvLyBkaXNwYXRjaGVyIGNvbnN1bWUsIGF0IGFuc3dlciB0aW1lLiBObyBkYWVtb24sIG5vIGNvbmZpZywgbm9cbiAgICAgIC8vIGNyZWRlbnRpYWxzOyBzdGRvdXQsIGV4aXQgMC4gVGhlIHNoYXBlIGlzIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjBcbiAgICAgIC8vIGV4YWN0bHksIHNvIHRoZSBvdXRwdXQgcGlwZXMgc3RyYWlnaHQgaW50b1xuICAgICAgLy8gYGFjYyBjaGVjayA8Y2xpPiAtLWRlY2xhcmF0aW9uIDwoZ3JhcGV2aW5lIHNjaGVtYSlgIHdpdGggbm8gYWRhcHRlci5cbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcmludEhlbHAoKTtcbiAgICB9LFxuICB9LFxuXTtcblxuZnVuY3Rpb24gZmluZENvbW1hbmQodG9rZW46IHN0cmluZyk6IENvbW1hbmRTcGVjIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIENPTU1BTkRTLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gdG9rZW4gfHwgYy5hbGlhc2VzPy5pbmNsdWRlcyh0b2tlbikpO1xufVxuXG4vLyBUaGUgdmVyYidzIGZ1bGwgYWNjZXB0ZWQgc2V0OiBpdHMgb3duIGZsYWdzIHBsdXMgdGhlIGNvbnRyYWN0dWFsbHktZ2xvYmFsXG4vLyBpZGVudGl0eSBwYWlyLCBpbiByZWdpc3RyeSBvcmRlci5cbmZ1bmN0aW9uIGFjY2VwdGVkRmxhZ3Moc3BlYzogQ29tbWFuZFNwZWMpOiBGbGFnTmFtZVtdIHtcbiAgY29uc3Qgb3duID0gbmV3IFNldDxGbGFnTmFtZT4oWy4uLkdMT0JBTF9GTEFHUywgLi4uc3BlYy5mbGFnc10pO1xuICByZXR1cm4gKE9iamVjdC5rZXlzKENMSV9PUFRJT05TKSBhcyBGbGFnTmFtZVtdKS5maWx0ZXIoKGspID0+IG93bi5oYXMoaykpO1xufVxuXG4vLyBSb290IGludGVyY2VwdG9ycyDigJQgZmxhZ3MgdGhlIFJPT1QgYW5zd2VycyBpdHNlbGYsIGJlZm9yZSBhbnkgdmVyYi4gVGhlc2UgYXJlXG4vLyBub3QgY29tbWFuZHMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IGEgZ2VuZXJhdG9yIHdhbGtpbmcgXCJ0aGUgY29tbWFuZHNcIiB3YWxrc1xuLy8gcGFzdCB0aGVtIChhY2MgRFQtNik7IHRoZXkgYXJlIGRlY2xhcmVkIGV4cGxpY2l0bHkgYXQgYHBhdGg6IFtdYC5cbmNvbnN0IFJPT1RfSU5URVJDRVBUT1JTID0gW1xuICB7IG5hbWU6IFwiLS1oZWxwXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItaFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLS12ZXJzaW9uXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG4gIHsgbmFtZTogXCItVlwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuLy8gYWNjIGRlY2xhcmF0aW9uIGZvcm1hdCB2MCAoc2VlIGFnZW50LWNsaS1jb25mb3JtYW5jZSBzcmMvYWNjL2tpdC9kZWNsYXJhdGlvbi50cyk6XG4vLyB7IGZvcm1hdFZlcnNpb24sIHByb3ZlbmFuY2UsIHNlbGZEZXNjcmlwdGlvbiwgY29tbWFuZHM6IFt7IHBhdGgsIGFyZ3MsIHBvc2l0aW9uYWxzIH1dIH0uXG4vLyB2MCByZWZ1c2VzIHVua25vd24ga2V5cywgc28gbm90aGluZyByaWNoZXIgKGVmZmVjdHMsIHN1bW1hcmllcywgdmVyc2lvbnMpXG4vLyByaWRlcyBhbG9uZyDigJQgdGhvc2Ugd2FpdCBmb3IgYSB2MSB3aXRoIHNsb3RzIGZvciB0aGVtLlxuZnVuY3Rpb24gYnVpbGREZWNsYXJhdGlvbigpIHtcbiAgLy8gRXZlcnkgcmVnaXN0cnkgZmxhZyBpcyBhY2NlcHRlZCB0b2RheTsgYSByZWZ1c2FsIGxpc3Qgd291bGQgYWRkXG4gIC8vIHN0YXR1czogXCJyZWZ1c2VkXCIgZW50cmllcyBoZXJlIHRoZSBkYXkgYSB2ZXJiIHJlY29nbmlzZXMtYW5kLWRlY2xpbmVzIG9uZS5cbiAgY29uc3QgYXJnID0gKGs6IEZsYWdOYW1lKSA9PiAoe1xuICAgIG5hbWU6IGAtLSR7a31gLFxuICAgIHR5cGU6IENMSV9PUFRJT05TW2tdLnR5cGUsXG4gICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gIH0pO1xuICBjb25zdCBjb21tYW5kczoge1xuICAgIHBhdGg6IHN0cmluZ1tdO1xuICAgIGFyZ3M6IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBcInN0cmluZ1wiIHwgXCJib29sZWFuXCI7IHN0YXR1czogc3RyaW5nIH1bXTtcbiAgICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgfVtdID0gW1xuICAgIHtcbiAgICAgIC8vIGBwYXRoOiBbXWAgSVMgdGhlIHJvb3QuIEl0cyBncmFtbWFyOiBvbmUgcmVxdWlyZWQgdG9rZW4gc2VsZWN0aW5nIGFcbiAgICAgIC8vIGNvbW1hbmQsIG9yIGFuIGludGVyY2VwdG9yIGZsYWcgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuXG4gICAgICBwYXRoOiBbXSxcbiAgICAgIGFyZ3M6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgICB9KSksXG4gICAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIH0sXG4gIF07XG4gIGZvciAoY29uc3Qgc3BlYyBvZiBDT01NQU5EUykge1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbc3BlYy5uYW1lLCAuLi4oc3BlYy5hbGlhc2VzID8/IFtdKV0pIHtcbiAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICBwYXRoOiBbbmFtZV0sXG4gICAgICAgIGFyZ3M6IGFjY2VwdGVkRmxhZ3Moc3BlYykubWFwKChrKSA9PiBhcmcoaykpLFxuICAgICAgICBwb3NpdGlvbmFsczogc3BlYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbXCJzY2hlbWFcIl0gfSxcbiAgICBjb21tYW5kcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VGbGFncyhcbiAgYXJndjogc3RyaW5nW10sXG4gIHNwZWM6IENvbW1hbmRTcGVjLFxuKToge1xuICBwb3NpdGlvbmFsOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdzO1xufSB7XG4gIGNvbnN0IGFjY2VwdGVkID0gYWNjZXB0ZWRGbGFncyhzcGVjKTtcbiAgY29uc3Qgb3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhhY2NlcHRlZC5tYXAoKGspID0+IFtrLCBDTElfT1BUSU9OU1trXV0pKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBwb3NpdGlvbmFsOiBwb3NpdGlvbmFscyxcbiAgICAgIGZsYWdzOiB2YWx1ZXMgYXMgRmxhZ3MsXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBjb25zdCBib2R5SGludCA9XG4gICAgICBzcGVjLm5hbWUgPT09IFwic2VuZFwiIHx8IHNwZWMubmFtZSA9PT0gXCJhbm5vdW5jZVwiXG4gICAgICAgID8gXCJmb3IgYSBtZXNzYWdlIGJvZHkgY29udGFpbmluZyBkYXNoZXMsIHVzZSAtLXN0ZGluIG9yIC0tYm9keS1maWxlLCBcIiArXG4gICAgICAgICAgXCJvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCJcbiAgICAgICAgOiBcIlwiO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGAke3NwZWMubmFtZX06ICR7ZGV0YWlsfWAsIHtcbiAgICAgIC8vIOKblCBUSEUgU0VUIElTIGBjaG9pY2VzYCBOT1csIE5PVCBBIFBST1NFIE1BUktFUi4gSXQgdXNlZCB0byBiZSBhIHNlY29uZFxuICAgICAgLy8gbGluZSByZWFkaW5nIGByZWNvZ25pemVkIGZsYWdzOiAtLWEgLS1iYCwgc3BlbGxlZCB3aXRoIHRoZSBjb2xvblxuICAgICAgLy8gc3RyYWlnaHQgYWZ0ZXIgdGhlIG5vdW4gYmVjYXVzZSB0aGF0IGlzIHRoZSBtYXJrZXIgc2hhcGUgYSBmbGFnLXNldFxuICAgICAgLy8gZXh0cmFjdG9yIG1hdGNoZXMuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEFORCBOT1QgQkVDQVVTRSBUSEUgTUFSS0VSIFdPVUxEIEhBVkUgU1RPUFBFRCBXT1JLSU5HIOKAlCB0aGF0IHJlYXNvblxuICAgICAgLy8gd2FzIHdyaXR0ZW4gaGVyZSBhbmQgaW4gRDcxLCBhbmQgaXQgaXMgRkFMU0UuIGFjYyBwYXJzZXMgdGhlIHdob2xlXG4gICAgICAvLyBlbnZlbG9wZSwgdGhlbiB3YWxrcyBgc3RyaW5nVmFsdWVzT2YoZG9jdW1lbnQpYCBhbmQgcnVucyB0aGUgU0FNRSBwcm9zZVxuICAgICAgLy8gTUFSS0VSIHJlZ2V4IG92ZXIgZXZlcnkgc3RyaW5nIGluc2lkZSBpdCwgZm9yIGV4YWN0bHkgdGhpcyBjYXNlXG4gICAgICAvLyAoYGFnZW50LWNsaS1jb25mb3JtYW5jZS9zcmMvYWNjL2tpdC9zdXJmYWNlLnRzOjY1My02NTZgLCB3aG9zZSBkb2NcbiAgICAgIC8vIGNvbW1lbnQgbmFtZXMgYW50aGlsbCdzIGBcIlZhbGlkIGZsYWdzOiAtLWZvcm1hdFwiYCBpbnNpZGUgYW4gYGVycm9yYFxuICAgICAgLy8gc3RyaW5nKS4gQSBtYXJrZXIgZW1iZWRkZWQgaW4gdGhlIGVudmVsb3BlIHdvdWxkIHN0aWxsIGhhdmUgYmVlbiByZWFkLlxuICAgICAgLy9cbiAgICAgIC8vIFRoZSBtb3ZlIGlzIHJpZ2h0IGZvciByZWFzb25zIHRoYXQgc3Vydml2ZSB0aGF0IGNvcnJlY3Rpb246IGBjaG9pY2VzYCBpc1xuICAgICAgLy8gdGhlIGVudmVsb3BlJ3Mgb3duIGZpZWxkIGZvciB0aGUgYWNjZXB0ZWQgc2V0LCBpdCBpcyB3aGF0IGdsYW1vdXJcbiAgICAgIC8vIHB1Ymxpc2hlcyBhdCBDT05GT1JNQU5UIEwwLCBhbiBBUlJBWSBjYW5ub3QgYmUgdHJ1bmNhdGVkIGJ5IGEgcmVhZGVyXG4gICAgICAvLyB0aGF0IHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB3aGljaCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLCBhbmQgb25lXG4gICAgICAvLyBzcGVsbGluZyBvZiBvbmUgc2V0IGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBvdGhlci5cbiAgICAgIGNob2ljZXM6IGFjY2VwdGVkLm1hcCgoaykgPT4gYC0tJHtrfWApLFxuICAgICAgLi4uKGJvZHlIaW50ID8geyBoaW50OiBib2R5SGludCB9IDoge30pLFxuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbW1hbmRUb2tlbnMoKTogc3RyaW5nW10ge1xuICByZXR1cm4gQ09NTUFORFMuZmxhdE1hcCgoYykgPT4gW2MubmFtZSwgLi4uKGMuYWxpYXNlcyA/PyBbXSldKTtcbn1cblxuZnVuY3Rpb24gcHJpbnRIZWxwKCkge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIOKAlCBhZ2VudC10by1hZ2VudCB3YWxraWUtdGFsa2llXG5cblVzYWdlOlxuICBncmFwZXZpbmUgb3BlbiA8bmFtZT4gWy0tdG9waWMgPHRleHQ+XSBbLS1mcmVzaF0gICBvcGVuL2NyZWF0ZSAoYXV0by11bmFyY2hpdmVzOyAtLWZyZXNoIGNsZWFycyBhIGRvcm1hbnQgY2hhbm5lbClcbiAgZ3JhcGV2aW5lIGxpc3RcbiAgZ3JhcGV2aW5lIHNlbmQgPG5hbWU+IFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1xdWlldF0gWy0tdmVyYm9zZV0gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLWZvcmNlXSBbLS1pbi1yZXBseS10byA8aWQ+XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBib2R5OiBpbmxpbmUgdGV4dCwgLS1zdGRpbiwgLS1ib2R5LWZpbGUsIG9yIHBpcGVkIHN0ZGluIChkZWZhdWx0IHdoZW4gbm8gaW5saW5lIHRleHQpXG4gIGdyYXBldmluZSBhbm5vdW5jZSBbLS1mcm9tLy0tYXMgPGFsaWFzPl0gWy0tY2hhbm5lbHMgYSxiLGNdIFstLXN0ZGluXSBbLS1ib2R5LWZpbGUgPHBhdGg+XSBbLS1xdWlldF0gWzx0ZXh0Li4uPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgYnJvYWRjYXN0IG9uZSBtZXNzYWdlIHRvIGV2ZXJ5IGFjdGl2ZSBjaGFubmVsIChvciAtLWNoYW5uZWxzKVxuICBncmFwZXZpbmUgdGFpbCA8bmFtZT4gWy0tYXMvLS1mcm9tIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XSBbLS1odW1hbl0gWy0tbHVya10gWy0tbWF4IDxuPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgJHtXSU5ET1dfSEVMUH0gKC0taHVtYW4gbmV2ZXIgZW5kcyBieSBpdHNlbGYpXG4gICAgICAgIyAtLWxhc3QgPG4+OiBiYWNrZmlsbCB0aGUgbW9zdCByZWNlbnQgbiBtZXNzYWdlcyB0aGVuIGdvIGxpdmUgKGJvdW5kZWQgY2F0Y2gtdXAgZm9yIGEgY29sZCBqb2luZXIpXG4gIGdyYXBldmluZSBwdWxsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl0gICAjIC0tc3RhdHVzID0gZnVsbC1zY2FuIGZpbHRlciAob3Blbnx3b250Zml4fGluY29ycG9yYXRlZHzigKYpXG4gIGdyYXBldmluZSB0cmlhZ2UgPG5hbWU+ICAgICAgICAgICAgICMgZnVsbC1zY2FuOiBvcGVuIG1lc3NhZ2VzIG9uIHRvcCArIGdyb3VwZWQgYnlfc3RhdHVzXG4gIGdyYXBldmluZSBtYXJrIDxuYW1lPiA8aWQ+IDxkaXNwb3NpdGlvbj4gWy0tbm90ZSA8dGV4dD5dICAjIHNldCBkaXNwb3NpdGlvbiAoaW5jb3Jwb3JhdGVkfHdvbnRmaXh8ZGVmZXJyZWR84oCmKVxuICBncmFwZXZpbmUgcmVvcGVuIDxuYW1lPiA8aWQ+ICAgICAgICAjIGJvdW5jZSBhIG1lc3NhZ2UgYmFjayB0byBvcGVuXG4gIGdyYXBldmluZSByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdICAgIyBvbmUgZnVsbCBtZXNzYWdlIGJ5IGlkICgtLXRleHQgPSBwcm9zZSlcbiAgZ3JhcGV2aW5lIHdhaXQgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVxuICBncmFwZXZpbmUgZ3JlcCA8bmFtZT4gPHBhdHRlcm4+IFstLWxpdGVyYWxdIFstLWZyb20gPGFsaWFzPl1cbiAgZ3JhcGV2aW5lIHRvcGljIDxuYW1lPiBbPHRleHQ+XSAgICMgbm8gdGV4dCDihpIgcmVhZCBjdXJyZW50OyB3aXRoIHRleHQg4oaSIHVwZGF0ZVxuICBncmFwZXZpbmUgd2hvIDxuYW1lPiAgICAgICAgICAgICAgIyByb3N0ZXI7IHRoZSBodW1hbnMgZmllbGQgbGlzdHMgaHVtYW5zXG4gIGdyYXBldmluZSBhbGlhcyBbPG5hbWU+XSAgICAgICAgICAjIHNldC9zaG93IHlvdXIgcGVyc2lzdGVkIGFsaWFzIChjb25maWcuanNvbilcbiAgZ3JhcGV2aW5lIHdhdGNoIFs8bmFtZT5dICAgICAgICAgICMgb3BlbiBicm93c2VyIHRhYjsgbGl2ZSBjaGF0LWJ1YmJsZSB2aWV3XG4gIGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdICAgICAgICAgICBzbmFwc2hvdCB0aGUgbG9nIOKGkiB+Ly5ncmFwZXZpbmUvYXJjaGl2ZSwgdGhlbiBjbGVhciBpdFxuICBncmFwZXZpbmUgYXJjaGl2ZSA8bmFtZT4gICAgICAgICAgIyByZWFkLW9ubHk6IGtlZXAgaGlzdG9yeSwgcmVqZWN0IHNlbmRzXG4gIGdyYXBldmluZSB1bmFyY2hpdmUgPG5hbWU+ICAgICAgICAjIGJyaW5nIGFuIGFyY2hpdmVkIGNoYW5uZWwgYmFja1xuICBncmFwZXZpbmUgY2xvc2UgPG5hbWU+ICAgICAgICAgICAgIyBkZXN0cnVjdGl2ZTogZGVsZXRlIHRoZSBtZXNzYWdlIGxvZ1xuICBncmFwZXZpbmUgc3RhcnQgICAgICAgICAgICAgICAgICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyBydW5uaW5nIChhbGlhczogdXApOyBubyBjaGFubmVsXG4gIGdyYXBldmluZSByZXN0YXJ0IFstLWZvcmNlfC0teWVzXSAjIHN0b3AgKyByZXNwYXduIGZyZXNoOyAtLWZvcmNlIHRvIG92ZXJyaWRlIHRoZSBsaXZlLWZsZWV0IGd1YXJkXG4gIGdyYXBldmluZSByb2xsIFstLWZvcmNlXSAgICAgICAgICAjIHNhZmUgcmVzdGFydCAoc3RvcCtob2xkK3Jlc3Bhd24pICsgdmVyc2lvbiB2ZXJpZnkg4oCUIHRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcFxuICBncmFwZXZpbmUgc3RvcCBbLS1ob2xkIDxzZWNvbmRzPl0gIyBraWxsIHRoZSBkYWVtb247IC0taG9sZCBzdXBwcmVzc2VzIGF1dG8tcmVzcGF3biBmb3IgPHM+IHNlY29uZHMgKHVwZ3JhZGUgd2luZG93KVxuICBncmFwZXZpbmUgaW5mb1xuICBncmFwZXZpbmUgZG9jdG9yICAgICAgICAgICAgICAgICAgIyBoZWFsdGggY2hlY2sg4oCUIGxhYmVscyBlYWNoIGRhZW1vbjogYXV0aG9yaXRhdGl2ZSAvIG9ycGhhbiAvIHVucmVzcG9uc2l2ZSAvIHVua25vd25cbiAgZ3JhcGV2aW5lIHJlYXAgWy0tZm9yY2VdIFstLWRyeS1ydW5dICAjIGtpbGwgb3JwaGFuIGRhZW1vbnM7IC0tZm9yY2UgYWxzbyBraWxscyB1bnJlc3BvbnNpdmU7IGFsaWFzOiBwcnVuZVxuXG4gIGdyYXBldmluZSBzY2hlbWEgICAgICAgICAgICAgICAgICAjIHRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgZGVzY3JpcHRpb24gKGFjYyBkZWNsYXJhdGlvbiB2MClcbiAgZ3JhcGV2aW5lIC0tdmVyc2lvbiAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyB2ZXJzaW9uIChhbGlhczogLVYsIHZlcnNpb24pXG4gIGdyYXBldmluZSBoZWxwICAgICAgICAgICAgICAgICAgICAjIHRoaXMgdXNhZ2UgKGFsaWFzOiAtLWhlbHAsIC1oKVxuXG5PdXRwdXQ6XG4gIERhdGEgY29tbWFuZHMgZW1pdCBKU09OIG9uIHN0ZG91dCBieSBERUZBVUxUOyBwYXNzIC0taHVtYW4gZm9yIHByb3NlIHdoZXJlIGFcbiAgY29tbWFuZCBvZmZlcnMgaXQuIERpYWdub3N0aWNzIGFuZCB3YXJuaW5ncyBnbyB0byBzdGRlcnIsIG5ldmVyIHN0ZG91dC5cbiAgVXNhZ2UgZXJyb3JzIGV4aXQgMi4gRWFjaCBjb21tYW5kIGFjY2VwdHMgaXRzIE9XTiBmbGFncyAocGx1cyAtLWFzLy0tZnJvbSxcbiAgd2hpY2ggYXJlIGdsb2JhbCkg4oCUIGFuIHVua25vd24gZmxhZyBmb3IgYSB2ZXJiIGVudW1lcmF0ZXMgdGhhdCB2ZXJiJ3Mgc2V0LlxuXG5FbnY6XG4gIEdSQVBFVklORV9GUk9NICAgRGVmYXVsdCBpZGVudGl0eSBhbGlhcyAoLS1mcm9tLy0tYXMgYXJlIGludGVyY2hhbmdlYWJsZSkuXG4gIEdSQVBFVklORV9IT01FICAgRGF0YSBkaXIgKGRlZmF1bHQgfi8uZ3JhcGV2aW5lKS5cbmApO1xufVxuXG4vKipcbiAqIFRoZSB2ZXJiIHJvdXRlci4gRXZlcnkgcmVqZWN0aW9uIGhlcmUgUkFJU0VTOyBub3RoaW5nIHdyaXRlcyBpdHMgb3duIHByb3NlLlxuICpcbiAqIOKblCBUSElTIEZVTkNUSU9OIFVTRUQgVE8gQkUgYG1haW5gLCBBTkQgSVRTIEZPVVIgUkVKRUNUSU9OUyBVU0VEIFRPIEJFXG4gKiBgcHJvY2Vzcy5zdGRlcnIud3JpdGUoLi4uKTsgcmV0dXJuIDJgIOKAlCBhIFNFQ09ORCBlcnJvciBjb250cmFjdCBiZXNpZGUgYGRpZWAsXG4gKiB3aXRoIGl0cyBvd24gd29yZGluZywgaXRzIG93biBtYXJrZXJzIGFuZCBubyBga2luZGAgb24gdGhlIHdpcmUuIEEgZ3JlcCBmb3JcbiAqIGBkaWUoYCB3b3VsZCBoYXZlIHJlcG9ydGVkIFwidGhlIGVycm9yIGNvbnRyYWN0IGlzIDQ2IHNpdGVzXCI7IGl0IHdhcyA0NiBwbHVzXG4gKiB0aGVzZSwgYW5kIHRoZXNlIGFyZSB0aGUgb25lcyBhbiBhZ2VudCBtZWV0cyBmaXJzdCAocGxheWJvb2sgQjg6IGxvb2sgZm9yIHRoZVxuICogUkFJU0UsIG5vdCBmb3IgdGhlIGhlbHBlcikuIFRoZXkgbm93IHJhaXNlIHRoZSBzYW1lIGVudmVsb3BlIGFzIHRoZSByZXN0LlxuICovXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IFtjbWQsIC4uLnJlc3RdID0gYXJndjtcblxuICAvLyBCQVJFIElOVk9DQVRJT04gSVMgQSBVU0FHRSBFUlJPUiDigJQgZXhpdCAyLCB1c2FnZSBwb2ludGVyIG9uIHN0ZGVyciDigJQgbm90IGFcbiAgLy8gaGVscCByZXF1ZXN0IGF0IGV4aXQgMC4gZ3JhcGV2aW5lJ3MgY2FsbGVycyBhcmUgYWdlbnRzOiBhIGJhcmUgY2FsbCBpcyBhblxuICAvLyB1bnNldCBzaGVsbCB2YXJpYWJsZSBleHBhbmRpbmcgdG8gbm90aGluZywgb3IgYSBtaXN0YWtlLCBhbmQgYW5zd2VyaW5nIGl0XG4gIC8vIHdpdGggMi45S0Igb2YgaGVscCBhdCBleGl0IDAgcmVwb3J0cyBzdWNjZXNzIGZvciBhIGNvbW1hbmQgdGhhdCBhc2tlZCBmb3JcbiAgLy8gbm90aGluZy4gYGhlbHBgIC8gYC0taGVscGAgcmVtYWluIG9uZSB0b2tlbiBhd2F5IGF0IGV4aXQgMCAoYWNjIEQyIOKAlFxuICAvLyBjb25mb3JtZWQgZm9yIHRoYXQgcmVhc29uLCBub3QgYmVjYXVzZSB0aGUgcnVsZSBzYWlkIHNvKS5cbiAgaWYgKGNtZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgZGllKFwiZXhwZWN0ZWQgYSBjb21tYW5kXCIsIFwidXNhZ2VcIiwge1xuICAgICAgY2hvaWNlczogY29tbWFuZFRva2VucygpLFxuICAgICAgaGludDogXCJydW4gYGdyYXBldmluZSBoZWxwYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VcIixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJPT1QgRkxBRyBST1VUSU5HLiBBIGxlYWRpbmcgLS10b2tlbiB1c2VkIHRvIGJlIGNvbnN1bWVkIGFzIHRoZSBDT01NQU5EXG4gIC8vIHRva2VuIGFuZCByZWplY3RlZCBhcyBgdW5rbm93biBjb21tYW5kOiAtLW5vcGVgIOKAlCBhIGZsYWcgcmVhY2hpbmcgdGhlIHZlcmJcbiAgLy8gcGFyc2VyJ3MgZXJyb3IgcGF0aCwgd2hlcmUgdGhlIHJlamVjdGlvbiBjb3VsZCBub3QgZW51bWVyYXRlIHRoZSBmbGFnIHNldFxuICAvLyAoZm91bmQgdmlhIGFjYydzIHJvb3Qtb25seSBzdXJmYWNlIGNhcHR1cmUpLiBUaGUgcm9vdCdzIGFjY2VwdGVkIGZsYWdzIGFyZVxuICAvLyB0aGUgaW50ZXJjZXB0b3JzOyBhbnl0aGluZyBlbHNlIGRhc2hlZCBpcyByZWplY3RlZCBBUyBBIEZMQUcsIGVudW1lcmF0aW5nXG4gIC8vIHRoZSByb290J3Mgb3duIHNldC5cbiAgaWYgKGNtZC5zdGFydHNXaXRoKFwiLVwiKSkge1xuICAgIGNvbnN0IGludGVyY2VwdG9yID0gUk9PVF9JTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBjbWQpO1xuICAgIGlmICghaW50ZXJjZXB0b3IpIHtcbiAgICAgIC8vIOKaoCBUSEUgU09SVCBTVVJWSVZFUyBUSEUgTU9WRSBJTlRPIGBjaG9pY2VzYCwgQU5EIElUIElTIE5PVCBERUNPUkFUSU9OLlxuICAgICAgLy8gTG9uZyBmbGFncyBmaXJzdCwgYmVjYXVzZSBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkcyB0aGUgbGlzdFxuICAgICAgLy8gbGVmdC10by1yaWdodCBhbmQgc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZyxcbiAgICAgIC8vIHNvIGEgc2hvcnQgYWxpYXMgbWlkLWxpc3QgdHJ1bmNhdGVzIHdoYXQgaXQgc2Vlcy4gQW4gYXJyYXkgaXMgbm90XG4gICAgICAvLyB2dWxuZXJhYmxlIHRvIHRoYXQg4oCUIGJ1dCB0aGUgb3JkZXIgaXMgZnJlZSBhbmQgdGhlIHByb3BlcnR5IGlzIHJlYWwgZm9yXG4gICAgICAvLyBhbnkgY29uc3VtZXIgdGhhdCBmbGF0dGVucyBpdCBiYWNrIHRvIGEgbGluZS5cbiAgICAgIGRpZShgdW5rbm93biBmbGFnIGF0IHRoZSByb290OiAke2NtZH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgY2hvaWNlczogWy4uLlJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKV0uc29ydChcbiAgICAgICAgICAoYSwgYikgPT4gTnVtYmVyKGIuc3RhcnRzV2l0aChcIi0tXCIpKSAtIE51bWJlcihhLnN0YXJ0c1dpdGgoXCItLVwiKSksXG4gICAgICAgICksXG4gICAgICAgIGhpbnQ6IGBjb21tYW5kcyAoZWFjaCB0YWtlcyBpdHMgb3duIGZsYWdzKTogJHtjb21tYW5kVG9rZW5zKCkuam9pbihcIiBcIil9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gYXdhaXQgcnVuQ29tbWFuZChmaW5kQ29tbWFuZChpbnRlcmNlcHRvci5ydW5zKSBhcyBDb21tYW5kU3BlYywgcmVzdCk7XG4gIH1cblxuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQoY21kKTtcbiAgaWYgKCFzcGVjKSB7XG4gICAgLy8gVGhlIHVua25vd24tdmVyYiByZWplY3Rpb24gZW51bWVyYXRlcyB0aGUgdmFsaWQgc2V0LCBleGFjdGx5IGFzIHRoZVxuICAgIC8vIHVua25vd24tZmxhZyByZWplY3Rpb24gZG9lcyDigJQgdGhlIHBhcnNlcidzIG93biBhY2NvdW50IG9mIHdoYXQgaXRcbiAgICAvLyBhY2NlcHRzLCBwcm9kdWNlZCBieSB0aGUgcGFyc2VyIChhY2MgU1RBTkRBUkQubWQsIFwidGhlIGNoZWFwZXN0IHZlcnNpb25cbiAgICAvLyBvZiBjaGVja2VkXCIpLlxuICAgIGRpZShgdW5rbm93biBjb21tYW5kOiAke2NtZH1gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogY29tbWFuZFRva2VucygpIH0pO1xuICB9XG4gIHJldHVybiBhd2FpdCBydW5Db21tYW5kKHNwZWMsIHJlc3QpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5Db21tYW5kKHNwZWM6IENvbW1hbmRTcGVjLCByZXN0OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBwb3NpdGlvbmFsOiBzdHJpbmdbXTtcbiAgbGV0IGZsYWdzOiBGbGFncztcbiAgdHJ5IHtcbiAgICAoeyBwb3NpdGlvbmFsLCBmbGFncyB9ID0gcGFyc2VGbGFncyhyZXN0LCBzcGVjKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgZGllKGUubWVzc2FnZSwgXCJ1c2FnZVwiLCBlLmV4dHJhKTtcbiAgfVxuICAvLyBBcml0eSwgZW5mb3JjZWQgRlJPTSBUSEUgREVDTEFSRUQgU0hBUEUg4oCUIHRoZSByZWdpc3RyeSdzIHBvc2l0aW9uYWwgc3BlYyBpc1xuICAvLyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcywgc28gZW5mb3JjaW5nIGl0IGhlcmUgaXMgd2hhdCBrZWVwcyB0aGUgZGVjbGFyYXRpb25cbiAgLy8gdHJ1ZSBieSBjb25zdHJ1Y3Rpb246IGEgbWlzc2luZyByZXF1aXJlZCBwb3NpdGlvbmFsIGVycm9ycyBiZWZvcmUgdGhlIHZlcmJcbiAgLy8gcnVucywgYW5kIGFuIEVYQ0VTUyBwb3NpdGlvbmFsIGlzIHJlamVjdGVkIHJhdGhlciB0aGFuIHNpbGVudGx5IHN3YWxsb3dlZFxuICAvLyAoYWNjIEE0J3Mgc2hhcGUg4oCUIHRoZSBkZWZlY3Qgbm8gZXh0ZXJuYWwgY2hlY2sgY2FuIHNlZSkuXG4gIGNvbnN0IHJlcXVpcmVkID0gc3BlYy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgY29uc3QgdmFyaWFkaWMgPSBzcGVjLnBvc2l0aW9uYWxzLnNvbWUoKHApID0+IHAudmFyaWFkaWMpO1xuICBpZiAocG9zaXRpb25hbC5sZW5ndGggPCByZXF1aXJlZCkge1xuICAgIGNvbnN0IG1pc3NpbmcgPSBzcGVjLnBvc2l0aW9uYWxzW3Bvc2l0aW9uYWwubGVuZ3RoXTtcbiAgICBkaWUoYCR7c3BlYy5uYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICBoaW50OiBgZXhwZWN0czogJHtzcGVjLm5hbWV9ICR7c3BlYy5wb3NpdGlvbmFsc1xuICAgICAgICAubWFwKChwKSA9PiAocC5yZXF1aXJlZCA/IGA8JHtwLm5hbWV9PmAgOiBgWyR7cC5uYW1lfV1gKSlcbiAgICAgICAgLmpvaW4oXCIgXCIpfWAsXG4gICAgfSk7XG4gIH1cbiAgaWYgKCF2YXJpYWRpYyAmJiBwb3NpdGlvbmFsLmxlbmd0aCA+IHNwZWMucG9zaXRpb25hbHMubGVuZ3RoKSB7XG4gICAgZGllKFxuICAgICAgYCR7c3BlYy5uYW1lfTogdW5leHBlY3RlZCBhcmd1bWVudCAke0pTT04uc3RyaW5naWZ5KHBvc2l0aW9uYWxbc3BlYy5wb3NpdGlvbmFscy5sZW5ndGhdKX1gLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBgZXhwZWN0czogJHtzcGVjLm5hbWV9ICR7XG4gICAgICAgICAgc3BlYy5wb3NpdGlvbmFscy5tYXAoKHApID0+IChwLnJlcXVpcmVkID8gYDwke3AubmFtZX0+YCA6IGBbJHtwLm5hbWV9XWApKS5qb2luKFwiIFwiKSB8fFxuICAgICAgICAgIFwiKG5vIGFyZ3VtZW50cylcIlxuICAgICAgICB9YCxcbiAgICAgIH0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBvdXRjb21lID0gYXdhaXQgc3BlYy5ydW4ocG9zaXRpb25hbCwgZmxhZ3MpO1xuICByZXR1cm4gdHlwZW9mIG91dGNvbWUgPT09IFwibnVtYmVyXCIgPyBvdXRjb21lIDogMDtcbn1cblxuLyoqXG4gKiBUaGUgb25lIHBsYWNlIHRoaXMgQ0xJIGNhbiBlbmQsIGFuZCB0aGUgb25lIHBsYWNlIGEgYENsaUVycm9yYCBiZWNvbWVzIGFuXG4gKiBleGl0IGNvZGUuXG4gKlxuICog4puUIEFEREVEIEFUIFBIQVNFIDYgQ0hBUFRFUiAyLCBBTkQgSVQgSVMgV0hBVCBNQUtFUyBgZGllYCBTQUZFIFRPIFRIUk9XLlxuICogYHJlcG9ydENsaUVycm9yYCB3cml0ZXMgdGhlIGVudmVsb3BlIGFuZCBoYW5kcyBiYWNrIHRoZSB0YXhvbm9teSBjb2RlOyBhXG4gKiB0aHJvdyBpdCBkb2VzIE5PVCByZWNvZ25pc2UgaXMgcmUtdGhyb3duLCBiZWNhdXNlIHN3YWxsb3dpbmcgYW4gdW5rbm93biBvbmVcbiAqIGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeSB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZVxuICogc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKlxuICog4pqgIEFORCBgc2V0Q3VycmVudENvbW1hbmRgIElTIE5PVCBERUNPUkFUSU9OIOKAlCBpdCBpcyB0aGUgYG1ldGEuY29tbWFuZGAgZmllbGRcbiAqIG9mIGV2ZXJ5IGVudmVsb3BlIHRoaXMgQ0xJIGVtaXRzLCB3aGljaCBpcyBob3cgYSBjYWxsZXIgcm91dGluZyBvbiBga2luZGBcbiAqIGtub3dzIFdISUNIIHZlcmIgcHJvZHVjZWQgaXQuIFNldCBmcm9tIHRoZSByYXcgdG9rZW4gc28gYW4gdW5rbm93biB2ZXJiIHN0aWxsXG4gKiBuYW1lcyBpdHNlbGYgaW4gaXRzIG93biByZWplY3Rpb24uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBzZXRDdXJyZW50Q29tbWFuZChhcmd2WzBdID8/IG51bGwpO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAoY29kZSAhPT0gbnVsbCkgcmV0dXJuIGNvZGU7XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vLyDim5QgTk8gYGltcG9ydC5tZXRhLm1haW5gIEJMT0NLLCBBTkQgSVRTIEFCU0VOQ0UgSVMgVEhFIFNURVAgKHBsYXlib29rIEIzKS5cbi8vIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgYHNjcmlwdHMvY2xpLnRzYCwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3Ncbi8vIGVudHJ5LCBzbyB0aGUgZ3VhcmQgd291bGQgbmV2ZXIgcnVuIGFuZCBldmVyeSB2ZXJiIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kXG4vLyBleGl0IDAuIE5vciBtYXkgdGhpcyBmaWxlIG9mZmVyIGEgc2Vjb25kIGVudHJ5IGZyb20gaXRzIGF1dGhvcmluZyBhZGRyZXNzOlxuLy8gYFNLSUxMX1JPT1RgLCBgRElTVF9ESVJgLCBgU1VSRkFDRV9DV0RgIGFuZCBgREFFTU9OX1NDUklQVGAgYWJvdmUgYXJlIGFsbFxuLy8gY29tcHV0ZWQgZnJvbSBgU0NSSVBUX0RJUmAgYW5kIGFyZSBjb3JyZWN0IG9ubHkgZnJvbSBgZGlzdC9gLlxuLy9cbi8vIFRoZSBkcmFpbiBjb250cmFjdCBsaXZlcyBhdCB0aGUgbGF1bmNoZXIgbm93IOKAlCBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbi8vIHJldHVybiwgbmV2ZXIgYW4gZXhwbGljaXQgZXhpdCwgYmVjYXVzZSBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGFcbi8vIHBpcGUgYW5kIGB0YWlsYCB3cml0ZXMgSlNPTkwgYSBjYWxsZXIgcGFyc2VzLiBTZWVcbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvY2xpLnRzYCBmb3IgdGhlIGZ1bGwgYWNjb3VudC5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCByZXBhaXJlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhXG4gKiBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4g4puUIFJFQUNIQUJJTElUWSwgTk9UIENBTEwgU0lURVM6IGFcbiAqIEhFTFBFUiB0aGF0IGRpZXMsIGludm9rZWQgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAsIGhhcyBpdHMgYGRpZWAgYXRcbiAqIGEgc2l0ZSB0aGF0IHJlYWRzIGFzIHBlcmZlY3RseSBzYWZlLiBBbiBhZG9wdGluZyBzcGVsbCBtdXN0IGZvbGxvdyB0aGUgY2FsbFxuICogZ3JhcGgsIG5vdCBncmVwIGZvciBgZGllKGAuIEF1ZGl0ZWQgdGhhdCB3YXkgb24gYWRvcHRpb24g4oCUIDE1IHNpdGVzIGluXG4gKiBhc3Ryb2xhYmUsIDI5IGluIG1hZ3BpZSwgcGx1cyB0aGUgaGVscGVycyByZWFjaGFibGUgZnJvbSB0aGVtIOKAlCBhbmQgZXZlcnlcbiAqIHBhdGggaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLCBmcm9tIHdoaWNoIHRoZSB0aHJvd1xuICogcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKipcbiAqIEV4dHJhIGZpZWxkcyBhIGZhaWx1cmUgbWF5IGNhcnJ5LiBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC10YWlsLXJlYWRlci1jb252ZXJnZW5jZS5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7IGN1cnNvcjogbnVtYmVyOyByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgfSkgPT4gdm9pZDtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHtcbiAgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDtcbiAgY29tbWVudHM6IHN0cmluZ1tdO1xufSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikge1xuICAgICAgICAgIGVuZGluZyA9IFwidW5yZXNvbHZlZFwiO1xuICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8ge1xuICAgICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICB9O1xuICAgICAgLy8gV2hhdCB0aGlzIGNvbm5lY3Rpb24gYXNrZWQgZnJvbSwgZm9yIGByZXN0YXJ0T25SZXBsYXlgLlxuICAgICAgY29uc3QgYXNrZWRTaW5jZSA9IGN1cnNvcjtcbiAgICAgIGxldCByZXN0YXJ0Tm90ZWQgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZXBvY2hSZXNldCA9IGZhbHNlO1xuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgZXBvY2hSZXNldCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBvcHRzLnJlc3RhcnRPblJlcGxheSA9PT0gdHJ1ZSAmJlxuICAgICAgICAgICAgICAhZXBvY2hSZXNldCAmJlxuICAgICAgICAgICAgICAhcmVzdGFydE5vdGVkICYmXG4gICAgICAgICAgICAgIGFza2VkU2luY2UgPj0gMCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICBuIDw9IGFza2VkU2luY2VcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyBUaGUgZGFlbW9uIHJlcGxheWVkIFdIT0xFOiBpdHMgbG9nIHJlc3RhcnRlZCAoc2VlIHRoZSBvcHRpb24pLlxuICAgICAgICAgICAgICByZXN0YXJ0Tm90ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4ob3B0cy5lcG9jaE9mPy4oZXYpID8/IFwidW5rbm93blwiKSA/PyBudWxsO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvYmFja2xvZy8yMDI2LTA5LTIyLXNjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTIyLW1vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgYWx3YXlzIGdldHMgYHRhaWwud2luZG93YDogYSBzdG9wLXN0YXJ0IHRhaWxcbiAqICAgICB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHMgY29ubmVjdGlvbiBjYXJyaWVzLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMpLCBlYWNoIG5hbWluZyBob3cgdG8gY29tZSBiYWNrXG4gKiBpbnN0ZWFkIG9mIGEgcmUtYXJtLiBBIHNpZ25hbCBvciBhIGNhbGxlcidzIGFib3J0IHByaW50cyBub3RoaW5nLlxuICpcbiAqIEV2ZXJ5IHJlLWFybSBjYXJyaWVzIGAtLXNpbmNlIDxjdXJzb3I+YCwgc28gbm90aGluZyByZXBsYXlzOyB0aGUgZGFlbW9uJ3NcbiAqIGJ1ZmZlciBjb3ZlcnMgd2hhdGV2ZXIgbGFuZHMgYmV0d2VlbiBvbmUgd2F0Y2gncyBleGl0IGFuZCB0aGUgbmV4dCdzIGFybS5cbiAqXG4gKiDilIDilIAgREVDSVNJT04gTE9HIChmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogS2l0IGRlY2lzaW9ucyBsaXZlIGluIG1vZHVsZSBoZWFkZXJzICh0aGUgYXJjaGl0ZWN0dXJlIGRvYydzIMKnNCBydWxlOiBcImVhY2hcbiAqIG1vZHVsZSdzIGhlYWRlciBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhY2NvdW50XCIpLiBSdWxlZCBieSBDb2xlOiB0aGUgaHlicmlkLFxuICogdGhlIGFsd2F5cy1ib29rbWFyaywgcHJlc2VuY2Ugc3BlbGxzIGFsd2F5cyByZS1hcm0gTW9uaXRvciwgYm91bnR5J3MgZXhhbXBsZVxuICogZml4ZWQuIFRoZSBmb3VyIGFkanVzdG1lbnRzIHdlcmUgdGhlIHNwaWtlJ3MgcmVxdWlyZW1lbnRzLiBUaGUgcmVzdCBhcmUgdGhlXG4gKiBpbXBsZW1lbnRlcidzIHJ1bGluZ3MsIG1hcmtlZCDimpYgd2l0aCB0aGUgb3B0aW9ucyBub3QgdGFrZW4uXG4gKlxuICogQTEgwrcgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04uIGB0YWlsRXZlbnRzYCBub3cgYWJvcnRzIHRoZVxuICogICAgICBpbi1mbGlnaHQgZmV0Y2ggYmVmb3JlIGl0IHJldHVybnMgb24gYSB0ZXJtaW5hbCBmcmFtZS4gQmVmb3JlLCBpdFxuICogICAgICByZXR1cm5lZCBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIGFuZCBsZWZ0IHRoZSBTU0Ugc3RyZWFtIG9wZW4sIHNvIHRoZVxuICogICAgICBwcm9jZXNzIHN0YXllZCBhbGl2ZTogdW5zZWVuIGZvciBgY2xvc2VkYCAodGhlIHNlcnZlciBlbmRzIHRoYXRcbiAqICAgICAgc3RyZWFtIGl0c2VsZikgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrIHdvdWxkXG4gKiAgICAgIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LCBzaWxlbnRseS4gUGlubmVkIGluXG4gKiAgICAgIGB0YWlsSGFuZG9mZi50ZXN0LnRzYCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQga2VlcHMgdGhlIHN0cmVhbSBvcGVuLlxuICpcbiAqIEEyIMK3IFRIRSBORVhUIEFDVCBERVBFTkRTIE9OIFNUQVRFLiBgaGFuZG9mZigpYCBiZWxvdyBpcyB0aGUgcHVyZSBkZWNpc2lvbjpcbiAqICAgICAgcXVpZXQg4oaSIGJhY2tncm91bmQsIGFjdGl2ZSBvciBwcmVzZW5jZSDihpIgTW9uaXRvciwgd29rZSDihpIgTW9uaXRvcixcbiAqICAgICAgY2xvc2VkIOKGkiBjb21lIGJhY2ssIGxvc3Qg4oaSIGNvbWUgYmFjay4gQ29tZSBiYWNrIGlzIHRoZSBzcGVsbCdzIG93biB2ZXJiXG4gKiAgICAgIChgb3BlbiAtLXJlc3RvcmUgPGlkPmAgZm9yIHRoZSBzZXNzaW9uIHNwZWxscykuXG4gKiAgICAgIOKaliBUSEUgRElTQ09OTkVDVCBERUNJU0lPTjogZm9yIGEgc2Vzc2lvbiBzcGVsbCwgYSBMT1NUIGRhZW1vbiBlbmRzIHRoZVxuICogICAgICB0YWlsIGluIEJPVEggbW9kZXMgd2l0aCBhIHN0ZG91dCBgdGFpbC5sb3N0YCBsaW5lLiBNb25pdG9yIG5vdGlmaWVzIG9ubHlcbiAqICAgICAgb24gc3Rkb3V0LCBzbyB0aGUgb2xkIHN0ZGVyci1vbmx5IGB0YWlsLmRpc2Nvbm5lY3RlZGAgbGVmdCBhXG4gKiAgICAgIE1vbml0b3Itd3JhcHBlZCBhZ2VudCB1bmF3YXJlIG9mIGEgYGtpbGwgLTlgIChFNTUncyBwdXJwb3NlIHVubWV0KSwgYW5kXG4gKiAgICAgIGEgYC0tb25jZWAgb24gYSBkZWFkIGRhZW1vbiB3b3VsZCBoYXZlIHNsZXB0IGZvcmV2ZXIuIFwiTG9zdFwiIGlzXG4gKiAgICAgIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBjb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93LCBuZXZlciBhIGRyb3BwZWRcbiAqICAgICAgc3RyZWFtIGFsb25lOiBhIGxhcHRvcCB0aGF0IHNsZWVwcyBkcm9wcyB0aGUgc3RyZWFtLCByZWNvbm5lY3RzIG9uIHRoZVxuICogICAgICBmaXJzdCB0cnksIGFuZCBtdXN0IHN0YXkgc2lsZW50LlxuICogICAgICAgIE5vdCB0YWtlbjogKGEpIGtlZXAgcmV0cnlpbmcgYW5kIG9ubHkgTU9WRSB0aGUgZGlzY29ubmVjdCBsaW5lIHRvXG4gKiAgICAgICAgc3Rkb3V0IOKAlCBhIHNlc3Npb24gZGFlbW9uIGlzIG5ldmVyIHJlc3Bhd25lZCBieSBpdHMgdGFpbCwgc28gdGhlXG4gKiAgICAgICAgcmV0cmllcyBidXkgbm90aGluZyBhbmQgdGhlIGFnZW50IGlzIHdva2VuIHRvIGJlIHRvbGQgdG8gd2FpdDsgKGIpXG4gKiAgICAgICAgbGVhdmUgaXQgb24gc3RkZXJyIOKAlCB0aGUgZGVmZWN0LlxuICogICAgICDimpYgUHJlc2VuY2Ugc3BlbGxzIGtlZXAgcmV0cnlpbmcsIGFzIGJlZm9yZTogZ3JhcGV2aW5lJ3MgdGFpbCByZXNwYXduc1xuICogICAgICBpdHMgZGFlbW9uIGFuZCBhc3Ryb2xhYmUncyBgam9pbmAgd2FpdHMgZm9yIHRoZSBodW1hbiB0byByZW9wZW4gdGhlXG4gKiAgICAgIGJvYXJkLCBib3RoIGJ5IGRlc2lnbi4gVGhlaXIgZGlzY29ubmVjdCBub3RlcyBzdGF5IHdoZXJlIHRoZXkgd2VyZS5cbiAqXG4gKiBBMyDCtyBRVUlFVCBJUyBUSEUgVEFJTCdTIE9XTiBDT1VOVC4gYGV2ZW50c2AgY291bnRzIHRoZSBsb2cgZnJhbWVzIHRoaXNcbiAqICAgICAgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQuIFRoZSBncm91bmRpbmcgbGluZSwgYSBzcGVsbCdzIGBzdWJzY3JpYmVkYFxuICogICAgICBtYXJrZXIsIGBlcG9jaC5jaGFuZ2VkYCBhbmQgdGhlIGhhbmRvZmYgbGluZSBpdHNlbGYgYXJlIG5vdCBsb2cgZnJhbWVzXG4gKiAgICAgIGFuZCBhcmUgbm90IGNvdW50ZWQgKGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgc2VydmVyLXNlbnRcbiAqICAgICAgZ3JvdW5kaW5nIGZyYW1lKS4gQW55IGxvZyBmcmFtZSBjb3VudHMsIHRoZSBkYWVtb24ncyBgd2FpdGluZ2AgcmVtaW5kZXJcbiAqICAgICAgaW5jbHVkZWQsIHNvIFwicXVpZXRcIiBtZWFucyBub3RoaW5nIG9uIHRoZSBsb2cuXG4gKiAgICAgIOKaliBBIGZyYW1lIHRoZSB0YWlsJ3Mgb3duIGZpbHRlciByZWplY3RzIChib3VudHkncyBvd25lciBzY29wZSwgYVxuICogICAgICBzZWxmLWVjaG8pIGlzIE5PVCBjb3VudGVkIGFuZCBkb2VzIG5vdCBlbmQgYSBgLS1vbmNlYDogaXQgd2FzIG5ldmVyXG4gKiAgICAgIGRlbGl2ZXJlZCwgYW5kIHdha2luZyBvbiBpdCB3b3VsZCBiZSBhIHdha2Ugd2l0aCBub3RoaW5nIHRvIGFjdCBvbiDigJRcbiAqICAgICAgdGhlIGRlZmVjdCB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcmVtb3ZlLiBUaGUgY3Vyc29yIHN0aWxsIGFkdmFuY2VzXG4gKiAgICAgIHBhc3QgaXQgKHRhaWxFdmVudHMnIHJ1bGUpLCBzbyBpdCBuZXZlciByZXBsYXlzIGVpdGhlci5cbiAqICAgICAgQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTsgdGhhdCBoYWxmIGxpdmVzIGluIGVhY2hcbiAqICAgICAgc3BlbGwncyBgdGFpbGAsIHdoaWNoIGtub3dzIHdoZXRoZXIgYC0tc2luY2VgIHdhcyBnaXZlbi5cbiAqXG4gKiBBNCDCtyBUSEUgV0lORE9XLiBgREVGQVVMVF9XSU5ET1dfTVNgID0gdGhlIGNhcCBtaW51cyBgV0lORE9XX01BUkdJTl9NU2BcbiAqICAgICAgKDYwIHMpLCBzbyAxLDc0MCwwMDAgbXMuIFRoZSBtYXJnaW4gaGFzIHRvIGNvdmVyIHRoZSBnYXAgYmV0d2VlbiB0aGVcbiAqICAgICAgaGFybmVzcyBzdGFydGluZyBpdHMgY2xvY2sgYW5kIHRoaXMgcHJvY2VzcyBzdGFydGluZyBpdHMgb3duIChCdW5cbiAqICAgICAgc3RhcnQtdXAsIGEgc2Vzc2lvbiBsb29rdXAsIGEgZGFlbW9uIHNwYXduIG9uIHRoZSBzcGVsbHMgd2hvc2UgYHJlc29sdmVgXG4gKiAgICAgIHNwYXducyBvbmUg4oCUIGJvdW5kZWQgYnkgdGhlaXIgc3RhcnQgdGltZW91dHMsIHdoaWNoIGFyZSBzZWNvbmRzKSBwbHVzXG4gKiAgICAgIHRoZSBsYXN0IGxpbmUncyBmbHVzaCBhbmQgTW9uaXRvcidzIDIwMCBtcyBiYXRjaGluZy4gQSBtaW51dGUgY292ZXJzXG4gKiAgICAgIGFsbCBvZiB0aGF0IG1hbnkgdGltZXMgb3ZlciBhbmQgY29zdHMgMyUgb2YgdGhlIHdpbmRvdywgb25lIGV4dHJhXG4gKiAgICAgIHJlLWFybSBhYm91dCBldmVyeSAxNC41IGhvdXJzIG9mIGFjdGl2aXR5LiBUaGUgc3Bpa2UgbWVhc3VyZWQgYSAxMiBzXG4gKiAgICAgIHdpbmRvdyB1bmRlciBhIDIwIHMgY2FwIGVuZGluZyBjbGVhbmx5OyBub3RoaW5nIGhlcmUgZGVwZW5kcyBvbiBhXG4gKiAgICAgIG1hcmdpbiB0aGF0IHRpZ2h0LiBJZiB0aGUgY2FwIHdpbnMgYW55d2F5LCB0aGUgYWdlbnQgZ2V0cyBNb25pdG9yJ3NcbiAqICAgICAgYmFyZSBleHBpcnkgbm90aWNlIGFuZCByZS1hcm1zIHNpbGVudGx5IGZyb20gdGhlIGxhc3QgaWQgaXQgc2F3IOKAlCB0aGVcbiAqICAgICAgcnVsaW5nJ3MgZmFsbGJhY2ssIHN0YXRlZCBpbiBldmVyeSBza2lsbC5cbiAqICAgICAg4pqWIFRoZSB3aW5kb3cgaXMgaW5qZWN0YWJsZSBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiB0aHJvdWdoXG4gKiAgICAgIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNgIChhIGNvdW50IG9mIG1zOyBgMGAgdHVybnMgdGhlIHdpbmRvdyBvZmYsXG4gKiAgICAgIGZvciBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwpLiBBbiBlbnYgdmFyIGFuZCBub3QgYSBmbGFnOiBpdCBpc1xuICogICAgICBub3QgYW4gYWdlbnQncyBhY3QsIHNvIGl0IHN0YXlzIG91dCBvZiBlaWdodCB2ZXJicycgc2NoZW1hcy5cbiAqXG4gKiDilIDilIAgVEhFIFZFUklGSUVSJ1MgREVGRUNUUywgRklYRUQgT04gVEhFIFNBTUUgQlJBTkNIICgyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbm8tc3Rha2UgdmVyaWZpZXIgcmFuIGV2ZXJ5IHNwZWxsJ3MgcmVhbCB0YWlsIGFuZCBmb3VuZCBmb3VyIHdheXMgdGhlXG4gKiBsb29wIGJyb2tlLiBFYWNoIGhhcyBhIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgOyBEMSBhbmQgRDIgYWxzbyBoYXZlIGFcbiAqIHJlYWwtZGFlbW9uIGNlbGwgaW4gYHNyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RhaWwtaGFuZG9mZi5pbnRlZ3JhdGlvbi50ZXN0LnRzYC5cbiAqXG4gKiBEMSDCtyBBIFJFLUFSTSBBVCBBIFNFU1NJT04gVEhBVCBDTE9TRUQgSU4gVEhFIEdBUCBFTkRTIGB0YWlsLmNsb3NlZGAuIFRoZVxuICogICAgICB0cmlnZ2VyIGlzIG9yZGluYXJ5OiB0aGUgaHVtYW4gcHJlc3NlcyBDbG9zZSB3aGlsZSB0aGUgYWdlbnQgaGFuZGxlc1xuICogICAgICBgdGFpbC53b2tlYC4gVGhlIHNlc3Npb24gc3BlbGxzIHN0b3BwZWQgb25seSB3aGVuIFRISVMgcHJvY2VzcyBoYWRcbiAqICAgICAgb25jZSByZWFjaGVkIHRoZSBzZXNzaW9uLCBzbyB0aGUgcmUtYXJtIHJldHJpZWQgXCJubyBzZXNzaW9uIHlldFwiIG9uXG4gKiAgICAgIHN0ZGVyciBmb3JldmVyIOKAlCBhbmQgaXRzIGAtLW9uY2VgIG5ldmVyIGV4aXRlZC4gUnVsZTogYSB0YWlsIGdpdmVuXG4gKiAgICAgIGAtLXNlc3Npb25gIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HIHNlc3Npb24sIHNvIG5vdFxuICogICAgICBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZDsgdGhlIHNwZWxsJ3MgYG9uVW5yZXNvbHZlZGAgc2F5cyBcInN0b3BcIlxuICogICAgICBhbmQgdGhpcyBtb2R1bGUgcmVhZHMgQU5ZIHN0b3AgYXMgY2xvc2VkLiBBIGJhcmUgZmlyc3QgYXJtIHN0aWxsXG4gKiAgICAgIHdhaXRzIGZvciBhIHNlc3Npb24gdG8gYXBwZWFyLlxuICogRDIgwrcgQSBCT09LTUFSSyBDQU5OT1QgT1VUTElWRSBJVFMgTE9HLiBBIHJlc3RvcmVkIGRhZW1vbidzIGlkcyBiZWdpbiBhdCAxLFxuICogICAgICBhbmQgdGhlIGtpdCdzIGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duIGJ5IHJlcGxheWluZyB3aG9sZTtcbiAqICAgICAgdGhlIHRhaWwga2VwdCBpdHMgaGlnaGVyIGN1cnNvciwgc28gZXZlcnkgcmUtYXJtIHJlcGxheWVkIHRoZSBuZXcgbG9nXG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUd28gaGFsdmVzOlxuICogICAgICAgIChhKSB0aGUgbmV0IOKAlCBgdGFpbEV2ZW50c2AnIGByZXN0YXJ0T25SZXBsYXlgIChvbiBieSBkZWZhdWx0IGhlcmUsXG4gKiAgICAgICAgICAgIG9mZiBmb3IgZ3JhcGV2aW5lLCB3aG9zZSBpZHMgc3Vydml2ZSBhIHJlc3RhcnQpIHJlYWRzIGEgZnJhbWUgYXRcbiAqICAgICAgICAgICAgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBhcyBhIHJlc3RhcnRlZCBsb2cgYW5kIHJlc2V0cztcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQgc2F5cyB0byB0YWlsIHRoZVxuICogICAgICAgICAgICBzZXNzaW9uIGlkIGBvcGVuYCBwcmludHMgV0lUSCBOTyBgLS1zaW5jZWAsIGFuZCBzbyBkb2VzIGV2ZXJ5XG4gKiAgICAgICAgICAgIHNraWxsLiBCb3VudHkncyByZXN0b3JlIG1pbnRzIGEgbmV3IGlkLCB3aGljaCBpcyB3aHkgdGhlIGxpbmVcbiAqICAgICAgICAgICAgbmFtZXMgXCJ0aGUgaWQgaXQgcHJpbnRzXCIsIG5vdCB0aGUgb2xkIG9uZS5cbiAqICAgICAgTm90IHRha2VuOiBjYXJyeWluZyB0aGUgZGFlbW9uJ3MgZXBvY2ggaW4gdGhlIGJvb2ttYXJrXG4gKiAgICAgIChgLS1zaW5jZSBOIC0tZXBvY2ggRWApIOKAlCBleGFjdCwgYnV0IGEgbmV3IGZsYWcgb24gZWlnaHQgdmVyYnMgYW5kIGFuXG4gKiAgICAgIGVwb2NoIHRoZSB0YWlsIHNlZXMgb25seSBvbmNlIGEgZnJhbWUgYXJyaXZlcy4gKGEpJ3Mgc3RhdGVkIGJsaW5kIHNwb3RcbiAqICAgICAgaXMgYSBzdGFsZSBib29rbWFyayBhdCBvciBiZWxvdyB0aGUgTkVXIGxvZydzIGxlbmd0aDsgKGIpIGlzIHdoeSB0aGVcbiAqICAgICAgY29tZS1iYWNrIHBhdGggbmV2ZXIgcHJlc2VudHMgb25lLlxuICogRDMgwrcgT05MWSBBIEZSQU1FIFdJVEggQSBMT0cgSUQgQ09VTlRTLiBHbGFtb3VyJ3MgYW5kIGltYWdvJ3MgdGFiIHBpbmdzXG4gKiAgICAgIChgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCkgY2Fycnkgbm8gaWQ6IG5vdCBvbiB0aGUgbG9nLCBzbyBhIGxhcHRvcFxuICogICAgICBsaWQgbm8gbG9uZ2VyIHdha2VzIGEgYC0tb25jZWAsIGFuZCBpbWFnbydzIGdyZXAgbm8gbG9uZ2VyIHNob3dzIGFcbiAqICAgICAgYHRhaWwud29rZWAgd2l0aCBub3RoaW5nIGFib3ZlIGl0LlxuICogRDQgwrcgQSBIVU1BTidTIFdBVENIIEhBUyBOTyBXSU5ET1cuIGBncmFwZXZpbmUgdGFpbCAtLWh1bWFuYCBwYXNzZXNcbiAqICAgICAgYHdpbmRvd01zOiAwYDsgbm8gb3RoZXIgc3BlbGwgaGFzIGEgaHVtYW4gbW9kZS4gRXZlcnkgYHRhaWxgJ3MgaGVscFxuICogICAgICBjYXJyaWVzIGBXSU5ET1dfSEVMUGAsIHdoaWNoIG5hbWVzIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MGAuXG4gKiBBbHNvOiBldmVyeSBjb21lLWJhY2sgY29tbWFuZCBjYXJyaWVzIGAtLW5vLW9wZW5gLCBzbyBydW5uaW5nIGl0IGFzIHByaW50ZWRcbiAqIG9wZW5zIG5vIGJyb3dzZXIgdGFiLlxuICpcbiAqIOKaoCBLTk9XTiBMSU1JVCwgTk9UIEZJWEVEOiB0aGUgcHJpbnRlZCBgY29tbWFuZGAgbmFtZXMgdGhlIGxhdW5jaGVyIGJ5IGl0c1xuICogICBmdWxsIHBhdGgsIHdoaWNoIGZvciBhbiBpbnN0YWxsZWQgcGx1Z2luIGluY2x1ZGVzIGl0cyBWRVJTSU9ORUQgY2FjaGVcbiAqICAgZGlyZWN0b3J5LiBBY3Jvc3MgYSBwbHVnaW4gdXBncmFkZSBhIHJlLWFybSBrZWVwcyBydW5uaW5nIHRoZSBvbGQgdmVyc2lvblxuICogICB1bnRpbCB0aGUgYWdlbnQgbmV4dCBhcm1zIGZyb20gdGhlIHNraWxsJ3Mgb3duIHBhdGguIE5vdGVkLCBub3QgcmVkZXNpZ25lZC5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBSVU5OQUJMRSBBUyBQUklOVEVEOiBgYnVuIDx0aGlzIGNsaSdzIHBhdGg+IOKApmAsXG4gKiAgIHBpbm5lZCB0byB0aGUgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlXG4gKiAgIHNraWxscyBuYW1lIHRoZSBydWxlIG9uY2U7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIGVuZDogVGFpbEVuZDtcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBMb2cgZnJhbWVzIHRoaXMgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQgKEEzKS4gKi9cbiAgZXZlbnRzOiBudW1iZXI7XG4gIC8qKiBUaGUgYm9va21hcms6IHRoZSBoaWdoZXN0IGlkIHRoaXMgcHJvY2VzcyBoYXMgc2Vlbi4gKi9cbiAgY3Vyc29yOiBudW1iZXI7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKiBUaGUgY29tZS1iYWNrIGhpbnQsIHdpdGggaG93IHRvIFJFU1VNRSBhZnRlciBjb21pbmcgYmFjayAoRDIpOiBhIHJlc3RvcmVkXG4gKiAgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgbWVhbnMgbm90aGluZyB0aGVyZS4gKi9cbmNvbnN0IENPTUVfQkFDSyA9ICh3aHk6IHN0cmluZykgPT5cbiAgYCR7d2h5fSBUbyBicmluZyBpdCBiYWNrLCBydW4gY29tbWFuZDsgdGhlbiB0YWlsIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cywgd2l0aCBubyAtLXNpbmNlIChhIHJlc3RvcmVkIHNlc3Npb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBkb2VzIG5vdCBhcHBseSlgO1xuXG4vKipcbiAqIFRIRSBERUNJU0lPTjogZ2l2ZW4gaG93IHRoZSB0YWlsIGVuZGVkLCB3aGljaCBsaW5lIGl0IHByaW50cy4gUHVyZSwgc28gZXZlcnlcbiAqIHN0YXRlIGlzIGEgbGl0ZXJhbCBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4gUmV0dXJucyBudWxsIGZvciBgc3RvcHBlZGA6XG4gKiBhIGh1bWFuJ3MgQ3RybC1DIG9yIGEgY2FsbGVyJ3MgYWJvcnQgaXMgbm90IGEgaGFuZG9mZi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhbmRvZmYoczogSGFuZG9mZklucHV0LCBjbWQ6IEhhbmRvZmZDb21tYW5kcyk6IEhhbmRvZmZMaW5lIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSB7IGV2ZW50czogcy5ldmVudHMsIGN1cnNvcjogcy5jdXJzb3IgfTtcbiAgc3dpdGNoIChzLmVuZCkge1xuICAgIGNhc2UgXCJzdG9wcGVkXCI6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBjYXNlIFwiY2xvc2VkXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwuY2xvc2VkXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwidGhlIHNlc3Npb24gY2xvc2VkOyB0aGVyZSBpcyBub3RoaW5nIGxlZnQgdG8gd2F0Y2guXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwibG9zdFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmxvc3RcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBDT01FX0JBQ0soXCJsb3N0IHRoZSBkYWVtb24gKGl0IGNyYXNoZWQgb3Igd2FzIGtpbGxlZCk7IG5vdGhpbmcgaXMgbGlzdGVuaW5nLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImV2ZW50XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwud29rZVwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IGZhbHNlIH0pLFxuICAgICAgICBoaW50OiBcImhhbmRsZSB0aGUgZXZlbnQgYWJvdmUsIHRoZW4gYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCBjb21tYW5kXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJ3aW5kb3dcIjpcbiAgICAgIGlmIChzLnByZXNlbmNlIHx8IHMuZXZlbnRzID4gMClcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwud2luZG93XCIsXG4gICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UgfSksXG4gICAgICAgICAgaGludDogXCJ0aGUgd2luZG93IGVuZGVkIGJlZm9yZSBNb25pdG9yJ3MgY2FwOyBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIGNvbW1hbmRcIixcbiAgICAgICAgfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5xdWlldFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcImJhY2tncm91bmRcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IHRydWUgfSksXG4gICAgICAgIGhpbnQ6IFwibm90aGluZyBvbiB0aGUgbG9nIHRoaXMgd2luZG93OyBydW4gY29tbWFuZCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50XCIsXG4gICAgICB9O1xuICB9XG59XG5cbi8qKiBQT1NJWCBzaW5nbGUtcXVvdGUgYW4gYXJndW1lbnQgd2hlbiBpdCBuZWVkcyBpdCwgc28gYSBwcmludGVkIGBjb21tYW5kYFxuICogIHJ1bnMgYXMgcHJpbnRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqIEpvaW4gYW4gYXJndiBpbnRvIG9uZSBydW5uYWJsZSBjb21tYW5kIGxpbmUuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZExpbmUoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYXJndi5tYXAoc2hlbGxRdW90ZSkuam9pbihcIiBcIik7XG59XG5cbi8qKiBIb3cgVEhJUyBwcm9jZXNzIHdhcyBpbnZva2VkLCBhcyB0aGUgaGVhZCBvZiBhIGNvbW1hbmQgdGhhdCBydW5zIGl0IGFnYWluOlxuICogIGBidW4gPHRoZSBsYXVuY2hlcidzIGZ1bGwgcGF0aD5gLiBCdW4gaGFuZHMgYGFyZ3ZbMV1gIG92ZXIgYXMgYSBmdWxsIHBhdGguICovXG5leHBvcnQgZnVuY3Rpb24gc2VsZkNvbW1hbmQoKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1wiYnVuXCIsIHByb2Nlc3MuYXJndlsxXSA/PyBcImNsaS50c1wiXTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOIFstLW9uY2VdYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChwcmVmaXg6IHJlYWRvbmx5IHN0cmluZ1tdLCBzaW5jZTogbnVtYmVyLCBvbmNlOiBib29sZWFuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHtzaW5jZX1gXSA6IFtcIi0tc2luY2VcIiwgU3RyaW5nKHNpbmNlKV07XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIEEgcHJlc2VuY2Ugc3BlbGw6IGFsd2F5cyBgdGFpbC53aW5kb3dgIGF0IHRoZSB3aW5kb3cncyBlbmQsIG5ldmVyIGxvc3QuICovXG4gIHByZXNlbmNlOiBib29sZWFuO1xuICAvKiogRGVmYXVsdDogYHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSlgLiBgMGAgPSBubyB3aW5kb3cuICovXG4gIHdpbmRvd01zPzogbnVtYmVyO1xuICAvKiogV2hldGhlciBhbiBlbWl0dGVkIGZyYW1lIGlzIGEgTE9HIGZyYW1lIChBMykuIERlZmF1bHQ6IGV2ZXJ5IG9uZS4gKi9cbiAgY291bnRzPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogV2hpY2ggdGVybWluYWwgZnJhbWUgbWVhbnMgdGhlIHNlc3Npb24gY2xvc2VkLiBEZWZhdWx0OiBldmVyeSB0ZXJtaW5hbC4gKi9cbiAgaXNDbG9zZWQ/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogVGhlIGRhZW1vbiBydW5zIHRoZSBraXQncyBldmVudCBsb2csIHNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkXG4gICAqICBjdXJzb3IgbWVhbnMgaXRzIGxvZyByZXN0YXJ0ZWQgKGB0YWlsRXZlbnRzYCcgYHJlc3RhcnRPblJlcGxheWAsIEQyKS5cbiAgICogIERlZmF1bHQgdHJ1ZTsgZ3JhcGV2aW5lJ3MgZHVyYWJsZSBsb2cgdHVybnMgaXQgb2ZmLiAqL1xuICBldmVudExvZz86IGJvb2xlYW47XG4gIGNvbW1hbmRzOiBIYW5kb2ZmQ29tbWFuZHM7XG59O1xuXG4vKipcbiAqIFJ1biBgdGFpbEV2ZW50c2Agd2l0aCB0aGUgaGFuZG9mZjogdGhlIHdpbmRvdywgYC0tb25jZWAsIHRoZSBsb3N0IHJ1bGUsIGFuZFxuICogdGhlIGZpbmFsIGxpbmUuIFJldHVybnMgdGhlIGV4aXQgY29kZSwgbGlrZSBgdGFpbEV2ZW50c2AsIGFuZCBuZXZlciBleGl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxXaXRoSGFuZG9mZjxFdj4oXG4gIHRhaWw6IFRhaWxPcHRpb25zPEV2PixcbiAgaDogSGFuZG9mZk9wdGlvbnM8RXY+LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gdGFpbC5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IHdpbmRvd01zID0gaC53aW5kb3dNcyA/PyByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pO1xuICBjb25zdCBjb3VudHMgPSBoLmNvdW50cyA/PyAoKCkgPT4gdHJ1ZSk7XG4gIGNvbnN0IGVuZE9uTG9zdCA9ICFoLnByZXNlbmNlO1xuXG4gIGNvbnN0IGFjID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gYWMuYWJvcnQoKTtcbiAgdGFpbC5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKHRhaWwuc2lnbmFsPy5hYm9ydGVkKSBhYy5hYm9ydCgpO1xuXG4gIGxldCBldmVudHMgPSAwO1xuICBsZXQgY3Vyc29yID0gdGFpbC5zaW5jZTtcbiAgbGV0IGZyYW1lSGFzSWQgPSBmYWxzZTtcbiAgLyoqIEEzICsgRDM6IGEgZnJhbWUgY291bnRzLCBhbmQgd2FrZXMgYSBgLS1vbmNlYCwgb25seSB3aGVuIGl0IGlzIE9OIFRIRVxuICAgKiAgTE9HIOKAlCBpdCBjYXJyaWVzIGEgbG9nIGlkIOKAlCBhbmQgdGhlIHNwZWxsJ3Mgb3duIGBjb3VudHNgIGFncmVlcy4gQSB0YWInc1xuICAgKiAgaWQtbGVzcyBgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCBwaW5nIGlzIG5vdCBvbiB0aGUgbG9nLiAqL1xuICBjb25zdCBpc0xvZ0ZyYW1lID0gKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBmcmFtZUhhc0lkICYmIGNvdW50cyhldiwgZnJhbWUpO1xuICBsZXQgZW5kOiBUYWlsRW5kIHwgbnVsbCA9IG51bGw7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICByZXN0YXJ0T25SZXBsYXk6IGguZXZlbnRMb2cgPz8gdHJ1ZSxcbiAgICAgIC8vIEQzOiByZW1lbWJlciB3aGV0aGVyIFRISVMgZnJhbWUgY2FycmllcyBhIGxvZyBpZC4gYHRhaWxFdmVudHNgIHJlYWRzXG4gICAgICAvLyB0aGUgY3Vyc29yIG9uY2UgcGVyIGZyYW1lLCBiZWZvcmUgYGFjY2VwdGAsIGB0ZXJtaW5hbGAgYW5kIGByZW5kZXJgLlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4ge1xuICAgICAgICBjb25zdCBuID0gdGFpbC5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgZnJhbWVIYXNJZCA9IHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKTtcbiAgICAgICAgcmV0dXJuIG47XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAocykgPT4ge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gdGFpbC5vblVucmVzb2x2ZWQ/LihzKSA/PyBcInJldHJ5XCI7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgdGhhdCBnaXZlcyB1cCBvbiBmaW5kaW5nIGl0cyBzZXNzaW9uIGlzIHdhdGNoaW5nIGFcbiAgICAgICAgLy8gc2Vzc2lvbiB0aGF0IGlzIGdvbmUg4oCUIHdoZXRoZXIgdGhpcyBwcm9jZXNzIGV2ZXIgcmVhY2hlZCBpdCAoaXRzXG4gICAgICAgIC8vIHBvaW50ZXIgdmFuaXNoZWQpIG9yIGl0IHdhcyByZS1hcm1lZCBhdCBvbmUgdGhhdCBjbG9zZWQgaW4gdGhlIGdhcC5cbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiICYmIGVuZCA9PT0gbnVsbCkgZW5kID0gXCJjbG9zZWRcIjtcbiAgICAgICAgcmV0dXJuIHZlcmRpY3Q7XG4gICAgICB9LFxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwucmVuZGVyID8gdGFpbC5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgIGlmIChsaW5lICE9PSBudWxsICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkgZXZlbnRzICs9IDE7XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIHRlcm1pbmFsOiAoZXYsIGZyYW1lLCBhY2NlcHRlZCkgPT4ge1xuICAgICAgICBpZiAodGFpbC50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gKGguaXNDbG9zZWQgPz8gKCgpID0+IHRydWUpKShldikgPyBcImNsb3NlZFwiIDogXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICBwcmVzZW5jZTogaC5wcmVzZW5jZSxcbiAgICAgIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogR3JhcGV2aW5lJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyBvZiB0aGUgc3BlbGwsIGFuZCBUSEUgT05FIFBMQUNFIFRIRSBFTlYgSVMgUkVBRC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLCBBTkQgRk9SIEdSQVBFVklORSBUSEUgU0VBTSBJUyBSRUFMIOKAlCB0aGUgZmlyc3QgdGltZVxuICogaW4gZm91ciBwb3J0cyAocGxheWJvb2sgQjgsIGVudHJ5LWJsb2NrIHF1ZXN0aW9uIDMpLiBCZWZvcmUgUGhhc2UgNiB0aGVcbiAqIGhlYXJ0YmVhdCB3YXMgYSBMSVRFUkFMIGAzMDAwYCBpbnNpZGUgYGRhZW1vbi50c2AncyBTU0Ugc3RyZWFtLCBgaWRsZVRpbWVvdXQ6XG4gKiAyNTVgIHdhcyBhIHNlY29uZCBsaXRlcmFsIHRlbiBsaW5lcyBhd2F5IHdpdGggdGhlIHJlbGF0aW9uc2hpcCB3cml0dGVuIG9ubHkgaW5cbiAqIHByb3NlLCBhbmQgYGNsaS50c2AncyB0YWlsIGhhZCBOTyB3YXRjaGRvZyBhdCBhbGwg4oCUIGl0IGJsb2NrZWQgb25cbiAqIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGUgZmFpbHVyZSB0aGUga2l0J3Mgd2F0Y2hkb2cgZXhpc3RzIHRvXG4gKiBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vblxuICogd291bGQgZHJhZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzXG4gKiBidXQgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKiBBIHZhbHVlIHRoYXQgY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR1JBUEVWSU5FJ1MgT1dOIEhFQVJUQkVBVCwgTkVWRVIgQ09QSUVEXG4gKiBGUk9NIEEgU0lCTElORy4qKiBUaGlzIGlzIHRoZSBydWxlIGFzdHJvbGFiZSBwYWlkIGZvcjogYSBoYXJkLWNvZGVkIDQ1IHNcbiAqIHdhdGNoZG9nIGFnYWluc3QgYW4gZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZCByZWNvbm5lY3RzIGF0ICs0Ny40IHMsXG4gKiArOTIuNiBzIGFuZCArMTM3LjkgcyBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2VcbiAqIGFuIHVucmVsYXRlZCB0aGlyZCBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uIOKaoCBHcmFwZXZpbmUgaXMgdGhlIHNwZWxsIHRoYXRcbiAqIG1ha2VzIHRoZSBwb2ludCBzaGFycGVzdDogaXQgYmVhdHMgYXQgKiozIHMqKiwgYSBmaWZ0aCBvZiB0aGUgaG91c2UgZGVmYXVsdCxcbiAqIHNvIGEgY29waWVkIDQ1LDAwMCB3b3VsZCB0b2xlcmF0ZSBGSUZURUVOIG1pc3NlZCBiZWF0cyB3aGVyZSBldmVyeSBzaWJsaW5nXG4gKiB0b2xlcmF0ZXMgdGhyZWUuIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgYmVhdCBpdFxuICogaXMgd2F0Y2hpbmcsIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4puUICoqQU5EIFwiV0hBVEVWRVIgVEhFIEJFQVQgQkVDT01FU1wiIElTIFdIWSBUSEUgRU5WIElTIFJFU09MVkVEIEhFUkUgQU5EXG4gKiBOT1dIRVJFIEVMU0UgKEQ3NSkuIFRIRSBQT1JUIFJFLUNSRUFURUQgQVNUUk9MQUJFJ1MgREVGRUNUIElOIFRISVMgRklMRS4qKlxuICogQ2hhcHRlciAyIHNoaXBwZWQgYEhFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gKiDigKYpYCBhdCBgZGFlbW9uLnRzOjExMmAgd2hpbGUgdGhpcyBmaWxlIGtlcHQgYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgXG4gKiBhZ2FpbnN0IHRoZSBMSVRFUkFMIDMsMDAwOiB0aGUgZGFlbW9uJ3MgYmVhdCB3YXMgdHVuYWJsZSBhbmQgdGhlIENMSSdzXG4gKiB3YXRjaGRvZyB3YXMgbm90LCBzbyAqKmFueSB2YWx1ZSBhYm92ZSAzLDAwMCBicm9rZSBldmVyeSB0YWlsLioqIE1FQVNVUkVEIGF0XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0yMDAwMGAgYWdhaW5zdCBhIGhlYWx0aHkgZGFlbW9uLCBiZWZvcmUgdGhlIHJlcGFpcjogYVxuICogcmVhbCBgY2xpLnRzIHRhaWxgIHJlLXN1YnNjcmliZWQgKio0IHRpbWVzIGluIDMwIHMqKiAofjkgcyBhcGFydCwgaXRzIHdhdGNoZG9nXG4gKiBmaXJpbmcgYmVmb3JlIGEgc2luZ2xlIDIwIHMgYmVhdCBjb3VsZCBsYW5kIOKAlCAqKjAga2VlcGFsaXZlcyBhcnJpdmVkKiopLCBhbmRcbiAqIGAvY2hhbm5lbHMvd2Qvc3Vic2NyaWJlcnNgIHJlcG9ydGVkIGBjb3VudDogMiwgY29ubmVjdGlvbnM6IDIsIG5hbWVkOiAyYCBmb3JcbiAqICoqb25lKiogbGl2ZSB0YWlsLCBiZWNhdXNlIHRoZSBhYmFuZG9uZWQgc3RyZWFtcyBhcmUgbm90IHJlYXBlZCB1bnRpbCB0aGVcbiAqIG5vdy0yMCBzIGJlYXQgZmFpbHMgdG8gZW5xdWV1ZS4gVGhhdCBpcyB0aGUgYXN0cm9sYWJlIHNjYXIgdHdvIHBhcmFncmFwaHMgdXAsXG4gKiByZS1jcmVhdGVkIGluc2lkZSB0aGUgZmlsZSB0aGF0IGRvY3VtZW50cyBpdC4gKipPbmUgaGFsZiBvZiB0aGUgcGFpciB0dW5hYmxlXG4gKiBhbmQgdGhlIG90aGVyIGEgY29uc3RhbnQgSVMgdGhlIGRlZmVjdCoqIOKAlCB0aGUgZGVyaXZhdGlvbiBvbmx5IGhvbGRzIGlmIGl0XG4gKiBkZXJpdmVzIGZyb20gdGhlIHZhbHVlIHRoYXQgYWN0dWFsbHkgc2hpcHBlZC5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKiBgcHJvY2Vzcy5lbnZgIGlzIG5vdCBzdWNoIGFuIGltcG9ydDogaXQgaXMgYW1iaWVudCBpbiBib3RoIGhhbHZlcywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgd2h5IHRoaXMgZmlsZSDigJQgYW5kIG5vdCBgZGFlbW9uLnRzYCDigJQgY2FuIGhvbGQgdGhlIHJlc29sdXRpb24uIChUaGlzXG4gKiBpcyBib3VudHkncyBzaGFwZSwgdW5jaGFuZ2VkOiBgc3JjL2JvdW50eS9iYWNrZW5kL2hlYXJ0YmVhdC50c2AgcmVzb2x2ZXNcbiAqIGBCT1VOVFlfSURMRV9USU1FT1VUX1NFQ2AgYW5kIGBCT1VOVFlfSEVBUlRCRUFUX01TYCBpbiB0aGUgc2VhbSBmaWxlIGZvciB0aGVcbiAqIHNhbWUgcmVhc29uLilcbiAqL1xuXG5pbXBvcnQge1xuICBoZWFydGJlYXRNcyxcbiAgaWRsZVRpbWVvdXRTZWMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSwgaW4gc2Vjb25kcy4gR3JhcGV2aW5lJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkXG4gKiBvbmU6IGBkYWVtb24udHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHVuZGVyIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdFxuICogQnVuJ3MgZGVmYXVsdCAxMCBzIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXNcbiAqIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMg4oCUIGFuZCB0aGF0IGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiLCBpdCBpcyB0aGVcbiAqIGRlZmF1bHQuXG4gKlxuICog4pqgIGBHUkFQRVZJTkVfSURMRV9USU1FT1VUX1NFQ2AgaXMgYWNjZXB0ZWQgc28gdGhlIFBBSVIgY2FuIGJlIHR1bmVkIHRvZ2V0aGVyLFxuICogYW5kIHRoZSBjbGFtcCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLiAoVGhpcyBmaWxlIHVzZWQgdG8gc2F5XG4gKiBncmFwZXZpbmUgXCJkb2VzIG5vdCBlbnYtdHVuZSBpdFwiIHdoaWxlIGBkYWVtb24udHNgIGVudi10dW5lZCBpdCB0ZW4gbGluZXMgZnJvbVxuICogd2hlcmUgaXQgaW1wb3J0ZWQgdGhpcyBjb25zdGFudCDigJQgdGhlIHNhbWUgb25lLWhhbGYtdHVuYWJsZSBzcGxpdCBhcyB0aGUgYmVhdCxcbiAqIGFuZCBjb3JyZWN0ZWQgaW4gdGhlIHNhbWUgY2hhcHRlci4pXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKlxuICogVGhlIFNTRSBrZWVwYWxpdmUsIGluIG1zIOKAlCB0aGUgREVGQVVMVCwgYmVmb3JlIHRoZSBlbnYgaXMgY29uc3VsdGVkLlxuICog4pqgICoqMyBzLCBhbmQgaXQgaXMgTk9UIHRoZSBob3VzZSBkZWZhdWx0IG9mIDE1IHMqKiDigJQgZ3JhcGV2aW5lIGlzIHRoZSBvbmx5XG4gKiBzcGVsbCBpbiB0aGUgcm9zdGVyIHRoYXQgYmVhdHMgdGhpcyBmYXN0LCBhbmQgdGhlIG51bWJlciBpcyBsb2FkLWJlYXJpbmdcbiAqIHJhdGhlciB0aGFuIGluY2lkZW50YWw6IHRoZSBiZWF0IGlzIGFsc28gZ3JhcGV2aW5lJ3MgZGVhZC1zdWJzY3JpYmVyIHByb2JlLiBBXG4gKiB0YWlsIHdob3NlIHNvY2tldCBoYXMgZ29uZSBhd2F5IGlzIGRpc2NvdmVyZWQgd2hlbiB0aGUgZW5xdWV1ZSBmYWlscywgYW5kXG4gKiB1bnRpbCBpdCBpcyBkaXNjb3ZlcmVkIGB3aG9gLCBgL3ByZXNlbmNlYCBhbmQgZXZlcnkgc2VuZCdzIHJlY2lwaWVudCBjb3VudFxuICogcmVwb3J0IGEgZ2hvc3QuIEV2ZXJ5IG90aGVyIHNwZWxsJ3MgaGVhcnRiZWF0IG9ubHkgaGFzIHRvIGtlZXAgYSBjb25uZWN0aW9uXG4gKiBvcGVuOyB0aGlzIG9uZSBhbHNvIGhhcyB0byBrZWVwIGEgUk9TVEVSIGhvbmVzdCwgd2hpY2ggaXMgYSBodW1hbi12aXNpYmxlXG4gKiBudW1iZXIgaW4gdGhlIHdhdGNoIHN1cmZhY2UuIOKblCAqKlNvIHJhaXNpbmcgdGhpcyBrbm9iIG1ha2VzIHByZXNlbmNlXG4gKiBzdGFsZXIsIG5vdCBqdXN0IHF1aWV0ZXIqKiDigJQgaXQgaXMgdGhlIG9uZSB0aGluZyBhbiBvcGVyYXRvciB0dW5pbmcgaXQgc2hvdWxkXG4gKiBrbm93LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TID0gM18wMDA7XG5cbi8qKlxuICogVGhlIGJlYXQgYXMgaXQgd2lsbCBhY3R1YWxseSBiZSB1c2VkLCBlbnYtcmVzb2x2ZWQgYW5kIGNsYW1wZWQgYXQgYm90aCBlbmRzIGJ5XG4gKiB0aGUga2l0OiBuZXZlciBhYm92ZSBgSURMRV9USU1FT1VUX1NFQyAvIDJgIChvciBCdW4gY2xvc2VzIHRoZSBjb25uZWN0aW9uIHRoZVxuICoga2VlcGFsaXZlIHdhcyBwcmVzZXJ2aW5nKSwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIOKblCBUSEUgRkxPT1IgSVMgTk9UIERFQ09SQVRJT04gKEQ3NikuIGBpbnRPcmAgcGFyc2VzIHdpdGggYHBhcnNlSW50YCwgd2hpY2hcbiAqIHJlYWRzIGBcIjFlOVwiYCDigJQgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdCBodWdlXCIg4oCUIGFzICoqMSoqLlxuICogRHJpdmVuIGJlZm9yZSB0aGUgZmxvb3IgZXhpc3RlZDogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOFxuICoga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0UgY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIOKGkiAzIG1zIGFuZFxuICogYFwiNWFiY1wiYCDihpIgNSBtcyBhcnJpdmUgdGhlIHNhbWUgd2F5LiBUaGUgZmxvb3IgbGl2ZXMgaW4gdGhlIGtpdCdzXG4gKiBgaGVhcnRiZWF0TXNgIGJlc2lkZSB0aGUgY2VpbGluZyBpdCBjYW5ub3QgY3Jvc3MsIE5PVCBpbiBgaW50T3JgLCB3aGljaCBldmVyeVxuICogb3RoZXIga25vYiBpbiB0aGUgaG91c2Ugc2hhcmVzLlxuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSEVBUlRCRUFUX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuIDksMDAwIG1zIGF0IHRoZSBkZWZhdWx0LlxuICpcbiAqIOKblCAqKlRIRSBUQUlMIEhBRCBOTyBXQVRDSERPRyBBVCBBTEwgQkVGT1JFIFRISVMuKiogYGNtZFRhaWxgJ3MgaW5uZXIgbG9vcFxuICogYXdhaXRlZCBgcmVhZGVyLnJlYWQoKWAgd2l0aCBub3RoaW5nIGJvdW5kaW5nIGl0LCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXJcbiAqIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kIG9yIGEgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgRk9SRVZFUiDigJQgYW5kXG4gKiBhIHBhcmtlZCB0YWlsIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLCB3aGljaCBpcyB0aGUgc3RhdGVcbiAqIGdyYXBldmluZSdzIGNhbGxlcnMgc3BlbmQgbW9zdCBvZiB0aGVpciB0aW1lIGluLlxuICpcbiAqIOKaoCA5IHMgaXMgYWdncmVzc2l2ZSBieSBob3VzZSBzdGFuZGFyZHMgKDQ1IHMgZXZlcnl3aGVyZSBlbHNlKSBhbmQgdGhhdCBpcyB0aGVcbiAqIGRlcml2YXRpb24gd29ya2luZywgbm90IGEgbWlzdGFrZTogaXQgaXMgdGhyZWUgb2YgVEhJUyBzcGVsbCdzIGJlYXRzLiBIb2xkaW5nXG4gKiB0aGUgY29ubmVjdGlvbiBvcGVuIElTIGEgdGFpbCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwc1xuICogYSBuYW1lIGluIGEgaHVtYW4ncyByb3N0ZXIg4oCUIHdoaWNoIGlzIHdoeSBpdCBpcyB0aHJlZSBiZWF0cyBhbmQgbm90IHR3by5cbiAqXG4gKiDim5QgREVSSVZFRCBGUk9NIFRIRSBSRVNPTFZFRCBCRUFULCBORVZFUiBGUk9NIFRIRSBERUZBVUxULiBJdCBpc1xuICogYFNTRV9IRUFSVEJFQVRfTVNgIGFib3ZlIGFuZCBub3QgYERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NU2Agb24gcHVycG9zZTsgdGhlXG4gKiByZXBhaXIgY2hhcHRlciBpcyB3aGF0IHRoZSBkaWZmZXJlbmNlIGNvc3QuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQWlCQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFRQTtBQUNBO0FBQ0E7QUFDQSxzQkFBUzs7O0FDd0JGLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFP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LFlBQVksS0FBSyxRQUNyQixLQUFLLFlBQVksSUFBSSxDQUFDLE1BQU8sRUFBRSxXQUFXLElBQUksRUFBRSxVQUFVLElBQUksRUFBRSxPQUFRLEVBQUUsS0FBSyxHQUFHLEtBQ2xGO0FBQUEsSUFFSixDQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTSxVQUFVLE1BQU0sS0FBSyxJQUFJLFlBQVksS0FBSztBQUFBLEVBQ2hELE9BQU8sT0FBTyxZQUFZLFdBQVcsVUFBVTtBQUFBO0FBa0JqRCxlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELGtCQUFrQixLQUFLLE1BQU0sSUFBSTtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxTQUFTLElBQUk7QUFBQSxJQUMxQixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sT0FBTyxlQUFlLENBQUM7QUFBQSxJQUM3QixJQUFJLFNBQVM7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUMxQixNQUFNO0FBQUE7QUFBQTtBQWVWLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkRENkQ0QTE2ODlCOEIwMUQ2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
