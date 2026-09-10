#!/usr/bin/env bun
// @bun

// src/imago/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
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

// src/imago/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.IMAGO_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.IMAGO_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/imago/backend/cli.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "imago");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var SNAPSHOTS_DIR = join(process.env.IMAGO_HOME ?? join(homedir(), ".imago"), "snapshots");
var MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};
var NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };
function daemonRefused(what, status, data) {
  const kind = status === 400 ? "usage" : status === 404 ? "not_found" : status === 409 ? "conflict" : "internal";
  die(`${what} failed (HTTP ${status})`, kind, {
    ...data !== null && data !== undefined ? { server: data } : {}
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function sessionFilePath(session) {
  return session ? join(tmpdir(), `imago-${session}.json`) : join(tmpdir(), "imago-latest.json");
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
    die("no running imago session", "not_found", NO_SESSION_HINT);
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
  content: { type: "string" },
  "edited-from": { type: "string" },
  image: { type: "string" },
  kind: { type: "string" },
  link: { type: "string" },
  models: { type: "string" },
  n: { type: "string" },
  options: { type: "string" },
  prompt: { type: "string" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  summary: { type: "string" },
  tag: { type: "string" },
  tags: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  clear: { type: "boolean" },
  full: { type: "boolean" },
  "no-open": { type: "boolean" }
};

class UsageError extends Error {
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
    throw new UsageError(`${detail}
` + `  recognized flags: ${Object.keys(CLI_OPTIONS).map((k) => `--${k}`).join(" ")}
` + `  for free text containing dashes, use --stdin, or put it after a bare --`);
  }
}
async function postCmd(session, msg) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "POST", "/cmd", msg);
  if (status !== 200)
    daemonRefused("cmd", status, data);
  printJson({ ok: true, sent: msg.type });
}
async function cmdOpen(flags) {
  const args = ["run", SERVER_SCRIPT];
  if (flags.title)
    args.push("--title", String(flags.title));
  if (flags.timeout)
    args.push("--timeout", String(flags.timeout));
  if (flags.restore)
    args.push("--restore", String(flags.restore));
  if (flags["no-open"])
    args.push("--no-open");
  const prevId = readSession()?.session_id;
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd: daemonCwd()
  });
  proc.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(80);
    const s = readSession();
    if (s && s.session_id !== prevId) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/state`);
        if (r.ok) {
          printJson(s);
          return;
        }
      } catch {}
    }
  }
  die("imago server failed to start within 5s", "internal", {
    hint: "the daemon writes its discovery pointer once it has bound; check for a stale $TMPDIR/imago-latest.json"
  });
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
    onComment: () => ": imago-keepalive"
  });
}
function fileToDataUrl(path) {
  const buf = readFileSync(path);
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok)
    die(`fetch failed (HTTP ${res.status}): ${url}`, "usage");
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  return `data:${mime};base64,${buf.toString("base64")}`;
}
async function resolveSrc(arg) {
  if (/^https?:\/\//.test(arg))
    return urlToDataUrl(arg);
  if (arg.startsWith("data:"))
    return arg;
  return fileToDataUrl(arg);
}
function cmdInfo(session) {
  const s = readSession(session);
  if (!s)
    die("no running imago session", "not_found", NO_SESSION_HINT);
  printJson(s);
}
function cmdSessions() {
  let files;
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    process.stdout.write(`no saved sessions
`);
    return;
  }
  const rows = [];
  for (const f of files) {
    const path = join(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      const batches = st.batches || [];
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        batches: batches.length,
        gens: batches.reduce((n, b) => n + (b.variants?.length ?? 0), 0),
        mtime: statSync(path).mtimeMs
      });
    } catch {}
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.batches} batches \xB7 ${r.gens} generations  \u2014 ${r.title}
`);
  }
  if (!rows.length)
    process.stdout.write(`no saved sessions
`);
}
var HELP = `imago \u2014 a grounded image conversation.

  open   [--title ..] [--no-open] [--timeout S] [--restore <id|path>]
  sessions                           list saved (resumable) sessions
  tail   [--since N]                  SSE user events \u2192 JSONL (wrap with Monitor)
  state  [--full]                    lean state snapshot (add --full for raw incl. base64)
  say    <text...>                   post agent dialogue into the conversation
  propose <prompt...> [--n N]        propose a prompt for the user to send (\xD7N, \u22644)
  ask    <text...> [--options "a|b|c"]   ask the user a question (in-thread)
  batch  [--kind generate|edit] [--prompt ..] [--tag ..] [--edited-from <vid>] [--summary ..] [--models m1,m2,..] <src> ...
                                     add a produced batch; each src = http url, data: url, or file path; --models labels each variant
  focus  <batchId> <variantId>       put an image on the canvas
  select <variantId> [off]           point a variant at the next gen as a reference (highlights it for the user)
  analyze <variantId> <text...>      write your read onto an image (durable metadata)
  context <kind> <name...> [--content "<text>"] [--image <path|url>] [--link active|quickPrompts] [--tags a,b,c]
                                     add/upsert a Context Library entry (kind: prompt|style|skill|context)
  status on [text...] | status off   show/hide the "imago working" spinner
  cost   <text...>                   cumulative spend display (e.g. "$0.38 \xB7 8 imgs")
  handoff <text...> | handoff --clear   raise/clear a terminal-ask escalation
  close | info | help

  Add --session <id> to target a specific session (default: most recent).`;
async function dispatch(argv) {
  const [verb, ...rest] = argv;
  setCurrentCommand(typeof verb === "string" ? verb : null);
  let pos;
  let flags;
  try {
    ({ pos, flags } = parseArgs(rest));
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    die(e.message, "usage");
  }
  const session = typeof flags.session === "string" ? flags.session : undefined;
  switch (verb) {
    case "open":
      await cmdOpen(flags);
      break;
    case "tail":
      await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1);
      break;
    case "state":
      await cmdState(session, flags.full === true);
      break;
    case "say":
      if (!pos.length)
        die("usage: say <text...>");
      await postCmd(session, { type: "say", text: pos.join(" ") });
      break;
    case "propose": {
      if (!pos.length)
        die("usage: propose <prompt...> [--n N]");
      const msg = { type: "propose", prompt: pos.join(" ") };
      if (typeof flags.n === "string")
        msg.n = parseInt(flags.n, 10);
      await postCmd(session, msg);
      break;
    }
    case "ask": {
      if (!pos.length)
        die('usage: ask <text...> [--options "a|b|c"]');
      const msg = { type: "ask", text: pos.join(" ") };
      if (typeof flags.options === "string") {
        msg.options = flags.options.split("|").map((s) => s.trim()).filter(Boolean);
      }
      await postCmd(session, msg);
      break;
    }
    case "batch": {
      if (!pos.length) {
        die(`usage: batch [--kind generate|edit] [--prompt ..] [--tag ..] [--edited-from <vid>] [--summary ..] [--models m1,m2,..] <src> ...
` + "  src = an http(s) url, a data: url, or a file path; --models labels each variant in order");
      }
      const models = typeof flags.models === "string" ? flags.models.split(",").map((m) => m.trim()) : [];
      const variants = [];
      for (let i = 0;i < pos.length; i++) {
        const v = { src: await resolveSrc(pos[i]) };
        if (models[i])
          v.model = models[i];
        variants.push(v);
      }
      const msg = {
        type: "batch.add",
        kind: flags.kind === "edit" ? "edit" : "generate",
        prompt: typeof flags.prompt === "string" ? flags.prompt : "",
        variants
      };
      if (typeof flags.tag === "string")
        msg.tag = flags.tag;
      if (typeof flags["edited-from"] === "string")
        msg.editedFromVariantId = flags["edited-from"];
      if (typeof flags.summary === "string")
        msg.summary = flags.summary;
      await postCmd(session, msg);
      break;
    }
    case "focus":
      if (pos.length < 2)
        die("usage: focus <batchId> <variantId>");
      await postCmd(session, { type: "focus", batchId: pos[0], variantId: pos[1] });
      break;
    case "select":
      if (!pos.length)
        die("usage: select <variantId> [off]");
      await postCmd(session, { type: "ref.select", id: pos[0], selected: pos[1] !== "off" });
      break;
    case "analyze": {
      if (pos.length < 2)
        die("usage: analyze <image-id> <text...>");
      const [aid, ...words] = pos;
      await postCmd(session, { type: "variant.analyze", id: aid, text: words.join(" ") });
      break;
    }
    case "context": {
      const VALID_KINDS = ["prompt", "style", "skill", "context"];
      const VALID_LINKS = ["active", "quickPrompts"];
      const [kindArg, ...nameWords] = pos;
      if (!kindArg || !VALID_KINDS.includes(kindArg)) {
        die(`usage: context <kind> <name...> [--content "<text>"] [--image <path|url>] [--link active|quickPrompts] [--tags a,b,c]
` + `  kind must be one of: ${VALID_KINDS.join(", ")}`);
      }
      if (!nameWords.length)
        die("usage: context <kind> <name...> \u2014 at least one name word required");
      if (typeof flags.link === "string" && !VALID_LINKS.includes(flags.link)) {
        die(`--link must be one of: ${VALID_LINKS.join(", ")}`);
      }
      const ctxMsg = {
        type: "context.add",
        kind: kindArg,
        name: nameWords.join(" "),
        content: typeof flags.content === "string" ? flags.content : ""
      };
      if (typeof flags.image === "string")
        ctxMsg.image = await resolveSrc(flags.image);
      if (typeof flags.tags === "string") {
        ctxMsg.tags = flags.tags.split(",").map((t) => t.trim()).filter(Boolean);
      }
      if (typeof flags.link === "string")
        ctxMsg.link = flags.link;
      await postCmd(session, ctxMsg);
      break;
    }
    case "status": {
      const on = pos[0] === "on";
      await postCmd(session, { type: "status", busy: on, text: pos.slice(1).join(" ") });
      break;
    }
    case "cost":
      if (!pos.length)
        die("usage: cost <text...>");
      await postCmd(session, { type: "cost", text: pos.join(" ") });
      break;
    case "handoff":
      await postCmd(session, {
        type: "handoff",
        text: flags.clear === true ? "" : pos.join(" ")
      });
      break;
    case "close":
      await postCmd(session, { type: "close" });
      break;
    case "info":
      cmdInfo(session);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}
