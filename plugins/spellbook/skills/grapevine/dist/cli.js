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

//# debugId=D7248CE08B1393E264756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9ncmFwZXZpbmUvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGdyYXBldmluZSBDTEkg4oCUIHRoaW4gd3JhcHBlciBhcm91bmQgdGhlIGRhZW1vbidzIEhUVFAgc3VyZmFjZS5cbi8vXG4vLyBVc2FnZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIGxpc3Rcbi8vICAgYnVuIGNsaS50cyBzZW5kIDxuYW1lPiAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyB0YWlsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl1cbi8vICAgYnVuIGNsaS50cyByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdXG4vLyAgIGJ1biBjbGkudHMgY2xvc2UgPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgc3RvcFxuLy8gICBidW4gY2xpLnRzIGluZm9cbi8vXG4vLyBgdGFpbGAgd3JpdGVzIGVhY2ggaW5jb21pbmcgbWVzc2FnZSBhcyBvbmUgSlNPTkwgbGluZSBvbiBzdGRvdXQuIFBpcGVcbi8vIG9yIHdyYXAgd2l0aCBNb25pdG9yLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgdW5saW5rU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBFcnJFeHRyYSxcbiAgdHlwZSBFcnJLaW5kLFxuICBkaWUgYXMgcmFpc2UsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHsgY29tbWFuZExpbmUsIHNlbGZDb21tYW5kLCB0YWlsV2l0aEhhbmRvZmYgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEhhbmRvZmYudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG5jb25zdCBEQVRBX0RJUiA9IHByb2Nlc3MuZW52LkdSQVBFVklORV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5ncmFwZXZpbmVcIik7XG5jb25zdCBQT1JUX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5waWRcIik7XG5jb25zdCBIT0xEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5ob2xkXCIpO1xuLy8gUGVyc2lzdGVkIGlkZW50aXR5IGNvbmZpZyAoVjEuNykg4oCUIGBncmFwZXZpbmUgYWxpYXMgPG5hbWU+YCB3cml0ZXMgaXQ7IHRoZVxuLy8gZGFlbW9uIHNlcnZlcyBpdCB0byB0aGUgd2F0Y2ggdmlhIEdFVCAvaWRlbnRpdHkuXG5jb25zdCBDT05GSUdfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiY29uZmlnLmpzb25cIik7XG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIE5FVkVSIEEgRkxBVCBTSUJMSU5HIChwbGF5Ym9vayBCNCkuIFRoaXMgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJkYWVtb24udHNcIilgIOKAlCBnbGFtb3VyJ3MgZXhhY3Qgc2hpcHBlZCBkZWZlY3Qg4oCUIHdoaWNoIHdhc1xuLy8gdHJ1ZSBmb3IgZXhhY3RseSBhcyBsb25nIGFzIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tXG4vLyBgZGlzdC9gIHRoYXQgcmVzb2x2ZXMgdG8gYGRpc3QvZGFlbW9uLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgYW5kIG11c3Qgbm90XG4vLyBleGlzdC4gVGhlIHN5bXB0b20gaXMgbm90IGEgY3Jhc2g6IHRoZSBzcGF3biBmYWlscyBzaWxlbnRseSAodGhlIGRhZW1vbidzXG4vLyBzdGRpbyBpcyBpZ25vcmVkKSwgbm8gcG9ydCBmaWxlIGV2ZXIgYXBwZWFycywgYW5kIHRoZSAzIHMgcG9sbCBsb29wIGJlbG93XG4vLyByZXBvcnRzIGBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc2Ag4oCUIHdoaWNoIGlzIEFMU08gd2hhdCBhIGxhdW5jaGVyXG4vLyB0aGF0IGV4aXRzIGEgbGl2ZSBkYWVtb24gcmVwb3J0cyAoRDY5KSBhbmQgQUxTTyB3aGF0IGEgZGV2LW1vZGUgZGFlbW9uIGR5aW5nXG4vLyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQgcmVwb3J0cyAoc2VlIGBlbnN1cmVEYWVtb25gKS4gVGhyZWUgZGVmZWN0IGNsYXNzZXMsIG9uZVxuLy8gc2VudGVuY2U7IHRoaXMgaXMgdGhlIGZpcnN0IG9mIHRoZSB0aHJlZS5cbi8vIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgcmVzb2x2ZXMgdGhpcyBhcml0aG1ldGljIHRoZSB3YXkgdGhlXG4vLyBydW50aW1lIHdpbGwsIGZyb20gdGhlIEVNSVRURUQgZmlsZSdzIG93biBkaXJlY3RvcnksIGFuZCBhc3NlcnRzIHRoZSBmaWxlIGlzXG4vLyB0aGVyZS5cbmNvbnN0IERBRU1PTl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwiZGFlbW9uLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBUaGUgd2F0Y2ggc3VyZmFjZSBpcyBidWlsdCAoc3JjL2dyYXBldmluZS9zdXJmYWNlIOKGkiBkaXN0LykuIEJ1biByZWFkc1xuLy8gYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIGluIERFViBtb2RlIHRoZSBkYWVtb24nc1xuLy8gY3dkIE1VU1QgYmUgc3JjL2dyYXBldmluZS8gKHNlYW1zIENvbnRyYWN0IDUpIOKAlCBsYXVuY2hlZCBlbHNld2hlcmUgdGhlIGRldlxuLy8gYnVuZGxlciBjYW5ub3QgY29tcGlsZSB0aGUgc3R5bGVzaGVldCBhbmQgdGhlIHBhZ2UgZmFpbHMgKG1lYXN1cmVkIG9uXG4vLyBnbGFtb3VyOiBIVFRQIDUwMCwgbm8gc3R5bGVzaGVldCBsaW5rKS4gSW4gUkVMRUFTRSBtb2RlIGRpc3QvIGlzIHN0YXRpYyBhbmRcbi8vIHByZS1idWlsdCwgbm8gYnVuZmlnIGlzIHJlYWQsIGFuZCBzcmMvZ3JhcGV2aW5lLyBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLykg4oCUIHNvIHRoZSBjd2Qgc3RheXMgYXRcbi8vIHRoZSBza2lsbCByb290LiBTYW1lIHNoYXBlIGFzIGdsYW1vdXIncyBkYWVtb25Dd2QoKS4gRXhwb3J0ZWQgZm9yIHRlc3RzLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcImdyYXBldmluZVwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vLyDilIDilIAgRGFlbW9uIEhUVFAgcHJvdG9jb2wg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBSZXNwb25zZSBzaGFwZXMgdGhlIGRhZW1vbiBlbWl0cy4gQW55IGVuZHBvaW50IGNhbiBhbHNvIHJldHVybiBhbiBlcnJvclxuLy8gYm9keSB3aXRoIGEgNHh4LzV4eCBzdGF0dXMsIHNvIGVhY2ggY2FycmllcyBhbiBvcHRpb25hbCBgZXJyb3JgLlxuXG50eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBudW1iZXI7XG4gIGNoYW5uZWw6IHN0cmluZztcbiAgZnJvbTogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIGtpbmQ6IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIGluX3JlcGx5X3RvPzogbnVtYmVyO1xuICB0YXJnZXQ/OiBudW1iZXI7XG4gIGRpc3Bvc2l0aW9uPzogc3RyaW5nO1xuICAvLyBDaGFubmVsLWxldmVsIGxpZmVjeWNsZSBmYWN0IChhcmNoaXZlIC8gdW5hcmNoaXZlKS4gQSBraW5kOlwic3RhdHVzXCIgZnJhbWVcbiAgLy8gY2FycnlpbmcgYGV2ZW50YCBhbmQgbm8gYGRpc3Bvc2l0aW9uYCDigJQgc2VlIGlzRGlzcG9zaXRpb25GcmFtZS5cbiAgZXZlbnQ/OiBcImFyY2hpdmVkXCIgfCBcInVuYXJjaGl2ZWRcIjtcbn07XG5cbi8vIEdFVCAvIOKAlCBkYWVtb24gbGl2ZW5lc3MvaW5mby5cbnR5cGUgUm9vdEluZm8gPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgcGlkPzogbnVtYmVyO1xuICBzdGFydGVkX2F0PzogbnVtYmVyO1xuICBjaGFubmVscz86IG51bWJlcjtcbiAgZGF0YV9kaXI/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyDigJQgbWVzc2FnZSByZWNlaXB0IHdpdGggZGVsaXZlcnkgYWNjb3VudGluZy5cbnR5cGUgU2VuZFJlY2VpcHQgPSBNZXNzYWdlICYge1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgcmVjaXBpZW50cz86IG51bWJlcjtcbiAgc3Vic2NyaWJlcl9hbGlhc2VzPzogc3RyaW5nW107XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvYW5ub3VuY2Ug4oCUIGNyb3NzLWNoYW5uZWwgYnJvYWRjYXN0IHJlY2VpcHQuXG50eXBlIEFubm91bmNlUmVjZWlwdCA9IHtcbiAgb2s6IGJvb2xlYW47XG4gIGNoYW5uZWxzOiB7IG5hbWU6IHN0cmluZzsgcmVjaXBpZW50czogbnVtYmVyIH1bXTtcbiAgc2tpcHBlZDogeyBuYW1lOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH1bXTtcbiAgdG90YWxfcmVjaXBpZW50czogbnVtYmVyO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMg4oCUIGNoYW5uZWwgZGlyZWN0b3J5IGxpc3RpbmcuXG50eXBlIENoYW5uZWxTdW1tYXJ5ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gIC8vIG51bGwgPSB0aGUgZGFlbW9uIGNvdWxkIG5vdCBlc3RhYmxpc2ggYSBjb3VudCAodW5yZWFkYWJsZSBmaWxlKSwgTkVWRVIgMC5cbiAgLy8gMCBtZWFucyBcInRoaXMgY2hhbm5lbCBpcyBnZW51aW5lbHkgZW1wdHlcIiBhbmQgbm90aGluZyBlbHNlIOKAlCBiNS5cbiAgbWVzc2FnZV9jb3VudDogbnVtYmVyIHwgbnVsbDtcbiAgbGFzdF9hY3Rpdml0eTogbnVtYmVyO1xuICBsb2FkZWQ6IGJvb2xlYW47XG59O1xudHlwZSBDaGFubmVsc1Jlc3BvbnNlID0geyBjaGFubmVscz86IENoYW5uZWxTdW1tYXJ5W107IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEFueSBlbmRwb2ludCBtYXkgcmVwbHkgd2l0aCBqdXN0IGFuIGVycm9yL29rIGVudmVsb3BlLlxudHlwZSBTdGF0dXNSZXNwb25zZSA9IHsgb2s/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyBhbmQgP3NpbmNlPSByYW5nZXMuXG50eXBlIE1lc3NhZ2VzUmVzcG9uc2UgPSB7IG1lc3NhZ2VzPzogTWVzc2FnZVtdOyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi93YWl0IOKAlCBsb25nLXBvbGwgYmF0Y2guXG50eXBlIFdhaXRSZXNwb25zZSA9IHtcbiAgbWVzc2FnZXM/OiBNZXNzYWdlW107XG4gIGN1cnNvcj86IG51bWJlcjtcbiAgdGltZWRfb3V0PzogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIC8vIEEgcmVmdXNhbCBuYW1lcyB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoNDA0IG9uIGEgbWlzc2luZyBjaGFubmVsKS5cbiAgaGludD86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzIOKAlCBvcGVuL2Vuc3VyZSBhIGNoYW5uZWwuXG50eXBlIE9wZW5SZXNwb25zZSA9IHtcbiAgbmFtZT86IHN0cmluZztcbiAgY3JlYXRlZF9hdD86IG51bWJlcjtcbiAgbWVzc2FnZV9jb3VudD86IG51bWJlcjtcbiAgc3Vic2NyaWJlcnM/OiBudW1iZXI7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgdW5hcmNoaXZlZD86IGJvb2xlYW47XG4gIGNsZWFyZWQ/OiBib29sZWFuO1xuICBzbmFwc2hvdD86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vdG9waWMgYW5kIFBVVCAvY2hhbm5lbHMvPG5hbWU+L3RvcGljLlxudHlwZSBUb3BpY1Jlc3BvbnNlID0ge1xuICBvaz86IGJvb2xlYW47XG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgaWQ/OiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vc3Vic2NyaWJlcnMg4oCUIHNpbmdsZS1jaGFubmVsIHJvc3Rlci5cbnR5cGUgU3Vic2NyaWJlcnNSZXNwb25zZSA9IHtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgc3Vic2NyaWJlcnM/OiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvdW50PzogbnVtYmVyO1xuICBjb25uZWN0aW9ucz86IG51bWJlcjtcbiAgbmFtZWQ/OiBudW1iZXI7XG4gIGFub255bW91cz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBlci1jaGFubmVsIHByZXNlbmNlIGVudHJ5IGZyb20gR0VUIC9wcmVzZW5jZS5cbnR5cGUgUHJlc2VuY2VDaGFubmVsID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gIG5hbWVkOiBudW1iZXI7XG4gIGFub255bW91czogbnVtYmVyO1xufTtcbnR5cGUgUHJlc2VuY2VSZXNwb25zZSA9IHsgY2hhbm5lbHM/OiBQcmVzZW5jZUNoYW5uZWxbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gU1NFIGZyYW1lcyBwdXNoZWQgb24gR0VUIC9jaGFubmVscy88bmFtZT4vdGFpbC4gVHdvIGZyYW1lIGtpbmRzIGFycml2ZSBvblxuLy8gdGhlIHNhbWUgYGRhdGE6YCBsaW5lIOKAlCBhIGBzdWJzY3JpYmVkYCBldmVudCBhbmQgcGVyLW1lc3NhZ2UgZnJhbWVzIOKAlCBzbyB0aGVcbi8vIGRlY29kZWQgcGF5bG9hZCBpcyBhIHVuaW9uLiBBbGwgZmllbGRzIG9wdGlvbmFsIGJlY2F1c2UgdGhlIGZyYW1lIGlzXG4vLyB1bnRydXN0ZWQgd2lyZSBkYXRhIG5hcnJvd2VkIGF0IHRoZSB1c2Ugc2l0ZS5cbnR5cGUgVGFpbFBheWxvYWQgPSB7XG4gIC8vIHN1YnNjcmliZWQtZXZlbnQgZmllbGRzXG4gIHNpbmNlPzogbnVtYmVyO1xuICBhcz86IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdF9pZD86IG51bWJlcjtcbiAgLy8gVHJ1ZSB3aGVuIFRISVMgc3Vic2NyaWJlIGNyZWF0ZWQgdGhlIGNoYW5uZWwg4oCUIHRoZSBzaWduYWwgdGhhdCBzZXBhcmF0ZXNcbiAgLy8gXCJxdWlldCBjaGFubmVsXCIgZnJvbSBcInlvdSB0YWlsZWQgYSBuYW1lIHRoYXQgZGlkIG5vdCBleGlzdFwiLlxuICBjcmVhdGVkPzogYm9vbGVhbjtcbiAgLy8gVHJ1ZSB3aGVuIHRoZSBjaGFubmVsIGlzIGFscmVhZHkgYXJjaGl2ZWQgKHJlYWQtb25seSkgYXQgc3Vic2NyaWJlIHRpbWUg4oCUXG4gIC8vIHRoZSBzaWduYWwgZm9yIGEgTEFURSBqb2luZXIsIHdobyB3b3VsZCBvdGhlcndpc2UgbGVhcm4gaXQgZnJvbSBhIHJlamVjdGVkXG4gIC8vIHNlbmQuIFRoZSBsaWZlY3ljbGUgZnJhbWUgb25seSByZWFjaGVzIGFuIGFnZW50IHRoYXQgd2FzIGNvbm5lY3RlZCBhdCB0aGVcbiAgLy8gbW9tZW50LCBvciB0aGF0IHB1bGxzIGhpc3RvcnkuXG4gIGFyY2hpdmVkPzogYm9vbGVhbjtcbiAgLy8gbWVzc2FnZSBmaWVsZHNcbiAgaWQ/OiBudW1iZXI7XG4gIGZyb20/OiBzdHJpbmc7XG4gIHRleHQ/OiBzdHJpbmc7XG4gIHRzPzogbnVtYmVyO1xuICBraW5kPzogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgLy8gc2hhcmVkXG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIE91ciBwbHVnaW4gdmVyc2lvbiAoZnJvbSBwbHVnaW4uanNvbikuIFVzZWQgdG8gZGV0ZWN0IGNhY2hlLXBpbm5pbmdcbi8vIG1pc21hdGNoZXMgd2hlbiB3ZSB0YWxrIHRvIGEgZGFlbW9uIHNwYXduZWQgZnJvbSBhIGRpZmZlcmVudCBjYWNoZWRcbi8vIHBhdGguIEJlc3QtZWZmb3J0OyBudWxsIGlmIHJlYWQgZmFpbHMuXG5mdW5jdGlvbiByZWFkUGx1Z2luVmVyc2lvbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbHVnaW5Kc29uUGF0aCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwbHVnaW5Kc29uUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpLnZlcnNpb24gPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmNvbnN0IFBMVUdJTl9WRVJTSU9OID0gcmVhZFBsdWdpblZlcnNpb24oKTtcblxuLy8gT25lLXNob3QgdmVyc2lvbi1taXNtYXRjaCBjaGVjay4gVGhlIGRhZW1vbiBtYXkgYmUgZnJvbSBhIGRpZmZlcmVudFxuLy8gY2FjaGVkIHBsdWdpbiBwYXRoIHRoYW4gdGhpcyBDTEkgKGV4aXN0aW5nIHRhaWwgcHJvY2Vzc2VzJyBhdXRvLXJlY29ubmVjdFxuLy8gY2FuIHJhY2UgYSBgc3RvcGAgYW5kIHJlc3Bhd24gdGhlIG9sZCBkYWVtb24pLiBXYXJuIG9uY2UgcGVyIGludm9jYXRpb25cbi8vIHNvIHRoZSB1c2VyIGhhcyBhIHNpZ25hbCBpbnN0ZWFkIG9mIHNpbGVudGx5IGRlZ3JhZGVkIGJlaGF2aW9yLlxubGV0IF92ZXJzaW9uQ2hlY2tEb25lID0gZmFsc2U7XG5hc3luYyBmdW5jdGlvbiBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0OiBudW1iZXIpIHtcbiAgaWYgKF92ZXJzaW9uQ2hlY2tEb25lKSByZXR1cm47XG4gIF92ZXJzaW9uQ2hlY2tEb25lID0gdHJ1ZTtcbiAgaWYgKCFQTFVHSU5fVkVSU0lPTikgcmV0dXJuOyAvLyBjYW4ndCBjb21wYXJlIGlmIHdlIGRvbid0IGtub3cgb3VyIG93biB2ZXJzaW9uXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICB9KTtcbiAgICBpZiAoIXJlcy5vaykgcmV0dXJuO1xuICAgIGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gICAgY29uc3QgZGFlbW9uVmVyc2lvbiA9IGRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAoZGFlbW9uVmVyc2lvbiA9PT0gbnVsbCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIGlzIG9sZGVyIHRoYW4gdGhpcyBDTEkgKG5vIHZlcnNpb24gcmVwb3J0ZWQpLiBgICtcbiAgICAgICAgICBgQ0xJIGlzIHYke1BMVUdJTl9WRVJTSU9OfS4gU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gYCArXG4gICAgICAgICAgYFJlc3RhcnQgdGhlIGRhZW1vbiAoZHJvcCB0YWlscywgdGhlbiBcXGBzdG9wXFxgLCB0aGVuIGFueSB2ZXJiKSB0byB1cGdyYWRlLlxcbmAsXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZGFlbW9uVmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT04pIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBncmFwZXZpbmU6IGRhZW1vbiB2ZXJzaW9uICh2JHtkYWVtb25WZXJzaW9ufSkgZGlmZmVycyBmcm9tIENMSSB2ZXJzaW9uICh2JHtQTFVHSU5fVkVSU0lPTn0pLiBgICtcbiAgICAgICAgICBgU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduLlxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxufVxuLy8gR1JBUEVWSU5FX0ZST00gc2V0cyB0aGUgZGVmYXVsdCAtLWZyb20gLyAtLWFzIGFsaWFzIHNvIGFnZW50cyBkb24ndCBoYXZlXG4vLyB0byByZXBlYXQgdGhlaXIgaWRlbnRpdHkgb24gZXZlcnkgdmVyYi4gUGVyLXZlcmIgZmxhZ3Mgc3RpbGwgb3ZlcnJpZGUuXG5jb25zdCBERUZBVUxUX0FMSUFTID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0ZST00gPz8gdW5kZWZpbmVkO1xuXG4vLyBJZGVudGl0eSBmbGFncyBhcmUgaW50ZXJjaGFuZ2VhYmxlIGFjcm9zcyB2ZXJicy4gYHNlbmRgIGhpc3RvcmljYWxseSB0b29rXG4vLyBgLS1mcm9tYCB3aGlsZSBgdGFpbGAvYHdhaXRgIHRvb2sgYC0tYXNgIOKAlCBzYW1lIGNvbmNlcHQgKHdobyBhbSBJKSwgYW5kIHRoZVxuLy8gYXN5bW1ldHJ5IHRyaXBzIHlvdSBtaWQtZmxvdy4gQWNjZXB0IGVpdGhlciBldmVyeXdoZXJlIGlkZW50aXR5IGlzIG1lYW50LFxuLy8gZmFsbGluZyBiYWNrIHRvIEdSQVBFVklORV9GUk9NLiAoZ3JlcCdzIGAtLWZyb21gIGlzIGEgZGlmZmVyZW50IHRoaW5nIOKAlCBhblxuLy8gYXV0aG9yICpmaWx0ZXIqLCBub3QgaWRlbnRpdHkg4oCUIHNvIGl0IGRvZXNuJ3QgdXNlIHRoaXMuKVxuZnVuY3Rpb24gcmVzb2x2ZUFsaWFzKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiAoZmxhZ3MuZnJvbSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IChmbGFncy5hcyBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IERFRkFVTFRfQUxJQVM7XG59XG4vLyBUcnVuY2F0aW9uLWhpbnQgdGhyZXNob2xkLiBNZXNzYWdlcyBsb25nZXIgdGhhbiB0aGlzIGdldCBhIGB0cnVuY2F0aW9uX2hpbnRgXG4vLyBmaWVsZCBvbiB0aGUgdGFpbCBKU09OIHNvIGNvbnN1bWVycyAoZS5nLiBNb25pdG9yKSBrbm93IHRoZSBub3RpZmljYXRpb25cbi8vIHByZXZpZXcgaXMgaW5jb21wbGV0ZSBhbmQgc2hvdWxkIGByZWFkYCB0aGUgZnVsbCBib2R5LiBJbiBhZ2VudC10by1hZ2VudFxuLy8gdHJhZmZpYywgbG9uZyBtZXNzYWdlcyBhcmUgdGhlIE5PUk0gKHRoZSBWMS42IHJvdW5kdGFibGUgc2F3IG1vc3Qgc3Vic3RhbnRpdmVcbi8vIG1lc3NhZ2VzIGV4Y2VlZCA4MDApLCBzbyBhbiA4MDAgZGVmYXVsdCBmaXJlZCBvbiBuZWFybHkgZXZlcnl0aGluZyBhbmQgdGhlXG4vLyByZWNvdmVyeSBwYXRoIGJlY2FtZSB0aGUgbWFpbiBwYXRoLiBEZWZhdWx0IHJhaXNlZCB0byAyMDAwIHNvIHRoZSBoaW50IG1hcmtzXG4vLyB0aGUgZ2VudWluZWx5LWxvbmcgb3V0bGllcnMuIE92ZXJyaWRhYmxlIHZpYSBlbnYgdmFyIGZvciB0dW5pbmcuXG5jb25zdCBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID0gcGFyc2VJbnQoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9UUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID8/IFwiMjAwMFwiLFxuICAxMCxcbik7XG5cbi8vIE9wdGlvbmFsIGlubGluZS1ib2R5IGNhcCBmb3IgYHRhaWxgIChvcHQtaW4gdmlhIC0tbWF4IDxuPiBvciBHUkFQRVZJTkVfVEFJTF9NQVgpLlxuLy8gV2hlbiBzZXQsIGEgYm9keSBsb25nZXIgdGhhbiB0aGUgY2FwIGlzIHRydW5jYXRlZCB0byBgbmAgY2hhcnMgaW4gdGhlIHRhaWxcbi8vIGZyYW1lIChwbHVzIHRoZSByZWFkLXBvaW50ZXIgaGludCksIHNvIGEgcHVzaCBjb25zdW1lciBjYW4gaGFuZCBpdHNcbi8vIG5vdGlmaWNhdGlvbiBzdXJmYWNlIGEgZGVsaWJlcmF0ZWx5LXNpemVkIGxpbmUuIFRoZSBGVUxMIG1lc3NhZ2UgaXMgYWx3YXlzXG4vLyByZXRyaWV2YWJsZSB2aWEgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLiBVbmRlZmluZWQgPSBubyBjYXAgKGZ1bGwgdGV4dCBpbmxpbmUg4oCUXG4vLyB0b2RheSdzIGRlZmF1bHQpLiBOb3RlOiB0aGUgaGFyZCBjbGlwIGEgY29uc3VtZXIgdWx0aW1hdGVseSBzZWVzIGlzIHN0aWxsIHRoZVxuLy8gTW9uaXRvci9ub3RpZmljYXRpb24gbGF5ZXInczsgLS1tYXggb25seSBib3VuZHMgdGhlIGxpbmUgZ3JhcGV2aW5lIGVtaXRzLlxuLy8gUmVqZWN0cyBuZWdhdGl2ZSAvIG5vbi1udW1lcmljLlxuZnVuY3Rpb24gcmVzb2x2ZVRhaWxNYXgoZmxhZzogdW5rbm93bik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBmbGFnID09PSBcInN0cmluZ1wiID8gZmxhZyA6IHByb2Nlc3MuZW52LkdSQVBFVklORV9UQUlMX01BWDtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdywgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPj0gMCA/IG4gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlIOKAlCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2AncyBgZGllYCwgdW5kZXIgdGhpc1xuICogc3BlbGwncyBvd24gbmFtZSBzbyA0NiBjYWxsIHNpdGVzIGRpZCBub3QgZWFjaCBoYXZlIHRvIGJlIHJlLXNwZWxsZWQuXG4gKlxuICog4puUICoqSVQgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBBIENBTExFUi1WSVNJQkxFIENIQU5HRSoqXG4gKiAoUGhhc2UgNiBjaGFwdGVyIDI7IHRoZSBkZWx0YSBpcyBkcml2ZW4gYW5kIHJlY29yZGVkIGluIHRoZSBqb3VybmFsKS4gVGhpc1xuICogZnVuY3Rpb24gd2FzIGBwcm9jZXNzLnN0ZGVyci53cml0ZShcXGBncmFwZXZpbmU6ICR7bXNnfVxcblxcYCk7IHByb2Nlc3MuZXhpdChjb2RlKWBcbiAqIOKAlCBQUk9TRSBhdCBleGl0IDIgZm9yIGV2ZXJ5IGZhaWx1cmUgZ3JhcGV2aW5lIGNvdWxkIHByb2R1Y2UsIHdpdGggdHdvIHNpdGVzXG4gKiBwYXNzaW5nIDEuIEFmdGVyIHRoZSBhZG9wdGlvbiBpdCBpcyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIHRoZVxuICogYWNjIHRheG9ub215J3MgY29kZXM6IHVzYWdlIDIsIGludGVybmFsIDEsIG5vdF9mb3VuZCA1LCBjb25mbGljdCA2LiBBbiBhZ2VudFxuICogcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZTsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbiBhbmQgcmV3b3JkaW5nXG4gKiBpdCBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkaWQgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlZCBwcm9zZS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIEVOVU1FUkFUSU9OUyBNT1ZFRCBGUk9NIFBST1NFIElOVE8gYGNob2ljZXNgLioqIGdyYXBldmluZSdzXG4gKiByZWplY3Rpb25zIHdlcmUgc2hhcGVkIGZvciBhY2MncyBmbGFnLXNldCBleHRyYWN0b3JzIOKAlCBgcmVjb2duaXplZCBmbGFnczogLS1hXG4gKiAtLWJgLCB3aXRoIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdCBhIHF1YWxpZmllciBiZXR3ZWVuIHRoZSBub3VuIGFuZCB0aGUgY29sb25cbiAqIFwicmVhZHMgYXMgcHJvc2UsIG5vdCBhIHNldFwiLiBXcmFwcGVkIGluIEpTT04gdGhhdCBtYXJrZXIgYmVjb21lcyBhIHN1YnN0cmluZyBvZlxuICogYW4gZXNjYXBlZCBzdHJpbmcsIHNvIGl0IGRvZXMgbm90IHN0YXkgaW4gcHJvc2U6IGV2ZXJ5IGVudW1lcmF0aW9uIGlzIG5vdyBhXG4gKiBgY2hvaWNlc2AgYXJyYXksIHdoaWNoIGlzIHdoYXQgZ2xhbW91ciAoQ09ORk9STUFOVCBMMCkgcHVibGlzaGVzIGFuZCB3aGF0IHRoZVxuICogZW52ZWxvcGUgaGFzIGEgZmllbGQgZm9yLiBUaGUgcnVubmFibGUgcmVjb3Zlcnkg4oCUIGB0cnk6IGJ1biDigKYvY2xpLnRzIG9wZW4geGAg4oCUXG4gKiBtb3ZlZCBpbnRvIGBoaW50YCBmb3IgdGhlIHNhbWUgcmVhc29uLCBhbmQgYSBjYWxsZXIgbm93IHJlYWRzIGEgZmllbGQgaW5zdGVhZFxuICogb2Ygc3BsaXR0aW5nIGEgc2VudGVuY2UuXG4gKlxuICog4pqgIGBkaWVgIGlzIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgc3dhbGxvd3MsIGFuZCB0aGF0IGlzXG4gKiBub3cgYSBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4gQXVkaXRlZCBieSBjYWxsIGdyYXBoIGF0IHRoZVxuICogYWRvcHRpb24gKHBsYXlib29rIEI5KTsgdGhlIGNvdW50IGlzIGluIHRoZSBqb3VybmFsLlxuICovXG5mdW5jdGlvbiBkaWUobXNnOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHJhaXNlKG1zZywga2luZCwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFRoZSB0YXhvbm9teSBga2luZGAgZm9yIGFuIEhUVFAgc3RhdHVzIHRoZSBkYWVtb24gYW5zd2VyZWQgd2l0aC5cbiAqXG4gKiDim5QgT05FIE1BUFBJTkcsIE5PVCBBIEpVREdFTUVOVCBQRVIgU0lURS4gVHdlbnR5IG9mIGdyYXBldmluZSdzIHJhaXNlIHNpdGVzXG4gKiBhcmUgXCJ0aGUgZGFlbW9uIHNhaWQgbm9cIjsgYmVmb3JlIHRoZSBhZG9wdGlvbiBldmVyeSBvbmUgb2YgdGhlbSBjb2xsYXBzZWQgdG9cbiAqIGV4aXQgMiwgc28gYSBtaXNzaW5nIGNoYW5uZWwsIGEgbGl2ZS1zZXNzaW9uIHJlZnVzYWwgYW5kIGEgYnJva2VuIGRhZW1vbiB3ZXJlXG4gKiBvbmUgbnVtYmVyIHRvIGFuIGFnZW50LiBUaGUgZGFlbW9uIGFscmVhZHkgZGlzdGluZ3Vpc2hlcyB0aGVtIGJ5IHN0YXR1cyDigJRcbiAqIDQwNCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QsIDQwOSBmb3IgYXJjaGl2ZWQgLyBsaXZlIC8gYWxyZWFkeS1vcGVuXG4gKiDigJQgc28gdGhlIG1hcHBpbmcgaXMgYSByZS1yZWFkaW5nIG9mIHdoYXQgd2FzIG9uIHRoZSB3aXJlLCBub3QgYSBuZXcgb3Bpbmlvbi5cbiAqL1xuZnVuY3Rpb24ga2luZEZvclN0YXR1cyhzdGF0dXM6IG51bWJlcik6IEVycktpbmQge1xuICBpZiAoc3RhdHVzID09PSA0MDQpIHJldHVybiBcIm5vdF9mb3VuZFwiO1xuICBpZiAoc3RhdHVzID09PSA0MDkpIHJldHVybiBcImNvbmZsaWN0XCI7XG4gIGlmIChzdGF0dXMgPj0gNDAwICYmIHN0YXR1cyA8IDUwMCkgcmV0dXJuIFwidXNhZ2VcIjtcbiAgcmV0dXJuIFwiaW50ZXJuYWxcIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZERhZW1vblBvcnQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKFBPUlRfRklMRSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChyYXcsIDEwKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIC8vIEZpcmUtYW5kLWZvcmdldCBtaXNtYXRjaCBjaGVjayAod29uJ3QgYmxvY2sgdGhlIHZlcmIpLlxuICAgICAgbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydCk7XG4gICAgICByZXR1cm4gcG9ydDtcbiAgICB9XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RhbGUg4oCUIGNsZWFuIHVwLlxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUE9SVF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUElEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBob2xkQWN0aXZlKCk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB1bnRpbCA9IHBhcnNlSW50KHJlYWRGaWxlU3luYyhIT0xEX0ZJTEUsIFwidXRmLThcIikudHJpbSgpLCAxMCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh1bnRpbCkgJiYgdW50aWwgPiBEYXRlLm5vdygpKSByZXR1cm4gdW50aWw7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9IGNhdGNoIHt9IC8vIGV4cGlyZWQg4oaSIGNsZWFuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgZnVuY3Rpb24gcmVsZWFzZUhvbGQoKSB7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgaWYgKGhvbGRBY3RpdmUoKSlcbiAgICBkaWUoXG4gICAgICBcImRhZW1vbiBpcyBoZWxkIChyZXNwYXduIHN1cHByZXNzZWQpIOKAlCB3YWl0IGZvciB0aGUgaG9sZCB0byBjbGVhciBvciBydW4gYGdyYXBldmluZSByb2xsYFwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIC8vIENoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzogdGhlIGRhZW1vbidzIHN0ZGlvIGlzIGlnbm9yZWQsIHNvIGFcbiAgLy8gZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydCB3b3VsZCBvdGhlcndpc2Ugc3VyZmFjZSBvbmx5IGFzXG4gIC8vIFwiZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiIOKAlCBhbmQgbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgRU5PRU5UIG9uXG4gIC8vIHRoZSBleGVjdXRhYmxlLCB3aGljaCByZWFkcyBhcyBcImJ1biBpcyBtaXNzaW5nXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBncmFwZXZpbmUgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH0uIGAgK1xuICAgICAgICBcIk5vIGRpc3QvaW5kZXguaHRtbCB3YXMgZm91bmQgKG9yIFNQRUxMQk9PS19TVVJGQUNFX01PREU9ZGV2IGlzIHNldCksIHNvIHRoZSBkYWVtb24gXCIgK1xuICAgICAgICBcIm11c3QgcnVuIGZyb20gc3JjL2dyYXBldmluZS8gdG8gYnVuZGxlIHRoZSB3YXRjaCBzdXJmYWNlLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgXCIgK1xuICAgICAgICBcImRvZXMgbm90IGhhdmUuIEVpdGhlciB0aGUgc2hpcHBlZCBkaXN0LyBpcyBtaXNzaW5nIChyZWluc3RhbGwgdGhlIHNwZWxsKSBvciB5b3UgYXJlIGluIFwiICtcbiAgICAgICAgXCJhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dyYXBldmluZS8uXCIsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgKTtcbiAgfVxuICAvLyBTcGF3biBkZXRhY2hlZCBzbyB0aGUgZGFlbW9uIHN1cnZpdmVzIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdC5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtEQUVNT05fU0NSSVBUXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2QsXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFdhaXQgdXAgdG8gM3MgZm9yIHRoZSBwb3J0IGZpbGUgdG8gYXBwZWFyIGFuZCByZXNwb25kLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIH1cbiAgZGllKFwiZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiwgXCJpbnRlcm5hbFwiLCB7XG4gICAgaGludDpcbiAgICAgIFwidGhyZWUgdW5yZWxhdGVkIGNhdXNlcyByZXBvcnQgdGhpcyBvbmUgc2VudGVuY2U6IHRoZSBkYWVtb24ncyBsYXVuY2hlciBzaGFwZSwgXCIgK1xuICAgICAgXCJhIHdyb25nIHNwYXduIHBhdGgsIGFuZCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQuIFwiICtcbiAgICAgIFwiUnVuIHRoZSBkYWVtb24gbGF1bmNoZXIgYWxvbmUgdG8gdGVsbCB0aGVtIGFwYXJ0IOKAlCBpdCBpcyB0aGUgbGF1bmNoZXIgc2hhcGUgXCIgK1xuICAgICAgXCJpZmYgaXQgcHJpbnRzIGBsaXN0ZW5pbmcgb24g4oCmYCBhbmQgcmV0dXJucyBhdCBleGl0IDAuIEFuIGVtcHR5IFwiICtcbiAgICAgIFwiR1JBUEVWSU5FX0hPTUUgKG5vIGBjaGFubmVscy9gKSBtZWFucyB0aGUgZGFlbW9uIG5ldmVyIGJvdW5kIGF0IGFsbC5cIixcbiAgfSk7XG59XG5cbi8vIEdlbmVyaWMgb3ZlciB0aGUgZXhwZWN0ZWQgc3VjY2VzcyBib2R5LiBgZGF0YWAgbWF5IGJlIG51bGwgaWYgdGhlIHJlc3BvbnNlXG4vLyBoYWQgbm8gSlNPTiBib2R5LCBzbyBjYWxsZXJzIHNlZSBgVCB8IG51bGxgLlxuYXN5bmMgZnVuY3Rpb24gYXBpPFQgPSB1bmtub3duPihcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogVCB8IG51bGwgfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IFQgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFQ7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG4vLyBIb3cgVEhJUyBDTEkgd2FzIGludm9rZWQsIGFzIGEgcnVubmFibGUgcHJlZml4LiBgcHJvY2Vzcy5hcmd2WzFdYCBpcyB0aGVcbi8vIGFic29sdXRlIHBhdGggb2YgY2xpLnRzIHVuZGVyIGBidW4g4oCmL2NsaS50cyA8dmVyYj5gLCB3aGljaCBpcyBTS0lMTC5tZCdzXG4vLyBjYW5vbmljYWwgaW52b2NhdGlvbiDigJQgc28gdGhlIGxpbmUgd2UgcHJpbnQgY2FuIGFjdHVhbGx5IGJlIHBhc3RlZC4gRmFsbHNcbi8vIGJhY2sgdG8gdGhlIGJhcmUgdmVyYiBpZiBhcmd2IGlzIG5vdCBzaGFwZWQgYXMgZXhwZWN0ZWQsIHdoaWNoIGlzIGEgdmVyYlxuLy8gcmVmZXJlbmNlIHJhdGhlciB0aGFuIGEgY29tbWFuZCB0aGF0IGxpZXMgYWJvdXQgYmVpbmcgb25lLlxuZnVuY3Rpb24gaW52b2NhdGlvblByZWZpeCgpOiBzdHJpbmcge1xuICBjb25zdCBlbnRyeSA9IHByb2Nlc3MuYXJndlsxXTtcbiAgcmV0dXJuIGVudHJ5ID8gYGJ1biAke2VudHJ5fWAgOiBcIlwiO1xufVxuXG4vLyBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgYGhpbnRgIOKAlCB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoYSA0MDQgb24gYVxuLy8gcmVhZCBuYW1lcyB0aGUgYG9wZW5gIHRoYXQgd291bGQgY3JlYXRlIHRoZSBjaGFubmVsKS5cbi8vXG4vLyDimqAgYGhpbnRgIGlzIGEgVkVSQiBJTlZPQ0FUSU9OLCBub3QgYSBzaGVsbCBjb21tYW5kOiB0aGUgZGFlbW9uIGNhbm5vdCBrbm93XG4vLyBob3cgaXRzIGNsaWVudCB3YXMgaW52b2tlZCwgc28gaXQgbmFtZXMgdGhlIGFjdCBhbmQgd2UgcmVuZGVyIGl0LiBJdCB1c2VkIHRvXG4vLyBhcnJpdmUgYXMgYGdyYXBldmluZSBvcGVuIDxuYW1lPmAgYW5kIGJlIHByaW50ZWQgdmVyYmF0aW0gYWZ0ZXIgYHRyeTpgLCB3aGljaFxuLy8gcmVhZHMgYXMgc29tZXRoaW5nIHRvIHBhc3RlIOKAlCBhbmQgcGFzdGluZyBpdCBnZXRzIGBjb21tYW5kIG5vdCBmb3VuZGAsXG4vLyBiZWNhdXNlIG5vdGhpbmcgaW5zdGFsbHMgYSBgZ3JhcGV2aW5lYCBiaW5hcnkuIFJ1bGluZyAyIGFza2VkIHRoYXQgYSByZWZ1c2FsXG4vLyBuYW1lIHRoZSBuZXh0IGFjdDsgYSByZWNvdmVyeSB0aGF0IGZhaWxzIHdoZW4geW91IHJ1biBpdCBkb2VzIG5vdC5cbmZ1bmN0aW9uIGRpZUFwaShkYXRhOiB7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0gfCBudWxsLCBzdGF0dXM6IG51bWJlcik6IG5ldmVyIHtcbiAgY29uc3QgbXNnID0gZGF0YT8uZXJyb3IgPz8gYEhUVFAgJHtzdGF0dXN9YDtcbiAgY29uc3QgcHJlZml4ID0gaW52b2NhdGlvblByZWZpeCgpO1xuICAvLyDim5QgVEhFIFJFQ09WRVJZIElTIEEgRklFTEQgTk9XLCBOT1QgQSBTRU5URU5DRS4gSXQgdXNlZCB0byBiZSBhcHBlbmRlZCB0byB0aGVcbiAgLy8gbWVzc2FnZSBhcyBg4oCUIHRyeTogPGNtZD5gLCB3aGljaCBhIGNhbGxlciBoYWQgdG8gcmVjb3ZlciBieSBzcGxpdHRpbmcgb25cbiAgLy8gXCJ0cnk6IFwiIChvbmUgb2YgZ3JhcGV2aW5lJ3Mgb3duIGNlbGxzIGRpZCBleGFjdGx5IHRoYXQsIGFuZCByYW4gd2hhdCBpdFxuICAvLyBmb3VuZCkuIGBoaW50YCBpcyB3aGVyZSB0aGUgZW52ZWxvcGUgY2FycmllcyBpdCwgc28gdGhlIHNhbWUgY2VsbCBub3cgcmVhZHNcbiAgLy8gYSBmaWVsZCBhbmQgcnVucyBpdCDigJQgdGhlIHByb3BlcnR5IGlzIHVuY2hhbmdlZCBhbmQgdGhlIHBhcnNlIGlzIG5vdCBhIHBhcnNlLlxuICBjb25zdCBoaW50ID0gZGF0YT8uaGludFxuICAgID8gcHJlZml4XG4gICAgICA/IGB0cnk6ICR7cHJlZml4fSAke2RhdGEuaGludH1gXG4gICAgICA6IGB0cnkgdGhlIFxcYCR7ZGF0YS5oaW50fVxcYCB2ZXJiYFxuICAgIDogdW5kZWZpbmVkO1xuICBkaWUobXNnLCBraW5kRm9yU3RhdHVzKHN0YXR1cyksIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC8vIFRoZSB1cHN0cmVhbSdzIGJvZHkgVkVSQkFUSU0sIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gd2hhdCB0aGUgZGFlbW9uXG4gICAgLy8gYWN0dWFsbHkgc2FpZCByYXRoZXIgdGhhbiBvbiB0aGlzIENMSSdzIHByb3NlIGFib3V0IGl0LlxuICAgIC4uLihkYXRhICE9PSBudWxsID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIEV4aXN0ZW5jZSBwcm9iZSBmb3IgdGhlIHJlYWQgdmVyYnMgdGhhdCBhbnN3ZXIgZnJvbSB0aGUgTE9HIEZJTEUgcmF0aGVyIHRoYW5cbi8vIGZyb20gYSByb3V0ZSAoYHRyaWFnZWAsIGBwdWxsIC0tc3RhdHVzYCkuIFRob3NlIGNhbm5vdCA0MDQgb24gdGhlaXIgb3duOiBhXG4vLyBtaXNzaW5nIGxvZyBpcyBhbiBlbXB0eSBhcnJheSwgd2hpY2ggaXMgdGhlIHNhbWUgc2lsZW50IGxpZSB0aGUgZGFlbW9uIGd1YXJkXG4vLyBleGlzdHMgdG8ga2lsbC4gR0VUIC90b3BpYyBpcyB0aGUgY2hlYXBlc3QgZ3VhcmRlZCByb3V0ZSwgc28gaXQgaXMgdGhlIHByb2JlLlxuYXN5bmMgZnVuY3Rpb24gcmVxdWlyZUNoYW5uZWwocG9ydDogbnVtYmVyLCBuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyB0b3BpYz86IHN0cmluZzsgZnJvbT86IHN0cmluZzsgZnJlc2g/OiBib29sZWFuIH0sXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIG9wZW4gPG5hbWU+IFstLXRvcGljIDx0ZXh0Pl0gWy0tZnJlc2hdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+ID0geyBuYW1lLCBleHBsaWNpdDogdHJ1ZSB9O1xuICBpZiAob3B0cy50b3BpYyAhPT0gdW5kZWZpbmVkKSBib2R5LnRvcGljID0gb3B0cy50b3BpYztcbiAgaWYgKG9wdHMuZnJvbSAhPT0gdW5kZWZpbmVkKSBib2R5LmZyb20gPSBvcHRzLmZyb207XG4gIGlmIChvcHRzLmZyZXNoKSBib2R5LmZyZXNoID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxPcGVuUmVzcG9uc2U+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVG9waWMoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgdGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBmcm9tOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRvcGljIDxjaGFubmVsPiBbPHRleHQ+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBpZiAodGV4dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gYHRvcGljIDxuYW1lPmAgd2l0aCBubyB0ZXh0IGlzIGEgUkVBRCDigJQgaXQgYXNrcyB3aGF0IHRoZSB0b3BpYyBpcywgYW5kIGFcbiAgICAvLyBtaXNzaW5nIGNoYW5uZWwgYW5zd2VycyB0aGF0IHF1ZXN0aW9uIGJ5IGJlaW5nIG1pc3NpbmcuIE5vIGVuc3VyZTogdGhlXG4gICAgLy8gZW5zdXJlIHdhcyB3aGF0IHJlc3VycmVjdGVkIGEgY2xvc2VkIGNoYW5uZWwgZnJvbSBhIHJlYWQgdmVyYi5cbiAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2ApO1xuICAgIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBgdG9waWMgPG5hbWU+IDx0ZXh0PmAgaXMgYSBXUklURSwgc28gaXQgbWF5IGNyZWF0ZSDigJQgYnV0IGl0IG11c3Qgbm90IHdyaXRlXG4gIC8vIHRvIGFuIEFSQ0hJVkVEIGNoYW5uZWwuIFRoZSBQVVQgZW5mb3JjZXMgdGhhdCBpdHNlbGYgbm93OyB0aGlzIGVuc3VyZSBzdGF5c1xuICAvLyBiZWNhdXNlIERJU0NBUkRJTkcgSVRTIFNUQVRVUyBpcyBwcmVjaXNlbHkgdGhlIGJ1ZyBiZWluZyBmaXhlZCBoZXJlLiBCZWZvcmVcbiAgLy8gdG9kYXkgdGhlIDQwOSB0aGF0IGFuc3dlcnMgZm9yIGFuIGFyY2hpdmVkIG5hbWUgd2FzIHRocm93biBhd2F5IGFuZCB0aGUgUFVUXG4gIC8vIHRoYXQgZm9sbG93ZWQgbGFuZGVkOiBgYXJjaGl2ZSB4OyB0b3BpYyB4IFwidFwiYCByZXR1cm5lZCBvazp0cnVlLCBleGl0IDAuXG4gIGNvbnN0IGVuc3VyZSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCB7IG5hbWUgfSk7XG4gIGlmIChlbnN1cmUuc3RhdHVzID49IDQwMCkgZGllQXBpKGVuc3VyZS5kYXRhLCBlbnN1cmUuc3RhdHVzKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIlBVVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLCB7XG4gICAgdG9waWM6IHRleHQsXG4gICAgZnJvbTogZnJvbSA/PyBcInN5c3RlbVwiLFxuICB9KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljLCBpZDogZGF0YT8uaWQgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxDaGFubmVsc1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9jaGFubmVsc1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW47IHZlcmJvc2U/OiBib29sZWFuOyBpblJlcGx5VG8/OiBudW1iZXIgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGluX3JlcGx5X3RvPzogbnVtYmVyIH0gPSB7XG4gICAgZnJvbSxcbiAgICB0ZXh0LFxuICB9O1xuICBpZiAob3B0cy5pblJlcGx5VG8gIT09IHVuZGVmaW5lZCkgYm9keS5pbl9yZXBseV90byA9IG9wdHMuaW5SZXBseVRvO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFNlbmRSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgLy8gVGFyZ2V0IGVjaG8gb24gc3RkZXJyIOKAlCBjb25maXJtcyBXSEVSRSB0aGUgbWVzc2FnZSBsYW5kZWQgc28gYSBtaXNyb3V0ZWRcbiAgLy8gcmVwbHkgKHJpZ2h0IHByb21wdCwgd3JvbmcgY2hhbm5lbCkgaXMgY2F1Z2h0IHRoZSBpbnN0YW50IGl0IGhhcHBlbnMgKEY5KS5cbiAgLy8gT24gc3RkZXJyIHNvIGl0IG5ldmVyIHBvbGx1dGVzIHRoZSBzdGRvdXQgSlNPTiByZWNlaXB0LCBhbmQgaXQgZmlyZXMgZXZlblxuICAvLyB1bmRlciAtLXF1aWV0ICh0aGUgc2FmZXR5IHNpZ25hbCBzaG91bGRuJ3QgYmUgc2lsZW5jZWQpLlxuICBjb25zdCByZWNpcCA9XG4gICAgZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWRcbiAgICAgID8gYCR7ZGF0YS5yZWNpcGllbnRzfSByZWNpcGllbnQocylgXG4gICAgICA6IGAke2RhdGEuc3Vic2NyaWJlcnMgPz8gMH0gc3Vic2NyaWJlcihzKWA7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIOKGkiAke2RhdGEuY2hhbm5lbH0gwrcgJHtyZWNpcH1cXG5gKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgLy8gVGVyc2UgZGVmYXVsdDogaWQgKyBzdWJzY3JpYmVyIGNvdW50ICsgdm9pZCB3YXJuaW5nLiAtLXZlcmJvc2UgYWxzb1xuICAvLyBpbmNsdWRlcyB0aGUgc3Vic2NyaWJlciBhbGlhcyBsaXN0IChzYW1lIGRhdGEgYXMgdGhlIGB3aG9gIHZlcmIsXG4gIC8vIHBpZ2d5YmFja2VkIHRvIGF2b2lkIGFuIGV4dHJhIHJvdW5kLXRyaXAgd2hlbiB0aGUgc2VuZGVyIGNhcmVzKS5cbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBpZDogZGF0YS5pZCxcbiAgICBjaGFubmVsOiBkYXRhLmNoYW5uZWwsXG4gICAgc3Vic2NyaWJlcnM6IGRhdGEuc3Vic2NyaWJlcnMgPz8gMCxcbiAgfTtcbiAgLy8gT25seSBzdXJmYWNlIHJlY2lwaWVudHMgaWYgdGhlIGRhZW1vbiBhY3R1YWxseSBjb21wdXRlZCBpdC4gRGVmYXVsdGluZ1xuICAvLyB0byAwIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIFwicmVhbGx5IDBcIiBhbmQgaGlkIHNpbGVudCBWMS41LWRhZW1vblxuICAvLyBkZWdyYWRhdGlvbiBkdXJpbmcgY3Jvc3MtdmVyc2lvbiBzZXNzaW9uczsgbWlzc2luZy1tZWFucy1taXNzaW5nIGlzIHRoZVxuICAvLyBob25lc3Qgc2lnbmFsLlxuICBpZiAoZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWQpIG91dC5yZWNpcGllbnRzID0gZGF0YS5yZWNpcGllbnRzO1xuICBpZiAoZGF0YS5zdWJzY3JpYmVycyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcImNoYW5uZWwgaGFzIG5vIHN1YnNjcmliZXJzXCI7XG4gIGVsc2UgaWYgKGRhdGEucmVjaXBpZW50cyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm9ubHkgeW91IGFyZSBzdWJzY3JpYmVkXCI7XG4gIGlmIChvcHRzLnZlcmJvc2UpIG91dC5zdWJzY3JpYmVyX2FsaWFzZXMgPSBkYXRhLnN1YnNjcmliZXJfYWxpYXNlcyA/PyBbXTtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFubm91bmNlKFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgY2hhbm5lbHM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7IHF1aWV0PzogYm9vbGVhbiB9LFxuKSB7XG4gIGlmICghZnJvbSB8fCAhdGV4dCkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBhbm5vdW5jZSAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogeyBmcm9tOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgY2hhbm5lbHM/OiBzdHJpbmdbXSB9ID0geyBmcm9tLCB0ZXh0IH07XG4gIGlmIChjaGFubmVscz8ubGVuZ3RoKSBib2R5LmNoYW5uZWxzID0gY2hhbm5lbHM7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8QW5ub3VuY2VSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgXCIvYW5ub3VuY2VcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgYCMgYW5ub3VuY2VkIOKGkiAke2RhdGEuY2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIMK3ICR7ZGF0YS50b3RhbF9yZWNpcGllbnRzfSByZWNpcGllbnQocylcXG5gLFxuICApO1xuICBpZiAob3B0cy5xdWlldCkgcmV0dXJuO1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG9rOiB0cnVlLFxuICAgIGNoYW5uZWxzOiBkYXRhLmNoYW5uZWxzLFxuICAgIHRvdGFsX3JlY2lwaWVudHM6IGRhdGEudG90YWxfcmVjaXBpZW50cyxcbiAgfTtcbiAgaWYgKGRhdGEuc2tpcHBlZD8ubGVuZ3RoKSBvdXQuc2tpcHBlZCA9IGRhdGEuc2tpcHBlZDtcbiAgaWYgKGRhdGEuY2hhbm5lbHMubGVuZ3RoID09PSAwKSBvdXQud2FybmluZyA9IFwibm8gYWN0aXZlIGNoYW5uZWxzIHRvIGFubm91bmNlIHRvXCI7XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQdWxsKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2U6IG51bWJlciwgb3B0czogeyBzdGF0dXM/OiBzdHJpbmcgfSA9IHt9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBwdWxsIDxjaGFubmVsPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcblxuICBpZiAob3B0cy5zdGF0dXMgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFRoaXMgYnJhbmNoIGFuc3dlcnMgZnJvbSB0aGUgbG9nIGZpbGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93bi5cbiAgICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgICAvLyBGdWxsLWNoYW5uZWwgc2NhbjogZmlsdGVyIGJ5IGxhdGVzdCBkaXNwb3NpdGlvbiwgc3RhdHVzIGZyYW1lcyBleGNsdWRlZC5cbiAgICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICAgIGNvbnN0IGZpbHRlcmVkID0gYmFkZ2VkLmZpbHRlcigobSkgPT4ge1xuICAgICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICAgIC8vIGAtLXN0YXR1cyBvcGVuYCBtaXJyb3JzIHRyaWFnZSdzIG9wZW4gYnVja2V0OiBzaWduYWwtb25seSwgc28gbm9uLW1lc3NhZ2VcbiAgICAgIC8vIEZZSXMgKHRvcGljL2Fubm91bmNlbWVudCkgYXJlIGV4Y2x1ZGVkIGZyb20gdGhlIGFjdGlvbmFibGUgcXVldWUuXG4gICAgICByZXR1cm4gb3B0cy5zdGF0dXMgPT09IFwib3BlblwiXG4gICAgICAgID8gbS5raW5kID09PSBcIm1lc3NhZ2VcIiAmJiBpc09wZW4oZGlzcEFyZylcbiAgICAgICAgOiBtLmRpc3Bvc2l0aW9uID09PSBvcHRzLnN0YXR1cztcbiAgICB9KTtcbiAgICBjb25zdCBsYXN0SWQgPSBmaWx0ZXJlZC5hdCgtMSk/LmlkID8/IDA7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBmaWx0ZXJlZCwgY3Vyc29yOiBsYXN0SWQgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU2luY2Utd2luZG93IHBhdGggKHVuY2hhbmdlZCBmcm9tIFRhc2sgMikuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke3NpbmNlfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgcmF3TXNncyA9IGRhdGE/Lm1lc3NhZ2VzID8/IFtdO1xuICBjb25zdCBjdXJzb3IgPSByYXdNc2dzLmF0KC0xKT8uaWQgPz8gc2luY2U7XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBhbm5vdGF0ZWQgPSByYXdNc2dzXG4gICAgLy8gRGlzcG9zaXRpb24gZnJhbWVzIG9ubHkg4oCUIGEgbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgc3RheXMgaW5cbiAgICAvLyB0aGUgaGlzdG9yeSBhbiBhZ2VudCBwdWxsczsgaXQgaXMgaG93IGl0IGxlYXJucyB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZC5cbiAgICAuZmlsdGVyKChtKSA9PiAhaXNEaXNwb3NpdGlvbkZyYW1lKG0pKVxuICAgIC5tYXAoKG0pID0+IHtcbiAgICAgIGNvbnN0IGQgPSBkaXNwLmdldChtLmlkKTtcbiAgICAgIHJldHVybiBkID8geyAuLi5tLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0gOiBtO1xuICAgIH0pO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IGFubm90YXRlZCwgY3Vyc29yIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZWFkKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgaWQ6IG51bWJlciwgb3B0czogeyB0ZXh0PzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGlkKSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZWFkIDxjaGFubmVsPiA8aWQ+IFstLXRleHRdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJ1aWx0IG9uIHRoZSBleGlzdGluZyByYW5nZSBmZXRjaCDigJQgYHNpbmNlPWlkLTFgIHJldHVybnMgaWQgYW5kIGJleW9uZDtcbiAgLy8gd2UgcGljayB0aGUgZXhhY3QgaWQuIE5vIGRhZW1vbiBBUEkgY2hhbmdlLiBUaGlzIGlzIHRoZSB0YXJnZXRlZFxuICAvLyBcImdpdmUgbWUgbWVzc2FnZSBOIGluIGZ1bGxcIiB2ZXJiIHRoYXQgcmVjb3ZlcnMgYSBjbGlwcGVkIHRhaWwgcHJldmlld1xuICAvLyB3aXRob3V0IHRoZSBwdWxsLXJhbmdlICsganEgZGFuY2UuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke2lkIC0gMX1gLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIGNvbnN0IG1zZyA9IChkYXRhPy5tZXNzYWdlcyA/PyBbXSkuZmluZCgobSkgPT4gbS5pZCA9PT0gaWQpO1xuICBpZiAoIW1zZykgZGllKGBtZXNzYWdlICR7aWR9IG5vdCBmb3VuZCBpbiAke25hbWV9YCwgXCJub3RfZm91bmRcIik7XG4gIGNvbnN0IGRpc3BNYXAgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBkID0gZGlzcE1hcC5nZXQoaWQpO1xuICBjb25zdCBhbm5vdGF0ZWRNc2cgPSBkID8geyAuLi5tc2csIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSA6IG1zZztcbiAgaWYgKG9wdHMudGV4dCkge1xuICAgIC8vIFByb3NlIG1vZGU6IGhlYWRlciArIGJvZHksIG5vIEpTT04gZW52ZWxvcGUsIHNvIGEgaHVtYW4gKG9yIGFuIGFnZW50XG4gICAgLy8gcmVjb3ZlcmluZyBhIHRydW5jYXRlZCBub3RpZmljYXRpb24pIGNhbiByZWFkIGl0IGRpcmVjdGx5LlxuICAgIGNvbnN0IHRzID0gbmV3IERhdGUobXNnLnRzKS50b0lTT1N0cmluZygpO1xuICAgIGNvbnN0IGRpc3BQcmVmaXggPSBkXG4gICAgICA/IGQucmVvcGVucyA+IDBcbiAgICAgICAgPyBgWyR7ZC5kaXNwb3NpdGlvbn0g4oa7JHtkLnJlb3BlbnN9XSBgXG4gICAgICAgIDogYFske2QuZGlzcG9zaXRpb259XSBgXG4gICAgICA6IFwiXCI7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7ZGlzcFByZWZpeH1bJHttc2cuaWR9XSAke21zZy5mcm9tfSDCtyAke3RzfVxcbiR7bXNnLnRleHR9XFxuYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlOiBhbm5vdGF0ZWRNc2cgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhaXQoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgc2luY2U6IG51bWJlcixcbiAgdGltZW91dFM6IG51bWJlcixcbiAgYWxpYXM6IHN0cmluZyB8IHVuZGVmaW5lZCxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2FpdCA8Y2hhbm5lbD4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEdpdmUgdGhlIEhUVFAgZmV0Y2ggYSBzbGlnaHRseSBoaWdoZXIgYWJvcnQgdGltZW91dCB0aGFuIHRoZSBkYWVtb24nc1xuICAvLyBsb25nLXBvbGwgdGltZW91dCBzbyB0aGUgZGFlbW9uIGFsd2F5cyB3aW5zIHRoZSB0aW1lb3V0IHJhY2UuXG4gIC8vIGA/YXM9PGFsaWFzPmAgcmVnaXN0ZXJzIHByZXNlbmNlIG9uIHRoZSBjaGFubmVsIGZvciB0aGUgd2FpdCBkdXJhdGlvbiDigJRcbiAgLy8gd2FpdCBpcyBsb25nLXBvbGwgKHB1c2gtc2hhcGVkIHdpdGggYSBkZWFkbGluZSkgc28gaXQgZGVzZXJ2ZXMgcHJlc2VuY2UuXG4gIGNvbnN0IGFzUGFyYW0gPSBhbGlhcyA/IGAmYXM9JHtlbmNvZGVVUklDb21wb25lbnQoYWxpYXMpfWAgOiBcIlwiO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5uZWxzLyR7bmFtZX0vd2FpdD9zaW5jZT0ke3NpbmNlfSZ0aW1lb3V0PSR7dGltZW91dFN9JHthc1BhcmFtfWA7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgodGltZW91dFMgKyA1KSAqIDEwMDApLFxuICB9KTtcbiAgbGV0IGRhdGE6IFdhaXRSZXNwb25zZSB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgV2FpdFJlc3BvbnNlO1xuICB9IGNhdGNoIHt9XG4gIGlmICghcmVzLm9rKSBkaWVBcGkoZGF0YSwgcmVzLnN0YXR1cyk7XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgbWVzc2FnZXM6IGRhdGE/Lm1lc3NhZ2VzID8/IFtdLFxuICAgIGN1cnNvcjogZGF0YT8uY3Vyc29yID8/IHNpbmNlLFxuICAgIHRpbWVkX291dDogISFkYXRhPy50aW1lZF9vdXQsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXaG8obmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB3aG8gPGNoYW5uZWw+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWw6IG5hbWUsIHN1YnNjcmliZXJzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdWJzY3JpYmVyc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3N1YnNjcmliZXJzYCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvQWxsKCkge1xuICAvLyBDcm9zcy1jaGFubmVsIHJvc3RlciDigJQgbmFtZXMgw5cgY2hhbm5lbCBpbiBvbmUgY2FsbCwgc28geW91IGRvbid0IGZhbiBvdXRcbiAgLy8gTiBgd2hvYCBjYWxscyArIGEgbWFudWFsIGpvaW4gdG8gYW5zd2VyIFwid2hvIGlzIG9uIHdoaWNoIHZpbmU/XCIuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyBHZXQgb3Igc2V0IHRoZSBwZXJzaXN0ZWQgZGVmYXVsdCBhbGlhcyAoVjEuNykuIFdpdGggbm8gYXJndW1lbnQsIHByaW50cyB0aGVcbi8vIGN1cnJlbnQgYWxpYXM7IHdpdGggb25lLCB3cml0ZXMgaXQgdG8gY29uZmlnLmpzb24uIFB1cmUgZmlsZSBJL08g4oCUIHdvcmtzXG4vLyB3aXRob3V0IGEgcnVubmluZyBkYWVtb24uIFRoZSB3YXRjaCBzdXJmYWNlIHJlYWRzIGl0IHZpYSBHRVQgL2lkZW50aXR5IHNvIHRoZVxuLy8gaHVtYW4gaGFzIGEgY29uc2lzdGVudCBuYW1lIGFjcm9zcyBldmVyeSBncmFwZXZpbmUuXG5hc3luYyBmdW5jdGlvbiBjbWRBbGlhcyhuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgbGV0IGNmZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgdHJ5IHtcbiAgICBjZmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhDT05GSUdfRklMRSwgXCJ1dGYtOFwiKSk7XG4gIH0gY2F0Y2gge31cbiAgaWYgKG5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFsaWFzID0gdHlwZW9mIGNmZy5hbGlhcyA9PT0gXCJzdHJpbmdcIiAmJiBjZmcuYWxpYXMudHJpbSgpID8gY2ZnLmFsaWFzLnRyaW0oKSA6IG51bGw7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFsaWFzIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB0cmltbWVkID0gbmFtZS50cmltKCk7XG4gIGNmZy5hbGlhcyA9IHRyaW1tZWQ7XG4gIG1rZGlyU3luYyhEQVRBX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoQ09ORklHX0ZJTEUsIGAke0pTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMil9XFxuYCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhczogdHJpbW1lZCB8fCBudWxsIH0pO1xufVxuXG4vKipcbiAqIFRoZSBzdGFuZGluZyB0YWlsIOKAlCBgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgLCBhZG9wdGVkIGF0IFBoYXNlIDYgY2hhcHRlciAyLlxuICpcbiAqIOKblCBXSEFUIFRISVMgUkVQTEFDRUQsIEFORCBXSEFUIElUIEJPVUdIVC4gVGhpcyB2ZXJiIHdhcyAyMjAgbGluZXMgb2ZcbiAqIGhhbmQtd3JpdHRlbiByZWNvbm5lY3QgbG9vcDogdGhyZWUgbmVzdGVkIGxvb3BzIChyZWNvbm5lY3QgLyByZWFkIC8gZnJhbWVcbiAqIGRyYWluKSwgaXRzIG93biBTU0Ugc3BsaXR0ZXIsIGl0cyBvd24gYmFja29mZiwgYW5kIGEgYHByb2Nlc3MuZXhpdCgwKWAgaW4gYVxuICogc2lnbmFsIGhhbmRsZXIgc2V2ZW4gbGluZXMgaW4uIFRoZSBzaGFyZWQgY2xpZW50IGlzIHRoZSBzYW1lIGRlc2lnbiwgb25jZSwgYW5kXG4gKiB0aHJlZSB0aGluZ3MgYXJyaXZlIHdpdGggaXQgdGhhdCBncmFwZXZpbmUgZGlkIG5vdCBoYXZlOlxuICpcbiAqICAgMS4gKipBTiBJRExFIFdBVENIRE9HIOKAlCBncmFwZXZpbmUgaGFkIE5PTkUuKiogYGF3YWl0IHJlYWRlci5yZWFkKClgIHdhc1xuICogICAgICB1bmJvdW5kZWQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhXG4gKiAgICAgIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIEZPUkVWRVIsIGFuZCBhIHBhcmtlZCB0YWlsIGlzXG4gKiAgICAgIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLiBgVEFJTF9JRExFX01TYCBpcyB0aHJlZSBvZiBUSElTXG4gKiAgICAgIHNwZWxsJ3MgMyBzIGJlYXRzIChgLi9oZWFydGJlYXQudHNgKSwgbmV2ZXIgYSBjb3BpZWQgNDUsMDAwLlxuICogICAyLiAqKkEgU1BFQy1DT1JSRUNUIEZSQU1FIFBBUlNFUi4qKiBUaGUgaGFuZC13cml0dGVuIG9uZSBkaWRcbiAqICAgICAgYGxpbmUuc2xpY2UoNSkudHJpbSgpYCwgd2hpY2ggc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIHRoZSBvbmVcbiAqICAgICAgbGVhZGluZyBzcGFjZSB0aGUgc3BlYyByZW1vdmVzIOKAlCBpdCB3b3VsZCBjb3JydXB0IGEgbWVzc2FnZSBib2R5IHdob3NlXG4gKiAgICAgIGZpcnN0IGxpbmUgaXMgaW5kZW50ZWQuIE5vdGhpbmcgaW4gdGhlIHJvc3RlciBlbWl0cyBvbmUgdG9kYXk7IHRoZSBwYXJzZVxuICogICAgICBpcyByaWdodCBhbnl3YXkgbm93LlxuICogICAzLiAqKkEgU0lHTkFMIFBBVEggVEhBVCBEUkFJTlMuKiogVGhlIG9sZCBoYW5kbGVyIHdhc1xuICogICAgICBgc3RvcHBlZCA9IHRydWU7IHByb2Nlc3MuZXhpdCgwKWAg4oCUIHRoZSBQMGYgZGVmZWN0IGV4YWN0bHksIGFwcGxpZWQgdG9cbiAqICAgICAgdGhlIHRlcm1pbmFsIGZyYW1lIGluIGZpdmUgc3BlbGxzIGFuZCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZVxuICogICAgICBsaW5lcyBhYm92ZSBpdC4gQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWRcbiAqICAgICAgc3Rkb3V0LiBUaGUgY2xpZW50IFJFVFVSTlMgYW4gZXhpdCBjb2RlOyBgbWFpbmAgYXNzaWducyBpdCBhbmQgcmV0dXJuc1xuICogICAgICBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMuXG4gKlxuICog4puUIE5PIGBlcG9jaE9mYCAvIGBvbkVwb2NoQ2hhbmdlYCwgQU5EIFRIQVQgSVMgQSBSVUxJTkcsIE5PVCBBTiBPTUlTU0lPTlxuICogKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmUgUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQg4oCUIGBsb2FkQ2hhbm5lbCgpYFxuICogZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBoaWdoLXdhdGVyIG1hcmsgb3ZlciB0aGUgZHVyYWJsZSBgLmpzb25sYCDigJQgc28gYVxuICogcmVjb25uZWN0aW5nIGN1cnNvciBpcyBzdGlsbCB2YWxpZCBhbmQgdGhlIGNvbmRpdGlvbiBhbiBlcG9jaCBkZXRlY3RzIGNhbm5vdFxuICogb2NjdXIgaGVyZS4gV2lyaW5nIG9uZSB3b3VsZCBiZSBhIFJFR1JFU1NJT04gd2l0aCBhIG1lYXN1cmVkIG1lY2hhbmlzbTpcbiAqIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIGBjdXJzb3IgPSAwYCwgYW5kIHRoaXMgZGFlbW9uIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGhcbiAqIGByZWFkQmFja2xvZyhuYW1lLCAwKWAg4oCUIHRoZSB3aG9sZSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhbiBhZ2VudCdzIHBpcGUsXG4gKiBvbiBldmVyeSBgZ3JhcGV2aW5lIHJvbGxgLlxuICpcbiAqIOKaoCBgcmVzb2x2ZWAgQ0FMTFMgYGVuc3VyZURhZW1vbmAsIFdISUNIIENBTiBSQUlTRSDigJQgZGVsaWJlcmF0ZWx5LCBhbmQgdGhlIGtpdFxuICogZG9jdW1lbnRzIHRoZSBwcm9wZXJ0eSB0aGlzIGRlcGVuZHMgb246IGl0cyBvdXRlciBibG9jayBpcyBhIGB0cnlgL2BmaW5hbGx5YFxuICogd2l0aCBOTyBgY2F0Y2hgLCBzbyBhIGBDbGlFcnJvcmAgZnJvbSB0aHJlZSBmcmFtZXMgZG93biBwcm9wYWdhdGVzIGludG9cbiAqIGBtYWluYCBpbnN0ZWFkIG9mIGJlaW5nIHJlYWQgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kIHJldHJpZWQgZm9yZXZlci5cbiAqIENoZWNrZWQgYXQgdGhlIGFkb3B0aW9uIHJhdGhlciB0aGFuIGFzc3VtZWQgKHBsYXlib29rIEI5IHN0ZXAgNSkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgb3B0czoge1xuICAgIHNpbmNlPzogbnVtYmVyO1xuICAgIGZyb21TdGFydD86IGJvb2xlYW47XG4gICAgbGFzdD86IG51bWJlcjtcbiAgICBhcz86IHN0cmluZztcbiAgICBodW1hbj86IGJvb2xlYW47XG4gICAgbHVyaz86IGJvb2xlYW47XG4gICAgbWF4PzogbnVtYmVyO1xuICB9LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFuYW1lKVxuICAgIGRpZShcbiAgICAgIFwidXNhZ2U6IGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXCIsXG4gICAgKTtcbiAgLy8gLS1sdXJrIHJlY2VpdmVzIG1lc3NhZ2VzIGJ1dCByZWdpc3RlcnMgbm8gcHJlc2VuY2Ug4oCUIGFuIGludmlzaWJsZSBvYnNlcnZlci5cbiAgLy8gSXQgb3ZlcnJpZGVzIGlkZW50aXR5IGZsYWdzIChhIGx1cmtlciBoYXMgbm8gbmFtZSB0byBzaG93KS5cbiAgY29uc3QgbXlBbGlhcyA9IG9wdHMubHVyayA/IHVuZGVmaW5lZCA6IG9wdHMuYXM7XG4gIGNvbnN0IHNpbmNlID0gb3B0cy5mcm9tU3RhcnQgPyAwIDogKG9wdHMuc2luY2UgPz8gLTEpO1xuICAvLyBFbWl0IHRoZSBncm91bmRpbmcgbGluZSBvbmx5IG9uIHRoZSBmaXJzdCBzdWJzY3JpYmUsIG5ldmVyIG9uIHJlY29ubmVjdHNcbiAgLy8gKGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSB0aGUgY3Vyc29yIOKAlCB0aGVyZSBpcyBubyB1bnNlZW4gaGlzdG9yeSB0aGVuKS5cbiAgLy8g4puUIEFORCBORVZFUiBPTiBBIGAtLXNpbmNlYCBSRS1BUk0gKGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsIEEzKTogdGhlXG4gIC8vIGFnZW50IGFscmVhZHkga25vd3MgdGhlIGNoYW5uZWwsIGFuZCB0aGUgaGlzdG9yeSBoaW50IHdvdWxkIGJlIG5vaXNlLlxuICBsZXQgZ3JvdW5kZWQgPSBvcHRzLnNpbmNlICE9PSB1bmRlZmluZWQ7XG4gIC8vIOKblCBUSEUgQk9PS01BUksgRk9SIEEgTElWRS1PTkxZIFRBSUwuIGBzaW5jZSA9IC0xYCBhc2tzIGZvciBubyBoaXN0b3J5LCBzbyBhXG4gIC8vIHRhaWwgdGhhdCBzZWVzIG5vIG1lc3NhZ2UgaGFzIG5vIGlkIHRvIGhhbmQgaXRzIHJlLWFybSwgYW5kIHRoZSByZS1hcm1cbiAgLy8gd291bGQgbWlzcyBldmVyeXRoaW5nIHNlbnQgaW4gdGhlIGdhcC4gVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXIgY2FycmllcyB0aGVcbiAgLy8gY2hhbm5lbCdzIGBsYXRlc3RfaWRgOiBzZWVkaW5nIHRoZSBjdXJzb3IgZnJvbSBpdCBtYWtlcyB0aGUgaGFuZG9mZidzXG4gIC8vIGAtLXNpbmNlYCBleGFjdC4gT25seSBmb3IgYSBsaXZlLW9ubHkgc3RhcnQg4oCUIGEgYmFja2ZpbGxpbmcgb25lIChgLS1sYXN0YCxcbiAgLy8gYC0tZnJvbS1zdGFydGAsIGAtLXNpbmNlYCkgaXMgc3RpbGwgcmVhZGluZyBpZHMgYXQgb3IgYmVsb3cgaXQsIGFuZCBhXG4gIC8vIHJlY29ubmVjdCBtaWQtYmFja2ZpbGwgbXVzdCBub3Qgc2tpcCBwYXN0IHRoZW0uXG4gIC8vIE9uY2U6IGEgbGF0ZXIgbWFya2VyIChhIHJlY29ubmVjdCkgbXVzdCBub3QganVtcCB0aGUgY3Vyc29yIHBhc3QgbWVzc2FnZXNcbiAgLy8gaXRzIG93biBiYWNrbG9nIGlzIGFib3V0IHRvIHJlcGxheS5cbiAgbGV0IHNlZWRGcm9tTWFya2VyID0gc2luY2UgPCAwICYmIG9wdHMubGFzdCA9PT0gdW5kZWZpbmVkO1xuXG4gIC8vIOKblCBBIFBSRVNFTkNFIFNQRUxMOiB0aGUgY29ubmVjdGlvbiBJUyBgd2hvYCdzIHByZXNlbmNlLCBzbyB0aGUgd2luZG93XG4gIC8vIGFsd2F5cyBuYW1lcyB0aGUgTW9uaXRvciByZS1hcm0sIG5ldmVyIHRoZSBzdG9wLXN0YXJ0IGAtLW9uY2VgLCBhbmQgYSBsb3N0XG4gIC8vIGRhZW1vbiBpcyByZXRyaWVkIChgcmVzb2x2ZWAgcmVzcGF3bnMgaXQpLCBub3QgcmVwb3J0ZWQuXG4gIGNvbnN0IGFnYWluID0gKGF0OiBudW1iZXIpID0+XG4gICAgY29tbWFuZExpbmUoW1xuICAgICAgLi4uc2VsZkNvbW1hbmQoKSxcbiAgICAgIFwidGFpbFwiLFxuICAgICAgbmFtZSxcbiAgICAgIC4uLihvcHRzLmx1cmsgPyBbXCItLWx1cmtcIl0gOiBteUFsaWFzID8gW1wiLS1hc1wiLCBteUFsaWFzXSA6IFtdKSxcbiAgICAgIC4uLihvcHRzLmh1bWFuICYmICFvcHRzLmx1cmsgPyBbXCItLWh1bWFuXCJdIDogW10pLFxuICAgICAgLi4uKG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBbXCItLW1heFwiLCBTdHJpbmcob3B0cy5tYXgpXSA6IFtdKSxcbiAgICAgIC8vIGAtLXNpbmNlYCB0YWtlcyBubyBuZWdhdGl2ZSBoZXJlOyBhIHRhaWwgdGhhdCBuZXZlciBsZWFybmVkIGFuIGlkXG4gICAgICAvLyByZS1hcm1zIGxpdmUtb25seSwgd2hpY2ggaXMgd2hhdCAtMSBtZWFudC5cbiAgICAgIC4uLihhdCA+PSAwID8gW1wiLS1zaW5jZVwiLCBTdHJpbmcoYXQpXSA6IFtdKSxcbiAgICBdKTtcblxuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPFRhaWxQYXlsb2FkPihcbiAgICB7XG4gICAgICAvLyDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVELiBBIHRhaWwgb3V0bGl2ZXNcbiAgICAgIC8vIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0IOKAlCBgcm9sbGAgYW5kIGByZXN0YXJ0YCBib3RoIHJlcGxhY2UgaXQg4oCUIGFuZFxuICAgICAgLy8gYGVuc3VyZURhZW1vbmAgcmUtcmVhZHMgdGhlIHBvcnQgZmlsZSBhbmQgcmVzcGF3bnMsIHNvIGEgcmVjb25uZWN0IGFmdGVyIGFcbiAgICAgIC8vIHJvbGwgbGFuZHMgb24gdGhlIE5FVyBkYWVtb24gcmF0aGVyIHRoYW4gc3Bpbm5pbmcgYWdhaW5zdCBhIGRlYWQgcG9ydC5cbiAgICAgIHJlc29sdmU6IGFzeW5jICgpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7YXdhaXQgZW5zdXJlRGFlbW9uKCl9YCxcbiAgICAgIHBhdGg6IGAvY2hhbm5lbHMvJHtuYW1lfS90YWlsYCxcbiAgICAgIHNpbmNlLFxuICAgICAgLy8g4pqgIE5PIGVuc3VyZSBjYWxsIGJlZm9yZSB0aGUgc3Vic2NyaWJlLiBBIGZyZXNoIGB0YWlsIG5hbWVgIHN0aWxsIHdvcmtzXG4gICAgICAvLyB3aXRob3V0IGFuIGV4cGxpY2l0IG9wZW4g4oCUIEdFVCDigKYvdGFpbCBjcmVhdGVzIHRoZSBjaGFubmVsIGl0c2VsZiDigJQgYW5kXG4gICAgICAvLyB0aGF0IGlzIHRoZSBPTkxZIHdheSB0aGUgc3Vic2NyaWJlZCBldmVudCdzIGBjcmVhdGVkYCBmbGFnIGNhbiBldmVyIGJlXG4gICAgICAvLyB0cnVlOiBhbiBlbnN1cmUgc2VudCBmaXJzdCBjcmVhdGVzIHRoZSBjaGFubmVsLCBzbyB0aGUgc3Vic2NyaWJlIHRoYXRcbiAgICAgIC8vIGZvbGxvd3MgYWx3YXlzIHJlcG9ydHMgYGNyZWF0ZWQ6ZmFsc2VgIGFuZCB0aGUgbWlzdHlwZWQtbmFtZSBzaWduYWwgbmV2ZXJcbiAgICAgIC8vIGZpcmVzLlxuICAgICAgcXVlcnk6IChjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPT4ge1xuICAgICAgICBjb25zdCBxOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgICAgLy8gIzY4IOKAlCBgLS1sYXN0IE5gIHJpZGVzIHRoZSBGSVJTVCBjb25uZWN0aW9uIG9ubHkuIE9uY2UgYW55IG1lc3NhZ2VcbiAgICAgICAgLy8gbGFuZHMgdGhlIGN1cnNvciBhZHZhbmNlcyBhbmQgYSByZWNvbm5lY3QgcmVzdW1lcyBmcm9tIGl0IHZpYSBgc2luY2VgLFxuICAgICAgICAvLyBuZXZlciByZS1iYWNrZmlsbGluZyB0aGUgd2luZG93LiBgZmlyc3RDb25uZWN0YCBpcyB0aGUga2l0J3MgcGFyYW1ldGVyXG4gICAgICAgIC8vIGZvciBleGFjdGx5IHRoaXM7IHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCBzcGVsbGVkIGl0IGBoaWdoZXN0U2VlbiA8IDBgLFxuICAgICAgICAvLyB3aGljaCB3YXMgdGhlIHNhbWUgdGVzdCBieSBhY2NpZGVudCBvZiB0aGUgc2VudGluZWwuXG4gICAgICAgIGlmIChvcHRzLmxhc3QgIT09IHVuZGVmaW5lZCAmJiBmaXJzdENvbm5lY3QpIHEubGFzdCA9IFN0cmluZyhvcHRzLmxhc3QpO1xuICAgICAgICBpZiAobXlBbGlhcykgcS5hcyA9IG15QWxpYXM7XG4gICAgICAgIGlmIChvcHRzLmh1bWFuICYmICFvcHRzLmx1cmspIHEuaHVtYW4gPSBcIjFcIjtcbiAgICAgICAgaWYgKG9wdHMubHVyaykgcS5sdXJrID0gXCIxXCI7XG4gICAgICAgIHJldHVybiBxO1xuICAgICAgfSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIikgcmV0dXJuIGV2LmlkO1xuICAgICAgICBpZiAoc2VlZEZyb21NYXJrZXIgJiYgdHlwZW9mIGV2LmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIikge1xuICAgICAgICAgIHNlZWRGcm9tTWFya2VyID0gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIGV2LmxhdGVzdF9pZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfSxcbiAgICAgIGFjY2VwdDogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICAvLyBUaGUgc3Vic2NyaWJlZCBtYXJrZXIgaXMgbm90IGEgbWVzc2FnZTsgYHJlbmRlcmAgYW5zd2VycyBpdC5cbiAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHRydWU7XG4gICAgICAgIC8vIERyb3AgRElTUE9TSVRJT04gZnJhbWVzIOKAlCB0aGV5IGFyZSBtZXRhZGF0YSBhYm91dCBhbm90aGVyIG1lc3NhZ2UuIEFcbiAgICAgICAgLy8gbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgcGFzc2VzIHRocm91Z2g6IGFuIGFnZW50IHRhaWxpbmcgYVxuICAgICAgICAvLyBjaGFubmVsIGNvdWxkIG5vdCBwcmV2aW91c2x5IHNlZSBlaXRoZXIgcGFydHkgcmV0aXJlIGl0LCBhbmQgZm91bmQgb3V0XG4gICAgICAgIC8vIHdoZW4gaXRzIG5leHQgc2VuZCB3YXMgcmVqZWN0ZWQuXG4gICAgICAgIGlmIChpc0Rpc3Bvc2l0aW9uRnJhbWUoZXYpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIC8vIFN1cHByZXNzIHNlbGYtZWNobzogd2hlbiAtLWFzIGlzIHNldCwgZHJvcCBtZXNzYWdlcyB3ZSBzZW50IG91cnNlbHZlcy5cbiAgICAgICAgLy8gVGhlIHNlbmRlciBhbHJlYWR5IGdvdCB0aGUgcmVjZWlwdCBhcyB0aGUgUE9TVCByZXNwb25zZSwgc28gcmUtZW1pdHRpbmdcbiAgICAgICAgLy8gaXQgb24gdGFpbCBpcyBwdXJlIG5vaXNlLlxuICAgICAgICBpZiAobXlBbGlhcyAmJiBldi5mcm9tID09PSBteUFsaWFzKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKHBheWxvYWQsIGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiByZW5kZXJTdWJzY3JpYmVkKHBheWxvYWQpO1xuICAgICAgICAvLyAjNjcg4oCUIGZyb250LWxvYWQgYSByZWNvdmVyeSBwb2ludGVyIG9uIEVWRVJZIG1lc3NhZ2UgZnJhbWUsIHNvIHRoZSByZWFkXG4gICAgICAgIC8vIGNvb3JkaW5hdGVzIHN1cnZpdmUgYSBkb3duc3RyZWFtIG5vdGlmaWNhdGlvbiBjbGlwLiBNb25pdG9yIHRydW5jYXRlcyBhdFxuICAgICAgICAvLyBpdHMgT1dOIGNhcCAoYmVsb3cgb3VyIGhpbnQgdGhyZXNob2xkLCBhbmQgb25lIHdlIGNhbm5vdCBvYnNlcnZlIGhlcmUpOyBhXG4gICAgICAgIC8vIG1lc3NhZ2UgaXQgY2xpcHMgd291bGQgb3RoZXJ3aXNlIGxvc2UgaXRzIHRyYWlsaW5nIGBpZGAgYW5kIGJlY29tZVxuICAgICAgICAvLyB1bnJlY292ZXJhYmxlIOKAlCB0aGUgcmVhZGVyIGlzIGxlZnQgaW5mZXJyaW5nIHRoZSBpZC4gRXZlcnkgZnJhbWVcbiAgICAgICAgLy8gdGhlcmVmb3JlIGNhcnJpZXMgYSBGUk9OVC1sb2FkZWQgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLCBlaXRoZXIgYXMgdGhlXG4gICAgICAgIC8vIHJpY2hlciBgdHJ1bmNhdGlvbl9oaW50YCAoZ2VudWluZWx5LWxvbmcgbWVzc2FnZXMg4oCUIHRoZSBcIitOIGNoYXJzLFxuICAgICAgICAvLyB5b3UncmUgZGVmaW5pdGVseSBtaXNzaW5nIGNvbnRlbnRcIiBhbGFybSkgb3IgYXMgdGhlIGNvbXBhY3QgYGZ1bGxgXG4gICAgICAgIC8vIHBvaW50ZXIuIFNlcmlhbGl6aW5nIGl0IGJlZm9yZSB0aGUgbG9uZyBgLnRleHRgIGlzIHdoYXQgbWFrZXMgaXQgc3Vydml2ZVxuICAgICAgICAvLyB0aGUgY2xpcCAoRjE3KS5cbiAgICAgICAgY29uc3QgcmVhZFJlZiA9IGByZWFkICR7bmFtZX0gJHtwYXlsb2FkLmlkfWA7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgcGF5bG9hZC50ZXh0ID09PSBcInN0cmluZ1wiICYmXG4gICAgICAgICAgcGF5bG9hZC50ZXh0Lmxlbmd0aCA+IChvcHRzLm1heCA/PyBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEKVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB0cnVuY2F0aW9uX2hpbnQgPSBgKyR7cGF5bG9hZC50ZXh0Lmxlbmd0aH0gY2hhcnMg4oCUIGZ1bGw6ICR7cmVhZFJlZn1gO1xuICAgICAgICAgIC8vIENhcCB0aGUgSU5MSU5FIGJvZHkgd2hlbiAtLW1heCBpcyBzZXQgKHRoZSBmdWxsIG1lc3NhZ2Ugc3RheXMgb24gZGlza1xuICAgICAgICAgIC8vIOKGkiBgcmVhZGApOyB3aXRob3V0IC0tbWF4LCBlbWl0IHRoZSBmdWxsIHRleHQgKHRvZGF5J3MgZGVmYXVsdCkuXG4gICAgICAgICAgY29uc3QgdGV4dCA9IG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBwYXlsb2FkLnRleHQuc2xpY2UoMCwgb3B0cy5tYXgpIDogcGF5bG9hZC50ZXh0O1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHRydW5jYXRpb25faGludCwgLi4ucGF5bG9hZCwgdGV4dCB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBmdWxsOiByZWFkUmVmLCAuLi5wYXlsb2FkIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIERhZW1vbiBsaXZlbmVzcyBoZWFydGJlYXQgKGA6IGhiIDx0cz5gKS4gU3VyZmFjZSBhIHJlY29nbml6YWJsZSBzZW50aW5lbFxuICAgICAgLy8gb24gc3RkZXJyIHNvIGEgYDI+JjFgIGNvbnN1bWVyIGNhbiB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiAoRjYpLiBLZXB0XG4gICAgICAvLyBvZmYgc3Rkb3V0IOKAlCB0aGUgSlNPTkwgc3RyZWFtIHN0YXlzIHB1cmUuXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiAodGV4dC50cmltU3RhcnQoKS5zdGFydHNXaXRoKFwiaGJcIikgPyBcIjogZ3JhcGV2aW5lLWtlZXBhbGl2ZVwiIDogbnVsbCksXG4gICAgICBvbk1hbGZvcm1lZDogKF9mcmFtZSwgZSkgPT4gYCMgYmFkIHNzZSBkYXRhOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgICAgLy8gVGhlIGZvdXIgbGluZXMgdGhlIGhhbmQtd3JpdHRlbiBsb29wIHdyb3RlLCBwcmVzZXJ2ZWQgdmVyYmF0aW0g4oCUIGEgdGFpbFxuICAgICAgLy8gdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBvbmUgdGhhdCBpcyB3b3JraW5nLlxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBzd2l0Y2ggKGluZm8uY2F1c2UpIHtcbiAgICAgICAgICBjYXNlIFwiY29ubmVjdC1mYWlsZWRcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBjb25uZWN0IGZhaWxlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZXRyeWluZ+KApmA7XG4gICAgICAgICAgY2FzZSBcImh0dHBcIjpcbiAgICAgICAgICBjYXNlIFwibm8tYm9keVwiOlxuICAgICAgICAgICAgcmV0dXJuIGAjIHRhaWwgSFRUUCAke2luZm8uc3RhdHVzfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZXJyb3JcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyBzdHJlYW0gZHJvcHBlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZWNvbm5lY3RpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJzdHJlYW0tZW5kXCI6XG4gICAgICAgICAgICByZXR1cm4gXCIjIHN0cmVhbSBjbG9zZWQsIHJlY29ubmVjdGluZ+KAplwiO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgfSxcbiAgICB7XG4gICAgICBtb2RlOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogdHJ1ZSxcbiAgICAgIC8vIFRoZSBgc3Vic2NyaWJlZGAgbWFya2VyIChhbmQgdGhlIGdyb3VuZGluZyBsaW5lIGl0IHJlbmRlcnMpIGlzIG5vdCBhXG4gICAgICAvLyBtZXNzYWdlIG9uIHRoZSBjaGFubmVsLlxuICAgICAgY291bnRzOiAoX2V2LCBmcmFtZSkgPT4gZnJhbWUuZXZlbnQgIT09IFwic3Vic2NyaWJlZFwiLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2U6IGF0IH0pID0+IGFnYWluKGF0KSxcbiAgICAgICAgY29tZUJhY2s6ICgpID0+IGNvbW1hbmRMaW5lKFsuLi5zZWxmQ29tbWFuZCgpLCBcImRvY3RvclwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG5cbiAgLyoqIFRoZSBgc3Vic2NyaWJlZGAgbWFya2VyOiBzdGRlcnIgY29udGV4dCwgcGx1cyBhIHN0cnVjdHVyZWQgZ3JvdW5kaW5nIGxpbmVcbiAgICogIG9uIHN0ZG91dCB0aGUgRklSU1QgdGltZSBvbmx5LiAqL1xuICBmdW5jdGlvbiByZW5kZXJTdWJzY3JpYmVkKHBheWxvYWQ6IFRhaWxQYXlsb2FkKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgc3Vic2NyaWJlZCB0byAke3BheWxvYWQuY2hhbm5lbH0gKHNpbmNlPSR7cGF5bG9hZC5zaW5jZX0pXFxuYCk7XG4gICAgaWYgKHBheWxvYWQudG9waWMpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHRvcGljOiAke3BheWxvYWQudG9waWN9XFxuYCk7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZClcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBjcmVhdGVkICR7cGF5bG9hZC5jaGFubmVsfSDigJQgdGhpcyB0YWlsIGJyb3VnaHQgaXQgaW50byBiZWluZyAoY2hlY2sgdGhlIG5hbWUpXFxuYCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkXFxuYCxcbiAgICAgICk7XG4gICAgLy8gU3RydWN0dXJlZCBncm91bmRpbmcgb24gc3Rkb3V0IChGMy9GNykg4oCUIHVuZGVyIHRoZSBkZWZhdWx0IFdpcmluZy1CXG4gICAgLy8gTW9uaXRvciwgc3Rkb3V0IHN1cmZhY2VzIGFzIG5vdGlmaWNhdGlvbnMsIHNvIGEgZnJlc2ggc3Vic2NyaWJlciBhY3R1YWxseVxuICAgIC8vIHNlZXMgdGhlIHRvcGljICsgdGhhdCBlYXJsaWVyIGhpc3RvcnkgZXhpc3RzLiBHYXRlZDogb25seSB3aGVuIHRoZXJlJ3NcbiAgICAvLyBzb21ldGhpbmcgdG8gZ3JvdW5kICh1bnNlZW4gaGlzdG9yeSBvciBhIHRvcGljKSwgYW5kIG9ubHkgb24gdGhlIGZpcnN0XG4gICAgLy8gc3Vic2NyaWJlIChub3QgcmVjb25uZWN0cykuXG4gICAgaWYgKGdyb3VuZGVkKSByZXR1cm4gbnVsbDtcbiAgICBncm91bmRlZCA9IHRydWU7XG4gICAgY29uc3QgbGF0ZXN0ID0gdHlwZW9mIHBheWxvYWQubGF0ZXN0X2lkID09PSBcIm51bWJlclwiID8gcGF5bG9hZC5sYXRlc3RfaWQgOiAwO1xuICAgIGNvbnN0IGVhcmxpZXIgPSBzaW5jZSA8IDAgPyBsYXRlc3QgOiBNYXRoLm1heCgwLCBNYXRoLm1pbihzaW5jZSwgbGF0ZXN0KSk7XG4gICAgLy8gYGNyZWF0ZWRgIGFuZCBgYXJjaGl2ZWRgIGpvaW4gdGhlIGdhdGUgb24gcHVycG9zZS4gQSBjaGFubmVsIHRoaXNcbiAgICAvLyBzdWJzY3JpYmUganVzdCBtYWRlIGhhcyBubyB0b3BpYyBhbmQgbm8gaGlzdG9yeSwgc28gdGhlIG9sZCBjb25kaXRpb25cbiAgICAvLyAoYGVhcmxpZXIgPiAwIHx8IHRvcGljYCkgaXMgZXhhY3RseSB0aGUgY2FzZSB0aGF0IGVtaXRzIE5PVEhJTkc7IGFuZCBhblxuICAgIC8vIEFSQ0hJVkVEIGNoYW5uZWwncyBncm91bmRpbmcgbGluZSB3YXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGhlYWx0aHlcbiAgICAvLyBvbmUncywgc28gYSBsYXRlIGpvaW5lciBzdGlsbCBsZWFybmVkIHRoZSBjaGFubmVsIHdhcyByZXRpcmVkIG9ubHkgd2hlblxuICAgIC8vIGl0cyBzZW5kIGJvdW5jZWQuXG4gICAgLy9cbiAgICAvLyDimqAgVGhlIGhpbnRzIEFDQ1VNVUxBVEUgaW50byBhIGxpc3QgcmF0aGVyIHRoYW4gYXNzaWduaW5nIHRvIG9uZSBmaWVsZC5cbiAgICAvLyBUaGV5IHVzZWQgdG8gYmUgdGhyZWUgYXNzaWdubWVudHMgdG8gYGdyb3VuZGluZy5oaW50YCwgb3JkZXJlZCBzbyB0aGUgbW9zdFxuICAgIC8vIGltcG9ydGFudCB3b24g4oCUIHdoaWNoIGlzIGEgaGludCB0aGF0IGNhbiBzaWxlbnRseSBsb3NlIHRvIGFub3RoZXIgaGludCxcbiAgICAvLyB0aGUgZmFpbHVyZSBtb2RlIHRoaXMgd2hvbGUgYnJhbmNoIGlzIGFib3V0LCBzaXR0aW5nIGluIHRoZSBmaXggZm9yIGl0LiBBXG4gICAgLy8gbGlzdCBjYW5ub3Qgb3ZlcndyaXRlOiBhbiBhcmNoaXZlZCBjaGFubmVsIFdJVEggaGlzdG9yeSBub3cgc2F5cyBib3RoLlxuICAgIGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChlYXJsaWVyID4gMClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2VhcmxpZXJ9IGVhcmxpZXIgbWVzc2FnZShzKSBleGlzdCDigJQgdXNlIC0tZnJvbS1zdGFydCBvciAtLXNpbmNlIDxpZD4gdG8gYmFja2ZpbGxgLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYHRoaXMgdGFpbCBjcmVhdGVkICR7cGF5bG9hZC5jaGFubmVsfSDigJQgbm8gc3VjaCBjaGFubmVsIGV4aXN0ZWQ7IGNoZWNrIHRoZSBuYW1lLCBvciBhbm90aGVyIHBhcnR5IGhhcyB5ZXQgdG8gb3BlbiBpdGAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7cGF5bG9hZC5jaGFubmVsfSBpcyBhcmNoaXZlZCDigJQgcmVhZC1vbmx5OyBhIHNlbmQgd2lsbCBiZSByZWplY3RlZCB1bnRpbCBzb21lb25lIHVuYXJjaGl2ZXMgaXRgLFxuICAgICAgKTtcbiAgICBpZiAoIShlYXJsaWVyID4gMCB8fCBwYXlsb2FkLnRvcGljIHx8IHBheWxvYWQuY3JlYXRlZCB8fCBwYXlsb2FkLmFyY2hpdmVkKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgZ3JvdW5kaW5nOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgIGtpbmQ6IFwiZ3JvdW5kaW5nXCIsXG4gICAgICBjaGFubmVsOiBwYXlsb2FkLmNoYW5uZWwsXG4gICAgICBqb2luZWRfYXQ6IHNpbmNlIDwgMCA/IGxhdGVzdCA6IE1hdGgubWluKHNpbmNlLCBsYXRlc3QpLFxuICAgICAgZWFybGllcixcbiAgICB9O1xuICAgIGlmIChwYXlsb2FkLnRvcGljKSBncm91bmRpbmcudG9waWMgPSBwYXlsb2FkLnRvcGljO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpIGdyb3VuZGluZy5jcmVhdGVkID0gdHJ1ZTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZCkgZ3JvdW5kaW5nLmFyY2hpdmVkID0gdHJ1ZTtcbiAgICBpZiAoaGludHMubGVuZ3RoKSBncm91bmRpbmcuaGludCA9IGhpbnRzLmpvaW4oXCIgwrcgXCIpO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShncm91bmRpbmcpO1xuICB9XG59XG5mdW5jdGlvbiBmb2xkRGlzcG9zaXRpb25zKG5hbWU6IHN0cmluZykge1xuICBjb25zdCBtYXAgPSBuZXcgTWFwPFxuICAgIG51bWJlcixcbiAgICB7XG4gICAgICBkaXNwb3NpdGlvbjogc3RyaW5nO1xuICAgICAgZnJvbTogc3RyaW5nO1xuICAgICAgdHM6IG51bWJlcjtcbiAgICAgIG5vdGU6IHN0cmluZztcbiAgICAgIHJlb3BlbnM6IG51bWJlcjtcbiAgICB9XG4gID4oKTtcbiAgY29uc3QgcGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gbWFwO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIikuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgbTogTWVzc2FnZTtcbiAgICB0cnkge1xuICAgICAgbSA9IEpTT04ucGFyc2UobGluZSkgYXMgTWVzc2FnZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobS5raW5kICE9PSBcInN0YXR1c1wiIHx8IHR5cGVvZiBtLnRhcmdldCAhPT0gXCJudW1iZXJcIiB8fCB0eXBlb2YgbS5kaXNwb3NpdGlvbiAhPT0gXCJzdHJpbmdcIilcbiAgICAgIGNvbnRpbnVlO1xuICAgIGNvbnN0IHByZXYgPSBtYXAuZ2V0KG0udGFyZ2V0KTtcbiAgICBjb25zdCByZW9wZW5zID1cbiAgICAgIChwcmV2Py5yZW9wZW5zID8/IDApICtcbiAgICAgIChtLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIiAmJiBwcmV2ICYmIHByZXYuZGlzcG9zaXRpb24gIT09IFwib3BlblwiID8gMSA6IDApO1xuICAgIG1hcC5zZXQobS50YXJnZXQsIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uLFxuICAgICAgZnJvbTogbS5mcm9tLFxuICAgICAgdHM6IG0udHMsXG4gICAgICBub3RlOiBtLnRleHQsXG4gICAgICByZW9wZW5zLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBtYXA7XG59XG4vLyBUV08gdGhpbmdzIG5vdyB3ZWFyIGtpbmQ6XCJzdGF0dXNcIi4gQSBESVNQT1NJVElPTiBmcmFtZSBhY3RzIG9uIGEgc3BlY2lmaWNcbi8vIG1lc3NhZ2UgKGB0YXJnZXRgICsgYGRpc3Bvc2l0aW9uYCkgYW5kIGlzIG1ldGFkYXRhIOKAlCBgcHVsbGAgYW5kIGB0YWlsYCBmb2xkXG4vLyBpdCBhd2F5IGFuZCBiYWRnZSB0aGUgbWVzc2FnZSBpdCBwb2ludHMgYXQgaW5zdGVhZC4gQSBMSUZFQ1lDTEUgZnJhbWVcbi8vIChhcmNoaXZlIC8gdW5hcmNoaXZlKSBpcyBhIGZhY3QgYWJvdXQgdGhlIENIQU5ORUw6IGl0IHRhcmdldHMgbm90aGluZywgYW5kIGl0XG4vLyBpcyB0aGUgd2hvbGUgcG9pbnQgdGhhdCBhIHJlYWRlciBzZWVzIGl0LiBEaXNjcmltaW5hdGluZyBvbiBgZGlzcG9zaXRpb25gXG4vLyByYXRoZXIgdGhhbiBvbiBgZXZlbnRgIGtlZXBzIGEgZnJhbWUgZnJvbSBzb21lIGZ1dHVyZSBlbWl0dGVyIHZpc2libGUgYnlcbi8vIGRlZmF1bHQg4oCUIHRoZSBmYWlsdXJlIG1vZGUgaGVyZSBpcyBzd2FsbG93aW5nIGEgc2lnbmFsLCBub3Qgc2hvd2luZyBvbmUuXG5mdW5jdGlvbiBpc0Rpc3Bvc2l0aW9uRnJhbWUobTogeyBraW5kPzogc3RyaW5nOyBkaXNwb3NpdGlvbj86IHN0cmluZyB9KTogYm9vbGVhbiB7XG4gIHJldHVybiBtLmtpbmQgPT09IFwic3RhdHVzXCIgJiYgdHlwZW9mIG0uZGlzcG9zaXRpb24gPT09IFwic3RyaW5nXCI7XG59XG5cbi8vIFwib3BlblwiID0gbm8gZW50cnksIG9yIGxhdGVzdCBkaXNwb3NpdGlvbiBpcyBcIm9wZW5cIlxuZnVuY3Rpb24gaXNPcGVuKGQ/OiB7IGRpc3Bvc2l0aW9uOiBzdHJpbmcgfSkge1xuICByZXR1cm4gIWQgfHwgZC5kaXNwb3NpdGlvbiA9PT0gXCJvcGVuXCI7XG59XG5cbi8vIFJlYWRzIHRoZSBmdWxsIGNoYW5uZWwgbG9nLCBkcm9wcyBFVkVSWSBraW5kOlwic3RhdHVzXCIgZnJhbWUsIGFuZCBiYWRnZXMgZWFjaFxuLy8gcmVtYWluaW5nIG1lc3NhZ2Ugd2l0aCBpdHMgbGF0ZXN0IGRpc3Bvc2l0aW9uIHZpYSBmb2xkRGlzcG9zaXRpb25zLlxuLy9cbi8vIEV2ZXJ5IG9uZSwgZGVsaWJlcmF0ZWx5IOKAlCBpbmNsdWRpbmcgYSBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSxcbi8vIHdoaWNoIGBwdWxsYCBhbmQgYHRhaWxgIGRvIGxldCB0aHJvdWdoLiBUaGlzIGZlZWRzIGB0cmlhZ2VgLCB3aG9zZSBvcGVuIHF1ZXVlXG4vLyBpcyBcIndoYXQgaXMgbGVmdCB0byBhY3Qgb25cIiwgYW5kIGFuIGFyY2hpdmUgaXMgYW4gRllJLCBub3QgYSB3b3JrIGl0ZW0uIFNhbWVcbi8vIHJlYXNvbiBgdG9waWNgIGFuZCBgYW5ub3VuY2VtZW50YCBhcmUgZm9sZGVkIG91dCBvZiB0aGUgb3BlbiBidWNrZXQgYmVsb3cuXG5mdW5jdGlvbiBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKFxuICBuYW1lOiBzdHJpbmcsXG4pOiAoTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfSlbXSB7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhsb2dQYXRoKSkgcmV0dXJuIFtdO1xuICBjb25zdCBkaXNwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgbWVzc2FnZXM6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgPT09IFwic3RhdHVzXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGQgPSBkaXNwLmdldChtLmlkKTtcbiAgICBpZiAoZCkge1xuICAgICAgbWVzc2FnZXMucHVzaCh7IC4uLm0sIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2gobSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBtZXNzYWdlcztcbn1cblxudHlwZSBCYWRnZWRNZXNzYWdlID0gTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfTtcblxuLy8gRGFzaGJvYXJkIHJlbmRlciBvZiBhIHRyaWFnZSBzY2FuOiB0aGUgb3BlbiBxdWV1ZSBvbiB0b3AsIHRoZW4gZWFjaFxuLy8gZGlzcG9zaXRpb24gZ3JvdXAsIG9uZSBzY2FubmFibGUgbGluZSBwZXIgbWVzc2FnZS4gTWlycm9ycyBgcmVhZCAtLXRleHRgXG4vLyBwcm9zZSBtb2RlIHNvIGEgaHVtYW4gKG9yIGFuIGFnZW50KSByZWFkcyBpdCB3aXRob3V0IHBhcnNpbmcgSlNPTi5cbmZ1bmN0aW9uIHJlbmRlclRyaWFnZUh1bWFuKFxuICBuYW1lOiBzdHJpbmcsXG4gIG9wZW46IEJhZGdlZE1lc3NhZ2VbXSxcbiAgYnlfc3RhdHVzOiBSZWNvcmQ8c3RyaW5nLCBCYWRnZWRNZXNzYWdlW10+LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZSA9IChtOiBCYWRnZWRNZXNzYWdlKSA9PiB7XG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZShtLnRzKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDE2KS5yZXBsYWNlKFwiVFwiLCBcIiBcIik7XG4gICAgY29uc3QgcmVvcGVuID0gbS5yZW9wZW5zICYmIG0ucmVvcGVucyA+IDAgPyBgIOKGuyR7bS5yZW9wZW5zfWAgOiBcIlwiO1xuICAgIC8vIFRoZSBmaXJzdCBsaW5lLCB3aXRob3V0IGFuIGluZGV4IHJlYWQgYHNwbGl0YCB3b3VsZCBtYWtlIHRoZSBjb21waWxlclxuICAgIC8vIGRvdWJ0OiBgc3BsaXRgIG5ldmVyIHJldHVybnMgYW4gZW1wdHkgYXJyYXksIGFuZCB0aGlzIHNheXMgdGhlIHNhbWUgdGhpbmcuXG4gICAgY29uc3QgbmwgPSBtLnRleHQuaW5kZXhPZihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gbmwgPT09IC0xID8gbS50ZXh0IDogbS50ZXh0LnNsaWNlKDAsIG5sKTtcbiAgICBjb25zdCBwcmV2aWV3ID0gaGVhZC5sZW5ndGggPiAxMDAgPyBgJHtoZWFkLnNsaWNlKDAsIDk5KX3igKZgIDogaGVhZDtcbiAgICByZXR1cm4gYCAgWyR7bS5pZH0ke3Jlb3Blbn1dICR7bS5mcm9tfSDCtyAke3RzfSDCtyAke3ByZXZpZXd9YDtcbiAgfTtcbiAgY29uc3Qgc2VjdGlvbnMgPSBbYCR7bmFtZX0gwrcgdHJpYWdlXFxuYCwgYE9QRU4gKCR7b3Blbi5sZW5ndGh9KWBdO1xuICBzZWN0aW9ucy5wdXNoKG9wZW4ubGVuZ3RoID8gb3Blbi5tYXAobGluZSkuam9pbihcIlxcblwiKSA6IFwiICDigJRcIik7XG4gIGZvciAoY29uc3QgW3N0YXR1cywgaXRlbXNdIG9mIE9iamVjdC5lbnRyaWVzKGJ5X3N0YXR1cykpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGBcXG4ke3N0YXR1cy50b1VwcGVyQ2FzZSgpfSAoJHtpdGVtcy5sZW5ndGh9KWAsIGl0ZW1zLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuICByZXR1cm4gYCR7c2VjdGlvbnMuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUcmlhZ2UobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcHRzOiB7IGh1bWFuPzogYm9vbGVhbiB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRyaWFnZSA8Y2hhbm5lbD4gWy0taHVtYW5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIHRyaWFnZSByZWFkcyB0aGUgbG9nIGZpbGUsIG5vdCBhIHJvdXRlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24g4oCUIGFuZFxuICAvLyBhbiBlbXB0eSBkYXNoYm9hcmQgZm9yIGEgY2hhbm5lbCB0aGF0IGRvZXMgbm90IGV4aXN0IGlzIHRoZSBzYW1lIHNpbGVudCBsaWVcbiAgLy8gYXMgYW4gZW1wdHkgYHB1bGxgLlxuICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgY29uc3Qgb3BlbjogQmFkZ2VkTWVzc2FnZVtdID0gW107XG4gIGNvbnN0IGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPiA9IHt9O1xuICBmb3IgKGNvbnN0IG0gb2YgYmFkZ2VkKSB7XG4gICAgLy8gaXNPcGVuIGV4cGVjdHMgYSBkaXNwb3NpdGlvbiBlbnRyeSBvYmplY3QgKG9yIHVuZGVmaW5lZCBmb3Igbm8gZW50cnkpLlxuICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgaWYgKGlzT3BlbihkaXNwQXJnKSkge1xuICAgICAgLy8gVGhlIG9wZW4gcXVldWUgaXMgc2lnbmFsLW9ubHk6IHNraXAgbm9uLWFjdGlvbmFibGUgZnJhbWVzICh0b3BpYy9cbiAgICAgIC8vIGFubm91bmNlbWVudCBGWUlzIGNhbiBuZXZlciBjYXJyeSBhIGRpc3Bvc2l0aW9uLCBzbyB0aGV5J2Qgb3RoZXJ3aXNlXG4gICAgICAvLyBwYWQgXCJ3aGF0J3MgbGVmdD9cIiBmb3JldmVyKS5cbiAgICAgIGlmIChtLmtpbmQgPT09IFwibWVzc2FnZVwiKSBvcGVuLnB1c2gobSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGtleSA9IG0uZGlzcG9zaXRpb24gPz8gXCJ1bmtub3duXCI7XG4gICAgICBpZiAoIWJ5X3N0YXR1c1trZXldKSBieV9zdGF0dXNba2V5XSA9IFtdO1xuICAgICAgYnlfc3RhdHVzW2tleV0ucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgaWYgKG9wdHMuaHVtYW4pIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShyZW5kZXJUcmlhZ2VIdW1hbihuYW1lLCBvcGVuLCBieV9zdGF0dXMpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG9wZW4sIGJ5X3N0YXR1cyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kR3JlcChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBwYXR0ZXJuOiBzdHJpbmcsXG4gIG9wdHM6IHsgbGl0ZXJhbD86IGJvb2xlYW47IGZyb20/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIXBhdHRlcm4pXG4gICAgZGllKFwidXNhZ2U6IGdyYXBldmluZSBncmVwIDxjaGFubmVsPiA8cGF0dGVybj4gWy0tbGl0ZXJhbHwtRl0gWy0tZnJvbSA8YWxpYXM+XVwiKTtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgbGV0IG1hdGNoZXI6ICh0ZXh0OiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGlmIChvcHRzLmxpdGVyYWwpIHtcbiAgICBjb25zdCBuZWVkbGUgPSBwYXR0ZXJuLnRvTG93ZXJDYXNlKCk7XG4gICAgbWF0Y2hlciA9ICh0ZXh0KSA9PiB0ZXh0LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlKTtcbiAgfSBlbHNlIHtcbiAgICBsZXQgcmU6IFJlZ0V4cDtcbiAgICB0cnkge1xuICAgICAgcmUgPSBuZXcgUmVnRXhwKHBhdHRlcm4sIFwiaVwiKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkaWUoYGludmFsaWQgcmVnZXg6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsIFwidXNhZ2VcIik7XG4gICAgfVxuICAgIG1hdGNoZXIgPSAodGV4dCkgPT4gcmUudGVzdCh0ZXh0KTtcbiAgfVxuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgbWVzc2FnZXM6IHVua25vd25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmF3LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lKSBjb250aW51ZTtcbiAgICBsZXQgbXNnOiBQYXJ0aWFsPE1lc3NhZ2U+O1xuICAgIHRyeSB7XG4gICAgICBtc2cgPSBKU09OLnBhcnNlKGxpbmUpIGFzIFBhcnRpYWw8TWVzc2FnZT47XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBtc2cudGV4dCAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgaWYgKG9wdHMuZnJvbSAmJiBtc2cuZnJvbSAhPT0gb3B0cy5mcm9tKSBjb250aW51ZTtcbiAgICBpZiAoIW1hdGNoZXIobXNnLnRleHQpKSBjb250aW51ZTtcbiAgICBtZXNzYWdlcy5wdXNoKG1zZyk7XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGNsb3NlIDxuYW1lPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkgZGllKFwibm8gZGFlbW9uIHJ1bm5pbmdcIiwgXCJub3RfZm91bmRcIik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KHBvcnQsIFwiREVMRVRFXCIsIGAvY2hhbm5lbHMvJHtuYW1lfWApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZXNldChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdHM6IHsgZm9yY2U/OiBib29sZWFuIH0pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHJlc2V0IDxuYW1lPiBbLS1mb3JjZV1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSB7fTtcbiAgaWYgKG9wdHMuZm9yY2UpIGJvZHkuZm9yY2UgPSB0cnVlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IHN1YnNjcmliZXJzPzogbnVtYmVyIH0+KFxuICAgIHBvcnQsXG4gICAgXCJQT1NUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3Jlc2V0YCxcbiAgICBib2R5LFxuICApO1xuICBpZiAoc3RhdHVzID09PSA0MDkgJiYgZGF0YT8uZXJyb3IgPT09IFwibGl2ZVwiKSB7XG4gICAgZGllKFxuICAgICAgYGNoYW5uZWwgaGFzICR7ZGF0YS5zdWJzY3JpYmVyc30gbGl2ZSBzdWJzY3JpYmVyKHMpIOKAlCByZWZ1c2luZyB0byBjbGVhciBhIGxpdmUgc2Vzc2lvbi4gUmUtcnVuIHdpdGggLS1mb3JjZSB0byBjbGVhciBhbnl3YXkgKHRoZSBsb2cgaXMgc25hcHNob3R0ZWQgZmlyc3QpLmAsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyBBcmNoaXZlIChyZWFkLW9ubHkpIG9yIHVuYXJjaGl2ZSBhIGNoYW5uZWwgKFYxLjcpIOKAlCB0aGUgbm9uLWRlc3RydWN0aXZlXG4vLyBhbHRlcm5hdGl2ZSB0byBjbG9zZTogaGlzdG9yeSBpcyBwcmVzZXJ2ZWQsIHNlbmRzIGFyZSByZWplY3RlZCwgYW5kIHRoZSBuYW1lXG4vLyBpcyBsb2NrZWQgZnJvbSByZS1vcGVuIHVudGlsIHVuYXJjaGl2ZWQuXG5hc3luYyBmdW5jdGlvbiBjbWRNYXJrKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkOiBudW1iZXIsXG4gIGRpc3Bvc2l0aW9uOiBzdHJpbmcsXG4gIGZyb206IHN0cmluZyxcbiAgb3B0czogeyBub3RlPzogc3RyaW5nIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFOdW1iZXIuaXNGaW5pdGUoaWQpIHx8ICFkaXNwb3NpdGlvbilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIG1hcmsgPGNoYW5uZWw+IDxpZD4gPGRpc3Bvc2l0aW9uPiBbLS1ub3RlIDx0ZXh0Pl0gWy0tYXMgPGFsaWFzPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IGZyb20sIHRhcmdldDogaWQsIGRpc3Bvc2l0aW9uIH07XG4gIGlmIChvcHRzLm5vdGUgIT09IHVuZGVmaW5lZCkgYm9keS5ub3RlID0gb3B0cy5ub3RlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2U+KHBvcnQsIFwiUE9TVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vc3RhdHVzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSBhcyB7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0gfCBudWxsLCBzdGF0dXMpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFyY2hpdmUobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCB1bmFyY2hpdmU6IGJvb2xlYW4sIGZyb20/OiBzdHJpbmcpIHtcbiAgY29uc3QgdmVyYiA9IHVuYXJjaGl2ZSA/IFwidW5hcmNoaXZlXCIgOiBcImFyY2hpdmVcIjtcbiAgaWYgKCFuYW1lKSBkaWUoYHVzYWdlOiBncmFwZXZpbmUgJHt2ZXJifSA8Y2hhbm5lbD5gKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBCb3RoIHJvdXRlcyBhcHBlbmQgYSBraW5kOlwic3RhdHVzXCIgZnJhbWUgdG8gdGhlIGxvZywgc28gd2hvIGRpZCBpdCBpcyB3b3J0aFxuICAvLyByZWNvcmRpbmcgd2hlbiB0aGUgY2FsbGVyIHRvbGQgdXMuIElkZW50aXR5IGlzIG9wdGlvbmFsIGhlcmUgKGl0IGlzIG9uIHRoZVxuICAvLyBnbG9iYWxseS1hY2NlcHRlZCAtLWFzLy0tZnJvbSksIGFuZCB0aGUgZGFlbW9uIHNpZ25zIFwic3lzdGVtXCIgd2l0aG91dCBpdC5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdGF0dXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIlBPU1RcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vJHt2ZXJifWAsXG4gICAgZnJvbSA/IHsgZnJvbSB9IDogdW5kZWZpbmVkLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdG9wKG9wdHM6IHsgaG9sZFNlY29uZHM/OiBudW1iZXIgfSA9IHt9KSB7XG4gIGxldCBoZWxkVW50aWw6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgaWYgKG9wdHMuaG9sZFNlY29uZHMgJiYgb3B0cy5ob2xkU2Vjb25kcyA+IDApIHtcbiAgICBoZWxkVW50aWwgPSBEYXRlLm5vdygpICsgb3B0cy5ob2xkU2Vjb25kcyAqIDEwMDA7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoSE9MRF9GSUxFLCBTdHJpbmcoaGVsZFVudGlsKSk7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oe1xuICAgICAgb2s6IHRydWUsXG4gICAgICBkYWVtb246IGZhbHNlLFxuICAgICAgLi4uKGhlbGRVbnRpbCAhPT0gdW5kZWZpbmVkID8geyBoZWxkX3VudGlsOiBoZWxkVW50aWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGkocG9ydCwgXCJERUxFVEVcIiwgXCIvXCIpO1xuICB9IGNhdGNoIHt9XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgc3RvcHBlZDogdHJ1ZSxcbiAgICAuLi4oaGVsZFVudGlsICE9PSB1bmRlZmluZWQgPyB7IGhlbGRfdW50aWw6IGhlbGRVbnRpbCB9IDoge30pLFxuICB9KTtcbn1cblxuLy8gUGVyLWNoYW5uZWwgbGl2ZS1jb25uZWN0aW9uIHN1bW1hcnkg4oCUIHRoZSByZXN0YXJ0LXNhZmV0eSByZWFkLiBNaXJyb3JzIHdoYXRcbi8vIGBkb2N0b3JgIHJlcG9ydHMgdW5kZXIgYWN0aXZlX3N1YnNjcmliZXJzOyBvbmx5IHBvcHVsYXRlZCBjaGFubmVscyBhcmUgbGlzdGVkLlxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhcbiAgcG9ydDogbnVtYmVyLFxuKTogUHJvbWlzZTx7IHRvdGFsOiBudW1iZXI7IGNoYW5uZWxzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgY29ubmVjdGlvbnM6IG51bWJlciB9PiB9PiB7XG4gIGxldCB0b3RhbCA9IDA7XG4gIGNvbnN0IGNoYW5uZWxzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgY29ubmVjdGlvbnM6IG51bWJlciB9PiA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICAgIGZvciAoY29uc3QgY2ggb2YgZGF0YT8uY2hhbm5lbHMgPz8gW10pIHtcbiAgICAgIHRvdGFsICs9IGNoLmNvbm5lY3Rpb25zO1xuICAgICAgaWYgKGNoLmNvbm5lY3Rpb25zID4gMCkgY2hhbm5lbHMucHVzaCh7IG5hbWU6IGNoLm5hbWUsIGNvbm5lY3Rpb25zOiBjaC5jb25uZWN0aW9ucyB9KTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGJlc3QtZWZmb3J0IOKAlCBhIHByZXNlbmNlIGhpY2N1cCBzaG91bGRuJ3QgY3Jhc2ggYSBsaWZlY3ljbGUgdmVyYlxuICB9XG4gIHJldHVybiB7IHRvdGFsLCBjaGFubmVscyB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGFydCgpIHtcbiAgLy8gRW5zdXJlLXJ1bm5pbmcsIG5vIGNoYW5uZWwgc2lkZS1lZmZlY3QuIElkZW1wb3RlbnQ6IHJlcG9ydCBhbiBleGlzdGluZ1xuICAvLyBkYWVtb24sIG9yIHNwYXduIGEgZnJlc2ggb25lLiBUaGUgZXhwbGljaXQgXCJicmluZyBpdCB1cFwiIHZlcmIg4oCUIGRpYWdub3N0aWNzXG4gIC8vIChkb2N0b3IvaW5mby9saXN0KSBzdGF5IHJlYWQtb25seSBhbmQgbmV2ZXIgc3Bhd24uXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFleGlzdGluZyAmJiBob2xkQWN0aXZlKCkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgaGVsZDogdHJ1ZSwgcG9ydDogbnVsbCB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcG9ydCA9IGV4aXN0aW5nID8/IChhd2FpdCBlbnN1cmVEYWVtb24oKSk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBwb3J0LCBhbHJlYWR5X3J1bm5pbmc6IGV4aXN0aW5nICE9PSBudWxsIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZXN0YXJ0KG9wdHM6IHsgZm9yY2U/OiBib29sZWFuIH0pIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIC8vIE5vdGhpbmcgdG8gdGVhciBkb3duIOKAlCBqdXN0IGJyaW5nIGEgZnJlc2ggZGFlbW9uIHVwLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJlc3RhcnRlZDogdHJ1ZSwgcG9ydDogZnJlc2gsIHByZXZpb3VzX3BpZDogbnVsbCB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gU0FGRVRZOiBhIHJlc3RhcnQgZm9yY2VzIGV2ZXJ5IGNvbm5lY3RlZCBjbGllbnQgdG8gYXV0by1yZWNvbm5lY3QuIFJlZnVzZSB0b1xuICAvLyB0ZWFyIGRvd24gYSB3b3JraW5nIGZsZWV0IHVubGVzcyBleHBsaWNpdGx5IGZvcmNlZCDigJQgbmV2ZXIgc2lsZW50bHkgZHJvcCBpdC5cbiAgY29uc3QgeyB0b3RhbCwgY2hhbm5lbHMgfSA9IGF3YWl0IGZldGNoQWN0aXZlU3Vic2NyaWJlcnMocG9ydCk7XG4gIGlmICh0b3RhbCA+IDAgJiYgIW9wdHMuZm9yY2UpIHtcbiAgICBjb25zdCB3aGVyZSA9IGNoYW5uZWxzLm1hcCgoYykgPT4gYCR7Yy5uYW1lfSAoJHtjLmNvbm5lY3Rpb25zfSlgKS5qb2luKFwiLCBcIik7XG4gICAgZGllKFxuICAgICAgYHJlc3RhcnQ6ICR7dG90YWx9IGFjdGl2ZSBzdWJzY3JpYmVyKHMpIGFjcm9zcyAke2NoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKSDigJQgJHt3aGVyZX0uIGAgK1xuICAgICAgICBcIkEgcmVzdGFydCB3b3VsZCBmb3JjZSB0aGVtIGFsbCB0byByZWNvbm5lY3QuIFJlLXJ1biB3aXRoIC0tZm9yY2UgKG9yIC0teWVzKSB0byBwcm9jZWVkIGFueXdheS5cIixcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIC8vIENhcHR1cmUgdGhlIHBpZCB3ZSdyZSByZXBsYWNpbmcsIGZvciB0aGUgcmVjZWlwdC5cbiAgbGV0IHByZXZpb3VzUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpO1xuICAgIHByZXZpb3VzUGlkID0gZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RvcCwgdGhlbiB3YWl0IGZvciB0aGUgb2xkIGRhZW1vbiB0byBhY3R1YWxseSBnbyBhd2F5IOKAlCBpdCB1bmxpbmtzIGl0c1xuICAvLyBwb3J0L3BpZCBmaWxlcyBvbiBzaHV0ZG93biwgc28gZW5zdXJlRGFlbW9uIHNwYXducyBmcmVzaCByYXRoZXIgdGhhblxuICAvLyByZS1kaXNjb3ZlcmluZyB0aGUgZHlpbmcgb25lLlxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgaWYgKChhd2FpdCByZWFkRGFlbW9uUG9ydCgpKSA9PT0gbnVsbCkgYnJlYWs7XG4gIH1cbiAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJlc3RhcnRlZDogdHJ1ZSwgcG9ydDogZnJlc2gsIHByZXZpb3VzX3BpZDogcHJldmlvdXNQaWQgfSk7XG59XG5cbi8vIGIzIOKAlCBUSEUgVkVSU0lPTiBWRVJJRlksIEFTIE9ORSBTT1VSQ0UgRk9SIEJPVEggUEFUSFMuXG4vL1xuLy8gYHJvbGxgIGlzIGRvY3VtZW50ZWQgYXMgXCJ0aGUgcmVjb21tZW5kZWQgZGVwbG95IHN0ZXAg4oCmICsgdmVyc2lvbiB2ZXJpZnlcIiwgYW5kXG4vLyB0aGUgdmVyaWZ5IGhhZCB0d28gd2F5cyB0byBzYXkgbm90aGluZzpcbi8vXG4vLyAgIENPTEQgUEFUSCDigJQgbm8gZGFlbW9uIHJ1bm5pbmc6IGl0IHNwYXduZWQgb25lIGFuZCBwcmludGVkIG5laXRoZXIgYHZlcnNpb25gXG4vLyAgIG5vciBgdmVyc2lvbl9va2AuIFRoZSBmaWVsZHMgd2VyZSBBQlNFTlQsIHNvIGEgY2FsbGVyIGNoZWNraW5nIHRoZSB2ZXJpZnlcbi8vICAgZ290IGB1bmRlZmluZWRgIG9uIHRoZSBleGFjdCBwYXRoIHdoZXJlIHRoZSB2ZXJpZnkgbmV2ZXIgaGFwcGVuZWQuXG4vL1xuLy8gICBXQVJNIFBBVEgg4oCUIHRoZSBwcm9iZSB3YXMgd3JhcHBlZCBpbiBgY2F0Y2gge31gLCBsZWF2aW5nIGB2ZXJzaW9uID0gbnVsbGAsXG4vLyAgIGFuZCBgdmVyc2lvbl9vazogbnVsbCA9PT0gUExVR0lOX1ZFUlNJT05gIGV2YWx1YXRlcyB0byBGQUxTRS4gXCJJIGNvdWxkIG5vdFxuLy8gICBjaGVja1wiIHdhcyByZXBvcnRlZCBhcyBcInRoZSB2ZXJzaW9uIGlzIFdST05HXCIg4oCUIGEgYm9vbGVhbiB0aGF0IGNhbm5vdCBzYXlcbi8vICAgXCJ1bmtub3duXCIgaXMgdGhlIGNhbm9uaWNhbCBzaGFwZSBvZiB0aGlzIHNwcmludCdzIGRlZmVjdCwgYW5kIGZhbHNlIGlzIHRoZVxuLy8gICB3b3JzdCBhdmFpbGFibGUgYW5zd2VyIGJlY2F1c2UgaXQgaXMgYWN0aW9uYWJsZSBhbmQgaW5jb3JyZWN0LlxuLy9cbi8vIFNvIGB2ZXJzaW9uX29rYCBpcyBub3cgYGJvb2xlYW4gfCBudWxsYDogbnVsbCBtZWFucyBVTkNIRUNLRUQsIG5ldmVyIGZhbHNlLlxuLy8gYHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbmAgaXMgcHJlc2VudC1hbmQtbnVsbCBiZXNpZGUgaXQsIGJlY2F1c2UgYSBiYXJlIG51bGxcbi8vIHRlbGxzIGEgY2FsbGVyIHRoZSBjaGVjayBkaWQgbm90IGhhcHBlbiBhbmQgbm90IHdoeS5cbi8vXG4vLyBPbmUgaGVscGVyIHJhdGhlciB0aGFuIHR3byBjYWxsIHNpdGVzOiBhIHNlY29uZCBjb3B5IG9mIHRoaXMgbG9naWMgb24gdGhlIGNvbGRcbi8vIHBhdGggaXMgdGhlIG1pcnJvci1kcmlmdCB0cmFwLCBhbmQgdGhlIGNvbGQgcGF0aCBpcyBwcmVjaXNlbHkgdGhlIG9uZSBub2JvZHlcbi8vIHJlLXJlYWRzLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHByb2JlVmVyc2lvbihwb3J0OiBudW1iZXIpOiBQcm9taXNlPHtcbiAgdmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgdmVyc2lvbl9vazogYm9vbGVhbiB8IG51bGw7XG4gIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogc3RyaW5nIHwgbnVsbDtcbn0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB2ID0gKGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy52ZXJzaW9uID8/IG51bGw7XG4gICAgaWYgKHYgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHZlcnNpb246IG51bGwsXG4gICAgICAgIHZlcnNpb25fb2s6IG51bGwsXG4gICAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogXCJ0aGUgZGFlbW9uIGFuc3dlcmVkIGJ1dCByZXBvcnRlZCBubyB2ZXJzaW9uXCIsXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4geyB2ZXJzaW9uOiB2LCB2ZXJzaW9uX29rOiB2ID09PSBQTFVHSU5fVkVSU0lPTiwgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBudWxsIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgIHZlcnNpb25fb2s6IG51bGwsXG4gICAgICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IGBjb3VsZCBub3QgcmVhY2ggdGhlIGRhZW1vbiB0byB2ZXJpZnk6ICR7XG4gICAgICAgIGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSb2xsKG9wdHM6IHsgZm9yY2U/OiBib29sZWFuIH0pIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIC8vIENPTEQgUEFUSCDigJQgbm90aGluZyB3YXMgcnVubmluZywgc28gdGhpcyBpcyBhIHN0YXJ0IHJhdGhlciB0aGFuIGEgcm9sbC5cbiAgICAvLyBJdCBzdGlsbCByZXBvcnRzIHRoZSB2ZXJpZnksIGJlY2F1c2UgXCJubyBkYWVtb24gd2FzIHVwXCIgaXMgbm90IGEgcmVhc29uIHRvXG4gICAgLy8gc3RheSBzaWxlbnQgYWJvdXQgd2hpY2ggdmVyc2lvbiBpcyBub3cgc2VydmluZy5cbiAgICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgIHByaW50SnNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHJvbGxlZDogdHJ1ZSxcbiAgICAgIHByZXZpb3VzX3BpZDogbnVsbCxcbiAgICAgIHBvcnQ6IGZyZXNoLFxuICAgICAgLi4uKGF3YWl0IHByb2JlVmVyc2lvbihmcmVzaCkpLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcm9sbDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykg4oCUICR7d2hlcmV9LiBUaGV5J2xsIGF1dG8tcmVjb25uZWN0IGFjcm9zcyB0aGUgcm9sbC4gUmUtcnVuIHdpdGggLS1mb3JjZSB0byBwcm9jZWVkLmAsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgfVxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIHByZXZpb3VzUGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wIHdpdGggYSBzaG9ydCBob2xkIHNvIGEgc3RhbGUgQ0xJIGNhbid0IHdpbiB0aGUgcmVzcGF3biByYWNlOyB3ZSBob2xkIHRoZSBzcGF3biBvdXJzZWx2ZXMuXG4gIGNvbnN0IGhvbGRNcyA9IDQwMDA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhIT0xEX0ZJTEUsIFN0cmluZyhEYXRlLm5vdygpICsgaG9sZE1zKSk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGkocG9ydCwgXCJERUxFVEVcIiwgXCIvXCIpO1xuICB9IGNhdGNoIHt9XG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIGlmICgoYXdhaXQgcmVhZERhZW1vblBvcnQoKSkgPT09IG51bGwpIGJyZWFrO1xuICB9XG4gIHJlbGVhc2VIb2xkKCk7IC8vIG91ciB0dXJuIHRvIHNwYXduIHRoZSBuZXcgdmVyc2lvblxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBsZXQgcGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBwaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihmcmVzaCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHJvbGxlZDogdHJ1ZSxcbiAgICBwcmV2aW91c19waWQ6IHByZXZpb3VzUGlkLFxuICAgIHBpZCxcbiAgICBwb3J0OiBmcmVzaCxcbiAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXYXRjaChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgLy8gQ2hhbm5lbCBuYW1lIGlzIG9wdGlvbmFsIOKAlCB0aGUgcGFnZSByZWFkcyBpdCBmcm9tIHRoZSBVUkwgaGFzaCBhbmRcbiAgLy8gZGVmYXVsdHMgdG8gXCJsb2JieVwiIGlmIGFic2VudC4gV2UgcGFzcyB0aHJvdWdoIHdoYXRldmVyIHRoZSB1c2VyIGdhdmVcbiAgLy8gKG9yIFwibG9iYnlcIikgYW5kIG9wZW4gdGhlIGJyb3dzZXIuIERhZW1vbiBpcyBlbnN1cmVkIHNvIHRoZSBzZXJ2ZWRcbiAgLy8gL3dhdGNoIEhUTUwgaXMgcmVhY2hhYmxlLlxuICBjb25zdCBjaGFubmVsID0gbmFtZT8udHJpbSgpID8gbmFtZS50cmltKCkgOiBcImxvYmJ5XCI7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gRW5zdXJlIHRoZSBjaGFubmVsIGV4aXN0cyBzbyB0aGUgcGFnZSBzZWVzIGEgdmFsaWQgYmFja2xvZy90b3BpYy5cbiAgYXdhaXQgYXBpKHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCB7IG5hbWU6IGNoYW5uZWwgfSk7XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vd2F0Y2gjJHtlbmNvZGVVUklDb21wb25lbnQoY2hhbm5lbCl9YDtcbiAgLy8gT3BlbiB0aGUgYnJvd3NlciB2aWEgdGhlIHBsYXRmb3JtJ3MgZGVmYXVsdCBvcGVuZXIuIEJlc3QtZWZmb3J0IOKAlFxuICAvLyBwcmludCB0aGUgVVJMIHNvIHRoZSB1c2VyIGNhbiBjbGljayBpdCBpZiBhdXRvLW9wZW4gZmFpbHMuXG4gIGNvbnN0IG9wZW5lciA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJleHBsb3JlclwiIDogXCJ4ZGctb3BlblwiO1xuICB0cnkge1xuICAgIGNvbnN0IHAgPSBzcGF3bihvcGVuZXIsIFt1cmxdLCB7XG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgIH0pO1xuICAgIHAudW5yZWYoKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogb3BlbmVyIG1pc3Npbmcg4oCUIGp1c3QgcHJpbnQgKi9cbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbCwgdXJsIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWREb2N0b3IoKSB7XG4gIC8vIFJlYWQtb25seSBkaWFnbm9zdGljLiBSZXBvcnRzIHRoZSBhdXRob3JpdGF0aXZlIGRhZW1vbiAoaWYgYW55KSwgb3RoZXJcbiAgLy8gZ3JhcGV2aW5lIGRhZW1vbiBwcm9jZXNzZXMgdmlzaWJsZSBvbiB0aGUgbWFjaGluZSwgY2hhbm5lbCBmaWxlcyBvblxuICAvLyBkaXNrLCBhbmQgc3VyZmFjZXMgaGludHMuIERvZXMgTk9UIHRha2UgZGVzdHJ1Y3RpdmUgYWN0aW9uIOKAlCBjbGVhbnVwXG4gIC8vIGlzIHRoZSBvcGVyYXRvcidzIGNhbGwsIHdpdGggc3RvY2sgdW5peCB0b29scy5cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGxldCBhdXRob3JpdGF0aXZlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPSBudWxsO1xuICAvLyBQZXItY2hhbm5lbCBzdWJzY3JpYmVyIHN1bW1hcnkg4oCUIGFuc3dlcnMgXCJpcyBpdCBzYWZlIHRvIHJlc3RhcnQgdGhlXG4gIC8vIGRhZW1vbiByaWdodCBub3c/XCIgd2l0aG91dCBuZWVkaW5nIHRvIGFsc28gcnVuIGBsaXN0YCBhbmQgcmVhZCB0aGVcbiAgLy8gb3V0cHV0LiBFbXB0eSBpZiBubyBkYWVtb24gaXMgcnVubmluZy5cbiAgbGV0IHRvdGFsU3Vic2NyaWJlcnMgPSAwO1xuICBjb25zdCBidXN5Q2hhbm5lbHM6IEFycmF5PHtcbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgc3Vic2NyaWJlcnM6IG51bWJlcjtcbiAgICBjb25uZWN0aW9uczogbnVtYmVyO1xuICAgIG5hbWVkOiBudW1iZXI7XG4gICAgYW5vbnltb3VzOiBudW1iZXI7XG4gIH0+ID0gW107XG4gIGlmIChwb3J0KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgICBhdXRob3JpdGF0aXZlID0geyBwb3J0LCAuLi5kYXRhIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBkYWVtb24gd2VudCBhd2F5IGJldHdlZW4gcG9ydCBjaGVjayBhbmQgYXBpIGNhbGxcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIC8vIC9wcmVzZW5jZSBnaXZlcyB0aGUgaG9uZXN0IHBlci1jaGFubmVsIGJyZWFrZG93biAoY29ubmVjdGlvbnMgdnMgbmFtZWRcbiAgICAgIC8vIHZzIGFub255bW91cykg4oCUIHNvIHRoZSByZXN0YXJ0LXNhZmV0eSB0b3RhbCBpc24ndCBhIG15c3RlcnkgYW5kIGFuXG4gICAgICAvLyBhbm9ueW1vdXMgd2F0Y2ggdGFiIHJlYWRzIGFzIGEgd2F0Y2hlciwgbm90IGEgZ2hvc3QuXG4gICAgICBjb25zdCB7IGRhdGE6IHByZXNEYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgICBmb3IgKGNvbnN0IGNoIG9mIHByZXNEYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgICB0b3RhbFN1YnNjcmliZXJzICs9IGNoLmNvbm5lY3Rpb25zO1xuICAgICAgICBidXN5Q2hhbm5lbHMucHVzaCh7XG4gICAgICAgICAgbmFtZTogY2gubmFtZSxcbiAgICAgICAgICBzdWJzY3JpYmVyczogY2guY29ubmVjdGlvbnMsIC8vIGJhY2stY29tcGF0OiBwcmV2aW91c2x5IHRoZSByYXcgY291bnRcbiAgICAgICAgICBjb25uZWN0aW9uczogY2guY29ubmVjdGlvbnMsXG4gICAgICAgICAgbmFtZWQ6IGNoLm5hbWVkLFxuICAgICAgICAgIGFub255bW91czogY2guYW5vbnltb3VzLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGJlc3QtZWZmb3J0XG4gICAgfVxuICB9XG5cbiAgLy8gRW51bWVyYXRlIG90aGVyIGRhZW1vbiBwcm9jZXNzZXMgdmlhIHRoZSBzaGFyZWQgY2xhc3NpZmllci4gRWFjaCBlbnRyeVxuICAvLyBnYWlucyBwb3J0L2hvbWUvdmVyc2lvbi9zdGF0dXMvcmVhcGFibGUgc28gdGhlIG9wZXJhdG9yIGhhcyB0aGUgZnVsbFxuICAvLyBwaWN0dXJlIHdpdGhvdXQgbmVlZGluZyBhIHNlcGFyYXRlIGByZWFwIC0tZHJ5LXJ1bmAuXG4gIGNvbnN0IG90aGVyRGFlbW9uczogQXJyYXk8QXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBjbGFzc2lmeURhZW1vbj4+ICYgeyBjb21tYW5kPzogc3RyaW5nIH0+ID0gW107XG4gIGNvbnN0IHNlbGZQaWQgPSBhdXRob3JpdGF0aXZlPy5waWQgYXMgbnVtYmVyIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgcGlkIG9mIGF3YWl0IGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCkpIHtcbiAgICAgIGlmIChzZWxmUGlkICYmIHBpZCA9PT0gc2VsZlBpZCkgY29udGludWU7XG4gICAgICBvdGhlckRhZW1vbnMucHVzaChhd2FpdCBjbGFzc2lmeURhZW1vbihwaWQpKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIHBzIHVuYXZhaWxhYmxlOyBjYXJyeSBvbiB3aXRoIGVtcHR5IGxpc3RcbiAgfVxuXG4gIC8vIENoYW5uZWxzIG9uIGRpc2sgdW5kZXIgdGhpcyBIT01FLlxuICBjb25zdCBjaGFubmVsc09uRGlzazogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjaGFubmVsc0RpciA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoY2hhbm5lbHNEaXIpKSB7XG4gICAgICBmb3IgKGNvbnN0IGYgb2YgcmVhZGRpclN5bmMoY2hhbm5lbHNEaXIpKSB7XG4gICAgICAgIGlmIChmLmVuZHNXaXRoKFwiLmpzb25sXCIpKSBjaGFubmVsc09uRGlzay5wdXNoKGYucmVwbGFjZSgvXFwuanNvbmwkLywgXCJcIikpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7fVxuXG4gIC8vIEhpbnRzIOKAlCBzdXJmYWNlIHRoZSBtb3N0IGFjdGlvbmFibGUgc2lnbmFscy5cbiAgY29uc3QgaGludHM6IHN0cmluZ1tdID0gW107XG4gIGlmICghYXV0aG9yaXRhdGl2ZSkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBcIk5vIGF1dGhvcml0YXRpdmUgZGFlbW9uIHJ1bm5pbmcgZm9yIHRoaXMgSE9NRS4gUnVuIGFueSB2ZXJiIChlLmcuIGBjbGkudHMgbGlzdGApIHRvIHNwYXduIG9uZS5cIixcbiAgICApO1xuICB9XG4gIGlmIChvdGhlckRhZW1vbnMubGVuZ3RoID4gMCkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgRm91bmQgJHtvdGhlckRhZW1vbnMubGVuZ3RofSBvdGhlciBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3MoZXMpIG9uIHRoaXMgbWFjaGluZS4gYCArXG4gICAgICAgIFwiVGhleSBtYXkgYmUgem9tYmllcyBmcm9tIHBhc3QgcnVucyBPUiBkYWVtb25zIHNlcnZpbmcgb3RoZXIgSE9NRXMgKGRpZmZlcmVudCBHUkFQRVZJTkVfSE9NRSkuXCIsXG4gICAgKTtcbiAgICBjb25zdCByZWFwYWJsZUNvdW50ID0gb3RoZXJEYWVtb25zLmZpbHRlcigoZCkgPT4gZC5yZWFwYWJsZSkubGVuZ3RoO1xuICAgIGlmIChyZWFwYWJsZUNvdW50ID4gMCkge1xuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYEZvdW5kICR7cmVhcGFibGVDb3VudH0gcmVhcGFibGUgb3JwaGFuIGRhZW1vbihzKS4gUnVuIFxcYGdyYXBldmluZSByZWFwXFxgIHRvIGNsZWFyIHRoZW0gc2FmZWx5LmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3RoZXJEYWVtb25zLnNvbWUoKGQpID0+IGQuc3RhdHVzID09PSBcInVucmVzcG9uc2l2ZVwiKSkge1xuICAgICAgaGludHMucHVzaChcIlNvbWUgZGFlbW9ucyBhcmUgdW5yZXNwb25zaXZlOyBgZ3JhcGV2aW5lIHJlYXAgLS1mb3JjZWAgaW5jbHVkZXMgdGhlbS5cIik7XG4gICAgfVxuICB9XG4gIGlmIChcbiAgICBhdXRob3JpdGF0aXZlICYmXG4gICAgUExVR0lOX1ZFUlNJT04gJiZcbiAgICB0eXBlb2YgYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSBcInN0cmluZ1wiICYmXG4gICAgYXV0aG9yaXRhdGl2ZS52ZXJzaW9uICE9PSBQTFVHSU5fVkVSU0lPTlxuICApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYEF1dGhvcml0YXRpdmUgZGFlbW9uIHZlcnNpb24gKCR7YXV0aG9yaXRhdGl2ZS52ZXJzaW9ufSkgZGlmZmVycyBmcm9tIHRoaXMgQ0xJJ3MgdmVyc2lvbiAoJHtQTFVHSU5fVkVSU0lPTn0pLiBgICtcbiAgICAgICAgXCJSZXN0YXJ0IHRoZSBkYWVtb24gdG8gYWxpZ24g4oCUIGRyb3AgYWN0aXZlIHRhaWxzLCB0aGVuIGBzdG9wYCwgdGhlbiBhbnkgdmVyYi5cIixcbiAgICApO1xuICB9XG4gIGlmIChhdXRob3JpdGF0aXZlICYmIChhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IG51bGwgfHwgYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSB1bmRlZmluZWQpKSB7XG4gICAgaGludHMucHVzaChcIkF1dGhvcml0YXRpdmUgZGFlbW9uIHByZWRhdGVzIHZlcnNpb24gcmVwb3J0aW5nIChwcmUtVjEuNi4yKS4gUmVzdGFydCB0byBhbGlnbi5cIik7XG4gIH1cbiAgaWYgKHRvdGFsU3Vic2NyaWJlcnMgPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGAke3RvdGFsU3Vic2NyaWJlcnN9IGFjdGl2ZSBzdWJzY3JpYmVyKHMpIGFjcm9zcyAke2J1c3lDaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykuIGAgK1xuICAgICAgICBcIkRhZW1vbiByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gdG8gYXV0by1yZWNvbm5lY3QgKHdvcmtzLCBidXQgZGlzcnVwdGl2ZSkg4oCUIGNvb3JkaW5hdGUgZmlyc3QuXCIsXG4gICAgKTtcbiAgfSBlbHNlIGlmIChhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcIk5vIGFjdGl2ZSBzdWJzY3JpYmVycyDigJQgZGFlbW9uIHJlc3RhcnQgaXMgbm9uLWRpc3J1cHRpdmUuXCIpO1xuICB9XG4gIC8vIEV4cGxhaW4gYW55IGNoYW5uZWwgd2hlcmUgdGhlIGNvbm5lY3Rpb24gY291bnQgZXhjZWVkcyBuYW1lZCBhZ2VudHMg4oCUIGFuXG4gIC8vIGFub255bW91cyB3YXRjaCB0YWIgaW5mbGF0ZXMgYGNvdW50YC9gY29ubmVjdGlvbnNgIGJ1dCBpc24ndCBhIGdob3N0LlxuICBmb3IgKGNvbnN0IGNoIG9mIGJ1c3lDaGFubmVscykge1xuICAgIGlmIChjaC5hbm9ueW1vdXMgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtjaC5uYW1lfTogJHtjaC5jb25uZWN0aW9uc30gY29ubmVjdGlvbihzKSwgJHtjaC5uYW1lZH0gbmFtZWQgYWdlbnQocykgKyBgICtcbiAgICAgICAgICBgJHtjaC5hbm9ueW1vdXN9IGFub255bW91cyAoZS5nLiBhIHdhdGNoIHRhYikuIFRoZSBjb3VudCBvdmVyIHRoZSBuYW1lIGxpc3QgaXMgZXhwZWN0ZWQsIG5vdCBhIGdob3N0LmAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgaG9tZTogREFUQV9ESVIsXG4gICAgY2xpX3ZlcnNpb246IFBMVUdJTl9WRVJTSU9OLFxuICAgIGF1dGhvcml0YXRpdmUsXG4gICAgYWN0aXZlX3N1YnNjcmliZXJzOiB7XG4gICAgICB0b3RhbDogdG90YWxTdWJzY3JpYmVycyxcbiAgICAgIGJ1c3lfY2hhbm5lbHM6IGJ1c3lDaGFubmVscyxcbiAgICB9LFxuICAgIG90aGVyX2RhZW1vbnNfb25fbWFjaGluZTogb3RoZXJEYWVtb25zLFxuICAgIGNoYW5uZWxzX29uX2Rpc2s6IGNoYW5uZWxzT25EaXNrLFxuICAgIGhpbnRzLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5mbygpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyDilIDilIAgRGFlbW9uIGVudW1lcmF0aW9uICsgY2xhc3NpZmllciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqIEFsbCBncmFwZXZpbmUgZGFlbW9uLnRzIHBpZHMgdmlzaWJsZSBvbiB0aGlzIG1hY2hpbmUgKHZpYSBgcHNgKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCk6IFByb21pc2U8bnVtYmVyW10+IHtcbiAgY29uc3QgcGlkczogbnVtYmVyW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9jID0gc3Bhd24oXCJwc1wiLCBbXCItZW9cIiwgXCJwaWQsY29tbWFuZFwiXSwge1xuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpZ25vcmVcIl0sXG4gICAgfSk7XG4gICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgIHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGIpID0+IGNodW5rcy5wdXNoKGIgYXMgQnVmZmVyKSk7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHByb2Mub24oXCJleGl0XCIsICgpID0+IHJlc29sdmUoKSkpO1xuICAgIGNvbnN0IG91dCA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0Zi04XCIpO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGlmICghbGluZS5pbmNsdWRlcyhcImRhZW1vbi50c1wiKSkgY29udGludWU7XG4gICAgICBpZiAoIWxpbmUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImdyYXBldmluZVwiKSkgY29udGludWU7XG4gICAgICAvLyBUaGUgcGlkIGdyb3VwIGlzIG1hbmRhdG9yeTsgYW4gdW5tYXRjaGVkIGxpbmUgaXMgc2tpcHBlZCwgYXMgYmVmb3JlLlxuICAgICAgY29uc3QgZGlnaXRzID0gbGluZS5tYXRjaCgvXlxccyooXFxkKylcXHMrLyk/LlsxXTtcbiAgICAgIGlmIChkaWdpdHMgPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgICBjb25zdCBwaWQgPSBwYXJzZUludChkaWdpdHMsIDEwKTtcbiAgICAgIGlmIChwaWQpIHBpZHMucHVzaChwaWQpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IHJldHVybiBlbXB0eVxuICB9XG4gIHJldHVybiBwaWRzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsc29mTGlzdGVuUG9ydChwaWQ6IG51bWJlcik6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcImxzb2ZcIiwgW1wiLWFpVENQXCIsIFwiLXNUQ1A6TElTVEVOXCIsIFwiLXBcIiwgU3RyaW5nKHBpZCksIFwiLVBcIiwgXCItblwiXSwge1xuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpZ25vcmVcIl0sXG4gICAgfSk7XG4gICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgIHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGIpID0+IGNodW5rcy5wdXNoKGIgYXMgQnVmZmVyKSk7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHByb2Mub24oXCJleGl0XCIsICgpID0+IHIoKSkpO1xuICAgIC8vIFRoZSBwb3J0IGdyb3VwIGlzIG1hbmRhdG9yeTsgbm8gbWF0Y2ggaXMgdGhpcyBmdW5jdGlvbidzIG93biBgbnVsbGAuXG4gICAgY29uc3QgZGlnaXRzID0gQnVmZmVyLmNvbmNhdChjaHVua3MpXG4gICAgICAudG9TdHJpbmcoXCJ1dGYtOFwiKVxuICAgICAgLm1hdGNoKC8xMjdcXC4wXFwuMFxcLjE6KFxcZCspLyk/LlsxXTtcbiAgICByZXR1cm4gZGlnaXRzID09PSB1bmRlZmluZWQgPyBudWxsIDogcGFyc2VJbnQoZGlnaXRzLCAxMCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCB0eXBlIERhZW1vblN0YXR1cyA9IFwiYXV0aG9yaXRhdGl2ZVwiIHwgXCJvcnBoYW5cIiB8IFwidW5yZXNwb25zaXZlXCIgfCBcInVua25vd25cIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsYXNzaWZ5RGFlbW9uKHBpZDogbnVtYmVyKTogUHJvbWlzZTx7XG4gIHBpZDogbnVtYmVyO1xuICBwb3J0OiBudW1iZXIgfCBudWxsO1xuICBob21lPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzOiBEYWVtb25TdGF0dXM7XG4gIHJlYXBhYmxlOiBib29sZWFuO1xufT4ge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgbHNvZkxpc3RlblBvcnQocGlkKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4geyBwaWQsIHBvcnQ6IG51bGwsIHN0YXR1czogXCJ1bmtub3duXCIsIHJlYXBhYmxlOiBmYWxzZSB9O1xuICBsZXQgaW5mbzogUm9vdEluZm8gfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg4MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIGluZm8gPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gIH0gY2F0Y2gge31cbiAgaWYgKCFpbmZvKSByZXR1cm4geyBwaWQsIHBvcnQsIHN0YXR1czogXCJ1bnJlc3BvbnNpdmVcIiwgcmVhcGFibGU6IGZhbHNlIH07IC8vIHJlYXAgb25seSB3aXRoIC0tZm9yY2UgKGhhbmRsZWQgaW4gY21kUmVhcClcbiAgY29uc3QgaG9tZSA9IGluZm8uZGF0YV9kaXIgYXMgc3RyaW5nO1xuICBsZXQgb3ducyA9IGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IG9wID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucG9ydFwiKSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgY29uc3Qgb2kgPSByZWFkRmlsZVN5bmMoam9pbihob21lLCBcImRhZW1vbi5waWRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIG93bnMgPSBvcCA9PT0gU3RyaW5nKHBvcnQpICYmIG9pID09PSBTdHJpbmcocGlkKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4gb3duc1xuICAgID8ge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwiYXV0aG9yaXRhdGl2ZVwiLFxuICAgICAgICByZWFwYWJsZTogZmFsc2UsXG4gICAgICB9XG4gICAgOiB7XG4gICAgICAgIHBpZCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgaG9tZSxcbiAgICAgICAgdmVyc2lvbjogaW5mby52ZXJzaW9uID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogXCJvcnBoYW5cIixcbiAgICAgICAgcmVhcGFibGU6IHRydWUsXG4gICAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZWFwKG9wdHM6IHsgZm9yY2U/OiBib29sZWFuOyBkcnlSdW4/OiBib29sZWFuIH0pIHtcbiAgY29uc3Qgc2VsZlBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpOyAvLyBjdXJyZW50IEhPTUUgYXV0aG9yaXRhdGl2ZSAobmV2ZXIgcmVhcClcbiAgbGV0IHNlbGZQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBpZiAoc2VsZlBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZlBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHNlbGZQb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCBwaWRzID0gYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTtcbiAgY29uc3Qga2VwdDogdW5rbm93bltdID0gW10sXG4gICAgcmVhcGVkOiB1bmtub3duW10gPSBbXSxcbiAgICBza2lwcGVkOiB1bmtub3duW10gPSBbXTtcbiAgZm9yIChjb25zdCBwaWQgb2YgcGlkcykge1xuICAgIGNvbnN0IGMgPSBhd2FpdCBjbGFzc2lmeURhZW1vbihwaWQpO1xuICAgIGNvbnN0IGlzU2VsZiA9IHBpZCA9PT0gc2VsZlBpZDtcbiAgICBjb25zdCBzaG91bGRSZWFwID1cbiAgICAgICFpc1NlbGYgJiYgKGMucmVhcGFibGUgfHwgKGMuc3RhdHVzID09PSBcInVucmVzcG9uc2l2ZVwiICYmIG9wdHMuZm9yY2UgPT09IHRydWUpKTtcbiAgICBpZiAoIXNob3VsZFJlYXApIHtcbiAgICAgIGtlcHQucHVzaChjKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAob3B0cy5kcnlSdW4pIHtcbiAgICAgIHNraXBwZWQucHVzaCh7IC4uLmMsIG5vdGU6IFwiZHJ5LXJ1blwiIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmtpbGwocGlkLCBcIlNJR1RFUk1cIik7XG4gICAgICByZWFwZWQucHVzaChjKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHNraXBwZWQucHVzaCh7IC4uLmMsIG5vdGU6IFwia2lsbCBmYWlsZWRcIiB9KTtcbiAgICB9XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRyeV9ydW46ICEhb3B0cy5kcnlSdW4sIGtlcHQsIHJlYXBlZCwgc2tpcHBlZCB9KTtcbn1cblxuLy8gKEJPT0xFQU5fRkxBR1Mgd2FzIGhlcmUuIEl0IGxpc3RlZCB3aGljaCBmbGFncyB0YWtlIG5vIHZhbHVlIOKAlCBoYWxmIGFcbi8vIHJlZ2lzdHJ5LCBjb25zdWx0ZWQgYnkgdGhlIGhhbmQtcm9sbGVkIHBhcnNlci4gSXRzIDEzIGVudHJpZXMgbm93IGxpdmUgaW5cbi8vIENMSV9PUFRJT05TIGJlbG93IGFzIGB7dHlwZTpcImJvb2xlYW5cIn1gLCB2ZXJpZmllZCAxMy1mb3ItMTMgYWdhaW5zdCB0aG90aCdzXG4vLyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3QgYmVmb3JlIHRoZSBtb3ZlLiBEZWxldGVkIHJhdGhlciB0aGFuIGxlZnRcbi8vIGJlc2lkZSBpdHMgcmVwbGFjZW1lbnQ6IGEgc2Vjb25kIHNvdXJjZSBvZiB0cnV0aCBmb3IgdGhlIHNhbWUgZmFjdCBpcyB0aGVcbi8vIGRyaWZ0IGJ1ZyB0aGlzIGxhbmUgZXhpc3RzIHRvIHJlbW92ZSwgYW5kIGl0IHdvdWxkIG5vIGxvbmdlciBiZSBjb25zdWx0ZWRcbi8vIGJ5IGFueXRoaW5nLilcblxuLy8gU2lnbmF0dXJlIG9mIGEgaGVyZWRvYyBmdW1ibGU6IGEgbGluZSB0aGF0IGlzIChvciBiZWdpbnMgd2l0aCkgYVxuLy8gYGJ1biDigKYgY2xpLnRzIOKApiBzZW5kYCBpbnZvY2F0aW9uLiBXaGVuIGEgYHNlbmQgLS1zdGRpbiA8PEVPRmAgaXMgYm90Y2hlZCwgdGhlXG4vLyBzaGVsbCBwaXBlcyB0aGUgbGl0ZXJhbCBjb21tYW5kIGxpbmUgaW4gYXMgdGhlIGJvZHksIHdoaWNoIHRoZW4gZ2V0cyBwb3N0ZWQg4oCUXG4vLyBjb3JydXB0aW5nIHRoZSBjaGFubmVsIHdpdGggYGJ1biAv4oCmL2NsaS50cyBzZW5kIDxjaGFubmVsPiAtLWFzIOKApiA8dGV4dD5gLlxuLy8gV2UgcmVmdXNlIHRvIHBvc3Qgc3VjaCBhIGJvZHkgdW5sZXNzIC0tZm9yY2UgaXMgcGFzc2VkLlxuY29uc3QgTEVBS0VEX1NFTkRfUkUgPSAvKD86XnxcXG4pWyBcXHRdKmJ1blxcYlteXFxuXSpcXGJjbGlcXC50c1xcYlteXFxuXSpcXGIoPzpzZW5kfGFubm91bmNlKVxcYi87XG5mdW5jdGlvbiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gTEVBS0VEX1NFTkRfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gU2hlbGwtbWV0YWNoYXJhY3RlciBmb290Z3VuICgjNjApOiBhIGJvZHkgcGFzc2VkIGFzIGFuIElOTElORSBwb3NpdGlvbmFsIGFyZ1xuLy8gaXMgZXhwb3NlZCB0byB0aGUgY2FsbGVyJ3Mgc2hlbGwsIHdoaWNoIGNvbW1hbmQtc3Vic3RpdHV0ZXMgYmFja3RpY2tzIC9cbi8vIGAkKC4uLilgIC8gYCR7Li4ufWAgQkVGT1JFIGdyYXBldmluZSBzZWVzIGl0IOKAlCBjb3JydXB0aW5nIG9yIHBhcnRpYWxseVxuLy8gZXhlY3V0aW5nIGNvZGUtYmVhcmluZyBtZXNzYWdlcy4gVGhlIENMSSBjYW4ndCB1bi1zdWJzdGl0dXRlIHdoYXQgdGhlIHNoZWxsXG4vLyBhbHJlYWR5IGF0ZTsgdGhlIGhvbmVzdCBmaXggaXMgdG8gc3RlZXIgY2FsbGVycyB0byB0aGUgc2hlbGwtZnJlZSBwYXRoc1xuLy8gKC0tYm9keS1maWxlIC8gLS1zdGRpbiAvIGRlZmF1bHQtc3RkaW4pLiBXaGVuIG1ldGFjaGFyYWN0ZXJzIFNVUlZJVkUgaW50byBhblxuLy8gaW5saW5lIGJvZHkgKGUuZy4gdGhlIGNhbGxlciBoYXBwZW5lZCB0byBzaW5nbGUtcXVvdGUpLCB0aGV5J3JlIGludGFjdCB0aGlzXG4vLyB0aW1lIOKAlCBidXQgdGhlIHBhdHRlcm4gaXMgYSBsYXRlbnQgZm9vdGd1biwgc28gd2Ugd2FybiAobmV2ZXIgYmxvY2s6IHRoZVxuLy8gbWVzc2FnZSBpcyBmaW5lIGFzIHJlY2VpdmVkKS4gQWJzZW50LW1ldGFjaGFyIGlubGluZSBib2RpZXMgYXJlIGVpdGhlciBwbGFpblxuLy8gdGV4dCAoc2FmZSkgb3IgYWxyZWFkeS1zdWJzdGl0dXRlZCAodW5kZXRlY3RhYmxlKSDigJQgc28gd2Ugb25seSB3YXJuIG9uIHRoZVxuLy8gZGV0ZWN0YWJsZSByaXNreSBwYXR0ZXJuLlxuY29uc3QgU0hFTExfTUVUQUNIQVJfUkUgPSAvYHxcXCRcXCh8XFwkXFx7LztcbmV4cG9ydCBmdW5jdGlvbiBsb29rc1NoZWxsUmlza3kodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBTSEVMTF9NRVRBQ0hBUl9SRS50ZXN0KHRleHQpO1xufVxuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gZ3JhcGV2aW5lIGFscmVhZHkgaGFkIEhBTEYgYSByZWdpc3RyeTogYEJPT0xFQU5fRkxBR1NgIGFib3ZlIHRvbGQgdGhlIHBhcnNlclxuLy8gd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZS4gV2hhdCBpdCBoYWQgbm8gbm90aW9uIG9mIHdhcyB3aGljaCBmbGFncyBFWElTVCwgc29cbi8vIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZSBwcm9zZVxuLy8gY29udGFpbmluZyBhIGAtLXdvcmRgIHdhcyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLlxuLy9cbi8vIOKaoCBncmFwZXZpbmUgaXMgdGhlIE9VVExJRVIgb2YgdGhlIHNpeCwgYW5kIGl0IGlzIHdvcnRoIHNheWluZyB3aHkgc28gbm9ib2R5XG4vLyByZWFkcyBpdCBhcyBtZXJlbHkgYmVoaW5kOiBpdCB0eXBlcyBpdHMgdmFsdWUgZmxhZ3Mgd2l0aCBhIENBU1Rcbi8vIChgZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkYCkgd2hlcmUgdGhlIG90aGVyIGVudHJ5IHBvaW50cyB1c2UgYVxuLy8gYHR5cGVvZmAgZ3VhcmQuIEEgY2FzdCBpcyBhIGNsYWltIHdpdGggTk8gUlVOVElNRSBDSEVDSywgc28gZ3JhcGV2aW5lIGNhcnJpZWRcbi8vIGEgY2xhc3Mgb2YgbGF0ZW50IHR5cGUtbGllIHRoZSBvdGhlcnMgd2VyZSBndWFyZGVkIGFnYWluc3Qg4oCUIGFuZCBiYXJlIHZhbHVlXG4vLyBmbGFncyBwcm9kdWNlZCBzaWxlbnQgd3JvbmcgdmFsdWVzIHJhdGhlciB0aGFuIGVycm9yczpcbi8vXG4vLyAgIC0tbGFzdCAgIGJhcmUgIC0+ICBwYXJzZUludCh0cnVlLCAxMCkgIC0+ICBOYU4sIHNpbGVudGx5XG4vLyAgIC0tdG9waWMgIGJhcmUgIC0+ICBgdHJ1ZWAgaW4gYSBmaWVsZCBERUNMQVJFRCBgc3RyaW5nYFxuLy9cbi8vIGBzdHJpY3Q6IHRydWVgIHR1cm5zIGVhY2ggb2YgdGhvc2UgZnJvbSBhIHNpbGVudCB3cm9uZyB2YWx1ZSBpbnRvIGFcbi8vIGNhbGxlci1mYWNpbmcgZXJyb3IsIHdoaWNoIGlzIHRoZSBsYW5lJ3Mgd2hvbGUgcHVycG9zZSBhbmQgdGhlIGxhcmdlc3Rcbi8vIGJlaGF2aW91ciBkZWx0YSBvZiB0aGUgc2l4IGVudHJ5IHBvaW50cy5cbi8vXG4vLyBUaGUgYm9vbGVhbiBzZXQgYmVsb3cgaXMgQk9PTEVBTl9GTEFHUywgdW5jaGFuZ2VkIOKAlCBleHRyYWN0ZWQgZnJvbSB0aGlzIGZpbGVcbi8vIGFuZCBkaWZmZWQgYWdhaW5zdCB0aG90aCdzIGluZGVwZW5kZW50bHktZGVyaXZlZCBhcnRpZmFjdDogMTMgZm9yIDEzLCBleGFjdCxcbi8vIHplcm8gZGl2ZXJnZW5jZSBpbiBlaXRoZXIgZGlyZWN0aW9uLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNoYW5uZWxzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGhvbGQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImluLXJlcGx5LXRvXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYXN0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbWF4OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRvcGljOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwiZHJ5LXJ1blwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGZyZXNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwiZnJvbS1zdGFydFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGh1bWFuOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGxpdGVyYWw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbHVyazogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBxdWlldDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB0ZXh0OiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHZlcmJvc2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgeWVzOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIEEgcGFyc2Utc3RhZ2UgcmVqZWN0aW9uLCBjYXJyeWluZyB0aGUgZW51bWVyYXRpb24gaXQgd2FudHMgdG8gcHVibGlzaC5cbiAqXG4gKiDim5QgVEhFIGBleHRyYWAgSVMgV0hZIFRISVMgQ0xBU1MgU1VSVklWRUQgVEhFIGBlcnJvcnMudHNgIEFET1BUSU9OLiBUaGVcbiAqIHJlamVjdGlvbiBoYXMgdG8gTkFNRSBpdHMgdmFsaWQgc2V0IOKAlCB0aGF0IGlzIHRoZSB3aG9sZSByZWFzb24gZ3JhcGV2aW5lJ3NcbiAqIHBhcnNlciBlcnJvcnMgd2VyZSBzaGFwZWQgdGhlIHdheSB0aGV5IHdlcmUg4oCUIGFuZCB0aGUgdGhyb3cgaGFwcGVucyB0d28gZnJhbWVzXG4gKiBiZWxvdyB0aGUgcGxhY2UgdGhhdCBrbm93cyB0aGUgc2V0LiBgY2hvaWNlc2AgaXMgd2hlcmUgdGhlIGhvdXNlIGVudmVsb3BlXG4gKiBjYXJyaWVzIGFuIGVudW1lcmF0aW9uLCBzbyB0aGUgY2xhc3MgaG9sZHMgaXQgdW50aWwgYHJ1bkNvbW1hbmRgIHJhaXNlcy5cbiAqL1xuY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJVc2FnZUVycm9yXCI7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG59XG5cbnR5cGUgRmxhZ05hbWUgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG5cbi8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgR0xPQkFMOiBTS0lMTC5tZCB0ZWxscyBhZ2VudHMgdG8gcGFzcyAtLWFzLy0tZnJvbVxuLy8gb24gRVZFUlkgdmVyYiAoYSBmcmVzaCBzaGVsbCBwZXIgY29tbWFuZCBtZWFucyBHUkFQRVZJTkVfRlJPTSBuZXZlclxuLy8gcGVyc2lzdHMpLCBzbyBldmVyeSBjb21tYW5kIGFjY2VwdHMgYm90aCDigJQgZXZlbiB3aGVyZSBhIHZlcmIgaGFzIG5vIHVzZSBmb3Jcbi8vIGlkZW50aXR5LCBhIGNhbGxlciBmb2xsb3dpbmcgb3VyIG93biBkb2NzIG11c3Qgbm90IGJlIHJlamVjdGVkIGZvciBvYmV5aW5nXG4vLyB0aGVtLiBPbiBgZ3JlcGAsIGAtLWZyb21gIGlzIGFuIGF1dGhvciBGSUxURVIgcmF0aGVyIHRoYW4gaWRlbnRpdHk6IGRpZmZlcmVudFxuLy8gc2VtYW50aWNzLCBzYW1lIGFjY2VwdGFuY2UuXG5jb25zdCBHTE9CQUxfRkxBR1M6IEZsYWdOYW1lW10gPSBbXCJhc1wiLCBcImZyb21cIl07XG5cbnR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG4vLyBUSEUgQ09NTUFORCBUQUJMRSwgQVMgQSBTVFJVQ1RVUkUg4oCUIHRoZSBwYXJzZXIsIHRoZSBkaXNwYXRjaGVyLCB0aGUgc2NoZW1hXG4vLyBlbWl0dGVyIGFuZCB0aGUgcm9vdCByZWplY3Rpb24gYWxsIHdhbGsgVEhJUy4gSXQgcmVwbGFjZWQgYSBiYXJlIGBzd2l0Y2hgLFxuLy8gd2hpY2ggb25seSB0aGUgZGlzcGF0Y2hlciBjb3VsZCB3YWxrOiBhIHNjaGVtYSBlbWl0dGVkIGZyb20gYW55dGhpbmcgb3RoZXJcbi8vIHRoYW4gdGhlIHN0cnVjdHVyZSB0aGF0IHJvdXRlcyB0aGUgYmVoYXZpb3VyIGlzIGEgZG9jdW1lbnQgdGhhdCBsaWVzIGFzIHNvb25cbi8vIGFzIGFueW9uZSBlZGl0cyB0aGUgb3RoZXIgc2lkZSAoYWNjIFNUQU5EQVJELm1kIFBhcnQgMSDCpzI7IG91ciBvd24gIzgxL0Q0XG4vLyBsYW5lIGxlYXJuZWQgdGhlIHNhbWUgbGVzc29uIG9uZSBhbHRpdHVkZSBkb3duIHdpdGggQk9PTEVBTl9GTEFHUykuXG4vL1xuLy8gYGZsYWdzYCBpcyB0aGUgdmVyYidzIE9XTiBhY2NlcHRlZCBzZXQgKEdMT0JBTF9GTEFHUyBhcmUgbWVyZ2VkIGluIGJ5XG4vLyBgYWNjZXB0ZWRGbGFnc2ApLiBBIGZsYWcgbm90IGxpc3RlZCBoZXJlIGlzIFJFSkVDVEVEIGZvciB0aGlzIHZlcmIgd2l0aCB0aGVcbi8vIHZlcmIncyBvd24gc2V0IGVudW1lcmF0ZWQg4oCUIGFjY2VwdGVkLWFuZC1pZ25vcmVkIGlzIHRoZSBkaXNlYXNlIHRoaXMgdGFibGVcbi8vIGV4aXN0cyB0byBjdXJlIChhY2MgRFQtMTogYW50aGlsbCBhY2NlcHRpbmcgYSByb290IGAtLWZvcm1hdGAgaXQgc2lsZW50bHlcbi8vIGRpc2NhcmRzOyBncmFwZXZpbmUgYWNjZXB0aW5nIGBzZW5kIC0tZHJ5LXJ1bmAgYW5kIGRvaW5nIG5vdGhpbmcgd2FzIHRoZVxuLy8gc2FtZSBldmVudCB3aXRoIGEgZGlmZmVyZW50IHNwZWxsaW5nKS5cbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlcz86IHN0cmluZ1tdO1xuICBmbGFnczogRmxhZ05hbWVbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIC8qKlxuICAgKiDimqAgTUFZIFJFVFVSTiBBTiBFWElUIENPREUsIEFORCBFWEFDVExZIE9ORSBWRVJCIERPRVMuIGB0YWlsYCBydW5zIHRoZSBzaGFyZWRcbiAgICogY2xpZW50IChgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgKSwgd2hpY2ggUkVUVVJOUyBhIGNvZGUgcmF0aGVyIHRoYW5cbiAgICogZW5kaW5nIHRoZSBwcm9jZXNzIGZyb20gaW5zaWRlIHRocmVlIG5lc3RlZCBsb29wcyDigJQgc28gdGhlIGNvZGUgaGFzIHRvIHJlYWNoXG4gICAqIGBtYWluYCwgYW5kIHRoaXMgaXMgdGhlIHNlYW0gaXQgY3Jvc3Nlcy4gQW55dGhpbmcgdGhhdCBpcyBub3QgYSBudW1iZXIgbWVhbnNcbiAgICogMCwgd2hpY2ggaXMgd2hhdCB0aGUgb3RoZXIgdHdlbnR5LW9kZCB2ZXJicyByZXR1cm4uXG4gICAqXG4gICAqIOKaoCBUeXBlZCBgdW5rbm93bmAgcmF0aGVyIHRoYW4gYSB1bmlvbiB3aXRoIGB2b2lkYDogYSB1bmlvbiBpcyB3aGF0IGEgcmVhZGVyXG4gICAqIHdvdWxkIHdyaXRlIGZpcnN0LCBhbmQgZXZlcnkgYGFzeW5jYCB2ZXJiIHRoYXQgZW5kcyB3aXRob3V0IGEgYHJldHVybmAgaXNcbiAgICogYFByb21pc2U8dm9pZD5gLCB3aGljaCBpcyBOT1QgYXNzaWduYWJsZSB0byBgUHJvbWlzZTxudW1iZXIgfCB1bmRlZmluZWQ+YC5cbiAgICogVGhlIHdpZGVuaW5nIGhhcHBlbnMgYXQgdGhlIG9uZSBwbGFjZSB0aGF0IHJlYWRzIHRoZSB2YWx1ZSwgYmVsb3cuXG4gICAqL1xuICBydW46IChwb3NpdGlvbmFsOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzKSA9PiB1bmtub3duO1xufTtcblxuLy8gQSBkZWNsYXJlZCB2YWx1ZSBmbGFnIHRoYXQgY2FycmllcyBhIG51bWJlciBtdXN0IFJFSkVDVCBhIG5vbi1udW1iZXIgYXMgYVxuLy8gdXNhZ2UgZXJyb3IgKGV4aXQgMiksIG5vdCBjcmFzaCBvbiBpdCBkb3duc3RyZWFtIOKAlCBgc2NoZW1hYCBwdWJsaXNoZXMgdGhlXG4vLyBmbGFnIGFzIHZhbGlkLCBzbyB0aGUgcGFyc2UgYm91bmRhcnkgaXMgd2hlcmUgYSBiYWQgdmFsdWUgZ2V0cyBpdHNcbi8vIGNhbGxlci1mYWNpbmcgYW5zd2VyLiAoYHdhaXQgLS10aW1lb3V0IG5vdGFudW1iZXJgIHVzZWQgdG8gdGhyb3cgYW5cbi8vIHVuaGFuZGxlZCBSYW5nZUVycm9yIGF0IGV4aXQgMSwgc3RhY2sgdHJhY2UgYW5kIGFsbC4pXG5mdW5jdGlvbiBudW1lcmljRmxhZyh2ZXJiOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmF3OiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8IDApXG4gICAgZGllKGAke3ZlcmJ9OiAtLSR7bmFtZX0gZXhwZWN0cyBhIG5vbi1uZWdhdGl2ZSBudW1iZXIsIGdvdCAke0pTT04uc3RyaW5naWZ5KFN0cmluZyhyYXcpKX1gKTtcbiAgcmV0dXJuIG47XG59XG5cbi8vIEJvZHkgcmVzb2x1dGlvbiBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZSDigJQgZmlyc3QgbWF0Y2ggd2luczogLS1ib2R5LWZpbGUsXG4vLyAtLXN0ZGluLCBpbmxpbmUgcG9zaXRpb25hbHMsIGRlZmF1bHQtc3RkaW4gd2hlbiBwaXBlZC4gU2VlIHRoZSBwZXItdmVyYlxuLy8gY29tbWVudHMgYXQgdGhlIG9yaWdpbmFsIHNpdGVzIChWMS42LyM2MCk7IGJlaGF2aW91ciB1bmNoYW5nZWQuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQm9keShcbiAgdmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsXG4gIGlubGluZTogc3RyaW5nW10sXG4gIGZsYWdzOiBGbGFncyxcbik6IFByb21pc2U8eyB0ZXh0OiBzdHJpbmc7IGZyb21JbmxpbmU6IGJvb2xlYW4gfT4ge1xuICBpZiAoZmxhZ3NbXCJib2R5LWZpbGVcIl0pIHtcbiAgICBjb25zdCBwYXRoID0gZmxhZ3NbXCJib2R5LWZpbGVcIl0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICByZXR1cm4geyB0ZXh0OiAoYXdhaXQgZmlsZS50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSwgZnJvbUlubGluZTogZmFsc2UgfTtcbiAgfVxuICBpZiAoZmxhZ3Muc3RkaW4gfHwgKGlubGluZS5sZW5ndGggPT09IDAgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpKSB7XG4gICAgY29uc3QgYnVmOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcHJvY2Vzcy5zdGRpbikgYnVmLnB1c2goY2h1bmsgYXMgQnVmZmVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGV4dDogQnVmZmVyLmNvbmNhdChidWYpLnRvU3RyaW5nKFwidXRmLThcIikucmVwbGFjZSgvXFxuJC8sIFwiXCIpLFxuICAgICAgZnJvbUlubGluZTogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyB0ZXh0OiBpbmxpbmUuam9pbihcIiBcIiksIGZyb21JbmxpbmU6IHRydWUgfTtcbn1cblxuLy8gVGhlIHR3byBib2R5IGd1YXJkcyBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZTogcmVmdXNlIGEgbGVha2VkIGludm9jYXRpb25cbi8vIChmdW1ibGVkIGhlcmVkb2MpIHVubGVzcyAtLWZvcmNlLCBhbmQgd2FybiBvbiBzaGVsbCBtZXRhY2hhcmFjdGVycyB0aGF0XG4vLyBzdXJ2aXZlZCBhbiBpbmxpbmUgYm9keSAoIzYwIOKAlCB3YXJuLCBuZXZlciBibG9jaykuXG5mdW5jdGlvbiBndWFyZEJvZHkodmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsIHRleHQ6IHN0cmluZywgZnJvbUlubGluZTogYm9vbGVhbiwgZm9yY2U6IGJvb2xlYW4pIHtcbiAgaWYgKCFmb3JjZSAmJiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQpKSB7XG4gICAgZGllKFxuICAgICAgYCR7dmVyYn06IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGdyYXBldmluZSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgYCArXG4gICAgICAgIFwiaGVyZWRvYz8pLiBOb3RoaW5nIHdhcyBzZW50LiBQaXBlIHRoZSByZWFsIGJvZHkgdmlhIC0tc3RkaW4gb3IgXCIgK1xuICAgICAgICBcIi0tYm9keS1maWxlIDxwYXRoPiwgb3IgcGFzcyAtLWZvcmNlIHRvIHNlbmQgaXQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZyb21JbmxpbmUgJiYgbG9va3NTaGVsbFJpc2t5KHRleHQpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBcIiMg4pqgIGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgYmVmb3JlIFwiICtcbiAgICAgICAgXCJncmFwZXZpbmUgc2VlcyB0aGVtIOKAlCB1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiDim5QgUkVHSVNURVIgQTEg4oCUIGBjaG9pY2VzYCBJUyBgR0xPQkFMX0ZMQUdTYCwgVEhFIFNFVCBgcmVzb2x2ZUFsaWFzYCBSRUFEUy5cbiAqIFRoaXMgaXMgYSBESVNKVU5DVElPTiAoZWl0aGVyIGZsYWcgc2F0aXNmaWVzIGl0KSwgc28gdGhlIGNhbGxlciBoYXMgdG8gcGljayxcbiAqIGFuZCBpdCBpcyB0aGUgb25lIGlkZW50aXR5IHJlZnVzYWwgZm91ciB2ZXJicyBzaGFyZS4gVGhlIGVudiB2YXIgc3RheXMgaW5cbiAqIGBoaW50YCBhbmQgZGVsaWJlcmF0ZWx5IE5PVCBpbiBgY2hvaWNlc2A6IGBjaG9pY2VzYCBlbnVtZXJhdGVzIENPTU1BTkRcbiAqIFRPS0VOUyDigJQgd2hhdCB3b3VsZCBoYXZlIGJlZW4gYWNjZXB0ZWQgSU4gVEhFIElOVk9DQVRJT04g4oCUIGFuZCBwdXR0aW5nIGFuXG4gKiBlbnZpcm9ubWVudCBuYW1lIGluIHRoZSBzYW1lIGFycmF5IHdvdWxkIGdpdmUgYSBjYWxsZXIgYSBcImNob2ljZVwiIGl0IGNhbm5vdFxuICogcGFzcyBvbiB0aGUgY29tbWFuZCBsaW5lLlxuICovXG5jb25zdCBpZGVudGl0eVJlcXVpcmVkID0gKHZlcmI6IHN0cmluZyk6IG5ldmVyID0+XG4gIGRpZShgJHt2ZXJifTogaWRlbnRpdHkgcmVxdWlyZWRgLCBcInVzYWdlXCIsIHtcbiAgICBoaW50OiBgcGFzcyAke0dMT0JBTF9GTEFHUy5tYXAoKGYpID0+IGAtLSR7Zn1gKS5qb2luKFwiL1wiKX0gPGFsaWFzPiwgb3Igc2V0IEdSQVBFVklORV9GUk9NYCxcbiAgICBjaG9pY2VzOiBHTE9CQUxfRkxBR1MubWFwKChmKSA9PiBgLS0ke2Z9YCksXG4gIH0pO1xuXG4vLyDimqAgRVZFUlkgQ09NTUFORCBGVU5DVElPTiBCRUxPVyBSRUZVU0VTIEEgTUlTU0lORyBQT1NJVElPTkFMIE9OIElUUyBPV04gRklSU1Rcbi8vIExJTkUgKGEgdXNhZ2UgcmVmdXNhbCB3aGVuIHRoZSBuYW1lIGlzIGZhbHN5KSwgYW5kIGVhY2ggbm93IGRlY2xhcmVzIHRoYXQgcGFyYW1ldGVyXG4vLyBgc3RyaW5nIHwgdW5kZWZpbmVkYCBzbyBpdHMgc2lnbmF0dXJlIHNheXMgd2hhdCB0aGF0IGxpbmUgZG9lcyAodHlwZS1kZWJ0XG4vLyBUMzUpLiBBcml0eSBkaXNwYXRjaCByZWZ1c2VzIGEgbWlzc2luZyByZXF1aXJlZCBwb3NpdGlvbmFsIGJlZm9yZSBhbnkgb2Zcbi8vIHRoZW0gcnVucywgc28gdGhlIGd1YXJkcyBhcmUgdGhlIHNlY29uZCBsaW5lIG9mIGRlZmVuY2UsIG5vdCB0aGUgZmlyc3QuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJ0b3BpY1wiLCBcImZyZXNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE9wZW4ocG9zaXRpb25hbFswXSwge1xuICAgICAgICB0b3BpYzogZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgICBmcm9tOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBmcmVzaDogZmxhZ3MuZnJlc2ggPT09IHRydWUsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0b3BpY1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUb3BpYyhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcG9zaXRpb25hbC5sZW5ndGggPiAxID8gcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGlzdFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRMaXN0KCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwidmVyYm9zZVwiLCBcImZvcmNlXCIsIFwiaW4tcmVwbHktdG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgbmFtZSA9IHBvc2l0aW9uYWxbMF07XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJzZW5kXCIsIHBvc2l0aW9uYWwuc2xpY2UoMSksIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcInNlbmRcIik7XG4gICAgICBndWFyZEJvZHkoXCJzZW5kXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgYXdhaXQgY21kU2VuZChuYW1lLCBmcm9tIGFzIHN0cmluZywgdGV4dCwge1xuICAgICAgICBxdWlldDogISFmbGFncy5xdWlldCxcbiAgICAgICAgdmVyYm9zZTogISFmbGFncy52ZXJib3NlLFxuICAgICAgICBpblJlcGx5VG86IGZsYWdzW1wiaW4tcmVwbHktdG9cIl1cbiAgICAgICAgICA/IG51bWVyaWNGbGFnKFwic2VuZFwiLCBcImluLXJlcGx5LXRvXCIsIGZsYWdzW1wiaW4tcmVwbHktdG9cIl0sIDApXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbm5vdW5jZVwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwiZm9yY2VcIiwgXCJjaGFubmVsc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSByZXNvbHZlQWxpYXMoZmxhZ3MpO1xuICAgICAgY29uc3QgeyB0ZXh0LCBmcm9tSW5saW5lIH0gPSBhd2FpdCByZXNvbHZlQm9keShcImFubm91bmNlXCIsIHBvc2l0aW9uYWwsIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcImFubm91bmNlXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwiYW5ub3VuY2VcIiwgdGV4dCwgZnJvbUlubGluZSwgISFmbGFncy5mb3JjZSk7XG4gICAgICBjb25zdCBjaGFubmVscyA9IGZsYWdzLmNoYW5uZWxzXG4gICAgICAgID8gKGZsYWdzLmNoYW5uZWxzIGFzIHN0cmluZylcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKGMpID0+IGMudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGF3YWl0IGNtZEFubm91bmNlKGZyb20gYXMgc3RyaW5nLCB0ZXh0LCBjaGFubmVscywgeyBxdWlldDogISFmbGFncy5xdWlldCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwdWxsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwic3RhdHVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJwdWxsXCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgYXdhaXQgY21kUHVsbChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgeyBzdGF0dXM6IGZsYWdzLnN0YXR1cyBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidHJpYWdlXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRyaWFnZShwb3NpdGlvbmFsWzBdLCB7IGh1bWFuOiAhIWZsYWdzLmh1bWFuIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYWRcIixcbiAgICBmbGFnczogW1widGV4dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zaXRpb25hbFsxXSA/IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSA6IE5hTjtcbiAgICAgIGF3YWl0IGNtZFJlYWQocG9zaXRpb25hbFswXSwgaWQsIHsgdGV4dDogISFmbGFncy50ZXh0IH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhaXRcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJ0aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJ3YWl0XCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgY29uc3QgdGltZW91dCA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCwgMzApO1xuICAgICAgYXdhaXQgY21kV2FpdChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgdGltZW91dCwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2hvXCIsXG4gICAgZmxhZ3M6IFtcImFsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgaWYgKGZsYWdzLmFsbCkgYXdhaXQgY21kV2hvQWxsKCk7XG4gICAgICBlbHNlIGF3YWl0IGNtZFdobyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbGlhc1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBbGlhcyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwiZnJvbS1zdGFydFwiLCBcImxhc3RcIiwgXCJodW1hblwiLCBcImx1cmtcIiwgXCJtYXhcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgcmV0dXJuIGF3YWl0IGNtZFRhaWwocG9zaXRpb25hbFswXSwge1xuICAgICAgICBzaW5jZTogZmxhZ3Muc2luY2UgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbVN0YXJ0OiAhIWZsYWdzW1wiZnJvbS1zdGFydFwiXSxcbiAgICAgICAgbGFzdDogZmxhZ3MubGFzdCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJ0YWlsXCIsIFwibGFzdFwiLCBmbGFncy5sYXN0LCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgYXM6IHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICAgIGh1bWFuOiAhIWZsYWdzLmh1bWFuLFxuICAgICAgICBsdXJrOiAhIWZsYWdzLmx1cmssXG4gICAgICAgIG1heDogcmVzb2x2ZVRhaWxNYXgoZmxhZ3MubWF4KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdyZXBcIixcbiAgICBmbGFnczogW1wibGl0ZXJhbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJwYXR0ZXJuXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEdyZXAocG9zaXRpb25hbFswXSwgcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSwge1xuICAgICAgICBsaXRlcmFsOiAhIWZsYWdzLmxpdGVyYWwsXG4gICAgICAgIGZyb206IGZsYWdzLmZyb20gYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiY2xvc2VcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRDbG9zZShwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXNldFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZXNldChwb3NpdGlvbmFsWzBdLCB7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtYXJrXCIsXG4gICAgZmxhZ3M6IFtcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJkaXNwb3NpdGlvblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRNYXJrKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICAvLyBOYU4gZm9yIGEgbWlzc2luZyBpZCwgZXhhY3RseSB3aGF0IGBwYXJzZUludCh1bmRlZmluZWQpYCBnYXZlIOKAlCBhbmRcbiAgICAgICAgLy8gYGNtZE1hcmtgIHJlZnVzZXMgYSBub24tZmluaXRlIGlkIG9uIGl0cyBmaXJzdCBsaW5lLlxuICAgICAgICBwb3NpdGlvbmFsWzFdID09PSB1bmRlZmluZWQgPyBOdW1iZXIuTmFOIDogcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBwb3NpdGlvbmFsLnNsaWNlKDIpLmpvaW4oXCIgXCIpLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJtYXJrXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlb3BlblwiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgLy8gTmFOIGZvciBhIG1pc3NpbmcgaWQsIGV4YWN0bHkgd2hhdCBgcGFyc2VJbnQodW5kZWZpbmVkKWAgZ2F2ZSDigJQgYW5kXG4gICAgICAgIC8vIGBjbWRNYXJrYCByZWZ1c2VzIGEgbm9uLWZpbml0ZSBpZCBvbiBpdHMgZmlyc3QgbGluZS5cbiAgICAgICAgcG9zaXRpb25hbFsxXSA9PT0gdW5kZWZpbmVkID8gTnVtYmVyLk5hTiA6IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSxcbiAgICAgICAgXCJvcGVuXCIsXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncykgPz8gaWRlbnRpdHlSZXF1aXJlZChcInJlb3BlblwiKSxcbiAgICAgICAgeyBub3RlOiBmbGFncy5ub3RlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9LFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFyY2hpdmUocG9zaXRpb25hbFswXSwgZmFsc2UsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInVuYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBcmNoaXZlKHBvc2l0aW9uYWxbMF0sIHRydWUsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXJ0XCIsXG4gICAgYWxpYXNlczogW1widXBcIl0sXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZFN0YXJ0KCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzdGFydFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcInllc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZXN0YXJ0KHsgZm9yY2U6ICEhZmxhZ3MuZm9yY2UgfHwgISFmbGFncy55ZXMgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicm9sbFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcInllc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSb2xsKHsgZm9yY2U6IGZsYWdzLmZvcmNlID09PSB0cnVlIHx8IGZsYWdzLnllcyA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdG9wXCIsXG4gICAgZmxhZ3M6IFtcImhvbGRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kU3RvcCh7XG4gICAgICAgIGhvbGRTZWNvbmRzOlxuICAgICAgICAgIGZsYWdzLmhvbGQgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwic3RvcFwiLCBcImhvbGRcIiwgZmxhZ3MuaG9sZCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3YXRjaFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRXYXRjaChwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZWFwXCIsXG4gICAgYWxpYXNlczogW1wicHJ1bmVcIl0sXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwiZHJ5LXJ1blwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZWFwKHsgZm9yY2U6IGZsYWdzLmZvcmNlID09PSB0cnVlLCBkcnlSdW46IGZsYWdzW1wiZHJ5LXJ1blwiXSA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbmZvXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZEluZm8oKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2N0b3JcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kRG9jdG9yKCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgIGZsYWdzOiBbXCJodW1hblwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICAvLyBUaGUgQ0xJIGNhbiBiZSBBU0tFRCB3aGF0IGl0IGlzLiBncmFwZXZpbmUgYWxyZWFkeSBjYXJyaWVzXG4gICAgICAvLyBQTFVHSU5fVkVSU0lPTiB0byB3YXJuIHRoYXQgYSBkYWVtb24gaXMgZnJvbSBhIGRpZmZlcmVudCBjYWNoZWQgcGx1Z2luXG4gICAgICAvLyBwYXRoIHRoYW4gdGhpcyBDTEkgKG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKSDigJQgYnV0IGEgY2FsbGVyIHRoYXQgaGl0XG4gICAgICAvLyB0aGF0IHdhcm5pbmcsIG9yIHRoYXQgcnVucyBgcm9sbGAgZm9yIGl0cyB2ZXJzaW9uIHZlcmlmeSwgaGFkIG5vIHdheSB0b1xuICAgICAgLy8gYXNrIHRoaXMgc2lkZSB3aGF0IGl0IGlzIGhvbGRpbmcuIFRoZSB2YWx1ZSB3YXMgYWxyZWFkeSBpbiBtZW1vcnk7IG9ubHlcbiAgICAgIC8vIHRoZSBxdWVzdGlvbiB3YXMgbWlzc2luZy5cbiAgICAgIC8vIEpTT04gYnkgZGVmYXVsdCwgbWF0Y2hpbmcgZXZlcnkgZGF0YSBjb21tYW5kOyAtLWh1bWFuIGZvciBwcm9zZS5cbiAgICAgIGlmIChQTFVHSU5fVkVSU0lPTiA9PT0gbnVsbClcbiAgICAgICAgZGllKFwidmVyc2lvbiB1bmF2YWlsYWJsZSDigJQgY291bGQgbm90IHJlYWQgcGx1Z2luLmpzb25cIiwgXCJpbnRlcm5hbFwiKTtcbiAgICAgIGlmIChmbGFncy5odW1hbiA9PT0gdHJ1ZSkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYGdyYXBldmluZSB2JHtQTFVHSU5fVkVSU0lPTn1cXG5gKTtcbiAgICAgIGVsc2UgcHJpbnRKc29uKHsgbmFtZTogXCJncmFwZXZpbmVcIiwgdmVyc2lvbjogUExVR0lOX1ZFUlNJT04gfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46ICgpID0+IHtcbiAgICAgIC8vIEVtaXQgdGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSBkZXNjcmlwdGlvbiDigJQgZ2VuZXJhdGVkIGJ5XG4gICAgICAvLyBXQUxLSU5HIENPTU1BTkRTIGFuZCBDTElfT1BUSU9OUywgdGhlIHNhbWUgc3RydWN0dXJlcyB0aGUgcGFyc2VyIGFuZFxuICAgICAgLy8gZGlzcGF0Y2hlciBjb25zdW1lLCBhdCBhbnN3ZXIgdGltZS4gTm8gZGFlbW9uLCBubyBjb25maWcsIG5vXG4gICAgICAvLyBjcmVkZW50aWFsczsgc3Rkb3V0LCBleGl0IDAuIFRoZSBzaGFwZSBpcyBhY2MgZGVjbGFyYXRpb24gZm9ybWF0IHYwXG4gICAgICAvLyBleGFjdGx5LCBzbyB0aGUgb3V0cHV0IHBpcGVzIHN0cmFpZ2h0IGludG9cbiAgICAgIC8vIGBhY2MgY2hlY2sgPGNsaT4gLS1kZWNsYXJhdGlvbiA8KGdyYXBldmluZSBzY2hlbWEpYCB3aXRoIG5vIGFkYXB0ZXIuXG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShidWlsZERlY2xhcmF0aW9uKCksIG51bGwsIDIpfVxcbmApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhlbHBcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJpbnRIZWxwKCk7XG4gICAgfSxcbiAgfSxcbl07XG5cbmZ1bmN0aW9uIGZpbmRDb21tYW5kKHRva2VuOiBzdHJpbmcpOiBDb21tYW5kU3BlYyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBDT01NQU5EUy5maW5kKChjKSA9PiBjLm5hbWUgPT09IHRva2VuIHx8IGMuYWxpYXNlcz8uaW5jbHVkZXModG9rZW4pKTtcbn1cblxuLy8gVGhlIHZlcmIncyBmdWxsIGFjY2VwdGVkIHNldDogaXRzIG93biBmbGFncyBwbHVzIHRoZSBjb250cmFjdHVhbGx5LWdsb2JhbFxuLy8gaWRlbnRpdHkgcGFpciwgaW4gcmVnaXN0cnkgb3JkZXIuXG5mdW5jdGlvbiBhY2NlcHRlZEZsYWdzKHNwZWM6IENvbW1hbmRTcGVjKTogRmxhZ05hbWVbXSB7XG4gIGNvbnN0IG93biA9IG5ldyBTZXQ8RmxhZ05hbWU+KFsuLi5HTE9CQUxfRkxBR1MsIC4uLnNwZWMuZmxhZ3NdKTtcbiAgcmV0dXJuIChPYmplY3Qua2V5cyhDTElfT1BUSU9OUykgYXMgRmxhZ05hbWVbXSkuZmlsdGVyKChrKSA9PiBvd24uaGFzKGspKTtcbn1cblxuLy8gUm9vdCBpbnRlcmNlcHRvcnMg4oCUIGZsYWdzIHRoZSBST09UIGFuc3dlcnMgaXRzZWxmLCBiZWZvcmUgYW55IHZlcmIuIFRoZXNlIGFyZVxuLy8gbm90IGNvbW1hbmRzLCB3aGljaCBpcyBleGFjdGx5IHdoeSBhIGdlbmVyYXRvciB3YWxraW5nIFwidGhlIGNvbW1hbmRzXCIgd2Fsa3Ncbi8vIHBhc3QgdGhlbSAoYWNjIERULTYpOyB0aGV5IGFyZSBkZWNsYXJlZCBleHBsaWNpdGx5IGF0IGBwYXRoOiBbXWAuXG5jb25zdCBST09UX0lOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbi8vIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjAgKHNlZSBhZ2VudC1jbGktY29uZm9ybWFuY2Ugc3JjL2FjYy9raXQvZGVjbGFyYXRpb24udHMpOlxuLy8geyBmb3JtYXRWZXJzaW9uLCBwcm92ZW5hbmNlLCBzZWxmRGVzY3JpcHRpb24sIGNvbW1hbmRzOiBbeyBwYXRoLCBhcmdzLCBwb3NpdGlvbmFscyB9XSB9LlxuLy8gdjAgcmVmdXNlcyB1bmtub3duIGtleXMsIHNvIG5vdGhpbmcgcmljaGVyIChlZmZlY3RzLCBzdW1tYXJpZXMsIHZlcnNpb25zKVxuLy8gcmlkZXMgYWxvbmcg4oCUIHRob3NlIHdhaXQgZm9yIGEgdjEgd2l0aCBzbG90cyBmb3IgdGhlbS5cbmZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIC8vIEV2ZXJ5IHJlZ2lzdHJ5IGZsYWcgaXMgYWNjZXB0ZWQgdG9kYXk7IGEgcmVmdXNhbCBsaXN0IHdvdWxkIGFkZFxuICAvLyBzdGF0dXM6IFwicmVmdXNlZFwiIGVudHJpZXMgaGVyZSB0aGUgZGF5IGEgdmVyYiByZWNvZ25pc2VzLWFuZC1kZWNsaW5lcyBvbmUuXG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnTmFtZSkgPT4gKHtcbiAgICBuYW1lOiBgLS0ke2t9YCxcbiAgICB0eXBlOiBDTElfT1BUSU9OU1trXS50eXBlLFxuICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICB9KTtcbiAgY29uc3QgY29tbWFuZHM6IHtcbiAgICBwYXRoOiBzdHJpbmdbXTtcbiAgICBhcmdzOiB7IG5hbWU6IHN0cmluZzsgdHlwZTogXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiOyBzdGF0dXM6IHN0cmluZyB9W107XG4gICAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIH1bXSA9IFtcbiAgICB7XG4gICAgICAvLyBgcGF0aDogW11gIElTIHRoZSByb290LiBJdHMgZ3JhbW1hcjogb25lIHJlcXVpcmVkIHRva2VuIHNlbGVjdGluZyBhXG4gICAgICAvLyBjb21tYW5kLCBvciBhbiBpbnRlcmNlcHRvciBmbGFnIHRoZSByb290IGFuc3dlcnMgaXRzZWxmLlxuICAgICAgcGF0aDogW10sXG4gICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgIG5hbWU6IGkubmFtZSxcbiAgICAgICAgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsXG4gICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgfSkpLFxuICAgICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiY29tbWFuZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IHNwZWMgb2YgQ09NTUFORFMpIHtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgW3NwZWMubmFtZSwgLi4uKHNwZWMuYWxpYXNlcyA/PyBbXSldKSB7XG4gICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgcGF0aDogW25hbWVdLFxuICAgICAgICBhcmdzOiBhY2NlcHRlZEZsYWdzKHNwZWMpLm1hcCgoaykgPT4gYXJnKGspKSxcbiAgICAgICAgcG9zaXRpb25hbHM6IHNwZWMucG9zaXRpb25hbHMsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW1wic2NoZW1hXCJdIH0sXG4gICAgY29tbWFuZHMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlRmxhZ3MoXG4gIGFyZ3Y6IHN0cmluZ1tdLFxuICBzcGVjOiBDb21tYW5kU3BlYyxcbik6IHtcbiAgcG9zaXRpb25hbDogc3RyaW5nW107XG4gIGZsYWdzOiBGbGFncztcbn0ge1xuICBjb25zdCBhY2NlcHRlZCA9IGFjY2VwdGVkRmxhZ3Moc3BlYyk7XG4gIGNvbnN0IG9wdGlvbnMgPSBPYmplY3QuZnJvbUVudHJpZXMoYWNjZXB0ZWQubWFwKChrKSA9PiBbaywgQ0xJX09QVElPTlNba11dKSk7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IGFyZ3YsXG4gICAgICBvcHRpb25zLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgcG9zaXRpb25hbDogcG9zaXRpb25hbHMsXG4gICAgICBmbGFnczogdmFsdWVzIGFzIEZsYWdzLFxuICAgIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBkZXRhaWwgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgY29uc3QgYm9keUhpbnQgPVxuICAgICAgc3BlYy5uYW1lID09PSBcInNlbmRcIiB8fCBzcGVjLm5hbWUgPT09IFwiYW5ub3VuY2VcIlxuICAgICAgICA/IFwiZm9yIGEgbWVzc2FnZSBib2R5IGNvbnRhaW5pbmcgZGFzaGVzLCB1c2UgLS1zdGRpbiBvciAtLWJvZHktZmlsZSwgXCIgK1xuICAgICAgICAgIFwib3IgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLVwiXG4gICAgICAgIDogXCJcIjtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihgJHtzcGVjLm5hbWV9OiAke2RldGFpbH1gLCB7XG4gICAgICAvLyDim5QgVEhFIFNFVCBJUyBgY2hvaWNlc2AgTk9XLCBOT1QgQSBQUk9TRSBNQVJLRVIuIEl0IHVzZWQgdG8gYmUgYSBzZWNvbmRcbiAgICAgIC8vIGxpbmUgcmVhZGluZyBgcmVjb2duaXplZCBmbGFnczogLS1hIC0tYmAsIHNwZWxsZWQgd2l0aCB0aGUgY29sb25cbiAgICAgIC8vIHN0cmFpZ2h0IGFmdGVyIHRoZSBub3VuIGJlY2F1c2UgdGhhdCBpcyB0aGUgbWFya2VyIHNoYXBlIGEgZmxhZy1zZXRcbiAgICAgIC8vIGV4dHJhY3RvciBtYXRjaGVzLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBBTkQgTk9UIEJFQ0FVU0UgVEhFIE1BUktFUiBXT1VMRCBIQVZFIFNUT1BQRUQgV09SS0lORyDigJQgdGhhdCByZWFzb25cbiAgICAgIC8vIHdhcyB3cml0dGVuIGhlcmUgYW5kIGluIEQ3MSwgYW5kIGl0IGlzIEZBTFNFLiBhY2MgcGFyc2VzIHRoZSB3aG9sZVxuICAgICAgLy8gZW52ZWxvcGUsIHRoZW4gd2Fsa3MgYHN0cmluZ1ZhbHVlc09mKGRvY3VtZW50KWAgYW5kIHJ1bnMgdGhlIFNBTUUgcHJvc2VcbiAgICAgIC8vIE1BUktFUiByZWdleCBvdmVyIGV2ZXJ5IHN0cmluZyBpbnNpZGUgaXQsIGZvciBleGFjdGx5IHRoaXMgY2FzZVxuICAgICAgLy8gKGBhZ2VudC1jbGktY29uZm9ybWFuY2Uvc3JjL2FjYy9raXQvc3VyZmFjZS50czo2NTMtNjU2YCwgd2hvc2UgZG9jXG4gICAgICAvLyBjb21tZW50IG5hbWVzIGFudGhpbGwncyBgXCJWYWxpZCBmbGFnczogLS1mb3JtYXRcImAgaW5zaWRlIGFuIGBlcnJvcmBcbiAgICAgIC8vIHN0cmluZykuIEEgbWFya2VyIGVtYmVkZGVkIGluIHRoZSBlbnZlbG9wZSB3b3VsZCBzdGlsbCBoYXZlIGJlZW4gcmVhZC5cbiAgICAgIC8vXG4gICAgICAvLyBUaGUgbW92ZSBpcyByaWdodCBmb3IgcmVhc29ucyB0aGF0IHN1cnZpdmUgdGhhdCBjb3JyZWN0aW9uOiBgY2hvaWNlc2AgaXNcbiAgICAgIC8vIHRoZSBlbnZlbG9wZSdzIG93biBmaWVsZCBmb3IgdGhlIGFjY2VwdGVkIHNldCwgaXQgaXMgd2hhdCBnbGFtb3VyXG4gICAgICAvLyBwdWJsaXNoZXMgYXQgQ09ORk9STUFOVCBMMCwgYW4gQVJSQVkgY2Fubm90IGJlIHRydW5jYXRlZCBieSBhIHJlYWRlclxuICAgICAgLy8gdGhhdCBzdG9wcyBhdCB0aGUgZmlyc3QgdG9rZW4gd2hpY2ggaXMgbm90IGEgYC0tbG9uZ2AgZmxhZywgYW5kIG9uZVxuICAgICAgLy8gc3BlbGxpbmcgb2Ygb25lIHNldCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgb3RoZXIuXG4gICAgICBjaG9pY2VzOiBhY2NlcHRlZC5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICAgIC4uLihib2R5SGludCA/IHsgaGludDogYm9keUhpbnQgfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb21tYW5kVG9rZW5zKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIENPTU1BTkRTLmZsYXRNYXAoKGMpID0+IFtjLm5hbWUsIC4uLihjLmFsaWFzZXMgPz8gW10pXSk7XG59XG5cbmZ1bmN0aW9uIHByaW50SGVscCgpIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYGdyYXBldmluZSDigJQgYWdlbnQtdG8tYWdlbnQgd2Fsa2llLXRhbGtpZVxuXG5Vc2FnZTpcbiAgZ3JhcGV2aW5lIG9wZW4gPG5hbWU+IFstLXRvcGljIDx0ZXh0Pl0gWy0tZnJlc2hdICAgb3Blbi9jcmVhdGUgKGF1dG8tdW5hcmNoaXZlczsgLS1mcmVzaCBjbGVhcnMgYSBkb3JtYW50IGNoYW5uZWwpXG4gIGdyYXBldmluZSBsaXN0XG4gIGdyYXBldmluZSBzZW5kIDxuYW1lPiBbLS1mcm9tLy0tYXMgPGFsaWFzPl0gWy0tcXVpZXRdIFstLXZlcmJvc2VdIFstLXN0ZGluXSBbLS1ib2R5LWZpbGUgPHBhdGg+XSBbLS1mb3JjZV0gWy0taW4tcmVwbHktdG8gPGlkPl0gWzx0ZXh0Li4uPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgYm9keTogaW5saW5lIHRleHQsIC0tc3RkaW4sIC0tYm9keS1maWxlLCBvciBwaXBlZCBzdGRpbiAoZGVmYXVsdCB3aGVuIG5vIGlubGluZSB0ZXh0KVxuICBncmFwZXZpbmUgYW5ub3VuY2UgWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLWNoYW5uZWxzIGEsYixjXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tcXVpZXRdIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJyb2FkY2FzdCBvbmUgbWVzc2FnZSB0byBldmVyeSBhY3RpdmUgY2hhbm5lbCAob3IgLS1jaGFubmVscylcbiAgZ3JhcGV2aW5lIHRhaWwgPG5hbWU+IFstLWFzLy0tZnJvbSA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXG4gICAgICAgIyAtLWxhc3QgPG4+OiBiYWNrZmlsbCB0aGUgbW9zdCByZWNlbnQgbiBtZXNzYWdlcyB0aGVuIGdvIGxpdmUgKGJvdW5kZWQgY2F0Y2gtdXAgZm9yIGEgY29sZCBqb2luZXIpXG4gIGdyYXBldmluZSBwdWxsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl0gICAjIC0tc3RhdHVzID0gZnVsbC1zY2FuIGZpbHRlciAob3Blbnx3b250Zml4fGluY29ycG9yYXRlZHzigKYpXG4gIGdyYXBldmluZSB0cmlhZ2UgPG5hbWU+ICAgICAgICAgICAgICMgZnVsbC1zY2FuOiBvcGVuIG1lc3NhZ2VzIG9uIHRvcCArIGdyb3VwZWQgYnlfc3RhdHVzXG4gIGdyYXBldmluZSBtYXJrIDxuYW1lPiA8aWQ+IDxkaXNwb3NpdGlvbj4gWy0tbm90ZSA8dGV4dD5dICAjIHNldCBkaXNwb3NpdGlvbiAoaW5jb3Jwb3JhdGVkfHdvbnRmaXh8ZGVmZXJyZWR84oCmKVxuICBncmFwZXZpbmUgcmVvcGVuIDxuYW1lPiA8aWQ+ICAgICAgICAjIGJvdW5jZSBhIG1lc3NhZ2UgYmFjayB0byBvcGVuXG4gIGdyYXBldmluZSByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdICAgIyBvbmUgZnVsbCBtZXNzYWdlIGJ5IGlkICgtLXRleHQgPSBwcm9zZSlcbiAgZ3JhcGV2aW5lIHdhaXQgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVxuICBncmFwZXZpbmUgZ3JlcCA8bmFtZT4gPHBhdHRlcm4+IFstLWxpdGVyYWxdIFstLWZyb20gPGFsaWFzPl1cbiAgZ3JhcGV2aW5lIHRvcGljIDxuYW1lPiBbPHRleHQ+XSAgICMgbm8gdGV4dCDihpIgcmVhZCBjdXJyZW50OyB3aXRoIHRleHQg4oaSIHVwZGF0ZVxuICBncmFwZXZpbmUgd2hvIDxuYW1lPiAgICAgICAgICAgICAgIyByb3N0ZXI7IHRoZSBodW1hbnMgZmllbGQgbGlzdHMgaHVtYW5zXG4gIGdyYXBldmluZSBhbGlhcyBbPG5hbWU+XSAgICAgICAgICAjIHNldC9zaG93IHlvdXIgcGVyc2lzdGVkIGFsaWFzIChjb25maWcuanNvbilcbiAgZ3JhcGV2aW5lIHdhdGNoIFs8bmFtZT5dICAgICAgICAgICMgb3BlbiBicm93c2VyIHRhYjsgbGl2ZSBjaGF0LWJ1YmJsZSB2aWV3XG4gIGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdICAgICAgICAgICBzbmFwc2hvdCB0aGUgbG9nIOKGkiB+Ly5ncmFwZXZpbmUvYXJjaGl2ZSwgdGhlbiBjbGVhciBpdFxuICBncmFwZXZpbmUgYXJjaGl2ZSA8bmFtZT4gICAgICAgICAgIyByZWFkLW9ubHk6IGtlZXAgaGlzdG9yeSwgcmVqZWN0IHNlbmRzXG4gIGdyYXBldmluZSB1bmFyY2hpdmUgPG5hbWU+ICAgICAgICAjIGJyaW5nIGFuIGFyY2hpdmVkIGNoYW5uZWwgYmFja1xuICBncmFwZXZpbmUgY2xvc2UgPG5hbWU+ICAgICAgICAgICAgIyBkZXN0cnVjdGl2ZTogZGVsZXRlIHRoZSBtZXNzYWdlIGxvZ1xuICBncmFwZXZpbmUgc3RhcnQgICAgICAgICAgICAgICAgICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyBydW5uaW5nIChhbGlhczogdXApOyBubyBjaGFubmVsXG4gIGdyYXBldmluZSByZXN0YXJ0IFstLWZvcmNlfC0teWVzXSAjIHN0b3AgKyByZXNwYXduIGZyZXNoOyAtLWZvcmNlIHRvIG92ZXJyaWRlIHRoZSBsaXZlLWZsZWV0IGd1YXJkXG4gIGdyYXBldmluZSByb2xsIFstLWZvcmNlXSAgICAgICAgICAjIHNhZmUgcmVzdGFydCAoc3RvcCtob2xkK3Jlc3Bhd24pICsgdmVyc2lvbiB2ZXJpZnkg4oCUIHRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcFxuICBncmFwZXZpbmUgc3RvcCBbLS1ob2xkIDxzZWNvbmRzPl0gIyBraWxsIHRoZSBkYWVtb247IC0taG9sZCBzdXBwcmVzc2VzIGF1dG8tcmVzcGF3biBmb3IgPHM+IHNlY29uZHMgKHVwZ3JhZGUgd2luZG93KVxuICBncmFwZXZpbmUgaW5mb1xuICBncmFwZXZpbmUgZG9jdG9yICAgICAgICAgICAgICAgICAgIyBoZWFsdGggY2hlY2sg4oCUIGxhYmVscyBlYWNoIGRhZW1vbjogYXV0aG9yaXRhdGl2ZSAvIG9ycGhhbiAvIHVucmVzcG9uc2l2ZSAvIHVua25vd25cbiAgZ3JhcGV2aW5lIHJlYXAgWy0tZm9yY2VdIFstLWRyeS1ydW5dICAjIGtpbGwgb3JwaGFuIGRhZW1vbnM7IC0tZm9yY2UgYWxzbyBraWxscyB1bnJlc3BvbnNpdmU7IGFsaWFzOiBwcnVuZVxuXG4gIGdyYXBldmluZSBzY2hlbWEgICAgICAgICAgICAgICAgICAjIHRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgZGVzY3JpcHRpb24gKGFjYyBkZWNsYXJhdGlvbiB2MClcbiAgZ3JhcGV2aW5lIC0tdmVyc2lvbiAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyB2ZXJzaW9uIChhbGlhczogLVYsIHZlcnNpb24pXG4gIGdyYXBldmluZSBoZWxwICAgICAgICAgICAgICAgICAgICAjIHRoaXMgdXNhZ2UgKGFsaWFzOiAtLWhlbHAsIC1oKVxuXG5PdXRwdXQ6XG4gIERhdGEgY29tbWFuZHMgZW1pdCBKU09OIG9uIHN0ZG91dCBieSBERUZBVUxUOyBwYXNzIC0taHVtYW4gZm9yIHByb3NlIHdoZXJlIGFcbiAgY29tbWFuZCBvZmZlcnMgaXQuIERpYWdub3N0aWNzIGFuZCB3YXJuaW5ncyBnbyB0byBzdGRlcnIsIG5ldmVyIHN0ZG91dC5cbiAgVXNhZ2UgZXJyb3JzIGV4aXQgMi4gRWFjaCBjb21tYW5kIGFjY2VwdHMgaXRzIE9XTiBmbGFncyAocGx1cyAtLWFzLy0tZnJvbSxcbiAgd2hpY2ggYXJlIGdsb2JhbCkg4oCUIGFuIHVua25vd24gZmxhZyBmb3IgYSB2ZXJiIGVudW1lcmF0ZXMgdGhhdCB2ZXJiJ3Mgc2V0LlxuXG5FbnY6XG4gIEdSQVBFVklORV9GUk9NICAgRGVmYXVsdCBpZGVudGl0eSBhbGlhcyAoLS1mcm9tLy0tYXMgYXJlIGludGVyY2hhbmdlYWJsZSkuXG4gIEdSQVBFVklORV9IT01FICAgRGF0YSBkaXIgKGRlZmF1bHQgfi8uZ3JhcGV2aW5lKS5cbmApO1xufVxuXG4vKipcbiAqIFRoZSB2ZXJiIHJvdXRlci4gRXZlcnkgcmVqZWN0aW9uIGhlcmUgUkFJU0VTOyBub3RoaW5nIHdyaXRlcyBpdHMgb3duIHByb3NlLlxuICpcbiAqIOKblCBUSElTIEZVTkNUSU9OIFVTRUQgVE8gQkUgYG1haW5gLCBBTkQgSVRTIEZPVVIgUkVKRUNUSU9OUyBVU0VEIFRPIEJFXG4gKiBgcHJvY2Vzcy5zdGRlcnIud3JpdGUoLi4uKTsgcmV0dXJuIDJgIOKAlCBhIFNFQ09ORCBlcnJvciBjb250cmFjdCBiZXNpZGUgYGRpZWAsXG4gKiB3aXRoIGl0cyBvd24gd29yZGluZywgaXRzIG93biBtYXJrZXJzIGFuZCBubyBga2luZGAgb24gdGhlIHdpcmUuIEEgZ3JlcCBmb3JcbiAqIGBkaWUoYCB3b3VsZCBoYXZlIHJlcG9ydGVkIFwidGhlIGVycm9yIGNvbnRyYWN0IGlzIDQ2IHNpdGVzXCI7IGl0IHdhcyA0NiBwbHVzXG4gKiB0aGVzZSwgYW5kIHRoZXNlIGFyZSB0aGUgb25lcyBhbiBhZ2VudCBtZWV0cyBmaXJzdCAocGxheWJvb2sgQjg6IGxvb2sgZm9yIHRoZVxuICogUkFJU0UsIG5vdCBmb3IgdGhlIGhlbHBlcikuIFRoZXkgbm93IHJhaXNlIHRoZSBzYW1lIGVudmVsb3BlIGFzIHRoZSByZXN0LlxuICovXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IFtjbWQsIC4uLnJlc3RdID0gYXJndjtcblxuICAvLyBCQVJFIElOVk9DQVRJT04gSVMgQSBVU0FHRSBFUlJPUiDigJQgZXhpdCAyLCB1c2FnZSBwb2ludGVyIG9uIHN0ZGVyciDigJQgbm90IGFcbiAgLy8gaGVscCByZXF1ZXN0IGF0IGV4aXQgMC4gZ3JhcGV2aW5lJ3MgY2FsbGVycyBhcmUgYWdlbnRzOiBhIGJhcmUgY2FsbCBpcyBhblxuICAvLyB1bnNldCBzaGVsbCB2YXJpYWJsZSBleHBhbmRpbmcgdG8gbm90aGluZywgb3IgYSBtaXN0YWtlLCBhbmQgYW5zd2VyaW5nIGl0XG4gIC8vIHdpdGggMi45S0Igb2YgaGVscCBhdCBleGl0IDAgcmVwb3J0cyBzdWNjZXNzIGZvciBhIGNvbW1hbmQgdGhhdCBhc2tlZCBmb3JcbiAgLy8gbm90aGluZy4gYGhlbHBgIC8gYC0taGVscGAgcmVtYWluIG9uZSB0b2tlbiBhd2F5IGF0IGV4aXQgMCAoYWNjIEQyIOKAlFxuICAvLyBjb25mb3JtZWQgZm9yIHRoYXQgcmVhc29uLCBub3QgYmVjYXVzZSB0aGUgcnVsZSBzYWlkIHNvKS5cbiAgaWYgKGNtZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgZGllKFwiZXhwZWN0ZWQgYSBjb21tYW5kXCIsIFwidXNhZ2VcIiwge1xuICAgICAgY2hvaWNlczogY29tbWFuZFRva2VucygpLFxuICAgICAgaGludDogXCJydW4gYGdyYXBldmluZSBoZWxwYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VcIixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJPT1QgRkxBRyBST1VUSU5HLiBBIGxlYWRpbmcgLS10b2tlbiB1c2VkIHRvIGJlIGNvbnN1bWVkIGFzIHRoZSBDT01NQU5EXG4gIC8vIHRva2VuIGFuZCByZWplY3RlZCBhcyBgdW5rbm93biBjb21tYW5kOiAtLW5vcGVgIOKAlCBhIGZsYWcgcmVhY2hpbmcgdGhlIHZlcmJcbiAgLy8gcGFyc2VyJ3MgZXJyb3IgcGF0aCwgd2hlcmUgdGhlIHJlamVjdGlvbiBjb3VsZCBub3QgZW51bWVyYXRlIHRoZSBmbGFnIHNldFxuICAvLyAoZm91bmQgdmlhIGFjYydzIHJvb3Qtb25seSBzdXJmYWNlIGNhcHR1cmUpLiBUaGUgcm9vdCdzIGFjY2VwdGVkIGZsYWdzIGFyZVxuICAvLyB0aGUgaW50ZXJjZXB0b3JzOyBhbnl0aGluZyBlbHNlIGRhc2hlZCBpcyByZWplY3RlZCBBUyBBIEZMQUcsIGVudW1lcmF0aW5nXG4gIC8vIHRoZSByb290J3Mgb3duIHNldC5cbiAgaWYgKGNtZC5zdGFydHNXaXRoKFwiLVwiKSkge1xuICAgIGNvbnN0IGludGVyY2VwdG9yID0gUk9PVF9JTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBjbWQpO1xuICAgIGlmICghaW50ZXJjZXB0b3IpIHtcbiAgICAgIC8vIOKaoCBUSEUgU09SVCBTVVJWSVZFUyBUSEUgTU9WRSBJTlRPIGBjaG9pY2VzYCwgQU5EIElUIElTIE5PVCBERUNPUkFUSU9OLlxuICAgICAgLy8gTG9uZyBmbGFncyBmaXJzdCwgYmVjYXVzZSBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkcyB0aGUgbGlzdFxuICAgICAgLy8gbGVmdC10by1yaWdodCBhbmQgc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZyxcbiAgICAgIC8vIHNvIGEgc2hvcnQgYWxpYXMgbWlkLWxpc3QgdHJ1bmNhdGVzIHdoYXQgaXQgc2Vlcy4gQW4gYXJyYXkgaXMgbm90XG4gICAgICAvLyB2dWxuZXJhYmxlIHRvIHRoYXQg4oCUIGJ1dCB0aGUgb3JkZXIgaXMgZnJlZSBhbmQgdGhlIHByb3BlcnR5IGlzIHJlYWwgZm9yXG4gICAgICAvLyBhbnkgY29uc3VtZXIgdGhhdCBmbGF0dGVucyBpdCBiYWNrIHRvIGEgbGluZS5cbiAgICAgIGRpZShgdW5rbm93biBmbGFnIGF0IHRoZSByb290OiAke2NtZH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgY2hvaWNlczogWy4uLlJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKV0uc29ydChcbiAgICAgICAgICAoYSwgYikgPT4gTnVtYmVyKGIuc3RhcnRzV2l0aChcIi0tXCIpKSAtIE51bWJlcihhLnN0YXJ0c1dpdGgoXCItLVwiKSksXG4gICAgICAgICksXG4gICAgICAgIGhpbnQ6IGBjb21tYW5kcyAoZWFjaCB0YWtlcyBpdHMgb3duIGZsYWdzKTogJHtjb21tYW5kVG9rZW5zKCkuam9pbihcIiBcIil9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gYXdhaXQgcnVuQ29tbWFuZChmaW5kQ29tbWFuZChpbnRlcmNlcHRvci5ydW5zKSBhcyBDb21tYW5kU3BlYywgcmVzdCk7XG4gIH1cblxuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQoY21kKTtcbiAgaWYgKCFzcGVjKSB7XG4gICAgLy8gVGhlIHVua25vd24tdmVyYiByZWplY3Rpb24gZW51bWVyYXRlcyB0aGUgdmFsaWQgc2V0LCBleGFjdGx5IGFzIHRoZVxuICAgIC8vIHVua25vd24tZmxhZyByZWplY3Rpb24gZG9lcyDigJQgdGhlIHBhcnNlcidzIG93biBhY2NvdW50IG9mIHdoYXQgaXRcbiAgICAvLyBhY2NlcHRzLCBwcm9kdWNlZCBieSB0aGUgcGFyc2VyIChhY2MgU1RBTkRBUkQubWQsIFwidGhlIGNoZWFwZXN0IHZlcnNpb25cbiAgICAvLyBvZiBjaGVja2VkXCIpLlxuICAgIGRpZShgdW5rbm93biBjb21tYW5kOiAke2NtZH1gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogY29tbWFuZFRva2VucygpIH0pO1xuICB9XG4gIHJldHVybiBhd2FpdCBydW5Db21tYW5kKHNwZWMsIHJlc3QpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5Db21tYW5kKHNwZWM6IENvbW1hbmRTcGVjLCByZXN0OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBwb3NpdGlvbmFsOiBzdHJpbmdbXTtcbiAgbGV0IGZsYWdzOiBGbGFncztcbiAgdHJ5IHtcbiAgICAoeyBwb3NpdGlvbmFsLCBmbGFncyB9ID0gcGFyc2VGbGFncyhyZXN0LCBzcGVjKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgZGllKGUubWVzc2FnZSwgXCJ1c2FnZVwiLCBlLmV4dHJhKTtcbiAgfVxuICAvLyBBcml0eSwgZW5mb3JjZWQgRlJPTSBUSEUgREVDTEFSRUQgU0hBUEUg4oCUIHRoZSByZWdpc3RyeSdzIHBvc2l0aW9uYWwgc3BlYyBpc1xuICAvLyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcywgc28gZW5mb3JjaW5nIGl0IGhlcmUgaXMgd2hhdCBrZWVwcyB0aGUgZGVjbGFyYXRpb25cbiAgLy8gdHJ1ZSBieSBjb25zdHJ1Y3Rpb246IGEgbWlzc2luZyByZXF1aXJlZCBwb3NpdGlvbmFsIGVycm9ycyBiZWZvcmUgdGhlIHZlcmJcbiAgLy8gcnVucywgYW5kIGFuIEVYQ0VTUyBwb3NpdGlvbmFsIGlzIHJlamVjdGVkIHJhdGhlciB0aGFuIHNpbGVudGx5IHN3YWxsb3dlZFxuICAvLyAoYWNjIEE0J3Mgc2hhcGUg4oCUIHRoZSBkZWZlY3Qgbm8gZXh0ZXJuYWwgY2hlY2sgY2FuIHNlZSkuXG4gIGNvbnN0IHJlcXVpcmVkID0gc3BlYy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgY29uc3QgdmFyaWFkaWMgPSBzcGVjLnBvc2l0aW9uYWxzLnNvbWUoKHApID0+IHAudmFyaWFkaWMpO1xuICBpZiAocG9zaXRpb25hbC5sZW5ndGggPCByZXF1aXJlZCkge1xuICAgIGNvbnN0IG1pc3NpbmcgPSBzcGVjLnBvc2l0aW9uYWxzW3Bvc2l0aW9uYWwubGVuZ3RoXTtcbiAgICBkaWUoYCR7c3BlYy5uYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICBoaW50OiBgZXhwZWN0czogJHtzcGVjLm5hbWV9ICR7c3BlYy5wb3NpdGlvbmFsc1xuICAgICAgICAubWFwKChwKSA9PiAocC5yZXF1aXJlZCA/IGA8JHtwLm5hbWV9PmAgOiBgWyR7cC5uYW1lfV1gKSlcbiAgICAgICAgLmpvaW4oXCIgXCIpfWAsXG4gICAgfSk7XG4gIH1cbiAgaWYgKCF2YXJpYWRpYyAmJiBwb3NpdGlvbmFsLmxlbmd0aCA+IHNwZWMucG9zaXRpb25hbHMubGVuZ3RoKSB7XG4gICAgZGllKFxuICAgICAgYCR7c3BlYy5uYW1lfTogdW5leHBlY3RlZCBhcmd1bWVudCAke0pTT04uc3RyaW5naWZ5KHBvc2l0aW9uYWxbc3BlYy5wb3NpdGlvbmFscy5sZW5ndGhdKX1gLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBgZXhwZWN0czogJHtzcGVjLm5hbWV9ICR7XG4gICAgICAgICAgc3BlYy5wb3NpdGlvbmFscy5tYXAoKHApID0+IChwLnJlcXVpcmVkID8gYDwke3AubmFtZX0+YCA6IGBbJHtwLm5hbWV9XWApKS5qb2luKFwiIFwiKSB8fFxuICAgICAgICAgIFwiKG5vIGFyZ3VtZW50cylcIlxuICAgICAgICB9YCxcbiAgICAgIH0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBvdXRjb21lID0gYXdhaXQgc3BlYy5ydW4ocG9zaXRpb25hbCwgZmxhZ3MpO1xuICByZXR1cm4gdHlwZW9mIG91dGNvbWUgPT09IFwibnVtYmVyXCIgPyBvdXRjb21lIDogMDtcbn1cblxuLyoqXG4gKiBUaGUgb25lIHBsYWNlIHRoaXMgQ0xJIGNhbiBlbmQsIGFuZCB0aGUgb25lIHBsYWNlIGEgYENsaUVycm9yYCBiZWNvbWVzIGFuXG4gKiBleGl0IGNvZGUuXG4gKlxuICog4puUIEFEREVEIEFUIFBIQVNFIDYgQ0hBUFRFUiAyLCBBTkQgSVQgSVMgV0hBVCBNQUtFUyBgZGllYCBTQUZFIFRPIFRIUk9XLlxuICogYHJlcG9ydENsaUVycm9yYCB3cml0ZXMgdGhlIGVudmVsb3BlIGFuZCBoYW5kcyBiYWNrIHRoZSB0YXhvbm9teSBjb2RlOyBhXG4gKiB0aHJvdyBpdCBkb2VzIE5PVCByZWNvZ25pc2UgaXMgcmUtdGhyb3duLCBiZWNhdXNlIHN3YWxsb3dpbmcgYW4gdW5rbm93biBvbmVcbiAqIGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeSB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZVxuICogc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKlxuICog4pqgIEFORCBgc2V0Q3VycmVudENvbW1hbmRgIElTIE5PVCBERUNPUkFUSU9OIOKAlCBpdCBpcyB0aGUgYG1ldGEuY29tbWFuZGAgZmllbGRcbiAqIG9mIGV2ZXJ5IGVudmVsb3BlIHRoaXMgQ0xJIGVtaXRzLCB3aGljaCBpcyBob3cgYSBjYWxsZXIgcm91dGluZyBvbiBga2luZGBcbiAqIGtub3dzIFdISUNIIHZlcmIgcHJvZHVjZWQgaXQuIFNldCBmcm9tIHRoZSByYXcgdG9rZW4gc28gYW4gdW5rbm93biB2ZXJiIHN0aWxsXG4gKiBuYW1lcyBpdHNlbGYgaW4gaXRzIG93biByZWplY3Rpb24uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBzZXRDdXJyZW50Q29tbWFuZChhcmd2WzBdID8/IG51bGwpO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAoY29kZSAhPT0gbnVsbCkgcmV0dXJuIGNvZGU7XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vLyDim5QgTk8gYGltcG9ydC5tZXRhLm1haW5gIEJMT0NLLCBBTkQgSVRTIEFCU0VOQ0UgSVMgVEhFIFNURVAgKHBsYXlib29rIEIzKS5cbi8vIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgYHNjcmlwdHMvY2xpLnRzYCwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3Ncbi8vIGVudHJ5LCBzbyB0aGUgZ3VhcmQgd291bGQgbmV2ZXIgcnVuIGFuZCBldmVyeSB2ZXJiIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kXG4vLyBleGl0IDAuIE5vciBtYXkgdGhpcyBmaWxlIG9mZmVyIGEgc2Vjb25kIGVudHJ5IGZyb20gaXRzIGF1dGhvcmluZyBhZGRyZXNzOlxuLy8gYFNLSUxMX1JPT1RgLCBgRElTVF9ESVJgLCBgU1VSRkFDRV9DV0RgIGFuZCBgREFFTU9OX1NDUklQVGAgYWJvdmUgYXJlIGFsbFxuLy8gY29tcHV0ZWQgZnJvbSBgU0NSSVBUX0RJUmAgYW5kIGFyZSBjb3JyZWN0IG9ubHkgZnJvbSBgZGlzdC9gLlxuLy9cbi8vIFRoZSBkcmFpbiBjb250cmFjdCBsaXZlcyBhdCB0aGUgbGF1bmNoZXIgbm93IOKAlCBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbi8vIHJldHVybiwgbmV2ZXIgYW4gZXhwbGljaXQgZXhpdCwgYmVjYXVzZSBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGFcbi8vIHBpcGUgYW5kIGB0YWlsYCB3cml0ZXMgSlNPTkwgYSBjYWxsZXIgcGFyc2VzLiBTZWVcbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvY2xpLnRzYCBmb3IgdGhlIGZ1bGwgYWNjb3VudC5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCByZXBhaXJlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhXG4gKiBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4g4puUIFJFQUNIQUJJTElUWSwgTk9UIENBTEwgU0lURVM6IGFcbiAqIEhFTFBFUiB0aGF0IGRpZXMsIGludm9rZWQgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAsIGhhcyBpdHMgYGRpZWAgYXRcbiAqIGEgc2l0ZSB0aGF0IHJlYWRzIGFzIHBlcmZlY3RseSBzYWZlLiBBbiBhZG9wdGluZyBzcGVsbCBtdXN0IGZvbGxvdyB0aGUgY2FsbFxuICogZ3JhcGgsIG5vdCBncmVwIGZvciBgZGllKGAuIEF1ZGl0ZWQgdGhhdCB3YXkgb24gYWRvcHRpb24g4oCUIDE1IHNpdGVzIGluXG4gKiBhc3Ryb2xhYmUsIDI5IGluIG1hZ3BpZSwgcGx1cyB0aGUgaGVscGVycyByZWFjaGFibGUgZnJvbSB0aGVtIOKAlCBhbmQgZXZlcnlcbiAqIHBhdGggaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLCBmcm9tIHdoaWNoIHRoZSB0aHJvd1xuICogcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKipcbiAqIEV4dHJhIGZpZWxkcyBhIGZhaWx1cmUgbWF5IGNhcnJ5LiBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC10YWlsLXJlYWRlci1jb252ZXJnZW5jZS5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7IGN1cnNvcjogbnVtYmVyOyByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgfSkgPT4gdm9pZDtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcbiAgbGV0IGVuZGluZzogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIiA9IFwic3RvcHBlZFwiO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvYmFja2xvZy8yMDI2LTA5LTIyLXNjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTIyLW1vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgYWx3YXlzIGdldHMgYHRhaWwud2luZG93YDogYSBzdG9wLXN0YXJ0IHRhaWxcbiAqICAgICB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHMgY29ubmVjdGlvbiBjYXJyaWVzLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMpLCBlYWNoIG5hbWluZyBob3cgdG8gY29tZSBiYWNrXG4gKiBpbnN0ZWFkIG9mIGEgcmUtYXJtLiBBIHNpZ25hbCBvciBhIGNhbGxlcidzIGFib3J0IHByaW50cyBub3RoaW5nLlxuICpcbiAqIEV2ZXJ5IHJlLWFybSBjYXJyaWVzIGAtLXNpbmNlIDxjdXJzb3I+YCwgc28gbm90aGluZyByZXBsYXlzOyB0aGUgZGFlbW9uJ3NcbiAqIGJ1ZmZlciBjb3ZlcnMgd2hhdGV2ZXIgbGFuZHMgYmV0d2VlbiBvbmUgd2F0Y2gncyBleGl0IGFuZCB0aGUgbmV4dCdzIGFybS5cbiAqXG4gKiDilIDilIAgREVDSVNJT04gTE9HIChmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogS2l0IGRlY2lzaW9ucyBsaXZlIGluIG1vZHVsZSBoZWFkZXJzICh0aGUgYXJjaGl0ZWN0dXJlIGRvYydzIMKnNCBydWxlOiBcImVhY2hcbiAqIG1vZHVsZSdzIGhlYWRlciBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhY2NvdW50XCIpLiBSdWxlZCBieSBDb2xlOiB0aGUgaHlicmlkLFxuICogdGhlIGFsd2F5cy1ib29rbWFyaywgcHJlc2VuY2Ugc3BlbGxzIGFsd2F5cyByZS1hcm0gTW9uaXRvciwgYm91bnR5J3MgZXhhbXBsZVxuICogZml4ZWQuIFRoZSBmb3VyIGFkanVzdG1lbnRzIHdlcmUgdGhlIHNwaWtlJ3MgcmVxdWlyZW1lbnRzLiBUaGUgcmVzdCBhcmUgdGhlXG4gKiBpbXBsZW1lbnRlcidzIHJ1bGluZ3MsIG1hcmtlZCDimpYgd2l0aCB0aGUgb3B0aW9ucyBub3QgdGFrZW4uXG4gKlxuICogQTEgwrcgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04uIGB0YWlsRXZlbnRzYCBub3cgYWJvcnRzIHRoZVxuICogICAgICBpbi1mbGlnaHQgZmV0Y2ggYmVmb3JlIGl0IHJldHVybnMgb24gYSB0ZXJtaW5hbCBmcmFtZS4gQmVmb3JlLCBpdFxuICogICAgICByZXR1cm5lZCBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIGFuZCBsZWZ0IHRoZSBTU0Ugc3RyZWFtIG9wZW4sIHNvIHRoZVxuICogICAgICBwcm9jZXNzIHN0YXllZCBhbGl2ZTogdW5zZWVuIGZvciBgY2xvc2VkYCAodGhlIHNlcnZlciBlbmRzIHRoYXRcbiAqICAgICAgc3RyZWFtIGl0c2VsZikgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrIHdvdWxkXG4gKiAgICAgIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LCBzaWxlbnRseS4gUGlubmVkIGluXG4gKiAgICAgIGB0YWlsSGFuZG9mZi50ZXN0LnRzYCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQga2VlcHMgdGhlIHN0cmVhbSBvcGVuLlxuICpcbiAqIEEyIMK3IFRIRSBORVhUIEFDVCBERVBFTkRTIE9OIFNUQVRFLiBgaGFuZG9mZigpYCBiZWxvdyBpcyB0aGUgcHVyZSBkZWNpc2lvbjpcbiAqICAgICAgcXVpZXQg4oaSIGJhY2tncm91bmQsIGFjdGl2ZSBvciBwcmVzZW5jZSDihpIgTW9uaXRvciwgd29rZSDihpIgTW9uaXRvcixcbiAqICAgICAgY2xvc2VkIOKGkiBjb21lIGJhY2ssIGxvc3Qg4oaSIGNvbWUgYmFjay4gQ29tZSBiYWNrIGlzIHRoZSBzcGVsbCdzIG93biB2ZXJiXG4gKiAgICAgIChgb3BlbiAtLXJlc3RvcmUgPGlkPmAgZm9yIHRoZSBzZXNzaW9uIHNwZWxscykuXG4gKiAgICAgIOKaliBUSEUgRElTQ09OTkVDVCBERUNJU0lPTjogZm9yIGEgc2Vzc2lvbiBzcGVsbCwgYSBMT1NUIGRhZW1vbiBlbmRzIHRoZVxuICogICAgICB0YWlsIGluIEJPVEggbW9kZXMgd2l0aCBhIHN0ZG91dCBgdGFpbC5sb3N0YCBsaW5lLiBNb25pdG9yIG5vdGlmaWVzIG9ubHlcbiAqICAgICAgb24gc3Rkb3V0LCBzbyB0aGUgb2xkIHN0ZGVyci1vbmx5IGB0YWlsLmRpc2Nvbm5lY3RlZGAgbGVmdCBhXG4gKiAgICAgIE1vbml0b3Itd3JhcHBlZCBhZ2VudCB1bmF3YXJlIG9mIGEgYGtpbGwgLTlgIChFNTUncyBwdXJwb3NlIHVubWV0KSwgYW5kXG4gKiAgICAgIGEgYC0tb25jZWAgb24gYSBkZWFkIGRhZW1vbiB3b3VsZCBoYXZlIHNsZXB0IGZvcmV2ZXIuIFwiTG9zdFwiIGlzXG4gKiAgICAgIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBjb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93LCBuZXZlciBhIGRyb3BwZWRcbiAqICAgICAgc3RyZWFtIGFsb25lOiBhIGxhcHRvcCB0aGF0IHNsZWVwcyBkcm9wcyB0aGUgc3RyZWFtLCByZWNvbm5lY3RzIG9uIHRoZVxuICogICAgICBmaXJzdCB0cnksIGFuZCBtdXN0IHN0YXkgc2lsZW50LlxuICogICAgICAgIE5vdCB0YWtlbjogKGEpIGtlZXAgcmV0cnlpbmcgYW5kIG9ubHkgTU9WRSB0aGUgZGlzY29ubmVjdCBsaW5lIHRvXG4gKiAgICAgICAgc3Rkb3V0IOKAlCBhIHNlc3Npb24gZGFlbW9uIGlzIG5ldmVyIHJlc3Bhd25lZCBieSBpdHMgdGFpbCwgc28gdGhlXG4gKiAgICAgICAgcmV0cmllcyBidXkgbm90aGluZyBhbmQgdGhlIGFnZW50IGlzIHdva2VuIHRvIGJlIHRvbGQgdG8gd2FpdDsgKGIpXG4gKiAgICAgICAgbGVhdmUgaXQgb24gc3RkZXJyIOKAlCB0aGUgZGVmZWN0LlxuICogICAgICDimpYgUHJlc2VuY2Ugc3BlbGxzIGtlZXAgcmV0cnlpbmcsIGFzIGJlZm9yZTogZ3JhcGV2aW5lJ3MgdGFpbCByZXNwYXduc1xuICogICAgICBpdHMgZGFlbW9uIGFuZCBhc3Ryb2xhYmUncyBgam9pbmAgd2FpdHMgZm9yIHRoZSBodW1hbiB0byByZW9wZW4gdGhlXG4gKiAgICAgIGJvYXJkLCBib3RoIGJ5IGRlc2lnbi4gVGhlaXIgZGlzY29ubmVjdCBub3RlcyBzdGF5IHdoZXJlIHRoZXkgd2VyZS5cbiAqXG4gKiBBMyDCtyBRVUlFVCBJUyBUSEUgVEFJTCdTIE9XTiBDT1VOVC4gYGV2ZW50c2AgY291bnRzIHRoZSBsb2cgZnJhbWVzIHRoaXNcbiAqICAgICAgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQuIFRoZSBncm91bmRpbmcgbGluZSwgYSBzcGVsbCdzIGBzdWJzY3JpYmVkYFxuICogICAgICBtYXJrZXIsIGBlcG9jaC5jaGFuZ2VkYCBhbmQgdGhlIGhhbmRvZmYgbGluZSBpdHNlbGYgYXJlIG5vdCBsb2cgZnJhbWVzXG4gKiAgICAgIGFuZCBhcmUgbm90IGNvdW50ZWQgKGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgc2VydmVyLXNlbnRcbiAqICAgICAgZ3JvdW5kaW5nIGZyYW1lKS4gQW55IGxvZyBmcmFtZSBjb3VudHMsIHRoZSBkYWVtb24ncyBgd2FpdGluZ2AgcmVtaW5kZXJcbiAqICAgICAgaW5jbHVkZWQsIHNvIFwicXVpZXRcIiBtZWFucyBub3RoaW5nIG9uIHRoZSBsb2cuXG4gKiAgICAgIOKaliBBIGZyYW1lIHRoZSB0YWlsJ3Mgb3duIGZpbHRlciByZWplY3RzIChib3VudHkncyBvd25lciBzY29wZSwgYVxuICogICAgICBzZWxmLWVjaG8pIGlzIE5PVCBjb3VudGVkIGFuZCBkb2VzIG5vdCBlbmQgYSBgLS1vbmNlYDogaXQgd2FzIG5ldmVyXG4gKiAgICAgIGRlbGl2ZXJlZCwgYW5kIHdha2luZyBvbiBpdCB3b3VsZCBiZSBhIHdha2Ugd2l0aCBub3RoaW5nIHRvIGFjdCBvbiDigJRcbiAqICAgICAgdGhlIGRlZmVjdCB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcmVtb3ZlLiBUaGUgY3Vyc29yIHN0aWxsIGFkdmFuY2VzXG4gKiAgICAgIHBhc3QgaXQgKHRhaWxFdmVudHMnIHJ1bGUpLCBzbyBpdCBuZXZlciByZXBsYXlzIGVpdGhlci5cbiAqICAgICAgQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTsgdGhhdCBoYWxmIGxpdmVzIGluIGVhY2hcbiAqICAgICAgc3BlbGwncyBgdGFpbGAsIHdoaWNoIGtub3dzIHdoZXRoZXIgYC0tc2luY2VgIHdhcyBnaXZlbi5cbiAqXG4gKiBBNCDCtyBUSEUgV0lORE9XLiBgREVGQVVMVF9XSU5ET1dfTVNgID0gdGhlIGNhcCBtaW51cyBgV0lORE9XX01BUkdJTl9NU2BcbiAqICAgICAgKDYwIHMpLCBzbyAxLDc0MCwwMDAgbXMuIFRoZSBtYXJnaW4gaGFzIHRvIGNvdmVyIHRoZSBnYXAgYmV0d2VlbiB0aGVcbiAqICAgICAgaGFybmVzcyBzdGFydGluZyBpdHMgY2xvY2sgYW5kIHRoaXMgcHJvY2VzcyBzdGFydGluZyBpdHMgb3duIChCdW5cbiAqICAgICAgc3RhcnQtdXAsIGEgc2Vzc2lvbiBsb29rdXAsIGEgZGFlbW9uIHNwYXduIG9uIHRoZSBzcGVsbHMgd2hvc2UgYHJlc29sdmVgXG4gKiAgICAgIHNwYXducyBvbmUg4oCUIGJvdW5kZWQgYnkgdGhlaXIgc3RhcnQgdGltZW91dHMsIHdoaWNoIGFyZSBzZWNvbmRzKSBwbHVzXG4gKiAgICAgIHRoZSBsYXN0IGxpbmUncyBmbHVzaCBhbmQgTW9uaXRvcidzIDIwMCBtcyBiYXRjaGluZy4gQSBtaW51dGUgY292ZXJzXG4gKiAgICAgIGFsbCBvZiB0aGF0IG1hbnkgdGltZXMgb3ZlciBhbmQgY29zdHMgMyUgb2YgdGhlIHdpbmRvdywgb25lIGV4dHJhXG4gKiAgICAgIHJlLWFybSBhYm91dCBldmVyeSAxNC41IGhvdXJzIG9mIGFjdGl2aXR5LiBUaGUgc3Bpa2UgbWVhc3VyZWQgYSAxMiBzXG4gKiAgICAgIHdpbmRvdyB1bmRlciBhIDIwIHMgY2FwIGVuZGluZyBjbGVhbmx5OyBub3RoaW5nIGhlcmUgZGVwZW5kcyBvbiBhXG4gKiAgICAgIG1hcmdpbiB0aGF0IHRpZ2h0LiBJZiB0aGUgY2FwIHdpbnMgYW55d2F5LCB0aGUgYWdlbnQgZ2V0cyBNb25pdG9yJ3NcbiAqICAgICAgYmFyZSBleHBpcnkgbm90aWNlIGFuZCByZS1hcm1zIHNpbGVudGx5IGZyb20gdGhlIGxhc3QgaWQgaXQgc2F3IOKAlCB0aGVcbiAqICAgICAgcnVsaW5nJ3MgZmFsbGJhY2ssIHN0YXRlZCBpbiBldmVyeSBza2lsbC5cbiAqICAgICAg4pqWIFRoZSB3aW5kb3cgaXMgaW5qZWN0YWJsZSBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiB0aHJvdWdoXG4gKiAgICAgIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNgIChhIGNvdW50IG9mIG1zOyBgMGAgdHVybnMgdGhlIHdpbmRvdyBvZmYsXG4gKiAgICAgIGZvciBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwpLiBBbiBlbnYgdmFyIGFuZCBub3QgYSBmbGFnOiBpdCBpc1xuICogICAgICBub3QgYW4gYWdlbnQncyBhY3QsIHNvIGl0IHN0YXlzIG91dCBvZiBlaWdodCB2ZXJicycgc2NoZW1hcy5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBSVU5OQUJMRSBBUyBQUklOVEVEOiBgYnVuIDx0aGlzIGNsaSdzIHBhdGg+IOKApmAsXG4gKiAgIHBpbm5lZCB0byB0aGUgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlXG4gKiAgIHNraWxscyBuYW1lIHRoZSBydWxlIG9uY2U7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogQ29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdyB0aGF0IG1ha2UgdGhlIGRhZW1vbiBcImxvc3RcIiAoc2VlIEEyKS4gVGhyZWVcbiAqICBzcGFuIGFib3V0IDAuNzUgcyB1bmRlciB0aGUga2l0J3MgZGVmYXVsdCBiYWNrb2ZmICgyNTAgKyA1MDAgbXMgYmV0d2VlblxuICogIHRoZW0pOiBhIGxpdmUgZGFlbW9uIG5ldmVyIHJlZnVzZXMgaXRzIG93biBwb3J0LCBhbmQgdGhlIHR3byBleHRyYSBhdHRlbXB0c1xuICogIG9ubHkgYnV5IHRvbGVyYW5jZSBmb3IgYSByZXN0YXJ0IHRoYXQgcmViaW5kcyB0aGUgc2FtZSBwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IExPU1RfQUZURVJfUkVGVVNBTFMgPSAzO1xuXG4vKiogVGhlIHdpbmRvdyBsZW5ndGg6IHRoZSBlbnYgdmFsdWUgd2hlbiBpdCBpcyBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyLCBlbHNlIHRoZVxuICogIGRlZmF1bHQuIGAwYCBtZWFucyBubyB3aW5kb3cuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVdpbmRvd01zKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdy50cmltKCkgPT09IFwiXCIpIHJldHVybiBERUZBVUxUX1dJTkRPV19NUztcbiAgY29uc3QgbiA9IE51bWJlcihyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzSW50ZWdlcihuKSAmJiBuID49IDAgPyBuIDogREVGQVVMVF9XSU5ET1dfTVM7XG59XG5cbmV4cG9ydCB0eXBlIFRhaWxNb2RlID0gXCJ3YXRjaFwiIHwgXCJvbmNlXCI7XG5cbi8qKiBIb3cgYSB0YWlsIGVuZGVkLiBgd2luZG93YCBpcyBvdXIgb3duIGRlYWRsaW5lLCBgZXZlbnRgIGlzIGEgYC0tb25jZWAnc1xuICogIGZpcnN0IGZyYW1lLCBgY2xvc2VkYCBpcyB0aGUgc2Vzc2lvbiBlbmRpbmcgKGEgYGNsb3NlZGAgZnJhbWUgb3IgdGhlIHBpbm5lZFxuICogIHNlc3Npb24ncyBwb2ludGVyIHZhbmlzaGluZyksIGBsb3N0YCBpcyB0aGUgZGFlbW9uIHJlZnVzaW5nIGNvbm5lY3Rpb25zLFxuICogIGFuZCBgc3RvcHBlZGAgaXMgYSBzaWduYWwsIGEgY2FsbGVyJ3MgYWJvcnQgb3IgYSBjbG9zZWQgc3Rkb3V0LiAqL1xuZXhwb3J0IHR5cGUgVGFpbEVuZCA9IFwid2luZG93XCIgfCBcImV2ZW50XCIgfCBcImNsb3NlZFwiIHwgXCJsb3N0XCIgfCBcInN0b3BwZWRcIjtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZklucHV0ID0ge1xuICBlbmQ6IFRhaWxFbmQ7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gKi9cbiAgdGFpbDogKG86IHsgc2luY2U6IG51bWJlcjsgb25jZTogYm9vbGVhbiB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICBldmVudHM6IG51bWJlcjtcbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBgbW9uaXRvcmA6IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggYGNvbW1hbmRgLlxuICAgKiAgYGJhY2tncm91bmRgOiBydW4gYGNvbW1hbmRgIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2suXG4gICAqICBgc3RvcGA6IG5vdGhpbmcgdG8gd2F0Y2g7IGBjb21tYW5kYCBpcyBob3cgdG8gY29tZSBiYWNrLCBpZiB3YW50ZWQuICovXG4gIG5leHQ6IFwibW9uaXRvclwiIHwgXCJiYWNrZ3JvdW5kXCIgfCBcInN0b3BcIjtcbiAgY29tbWFuZDogc3RyaW5nO1xuICBoaW50OiBzdHJpbmc7XG59O1xuXG4vKipcbiAqIFRIRSBERUNJU0lPTjogZ2l2ZW4gaG93IHRoZSB0YWlsIGVuZGVkLCB3aGljaCBsaW5lIGl0IHByaW50cy4gUHVyZSwgc28gZXZlcnlcbiAqIHN0YXRlIGlzIGEgbGl0ZXJhbCBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4gUmV0dXJucyBudWxsIGZvciBgc3RvcHBlZGA6XG4gKiBhIGh1bWFuJ3MgQ3RybC1DIG9yIGEgY2FsbGVyJ3MgYWJvcnQgaXMgbm90IGEgaGFuZG9mZi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhbmRvZmYoczogSGFuZG9mZklucHV0LCBjbWQ6IEhhbmRvZmZDb21tYW5kcyk6IEhhbmRvZmZMaW5lIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSB7IGV2ZW50czogcy5ldmVudHMsIGN1cnNvcjogcy5jdXJzb3IgfTtcbiAgc3dpdGNoIChzLmVuZCkge1xuICAgIGNhc2UgXCJzdG9wcGVkXCI6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBjYXNlIFwiY2xvc2VkXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwuY2xvc2VkXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC4gVG8gYnJpbmcgaXQgYmFjaywgcnVuIGNvbW1hbmRcIixcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogXCJsb3N0IHRoZSBkYWVtb24gKGl0IGNyYXNoZWQgb3Igd2FzIGtpbGxlZCk7IG5vdGhpbmcgaXMgbGlzdGVuaW5nLiBUbyBjb21lIGJhY2ssIHJ1biBjb21tYW5kXCIsXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSB9KSxcbiAgICAgICAgaGludDogXCJoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggY29tbWFuZFwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IGZhbHNlIH0pLFxuICAgICAgICAgIGhpbnQ6IFwidGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCBjb21tYW5kXCIsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlIH0pLFxuICAgICAgICBoaW50OiBcIm5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuIGNvbW1hbmQgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpIOKAlCBpdCBleGl0cyBvbiB0aGUgbmV4dCBldmVudFwiLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2hlbGxRdW90ZShhcmc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltBLVphLXowLTlfQCUrPTosLi8tXSskLy50ZXN0KGFyZykgPyBhcmcgOiBgJyR7YXJnLnJlcGxhY2VBbGwoXCInXCIsIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogSG93IFRISVMgcHJvY2VzcyB3YXMgaW52b2tlZCwgYXMgdGhlIGhlYWQgb2YgYSBjb21tYW5kIHRoYXQgcnVucyBpdCBhZ2FpbjpcbiAqICBgYnVuIDx0aGUgbGF1bmNoZXIncyBmdWxsIHBhdGg+YC4gQnVuIGhhbmRzIGBhcmd2WzFdYCBvdmVyIGFzIGEgZnVsbCBwYXRoLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlbGZDb21tYW5kKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcImJ1blwiLCBwcm9jZXNzLmFyZ3ZbMV0gPz8gXCJjbGkudHNcIl07XG59XG5cbi8qKiBUaGUgcmUtYXJtIGZvciBhIHNwZWxsIHdob3NlIHRhaWwgaXMgYDxwcmVmaXjigKY+IC0tc2luY2UgTiBbLS1vbmNlXWAuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQocHJlZml4OiByZWFkb25seSBzdHJpbmdbXSwgc2luY2U6IG51bWJlciwgb25jZTogYm9vbGVhbik6IHN0cmluZyB7XG4gIC8vIOKaoCBBIG5lZ2F0aXZlIGJvb2ttYXJrIChub3RoaW5nIHNlZW4geWV0KSBpcyBzcGVsbGVkIGAtLXNpbmNlPS0xYDogdGhlXG4gIC8vIHBhcnNlcnMgcmVhZCBhIGJhcmUgYC0xYCBhZnRlciBhIGZsYWcgYXMgYW5vdGhlciBmbGFnIGFuZCByZWZ1c2UgaXQuXG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7c2luY2V9YF0gOiBbXCItLXNpbmNlXCIsIFN0cmluZyhzaW5jZSldO1xuICByZXR1cm4gY29tbWFuZExpbmUoWy4uLnByZWZpeCwgLi4uYXQsIC4uLihvbmNlID8gW1wiLS1vbmNlXCJdIDogW10pXSk7XG59XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZPcHRpb25zPEV2PiA9IHtcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgY29tbWFuZHM6IEhhbmRvZmZDb21tYW5kcztcbn07XG5cbi8qKlxuICogUnVuIGB0YWlsRXZlbnRzYCB3aXRoIHRoZSBoYW5kb2ZmOiB0aGUgd2luZG93LCBgLS1vbmNlYCwgdGhlIGxvc3QgcnVsZSwgYW5kXG4gKiB0aGUgZmluYWwgbGluZS4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLCBsaWtlIGB0YWlsRXZlbnRzYCwgYW5kIG5ldmVyIGV4aXRzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbFdpdGhIYW5kb2ZmPEV2PihcbiAgdGFpbDogVGFpbE9wdGlvbnM8RXY+LFxuICBoOiBIYW5kb2ZmT3B0aW9uczxFdj4sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSB0YWlsLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3Qgd2luZG93TXMgPSBoLndpbmRvd01zID8/IHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSk7XG4gIGNvbnN0IGNvdW50cyA9IGguY291bnRzID8/ICgoKSA9PiB0cnVlKTtcbiAgY29uc3QgZW5kT25Mb3N0ID0gIWgucHJlc2VuY2U7XG5cbiAgY29uc3QgYWMgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBhYy5hYm9ydCgpO1xuICB0YWlsLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAodGFpbC5zaWduYWw/LmFib3J0ZWQpIGFjLmFib3J0KCk7XG5cbiAgbGV0IGV2ZW50cyA9IDA7XG4gIGxldCBjdXJzb3IgPSB0YWlsLnNpbmNlO1xuICBsZXQgZW5kOiBUYWlsRW5kIHwgbnVsbCA9IG51bGw7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gQSBwaW5uZWQgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nIGFmdGVyIHdlIGhhZCBpdDogaXQgY2xvc2VkLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgcy5ldmVyUmVzb2x2ZWQgJiYgZW5kID09PSBudWxsKSBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgY291bnRzKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaC5tb2RlID09PSBcIm9uY2VcIiAmJiBhY2NlcHRlZCAmJiBjb3VudHMoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7IGVuZDogZW5kID8/IFwic3RvcHBlZFwiLCBtb2RlOiBoLm1vZGUsIGV2ZW50cywgY3Vyc29yLCBwcmVzZW5jZTogaC5wcmVzZW5jZSB9LFxuICAgICAgaC5jb21tYW5kcyxcbiAgICApO1xuICAgIGlmIChsaW5lICE9PSBudWxsKSBvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkobGluZSl9XFxuYCk7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHRhaWwuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEdyYXBldmluZSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgb2YgdGhlIHNwZWxsLCBhbmQgVEhFIE9ORSBQTEFDRSBUSEUgRU5WIElTIFJFQUQuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTSwgQU5EIEZPUiBHUkFQRVZJTkUgVEhFIFNFQU0gSVMgUkVBTCDigJQgdGhlIGZpcnN0IHRpbWVcbiAqIGluIGZvdXIgcG9ydHMgKHBsYXlib29rIEI4LCBlbnRyeS1ibG9jayBxdWVzdGlvbiAzKS4gQmVmb3JlIFBoYXNlIDYgdGhlXG4gKiBoZWFydGJlYXQgd2FzIGEgTElURVJBTCBgMzAwMGAgaW5zaWRlIGBkYWVtb24udHNgJ3MgU1NFIHN0cmVhbSwgYGlkbGVUaW1lb3V0OlxuICogMjU1YCB3YXMgYSBzZWNvbmQgbGl0ZXJhbCB0ZW4gbGluZXMgYXdheSB3aXRoIHRoZSByZWxhdGlvbnNoaXAgd3JpdHRlbiBvbmx5IGluXG4gKiBwcm9zZSwgYW5kIGBjbGkudHNgJ3MgdGFpbCBoYWQgTk8gd2F0Y2hkb2cgYXQgYWxsIOKAlCBpdCBibG9ja2VkIG9uXG4gKiBgcmVhZGVyLnJlYWQoKWAgZm9yZXZlciwgd2hpY2ggaXMgdGhlIGZhaWx1cmUgdGhlIGtpdCdzIHdhdGNoZG9nIGV4aXN0cyB0b1xuICogZW5kLiBOZWl0aGVyIGZpbGUgY291bGQgaW1wb3J0IHRoZSBvdGhlcjogdGhlIENMSSByZWFjaGluZyBpbnRvIHRoZSBkYWVtb25cbiAqIHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIEEgbW9kdWxlIHdpdGggbm8gaW1wb3J0c1xuICogYnV0IHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaCBncmFwaCwgc28gYm90aCBoYWx2ZXMgaW1wb3J0IHRoaXMgb25lLlxuICogQSB2YWx1ZSB0aGF0IGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICpcbiAqIOKblCAqKkFORCBUSEUgV0FUQ0hET0cgSVMgREVSSVZFRCBGUk9NIEdSQVBFVklORSdTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyB0aGUgcnVsZSBhc3Ryb2xhYmUgcGFpZCBmb3I6IGEgaGFyZC1jb2RlZCA0NSBzXG4gKiB3YXRjaGRvZyBhZ2FpbnN0IGFuIGVudi10dW5lZCBoZWFydGJlYXQgcHJvZHVjZWQgcmVjb25uZWN0cyBhdCArNDcuNCBzLFxuICogKzkyLjYgcyBhbmQgKzEzNy45IHMgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbiwgaGFybWxlc3Mgb25seSBiZWNhdXNlXG4gKiBhbiB1bnJlbGF0ZWQgdGhpcmQgY29uc3RhbnQgYWJzb3JiZWQgdGhlIGNodXJuLiDimqAgR3JhcGV2aW5lIGlzIHRoZSBzcGVsbCB0aGF0XG4gKiBtYWtlcyB0aGUgcG9pbnQgc2hhcnBlc3Q6IGl0IGJlYXRzIGF0ICoqMyBzKiosIGEgZmlmdGggb2YgdGhlIGhvdXNlIGRlZmF1bHQsXG4gKiBzbyBhIGNvcGllZCA0NSwwMDAgd291bGQgdG9sZXJhdGUgRklGVEVFTiBtaXNzZWQgYmVhdHMgd2hlcmUgZXZlcnkgc2libGluZ1xuICogdG9sZXJhdGVzIHRocmVlLiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb20gdGhlIGJlYXQgaXRcbiAqIGlzIHdhdGNoaW5nLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKblCAqKkFORCBcIldIQVRFVkVSIFRIRSBCRUFUIEJFQ09NRVNcIiBJUyBXSFkgVEhFIEVOViBJUyBSRVNPTFZFRCBIRVJFIEFORFxuICogTk9XSEVSRSBFTFNFIChENzUpLiBUSEUgUE9SVCBSRS1DUkVBVEVEIEFTVFJPTEFCRSdTIERFRkVDVCBJTiBUSElTIEZJTEUuKipcbiAqIENoYXB0ZXIgMiBzaGlwcGVkIGBIRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhwcm9jZXNzLmVudi5HUkFQRVZJTkVfSEVBUlRCRUFUX01TLFxuICog4oCmKWAgYXQgYGRhZW1vbi50czoxMTJgIHdoaWxlIHRoaXMgZmlsZSBrZXB0IGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYFxuICogYWdhaW5zdCB0aGUgTElURVJBTCAzLDAwMDogdGhlIGRhZW1vbidzIGJlYXQgd2FzIHR1bmFibGUgYW5kIHRoZSBDTEknc1xuICogd2F0Y2hkb2cgd2FzIG5vdCwgc28gKiphbnkgdmFsdWUgYWJvdmUgMywwMDAgYnJva2UgZXZlcnkgdGFpbC4qKiBNRUFTVVJFRCBhdFxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MjAwMDBgIGFnYWluc3QgYSBoZWFsdGh5IGRhZW1vbiwgYmVmb3JlIHRoZSByZXBhaXI6IGFcbiAqIHJlYWwgYGNsaS50cyB0YWlsYCByZS1zdWJzY3JpYmVkICoqNCB0aW1lcyBpbiAzMCBzKiogKH45IHMgYXBhcnQsIGl0cyB3YXRjaGRvZ1xuICogZmlyaW5nIGJlZm9yZSBhIHNpbmdsZSAyMCBzIGJlYXQgY291bGQgbGFuZCDigJQgKiowIGtlZXBhbGl2ZXMgYXJyaXZlZCoqKSwgYW5kXG4gKiBgL2NoYW5uZWxzL3dkL3N1YnNjcmliZXJzYCByZXBvcnRlZCBgY291bnQ6IDIsIGNvbm5lY3Rpb25zOiAyLCBuYW1lZDogMmAgZm9yXG4gKiAqKm9uZSoqIGxpdmUgdGFpbCwgYmVjYXVzZSB0aGUgYWJhbmRvbmVkIHN0cmVhbXMgYXJlIG5vdCByZWFwZWQgdW50aWwgdGhlXG4gKiBub3ctMjAgcyBiZWF0IGZhaWxzIHRvIGVucXVldWUuIFRoYXQgaXMgdGhlIGFzdHJvbGFiZSBzY2FyIHR3byBwYXJhZ3JhcGhzIHVwLFxuICogcmUtY3JlYXRlZCBpbnNpZGUgdGhlIGZpbGUgdGhhdCBkb2N1bWVudHMgaXQuICoqT25lIGhhbGYgb2YgdGhlIHBhaXIgdHVuYWJsZVxuICogYW5kIHRoZSBvdGhlciBhIGNvbnN0YW50IElTIHRoZSBkZWZlY3QqKiDigJQgdGhlIGRlcml2YXRpb24gb25seSBob2xkcyBpZiBpdFxuICogZGVyaXZlcyBmcm9tIHRoZSB2YWx1ZSB0aGF0IGFjdHVhbGx5IHNoaXBwZWQuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICogYHByb2Nlc3MuZW52YCBpcyBub3Qgc3VjaCBhbiBpbXBvcnQ6IGl0IGlzIGFtYmllbnQgaW4gYm90aCBoYWx2ZXMsIHdoaWNoIGlzXG4gKiBleGFjdGx5IHdoeSB0aGlzIGZpbGUg4oCUIGFuZCBub3QgYGRhZW1vbi50c2Ag4oCUIGNhbiBob2xkIHRoZSByZXNvbHV0aW9uLiAoVGhpc1xuICogaXMgYm91bnR5J3Mgc2hhcGUsIHVuY2hhbmdlZDogYHNyYy9ib3VudHkvYmFja2VuZC9oZWFydGJlYXQudHNgIHJlc29sdmVzXG4gKiBgQk9VTlRZX0lETEVfVElNRU9VVF9TRUNgIGFuZCBgQk9VTlRZX0hFQVJUQkVBVF9NU2AgaW4gdGhlIHNlYW0gZmlsZSBmb3IgdGhlXG4gKiBzYW1lIHJlYXNvbi4pXG4gKi9cblxuaW1wb3J0IHtcbiAgaGVhcnRiZWF0TXMsXG4gIGlkbGVUaW1lb3V0U2VjLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEJ1bidzIG1heGltdW0sIGluIHNlY29uZHMuIEdyYXBldmluZSdzIG93biBtZWFzdXJlZCB2YWx1ZSwgbm90IGFuIGluaGVyaXRlZFxuICogb25lOiBgZGFlbW9uLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB1bmRlciBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXRcbiAqIEJ1bidzIGRlZmF1bHQgMTAgcyBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZSB0aGUga2VlcGFsaXZlIHRoYXQgd2FzXG4gKiBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzIOKAlCBhbmQgdGhhdCBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiwgaXQgaXMgdGhlXG4gKiBkZWZhdWx0LlxuICpcbiAqIOKaoCBgR1JBUEVWSU5FX0lETEVfVElNRU9VVF9TRUNgIGlzIGFjY2VwdGVkIHNvIHRoZSBQQUlSIGNhbiBiZSB0dW5lZCB0b2dldGhlcixcbiAqIGFuZCB0aGUgY2xhbXAgYmVsb3cgaXMgd2hhdCBrZWVwcyB0aGVtIGEgcGFpci4gKFRoaXMgZmlsZSB1c2VkIHRvIHNheVxuICogZ3JhcGV2aW5lIFwiZG9lcyBub3QgZW52LXR1bmUgaXRcIiB3aGlsZSBgZGFlbW9uLnRzYCBlbnYtdHVuZWQgaXQgdGVuIGxpbmVzIGZyb21cbiAqIHdoZXJlIGl0IGltcG9ydGVkIHRoaXMgY29uc3RhbnQg4oCUIHRoZSBzYW1lIG9uZS1oYWxmLXR1bmFibGUgc3BsaXQgYXMgdGhlIGJlYXQsXG4gKiBhbmQgY29ycmVjdGVkIGluIHRoZSBzYW1lIGNoYXB0ZXIuKVxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSURMRV9USU1FT1VUX1NFQyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4pO1xuXG4vKipcbiAqIFRoZSBTU0Uga2VlcGFsaXZlLCBpbiBtcyDigJQgdGhlIERFRkFVTFQsIGJlZm9yZSB0aGUgZW52IGlzIGNvbnN1bHRlZC5cbiAqIOKaoCAqKjMgcywgYW5kIGl0IGlzIE5PVCB0aGUgaG91c2UgZGVmYXVsdCBvZiAxNSBzKiog4oCUIGdyYXBldmluZSBpcyB0aGUgb25seVxuICogc3BlbGwgaW4gdGhlIHJvc3RlciB0aGF0IGJlYXRzIHRoaXMgZmFzdCwgYW5kIHRoZSBudW1iZXIgaXMgbG9hZC1iZWFyaW5nXG4gKiByYXRoZXIgdGhhbiBpbmNpZGVudGFsOiB0aGUgYmVhdCBpcyBhbHNvIGdyYXBldmluZSdzIGRlYWQtc3Vic2NyaWJlciBwcm9iZS4gQVxuICogdGFpbCB3aG9zZSBzb2NrZXQgaGFzIGdvbmUgYXdheSBpcyBkaXNjb3ZlcmVkIHdoZW4gdGhlIGVucXVldWUgZmFpbHMsIGFuZFxuICogdW50aWwgaXQgaXMgZGlzY292ZXJlZCBgd2hvYCwgYC9wcmVzZW5jZWAgYW5kIGV2ZXJ5IHNlbmQncyByZWNpcGllbnQgY291bnRcbiAqIHJlcG9ydCBhIGdob3N0LiBFdmVyeSBvdGhlciBzcGVsbCdzIGhlYXJ0YmVhdCBvbmx5IGhhcyB0byBrZWVwIGEgY29ubmVjdGlvblxuICogb3BlbjsgdGhpcyBvbmUgYWxzbyBoYXMgdG8ga2VlcCBhIFJPU1RFUiBob25lc3QsIHdoaWNoIGlzIGEgaHVtYW4tdmlzaWJsZVxuICogbnVtYmVyIGluIHRoZSB3YXRjaCBzdXJmYWNlLiDim5QgKipTbyByYWlzaW5nIHRoaXMga25vYiBtYWtlcyBwcmVzZW5jZVxuICogc3RhbGVyLCBub3QganVzdCBxdWlldGVyKiog4oCUIGl0IGlzIHRoZSBvbmUgdGhpbmcgYW4gb3BlcmF0b3IgdHVuaW5nIGl0IHNob3VsZFxuICoga25vdy5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyA9IDNfMDAwO1xuXG4vKipcbiAqIFRoZSBiZWF0IGFzIGl0IHdpbGwgYWN0dWFsbHkgYmUgdXNlZCwgZW52LXJlc29sdmVkIGFuZCBjbGFtcGVkIGF0IGJvdGggZW5kcyBieVxuICogdGhlIGtpdDogbmV2ZXIgYWJvdmUgYElETEVfVElNRU9VVF9TRUMgLyAyYCAob3IgQnVuIGNsb3NlcyB0aGUgY29ubmVjdGlvbiB0aGVcbiAqIGtlZXBhbGl2ZSB3YXMgcHJlc2VydmluZyksIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiDim5QgVEhFIEZMT09SIElTIE5PVCBERUNPUkFUSU9OIChENzYpLiBgaW50T3JgIHBhcnNlcyB3aXRoIGBwYXJzZUludGAsIHdoaWNoXG4gKiByZWFkcyBgXCIxZTlcImAg4oCUIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXQgaHVnZVwiIOKAlCBhcyAqKjEqKi5cbiAqIERyaXZlbiBiZWZvcmUgdGhlIGZsb29yIGV4aXN0ZWQ6IGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41MjhcbiAqIGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCDihpIgMyBtcyBhbmRcbiAqIGBcIjVhYmNcImAg4oaSIDUgbXMgYXJyaXZlIHRoZSBzYW1lIHdheS4gVGhlIGZsb29yIGxpdmVzIGluIHRoZSBraXQnc1xuICogYGhlYXJ0YmVhdE1zYCBiZXNpZGUgdGhlIGNlaWxpbmcgaXQgY2Fubm90IGNyb3NzLCBOT1QgaW4gYGludE9yYCwgd2hpY2ggZXZlcnlcbiAqIG90aGVyIGtub2IgaW4gdGhlIGhvdXNlIHNoYXJlcy5cbiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hFQVJUQkVBVF9NUyxcbiAgSURMRV9USU1FT1VUX1NFQyxcbiAgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TLFxuKTtcblxuLyoqXG4gKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzLCBERVJJVkVELiA5LDAwMCBtcyBhdCB0aGUgZGVmYXVsdC5cbiAqXG4gKiDim5QgKipUSEUgVEFJTCBIQUQgTk8gV0FUQ0hET0cgQVQgQUxMIEJFRk9SRSBUSElTLioqIGBjbWRUYWlsYCdzIGlubmVyIGxvb3BcbiAqIGF3YWl0ZWQgYHJlYWRlci5yZWFkKClgIHdpdGggbm90aGluZyBib3VuZGluZyBpdCwgc28gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyXG4gKiBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIEZPUkVWRVIg4oCUIGFuZFxuICogYSBwYXJrZWQgdGFpbCBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgcXVpZXQgY2hhbm5lbCwgd2hpY2ggaXMgdGhlIHN0YXRlXG4gKiBncmFwZXZpbmUncyBjYWxsZXJzIHNwZW5kIG1vc3Qgb2YgdGhlaXIgdGltZSBpbi5cbiAqXG4gKiDimqAgOSBzIGlzIGFnZ3Jlc3NpdmUgYnkgaG91c2Ugc3RhbmRhcmRzICg0NSBzIGV2ZXJ5d2hlcmUgZWxzZSkgYW5kIHRoYXQgaXMgdGhlXG4gKiBkZXJpdmF0aW9uIHdvcmtpbmcsIG5vdCBhIG1pc3Rha2U6IGl0IGlzIHRocmVlIG9mIFRISVMgc3BlbGwncyBiZWF0cy4gSG9sZGluZ1xuICogdGhlIGNvbm5lY3Rpb24gb3BlbiBJUyBhIHRhaWwncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHNcbiAqIGEgbmFtZSBpbiBhIGh1bWFuJ3Mgcm9zdGVyIOKAlCB3aGljaCBpcyB3aHkgaXQgaXMgdGhyZWUgYmVhdHMgYW5kIG5vdCB0d28uXG4gKlxuICog4puUIERFUklWRUQgRlJPTSBUSEUgUkVTT0xWRUQgQkVBVCwgTkVWRVIgRlJPTSBUSEUgREVGQVVMVC4gSXQgaXNcbiAqIGBTU0VfSEVBUlRCRUFUX01TYCBhYm92ZSBhbmQgbm90IGBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVNgIG9uIHB1cnBvc2U7IHRoZVxuICogcmVwYWlyIGNoYXB0ZXIgaXMgd2hhdCB0aGUgZGlmZmVyZW5jZSBjb3N0LlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFpQkE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBUUE7QUFDQTtBQUNBO0FBQ0Esc0JBQVM7OztBQ3dCRixJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMs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QSxJQUNWLElBQUksRUFBRSxhQUFhO0FBQUEsTUFBYSxNQUFNO0FBQUEsSUFDdEMsS0FBSSxFQUFFLFNBQVMsU0FBUyxFQUFFLEtBQUs7QUFBQTtBQUFBLEVBT2pDLE1BQU0sV0FBVyxLQUFLLFlBQVksT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUU7QUFBQSxFQUM1RCxNQUFNLFdBQVcsS0FBSyxZQUFZLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUTtBQUFBLEVBQ3hELElBQUksV0FBVyxTQUFTLFVBQVU7QUFBQSxJQUNoQyxNQUFNLFVBQVUsS0FBSyxZQUFZLFdBQVc7QUFBQSxJQUM1QyxLQUFJLEdBQUcsS0FBSywyQkFBMkIsU0FBUyxRQUFRLGVBQWUsU0FBUztBQUFBLE1BQzlFLE1BQU0sWUFBWSxLQUFLLFFBQVEsS0FBSyxZQUNqQyxJQUFJLENBQUMsTUFBTyxFQUFFLFdBQVcsSUFBSSxFQUFFLFVBQVUsSUFBSSxFQUFFLE9BQVEsRUFDdkQsS0FBSyxHQUFHO0FBQUEsSUFDYixDQUFDO0FBQUEsRUFDSDtBQUFBLEVBQ0EsSUFBSSxDQUFDLFlBQVksV0FBVyxTQUFTLEtBQUssWUFBWSxRQUFRO0FBQUEsSUFDNUQsS0FDRSxHQUFHLEtBQUssNkJBQTZCLEtBQUssVUFBVSxXQUFXLEtBQUssWUFBWSxPQUFPLEtBQ3ZGLFNBQ0E7QUFBQSxNQUNFLE1BQU0sWUFBWSxLQUFLLFFBQ3JCLEtBQUssWUFBWSxJQUFJLENBQUMsTUFBTyxFQUFFLFdBQVcsSUFBSSxFQUFFLFVBQVUsSUFBSSxFQUFFLE9BQVEsRUFBRSxLQUFLLEdBQUcsS0FDbEY7QUFBQSxJQUVKLENBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxNQUFNLFVBQVUsTUFBTSxLQUFLLElBQUksWUFBWSxLQUFLO0FBQUEsRUFDaEQsT0FBTyxPQUFPLFlBQVksV0FBVyxVQUFVO0FBQUE7QUFrQmpELGVBQWUsSUFBSSxDQUFDLE1BQWlDO0FBQUEsRUFDbkQsa0JBQWtCLEtBQUssTUFBTSxJQUFJO0FBQUEsRUFDakMsSUFBSTtBQUFBLElBQ0YsT0FBTyxNQUFNLFNBQVMsSUFBSTtBQUFBLElBQzFCLE9BQU8sR0FBRztBQUFBLElBQ1YsTUFBTSxPQUFPLGVBQWUsQ0FBQztBQUFBLElBQzdCLElBQUksU0FBUztBQUFBLE1BQU0sT0FBTztBQUFBLElBQzFCLE1BQU07QUFBQTtBQUFBO0FBZVYsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiRDcyNDhDRTA4QjEzOTNFMjY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
