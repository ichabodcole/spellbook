#!/usr/bin/env bun
// @bun

// src/glamour/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
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
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/glamour/backend/heartbeat.ts
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// plugins/spellbook/skills/glamour/shared/imageOptimize.ts
var OPTIMIZE = { maxDim: 1200, quality: 0.85 };

// src/glamour/backend/imageOptimize.server.ts
async function optimizeImageBuffer(input) {
  const data = await new Bun.Image(input).resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
    fit: "inside",
    withoutEnlargement: true
  }).webp({ quality: Math.round(OPTIMIZE.quality * 100) }).bytes();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
async function optimizeImageDataUrl(dataUrl) {
  const body = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)?.[2];
  if (body === undefined)
    throw new Error("optimizeImageDataUrl: expected a base64 data-URL");
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const { data } = await optimizeImageBuffer(bytes);
  let bin = "";
  for (const b of data)
    bin += String.fromCharCode(b);
  return `data:image/webp;base64,${btoa(bin)}`;
}

// src/glamour/backend/cli.ts
var SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "glamour");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var SKILL_ROOT_FOR_TEST = SKILL_ROOT;

class UsageError extends CliError {
  constructor(message, extra) {
    super("usage", message, extra);
  }
}
function daemonRefused(what, status, data) {
  const kind = status === 400 ? "usage" : status === 404 ? "not_found" : status === 409 ? "conflict" : "internal";
  die(`${what} failed (HTTP ${status})`, kind, {
    ...data !== null && data !== undefined ? { server: data } : {}
  });
}
var NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function sessionFilePath(session) {
  return session ? join(tmpdir(), `glamour-${session}.json`) : join(tmpdir(), "glamour-latest.json");
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
    die("no running glamour session", "not_found", NO_SESSION_HINT);
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
var CLI_OPTIONS = {
  colors: { type: "string" },
  content: { type: "string" },
  cost: { type: "string" },
  custom: { type: "string" },
  file: { type: "string" },
  intent: { type: "string" },
  kind: { type: "string" },
  label: { type: "string" },
  model: { type: "string" },
  note: { type: "string" },
  prompt: { type: "string" },
  prompts: { type: "string" },
  restore: { type: "string" },
  round: { type: "string" },
  seed: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  once: { type: "boolean" },
  src: { type: "string" },
  "start-timeout": { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  url: { type: "string" },
  full: { type: "boolean" },
  "no-open": { type: "boolean" },
  unarchive: { type: "boolean" }
};
var RECOGNIZED_FLAGS = Object.keys(CLI_OPTIONS).map((k) => `--${k}`);
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
    throw new UsageError(detail, {
      hint: "for free text containing dashes, put it after a bare --",
      choices: RECOGNIZED_FLAGS
    });
  }
}
function positional(pos, i, name) {
  const v = pos[i];
  if (v === undefined)
    throw new UsageError(`missing <${name}>`);
  return v;
}
function buildSayCmd(pos, flags) {
  const cmd = {
    type: "say",
    text: pos.join(" ")
  };
  if (typeof flags.kind === "string")
    cmd.kind = flags.kind;
  return cmd;
}
function buildSectionCmd(pos, flags) {
  const cmd = { type: "section", key: positional(pos, 0, "key") };
  if (typeof flags.status === "string")
    cmd.status = flags.status;
  if (typeof flags.content === "string")
    cmd.content = flags.content;
  if (typeof flags.prompts === "string")
    cmd.prompts = flags.prompts.split("||").map((p) => p.trim());
  if (typeof flags.colors === "string")
    cmd.colors = flags.colors.split("||").map((s) => {
      const i = s.indexOf(":");
      return i >= 0 ? { hex: s.slice(0, i).trim(), name: s.slice(i + 1).trim() } : { hex: s.trim() };
    }).filter((c) => c.hex);
  return cmd;
}
function parseCustom(v) {
  if (typeof v !== "string")
    return;
  const out = {};
  for (const pair of v.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0)
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}
function buildGenCmd(src, flags) {
  const cmd = {
    type: "gen.add",
    src,
    prompt: typeof flags.prompt === "string" ? flags.prompt : "",
    model: typeof flags.model === "string" ? flags.model : "",
    round: typeof flags.round === "string" ? Number.parseInt(flags.round, 10) : 0
  };
  if (typeof flags.seed === "string")
    cmd.seed = Number.parseInt(flags.seed, 10);
  if (typeof flags.cost === "string")
    cmd.cost = Number.parseFloat(flags.cost);
  if (typeof flags.label === "string")
    cmd.label = flags.label;
  const custom = parseCustom(flags.custom);
  if (custom)
    cmd.custom = custom;
  return cmd;
}
function buildGenCostCmd(pos, flags) {
  return {
    type: "gen.cost",
    id: positional(pos, 0, "id"),
    cost: typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN
  };
}
function buildGenMetaCmd(pos, flags) {
  const cmd = {
    type: "gen.meta",
    id: positional(pos, 0, "id")
  };
  if (typeof flags.prompt === "string")
    cmd.prompt = flags.prompt;
  const custom = parseCustom(flags.custom);
  if (custom)
    cmd.custom = custom;
  return cmd;
}
function buildStyleSaveCmd(pos) {
  return { type: "style.save", label: pos.join(" ") };
}
function buildStyleArchiveCmd(pos, flags) {
  return {
    type: "style.archive",
    id: positional(pos, 0, "id"),
    archived: !flags.unarchive
  };
}
function buildFocusCmd(pos, flags) {
  const cmd = {
    type: "focus.push",
    ids: pos
  };
  if (typeof flags.note === "string")
    cmd.note = flags.note;
  return cmd;
}
var GEN_SRC_FLAGS = ["url", "file", "src"];
var GEN_REQUIRED_FLAGS = ["prompt", "model", "round"];
var GEN_META_FLAGS = ["prompt", "custom"];
async function resolveGenSrc(flags) {
  if (typeof flags.url === "string") {
    const res = await fetch(flags.url);
    if (!res.ok)
      die(`gen: failed to fetch --url (HTTP ${res.status})`, "internal");
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (const b of bytes)
      bin += String.fromCharCode(b);
    const mime = res.headers.get("content-type") ?? "image/png";
    return optimizeImageDataUrl(`data:${mime};base64,${btoa(bin)}`);
  }
  if (typeof flags.file === "string") {
    const bytes = new Uint8Array(await Bun.file(flags.file).arrayBuffer());
    let bin = "";
    for (const b of bytes)
      bin += String.fromCharCode(b);
    return optimizeImageDataUrl(`data:image/png;base64,${btoa(bin)}`);
  }
  if (typeof flags.src === "string")
    return optimizeImageDataUrl(flags.src);
  die("gen: a source is required", "usage", {
    hint: `pass one of ${GEN_SRC_FLAGS.map((k) => `--${k}`).join(" ")}`,
    choices: GEN_SRC_FLAGS.map((k) => `--${k}`)
  });
}
async function postCmd(session, msg) {
  const s = requireSession(session);
  let status;
  let data;
  try {
    ({ status, data } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    const message = err instanceof Error ? err.message : String(err);
    if (msg.type === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET"))) {
      printJson({ ok: true, sent: "close" });
      return;
    }
    throw err;
  }
  if (status !== 200)
    daemonRefused("cmd", status, data);
  printJson({ ok: true, sent: msg.type });
}
async function cmdOpen(flags) {
  const daemonArgs = ["run", SERVER_SCRIPT];
  if (flags.title)
    daemonArgs.push("--title", String(flags.title));
  if (flags.intent)
    daemonArgs.push("--intent", String(flags.intent));
  if (flags.timeout)
    daemonArgs.push("--timeout", String(flags.timeout));
  if (flags.restore)
    daemonArgs.push("--restore", String(flags.restore));
  daemonArgs.push("--project", process.cwd());
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    die(`glamour cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}`, "internal", {
      hint: "dev mode was resolved (no dist/index.html at the skill root and no SPELLBOOK_SURFACE_MODE=release), " + "so the daemon must run from src/glamour/, which a source-free install does not have. " + "Either the shipped dist/ is missing (reinstall the spell) or you are in a checkout without src/glamour/."
    });
  }
  const child = spawn("bun", daemonArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env
  });
  child.unref();
  const startTimeoutMs = typeof flags["start-timeout"] === "string" ? Math.max(5000, Number.parseInt(String(flags["start-timeout"]), 10) * 1000) : 45000;
  const info = await new Promise((resolve, reject) => {
    let buf = "";
    const timeout = setTimeout(() => reject(new Error(`daemon start timeout (${startTimeoutMs / 1000}s) \u2014 first bundle build can be slow; retry or pass --start-timeout <seconds>`)), startTimeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf(`
`);
      if (nl >= 0) {
        clearTimeout(timeout);
        resolve(buf.slice(0, nl).trim());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`daemon exited with code ${code}`));
      }
    });
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    die(`glamour server failed to start: ${msg}`, "internal");
  });
  const out = child.stdout;
  if (!out || !("unref" in out) || typeof out.unref !== "function") {
    throw new Error("glamour: the daemon's stdout pipe has no unref(); `open` would never exit");
  }
  out.unref();
  let parsed;
  try {
    parsed = JSON.parse(info);
  } catch {
    die(`unexpected output from daemon: ${info}`, "internal");
  }
  printJson(parsed);
  if (!flags["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [parsed.url], { detached: true, stdio: "ignore" }).unref();
  }
}
async function cmdState(session, full = false) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200)
    daemonRefused("state", status, data);
  printJson(data);
}
async function cmdTail(session, sinceArg, o) {
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
    since: sinceArg,
    cursorOf: (ev) => ev.id,
    terminal: (ev) => ev.type === "closed",
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": glamour-keepalive"
  }, {
    mode: o.once ? "once" : "watch",
    presence: false,
    commands: {
      tail: ({ since, once }) => tailCommand([...selfCommand(), "tail", ...pin()], since, once),
      comeBack: () => commandLine([...selfCommand(), "open", "--restore", boundId ?? "<id>", "--no-open"])
    }
  });
}
function cmdInfo(session) {
  const s = readSession(session);
  if (!s)
    die("no running glamour session", "not_found", NO_SESSION_HINT);
  printJson(s);
}
function versionInfo() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "glamour", version: pkg.version };
  } catch {}
  return { name: "glamour", version: "unknown" };
}
var SESSION = ["session"];
var P = {
  text: [{ name: "text", required: true, variadic: true }],
  id: [{ name: "id", required: true }],
  idText: [
    { name: "id", required: true },
    { name: "text", required: true, variadic: true }
  ],
  ids: [{ name: "id", required: true, variadic: true }],
  none: []
};
var COMMANDS = [
  {
    name: "open",
    flags: ["title", "intent", "no-open", "timeout", "start-timeout", "restore"],
    positionals: P.none,
    describe: "spawn a session (opens the browser); prints {url, port, session_id}",
    run: (_pos, flags) => cmdOpen(flags)
  },
  {
    name: "tail",
    flags: [...SESSION, "since", "once"],
    positionals: P.none,
    describe: `SSE user events \u2192 JSONL (wrap with Monitor; waits for a session, never exits 5); ${WINDOW_HELP}`,
    run: (_pos, flags, session) => cmdTail(session, typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1, {
      once: flags.once === true,
      sinceGiven: typeof flags.since === "string"
    })
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: P.none,
    describe: "lean state snapshot (--full for raw incl. base64)",
    run: (_pos, flags, session) => cmdState(session, flags.full === true)
  },
  {
    name: "intent",
    flags: SESSION,
    positionals: P.text,
    describe: "update the session intent",
    run: (pos, _flags, session) => postCmd(session, { type: "intent", text: pos.join(" ") })
  },
  {
    name: "annotate",
    flags: SESSION,
    positionals: P.idText,
    describe: "write agent annotation onto a library item",
    run: (pos, _flags, session) => {
      const [id, ...words] = pos;
      return postCmd(session, { type: "item.annotate", id, agent: words.join(" ") });
    }
  },
  {
    name: "say",
    flags: [...SESSION, "kind"],
    positionals: P.text,
    describe: "post agent dialogue into the conversation (--kind info|working|result|error)",
    run: (pos, flags, session) => postCmd(session, buildSayCmd(pos, flags))
  },
  {
    name: "section",
    flags: [...SESSION, "status", "content", "prompts", "colors"],
    positionals: [{ name: "key", required: true }],
    describe: 'shape a style-guide section (--prompts a||b; --colors "#hex:Name||#hex:Name")',
    run: (pos, flags, session) => postCmd(session, buildSectionCmd(pos, flags))
  },
  {
    name: "status",
    flags: SESSION,
    positionals: [
      { name: "on|off", required: true },
      { name: "text", required: false, variadic: true }
    ],
    describe: "show/hide the working spinner",
    run: (pos, _flags, session) => {
      const on = pos[0] === "on";
      const text = pos.slice(1).join(" ") || undefined;
      return postCmd(session, { type: "status", busy: on, ...text ? { text } : {} });
    }
  },
  {
    name: "gen",
    flags: [
      ...SESSION,
      "url",
      "file",
      "src",
      "prompt",
      "model",
      "round",
      "seed",
      "cost",
      "label",
      "custom"
    ],
    positionals: P.none,
    describe: "post a generated image (one of --url|--file|--src, and --prompt --model --round required)",
    run: async (_pos, flags, session) => {
      const missingGen = GEN_REQUIRED_FLAGS.filter((k) => !flags[k]).map((k) => `--${k}`);
      if (missingGen.length > 0)
        die(`usage: ${usageOf(findCommand("gen"))}`, "usage", {
          hint: `missing required ${missingGen.join(" ")}`,
          choices: missingGen
        });
      const src = await resolveGenSrc(flags);
      await postCmd(session, buildGenCmd(src, flags));
    }
  },
  {
    name: "gen-cost",
    flags: [...SESSION, "cost"],
    positionals: P.id,
    describe: "backfill a generated image's cost (--cost <n> required)",
    run: (pos, flags, session) => {
      const cost = typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN;
      if (!Number.isFinite(cost))
        die(`usage: ${usageOf(findCommand("gen-cost"))} \u2014 --cost must be a number`);
      return postCmd(session, buildGenCostCmd(pos, flags));
    }
  },
  {
    name: "gen-meta",
    flags: [...SESSION, "prompt", "custom"],
    positionals: P.id,
    describe: "backfill the real prompt / refs onto a gen (--prompt and/or --custom)",
    run: (pos, flags, session) => {
      if (!GEN_META_FLAGS.some((k) => flags[k] !== undefined))
        die(`usage: ${usageOf(findCommand("gen-meta"))}`, "usage", {
          hint: `give one of ${GEN_META_FLAGS.map((k) => `--${k}`).join(" ")}`,
          choices: GEN_META_FLAGS.map((k) => `--${k}`)
        });
      return postCmd(session, buildGenMetaCmd(pos, flags));
    }
  },
  {
    name: "focus",
    flags: [...SESSION, "note"],
    positionals: P.ids,
    describe: "scope the focus lens to these items (+ --note to ask)",
    run: (pos, flags, session) => postCmd(session, buildFocusCmd(pos, flags))
  },
  {
    name: "style-save",
    flags: SESSION,
    positionals: [{ name: "label", required: true, variadic: true }],
    describe: "codify the current style \u2192 project tray",
    run: (pos, _flags, session) => postCmd(session, buildStyleSaveCmd(pos))
  },
  {
    name: "style-archive",
    flags: [...SESSION, "unarchive"],
    positionals: P.id,
    describe: "archive (or --unarchive) a saved style",
    run: (pos, flags, session) => postCmd(session, buildStyleArchiveCmd(pos, flags))
  },
  {
    name: "tray",
    flags: SESSION,
    positionals: P.none,
    describe: "list the project's saved styles",
    run: async (_pos, _flags, session) => {
      const s = requireSession(session);
      const { status, data } = await api(s.port, "GET", "/state?lean=1");
      if (status !== 200)
        daemonRefused("tray", status, data);
      printJson(data?.state?.tray ?? []);
    }
  },
  {
    name: "close",
    flags: SESSION,
    positionals: P.none,
    describe: "shut down the session",
    run: (_pos, _flags, session) => postCmd(session, { type: "close" })
  },
  {
    name: "info",
    flags: SESSION,
    positionals: P.none,
    describe: "print the resolved discovery JSON",
    run: (_pos, _flags, session) => cmdInfo(session)
  },
  {
    name: "schema",
    flags: [],
    positionals: P.none,
    describe: "emit this CLI's acc declaration (walked from the command table)",
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}
`);
    }
  },
  {
    name: "help",
    flags: [],
    positionals: P.none,
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
  const parts = [
    spec.name,
    ...spec.positionals.map(renderPositional),
    ...spec.flags.filter((k) => k !== "session").map(renderFlag)
  ];
  return parts.join(" ");
}
function renderHelp() {
  const rows = COMMANDS.map((c) => [usageOf(c), c.describe]);
  const width = Math.min(Math.max(...rows.map(([u]) => u.length)), 44);
  const body = rows.map(([usage, describe]) => usage.length <= width ? `  ${usage.padEnd(width)}  ${describe}` : `  ${usage}
  ${"".padEnd(width)}  ${describe}`).join(`
`);
  return `glamour \u2014 a grounded visual conversation surface.

${body}
  ${ROOT_INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON

  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row; a recognized flag on the wrong
  verb is refused, and the rejection lists the verb's own flags.

  Output: every verb prints JSON on stdout by default, one document per answer \u2014
  except tail, a stream that prints one JSON line per event, and help, which is
  prose. Failures are one JSON envelope on stderr and exit non-zero (2 = usage,
  1 = internal, 5 = not found, 6 = conflict) \u2014 except tail, which waits for a
  session instead of failing and writes its retry/keepalive notes to stderr as
  '#'-prefixed prose.`;
}
function buildDeclaration() {
  const arg = (k) => ({ name: `--${k}`, type: CLI_OPTIONS[k].type, status: "valid" });
  const commands = [
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
  ];
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands
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
    const runs = interceptor?.runs ?? "version";
    if (runs === "help")
      process.stdout.write(`${renderHelp()}
`);
    else
      process.stdout.write(`${JSON.stringify(versionInfo())}
`);
    return 0;
  }
  let currentCommand2 = verbToken(argv);
  setCurrentCommand(currentCommand2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    const spec2 = currentCommand2 === null ? undefined : findCommand(currentCommand2);
    if (spec2 !== undefined) {
      throw new UsageError(e.message, { hint: e.extra?.hint, choices: flagsFor(spec2.name) });
    }
    throw new UsageError(e.message, {
      hint: `no verb given \u2014 verbs: ${VERBS.join(" ")} (run: cli.ts help)`,
      choices: ROOT_INTERCEPTORS.map((i) => i.name)
    });
  }
  const [verb, ...pos] = parsed.pos;
  const flags = parsed.flags;
  currentCommand2 = verb ?? null;
  setCurrentCommand(currentCommand2);
  if (verb === undefined) {
    throw new UsageError("no verb given", { hint: "run: cli.ts help", choices: [...VERBS] });
  }
  const spec = findCommand(verb);
  if (spec === undefined) {
    throw new UsageError(`unknown verb "${verb}"`, {
      hint: "run: cli.ts help",
      choices: [...VERBS]
    });
  }
  const allowed = new Set(spec.flags);
  const stray = Object.keys(flags).find((k) => !allowed.has(k));
  if (stray !== undefined) {
    const accepted = flagsFor(spec.name);
    throw new UsageError(`--${stray} is not accepted by \`${spec.name}\` (it is a recognized glamour flag, just not this verb's)`, accepted.length > 0 ? { choices: accepted } : { hint: `${spec.name} takes no flags` });
  }
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (pos.length < required || !variadic && pos.length > spec.positionals.length) {
    throw new UsageError(`usage: ${usageOf(spec)}`, { hint: spec.describe });
  }
  const session = typeof flags.session === "string" ? flags.session : undefined;
  const code = await spec.run(pos, flags, session);
  return typeof code === "number" ? code : 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  CliError,
  RECOGNIZED_FLAGS,
  SKILL_ROOT_FOR_TEST,
  UsageError,
  VERBS,
  VERB_SPEC,
  buildDeclaration,
  buildFocusCmd,
  buildGenCmd,
  buildGenCostCmd,
  buildGenMetaCmd,
  buildSayCmd,
  buildSectionCmd,
  buildStyleArchiveCmd,
  buildStyleSaveCmd,
  daemonCwd,
  flagsFor,
  main,
  parseArgs,
  parseCustom,
  renderHelp,
  run,
  usageOf,
  verbToken
};