`);
      break;
    default:
      die(`unknown verb "${verb}" \u2014 run: cli.ts help`);
  }
  return 0;
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
      return reportCliError(new CliError("usage", msg)) ?? 2;
    return reportCliError(new CliError("internal", msg)) ?? 1;
  }
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  main,
  parseArgs,
  run
};

//# debugId=9B92AE14BFFA2BD364756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2ltYWdvL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9lcnJvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGltYWdvIENMSSDigJQgdGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgcGVyLXNlc3Npb24gZGFlbW9uJ3MgSFRUUCBzdXJmYWNlXG4vLyAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyBhIGdyb3VuZGVkIGltYWdlIGNvbnZlcnNhdGlvbiB0aHJvdWdoIHRoZXNlXG4vLyB2ZXJiczsgYHRhaWxgIHN0cmVhbXMgdXNlciBldmVudHMgYXMgSlNPTkwgZm9yIE1vbml0b3IgdG8gd3JhcC5cbi8vXG4vLyBMaWZlY3ljbGU6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiBbLS10aXRsZSAuLl0gWy0tbm8tb3Blbl0gICAjIHNwYXduIGEgc2Vzc2lvblxuLy8gICBidW4gY2xpLnRzIHRhaWwgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBTU0UgdXNlciBldmVudHMg4oaSIEpTT05MIChNb25pdG9yIHRoaXMpXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tZnVsbF0gICAgICAgICAgICAgICAgICAjIGxlYW4gc3RhdGUgc25hcHNob3Rcbi8vXG4vLyBUYWxraW5nICsgZHJpdmluZyB0aGUgY2FudmFzIChQT1NUIC9jbWQpOlxuLy8gICBidW4gY2xpLnRzIHNheSA8dGV4dC4uLj4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgcG9zdCBhZ2VudCBkaWFsb2d1ZVxuLy8gICBidW4gY2xpLnRzIHByb3Bvc2UgPHByb21wdC4uLj4gWy0tbiBOXSAgICAgICAgICAgICAgICAgICAgICMgcHJvcG9zZSBhIHByb21wdCB0byBzZW5kXG4vLyAgIGJ1biBjbGkudHMgYXNrIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0gICAgICAgICAgICAgICAjIGFzayB0aGUgdXNlciAoaW4tdGhyZWFkKVxuLy8gICBidW4gY2xpLnRzIGJhdGNoIFstLWtpbmQgZ2VuZXJhdGV8ZWRpdF0gWy0tcHJvbXB0IC4uXSBbLS10YWcgLi5dXG4vLyAgICAgICAgICAgICAgICAgICAgWy0tZWRpdGVkLWZyb20gPHZhcmlhbnRJZD5dIFstLXN1bW1hcnkgLi5dIDxzcmMxPiA8c3JjMj4gLi4uXG4vLyAgICAgICAgICAgICAgICAgICAgIyBlYWNoIHNyYyA9IGFuIGh0dHAocykgdXJsLCBhIGRhdGE6IHVybCwgb3IgYSBmaWxlIHBhdGhcbi8vICAgYnVuIGNsaS50cyBmb2N1cyA8YmF0Y2hJZD4gPHZhcmlhbnRJZD4gICAgICAgICAgICAgICAgICAgICMgcHV0IGFuIGltYWdlIG9uIHRoZSBjYW52YXNcbi8vICAgYnVuIGNsaS50cyBjb250ZXh0IDxraW5kPiA8bmFtZS4uLj4gWy0tY29udGVudCBcIjx0ZXh0PlwiXSBbLS1pbWFnZSA8cGF0aHx1cmw+XVxuLy8gICAgICAgICAgICAgICAgICAgIFstLWxpbmsgYWN0aXZlfHF1aWNrUHJvbXB0c10gWy0tdGFncyBhLGIsY11cbi8vICAgICAgICAgICAgICAgICAgICAjIGFkZC91cHNlcnQgYSBDb250ZXh0IExpYnJhcnkgZW50cnkgKGtpbmQ6IHByb21wdHxzdHlsZXxza2lsbHxjb250ZXh0KVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgICAgICAgICAgICAgIyB0aGUgd29ya2luZyBzcGlubmVyXG4vLyAgIGJ1biBjbGkudHMgY29zdCA8dGV4dC4uLj4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBjdW11bGF0aXZlIHNwZW5kIGRpc3BsYXlcbi8vICAgYnVuIGNsaS50cyBoYW5kb2ZmIDx0ZXh0Li4uPiB8IGhhbmRvZmYgLS1jbGVhciAgICAgICAgICAgICMgZXNjYWxhdGUgdG8gYSB0ZXJtaW5hbCBhc2tcbi8vICAgYnVuIGNsaS50cyBjbG9zZSB8IGluZm8gfCBzZXNzaW9ucyB8IGhlbHBcbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD5cbi8vIHRvIHRhcmdldCBhIHNwZWNpZmljIG9uZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgQ2xpRXJyb3IsXG4gIGRpZSxcbiAgdHlwZSBFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbiAgc2V0Q3VycmVudENvbW1hbmQsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50cy50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5cbi8vIOKblCBFVkVSWSBQQVRIIEJFTE9XIElTIFJFU09MVkVEIEZST00gVEhFIEVNSVRURUQgQlVORExFLCBORVZFUiBGUk9NIFRISVMgRklMRS5cbi8vIFRoaXMgbW9kdWxlIGlzIGF1dGhvcmVkIGhlcmUgYW5kIFNISVBTIEJVSUxUIGF0XG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2ltYWdvL2Rpc3QvY2xpLmpzYCwgaW1wb3J0ZWQgYnkgdGhlIGxhdW5jaGVyIGF0XG4vLyBgLi4vc2NyaXB0cy9jbGkudHNgIChiYWNrZW5kIGNvbnZlcmdlbmNlIFBoYXNlIDM7IHNlYW1zIENvbnRyYWN0IDQnc1xuLy8gYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLiBgaW1wb3J0Lm1ldGEudXJsYCB0aGVyZWZvcmUgbmFtZXMgYGRpc3QvY2xpLmpzYCxcbi8vIHNvIGBTQ1JJUFRfRElSYCBpcyBgPHNraWxsPi9kaXN0L2AgYW5kIGBTS0lMTF9ST09UYCBpcyB0aGUgc2tpbGwgcm9vdCDigJQgd2hpY2hcbi8vIGlzIHdoYXQgdGhlIHR3byBsaW5lcyBiZWxvdyBhbHJlYWR5IG1lYW50IGZyb20gYHNjcmlwdHMvYCwgdW5jaGFuZ2VkLCBiZWNhdXNlXG4vLyBgZGlzdC9gIHNpdHMgYXQgdGhlIHNhbWUgZGVwdGggYXMgdGhlIGBzY3JpcHRzL2AgaXQgcmVwbGFjZWQuIOKaoCBUSEFUIElTIEFcbi8vIENPSU5DSURFTkNFIE9GIERFUFRILCBOT1QgQSBQUk9QRVJUWTogYHJlbGVhc2Utc2VydmUudGVzdC50c2AgYXNzZXJ0cyBpdFxuLy8gcmF0aGVyIHRoYW4gdHJ1c3RpbmcgaXQuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyDim5QgVVAgQU5EIEJBQ0sgRE9XTiwgTkVWRVIgYGpvaW4oU0NSSVBUX0RJUiwgXCJzZXJ2ZXIudHNcIilgLiBUaGUgZGFlbW9uIGlzXG4vLyBzcGF3bmVkIGJ5IFBBVEgsIGFuZCB0aGUgcGF0aCBpcyB0aGUgTEFVTkNIRVIgYXQgYDxza2lsbD4vc2NyaXB0cy9zZXJ2ZXIudHNgXG4vLyDigJQgYSByZWFsIGAudHNgIGZpbGUgdGhhdCBpbXBvcnRzIGAuLi9kaXN0L3NlcnZlci5qc2AuIFRoZSBzaWJsaW5nIHNwZWxsaW5nXG4vLyB0aGlzIGxpbmUgdXNlZCB0byBjYXJyeSB3YXMgY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgaXRzZWxmIGxpdmVkIGluXG4vLyBgc2NyaXB0cy9gOyBmcm9tIGBkaXN0L2AgaXQgcmVzb2x2ZXMgdG8gYGRpc3Qvc2VydmVyLnRzYCwgYSBmaWxlIHRoYXQgZG9lc1xuLy8gbm90IGFuZCBtdXN0IG5vdCBleGlzdCwgYW5kIHRoZSBzeW1wdG9tIGlzIG5vdCBhIGNyYXNoIOKAlCBgb3BlbmAgd2FpdHMgb3V0IGl0c1xuLy8gc3RhcnQgZGVhZGxpbmUgYW5kIHJlcG9ydHMgYSB0aW1lb3V0LCB3aGljaCByZWFkcyBsaWtlIGEgc2xvdyBmaXJzdCBidWlsZC5cbi8vIGdsYW1vdXIgc2hpcHBlZCBleGFjdGx5IHRoYXQgZGVmZWN0IGluIFBoYXNlIDIgKHBsYXlib29rIEI0KS5cbi8vIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgaXMgdGhlIGluc3RydW1lbnQgdGhhdCBjYXRjaGVzIGFcbi8vIHJlZ3Jlc3Npb24gaGVyZTsgY29uZmlybSBpdHMgY292ZXJhZ2Ugcm93IG5hbWVzIGltYWdvIHdpdGggYSBub24temVybyBwaW5cbi8vIGNvdW50LCBiZWNhdXNlIGEgd2FyZCB3aG9zZSBwb3B1bGF0aW9uIGlzIGRlcml2ZWQgaXMgbm90IHRoZXJlYnkgQ09WRVJFRC5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2UsIGFuZCBCdW4gcmVhZHMgYnVuZmlnLnRvbWxcbi8vICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyB0aGUgZGFlbW9uJ3MgY3dkIE1VU1QgYmUgc3JjL2ltYWdvL1xuLy8gKHNlYW1zIENvbnRyYWN0IDUgY3dkLXBpbikg4oCUIGxhdW5jaGVkIGFueXdoZXJlIGVsc2UgdGhlIGRldiBidW5kbGVyIGNhbm5vdFxuLy8gY29tcGlsZSB0aGUgc3R5bGVzaGVldCAobWVhc3VyZWQgb24gZ2xhbW91cjogdGhlIFBBR0UgNTAwcyB3aXRoIG5vIHN0eWxlc2hlZXRcbi8vIGxpbms7IG5vdCBcInVuc3R5bGVkIGF0IDIwMFwiIOKAlCB0aGF0IHNlbnRlbmNlIHdhcyBuZXZlciBydW47IGltYWdvJ3Mgb3duIGZhaWx1cmVcbi8vIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kXG4vLyBzdGF0aWMg4oCUIG5vIGJ1bmZpZyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlXG4vLyBtYXJrZXRwbGFjZSBjbG9uZSBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkXG4vLyBicmVhayB0aGUgc3Bhd24uXG4vLyDimqAgVGhlIGZpdmUgYC4uYCBhcmUgY291bnRlZCBmcm9tIGA8c2tpbGw+L2Rpc3QvYCwgd2hpY2ggaXMgd2hlcmUgdGhpcyBsaW5lXG4vLyBFWEVDVVRFUyDigJQgbm90IGZyb20gYHNyYy9pbWFnby9iYWNrZW5kL2AsIHdoZXJlIGl0IGlzIHdyaXR0ZW4uIFJlYWQgYXMgYW5cbi8vIG9yZGluYXJ5IHJlbGF0aXZlIHBhdGggb2YgdGhlIGZpbGUgaXQgc2l0cyBpbiBpdCB3b3VsZCBjbGltYiBvdXQgb2YgdGhlIHJlcG8uXG4vLyBJdCBpcyB0aGUgc2FtZSBzdHJpbmcgYXMgYmVmb3JlIHRoZSByZWxvY2F0aW9uIG9ubHkgYmVjYXVzZSBgZGlzdC9gIGFuZFxuLy8gYHNjcmlwdHMvYCBzaXQgYXQgdGhlIHNhbWUgZGVwdGggKEQxMSdzIGNvaW5jaWRlbmNlLW9mLWRlcHRoLCBhZ2FpbikuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiaW1hZ29cIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4ocHJvY2Vzcy5lbnYuSU1BR09fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuaW1hZ29cIiksIFwic25hcHNob3RzXCIpO1xuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG4gIFwiLmpwZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuanBlZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbn07XG5cbnR5cGUgU2Vzc2lvbiA9IHtcbiAgdXJsOiBzdHJpbmc7XG4gIHBvcnQ6IG51bWJlcjtcbiAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlc19kaXI/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZGFlbW9uJ3MgcmVzb2x2ZWQgc3VyZmFjZSBtb2RlIChDb250cmFjdCAxKS4gQWRkaXRpdmUtb3B0aW9uYWw6IGFcbiAgICogIHNlc3Npb24gZmlsZSB3cml0dGVuIGJ5IGFuIG9sZGVyIGRhZW1vbiBoYXMgbm8gYG1vZGVgLCBhbmQgYWJzZW50IG1lYW5zXG4gICAqICBcInVua25vd25cIiwgbmV2ZXIgXCJkZXZcIi4gKi9cbiAgbW9kZT86IFwiZGV2XCIgfCBcInJlbGVhc2VcIjtcbn07XG5cbi8qKlxuICog4puUIGBkaWVgIElTIE5PVyBUSEUgSE9VU0UnUyAoYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSBBTkQgSVQgVEhST1dTIFJBVEhFUlxuICogVEhBTiBFWElUUyDigJQgYW5kIGZvciBpbWFnbyB0aGF0IGlzIGEgQ0FMTEVSLVZJU0lCTEUgQ0hBTkdFLCBzdGF0ZWQgaGVyZVxuICogcmF0aGVyIHRoYW4gYWJzb3JiZWQuIFRoZSBmdW5jdGlvbiB0aGlzIHJlcGxhY2VzIHdyb3RlIGBpbWFnbzogPG1zZz5gIHRvXG4gKiBzdGRlcnIgYXMgUFJPU0UgYW5kIGV4aXRlZCAqKjIgZm9yIGV2ZXJ5IGZhaWx1cmUqKjogYSBtaXNzaW5nIHNlc3Npb24sIGFuXG4gKiB1bnJlYWNoYWJsZSBkYWVtb24sIGEgYmFkIGZsYWcgYW5kIGFuIGludGVybmFsIGZhdWx0IHdlcmUgb25lIG51bWJlci4gQVxuICogZmFpbHVyZSBub3cgZW1pdHMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIGFuZCB0aGUgZXhpdCBjb2RlIGNvbWVzIGZyb21cbiAqIHRoZSB0YXhvbm9teSDigJQgdXNhZ2UgMiwgaW50ZXJuYWwgMSwgbm90X2ZvdW5kIDUsIGNvbmZsaWN0IDYg4oCUIHNvIGFuIGFnZW50IGNhblxuICogcm91dGUgb24gYGtpbmRgIGluc3RlYWQgb2YgbWF0Y2hpbmcgcHJvc2UuIFNlZSBkZWNpc2lvbiBEMzguXG4gKlxuICogVGhlIFRIUk9XIGlzIHRoZSBvdGhlciBoYWxmLCBhbmQgaXQgaXMgd2h5IEI5J3MgYXVkaXQgaGFkIHRvIGJlIHJ1bjogQnVuJ3NcbiAqIHN0ZG91dCBpcyBhc3luY2hyb25vdXMgb24gYSBwaXBlLCBzbyBhbiBleGl0IGZyb20gdGhyZWUgZnJhbWVzIGRvd24gZGlzY2FyZHNcbiAqIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZC4gRXZlcnkgZmFpbHVyZSBub3cgbGVhdmVzIHRocm91Z2ggYG1haW5gJ3MgZnVubmVsLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgYSBzaWxlbnRcbiAqIGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIEF1ZGl0ZWQgYnkgY2FsbCBncmFwaCwgbm90IGJ5IGdyZXAg4oCUIHRoZSBjb3VudFxuICogYW5kIHRoZSBjbGFzc2lmaWNhdGlvbiBhcmUgaW4gdGhlIHBoYXNlIDMgam91cm5hbC5cbiAqL1xuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuLyoqIEEgcmVmdXNhbCBmcm9tIGltYWdvJ3Mgb3duIGRhZW1vbiwgY2FycmllZCBWRVJCQVRJTSB1bmRlciBgZXJyb3Iuc2VydmVyYCBzb1xuICogIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkIHJhdGhlciB0aGFuIG9uIHRoaXNcbiAqICBDTEkncyBwcm9zZSBhYm91dCBpdC4gVGhlIHN0YXR1c+KGkmtpbmQgbWFwIGlzIHRoZSBob3VzZSdzLiAqL1xuZnVuY3Rpb24gZGFlbW9uUmVmdXNlZCh3aGF0OiBzdHJpbmcsIHN0YXR1czogbnVtYmVyLCBkYXRhOiB1bmtub3duKTogbmV2ZXIge1xuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICBzdGF0dXMgPT09IDQwMFxuICAgICAgPyBcInVzYWdlXCJcbiAgICAgIDogc3RhdHVzID09PSA0MDRcbiAgICAgICAgPyBcIm5vdF9mb3VuZFwiXG4gICAgICAgIDogc3RhdHVzID09PSA0MDlcbiAgICAgICAgICA/IFwiY29uZmxpY3RcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICBkaWUoYCR7d2hhdH0gZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBraW5kLCB7XG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzZXNzaW9uID8gam9pbih0bXBkaXIoKSwgYGltYWdvLSR7c2Vzc2lvbn0uanNvbmApIDogam9pbih0bXBkaXIoKSwgXCJpbWFnby1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIOKblCBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFLlxuICpcbiAqICBUaGlzIGNhdWdodCBldmVyeSBlcnJvciBmcm9tIHRoZSByZWFkIGFuZCByZXR1cm5lZCBudWxsLCBzbyBhIGNvcnJ1cHRcbiAqICBwb2ludGVyLCBhbiBFQUNDRVMsIGFuZCBhbnkgdHJhbnNpZW50IHRoZSBPUyByYWlzZXMgdW5kZXIgbG9hZCBhbGwgYXJyaXZlZFxuICogIGF0IHRoZSBjYWxsZXJzIHdlYXJpbmcgYWJzZW5jZSdzIGNsb3RoZXMg4oCUIGFuZCB0aGUgY2FsbGVycyBhY3Qgb24gYWJzZW5jZTpcbiAqICB0aGV5IHJlcG9ydCBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiLCBhbmQgYSB0YWlsIGxvb3AgcmVhZHMgaXQgYXMgXCJ0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbiB3ZW50IGF3YXlcIiBhbmQgZXhpdHMgMC4gQSByZXNvdXJjZSBmYWlsdXJlIHdhcyB0aGVyZWZvcmUgcmVwb3J0ZWRcbiAqICBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBpbiBnbGFtb3VyLCB3aG9zZSBjb3B5IG9mIHRoaXMgZnVuY3Rpb24gaXMgYnl0ZS1pZGVudGljYWw6IGl0cyBDTElcbiAqICBjb250cmFjdCBjZWxsIGZhaWxlZCBvbmNlIHVuZGVyIHRoZSBmdWxsIGdhdGUgd2l0aCB0aGUgbm90X2ZvdW5kIGV4aXQgd2hlcmVcbiAqICB0aGUgY29udHJhY3Qgc2FpZCB1c2FnZSwgYW5kIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuLiBGaXhlZCB0aGVyZVxuICogIDIwMjYtMDktMDc7IGZvdW5kIHN0aWxsIHN0YW5kaW5nIGhlcmUgMjAyNi0wOS0wOCBieSB0aGUgYmFja2VuZCBkdXBsaWNhdGlvblxuICogIHJlY29uIChkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtYmFja2VuZC1kdXBsaWNhdGlvbi1yZWNvbi5tZCkuXG4gKlxuICogIEVOT0VOVCBpcyB0aGUgb25seSBob25lc3QgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHNheXMgd2hhdCBpdCB3YXMuXG4gKlxuICogIOKaoCBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgd2hpY2ggaXMgd2hhdCBsZXRzXG4gKiAgdW5wYXJzZWFibGUgY29udGVudCBjb3VudCBhcyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGEgaGFsZi13cml0dGVuIHJlYWQuICovXG5mdW5jdGlvbiByZWFkU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvbiB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgaW1hZ28gc2Vzc2lvblwiLCBcIm5vdF9mb3VuZFwiLCBOT19TRVNTSU9OX0hJTlQpO1xuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgIG9yIGJvb2xlYW4gYC0tZmxhZ2AuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhlIGhhbmQtcm9sbGVkIHBhcnNlciBoYWQgbm8gcmVnaXN0cnksIHNvIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXRcbi8vIGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhc1xuLy8gc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC4gYG5vZGU6dXRpbGAgc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiwgdGhlXG4vLyBgPWAgZm9ybSBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBmcm9tIHRoZSBzdGFuZGFyZCBsaWJyYXJ5LlxuLy9cbi8vIFR5cGVzIGFyZSB0aG90aCdzIGF1ZGl0ZWQgYXJ0aWZhY3QgKDE3IHN0cmluZyDCtyAzIGJvb2xlYW4pLCBlYWNoIHNldHRsZWQgYnlcbi8vIHVuYW1iaWd1b3VzIGV2aWRlbmNlIGF0IGV2ZXJ5IGNvbnN1bXB0aW9uIHNpdGUuIEdldHRpbmcgb25lIHdyb25nIGlzIG5vdCBhXG4vLyBuby1vcDogYSBcInN0cmluZ1wiIHRoYXQgc2hvdWxkIGJlIGJvb2xlYW4gU1dBTExPV1MgVEhFIE5FWFQgUE9TSVRJT05BTCwgYW5kIGFcbi8vIFwiYm9vbGVhblwiIHRoYXQgc2hvdWxkIGJlIHN0cmluZyBicmVha3MgdGhlIHNwYWNlIGZvcm0uLy9cbi8vIGBraW5kYCBpcyBTVFJJTkcgZGVzcGl0ZSByZWFkaW5nIGFzIGBmbGFncy5raW5kID09PSBcImVkaXRcImAg4oCUIGl0IGlzIGNvbXBhcmVkXG4vLyB0byBhIHN0cmluZyBsaXRlcmFsLCBub3QgdGVzdGVkIGZvciBwcmVzZW5jZS4gRGVjbGFyaW5nIGl0IGJvb2xlYW4gdGhlcmVcbi8vIHdvdWxkIG1ha2UgYC0ta2luZCBlZGl0YCBwdXNoIFwiZWRpdFwiIGludG8gcG9zaXRpb25hbHMgYW5kIHRoZSBjb21wYXJpc29uXG4vLyB3b3VsZCBuZXZlciBtYXRjaDogYSBzaWxlbnQgbm8tb3AsIG5vdCBhIGNyYXNoLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGNvbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImVkaXRlZC1mcm9tXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbWFnZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGtpbmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaW5rOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWxzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9wdGlvbnM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwcm9tcHQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3VtbWFyeTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRhZ3M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmdWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG5jbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYCR7ZGV0YWlsfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKENMSV9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gICtcbiAgICAgICAgYCAgZm9yIGZyZWUgdGV4dCBjb250YWluaW5nIGRhc2hlcywgdXNlIC0tc3RkaW4sIG9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1gLFxuICAgICk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJjbWRcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IG1zZy50eXBlIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmIChmbGFncy50aXRsZSkgYXJncy5wdXNoKFwiLS10aXRsZVwiLCBTdHJpbmcoZmxhZ3MudGl0bGUpKTtcbiAgaWYgKGZsYWdzLnRpbWVvdXQpIGFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBTdHJpbmcoZmxhZ3MudGltZW91dCkpO1xuICBpZiAoZmxhZ3MucmVzdG9yZSkgYXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIFN0cmluZyhmbGFncy5yZXN0b3JlKSk7XG4gIGlmIChmbGFnc1tcIm5vLW9wZW5cIl0pIGFyZ3MucHVzaChcIi0tbm8tb3BlblwiKTtcblxuICBjb25zdCBwcmV2SWQgPSByZWFkU2Vzc2lvbigpPy5zZXNzaW9uX2lkO1xuICAvLyBub2RlOmNoaWxkX3Byb2Nlc3MgKG5vdCBCdW4uc3Bhd24pIGlzIGRlbGliZXJhdGUgKyBtYXRjaGVzIGdyYXBldmluZS9ib3VudHk6XG4gIC8vIHRoZSBkYWVtb24gbXVzdCBTVVJWSVZFIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdGluZywgd2hpY2ggbmVlZHMgYGRldGFjaGVkOiB0cnVlYFxuICAvLyArIGB1bnJlZigpYC4gQnVuLnNwYXduIGNhbid0IGRldGFjaCBhIHN1cnZpdmluZyBkYWVtb24g4oCUIHNvIHRoZSBob3VzZSBwYXR0ZXJuXG4gIC8vIGZvciBzcGF3bmluZyBhIHN0YW5kaW5nIGRhZW1vbiBpcyBub2RlJ3Mgc3Bhd24uIChDTEFVREUubWQncyBCdW4tc3Bhd24gcHJlZlxuICAvLyBhcHBsaWVzIHRvIGluLXByb2Nlc3MgY2hpbGQgY29tbWFuZHMsIG5vdCBkZXRhY2hlZCBkYWVtb25zLilcbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGFyZ3MsIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgLy8gQ29udHJhY3QgNSDigJQgc2VlIGRhZW1vbkN3ZCgpLiBBIHdyb25nIGN3ZCBza2lwcyBidW5maWcudG9tbCdzIFRhaWx3aW5kXG4gICAgLy8gcGx1Z2luOyBvbiBnbGFtb3VyIHRoYXQgZmFpbHMgdGhlIHBhZ2Ugb3V0cmlnaHQgKDUwMCkuIEFzc2VydCB0aGUgaW52YXJpYW50LFxuICAgIC8vIG5vdCB0aGUgc3RhdHVzOiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gY3dkIGlzIHdyb25nLlxuICAgIGN3ZDogZGFlbW9uQ3dkKCksXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IHNsZWVwKDgwKTtcbiAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oKTtcbiAgICBpZiAocyAmJiBzLnNlc3Npb25faWQgIT09IHByZXZJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fS9zdGF0ZWApO1xuICAgICAgICBpZiAoci5vaykge1xuICAgICAgICAgIHByaW50SnNvbihzKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBub3QgdXAgeWV0ICovXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGRpZShcImltYWdvIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDVzXCIsIFwiaW50ZXJuYWxcIiwge1xuICAgIGhpbnQ6IFwidGhlIGRhZW1vbiB3cml0ZXMgaXRzIGRpc2NvdmVyeSBwb2ludGVyIG9uY2UgaXQgaGFzIGJvdW5kOyBjaGVjayBmb3IgYSBzdGFsZSAkVE1QRElSL2ltYWdvLWxhdGVzdC5qc29uXCIsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uPzogc3RyaW5nLCBmdWxsID0gZmFsc2UpIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiXCIgOiBcIj9sZWFuPTFcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG4vKipcbiAqIFRoZSBldmVudCB0YWlsIOKAlCBPTkUgQ0FMTCBpbnRvIHRoZSBob3VzZSdzIHNoYXJlZCBTU0UgY2xpZW50XG4gKiAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoZXJlIHRoZSByZWNvbm5lY3QgbG9vcCwgdGhlIHNwZWMtY29ycmVjdFxuICogZnJhbWUgcGFyc2VyLCB0aGUgYmFja29mZiwgdGhlIGlkbGUgd2F0Y2hkb2cgYW5kIHRoZSBkcmFpbmVkIGV4aXQgbGl2ZSBvbmNlXG4gKiBmb3IgZXZlcnkgc3BlbGwuXG4gKlxuICog4puUICoqVEhFIEhBTkQtUk9MTEVEIExPT1AgVEhJUyBSRVBMQUNFUyBIQUQgVEhFIENPTlNUQU5ULUJBQ0tPRkYgREVGRUNULCBBTkRcbiAqIElNQUdPJ1MgQ09QWSBXQVMgV09SU0UgVEhBTiBUSEUgT05FIEdMQU1PVVIgUEFJRCBGT1IuKiogSXQgc2V0IGBkZWxheSA9IDI1MGAsXG4gKiBkb3VibGVkIGl0IG9uIHRocmVlIGZhaWx1cmUgYnJhbmNoZXMg4oCUIGFuZCBSRVNFVCBJVCBUTyAyNTAgb24gZXZlcnkgc3VjY2Vzc2Z1bFxuICogT1BFTiwgYmVmb3JlIHJlYWRpbmcgYSBieXRlLiBBIGRhZW1vbiB0aGF0IGFjY2VwdHMgYSBjb25uZWN0aW9uIGFuZFxuICogaW1tZWRpYXRlbHkgZHJvcHMgaXQgd2FzIHRoZXJlZm9yZSByZWNvbm5lY3RlZCBhZ2FpbnN0IGF0IGEgY29uc3RhbnQgMjUwIG1zLFxuICogZm9yZXZlciwgd2l0aCBubyBncm93dGg6IGEgcmVjb25uZWN0IHN0b3JtIHRoYXQgcmVhZHMgYXMgYSBoZWFsdGh5IHJldHJ5LlxuICog4pqgIEFORCBJTUFHTyBIQUQgQSBGT1VSVEggU0lURSBUSEUgT1RIRVJTIERJRCBOT1Qg4oCUIGBhd2FpdCBzbGVlcChkZWxheSlgIGF0IHRoZVxuICogQk9UVE9NIG9mIHRoZSBvdXRlciBsb29wLCBhZnRlciB0aGUgc3RyZWFtIGVuZGVkLCB1c2luZyB3aGF0ZXZlciBgZGVsYXlgIHRoZVxuICogc3VjY2Vzc2Z1bCBvcGVuIGhhZCBqdXN0IHJlc2V0LiBJdCBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGhlcmUsIGJlY2F1c2UgdGhlcmVcbiAqIGlzIG5vIGxvb3AgbGVmdCB0byBwdXQgaXQgaW4uXG4gKlxuICog4puUIEFORCBJVCBHQUlORUQgQSBXQVRDSERPRyBJVCBESUQgTk9UIEhBVkUuIFRoZSBvbGQgbG9vcCBibG9ja2VkIG9uXG4gKiBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgZm9yZXZlciwgc28gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVRcbiAqIHJlYmluZCBvciBhIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIGluIHNpbGVuY2Ugd2l0aCBubyB3YXkgb3V0LlxuICogYFRBSUxfSURMRV9NU2AgaXMgREVSSVZFRCBmcm9tIGltYWdvJ3Mgb3duIGhlYXJ0YmVhdCAoYC4vaGVhcnRiZWF0LnRzYCksIG5ldmVyXG4gKiBjb3BpZWQgZnJvbSBhIHNpYmxpbmcuXG4gKlxuICog4puUIGByZXNvbHZlYCBSRS1SRUFEUyBUSEUgU0VTU0lPTiBQT0lOVEVSIE9OIEVWRVJZIEFUVEVNUFQg4oCUIHdoaWNoIHRoZSBvbGRcbiAqIGxvb3AgZGlkIHRvbywgYW5kIHdoaWNoIHRoZSBzaGFyZWQgY2xpZW50IG1ha2VzIHN0cnVjdHVyYWw6IHRoZSBkYWVtb24gYmluZHNcbiAqIGFuIGVwaGVtZXJhbCBwb3J0LCBzbyBhIGNhcHR1cmVkIGJhc2UgaXMgYSB0YWlsIHRoYXQgc3Vydml2ZXMgb25lIGRhZW1vbi5cbiAqXG4gKiBQUkVTRVJWRUQgVkVSQkFUSU0sIGJlY2F1c2UgdGhleSBhcmUgaW1hZ28ncyBvd24gY29udHJhY3QgYW5kIG5vdCB0aGUgc2hhcmVkXG4gKiBjbGllbnQnczogdGhlIEZJUlNUIHJlc29sdmVkIHNlc3Npb24gaXMgcGlubmVkIGZvciB0aGUgbGlmZSBvZiB0aGUgd2F0Y2gsIHRoZVxuICogZ3JvdW5kaW5nIGxpbmUgbmFtZXMgdGhhdCBiaW5kaW5nIG9uY2Ugc28gYSB3cm9uZyBzZXNzaW9uL3BvcnQgaXMgb2J2aW91c1xuICogaW5zdGVhZCBvZiBzaWxlbnQsIGEgcG9pbnRlciB0aGF0IGRpc2FwcGVhcnMgQUZURVIgd2Ugd2VyZSBib3VuZCBlbmRzIHRoZVxuICogd2F0Y2ggYXQgMCAoYSBjb21wbGV0ZWQgd2F0Y2gsIG5vdCBhIGZhaWx1cmUpLCBhbmQgb25lIHRoYXQgbmV2ZXIgYXBwZWFyZWRcbiAqIGtlZXBzIHJldHJ5aW5nIHdpdGggYCMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmYCBvbiBzdGRlcnIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzaW5jZUFyZzogbnVtYmVyKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGJvdW5kSWQgPSBzZXNzaW9uO1xuICBsZXQgZ3JvdW5kZWQgPSBmYWxzZTtcblxuICByZXR1cm4gYXdhaXQgdGFpbEV2ZW50czx7IGlkPzogbnVtYmVyOyB0eXBlPzogc3RyaW5nIH0+KHtcbiAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICAvLyBgcmVhZFNlc3Npb25gIGRpZXMgb24gYSBDT1JSVVBUIHBvaW50ZXIgYW5kIHJldHVybnMgbnVsbCBvbmx5IGZvciBhXG4gICAgICAvLyBnZW51aW5lbHkgYWJzZW50IG9uZSDigJQgdGhlIEVOT0VOVCBydWxlLiBUaGF0IGBkaWVgIG5vdyBUSFJPV1MsIGFuZCB0aGVcbiAgICAgIC8vIHRocm93IGxlYXZlcyB0aGUgdGFpbCB0aHJvdWdoIG1haW4ncyBmdW5uZWwgaW5zdGVhZCBvZiBleGl0aW5nIGZyb21cbiAgICAgIC8vIHRocmVlIGZyYW1lcyBkb3duIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLiBJdCBpcyBCOSdzIGF1ZGl0IHBheWluZyBmb3JcbiAgICAgIC8vIGl0c2VsZjogdGhpcyBpcyB0aGUgb25lIGRpZS1yZWFjaGFibGUgY2FsbCB0aGUgc2hhcmVkIGNsaWVudCBpbnZva2VzIG9uXG4gICAgICAvLyBhIHNjaGVkdWxlLlxuICAgICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDsgLy8gcGluIHRvIHRoZSBmaXJzdCBzZXNzaW9uIHdlIHJlc29sdmVkXG4gICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgfSxcbiAgICBvblVucmVzb2x2ZWQ6ICh7IGV2ZXJSZXNvbHZlZCB9KSA9PiB7XG4gICAgICBpZiAoZXZlclJlc29sdmVkKSByZXR1cm4gXCJzdG9wXCI7IC8vIG91ciBwaW5uZWQgc2Vzc2lvbiB3ZW50IGF3YXkg4oaSIGRvbmVcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgIH0sXG4gICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgc2luY2U6IHNpbmNlQXJnLFxuICAgIGN1cnNvck9mOiAoZXYpID0+IGV2LmlkLFxuICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgb25Db21tZW50OiAoKSA9PiBcIjogaW1hZ28ta2VlcGFsaXZlXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBmaWxlVG9EYXRhVXJsKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ1ZiA9IHJlYWRGaWxlU3luYyhwYXRoKTtcbiAgY29uc3QgZG90ID0gcGF0aC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gcGF0aC5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICBjb25zdCBtaW1lID0gTUlNRV9CWV9FWFRbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xuICByZXR1cm4gYGRhdGE6JHttaW1lfTtiYXNlNjQsJHtidWYudG9TdHJpbmcoXCJiYXNlNjRcIil9YDtcbn1cblxuLy8gRG93bmxvYWQgYW4gaW1hZ2UgVVJMIGFuZCBpbmxpbmUgaXQgYXMgYSBkYXRhIFVSTCDigJQgc28gYSBnZW5lcmF0ZWQgdmFyaWFudFxuLy8gaXMgc2VsZi1jb250YWluZWQgKHBlcnNpc3RzIGluIHRoZSBzbmFwc2hvdCwgc3Vydml2ZXMgcHJlc2lnbmVkLVVSTCBleHBpcnkpLlxuYXN5bmMgZnVuY3Rpb24gdXJsVG9EYXRhVXJsKHVybDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsKTtcbiAgaWYgKCFyZXMub2spIGRpZShgZmV0Y2ggZmFpbGVkIChIVFRQICR7cmVzLnN0YXR1c30pOiAke3VybH1gLCBcInVzYWdlXCIpO1xuICBjb25zdCBidWYgPSBCdWZmZXIuZnJvbShhd2FpdCByZXMuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IG1pbWUgPSAocmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpIHx8IFwiaW1hZ2UvanBlZ1wiKS5zcGxpdChcIjtcIilbMF07XG4gIHJldHVybiBgZGF0YToke21pbWV9O2Jhc2U2NCwke2J1Zi50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xufVxuXG4vLyBSZXNvbHZlIGEgdmFyaWFudCBzb3VyY2UgYXJndW1lbnQ6IGFuIGh0dHAocykgVVJMIChkb3dubG9hZGVkICsgaW5saW5lZCksIGFcbi8vIGRhdGE6IFVSTCAocGFzc2VkIHRocm91Z2gpLCBvciBhIGxvY2FsIGZpbGUgcGF0aCAocmVhZCArIGlubGluZWQpLlxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVNyYyhhcmc6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QoYXJnKSkgcmV0dXJuIHVybFRvRGF0YVVybChhcmcpO1xuICBpZiAoYXJnLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcmV0dXJuIGFyZztcbiAgcmV0dXJuIGZpbGVUb0RhdGFVcmwoYXJnKTtcbn1cblxuZnVuY3Rpb24gY21kSW5mbyhzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIGltYWdvIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG5mdW5jdGlvbiBjbWRTZXNzaW9ucygpIHtcbiAgbGV0IGZpbGVzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBmaWxlcyA9IHJlYWRkaXJTeW5jKFNOQVBTSE9UU19ESVIpLmZpbHRlcigoZikgPT4gZi5lbmRzV2l0aChcIi5qc29uXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXCJubyBzYXZlZCBzZXNzaW9uc1xcblwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHlwZSBSb3cgPSB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGJhdGNoZXM6IG51bWJlcjsgZ2VuczogbnVtYmVyOyBtdGltZTogbnVtYmVyIH07XG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gW107XG4gIGZvciAoY29uc3QgZiBvZiBmaWxlcykge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKFNOQVBTSE9UU19ESVIsIGYpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG4gICAgICBjb25zdCBiYXRjaGVzID0gKHN0LmJhdGNoZXMgfHwgW10pIGFzIEFycmF5PHsgdmFyaWFudHM/OiB1bmtub3duW10gfT47XG4gICAgICByb3dzLnB1c2goe1xuICAgICAgICBpZDogZi5yZXBsYWNlKC9cXC5qc29uJC8sIFwiXCIpLFxuICAgICAgICB0aXRsZTogc3QudGl0bGUsXG4gICAgICAgIGJhdGNoZXM6IGJhdGNoZXMubGVuZ3RoLFxuICAgICAgICBnZW5zOiBiYXRjaGVzLnJlZHVjZSgobiwgYikgPT4gbiArIChiLnZhcmlhbnRzPy5sZW5ndGggPz8gMCksIDApLFxuICAgICAgICBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWVNcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCB1bnJlYWRhYmxlIHNuYXBzaG90ICovXG4gICAgfVxuICB9XG4gIHJvd3Muc29ydCgoYSwgYikgPT4gYi5tdGltZSAtIGEubXRpbWUpO1xuICBmb3IgKGNvbnN0IHIgb2Ygcm93cykge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3IuaWR9ICAke3IuYmF0Y2hlc30gYmF0Y2hlcyDCtyAke3IuZ2Vuc30gZ2VuZXJhdGlvbnMgIOKAlCAke3IudGl0bGV9XFxuYCk7XG4gIH1cbiAgaWYgKCFyb3dzLmxlbmd0aCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXCJubyBzYXZlZCBzZXNzaW9uc1xcblwiKTtcbn1cblxuY29uc3QgSEVMUCA9IGBpbWFnbyDigJQgYSBncm91bmRlZCBpbWFnZSBjb252ZXJzYXRpb24uXG5cbiAgb3BlbiAgIFstLXRpdGxlIC4uXSBbLS1uby1vcGVuXSBbLS10aW1lb3V0IFNdIFstLXJlc3RvcmUgPGlkfHBhdGg+XVxuICBzZXNzaW9ucyAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Qgc2F2ZWQgKHJlc3VtYWJsZSkgc2Vzc2lvbnNcbiAgdGFpbCAgIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3IpXG4gIHN0YXRlICBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgbGVhbiBzdGF0ZSBzbmFwc2hvdCAoYWRkIC0tZnVsbCBmb3IgcmF3IGluY2wuIGJhc2U2NClcbiAgc2F5ICAgIDx0ZXh0Li4uPiAgICAgICAgICAgICAgICAgICBwb3N0IGFnZW50IGRpYWxvZ3VlIGludG8gdGhlIGNvbnZlcnNhdGlvblxuICBwcm9wb3NlIDxwcm9tcHQuLi4+IFstLW4gTl0gICAgICAgIHByb3Bvc2UgYSBwcm9tcHQgZm9yIHRoZSB1c2VyIHRvIHNlbmQgKMOXTiwg4omkNClcbiAgYXNrICAgIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0gICBhc2sgdGhlIHVzZXIgYSBxdWVzdGlvbiAoaW4tdGhyZWFkKVxuICBiYXRjaCAgWy0ta2luZCBnZW5lcmF0ZXxlZGl0XSBbLS1wcm9tcHQgLi5dIFstLXRhZyAuLl0gWy0tZWRpdGVkLWZyb20gPHZpZD5dIFstLXN1bW1hcnkgLi5dIFstLW1vZGVscyBtMSxtMiwuLl0gPHNyYz4gLi4uXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWRkIGEgcHJvZHVjZWQgYmF0Y2g7IGVhY2ggc3JjID0gaHR0cCB1cmwsIGRhdGE6IHVybCwgb3IgZmlsZSBwYXRoOyAtLW1vZGVscyBsYWJlbHMgZWFjaCB2YXJpYW50XG4gIGZvY3VzICA8YmF0Y2hJZD4gPHZhcmlhbnRJZD4gICAgICAgcHV0IGFuIGltYWdlIG9uIHRoZSBjYW52YXNcbiAgc2VsZWN0IDx2YXJpYW50SWQ+IFtvZmZdICAgICAgICAgICBwb2ludCBhIHZhcmlhbnQgYXQgdGhlIG5leHQgZ2VuIGFzIGEgcmVmZXJlbmNlIChoaWdobGlnaHRzIGl0IGZvciB0aGUgdXNlcilcbiAgYW5hbHl6ZSA8dmFyaWFudElkPiA8dGV4dC4uLj4gICAgICB3cml0ZSB5b3VyIHJlYWQgb250byBhbiBpbWFnZSAoZHVyYWJsZSBtZXRhZGF0YSlcbiAgY29udGV4dCA8a2luZD4gPG5hbWUuLi4+IFstLWNvbnRlbnQgXCI8dGV4dD5cIl0gWy0taW1hZ2UgPHBhdGh8dXJsPl0gWy0tbGluayBhY3RpdmV8cXVpY2tQcm9tcHRzXSBbLS10YWdzIGEsYixjXVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFkZC91cHNlcnQgYSBDb250ZXh0IExpYnJhcnkgZW50cnkgKGtpbmQ6IHByb21wdHxzdHlsZXxza2lsbHxjb250ZXh0KVxuICBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZiAgIHNob3cvaGlkZSB0aGUgXCJpbWFnbyB3b3JraW5nXCIgc3Bpbm5lclxuICBjb3N0ICAgPHRleHQuLi4+ICAgICAgICAgICAgICAgICAgIGN1bXVsYXRpdmUgc3BlbmQgZGlzcGxheSAoZS5nLiBcIiQwLjM4IMK3IDggaW1nc1wiKVxuICBoYW5kb2ZmIDx0ZXh0Li4uPiB8IGhhbmRvZmYgLS1jbGVhciAgIHJhaXNlL2NsZWFyIGEgdGVybWluYWwtYXNrIGVzY2FsYXRpb25cbiAgY2xvc2UgfCBpbmZvIHwgaGVscFxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byB0YXJnZXQgYSBzcGVjaWZpYyBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuYDtcblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbdmVyYiwgLi4ucmVzdF0gPSBhcmd2O1xuICAvLyBOYW1lcyB0aGUgdmVyYiBpbiBldmVyeSBlbnZlbG9wZSdzIGBtZXRhLmNvbW1hbmRgLCBzbyBhIGNhbGxlciByZWFkaW5nIGFcbiAgLy8gZmFpbHVyZSBrbm93cyB3aGljaCBpbnZvY2F0aW9uIHByb2R1Y2VkIGl0IHdpdGhvdXQgY29ycmVsYXRpbmcuXG4gIHNldEN1cnJlbnRDb21tYW5kKHR5cGVvZiB2ZXJiID09PSBcInN0cmluZ1wiID8gdmVyYiA6IG51bGwpO1xuICAvLyBBIHVzYWdlIGZhaWx1cmUgUkVUVVJOUyByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0LlxuICBsZXQgcG9zOiBzdHJpbmdbXTtcbiAgbGV0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbiAgdHJ5IHtcbiAgICAoeyBwb3MsIGZsYWdzIH0gPSBwYXJzZUFyZ3MocmVzdCkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKCEoZSBpbnN0YW5jZW9mIFVzYWdlRXJyb3IpKSB0aHJvdyBlO1xuICAgIC8vIFRoZSBwYXJzZXIncyBvd24gZXJyb3IgY2xhc3MsIGNvbnZlcnRlZCBhdCB0aGUgYm91bmRhcnkgaW50byB0aGUgaG91c2VcbiAgICAvLyBlbnZlbG9wZS4gYFVzYWdlRXJyb3JgIHN0YXlzIGJlY2F1c2UgaXQgY2FycmllcyB0aGUgcmVjb2duaXNlZC1mbGFnIGxpc3RcbiAgICAvLyB0aGF0IGBwYXJzZUFyZ3NgIGJ1aWxkczsgd2hhdCBjaGFuZ2VkIGlzIHRoYXQgdGhlIG1lc3NhZ2Ugbm8gbG9uZ2VyIGdvZXNcbiAgICAvLyBvdXQgYXMgYmFyZSBwcm9zZS5cbiAgICBkaWUoZS5tZXNzYWdlLCBcInVzYWdlXCIpO1xuICB9XG4gIGNvbnN0IHNlc3Npb24gPSB0eXBlb2YgZmxhZ3Muc2Vzc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnNlc3Npb24gOiB1bmRlZmluZWQ7XG5cbiAgc3dpdGNoICh2ZXJiKSB7XG4gICAgY2FzZSBcIm9wZW5cIjpcbiAgICAgIGF3YWl0IGNtZE9wZW4oZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInRhaWxcIjpcbiAgICAgIGF3YWl0IGNtZFRhaWwoc2Vzc2lvbiwgdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdGF0ZVwiOlxuICAgICAgYXdhaXQgY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2F5XCI6XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZShcInVzYWdlOiBzYXkgPHRleHQuLi4+XCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJwcm9wb3NlXCI6IHtcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IHByb3Bvc2UgPHByb21wdC4uLj4gWy0tbiBOXVwiKTtcbiAgICAgIGNvbnN0IG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6IFwicHJvcG9zZVwiLCBwcm9tcHQ6IHBvcy5qb2luKFwiIFwiKSB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5uID09PSBcInN0cmluZ1wiKSBtc2cubiA9IHBhcnNlSW50KGZsYWdzLm4sIDEwKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgbXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiYXNrXCI6IHtcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKCd1c2FnZTogYXNrIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0nKTtcbiAgICAgIGNvbnN0IG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6IFwiYXNrXCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5vcHRpb25zID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIG1zZy5vcHRpb25zID0gZmxhZ3Mub3B0aW9uc1xuICAgICAgICAgIC5zcGxpdChcInxcIilcbiAgICAgICAgICAubWFwKChzKSA9PiBzLnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgfVxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBtc2cpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJiYXRjaFwiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIHtcbiAgICAgICAgZGllKFxuICAgICAgICAgIFwidXNhZ2U6IGJhdGNoIFstLWtpbmQgZ2VuZXJhdGV8ZWRpdF0gWy0tcHJvbXB0IC4uXSBbLS10YWcgLi5dIFstLWVkaXRlZC1mcm9tIDx2aWQ+XSBbLS1zdW1tYXJ5IC4uXSBbLS1tb2RlbHMgbTEsbTIsLi5dIDxzcmM+IC4uLlxcblwiICtcbiAgICAgICAgICAgIFwiICBzcmMgPSBhbiBodHRwKHMpIHVybCwgYSBkYXRhOiB1cmwsIG9yIGEgZmlsZSBwYXRoOyAtLW1vZGVscyBsYWJlbHMgZWFjaCB2YXJpYW50IGluIG9yZGVyXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBvcHRpb25hbCBwZXItdmFyaWFudCBtb2RlbCBsYWJlbHMsIGNvbW1hLXNlcGFyYXRlZCwgcG9zaXRpb25hbCB0byBzcmNzXG4gICAgICBjb25zdCBtb2RlbHMgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MubW9kZWxzID09PSBcInN0cmluZ1wiID8gZmxhZ3MubW9kZWxzLnNwbGl0KFwiLFwiKS5tYXAoKG0pID0+IG0udHJpbSgpKSA6IFtdO1xuICAgICAgY29uc3QgdmFyaWFudHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwb3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgdjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHNyYzogYXdhaXQgcmVzb2x2ZVNyYyhwb3NbaV0pIH07XG4gICAgICAgIGlmIChtb2RlbHNbaV0pIHYubW9kZWwgPSBtb2RlbHNbaV07XG4gICAgICAgIHZhcmlhbnRzLnB1c2godik7XG4gICAgICB9XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICB0eXBlOiBcImJhdGNoLmFkZFwiLFxuICAgICAgICBraW5kOiBmbGFncy5raW5kID09PSBcImVkaXRcIiA/IFwiZWRpdFwiIDogXCJnZW5lcmF0ZVwiLFxuICAgICAgICBwcm9tcHQ6IHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIgPyBmbGFncy5wcm9tcHQgOiBcIlwiLFxuICAgICAgICB2YXJpYW50cyxcbiAgICAgIH07XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLnRhZyA9PT0gXCJzdHJpbmdcIikgbXNnLnRhZyA9IGZsYWdzLnRhZztcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3NbXCJlZGl0ZWQtZnJvbVwiXSA9PT0gXCJzdHJpbmdcIikgbXNnLmVkaXRlZEZyb21WYXJpYW50SWQgPSBmbGFnc1tcImVkaXRlZC1mcm9tXCJdO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5zdW1tYXJ5ID09PSBcInN0cmluZ1wiKSBtc2cuc3VtbWFyeSA9IGZsYWdzLnN1bW1hcnk7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG1zZyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImZvY3VzXCI6XG4gICAgICBpZiAocG9zLmxlbmd0aCA8IDIpIGRpZShcInVzYWdlOiBmb2N1cyA8YmF0Y2hJZD4gPHZhcmlhbnRJZD5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmb2N1c1wiLCBiYXRjaElkOiBwb3NbMF0sIHZhcmlhbnRJZDogcG9zWzFdIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNlbGVjdFwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogc2VsZWN0IDx2YXJpYW50SWQ+IFtvZmZdXCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwicmVmLnNlbGVjdFwiLCBpZDogcG9zWzBdLCBzZWxlY3RlZDogcG9zWzFdICE9PSBcIm9mZlwiIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImFuYWx5emVcIjoge1xuICAgICAgaWYgKHBvcy5sZW5ndGggPCAyKSBkaWUoXCJ1c2FnZTogYW5hbHl6ZSA8aW1hZ2UtaWQ+IDx0ZXh0Li4uPlwiKTtcbiAgICAgIGNvbnN0IFthaWQsIC4uLndvcmRzXSA9IHBvcztcbiAgICAgIC8vIHJlZnMgYXJlIHZhcmlhbnRzIG5vdyDihpIgb25lIHZlcmIgd3JpdGVzIGEgcmVhZCBvbnRvIGFueSBpbWFnZSAoaW5jbC5cbiAgICAgIC8vIG1pZ3JhdGVkIHJlZnMgdGhhdCBrZXB0IHRoZWlyIG9sZCBcInJlZi3igKZcIiBpZClcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInZhcmlhbnQuYW5hbHl6ZVwiLCBpZDogYWlkLCB0ZXh0OiB3b3Jkcy5qb2luKFwiIFwiKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY29udGV4dFwiOiB7XG4gICAgICBjb25zdCBWQUxJRF9LSU5EUyA9IFtcInByb21wdFwiLCBcInN0eWxlXCIsIFwic2tpbGxcIiwgXCJjb250ZXh0XCJdIGFzIGNvbnN0O1xuICAgICAgdHlwZSBDb250ZXh0S2luZCA9ICh0eXBlb2YgVkFMSURfS0lORFMpW251bWJlcl07XG4gICAgICBjb25zdCBWQUxJRF9MSU5LUyA9IFtcImFjdGl2ZVwiLCBcInF1aWNrUHJvbXB0c1wiXSBhcyBjb25zdDtcbiAgICAgIGNvbnN0IFtraW5kQXJnLCAuLi5uYW1lV29yZHNdID0gcG9zO1xuICAgICAgaWYgKCFraW5kQXJnIHx8ICFWQUxJRF9LSU5EUy5pbmNsdWRlcyhraW5kQXJnIGFzIENvbnRleHRLaW5kKSkge1xuICAgICAgICBkaWUoXG4gICAgICAgICAgYHVzYWdlOiBjb250ZXh0IDxraW5kPiA8bmFtZS4uLj4gWy0tY29udGVudCBcIjx0ZXh0PlwiXSBbLS1pbWFnZSA8cGF0aHx1cmw+XSBbLS1saW5rIGFjdGl2ZXxxdWlja1Byb21wdHNdIFstLXRhZ3MgYSxiLGNdXFxuYCArXG4gICAgICAgICAgICBgICBraW5kIG11c3QgYmUgb25lIG9mOiAke1ZBTElEX0tJTkRTLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFuYW1lV29yZHMubGVuZ3RoKVxuICAgICAgICBkaWUoXCJ1c2FnZTogY29udGV4dCA8a2luZD4gPG5hbWUuLi4+IOKAlCBhdCBsZWFzdCBvbmUgbmFtZSB3b3JkIHJlcXVpcmVkXCIpO1xuICAgICAgaWYgKFxuICAgICAgICB0eXBlb2YgZmxhZ3MubGluayA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAhVkFMSURfTElOS1MuaW5jbHVkZXMoZmxhZ3MubGluayBhcyAodHlwZW9mIFZBTElEX0xJTktTKVtudW1iZXJdKVxuICAgICAgKSB7XG4gICAgICAgIGRpZShgLS1saW5rIG11c3QgYmUgb25lIG9mOiAke1ZBTElEX0xJTktTLmpvaW4oXCIsIFwiKX1gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGN0eE1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgIHR5cGU6IFwiY29udGV4dC5hZGRcIixcbiAgICAgICAga2luZDoga2luZEFyZyBhcyBDb250ZXh0S2luZCxcbiAgICAgICAgbmFtZTogbmFtZVdvcmRzLmpvaW4oXCIgXCIpLFxuICAgICAgICBjb250ZW50OiB0eXBlb2YgZmxhZ3MuY29udGVudCA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmNvbnRlbnQgOiBcIlwiLFxuICAgICAgfTtcbiAgICAgIC8vIGEgY2FwdHVyZWQgc3R5bGUgY2FycmllcyBhIGNhbm9uaWNhbCBleGFtcGxlIGltYWdlIChhIHZhcmlhbnQgcGF0aC91cmwpIOKGklxuICAgICAgLy8gaW5saW5lIGl0IHNvIGl0J3Mgc2VsZi1jb250YWluZWQsIGxpa2UgYmF0Y2ggc3Jjc1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5pbWFnZSA9PT0gXCJzdHJpbmdcIikgY3R4TXNnLmltYWdlID0gYXdhaXQgcmVzb2x2ZVNyYyhmbGFncy5pbWFnZSk7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLnRhZ3MgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgY3R4TXNnLnRhZ3MgPSBmbGFncy50YWdzXG4gICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgIC5tYXAoKHQpID0+IHQudHJpbSgpKVxuICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLmxpbmsgPT09IFwic3RyaW5nXCIpIGN0eE1zZy5saW5rID0gZmxhZ3MubGluaztcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgY3R4TXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwic3RhdHVzXCI6IHtcbiAgICAgIGNvbnN0IG9uID0gcG9zWzBdID09PSBcIm9uXCI7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogb24sIHRleHQ6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY29zdFwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogY29zdCA8dGV4dC4uLj5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjb3N0XCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoYW5kb2ZmXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJoYW5kb2ZmXCIsXG4gICAgICAgIHRleHQ6IGZsYWdzLmNsZWFyID09PSB0cnVlID8gXCJcIiA6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGNtZEluZm8oc2Vzc2lvbik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2Vzc2lvbnNcIjpcbiAgICAgIGNtZFNlc3Npb25zKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaGVscFwiOlxuICAgIGNhc2UgXCItLWhlbHBcIjpcbiAgICBjYXNlIFwiLWhcIjpcbiAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgICBicmVhaztcbiAgICBkZWZhdWx0OlxuICAgICAgZGllKGB1bmtub3duIHZlcmIgXCIke3ZlcmJ9XCIg4oCUIHJ1bjogY2xpLnRzIGhlbHBgKTtcbiAgfVxuICByZXR1cm4gMDtcbn1cblxuLyoqXG4gKiBUSEUgT05FIFBMQUNFIEEgRkFJTFVSRSBCRUNPTUVTIEFOIEVYSVQgQ09ERS5cbiAqXG4gKiBgZGllYCBUSFJPV1MgKGBzcmMva2l0L3dpcmUvZXJyb3JzLnRzYCksIHNvIGV2ZXJ5IHJhaXNlIGluIHRoaXMgZmlsZSDigJQgYW5kXG4gKiBldmVyeSByYWlzZSBpbiBhIGhlbHBlciByZWFjaGFibGUgZnJvbSBpdCDigJQgYXJyaXZlcyBoZXJlLCBpcyB3cml0dGVuIGFzIE9ORVxuICogSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIsIGFuZCBiZWNvbWVzIGEgdGF4b25vbXkgZXhpdCBjb2RlLiBUaGF0IGlzIHdoYXQgbGV0c1xuICogYSBmYWlsdXJlIHRocmVlIGZyYW1lcyBkb3duIHN0b3AgdHJ1bmNhdGluZyBpdHMgb3duIHN0ZG91dDogbm90aGluZyBleGl0c1xuICogZnJvbSBpbnNpZGUgYSB2ZXJiIGFueSBtb3JlLlxuICpcbiAqIOKblCBBIE5PTi1gQ2xpRXJyb3JgIElTIE5PVCBTV0FMTE9XRUQgSU5UTyBUSEUgVEFYT05PTVkuIGByZXBvcnRDbGlFcnJvcmBcbiAqIHJldHVybnMgYG51bGxgIGZvciBhIHRocm93IGl0IGRvZXMgbm90IHJlY29nbmlzZSwgYW5kIHRoZSBicmFuY2ggYmVsb3cgdHVybnNcbiAqIGl0IGludG8gYW4gSU5URVJOQUwgZW52ZWxvcGUgcmF0aGVyIHRoYW4gYSBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3RcbiAqIGlzIEpTT04gb24gc3RkZXJyIGZvciBFVkVSWSBmYWlsdXJlIOKAlCBidXQgaXQgZG9lcyBzbyBrbm93aW5nbHksIGluIG9uZSBwbGFjZSxcbiAqIGluc3RlYWQgb2YgYnkgYSBjYXRjaC1hbGwgdGhhdCB3b3VsZCByZXBvcnQgYW4gdW5leHBlY3RlZCBmYXVsdCBhcyBhIHRpZHlcbiAqIHVzYWdlIGVycm9yLlxuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIEEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZSDigJQgYGJhdGNoIDxwYXRoPmAgYW5kIGBjb250ZXh0IC0taW1hZ2VcbiAgICAvLyA8cGF0aD5gIGJvdGggcmVhZCBjYWxsZXItc3VwcGxpZWQgcGF0aHMsIHNvIEVOT0VOVCBoZXJlIGlzIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcInVzYWdlXCIsIG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgQ0xJJ3MgT05FIGVudHJ5LCBhbmQgaXQgaXMgdGhlIExBVU5DSEVSJ3MgdG8gY2FsbC5cbiAqXG4gKiDim5QgVEhFUkUgSVMgTk8gYGltcG9ydC5tZXRhLm1haW5gIEJMT0NLLCBBTkQgVEhBVCBJUyBUSEUgRklSU1QgVEhJTkcgQVxuICogQlVORExFIEJSRUFLUy4gYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSBgPHNraWxsPi9zY3JpcHRzL2NsaS50c2AsIG5ldmVyXG4gKiBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSwgc28gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIHRoZXJlIGFuZCB0aGVcbiAqIGJsb2NrIHRoYXQgdXNlZCB0byBzaXQgaGVyZSB3b3VsZCBuZXZlciBydW4g4oCUIHRoZSBDTEkgd291bGQgcHJpbnQgbm90aGluZ1xuICogYW5kIGV4aXQgMCBmb3IgZXZlcnkgdmVyYiwgd2hpY2ggcmVhZHMgbGlrZSBhbiBlbXB0eSByZXN1bHQgcmF0aGVyIHRoYW4gYVxuICogZGVhZCBiaW5hcnkgKHBsYXlib29rIEIzKS5cbiAqXG4gKiDimqAgVEhFIERSQUlORUQgRVhJVCBNT1ZFRCBUTyBUSEUgTEFVTkNIRVIsIElUIERJRCBOT1QgR08gQVdBWS4gYHJ1bigpYCBoYW5kc1xuICogYmFjayBhIGNvZGUgYW5kIHRoZSBsYXVuY2hlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYDsgaXQgbXVzdCBORVZFUiBiZVxuICogdGlkaWVkIGludG8gYHByb2Nlc3MuZXhpdChjb2RlKWAuIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlXG4gKiAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdFxuICogZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIGFuZCBpbWFnbyBzaGlwcyBsYXJnZSBzdGRvdXRcbiAqIHBheWxvYWRzIChgc3RhdGUgLS1mdWxsYCBpbmxpbmVzIGJhc2U2NCBpbWFnZXMpLCBzbyB0aGUgY2FsbGVyIHdvdWxkIGdldFxuICogd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgZml4ZWQgYW5kIGdhdGVkXG4gKiBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBgcnVuKClgIHRha2VzIE5PIEFSR1VNRU5UUzogdGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzXG4gKiBpdCwgd2hpY2ggaXMgdGhpcyBvbmUuIEEgZm9yd2FyZGVyIHRoYXQgcmVhZCBgcHJvY2Vzcy5hcmd2YCBpdHNlbGYgd291bGRcbiAqIG1hdGNoIHRoZSByb3N0ZXIgZW51bWVyYXRvcidzIGFyZy1wYXJzaW5nIHByZWRpY2F0ZSBhbmQgdGhlIGZsYWcgd2FyZCB3b3VsZFxuICogdGhlbiBqdWRnZSBpbWFnbydzIGRvY3VtZW50ZWQgZmxhZ3MgYWdhaW5zdCBhIGZpbGUgdGhhdCByZWNvZ25pc2VzIG5vbmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1biAxLjMuMTQgZmluZGluZyB0aGF0XG4gKiBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuIEl0IGlzIGEgREFFTU9OLXNpZGVcbiAqIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvbiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55XG4gKiBjbGllbnQuIEl0IHN0YXlzIHdoZXJlIGl0IHdhcyBtZWFzdXJlZC5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogSW1hZ28ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aCBoYWx2ZXNcbiAqIG9mIHRoZSBzcGVsbC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLCBBTkQgSVQgSVMgVEhFIENMRUFORVNUIFBST09GIFRIRSBQT1JUIFdPUktFRC5cbiAqIEJlZm9yZSBQaGFzZSAzIHRoZSBoZWFydGJlYXQgd2FzIGEgTElURVJBTCBgMTUwMDBgIGluc2lkZSBgc2VydmVyLnRzYCdzXG4gKiBgc3NlUmVzcG9uc2VgLCBzaXR0aW5nIHVuZGVyIGEgY29tbWVudCBhYm91dCBgaWRsZVRpbWVvdXQ6IDI1NWAgd3JpdHRlbiAxLDMwMFxuICogbGluZXMgYXdheSBpbiBhIGRpZmZlcmVudCBmdW5jdGlvbiDigJQgYW5kIGBjbGkudHNgIGhhZCBOTyBjb3JyZXNwb25kaW5nIG51bWJlclxuICogYXQgYWxsOiBpdHMgdGFpbCBsb29wIGJsb2NrZWQgb24gYHJlYWRlci5yZWFkKClgIHdpdGggbm8gd2F0Y2hkb2csIHdoaWNoIGlzXG4gKiB0aGUgZmFpbHVyZSBgdGFpbEV2ZW50c2AgZXhpc3RzIHRvIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXIsXG4gKiBiZWNhdXNlIHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uIHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaFxuICogaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aG9zZSBvbmx5IGltcG9ydHMgYXJlIHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXNcbiAqIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS4gQSB2YWx1ZSB0aGF0IGNvdWxkIG5vdFxuICogcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBJTUFHTydTIE9XTiBIRUFSVEJFQVQsIE5FVkVSIENPUElFRFxuICogRlJPTSBBIFNJQkxJTkcuKiogQXN0cm9sYWJlIGJlYXRzIGF0IDEwIHMgYW5kIGltYWdvIGF0IDE1IHMsIHNvIGEgaGFyZC1jb2RlZFxuICogd2F0Y2hkb2cgaXMgY29ycmVjdCBmb3IgYXQgbW9zdCBvbmUgb2YgdGhlbS4gQXN0cm9sYWJlIG1lYXN1cmVkIHdoYXQgYSBjb3BpZWRcbiAqIG51bWJlciBkb2VzOiBhIDQ1IHMgd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkXG4gKiByZWNvbm5lY3RzIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeVxuICogZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi5cbiAqIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgYmVhdCBpdCBpcyB3YXRjaGluZyxcbiAqIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBoZWFydGJlYXRNcyxcbiAgaWRsZVRpbWVvdXRTZWMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSwgYW5kIGl0IGlzIGltYWdvJ3Mgb3duIG1lYXN1cmVkIHZhbHVlIHJhdGhlciB0aGFuIGFuIGluaGVyaXRlZFxuICogb25lOiBgc2VydmVyLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB1bmRlciBhIGNvbW1lbnQgcmVjb3JkaW5nIHRoYXRcbiAqIEJ1bidzIGRlZmF1bHQgMTAgcyBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZSB0aGUgMTUgcyBrZWVwYWxpdmVcbiAqIGV2ZXIgZmlyZXMg4oCUIFwidGhlIGtlZXBhbGl2ZSBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiBrZWVwaW5nIGFsaXZlIGlzIGdvbmVcIiwgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGJlYXQgcmF0ZSB3b3VsZCBub3QgaGF2ZVxuICogaGVscGVkLiBgSU1BR09fSURMRV9USU1FT1VUX1NFQ2AgaXMgYWNjZXB0ZWQgc28gdGhlIHBhaXIgY2FuIGJlIHR1bmVkXG4gKiBUT0dFVEhFUjsgdGhlIGNsYW1wIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMoXG4gIHByb2Nlc3MuZW52LklNQUdPX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCDigJQgaW1hZ28ncyBvd24gbGl0ZXJhbCAxNSBzIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZCwgbm93XG4gKiBDTEFNUEVEIHRvIGhhbGYgdGhlIGlkbGUgdGltZW91dC5cbiAqXG4gKiDim5QgVEhFIENMQU1QIElTIFRIRSBGSVggRk9SIFRIRSBCVUcgVEhJUyBTUEVMTCBBTFJFQURZIFBBSUQgRk9SLiBUaGUgb2xkIGNvZGVcbiAqIHdyb3RlIDE1IHMgYW5kIDI1NSBzIGluIHR3byBkaWZmZXJlbnQgZnVuY3Rpb25zIGFuZCByZWNvcmRlZCB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIERlcml2aW5nIGl0XG4gKiBtYWtlcyBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWQgcGFpci5cbiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuSU1BR09fSEVBUlRCRUFUX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC5cbiAqXG4gKiDimqAgNDUsMDAwIG1zIGF0IHRoZSBkZWZhdWx0cy4gaW1hZ28ncyBDTEkgaGFzIG5vIGAtLXN0YXJ0LXRpbWVvdXRgOyB0aGUgbnVtYmVyXG4gKiBpdCBtaWdodCBiZSBjb25mdXNlZCB3aXRoIGlzIGBjbWRPcGVuYCdzIDUsMDAwIG1zIHN0YXJ0IGRlYWRsaW5lLCB3aGljaCBpcyBhXG4gKiBkaWZmZXJlbnQgcXVhbnRpdHkgZW50aXJlbHkg4oCUIG9uZSBib3VuZHMgYSBmaXJzdCBidW5kbGUgYnVpbGQsIHRoZSBvdGhlclxuICogYm91bmRzIGEgc2lsZW50IHNvY2tldC4gTmFtZWQgaGVyZSBzbyBub2JvZHkgbGF0ZXIgXCJkZS1kdXBsaWNhdGVzXCIgdGhlbS5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBOEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxzQkFBUzs7O0FDa0JGLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBYVosU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8sVUFBVSxFQUFFLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQztB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QUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sU0FBUyxJQUFJO0FBQUEsSUFDMUIsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLFdBQVcsZUFBZSxDQUFDO0FBQUEsSUFDakMsSUFBSSxhQUFhO0FBQUEsTUFBTSxPQUFPO0FBQUEsSUFDOUIsTUFBTSxPQUNKLEtBQUssT0FBTyxNQUFNLFlBQVksVUFBVSxJQUFJLE9BQVEsRUFBd0IsSUFBSSxJQUFJO0FBQUEsSUFDdEYsTUFBTSxNQUFNLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsSUFHckQsSUFBSSxTQUFTO0FBQUEsTUFBVSxPQUFPLGVBQWUsSUFBSSxTQUFTLFNBQVMsR0FBRyxDQUFDLEtBQUs7QUFBQSxJQUM1RSxPQUFPLGVBQWUsSUFBSSxTQUFTLFlBQVksR0FBRyxDQUFDLEtBQUs7QUFBQTtBQUFBO0FBNEI1RCxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI5QjkyQUUxNEJGRkEyQkQzNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
