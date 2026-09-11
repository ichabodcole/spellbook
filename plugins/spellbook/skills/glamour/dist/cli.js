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

//# debugId=40717D8F13BA0C0B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9jbGkudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9nbGFtb3VyL2JhY2tlbmQvaGVhcnRiZWF0LnRzIiwgIi4uL3NoYXJlZC9pbWFnZU9wdGltaXplLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9nbGFtb3VyL2JhY2tlbmQvaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGdsYW1vdXIgQ0xJIOKAlCB0aGluIHdyYXBwZXIgYXJvdW5kIHRoZSBwZXItc2Vzc2lvbiBkYWVtb24ncyBIVFRQIHN1cmZhY2Vcbi8vIChzZXJ2ZXIudHMpLiBUaGUgYWdlbnQgZHJpdmVzIGEgZ2xhbW91ciBzZXNzaW9uIHRocm91Z2ggdGhlc2UgdmVyYnM7XG4vLyBgdGFpbGAgc3RyZWFtcyB1c2VyIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwLlxuLy9cbi8vIExpZmVjeWNsZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLW5vLW9wZW5dICAgIyBzcGF3biBhIHNlc3Npb25cbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgU1NFIGV2ZW50cyDihpIgSlNPTkwgKE1vbml0b3IgdGhpcylcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgbGVhbiBzdGF0ZSBzbmFwc2hvdFxuLy9cbi8vIEFnZW50IGNvbW1hbmRzIChQT1NUIC9jbWQpOlxuLy8gICBidW4gY2xpLnRzIGludGVudCA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyBhbm5vdGF0ZSA8aWQ+IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIHNheSA8dGV4dC4uLj5cbi8vICAgYnVuIGNsaS50cyBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZlxuLy8gICBidW4gY2xpLnRzIGNsb3NlXG4vLyAgIGJ1biBjbGkudHMgaW5mbyB8IGhlbHAgfCAtLXZlcnNpb25cbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD5cbi8vIHRvIHRhcmdldCBhIHNwZWNpZmljIG9uZS5cbi8vXG4vLyBFUlJPUiBDT05UUkFDVCAoYWNjIEwwIOKAlCB0aGUgaG91c2UgdGF4b25vbXkgbWFncGllIHNldCBhbmQgbWluZC1tYXBwZXJcbi8vIGFkb3B0ZWQpOiBldmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciB3aXRoIHN0ZG91dCBlbXB0eSDigJRcbi8vICAge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vICAgIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbi8vICAgdXNhZ2Ug4oaSIGV4aXQgMiDCtyBpbnRlcm5hbCDihpIgMSDCtyBub3RfZm91bmQg4oaSIDUgwrcgY29uZmxpY3Qg4oaSIDZcbi8vIEEgZGFlbW9uIHJlZnVzYWwgbWFwcyBvZmYgaXRzIEhUVFAgc3RhdHVzICg0MDAgdXNhZ2UsIDQwNCBub3RfZm91bmQsXG4vLyA0MDkgY29uZmxpY3QsIGVsc2UgaW50ZXJuYWwpIGFuZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gYm9keSBWRVJCQVRJTVxuLy8gdW5kZXIgZXJyb3Iuc2VydmVyLiBCcmFuY2ggb24gYGtpbmRgLCBuZXZlciBvbiBgbWVzc2FnZWAgcHJvc2UuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQge1xuICBDbGlFcnJvcixcbiAgZGllLFxuICB0eXBlIEVycktpbmQsXG4gIHJlcG9ydENsaUVycm9yLFxuICBzZXRDdXJyZW50Q29tbWFuZCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9yc1wiO1xuaW1wb3J0IHsgdGFpbEV2ZW50cyB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsRXZlbnRzXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IG9wdGltaXplSW1hZ2VEYXRhVXJsIH0gZnJvbSBcIi4vaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXJcIjtcblxuLy8g4puUIEVWRVJZIFBBVEggSEVSRSBJUyBSRVNPTFZFRCBGUk9NIFRIRSBFTUlUVEVEIExPQ0FUSU9OLCBgZGlzdC9gLCBOT1QgRlJPTVxuLy8gVEhJUyBTT1VSQ0UgRklMRS4gVGhpcyBtb2R1bGUgaXMgYnVuZGxlZCB0b1xuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL2Rpc3QvY2xpLmpzYCBhbmQgdGhlIGxhdW5jaGVyIGF0XG4vLyBgLi4vc2NyaXB0cy9jbGkudHNgIGltcG9ydHMgaXQsIHNvIGBpbXBvcnQubWV0YS51cmxgIG5hbWVzIHRoZSBCVU5ETEUuIGBkaXN0L2Bcbi8vIGhhcHBlbnMgdG8gc2l0IGF0IHRoZSBzYW1lIGRlcHRoIGFzIHRoZSBgc2NyaXB0cy9gIHRoaXMgZmlsZSB1c2VkIHRvIGxpdmUgaW4sXG4vLyBzbyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAgYW5kIGBTVVJGQUNFX0NXRGAgYXJlIHVuY2hhbmdlZCDigJQgYnV0IHRoYXQgaXMgYVxuLy8gQ09JTkNJREVOQ0UgT0YgREVQVEgsIG5vdCBhIHByb3BlcnR5LCB3aGljaCBpcyB3aHkgdGhlIHdhcmQgYXNzZXJ0cyB0aGVtXG4vLyByYXRoZXIgdGhhbiB0cnVzdGluZyB0aGlzIHBhcmFncmFwaC5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIEFORCBUSElTIExJTkUgSVMgVEhFIE9ORSBUSEUgUkVMT0NBVElPTiBCUk9LRS4gSXQgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJzZXJ2ZXIudHNcIilgIOKAlCB0aGUgZGFlbW9uIGJlc2lkZSB0aGUgQ0xJIOKAlCB3aGljaCB3YXMgdHJ1ZVxuLy8gZm9yIGV4YWN0bHkgYXMgbG9uZyBhcyBib3RoIGxpdmVkIGluIGBzY3JpcHRzL2AuIEZyb20gYGRpc3QvYCBpdCByZXNvbHZlcyB0b1xuLy8gYGRpc3Qvc2VydmVyLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgZXhpc3QgYW5kIG11c3Qgbm90OiBgZGlzdC9gIGhvbGRzIHRoZVxuLy8gQlVORExFIChgc2VydmVyLmpzYCksIGFuZCB0aGUgc3Bhd25hYmxlIGVudHJ5IGlzIHRoZSBsYXVuY2hlciBvbmUgZGlyZWN0b3J5XG4vLyBvdmVyLiBUaGUgc3ltcHRvbSBvZiBnZXR0aW5nIGl0IHdyb25nIGlzIG5vdCBhIGNyYXNoIOKAlCBgb3BlbmAgd2FpdHMgb3V0IGl0c1xuLy8gNDUtc2Vjb25kIGhhbmRzaGFrZSBhbmQgcmVwb3J0cyBhIHN0YXJ0IHRpbWVvdXQsIHdoaWNoIHJlYWRzIGxpa2UgYSBzbG93IGZpcnN0XG4vLyBidW5kbGUgYnVpbGQuIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgaXMgd2hhdCBuYW1lcyBpdCBpbiAwLjRzXG4vLyBpbnN0ZWFkLCBhbmQgaXQgbmFtZWQgdGhpcyBvbmUuIEFzdHJvbGFiZSBhbmQgbWFncGllIHdlcmUgYWxyZWFkeSB3cml0dGVuIHRoaXNcbi8vIHdheSBhbmQgcGFpZCBub3RoaW5nIGZvciB0aGUgbW92ZTsgZ2xhbW91ciBpcyB3aGVyZSB0aGUgc2hhcGUgZWFybmVkIGl0c2VsZi5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBCdW4gcmVhZHMgYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2Rcbi8vIE1VU1QgYmUgc3JjL2dsYW1vdXIvIGluIGRldiAoc2VhbXMgQ29udHJhY3QgNSkuIExhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IOKAlCBtZWFzdXJlZCBvbiBnbGFtb3VyIHRoZSBQQUdFIDUwMHMgd2l0aFxuLy8gbm8gc3R5bGVzaGVldCBsaW5rIChub3QgXCJ1bnN0eWxlZCBhdCAyMDBcIjsgdGhhdCBzZW50ZW5jZSB3YXMgbmV2ZXIgcnVuKS4gQXNzZXJ0XG4vLyB0aGUgaW52YXJpYW50OiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gdGhlIGN3ZCBpcyB3cm9uZy5cbi8vIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmQgc3RhdGljIOKAlCBubyBidW5maWcgcmVhZCwgc28gc3JjL2dsYW1vdXIvIG5lZWRcbi8vIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSwgYW5kXG4vLyBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGQgYnJlYWsgdGhlIHNwYXduLiBFeHBvcnRlZCBmb3IgdGhlIHRlc3QuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ2xhbW91clwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuZXhwb3J0IGNvbnN0IFNLSUxMX1JPT1RfRk9SX1RFU1QgPSBTS0lMTF9ST09UO1xuXG50eXBlIFNlc3Npb24gPSB7XG4gIHVybDogc3RyaW5nO1xuICBwb3J0OiBudW1iZXI7XG4gIHNlc3Npb25faWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZmlsZXNfZGlyPzogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIGVycm9yIGVudmVsb3BlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBUSEUgQ09OVFJBQ1QgSVMgTk9XIFRIRSBIT1VTRSdTIE9ORSBDT1BZIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIGFuZFxuLy8gZ2xhbW91cidzIGZvdXJ0aCB3YXMgZGVsZXRlZC4gVGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlIGVudmVsb3BlJ3Mga2V5XG4vLyBvcmRlciBhbmQgYGRpZWAncyB0aHJvdy1ub3QtZXhpdCBzaGFwZSBhbGwgY29tZSBmcm9tIHRoZXJlIOKAlCBhbmQgZ2xhbW91ciBpc1xuLy8gd2hlcmUgdHdvIG9mIHRoZW0gd2VyZSBmaXJzdCB3cml0dGVuLCBzbyBub3RoaW5nIGFib3V0IHRoZSB3aXJlIGNoYW5nZWQuIFRIUk9XXG4vLyBhbmQgbGV0IG1haW4oKSBjYXRjaCBhbmQgUkVUVVJOIHRoZSBjb2RlLCBuZXZlciBgcHJvY2Vzcy5leGl0YCBpbnNpZGUgYVxuLy8gaGVscGVyOiB0aGlzIENMSSBzaGlwcyBsYXJnZSBzdGRvdXQgcGF5bG9hZHMgKGBzdGF0ZSAtLWZ1bGxgKSwgQnVuJ3Mgc3Rkb3V0IGlzXG4vLyBhc3luY2hyb25vdXMgb24gYSBwaXBlLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgd2hhdGV2ZXIgaGFzIG5vdFxuLy8gZHJhaW5lZCAobWVhc3VyZWQgYXQgNjUsNTM2IGJ5dGVzKS5cbi8vXG4vLyDimqAgT05FIEZJRUxEIFdFTlQgVEhFIE9USEVSIFdBWS4gYGVycm9yLnNlcnZlcmAg4oCUIHRoZSBkYWVtb24ncyBvd24gYm9keSxcbi8vIHZlcmJhdGltIOKAlCBleGlzdGVkIG9ubHkgaGVyZSwgYmVjYXVzZSBhc3Ryb2xhYmUncyBhbmQgbWFncGllJ3MgY29waWVzIGtlZXAgdGhlXG4vLyBIVFRQIHN0YXR1cyBhbmQgZGlzY2FyZCB3aGF0IHRoZSBkYWVtb24gc2FpZC4gSXQgaXMgbm93IHBhcnQgb2YgdGhlIGtpdCdzXG4vLyBgRXJyRXh0cmFgLCBzbyB0aGUgc2hhcmVkIGNvbnRyYWN0IGdvdCBXSURFUiBieSBhZG9wdGluZyBnbGFtb3VyIHJhdGhlciB0aGFuXG4vLyBnbGFtb3VyIGdldHRpbmcgbmFycm93ZXIgdG8gZml0IGl0LiBTZWUgdGhhdCBtb2R1bGUncyBub3RlIG9uIHRoZSBmaWVsZC5cbi8vXG4vLyDim5QgQU5EIFRIRSBBRE9QVElPTiBSRVFVSVJFRCBUSEUgRDggUkVBQ0hBQklMSVRZIEFVRElULCBXSElDSCBXQVMgUEVSRk9STUVELlxuLy8gQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIHN3YWxsb3dzIGlzIGEgc2lsZW50XG4vLyBjb250aW51ZSwgYW5kIHRoZSBzaXRlIHRoYXQgZGllcyBjYW4gYmUgdGhyZWUgZnJhbWVzIGJlbG93IHRoZSBzaXRlIHRoYXQgbG9va3Ncbi8vIHNhZmUuIEF1ZGl0ZWQgYnkgZm9sbG93aW5nIHRoZSBjYWxsIGdyYXBoLCBub3QgYnkgZ3JlcHBpbmc6IDEyIGBkaWVgIGNhbGxcbi8vIHNpdGVzLCAyNSBmdXJ0aGVyIGludm9jYXRpb24gZWRnZXMgb2YgdGhlIHRlbiBmdW5jdGlvbnMgdGhhdCByZWFjaCBvbmVcbi8vIHRyYW5zaXRpdmVseSAoYHJlYWRTZXNzaW9uYCwgYHJlcXVpcmVTZXNzaW9uYCwgYHJlc29sdmVHZW5TcmNgLCBgY21kT3BlbmAsXG4vLyBgY21kSW5mb2AsIGBjbWRTdGF0ZWAsIGBjbWRUYWlsYCwgYHBvc3RDbWRgLCBgZGlzcGF0Y2hgLCBgbWFpbmAsIHBsdXMgZmlmdGVlblxuLy8gQ09NTUFORFNbXS5ydW4gY2xvc3VyZXMpLCAzNyBhdWRpdGVkIHBvc2l0aW9ucywgWkVSTyBpbnNpZGUgYSBgdHJ5YC4gVGhlIHRocmVlXG4vLyBzd2FsbG93aW5nIGNhdGNoZXMgaW4gdGhpcyBmaWxlIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2Anc1xuLy8gZGVncmFkZS10by11bmtub3duLCB0aGUgdGFpbCdzIG1hbGZvcm1lZC1mcmFtZSBza2lwKSBoYXZlIG5vIGRpZS1yZWFjaGFibGVcbi8vIGNhbGwgaW5zaWRlIHRoZW0uIFRoZSBvbmUgdG8gd2F0Y2ggaXMgZmxhZ2dlZCBhdCBgcG9zdENtZGAuXG5cbi8qKiBgVXNhZ2VFcnJvcmAgaXMgdGhlIG5hbWUgdGhlIHRlc3RzIGFuZCB0aGUgb2xkZXIgY2FsbCBzaXRlcyBrbm93OyBhIHVzYWdlXG4gKiAgZmFpbHVyZSBpcyBhIGBDbGlFcnJvcmAgb2Yga2luZCBcInVzYWdlXCIuIEtlcHQgYXMgYSBzdWJjbGFzcyByYXRoZXIgdGhhblxuICogIGlubGluZWQgYmVjYXVzZSBgZGlzcGF0Y2hgIGJyYW5jaGVzIG9uIGl0IHRvIGRpc3Rpbmd1aXNoIGEgUEFSU0UgcmVqZWN0aW9uXG4gKiAgKHdoaWNoIGl0IHJlc2hhcGVzIHdpdGggYSBwYXRoLXNjb3BlZCBgY2hvaWNlc2ApIGZyb20gYW55dGhpbmcgZWxzZSwgYW5kXG4gKiAgYGluc3RhbmNlb2ZgIGlzIHRoZSBvbmx5IGhvbmVzdCB3YXkgdG8gYXNrIHRoYXQuICovXG5leHBvcnQgY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0pIHtcbiAgICBzdXBlcihcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKTtcbiAgfVxufVxuXG5leHBvcnQgeyBDbGlFcnJvciB9O1xuXG4vLyBBIGRhZW1vbiByZWZ1c2FsOiB0aGUga2luZCBtYXBzIG9mZiB0aGUgSFRUUCBzdGF0dXMsIHRoZSBkYWVtb24ncyBvd24gYm9keVxuLy8gcmlkZXMgdmVyYmF0aW0gdW5kZXIgZXJyb3Iuc2VydmVyIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gaXQuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGRpZShgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNlc3Npb25cbiAgICA/IGpvaW4odG1wZGlyKCksIGBnbGFtb3VyLSR7c2Vzc2lvbn0uanNvbmApXG4gICAgOiBqb2luKHRtcGRpcigpLCBcImdsYW1vdXItbGF0ZXN0Lmpzb25cIik7XG59XG5cbi8qKiDim5QgTlVMTCBNRUFOUyBcIk5PIFNFU1NJT05cIiwgQU5EIE5PVEhJTkcgRUxTRS5cbiAqXG4gKiAgVGhpcyB1c2VkIHRvIGBjYXRjaCB7IHJldHVybiBudWxsIH1gIG92ZXIgdGhlIHdob2xlIHJlYWQsIHNvIEVWRVJZIGZhaWx1cmUg4oCUXG4gKiAgYSBjb3JydXB0IHBvaW50ZXIsIEVBQ0NFUywgYW5kIGFueSB0cmFuc2llbnQgdGhlIE9TIHJhaXNlcyB1bmRlciBsb2FkIOKAlFxuICogIGFycml2ZWQgYXQgdGhlIGNhbGxlcnMgd2VhcmluZyBhYnNlbmNlJ3MgY2xvdGhlcy4gVGhyZWUgb2YgdGhlbSBhY3Qgb24gdGhhdDpcbiAqICBgcmVxdWlyZVNlc3Npb25gIGRpZXMgYG5vdF9mb3VuZGAgKGV4aXQgNSksIGBjbWRJbmZvYCB0aGUgc2FtZSwgYW5kIHRoZSB3YXRjaFxuICogIGxvb3AgdHJlYXRzIGl0IGFzIFwidGhlIHBpbm5lZCBzZXNzaW9uIHdlbnQgYXdheVwiIGFuZCBleGl0cyAqKjAqKi4gQSByZXNvdXJjZVxuICogIGZhaWx1cmUgd2FzIHRoZXJlZm9yZSByZXBvcnRlZCBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBjb25zZXF1ZW5jZTogYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCdzIEhUVFAtNDAwIHJvdyBmYWlsZWQgb25jZVxuICogIHVuZGVyIHRoZSBmdWxsIDE0Ni1maWxlIGdhdGUgd2l0aCBleGl0ICoqNSoqIHdoZXJlIHRoZSBjb250cmFjdCBzYXlzIDIsIGFuZFxuICogIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuIChmaWxlZCAyMDI2LTA5LTA3LCBkaWdlc3RpZnkncyBQaGFzZSAwIGJhc2VsaW5lKS5cbiAqICA1IGlzIG5vdCBhIHNwYXduIGNyYXNoIOKAlCBpdCBpcyB0aGlzIGZ1bmN0aW9uJ3MgYG5vdF9mb3VuZGAsIHdoaWNoIGlzIHdoeSB0aGVcbiAqICBjZWxsIGNvdWxkIG5vdCB0ZWxsIFwidGhlIGNvbnRyYWN0IGJyb2tlXCIgZnJvbSBcInRoZSBtYWNoaW5lIHdhcyBidXN5XCIuXG4gKlxuICogIFNvOiBFTk9FTlQgaXMgdGhlIG9ubHkgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHRocm93cyBhbmQgbmFtZXMgaXRzZWxmLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24gfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gbnVsbDsgLy8gdGhlIG9uZSBob25lc3QgYWJzZW5jZVxuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgc28gYSBoYWxmLXdyaXR0ZW5cbiAgICAvLyBwb2ludGVyIGlzIG5vdCByZWFjaGFibGUgYW5kIHVucGFyc2VhYmxlIGNvbnRlbnQgaXMgcmVhbCBjb3JydXB0aW9uLlxuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24ge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBnbGFtb3VyIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgIG9yIGJvb2xlYW4gYC0tZmxhZ2AuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhpcyBwYXJzZXIgYWxyZWFkeSBzcGxpdCBvbiB0aGUgZmlyc3QgYD1gLiBXaGF0IGl0IGxhY2tlZCB3YXMgYSBSRUdJU1RSWTpcbi8vIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZVxuLy8gcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhcyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLiBgbm9kZTp1dGlsYFxuLy8gc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBhbG9uZ3NpZGUgdGhlIGA9YCBoYW5kbGluZy5cbi8vXG4vLyDimqAgYC0tcmVzdG9yZWAgSEFEIE5PIENPUlJFQ1QgVFlQRSBhbmQgdGhpcyBpcyB0aGUgc3ByaW50J3Mgb25lIGdlbnVpbmUgZGVzaWduXG4vLyBibG9ja2VyLCBSVUxFRCBCWSBDT0xFLiBJdCB3YXMgQk9PTEVBTiBpbiBgc3R5bGUtYXJjaGl2ZWAgKGBhcmNoaXZlZDpcbi8vIGZsYWdzLnJlc3RvcmUgIT09IHRydWVgKSBhbmQgU1RSSU5HIGluIGBvcGVuYCdzIGRhZW1vbiBzcGF3biDigJQgb25lIGZsYWcgbmFtZSxcbi8vIHR3byBpbmNvbXBhdGlibGUgdHlwZXMsIG9uZSBvcHRpb25zIG1hcC4gRGVjbGFyaW5nIGl0IGJvb2xlYW4gc2VuZHMgYG9wZW5gJ3Ncbi8vIGlkIHRvIHBvc2l0aW9uYWxzIGFuZCBmb3J3YXJkcyBgLS1yZXN0b3JlIHRydWVgLCBzbyB0aGUgZGFlbW9uIGh1bnRzIGFcbi8vIHNuYXBzaG90IG5hbWVkIFwidHJ1ZVwiOyBkZWNsYXJpbmcgaXQgc3RyaW5nIG1ha2VzIGBzdHlsZS1hcmNoaXZlIDxpZD5cbi8vIC0tcmVzdG9yZWAgc3dhbGxvdyB0aGUgbmV4dCBwb3NpdGlvbmFsLCB3aGljaCBpcyB0aGlzIHNwcmludCdzIG93biBkZWZlY3Rcbi8vIGNsYXNzIHJlLWludHJvZHVjZWQgYnkgaXRzIGZpeC5cbi8vXG4vLyBSdWxlZDogcmVuYW1lIHRoZSBCT09MRUFOIG9uZS4gYC0tcmVzdG9yZWAga2VlcHMgdGhlIGhvdXNlLXdpZGUgc3RyaW5nXG4vLyBzcGVsbGluZyBpdCBzaGFyZXMgd2l0aCBib3VudHksIGltYWdvLCBtYWdwaWUgYW5kIGdsYW1vdXIncyBvd24gc2VydmVyLnRzO1xuLy8gYHN0eWxlLWFyY2hpdmVgIHRha2VzIGAtLXVuYXJjaGl2ZWAsIHdoaWNoIG5hbWVzIHRoZSBpbnZlcnNlIG9mIGFyY2hpdmVcbi8vIGJldHRlciBhbnl3YXkuIEl0IGFsc28ga2lsbHMgYSBsaXZlIGJ1ZyBCWSBDT05TVFJVQ1RJT046IGBmbGFncy5yZXN0b3JlICE9PVxuLy8gdHJ1ZWAgbWVhbnQgYHN0eWxlLWFyY2hpdmUgPGlkPiAtLXJlc3RvcmUgZm9vYCBBUkNISVZFRCBpbnN0ZWFkIG9mIHJlc3RvcmluZyxcbi8vIGF0IGV4aXQgMCwgd2l0aCBubyBzaWduYWwuXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgY29sb3JzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY29udGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjdXN0b206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmaWxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBub3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvbXB0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvbXB0czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByb3VuZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlZWQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzcmM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHVybDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdW5hcmNoaXZlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUyA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKS5tYXAoKGspID0+IGAtLSR7a31gKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIFRoZSByZWplY3Rpb24gTkFNRVMgaXRzIHZhbGlkIHNldCAoYWNjIEEzJ3MgU0hPVUxEKTogYGNob2ljZXNgIGlzIHRoZVxuICAgIC8vIHJlY29nbml6ZWQgZmxhZyByZWdpc3RyeSwgc28gYW4gYWdlbnQgc2VsZi1jb3JyZWN0cyB3aXRob3V0IGEgbG9va3VwLlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGRldGFpbCwge1xuICAgICAgaGludDogXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCIsXG4gICAgICBjaG9pY2VzOiBSRUNPR05JWkVEX0ZMQUdTLFxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICogUG9zaXRpb25hbCBgaWAgb2YgYSB2ZXJiIHdob3NlIEFSSVRZIERJU1BBVENIIEhBUyBBTFJFQURZIEVORk9SQ0VEIOKAlCBzbyB0aGlzXG4gKiBhYnNlbmNlIGlzIGltcG9zc2libGUgdGhyb3VnaCB0aGUgQ0xJLiBUaGUgYnVpbGRlcnMgYXJlIGV4cG9ydGVkIChjbGkudGVzdC50c1xuICogY2FsbHMgdGhlbSBkaXJlY3RseSksIGFuZCBcIm5vIHN1Y2ggYW5zd2VyIGV4aXN0c1wiIGZvciBhIGNvbW1hbmQgd2l0aCBubyBpZCxcbiAqIHNvIGFuIGltcG9zc2libGUgYWJzZW5jZSBnZXRzIHRoZSBob3VzZSdzIHVzYWdlIHJlZnVzYWwgKFQyMidzIHRoaXJkIHJvdylcbiAqIHJhdGhlciB0aGFuIGEgY29tbWFuZCBwb3N0ZWQgdG8gdGhlIGRhZW1vbiB3aXRoIGBpZDogdW5kZWZpbmVkYC5cbiAqL1xuZnVuY3Rpb24gcG9zaXRpb25hbChwb3M6IHN0cmluZ1tdLCBpOiBudW1iZXIsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHYgPSBwb3NbaV07XG4gIGlmICh2ID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBVc2FnZUVycm9yKGBtaXNzaW5nIDwke25hbWV9PmApO1xuICByZXR1cm4gdjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2F5Q21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IHN0cmluZyB9IHtcbiAgY29uc3QgY21kOiB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZzsga2luZD86IHN0cmluZyB9ID0ge1xuICAgIHR5cGU6IFwic2F5XCIsXG4gICAgdGV4dDogcG9zLmpvaW4oXCIgXCIpLFxuICB9O1xuICBpZiAodHlwZW9mIGZsYWdzLmtpbmQgPT09IFwic3RyaW5nXCIpIGNtZC5raW5kID0gZmxhZ3Mua2luZDtcbiAgcmV0dXJuIGNtZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2VjdGlvbkNtZChcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKToge1xuICB0eXBlOiBcInNlY3Rpb25cIjtcbiAga2V5OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgY29udGVudD86IHN0cmluZztcbiAgcHJvbXB0cz86IHN0cmluZ1tdO1xuICBjb2xvcnM/OiBBcnJheTx7IGhleDogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0+O1xufSB7XG4gIGNvbnN0IGNtZDoge1xuICAgIHR5cGU6IFwic2VjdGlvblwiO1xuICAgIGtleTogc3RyaW5nO1xuICAgIHN0YXR1cz86IHN0cmluZztcbiAgICBjb250ZW50Pzogc3RyaW5nO1xuICAgIHByb21wdHM/OiBzdHJpbmdbXTtcbiAgICBjb2xvcnM/OiBBcnJheTx7IGhleDogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0+O1xuICB9ID0geyB0eXBlOiBcInNlY3Rpb25cIiwga2V5OiBwb3NpdGlvbmFsKHBvcywgMCwgXCJrZXlcIikgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5zdGF0dXMgPT09IFwic3RyaW5nXCIpIGNtZC5zdGF0dXMgPSBmbGFncy5zdGF0dXM7XG4gIGlmICh0eXBlb2YgZmxhZ3MuY29udGVudCA9PT0gXCJzdHJpbmdcIikgY21kLmNvbnRlbnQgPSBmbGFncy5jb250ZW50O1xuICBpZiAodHlwZW9mIGZsYWdzLnByb21wdHMgPT09IFwic3RyaW5nXCIpXG4gICAgY21kLnByb21wdHMgPSBmbGFncy5wcm9tcHRzLnNwbGl0KFwifHxcIikubWFwKChwKSA9PiBwLnRyaW0oKSk7XG4gIC8vIC0tY29sb3JzIFwiI0ZBQ0MzRTpUcmVhc3VyZSBHb2xkfHwjMjkzRDM2OlN1bmtlbiBDaGFyY29hbFwiIOKGkiBzdHJ1Y3R1cmVkIHN3YXRjaGVzXG4gIGlmICh0eXBlb2YgZmxhZ3MuY29sb3JzID09PSBcInN0cmluZ1wiKVxuICAgIGNtZC5jb2xvcnMgPSBmbGFncy5jb2xvcnNcbiAgICAgIC5zcGxpdChcInx8XCIpXG4gICAgICAubWFwKChzKSA9PiB7XG4gICAgICAgIGNvbnN0IGkgPSBzLmluZGV4T2YoXCI6XCIpO1xuICAgICAgICByZXR1cm4gaSA+PSAwXG4gICAgICAgICAgPyB7IGhleDogcy5zbGljZSgwLCBpKS50cmltKCksIG5hbWU6IHMuc2xpY2UoaSArIDEpLnRyaW0oKSB9XG4gICAgICAgICAgOiB7IGhleDogcy50cmltKCkgfTtcbiAgICAgIH0pXG4gICAgICAuZmlsdGVyKChjKSA9PiBjLmhleCk7XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUN1c3RvbSh2OiBzdHJpbmcgfCBib29sZWFuIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgdiAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGZvciAoY29uc3QgcGFpciBvZiB2LnNwbGl0KFwiLFwiKSkge1xuICAgIGNvbnN0IGVxID0gcGFpci5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXEgPiAwKSBvdXRbcGFpci5zbGljZSgwLCBlcSkudHJpbSgpXSA9IHBhaXIuc2xpY2UoZXEgKyAxKS50cmltKCk7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKG91dCkubGVuZ3RoID8gb3V0IDogdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW5DbWQoXG4gIHNyYzogc3RyaW5nLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7XG4gIHR5cGU6IFwiZ2VuLmFkZFwiO1xuICBzcmM6IHN0cmluZztcbiAgcHJvbXB0OiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIHJvdW5kOiBudW1iZXI7XG4gIHNlZWQ/OiBudW1iZXI7XG4gIGNvc3Q/OiBudW1iZXI7XG4gIGxhYmVsPzogc3RyaW5nO1xuICBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufSB7XG4gIGNvbnN0IGNtZDogUmV0dXJuVHlwZTx0eXBlb2YgYnVpbGRHZW5DbWQ+ID0ge1xuICAgIHR5cGU6IFwiZ2VuLmFkZFwiLFxuICAgIHNyYyxcbiAgICBwcm9tcHQ6IHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIgPyBmbGFncy5wcm9tcHQgOiBcIlwiLFxuICAgIG1vZGVsOiB0eXBlb2YgZmxhZ3MubW9kZWwgPT09IFwic3RyaW5nXCIgPyBmbGFncy5tb2RlbCA6IFwiXCIsXG4gICAgcm91bmQ6IHR5cGVvZiBmbGFncy5yb3VuZCA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUludChmbGFncy5yb3VuZCwgMTApIDogMCxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5zZWVkID09PSBcInN0cmluZ1wiKSBjbWQuc2VlZCA9IE51bWJlci5wYXJzZUludChmbGFncy5zZWVkLCAxMCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MuY29zdCA9PT0gXCJzdHJpbmdcIikgY21kLmNvc3QgPSBOdW1iZXIucGFyc2VGbG9hdChmbGFncy5jb3N0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIikgY21kLmxhYmVsID0gZmxhZ3MubGFiZWw7XG4gIGNvbnN0IGN1c3RvbSA9IHBhcnNlQ3VzdG9tKGZsYWdzLmN1c3RvbSk7XG4gIGlmIChjdXN0b20pIGNtZC5jdXN0b20gPSBjdXN0b207XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdlbkNvc3RDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJnZW4uY29zdFwiOyBpZDogc3RyaW5nOyBjb3N0OiBudW1iZXIgfSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogXCJnZW4uY29zdFwiLFxuICAgIGlkOiBwb3NpdGlvbmFsKHBvcywgMCwgXCJpZFwiKSxcbiAgICBjb3N0OiB0eXBlb2YgZmxhZ3MuY29zdCA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUZsb2F0KGZsYWdzLmNvc3QpIDogTnVtYmVyLk5hTixcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR2VuTWV0YUNtZChcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogeyB0eXBlOiBcImdlbi5tZXRhXCI7IGlkOiBzdHJpbmc7IHByb21wdD86IHN0cmluZzsgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9IHtcbiAgY29uc3QgY21kOiB7IHR5cGU6IFwiZ2VuLm1ldGFcIjsgaWQ6IHN0cmluZzsgcHJvbXB0Pzogc3RyaW5nOyBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH0gPSB7XG4gICAgdHlwZTogXCJnZW4ubWV0YVwiLFxuICAgIGlkOiBwb3NpdGlvbmFsKHBvcywgMCwgXCJpZFwiKSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGNtZC5wcm9tcHQgPSBmbGFncy5wcm9tcHQ7XG4gIGNvbnN0IGN1c3RvbSA9IHBhcnNlQ3VzdG9tKGZsYWdzLmN1c3RvbSk7XG4gIGlmIChjdXN0b20pIGNtZC5jdXN0b20gPSBjdXN0b207XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0eWxlU2F2ZUNtZChwb3M6IHN0cmluZ1tdKToge1xuICB0eXBlOiBcInN0eWxlLnNhdmVcIjtcbiAgbGFiZWw6IHN0cmluZztcbn0ge1xuICByZXR1cm4geyB0eXBlOiBcInN0eWxlLnNhdmVcIiwgbGFiZWw6IHBvcy5qb2luKFwiIFwiKSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdHlsZUFyY2hpdmVDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJzdHlsZS5hcmNoaXZlXCI7IGlkOiBzdHJpbmc7IGFyY2hpdmVkOiBib29sZWFuIH0ge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwic3R5bGUuYXJjaGl2ZVwiLFxuICAgIGlkOiBwb3NpdGlvbmFsKHBvcywgMCwgXCJpZFwiKSxcbiAgICBhcmNoaXZlZDogIWZsYWdzLnVuYXJjaGl2ZSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRm9jdXNDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGNtZDogeyB0eXBlOiBcImZvY3VzLnB1c2hcIjsgaWRzOiBzdHJpbmdbXTsgbm90ZT86IHN0cmluZyB9ID0ge1xuICAgIHR5cGU6IFwiZm9jdXMucHVzaFwiLFxuICAgIGlkczogcG9zLFxuICB9O1xuICBpZiAodHlwZW9mIGZsYWdzLm5vdGUgPT09IFwic3RyaW5nXCIpIGNtZC5ub3RlID0gZmxhZ3Mubm90ZTtcbiAgcmV0dXJuIGNtZDtcbn1cblxuLy8gUmVzb2x2ZSBhIGdlbiBpbWFnZSBzb3VyY2UgdG8gYW4gT1BUSU1JWkVEIHdlYnAgZGF0YS1VUkwgKHRoZSBkYWVtb24gc3RvcmVzXG4vLyBpdCBhcy1pcykuIC0tdXJsIGRvd25sb2FkczsgLS1maWxlIHJlYWRzOyAtLXNyYyBpcyBhbiBleGlzdGluZyBkYXRhLVVSTC5cbi8qKlxuICog4pSA4pSAIGBnZW5gJ3MgVFdPIEFDQ0VQVEVEIFNFVFMgKHJlZ2lzdGVyIEExKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBgR0VOX1NSQ19GTEFHU2AgaXMgYSBESVNKVU5DVElPTiDigJQgYW55IG9uZSBzYXRpc2ZpZXMgYHJlc29sdmVHZW5TcmNgLlxuICogYEdFTl9SRVFVSVJFRF9GTEFHU2AgaXMgYSBDT05KVU5DVElPTiDigJQgYWxsIHRocmVlIG11c3QgYmUgcHJlc2VudCDigJQgYW5kIHRoZVxuICogcmVqZWN0aW9uIGJlbG93IGZpbHRlcnMgaXQsIHNvIGl0cyBgY2hvaWNlc2AgbmFtZXMgdGhlIG9uZXMgYWN0dWFsbHkgTUlTU0lOR1xuICogcmF0aGVyIHRoYW4gdGhlIHdob2xlIHJvc3Rlci4gQm90aCBhcmUgZGVyaXZlZCBhdCB0aGUgc2l0ZSB0aGF0IGVuZm9yY2VzXG4gKiB0aGVtOyBuZWl0aGVyIGlzIHJlLXR5cGVkIGludG8gYSBtZXNzYWdlLlxuICovXG5jb25zdCBHRU5fU1JDX0ZMQUdTID0gW1widXJsXCIsIFwiZmlsZVwiLCBcInNyY1wiXSBhcyBjb25zdDtcbmNvbnN0IEdFTl9SRVFVSVJFRF9GTEFHUyA9IFtcInByb21wdFwiLCBcIm1vZGVsXCIsIFwicm91bmRcIl0gYXMgY29uc3Q7XG4vKiogYGdlbi1tZXRhYCdzIGRpc2p1bmN0aW9uIOKAlCBlaXRoZXIgb25lIHNhdGlzZmllcyBpdC4gKi9cbmNvbnN0IEdFTl9NRVRBX0ZMQUdTID0gW1wicHJvbXB0XCIsIFwiY3VzdG9tXCJdIGFzIGNvbnN0O1xuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlR2VuU3JjKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmICh0eXBlb2YgZmxhZ3MudXJsID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goZmxhZ3MudXJsKTtcbiAgICBpZiAoIXJlcy5vaykgZGllKGBnZW46IGZhaWxlZCB0byBmZXRjaCAtLXVybCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCByZXMuYXJyYXlCdWZmZXIoKSk7XG4gICAgbGV0IGJpbiA9IFwiXCI7XG4gICAgZm9yIChjb25zdCBiIG9mIGJ5dGVzKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgICBjb25zdCBtaW1lID0gcmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpID8/IFwiaW1hZ2UvcG5nXCI7XG4gICAgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGBkYXRhOiR7bWltZX07YmFzZTY0LCR7YnRvYShiaW4pfWApO1xuICB9XG4gIGlmICh0eXBlb2YgZmxhZ3MuZmlsZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUoZmxhZ3MuZmlsZSkuYXJyYXlCdWZmZXIoKSk7XG4gICAgbGV0IGJpbiA9IFwiXCI7XG4gICAgZm9yIChjb25zdCBiIG9mIGJ5dGVzKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgICByZXR1cm4gb3B0aW1pemVJbWFnZURhdGFVcmwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke2J0b2EoYmluKX1gKTtcbiAgfVxuICBpZiAodHlwZW9mIGZsYWdzLnNyYyA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGZsYWdzLnNyYyk7XG4gIC8vIOKblCBSRUdJU1RFUiBBMSDigJQgVEhFIERJU0pVTkNUSU9OIElTIGBjaG9pY2VzYCwgTk9UIEEgU0VOVEVOQ0UuIFRocmVlIGZsYWdzXG4gIC8vIGFueSBPTkUgb2Ygd2hpY2ggc2F0aXNmaWVzIHRoaXMgaXMgZXhhY3RseSBhIHJvdXRpbmcgZGVjaXNpb246IHRoZSBjYWxsZXJcbiAgLy8gKHVzdWFsbHkgYW4gYWdlbnQpIGhhcyB0byBwaWNrIG9uZSwgYW5kIHBpY2tpbmcgZnJvbSBwcm9zZSBtZWFucyBwYXJzaW5nXG4gIC8vIHByb3NlLiBgR0VOX1NSQ19GTEFHU2AgaXMgdGhlIHNldCB0aGUgYnJhbmNoZXMgYWJvdmUgcmVhZCwgYW5kXG4gIC8vIGBjbGkudGVzdC50c2AgYmluZHMgdGhlIHR3byBzbyBhIGZvdXJ0aCBzb3VyY2UgY2Fubm90IGJlIGFkZGVkIHRvIG9uZS5cbiAgZGllKFwiZ2VuOiBhIHNvdXJjZSBpcyByZXF1aXJlZFwiLCBcInVzYWdlXCIsIHtcbiAgICBoaW50OiBgcGFzcyBvbmUgb2YgJHtHRU5fU1JDX0ZMQUdTLm1hcCgoaykgPT4gYC0tJHtrfWApLmpvaW4oXCIgXCIpfWAsXG4gICAgY2hvaWNlczogR0VOX1NSQ19GTEFHUy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgbGV0IHN0YXR1czogbnVtYmVyO1xuICBsZXQgZGF0YTogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICAoeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgbXNnKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIGBjbG9zZWAgY2F1c2VzIEJ1bi5zZXJ2ZSB0byBzdG9wIGltbWVkaWF0ZWx5IOKAlCB0aGUgY29ubmVjdGlvbiByZXNldHNcbiAgICAvLyBiZWZvcmUgdGhlIDIwMCByZXNwb25zZSBpcyBmbHVzaGVkLiBUcmVhdCBFQ09OTlJFU0VUIG9uIGNsb3NlIGFzIHN1Y2Nlc3MuXG4gICAgLy8gT05MWSBhIHJlc2V0OiBhIHJlZnVzZWQgY29ubmVjdGlvbiAoc3RhbGUgcG9pbnRlciwgZGFlbW9uIGFscmVhZHkgZ29uZSlcbiAgICAvLyBpcyBhIHRyYW5zcG9ydCBmYWlsdXJlIGxpa2UgYW55IG90aGVyIGFuZCByaWRlcyB0aGUgaW50ZXJuYWwgZW52ZWxvcGUg4oCUXG4gICAgLy8gdGhlIHJldmlldyBmb3VuZCB0aGUgb2xkIGNhdGNoLWFsbCByZXBvcnRpbmcge29rOnRydWV9IGFnYWluc3QgYSBkZWFkIHBvcnQuXG4gICAgY29uc3QgY29kZSA9IGVyciAmJiB0eXBlb2YgZXJyID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGVyciA/IFN0cmluZyhlcnIuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSkge1xuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcImNtZFwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgc2VudDogbXNnLnR5cGUgfSk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgZGFlbW9uQXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKGZsYWdzLnRpdGxlKSBkYWVtb25BcmdzLnB1c2goXCItLXRpdGxlXCIsIFN0cmluZyhmbGFncy50aXRsZSkpO1xuICBpZiAoZmxhZ3MuaW50ZW50KSBkYWVtb25BcmdzLnB1c2goXCItLWludGVudFwiLCBTdHJpbmcoZmxhZ3MuaW50ZW50KSk7XG4gIGlmIChmbGFncy50aW1lb3V0KSBkYWVtb25BcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgU3RyaW5nKGZsYWdzLnRpbWVvdXQpKTtcbiAgaWYgKGZsYWdzLnJlc3RvcmUpIGRhZW1vbkFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBTdHJpbmcoZmxhZ3MucmVzdG9yZSkpO1xuICAvLyBUaGUgdXNlcidzIHByb2plY3QgZGlyIOKAlCBjYXB0dXJlZCBoZXJlIGJlY2F1c2UgdGhlIGRhZW1vbiBzcGF3bnMgd2l0aCBhXG4gIC8vIHBpbm5lZCBjd2QgKGRhZW1vbkN3ZCgpKSwgc28gaXQgY2FuJ3QgcmVhZCB0aGUgcmVhbCBjd2QgaXRzZWxmLlxuICBkYWVtb25BcmdzLnB1c2goXCItLXByb2plY3RcIiwgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgLy8gbm9kZTpjaGlsZF9wcm9jZXNzIChub3QgQnVuLnNwYXduKSBpcyBkZWxpYmVyYXRlOiB0aGUgZGFlbW9uIG11c3QgU1VSVklWRVxuICAvLyB0aGlzIENMSSBwcm9jZXNzIGV4aXRpbmcsIHdoaWNoIG5lZWRzIGBkZXRhY2hlZDogdHJ1ZWAgKyBgdW5yZWYoKWAuXG4gIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQW5kIGNoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzpcbiAgLy8gbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgYEVOT0VOVCDigKYgcG9zaXhfc3Bhd24gJ2J1bidgLCB3aGljaCBuYW1lcyB0aGVcbiAgLy8gb25lIHRoaW5nIHRoYXQgaXMgZmluZS4gTWVhc3VyZWQgYnkgY2Fzc2FuZHJhIGF0IGEgZGVwcy1mcmVlIGRlc3RpbmF0aW9uXG4gIC8vIHdpdGggZGlzdC9pbmRleC5odG1sIHJlbW92ZWQgKGNvbW1zICMxMjY1KTogYSBjb2xkIGFnZW50IHJlYWRzIHRoYXQgYW5kXG4gIC8vIHJlaW5zdGFsbHMgYnVuLiBOYW1lIHRoZSByZWFsIGFic2VuY2UgaW5zdGVhZC5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKSB7XG4gICAgZGllKFxuICAgICAgYGdsYW1vdXIgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OlxuICAgICAgICAgIFwiZGV2IG1vZGUgd2FzIHJlc29sdmVkIChubyBkaXN0L2luZGV4Lmh0bWwgYXQgdGhlIHNraWxsIHJvb3QgYW5kIG5vIFNQRUxMQk9PS19TVVJGQUNFX01PREU9cmVsZWFzZSksIFwiICtcbiAgICAgICAgICBcInNvIHRoZSBkYWVtb24gbXVzdCBydW4gZnJvbSBzcmMvZ2xhbW91ci8sIHdoaWNoIGEgc291cmNlLWZyZWUgaW5zdGFsbCBkb2VzIG5vdCBoYXZlLiBcIiArXG4gICAgICAgICAgXCJFaXRoZXIgdGhlIHNoaXBwZWQgZGlzdC8gaXMgbWlzc2luZyAocmVpbnN0YWxsIHRoZSBzcGVsbCkgb3IgeW91IGFyZSBpbiBhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dsYW1vdXIvLlwiLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJidW5cIiwgZGFlbW9uQXJncywge1xuICAgIGN3ZCxcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgfSk7XG4gIGNoaWxkLnVucmVmKCk7XG5cbiAgLy8gUmVhZCB0aGUgZGFlbW9uJ3MgZmlyc3Qgc3Rkb3V0IGxpbmUg4oCUIGl0IHByaW50cyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfS5cbiAgLy8gR2VuZXJvdXMgZGVmYXVsdDogdGhlIGZpcnN0IGJ1bmRsZSBidWlsZCBvZiB0aGUgUmVhY3Qgc3VyZmFjZSBjYW4gdGFrZSB0ZW5zXG4gIC8vIG9mIHNlY29uZHMgY29sZCwgYW5kIGEgdG9vLXNob3J0IGhhbmRzaGFrZSBtYWtlcyBgb3BlbmAgcmVwb3J0IGZhaWx1cmUgd2hpbGVcbiAgLy8gdGhlIGRhZW1vbiBhY3R1YWxseSBjb21lcyB1cCBmaW5lLiBPdmVycmlkZSB3aXRoIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz4uXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChTdHJpbmcoZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdKSwgMTApICogMTAwMClcbiAgICAgIDogNDUwMDA7XG4gIGNvbnN0IGluZm8gPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dChcbiAgICAgICgpID0+XG4gICAgICAgIHJlamVjdChcbiAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgZGFlbW9uIHN0YXJ0IHRpbWVvdXQgKCR7c3RhcnRUaW1lb3V0TXMgLyAxMDAwfXMpIOKAlCBmaXJzdCBidW5kbGUgYnVpbGQgY2FuIGJlIHNsb3c7IHJldHJ5IG9yIHBhc3MgLS1zdGFydC10aW1lb3V0IDxzZWNvbmRzPmAsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgIHN0YXJ0VGltZW91dE1zLFxuICAgICk7XG4gICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3R5bGUvbm9Ob25OdWxsQXNzZXJ0aW9uOiBzdGRpbyBcInBpcGVcIiBndWFyYW50ZWVzIHN0ZG91dFxuICAgIGNoaWxkLnN0ZG91dCEub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICBidWYgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IG5sID0gYnVmLmluZGV4T2YoXCJcXG5cIik7XG4gICAgICBpZiAobmwgPj0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgIHJlc29sdmUoYnVmLnNsaWNlKDAsIG5sKS50cmltKCkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgcmVqZWN0KGVycik7XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJleGl0XCIsIChjb2RlKSA9PiB7XG4gICAgICBpZiAoY29kZSAhPT0gbnVsbCAmJiBjb2RlICE9PSAwKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgZGFlbW9uIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfWApKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBkaWUoYGdsYW1vdXIgc2VydmVyIGZhaWxlZCB0byBzdGFydDogJHttc2d9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfSk7XG5cbiAgLy8g4pqgIFJFTEVBU0UgVEhFIERBRU1PTidTIFNURE9VVCBQSVBFLCBvciB0aGlzIENMSSBuZXZlciBleGl0cy5cbiAgLy9cbiAgLy8gYGNoaWxkLnVucmVmKClgIGFib3ZlIHJlbGVhc2VzIHRoZSBDSElMRCBQUk9DRVNTIGhhbmRsZS4gVGhlIHBpcGVkIHN0ZG91dCBpc1xuICAvLyBhIFNFUEFSQVRFIHJlZmZlZCBoYW5kbGUsIGFuZCB0aGUgZGFlbW9uIHJ1bnMgZm9yZXZlciDigJQgc28gb25jZSBgb3BlbmAgc3RvcHNcbiAgLy8gZm9yY2UtZXhpdGluZywgdGhlIHBhcmVudCdzIGV2ZW50IGxvb3Agd2FpdHMgb24gYSBzdHJlYW0gdGhhdCB3aWxsIG5ldmVyXG4gIC8vIGNsb3NlLiBNZWFzdXJlZDogYG9wZW4gLS1uby1vcGVuYCBzdGlsbCBydW5uaW5nIGF0IDkxczsgd2l0aCB0aGlzIGxpbmUsIDFzLlxuICAvL1xuICAvLyBUaGlzIGJlY2FtZSBsaXZlIHdoZW4gUDAgcmVwbGFjZWQgYHByb2Nlc3MuZXhpdChjb2RlKWAgd2l0aCBgcHJvY2Vzcy5leGl0Q29kZWBcbiAgLy8gKyBhIG5hdHVyYWwgcmV0dXJuOiBgcHJvY2Vzcy5leGl0YCBoYWQgYmVlbiBkb2luZyBET1VCTEUgRFVUWSwgZHJhaW5pbmcgc3Rkb3V0XG4gIC8vIChicm9rZW4g4oCUIGl0IHRydW5jYXRlZCBhdCA2NSw1MzYpIEFORCB0ZXJtaW5hdGluZyBkZXNwaXRlIGEgbGl2ZSBjaGlsZCBwaXBlXG4gIC8vIChsb2FkLWJlYXJpbmcsIGFuZCB1bm5vdGljZWQpLiBSZW1vdmluZyBpdCBmaXhlZCB0aGUgZmlyc3QgYW5kIGV4cG9zZWQgdGhlXG4gIC8vIHNlY29uZC4gYGpvaW4udHNgIGhhcyB0aGUgc2FtZSBzaGFwZSBhbmQgaXMgZGVsaWJlcmF0ZWx5IE5PVCBjb252ZXJ0ZWQuXG4gIC8vXG4gIC8vIGB1bnJlZigpYCByYXRoZXIgdGhhbiBgZGVzdHJveSgpYDogYm90aCBtZWFzdXJlZCBjbGVhbiwgYW5kIHVucmVmIGlzIHRoZVxuICAvLyBjb25zZXJ2YXRpdmUgb25lIOKAlCBpdCBsZWF2ZXMgdGhlIHN0cmVhbSB1c2FibGUgYW5kIG9ubHkgc3RvcHMgaXQgaG9sZGluZyB0aGVcbiAgLy8gbG9vcC4gVGhlIGhhbmRzaGFrZSBpcyB0aGUgc29sZSByZWFkLCBzbyBub3RoaW5nIGRvd25zdHJlYW0gbmVlZHMgaXQuXG4gIC8vIOKaoCBOT1QgYGluc3RhbmNlb2YgU29ja2V0YC4gTUVBU1VSRUQgdW5kZXIgQnVuOiB0aGlzIHBpcGUgaXMgYSBwbGFpblxuICAvLyBgUmVhZGFibGVgIChjb25zdHJ1Y3RvciBgUmVhZGFibGVgLCBgaW5zdGFuY2VvZiBuZXQuU29ja2V0YCBmYWxzZSkgdGhhdFxuICAvLyBub25ldGhlbGVzcyBjYXJyaWVzIGB1bnJlZmAg4oCUIG5vZGUncyB0eXBpbmdzIGRlY2xhcmUgaXQgb25seSBvbiBgU29ja2V0YCxcbiAgLy8gaGVuY2UgVFMyMzM5LiBBIFNvY2tldCBndWFyZCB3b3VsZCBzaWxlbnRseSBza2lwIHRoZSB1bnJlZiBhbmQgYnJpbmcgYmFja1xuICAvLyB0aGUgOTEgcyBoYW5nIGFib3ZlLCBzbyB0aGUgY2hlY2sgaXMgZm9yIHRoZSBNRVRIT0QsIGFuZCBpdHMgYWJzZW5jZSBpcyBhXG4gIC8vIG5hbWVkIHRocm93IOKAlCB0aGUgc2FtZSBjcmFzaCB0aGUgb2xkIGAhYCB3b3VsZCBoYXZlIHByb2R1Y2VkLCBub3cgc2F5aW5nIHdoeS5cbiAgY29uc3Qgb3V0ID0gY2hpbGQuc3Rkb3V0O1xuICBpZiAoIW91dCB8fCAhKFwidW5yZWZcIiBpbiBvdXQpIHx8IHR5cGVvZiBvdXQudW5yZWYgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcImdsYW1vdXI6IHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSBoYXMgbm8gdW5yZWYoKTsgYG9wZW5gIHdvdWxkIG5ldmVyIGV4aXRcIik7XG4gIH1cbiAgb3V0LnVucmVmKCk7XG5cbiAgbGV0IHBhcnNlZDogeyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmcgfTtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGluZm8pIGFzIHR5cGVvZiBwYXJzZWQ7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7aW5mb31gLCBcImludGVybmFsXCIpO1xuICB9XG5cbiAgcHJpbnRKc29uKHBhcnNlZCk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICAvLyBQbGF0Zm9ybSBvcGVuZXIg4oCUIG9wZW4gdGhlIGJyb3dzZXJcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW3BhcnNlZC51cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb24/OiBzdHJpbmcsIGZ1bGwgPSBmYWxzZSkge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCJcIiA6IFwiP2xlYW49MVwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJzdGF0ZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbi8qKlxuICogVGhlIGV2ZW50IHRhaWwg4oCUIE9ORSBDQUxMIGludG8gdGhlIGhvdXNlJ3Mgc2hhcmVkIFNTRSBjbGllbnRcbiAqIChgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgKSwgd2hlcmUgdGhlIHJlY29ubmVjdCBsb29wLCB0aGUgc3BlYy1jb3JyZWN0XG4gKiBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmQgdGhlIGRyYWluZWQgZXhpdCBsaXZlIG9uY2VcbiAqIGZvciBldmVyeSBzcGVsbC5cbiAqXG4gKiDim5QgKipUSElTIElTIFdIRVJFIENFTlNVUyBERUZFQ1QgQjUgRElFUyBCWSBDT05TVFJVQ1RJT04uKiogVGhlIGxvb3AgdGhpc1xuICogcmVwbGFjZXMgc2V0IGBsZXQgZGVsYXkgPSAyNTBgIChgY2xpLnRzOjYyM2AgYmVmb3JlIHRoZSBwb3J0KSBhbmQgdGhlbiByZXNldFxuICogaXQgdG8gMjUwIG9uIGV2ZXJ5IFNVQ0NFU1NGVUwgT1BFTiAoYDo2NjdgKSDigJQgc28gYSBkYWVtb24gdGhhdCBhY2NlcHRzIGFcbiAqIGNvbm5lY3Rpb24gYW5kIGltbWVkaWF0ZWx5IGRyb3BzIGl0IHdhcyByZWNvbm5lY3RlZCBhZ2FpbnN0IGF0IGEgQ09OU1RBTlRcbiAqIDI1MCBtcywgZm9yZXZlciwgd2l0aCBubyBncm93dGg6IGEgcmVjb25uZWN0IHN0b3JtIHRoYXQgbG9va3MgbGlrZSBhIGhlYWx0aHlcbiAqIHJldHJ5LiBUaHJlZSBzaXRlcyBkaWQgZ3JvdyB0aGUgZGVsYXkgKGA6NjQyYCwgYDo2NTlgLCBgOjY2NGApIGFuZCBvbmUgZGlkXG4gKiBub3QsIHdoaWNoIGlzIHByZWNpc2VseSB3aHkgYSBoYW5kLXdyaXR0ZW4gbG9vcCBjYW5ub3QgYmUgcmVhc29uZWQgYWJvdXQgZnJvbVxuICogb25lIG9mIGl0cyBicmFuY2hlcy4gKipJdCBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGhlcmUsIGJlY2F1c2UgdGhlcmUgaXMgbm9cbiAqIGxvb3AgbGVmdCB0byBwdXQgaXQgaW4qKiDigJQgdGhlcmUgaXMgb25lIGJhY2tvZmYsIGl0IGRvdWJsZXMgb24gZXZlcnkgZmFpbGVkXG4gKiBhdHRlbXB0LCBhbmQgUGhhc2UgMWEncyBzZWNvbmQgZG9vciAodGhlIHJlc2V0IGJlbG9uZ3MgYXQgdGhlIEZJUlNUIEJZVEUsIG5vdFxuICogYXQgYSBzdWNjZXNzZnVsIG9wZW4pIGlzIGNsb3NlZCBieSB0aGUgc2FtZSBzaW5nbGUgaW1wbGVtZW50YXRpb24uXG4gKlxuICog4puUIGByZXNvbHZlYCBSRS1SRUFEUyBUSEUgU0VTU0lPTiBQT0lOVEVSIE9OIEVWRVJZIEFUVEVNUFQsIHdoaWNoIGlzIHdoYXRcbiAqIGdsYW1vdXIncyBvd24gbG9vcCBkaWQgYW5kIHdoYXQgdGhlIHNoYXJlZCBjbGllbnQgbWFrZXMgc3RydWN0dXJhbDogdGhlIGRhZW1vblxuICogYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQsIHNvIGEgY2FwdHVyZWQgYmFzZSBpcyBhIHRhaWwgdGhhdCBzdXJ2aXZlcyBleGFjdGx5IG9uZVxuICogZGFlbW9uLlxuICpcbiAqIOKblCBBTkQgSVQgR0FJTkVEIEEgV0FUQ0hET0cgSVQgRElEIE5PVCBIQVZFLiBUaGUgb2xkIGxvb3AgaGFkIG5vbmU6IGl0IGJsb2NrZWRcbiAqIG9uIGBhd2FpdCByZWFkZXIucmVhZCgpYCBmb3JldmVyLCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhXG4gKiBOQVQgcmViaW5kIG9yIGEgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgaW4gc2lsZW5jZSB3aXRoIG5vIHdheSBvdXQuXG4gKiBgVEFJTF9JRExFX01TYCBpcyBERVJJVkVEIGZyb20gZ2xhbW91cidzIG93biBoZWFydGJlYXQgKGAuL2hlYXJ0YmVhdC50c2ApLFxuICogbmV2ZXIgY29waWVkIGZyb20gYSBzaWJsaW5nIOKAlCBhc3Ryb2xhYmUgbWVhc3VyZWQgd2hhdCBhIGNvcGllZCBudW1iZXIgY29zdHMuXG4gKlxuICogVGhlIHBpbiwgdGhlIGdyb3VuZGluZyBhbmNob3IgYW5kIHRoZSBcIm91ciBzZXNzaW9uIHdlbnQgYXdheVwiIGV4aXQgYXJlIGFsbFxuICogcHJlc2VydmVkIHZlcmJhdGltOiB0aGUgRklSU1QgcmVzb2x2ZWQgc2Vzc2lvbiBpcyBwaW5uZWQgZm9yIHRoZSBsaWZlIG9mIHRoZVxuICogd2F0Y2gsIHRoZSBncm91bmRpbmcgbGluZSBuYW1lcyB0aGF0IGJpbmRpbmcgb25jZSwgYW5kIGEgcG9pbnRlciB0aGF0XG4gKiBkaXNhcHBlYXJzIEFGVEVSIHdlIHdlcmUgYm91bmQgZW5kcyB0aGUgd2F0Y2ggYXQgMCDigJQgYSBjb21wbGV0ZWQgd2F0Y2gsIG5vdCBhXG4gKiBmYWlsdXJlLiBBIHBvaW50ZXIgdGhhdCBuZXZlciBhcHBlYXJlZCBrZWVwcyByZXRyeWluZywgd2hpY2ggaXMgd2hhdCBgdGFpbGAnc1xuICogb3duIGhlbHAgcHJvbWlzZXMgKFwid2FpdHMgZm9yIGEgc2Vzc2lvbiwgbmV2ZXIgZXhpdHMgNVwiKS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlQXJnOiBudW1iZXIpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGxldCBncm91bmRlZCA9IGZhbHNlO1xuXG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPHsgaWQ/OiBudW1iZXI7IHR5cGU/OiBzdHJpbmcgfT4oe1xuICAgIHJlc29sdmU6ICgpID0+IHtcbiAgICAgIC8vIHJlYWRTZXNzaW9uIGRpZXMgb24gYSBDT1JSVVBUIHBvaW50ZXIgYW5kIHJldHVybnMgbnVsbCBvbmx5IGZvciBhXG4gICAgICAvLyBnZW51aW5lbHkgYWJzZW50IG9uZSDigJQgdGhlIEVOT0VOVCBydWxlLiBUaGF0IGBkaWVgIG5vdyBUSFJPV1MsIGFuZCB0aGVcbiAgICAgIC8vIHRocm93IGxlYXZlcyB0aGUgdGFpbCB0aHJvdWdoIG1haW4ncyBmdW5uZWwgaW5zdGVhZCBvZiBleGl0aW5nIGZyb20gdGhyZWVcbiAgICAgIC8vIGZyYW1lcyBkb3duIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLiBJdCBpcyBEOCdzIGF1ZGl0IHBheWluZyBmb3IgaXRzZWxmOlxuICAgICAgLy8gdGhpcyBpcyB0aGUgb25lIGRpZS1yZWFjaGFibGUgY2FsbCB0aGUgc2hhcmVkIGNsaWVudCBpbnZva2VzIG9uIGEgc2NoZWR1bGUuXG4gICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkOyAvLyBwaW4gdG8gdGhlIGZpcnN0IHNlc3Npb24gd2UgcmVzb2x2ZWRcbiAgICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgICAvLyBncm91bmRpbmcgbGluZSDigJQgcGFyc2VhYmxlIGluIE1vbml0b3IsIG5hbWVzIHRoZSBiaW5kaW5nIHNvIGEgd3JvbmdcbiAgICAgICAgLy8gc2Vzc2lvbi9wb3J0IGlzIG9idmlvdXMgaW5zdGVhZCBvZiBzaWxlbnQuXG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgIH0sXG4gICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgaWYgKGV2ZXJSZXNvbHZlZCkgcmV0dXJuIFwic3RvcFwiOyAvLyBvdXIgcGlubmVkIHNlc3Npb24gd2VudCBhd2F5IOKGkiBkb25lXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgcmV0dXJuIFwicmV0cnlcIjtcbiAgICB9LFxuICAgIHBhdGg6IFwiL2V2ZW50c1wiLFxuICAgIHNpbmNlOiBzaW5jZUFyZyxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiBldi5pZCxcbiAgICB0ZXJtaW5hbDogKGV2KSA9PiBldi50eXBlID09PSBcImNsb3NlZFwiLFxuICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgIG9uQ29tbWVudDogKCkgPT4gXCI6IGdsYW1vdXIta2VlcGFsaXZlXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjbWRJbmZvKHNlc3Npb24/OiBzdHJpbmcpIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgZ2xhbW91ciBzZXNzaW9uXCIsIFwibm90X2ZvdW5kXCIsIE5PX1NFU1NJT05fSElOVCk7XG4gIHByaW50SnNvbihzKTtcbn1cblxuLy8gVGhlIHBsdWdpbiBtYW5pZmVzdCBpcyB0aGUgb25lIHZlcnNpb24gc291cmNlOyB0aGUgQ0xJIHJlYWRzIGl0IHJhdGhlciB0aGFuXG4vLyBtaXJyb3JpbmcgdGhlIG51bWJlciAoYXN0cm9sYWJlJ3MgcGF0dGVybiwgdmlhIG1pbmQtbWFwcGVyKS4gTGF5b3V0LWRlcGVuZGVudCxcbi8vIHNvIGFic2VuY2UgZGVncmFkZXMgdG8gXCJ1bmtub3duXCIgaW5zdGVhZCBvZiBpbnZlbnRpbmcgb25lLlxuZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihTS0lMTF9ST09ULCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpLCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcbiAgICBpZiAodHlwZW9mIHBrZy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSByZXR1cm4geyBuYW1lOiBcImdsYW1vdXJcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoIHRvIHVua25vd24gKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcImdsYW1vdXJcIiwgdmVyc2lvbjogXCJ1bmtub3duXCIgfTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFLCBBUyBBIFNUUlVDVFVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgZGlzcGF0Y2hlciwgdGhlIHN0YWdlLTIgZmxhZyBjaGVjaywgdGhlIHJlamVjdGlvbnMnIGBjaG9pY2VzYCwgdGhlXG4vLyBoZWxwIHRleHQgYW5kIHRoZSBgc2NoZW1hYCBkZWNsYXJhdGlvbiBhbGwgd2FsayBUSElTLiBJdCByZXBsYWNlZCBhIGJhcmVcbi8vIGBzd2l0Y2hgLCB3aGljaCBvbmx5IHRoZSBkaXNwYXRjaGVyIGNvdWxkIHdhbGsg4oCUIGhlbHAgYW5kIHRoZSBzd2l0Y2ggaGFkXG4vLyBhbHJlYWR5IGRyaWZ0ZWQgb25jZSAodGhlIGBvcGVuYCByb3cgbG9zdCAtLXN0YXJ0LXRpbWVvdXQpIOKAlCBhbmQgYSBzY2hlbWFcbi8vIGVtaXR0ZWQgZnJvbSBhbnl0aGluZyBvdGhlciB0aGFuIHRoZSBzdHJ1Y3R1cmUgdGhhdCByb3V0ZXMgdGhlIGJlaGF2aW91clxuLy8gaXMgYSBkb2N1bWVudCB0aGF0IGxpZXMgYXMgc29vbiBhcyBhbnlvbmUgZWRpdHMgdGhlIG90aGVyIHNpZGUuXG4vL1xuLy8gYGZsYWdzYCBpcyB0aGUgdmVyYidzIE9XTiBhY2NlcHRlZCBzZXQsIHR5cGVkIGFnYWluc3QgdGhlIHJlZ2lzdHJ5LCBzbyBhXG4vLyB2ZXJiIGNhbm5vdCBuYW1lIGEgZmxhZyB0aGUgcGFyc2VyIGRvZXMgbm90IGRlZmluZS4gYHNlc3Npb25gIGlzIGxpc3RlZFxuLy8gcGVyIHZlcmIgcmF0aGVyIHRoYW4gbWVyZ2VkIGFzIGEgZ2xvYmFsOiBgb3BlbmAgc3Bhd25zIGEgc2Vzc2lvbiBpbnN0ZWFkIG9mXG4vLyB0YXJnZXRpbmcgb25lLCBhbmQgYGhlbHBgIHRha2VzIG5vdGhpbmcuXG50eXBlIEZsYWcgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgZmxhZ3M6IHJlYWRvbmx5IEZsYWdbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIC8vIFRoZSBvbmUtbGluZSBkZXNjcmlwdGlvbiBoZWxwIHByaW50cyBiZXNpZGUgdGhlIHVzYWdlLlxuICBkZXNjcmliZTogc3RyaW5nO1xuICAvLyDim5QgQSBWRVJCIE1BWSBSRVRVUk4gQU4gRVhJVCBDT0RFLCBhbmQgZXhhY3RseSBvbmUgZG9lcy4gYHRhaWxgIGlzIGEgV0FUQ0g6XG4gIC8vIGl0IGVuZHMgd2hlbiB0aGUgZGFlbW9uIHNheXMgYGNsb3NlZGAsIHdoZW4gaXRzIHBpbm5lZCBzZXNzaW9uIGdvZXMgYXdheSwgb3JcbiAgLy8gd2hlbiBhIHNpZ25hbCBhcnJpdmVzLCBhbmQgdGhlIHNoYXJlZCBjbGllbnQgKGBraXQvd2lyZS90YWlsRXZlbnRzLnRzYClcbiAgLy8gUkVUVVJOUyB0aGF0IGNvZGUgcmF0aGVyIHRoYW4gY2FsbGluZyBgcHJvY2Vzcy5leGl0YCBmcm9tIGluc2lkZSBpdHMgb3duXG4gIC8vIGxvb3Ag4oCUIHdoaWNoIGlzIHRoZSB3aG9sZSBvZiB0aGUgUDBmIGRyYWluIHNjYXIuIGB2b2lkYCB0aGVyZWZvcmUgaGFzIHRvIG1lYW5cbiAgLy8gXCIwXCIsIG5vdCBcIm5vIG9waW5pb25cIjogZGlzcGF0Y2ggY29lcmNlcyBiZWxvdywgc28gZXZlcnkgb3RoZXIgcm93IGlzXG4gIC8vIHVuY2hhbmdlZCBhbmQgb25seSB0aGUgdmVyYiB0aGF0IGhhcyBhIGNvZGUgaGFzIHRvIHNheSBzby5cbiAgcnVuOiAoXG4gICAgcG9zOiBzdHJpbmdbXSxcbiAgICBmbGFnczogRmxhZ3MsXG4gICAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICApID0+IFByb21pc2U8bnVtYmVyPiB8IFByb21pc2U8dm9pZD4gfCBudW1iZXIgfCB2b2lkO1xuICAvLyDimqAgYHZvaWRgLCBub3QgYHVuZGVmaW5lZGAsIGFuZCB0aGF0IGlzIHRoZSBjb250cmFjdCBhYm92ZSByYXRoZXIgdGhhbiBhXG4gIC8vIGxvb3NlbmluZzogZXZlcnkgaGFuZGxlciB0aGF0IHJldHVybnMgYHBvc3RDbWQoLi4uKWAgcmV0dXJucyBgUHJvbWlzZTx2b2lkPmAsXG4gIC8vIGFuZCBgdW5kZWZpbmVkYCByZWZ1c2VkIGFsbCBzZXZlbnRlZW4gb2YgdGhlbSAodHlwZS1kZWJ0IFBoYXNlIDNjKS4gRGlzcGF0Y2hcbiAgLy8gbWFwcyBhbnkgbm9uLW51bWJlciB0byAwLCBzbyBgdm9pZGAgaXMgZXhhY3RseSB0aGUgc2V0IGl0IGFjY2VwdHMg4oCUIGFuZCBhXG4gIC8vIGhhbmRsZXIgcmV0dXJuaW5nIGEgc3RyaW5nIG9yIGFuIG9iamVjdCBpcyBzdGlsbCBhIHR5cGUgZXJyb3IuIFNwZWxsZWQgYXNcbiAgLy8gdHdvIGBQcm9taXNlYHMgYmVjYXVzZSBiaW9tZSdzIG5vQ29uZnVzaW5nVm9pZFR5cGUgcmVmdXNlcyBgdm9pZGAgaW5zaWRlIGFcbiAgLy8gdW5pb24gdHlwZSBhcmd1bWVudDsgdGhlIGFjY2VwdGVkIHNldCBpcyB0aGUgc2FtZS5cbn07XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5jb25zdCBQID0ge1xuICB0ZXh0OiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICBpZDogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgaWRUZXh0OiBbXG4gICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gIF0sXG4gIGlkczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gIG5vbmU6IFtdIGFzIFBvc2l0aW9uYWxTcGVjW10sXG59IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCBQb3NpdGlvbmFsU3BlY1tdPjtcblxuY29uc3QgQ09NTUFORFM6IENvbW1hbmRTcGVjW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5cIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJpbnRlbnRcIiwgXCJuby1vcGVuXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIiwgXCJyZXN0b3JlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwic3Bhd24gYSBzZXNzaW9uIChvcGVucyB0aGUgYnJvd3Nlcik7IHByaW50cyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfVwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzKSA9PiBjbWRPcGVuKGZsYWdzKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFpbFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzaW5jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcIlNTRSB1c2VyIGV2ZW50cyDihpIgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yOyB3YWl0cyBmb3IgYSBzZXNzaW9uLCBuZXZlciBleGl0cyA1KVwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgY21kVGFpbChzZXNzaW9uLCB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhdGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZnVsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcImxlYW4gc3RhdGUgc25hcHNob3QgKC0tZnVsbCBmb3IgcmF3IGluY2wuIGJhc2U2NClcIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImludGVudFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBQLnRleHQsXG4gICAgZGVzY3JpYmU6IFwidXBkYXRlIHRoZSBzZXNzaW9uIGludGVudFwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJpbnRlbnRcIiwgdGV4dDogcG9zLmpvaW4oXCIgXCIpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbm5vdGF0ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkVGV4dCxcbiAgICBkZXNjcmliZTogXCJ3cml0ZSBhZ2VudCBhbm5vdGF0aW9uIG9udG8gYSBsaWJyYXJ5IGl0ZW1cIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgW2lkLCAuLi53b3Jkc10gPSBwb3M7XG4gICAgICByZXR1cm4gcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiaXRlbS5hbm5vdGF0ZVwiLCBpZCwgYWdlbnQ6IHdvcmRzLmpvaW4oXCIgXCIpIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNheVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJraW5kXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLnRleHQsXG4gICAgZGVzY3JpYmU6IFwicG9zdCBhZ2VudCBkaWFsb2d1ZSBpbnRvIHRoZSBjb252ZXJzYXRpb24gKC0ta2luZCBpbmZvfHdvcmtpbmd8cmVzdWx0fGVycm9yKVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRTYXlDbWQocG9zLCBmbGFncykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZWN0aW9uXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInN0YXR1c1wiLCBcImNvbnRlbnRcIiwgXCJwcm9tcHRzXCIsIFwiY29sb3JzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImtleVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogJ3NoYXBlIGEgc3R5bGUtZ3VpZGUgc2VjdGlvbiAoLS1wcm9tcHRzIGF8fGI7IC0tY29sb3JzIFwiI2hleDpOYW1lfHwjaGV4Ok5hbWVcIiknLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRTZWN0aW9uQ21kKHBvcywgZmxhZ3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhdHVzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJvbnxvZmZcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNob3cvaGlkZSB0aGUgd29ya2luZyBzcGlubmVyXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IG9uID0gcG9zWzBdID09PSBcIm9uXCI7XG4gICAgICBjb25zdCB0ZXh0ID0gcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpIHx8IHVuZGVmaW5lZDtcbiAgICAgIHJldHVybiBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogb24sIC4uLih0ZXh0ID8geyB0ZXh0IH0gOiB7fSkgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2VuXCIsXG4gICAgZmxhZ3M6IFtcbiAgICAgIC4uLlNFU1NJT04sXG4gICAgICBcInVybFwiLFxuICAgICAgXCJmaWxlXCIsXG4gICAgICBcInNyY1wiLFxuICAgICAgXCJwcm9tcHRcIixcbiAgICAgIFwibW9kZWxcIixcbiAgICAgIFwicm91bmRcIixcbiAgICAgIFwic2VlZFwiLFxuICAgICAgXCJjb3N0XCIsXG4gICAgICBcImxhYmVsXCIsXG4gICAgICBcImN1c3RvbVwiLFxuICAgIF0sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwicG9zdCBhIGdlbmVyYXRlZCBpbWFnZSAob25lIG9mIC0tdXJsfC0tZmlsZXwtLXNyYywgYW5kIC0tcHJvbXB0IC0tbW9kZWwgLS1yb3VuZCByZXF1aXJlZClcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgLy8g4puUIGBjaG9pY2VzYCBOQU1FUyBXSEFUIElTIE1JU1NJTkcsIEZJTFRFUkVEIEZST00gVEhFIFJFUVVJUkVEIFNFVCDigJRcbiAgICAgIC8vIHNvIHRoZSBzZXQgdGhlIG1lc3NhZ2UgYXNzZXJ0cyBhbmQgdGhlIHNldCB0aGUgY2hlY2sgZW5mb3JjZXMgY2Fubm90XG4gICAgICAvLyBiZSB0d28gbGlzdHMuIGBnZW4gLS1wcm9tcHQgcCAtLW1vZGVsIG1gIGFuc3dlcnMgYFtcIi0tcm91bmRcIl1gLCB3aGljaFxuICAgICAgLy8gaXMgb25lIHJlcGFpciByYXRoZXIgdGhhbiB0aHJlZSB0byByZS1yZWFkLlxuICAgICAgY29uc3QgbWlzc2luZ0dlbiA9IEdFTl9SRVFVSVJFRF9GTEFHUy5maWx0ZXIoKGspID0+ICFmbGFnc1trXSkubWFwKChrKSA9PiBgLS0ke2t9YCk7XG4gICAgICBpZiAobWlzc2luZ0dlbi5sZW5ndGggPiAwKVxuICAgICAgICBkaWUoYHVzYWdlOiAke3VzYWdlT2YoZmluZENvbW1hbmQoXCJnZW5cIikgYXMgQ29tbWFuZFNwZWMpfWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGhpbnQ6IGBtaXNzaW5nIHJlcXVpcmVkICR7bWlzc2luZ0dlbi5qb2luKFwiIFwiKX1gLFxuICAgICAgICAgIGNob2ljZXM6IG1pc3NpbmdHZW4sXG4gICAgICAgIH0pO1xuICAgICAgY29uc3Qgc3JjID0gYXdhaXQgcmVzb2x2ZUdlblNyYyhmbGFncyk7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkR2VuQ21kKHNyYywgZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJnZW4tY29zdFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJjb3N0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkLFxuICAgIGRlc2NyaWJlOiBcImJhY2tmaWxsIGEgZ2VuZXJhdGVkIGltYWdlJ3MgY29zdCAoLS1jb3N0IDxuPiByZXF1aXJlZClcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBjb3N0ID0gdHlwZW9mIGZsYWdzLmNvc3QgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VGbG9hdChmbGFncy5jb3N0KSA6IE51bWJlci5OYU47XG4gICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjb3N0KSlcbiAgICAgICAgZGllKGB1c2FnZTogJHt1c2FnZU9mKGZpbmRDb21tYW5kKFwiZ2VuLWNvc3RcIikgYXMgQ29tbWFuZFNwZWMpfSDigJQgLS1jb3N0IG11c3QgYmUgYSBudW1iZXJgKTtcbiAgICAgIHJldHVybiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkR2VuQ29zdENtZChwb3MsIGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2VuLW1ldGFcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwicHJvbXB0XCIsIFwiY3VzdG9tXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkLFxuICAgIGRlc2NyaWJlOiBcImJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlbiAoLS1wcm9tcHQgYW5kL29yIC0tY3VzdG9tKVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIC8vIEEgRElTSlVOQ1RJT04sIHNvIGBjaG9pY2VzYCBpcyB0aGUgd2hvbGUgc2V0IHJhdGhlciB0aGFuIHRoZSBtaXNzaW5nXG4gICAgICAvLyBoYWxmOiBlaXRoZXIgb25lIHNhdGlzZmllcyB0aGlzLCBhbmQgdGhlIGNhbGxlciBwaWNrcy5cbiAgICAgIGlmICghR0VOX01FVEFfRkxBR1Muc29tZSgoaykgPT4gZmxhZ3Nba10gIT09IHVuZGVmaW5lZCkpXG4gICAgICAgIGRpZShgdXNhZ2U6ICR7dXNhZ2VPZihmaW5kQ29tbWFuZChcImdlbi1tZXRhXCIpIGFzIENvbW1hbmRTcGVjKX1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBoaW50OiBgZ2l2ZSBvbmUgb2YgJHtHRU5fTUVUQV9GTEFHUy5tYXAoKGspID0+IGAtLSR7a31gKS5qb2luKFwiIFwiKX1gLFxuICAgICAgICAgIGNob2ljZXM6IEdFTl9NRVRBX0ZMQUdTLm1hcCgoaykgPT4gYC0tJHtrfWApLFxuICAgICAgICB9KTtcbiAgICAgIHJldHVybiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkR2VuTWV0YUNtZChwb3MsIGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9jdXNcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwibm90ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5pZHMsXG4gICAgZGVzY3JpYmU6IFwic2NvcGUgdGhlIGZvY3VzIGxlbnMgdG8gdGhlc2UgaXRlbXMgKCsgLS1ub3RlIHRvIGFzaylcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkRm9jdXNDbWQocG9zLCBmbGFncykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdHlsZS1zYXZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibGFiZWxcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImNvZGlmeSB0aGUgY3VycmVudCBzdHlsZSDihpIgcHJvamVjdCB0cmF5XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRTdHlsZVNhdmVDbWQocG9zKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0eWxlLWFyY2hpdmVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidW5hcmNoaXZlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkLFxuICAgIGRlc2NyaWJlOiBcImFyY2hpdmUgKG9yIC0tdW5hcmNoaXZlKSBhIHNhdmVkIHN0eWxlXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCBidWlsZFN0eWxlQXJjaGl2ZUNtZChwb3MsIGZsYWdzKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRyYXlcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcImxpc3QgdGhlIHByb2plY3QncyBzYXZlZCBzdHlsZXNcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgICAgIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZT9sZWFuPTFcIik7XG4gICAgICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJ0cmF5XCIsIHN0YXR1cywgZGF0YSk7XG4gICAgICBwcmludEpzb24oKGRhdGEgYXMgeyBzdGF0ZT86IHsgdHJheT86IHVua25vd25bXSB9IH0pPy5zdGF0ZT8udHJheSA/PyBbXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiY2xvc2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcInNodXQgZG93biB0aGUgc2Vzc2lvblwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIGRpc2NvdmVyeSBKU09OXCIsXG4gICAgcnVuOiAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiBjbWRJbmZvKHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJlbWl0IHRoaXMgQ0xJJ3MgYWNjIGRlY2xhcmF0aW9uICh3YWxrZWQgZnJvbSB0aGUgY29tbWFuZCB0YWJsZSlcIixcbiAgICBydW46ICgpID0+IHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcInNob3cgdGhpcyBtZXNzYWdlXCIsXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgfSxcbiAgfSxcbl07XG5cbi8vIFJvb3QgaW50ZXJjZXB0b3JzIOKAlCB0b2tlbnMgdGhlIFJPT1QgYW5zd2VycyBpdHNlbGYsIGJlZm9yZSBhbnkgdmVyYi4gTm90XG4vLyBjb21tYW5kcyBhbmQgbm90IHJlZ2lzdHJ5IGZsYWdzLCBzbyB0aGV5IGFyZSBkZWNsYXJlZCBleHBsaWNpdGx5IGF0XG4vLyBwYXRoIFtdIHJhdGhlciB0aGFuIHdhbGtlZCBwYXN0LlxuY29uc3QgUk9PVF9JTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG5jb25zdCBmaW5kQ29tbWFuZCA9ICh0b2tlbjogc3RyaW5nKTogQ29tbWFuZFNwZWMgfCB1bmRlZmluZWQgPT5cbiAgQ09NTUFORFMuZmluZCgoYykgPT4gYy5uYW1lID09PSB0b2tlbik7XG5cbi8vIFRoZSB2ZXJiIHRva2VuIGluIGEgcmF3IGFyZ3YsIGZvdW5kIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsIGZpbmQgaXQ6IGFcbi8vIHN0cmluZyBmbGFnIENPTlNVTUVTIHRoZSBuZXh0IHRva2VuIChgLS1zZXNzaW9uIGFiYyBzYXlgIOKGkiBcInNheVwiLCBub3Rcbi8vIFwiYWJjXCIpLCBgLS1rZXk9dmFsdWVgIGNvbnN1bWVzIG5vdGhpbmcsIGEgYmFyZSBgLS1gIGVuZHMgZmxhZyBwYXJzaW5nLCBhbmRcbi8vIHRoZSBmaXJzdCB0b2tlbiBsZWZ0IHN0YW5kaW5nIGlzIHRoZSB2ZXJiLiBVc2VkIG9ubHkgdG8gbmFtZSB0aGUgdmVyYiBvbiBhXG4vLyByZWplY3Rpb24gcmFpc2VkIEJFRk9SRSB0aGUgcGFyc2Ugc3VjY2VlZHMgKGEgc3RyYXkgZmxhZykg4oCUIHRoZSBwYXJzZSdzIG93blxuLy8gcG9zaXRpb25hbHMgYXJlIHRoZSB0cnV0aCBhZnRlcndhcmRzLiBBIG5haXZlIFwiZmlyc3Qgbm9uLWRhc2ggdG9rZW5cIiB3YXNcbi8vIHRoZSByZXZpZXcncyBmaW5kaW5nOiBpdCBuYW1lZCBhIGZsYWcncyB2YWx1ZSBhcyB0aGUgdmVyYi5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJiVG9rZW4oYXJndjogc3RyaW5nW10pOiBzdHJpbmcgfCBudWxsIHtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmd2Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYSA9IGFyZ3ZbaV0gYXMgc3RyaW5nO1xuICAgIGlmIChhID09PSBcIi0tXCIpIHJldHVybiBhcmd2W2kgKyAxXSA/PyBudWxsO1xuICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItLVwiKSkge1xuICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGtleSA9IGEuc2xpY2UoMikgYXMga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xuICAgICAgaWYgKGtleSBpbiBDTElfT1BUSU9OUyAmJiBDTElfT1BUSU9OU1trZXldLnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIFRoZSBkZXJpdmVkIHZpZXdzIHRoZSB0ZXN0cyBhbmQgdGhlIHJlamVjdGlvbnMgcmVhZC4gVkVSQlMgaXMgdGhlIHJvc3Rlcjtcbi8vIFZFUkJfU1BFQyBpcyBlYWNoIHZlcmIncyBhY2NlcHRlZCBmbGFnczsgZmxhZ3NGb3IgcmVuZGVycyBvbmUgcm93IGFzIHRoZVxuLy8gYGNob2ljZXNgIGEgcmVqZWN0aW9uIGNhcnJpZXMuXG5leHBvcnQgY29uc3QgVkVSQlM6IHJlYWRvbmx5IHN0cmluZ1tdID0gQ09NTUFORFMubWFwKChjKSA9PiBjLm5hbWUpO1xuZXhwb3J0IGNvbnN0IFZFUkJfU1BFQzogUmVjb3JkPHN0cmluZywgcmVhZG9ubHkgRmxhZ1tdPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgQ09NTUFORFMubWFwKChjKSA9PiBbYy5uYW1lLCBjLmZsYWdzXSksXG4pO1xuZXhwb3J0IGNvbnN0IGZsYWdzRm9yID0gKHZlcmI6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gIFsuLi4oZmluZENvbW1hbmQodmVyYik/LmZsYWdzID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuXG4vLyDilIDilIAgaGVscCBhbmQgdGhlIGRlY2xhcmF0aW9uLCBib3RoIHdhbGtlZCBmcm9tIENPTU1BTkRTIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5jb25zdCByZW5kZXJGbGFnID0gKGs6IEZsYWcpOiBzdHJpbmcgPT5cbiAgQ0xJX09QVElPTlNba10udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgWy0tJHtrfV1gIDogYFstLSR7a30gLi5dYDtcblxuY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbn07XG5cbi8vIFRoZSB1c2FnZSBsaW5lOiB2ZXJiLCBwb3NpdGlvbmFscywgdGhlbiB0aGUgdmVyYidzIG93biBmbGFncyAoc2Vzc2lvbiBpc1xuLy8gcmVuZGVyZWQgb25jZSBpbiB0aGUgZm9vdGVyLCBub3Qgb24gZXZlcnkgcm93KS5cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZU9mKHNwZWM6IENvbW1hbmRTcGVjKTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHMgPSBbXG4gICAgc3BlYy5uYW1lLFxuICAgIC4uLnNwZWMucG9zaXRpb25hbHMubWFwKHJlbmRlclBvc2l0aW9uYWwpLFxuICAgIC4uLnNwZWMuZmxhZ3MuZmlsdGVyKChrKSA9PiBrICE9PSBcInNlc3Npb25cIikubWFwKHJlbmRlckZsYWcpLFxuICBdO1xuICByZXR1cm4gcGFydHMuam9pbihcIiBcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJIZWxwKCk6IHN0cmluZyB7XG4gIGNvbnN0IHJvd3MgPSBDT01NQU5EUy5tYXAoKGMpID0+IFt1c2FnZU9mKGMpLCBjLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ucm93cy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICBjb25zdCBib2R5ID0gcm93c1xuICAgIC5tYXAoKFt1c2FnZSwgZGVzY3JpYmVdKSA9PlxuICAgICAgdXNhZ2UubGVuZ3RoIDw9IHdpZHRoXG4gICAgICAgID8gYCAgJHt1c2FnZS5wYWRFbmQod2lkdGgpfSAgJHtkZXNjcmliZX1gXG4gICAgICAgIDogYCAgJHt1c2FnZX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkZXNjcmliZX1gLFxuICAgIClcbiAgICAuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIGBnbGFtb3VyIOKAlCBhIGdyb3VuZGVkIHZpc3VhbCBjb252ZXJzYXRpb24gc3VyZmFjZS5cblxuJHtib2R5fVxuICAke1JPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OXG5cbiAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIGFueSB2ZXJiIHRoYXQgdGFsa3MgdG8gYSBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuXG4gIEVhY2ggdmVyYiBhY2NlcHRzIG9ubHkgdGhlIGZsYWdzIG9uIGl0cyByb3c7IGEgcmVjb2duaXplZCBmbGFnIG9uIHRoZSB3cm9uZ1xuICB2ZXJiIGlzIHJlZnVzZWQsIGFuZCB0aGUgcmVqZWN0aW9uIGxpc3RzIHRoZSB2ZXJiJ3Mgb3duIGZsYWdzLlxuXG4gIE91dHB1dDogZXZlcnkgdmVyYiBwcmludHMgSlNPTiBvbiBzdGRvdXQgYnkgZGVmYXVsdCwgb25lIGRvY3VtZW50IHBlciBhbnN3ZXIg4oCUXG4gIGV4Y2VwdCB0YWlsLCBhIHN0cmVhbSB0aGF0IHByaW50cyBvbmUgSlNPTiBsaW5lIHBlciBldmVudCwgYW5kIGhlbHAsIHdoaWNoIGlzXG4gIHByb3NlLiBGYWlsdXJlcyBhcmUgb25lIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIGFuZCBleGl0IG5vbi16ZXJvICgyID0gdXNhZ2UsXG4gIDEgPSBpbnRlcm5hbCwgNSA9IG5vdCBmb3VuZCwgNiA9IGNvbmZsaWN0KSDigJQgZXhjZXB0IHRhaWwsIHdoaWNoIHdhaXRzIGZvciBhXG4gIHNlc3Npb24gaW5zdGVhZCBvZiBmYWlsaW5nIGFuZCB3cml0ZXMgaXRzIHJldHJ5L2tlZXBhbGl2ZSBub3RlcyB0byBzdGRlcnIgYXNcbiAgJyMnLXByZWZpeGVkIHByb3NlLmA7XG59XG5cbi8vIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjAsIGdlbmVyYXRlZCBieSBXQUxLSU5HIENPTU1BTkRTIGFuZCBDTElfT1BUSU9OUyDigJRcbi8vIHRoZSBzYW1lIHN0cnVjdHVyZXMgdGhlIHBhcnNlciBhbmQgZGlzcGF0Y2hlciBjb25zdW1lIOKAlCBhdCBhbnN3ZXIgdGltZSwgc29cbi8vIGBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcImAgaXMgdHJ1ZSByYXRoZXIgdGhhbiBjbGFpbWVkLiBQaXBlcyBzdHJhaWdodCBpbnRvXG4vLyBgYWNjIGNoZWNrIDxjbGkudHM+IC0tZGVjbGFyYXRpb24gPChjbGkudHMgc2NoZW1hKWAuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGREZWNsYXJhdGlvbigpIHtcbiAgLy8gRXZlcnkgcmVnaXN0cnkgZmxhZyBpcyBhY2NlcHRlZCB0b2RheTsgYSByZWZ1c2FsIGxpc3Qgd291bGQgYWRkXG4gIC8vIHN0YXR1czogXCJyZWZ1c2VkXCIgZW50cmllcyBoZXJlIHRoZSBkYXkgYSB2ZXJiIHJlY29nbmlzZXMtYW5kLWRlY2xpbmVzIG9uZS5cbiAgY29uc3QgYXJnID0gKGs6IEZsYWcpID0+ICh7IG5hbWU6IGAtLSR7a31gLCB0eXBlOiBDTElfT1BUSU9OU1trXS50eXBlLCBzdGF0dXM6IFwidmFsaWRcIiB9KTtcbiAgY29uc3QgY29tbWFuZHM6IHtcbiAgICBwYXRoOiBzdHJpbmdbXTtcbiAgICBhcmdzOiB7IG5hbWU6IHN0cmluZzsgdHlwZTogXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiOyBzdGF0dXM6IHN0cmluZyB9W107XG4gICAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIH1bXSA9IFtcbiAgICB7XG4gICAgICAvLyBwYXRoIFtdIElTIHRoZSByb290OiBvbmUgcmVxdWlyZWQgdG9rZW4gc2VsZWN0aW5nIGEgdmVyYiwgb3IgYW5cbiAgICAgIC8vIGludGVyY2VwdG9yIHRoZSByb290IGFuc3dlcnMgaXRzZWxmLlxuICAgICAgcGF0aDogW10sXG4gICAgICBhcmdzOiBST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgIG5hbWU6IGkubmFtZSxcbiAgICAgICAgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsXG4gICAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgICAgfSkpLFxuICAgICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidmVyYlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICB9LFxuICAgIC4uLkNPTU1BTkRTLm1hcCgoYykgPT4gKHtcbiAgICAgIHBhdGg6IFtjLm5hbWVdLFxuICAgICAgYXJnczogWy4uLmMuZmxhZ3NdLm1hcChhcmcpLFxuICAgICAgcG9zaXRpb25hbHM6IGMucG9zaXRpb25hbHMsXG4gICAgfSkpLFxuICBdO1xuICByZXR1cm4ge1xuICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbXCJzY2hlbWFcIl0gfSxcbiAgICBjb21tYW5kcyxcbiAgfTtcbn1cblxuLy8gRXZlcnkgZmFpbHVyZSBmdW5uZWxzIHRocm91Z2ggaGVyZSBhbmQgUkVUVVJOUyBpdHMgY29kZSwgc28gdGhlIHJ1bnRpbWVcbi8vIGRyYWlucyBzdGRvdXQuIFVuY2F1Z2h0LCBhIGZhaWx1cmUgd291bGQgc3VyZmFjZSBhcyBhIHJhdyBzdGFjayB0cmFjZSBhdCBleGl0XG4vLyAxLCB3aGljaCBpcyBub3QgYSB1c2FnZSBlcnJvciB0byBhbnlvbmUgcmVhZGluZyBpdC5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIFRoZSBob3VzZSBmdW5uZWw6IGByZXBvcnRDbGlFcnJvcmAgd3JpdGVzIHRoZSBlbnZlbG9wZSBhbmQgaGFuZHMgYmFjayB0aGVcbiAgICAvLyB0YXhvbm9teSBleGl0IGNvZGUsIG9yIGBudWxsYCB3aGVuIHRoZSB0aHJvdyB3YXMgbm90IGEgQ2xpRXJyb3IuXG4gICAgY29uc3QgcmVwb3J0ZWQgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAvLyBBIG5hbWVkIGZpbGUgdGhhdCBpcyBub3QgdGhlcmUgKC0tZmlsZSBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIGdsYW1vdXIncyBvd24gZmF1bHQ6IG9uZSBJTlRFUk5BTCBlbnZlbG9wZSwgbmV2ZXIgYVxuICAgIC8vIHN0YWNrIHRyYWNlIOKAlCB0aGUgcHJvY2VzcyBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS5cbiAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgbXNnKSkgPz8gMTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vIFJPT1QgSU5URVJDRVBUT1JTIEZJUlNULCBiZWZvcmUgYW55IGZsYWcgcGFyc2luZyAobWFncGllL2FzdHJvbGFiZVxuICAvLyBwYXR0ZXJuKS4gVGhleSBhcmUgbm90IGNvbW1hbmRzIGFuZCBub3QgcmVnaXN0cnkgZmxhZ3Mg4oCUIGBzdGF0ZSAtLXZlcnNpb25gXG4gIC8vIHN0YXlzIHJlZnVzZWQg4oCUIHdoaWNoIGlzIHdoeSB0aGV5IGFyZSBkZWNsYXJlZCBleHBsaWNpdGx5IGF0IHBhdGggW10gYW5kXG4gIC8vIHdoeSBhIGdlbmVyYXRvciB3YWxraW5nIFwidGhlIGNvbW1hbmRzXCIgd291bGQgd2FsayBwYXN0IHRoZW0uXG4gIGNvbnN0IGludGVyY2VwdG9yID0gUk9PVF9JTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBhcmd2WzBdKTtcbiAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQgfHwgYXJndlswXSA9PT0gXCJ2ZXJzaW9uXCIpIHtcbiAgICBjb25zdCBydW5zID0gaW50ZXJjZXB0b3I/LnJ1bnMgPz8gXCJ2ZXJzaW9uXCI7XG4gICAgaWYgKHJ1bnMgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh2ZXJzaW9uSW5mbygpKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFRoZSBXSE9MRSBhcmd2IGlzIHBhcnNlZCwgdmVyYiBpbmNsdWRlZCwgc28gYSBiYXJlIGAtLWAgaXMgaG9ub3VyZWQgYXRcbiAgLy8gdGhlIHJvb3QgKGFjYyBBNik6IGAtLSAtLXhgIHlpZWxkcyB0aGUgcG9zaXRpb25hbCBcIi0teFwiLCB3aGljaCBpcyB0aGVuIGFuXG4gIC8vIHVua25vd24gdmVyYiDigJQgbm90IGFuIHVua25vd24gb3B0aW9uLlxuICAvLyBOYW1lIHRoZSB2ZXJiIEJFRk9SRSBwYXJzaW5nLCBzbyBhIHBhcnNlciByZWplY3Rpb24ncyBlbnZlbG9wZSBzdGlsbCBzYXlzXG4gIC8vIHdoYXQgd2FzIGJlaW5nIHJ1bi5cbiAgLy8gVGhlIHZlcmIsIG5hbWVkIEJFRk9SRSBwYXJzaW5nLCBzbyBhIHBhcnNlciByZWplY3Rpb24ncyBlbnZlbG9wZSBzdGlsbCBzYXlzXG4gIC8vIHdoYXQgd2FzIGJlaW5nIHJ1bi4gSXQgbGl2ZXMgaW4gdGhlIGtpdCBub3cg4oCUIG9uZSBtb2R1bGUgb3ducyB0aGUgZW52ZWxvcGUsXG4gIC8vIHNvIGl0IG93bnMgdGhlIGZpZWxkIHRoZSBlbnZlbG9wZSBwcmludHMuXG4gIGxldCBjdXJyZW50Q29tbWFuZCA9IHZlcmJUb2tlbihhcmd2KTtcbiAgc2V0Q3VycmVudENvbW1hbmQoY3VycmVudENvbW1hbmQpO1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyhhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICAvLyBBbiB1bmtub3duIGZsYWcncyByZWplY3Rpb24gbmFtZXMgdGhlIHNldCBBVCBUSElTIFBBVEgsIG5vdCB0aGUgd2hvbGVcbiAgICAvLyByZWdpc3RyeTogdGhlIHZlcmIncyBvd24gZmxhZ3Mgd2hlbiB0aGUgdmVyYiBpcyBvbmUgb2Ygb3VycywgdGhlIHZlcmJcbiAgICAvLyByb3N0ZXIgd2hlbiB0aGVyZSBpcyBubyB2ZXJiIHlldCAodGhlIHJvb3QgYWNjZXB0cyBubyBmbGFncyBvZiBpdHMgb3duKS5cbiAgICAvLyBUaGlzIGlzIHdoYXQgYSByZWNvcmRlZC1zdXJmYWNlIGNlbnN1cyByZWFkcywgcGF0aCBieSBwYXRoLlxuICAgIGNvbnN0IHNwZWMgPSBjdXJyZW50Q29tbWFuZCA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IGZpbmRDb21tYW5kKGN1cnJlbnRDb21tYW5kKTtcbiAgICBpZiAoc3BlYyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlLm1lc3NhZ2UsIHsgaGludDogZS5leHRyYT8uaGludCwgY2hvaWNlczogZmxhZ3NGb3Ioc3BlYy5uYW1lKSB9KTtcbiAgICB9XG4gICAgLy8gQXQgdGhlIHJvb3QgdGhlIGZsYWdzIHRoZSB0b29sIGFjY2VwdHMgYXJlIHRoZSBpbnRlcmNlcHRvcnMsIGFuZCB0aGF0IGlzXG4gICAgLy8gdGhlIHNldCBuYW1lZCDigJQgdGhlIHNhbWUgYXJyYXkgYHNjaGVtYWAgZGVjbGFyZXMgYXQgcGF0aCBbXSwgc28gdGhlXG4gICAgLy8gcm9vdCBpcyBkaWZmYWJsZS4gVGhlIHZlcmIgcm9zdGVyIHJpZGVzIHRoZSBoaW50OiB0aGUgbmV4dCBhY3QgaXMgYSB2ZXJiLlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGUubWVzc2FnZSwge1xuICAgICAgaGludDogYG5vIHZlcmIgZ2l2ZW4g4oCUIHZlcmJzOiAke1ZFUkJTLmpvaW4oXCIgXCIpfSAocnVuOiBjbGkudHMgaGVscClgLFxuICAgICAgY2hvaWNlczogUk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IFt2ZXJiLCAuLi5wb3NdID0gcGFyc2VkLnBvcztcbiAgY29uc3QgZmxhZ3MgPSBwYXJzZWQuZmxhZ3M7XG4gIGN1cnJlbnRDb21tYW5kID0gdmVyYiA/PyBudWxsO1xuICBzZXRDdXJyZW50Q29tbWFuZChjdXJyZW50Q29tbWFuZCk7XG5cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIEJhcmUgaW52b2NhdGlvbiBpcyBhIHVzYWdlIGVycm9yIChhY2MgRDIpLCBhbmQgdGhlIHJlamVjdGlvbiBuYW1lc1xuICAgIC8vIHRoZSByb3N0ZXIgc28gdGhlIGNhbGxlcidzIG5leHQgY29tbWFuZCBjYW4gYmUgcmlnaHQuXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoXCJubyB2ZXJiIGdpdmVuXCIsIHsgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsIGNob2ljZXM6IFsuLi5WRVJCU10gfSk7XG4gIH1cbiAgY29uc3Qgc3BlYyA9IGZpbmRDb21tYW5kKHZlcmIpO1xuICBpZiAoc3BlYyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFN0YWdlIDI6IGEgcmVjb2duaXplZCBmbGFnIHRoaXMgdmVyYiBkb2VzIG5vdCB0YWtlIOKAlCBNSVNQTEFDRUQsIG5vdFxuICAvLyB1bmtub3duLiBBbiBhZ2VudCB0b2xkIGEgcmVhbCBmbGFnIGlzIHVua25vd24gZ29lcyBodW50aW5nIGEgdHlwbyBpdCBkaWRcbiAgLy8gbm90IG1ha2UuIFRoZSB2ZXJiIGlzIHJlc29sdmVkIGZpcnN0IGJlY2F1c2Ugd2hpY2ggZmxhZ3MgYXJlIGxlZ2FsIGlzIGFcbiAgLy8gcXVlc3Rpb24gYWJvdXQgdGhlIHZlcmIuXG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oc3BlYy5mbGFncyk7XG4gIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXMoZmxhZ3MpLmZpbmQoKGspID0+ICFhbGxvd2VkLmhhcyhrKSk7XG4gIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBmbGFnc0ZvcihzcGVjLm5hbWUpO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7c3BlYy5uYW1lfVxcYCAoaXQgaXMgYSByZWNvZ25pemVkIGdsYW1vdXIgZmxhZywganVzdCBub3QgdGhpcyB2ZXJiJ3MpYCxcbiAgICAgIGFjY2VwdGVkLmxlbmd0aCA+IDAgPyB7IGNob2ljZXM6IGFjY2VwdGVkIH0gOiB7IGhpbnQ6IGAke3NwZWMubmFtZX0gdGFrZXMgbm8gZmxhZ3NgIH0sXG4gICAgKTtcbiAgfVxuXG4gIC8vIEFyaXR5LCBlbmZvcmNlZCBGUk9NIFRIRSBERUNMQVJFRCBTSEFQRTogdGhlIHRhYmxlJ3MgcG9zaXRpb25hbCBzcGVjIGlzXG4gIC8vIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzIGFuZCB3aGF0IGhlbHAgcHJpbnRzLCBzbyBlbmZvcmNpbmcgaXQgaGVyZSBrZWVwc1xuICAvLyBib3RoIHRydWUgYnkgY29uc3RydWN0aW9uLiBBIHZlcmIncyBvd24gZmluZXIgY2hlY2tzIChhIG51bWVyaWMgLS1jb3N0LFxuICAvLyBhIHJlcXVpcmVkIGZsYWcpIGxpdmUgaW4gaXRzIGhhbmRsZXIgYW5kIG5hbWUgdGhlIHNhbWUgdXNhZ2UgbGluZS5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKSB7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVzYWdlOiAke3VzYWdlT2Yoc3BlYyl9YCwgeyBoaW50OiBzcGVjLmRlc2NyaWJlIH0pO1xuICB9XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IHR5cGVvZiBmbGFncy5zZXNzaW9uID09PSBcInN0cmluZ1wiID8gZmxhZ3Muc2Vzc2lvbiA6IHVuZGVmaW5lZDtcbiAgLy8gYHZvaWRgIG1lYW5zIDAg4oCUIGEgdmVyYiB0aGF0IGNvbXBsZXRlZCBhbmQgaGFkIG5vdGhpbmcgdG8gc2F5IGFib3V0IHRoZSBleGl0LlxuICAvLyBBIG51bWJlciBtZWFucyB0aGUgdmVyYiBPV05TIGl0cyBjb2RlLCB3aGljaCB0b2RheSBpcyBgdGFpbGAgYW5kIG9ubHkgYHRhaWxgLlxuICBjb25zdCBjb2RlID0gYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiB0eXBlb2YgY29kZSA9PT0gXCJudW1iZXJcIiA/IGNvZGUgOiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUiBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NjcmlwdHMvY2xpLnRzYC5cbiAqXG4gKiDim5QgYGltcG9ydC5tZXRhLm1haW5gIElTIEZBTFNFIElOIFRIRSBCVU5ETEUg4oCUIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnlcbiAqIHRoZSBsYXVuY2hlciwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3MgZW50cnksIHNvIGFuIGBpZiAoaW1wb3J0Lm1ldGEubWFpbilgXG4gKiBibG9jayBoZXJlIHdvdWxkIG5ldmVyIHJ1bjogdGhlIENMSSB3b3VsZCBwcmludCBub3RoaW5nIGFuZCBleGl0IDAgZm9yIGV2ZXJ5XG4gKiB2ZXJiLiBUaGlzIGV4cG9ydCBpcyB3aGF0IHJlcGxhY2VzIGl0LlxuICpcbiAqIOKblCBJVCBSRVRVUk5TIFRIRSBDT0RFIFJBVEhFUiBUSEFOIFNFVFRJTkcgSVQuIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbFxuICogcmV0dXJuLCBORVZFUiBgcHJvY2Vzcy5leGl0KGNvZGUpYDogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGVcbiAqIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc28gYW4gZXhwbGljaXQgZXhpdCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90XG4gKiBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHlcbiAqIHRoZSB3cml0ZSBpcyBsb3N0LCBzbyB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIGdsYW1vdXIncyBgc3RhdGUgLS1mdWxsYCBzaGlwcyBiYXNlNjQgcGF5bG9hZHMgZmFyIHBhc3QgdGhhdFxuICogYm91bmRhcnksIHNvIHRoaXMgaXMgbm90IHRoZW9yZXRpY2FsIGhlcmUuIFJlcHJvZHVjZWQsIGZpeGVkIGFuZCBnYXRlZCBpblxuICogYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuIFRoZSBhc3NpZ25tZW50IGhhcHBlbnMgb25jZSwgaW4gdGhlIGxhdW5jaGVyLlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTOiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVNcbiAqIGl0LiBBIGxhdW5jaGVyIHJlYWRpbmcgYHByb2Nlc3MuYXJndmAgd291bGQgbWF0Y2ggdGhlIGFyZy1wYXJzaW5nIHByZWRpY2F0ZSBpblxuICogYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgIGFuZCB0aGUgZmxhZyB3YXJkIHdvdWxkIGp1ZGdlIHRoaXMgc3BlbGwnc1xuICogZG9jdW1lbnRlZCBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0IHJlY29nbmlzZXMgbm9uZS5cbiAqXG4gKiDimqAgVU5MSUtFIFRIRSBEQUVNT04sIFRIRSBTT1VSQ0UgS0VFUFMgTk8gU0VDT05EIEVOVFJZIEFORCBORUVEUyBOT05FIChEMTIpOlxuICogYFNDUklQVF9ESVJgJ3MgY29uc3VtZXJzIGhlcmUgYXJlIGFsbCBhbmNlc3Rvci1yZWxhdGl2ZSBhbmQgY29ycmVjdCBmcm9tIGVpdGhlclxuICogYWRkcmVzcywgYnV0IHRoZSBzb3VyY2UgaGFzIG5vIGBpbXBvcnQubWV0YS5tYWluYCBibG9jayBlaXRoZXIsIHNvIHRoZXJlIGlzIG9uZVxuICogZW50cnkgYW5kIGl0IGlzIHRoaXMgb25lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7IG1haW4gfTtcbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCByZXBhaXJlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhXG4gKiBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4g4puUIFJFQUNIQUJJTElUWSwgTk9UIENBTEwgU0lURVM6IGFcbiAqIEhFTFBFUiB0aGF0IGRpZXMsIGludm9rZWQgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAsIGhhcyBpdHMgYGRpZWAgYXRcbiAqIGEgc2l0ZSB0aGF0IHJlYWRzIGFzIHBlcmZlY3RseSBzYWZlLiBBbiBhZG9wdGluZyBzcGVsbCBtdXN0IGZvbGxvdyB0aGUgY2FsbFxuICogZ3JhcGgsIG5vdCBncmVwIGZvciBgZGllKGAuIEF1ZGl0ZWQgdGhhdCB3YXkgb24gYWRvcHRpb24g4oCUIDE1IHNpdGVzIGluXG4gKiBhc3Ryb2xhYmUsIDI5IGluIG1hZ3BpZSwgcGx1cyB0aGUgaGVscGVycyByZWFjaGFibGUgZnJvbSB0aGVtIOKAlCBhbmQgZXZlcnlcbiAqIHBhdGggaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLCBmcm9tIHdoaWNoIHRoZSB0aHJvd1xuICogcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKipcbiAqIEV4dHJhIGZpZWxkcyBhIGZhaWx1cmUgbWF5IGNhcnJ5LiBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC10YWlsLXJlYWRlci1jb252ZXJnZW5jZS5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7IGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7IGNvbW1lbnRzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikgcmV0dXJuIGNvZGU7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSByZXR1cm4gY29kZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEdsYW1vdXIncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aCBoYWx2ZXNcbiAqIG9mIHRoZSBzcGVsbC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLiBCZWZvcmUgUGhhc2UgMiB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDE1MDAwYFxuICogaW5zaWRlIGBzZXJ2ZXIudHNgJ3MgYHNzZVJlc3BvbnNlYCwgYW5kIGBjbGkudHNgIGhhZCBOTyBjb3JyZXNwb25kaW5nIG51bWJlclxuICogYXQgYWxsIOKAlCBpdHMgdGFpbCBsb29wIHNpbXBseSBibG9ja2VkIG9uIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGVcbiAqIGZhaWx1cmUgYHRhaWxFdmVudHNgJ3Mgd2F0Y2hkb2cgZXhpc3RzIHRvIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGVcbiAqIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50b1xuICogYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2hcbiAqIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR0xBTU9VUidTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyBQaGFzZSAxYSdzIHJ1bGUgYW5kIGl0IGlzIHRoZSB3aG9sZSByZWFzb24gdGhlIGZpbGVcbiAqIGV4aXN0cyByYXRoZXIgdGhhbiBhIHNoYXJlZCBjb25zdGFudCBzb21ld2hlcmU6IGFzdHJvbGFiZSBiZWF0cyBhdCAxMCBzIGFuZFxuICogbWFncGllIGF0IDE1IHMsIHNvIGEgaGFyZC1jb2RlZCB3YXRjaGRvZyBpcyBjb3JyZWN0IGZvciBhdCBtb3N0IG9uZSBvZiB0aGVtLlxuICogQXN0cm9sYWJlIG1lYXN1cmVkIHdoYXQgYSBjb3BpZWQgbnVtYmVyIGRvZXMg4oCUIGEgNDUgcyB3YXRjaGRvZyBhZ2FpbnN0IGFuXG4gKiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhbiB1bnJlbGF0ZWQgdGhpcmRcbiAqIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tXG4gKiB0aGUgYmVhdCBpdCBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bS4gVGhpcyBpcyBnbGFtb3VyJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkIG9uZTpcbiAqIGBzZXJ2ZXIudHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IEJ1bidzXG4gKiBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIDE1IHMga2VlcGFsaXZlIGV2ZXJcbiAqIGZpcmVzLiBHbGFtb3VyIGRvZXMgbm90IGVudi10dW5lIGl0IOKAlCBhIHNlc3Npb24gZGFlbW9uJ3MgY29ubmVjdGlvbiBsaWZldGltZVxuICogaXMgbm90IHNvbWV0aGluZyBhIGNhbGxlciBoYXMgZXZlciBuZWVkZWQgdG8gc2hvcnRlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LCBhbmQgZ2xhbW91cidzIG93biBsaXRlcmFsIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC5cbiAqXG4gKiDimqAgNDUsMDAwIG1zIHRvZGF5LCB3aGljaCBpcyB0aGUgc2FtZSBudW1iZXIgYGNtZE9wZW5gJ3MgYC0tc3RhcnQtdGltZW91dGBcbiAqIGRlZmF1bHQgaGFwcGVucyB0byBiZS4gVGhleSBhcmUgVU5SRUxBVEVEIOKAlCBvbmUgYm91bmRzIGEgZmlyc3QgYnVuZGxlIGJ1aWxkLFxuICogdGhlIG90aGVyIGJvdW5kcyBhIHNpbGVudCBzb2NrZXQg4oCUIGFuZCB0aGUgY29pbmNpZGVuY2UgaXMgbmFtZWQgaGVyZSBzbyBub2JvZHlcbiAqIGxhdGVyIFwiZGUtZHVwbGljYXRlc1wiIHRoZW0gaW50byBvbmUgY29uc3RhbnQuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvLyBCcm93c2VyLXNhZmUgaW1hZ2Utb3B0aW1pemF0aW9uIFBPTElDWSAoc2hhcmVkIGJ5IHRoZSBicm93c2VyIGRyb3AgcGF0aCBhbmRcbi8vIHRoZSBzZXJ2ZXIgcGF0aCkuIE5vIG5hdGl2ZSBkZXBzIOKAlCBzYWZlIHRvIGltcG9ydCBpbnRvIHRoZSBSZWFjdCBidW5kbGUuXG4vLyBUaGUgQnVuLkltYWdlIGltcGxlbWVudGF0aW9uIGxpdmVzIGluIGltYWdlT3B0aW1pemUuc2VydmVyLnRzLlxuZXhwb3J0IGNvbnN0IE9QVElNSVpFID0geyBtYXhEaW06IDEyMDAsIHF1YWxpdHk6IDAuODUgfSBhcyBjb25zdDtcbiIsCiAgICAiLy8gU2VydmVyL0NMSS1vbmx5OiBuYXRpdmUgQnVuLkltYWdlIGRvd25zY2FsZSArIHdlYnAuIERvIE5PVCBpbXBvcnQgZnJvbSBicm93c2VyXG4vLyBjb2RlICh0aGUgYnJvd3NlciBkcm9wIHBhdGggdXNlcyA8Y2FudmFzPikuIFJlcXVpcmVzIEJ1biA+PSAxLjMuMTQuXG5pbXBvcnQgeyBPUFRJTUlaRSB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ2xhbW91ci9zaGFyZWQvaW1hZ2VPcHRpbWl6ZVwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVJbWFnZUJ1ZmZlcihcbiAgaW5wdXQ6IFVpbnQ4QXJyYXksXG4pOiBQcm9taXNlPHsgZGF0YTogVWludDhBcnJheTsgbWltZTogXCJpbWFnZS93ZWJwXCIgfT4ge1xuICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IEJ1bi5JbWFnZShpbnB1dClcbiAgICAucmVzaXplKE9QVElNSVpFLm1heERpbSwgT1BUSU1JWkUubWF4RGltLCB7XG4gICAgICBmaXQ6IFwiaW5zaWRlXCIsXG4gICAgICB3aXRob3V0RW5sYXJnZW1lbnQ6IHRydWUsXG4gICAgfSlcbiAgICAud2VicCh7IHF1YWxpdHk6IE1hdGgucm91bmQoT1BUSU1JWkUucXVhbGl0eSAqIDEwMCkgfSlcbiAgICAuYnl0ZXMoKTtcbiAgcmV0dXJuIHsgZGF0YTogbmV3IFVpbnQ4QXJyYXkoZGF0YSksIG1pbWU6IFwiaW1hZ2Uvd2VicFwiIH07XG59XG5cbi8vIERlY29kZSBhIGJhc2U2NCBkYXRhLVVSTCwgb3B0aW1pemUgdGhlIHJhc3RlciwgcmUtZW5jb2RlIGFzIGEgd2VicCBkYXRhLVVSTC5cbi8vIFVzZWQgYnkgdGhlIENMSSBgZ2VuYCB2ZXJiICh0aGUgYWdlbnQgcG9zdHMgYSBtZWRpYS1mb3JnZSBpbWFnZSB3aXRoIG5vXG4vLyBicm93c2VyIDxjYW52YXM+IGF2YWlsYWJsZSkuIFRocm93cyBvbiBhIG5vbi1iYXNlNjQtZGF0YS1VUkwgaW5wdXQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3B0aW1pemVJbWFnZURhdGFVcmwoZGF0YVVybDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgLy8gVGhlIGJvZHkgZ3JvdXAgaXMgbWFuZGF0b3J5LCBzbyBhIG1hdGNoIGFsd2F5cyBzZXRzIGl0OiBgYm9keWAgaXNcbiAgLy8gdW5kZWZpbmVkIGV4YWN0bHkgd2hlbiB0aGlzIGlzIG5vdCBhIGJhc2U2NCBkYXRhLVVSTCwgYW5kIGJvdGggdGFrZSB0aGVcbiAgLy8gZnVuY3Rpb24ncyBvbmUgcmVmdXNhbC5cbiAgY29uc3QgYm9keSA9IC9eZGF0YTooW147LF0rKTtiYXNlNjQsKC4qKSQvcy5leGVjKGRhdGFVcmwpPy5bMl07XG4gIGlmIChib2R5ID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcihcIm9wdGltaXplSW1hZ2VEYXRhVXJsOiBleHBlY3RlZCBhIGJhc2U2NCBkYXRhLVVSTFwiKTtcbiAgY29uc3QgYnl0ZXMgPSBVaW50OEFycmF5LmZyb20oYXRvYihib2R5KSwgKGMpID0+IGMuY2hhckNvZGVBdCgwKSk7XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgb3B0aW1pemVJbWFnZUJ1ZmZlcihieXRlcyk7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGNvbnN0IGIgb2YgZGF0YSkgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYik7XG4gIHJldHVybiBgZGF0YTppbWFnZS93ZWJwO2Jhc2U2NCwke2J0b2EoYmluKX1gO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQStCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLHNCQUFTOzs7QUNrQkYsSUFBTSxXQUFvQztBQUFBLEVBQy9DLE9BQU87QUFBQSxFQUNQLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLFVBQVU7QUFDWjtBQXVCQSxJQUFJLGlCQUFnQztBQUU3QixTQUFTLGlCQUFpQixDQUFDLFNBQThCO0FBQUEsRUFDOUQsaUJBQWlC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QUFRLElBQUksQ0FBQyxDQUFDO0FBQUEsRUFDNUQsSUFBSSxVQUFVLFdBQVc7QUFBQSxJQUN2QixNQUFNLFdBQVcsU0FBUyxLQUFLLElBQUk7QUFBQSxJQUNuQyxNQUFNLElBQUksV0FDUixLQUFLLDhCQUE4QixLQUFLLGtFQUN4QyxTQUFTLFNBQVMsSUFBSSxFQUFFLFNBQVMsU0FBUyxJQUFJLEVBQUUsTUFBTSxHQUFHLEtBQUssc0JBQXNCLENBQ3RGO0FBQUEsRUFDRjtBQUFBLEVBTUEsTUFBTSxXQUFXLEtBQUssWUFBWSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLEVBQzVELE1BQU0sV0FBVyxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsRUFDeEQsSUFBSSxJQUFJLFNBQVMsWUFBYSxDQUFDLFlBQVksSUFBSSxTQUFTLEtBQUssWUFBWSxRQUFTO0FBQUEsSUFDaEYsTUFBTSxJQUFJLFdBQVcsVUFBVSxRQUFRLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxFQUN6RTtBQUFBLEVBRUEsTUFBTSxVQUFVLE9BQU8sTUFBTSxZQUFZLFdBQVcsTUFBTSxVQUFVO0FBQUEsRUFHcEUsTUFBTSxPQUFPLE1BQU0sS0FBSyxJQUFJLEtBQUssT0FBTyxPQUFPO0FBQUEsRUFDL0MsT0FBTyxPQUFPLFNBQVMsV0FBVyxPQUFPO0FBQUE7QUErQjNDLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjQwNzE3RDhGMTNCQTBDMEI2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
