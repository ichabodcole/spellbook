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
    const lastId = filtered.length ? filtered[filtered.length - 1].id : 0;
    printJson({ ok: true, messages: filtered, cursor: lastId });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${since}`);
  if (status >= 400)
    dieApi(data, status);
  const rawMsgs = data?.messages ?? [];
  const cursor = rawMsgs.length ? rawMsgs[rawMsgs.length - 1].id : since;
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
  let grounded = false;
  return await tailEvents({
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
    cursorOf: (ev) => typeof ev.id === "number" ? ev.id : undefined,
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
    const head = m.text.split(`
`)[0];
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
      const m = line.match(/^\s*(\d+)\s+/);
      if (!m)
        continue;
      const pid = parseInt(m[1], 10);
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
    const m = Buffer.concat(chunks).toString("utf-8").match(/127\.0\.0\.1:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
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
      await cmdMark(positional[0], parseInt(positional[1], 10), positional.slice(2).join(" "), resolveAlias(flags) ?? identityRequired("mark"), { note: flags.note });
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
      await cmdMark(positional[0], parseInt(positional[1], 10), "open", resolveAlias(flags) ?? identityRequired("reopen"), { note: flags.note });
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

//# debugId=5F43C375DF8E8A2E64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2hlYXJ0YmVhdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gZ3JhcGV2aW5lIENMSSDigJQgdGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgZGFlbW9uJ3MgSFRUUCBzdXJmYWNlLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBidW4gY2xpLnRzIG9wZW4gPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgbGlzdFxuLy8gICBidW4gY2xpLnRzIHNlbmQgPG5hbWU+IC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIHRhaWwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XVxuLy8gICBidW4gY2xpLnRzIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF1cbi8vICAgYnVuIGNsaS50cyBjbG9zZSA8bmFtZT5cbi8vICAgYnVuIGNsaS50cyBzdG9wXG4vLyAgIGJ1biBjbGkudHMgaW5mb1xuLy9cbi8vIGB0YWlsYCB3cml0ZXMgZWFjaCBpbmNvbWluZyBtZXNzYWdlIGFzIG9uZSBKU09OTCBsaW5lIG9uIHN0ZG91dC4gUGlwZVxuLy8gb3Igd3JhcCB3aXRoIE1vbml0b3IuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICB1bmxpbmtTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQge1xuICB0eXBlIEVyckV4dHJhLFxuICB0eXBlIEVycktpbmQsXG4gIGRpZSBhcyByYWlzZSxcbiAgcmVwb3J0Q2xpRXJyb3IsXG4gIHNldEN1cnJlbnRDb21tYW5kLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzLnRzXCI7XG5pbXBvcnQgeyB0YWlsRXZlbnRzIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxFdmVudHMudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG5jb25zdCBEQVRBX0RJUiA9IHByb2Nlc3MuZW52LkdSQVBFVklORV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5ncmFwZXZpbmVcIik7XG5jb25zdCBQT1JUX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5waWRcIik7XG5jb25zdCBIT0xEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5ob2xkXCIpO1xuLy8gUGVyc2lzdGVkIGlkZW50aXR5IGNvbmZpZyAoVjEuNykg4oCUIGBncmFwZXZpbmUgYWxpYXMgPG5hbWU+YCB3cml0ZXMgaXQ7IHRoZVxuLy8gZGFlbW9uIHNlcnZlcyBpdCB0byB0aGUgd2F0Y2ggdmlhIEdFVCAvaWRlbnRpdHkuXG5jb25zdCBDT05GSUdfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiY29uZmlnLmpzb25cIik7XG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIE5FVkVSIEEgRkxBVCBTSUJMSU5HIChwbGF5Ym9vayBCNCkuIFRoaXMgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJkYWVtb24udHNcIilgIOKAlCBnbGFtb3VyJ3MgZXhhY3Qgc2hpcHBlZCBkZWZlY3Qg4oCUIHdoaWNoIHdhc1xuLy8gdHJ1ZSBmb3IgZXhhY3RseSBhcyBsb25nIGFzIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tXG4vLyBgZGlzdC9gIHRoYXQgcmVzb2x2ZXMgdG8gYGRpc3QvZGFlbW9uLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgYW5kIG11c3Qgbm90XG4vLyBleGlzdC4gVGhlIHN5bXB0b20gaXMgbm90IGEgY3Jhc2g6IHRoZSBzcGF3biBmYWlscyBzaWxlbnRseSAodGhlIGRhZW1vbidzXG4vLyBzdGRpbyBpcyBpZ25vcmVkKSwgbm8gcG9ydCBmaWxlIGV2ZXIgYXBwZWFycywgYW5kIHRoZSAzIHMgcG9sbCBsb29wIGJlbG93XG4vLyByZXBvcnRzIGBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc2Ag4oCUIHdoaWNoIGlzIEFMU08gd2hhdCBhIGxhdW5jaGVyXG4vLyB0aGF0IGV4aXRzIGEgbGl2ZSBkYWVtb24gcmVwb3J0cyAoRDY5KSBhbmQgQUxTTyB3aGF0IGEgZGV2LW1vZGUgZGFlbW9uIGR5aW5nXG4vLyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQgcmVwb3J0cyAoc2VlIGBlbnN1cmVEYWVtb25gKS4gVGhyZWUgZGVmZWN0IGNsYXNzZXMsIG9uZVxuLy8gc2VudGVuY2U7IHRoaXMgaXMgdGhlIGZpcnN0IG9mIHRoZSB0aHJlZS5cbi8vIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgcmVzb2x2ZXMgdGhpcyBhcml0aG1ldGljIHRoZSB3YXkgdGhlXG4vLyBydW50aW1lIHdpbGwsIGZyb20gdGhlIEVNSVRURUQgZmlsZSdzIG93biBkaXJlY3RvcnksIGFuZCBhc3NlcnRzIHRoZSBmaWxlIGlzXG4vLyB0aGVyZS5cbmNvbnN0IERBRU1PTl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwiZGFlbW9uLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBUaGUgd2F0Y2ggc3VyZmFjZSBpcyBidWlsdCAoc3JjL2dyYXBldmluZS9zdXJmYWNlIOKGkiBkaXN0LykuIEJ1biByZWFkc1xuLy8gYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIGluIERFViBtb2RlIHRoZSBkYWVtb24nc1xuLy8gY3dkIE1VU1QgYmUgc3JjL2dyYXBldmluZS8gKHNlYW1zIENvbnRyYWN0IDUpIOKAlCBsYXVuY2hlZCBlbHNld2hlcmUgdGhlIGRldlxuLy8gYnVuZGxlciBjYW5ub3QgY29tcGlsZSB0aGUgc3R5bGVzaGVldCBhbmQgdGhlIHBhZ2UgZmFpbHMgKG1lYXN1cmVkIG9uXG4vLyBnbGFtb3VyOiBIVFRQIDUwMCwgbm8gc3R5bGVzaGVldCBsaW5rKS4gSW4gUkVMRUFTRSBtb2RlIGRpc3QvIGlzIHN0YXRpYyBhbmRcbi8vIHByZS1idWlsdCwgbm8gYnVuZmlnIGlzIHJlYWQsIGFuZCBzcmMvZ3JhcGV2aW5lLyBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLykg4oCUIHNvIHRoZSBjd2Qgc3RheXMgYXRcbi8vIHRoZSBza2lsbCByb290LiBTYW1lIHNoYXBlIGFzIGdsYW1vdXIncyBkYWVtb25Dd2QoKS4gRXhwb3J0ZWQgZm9yIHRlc3RzLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcImdyYXBldmluZVwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vLyDilIDilIAgRGFlbW9uIEhUVFAgcHJvdG9jb2wg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBSZXNwb25zZSBzaGFwZXMgdGhlIGRhZW1vbiBlbWl0cy4gQW55IGVuZHBvaW50IGNhbiBhbHNvIHJldHVybiBhbiBlcnJvclxuLy8gYm9keSB3aXRoIGEgNHh4LzV4eCBzdGF0dXMsIHNvIGVhY2ggY2FycmllcyBhbiBvcHRpb25hbCBgZXJyb3JgLlxuXG50eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBudW1iZXI7XG4gIGNoYW5uZWw6IHN0cmluZztcbiAgZnJvbTogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIGtpbmQ6IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIGluX3JlcGx5X3RvPzogbnVtYmVyO1xuICB0YXJnZXQ/OiBudW1iZXI7XG4gIGRpc3Bvc2l0aW9uPzogc3RyaW5nO1xuICAvLyBDaGFubmVsLWxldmVsIGxpZmVjeWNsZSBmYWN0IChhcmNoaXZlIC8gdW5hcmNoaXZlKS4gQSBraW5kOlwic3RhdHVzXCIgZnJhbWVcbiAgLy8gY2FycnlpbmcgYGV2ZW50YCBhbmQgbm8gYGRpc3Bvc2l0aW9uYCDigJQgc2VlIGlzRGlzcG9zaXRpb25GcmFtZS5cbiAgZXZlbnQ/OiBcImFyY2hpdmVkXCIgfCBcInVuYXJjaGl2ZWRcIjtcbn07XG5cbi8vIEdFVCAvIOKAlCBkYWVtb24gbGl2ZW5lc3MvaW5mby5cbnR5cGUgUm9vdEluZm8gPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgcGlkPzogbnVtYmVyO1xuICBzdGFydGVkX2F0PzogbnVtYmVyO1xuICBjaGFubmVscz86IG51bWJlcjtcbiAgZGF0YV9kaXI/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyDigJQgbWVzc2FnZSByZWNlaXB0IHdpdGggZGVsaXZlcnkgYWNjb3VudGluZy5cbnR5cGUgU2VuZFJlY2VpcHQgPSBNZXNzYWdlICYge1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgcmVjaXBpZW50cz86IG51bWJlcjtcbiAgc3Vic2NyaWJlcl9hbGlhc2VzPzogc3RyaW5nW107XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvYW5ub3VuY2Ug4oCUIGNyb3NzLWNoYW5uZWwgYnJvYWRjYXN0IHJlY2VpcHQuXG50eXBlIEFubm91bmNlUmVjZWlwdCA9IHtcbiAgb2s6IGJvb2xlYW47XG4gIGNoYW5uZWxzOiB7IG5hbWU6IHN0cmluZzsgcmVjaXBpZW50czogbnVtYmVyIH1bXTtcbiAgc2tpcHBlZDogeyBuYW1lOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH1bXTtcbiAgdG90YWxfcmVjaXBpZW50czogbnVtYmVyO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMg4oCUIGNoYW5uZWwgZGlyZWN0b3J5IGxpc3RpbmcuXG50eXBlIENoYW5uZWxTdW1tYXJ5ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gIC8vIG51bGwgPSB0aGUgZGFlbW9uIGNvdWxkIG5vdCBlc3RhYmxpc2ggYSBjb3VudCAodW5yZWFkYWJsZSBmaWxlKSwgTkVWRVIgMC5cbiAgLy8gMCBtZWFucyBcInRoaXMgY2hhbm5lbCBpcyBnZW51aW5lbHkgZW1wdHlcIiBhbmQgbm90aGluZyBlbHNlIOKAlCBiNS5cbiAgbWVzc2FnZV9jb3VudDogbnVtYmVyIHwgbnVsbDtcbiAgbGFzdF9hY3Rpdml0eTogbnVtYmVyO1xuICBsb2FkZWQ6IGJvb2xlYW47XG59O1xudHlwZSBDaGFubmVsc1Jlc3BvbnNlID0geyBjaGFubmVscz86IENoYW5uZWxTdW1tYXJ5W107IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEFueSBlbmRwb2ludCBtYXkgcmVwbHkgd2l0aCBqdXN0IGFuIGVycm9yL29rIGVudmVsb3BlLlxudHlwZSBTdGF0dXNSZXNwb25zZSA9IHsgb2s/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyBhbmQgP3NpbmNlPSByYW5nZXMuXG50eXBlIE1lc3NhZ2VzUmVzcG9uc2UgPSB7IG1lc3NhZ2VzPzogTWVzc2FnZVtdOyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi93YWl0IOKAlCBsb25nLXBvbGwgYmF0Y2guXG50eXBlIFdhaXRSZXNwb25zZSA9IHtcbiAgbWVzc2FnZXM/OiBNZXNzYWdlW107XG4gIGN1cnNvcj86IG51bWJlcjtcbiAgdGltZWRfb3V0PzogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIC8vIEEgcmVmdXNhbCBuYW1lcyB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoNDA0IG9uIGEgbWlzc2luZyBjaGFubmVsKS5cbiAgaGludD86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzIOKAlCBvcGVuL2Vuc3VyZSBhIGNoYW5uZWwuXG50eXBlIE9wZW5SZXNwb25zZSA9IHtcbiAgbmFtZT86IHN0cmluZztcbiAgY3JlYXRlZF9hdD86IG51bWJlcjtcbiAgbWVzc2FnZV9jb3VudD86IG51bWJlcjtcbiAgc3Vic2NyaWJlcnM/OiBudW1iZXI7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgdW5hcmNoaXZlZD86IGJvb2xlYW47XG4gIGNsZWFyZWQ/OiBib29sZWFuO1xuICBzbmFwc2hvdD86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vdG9waWMgYW5kIFBVVCAvY2hhbm5lbHMvPG5hbWU+L3RvcGljLlxudHlwZSBUb3BpY1Jlc3BvbnNlID0ge1xuICBvaz86IGJvb2xlYW47XG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgaWQ/OiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vc3Vic2NyaWJlcnMg4oCUIHNpbmdsZS1jaGFubmVsIHJvc3Rlci5cbnR5cGUgU3Vic2NyaWJlcnNSZXNwb25zZSA9IHtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgc3Vic2NyaWJlcnM/OiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvdW50PzogbnVtYmVyO1xuICBjb25uZWN0aW9ucz86IG51bWJlcjtcbiAgbmFtZWQ/OiBudW1iZXI7XG4gIGFub255bW91cz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBlci1jaGFubmVsIHByZXNlbmNlIGVudHJ5IGZyb20gR0VUIC9wcmVzZW5jZS5cbnR5cGUgUHJlc2VuY2VDaGFubmVsID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gIG5hbWVkOiBudW1iZXI7XG4gIGFub255bW91czogbnVtYmVyO1xufTtcbnR5cGUgUHJlc2VuY2VSZXNwb25zZSA9IHsgY2hhbm5lbHM/OiBQcmVzZW5jZUNoYW5uZWxbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gU1NFIGZyYW1lcyBwdXNoZWQgb24gR0VUIC9jaGFubmVscy88bmFtZT4vdGFpbC4gVHdvIGZyYW1lIGtpbmRzIGFycml2ZSBvblxuLy8gdGhlIHNhbWUgYGRhdGE6YCBsaW5lIOKAlCBhIGBzdWJzY3JpYmVkYCBldmVudCBhbmQgcGVyLW1lc3NhZ2UgZnJhbWVzIOKAlCBzbyB0aGVcbi8vIGRlY29kZWQgcGF5bG9hZCBpcyBhIHVuaW9uLiBBbGwgZmllbGRzIG9wdGlvbmFsIGJlY2F1c2UgdGhlIGZyYW1lIGlzXG4vLyB1bnRydXN0ZWQgd2lyZSBkYXRhIG5hcnJvd2VkIGF0IHRoZSB1c2Ugc2l0ZS5cbnR5cGUgVGFpbFBheWxvYWQgPSB7XG4gIC8vIHN1YnNjcmliZWQtZXZlbnQgZmllbGRzXG4gIHNpbmNlPzogbnVtYmVyO1xuICBhcz86IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdF9pZD86IG51bWJlcjtcbiAgLy8gVHJ1ZSB3aGVuIFRISVMgc3Vic2NyaWJlIGNyZWF0ZWQgdGhlIGNoYW5uZWwg4oCUIHRoZSBzaWduYWwgdGhhdCBzZXBhcmF0ZXNcbiAgLy8gXCJxdWlldCBjaGFubmVsXCIgZnJvbSBcInlvdSB0YWlsZWQgYSBuYW1lIHRoYXQgZGlkIG5vdCBleGlzdFwiLlxuICBjcmVhdGVkPzogYm9vbGVhbjtcbiAgLy8gVHJ1ZSB3aGVuIHRoZSBjaGFubmVsIGlzIGFscmVhZHkgYXJjaGl2ZWQgKHJlYWQtb25seSkgYXQgc3Vic2NyaWJlIHRpbWUg4oCUXG4gIC8vIHRoZSBzaWduYWwgZm9yIGEgTEFURSBqb2luZXIsIHdobyB3b3VsZCBvdGhlcndpc2UgbGVhcm4gaXQgZnJvbSBhIHJlamVjdGVkXG4gIC8vIHNlbmQuIFRoZSBsaWZlY3ljbGUgZnJhbWUgb25seSByZWFjaGVzIGFuIGFnZW50IHRoYXQgd2FzIGNvbm5lY3RlZCBhdCB0aGVcbiAgLy8gbW9tZW50LCBvciB0aGF0IHB1bGxzIGhpc3RvcnkuXG4gIGFyY2hpdmVkPzogYm9vbGVhbjtcbiAgLy8gbWVzc2FnZSBmaWVsZHNcbiAgaWQ/OiBudW1iZXI7XG4gIGZyb20/OiBzdHJpbmc7XG4gIHRleHQ/OiBzdHJpbmc7XG4gIHRzPzogbnVtYmVyO1xuICBraW5kPzogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgLy8gc2hhcmVkXG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIE91ciBwbHVnaW4gdmVyc2lvbiAoZnJvbSBwbHVnaW4uanNvbikuIFVzZWQgdG8gZGV0ZWN0IGNhY2hlLXBpbm5pbmdcbi8vIG1pc21hdGNoZXMgd2hlbiB3ZSB0YWxrIHRvIGEgZGFlbW9uIHNwYXduZWQgZnJvbSBhIGRpZmZlcmVudCBjYWNoZWRcbi8vIHBhdGguIEJlc3QtZWZmb3J0OyBudWxsIGlmIHJlYWQgZmFpbHMuXG5mdW5jdGlvbiByZWFkUGx1Z2luVmVyc2lvbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbHVnaW5Kc29uUGF0aCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwbHVnaW5Kc29uUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpLnZlcnNpb24gPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmNvbnN0IFBMVUdJTl9WRVJTSU9OID0gcmVhZFBsdWdpblZlcnNpb24oKTtcblxuLy8gT25lLXNob3QgdmVyc2lvbi1taXNtYXRjaCBjaGVjay4gVGhlIGRhZW1vbiBtYXkgYmUgZnJvbSBhIGRpZmZlcmVudFxuLy8gY2FjaGVkIHBsdWdpbiBwYXRoIHRoYW4gdGhpcyBDTEkgKGV4aXN0aW5nIHRhaWwgcHJvY2Vzc2VzJyBhdXRvLXJlY29ubmVjdFxuLy8gY2FuIHJhY2UgYSBgc3RvcGAgYW5kIHJlc3Bhd24gdGhlIG9sZCBkYWVtb24pLiBXYXJuIG9uY2UgcGVyIGludm9jYXRpb25cbi8vIHNvIHRoZSB1c2VyIGhhcyBhIHNpZ25hbCBpbnN0ZWFkIG9mIHNpbGVudGx5IGRlZ3JhZGVkIGJlaGF2aW9yLlxubGV0IF92ZXJzaW9uQ2hlY2tEb25lID0gZmFsc2U7XG5hc3luYyBmdW5jdGlvbiBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0OiBudW1iZXIpIHtcbiAgaWYgKF92ZXJzaW9uQ2hlY2tEb25lKSByZXR1cm47XG4gIF92ZXJzaW9uQ2hlY2tEb25lID0gdHJ1ZTtcbiAgaWYgKCFQTFVHSU5fVkVSU0lPTikgcmV0dXJuOyAvLyBjYW4ndCBjb21wYXJlIGlmIHdlIGRvbid0IGtub3cgb3VyIG93biB2ZXJzaW9uXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICB9KTtcbiAgICBpZiAoIXJlcy5vaykgcmV0dXJuO1xuICAgIGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gICAgY29uc3QgZGFlbW9uVmVyc2lvbiA9IGRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAoZGFlbW9uVmVyc2lvbiA9PT0gbnVsbCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIGlzIG9sZGVyIHRoYW4gdGhpcyBDTEkgKG5vIHZlcnNpb24gcmVwb3J0ZWQpLiBgICtcbiAgICAgICAgICBgQ0xJIGlzIHYke1BMVUdJTl9WRVJTSU9OfS4gU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gYCArXG4gICAgICAgICAgYFJlc3RhcnQgdGhlIGRhZW1vbiAoZHJvcCB0YWlscywgdGhlbiBcXGBzdG9wXFxgLCB0aGVuIGFueSB2ZXJiKSB0byB1cGdyYWRlLlxcbmAsXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZGFlbW9uVmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT04pIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBncmFwZXZpbmU6IGRhZW1vbiB2ZXJzaW9uICh2JHtkYWVtb25WZXJzaW9ufSkgZGlmZmVycyBmcm9tIENMSSB2ZXJzaW9uICh2JHtQTFVHSU5fVkVSU0lPTn0pLiBgICtcbiAgICAgICAgICBgU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduLlxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxufVxuLy8gR1JBUEVWSU5FX0ZST00gc2V0cyB0aGUgZGVmYXVsdCAtLWZyb20gLyAtLWFzIGFsaWFzIHNvIGFnZW50cyBkb24ndCBoYXZlXG4vLyB0byByZXBlYXQgdGhlaXIgaWRlbnRpdHkgb24gZXZlcnkgdmVyYi4gUGVyLXZlcmIgZmxhZ3Mgc3RpbGwgb3ZlcnJpZGUuXG5jb25zdCBERUZBVUxUX0FMSUFTID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0ZST00gPz8gdW5kZWZpbmVkO1xuXG4vLyBJZGVudGl0eSBmbGFncyBhcmUgaW50ZXJjaGFuZ2VhYmxlIGFjcm9zcyB2ZXJicy4gYHNlbmRgIGhpc3RvcmljYWxseSB0b29rXG4vLyBgLS1mcm9tYCB3aGlsZSBgdGFpbGAvYHdhaXRgIHRvb2sgYC0tYXNgIOKAlCBzYW1lIGNvbmNlcHQgKHdobyBhbSBJKSwgYW5kIHRoZVxuLy8gYXN5bW1ldHJ5IHRyaXBzIHlvdSBtaWQtZmxvdy4gQWNjZXB0IGVpdGhlciBldmVyeXdoZXJlIGlkZW50aXR5IGlzIG1lYW50LFxuLy8gZmFsbGluZyBiYWNrIHRvIEdSQVBFVklORV9GUk9NLiAoZ3JlcCdzIGAtLWZyb21gIGlzIGEgZGlmZmVyZW50IHRoaW5nIOKAlCBhblxuLy8gYXV0aG9yICpmaWx0ZXIqLCBub3QgaWRlbnRpdHkg4oCUIHNvIGl0IGRvZXNuJ3QgdXNlIHRoaXMuKVxuZnVuY3Rpb24gcmVzb2x2ZUFsaWFzKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiAoZmxhZ3MuZnJvbSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IChmbGFncy5hcyBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IERFRkFVTFRfQUxJQVM7XG59XG4vLyBUcnVuY2F0aW9uLWhpbnQgdGhyZXNob2xkLiBNZXNzYWdlcyBsb25nZXIgdGhhbiB0aGlzIGdldCBhIGB0cnVuY2F0aW9uX2hpbnRgXG4vLyBmaWVsZCBvbiB0aGUgdGFpbCBKU09OIHNvIGNvbnN1bWVycyAoZS5nLiBNb25pdG9yKSBrbm93IHRoZSBub3RpZmljYXRpb25cbi8vIHByZXZpZXcgaXMgaW5jb21wbGV0ZSBhbmQgc2hvdWxkIGByZWFkYCB0aGUgZnVsbCBib2R5LiBJbiBhZ2VudC10by1hZ2VudFxuLy8gdHJhZmZpYywgbG9uZyBtZXNzYWdlcyBhcmUgdGhlIE5PUk0gKHRoZSBWMS42IHJvdW5kdGFibGUgc2F3IG1vc3Qgc3Vic3RhbnRpdmVcbi8vIG1lc3NhZ2VzIGV4Y2VlZCA4MDApLCBzbyBhbiA4MDAgZGVmYXVsdCBmaXJlZCBvbiBuZWFybHkgZXZlcnl0aGluZyBhbmQgdGhlXG4vLyByZWNvdmVyeSBwYXRoIGJlY2FtZSB0aGUgbWFpbiBwYXRoLiBEZWZhdWx0IHJhaXNlZCB0byAyMDAwIHNvIHRoZSBoaW50IG1hcmtzXG4vLyB0aGUgZ2VudWluZWx5LWxvbmcgb3V0bGllcnMuIE92ZXJyaWRhYmxlIHZpYSBlbnYgdmFyIGZvciB0dW5pbmcuXG5jb25zdCBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID0gcGFyc2VJbnQoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9UUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID8/IFwiMjAwMFwiLFxuICAxMCxcbik7XG5cbi8vIE9wdGlvbmFsIGlubGluZS1ib2R5IGNhcCBmb3IgYHRhaWxgIChvcHQtaW4gdmlhIC0tbWF4IDxuPiBvciBHUkFQRVZJTkVfVEFJTF9NQVgpLlxuLy8gV2hlbiBzZXQsIGEgYm9keSBsb25nZXIgdGhhbiB0aGUgY2FwIGlzIHRydW5jYXRlZCB0byBgbmAgY2hhcnMgaW4gdGhlIHRhaWxcbi8vIGZyYW1lIChwbHVzIHRoZSByZWFkLXBvaW50ZXIgaGludCksIHNvIGEgcHVzaCBjb25zdW1lciBjYW4gaGFuZCBpdHNcbi8vIG5vdGlmaWNhdGlvbiBzdXJmYWNlIGEgZGVsaWJlcmF0ZWx5LXNpemVkIGxpbmUuIFRoZSBGVUxMIG1lc3NhZ2UgaXMgYWx3YXlzXG4vLyByZXRyaWV2YWJsZSB2aWEgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLiBVbmRlZmluZWQgPSBubyBjYXAgKGZ1bGwgdGV4dCBpbmxpbmUg4oCUXG4vLyB0b2RheSdzIGRlZmF1bHQpLiBOb3RlOiB0aGUgaGFyZCBjbGlwIGEgY29uc3VtZXIgdWx0aW1hdGVseSBzZWVzIGlzIHN0aWxsIHRoZVxuLy8gTW9uaXRvci9ub3RpZmljYXRpb24gbGF5ZXInczsgLS1tYXggb25seSBib3VuZHMgdGhlIGxpbmUgZ3JhcGV2aW5lIGVtaXRzLlxuLy8gUmVqZWN0cyBuZWdhdGl2ZSAvIG5vbi1udW1lcmljLlxuZnVuY3Rpb24gcmVzb2x2ZVRhaWxNYXgoZmxhZzogdW5rbm93bik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBmbGFnID09PSBcInN0cmluZ1wiID8gZmxhZyA6IHByb2Nlc3MuZW52LkdSQVBFVklORV9UQUlMX01BWDtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdywgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPj0gMCA/IG4gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlIOKAlCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2AncyBgZGllYCwgdW5kZXIgdGhpc1xuICogc3BlbGwncyBvd24gbmFtZSBzbyA0NiBjYWxsIHNpdGVzIGRpZCBub3QgZWFjaCBoYXZlIHRvIGJlIHJlLXNwZWxsZWQuXG4gKlxuICog4puUICoqSVQgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBBIENBTExFUi1WSVNJQkxFIENIQU5HRSoqXG4gKiAoUGhhc2UgNiBjaGFwdGVyIDI7IHRoZSBkZWx0YSBpcyBkcml2ZW4gYW5kIHJlY29yZGVkIGluIHRoZSBqb3VybmFsKS4gVGhpc1xuICogZnVuY3Rpb24gd2FzIGBwcm9jZXNzLnN0ZGVyci53cml0ZShcXGBncmFwZXZpbmU6ICR7bXNnfVxcblxcYCk7IHByb2Nlc3MuZXhpdChjb2RlKWBcbiAqIOKAlCBQUk9TRSBhdCBleGl0IDIgZm9yIGV2ZXJ5IGZhaWx1cmUgZ3JhcGV2aW5lIGNvdWxkIHByb2R1Y2UsIHdpdGggdHdvIHNpdGVzXG4gKiBwYXNzaW5nIDEuIEFmdGVyIHRoZSBhZG9wdGlvbiBpdCBpcyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIHRoZVxuICogYWNjIHRheG9ub215J3MgY29kZXM6IHVzYWdlIDIsIGludGVybmFsIDEsIG5vdF9mb3VuZCA1LCBjb25mbGljdCA2LiBBbiBhZ2VudFxuICogcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZTsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbiBhbmQgcmV3b3JkaW5nXG4gKiBpdCBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkaWQgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlZCBwcm9zZS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIEVOVU1FUkFUSU9OUyBNT1ZFRCBGUk9NIFBST1NFIElOVE8gYGNob2ljZXNgLioqIGdyYXBldmluZSdzXG4gKiByZWplY3Rpb25zIHdlcmUgc2hhcGVkIGZvciBhY2MncyBmbGFnLXNldCBleHRyYWN0b3JzIOKAlCBgcmVjb2duaXplZCBmbGFnczogLS1hXG4gKiAtLWJgLCB3aXRoIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdCBhIHF1YWxpZmllciBiZXR3ZWVuIHRoZSBub3VuIGFuZCB0aGUgY29sb25cbiAqIFwicmVhZHMgYXMgcHJvc2UsIG5vdCBhIHNldFwiLiBXcmFwcGVkIGluIEpTT04gdGhhdCBtYXJrZXIgYmVjb21lcyBhIHN1YnN0cmluZyBvZlxuICogYW4gZXNjYXBlZCBzdHJpbmcsIHNvIGl0IGRvZXMgbm90IHN0YXkgaW4gcHJvc2U6IGV2ZXJ5IGVudW1lcmF0aW9uIGlzIG5vdyBhXG4gKiBgY2hvaWNlc2AgYXJyYXksIHdoaWNoIGlzIHdoYXQgZ2xhbW91ciAoQ09ORk9STUFOVCBMMCkgcHVibGlzaGVzIGFuZCB3aGF0IHRoZVxuICogZW52ZWxvcGUgaGFzIGEgZmllbGQgZm9yLiBUaGUgcnVubmFibGUgcmVjb3Zlcnkg4oCUIGB0cnk6IGJ1biDigKYvY2xpLnRzIG9wZW4geGAg4oCUXG4gKiBtb3ZlZCBpbnRvIGBoaW50YCBmb3IgdGhlIHNhbWUgcmVhc29uLCBhbmQgYSBjYWxsZXIgbm93IHJlYWRzIGEgZmllbGQgaW5zdGVhZFxuICogb2Ygc3BsaXR0aW5nIGEgc2VudGVuY2UuXG4gKlxuICog4pqgIGBkaWVgIGlzIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgc3dhbGxvd3MsIGFuZCB0aGF0IGlzXG4gKiBub3cgYSBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4gQXVkaXRlZCBieSBjYWxsIGdyYXBoIGF0IHRoZVxuICogYWRvcHRpb24gKHBsYXlib29rIEI5KTsgdGhlIGNvdW50IGlzIGluIHRoZSBqb3VybmFsLlxuICovXG5mdW5jdGlvbiBkaWUobXNnOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHJhaXNlKG1zZywga2luZCwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFRoZSB0YXhvbm9teSBga2luZGAgZm9yIGFuIEhUVFAgc3RhdHVzIHRoZSBkYWVtb24gYW5zd2VyZWQgd2l0aC5cbiAqXG4gKiDim5QgT05FIE1BUFBJTkcsIE5PVCBBIEpVREdFTUVOVCBQRVIgU0lURS4gVHdlbnR5IG9mIGdyYXBldmluZSdzIHJhaXNlIHNpdGVzXG4gKiBhcmUgXCJ0aGUgZGFlbW9uIHNhaWQgbm9cIjsgYmVmb3JlIHRoZSBhZG9wdGlvbiBldmVyeSBvbmUgb2YgdGhlbSBjb2xsYXBzZWQgdG9cbiAqIGV4aXQgMiwgc28gYSBtaXNzaW5nIGNoYW5uZWwsIGEgbGl2ZS1zZXNzaW9uIHJlZnVzYWwgYW5kIGEgYnJva2VuIGRhZW1vbiB3ZXJlXG4gKiBvbmUgbnVtYmVyIHRvIGFuIGFnZW50LiBUaGUgZGFlbW9uIGFscmVhZHkgZGlzdGluZ3Vpc2hlcyB0aGVtIGJ5IHN0YXR1cyDigJRcbiAqIDQwNCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QsIDQwOSBmb3IgYXJjaGl2ZWQgLyBsaXZlIC8gYWxyZWFkeS1vcGVuXG4gKiDigJQgc28gdGhlIG1hcHBpbmcgaXMgYSByZS1yZWFkaW5nIG9mIHdoYXQgd2FzIG9uIHRoZSB3aXJlLCBub3QgYSBuZXcgb3Bpbmlvbi5cbiAqL1xuZnVuY3Rpb24ga2luZEZvclN0YXR1cyhzdGF0dXM6IG51bWJlcik6IEVycktpbmQge1xuICBpZiAoc3RhdHVzID09PSA0MDQpIHJldHVybiBcIm5vdF9mb3VuZFwiO1xuICBpZiAoc3RhdHVzID09PSA0MDkpIHJldHVybiBcImNvbmZsaWN0XCI7XG4gIGlmIChzdGF0dXMgPj0gNDAwICYmIHN0YXR1cyA8IDUwMCkgcmV0dXJuIFwidXNhZ2VcIjtcbiAgcmV0dXJuIFwiaW50ZXJuYWxcIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZERhZW1vblBvcnQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKFBPUlRfRklMRSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChyYXcsIDEwKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIC8vIEZpcmUtYW5kLWZvcmdldCBtaXNtYXRjaCBjaGVjayAod29uJ3QgYmxvY2sgdGhlIHZlcmIpLlxuICAgICAgbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydCk7XG4gICAgICByZXR1cm4gcG9ydDtcbiAgICB9XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RhbGUg4oCUIGNsZWFuIHVwLlxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUE9SVF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUElEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBob2xkQWN0aXZlKCk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB1bnRpbCA9IHBhcnNlSW50KHJlYWRGaWxlU3luYyhIT0xEX0ZJTEUsIFwidXRmLThcIikudHJpbSgpLCAxMCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh1bnRpbCkgJiYgdW50aWwgPiBEYXRlLm5vdygpKSByZXR1cm4gdW50aWw7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9IGNhdGNoIHt9IC8vIGV4cGlyZWQg4oaSIGNsZWFuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgZnVuY3Rpb24gcmVsZWFzZUhvbGQoKSB7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgaWYgKGhvbGRBY3RpdmUoKSlcbiAgICBkaWUoXG4gICAgICBcImRhZW1vbiBpcyBoZWxkIChyZXNwYXduIHN1cHByZXNzZWQpIOKAlCB3YWl0IGZvciB0aGUgaG9sZCB0byBjbGVhciBvciBydW4gYGdyYXBldmluZSByb2xsYFwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIC8vIENoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzogdGhlIGRhZW1vbidzIHN0ZGlvIGlzIGlnbm9yZWQsIHNvIGFcbiAgLy8gZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydCB3b3VsZCBvdGhlcndpc2Ugc3VyZmFjZSBvbmx5IGFzXG4gIC8vIFwiZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiIOKAlCBhbmQgbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgRU5PRU5UIG9uXG4gIC8vIHRoZSBleGVjdXRhYmxlLCB3aGljaCByZWFkcyBhcyBcImJ1biBpcyBtaXNzaW5nXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBncmFwZXZpbmUgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH0uIGAgK1xuICAgICAgICBcIk5vIGRpc3QvaW5kZXguaHRtbCB3YXMgZm91bmQgKG9yIFNQRUxMQk9PS19TVVJGQUNFX01PREU9ZGV2IGlzIHNldCksIHNvIHRoZSBkYWVtb24gXCIgK1xuICAgICAgICBcIm11c3QgcnVuIGZyb20gc3JjL2dyYXBldmluZS8gdG8gYnVuZGxlIHRoZSB3YXRjaCBzdXJmYWNlLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgXCIgK1xuICAgICAgICBcImRvZXMgbm90IGhhdmUuIEVpdGhlciB0aGUgc2hpcHBlZCBkaXN0LyBpcyBtaXNzaW5nIChyZWluc3RhbGwgdGhlIHNwZWxsKSBvciB5b3UgYXJlIGluIFwiICtcbiAgICAgICAgXCJhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dyYXBldmluZS8uXCIsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgKTtcbiAgfVxuICAvLyBTcGF3biBkZXRhY2hlZCBzbyB0aGUgZGFlbW9uIHN1cnZpdmVzIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdC5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtEQUVNT05fU0NSSVBUXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2QsXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFdhaXQgdXAgdG8gM3MgZm9yIHRoZSBwb3J0IGZpbGUgdG8gYXBwZWFyIGFuZCByZXNwb25kLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIH1cbiAgZGllKFwiZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiwgXCJpbnRlcm5hbFwiLCB7XG4gICAgaGludDpcbiAgICAgIFwidGhyZWUgdW5yZWxhdGVkIGNhdXNlcyByZXBvcnQgdGhpcyBvbmUgc2VudGVuY2U6IHRoZSBkYWVtb24ncyBsYXVuY2hlciBzaGFwZSwgXCIgK1xuICAgICAgXCJhIHdyb25nIHNwYXduIHBhdGgsIGFuZCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQuIFwiICtcbiAgICAgIFwiUnVuIHRoZSBkYWVtb24gbGF1bmNoZXIgYWxvbmUgdG8gdGVsbCB0aGVtIGFwYXJ0IOKAlCBpdCBpcyB0aGUgbGF1bmNoZXIgc2hhcGUgXCIgK1xuICAgICAgXCJpZmYgaXQgcHJpbnRzIGBsaXN0ZW5pbmcgb24g4oCmYCBhbmQgcmV0dXJucyBhdCBleGl0IDAuIEFuIGVtcHR5IFwiICtcbiAgICAgIFwiR1JBUEVWSU5FX0hPTUUgKG5vIGBjaGFubmVscy9gKSBtZWFucyB0aGUgZGFlbW9uIG5ldmVyIGJvdW5kIGF0IGFsbC5cIixcbiAgfSk7XG59XG5cbi8vIEdlbmVyaWMgb3ZlciB0aGUgZXhwZWN0ZWQgc3VjY2VzcyBib2R5LiBgZGF0YWAgbWF5IGJlIG51bGwgaWYgdGhlIHJlc3BvbnNlXG4vLyBoYWQgbm8gSlNPTiBib2R5LCBzbyBjYWxsZXJzIHNlZSBgVCB8IG51bGxgLlxuYXN5bmMgZnVuY3Rpb24gYXBpPFQgPSB1bmtub3duPihcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogVCB8IG51bGwgfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IFQgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFQ7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG4vLyBIb3cgVEhJUyBDTEkgd2FzIGludm9rZWQsIGFzIGEgcnVubmFibGUgcHJlZml4LiBgcHJvY2Vzcy5hcmd2WzFdYCBpcyB0aGVcbi8vIGFic29sdXRlIHBhdGggb2YgY2xpLnRzIHVuZGVyIGBidW4g4oCmL2NsaS50cyA8dmVyYj5gLCB3aGljaCBpcyBTS0lMTC5tZCdzXG4vLyBjYW5vbmljYWwgaW52b2NhdGlvbiDigJQgc28gdGhlIGxpbmUgd2UgcHJpbnQgY2FuIGFjdHVhbGx5IGJlIHBhc3RlZC4gRmFsbHNcbi8vIGJhY2sgdG8gdGhlIGJhcmUgdmVyYiBpZiBhcmd2IGlzIG5vdCBzaGFwZWQgYXMgZXhwZWN0ZWQsIHdoaWNoIGlzIGEgdmVyYlxuLy8gcmVmZXJlbmNlIHJhdGhlciB0aGFuIGEgY29tbWFuZCB0aGF0IGxpZXMgYWJvdXQgYmVpbmcgb25lLlxuZnVuY3Rpb24gaW52b2NhdGlvblByZWZpeCgpOiBzdHJpbmcge1xuICBjb25zdCBlbnRyeSA9IHByb2Nlc3MuYXJndlsxXTtcbiAgcmV0dXJuIGVudHJ5ID8gYGJ1biAke2VudHJ5fWAgOiBcIlwiO1xufVxuXG4vLyBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgYGhpbnRgIOKAlCB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoYSA0MDQgb24gYVxuLy8gcmVhZCBuYW1lcyB0aGUgYG9wZW5gIHRoYXQgd291bGQgY3JlYXRlIHRoZSBjaGFubmVsKS5cbi8vXG4vLyDimqAgYGhpbnRgIGlzIGEgVkVSQiBJTlZPQ0FUSU9OLCBub3QgYSBzaGVsbCBjb21tYW5kOiB0aGUgZGFlbW9uIGNhbm5vdCBrbm93XG4vLyBob3cgaXRzIGNsaWVudCB3YXMgaW52b2tlZCwgc28gaXQgbmFtZXMgdGhlIGFjdCBhbmQgd2UgcmVuZGVyIGl0LiBJdCB1c2VkIHRvXG4vLyBhcnJpdmUgYXMgYGdyYXBldmluZSBvcGVuIDxuYW1lPmAgYW5kIGJlIHByaW50ZWQgdmVyYmF0aW0gYWZ0ZXIgYHRyeTpgLCB3aGljaFxuLy8gcmVhZHMgYXMgc29tZXRoaW5nIHRvIHBhc3RlIOKAlCBhbmQgcGFzdGluZyBpdCBnZXRzIGBjb21tYW5kIG5vdCBmb3VuZGAsXG4vLyBiZWNhdXNlIG5vdGhpbmcgaW5zdGFsbHMgYSBgZ3JhcGV2aW5lYCBiaW5hcnkuIFJ1bGluZyAyIGFza2VkIHRoYXQgYSByZWZ1c2FsXG4vLyBuYW1lIHRoZSBuZXh0IGFjdDsgYSByZWNvdmVyeSB0aGF0IGZhaWxzIHdoZW4geW91IHJ1biBpdCBkb2VzIG5vdC5cbmZ1bmN0aW9uIGRpZUFwaShkYXRhOiB7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0gfCBudWxsLCBzdGF0dXM6IG51bWJlcik6IG5ldmVyIHtcbiAgY29uc3QgbXNnID0gZGF0YT8uZXJyb3IgPz8gYEhUVFAgJHtzdGF0dXN9YDtcbiAgY29uc3QgcHJlZml4ID0gaW52b2NhdGlvblByZWZpeCgpO1xuICAvLyDim5QgVEhFIFJFQ09WRVJZIElTIEEgRklFTEQgTk9XLCBOT1QgQSBTRU5URU5DRS4gSXQgdXNlZCB0byBiZSBhcHBlbmRlZCB0byB0aGVcbiAgLy8gbWVzc2FnZSBhcyBg4oCUIHRyeTogPGNtZD5gLCB3aGljaCBhIGNhbGxlciBoYWQgdG8gcmVjb3ZlciBieSBzcGxpdHRpbmcgb25cbiAgLy8gXCJ0cnk6IFwiIChvbmUgb2YgZ3JhcGV2aW5lJ3Mgb3duIGNlbGxzIGRpZCBleGFjdGx5IHRoYXQsIGFuZCByYW4gd2hhdCBpdFxuICAvLyBmb3VuZCkuIGBoaW50YCBpcyB3aGVyZSB0aGUgZW52ZWxvcGUgY2FycmllcyBpdCwgc28gdGhlIHNhbWUgY2VsbCBub3cgcmVhZHNcbiAgLy8gYSBmaWVsZCBhbmQgcnVucyBpdCDigJQgdGhlIHByb3BlcnR5IGlzIHVuY2hhbmdlZCBhbmQgdGhlIHBhcnNlIGlzIG5vdCBhIHBhcnNlLlxuICBjb25zdCBoaW50ID0gZGF0YT8uaGludFxuICAgID8gcHJlZml4XG4gICAgICA/IGB0cnk6ICR7cHJlZml4fSAke2RhdGEuaGludH1gXG4gICAgICA6IGB0cnkgdGhlIFxcYCR7ZGF0YS5oaW50fVxcYCB2ZXJiYFxuICAgIDogdW5kZWZpbmVkO1xuICBkaWUobXNnLCBraW5kRm9yU3RhdHVzKHN0YXR1cyksIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC8vIFRoZSB1cHN0cmVhbSdzIGJvZHkgVkVSQkFUSU0sIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gd2hhdCB0aGUgZGFlbW9uXG4gICAgLy8gYWN0dWFsbHkgc2FpZCByYXRoZXIgdGhhbiBvbiB0aGlzIENMSSdzIHByb3NlIGFib3V0IGl0LlxuICAgIC4uLihkYXRhICE9PSBudWxsID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIEV4aXN0ZW5jZSBwcm9iZSBmb3IgdGhlIHJlYWQgdmVyYnMgdGhhdCBhbnN3ZXIgZnJvbSB0aGUgTE9HIEZJTEUgcmF0aGVyIHRoYW5cbi8vIGZyb20gYSByb3V0ZSAoYHRyaWFnZWAsIGBwdWxsIC0tc3RhdHVzYCkuIFRob3NlIGNhbm5vdCA0MDQgb24gdGhlaXIgb3duOiBhXG4vLyBtaXNzaW5nIGxvZyBpcyBhbiBlbXB0eSBhcnJheSwgd2hpY2ggaXMgdGhlIHNhbWUgc2lsZW50IGxpZSB0aGUgZGFlbW9uIGd1YXJkXG4vLyBleGlzdHMgdG8ga2lsbC4gR0VUIC90b3BpYyBpcyB0aGUgY2hlYXBlc3QgZ3VhcmRlZCByb3V0ZSwgc28gaXQgaXMgdGhlIHByb2JlLlxuYXN5bmMgZnVuY3Rpb24gcmVxdWlyZUNoYW5uZWwocG9ydDogbnVtYmVyLCBuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4obmFtZTogc3RyaW5nLCBvcHRzOiB7IHRvcGljPzogc3RyaW5nOyBmcm9tPzogc3RyaW5nOyBmcmVzaD86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgb3BlbiA8bmFtZT4gWy0tdG9waWMgPHRleHQ+XSBbLS1mcmVzaF1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4gPSB7IG5hbWUsIGV4cGxpY2l0OiB0cnVlIH07XG4gIGlmIChvcHRzLnRvcGljICE9PSB1bmRlZmluZWQpIGJvZHkudG9waWMgPSBvcHRzLnRvcGljO1xuICBpZiAob3B0cy5mcm9tICE9PSB1bmRlZmluZWQpIGJvZHkuZnJvbSA9IG9wdHMuZnJvbTtcbiAgaWYgKG9wdHMuZnJlc2gpIGJvZHkuZnJlc2ggPSB0cnVlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE9wZW5SZXNwb25zZT4ocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBkYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUb3BpYyhuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZyB8IHVuZGVmaW5lZCwgZnJvbTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB0b3BpYyA8Y2hhbm5lbD4gWzx0ZXh0Pl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgaWYgKHRleHQgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIGB0b3BpYyA8bmFtZT5gIHdpdGggbm8gdGV4dCBpcyBhIFJFQUQg4oCUIGl0IGFza3Mgd2hhdCB0aGUgdG9waWMgaXMsIGFuZCBhXG4gICAgLy8gbWlzc2luZyBjaGFubmVsIGFuc3dlcnMgdGhhdCBxdWVzdGlvbiBieSBiZWluZyBtaXNzaW5nLiBObyBlbnN1cmU6IHRoZVxuICAgIC8vIGVuc3VyZSB3YXMgd2hhdCByZXN1cnJlY3RlZCBhIGNsb3NlZCBjaGFubmVsIGZyb20gYSByZWFkIHZlcmIuXG4gICAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgKTtcbiAgICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gYHRvcGljIDxuYW1lPiA8dGV4dD5gIGlzIGEgV1JJVEUsIHNvIGl0IG1heSBjcmVhdGUg4oCUIGJ1dCBpdCBtdXN0IG5vdCB3cml0ZVxuICAvLyB0byBhbiBBUkNISVZFRCBjaGFubmVsLiBUaGUgUFVUIGVuZm9yY2VzIHRoYXQgaXRzZWxmIG5vdzsgdGhpcyBlbnN1cmUgc3RheXNcbiAgLy8gYmVjYXVzZSBESVNDQVJESU5HIElUUyBTVEFUVVMgaXMgcHJlY2lzZWx5IHRoZSBidWcgYmVpbmcgZml4ZWQgaGVyZS4gQmVmb3JlXG4gIC8vIHRvZGF5IHRoZSA0MDkgdGhhdCBhbnN3ZXJzIGZvciBhbiBhcmNoaXZlZCBuYW1lIHdhcyB0aHJvd24gYXdheSBhbmQgdGhlIFBVVFxuICAvLyB0aGF0IGZvbGxvd2VkIGxhbmRlZDogYGFyY2hpdmUgeDsgdG9waWMgeCBcInRcImAgcmV0dXJuZWQgb2s6dHJ1ZSwgZXhpdCAwLlxuICBjb25zdCBlbnN1cmUgPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9Pihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lIH0pO1xuICBpZiAoZW5zdXJlLnN0YXR1cyA+PSA0MDApIGRpZUFwaShlbnN1cmUuZGF0YSwgZW5zdXJlLnN0YXR1cyk7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8VG9waWNSZXNwb25zZT4ocG9ydCwgXCJQVVRcIiwgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCwge1xuICAgIHRvcGljOiB0ZXh0LFxuICAgIGZyb206IGZyb20gPz8gXCJzeXN0ZW1cIixcbiAgfSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYywgaWQ6IGRhdGE/LmlkIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRMaXN0KCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWxzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Q2hhbm5lbHNSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvY2hhbm5lbHNcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFNlbmQoXG4gIG5hbWU6IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIG9wdHM6IHsgcXVpZXQ/OiBib29sZWFuOyB2ZXJib3NlPzogYm9vbGVhbjsgaW5SZXBseVRvPzogbnVtYmVyIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFmcm9tIHx8ICF0ZXh0KSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHNlbmQgPG5hbWU+IC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiB7IGZyb206IHN0cmluZzsgdGV4dDogc3RyaW5nOyBpbl9yZXBseV90bz86IG51bWJlciB9ID0ge1xuICAgIGZyb20sXG4gICAgdGV4dCxcbiAgfTtcbiAgaWYgKG9wdHMuaW5SZXBseVRvICE9PSB1bmRlZmluZWQpIGJvZHkuaW5fcmVwbHlfdG8gPSBvcHRzLmluUmVwbHlUbztcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTZW5kUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlc2AsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIC8vIFRhcmdldCBlY2hvIG9uIHN0ZGVyciDigJQgY29uZmlybXMgV0hFUkUgdGhlIG1lc3NhZ2UgbGFuZGVkIHNvIGEgbWlzcm91dGVkXG4gIC8vIHJlcGx5IChyaWdodCBwcm9tcHQsIHdyb25nIGNoYW5uZWwpIGlzIGNhdWdodCB0aGUgaW5zdGFudCBpdCBoYXBwZW5zIChGOSkuXG4gIC8vIE9uIHN0ZGVyciBzbyBpdCBuZXZlciBwb2xsdXRlcyB0aGUgc3Rkb3V0IEpTT04gcmVjZWlwdCwgYW5kIGl0IGZpcmVzIGV2ZW5cbiAgLy8gdW5kZXIgLS1xdWlldCAodGhlIHNhZmV0eSBzaWduYWwgc2hvdWxkbid0IGJlIHNpbGVuY2VkKS5cbiAgY29uc3QgcmVjaXAgPVxuICAgIGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkXG4gICAgICA/IGAke2RhdGEucmVjaXBpZW50c30gcmVjaXBpZW50KHMpYFxuICAgICAgOiBgJHtkYXRhLnN1YnNjcmliZXJzID8/IDB9IHN1YnNjcmliZXIocylgO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyDihpIgJHtkYXRhLmNoYW5uZWx9IMK3ICR7cmVjaXB9XFxuYCk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIC8vIFRlcnNlIGRlZmF1bHQ6IGlkICsgc3Vic2NyaWJlciBjb3VudCArIHZvaWQgd2FybmluZy4gLS12ZXJib3NlIGFsc29cbiAgLy8gaW5jbHVkZXMgdGhlIHN1YnNjcmliZXIgYWxpYXMgbGlzdCAoc2FtZSBkYXRhIGFzIHRoZSBgd2hvYCB2ZXJiLFxuICAvLyBwaWdneWJhY2tlZCB0byBhdm9pZCBhbiBleHRyYSByb3VuZC10cmlwIHdoZW4gdGhlIHNlbmRlciBjYXJlcykuXG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgaWQ6IGRhdGEuaWQsXG4gICAgY2hhbm5lbDogZGF0YS5jaGFubmVsLFxuICAgIHN1YnNjcmliZXJzOiBkYXRhLnN1YnNjcmliZXJzID8/IDAsXG4gIH07XG4gIC8vIE9ubHkgc3VyZmFjZSByZWNpcGllbnRzIGlmIHRoZSBkYWVtb24gYWN0dWFsbHkgY29tcHV0ZWQgaXQuIERlZmF1bHRpbmdcbiAgLy8gdG8gMCB3YXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBcInJlYWxseSAwXCIgYW5kIGhpZCBzaWxlbnQgVjEuNS1kYWVtb25cbiAgLy8gZGVncmFkYXRpb24gZHVyaW5nIGNyb3NzLXZlcnNpb24gc2Vzc2lvbnM7IG1pc3NpbmctbWVhbnMtbWlzc2luZyBpcyB0aGVcbiAgLy8gaG9uZXN0IHNpZ25hbC5cbiAgaWYgKGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkKSBvdXQucmVjaXBpZW50cyA9IGRhdGEucmVjaXBpZW50cztcbiAgaWYgKGRhdGEuc3Vic2NyaWJlcnMgPT09IDApIG91dC53YXJuaW5nID0gXCJjaGFubmVsIGhhcyBubyBzdWJzY3JpYmVyc1wiO1xuICBlbHNlIGlmIChkYXRhLnJlY2lwaWVudHMgPT09IDApIG91dC53YXJuaW5nID0gXCJvbmx5IHlvdSBhcmUgc3Vic2NyaWJlZFwiO1xuICBpZiAob3B0cy52ZXJib3NlKSBvdXQuc3Vic2NyaWJlcl9hbGlhc2VzID0gZGF0YS5zdWJzY3JpYmVyX2FsaWFzZXMgPz8gW107XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBbm5vdW5jZShcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNoYW5uZWxzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW4gfSxcbikge1xuICBpZiAoIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgYW5ub3VuY2UgLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGNoYW5uZWxzPzogc3RyaW5nW10gfSA9IHsgZnJvbSwgdGV4dCB9O1xuICBpZiAoY2hhbm5lbHM/Lmxlbmd0aCkgYm9keS5jaGFubmVscyA9IGNoYW5uZWxzO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPEFubm91bmNlUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIFwiL2Fubm91bmNlXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgIGAjIGFubm91bmNlZCDihpIgJHtkYXRhLmNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKSDCtyAke2RhdGEudG90YWxfcmVjaXBpZW50c30gcmVjaXBpZW50KHMpXFxuYCxcbiAgKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBjaGFubmVsczogZGF0YS5jaGFubmVscyxcbiAgICB0b3RhbF9yZWNpcGllbnRzOiBkYXRhLnRvdGFsX3JlY2lwaWVudHMsXG4gIH07XG4gIGlmIChkYXRhLnNraXBwZWQ/Lmxlbmd0aCkgb3V0LnNraXBwZWQgPSBkYXRhLnNraXBwZWQ7XG4gIGlmIChkYXRhLmNoYW5uZWxzLmxlbmd0aCA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm5vIGFjdGl2ZSBjaGFubmVscyB0byBhbm5vdW5jZSB0b1wiO1xuICBwcmludEpzb24ob3V0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUHVsbChuYW1lOiBzdHJpbmcsIHNpbmNlOiBudW1iZXIsIG9wdHM6IHsgc3RhdHVzPzogc3RyaW5nIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcHVsbCA8Y2hhbm5lbD4gWy0tc2luY2UgPGlkPl0gWy0tc3RhdHVzIDx2YWx1ZT5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG5cbiAgaWYgKG9wdHMuc3RhdHVzICE9PSB1bmRlZmluZWQpIHtcbiAgICAvLyBUaGlzIGJyYW5jaCBhbnN3ZXJzIGZyb20gdGhlIGxvZyBmaWxlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24uXG4gICAgYXdhaXQgcmVxdWlyZUNoYW5uZWwocG9ydCwgbmFtZSk7XG4gICAgLy8gRnVsbC1jaGFubmVsIHNjYW46IGZpbHRlciBieSBsYXRlc3QgZGlzcG9zaXRpb24sIHN0YXR1cyBmcmFtZXMgZXhjbHVkZWQuXG4gICAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgICBjb25zdCBmaWx0ZXJlZCA9IGJhZGdlZC5maWx0ZXIoKG0pID0+IHtcbiAgICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgICAvLyBgLS1zdGF0dXMgb3BlbmAgbWlycm9ycyB0cmlhZ2UncyBvcGVuIGJ1Y2tldDogc2lnbmFsLW9ubHksIHNvIG5vbi1tZXNzYWdlXG4gICAgICAvLyBGWUlzICh0b3BpYy9hbm5vdW5jZW1lbnQpIGFyZSBleGNsdWRlZCBmcm9tIHRoZSBhY3Rpb25hYmxlIHF1ZXVlLlxuICAgICAgcmV0dXJuIG9wdHMuc3RhdHVzID09PSBcIm9wZW5cIlxuICAgICAgICA/IG0ua2luZCA9PT0gXCJtZXNzYWdlXCIgJiYgaXNPcGVuKGRpc3BBcmcpXG4gICAgICAgIDogbS5kaXNwb3NpdGlvbiA9PT0gb3B0cy5zdGF0dXM7XG4gICAgfSk7XG4gICAgY29uc3QgbGFzdElkID0gZmlsdGVyZWQubGVuZ3RoID8gZmlsdGVyZWRbZmlsdGVyZWQubGVuZ3RoIC0gMV0uaWQgOiAwO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogZmlsdGVyZWQsIGN1cnNvcjogbGFzdElkIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpbmNlLXdpbmRvdyBwYXRoICh1bmNoYW5nZWQgZnJvbSBUYXNrIDIpLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtzaW5jZX1gLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIGNvbnN0IHJhd01zZ3MgPSBkYXRhPy5tZXNzYWdlcyA/PyBbXTtcbiAgY29uc3QgY3Vyc29yID0gcmF3TXNncy5sZW5ndGggPyByYXdNc2dzW3Jhd01zZ3MubGVuZ3RoIC0gMV0uaWQgOiBzaW5jZTtcbiAgY29uc3QgZGlzcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGFubm90YXRlZCA9IHJhd01zZ3NcbiAgICAvLyBEaXNwb3NpdGlvbiBmcmFtZXMgb25seSDigJQgYSBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSBzdGF5cyBpblxuICAgIC8vIHRoZSBoaXN0b3J5IGFuIGFnZW50IHB1bGxzOyBpdCBpcyBob3cgaXQgbGVhcm5zIHRoZSBjaGFubmVsIHdhcyByZXRpcmVkLlxuICAgIC5maWx0ZXIoKG0pID0+ICFpc0Rpc3Bvc2l0aW9uRnJhbWUobSkpXG4gICAgLm1hcCgobSkgPT4ge1xuICAgICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgICAgcmV0dXJuIGQgPyB7IC4uLm0sIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSA6IG07XG4gICAgfSk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogYW5ub3RhdGVkLCBjdXJzb3IgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYWQobmFtZTogc3RyaW5nLCBpZDogbnVtYmVyLCBvcHRzOiB7IHRleHQ/OiBib29sZWFuIH0pIHtcbiAgaWYgKCFuYW1lIHx8ICFOdW1iZXIuaXNGaW5pdGUoaWQpKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHJlYWQgPGNoYW5uZWw+IDxpZD4gWy0tdGV4dF1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQnVpbHQgb24gdGhlIGV4aXN0aW5nIHJhbmdlIGZldGNoIOKAlCBgc2luY2U9aWQtMWAgcmV0dXJucyBpZCBhbmQgYmV5b25kO1xuICAvLyB3ZSBwaWNrIHRoZSBleGFjdCBpZC4gTm8gZGFlbW9uIEFQSSBjaGFuZ2UuIFRoaXMgaXMgdGhlIHRhcmdldGVkXG4gIC8vIFwiZ2l2ZSBtZSBtZXNzYWdlIE4gaW4gZnVsbFwiIHZlcmIgdGhhdCByZWNvdmVycyBhIGNsaXBwZWQgdGFpbCBwcmV2aWV3XG4gIC8vIHdpdGhvdXQgdGhlIHB1bGwtcmFuZ2UgKyBqcSBkYW5jZS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzP3NpbmNlPSR7aWQgLSAxfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgbXNnID0gKGRhdGE/Lm1lc3NhZ2VzID8/IFtdKS5maW5kKChtKSA9PiBtLmlkID09PSBpZCk7XG4gIGlmICghbXNnKSBkaWUoYG1lc3NhZ2UgJHtpZH0gbm90IGZvdW5kIGluICR7bmFtZX1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgZGlzcE1hcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGQgPSBkaXNwTWFwLmdldChpZCk7XG4gIGNvbnN0IGFubm90YXRlZE1zZyA9IGQgPyB7IC4uLm1zZywgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbXNnO1xuICBpZiAob3B0cy50ZXh0KSB7XG4gICAgLy8gUHJvc2UgbW9kZTogaGVhZGVyICsgYm9keSwgbm8gSlNPTiBlbnZlbG9wZSwgc28gYSBodW1hbiAob3IgYW4gYWdlbnRcbiAgICAvLyByZWNvdmVyaW5nIGEgdHJ1bmNhdGVkIG5vdGlmaWNhdGlvbikgY2FuIHJlYWQgaXQgZGlyZWN0bHkuXG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZShtc2cudHMpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgZGlzcFByZWZpeCA9IGRcbiAgICAgID8gZC5yZW9wZW5zID4gMFxuICAgICAgICA/IGBbJHtkLmRpc3Bvc2l0aW9ufSDihrske2QucmVvcGVuc31dIGBcbiAgICAgICAgOiBgWyR7ZC5kaXNwb3NpdGlvbn1dIGBcbiAgICAgIDogXCJcIjtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtkaXNwUHJlZml4fVske21zZy5pZH1dICR7bXNnLmZyb219IMK3ICR7dHN9XFxuJHttc2cudGV4dH1cXG5gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2U6IGFubm90YXRlZE1zZyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2FpdChuYW1lOiBzdHJpbmcsIHNpbmNlOiBudW1iZXIsIHRpbWVvdXRTOiBudW1iZXIsIGFsaWFzOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdhaXQgPGNoYW5uZWw+IFstLWFzIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBHaXZlIHRoZSBIVFRQIGZldGNoIGEgc2xpZ2h0bHkgaGlnaGVyIGFib3J0IHRpbWVvdXQgdGhhbiB0aGUgZGFlbW9uJ3NcbiAgLy8gbG9uZy1wb2xsIHRpbWVvdXQgc28gdGhlIGRhZW1vbiBhbHdheXMgd2lucyB0aGUgdGltZW91dCByYWNlLlxuICAvLyBgP2FzPTxhbGlhcz5gIHJlZ2lzdGVycyBwcmVzZW5jZSBvbiB0aGUgY2hhbm5lbCBmb3IgdGhlIHdhaXQgZHVyYXRpb24g4oCUXG4gIC8vIHdhaXQgaXMgbG9uZy1wb2xsIChwdXNoLXNoYXBlZCB3aXRoIGEgZGVhZGxpbmUpIHNvIGl0IGRlc2VydmVzIHByZXNlbmNlLlxuICBjb25zdCBhc1BhcmFtID0gYWxpYXMgPyBgJmFzPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGFsaWFzKX1gIDogXCJcIjtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFubmVscy8ke25hbWV9L3dhaXQ/c2luY2U9JHtzaW5jZX0mdGltZW91dD0ke3RpbWVvdXRTfSR7YXNQYXJhbX1gO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcbiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoKHRpbWVvdXRTICsgNSkgKiAxMDAwKSxcbiAgfSk7XG4gIGxldCBkYXRhOiBXYWl0UmVzcG9uc2UgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFdhaXRSZXNwb25zZTtcbiAgfSBjYXRjaCB7fVxuICBpZiAoIXJlcy5vaykgZGllQXBpKGRhdGEsIHJlcy5zdGF0dXMpO1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIG1lc3NhZ2VzOiBkYXRhPy5tZXNzYWdlcyA/PyBbXSxcbiAgICBjdXJzb3I6IGRhdGE/LmN1cnNvciA/PyBzaW5jZSxcbiAgICB0aW1lZF9vdXQ6ICEhZGF0YT8udGltZWRfb3V0LFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvKG5hbWU6IHN0cmluZykge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2hvIDxjaGFubmVsPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsOiBuYW1lLCBzdWJzY3JpYmVyczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3Vic2NyaWJlcnNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9zdWJzY3JpYmVyc2AsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdob0FsbCgpIHtcbiAgLy8gQ3Jvc3MtY2hhbm5lbCByb3N0ZXIg4oCUIG5hbWVzIMOXIGNoYW5uZWwgaW4gb25lIGNhbGwsIHNvIHlvdSBkb24ndCBmYW4gb3V0XG4gIC8vIE4gYHdob2AgY2FsbHMgKyBhIG1hbnVhbCBqb2luIHRvIGFuc3dlciBcIndobyBpcyBvbiB3aGljaCB2aW5lP1wiLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWxzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gR2V0IG9yIHNldCB0aGUgcGVyc2lzdGVkIGRlZmF1bHQgYWxpYXMgKFYxLjcpLiBXaXRoIG5vIGFyZ3VtZW50LCBwcmludHMgdGhlXG4vLyBjdXJyZW50IGFsaWFzOyB3aXRoIG9uZSwgd3JpdGVzIGl0IHRvIGNvbmZpZy5qc29uLiBQdXJlIGZpbGUgSS9PIOKAlCB3b3Jrc1xuLy8gd2l0aG91dCBhIHJ1bm5pbmcgZGFlbW9uLiBUaGUgd2F0Y2ggc3VyZmFjZSByZWFkcyBpdCB2aWEgR0VUIC9pZGVudGl0eSBzbyB0aGVcbi8vIGh1bWFuIGhhcyBhIGNvbnNpc3RlbnQgbmFtZSBhY3Jvc3MgZXZlcnkgZ3JhcGV2aW5lLlxuYXN5bmMgZnVuY3Rpb24gY21kQWxpYXMobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGxldCBjZmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHRyeSB7XG4gICAgY2ZnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoQ09ORklHX0ZJTEUsIFwidXRmLThcIikpO1xuICB9IGNhdGNoIHt9XG4gIGlmIChuYW1lID09PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBhbGlhcyA9IHR5cGVvZiBjZmcuYWxpYXMgPT09IFwic3RyaW5nXCIgJiYgY2ZnLmFsaWFzLnRyaW0oKSA/IGNmZy5hbGlhcy50cmltKCkgOiBudWxsO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhcyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgdHJpbW1lZCA9IG5hbWUudHJpbSgpO1xuICBjZmcuYWxpYXMgPSB0cmltbWVkO1xuICBta2RpclN5bmMoREFUQV9ESVIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKENPTkZJR19GSUxFLCBgJHtKU09OLnN0cmluZ2lmeShjZmcsIG51bGwsIDIpfVxcbmApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgYWxpYXM6IHRyaW1tZWQgfHwgbnVsbCB9KTtcbn1cblxuLyoqXG4gKiBUaGUgc3RhbmRpbmcgdGFpbCDigJQgYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCwgYWRvcHRlZCBhdCBQaGFzZSA2IGNoYXB0ZXIgMi5cbiAqXG4gKiDim5QgV0hBVCBUSElTIFJFUExBQ0VELCBBTkQgV0hBVCBJVCBCT1VHSFQuIFRoaXMgdmVyYiB3YXMgMjIwIGxpbmVzIG9mXG4gKiBoYW5kLXdyaXR0ZW4gcmVjb25uZWN0IGxvb3A6IHRocmVlIG5lc3RlZCBsb29wcyAocmVjb25uZWN0IC8gcmVhZCAvIGZyYW1lXG4gKiBkcmFpbiksIGl0cyBvd24gU1NFIHNwbGl0dGVyLCBpdHMgb3duIGJhY2tvZmYsIGFuZCBhIGBwcm9jZXNzLmV4aXQoMClgIGluIGFcbiAqIHNpZ25hbCBoYW5kbGVyIHNldmVuIGxpbmVzIGluLiBUaGUgc2hhcmVkIGNsaWVudCBpcyB0aGUgc2FtZSBkZXNpZ24sIG9uY2UsIGFuZFxuICogdGhyZWUgdGhpbmdzIGFycml2ZSB3aXRoIGl0IHRoYXQgZ3JhcGV2aW5lIGRpZCBub3QgaGF2ZTpcbiAqXG4gKiAgIDEuICoqQU4gSURMRSBXQVRDSERPRyDigJQgZ3JhcGV2aW5lIGhhZCBOT05FLioqIGBhd2FpdCByZWFkZXIucmVhZCgpYCB3YXNcbiAqICAgICAgdW5ib3VuZGVkLCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYVxuICogICAgICBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSLCBhbmQgYSBwYXJrZWQgdGFpbCBpc1xuICogICAgICBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgcXVpZXQgY2hhbm5lbC4gYFRBSUxfSURMRV9NU2AgaXMgdGhyZWUgb2YgVEhJU1xuICogICAgICBzcGVsbCdzIDMgcyBiZWF0cyAoYC4vaGVhcnRiZWF0LnRzYCksIG5ldmVyIGEgY29waWVkIDQ1LDAwMC5cbiAqICAgMi4gKipBIFNQRUMtQ09SUkVDVCBGUkFNRSBQQVJTRVIuKiogVGhlIGhhbmQtd3JpdHRlbiBvbmUgZGlkXG4gKiAgICAgIGBsaW5lLnNsaWNlKDUpLnRyaW0oKWAsIHdoaWNoIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiB0aGUgb25lXG4gKiAgICAgIGxlYWRpbmcgc3BhY2UgdGhlIHNwZWMgcmVtb3ZlcyDigJQgaXQgd291bGQgY29ycnVwdCBhIG1lc3NhZ2UgYm9keSB3aG9zZVxuICogICAgICBmaXJzdCBsaW5lIGlzIGluZGVudGVkLiBOb3RoaW5nIGluIHRoZSByb3N0ZXIgZW1pdHMgb25lIHRvZGF5OyB0aGUgcGFyc2VcbiAqICAgICAgaXMgcmlnaHQgYW55d2F5IG5vdy5cbiAqICAgMy4gKipBIFNJR05BTCBQQVRIIFRIQVQgRFJBSU5TLioqIFRoZSBvbGQgaGFuZGxlciB3YXNcbiAqICAgICAgYHN0b3BwZWQgPSB0cnVlOyBwcm9jZXNzLmV4aXQoMClgIOKAlCB0aGUgUDBmIGRlZmVjdCBleGFjdGx5LCBhcHBsaWVkIHRvXG4gKiAgICAgIHRoZSB0ZXJtaW5hbCBmcmFtZSBpbiBmaXZlIHNwZWxscyBhbmQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmVcbiAqICAgICAgbGluZXMgYWJvdmUgaXQuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkXG4gKiAgICAgIHN0ZG91dC4gVGhlIGNsaWVudCBSRVRVUk5TIGFuIGV4aXQgY29kZTsgYG1haW5gIGFzc2lnbnMgaXQgYW5kIHJldHVybnNcbiAqICAgICAgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zLlxuICpcbiAqIOKblCBOTyBgZXBvY2hPZmAgLyBgb25FcG9jaENoYW5nZWAsIEFORCBUSEFUIElTIEEgUlVMSU5HLCBOT1QgQU4gT01JU1NJT05cbiAqIChENzApLiBHcmFwZXZpbmUncyBpZHMgYXJlIFJFQ09WRVJFRCBhY3Jvc3MgYSByZXN0YXJ0IOKAlCBgbG9hZENoYW5uZWwoKWBcbiAqIGRlcml2ZXMgYG5leHRfaWRgIGFzIGEgaGlnaC13YXRlciBtYXJrIG92ZXIgdGhlIGR1cmFibGUgYC5qc29ubGAg4oCUIHNvIGFcbiAqIHJlY29ubmVjdGluZyBjdXJzb3IgaXMgc3RpbGwgdmFsaWQgYW5kIHRoZSBjb25kaXRpb24gYW4gZXBvY2ggZGV0ZWN0cyBjYW5ub3RcbiAqIG9jY3VyIGhlcmUuIFdpcmluZyBvbmUgd291bGQgYmUgYSBSRUdSRVNTSU9OIHdpdGggYSBtZWFzdXJlZCBtZWNoYW5pc206XG4gKiBgb25FcG9jaENoYW5nZWAgc2V0cyBgY3Vyc29yID0gMGAsIGFuZCB0aGlzIGRhZW1vbiBhbnN3ZXJzIGBzaW5jZT0wYCB3aXRoXG4gKiBgcmVhZEJhY2tsb2cobmFtZSwgMClgIOKAlCB0aGUgd2hvbGUgY2hhbm5lbCBsb2cgb2ZmIGRpc2ssIGludG8gYW4gYWdlbnQncyBwaXBlLFxuICogb24gZXZlcnkgYGdyYXBldmluZSByb2xsYC5cbiAqXG4gKiDimqAgYHJlc29sdmVgIENBTExTIGBlbnN1cmVEYWVtb25gLCBXSElDSCBDQU4gUkFJU0Ug4oCUIGRlbGliZXJhdGVseSwgYW5kIHRoZSBraXRcbiAqIGRvY3VtZW50cyB0aGUgcHJvcGVydHkgdGhpcyBkZXBlbmRzIG9uOiBpdHMgb3V0ZXIgYmxvY2sgaXMgYSBgdHJ5YC9gZmluYWxseWBcbiAqIHdpdGggTk8gYGNhdGNoYCwgc28gYSBgQ2xpRXJyb3JgIGZyb20gdGhyZWUgZnJhbWVzIGRvd24gcHJvcGFnYXRlcyBpbnRvXG4gKiBgbWFpbmAgaW5zdGVhZCBvZiBiZWluZyByZWFkIGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZCByZXRyaWVkIGZvcmV2ZXIuXG4gKiBDaGVja2VkIGF0IHRoZSBhZG9wdGlvbiByYXRoZXIgdGhhbiBhc3N1bWVkIChwbGF5Ym9vayBCOSBzdGVwIDUpLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKFxuICBuYW1lOiBzdHJpbmcsXG4gIG9wdHM6IHtcbiAgICBzaW5jZT86IG51bWJlcjtcbiAgICBmcm9tU3RhcnQ/OiBib29sZWFuO1xuICAgIGxhc3Q/OiBudW1iZXI7XG4gICAgYXM/OiBzdHJpbmc7XG4gICAgaHVtYW4/OiBib29sZWFuO1xuICAgIGx1cms/OiBib29sZWFuO1xuICAgIG1heD86IG51bWJlcjtcbiAgfSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghbmFtZSlcbiAgICBkaWUoXG4gICAgICBcInVzYWdlOiBncmFwZXZpbmUgdGFpbCA8bmFtZT4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVwiLFxuICAgICk7XG4gIC8vIC0tbHVyayByZWNlaXZlcyBtZXNzYWdlcyBidXQgcmVnaXN0ZXJzIG5vIHByZXNlbmNlIOKAlCBhbiBpbnZpc2libGUgb2JzZXJ2ZXIuXG4gIC8vIEl0IG92ZXJyaWRlcyBpZGVudGl0eSBmbGFncyAoYSBsdXJrZXIgaGFzIG5vIG5hbWUgdG8gc2hvdykuXG4gIGNvbnN0IG15QWxpYXMgPSBvcHRzLmx1cmsgPyB1bmRlZmluZWQgOiBvcHRzLmFzO1xuICBjb25zdCBzaW5jZSA9IG9wdHMuZnJvbVN0YXJ0ID8gMCA6IChvcHRzLnNpbmNlID8/IC0xKTtcbiAgLy8gRW1pdCB0aGUgZ3JvdW5kaW5nIGxpbmUgb25seSBvbiB0aGUgZmlyc3Qgc3Vic2NyaWJlLCBuZXZlciBvbiByZWNvbm5lY3RzXG4gIC8vIChhIHJlY29ubmVjdCByZXN1bWVzIGZyb20gdGhlIGN1cnNvciDigJQgdGhlcmUgaXMgbm8gdW5zZWVuIGhpc3RvcnkgdGhlbikuXG4gIGxldCBncm91bmRlZCA9IGZhbHNlO1xuXG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPFRhaWxQYXlsb2FkPih7XG4gICAgLy8g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRC4gQSB0YWlsIG91dGxpdmVzXG4gICAgLy8gdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3Qg4oCUIGByb2xsYCBhbmQgYHJlc3RhcnRgIGJvdGggcmVwbGFjZSBpdCDigJQgYW5kXG4gICAgLy8gYGVuc3VyZURhZW1vbmAgcmUtcmVhZHMgdGhlIHBvcnQgZmlsZSBhbmQgcmVzcGF3bnMsIHNvIGEgcmVjb25uZWN0IGFmdGVyIGFcbiAgICAvLyByb2xsIGxhbmRzIG9uIHRoZSBORVcgZGFlbW9uIHJhdGhlciB0aGFuIHNwaW5uaW5nIGFnYWluc3QgYSBkZWFkIHBvcnQuXG4gICAgcmVzb2x2ZTogYXN5bmMgKCkgPT4gYGh0dHA6Ly8xMjcuMC4wLjE6JHthd2FpdCBlbnN1cmVEYWVtb24oKX1gLFxuICAgIHBhdGg6IGAvY2hhbm5lbHMvJHtuYW1lfS90YWlsYCxcbiAgICBzaW5jZSxcbiAgICAvLyDimqAgTk8gZW5zdXJlIGNhbGwgYmVmb3JlIHRoZSBzdWJzY3JpYmUuIEEgZnJlc2ggYHRhaWwgbmFtZWAgc3RpbGwgd29ya3NcbiAgICAvLyB3aXRob3V0IGFuIGV4cGxpY2l0IG9wZW4g4oCUIEdFVCDigKYvdGFpbCBjcmVhdGVzIHRoZSBjaGFubmVsIGl0c2VsZiDigJQgYW5kXG4gICAgLy8gdGhhdCBpcyB0aGUgT05MWSB3YXkgdGhlIHN1YnNjcmliZWQgZXZlbnQncyBgY3JlYXRlZGAgZmxhZyBjYW4gZXZlciBiZVxuICAgIC8vIHRydWU6IGFuIGVuc3VyZSBzZW50IGZpcnN0IGNyZWF0ZXMgdGhlIGNoYW5uZWwsIHNvIHRoZSBzdWJzY3JpYmUgdGhhdFxuICAgIC8vIGZvbGxvd3MgYWx3YXlzIHJlcG9ydHMgYGNyZWF0ZWQ6ZmFsc2VgIGFuZCB0aGUgbWlzdHlwZWQtbmFtZSBzaWduYWwgbmV2ZXJcbiAgICAvLyBmaXJlcy5cbiAgICBxdWVyeTogKGN1cnNvciwgZmlyc3RDb25uZWN0KSA9PiB7XG4gICAgICBjb25zdCBxOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgIC8vICM2OCDigJQgYC0tbGFzdCBOYCByaWRlcyB0aGUgRklSU1QgY29ubmVjdGlvbiBvbmx5LiBPbmNlIGFueSBtZXNzYWdlXG4gICAgICAvLyBsYW5kcyB0aGUgY3Vyc29yIGFkdmFuY2VzIGFuZCBhIHJlY29ubmVjdCByZXN1bWVzIGZyb20gaXQgdmlhIGBzaW5jZWAsXG4gICAgICAvLyBuZXZlciByZS1iYWNrZmlsbGluZyB0aGUgd2luZG93LiBgZmlyc3RDb25uZWN0YCBpcyB0aGUga2l0J3MgcGFyYW1ldGVyXG4gICAgICAvLyBmb3IgZXhhY3RseSB0aGlzOyB0aGUgaGFuZC13cml0dGVuIGxvb3Agc3BlbGxlZCBpdCBgaGlnaGVzdFNlZW4gPCAwYCxcbiAgICAgIC8vIHdoaWNoIHdhcyB0aGUgc2FtZSB0ZXN0IGJ5IGFjY2lkZW50IG9mIHRoZSBzZW50aW5lbC5cbiAgICAgIGlmIChvcHRzLmxhc3QgIT09IHVuZGVmaW5lZCAmJiBmaXJzdENvbm5lY3QpIHEubGFzdCA9IFN0cmluZyhvcHRzLmxhc3QpO1xuICAgICAgaWYgKG15QWxpYXMpIHEuYXMgPSBteUFsaWFzO1xuICAgICAgaWYgKG9wdHMuaHVtYW4gJiYgIW9wdHMubHVyaykgcS5odW1hbiA9IFwiMVwiO1xuICAgICAgaWYgKG9wdHMubHVyaykgcS5sdXJrID0gXCIxXCI7XG4gICAgICByZXR1cm4gcTtcbiAgICB9LFxuICAgIGN1cnNvck9mOiAoZXYpID0+ICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgPyBldi5pZCA6IHVuZGVmaW5lZCksXG4gICAgYWNjZXB0OiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAvLyBUaGUgc3Vic2NyaWJlZCBtYXJrZXIgaXMgbm90IGEgbWVzc2FnZTsgYHJlbmRlcmAgYW5zd2VycyBpdC5cbiAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiB0cnVlO1xuICAgICAgLy8gRHJvcCBESVNQT1NJVElPTiBmcmFtZXMg4oCUIHRoZXkgYXJlIG1ldGFkYXRhIGFib3V0IGFub3RoZXIgbWVzc2FnZS4gQVxuICAgICAgLy8gbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgcGFzc2VzIHRocm91Z2g6IGFuIGFnZW50IHRhaWxpbmcgYVxuICAgICAgLy8gY2hhbm5lbCBjb3VsZCBub3QgcHJldmlvdXNseSBzZWUgZWl0aGVyIHBhcnR5IHJldGlyZSBpdCwgYW5kIGZvdW5kIG91dFxuICAgICAgLy8gd2hlbiBpdHMgbmV4dCBzZW5kIHdhcyByZWplY3RlZC5cbiAgICAgIGlmIChpc0Rpc3Bvc2l0aW9uRnJhbWUoZXYpKSByZXR1cm4gZmFsc2U7XG4gICAgICAvLyBTdXBwcmVzcyBzZWxmLWVjaG86IHdoZW4gLS1hcyBpcyBzZXQsIGRyb3AgbWVzc2FnZXMgd2Ugc2VudCBvdXJzZWx2ZXMuXG4gICAgICAvLyBUaGUgc2VuZGVyIGFscmVhZHkgZ290IHRoZSByZWNlaXB0IGFzIHRoZSBQT1NUIHJlc3BvbnNlLCBzbyByZS1lbWl0dGluZ1xuICAgICAgLy8gaXQgb24gdGFpbCBpcyBwdXJlIG5vaXNlLlxuICAgICAgaWYgKG15QWxpYXMgJiYgZXYuZnJvbSA9PT0gbXlBbGlhcykgcmV0dXJuIGZhbHNlO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgICByZW5kZXI6IChwYXlsb2FkLCBmcmFtZSkgPT4ge1xuICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHJlbmRlclN1YnNjcmliZWQocGF5bG9hZCk7XG4gICAgICAvLyAjNjcg4oCUIGZyb250LWxvYWQgYSByZWNvdmVyeSBwb2ludGVyIG9uIEVWRVJZIG1lc3NhZ2UgZnJhbWUsIHNvIHRoZSByZWFkXG4gICAgICAvLyBjb29yZGluYXRlcyBzdXJ2aXZlIGEgZG93bnN0cmVhbSBub3RpZmljYXRpb24gY2xpcC4gTW9uaXRvciB0cnVuY2F0ZXMgYXRcbiAgICAgIC8vIGl0cyBPV04gY2FwIChiZWxvdyBvdXIgaGludCB0aHJlc2hvbGQsIGFuZCBvbmUgd2UgY2Fubm90IG9ic2VydmUgaGVyZSk7IGFcbiAgICAgIC8vIG1lc3NhZ2UgaXQgY2xpcHMgd291bGQgb3RoZXJ3aXNlIGxvc2UgaXRzIHRyYWlsaW5nIGBpZGAgYW5kIGJlY29tZVxuICAgICAgLy8gdW5yZWNvdmVyYWJsZSDigJQgdGhlIHJlYWRlciBpcyBsZWZ0IGluZmVycmluZyB0aGUgaWQuIEV2ZXJ5IGZyYW1lXG4gICAgICAvLyB0aGVyZWZvcmUgY2FycmllcyBhIEZST05ULWxvYWRlZCBgcmVhZCA8Y2hhbm5lbD4gPGlkPmAsIGVpdGhlciBhcyB0aGVcbiAgICAgIC8vIHJpY2hlciBgdHJ1bmNhdGlvbl9oaW50YCAoZ2VudWluZWx5LWxvbmcgbWVzc2FnZXMg4oCUIHRoZSBcIitOIGNoYXJzLFxuICAgICAgLy8geW91J3JlIGRlZmluaXRlbHkgbWlzc2luZyBjb250ZW50XCIgYWxhcm0pIG9yIGFzIHRoZSBjb21wYWN0IGBmdWxsYFxuICAgICAgLy8gcG9pbnRlci4gU2VyaWFsaXppbmcgaXQgYmVmb3JlIHRoZSBsb25nIGAudGV4dGAgaXMgd2hhdCBtYWtlcyBpdCBzdXJ2aXZlXG4gICAgICAvLyB0aGUgY2xpcCAoRjE3KS5cbiAgICAgIGNvbnN0IHJlYWRSZWYgPSBgcmVhZCAke25hbWV9ICR7cGF5bG9hZC5pZH1gO1xuICAgICAgaWYgKFxuICAgICAgICB0eXBlb2YgcGF5bG9hZC50ZXh0ID09PSBcInN0cmluZ1wiICYmXG4gICAgICAgIHBheWxvYWQudGV4dC5sZW5ndGggPiAob3B0cy5tYXggPz8gVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRClcbiAgICAgICkge1xuICAgICAgICBjb25zdCB0cnVuY2F0aW9uX2hpbnQgPSBgKyR7cGF5bG9hZC50ZXh0Lmxlbmd0aH0gY2hhcnMg4oCUIGZ1bGw6ICR7cmVhZFJlZn1gO1xuICAgICAgICAvLyBDYXAgdGhlIElOTElORSBib2R5IHdoZW4gLS1tYXggaXMgc2V0ICh0aGUgZnVsbCBtZXNzYWdlIHN0YXlzIG9uIGRpc2tcbiAgICAgICAgLy8g4oaSIGByZWFkYCk7IHdpdGhvdXQgLS1tYXgsIGVtaXQgdGhlIGZ1bGwgdGV4dCAodG9kYXkncyBkZWZhdWx0KS5cbiAgICAgICAgY29uc3QgdGV4dCA9IG9wdHMubWF4ICE9PSB1bmRlZmluZWQgPyBwYXlsb2FkLnRleHQuc2xpY2UoMCwgb3B0cy5tYXgpIDogcGF5bG9hZC50ZXh0O1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyB0cnVuY2F0aW9uX2hpbnQsIC4uLnBheWxvYWQsIHRleHQgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBmdWxsOiByZWFkUmVmLCAuLi5wYXlsb2FkIH0pO1xuICAgIH0sXG4gICAgLy8gRGFlbW9uIGxpdmVuZXNzIGhlYXJ0YmVhdCAoYDogaGIgPHRzPmApLiBTdXJmYWNlIGEgcmVjb2duaXphYmxlIHNlbnRpbmVsXG4gICAgLy8gb24gc3RkZXJyIHNvIGEgYDI+JjFgIGNvbnN1bWVyIGNhbiB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiAoRjYpLiBLZXB0XG4gICAgLy8gb2ZmIHN0ZG91dCDigJQgdGhlIEpTT05MIHN0cmVhbSBzdGF5cyBwdXJlLlxuICAgIG9uQ29tbWVudDogKHRleHQpID0+ICh0ZXh0LnRyaW1TdGFydCgpLnN0YXJ0c1dpdGgoXCJoYlwiKSA/IFwiOiBncmFwZXZpbmUta2VlcGFsaXZlXCIgOiBudWxsKSxcbiAgICBvbk1hbGZvcm1lZDogKF9mcmFtZSwgZSkgPT4gYCMgYmFkIHNzZSBkYXRhOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLFxuICAgIC8vIFRoZSBmb3VyIGxpbmVzIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCB3cm90ZSwgcHJlc2VydmVkIHZlcmJhdGltIOKAlCBhIHRhaWxcbiAgICAvLyB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIG9uZSB0aGF0IGlzIHdvcmtpbmcuXG4gICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgc3dpdGNoIChpbmZvLmNhdXNlKSB7XG4gICAgICAgIGNhc2UgXCJjb25uZWN0LWZhaWxlZFwiOlxuICAgICAgICAgIHJldHVybiBgIyBjb25uZWN0IGZhaWxlZDogJHtpbmZvLmVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBpbmZvLmVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoaW5mby5lcnJvcil9LCByZXRyeWluZ+KApmA7XG4gICAgICAgIGNhc2UgXCJodHRwXCI6XG4gICAgICAgIGNhc2UgXCJuby1ib2R5XCI6XG4gICAgICAgICAgcmV0dXJuIGAjIHRhaWwgSFRUUCAke2luZm8uc3RhdHVzfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICBjYXNlIFwic3RyZWFtLWVycm9yXCI6XG4gICAgICAgICAgcmV0dXJuIGAjIHN0cmVhbSBkcm9wcGVkOiAke2luZm8uZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGluZm8uZXJyb3IubWVzc2FnZSA6IFN0cmluZyhpbmZvLmVycm9yKX0sIHJlY29ubmVjdGluZ+KApmA7XG4gICAgICAgIGNhc2UgXCJzdHJlYW0tZW5kXCI6XG4gICAgICAgICAgcmV0dXJuIFwiIyBzdHJlYW0gY2xvc2VkLCByZWNvbm5lY3RpbmfigKZcIjtcbiAgICAgIH1cbiAgICB9LFxuICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICB9KTtcblxuICAvKiogVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXI6IHN0ZGVyciBjb250ZXh0LCBwbHVzIGEgc3RydWN0dXJlZCBncm91bmRpbmcgbGluZVxuICAgKiAgb24gc3Rkb3V0IHRoZSBGSVJTVCB0aW1lIG9ubHkuICovXG4gIGZ1bmN0aW9uIHJlbmRlclN1YnNjcmliZWQocGF5bG9hZDogVGFpbFBheWxvYWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyBzdWJzY3JpYmVkIHRvICR7cGF5bG9hZC5jaGFubmVsfSAoc2luY2U9JHtwYXlsb2FkLnNpbmNlfSlcXG5gKTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgdG9waWM6ICR7cGF5bG9hZC50b3BpY31cXG5gKTtcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCB0aGlzIHRhaWwgYnJvdWdodCBpdCBpbnRvIGJlaW5nIChjaGVjayB0aGUgbmFtZSlcXG5gLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWRcXG5gLFxuICAgICAgKTtcbiAgICAvLyBTdHJ1Y3R1cmVkIGdyb3VuZGluZyBvbiBzdGRvdXQgKEYzL0Y3KSDigJQgdW5kZXIgdGhlIGRlZmF1bHQgV2lyaW5nLUJcbiAgICAvLyBNb25pdG9yLCBzdGRvdXQgc3VyZmFjZXMgYXMgbm90aWZpY2F0aW9ucywgc28gYSBmcmVzaCBzdWJzY3JpYmVyIGFjdHVhbGx5XG4gICAgLy8gc2VlcyB0aGUgdG9waWMgKyB0aGF0IGVhcmxpZXIgaGlzdG9yeSBleGlzdHMuIEdhdGVkOiBvbmx5IHdoZW4gdGhlcmUnc1xuICAgIC8vIHNvbWV0aGluZyB0byBncm91bmQgKHVuc2VlbiBoaXN0b3J5IG9yIGEgdG9waWMpLCBhbmQgb25seSBvbiB0aGUgZmlyc3RcbiAgICAvLyBzdWJzY3JpYmUgKG5vdCByZWNvbm5lY3RzKS5cbiAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICBjb25zdCBsYXRlc3QgPSB0eXBlb2YgcGF5bG9hZC5sYXRlc3RfaWQgPT09IFwibnVtYmVyXCIgPyBwYXlsb2FkLmxhdGVzdF9pZCA6IDA7XG4gICAgY29uc3QgZWFybGllciA9IHNpbmNlIDwgMCA/IGxhdGVzdCA6IE1hdGgubWF4KDAsIE1hdGgubWluKHNpbmNlLCBsYXRlc3QpKTtcbiAgICAvLyBgY3JlYXRlZGAgYW5kIGBhcmNoaXZlZGAgam9pbiB0aGUgZ2F0ZSBvbiBwdXJwb3NlLiBBIGNoYW5uZWwgdGhpc1xuICAgIC8vIHN1YnNjcmliZSBqdXN0IG1hZGUgaGFzIG5vIHRvcGljIGFuZCBubyBoaXN0b3J5LCBzbyB0aGUgb2xkIGNvbmRpdGlvblxuICAgIC8vIChgZWFybGllciA+IDAgfHwgdG9waWNgKSBpcyBleGFjdGx5IHRoZSBjYXNlIHRoYXQgZW1pdHMgTk9USElORzsgYW5kIGFuXG4gICAgLy8gQVJDSElWRUQgY2hhbm5lbCdzIGdyb3VuZGluZyBsaW5lIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgaGVhbHRoeVxuICAgIC8vIG9uZSdzLCBzbyBhIGxhdGUgam9pbmVyIHN0aWxsIGxlYXJuZWQgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQgb25seSB3aGVuXG4gICAgLy8gaXRzIHNlbmQgYm91bmNlZC5cbiAgICAvL1xuICAgIC8vIOKaoCBUaGUgaGludHMgQUNDVU1VTEFURSBpbnRvIGEgbGlzdCByYXRoZXIgdGhhbiBhc3NpZ25pbmcgdG8gb25lIGZpZWxkLlxuICAgIC8vIFRoZXkgdXNlZCB0byBiZSB0aHJlZSBhc3NpZ25tZW50cyB0byBgZ3JvdW5kaW5nLmhpbnRgLCBvcmRlcmVkIHNvIHRoZSBtb3N0XG4gICAgLy8gaW1wb3J0YW50IHdvbiDigJQgd2hpY2ggaXMgYSBoaW50IHRoYXQgY2FuIHNpbGVudGx5IGxvc2UgdG8gYW5vdGhlciBoaW50LFxuICAgIC8vIHRoZSBmYWlsdXJlIG1vZGUgdGhpcyB3aG9sZSBicmFuY2ggaXMgYWJvdXQsIHNpdHRpbmcgaW4gdGhlIGZpeCBmb3IgaXQuIEFcbiAgICAvLyBsaXN0IGNhbm5vdCBvdmVyd3JpdGU6IGFuIGFyY2hpdmVkIGNoYW5uZWwgV0lUSCBoaXN0b3J5IG5vdyBzYXlzIGJvdGguXG4gICAgY29uc3QgaGludHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKGVhcmxpZXIgPiAwKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7ZWFybGllcn0gZWFybGllciBtZXNzYWdlKHMpIGV4aXN0IOKAlCB1c2UgLS1mcm9tLXN0YXJ0IG9yIC0tc2luY2UgPGlkPiB0byBiYWNrZmlsbGAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgdGhpcyB0YWlsIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCBubyBzdWNoIGNoYW5uZWwgZXhpc3RlZDsgY2hlY2sgdGhlIG5hbWUsIG9yIGFub3RoZXIgcGFydHkgaGFzIHlldCB0byBvcGVuIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkIHVudGlsIHNvbWVvbmUgdW5hcmNoaXZlcyBpdGAsXG4gICAgICApO1xuICAgIGlmICghKGVhcmxpZXIgPiAwIHx8IHBheWxvYWQudG9waWMgfHwgcGF5bG9hZC5jcmVhdGVkIHx8IHBheWxvYWQuYXJjaGl2ZWQpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBncm91bmRpbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAga2luZDogXCJncm91bmRpbmdcIixcbiAgICAgIGNoYW5uZWw6IHBheWxvYWQuY2hhbm5lbCxcbiAgICAgIGpvaW5lZF9hdDogc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5taW4oc2luY2UsIGxhdGVzdCksXG4gICAgICBlYXJsaWVyLFxuICAgIH07XG4gICAgaWYgKHBheWxvYWQudG9waWMpIGdyb3VuZGluZy50b3BpYyA9IHBheWxvYWQudG9waWM7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZCkgZ3JvdW5kaW5nLmNyZWF0ZWQgPSB0cnVlO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKSBncm91bmRpbmcuYXJjaGl2ZWQgPSB0cnVlO1xuICAgIGlmIChoaW50cy5sZW5ndGgpIGdyb3VuZGluZy5oaW50ID0gaGludHMuam9pbihcIiDCtyBcIik7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGdyb3VuZGluZyk7XG4gIH1cbn1cbmZ1bmN0aW9uIGZvbGREaXNwb3NpdGlvbnMobmFtZTogc3RyaW5nKSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8XG4gICAgbnVtYmVyLFxuICAgIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBzdHJpbmc7XG4gICAgICBmcm9tOiBzdHJpbmc7XG4gICAgICB0czogbnVtYmVyO1xuICAgICAgbm90ZTogc3RyaW5nO1xuICAgICAgcmVvcGVuczogbnVtYmVyO1xuICAgIH1cbiAgPigpO1xuICBjb25zdCBwYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBtYXA7XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgIT09IFwic3RhdHVzXCIgfHwgdHlwZW9mIG0udGFyZ2V0ICE9PSBcIm51bWJlclwiIHx8IHR5cGVvZiBtLmRpc3Bvc2l0aW9uICE9PSBcInN0cmluZ1wiKVxuICAgICAgY29udGludWU7XG4gICAgY29uc3QgcHJldiA9IG1hcC5nZXQobS50YXJnZXQpO1xuICAgIGNvbnN0IHJlb3BlbnMgPVxuICAgICAgKHByZXY/LnJlb3BlbnMgPz8gMCkgK1xuICAgICAgKG0uZGlzcG9zaXRpb24gPT09IFwib3BlblwiICYmIHByZXYgJiYgcHJldi5kaXNwb3NpdGlvbiAhPT0gXCJvcGVuXCIgPyAxIDogMCk7XG4gICAgbWFwLnNldChtLnRhcmdldCwge1xuICAgICAgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24sXG4gICAgICBmcm9tOiBtLmZyb20sXG4gICAgICB0czogbS50cyxcbiAgICAgIG5vdGU6IG0udGV4dCxcbiAgICAgIHJlb3BlbnMsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cbi8vIFRXTyB0aGluZ3Mgbm93IHdlYXIga2luZDpcInN0YXR1c1wiLiBBIERJU1BPU0lUSU9OIGZyYW1lIGFjdHMgb24gYSBzcGVjaWZpY1xuLy8gbWVzc2FnZSAoYHRhcmdldGAgKyBgZGlzcG9zaXRpb25gKSBhbmQgaXMgbWV0YWRhdGEg4oCUIGBwdWxsYCBhbmQgYHRhaWxgIGZvbGRcbi8vIGl0IGF3YXkgYW5kIGJhZGdlIHRoZSBtZXNzYWdlIGl0IHBvaW50cyBhdCBpbnN0ZWFkLiBBIExJRkVDWUNMRSBmcmFtZVxuLy8gKGFyY2hpdmUgLyB1bmFyY2hpdmUpIGlzIGEgZmFjdCBhYm91dCB0aGUgQ0hBTk5FTDogaXQgdGFyZ2V0cyBub3RoaW5nLCBhbmQgaXRcbi8vIGlzIHRoZSB3aG9sZSBwb2ludCB0aGF0IGEgcmVhZGVyIHNlZXMgaXQuIERpc2NyaW1pbmF0aW5nIG9uIGBkaXNwb3NpdGlvbmBcbi8vIHJhdGhlciB0aGFuIG9uIGBldmVudGAga2VlcHMgYSBmcmFtZSBmcm9tIHNvbWUgZnV0dXJlIGVtaXR0ZXIgdmlzaWJsZSBieVxuLy8gZGVmYXVsdCDigJQgdGhlIGZhaWx1cmUgbW9kZSBoZXJlIGlzIHN3YWxsb3dpbmcgYSBzaWduYWwsIG5vdCBzaG93aW5nIG9uZS5cbmZ1bmN0aW9uIGlzRGlzcG9zaXRpb25GcmFtZShtOiB7IGtpbmQ/OiBzdHJpbmc7IGRpc3Bvc2l0aW9uPzogc3RyaW5nIH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG0ua2luZCA9PT0gXCJzdGF0dXNcIiAmJiB0eXBlb2YgbS5kaXNwb3NpdGlvbiA9PT0gXCJzdHJpbmdcIjtcbn1cblxuLy8gXCJvcGVuXCIgPSBubyBlbnRyeSwgb3IgbGF0ZXN0IGRpc3Bvc2l0aW9uIGlzIFwib3BlblwiXG5mdW5jdGlvbiBpc09wZW4oZD86IHsgZGlzcG9zaXRpb246IHN0cmluZyB9KSB7XG4gIHJldHVybiAhZCB8fCBkLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIjtcbn1cblxuLy8gUmVhZHMgdGhlIGZ1bGwgY2hhbm5lbCBsb2csIGRyb3BzIEVWRVJZIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSwgYW5kIGJhZGdlcyBlYWNoXG4vLyByZW1haW5pbmcgbWVzc2FnZSB3aXRoIGl0cyBsYXRlc3QgZGlzcG9zaXRpb24gdmlhIGZvbGREaXNwb3NpdGlvbnMuXG4vL1xuLy8gRXZlcnkgb25lLCBkZWxpYmVyYXRlbHkg4oCUIGluY2x1ZGluZyBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpLFxuLy8gd2hpY2ggYHB1bGxgIGFuZCBgdGFpbGAgZG8gbGV0IHRocm91Z2guIFRoaXMgZmVlZHMgYHRyaWFnZWAsIHdob3NlIG9wZW4gcXVldWVcbi8vIGlzIFwid2hhdCBpcyBsZWZ0IHRvIGFjdCBvblwiLCBhbmQgYW4gYXJjaGl2ZSBpcyBhbiBGWUksIG5vdCBhIHdvcmsgaXRlbS4gU2FtZVxuLy8gcmVhc29uIGB0b3BpY2AgYW5kIGBhbm5vdW5jZW1lbnRgIGFyZSBmb2xkZWQgb3V0IG9mIHRoZSBvcGVuIGJ1Y2tldCBiZWxvdy5cbmZ1bmN0aW9uIGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQoXG4gIG5hbWU6IHN0cmluZyxcbik6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdIHtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSByZXR1cm4gW107XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBtZXNzYWdlczogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCA9PT0gXCJzdGF0dXNcIikgY29udGludWU7XG4gICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgIGlmIChkKSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWVzc2FnZXMucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1lc3NhZ2VzO1xufVxuXG50eXBlIEJhZGdlZE1lc3NhZ2UgPSBNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9O1xuXG4vLyBEYXNoYm9hcmQgcmVuZGVyIG9mIGEgdHJpYWdlIHNjYW46IHRoZSBvcGVuIHF1ZXVlIG9uIHRvcCwgdGhlbiBlYWNoXG4vLyBkaXNwb3NpdGlvbiBncm91cCwgb25lIHNjYW5uYWJsZSBsaW5lIHBlciBtZXNzYWdlLiBNaXJyb3JzIGByZWFkIC0tdGV4dGBcbi8vIHByb3NlIG1vZGUgc28gYSBodW1hbiAob3IgYW4gYWdlbnQpIHJlYWRzIGl0IHdpdGhvdXQgcGFyc2luZyBKU09OLlxuZnVuY3Rpb24gcmVuZGVyVHJpYWdlSHVtYW4oXG4gIG5hbWU6IHN0cmluZyxcbiAgb3BlbjogQmFkZ2VkTWVzc2FnZVtdLFxuICBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4sXG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lID0gKG06IEJhZGdlZE1lc3NhZ2UpID0+IHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG0udHMpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKTtcbiAgICBjb25zdCByZW9wZW4gPSBtLnJlb3BlbnMgJiYgbS5yZW9wZW5zID4gMCA/IGAg4oa7JHttLnJlb3BlbnN9YCA6IFwiXCI7XG4gICAgY29uc3QgaGVhZCA9IG0udGV4dC5zcGxpdChcIlxcblwiKVswXTtcbiAgICBjb25zdCBwcmV2aWV3ID0gaGVhZC5sZW5ndGggPiAxMDAgPyBgJHtoZWFkLnNsaWNlKDAsIDk5KX3igKZgIDogaGVhZDtcbiAgICByZXR1cm4gYCAgWyR7bS5pZH0ke3Jlb3Blbn1dICR7bS5mcm9tfSDCtyAke3RzfSDCtyAke3ByZXZpZXd9YDtcbiAgfTtcbiAgY29uc3Qgc2VjdGlvbnMgPSBbYCR7bmFtZX0gwrcgdHJpYWdlXFxuYCwgYE9QRU4gKCR7b3Blbi5sZW5ndGh9KWBdO1xuICBzZWN0aW9ucy5wdXNoKG9wZW4ubGVuZ3RoID8gb3Blbi5tYXAobGluZSkuam9pbihcIlxcblwiKSA6IFwiICDigJRcIik7XG4gIGZvciAoY29uc3QgW3N0YXR1cywgaXRlbXNdIG9mIE9iamVjdC5lbnRyaWVzKGJ5X3N0YXR1cykpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGBcXG4ke3N0YXR1cy50b1VwcGVyQ2FzZSgpfSAoJHtpdGVtcy5sZW5ndGh9KWAsIGl0ZW1zLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuICByZXR1cm4gYCR7c2VjdGlvbnMuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUcmlhZ2UobmFtZTogc3RyaW5nLCBvcHRzOiB7IGh1bWFuPzogYm9vbGVhbiB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRyaWFnZSA8Y2hhbm5lbD4gWy0taHVtYW5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIHRyaWFnZSByZWFkcyB0aGUgbG9nIGZpbGUsIG5vdCBhIHJvdXRlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24g4oCUIGFuZFxuICAvLyBhbiBlbXB0eSBkYXNoYm9hcmQgZm9yIGEgY2hhbm5lbCB0aGF0IGRvZXMgbm90IGV4aXN0IGlzIHRoZSBzYW1lIHNpbGVudCBsaWVcbiAgLy8gYXMgYW4gZW1wdHkgYHB1bGxgLlxuICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgY29uc3Qgb3BlbjogQmFkZ2VkTWVzc2FnZVtdID0gW107XG4gIGNvbnN0IGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPiA9IHt9O1xuICBmb3IgKGNvbnN0IG0gb2YgYmFkZ2VkKSB7XG4gICAgLy8gaXNPcGVuIGV4cGVjdHMgYSBkaXNwb3NpdGlvbiBlbnRyeSBvYmplY3QgKG9yIHVuZGVmaW5lZCBmb3Igbm8gZW50cnkpLlxuICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgaWYgKGlzT3BlbihkaXNwQXJnKSkge1xuICAgICAgLy8gVGhlIG9wZW4gcXVldWUgaXMgc2lnbmFsLW9ubHk6IHNraXAgbm9uLWFjdGlvbmFibGUgZnJhbWVzICh0b3BpYy9cbiAgICAgIC8vIGFubm91bmNlbWVudCBGWUlzIGNhbiBuZXZlciBjYXJyeSBhIGRpc3Bvc2l0aW9uLCBzbyB0aGV5J2Qgb3RoZXJ3aXNlXG4gICAgICAvLyBwYWQgXCJ3aGF0J3MgbGVmdD9cIiBmb3JldmVyKS5cbiAgICAgIGlmIChtLmtpbmQgPT09IFwibWVzc2FnZVwiKSBvcGVuLnB1c2gobSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGtleSA9IG0uZGlzcG9zaXRpb24gPz8gXCJ1bmtub3duXCI7XG4gICAgICBpZiAoIWJ5X3N0YXR1c1trZXldKSBieV9zdGF0dXNba2V5XSA9IFtdO1xuICAgICAgYnlfc3RhdHVzW2tleV0ucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgaWYgKG9wdHMuaHVtYW4pIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShyZW5kZXJUcmlhZ2VIdW1hbihuYW1lLCBvcGVuLCBieV9zdGF0dXMpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG9wZW4sIGJ5X3N0YXR1cyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kR3JlcChuYW1lOiBzdHJpbmcsIHBhdHRlcm46IHN0cmluZywgb3B0czogeyBsaXRlcmFsPzogYm9vbGVhbjsgZnJvbT86IHN0cmluZyB9KSB7XG4gIGlmICghbmFtZSB8fCAhcGF0dGVybilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGdyZXAgPGNoYW5uZWw+IDxwYXR0ZXJuPiBbLS1saXRlcmFsfC1GXSBbLS1mcm9tIDxhbGlhcz5dXCIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgbWF0Y2hlcjogKHRleHQ6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgaWYgKG9wdHMubGl0ZXJhbCkge1xuICAgIGNvbnN0IG5lZWRsZSA9IHBhdHRlcm4udG9Mb3dlckNhc2UoKTtcbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUpO1xuICB9IGVsc2Uge1xuICAgIGxldCByZTogUmVnRXhwO1xuICAgIHRyeSB7XG4gICAgICByZSA9IG5ldyBSZWdFeHAocGF0dGVybiwgXCJpXCIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRpZShgaW52YWxpZCByZWdleDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCwgXCJ1c2FnZVwiKTtcbiAgICB9XG4gICAgbWF0Y2hlciA9ICh0ZXh0KSA9PiByZS50ZXN0KHRleHQpO1xuICB9XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpO1xuICBjb25zdCBtZXNzYWdlczogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGxldCBtc2c6IFBhcnRpYWw8TWVzc2FnZT47XG4gICAgdHJ5IHtcbiAgICAgIG1zZyA9IEpTT04ucGFyc2UobGluZSkgYXMgUGFydGlhbDxNZXNzYWdlPjtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAob3B0cy5mcm9tICYmIG1zZy5mcm9tICE9PSBvcHRzLmZyb20pIGNvbnRpbnVlO1xuICAgIGlmICghbWF0Y2hlcihtc2cudGV4dCkpIGNvbnRpbnVlO1xuICAgIG1lc3NhZ2VzLnB1c2gobXNnKTtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXMgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZENsb3NlKG5hbWU6IHN0cmluZykge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgY2xvc2UgPG5hbWU+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSBkaWUoXCJubyBkYWVtb24gcnVubmluZ1wiLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdGF0dXNSZXNwb25zZT4ocG9ydCwgXCJERUxFVEVcIiwgYC9jaGFubmVscy8ke25hbWV9YCk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc2V0KG5hbWU6IHN0cmluZywgb3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9O1xuICBpZiAob3B0cy5mb3JjZSkgYm9keS5mb3JjZSA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgc3Vic2NyaWJlcnM/OiBudW1iZXIgfT4oXG4gICAgcG9ydCxcbiAgICBcIlBPU1RcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vcmVzZXRgLFxuICAgIGJvZHksXG4gICk7XG4gIGlmIChzdGF0dXMgPT09IDQwOSAmJiBkYXRhPy5lcnJvciA9PT0gXCJsaXZlXCIpIHtcbiAgICBkaWUoXG4gICAgICBgY2hhbm5lbCBoYXMgJHtkYXRhLnN1YnNjcmliZXJzfSBsaXZlIHN1YnNjcmliZXIocykg4oCUIHJlZnVzaW5nIHRvIGNsZWFyIGEgbGl2ZSBzZXNzaW9uLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIGNsZWFyIGFueXdheSAodGhlIGxvZyBpcyBzbmFwc2hvdHRlZCBmaXJzdCkuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEFyY2hpdmUgKHJlYWQtb25seSkgb3IgdW5hcmNoaXZlIGEgY2hhbm5lbCAoVjEuNykg4oCUIHRoZSBub24tZGVzdHJ1Y3RpdmVcbi8vIGFsdGVybmF0aXZlIHRvIGNsb3NlOiBoaXN0b3J5IGlzIHByZXNlcnZlZCwgc2VuZHMgYXJlIHJlamVjdGVkLCBhbmQgdGhlIG5hbWVcbi8vIGlzIGxvY2tlZCBmcm9tIHJlLW9wZW4gdW50aWwgdW5hcmNoaXZlZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZE1hcmsoXG4gIG5hbWU6IHN0cmluZyxcbiAgaWQ6IG51bWJlcixcbiAgZGlzcG9zaXRpb246IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICBvcHRzOiB7IG5vdGU/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkgfHwgIWRpc3Bvc2l0aW9uKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgbWFyayA8Y2hhbm5lbD4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSBbLS1hcyA8YWxpYXM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgZnJvbSwgdGFyZ2V0OiBpZCwgZGlzcG9zaXRpb24gfTtcbiAgaWYgKG9wdHMubm90ZSAhPT0gdW5kZWZpbmVkKSBib2R5Lm5vdGUgPSBvcHRzLm5vdGU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZT4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9zdGF0dXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhIGFzIHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1cyk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQXJjaGl2ZShuYW1lOiBzdHJpbmcsIHVuYXJjaGl2ZTogYm9vbGVhbiwgZnJvbT86IHN0cmluZykge1xuICBjb25zdCB2ZXJiID0gdW5hcmNoaXZlID8gXCJ1bmFyY2hpdmVcIiA6IFwiYXJjaGl2ZVwiO1xuICBpZiAoIW5hbWUpIGRpZShgdXNhZ2U6IGdyYXBldmluZSAke3ZlcmJ9IDxjaGFubmVsPmApO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJvdGggcm91dGVzIGFwcGVuZCBhIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSB0byB0aGUgbG9nLCBzbyB3aG8gZGlkIGl0IGlzIHdvcnRoXG4gIC8vIHJlY29yZGluZyB3aGVuIHRoZSBjYWxsZXIgdG9sZCB1cy4gSWRlbnRpdHkgaXMgb3B0aW9uYWwgaGVyZSAoaXQgaXMgb24gdGhlXG4gIC8vIGdsb2JhbGx5LWFjY2VwdGVkIC0tYXMvLS1mcm9tKSwgYW5kIHRoZSBkYWVtb24gc2lnbnMgXCJzeXN0ZW1cIiB3aXRob3V0IGl0LlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS8ke3ZlcmJ9YCxcbiAgICBmcm9tID8geyBmcm9tIH0gOiB1bmRlZmluZWQsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0b3Aob3B0czogeyBob2xkU2Vjb25kcz86IG51bWJlciB9ID0ge30pIHtcbiAgbGV0IGhlbGRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBpZiAob3B0cy5ob2xkU2Vjb25kcyAmJiBvcHRzLmhvbGRTZWNvbmRzID4gMCkge1xuICAgIGhlbGRVbnRpbCA9IERhdGUubm93KCkgKyBvcHRzLmhvbGRTZWNvbmRzICogMTAwMDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhIT0xEX0ZJTEUsIFN0cmluZyhoZWxkVW50aWwpKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGRhZW1vbjogZmFsc2UsXG4gICAgICAuLi4oaGVsZFVudGlsICE9PSB1bmRlZmluZWQgPyB7IGhlbGRfdW50aWw6IGhlbGRVbnRpbCB9IDoge30pLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wcGVkOiB0cnVlLFxuICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBQZXItY2hhbm5lbCBsaXZlLWNvbm5lY3Rpb24gc3VtbWFyeSDigJQgdGhlIHJlc3RhcnQtc2FmZXR5IHJlYWQuIE1pcnJvcnMgd2hhdFxuLy8gYGRvY3RvcmAgcmVwb3J0cyB1bmRlciBhY3RpdmVfc3Vic2NyaWJlcnM7IG9ubHkgcG9wdWxhdGVkIGNoYW5uZWxzIGFyZSBsaXN0ZWQuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKFxuICBwb3J0OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgdG90YWw6IG51bWJlcjsgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+IH0+IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgY29uc3QgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgZm9yIChjb25zdCBjaCBvZiBkYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgdG90YWwgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICBpZiAoY2guY29ubmVjdGlvbnMgPiAwKSBjaGFubmVscy5wdXNoKHsgbmFtZTogY2gubmFtZSwgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zIH0pO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnQg4oCUIGEgcHJlc2VuY2UgaGljY3VwIHNob3VsZG4ndCBjcmFzaCBhIGxpZmVjeWNsZSB2ZXJiXG4gIH1cbiAgcmV0dXJuIHsgdG90YWwsIGNoYW5uZWxzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXJ0KCkge1xuICAvLyBFbnN1cmUtcnVubmluZywgbm8gY2hhbm5lbCBzaWRlLWVmZmVjdC4gSWRlbXBvdGVudDogcmVwb3J0IGFuIGV4aXN0aW5nXG4gIC8vIGRhZW1vbiwgb3Igc3Bhd24gYSBmcmVzaCBvbmUuIFRoZSBleHBsaWNpdCBcImJyaW5nIGl0IHVwXCIgdmVyYiDigJQgZGlhZ25vc3RpY3NcbiAgLy8gKGRvY3Rvci9pbmZvL2xpc3QpIHN0YXkgcmVhZC1vbmx5IGFuZCBuZXZlciBzcGF3bi5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIWV4aXN0aW5nICYmIGhvbGRBY3RpdmUoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBoZWxkOiB0cnVlLCBwb3J0OiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwb3J0ID0gZXhpc3RpbmcgPz8gKGF3YWl0IGVuc3VyZURhZW1vbigpKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHBvcnQsIGFscmVhZHlfcnVubmluZzogZXhpc3RpbmcgIT09IG51bGwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc3RhcnQob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gTm90aGluZyB0byB0ZWFyIGRvd24g4oCUIGp1c3QgYnJpbmcgYSBmcmVzaCBkYWVtb24gdXAuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTQUZFVFk6IGEgcmVzdGFydCBmb3JjZXMgZXZlcnkgY29ubmVjdGVkIGNsaWVudCB0byBhdXRvLXJlY29ubmVjdC4gUmVmdXNlIHRvXG4gIC8vIHRlYXIgZG93biBhIHdvcmtpbmcgZmxlZXQgdW5sZXNzIGV4cGxpY2l0bHkgZm9yY2VkIOKAlCBuZXZlciBzaWxlbnRseSBkcm9wIGl0LlxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcmVzdGFydDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7Y2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIOKAlCAke3doZXJlfS4gYCArXG4gICAgICAgIFwiQSByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gYWxsIHRvIHJlY29ubmVjdC4gUmUtcnVuIHdpdGggLS1mb3JjZSAob3IgLS15ZXMpIHRvIHByb2NlZWQgYW55d2F5LlwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FwdHVyZSB0aGUgcGlkIHdlJ3JlIHJlcGxhY2luZywgZm9yIHRoZSByZWNlaXB0LlxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgcHJldmlvdXNQaWQgPSBkYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wLCB0aGVuIHdhaXQgZm9yIHRoZSBvbGQgZGFlbW9uIHRvIGFjdHVhbGx5IGdvIGF3YXkg4oCUIGl0IHVubGlua3MgaXRzXG4gIC8vIHBvcnQvcGlkIGZpbGVzIG9uIHNodXRkb3duLCBzbyBlbnN1cmVEYWVtb24gc3Bhd25zIGZyZXNoIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRpc2NvdmVyaW5nIHRoZSBkeWluZyBvbmUuXG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCB9KTtcbn1cblxuLy8gYjMg4oCUIFRIRSBWRVJTSU9OIFZFUklGWSwgQVMgT05FIFNPVVJDRSBGT1IgQk9USCBQQVRIUy5cbi8vXG4vLyBgcm9sbGAgaXMgZG9jdW1lbnRlZCBhcyBcInRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcCDigKYgKyB2ZXJzaW9uIHZlcmlmeVwiLCBhbmRcbi8vIHRoZSB2ZXJpZnkgaGFkIHR3byB3YXlzIHRvIHNheSBub3RoaW5nOlxuLy9cbi8vICAgQ09MRCBQQVRIIOKAlCBubyBkYWVtb24gcnVubmluZzogaXQgc3Bhd25lZCBvbmUgYW5kIHByaW50ZWQgbmVpdGhlciBgdmVyc2lvbmBcbi8vICAgbm9yIGB2ZXJzaW9uX29rYC4gVGhlIGZpZWxkcyB3ZXJlIEFCU0VOVCwgc28gYSBjYWxsZXIgY2hlY2tpbmcgdGhlIHZlcmlmeVxuLy8gICBnb3QgYHVuZGVmaW5lZGAgb24gdGhlIGV4YWN0IHBhdGggd2hlcmUgdGhlIHZlcmlmeSBuZXZlciBoYXBwZW5lZC5cbi8vXG4vLyAgIFdBUk0gUEFUSCDigJQgdGhlIHByb2JlIHdhcyB3cmFwcGVkIGluIGBjYXRjaCB7fWAsIGxlYXZpbmcgYHZlcnNpb24gPSBudWxsYCxcbi8vICAgYW5kIGB2ZXJzaW9uX29rOiBudWxsID09PSBQTFVHSU5fVkVSU0lPTmAgZXZhbHVhdGVzIHRvIEZBTFNFLiBcIkkgY291bGQgbm90XG4vLyAgIGNoZWNrXCIgd2FzIHJlcG9ydGVkIGFzIFwidGhlIHZlcnNpb24gaXMgV1JPTkdcIiDigJQgYSBib29sZWFuIHRoYXQgY2Fubm90IHNheVxuLy8gICBcInVua25vd25cIiBpcyB0aGUgY2Fub25pY2FsIHNoYXBlIG9mIHRoaXMgc3ByaW50J3MgZGVmZWN0LCBhbmQgZmFsc2UgaXMgdGhlXG4vLyAgIHdvcnN0IGF2YWlsYWJsZSBhbnN3ZXIgYmVjYXVzZSBpdCBpcyBhY3Rpb25hYmxlIGFuZCBpbmNvcnJlY3QuXG4vL1xuLy8gU28gYHZlcnNpb25fb2tgIGlzIG5vdyBgYm9vbGVhbiB8IG51bGxgOiBudWxsIG1lYW5zIFVOQ0hFQ0tFRCwgbmV2ZXIgZmFsc2UuXG4vLyBgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uYCBpcyBwcmVzZW50LWFuZC1udWxsIGJlc2lkZSBpdCwgYmVjYXVzZSBhIGJhcmUgbnVsbFxuLy8gdGVsbHMgYSBjYWxsZXIgdGhlIGNoZWNrIGRpZCBub3QgaGFwcGVuIGFuZCBub3Qgd2h5LlxuLy9cbi8vIE9uZSBoZWxwZXIgcmF0aGVyIHRoYW4gdHdvIGNhbGwgc2l0ZXM6IGEgc2Vjb25kIGNvcHkgb2YgdGhpcyBsb2dpYyBvbiB0aGUgY29sZFxuLy8gcGF0aCBpcyB0aGUgbWlycm9yLWRyaWZ0IHRyYXAsIGFuZCB0aGUgY29sZCBwYXRoIGlzIHByZWNpc2VseSB0aGUgb25lIG5vYm9keVxuLy8gcmUtcmVhZHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVWZXJzaW9uKHBvcnQ6IG51bWJlcik6IFByb21pc2U8e1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB2ZXJzaW9uX29rOiBib29sZWFuIHwgbnVsbDtcbiAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBzdHJpbmcgfCBudWxsO1xufT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHYgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAodiA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBcInRoZSBkYWVtb24gYW5zd2VyZWQgYnV0IHJlcG9ydGVkIG5vIHZlcnNpb25cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IHZlcnNpb246IHYsIHZlcnNpb25fb2s6IHYgPT09IFBMVUdJTl9WRVJTSU9OLCB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IG51bGwgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogYGNvdWxkIG5vdCByZWFjaCB0aGUgZGFlbW9uIHRvIHZlcmlmeTogJHtcbiAgICAgICAgZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJvbGwob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gQ09MRCBQQVRIIOKAlCBub3RoaW5nIHdhcyBydW5uaW5nLCBzbyB0aGlzIGlzIGEgc3RhcnQgcmF0aGVyIHRoYW4gYSByb2xsLlxuICAgIC8vIEl0IHN0aWxsIHJlcG9ydHMgdGhlIHZlcmlmeSwgYmVjYXVzZSBcIm5vIGRhZW1vbiB3YXMgdXBcIiBpcyBub3QgYSByZWFzb24gdG9cbiAgICAvLyBzdGF5IHNpbGVudCBhYm91dCB3aGljaCB2ZXJzaW9uIGlzIG5vdyBzZXJ2aW5nLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgcm9sbGVkOiB0cnVlLFxuICAgICAgcHJldmlvdXNfcGlkOiBudWxsLFxuICAgICAgcG9ydDogZnJlc2gsXG4gICAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByb2xsOiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSDigJQgJHt3aGVyZX0uIFRoZXknbGwgYXV0by1yZWNvbm5lY3QgYWNyb3NzIHRoZSByb2xsLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIHByb2NlZWQuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcHJldmlvdXNQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3Agd2l0aCBhIHNob3J0IGhvbGQgc28gYSBzdGFsZSBDTEkgY2FuJ3Qgd2luIHRoZSByZXNwYXduIHJhY2U7IHdlIGhvbGQgdGhlIHNwYXduIG91cnNlbHZlcy5cbiAgY29uc3QgaG9sZE1zID0gNDAwMDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKERhdGUubm93KCkgKyBob2xkTXMpKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgaWYgKChhd2FpdCByZWFkRGFlbW9uUG9ydCgpKSA9PT0gbnVsbCkgYnJlYWs7XG4gIH1cbiAgcmVsZWFzZUhvbGQoKTsgLy8gb3VyIHR1cm4gdG8gc3Bhd24gdGhlIG5ldyB2ZXJzaW9uXG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGxldCBwaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIHBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KGZyZXNoLCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgcm9sbGVkOiB0cnVlLFxuICAgIHByZXZpb3VzX3BpZDogcHJldmlvdXNQaWQsXG4gICAgcGlkLFxuICAgIHBvcnQ6IGZyZXNoLFxuICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhdGNoKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAvLyBDaGFubmVsIG5hbWUgaXMgb3B0aW9uYWwg4oCUIHRoZSBwYWdlIHJlYWRzIGl0IGZyb20gdGhlIFVSTCBoYXNoIGFuZFxuICAvLyBkZWZhdWx0cyB0byBcImxvYmJ5XCIgaWYgYWJzZW50LiBXZSBwYXNzIHRocm91Z2ggd2hhdGV2ZXIgdGhlIHVzZXIgZ2F2ZVxuICAvLyAob3IgXCJsb2JieVwiKSBhbmQgb3BlbiB0aGUgYnJvd3Nlci4gRGFlbW9uIGlzIGVuc3VyZWQgc28gdGhlIHNlcnZlZFxuICAvLyAvd2F0Y2ggSFRNTCBpcyByZWFjaGFibGUuXG4gIGNvbnN0IGNoYW5uZWwgPSBuYW1lPy50cmltKCkgPyBuYW1lLnRyaW0oKSA6IFwibG9iYnlcIjtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBFbnN1cmUgdGhlIGNoYW5uZWwgZXhpc3RzIHNvIHRoZSBwYWdlIHNlZXMgYSB2YWxpZCBiYWNrbG9nL3RvcGljLlxuICBhd2FpdCBhcGkocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZTogY2hhbm5lbCB9KTtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS93YXRjaCMke2VuY29kZVVSSUNvbXBvbmVudChjaGFubmVsKX1gO1xuICAvLyBPcGVuIHRoZSBicm93c2VyIHZpYSB0aGUgcGxhdGZvcm0ncyBkZWZhdWx0IG9wZW5lci4gQmVzdC1lZmZvcnQg4oCUXG4gIC8vIHByaW50IHRoZSBVUkwgc28gdGhlIHVzZXIgY2FuIGNsaWNrIGl0IGlmIGF1dG8tb3BlbiBmYWlscy5cbiAgY29uc3Qgb3BlbmVyID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcImV4cGxvcmVyXCIgOiBcInhkZy1vcGVuXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgcCA9IHNwYXduKG9wZW5lciwgW3VybF0sIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgfSk7XG4gICAgcC51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBvcGVuZXIgbWlzc2luZyDigJQganVzdCBwcmludCAqL1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsLCB1cmwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZERvY3RvcigpIHtcbiAgLy8gUmVhZC1vbmx5IGRpYWdub3N0aWMuIFJlcG9ydHMgdGhlIGF1dGhvcml0YXRpdmUgZGFlbW9uIChpZiBhbnkpLCBvdGhlclxuICAvLyBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3NlcyB2aXNpYmxlIG9uIHRoZSBtYWNoaW5lLCBjaGFubmVsIGZpbGVzIG9uXG4gIC8vIGRpc2ssIGFuZCBzdXJmYWNlcyBoaW50cy4gRG9lcyBOT1QgdGFrZSBkZXN0cnVjdGl2ZSBhY3Rpb24g4oCUIGNsZWFudXBcbiAgLy8gaXMgdGhlIG9wZXJhdG9yJ3MgY2FsbCwgd2l0aCBzdG9jayB1bml4IHRvb2xzLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgbGV0IGF1dGhvcml0YXRpdmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gIC8vIFBlci1jaGFubmVsIHN1YnNjcmliZXIgc3VtbWFyeSDigJQgYW5zd2VycyBcImlzIGl0IHNhZmUgdG8gcmVzdGFydCB0aGVcbiAgLy8gZGFlbW9uIHJpZ2h0IG5vdz9cIiB3aXRob3V0IG5lZWRpbmcgdG8gYWxzbyBydW4gYGxpc3RgIGFuZCByZWFkIHRoZVxuICAvLyBvdXRwdXQuIEVtcHR5IGlmIG5vIGRhZW1vbiBpcyBydW5uaW5nLlxuICBsZXQgdG90YWxTdWJzY3JpYmVycyA9IDA7XG4gIGNvbnN0IGJ1c3lDaGFubmVsczogQXJyYXk8e1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAgIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gICAgbmFtZWQ6IG51bWJlcjtcbiAgICBhbm9ueW1vdXM6IG51bWJlcjtcbiAgfT4gPSBbXTtcbiAgaWYgKHBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICAgIGF1dGhvcml0YXRpdmUgPSB7IHBvcnQsIC4uLmRhdGEgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGRhZW1vbiB3ZW50IGF3YXkgYmV0d2VlbiBwb3J0IGNoZWNrIGFuZCBhcGkgY2FsbFxuICAgIH1cbiAgICB0cnkge1xuICAgICAgLy8gL3ByZXNlbmNlIGdpdmVzIHRoZSBob25lc3QgcGVyLWNoYW5uZWwgYnJlYWtkb3duIChjb25uZWN0aW9ucyB2cyBuYW1lZFxuICAgICAgLy8gdnMgYW5vbnltb3VzKSDigJQgc28gdGhlIHJlc3RhcnQtc2FmZXR5IHRvdGFsIGlzbid0IGEgbXlzdGVyeSBhbmQgYW5cbiAgICAgIC8vIGFub255bW91cyB3YXRjaCB0YWIgcmVhZHMgYXMgYSB3YXRjaGVyLCBub3QgYSBnaG9zdC5cbiAgICAgIGNvbnN0IHsgZGF0YTogcHJlc0RhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgcHJlc0RhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICAgIHRvdGFsU3Vic2NyaWJlcnMgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICAgIGJ1c3lDaGFubmVscy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBjaC5uYW1lLFxuICAgICAgICAgIHN1YnNjcmliZXJzOiBjaC5jb25uZWN0aW9ucywgLy8gYmFjay1jb21wYXQ6IHByZXZpb3VzbHkgdGhlIHJhdyBjb3VudFxuICAgICAgICAgIGNvbm5lY3Rpb25zOiBjaC5jb25uZWN0aW9ucyxcbiAgICAgICAgICBuYW1lZDogY2gubmFtZWQsXG4gICAgICAgICAgYW5vbnltb3VzOiBjaC5hbm9ueW1vdXMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gYmVzdC1lZmZvcnRcbiAgICB9XG4gIH1cblxuICAvLyBFbnVtZXJhdGUgb3RoZXIgZGFlbW9uIHByb2Nlc3NlcyB2aWEgdGhlIHNoYXJlZCBjbGFzc2lmaWVyLiBFYWNoIGVudHJ5XG4gIC8vIGdhaW5zIHBvcnQvaG9tZS92ZXJzaW9uL3N0YXR1cy9yZWFwYWJsZSBzbyB0aGUgb3BlcmF0b3IgaGFzIHRoZSBmdWxsXG4gIC8vIHBpY3R1cmUgd2l0aG91dCBuZWVkaW5nIGEgc2VwYXJhdGUgYHJlYXAgLS1kcnktcnVuYC5cbiAgY29uc3Qgb3RoZXJEYWVtb25zOiBBcnJheTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGNsYXNzaWZ5RGFlbW9uPj4gJiB7IGNvbW1hbmQ/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3Qgc2VsZlBpZCA9IGF1dGhvcml0YXRpdmU/LnBpZCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBwaWQgb2YgYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKSkge1xuICAgICAgaWYgKHNlbGZQaWQgJiYgcGlkID09PSBzZWxmUGlkKSBjb250aW51ZTtcbiAgICAgIG90aGVyRGFlbW9ucy5wdXNoKGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCkpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IGNhcnJ5IG9uIHdpdGggZW1wdHkgbGlzdFxuICB9XG5cbiAgLy8gQ2hhbm5lbHMgb24gZGlzayB1bmRlciB0aGlzIEhPTUUuXG4gIGNvbnN0IGNoYW5uZWxzT25EaXNrOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGNoYW5uZWxzRGlyID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZiBvZiByZWFkZGlyU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgICAgaWYgKGYuZW5kc1dpdGgoXCIuanNvbmxcIikpIGNoYW5uZWxzT25EaXNrLnB1c2goZi5yZXBsYWNlKC9cXC5qc29ubCQvLCBcIlwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHt9XG5cbiAgLy8gSGludHMg4oCUIHN1cmZhY2UgdGhlIG1vc3QgYWN0aW9uYWJsZSBzaWduYWxzLlxuICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIFwiTm8gYXV0aG9yaXRhdGl2ZSBkYWVtb24gcnVubmluZyBmb3IgdGhpcyBIT01FLiBSdW4gYW55IHZlcmIgKGUuZy4gYGNsaS50cyBsaXN0YCkgdG8gc3Bhd24gb25lLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG90aGVyRGFlbW9ucy5sZW5ndGggPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBGb3VuZCAke290aGVyRGFlbW9ucy5sZW5ndGh9IG90aGVyIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzcyhlcykgb24gdGhpcyBtYWNoaW5lLiBgICtcbiAgICAgICAgXCJUaGV5IG1heSBiZSB6b21iaWVzIGZyb20gcGFzdCBydW5zIE9SIGRhZW1vbnMgc2VydmluZyBvdGhlciBIT01FcyAoZGlmZmVyZW50IEdSQVBFVklORV9IT01FKS5cIixcbiAgICApO1xuICAgIGNvbnN0IHJlYXBhYmxlQ291bnQgPSBvdGhlckRhZW1vbnMuZmlsdGVyKChkKSA9PiBkLnJlYXBhYmxlKS5sZW5ndGg7XG4gICAgaWYgKHJlYXBhYmxlQ291bnQgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgRm91bmQgJHtyZWFwYWJsZUNvdW50fSByZWFwYWJsZSBvcnBoYW4gZGFlbW9uKHMpLiBSdW4gXFxgZ3JhcGV2aW5lIHJlYXBcXGAgdG8gY2xlYXIgdGhlbSBzYWZlbHkuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvdGhlckRhZW1vbnMuc29tZSgoZCkgPT4gZC5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIpKSB7XG4gICAgICBoaW50cy5wdXNoKFwiU29tZSBkYWVtb25zIGFyZSB1bnJlc3BvbnNpdmU7IGBncmFwZXZpbmUgcmVhcCAtLWZvcmNlYCBpbmNsdWRlcyB0aGVtLlwiKTtcbiAgICB9XG4gIH1cbiAgaWYgKFxuICAgIGF1dGhvcml0YXRpdmUgJiZcbiAgICBQTFVHSU5fVkVSU0lPTiAmJlxuICAgIHR5cGVvZiBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IFwic3RyaW5nXCIgJiZcbiAgICBhdXRob3JpdGF0aXZlLnZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OXG4gICkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgQXV0aG9yaXRhdGl2ZSBkYWVtb24gdmVyc2lvbiAoJHthdXRob3JpdGF0aXZlLnZlcnNpb259KSBkaWZmZXJzIGZyb20gdGhpcyBDTEkncyB2ZXJzaW9uICgke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICBcIlJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbiDigJQgZHJvcCBhY3RpdmUgdGFpbHMsIHRoZW4gYHN0b3BgLCB0aGVuIGFueSB2ZXJiLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGF1dGhvcml0YXRpdmUgJiYgKGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gbnVsbCB8fCBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IHVuZGVmaW5lZCkpIHtcbiAgICBoaW50cy5wdXNoKFwiQXV0aG9yaXRhdGl2ZSBkYWVtb24gcHJlZGF0ZXMgdmVyc2lvbiByZXBvcnRpbmcgKHByZS1WMS42LjIpLiBSZXN0YXJ0IHRvIGFsaWduLlwiKTtcbiAgfVxuICBpZiAodG90YWxTdWJzY3JpYmVycyA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYCR7dG90YWxTdWJzY3JpYmVyc30gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7YnVzeUNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKS4gYCArXG4gICAgICAgIFwiRGFlbW9uIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSB0byBhdXRvLXJlY29ubmVjdCAod29ya3MsIGJ1dCBkaXNydXB0aXZlKSDigJQgY29vcmRpbmF0ZSBmaXJzdC5cIixcbiAgICApO1xuICB9IGVsc2UgaWYgKGF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFwiTm8gYWN0aXZlIHN1YnNjcmliZXJzIOKAlCBkYWVtb24gcmVzdGFydCBpcyBub24tZGlzcnVwdGl2ZS5cIik7XG4gIH1cbiAgLy8gRXhwbGFpbiBhbnkgY2hhbm5lbCB3aGVyZSB0aGUgY29ubmVjdGlvbiBjb3VudCBleGNlZWRzIG5hbWVkIGFnZW50cyDigJQgYW5cbiAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiBpbmZsYXRlcyBgY291bnRgL2Bjb25uZWN0aW9uc2AgYnV0IGlzbid0IGEgZ2hvc3QuXG4gIGZvciAoY29uc3QgY2ggb2YgYnVzeUNoYW5uZWxzKSB7XG4gICAgaWYgKGNoLmFub255bW91cyA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2NoLm5hbWV9OiAke2NoLmNvbm5lY3Rpb25zfSBjb25uZWN0aW9uKHMpLCAke2NoLm5hbWVkfSBuYW1lZCBhZ2VudChzKSArIGAgK1xuICAgICAgICAgIGAke2NoLmFub255bW91c30gYW5vbnltb3VzIChlLmcuIGEgd2F0Y2ggdGFiKS4gVGhlIGNvdW50IG92ZXIgdGhlIG5hbWUgbGlzdCBpcyBleHBlY3RlZCwgbm90IGEgZ2hvc3QuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBob21lOiBEQVRBX0RJUixcbiAgICBjbGlfdmVyc2lvbjogUExVR0lOX1ZFUlNJT04sXG4gICAgYXV0aG9yaXRhdGl2ZSxcbiAgICBhY3RpdmVfc3Vic2NyaWJlcnM6IHtcbiAgICAgIHRvdGFsOiB0b3RhbFN1YnNjcmliZXJzLFxuICAgICAgYnVzeV9jaGFubmVsczogYnVzeUNoYW5uZWxzLFxuICAgIH0sXG4gICAgb3RoZXJfZGFlbW9uc19vbl9tYWNoaW5lOiBvdGhlckRhZW1vbnMsXG4gICAgY2hhbm5lbHNfb25fZGlzazogY2hhbm5lbHNPbkRpc2ssXG4gICAgaGludHMsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRJbmZvKCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gZW51bWVyYXRpb24gKyBjbGFzc2lmaWVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogQWxsIGdyYXBldmluZSBkYWVtb24udHMgcGlkcyB2aXNpYmxlIG9uIHRoaXMgbWFjaGluZSAodmlhIGBwc2ApLiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuICBjb25zdCBwaWRzOiBudW1iZXJbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcInBzXCIsIFtcIi1lb1wiLCBcInBpZCxjb21tYW5kXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY29uc3Qgb3V0ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmLThcIik7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKFwiZGFlbW9uLnRzXCIpKSBjb250aW51ZTtcbiAgICAgIGlmICghbGluZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZ3JhcGV2aW5lXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG0gPSBsaW5lLm1hdGNoKC9eXFxzKihcXGQrKVxccysvKTtcbiAgICAgIGlmICghbSkgY29udGludWU7XG4gICAgICBjb25zdCBwaWQgPSBwYXJzZUludChtWzFdLCAxMCk7XG4gICAgICBpZiAocGlkKSBwaWRzLnB1c2gocGlkKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIHBzIHVuYXZhaWxhYmxlOyByZXR1cm4gZW1wdHlcbiAgfVxuICByZXR1cm4gcGlkcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gbHNvZkxpc3RlblBvcnQocGlkOiBudW1iZXIpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9jID0gc3Bhd24oXCJsc29mXCIsIFtcIi1haVRDUFwiLCBcIi1zVENQOkxJU1RFTlwiLCBcIi1wXCIsIFN0cmluZyhwaWQpLCBcIi1QXCIsIFwiLW5cIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByKCkpKTtcbiAgICBjb25zdCBtID0gQnVmZmVyLmNvbmNhdChjaHVua3MpXG4gICAgICAudG9TdHJpbmcoXCJ1dGYtOFwiKVxuICAgICAgLm1hdGNoKC8xMjdcXC4wXFwuMFxcLjE6KFxcZCspLyk7XG4gICAgcmV0dXJuIG0gPyBwYXJzZUludChtWzFdLCAxMCkgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgdHlwZSBEYWVtb25TdGF0dXMgPSBcImF1dGhvcml0YXRpdmVcIiB8IFwib3JwaGFuXCIgfCBcInVucmVzcG9uc2l2ZVwiIHwgXCJ1bmtub3duXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGFzc2lmeURhZW1vbihwaWQ6IG51bWJlcik6IFByb21pc2U8e1xuICBwaWQ6IG51bWJlcjtcbiAgcG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgaG9tZT86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogRGFlbW9uU3RhdHVzO1xuICByZWFwYWJsZTogYm9vbGVhbjtcbn0+IHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGxzb2ZMaXN0ZW5Qb3J0KHBpZCk7XG4gIGlmICghcG9ydCkgcmV0dXJuIHsgcGlkLCBwb3J0OiBudWxsLCBzdGF0dXM6IFwidW5rbm93blwiLCByZWFwYWJsZTogZmFsc2UgfTtcbiAgbGV0IGluZm86IFJvb3RJbmZvIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoODAwKSxcbiAgICB9KTtcbiAgICBpZiAocmVzLm9rKSBpbmZvID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJvb3RJbmZvO1xuICB9IGNhdGNoIHt9XG4gIGlmICghaW5mbykgcmV0dXJuIHsgcGlkLCBwb3J0LCBzdGF0dXM6IFwidW5yZXNwb25zaXZlXCIsIHJlYXBhYmxlOiBmYWxzZSB9OyAvLyByZWFwIG9ubHkgd2l0aCAtLWZvcmNlIChoYW5kbGVkIGluIGNtZFJlYXApXG4gIGNvbnN0IGhvbWUgPSBpbmZvLmRhdGFfZGlyIGFzIHN0cmluZztcbiAgbGV0IG93bnMgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBvcCA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBvcnRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIGNvbnN0IG9pID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucGlkXCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBvd25zID0gb3AgPT09IFN0cmluZyhwb3J0KSAmJiBvaSA9PT0gU3RyaW5nKHBpZCk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG93bnNcbiAgICA/IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcImF1dGhvcml0YXRpdmVcIixcbiAgICAgICAgcmVhcGFibGU6IGZhbHNlLFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwib3JwaGFuXCIsXG4gICAgICAgIHJlYXBhYmxlOiB0cnVlLFxuICAgICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhcChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbjsgZHJ5UnVuPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHNlbGZQb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTsgLy8gY3VycmVudCBIT01FIGF1dGhvcml0YXRpdmUgKG5ldmVyIHJlYXApXG4gIGxldCBzZWxmUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgaWYgKHNlbGZQb3J0KSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGZQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihzZWxmUG9ydCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcGlkcyA9IGF3YWl0IGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCk7XG4gIGNvbnN0IGtlcHQ6IHVua25vd25bXSA9IFtdLFxuICAgIHJlYXBlZDogdW5rbm93bltdID0gW10sXG4gICAgc2tpcHBlZDogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgcGlkIG9mIHBpZHMpIHtcbiAgICBjb25zdCBjID0gYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKTtcbiAgICBjb25zdCBpc1NlbGYgPSBwaWQgPT09IHNlbGZQaWQ7XG4gICAgY29uc3Qgc2hvdWxkUmVhcCA9XG4gICAgICAhaXNTZWxmICYmIChjLnJlYXBhYmxlIHx8IChjLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIiAmJiBvcHRzLmZvcmNlID09PSB0cnVlKSk7XG4gICAgaWYgKCFzaG91bGRSZWFwKSB7XG4gICAgICBrZXB0LnB1c2goYyk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG9wdHMuZHJ5UnVuKSB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImRyeS1ydW5cIiB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5raWxsKHBpZCwgXCJTSUdURVJNXCIpO1xuICAgICAgcmVhcGVkLnB1c2goYyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImtpbGwgZmFpbGVkXCIgfSk7XG4gICAgfVxuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkcnlfcnVuOiAhIW9wdHMuZHJ5UnVuLCBrZXB0LCByZWFwZWQsIHNraXBwZWQgfSk7XG59XG5cbi8vIChCT09MRUFOX0ZMQUdTIHdhcyBoZXJlLiBJdCBsaXN0ZWQgd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZSDigJQgaGFsZiBhXG4vLyByZWdpc3RyeSwgY29uc3VsdGVkIGJ5IHRoZSBoYW5kLXJvbGxlZCBwYXJzZXIuIEl0cyAxMyBlbnRyaWVzIG5vdyBsaXZlIGluXG4vLyBDTElfT1BUSU9OUyBiZWxvdyBhcyBge3R5cGU6XCJib29sZWFuXCJ9YCwgdmVyaWZpZWQgMTMtZm9yLTEzIGFnYWluc3QgdGhvdGgnc1xuLy8gaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0IGJlZm9yZSB0aGUgbW92ZS4gRGVsZXRlZCByYXRoZXIgdGhhbiBsZWZ0XG4vLyBiZXNpZGUgaXRzIHJlcGxhY2VtZW50OiBhIHNlY29uZCBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSBzYW1lIGZhY3QgaXMgdGhlXG4vLyBkcmlmdCBidWcgdGhpcyBsYW5lIGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCB3b3VsZCBubyBsb25nZXIgYmUgY29uc3VsdGVkXG4vLyBieSBhbnl0aGluZy4pXG5cbi8vIFNpZ25hdHVyZSBvZiBhIGhlcmVkb2MgZnVtYmxlOiBhIGxpbmUgdGhhdCBpcyAob3IgYmVnaW5zIHdpdGgpIGFcbi8vIGBidW4g4oCmIGNsaS50cyDigKYgc2VuZGAgaW52b2NhdGlvbi4gV2hlbiBhIGBzZW5kIC0tc3RkaW4gPDxFT0ZgIGlzIGJvdGNoZWQsIHRoZVxuLy8gc2hlbGwgcGlwZXMgdGhlIGxpdGVyYWwgY29tbWFuZCBsaW5lIGluIGFzIHRoZSBib2R5LCB3aGljaCB0aGVuIGdldHMgcG9zdGVkIOKAlFxuLy8gY29ycnVwdGluZyB0aGUgY2hhbm5lbCB3aXRoIGBidW4gL+KApi9jbGkudHMgc2VuZCA8Y2hhbm5lbD4gLS1hcyDigKYgPHRleHQ+YC5cbi8vIFdlIHJlZnVzZSB0byBwb3N0IHN1Y2ggYSBib2R5IHVubGVzcyAtLWZvcmNlIGlzIHBhc3NlZC5cbmNvbnN0IExFQUtFRF9TRU5EX1JFID0gLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxiKD86c2VuZHxhbm5vdW5jZSlcXGIvO1xuZnVuY3Rpb24gbG9va3NMaWtlTGVha2VkU2VuZCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIExFQUtFRF9TRU5EX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vIFNoZWxsLW1ldGFjaGFyYWN0ZXIgZm9vdGd1biAoIzYwKTogYSBib2R5IHBhc3NlZCBhcyBhbiBJTkxJTkUgcG9zaXRpb25hbCBhcmdcbi8vIGlzIGV4cG9zZWQgdG8gdGhlIGNhbGxlcidzIHNoZWxsLCB3aGljaCBjb21tYW5kLXN1YnN0aXR1dGVzIGJhY2t0aWNrcyAvXG4vLyBgJCguLi4pYCAvIGAkey4uLn1gIEJFRk9SRSBncmFwZXZpbmUgc2VlcyBpdCDigJQgY29ycnVwdGluZyBvciBwYXJ0aWFsbHlcbi8vIGV4ZWN1dGluZyBjb2RlLWJlYXJpbmcgbWVzc2FnZXMuIFRoZSBDTEkgY2FuJ3QgdW4tc3Vic3RpdHV0ZSB3aGF0IHRoZSBzaGVsbFxuLy8gYWxyZWFkeSBhdGU7IHRoZSBob25lc3QgZml4IGlzIHRvIHN0ZWVyIGNhbGxlcnMgdG8gdGhlIHNoZWxsLWZyZWUgcGF0aHNcbi8vICgtLWJvZHktZmlsZSAvIC0tc3RkaW4gLyBkZWZhdWx0LXN0ZGluKS4gV2hlbiBtZXRhY2hhcmFjdGVycyBTVVJWSVZFIGludG8gYW5cbi8vIGlubGluZSBib2R5IChlLmcuIHRoZSBjYWxsZXIgaGFwcGVuZWQgdG8gc2luZ2xlLXF1b3RlKSwgdGhleSdyZSBpbnRhY3QgdGhpc1xuLy8gdGltZSDigJQgYnV0IHRoZSBwYXR0ZXJuIGlzIGEgbGF0ZW50IGZvb3RndW4sIHNvIHdlIHdhcm4gKG5ldmVyIGJsb2NrOiB0aGVcbi8vIG1lc3NhZ2UgaXMgZmluZSBhcyByZWNlaXZlZCkuIEFic2VudC1tZXRhY2hhciBpbmxpbmUgYm9kaWVzIGFyZSBlaXRoZXIgcGxhaW5cbi8vIHRleHQgKHNhZmUpIG9yIGFscmVhZHktc3Vic3RpdHV0ZWQgKHVuZGV0ZWN0YWJsZSkg4oCUIHNvIHdlIG9ubHkgd2FybiBvbiB0aGVcbi8vIGRldGVjdGFibGUgcmlza3kgcGF0dGVybi5cbmNvbnN0IFNIRUxMX01FVEFDSEFSX1JFID0gL2B8XFwkXFwofFxcJFxcey87XG5leHBvcnQgZnVuY3Rpb24gbG9va3NTaGVsbFJpc2t5KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gU0hFTExfTUVUQUNIQVJfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIGdyYXBldmluZSBhbHJlYWR5IGhhZCBIQUxGIGEgcmVnaXN0cnk6IGBCT09MRUFOX0ZMQUdTYCBhYm92ZSB0b2xkIHRoZSBwYXJzZXJcbi8vIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUuIFdoYXQgaXQgaGFkIG5vIG5vdGlvbiBvZiB3YXMgd2hpY2ggZmxhZ3MgRVhJU1QsIHNvXG4vLyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2Vcbi8vIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXMgc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC5cbi8vXG4vLyDimqAgZ3JhcGV2aW5lIGlzIHRoZSBPVVRMSUVSIG9mIHRoZSBzaXgsIGFuZCBpdCBpcyB3b3J0aCBzYXlpbmcgd2h5IHNvIG5vYm9keVxuLy8gcmVhZHMgaXQgYXMgbWVyZWx5IGJlaGluZDogaXQgdHlwZXMgaXRzIHZhbHVlIGZsYWdzIHdpdGggYSBDQVNUXG4vLyAoYGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZGApIHdoZXJlIHRoZSBvdGhlciBlbnRyeSBwb2ludHMgdXNlIGFcbi8vIGB0eXBlb2ZgIGd1YXJkLiBBIGNhc3QgaXMgYSBjbGFpbSB3aXRoIE5PIFJVTlRJTUUgQ0hFQ0ssIHNvIGdyYXBldmluZSBjYXJyaWVkXG4vLyBhIGNsYXNzIG9mIGxhdGVudCB0eXBlLWxpZSB0aGUgb3RoZXJzIHdlcmUgZ3VhcmRlZCBhZ2FpbnN0IOKAlCBhbmQgYmFyZSB2YWx1ZVxuLy8gZmxhZ3MgcHJvZHVjZWQgc2lsZW50IHdyb25nIHZhbHVlcyByYXRoZXIgdGhhbiBlcnJvcnM6XG4vL1xuLy8gICAtLWxhc3QgICBiYXJlICAtPiAgcGFyc2VJbnQodHJ1ZSwgMTApICAtPiAgTmFOLCBzaWxlbnRseVxuLy8gICAtLXRvcGljICBiYXJlICAtPiAgYHRydWVgIGluIGEgZmllbGQgREVDTEFSRUQgYHN0cmluZ2Bcbi8vXG4vLyBgc3RyaWN0OiB0cnVlYCB0dXJucyBlYWNoIG9mIHRob3NlIGZyb20gYSBzaWxlbnQgd3JvbmcgdmFsdWUgaW50byBhXG4vLyBjYWxsZXItZmFjaW5nIGVycm9yLCB3aGljaCBpcyB0aGUgbGFuZSdzIHdob2xlIHB1cnBvc2UgYW5kIHRoZSBsYXJnZXN0XG4vLyBiZWhhdmlvdXIgZGVsdGEgb2YgdGhlIHNpeCBlbnRyeSBwb2ludHMuXG4vL1xuLy8gVGhlIGJvb2xlYW4gc2V0IGJlbG93IGlzIEJPT0xFQU5fRkxBR1MsIHVuY2hhbmdlZCDigJQgZXh0cmFjdGVkIGZyb20gdGhpcyBmaWxlXG4vLyBhbmQgZGlmZmVkIGFnYWluc3QgdGhvdGgncyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3Q6IDEzIGZvciAxMywgZXhhY3QsXG4vLyB6ZXJvIGRpdmVyZ2VuY2UgaW4gZWl0aGVyIGRpcmVjdGlvbi5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjaGFubmVsczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBob2xkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJpbi1yZXBseS10b1wiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFzdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1heDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0b3BpYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGFsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImRyeS1ydW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmb3JjZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmcmVzaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImZyb20tc3RhcnRcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW1hbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsaXRlcmFsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGx1cms6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVpZXQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGV4dDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB2ZXJib3NlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHllczogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxufSBhcyBjb25zdDtcblxuLyoqXG4gKiBBIHBhcnNlLXN0YWdlIHJlamVjdGlvbiwgY2FycnlpbmcgdGhlIGVudW1lcmF0aW9uIGl0IHdhbnRzIHRvIHB1Ymxpc2guXG4gKlxuICog4puUIFRIRSBgZXh0cmFgIElTIFdIWSBUSElTIENMQVNTIFNVUlZJVkVEIFRIRSBgZXJyb3JzLnRzYCBBRE9QVElPTi4gVGhlXG4gKiByZWplY3Rpb24gaGFzIHRvIE5BTUUgaXRzIHZhbGlkIHNldCDigJQgdGhhdCBpcyB0aGUgd2hvbGUgcmVhc29uIGdyYXBldmluZSdzXG4gKiBwYXJzZXIgZXJyb3JzIHdlcmUgc2hhcGVkIHRoZSB3YXkgdGhleSB3ZXJlIOKAlCBhbmQgdGhlIHRocm93IGhhcHBlbnMgdHdvIGZyYW1lc1xuICogYmVsb3cgdGhlIHBsYWNlIHRoYXQga25vd3MgdGhlIHNldC4gYGNob2ljZXNgIGlzIHdoZXJlIHRoZSBob3VzZSBlbnZlbG9wZVxuICogY2FycmllcyBhbiBlbnVtZXJhdGlvbiwgc28gdGhlIGNsYXNzIGhvbGRzIGl0IHVudGlsIGBydW5Db21tYW5kYCByYWlzZXMuXG4gKi9cbmNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiVXNhZ2VFcnJvclwiO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxufVxuXG50eXBlIEZsYWdOYW1lID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuXG4vLyBJZGVudGl0eSBpcyBjb250cmFjdHVhbGx5IEdMT0JBTDogU0tJTEwubWQgdGVsbHMgYWdlbnRzIHRvIHBhc3MgLS1hcy8tLWZyb21cbi8vIG9uIEVWRVJZIHZlcmIgKGEgZnJlc2ggc2hlbGwgcGVyIGNvbW1hbmQgbWVhbnMgR1JBUEVWSU5FX0ZST00gbmV2ZXJcbi8vIHBlcnNpc3RzKSwgc28gZXZlcnkgY29tbWFuZCBhY2NlcHRzIGJvdGgg4oCUIGV2ZW4gd2hlcmUgYSB2ZXJiIGhhcyBubyB1c2UgZm9yXG4vLyBpZGVudGl0eSwgYSBjYWxsZXIgZm9sbG93aW5nIG91ciBvd24gZG9jcyBtdXN0IG5vdCBiZSByZWplY3RlZCBmb3Igb2JleWluZ1xuLy8gdGhlbS4gT24gYGdyZXBgLCBgLS1mcm9tYCBpcyBhbiBhdXRob3IgRklMVEVSIHJhdGhlciB0aGFuIGlkZW50aXR5OiBkaWZmZXJlbnRcbi8vIHNlbWFudGljcywgc2FtZSBhY2NlcHRhbmNlLlxuY29uc3QgR0xPQkFMX0ZMQUdTOiBGbGFnTmFtZVtdID0gW1wiYXNcIiwgXCJmcm9tXCJdO1xuXG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcblxuLy8gVEhFIENPTU1BTkQgVEFCTEUsIEFTIEEgU1RSVUNUVVJFIOKAlCB0aGUgcGFyc2VyLCB0aGUgZGlzcGF0Y2hlciwgdGhlIHNjaGVtYVxuLy8gZW1pdHRlciBhbmQgdGhlIHJvb3QgcmVqZWN0aW9uIGFsbCB3YWxrIFRISVMuIEl0IHJlcGxhY2VkIGEgYmFyZSBgc3dpdGNoYCxcbi8vIHdoaWNoIG9ubHkgdGhlIGRpc3BhdGNoZXIgY291bGQgd2FsazogYSBzY2hlbWEgZW1pdHRlZCBmcm9tIGFueXRoaW5nIG90aGVyXG4vLyB0aGFuIHRoZSBzdHJ1Y3R1cmUgdGhhdCByb3V0ZXMgdGhlIGJlaGF2aW91ciBpcyBhIGRvY3VtZW50IHRoYXQgbGllcyBhcyBzb29uXG4vLyBhcyBhbnlvbmUgZWRpdHMgdGhlIG90aGVyIHNpZGUgKGFjYyBTVEFOREFSRC5tZCBQYXJ0IDEgwqcyOyBvdXIgb3duICM4MS9ENFxuLy8gbGFuZSBsZWFybmVkIHRoZSBzYW1lIGxlc3NvbiBvbmUgYWx0aXR1ZGUgZG93biB3aXRoIEJPT0xFQU5fRkxBR1MpLlxuLy9cbi8vIGBmbGFnc2AgaXMgdGhlIHZlcmIncyBPV04gYWNjZXB0ZWQgc2V0IChHTE9CQUxfRkxBR1MgYXJlIG1lcmdlZCBpbiBieVxuLy8gYGFjY2VwdGVkRmxhZ3NgKS4gQSBmbGFnIG5vdCBsaXN0ZWQgaGVyZSBpcyBSRUpFQ1RFRCBmb3IgdGhpcyB2ZXJiIHdpdGggdGhlXG4vLyB2ZXJiJ3Mgb3duIHNldCBlbnVtZXJhdGVkIOKAlCBhY2NlcHRlZC1hbmQtaWdub3JlZCBpcyB0aGUgZGlzZWFzZSB0aGlzIHRhYmxlXG4vLyBleGlzdHMgdG8gY3VyZSAoYWNjIERULTE6IGFudGhpbGwgYWNjZXB0aW5nIGEgcm9vdCBgLS1mb3JtYXRgIGl0IHNpbGVudGx5XG4vLyBkaXNjYXJkczsgZ3JhcGV2aW5lIGFjY2VwdGluZyBgc2VuZCAtLWRyeS1ydW5gIGFuZCBkb2luZyBub3RoaW5nIHdhcyB0aGVcbi8vIHNhbWUgZXZlbnQgd2l0aCBhIGRpZmZlcmVudCBzcGVsbGluZykuXG50eXBlIENvbW1hbmRTcGVjID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdOYW1lW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICAvKipcbiAgICog4pqgIE1BWSBSRVRVUk4gQU4gRVhJVCBDT0RFLCBBTkQgRVhBQ1RMWSBPTkUgVkVSQiBET0VTLiBgdGFpbGAgcnVucyB0aGUgc2hhcmVkXG4gICAqIGNsaWVudCAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoaWNoIFJFVFVSTlMgYSBjb2RlIHJhdGhlciB0aGFuXG4gICAqIGVuZGluZyB0aGUgcHJvY2VzcyBmcm9tIGluc2lkZSB0aHJlZSBuZXN0ZWQgbG9vcHMg4oCUIHNvIHRoZSBjb2RlIGhhcyB0byByZWFjaFxuICAgKiBgbWFpbmAsIGFuZCB0aGlzIGlzIHRoZSBzZWFtIGl0IGNyb3NzZXMuIEFueXRoaW5nIHRoYXQgaXMgbm90IGEgbnVtYmVyIG1lYW5zXG4gICAqIDAsIHdoaWNoIGlzIHdoYXQgdGhlIG90aGVyIHR3ZW50eS1vZGQgdmVyYnMgcmV0dXJuLlxuICAgKlxuICAgKiDimqAgVHlwZWQgYHVua25vd25gIHJhdGhlciB0aGFuIGEgdW5pb24gd2l0aCBgdm9pZGA6IGEgdW5pb24gaXMgd2hhdCBhIHJlYWRlclxuICAgKiB3b3VsZCB3cml0ZSBmaXJzdCwgYW5kIGV2ZXJ5IGBhc3luY2AgdmVyYiB0aGF0IGVuZHMgd2l0aG91dCBhIGByZXR1cm5gIGlzXG4gICAqIGBQcm9taXNlPHZvaWQ+YCwgd2hpY2ggaXMgTk9UIGFzc2lnbmFibGUgdG8gYFByb21pc2U8bnVtYmVyIHwgdW5kZWZpbmVkPmAuXG4gICAqIFRoZSB3aWRlbmluZyBoYXBwZW5zIGF0IHRoZSBvbmUgcGxhY2UgdGhhdCByZWFkcyB0aGUgdmFsdWUsIGJlbG93LlxuICAgKi9cbiAgcnVuOiAocG9zaXRpb25hbDogc3RyaW5nW10sIGZsYWdzOiBGbGFncykgPT4gdW5rbm93bjtcbn07XG5cbi8vIEEgZGVjbGFyZWQgdmFsdWUgZmxhZyB0aGF0IGNhcnJpZXMgYSBudW1iZXIgbXVzdCBSRUpFQ1QgYSBub24tbnVtYmVyIGFzIGFcbi8vIHVzYWdlIGVycm9yIChleGl0IDIpLCBub3QgY3Jhc2ggb24gaXQgZG93bnN0cmVhbSDigJQgYHNjaGVtYWAgcHVibGlzaGVzIHRoZVxuLy8gZmxhZyBhcyB2YWxpZCwgc28gdGhlIHBhcnNlIGJvdW5kYXJ5IGlzIHdoZXJlIGEgYmFkIHZhbHVlIGdldHMgaXRzXG4vLyBjYWxsZXItZmFjaW5nIGFuc3dlci4gKGB3YWl0IC0tdGltZW91dCBub3RhbnVtYmVyYCB1c2VkIHRvIHRocm93IGFuXG4vLyB1bmhhbmRsZWQgUmFuZ2VFcnJvciBhdCBleGl0IDEsIHN0YWNrIHRyYWNlIGFuZCBhbGwuKVxuZnVuY3Rpb24gbnVtZXJpY0ZsYWcodmVyYjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHJhdzogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbGxiYWNrO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG4pIHx8IG4gPCAwKVxuICAgIGRpZShgJHt2ZXJifTogLS0ke25hbWV9IGV4cGVjdHMgYSBub24tbmVnYXRpdmUgbnVtYmVyLCBnb3QgJHtKU09OLnN0cmluZ2lmeShTdHJpbmcocmF3KSl9YCk7XG4gIHJldHVybiBuO1xufVxuXG4vLyBCb2R5IHJlc29sdXRpb24gc2hhcmVkIGJ5IHNlbmQvYW5ub3VuY2Ug4oCUIGZpcnN0IG1hdGNoIHdpbnM6IC0tYm9keS1maWxlLFxuLy8gLS1zdGRpbiwgaW5saW5lIHBvc2l0aW9uYWxzLCBkZWZhdWx0LXN0ZGluIHdoZW4gcGlwZWQuIFNlZSB0aGUgcGVyLXZlcmJcbi8vIGNvbW1lbnRzIGF0IHRoZSBvcmlnaW5hbCBzaXRlcyAoVjEuNi8jNjApOyBiZWhhdmlvdXIgdW5jaGFuZ2VkLlxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJvZHkoXG4gIHZlcmI6IFwic2VuZFwiIHwgXCJhbm5vdW5jZVwiLFxuICBpbmxpbmU6IHN0cmluZ1tdLFxuICBmbGFnczogRmxhZ3MsXG4pOiBQcm9taXNlPHsgdGV4dDogc3RyaW5nOyBmcm9tSW5saW5lOiBib29sZWFuIH0+IHtcbiAgaWYgKGZsYWdzW1wiYm9keS1maWxlXCJdKSB7XG4gICAgY29uc3QgcGF0aCA9IGZsYWdzW1wiYm9keS1maWxlXCJdIGFzIHN0cmluZztcbiAgICBjb25zdCBmaWxlID0gQnVuLmZpbGUocGF0aCk7XG4gICAgaWYgKCEoYXdhaXQgZmlsZS5leGlzdHMoKSkpIGRpZShgJHt2ZXJifTogLS1ib2R5LWZpbGUgbm90IGZvdW5kOiAke3BhdGh9YCwgXCJub3RfZm91bmRcIik7XG4gICAgcmV0dXJuIHsgdGV4dDogKGF3YWl0IGZpbGUudGV4dCgpKS5yZXBsYWNlKC9cXG4kLywgXCJcIiksIGZyb21JbmxpbmU6IGZhbHNlIH07XG4gIH1cbiAgaWYgKGZsYWdzLnN0ZGluIHx8IChpbmxpbmUubGVuZ3RoID09PSAwICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgIGNvbnN0IGJ1ZjogQnVmZmVyW10gPSBbXTtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIHByb2Nlc3Muc3RkaW4pIGJ1Zi5wdXNoKGNodW5rIGFzIEJ1ZmZlcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRleHQ6IEJ1ZmZlci5jb25jYXQoYnVmKS50b1N0cmluZyhcInV0Zi04XCIpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSxcbiAgICAgIGZyb21JbmxpbmU6IGZhbHNlLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgdGV4dDogaW5saW5lLmpvaW4oXCIgXCIpLCBmcm9tSW5saW5lOiB0cnVlIH07XG59XG5cbi8vIFRoZSB0d28gYm9keSBndWFyZHMgc2hhcmVkIGJ5IHNlbmQvYW5ub3VuY2U6IHJlZnVzZSBhIGxlYWtlZCBpbnZvY2F0aW9uXG4vLyAoZnVtYmxlZCBoZXJlZG9jKSB1bmxlc3MgLS1mb3JjZSwgYW5kIHdhcm4gb24gc2hlbGwgbWV0YWNoYXJhY3RlcnMgdGhhdFxuLy8gc3Vydml2ZWQgYW4gaW5saW5lIGJvZHkgKCM2MCDigJQgd2FybiwgbmV2ZXIgYmxvY2spLlxuZnVuY3Rpb24gZ3VhcmRCb2R5KHZlcmI6IFwic2VuZFwiIHwgXCJhbm5vdW5jZVwiLCB0ZXh0OiBzdHJpbmcsIGZyb21JbmxpbmU6IGJvb2xlYW4sIGZvcmNlOiBib29sZWFuKSB7XG4gIGlmICghZm9yY2UgJiYgbG9va3NMaWtlTGVha2VkU2VuZCh0ZXh0KSkge1xuICAgIGRpZShcbiAgICAgIGAke3ZlcmJ9OiB0aGF0IGJvZHkgbG9va3MgbGlrZSBhIGxlYWtlZCBncmFwZXZpbmUgaW52b2NhdGlvbiAoYSBmdW1ibGVkIGAgK1xuICAgICAgICBcImhlcmVkb2M/KS4gTm90aGluZyB3YXMgc2VudC4gUGlwZSB0aGUgcmVhbCBib2R5IHZpYSAtLXN0ZGluIG9yIFwiICtcbiAgICAgICAgXCItLWJvZHktZmlsZSA8cGF0aD4sIG9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cIixcbiAgICApO1xuICB9XG4gIGlmIChmcm9tSW5saW5lICYmIGxvb2tzU2hlbGxSaXNreSh0ZXh0KSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgXCIjIOKaoCBpbmxpbmUgYm9keSBjb250YWlucyBzaGVsbCBtZXRhY2hhcmFjdGVycyAoYmFja3RpY2ssICQoKSwgY3VybHktYnJhY2UgdmFycykuIFwiICtcbiAgICAgICAgXCJJdCB3YXMgc2VudCBhcy1pcywgYnV0IHRoZSBzaGVsbCBjYW4gY29tbWFuZC1zdWJzdGl0dXRlIHRoZXNlIGJlZm9yZSBcIiArXG4gICAgICAgIFwiZ3JhcGV2aW5lIHNlZXMgdGhlbSDigJQgdXNlIC0tYm9keS1maWxlIG9yIC0tc3RkaW4gZm9yIGNvZGUtYmVhcmluZyBtZXNzYWdlcy5cXG5cIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICog4puUIFJFR0lTVEVSIEExIOKAlCBgY2hvaWNlc2AgSVMgYEdMT0JBTF9GTEFHU2AsIFRIRSBTRVQgYHJlc29sdmVBbGlhc2AgUkVBRFMuXG4gKiBUaGlzIGlzIGEgRElTSlVOQ1RJT04gKGVpdGhlciBmbGFnIHNhdGlzZmllcyBpdCksIHNvIHRoZSBjYWxsZXIgaGFzIHRvIHBpY2ssXG4gKiBhbmQgaXQgaXMgdGhlIG9uZSBpZGVudGl0eSByZWZ1c2FsIGZvdXIgdmVyYnMgc2hhcmUuIFRoZSBlbnYgdmFyIHN0YXlzIGluXG4gKiBgaGludGAgYW5kIGRlbGliZXJhdGVseSBOT1QgaW4gYGNob2ljZXNgOiBgY2hvaWNlc2AgZW51bWVyYXRlcyBDT01NQU5EXG4gKiBUT0tFTlMg4oCUIHdoYXQgd291bGQgaGF2ZSBiZWVuIGFjY2VwdGVkIElOIFRIRSBJTlZPQ0FUSU9OIOKAlCBhbmQgcHV0dGluZyBhblxuICogZW52aXJvbm1lbnQgbmFtZSBpbiB0aGUgc2FtZSBhcnJheSB3b3VsZCBnaXZlIGEgY2FsbGVyIGEgXCJjaG9pY2VcIiBpdCBjYW5ub3RcbiAqIHBhc3Mgb24gdGhlIGNvbW1hbmQgbGluZS5cbiAqL1xuY29uc3QgaWRlbnRpdHlSZXF1aXJlZCA9ICh2ZXJiOiBzdHJpbmcpOiBuZXZlciA9PlxuICBkaWUoYCR7dmVyYn06IGlkZW50aXR5IHJlcXVpcmVkYCwgXCJ1c2FnZVwiLCB7XG4gICAgaGludDogYHBhc3MgJHtHTE9CQUxfRkxBR1MubWFwKChmKSA9PiBgLS0ke2Z9YCkuam9pbihcIi9cIil9IDxhbGlhcz4sIG9yIHNldCBHUkFQRVZJTkVfRlJPTWAsXG4gICAgY2hvaWNlczogR0xPQkFMX0ZMQUdTLm1hcCgoZikgPT4gYC0tJHtmfWApLFxuICB9KTtcblxuY29uc3QgQ09NTUFORFM6IENvbW1hbmRTcGVjW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5cIixcbiAgICBmbGFnczogW1widG9waWNcIiwgXCJmcmVzaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRPcGVuKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgdG9waWM6IGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbTogcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICAgZnJlc2g6IGZsYWdzLmZyZXNoID09PSB0cnVlLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidG9waWNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kVG9waWMoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIHBvc2l0aW9uYWwubGVuZ3RoID4gMSA/IHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIikgOiB1bmRlZmluZWQsXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxpc3RcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kTGlzdCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlbmRcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcInZlcmJvc2VcIiwgXCJmb3JjZVwiLCBcImluLXJlcGx5LXRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwb3NpdGlvbmFsWzBdO1xuICAgICAgY29uc3QgZnJvbSA9IHJlc29sdmVBbGlhcyhmbGFncyk7XG4gICAgICBjb25zdCB7IHRleHQsIGZyb21JbmxpbmUgfSA9IGF3YWl0IHJlc29sdmVCb2R5KFwic2VuZFwiLCBwb3NpdGlvbmFsLnNsaWNlKDEpLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJzZW5kXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwic2VuZFwiLCB0ZXh0LCBmcm9tSW5saW5lLCAhIWZsYWdzLmZvcmNlKTtcbiAgICAgIGF3YWl0IGNtZFNlbmQobmFtZSwgZnJvbSBhcyBzdHJpbmcsIHRleHQsIHtcbiAgICAgICAgcXVpZXQ6ICEhZmxhZ3MucXVpZXQsXG4gICAgICAgIHZlcmJvc2U6ICEhZmxhZ3MudmVyYm9zZSxcbiAgICAgICAgaW5SZXBseVRvOiBmbGFnc1tcImluLXJlcGx5LXRvXCJdXG4gICAgICAgICAgPyBudW1lcmljRmxhZyhcInNlbmRcIiwgXCJpbi1yZXBseS10b1wiLCBmbGFnc1tcImluLXJlcGx5LXRvXCJdLCAwKVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYW5ub3VuY2VcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcImZvcmNlXCIsIFwiY2hhbm5lbHNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJhbm5vdW5jZVwiLCBwb3NpdGlvbmFsLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJhbm5vdW5jZVwiKTtcbiAgICAgIGd1YXJkQm9keShcImFubm91bmNlXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgY29uc3QgY2hhbm5lbHMgPSBmbGFncy5jaGFubmVsc1xuICAgICAgICA/IChmbGFncy5jaGFubmVscyBhcyBzdHJpbmcpXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKChjKSA9PiBjLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBhd2FpdCBjbWRBbm5vdW5jZShmcm9tIGFzIHN0cmluZywgdGV4dCwgY2hhbm5lbHMsIHsgcXVpZXQ6ICEhZmxhZ3MucXVpZXQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHVsbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcInN0YXR1c1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwicHVsbFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGF3YWl0IGNtZFB1bGwocG9zaXRpb25hbFswXSwgc2luY2UsIHsgc3RhdHVzOiBmbGFncy5zdGF0dXMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRyaWFnZVwiLFxuICAgIGZsYWdzOiBbXCJodW1hblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUcmlhZ2UocG9zaXRpb25hbFswXSwgeyBodW1hbjogISFmbGFncy5odW1hbiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgZmxhZ3M6IFtcInRleHRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBpZCA9IHBvc2l0aW9uYWxbMV0gPyBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCkgOiBOYU47XG4gICAgICBhd2FpdCBjbWRSZWFkKHBvc2l0aW9uYWxbMF0sIGlkLCB7IHRleHQ6ICEhZmxhZ3MudGV4dCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3YWl0XCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwidGltZW91dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGNvbnN0IHRpbWVvdXQgPSBudW1lcmljRmxhZyhcIndhaXRcIiwgXCJ0aW1lb3V0XCIsIGZsYWdzLnRpbWVvdXQsIDMwKTtcbiAgICAgIGF3YWl0IGNtZFdhaXQocG9zaXRpb25hbFswXSwgc2luY2UsIHRpbWVvdXQsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndob1wiLFxuICAgIGZsYWdzOiBbXCJhbGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGlmIChmbGFncy5hbGwpIGF3YWl0IGNtZFdob0FsbCgpO1xuICAgICAgZWxzZSBhd2FpdCBjbWRXaG8ocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYWxpYXNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQWxpYXMocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFpbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcImZyb20tc3RhcnRcIiwgXCJsYXN0XCIsIFwiaHVtYW5cIiwgXCJsdXJrXCIsIFwibWF4XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIHJldHVybiBhd2FpdCBjbWRUYWlsKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgc2luY2U6IGZsYWdzLnNpbmNlICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInRhaWxcIiwgXCJzaW5jZVwiLCBmbGFncy5zaW5jZSwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGZyb21TdGFydDogISFmbGFnc1tcImZyb20tc3RhcnRcIl0sXG4gICAgICAgIGxhc3Q6IGZsYWdzLmxhc3QgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcImxhc3RcIiwgZmxhZ3MubGFzdCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGFzOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBodW1hbjogISFmbGFncy5odW1hbixcbiAgICAgICAgbHVyazogISFmbGFncy5sdXJrLFxuICAgICAgICBtYXg6IHJlc29sdmVUYWlsTWF4KGZsYWdzLm1heCksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmVwXCIsXG4gICAgZmxhZ3M6IFtcImxpdGVyYWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwicGF0dGVyblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRHcmVwKHBvc2l0aW9uYWxbMF0sIHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIiksIHtcbiAgICAgICAgbGl0ZXJhbDogISFmbGFncy5saXRlcmFsLFxuICAgICAgICBmcm9tOiBmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQ2xvc2UocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzZXRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzZXQocG9zaXRpb25hbFswXSwgeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFya1wiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiZGlzcG9zaXRpb25cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBwb3NpdGlvbmFsLnNsaWNlKDIpLmpvaW4oXCIgXCIpLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJtYXJrXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlb3BlblwiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBcIm9wZW5cIixcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwicmVvcGVuXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCBmYWxzZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidW5hcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFyY2hpdmUocG9zaXRpb25hbFswXSwgdHJ1ZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhcnRcIixcbiAgICBhbGlhc2VzOiBbXCJ1cFwiXSxcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kU3RhcnQoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXN0YXJ0XCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlc3RhcnQoeyBmb3JjZTogISFmbGFncy5mb3JjZSB8fCAhIWZsYWdzLnllcyB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyb2xsXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJvbGwoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfHwgZmxhZ3MueWVzID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0b3BcIixcbiAgICBmbGFnczogW1wiaG9sZFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdG9wKHtcbiAgICAgICAgaG9sZFNlY29uZHM6XG4gICAgICAgICAgZmxhZ3MuaG9sZCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJzdG9wXCIsIFwiaG9sZFwiLCBmbGFncy5ob2xkLCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhdGNoXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZFdhdGNoKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYXBcIixcbiAgICBhbGlhc2VzOiBbXCJwcnVuZVwiXSxcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJkcnktcnVuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlYXAoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUsIGRyeVJ1bjogZmxhZ3NbXCJkcnktcnVuXCJdID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kSW5mbygpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWREb2N0b3IoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIC8vIFRoZSBDTEkgY2FuIGJlIEFTS0VEIHdoYXQgaXQgaXMuIGdyYXBldmluZSBhbHJlYWR5IGNhcnJpZXNcbiAgICAgIC8vIFBMVUdJTl9WRVJTSU9OIHRvIHdhcm4gdGhhdCBhIGRhZW1vbiBpcyBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZCBwbHVnaW5cbiAgICAgIC8vIHBhdGggdGhhbiB0aGlzIENMSSAobWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gpIOKAlCBidXQgYSBjYWxsZXIgdGhhdCBoaXRcbiAgICAgIC8vIHRoYXQgd2FybmluZywgb3IgdGhhdCBydW5zIGByb2xsYCBmb3IgaXRzIHZlcnNpb24gdmVyaWZ5LCBoYWQgbm8gd2F5IHRvXG4gICAgICAvLyBhc2sgdGhpcyBzaWRlIHdoYXQgaXQgaXMgaG9sZGluZy4gVGhlIHZhbHVlIHdhcyBhbHJlYWR5IGluIG1lbW9yeTsgb25seVxuICAgICAgLy8gdGhlIHF1ZXN0aW9uIHdhcyBtaXNzaW5nLlxuICAgICAgLy8gSlNPTiBieSBkZWZhdWx0LCBtYXRjaGluZyBldmVyeSBkYXRhIGNvbW1hbmQ7IC0taHVtYW4gZm9yIHByb3NlLlxuICAgICAgaWYgKFBMVUdJTl9WRVJTSU9OID09PSBudWxsKVxuICAgICAgICBkaWUoXCJ2ZXJzaW9uIHVuYXZhaWxhYmxlIOKAlCBjb3VsZCBub3QgcmVhZCBwbHVnaW4uanNvblwiLCBcImludGVybmFsXCIpO1xuICAgICAgaWYgKGZsYWdzLmh1bWFuID09PSB0cnVlKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIHYke1BMVUdJTl9WRVJTSU9OfVxcbmApO1xuICAgICAgZWxzZSBwcmludEpzb24oeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgLy8gRW1pdCB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIOKAlCBnZW5lcmF0ZWQgYnlcbiAgICAgIC8vIFdBTEtJTkcgQ09NTUFORFMgYW5kIENMSV9PUFRJT05TLCB0aGUgc2FtZSBzdHJ1Y3R1cmVzIHRoZSBwYXJzZXIgYW5kXG4gICAgICAvLyBkaXNwYXRjaGVyIGNvbnN1bWUsIGF0IGFuc3dlciB0aW1lLiBObyBkYWVtb24sIG5vIGNvbmZpZywgbm9cbiAgICAgIC8vIGNyZWRlbnRpYWxzOyBzdGRvdXQsIGV4aXQgMC4gVGhlIHNoYXBlIGlzIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjBcbiAgICAgIC8vIGV4YWN0bHksIHNvIHRoZSBvdXRwdXQgcGlwZXMgc3RyYWlnaHQgaW50b1xuICAgICAgLy8gYGFjYyBjaGVjayA8Y2xpPiAtLWRlY2xhcmF0aW9uIDwoZ3JhcGV2aW5lIHNjaGVtYSlgIHdpdGggbm8gYWRhcHRlci5cbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcmludEhlbHAoKTtcbiAgICB9LFxuICB9LFxuXTtcblxuZnVuY3Rpb24gZmluZENvbW1hbmQodG9rZW46IHN0cmluZyk6IENvbW1hbmRTcGVjIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIENPTU1BTkRTLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gdG9rZW4gfHwgYy5hbGlhc2VzPy5pbmNsdWRlcyh0b2tlbikpO1xufVxuXG4vLyBUaGUgdmVyYidzIGZ1bGwgYWNjZXB0ZWQgc2V0OiBpdHMgb3duIGZsYWdzIHBsdXMgdGhlIGNvbnRyYWN0dWFsbHktZ2xvYmFsXG4vLyBpZGVudGl0eSBwYWlyLCBpbiByZWdpc3RyeSBvcmRlci5cbmZ1bmN0aW9uIGFjY2VwdGVkRmxhZ3Moc3BlYzogQ29tbWFuZFNwZWMpOiBGbGFnTmFtZVtdIHtcbiAgY29uc3Qgb3duID0gbmV3IFNldDxGbGFnTmFtZT4oWy4uLkdMT0JBTF9GTEFHUywgLi4uc3BlYy5mbGFnc10pO1xuICByZXR1cm4gKE9iamVjdC5rZXlzKENMSV9PUFRJT05TKSBhcyBGbGFnTmFtZVtdKS5maWx0ZXIoKGspID0+IG93bi5oYXMoaykpO1xufVxuXG4vLyBSb290IGludGVyY2VwdG9ycyDigJQgZmxhZ3MgdGhlIFJPT1QgYW5zd2VycyBpdHNlbGYsIGJlZm9yZSBhbnkgdmVyYi4gVGhlc2UgYXJlXG4vLyBub3QgY29tbWFuZHMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IGEgZ2VuZXJhdG9yIHdhbGtpbmcgXCJ0aGUgY29tbWFuZHNcIiB3YWxrc1xuLy8gcGFzdCB0aGVtIChhY2MgRFQtNik7IHRoZXkgYXJlIGRlY2xhcmVkIGV4cGxpY2l0bHkgYXQgYHBhdGg6IFtdYC5cbmNvbnN0IFJPT1RfSU5URVJDRVBUT1JTID0gW1xuICB7IG5hbWU6IFwiLS1oZWxwXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItaFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLS12ZXJzaW9uXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG4gIHsgbmFtZTogXCItVlwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuLy8gYWNjIGRlY2xhcmF0aW9uIGZvcm1hdCB2MCAoc2VlIGFnZW50LWNsaS1jb25mb3JtYW5jZSBzcmMvYWNjL2tpdC9kZWNsYXJhdGlvbi50cyk6XG4vLyB7IGZvcm1hdFZlcnNpb24sIHByb3ZlbmFuY2UsIHNlbGZEZXNjcmlwdGlvbiwgY29tbWFuZHM6IFt7IHBhdGgsIGFyZ3MsIHBvc2l0aW9uYWxzIH1dIH0uXG4vLyB2MCByZWZ1c2VzIHVua25vd24ga2V5cywgc28gbm90aGluZyByaWNoZXIgKGVmZmVjdHMsIHN1bW1hcmllcywgdmVyc2lvbnMpXG4vLyByaWRlcyBhbG9uZyDigJQgdGhvc2Ugd2FpdCBmb3IgYSB2MSB3aXRoIHNsb3RzIGZvciB0aGVtLlxuZnVuY3Rpb24gYnVpbGREZWNsYXJhdGlvbigpIHtcbiAgLy8gRXZlcnkgcmVnaXN0cnkgZmxhZyBpcyBhY2NlcHRlZCB0b2RheTsgYSByZWZ1c2FsIGxpc3Qgd291bGQgYWRkXG4gIC8vIHN0YXR1czogXCJyZWZ1c2VkXCIgZW50cmllcyBoZXJlIHRoZSBkYXkgYSB2ZXJiIHJlY29nbmlzZXMtYW5kLWRlY2xpbmVzIG9uZS5cbiAgY29uc3QgYXJnID0gKGs6IEZsYWdOYW1lKSA9PiAoe1xuICAgIG5hbWU6IGAtLSR7a31gLFxuICAgIHR5cGU6IENMSV9PUFRJT05TW2tdLnR5cGUsXG4gICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gIH0pO1xuICBjb25zdCBjb21tYW5kczoge1xuICAgIHBhdGg6IHN0cmluZ1tdO1xuICAgIGFyZ3M6IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBcInN0cmluZ1wiIHwgXCJib29sZWFuXCI7IHN0YXR1czogc3RyaW5nIH1bXTtcbiAgICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgfVtdID0gW1xuICAgIHtcbiAgICAgIC8vIGBwYXRoOiBbXWAgSVMgdGhlIHJvb3QuIEl0cyBncmFtbWFyOiBvbmUgcmVxdWlyZWQgdG9rZW4gc2VsZWN0aW5nIGFcbiAgICAgIC8vIGNvbW1hbmQsIG9yIGFuIGludGVyY2VwdG9yIGZsYWcgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuXG4gICAgICBwYXRoOiBbXSxcbiAgICAgIGFyZ3M6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgICB9KSksXG4gICAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIH0sXG4gIF07XG4gIGZvciAoY29uc3Qgc3BlYyBvZiBDT01NQU5EUykge1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbc3BlYy5uYW1lLCAuLi4oc3BlYy5hbGlhc2VzID8/IFtdKV0pIHtcbiAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICBwYXRoOiBbbmFtZV0sXG4gICAgICAgIGFyZ3M6IGFjY2VwdGVkRmxhZ3Moc3BlYykubWFwKChrKSA9PiBhcmcoaykpLFxuICAgICAgICBwb3NpdGlvbmFsczogc3BlYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbXCJzY2hlbWFcIl0gfSxcbiAgICBjb21tYW5kcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VGbGFncyhcbiAgYXJndjogc3RyaW5nW10sXG4gIHNwZWM6IENvbW1hbmRTcGVjLFxuKToge1xuICBwb3NpdGlvbmFsOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdzO1xufSB7XG4gIGNvbnN0IGFjY2VwdGVkID0gYWNjZXB0ZWRGbGFncyhzcGVjKTtcbiAgY29uc3Qgb3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhhY2NlcHRlZC5tYXAoKGspID0+IFtrLCBDTElfT1BUSU9OU1trXV0pKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBwb3NpdGlvbmFsOiBwb3NpdGlvbmFscyxcbiAgICAgIGZsYWdzOiB2YWx1ZXMgYXMgRmxhZ3MsXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBjb25zdCBib2R5SGludCA9XG4gICAgICBzcGVjLm5hbWUgPT09IFwic2VuZFwiIHx8IHNwZWMubmFtZSA9PT0gXCJhbm5vdW5jZVwiXG4gICAgICAgID8gXCJmb3IgYSBtZXNzYWdlIGJvZHkgY29udGFpbmluZyBkYXNoZXMsIHVzZSAtLXN0ZGluIG9yIC0tYm9keS1maWxlLCBcIiArXG4gICAgICAgICAgXCJvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCJcbiAgICAgICAgOiBcIlwiO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGAke3NwZWMubmFtZX06ICR7ZGV0YWlsfWAsIHtcbiAgICAgIC8vIOKblCBUSEUgU0VUIElTIGBjaG9pY2VzYCBOT1csIE5PVCBBIFBST1NFIE1BUktFUi4gSXQgdXNlZCB0byBiZSBhIHNlY29uZFxuICAgICAgLy8gbGluZSByZWFkaW5nIGByZWNvZ25pemVkIGZsYWdzOiAtLWEgLS1iYCwgc3BlbGxlZCB3aXRoIHRoZSBjb2xvblxuICAgICAgLy8gc3RyYWlnaHQgYWZ0ZXIgdGhlIG5vdW4gYmVjYXVzZSB0aGF0IGlzIHRoZSBtYXJrZXIgc2hhcGUgYSBmbGFnLXNldFxuICAgICAgLy8gZXh0cmFjdG9yIG1hdGNoZXMuXG4gICAgICAvL1xuICAgICAgLy8g4pqgIEFORCBOT1QgQkVDQVVTRSBUSEUgTUFSS0VSIFdPVUxEIEhBVkUgU1RPUFBFRCBXT1JLSU5HIOKAlCB0aGF0IHJlYXNvblxuICAgICAgLy8gd2FzIHdyaXR0ZW4gaGVyZSBhbmQgaW4gRDcxLCBhbmQgaXQgaXMgRkFMU0UuIGFjYyBwYXJzZXMgdGhlIHdob2xlXG4gICAgICAvLyBlbnZlbG9wZSwgdGhlbiB3YWxrcyBgc3RyaW5nVmFsdWVzT2YoZG9jdW1lbnQpYCBhbmQgcnVucyB0aGUgU0FNRSBwcm9zZVxuICAgICAgLy8gTUFSS0VSIHJlZ2V4IG92ZXIgZXZlcnkgc3RyaW5nIGluc2lkZSBpdCwgZm9yIGV4YWN0bHkgdGhpcyBjYXNlXG4gICAgICAvLyAoYGFnZW50LWNsaS1jb25mb3JtYW5jZS9zcmMvYWNjL2tpdC9zdXJmYWNlLnRzOjY1My02NTZgLCB3aG9zZSBkb2NcbiAgICAgIC8vIGNvbW1lbnQgbmFtZXMgYW50aGlsbCdzIGBcIlZhbGlkIGZsYWdzOiAtLWZvcm1hdFwiYCBpbnNpZGUgYW4gYGVycm9yYFxuICAgICAgLy8gc3RyaW5nKS4gQSBtYXJrZXIgZW1iZWRkZWQgaW4gdGhlIGVudmVsb3BlIHdvdWxkIHN0aWxsIGhhdmUgYmVlbiByZWFkLlxuICAgICAgLy9cbiAgICAgIC8vIFRoZSBtb3ZlIGlzIHJpZ2h0IGZvciByZWFzb25zIHRoYXQgc3Vydml2ZSB0aGF0IGNvcnJlY3Rpb246IGBjaG9pY2VzYCBpc1xuICAgICAgLy8gdGhlIGVudmVsb3BlJ3Mgb3duIGZpZWxkIGZvciB0aGUgYWNjZXB0ZWQgc2V0LCBpdCBpcyB3aGF0IGdsYW1vdXJcbiAgICAgIC8vIHB1Ymxpc2hlcyBhdCBDT05GT1JNQU5UIEwwLCBhbiBBUlJBWSBjYW5ub3QgYmUgdHJ1bmNhdGVkIGJ5IGEgcmVhZGVyXG4gICAgICAvLyB0aGF0IHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB3aGljaCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLCBhbmQgb25lXG4gICAgICAvLyBzcGVsbGluZyBvZiBvbmUgc2V0IGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBvdGhlci5cbiAgICAgIGNob2ljZXM6IGFjY2VwdGVkLm1hcCgoaykgPT4gYC0tJHtrfWApLFxuICAgICAgLi4uKGJvZHlIaW50ID8geyBoaW50OiBib2R5SGludCB9IDoge30pLFxuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbW1hbmRUb2tlbnMoKTogc3RyaW5nW10ge1xuICByZXR1cm4gQ09NTUFORFMuZmxhdE1hcCgoYykgPT4gW2MubmFtZSwgLi4uKGMuYWxpYXNlcyA/PyBbXSldKTtcbn1cblxuZnVuY3Rpb24gcHJpbnRIZWxwKCkge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIOKAlCBhZ2VudC10by1hZ2VudCB3YWxraWUtdGFsa2llXG5cblVzYWdlOlxuICBncmFwZXZpbmUgb3BlbiA8bmFtZT4gWy0tdG9waWMgPHRleHQ+XSBbLS1mcmVzaF0gICBvcGVuL2NyZWF0ZSAoYXV0by11bmFyY2hpdmVzOyAtLWZyZXNoIGNsZWFycyBhIGRvcm1hbnQgY2hhbm5lbClcbiAgZ3JhcGV2aW5lIGxpc3RcbiAgZ3JhcGV2aW5lIHNlbmQgPG5hbWU+IFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1xdWlldF0gWy0tdmVyYm9zZV0gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLWZvcmNlXSBbLS1pbi1yZXBseS10byA8aWQ+XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBib2R5OiBpbmxpbmUgdGV4dCwgLS1zdGRpbiwgLS1ib2R5LWZpbGUsIG9yIHBpcGVkIHN0ZGluIChkZWZhdWx0IHdoZW4gbm8gaW5saW5lIHRleHQpXG4gIGdyYXBldmluZSBhbm5vdW5jZSBbLS1mcm9tLy0tYXMgPGFsaWFzPl0gWy0tY2hhbm5lbHMgYSxiLGNdIFstLXN0ZGluXSBbLS1ib2R5LWZpbGUgPHBhdGg+XSBbLS1xdWlldF0gWzx0ZXh0Li4uPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgYnJvYWRjYXN0IG9uZSBtZXNzYWdlIHRvIGV2ZXJ5IGFjdGl2ZSBjaGFubmVsIChvciAtLWNoYW5uZWxzKVxuICBncmFwZXZpbmUgdGFpbCA8bmFtZT4gWy0tYXMvLS1mcm9tIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XSBbLS1odW1hbl0gWy0tbHVya10gWy0tbWF4IDxuPl1cbiAgICAgICAjIC0tbGFzdCA8bj46IGJhY2tmaWxsIHRoZSBtb3N0IHJlY2VudCBuIG1lc3NhZ2VzIHRoZW4gZ28gbGl2ZSAoYm91bmRlZCBjYXRjaC11cCBmb3IgYSBjb2xkIGpvaW5lcilcbiAgZ3JhcGV2aW5lIHB1bGwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XSAgICMgLS1zdGF0dXMgPSBmdWxsLXNjYW4gZmlsdGVyIChvcGVufHdvbnRmaXh8aW5jb3Jwb3JhdGVkfOKApilcbiAgZ3JhcGV2aW5lIHRyaWFnZSA8bmFtZT4gICAgICAgICAgICAgIyBmdWxsLXNjYW46IG9wZW4gbWVzc2FnZXMgb24gdG9wICsgZ3JvdXBlZCBieV9zdGF0dXNcbiAgZ3JhcGV2aW5lIG1hcmsgPG5hbWU+IDxpZD4gPGRpc3Bvc2l0aW9uPiBbLS1ub3RlIDx0ZXh0Pl0gICMgc2V0IGRpc3Bvc2l0aW9uIChpbmNvcnBvcmF0ZWR8d29udGZpeHxkZWZlcnJlZHzigKYpXG4gIGdyYXBldmluZSByZW9wZW4gPG5hbWU+IDxpZD4gICAgICAgICMgYm91bmNlIGEgbWVzc2FnZSBiYWNrIHRvIG9wZW5cbiAgZ3JhcGV2aW5lIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF0gICAjIG9uZSBmdWxsIG1lc3NhZ2UgYnkgaWQgKC0tdGV4dCA9IHByb3NlKVxuICBncmFwZXZpbmUgd2FpdCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXG4gIGdyYXBldmluZSBncmVwIDxuYW1lPiA8cGF0dGVybj4gWy0tbGl0ZXJhbF0gWy0tZnJvbSA8YWxpYXM+XVxuICBncmFwZXZpbmUgdG9waWMgPG5hbWU+IFs8dGV4dD5dICAgIyBubyB0ZXh0IOKGkiByZWFkIGN1cnJlbnQ7IHdpdGggdGV4dCDihpIgdXBkYXRlXG4gIGdyYXBldmluZSB3aG8gPG5hbWU+ICAgICAgICAgICAgICAjIHJvc3RlcjsgdGhlIGh1bWFucyBmaWVsZCBsaXN0cyBodW1hbnNcbiAgZ3JhcGV2aW5lIGFsaWFzIFs8bmFtZT5dICAgICAgICAgICMgc2V0L3Nob3cgeW91ciBwZXJzaXN0ZWQgYWxpYXMgKGNvbmZpZy5qc29uKVxuICBncmFwZXZpbmUgd2F0Y2ggWzxuYW1lPl0gICAgICAgICAgIyBvcGVuIGJyb3dzZXIgdGFiOyBsaXZlIGNoYXQtYnViYmxlIHZpZXdcbiAgZ3JhcGV2aW5lIHJlc2V0IDxuYW1lPiBbLS1mb3JjZV0gICAgICAgICAgIHNuYXBzaG90IHRoZSBsb2cg4oaSIH4vLmdyYXBldmluZS9hcmNoaXZlLCB0aGVuIGNsZWFyIGl0XG4gIGdyYXBldmluZSBhcmNoaXZlIDxuYW1lPiAgICAgICAgICAjIHJlYWQtb25seToga2VlcCBoaXN0b3J5LCByZWplY3Qgc2VuZHNcbiAgZ3JhcGV2aW5lIHVuYXJjaGl2ZSA8bmFtZT4gICAgICAgICMgYnJpbmcgYW4gYXJjaGl2ZWQgY2hhbm5lbCBiYWNrXG4gIGdyYXBldmluZSBjbG9zZSA8bmFtZT4gICAgICAgICAgICAjIGRlc3RydWN0aXZlOiBkZWxldGUgdGhlIG1lc3NhZ2UgbG9nXG4gIGdyYXBldmluZSBzdGFydCAgICAgICAgICAgICAgICAgICAjIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHJ1bm5pbmcgKGFsaWFzOiB1cCk7IG5vIGNoYW5uZWxcbiAgZ3JhcGV2aW5lIHJlc3RhcnQgWy0tZm9yY2V8LS15ZXNdICMgc3RvcCArIHJlc3Bhd24gZnJlc2g7IC0tZm9yY2UgdG8gb3ZlcnJpZGUgdGhlIGxpdmUtZmxlZXQgZ3VhcmRcbiAgZ3JhcGV2aW5lIHJvbGwgWy0tZm9yY2VdICAgICAgICAgICMgc2FmZSByZXN0YXJ0IChzdG9wK2hvbGQrcmVzcGF3bikgKyB2ZXJzaW9uIHZlcmlmeSDigJQgdGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwXG4gIGdyYXBldmluZSBzdG9wIFstLWhvbGQgPHNlY29uZHM+XSAjIGtpbGwgdGhlIGRhZW1vbjsgLS1ob2xkIHN1cHByZXNzZXMgYXV0by1yZXNwYXduIGZvciA8cz4gc2Vjb25kcyAodXBncmFkZSB3aW5kb3cpXG4gIGdyYXBldmluZSBpbmZvXG4gIGdyYXBldmluZSBkb2N0b3IgICAgICAgICAgICAgICAgICAjIGhlYWx0aCBjaGVjayDigJQgbGFiZWxzIGVhY2ggZGFlbW9uOiBhdXRob3JpdGF0aXZlIC8gb3JwaGFuIC8gdW5yZXNwb25zaXZlIC8gdW5rbm93blxuICBncmFwZXZpbmUgcmVhcCBbLS1mb3JjZV0gWy0tZHJ5LXJ1bl0gICMga2lsbCBvcnBoYW4gZGFlbW9uczsgLS1mb3JjZSBhbHNvIGtpbGxzIHVucmVzcG9uc2l2ZTsgYWxpYXM6IHBydW5lXG5cbiAgZ3JhcGV2aW5lIHNjaGVtYSAgICAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSBkZXNjcmlwdGlvbiAoYWNjIGRlY2xhcmF0aW9uIHYwKVxuICBncmFwZXZpbmUgLS12ZXJzaW9uICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIHZlcnNpb24gKGFsaWFzOiAtViwgdmVyc2lvbilcbiAgZ3JhcGV2aW5lIGhlbHAgICAgICAgICAgICAgICAgICAgICMgdGhpcyB1c2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXG5cbk91dHB1dDpcbiAgRGF0YSBjb21tYW5kcyBlbWl0IEpTT04gb24gc3Rkb3V0IGJ5IERFRkFVTFQ7IHBhc3MgLS1odW1hbiBmb3IgcHJvc2Ugd2hlcmUgYVxuICBjb21tYW5kIG9mZmVycyBpdC4gRGlhZ25vc3RpY3MgYW5kIHdhcm5pbmdzIGdvIHRvIHN0ZGVyciwgbmV2ZXIgc3Rkb3V0LlxuICBVc2FnZSBlcnJvcnMgZXhpdCAyLiBFYWNoIGNvbW1hbmQgYWNjZXB0cyBpdHMgT1dOIGZsYWdzIChwbHVzIC0tYXMvLS1mcm9tLFxuICB3aGljaCBhcmUgZ2xvYmFsKSDigJQgYW4gdW5rbm93biBmbGFnIGZvciBhIHZlcmIgZW51bWVyYXRlcyB0aGF0IHZlcmIncyBzZXQuXG5cbkVudjpcbiAgR1JBUEVWSU5FX0ZST00gICBEZWZhdWx0IGlkZW50aXR5IGFsaWFzICgtLWZyb20vLS1hcyBhcmUgaW50ZXJjaGFuZ2VhYmxlKS5cbiAgR1JBUEVWSU5FX0hPTUUgICBEYXRhIGRpciAoZGVmYXVsdCB+Ly5ncmFwZXZpbmUpLlxuYCk7XG59XG5cbi8qKlxuICogVGhlIHZlcmIgcm91dGVyLiBFdmVyeSByZWplY3Rpb24gaGVyZSBSQUlTRVM7IG5vdGhpbmcgd3JpdGVzIGl0cyBvd24gcHJvc2UuXG4gKlxuICog4puUIFRISVMgRlVOQ1RJT04gVVNFRCBUTyBCRSBgbWFpbmAsIEFORCBJVFMgRk9VUiBSRUpFQ1RJT05TIFVTRUQgVE8gQkVcbiAqIGBwcm9jZXNzLnN0ZGVyci53cml0ZSguLi4pOyByZXR1cm4gMmAg4oCUIGEgU0VDT05EIGVycm9yIGNvbnRyYWN0IGJlc2lkZSBgZGllYCxcbiAqIHdpdGggaXRzIG93biB3b3JkaW5nLCBpdHMgb3duIG1hcmtlcnMgYW5kIG5vIGBraW5kYCBvbiB0aGUgd2lyZS4gQSBncmVwIGZvclxuICogYGRpZShgIHdvdWxkIGhhdmUgcmVwb3J0ZWQgXCJ0aGUgZXJyb3IgY29udHJhY3QgaXMgNDYgc2l0ZXNcIjsgaXQgd2FzIDQ2IHBsdXNcbiAqIHRoZXNlLCBhbmQgdGhlc2UgYXJlIHRoZSBvbmVzIGFuIGFnZW50IG1lZXRzIGZpcnN0IChwbGF5Ym9vayBCODogbG9vayBmb3IgdGhlXG4gKiBSQUlTRSwgbm90IGZvciB0aGUgaGVscGVyKS4gVGhleSBub3cgcmFpc2UgdGhlIHNhbWUgZW52ZWxvcGUgYXMgdGhlIHJlc3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgW2NtZCwgLi4ucmVzdF0gPSBhcmd2O1xuXG4gIC8vIEJBUkUgSU5WT0NBVElPTiBJUyBBIFVTQUdFIEVSUk9SIOKAlCBleGl0IDIsIHVzYWdlIHBvaW50ZXIgb24gc3RkZXJyIOKAlCBub3QgYVxuICAvLyBoZWxwIHJlcXVlc3QgYXQgZXhpdCAwLiBncmFwZXZpbmUncyBjYWxsZXJzIGFyZSBhZ2VudHM6IGEgYmFyZSBjYWxsIGlzIGFuXG4gIC8vIHVuc2V0IHNoZWxsIHZhcmlhYmxlIGV4cGFuZGluZyB0byBub3RoaW5nLCBvciBhIG1pc3Rha2UsIGFuZCBhbnN3ZXJpbmcgaXRcbiAgLy8gd2l0aCAyLjlLQiBvZiBoZWxwIGF0IGV4aXQgMCByZXBvcnRzIHN1Y2Nlc3MgZm9yIGEgY29tbWFuZCB0aGF0IGFza2VkIGZvclxuICAvLyBub3RoaW5nLiBgaGVscGAgLyBgLS1oZWxwYCByZW1haW4gb25lIHRva2VuIGF3YXkgYXQgZXhpdCAwIChhY2MgRDIg4oCUXG4gIC8vIGNvbmZvcm1lZCBmb3IgdGhhdCByZWFzb24sIG5vdCBiZWNhdXNlIHRoZSBydWxlIHNhaWQgc28pLlxuICBpZiAoY21kID09PSB1bmRlZmluZWQpIHtcbiAgICBkaWUoXCJleHBlY3RlZCBhIGNvbW1hbmRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICBjaG9pY2VzOiBjb21tYW5kVG9rZW5zKCksXG4gICAgICBoaW50OiBcInJ1biBgZ3JhcGV2aW5lIGhlbHBgIChvciAtLWhlbHApIGZvciB1c2FnZVwiLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gUk9PVCBGTEFHIFJPVVRJTkcuIEEgbGVhZGluZyAtLXRva2VuIHVzZWQgdG8gYmUgY29uc3VtZWQgYXMgdGhlIENPTU1BTkRcbiAgLy8gdG9rZW4gYW5kIHJlamVjdGVkIGFzIGB1bmtub3duIGNvbW1hbmQ6IC0tbm9wZWAg4oCUIGEgZmxhZyByZWFjaGluZyB0aGUgdmVyYlxuICAvLyBwYXJzZXIncyBlcnJvciBwYXRoLCB3aGVyZSB0aGUgcmVqZWN0aW9uIGNvdWxkIG5vdCBlbnVtZXJhdGUgdGhlIGZsYWcgc2V0XG4gIC8vIChmb3VuZCB2aWEgYWNjJ3Mgcm9vdC1vbmx5IHN1cmZhY2UgY2FwdHVyZSkuIFRoZSByb290J3MgYWNjZXB0ZWQgZmxhZ3MgYXJlXG4gIC8vIHRoZSBpbnRlcmNlcHRvcnM7IGFueXRoaW5nIGVsc2UgZGFzaGVkIGlzIHJlamVjdGVkIEFTIEEgRkxBRywgZW51bWVyYXRpbmdcbiAgLy8gdGhlIHJvb3QncyBvd24gc2V0LlxuICBpZiAoY21kLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBST09UX0lOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGNtZCk7XG4gICAgaWYgKCFpbnRlcmNlcHRvcikge1xuICAgICAgLy8g4pqgIFRIRSBTT1JUIFNVUlZJVkVTIFRIRSBNT1ZFIElOVE8gYGNob2ljZXNgLCBBTkQgSVQgSVMgTk9UIERFQ09SQVRJT04uXG4gICAgICAvLyBMb25nIGZsYWdzIGZpcnN0LCBiZWNhdXNlIGEgZmxhZy1zZXQgZXh0cmFjdG9yIHJlYWRzIHRoZSBsaXN0XG4gICAgICAvLyBsZWZ0LXRvLXJpZ2h0IGFuZCBzdG9wcyBhdCB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLFxuICAgICAgLy8gc28gYSBzaG9ydCBhbGlhcyBtaWQtbGlzdCB0cnVuY2F0ZXMgd2hhdCBpdCBzZWVzLiBBbiBhcnJheSBpcyBub3RcbiAgICAgIC8vIHZ1bG5lcmFibGUgdG8gdGhhdCDigJQgYnV0IHRoZSBvcmRlciBpcyBmcmVlIGFuZCB0aGUgcHJvcGVydHkgaXMgcmVhbCBmb3JcbiAgICAgIC8vIGFueSBjb25zdW1lciB0aGF0IGZsYXR0ZW5zIGl0IGJhY2sgdG8gYSBsaW5lLlxuICAgICAgZGllKGB1bmtub3duIGZsYWcgYXQgdGhlIHJvb3Q6ICR7Y21kfWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4uUk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpXS5zb3J0KFxuICAgICAgICAgIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbiAgICAgICAgKSxcbiAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke2NvbW1hbmRUb2tlbnMoKS5qb2luKFwiIFwiKX1gLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBydW5Db21tYW5kKGZpbmRDb21tYW5kKGludGVyY2VwdG9yLnJ1bnMpIGFzIENvbW1hbmRTcGVjLCByZXN0KTtcbiAgfVxuXG4gIGNvbnN0IHNwZWMgPSBmaW5kQ29tbWFuZChjbWQpO1xuICBpZiAoIXNwZWMpIHtcbiAgICAvLyBUaGUgdW5rbm93bi12ZXJiIHJlamVjdGlvbiBlbnVtZXJhdGVzIHRoZSB2YWxpZCBzZXQsIGV4YWN0bHkgYXMgdGhlXG4gICAgLy8gdW5rbm93bi1mbGFnIHJlamVjdGlvbiBkb2VzIOKAlCB0aGUgcGFyc2VyJ3Mgb3duIGFjY291bnQgb2Ygd2hhdCBpdFxuICAgIC8vIGFjY2VwdHMsIHByb2R1Y2VkIGJ5IHRoZSBwYXJzZXIgKGFjYyBTVEFOREFSRC5tZCwgXCJ0aGUgY2hlYXBlc3QgdmVyc2lvblxuICAgIC8vIG9mIGNoZWNrZWRcIikuXG4gICAgZGllKGB1bmtub3duIGNvbW1hbmQ6ICR7Y21kfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzOiBjb21tYW5kVG9rZW5zKCkgfSk7XG4gIH1cbiAgcmV0dXJuIGF3YWl0IHJ1bkNvbW1hbmQoc3BlYywgcmVzdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkNvbW1hbmQoc3BlYzogQ29tbWFuZFNwZWMsIHJlc3Q6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IHBvc2l0aW9uYWw6IHN0cmluZ1tdO1xuICBsZXQgZmxhZ3M6IEZsYWdzO1xuICB0cnkge1xuICAgICh7IHBvc2l0aW9uYWwsIGZsYWdzIH0gPSBwYXJzZUZsYWdzKHJlc3QsIHNwZWMpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICBkaWUoZS5tZXNzYWdlLCBcInVzYWdlXCIsIGUuZXh0cmEpO1xuICB9XG4gIC8vIEFyaXR5LCBlbmZvcmNlZCBGUk9NIFRIRSBERUNMQVJFRCBTSEFQRSDigJQgdGhlIHJlZ2lzdHJ5J3MgcG9zaXRpb25hbCBzcGVjIGlzXG4gIC8vIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLCBzbyBlbmZvcmNpbmcgaXQgaGVyZSBpcyB3aGF0IGtlZXBzIHRoZSBkZWNsYXJhdGlvblxuICAvLyB0cnVlIGJ5IGNvbnN0cnVjdGlvbjogYSBtaXNzaW5nIHJlcXVpcmVkIHBvc2l0aW9uYWwgZXJyb3JzIGJlZm9yZSB0aGUgdmVyYlxuICAvLyBydW5zLCBhbmQgYW4gRVhDRVNTIHBvc2l0aW9uYWwgaXMgcmVqZWN0ZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgc3dhbGxvd2VkXG4gIC8vIChhY2MgQTQncyBzaGFwZSDigJQgdGhlIGRlZmVjdCBubyBleHRlcm5hbCBjaGVjayBjYW4gc2VlKS5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3NpdGlvbmFsLmxlbmd0aCA8IHJlcXVpcmVkKSB7XG4gICAgY29uc3QgbWlzc2luZyA9IHNwZWMucG9zaXRpb25hbHNbcG9zaXRpb25hbC5sZW5ndGhdO1xuICAgIGRpZShgJHtzcGVjLm5hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIDwke21pc3Npbmc/Lm5hbWUgPz8gXCJhcmd1bWVudFwifT5gLCBcInVzYWdlXCIsIHtcbiAgICAgIGhpbnQ6IGBleHBlY3RzOiAke3NwZWMubmFtZX0gJHtzcGVjLnBvc2l0aW9uYWxzXG4gICAgICAgIC5tYXAoKHApID0+IChwLnJlcXVpcmVkID8gYDwke3AubmFtZX0+YCA6IGBbJHtwLm5hbWV9XWApKVxuICAgICAgICAuam9pbihcIiBcIil9YCxcbiAgICB9KTtcbiAgfVxuICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWwubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICBkaWUoXG4gICAgICBgJHtzcGVjLm5hbWV9OiB1bmV4cGVjdGVkIGFyZ3VtZW50ICR7SlNPTi5zdHJpbmdpZnkocG9zaXRpb25hbFtzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aF0pfWAsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IGBleHBlY3RzOiAke3NwZWMubmFtZX0gJHtcbiAgICAgICAgICBzcGVjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHAucmVxdWlyZWQgPyBgPCR7cC5uYW1lfT5gIDogYFske3AubmFtZX1dYCkpLmpvaW4oXCIgXCIpIHx8XG4gICAgICAgICAgXCIobm8gYXJndW1lbnRzKVwiXG4gICAgICAgIH1gLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBzcGVjLnJ1bihwb3NpdGlvbmFsLCBmbGFncyk7XG4gIHJldHVybiB0eXBlb2Ygb3V0Y29tZSA9PT0gXCJudW1iZXJcIiA/IG91dGNvbWUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBvbmUgcGxhY2UgdGhpcyBDTEkgY2FuIGVuZCwgYW5kIHRoZSBvbmUgcGxhY2UgYSBgQ2xpRXJyb3JgIGJlY29tZXMgYW5cbiAqIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgQURERUQgQVQgUEhBU0UgNiBDSEFQVEVSIDIsIEFORCBJVCBJUyBXSEFUIE1BS0VTIGBkaWVgIFNBRkUgVE8gVEhST1cuXG4gKiBgcmVwb3J0Q2xpRXJyb3JgIHdyaXRlcyB0aGUgZW52ZWxvcGUgYW5kIGhhbmRzIGJhY2sgdGhlIHRheG9ub215IGNvZGU7IGFcbiAqIHRocm93IGl0IGRvZXMgTk9UIHJlY29nbmlzZSBpcyByZS10aHJvd24sIGJlY2F1c2Ugc3dhbGxvd2luZyBhbiB1bmtub3duIG9uZVxuICogaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5IHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlXG4gKiBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqXG4gKiDimqAgQU5EIGBzZXRDdXJyZW50Q29tbWFuZGAgSVMgTk9UIERFQ09SQVRJT04g4oCUIGl0IGlzIHRoZSBgbWV0YS5jb21tYW5kYCBmaWVsZFxuICogb2YgZXZlcnkgZW52ZWxvcGUgdGhpcyBDTEkgZW1pdHMsIHdoaWNoIGlzIGhvdyBhIGNhbGxlciByb3V0aW5nIG9uIGBraW5kYFxuICoga25vd3MgV0hJQ0ggdmVyYiBwcm9kdWNlZCBpdC4gU2V0IGZyb20gdGhlIHJhdyB0b2tlbiBzbyBhbiB1bmtub3duIHZlcmIgc3RpbGxcbiAqIG5hbWVzIGl0c2VsZiBpbiBpdHMgb3duIHJlamVjdGlvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHNldEN1cnJlbnRDb21tYW5kKGFyZ3ZbMF0gPz8gbnVsbCk7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlICE9PSBudWxsKSByZXR1cm4gY29kZTtcbiAgICB0aHJvdyBlO1xuICB9XG59XG5cbi8vIOKblCBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBJVFMgQUJTRU5DRSBJUyBUSEUgU1RFUCAocGxheWJvb2sgQjMpLlxuLy8gYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSBgc2NyaXB0cy9jbGkudHNgLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuLy8gZW50cnksIHNvIHRoZSBndWFyZCB3b3VsZCBuZXZlciBydW4gYW5kIGV2ZXJ5IHZlcmIgd291bGQgcHJpbnQgbm90aGluZyBhbmRcbi8vIGV4aXQgMC4gTm9yIG1heSB0aGlzIGZpbGUgb2ZmZXIgYSBzZWNvbmQgZW50cnkgZnJvbSBpdHMgYXV0aG9yaW5nIGFkZHJlc3M6XG4vLyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAsIGBTVVJGQUNFX0NXRGAgYW5kIGBEQUVNT05fU0NSSVBUYCBhYm92ZSBhcmUgYWxsXG4vLyBjb21wdXRlZCBmcm9tIGBTQ1JJUFRfRElSYCBhbmQgYXJlIGNvcnJlY3Qgb25seSBmcm9tIGBkaXN0L2AuXG4vL1xuLy8gVGhlIGRyYWluIGNvbnRyYWN0IGxpdmVzIGF0IHRoZSBsYXVuY2hlciBub3cg4oCUIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbFxuLy8gcmV0dXJuLCBuZXZlciBhbiBleHBsaWNpdCBleGl0LCBiZWNhdXNlIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYVxuLy8gcGlwZSBhbmQgYHRhaWxgIHdyaXRlcyBKU09OTCBhIGNhbGxlciBwYXJzZXMuIFNlZVxuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9jbGkudHNgIGZvciB0aGUgZnVsbCBhY2NvdW50LlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogR3JhcGV2aW5lJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyBvZiB0aGUgc3BlbGwsIGFuZCBUSEUgT05FIFBMQUNFIFRIRSBFTlYgSVMgUkVBRC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLCBBTkQgRk9SIEdSQVBFVklORSBUSEUgU0VBTSBJUyBSRUFMIOKAlCB0aGUgZmlyc3QgdGltZVxuICogaW4gZm91ciBwb3J0cyAocGxheWJvb2sgQjgsIGVudHJ5LWJsb2NrIHF1ZXN0aW9uIDMpLiBCZWZvcmUgUGhhc2UgNiB0aGVcbiAqIGhlYXJ0YmVhdCB3YXMgYSBMSVRFUkFMIGAzMDAwYCBpbnNpZGUgYGRhZW1vbi50c2AncyBTU0Ugc3RyZWFtLCBgaWRsZVRpbWVvdXQ6XG4gKiAyNTVgIHdhcyBhIHNlY29uZCBsaXRlcmFsIHRlbiBsaW5lcyBhd2F5IHdpdGggdGhlIHJlbGF0aW9uc2hpcCB3cml0dGVuIG9ubHkgaW5cbiAqIHByb3NlLCBhbmQgYGNsaS50c2AncyB0YWlsIGhhZCBOTyB3YXRjaGRvZyBhdCBhbGwg4oCUIGl0IGJsb2NrZWQgb25cbiAqIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGUgZmFpbHVyZSB0aGUga2l0J3Mgd2F0Y2hkb2cgZXhpc3RzIHRvXG4gKiBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vblxuICogd291bGQgZHJhZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzXG4gKiBidXQgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKiBBIHZhbHVlIHRoYXQgY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR1JBUEVWSU5FJ1MgT1dOIEhFQVJUQkVBVCwgTkVWRVIgQ09QSUVEXG4gKiBGUk9NIEEgU0lCTElORy4qKiBUaGlzIGlzIHRoZSBydWxlIGFzdHJvbGFiZSBwYWlkIGZvcjogYSBoYXJkLWNvZGVkIDQ1IHNcbiAqIHdhdGNoZG9nIGFnYWluc3QgYW4gZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZCByZWNvbm5lY3RzIGF0ICs0Ny40IHMsXG4gKiArOTIuNiBzIGFuZCArMTM3LjkgcyBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2VcbiAqIGFuIHVucmVsYXRlZCB0aGlyZCBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uIOKaoCBHcmFwZXZpbmUgaXMgdGhlIHNwZWxsIHRoYXRcbiAqIG1ha2VzIHRoZSBwb2ludCBzaGFycGVzdDogaXQgYmVhdHMgYXQgKiozIHMqKiwgYSBmaWZ0aCBvZiB0aGUgaG91c2UgZGVmYXVsdCxcbiAqIHNvIGEgY29waWVkIDQ1LDAwMCB3b3VsZCB0b2xlcmF0ZSBGSUZURUVOIG1pc3NlZCBiZWF0cyB3aGVyZSBldmVyeSBzaWJsaW5nXG4gKiB0b2xlcmF0ZXMgdGhyZWUuIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgYmVhdCBpdFxuICogaXMgd2F0Y2hpbmcsIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4puUICoqQU5EIFwiV0hBVEVWRVIgVEhFIEJFQVQgQkVDT01FU1wiIElTIFdIWSBUSEUgRU5WIElTIFJFU09MVkVEIEhFUkUgQU5EXG4gKiBOT1dIRVJFIEVMU0UgKEQ3NSkuIFRIRSBQT1JUIFJFLUNSRUFURUQgQVNUUk9MQUJFJ1MgREVGRUNUIElOIFRISVMgRklMRS4qKlxuICogQ2hhcHRlciAyIHNoaXBwZWQgYEhFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gKiDigKYpYCBhdCBgZGFlbW9uLnRzOjExMmAgd2hpbGUgdGhpcyBmaWxlIGtlcHQgYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgXG4gKiBhZ2FpbnN0IHRoZSBMSVRFUkFMIDMsMDAwOiB0aGUgZGFlbW9uJ3MgYmVhdCB3YXMgdHVuYWJsZSBhbmQgdGhlIENMSSdzXG4gKiB3YXRjaGRvZyB3YXMgbm90LCBzbyAqKmFueSB2YWx1ZSBhYm92ZSAzLDAwMCBicm9rZSBldmVyeSB0YWlsLioqIE1FQVNVUkVEIGF0XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0yMDAwMGAgYWdhaW5zdCBhIGhlYWx0aHkgZGFlbW9uLCBiZWZvcmUgdGhlIHJlcGFpcjogYVxuICogcmVhbCBgY2xpLnRzIHRhaWxgIHJlLXN1YnNjcmliZWQgKio0IHRpbWVzIGluIDMwIHMqKiAofjkgcyBhcGFydCwgaXRzIHdhdGNoZG9nXG4gKiBmaXJpbmcgYmVmb3JlIGEgc2luZ2xlIDIwIHMgYmVhdCBjb3VsZCBsYW5kIOKAlCAqKjAga2VlcGFsaXZlcyBhcnJpdmVkKiopLCBhbmRcbiAqIGAvY2hhbm5lbHMvd2Qvc3Vic2NyaWJlcnNgIHJlcG9ydGVkIGBjb3VudDogMiwgY29ubmVjdGlvbnM6IDIsIG5hbWVkOiAyYCBmb3JcbiAqICoqb25lKiogbGl2ZSB0YWlsLCBiZWNhdXNlIHRoZSBhYmFuZG9uZWQgc3RyZWFtcyBhcmUgbm90IHJlYXBlZCB1bnRpbCB0aGVcbiAqIG5vdy0yMCBzIGJlYXQgZmFpbHMgdG8gZW5xdWV1ZS4gVGhhdCBpcyB0aGUgYXN0cm9sYWJlIHNjYXIgdHdvIHBhcmFncmFwaHMgdXAsXG4gKiByZS1jcmVhdGVkIGluc2lkZSB0aGUgZmlsZSB0aGF0IGRvY3VtZW50cyBpdC4gKipPbmUgaGFsZiBvZiB0aGUgcGFpciB0dW5hYmxlXG4gKiBhbmQgdGhlIG90aGVyIGEgY29uc3RhbnQgSVMgdGhlIGRlZmVjdCoqIOKAlCB0aGUgZGVyaXZhdGlvbiBvbmx5IGhvbGRzIGlmIGl0XG4gKiBkZXJpdmVzIGZyb20gdGhlIHZhbHVlIHRoYXQgYWN0dWFsbHkgc2hpcHBlZC5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKiBgcHJvY2Vzcy5lbnZgIGlzIG5vdCBzdWNoIGFuIGltcG9ydDogaXQgaXMgYW1iaWVudCBpbiBib3RoIGhhbHZlcywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgd2h5IHRoaXMgZmlsZSDigJQgYW5kIG5vdCBgZGFlbW9uLnRzYCDigJQgY2FuIGhvbGQgdGhlIHJlc29sdXRpb24uIChUaGlzXG4gKiBpcyBib3VudHkncyBzaGFwZSwgdW5jaGFuZ2VkOiBgc3JjL2JvdW50eS9iYWNrZW5kL2hlYXJ0YmVhdC50c2AgcmVzb2x2ZXNcbiAqIGBCT1VOVFlfSURMRV9USU1FT1VUX1NFQ2AgYW5kIGBCT1VOVFlfSEVBUlRCRUFUX01TYCBpbiB0aGUgc2VhbSBmaWxlIGZvciB0aGVcbiAqIHNhbWUgcmVhc29uLilcbiAqL1xuXG5pbXBvcnQge1xuICBoZWFydGJlYXRNcyxcbiAgaWRsZVRpbWVvdXRTZWMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSwgaW4gc2Vjb25kcy4gR3JhcGV2aW5lJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkXG4gKiBvbmU6IGBkYWVtb24udHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHVuZGVyIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdFxuICogQnVuJ3MgZGVmYXVsdCAxMCBzIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXNcbiAqIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMg4oCUIGFuZCB0aGF0IGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiLCBpdCBpcyB0aGVcbiAqIGRlZmF1bHQuXG4gKlxuICog4pqgIGBHUkFQRVZJTkVfSURMRV9USU1FT1VUX1NFQ2AgaXMgYWNjZXB0ZWQgc28gdGhlIFBBSVIgY2FuIGJlIHR1bmVkIHRvZ2V0aGVyLFxuICogYW5kIHRoZSBjbGFtcCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLiAoVGhpcyBmaWxlIHVzZWQgdG8gc2F5XG4gKiBncmFwZXZpbmUgXCJkb2VzIG5vdCBlbnYtdHVuZSBpdFwiIHdoaWxlIGBkYWVtb24udHNgIGVudi10dW5lZCBpdCB0ZW4gbGluZXMgZnJvbVxuICogd2hlcmUgaXQgaW1wb3J0ZWQgdGhpcyBjb25zdGFudCDigJQgdGhlIHNhbWUgb25lLWhhbGYtdHVuYWJsZSBzcGxpdCBhcyB0aGUgYmVhdCxcbiAqIGFuZCBjb3JyZWN0ZWQgaW4gdGhlIHNhbWUgY2hhcHRlci4pXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKlxuICogVGhlIFNTRSBrZWVwYWxpdmUsIGluIG1zIOKAlCB0aGUgREVGQVVMVCwgYmVmb3JlIHRoZSBlbnYgaXMgY29uc3VsdGVkLlxuICog4pqgICoqMyBzLCBhbmQgaXQgaXMgTk9UIHRoZSBob3VzZSBkZWZhdWx0IG9mIDE1IHMqKiDigJQgZ3JhcGV2aW5lIGlzIHRoZSBvbmx5XG4gKiBzcGVsbCBpbiB0aGUgcm9zdGVyIHRoYXQgYmVhdHMgdGhpcyBmYXN0LCBhbmQgdGhlIG51bWJlciBpcyBsb2FkLWJlYXJpbmdcbiAqIHJhdGhlciB0aGFuIGluY2lkZW50YWw6IHRoZSBiZWF0IGlzIGFsc28gZ3JhcGV2aW5lJ3MgZGVhZC1zdWJzY3JpYmVyIHByb2JlLiBBXG4gKiB0YWlsIHdob3NlIHNvY2tldCBoYXMgZ29uZSBhd2F5IGlzIGRpc2NvdmVyZWQgd2hlbiB0aGUgZW5xdWV1ZSBmYWlscywgYW5kXG4gKiB1bnRpbCBpdCBpcyBkaXNjb3ZlcmVkIGB3aG9gLCBgL3ByZXNlbmNlYCBhbmQgZXZlcnkgc2VuZCdzIHJlY2lwaWVudCBjb3VudFxuICogcmVwb3J0IGEgZ2hvc3QuIEV2ZXJ5IG90aGVyIHNwZWxsJ3MgaGVhcnRiZWF0IG9ubHkgaGFzIHRvIGtlZXAgYSBjb25uZWN0aW9uXG4gKiBvcGVuOyB0aGlzIG9uZSBhbHNvIGhhcyB0byBrZWVwIGEgUk9TVEVSIGhvbmVzdCwgd2hpY2ggaXMgYSBodW1hbi12aXNpYmxlXG4gKiBudW1iZXIgaW4gdGhlIHdhdGNoIHN1cmZhY2UuIOKblCAqKlNvIHJhaXNpbmcgdGhpcyBrbm9iIG1ha2VzIHByZXNlbmNlXG4gKiBzdGFsZXIsIG5vdCBqdXN0IHF1aWV0ZXIqKiDigJQgaXQgaXMgdGhlIG9uZSB0aGluZyBhbiBvcGVyYXRvciB0dW5pbmcgaXQgc2hvdWxkXG4gKiBrbm93LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TID0gM18wMDA7XG5cbi8qKlxuICogVGhlIGJlYXQgYXMgaXQgd2lsbCBhY3R1YWxseSBiZSB1c2VkLCBlbnYtcmVzb2x2ZWQgYW5kIGNsYW1wZWQgYXQgYm90aCBlbmRzIGJ5XG4gKiB0aGUga2l0OiBuZXZlciBhYm92ZSBgSURMRV9USU1FT1VUX1NFQyAvIDJgIChvciBCdW4gY2xvc2VzIHRoZSBjb25uZWN0aW9uIHRoZVxuICoga2VlcGFsaXZlIHdhcyBwcmVzZXJ2aW5nKSwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIOKblCBUSEUgRkxPT1IgSVMgTk9UIERFQ09SQVRJT04gKEQ3NikuIGBpbnRPcmAgcGFyc2VzIHdpdGggYHBhcnNlSW50YCwgd2hpY2hcbiAqIHJlYWRzIGBcIjFlOVwiYCDigJQgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdCBodWdlXCIg4oCUIGFzICoqMSoqLlxuICogRHJpdmVuIGJlZm9yZSB0aGUgZmxvb3IgZXhpc3RlZDogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOFxuICoga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0UgY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIOKGkiAzIG1zIGFuZFxuICogYFwiNWFiY1wiYCDihpIgNSBtcyBhcnJpdmUgdGhlIHNhbWUgd2F5LiBUaGUgZmxvb3IgbGl2ZXMgaW4gdGhlIGtpdCdzXG4gKiBgaGVhcnRiZWF0TXNgIGJlc2lkZSB0aGUgY2VpbGluZyBpdCBjYW5ub3QgY3Jvc3MsIE5PVCBpbiBgaW50T3JgLCB3aGljaCBldmVyeVxuICogb3RoZXIga25vYiBpbiB0aGUgaG91c2Ugc2hhcmVzLlxuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSEVBUlRCRUFUX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuIDksMDAwIG1zIGF0IHRoZSBkZWZhdWx0LlxuICpcbiAqIOKblCAqKlRIRSBUQUlMIEhBRCBOTyBXQVRDSERPRyBBVCBBTEwgQkVGT1JFIFRISVMuKiogYGNtZFRhaWxgJ3MgaW5uZXIgbG9vcFxuICogYXdhaXRlZCBgcmVhZGVyLnJlYWQoKWAgd2l0aCBub3RoaW5nIGJvdW5kaW5nIGl0LCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXJcbiAqIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kIG9yIGEgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgRk9SRVZFUiDigJQgYW5kXG4gKiBhIHBhcmtlZCB0YWlsIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLCB3aGljaCBpcyB0aGUgc3RhdGVcbiAqIGdyYXBldmluZSdzIGNhbGxlcnMgc3BlbmQgbW9zdCBvZiB0aGVpciB0aW1lIGluLlxuICpcbiAqIOKaoCA5IHMgaXMgYWdncmVzc2l2ZSBieSBob3VzZSBzdGFuZGFyZHMgKDQ1IHMgZXZlcnl3aGVyZSBlbHNlKSBhbmQgdGhhdCBpcyB0aGVcbiAqIGRlcml2YXRpb24gd29ya2luZywgbm90IGEgbWlzdGFrZTogaXQgaXMgdGhyZWUgb2YgVEhJUyBzcGVsbCdzIGJlYXRzLiBIb2xkaW5nXG4gKiB0aGUgY29ubmVjdGlvbiBvcGVuIElTIGEgdGFpbCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwc1xuICogYSBuYW1lIGluIGEgaHVtYW4ncyByb3N0ZXIg4oCUIHdoaWNoIGlzIHdoeSBpdCBpcyB0aHJlZSBiZWF0cyBhbmQgbm90IHR3by5cbiAqXG4gKiDim5QgREVSSVZFRCBGUk9NIFRIRSBSRVNPTFZFRCBCRUFULCBORVZFUiBGUk9NIFRIRSBERUZBVUxULiBJdCBpc1xuICogYFNTRV9IRUFSVEJFQVRfTVNgIGFib3ZlIGFuZCBub3QgYERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NU2Agb24gcHVycG9zZTsgdGhlXG4gKiByZXBhaXIgY2hhcHRlciBpcyB3aGF0IHRoZSBkaWZmZXJlbmNlIGNvc3QuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQWlCQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFRQTtBQUNBO0FBQ0E7QUFDQSxzQkFBUzs7O0FDd0JGLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBYVosU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8sVUFBVSxFQUFFLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQztBQUFBLFNBRS9DLE9BQU8sV0FBVyxZQUFZLEVBQUUsUUFBUSxNQUFNLE9BQU8sSUFBSSxDQUFDO0FBQUEsSUFDaEU7QUFBQSxJ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TSxXQUFXLE1BQU0sSUFBSTtBQUFBO0FBR3BDLGVBQWUsVUFBVSxDQUFDLE1BQW1CLE1BQWlDO0FBQUEsRUFDNUUsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLEtBQ0QsRUFBRSxZQUFZLE1BQU0sSUFBSSxXQUFXLE1BQU0sSUFBSTtBQUFBLElBQzlDLE9BQU8sR0FBRztBQUFBLElBQ1YsSUFBSSxFQUFFLGFBQWE7QUFBQSxNQUFhLE1BQU07QUFBQSxJQUN0QyxLQUFJLEVBQUUsU0FBUyxTQUFTLEVBQUUsS0FBSztBQUFBO0FBQUEsRUFPakMsTUFBTSxXQUFXLEtBQUssWUFBWSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLEVBQzVELE1BQU0sV0FBVyxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsRUFDeEQsSUFBSSxXQUFXLFNBQVMsVUFBVTtBQUFBLElBQ2hDLE1BQU0sVUFBVSxLQUFLLFlBQVksV0FBVztBQUFBLElBQzVDLEtBQUksR0FBRyxLQUFLLDJCQUEyQixTQUFTLFFBQVEsZUFBZSxTQUFTO0FBQUEsTUFDOUUsTUFBTSxZQUFZLEtBQUssUUFBUSxLQUFLLFlBQ2pDLElBQUksQ0FBQyxNQUFPLEVBQUUsV0FBVyxJQUFJLEVBQUUsVUFBVSxJQUFJLEVBQUUsT0FBUSxFQUN2RCxLQUFLLEdBQUc7QUFBQSxJQUNiLENBQUM7QUFBQSxFQUNIO0FBQUEsRUFDQSxJQUFJLENBQUMsWUFBWSxXQUFXLFNBQVMsS0FBSyxZQUFZLFFBQVE7QUFBQSxJQUM1RCxLQUNFLEdBQUcsS0FBSyw2QkFBNkIsS0FBSyxVQUFVLFdBQVcsS0FBSyxZQUFZLE9BQU8sS0FDdkYsU0FDQTtBQUFBLE1BQ0UsTUFBTSxZQUFZLEtBQUssUUFDckIsS0FBSyxZQUFZLElBQUksQ0FBQyxNQUFPLEVBQUUsV0FBVyxJQUFJLEVBQUUsVUFBVSxJQUFJLEVBQUUsT0FBUSxFQUFFLEtBQUssR0FBRyxLQUNsRjtBQUFBLElBRUosQ0FDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE1BQU0sVUFBVSxNQUFNLEtBQUssSUFBSSxZQUFZLEtBQUs7QUFBQSxFQUNoRCxPQUFPLE9BQU8sWUFBWSxXQUFXLFVBQVU7QUFBQTtBQWtCakQsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxrQkFBa0IsS0FBSyxNQUFNLElBQUk7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sU0FBUyxJQUFJO0FBQUEsSUFDMUIsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQU8sZUFBZSxDQUFDO0FBQUEsSUFDN0IsSUFBSSxTQUFTO0FBQUEsTUFBTSxPQUFPO0FBQUEsSUFDMUIsTUFBTTtBQUFBO0FBQUE7QUFlVixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI1RjQzQzM3NURGOEU4QTJFNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
