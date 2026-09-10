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
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m)
    throw new Error("optimizeImageDataUrl: expected a base64 data-URL");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
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
  const cmd = { type: "section", key: pos[0] };
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
    id: pos[0],
    cost: typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN
  };
}
function buildGenMetaCmd(pos, flags) {
  const cmd = {
    type: "gen.meta",
    id: pos[0]
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
    id: pos[0],
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
  child.stdout.unref();
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
async function cmdTail(session, sinceArg) {
  let boundId = session;
  let grounded = false;
  return await tailEvents({
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
    since: sinceArg,
    cursorOf: (ev) => ev.id,
    terminal: (ev) => ev.type === "closed",
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": glamour-keepalive"
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
    flags: [...SESSION, "since"],
    positionals: P.none,
    describe: "SSE user events \u2192 JSONL (wrap with Monitor; waits for a session, never exits 5)",
    run: (_pos, flags, session) => cmdTail(session, typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1)
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

//# debugId=2CB73E9579F2B81A64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9jbGkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9nbGFtb3VyL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uL3NoYXJlZC9pbWFnZU9wdGltaXplLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9nbGFtb3VyL2JhY2tlbmQvaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGdsYW1vdXIgQ0xJIOKAlCB0aGluIHdyYXBwZXIgYXJvdW5kIHRoZSBwZXItc2Vzc2lvbiBkYWVtb24ncyBIVFRQIHN1cmZhY2Vcbi8vIChzZXJ2ZXIudHMpLiBUaGUgYWdlbnQgZHJpdmVzIGEgZ2xhbW91ciBzZXNzaW9uIHRocm91Z2ggdGhlc2UgdmVyYnM7XG4vLyBgdGFpbGAgc3RyZWFtcyB1c2VyIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwLlxuLy9cbi8vIExpZmVjeWNsZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLW5vLW9wZW5dICAgIyBzcGF3biBhIHNlc3Npb25cbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgU1NFIGV2ZW50cyDihpIgSlNPTkwgKE1vbml0b3IgdGhpcylcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgbGVhbiBzdGF0ZSBzbmFwc2hvdFxuLy9cbi8vIEFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpOlxuLy8gICBidW4gY2xpLnRzIGludGVudCA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyBhbm5vdGF0ZSA8aWQ+IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIHNheSA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZlxuLy8gICBidW4gY2xpLnRzIGNsb3NlXG4vLyAgIGJ1biBjbGkudHMgaW5mbyB8IGhlbHAgfCAtLXZlcnNpb25cbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD5cbi8vIHRvIHRhcmdldCBhIHNwZWNpZmljIG9uZS5cbi8vXG4vLyBFUlJPUiBDT05UUkFDVCAoYWNjIEwwIOKAlCB0aGUgaG91c2UgdGF4b25vbXkgbWFncGllIHNldCBhbmQgbWluZC1tYXBwZXJcbi8vIGFkb3B0ZWQpOiBldmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciB3aXRoIHN0ZG91dCBlbXB0eSDigJRcbi8vICAge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vICAgIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbi8vICAgdXNhZ2Ug4oaSIGV4aXQgMiDCtyBpbnRlcm5hbCDihpIgMSDCtyBub3RfZm91bmQg4oaSIDUgwrcgY29uZmxpY3Qg4oaSIDZcbi8vIEEgZGFlbW9uIHJlZnVzYWwgbWFwcyBvZmYgaXRzIEhUVFAgc3RhdHVzICg0MDAgdXNhZ2UsIDQwNCBub3RfZm91bmQsXG4vLyA0MDkgY29uZmxpY3QsIGVsc2UgaW50ZXJuYWwpIGFuZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gYm9keSBWRVJCQVRJTVxuLy8gdW5kZXIgZXJyb3Iuc2VydmVyLiBCcmFuY2ggb24gYGtpbmRgLCBuZXZlciBvbiBgbWVzc2FnZWAgcHJvc2UuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQge1xuICBDbGlFcnJvcixcbiAgZGllLFxuICB0eXBlIEVycktpbmQsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9yc1wiO1xuaW1wb3J0IHsgdGFpbEV2ZW50cyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsRXZlbnRzXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IG9wdGltaXplSW1hZ2VEYXRhVXJsIH0gZnJvbSBcIi4vaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXJcIjtcblxuLy8g4puUIEVWRVJZIFBBVEggSEVSRSBJUyBSRVNPTFZFRCBGUk9NIFRIRSBFTUlUVEVEIExPQ0FUSU9OLCBgZGlzdC9gLCBOT1QgRlJPTVxuLy8gVEhJUyBTT1VSQ0UgRklMRS4gVGhpcyBtb2R1bGUgaXMgYnVuZGxlZCB0b1xuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL2Rpc3QvY2xpLmpzYCBhbmQgdGhlIGxhdW5jaGVyIGF0XG4vLyBgLi4vc2NyaXB0cy9jbGkudHNgIGltcG9ydHMgaXQsIHNvIGBpbXBvcnQubWV0YS51cmxgIG5hbWVzIHRoZSBCVU5ETEUuIGBkaXN0L2Bcbi8vIGhhcHBlbnMgdG8gc2l0IGF0IHRoZSBzYW1lIGRlcHRoIGFzIHRoZSBgc2NyaXB0cy9gIHRoaXMgZmlsZSB1c2VkIHRvIGxpdmUgaW4sXG4vLyBzbyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAgYW5kIGBTVVJGQUNFX0NXRGAgYXJlIHVuY2hhbmdlZCDigJQgYnV0IHRoYXQgaXMgYVxuLy8gQ09JTkNJREVOQ0UgT0YgREVQVEgsIG5vdCBhIHByb3BlcnR5LCB3aGljaCBpcyB3aHkgdGhlIHdhcmQgYXNzZXJ0cyB0aGVtXG4vLyByYXRoZXIgdGhhbiB0cnVzdGluZyB0aGlzIHBhcmFncmFwaC5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIEFORCBUSElTIExJTkUgSVMgVEhFIE9ORSBUSEUgUkVMT0NBVElPTiBCUk9LRS4gSXQgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJzZXJ2ZXIudHNcIilgIOKAlCB0aGUgZGFlbW9uIGJlc2lkZSB0aGUgQ0xJIOKAlCB3aGljaCB3YXMgdHJ1ZVxuLy8gZm9yIGV4YWN0bHkgYXMgbG9uZyBhcyBib3RoIGxpdmVkIGluIGBzY3JpcHRzL2AuIEZyb20gYGRpc3QvYCBpdCByZXNvbHZlcyB0b1xuLy8gYGRpc3Qvc2VydmVyLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgZXhpc3QgYW5kIG11c3Qgbm90OiBgZGlzdC9gIGhvbGRzIHRoZVxuLy8gQlVORExFIChgc2VydmVyLmpzYCksIGFuZCB0aGUgc3Bhd25hYmxlIGVudHJ5IGlzIHRoZSBsYXVuY2hlciBvbmUgZGlyZWN0b3J5XG4vLyBvdmVyLiBUaGUgc3ltcHRvbSBvZiBnZXR0aW5nIGl0IHdyb25nIGlzIG5vdCBhIGNyYXNoIOKAlCBgb3BlbmAgd2FpdHMgb3V0IGl0c1xuLy8gNDUtc2Vjb25kIGhhbmRzaGFrZSBhbmQgcmVwb3J0cyBhIHN0YXJ0IHRpbWVvdXQsIHdoaWNoIHJlYWRzIGxpa2UgYSBzbG93IGZpcnN0XG4vLyBidW5kbGUgYnVpbGQuIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgaXMgd2hhdCBuYW1lcyBpdCBpbiAwLjRzXG4vLyBpbnN0ZWFkLCBhbmQgaXQgbmFtZWQgdGhpcyBvbmUuIEFzdHJvbGFiZSBhbmQgbWFncGllIHdlcmUgYWxyZWFkeSB3cml0dGVuIHRoaXNcbi8vIHdheSBhbmQgcGFpZCBub3RoaW5nIGZvciB0aGUgbW92ZTsgZ2xhbW91ciBpcyB3aGVyZSB0aGUgc2hhcGUgZWFybmVkIGl0c2VsZi5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBCdW4gcmVhZHMgYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2Rcbi8vIE1VU1QgYmUgc3JjL2dsYW1vdXIvIGluIGRldiAoc2VhbXMgQ29udHJhY3QgNSkuIExhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IOKAlCBtZWFzdXJlZCBvbiBnbGFtb3VyIHRoZSBQQUdFIDUwMHMgd2l0aFxuLy8gbm8gc3R5bGVzaGVldCBsaW5rIChub3QgXCJ1bnN0eWxlZCBhdCAyMDBcIjsgdGhhdCBzZW50ZW5jZSB3YXMgbmV2ZXIgcnVuKS4gQXNzZXJ0XG4vLyB0aGUgaW52YXJpYW50OiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gdGhlIGN3ZCBpcyB3cm9uZy5cbi8vIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmQgc3RhdGljIOKAlCBubyBidW5maWcgcmVhZCwgc28gc3JjL2dsYW1vdXIvIG5lZWRcbi8vIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSwgYW5kXG4vLyBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGQgYnJlYWsgdGhlIHNwYXduLiBFeHBvcnRlZCBmb3IgdGhlIHRlc3QuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ2xhbW91clwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuZXhwb3J0IGNvbnN0IFNLSUxMX1JPT1RfRk9SX1RFU1QgPSBTS0lMTF9ST09UO1xuXG50eXBlIFNlc3Npb24gPSB7XG4gIHVybDogc3RyaW5nO1xuICBwb3J0OiBudW1iZXI7XG4gIHNlc3Npb25faWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZmlsZXNfZGlyPzogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIGVycm9yIGVudmVsb3BlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBUSEUgQ09OVFJBQ1QgSVMgTk9XIFRIRSBIT1VTRSdTIE9ORSBDT1BZIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIGFuZFxuLy8gZ2xhbW91cidzIGZvdXJ0aCB3YXMgZGVsZXRlZC4gVGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlIGVudmVsb3BlJ3Mga2V5XG4vLyBvcmRlciBhbmQgYGRpZWAncyB0aHJvdy1ub3QtZXhpdCBzaGFwZSBhbGwgY29tZSBmcm9tIHRoZXJlIOKAlCBhbmQgZ2xhbW91ciBpc1xuLy8gd2hlcmUgdHdvIG9mIHRoZW0gd2VyZSBmaXJzdCB3cml0dGVuLCBzbyBub3RoaW5nIGFib3V0IHRoZSB3aXJlIGNoYW5nZWQuIFRIUk9XXG4vLyBhbmQgbGV0IG1haW4oKSBjYXRjaCBhbmQgUkVUVVJOIHRoZSBjb2RlLCBuZXZlciBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYVxuLy8gaGVscGVyOiB0aGlzIENMSSBzaGlwcyBsYXJnZSBzdGRvdXQgcGF5bG9hZHMgKGBzdGF0ZSAtLWZ1bGxgKSwgQnVuJ3Mgc3Rkb3V0IGlzXG4vLyBhc3luY2hyb25vdXMgb24gYSBwaXBlLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgd2hhdGV2ZXIgaGFzIG5vdFxuLy8gZHJhaW5lZCAobWVhc3VyZWQgYXQgNjUsNTM2IGJ5dGVzKS5cbi8vXG4vLyDimqAgT05FIEZJRUxEIFdFTlQgVEhFIE9USEVSIFdBWS4gYGVycm9yLnNlcnZlcmAg4oCUIHRoZSBkYWVtb24ncyBvd24gYm9keSxcbi8vIHZlcmJhdGltIOKAlCBleGlzdGVkIG9ubHkgaGVyZSwgYmVjYXVzZSBhc3Ryb2xhYmUncyBhbmQgbWFncGllJ3MgY29waWVzIGtlZXAgdGhlXG4vLyBIVFRQIHN0YXR1cyBhbmQgZGlzY2FyZCB3aGF0IHRoZSBkYWVtb24gc2FpZC4gSXQgaXMgbm93IHBhcnQgb2YgdGhlIGtpdCdzXG4vLyBgRXJyRXh0cmFgLCBzbyB0aGUgc2hhcmVkIGNvbnRyYWN0IGdvdCBXSURFUiBieSBhZG9wdGluZyBnbGFtb3VyIHJhdGhlciB0aGFuXG4vLyBnbGFtb3VyIGdldHRpbmcgbmFycm93ZXIgdG8gZml0IGl0LiBTZWUgdGhhdCBtb2R1bGUncyBub3RlIG9uIHRoZSBmaWVsZC5cbi8vXG4vLyDim5QgQU5EIFRIRSBBRE9QVElPTiBSRVFVSVJFRCBUSEUgRDggUkVBQ0hBQklMSVRZIEFVRElULCBXSElDSCBXQVMgUEVSRk9STUVELlxuLy8gQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIHN3YWxsb3dzIGlzIGEgc2lsZW50XG4vLyBjb250aW51ZSwgYW5kIHRoZSBzaXRlIHRoYXQgZGllcyBjYW4gYmUgdGhyZWUgZnJhbWVzIGJlbG93IHRoZSBzaXRlIHRoYXQgbG9va3Ncbi8vIHNhZmUuIEF1ZGl0ZWQgYnkgZm9sbG93aW5nIHRoZSBjYWxsIGdyYXBoLCBub3QgYnkgZ3JlcHBpbmc6IDEyIGBkaWVgIGNhbGxcbi8vIHNpdGVzLCAyNSBmdXJ0aGVyIGludm9jYXRpb24gZWRnZXMgb2YgdGhlIHRlbiBmdW5jdGlvbnMgdGhhdCByZWFjaCBvbmVcbi8vIHRyYW5zaXRpdmVseSAoYHJlYWRTZXNzaW9uYCwgYHJlcXVpcmVTZXNzaW9uYCwgYHJlc29sdmVHZW5TcmNgLCBgY21kT3BlbmAsXG4vLyBgY21kSW5mb2AsIGBjbWRTdGF0ZWAsIGBjbWRUYWlsYCwgYHBvc3RDbWRgLCBgZGlzcGF0Y2hgLCBgbWFpbmAsIHBsdXMgZmlmdGVlblxuLy8gQ09NTUFORFNbXS5ydW4gY2xvc3VyZXMpLCAzNyBhdWRpdGVkIHBvc2l0aW9ucywgWkVSTyBpbnNpZGUgYSBgdHJ5YC4gVGhlIHRocmVlXG4vLyBzd2FsbG93aW5nIGNhdGNoZXMgaW4gdGhpcyBmaWxlIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2Anc1xuLy8gZGVncmFkZS10by11bmtub3duLCB0aGUgdGFpbCdzIG1hbGZvcm1lZC1mcmFtZSBza2lwKSBoYXZlIG5vIGRpZS1yZWFjaGFibGVcbi8vIGNhbGwgaW5zaWRlIHRoZW0uIFRoZSBvbmUgdG8gd2F0Y2ggaXMgZmxhZ2dlZCBhdCBgcG9zdENtZGAuXG5cbi8qKiBgVXNhZ2VFcnJvcmAgaXMgdGhlIG5hbWUgdGhlIHRlc3RzIGFuZCB0aGUgb2xkZXIgY2FsbCBzaXRlcyBrbm93OyBhIHVzYWdlXG4gKiAgZmFpbHVyZSBpcyBhIGBDbGlFcnJvcmAgb2Yga2luZCBcInVzYWdlXCIuIEtlcHQgYXMgYSBzdWJjbGFzcyByYXRoZXIgdGhhblxuICogIGlubGluZWQgYmVjYXVzZSBgZGlzcGF0Y2hgIGJyYW5jaGVzIG9uIGl0IHRvIGRpc3Rpbmd1aXNoIGEgUEFSU0UgcmVqZWN0aW9uXG4gKiAgKHdoaWNoIGl0IHJlc2hhcGVzIHdpdGggYSBwYXRoLXNjb3BlZCBgY2hvaWNlc2ApIGZyb20gYW55dGhpbmcgZWxzZSwgYW5kXG4gKiAgYGluc3RhbmNlb2ZgIGlzIHRoZSBvbmx5IGhvbmVzdCB3YXkgdG8gYXNrIHRoYXQuICovXG5leHBvcnQgY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0pIHtcbiAgICBzdXBlcihcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKTtcbiAgfVxufVxuXG5leHBvcnQgeyBDbGlFcnJvciB9O1xuXG4vLyBBIGRhZW1vbiByZWZ1c2FsOiB0aGUga2luZCBtYXBzIG9mZiB0aGUgSFRUUCBzdGF0dXMsIHRoZSBkYWVtb24ncyBvd24gYm9keVxuLy8gcmlkZXMgdmVyYmF0aW0gdW5kZXIgZXJyb3Iuc2VydmVyIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gaXQuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGRpZShgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNlc3Npb25cbiAgICA/IGpvaW4odG1wZGlyKCksIGBnbGFtb3VyLSR7c2Vzc2lvbn0uanNvbmApXG4gICAgOiBqb2luKHRtcGRpcigpLCBcImdsYW1vdXItbGF0ZXN0Lmpzb25cIik7XG59XG5cbi8qKiDim5QgTlVMTCBNRUFOUyBcIk5PIFNFU1NJT05cIiwgQU5EIE5PVEhJTkcgRUxTRS5cbiAqXG4gKiAgVGhpcyB1c2VkIHRvIGBjYXRjaCB7IHJldHVybiBudWxsIH1gIG92ZXIgdGhlIHdob2xlIHJlYWQsIHNvIEVWRVJZIGZhaWx1cmUg4oCUXG4gKiAgYSBjb3JydXB0IHBvaW50ZXIsIEVBQ0NFUywgYW5kIGFueSB0cmFuc2llbnQgdGhlIE9TIHJhaXNlcyB1bmRlciBsb2FkIOKAlFxuICogIGFycml2ZWQgYXQgdGhlIGNhbGxlcnMgd2VhcmluZyBhYnNlbmNlJ3MgY2xvdGhlcy4gVGhyZWUgb2YgdGhlbSBhY3Qgb24gdGhhdDpcbiAqICBgcmVxdWlyZVNlc3Npb25gIGRpZXMgYG5vdF9mb3VuZGAgKGV4aXQgNSksIGBjbWRJbmZvYCB0aGUgc2FtZSwgYW5kIHRoZSB3YXRjaFxuICogIGxvb3AgdHJlYXRzIGl0IGFzIFwidGhlIHBpbm5lZCBzZXNzaW9uIHdlbnQgYXdheVwiIGFuZCBleGl0cyAqKjAqKi4gQSByZXNvdXJjZVxuICogIGZhaWx1cmUgd2FzIHRoZXJlZm9yZSByZXBvcnRlZCBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBjb25zZXF1ZW5jZTogYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCdzIEhUVFAtNDAwIHJvdyBmYWlsZWQgb25jZVxuICogIHVuZGVyIHRoZSBmdWxsIDE0Ni1maWxlIGdhdGUgd2l0aCBleGl0ICoqNSoqIHdoZXJlIHRoZSBjb250cmFjdCBzYXlzIDIsIGFuZFxuICogIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuIChmaWxlZCAyMDI2LTA5LTA3LCBkaWdlc3RpZnkncyBQaGFzZSAwIGJhc2VsaW5lKS5cbiAqICA1IGlzIG5vdCBhIHNwYXduIGNyYXNoIOKAlCBpdCBpcyB0aGlzIGZ1bmN0aW9uJ3MgYG5vdF9mb3VuZGAsIHdoaWNoIGlzIHdoeSB0aGVcbiAqICBjZWxsIGNvdWxkIG5vdCB0ZWxsIFwidGhlIGNvbnRyYWN0IGJyb2tlXCIgZnJvbSBcInRoZSBtYWNoaW5lIHdhcyBidXN5XCIuXG4gKlxuICogIFNvOiBFTk9FTlQgaXMgdGhlIG9ubHkgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHRocm93cyBhbmQgbmFtZXMgaXRzZWxmLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24gfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gbnVsbDsgLy8gdGhlIG9uZSBob25lc3QgYWJzZW5jZVxuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgc28gYSBoYWxmLXdyaXR0ZW5cbiAgICAvLyBwb2ludGVyIGlzIG5vdCByZWFjaGFibGUgYW5kIHVucGFyc2VhYmxlIGNvbnRlbnQgaXMgcmVhbCBjb3JydXB0aW9uLlxuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24ge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBnbGFtb3VyIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgIG9yIGJvb2xlYW4gYC0tZmxhZ2AuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhpcyBwYXJzZXIgYWxyZWFkeSBzcGxpdCBvbiB0aGUgZmlyc3QgYD1gLiBXaGF0IGl0IGxhY2tlZCB3YXMgYSBSRUdJU1RSWTpcbi8vIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZVxuLy8gcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhcyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLiBgbm9kZTp1dGlsYFxuLy8gc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBhbG9uZ3NpZGUgdGhlIGA9YCBoYW5kbGluZy5cbi8vXG4vLyDimqAgYC0tcmVzdG9yZWAgSEFEIE5PIENPUlJFQ1QgVFlQRSBhbmQgdGhpcyBpcyB0aGUgc3ByaW50J3Mgb25lIGdlbnVpbmUgZGVzaWduXG4vLyBibG9ja2VyLCBSVUxFRCBCWSBDT0xFLiBJdCB3YXMgQk9PTEVBTiBpbiBgc3R5bGUtYXJjaGl2ZWAgKGBhcmNoaXZlZDpcbi8vIGZsYWdzLnJlc3RvcmUgIT09IHRydWVgKSBhbmQgU1RSSU5HIGluIGBvcGVuYCdzIGRhZW1vbiBzcGF3biDigJQgb25lIGZsYWcgbmFtZSxcbi8vIHR3byBpbmNvbXBhdGlibGUgdHlwZXMsIG9uZSBvcHRpb25zIG1hcC4gRGVjbGFyaW5nIGl0IGJvb2xlYW4gc2VuZHMgYG9wZW5gJ3Ncbi8vIGlkIHRvIHBvc2l0aW9uYWxzIGFuZCBmb3J3YXJkcyBgLS1yZXN0b3JlIHRydWVgLCBzbyB0aGUgZGFlbW9uIGh1bnRzIGFcbi8vIHNuYXBzaG90IG5hbWVkIFwidHJ1ZVwiOyBkZWNsYXJpbmcgaXQgc3RyaW5nIG1ha2VzIGBzdHlsZS1hcmNoaXZlIDxpZD5cbi8vIC0tcmVzdG9yZWAgc3dhbGxvdyB0aGUgbmV4dCBwb3NpdGlvbmFsLCB3aGljaCBpcyB0aGlzIHNwcmludCdzIG93biBkZWZlY3Rcbi8vIGNsYXNzIHJlLWludHJvZHVjZWQgYnkgaXRzIGZpeC5cbi8vXG4vLyBSdWxlZDogcmVuYW1lIHRoZSBCT09MRUFOIG9uZS4gYC0tcmVzdG9yZWAga2VlcHMgdGhlIGhvdXNlLXdpZGUgc3RyaW5nXG4vLyBzcGVsbGluZyBpdCBzaGFyZXMgd2l0aCBib3VudHksIGltYWdvLCBtYWdwaWUgYW5kIGdsYW1vdXIncyBvd24gc2VydmVyLnRzO1xuLy8gYHN0eWxlLWFyY2hpdmVgIHRha2VzIGAtLXVuYXJjaGl2ZWAsIHdoaWNoIG5hbWVzIHRoZSBpbnZlcnNlIG9mIGFyY2hpdmVcbi8vIGJldHRlciBhbnl3YXkuIEl0IGFsc28ga2lsbHMgYSBsaXZlIGJ1ZyBCWSBDT05TVFJVQ1RJT046IGBmbGFncy5yZXN0b3JlICE9PVxuLy8gdHJ1ZWAgbWVhbnQgYHN0eWxlLWFyY2hpdmUgPGlkPiAtLXJlc3RvcmUgZm9vYCBBUkNISVZFRCBpbnN0ZWFkIG9mIHJlc3RvcmluZyxcbi8vIGF0IGV4aXQgMCwgd2l0aCBubyBzaWduYWwuXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgY29sb3JzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY29udGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjdXN0b206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmaWxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBub3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvbXB0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvbXB0czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByb3VuZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlZWQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzcmM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHVybDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdW5hcmNoaXZlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUyA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKS5tYXAoKGspID0+IGAtLSR7a31gKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIFRoZSByZWplY3Rpb24gTkFNRVMgaXRzIHZhbGlkIHNldCAoYWNjIEEzJ3MgU0hPVUxEKTogYGNob2ljZXNgIGlzIHRoZVxuICAgIC8vIHJlY29nbml6ZWQgZmxhZyByZWdpc3RyeSwgc28gYW4gYWdlbnQgc2VsZi1jb3JyZWN0cyB3aXRob3V0IGEgbG9va3VwLlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGRldGFpbCwge1xuICAgICAgaGludDogXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCIsXG4gICAgICBjaG9pY2VzOiBSRUNPR05JWkVEX0ZMQUdTLFxuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNheUNtZChcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmc7IGtpbmQ/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGNtZDogeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmc7IGtpbmQ/OiBzdHJpbmcgfSA9IHtcbiAgICB0eXBlOiBcInNheVwiLFxuICAgIHRleHQ6IHBvcy5qb2luKFwiIFwiKSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5raW5kID09PSBcInN0cmluZ1wiKSBjbWQua2luZCA9IGZsYWdzLmtpbmQ7XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNlY3Rpb25DbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHtcbiAgdHlwZTogXCJzZWN0aW9uXCI7XG4gIGtleTogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGNvbnRlbnQ/OiBzdHJpbmc7XG4gIHByb21wdHM/OiBzdHJpbmdbXTtcbiAgY29sb3JzPzogQXJyYXk8eyBoZXg6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9Pjtcbn0ge1xuICBjb25zdCBjbWQ6IHtcbiAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICBrZXk6IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgY29udGVudD86IHN0cmluZztcbiAgICBwcm9tcHRzPzogc3RyaW5nW107XG4gICAgY29sb3JzPzogQXJyYXk8eyBoZXg6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9PjtcbiAgfSA9IHsgdHlwZTogXCJzZWN0aW9uXCIsIGtleTogcG9zWzBdIH07XG4gIGlmICh0eXBlb2YgZmxhZ3Muc3RhdHVzID09PSBcInN0cmluZ1wiKSBjbWQuc3RhdHVzID0gZmxhZ3Muc3RhdHVzO1xuICBpZiAodHlwZW9mIGZsYWdzLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIGNtZC5jb250ZW50ID0gZmxhZ3MuY29udGVudDtcbiAgaWYgKHR5cGVvZiBmbGFncy5wcm9tcHRzID09PSBcInN0cmluZ1wiKVxuICAgIGNtZC5wcm9tcHRzID0gZmxhZ3MucHJvbXB0cy5zcGxpdChcInx8XCIpLm1hcCgocCkgPT4gcC50cmltKCkpO1xuICAvLyAtLWNvbG9ycyBcIiNGQUNDM0U6VHJlYXN1cmUgR29sZHx8IzI5M0QzNjpTdW5rZW4gQ2hhcmNvYWxcIiDihpIgc3RydWN0dXJlZCBzd2F0Y2hlc1xuICBpZiAodHlwZW9mIGZsYWdzLmNvbG9ycyA9PT0gXCJzdHJpbmdcIilcbiAgICBjbWQuY29sb3JzID0gZmxhZ3MuY29sb3JzXG4gICAgICAuc3BsaXQoXCJ8fFwiKVxuICAgICAgLm1hcCgocykgPT4ge1xuICAgICAgICBjb25zdCBpID0gcy5pbmRleE9mKFwiOlwiKTtcbiAgICAgICAgcmV0dXJuIGkgPj0gMFxuICAgICAgICAgID8geyBoZXg6IHMuc2xpY2UoMCwgaSkudHJpbSgpLCBuYW1lOiBzLnNsaWNlKGkgKyAxKS50cmltKCkgfVxuICAgICAgICAgIDogeyBoZXg6IHMudHJpbSgpIH07XG4gICAgICB9KVxuICAgICAgLmZpbHRlcigoYykgPT4gYy5oZXgpO1xuICByZXR1cm4gY21kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDdXN0b20odjogc3RyaW5nIHwgYm9vbGVhbiB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIHYgIT09IFwic3RyaW5nXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBmb3IgKGNvbnN0IHBhaXIgb2Ygdi5zcGxpdChcIixcIikpIHtcbiAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgaWYgKGVxID4gMCkgb3V0W3BhaXIuc2xpY2UoMCwgZXEpLnRyaW0oKV0gPSBwYWlyLnNsaWNlKGVxICsgMSkudHJpbSgpO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyhvdXQpLmxlbmd0aCA/IG91dCA6IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR2VuQ21kKFxuICBzcmM6IHN0cmluZyxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKToge1xuICB0eXBlOiBcImdlbi5hZGRcIjtcbiAgc3JjOiBzdHJpbmc7XG4gIHByb21wdDogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nO1xuICByb3VuZDogbnVtYmVyO1xuICBzZWVkPzogbnVtYmVyO1xuICBjb3N0PzogbnVtYmVyO1xuICBsYWJlbD86IHN0cmluZztcbiAgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn0ge1xuICBjb25zdCBjbWQ6IFJldHVyblR5cGU8dHlwZW9mIGJ1aWxkR2VuQ21kPiA9IHtcbiAgICB0eXBlOiBcImdlbi5hZGRcIixcbiAgICBzcmMsXG4gICAgcHJvbXB0OiB0eXBlb2YgZmxhZ3MucHJvbXB0ID09PSBcInN0cmluZ1wiID8gZmxhZ3MucHJvbXB0IDogXCJcIixcbiAgICBtb2RlbDogdHlwZW9mIGZsYWdzLm1vZGVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubW9kZWwgOiBcIlwiLFxuICAgIHJvdW5kOiB0eXBlb2YgZmxhZ3Mucm91bmQgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Mucm91bmQsIDEwKSA6IDAsXG4gIH07XG4gIGlmICh0eXBlb2YgZmxhZ3Muc2VlZCA9PT0gXCJzdHJpbmdcIikgY21kLnNlZWQgPSBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2VlZCwgMTApO1xuICBpZiAodHlwZW9mIGZsYWdzLmNvc3QgPT09IFwic3RyaW5nXCIpIGNtZC5jb3N0ID0gTnVtYmVyLnBhcnNlRmxvYXQoZmxhZ3MuY29zdCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MubGFiZWwgPT09IFwic3RyaW5nXCIpIGNtZC5sYWJlbCA9IGZsYWdzLmxhYmVsO1xuICBjb25zdCBjdXN0b20gPSBwYXJzZUN1c3RvbShmbGFncy5jdXN0b20pO1xuICBpZiAoY3VzdG9tKSBjbWQuY3VzdG9tID0gY3VzdG9tO1xuICByZXR1cm4gY21kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW5Db3N0Q21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwiZ2VuLmNvc3RcIjsgaWQ6IHN0cmluZzsgY29zdDogbnVtYmVyIH0ge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwiZ2VuLmNvc3RcIixcbiAgICBpZDogcG9zWzBdLFxuICAgIGNvc3Q6IHR5cGVvZiBmbGFncy5jb3N0ID09PSBcInN0cmluZ1wiID8gTnVtYmVyLnBhcnNlRmxvYXQoZmxhZ3MuY29zdCkgOiBOdW1iZXIuTmFOLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW5NZXRhQ21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwiZ2VuLm1ldGFcIjsgaWQ6IHN0cmluZzsgcHJvbXB0Pzogc3RyaW5nOyBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH0ge1xuICBjb25zdCBjbWQ6IHsgdHlwZTogXCJnZW4ubWV0YVwiOyBpZDogc3RyaW5nOyBwcm9tcHQ/OiBzdHJpbmc7IGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSA9IHtcbiAgICB0eXBlOiBcImdlbi5tZXRhXCIsXG4gICAgaWQ6IHBvc1swXSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGNtZC5wcm9tcHQgPSBmbGFncy5wcm9tcHQ7XG4gIGNvbnN0IGN1c3RvbSA9IHBhcnNlQ3VzdG9tKGZsYWdzLmN1c3RvbSk7XG4gIGlmIChjdXN0b20pIGNtZC5jdXN0b20gPSBjdXN0b207XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0eWxlU2F2ZUNtZChwb3M6IHN0cmluZ1tdKToge1xuICB0eXBlOiBcInN0eWxlLnNhdmVcIjtcbiAgbGFiZWw6IHN0cmluZztcbn0ge1xuICByZXR1cm4geyB0eXBlOiBcInN0eWxlLnNhdmVcIiwgbGFiZWw6IHBvcy5qb2luKFwiIFwiKSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdHlsZUFyY2hpdmVDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJzdHlsZS5hcmNoaXZlXCI7IGlkOiBzdHJpbmc7IGFyY2hpdmVkOiBib29sZWFuIH0ge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwic3R5bGUuYXJjaGl2ZVwiLFxuICAgIGlkOiBwb3NbMF0sXG4gICAgYXJjaGl2ZWQ6ICFmbGFncy51bmFyY2hpdmUsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZvY3VzQ21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwiZm9jdXMucHVzaFwiOyBpZHM6IHN0cmluZ1tdOyBub3RlPzogc3RyaW5nIH0ge1xuICBjb25zdCBjbWQ6IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSA9IHtcbiAgICB0eXBlOiBcImZvY3VzLnB1c2hcIixcbiAgICBpZHM6IHBvcyxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5ub3RlID09PSBcInN0cmluZ1wiKSBjbWQubm90ZSA9IGZsYWdzLm5vdGU7XG4gIHJldHVybiBjbWQ7XG59XG5cbi8vIFJlc29sdmUgYSBnZW4gaW1hZ2Ugc291cmNlIHRvIGFuIE9QVElNSVpFRCB3ZWJwIGRhdGEtVVJMICh0aGUgZGFlbW9uIHN0b3Jlc1xuLy8gaXQgYXMtaXMpLiAtLXVybCBkb3dubG9hZHM7IC0tZmlsZSByZWFkczsgLS1zcmMgaXMgYW4gZXhpc3RpbmcgZGF0YS1VUkwuXG4vKipcbiAqIOKUgOKUgCBgZ2VuYCdzIFRXTyBBQ0NFUFRFRCBTRVRTIChyZWdpc3RlciBBMSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYEdFTl9TUkNfRkxBR1NgIGlzIGEgRElTSlVOQ1RJT04g4oCUIGFueSBvbmUgc2F0aXNmaWVzIGByZXNvbHZlR2VuU3JjYC5cbiAqIGBHRU5fUkVRVUlSRURfRkxBR1NgIGlzIGEgQ09OSlVOQ1RJT04g4oCUIGFsbCB0aHJlZSBtdXN0IGJlIHByZXNlbnQg4oCUIGFuZCB0aGVcbiAqIHJlamVjdGlvbiBiZWxvdyBmaWx0ZXJzIGl0LCBzbyBpdHMgYGNob2ljZXNgIG5hbWVzIHRoZSBvbmVzIGFjdHVhbGx5IE1JU1NJTkdcbiAqIHJhdGhlciB0aGFuIHRoZSB3aG9sZSByb3N0ZXIuIEJvdGggYXJlIGRlcml2ZWQgYXQgdGhlIHNpdGUgdGhhdCBlbmZvcmNlc1xuICogdGhlbTsgbmVpdGhlciBpcyByZS10eXBlZCBpbnRvIGEgbWVzc2FnZS5cbiAqL1xuY29uc3QgR0VOX1NSQ19GTEFHUyA9IFtcInVybFwiLCBcImZpbGVcIiwgXCJzcmNcIl0gYXMgY29uc3Q7XG5jb25zdCBHRU5fUkVRVUlSRURfRkxBR1MgPSBbXCJwcm9tcHRcIiwgXCJtb2RlbFwiLCBcInJvdW5kXCJdIGFzIGNvbnN0O1xuLyoqIGBnZW4tbWV0YWAncyBkaXNqdW5jdGlvbiDigJQgZWl0aGVyIG9uZSBzYXRpc2ZpZXMgaXQuICovXG5jb25zdCBHRU5fTUVUQV9GTEFHUyA9IFtcInByb21wdFwiLCBcImN1c3RvbVwiXSBhcyBjb25zdDtcblxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUdlblNyYyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBpZiAodHlwZW9mIGZsYWdzLnVybCA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGZsYWdzLnVybCk7XG4gICAgaWYgKCFyZXMub2spIGRpZShgZ2VuOiBmYWlsZWQgdG8gZmV0Y2ggLS11cmwgKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgcmVzLmFycmF5QnVmZmVyKCkpO1xuICAgIGxldCBiaW4gPSBcIlwiO1xuICAgIGZvciAoY29uc3QgYiBvZiBieXRlcykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYik7XG4gICAgY29uc3QgbWltZSA9IHJlcy5oZWFkZXJzLmdldChcImNvbnRlbnQtdHlwZVwiKSA/PyBcImltYWdlL3BuZ1wiO1xuICAgIHJldHVybiBvcHRpbWl6ZUltYWdlRGF0YVVybChgZGF0YToke21pbWV9O2Jhc2U2NCwke2J0b2EoYmluKX1gKTtcbiAgfVxuICBpZiAodHlwZW9mIGZsYWdzLmZpbGUgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IEJ1bi5maWxlKGZsYWdzLmZpbGUpLmFycmF5QnVmZmVyKCkpO1xuICAgIGxldCBiaW4gPSBcIlwiO1xuICAgIGZvciAoY29uc3QgYiBvZiBieXRlcykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYik7XG4gICAgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtidG9hKGJpbil9YCk7XG4gIH1cbiAgaWYgKHR5cGVvZiBmbGFncy5zcmMgPT09IFwic3RyaW5nXCIpIHJldHVybiBvcHRpbWl6ZUltYWdlRGF0YVVybChmbGFncy5zcmMpO1xuICAvLyDim5QgUkVHSVNURVIgQTEg4oCUIFRIRSBESVNKVU5DVElPTiBJUyBgY2hvaWNlc2AsIE5PVCBBIFNFTlRFTkNFLiBUaHJlZSBmbGFnc1xuICAvLyBhbnkgT05FIG9mIHdoaWNoIHNhdGlzZmllcyB0aGlzIGlzIGV4YWN0bHkgYSByb3V0aW5nIGRlY2lzaW9uOiB0aGUgY2FsbGVyXG4gIC8vICh1c3VhbGx5IGFuIGFnZW50KSBoYXMgdG8gcGljayBvbmUsIGFuZCBwaWNraW5nIGZyb20gcHJvc2UgbWVhbnMgcGFyc2luZ1xuICAvLyBwcm9zZS4gYEdFTl9TUkNfRkxBR1NgIGlzIHRoZSBzZXQgdGhlIGJyYW5jaGVzIGFib3ZlIHJlYWQsIGFuZFxuICAvLyBgY2xpLnRlc3QudHNgIGJpbmRzIHRoZSB0d28gc28gYSBmb3VydGggc291cmNlIGNhbm5vdCBiZSBhZGRlZCB0byBvbmUuXG4gIGRpZShcImdlbjogYSBzb3VyY2UgaXMgcmVxdWlyZWRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgaGludDogYHBhc3Mgb25lIG9mICR7R0VOX1NSQ19GTEFHUy5tYXAoKGspID0+IGAtLSR7a31gKS5qb2luKFwiIFwiKX1gLFxuICAgIGNob2ljZXM6IEdFTl9TUkNfRkxBR1MubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGxldCBzdGF0dXM6IG51bWJlcjtcbiAgbGV0IGRhdGE6IHVua25vd247XG4gIHRyeSB7XG4gICAgKHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIG1zZykpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBgY2xvc2VgIGNhdXNlcyBCdW4uc2VydmUgdG8gc3RvcCBpbW1lZGlhdGVseSDigJQgdGhlIGNvbm5lY3Rpb24gcmVzZXRzXG4gICAgLy8gYmVmb3JlIHRoZSAyMDAgcmVzcG9uc2UgaXMgZmx1c2hlZC4gVHJlYXQgRUNPTk5SRVNFVCBvbiBjbG9zZSBhcyBzdWNjZXNzLlxuICAgIC8vIE9OTFkgYSByZXNldDogYSByZWZ1c2VkIGNvbm5lY3Rpb24gKHN0YWxlIHBvaW50ZXIsIGRhZW1vbiBhbHJlYWR5IGdvbmUpXG4gICAgLy8gaXMgYSB0cmFuc3BvcnQgZmFpbHVyZSBsaWtlIGFueSBvdGhlciBhbmQgcmlkZXMgdGhlIGludGVybmFsIGVudmVsb3BlIOKAlFxuICAgIC8vIHRoZSByZXZpZXcgZm91bmQgdGhlIG9sZCBjYXRjaC1hbGwgcmVwb3J0aW5nIHtvazp0cnVlfSBhZ2FpbnN0IGEgZGVhZCBwb3J0LlxuICAgIGNvbnN0IGNvZGUgPSBlcnIgJiYgdHlwZW9mIGVyciA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlcnIgPyBTdHJpbmcoZXJyLmNvZGUpIDogXCJcIjtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiICYmIChjb2RlID09PSBcIkVDT05OUkVTRVRcIiB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiRUNPTk5SRVNFVFwiKSkpIHtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJjbWRcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IG1zZy50eXBlIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGRhZW1vbkFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmIChmbGFncy50aXRsZSkgZGFlbW9uQXJncy5wdXNoKFwiLS10aXRsZVwiLCBTdHJpbmcoZmxhZ3MudGl0bGUpKTtcbiAgaWYgKGZsYWdzLmludGVudCkgZGFlbW9uQXJncy5wdXNoKFwiLS1pbnRlbnRcIiwgU3RyaW5nKGZsYWdzLmludGVudCkpO1xuICBpZiAoZmxhZ3MudGltZW91dCkgZGFlbW9uQXJncy5wdXNoKFwiLS10aW1lb3V0XCIsIFN0cmluZyhmbGFncy50aW1lb3V0KSk7XG4gIGlmIChmbGFncy5yZXN0b3JlKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgU3RyaW5nKGZsYWdzLnJlc3RvcmUpKTtcbiAgLy8gVGhlIHVzZXIncyBwcm9qZWN0IGRpciDigJQgY2FwdHVyZWQgaGVyZSBiZWNhdXNlIHRoZSBkYWVtb24gc3Bhd25zIHdpdGggYVxuICAvLyBwaW5uZWQgY3dkIChkYWVtb25Dd2QoKSksIHNvIGl0IGNhbid0IHJlYWQgdGhlIHJlYWwgY3dkIGl0c2VsZi5cbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1wcm9qZWN0XCIsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIC8vIG5vZGU6Y2hpbGRfcHJvY2VzcyAobm90IEJ1bi5zcGF3bikgaXMgZGVsaWJlcmF0ZTogdGhlIGRhZW1vbiBtdXN0IFNVUlZJVkVcbiAgLy8gdGhpcyBDTEkgcHJvY2VzcyBleGl0aW5nLCB3aGljaCBuZWVkcyBgZGV0YWNoZWQ6IHRydWVgICsgYHVucmVmKClgLlxuICAvLyBDb250cmFjdCA1IOKAlCBzZWUgZGFlbW9uQ3dkKCkuIEFuZCBjaGVjayB0aGUgY3dkIEVYSVNUUyBiZWZvcmUgc3Bhd25pbmc6XG4gIC8vIG5vZGUgcmVwb3J0cyBhIG1pc3NpbmcgY3dkIGFzIGBFTk9FTlQg4oCmIHBvc2l4X3NwYXduICdidW4nYCwgd2hpY2ggbmFtZXMgdGhlXG4gIC8vIG9uZSB0aGluZyB0aGF0IGlzIGZpbmUuIE1lYXN1cmVkIGJ5IGNhc3NhbmRyYSBhdCBhIGRlcHMtZnJlZSBkZXN0aW5hdGlvblxuICAvLyB3aXRoIGRpc3QvaW5kZXguaHRtbCByZW1vdmVkIChjb21tcyAjMTI2NSk6IGEgY29sZCBhZ2VudCByZWFkcyB0aGF0IGFuZFxuICAvLyByZWluc3RhbGxzIGJ1bi4gTmFtZSB0aGUgcmVhbCBhYnNlbmNlIGluc3RlYWQuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBnbGFtb3VyIGNhbm5vdCBzdGFydCBpdHMgZGFlbW9uOiB0aGUgd29ya2luZyBkaXJlY3RvcnkgaXQgbmVlZHMgaXMgbWlzc2luZyDigJQgJHtjd2R9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGF0IHRoZSBza2lsbCByb290IGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCBcIiArXG4gICAgICAgICAgXCJzbyB0aGUgZGFlbW9uIG11c3QgcnVuIGZyb20gc3JjL2dsYW1vdXIvLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgZG9lcyBub3QgaGF2ZS4gXCIgK1xuICAgICAgICAgIFwiRWl0aGVyIHRoZSBzaGlwcGVkIGRpc3QvIGlzIG1pc3NpbmcgKHJlaW5zdGFsbCB0aGUgc3BlbGwpIG9yIHlvdSBhcmUgaW4gYSBjaGVja291dCB3aXRob3V0IHNyYy9nbGFtb3VyLy5cIixcbiAgICAgIH0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpbmhlcml0XCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIC8vIFJlYWQgdGhlIGRhZW1vbidzIGZpcnN0IHN0ZG91dCBsaW5lIOKAlCBpdCBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH0uXG4gIC8vIEdlbmVyb3VzIGRlZmF1bHQ6IHRoZSBmaXJzdCBidW5kbGUgYnVpbGQgb2YgdGhlIFJlYWN0IHN1cmZhY2UgY2FuIHRha2UgdGVuc1xuICAvLyBvZiBzZWNvbmRzIGNvbGQsIGFuZCBhIHRvby1zaG9ydCBoYW5kc2hha2UgbWFrZXMgYG9wZW5gIHJlcG9ydCBmYWlsdXJlIHdoaWxlXG4gIC8vIHRoZSBkYWVtb24gYWN0dWFsbHkgY29tZXMgdXAgZmluZS4gT3ZlcnJpZGUgd2l0aCAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+LlxuICBjb25zdCBzdGFydFRpbWVvdXRNcyA9XG4gICAgdHlwZW9mIGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBNYXRoLm1heCg1MDAwLCBOdW1iZXIucGFyc2VJbnQoU3RyaW5nKGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSksIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBpbmZvID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWplY3QoXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgZmlyc3QgYnVuZGxlIGJ1aWxkIGNhbiBiZSBzbG93OyByZXRyeSBvciBwYXNzIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz5gLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICBzdGFydFRpbWVvdXRNcyxcbiAgICApO1xuICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N0eWxlL25vTm9uTnVsbEFzc2VydGlvbjogc3RkaW8gXCJwaXBlXCIgZ3VhcmFudGVlcyBzdGRvdXRcbiAgICBjaGlsZC5zdGRvdXQhLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICByZXNvbHZlKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICAgIHJlamVjdChlcnIpO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgICAgaWYgKGNvZGUgIT09IG51bGwgJiYgY29kZSAhPT0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoYGRhZW1vbiBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX1gKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgZGllKGBnbGFtb3VyIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQ6ICR7bXNnfWAsIFwiaW50ZXJuYWxcIik7XG4gIH0pO1xuXG4gIC8vIOKaoCBSRUxFQVNFIFRIRSBEQUVNT04nUyBTVERPVVQgUElQRSwgb3IgdGhpcyBDTEkgbmV2ZXIgZXhpdHMuXG4gIC8vXG4gIC8vIGBjaGlsZC51bnJlZigpYCBhYm92ZSByZWxlYXNlcyB0aGUgQ0hJTEQgUFJPQ0VTUyBoYW5kbGUuIFRoZSBwaXBlZCBzdGRvdXQgaXNcbiAgLy8gYSBTRVBBUkFURSByZWZmZWQgaGFuZGxlLCBhbmQgdGhlIGRhZW1vbiBydW5zIGZvcmV2ZXIg4oCUIHNvIG9uY2UgYG9wZW5gIHN0b3BzXG4gIC8vIGZvcmNlLWV4aXRpbmcsIHRoZSBwYXJlbnQncyBldmVudCBsb29wIHdhaXRzIG9uIGEgc3RyZWFtIHRoYXQgd2lsbCBuZXZlclxuICAvLyBjbG9zZS4gTWVhc3VyZWQ6IGBvcGVuIC0tbm8tb3BlbmAgc3RpbGwgcnVubmluZyBhdCA5MXM7IHdpdGggdGhpcyBsaW5lLCAxcy5cbiAgLy9cbiAgLy8gVGhpcyBiZWNhbWUgbGl2ZSB3aGVuIFAwIHJlcGxhY2VkIGBwcm9jZXNzLmV4aXQoY29kZSlgIHdpdGggYHByb2Nlc3MuZXhpdENvZGVgXG4gIC8vICsgYSBuYXR1cmFsIHJldHVybjogYHByb2Nlc3MuZXhpdGAgaGFkIGJlZW4gZG9pbmcgRE9VQkxFIERVVFksIGRyYWluaW5nIHN0ZG91dFxuICAvLyAoYnJva2VuIOKAlCBpdCB0cnVuY2F0ZWQgYXQgNjUsNTM2KSBBTkQgdGVybWluYXRpbmcgZGVzcGl0ZSBhIGxpdmUgY2hpbGQgcGlwZVxuICAvLyAobG9hZC1iZWFyaW5nLCBhbmQgdW5ub3RpY2VkKS4gUmVtb3ZpbmcgaXQgZml4ZWQgdGhlIGZpcnN0IGFuZCBleHBvc2VkIHRoZVxuICAvLyBzZWNvbmQuIGBqb2luLnRzYCBoYXMgdGhlIHNhbWUgc2hhcGUgYW5kIGlzIGRlbGliZXJhdGVseSBOT1QgY29udmVydGVkLlxuICAvL1xuICAvLyBgdW5yZWYoKWAgcmF0aGVyIHRoYW4gYGRlc3Ryb3koKWA6IGJvdGggbWVhc3VyZWQgY2xlYW4sIGFuZCB1bnJlZiBpcyB0aGVcbiAgLy8gY29uc2VydmF0aXZlIG9uZSDigJQgaXQgbGVhdmVzIHRoZSBzdHJlYW0gdXNhYmxlIGFuZCBvbmx5IHN0b3BzIGl0IGhvbGRpbmcgdGhlXG4gIC8vIGxvb3AuIFRoZSBoYW5kc2hha2UgaXMgdGhlIHNvbGUgcmVhZCwgc28gbm90aGluZyBkb3duc3RyZWFtIG5lZWRzIGl0LlxuICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdHlsZS9ub05vbk51bGxBc3NlcnRpb246IHN0ZGlvIFwicGlwZVwiIGd1YXJhbnRlZXMgc3Rkb3V0XG4gIGNoaWxkLnN0ZG91dCEudW5yZWYoKTtcblxuICBsZXQgcGFyc2VkOiB7IHVybDogc3RyaW5nOyBwb3J0OiBudW1iZXI7IHNlc3Npb25faWQ6IHN0cmluZyB9O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UoaW5mbykgYXMgdHlwZW9mIHBhcnNlZDtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB1bmV4cGVjdGVkIG91dHB1dCBmcm9tIGRhZW1vbjogJHtpbmZvfWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cblxuICBwcmludEpzb24ocGFyc2VkKTtcblxuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkge1xuICAgIC8vIFBsYXRmb3JtIG9wZW5lciDigJQgb3BlbiB0aGUgYnJvd3NlclxuICAgIGNvbnN0IG9wZW5lciA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gICAgc3Bhd24ob3BlbmVyLCBbcGFyc2VkLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoc2Vzc2lvbj86IHN0cmluZywgZnVsbCA9IGZhbHNlKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIGAvc3RhdGUke2Z1bGwgPyBcIlwiIDogXCI/bGVhbj0xXCJ9YCk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcInN0YXRlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuLyoqXG4gKiBUaGUgZXZlbnQgdGFpbCDigJQgT05FIENBTEwgaW50byB0aGUgaG91c2UncyBzaGFyZWQgU1NFIGNsaWVudFxuICogKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLCB3aGVyZSB0aGUgcmVjb25uZWN0IGxvb3AsIHRoZSBzcGVjLWNvcnJlY3RcbiAqIGZyYW1lIHBhcnNlciwgdGhlIGJhY2tvZmYsIHRoZSBpZGxlIHdhdGNoZG9nIGFuZCB0aGUgZHJhaW5lZCBleGl0IGxpdmUgb25jZVxuICogZm9yIGV2ZXJ5IHNwZWxsLlxuICpcbiAqIOKblCAqKlRISVMgSVMgV0hFUkUgQ0VOU1VTIERFRkVDVCBCNSBESUVTIEJZIENPTlNUUlVDVElPTi4qKiBUaGUgbG9vcCB0aGlzXG4gKiByZXBsYWNlcyBzZXQgYGxldCBkZWxheSA9IDI1MGAgKGBjbGkudHM6NjIzYCBiZWZvcmUgdGhlIHBvcnQpIGFuZCB0aGVuIHJlc2V0XG4gKiBpdCB0byAyNTAgb24gZXZlcnkgU1VDQ0VTU0ZVTCBPUEVOIChgOjY2N2ApIOKAlCBzbyBhIGRhZW1vbiB0aGF0IGFjY2VwdHMgYVxuICogY29ubmVjdGlvbiBhbmQgaW1tZWRpYXRlbHkgZHJvcHMgaXQgd2FzIHJlY29ubmVjdGVkIGFnYWluc3QgYXQgYSBDT05TVEFOVFxuICogMjUwIG1zLCBmb3JldmVyLCB3aXRoIG5vIGdyb3d0aDogYSByZWNvbm5lY3Qgc3Rvcm0gdGhhdCBsb29rcyBsaWtlIGEgaGVhbHRoeVxuICogcmV0cnkuIFRocmVlIHNpdGVzIGRpZCBncm93IHRoZSBkZWxheSAoYDo2NDJgLCBgOjY1OWAsIGA6NjY0YCkgYW5kIG9uZSBkaWRcbiAqIG5vdCwgd2hpY2ggaXMgcHJlY2lzZWx5IHdoeSBhIGhhbmQtd3JpdHRlbiBsb29wIGNhbm5vdCBiZSByZWFzb25lZCBhYm91dCBmcm9tXG4gKiBvbmUgb2YgaXRzIGJyYW5jaGVzLiAqKkl0IGNhbm5vdCBiZSByZS1leHByZXNzZWQgaGVyZSwgYmVjYXVzZSB0aGVyZSBpcyBub1xuICogbG9vcCBsZWZ0IHRvIHB1dCBpdCBpbioqIOKAlCB0aGVyZSBpcyBvbmUgYmFja29mZiwgaXQgZG91YmxlcyBvbiBldmVyeSBmYWlsZWRcbiAqIGF0dGVtcHQsIGFuZCBQaGFzZSAxYSdzIHNlY29uZCBkb29yICh0aGUgcmVzZXQgYmVsb25ncyBhdCB0aGUgRklSU1QgQllURSwgbm90XG4gKiBhdCBhIHN1Y2Nlc3NmdWwgb3BlbikgaXMgY2xvc2VkIGJ5IHRoZSBzYW1lIHNpbmdsZSBpbXBsZW1lbnRhdGlvbi5cbiAqXG4gKiDim5QgYHJlc29sdmVgIFJFLVJFQURTIFRIRSBTRVNTSU9OIFBPSU5URVIgT04gRVZFUlkgQVRURU1QVCwgd2hpY2ggaXMgd2hhdFxuICogZ2xhbW91cidzIG93biBsb29wIGRpZCBhbmQgd2hhdCB0aGUgc2hhcmVkIGNsaWVudCBtYWtlcyBzdHJ1Y3R1cmFsOiB0aGUgZGFlbW9uXG4gKiBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydCwgc28gYSBjYXB0dXJlZCBiYXNlIGlzIGEgdGFpbCB0aGF0IHN1cnZpdmVzIGV4YWN0bHkgb25lXG4gKiBkYWVtb24uXG4gKlxuICog4puUIEFORCBJVCBHQUlORUQgQSBXQVRDSERPRyBJVCBESUQgTk9UIEhBVkUuIFRoZSBvbGQgbG9vcCBoYWQgbm9uZTogaXQgYmxvY2tlZFxuICogb24gYGF3YWl0IHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGFcbiAqIE5BVCByZWJpbmQgb3IgYSBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBpbiBzaWxlbmNlIHdpdGggbm8gd2F5IG91dC5cbiAqIGBUQUlMX0lETEVfTVNgIGlzIERFUklWRUQgZnJvbSBnbGFtb3VyJ3Mgb3duIGhlYXJ0YmVhdCAoYC4vaGVhcnRiZWF0LnRzYCksXG4gKiBuZXZlciBjb3BpZWQgZnJvbSBhIHNpYmxpbmcg4oCUIGFzdHJvbGFiZSBtZWFzdXJlZCB3aGF0IGEgY29waWVkIG51bWJlciBjb3N0cy5cbiAqXG4gKiBUaGUgcGluLCB0aGUgZ3JvdW5kaW5nIGFuY2hvciBhbmQgdGhlIFwib3VyIHNlc3Npb24gd2VudCBhd2F5XCIgZXhpdCBhcmUgYWxsXG4gKiBwcmVzZXJ2ZWQgdmVyYmF0aW06IHRoZSBGSVJTVCByZXNvbHZlZCBzZXNzaW9uIGlzIHBpbm5lZCBmb3IgdGhlIGxpZmUgb2YgdGhlXG4gKiB3YXRjaCwgdGhlIGdyb3VuZGluZyBsaW5lIG5hbWVzIHRoYXQgYmluZGluZyBvbmNlLCBhbmQgYSBwb2ludGVyIHRoYXRcbiAqIGRpc2FwcGVhcnMgQUZURVIgd2Ugd2VyZSBib3VuZCBlbmRzIHRoZSB3YXRjaCBhdCAwIOKAlCBhIGNvbXBsZXRlZCB3YXRjaCwgbm90IGFcbiAqIGZhaWx1cmUuIEEgcG9pbnRlciB0aGF0IG5ldmVyIGFwcGVhcmVkIGtlZXBzIHJldHJ5aW5nLCB3aGljaCBpcyB3aGF0IGB0YWlsYCdzXG4gKiBvd24gaGVscCBwcm9taXNlcyAoXCJ3YWl0cyBmb3IgYSBzZXNzaW9uLCBuZXZlciBleGl0cyA1XCIpLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2VBcmc6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8eyBpZD86IG51bWJlcjsgdHlwZT86IHN0cmluZyB9Pih7XG4gICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgLy8gcmVhZFNlc3Npb24gZGllcyBvbiBhIENPUlJVUFQgcG9pbnRlciBhbmQgcmV0dXJucyBudWxsIG9ubHkgZm9yIGFcbiAgICAgIC8vIGdlbnVpbmVseSBhYnNlbnQgb25lIOKAlCB0aGUgRU5PRU5UIHJ1bGUuIFRoYXQgYGRpZWAgbm93IFRIUk9XUywgYW5kIHRoZVxuICAgICAgLy8gdGhyb3cgbGVhdmVzIHRoZSB0YWlsIHRocm91Z2ggbWFpbidzIGZ1bm5lbCBpbnN0ZWFkIG9mIGV4aXRpbmcgZnJvbSB0aHJlZVxuICAgICAgLy8gZnJhbWVzIGRvd24gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AuIEl0IGlzIEQ4J3MgYXVkaXQgcGF5aW5nIGZvciBpdHNlbGY6XG4gICAgICAvLyB0aGlzIGlzIHRoZSBvbmUgZGllLXJlYWNoYWJsZSBjYWxsIHRoZSBzaGFyZWQgY2xpZW50IGludm9rZXMgb24gYSBzY2hlZHVsZS5cbiAgICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICAgIGlmICghcykgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIWJvdW5kSWQpIGJvdW5kSWQgPSBzLnNlc3Npb25faWQ7IC8vIHBpbiB0byB0aGUgZmlyc3Qgc2Vzc2lvbiB3ZSByZXNvbHZlZFxuICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgIC8vIGdyb3VuZGluZyBsaW5lIOKAlCBwYXJzZWFibGUgaW4gTW9uaXRvciwgbmFtZXMgdGhlIGJpbmRpbmcgc28gYSB3cm9uZ1xuICAgICAgICAvLyBzZXNzaW9uL3BvcnQgaXMgb2J2aW91cyBpbnN0ZWFkIG9mIHNpbGVudC5cbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgfSxcbiAgICBvblVucmVzb2x2ZWQ6ICh7IGV2ZXJSZXNvbHZlZCB9KSA9PiB7XG4gICAgICBpZiAoZXZlclJlc29sdmVkKSByZXR1cm4gXCJzdG9wXCI7IC8vIG91ciBwaW5uZWQgc2Vzc2lvbiB3ZW50IGF3YXkg4oaSIGRvbmVcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgIH0sXG4gICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgc2luY2U6IHNpbmNlQXJnLFxuICAgIGN1cnNvck9mOiAoZXYpID0+IGV2LmlkLFxuICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgb25Db21tZW50OiAoKSA9PiBcIjogZ2xhbW91ci1rZWVwYWxpdmVcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNtZEluZm8oc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBnbGFtb3VyIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyIChhc3Ryb2xhYmUncyBwYXR0ZXJuLCB2aWEgbWluZC1tYXBwZXIpLiBMYXlvdXQtZGVwZW5kZW50LFxuLy8gc28gYWJzZW5jZSBkZWdyYWRlcyB0byBcInVua25vd25cIiBpbnN0ZWFkIG9mIGludmVudGluZyBvbmUuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKFNLSUxMX1JPT1QsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIiksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwiZ2xhbW91clwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggdG8gdW5rbm93biAqL1xuICB9XG4gIHJldHVybiB7IG5hbWU6IFwiZ2xhbW91clwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vLyDilIDilIAgVEhFIENPTU1BTkQgVEFCTEUsIEFTIEEgU1RSVUNUVVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIFRoZSBkaXNwYXRjaGVyLCB0aGUgc3RhZ2UtMiBmbGFnIGNoZWNrLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCB0aGVcbi8vIGhlbHAgdGV4dCBhbmQgdGhlIGBzY2hlbWFgIGRlY2xhcmF0aW9uIGFsbCB3YWxrIFRISVMuIEl0IHJlcGxhY2VkIGEgYmFyZVxuLy8gYHN3aXRjaGAsIHdoaWNoIG9ubHkgdGhlIGRpc3BhdGNoZXIgY291bGQgd2FsayDigJQgaGVscCBhbmQgdGhlIHN3aXRjaCBoYWRcbi8vIGFscmVhZHkgZHJpZnRlZCBvbmNlICh0aGUgYG9wZW5gIHJvdyBsb3N0IC0tc3RhcnQtdGltZW91dCkg4oCUIGFuZCBhIHNjaGVtYVxuLy8gZW1pdHRlZCBmcm9tIGFueXRoaW5nIG90aGVyIHRoYW4gdGhlIHN0cnVjdHVyZSB0aGF0IHJvdXRlcyB0aGUgYmVoYXZpb3VyXG4vLyBpcyBhIGRvY3VtZW50IHRoYXQgbGllcyBhcyBzb29uIGFzIGFueW9uZSBlZGl0cyB0aGUgb3RoZXIgc2lkZS5cbi8vXG4vLyBgZmxhZ3NgIGlzIHRoZSB2ZXJiJ3MgT1dOIGFjY2VwdGVkIHNldCwgdHlwZWQgYWdhaW5zdCB0aGUgcmVnaXN0cnksIHNvIGFcbi8vIHZlcmIgY2Fubm90IG5hbWUgYSBmbGFnIHRoZSBwYXJzZXIgZG9lcyBub3QgZGVmaW5lLiBgc2Vzc2lvbmAgaXMgbGlzdGVkXG4vLyBwZXIgdmVyYiByYXRoZXIgdGhhbiBtZXJnZWQgYXMgYSBnbG9iYWw6IGBvcGVuYCBzcGF3bnMgYSBzZXNzaW9uIGluc3RlYWQgb2Zcbi8vIHRhcmdldGluZyBvbmUsIGFuZCBgaGVscGAgdGFrZXMgbm90aGluZy5cbnR5cGUgRmxhZyA9IGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUztcbnR5cGUgRmxhZ3MgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbnR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xudHlwZSBDb21tYW5kU3BlYyA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBmbGFnczogcmVhZG9ubHkgRmxhZ1tdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgLy8gVGhlIG9uZS1saW5lIGRlc2NyaXB0aW9uIGhlbHAgcHJpbnRzIGJlc2lkZSB0aGUgdXNhZ2UuXG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8vIOKblCBBIFZFUkIgTUFZIFJFVFVSTiBBTiBFWElUIENPREUsIGFuZCBleGFjdGx5IG9uZSBkb2VzLiBgdGFpbGAgaXMgYSBXQVRDSDpcbiAgLy8gaXQgZW5kcyB3aGVuIHRoZSBkYWVtb24gc2F5cyBgY2xvc2VkYCwgd2hlbiBpdHMgcGlubmVkIHNlc3Npb24gZ29lcyBhd2F5LCBvclxuICAvLyB3aGVuIGEgc2lnbmFsIGFycml2ZXMsIGFuZCB0aGUgc2hhcmVkIGNsaWVudCAoYGtpdC93aXJlL3RhaWxFdmVudHMudHNgKVxuICAvLyBSRVRVUk5TIHRoYXQgY29kZSByYXRoZXIgdGhhbiBjYWxsaW5nIGBwcm9jZXNzLmV4aXRgIGZyb20gaW5zaWRlIGl0cyBvd25cbiAgLy8gbG9vcCDigJQgd2hpY2ggaXMgdGhlIHdob2xlIG9mIHRoZSBQMGYgZHJhaW4gc2Nhci4gYHZvaWRgIHRoZXJlZm9yZSBoYXMgdG8gbWVhblxuICAvLyBcIjBcIiwgbm90IFwibm8gb3BpbmlvblwiOiBkaXNwYXRjaCBjb2VyY2VzIGJlbG93LCBzbyBldmVyeSBvdGhlciByb3cgaXNcbiAgLy8gdW5jaGFuZ2VkIGFuZCBvbmx5IHRoZSB2ZXJiIHRoYXQgaGFzIGEgY29kZSBoYXMgdG8gc2F5IHNvLlxuICBydW46IChcbiAgICBwb3M6IHN0cmluZ1tdLFxuICAgIGZsYWdzOiBGbGFncyxcbiAgICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICkgPT4gUHJvbWlzZTxudW1iZXIgfCB1bmRlZmluZWQ+IHwgbnVtYmVyIHwgdW5kZWZpbmVkO1xufTtcblxuY29uc3QgU0VTU0lPTiA9IFtcInNlc3Npb25cIl0gYXMgY29uc3Qgc2F0aXNmaWVzIHJlYWRvbmx5IEZsYWdbXTtcbmNvbnN0IFAgPSB7XG4gIHRleHQ6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gIGlkOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICBpZFRleHQ6IFtcbiAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgXSxcbiAgaWRzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgbm9uZTogW10gYXMgUG9zaXRpb25hbFNwZWNbXSxcbn0gc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIFBvc2l0aW9uYWxTcGVjW10+O1xuXG5jb25zdCBDT01NQU5EUzogQ29tbWFuZFNwZWNbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJ0aXRsZVwiLCBcImludGVudFwiLCBcIm5vLW9wZW5cIiwgXCJ0aW1lb3V0XCIsIFwic3RhcnQtdGltZW91dFwiLCBcInJlc3RvcmVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKTsgcHJpbnRzIHt1cmwsIHBvcnQsIHNlc3Npb25faWR9XCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MpID0+IGNtZE9wZW4oZmxhZ3MpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInNpbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwiU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3I7IHdhaXRzIGZvciBhIHNlc3Npb24sIG5ldmVyIGV4aXRzIDUpXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBjbWRUYWlsKHNlc3Npb24sIHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUludChmbGFncy5zaW5jZSwgMTApIDogLTEpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJmdWxsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwibGVhbiBzdGF0ZSBzbmFwc2hvdCAoLS1mdWxsIGZvciByYXcgaW5jbC4gYmFzZTY0KVwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBjbWRTdGF0ZShzZXNzaW9uLCBmbGFncy5mdWxsID09PSB0cnVlKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW50ZW50XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAudGV4dCxcbiAgICBkZXNjcmliZTogXCJ1cGRhdGUgdGhlIHNlc3Npb24gaW50ZW50XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImludGVudFwiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFubm90YXRlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAuaWRUZXh0LFxuICAgIGRlc2NyaWJlOiBcIndyaXRlIGFnZW50IGFubm90YXRpb24gb250byBhIGxpYnJhcnkgaXRlbVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBbaWQsIC4uLndvcmRzXSA9IHBvcztcbiAgICAgIHJldHVybiBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJpdGVtLmFubm90YXRlXCIsIGlkLCBhZ2VudDogd29yZHMuam9pbihcIiBcIikgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2F5XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImtpbmRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAudGV4dCxcbiAgICBkZXNjcmliZTogXCJwb3N0IGFnZW50IGRpYWxvZ3VlIGludG8gdGhlIGNvbnZlcnNhdGlvbiAoLS1raW5kIGluZm98d29ya2luZ3xyZXN1bHR8ZXJyb3IpXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCBidWlsZFNheUNtZChwb3MsIGZsYWdzKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlY3Rpb25cIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RhdHVzXCIsIFwiY29udGVudFwiLCBcInByb21wdHNcIiwgXCJjb2xvcnNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwia2V5XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiAnc2hhcGUgYSBzdHlsZS1ndWlkZSBzZWN0aW9uICgtLXByb21wdHMgYXx8YjsgLS1jb2xvcnMgXCIjaGV4Ok5hbWV8fCNoZXg6TmFtZVwiKScsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCBidWlsZFNlY3Rpb25DbWQocG9zLCBmbGFncykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0dXNcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm9ufG9mZlwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwic2hvdy9oaWRlIHRoZSB3b3JraW5nIHNwaW5uZXJcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3Qgb24gPSBwb3NbMF0gPT09IFwib25cIjtcbiAgICAgIGNvbnN0IHRleHQgPSBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikgfHwgdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInN0YXR1c1wiLCBidXN5OiBvbiwgLi4uKHRleHQgPyB7IHRleHQgfSA6IHt9KSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJnZW5cIixcbiAgICBmbGFnczogW1xuICAgICAgLi4uU0VTU0lPTixcbiAgICAgIFwidXJsXCIsXG4gICAgICBcImZpbGVcIixcbiAgICAgIFwic3JjXCIsXG4gICAgICBcInByb21wdFwiLFxuICAgICAgXCJtb2RlbFwiLFxuICAgICAgXCJyb3VuZFwiLFxuICAgICAgXCJzZWVkXCIsXG4gICAgICBcImNvc3RcIixcbiAgICAgIFwibGFiZWxcIixcbiAgICAgIFwiY3VzdG9tXCIsXG4gICAgXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJwb3N0IGEgZ2VuZXJhdGVkIGltYWdlIChvbmUgb2YgLS11cmx8LS1maWxlfC0tc3JjLCBhbmQgLS1wcm9tcHQgLS1tb2RlbCAtLXJvdW5kIHJlcXVpcmVkKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICAvLyDim5QgYGNob2ljZXNgIE5BTUVTIFdIQVQgSVMgTUlTU0lORywgRklMVEVSRUQgRlJPTSBUSEUgUkVRVUlSRUQgU0VUIOKAlFxuICAgICAgLy8gc28gdGhlIHNldCB0aGUgbWVzc2FnZSBhc3NlcnRzIGFuZCB0aGUgc2V0IHRoZSBjaGVjayBlbmZvcmNlcyBjYW5ub3RcbiAgICAgIC8vIGJlIHR3byBsaXN0cy4gYGdlbiAtLXByb21wdCBwIC0tbW9kZWwgbWAgYW5zd2VycyBgW1wiLS1yb3VuZFwiXWAsIHdoaWNoXG4gICAgICAvLyBpcyBvbmUgcmVwYWlyIHJhdGhlciB0aGFuIHRocmVlIHRvIHJlLXJlYWQuXG4gICAgICBjb25zdCBtaXNzaW5nR2VuID0gR0VOX1JFUVVJUkVEX0ZMQUdTLmZpbHRlcigoaykgPT4gIWZsYWdzW2tdKS5tYXAoKGspID0+IGAtLSR7a31gKTtcbiAgICAgIGlmIChtaXNzaW5nR2VuLmxlbmd0aCA+IDApXG4gICAgICAgIGRpZShgdXNhZ2U6ICR7dXNhZ2VPZihmaW5kQ29tbWFuZChcImdlblwiKSBhcyBDb21tYW5kU3BlYyl9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgaGludDogYG1pc3NpbmcgcmVxdWlyZWQgJHttaXNzaW5nR2VuLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgICAgY2hvaWNlczogbWlzc2luZ0dlbixcbiAgICAgICAgfSk7XG4gICAgICBjb25zdCBzcmMgPSBhd2FpdCByZXNvbHZlR2VuU3JjKGZsYWdzKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRHZW5DbWQoc3JjLCBmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdlbi1jb3N0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImNvc3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAuaWQsXG4gICAgZGVzY3JpYmU6IFwiYmFja2ZpbGwgYSBnZW5lcmF0ZWQgaW1hZ2UncyBjb3N0ICgtLWNvc3QgPG4+IHJlcXVpcmVkKVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGNvc3QgPSB0eXBlb2YgZmxhZ3MuY29zdCA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUZsb2F0KGZsYWdzLmNvc3QpIDogTnVtYmVyLk5hTjtcbiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGNvc3QpKVxuICAgICAgICBkaWUoYHVzYWdlOiAke3VzYWdlT2YoZmluZENvbW1hbmQoXCJnZW4tY29zdFwiKSBhcyBDb21tYW5kU3BlYyl9IOKAlCAtLWNvc3QgbXVzdCBiZSBhIG51bWJlcmApO1xuICAgICAgcmV0dXJuIHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRHZW5Db3N0Q21kKHBvcywgZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJnZW4tbWV0YVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJwcm9tcHRcIiwgXCJjdXN0b21cIl0sXG4gICAgcG9zaXRpb25hbHM6IFAuaWQsXG4gICAgZGVzY3JpYmU6IFwiYmFja2ZpbGwgdGhlIHJlYWwgcHJvbXB0IC8gcmVmcyBvbnRvIGEgZ2VuICgtLXByb21wdCBhbmQvb3IgLS1jdXN0b20pXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgLy8gQSBESVNKVU5DVElPTiwgc28gYGNob2ljZXNgIGlzIHRoZSB3aG9sZSBzZXQgcmF0aGVyIHRoYW4gdGhlIG1pc3NpbmdcbiAgICAgIC8vIGhhbGY6IGVpdGhlciBvbmUgc2F0aXNmaWVzIHRoaXMsIGFuZCB0aGUgY2FsbGVyIHBpY2tzLlxuICAgICAgaWYgKCFHRU5fTUVUQV9GTEFHUy5zb21lKChrKSA9PiBmbGFnc1trXSAhPT0gdW5kZWZpbmVkKSlcbiAgICAgICAgZGllKGB1c2FnZTogJHt1c2FnZU9mKGZpbmRDb21tYW5kKFwiZ2VuLW1ldGFcIikgYXMgQ29tbWFuZFNwZWMpfWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGhpbnQ6IGBnaXZlIG9uZSBvZiAke0dFTl9NRVRBX0ZMQUdTLm1hcCgoaykgPT4gYC0tJHtrfWApLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgICAgY2hvaWNlczogR0VOX01FVEFfRkxBR1MubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgICAgIH0pO1xuICAgICAgcmV0dXJuIHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRHZW5NZXRhQ21kKHBvcywgZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmb2N1c1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkcyxcbiAgICBkZXNjcmliZTogXCJzY29wZSB0aGUgZm9jdXMgbGVucyB0byB0aGVzZSBpdGVtcyAoKyAtLW5vdGUgdG8gYXNrKVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRGb2N1c0NtZChwb3MsIGZsYWdzKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0eWxlLXNhdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJsYWJlbFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29kaWZ5IHRoZSBjdXJyZW50IHN0eWxlIOKGkiBwcm9qZWN0IHRyYXlcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCBidWlsZFN0eWxlU2F2ZUNtZChwb3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3R5bGUtYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ1bmFyY2hpdmVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAuaWQsXG4gICAgZGVzY3JpYmU6IFwiYXJjaGl2ZSAob3IgLS11bmFyY2hpdmUpIGEgc2F2ZWQgc3R5bGVcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU3R5bGVBcmNoaXZlQ21kKHBvcywgZmxhZ3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidHJheVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwibGlzdCB0aGUgcHJvamVjdCdzIHNhdmVkIHN0eWxlc1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICAgICAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlP2xlYW49MVwiKTtcbiAgICAgIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcInRyYXlcIiwgc3RhdHVzLCBkYXRhKTtcbiAgICAgIHByaW50SnNvbigoZGF0YSBhcyB7IHN0YXRlPzogeyB0cmF5PzogdW5rbm93bltdIH0gfSk/LnN0YXRlPy50cmF5ID8/IFtdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwic2h1dCBkb3duIHRoZSBzZXNzaW9uXCIsXG4gICAgcnVuOiAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbmZvXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJwcmludCB0aGUgcmVzb2x2ZWQgZGlzY292ZXJ5IEpTT05cIixcbiAgICBydW46IChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZEluZm8oc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcImVtaXQgdGhpcyBDTEkncyBhY2MgZGVjbGFyYXRpb24gKHdhbGtlZCBmcm9tIHRoZSBjb21tYW5kIHRhYmxlKVwiLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoYnVpbGREZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJoZWxwXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwic2hvdyB0aGlzIG1lc3NhZ2VcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICB9LFxuICB9LFxuXTtcblxuLy8gUm9vdCBpbnRlcmNlcHRvcnMg4oCUIHRva2VucyB0aGUgUk9PVCBhbnN3ZXJzIGl0c2VsZiwgYmVmb3JlIGFueSB2ZXJiLiBOb3Rcbi8vIGNvbW1hbmRzIGFuZCBub3QgcmVnaXN0cnkgZmxhZ3MsIHNvIHRoZXkgYXJlIGRlY2xhcmVkIGV4cGxpY2l0bHkgYXRcbi8vIHBhdGggW10gcmF0aGVyIHRoYW4gd2Fsa2VkIHBhc3QuXG5jb25zdCBST09UX0lOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbmNvbnN0IGZpbmRDb21tYW5kID0gKHRva2VuOiBzdHJpbmcpOiBDb21tYW5kU3BlYyB8IHVuZGVmaW5lZCA9PlxuICBDT01NQU5EUy5maW5kKChjKSA9PiBjLm5hbWUgPT09IHRva2VuKTtcblxuLy8gVGhlIHZlcmIgdG9rZW4gaW4gYSByYXcgYXJndiwgZm91bmQgdGhlIHdheSB0aGUgcGFyc2VyIHdpbGwgZmluZCBpdDogYVxuLy8gc3RyaW5nIGZsYWcgQ09OU1VNRVMgdGhlIG5leHQgdG9rZW4gKGAtLXNlc3Npb24gYWJjIHNheWAg4oaSIFwic2F5XCIsIG5vdFxuLy8gXCJhYmNcIiksIGAtLWtleT12YWx1ZWAgY29uc3VtZXMgbm90aGluZywgYSBiYXJlIGAtLWAgZW5kcyBmbGFnIHBhcnNpbmcsIGFuZFxuLy8gdGhlIGZpcnN0IHRva2VuIGxlZnQgc3RhbmRpbmcgaXMgdGhlIHZlcmIuIFVzZWQgb25seSB0byBuYW1lIHRoZSB2ZXJiIG9uIGFcbi8vIHJlamVjdGlvbiByYWlzZWQgQkVGT1JFIHRoZSBwYXJzZSBzdWNjZWVkcyAoYSBzdHJheSBmbGFnKSDigJQgdGhlIHBhcnNlJ3Mgb3duXG4vLyBwb3NpdGlvbmFscyBhcmUgdGhlIHRydXRoIGFmdGVyd2FyZHMuIEEgbmFpdmUgXCJmaXJzdCBub24tZGFzaCB0b2tlblwiIHdhc1xuLy8gdGhlIHJldmlldydzIGZpbmRpbmc6IGl0IG5hbWVkIGEgZmxhZydzIHZhbHVlIGFzIHRoZSB2ZXJiLlxuZXhwb3J0IGZ1bmN0aW9uIHZlcmJUb2tlbihhcmd2OiBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIGFyZ3ZbaSArIDFdID8/IG51bGw7XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qga2V5ID0gYS5zbGljZSgyKSBhcyBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG4gICAgICBpZiAoa2V5IGluIENMSV9PUFRJT05TICYmIENMSV9PUFRJT05TW2tleV0udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpKSBjb250aW51ZTtcbiAgICByZXR1cm4gYTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLy8gVGhlIGRlcml2ZWQgdmlld3MgdGhlIHRlc3RzIGFuZCB0aGUgcmVqZWN0aW9ucyByZWFkLiBWRVJCUyBpcyB0aGUgcm9zdGVyO1xuLy8gVkVSQl9TUEVDIGlzIGVhY2ggdmVyYidzIGFjY2VwdGVkIGZsYWdzOyBmbGFnc0ZvciByZW5kZXJzIG9uZSByb3cgYXMgdGhlXG4vLyBgY2hvaWNlc2AgYSByZWplY3Rpb24gY2Fycmllcy5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBDT01NQU5EUy5tYXAoKGMpID0+IGMubmFtZSk7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBGbGFnW10+ID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBDT01NQU5EUy5tYXAoKGMpID0+IFtjLm5hbWUsIGMuZmxhZ3NdKSxcbik7XG5leHBvcnQgY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgWy4uLihmaW5kQ29tbWFuZCh2ZXJiKT8uZmxhZ3MgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbi8vIOKUgOKUgCBoZWxwIGFuZCB0aGUgZGVjbGFyYXRpb24sIGJvdGggd2Fsa2VkIGZyb20gQ09NTUFORFMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmNvbnN0IHJlbmRlckZsYWcgPSAoazogRmxhZyk6IHN0cmluZyA9PlxuICBDTElfT1BUSU9OU1trXS50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuXG5jb25zdCByZW5kZXJQb3NpdGlvbmFsID0gKHA6IFBvc2l0aW9uYWxTcGVjKTogc3RyaW5nID0+IHtcbiAgY29uc3QgaW5uZXIgPSBwLnZhcmlhZGljID8gYCR7cC5uYW1lfS4uLmAgOiBwLm5hbWU7XG4gIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xufTtcblxuLy8gVGhlIHVzYWdlIGxpbmU6IHZlcmIsIHBvc2l0aW9uYWxzLCB0aGVuIHRoZSB2ZXJiJ3Mgb3duIGZsYWdzIChzZXNzaW9uIGlzXG4vLyByZW5kZXJlZCBvbmNlIGluIHRoZSBmb290ZXIsIG5vdCBvbiBldmVyeSByb3cpLlxuZXhwb3J0IGZ1bmN0aW9uIHVzYWdlT2Yoc3BlYzogQ29tbWFuZFNwZWMpOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0cyA9IFtcbiAgICBzcGVjLm5hbWUsXG4gICAgLi4uc3BlYy5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgLi4uc3BlYy5mbGFncy5maWx0ZXIoKGspID0+IGsgIT09IFwic2Vzc2lvblwiKS5tYXAocmVuZGVyRmxhZyksXG4gIF07XG4gIHJldHVybiBwYXJ0cy5qb2luKFwiIFwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckhlbHAoKTogc3RyaW5nIHtcbiAgY29uc3Qgcm93cyA9IENPTU1BTkRTLm1hcCgoYykgPT4gW3VzYWdlT2YoYyksIGMuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihNYXRoLm1heCguLi5yb3dzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gIGNvbnN0IGJvZHkgPSByb3dzXG4gICAgLm1hcCgoW3VzYWdlLCBkZXNjcmliZV0pID0+XG4gICAgICB1c2FnZS5sZW5ndGggPD0gd2lkdGhcbiAgICAgICAgPyBgICAke3VzYWdlLnBhZEVuZCh3aWR0aCl9ICAke2Rlc2NyaWJlfWBcbiAgICAgICAgOiBgICAke3VzYWdlfVxcbiAgJHtcIlwiLnBhZEVuZCh3aWR0aCl9ICAke2Rlc2NyaWJlfWAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYGdsYW1vdXIg4oCUIGEgZ3JvdW5kZWQgdmlzdWFsIGNvbnZlcnNhdGlvbiBzdXJmYWNlLlxuXG4ke2JvZHl9XG4gICR7Uk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLmpvaW4oXCIgfCBcIil9ICByb290IHRva2VuczogaGVscCwgb3Ige25hbWUsIHZlcnNpb259IGFzIEpTT05cblxuICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gYW55IHZlcmIgdGhhdCB0YWxrcyB0byBhIHNlc3Npb24gKGRlZmF1bHQ6IG1vc3QgcmVjZW50KS5cbiAgRWFjaCB2ZXJiIGFjY2VwdHMgb25seSB0aGUgZmxhZ3Mgb24gaXRzIHJvdzsgYSByZWNvZ25pemVkIGZsYWcgb24gdGhlIHdyb25nXG4gIHZlcmIgaXMgcmVmdXNlZCwgYW5kIHRoZSByZWplY3Rpb24gbGlzdHMgdGhlIHZlcmIncyBvd24gZmxhZ3MuXG5cbiAgT3V0cHV0OiBldmVyeSB2ZXJiIHByaW50cyBKU09OIG9uIHN0ZG91dCBieSBkZWZhdWx0LCBvbmUgZG9jdW1lbnQgcGVyIGFuc3dlciDigJRcbiAgZXhjZXB0IHRhaWwsIGEgc3RyZWFtIHRoYXQgcHJpbnRzIG9uZSBKU09OIGxpbmUgcGVyIGV2ZW50LCBhbmQgaGVscCwgd2hpY2ggaXNcbiAgcHJvc2UuIEZhaWx1cmVzIGFyZSBvbmUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSxcbiAgMSA9IGludGVybmFsLCA1ID0gbm90IGZvdW5kLCA2ID0gY29uZmxpY3QpIOKAlCBleGNlcHQgdGFpbCwgd2hpY2ggd2FpdHMgZm9yIGFcbiAgc2Vzc2lvbiBpbnN0ZWFkIG9mIGZhaWxpbmcgYW5kIHdyaXRlcyBpdHMgcmV0cnkva2VlcGFsaXZlIG5vdGVzIHRvIHN0ZGVyciBhc1xuICAnIyctcHJlZml4ZWQgcHJvc2UuYDtcbn1cblxuLy8gYWNjIGRlY2xhcmF0aW9uIGZvcm1hdCB2MCwgZ2VuZXJhdGVkIGJ5IFdBTEtJTkcgQ09NTUFORFMgYW5kIENMSV9PUFRJT05TIOKAlFxuLy8gdGhlIHNhbWUgc3RydWN0dXJlcyB0aGUgcGFyc2VyIGFuZCBkaXNwYXRjaGVyIGNvbnN1bWUg4oCUIGF0IGFuc3dlciB0aW1lLCBzb1xuLy8gYHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiYCBpcyB0cnVlIHJhdGhlciB0aGFuIGNsYWltZWQuIFBpcGVzIHN0cmFpZ2h0IGludG9cbi8vIGBhY2MgY2hlY2sgPGNsaS50cz4gLS1kZWNsYXJhdGlvbiA8KGNsaS50cyBzY2hlbWEpYC5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERlY2xhcmF0aW9uKCkge1xuICAvLyBFdmVyeSByZWdpc3RyeSBmbGFnIGlzIGFjY2VwdGVkIHRvZGF5OyBhIHJlZnVzYWwgbGlzdCB3b3VsZCBhZGRcbiAgLy8gc3RhdHVzOiBcInJlZnVzZWRcIiBlbnRyaWVzIGhlcmUgdGhlIGRheSBhIHZlcmIgcmVjb2duaXNlcy1hbmQtZGVjbGluZXMgb25lLlxuICBjb25zdCBhcmcgPSAoazogRmxhZykgPT4gKHsgbmFtZTogYC0tJHtrfWAsIHR5cGU6IENMSV9PUFRJT05TW2tdLnR5cGUsIHN0YXR1czogXCJ2YWxpZFwiIH0pO1xuICBjb25zdCBjb21tYW5kczoge1xuICAgIHBhdGg6IHN0cmluZ1tdO1xuICAgIGFyZ3M6IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBcInN0cmluZ1wiIHwgXCJib29sZWFuXCI7IHN0YXR1czogc3RyaW5nIH1bXTtcbiAgICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgfVtdID0gW1xuICAgIHtcbiAgICAgIC8vIHBhdGggW10gSVMgdGhlIHJvb3Q6IG9uZSByZXF1aXJlZCB0b2tlbiBzZWxlY3RpbmcgYSB2ZXJiLCBvciBhblxuICAgICAgLy8gaW50ZXJjZXB0b3IgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuXG4gICAgICBwYXRoOiBbXSxcbiAgICAgIGFyZ3M6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgICB9KSksXG4gICAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ2ZXJiXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIH0sXG4gICAgLi4uQ09NTUFORFMubWFwKChjKSA9PiAoe1xuICAgICAgcGF0aDogW2MubmFtZV0sXG4gICAgICBhcmdzOiBbLi4uYy5mbGFnc10ubWFwKGFyZyksXG4gICAgICBwb3NpdGlvbmFsczogYy5wb3NpdGlvbmFscyxcbiAgICB9KSksXG4gIF07XG4gIHJldHVybiB7XG4gICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtcInNjaGVtYVwiXSB9LFxuICAgIGNvbW1hbmRzLFxuICB9O1xufVxuXG4vLyBFdmVyeSBmYWlsdXJlIGZ1bm5lbHMgdGhyb3VnaCBoZXJlIGFuZCBSRVRVUk5TIGl0cyBjb2RlLCBzbyB0aGUgcnVudGltZVxuLy8gZHJhaW5zIHN0ZG91dC4gVW5jYXVnaHQsIGEgZmFpbHVyZSB3b3VsZCBzdXJmYWNlIGFzIGEgcmF3IHN0YWNrIHRyYWNlIGF0IGV4aXRcbi8vIDEsIHdoaWNoIGlzIG5vdCBhIHVzYWdlIGVycm9yIHRvIGFueW9uZSByZWFkaW5nIGl0LlxuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gVGhlIGhvdXNlIGZ1bm5lbDogYHJlcG9ydENsaUVycm9yYCB3cml0ZXMgdGhlIGVudmVsb3BlIGFuZCBoYW5kcyBiYWNrIHRoZVxuICAgIC8vIHRheG9ub215IGV4aXQgY29kZSwgb3IgYG51bGxgIHdoZW4gdGhlIHRocm93IHdhcyBub3QgYSBDbGlFcnJvci5cbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZSAoLS1maWxlIHBhdGhzKSDigJQgdGhlIGNhbGxlcidzLlxuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IFVzYWdlRXJyb3IobXNnKSkgPz8gMjtcbiAgICAvLyBFdmVyeXRoaW5nIGVsc2UgaXMgZ2xhbW91cidzIG93biBmYXVsdDogb25lIElOVEVSTkFMIGVudmVsb3BlLCBuZXZlciBhXG4gICAgLy8gc3RhY2sgdHJhY2Ug4oCUIHRoZSBwcm9jZXNzIGNvbnRyYWN0IGlzIEpTT04gb24gc3RkZXJyIGZvciBFVkVSWSBmYWlsdXJlLlxuICAgIHJldHVybiByZXBvcnRDbGlFcnJvcihuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBtc2cpKSA/PyAxO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgLy8gUk9PVCBJTlRFUkNFUFRPUlMgRklSU1QsIGJlZm9yZSBhbnkgZmxhZyBwYXJzaW5nIChtYWdwaWUvYXN0cm9sYWJlXG4gIC8vIHBhdHRlcm4pLiBUaGV5IGFyZSBub3QgY29tbWFuZHMgYW5kIG5vdCByZWdpc3RyeSBmbGFncyDigJQgYHN0YXRlIC0tdmVyc2lvbmBcbiAgLy8gc3RheXMgcmVmdXNlZCDigJQgd2hpY2ggaXMgd2h5IHRoZXkgYXJlIGRlY2xhcmVkIGV4cGxpY2l0bHkgYXQgcGF0aCBbXSBhbmRcbiAgLy8gd2h5IGEgZ2VuZXJhdG9yIHdhbGtpbmcgXCJ0aGUgY29tbWFuZHNcIiB3b3VsZCB3YWxrIHBhc3QgdGhlbS5cbiAgY29uc3QgaW50ZXJjZXB0b3IgPSBST09UX0lOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGFyZ3ZbMF0pO1xuICBpZiAoaW50ZXJjZXB0b3IgIT09IHVuZGVmaW5lZCB8fCBhcmd2WzBdID09PSBcInZlcnNpb25cIikge1xuICAgIGNvbnN0IHJ1bnMgPSBpbnRlcmNlcHRvcj8ucnVucyA/PyBcInZlcnNpb25cIjtcbiAgICBpZiAocnVucyA9PT0gXCJoZWxwXCIpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlckhlbHAoKX1cXG5gKTtcbiAgICBlbHNlIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHZlcnNpb25JbmZvKCkpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gVGhlIFdIT0xFIGFyZ3YgaXMgcGFyc2VkLCB2ZXJiIGluY2x1ZGVkLCBzbyBhIGJhcmUgYC0tYCBpcyBob25vdXJlZCBhdFxuICAvLyB0aGUgcm9vdCAoYWNjIEE2KTogYC0tIC0teGAgeWllbGRzIHRoZSBwb3NpdGlvbmFsIFwiLS14XCIsIHdoaWNoIGlzIHRoZW4gYW5cbiAgLy8gdW5rbm93biB2ZXJiIOKAlCBub3QgYW4gdW5rbm93biBvcHRpb24uXG4gIC8vIE5hbWUgdGhlIHZlcmIgQkVGT1JFIHBhcnNpbmcsIHNvIGEgcGFyc2VyIHJlamVjdGlvbidzIGVudmVsb3BlIHN0aWxsIHNheXNcbiAgLy8gd2hhdCB3YXMgYmVpbmcgcnVuLlxuICAvLyBUaGUgdmVyYiwgbmFtZWQgQkVGT1JFIHBhcnNpbmcsIHNvIGEgcGFyc2VyIHJlamVjdGlvbidzIGVudmVsb3BlIHN0aWxsIHNheXNcbiAgLy8gd2hhdCB3YXMgYmVpbmcgcnVuLiBJdCBsaXZlcyBpbiB0aGUga2l0IG5vdyDigJQgb25lIG1vZHVsZSBvd25zIHRoZSBlbnZlbG9wZSxcbiAgLy8gc28gaXQgb3ducyB0aGUgZmllbGQgdGhlIGVudmVsb3BlIHByaW50cy5cbiAgbGV0IGN1cnJlbnRDb21tYW5kID0gdmVyYlRva2VuKGFyZ3YpO1xuICBzZXRDdXJyZW50Q29tbWFuZChjdXJyZW50Q29tbWFuZCk7XG4gIGxldCBwYXJzZWQ6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz47XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gcGFyc2VBcmdzKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKCEoZSBpbnN0YW5jZW9mIFVzYWdlRXJyb3IpKSB0aHJvdyBlO1xuICAgIC8vIEFuIHVua25vd24gZmxhZydzIHJlamVjdGlvbiBuYW1lcyB0aGUgc2V0IEFUIFRISVMgUEFUSCwgbm90IHRoZSB3aG9sZVxuICAgIC8vIHJlZ2lzdHJ5OiB0aGUgdmVyYidzIG93biBmbGFncyB3aGVuIHRoZSB2ZXJiIGlzIG9uZSBvZiBvdXJzLCB0aGUgdmVyYlxuICAgIC8vIHJvc3RlciB3aGVuIHRoZXJlIGlzIG5vIHZlcmIgeWV0ICh0aGUgcm9vdCBhY2NlcHRzIG5vIGZsYWdzIG9mIGl0cyBvd24pLlxuICAgIC8vIFRoaXMgaXMgd2hhdCBhIHJlY29yZGVkLXN1cmZhY2UgY2Vuc3VzIHJlYWRzLCBwYXRoIGJ5IHBhdGguXG4gICAgY29uc3Qgc3BlYyA9IGN1cnJlbnRDb21tYW5kID09PSBudWxsID8gdW5kZWZpbmVkIDogZmluZENvbW1hbmQoY3VycmVudENvbW1hbmQpO1xuICAgIGlmIChzcGVjICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGUubWVzc2FnZSwgeyBoaW50OiBlLmV4dHJhPy5oaW50LCBjaG9pY2VzOiBmbGFnc0ZvcihzcGVjLm5hbWUpIH0pO1xuICAgIH1cbiAgICAvLyBBdCB0aGUgcm9vdCB0aGUgZmxhZ3MgdGhlIHRvb2wgYWNjZXB0cyBhcmUgdGhlIGludGVyY2VwdG9ycywgYW5kIHRoYXQgaXNcbiAgICAvLyB0aGUgc2V0IG5hbWVkIOKAlCB0aGUgc2FtZSBhcnJheSBgc2NoZW1hYCBkZWNsYXJlcyBhdCBwYXRoIFtdLCBzbyB0aGVcbiAgICAvLyByb290IGlzIGRpZmZhYmxlLiBUaGUgdmVyYiByb3N0ZXIgcmlkZXMgdGhlIGhpbnQ6IHRoZSBuZXh0IGFjdCBpcyBhIHZlcmIuXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZS5tZXNzYWdlLCB7XG4gICAgICBoaW50OiBgbm8gdmVyYiBnaXZlbiDigJQgdmVyYnM6ICR7VkVSQlMuam9pbihcIiBcIil9IChydW46IGNsaS50cyBoZWxwKWAsXG4gICAgICBjaG9pY2VzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSksXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgW3ZlcmIsIC4uLnBvc10gPSBwYXJzZWQucG9zO1xuICBjb25zdCBmbGFncyA9IHBhcnNlZC5mbGFncztcbiAgY3VycmVudENvbW1hbmQgPSB2ZXJiID8/IG51bGw7XG4gIHNldEN1cnJlbnRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcblxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBEMiksIGFuZCB0aGUgcmVqZWN0aW9uIG5hbWVzXG4gICAgLy8gdGhlIHJvc3RlciBzbyB0aGUgY2FsbGVyJ3MgbmV4dCBjb21tYW5kIGNhbiBiZSByaWdodC5cbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcIm5vIHZlcmIgZ2l2ZW5cIiwgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogWy4uLlZFUkJTXSB9KTtcbiAgfVxuICBjb25zdCBzcGVjID0gZmluZENvbW1hbmQodmVyYik7XG4gIGlmIChzcGVjID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihgdW5rbm93biB2ZXJiIFwiJHt2ZXJifVwiYCwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsXG4gICAgICBjaG9pY2VzOiBbLi4uVkVSQlNdLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gU3RhZ2UgMjogYSByZWNvZ25pemVkIGZsYWcgdGhpcyB2ZXJiIGRvZXMgbm90IHRha2Ug4oCUIE1JU1BMQUNFRCwgbm90XG4gIC8vIHVua25vd24uIEFuIGFnZW50IHRvbGQgYSByZWFsIGZsYWcgaXMgdW5rbm93biBnb2VzIGh1bnRpbmcgYSB0eXBvIGl0IGRpZFxuICAvLyBub3QgbWFrZS4gVGhlIHZlcmIgaXMgcmVzb2x2ZWQgZmlyc3QgYmVjYXVzZSB3aGljaCBmbGFncyBhcmUgbGVnYWwgaXMgYVxuICAvLyBxdWVzdGlvbiBhYm91dCB0aGUgdmVyYi5cbiAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQ8c3RyaW5nPihzcGVjLmZsYWdzKTtcbiAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyhmbGFncykuZmluZCgoaykgPT4gIWFsbG93ZWQuaGFzKGspKTtcbiAgaWYgKHN0cmF5ICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBhY2NlcHRlZCA9IGZsYWdzRm9yKHNwZWMubmFtZSk7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoXG4gICAgICBgLS0ke3N0cmF5fSBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgJHtzcGVjLm5hbWV9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgZ2xhbW91ciBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgYWNjZXB0ZWQubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogYWNjZXB0ZWQgfSA6IHsgaGludDogYCR7c3BlYy5uYW1lfSB0YWtlcyBubyBmbGFnc2AgfSxcbiAgICApO1xuICB9XG5cbiAgLy8gQXJpdHksIGVuZm9yY2VkIEZST00gVEhFIERFQ0xBUkVEIFNIQVBFOiB0aGUgdGFibGUncyBwb3NpdGlvbmFsIHNwZWMgaXNcbiAgLy8gd2hhdCBgc2NoZW1hYCBwdWJsaXNoZXMgYW5kIHdoYXQgaGVscCBwcmludHMsIHNvIGVuZm9yY2luZyBpdCBoZXJlIGtlZXBzXG4gIC8vIGJvdGggdHJ1ZSBieSBjb25zdHJ1Y3Rpb24uIEEgdmVyYidzIG93biBmaW5lciBjaGVja3MgKGEgbnVtZXJpYyAtLWNvc3QsXG4gIC8vIGEgcmVxdWlyZWQgZmxhZykgbGl2ZSBpbiBpdHMgaGFuZGxlciBhbmQgbmFtZSB0aGUgc2FtZSB1c2FnZSBsaW5lLlxuICBjb25zdCByZXF1aXJlZCA9IHNwZWMucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gIGNvbnN0IHZhcmlhZGljID0gc3BlYy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgaWYgKHBvcy5sZW5ndGggPCByZXF1aXJlZCB8fCAoIXZhcmlhZGljICYmIHBvcy5sZW5ndGggPiBzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aCkpIHtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihgdXNhZ2U6ICR7dXNhZ2VPZihzcGVjKX1gLCB7IGhpbnQ6IHNwZWMuZGVzY3JpYmUgfSk7XG4gIH1cblxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuICAvLyBgdm9pZGAgbWVhbnMgMCDigJQgYSB2ZXJiIHRoYXQgY29tcGxldGVkIGFuZCBoYWQgbm90aGluZyB0byBzYXkgYWJvdXQgdGhlIGV4aXQuXG4gIC8vIEEgbnVtYmVyIG1lYW5zIHRoZSB2ZXJiIE9XTlMgaXRzIGNvZGUsIHdoaWNoIHRvZGF5IGlzIGB0YWlsYCBhbmQgb25seSBgdGFpbGAuXG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBzcGVjLnJ1bihwb3MsIGZsYWdzLCBzZXNzaW9uKTtcbiAgcmV0dXJuIHR5cGVvZiBjb2RlID09PSBcIm51bWJlclwiID8gY29kZSA6IDA7XG59XG5cbi8qKlxuICogVGhlIENMSSdzIGVudHJ5LCBmb3IgdGhlIExBVU5DSEVSIGF0XG4gKiBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2NyaXB0cy9jbGkudHNgLlxuICpcbiAqIOKblCBgaW1wb3J0Lm1ldGEubWFpbmAgSVMgRkFMU0UgSU4gVEhFIEJVTkRMRSDigJQgYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieVxuICogdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gYW4gYGlmIChpbXBvcnQubWV0YS5tYWluKWBcbiAqIGJsb2NrIGhlcmUgd291bGQgbmV2ZXIgcnVuOiB0aGUgQ0xJIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kIGV4aXQgMCBmb3IgZXZlcnlcbiAqIHZlcmIuIFRoaXMgZXhwb3J0IGlzIHdoYXQgcmVwbGFjZXMgaXQuXG4gKlxuICog4puUIElUIFJFVFVSTlMgVEhFIENPREUgUkFUSEVSIFRIQU4gU0VUVElORyBJVC4gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4gKiByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZVxuICogKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAqIGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seVxuICogdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gZ2xhbW91cidzIGBzdGF0ZSAtLWZ1bGxgIHNoaXBzIGJhc2U2NCBwYXlsb2FkcyBmYXIgcGFzdCB0aGF0XG4gKiBib3VuZGFyeSwgc28gdGhpcyBpcyBub3QgdGhlb3JldGljYWwgaGVyZS4gUmVwcm9kdWNlZCwgZml4ZWQgYW5kIGdhdGVkIGluXG4gKiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS4gVGhlIGFzc2lnbm1lbnQgaGFwcGVucyBvbmNlLCBpbiB0aGUgbGF1bmNoZXIuXG4gKlxuICog4puUIEFORCBJVCBUQUtFUyBOTyBBUkdVTUVOVFM6IHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IFBBUlNFU1xuICogaXQuIEEgbGF1bmNoZXIgcmVhZGluZyBgcHJvY2Vzcy5hcmd2YCB3b3VsZCBtYXRjaCB0aGUgYXJnLXBhcnNpbmcgcHJlZGljYXRlIGluXG4gKiBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AgYW5kIHRoZSBmbGFnIHdhcmQgd291bGQganVkZ2UgdGhpcyBzcGVsbCdzXG4gKiBkb2N1bWVudGVkIGZsYWdzIGFnYWluc3QgYSBmaWxlIHRoYXQgcmVjb2duaXNlcyBub25lLlxuICpcbiAqIOKaoCBVTkxJS0UgVEhFIERBRU1PTiwgVEhFIFNPVVJDRSBLRUVQUyBOTyBTRUNPTkQgRU5UUlkgQU5EIE5FRURTIE5PTkUgKEQxMik6XG4gKiBgU0NSSVBUX0RJUmAncyBjb25zdW1lcnMgaGVyZSBhcmUgYWxsIGFuY2VzdG9yLXJlbGF0aXZlIGFuZCBjb3JyZWN0IGZyb20gZWl0aGVyXG4gKiBhZGRyZXNzLCBidXQgdGhlIHNvdXJjZSBoYXMgbm8gYGltcG9ydC5tZXRhLm1haW5gIGJsb2NrIGVpdGhlciwgc28gdGhlcmUgaXMgb25lXG4gKiBlbnRyeSBhbmQgaXQgaXMgdGhpcyBvbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogR2xhbW91cidzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoIGhhbHZlc1xuICogb2YgdGhlIHNwZWxsLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0uIEJlZm9yZSBQaGFzZSAyIHRoZSBoZWFydGJlYXQgd2FzIGEgTElURVJBTCBgMTUwMDBgXG4gKiBpbnNpZGUgYHNlcnZlci50c2AncyBgc3NlUmVzcG9uc2VgLCBhbmQgYGNsaS50c2AgaGFkIE5PIGNvcnJlc3BvbmRpbmcgbnVtYmVyXG4gKiBhdCBhbGwg4oCUIGl0cyB0YWlsIGxvb3Agc2ltcGx5IGJsb2NrZWQgb24gYHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHdoaWNoIGlzIHRoZVxuICogZmFpbHVyZSBgdGFpbEV2ZW50c2AncyB3YXRjaGRvZyBleGlzdHMgdG8gZW5kLiBOZWl0aGVyIGZpbGUgY291bGQgaW1wb3J0IHRoZVxuICogb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uIHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaCBpbnRvXG4gKiBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHMgYnV0IHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaFxuICogZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBHTEFNT1VSJ1MgT1dOIEhFQVJUQkVBVCwgTkVWRVIgQ09QSUVEXG4gKiBGUk9NIEEgU0lCTElORy4qKiBUaGlzIGlzIFBoYXNlIDFhJ3MgcnVsZSBhbmQgaXQgaXMgdGhlIHdob2xlIHJlYXNvbiB0aGUgZmlsZVxuICogZXhpc3RzIHJhdGhlciB0aGFuIGEgc2hhcmVkIGNvbnN0YW50IHNvbWV3aGVyZTogYXN0cm9sYWJlIGJlYXRzIGF0IDEwIHMgYW5kXG4gKiBtYWdwaWUgYXQgMTUgcywgc28gYSBoYXJkLWNvZGVkIHdhdGNoZG9nIGlzIGNvcnJlY3QgZm9yIGF0IG1vc3Qgb25lIG9mIHRoZW0uXG4gKiBBc3Ryb2xhYmUgbWVhc3VyZWQgd2hhdCBhIGNvcGllZCBudW1iZXIgZG9lcyDigJQgYSA0NSBzIHdhdGNoZG9nIGFnYWluc3QgYW5cbiAqIGVudi10dW5lZCBoZWFydGJlYXQgcHJvZHVjZWQgcmVjb25uZWN0cyBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbiwgaGFybWxlc3Mgb25seSBiZWNhdXNlIGFuIHVucmVsYXRlZCB0aGlyZFxuICogY29uc3RhbnQgYWJzb3JiZWQgdGhlIGNodXJuLiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb21cbiAqIHRoZSBiZWF0IGl0IGlzIHdhdGNoaW5nLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtLiBUaGlzIGlzIGdsYW1vdXIncyBvd24gbWVhc3VyZWQgdmFsdWUsIG5vdCBhbiBpbmhlcml0ZWQgb25lOlxuICogYHNlcnZlci50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgd2l0aCBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXQgQnVuJ3NcbiAqIGRlZmF1bHQgMTAgcyBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZSB0aGUgMTUgcyBrZWVwYWxpdmUgZXZlclxuICogZmlyZXMuIEdsYW1vdXIgZG9lcyBub3QgZW52LXR1bmUgaXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24ncyBjb25uZWN0aW9uIGxpZmV0aW1lXG4gKiBpcyBub3Qgc29tZXRoaW5nIGEgY2FsbGVyIGhhcyBldmVyIG5lZWRlZCB0byBzaG9ydGVuLlxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQsIGFuZCBnbGFtb3VyJ3Mgb3duIGxpdGVyYWwgYmVmb3JlIHRoaXMgZmlsZSBleGlzdGVkLiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqXG4gKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzLCBERVJJVkVELlxuICpcbiAqIOKaoCA0NSwwMDAgbXMgdG9kYXksIHdoaWNoIGlzIHRoZSBzYW1lIG51bWJlciBgY21kT3BlbmAncyBgLS1zdGFydC10aW1lb3V0YFxuICogZGVmYXVsdCBoYXBwZW5zIHRvIGJlLiBUaGV5IGFyZSBVTlJFTEFURUQg4oCUIG9uZSBib3VuZHMgYSBmaXJzdCBidW5kbGUgYnVpbGQsXG4gKiB0aGUgb3RoZXIgYm91bmRzIGEgc2lsZW50IHNvY2tldCDigJQgYW5kIHRoZSBjb2luY2lkZW5jZSBpcyBuYW1lZCBoZXJlIHNvIG5vYm9keVxuICogbGF0ZXIgXCJkZS1kdXBsaWNhdGVzXCIgdGhlbSBpbnRvIG9uZSBjb25zdGFudC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8vIEJyb3dzZXItc2FmZSBpbWFnZS1vcHRpbWl6YXRpb24gUE9MSUNZIChzaGFyZWQgYnkgdGhlIGJyb3dzZXIgZHJvcCBwYXRoIGFuZFxuLy8gdGhlIHNlcnZlciBwYXRoKS4gTm8gbmF0aXZlIGRlcHMg4oCUIHNhZmUgdG8gaW1wb3J0IGludG8gdGhlIFJlYWN0IGJ1bmRsZS5cbi8vIFRoZSBCdW4uSW1hZ2UgaW1wbGVtZW50YXRpb24gbGl2ZXMgaW4gaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXIudHMuXG5leHBvcnQgY29uc3QgT1BUSU1JWkUgPSB7IG1heERpbTogMTIwMCwgcXVhbGl0eTogMC44NSB9IGFzIGNvbnN0O1xuIiwKICAgICIvLyBTZXJ2ZXIvQ0xJLW9ubHk6IG5hdGl2ZSBCdW4uSW1hZ2UgZG93bnNjYWxlICsgd2VicC4gRG8gTk9UIGltcG9ydCBmcm9tIGJyb3dzZXJcbi8vIGNvZGUgKHRoZSBicm93c2VyIGRyb3AgcGF0aCB1c2VzIDxjYW52YXM+KS4gUmVxdWlyZXMgQnVuID49IDEuMy4xNC5cbmltcG9ydCB7IE9QVElNSVpFIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NoYXJlZC9pbWFnZU9wdGltaXplXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBvcHRpbWl6ZUltYWdlQnVmZmVyKFxuICBpbnB1dDogVWludDhBcnJheSxcbik6IFByb21pc2U8eyBkYXRhOiBVaW50OEFycmF5OyBtaW1lOiBcImltYWdlL3dlYnBcIiB9PiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGlucHV0KVxuICAgIC5yZXNpemUoT1BUSU1JWkUubWF4RGltLCBPUFRJTUlaRS5tYXhEaW0sIHtcbiAgICAgIGZpdDogXCJpbnNpZGVcIixcbiAgICAgIHdpdGhvdXRFbmxhcmdlbWVudDogdHJ1ZSxcbiAgICB9KVxuICAgIC53ZWJwKHsgcXVhbGl0eTogTWF0aC5yb3VuZChPUFRJTUlaRS5xdWFsaXR5ICogMTAwKSB9KVxuICAgIC5ieXRlcygpO1xuICByZXR1cm4geyBkYXRhOiBuZXcgVWludDhBcnJheShkYXRhKSwgbWltZTogXCJpbWFnZS93ZWJwXCIgfTtcbn1cblxuLy8gRGVjb2RlIGEgYmFzZTY0IGRhdGEtVVJMLCBvcHRpbWl6ZSB0aGUgcmFzdGVyLCByZS1lbmNvZGUgYXMgYSB3ZWJwIGRhdGEtVVJMLlxuLy8gVXNlZCBieSB0aGUgQ0xJIGBnZW5gIHZlcmIgKHRoZSBhZ2VudCBwb3N0cyBhIG1lZGlhLWZvcmdlIGltYWdlIHdpdGggbm9cbi8vIGJyb3dzZXIgPGNhbnZhcz4gYXZhaWxhYmxlKS4gVGhyb3dzIG9uIGEgbm9uLWJhc2U2NC1kYXRhLVVSTCBpbnB1dC5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBvcHRpbWl6ZUltYWdlRGF0YVVybChkYXRhVXJsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBtID0gL15kYXRhOihbXjssXSspO2Jhc2U2NCwoLiopJC9zLmV4ZWMoZGF0YVVybCk7XG4gIGlmICghbSkgdGhyb3cgbmV3IEVycm9yKFwib3B0aW1pemVJbWFnZURhdGFVcmw6IGV4cGVjdGVkIGEgYmFzZTY0IGRhdGEtVVJMXCIpO1xuICBjb25zdCBieXRlcyA9IFVpbnQ4QXJyYXkuZnJvbShhdG9iKG1bMl0pLCAoYykgPT4gYy5jaGFyQ29kZUF0KDApKTtcbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBvcHRpbWl6ZUltYWdlQnVmZmVyKGJ5dGVzKTtcbiAgbGV0IGJpbiA9IFwiXCI7XG4gIGZvciAoY29uc3QgYiBvZiBkYXRhKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgcmV0dXJuIGBkYXRhOmltYWdlL3dlYnA7YmFzZTY0LCR7YnRvYShiaW4pfWA7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBK0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0Esc0JBQVM7OztBQ2tCRixJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7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V0FBVztBQUFBLElBR3RCLE1BQU0sSUFBSSxXQUFXLGlCQUFpQixFQUFFLE1BQU0sb0JBQW9CLFNBQVMsQ0FBQyxHQUFHLEtBQUssRUFBRSxDQUFDO0FBQUEsRUFDekY7QUFBQSxFQUNBLE1BQU0sT0FBTyxZQUFZLElBQUk7QUFBQSxFQUM3QixJQUFJLFNBQVMsV0FBVztBQUFBLElBQ3RCLE1BQU0sSUFBSSxXQUFXLGlCQUFpQixTQUFTO0FBQUEsTUFDN0MsTUFBTTtBQUFBLE1BQ04sU0FBUyxDQUFDLEdBQUcsS0FBSztBQUFBLElBQ3BCLENBQUM7QUFBQSxFQUNIO0FBQUEsRUFNQSxNQUFNLFVBQVUsSUFBSSxJQUFZLEtBQUssS0FBSztBQUFBLEVBQzFDLE1BQU0sUUFBUSxPQUFPLEtBQUssS0FBSyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsUUFBUSxJQUFJLENBQUMsQ0FBQztBQUFBLEVBQzVELElBQUksVUFBVSxXQUFXO0FBQUEsSUFDdkIsTUFBTSxXQUFXLFNBQVMsS0FBSyxJQUFJO0FBQUEsSUFDbkMsTUFBTSxJQUFJLFdBQ1IsS0FBSyw4QkFBOEIsS0FBSyxrRUFDeEMsU0FBUyxTQUFTLElBQUksRUFBRSxTQUFTLFNBQVMsSUFBSSxFQUFFLE1BQU0sR0FBRyxLQUFLLHNCQUFzQixDQUN0RjtBQUFBLEVBQ0Y7QUFBQSxFQU1BLE1BQU0sV0FBVyxLQUFLLFlBQVksT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUU7QUFBQSxFQUM1RCxNQUFNLFdBQVcsS0FBSyxZQUFZLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUTtBQUFBLEVBQ3hELElBQUksSUFBSSxTQUFTLFlBQWEsQ0FBQyxZQUFZLElBQUksU0FBUyxLQUFLLFlBQVksUUFBUztBQUFBLElBQ2hGLE1BQU0sSUFBSSxXQUFXLFVBQVUsUUFBUSxJQUFJLEtBQUssRUFBRSxNQUFNLEtBQUssU0FBUyxDQUFDO0FBQUEsRUFDekU7QUFBQSxFQUVBLE1BQU0sVUFBVSxPQUFPLE1BQU0sWUFBWSxXQUFXLE1BQU0sVUFBVTtBQUFBLEVBR3BFLE1BQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxLQUFLLE9BQU8sT0FBTztBQUFBLEVBQy9DLE9BQU8sT0FBTyxTQUFTLFdBQVcsT0FBTztBQUFBO0FBK0IzQyxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICIyQ0I3M0U5NTc5RjJCODFBNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
