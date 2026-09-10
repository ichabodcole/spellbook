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
var RECOGNIZED_FLAGS = Object.keys(CLI_OPTIONS).map((k) => `--${k}`).sort();
var VERBS = [
  "open",
  "tail",
  "state",
  "say",
  "propose",
  "ask",
  "batch",
  "focus",
  "select",
  "analyze",
  "context",
  "status",
  "cost",
  "handoff",
  "close",
  "info",
  "sessions",
  "help"
];
var VERB_ALIASES = ["--help", "-h"];
var VERB_CHOICES = [...VERBS, ...VERB_ALIASES];
var VALID_CONTEXT_KINDS = ["prompt", "style", "skill", "context"];
var VALID_CONTEXT_LINKS = ["active", "quickPrompts"];

class UsageError extends Error {
  extra;
  constructor(message, extra) {
    super(message);
    this.extra = extra;
  }
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
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    throw new UsageError(`${detail}
` + `  for free text containing dashes, use --stdin, or put it after a bare --`, code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? { choices: [...RECOGNIZED_FLAGS] } : undefined);
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
    die(e.message, "usage", e.extra);
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
      const [kindArg, ...nameWords] = pos;
      if (!kindArg || !VALID_CONTEXT_KINDS.includes(kindArg)) {
        die(`usage: context <kind> <name...> [--content "<text>"] [--image <path|url>] [--link active|quickPrompts] [--tags a,b,c]`, "usage", { hint: "kind is the first positional", choices: [...VALID_CONTEXT_KINDS] });
      }
      if (!nameWords.length)
        die("usage: context <kind> <name...> \u2014 at least one name word required");
      if (typeof flags.link === "string" && !VALID_CONTEXT_LINKS.includes(flags.link)) {
        die(`invalid --link '${flags.link}'`, "usage", { choices: [...VALID_CONTEXT_LINKS] });
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
      die(`unknown verb "${verb}"`, "usage", {
        hint: "run: cli.ts help",
        choices: [...VERB_CHOICES]
      });
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
  RECOGNIZED_FLAGS,
  VALID_CONTEXT_KINDS,
  VALID_CONTEXT_LINKS,
  VERBS,
  VERB_ALIASES,
  VERB_CHOICES,
  main,
  parseArgs,
  run
};

//# debugId=22C38F14E6288E1264756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2ltYWdvL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9lcnJvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvaW1hZ28vYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGltYWdvIENMSSDigJQgdGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgcGVyLXNlc3Npb24gZGFlbW9uJ3MgSFRUUCBzdXJmYWNlXG4vLyAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyBhIGdyb3VuZGVkIGltYWdlIGNvbnZlcnNhdGlvbiB0aHJvdWdoIHRoZXNlXG4vLyB2ZXJiczsgYHRhaWxgIHN0cmVhbXMgdXNlciBldmVudHMgYXMgSlNPTkwgZm9yIE1vbml0b3IgdG8gd3JhcC5cbi8vXG4vLyBMaWZlY3ljbGU6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiBbLS10aXRsZSAuLl0gWy0tbm8tb3Blbl0gICAjIHNwYXduIGEgc2Vzc2lvblxuLy8gICBidW4gY2xpLnRzIHRhaWwgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBTU0UgdXNlciBldmVudHMg4oaSIEpTT05MIChNb25pdG9yIHRoaXMpXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tZnVsbF0gICAgICAgICAgICAgICAgICAjIGxlYW4gc3RhdGUgc25hcHNob3Rcbi8vXG4vLyBUYWxraW5nICsgZHJpdmluZyB0aGUgY2FudmFzIChQT1NUIC9jbWQpOlxuLy8gICBidW4gY2xpLnRzIHNheSA8dGV4dC4uLj4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgcG9zdCBhZ2VudCBkaWFsb2d1ZVxuLy8gICBidW4gY2xpLnRzIHByb3Bvc2UgPHByb21wdC4uLj4gWy0tbiBOXSAgICAgICAgICAgICAgICAgICAgICMgcHJvcG9zZSBhIHByb21wdCB0byBzZW5kXG4vLyAgIGJ1biBjbGkudHMgYXNrIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0gICAgICAgICAgICAgICAjIGFzayB0aGUgdXNlciAoaW4tdGhyZWFkKVxuLy8gICBidW4gY2xpLnRzIGJhdGNoIFstLWtpbmQgZ2VuZXJhdGV8ZWRpdF0gWy0tcHJvbXB0IC4uXSBbLS10YWcgLi5dXG4vLyAgICAgICAgICAgICAgICAgICAgWy0tZWRpdGVkLWZyb20gPHZhcmlhbnRJZD5dIFstLXN1bW1hcnkgLi5dIDxzcmMxPiA8c3JjMj4gLi4uXG4vLyAgICAgICAgICAgICAgICAgICAgIyBlYWNoIHNyYyA9IGFuIGh0dHAocykgdXJsLCBhIGRhdGE6IHVybCwgb3IgYSBmaWxlIHBhdGhcbi8vICAgYnVuIGNsaS50cyBmb2N1cyA8YmF0Y2hJZD4gPHZhcmlhbnRJZD4gICAgICAgICAgICAgICAgICAgICMgcHV0IGFuIGltYWdlIG9uIHRoZSBjYW52YXNcbi8vICAgYnVuIGNsaS50cyBjb250ZXh0IDxraW5kPiA8bmFtZS4uLj4gWy0tY29udGVudCBcIjx0ZXh0PlwiXSBbLS1pbWFnZSA8cGF0aHx1cmw+XVxuLy8gICAgICAgICAgICAgICAgICAgIFstLWxpbmsgYWN0aXZlfHF1aWNrUHJvbXB0c10gWy0tdGFncyBhLGIsY11cbi8vICAgICAgICAgICAgICAgICAgICAjIGFkZC91cHNlcnQgYSBDb250ZXh0IExpYnJhcnkgZW50cnkgKGtpbmQ6IHByb21wdHxzdHlsZXxza2lsbHxjb250ZXh0KVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgICAgICAgICAgICAgIyB0aGUgd29ya2luZyBzcGlubmVyXG4vLyAgIGJ1biBjbGkudHMgY29zdCA8dGV4dC4uLj4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBjdW11bGF0aXZlIHNwZW5kIGRpc3BsYXlcbi8vICAgYnVuIGNsaS50cyBoYW5kb2ZmIDx0ZXh0Li4uPiB8IGhhbmRvZmYgLS1jbGVhciAgICAgICAgICAgICMgZXNjYWxhdGUgdG8gYSB0ZXJtaW5hbCBhc2tcbi8vICAgYnVuIGNsaS50cyBjbG9zZSB8IGluZm8gfCBzZXNzaW9ucyB8IGhlbHBcbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD5cbi8vIHRvIHRhcmdldCBhIHNwZWNpZmljIG9uZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgQ2xpRXJyb3IsXG4gIGRpZSxcbiAgdHlwZSBFcnJFeHRyYSxcbiAgdHlwZSBFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbiAgc2V0Q3VycmVudENvbW1hbmQsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50cy50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5cbi8vIOKblCBFVkVSWSBQQVRIIEJFTE9XIElTIFJFU09MVkVEIEZST00gVEhFIEVNSVRURUQgQlVORExFLCBORVZFUiBGUk9NIFRISVMgRklMRS5cbi8vIFRoaXMgbW9kdWxlIGlzIGF1dGhvcmVkIGhlcmUgYW5kIFNISVBTIEJVSUxUIGF0XG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2ltYWdvL2Rpc3QvY2xpLmpzYCwgaW1wb3J0ZWQgYnkgdGhlIGxhdW5jaGVyIGF0XG4vLyBgLi4vc2NyaXB0cy9jbGkudHNgIChiYWNrZW5kIGNvbnZlcmdlbmNlIFBoYXNlIDM7IHNlYW1zIENvbnRyYWN0IDQnc1xuLy8gYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLiBgaW1wb3J0Lm1ldGEudXJsYCB0aGVyZWZvcmUgbmFtZXMgYGRpc3QvY2xpLmpzYCxcbi8vIHNvIGBTQ1JJUFRfRElSYCBpcyBgPHNraWxsPi9kaXN0L2AgYW5kIGBTS0lMTF9ST09UYCBpcyB0aGUgc2tpbGwgcm9vdCDigJQgd2hpY2hcbi8vIGlzIHdoYXQgdGhlIHR3byBsaW5lcyBiZWxvdyBhbHJlYWR5IG1lYW50IGZyb20gYHNjcmlwdHMvYCwgdW5jaGFuZ2VkLCBiZWNhdXNlXG4vLyBgZGlzdC9gIHNpdHMgYXQgdGhlIHNhbWUgZGVwdGggYXMgdGhlIGBzY3JpcHRzL2AgaXQgcmVwbGFjZWQuIOKaoCBUSEFUIElTIEFcbi8vIENPSU5DSURFTkNFIE9GIERFUFRILCBOT1QgQSBQUk9QRVJUWTogYHJlbGVhc2Utc2VydmUudGVzdC50c2AgYXNzZXJ0cyBpdFxuLy8gcmF0aGVyIHRoYW4gdHJ1c3RpbmcgaXQuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyDim5QgVVAgQU5EIEJBQ0sgRE9XTiwgTkVWRVIgYGpvaW4oU0NSSVBUX0RJUiwgXCJzZXJ2ZXIudHNcIilgLiBUaGUgZGFlbW9uIGlzXG4vLyBzcGF3bmVkIGJ5IFBBVEgsIGFuZCB0aGUgcGF0aCBpcyB0aGUgTEFVTkNIRVIgYXQgYDxza2lsbD4vc2NyaXB0cy9zZXJ2ZXIudHNgXG4vLyDigJQgYSByZWFsIGAudHNgIGZpbGUgdGhhdCBpbXBvcnRzIGAuLi9kaXN0L3NlcnZlci5qc2AuIFRoZSBzaWJsaW5nIHNwZWxsaW5nXG4vLyB0aGlzIGxpbmUgdXNlZCB0byBjYXJyeSB3YXMgY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgaXRzZWxmIGxpdmVkIGluXG4vLyBgc2NyaXB0cy9gOyBmcm9tIGBkaXN0L2AgaXQgcmVzb2x2ZXMgdG8gYGRpc3Qvc2VydmVyLnRzYCwgYSBmaWxlIHRoYXQgZG9lc1xuLy8gbm90IGFuZCBtdXN0IG5vdCBleGlzdCwgYW5kIHRoZSBzeW1wdG9tIGlzIG5vdCBhIGNyYXNoIOKAlCBgb3BlbmAgd2FpdHMgb3V0IGl0c1xuLy8gc3RhcnQgZGVhZGxpbmUgYW5kIHJlcG9ydHMgYSB0aW1lb3V0LCB3aGljaCByZWFkcyBsaWtlIGEgc2xvdyBmaXJzdCBidWlsZC5cbi8vIGdsYW1vdXIgc2hpcHBlZCBleGFjdGx5IHRoYXQgZGVmZWN0IGluIFBoYXNlIDIgKHBsYXlib29rIEI0KS5cbi8vIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgaXMgdGhlIGluc3RydW1lbnQgdGhhdCBjYXRjaGVzIGFcbi8vIHJlZ3Jlc3Npb24gaGVyZTsgY29uZmlybSBpdHMgY292ZXJhZ2Ugcm93IG5hbWVzIGltYWdvIHdpdGggYSBub24temVybyBwaW5cbi8vIGNvdW50LCBiZWNhdXNlIGEgd2FyZCB3aG9zZSBwb3B1bGF0aW9uIGlzIGRlcml2ZWQgaXMgbm90IHRoZXJlYnkgQ09WRVJFRC5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2UsIGFuZCBCdW4gcmVhZHMgYnVuZmlnLnRvbWxcbi8vICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyB0aGUgZGFlbW9uJ3MgY3dkIE1VU1QgYmUgc3JjL2ltYWdvL1xuLy8gKHNlYW1zIENvbnRyYWN0IDUgY3dkLXBpbikg4oCUIGxhdW5jaGVkIGFueXdoZXJlIGVsc2UgdGhlIGRldiBidW5kbGVyIGNhbm5vdFxuLy8gY29tcGlsZSB0aGUgc3R5bGVzaGVldCAobWVhc3VyZWQgb24gZ2xhbW91cjogdGhlIFBBR0UgNTAwcyB3aXRoIG5vIHN0eWxlc2hlZXRcbi8vIGxpbms7IG5vdCBcInVuc3R5bGVkIGF0IDIwMFwiIOKAlCB0aGF0IHNlbnRlbmNlIHdhcyBuZXZlciBydW47IGltYWdvJ3Mgb3duIGZhaWx1cmVcbi8vIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kXG4vLyBzdGF0aWMg4oCUIG5vIGJ1bmZpZyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlXG4vLyBtYXJrZXRwbGFjZSBjbG9uZSBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkXG4vLyBicmVhayB0aGUgc3Bhd24uXG4vLyDimqAgVGhlIGZpdmUgYC4uYCBhcmUgY291bnRlZCBmcm9tIGA8c2tpbGw+L2Rpc3QvYCwgd2hpY2ggaXMgd2hlcmUgdGhpcyBsaW5lXG4vLyBFWEVDVVRFUyDigJQgbm90IGZyb20gYHNyYy9pbWFnby9iYWNrZW5kL2AsIHdoZXJlIGl0IGlzIHdyaXR0ZW4uIFJlYWQgYXMgYW5cbi8vIG9yZGluYXJ5IHJlbGF0aXZlIHBhdGggb2YgdGhlIGZpbGUgaXQgc2l0cyBpbiBpdCB3b3VsZCBjbGltYiBvdXQgb2YgdGhlIHJlcG8uXG4vLyBJdCBpcyB0aGUgc2FtZSBzdHJpbmcgYXMgYmVmb3JlIHRoZSByZWxvY2F0aW9uIG9ubHkgYmVjYXVzZSBgZGlzdC9gIGFuZFxuLy8gYHNjcmlwdHMvYCBzaXQgYXQgdGhlIHNhbWUgZGVwdGggKEQxMSdzIGNvaW5jaWRlbmNlLW9mLWRlcHRoLCBhZ2FpbikuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiaW1hZ29cIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgU05BUFNIT1RTX0RJUiA9IGpvaW4ocHJvY2Vzcy5lbnYuSU1BR09fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuaW1hZ29cIiksIFwic25hcHNob3RzXCIpO1xuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG4gIFwiLmpwZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuanBlZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG4gIFwiLnN2Z1wiOiBcImltYWdlL3N2Zyt4bWxcIixcbn07XG5cbnR5cGUgU2Vzc2lvbiA9IHtcbiAgdXJsOiBzdHJpbmc7XG4gIHBvcnQ6IG51bWJlcjtcbiAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlc19kaXI/OiBzdHJpbmc7XG4gIC8qKiBUaGUgZGFlbW9uJ3MgcmVzb2x2ZWQgc3VyZmFjZSBtb2RlIChDb250cmFjdCAxKS4gQWRkaXRpdmUtb3B0aW9uYWw6IGFcbiAgICogIHNlc3Npb24gZmlsZSB3cml0dGVuIGJ5IGFuIG9sZGVyIGRhZW1vbiBoYXMgbm8gYG1vZGVgLCBhbmQgYWJzZW50IG1lYW5zXG4gICAqICBcInVua25vd25cIiwgbmV2ZXIgXCJkZXZcIi4gKi9cbiAgbW9kZT86IFwiZGV2XCIgfCBcInJlbGVhc2VcIjtcbn07XG5cbi8qKlxuICog4puUIGBkaWVgIElTIE5PVyBUSEUgSE9VU0UnUyAoYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSBBTkQgSVQgVEhST1dTIFJBVEhFUlxuICogVEhBTiBFWElUUyDigJQgYW5kIGZvciBpbWFnbyB0aGF0IGlzIGEgQ0FMTEVSLVZJU0lCTEUgQ0hBTkdFLCBzdGF0ZWQgaGVyZVxuICogcmF0aGVyIHRoYW4gYWJzb3JiZWQuIFRoZSBmdW5jdGlvbiB0aGlzIHJlcGxhY2VzIHdyb3RlIGBpbWFnbzogPG1zZz5gIHRvXG4gKiBzdGRlcnIgYXMgUFJPU0UgYW5kIGV4aXRlZCAqKjIgZm9yIGV2ZXJ5IGZhaWx1cmUqKjogYSBtaXNzaW5nIHNlc3Npb24sIGFuXG4gKiB1bnJlYWNoYWJsZSBkYWVtb24sIGEgYmFkIGZsYWcgYW5kIGFuIGludGVybmFsIGZhdWx0IHdlcmUgb25lIG51bWJlci4gQVxuICogZmFpbHVyZSBub3cgZW1pdHMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIGFuZCB0aGUgZXhpdCBjb2RlIGNvbWVzIGZyb21cbiAqIHRoZSB0YXhvbm9teSDigJQgdXNhZ2UgMiwgaW50ZXJuYWwgMSwgbm90X2ZvdW5kIDUsIGNvbmZsaWN0IDYg4oCUIHNvIGFuIGFnZW50IGNhblxuICogcm91dGUgb24gYGtpbmRgIGluc3RlYWQgb2YgbWF0Y2hpbmcgcHJvc2UuIFNlZSBkZWNpc2lvbiBEMzguXG4gKlxuICogVGhlIFRIUk9XIGlzIHRoZSBvdGhlciBoYWxmLCBhbmQgaXQgaXMgd2h5IEI5J3MgYXVkaXQgaGFkIHRvIGJlIHJ1bjogQnVuJ3NcbiAqIHN0ZG91dCBpcyBhc3luY2hyb25vdXMgb24gYSBwaXBlLCBzbyBhbiBleGl0IGZyb20gdGhyZWUgZnJhbWVzIGRvd24gZGlzY2FyZHNcbiAqIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZC4gRXZlcnkgZmFpbHVyZSBub3cgbGVhdmVzIHRocm91Z2ggYG1haW5gJ3MgZnVubmVsLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgYSBzaWxlbnRcbiAqIGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIEF1ZGl0ZWQgYnkgY2FsbCBncmFwaCwgbm90IGJ5IGdyZXAg4oCUIHRoZSBjb3VudFxuICogYW5kIHRoZSBjbGFzc2lmaWNhdGlvbiBhcmUgaW4gdGhlIHBoYXNlIDMgam91cm5hbC5cbiAqL1xuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuLyoqIEEgcmVmdXNhbCBmcm9tIGltYWdvJ3Mgb3duIGRhZW1vbiwgY2FycmllZCBWRVJCQVRJTSB1bmRlciBgZXJyb3Iuc2VydmVyYCBzb1xuICogIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkIHJhdGhlciB0aGFuIG9uIHRoaXNcbiAqICBDTEkncyBwcm9zZSBhYm91dCBpdC4gVGhlIHN0YXR1c+KGkmtpbmQgbWFwIGlzIHRoZSBob3VzZSdzLiAqL1xuZnVuY3Rpb24gZGFlbW9uUmVmdXNlZCh3aGF0OiBzdHJpbmcsIHN0YXR1czogbnVtYmVyLCBkYXRhOiB1bmtub3duKTogbmV2ZXIge1xuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICBzdGF0dXMgPT09IDQwMFxuICAgICAgPyBcInVzYWdlXCJcbiAgICAgIDogc3RhdHVzID09PSA0MDRcbiAgICAgICAgPyBcIm5vdF9mb3VuZFwiXG4gICAgICAgIDogc3RhdHVzID09PSA0MDlcbiAgICAgICAgICA/IFwiY29uZmxpY3RcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICBkaWUoYCR7d2hhdH0gZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBraW5kLCB7XG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzZXNzaW9uID8gam9pbih0bXBkaXIoKSwgYGltYWdvLSR7c2Vzc2lvbn0uanNvbmApIDogam9pbih0bXBkaXIoKSwgXCJpbWFnby1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIOKblCBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFLlxuICpcbiAqICBUaGlzIGNhdWdodCBldmVyeSBlcnJvciBmcm9tIHRoZSByZWFkIGFuZCByZXR1cm5lZCBudWxsLCBzbyBhIGNvcnJ1cHRcbiAqICBwb2ludGVyLCBhbiBFQUNDRVMsIGFuZCBhbnkgdHJhbnNpZW50IHRoZSBPUyByYWlzZXMgdW5kZXIgbG9hZCBhbGwgYXJyaXZlZFxuICogIGF0IHRoZSBjYWxsZXJzIHdlYXJpbmcgYWJzZW5jZSdzIGNsb3RoZXMg4oCUIGFuZCB0aGUgY2FsbGVycyBhY3Qgb24gYWJzZW5jZTpcbiAqICB0aGV5IHJlcG9ydCBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiLCBhbmQgYSB0YWlsIGxvb3AgcmVhZHMgaXQgYXMgXCJ0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbiB3ZW50IGF3YXlcIiBhbmQgZXhpdHMgMC4gQSByZXNvdXJjZSBmYWlsdXJlIHdhcyB0aGVyZWZvcmUgcmVwb3J0ZWRcbiAqICBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBpbiBnbGFtb3VyLCB3aG9zZSBjb3B5IG9mIHRoaXMgZnVuY3Rpb24gaXMgYnl0ZS1pZGVudGljYWw6IGl0cyBDTElcbiAqICBjb250cmFjdCBjZWxsIGZhaWxlZCBvbmNlIHVuZGVyIHRoZSBmdWxsIGdhdGUgd2l0aCB0aGUgbm90X2ZvdW5kIGV4aXQgd2hlcmVcbiAqICB0aGUgY29udHJhY3Qgc2FpZCB1c2FnZSwgYW5kIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuLiBGaXhlZCB0aGVyZVxuICogIDIwMjYtMDktMDc7IGZvdW5kIHN0aWxsIHN0YW5kaW5nIGhlcmUgMjAyNi0wOS0wOCBieSB0aGUgYmFja2VuZCBkdXBsaWNhdGlvblxuICogIHJlY29uIChkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtYmFja2VuZC1kdXBsaWNhdGlvbi1yZWNvbi5tZCkuXG4gKlxuICogIEVOT0VOVCBpcyB0aGUgb25seSBob25lc3QgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHNheXMgd2hhdCBpdCB3YXMuXG4gKlxuICogIOKaoCBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgd2hpY2ggaXMgd2hhdCBsZXRzXG4gKiAgdW5wYXJzZWFibGUgY29udGVudCBjb3VudCBhcyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGEgaGFsZi13cml0dGVuIHJlYWQuICovXG5mdW5jdGlvbiByZWFkU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvbiB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgaW1hZ28gc2Vzc2lvblwiLCBcIm5vdF9mb3VuZFwiLCBOT19TRVNTSU9OX0hJTlQpO1xuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgIG9yIGJvb2xlYW4gYC0tZmxhZ2AuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhlIGhhbmQtcm9sbGVkIHBhcnNlciBoYWQgbm8gcmVnaXN0cnksIHNvIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXRcbi8vIGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhc1xuLy8gc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC4gYG5vZGU6dXRpbGAgc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiwgdGhlXG4vLyBgPWAgZm9ybSBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBmcm9tIHRoZSBzdGFuZGFyZCBsaWJyYXJ5LlxuLy9cbi8vIFR5cGVzIGFyZSB0aG90aCdzIGF1ZGl0ZWQgYXJ0aWZhY3QgKDE3IHN0cmluZyDCtyAzIGJvb2xlYW4pLCBlYWNoIHNldHRsZWQgYnlcbi8vIHVuYW1iaWd1b3VzIGV2aWRlbmNlIGF0IGV2ZXJ5IGNvbnN1bXB0aW9uIHNpdGUuIEdldHRpbmcgb25lIHdyb25nIGlzIG5vdCBhXG4vLyBuby1vcDogYSBcInN0cmluZ1wiIHRoYXQgc2hvdWxkIGJlIGJvb2xlYW4gU1dBTExPV1MgVEhFIE5FWFQgUE9TSVRJT05BTCwgYW5kIGFcbi8vIFwiYm9vbGVhblwiIHRoYXQgc2hvdWxkIGJlIHN0cmluZyBicmVha3MgdGhlIHNwYWNlIGZvcm0uLy9cbi8vIGBraW5kYCBpcyBTVFJJTkcgZGVzcGl0ZSByZWFkaW5nIGFzIGBmbGFncy5raW5kID09PSBcImVkaXRcImAg4oCUIGl0IGlzIGNvbXBhcmVkXG4vLyB0byBhIHN0cmluZyBsaXRlcmFsLCBub3QgdGVzdGVkIGZvciBwcmVzZW5jZS4gRGVjbGFyaW5nIGl0IGJvb2xlYW4gdGhlcmVcbi8vIHdvdWxkIG1ha2UgYC0ta2luZCBlZGl0YCBwdXNoIFwiZWRpdFwiIGludG8gcG9zaXRpb25hbHMgYW5kIHRoZSBjb21wYXJpc29uXG4vLyB3b3VsZCBuZXZlciBtYXRjaDogYSBzaWxlbnQgbm8tb3AsIG5vdCBhIGNyYXNoLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGNvbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImVkaXRlZC1mcm9tXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbWFnZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGtpbmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaW5rOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWxzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9wdGlvbnM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwcm9tcHQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3VtbWFyeTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRhZ3M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmdWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIOKUgOKUgCBUSEUgQUNDRVBURUQgU0VUUywgREVDTEFSRUQgT05DRSAocmVnaXN0ZXIgQTEpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBjaG9pY2VzYCBpcyAqd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQqLCBhbmQgaXQgaXMgb25seSB3b3J0aCBlbWl0dGluZ1xuICogd2hpbGUgaXQgaXMgdGhlIEFDVFVBTCBzZXQuIGBSRUNPR05JWkVEX0ZMQUdTYCBpcyBkZXJpdmVkIGZyb20gYENMSV9PUFRJT05TYCxcbiAqIHRoZSBvYmplY3QgYHBhcnNlQXJnc2AgaGFuZHMgYG5vZGU6dXRpbGA7IGBWRVJCU2AgaXMgYm91bmQgdG8gdGhlIGRpc3BhdGNoXG4gKiBzd2l0Y2ggYnkgYGNsaS50ZXN0LnRzYCwgYmVjYXVzZSBhIGNhc2UgbGFiZWwgaXMgbm90IGEgdmFsdWUuXG4gKi9cbmV4cG9ydCBjb25zdCBSRUNPR05JWkVEX0ZMQUdTOiByZWFkb25seSBzdHJpbmdbXSA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKVxuICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgLnNvcnQoKTtcblxuLyoqIFRoZSBkaXNwYXRjaGVkIHZlcmJzLCBpbiB0aGUgc3dpdGNoJ3Mgb3duIG9yZGVyLiAqL1xuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJvcGVuXCIsXG4gIFwidGFpbFwiLFxuICBcInN0YXRlXCIsXG4gIFwic2F5XCIsXG4gIFwicHJvcG9zZVwiLFxuICBcImFza1wiLFxuICBcImJhdGNoXCIsXG4gIFwiZm9jdXNcIixcbiAgXCJzZWxlY3RcIixcbiAgXCJhbmFseXplXCIsXG4gIFwiY29udGV4dFwiLFxuICBcInN0YXR1c1wiLFxuICBcImNvc3RcIixcbiAgXCJoYW5kb2ZmXCIsXG4gIFwiY2xvc2VcIixcbiAgXCJpbmZvXCIsXG4gIFwic2Vzc2lvbnNcIixcbiAgXCJoZWxwXCIsXG5dO1xuXG4vKiogVGhlIGZsYWctc2hhcGVkIHNwZWxsaW5ncyBvZiBgaGVscGAsIHdoaWNoIHRoZSBzd2l0Y2ggYWxzbyBhbnN3ZXJzLiAqL1xuZXhwb3J0IGNvbnN0IFZFUkJfQUxJQVNFUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXCItLWhlbHBcIiwgXCItaFwiXTtcblxuLyoqIFdoYXQgdGhlIHJvb3QgYWN0dWFsbHkgYWNjZXB0cyBhcyBhIGZpcnN0IHRva2VuLiAqL1xuZXhwb3J0IGNvbnN0IFZFUkJfQ0hPSUNFUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbLi4uVkVSQlMsIC4uLlZFUkJfQUxJQVNFU107XG5cbi8qKlxuICogYGNvbnRleHQgPGtpbmQ+YCdzIGFuZCBgLS1saW5rYCdzIGFjY2VwdGVkIHZhbHVlcyDigJQgdGhlIHR3byBFTlVNRVJBVEVEIHR5cGVzXG4gKiBpbiB0aGlzIENMSS4gSG9pc3RlZCBvdXQgb2YgYGNhc2UgXCJjb250ZXh0XCJgIHNvIHRoZSByZWplY3Rpb24gYW5kIHRoZSBjaGVja1xuICogcmVhZCBvbmUgYXJyYXkgKHRoZXkgd2VyZSB0d28gY29waWVzOiBhIGBWQUxJRF8qYCBjb25zdCBmb3IgdGhlIHRlc3QgYW5kIHRoZVxuICogc2FtZSBtZW1iZXJzIHJlLXR5cGVkIGludG8gdGhlIG1lc3NhZ2UncyBwcm9zZSkuXG4gKi9cbmV4cG9ydCBjb25zdCBWQUxJRF9DT05URVhUX0tJTkRTID0gW1wicHJvbXB0XCIsIFwic3R5bGVcIiwgXCJza2lsbFwiLCBcImNvbnRleHRcIl0gYXMgY29uc3Q7XG5leHBvcnQgY29uc3QgVkFMSURfQ09OVEVYVF9MSU5LUyA9IFtcImFjdGl2ZVwiLCBcInF1aWNrUHJvbXB0c1wiXSBhcyBjb25zdDtcblxuY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgLy8g4puUIFJFR0lTVEVSIEExIOKAlCBUSEUgUk9TVEVSIFJJREVTIGBjaG9pY2VzYCwgTk9UIFRIRSBTRU5URU5DRS4gVGhlXG4gIC8vIHJlY29nbmlzZWQtZmxhZyBzZXQgdXNlZCB0byBiZSBidWlsdCBpbnRvIHRoaXMgY2xhc3MncyBNRVNTQUdFLCBzbyB0aGUgb25lXG4gIC8vIHNldCBhbiBhZ2VudCByb3V0ZXMgb24gd2FzIHJlYWNoYWJsZSBvbmx5IGJ5IHBhcnNpbmcgcHJvc2UuXG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3M6IHN0cmluZ1tdKToge1xuICBwb3M6IHN0cmluZ1tdO1xuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG59IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJncyxcbiAgICAgIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4geyBwb3M6IHBvc2l0aW9uYWxzLCBmbGFnczogdmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+IH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBkZXRhaWwgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgLy8g4puUIFRIRSBTRVQgTU9WRUQsIElUIFdBUyBOT1QgQ09QSUVEIOKAlCBlbWl0dGluZyBpdCB0d2ljZSwgb25jZSBhcyBkYXRhIGFuZFxuICAgIC8vIG9uY2UgaW5zaWRlIHRoZSBtZXNzYWdlLCBpcyBob3cgb25lIGNvcHkgcm90cyAoQTEncyBydWxlKS4gQW5kIGBjaG9pY2VzYFxuICAgIC8vIG9ubHkgZm9yIGFuIFVOS05PV04gT1BUSU9OOiBub2RlJ3Mgb3RoZXIgcGFyc2UgcmVqZWN0aW9ucyBtZWFuIGFcbiAgICAvLyByZWNvZ25pc2VkIGZsYWcgZ290IGEgdmFsdWUgZnJvbSBhbiBvcGVuIHNldCwgYW5kIHRoZSBmbGFnIHJvc3RlciB3b3VsZFxuICAgIC8vIHBvaW50IGF0IHRoZSBoYWxmIHRoYXQgd2FzIHJpZ2h0LiBSb3V0ZWQgb24gdGhlIGVycm9yIENPREUsIG5vdCBwcm9zZS5cbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYCR7ZGV0YWlsfVxcbmAgKyBgICBmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCB1c2UgLS1zdGRpbiwgb3IgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLWAsXG4gICAgICBjb2RlID09PSBcIkVSUl9QQVJTRV9BUkdTX1VOS05PV05fT1BUSU9OXCIgPyB7IGNob2ljZXM6IFsuLi5SRUNPR05JWkVEX0ZMQUdTXSB9IDogdW5kZWZpbmVkLFxuICAgICk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJjbWRcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IG1zZy50eXBlIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmIChmbGFncy50aXRsZSkgYXJncy5wdXNoKFwiLS10aXRsZVwiLCBTdHJpbmcoZmxhZ3MudGl0bGUpKTtcbiAgaWYgKGZsYWdzLnRpbWVvdXQpIGFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBTdHJpbmcoZmxhZ3MudGltZW91dCkpO1xuICBpZiAoZmxhZ3MucmVzdG9yZSkgYXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIFN0cmluZyhmbGFncy5yZXN0b3JlKSk7XG4gIGlmIChmbGFnc1tcIm5vLW9wZW5cIl0pIGFyZ3MucHVzaChcIi0tbm8tb3BlblwiKTtcblxuICBjb25zdCBwcmV2SWQgPSByZWFkU2Vzc2lvbigpPy5zZXNzaW9uX2lkO1xuICAvLyBub2RlOmNoaWxkX3Byb2Nlc3MgKG5vdCBCdW4uc3Bhd24pIGlzIGRlbGliZXJhdGUgKyBtYXRjaGVzIGdyYXBldmluZS9ib3VudHk6XG4gIC8vIHRoZSBkYWVtb24gbXVzdCBTVVJWSVZFIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdGluZywgd2hpY2ggbmVlZHMgYGRldGFjaGVkOiB0cnVlYFxuICAvLyArIGB1bnJlZigpYC4gQnVuLnNwYXduIGNhbid0IGRldGFjaCBhIHN1cnZpdmluZyBkYWVtb24g4oCUIHNvIHRoZSBob3VzZSBwYXR0ZXJuXG4gIC8vIGZvciBzcGF3bmluZyBhIHN0YW5kaW5nIGRhZW1vbiBpcyBub2RlJ3Mgc3Bhd24uIChDTEFVREUubWQncyBCdW4tc3Bhd24gcHJlZlxuICAvLyBhcHBsaWVzIHRvIGluLXByb2Nlc3MgY2hpbGQgY29tbWFuZHMsIG5vdCBkZXRhY2hlZCBkYWVtb25zLilcbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGFyZ3MsIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgLy8gQ29udHJhY3QgNSDigJQgc2VlIGRhZW1vbkN3ZCgpLiBBIHdyb25nIGN3ZCBza2lwcyBidW5maWcudG9tbCdzIFRhaWx3aW5kXG4gICAgLy8gcGx1Z2luOyBvbiBnbGFtb3VyIHRoYXQgZmFpbHMgdGhlIHBhZ2Ugb3V0cmlnaHQgKDUwMCkuIEFzc2VydCB0aGUgaW52YXJpYW50LFxuICAgIC8vIG5vdCB0aGUgc3RhdHVzOiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gY3dkIGlzIHdyb25nLlxuICAgIGN3ZDogZGFlbW9uQ3dkKCksXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IHNsZWVwKDgwKTtcbiAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oKTtcbiAgICBpZiAocyAmJiBzLnNlc3Npb25faWQgIT09IHByZXZJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fS9zdGF0ZWApO1xuICAgICAgICBpZiAoci5vaykge1xuICAgICAgICAgIHByaW50SnNvbihzKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBub3QgdXAgeWV0ICovXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGRpZShcImltYWdvIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDVzXCIsIFwiaW50ZXJuYWxcIiwge1xuICAgIGhpbnQ6IFwidGhlIGRhZW1vbiB3cml0ZXMgaXRzIGRpc2NvdmVyeSBwb2ludGVyIG9uY2UgaXQgaGFzIGJvdW5kOyBjaGVjayBmb3IgYSBzdGFsZSAkVE1QRElSL2ltYWdvLWxhdGVzdC5qc29uXCIsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uPzogc3RyaW5nLCBmdWxsID0gZmFsc2UpIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiXCIgOiBcIj9sZWFuPTFcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG4vKipcbiAqIFRoZSBldmVudCB0YWlsIOKAlCBPTkUgQ0FMTCBpbnRvIHRoZSBob3VzZSdzIHNoYXJlZCBTU0UgY2xpZW50XG4gKiAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoZXJlIHRoZSByZWNvbm5lY3QgbG9vcCwgdGhlIHNwZWMtY29ycmVjdFxuICogZnJhbWUgcGFyc2VyLCB0aGUgYmFja29mZiwgdGhlIGlkbGUgd2F0Y2hkb2cgYW5kIHRoZSBkcmFpbmVkIGV4aXQgbGl2ZSBvbmNlXG4gKiBmb3IgZXZlcnkgc3BlbGwuXG4gKlxuICog4puUICoqVEhFIEhBTkQtUk9MTEVEIExPT1AgVEhJUyBSRVBMQUNFUyBIQUQgVEhFIENPTlNUQU5ULUJBQ0tPRkYgREVGRUNULCBBTkRcbiAqIElNQUdPJ1MgQ09QWSBXQVMgV09SU0UgVEhBTiBUSEUgT05FIEdMQU1PVVIgUEFJRCBGT1IuKiogSXQgc2V0IGBkZWxheSA9IDI1MGAsXG4gKiBkb3VibGVkIGl0IG9uIHRocmVlIGZhaWx1cmUgYnJhbmNoZXMg4oCUIGFuZCBSRVNFVCBJVCBUTyAyNTAgb24gZXZlcnkgc3VjY2Vzc2Z1bFxuICogT1BFTiwgYmVmb3JlIHJlYWRpbmcgYSBieXRlLiBBIGRhZW1vbiB0aGF0IGFjY2VwdHMgYSBjb25uZWN0aW9uIGFuZFxuICogaW1tZWRpYXRlbHkgZHJvcHMgaXQgd2FzIHRoZXJlZm9yZSByZWNvbm5lY3RlZCBhZ2FpbnN0IGF0IGEgY29uc3RhbnQgMjUwIG1zLFxuICogZm9yZXZlciwgd2l0aCBubyBncm93dGg6IGEgcmVjb25uZWN0IHN0b3JtIHRoYXQgcmVhZHMgYXMgYSBoZWFsdGh5IHJldHJ5LlxuICog4pqgIEFORCBJTUFHTyBIQUQgQSBGT1VSVEggU0lURSBUSEUgT1RIRVJTIERJRCBOT1Qg4oCUIGBhd2FpdCBzbGVlcChkZWxheSlgIGF0IHRoZVxuICogQk9UVE9NIG9mIHRoZSBvdXRlciBsb29wLCBhZnRlciB0aGUgc3RyZWFtIGVuZGVkLCB1c2luZyB3aGF0ZXZlciBgZGVsYXlgIHRoZVxuICogc3VjY2Vzc2Z1bCBvcGVuIGhhZCBqdXN0IHJlc2V0LiBJdCBjYW5ub3QgYmUgcmUtZXhwcmVzc2VkIGhlcmUsIGJlY2F1c2UgdGhlcmVcbiAqIGlzIG5vIGxvb3AgbGVmdCB0byBwdXQgaXQgaW4uXG4gKlxuICog4puUIEFORCBJVCBHQUlORUQgQSBXQVRDSERPRyBJVCBESUQgTk9UIEhBVkUuIFRoZSBvbGQgbG9vcCBibG9ja2VkIG9uXG4gKiBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgZm9yZXZlciwgc28gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVRcbiAqIHJlYmluZCBvciBhIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIGluIHNpbGVuY2Ugd2l0aCBubyB3YXkgb3V0LlxuICogYFRBSUxfSURMRV9NU2AgaXMgREVSSVZFRCBmcm9tIGltYWdvJ3Mgb3duIGhlYXJ0YmVhdCAoYC4vaGVhcnRiZWF0LnRzYCksIG5ldmVyXG4gKiBjb3BpZWQgZnJvbSBhIHNpYmxpbmcuXG4gKlxuICog4puUIGByZXNvbHZlYCBSRS1SRUFEUyBUSEUgU0VTU0lPTiBQT0lOVEVSIE9OIEVWRVJZIEFUVEVNUFQg4oCUIHdoaWNoIHRoZSBvbGRcbiAqIGxvb3AgZGlkIHRvbywgYW5kIHdoaWNoIHRoZSBzaGFyZWQgY2xpZW50IG1ha2VzIHN0cnVjdHVyYWw6IHRoZSBkYWVtb24gYmluZHNcbiAqIGFuIGVwaGVtZXJhbCBwb3J0LCBzbyBhIGNhcHR1cmVkIGJhc2UgaXMgYSB0YWlsIHRoYXQgc3Vydml2ZXMgb25lIGRhZW1vbi5cbiAqXG4gKiBQUkVTRVJWRUQgVkVSQkFUSU0sIGJlY2F1c2UgdGhleSBhcmUgaW1hZ28ncyBvd24gY29udHJhY3QgYW5kIG5vdCB0aGUgc2hhcmVkXG4gKiBjbGllbnQnczogdGhlIEZJUlNUIHJlc29sdmVkIHNlc3Npb24gaXMgcGlubmVkIGZvciB0aGUgbGlmZSBvZiB0aGUgd2F0Y2gsIHRoZVxuICogZ3JvdW5kaW5nIGxpbmUgbmFtZXMgdGhhdCBiaW5kaW5nIG9uY2Ugc28gYSB3cm9uZyBzZXNzaW9uL3BvcnQgaXMgb2J2aW91c1xuICogaW5zdGVhZCBvZiBzaWxlbnQsIGEgcG9pbnRlciB0aGF0IGRpc2FwcGVhcnMgQUZURVIgd2Ugd2VyZSBib3VuZCBlbmRzIHRoZVxuICogd2F0Y2ggYXQgMCAoYSBjb21wbGV0ZWQgd2F0Y2gsIG5vdCBhIGZhaWx1cmUpLCBhbmQgb25lIHRoYXQgbmV2ZXIgYXBwZWFyZWRcbiAqIGtlZXBzIHJldHJ5aW5nIHdpdGggYCMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmYCBvbiBzdGRlcnIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzaW5jZUFyZzogbnVtYmVyKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGJvdW5kSWQgPSBzZXNzaW9uO1xuICBsZXQgZ3JvdW5kZWQgPSBmYWxzZTtcblxuICByZXR1cm4gYXdhaXQgdGFpbEV2ZW50czx7IGlkPzogbnVtYmVyOyB0eXBlPzogc3RyaW5nIH0+KHtcbiAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICAvLyBgcmVhZFNlc3Npb25gIGRpZXMgb24gYSBDT1JSVVBUIHBvaW50ZXIgYW5kIHJldHVybnMgbnVsbCBvbmx5IGZvciBhXG4gICAgICAvLyBnZW51aW5lbHkgYWJzZW50IG9uZSDigJQgdGhlIEVOT0VOVCBydWxlLiBUaGF0IGBkaWVgIG5vdyBUSFJPV1MsIGFuZCB0aGVcbiAgICAgIC8vIHRocm93IGxlYXZlcyB0aGUgdGFpbCB0aHJvdWdoIG1haW4ncyBmdW5uZWwgaW5zdGVhZCBvZiBleGl0aW5nIGZyb21cbiAgICAgIC8vIHRocmVlIGZyYW1lcyBkb3duIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLiBJdCBpcyBCOSdzIGF1ZGl0IHBheWluZyBmb3JcbiAgICAgIC8vIGl0c2VsZjogdGhpcyBpcyB0aGUgb25lIGRpZS1yZWFjaGFibGUgY2FsbCB0aGUgc2hhcmVkIGNsaWVudCBpbnZva2VzIG9uXG4gICAgICAvLyBhIHNjaGVkdWxlLlxuICAgICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDsgLy8gcGluIHRvIHRoZSBmaXJzdCBzZXNzaW9uIHdlIHJlc29sdmVkXG4gICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgfSxcbiAgICBvblVucmVzb2x2ZWQ6ICh7IGV2ZXJSZXNvbHZlZCB9KSA9PiB7XG4gICAgICBpZiAoZXZlclJlc29sdmVkKSByZXR1cm4gXCJzdG9wXCI7IC8vIG91ciBwaW5uZWQgc2Vzc2lvbiB3ZW50IGF3YXkg4oaSIGRvbmVcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgIH0sXG4gICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgc2luY2U6IHNpbmNlQXJnLFxuICAgIGN1cnNvck9mOiAoZXYpID0+IGV2LmlkLFxuICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgb25Db21tZW50OiAoKSA9PiBcIjogaW1hZ28ta2VlcGFsaXZlXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBmaWxlVG9EYXRhVXJsKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ1ZiA9IHJlYWRGaWxlU3luYyhwYXRoKTtcbiAgY29uc3QgZG90ID0gcGF0aC5sYXN0SW5kZXhPZihcIi5cIik7XG4gIGNvbnN0IGV4dCA9IGRvdCA+PSAwID8gcGF0aC5zbGljZShkb3QpLnRvTG93ZXJDYXNlKCkgOiBcIlwiO1xuICBjb25zdCBtaW1lID0gTUlNRV9CWV9FWFRbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiO1xuICByZXR1cm4gYGRhdGE6JHttaW1lfTtiYXNlNjQsJHtidWYudG9TdHJpbmcoXCJiYXNlNjRcIil9YDtcbn1cblxuLy8gRG93bmxvYWQgYW4gaW1hZ2UgVVJMIGFuZCBpbmxpbmUgaXQgYXMgYSBkYXRhIFVSTCDigJQgc28gYSBnZW5lcmF0ZWQgdmFyaWFudFxuLy8gaXMgc2VsZi1jb250YWluZWQgKHBlcnNpc3RzIGluIHRoZSBzbmFwc2hvdCwgc3Vydml2ZXMgcHJlc2lnbmVkLVVSTCBleHBpcnkpLlxuYXN5bmMgZnVuY3Rpb24gdXJsVG9EYXRhVXJsKHVybDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsKTtcbiAgaWYgKCFyZXMub2spIGRpZShgZmV0Y2ggZmFpbGVkIChIVFRQICR7cmVzLnN0YXR1c30pOiAke3VybH1gLCBcInVzYWdlXCIpO1xuICBjb25zdCBidWYgPSBCdWZmZXIuZnJvbShhd2FpdCByZXMuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IG1pbWUgPSAocmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpIHx8IFwiaW1hZ2UvanBlZ1wiKS5zcGxpdChcIjtcIilbMF07XG4gIHJldHVybiBgZGF0YToke21pbWV9O2Jhc2U2NCwke2J1Zi50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xufVxuXG4vLyBSZXNvbHZlIGEgdmFyaWFudCBzb3VyY2UgYXJndW1lbnQ6IGFuIGh0dHAocykgVVJMIChkb3dubG9hZGVkICsgaW5saW5lZCksIGFcbi8vIGRhdGE6IFVSTCAocGFzc2VkIHRocm91Z2gpLCBvciBhIGxvY2FsIGZpbGUgcGF0aCAocmVhZCArIGlubGluZWQpLlxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVNyYyhhcmc6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QoYXJnKSkgcmV0dXJuIHVybFRvRGF0YVVybChhcmcpO1xuICBpZiAoYXJnLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcmV0dXJuIGFyZztcbiAgcmV0dXJuIGZpbGVUb0RhdGFVcmwoYXJnKTtcbn1cblxuZnVuY3Rpb24gY21kSW5mbyhzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIGltYWdvIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG5mdW5jdGlvbiBjbWRTZXNzaW9ucygpIHtcbiAgbGV0IGZpbGVzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBmaWxlcyA9IHJlYWRkaXJTeW5jKFNOQVBTSE9UU19ESVIpLmZpbHRlcigoZikgPT4gZi5lbmRzV2l0aChcIi5qc29uXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXCJubyBzYXZlZCBzZXNzaW9uc1xcblwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHlwZSBSb3cgPSB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGJhdGNoZXM6IG51bWJlcjsgZ2VuczogbnVtYmVyOyBtdGltZTogbnVtYmVyIH07XG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gW107XG4gIGZvciAoY29uc3QgZiBvZiBmaWxlcykge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKFNOQVBTSE9UU19ESVIsIGYpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG4gICAgICBjb25zdCBiYXRjaGVzID0gKHN0LmJhdGNoZXMgfHwgW10pIGFzIEFycmF5PHsgdmFyaWFudHM/OiB1bmtub3duW10gfT47XG4gICAgICByb3dzLnB1c2goe1xuICAgICAgICBpZDogZi5yZXBsYWNlKC9cXC5qc29uJC8sIFwiXCIpLFxuICAgICAgICB0aXRsZTogc3QudGl0bGUsXG4gICAgICAgIGJhdGNoZXM6IGJhdGNoZXMubGVuZ3RoLFxuICAgICAgICBnZW5zOiBiYXRjaGVzLnJlZHVjZSgobiwgYikgPT4gbiArIChiLnZhcmlhbnRzPy5sZW5ndGggPz8gMCksIDApLFxuICAgICAgICBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWVNcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCB1bnJlYWRhYmxlIHNuYXBzaG90ICovXG4gICAgfVxuICB9XG4gIHJvd3Muc29ydCgoYSwgYikgPT4gYi5tdGltZSAtIGEubXRpbWUpO1xuICBmb3IgKGNvbnN0IHIgb2Ygcm93cykge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3IuaWR9ICAke3IuYmF0Y2hlc30gYmF0Y2hlcyDCtyAke3IuZ2Vuc30gZ2VuZXJhdGlvbnMgIOKAlCAke3IudGl0bGV9XFxuYCk7XG4gIH1cbiAgaWYgKCFyb3dzLmxlbmd0aCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXCJubyBzYXZlZCBzZXNzaW9uc1xcblwiKTtcbn1cblxuY29uc3QgSEVMUCA9IGBpbWFnbyDigJQgYSBncm91bmRlZCBpbWFnZSBjb252ZXJzYXRpb24uXG5cbiAgb3BlbiAgIFstLXRpdGxlIC4uXSBbLS1uby1vcGVuXSBbLS10aW1lb3V0IFNdIFstLXJlc3RvcmUgPGlkfHBhdGg+XVxuICBzZXNzaW9ucyAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Qgc2F2ZWQgKHJlc3VtYWJsZSkgc2Vzc2lvbnNcbiAgdGFpbCAgIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3IpXG4gIHN0YXRlICBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgbGVhbiBzdGF0ZSBzbmFwc2hvdCAoYWRkIC0tZnVsbCBmb3IgcmF3IGluY2wuIGJhc2U2NClcbiAgc2F5ICAgIDx0ZXh0Li4uPiAgICAgICAgICAgICAgICAgICBwb3N0IGFnZW50IGRpYWxvZ3VlIGludG8gdGhlIGNvbnZlcnNhdGlvblxuICBwcm9wb3NlIDxwcm9tcHQuLi4+IFstLW4gTl0gICAgICAgIHByb3Bvc2UgYSBwcm9tcHQgZm9yIHRoZSB1c2VyIHRvIHNlbmQgKMOXTiwg4omkNClcbiAgYXNrICAgIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0gICBhc2sgdGhlIHVzZXIgYSBxdWVzdGlvbiAoaW4tdGhyZWFkKVxuICBiYXRjaCAgWy0ta2luZCBnZW5lcmF0ZXxlZGl0XSBbLS1wcm9tcHQgLi5dIFstLXRhZyAuLl0gWy0tZWRpdGVkLWZyb20gPHZpZD5dIFstLXN1bW1hcnkgLi5dIFstLW1vZGVscyBtMSxtMiwuLl0gPHNyYz4gLi4uXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWRkIGEgcHJvZHVjZWQgYmF0Y2g7IGVhY2ggc3JjID0gaHR0cCB1cmwsIGRhdGE6IHVybCwgb3IgZmlsZSBwYXRoOyAtLW1vZGVscyBsYWJlbHMgZWFjaCB2YXJpYW50XG4gIGZvY3VzICA8YmF0Y2hJZD4gPHZhcmlhbnRJZD4gICAgICAgcHV0IGFuIGltYWdlIG9uIHRoZSBjYW52YXNcbiAgc2VsZWN0IDx2YXJpYW50SWQ+IFtvZmZdICAgICAgICAgICBwb2ludCBhIHZhcmlhbnQgYXQgdGhlIG5leHQgZ2VuIGFzIGEgcmVmZXJlbmNlIChoaWdobGlnaHRzIGl0IGZvciB0aGUgdXNlcilcbiAgYW5hbHl6ZSA8dmFyaWFudElkPiA8dGV4dC4uLj4gICAgICB3cml0ZSB5b3VyIHJlYWQgb250byBhbiBpbWFnZSAoZHVyYWJsZSBtZXRhZGF0YSlcbiAgY29udGV4dCA8a2luZD4gPG5hbWUuLi4+IFstLWNvbnRlbnQgXCI8dGV4dD5cIl0gWy0taW1hZ2UgPHBhdGh8dXJsPl0gWy0tbGluayBhY3RpdmV8cXVpY2tQcm9tcHRzXSBbLS10YWdzIGEsYixjXVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFkZC91cHNlcnQgYSBDb250ZXh0IExpYnJhcnkgZW50cnkgKGtpbmQ6IHByb21wdHxzdHlsZXxza2lsbHxjb250ZXh0KVxuICBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZiAgIHNob3cvaGlkZSB0aGUgXCJpbWFnbyB3b3JraW5nXCIgc3Bpbm5lclxuICBjb3N0ICAgPHRleHQuLi4+ICAgICAgICAgICAgICAgICAgIGN1bXVsYXRpdmUgc3BlbmQgZGlzcGxheSAoZS5nLiBcIiQwLjM4IMK3IDggaW1nc1wiKVxuICBoYW5kb2ZmIDx0ZXh0Li4uPiB8IGhhbmRvZmYgLS1jbGVhciAgIHJhaXNlL2NsZWFyIGEgdGVybWluYWwtYXNrIGVzY2FsYXRpb25cbiAgY2xvc2UgfCBpbmZvIHwgaGVscFxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byB0YXJnZXQgYSBzcGVjaWZpYyBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuYDtcblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbdmVyYiwgLi4ucmVzdF0gPSBhcmd2O1xuICAvLyBOYW1lcyB0aGUgdmVyYiBpbiBldmVyeSBlbnZlbG9wZSdzIGBtZXRhLmNvbW1hbmRgLCBzbyBhIGNhbGxlciByZWFkaW5nIGFcbiAgLy8gZmFpbHVyZSBrbm93cyB3aGljaCBpbnZvY2F0aW9uIHByb2R1Y2VkIGl0IHdpdGhvdXQgY29ycmVsYXRpbmcuXG4gIHNldEN1cnJlbnRDb21tYW5kKHR5cGVvZiB2ZXJiID09PSBcInN0cmluZ1wiID8gdmVyYiA6IG51bGwpO1xuICAvLyBBIHVzYWdlIGZhaWx1cmUgUkVUVVJOUyByYXRoZXIgdGhhbiBleGl0aW5nLCBzbyB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0LlxuICBsZXQgcG9zOiBzdHJpbmdbXTtcbiAgbGV0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbiAgdHJ5IHtcbiAgICAoeyBwb3MsIGZsYWdzIH0gPSBwYXJzZUFyZ3MocmVzdCkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKCEoZSBpbnN0YW5jZW9mIFVzYWdlRXJyb3IpKSB0aHJvdyBlO1xuICAgIC8vIFRoZSBwYXJzZXIncyBvd24gZXJyb3IgY2xhc3MsIGNvbnZlcnRlZCBhdCB0aGUgYm91bmRhcnkgaW50byB0aGUgaG91c2VcbiAgICAvLyBlbnZlbG9wZS4gYFVzYWdlRXJyb3JgIHN0YXlzIGJlY2F1c2UgaXQgY2FycmllcyB0aGUgcmVjb2duaXNlZC1mbGFnIHNldFxuICAgIC8vIHRoYXQgYHBhcnNlQXJnc2AgYnVpbGRzIOKAlCBhcyBgY2hvaWNlc2Agbm93LCBub3QgYXMgcHJvc2UgaW4gdGhlIG1lc3NhZ2UuXG4gICAgZGllKGUubWVzc2FnZSwgXCJ1c2FnZVwiLCBlLmV4dHJhKTtcbiAgfVxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJ0YWlsXCI6XG4gICAgICBhd2FpdCBjbWRUYWlsKHNlc3Npb24sIHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlSW50KGZsYWdzLnNpbmNlLCAxMCkgOiAtMSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic3RhdGVcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNheVwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogc2F5IDx0ZXh0Li4uPlwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNheVwiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwicHJvcG9zZVwiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZShcInVzYWdlOiBwcm9wb3NlIDxwcm9tcHQuLi4+IFstLW4gTl1cIik7XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlOiBcInByb3Bvc2VcIiwgcHJvbXB0OiBwb3Muam9pbihcIiBcIikgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MubiA9PT0gXCJzdHJpbmdcIikgbXNnLm4gPSBwYXJzZUludChmbGFncy5uLCAxMCk7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG1zZyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImFza1wiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZSgndXNhZ2U6IGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdJyk7XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlOiBcImFza1wiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Mub3B0aW9ucyA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBtc2cub3B0aW9ucyA9IGZsYWdzLm9wdGlvbnNcbiAgICAgICAgICAuc3BsaXQoXCJ8XCIpXG4gICAgICAgICAgLm1hcCgocykgPT4gcy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgbXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiYmF0Y2hcIjoge1xuICAgICAgaWYgKCFwb3MubGVuZ3RoKSB7XG4gICAgICAgIGRpZShcbiAgICAgICAgICBcInVzYWdlOiBiYXRjaCBbLS1raW5kIGdlbmVyYXRlfGVkaXRdIFstLXByb21wdCAuLl0gWy0tdGFnIC4uXSBbLS1lZGl0ZWQtZnJvbSA8dmlkPl0gWy0tc3VtbWFyeSAuLl0gWy0tbW9kZWxzIG0xLG0yLC4uXSA8c3JjPiAuLi5cXG5cIiArXG4gICAgICAgICAgICBcIiAgc3JjID0gYW4gaHR0cChzKSB1cmwsIGEgZGF0YTogdXJsLCBvciBhIGZpbGUgcGF0aDsgLS1tb2RlbHMgbGFiZWxzIGVhY2ggdmFyaWFudCBpbiBvcmRlclwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gb3B0aW9uYWwgcGVyLXZhcmlhbnQgbW9kZWwgbGFiZWxzLCBjb21tYS1zZXBhcmF0ZWQsIHBvc2l0aW9uYWwgdG8gc3Jjc1xuICAgICAgY29uc3QgbW9kZWxzID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLm1vZGVscyA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLm1vZGVscy5zcGxpdChcIixcIikubWFwKChtKSA9PiBtLnRyaW0oKSkgOiBbXTtcbiAgICAgIGNvbnN0IHZhcmlhbnRzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcG9zLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBzcmM6IGF3YWl0IHJlc29sdmVTcmMocG9zW2ldKSB9O1xuICAgICAgICBpZiAobW9kZWxzW2ldKSB2Lm1vZGVsID0gbW9kZWxzW2ldO1xuICAgICAgICB2YXJpYW50cy5wdXNoKHYpO1xuICAgICAgfVxuICAgICAgY29uc3QgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgdHlwZTogXCJiYXRjaC5hZGRcIixcbiAgICAgICAga2luZDogZmxhZ3Mua2luZCA9PT0gXCJlZGl0XCIgPyBcImVkaXRcIiA6IFwiZ2VuZXJhdGVcIixcbiAgICAgICAgcHJvbXB0OiB0eXBlb2YgZmxhZ3MucHJvbXB0ID09PSBcInN0cmluZ1wiID8gZmxhZ3MucHJvbXB0IDogXCJcIixcbiAgICAgICAgdmFyaWFudHMsXG4gICAgICB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy50YWcgPT09IFwic3RyaW5nXCIpIG1zZy50YWcgPSBmbGFncy50YWc7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzW1wiZWRpdGVkLWZyb21cIl0gPT09IFwic3RyaW5nXCIpIG1zZy5lZGl0ZWRGcm9tVmFyaWFudElkID0gZmxhZ3NbXCJlZGl0ZWQtZnJvbVwiXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc3VtbWFyeSA9PT0gXCJzdHJpbmdcIikgbXNnLnN1bW1hcnkgPSBmbGFncy5zdW1tYXJ5O1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBtc2cpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJmb2N1c1wiOlxuICAgICAgaWYgKHBvcy5sZW5ndGggPCAyKSBkaWUoXCJ1c2FnZTogZm9jdXMgPGJhdGNoSWQ+IDx2YXJpYW50SWQ+XCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZm9jdXNcIiwgYmF0Y2hJZDogcG9zWzBdLCB2YXJpYW50SWQ6IHBvc1sxXSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IHNlbGVjdCA8dmFyaWFudElkPiBbb2ZmXVwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlZi5zZWxlY3RcIiwgaWQ6IHBvc1swXSwgc2VsZWN0ZWQ6IHBvc1sxXSAhPT0gXCJvZmZcIiB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJhbmFseXplXCI6IHtcbiAgICAgIGlmIChwb3MubGVuZ3RoIDwgMikgZGllKFwidXNhZ2U6IGFuYWx5emUgPGltYWdlLWlkPiA8dGV4dC4uLj5cIik7XG4gICAgICBjb25zdCBbYWlkLCAuLi53b3Jkc10gPSBwb3M7XG4gICAgICAvLyByZWZzIGFyZSB2YXJpYW50cyBub3cg4oaSIG9uZSB2ZXJiIHdyaXRlcyBhIHJlYWQgb250byBhbnkgaW1hZ2UgKGluY2wuXG4gICAgICAvLyBtaWdyYXRlZCByZWZzIHRoYXQga2VwdCB0aGVpciBvbGQgXCJyZWYt4oCmXCIgaWQpXG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ2YXJpYW50LmFuYWx5emVcIiwgaWQ6IGFpZCwgdGV4dDogd29yZHMuam9pbihcIiBcIikgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImNvbnRleHRcIjoge1xuICAgICAgdHlwZSBDb250ZXh0S2luZCA9ICh0eXBlb2YgVkFMSURfQ09OVEVYVF9LSU5EUylbbnVtYmVyXTtcbiAgICAgIGNvbnN0IFtraW5kQXJnLCAuLi5uYW1lV29yZHNdID0gcG9zO1xuICAgICAgaWYgKCFraW5kQXJnIHx8ICFWQUxJRF9DT05URVhUX0tJTkRTLmluY2x1ZGVzKGtpbmRBcmcgYXMgQ29udGV4dEtpbmQpKSB7XG4gICAgICAgIC8vIOKblCBBTiBFTlVNRVJBVEVEIFBPU0lUSU9OQUwg4oCUIHRoZSBvbmUgY2xhc3Mgb2YgcG9zaXRpb25hbCB0aGF0IERPRVNcbiAgICAgICAgLy8gcXVhbGlmeSBmb3IgYGNob2ljZXNgLCBiZWNhdXNlIGl0cyBhY2NlcHRlZCBzZXQgaXMgY2xvc2VkIGFuZCBpblxuICAgICAgICAvLyBoYW5kLiBBIGZyZWUtdGV4dCBwb3NpdGlvbmFsIChhIG5hbWUsIGEgcHJvbXB0KSBoYXMgbm8gc3VjaCBzZXQgYW5kXG4gICAgICAgIC8vIGdldHMgbm9uZTsgc2VlIHRoZSB3YXJkJ3MgaGVhZGVyIGZvciB3aHkgdGhhdCBsaW5lIGlzIGRyYXduIGhlcmUuXG4gICAgICAgIGRpZShcbiAgICAgICAgICBgdXNhZ2U6IGNvbnRleHQgPGtpbmQ+IDxuYW1lLi4uPiBbLS1jb250ZW50IFwiPHRleHQ+XCJdIFstLWltYWdlIDxwYXRofHVybD5dIFstLWxpbmsgYWN0aXZlfHF1aWNrUHJvbXB0c10gWy0tdGFncyBhLGIsY11gLFxuICAgICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgICB7IGhpbnQ6IFwia2luZCBpcyB0aGUgZmlyc3QgcG9zaXRpb25hbFwiLCBjaG9pY2VzOiBbLi4uVkFMSURfQ09OVEVYVF9LSU5EU10gfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghbmFtZVdvcmRzLmxlbmd0aClcbiAgICAgICAgZGllKFwidXNhZ2U6IGNvbnRleHQgPGtpbmQ+IDxuYW1lLi4uPiDigJQgYXQgbGVhc3Qgb25lIG5hbWUgd29yZCByZXF1aXJlZFwiKTtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIGZsYWdzLmxpbmsgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgIVZBTElEX0NPTlRFWFRfTElOS1MuaW5jbHVkZXMoZmxhZ3MubGluayBhcyAodHlwZW9mIFZBTElEX0NPTlRFWFRfTElOS1MpW251bWJlcl0pXG4gICAgICApIHtcbiAgICAgICAgLy8gVGhlIHNldCB3YXMgYWxyZWFkeSBhIGNvbnN0IEhFUkUgYW5kIHN0aWxsIHdlbnQgb3V0IGFzIGBqb2luKFwiLCBcIilgXG4gICAgICAgIC8vIGluc2lkZSB0aGUgc2VudGVuY2Ug4oCUIHRoZSBleGFjdCBzaGFwZSBBMSBuYW1lczogdG9sZCB0aGUgaHVtYW4sIG5ldmVyXG4gICAgICAgIC8vIHRoZSBhZ2VudC4gU2FtZSBhcnJheSwgbm93IGFzIGRhdGEuXG4gICAgICAgIGRpZShgaW52YWxpZCAtLWxpbmsgJyR7ZmxhZ3MubGlua30nYCwgXCJ1c2FnZVwiLCB7IGNob2ljZXM6IFsuLi5WQUxJRF9DT05URVhUX0xJTktTXSB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGN0eE1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICAgIHR5cGU6IFwiY29udGV4dC5hZGRcIixcbiAgICAgICAga2luZDoga2luZEFyZyBhcyBDb250ZXh0S2luZCxcbiAgICAgICAgbmFtZTogbmFtZVdvcmRzLmpvaW4oXCIgXCIpLFxuICAgICAgICBjb250ZW50OiB0eXBlb2YgZmxhZ3MuY29udGVudCA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmNvbnRlbnQgOiBcIlwiLFxuICAgICAgfTtcbiAgICAgIC8vIGEgY2FwdHVyZWQgc3R5bGUgY2FycmllcyBhIGNhbm9uaWNhbCBleGFtcGxlIGltYWdlIChhIHZhcmlhbnQgcGF0aC91cmwpIOKGklxuICAgICAgLy8gaW5saW5lIGl0IHNvIGl0J3Mgc2VsZi1jb250YWluZWQsIGxpa2UgYmF0Y2ggc3Jjc1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5pbWFnZSA9PT0gXCJzdHJpbmdcIikgY3R4TXNnLmltYWdlID0gYXdhaXQgcmVzb2x2ZVNyYyhmbGFncy5pbWFnZSk7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLnRhZ3MgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgY3R4TXNnLnRhZ3MgPSBmbGFncy50YWdzXG4gICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgIC5tYXAoKHQpID0+IHQudHJpbSgpKVxuICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLmxpbmsgPT09IFwic3RyaW5nXCIpIGN0eE1zZy5saW5rID0gZmxhZ3MubGluaztcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgY3R4TXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwic3RhdHVzXCI6IHtcbiAgICAgIGNvbnN0IG9uID0gcG9zWzBdID09PSBcIm9uXCI7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogb24sIHRleHQ6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY29zdFwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogY29zdCA8dGV4dC4uLj5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjb3N0XCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoYW5kb2ZmXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJoYW5kb2ZmXCIsXG4gICAgICAgIHRleHQ6IGZsYWdzLmNsZWFyID09PSB0cnVlID8gXCJcIiA6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGNtZEluZm8oc2Vzc2lvbik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2Vzc2lvbnNcIjpcbiAgICAgIGNtZFNlc3Npb25zKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaGVscFwiOlxuICAgIGNhc2UgXCItLWhlbHBcIjpcbiAgICBjYXNlIFwiLWhcIjpcbiAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgICBicmVhaztcbiAgICBkZWZhdWx0OlxuICAgICAgZGllKGB1bmtub3duIHZlcmIgXCIke3ZlcmJ9XCJgLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsXG4gICAgICAgIGNob2ljZXM6IFsuLi5WRVJCX0NIT0lDRVNdLFxuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogVEhFIE9ORSBQTEFDRSBBIEZBSUxVUkUgQkVDT01FUyBBTiBFWElUIENPREUuXG4gKlxuICogYGRpZWAgVEhST1dTIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApLCBzbyBldmVyeSByYWlzZSBpbiB0aGlzIGZpbGUg4oCUIGFuZFxuICogZXZlcnkgcmFpc2UgaW4gYSBoZWxwZXIgcmVhY2hhYmxlIGZyb20gaXQg4oCUIGFycml2ZXMgaGVyZSwgaXMgd3JpdHRlbiBhcyBPTkVcbiAqIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyLCBhbmQgYmVjb21lcyBhIHRheG9ub215IGV4aXQgY29kZS4gVGhhdCBpcyB3aGF0IGxldHNcbiAqIGEgZmFpbHVyZSB0aHJlZSBmcmFtZXMgZG93biBzdG9wIHRydW5jYXRpbmcgaXRzIG93biBzdGRvdXQ6IG5vdGhpbmcgZXhpdHNcbiAqIGZyb20gaW5zaWRlIGEgdmVyYiBhbnkgbW9yZS5cbiAqXG4gKiDim5QgQSBOT04tYENsaUVycm9yYCBJUyBOT1QgU1dBTExPV0VEIElOVE8gVEhFIFRBWE9OT01ZLiBgcmVwb3J0Q2xpRXJyb3JgXG4gKiByZXR1cm5zIGBudWxsYCBmb3IgYSB0aHJvdyBpdCBkb2VzIG5vdCByZWNvZ25pc2UsIGFuZCB0aGUgYnJhbmNoIGJlbG93IHR1cm5zXG4gKiBpdCBpbnRvIGFuIElOVEVSTkFMIGVudmVsb3BlIHJhdGhlciB0aGFuIGEgc3RhY2sgdHJhY2Ug4oCUIHRoZSBwcm9jZXNzIGNvbnRyYWN0XG4gKiBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZSDigJQgYnV0IGl0IGRvZXMgc28ga25vd2luZ2x5LCBpbiBvbmUgcGxhY2UsXG4gKiBpbnN0ZWFkIG9mIGJ5IGEgY2F0Y2gtYWxsIHRoYXQgd291bGQgcmVwb3J0IGFuIHVuZXhwZWN0ZWQgZmF1bHQgYXMgYSB0aWR5XG4gKiB1c2FnZSBlcnJvci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgcmVwb3J0ZWQgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAvLyBBIG5hbWVkIGZpbGUgdGhhdCBpcyBub3QgdGhlcmUg4oCUIGBiYXRjaCA8cGF0aD5gIGFuZCBgY29udGV4dCAtLWltYWdlXG4gICAgLy8gPHBhdGg+YCBib3RoIHJlYWQgY2FsbGVyLXN1cHBsaWVkIHBhdGhzLCBzbyBFTk9FTlQgaGVyZSBpcyB0aGUgY2FsbGVyJ3MuXG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiByZXBvcnRDbGlFcnJvcihuZXcgQ2xpRXJyb3IoXCJ1c2FnZVwiLCBtc2cpKSA/PyAyO1xuICAgIHJldHVybiByZXBvcnRDbGlFcnJvcihuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBtc2cpKSA/PyAxO1xuICB9XG59XG5cbi8qKlxuICogVGhlIENMSSdzIE9ORSBlbnRyeSwgYW5kIGl0IGlzIHRoZSBMQVVOQ0hFUidzIHRvIGNhbGwuXG4gKlxuICog4puUIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIFRIQVQgSVMgVEhFIEZJUlNUIFRISU5HIEFcbiAqIEJVTkRMRSBCUkVBS1MuIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgYDxza2lsbD4vc2NyaXB0cy9jbGkudHNgLCBuZXZlclxuICogZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3MgZW50cnksIHNvIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSB0aGVyZSBhbmQgdGhlXG4gKiBibG9jayB0aGF0IHVzZWQgdG8gc2l0IGhlcmUgd291bGQgbmV2ZXIgcnVuIOKAlCB0aGUgQ0xJIHdvdWxkIHByaW50IG5vdGhpbmdcbiAqIGFuZCBleGl0IDAgZm9yIGV2ZXJ5IHZlcmIsIHdoaWNoIHJlYWRzIGxpa2UgYW4gZW1wdHkgcmVzdWx0IHJhdGhlciB0aGFuIGFcbiAqIGRlYWQgYmluYXJ5IChwbGF5Ym9vayBCMykuXG4gKlxuICog4pqgIFRIRSBEUkFJTkVEIEVYSVQgTU9WRUQgVE8gVEhFIExBVU5DSEVSLCBJVCBESUQgTk9UIEdPIEFXQVkuIGBydW4oKWAgaGFuZHNcbiAqIGJhY2sgYSBjb2RlIGFuZCB0aGUgbGF1bmNoZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWA7IGl0IG11c3QgTkVWRVIgYmVcbiAqIHRpZGllZCBpbnRvIGBwcm9jZXNzLmV4aXQoY29kZSlgLiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZVxuICogKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAqIGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBhbmQgaW1hZ28gc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4gKiBwYXlsb2FkcyAoYHN0YXRlIC0tZnVsbGAgaW5saW5lcyBiYXNlNjQgaW1hZ2VzKSwgc28gdGhlIGNhbGxlciB3b3VsZCBnZXRcbiAqIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIGZpeGVkIGFuZCBnYXRlZFxuICogaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogYHJ1bigpYCB0YWtlcyBOTyBBUkdVTUVOVFM6IHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlc1xuICogaXQsIHdoaWNoIGlzIHRoaXMgb25lLiBBIGZvcndhcmRlciB0aGF0IHJlYWQgYHByb2Nlc3MuYXJndmAgaXRzZWxmIHdvdWxkXG4gKiBtYXRjaCB0aGUgcm9zdGVyIGVudW1lcmF0b3IncyBhcmctcGFyc2luZyBwcmVkaWNhdGUgYW5kIHRoZSBmbGFnIHdhcmQgd291bGRcbiAqIHRoZW4ganVkZ2UgaW1hZ28ncyBkb2N1bWVudGVkIGZsYWdzIGFnYWluc3QgYSBmaWxlIHRoYXQgcmVjb2duaXNlcyBub25lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7IG1haW4gfTtcbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCByZXBhaXJlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhXG4gKiBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4g4puUIFJFQUNIQUJJTElUWSwgTk9UIENBTEwgU0lURVM6IGFcbiAqIEhFTFBFUiB0aGF0IGRpZXMsIGludm9rZWQgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAsIGhhcyBpdHMgYGRpZWAgYXRcbiAqIGEgc2l0ZSB0aGF0IHJlYWRzIGFzIHBlcmZlY3RseSBzYWZlLiBBbiBhZG9wdGluZyBzcGVsbCBtdXN0IGZvbGxvdyB0aGUgY2FsbFxuICogZ3JhcGgsIG5vdCBncmVwIGZvciBgZGllKGAuIEF1ZGl0ZWQgdGhhdCB3YXkgb24gYWRvcHRpb24g4oCUIDE1IHNpdGVzIGluXG4gKiBhc3Ryb2xhYmUsIDI5IGluIG1hZ3BpZSwgcGx1cyB0aGUgaGVscGVycyByZWFjaGFibGUgZnJvbSB0aGVtIOKAlCBhbmQgZXZlcnlcbiAqIHBhdGggaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLCBmcm9tIHdoaWNoIHRoZSB0aHJvd1xuICogcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKipcbiAqIEV4dHJhIGZpZWxkcyBhIGZhaWx1cmUgbWF5IGNhcnJ5LiBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC10YWlsLXJlYWRlci1jb252ZXJnZW5jZS5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7IGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7IGNvbW1lbnRzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikgcmV0dXJuIGNvZGU7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSByZXR1cm4gY29kZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEltYWdvJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGggaGFsdmVzXG4gKiBvZiB0aGUgc3BlbGwuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTSwgQU5EIElUIElTIFRIRSBDTEVBTkVTVCBQUk9PRiBUSEUgUE9SVCBXT1JLRUQuXG4gKiBCZWZvcmUgUGhhc2UgMyB0aGUgaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDE1MDAwYCBpbnNpZGUgYHNlcnZlci50c2Anc1xuICogYHNzZVJlc3BvbnNlYCwgc2l0dGluZyB1bmRlciBhIGNvbW1lbnQgYWJvdXQgYGlkbGVUaW1lb3V0OiAyNTVgIHdyaXR0ZW4gMSwzMDBcbiAqIGxpbmVzIGF3YXkgaW4gYSBkaWZmZXJlbnQgZnVuY3Rpb24g4oCUIGFuZCBgY2xpLnRzYCBoYWQgTk8gY29ycmVzcG9uZGluZyBudW1iZXJcbiAqIGF0IGFsbDogaXRzIHRhaWwgbG9vcCBibG9ja2VkIG9uIGByZWFkZXIucmVhZCgpYCB3aXRoIG5vIHdhdGNoZG9nLCB3aGljaCBpc1xuICogdGhlIGZhaWx1cmUgYHRhaWxFdmVudHNgIGV4aXN0cyB0byBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyLFxuICogYmVjYXVzZSB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGhcbiAqIGludG8gYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2hvc2Ugb25seSBpbXBvcnRzIGFyZSB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzXG4gKiBubyBzdWNoIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuIEEgdmFsdWUgdGhhdCBjb3VsZCBub3RcbiAqIHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gSU1BR08nUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIEFzdHJvbGFiZSBiZWF0cyBhdCAxMCBzIGFuZCBpbWFnbyBhdCAxNSBzLCBzbyBhIGhhcmQtY29kZWRcbiAqIHdhdGNoZG9nIGlzIGNvcnJlY3QgZm9yIGF0IG1vc3Qgb25lIG9mIHRoZW0uIEFzdHJvbGFiZSBtZWFzdXJlZCB3aGF0IGEgY29waWVkXG4gKiBudW1iZXIgZG9lczogYSA0NSBzIHdhdGNoZG9nIGFnYWluc3QgYW4gZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZFxuICogcmVjb25uZWN0cyBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3LjkgcyBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHlcbiAqIGRhZW1vbiwgaGFybWxlc3Mgb25seSBiZWNhdXNlIGFuIHVucmVsYXRlZCB0aGlyZCBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uXG4gKiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb20gdGhlIGJlYXQgaXQgaXMgd2F0Y2hpbmcsXG4gKiB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgaGVhcnRiZWF0TXMsXG4gIGlkbGVUaW1lb3V0U2VjLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEJ1bidzIG1heGltdW0sIGFuZCBpdCBpcyBpbWFnbydzIG93biBtZWFzdXJlZCB2YWx1ZSByYXRoZXIgdGhhbiBhbiBpbmhlcml0ZWRcbiAqIG9uZTogYHNlcnZlci50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50IHJlY29yZGluZyB0aGF0XG4gKiBCdW4ncyBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIDE1IHMga2VlcGFsaXZlXG4gKiBldmVyIGZpcmVzIOKAlCBcInRoZSBrZWVwYWxpdmUgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICoga2VlcGluZyBhbGl2ZSBpcyBnb25lXCIsIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBiZWF0IHJhdGUgd291bGQgbm90IGhhdmVcbiAqIGhlbHBlZC4gYElNQUdPX0lETEVfVElNRU9VVF9TRUNgIGlzIGFjY2VwdGVkIHNvIHRoZSBwYWlyIGNhbiBiZSB0dW5lZFxuICogVE9HRVRIRVI7IHRoZSBjbGFtcCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLlxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKFxuICBwcm9jZXNzLmVudi5JTUFHT19JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQg4oCUIGltYWdvJ3Mgb3duIGxpdGVyYWwgMTUgcyBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQsIG5vd1xuICogQ0xBTVBFRCB0byBoYWxmIHRoZSBpZGxlIHRpbWVvdXQuXG4gKlxuICog4puUIFRIRSBDTEFNUCBJUyBUSEUgRklYIEZPUiBUSEUgQlVHIFRISVMgU1BFTEwgQUxSRUFEWSBQQUlEIEZPUi4gVGhlIG9sZCBjb2RlXG4gKiB3cm90ZSAxNSBzIGFuZCAyNTUgcyBpbiB0d28gZGlmZmVyZW50IGZ1bmN0aW9ucyBhbmQgcmVjb3JkZWQgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBEZXJpdmluZyBpdFxuICogbWFrZXMgYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIHRydWUgZm9yIEFOWSBjb25maWd1cmVkIHBhaXIuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LklNQUdPX0hFQVJUQkVBVF9NUyxcbiAgSURMRV9USU1FT1VUX1NFQyxcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuXG4gKlxuICog4pqgIDQ1LDAwMCBtcyBhdCB0aGUgZGVmYXVsdHMuIGltYWdvJ3MgQ0xJIGhhcyBubyBgLS1zdGFydC10aW1lb3V0YDsgdGhlIG51bWJlclxuICogaXQgbWlnaHQgYmUgY29uZnVzZWQgd2l0aCBpcyBgY21kT3BlbmAncyA1LDAwMCBtcyBzdGFydCBkZWFkbGluZSwgd2hpY2ggaXMgYVxuICogZGlmZmVyZW50IHF1YW50aXR5IGVudGlyZWx5IOKAlCBvbmUgYm91bmRzIGEgZmlyc3QgYnVuZGxlIGJ1aWxkLCB0aGUgb3RoZXJcbiAqIGJvdW5kcyBhIHNpbGVudCBzb2NrZXQuIE5hbWVkIGhlcmUgc28gbm9ib2R5IGxhdGVyIFwiZGUtZHVwbGljYXRlc1wiIHRoZW0uXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQThCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0Esc0JBQVM7OztBQ2tCRixJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUlJLE1BQU0saUJBQWlCLE1BQU07QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUVULFdBQVcsQ0FBQyxNQUFlLFNBQWlCLE9BQWtCO0FBQUEsSUFDNUQsTUFBTSxPQUFPO0FBQUEsSUFDYixLQUFLLE9BQU87QUFBQSxJQUNaLEtBQUssT0FBTztBQUFBLElBQ1osS0FBSyxRQUFRO0FBQUE7QUFBQSxNQUdYLFFBQVEsR0FBVztBQUFBLElBQ3JCLE9BQU8sU0FBUyxLQUFLO0FBQUE7QUFFekI7QUFLTyxTQUFTLEdBQUcsQ0FBQyxTQUFpQixPQUFnQixTQUFTLE9BQXlCO0FBQUEsRUFDckYsTUFBTSxJQUFJLFNBQVMsTUFBTSxTQUFTLEtBQUs7QUFBQTtBQVNsQyxTQUFTLGNBQWMsQ0FDNUIsR0FDQSxNQUF5QyxRQUFRLFFBQ2xDO0FBQUEsRUFDZixJQUFJLEVBQUUsYUFBYTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQ3JDLElBQUksTUFBTSxjQUFjLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUNuRCxPQUFPLEVBQUU7QUFBQTs7O0FDaUhYLElBQU0sa0JBQWtCO0FBQ3hCLElBQU0sZ0JBQWdCLEVBQUUsV0FBVyxLQUFLLE9BQU8sS0FBSztBQVU3QyxTQUFTLGFBQWEsQ0FBQyxPQUErRDtBQUFBLEVBQzNGLE1BQU0sV0FBcUIsQ0FBQztBQUFBLEVBQzVCLE1BQU0sWUFBc0IsQ0FBQztBQUFBLEVBQzdCLElBQUksUUFBUTtBQUFBLEVBQ1osSUFBSSxVQUFVO0FBQUEsRUFFZCxXQUFXLFFBQVEsTUFBTSxNQUFNO0FBQUEsQ0FBSSxHQUFHO0FBQUEsSUFDcEMsSUFBSSxTQUFTO0FBQUEsTUFBSTtBQUFBLElBQ2pCLElBQUksS0FBSyxXQUFXLEdBQUcsR0FBRztBQUFBLE1BQ3hCLFNBQVMsS0FBSyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDM0I7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLFFBQVEsS0FBSyxRQUFRLEdBQUc7QUFBQSxJQUM5QixNQUFNLFFBQVEsVUFBVSxLQUFLLE9BQU8sS0FBSyxNQUFNLEdBQUcsS0FBSztBQUFBLElBQ3ZELElBQUksUUFBUSxVQUFVLEtBQUssS0FBSyxLQUFLLE1BQU0sUUFBUSxDQUFDO0FBQUEsSUFDcEQsSUFBSSxNQUFNLFdBQVcsR0FBRztBQUFBLE1BQUcsUUFBUSxNQUFNLE1BQU0sQ0FBQztBQUFBLElBQ2hELElBQUksVUFBVSxRQUFRO0FBQUEsTUFDcEIsVUFBVSxLQUFLLEtBQUs7QUFBQSxNQUNwQixVQUFVO0FBQUEsSUFDWixFQUFPLFNBQUksVUFBVSxTQUFTO0FBQUEsTUFDNUIsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUVGO0FBQUEsRUFFQSxJQUFJLENBQUM7QUFBQSxJQUFTLE9BQU8sRUFBRSxPQUFPLE1BQU0sU0FBUztBQUFBLEVBQzdDLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxNQUFNLFVBQVUsS0FBSztBQUFBLENBQUksRUFBRSxHQUFHLFNBQVM7QUFBQTtBQVVsRSxlQUFzQixVQUFjLENBQUMsTUFBd0M7QUFBQSxFQUMzRSxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLFNBQVMsS0FBSyxVQUFVO0FBQUEsRUFDOUIsTUFBTSxRQUFRLEtBQUssU0FBUztBQUFBLEVBQzVCLE1BQU0sZUFBZSxLQUFLLGdCQUFnQjtBQUFBLEVBRTFDLElBQUksU0FBUyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxRQUF1QjtBQUFBLEVBQzNCLElBQUksZUFBZTtBQUFBLEVBQ25CLElBQUksZ0JBQWdCO0FBQUEsRUFDcEIsSUFBSSxlQUFlO0FBQUEsRUFDbkIsSUFBSSxRQUFRLE1BQU07QUFBQSxFQUNsQixJQUFJLE9BQU87QUFBQSxFQWdCWCxJQUFJLFVBQVU7QUFBQSxFQUNkLElBQUksVUFBa0M7QUFBQSxFQUN0QyxJQUFJLGNBQW1DO0FBQUEsRUFDdkMsTUFBTSxPQUFPLENBQUMsYUFBcUI7QUFBQSxJQUNqQyxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxTQUFTLE1BQU07QUFBQSxJQUNmLGNBQWM7QUFBQTtBQUFBLEVBSWhCLE1BQU0sVUFBVSxDQUFDLE9BQ2YsSUFBSSxRQUFjLENBQUMsaUJBQWlCO0FBQUEsSUFDbEMsSUFBSTtBQUFBLE1BQVMsT0FBTyxhQUFhO0FBQUEsSUFDakMsTUFBTSxTQUFTLE1BQU07QUFBQSxNQUNuQixhQUFhLEtBQUs7QUFBQSxNQUNsQixjQUFjO0FBQUEsTUFDZCxhQUFhO0FBQUE7QUFBQSxJQUVmLE1BQU0sUUFBUSxXQUFXLFFBQVEsRUFBRTtBQUFBLElBQ25DLGNBQWM7QUFBQSxHQUNmO0FBQUEsRUFFSCxNQUFNLFdBQVcsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUM3QixNQUFNLGFBQWEsS0FBSyxZQUFZO0FBQUEsRUFDcEMsSUFBSSxZQUFZO0FBQUEsSUFDZCxRQUFRLEdBQUcsVUFBVSxRQUFRO0FBQUEsSUFDN0IsUUFBUSxHQUFHLFdBQVcsUUFBUTtBQUFBLEVBQ2hDO0FBQUEsRUFJQSxNQUFNLGFBQWEsQ0FBQyxNQUFlO0FBQUEsSUFDakMsSUFBSyxHQUF5QyxTQUFTO0FBQUEsTUFBUyxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRXhFLE1BQU0sYUFBYTtBQUFBLEVBSW5CLFdBQVcsS0FBSyxTQUFTLFVBQVU7QUFBQSxFQUVuQyxNQUFNLGdCQUFnQixNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ2xDLEtBQUssUUFBUSxpQkFBaUIsU0FBUyxhQUFhO0FBQUEsRUFDcEQsSUFBSSxLQUFLLFFBQVE7QUFBQSxJQUFTLEtBQUssQ0FBQztBQUFBLEVBRWhDLE1BQU0sT0FBTyxDQUFDLFNBQWlCO0FBQUEsSUFDN0IsSUFBSSxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUE7QUFBQSxFQUl2QixNQUFNLE9BQU8sQ0FBQyxTQUFvQztBQUFBLElBQ2hELElBQUksU0FBUyxRQUFRLFNBQVM7QUFBQSxNQUFXLElBQUksTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBO0FBQUEsRUFHaEUsSUFBSTtBQUFBLElBQ0YsT0FBTyxDQUFDLFNBQVM7QUFBQSxNQU1mLE1BQU0sT0FBTyxNQUFNLEtBQUssUUFBUTtBQUFBLE1BQ2hDLElBQUksU0FBUyxNQUFNO0FBQUEsUUFDakIsTUFBTSxVQUFVLEtBQUssZUFBZSxFQUFFLGNBQWMsY0FBYyxDQUFDLEtBQUs7QUFBQSxRQUN4RSxJQUFJLFlBQVk7QUFBQSxVQUFRLE9BQU87QUFBQSxRQUMvQixNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxRQUN2QztBQUFBLE1BQ0Y7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUVmLE1BQU0sU0FBUyxLQUFLLFFBQVEsUUFBUSxZQUFZLEtBQUssRUFBRSxPQUFPLE9BQU8sTUFBTSxFQUFFO0FBQUEsTUFDN0UsTUFBTSxLQUFLLElBQUksZ0JBQWdCLE1BQU0sRUFBRSxTQUFTO0FBQUEsTUFDaEQsTUFBTSxNQUFNLEdBQUcsT0FBTyxLQUFLLE9BQU8sS0FBSyxJQUFJLE9BQU87QUFBQSxNQUVsRCxVQUFVLElBQUk7QUFBQSxNQUNkLE1BQU0sYUFBYTtBQUFBLE1BQ25CLElBQUksV0FBaUQ7QUFBQSxNQUNyRCxNQUFNLGdCQUFnQixNQUFNO0FBQUEsUUFDMUIsSUFBSSxVQUFVO0FBQUEsVUFBRztBQUFBLFFBQ2pCLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsV0FBVyxXQUFXLE1BQU0sV0FBVyxNQUFNLEdBQUcsTUFBTTtBQUFBO0FBQUEsTUFVeEQsSUFBSTtBQUFBLE1BQ0osSUFBSTtBQUFBLFFBQ0YsTUFBTSxNQUFNLE1BQU0sS0FBSyxFQUFFLFFBQVEsV0FBVyxPQUFPLENBQUM7QUFBQSxRQUNwRCxPQUFPLEdBQUc7QUFBQSxRQUNWLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsVUFBVTtBQUFBLFFBQ1YsSUFBSTtBQUFBLFVBQVM7QUFBQSxRQUNiLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxrQkFBa0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFFBQy9ELE1BQU0sUUFBUSxLQUFLO0FBQUEsUUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFFBQ3ZDO0FBQUE7QUFBQSxNQUdGLElBQUk7QUFBQSxRQUNGLElBQUksQ0FBQyxJQUFJLElBQUk7QUFBQSxVQUVYLE1BQU0sS0FBSyxjQUFjLEdBQUc7QUFBQSxVQUs1QixNQUFNLElBQUksTUFBTSxPQUFPLEVBQUUsTUFBTSxNQUFNLEVBQUU7QUFBQSxVQUN2QyxLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sUUFBUSxRQUFRLElBQUksT0FBTyxDQUFDLENBQUM7QUFBQSxVQUMvRCxNQUFNLFFBQVEsS0FBSztBQUFBLFVBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxVQUN2QztBQUFBLFFBQ0Y7QUFBQSxRQUNBLElBQUksQ0FBQyxJQUFJLE1BQU07QUFBQSxVQUliLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxXQUFXLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQztBQUFBLFVBQ2xFLE1BQU0sUUFBUSxLQUFLO0FBQUEsVUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFVBQ3ZDO0FBQUEsUUFDRjtBQUFBLFFBRUEsZ0JBQWdCO0FBQUEsUUFDaEIsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLFFBRWQsTUFBTSxTQUFTLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDbEMsTUFBTSxVQUFVLElBQUk7QUFBQSxRQUNwQixJQUFJLE1BQU07QUFBQSxRQUVWLE9BQU8sQ0FBQyxTQUFTO0FBQUEsVUFDZixJQUFJO0FBQUEsVUFDSixJQUFJO0FBQUEsWUFDRixRQUFRLE1BQU0sT0FBTyxLQUFLO0FBQUEsWUFDMUIsT0FBTyxHQUFHO0FBQUEsWUFHVixJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxnQkFBZ0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFlBQzNFO0FBQUE7QUFBQSxVQUVGLElBQUksTUFBTSxNQUFNO0FBQUEsWUFDZCxJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxhQUFhLENBQUMsQ0FBQztBQUFBLFlBQy9EO0FBQUEsVUFDRjtBQUFBLFVBVUEsUUFBUSxNQUFNO0FBQUEsVUFLZCxjQUFjO0FBQUEsVUFDZCxPQUFPLFFBQVEsT0FBTyxNQUFNLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUFBLFVBRW5ELFNBQVMsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sRUFBRyxPQUFPLEdBQUcsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sR0FBRztBQUFBLFlBQ3ZFLE1BQU0sUUFBUSxJQUFJLE1BQU0sR0FBRyxHQUFHO0FBQUEsWUFDOUIsTUFBTSxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQUEsWUFDdkIsUUFBUSxPQUFPLGFBQWEsY0FBYyxLQUFLO0FBQUEsWUFDL0MsV0FBVyxRQUFRO0FBQUEsY0FBVSxLQUFLLEtBQUssWUFBWSxJQUFJLENBQUM7QUFBQSxZQUN4RCxJQUFJLENBQUM7QUFBQSxjQUFPO0FBQUEsWUFFWixJQUFJO0FBQUEsWUFDSixJQUFJO0FBQUEsY0FDRixLQUFLLEtBQUssTUFBTSxNQUFNLElBQUk7QUFBQSxjQUMxQixPQUFPLEdBQUc7QUFBQSxjQUNWLEtBQUssS0FBSyxjQUFjLE9BQU8sQ0FBQyxDQUFDO0FBQUEsY0FDakM7QUFBQTtBQUFBLFlBR0YsSUFBSSxLQUFLLFNBQVM7QUFBQSxjQUNoQixNQUFNLE9BQU8sS0FBSyxRQUFRLEVBQUU7QUFBQSxjQUM1QixJQUFJLE9BQU8sU0FBUyxVQUFVO0FBQUEsZ0JBQzVCLElBQUksVUFBVSxRQUFRLFNBQVMsT0FBTztBQUFBLGtCQUNwQyxTQUFTO0FBQUEsa0JBQ1QsTUFBTSxPQUFPLEtBQUssZ0JBQWdCLElBQUksS0FBSztBQUFBLGtCQUMzQyxJQUFJLFNBQVM7QUFBQSxvQkFBTSxLQUFLLElBQUk7QUFBQSxnQkFDOUI7QUFBQSxnQkFDQSxRQUFRO0FBQUEsY0FDVjtBQUFBLFlBQ0Y7QUFBQSxZQU1BLE1BQU0sSUFBSSxLQUFLLFdBQVcsRUFBRTtBQUFBLFlBQzVCLElBQUksT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLENBQUMsR0FBRztBQUFBLGNBQy9DLFNBQVMsaUJBQWlCLFdBQVcsSUFBSSxLQUFLLElBQUksUUFBUSxDQUFDO0FBQUEsWUFDN0Q7QUFBQSxZQUVBLE1BQU0sV0FBVyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUs7QUFBQSxZQUM3QyxNQUFNLGFBQWEsS0FBSyxXQUFXLEVBQUUsS0FBSztBQUFBLFlBRTFDLElBQUksWUFBYSxjQUFjLEtBQUssMEJBQTBCLE1BQU87QUFBQSxjQUNuRSxNQUFNLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxJQUFJLEtBQUssSUFBSSxNQUFNO0FBQUEsY0FDMUQsSUFBSSxTQUFTO0FBQUEsZ0JBQU0sS0FBSyxJQUFJO0FBQUEsWUFDOUI7QUFBQSxZQUNBLElBQUk7QUFBQSxjQUFZLE9BQU87QUFBQSxVQUN6QjtBQUFBLFFBQ0Y7QUFBQSxnQkFDQTtBQUFBLFFBQ0EsSUFBSSxhQUFhO0FBQUEsVUFBTSxhQUFhLFFBQVE7QUFBQSxRQUM1QyxVQUFVO0FBQUE7QUFBQSxNQUdaLElBQUk7QUFBQSxRQUFTO0FBQUEsTUFRYixNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxJQUN6QztBQUFBLElBQ0EsT0FBTztBQUFBLFlBQ1A7QUFBQSxJQUNBLElBQUksWUFBWTtBQUFBLE1BQ2QsUUFBUSxJQUFJLFVBQVUsUUFBUTtBQUFBLE1BQzlCLFFBQVEsSUFBSSxXQUFXLFFBQVE7QUFBQSxJQUNqQztBQUFBLElBQ0EsV0FBVyxNQUFNLFNBQVMsVUFBVTtBQUFBLElBQ3BDLEtBQUssUUFBUSxvQkFBb0IsU0FBUyxhQUFhO0FBQUE7QUFBQTs7O0FDM2hCcEQsSUFBTSx1QkFBdUI7QUFHN0IsSUFBTSx1QkFBdUI7QUFPN0IsSUFBTSxlQUFlO0FBd0JyQixJQUFNLG1CQUFtQjtBQU1oQyxTQUFTLEtBQUssQ0FBQyxLQUF5QixVQUEwQjtBQUFBLEVBQ2hFLE1BQU0sSUFBSSxPQUFPLFNBQVMsT0FBTyxJQUFJLEVBQUU7QUFBQSxFQUN2QyxPQUFPLE9BQU8sU0FBUyxDQUFDLEtBQUssSUFBSSxJQUFJLElBQUk7QUFBQTtBQUlwQyxTQUFTLGNBQWMsQ0FBQyxLQUEwQixXQUFXLHNCQUE4QjtBQUFBLEVBQ2hHLE9BQU8sS0FBSyxJQUFJLEdBQUcsS0FBSyxJQUFJLHNCQUFzQixNQUFNLEtBQUssUUFBUSxDQUFDLENBQUM7QUFBQTtBQWlCbEUsU0FBUyxXQUFXLENBQ3pCLEtBQ0EsU0FDQSxXQUFXLHNCQUNIO0FBQUEsRUFDUixNQUFNLFVBQVUsS0FBSyxJQUFJLGtCQUFrQixLQUFLLE1BQU8sVUFBVSxPQUFRLENBQUMsQ0FBQztBQUFBLEVBQzNFLE9BQU8sS0FBSyxJQUFJLEtBQUssSUFBSSxNQUFNLEtBQUssUUFBUSxHQUFHLGdCQUFnQixHQUFHLE9BQU87QUFBQTtBQUlwRSxTQUFTLFVBQVUsQ0FBQyxRQUF3QjtBQUFBLEVBQ2pELE9BQU8sU0FBUztBQUFBOzs7QUNuRVgsSUFBTSxtQkFBbUIsZUFDOUIsUUFBUSxJQUFJLHdCQUNaLG9CQUNGO0FBV08sSUFBTSxtQkFBbUIsWUFDOUIsUUFBUSxJQUFJLG9CQUNaLGtCQUNBLG9CQUNGO0FBVU8sSUFBTSxlQUFlLFdBQVcsZ0JBQWdCOzs7QUpoQnZELElBQU0sYUFBYSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFDekQsSUFBTSxhQUFhLEtBQUssWUFBWSxJQUFJO0FBQ3hDLElBQU0sV0FBVyxLQUFLLFlBQVksTUFBTTtBQVl4QyxJQUFNLGdCQUFnQixLQUFLLFlBQVksTUFBTSxXQUFXLFdBQVc7QUFlbkUsSUFBTSxjQUFjLEtBQUssWUFBWSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sT0FBTyxPQUFPO0FBRWpGLFNBQVMsU0FBUyxHQUFXO0FBQUEsRUFDM0IsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBVyxPQUFPO0FBQUEsRUFDN0QsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBTyxPQUFPO0FBQUEsRUFDekQsT0FBTyxXQUFXLEtBQUssVUFBVSxZQUFZLENBQUMsSUFBSSxhQUFhO0FBQUE7QUFFakUsSUFBTSxnQkFBZ0IsS0FBSyxRQUFRLElBQUksY0FBYyxLQUFLLFFBQVEsR0FBRyxRQUFRLEdBQUcsV0FBVztBQUUzRixJQUFNLGNBQXNDO0FBQUEsRUFDMUMsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsU0FBUztBQUFBLEVBQ1QsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUNWO0FBZ0NBLElBQU0sa0JBQWtCLEVBQUUsTUFBTSw0Q0FBNEM7QUFLNUUsU0FBUyxhQUFhLENBQUMsTUFBYyxRQUFnQixNQUFzQjtBQUFBLEVBQ3pFLE1BQU0sT0FDSixXQUFXLE1BQ1AsVUFDQSxXQUFXLE1BQ1QsY0FDQSxXQUFXLE1BQ1QsYUFDQTtBQUFBLEVBQ1YsSUFBSSxHQUFHLHFCQUFxQixXQUFXLE1BQU07QUFBQSxPQUN2QyxTQUFTLFFBQVEsU0FBUyxZQUFZLEVBQUUsUUFBUSxLQUFLLElBQUksQ0FBQztBQUFBLEVBQ2hFLENBQUM7QUFBQTtBQUdILFNBQVMsS0FBSyxDQUFDLElBQTJCO0FBQUEsRUFDeEMsT0FBTyxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUM7QUFBQTtBQUc3QyxTQUFTLFNBQVMsQ0FBQyxNQUFlO0FBQUEsRUFDaEMsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTtBQUdsRCxTQUFTLGVBQWUsQ0FBQyxTQUEwQjtBQUFBLEVBQ2pELE9BQU8sVUFBVSxLQUFLLE9BQU8sR0FBRyxTQUFTLGNBQWMsSUFBSSxLQUFLLE9BQU8sR0FBRyxtQkFBbUI7QUFBQTtBQXNCL0YsU0FBUyxXQUFXLENBQUMsU0FBa0M7QUFBQSxFQUNyRCxNQUFNLE9BQU8sZ0JBQWdCLE9BQU87QUFBQSxFQUNwQyxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixNQUFNLGFBQWEsTUFBTSxNQUFNO0FBQUEsSUFDL0IsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQVEsRUFBNEI7QUFBQSxJQUMxQyxJQUFJLFNBQVM7QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5QixJQUFJLG9DQUFvQyxRQUFRLHFCQUFxQixRQUFRLFVBQVU7QUFBQTtBQUFBLEVBRXpGLElBQUk7QUFBQSxJQUNGLE9BQU8sS0FBSyxNQUFNLEdBQUc7QUFBQSxJQUNyQixNQUFNO0FBQUEsSUFDTixJQUFJLDBDQUEwQyxRQUFRLFVBQVU7QUFBQTtBQUFBO0FBSXBFLFNBQVMsY0FBYyxDQUFDLFNBQTJCO0FBQUEsRUFDakQsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLEVBQzdCLElBQUksQ0FBQztBQUFBLElBQUcsSUFBSSw0QkFBNEIsYUFBYSxlQUFlO0FBQUEsRUFDcEUsT0FBTztBQUFBO0FBR1QsZUFBZSxHQUFHLENBQ2hCLE1BQ0EsUUFDQSxNQUNBLE1BQzRDO0FBQUEsRUFDNUMsTUFBTSxNQUFNLE1BQU0sTUFBTSxvQkFBb0IsT0FBTyxRQUFRO0FBQUEsSUFDekQ7QUFBQSxJQUNBLFNBQVMsU0FBUyxZQUFZLEVBQUUsZ0JBQWdCLG1CQUFtQixJQUFJO0FBQUEsSUFDdkUsTUFBTSxTQUFTLFlBQVksS0FBSyxVQUFVLElBQUksSUFBSTtBQUFBLEVBQ3BELENBQUM7QUFBQSxFQUNELElBQUksT0FBZ0I7QUFBQSxFQUNwQixJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sSUFBSSxLQUFLO0FBQUEsSUFDdEIsTUFBTTtBQUFBLEVBQ1IsT0FBTyxFQUFFLFFBQVEsSUFBSSxRQUFRLEtBQUs7QUFBQTtBQW1CcEMsSUFBTSxjQUFjO0FBQUEsRUFDbEIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLGVBQWUsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUNoQyxPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsR0FBRyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3BCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixPQUFPLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDekIsTUFBTSxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3hCLFdBQVcsRUFBRSxNQUFNLFVBQVU7QUFDL0I7QUFVTyxJQUFNLG1CQUFzQyxPQUFPLEtBQUssV0FBVyxFQUN2RSxJQUFJLENBQUMsTUFBTSxLQUFLLEdBQUcsRUFDbkIsS0FBSztBQUdELElBQU0sUUFBMkI7QUFBQSxFQUN0QztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUFHTyxJQUFNLGVBQWtDLENBQUMsVUFBVSxJQUFJO0FBR3ZELElBQU0sZUFBa0MsQ0FBQyxHQUFHLE9BQU8sR0FBRyxZQUFZO0FBUWxFLElBQU0sc0JBQXNCLENBQUMsVUFBVSxTQUFTLFNBQVMsU0FBUztBQUNsRSxJQUFNLHNCQUFzQixDQUFDLFVBQVUsY0FBYztBQUFBO0FBRTVELE1BQU0sbUJBQW1CLE1BQU07QUFBQSxFQUlwQjtBQUFBLEVBQ1QsV0FBVyxDQUFDLFNBQWlCLE9BQWtCO0FBQUEsSUFDN0MsTUFBTSxPQUFPO0FBQUEsSUFDYixLQUFLLFFBQVE7QUFBQTtBQUVqQjtBQUVPLFNBQVMsU0FBUyxDQUFDLE1BR3hCO0FBQUEsRUFDQSxJQUFJO0FBQUEsSUFDRixRQUFRLFFBQVEsZ0JBQWdCLGNBQWM7QUFBQSxNQUM1QztBQUFBLE1BQ0EsU0FBUztBQUFBLE1BQ1QsUUFBUTtBQUFBLE1BQ1Isa0JBQWtCO0FBQUEsSUFDcEIsQ0FBQztBQUFBLElBQ0QsT0FBTyxFQUFFLEtBQUssYUFBYSxPQUFPLE9BQTJDO0FBQUEsSUFDN0UsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLFNBQVMsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxJQU14RCxNQUFNLE9BQ0osS0FBSyxPQUFPLE1BQU0sWUFBWSxVQUFVLElBQUksT0FBUSxFQUF3QixJQUFJLElBQUk7QUFBQSxJQUN0RixNQUFNLElBQUksV0FDUixHQUFHO0FBQUEsSUFBYSw2RUFDaEIsU0FBUyxrQ0FBa0MsRUFBRSxTQUFTLENBQUMsR0FBRyxnQkFBZ0IsRUFBRSxJQUFJLFNBQ2xGO0FBQUE7QUFBQTtBQUlKLGVBQWUsT0FBTyxDQUFDLFNBQTZCLEtBQThCO0FBQUEsRUFDaEYsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRLEdBQUc7QUFBQSxFQUM5RCxJQUFJLFdBQVc7QUFBQSxJQUFLLGNBQWMsT0FBTyxRQUFRLElBQUk7QUFBQSxFQUNyRCxVQUFVLEVBQUUsSUFBSSxNQUFNLE1BQU0sSUFBSSxLQUFLLENBQUM7QUFBQTtBQUt4QyxlQUFlLE9BQU8sQ0FBQyxPQUF5QztBQUFBLEVBQzlELE1BQU0sT0FBTyxDQUFDLE9BQU8sYUFBYTtBQUFBLEVBQ2xDLElBQUksTUFBTTtBQUFBLElBQU8sS0FBSyxLQUFLLFdBQVcsT0FBTyxNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ3pELElBQUksTUFBTTtBQUFBLElBQVMsS0FBSyxLQUFLLGFBQWEsT0FBTyxNQUFNLE9BQU8sQ0FBQztBQUFBLEVBQy9ELElBQUksTUFBTTtBQUFBLElBQVMsS0FBSyxLQUFLLGFBQWEsT0FBTyxNQUFNLE9BQU8sQ0FBQztBQUFBLEVBQy9ELElBQUksTUFBTTtBQUFBLElBQVksS0FBSyxLQUFLLFdBQVc7QUFBQSxFQUUzQyxNQUFNLFNBQVMsWUFBWSxHQUFHO0FBQUEsRUFNOUIsTUFBTSxPQUFPLE1BQU0sUUFBUSxVQUFVLE1BQU07QUFBQSxJQUN6QyxVQUFVO0FBQUEsSUFDVixPQUFPLENBQUMsVUFBVSxVQUFVLFFBQVE7QUFBQSxJQUNwQyxLQUFLLFFBQVE7QUFBQSxJQUliLEtBQUssVUFBVTtBQUFBLEVBQ2pCLENBQUM7QUFBQSxFQUNELEtBQUssTUFBTTtBQUFBLEVBRVgsTUFBTSxXQUFXLEtBQUssSUFBSSxJQUFJO0FBQUEsRUFDOUIsT0FBTyxLQUFLLElBQUksSUFBSSxVQUFVO0FBQUEsSUFDNUIsTUFBTSxNQUFNLEVBQUU7QUFBQSxJQUNkLE1BQU0sSUFBSSxZQUFZO0FBQUEsSUFDdEIsSUFBSSxLQUFLLEVBQUUsZUFBZSxRQUFRO0FBQUEsTUFDaEMsSUFBSTtBQUFBLFFBQ0YsTUFBTSxJQUFJLE1BQU0sTUFBTSxvQkFBb0IsRUFBRSxZQUFZO0FBQUEsUUFDeEQsSUFBSSxFQUFFLElBQUk7QUFBQSxVQUNSLFVBQVUsQ0FBQztBQUFBLFVBQ1g7QUFBQSxRQUNGO0FBQUEsUUFDQSxNQUFNO0FBQUEsSUFHVjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLElBQUksMENBQTBDLFlBQVk7QUFBQSxJQUN4RCxNQUFNO0FBQUEsRUFDUixDQUFDO0FBQUE7QUFHSCxlQUFlLFFBQVEsQ0FBQyxTQUFrQixPQUFPLE9BQU87QUFBQSxFQUN0RCxNQUFNLElBQUksZUFBZSxPQUFPO0FBQUEsRUFDaEMsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFJLEVBQUUsTUFBTSxPQUFPLFNBQVMsT0FBTyxLQUFLLFdBQVc7QUFBQSxFQUNsRixJQUFJLFdBQVc7QUFBQSxJQUFLLGNBQWMsU0FBUyxRQUFRLElBQUk7QUFBQSxFQUN2RCxVQUFVLElBQUk7QUFBQTtBQXFDaEIsZUFBZSxPQUFPLENBQUMsU0FBNkIsVUFBbUM7QUFBQSxFQUNyRixJQUFJLFVBQVU7QUFBQSxFQUNkLElBQUksV0FBVztBQUFBLEVBRWYsT0FBTyxNQUFNLFdBQTJDO0FBQUEsSUFDdEQsU0FBUyxNQUFNO0FBQUEsTUFPYixNQUFNLElBQUksWUFBWSxPQUFPO0FBQUEsTUFDN0IsSUFBSSxDQUFDO0FBQUEsUUFBRyxPQUFPO0FBQUEsTUFDZixJQUFJLENBQUM7QUFBQSxRQUFTLFVBQVUsRUFBRTtBQUFBLE1BQzFCLElBQUksQ0FBQyxVQUFVO0FBQUEsUUFDYixXQUFXO0FBQUEsUUFDWCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLE1BQU0sYUFBYSxZQUFZLEVBQUUsWUFBWSxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQUEsQ0FDakY7QUFBQSxNQUNGO0FBQUEsTUFDQSxPQUFPLG9CQUFvQixFQUFFO0FBQUE7QUFBQSxJQUUvQixjQUFjLEdBQUcsbUJBQW1CO0FBQUEsTUFDbEMsSUFBSTtBQUFBLFFBQWMsT0FBTztBQUFBLE1BQ3pCLFFBQVEsT0FBTyxNQUFNO0FBQUEsQ0FBK0I7QUFBQSxNQUNwRCxPQUFPO0FBQUE7QUFBQSxJQUVULE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLFVBQVUsQ0FBQyxPQUFPLEdBQUc7QUFBQSxJQUNyQixVQUFVLENBQUMsT0FBTyxHQUFHLFNBQVM7QUFBQSxJQUM5QixRQUFRO0FBQUEsSUFDUixXQUFXLE1BQU07QUFBQSxFQUNuQixDQUFDO0FBQUE7QUFHSCxTQUFTLGFBQWEsQ0FBQyxNQUFzQjtBQUFBLEVBQzNDLE1BQU0sTUFBTSxhQUFhLElBQUk7QUFBQSxFQUM3QixNQUFNLE1BQU0sS0FBSyxZQUFZLEdBQUc7QUFBQSxFQUNoQyxNQUFNLE1BQU0sT0FBTyxJQUFJLEtBQUssTUFBTSxHQUFHLEVBQUUsWUFBWSxJQUFJO0FBQUEsRUFDdkQsTUFBTSxPQUFPLFlBQVksUUFBUTtBQUFBLEVBQ2pDLE9BQU8sUUFBUSxlQUFlLElBQUksU0FBUyxRQUFRO0FBQUE7QUFLckQsZUFBZSxZQUFZLENBQUMsS0FBOEI7QUFBQSxFQUN4RCxNQUFNLE1BQU0sTUFBTSxNQUFNLEdBQUc7QUFBQSxFQUMzQixJQUFJLENBQUMsSUFBSTtBQUFBLElBQUksSUFBSSxzQkFBc0IsSUFBSSxZQUFZLE9BQU8sT0FBTztBQUFBLEVBQ3JFLE1BQU0sTUFBTSxPQUFPLEtBQUssTUFBTSxJQUFJLFlBQVksQ0FBQztBQUFBLEVBQy9DLE1BQU0sUUFBUSxJQUFJLFFBQVEsSUFBSSxjQUFjLEtBQUssY0FBYyxNQUFNLEdBQUcsRUFBRTtBQUFBLEVBQzFFLE9BQU8sUUFBUSxlQUFlLElBQUksU0FBUyxRQUFRO0FBQUE7QUFLckQsZUFBZSxVQUFVLENBQUMsS0FBOEI7QUFBQSxFQUN0RCxJQUFJLGVBQWUsS0FBSyxHQUFHO0FBQUEsSUFBRyxPQUFPLGFBQWEsR0FBRztBQUFBLEVBQ3JELElBQUksSUFBSSxXQUFXLE9BQU87QUFBQSxJQUFHLE9BQU87QUFBQSxFQUNwQyxPQUFPLGNBQWMsR0FBRztBQUFBO0FBRzFCLFNBQVMsT0FBTyxDQUFDLFNBQWtCO0FBQUEsRUFDakMsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLEVBQzdCLElBQUksQ0FBQztBQUFBLElBQUcsSUFBSSw0QkFBNEIsYUFBYSxlQUFlO0FBQUEsRUFDcEUsVUFBVSxDQUFDO0FBQUE7QUFHYixTQUFTLFdBQVcsR0FBRztBQUFBLEVBQ3JCLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFFBQVEsWUFBWSxhQUFhLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLE9BQU8sQ0FBQztBQUFBLElBQ3BFLE1BQU07QUFBQSxJQUNOLFFBQVEsT0FBTyxNQUFNO0FBQUEsQ0FBcUI7QUFBQSxJQUMxQztBQUFBO0FBQUEsRUFHRixNQUFNLE9BQWMsQ0FBQztBQUFBLEVBQ3JCLFdBQVcsS0FBSyxPQUFPO0FBQUEsSUFDckIsTUFBTSxPQUFPLEtBQUssZUFBZSxDQUFDO0FBQUEsSUFDbEMsSUFBSTtBQUFBLE1BQ0YsTUFBTSxLQUFLLEtBQUssTUFBTSxhQUFhLE1BQU0sTUFBTSxDQUFDO0FBQUEsTUFDaEQsTUFBTSxVQUFXLEdBQUcsV0FBVyxDQUFDO0FBQUEsTUFDaEMsS0FBSyxLQUFLO0FBQUEsUUFDUixJQUFJLEVBQUUsUUFBUSxXQUFXLEVBQUU7QUFBQSxRQUMzQixPQUFPLEdBQUc7QUFBQSxRQUNWLFNBQVMsUUFBUTtBQUFBLFFBQ2pCLE1BQU0sUUFBUSxPQUFPLENBQUMsR0FBRyxNQUFNLEtBQUssRUFBRSxVQUFVLFVBQVUsSUFBSSxDQUFDO0FBQUEsUUFDL0QsT0FBTyxTQUFTLElBQUksRUFBRTtBQUFBLE1BQ3hCLENBQUM7QUFBQSxNQUNELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxLQUFLLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxRQUFRLEVBQUUsS0FBSztBQUFBLEVBQ3JDLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDcEIsUUFBUSxPQUFPLE1BQU0sR0FBRyxFQUFFLE9BQU8sRUFBRSx3QkFBcUIsRUFBRSw0QkFBdUIsRUFBRTtBQUFBLENBQVM7QUFBQSxFQUM5RjtBQUFBLEVBQ0EsSUFBSSxDQUFDLEtBQUs7QUFBQSxJQUFRLFFBQVEsT0FBTyxNQUFNO0FBQUEsQ0FBcUI7QUFBQTtBQUc5RCxJQUFNLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUF1QmIsZUFBZSxRQUFRLENBQUMsTUFBaUM7QUFBQSxFQUN2RCxPQUFPLFNBQVMsUUFBUTtBQUFBLEVBR3hCLGtCQUFrQixPQUFPLFNBQVMsV0FBVyxPQUFPLElBQUk7QUFBQSxFQUV4RCxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsS0FDRCxFQUFFLEtBQUssTUFBTSxJQUFJLFVBQVUsSUFBSTtBQUFBLElBQ2hDLE9BQU8sR0FBRztBQUFBLElBQ1YsSUFBSSxFQUFFLGFBQWE7QUFBQSxNQUFhLE1BQU07QUFBQSxJQUl0QyxJQUFJLEVBQUUsU0FBUyxTQUFTLEVBQUUsS0FBSztBQUFBO0FBQUEsRUFFakMsTUFBTSxVQUFVLE9BQU8sTUFBTSxZQUFZLFdBQVcsTUFBTSxVQUFVO0FBQUEsRUFFcEUsUUFBUTtBQUFBLFNBQ0Q7QUFBQSxNQUNILE1BQU0sUUFBUSxLQUFLO0FBQUEsTUFDbkI7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFFBQVEsU0FBUyxPQUFPLE1BQU0sVUFBVSxXQUFXLFNBQVMsTUFBTSxPQUFPLEVBQUUsSUFBSSxFQUFFO0FBQUEsTUFDdkY7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFNBQVMsU0FBUyxNQUFNLFNBQVMsSUFBSTtBQUFBLE1BQzNDO0FBQUEsU0FDRztBQUFBLE1BQ0gsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUFRLElBQUksc0JBQXNCO0FBQUEsTUFDM0MsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLE9BQU8sTUFBTSxJQUFJLEtBQUssR0FBRyxFQUFFLENBQUM7QUFBQSxNQUMzRDtBQUFBLFNBQ0csV0FBVztBQUFBLE1BQ2QsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUFRLElBQUksb0NBQW9DO0FBQUEsTUFDekQsTUFBTSxNQUErQixFQUFFLE1BQU0sV0FBVyxRQUFRLElBQUksS0FBSyxHQUFHLEVBQUU7QUFBQSxNQUM5RSxJQUFJLE9BQU8sTUFBTSxNQUFNO0FBQUEsUUFBVSxJQUFJLElBQUksU0FBUyxNQUFNLEdBQUcsRUFBRTtBQUFBLE1BQzdELE1BQU0sUUFBUSxTQUFTLEdBQUc7QUFBQSxNQUMxQjtBQUFBLElBQ0Y7QUFBQSxTQUNLLE9BQU87QUFBQSxNQUNWLElBQUksQ0FBQyxJQUFJO0FBQUEsUUFBUSxJQUFJLDBDQUEwQztBQUFBLE1BQy9ELE1BQU0sTUFBK0IsRUFBRSxNQUFNLE9BQU8sTUFBTSxJQUFJLEtBQUssR0FBRyxFQUFFO0FBQUEsTUFDeEUsSUFBSSxPQUFPLE1BQU0sWUFBWSxVQUFVO0FBQUEsUUFDckMsSUFBSSxVQUFVLE1BQU0sUUFDakIsTUFBTSxHQUFHLEVBQ1QsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFDbkIsT0FBTyxPQUFPO0FBQUEsTUFDbkI7QUFBQSxNQUNBLE1BQU0sUUFBUSxTQUFTLEdBQUc7QUFBQSxNQUMxQjtBQUFBLElBQ0Y7QUFBQSxTQUNLLFNBQVM7QUFBQSxNQUNaLElBQUksQ0FBQyxJQUFJLFFBQVE7QUFBQSxRQUNmLElBQ0U7QUFBQSxJQUNFLDRGQUNKO0FBQUEsTUFDRjtBQUFBLE1BRUEsTUFBTSxTQUNKLE9BQU8sTUFBTSxXQUFXLFdBQVcsTUFBTSxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQztBQUFBLE1BQ3JGLE1BQU0sV0FBMkMsQ0FBQztBQUFBLE1BQ2xELFNBQVMsSUFBSSxFQUFHLElBQUksSUFBSSxRQUFRLEtBQUs7QUFBQSxRQUNuQyxNQUFNLElBQTZCLEVBQUUsS0FBSyxNQUFNLFdBQVcsSUFBSSxFQUFFLEVBQUU7QUFBQSxRQUNuRSxJQUFJLE9BQU87QUFBQSxVQUFJLEVBQUUsUUFBUSxPQUFPO0FBQUEsUUFDaEMsU0FBUyxLQUFLLENBQUM7QUFBQSxNQUNqQjtBQUFBLE1BQ0EsTUFBTSxNQUErQjtBQUFBLFFBQ25DLE1BQU07QUFBQSxRQUNOLE1BQU0sTUFBTSxTQUFTLFNBQVMsU0FBUztBQUFBLFFBQ3ZDLFFBQVEsT0FBTyxNQUFNLFdBQVcsV0FBVyxNQUFNLFNBQVM7QUFBQSxRQUMxRDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLElBQUksT0FBTyxNQUFNLFFBQVE7QUFBQSxRQUFVLElBQUksTUFBTSxNQUFNO0FBQUEsTUFDbkQsSUFBSSxPQUFPLE1BQU0sbUJBQW1CO0FBQUEsUUFBVSxJQUFJLHNCQUFzQixNQUFNO0FBQUEsTUFDOUUsSUFBSSxPQUFPLE1BQU0sWUFBWTtBQUFBLFFBQVUsSUFBSSxVQUFVLE1BQU07QUFBQSxNQUMzRCxNQUFNLFFBQVEsU0FBUyxHQUFHO0FBQUEsTUFDMUI7QUFBQSxJQUNGO0FBQUEsU0FDSztBQUFBLE1BQ0gsSUFBSSxJQUFJLFNBQVM7QUFBQSxRQUFHLElBQUksb0NBQW9DO0FBQUEsTUFDNUQsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLFNBQVMsU0FBUyxJQUFJLElBQUksV0FBVyxJQUFJLEdBQUcsQ0FBQztBQUFBLE1BQzVFO0FBQUEsU0FDRztBQUFBLE1BQ0gsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUFRLElBQUksaUNBQWlDO0FBQUEsTUFDdEQsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGNBQWMsSUFBSSxJQUFJLElBQUksVUFBVSxJQUFJLE9BQU8sTUFBTSxDQUFDO0FBQUEsTUFDckY7QUFBQSxTQUNHLFdBQVc7QUFBQSxNQUNkLElBQUksSUFBSSxTQUFTO0FBQUEsUUFBRyxJQUFJLHFDQUFxQztBQUFBLE1BQzdELE9BQU8sUUFBUSxTQUFTO0FBQUEsTUFHeEIsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLG1CQUFtQixJQUFJLEtBQUssTUFBTSxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUM7QUFBQSxNQUNsRjtBQUFBLElBQ0Y7QUFBQSxTQUNLLFdBQVc7QUFBQSxNQUVkLE9BQU8sWUFBWSxhQUFhO0FBQUEsTUFDaEMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxvQkFBb0IsU0FBUyxPQUFzQixHQUFHO0FBQUEsUUFLckUsSUFDRSx5SEFDQSxTQUNBLEVBQUUsTUFBTSxnQ0FBZ0MsU0FBUyxDQUFDLEdBQUcsbUJBQW1CLEVBQUUsQ0FDNUU7QUFBQSxNQUNGO0FBQUEsTUFDQSxJQUFJLENBQUMsVUFBVTtBQUFBLFFBQ2IsSUFBSSx3RUFBbUU7QUFBQSxNQUN6RSxJQUNFLE9BQU8sTUFBTSxTQUFTLFlBQ3RCLENBQUMsb0JBQW9CLFNBQVMsTUFBTSxJQUE0QyxHQUNoRjtBQUFBLFFBSUEsSUFBSSxtQkFBbUIsTUFBTSxTQUFTLFNBQVMsRUFBRSxTQUFTLENBQUMsR0FBRyxtQkFBbUIsRUFBRSxDQUFDO0FBQUEsTUFDdEY7QUFBQSxNQUNBLE1BQU0sU0FBa0M7QUFBQSxRQUN0QyxNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixNQUFNLFVBQVUsS0FBSyxHQUFHO0FBQUEsUUFDeEIsU0FBUyxPQUFPLE1BQU0sWUFBWSxXQUFXLE1BQU0sVUFBVTtBQUFBLE1BQy9EO0FBQUEsTUFHQSxJQUFJLE9BQU8sTUFBTSxVQUFVO0FBQUEsUUFBVSxPQUFPLFFBQVEsTUFBTSxXQUFXLE1BQU0sS0FBSztBQUFBLE1BQ2hGLElBQUksT0FBTyxNQUFNLFNBQVMsVUFBVTtBQUFBLFFBQ2xDLE9BQU8sT0FBTyxNQUFNLEtBQ2pCLE1BQU0sR0FBRyxFQUNULElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLEVBQ25CLE9BQU8sT0FBTztBQUFBLE1BQ25CO0FBQUEsTUFDQSxJQUFJLE9BQU8sTUFBTSxTQUFTO0FBQUEsUUFBVSxPQUFPLE9BQU8sTUFBTTtBQUFBLE1BQ3hELE1BQU0sUUFBUSxTQUFTLE1BQU07QUFBQSxNQUM3QjtBQUFBLElBQ0Y7QUFBQSxTQUNLLFVBQVU7QUFBQSxNQUNiLE1BQU0sS0FBSyxJQUFJLE9BQU87QUFBQSxNQUN0QixNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sVUFBVSxNQUFNLElBQUksTUFBTSxJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxFQUFFLENBQUM7QUFBQSxNQUNqRjtBQUFBLElBQ0Y7QUFBQSxTQUNLO0FBQUEsTUFDSCxJQUFJLENBQUMsSUFBSTtBQUFBLFFBQVEsSUFBSSx1QkFBdUI7QUFBQSxNQUM1QyxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sUUFBUSxNQUFNLElBQUksS0FBSyxHQUFHLEVBQUUsQ0FBQztBQUFBLE1BQzVEO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixNQUFNLE1BQU0sVUFBVSxPQUFPLEtBQUssSUFBSSxLQUFLLEdBQUc7QUFBQSxNQUNoRCxDQUFDO0FBQUEsTUFDRDtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxRQUFRLENBQUM7QUFBQSxNQUN4QztBQUFBLFNBQ0c7QUFBQSxNQUNILFFBQVEsT0FBTztBQUFBLE1BQ2Y7QUFBQSxTQUNHO0FBQUEsTUFDSCxZQUFZO0FBQUEsTUFDWjtBQUFBLFNBQ0c7QUFBQSxTQUNBO0FBQUEsU0FDQTtBQUFBLFNBQ0E7QUFBQSxNQUNILFFBQVEsT0FBTyxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUEsTUFDaEM7QUFBQTtBQUFBLE1BRUEsSUFBSSxpQkFBaUIsU0FBUyxTQUFTO0FBQUEsUUFDckMsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDLEdBQUcsWUFBWTtBQUFBLE1BQzNCLENBQUM7QUFBQTtBQUFBLEVBRUwsT0FBTztBQUFBO0FBbUJULGVBQWUsSUFBSSxDQUFDLE1BQWlDO0FBQUEsRUFDbkQsSUFBSTtBQUFBLElBQ0YsT0FBTyxNQUFNLFNBQVMsSUFBSTtBQUFBLElBQzFCLE9BQU8sR0FBRztBQUFBLElBQ1YsTUFBTSxXQUFXLGVBQWUsQ0FBQztBQUFBLElBQ2pDLElBQUksYUFBYTtBQUFBLE1BQU0sT0FBTztBQUFBLElBQzlCLE1BQU0sT0FDSixLQUFLLE9BQU8sTUFBTSxZQUFZLFVBQVUsSUFBSSxPQUFRLEVBQXdCLElBQUksSUFBSTtBQUFBLElBQ3RGLE1BQU0sTUFBTSxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLElBR3JELElBQUksU0FBUztBQUFBLE1BQVUsT0FBTyxlQUFlLElBQUksU0FBUyxTQUFTLEdBQUcsQ0FBQyxLQUFLO0FBQUEsSUFDNUUsT0FBTyxlQUFlLElBQUksU0FBUyxZQUFZLEdBQUcsQ0FBQyxLQUFLO0FBQUE7QUFBQTtBQTRCNUQsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiMjJDMzhGMTRFNjI4OEUxMjY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