//# debugId=F5F8376218D697D264756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9jbGkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi9zaGFyZWQvaW1hZ2VPcHRpbWl6ZS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ2xhbW91ci9iYWNrZW5kL2ltYWdlT3B0aW1pemUuc2VydmVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBnbGFtb3VyIENMSSDigJQgdGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgcGVyLXNlc3Npb24gZGFlbW9uJ3MgSFRUUCBzdXJmYWNlXG4vLyAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyBhIGdsYW1vdXIgc2Vzc2lvbiB0aHJvdWdoIHRoZXNlIHZlcmJzO1xuLy8gYHRhaWxgIHN0cmVhbXMgdXNlciBldmVudHMgYXMgSlNPTkwgZm9yIE1vbml0b3IgdG8gd3JhcC5cbi8vXG4vLyBMaWZlY3ljbGU6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiBbLS10aXRsZSAuLl0gWy0taW50ZW50IC4uXSBbLS1uby1vcGVuXSAgICMgc3Bhd24gYSBzZXNzaW9uXG4vLyAgIGJ1biBjbGkudHMgdGFpbCBbLS1zaW5jZSBOXSBbLS1vbmNlXSAgICAgICAgICAgICAgICAgICAgICAjIFNTRSBldmVudHMg4oaSIEpTT05MIChNb25pdG9yIHRoaXM7IGxhc3QgbGluZSBuYW1lcyB0aGUgbmV4dCBhY3QpXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tZnVsbF0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGxlYW4gc3RhdGUgc25hcHNob3Rcbi8vXG4vLyBBZ2VudCBjb21tYW5kcyAoUE9TVCAvY21kKTpcbi8vICAgYnVuIGNsaS50cyBpbnRlbnQgPHRleHQuLi4+XG4vLyAgIGJ1biBjbGkudHMgYW5ub3RhdGUgPGlkPiA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyBzYXkgPHRleHQuLi4+XG4vLyAgIGJ1biBjbGkudHMgc3RhdHVzIG9uIFt0ZXh0Li4uXSB8IHN0YXR1cyBvZmZcbi8vICAgYnVuIGNsaS50cyBjbG9zZVxuLy8gICBidW4gY2xpLnRzIGluZm8gfCBoZWxwIHwgLS12ZXJzaW9uXG4vL1xuLy8gQWxsIHZlcmJzIHRhcmdldCB0aGUgbW9zdCByZWNlbnQgc2Vzc2lvbiBieSBkZWZhdWx0OyBwYXNzIC0tc2Vzc2lvbiA8aWQ+XG4vLyB0byB0YXJnZXQgYSBzcGVjaWZpYyBvbmUuXG4vL1xuLy8gRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCDigJQgdGhlIGhvdXNlIHRheG9ub215IG1hZ3BpZSBzZXQgYW5kIG1pbmQtbWFwcGVyXG4vLyBhZG9wdGVkKTogZXZlcnkgZmFpbHVyZSBpcyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgZW1wdHkg4oCUXG4vLyAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sXG4vLyAgICBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4vLyAgIHVzYWdlIOKGkiBleGl0IDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IMK3IGNvbmZsaWN0IOKGkiA2XG4vLyBBIGRhZW1vbiByZWZ1c2FsIG1hcHMgb2ZmIGl0cyBIVFRQIHN0YXR1cyAoNDAwIHVzYWdlLCA0MDQgbm90X2ZvdW5kLFxuLy8gNDA5IGNvbmZsaWN0LCBlbHNlIGludGVybmFsKSBhbmQgY2FycmllcyB0aGUgZGFlbW9uJ3Mgb3duIGJvZHkgVkVSQkFUSU1cbi8vIHVuZGVyIGVycm9yLnNlcnZlci4gQnJhbmNoIG9uIGBraW5kYCwgbmV2ZXIgb24gYG1lc3NhZ2VgIHByb3NlLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgQ2xpRXJyb3IsXG4gIGRpZSxcbiAgdHlwZSBFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbiAgc2V0Q3VycmVudENvbW1hbmQsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRMaW5lLFxuICBzZWxmQ29tbWFuZCxcbiAgdGFpbENvbW1hbmQsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZlwiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0XCI7XG5pbXBvcnQgeyBvcHRpbWl6ZUltYWdlRGF0YVVybCB9IGZyb20gXCIuL2ltYWdlT3B0aW1pemUuc2VydmVyXCI7XG5cbi8vIOKblCBFVkVSWSBQQVRIIEhFUkUgSVMgUkVTT0xWRUQgRlJPTSBUSEUgRU1JVFRFRCBMT0NBVElPTiwgYGRpc3QvYCwgTk9UIEZST01cbi8vIFRISVMgU09VUkNFIEZJTEUuIFRoaXMgbW9kdWxlIGlzIGJ1bmRsZWQgdG9cbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9kaXN0L2NsaS5qc2AgYW5kIHRoZSBsYXVuY2hlciBhdFxuLy8gYC4uL3NjcmlwdHMvY2xpLnRzYCBpbXBvcnRzIGl0LCBzbyBgaW1wb3J0Lm1ldGEudXJsYCBuYW1lcyB0aGUgQlVORExFLiBgZGlzdC9gXG4vLyBoYXBwZW5zIHRvIHNpdCBhdCB0aGUgc2FtZSBkZXB0aCBhcyB0aGUgYHNjcmlwdHMvYCB0aGlzIGZpbGUgdXNlZCB0byBsaXZlIGluLFxuLy8gc28gYFNLSUxMX1JPT1RgLCBgRElTVF9ESVJgIGFuZCBgU1VSRkFDRV9DV0RgIGFyZSB1bmNoYW5nZWQg4oCUIGJ1dCB0aGF0IGlzIGFcbi8vIENPSU5DSURFTkNFIE9GIERFUFRILCBub3QgYSBwcm9wZXJ0eSwgd2hpY2ggaXMgd2h5IHRoZSB3YXJkIGFzc2VydHMgdGhlbVxuLy8gcmF0aGVyIHRoYW4gdHJ1c3RpbmcgdGhpcyBwYXJhZ3JhcGguXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShCdW4uZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBBTkQgVEhJUyBMSU5FIElTIFRIRSBPTkUgVEhFIFJFTE9DQVRJT04gQlJPS0UuIEl0IHJlYWRcbi8vIGBqb2luKFNDUklQVF9ESVIsIFwic2VydmVyLnRzXCIpYCDigJQgdGhlIGRhZW1vbiBiZXNpZGUgdGhlIENMSSDigJQgd2hpY2ggd2FzIHRydWVcbi8vIGZvciBleGFjdGx5IGFzIGxvbmcgYXMgYm90aCBsaXZlZCBpbiBgc2NyaXB0cy9gLiBGcm9tIGBkaXN0L2AgaXQgcmVzb2x2ZXMgdG9cbi8vIGBkaXN0L3NlcnZlci50c2AsIGEgZmlsZSB0aGF0IGRvZXMgbm90IGV4aXN0IGFuZCBtdXN0IG5vdDogYGRpc3QvYCBob2xkcyB0aGVcbi8vIEJVTkRMRSAoYHNlcnZlci5qc2ApLCBhbmQgdGhlIHNwYXduYWJsZSBlbnRyeSBpcyB0aGUgbGF1bmNoZXIgb25lIGRpcmVjdG9yeVxuLy8gb3Zlci4gVGhlIHN5bXB0b20gb2YgZ2V0dGluZyBpdCB3cm9uZyBpcyBub3QgYSBjcmFzaCDigJQgYG9wZW5gIHdhaXRzIG91dCBpdHNcbi8vIDQ1LXNlY29uZCBoYW5kc2hha2UgYW5kIHJlcG9ydHMgYSBzdGFydCB0aW1lb3V0LCB3aGljaCByZWFkcyBsaWtlIGEgc2xvdyBmaXJzdFxuLy8gYnVuZGxlIGJ1aWxkLiBgZ3JpbW9pcmUvc3Bhd24tcGF0aC13YXJkLnRlc3QudHNgIGlzIHdoYXQgbmFtZXMgaXQgaW4gMC40c1xuLy8gaW5zdGVhZCwgYW5kIGl0IG5hbWVkIHRoaXMgb25lLiBBc3Ryb2xhYmUgYW5kIG1hZ3BpZSB3ZXJlIGFscmVhZHkgd3JpdHRlbiB0aGlzXG4vLyB3YXkgYW5kIHBhaWQgbm90aGluZyBmb3IgdGhlIG1vdmU7IGdsYW1vdXIgaXMgd2hlcmUgdGhlIHNoYXBlIGVhcm5lZCBpdHNlbGYuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gQnVuIHJlYWRzIGJ1bmZpZy50b21sICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyB0aGUgZGFlbW9uJ3MgY3dkXG4vLyBNVVNUIGJlIHNyYy9nbGFtb3VyLyBpbiBkZXYgKHNlYW1zIENvbnRyYWN0IDUpLiBMYXVuY2hlZCBlbHNld2hlcmUgdGhlIGRldlxuLy8gYnVuZGxlciBjYW5ub3QgY29tcGlsZSB0aGUgc3R5bGVzaGVldCDigJQgbWVhc3VyZWQgb24gZ2xhbW91ciB0aGUgUEFHRSA1MDBzIHdpdGhcbi8vIG5vIHN0eWxlc2hlZXQgbGluayAobm90IFwidW5zdHlsZWQgYXQgMjAwXCI7IHRoYXQgc2VudGVuY2Ugd2FzIG5ldmVyIHJ1bikuIEFzc2VydFxuLy8gdGhlIGludmFyaWFudDogdGhlIHV0aWxpdHkgbmV2ZXIgcmVhY2hlcyB0aGUgYnJvd3NlciB3aGVuIHRoZSBjd2QgaXMgd3JvbmcuXG4vLyByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHNyYy9nbGFtb3VyLyBuZWVkXG4vLyBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZFxuLy8gcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkIGJyZWFrIHRoZSBzcGF3bi4gRXhwb3J0ZWQgZm9yIHRoZSB0ZXN0LlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcImdsYW1vdXJcIik7XG5cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cbmV4cG9ydCBjb25zdCBTS0lMTF9ST09UX0ZPUl9URVNUID0gU0tJTExfUk9PVDtcblxudHlwZSBTZXNzaW9uID0ge1xuICB1cmw6IHN0cmluZztcbiAgcG9ydDogbnVtYmVyO1xuICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGZpbGVzX2Rpcj86IHN0cmluZztcbn07XG5cbi8vIOKUgOKUgCBlcnJvciBlbnZlbG9wZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyDim5QgVEhFIENPTlRSQUNUIElTIE5PVyBUSEUgSE9VU0UnUyBPTkUgQ09QWSAoYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSBhbmRcbi8vIGdsYW1vdXIncyBmb3VydGggd2FzIGRlbGV0ZWQuIFRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZSBlbnZlbG9wZSdzIGtleVxuLy8gb3JkZXIgYW5kIGBkaWVgJ3MgdGhyb3ctbm90LWV4aXQgc2hhcGUgYWxsIGNvbWUgZnJvbSB0aGVyZSDigJQgYW5kIGdsYW1vdXIgaXNcbi8vIHdoZXJlIHR3byBvZiB0aGVtIHdlcmUgZmlyc3Qgd3JpdHRlbiwgc28gbm90aGluZyBhYm91dCB0aGUgd2lyZSBjaGFuZ2VkLiBUSFJPV1xuLy8gYW5kIGxldCBtYWluKCkgY2F0Y2ggYW5kIFJFVFVSTiB0aGUgY29kZSwgbmV2ZXIgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGFcbi8vIGhlbHBlcjogdGhpcyBDTEkgc2hpcHMgbGFyZ2Ugc3Rkb3V0IHBheWxvYWRzIChgc3RhdGUgLS1mdWxsYCksIEJ1bidzIHN0ZG91dCBpc1xuLy8gYXN5bmNocm9ub3VzIG9uIGEgcGlwZSwgYW5kIGFuIGV4cGxpY2l0IGV4aXQgdHJ1bmNhdGVzIHdoYXRldmVyIGhhcyBub3Rcbi8vIGRyYWluZWQgKG1lYXN1cmVkIGF0IDY1LDUzNiBieXRlcykuXG4vL1xuLy8g4pqgIE9ORSBGSUVMRCBXRU5UIFRIRSBPVEhFUiBXQVkuIGBlcnJvci5zZXJ2ZXJgIOKAlCB0aGUgZGFlbW9uJ3Mgb3duIGJvZHksXG4vLyB2ZXJiYXRpbSDigJQgZXhpc3RlZCBvbmx5IGhlcmUsIGJlY2F1c2UgYXN0cm9sYWJlJ3MgYW5kIG1hZ3BpZSdzIGNvcGllcyBrZWVwIHRoZVxuLy8gSFRUUCBzdGF0dXMgYW5kIGRpc2NhcmQgd2hhdCB0aGUgZGFlbW9uIHNhaWQuIEl0IGlzIG5vdyBwYXJ0IG9mIHRoZSBraXQnc1xuLy8gYEVyckV4dHJhYCwgc28gdGhlIHNoYXJlZCBjb250cmFjdCBnb3QgV0lERVIgYnkgYWRvcHRpbmcgZ2xhbW91ciByYXRoZXIgdGhhblxuLy8gZ2xhbW91ciBnZXR0aW5nIG5hcnJvd2VyIHRvIGZpdCBpdC4gU2VlIHRoYXQgbW9kdWxlJ3Mgbm90ZSBvbiB0aGUgZmllbGQuXG4vL1xuLy8g4puUIEFORCBUSEUgQURPUFRJT04gUkVRVUlSRUQgVEhFIEQ4IFJFQUNIQUJJTElUWSBBVURJVCwgV0hJQ0ggV0FTIFBFUkZPUk1FRC5cbi8vIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBzd2FsbG93cyBpcyBhIHNpbGVudFxuLy8gY29udGludWUsIGFuZCB0aGUgc2l0ZSB0aGF0IGRpZXMgY2FuIGJlIHRocmVlIGZyYW1lcyBiZWxvdyB0aGUgc2l0ZSB0aGF0IGxvb2tzXG4vLyBzYWZlLiBBdWRpdGVkIGJ5IGZvbGxvd2luZyB0aGUgY2FsbCBncmFwaCwgbm90IGJ5IGdyZXBwaW5nOiAxMiBgZGllYCBjYWxsXG4vLyBzaXRlcywgMjUgZnVydGhlciBpbnZvY2F0aW9uIGVkZ2VzIG9mIHRoZSB0ZW4gZnVuY3Rpb25zIHRoYXQgcmVhY2ggb25lXG4vLyB0cmFuc2l0aXZlbHkgKGByZWFkU2Vzc2lvbmAsIGByZXF1aXJlU2Vzc2lvbmAsIGByZXNvbHZlR2VuU3JjYCwgYGNtZE9wZW5gLFxuLy8gYGNtZEluZm9gLCBgY21kU3RhdGVgLCBgY21kVGFpbGAsIGBwb3N0Q21kYCwgYGRpc3BhdGNoYCwgYG1haW5gLCBwbHVzIGZpZnRlZW5cbi8vIENPTU1BTkRTW10ucnVuIGNsb3N1cmVzKSwgMzcgYXVkaXRlZCBwb3NpdGlvbnMsIFpFUk8gaW5zaWRlIGEgYHRyeWAuIFRoZSB0aHJlZVxuLy8gc3dhbGxvd2luZyBjYXRjaGVzIGluIHRoaXMgZmlsZSAoYGFwaWAncyBub24tSlNPTiBib2R5LCBgdmVyc2lvbkluZm9gJ3Ncbi8vIGRlZ3JhZGUtdG8tdW5rbm93biwgdGhlIHRhaWwncyBtYWxmb3JtZWQtZnJhbWUgc2tpcCkgaGF2ZSBubyBkaWUtcmVhY2hhYmxlXG4vLyBjYWxsIGluc2lkZSB0aGVtLiBUaGUgb25lIHRvIHdhdGNoIGlzIGZsYWdnZWQgYXQgYHBvc3RDbWRgLlxuXG4vKiogYFVzYWdlRXJyb3JgIGlzIHRoZSBuYW1lIHRoZSB0ZXN0cyBhbmQgdGhlIG9sZGVyIGNhbGwgc2l0ZXMga25vdzsgYSB1c2FnZVxuICogIGZhaWx1cmUgaXMgYSBgQ2xpRXJyb3JgIG9mIGtpbmQgXCJ1c2FnZVwiLiBLZXB0IGFzIGEgc3ViY2xhc3MgcmF0aGVyIHRoYW5cbiAqICBpbmxpbmVkIGJlY2F1c2UgYGRpc3BhdGNoYCBicmFuY2hlcyBvbiBpdCB0byBkaXN0aW5ndWlzaCBhIFBBUlNFIHJlamVjdGlvblxuICogICh3aGljaCBpdCByZXNoYXBlcyB3aXRoIGEgcGF0aC1zY29wZWQgYGNob2ljZXNgKSBmcm9tIGFueXRoaW5nIGVsc2UsIGFuZFxuICogIGBpbnN0YW5jZW9mYCBpcyB0aGUgb25seSBob25lc3Qgd2F5IHRvIGFzayB0aGF0LiAqL1xuZXhwb3J0IGNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBDbGlFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSB7XG4gICAgc3VwZXIoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuZXhwb3J0IHsgQ2xpRXJyb3IgfTtcblxuLy8gQSBkYWVtb24gcmVmdXNhbDogdGhlIGtpbmQgbWFwcyBvZmYgdGhlIEhUVFAgc3RhdHVzLCB0aGUgZGFlbW9uJ3Mgb3duIGJvZHlcbi8vIHJpZGVzIHZlcmJhdGltIHVuZGVyIGVycm9yLnNlcnZlciBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIGl0LlxuZnVuY3Rpb24gZGFlbW9uUmVmdXNlZCh3aGF0OiBzdHJpbmcsIHN0YXR1czogbnVtYmVyLCBkYXRhOiB1bmtub3duKTogbmV2ZXIge1xuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICBzdGF0dXMgPT09IDQwMFxuICAgICAgPyBcInVzYWdlXCJcbiAgICAgIDogc3RhdHVzID09PSA0MDRcbiAgICAgICAgPyBcIm5vdF9mb3VuZFwiXG4gICAgICAgIDogc3RhdHVzID09PSA0MDlcbiAgICAgICAgICA/IFwiY29uZmxpY3RcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICBkaWUoYCR7d2hhdH0gZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBraW5kLCB7XG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IE5PX1NFU1NJT05fSElOVCA9IHsgaGludDogXCJydW46IGNsaS50cyBvcGVuIChvciBwYXNzIC0tc2Vzc2lvbiA8aWQ+KVwiIH07XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzZXNzaW9uXG4gICAgPyBqb2luKHRtcGRpcigpLCBgZ2xhbW91ci0ke3Nlc3Npb259Lmpzb25gKVxuICAgIDogam9pbih0bXBkaXIoKSwgXCJnbGFtb3VyLWxhdGVzdC5qc29uXCIpO1xufVxuXG4vKiog4puUIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0UuXG4gKlxuICogIFRoaXMgdXNlZCB0byBgY2F0Y2ggeyByZXR1cm4gbnVsbCB9YCBvdmVyIHRoZSB3aG9sZSByZWFkLCBzbyBFVkVSWSBmYWlsdXJlIOKAlFxuICogIGEgY29ycnVwdCBwb2ludGVyLCBFQUNDRVMsIGFuZCBhbnkgdHJhbnNpZW50IHRoZSBPUyByYWlzZXMgdW5kZXIgbG9hZCDigJRcbiAqICBhcnJpdmVkIGF0IHRoZSBjYWxsZXJzIHdlYXJpbmcgYWJzZW5jZSdzIGNsb3RoZXMuIFRocmVlIG9mIHRoZW0gYWN0IG9uIHRoYXQ6XG4gKiAgYHJlcXVpcmVTZXNzaW9uYCBkaWVzIGBub3RfZm91bmRgIChleGl0IDUpLCBgY21kSW5mb2AgdGhlIHNhbWUsIGFuZCB0aGUgd2F0Y2hcbiAqICBsb29wIHRyZWF0cyBpdCBhcyBcInRoZSBwaW5uZWQgc2Vzc2lvbiB3ZW50IGF3YXlcIiBhbmQgZXhpdHMgKiowKiouIEEgcmVzb3VyY2VcbiAqICBmYWlsdXJlIHdhcyB0aGVyZWZvcmUgcmVwb3J0ZWQgYXMgYSBTVUNDRVNTRlVMIGVuZCBvZiB3YXRjaC5cbiAqXG4gKiAgTWVhc3VyZWQgY29uc2VxdWVuY2U6IGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AncyBIVFRQLTQwMCByb3cgZmFpbGVkIG9uY2VcbiAqICB1bmRlciB0aGUgZnVsbCAxNDYtZmlsZSBnYXRlIHdpdGggZXhpdCAqKjUqKiB3aGVyZSB0aGUgY29udHJhY3Qgc2F5cyAyLCBhbmRcbiAqICBwYXNzZWQgYWxvbmUgYW5kIG9uIHJlLXJ1biAoZmlsZWQgMjAyNi0wOS0wNywgZGlnZXN0aWZ5J3MgUGhhc2UgMCBiYXNlbGluZSkuXG4gKiAgNSBpcyBub3QgYSBzcGF3biBjcmFzaCDigJQgaXQgaXMgdGhpcyBmdW5jdGlvbidzIGBub3RfZm91bmRgLCB3aGljaCBpcyB3aHkgdGhlXG4gKiAgY2VsbCBjb3VsZCBub3QgdGVsbCBcInRoZSBjb250cmFjdCBicm9rZVwiIGZyb20gXCJ0aGUgbWFjaGluZSB3YXMgYnVzeVwiLlxuICpcbiAqICBTbzogRU5PRU5UIGlzIHRoZSBvbmx5IGFic2VuY2UuIEV2ZXJ5dGhpbmcgZWxzZSB0aHJvd3MgYW5kIG5hbWVzIGl0c2VsZi4gKi9cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7IC8vIHRoZSBvbmUgaG9uZXN0IGFic2VuY2VcbiAgICBkaWUoYGNhbm5vdCByZWFkIHRoZSBzZXNzaW9uIHBvaW50ZXIgKCR7Y29kZSA/PyBcInVua25vd24gZXJyb3JcIn0pOiAke3BhdGh9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykgYXMgU2Vzc2lvbjtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVGhlIGRhZW1vbiB3cml0ZXMgdGhpcyBmaWxlIGF0b21pY2FsbHkgKHNlcnZlci50cyksIHNvIGEgaGFsZi13cml0dGVuXG4gICAgLy8gcG9pbnRlciBpcyBub3QgcmVhY2hhYmxlIGFuZCB1bnBhcnNlYWJsZSBjb250ZW50IGlzIHJlYWwgY29ycnVwdGlvbi5cbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgZ2xhbW91ciBzZXNzaW9uXCIsIFwibm90X2ZvdW5kXCIsIE5PX1NFU1NJT05fSElOVCk7XG4gIHJldHVybiBzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBub24tSlNPTiBib2R5ICovXG4gIH1cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbi8vIFNwbGl0IGFyZ3YgaW50byBwb3NpdGlvbmFscyArIGZsYWdzLiBgLS1mbGFnIHZhbHVlYCBvciBib29sZWFuIGAtLWZsYWdgLlxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIFRoaXMgcGFyc2VyIGFscmVhZHkgc3BsaXQgb24gdGhlIGZpcnN0IGA9YC4gV2hhdCBpdCBsYWNrZWQgd2FzIGEgUkVHSVNUUlk6XG4vLyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWVcbi8vIHByb3NlIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXMgc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC4gYG5vZGU6dXRpbGBcbi8vIHN0cmljdCBzdXBwbGllcyByZWplY3Rpb24gYW5kIHRoZSBgLS1gIHRlcm1pbmF0b3IgYWxvbmdzaWRlIHRoZSBgPWAgaGFuZGxpbmcuXG4vL1xuLy8g4pqgIGAtLXJlc3RvcmVgIEhBRCBOTyBDT1JSRUNUIFRZUEUgYW5kIHRoaXMgaXMgdGhlIHNwcmludCdzIG9uZSBnZW51aW5lIGRlc2lnblxuLy8gYmxvY2tlciwgUlVMRUQgQlkgQ09MRS4gSXQgd2FzIEJPT0xFQU4gaW4gYHN0eWxlLWFyY2hpdmVgIChgYXJjaGl2ZWQ6XG4vLyBmbGFncy5yZXN0b3JlICE9PSB0cnVlYCkgYW5kIFNUUklORyBpbiBgb3BlbmAncyBkYWVtb24gc3Bhd24g4oCUIG9uZSBmbGFnIG5hbWUsXG4vLyB0d28gaW5jb21wYXRpYmxlIHR5cGVzLCBvbmUgb3B0aW9ucyBtYXAuIERlY2xhcmluZyBpdCBib29sZWFuIHNlbmRzIGBvcGVuYCdzXG4vLyBpZCB0byBwb3NpdGlvbmFscyBhbmQgZm9yd2FyZHMgYC0tcmVzdG9yZSB0cnVlYCwgc28gdGhlIGRhZW1vbiBodW50cyBhXG4vLyBzbmFwc2hvdCBuYW1lZCBcInRydWVcIjsgZGVjbGFyaW5nIGl0IHN0cmluZyBtYWtlcyBgc3R5bGUtYXJjaGl2ZSA8aWQ+XG4vLyAtLXJlc3RvcmVgIHN3YWxsb3cgdGhlIG5leHQgcG9zaXRpb25hbCwgd2hpY2ggaXMgdGhpcyBzcHJpbnQncyBvd24gZGVmZWN0XG4vLyBjbGFzcyByZS1pbnRyb2R1Y2VkIGJ5IGl0cyBmaXguXG4vL1xuLy8gUnVsZWQ6IHJlbmFtZSB0aGUgQk9PTEVBTiBvbmUuIGAtLXJlc3RvcmVgIGtlZXBzIHRoZSBob3VzZS13aWRlIHN0cmluZ1xuLy8gc3BlbGxpbmcgaXQgc2hhcmVzIHdpdGggYm91bnR5LCBpbWFnbywgbWFncGllIGFuZCBnbGFtb3VyJ3Mgb3duIHNlcnZlci50cztcbi8vIGBzdHlsZS1hcmNoaXZlYCB0YWtlcyBgLS11bmFyY2hpdmVgLCB3aGljaCBuYW1lcyB0aGUgaW52ZXJzZSBvZiBhcmNoaXZlXG4vLyBiZXR0ZXIgYW55d2F5LiBJdCBhbHNvIGtpbGxzIGEgbGl2ZSBidWcgQlkgQ09OU1RSVUNUSU9OOiBgZmxhZ3MucmVzdG9yZSAhPT1cbi8vIHRydWVgIG1lYW50IGBzdHlsZS1hcmNoaXZlIDxpZD4gLS1yZXN0b3JlIGZvb2AgQVJDSElWRUQgaW5zdGVhZCBvZiByZXN0b3JpbmcsXG4vLyBhdCBleGl0IDAsIHdpdGggbm8gc2lnbmFsLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGNvbG9yczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNvbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjb3N0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY3VzdG9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZmlsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGtpbmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1vZGVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb21wdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb21wdHM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcm91bmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZWVkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgb25jZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzcmM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHVybDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdW5hcmNoaXZlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUyA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKS5tYXAoKGspID0+IGAtLSR7a31gKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIFRoZSByZWplY3Rpb24gTkFNRVMgaXRzIHZhbGlkIHNldCAoYWNjIEEzJ3MgU0hPVUxEKTogYGNob2ljZXNgIGlzIHRoZVxuICAgIC8vIHJlY29nbml6ZWQgZmxhZyByZWdpc3RyeSwgc28gYW4gYWdlbnQgc2VsZi1jb3JyZWN0cyB3aXRob3V0IGEgbG9va3VwLlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGRldGFpbCwge1xuICAgICAgaGludDogXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCIsXG4gICAgICBjaG9pY2VzOiBSRUNPR05JWkVEX0ZMQUdTLFxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICogUG9zaXRpb25hbCBgaWAgb2YgYSB2ZXJiIHdob3NlIEFSSVRZIERJU1BBVENIIEhBUyBBTFJFQURZIEVORk9SQ0VEIOKAlCBzbyB0aGlzXG4gKiBhYnNlbmNlIGlzIGltcG9zc2libGUgdGhyb3VnaCB0aGUgQ0xJLiBUaGUgYnVpbGRlcnMgYXJlIGV4cG9ydGVkIChjbGkudGVzdC50c1xuICogY2FsbHMgdGhlbSBkaXJlY3RseSksIGFuZCBcIm5vIHN1Y2ggYW5zd2VyIGV4aXN0c1wiIGZvciBhIGNvbW1hbmQgd2l0aCBubyBpZCxcbiAqIHNvIGFuIGltcG9zc2libGUgYWJzZW5jZSBnZXRzIHRoZSBob3VzZSdzIHVzYWdlIHJlZnVzYWwgKFQyMidzIHRoaXJkIHJvdylcbiAqIHJhdGhlciB0aGFuIGEgY29tbWFuZCBwb3N0ZWQgdG8gdGhlIGRhZW1vbiB3aXRoIGBpZDogdW5kZWZpbmVkYC5cbiAqL1xuZnVuY3Rpb24gcG9zaXRpb25hbChwb3M6IHN0cmluZ1tdLCBpOiBudW1iZXIsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHYgPSBwb3NbaV07XG4gIGlmICh2ID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBVc2FnZUVycm9yKGBtaXNzaW5nIDwke25hbWV9PmApO1xuICByZXR1cm4gdjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2F5Q21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IHN0cmluZyB9IHtcbiAgY29uc3QgY21kOiB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IHN0cmluZyB9ID0ge1xuICAgIHR5cGU6IFwic2F5XCIsXG4gICAgdGV4dDogcG9zLmpvaW4oXCIgXCIpLFxuICB9O1xuICBpZiAodHlwZW9mIGZsYWdzLmtpbmQgPT09IFwic3RyaW5nXCIpIGNtZC5raW5kID0gZmxhZ3Mua2luZDtcbiAgcmV0dXJuIGNtZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2VjdGlvbkNtZChcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKToge1xuICB0eXBlOiBcInNlY3Rpb25cIjtcbiAga2V5OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgY29udGVudD86IHN0cmluZztcbiAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICBjb2xvcnM/OiBBcnJheTx7IGhleDogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0+O1xufSB7XG4gIGNvbnN0IGNtZDoge1xuICAgIHR5cGU6IFwic2VjdGlvblwiO1xuICAgIGtleTogc3RyaW5nO1xuICAgIHN0YXR1cz86IHN0cmluZztcbiAgICBjb250ZW50Pzogc3RyaW5nO1xuICAgIHByb21wdHM/OiBzdHJpbmdbXTtcbiAgICBjb2xvcnM/OiBBcnJheTx7IGhleDogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0+O1xuICB9ID0geyB0eXBlOiBcInNlY3Rpb25cIiwga2V5OiBwb3NpdGlvbmFsKHBvcywgMCwgXCJrZXlcIikgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5zdGF0dXMgPT09IFwic3RyaW5nXCIpIGNtZC5zdGF0dXMgPSBmbGFncy5zdGF0dXM7XG4gIGlmICh0eXBlb2YgZmxhZ3MuY29udGVudCA9PT0gXCJzdHJpbmdcIikgY21kLmNvbnRlbnQgPSBmbGFncy5jb250ZW50O1xuICBpZiAodHlwZW9mIGZsYWdzLnByb21wdHMgPT09IFwic3RyaW5nXCIpXG4gICAgY21kLnByb21wdHMgPSBmbGFncy5wcm9tcHRzLnNwbGl0KFwifHxcIikubWFwKChwKSA9PiBwLnRyaW0oKSk7XG4gIC8vIC0tY29sb3JzIFwiI0ZBQ0MzRTpUcmVhc3VyZSBHb2xkfHwjMjkzRDM2OlN1bmtlbiBDaGFyY29hbFwiIOKGkiBzdHJ1Y3R1cmVkIHN3YXRjaGVzXG4gIGlmICh0eXBlb2YgZmxhZ3MuY29sb3JzID09PSBcInN0cmluZ1wiKVxuICAgIGNtZC5jb2xvcnMgPSBmbGFncy5jb2xvcnNcbiAgICAgIC5zcGxpdChcInx8XCIpXG4gICAgICAubWFwKChzKSA9PiB7XG4gICAgICAgIGNvbnN0IGkgPSBzLmluZGV4T2YoXCI6XCIpO1xuICAgICAgICByZXR1cm4gaSA+PSAwXG4gICAgICAgICAgPyB7IGhleDogcy5zbGljZSgwLCBpKS50cmltKCksIG5hbWU6IHMuc2xpY2UoaSArIDEpLnRyaW0oKSB9XG4gICAgICAgICAgOiB7IGhleDogcy50cmltKCkgfTtcbiAgICAgIH0pXG4gICAgICAuZmlsdGVyKChjKSA9PiBjLmhleCk7XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUN1c3RvbSh2OiBzdHJpbmcgfCBib29sZWFuIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgdiAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGZvciAoY29uc3QgcGFpciBvZiB2LnNwbGl0KFwiLFwiKSkge1xuICAgIGNvbnN0IGVxID0gcGFpci5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXEgPiAwKSBvdXRbcGFpci5zbGljZSgwLCBlcSkudHJpbSgpXSA9IHBhaXIuc2xpY2UoZXEgKyAxKS50cmltKCk7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKG91dCkubGVuZ3RoID8gb3V0IDogdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW5DbWQoXG4gIHNyYzogc3RyaW5nLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7XG4gIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICBzcmM6IHN0cmluZztcbiAgcHJvbXB0OiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIHJvdW5kOiBudW1iZXI7XG4gIHNlZWQ/OiBudW1iZXI7XG4gIGNvc3Q/OiBudW1iZXI7XG4gIGxhYmVsPzogc3RyaW5nO1xuICBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufSB7XG4gIGNvbnN0IGNtZDogUmV0dXJuVHlwZTx0eXBlb2YgYnVpbGRHZW5DbWQ+ID0ge1xuICAgIHR5cGU6IFwiZ2VuLmFkZFwiLFxuICAgIHNyYyxcbiAgICBwcm9tcHQ6IHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIgPyBmbGFncy5wcm9tcHQgOiBcIlwiLFxuICAgIG1vZGVsOiB0eXBlb2YgZmxhZ3MubW9kZWwgPT09IFwic3RyaW5nXCIgPyBmbGFncy5tb2RlbCA6IFwiXCIsXG4gICAgcm91bmQ6IHR5cGVvZiBmbGFncy5yb3VuZCA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUludChmbGFncy5yb3VuZCwgMTApIDogMCxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5zZWVkID09PSBcInN0cmluZ1wiKSBjbWQuc2VlZCA9IE51bWJlci5wYXJzZUludChmbGFncy5zZWVkLCAxMCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MuY29zdCA9PT0gXCJzdHJpbmdcIikgY21kLmNvc3QgPSBOdW1iZXIucGFyc2VGbG9hdChmbGFncy5jb3N0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIikgY21kLmxhYmVsID0gZmxhZ3MubGFiZWw7XG4gIGNvbnN0IGN1c3RvbSA9IHBhcnNlQ3VzdG9tKGZsYWdzLmN1c3RvbSk7XG4gIGlmIChjdXN0b20pIGNtZC5jdXN0b20gPSBjdXN0b207XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdlbkNvc3RDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogXCJnZW4uY29zdFwiLFxuICAgIGlkOiBwb3NpdGlvbmFsKHBvcywgMCwgXCJpZFwiKSxcbiAgICBjb3N0OiB0eXBlb2YgZmxhZ3MuY29zdCA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUZsb2F0KGZsYWdzLmNvc3QpIDogTnVtYmVyLk5hTixcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR2VuTWV0YUNtZChcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IHtcbiAgY29uc3QgY21kOiB7IHR5cGU6IFwiZ2VuLm1ldGFcIjsgaWQ6IHN0cmluZzsgcHJvbXB0Pzogc3RyaW5nOyBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH0gPSB7XG4gICAgdHlwZTogXCJnZW4ubWV0YVwiLFxuICAgIGlkOiBwb3NpdGlvbmFsKHBvcywgMCwgXCJpZFwiKSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGNtZC5wcm9tcHQgPSBmbGFncy5wcm9tcHQ7XG4gIGNvbnN0IGN1c3RvbSA9IHBhcnNlQ3VzdG9tKGZsYWdzLmN1c3RvbSk7XG4gIGlmIChjdXN0b20pIGNtZC5jdXN0b20gPSBjdXN0b207XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0eWxlU2F2ZUNtZChwb3M6IHN0cmluZ1tdKToge1xuICB0eXBlOiBcInN0eWxlLnNhdmVcIjtcbiAgbGFiZWw6IHN0cmluZztcbn0ge1xuICByZXR1cm4geyB0eXBlOiBcInN0eWxlLnNhdmVcIiwgbGFiZWw6IHBvcy5qb2luKFwiIFwiKSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdHlsZUFyY2hpdmVDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJzdHlsZS5hcmNoaXZlXCI7IGlkOiBzdHJpbmc7IGFyY2hpdmVkOiBib29sZWFuIH0ge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwic3R5bGUuYXJjaGl2ZVwiLFxuICAgIGlkOiBwb3NpdGlvbmFsKHBvcywgMCwgXCJpZFwiKSxcbiAgICBhcmNoaXZlZDogIWZsYWdzLnVuYXJjaGl2ZSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRm9jdXNDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGNtZDogeyB0eXBlOiBcImZvY3VzLnB1c2hcIjsgaWRzOiBzdHJpbmdbXTsgbm90ZT86IHN0cmluZyB9ID0ge1xuICAgIHR5cGU6IFwiZm9jdXMucHVzaFwiLFxuICAgIGlkczogcG9zLFxuICB9O1xuICBpZiAodHlwZW9mIGZsYWdzLm5vdGUgPT09IFwic3RyaW5nXCIpIGNtZC5ub3RlID0gZmxhZ3Mubm90ZTtcbiAgcmV0dXJuIGNtZDtcbn1cblxuLy8gUmVzb2x2ZSBhIGdlbiBpbWFnZSBzb3VyY2UgdG8gYW4gT1BUSU1JWkVEIHdlYnAgZGF0YS1VUkwgKHRoZSBkYWVtb24gc3RvcmVzXG4vLyBpdCBhcy1pcykuIC0tdXJsIGRvd25sb2FkczsgLS1maWxlIHJlYWRzOyAtLXNyYyBpcyBhbiBleGlzdGluZyBkYXRhLVVSTC5cbi8qKlxuICog4pSA4pSAIGBnZW5gJ3MgVFdPIEFDQ0VQVEVEIFNFVFMgKHJlZ2lzdGVyIEExKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBgR0VOX1NSQ19GTEFHU2AgaXMgYSBESVNKVU5DVElPTiDigJQgYW55IG9uZSBzYXRpc2ZpZXMgYHJlc29sdmVHZW5TcmNgLlxuICogYEdFTl9SRVFVSVJFRF9GTEFHU2AgaXMgYSBDT05KVU5DVElPTiDigJQgYWxsIHRocmVlIG11c3QgYmUgcHJlc2VudCDigJQgYW5kIHRoZVxuICogcmVqZWN0aW9uIGJlbG93IGZpbHRlcnMgaXQsIHNvIGl0cyBgY2hvaWNlc2AgbmFtZXMgdGhlIG9uZXMgYWN0dWFsbHkgTUlTU0lOR1xuICogcmF0aGVyIHRoYW4gdGhlIHdob2xlIHJvc3Rlci4gQm90aCBhcmUgZGVyaXZlZCBhdCB0aGUgc2l0ZSB0aGF0IGVuZm9yY2VzXG4gKiB0aGVtOyBuZWl0aGVyIGlzIHJlLXR5cGVkIGludG8gYSBtZXNzYWdlLlxuICovXG5jb25zdCBHRU5fU1JDX0ZMQUdTID0gW1widXJsXCIsIFwiZmlsZVwiLCBcInNyY1wiXSBhcyBjb25zdDtcbmNvbnN0IEdFTl9SRVFVSVJFRF9GTEFHUyA9IFtcInByb21wdFwiLCBcIm1vZGVsXCIsIFwicm91bmRcIl0gYXMgY29uc3Q7XG4vKiogYGdlbi1tZXRhYCdzIGRpc2p1bmN0aW9uIOKAlCBlaXRoZXIgb25lIHNhdGlzZmllcyBpdC4gKi9cbmNvbnN0IEdFTl9NRVRBX0ZMQUdTID0gW1wicHJvbXB0XCIsIFwiY3VzdG9tXCJdIGFzIGNvbnN0O1xuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlR2VuU3JjKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmICh0eXBlb2YgZmxhZ3MudXJsID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goZmxhZ3MudXJsKTtcbiAgICBpZiAoIXJlcy5vaykgZGllKGBnZW46IGZhaWxlZCB0byBmZXRjaCAtLXVybCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCByZXMuYXJyYXlCdWZmZXIoKSk7XG4gICAgbGV0IGJpbiA9IFwiXCI7XG4gICAgZm9yIChjb25zdCBiIG9mIGJ5dGVzKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgICBjb25zdCBtaW1lID0gcmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpID8/IFwiaW1hZ2UvcG5nXCI7XG4gICAgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGBkYXRhOiR7bWltZX07YmFzZTY0LCR7YnRvYShiaW4pfWApO1xuICB9XG4gIGlmICh0eXBlb2YgZmxhZ3MuZmlsZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUoZmxhZ3MuZmlsZSkuYXJyYXlCdWZmZXIoKSk7XG4gICAgbGV0IGJpbiA9IFwiXCI7XG4gICAgZm9yIChjb25zdCBiIG9mIGJ5dGVzKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgICByZXR1cm4gb3B0aW1pemVJbWFnZURhdGFVcmwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke2J0b2EoYmluKX1gKTtcbiAgfVxuICBpZiAodHlwZW9mIGZsYWdzLnNyYyA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGZsYWdzLnNyYyk7XG4gIC8vIOKblCBSRUdJU1RFUiBBMSDigJQgVEhFIERJU0pVTkNUSU9OIElTIGBjaG9pY2VzYCwgTk9UIEEgU0VOVEVOQ0UuIFRocmVlIGZsYWdzXG4gIC8vIGFueSBPTkUgb2Ygd2hpY2ggc2F0aXNmaWVzIHRoaXMgaXMgZXhhY3RseSBhIHJvdXRpbmcgZGVjaXNpb246IHRoZSBjYWxsZXJcbiAgLy8gKHVzdWFsbHkgYW4gYWdlbnQpIGhhcyB0byBwaWNrIG9uZSwgYW5kIHBpY2tpbmcgZnJvbSBwcm9zZSBtZWFucyBwYXJzaW5nXG4gIC8vIHByb3NlLiBgR0VOX1NSQ19GTEFHU2AgaXMgdGhlIHNldCB0aGUgYnJhbmNoZXMgYWJvdmUgcmVhZCwgYW5kXG4gIC8vIGBjbGkudGVzdC50c2AgYmluZHMgdGhlIHR3byBzbyBhIGZvdXJ0aCBzb3VyY2UgY2Fubm90IGJlIGFkZGVkIHRvIG9uZS5cbiAgZGllKFwiZ2VuOiBhIHNvdXJjZSBpcyByZXF1aXJlZFwiLCBcInVzYWdlXCIsIHtcbiAgICBoaW50OiBgcGFzcyBvbmUgb2YgJHtHRU5fU1JDX0ZMQUdTLm1hcCgoaykgPT4gYC0tJHtrfWApLmpvaW4oXCIgXCIpfWAsXG4gICAgY2hvaWNlczogR0VOX1NSQ19GTEFHUy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgbGV0IHN0YXR1czogbnVtYmVyO1xuICBsZXQgZGF0YTogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICAoeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgbXNnKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIGBjbG9zZWAgY2F1c2VzIEJ1bi5zZXJ2ZSB0byBzdG9wIGltbWVkaWF0ZWx5IOKAlCB0aGUgY29ubmVjdGlvbiByZXNldHNcbiAgICAvLyBiZWZvcmUgdGhlIDIwMCByZXNwb25zZSBpcyBmbHVzaGVkLiBUcmVhdCBFQ09OTlJFU0VUIG9uIGNsb3NlIGFzIHN1Y2Nlc3MuXG4gICAgLy8gT05MWSBhIHJlc2V0OiBhIHJlZnVzZWQgY29ubmVjdGlvbiAoc3RhbGUgcG9pbnRlciwgZGFlbW9uIGFscmVhZHkgZ29uZSlcbiAgICAvLyBpcyBhIHRyYW5zcG9ydCBmYWlsdXJlIGxpa2UgYW55IG90aGVyIGFuZCByaWRlcyB0aGUgaW50ZXJuYWwgZW52ZWxvcGUg4oCUXG4gICAgLy8gdGhlIHJldmlldyBmb3VuZCB0aGUgb2xkIGNhdGNoLWFsbCByZXBvcnRpbmcge29rOnRydWV9IGFnYWluc3QgYSBkZWFkIHBvcnQuXG4gICAgY29uc3QgY29kZSA9IGVyciAmJiB0eXBlb2YgZXJyID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGVyciA/IFN0cmluZyhlcnIuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSkge1xuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcImNtZFwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgc2VudDogbXNnLnR5cGUgfSk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgZGFlbW9uQXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKGZsYWdzLnRpdGxlKSBkYWVtb25BcmdzLnB1c2goXCItLXRpdGxlXCIsIFN0cmluZyhmbGFncy50aXRsZSkpO1xuICBpZiAoZmxhZ3MuaW50ZW50KSBkYWVtb25BcmdzLnB1c2goXCItLWludGVudFwiLCBTdHJpbmcoZmxhZ3MuaW50ZW50KSk7XG4gIGlmIChmbGFncy50aW1lb3V0KSBkYWVtb25BcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgU3RyaW5nKGZsYWdzLnRpbWVvdXQpKTtcbiAgaWYgKGZsYWdzLnJlc3RvcmUpIGRhZW1vbkFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBTdHJpbmcoZmxhZ3MucmVzdG9yZSkpO1xuICAvLyBUaGUgdXNlcidzIHByb2plY3QgZGlyIOKAlCBjYXB0dXJlZCBoZXJlIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGF3bnMgd2l0aCBhXG4gIC8vIHBpbm5lZCBjd2QgKGRhZW1vbkN3ZCgpKSwgc28gaXQgY2FuJ3QgcmVhZCB0aGUgcmVhbCBjd2QgaXRzZWxmLlxuICBkYWVtb25BcmdzLnB1c2goXCItLXByb2plY3RcIiwgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgLy8gbm9kZTpjaGlsZF9wcm9jZXNzIChub3QgQnVuLnNwYXduKSBpcyBkZWxpYmVyYXRlOiB0aGUgZGFlbW9uIG11c3QgU1VSVklWRVxuICAvLyB0aGlzIENMSSBwcm9jZXNzIGV4aXRpbmcsIHdoaWNoIG5lZWRzIGBkZXRhY2hlZDogdHJ1ZWAgKyBgdW5yZWYoKWAuXG4gIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQW5kIGNoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzpcbiAgLy8gbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgYEVOT0VOVCDigKYgcG9zaXhfc3Bhd24gJ2J1bidgLCB3aGljaCBuYW1lcyB0aGVcbiAgLy8gb25lIHRoaW5nIHRoYXQgaXMgZmluZS4gTWVhc3VyZWQgYnkgY2Fzc2FuZHJhIGF0IGEgZGVwcy1mcmVlIGRlc3RpbmF0aW9uXG4gIC8vIHdpdGggZGlzdC9pbmRleC5odG1sIHJlbW92ZWQgKGNvbW1zICMxMjY1KTogYSBjb2xkIGFnZW50IHJlYWRzIHRoYXQgYW5kXG4gIC8vIHJlaW5zdGFsbHMgYnVuLiBOYW1lIHRoZSByZWFsIGFic2VuY2UgaW5zdGVhZC5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKSB7XG4gICAgZGllKFxuICAgICAgYGdsYW1vdXIgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OlxuICAgICAgICAgIFwiZGV2IG1vZGUgd2FzIHJlc29sdmVkIChubyBkaXN0L2luZGV4Lmh0bWwgYXQgdGhlIHNraWxsIHJvb3QgYW5kIG5vIFNQRUxMQk9PS19TVVJGQUNFX01PREU9cmVsZWFzZSksIFwiICtcbiAgICAgICAgICBcInNvIHRoZSBkYWVtb24gbXVzdCBydW4gZnJvbSBzcmMvZ2xhbW91ci8sIHdoaWNoIGEgc291cmNlLWZyZWUgaW5zdGFsbCBkb2VzIG5vdCBoYXZlLiBcIiArXG4gICAgICAgICAgXCJFaXRoZXIgdGhlIHNoaXBwZWQgZGlzdC8gaXMgbWlzc2luZyAocmVpbnN0YWxsIHRoZSBzcGVsbCkgb3IgeW91IGFyZSBpbiBhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dsYW1vdXIvLlwiLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJidW5cIiwgZGFlbW9uQXJncywge1xuICAgIGN3ZCxcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgfSk7XG4gIGNoaWxkLnVucmVmKCk7XG5cbiAgLy8gUmVhZCB0aGUgZGFlbW9uJ3MgZmlyc3Qgc3Rkb3V0IGxpbmUg4oCUIGl0IHByaW50cyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfS5cbiAgLy8gR2VuZXJvdXMgZGVmYXVsdDogdGhlIGZpcnN0IGJ1bmRsZSBidWlsZCBvZiB0aGUgUmVhY3Qgc3VyZmFjZSBjYW4gdGFrZSB0ZW5zXG4gIC8vIG9mIHNlY29uZHMgY29sZCwgYW5kIGEgdG9vLXNob3J0IGhhbmRzaGFrZSBtYWtlcyBgb3BlbmAgcmVwb3J0IGZhaWx1cmUgd2hpbGVcbiAgLy8gdGhlIGRhZW1vbiBhY3R1YWxseSBjb21lcyB1cCBmaW5lLiBPdmVycmlkZSB3aXRoIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz4uXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChTdHJpbmcoZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdKSwgMTApICogMTAwMClcbiAgICAgIDogNDUwMDA7XG4gIGNvbnN0IGluZm8gPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dChcbiAgICAgICgpID0+XG4gICAgICAgIHJlamVjdChcbiAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgZGFlbW9uIHN0YXJ0IHRpbWVvdXQgKCR7c3RhcnRUaW1lb3V0TXMgLyAxMDAwfXMpIOKAlCBmaXJzdCBidW5kbGUgYnVpbGQgY2FuIGJlIHNsb3c7IHJldHJ5IG9yIHBhc3MgLS1zdGFydC10aW1lb3V0IDxzZWNvbmRzPmAsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgIHN0YXJ0VGltZW91dE1zLFxuICAgICk7XG4gICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3R5bGUvbm9Ob25OdWxsQXNzZXJ0aW9uOiBzdGRpbyBcInBpcGVcIiBndWFyYW50ZWVzIHN0ZG91dFxuICAgIGNoaWxkLnN0ZG91dCEub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICBidWYgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IG5sID0gYnVmLmluZGV4T2YoXCJcXG5cIik7XG4gICAgICBpZiAobmwgPj0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgIHJlc29sdmUoYnVmLnNsaWNlKDAsIG5sKS50cmltKCkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgcmVqZWN0KGVycik7XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJleGl0XCIsIChjb2RlKSA9PiB7XG4gICAgICBpZiAoY29kZSAhPT0gbnVsbCAmJiBjb2RlICE9PSAwKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgZGFlbW9uIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfWApKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBkaWUoYGdsYW1vdXIgc2VydmVyIGZhaWxlZCB0byBzdGFydDogJHttc2d9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfSk7XG5cbiAgLy8g4pqgIFJFTEVBU0UgVEhFIERBRU1PTidTIFNURE9VVCBQSVBFLCBvciB0aGlzIENMSSBuZXZlciBleGl0cy5cbiAgLy9cbiAgLy8gYGNoaWxkLnVucmVmKClgIGFib3ZlIHJlbGVhc2VzIHRoZSBDSElMRCBQUk9DRVNTIGhhbmRsZS4gVGhlIHBpcGVkIHN0ZG91dCBpc1xuICAvLyBhIFNFUEFSQVRFIHJlZmZlZCBoYW5kbGUsIGFuZCB0aGUgZGFlbW9uIHJ1bnMgZm9yZXZlciDigJQgc28gb25jZSBgb3BlbmAgc3RvcHNcbiAgLy8gZm9yY2UtZXhpdGluZywgdGhlIHBhcmVudCdzIGV2ZW50IGxvb3Agd2FpdHMgb24gYSBzdHJlYW0gdGhhdCB3aWxsIG5ldmVyXG4gIC8vIGNsb3NlLiBNZWFzdXJlZDogYG9wZW4gLS1uby1vcGVuYCBzdGlsbCBydW5uaW5nIGF0IDkxczsgd2l0aCB0aGlzIGxpbmUsIDFzLlxuICAvL1xuICAvLyBUaGlzIGJlY2FtZSBsaXZlIHdoZW4gUDAgcmVwbGFjZWQgYHByb2Nlc3MuZXhpdChjb2RlKWAgd2l0aCBgcHJvY2Vzcy5leGl0Q29kZWBcbiAgLy8gKyBhIG5hdHVyYWwgcmV0dXJuOiBgcHJvY2Vzcy5leGl0YCBoYWQgYmVlbiBkb2luZyBET1VCTEUgRFVUWSwgZHJhaW5pbmcgc3Rkb3V0XG4gIC8vIChicm9rZW4g4oCUIGl0IHRydW5jYXRlZCBhdCA2NSw1MzYpIEFORCB0ZXJtaW5hdGluZyBkZXNwaXRlIGEgbGl2ZSBjaGlsZCBwaXBlXG4gIC8vIChsb2FkLWJlYXJpbmcsIGFuZCB1bm5vdGljZWQpLiBSZW1vdmluZyBpdCBmaXhlZCB0aGUgZmlyc3QgYW5kIGV4cG9zZWQgdGhlXG4gIC8vIHNlY29uZC4gYGpvaW4udHNgIGhhcyB0aGUgc2FtZSBzaGFwZSBhbmQgaXMgZGVsaWJlcmF0ZWx5IE5PVCBjb252ZXJ0ZWQuXG4gIC8vXG4gIC8vIGB1bnJlZigpYCByYXRoZXIgdGhhbiBgZGVzdHJveSgpYDogYm90aCBtZWFzdXJlZCBjbGVhbiwgYW5kIHVucmVmIGlzIHRoZVxuICAvLyBjb25zZXJ2YXRpdmUgb25lIOKAlCBpdCBsZWF2ZXMgdGhlIHN0cmVhbSB1c2FibGUgYW5kIG9ubHkgc3RvcHMgaXQgaG9sZGluZyB0aGVcbiAgLy8gbG9vcC4gVGhlIGhhbmRzaGFrZSBpcyB0aGUgc29sZSByZWFkLCBzbyBub3RoaW5nIGRvd25zdHJlYW0gbmVlZHMgaXQuXG4gIC8vIOKaoCBOT1QgYGluc3RhbmNlb2YgU29ja2V0YC4gTUVBU1VSRUQgdW5kZXIgQnVuOiB0aGlzIHBpcGUgaXMgYSBwbGFpblxuICAvLyBgUmVhZGFibGVgIChjb25zdHJ1Y3RvciBgUmVhZGFibGVgLCBgaW5zdGFuY2VvZiBuZXQuU29ja2V0YCBmYWxzZSkgdGhhdFxuICAvLyBub25ldGhlbGVzcyBjYXJyaWVzIGB1bnJlZmAg4oCUIG5vZGUncyB0eXBpbmdzIGRlY2xhcmUgaXQgb25seSBvbiBgU29ja2V0YCxcbiAgLy8gaGVuY2UgVFMyMzM5LiBBIFNvY2tldCBndWFyZCB3b3VsZCBzaWxlbnRseSBza2lwIHRoZSB1bnJlZiBhbmQgYnJpbmcgYmFja1xuICAvLyB0aGUgOTEgcyBoYW5nIGFib3ZlLCBzbyB0aGUgY2hlY2sgaXMgZm9yIHRoZSBNRVRIT0QsIGFuZCBpdHMgYWJzZW5jZSBpcyBhXG4gIC8vIG5hbWVkIHRocm93IOKAlCB0aGUgc2FtZSBjcmFzaCB0aGUgb2xkIGAhYCB3b3VsZCBoYXZlIHByb2R1Y2VkLCBub3cgc2F5aW5nIHdoeS5cbiAgY29uc3Qgb3V0ID0gY2hpbGQuc3Rkb3V0O1xuICBpZiAoIW91dCB8fCAhKFwidW5yZWZcIiBpbiBvdXQpIHx8IHR5cGVvZiBvdXQudW5yZWYgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcImdsYW1vdXI6IHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSBoYXMgbm8gdW5yZWYoKTsgYG9wZW5gIHdvdWxkIG5ldmVyIGV4aXRcIik7XG4gIH1cbiAgb3V0LnVucmVmKCk7XG5cbiAgbGV0IHBhcnNlZDogeyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmcgfTtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGluZm8pIGFzIHR5cGVvZiBwYXJzZWQ7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7aW5mb31gLCBcImludGVybmFsXCIpO1xuICB9XG5cbiAgcHJpbnRKc29uKHBhcnNlZCk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICAvLyBQbGF0Zm9ybSBvcGVuZXIg4oCUIG9wZW4gdGhlIGJyb3dzZXJcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW3BhcnNlZC51cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb24/OiBzdHJpbmcsIGZ1bGwgPSBmYWxzZSkge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCJcIiA6IFwiP2xlYW49MVwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJzdGF0ZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbi8qKlxuICogVGhlIGV2ZW50IHRhaWwg4oCUIE9ORSBDQUxMIGludG8gdGhlIGhvdXNlJ3Mgc2hhcmVkIFNTRSBjbGllbnRcbiAqIChgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgKSwgd2hlcmUgdGhlIHJlY29ubmVjdCBsb29wLCB0aGUgc3BlYy1jb3JyZWN0XG4gKiBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmQgdGhlIGRyYWluZWQgZXhpdCBsaXZlIG9uY2VcbiAqIGZvciBldmVyeSBzcGVsbC5cbiAqXG4gKiDim5QgKipUSElTIElTIFdIRVJFIENFTlNVUyBERUZFQ1QgQjUgRElFUyBCWSBDT05TVFJVQ1RJT04uKiogVGhlIGxvb3AgdGhpc1xuICogcmVwbGFjZXMgc2V0IGBsZXQgZGVsYXkgPSAyNTBgIChgY2xpLnRzOjYyM2AgYmVmb3JlIHRoZSBwb3J0KSBhbmQgdGhlbiByZXNldFxuICogaXQgdG8gMjUwIG9uIGV2ZXJ5IFNVQ0NFU1NGVUwgT1BFTiAoYDo2NjdgKSDigJQgc28gYSBkYWVtb24gdGhhdCBhY2NlcHRzIGFcbiAqIGNvbm5lY3Rpb24gYW5kIGltbWVkaWF0ZWx5IGRyb3BzIGl0IHdhcyByZWNvbm5lY3RlZCBhZ2FpbnN0IGF0IGEgQ09OU1RBTlRcbiAqIDI1MCBtcywgZm9yZXZlciwgd2l0aCBubyBncm93dGg6IGEgcmVjb25uZWN0IHN0b3JtIHRoYXQgbG9va3MgbGlrZSBhIGhlYWx0aHlcbiAqIHJldHJ5LiBUaHJlZSBzaXRlcyBkaWQgZ3JvdyB0aGUgZGVsYXkgKGA6NjQyYCwgYDo2NTlgLCBgOjY2NGApIGFuZCBvbmUgZGlkXG4gKiBub3QsIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgYSBoYW5kLXdyaXR0ZW4gbG9vcCBjYW5ub3QgYmUgcmVhc29uZWQgYWJvdXQgZnJvbVxuICogb25lIG9mIGl0cyBicmFuY2hlcy4gKipJdCBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGhlcmUsIGJlY2F1c2UgdGhlcmUgaXMgbm9cbiAqIGxvb3AgbGVmdCB0byBwdXQgaXQgaW4qKiDigJQgdGhlcmUgaXMgb25lIGJhY2tvZmYsIGl0IGRvdWJsZXMgb24gZXZlcnkgZmFpbGVkXG4gKiBhdHRlbXB0LCBhbmQgUGhhc2UgMWEncyBzZWNvbmQgZG9vciAodGhlIHJlc2V0IGJlbG9uZ3MgYXQgdGhlIEZJUlNUIEJZVEUsIG5vdFxuICogYXQgYSBzdWNjZXNzZnVsIG9wZW4pIGlzIGNsb3NlZCBieSB0aGUgc2FtZSBzaW5nbGUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4puUIGByZXNvbHZlYCBSRS1SRUFEUyBUSEUgU0VTU0lPTiBQT0lOVEVSIE9OIEVWRVJZIEFUVEVNUFQsIHdoaWNoIGlzIHdoYXRcbiAqIGdsYW1vdXIncyBvd24gbG9vcCBkaWQgYW5kIHdoYXQgdGhlIHNoYXJlZCBjbGllbnQgbWFrZXMgc3RydWN0dXJhbDogdGhlIGRhZW1vblxuICogYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQsIHNvIGEgY2FwdHVyZWQgYmFzZSBpcyBhIHRhaWwgdGhhdCBzdXJ2aXZlcyBleGFjdGx5IG9uZVxuICogZGFlbW9uLlxuICpcbiAqIOKblCBBTkQgSVQgR0FJTkVEIEEgV0FUQ0hET0cgSVQgRElEIE5PVCBIQVZFLiBUaGUgb2xkIGxvb3AgaGFkIG5vbmU6IGl0IGJsb2NrZWRcbiAqIG9uIGBhd2FpdCByZWFkZXIucmVhZCgpYCBmb3JldmVyLCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhXG4gKiBOQVQgcmViaW5kIG9yIGEgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgaW4gc2lsZW5jZSB3aXRoIG5vIHdheSBvdXQuXG4gKiBgVEFJTF9JRExFX01TYCBpcyBERVJJVkVEIGZyb20gZ2xhbW91cidzIG93biBoZWFydGJlYXQgKGAuL2hlYXJ0YmVhdC50c2ApLFxuICogbmV2ZXIgY29waWVkIGZyb20gYSBzaWJsaW5nIOKAlCBhc3Ryb2xhYmUgbWVhc3VyZWQgd2hhdCBhIGNvcGllZCBudW1iZXIgY29zdHMuXG4gKlxuICogVGhlIHBpbiwgdGhlIGdyb3VuZGluZyBhbmNob3IgYW5kIHRoZSBcIm91ciBzZXNzaW9uIHdlbnQgYXdheVwiIGV4aXQgYXJlIGFsbFxuICogcHJlc2VydmVkIHZlcmJhdGltOiB0aGUgRklSU1QgcmVzb2x2ZWQgc2Vzc2lvbiBpcyBwaW5uZWQgZm9yIHRoZSBsaWZlIG9mIHRoZVxuICogd2F0Y2gsIHRoZSBncm91bmRpbmcgbGluZSBuYW1lcyB0aGF0IGJpbmRpbmcgb25jZSwgYW5kIGEgcG9pbnRlciB0aGF0XG4gKiBkaXNhcHBlYXJzIEFGVEVSIHdlIHdlcmUgYm91bmQgZW5kcyB0aGUgd2F0Y2ggYXQgMCDigJQgYSBjb21wbGV0ZWQgd2F0Y2gsIG5vdCBhXG4gKiBmYWlsdXJlLiBBIHBvaW50ZXIgdGhhdCBuZXZlciBhcHBlYXJlZCBrZWVwcyByZXRyeWluZywgd2hpY2ggaXMgd2hhdCBgdGFpbGAnc1xuICogb3duIGhlbHAgcHJvbWlzZXMgKFwid2FpdHMgZm9yIGEgc2Vzc2lvbiwgbmV2ZXIgZXhpdHMgNVwiKS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZUFyZzogbnVtYmVyLFxuICBvOiB7IG9uY2U6IGJvb2xlYW47IHNpbmNlR2l2ZW46IGJvb2xlYW4gfSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgY29uc3QgcmVBcm0gPSBzZXNzaW9uICE9PSB1bmRlZmluZWQgfHwgby5zaW5jZUdpdmVuO1xuICAvLyBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBBMykuXG4gIGxldCBncm91bmRlZCA9IG8uc2luY2VHaXZlbjtcbiAgY29uc3QgcGluID0gKCkgPT4gKGJvdW5kSWQgIT09IHVuZGVmaW5lZCA/IFtcIi0tc2Vzc2lvblwiLCBib3VuZElkXSA6IFtdKTtcblxuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPHsgaWQ/OiBudW1iZXI7IHR5cGU/OiBzdHJpbmcgfT4oXG4gICAge1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICAvLyByZWFkU2Vzc2lvbiBkaWVzIG9uIGEgQ09SUlVQVCBwb2ludGVyIGFuZCByZXR1cm5zIG51bGwgb25seSBmb3IgYVxuICAgICAgICAvLyBnZW51aW5lbHkgYWJzZW50IG9uZSDigJQgdGhlIEVOT0VOVCBydWxlLiBUaGF0IGBkaWVgIG5vdyBUSFJPV1MsIGFuZCB0aGVcbiAgICAgICAgLy8gdGhyb3cgbGVhdmVzIHRoZSB0YWlsIHRocm91Z2ggbWFpbidzIGZ1bm5lbCBpbnN0ZWFkIG9mIGV4aXRpbmcgZnJvbSB0aHJlZVxuICAgICAgICAvLyBmcmFtZXMgZG93biBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcC4gSXQgaXMgRDgncyBhdWRpdCBwYXlpbmcgZm9yIGl0c2VsZjpcbiAgICAgICAgLy8gdGhpcyBpcyB0aGUgb25lIGRpZS1yZWFjaGFibGUgY2FsbCB0aGUgc2hhcmVkIGNsaWVudCBpbnZva2VzIG9uIGEgc2NoZWR1bGUuXG4gICAgICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkOyAvLyBwaW4gdG8gdGhlIGZpcnN0IHNlc3Npb24gd2UgcmVzb2x2ZWRcbiAgICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgICAvLyBncm91bmRpbmcgbGluZSDigJQgcGFyc2VhYmxlIGluIE1vbml0b3IsIG5hbWVzIHRoZSBiaW5kaW5nIHNvIGEgd3JvbmdcbiAgICAgICAgICAvLyBzZXNzaW9uL3BvcnQgaXMgb2J2aW91cyBpbnN0ZWFkIG9mIHNpbGVudC5cbiAgICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHsgZXZlclJlc29sdmVkIH0pID0+IHtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCBnaXZlbiAtLXNlc3Npb24gb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkdcbiAgICAgICAgLy8gc2Vzc2lvbiwgc28gbm90IGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkIChpbiB0aGUgZ2FwLCBzYXkpIOKAlCB0aGVcbiAgICAgICAgLy8gaGFuZG9mZiBzYXlzIGB0YWlsLmNsb3NlZGAsIG5ldmVyIGEgc2lsZW50IHJldHJ5LWZvcmV2ZXIuXG4gICAgICAgIGlmIChldmVyUmVzb2x2ZWQgfHwgcmVBcm0pIHJldHVybiBcInN0b3BcIjtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgICAgcmV0dXJuIFwicmV0cnlcIjtcbiAgICAgIH0sXG4gICAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICAgIHNpbmNlOiBzaW5jZUFyZyxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IGV2LmlkLFxuICAgICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgICAgb25Db21tZW50OiAoKSA9PiBcIjogZ2xhbW91ci1rZWVwYWxpdmVcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIG1vZGU6IG8ub25jZSA/IFwib25jZVwiIDogXCJ3YXRjaFwiLFxuICAgICAgcHJlc2VuY2U6IGZhbHNlLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2UsIG9uY2UgfSkgPT4gdGFpbENvbW1hbmQoWy4uLnNlbGZDb21tYW5kKCksIFwidGFpbFwiLCAuLi5waW4oKV0sIHNpbmNlLCBvbmNlKSxcbiAgICAgICAgY29tZUJhY2s6ICgpID0+XG4gICAgICAgICAgY29tbWFuZExpbmUoWy4uLnNlbGZDb21tYW5kKCksIFwib3BlblwiLCBcIi0tcmVzdG9yZVwiLCBib3VuZElkID8/IFwiPGlkPlwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNtZEluZm8oc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBnbGFtb3VyIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyIChhc3Ryb2xhYmUncyBwYXR0ZXJuLCB2aWEgbWluZC1tYXBwZXIpLiBMYXlvdXQtZGVwZW5kZW50LFxuLy8gc28gYWJzZW5jZSBkZWdyYWRlcyB0byBcInVua25vd25cIiBpbnN0ZWFkIG9mIGludmVudGluZyBvbmUuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKFNLSUxMX1JPT1QsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIiksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwiZ2xhbW91clwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggdG8gdW5rbm93biAqL1xuICB9XG4gIHJldHVybiB7IG5hbWU6IFwiZ2xhbW91clwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vLyDilIDilIAgVEhFIENPTU1BTkQgVEFCTEUsIEFTIEEgU1RSVUNUVVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIFRoZSBkaXNwYXRjaGVyLCB0aGUgc3RhZ2UtMiBmbGFnIGNoZWNrLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCB0aGVcbi8vIGhlbHAgdGV4dCBhbmQgdGhlIGBzY2hlbWFgIGRlY2xhcmF0aW9uIGFsbCB3YWxrIFRISVMuIEl0IHJlcGxhY2VkIGEgYmFyZVxuLy8gYHN3aXRjaGAsIHdoaWNoIG9ubHkgdGhlIGRpc3BhdGNoZXIgY291bGQgd2FsayDigJQgaGVscCBhbmQgdGhlIHN3aXRjaCBoYWRcbi8vIGFscmVhZHkgZHJpZnRlZCBvbmNlICh0aGUgYG9wZW5gIHJvdyBsb3N0IC0tc3RhcnQtdGltZW91dCkg4oCUIGFuZCBhIHNjaGVtYVxuLy8gZW1pdHRlZCBmcm9tIGFueXRoaW5nIG90aGVyIHRoYW4gdGhlIHN0cnVjdHVyZSB0aGF0IHJvdXRlcyB0aGUgYmVoYXZpb3VyXG4vLyBpcyBhIGRvY3VtZW50IHRoYXQgbGllcyBhcyBzb29uIGFzIGFueW9uZSBlZGl0cyB0aGUgb3RoZXIgc2lkZS5cbi8vXG4vLyBgZmxhZ3NgIGlzIHRoZSB2ZXJiJ3MgT1dOIGFjY2VwdGVkIHNldCwgdHlwZWQgYWdhaW5zdCB0aGUgcmVnaXN0cnksIHNvIGFcbi8vIHZlcmIgY2Fubm90IG5hbWUgYSBmbGFnIHRoZSBwYXJzZXIgZG9lcyBub3QgZGVmaW5lLiBgc2Vzc2lvbmAgaXMgbGlzdGVkXG4vLyBwZXIgdmVyYiByYXRoZXIgdGhhbiBtZXJnZWQgYXMgYSBnbG9iYWw6IGBvcGVuYCBzcGF3bnMgYSBzZXNzaW9uIGluc3RlYWQgb2Zcbi8vIHRhcmdldGluZyBvbmUsIGFuZCBgaGVscGAgdGFrZXMgbm90aGluZy5cbnR5cGUgRmxhZyA9IGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUztcbnR5cGUgRmxhZ3MgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbnR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xudHlwZSBDb21tYW5kU3BlYyA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBmbGFnczogcmVhZG9ubHkgRmxhZ1tdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgLy8gVGhlIG9uZS1saW5lIGRlc2NyaXB0aW9uIGhlbHAgcHJpbnRzIGJlc2lkZSB0aGUgdXNhZ2UuXG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8vIOKblCBBIFZFUkIgTUFZIFJFVFVSTiBBTiBFWElUIENPREUsIGFuZCBleGFjdGx5IG9uZSBkb2VzLiBgdGFpbGAgaXMgYSBXQVRDSDpcbiAgLy8gaXQgZW5kcyB3aGVuIHRoZSBkYWVtb24gc2F5cyBgY2xvc2VkYCwgd2hlbiBpdHMgcGlubmVkIHNlc3Npb24gZ29lcyBhd2F5LCBvclxuICAvLyB3aGVuIGEgc2lnbmFsIGFycml2ZXMsIGFuZCB0aGUgc2hhcmVkIGNsaWVudCAoYGtpdC93aXJlL3RhaWxFdmVudHMudHNgKVxuICAvLyBSRVRVUk5TIHRoYXQgY29kZSByYXRoZXIgdGhhbiBjYWxsaW5nIGBwcm9jZXNzLmV4aXRgIGZyb20gaW5zaWRlIGl0cyBvd25cbiAgLy8gbG9vcCDigJQgd2hpY2ggaXMgdGhlIHdob2xlIG9mIHRoZSBQMGYgZHJhaW4gc2Nhci4gYHZvaWRgIHRoZXJlZm9yZSBoYXMgdG8gbWVhblxuICAvLyBcIjBcIiwgbm90IFwibm8gb3BpbmlvblwiOiBkaXNwYXRjaCBjb2VyY2VzIGJlbG93LCBzbyBldmVyeSBvdGhlciByb3cgaXNcbiAgLy8gdW5jaGFuZ2VkIGFuZCBvbmx5IHRoZSB2ZXJiIHRoYXQgaGFzIGEgY29kZSBoYXMgdG8gc2F5IHNvLlxuICBydW46IChcbiAgICBwb3M6IHN0cmluZ1tdLFxuICAgIGZsYWdzOiBGbGFncyxcbiAgICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICkgPT4gUHJvbWlzZTxudW1iZXI+IHwgUHJvbWlzZTx2b2lkPiB8IG51bWJlciB8IHZvaWQ7XG4gIC8vIOKaoCBgdm9pZGAsIG5vdCBgdW5kZWZpbmVkYCwgYW5kIHRoYXQgaXMgdGhlIGNvbnRyYWN0IGFib3ZlIHJhdGhlciB0aGFuIGFcbiAgLy8gbG9vc2VuaW5nOiBldmVyeSBoYW5kbGVyIHRoYXQgcmV0dXJucyBgcG9zdENtZCguLi4pYCByZXR1cm5zIGBQcm9taXNlPHZvaWQ+YCxcbiAgLy8gYW5kIGB1bmRlZmluZWRgIHJlZnVzZWQgYWxsIHNldmVudGVlbiBvZiB0aGVtICh0eXBlLWRlYnQgUGhhc2UgM2MpLiBEaXNwYXRjaFxuICAvLyBtYXBzIGFueSBub24tbnVtYmVyIHRvIDAsIHNvIGB2b2lkYCBpcyBleGFjdGx5IHRoZSBzZXQgaXQgYWNjZXB0cyDigJQgYW5kIGFcbiAgLy8gaGFuZGxlciByZXR1cm5pbmcgYSBzdHJpbmcgb3IgYW4gb2JqZWN0IGlzIHN0aWxsIGEgdHlwZSBlcnJvci4gU3BlbGxlZCBhc1xuICAvLyB0d28gYFByb21pc2VgcyBiZWNhdXNlIGJpb21lJ3Mgbm9Db25mdXNpbmdWb2lkVHlwZSByZWZ1c2VzIGB2b2lkYCBpbnNpZGUgYVxuICAvLyB1bmlvbiB0eXBlIGFyZ3VtZW50OyB0aGUgYWNjZXB0ZWQgc2V0IGlzIHRoZSBzYW1lLlxufTtcblxuY29uc3QgU0VTU0lPTiA9IFtcInNlc3Npb25cIl0gYXMgY29uc3Qgc2F0aXNmaWVzIHJlYWRvbmx5IEZsYWdbXTtcbmNvbnN0IFAgPSB7XG4gIHRleHQ6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gIGlkOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICBpZFRleHQ6IFtcbiAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgXSxcbiAgaWRzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgbm9uZTogW10gYXMgUG9zaXRpb25hbFNwZWNbXSxcbn0gc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIFBvc2l0aW9uYWxTcGVjW10+O1xuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJ0aXRsZVwiLCBcImludGVudFwiLCBcIm5vLW9wZW5cIiwgXCJ0aW1lb3V0XCIsIFwic3RhcnQtdGltZW91dFwiLCBcInJlc3RvcmVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKTsgcHJpbnRzIHt1cmwsIHBvcnQsIHNlc3Npb25faWR9XCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MpID0+IGNtZE9wZW4oZmxhZ3MpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInNpbmNlXCIsIFwib25jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3I7IHdhaXRzIGZvciBhIHNlc3Npb24sIG5ldmVyIGV4aXRzIDUpOyAke1dJTkRPV19IRUxQfWAsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBjbWRUYWlsKHNlc3Npb24sIHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUludChmbGFncy5zaW5jZSwgMTApIDogLTEsIHtcbiAgICAgICAgb25jZTogZmxhZ3Mub25jZSA9PT0gdHJ1ZSxcbiAgICAgICAgc2luY2VHaXZlbjogdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiLFxuICAgICAgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJsZWFuIHN0YXRlIHNuYXBzaG90ICgtLWZ1bGwgZm9yIHJhdyBpbmNsLiBiYXNlNjQpXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbnRlbnRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC50ZXh0LFxuICAgIGRlc2NyaWJlOiBcInVwZGF0ZSB0aGUgc2Vzc2lvbiBpbnRlbnRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiaW50ZW50XCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYW5ub3RhdGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC5pZFRleHQsXG4gICAgZGVzY3JpYmU6IFwid3JpdGUgYWdlbnQgYW5ub3RhdGlvbiBvbnRvIGEgbGlicmFyeSBpdGVtXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IFtpZCwgLi4ud29yZHNdID0gcG9zO1xuICAgICAgcmV0dXJuIHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIml0ZW0uYW5ub3RhdGVcIiwgaWQsIGFnZW50OiB3b3Jkcy5qb2luKFwiIFwiKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwia2luZFwiXSxcbiAgICBwb3NpdGlvbmFsczogUC50ZXh0LFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYWdlbnQgZGlhbG9ndWUgaW50byB0aGUgY29udmVyc2F0aW9uICgtLWtpbmQgaW5mb3x3b3JraW5nfHJlc3VsdHxlcnJvcilcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU2F5Q21kKHBvcywgZmxhZ3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VjdGlvblwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGF0dXNcIiwgXCJjb250ZW50XCIsIFwicHJvbXB0c1wiLCBcImNvbG9yc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJrZXlcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6ICdzaGFwZSBhIHN0eWxlLWd1aWRlIHNlY3Rpb24gKC0tcHJvbXB0cyBhfHxiOyAtLWNvbG9ycyBcIiNoZXg6TmFtZXx8I2hleDpOYW1lXCIpJyxcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU2VjdGlvbkNtZChwb3MsIGZsYWdzKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXR1c1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwib258b2ZmXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzaG93L2hpZGUgdGhlIHdvcmtpbmcgc3Bpbm5lclwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBvbiA9IHBvc1swXSA9PT0gXCJvblwiO1xuICAgICAgY29uc3QgdGV4dCA9IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSB8fCB1bmRlZmluZWQ7XG4gICAgICByZXR1cm4gcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IG9uLCAuLi4odGV4dCA/IHsgdGV4dCB9IDoge30pIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdlblwiLFxuICAgIGZsYWdzOiBbXG4gICAgICAuLi5TRVNTSU9OLFxuICAgICAgXCJ1cmxcIixcbiAgICAgIFwiZmlsZVwiLFxuICAgICAgXCJzcmNcIixcbiAgICAgIFwicHJvbXB0XCIsXG4gICAgICBcIm1vZGVsXCIsXG4gICAgICBcInJvdW5kXCIsXG4gICAgICBcInNlZWRcIixcbiAgICAgIFwiY29zdFwiLFxuICAgICAgXCJsYWJlbFwiLFxuICAgICAgXCJjdXN0b21cIixcbiAgICBdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInBvc3QgYSBnZW5lcmF0ZWQgaW1hZ2UgKG9uZSBvZiAtLXVybHwtLWZpbGV8LS1zcmMsIGFuZCAtLXByb21wdCAtLW1vZGVsIC0tcm91bmQgcmVxdWlyZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIC8vIOKblCBgY2hvaWNlc2AgTkFNRVMgV0hBVCBJUyBNSVNTSU5HLCBGSUxURVJFRCBGUk9NIFRIRSBSRVFVSVJFRCBTRVQg4oCUXG4gICAgICAvLyBzbyB0aGUgc2V0IHRoZSBtZXNzYWdlIGFzc2VydHMgYW5kIHRoZSBzZXQgdGhlIGNoZWNrIGVuZm9yY2VzIGNhbm5vdFxuICAgICAgLy8gYmUgdHdvIGxpc3RzLiBgZ2VuIC0tcHJvbXB0IHAgLS1tb2RlbCBtYCBhbnN3ZXJzIGBbXCItLXJvdW5kXCJdYCwgd2hpY2hcbiAgICAgIC8vIGlzIG9uZSByZXBhaXIgcmF0aGVyIHRoYW4gdGhyZWUgdG8gcmUtcmVhZC5cbiAgICAgIGNvbnN0IG1pc3NpbmdHZW4gPSBHRU5fUkVRVUlSRURfRkxBR1MuZmlsdGVyKChrKSA9PiAhZmxhZ3Nba10pLm1hcCgoaykgPT4gYC0tJHtrfWApO1xuICAgICAgaWYgKG1pc3NpbmdHZW4ubGVuZ3RoID4gMClcbiAgICAgICAgZGllKGB1c2FnZTogJHt1c2FnZU9mKGZpbmRDb21tYW5kKFwiZ2VuXCIpIGFzIENvbW1hbmRTcGVjKX1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBoaW50OiBgbWlzc2luZyByZXF1aXJlZCAke21pc3NpbmdHZW4uam9pbihcIiBcIil9YCxcbiAgICAgICAgICBjaG9pY2VzOiBtaXNzaW5nR2VuLFxuICAgICAgICB9KTtcbiAgICAgIGNvbnN0IHNyYyA9IGF3YWl0IHJlc29sdmVHZW5TcmMoZmxhZ3MpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBidWlsZEdlbkNtZChzcmMsIGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2VuLWNvc3RcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiY29zdFwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5pZCxcbiAgICBkZXNjcmliZTogXCJiYWNrZmlsbCBhIGdlbmVyYXRlZCBpbWFnZSdzIGNvc3QgKC0tY29zdCA8bj4gcmVxdWlyZWQpXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgY29zdCA9IHR5cGVvZiBmbGFncy5jb3N0ID09PSBcInN0cmluZ1wiID8gTnVtYmVyLnBhcnNlRmxvYXQoZmxhZ3MuY29zdCkgOiBOdW1iZXIuTmFOO1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoY29zdCkpXG4gICAgICAgIGRpZShgdXNhZ2U6ICR7dXNhZ2VPZihmaW5kQ29tbWFuZChcImdlbi1jb3N0XCIpIGFzIENvbW1hbmRTcGVjKX0g4oCUIC0tY29zdCBtdXN0IGJlIGEgbnVtYmVyYCk7XG4gICAgICByZXR1cm4gcG9zdENtZChzZXNzaW9uLCBidWlsZEdlbkNvc3RDbWQocG9zLCBmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdlbi1tZXRhXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInByb21wdFwiLCBcImN1c3RvbVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5pZCxcbiAgICBkZXNjcmliZTogXCJiYWNrZmlsbCB0aGUgcmVhbCBwcm9tcHQgLyByZWZzIG9udG8gYSBnZW4gKC0tcHJvbXB0IGFuZC9vciAtLWN1c3RvbSlcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICAvLyBBIERJU0pVTkNUSU9OLCBzbyBgY2hvaWNlc2AgaXMgdGhlIHdob2xlIHNldCByYXRoZXIgdGhhbiB0aGUgbWlzc2luZ1xuICAgICAgLy8gaGFsZjogZWl0aGVyIG9uZSBzYXRpc2ZpZXMgdGhpcywgYW5kIHRoZSBjYWxsZXIgcGlja3MuXG4gICAgICBpZiAoIUdFTl9NRVRBX0ZMQUdTLnNvbWUoKGspID0+IGZsYWdzW2tdICE9PSB1bmRlZmluZWQpKVxuICAgICAgICBkaWUoYHVzYWdlOiAke3VzYWdlT2YoZmluZENvbW1hbmQoXCJnZW4tbWV0YVwiKSBhcyBDb21tYW5kU3BlYyl9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgaGludDogYGdpdmUgb25lIG9mICR7R0VOX01FVEFfRkxBR1MubWFwKChrKSA9PiBgLS0ke2t9YCkuam9pbihcIiBcIil9YCxcbiAgICAgICAgICBjaG9pY2VzOiBHRU5fTUVUQV9GTEFHUy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICAgICAgfSk7XG4gICAgICByZXR1cm4gcG9zdENtZChzZXNzaW9uLCBidWlsZEdlbk1ldGFDbWQocG9zLCBmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImZvY3VzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAuaWRzLFxuICAgIGRlc2NyaWJlOiBcInNjb3BlIHRoZSBmb2N1cyBsZW5zIHRvIHRoZXNlIGl0ZW1zICgrIC0tbm90ZSB0byBhc2spXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCBidWlsZEZvY3VzQ21kKHBvcywgZmxhZ3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3R5bGUtc2F2ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImxhYmVsXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjb2RpZnkgdGhlIGN1cnJlbnQgc3R5bGUg4oaSIHByb2plY3QgdHJheVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU3R5bGVTYXZlQ21kKHBvcykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdHlsZS1hcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInVuYXJjaGl2ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5pZCxcbiAgICBkZXNjcmliZTogXCJhcmNoaXZlIChvciAtLXVuYXJjaGl2ZSkgYSBzYXZlZCBzdHlsZVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRTdHlsZUFyY2hpdmVDbWQocG9zLCBmbGFncykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0cmF5XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJsaXN0IHRoZSBwcm9qZWN0J3Mgc2F2ZWQgc3R5bGVzXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gICAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGU/bGVhbj0xXCIpO1xuICAgICAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwidHJheVwiLCBzdGF0dXMsIGRhdGEpO1xuICAgICAgcHJpbnRKc29uKChkYXRhIGFzIHsgc3RhdGU/OiB7IHRyYXk/OiB1bmtub3duW10gfSB9KT8uc3RhdGU/LnRyYXkgPz8gW10pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJzaHV0IGRvd24gdGhlIHNlc3Npb25cIixcbiAgICBydW46IChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImNsb3NlXCIgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSByZXNvbHZlZCBkaXNjb3ZlcnkgSlNPTlwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kSW5mbyhzZXNzaW9uKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwiZW1pdCB0aGlzIENMSSdzIGFjYyBkZWNsYXJhdGlvbiAod2Fsa2VkIGZyb20gdGhlIGNvbW1hbmQgdGFibGUpXCIsXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShidWlsZERlY2xhcmF0aW9uKCksIG51bGwsIDIpfVxcbmApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhlbHBcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZVwiLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVySGVscCgpfVxcbmApO1xuICAgIH0sXG4gIH0sXG5dO1xuXG4vLyBSb290IGludGVyY2VwdG9ycyDigJQgdG9rZW5zIHRoZSBST09UIGFuc3dlcnMgaXRzZWxmLCBiZWZvcmUgYW55IHZlcmIuIE5vdFxuLy8gY29tbWFuZHMgYW5kIG5vdCByZWdpc3RyeSBmbGFncywgc28gdGhleSBhcmUgZGVjbGFyZWQgZXhwbGljaXRseSBhdFxuLy8gcGF0aCBbXSByYXRoZXIgdGhhbiB3YWxrZWQgcGFzdC5cbmNvbnN0IFJPT1RfSU5URVJDRVBUT1JTID0gW1xuICB7IG5hbWU6IFwiLS1oZWxwXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItaFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLS12ZXJzaW9uXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG4gIHsgbmFtZTogXCItVlwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuY29uc3QgZmluZENvbW1hbmQgPSAodG9rZW46IHN0cmluZyk6IENvbW1hbmRTcGVjIHwgdW5kZWZpbmVkID0+XG4gIENPTU1BTkRTLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gdG9rZW4pO1xuXG4vLyBUaGUgdmVyYiB0b2tlbiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCBmaW5kIGl0OiBhXG4vLyBzdHJpbmcgZmxhZyBDT05TVU1FUyB0aGUgbmV4dCB0b2tlbiAoYC0tc2Vzc2lvbiBhYmMgc2F5YCDihpIgXCJzYXlcIiwgbm90XG4vLyBcImFiY1wiKSwgYC0ta2V5PXZhbHVlYCBjb25zdW1lcyBub3RoaW5nLCBhIGJhcmUgYC0tYCBlbmRzIGZsYWcgcGFyc2luZywgYW5kXG4vLyB0aGUgZmlyc3QgdG9rZW4gbGVmdCBzdGFuZGluZyBpcyB0aGUgdmVyYi4gVXNlZCBvbmx5IHRvIG5hbWUgdGhlIHZlcmIgb24gYVxuLy8gcmVqZWN0aW9uIHJhaXNlZCBCRUZPUkUgdGhlIHBhcnNlIHN1Y2NlZWRzIChhIHN0cmF5IGZsYWcpIOKAlCB0aGUgcGFyc2UncyBvd25cbi8vIHBvc2l0aW9uYWxzIGFyZSB0aGUgdHJ1dGggYWZ0ZXJ3YXJkcy4gQSBuYWl2ZSBcImZpcnN0IG5vbi1kYXNoIHRva2VuXCIgd2FzXG4vLyB0aGUgcmV2aWV3J3MgZmluZGluZzogaXQgbmFtZWQgYSBmbGFnJ3MgdmFsdWUgYXMgdGhlIHZlcmIuXG5leHBvcnQgZnVuY3Rpb24gdmVyYlRva2VuKGFyZ3Y6IHN0cmluZ1tdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJndi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGEgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gYXJndltpICsgMV0gPz8gbnVsbDtcbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgIGlmIChhLmluY2x1ZGVzKFwiPVwiKSkgY29udGludWU7XG4gICAgICBjb25zdCBrZXkgPSBhLnNsaWNlKDIpIGFzIGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUztcbiAgICAgIGlmIChrZXkgaW4gQ0xJX09QVElPTlMgJiYgQ0xJX09QVElPTlNba2V5XS50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi1cIikpIGNvbnRpbnVlO1xuICAgIHJldHVybiBhO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vLyBUaGUgZGVyaXZlZCB2aWV3cyB0aGUgdGVzdHMgYW5kIHRoZSByZWplY3Rpb25zIHJlYWQuIFZFUkJTIGlzIHRoZSByb3N0ZXI7XG4vLyBWRVJCX1NQRUMgaXMgZWFjaCB2ZXJiJ3MgYWNjZXB0ZWQgZmxhZ3M7IGZsYWdzRm9yIHJlbmRlcnMgb25lIHJvdyBhcyB0aGVcbi8vIGBjaG9pY2VzYCBhIHJlamVjdGlvbiBjYXJyaWVzLlxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IENPTU1BTkRTLm1hcCgoYykgPT4gYy5uYW1lKTtcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IEZsYWdbXT4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gIENPTU1BTkRTLm1hcCgoYykgPT4gW2MubmFtZSwgYy5mbGFnc10pLFxuKTtcbmV4cG9ydCBjb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICBbLi4uKGZpbmRDb21tYW5kKHZlcmIpPy5mbGFncyA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuLy8g4pSA4pSAIGhlbHAgYW5kIHRoZSBkZWNsYXJhdGlvbiwgYm90aCB3YWxrZWQgZnJvbSBDT01NQU5EUyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuY29uc3QgcmVuZGVyRmxhZyA9IChrOiBGbGFnKTogc3RyaW5nID0+XG4gIENMSV9PUFRJT05TW2tdLnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG5cbmNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICBjb25zdCBpbm5lciA9IHAudmFyaWFkaWMgPyBgJHtwLm5hbWV9Li4uYCA6IHAubmFtZTtcbiAgcmV0dXJuIHAucmVxdWlyZWQgPyBgPCR7aW5uZXJ9PmAgOiBgWyR7aW5uZXJ9XWA7XG59O1xuXG4vLyBUaGUgdXNhZ2UgbGluZTogdmVyYiwgcG9zaXRpb25hbHMsIHRoZW4gdGhlIHZlcmIncyBvd24gZmxhZ3MgKHNlc3Npb24gaXNcbi8vIHJlbmRlcmVkIG9uY2UgaW4gdGhlIGZvb3Rlciwgbm90IG9uIGV2ZXJ5IHJvdykuXG5leHBvcnQgZnVuY3Rpb24gdXNhZ2VPZihzcGVjOiBDb21tYW5kU3BlYyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzID0gW1xuICAgIHNwZWMubmFtZSxcbiAgICAuLi5zcGVjLnBvc2l0aW9uYWxzLm1hcChyZW5kZXJQb3NpdGlvbmFsKSxcbiAgICAuLi5zcGVjLmZsYWdzLmZpbHRlcigoaykgPT4gayAhPT0gXCJzZXNzaW9uXCIpLm1hcChyZW5kZXJGbGFnKSxcbiAgXTtcbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCIgXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVySGVscCgpOiBzdHJpbmcge1xuICBjb25zdCByb3dzID0gQ09NTUFORFMubWFwKChjKSA9PiBbdXNhZ2VPZihjKSwgYy5kZXNjcmliZV0gYXMgY29uc3QpO1xuICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLnJvd3MubWFwKChbdV0pID0+IHUubGVuZ3RoKSksIDQ0KTtcbiAgY29uc3QgYm9keSA9IHJvd3NcbiAgICAubWFwKChbdXNhZ2UsIGRlc2NyaWJlXSkgPT5cbiAgICAgIHVzYWdlLmxlbmd0aCA8PSB3aWR0aFxuICAgICAgICA/IGAgICR7dXNhZ2UucGFkRW5kKHdpZHRoKX0gICR7ZGVzY3JpYmV9YFxuICAgICAgICA6IGAgICR7dXNhZ2V9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZGVzY3JpYmV9YCxcbiAgICApXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIHJldHVybiBgZ2xhbW91ciDigJQgYSBncm91bmRlZCB2aXN1YWwgY29udmVyc2F0aW9uIHN1cmZhY2UuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93OyBhIHJlY29nbml6ZWQgZmxhZyBvbiB0aGUgd3JvbmdcbiAgdmVyYiBpcyByZWZ1c2VkLCBhbmQgdGhlIHJlamVjdGlvbiBsaXN0cyB0aGUgdmVyYidzIG93biBmbGFncy5cblxuICBPdXRwdXQ6IGV2ZXJ5IHZlcmIgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlFxuICBleGNlcHQgdGFpbCwgYSBzdHJlYW0gdGhhdCBwcmludHMgb25lIEpTT04gbGluZSBwZXIgZXZlbnQsIGFuZCBoZWxwLCB3aGljaCBpc1xuICBwcm9zZS4gRmFpbHVyZXMgYXJlIG9uZSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciBhbmQgZXhpdCBub24temVybyAoMiA9IHVzYWdlLFxuICAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdCkg4oCUIGV4Y2VwdCB0YWlsLCB3aGljaCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIGluc3RlYWQgb2YgZmFpbGluZyBhbmQgd3JpdGVzIGl0cyByZXRyeS9rZWVwYWxpdmUgbm90ZXMgdG8gc3RkZXJyIGFzXG4gICcjJy1wcmVmaXhlZCBwcm9zZS5gO1xufVxuXG4vLyBhY2MgZGVjbGFyYXRpb24gZm9ybWF0IHYwLCBnZW5lcmF0ZWQgYnkgV0FMS0lORyBDT01NQU5EUyBhbmQgQ0xJX09QVElPTlMg4oCUXG4vLyB0aGUgc2FtZSBzdHJ1Y3R1cmVzIHRoZSBwYXJzZXIgYW5kIGRpc3BhdGNoZXIgY29uc3VtZSDigJQgYXQgYW5zd2VyIHRpbWUsIHNvXG4vLyBgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCJgIGlzIHRydWUgcmF0aGVyIHRoYW4gY2xhaW1lZC4gUGlwZXMgc3RyYWlnaHQgaW50b1xuLy8gYGFjYyBjaGVjayA8Y2xpLnRzPiAtLWRlY2xhcmF0aW9uIDwoY2xpLnRzIHNjaGVtYSlgLlxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIC8vIEV2ZXJ5IHJlZ2lzdHJ5IGZsYWcgaXMgYWNjZXB0ZWQgdG9kYXk7IGEgcmVmdXNhbCBsaXN0IHdvdWxkIGFkZFxuICAvLyBzdGF0dXM6IFwicmVmdXNlZFwiIGVudHJpZXMgaGVyZSB0aGUgZGF5IGEgdmVyYiByZWNvZ25pc2VzLWFuZC1kZWNsaW5lcyBvbmUuXG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIGNvbnN0IGNvbW1hbmRzOiB7XG4gICAgcGF0aDogc3RyaW5nW107XG4gICAgYXJnczogeyBuYW1lOiBzdHJpbmc7IHR5cGU6IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjsgc3RhdHVzOiBzdHJpbmcgfVtdO1xuICAgIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICB9W10gPSBbXG4gICAge1xuICAgICAgLy8gcGF0aCBbXSBJUyB0aGUgcm9vdDogb25lIHJlcXVpcmVkIHRva2VuIHNlbGVjdGluZyBhIHZlcmIsIG9yIGFuXG4gICAgICAvLyBpbnRlcmNlcHRvciB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi5cbiAgICAgIHBhdGg6IFtdLFxuICAgICAgYXJnczogUk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiAoe1xuICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgICAgIH0pKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgfSxcbiAgICAuLi5DT01NQU5EUy5tYXAoKGMpID0+ICh7XG4gICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgIGFyZ3M6IFsuLi5jLmZsYWdzXS5tYXAoYXJnKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLFxuICAgIH0pKSxcbiAgXTtcbiAgcmV0dXJuIHtcbiAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW1wic2NoZW1hXCJdIH0sXG4gICAgY29tbWFuZHMsXG4gIH07XG59XG5cbi8vIEV2ZXJ5IGZhaWx1cmUgZnVubmVscyB0aHJvdWdoIGhlcmUgYW5kIFJFVFVSTlMgaXRzIGNvZGUsIHNvIHRoZSBydW50aW1lXG4vLyBkcmFpbnMgc3Rkb3V0LiBVbmNhdWdodCwgYSBmYWlsdXJlIHdvdWxkIHN1cmZhY2UgYXMgYSByYXcgc3RhY2sgdHJhY2UgYXQgZXhpdFxuLy8gMSwgd2hpY2ggaXMgbm90IGEgdXNhZ2UgZXJyb3IgdG8gYW55b25lIHJlYWRpbmcgaXQuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBUaGUgaG91c2UgZnVubmVsOiBgcmVwb3J0Q2xpRXJyb3JgIHdyaXRlcyB0aGUgZW52ZWxvcGUgYW5kIGhhbmRzIGJhY2sgdGhlXG4gICAgLy8gdGF4b25vbXkgZXhpdCBjb2RlLCBvciBgbnVsbGAgd2hlbiB0aGUgdGhyb3cgd2FzIG5vdCBhIENsaUVycm9yLlxuICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgY29uc3QgY29kZSA9XG4gICAgICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbiAgICBjb25zdCBtc2cgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUgcGF0aHMpIOKAlCB0aGUgY2FsbGVyJ3MuXG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiByZXBvcnRDbGlFcnJvcihuZXcgVXNhZ2VFcnJvcihtc2cpKSA/PyAyO1xuICAgIC8vIEV2ZXJ5dGhpbmcgZWxzZSBpcyBnbGFtb3VyJ3Mgb3duIGZhdWx0OiBvbmUgSU5URVJOQUwgZW52ZWxvcGUsIG5ldmVyIGFcbiAgICAvLyBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuXG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICAvLyBST09UIElOVEVSQ0VQVE9SUyBGSVJTVCwgYmVmb3JlIGFueSBmbGFnIHBhcnNpbmcgKG1hZ3BpZS9hc3Ryb2xhYmVcbiAgLy8gcGF0dGVybikuIFRoZXkgYXJlIG5vdCBjb21tYW5kcyBhbmQgbm90IHJlZ2lzdHJ5IGZsYWdzIOKAlCBgc3RhdGUgLS12ZXJzaW9uYFxuICAvLyBzdGF5cyByZWZ1c2VkIOKAlCB3aGljaCBpcyB3aHkgdGhleSBhcmUgZGVjbGFyZWQgZXhwbGljaXRseSBhdCBwYXRoIFtdIGFuZFxuICAvLyB3aHkgYSBnZW5lcmF0b3Igd2Fsa2luZyBcInRoZSBjb21tYW5kc1wiIHdvdWxkIHdhbGsgcGFzdCB0aGVtLlxuICBjb25zdCBpbnRlcmNlcHRvciA9IFJPT1RfSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gYXJndlswXSk7XG4gIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkIHx8IGFyZ3ZbMF0gPT09IFwidmVyc2lvblwiKSB7XG4gICAgY29uc3QgcnVucyA9IGludGVyY2VwdG9yPy5ydW5zID8/IFwidmVyc2lvblwiO1xuICAgIGlmIChydW5zID09PSBcImhlbHBcIikgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVySGVscCgpfVxcbmApO1xuICAgIGVsc2UgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkodmVyc2lvbkluZm8oKSl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICAvLyBUaGUgV0hPTEUgYXJndiBpcyBwYXJzZWQsIHZlcmIgaW5jbHVkZWQsIHNvIGEgYmFyZSBgLS1gIGlzIGhvbm91cmVkIGF0XG4gIC8vIHRoZSByb290IChhY2MgQTYpOiBgLS0gLS14YCB5aWVsZHMgdGhlIHBvc2l0aW9uYWwgXCItLXhcIiwgd2hpY2ggaXMgdGhlbiBhblxuICAvLyB1bmtub3duIHZlcmIg4oCUIG5vdCBhbiB1bmtub3duIG9wdGlvbi5cbiAgLy8gTmFtZSB0aGUgdmVyYiBCRUZPUkUgcGFyc2luZywgc28gYSBwYXJzZXIgcmVqZWN0aW9uJ3MgZW52ZWxvcGUgc3RpbGwgc2F5c1xuICAvLyB3aGF0IHdhcyBiZWluZyBydW4uXG4gIC8vIFRoZSB2ZXJiLCBuYW1lZCBCRUZPUkUgcGFyc2luZywgc28gYSBwYXJzZXIgcmVqZWN0aW9uJ3MgZW52ZWxvcGUgc3RpbGwgc2F5c1xuICAvLyB3aGF0IHdhcyBiZWluZyBydW4uIEl0IGxpdmVzIGluIHRoZSBraXQgbm93IOKAlCBvbmUgbW9kdWxlIG93bnMgdGhlIGVudmVsb3BlLFxuICAvLyBzbyBpdCBvd25zIHRoZSBmaWVsZCB0aGUgZW52ZWxvcGUgcHJpbnRzLlxuICBsZXQgY3VycmVudENvbW1hbmQgPSB2ZXJiVG9rZW4oYXJndik7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3MoYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgLy8gQW4gdW5rbm93biBmbGFnJ3MgcmVqZWN0aW9uIG5hbWVzIHRoZSBzZXQgQVQgVEhJUyBQQVRILCBub3QgdGhlIHdob2xlXG4gICAgLy8gcmVnaXN0cnk6IHRoZSB2ZXJiJ3Mgb3duIGZsYWdzIHdoZW4gdGhlIHZlcmIgaXMgb25lIG9mIG91cnMsIHRoZSB2ZXJiXG4gICAgLy8gcm9zdGVyIHdoZW4gdGhlcmUgaXMgbm8gdmVyYiB5ZXQgKHRoZSByb290IGFjY2VwdHMgbm8gZmxhZ3Mgb2YgaXRzIG93bikuXG4gICAgLy8gVGhpcyBpcyB3aGF0IGEgcmVjb3JkZWQtc3VyZmFjZSBjZW5zdXMgcmVhZHMsIHBhdGggYnkgcGF0aC5cbiAgICBjb25zdCBzcGVjID0gY3VycmVudENvbW1hbmQgPT09IG51bGwgPyB1bmRlZmluZWQgOiBmaW5kQ29tbWFuZChjdXJyZW50Q29tbWFuZCk7XG4gICAgaWYgKHNwZWMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7IGhpbnQ6IGUuZXh0cmE/LmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgfVxuICAgIC8vIEF0IHRoZSByb290IHRoZSBmbGFncyB0aGUgdG9vbCBhY2NlcHRzIGFyZSB0aGUgaW50ZXJjZXB0b3JzLCBhbmQgdGhhdCBpc1xuICAgIC8vIHRoZSBzZXQgbmFtZWQg4oCUIHRoZSBzYW1lIGFycmF5IGBzY2hlbWFgIGRlY2xhcmVzIGF0IHBhdGggW10sIHNvIHRoZVxuICAgIC8vIHJvb3QgaXMgZGlmZmFibGUuIFRoZSB2ZXJiIHJvc3RlciByaWRlcyB0aGUgaGludDogdGhlIG5leHQgYWN0IGlzIGEgdmVyYi5cbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlLm1lc3NhZ2UsIHtcbiAgICAgIGhpbnQ6IGBubyB2ZXJiIGdpdmVuIOKAlCB2ZXJiczogJHtWRVJCUy5qb2luKFwiIFwiKX0gKHJ1bjogY2xpLnRzIGhlbHApYCxcbiAgICAgIGNob2ljZXM6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKSxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBbdmVyYiwgLi4ucG9zXSA9IHBhcnNlZC5wb3M7XG4gIGNvbnN0IGZsYWdzID0gcGFyc2VkLmZsYWdzO1xuICBjdXJyZW50Q29tbWFuZCA9IHZlcmIgPz8gbnVsbDtcbiAgc2V0Q3VycmVudENvbW1hbmQoY3VycmVudENvbW1hbmQpO1xuXG4gIGlmICh2ZXJiID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBCYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciAoYWNjIEQyKSwgYW5kIHRoZSByZWplY3Rpb24gbmFtZXNcbiAgICAvLyB0aGUgcm9zdGVyIHNvIHRoZSBjYWxsZXIncyBuZXh0IGNvbW1hbmQgY2FuIGJlIHJpZ2h0LlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBbLi4uVkVSQlNdIH0pO1xuICB9XG4gIGNvbnN0IHNwZWMgPSBmaW5kQ29tbWFuZCh2ZXJiKTtcbiAgaWYgKHNwZWMgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1bmtub3duIHZlcmIgXCIke3ZlcmJ9XCJgLCB7XG4gICAgICBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIixcbiAgICAgIGNob2ljZXM6IFsuLi5WRVJCU10sXG4gICAgfSk7XG4gIH1cblxuICAvLyBTdGFnZSAyOiBhIHJlY29nbml6ZWQgZmxhZyB0aGlzIHZlcmIgZG9lcyBub3QgdGFrZSDigJQgTUlTUExBQ0VELCBub3RcbiAgLy8gdW5rbm93bi4gQW4gYWdlbnQgdG9sZCBhIHJlYWwgZmxhZyBpcyB1bmtub3duIGdvZXMgaHVudGluZyBhIHR5cG8gaXQgZGlkXG4gIC8vIG5vdCBtYWtlLiBUaGUgdmVyYiBpcyByZXNvbHZlZCBmaXJzdCBiZWNhdXNlIHdoaWNoIGZsYWdzIGFyZSBsZWdhbCBpcyBhXG4gIC8vIHF1ZXN0aW9uIGFib3V0IHRoZSB2ZXJiLlxuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KHNwZWMuZmxhZ3MpO1xuICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKGZsYWdzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFjY2VwdGVkID0gZmxhZ3NGb3Ioc3BlYy5uYW1lKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3NwZWMubmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBnbGFtb3VyIGZsYWcsIGp1c3Qgbm90IHRoaXMgdmVyYidzKWAsXG4gICAgICBhY2NlcHRlZC5sZW5ndGggPiAwID8geyBjaG9pY2VzOiBhY2NlcHRlZCB9IDogeyBoaW50OiBgJHtzcGVjLm5hbWV9IHRha2VzIG5vIGZsYWdzYCB9LFxuICAgICk7XG4gIH1cblxuICAvLyBBcml0eSwgZW5mb3JjZWQgRlJPTSBUSEUgREVDTEFSRUQgU0hBUEU6IHRoZSB0YWJsZSdzIHBvc2l0aW9uYWwgc3BlYyBpc1xuICAvLyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcyBhbmQgd2hhdCBoZWxwIHByaW50cywgc28gZW5mb3JjaW5nIGl0IGhlcmUga2VlcHNcbiAgLy8gYm90aCB0cnVlIGJ5IGNvbnN0cnVjdGlvbi4gQSB2ZXJiJ3Mgb3duIGZpbmVyIGNoZWNrcyAoYSBudW1lcmljIC0tY29zdCxcbiAgLy8gYSByZXF1aXJlZCBmbGFnKSBsaXZlIGluIGl0cyBoYW5kbGVyIGFuZCBuYW1lIHRoZSBzYW1lIHVzYWdlIGxpbmUuXG4gIGNvbnN0IHJlcXVpcmVkID0gc3BlYy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgY29uc3QgdmFyaWFkaWMgPSBzcGVjLnBvc2l0aW9uYWxzLnNvbWUoKHApID0+IHAudmFyaWFkaWMpO1xuICBpZiAocG9zLmxlbmd0aCA8IHJlcXVpcmVkIHx8ICghdmFyaWFkaWMgJiYgcG9zLmxlbmd0aCA+IHNwZWMucG9zaXRpb25hbHMubGVuZ3RoKSkge1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGB1c2FnZTogJHt1c2FnZU9mKHNwZWMpfWAsIHsgaGludDogc3BlYy5kZXNjcmliZSB9KTtcbiAgfVxuXG4gIGNvbnN0IHNlc3Npb24gPSB0eXBlb2YgZmxhZ3Muc2Vzc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnNlc3Npb24gOiB1bmRlZmluZWQ7XG4gIC8vIGB2b2lkYCBtZWFucyAwIOKAlCBhIHZlcmIgdGhhdCBjb21wbGV0ZWQgYW5kIGhhZCBub3RoaW5nIHRvIHNheSBhYm91dCB0aGUgZXhpdC5cbiAgLy8gQSBudW1iZXIgbWVhbnMgdGhlIHZlcmIgT1dOUyBpdHMgY29kZSwgd2hpY2ggdG9kYXkgaXMgYHRhaWxgIGFuZCBvbmx5IGB0YWlsYC5cbiAgY29uc3QgY29kZSA9IGF3YWl0IHNwZWMucnVuKHBvcywgZmxhZ3MsIHNlc3Npb24pO1xuICByZXR1cm4gdHlwZW9mIGNvZGUgPT09IFwibnVtYmVyXCIgPyBjb2RlIDogMDtcbn1cblxuLyoqXG4gKiBUaGUgQ0xJJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zY3JpcHRzL2NsaS50c2AuXG4gKlxuICog4puUIGBpbXBvcnQubWV0YS5tYWluYCBJUyBGQUxTRSBJTiBUSEUgQlVORExFIOKAlCBgZGlzdC9jbGkuanNgIGlzIElNUE9SVEVEIGJ5XG4gKiB0aGUgbGF1bmNoZXIsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzIGVudHJ5LCBzbyBhbiBgaWYgKGltcG9ydC5tZXRhLm1haW4pYFxuICogYmxvY2sgaGVyZSB3b3VsZCBuZXZlciBydW46IHRoZSBDTEkgd291bGQgcHJpbnQgbm90aGluZyBhbmQgZXhpdCAwIGZvciBldmVyeVxuICogdmVyYi4gVGhpcyBleHBvcnQgaXMgd2hhdCByZXBsYWNlcyBpdC5cbiAqXG4gKiDim5QgSVQgUkVUVVJOUyBUSEUgQ09ERSBSQVRIRVIgVEhBTiBTRVRUSU5HIElULiBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbiAqIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlXG4gKiAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdFxuICogZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5XG4gKiB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBnbGFtb3VyJ3MgYHN0YXRlIC0tZnVsbGAgc2hpcHMgYmFzZTY0IHBheWxvYWRzIGZhciBwYXN0IHRoYXRcbiAqIGJvdW5kYXJ5LCBzbyB0aGlzIGlzIG5vdCB0aGVvcmV0aWNhbCBoZXJlLiBSZXByb2R1Y2VkLCBmaXhlZCBhbmQgZ2F0ZWQgaW5cbiAqIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLiBUaGUgYXNzaWdubWVudCBoYXBwZW5zIG9uY2UsIGluIHRoZSBsYXVuY2hlci5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUzogdGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgUEFSU0VTXG4gKiBpdC4gQSBsYXVuY2hlciByZWFkaW5nIGBwcm9jZXNzLmFyZ3ZgIHdvdWxkIG1hdGNoIHRoZSBhcmctcGFyc2luZyBwcmVkaWNhdGUgaW5cbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCBhbmQgdGhlIGZsYWcgd2FyZCB3b3VsZCBqdWRnZSB0aGlzIHNwZWxsJ3NcbiAqIGRvY3VtZW50ZWQgZmxhZ3MgYWdhaW5zdCBhIGZpbGUgdGhhdCByZWNvZ25pc2VzIG5vbmUuXG4gKlxuICog4pqgIFVOTElLRSBUSEUgREFFTU9OLCBUSEUgU09VUkNFIEtFRVBTIE5PIFNFQ09ORCBFTlRSWSBBTkQgTkVFRFMgTk9ORSAoRDEyKTpcbiAqIGBTQ1JJUFRfRElSYCdzIGNvbnN1bWVycyBoZXJlIGFyZSBhbGwgYW5jZXN0b3ItcmVsYXRpdmUgYW5kIGNvcnJlY3QgZnJvbSBlaXRoZXJcbiAqIGFkZHJlc3MsIGJ1dCB0aGUgc291cmNlIGhhcyBubyBgaW1wb3J0Lm1ldGEubWFpbmAgYmxvY2sgZWl0aGVyLCBzbyB0aGVyZSBpcyBvbmVcbiAqIGVudHJ5IGFuZCBpdCBpcyB0aGlzIG9uZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLiAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIFJlYWQgYSBmcmFtZSB3aG9zZSBpZCBpcyBBVCBPUiBCRUxPVyB0aGUgY3Vyc29yIHRoaXMgY29ubmVjdGlvbiBhc2tlZFxuICAgKiBmcm9tIGFzIFwidGhlIGxvZyByZXN0YXJ0ZWRcIiwgcmVzZXQgdGhlIGN1cnNvciB0byAwLCBhbmQgY2FsbFxuICAgKiBgb25FcG9jaENoYW5nZWAgKHdpdGggdGhlIGZyYW1lJ3MgZXBvY2gsIG9yIGBcInVua25vd25cImApLiBEZWZhdWx0IGZhbHNlLlxuICAgKlxuICAgKiDim5QgV0hZIElUIElTIEhPTkVTVDogdGhlIGtpdCdzIGV2ZW50IGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duXG4gICAqIGJ5IHJlcGxheWluZyBXSE9MRSAoYC4vZXZlbnRMb2cudHNgLCBwb2ludCAzKSwgYW5kIG90aGVyd2lzZSBzZW5kcyBvbmx5XG4gICAqIGlkcyBhYm92ZSB0aGUgY3Vyc29yLiBTbyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgZXhpc3RzIG9ubHlcbiAgICogd2hlbiB0aGUgZGFlbW9uIGp1ZGdlZCB0aGUgY3Vyc29yIGZvcmVpZ24g4oCUIGEgcmVzdGFydGVkIGRhZW1vbiwgd2hvc2UgaWRzXG4gICAqIGJlZ2FuIGFnYWluIGF0IDEuIFRoZSBlcG9jaCBjYXRjaGVzIHRoYXQgV0lUSElOIG9uZSBwcm9jZXNzOyB0aGlzIGNhdGNoZXNcbiAgICogaXQgQUNST1NTIHByb2Nlc3Nlcywgd2hlcmUgYSByZS1hcm1lZCB0YWlsIGNhcnJpZXMgYSBib29rbWFyayBmcm9tIGEgbG9nXG4gICAqIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cyBhbmQsIHdpdGhvdXQgaXQsIGtlcHQgdGhhdCBib29rbWFyayBmb3JldmVyOiBldmVyeVxuICAgKiByZS1hcm0gcmVwbGF5ZWQgdGhlIHdob2xlIG5ldyBsb2csIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wXG4gICAqIChmb3VuZCBieSB0aGUgdmVyaWZpZXIgb24gZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIGFmdGVyIGB0YWlsLmxvc3RgIOKGklxuICAgKiBgb3BlbiAtLXJlc3RvcmVgKS5cbiAgICpcbiAgICog4pqgIE9OTFkgRk9SIEEgREFFTU9OIE9OIFRIRSBLSVQnUyBFVkVOVCBMT0cuIEdyYXBldmluZSdzIGlkcyBhcmUgcmVjb3ZlcmVkXG4gICAqIGFjcm9zcyBhIHJlc3RhcnQgYW5kIGl0cyBgLS1sYXN0YCBxdWVyeSBvdmVycmlkZXMgYHNpbmNlYCwgc28gaXQgbGVhdmVzXG4gICAqIHRoaXMgb2ZmLiBBbmQgdGhlIGJsaW5kIHNwb3QgaXMgc3RhdGVkOiBhIGJvb2ttYXJrIHRoYXQgaGFwcGVucyB0byBiZSBhdFxuICAgKiBvciBiZWxvdyB0aGUgUkVTVEFSVEVEIGxvZydzIG93biBsZW5ndGggbG9va3MgdmFsaWQgdG8gdGhlIGRhZW1vbiwgd2hpY2hcbiAgICogdGhlbiBzZW5kcyBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdC4gVGhlIGNvbWUtYmFjayBwYXRoIHRoZXJlZm9yZSBkcm9wc1xuICAgKiB0aGUgYm9va21hcmsgYWx0b2dldGhlciAoYC4vdGFpbEhhbmRvZmYudHNgLCBEMiksIHNvIHRoaXMgaXMgdGhlIG5ldCwgbm90XG4gICAqIHRoZSBydWxlLlxuICAgKi9cbiAgcmVzdGFydE9uUmVwbGF5PzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiBgYWNjZXB0ZWRgIGlzIGBhY2NlcHRgJ3NcbiAgICogIHZlcmRpY3Qgb24gdGhpcyBmcmFtZSwgd2hpY2ggaXMgd2hhdCBsZXRzIGB0YWlsIC0tb25jZWAgZW5kIG9uIHRoZSBmaXJzdFxuICAgKiAgZnJhbWUgaXQgYWN0dWFsbHkgREVMSVZFUlMgKGAuL3RhaWxIYW5kb2ZmLnRzYCkuXG4gICAqXG4gICAqICDim5QgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04gYmVmb3JlIHRoZSBjbGllbnQgcmV0dXJucy4gSXRcbiAgICogIHVzZWQgdG8gcmV0dXJuIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3Agd2l0aCB0aGUgU1NFIHN0cmVhbSBzdGlsbCBvcGVuLFxuICAgKiAgd2hpY2gga2VwdCB0aGUgcHJvY2VzcyBhbGl2ZSDigJQgdW5zZWVuIGZvciBgY2xvc2VkYCwgYmVjYXVzZSB0aGUgc2VydmVyXG4gICAqICBlbmRzIHRoYXQgc3RyZWFtIGl0c2VsZiwgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrXG4gICAqICB3b3VsZCBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudC4gKEFkanVzdG1lbnQgMSBvZiB0aGVcbiAgICogIE1vbml0b3ItZXhwaXJ5IHNwaWtlOyBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLikgKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUsIGFjY2VwdGVkOiBib29sZWFuKSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIENhbGxlZCBvbmNlIGFzIHRoZSB0YWlsIGVuZHMsIHdpdGggdGhlIGZpbmFsIGN1cnNvciAodGhlIGJvb2ttYXJrIGEgcmUtYXJtXG4gICAqIHBhc3NlcyBhcyBgLS1zaW5jZWApIGFuZCB3aHkgaXQgZW5kZWQuIEEgUkVQT1JUIFNJTksgbGlrZSBgb25EaXNjb25uZWN0YCxcbiAgICogbm90IGEgYmVoYXZpb3VyYWwgaGF0Y2g6IGl0IGNoYW5nZXMgbm90aGluZyB0aGUgY2xpZW50IGRvZXMuIEl0IGV4aXN0c1xuICAgKiBmb3IgYC4vdGFpbEhhbmRvZmYudHNgLCB3aG9zZSBsYXN0IGxpbmUgbmFtZXMgdGhlIHJlLWFybSBhbmQgbXVzdCBjYXJyeVxuICAgKiB0aGUgY3Vyc29yIGV4YWN0bHkgYXMgdGhpcyBsb29wIGxlZnQgaXQsIGVwb2NoIHJlc2V0cyBpbmNsdWRlZC5cbiAgICovXG4gIG9uRW5kPzogKGVuZDogeyBjdXJzb3I6IG51bWJlcjsgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiIH0pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7XG4gIGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7XG4gIGNvbW1lbnRzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcbiAgbGV0IGVuZGluZzogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIiA9IFwic3RvcHBlZFwiO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHtcbiAgICAgICAgc2luY2U6IFN0cmluZyhjdXJzb3IpLFxuICAgICAgfTtcbiAgICAgIC8vIFdoYXQgdGhpcyBjb25uZWN0aW9uIGFza2VkIGZyb20sIGZvciBgcmVzdGFydE9uUmVwbGF5YC5cbiAgICAgIGNvbnN0IGFza2VkU2luY2UgPSBjdXJzb3I7XG4gICAgICBsZXQgcmVzdGFydE5vdGVkID0gZmFsc2U7XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGVwb2NoUmVzZXQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGVwb2NoUmVzZXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgICBvcHRzLm9uRW5kPy4oeyBjdXJzb3IsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2JhY2tsb2cvMjAyNi0wOS0yMi1zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0yMi1tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIGFsd2F5cyBnZXRzIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsXG4gKiAgICAgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzIGNvbm5lY3Rpb24gY2Fycmllcy5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzKSwgZWFjaCBuYW1pbmcgaG93IHRvIGNvbWUgYmFja1xuICogaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkIChgY291bnRzYCBsZXRzIGEgc3BlbGwgZXhjbHVkZSBhIHNlcnZlci1zZW50XG4gKiAgICAgIGdyb3VuZGluZyBmcmFtZSkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIgYW5kIGNvc3RzIDMlIG9mIHRoZSB3aW5kb3csIG9uZSBleHRyYVxuICogICAgICByZS1hcm0gYWJvdXQgZXZlcnkgMTQuNSBob3VycyBvZiBhY3Rpdml0eS4gVGhlIHNwaWtlIG1lYXN1cmVkIGEgMTIgc1xuICogICAgICB3aW5kb3cgdW5kZXIgYSAyMCBzIGNhcCBlbmRpbmcgY2xlYW5seTsgbm90aGluZyBoZXJlIGRlcGVuZHMgb24gYVxuICogICAgICBtYXJnaW4gdGhhdCB0aWdodC4gSWYgdGhlIGNhcCB3aW5zIGFueXdheSwgdGhlIGFnZW50IGdldHMgTW9uaXRvcidzXG4gKiAgICAgIGJhcmUgZXhwaXJ5IG5vdGljZSBhbmQgcmUtYXJtcyBzaWxlbnRseSBmcm9tIHRoZSBsYXN0IGlkIGl0IHNhdyDigJQgdGhlXG4gKiAgICAgIHJ1bGluZydzIGZhbGxiYWNrLCBzdGF0ZWQgaW4gZXZlcnkgc2tpbGwuXG4gKiAgICAgIOKaliBUaGUgd2luZG93IGlzIGluamVjdGFibGUgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gdGhyb3VnaFxuICogICAgICBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TYCAoYSBjb3VudCBvZiBtczsgYDBgIHR1cm5zIHRoZSB3aW5kb3cgb2ZmLFxuICogICAgICBmb3IgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsKS4gQW4gZW52IHZhciBhbmQgbm90IGEgZmxhZzogaXQgaXNcbiAqICAgICAgbm90IGFuIGFnZW50J3MgYWN0LCBzbyBpdCBzdGF5cyBvdXQgb2YgZWlnaHQgdmVyYnMnIHNjaGVtYXMuXG4gKlxuICog4pSA4pSAIFRIRSBWRVJJRklFUidTIERFRkVDVFMsIEZJWEVEIE9OIFRIRSBTQU1FIEJSQU5DSCAoMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIG5vLXN0YWtlIHZlcmlmaWVyIHJhbiBldmVyeSBzcGVsbCdzIHJlYWwgdGFpbCBhbmQgZm91bmQgZm91ciB3YXlzIHRoZVxuICogbG9vcCBicm9rZS4gRWFjaCBoYXMgYSBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYDsgRDEgYW5kIEQyIGFsc28gaGF2ZSBhXG4gKiByZWFsLWRhZW1vbiBjZWxsIGluIGBzcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90YWlsLWhhbmRvZmYuaW50ZWdyYXRpb24udGVzdC50c2AuXG4gKlxuICogRDEgwrcgQSBSRS1BUk0gQVQgQSBTRVNTSU9OIFRIQVQgQ0xPU0VEIElOIFRIRSBHQVAgRU5EUyBgdGFpbC5jbG9zZWRgLiBUaGVcbiAqICAgICAgdHJpZ2dlciBpcyBvcmRpbmFyeTogdGhlIGh1bWFuIHByZXNzZXMgQ2xvc2Ugd2hpbGUgdGhlIGFnZW50IGhhbmRsZXNcbiAqICAgICAgYHRhaWwud29rZWAuIFRoZSBzZXNzaW9uIHNwZWxscyBzdG9wcGVkIG9ubHkgd2hlbiBUSElTIHByb2Nlc3MgaGFkXG4gKiAgICAgIG9uY2UgcmVhY2hlZCB0aGUgc2Vzc2lvbiwgc28gdGhlIHJlLWFybSByZXRyaWVkIFwibm8gc2Vzc2lvbiB5ZXRcIiBvblxuICogICAgICBzdGRlcnIgZm9yZXZlciDigJQgYW5kIGl0cyBgLS1vbmNlYCBuZXZlciBleGl0ZWQuIFJ1bGU6IGEgdGFpbCBnaXZlblxuICogICAgICBgLS1zZXNzaW9uYCBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElORyBzZXNzaW9uLCBzbyBub3RcbiAqICAgICAgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQ7IHRoZSBzcGVsbCdzIGBvblVucmVzb2x2ZWRgIHNheXMgXCJzdG9wXCJcbiAqICAgICAgYW5kIHRoaXMgbW9kdWxlIHJlYWRzIEFOWSBzdG9wIGFzIGNsb3NlZC4gQSBiYXJlIGZpcnN0IGFybSBzdGlsbFxuICogICAgICB3YWl0cyBmb3IgYSBzZXNzaW9uIHRvIGFwcGVhci5cbiAqIEQyIMK3IEEgQk9PS01BUksgQ0FOTk9UIE9VVExJVkUgSVRTIExPRy4gQSByZXN0b3JlZCBkYWVtb24ncyBpZHMgYmVnaW4gYXQgMSxcbiAqICAgICAgYW5kIHRoZSBraXQncyBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93biBieSByZXBsYXlpbmcgd2hvbGU7XG4gKiAgICAgIHRoZSB0YWlsIGtlcHQgaXRzIGhpZ2hlciBjdXJzb3IsIHNvIGV2ZXJ5IHJlLWFybSByZXBsYXllZCB0aGUgbmV3IGxvZ1xuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVHdvIGhhbHZlczpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCAob24gYnkgZGVmYXVsdCBoZXJlLFxuICogICAgICAgICAgICBvZmYgZm9yIGdyYXBldmluZSwgd2hvc2UgaWRzIHN1cnZpdmUgYSByZXN0YXJ0KSByZWFkcyBhIGZyYW1lIGF0XG4gKiAgICAgICAgICAgIG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nIGFuZCByZXNldHM7XG4gKiAgICAgICAgKGIpIHRoZSBydWxlIOKAlCB0aGUgYHRhaWwuY2xvc2VkYC9gdGFpbC5sb3N0YCBoaW50IHNheXMgdG8gdGFpbCB0aGVcbiAqICAgICAgICAgICAgc2Vzc2lvbiBpZCBgb3BlbmAgcHJpbnRzIFdJVEggTk8gYC0tc2luY2VgLCBhbmQgc28gZG9lcyBldmVyeVxuICogICAgICAgICAgICBza2lsbC4gQm91bnR5J3MgcmVzdG9yZSBtaW50cyBhIG5ldyBpZCwgd2hpY2ggaXMgd2h5IHRoZSBsaW5lXG4gKiAgICAgICAgICAgIG5hbWVzIFwidGhlIGlkIGl0IHByaW50c1wiLCBub3QgdGhlIG9sZCBvbmUuXG4gKiAgICAgIE5vdCB0YWtlbjogY2FycnlpbmcgdGhlIGRhZW1vbidzIGVwb2NoIGluIHRoZSBib29rbWFya1xuICogICAgICAoYC0tc2luY2UgTiAtLWVwb2NoIEVgKSDigJQgZXhhY3QsIGJ1dCBhIG5ldyBmbGFnIG9uIGVpZ2h0IHZlcmJzIGFuZCBhblxuICogICAgICBlcG9jaCB0aGUgdGFpbCBzZWVzIG9ubHkgb25jZSBhIGZyYW1lIGFycml2ZXMuIChhKSdzIHN0YXRlZCBibGluZCBzcG90XG4gKiAgICAgIGlzIGEgc3RhbGUgYm9va21hcmsgYXQgb3IgYmVsb3cgdGhlIE5FVyBsb2cncyBsZW5ndGg7IChiKSBpcyB3aHkgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoIG5ldmVyIHByZXNlbnRzIG9uZS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBhcyBwcmludGVkXG4gKiBvcGVucyBubyBicm93c2VyIHRhYi5cbiAqXG4gKiDimqAgS05PV04gTElNSVQsIE5PVCBGSVhFRDogdGhlIHByaW50ZWQgYGNvbW1hbmRgIG5hbWVzIHRoZSBsYXVuY2hlciBieSBpdHNcbiAqICAgZnVsbCBwYXRoLCB3aGljaCBmb3IgYW4gaW5zdGFsbGVkIHBsdWdpbiBpbmNsdWRlcyBpdHMgVkVSU0lPTkVEIGNhY2hlXG4gKiAgIGRpcmVjdG9yeS4gQWNyb3NzIGEgcGx1Z2luIHVwZ3JhZGUgYSByZS1hcm0ga2VlcHMgcnVubmluZyB0aGUgb2xkIHZlcnNpb25cbiAqICAgdW50aWwgdGhlIGFnZW50IG5leHQgYXJtcyBmcm9tIHRoZSBza2lsbCdzIG93biBwYXRoLiBOb3RlZCwgbm90IHJlZGVzaWduZWQuXG4gKlxuICog4pqWIGAtLW9uY2VgIEVORFMgT04gVEhFIEZJUlNUIEZSQU1FLCB3aXRoIG5vIGRyYWluLiBBIGJ1cnN0IGFycml2ZXMgc3BsaXQ6IHRoZVxuICogICBmaXJzdCBldmVudCBvbiB0aGUgb25lLXNob3QsIHRoZSByZXN0IG9uIHRoZSBNb25pdG9yIHJlLWFybSwgd2hpY2ggbG9zZXNcbiAqICAgbm90aGluZyBiZWNhdXNlIG9mIHRoZSBib29rbWFyay4gVGhlIHNwaWtlIG9mZmVyZWQgYSB+MjAwIG1zIGRyYWluIGFzIGFuXG4gKiAgIG9wdGlvbiwgbm90IGEgcmVxdWlyZW1lbnQ7IG5vdCB0YWtlbiwgYmVjYXVzZSBpdCBhZGRzIGEgdGltZXIgdG8gdGhlXG4gKiAgIGV4aXQgcGF0aCB3aG9zZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byBtYWtlIGltcG9zc2libGUuXG4gKiDimpYgVEhFIExJTkUnUyBgY29tbWFuZGAgSVMgUlVOTkFCTEUgQVMgUFJJTlRFRDogYGJ1biA8dGhpcyBjbGkncyBwYXRoPiDigKZgLFxuICogICBwaW5uZWQgdG8gdGhlIHNlc3Npb24gdGhpcyB0YWlsIHdhcyBib3VuZCB0bywgd2l0aCBpdHMgc2NvcGUgZmxhZ3MuIFRoZVxuICogICBza2lsbHMgbmFtZSB0aGUgcnVsZSBvbmNlOyB0aGUgbGluZSBjYXJyaWVzIHRoZSBzcGVjaWZpY3MuXG4gKi9cbmltcG9ydCB7IHR5cGUgU3NlRnJhbWUsIHR5cGUgVGFpbE9wdGlvbnMsIHRhaWxFdmVudHMgfSBmcm9tIFwiLi90YWlsRXZlbnRzXCI7XG5cbi8qKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3IgY2FwLCBwZXIgdGhlIHRvb2wncyBzY2hlbWEgKFwiRGVhZGxpbmVzIGFib3ZlXG4gKiAgMTgwMDAwMG1zIGFyZSBjYXBwZWQgdG8gMTgwMDAwMG1zXCIpLiBBIGhhcm5lc3MgbnVtYmVyOiBpZiBpdCBjaGFuZ2VzLCB0aGlzXG4gKiAgY2hhbmdlcywgYW5kIHNvIGRvZXMgdGhlIHNraWxscycgYHRpbWVvdXRfbXNgLiAqL1xuZXhwb3J0IGNvbnN0IE1PTklUT1JfQ0FQX01TID0gMV84MDBfMDAwO1xuLyoqIFNlZSBBNCBpbiB0aGUgaGVhZGVyIGZvciB3aHkgYSBtaW51dGUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX01BUkdJTl9NUyA9IDYwXzAwMDtcbmV4cG9ydCBjb25zdCBERUZBVUxUX1dJTkRPV19NUyA9IE1PTklUT1JfQ0FQX01TIC0gV0lORE9XX01BUkdJTl9NUztcbi8qKiBUaGUgaW5qZWN0aW9uIHBvaW50IGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIChzZWUgQTQpLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19FTlYgPSBcIlNQRUxMQk9PS19UQUlMX1dJTkRPV19NU1wiO1xuLyoqIFRoZSBvbmUgc2VudGVuY2UgZXZlcnkgYHRhaWxgJ3MgaGVscCBjYXJyaWVzLCBzbyBhIGh1bWFuIHdhdGNoaW5nIGluIGFcbiAqICB0ZXJtaW5hbCBmaW5kcyB0aGUgZXNjYXBlIGhhdGNoIHdoZXJlIHRoZXkgbG9vayAoRDQpLiBXb3JkZWQgb25jZSBoZXJlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19IRUxQID1cbiAgXCJlbmRzIGl0c2VsZiBiZWZvcmUgTW9uaXRvcidzIDMwLW1pbnV0ZSBjYXAgd2l0aCBhIGxpbmUgbmFtaW5nIHRoZSBuZXh0IGFjdDsgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsIGtlZXBzIGl0IG9wZW4gd2l0aCBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MFwiO1xuXG4vKiogQ29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdyB0aGF0IG1ha2UgdGhlIGRhZW1vbiBcImxvc3RcIiAoc2VlIEEyKS4gVGhyZWVcbiAqICBzcGFuIGFib3V0IDAuNzUgcyB1bmRlciB0aGUga2l0J3MgZGVmYXVsdCBiYWNrb2ZmICgyNTAgKyA1MDAgbXMgYmV0d2VlblxuICogIHRoZW0pOiBhIGxpdmUgZGFlbW9uIG5ldmVyIHJlZnVzZXMgaXRzIG93biBwb3J0LCBhbmQgdGhlIHR3byBleHRyYSBhdHRlbXB0c1xuICogIG9ubHkgYnV5IHRvbGVyYW5jZSBmb3IgYSByZXN0YXJ0IHRoYXQgcmViaW5kcyB0aGUgc2FtZSBwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IExPU1RfQUZURVJfUkVGVVNBTFMgPSAzO1xuXG4vKiogVGhlIHdpbmRvdyBsZW5ndGg6IHRoZSBlbnYgdmFsdWUgd2hlbiBpdCBpcyBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyLCBlbHNlIHRoZVxuICogIGRlZmF1bHQuIGAwYCBtZWFucyBubyB3aW5kb3cuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVdpbmRvd01zKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdy50cmltKCkgPT09IFwiXCIpIHJldHVybiBERUZBVUxUX1dJTkRPV19NUztcbiAgY29uc3QgbiA9IE51bWJlcihyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzSW50ZWdlcihuKSAmJiBuID49IDAgPyBuIDogREVGQVVMVF9XSU5ET1dfTVM7XG59XG5cbmV4cG9ydCB0eXBlIFRhaWxNb2RlID0gXCJ3YXRjaFwiIHwgXCJvbmNlXCI7XG5cbi8qKiBIb3cgYSB0YWlsIGVuZGVkLiBgd2luZG93YCBpcyBvdXIgb3duIGRlYWRsaW5lLCBgZXZlbnRgIGlzIGEgYC0tb25jZWAnc1xuICogIGZpcnN0IGZyYW1lLCBgY2xvc2VkYCBpcyB0aGUgc2Vzc2lvbiBlbmRpbmcgKGEgYGNsb3NlZGAgZnJhbWUgb3IgdGhlIHBpbm5lZFxuICogIHNlc3Npb24ncyBwb2ludGVyIHZhbmlzaGluZyksIGBsb3N0YCBpcyB0aGUgZGFlbW9uIHJlZnVzaW5nIGNvbm5lY3Rpb25zLFxuICogIGFuZCBgc3RvcHBlZGAgaXMgYSBzaWduYWwsIGEgY2FsbGVyJ3MgYWJvcnQgb3IgYSBjbG9zZWQgc3Rkb3V0LiAqL1xuZXhwb3J0IHR5cGUgVGFpbEVuZCA9IFwid2luZG93XCIgfCBcImV2ZW50XCIgfCBcImNsb3NlZFwiIHwgXCJsb3N0XCIgfCBcInN0b3BwZWRcIjtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZklucHV0ID0ge1xuICBlbmQ6IFRhaWxFbmQ7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gKi9cbiAgdGFpbDogKG86IHsgc2luY2U6IG51bWJlcjsgb25jZTogYm9vbGVhbiB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICBldmVudHM6IG51bWJlcjtcbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBgbW9uaXRvcmA6IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggYGNvbW1hbmRgLlxuICAgKiAgYGJhY2tncm91bmRgOiBydW4gYGNvbW1hbmRgIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2suXG4gICAqICBgc3RvcGA6IG5vdGhpbmcgdG8gd2F0Y2g7IGBjb21tYW5kYCBpcyBob3cgdG8gY29tZSBiYWNrLCBpZiB3YW50ZWQuICovXG4gIG5leHQ6IFwibW9uaXRvclwiIHwgXCJiYWNrZ3JvdW5kXCIgfCBcInN0b3BcIjtcbiAgY29tbWFuZDogc3RyaW5nO1xuICBoaW50OiBzdHJpbmc7XG59O1xuXG4vKiogVGhlIGNvbWUtYmFjayBoaW50LCB3aXRoIGhvdyB0byBSRVNVTUUgYWZ0ZXIgY29taW5nIGJhY2sgKEQyKTogYSByZXN0b3JlZFxuICogIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIG1lYW5zIG5vdGhpbmcgdGhlcmUuICovXG5jb25zdCBDT01FX0JBQ0sgPSAod2h5OiBzdHJpbmcpID0+XG4gIGAke3doeX0gVG8gYnJpbmcgaXQgYmFjaywgcnVuIGNvbW1hbmQ7IHRoZW4gdGFpbCB0aGUgc2Vzc2lvbiBpZCBpdCBwcmludHMsIHdpdGggbm8gLS1zaW5jZSAoYSByZXN0b3JlZCBzZXNzaW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBldmVudHM6IHMuZXZlbnRzLCBjdXJzb3I6IHMuY3Vyc29yIH07XG4gIHN3aXRjaCAocy5lbmQpIHtcbiAgICBjYXNlIFwic3RvcHBlZFwiOlxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgY2FzZSBcImNsb3NlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmNsb3NlZFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSB9KSxcbiAgICAgICAgaGludDogXCJoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggY29tbWFuZFwiLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IGZhbHNlIH0pLFxuICAgICAgICAgIGhpbnQ6IFwidGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCBjb21tYW5kXCIsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlIH0pLFxuICAgICAgICBoaW50OiBcIm5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuIGNvbW1hbmQgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpIOKAlCBpdCBleGl0cyBvbiB0aGUgbmV4dCBldmVudFwiLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2hlbGxRdW90ZShhcmc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltBLVphLXowLTlfQCUrPTosLi8tXSskLy50ZXN0KGFyZykgPyBhcmcgOiBgJyR7YXJnLnJlcGxhY2VBbGwoXCInXCIsIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogSG93IFRISVMgcHJvY2VzcyB3YXMgaW52b2tlZCwgYXMgdGhlIGhlYWQgb2YgYSBjb21tYW5kIHRoYXQgcnVucyBpdCBhZ2FpbjpcbiAqICBgYnVuIDx0aGUgbGF1bmNoZXIncyBmdWxsIHBhdGg+YC4gQnVuIGhhbmRzIGBhcmd2WzFdYCBvdmVyIGFzIGEgZnVsbCBwYXRoLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlbGZDb21tYW5kKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcImJ1blwiLCBwcm9jZXNzLmFyZ3ZbMV0gPz8gXCJjbGkudHNcIl07XG59XG5cbi8qKiBUaGUgcmUtYXJtIGZvciBhIHNwZWxsIHdob3NlIHRhaWwgaXMgYDxwcmVmaXjigKY+IC0tc2luY2UgTiBbLS1vbmNlXWAuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQocHJlZml4OiByZWFkb25seSBzdHJpbmdbXSwgc2luY2U6IG51bWJlciwgb25jZTogYm9vbGVhbik6IHN0cmluZyB7XG4gIC8vIOKaoCBBIG5lZ2F0aXZlIGJvb2ttYXJrIChub3RoaW5nIHNlZW4geWV0KSBpcyBzcGVsbGVkIGAtLXNpbmNlPS0xYDogdGhlXG4gIC8vIHBhcnNlcnMgcmVhZCBhIGJhcmUgYC0xYCBhZnRlciBhIGZsYWcgYXMgYW5vdGhlciBmbGFnIGFuZCByZWZ1c2UgaXQuXG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7c2luY2V9YF0gOiBbXCItLXNpbmNlXCIsIFN0cmluZyhzaW5jZSldO1xuICByZXR1cm4gY29tbWFuZExpbmUoWy4uLnByZWZpeCwgLi4uYXQsIC4uLihvbmNlID8gW1wiLS1vbmNlXCJdIDogW10pXSk7XG59XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZPcHRpb25zPEV2PiA9IHtcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBkYWVtb24gcnVucyB0aGUga2l0J3MgZXZlbnQgbG9nLCBzbyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZFxuICAgKiAgY3Vyc29yIG1lYW5zIGl0cyBsb2cgcmVzdGFydGVkIChgdGFpbEV2ZW50c2AnIGByZXN0YXJ0T25SZXBsYXlgLCBEMikuXG4gICAqICBEZWZhdWx0IHRydWU7IGdyYXBldmluZSdzIGR1cmFibGUgbG9nIHR1cm5zIGl0IG9mZi4gKi9cbiAgZXZlbnRMb2c/OiBib29sZWFuO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBmcmFtZUhhc0lkID0gZmFsc2U7XG4gIC8qKiBBMyArIEQzOiBhIGZyYW1lIGNvdW50cywgYW5kIHdha2VzIGEgYC0tb25jZWAsIG9ubHkgd2hlbiBpdCBpcyBPTiBUSEVcbiAgICogIExPRyDigJQgaXQgY2FycmllcyBhIGxvZyBpZCDigJQgYW5kIHRoZSBzcGVsbCdzIG93biBgY291bnRzYCBhZ3JlZXMuIEEgdGFiJ3NcbiAgICogIGlkLWxlc3MgYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGAgcGluZyBpcyBub3Qgb24gdGhlIGxvZy4gKi9cbiAgY29uc3QgaXNMb2dGcmFtZSA9IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gZnJhbWVIYXNJZCAmJiBjb3VudHMoZXYsIGZyYW1lKTtcbiAgbGV0IGVuZDogVGFpbEVuZCB8IG51bGwgPSBudWxsO1xuICBsZXQgcmVmdXNhbHMgPSAwO1xuXG4gIGNvbnN0IGZpbmlzaCA9IChlOiBUYWlsRW5kKSA9PiB7XG4gICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gZTtcbiAgICBhYy5hYm9ydCgpO1xuICB9O1xuICBjb25zdCB0aW1lciA9XG4gICAgaC5tb2RlID09PSBcIndhdGNoXCIgJiYgd2luZG93TXMgPiAwID8gc2V0VGltZW91dCgoKSA9PiBmaW5pc2goXCJ3aW5kb3dcIiksIHdpbmRvd01zKSA6IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gYXdhaXQgdGFpbEV2ZW50czxFdj4oe1xuICAgICAgLi4udGFpbCxcbiAgICAgIHNpZ25hbDogYWMuc2lnbmFsLFxuICAgICAgcmVzdGFydE9uUmVwbGF5OiBoLmV2ZW50TG9nID8/IHRydWUsXG4gICAgICAvLyBEMzogcmVtZW1iZXIgd2hldGhlciBUSElTIGZyYW1lIGNhcnJpZXMgYSBsb2cgaWQuIGB0YWlsRXZlbnRzYCByZWFkc1xuICAgICAgLy8gdGhlIGN1cnNvciBvbmNlIHBlciBmcmFtZSwgYmVmb3JlIGBhY2NlcHRgLCBgdGVybWluYWxgIGFuZCBgcmVuZGVyYC5cbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgY29uc3QgbiA9IHRhaWwuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgIGZyYW1lSGFzSWQgPSB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobik7XG4gICAgICAgIHJldHVybiBuO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBEMTogYSB0YWlsIHRoYXQgZ2l2ZXMgdXAgb24gZmluZGluZyBpdHMgc2Vzc2lvbiBpcyB3YXRjaGluZyBhXG4gICAgICAgIC8vIHNlc3Npb24gdGhhdCBpcyBnb25lIOKAlCB3aGV0aGVyIHRoaXMgcHJvY2VzcyBldmVyIHJlYWNoZWQgaXQgKGl0c1xuICAgICAgICAvLyBwb2ludGVyIHZhbmlzaGVkKSBvciBpdCB3YXMgcmUtYXJtZWQgYXQgb25lIHRoYXQgY2xvc2VkIGluIHRoZSBnYXAuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBlbmQgPT09IG51bGwpIGVuZCA9IFwiY2xvc2VkXCI7XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaC5tb2RlID09PSBcIm9uY2VcIiAmJiBhY2NlcHRlZCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIG9uQ29tbWVudDogKHRleHQpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICByZXR1cm4gdGFpbC5vbkNvbW1lbnQ/Lih0ZXh0KSA/PyBudWxsO1xuICAgICAgfSxcbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwub25EaXNjb25uZWN0Py4oaW5mbykgPz8gbnVsbDtcbiAgICAgICAgaWYgKGluZm8uY2F1c2UgPT09IFwiY29ubmVjdC1mYWlsZWRcIikge1xuICAgICAgICAgIHJlZnVzYWxzICs9IDE7XG4gICAgICAgICAgaWYgKGVuZE9uTG9zdCAmJiByZWZ1c2FscyA+PSBMT1NUX0FGVEVSX1JFRlVTQUxTKSBmaW5pc2goXCJsb3N0XCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRoZSBkYWVtb24gYW5zd2VyZWQgKGEgc3RhdHVzLCBvciBhIHN0cmVhbSB0aGF0IG9wZW5lZCBhbmQgdGhlblxuICAgICAgICAgIC8vIGVuZGVkKTogaXQgaXMgYWxpdmUsIHNvIHRoZSByZWZ1c2FscyB3ZXJlIG5vdCBpbiBhIHJvdy5cbiAgICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgb25FbmQ6IChzKSA9PiB7XG4gICAgICAgIGN1cnNvciA9IHMuY3Vyc29yO1xuICAgICAgICB0YWlsLm9uRW5kPy4ocyk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGxpbmUgPSBoYW5kb2ZmKFxuICAgICAge1xuICAgICAgICBlbmQ6IGVuZCA/PyBcInN0b3BwZWRcIixcbiAgICAgICAgbW9kZTogaC5tb2RlLFxuICAgICAgICBldmVudHMsXG4gICAgICAgIGN1cnNvcixcbiAgICAgICAgcHJlc2VuY2U6IGgucHJlc2VuY2UsXG4gICAgICB9LFxuICAgICAgaC5jb21tYW5kcyxcbiAgICApO1xuICAgIGlmIChsaW5lICE9PSBudWxsKSBvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkobGluZSl9XFxuYCk7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHRhaWwuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEdsYW1vdXIncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aCBoYWx2ZXNcbiAqIG9mIHRoZSBzcGVsbC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLiBCZWZvcmUgUGhhc2UgMiB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDE1MDAwYFxuICogaW5zaWRlIGBzZXJ2ZXIudHNgJ3MgYHNzZVJlc3BvbnNlYCwgYW5kIGBjbGkudHNgIGhhZCBOTyBjb3JyZXNwb25kaW5nIG51bWJlclxuICogYXQgYWxsIOKAlCBpdHMgdGFpbCBsb29wIHNpbXBseSBibG9ja2VkIG9uIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGVcbiAqIGZhaWx1cmUgYHRhaWxFdmVudHNgJ3Mgd2F0Y2hkb2cgZXhpc3RzIHRvIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGVcbiAqIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50b1xuICogYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2hcbiAqIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR0xBTU9VUidTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyBQaGFzZSAxYSdzIHJ1bGUgYW5kIGl0IGlzIHRoZSB3aG9sZSByZWFzb24gdGhlIGZpbGVcbiAqIGV4aXN0cyByYXRoZXIgdGhhbiBhIHNoYXJlZCBjb25zdGFudCBzb21ld2hlcmU6IGFzdHJvbGFiZSBiZWF0cyBhdCAxMCBzIGFuZFxuICogbWFncGllIGF0IDE1IHMsIHNvIGEgaGFyZC1jb2RlZCB3YXRjaGRvZyBpcyBjb3JyZWN0IGZvciBhdCBtb3N0IG9uZSBvZiB0aGVtLlxuICogQXN0cm9sYWJlIG1lYXN1cmVkIHdoYXQgYSBjb3BpZWQgbnVtYmVyIGRvZXMg4oCUIGEgNDUgcyB3YXRjaGRvZyBhZ2FpbnN0IGFuXG4gKiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhbiB1bnJlbGF0ZWQgdGhpcmRcbiAqIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tXG4gKiB0aGUgYmVhdCBpdCBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bS4gVGhpcyBpcyBnbGFtb3VyJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkIG9uZTpcbiAqIGBzZXJ2ZXIudHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IEJ1bidzXG4gKiBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIDE1IHMga2VlcGFsaXZlIGV2ZXJcbiAqIGZpcmVzLiBHbGFtb3VyIGRvZXMgbm90IGVudi10dW5lIGl0IOKAlCBhIHNlc3Npb24gZGFlbW9uJ3MgY29ubmVjdGlvbiBsaWZldGltZVxuICogaXMgbm90IHNvbWV0aGluZyBhIGNhbGxlciBoYXMgZXZlciBuZWVkZWQgdG8gc2hvcnRlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LCBhbmQgZ2xhbW91cidzIG93biBsaXRlcmFsIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC5cbiAqXG4gKiDimqAgNDUsMDAwIG1zIHRvZGF5LCB3aGljaCBpcyB0aGUgc2FtZSBudW1iZXIgYGNtZE9wZW5gJ3MgYC0tc3RhcnQtdGltZW91dGBcbiAqIGRlZmF1bHQgaGFwcGVucyB0byBiZS4gVGhleSBhcmUgVU5SRUxBVEVEIOKAlCBvbmUgYm91bmRzIGEgZmlyc3QgYnVuZGxlIGJ1aWxkLFxuICogdGhlIG90aGVyIGJvdW5kcyBhIHNpbGVudCBzb2NrZXQg4oCUIGFuZCB0aGUgY29pbmNpZGVuY2UgaXMgbmFtZWQgaGVyZSBzbyBub2JvZHlcbiAqIGxhdGVyIFwiZGUtZHVwbGljYXRlc1wiIHRoZW0gaW50byBvbmUgY29uc3RhbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvLyBCcm93c2VyLXNhZmUgaW1hZ2Utb3B0aW1pemF0aW9uIFBPTElDWSAoc2hhcmVkIGJ5IHRoZSBicm93c2VyIGRyb3AgcGF0aCBhbmRcbi8vIHRoZSBzZXJ2ZXIgcGF0aCkuIE5vIG5hdGl2ZSBkZXBzIOKAlCBzYWZlIHRvIGltcG9ydCBpbnRvIHRoZSBSZWFjdCBidW5kbGUuXG4vLyBUaGUgQnVuLkltYWdlIGltcGxlbWVudGF0aW9uIGxpdmVzIGluIGltYWdlT3B0aW1pemUuc2VydmVyLnRzLlxuZXhwb3J0IGNvbnN0IE9QVElNSVpFID0geyBtYXhEaW06IDEyMDAsIHF1YWxpdHk6IDAuODUgfSBhcyBjb25zdDtcbiIsCiAgICAiLy8gU2VydmVyL0NMSS1vbmx5OiBuYXRpdmUgQnVuLkltYWdlIGRvd25zY2FsZSArIHdlYnAuIERvIE5PVCBpbXBvcnQgZnJvbSBicm93c2VyXG4vLyBjb2RlICh0aGUgYnJvd3NlciBkcm9wIHBhdGggdXNlcyA8Y2FudmFzPikuIFJlcXVpcmVzIEJ1biA+PSAxLjMuMTQuXG5pbXBvcnQgeyBPUFRJTUlaRSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvaW1hZ2VPcHRpbWl6ZVwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVJbWFnZUJ1ZmZlcihcbiAgaW5wdXQ6IFVpbnQ4QXJyYXksXG4pOiBQcm9taXNlPHsgZGF0YTogVWludDhBcnJheTsgbWltZTogXCJpbWFnZS93ZWJwXCIgfT4ge1xuICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IEJ1bi5JbWFnZShpbnB1dClcbiAgICAucmVzaXplKE9QVElNSVpFLm1heERpbSwgT1BUSU1JWkUubWF4RGltLCB7XG4gICAgICBmaXQ6IFwiaW5zaWRlXCIsXG4gICAgICB3aXRob3V0RW5sYXJnZW1lbnQ6IHRydWUsXG4gICAgfSlcbiAgICAud2VicCh7IHF1YWxpdHk6IE1hdGgucm91bmQoT1BUSU1JWkUucXVhbGl0eSAqIDEwMCkgfSlcbiAgICAuYnl0ZXMoKTtcbiAgcmV0dXJuIHsgZGF0YTogbmV3IFVpbnQ4QXJyYXkoZGF0YSksIG1pbWU6IFwiaW1hZ2Uvd2VicFwiIH07XG59XG5cbi8vIERlY29kZSBhIGJhc2U2NCBkYXRhLVVSTCwgb3B0aW1pemUgdGhlIHJhc3RlciwgcmUtZW5jb2RlIGFzIGEgd2VicCBkYXRhLVVSTC5cbi8vIFVzZWQgYnkgdGhlIENMSSBgZ2VuYCB2ZXJiICh0aGUgYWdlbnQgcG9zdHMgYSBtZWRpYS1mb3JnZSBpbWFnZSB3aXRoIG5vXG4vLyBicm93c2VyIDxjYW52YXM+IGF2YWlsYWJsZSkuIFRocm93cyBvbiBhIG5vbi1iYXNlNjQtZGF0YS1VUkwgaW5wdXQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVJbWFnZURhdGFVcmwoZGF0YVVybDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgLy8gVGhlIGJvZHkgZ3JvdXAgaXMgbWFuZGF0b3J5LCBzbyBhIG1hdGNoIGFsd2F5cyBzZXRzIGl0OiBgYm9keWAgaXNcbiAgLy8gdW5kZWZpbmVkIGV4YWN0bHkgd2hlbiB0aGlzIGlzIG5vdCBhIGJhc2U2NCBkYXRhLVVSTCwgYW5kIGJvdGggdGFrZSB0aGVcbiAgLy8gZnVuY3Rpb24ncyBvbmUgcmVmdXNhbC5cbiAgY29uc3QgYm9keSA9IC9eZGF0YTooW147LF0rKTtiYXNlNjQsKC4qKSQvcy5leGVjKGRhdGFVcmwpPy5bMl07XG4gIGlmIChib2R5ID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcihcIm9wdGltaXplSW1hZ2VEYXRhVXJsOiBleHBlY3RlZCBhIGJhc2U2NCBkYXRhLVVSTFwiKTtcbiAgY29uc3QgYnl0ZXMgPSBVaW50OEFycmF5LmZyb20oYXRvYihib2R5KSwgKGMpID0+IGMuY2hhckNvZGVBdCgwKSk7XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgb3B0aW1pemVJbWFnZUJ1ZmZlcihieXRlcyk7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGNvbnN0IGIgb2YgZGF0YSkgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYik7XG4gIHJldHVybiBgZGF0YTppbWFnZS93ZWJwO2Jhc2U2NCwke2J0b2EoYmluKX1gO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQStCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLHNCQUFTOzs7QUNrQkYsSUFBTSxXQUFvQztBQUFBLEVBQy9DLE9BQU87QUFBQSxFQUNQLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLFVB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O0FBQUEsRUFDckIsa0JBQWlCLFFBQVE7QUFBQSxFQUN6QixrQkFBa0IsZUFBYztBQUFBLEVBRWhDLElBQUksU0FBUyxXQUFXO0FBQUEsSUFHdEIsTUFBTSxJQUFJLFdBQVcsaUJBQWlCLEVBQUUsTUFBTSxvQkFBb0IsU0FBUyxDQUFDLEdBQUcsS0FBSyxFQUFFLENBQUM7QUFBQSxFQUN6RjtBQUFBLEVBQ0EsTUFBTSxPQUFPLFlBQVksSUFBSTtBQUFBLEVBQzdCLElBQUksU0FBUyxXQUFXO0FBQUEsSUFDdEIsTUFBTSxJQUFJLFdBQVcsaUJBQWlCLFNBQVM7QUFBQSxNQUM3QyxNQUFNO0FBQUEsTUFDTixTQUFTLENBQUMsR0FBRyxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQU1BLE1BQU0sVUFBVSxJQUFJLElBQVksS0FBSyxLQUFLO0FBQUEsRUFDMUMsTUFBTSxRQUFRLE9BQU8sS0FBSyxLQUFLLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDNUQsSUFBSSxVQUFVLFdBQVc7QUFBQSxJQUN2QixNQUFNLFdBQVcsU0FBUyxLQUFLLElBQUk7QUFBQSxJQUNuQyxNQUFNLElBQUksV0FDUixLQUFLLDhCQUE4QixLQUFLLGtFQUN4QyxTQUFTLFNBQVMsSUFBSSxFQUFFLFNBQVMsU0FBUyxJQUFJLEVBQUUsTUFBTSxHQUFHLEtBQUssc0JBQXNCLENBQ3RGO0FBQUEsRUFDRjtBQUFBLEVBTUEsTUFBTSxXQUFXLEtBQUssWUFBWSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLEVBQzVELE1BQU0sV0FBVyxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsRUFDeEQsSUFBSSxJQUFJLFNBQVMsWUFBYSxDQUFDLFlBQVksSUFBSSxTQUFTLEtBQUssWUFBWSxRQUFTO0FBQUEsSUFDaEYsTUFBTSxJQUFJLFdBQVcsVUFBVSxRQUFRLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxFQUN6RTtBQUFBLEVBRUEsTUFBTSxVQUFVLE9BQU8sTUFBTSxZQUFZLFdBQVcsTUFBTSxVQUFVO0FBQUEsRUFHcEUsTUFBTSxPQUFPLE1BQU0sS0FBSyxJQUFJLEtBQUssT0FBTyxPQUFPO0FBQUEsRUFDL0MsT0FBTyxPQUFPLFNBQVMsV0FBVyxPQUFPO0FBQUE7QUErQjNDLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkY1RjgzNzYyMThENjk3RDI2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
