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
    hint: "three unrelated causes report this one sentence: the daemon's launcher shape, " + "a wrong spawn path, and a dev-mode daemon dying at its surface import. " + "Run the daemon launcher alone to tell them apart."
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
var identityRequired = (verb) => die2(`${verb}: identity required \u2014 pass --as/--from <alias> or set GRAPEVINE_FROM env var`);
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

//# debugId=1BE49727B118024E64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9oZWFydGJlYXQudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2hlYXJ0YmVhdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gZ3JhcGV2aW5lIENMSSDigJQgdGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgZGFlbW9uJ3MgSFRUUCBzdXJmYWNlLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBidW4gY2xpLnRzIG9wZW4gPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgbGlzdFxuLy8gICBidW4gY2xpLnRzIHNlbmQgPG5hbWU+IC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIHRhaWwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XVxuLy8gICBidW4gY2xpLnRzIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF1cbi8vICAgYnVuIGNsaS50cyBjbG9zZSA8bmFtZT5cbi8vICAgYnVuIGNsaS50cyBzdG9wXG4vLyAgIGJ1biBjbGkudHMgaW5mb1xuLy9cbi8vIGB0YWlsYCB3cml0ZXMgZWFjaCBpbmNvbWluZyBtZXNzYWdlIGFzIG9uZSBKU09OTCBsaW5lIG9uIHN0ZG91dC4gUGlwZVxuLy8gb3Igd3JhcCB3aXRoIE1vbml0b3IuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICB1bmxpbmtTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQge1xuICB0eXBlIEVyckV4dHJhLFxuICB0eXBlIEVycktpbmQsXG4gIGRpZSBhcyByYWlzZSxcbiAgcmVwb3J0Q2xpRXJyb3IsXG4gIHNldEN1cnJlbnRDb21tYW5kLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzLnRzXCI7XG5pbXBvcnQgeyB0YWlsRXZlbnRzIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxFdmVudHMudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG5jb25zdCBEQVRBX0RJUiA9IHByb2Nlc3MuZW52LkdSQVBFVklORV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5ncmFwZXZpbmVcIik7XG5jb25zdCBQT1JUX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5waWRcIik7XG5jb25zdCBIT0xEX0ZJTEUgPSBqb2luKERBVEFfRElSLCBcImRhZW1vbi5ob2xkXCIpO1xuLy8gUGVyc2lzdGVkIGlkZW50aXR5IGNvbmZpZyAoVjEuNykg4oCUIGBncmFwZXZpbmUgYWxpYXMgPG5hbWU+YCB3cml0ZXMgaXQ7IHRoZVxuLy8gZGFlbW9uIHNlcnZlcyBpdCB0byB0aGUgd2F0Y2ggdmlhIEdFVCAvaWRlbnRpdHkuXG5jb25zdCBDT05GSUdfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiY29uZmlnLmpzb25cIik7XG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIE5FVkVSIEEgRkxBVCBTSUJMSU5HIChwbGF5Ym9vayBCNCkuIFRoaXMgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJkYWVtb24udHNcIilgIOKAlCBnbGFtb3VyJ3MgZXhhY3Qgc2hpcHBlZCBkZWZlY3Qg4oCUIHdoaWNoIHdhc1xuLy8gdHJ1ZSBmb3IgZXhhY3RseSBhcyBsb25nIGFzIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tXG4vLyBgZGlzdC9gIHRoYXQgcmVzb2x2ZXMgdG8gYGRpc3QvZGFlbW9uLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgYW5kIG11c3Qgbm90XG4vLyBleGlzdC4gVGhlIHN5bXB0b20gaXMgbm90IGEgY3Jhc2g6IHRoZSBzcGF3biBmYWlscyBzaWxlbnRseSAodGhlIGRhZW1vbidzXG4vLyBzdGRpbyBpcyBpZ25vcmVkKSwgbm8gcG9ydCBmaWxlIGV2ZXIgYXBwZWFycywgYW5kIHRoZSAzIHMgcG9sbCBsb29wIGJlbG93XG4vLyByZXBvcnRzIGBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc2Ag4oCUIHdoaWNoIGlzIEFMU08gd2hhdCBhIGxhdW5jaGVyXG4vLyB0aGF0IGV4aXRzIGEgbGl2ZSBkYWVtb24gcmVwb3J0cyAoRDY5KSBhbmQgQUxTTyB3aGF0IGEgZGV2LW1vZGUgZGFlbW9uIGR5aW5nXG4vLyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQgcmVwb3J0cyAoc2VlIGBlbnN1cmVEYWVtb25gKS4gVGhyZWUgZGVmZWN0IGNsYXNzZXMsIG9uZVxuLy8gc2VudGVuY2U7IHRoaXMgaXMgdGhlIGZpcnN0IG9mIHRoZSB0aHJlZS5cbi8vIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgcmVzb2x2ZXMgdGhpcyBhcml0aG1ldGljIHRoZSB3YXkgdGhlXG4vLyBydW50aW1lIHdpbGwsIGZyb20gdGhlIEVNSVRURUQgZmlsZSdzIG93biBkaXJlY3RvcnksIGFuZCBhc3NlcnRzIHRoZSBmaWxlIGlzXG4vLyB0aGVyZS5cbmNvbnN0IERBRU1PTl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwiZGFlbW9uLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBUaGUgd2F0Y2ggc3VyZmFjZSBpcyBidWlsdCAoc3JjL2dyYXBldmluZS9zdXJmYWNlIOKGkiBkaXN0LykuIEJ1biByZWFkc1xuLy8gYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIGluIERFViBtb2RlIHRoZSBkYWVtb24nc1xuLy8gY3dkIE1VU1QgYmUgc3JjL2dyYXBldmluZS8gKHNlYW1zIENvbnRyYWN0IDUpIOKAlCBsYXVuY2hlZCBlbHNld2hlcmUgdGhlIGRldlxuLy8gYnVuZGxlciBjYW5ub3QgY29tcGlsZSB0aGUgc3R5bGVzaGVldCBhbmQgdGhlIHBhZ2UgZmFpbHMgKG1lYXN1cmVkIG9uXG4vLyBnbGFtb3VyOiBIVFRQIDUwMCwgbm8gc3R5bGVzaGVldCBsaW5rKS4gSW4gUkVMRUFTRSBtb2RlIGRpc3QvIGlzIHN0YXRpYyBhbmRcbi8vIHByZS1idWlsdCwgbm8gYnVuZmlnIGlzIHJlYWQsIGFuZCBzcmMvZ3JhcGV2aW5lLyBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLykg4oCUIHNvIHRoZSBjd2Qgc3RheXMgYXRcbi8vIHRoZSBza2lsbCByb290LiBTYW1lIHNoYXBlIGFzIGdsYW1vdXIncyBkYWVtb25Dd2QoKS4gRXhwb3J0ZWQgZm9yIHRlc3RzLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcImdyYXBldmluZVwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vLyDilIDilIAgRGFlbW9uIEhUVFAgcHJvdG9jb2wg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBSZXNwb25zZSBzaGFwZXMgdGhlIGRhZW1vbiBlbWl0cy4gQW55IGVuZHBvaW50IGNhbiBhbHNvIHJldHVybiBhbiBlcnJvclxuLy8gYm9keSB3aXRoIGEgNHh4LzV4eCBzdGF0dXMsIHNvIGVhY2ggY2FycmllcyBhbiBvcHRpb25hbCBgZXJyb3JgLlxuXG50eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBudW1iZXI7XG4gIGNoYW5uZWw6IHN0cmluZztcbiAgZnJvbTogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIGtpbmQ6IFwibWVzc2FnZVwiIHwgXCJ0b3BpY1wiIHwgXCJhbm5vdW5jZW1lbnRcIiB8IFwic3RhdHVzXCI7XG4gIGluX3JlcGx5X3RvPzogbnVtYmVyO1xuICB0YXJnZXQ/OiBudW1iZXI7XG4gIGRpc3Bvc2l0aW9uPzogc3RyaW5nO1xuICAvLyBDaGFubmVsLWxldmVsIGxpZmVjeWNsZSBmYWN0IChhcmNoaXZlIC8gdW5hcmNoaXZlKS4gQSBraW5kOlwic3RhdHVzXCIgZnJhbWVcbiAgLy8gY2FycnlpbmcgYGV2ZW50YCBhbmQgbm8gYGRpc3Bvc2l0aW9uYCDigJQgc2VlIGlzRGlzcG9zaXRpb25GcmFtZS5cbiAgZXZlbnQ/OiBcImFyY2hpdmVkXCIgfCBcInVuYXJjaGl2ZWRcIjtcbn07XG5cbi8vIEdFVCAvIOKAlCBkYWVtb24gbGl2ZW5lc3MvaW5mby5cbnR5cGUgUm9vdEluZm8gPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgcGlkPzogbnVtYmVyO1xuICBzdGFydGVkX2F0PzogbnVtYmVyO1xuICBjaGFubmVscz86IG51bWJlcjtcbiAgZGF0YV9kaXI/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyDigJQgbWVzc2FnZSByZWNlaXB0IHdpdGggZGVsaXZlcnkgYWNjb3VudGluZy5cbnR5cGUgU2VuZFJlY2VpcHQgPSBNZXNzYWdlICYge1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgcmVjaXBpZW50cz86IG51bWJlcjtcbiAgc3Vic2NyaWJlcl9hbGlhc2VzPzogc3RyaW5nW107XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvYW5ub3VuY2Ug4oCUIGNyb3NzLWNoYW5uZWwgYnJvYWRjYXN0IHJlY2VpcHQuXG50eXBlIEFubm91bmNlUmVjZWlwdCA9IHtcbiAgb2s6IGJvb2xlYW47XG4gIGNoYW5uZWxzOiB7IG5hbWU6IHN0cmluZzsgcmVjaXBpZW50czogbnVtYmVyIH1bXTtcbiAgc2tpcHBlZDogeyBuYW1lOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH1bXTtcbiAgdG90YWxfcmVjaXBpZW50czogbnVtYmVyO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIEdFVCAvY2hhbm5lbHMg4oCUIGNoYW5uZWwgZGlyZWN0b3J5IGxpc3RpbmcuXG50eXBlIENoYW5uZWxTdW1tYXJ5ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gIC8vIG51bGwgPSB0aGUgZGFlbW9uIGNvdWxkIG5vdCBlc3RhYmxpc2ggYSBjb3VudCAodW5yZWFkYWJsZSBmaWxlKSwgTkVWRVIgMC5cbiAgLy8gMCBtZWFucyBcInRoaXMgY2hhbm5lbCBpcyBnZW51aW5lbHkgZW1wdHlcIiBhbmQgbm90aGluZyBlbHNlIOKAlCBiNS5cbiAgbWVzc2FnZV9jb3VudDogbnVtYmVyIHwgbnVsbDtcbiAgbGFzdF9hY3Rpdml0eTogbnVtYmVyO1xuICBsb2FkZWQ6IGJvb2xlYW47XG59O1xudHlwZSBDaGFubmVsc1Jlc3BvbnNlID0geyBjaGFubmVscz86IENoYW5uZWxTdW1tYXJ5W107IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEFueSBlbmRwb2ludCBtYXkgcmVwbHkgd2l0aCBqdXN0IGFuIGVycm9yL29rIGVudmVsb3BlLlxudHlwZSBTdGF0dXNSZXNwb25zZSA9IHsgb2s/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9tZXNzYWdlcyBhbmQgP3NpbmNlPSByYW5nZXMuXG50eXBlIE1lc3NhZ2VzUmVzcG9uc2UgPSB7IG1lc3NhZ2VzPzogTWVzc2FnZVtdOyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi93YWl0IOKAlCBsb25nLXBvbGwgYmF0Y2guXG50eXBlIFdhaXRSZXNwb25zZSA9IHtcbiAgbWVzc2FnZXM/OiBNZXNzYWdlW107XG4gIGN1cnNvcj86IG51bWJlcjtcbiAgdGltZWRfb3V0PzogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIC8vIEEgcmVmdXNhbCBuYW1lcyB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoNDA0IG9uIGEgbWlzc2luZyBjaGFubmVsKS5cbiAgaGludD86IHN0cmluZztcbn07XG5cbi8vIFBPU1QgL2NoYW5uZWxzIOKAlCBvcGVuL2Vuc3VyZSBhIGNoYW5uZWwuXG50eXBlIE9wZW5SZXNwb25zZSA9IHtcbiAgbmFtZT86IHN0cmluZztcbiAgY3JlYXRlZF9hdD86IG51bWJlcjtcbiAgbWVzc2FnZV9jb3VudD86IG51bWJlcjtcbiAgc3Vic2NyaWJlcnM/OiBudW1iZXI7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgdW5hcmNoaXZlZD86IGJvb2xlYW47XG4gIGNsZWFyZWQ/OiBib29sZWFuO1xuICBzbmFwc2hvdD86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vdG9waWMgYW5kIFBVVCAvY2hhbm5lbHMvPG5hbWU+L3RvcGljLlxudHlwZSBUb3BpY1Jlc3BvbnNlID0ge1xuICBvaz86IGJvb2xlYW47XG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbiAgaWQ/OiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscy88bmFtZT4vc3Vic2NyaWJlcnMg4oCUIHNpbmdsZS1jaGFubmVsIHJvc3Rlci5cbnR5cGUgU3Vic2NyaWJlcnNSZXNwb25zZSA9IHtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgc3Vic2NyaWJlcnM/OiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvdW50PzogbnVtYmVyO1xuICBjb25uZWN0aW9ucz86IG51bWJlcjtcbiAgbmFtZWQ/OiBudW1iZXI7XG4gIGFub255bW91cz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbi8vIFBlci1jaGFubmVsIHByZXNlbmNlIGVudHJ5IGZyb20gR0VUIC9wcmVzZW5jZS5cbnR5cGUgUHJlc2VuY2VDaGFubmVsID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN1YnNjcmliZXJzOiBzdHJpbmdbXTtcbiAgaHVtYW5zPzogc3RyaW5nW107XG4gIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gIG5hbWVkOiBudW1iZXI7XG4gIGFub255bW91czogbnVtYmVyO1xufTtcbnR5cGUgUHJlc2VuY2VSZXNwb25zZSA9IHsgY2hhbm5lbHM/OiBQcmVzZW5jZUNoYW5uZWxbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gU1NFIGZyYW1lcyBwdXNoZWQgb24gR0VUIC9jaGFubmVscy88bmFtZT4vdGFpbC4gVHdvIGZyYW1lIGtpbmRzIGFycml2ZSBvblxuLy8gdGhlIHNhbWUgYGRhdGE6YCBsaW5lIOKAlCBhIGBzdWJzY3JpYmVkYCBldmVudCBhbmQgcGVyLW1lc3NhZ2UgZnJhbWVzIOKAlCBzbyB0aGVcbi8vIGRlY29kZWQgcGF5bG9hZCBpcyBhIHVuaW9uLiBBbGwgZmllbGRzIG9wdGlvbmFsIGJlY2F1c2UgdGhlIGZyYW1lIGlzXG4vLyB1bnRydXN0ZWQgd2lyZSBkYXRhIG5hcnJvd2VkIGF0IHRoZSB1c2Ugc2l0ZS5cbnR5cGUgVGFpbFBheWxvYWQgPSB7XG4gIC8vIHN1YnNjcmliZWQtZXZlbnQgZmllbGRzXG4gIHNpbmNlPzogbnVtYmVyO1xuICBhcz86IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdF9pZD86IG51bWJlcjtcbiAgLy8gVHJ1ZSB3aGVuIFRISVMgc3Vic2NyaWJlIGNyZWF0ZWQgdGhlIGNoYW5uZWwg4oCUIHRoZSBzaWduYWwgdGhhdCBzZXBhcmF0ZXNcbiAgLy8gXCJxdWlldCBjaGFubmVsXCIgZnJvbSBcInlvdSB0YWlsZWQgYSBuYW1lIHRoYXQgZGlkIG5vdCBleGlzdFwiLlxuICBjcmVhdGVkPzogYm9vbGVhbjtcbiAgLy8gVHJ1ZSB3aGVuIHRoZSBjaGFubmVsIGlzIGFscmVhZHkgYXJjaGl2ZWQgKHJlYWQtb25seSkgYXQgc3Vic2NyaWJlIHRpbWUg4oCUXG4gIC8vIHRoZSBzaWduYWwgZm9yIGEgTEFURSBqb2luZXIsIHdobyB3b3VsZCBvdGhlcndpc2UgbGVhcm4gaXQgZnJvbSBhIHJlamVjdGVkXG4gIC8vIHNlbmQuIFRoZSBsaWZlY3ljbGUgZnJhbWUgb25seSByZWFjaGVzIGFuIGFnZW50IHRoYXQgd2FzIGNvbm5lY3RlZCBhdCB0aGVcbiAgLy8gbW9tZW50LCBvciB0aGF0IHB1bGxzIGhpc3RvcnkuXG4gIGFyY2hpdmVkPzogYm9vbGVhbjtcbiAgLy8gbWVzc2FnZSBmaWVsZHNcbiAgaWQ/OiBudW1iZXI7XG4gIGZyb20/OiBzdHJpbmc7XG4gIHRleHQ/OiBzdHJpbmc7XG4gIHRzPzogbnVtYmVyO1xuICBraW5kPzogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgLy8gc2hhcmVkXG4gIGNoYW5uZWw/OiBzdHJpbmc7XG4gIHRvcGljPzogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIE91ciBwbHVnaW4gdmVyc2lvbiAoZnJvbSBwbHVnaW4uanNvbikuIFVzZWQgdG8gZGV0ZWN0IGNhY2hlLXBpbm5pbmdcbi8vIG1pc21hdGNoZXMgd2hlbiB3ZSB0YWxrIHRvIGEgZGFlbW9uIHNwYXduZWQgZnJvbSBhIGRpZmZlcmVudCBjYWNoZWRcbi8vIHBhdGguIEJlc3QtZWZmb3J0OyBudWxsIGlmIHJlYWQgZmFpbHMuXG5mdW5jdGlvbiByZWFkUGx1Z2luVmVyc2lvbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbHVnaW5Kc29uUGF0aCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwbHVnaW5Kc29uUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpLnZlcnNpb24gPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmNvbnN0IFBMVUdJTl9WRVJTSU9OID0gcmVhZFBsdWdpblZlcnNpb24oKTtcblxuLy8gT25lLXNob3QgdmVyc2lvbi1taXNtYXRjaCBjaGVjay4gVGhlIGRhZW1vbiBtYXkgYmUgZnJvbSBhIGRpZmZlcmVudFxuLy8gY2FjaGVkIHBsdWdpbiBwYXRoIHRoYW4gdGhpcyBDTEkgKGV4aXN0aW5nIHRhaWwgcHJvY2Vzc2VzJyBhdXRvLXJlY29ubmVjdFxuLy8gY2FuIHJhY2UgYSBgc3RvcGAgYW5kIHJlc3Bhd24gdGhlIG9sZCBkYWVtb24pLiBXYXJuIG9uY2UgcGVyIGludm9jYXRpb25cbi8vIHNvIHRoZSB1c2VyIGhhcyBhIHNpZ25hbCBpbnN0ZWFkIG9mIHNpbGVudGx5IGRlZ3JhZGVkIGJlaGF2aW9yLlxubGV0IF92ZXJzaW9uQ2hlY2tEb25lID0gZmFsc2U7XG5hc3luYyBmdW5jdGlvbiBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0OiBudW1iZXIpIHtcbiAgaWYgKF92ZXJzaW9uQ2hlY2tEb25lKSByZXR1cm47XG4gIF92ZXJzaW9uQ2hlY2tEb25lID0gdHJ1ZTtcbiAgaWYgKCFQTFVHSU5fVkVSU0lPTikgcmV0dXJuOyAvLyBjYW4ndCBjb21wYXJlIGlmIHdlIGRvbid0IGtub3cgb3VyIG93biB2ZXJzaW9uXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwKSxcbiAgICB9KTtcbiAgICBpZiAoIXJlcy5vaykgcmV0dXJuO1xuICAgIGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gICAgY29uc3QgZGFlbW9uVmVyc2lvbiA9IGRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAoZGFlbW9uVmVyc2lvbiA9PT0gbnVsbCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIGlzIG9sZGVyIHRoYW4gdGhpcyBDTEkgKG5vIHZlcnNpb24gcmVwb3J0ZWQpLiBgICtcbiAgICAgICAgICBgQ0xJIGlzIHYke1BMVUdJTl9WRVJTSU9OfS4gU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gYCArXG4gICAgICAgICAgYFJlc3RhcnQgdGhlIGRhZW1vbiAoZHJvcCB0YWlscywgdGhlbiBcXGBzdG9wXFxgLCB0aGVuIGFueSB2ZXJiKSB0byB1cGdyYWRlLlxcbmAsXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZGFlbW9uVmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT04pIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBncmFwZXZpbmU6IGRhZW1vbiB2ZXJzaW9uICh2JHtkYWVtb25WZXJzaW9ufSkgZGlmZmVycyBmcm9tIENMSSB2ZXJzaW9uICh2JHtQTFVHSU5fVkVSU0lPTn0pLiBgICtcbiAgICAgICAgICBgU29tZSBmZWF0dXJlcyBtYXkgc2lsZW50bHkgZGVncmFkZS4gUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduLlxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxufVxuLy8gR1JBUEVWSU5FX0ZST00gc2V0cyB0aGUgZGVmYXVsdCAtLWZyb20gLyAtLWFzIGFsaWFzIHNvIGFnZW50cyBkb24ndCBoYXZlXG4vLyB0byByZXBlYXQgdGhlaXIgaWRlbnRpdHkgb24gZXZlcnkgdmVyYi4gUGVyLXZlcmIgZmxhZ3Mgc3RpbGwgb3ZlcnJpZGUuXG5jb25zdCBERUZBVUxUX0FMSUFTID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0ZST00gPz8gdW5kZWZpbmVkO1xuXG4vLyBJZGVudGl0eSBmbGFncyBhcmUgaW50ZXJjaGFuZ2VhYmxlIGFjcm9zcyB2ZXJicy4gYHNlbmRgIGhpc3RvcmljYWxseSB0b29rXG4vLyBgLS1mcm9tYCB3aGlsZSBgdGFpbGAvYHdhaXRgIHRvb2sgYC0tYXNgIOKAlCBzYW1lIGNvbmNlcHQgKHdobyBhbSBJKSwgYW5kIHRoZVxuLy8gYXN5bW1ldHJ5IHRyaXBzIHlvdSBtaWQtZmxvdy4gQWNjZXB0IGVpdGhlciBldmVyeXdoZXJlIGlkZW50aXR5IGlzIG1lYW50LFxuLy8gZmFsbGluZyBiYWNrIHRvIEdSQVBFVklORV9GUk9NLiAoZ3JlcCdzIGAtLWZyb21gIGlzIGEgZGlmZmVyZW50IHRoaW5nIOKAlCBhblxuLy8gYXV0aG9yICpmaWx0ZXIqLCBub3QgaWRlbnRpdHkg4oCUIHNvIGl0IGRvZXNuJ3QgdXNlIHRoaXMuKVxuZnVuY3Rpb24gcmVzb2x2ZUFsaWFzKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiAoZmxhZ3MuZnJvbSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IChmbGFncy5hcyBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/IERFRkFVTFRfQUxJQVM7XG59XG4vLyBUcnVuY2F0aW9uLWhpbnQgdGhyZXNob2xkLiBNZXNzYWdlcyBsb25nZXIgdGhhbiB0aGlzIGdldCBhIGB0cnVuY2F0aW9uX2hpbnRgXG4vLyBmaWVsZCBvbiB0aGUgdGFpbCBKU09OIHNvIGNvbnN1bWVycyAoZS5nLiBNb25pdG9yKSBrbm93IHRoZSBub3RpZmljYXRpb25cbi8vIHByZXZpZXcgaXMgaW5jb21wbGV0ZSBhbmQgc2hvdWxkIGByZWFkYCB0aGUgZnVsbCBib2R5LiBJbiBhZ2VudC10by1hZ2VudFxuLy8gdHJhZmZpYywgbG9uZyBtZXNzYWdlcyBhcmUgdGhlIE5PUk0gKHRoZSBWMS42IHJvdW5kdGFibGUgc2F3IG1vc3Qgc3Vic3RhbnRpdmVcbi8vIG1lc3NhZ2VzIGV4Y2VlZCA4MDApLCBzbyBhbiA4MDAgZGVmYXVsdCBmaXJlZCBvbiBuZWFybHkgZXZlcnl0aGluZyBhbmQgdGhlXG4vLyByZWNvdmVyeSBwYXRoIGJlY2FtZSB0aGUgbWFpbiBwYXRoLiBEZWZhdWx0IHJhaXNlZCB0byAyMDAwIHNvIHRoZSBoaW50IG1hcmtzXG4vLyB0aGUgZ2VudWluZWx5LWxvbmcgb3V0bGllcnMuIE92ZXJyaWRhYmxlIHZpYSBlbnYgdmFyIGZvciB0dW5pbmcuXG5jb25zdCBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID0gcGFyc2VJbnQoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9UUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEID8/IFwiMjAwMFwiLFxuICAxMCxcbik7XG5cbi8vIE9wdGlvbmFsIGlubGluZS1ib2R5IGNhcCBmb3IgYHRhaWxgIChvcHQtaW4gdmlhIC0tbWF4IDxuPiBvciBHUkFQRVZJTkVfVEFJTF9NQVgpLlxuLy8gV2hlbiBzZXQsIGEgYm9keSBsb25nZXIgdGhhbiB0aGUgY2FwIGlzIHRydW5jYXRlZCB0byBgbmAgY2hhcnMgaW4gdGhlIHRhaWxcbi8vIGZyYW1lIChwbHVzIHRoZSByZWFkLXBvaW50ZXIgaGludCksIHNvIGEgcHVzaCBjb25zdW1lciBjYW4gaGFuZCBpdHNcbi8vIG5vdGlmaWNhdGlvbiBzdXJmYWNlIGEgZGVsaWJlcmF0ZWx5LXNpemVkIGxpbmUuIFRoZSBGVUxMIG1lc3NhZ2UgaXMgYWx3YXlzXG4vLyByZXRyaWV2YWJsZSB2aWEgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLiBVbmRlZmluZWQgPSBubyBjYXAgKGZ1bGwgdGV4dCBpbmxpbmUg4oCUXG4vLyB0b2RheSdzIGRlZmF1bHQpLiBOb3RlOiB0aGUgaGFyZCBjbGlwIGEgY29uc3VtZXIgdWx0aW1hdGVseSBzZWVzIGlzIHN0aWxsIHRoZVxuLy8gTW9uaXRvci9ub3RpZmljYXRpb24gbGF5ZXInczsgLS1tYXggb25seSBib3VuZHMgdGhlIGxpbmUgZ3JhcGV2aW5lIGVtaXRzLlxuLy8gUmVqZWN0cyBuZWdhdGl2ZSAvIG5vbi1udW1lcmljLlxuZnVuY3Rpb24gcmVzb2x2ZVRhaWxNYXgoZmxhZzogdW5rbm93bik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBmbGFnID09PSBcInN0cmluZ1wiID8gZmxhZyA6IHByb2Nlc3MuZW52LkdSQVBFVklORV9UQUlMX01BWDtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdywgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPj0gMCA/IG4gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlIOKAlCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2AncyBgZGllYCwgdW5kZXIgdGhpc1xuICogc3BlbGwncyBvd24gbmFtZSBzbyA0NiBjYWxsIHNpdGVzIGRpZCBub3QgZWFjaCBoYXZlIHRvIGJlIHJlLXNwZWxsZWQuXG4gKlxuICog4puUICoqSVQgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBBIENBTExFUi1WSVNJQkxFIENIQU5HRSoqXG4gKiAoUGhhc2UgNiBjaGFwdGVyIDI7IHRoZSBkZWx0YSBpcyBkcml2ZW4gYW5kIHJlY29yZGVkIGluIHRoZSBqb3VybmFsKS4gVGhpc1xuICogZnVuY3Rpb24gd2FzIGBwcm9jZXNzLnN0ZGVyci53cml0ZShcXGBncmFwZXZpbmU6ICR7bXNnfVxcblxcYCk7IHByb2Nlc3MuZXhpdChjb2RlKWBcbiAqIOKAlCBQUk9TRSBhdCBleGl0IDIgZm9yIGV2ZXJ5IGZhaWx1cmUgZ3JhcGV2aW5lIGNvdWxkIHByb2R1Y2UsIHdpdGggdHdvIHNpdGVzXG4gKiBwYXNzaW5nIDEuIEFmdGVyIHRoZSBhZG9wdGlvbiBpdCBpcyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIHRoZVxuICogYWNjIHRheG9ub215J3MgY29kZXM6IHVzYWdlIDIsIGludGVybmFsIDEsIG5vdF9mb3VuZCA1LCBjb25mbGljdCA2LiBBbiBhZ2VudFxuICogcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZTsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbiBhbmQgcmV3b3JkaW5nXG4gKiBpdCBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkaWQgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlZCBwcm9zZS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIEVOVU1FUkFUSU9OUyBNT1ZFRCBGUk9NIFBST1NFIElOVE8gYGNob2ljZXNgLioqIGdyYXBldmluZSdzXG4gKiByZWplY3Rpb25zIHdlcmUgc2hhcGVkIGZvciBhY2MncyBmbGFnLXNldCBleHRyYWN0b3JzIOKAlCBgcmVjb2duaXplZCBmbGFnczogLS1hXG4gKiAtLWJgLCB3aXRoIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdCBhIHF1YWxpZmllciBiZXR3ZWVuIHRoZSBub3VuIGFuZCB0aGUgY29sb25cbiAqIFwicmVhZHMgYXMgcHJvc2UsIG5vdCBhIHNldFwiLiBXcmFwcGVkIGluIEpTT04gdGhhdCBtYXJrZXIgYmVjb21lcyBhIHN1YnN0cmluZyBvZlxuICogYW4gZXNjYXBlZCBzdHJpbmcsIHNvIGl0IGRvZXMgbm90IHN0YXkgaW4gcHJvc2U6IGV2ZXJ5IGVudW1lcmF0aW9uIGlzIG5vdyBhXG4gKiBgY2hvaWNlc2AgYXJyYXksIHdoaWNoIGlzIHdoYXQgZ2xhbW91ciAoQ09ORk9STUFOVCBMMCkgcHVibGlzaGVzIGFuZCB3aGF0IHRoZVxuICogZW52ZWxvcGUgaGFzIGEgZmllbGQgZm9yLiBUaGUgcnVubmFibGUgcmVjb3Zlcnkg4oCUIGB0cnk6IGJ1biDigKYvY2xpLnRzIG9wZW4geGAg4oCUXG4gKiBtb3ZlZCBpbnRvIGBoaW50YCBmb3IgdGhlIHNhbWUgcmVhc29uLCBhbmQgYSBjYWxsZXIgbm93IHJlYWRzIGEgZmllbGQgaW5zdGVhZFxuICogb2Ygc3BsaXR0aW5nIGEgc2VudGVuY2UuXG4gKlxuICog4pqgIGBkaWVgIGlzIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgc3dhbGxvd3MsIGFuZCB0aGF0IGlzXG4gKiBub3cgYSBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4gQXVkaXRlZCBieSBjYWxsIGdyYXBoIGF0IHRoZVxuICogYWRvcHRpb24gKHBsYXlib29rIEI5KTsgdGhlIGNvdW50IGlzIGluIHRoZSBqb3VybmFsLlxuICovXG5mdW5jdGlvbiBkaWUobXNnOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHJhaXNlKG1zZywga2luZCwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFRoZSB0YXhvbm9teSBga2luZGAgZm9yIGFuIEhUVFAgc3RhdHVzIHRoZSBkYWVtb24gYW5zd2VyZWQgd2l0aC5cbiAqXG4gKiDim5QgT05FIE1BUFBJTkcsIE5PVCBBIEpVREdFTUVOVCBQRVIgU0lURS4gVHdlbnR5IG9mIGdyYXBldmluZSdzIHJhaXNlIHNpdGVzXG4gKiBhcmUgXCJ0aGUgZGFlbW9uIHNhaWQgbm9cIjsgYmVmb3JlIHRoZSBhZG9wdGlvbiBldmVyeSBvbmUgb2YgdGhlbSBjb2xsYXBzZWQgdG9cbiAqIGV4aXQgMiwgc28gYSBtaXNzaW5nIGNoYW5uZWwsIGEgbGl2ZS1zZXNzaW9uIHJlZnVzYWwgYW5kIGEgYnJva2VuIGRhZW1vbiB3ZXJlXG4gKiBvbmUgbnVtYmVyIHRvIGFuIGFnZW50LiBUaGUgZGFlbW9uIGFscmVhZHkgZGlzdGluZ3Vpc2hlcyB0aGVtIGJ5IHN0YXR1cyDigJRcbiAqIDQwNCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QsIDQwOSBmb3IgYXJjaGl2ZWQgLyBsaXZlIC8gYWxyZWFkeS1vcGVuXG4gKiDigJQgc28gdGhlIG1hcHBpbmcgaXMgYSByZS1yZWFkaW5nIG9mIHdoYXQgd2FzIG9uIHRoZSB3aXJlLCBub3QgYSBuZXcgb3Bpbmlvbi5cbiAqL1xuZnVuY3Rpb24ga2luZEZvclN0YXR1cyhzdGF0dXM6IG51bWJlcik6IEVycktpbmQge1xuICBpZiAoc3RhdHVzID09PSA0MDQpIHJldHVybiBcIm5vdF9mb3VuZFwiO1xuICBpZiAoc3RhdHVzID09PSA0MDkpIHJldHVybiBcImNvbmZsaWN0XCI7XG4gIGlmIChzdGF0dXMgPj0gNDAwICYmIHN0YXR1cyA8IDUwMCkgcmV0dXJuIFwidXNhZ2VcIjtcbiAgcmV0dXJuIFwiaW50ZXJuYWxcIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZERhZW1vblBvcnQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKFBPUlRfRklMRSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChyYXcsIDEwKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIC8vIEZpcmUtYW5kLWZvcmdldCBtaXNtYXRjaCBjaGVjayAod29uJ3QgYmxvY2sgdGhlIHZlcmIpLlxuICAgICAgbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydCk7XG4gICAgICByZXR1cm4gcG9ydDtcbiAgICB9XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RhbGUg4oCUIGNsZWFuIHVwLlxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUE9SVF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUElEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBob2xkQWN0aXZlKCk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB1bnRpbCA9IHBhcnNlSW50KHJlYWRGaWxlU3luYyhIT0xEX0ZJTEUsIFwidXRmLThcIikudHJpbSgpLCAxMCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh1bnRpbCkgJiYgdW50aWwgPiBEYXRlLm5vdygpKSByZXR1cm4gdW50aWw7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9IGNhdGNoIHt9IC8vIGV4cGlyZWQg4oaSIGNsZWFuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgZnVuY3Rpb24gcmVsZWFzZUhvbGQoKSB7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgaWYgKGhvbGRBY3RpdmUoKSlcbiAgICBkaWUoXG4gICAgICBcImRhZW1vbiBpcyBoZWxkIChyZXNwYXduIHN1cHByZXNzZWQpIOKAlCB3YWl0IGZvciB0aGUgaG9sZCB0byBjbGVhciBvciBydW4gYGdyYXBldmluZSByb2xsYFwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIC8vIENoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzogdGhlIGRhZW1vbidzIHN0ZGlvIGlzIGlnbm9yZWQsIHNvIGFcbiAgLy8gZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydCB3b3VsZCBvdGhlcndpc2Ugc3VyZmFjZSBvbmx5IGFzXG4gIC8vIFwiZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiIOKAlCBhbmQgbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgRU5PRU5UIG9uXG4gIC8vIHRoZSBleGVjdXRhYmxlLCB3aGljaCByZWFkcyBhcyBcImJ1biBpcyBtaXNzaW5nXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBncmFwZXZpbmUgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH0uIGAgK1xuICAgICAgICBcIk5vIGRpc3QvaW5kZXguaHRtbCB3YXMgZm91bmQgKG9yIFNQRUxMQk9PS19TVVJGQUNFX01PREU9ZGV2IGlzIHNldCksIHNvIHRoZSBkYWVtb24gXCIgK1xuICAgICAgICBcIm11c3QgcnVuIGZyb20gc3JjL2dyYXBldmluZS8gdG8gYnVuZGxlIHRoZSB3YXRjaCBzdXJmYWNlLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgXCIgK1xuICAgICAgICBcImRvZXMgbm90IGhhdmUuIEVpdGhlciB0aGUgc2hpcHBlZCBkaXN0LyBpcyBtaXNzaW5nIChyZWluc3RhbGwgdGhlIHNwZWxsKSBvciB5b3UgYXJlIGluIFwiICtcbiAgICAgICAgXCJhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dyYXBldmluZS8uXCIsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgKTtcbiAgfVxuICAvLyBTcGF3biBkZXRhY2hlZCBzbyB0aGUgZGFlbW9uIHN1cnZpdmVzIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdC5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtEQUVNT05fU0NSSVBUXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2QsXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFdhaXQgdXAgdG8gM3MgZm9yIHRoZSBwb3J0IGZpbGUgdG8gYXBwZWFyIGFuZCByZXNwb25kLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIH1cbiAgZGllKFwiZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiwgXCJpbnRlcm5hbFwiLCB7XG4gICAgaGludDpcbiAgICAgIFwidGhyZWUgdW5yZWxhdGVkIGNhdXNlcyByZXBvcnQgdGhpcyBvbmUgc2VudGVuY2U6IHRoZSBkYWVtb24ncyBsYXVuY2hlciBzaGFwZSwgXCIgK1xuICAgICAgXCJhIHdyb25nIHNwYXduIHBhdGgsIGFuZCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQuIFwiICtcbiAgICAgIFwiUnVuIHRoZSBkYWVtb24gbGF1bmNoZXIgYWxvbmUgdG8gdGVsbCB0aGVtIGFwYXJ0LlwiLFxuICB9KTtcbn1cblxuLy8gR2VuZXJpYyBvdmVyIHRoZSBleHBlY3RlZCBzdWNjZXNzIGJvZHkuIGBkYXRhYCBtYXkgYmUgbnVsbCBpZiB0aGUgcmVzcG9uc2Vcbi8vIGhhZCBubyBKU09OIGJvZHksIHNvIGNhbGxlcnMgc2VlIGBUIHwgbnVsbGAuXG5hc3luYyBmdW5jdGlvbiBhcGk8VCA9IHVua25vd24+KFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiBUIHwgbnVsbCB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogVCB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgVDtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG5cbi8vIEhvdyBUSElTIENMSSB3YXMgaW52b2tlZCwgYXMgYSBydW5uYWJsZSBwcmVmaXguIGBwcm9jZXNzLmFyZ3ZbMV1gIGlzIHRoZVxuLy8gYWJzb2x1dGUgcGF0aCBvZiBjbGkudHMgdW5kZXIgYGJ1biDigKYvY2xpLnRzIDx2ZXJiPmAsIHdoaWNoIGlzIFNLSUxMLm1kJ3Ncbi8vIGNhbm9uaWNhbCBpbnZvY2F0aW9uIOKAlCBzbyB0aGUgbGluZSB3ZSBwcmludCBjYW4gYWN0dWFsbHkgYmUgcGFzdGVkLiBGYWxsc1xuLy8gYmFjayB0byB0aGUgYmFyZSB2ZXJiIGlmIGFyZ3YgaXMgbm90IHNoYXBlZCBhcyBleHBlY3RlZCwgd2hpY2ggaXMgYSB2ZXJiXG4vLyByZWZlcmVuY2UgcmF0aGVyIHRoYW4gYSBjb21tYW5kIHRoYXQgbGllcyBhYm91dCBiZWluZyBvbmUuXG5mdW5jdGlvbiBpbnZvY2F0aW9uUHJlZml4KCk6IHN0cmluZyB7XG4gIGNvbnN0IGVudHJ5ID0gcHJvY2Vzcy5hcmd2WzFdO1xuICByZXR1cm4gZW50cnkgPyBgYnVuICR7ZW50cnl9YCA6IFwiXCI7XG59XG5cbi8vIEEgZGFlbW9uIHJlZnVzYWwgY2FycmllcyBgaGludGAg4oCUIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0IChhIDQwNCBvbiBhXG4vLyByZWFkIG5hbWVzIHRoZSBgb3BlbmAgdGhhdCB3b3VsZCBjcmVhdGUgdGhlIGNoYW5uZWwpLlxuLy9cbi8vIOKaoCBgaGludGAgaXMgYSBWRVJCIElOVk9DQVRJT04sIG5vdCBhIHNoZWxsIGNvbW1hbmQ6IHRoZSBkYWVtb24gY2Fubm90IGtub3dcbi8vIGhvdyBpdHMgY2xpZW50IHdhcyBpbnZva2VkLCBzbyBpdCBuYW1lcyB0aGUgYWN0IGFuZCB3ZSByZW5kZXIgaXQuIEl0IHVzZWQgdG9cbi8vIGFycml2ZSBhcyBgZ3JhcGV2aW5lIG9wZW4gPG5hbWU+YCBhbmQgYmUgcHJpbnRlZCB2ZXJiYXRpbSBhZnRlciBgdHJ5OmAsIHdoaWNoXG4vLyByZWFkcyBhcyBzb21ldGhpbmcgdG8gcGFzdGUg4oCUIGFuZCBwYXN0aW5nIGl0IGdldHMgYGNvbW1hbmQgbm90IGZvdW5kYCxcbi8vIGJlY2F1c2Ugbm90aGluZyBpbnN0YWxscyBhIGBncmFwZXZpbmVgIGJpbmFyeS4gUnVsaW5nIDIgYXNrZWQgdGhhdCBhIHJlZnVzYWxcbi8vIG5hbWUgdGhlIG5leHQgYWN0OyBhIHJlY292ZXJ5IHRoYXQgZmFpbHMgd2hlbiB5b3UgcnVuIGl0IGRvZXMgbm90LlxuZnVuY3Rpb24gZGllQXBpKGRhdGE6IHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1czogbnVtYmVyKTogbmV2ZXIge1xuICBjb25zdCBtc2cgPSBkYXRhPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gO1xuICBjb25zdCBwcmVmaXggPSBpbnZvY2F0aW9uUHJlZml4KCk7XG4gIC8vIOKblCBUSEUgUkVDT1ZFUlkgSVMgQSBGSUVMRCBOT1csIE5PVCBBIFNFTlRFTkNFLiBJdCB1c2VkIHRvIGJlIGFwcGVuZGVkIHRvIHRoZVxuICAvLyBtZXNzYWdlIGFzIGDigJQgdHJ5OiA8Y21kPmAsIHdoaWNoIGEgY2FsbGVyIGhhZCB0byByZWNvdmVyIGJ5IHNwbGl0dGluZyBvblxuICAvLyBcInRyeTogXCIgKG9uZSBvZiBncmFwZXZpbmUncyBvd24gY2VsbHMgZGlkIGV4YWN0bHkgdGhhdCwgYW5kIHJhbiB3aGF0IGl0XG4gIC8vIGZvdW5kKS4gYGhpbnRgIGlzIHdoZXJlIHRoZSBlbnZlbG9wZSBjYXJyaWVzIGl0LCBzbyB0aGUgc2FtZSBjZWxsIG5vdyByZWFkc1xuICAvLyBhIGZpZWxkIGFuZCBydW5zIGl0IOKAlCB0aGUgcHJvcGVydHkgaXMgdW5jaGFuZ2VkIGFuZCB0aGUgcGFyc2UgaXMgbm90IGEgcGFyc2UuXG4gIGNvbnN0IGhpbnQgPSBkYXRhPy5oaW50XG4gICAgPyBwcmVmaXhcbiAgICAgID8gYHRyeTogJHtwcmVmaXh9ICR7ZGF0YS5oaW50fWBcbiAgICAgIDogYHRyeSB0aGUgXFxgJHtkYXRhLmhpbnR9XFxgIHZlcmJgXG4gICAgOiB1bmRlZmluZWQ7XG4gIGRpZShtc2csIGtpbmRGb3JTdGF0dXMoc3RhdHVzKSwge1xuICAgIC4uLihoaW50ID8geyBoaW50IH0gOiB7fSksXG4gICAgLy8gVGhlIHVwc3RyZWFtJ3MgYm9keSBWRVJCQVRJTSwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB3aGF0IHRoZSBkYWVtb25cbiAgICAvLyBhY3R1YWxseSBzYWlkIHJhdGhlciB0aGFuIG9uIHRoaXMgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQuXG4gICAgLi4uKGRhdGEgIT09IG51bGwgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuLy8gRXhpc3RlbmNlIHByb2JlIGZvciB0aGUgcmVhZCB2ZXJicyB0aGF0IGFuc3dlciBmcm9tIHRoZSBMT0cgRklMRSByYXRoZXIgdGhhblxuLy8gZnJvbSBhIHJvdXRlIChgdHJpYWdlYCwgYHB1bGwgLS1zdGF0dXNgKS4gVGhvc2UgY2Fubm90IDQwNCBvbiB0aGVpciBvd246IGFcbi8vIG1pc3NpbmcgbG9nIGlzIGFuIGVtcHR5IGFycmF5LCB3aGljaCBpcyB0aGUgc2FtZSBzaWxlbnQgbGllIHRoZSBkYWVtb24gZ3VhcmRcbi8vIGV4aXN0cyB0byBraWxsLiBHRVQgL3RvcGljIGlzIHRoZSBjaGVhcGVzdCBndWFyZGVkIHJvdXRlLCBzbyBpdCBpcyB0aGUgcHJvYmUuXG5hc3luYyBmdW5jdGlvbiByZXF1aXJlQ2hhbm5lbChwb3J0OiBudW1iZXIsIG5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2AsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihuYW1lOiBzdHJpbmcsIG9wdHM6IHsgdG9waWM/OiBzdHJpbmc7IGZyb20/OiBzdHJpbmc7IGZyZXNoPzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiA9IHsgbmFtZSwgZXhwbGljaXQ6IHRydWUgfTtcbiAgaWYgKG9wdHMudG9waWMgIT09IHVuZGVmaW5lZCkgYm9keS50b3BpYyA9IG9wdHMudG9waWM7XG4gIGlmIChvcHRzLmZyb20gIT09IHVuZGVmaW5lZCkgYm9keS5mcm9tID0gb3B0cy5mcm9tO1xuICBpZiAob3B0cy5mcmVzaCkgYm9keS5mcmVzaCA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8T3BlblJlc3BvbnNlPihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IGRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRvcGljKG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkLCBmcm9tOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRvcGljIDxjaGFubmVsPiBbPHRleHQ+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBpZiAodGV4dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gYHRvcGljIDxuYW1lPmAgd2l0aCBubyB0ZXh0IGlzIGEgUkVBRCDigJQgaXQgYXNrcyB3aGF0IHRoZSB0b3BpYyBpcywgYW5kIGFcbiAgICAvLyBtaXNzaW5nIGNoYW5uZWwgYW5zd2VycyB0aGF0IHF1ZXN0aW9uIGJ5IGJlaW5nIG1pc3NpbmcuIE5vIGVuc3VyZTogdGhlXG4gICAgLy8gZW5zdXJlIHdhcyB3aGF0IHJlc3VycmVjdGVkIGEgY2xvc2VkIGNoYW5uZWwgZnJvbSBhIHJlYWQgdmVyYi5cbiAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2ApO1xuICAgIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBgdG9waWMgPG5hbWU+IDx0ZXh0PmAgaXMgYSBXUklURSwgc28gaXQgbWF5IGNyZWF0ZSDigJQgYnV0IGl0IG11c3Qgbm90IHdyaXRlXG4gIC8vIHRvIGFuIEFSQ0hJVkVEIGNoYW5uZWwuIFRoZSBQVVQgZW5mb3JjZXMgdGhhdCBpdHNlbGYgbm93OyB0aGlzIGVuc3VyZSBzdGF5c1xuICAvLyBiZWNhdXNlIERJU0NBUkRJTkcgSVRTIFNUQVRVUyBpcyBwcmVjaXNlbHkgdGhlIGJ1ZyBiZWluZyBmaXhlZCBoZXJlLiBCZWZvcmVcbiAgLy8gdG9kYXkgdGhlIDQwOSB0aGF0IGFuc3dlcnMgZm9yIGFuIGFyY2hpdmVkIG5hbWUgd2FzIHRocm93biBhd2F5IGFuZCB0aGUgUFVUXG4gIC8vIHRoYXQgZm9sbG93ZWQgbGFuZGVkOiBgYXJjaGl2ZSB4OyB0b3BpYyB4IFwidFwiYCByZXR1cm5lZCBvazp0cnVlLCBleGl0IDAuXG4gIGNvbnN0IGVuc3VyZSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCB7IG5hbWUgfSk7XG4gIGlmIChlbnN1cmUuc3RhdHVzID49IDQwMCkgZGllQXBpKGVuc3VyZS5kYXRhLCBlbnN1cmUuc3RhdHVzKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIlBVVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLCB7XG4gICAgdG9waWM6IHRleHQsXG4gICAgZnJvbTogZnJvbSA/PyBcInN5c3RlbVwiLFxuICB9KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljLCBpZDogZGF0YT8uaWQgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxDaGFubmVsc1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9jaGFubmVsc1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChcbiAgbmFtZTogc3RyaW5nLFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW47IHZlcmJvc2U/OiBib29sZWFuOyBpblJlcGx5VG8/OiBudW1iZXIgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGluX3JlcGx5X3RvPzogbnVtYmVyIH0gPSB7XG4gICAgZnJvbSxcbiAgICB0ZXh0LFxuICB9O1xuICBpZiAob3B0cy5pblJlcGx5VG8gIT09IHVuZGVmaW5lZCkgYm9keS5pbl9yZXBseV90byA9IG9wdHMuaW5SZXBseVRvO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFNlbmRSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgLy8gVGFyZ2V0IGVjaG8gb24gc3RkZXJyIOKAlCBjb25maXJtcyBXSEVSRSB0aGUgbWVzc2FnZSBsYW5kZWQgc28gYSBtaXNyb3V0ZWRcbiAgLy8gcmVwbHkgKHJpZ2h0IHByb21wdCwgd3JvbmcgY2hhbm5lbCkgaXMgY2F1Z2h0IHRoZSBpbnN0YW50IGl0IGhhcHBlbnMgKEY5KS5cbiAgLy8gT24gc3RkZXJyIHNvIGl0IG5ldmVyIHBvbGx1dGVzIHRoZSBzdGRvdXQgSlNPTiByZWNlaXB0LCBhbmQgaXQgZmlyZXMgZXZlblxuICAvLyB1bmRlciAtLXF1aWV0ICh0aGUgc2FmZXR5IHNpZ25hbCBzaG91bGRuJ3QgYmUgc2lsZW5jZWQpLlxuICBjb25zdCByZWNpcCA9XG4gICAgZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWRcbiAgICAgID8gYCR7ZGF0YS5yZWNpcGllbnRzfSByZWNpcGllbnQocylgXG4gICAgICA6IGAke2RhdGEuc3Vic2NyaWJlcnMgPz8gMH0gc3Vic2NyaWJlcihzKWA7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIOKGkiAke2RhdGEuY2hhbm5lbH0gwrcgJHtyZWNpcH1cXG5gKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgLy8gVGVyc2UgZGVmYXVsdDogaWQgKyBzdWJzY3JpYmVyIGNvdW50ICsgdm9pZCB3YXJuaW5nLiAtLXZlcmJvc2UgYWxzb1xuICAvLyBpbmNsdWRlcyB0aGUgc3Vic2NyaWJlciBhbGlhcyBsaXN0IChzYW1lIGRhdGEgYXMgdGhlIGB3aG9gIHZlcmIsXG4gIC8vIHBpZ2d5YmFja2VkIHRvIGF2b2lkIGFuIGV4dHJhIHJvdW5kLXRyaXAgd2hlbiB0aGUgc2VuZGVyIGNhcmVzKS5cbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBpZDogZGF0YS5pZCxcbiAgICBjaGFubmVsOiBkYXRhLmNoYW5uZWwsXG4gICAgc3Vic2NyaWJlcnM6IGRhdGEuc3Vic2NyaWJlcnMgPz8gMCxcbiAgfTtcbiAgLy8gT25seSBzdXJmYWNlIHJlY2lwaWVudHMgaWYgdGhlIGRhZW1vbiBhY3R1YWxseSBjb21wdXRlZCBpdC4gRGVmYXVsdGluZ1xuICAvLyB0byAwIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIFwicmVhbGx5IDBcIiBhbmQgaGlkIHNpbGVudCBWMS41LWRhZW1vblxuICAvLyBkZWdyYWRhdGlvbiBkdXJpbmcgY3Jvc3MtdmVyc2lvbiBzZXNzaW9uczsgbWlzc2luZy1tZWFucy1taXNzaW5nIGlzIHRoZVxuICAvLyBob25lc3Qgc2lnbmFsLlxuICBpZiAoZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWQpIG91dC5yZWNpcGllbnRzID0gZGF0YS5yZWNpcGllbnRzO1xuICBpZiAoZGF0YS5zdWJzY3JpYmVycyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcImNoYW5uZWwgaGFzIG5vIHN1YnNjcmliZXJzXCI7XG4gIGVsc2UgaWYgKGRhdGEucmVjaXBpZW50cyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm9ubHkgeW91IGFyZSBzdWJzY3JpYmVkXCI7XG4gIGlmIChvcHRzLnZlcmJvc2UpIG91dC5zdWJzY3JpYmVyX2FsaWFzZXMgPSBkYXRhLnN1YnNjcmliZXJfYWxpYXNlcyA/PyBbXTtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFubm91bmNlKFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgY2hhbm5lbHM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7IHF1aWV0PzogYm9vbGVhbiB9LFxuKSB7XG4gIGlmICghZnJvbSB8fCAhdGV4dCkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBhbm5vdW5jZSAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogeyBmcm9tOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgY2hhbm5lbHM/OiBzdHJpbmdbXSB9ID0geyBmcm9tLCB0ZXh0IH07XG4gIGlmIChjaGFubmVscz8ubGVuZ3RoKSBib2R5LmNoYW5uZWxzID0gY2hhbm5lbHM7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8QW5ub3VuY2VSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgXCIvYW5ub3VuY2VcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgYCMgYW5ub3VuY2VkIOKGkiAke2RhdGEuY2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIMK3ICR7ZGF0YS50b3RhbF9yZWNpcGllbnRzfSByZWNpcGllbnQocylcXG5gLFxuICApO1xuICBpZiAob3B0cy5xdWlldCkgcmV0dXJuO1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG9rOiB0cnVlLFxuICAgIGNoYW5uZWxzOiBkYXRhLmNoYW5uZWxzLFxuICAgIHRvdGFsX3JlY2lwaWVudHM6IGRhdGEudG90YWxfcmVjaXBpZW50cyxcbiAgfTtcbiAgaWYgKGRhdGEuc2tpcHBlZD8ubGVuZ3RoKSBvdXQuc2tpcHBlZCA9IGRhdGEuc2tpcHBlZDtcbiAgaWYgKGRhdGEuY2hhbm5lbHMubGVuZ3RoID09PSAwKSBvdXQud2FybmluZyA9IFwibm8gYWN0aXZlIGNoYW5uZWxzIHRvIGFubm91bmNlIHRvXCI7XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQdWxsKG5hbWU6IHN0cmluZywgc2luY2U6IG51bWJlciwgb3B0czogeyBzdGF0dXM/OiBzdHJpbmcgfSA9IHt9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBwdWxsIDxjaGFubmVsPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcblxuICBpZiAob3B0cy5zdGF0dXMgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFRoaXMgYnJhbmNoIGFuc3dlcnMgZnJvbSB0aGUgbG9nIGZpbGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93bi5cbiAgICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgICAvLyBGdWxsLWNoYW5uZWwgc2NhbjogZmlsdGVyIGJ5IGxhdGVzdCBkaXNwb3NpdGlvbiwgc3RhdHVzIGZyYW1lcyBleGNsdWRlZC5cbiAgICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICAgIGNvbnN0IGZpbHRlcmVkID0gYmFkZ2VkLmZpbHRlcigobSkgPT4ge1xuICAgICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICAgIC8vIGAtLXN0YXR1cyBvcGVuYCBtaXJyb3JzIHRyaWFnZSdzIG9wZW4gYnVja2V0OiBzaWduYWwtb25seSwgc28gbm9uLW1lc3NhZ2VcbiAgICAgIC8vIEZZSXMgKHRvcGljL2Fubm91bmNlbWVudCkgYXJlIGV4Y2x1ZGVkIGZyb20gdGhlIGFjdGlvbmFibGUgcXVldWUuXG4gICAgICByZXR1cm4gb3B0cy5zdGF0dXMgPT09IFwib3BlblwiXG4gICAgICAgID8gbS5raW5kID09PSBcIm1lc3NhZ2VcIiAmJiBpc09wZW4oZGlzcEFyZylcbiAgICAgICAgOiBtLmRpc3Bvc2l0aW9uID09PSBvcHRzLnN0YXR1cztcbiAgICB9KTtcbiAgICBjb25zdCBsYXN0SWQgPSBmaWx0ZXJlZC5sZW5ndGggPyBmaWx0ZXJlZFtmaWx0ZXJlZC5sZW5ndGggLSAxXS5pZCA6IDA7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBmaWx0ZXJlZCwgY3Vyc29yOiBsYXN0SWQgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU2luY2Utd2luZG93IHBhdGggKHVuY2hhbmdlZCBmcm9tIFRhc2sgMikuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke3NpbmNlfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgcmF3TXNncyA9IGRhdGE/Lm1lc3NhZ2VzID8/IFtdO1xuICBjb25zdCBjdXJzb3IgPSByYXdNc2dzLmxlbmd0aCA/IHJhd01zZ3NbcmF3TXNncy5sZW5ndGggLSAxXS5pZCA6IHNpbmNlO1xuICBjb25zdCBkaXNwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgYW5ub3RhdGVkID0gcmF3TXNnc1xuICAgIC8vIERpc3Bvc2l0aW9uIGZyYW1lcyBvbmx5IOKAlCBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHN0YXlzIGluXG4gICAgLy8gdGhlIGhpc3RvcnkgYW4gYWdlbnQgcHVsbHM7IGl0IGlzIGhvdyBpdCBsZWFybnMgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQuXG4gICAgLmZpbHRlcigobSkgPT4gIWlzRGlzcG9zaXRpb25GcmFtZShtKSlcbiAgICAubWFwKChtKSA9PiB7XG4gICAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgICByZXR1cm4gZCA/IHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbTtcbiAgICB9KTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBhbm5vdGF0ZWQsIGN1cnNvciB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhZChuYW1lOiBzdHJpbmcsIGlkOiBudW1iZXIsIG9wdHM6IHsgdGV4dD86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVhZCA8Y2hhbm5lbD4gPGlkPiBbLS10ZXh0XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBCdWlsdCBvbiB0aGUgZXhpc3RpbmcgcmFuZ2UgZmV0Y2gg4oCUIGBzaW5jZT1pZC0xYCByZXR1cm5zIGlkIGFuZCBiZXlvbmQ7XG4gIC8vIHdlIHBpY2sgdGhlIGV4YWN0IGlkLiBObyBkYWVtb24gQVBJIGNoYW5nZS4gVGhpcyBpcyB0aGUgdGFyZ2V0ZWRcbiAgLy8gXCJnaXZlIG1lIG1lc3NhZ2UgTiBpbiBmdWxsXCIgdmVyYiB0aGF0IHJlY292ZXJzIGEgY2xpcHBlZCB0YWlsIHByZXZpZXdcbiAgLy8gd2l0aG91dCB0aGUgcHVsbC1yYW5nZSArIGpxIGRhbmNlLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtpZCAtIDF9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBjb25zdCBtc2cgPSAoZGF0YT8ubWVzc2FnZXMgPz8gW10pLmZpbmQoKG0pID0+IG0uaWQgPT09IGlkKTtcbiAgaWYgKCFtc2cpIGRpZShgbWVzc2FnZSAke2lkfSBub3QgZm91bmQgaW4gJHtuYW1lfWAsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCBkaXNwTWFwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgZCA9IGRpc3BNYXAuZ2V0KGlkKTtcbiAgY29uc3QgYW5ub3RhdGVkTXNnID0gZCA/IHsgLi4ubXNnLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0gOiBtc2c7XG4gIGlmIChvcHRzLnRleHQpIHtcbiAgICAvLyBQcm9zZSBtb2RlOiBoZWFkZXIgKyBib2R5LCBubyBKU09OIGVudmVsb3BlLCBzbyBhIGh1bWFuIChvciBhbiBhZ2VudFxuICAgIC8vIHJlY292ZXJpbmcgYSB0cnVuY2F0ZWQgbm90aWZpY2F0aW9uKSBjYW4gcmVhZCBpdCBkaXJlY3RseS5cbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG1zZy50cykudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCBkaXNwUHJlZml4ID0gZFxuICAgICAgPyBkLnJlb3BlbnMgPiAwXG4gICAgICAgID8gYFske2QuZGlzcG9zaXRpb259IOKGuyR7ZC5yZW9wZW5zfV0gYFxuICAgICAgICA6IGBbJHtkLmRpc3Bvc2l0aW9ufV0gYFxuICAgICAgOiBcIlwiO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2Rpc3BQcmVmaXh9WyR7bXNnLmlkfV0gJHttc2cuZnJvbX0gwrcgJHt0c31cXG4ke21zZy50ZXh0fVxcbmApO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZTogYW5ub3RhdGVkTXNnIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXYWl0KG5hbWU6IHN0cmluZywgc2luY2U6IG51bWJlciwgdGltZW91dFM6IG51bWJlciwgYWxpYXM6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2FpdCA8Y2hhbm5lbD4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEdpdmUgdGhlIEhUVFAgZmV0Y2ggYSBzbGlnaHRseSBoaWdoZXIgYWJvcnQgdGltZW91dCB0aGFuIHRoZSBkYWVtb24nc1xuICAvLyBsb25nLXBvbGwgdGltZW91dCBzbyB0aGUgZGFlbW9uIGFsd2F5cyB3aW5zIHRoZSB0aW1lb3V0IHJhY2UuXG4gIC8vIGA/YXM9PGFsaWFzPmAgcmVnaXN0ZXJzIHByZXNlbmNlIG9uIHRoZSBjaGFubmVsIGZvciB0aGUgd2FpdCBkdXJhdGlvbiDigJRcbiAgLy8gd2FpdCBpcyBsb25nLXBvbGwgKHB1c2gtc2hhcGVkIHdpdGggYSBkZWFkbGluZSkgc28gaXQgZGVzZXJ2ZXMgcHJlc2VuY2UuXG4gIGNvbnN0IGFzUGFyYW0gPSBhbGlhcyA/IGAmYXM9JHtlbmNvZGVVUklDb21wb25lbnQoYWxpYXMpfWAgOiBcIlwiO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5uZWxzLyR7bmFtZX0vd2FpdD9zaW5jZT0ke3NpbmNlfSZ0aW1lb3V0PSR7dGltZW91dFN9JHthc1BhcmFtfWA7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgodGltZW91dFMgKyA1KSAqIDEwMDApLFxuICB9KTtcbiAgbGV0IGRhdGE6IFdhaXRSZXNwb25zZSB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgV2FpdFJlc3BvbnNlO1xuICB9IGNhdGNoIHt9XG4gIGlmICghcmVzLm9rKSBkaWVBcGkoZGF0YSwgcmVzLnN0YXR1cyk7XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgbWVzc2FnZXM6IGRhdGE/Lm1lc3NhZ2VzID8/IFtdLFxuICAgIGN1cnNvcjogZGF0YT8uY3Vyc29yID8/IHNpbmNlLFxuICAgIHRpbWVkX291dDogISFkYXRhPy50aW1lZF9vdXQsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXaG8obmFtZTogc3RyaW5nKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB3aG8gPGNoYW5uZWw+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWw6IG5hbWUsIHN1YnNjcmliZXJzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdWJzY3JpYmVyc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3N1YnNjcmliZXJzYCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvQWxsKCkge1xuICAvLyBDcm9zcy1jaGFubmVsIHJvc3RlciDigJQgbmFtZXMgw5cgY2hhbm5lbCBpbiBvbmUgY2FsbCwgc28geW91IGRvbid0IGZhbiBvdXRcbiAgLy8gTiBgd2hvYCBjYWxscyArIGEgbWFudWFsIGpvaW4gdG8gYW5zd2VyIFwid2hvIGlzIG9uIHdoaWNoIHZpbmU/XCIuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyBHZXQgb3Igc2V0IHRoZSBwZXJzaXN0ZWQgZGVmYXVsdCBhbGlhcyAoVjEuNykuIFdpdGggbm8gYXJndW1lbnQsIHByaW50cyB0aGVcbi8vIGN1cnJlbnQgYWxpYXM7IHdpdGggb25lLCB3cml0ZXMgaXQgdG8gY29uZmlnLmpzb24uIFB1cmUgZmlsZSBJL08g4oCUIHdvcmtzXG4vLyB3aXRob3V0IGEgcnVubmluZyBkYWVtb24uIFRoZSB3YXRjaCBzdXJmYWNlIHJlYWRzIGl0IHZpYSBHRVQgL2lkZW50aXR5IHNvIHRoZVxuLy8gaHVtYW4gaGFzIGEgY29uc2lzdGVudCBuYW1lIGFjcm9zcyBldmVyeSBncmFwZXZpbmUuXG5hc3luYyBmdW5jdGlvbiBjbWRBbGlhcyhuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgbGV0IGNmZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgdHJ5IHtcbiAgICBjZmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhDT05GSUdfRklMRSwgXCJ1dGYtOFwiKSk7XG4gIH0gY2F0Y2gge31cbiAgaWYgKG5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFsaWFzID0gdHlwZW9mIGNmZy5hbGlhcyA9PT0gXCJzdHJpbmdcIiAmJiBjZmcuYWxpYXMudHJpbSgpID8gY2ZnLmFsaWFzLnRyaW0oKSA6IG51bGw7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFsaWFzIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB0cmltbWVkID0gbmFtZS50cmltKCk7XG4gIGNmZy5hbGlhcyA9IHRyaW1tZWQ7XG4gIG1rZGlyU3luYyhEQVRBX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoQ09ORklHX0ZJTEUsIGAke0pTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMil9XFxuYCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhczogdHJpbW1lZCB8fCBudWxsIH0pO1xufVxuXG4vKipcbiAqIFRoZSBzdGFuZGluZyB0YWlsIOKAlCBgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgLCBhZG9wdGVkIGF0IFBoYXNlIDYgY2hhcHRlciAyLlxuICpcbiAqIOKblCBXSEFUIFRISVMgUkVQTEFDRUQsIEFORCBXSEFUIElUIEJPVUdIVC4gVGhpcyB2ZXJiIHdhcyAyMjAgbGluZXMgb2ZcbiAqIGhhbmQtd3JpdHRlbiByZWNvbm5lY3QgbG9vcDogdGhyZWUgbmVzdGVkIGxvb3BzIChyZWNvbm5lY3QgLyByZWFkIC8gZnJhbWVcbiAqIGRyYWluKSwgaXRzIG93biBTU0Ugc3BsaXR0ZXIsIGl0cyBvd24gYmFja29mZiwgYW5kIGEgYHByb2Nlc3MuZXhpdCgwKWAgaW4gYVxuICogc2lnbmFsIGhhbmRsZXIgc2V2ZW4gbGluZXMgaW4uIFRoZSBzaGFyZWQgY2xpZW50IGlzIHRoZSBzYW1lIGRlc2lnbiwgb25jZSwgYW5kXG4gKiB0aHJlZSB0aGluZ3MgYXJyaXZlIHdpdGggaXQgdGhhdCBncmFwZXZpbmUgZGlkIG5vdCBoYXZlOlxuICpcbiAqICAgMS4gKipBTiBJRExFIFdBVENIRE9HIOKAlCBncmFwZXZpbmUgaGFkIE5PTkUuKiogYGF3YWl0IHJlYWRlci5yZWFkKClgIHdhc1xuICogICAgICB1bmJvdW5kZWQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhXG4gKiAgICAgIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIEZPUkVWRVIsIGFuZCBhIHBhcmtlZCB0YWlsIGlzXG4gKiAgICAgIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLiBgVEFJTF9JRExFX01TYCBpcyB0aHJlZSBvZiBUSElTXG4gKiAgICAgIHNwZWxsJ3MgMyBzIGJlYXRzIChgLi9oZWFydGJlYXQudHNgKSwgbmV2ZXIgYSBjb3BpZWQgNDUsMDAwLlxuICogICAyLiAqKkEgU1BFQy1DT1JSRUNUIEZSQU1FIFBBUlNFUi4qKiBUaGUgaGFuZC13cml0dGVuIG9uZSBkaWRcbiAqICAgICAgYGxpbmUuc2xpY2UoNSkudHJpbSgpYCwgd2hpY2ggc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIHRoZSBvbmVcbiAqICAgICAgbGVhZGluZyBzcGFjZSB0aGUgc3BlYyByZW1vdmVzIOKAlCBpdCB3b3VsZCBjb3JydXB0IGEgbWVzc2FnZSBib2R5IHdob3NlXG4gKiAgICAgIGZpcnN0IGxpbmUgaXMgaW5kZW50ZWQuIE5vdGhpbmcgaW4gdGhlIHJvc3RlciBlbWl0cyBvbmUgdG9kYXk7IHRoZSBwYXJzZVxuICogICAgICBpcyByaWdodCBhbnl3YXkgbm93LlxuICogICAzLiAqKkEgU0lHTkFMIFBBVEggVEhBVCBEUkFJTlMuKiogVGhlIG9sZCBoYW5kbGVyIHdhc1xuICogICAgICBgc3RvcHBlZCA9IHRydWU7IHByb2Nlc3MuZXhpdCgwKWAg4oCUIHRoZSBQMGYgZGVmZWN0IGV4YWN0bHksIGFwcGxpZWQgdG9cbiAqICAgICAgdGhlIHRlcm1pbmFsIGZyYW1lIGluIGZpdmUgc3BlbGxzIGFuZCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZVxuICogICAgICBsaW5lcyBhYm92ZSBpdC4gQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWRcbiAqICAgICAgc3Rkb3V0LiBUaGUgY2xpZW50IFJFVFVSTlMgYW4gZXhpdCBjb2RlOyBgbWFpbmAgYXNzaWducyBpdCBhbmQgcmV0dXJuc1xuICogICAgICBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMuXG4gKlxuICog4puUIE5PIGBlcG9jaE9mYCAvIGBvbkVwb2NoQ2hhbmdlYCwgQU5EIFRIQVQgSVMgQSBSVUxJTkcsIE5PVCBBTiBPTUlTU0lPTlxuICogKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmUgUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQg4oCUIGBsb2FkQ2hhbm5lbCgpYFxuICogZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBoaWdoLXdhdGVyIG1hcmsgb3ZlciB0aGUgZHVyYWJsZSBgLmpzb25sYCDigJQgc28gYVxuICogcmVjb25uZWN0aW5nIGN1cnNvciBpcyBzdGlsbCB2YWxpZCBhbmQgdGhlIGNvbmRpdGlvbiBhbiBlcG9jaCBkZXRlY3RzIGNhbm5vdFxuICogb2NjdXIgaGVyZS4gV2lyaW5nIG9uZSB3b3VsZCBiZSBhIFJFR1JFU1NJT04gd2l0aCBhIG1lYXN1cmVkIG1lY2hhbmlzbTpcbiAqIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIGBjdXJzb3IgPSAwYCwgYW5kIHRoaXMgZGFlbW9uIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGhcbiAqIGByZWFkQmFja2xvZyhuYW1lLCAwKWAg4oCUIHRoZSB3aG9sZSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhbiBhZ2VudCdzIHBpcGUsXG4gKiBvbiBldmVyeSBgZ3JhcGV2aW5lIHJvbGxgLlxuICpcbiAqIOKaoCBgcmVzb2x2ZWAgQ0FMTFMgYGVuc3VyZURhZW1vbmAsIFdISUNIIENBTiBSQUlTRSDigJQgZGVsaWJlcmF0ZWx5LCBhbmQgdGhlIGtpdFxuICogZG9jdW1lbnRzIHRoZSBwcm9wZXJ0eSB0aGlzIGRlcGVuZHMgb246IGl0cyBvdXRlciBibG9jayBpcyBhIGB0cnlgL2BmaW5hbGx5YFxuICogd2l0aCBOTyBgY2F0Y2hgLCBzbyBhIGBDbGlFcnJvcmAgZnJvbSB0aHJlZSBmcmFtZXMgZG93biBwcm9wYWdhdGVzIGludG9cbiAqIGBtYWluYCBpbnN0ZWFkIG9mIGJlaW5nIHJlYWQgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kIHJldHJpZWQgZm9yZXZlci5cbiAqIENoZWNrZWQgYXQgdGhlIGFkb3B0aW9uIHJhdGhlciB0aGFuIGFzc3VtZWQgKHBsYXlib29rIEI5IHN0ZXAgNSkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIG5hbWU6IHN0cmluZyxcbiAgb3B0czoge1xuICAgIHNpbmNlPzogbnVtYmVyO1xuICAgIGZyb21TdGFydD86IGJvb2xlYW47XG4gICAgbGFzdD86IG51bWJlcjtcbiAgICBhcz86IHN0cmluZztcbiAgICBodW1hbj86IGJvb2xlYW47XG4gICAgbHVyaz86IGJvb2xlYW47XG4gICAgbWF4PzogbnVtYmVyO1xuICB9LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFuYW1lKVxuICAgIGRpZShcbiAgICAgIFwidXNhZ2U6IGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXCIsXG4gICAgKTtcbiAgLy8gLS1sdXJrIHJlY2VpdmVzIG1lc3NhZ2VzIGJ1dCByZWdpc3RlcnMgbm8gcHJlc2VuY2Ug4oCUIGFuIGludmlzaWJsZSBvYnNlcnZlci5cbiAgLy8gSXQgb3ZlcnJpZGVzIGlkZW50aXR5IGZsYWdzIChhIGx1cmtlciBoYXMgbm8gbmFtZSB0byBzaG93KS5cbiAgY29uc3QgbXlBbGlhcyA9IG9wdHMubHVyayA/IHVuZGVmaW5lZCA6IG9wdHMuYXM7XG4gIGNvbnN0IHNpbmNlID0gb3B0cy5mcm9tU3RhcnQgPyAwIDogKG9wdHMuc2luY2UgPz8gLTEpO1xuICAvLyBFbWl0IHRoZSBncm91bmRpbmcgbGluZSBvbmx5IG9uIHRoZSBmaXJzdCBzdWJzY3JpYmUsIG5ldmVyIG9uIHJlY29ubmVjdHNcbiAgLy8gKGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSB0aGUgY3Vyc29yIOKAlCB0aGVyZSBpcyBubyB1bnNlZW4gaGlzdG9yeSB0aGVuKS5cbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8VGFpbFBheWxvYWQ+KHtcbiAgICAvLyDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVELiBBIHRhaWwgb3V0bGl2ZXNcbiAgICAvLyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCDigJQgYHJvbGxgIGFuZCBgcmVzdGFydGAgYm90aCByZXBsYWNlIGl0IOKAlCBhbmRcbiAgICAvLyBgZW5zdXJlRGFlbW9uYCByZS1yZWFkcyB0aGUgcG9ydCBmaWxlIGFuZCByZXNwYXducywgc28gYSByZWNvbm5lY3QgYWZ0ZXIgYVxuICAgIC8vIHJvbGwgbGFuZHMgb24gdGhlIE5FVyBkYWVtb24gcmF0aGVyIHRoYW4gc3Bpbm5pbmcgYWdhaW5zdCBhIGRlYWQgcG9ydC5cbiAgICByZXNvbHZlOiBhc3luYyAoKSA9PiBgaHR0cDovLzEyNy4wLjAuMToke2F3YWl0IGVuc3VyZURhZW1vbigpfWAsXG4gICAgcGF0aDogYC9jaGFubmVscy8ke25hbWV9L3RhaWxgLFxuICAgIHNpbmNlLFxuICAgIC8vIOKaoCBOTyBlbnN1cmUgY2FsbCBiZWZvcmUgdGhlIHN1YnNjcmliZS4gQSBmcmVzaCBgdGFpbCBuYW1lYCBzdGlsbCB3b3Jrc1xuICAgIC8vIHdpdGhvdXQgYW4gZXhwbGljaXQgb3BlbiDigJQgR0VUIOKApi90YWlsIGNyZWF0ZXMgdGhlIGNoYW5uZWwgaXRzZWxmIOKAlCBhbmRcbiAgICAvLyB0aGF0IGlzIHRoZSBPTkxZIHdheSB0aGUgc3Vic2NyaWJlZCBldmVudCdzIGBjcmVhdGVkYCBmbGFnIGNhbiBldmVyIGJlXG4gICAgLy8gdHJ1ZTogYW4gZW5zdXJlIHNlbnQgZmlyc3QgY3JlYXRlcyB0aGUgY2hhbm5lbCwgc28gdGhlIHN1YnNjcmliZSB0aGF0XG4gICAgLy8gZm9sbG93cyBhbHdheXMgcmVwb3J0cyBgY3JlYXRlZDpmYWxzZWAgYW5kIHRoZSBtaXN0eXBlZC1uYW1lIHNpZ25hbCBuZXZlclxuICAgIC8vIGZpcmVzLlxuICAgIHF1ZXJ5OiAoY3Vyc29yLCBmaXJzdENvbm5lY3QpID0+IHtcbiAgICAgIGNvbnN0IHE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgLy8gIzY4IOKAlCBgLS1sYXN0IE5gIHJpZGVzIHRoZSBGSVJTVCBjb25uZWN0aW9uIG9ubHkuIE9uY2UgYW55IG1lc3NhZ2VcbiAgICAgIC8vIGxhbmRzIHRoZSBjdXJzb3IgYWR2YW5jZXMgYW5kIGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSBpdCB2aWEgYHNpbmNlYCxcbiAgICAgIC8vIG5ldmVyIHJlLWJhY2tmaWxsaW5nIHRoZSB3aW5kb3cuIGBmaXJzdENvbm5lY3RgIGlzIHRoZSBraXQncyBwYXJhbWV0ZXJcbiAgICAgIC8vIGZvciBleGFjdGx5IHRoaXM7IHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCBzcGVsbGVkIGl0IGBoaWdoZXN0U2VlbiA8IDBgLFxuICAgICAgLy8gd2hpY2ggd2FzIHRoZSBzYW1lIHRlc3QgYnkgYWNjaWRlbnQgb2YgdGhlIHNlbnRpbmVsLlxuICAgICAgaWYgKG9wdHMubGFzdCAhPT0gdW5kZWZpbmVkICYmIGZpcnN0Q29ubmVjdCkgcS5sYXN0ID0gU3RyaW5nKG9wdHMubGFzdCk7XG4gICAgICBpZiAobXlBbGlhcykgcS5hcyA9IG15QWxpYXM7XG4gICAgICBpZiAob3B0cy5odW1hbiAmJiAhb3B0cy5sdXJrKSBxLmh1bWFuID0gXCIxXCI7XG4gICAgICBpZiAob3B0cy5sdXJrKSBxLmx1cmsgPSBcIjFcIjtcbiAgICAgIHJldHVybiBxO1xuICAgIH0sXG4gICAgY3Vyc29yT2Y6IChldikgPT4gKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiA/IGV2LmlkIDogdW5kZWZpbmVkKSxcbiAgICBhY2NlcHQ6IChldiwgZnJhbWUpID0+IHtcbiAgICAgIC8vIFRoZSBzdWJzY3JpYmVkIG1hcmtlciBpcyBub3QgYSBtZXNzYWdlOyBgcmVuZGVyYCBhbnN3ZXJzIGl0LlxuICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHRydWU7XG4gICAgICAvLyBEcm9wIERJU1BPU0lUSU9OIGZyYW1lcyDigJQgdGhleSBhcmUgbWV0YWRhdGEgYWJvdXQgYW5vdGhlciBtZXNzYWdlLiBBXG4gICAgICAvLyBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSBwYXNzZXMgdGhyb3VnaDogYW4gYWdlbnQgdGFpbGluZyBhXG4gICAgICAvLyBjaGFubmVsIGNvdWxkIG5vdCBwcmV2aW91c2x5IHNlZSBlaXRoZXIgcGFydHkgcmV0aXJlIGl0LCBhbmQgZm91bmQgb3V0XG4gICAgICAvLyB3aGVuIGl0cyBuZXh0IHNlbmQgd2FzIHJlamVjdGVkLlxuICAgICAgaWYgKGlzRGlzcG9zaXRpb25GcmFtZShldikpIHJldHVybiBmYWxzZTtcbiAgICAgIC8vIFN1cHByZXNzIHNlbGYtZWNobzogd2hlbiAtLWFzIGlzIHNldCwgZHJvcCBtZXNzYWdlcyB3ZSBzZW50IG91cnNlbHZlcy5cbiAgICAgIC8vIFRoZSBzZW5kZXIgYWxyZWFkeSBnb3QgdGhlIHJlY2VpcHQgYXMgdGhlIFBPU1QgcmVzcG9uc2UsIHNvIHJlLWVtaXR0aW5nXG4gICAgICAvLyBpdCBvbiB0YWlsIGlzIHB1cmUgbm9pc2UuXG4gICAgICBpZiAobXlBbGlhcyAmJiBldi5mcm9tID09PSBteUFsaWFzKSByZXR1cm4gZmFsc2U7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIHJlbmRlcjogKHBheWxvYWQsIGZyYW1lKSA9PiB7XG4gICAgICBpZiAoZnJhbWUuZXZlbnQgPT09IFwic3Vic2NyaWJlZFwiKSByZXR1cm4gcmVuZGVyU3Vic2NyaWJlZChwYXlsb2FkKTtcbiAgICAgIC8vICM2NyDigJQgZnJvbnQtbG9hZCBhIHJlY292ZXJ5IHBvaW50ZXIgb24gRVZFUlkgbWVzc2FnZSBmcmFtZSwgc28gdGhlIHJlYWRcbiAgICAgIC8vIGNvb3JkaW5hdGVzIHN1cnZpdmUgYSBkb3duc3RyZWFtIG5vdGlmaWNhdGlvbiBjbGlwLiBNb25pdG9yIHRydW5jYXRlcyBhdFxuICAgICAgLy8gaXRzIE9XTiBjYXAgKGJlbG93IG91ciBoaW50IHRocmVzaG9sZCwgYW5kIG9uZSB3ZSBjYW5ub3Qgb2JzZXJ2ZSBoZXJlKTsgYVxuICAgICAgLy8gbWVzc2FnZSBpdCBjbGlwcyB3b3VsZCBvdGhlcndpc2UgbG9zZSBpdHMgdHJhaWxpbmcgYGlkYCBhbmQgYmVjb21lXG4gICAgICAvLyB1bnJlY292ZXJhYmxlIOKAlCB0aGUgcmVhZGVyIGlzIGxlZnQgaW5mZXJyaW5nIHRoZSBpZC4gRXZlcnkgZnJhbWVcbiAgICAgIC8vIHRoZXJlZm9yZSBjYXJyaWVzIGEgRlJPTlQtbG9hZGVkIGByZWFkIDxjaGFubmVsPiA8aWQ+YCwgZWl0aGVyIGFzIHRoZVxuICAgICAgLy8gcmljaGVyIGB0cnVuY2F0aW9uX2hpbnRgIChnZW51aW5lbHktbG9uZyBtZXNzYWdlcyDigJQgdGhlIFwiK04gY2hhcnMsXG4gICAgICAvLyB5b3UncmUgZGVmaW5pdGVseSBtaXNzaW5nIGNvbnRlbnRcIiBhbGFybSkgb3IgYXMgdGhlIGNvbXBhY3QgYGZ1bGxgXG4gICAgICAvLyBwb2ludGVyLiBTZXJpYWxpemluZyBpdCBiZWZvcmUgdGhlIGxvbmcgYC50ZXh0YCBpcyB3aGF0IG1ha2VzIGl0IHN1cnZpdmVcbiAgICAgIC8vIHRoZSBjbGlwIChGMTcpLlxuICAgICAgY29uc3QgcmVhZFJlZiA9IGByZWFkICR7bmFtZX0gJHtwYXlsb2FkLmlkfWA7XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiBwYXlsb2FkLnRleHQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgcGF5bG9hZC50ZXh0Lmxlbmd0aCA+IChvcHRzLm1heCA/PyBUUlVOQ0FUSU9OX0hJTlRfVEhSRVNIT0xEKVxuICAgICAgKSB7XG4gICAgICAgIGNvbnN0IHRydW5jYXRpb25faGludCA9IGArJHtwYXlsb2FkLnRleHQubGVuZ3RofSBjaGFycyDigJQgZnVsbDogJHtyZWFkUmVmfWA7XG4gICAgICAgIC8vIENhcCB0aGUgSU5MSU5FIGJvZHkgd2hlbiAtLW1heCBpcyBzZXQgKHRoZSBmdWxsIG1lc3NhZ2Ugc3RheXMgb24gZGlza1xuICAgICAgICAvLyDihpIgYHJlYWRgKTsgd2l0aG91dCAtLW1heCwgZW1pdCB0aGUgZnVsbCB0ZXh0ICh0b2RheSdzIGRlZmF1bHQpLlxuICAgICAgICBjb25zdCB0ZXh0ID0gb3B0cy5tYXggIT09IHVuZGVmaW5lZCA/IHBheWxvYWQudGV4dC5zbGljZSgwLCBvcHRzLm1heCkgOiBwYXlsb2FkLnRleHQ7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHRydW5jYXRpb25faGludCwgLi4ucGF5bG9hZCwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IGZ1bGw6IHJlYWRSZWYsIC4uLnBheWxvYWQgfSk7XG4gICAgfSxcbiAgICAvLyBEYWVtb24gbGl2ZW5lc3MgaGVhcnRiZWF0IChgOiBoYiA8dHM+YCkuIFN1cmZhY2UgYSByZWNvZ25pemFibGUgc2VudGluZWxcbiAgICAvLyBvbiBzdGRlcnIgc28gYSBgMj4mMWAgY29uc3VtZXIgY2FuIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIChGNikuIEtlcHRcbiAgICAvLyBvZmYgc3Rkb3V0IOKAlCB0aGUgSlNPTkwgc3RyZWFtIHN0YXlzIHB1cmUuXG4gICAgb25Db21tZW50OiAodGV4dCkgPT4gKHRleHQudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcImhiXCIpID8gXCI6IGdyYXBldmluZS1rZWVwYWxpdmVcIiA6IG51bGwpLFxuICAgIG9uTWFsZm9ybWVkOiAoX2ZyYW1lLCBlKSA9PiBgIyBiYWQgc3NlIGRhdGE6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgLy8gVGhlIGZvdXIgbGluZXMgdGhlIGhhbmQtd3JpdHRlbiBsb29wIHdyb3RlLCBwcmVzZXJ2ZWQgdmVyYmF0aW0g4oCUIGEgdGFpbFxuICAgIC8vIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gb25lIHRoYXQgaXMgd29ya2luZy5cbiAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICBzd2l0Y2ggKGluZm8uY2F1c2UpIHtcbiAgICAgICAgY2FzZSBcImNvbm5lY3QtZmFpbGVkXCI6XG4gICAgICAgICAgcmV0dXJuIGAjIGNvbm5lY3QgZmFpbGVkOiAke2luZm8uZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGluZm8uZXJyb3IubWVzc2FnZSA6IFN0cmluZyhpbmZvLmVycm9yKX0sIHJldHJ5aW5n4oCmYDtcbiAgICAgICAgY2FzZSBcImh0dHBcIjpcbiAgICAgICAgY2FzZSBcIm5vLWJvZHlcIjpcbiAgICAgICAgICByZXR1cm4gYCMgdGFpbCBIVFRQICR7aW5mby5zdGF0dXN9LCByZXRyeWluZ+KApmA7XG4gICAgICAgIGNhc2UgXCJzdHJlYW0tZXJyb3JcIjpcbiAgICAgICAgICByZXR1cm4gYCMgc3RyZWFtIGRyb3BwZWQ6ICR7aW5mby5lcnJvciBpbnN0YW5jZW9mIEVycm9yID8gaW5mby5lcnJvci5tZXNzYWdlIDogU3RyaW5nKGluZm8uZXJyb3IpfSwgcmVjb25uZWN0aW5n4oCmYDtcbiAgICAgICAgY2FzZSBcInN0cmVhbS1lbmRcIjpcbiAgICAgICAgICByZXR1cm4gXCIjIHN0cmVhbSBjbG9zZWQsIHJlY29ubmVjdGluZ+KAplwiO1xuICAgICAgfVxuICAgIH0sXG4gICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gIH0pO1xuXG4gIC8qKiBUaGUgYHN1YnNjcmliZWRgIG1hcmtlcjogc3RkZXJyIGNvbnRleHQsIHBsdXMgYSBzdHJ1Y3R1cmVkIGdyb3VuZGluZyBsaW5lXG4gICAqICBvbiBzdGRvdXQgdGhlIEZJUlNUIHRpbWUgb25seS4gKi9cbiAgZnVuY3Rpb24gcmVuZGVyU3Vic2NyaWJlZChwYXlsb2FkOiBUYWlsUGF5bG9hZCk6IHN0cmluZyB8IG51bGwge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHN1YnNjcmliZWQgdG8gJHtwYXlsb2FkLmNoYW5uZWx9IChzaW5jZT0ke3BheWxvYWQuc2luY2V9KVxcbmApO1xuICAgIGlmIChwYXlsb2FkLnRvcGljKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB0b3BpYzogJHtwYXlsb2FkLnRvcGljfVxcbmApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIHRoaXMgdGFpbCBicm91Z2h0IGl0IGludG8gYmVpbmcgKGNoZWNrIHRoZSBuYW1lKVxcbmAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjICR7cGF5bG9hZC5jaGFubmVsfSBpcyBhcmNoaXZlZCDigJQgcmVhZC1vbmx5OyBhIHNlbmQgd2lsbCBiZSByZWplY3RlZFxcbmAsXG4gICAgICApO1xuICAgIC8vIFN0cnVjdHVyZWQgZ3JvdW5kaW5nIG9uIHN0ZG91dCAoRjMvRjcpIOKAlCB1bmRlciB0aGUgZGVmYXVsdCBXaXJpbmctQlxuICAgIC8vIE1vbml0b3IsIHN0ZG91dCBzdXJmYWNlcyBhcyBub3RpZmljYXRpb25zLCBzbyBhIGZyZXNoIHN1YnNjcmliZXIgYWN0dWFsbHlcbiAgICAvLyBzZWVzIHRoZSB0b3BpYyArIHRoYXQgZWFybGllciBoaXN0b3J5IGV4aXN0cy4gR2F0ZWQ6IG9ubHkgd2hlbiB0aGVyZSdzXG4gICAgLy8gc29tZXRoaW5nIHRvIGdyb3VuZCAodW5zZWVuIGhpc3Rvcnkgb3IgYSB0b3BpYyksIGFuZCBvbmx5IG9uIHRoZSBmaXJzdFxuICAgIC8vIHN1YnNjcmliZSAobm90IHJlY29ubmVjdHMpLlxuICAgIGlmIChncm91bmRlZCkgcmV0dXJuIG51bGw7XG4gICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgIGNvbnN0IGxhdGVzdCA9IHR5cGVvZiBwYXlsb2FkLmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIiA/IHBheWxvYWQubGF0ZXN0X2lkIDogMDtcbiAgICBjb25zdCBlYXJsaWVyID0gc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5tYXgoMCwgTWF0aC5taW4oc2luY2UsIGxhdGVzdCkpO1xuICAgIC8vIGBjcmVhdGVkYCBhbmQgYGFyY2hpdmVkYCBqb2luIHRoZSBnYXRlIG9uIHB1cnBvc2UuIEEgY2hhbm5lbCB0aGlzXG4gICAgLy8gc3Vic2NyaWJlIGp1c3QgbWFkZSBoYXMgbm8gdG9waWMgYW5kIG5vIGhpc3RvcnksIHNvIHRoZSBvbGQgY29uZGl0aW9uXG4gICAgLy8gKGBlYXJsaWVyID4gMCB8fCB0b3BpY2ApIGlzIGV4YWN0bHkgdGhlIGNhc2UgdGhhdCBlbWl0cyBOT1RISU5HOyBhbmQgYW5cbiAgICAvLyBBUkNISVZFRCBjaGFubmVsJ3MgZ3JvdW5kaW5nIGxpbmUgd2FzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBoZWFsdGh5XG4gICAgLy8gb25lJ3MsIHNvIGEgbGF0ZSBqb2luZXIgc3RpbGwgbGVhcm5lZCB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZCBvbmx5IHdoZW5cbiAgICAvLyBpdHMgc2VuZCBib3VuY2VkLlxuICAgIC8vXG4gICAgLy8g4pqgIFRoZSBoaW50cyBBQ0NVTVVMQVRFIGludG8gYSBsaXN0IHJhdGhlciB0aGFuIGFzc2lnbmluZyB0byBvbmUgZmllbGQuXG4gICAgLy8gVGhleSB1c2VkIHRvIGJlIHRocmVlIGFzc2lnbm1lbnRzIHRvIGBncm91bmRpbmcuaGludGAsIG9yZGVyZWQgc28gdGhlIG1vc3RcbiAgICAvLyBpbXBvcnRhbnQgd29uIOKAlCB3aGljaCBpcyBhIGhpbnQgdGhhdCBjYW4gc2lsZW50bHkgbG9zZSB0byBhbm90aGVyIGhpbnQsXG4gICAgLy8gdGhlIGZhaWx1cmUgbW9kZSB0aGlzIHdob2xlIGJyYW5jaCBpcyBhYm91dCwgc2l0dGluZyBpbiB0aGUgZml4IGZvciBpdC4gQVxuICAgIC8vIGxpc3QgY2Fubm90IG92ZXJ3cml0ZTogYW4gYXJjaGl2ZWQgY2hhbm5lbCBXSVRIIGhpc3Rvcnkgbm93IHNheXMgYm90aC5cbiAgICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoZWFybGllciA+IDApXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtlYXJsaWVyfSBlYXJsaWVyIG1lc3NhZ2UocykgZXhpc3Qg4oCUIHVzZSAtLWZyb20tc3RhcnQgb3IgLS1zaW5jZSA8aWQ+IHRvIGJhY2tmaWxsYCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGB0aGlzIHRhaWwgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIG5vIHN1Y2ggY2hhbm5lbCBleGlzdGVkOyBjaGVjayB0aGUgbmFtZSwgb3IgYW5vdGhlciBwYXJ0eSBoYXMgeWV0IHRvIG9wZW4gaXRgLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWQgdW50aWwgc29tZW9uZSB1bmFyY2hpdmVzIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKCEoZWFybGllciA+IDAgfHwgcGF5bG9hZC50b3BpYyB8fCBwYXlsb2FkLmNyZWF0ZWQgfHwgcGF5bG9hZC5hcmNoaXZlZCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGdyb3VuZGluZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICBraW5kOiBcImdyb3VuZGluZ1wiLFxuICAgICAgY2hhbm5lbDogcGF5bG9hZC5jaGFubmVsLFxuICAgICAgam9pbmVkX2F0OiBzaW5jZSA8IDAgPyBsYXRlc3QgOiBNYXRoLm1pbihzaW5jZSwgbGF0ZXN0KSxcbiAgICAgIGVhcmxpZXIsXG4gICAgfTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgZ3JvdW5kaW5nLnRvcGljID0gcGF5bG9hZC50b3BpYztcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKSBncm91bmRpbmcuY3JlYXRlZCA9IHRydWU7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpIGdyb3VuZGluZy5hcmNoaXZlZCA9IHRydWU7XG4gICAgaWYgKGhpbnRzLmxlbmd0aCkgZ3JvdW5kaW5nLmhpbnQgPSBoaW50cy5qb2luKFwiIMK3IFwiKTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZ3JvdW5kaW5nKTtcbiAgfVxufVxuZnVuY3Rpb24gZm9sZERpc3Bvc2l0aW9ucyhuYW1lOiBzdHJpbmcpIHtcbiAgY29uc3QgbWFwID0gbmV3IE1hcDxcbiAgICBudW1iZXIsXG4gICAge1xuICAgICAgZGlzcG9zaXRpb246IHN0cmluZztcbiAgICAgIGZyb206IHN0cmluZztcbiAgICAgIHRzOiBudW1iZXI7XG4gICAgICBub3RlOiBzdHJpbmc7XG4gICAgICByZW9wZW5zOiBudW1iZXI7XG4gICAgfVxuICA+KCk7XG4gIGNvbnN0IHBhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhwYXRoKSkgcmV0dXJuIG1hcDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCAhPT0gXCJzdGF0dXNcIiB8fCB0eXBlb2YgbS50YXJnZXQgIT09IFwibnVtYmVyXCIgfHwgdHlwZW9mIG0uZGlzcG9zaXRpb24gIT09IFwic3RyaW5nXCIpXG4gICAgICBjb250aW51ZTtcbiAgICBjb25zdCBwcmV2ID0gbWFwLmdldChtLnRhcmdldCk7XG4gICAgY29uc3QgcmVvcGVucyA9XG4gICAgICAocHJldj8ucmVvcGVucyA/PyAwKSArXG4gICAgICAobS5kaXNwb3NpdGlvbiA9PT0gXCJvcGVuXCIgJiYgcHJldiAmJiBwcmV2LmRpc3Bvc2l0aW9uICE9PSBcIm9wZW5cIiA/IDEgOiAwKTtcbiAgICBtYXAuc2V0KG0udGFyZ2V0LCB7XG4gICAgICBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbixcbiAgICAgIGZyb206IG0uZnJvbSxcbiAgICAgIHRzOiBtLnRzLFxuICAgICAgbm90ZTogbS50ZXh0LFxuICAgICAgcmVvcGVucyxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gbWFwO1xufVxuLy8gVFdPIHRoaW5ncyBub3cgd2VhciBraW5kOlwic3RhdHVzXCIuIEEgRElTUE9TSVRJT04gZnJhbWUgYWN0cyBvbiBhIHNwZWNpZmljXG4vLyBtZXNzYWdlIChgdGFyZ2V0YCArIGBkaXNwb3NpdGlvbmApIGFuZCBpcyBtZXRhZGF0YSDigJQgYHB1bGxgIGFuZCBgdGFpbGAgZm9sZFxuLy8gaXQgYXdheSBhbmQgYmFkZ2UgdGhlIG1lc3NhZ2UgaXQgcG9pbnRzIGF0IGluc3RlYWQuIEEgTElGRUNZQ0xFIGZyYW1lXG4vLyAoYXJjaGl2ZSAvIHVuYXJjaGl2ZSkgaXMgYSBmYWN0IGFib3V0IHRoZSBDSEFOTkVMOiBpdCB0YXJnZXRzIG5vdGhpbmcsIGFuZCBpdFxuLy8gaXMgdGhlIHdob2xlIHBvaW50IHRoYXQgYSByZWFkZXIgc2VlcyBpdC4gRGlzY3JpbWluYXRpbmcgb24gYGRpc3Bvc2l0aW9uYFxuLy8gcmF0aGVyIHRoYW4gb24gYGV2ZW50YCBrZWVwcyBhIGZyYW1lIGZyb20gc29tZSBmdXR1cmUgZW1pdHRlciB2aXNpYmxlIGJ5XG4vLyBkZWZhdWx0IOKAlCB0aGUgZmFpbHVyZSBtb2RlIGhlcmUgaXMgc3dhbGxvd2luZyBhIHNpZ25hbCwgbm90IHNob3dpbmcgb25lLlxuZnVuY3Rpb24gaXNEaXNwb3NpdGlvbkZyYW1lKG06IHsga2luZD86IHN0cmluZzsgZGlzcG9zaXRpb24/OiBzdHJpbmcgfSk6IGJvb2xlYW4ge1xuICByZXR1cm4gbS5raW5kID09PSBcInN0YXR1c1wiICYmIHR5cGVvZiBtLmRpc3Bvc2l0aW9uID09PSBcInN0cmluZ1wiO1xufVxuXG4vLyBcIm9wZW5cIiA9IG5vIGVudHJ5LCBvciBsYXRlc3QgZGlzcG9zaXRpb24gaXMgXCJvcGVuXCJcbmZ1bmN0aW9uIGlzT3BlbihkPzogeyBkaXNwb3NpdGlvbjogc3RyaW5nIH0pIHtcbiAgcmV0dXJuICFkIHx8IGQuZGlzcG9zaXRpb24gPT09IFwib3BlblwiO1xufVxuXG4vLyBSZWFkcyB0aGUgZnVsbCBjaGFubmVsIGxvZywgZHJvcHMgRVZFUlkga2luZDpcInN0YXR1c1wiIGZyYW1lLCBhbmQgYmFkZ2VzIGVhY2hcbi8vIHJlbWFpbmluZyBtZXNzYWdlIHdpdGggaXRzIGxhdGVzdCBkaXNwb3NpdGlvbiB2aWEgZm9sZERpc3Bvc2l0aW9ucy5cbi8vXG4vLyBFdmVyeSBvbmUsIGRlbGliZXJhdGVseSDigJQgaW5jbHVkaW5nIGEgbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSksXG4vLyB3aGljaCBgcHVsbGAgYW5kIGB0YWlsYCBkbyBsZXQgdGhyb3VnaC4gVGhpcyBmZWVkcyBgdHJpYWdlYCwgd2hvc2Ugb3BlbiBxdWV1ZVxuLy8gaXMgXCJ3aGF0IGlzIGxlZnQgdG8gYWN0IG9uXCIsIGFuZCBhbiBhcmNoaXZlIGlzIGFuIEZZSSwgbm90IGEgd29yayBpdGVtLiBTYW1lXG4vLyByZWFzb24gYHRvcGljYCBhbmQgYGFubm91bmNlbWVudGAgYXJlIGZvbGRlZCBvdXQgb2YgdGhlIG9wZW4gYnVja2V0IGJlbG93LlxuZnVuY3Rpb24gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChcbiAgbmFtZTogc3RyaW5nLFxuKTogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10ge1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHJldHVybiBbXTtcbiAgY29uc3QgZGlzcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IG1lc3NhZ2VzOiAoTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfSlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIikuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgbTogTWVzc2FnZTtcbiAgICB0cnkge1xuICAgICAgbSA9IEpTT04ucGFyc2UobGluZSkgYXMgTWVzc2FnZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobS5raW5kID09PSBcInN0YXR1c1wiKSBjb250aW51ZTtcbiAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgaWYgKGQpIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2goeyAuLi5tLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWVzc2FnZXM7XG59XG5cbnR5cGUgQmFkZ2VkTWVzc2FnZSA9IE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH07XG5cbi8vIERhc2hib2FyZCByZW5kZXIgb2YgYSB0cmlhZ2Ugc2NhbjogdGhlIG9wZW4gcXVldWUgb24gdG9wLCB0aGVuIGVhY2hcbi8vIGRpc3Bvc2l0aW9uIGdyb3VwLCBvbmUgc2Nhbm5hYmxlIGxpbmUgcGVyIG1lc3NhZ2UuIE1pcnJvcnMgYHJlYWQgLS10ZXh0YFxuLy8gcHJvc2UgbW9kZSBzbyBhIGh1bWFuIChvciBhbiBhZ2VudCkgcmVhZHMgaXQgd2l0aG91dCBwYXJzaW5nIEpTT04uXG5mdW5jdGlvbiByZW5kZXJUcmlhZ2VIdW1hbihcbiAgbmFtZTogc3RyaW5nLFxuICBvcGVuOiBCYWRnZWRNZXNzYWdlW10sXG4gIGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmUgPSAobTogQmFkZ2VkTWVzc2FnZSkgPT4ge1xuICAgIGNvbnN0IHRzID0gbmV3IERhdGUobS50cykudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxNikucmVwbGFjZShcIlRcIiwgXCIgXCIpO1xuICAgIGNvbnN0IHJlb3BlbiA9IG0ucmVvcGVucyAmJiBtLnJlb3BlbnMgPiAwID8gYCDihrske20ucmVvcGVuc31gIDogXCJcIjtcbiAgICBjb25zdCBoZWFkID0gbS50ZXh0LnNwbGl0KFwiXFxuXCIpWzBdO1xuICAgIGNvbnN0IHByZXZpZXcgPSBoZWFkLmxlbmd0aCA+IDEwMCA/IGAke2hlYWQuc2xpY2UoMCwgOTkpfeKApmAgOiBoZWFkO1xuICAgIHJldHVybiBgICBbJHttLmlkfSR7cmVvcGVufV0gJHttLmZyb219IMK3ICR7dHN9IMK3ICR7cHJldmlld31gO1xuICB9O1xuICBjb25zdCBzZWN0aW9ucyA9IFtgJHtuYW1lfSDCtyB0cmlhZ2VcXG5gLCBgT1BFTiAoJHtvcGVuLmxlbmd0aH0pYF07XG4gIHNlY3Rpb25zLnB1c2gob3Blbi5sZW5ndGggPyBvcGVuLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpIDogXCIgIOKAlFwiKTtcbiAgZm9yIChjb25zdCBbc3RhdHVzLCBpdGVtc10gb2YgT2JqZWN0LmVudHJpZXMoYnlfc3RhdHVzKSkge1xuICAgIHNlY3Rpb25zLnB1c2goYFxcbiR7c3RhdHVzLnRvVXBwZXJDYXNlKCl9ICgke2l0ZW1zLmxlbmd0aH0pYCwgaXRlbXMubWFwKGxpbmUpLmpvaW4oXCJcXG5cIikpO1xuICB9XG4gIHJldHVybiBgJHtzZWN0aW9ucy5qb2luKFwiXFxuXCIpfVxcbmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRyaWFnZShuYW1lOiBzdHJpbmcsIG9wdHM6IHsgaHVtYW4/OiBib29sZWFuIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgdHJpYWdlIDxjaGFubmVsPiBbLS1odW1hbl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gdHJpYWdlIHJlYWRzIHRoZSBsb2cgZmlsZSwgbm90IGEgcm91dGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93biDigJQgYW5kXG4gIC8vIGFuIGVtcHR5IGRhc2hib2FyZCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QgaXMgdGhlIHNhbWUgc2lsZW50IGxpZVxuICAvLyBhcyBhbiBlbXB0eSBgcHVsbGAuXG4gIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICBjb25zdCBvcGVuOiBCYWRnZWRNZXNzYWdlW10gPSBbXTtcbiAgY29uc3QgYnlfc3RhdHVzOiBSZWNvcmQ8c3RyaW5nLCBCYWRnZWRNZXNzYWdlW10+ID0ge307XG4gIGZvciAoY29uc3QgbSBvZiBiYWRnZWQpIHtcbiAgICAvLyBpc09wZW4gZXhwZWN0cyBhIGRpc3Bvc2l0aW9uIGVudHJ5IG9iamVjdCAob3IgdW5kZWZpbmVkIGZvciBubyBlbnRyeSkuXG4gICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICBpZiAoaXNPcGVuKGRpc3BBcmcpKSB7XG4gICAgICAvLyBUaGUgb3BlbiBxdWV1ZSBpcyBzaWduYWwtb25seTogc2tpcCBub24tYWN0aW9uYWJsZSBmcmFtZXMgKHRvcGljL1xuICAgICAgLy8gYW5ub3VuY2VtZW50IEZZSXMgY2FuIG5ldmVyIGNhcnJ5IGEgZGlzcG9zaXRpb24sIHNvIHRoZXknZCBvdGhlcndpc2VcbiAgICAgIC8vIHBhZCBcIndoYXQncyBsZWZ0P1wiIGZvcmV2ZXIpLlxuICAgICAgaWYgKG0ua2luZCA9PT0gXCJtZXNzYWdlXCIpIG9wZW4ucHVzaChtKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qga2V5ID0gbS5kaXNwb3NpdGlvbiA/PyBcInVua25vd25cIjtcbiAgICAgIGlmICghYnlfc3RhdHVzW2tleV0pIGJ5X3N0YXR1c1trZXldID0gW107XG4gICAgICBieV9zdGF0dXNba2V5XS5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICBpZiAob3B0cy5odW1hbikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHJlbmRlclRyaWFnZUh1bWFuKG5hbWUsIG9wZW4sIGJ5X3N0YXR1cykpO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgb3BlbiwgYnlfc3RhdHVzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRHcmVwKG5hbWU6IHN0cmluZywgcGF0dGVybjogc3RyaW5nLCBvcHRzOiB7IGxpdGVyYWw/OiBib29sZWFuOyBmcm9tPzogc3RyaW5nIH0pIHtcbiAgaWYgKCFuYW1lIHx8ICFwYXR0ZXJuKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgZ3JlcCA8Y2hhbm5lbD4gPHBhdHRlcm4+IFstLWxpdGVyYWx8LUZdIFstLWZyb20gPGFsaWFzPl1cIik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhsb2dQYXRoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCBtYXRjaGVyOiAodGV4dDogc3RyaW5nKSA9PiBib29sZWFuO1xuICBpZiAob3B0cy5saXRlcmFsKSB7XG4gICAgY29uc3QgbmVlZGxlID0gcGF0dGVybi50b0xvd2VyQ2FzZSgpO1xuICAgIG1hdGNoZXIgPSAodGV4dCkgPT4gdGV4dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5lZWRsZSk7XG4gIH0gZWxzZSB7XG4gICAgbGV0IHJlOiBSZWdFeHA7XG4gICAgdHJ5IHtcbiAgICAgIHJlID0gbmV3IFJlZ0V4cChwYXR0ZXJuLCBcImlcIik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGllKGBpbnZhbGlkIHJlZ2V4OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gLCBcInVzYWdlXCIpO1xuICAgIH1cbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHJlLnRlc3QodGV4dCk7XG4gIH1cbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IG1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJhdy5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZSkgY29udGludWU7XG4gICAgbGV0IG1zZzogUGFydGlhbDxNZXNzYWdlPjtcbiAgICB0cnkge1xuICAgICAgbXNnID0gSlNPTi5wYXJzZShsaW5lKSBhcyBQYXJ0aWFsPE1lc3NhZ2U+O1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgbXNnLnRleHQgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuICAgIGlmIChvcHRzLmZyb20gJiYgbXNnLmZyb20gIT09IG9wdHMuZnJvbSkgY29udGludWU7XG4gICAgaWYgKCFtYXRjaGVyKG1zZy50ZXh0KSkgY29udGludWU7XG4gICAgbWVzc2FnZXMucHVzaChtc2cpO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlcyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQ2xvc2UobmFtZTogc3RyaW5nKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBjbG9zZSA8bmFtZT5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIGRpZShcIm5vIGRhZW1vbiBydW5uaW5nXCIsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihwb3J0LCBcIkRFTEVURVwiLCBgL2NoYW5uZWxzLyR7bmFtZX1gKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzZXQobmFtZTogc3RyaW5nLCBvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+ID0ge307XG4gIGlmIChvcHRzLmZvcmNlKSBib2R5LmZvcmNlID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBzdWJzY3JpYmVycz86IG51bWJlciB9PihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9yZXNldGAsXG4gICAgYm9keSxcbiAgKTtcbiAgaWYgKHN0YXR1cyA9PT0gNDA5ICYmIGRhdGE/LmVycm9yID09PSBcImxpdmVcIikge1xuICAgIGRpZShcbiAgICAgIGBjaGFubmVsIGhhcyAke2RhdGEuc3Vic2NyaWJlcnN9IGxpdmUgc3Vic2NyaWJlcihzKSDigJQgcmVmdXNpbmcgdG8gY2xlYXIgYSBsaXZlIHNlc3Npb24uIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gY2xlYXIgYW55d2F5ICh0aGUgbG9nIGlzIHNuYXBzaG90dGVkIGZpcnN0KS5gLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gQXJjaGl2ZSAocmVhZC1vbmx5KSBvciB1bmFyY2hpdmUgYSBjaGFubmVsIChWMS43KSDigJQgdGhlIG5vbi1kZXN0cnVjdGl2ZVxuLy8gYWx0ZXJuYXRpdmUgdG8gY2xvc2U6IGhpc3RvcnkgaXMgcHJlc2VydmVkLCBzZW5kcyBhcmUgcmVqZWN0ZWQsIGFuZCB0aGUgbmFtZVxuLy8gaXMgbG9ja2VkIGZyb20gcmUtb3BlbiB1bnRpbCB1bmFyY2hpdmVkLlxuYXN5bmMgZnVuY3Rpb24gY21kTWFyayhcbiAgbmFtZTogc3RyaW5nLFxuICBpZDogbnVtYmVyLFxuICBkaXNwb3NpdGlvbjogc3RyaW5nLFxuICBmcm9tOiBzdHJpbmcsXG4gIG9wdHM6IHsgbm90ZT86IHN0cmluZyB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGlkKSB8fCAhZGlzcG9zaXRpb24pXG4gICAgZGllKFwidXNhZ2U6IGdyYXBldmluZSBtYXJrIDxjaGFubmVsPiA8aWQ+IDxkaXNwb3NpdGlvbj4gWy0tbm90ZSA8dGV4dD5dIFstLWFzIDxhbGlhcz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBmcm9tLCB0YXJnZXQ6IGlkLCBkaXNwb3NpdGlvbiB9O1xuICBpZiAob3B0cy5ub3RlICE9PSB1bmRlZmluZWQpIGJvZHkubm90ZSA9IG9wdHMubm90ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlPihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L3N0YXR1c2AsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllQXBpKGRhdGEgYXMgeyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9IHwgbnVsbCwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBcmNoaXZlKG5hbWU6IHN0cmluZywgdW5hcmNoaXZlOiBib29sZWFuLCBmcm9tPzogc3RyaW5nKSB7XG4gIGNvbnN0IHZlcmIgPSB1bmFyY2hpdmUgPyBcInVuYXJjaGl2ZVwiIDogXCJhcmNoaXZlXCI7XG4gIGlmICghbmFtZSkgZGllKGB1c2FnZTogZ3JhcGV2aW5lICR7dmVyYn0gPGNoYW5uZWw+YCk7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQm90aCByb3V0ZXMgYXBwZW5kIGEga2luZDpcInN0YXR1c1wiIGZyYW1lIHRvIHRoZSBsb2csIHNvIHdobyBkaWQgaXQgaXMgd29ydGhcbiAgLy8gcmVjb3JkaW5nIHdoZW4gdGhlIGNhbGxlciB0b2xkIHVzLiBJZGVudGl0eSBpcyBvcHRpb25hbCBoZXJlIChpdCBpcyBvbiB0aGVcbiAgLy8gZ2xvYmFsbHktYWNjZXB0ZWQgLS1hcy8tLWZyb20pLCBhbmQgdGhlIGRhZW1vbiBzaWducyBcInN5c3RlbVwiIHdpdGhvdXQgaXQuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJQT1NUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9LyR7dmVyYn1gLFxuICAgIGZyb20gPyB7IGZyb20gfSA6IHVuZGVmaW5lZCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RvcChvcHRzOiB7IGhvbGRTZWNvbmRzPzogbnVtYmVyIH0gPSB7fSkge1xuICBsZXQgaGVsZFVudGlsOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIGlmIChvcHRzLmhvbGRTZWNvbmRzICYmIG9wdHMuaG9sZFNlY29uZHMgPiAwKSB7XG4gICAgaGVsZFVudGlsID0gRGF0ZS5ub3coKSArIG9wdHMuaG9sZFNlY29uZHMgKiAxMDAwO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKGhlbGRVbnRpbCkpO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgZGFlbW9uOiBmYWxzZSxcbiAgICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHN0b3BwZWQ6IHRydWUsXG4gICAgLi4uKGhlbGRVbnRpbCAhPT0gdW5kZWZpbmVkID8geyBoZWxkX3VudGlsOiBoZWxkVW50aWwgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIFBlci1jaGFubmVsIGxpdmUtY29ubmVjdGlvbiBzdW1tYXJ5IOKAlCB0aGUgcmVzdGFydC1zYWZldHkgcmVhZC4gTWlycm9ycyB3aGF0XG4vLyBgZG9jdG9yYCByZXBvcnRzIHVuZGVyIGFjdGl2ZV9zdWJzY3JpYmVyczsgb25seSBwb3B1bGF0ZWQgY2hhbm5lbHMgYXJlIGxpc3RlZC5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoQWN0aXZlU3Vic2NyaWJlcnMoXG4gIHBvcnQ6IG51bWJlcixcbik6IFByb21pc2U8eyB0b3RhbDogbnVtYmVyOyBjaGFubmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbm5lY3Rpb25zOiBudW1iZXIgfT4gfT4ge1xuICBsZXQgdG90YWwgPSAwO1xuICBjb25zdCBjaGFubmVsczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGNvbm5lY3Rpb25zOiBudW1iZXIgfT4gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICBmb3IgKGNvbnN0IGNoIG9mIGRhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICB0b3RhbCArPSBjaC5jb25uZWN0aW9ucztcbiAgICAgIGlmIChjaC5jb25uZWN0aW9ucyA+IDApIGNoYW5uZWxzLnB1c2goeyBuYW1lOiBjaC5uYW1lLCBjb25uZWN0aW9uczogY2guY29ubmVjdGlvbnMgfSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydCDigJQgYSBwcmVzZW5jZSBoaWNjdXAgc2hvdWxkbid0IGNyYXNoIGEgbGlmZWN5Y2xlIHZlcmJcbiAgfVxuICByZXR1cm4geyB0b3RhbCwgY2hhbm5lbHMgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhcnQoKSB7XG4gIC8vIEVuc3VyZS1ydW5uaW5nLCBubyBjaGFubmVsIHNpZGUtZWZmZWN0LiBJZGVtcG90ZW50OiByZXBvcnQgYW4gZXhpc3RpbmdcbiAgLy8gZGFlbW9uLCBvciBzcGF3biBhIGZyZXNoIG9uZS4gVGhlIGV4cGxpY2l0IFwiYnJpbmcgaXQgdXBcIiB2ZXJiIOKAlCBkaWFnbm9zdGljc1xuICAvLyAoZG9jdG9yL2luZm8vbGlzdCkgc3RheSByZWFkLW9ubHkgYW5kIG5ldmVyIHNwYXduLlxuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghZXhpc3RpbmcgJiYgaG9sZEFjdGl2ZSgpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGhlbGQ6IHRydWUsIHBvcnQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBvcnQgPSBleGlzdGluZyA/PyAoYXdhaXQgZW5zdXJlRGFlbW9uKCkpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcG9ydCwgYWxyZWFkeV9ydW5uaW5nOiBleGlzdGluZyAhPT0gbnVsbCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzdGFydChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICAvLyBOb3RoaW5nIHRvIHRlYXIgZG93biDigJQganVzdCBicmluZyBhIGZyZXNoIGRhZW1vbiB1cC5cbiAgICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCByZXN0YXJ0ZWQ6IHRydWUsIHBvcnQ6IGZyZXNoLCBwcmV2aW91c19waWQ6IG51bGwgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFNBRkVUWTogYSByZXN0YXJ0IGZvcmNlcyBldmVyeSBjb25uZWN0ZWQgY2xpZW50IHRvIGF1dG8tcmVjb25uZWN0LiBSZWZ1c2UgdG9cbiAgLy8gdGVhciBkb3duIGEgd29ya2luZyBmbGVldCB1bmxlc3MgZXhwbGljaXRseSBmb3JjZWQg4oCUIG5ldmVyIHNpbGVudGx5IGRyb3AgaXQuXG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByZXN0YXJ0OiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSBhY3Jvc3MgJHtjaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykg4oCUICR7d2hlcmV9LiBgICtcbiAgICAgICAgXCJBIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSBhbGwgdG8gcmVjb25uZWN0LiBSZS1ydW4gd2l0aCAtLWZvcmNlIChvciAtLXllcykgdG8gcHJvY2VlZCBhbnl3YXkuXCIsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgfVxuICAvLyBDYXB0dXJlIHRoZSBwaWQgd2UncmUgcmVwbGFjaW5nLCBmb3IgdGhlIHJlY2VpcHQuXG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICBwcmV2aW91c1BpZCA9IGRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3AsIHRoZW4gd2FpdCBmb3IgdGhlIG9sZCBkYWVtb24gdG8gYWN0dWFsbHkgZ28gYXdheSDigJQgaXQgdW5saW5rcyBpdHNcbiAgLy8gcG9ydC9waWQgZmlsZXMgb24gc2h1dGRvd24sIHNvIGVuc3VyZURhZW1vbiBzcGF3bnMgZnJlc2ggcmF0aGVyIHRoYW5cbiAgLy8gcmUtZGlzY292ZXJpbmcgdGhlIGR5aW5nIG9uZS5cbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGkocG9ydCwgXCJERUxFVEVcIiwgXCIvXCIpO1xuICB9IGNhdGNoIHt9XG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIGlmICgoYXdhaXQgcmVhZERhZW1vblBvcnQoKSkgPT09IG51bGwpIGJyZWFrO1xuICB9XG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCByZXN0YXJ0ZWQ6IHRydWUsIHBvcnQ6IGZyZXNoLCBwcmV2aW91c19waWQ6IHByZXZpb3VzUGlkIH0pO1xufVxuXG4vLyBiMyDigJQgVEhFIFZFUlNJT04gVkVSSUZZLCBBUyBPTkUgU09VUkNFIEZPUiBCT1RIIFBBVEhTLlxuLy9cbi8vIGByb2xsYCBpcyBkb2N1bWVudGVkIGFzIFwidGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwIOKApiArIHZlcnNpb24gdmVyaWZ5XCIsIGFuZFxuLy8gdGhlIHZlcmlmeSBoYWQgdHdvIHdheXMgdG8gc2F5IG5vdGhpbmc6XG4vL1xuLy8gICBDT0xEIFBBVEgg4oCUIG5vIGRhZW1vbiBydW5uaW5nOiBpdCBzcGF3bmVkIG9uZSBhbmQgcHJpbnRlZCBuZWl0aGVyIGB2ZXJzaW9uYFxuLy8gICBub3IgYHZlcnNpb25fb2tgLiBUaGUgZmllbGRzIHdlcmUgQUJTRU5ULCBzbyBhIGNhbGxlciBjaGVja2luZyB0aGUgdmVyaWZ5XG4vLyAgIGdvdCBgdW5kZWZpbmVkYCBvbiB0aGUgZXhhY3QgcGF0aCB3aGVyZSB0aGUgdmVyaWZ5IG5ldmVyIGhhcHBlbmVkLlxuLy9cbi8vICAgV0FSTSBQQVRIIOKAlCB0aGUgcHJvYmUgd2FzIHdyYXBwZWQgaW4gYGNhdGNoIHt9YCwgbGVhdmluZyBgdmVyc2lvbiA9IG51bGxgLFxuLy8gICBhbmQgYHZlcnNpb25fb2s6IG51bGwgPT09IFBMVUdJTl9WRVJTSU9OYCBldmFsdWF0ZXMgdG8gRkFMU0UuIFwiSSBjb3VsZCBub3Rcbi8vICAgY2hlY2tcIiB3YXMgcmVwb3J0ZWQgYXMgXCJ0aGUgdmVyc2lvbiBpcyBXUk9OR1wiIOKAlCBhIGJvb2xlYW4gdGhhdCBjYW5ub3Qgc2F5XG4vLyAgIFwidW5rbm93blwiIGlzIHRoZSBjYW5vbmljYWwgc2hhcGUgb2YgdGhpcyBzcHJpbnQncyBkZWZlY3QsIGFuZCBmYWxzZSBpcyB0aGVcbi8vICAgd29yc3QgYXZhaWxhYmxlIGFuc3dlciBiZWNhdXNlIGl0IGlzIGFjdGlvbmFibGUgYW5kIGluY29ycmVjdC5cbi8vXG4vLyBTbyBgdmVyc2lvbl9va2AgaXMgbm93IGBib29sZWFuIHwgbnVsbGA6IG51bGwgbWVhbnMgVU5DSEVDS0VELCBuZXZlciBmYWxzZS5cbi8vIGB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb25gIGlzIHByZXNlbnQtYW5kLW51bGwgYmVzaWRlIGl0LCBiZWNhdXNlIGEgYmFyZSBudWxsXG4vLyB0ZWxscyBhIGNhbGxlciB0aGUgY2hlY2sgZGlkIG5vdCBoYXBwZW4gYW5kIG5vdCB3aHkuXG4vL1xuLy8gT25lIGhlbHBlciByYXRoZXIgdGhhbiB0d28gY2FsbCBzaXRlczogYSBzZWNvbmQgY29weSBvZiB0aGlzIGxvZ2ljIG9uIHRoZSBjb2xkXG4vLyBwYXRoIGlzIHRoZSBtaXJyb3ItZHJpZnQgdHJhcCwgYW5kIHRoZSBjb2xkIHBhdGggaXMgcHJlY2lzZWx5IHRoZSBvbmUgbm9ib2R5XG4vLyByZS1yZWFkcy5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZVZlcnNpb24ocG9ydDogbnVtYmVyKTogUHJvbWlzZTx7XG4gIHZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHZlcnNpb25fb2s6IGJvb2xlYW4gfCBudWxsO1xuICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IHN0cmluZyB8IG51bGw7XG59PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdiA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmICh2ID09PSBudWxsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgICB2ZXJzaW9uX29rOiBudWxsLFxuICAgICAgICB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IFwidGhlIGRhZW1vbiBhbnN3ZXJlZCBidXQgcmVwb3J0ZWQgbm8gdmVyc2lvblwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdmVyc2lvbjogdiwgdmVyc2lvbl9vazogdiA9PT0gUExVR0lOX1ZFUlNJT04sIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogbnVsbCB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHZlcnNpb246IG51bGwsXG4gICAgICB2ZXJzaW9uX29rOiBudWxsLFxuICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBgY291bGQgbm90IHJlYWNoIHRoZSBkYWVtb24gdG8gdmVyaWZ5OiAke1xuICAgICAgICBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSlcbiAgICAgIH1gLFxuICAgIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUm9sbChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICAvLyBDT0xEIFBBVEgg4oCUIG5vdGhpbmcgd2FzIHJ1bm5pbmcsIHNvIHRoaXMgaXMgYSBzdGFydCByYXRoZXIgdGhhbiBhIHJvbGwuXG4gICAgLy8gSXQgc3RpbGwgcmVwb3J0cyB0aGUgdmVyaWZ5LCBiZWNhdXNlIFwibm8gZGFlbW9uIHdhcyB1cFwiIGlzIG5vdCBhIHJlYXNvbiB0b1xuICAgIC8vIHN0YXkgc2lsZW50IGFib3V0IHdoaWNoIHZlcnNpb24gaXMgbm93IHNlcnZpbmcuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oe1xuICAgICAgb2s6IHRydWUsXG4gICAgICByb2xsZWQ6IHRydWUsXG4gICAgICBwcmV2aW91c19waWQ6IG51bGwsXG4gICAgICBwb3J0OiBmcmVzaCxcbiAgICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyB0b3RhbCwgY2hhbm5lbHMgfSA9IGF3YWl0IGZldGNoQWN0aXZlU3Vic2NyaWJlcnMocG9ydCk7XG4gIGlmICh0b3RhbCA+IDAgJiYgIW9wdHMuZm9yY2UpIHtcbiAgICBjb25zdCB3aGVyZSA9IGNoYW5uZWxzLm1hcCgoYykgPT4gYCR7Yy5uYW1lfSAoJHtjLmNvbm5lY3Rpb25zfSlgKS5qb2luKFwiLCBcIik7XG4gICAgZGllKFxuICAgICAgYHJvbGw6ICR7dG90YWx9IGFjdGl2ZSBzdWJzY3JpYmVyKHMpIOKAlCAke3doZXJlfS4gVGhleSdsbCBhdXRvLXJlY29ubmVjdCBhY3Jvc3MgdGhlIHJvbGwuIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gcHJvY2VlZC5gLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgbGV0IHByZXZpb3VzUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBwcmV2aW91c1BpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RvcCB3aXRoIGEgc2hvcnQgaG9sZCBzbyBhIHN0YWxlIENMSSBjYW4ndCB3aW4gdGhlIHJlc3Bhd24gcmFjZTsgd2UgaG9sZCB0aGUgc3Bhd24gb3Vyc2VsdmVzLlxuICBjb25zdCBob2xkTXMgPSA0MDAwO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoSE9MRF9GSUxFLCBTdHJpbmcoRGF0ZS5ub3coKSArIGhvbGRNcykpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICByZWxlYXNlSG9sZCgpOyAvLyBvdXIgdHVybiB0byBzcGF3biB0aGUgbmV3IHZlcnNpb25cbiAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgbGV0IHBpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4oZnJlc2gsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICByb2xsZWQ6IHRydWUsXG4gICAgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCxcbiAgICBwaWQsXG4gICAgcG9ydDogZnJlc2gsXG4gICAgLi4uKGF3YWl0IHByb2JlVmVyc2lvbihmcmVzaCkpLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2F0Y2gobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIC8vIENoYW5uZWwgbmFtZSBpcyBvcHRpb25hbCDigJQgdGhlIHBhZ2UgcmVhZHMgaXQgZnJvbSB0aGUgVVJMIGhhc2ggYW5kXG4gIC8vIGRlZmF1bHRzIHRvIFwibG9iYnlcIiBpZiBhYnNlbnQuIFdlIHBhc3MgdGhyb3VnaCB3aGF0ZXZlciB0aGUgdXNlciBnYXZlXG4gIC8vIChvciBcImxvYmJ5XCIpIGFuZCBvcGVuIHRoZSBicm93c2VyLiBEYWVtb24gaXMgZW5zdXJlZCBzbyB0aGUgc2VydmVkXG4gIC8vIC93YXRjaCBIVE1MIGlzIHJlYWNoYWJsZS5cbiAgY29uc3QgY2hhbm5lbCA9IG5hbWU/LnRyaW0oKSA/IG5hbWUudHJpbSgpIDogXCJsb2JieVwiO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEVuc3VyZSB0aGUgY2hhbm5lbCBleGlzdHMgc28gdGhlIHBhZ2Ugc2VlcyBhIHZhbGlkIGJhY2tsb2cvdG9waWMuXG4gIGF3YWl0IGFwaShwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lOiBjaGFubmVsIH0pO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3dhdGNoIyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNoYW5uZWwpfWA7XG4gIC8vIE9wZW4gdGhlIGJyb3dzZXIgdmlhIHRoZSBwbGF0Zm9ybSdzIGRlZmF1bHQgb3BlbmVyLiBCZXN0LWVmZm9ydCDigJRcbiAgLy8gcHJpbnQgdGhlIFVSTCBzbyB0aGUgdXNlciBjYW4gY2xpY2sgaXQgaWYgYXV0by1vcGVuIGZhaWxzLlxuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwiZXhwbG9yZXJcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gc3Bhd24ob3BlbmVyLCBbdXJsXSwge1xuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICBzdGRpbzogXCJpZ25vcmVcIixcbiAgICB9KTtcbiAgICBwLnVucmVmKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG9wZW5lciBtaXNzaW5nIOKAlCBqdXN0IHByaW50ICovXG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWwsIHVybCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kRG9jdG9yKCkge1xuICAvLyBSZWFkLW9ubHkgZGlhZ25vc3RpYy4gUmVwb3J0cyB0aGUgYXV0aG9yaXRhdGl2ZSBkYWVtb24gKGlmIGFueSksIG90aGVyXG4gIC8vIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzc2VzIHZpc2libGUgb24gdGhlIG1hY2hpbmUsIGNoYW5uZWwgZmlsZXMgb25cbiAgLy8gZGlzaywgYW5kIHN1cmZhY2VzIGhpbnRzLiBEb2VzIE5PVCB0YWtlIGRlc3RydWN0aXZlIGFjdGlvbiDigJQgY2xlYW51cFxuICAvLyBpcyB0aGUgb3BlcmF0b3IncyBjYWxsLCB3aXRoIHN0b2NrIHVuaXggdG9vbHMuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBsZXQgYXV0aG9yaXRhdGl2ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsID0gbnVsbDtcbiAgLy8gUGVyLWNoYW5uZWwgc3Vic2NyaWJlciBzdW1tYXJ5IOKAlCBhbnN3ZXJzIFwiaXMgaXQgc2FmZSB0byByZXN0YXJ0IHRoZVxuICAvLyBkYWVtb24gcmlnaHQgbm93P1wiIHdpdGhvdXQgbmVlZGluZyB0byBhbHNvIHJ1biBgbGlzdGAgYW5kIHJlYWQgdGhlXG4gIC8vIG91dHB1dC4gRW1wdHkgaWYgbm8gZGFlbW9uIGlzIHJ1bm5pbmcuXG4gIGxldCB0b3RhbFN1YnNjcmliZXJzID0gMDtcbiAgY29uc3QgYnVzeUNoYW5uZWxzOiBBcnJheTx7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIHN1YnNjcmliZXJzOiBudW1iZXI7XG4gICAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgICBuYW1lZDogbnVtYmVyO1xuICAgIGFub255bW91czogbnVtYmVyO1xuICB9PiA9IFtdO1xuICBpZiAocG9ydCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpO1xuICAgICAgYXV0aG9yaXRhdGl2ZSA9IHsgcG9ydCwgLi4uZGF0YSB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gZGFlbW9uIHdlbnQgYXdheSBiZXR3ZWVuIHBvcnQgY2hlY2sgYW5kIGFwaSBjYWxsXG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAvLyAvcHJlc2VuY2UgZ2l2ZXMgdGhlIGhvbmVzdCBwZXItY2hhbm5lbCBicmVha2Rvd24gKGNvbm5lY3Rpb25zIHZzIG5hbWVkXG4gICAgICAvLyB2cyBhbm9ueW1vdXMpIOKAlCBzbyB0aGUgcmVzdGFydC1zYWZldHkgdG90YWwgaXNuJ3QgYSBteXN0ZXJ5IGFuZCBhblxuICAgICAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiByZWFkcyBhcyBhIHdhdGNoZXIsIG5vdCBhIGdob3N0LlxuICAgICAgY29uc3QgeyBkYXRhOiBwcmVzRGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICAgICAgZm9yIChjb25zdCBjaCBvZiBwcmVzRGF0YT8uY2hhbm5lbHMgPz8gW10pIHtcbiAgICAgICAgdG90YWxTdWJzY3JpYmVycyArPSBjaC5jb25uZWN0aW9ucztcbiAgICAgICAgYnVzeUNoYW5uZWxzLnB1c2goe1xuICAgICAgICAgIG5hbWU6IGNoLm5hbWUsXG4gICAgICAgICAgc3Vic2NyaWJlcnM6IGNoLmNvbm5lY3Rpb25zLCAvLyBiYWNrLWNvbXBhdDogcHJldmlvdXNseSB0aGUgcmF3IGNvdW50XG4gICAgICAgICAgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zLFxuICAgICAgICAgIG5hbWVkOiBjaC5uYW1lZCxcbiAgICAgICAgICBhbm9ueW1vdXM6IGNoLmFub255bW91cyxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBiZXN0LWVmZm9ydFxuICAgIH1cbiAgfVxuXG4gIC8vIEVudW1lcmF0ZSBvdGhlciBkYWVtb24gcHJvY2Vzc2VzIHZpYSB0aGUgc2hhcmVkIGNsYXNzaWZpZXIuIEVhY2ggZW50cnlcbiAgLy8gZ2FpbnMgcG9ydC9ob21lL3ZlcnNpb24vc3RhdHVzL3JlYXBhYmxlIHNvIHRoZSBvcGVyYXRvciBoYXMgdGhlIGZ1bGxcbiAgLy8gcGljdHVyZSB3aXRob3V0IG5lZWRpbmcgYSBzZXBhcmF0ZSBgcmVhcCAtLWRyeS1ydW5gLlxuICBjb25zdCBvdGhlckRhZW1vbnM6IEFycmF5PEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlEYWVtb24+PiAmIHsgY29tbWFuZD86IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBzZWxmUGlkID0gYXV0aG9yaXRhdGl2ZT8ucGlkIGFzIG51bWJlciB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IHBpZCBvZiBhd2FpdCBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpKSB7XG4gICAgICBpZiAoc2VsZlBpZCAmJiBwaWQgPT09IHNlbGZQaWQpIGNvbnRpbnVlO1xuICAgICAgb3RoZXJEYWVtb25zLnB1c2goYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwcyB1bmF2YWlsYWJsZTsgY2Fycnkgb24gd2l0aCBlbXB0eSBsaXN0XG4gIH1cblxuICAvLyBDaGFubmVscyBvbiBkaXNrIHVuZGVyIHRoaXMgSE9NRS5cbiAgY29uc3QgY2hhbm5lbHNPbkRpc2s6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgY2hhbm5lbHNEaXIgPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIpO1xuICAgIGlmIChleGlzdHNTeW5jKGNoYW5uZWxzRGlyKSkge1xuICAgICAgZm9yIChjb25zdCBmIG9mIHJlYWRkaXJTeW5jKGNoYW5uZWxzRGlyKSkge1xuICAgICAgICBpZiAoZi5lbmRzV2l0aChcIi5qc29ubFwiKSkgY2hhbm5lbHNPbkRpc2sucHVzaChmLnJlcGxhY2UoL1xcLmpzb25sJC8sIFwiXCIpKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge31cblxuICAvLyBIaW50cyDigJQgc3VyZmFjZSB0aGUgbW9zdCBhY3Rpb25hYmxlIHNpZ25hbHMuXG4gIGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoIWF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgXCJObyBhdXRob3JpdGF0aXZlIGRhZW1vbiBydW5uaW5nIGZvciB0aGlzIEhPTUUuIFJ1biBhbnkgdmVyYiAoZS5nLiBgY2xpLnRzIGxpc3RgKSB0byBzcGF3biBvbmUuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAob3RoZXJEYWVtb25zLmxlbmd0aCA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYEZvdW5kICR7b3RoZXJEYWVtb25zLmxlbmd0aH0gb3RoZXIgZ3JhcGV2aW5lIGRhZW1vbiBwcm9jZXNzKGVzKSBvbiB0aGlzIG1hY2hpbmUuIGAgK1xuICAgICAgICBcIlRoZXkgbWF5IGJlIHpvbWJpZXMgZnJvbSBwYXN0IHJ1bnMgT1IgZGFlbW9ucyBzZXJ2aW5nIG90aGVyIEhPTUVzIChkaWZmZXJlbnQgR1JBUEVWSU5FX0hPTUUpLlwiLFxuICAgICk7XG4gICAgY29uc3QgcmVhcGFibGVDb3VudCA9IG90aGVyRGFlbW9ucy5maWx0ZXIoKGQpID0+IGQucmVhcGFibGUpLmxlbmd0aDtcbiAgICBpZiAocmVhcGFibGVDb3VudCA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGBGb3VuZCAke3JlYXBhYmxlQ291bnR9IHJlYXBhYmxlIG9ycGhhbiBkYWVtb24ocykuIFJ1biBcXGBncmFwZXZpbmUgcmVhcFxcYCB0byBjbGVhciB0aGVtIHNhZmVseS5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG90aGVyRGFlbW9ucy5zb21lKChkKSA9PiBkLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIikpIHtcbiAgICAgIGhpbnRzLnB1c2goXCJTb21lIGRhZW1vbnMgYXJlIHVucmVzcG9uc2l2ZTsgYGdyYXBldmluZSByZWFwIC0tZm9yY2VgIGluY2x1ZGVzIHRoZW0uXCIpO1xuICAgIH1cbiAgfVxuICBpZiAoXG4gICAgYXV0aG9yaXRhdGl2ZSAmJlxuICAgIFBMVUdJTl9WRVJTSU9OICYmXG4gICAgdHlwZW9mIGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIGF1dGhvcml0YXRpdmUudmVyc2lvbiAhPT0gUExVR0lOX1ZFUlNJT05cbiAgKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBBdXRob3JpdGF0aXZlIGRhZW1vbiB2ZXJzaW9uICgke2F1dGhvcml0YXRpdmUudmVyc2lvbn0pIGRpZmZlcnMgZnJvbSB0aGlzIENMSSdzIHZlcnNpb24gKCR7UExVR0lOX1ZFUlNJT059KS4gYCArXG4gICAgICAgIFwiUmVzdGFydCB0aGUgZGFlbW9uIHRvIGFsaWduIOKAlCBkcm9wIGFjdGl2ZSB0YWlscywgdGhlbiBgc3RvcGAsIHRoZW4gYW55IHZlcmIuXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoYXV0aG9yaXRhdGl2ZSAmJiAoYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSBudWxsIHx8IGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gdW5kZWZpbmVkKSkge1xuICAgIGhpbnRzLnB1c2goXCJBdXRob3JpdGF0aXZlIGRhZW1vbiBwcmVkYXRlcyB2ZXJzaW9uIHJlcG9ydGluZyAocHJlLVYxLjYuMikuIFJlc3RhcnQgdG8gYWxpZ24uXCIpO1xuICB9XG4gIGlmICh0b3RhbFN1YnNjcmliZXJzID4gMCkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgJHt0b3RhbFN1YnNjcmliZXJzfSBhY3RpdmUgc3Vic2NyaWJlcihzKSBhY3Jvc3MgJHtidXN5Q2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpLiBgICtcbiAgICAgICAgXCJEYWVtb24gcmVzdGFydCB3b3VsZCBmb3JjZSB0aGVtIHRvIGF1dG8tcmVjb25uZWN0ICh3b3JrcywgYnV0IGRpc3J1cHRpdmUpIOKAlCBjb29yZGluYXRlIGZpcnN0LlwiLFxuICAgICk7XG4gIH0gZWxzZSBpZiAoYXV0aG9yaXRhdGl2ZSkge1xuICAgIGhpbnRzLnB1c2goXCJObyBhY3RpdmUgc3Vic2NyaWJlcnMg4oCUIGRhZW1vbiByZXN0YXJ0IGlzIG5vbi1kaXNydXB0aXZlLlwiKTtcbiAgfVxuICAvLyBFeHBsYWluIGFueSBjaGFubmVsIHdoZXJlIHRoZSBjb25uZWN0aW9uIGNvdW50IGV4Y2VlZHMgbmFtZWQgYWdlbnRzIOKAlCBhblxuICAvLyBhbm9ueW1vdXMgd2F0Y2ggdGFiIGluZmxhdGVzIGBjb3VudGAvYGNvbm5lY3Rpb25zYCBidXQgaXNuJ3QgYSBnaG9zdC5cbiAgZm9yIChjb25zdCBjaCBvZiBidXN5Q2hhbm5lbHMpIHtcbiAgICBpZiAoY2guYW5vbnltb3VzID4gMCkge1xuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7Y2gubmFtZX06ICR7Y2guY29ubmVjdGlvbnN9IGNvbm5lY3Rpb24ocyksICR7Y2gubmFtZWR9IG5hbWVkIGFnZW50KHMpICsgYCArXG4gICAgICAgICAgYCR7Y2guYW5vbnltb3VzfSBhbm9ueW1vdXMgKGUuZy4gYSB3YXRjaCB0YWIpLiBUaGUgY291bnQgb3ZlciB0aGUgbmFtZSBsaXN0IGlzIGV4cGVjdGVkLCBub3QgYSBnaG9zdC5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIGhvbWU6IERBVEFfRElSLFxuICAgIGNsaV92ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTixcbiAgICBhdXRob3JpdGF0aXZlLFxuICAgIGFjdGl2ZV9zdWJzY3JpYmVyczoge1xuICAgICAgdG90YWw6IHRvdGFsU3Vic2NyaWJlcnMsXG4gICAgICBidXN5X2NoYW5uZWxzOiBidXN5Q2hhbm5lbHMsXG4gICAgfSxcbiAgICBvdGhlcl9kYWVtb25zX29uX21hY2hpbmU6IG90aGVyRGFlbW9ucyxcbiAgICBjaGFubmVsc19vbl9kaXNrOiBjaGFubmVsc09uRGlzayxcbiAgICBoaW50cyxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEluZm8oKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8g4pSA4pSAIERhZW1vbiBlbnVtZXJhdGlvbiArIGNsYXNzaWZpZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKiBBbGwgZ3JhcGV2aW5lIGRhZW1vbi50cyBwaWRzIHZpc2libGUgb24gdGhpcyBtYWNoaW5lICh2aWEgYHBzYCkuICovXG5hc3luYyBmdW5jdGlvbiBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpOiBQcm9taXNlPG51bWJlcltdPiB7XG4gIGNvbnN0IHBpZHM6IG51bWJlcltdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgcHJvYyA9IHNwYXduKFwicHNcIiwgW1wiLWVvXCIsIFwicGlkLGNvbW1hbmRcIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByZXNvbHZlKCkpKTtcbiAgICBjb25zdCBvdXQgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGYtOFwiKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygb3V0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBpZiAoIWxpbmUuaW5jbHVkZXMoXCJkYWVtb24udHNcIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFsaW5lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJncmFwZXZpbmVcIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgbSA9IGxpbmUubWF0Y2goL15cXHMqKFxcZCspXFxzKy8pO1xuICAgICAgaWYgKCFtKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBpZCA9IHBhcnNlSW50KG1bMV0sIDEwKTtcbiAgICAgIGlmIChwaWQpIHBpZHMucHVzaChwaWQpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IHJldHVybiBlbXB0eVxuICB9XG4gIHJldHVybiBwaWRzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsc29mTGlzdGVuUG9ydChwaWQ6IG51bWJlcik6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcImxzb2ZcIiwgW1wiLWFpVENQXCIsIFwiLXNUQ1A6TElTVEVOXCIsIFwiLXBcIiwgU3RyaW5nKHBpZCksIFwiLVBcIiwgXCItblwiXSwge1xuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpZ25vcmVcIl0sXG4gICAgfSk7XG4gICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgIHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGIpID0+IGNodW5rcy5wdXNoKGIgYXMgQnVmZmVyKSk7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHByb2Mub24oXCJleGl0XCIsICgpID0+IHIoKSkpO1xuICAgIGNvbnN0IG0gPSBCdWZmZXIuY29uY2F0KGNodW5rcylcbiAgICAgIC50b1N0cmluZyhcInV0Zi04XCIpXG4gICAgICAubWF0Y2goLzEyN1xcLjBcXC4wXFwuMTooXFxkKykvKTtcbiAgICByZXR1cm4gbSA/IHBhcnNlSW50KG1bMV0sIDEwKSA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCB0eXBlIERhZW1vblN0YXR1cyA9IFwiYXV0aG9yaXRhdGl2ZVwiIHwgXCJvcnBoYW5cIiB8IFwidW5yZXNwb25zaXZlXCIgfCBcInVua25vd25cIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsYXNzaWZ5RGFlbW9uKHBpZDogbnVtYmVyKTogUHJvbWlzZTx7XG4gIHBpZDogbnVtYmVyO1xuICBwb3J0OiBudW1iZXIgfCBudWxsO1xuICBob21lPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzOiBEYWVtb25TdGF0dXM7XG4gIHJlYXBhYmxlOiBib29sZWFuO1xufT4ge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgbHNvZkxpc3RlblBvcnQocGlkKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4geyBwaWQsIHBvcnQ6IG51bGwsIHN0YXR1czogXCJ1bmtub3duXCIsIHJlYXBhYmxlOiBmYWxzZSB9O1xuICBsZXQgaW5mbzogUm9vdEluZm8gfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg4MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIGluZm8gPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gIH0gY2F0Y2gge31cbiAgaWYgKCFpbmZvKSByZXR1cm4geyBwaWQsIHBvcnQsIHN0YXR1czogXCJ1bnJlc3BvbnNpdmVcIiwgcmVhcGFibGU6IGZhbHNlIH07IC8vIHJlYXAgb25seSB3aXRoIC0tZm9yY2UgKGhhbmRsZWQgaW4gY21kUmVhcClcbiAgY29uc3QgaG9tZSA9IGluZm8uZGF0YV9kaXIgYXMgc3RyaW5nO1xuICBsZXQgb3ducyA9IGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IG9wID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucG9ydFwiKSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgY29uc3Qgb2kgPSByZWFkRmlsZVN5bmMoam9pbihob21lLCBcImRhZW1vbi5waWRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIG93bnMgPSBvcCA9PT0gU3RyaW5nKHBvcnQpICYmIG9pID09PSBTdHJpbmcocGlkKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4gb3duc1xuICAgID8ge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwiYXV0aG9yaXRhdGl2ZVwiLFxuICAgICAgICByZWFwYWJsZTogZmFsc2UsXG4gICAgICB9XG4gICAgOiB7XG4gICAgICAgIHBpZCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgaG9tZSxcbiAgICAgICAgdmVyc2lvbjogaW5mby52ZXJzaW9uID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogXCJvcnBoYW5cIixcbiAgICAgICAgcmVhcGFibGU6IHRydWUsXG4gICAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZWFwKG9wdHM6IHsgZm9yY2U/OiBib29sZWFuOyBkcnlSdW4/OiBib29sZWFuIH0pIHtcbiAgY29uc3Qgc2VsZlBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpOyAvLyBjdXJyZW50IEhPTUUgYXV0aG9yaXRhdGl2ZSAobmV2ZXIgcmVhcClcbiAgbGV0IHNlbGZQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBpZiAoc2VsZlBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZlBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHNlbGZQb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCBwaWRzID0gYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTtcbiAgY29uc3Qga2VwdDogdW5rbm93bltdID0gW10sXG4gICAgcmVhcGVkOiB1bmtub3duW10gPSBbXSxcbiAgICBza2lwcGVkOiB1bmtub3duW10gPSBbXTtcbiAgZm9yIChjb25zdCBwaWQgb2YgcGlkcykge1xuICAgIGNvbnN0IGMgPSBhd2FpdCBjbGFzc2lmeURhZW1vbihwaWQpO1xuICAgIGNvbnN0IGlzU2VsZiA9IHBpZCA9PT0gc2VsZlBpZDtcbiAgICBjb25zdCBzaG91bGRSZWFwID1cbiAgICAgICFpc1NlbGYgJiYgKGMucmVhcGFibGUgfHwgKGMuc3RhdHVzID09PSBcInVucmVzcG9uc2l2ZVwiICYmIG9wdHMuZm9yY2UgPT09IHRydWUpKTtcbiAgICBpZiAoIXNob3VsZFJlYXApIHtcbiAgICAgIGtlcHQucHVzaChjKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAob3B0cy5kcnlSdW4pIHtcbiAgICAgIHNraXBwZWQucHVzaCh7IC4uLmMsIG5vdGU6IFwiZHJ5LXJ1blwiIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmtpbGwocGlkLCBcIlNJR1RFUk1cIik7XG4gICAgICByZWFwZWQucHVzaChjKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHNraXBwZWQucHVzaCh7IC4uLmMsIG5vdGU6IFwia2lsbCBmYWlsZWRcIiB9KTtcbiAgICB9XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRyeV9ydW46ICEhb3B0cy5kcnlSdW4sIGtlcHQsIHJlYXBlZCwgc2tpcHBlZCB9KTtcbn1cblxuLy8gKEJPT0xFQU5fRkxBR1Mgd2FzIGhlcmUuIEl0IGxpc3RlZCB3aGljaCBmbGFncyB0YWtlIG5vIHZhbHVlIOKAlCBoYWxmIGFcbi8vIHJlZ2lzdHJ5LCBjb25zdWx0ZWQgYnkgdGhlIGhhbmQtcm9sbGVkIHBhcnNlci4gSXRzIDEzIGVudHJpZXMgbm93IGxpdmUgaW5cbi8vIENMSV9PUFRJT05TIGJlbG93IGFzIGB7dHlwZTpcImJvb2xlYW5cIn1gLCB2ZXJpZmllZCAxMy1mb3ItMTMgYWdhaW5zdCB0aG90aCdzXG4vLyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3QgYmVmb3JlIHRoZSBtb3ZlLiBEZWxldGVkIHJhdGhlciB0aGFuIGxlZnRcbi8vIGJlc2lkZSBpdHMgcmVwbGFjZW1lbnQ6IGEgc2Vjb25kIHNvdXJjZSBvZiB0cnV0aCBmb3IgdGhlIHNhbWUgZmFjdCBpcyB0aGVcbi8vIGRyaWZ0IGJ1ZyB0aGlzIGxhbmUgZXhpc3RzIHRvIHJlbW92ZSwgYW5kIGl0IHdvdWxkIG5vIGxvbmdlciBiZSBjb25zdWx0ZWRcbi8vIGJ5IGFueXRoaW5nLilcblxuLy8gU2lnbmF0dXJlIG9mIGEgaGVyZWRvYyBmdW1ibGU6IGEgbGluZSB0aGF0IGlzIChvciBiZWdpbnMgd2l0aCkgYVxuLy8gYGJ1biDigKYgY2xpLnRzIOKApiBzZW5kYCBpbnZvY2F0aW9uLiBXaGVuIGEgYHNlbmQgLS1zdGRpbiA8PEVPRmAgaXMgYm90Y2hlZCwgdGhlXG4vLyBzaGVsbCBwaXBlcyB0aGUgbGl0ZXJhbCBjb21tYW5kIGxpbmUgaW4gYXMgdGhlIGJvZHksIHdoaWNoIHRoZW4gZ2V0cyBwb3N0ZWQg4oCUXG4vLyBjb3JydXB0aW5nIHRoZSBjaGFubmVsIHdpdGggYGJ1biAv4oCmL2NsaS50cyBzZW5kIDxjaGFubmVsPiAtLWFzIOKApiA8dGV4dD5gLlxuLy8gV2UgcmVmdXNlIHRvIHBvc3Qgc3VjaCBhIGJvZHkgdW5sZXNzIC0tZm9yY2UgaXMgcGFzc2VkLlxuY29uc3QgTEVBS0VEX1NFTkRfUkUgPSAvKD86XnxcXG4pWyBcXHRdKmJ1blxcYlteXFxuXSpcXGJjbGlcXC50c1xcYlteXFxuXSpcXGIoPzpzZW5kfGFubm91bmNlKVxcYi87XG5mdW5jdGlvbiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gTEVBS0VEX1NFTkRfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gU2hlbGwtbWV0YWNoYXJhY3RlciBmb290Z3VuICgjNjApOiBhIGJvZHkgcGFzc2VkIGFzIGFuIElOTElORSBwb3NpdGlvbmFsIGFyZ1xuLy8gaXMgZXhwb3NlZCB0byB0aGUgY2FsbGVyJ3Mgc2hlbGwsIHdoaWNoIGNvbW1hbmQtc3Vic3RpdHV0ZXMgYmFja3RpY2tzIC9cbi8vIGAkKC4uLilgIC8gYCR7Li4ufWAgQkVGT1JFIGdyYXBldmluZSBzZWVzIGl0IOKAlCBjb3JydXB0aW5nIG9yIHBhcnRpYWxseVxuLy8gZXhlY3V0aW5nIGNvZGUtYmVhcmluZyBtZXNzYWdlcy4gVGhlIENMSSBjYW4ndCB1bi1zdWJzdGl0dXRlIHdoYXQgdGhlIHNoZWxsXG4vLyBhbHJlYWR5IGF0ZTsgdGhlIGhvbmVzdCBmaXggaXMgdG8gc3RlZXIgY2FsbGVycyB0byB0aGUgc2hlbGwtZnJlZSBwYXRoc1xuLy8gKC0tYm9keS1maWxlIC8gLS1zdGRpbiAvIGRlZmF1bHQtc3RkaW4pLiBXaGVuIG1ldGFjaGFyYWN0ZXJzIFNVUlZJVkUgaW50byBhblxuLy8gaW5saW5lIGJvZHkgKGUuZy4gdGhlIGNhbGxlciBoYXBwZW5lZCB0byBzaW5nbGUtcXVvdGUpLCB0aGV5J3JlIGludGFjdCB0aGlzXG4vLyB0aW1lIOKAlCBidXQgdGhlIHBhdHRlcm4gaXMgYSBsYXRlbnQgZm9vdGd1biwgc28gd2Ugd2FybiAobmV2ZXIgYmxvY2s6IHRoZVxuLy8gbWVzc2FnZSBpcyBmaW5lIGFzIHJlY2VpdmVkKS4gQWJzZW50LW1ldGFjaGFyIGlubGluZSBib2RpZXMgYXJlIGVpdGhlciBwbGFpblxuLy8gdGV4dCAoc2FmZSkgb3IgYWxyZWFkeS1zdWJzdGl0dXRlZCAodW5kZXRlY3RhYmxlKSDigJQgc28gd2Ugb25seSB3YXJuIG9uIHRoZVxuLy8gZGV0ZWN0YWJsZSByaXNreSBwYXR0ZXJuLlxuY29uc3QgU0hFTExfTUVUQUNIQVJfUkUgPSAvYHxcXCRcXCh8XFwkXFx7LztcbmV4cG9ydCBmdW5jdGlvbiBsb29rc1NoZWxsUmlza3kodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBTSEVMTF9NRVRBQ0hBUl9SRS50ZXN0KHRleHQpO1xufVxuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gZ3JhcGV2aW5lIGFscmVhZHkgaGFkIEhBTEYgYSByZWdpc3RyeTogYEJPT0xFQU5fRkxBR1NgIGFib3ZlIHRvbGQgdGhlIHBhcnNlclxuLy8gd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZS4gV2hhdCBpdCBoYWQgbm8gbm90aW9uIG9mIHdhcyB3aGljaCBmbGFncyBFWElTVCwgc29cbi8vIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZSBwcm9zZVxuLy8gY29udGFpbmluZyBhIGAtLXdvcmRgIHdhcyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLlxuLy9cbi8vIOKaoCBncmFwZXZpbmUgaXMgdGhlIE9VVExJRVIgb2YgdGhlIHNpeCwgYW5kIGl0IGlzIHdvcnRoIHNheWluZyB3aHkgc28gbm9ib2R5XG4vLyByZWFkcyBpdCBhcyBtZXJlbHkgYmVoaW5kOiBpdCB0eXBlcyBpdHMgdmFsdWUgZmxhZ3Mgd2l0aCBhIENBU1Rcbi8vIChgZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkYCkgd2hlcmUgdGhlIG90aGVyIGVudHJ5IHBvaW50cyB1c2UgYVxuLy8gYHR5cGVvZmAgZ3VhcmQuIEEgY2FzdCBpcyBhIGNsYWltIHdpdGggTk8gUlVOVElNRSBDSEVDSywgc28gZ3JhcGV2aW5lIGNhcnJpZWRcbi8vIGEgY2xhc3Mgb2YgbGF0ZW50IHR5cGUtbGllIHRoZSBvdGhlcnMgd2VyZSBndWFyZGVkIGFnYWluc3Qg4oCUIGFuZCBiYXJlIHZhbHVlXG4vLyBmbGFncyBwcm9kdWNlZCBzaWxlbnQgd3JvbmcgdmFsdWVzIHJhdGhlciB0aGFuIGVycm9yczpcbi8vXG4vLyAgIC0tbGFzdCAgIGJhcmUgIC0+ICBwYXJzZUludCh0cnVlLCAxMCkgIC0+ICBOYU4sIHNpbGVudGx5XG4vLyAgIC0tdG9waWMgIGJhcmUgIC0+ICBgdHJ1ZWAgaW4gYSBmaWVsZCBERUNMQVJFRCBgc3RyaW5nYFxuLy9cbi8vIGBzdHJpY3Q6IHRydWVgIHR1cm5zIGVhY2ggb2YgdGhvc2UgZnJvbSBhIHNpbGVudCB3cm9uZyB2YWx1ZSBpbnRvIGFcbi8vIGNhbGxlci1mYWNpbmcgZXJyb3IsIHdoaWNoIGlzIHRoZSBsYW5lJ3Mgd2hvbGUgcHVycG9zZSBhbmQgdGhlIGxhcmdlc3Rcbi8vIGJlaGF2aW91ciBkZWx0YSBvZiB0aGUgc2l4IGVudHJ5IHBvaW50cy5cbi8vXG4vLyBUaGUgYm9vbGVhbiBzZXQgYmVsb3cgaXMgQk9PTEVBTl9GTEFHUywgdW5jaGFuZ2VkIOKAlCBleHRyYWN0ZWQgZnJvbSB0aGlzIGZpbGVcbi8vIGFuZCBkaWZmZWQgYWdhaW5zdCB0aG90aCdzIGluZGVwZW5kZW50bHktZGVyaXZlZCBhcnRpZmFjdDogMTMgZm9yIDEzLCBleGFjdCxcbi8vIHplcm8gZGl2ZXJnZW5jZSBpbiBlaXRoZXIgZGlyZWN0aW9uLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNoYW5uZWxzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGhvbGQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImluLXJlcGx5LXRvXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYXN0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbWF4OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRvcGljOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwiZHJ5LXJ1blwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGZyZXNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwiZnJvbS1zdGFydFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGh1bWFuOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGxpdGVyYWw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbHVyazogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBxdWlldDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB0ZXh0OiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHZlcmJvc2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgeWVzOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIEEgcGFyc2Utc3RhZ2UgcmVqZWN0aW9uLCBjYXJyeWluZyB0aGUgZW51bWVyYXRpb24gaXQgd2FudHMgdG8gcHVibGlzaC5cbiAqXG4gKiDim5QgVEhFIGBleHRyYWAgSVMgV0hZIFRISVMgQ0xBU1MgU1VSVklWRUQgVEhFIGBlcnJvcnMudHNgIEFET1BUSU9OLiBUaGVcbiAqIHJlamVjdGlvbiBoYXMgdG8gTkFNRSBpdHMgdmFsaWQgc2V0IOKAlCB0aGF0IGlzIHRoZSB3aG9sZSByZWFzb24gZ3JhcGV2aW5lJ3NcbiAqIHBhcnNlciBlcnJvcnMgd2VyZSBzaGFwZWQgdGhlIHdheSB0aGV5IHdlcmUg4oCUIGFuZCB0aGUgdGhyb3cgaGFwcGVucyB0d28gZnJhbWVzXG4gKiBiZWxvdyB0aGUgcGxhY2UgdGhhdCBrbm93cyB0aGUgc2V0LiBgY2hvaWNlc2AgaXMgd2hlcmUgdGhlIGhvdXNlIGVudmVsb3BlXG4gKiBjYXJyaWVzIGFuIGVudW1lcmF0aW9uLCBzbyB0aGUgY2xhc3MgaG9sZHMgaXQgdW50aWwgYHJ1bkNvbW1hbmRgIHJhaXNlcy5cbiAqL1xuY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJVc2FnZUVycm9yXCI7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG59XG5cbnR5cGUgRmxhZ05hbWUgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG5cbi8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgR0xPQkFMOiBTS0lMTC5tZCB0ZWxscyBhZ2VudHMgdG8gcGFzcyAtLWFzLy0tZnJvbVxuLy8gb24gRVZFUlkgdmVyYiAoYSBmcmVzaCBzaGVsbCBwZXIgY29tbWFuZCBtZWFucyBHUkFQRVZJTkVfRlJPTSBuZXZlclxuLy8gcGVyc2lzdHMpLCBzbyBldmVyeSBjb21tYW5kIGFjY2VwdHMgYm90aCDigJQgZXZlbiB3aGVyZSBhIHZlcmIgaGFzIG5vIHVzZSBmb3Jcbi8vIGlkZW50aXR5LCBhIGNhbGxlciBmb2xsb3dpbmcgb3VyIG93biBkb2NzIG11c3Qgbm90IGJlIHJlamVjdGVkIGZvciBvYmV5aW5nXG4vLyB0aGVtLiBPbiBgZ3JlcGAsIGAtLWZyb21gIGlzIGFuIGF1dGhvciBGSUxURVIgcmF0aGVyIHRoYW4gaWRlbnRpdHk6IGRpZmZlcmVudFxuLy8gc2VtYW50aWNzLCBzYW1lIGFjY2VwdGFuY2UuXG5jb25zdCBHTE9CQUxfRkxBR1M6IEZsYWdOYW1lW10gPSBbXCJhc1wiLCBcImZyb21cIl07XG5cbnR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG4vLyBUSEUgQ09NTUFORCBUQUJMRSwgQVMgQSBTVFJVQ1RVUkUg4oCUIHRoZSBwYXJzZXIsIHRoZSBkaXNwYXRjaGVyLCB0aGUgc2NoZW1hXG4vLyBlbWl0dGVyIGFuZCB0aGUgcm9vdCByZWplY3Rpb24gYWxsIHdhbGsgVEhJUy4gSXQgcmVwbGFjZWQgYSBiYXJlIGBzd2l0Y2hgLFxuLy8gd2hpY2ggb25seSB0aGUgZGlzcGF0Y2hlciBjb3VsZCB3YWxrOiBhIHNjaGVtYSBlbWl0dGVkIGZyb20gYW55dGhpbmcgb3RoZXJcbi8vIHRoYW4gdGhlIHN0cnVjdHVyZSB0aGF0IHJvdXRlcyB0aGUgYmVoYXZpb3VyIGlzIGEgZG9jdW1lbnQgdGhhdCBsaWVzIGFzIHNvb25cbi8vIGFzIGFueW9uZSBlZGl0cyB0aGUgb3RoZXIgc2lkZSAoYWNjIFNUQU5EQVJELm1kIFBhcnQgMSDCpzI7IG91ciBvd24gIzgxL0Q0XG4vLyBsYW5lIGxlYXJuZWQgdGhlIHNhbWUgbGVzc29uIG9uZSBhbHRpdHVkZSBkb3duIHdpdGggQk9PTEVBTl9GTEFHUykuXG4vL1xuLy8gYGZsYWdzYCBpcyB0aGUgdmVyYidzIE9XTiBhY2NlcHRlZCBzZXQgKEdMT0JBTF9GTEFHUyBhcmUgbWVyZ2VkIGluIGJ5XG4vLyBgYWNjZXB0ZWRGbGFnc2ApLiBBIGZsYWcgbm90IGxpc3RlZCBoZXJlIGlzIFJFSkVDVEVEIGZvciB0aGlzIHZlcmIgd2l0aCB0aGVcbi8vIHZlcmIncyBvd24gc2V0IGVudW1lcmF0ZWQg4oCUIGFjY2VwdGVkLWFuZC1pZ25vcmVkIGlzIHRoZSBkaXNlYXNlIHRoaXMgdGFibGVcbi8vIGV4aXN0cyB0byBjdXJlIChhY2MgRFQtMTogYW50aGlsbCBhY2NlcHRpbmcgYSByb290IGAtLWZvcm1hdGAgaXQgc2lsZW50bHlcbi8vIGRpc2NhcmRzOyBncmFwZXZpbmUgYWNjZXB0aW5nIGBzZW5kIC0tZHJ5LXJ1bmAgYW5kIGRvaW5nIG5vdGhpbmcgd2FzIHRoZVxuLy8gc2FtZSBldmVudCB3aXRoIGEgZGlmZmVyZW50IHNwZWxsaW5nKS5cbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlcz86IHN0cmluZ1tdO1xuICBmbGFnczogRmxhZ05hbWVbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIC8qKlxuICAgKiDimqAgTUFZIFJFVFVSTiBBTiBFWElUIENPREUsIEFORCBFWEFDVExZIE9ORSBWRVJCIERPRVMuIGB0YWlsYCBydW5zIHRoZSBzaGFyZWRcbiAgICogY2xpZW50IChgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgKSwgd2hpY2ggUkVUVVJOUyBhIGNvZGUgcmF0aGVyIHRoYW5cbiAgICogZW5kaW5nIHRoZSBwcm9jZXNzIGZyb20gaW5zaWRlIHRocmVlIG5lc3RlZCBsb29wcyDigJQgc28gdGhlIGNvZGUgaGFzIHRvIHJlYWNoXG4gICAqIGBtYWluYCwgYW5kIHRoaXMgaXMgdGhlIHNlYW0gaXQgY3Jvc3Nlcy4gQW55dGhpbmcgdGhhdCBpcyBub3QgYSBudW1iZXIgbWVhbnNcbiAgICogMCwgd2hpY2ggaXMgd2hhdCB0aGUgb3RoZXIgdHdlbnR5LW9kZCB2ZXJicyByZXR1cm4uXG4gICAqXG4gICAqIOKaoCBUeXBlZCBgdW5rbm93bmAgcmF0aGVyIHRoYW4gYSB1bmlvbiB3aXRoIGB2b2lkYDogYSB1bmlvbiBpcyB3aGF0IGEgcmVhZGVyXG4gICAqIHdvdWxkIHdyaXRlIGZpcnN0LCBhbmQgZXZlcnkgYGFzeW5jYCB2ZXJiIHRoYXQgZW5kcyB3aXRob3V0IGEgYHJldHVybmAgaXNcbiAgICogYFByb21pc2U8dm9pZD5gLCB3aGljaCBpcyBOT1QgYXNzaWduYWJsZSB0byBgUHJvbWlzZTxudW1iZXIgfCB1bmRlZmluZWQ+YC5cbiAgICogVGhlIHdpZGVuaW5nIGhhcHBlbnMgYXQgdGhlIG9uZSBwbGFjZSB0aGF0IHJlYWRzIHRoZSB2YWx1ZSwgYmVsb3cuXG4gICAqL1xuICBydW46IChwb3NpdGlvbmFsOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzKSA9PiB1bmtub3duO1xufTtcblxuLy8gQSBkZWNsYXJlZCB2YWx1ZSBmbGFnIHRoYXQgY2FycmllcyBhIG51bWJlciBtdXN0IFJFSkVDVCBhIG5vbi1udW1iZXIgYXMgYVxuLy8gdXNhZ2UgZXJyb3IgKGV4aXQgMiksIG5vdCBjcmFzaCBvbiBpdCBkb3duc3RyZWFtIOKAlCBgc2NoZW1hYCBwdWJsaXNoZXMgdGhlXG4vLyBmbGFnIGFzIHZhbGlkLCBzbyB0aGUgcGFyc2UgYm91bmRhcnkgaXMgd2hlcmUgYSBiYWQgdmFsdWUgZ2V0cyBpdHNcbi8vIGNhbGxlci1mYWNpbmcgYW5zd2VyLiAoYHdhaXQgLS10aW1lb3V0IG5vdGFudW1iZXJgIHVzZWQgdG8gdGhyb3cgYW5cbi8vIHVuaGFuZGxlZCBSYW5nZUVycm9yIGF0IGV4aXQgMSwgc3RhY2sgdHJhY2UgYW5kIGFsbC4pXG5mdW5jdGlvbiBudW1lcmljRmxhZyh2ZXJiOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmF3OiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8IDApXG4gICAgZGllKGAke3ZlcmJ9OiAtLSR7bmFtZX0gZXhwZWN0cyBhIG5vbi1uZWdhdGl2ZSBudW1iZXIsIGdvdCAke0pTT04uc3RyaW5naWZ5KFN0cmluZyhyYXcpKX1gKTtcbiAgcmV0dXJuIG47XG59XG5cbi8vIEJvZHkgcmVzb2x1dGlvbiBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZSDigJQgZmlyc3QgbWF0Y2ggd2luczogLS1ib2R5LWZpbGUsXG4vLyAtLXN0ZGluLCBpbmxpbmUgcG9zaXRpb25hbHMsIGRlZmF1bHQtc3RkaW4gd2hlbiBwaXBlZC4gU2VlIHRoZSBwZXItdmVyYlxuLy8gY29tbWVudHMgYXQgdGhlIG9yaWdpbmFsIHNpdGVzIChWMS42LyM2MCk7IGJlaGF2aW91ciB1bmNoYW5nZWQuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQm9keShcbiAgdmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsXG4gIGlubGluZTogc3RyaW5nW10sXG4gIGZsYWdzOiBGbGFncyxcbik6IFByb21pc2U8eyB0ZXh0OiBzdHJpbmc7IGZyb21JbmxpbmU6IGJvb2xlYW4gfT4ge1xuICBpZiAoZmxhZ3NbXCJib2R5LWZpbGVcIl0pIHtcbiAgICBjb25zdCBwYXRoID0gZmxhZ3NbXCJib2R5LWZpbGVcIl0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICByZXR1cm4geyB0ZXh0OiAoYXdhaXQgZmlsZS50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSwgZnJvbUlubGluZTogZmFsc2UgfTtcbiAgfVxuICBpZiAoZmxhZ3Muc3RkaW4gfHwgKGlubGluZS5sZW5ndGggPT09IDAgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpKSB7XG4gICAgY29uc3QgYnVmOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcHJvY2Vzcy5zdGRpbikgYnVmLnB1c2goY2h1bmsgYXMgQnVmZmVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGV4dDogQnVmZmVyLmNvbmNhdChidWYpLnRvU3RyaW5nKFwidXRmLThcIikucmVwbGFjZSgvXFxuJC8sIFwiXCIpLFxuICAgICAgZnJvbUlubGluZTogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyB0ZXh0OiBpbmxpbmUuam9pbihcIiBcIiksIGZyb21JbmxpbmU6IHRydWUgfTtcbn1cblxuLy8gVGhlIHR3byBib2R5IGd1YXJkcyBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZTogcmVmdXNlIGEgbGVha2VkIGludm9jYXRpb25cbi8vIChmdW1ibGVkIGhlcmVkb2MpIHVubGVzcyAtLWZvcmNlLCBhbmQgd2FybiBvbiBzaGVsbCBtZXRhY2hhcmFjdGVycyB0aGF0XG4vLyBzdXJ2aXZlZCBhbiBpbmxpbmUgYm9keSAoIzYwIOKAlCB3YXJuLCBuZXZlciBibG9jaykuXG5mdW5jdGlvbiBndWFyZEJvZHkodmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsIHRleHQ6IHN0cmluZywgZnJvbUlubGluZTogYm9vbGVhbiwgZm9yY2U6IGJvb2xlYW4pIHtcbiAgaWYgKCFmb3JjZSAmJiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQpKSB7XG4gICAgZGllKFxuICAgICAgYCR7dmVyYn06IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGdyYXBldmluZSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgYCArXG4gICAgICAgIFwiaGVyZWRvYz8pLiBOb3RoaW5nIHdhcyBzZW50LiBQaXBlIHRoZSByZWFsIGJvZHkgdmlhIC0tc3RkaW4gb3IgXCIgK1xuICAgICAgICBcIi0tYm9keS1maWxlIDxwYXRoPiwgb3IgcGFzcyAtLWZvcmNlIHRvIHNlbmQgaXQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZyb21JbmxpbmUgJiYgbG9va3NTaGVsbFJpc2t5KHRleHQpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBcIiMg4pqgIGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgYmVmb3JlIFwiICtcbiAgICAgICAgXCJncmFwZXZpbmUgc2VlcyB0aGVtIOKAlCB1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbn1cblxuY29uc3QgaWRlbnRpdHlSZXF1aXJlZCA9ICh2ZXJiOiBzdHJpbmcpOiBuZXZlciA9PlxuICBkaWUoYCR7dmVyYn06IGlkZW50aXR5IHJlcXVpcmVkIOKAlCBwYXNzIC0tYXMvLS1mcm9tIDxhbGlhcz4gb3Igc2V0IEdSQVBFVklORV9GUk9NIGVudiB2YXJgKTtcblxuY29uc3QgQ09NTUFORFM6IENvbW1hbmRTcGVjW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5cIixcbiAgICBmbGFnczogW1widG9waWNcIiwgXCJmcmVzaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRPcGVuKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgdG9waWM6IGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbTogcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICAgZnJlc2g6IGZsYWdzLmZyZXNoID09PSB0cnVlLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidG9waWNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kVG9waWMoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIHBvc2l0aW9uYWwubGVuZ3RoID4gMSA/IHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIikgOiB1bmRlZmluZWQsXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxpc3RcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kTGlzdCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlbmRcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcInZlcmJvc2VcIiwgXCJmb3JjZVwiLCBcImluLXJlcGx5LXRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwb3NpdGlvbmFsWzBdO1xuICAgICAgY29uc3QgZnJvbSA9IHJlc29sdmVBbGlhcyhmbGFncyk7XG4gICAgICBjb25zdCB7IHRleHQsIGZyb21JbmxpbmUgfSA9IGF3YWl0IHJlc29sdmVCb2R5KFwic2VuZFwiLCBwb3NpdGlvbmFsLnNsaWNlKDEpLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJzZW5kXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwic2VuZFwiLCB0ZXh0LCBmcm9tSW5saW5lLCAhIWZsYWdzLmZvcmNlKTtcbiAgICAgIGF3YWl0IGNtZFNlbmQobmFtZSwgZnJvbSBhcyBzdHJpbmcsIHRleHQsIHtcbiAgICAgICAgcXVpZXQ6ICEhZmxhZ3MucXVpZXQsXG4gICAgICAgIHZlcmJvc2U6ICEhZmxhZ3MudmVyYm9zZSxcbiAgICAgICAgaW5SZXBseVRvOiBmbGFnc1tcImluLXJlcGx5LXRvXCJdXG4gICAgICAgICAgPyBudW1lcmljRmxhZyhcInNlbmRcIiwgXCJpbi1yZXBseS10b1wiLCBmbGFnc1tcImluLXJlcGx5LXRvXCJdLCAwKVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYW5ub3VuY2VcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcImZvcmNlXCIsIFwiY2hhbm5lbHNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJhbm5vdW5jZVwiLCBwb3NpdGlvbmFsLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJhbm5vdW5jZVwiKTtcbiAgICAgIGd1YXJkQm9keShcImFubm91bmNlXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgY29uc3QgY2hhbm5lbHMgPSBmbGFncy5jaGFubmVsc1xuICAgICAgICA/IChmbGFncy5jaGFubmVscyBhcyBzdHJpbmcpXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKChjKSA9PiBjLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBhd2FpdCBjbWRBbm5vdW5jZShmcm9tIGFzIHN0cmluZywgdGV4dCwgY2hhbm5lbHMsIHsgcXVpZXQ6ICEhZmxhZ3MucXVpZXQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHVsbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcInN0YXR1c1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwicHVsbFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGF3YWl0IGNtZFB1bGwocG9zaXRpb25hbFswXSwgc2luY2UsIHsgc3RhdHVzOiBmbGFncy5zdGF0dXMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRyaWFnZVwiLFxuICAgIGZsYWdzOiBbXCJodW1hblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUcmlhZ2UocG9zaXRpb25hbFswXSwgeyBodW1hbjogISFmbGFncy5odW1hbiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgZmxhZ3M6IFtcInRleHRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBpZCA9IHBvc2l0aW9uYWxbMV0gPyBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCkgOiBOYU47XG4gICAgICBhd2FpdCBjbWRSZWFkKHBvc2l0aW9uYWxbMF0sIGlkLCB7IHRleHQ6ICEhZmxhZ3MudGV4dCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3YWl0XCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwidGltZW91dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGNvbnN0IHRpbWVvdXQgPSBudW1lcmljRmxhZyhcIndhaXRcIiwgXCJ0aW1lb3V0XCIsIGZsYWdzLnRpbWVvdXQsIDMwKTtcbiAgICAgIGF3YWl0IGNtZFdhaXQocG9zaXRpb25hbFswXSwgc2luY2UsIHRpbWVvdXQsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndob1wiLFxuICAgIGZsYWdzOiBbXCJhbGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGlmIChmbGFncy5hbGwpIGF3YWl0IGNtZFdob0FsbCgpO1xuICAgICAgZWxzZSBhd2FpdCBjbWRXaG8ocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYWxpYXNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQWxpYXMocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFpbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcImZyb20tc3RhcnRcIiwgXCJsYXN0XCIsIFwiaHVtYW5cIiwgXCJsdXJrXCIsIFwibWF4XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIHJldHVybiBhd2FpdCBjbWRUYWlsKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgc2luY2U6IGZsYWdzLnNpbmNlICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInRhaWxcIiwgXCJzaW5jZVwiLCBmbGFncy5zaW5jZSwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGZyb21TdGFydDogISFmbGFnc1tcImZyb20tc3RhcnRcIl0sXG4gICAgICAgIGxhc3Q6IGZsYWdzLmxhc3QgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcImxhc3RcIiwgZmxhZ3MubGFzdCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGFzOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBodW1hbjogISFmbGFncy5odW1hbixcbiAgICAgICAgbHVyazogISFmbGFncy5sdXJrLFxuICAgICAgICBtYXg6IHJlc29sdmVUYWlsTWF4KGZsYWdzLm1heCksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmVwXCIsXG4gICAgZmxhZ3M6IFtcImxpdGVyYWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwicGF0dGVyblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRHcmVwKHBvc2l0aW9uYWxbMF0sIHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIiksIHtcbiAgICAgICAgbGl0ZXJhbDogISFmbGFncy5saXRlcmFsLFxuICAgICAgICBmcm9tOiBmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQ2xvc2UocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzZXRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzZXQocG9zaXRpb25hbFswXSwgeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFya1wiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiZGlzcG9zaXRpb25cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBwb3NpdGlvbmFsLnNsaWNlKDIpLmpvaW4oXCIgXCIpLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJtYXJrXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlb3BlblwiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBcIm9wZW5cIixcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwicmVvcGVuXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCBmYWxzZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidW5hcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFyY2hpdmUocG9zaXRpb25hbFswXSwgdHJ1ZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhcnRcIixcbiAgICBhbGlhc2VzOiBbXCJ1cFwiXSxcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kU3RhcnQoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXN0YXJ0XCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlc3RhcnQoeyBmb3JjZTogISFmbGFncy5mb3JjZSB8fCAhIWZsYWdzLnllcyB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyb2xsXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJvbGwoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfHwgZmxhZ3MueWVzID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0b3BcIixcbiAgICBmbGFnczogW1wiaG9sZFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdG9wKHtcbiAgICAgICAgaG9sZFNlY29uZHM6XG4gICAgICAgICAgZmxhZ3MuaG9sZCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJzdG9wXCIsIFwiaG9sZFwiLCBmbGFncy5ob2xkLCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhdGNoXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZFdhdGNoKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYXBcIixcbiAgICBhbGlhc2VzOiBbXCJwcnVuZVwiXSxcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJkcnktcnVuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlYXAoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUsIGRyeVJ1bjogZmxhZ3NbXCJkcnktcnVuXCJdID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kSW5mbygpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWREb2N0b3IoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIC8vIFRoZSBDTEkgY2FuIGJlIEFTS0VEIHdoYXQgaXQgaXMuIGdyYXBldmluZSBhbHJlYWR5IGNhcnJpZXNcbiAgICAgIC8vIFBMVUdJTl9WRVJTSU9OIHRvIHdhcm4gdGhhdCBhIGRhZW1vbiBpcyBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZCBwbHVnaW5cbiAgICAgIC8vIHBhdGggdGhhbiB0aGlzIENMSSAobWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gpIOKAlCBidXQgYSBjYWxsZXIgdGhhdCBoaXRcbiAgICAgIC8vIHRoYXQgd2FybmluZywgb3IgdGhhdCBydW5zIGByb2xsYCBmb3IgaXRzIHZlcnNpb24gdmVyaWZ5LCBoYWQgbm8gd2F5IHRvXG4gICAgICAvLyBhc2sgdGhpcyBzaWRlIHdoYXQgaXQgaXMgaG9sZGluZy4gVGhlIHZhbHVlIHdhcyBhbHJlYWR5IGluIG1lbW9yeTsgb25seVxuICAgICAgLy8gdGhlIHF1ZXN0aW9uIHdhcyBtaXNzaW5nLlxuICAgICAgLy8gSlNPTiBieSBkZWZhdWx0LCBtYXRjaGluZyBldmVyeSBkYXRhIGNvbW1hbmQ7IC0taHVtYW4gZm9yIHByb3NlLlxuICAgICAgaWYgKFBMVUdJTl9WRVJTSU9OID09PSBudWxsKVxuICAgICAgICBkaWUoXCJ2ZXJzaW9uIHVuYXZhaWxhYmxlIOKAlCBjb3VsZCBub3QgcmVhZCBwbHVnaW4uanNvblwiLCBcImludGVybmFsXCIpO1xuICAgICAgaWYgKGZsYWdzLmh1bWFuID09PSB0cnVlKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIHYke1BMVUdJTl9WRVJTSU9OfVxcbmApO1xuICAgICAgZWxzZSBwcmludEpzb24oeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgLy8gRW1pdCB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIOKAlCBnZW5lcmF0ZWQgYnlcbiAgICAgIC8vIFdBTEtJTkcgQ09NTUFORFMgYW5kIENMSV9PUFRJT05TLCB0aGUgc2FtZSBzdHJ1Y3R1cmVzIHRoZSBwYXJzZXIgYW5kXG4gICAgICAvLyBkaXNwYXRjaGVyIGNvbnN1bWUsIGF0IGFuc3dlciB0aW1lLiBObyBkYWVtb24sIG5vIGNvbmZpZywgbm9cbiAgICAgIC8vIGNyZWRlbnRpYWxzOyBzdGRvdXQsIGV4aXQgMC4gVGhlIHNoYXBlIGlzIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjBcbiAgICAgIC8vIGV4YWN0bHksIHNvIHRoZSBvdXRwdXQgcGlwZXMgc3RyYWlnaHQgaW50b1xuICAgICAgLy8gYGFjYyBjaGVjayA8Y2xpPiAtLWRlY2xhcmF0aW9uIDwoZ3JhcGV2aW5lIHNjaGVtYSlgIHdpdGggbm8gYWRhcHRlci5cbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcmludEhlbHAoKTtcbiAgICB9LFxuICB9LFxuXTtcblxuZnVuY3Rpb24gZmluZENvbW1hbmQodG9rZW46IHN0cmluZyk6IENvbW1hbmRTcGVjIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIENPTU1BTkRTLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gdG9rZW4gfHwgYy5hbGlhc2VzPy5pbmNsdWRlcyh0b2tlbikpO1xufVxuXG4vLyBUaGUgdmVyYidzIGZ1bGwgYWNjZXB0ZWQgc2V0OiBpdHMgb3duIGZsYWdzIHBsdXMgdGhlIGNvbnRyYWN0dWFsbHktZ2xvYmFsXG4vLyBpZGVudGl0eSBwYWlyLCBpbiByZWdpc3RyeSBvcmRlci5cbmZ1bmN0aW9uIGFjY2VwdGVkRmxhZ3Moc3BlYzogQ29tbWFuZFNwZWMpOiBGbGFnTmFtZVtdIHtcbiAgY29uc3Qgb3duID0gbmV3IFNldDxGbGFnTmFtZT4oWy4uLkdMT0JBTF9GTEFHUywgLi4uc3BlYy5mbGFnc10pO1xuICByZXR1cm4gKE9iamVjdC5rZXlzKENMSV9PUFRJT05TKSBhcyBGbGFnTmFtZVtdKS5maWx0ZXIoKGspID0+IG93bi5oYXMoaykpO1xufVxuXG4vLyBSb290IGludGVyY2VwdG9ycyDigJQgZmxhZ3MgdGhlIFJPT1QgYW5zd2VycyBpdHNlbGYsIGJlZm9yZSBhbnkgdmVyYi4gVGhlc2UgYXJlXG4vLyBub3QgY29tbWFuZHMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IGEgZ2VuZXJhdG9yIHdhbGtpbmcgXCJ0aGUgY29tbWFuZHNcIiB3YWxrc1xuLy8gcGFzdCB0aGVtIChhY2MgRFQtNik7IHRoZXkgYXJlIGRlY2xhcmVkIGV4cGxpY2l0bHkgYXQgYHBhdGg6IFtdYC5cbmNvbnN0IFJPT1RfSU5URVJDRVBUT1JTID0gW1xuICB7IG5hbWU6IFwiLS1oZWxwXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItaFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLS12ZXJzaW9uXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG4gIHsgbmFtZTogXCItVlwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuLy8gYWNjIGRlY2xhcmF0aW9uIGZvcm1hdCB2MCAoc2VlIGFnZW50LWNsaS1jb25mb3JtYW5jZSBzcmMvYWNjL2tpdC9kZWNsYXJhdGlvbi50cyk6XG4vLyB7IGZvcm1hdFZlcnNpb24sIHByb3ZlbmFuY2UsIHNlbGZEZXNjcmlwdGlvbiwgY29tbWFuZHM6IFt7IHBhdGgsIGFyZ3MsIHBvc2l0aW9uYWxzIH1dIH0uXG4vLyB2MCByZWZ1c2VzIHVua25vd24ga2V5cywgc28gbm90aGluZyByaWNoZXIgKGVmZmVjdHMsIHN1bW1hcmllcywgdmVyc2lvbnMpXG4vLyByaWRlcyBhbG9uZyDigJQgdGhvc2Ugd2FpdCBmb3IgYSB2MSB3aXRoIHNsb3RzIGZvciB0aGVtLlxuZnVuY3Rpb24gYnVpbGREZWNsYXJhdGlvbigpIHtcbiAgLy8gRXZlcnkgcmVnaXN0cnkgZmxhZyBpcyBhY2NlcHRlZCB0b2RheTsgYSByZWZ1c2FsIGxpc3Qgd291bGQgYWRkXG4gIC8vIHN0YXR1czogXCJyZWZ1c2VkXCIgZW50cmllcyBoZXJlIHRoZSBkYXkgYSB2ZXJiIHJlY29nbmlzZXMtYW5kLWRlY2xpbmVzIG9uZS5cbiAgY29uc3QgYXJnID0gKGs6IEZsYWdOYW1lKSA9PiAoe1xuICAgIG5hbWU6IGAtLSR7a31gLFxuICAgIHR5cGU6IENMSV9PUFRJT05TW2tdLnR5cGUsXG4gICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gIH0pO1xuICBjb25zdCBjb21tYW5kczoge1xuICAgIHBhdGg6IHN0cmluZ1tdO1xuICAgIGFyZ3M6IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBcInN0cmluZ1wiIHwgXCJib29sZWFuXCI7IHN0YXR1czogc3RyaW5nIH1bXTtcbiAgICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgfVtdID0gW1xuICAgIHtcbiAgICAgIC8vIGBwYXRoOiBbXWAgSVMgdGhlIHJvb3QuIEl0cyBncmFtbWFyOiBvbmUgcmVxdWlyZWQgdG9rZW4gc2VsZWN0aW5nIGFcbiAgICAgIC8vIGNvbW1hbmQsIG9yIGFuIGludGVyY2VwdG9yIGZsYWcgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuXG4gICAgICBwYXRoOiBbXSxcbiAgICAgIGFyZ3M6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgICB9KSksXG4gICAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIH0sXG4gIF07XG4gIGZvciAoY29uc3Qgc3BlYyBvZiBDT01NQU5EUykge1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbc3BlYy5uYW1lLCAuLi4oc3BlYy5hbGlhc2VzID8/IFtdKV0pIHtcbiAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICBwYXRoOiBbbmFtZV0sXG4gICAgICAgIGFyZ3M6IGFjY2VwdGVkRmxhZ3Moc3BlYykubWFwKChrKSA9PiBhcmcoaykpLFxuICAgICAgICBwb3NpdGlvbmFsczogc3BlYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbXCJzY2hlbWFcIl0gfSxcbiAgICBjb21tYW5kcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VGbGFncyhcbiAgYXJndjogc3RyaW5nW10sXG4gIHNwZWM6IENvbW1hbmRTcGVjLFxuKToge1xuICBwb3NpdGlvbmFsOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdzO1xufSB7XG4gIGNvbnN0IGFjY2VwdGVkID0gYWNjZXB0ZWRGbGFncyhzcGVjKTtcbiAgY29uc3Qgb3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhhY2NlcHRlZC5tYXAoKGspID0+IFtrLCBDTElfT1BUSU9OU1trXV0pKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBwb3NpdGlvbmFsOiBwb3NpdGlvbmFscyxcbiAgICAgIGZsYWdzOiB2YWx1ZXMgYXMgRmxhZ3MsXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAvLyBcInJlY29nbml6ZWQgZmxhZ3M6XCIgd2l0aCB0aGUgY29sb24gc3RyYWlnaHQgYWZ0ZXIgdGhlIG5vdW4g4oCUIHRoZSBleGFjdFxuICAgIC8vIG1hcmtlciBzaGFwZSBmbGFnLXNldCBleHRyYWN0b3JzIG1hdGNoIChcIlZhbGlkIGZsYWdzOiAtLXhcIiBhbmQga2luOyBhY2Mnc1xuICAgIC8vIE1BUktFUiByZWdleCBpcyB0aGUgbWVhc3VyZWQgY29uc3VtZXIpLiBBIHF1YWxpZmllciBiZXR3ZWVuIHRoZSBub3VuIGFuZFxuICAgIC8vIHRoZSBjb2xvbiAoXCJyZWNvZ25pemVkIGZsYWdzIGZvciBzZW5kOlwiKSByZWFkcyBhcyBwcm9zZSwgbm90IGEgc2V0LlxuICAgIGNvbnN0IGJvZHlIaW50ID1cbiAgICAgIHNwZWMubmFtZSA9PT0gXCJzZW5kXCIgfHwgc3BlYy5uYW1lID09PSBcImFubm91bmNlXCJcbiAgICAgICAgPyBcImZvciBhIG1lc3NhZ2UgYm9keSBjb250YWluaW5nIGRhc2hlcywgdXNlIC0tc3RkaW4gb3IgLS1ib2R5LWZpbGUsIFwiICtcbiAgICAgICAgICBcIm9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1cIlxuICAgICAgICA6IFwiXCI7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYCR7c3BlYy5uYW1lfTogJHtkZXRhaWx9YCwge1xuICAgICAgLy8g4puUIFRIRSBTRVQgSVMgYGNob2ljZXNgIE5PVywgTk9UIEEgUFJPU0UgTUFSS0VSLiBJdCB1c2VkIHRvIGJlIGEgc2Vjb25kXG4gICAgICAvLyBsaW5lIHJlYWRpbmcgYHJlY29nbml6ZWQgZmxhZ3M6IC0tYSAtLWJgLCBzcGVsbGVkIHdpdGggdGhlIGNvbG9uXG4gICAgICAvLyBzdHJhaWdodCBhZnRlciB0aGUgbm91biBiZWNhdXNlIHRoYXQgaXMgdGhlIG1hcmtlciBzaGFwZSBhIGZsYWctc2V0XG4gICAgICAvLyBleHRyYWN0b3IgbWF0Y2hlcy4gSW5zaWRlIGEgSlNPTiBlbnZlbG9wZSBhIHByb3NlIG1hcmtlciBpcyBhIHN1YnN0cmluZ1xuICAgICAgLy8gb2YgYW4gZXNjYXBlZCBzdHJpbmcsIHNvIGl0IGRvZXMgbm90IHN1cnZpdmUgYXMgcHJvc2Ug4oCUIGFuZCBpdCBkb2VzIG5vdFxuICAgICAgLy8gbmVlZCB0bzogYGNob2ljZXNgIGlzIHRoZSBlbnZlbG9wZSdzIGZpZWxkIGZvciBleGFjdGx5IHRoaXMsIGl0IGlzIHdoYXRcbiAgICAgIC8vIGdsYW1vdXIgcHVibGlzaGVzIGF0IENPTkZPUk1BTlQgTDAsIGFuZCBhbiBhcnJheSBjYW5ub3QgYmUgdHJ1bmNhdGVkIGJ5XG4gICAgICAvLyBhIHJlYWRlciB0aGF0IHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB3aGljaCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLlxuICAgICAgY2hvaWNlczogYWNjZXB0ZWQubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgICAuLi4oYm9keUhpbnQgPyB7IGhpbnQ6IGJvZHlIaW50IH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29tbWFuZFRva2VucygpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBDT01NQU5EUy5mbGF0TWFwKChjKSA9PiBbYy5uYW1lLCAuLi4oYy5hbGlhc2VzID8/IFtdKV0pO1xufVxuXG5mdW5jdGlvbiBwcmludEhlbHAoKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBncmFwZXZpbmUg4oCUIGFnZW50LXRvLWFnZW50IHdhbGtpZS10YWxraWVcblxuVXNhZ2U6XG4gIGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXSAgIG9wZW4vY3JlYXRlIChhdXRvLXVuYXJjaGl2ZXM7IC0tZnJlc2ggY2xlYXJzIGEgZG9ybWFudCBjaGFubmVsKVxuICBncmFwZXZpbmUgbGlzdFxuICBncmFwZXZpbmUgc2VuZCA8bmFtZT4gWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLXF1aWV0XSBbLS12ZXJib3NlXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tZm9yY2VdIFstLWluLXJlcGx5LXRvIDxpZD5dIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJvZHk6IGlubGluZSB0ZXh0LCAtLXN0ZGluLCAtLWJvZHktZmlsZSwgb3IgcGlwZWQgc3RkaW4gKGRlZmF1bHQgd2hlbiBubyBpbmxpbmUgdGV4dClcbiAgZ3JhcGV2aW5lIGFubm91bmNlIFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1jaGFubmVscyBhLGIsY10gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLXF1aWV0XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBicm9hZGNhc3Qgb25lIG1lc3NhZ2UgdG8gZXZlcnkgYWN0aXZlIGNoYW5uZWwgKG9yIC0tY2hhbm5lbHMpXG4gIGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcy8tLWZyb20gPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVxuICAgICAgICMgLS1sYXN0IDxuPjogYmFja2ZpbGwgdGhlIG1vc3QgcmVjZW50IG4gbWVzc2FnZXMgdGhlbiBnbyBsaXZlIChib3VuZGVkIGNhdGNoLXVwIGZvciBhIGNvbGQgam9pbmVyKVxuICBncmFwZXZpbmUgcHVsbCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tc3RhdHVzIDx2YWx1ZT5dICAgIyAtLXN0YXR1cyA9IGZ1bGwtc2NhbiBmaWx0ZXIgKG9wZW58d29udGZpeHxpbmNvcnBvcmF0ZWR84oCmKVxuICBncmFwZXZpbmUgdHJpYWdlIDxuYW1lPiAgICAgICAgICAgICAjIGZ1bGwtc2Nhbjogb3BlbiBtZXNzYWdlcyBvbiB0b3AgKyBncm91cGVkIGJ5X3N0YXR1c1xuICBncmFwZXZpbmUgbWFyayA8bmFtZT4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSAgIyBzZXQgZGlzcG9zaXRpb24gKGluY29ycG9yYXRlZHx3b250Zml4fGRlZmVycmVkfOKApilcbiAgZ3JhcGV2aW5lIHJlb3BlbiA8bmFtZT4gPGlkPiAgICAgICAgIyBib3VuY2UgYSBtZXNzYWdlIGJhY2sgdG8gb3BlblxuICBncmFwZXZpbmUgcmVhZCA8bmFtZT4gPGlkPiBbLS10ZXh0XSAgICMgb25lIGZ1bGwgbWVzc2FnZSBieSBpZCAoLS10ZXh0ID0gcHJvc2UpXG4gIGdyYXBldmluZSB3YWl0IDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS10aW1lb3V0IDxzPl1cbiAgZ3JhcGV2aW5lIGdyZXAgPG5hbWU+IDxwYXR0ZXJuPiBbLS1saXRlcmFsXSBbLS1mcm9tIDxhbGlhcz5dXG4gIGdyYXBldmluZSB0b3BpYyA8bmFtZT4gWzx0ZXh0Pl0gICAjIG5vIHRleHQg4oaSIHJlYWQgY3VycmVudDsgd2l0aCB0ZXh0IOKGkiB1cGRhdGVcbiAgZ3JhcGV2aW5lIHdobyA8bmFtZT4gICAgICAgICAgICAgICMgcm9zdGVyOyB0aGUgaHVtYW5zIGZpZWxkIGxpc3RzIGh1bWFuc1xuICBncmFwZXZpbmUgYWxpYXMgWzxuYW1lPl0gICAgICAgICAgIyBzZXQvc2hvdyB5b3VyIHBlcnNpc3RlZCBhbGlhcyAoY29uZmlnLmpzb24pXG4gIGdyYXBldmluZSB3YXRjaCBbPG5hbWU+XSAgICAgICAgICAjIG9wZW4gYnJvd3NlciB0YWI7IGxpdmUgY2hhdC1idWJibGUgdmlld1xuICBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXSAgICAgICAgICAgc25hcHNob3QgdGhlIGxvZyDihpIgfi8uZ3JhcGV2aW5lL2FyY2hpdmUsIHRoZW4gY2xlYXIgaXRcbiAgZ3JhcGV2aW5lIGFyY2hpdmUgPG5hbWU+ICAgICAgICAgICMgcmVhZC1vbmx5OiBrZWVwIGhpc3RvcnksIHJlamVjdCBzZW5kc1xuICBncmFwZXZpbmUgdW5hcmNoaXZlIDxuYW1lPiAgICAgICAgIyBicmluZyBhbiBhcmNoaXZlZCBjaGFubmVsIGJhY2tcbiAgZ3JhcGV2aW5lIGNsb3NlIDxuYW1lPiAgICAgICAgICAgICMgZGVzdHJ1Y3RpdmU6IGRlbGV0ZSB0aGUgbWVzc2FnZSBsb2dcbiAgZ3JhcGV2aW5lIHN0YXJ0ICAgICAgICAgICAgICAgICAgICMgZW5zdXJlIHRoZSBkYWVtb24gaXMgcnVubmluZyAoYWxpYXM6IHVwKTsgbm8gY2hhbm5lbFxuICBncmFwZXZpbmUgcmVzdGFydCBbLS1mb3JjZXwtLXllc10gIyBzdG9wICsgcmVzcGF3biBmcmVzaDsgLS1mb3JjZSB0byBvdmVycmlkZSB0aGUgbGl2ZS1mbGVldCBndWFyZFxuICBncmFwZXZpbmUgcm9sbCBbLS1mb3JjZV0gICAgICAgICAgIyBzYWZlIHJlc3RhcnQgKHN0b3AraG9sZCtyZXNwYXduKSArIHZlcnNpb24gdmVyaWZ5IOKAlCB0aGUgcmVjb21tZW5kZWQgZGVwbG95IHN0ZXBcbiAgZ3JhcGV2aW5lIHN0b3AgWy0taG9sZCA8c2Vjb25kcz5dICMga2lsbCB0aGUgZGFlbW9uOyAtLWhvbGQgc3VwcHJlc3NlcyBhdXRvLXJlc3Bhd24gZm9yIDxzPiBzZWNvbmRzICh1cGdyYWRlIHdpbmRvdylcbiAgZ3JhcGV2aW5lIGluZm9cbiAgZ3JhcGV2aW5lIGRvY3RvciAgICAgICAgICAgICAgICAgICMgaGVhbHRoIGNoZWNrIOKAlCBsYWJlbHMgZWFjaCBkYWVtb246IGF1dGhvcml0YXRpdmUgLyBvcnBoYW4gLyB1bnJlc3BvbnNpdmUgLyB1bmtub3duXG4gIGdyYXBldmluZSByZWFwIFstLWZvcmNlXSBbLS1kcnktcnVuXSAgIyBraWxsIG9ycGhhbiBkYWVtb25zOyAtLWZvcmNlIGFsc28ga2lsbHMgdW5yZXNwb25zaXZlOyBhbGlhczogcHJ1bmVcblxuICBncmFwZXZpbmUgc2NoZW1hICAgICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIChhY2MgZGVjbGFyYXRpb24gdjApXG4gIGdyYXBldmluZSAtLXZlcnNpb24gICAgICAgICAgICAgICAjIHRoaXMgQ0xJJ3MgdmVyc2lvbiAoYWxpYXM6IC1WLCB2ZXJzaW9uKVxuICBncmFwZXZpbmUgaGVscCAgICAgICAgICAgICAgICAgICAgIyB0aGlzIHVzYWdlIChhbGlhczogLS1oZWxwLCAtaClcblxuT3V0cHV0OlxuICBEYXRhIGNvbW1hbmRzIGVtaXQgSlNPTiBvbiBzdGRvdXQgYnkgREVGQVVMVDsgcGFzcyAtLWh1bWFuIGZvciBwcm9zZSB3aGVyZSBhXG4gIGNvbW1hbmQgb2ZmZXJzIGl0LiBEaWFnbm9zdGljcyBhbmQgd2FybmluZ3MgZ28gdG8gc3RkZXJyLCBuZXZlciBzdGRvdXQuXG4gIFVzYWdlIGVycm9ycyBleGl0IDIuIEVhY2ggY29tbWFuZCBhY2NlcHRzIGl0cyBPV04gZmxhZ3MgKHBsdXMgLS1hcy8tLWZyb20sXG4gIHdoaWNoIGFyZSBnbG9iYWwpIOKAlCBhbiB1bmtub3duIGZsYWcgZm9yIGEgdmVyYiBlbnVtZXJhdGVzIHRoYXQgdmVyYidzIHNldC5cblxuRW52OlxuICBHUkFQRVZJTkVfRlJPTSAgIERlZmF1bHQgaWRlbnRpdHkgYWxpYXMgKC0tZnJvbS8tLWFzIGFyZSBpbnRlcmNoYW5nZWFibGUpLlxuICBHUkFQRVZJTkVfSE9NRSAgIERhdGEgZGlyIChkZWZhdWx0IH4vLmdyYXBldmluZSkuXG5gKTtcbn1cblxuLyoqXG4gKiBUaGUgdmVyYiByb3V0ZXIuIEV2ZXJ5IHJlamVjdGlvbiBoZXJlIFJBSVNFUzsgbm90aGluZyB3cml0ZXMgaXRzIG93biBwcm9zZS5cbiAqXG4gKiDim5QgVEhJUyBGVU5DVElPTiBVU0VEIFRPIEJFIGBtYWluYCwgQU5EIElUUyBGT1VSIFJFSkVDVElPTlMgVVNFRCBUTyBCRVxuICogYHByb2Nlc3Muc3RkZXJyLndyaXRlKC4uLik7IHJldHVybiAyYCDigJQgYSBTRUNPTkQgZXJyb3IgY29udHJhY3QgYmVzaWRlIGBkaWVgLFxuICogd2l0aCBpdHMgb3duIHdvcmRpbmcsIGl0cyBvd24gbWFya2VycyBhbmQgbm8gYGtpbmRgIG9uIHRoZSB3aXJlLiBBIGdyZXAgZm9yXG4gKiBgZGllKGAgd291bGQgaGF2ZSByZXBvcnRlZCBcInRoZSBlcnJvciBjb250cmFjdCBpcyA0NiBzaXRlc1wiOyBpdCB3YXMgNDYgcGx1c1xuICogdGhlc2UsIGFuZCB0aGVzZSBhcmUgdGhlIG9uZXMgYW4gYWdlbnQgbWVldHMgZmlyc3QgKHBsYXlib29rIEI4OiBsb29rIGZvciB0aGVcbiAqIFJBSVNFLCBub3QgZm9yIHRoZSBoZWxwZXIpLiBUaGV5IG5vdyByYWlzZSB0aGUgc2FtZSBlbnZlbG9wZSBhcyB0aGUgcmVzdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbY21kLCAuLi5yZXN0XSA9IGFyZ3Y7XG5cbiAgLy8gQkFSRSBJTlZPQ0FUSU9OIElTIEEgVVNBR0UgRVJST1Ig4oCUIGV4aXQgMiwgdXNhZ2UgcG9pbnRlciBvbiBzdGRlcnIg4oCUIG5vdCBhXG4gIC8vIGhlbHAgcmVxdWVzdCBhdCBleGl0IDAuIGdyYXBldmluZSdzIGNhbGxlcnMgYXJlIGFnZW50czogYSBiYXJlIGNhbGwgaXMgYW5cbiAgLy8gdW5zZXQgc2hlbGwgdmFyaWFibGUgZXhwYW5kaW5nIHRvIG5vdGhpbmcsIG9yIGEgbWlzdGFrZSwgYW5kIGFuc3dlcmluZyBpdFxuICAvLyB3aXRoIDIuOUtCIG9mIGhlbHAgYXQgZXhpdCAwIHJlcG9ydHMgc3VjY2VzcyBmb3IgYSBjb21tYW5kIHRoYXQgYXNrZWQgZm9yXG4gIC8vIG5vdGhpbmcuIGBoZWxwYCAvIGAtLWhlbHBgIHJlbWFpbiBvbmUgdG9rZW4gYXdheSBhdCBleGl0IDAgKGFjYyBEMiDigJRcbiAgLy8gY29uZm9ybWVkIGZvciB0aGF0IHJlYXNvbiwgbm90IGJlY2F1c2UgdGhlIHJ1bGUgc2FpZCBzbykuXG4gIGlmIChjbWQgPT09IHVuZGVmaW5lZCkge1xuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IGNvbW1hbmRUb2tlbnMoKSxcbiAgICAgIGhpbnQ6IFwicnVuIGBncmFwZXZpbmUgaGVscGAgKG9yIC0taGVscCkgZm9yIHVzYWdlXCIsXG4gICAgfSk7XG4gIH1cblxuICAvLyBST09UIEZMQUcgUk9VVElORy4gQSBsZWFkaW5nIC0tdG9rZW4gdXNlZCB0byBiZSBjb25zdW1lZCBhcyB0aGUgQ09NTUFORFxuICAvLyB0b2tlbiBhbmQgcmVqZWN0ZWQgYXMgYHVua25vd24gY29tbWFuZDogLS1ub3BlYCDigJQgYSBmbGFnIHJlYWNoaW5nIHRoZSB2ZXJiXG4gIC8vIHBhcnNlcidzIGVycm9yIHBhdGgsIHdoZXJlIHRoZSByZWplY3Rpb24gY291bGQgbm90IGVudW1lcmF0ZSB0aGUgZmxhZyBzZXRcbiAgLy8gKGZvdW5kIHZpYSBhY2MncyByb290LW9ubHkgc3VyZmFjZSBjYXB0dXJlKS4gVGhlIHJvb3QncyBhY2NlcHRlZCBmbGFncyBhcmVcbiAgLy8gdGhlIGludGVyY2VwdG9yczsgYW55dGhpbmcgZWxzZSBkYXNoZWQgaXMgcmVqZWN0ZWQgQVMgQSBGTEFHLCBlbnVtZXJhdGluZ1xuICAvLyB0aGUgcm9vdCdzIG93biBzZXQuXG4gIGlmIChjbWQuc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gY21kKTtcbiAgICBpZiAoIWludGVyY2VwdG9yKSB7XG4gICAgICAvLyDimqAgVEhFIFNPUlQgU1VSVklWRVMgVEhFIE1PVkUgSU5UTyBgY2hvaWNlc2AsIEFORCBJVCBJUyBOT1QgREVDT1JBVElPTi5cbiAgICAgIC8vIExvbmcgZmxhZ3MgZmlyc3QsIGJlY2F1c2UgYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZHMgdGhlIGxpc3RcbiAgICAgIC8vIGxlZnQtdG8tcmlnaHQgYW5kIHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcsXG4gICAgICAvLyBzbyBhIHNob3J0IGFsaWFzIG1pZC1saXN0IHRydW5jYXRlcyB3aGF0IGl0IHNlZXMuIEFuIGFycmF5IGlzIG5vdFxuICAgICAgLy8gdnVsbmVyYWJsZSB0byB0aGF0IOKAlCBidXQgdGhlIG9yZGVyIGlzIGZyZWUgYW5kIHRoZSBwcm9wZXJ0eSBpcyByZWFsIGZvclxuICAgICAgLy8gYW55IGNvbnN1bWVyIHRoYXQgZmxhdHRlbnMgaXQgYmFjayB0byBhIGxpbmUuXG4gICAgICBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtjbWR9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGNob2ljZXM6IFsuLi5ST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSldLnNvcnQoXG4gICAgICAgICAgKGEsIGIpID0+IE51bWJlcihiLnN0YXJ0c1dpdGgoXCItLVwiKSkgLSBOdW1iZXIoYS5zdGFydHNXaXRoKFwiLS1cIikpLFxuICAgICAgICApLFxuICAgICAgICBoaW50OiBgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7Y29tbWFuZFRva2VucygpLmpvaW4oXCIgXCIpfWAsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGF3YWl0IHJ1bkNvbW1hbmQoZmluZENvbW1hbmQoaW50ZXJjZXB0b3IucnVucykgYXMgQ29tbWFuZFNwZWMsIHJlc3QpO1xuICB9XG5cbiAgY29uc3Qgc3BlYyA9IGZpbmRDb21tYW5kKGNtZCk7XG4gIGlmICghc3BlYykge1xuICAgIC8vIFRoZSB1bmtub3duLXZlcmIgcmVqZWN0aW9uIGVudW1lcmF0ZXMgdGhlIHZhbGlkIHNldCwgZXhhY3RseSBhcyB0aGVcbiAgICAvLyB1bmtub3duLWZsYWcgcmVqZWN0aW9uIGRvZXMg4oCUIHRoZSBwYXJzZXIncyBvd24gYWNjb3VudCBvZiB3aGF0IGl0XG4gICAgLy8gYWNjZXB0cywgcHJvZHVjZWQgYnkgdGhlIHBhcnNlciAoYWNjIFNUQU5EQVJELm1kLCBcInRoZSBjaGVhcGVzdCB2ZXJzaW9uXG4gICAgLy8gb2YgY2hlY2tlZFwiKS5cbiAgICBkaWUoYHVua25vd24gY29tbWFuZDogJHtjbWR9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXM6IGNvbW1hbmRUb2tlbnMoKSB9KTtcbiAgfVxuICByZXR1cm4gYXdhaXQgcnVuQ29tbWFuZChzcGVjLCByZXN0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuQ29tbWFuZChzcGVjOiBDb21tYW5kU3BlYywgcmVzdDogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9zaXRpb25hbDogc3RyaW5nW107XG4gIGxldCBmbGFnczogRmxhZ3M7XG4gIHRyeSB7XG4gICAgKHsgcG9zaXRpb25hbCwgZmxhZ3MgfSA9IHBhcnNlRmxhZ3MocmVzdCwgc3BlYykpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKCEoZSBpbnN0YW5jZW9mIFVzYWdlRXJyb3IpKSB0aHJvdyBlO1xuICAgIGRpZShlLm1lc3NhZ2UsIFwidXNhZ2VcIiwgZS5leHRyYSk7XG4gIH1cbiAgLy8gQXJpdHksIGVuZm9yY2VkIEZST00gVEhFIERFQ0xBUkVEIFNIQVBFIOKAlCB0aGUgcmVnaXN0cnkncyBwb3NpdGlvbmFsIHNwZWMgaXNcbiAgLy8gd2hhdCBgc2NoZW1hYCBwdWJsaXNoZXMsIHNvIGVuZm9yY2luZyBpdCBoZXJlIGlzIHdoYXQga2VlcHMgdGhlIGRlY2xhcmF0aW9uXG4gIC8vIHRydWUgYnkgY29uc3RydWN0aW9uOiBhIG1pc3NpbmcgcmVxdWlyZWQgcG9zaXRpb25hbCBlcnJvcnMgYmVmb3JlIHRoZSB2ZXJiXG4gIC8vIHJ1bnMsIGFuZCBhbiBFWENFU1MgcG9zaXRpb25hbCBpcyByZWplY3RlZCByYXRoZXIgdGhhbiBzaWxlbnRseSBzd2FsbG93ZWRcbiAgLy8gKGFjYyBBNCdzIHNoYXBlIOKAlCB0aGUgZGVmZWN0IG5vIGV4dGVybmFsIGNoZWNrIGNhbiBzZWUpLlxuICBjb25zdCByZXF1aXJlZCA9IHNwZWMucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gIGNvbnN0IHZhcmlhZGljID0gc3BlYy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgaWYgKHBvc2l0aW9uYWwubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICBjb25zdCBtaXNzaW5nID0gc3BlYy5wb3NpdGlvbmFsc1twb3NpdGlvbmFsLmxlbmd0aF07XG4gICAgZGllKGAke3NwZWMubmFtZX06IG1pc3NpbmcgcmVxdWlyZWQgPCR7bWlzc2luZz8ubmFtZSA/PyBcImFyZ3VtZW50XCJ9PmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogYGV4cGVjdHM6ICR7c3BlYy5uYW1lfSAke3NwZWMucG9zaXRpb25hbHNcbiAgICAgICAgLm1hcCgocCkgPT4gKHAucmVxdWlyZWQgPyBgPCR7cC5uYW1lfT5gIDogYFske3AubmFtZX1dYCkpXG4gICAgICAgIC5qb2luKFwiIFwiKX1gLFxuICAgIH0pO1xuICB9XG4gIGlmICghdmFyaWFkaWMgJiYgcG9zaXRpb25hbC5sZW5ndGggPiBzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aCkge1xuICAgIGRpZShcbiAgICAgIGAke3NwZWMubmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsW3NwZWMucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogYGV4cGVjdHM6ICR7c3BlYy5uYW1lfSAke1xuICAgICAgICAgIHNwZWMucG9zaXRpb25hbHMubWFwKChwKSA9PiAocC5yZXF1aXJlZCA/IGA8JHtwLm5hbWV9PmAgOiBgWyR7cC5uYW1lfV1gKSkuam9pbihcIiBcIikgfHxcbiAgICAgICAgICBcIihubyBhcmd1bWVudHMpXCJcbiAgICAgICAgfWAsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHNwZWMucnVuKHBvc2l0aW9uYWwsIGZsYWdzKTtcbiAgcmV0dXJuIHR5cGVvZiBvdXRjb21lID09PSBcIm51bWJlclwiID8gb3V0Y29tZSA6IDA7XG59XG5cbi8qKlxuICogVGhlIG9uZSBwbGFjZSB0aGlzIENMSSBjYW4gZW5kLCBhbmQgdGhlIG9uZSBwbGFjZSBhIGBDbGlFcnJvcmAgYmVjb21lcyBhblxuICogZXhpdCBjb2RlLlxuICpcbiAqIOKblCBBRERFRCBBVCBQSEFTRSA2IENIQVBURVIgMiwgQU5EIElUIElTIFdIQVQgTUFLRVMgYGRpZWAgU0FGRSBUTyBUSFJPVy5cbiAqIGByZXBvcnRDbGlFcnJvcmAgd3JpdGVzIHRoZSBlbnZlbG9wZSBhbmQgaGFuZHMgYmFjayB0aGUgdGF4b25vbXkgY29kZTsgYVxuICogdGhyb3cgaXQgZG9lcyBOT1QgcmVjb2duaXNlIGlzIHJlLXRocm93biwgYmVjYXVzZSBzd2FsbG93aW5nIGFuIHVua25vd24gb25lXG4gKiBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGVcbiAqIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICpcbiAqIOKaoCBBTkQgYHNldEN1cnJlbnRDb21tYW5kYCBJUyBOT1QgREVDT1JBVElPTiDigJQgaXQgaXMgdGhlIGBtZXRhLmNvbW1hbmRgIGZpZWxkXG4gKiBvZiBldmVyeSBlbnZlbG9wZSB0aGlzIENMSSBlbWl0cywgd2hpY2ggaXMgaG93IGEgY2FsbGVyIHJvdXRpbmcgb24gYGtpbmRgXG4gKiBrbm93cyBXSElDSCB2ZXJiIHByb2R1Y2VkIGl0LiBTZXQgZnJvbSB0aGUgcmF3IHRva2VuIHNvIGFuIHVua25vd24gdmVyYiBzdGlsbFxuICogbmFtZXMgaXRzZWxmIGluIGl0cyBvd24gcmVqZWN0aW9uLlxuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKGNvZGUgIT09IG51bGwpIHJldHVybiBjb2RlO1xuICAgIHRocm93IGU7XG4gIH1cbn1cblxuLy8g4puUIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIElUUyBBQlNFTkNFIElTIFRIRSBTVEVQIChwbGF5Ym9vayBCMykuXG4vLyBgZGlzdC9jbGkuanNgIGlzIElNUE9SVEVEIGJ5IGBzY3JpcHRzL2NsaS50c2AsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzXG4vLyBlbnRyeSwgc28gdGhlIGd1YXJkIHdvdWxkIG5ldmVyIHJ1biBhbmQgZXZlcnkgdmVyYiB3b3VsZCBwcmludCBub3RoaW5nIGFuZFxuLy8gZXhpdCAwLiBOb3IgbWF5IHRoaXMgZmlsZSBvZmZlciBhIHNlY29uZCBlbnRyeSBmcm9tIGl0cyBhdXRob3JpbmcgYWRkcmVzczpcbi8vIGBTS0lMTF9ST09UYCwgYERJU1RfRElSYCwgYFNVUkZBQ0VfQ1dEYCBhbmQgYERBRU1PTl9TQ1JJUFRgIGFib3ZlIGFyZSBhbGxcbi8vIGNvbXB1dGVkIGZyb20gYFNDUklQVF9ESVJgIGFuZCBhcmUgY29ycmVjdCBvbmx5IGZyb20gYGRpc3QvYC5cbi8vXG4vLyBUaGUgZHJhaW4gY29udHJhY3QgbGl2ZXMgYXQgdGhlIGxhdW5jaGVyIG5vdyDigJQgYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4vLyByZXR1cm4sIG5ldmVyIGFuIGV4cGxpY2l0IGV4aXQsIGJlY2F1c2UgQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhXG4vLyBwaXBlIGFuZCBgdGFpbGAgd3JpdGVzIEpTT05MIGEgY2FsbGVyIHBhcnNlcy4gU2VlXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2NsaS50c2AgZm9yIHRoZSBmdWxsIGFjY291bnQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuIDEuMy4xNCBmaW5kaW5nIHRoYXRcbiAqIGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy4gSXQgaXMgYSBEQUVNT04tc2lkZVxuICogZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnlcbiAqIGNsaWVudC4gSXQgc3RheXMgd2hlcmUgaXQgd2FzIG1lYXN1cmVkLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLiAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiAqL1xuICB0ZXJtaW5hbD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKTogeyBmcmFtZTogU3NlRnJhbWUgfCBudWxsOyBjb21tZW50czogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHJldHVybiBjb2RlO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2KSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBHcmFwZXZpbmUncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIG9mIHRoZSBzcGVsbCwgYW5kIFRIRSBPTkUgUExBQ0UgVEhFIEVOViBJUyBSRUFELlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0sIEFORCBGT1IgR1JBUEVWSU5FIFRIRSBTRUFNIElTIFJFQUwg4oCUIHRoZSBmaXJzdCB0aW1lXG4gKiBpbiBmb3VyIHBvcnRzIChwbGF5Ym9vayBCOCwgZW50cnktYmxvY2sgcXVlc3Rpb24gMykuIEJlZm9yZSBQaGFzZSA2IHRoZVxuICogaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDMwMDBgIGluc2lkZSBgZGFlbW9uLnRzYCdzIFNTRSBzdHJlYW0sIGBpZGxlVGltZW91dDpcbiAqIDI1NWAgd2FzIGEgc2Vjb25kIGxpdGVyYWwgdGVuIGxpbmVzIGF3YXkgd2l0aCB0aGUgcmVsYXRpb25zaGlwIHdyaXR0ZW4gb25seSBpblxuICogcHJvc2UsIGFuZCBgY2xpLnRzYCdzIHRhaWwgaGFkIE5PIHdhdGNoZG9nIGF0IGFsbCDigJQgaXQgYmxvY2tlZCBvblxuICogYHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIHRoZSBraXQncyB3YXRjaGRvZyBleGlzdHMgdG9cbiAqIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uXG4gKiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHNcbiAqIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqIEEgdmFsdWUgdGhhdCBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBHUkFQRVZJTkUnUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgdGhlIHJ1bGUgYXN0cm9sYWJlIHBhaWQgZm9yOiBhIGhhcmQtY29kZWQgNDUgc1xuICogd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcyxcbiAqICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZVxuICogYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4g4pqgIEdyYXBldmluZSBpcyB0aGUgc3BlbGwgdGhhdFxuICogbWFrZXMgdGhlIHBvaW50IHNoYXJwZXN0OiBpdCBiZWF0cyBhdCAqKjMgcyoqLCBhIGZpZnRoIG9mIHRoZSBob3VzZSBkZWZhdWx0LFxuICogc28gYSBjb3BpZWQgNDUsMDAwIHdvdWxkIHRvbGVyYXRlIEZJRlRFRU4gbWlzc2VkIGJlYXRzIHdoZXJlIGV2ZXJ5IHNpYmxpbmdcbiAqIHRvbGVyYXRlcyB0aHJlZS4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBiZWF0IGl0XG4gKiBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDim5QgKipBTkQgXCJXSEFURVZFUiBUSEUgQkVBVCBCRUNPTUVTXCIgSVMgV0hZIFRIRSBFTlYgSVMgUkVTT0xWRUQgSEVSRSBBTkRcbiAqIE5PV0hFUkUgRUxTRSAoRDc1KS4gVEhFIFBPUlQgUkUtQ1JFQVRFRCBBU1RST0xBQkUnUyBERUZFQ1QgSU4gVEhJUyBGSUxFLioqXG4gKiBDaGFwdGVyIDIgc2hpcHBlZCBgSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMocHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hFQVJUQkVBVF9NUyxcbiAqIOKApilgIGF0IGBkYWVtb24udHM6MTEyYCB3aGlsZSB0aGlzIGZpbGUga2VwdCBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWBcbiAqIGFnYWluc3QgdGhlIExJVEVSQUwgMywwMDA6IHRoZSBkYWVtb24ncyBiZWF0IHdhcyB0dW5hYmxlIGFuZCB0aGUgQ0xJJ3NcbiAqIHdhdGNoZG9nIHdhcyBub3QsIHNvICoqYW55IHZhbHVlIGFib3ZlIDMsMDAwIGJyb2tlIGV2ZXJ5IHRhaWwuKiogTUVBU1VSRUQgYXRcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTIwMDAwYCBhZ2FpbnN0IGEgaGVhbHRoeSBkYWVtb24sIGJlZm9yZSB0aGUgcmVwYWlyOiBhXG4gKiByZWFsIGBjbGkudHMgdGFpbGAgcmUtc3Vic2NyaWJlZCAqKjQgdGltZXMgaW4gMzAgcyoqICh+OSBzIGFwYXJ0LCBpdHMgd2F0Y2hkb2dcbiAqIGZpcmluZyBiZWZvcmUgYSBzaW5nbGUgMjAgcyBiZWF0IGNvdWxkIGxhbmQg4oCUICoqMCBrZWVwYWxpdmVzIGFycml2ZWQqKiksIGFuZFxuICogYC9jaGFubmVscy93ZC9zdWJzY3JpYmVyc2AgcmVwb3J0ZWQgYGNvdW50OiAyLCBjb25uZWN0aW9uczogMiwgbmFtZWQ6IDJgIGZvclxuICogKipvbmUqKiBsaXZlIHRhaWwsIGJlY2F1c2UgdGhlIGFiYW5kb25lZCBzdHJlYW1zIGFyZSBub3QgcmVhcGVkIHVudGlsIHRoZVxuICogbm93LTIwIHMgYmVhdCBmYWlscyB0byBlbnF1ZXVlLiBUaGF0IGlzIHRoZSBhc3Ryb2xhYmUgc2NhciB0d28gcGFyYWdyYXBocyB1cCxcbiAqIHJlLWNyZWF0ZWQgaW5zaWRlIHRoZSBmaWxlIHRoYXQgZG9jdW1lbnRzIGl0LiAqKk9uZSBoYWxmIG9mIHRoZSBwYWlyIHR1bmFibGVcbiAqIGFuZCB0aGUgb3RoZXIgYSBjb25zdGFudCBJUyB0aGUgZGVmZWN0Kiog4oCUIHRoZSBkZXJpdmF0aW9uIG9ubHkgaG9sZHMgaWYgaXRcbiAqIGRlcml2ZXMgZnJvbSB0aGUgdmFsdWUgdGhhdCBhY3R1YWxseSBzaGlwcGVkLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqIGBwcm9jZXNzLmVudmAgaXMgbm90IHN1Y2ggYW4gaW1wb3J0OiBpdCBpcyBhbWJpZW50IGluIGJvdGggaGFsdmVzLCB3aGljaCBpc1xuICogZXhhY3RseSB3aHkgdGhpcyBmaWxlIOKAlCBhbmQgbm90IGBkYWVtb24udHNgIOKAlCBjYW4gaG9sZCB0aGUgcmVzb2x1dGlvbi4gKFRoaXNcbiAqIGlzIGJvdW50eSdzIHNoYXBlLCB1bmNoYW5nZWQ6IGBzcmMvYm91bnR5L2JhY2tlbmQvaGVhcnRiZWF0LnRzYCByZXNvbHZlc1xuICogYEJPVU5UWV9JRExFX1RJTUVPVVRfU0VDYCBhbmQgYEJPVU5UWV9IRUFSVEJFQVRfTVNgIGluIHRoZSBzZWFtIGZpbGUgZm9yIHRoZVxuICogc2FtZSByZWFzb24uKVxuICovXG5cbmltcG9ydCB7XG4gIGhlYXJ0YmVhdE1zLFxuICBpZGxlVGltZW91dFNlYyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtLCBpbiBzZWNvbmRzLiBHcmFwZXZpbmUncyBvd24gbWVhc3VyZWQgdmFsdWUsIG5vdCBhbiBpbmhlcml0ZWRcbiAqIG9uZTogYGRhZW1vbi50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50IHJlY29yZGluZyB0aGF0XG4gKiBCdW4ncyBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhc1xuICogc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcyDigJQgYW5kIHRoYXQgYDBgIGlzIG5vdCBcImRpc2FibGVkXCIsIGl0IGlzIHRoZVxuICogZGVmYXVsdC5cbiAqXG4gKiDimqAgYEdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDYCBpcyBhY2NlcHRlZCBzbyB0aGUgUEFJUiBjYW4gYmUgdHVuZWQgdG9nZXRoZXIsXG4gKiBhbmQgdGhlIGNsYW1wIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuIChUaGlzIGZpbGUgdXNlZCB0byBzYXlcbiAqIGdyYXBldmluZSBcImRvZXMgbm90IGVudi10dW5lIGl0XCIgd2hpbGUgYGRhZW1vbi50c2AgZW52LXR1bmVkIGl0IHRlbiBsaW5lcyBmcm9tXG4gKiB3aGVyZSBpdCBpbXBvcnRlZCB0aGlzIGNvbnN0YW50IOKAlCB0aGUgc2FtZSBvbmUtaGFsZi10dW5hYmxlIHNwbGl0IGFzIHRoZSBiZWF0LFxuICogYW5kIGNvcnJlY3RlZCBpbiB0aGUgc2FtZSBjaGFwdGVyLilcbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBpZGxlVGltZW91dFNlYyhcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqXG4gKiBUaGUgU1NFIGtlZXBhbGl2ZSwgaW4gbXMg4oCUIHRoZSBERUZBVUxULCBiZWZvcmUgdGhlIGVudiBpcyBjb25zdWx0ZWQuXG4gKiDimqAgKiozIHMsIGFuZCBpdCBpcyBOT1QgdGhlIGhvdXNlIGRlZmF1bHQgb2YgMTUgcyoqIOKAlCBncmFwZXZpbmUgaXMgdGhlIG9ubHlcbiAqIHNwZWxsIGluIHRoZSByb3N0ZXIgdGhhdCBiZWF0cyB0aGlzIGZhc3QsIGFuZCB0aGUgbnVtYmVyIGlzIGxvYWQtYmVhcmluZ1xuICogcmF0aGVyIHRoYW4gaW5jaWRlbnRhbDogdGhlIGJlYXQgaXMgYWxzbyBncmFwZXZpbmUncyBkZWFkLXN1YnNjcmliZXIgcHJvYmUuIEFcbiAqIHRhaWwgd2hvc2Ugc29ja2V0IGhhcyBnb25lIGF3YXkgaXMgZGlzY292ZXJlZCB3aGVuIHRoZSBlbnF1ZXVlIGZhaWxzLCBhbmRcbiAqIHVudGlsIGl0IGlzIGRpc2NvdmVyZWQgYHdob2AsIGAvcHJlc2VuY2VgIGFuZCBldmVyeSBzZW5kJ3MgcmVjaXBpZW50IGNvdW50XG4gKiByZXBvcnQgYSBnaG9zdC4gRXZlcnkgb3RoZXIgc3BlbGwncyBoZWFydGJlYXQgb25seSBoYXMgdG8ga2VlcCBhIGNvbm5lY3Rpb25cbiAqIG9wZW47IHRoaXMgb25lIGFsc28gaGFzIHRvIGtlZXAgYSBST1NURVIgaG9uZXN0LCB3aGljaCBpcyBhIGh1bWFuLXZpc2libGVcbiAqIG51bWJlciBpbiB0aGUgd2F0Y2ggc3VyZmFjZS4g4puUICoqU28gcmFpc2luZyB0aGlzIGtub2IgbWFrZXMgcHJlc2VuY2VcbiAqIHN0YWxlciwgbm90IGp1c3QgcXVpZXRlcioqIOKAlCBpdCBpcyB0aGUgb25lIHRoaW5nIGFuIG9wZXJhdG9yIHR1bmluZyBpdCBzaG91bGRcbiAqIGtub3cuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMgPSAzXzAwMDtcblxuLyoqXG4gKiBUaGUgYmVhdCBhcyBpdCB3aWxsIGFjdHVhbGx5IGJlIHVzZWQsIGVudi1yZXNvbHZlZCBhbmQgY2xhbXBlZCBhdCBib3RoIGVuZHMgYnlcbiAqIHRoZSBraXQ6IG5ldmVyIGFib3ZlIGBJRExFX1RJTUVPVVRfU0VDIC8gMmAgKG9yIEJ1biBjbG9zZXMgdGhlIGNvbm5lY3Rpb24gdGhlXG4gKiBrZWVwYWxpdmUgd2FzIHByZXNlcnZpbmcpLCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICog4puUIFRIRSBGTE9PUiBJUyBOT1QgREVDT1JBVElPTiAoRDc2KS4gYGludE9yYCBwYXJzZXMgd2l0aCBgcGFyc2VJbnRgLCB3aGljaFxuICogcmVhZHMgYFwiMWU5XCJgIOKAlCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0IGh1Z2VcIiDigJQgYXMgKioxKiouXG4gKiBEcml2ZW4gYmVmb3JlIHRoZSBmbG9vciBleGlzdGVkOiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4XG4gKiBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRSBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAg4oaSIDMgbXMgYW5kXG4gKiBgXCI1YWJjXCJgIOKGkiA1IG1zIGFycml2ZSB0aGUgc2FtZSB3YXkuIFRoZSBmbG9vciBsaXZlcyBpbiB0aGUga2l0J3NcbiAqIGBoZWFydGJlYXRNc2AgYmVzaWRlIHRoZSBjZWlsaW5nIGl0IGNhbm5vdCBjcm9zcywgTk9UIGluIGBpbnRPcmAsIHdoaWNoIGV2ZXJ5XG4gKiBvdGhlciBrbm9iIGluIHRoZSBob3VzZSBzaGFyZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC4gOSwwMDAgbXMgYXQgdGhlIGRlZmF1bHQuXG4gKlxuICog4puUICoqVEhFIFRBSUwgSEFEIE5PIFdBVENIRE9HIEFUIEFMTCBCRUZPUkUgVEhJUy4qKiBgY21kVGFpbGAncyBpbm5lciBsb29wXG4gKiBhd2FpdGVkIGByZWFkZXIucmVhZCgpYCB3aXRoIG5vdGhpbmcgYm91bmRpbmcgaXQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlclxuICogbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYSBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSIOKAlCBhbmRcbiAqIGEgcGFya2VkIHRhaWwgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHF1aWV0IGNoYW5uZWwsIHdoaWNoIGlzIHRoZSBzdGF0ZVxuICogZ3JhcGV2aW5lJ3MgY2FsbGVycyBzcGVuZCBtb3N0IG9mIHRoZWlyIHRpbWUgaW4uXG4gKlxuICog4pqgIDkgcyBpcyBhZ2dyZXNzaXZlIGJ5IGhvdXNlIHN0YW5kYXJkcyAoNDUgcyBldmVyeXdoZXJlIGVsc2UpIGFuZCB0aGF0IGlzIHRoZVxuICogZGVyaXZhdGlvbiB3b3JraW5nLCBub3QgYSBtaXN0YWtlOiBpdCBpcyB0aHJlZSBvZiBUSElTIHNwZWxsJ3MgYmVhdHMuIEhvbGRpbmdcbiAqIHRoZSBjb25uZWN0aW9uIG9wZW4gSVMgYSB0YWlsJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzXG4gKiBhIG5hbWUgaW4gYSBodW1hbidzIHJvc3RlciDigJQgd2hpY2ggaXMgd2h5IGl0IGlzIHRocmVlIGJlYXRzIGFuZCBub3QgdHdvLlxuICpcbiAqIOKblCBERVJJVkVEIEZST00gVEhFIFJFU09MVkVEIEJFQVQsIE5FVkVSIEZST00gVEhFIERFRkFVTFQuIEl0IGlzXG4gKiBgU1NFX0hFQVJUQkVBVF9NU2AgYWJvdmUgYW5kIG5vdCBgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TYCBvbiBwdXJwb3NlOyB0aGVcbiAqIHJlcGFpciBjaGFwdGVyIGlzIHdoYXQgdGhlIGRpZmZlcmVuY2UgY29zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBaUJBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVFBO0FBQ0E7QUFDQTtBQUNBLHNCQUFTOzs7QUN3QkYsSUFBTSxXQUFvQztBQUFBLEVBQy9DLE9BQU87QUFBQSxFQUNQLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLFVBQVU7QUFDWjtBQXVCQSxJQUFJ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WSxXQUFXLFNBQVMsS0FBSyxZQUFZLFFBQVE7QUFBQSxJQUM1RCxLQUNFLEdBQUcsS0FBSyw2QkFBNkIsS0FBSyxVQUFVLFdBQVcsS0FBSyxZQUFZLE9BQU8sS0FDdkYsU0FDQTtBQUFBLE1BQ0UsTUFBTSxZQUFZLEtBQUssUUFDckIsS0FBSyxZQUFZLElBQUksQ0FBQyxNQUFPLEVBQUUsV0FBVyxJQUFJLEVBQUUsVUFBVSxJQUFJLEVBQUUsT0FBUSxFQUFFLEtBQUssR0FBRyxLQUNsRjtBQUFBLElBRUosQ0FDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE1BQU0sVUFBVSxNQUFNLEtBQUssSUFBSSxZQUFZLEtBQUs7QUFBQSxFQUNoRCxPQUFPLE9BQU8sWUFBWSxXQUFXLFVBQVU7QUFBQTtBQWtCakQsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxrQkFBa0IsS0FBSyxNQUFNLElBQUk7QUFBQSxFQUNqQyxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sU0FBUyxJQUFJO0FBQUEsSUFDMUIsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQU8sZUFBZSxDQUFDO0FBQUEsSUFDN0IsSUFBSSxTQUFTO0FBQUEsTUFBTSxPQUFPO0FBQUEsSUFDMUIsTUFBTTtBQUFBO0FBQUE7QUFlVixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICIxQkU0OTcyN0IxMTgwMjRFNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
