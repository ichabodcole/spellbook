#!/usr/bin/env bun
// @bun

// src/mind-mapper/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseArgs } from "util";

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
function getCurrentCommand() {
  return currentCommand;
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

// src/mind-mapper/backend/heartbeat.ts
function intOr2(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.MIND_MAPPER_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var DEFAULT_SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.MIND_MAPPER_KEEPALIVE_MS, IDLE_TIMEOUT_SEC, DEFAULT_SSE_HEARTBEAT_MS);
var TAIL_IDLE_MS = intOr2(process.env.MIND_MAPPER_TAIL_IDLE_MS, tailIdleMs(SSE_HEARTBEAT_MS));
var TAIL_RETRY_MS = intOr2(process.env.MIND_MAPPER_TAIL_RETRY_MS, 1000);
var TAIL_RETRY_MAX_MS = 5000;

// src/mind-mapper/backend/cli.ts
var SCRIPT_DIR = import.meta.dir;
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
var PORT_FILE = join(HOME, "daemon.port");
var PID_FILE = join(HOME, "daemon.pid");
function livePort() {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE))
    return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  const port = Number.parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || !Number.isFinite(port))
    return null;
  try {
    process.kill(pid, 0);
    return port;
  } catch {
    return null;
  }
}
async function ensureDaemon(port) {
  const running = livePort();
  if (running !== null)
    return running;
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open", ...port ? ["--port", String(port)] : []], {
    detached: true,
    stdio: "ignore",
    cwd: daemonCwd()
  });
  proc.unref();
  for (let i = 0;i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const port2 = livePort();
    if (port2 !== null)
      return port2;
  }
  throw new CliError2("internal", "daemon did not come up within 10s");
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

class CliError2 extends CliError {
  constructor(kind, message, extra) {
    super(kind, message, extra);
  }
}
var usageError = (message, extra) => new CliError2("usage", message, extra);
function reportUsage(message) {
  process.stderr.write(errorEnvelope("usage", message));
  return EXIT_FOR.usage;
}
async function passOrThrow(res) {
  const text = await res.text();
  if (res.ok)
    return text;
  let server = text;
  try {
    server = JSON.parse(text);
  } catch {}
  const kind = res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 400 ? "usage" : "internal";
  throw new CliError2(kind, `${getCurrentCommand() ?? "request"} refused (HTTP ${res.status})`, {
    server
  });
}
function requireDaemon() {
  const port = livePort();
  if (port === null) {
    throw new CliError2("not_found", "no daemon running (use `open` first)");
  }
  return port;
}
function toSkeleton(state) {
  const degree = new Map;
  for (const e of state.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: state.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      tier: n.tier,
      degree: degree.get(n.id) ?? 0
    }))
  };
}
var CLI_OPTIONS = {
  add: { type: "string" },
  anchor: { type: "string" },
  author: { type: "string" },
  batch: { type: "string" },
  "body-file": { type: "string" },
  check: { type: "string" },
  clear: { type: "boolean" },
  create: { type: "string" },
  deliverable: { type: "string" },
  depth: { type: "string" },
  detail: { type: "string" },
  doc: { type: "string" },
  "doc-edit": { type: "string" },
  file: { type: "string" },
  force: { type: "boolean" },
  ground: { type: "string", multiple: true },
  inbound: { type: "boolean" },
  kind: { type: "string" },
  message: { type: "string" },
  "no-open": { type: "boolean" },
  node: { type: "string" },
  note: { type: "string" },
  owner: { type: "string" },
  port: { type: "string" },
  project: { type: "string" },
  role: { type: "string" },
  ruling: { type: "string" },
  set: { type: "string" },
  since: { type: "string" },
  skeleton: { type: "boolean" },
  span: { type: "string" },
  status: { type: "string" },
  stdin: { type: "boolean" },
  synopsis: { type: "string" },
  title: { type: "string" },
  to: { type: "string" },
  uncheck: { type: "string" },
  yes: { type: "boolean" },
  zone: { type: "string" }
};
var VERB_SPEC = {
  open: ["no-open", "port", "project"],
  state: ["skeleton", "batch", "project"],
  changes: ["since", "project"],
  tail: ["since", "inbound", "project"],
  projects: ["create"],
  ingest: ["title", "file", "stdin", "project"],
  "propose-node": ["stdin", "zone", "project"],
  "propose-edge": ["stdin", "zone", "project"],
  "propose-batch": ["stdin", "project"],
  "ratify-batch": ["stdin", "project"],
  "delete-batch": ["stdin", "project"],
  "node anchor": ["to", "clear", "project"],
  "node edit": ["title", "synopsis", "stdin", "project"],
  "node delete": ["force", "project"],
  read: ["project"],
  "zone create": ["project"],
  "zone list": ["project"],
  "zone delete": ["yes", "project"],
  promote: ["project"],
  "proposal zone": ["to", "clear", "project"],
  "proposal delete": ["project"],
  doc: ["project"],
  "doc delete": ["force", "project"],
  "doc kind": ["author", "clear", "project"],
  mark: ["status", "note", "author", "project"],
  search: ["project"],
  neighbors: ["depth", "project"],
  ratify: ["ruling", "doc-edit", "doc", "span", "anchor", "project"],
  "lens set": ["node", "doc", "depth", "owner", "project"],
  "lens clear": ["project"],
  "look-here": ["project"],
  actions: ["set", "stdin", "clear", "project"],
  tags: ["set", "stdin", "clear", "project"],
  "job create": ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
  "job update": ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
  "job claim": ["owner", "project"],
  "job release": ["project"],
  "job subtask": ["add", "check", "uncheck", "project"],
  "job list": ["project"],
  "job delete": ["project"],
  activity: ["message", "project"],
  send: ["role", "kind", "ground", "body-file", "stdin", "force", "project"],
  help: []
};
var VERB_ALIASES = { message: "read" };
var VERBS = [...new Set(Object.keys(VERB_SPEC).map((p) => p.split(" ")[0]))];
var NO_POSITIONALS = new Set([
  "open",
  "state",
  "changes",
  "tail",
  "ingest",
  "propose-node",
  "propose-edge",
  "propose-batch",
  "ratify-batch",
  "delete-batch",
  "lens set",
  "lens clear",
  "help"
]);
var flagsFor = (path) => VERB_SPEC[path].map((k) => `--${k}`).sort();
var subsOf = (verb) => Object.keys(VERB_SPEC).filter((p) => p.startsWith(`${verb} `)).map((p) => p.slice(verb.length + 1));
function parseVerbArgs(path, args) {
  setCurrentCommand(path);
  const parsed = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: true
  });
  const allowed = new Set(VERB_SPEC[path]);
  const stray = Object.keys(parsed.values).find((k) => !allowed.has(k));
  if (stray) {
    throw usageError(`--${stray} is not accepted by \`${path}\` (it is a recognized mind-mapper flag, just not this verb's)`, { choices: flagsFor(path) });
  }
  if (NO_POSITIONALS.has(path) && parsed.positionals.length > 0) {
    throw usageError(`${path} takes no positional arguments (got "${parsed.positionals[0]}")`, VERB_SPEC[path].length > 0 ? { choices: flagsFor(path) } : undefined);
  }
  return parsed;
}
var HELP = `mind-mapper \u2014 a co-present knowledge map: a dumb daemon holds the graph, the casting agent does the thinking.

  open   [--project <id>] [--port <n>] [--no-open]   spawn (or find) the daemon, print its url
  state  [--skeleton] [--batch <id>]                 the project snapshot (skeleton = ids/titles/degree)
  changes --since <epochSeconds>                     bounded delta, ADDITIONS ONLY (notCovered names the rest)
  tail   [--since N] [--inbound]                     SSE events as JSONL (wrap with Monitor)
  projects [--create <title>]                        list projects / create one
  ingest --title <t> (--file <p> | --stdin)          add a doc
  propose-node --stdin                               stage a node proposal (JSON {draft, evidence, ...})
  propose-edge --stdin [--zone <id>]                 stage an edge proposal
  propose-batch --stdin                              stage a set in one txn ({nodes, edges})
  ratify-batch --stdin                               ratify a set in one txn ({ruling, ids, anchors?})
  delete-batch --stdin                               delete a proposal set in one txn ({ids}, all-or-nothing)
  ratify <id> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <t>] [--anchor <parentId>]
  zone   create <name> | list | delete <id> [--yes]  staging pens for proposals
  promote <id>                                       move a zoned proposal to the main queue
  proposal zone <id> (--to <z> | --clear) | proposal delete <id>
  node   anchor <id> (--to <p> | --clear) | edit <id> [--title/--synopsis/--stdin] | delete <id> [--force]
  doc    <id> | delete <id> [--force] | kind <docId> (<kind> [--author a] | --clear)
  mark   <docId> --status <s> [--note <t>]           append a doc status mark
  actions <targetId> (--set <json> | --stdin | --clear)   action slots on a node/pending proposal
  tags   <targetId> (--set <json> | --stdin | --clear)    freeform tags, same targets
  job    create|update|claim|release|subtask|list|delete  persisted units of agent work
  search <query...>                                  FTS over nodes, docs, messages
  neighbors <id> [--depth 1]                         local hood + edge reasons
  lens   set (--node <id> [--depth n] | --doc <id>) | lens clear
  look-here <nodeId>                                 fire-once attention nudge
  read   <messageId>                                 one full message row (alias: message <id>)
  send   <text...> | --body-file <p> | --stdin       post a message ([--role] [--kind] [--ground])
  activity <received|thinking|idle> [--message <id>] the casting-loop liveness signal
  help | --version

  --project <id> is accepted by every verb except open's spawn-time flags; omit for the default project.

  Output: every verb prints JSON on stdout by default, one document per answer \u2014
  except tail, a stream that prints one JSON line per event. Prose, warnings and
  diagnostics go to stderr; failures exit non-zero (2 = usage).`;
function versionInfo() {
  try {
    const raw = readFileSync(join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "mind-mapper", version: pkg.version };
  } catch {}
  return { name: "mind-mapper", version: "unknown" };
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
    if (code.startsWith("ERR_PARSE_ARGS"))
      return reportUsage(msg);
    if (e instanceof SyntaxError)
      return reportUsage(`invalid JSON: ${msg}`);
    if (code === "ENOENT")
      return reportUsage(msg);
    process.stderr.write(errorEnvelope("internal", msg));
    return EXIT_FOR.internal;
  }
}
async function dispatch(argv) {
  const verb = argv[0];
  const rest = argv.slice(1);
  setCurrentCommand(verb ?? null);
  if (verb === "--help" || verb === "-h") {
    process.stdout.write(`${HELP}
`);
    return 0;
  }
  if (verb === "--version" || verb === "-V" || verb === "version") {
    process.stdout.write(`${JSON.stringify(versionInfo())}
`);
    return 0;
  }
  if (verb === "help") {
    parseVerbArgs("help", rest);
    process.stdout.write(`${HELP}
`);
    return 0;
  }
  if (verb === "open") {
    const parsed = parseVerbArgs("open", rest);
    const port = await ensureDaemon(parsed.values.port);
    const project = parsed.values.project;
    if (project !== undefined) {
      const res = await fetch(`http://127.0.0.1:${port}/projects`);
      const body = await res.json();
      if (!body.projects.some((p) => p.id === project)) {
        throw usageError(`unknown project: ${project} (open never creates one \u2014 use \`projects --create <title>\` first)`, { choices: body.projects.map((p) => p.id) });
      }
    }
    const url = `http://127.0.0.1:${port}${project ? `/?project=${encodeURIComponent(project)}` : ""}`;
    if (!parsed.values["no-open"])
      openBrowser(url);
    process.stdout.write(`${JSON.stringify({ ok: true, url })}
`);
    return 0;
  }
  if (verb === "state") {
    const parsed = parseVerbArgs("state", rest);
    const port = requireDaemon();
    const params = new URLSearchParams;
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    if (parsed.values.batch)
      params.set("batch", parsed.values.batch);
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/state${qs}`);
    const stateText = await passOrThrow(res);
    if (parsed.values.skeleton) {
      const state = JSON.parse(stateText);
      process.stdout.write(`${JSON.stringify(toSkeleton(state))}
`);
    } else {
      process.stdout.write(`${stateText}
`);
    }
    return 0;
  }
  if (verb === "changes") {
    const parsed = parseVerbArgs("changes", rest);
    if (parsed.values.since === undefined) {
      throw usageError("changes requires --since <epochSeconds> (use 0 for everything, then pass back the `now` from the previous response)", {
        hint: "ADDITIONS ONLY \u2014 the response's notCovered names what it cannot see; a full `state` read is still the only way to reconcile deletions, rejections and in-place edits"
      });
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ since: parsed.values.since });
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/changes?${params}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "tail") {
    const parsed = parseVerbArgs("tail", rest);
    const inbound = parsed.values.inbound === true;
    requireDaemon();
    const since = Number.parseInt(parsed.values.since, 10);
    let grounded = false;
    return await tailEvents({
      resolve: () => {
        const port = livePort();
        return port === null ? null : `http://127.0.0.1:${port}`;
      },
      path: "/events",
      since: Number.isFinite(since) ? since : 0,
      query: (cursor) => ({
        since: String(cursor),
        ...parsed.values.project ? { project: parsed.values.project } : {},
        ...inbound ? { inbound: "1" } : {}
      }),
      cursorOf: (ev) => typeof ev.id === "number" ? ev.id : undefined,
      epochOf: (ev) => typeof ev.epoch === "string" ? ev.epoch : undefined,
      onEpochChange: (epoch) => JSON.stringify({ kind: "epoch.changed", epoch }),
      render: (ev, frame) => {
        if (ev.kind === "grounding") {
          if (grounded)
            return null;
          grounded = true;
        }
        return frame.data;
      },
      onHttpError: async (res) => {
        if (res.status === 409 || res.status === 404)
          await passOrThrow(res);
        return "retry";
      },
      onMalformed: (frame) => {
        process.stdout.write(`${frame.data}
`);
        return null;
      },
      idleMs: TAIL_IDLE_MS,
      retry: { initialMs: TAIL_RETRY_MS, maxMs: TAIL_RETRY_MAX_MS }
    });
  }
  if (verb === "projects") {
    const parsed = parseVerbArgs("projects", rest);
    const port = requireDaemon();
    if (parsed.values.create) {
      const title = parsed.values.create;
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const res2 = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        body: JSON.stringify({ id, title })
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "ingest") {
    const parsed = parseVerbArgs("ingest", rest);
    if (!parsed.values.title) {
      throw usageError("ingest requires --title");
    }
    if (!parsed.values.file && !parsed.values.stdin) {
      throw usageError("ingest requires --file <path> or --stdin");
    }
    const text = parsed.values.file ? readFileSync(parsed.values.file, "utf8") : await Bun.stdin.text();
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/ingest${qs}`, {
      method: "POST",
      body: JSON.stringify({ title: parsed.values.title, text })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "propose-node" || verb === "propose-edge") {
    const parsed = parseVerbArgs(verb, rest);
    if (!parsed.values.stdin) {
      throw usageError(`${verb} requires --stdin JSON {draft, evidence[, suggestedTier, author, tags, batchId]}`, {
        hint: 'propose-edge endpoints: a node id, a pending node-proposal id, or "title:<exact node title>" ' + "(title refs resolve at INTAKE against ratified nodes only, exact + case-sensitive; " + "an ambiguous title errors and names every candidate id)"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals${qs}`, {
      method: "POST",
      body: JSON.stringify({
        kind: verb === "propose-node" ? "node" : "edge",
        draft: input.draft,
        evidence: input.evidence ?? {},
        suggestedTier: input.suggestedTier,
        author: input.author,
        zone: parsed.values.zone,
        tags: input.tags,
        batchId: input.batchId
      })
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}
`);
    if (verb === "propose-edge") {
      try {
        const { warning } = JSON.parse(responseText);
        if (typeof warning === "string")
          process.stderr.write(`# warning: ${warning}
`);
      } catch {}
    }
    return 0;
  }
  if (verb === "propose-batch") {
    const parsed = parseVerbArgs("propose-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError("propose-batch requires --stdin JSON {nodes:[{ref, draft, suggestedTier?, evidence?}], edges:[{draft:{source, target, label?}}]}", {
        hint: "an edge endpoint may be a node LOCAL REF (matches a node's ref in this batch), " + 'a real node id, a pending proposal id, or "title:<exact node title>" \u2014 local refs ' + "resolve to minted ids and title refs to ratified node ids, both server-side; " + "optional batchId: omit and one is MINTED + returned; supply one to extend that act"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/batch${qs}`, {
      method: "POST",
      body: JSON.stringify({
        nodes: input.nodes ?? [],
        edges: input.edges ?? [],
        batchId: input.batchId
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "ratify-batch") {
    const parsed = parseVerbArgs("ratify-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError('ratify-batch requires --stdin JSON {ruling: "canon|thread|story-local", ids: [proposalId], anchors?: [{node, parent}]}', {
        hint: "ratifies the set in ONE call/txn; nodes ratify before edges (auto-partitioned), " + "edge endpoints + anchor refs resolve old proposal ids \u2192 minted node ids via the " + "returned idMap. NO auto-include of unlisted edges; reject is not a batch act"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/ratify-batch${qs}`, {
      method: "POST",
      body: JSON.stringify({
        ruling: input.ruling,
        ids: input.ids ?? [],
        anchors: input.anchors
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "delete-batch") {
    const parsed = parseVerbArgs("delete-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError('delete-batch requires --stdin JSON {ids: ["<proposalId>", ...]}', {
        hint: "deletes the set in ONE txn \u2014 all-or-nothing: if any id is unknown, NOTHING is " + "deleted and the error names every unknown id. There is deliberately no " + "{batch: <id>} shorthand \u2014 run `state --batch <id>` and look before you sweep " + "(drive #10's bug was an over-broad cleanup that took the edges with it)"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/delete-batch${qs}`, {
      method: "POST",
      body: JSON.stringify({ ids: input.ids ?? [] })
    });
    const deleteBatchBody = await passOrThrow(res);
    process.stdout.write(`${deleteBatchBody}
`);
    try {
      const { warning } = JSON.parse(deleteBatchBody);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
    return 0;
  }
  if (verb === "node") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("node").includes(sub)) {
      throw usageError(sub === undefined ? "node requires a sub-command" : `unknown node sub-command: ${sub}`, { choices: subsOf("node") });
    }
    const parsed = parseVerbArgs(`node ${sub}`, rest.slice(1));
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "delete") {
      const id2 = parsed.positionals[0];
      if (!id2) {
        throw usageError("usage: cli.ts node delete <nodeId> [--force]");
      }
      const port2 = requireDaemon();
      const params = new URLSearchParams;
      if (parsed.values.project)
        params.set("project", parsed.values.project);
      if (parsed.values.force)
        params.set("force", "1");
      const dqs = params.size > 0 ? `?${params}` : "";
      const res2 = await fetch(`http://127.0.0.1:${port2}/nodes/${id2}${dqs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    if (sub === "edit") {
      const id2 = parsed.positionals[0];
      const patch = {};
      if (parsed.values.stdin) {
        Object.assign(patch, JSON.parse(await Bun.stdin.text()));
      }
      if (parsed.values.title !== undefined)
        patch.title = parsed.values.title;
      if (parsed.values.synopsis !== undefined)
        patch.synopsis = parsed.values.synopsis;
      if (!id2 || patch.title === undefined && patch.synopsis === undefined) {
        throw usageError(`usage: cli.ts node edit <nodeId> (--title <t> | --synopsis <s> | --stdin '{"synopsis": "..."}')`, {
          hint: "writes exactly what it is given (no inference); only title/synopsis are editable \u2014 " + "tier is the human's ruling and kind is a ratification-time classification"
        });
      }
      const port2 = requireDaemon();
      const res2 = await fetch(`http://127.0.0.1:${port2}/nodes/${id2}${qs}`, {
        method: "POST",
        body: JSON.stringify({
          ...patch.title !== undefined ? { title: patch.title } : {},
          ...patch.synopsis !== undefined ? { synopsis: patch.synopsis } : {}
        })
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    if (sub !== "anchor") {
      throw usageError(`usage: cli.ts node anchor <nodeId> (--to <parentId> | --clear) | node edit <nodeId> (--title <t> | --synopsis <s> | --stdin) | node delete <nodeId> [--force]
`);
    }
    const id = parsed.positionals[0];
    const hasTo = parsed.values.to !== undefined;
    if (!id || hasTo && parsed.values.clear || !hasTo && !parsed.values.clear) {
      throw usageError(`usage: cli.ts node anchor <nodeId> (--to <parentId> | --clear)
` + `  --to anchors the node under <parentId> (a real node id); --clear moves it to top-level
`);
    }
    const port = requireDaemon();
    const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}/anchor${qs}`, {
      method: "POST",
      body: JSON.stringify({ parentId: parsed.values.clear ? null : parsed.values.to })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "read" || verb === "message") {
    const parsed = parseVerbArgs("read", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts read <messageId>");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/message/${id}${qs}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "zone") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("zone").includes(sub)) {
      throw usageError(sub === undefined ? "zone requires a sub-command" : `unknown zone sub-command: ${sub}`, { choices: subsOf("zone") });
    }
    const parsed = parseVerbArgs(`zone ${sub}`, rest.slice(1));
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "create") {
      const name = parsed.positionals.join(" ");
      if (!name) {
        throw usageError("usage: cli.ts zone create <name>");
      }
      const res = await fetch(`http://127.0.0.1:${port}/zones${qs}`, {
        method: "POST",
        body: JSON.stringify({ name })
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "list") {
      const res = await fetch(`http://127.0.0.1:${port}/zones${qs}`);
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts zone delete <id> [--yes]");
      }
      const params = new URLSearchParams;
      if (parsed.values.project)
        params.set("project", parsed.values.project);
      if (parsed.values.yes)
        params.set("yes", "1");
      const dqs = params.size > 0 ? `?${params}` : "";
      const res = await fetch(`http://127.0.0.1:${port}/zones/${id}${dqs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    throw usageError("usage: cli.ts zone <create <name> | list | delete <id> [--yes]>");
  }
  if (verb === "promote") {
    const parsed = parseVerbArgs("promote", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts promote <proposalId>");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/promote${qs}`, {
      method: "POST"
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "proposal") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("proposal").includes(sub)) {
      throw usageError(sub === undefined ? "proposal requires a sub-command" : `unknown proposal sub-command: ${sub}`, { choices: subsOf("proposal") });
    }
    const parsed = parseVerbArgs(`proposal ${sub}`, rest.slice(1));
    const pqs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "delete") {
      const id2 = parsed.positionals[0];
      if (!id2) {
        throw usageError("usage: cli.ts proposal delete <proposalId>");
      }
      const port2 = requireDaemon();
      const res2 = await fetch(`http://127.0.0.1:${port2}/proposals/${id2}${pqs}`, {
        method: "DELETE"
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    if (sub !== "zone") {
      throw usageError(`usage: cli.ts proposal zone <id> (--to <zoneId> | --clear) | proposal delete <id>
`);
    }
    const id = parsed.positionals[0];
    const hasTo = parsed.values.to !== undefined;
    if (!id || hasTo && parsed.values.clear || !hasTo && !parsed.values.clear) {
      throw usageError(`usage: cli.ts proposal zone <proposalId> (--to <zoneId> | --clear)
` + `  --to moves a PENDING proposal INTO <zoneId>; --clear moves it back to the main queue
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/zone${qs}`, {
      method: "POST",
      body: JSON.stringify({ zoneId: parsed.values.clear ? null : parsed.values.to })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "doc") {
    const probe = parseArgs({
      args: rest,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true
    });
    const docPath = probe.positionals[0] === "kind" ? "doc kind" : probe.positionals[0] === "delete" ? "doc delete" : "doc";
    const parsed = parseVerbArgs(docPath, rest);
    if (parsed.positionals[0] === "kind") {
      const docId = parsed.positionals[1];
      const kindWords = parsed.positionals.slice(2).join(" ");
      if (!docId || kindWords === "" && !parsed.values.clear) {
        throw usageError(`usage: cli.ts doc kind <docId> <kind> [--author user|agent] | doc kind <docId> --clear
`);
      }
      const port2 = requireDaemon();
      const qs2 = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
      const res2 = await fetch(`http://127.0.0.1:${port2}/doc/${docId}/kind${qs2}`, {
        method: "POST",
        body: JSON.stringify(parsed.values.clear ? { kind: null } : { kind: kindWords, author: parsed.values.author ?? "agent" })
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    const isDelete = parsed.positionals[0] === "delete";
    const id = isDelete ? parsed.positionals[1] : parsed.positionals[0];
    if (!id) {
      throw usageError(`usage: cli.ts doc <id> | doc delete <id> [--force] | doc kind <docId> <kind|--clear> [--project <id>]
`);
    }
    const port = requireDaemon();
    const params = new URLSearchParams;
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    if (isDelete && parsed.values.force)
      params.set("force", "1");
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/doc/${id}${qs}`, {
      method: isDelete ? "DELETE" : "GET"
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "mark") {
    const parsed = parseVerbArgs("mark", rest);
    const docId = parsed.positionals[0];
    if (!docId || !parsed.values.status) {
      throw usageError("usage: cli.ts mark <docId> --status <s> [--note <t>]");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/doc/${docId}/mark${qs}`, {
      method: "POST",
      body: JSON.stringify({
        author: parsed.values.author ?? "agent",
        note: parsed.values.note,
        status: parsed.values.status
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "search") {
    const parsed = parseVerbArgs("search", rest);
    const query = parsed.positionals.join(" ");
    if (!query) {
      throw usageError("usage: cli.ts search <query...>");
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ q: query });
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/search?${params}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "neighbors") {
    const parsed = parseVerbArgs("neighbors", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts neighbors <nodeId> [--depth 1]");
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ depth: parsed.values.depth ?? "1" });
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/neighbors/${id}?${params}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "ratify") {
    const parsed = parseVerbArgs("ratify", rest);
    const proposalId = parsed.positionals[0];
    if (!proposalId || !parsed.values.ruling) {
      throw usageError(`usage: cli.ts ratify <proposalId> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <text>] [--anchor <parentId>]
`);
    }
    if (parsed.values.doc && !parsed.values["doc-edit"]) {
      throw usageError("--doc requires --doc-edit (the drafted doc home)");
    }
    const docEdit = parsed.values["doc-edit"] ? readFileSync(parsed.values["doc-edit"], "utf8") : undefined;
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${proposalId}/ruling${qs}`, {
      method: "POST",
      body: JSON.stringify({
        ruling: parsed.values.ruling,
        docEdit,
        docId: parsed.values.doc,
        span: parsed.values.span,
        anchor: parsed.values.anchor
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "lens") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("lens").includes(sub)) {
      throw usageError(sub === undefined ? "lens requires a sub-command" : `unknown lens sub-command: ${sub}`, { choices: subsOf("lens") });
    }
    const parsed = parseVerbArgs(`lens ${sub}`, rest.slice(1));
    if (parsed.values.node !== undefined && parsed.values.doc !== undefined) {
      throw usageError("lens set takes --node OR --doc, not both");
    }
    if (parsed.values.doc !== undefined && parsed.values.depth !== undefined) {
      throw usageError("--depth applies to a node lens only");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "set") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, {
        method: "POST",
        body: JSON.stringify({
          owner: parsed.values.owner ?? "agent",
          nodeId: parsed.values.node,
          docId: parsed.values.doc,
          depth: parsed.values.depth ? Number.parseInt(parsed.values.depth, 10) : undefined
        })
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "clear") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    throw usageError(`usage: cli.ts lens <set (--node <id> [--depth n] | --doc <docId>) | clear>
`);
  }
  if (verb === "look-here") {
    const parsed = parseVerbArgs("look-here", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts look-here <nodeId>");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/look-here/${id}${qs}`, { method: "POST" });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "actions") {
    const parsed = parseVerbArgs("actions", rest);
    const targetId = parsed.positionals[0];
    const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
    if (!targetId || modes.filter(Boolean).length !== 1) {
      throw usageError(`usage: cli.ts actions <targetId> (--set <json> | --stdin | --clear)
` + `  target is a node id or a PENDING proposal id; json is an array of
` + `  {"id", "label", "seed"} \u2014 empty array (or --clear) removes the slots
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const target = `http://127.0.0.1:${port}/actions/${targetId}${qs}`;
    const res = parsed.values.clear ? await fetch(target, { method: "DELETE" }) : await fetch(target, {
      method: "PUT",
      body: parsed.values.stdin ? await Bun.stdin.text() : parsed.values.set
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}
`);
    try {
      const { warning } = JSON.parse(responseText);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
    return 0;
  }
  if (verb === "tags") {
    const parsed = parseVerbArgs("tags", rest);
    const targetId = parsed.positionals[0];
    const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
    if (!targetId || modes.filter(Boolean).length !== 1) {
      throw usageError(`usage: cli.ts tags <targetId> (--set <json> | --stdin | --clear)
` + `  target is a node id or a PENDING proposal id; json is an array of
` + `  freeform strings \u2014 empty array (or --clear) removes the tags
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const target = `http://127.0.0.1:${port}/tags/${targetId}${qs}`;
    const res = parsed.values.clear ? await fetch(target, { method: "DELETE" }) : await fetch(target, {
      method: "PUT",
      body: parsed.values.stdin ? await Bun.stdin.text() : parsed.values.set
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "job") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("job").includes(sub)) {
      throw usageError(sub === undefined ? "job requires a sub-command" : `unknown job sub-command: ${sub}`, { choices: subsOf("job") });
    }
    const parsed = parseVerbArgs(`job ${sub}`, rest.slice(1));
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const base = (port, suffix = "") => `http://127.0.0.1:${port}/jobs${suffix}${qs}`;
    const bodyFromSource = async () => {
      if (parsed.values["body-file"] !== undefined) {
        const p = parsed.values["body-file"];
        if (!existsSync(p)) {
          throw usageError(`job: --body-file not found: ${p}`);
        }
        return JSON.parse(readFileSync(p, "utf8"));
      }
      if (parsed.values.stdin)
        return JSON.parse(await Bun.stdin.text());
      return null;
    };
    if (sub === "list") {
      const port = requireDaemon();
      const res = await fetch(base(port));
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "create") {
      const override = await bodyFromSource();
      const body = override ?? {
        title: parsed.values.title,
        status: parsed.values.status,
        deliverable: parsed.values.deliverable,
        detail: parsed.values.detail
      };
      if (typeof body.title !== "string" || body.title === "") {
        throw usageError(`usage: cli.ts job create --title <t> [--status <s>] [--deliverable <ref>] [--detail <x>]
` + `  or: cli.ts job create (--stdin | --body-file <path>) with JSON {title, status?, deliverable?, detail?}
`);
      }
      const port = requireDaemon();
      const res = await fetch(base(port), { method: "POST", body: JSON.stringify(body) });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "update") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError(`usage: cli.ts job update <id> [--title <t>] [--status <s>] [--deliverable <ref>] [--detail <x>]
`);
      }
      const override = await bodyFromSource();
      const body = override ?? Object.fromEntries(["title", "status", "deliverable", "detail"].filter((k) => parsed.values[k] !== undefined).map((k) => [k, parsed.values[k]]));
      if (Object.keys(body).length === 0) {
        throw usageError(`usage: cli.ts job update <id> (at least one of --title|--status|--deliverable|--detail)
`);
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}`), { method: "POST", body: JSON.stringify(body) });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "claim") {
      const id = parsed.positionals[0];
      if (!id || parsed.values.owner === undefined) {
        throw usageError("usage: cli.ts job claim <id> --owner <who>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/claim`), {
        method: "POST",
        body: JSON.stringify({ owner: parsed.values.owner })
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "release") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts job release <id>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/release`), { method: "POST" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "subtask") {
      const id = parsed.positionals[0];
      const modes = [
        parsed.values.add !== undefined,
        parsed.values.check !== undefined,
        parsed.values.uncheck !== undefined
      ];
      if (!id || modes.filter(Boolean).length !== 1) {
        throw usageError(`usage: cli.ts job subtask <id> (--add <label> | --check <subtaskId> | --uncheck <subtaskId>)
`);
      }
      const jobBody = parsed.values.add !== undefined ? { op: "add", label: parsed.values.add } : parsed.values.check !== undefined ? { op: "check", subtaskId: parsed.values.check } : { op: "uncheck", subtaskId: parsed.values.uncheck };
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/subtask`), {
        method: "POST",
        body: JSON.stringify(jobBody)
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts job delete <id>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}`), { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    throw usageError(`usage: cli.ts job <create|update <id>|claim <id> --owner <who>|release <id>|subtask <id> ...|list|delete <id>>
`);
  }
  if (verb === "activity") {
    const parsed = parseVerbArgs("activity", rest);
    const state = parsed.positionals[0];
    if (state !== "received" && state !== "thinking" && state !== "idle") {
      throw usageError("usage: cli.ts activity <received|thinking|idle> [--message <id>]");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/activity${qs}`, {
      method: "POST",
      body: JSON.stringify({ state, messageId: parsed.values.message })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "send") {
    const parsed = parseVerbArgs("send", rest);
    const hasInline = parsed.positionals.length > 0;
    let text;
    let fromInline = false;
    if (parsed.values["body-file"] !== undefined) {
      const path = parsed.values["body-file"];
      if (!existsSync(path)) {
        throw usageError(`send: --body-file not found: ${path}`);
      }
      text = readFileSync(path, "utf8").replace(/\n$/, "");
    } else if (parsed.values.stdin || !hasInline && !process.stdin.isTTY) {
      text = (await Bun.stdin.text()).replace(/\n$/, "");
    } else {
      text = parsed.positionals.join(" ");
      fromInline = true;
    }
    if (text === "") {
      throw usageError(`usage: cli.ts send <text...> | --body-file <path> | --stdin
` + `mind-mapper: send resolved an empty body \u2014 nothing sent
`);
    }
    if (!parsed.values.force && /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\bsend\b/.test(text)) {
      throw usageError("mind-mapper: that body looks like a leaked cli invocation (a fumbled heredoc?). " + "Nothing was sent. Pipe the real body via --stdin or --body-file <path>, " + `or pass --force to send it anyway.
`);
    }
    if (fromInline && /`|\$\(|\$\{/.test(text)) {
      process.stderr.write("# warning: inline body contains shell metacharacters (backtick, $(), curly-brace vars). " + "It was sent as-is, but the shell can command-substitute these first \u2014 " + `use --body-file or --stdin for code-bearing messages.
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/send${qs}`, {
      method: "POST",
      body: JSON.stringify({
        role: parsed.values.role ?? "agent",
        kind: parsed.values.kind ?? "turn",
        text,
        ground: (() => {
          const refs = (parsed.values.ground ?? []).flatMap((g) => g.split(",")).map((g) => g.trim()).filter((g) => g !== "");
          return refs.length > 0 ? refs : undefined;
        })()
      })
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}
`);
    try {
      const { warning } = JSON.parse(responseText);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
    return 0;
  }
  const VERB_CHOICES = [...VERBS, ...Object.keys(VERB_ALIASES)];
  if (verb === undefined) {
    throw usageError("no verb given", { hint: "run: cli.ts help", choices: VERB_CHOICES });
  }
  if (verb.startsWith("-")) {
    throw usageError(`unknown flag at the root: ${verb} (flags belong after a verb; root tokens are --help/-h and --version/-V)`, { hint: "run: cli.ts help", choices: VERB_CHOICES });
  }
  throw usageError(`unknown verb: ${verb}`, { hint: "run: cli.ts help", choices: VERB_CHOICES });
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  VERBS,
  VERB_ALIASES,
  VERB_SPEC,
  run
};

//# debugId=562C5E8F12D5A5FA64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9lcnJvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWluZC1tYXBwZXIvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIG1pbmQtbWFwcGVyIOKAlCB0aGUgZnVsbCB2ZXJiIHNldCAoVjEgKyBWMS54ICsgUm91bmQgMyk6XG4vLyAgIG9wZW4gICAgICAgICAgc3Bhd24gKG9yIGZpbmQpIHRoZSBkYWVtb24sIHByaW50IGl0cyB1cmwsIG9wZW4gdGhlIGJyb3dzZXJcbi8vICAgICAgICAgICAgICAgICAtLXByb2plY3QgPGlkPiBzY29wZXMgdGhlIHVybCAoP3Byb2plY3Q9KTsgb3BlbiBuZXZlciBtaW50cyDigJRcbi8vICAgICAgICAgICAgICAgICBhbiB1bmtub3duIGlkIGVycm9ycyAodXNlIHByb2plY3RzIC0tY3JlYXRlIGZpcnN0KVxuLy8gICAgICAgICAgICAgICAgIC0tcG9ydCA8bj4gYmluZHMgYSBTVEFCTEUgcG9ydCBzbyBhIGJyb3dzZXIgcmVmcmVzaCByZWNvbm5lY3RzXG4vLyAgICAgICAgICAgICAgICAgYWNyb3NzIGFuIGVudmlyb25tZW50LXJlYXAgKyByZXN0YXJ0LiBUd28gd3JpbmtsZXM6ICgxKSBhZ2FpbnN0XG4vLyAgICAgICAgICAgICAgICAgYSBMSVZFIGRhZW1vbiAtLXBvcnQgTiBpcyBJR05PUkVEIChvcGVuIHJldHVybnMgdGhlIGV4aXN0aW5nXG4vLyAgICAgICAgICAgICAgICAgZGFlbW9uKSDigJQgdGhlIHN0YWJsZSB1cmwgaG9sZHMgb25seSBpZiB0aGUgRklSU1Qgb3BlbiBzZXQgaXQ7XG4vLyAgICAgICAgICAgICAgICAgKDIpIGlmIHBvcnQgTiBpcyBhbHJlYWR5IGluIHVzZSB0aGUgZGFlbW9uIGV4aXRzIGFuZCB0aGlzIHBvbGxcbi8vICAgICAgICAgICAgICAgICB0aW1lcyBvdXQgKFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cFwiKSDigJQgcGljayBhIGZyZWUgcG9ydC5cbi8vICAgc3RhdGUgICAgICAgICBHRVQgL3N0YXRlIOKGkiB0aGUgcmVhbCBwcm9qZWN0IHNuYXBzaG90IG9uIHN0ZG91dFxuLy8gICAgICAgICAgICAgICAgIC0tc2tlbGV0b24gcmV0dXJucyBpZHMvdGl0bGVzL2RlZ3JlZSBvbmx5IChjb250ZXh0IGJ1ZGdldGluZylcbi8vICAgICAgICAgICAgICAgICBmcmVzaCBzdG9yZSB3aXRoIG5vIHByb2plY3Qg4oaSIHRoZSBuZWVkcy1wcm9qZWN0IDQwOSByaWRlc1xuLy8gICAgICAgICAgICAgICAgIHRoZSBlcnJvciBlbnZlbG9wZSAoY29uZmxpY3QsIGV4aXQgNjsgYm9keSB1bmRlciBlcnJvci5zZXJ2ZXIpXG4vLyAgIHRhaWwgICAgICAgICAgTW9uaXRvci1zaGFwZWQ6IEdFVCAvZXZlbnRzP3NpbmNlPTxjdXJzb3I+IFNTRSDihpIgb25lIEpTT05cbi8vICAgICAgICAgICAgICAgICBsaW5lIHBlciBldmVudCBvbiBzdGRvdXRcbi8vICAgICAgICAgICAgICAgICAtLWluYm91bmQgZmlsdGVycyBzZXJ2ZXItc2lkZSB0byBodW1hbi1vcmlnaW5hdGVkIGV2ZW50c1xuLy8gICAgICAgICAgICAgICAgIChjaGF0ICsgZHJvcHBlZCBub2RlcykgKyBvcGVucyB3aXRoIGEga2luZDpcImdyb3VuZGluZ1wiIGxpbmVcbi8vICAgcHJvamVjdHMgICAgICBsaXN0IHNhdmVkIHByb2plY3RzOyAtLWNyZWF0ZSA8dGl0bGU+IG1ha2VzIGEgbmV3IG9uZVxuLy8gICBpbmdlc3QgICAgICAgIC0tdGl0bGUgVCAoLS1maWxlIFAgfCAtLXN0ZGluKSDihpIgUE9TVCAvaW5nZXN0XG4vLyAgIHByb3Bvc2Utbm9kZSAgLS1zdGRpbiBKU09OIHtkcmFmdCwgZXZpZGVuY2UsIHN1Z2dlc3RlZFRpZXI/fSDihpIgUE9TVCAvcHJvcG9zYWxzXG4vLyAgIHByb3Bvc2UtZWRnZSAgc2FtZSBzaGFwZSwga2luZDogXCJlZGdlXCIgKHNvdXJjZS90YXJnZXQgbWF5IGJlIGEgcmVhbCBub2RlXG4vLyAgICAgICAgICAgICAgICAgaWQgT1IgYSBwZW5kaW5nIHByb3Bvc2FsJ3MgaWQg4oCUIHJhdGlmeSByZXNvbHZlcyB0aGUgbGF0dGVyKVxuLy8gICAgICAgICAgICAgICAgIC0tem9uZSA8aWQ+IHN0YWdlcyB0aGUgcHJvcG9zYWwgaW4gYSB6b25lXG4vLyAgIHByb3Bvc2UtYmF0Y2ggLS1zdGRpbiBKU09OIHtub2Rlczpbe3JlZiwgZHJhZnQsIC4uLn1dLCBlZGdlczpbe2RyYWZ0Ontcbi8vICAgICAgICAgICAgICAgICBzb3VyY2UsIHRhcmdldCwgbGFiZWw/fX1dfSDigJQgb25lIHRyYW5zYWN0aW9uOyBhbiBlZGdlXG4vLyAgICAgICAgICAgICAgICAgZW5kcG9pbnQgbWF5IGJlIGEgbm9kZSdzIExPQ0FMIFJFRiAocmVzb2x2ZWQgdG8gdGhlIG1pbnRlZFxuLy8gICAgICAgICAgICAgICAgIGlkIHNlcnZlci1zaWRlKSwgYSByZWFsIG5vZGUgaWQsIG9yIGEgcGVuZGluZyBwcm9wb3NhbCBpZC5cbi8vICAgICAgICAgICAgICAgICBSZXR1cm5zIHtyZWZUb0lkLCBwcm9wb3NhbHN9XG4vLyAgIHJlYWQgPGlkPiAgICAgR0VUIC9tZXNzYWdlLzppZCDihpIgdGhlIGZ1bGwgbWVzc2FnZSByb3cgKGFsaWFzOiBtZXNzYWdlIDxpZD4pXG4vLyAgIG5vZGUgYW5jaG9yIDxpZD4gKC0tdG8gPHBhcmVudElkPiB8IC0tY2xlYXIpICBQT1NUIC9ub2Rlcy86aWQvYW5jaG9yIOKAlFxuLy8gICAgICAgICAgICAgICAgIGFuY2hvciBhIHJlYWwgbm9kZSB1bmRlciBhIHBhcmVudCBpbiB0aGUgc3VibWFwIHRyZWUsIG9yXG4vLyAgICAgICAgICAgICAgICAgLS1jbGVhciB0byBtb3ZlIGl0IGJhY2sgdG8gdG9wLWxldmVsIChjeWNsZXMgcmVqZWN0ZWQpXG4vLyAgIHpvbmUgICAgICAgICAgY3JlYXRlIDxuYW1lPiAoc2x1ZyBpZCBkZXJpdmVkKSB8IGxpc3QgfCBkZWxldGUgPGlkPiBbLS15ZXNdXG4vLyAgICAgICAgICAgICAgICAgKGRlbGV0ZSBjYXNjYWRlcyB0aGUgem9uZSdzIHByb3Bvc2FsczsgcG9wdWxhdGVkIHpvbmVzIDQwOVxuLy8gICAgICAgICAgICAgICAgIHdpdGhvdXQgLS15ZXMpXG4vLyAgIHByb21vdGUgPGlkPiAgbW92ZSBhIHpvbmVkIHBlbmRpbmcgcHJvcG9zYWwgdG8gdGhlIG1haW4gcmV2aWV3IHF1ZXVlXG4vLyAgICAgICAgICAgICAgICAgKGVkZ2UgZW5kcG9pbnRzIG11c3QgcHJvbW90ZSBmaXJzdCDigJQgZXJyb3IgbmFtZXMgdGhlbSlcbi8vICAgcHJvcG9zYWwgem9uZSA8aWQ+ICgtLXRvIDx6b25lSWQ+IHwgLS1jbGVhcikgIFBPU1QgL3Byb3Bvc2Fscy86aWQvem9uZSDigJRcbi8vICAgICAgICAgICAgICAgICBtb3ZlIGEgUEVORElORyBwcm9wb3NhbCBJTlRPIGEgem9uZSAodGhlIGludmVyc2Ugb2YgcHJvbW90ZSksXG4vLyAgICAgICAgICAgICAgICAgb3IgLS1jbGVhciB0byBtb3ZlIGl0IGJhY2sgdG8gbWFpblxuLy8gICBkb2MgPGlkPiAgICAgIEdFVCAvZG9jLzppZCDihpIgdGhlIGRvYyBlbnZlbG9wZSBvbiBzdGRvdXRcbi8vICAgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSAgREVMRVRFIC9kb2MvOmlkIOKGkiA0MDkge2Vycm9yOlwiY2l0ZWRcIiwgY2l0ZWRCeX1cbi8vICAgICAgICAgICAgICAgICB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuLy8gICBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kPiBbLS1hdXRob3IgdXNlcnxhZ2VudF0gfCBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJcbi8vICAgICAgICAgICAgICAgICBQT1NUIC9kb2MvOmlkL2tpbmQg4oCUIGFzc2VydCAob3IgY2xlYXIpIGEgZG9jJ3Mga2luZDsgaW5nZXN0XG4vLyAgICAgICAgICAgICAgICAgbmV2ZXIgZ3Vlc3NlcyBvbmUgKHVudHlwZWQgPSBraW5kIG51bGwgb24gdGhlIHdpcmUpXG4vLyAgIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICBQT1NUIC9kb2MvOmlkL21hcmsg4oaSIGFwcGVuZCBhXG4vLyAgICAgICAgICAgICAgICAgc3RhdHVzIG1hcmsgKGRvYy5tYXJrZWQgY2FycmllcyB0aGUgZnVsbCBtYXJrIGlubGluZSlcbi8vICAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgIFBVVC9ERUxFVEVcbi8vICAgICAgICAgICAgICAgICAvYWN0aW9ucy86dGFyZ2V0SWQg4oCUIHJlcGxhY2UgKHdob2xlc2FsZSkgb3IgY2xlYXIgdGhlXG4vLyAgICAgICAgICAgICAgICAgYWN0aW9uIHNsb3RzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuXG4vLyAgICAgICAgICAgICAgICAgYXJyYXkgb2Yge2lkLCBsYWJlbCwgc2VlZH07ID40IGVudHJpZXMgd2FybnMgKHNvZnQgY2FwKVxuLy8gICB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgUFVUL0RFTEVURVxuLy8gICAgICAgICAgICAgICAgIC90YWdzLzp0YXJnZXRJZCDigJQgcmVwbGFjZSAod2hvbGVzYWxlKSBvciBjbGVhciB0aGUgZnJlZWZvcm1cbi8vICAgICAgICAgICAgICAgICB0YWdzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuIGFycmF5IG9mXG4vLyAgICAgICAgICAgICAgICAgc3RyaW5nczsgdGFncyBhbHNvIHJpZGUgcHJvcG9zZS0qIHN0ZGluIEpTT04gKGEgYHRhZ3NgIGtleSlcbi8vICAgam9iICAgICAgICAgICBjcmVhdGUgLS10aXRsZSBUIFstLXN0YXR1cyBzXSBbLS1kZWxpdmVyYWJsZSByZWZdIFstLWRldGFpbCB4XVxuLy8gICAgICAgICAgICAgICAgIHwgdXBkYXRlIDxpZD4gWy0tdGl0bGUvLS1zdGF0dXMvLS1kZWxpdmVyYWJsZS8tLWRldGFpbF1cbi8vICAgICAgICAgICAgICAgICB8IGNsYWltIDxpZD4gLS1vd25lciA8d2hvPiAoYXRvbWljIGxlYXNlOyA0MDkgaWYgaGVsZCBieVxuLy8gICAgICAgICAgICAgICAgICAgYW5vdGhlciBvd25lcikgfCByZWxlYXNlIDxpZD4gfCBzdWJ0YXNrIDxpZD4gKC0tYWRkIDxsYWJlbD5cbi8vICAgICAgICAgICAgICAgICAgIHwgLS1jaGVjayA8c3VidGFza0lkPiB8IC0tdW5jaGVjayA8c3VidGFza0lkPikgfCBsaXN0XG4vLyAgICAgICAgICAgICAgICAgfCBkZWxldGUgPGlkPi4gQSBwZXJzaXN0ZWQgdW5pdCBvZiBBR0VOVCBXT1JLIChzdGF0dXMgK1xuLy8gICAgICAgICAgICAgICAgIHN1Yi10YXNrcyArIGRlbGl2ZXJhYmxlICsgb3duZXIpOyBjcmVhdGUvdXBkYXRlIGFsc28gdGFrZSBhXG4vLyAgICAgICAgICAgICAgICAgZnVsbCBKU09OIGJvZHkgdmlhIC0tc3RkaW4gLyAtLWJvZHktZmlsZVxuLy8gICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gIFBPU1QgL2FjdGl2aXR5IOKGkiBmaXJlLWFuZC1mb3JnZXRcbi8vICAgICAgICAgICAgICAgICBhZ2VudC5hY3Rpdml0eSBzaWduYWwgKH42MHMgVFRMIGVtaXRzIHN5bnRoZXRpYyBpZGxlKVxuLy8gICBzZWFyY2ggPHEuLi4+IEdFVCAvc2VhcmNoIOKGkiB7aGl0czogW3traW5kOiBub2RlfGRvY3xtZXNzYWdlLCAuLi59XX1cbi8vICAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gIEdFVCAvbmVpZ2hib3JzLzppZCDihpIgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuLy8gICByYXRpZnkgPGlkPiAtLXJ1bGluZyBjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWx8cmVqZWN0IFstLWRvYy1lZGl0IDxmaWxlPl1cbi8vICAgICAgICAgICAgICAgICBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSAgcmF0aWZ5LXRpbWUgZXZpZGVuY2UgYXR0YWNoOlxuLy8gICAgICAgICAgICAgICAgIGZvciBhbiBFVklERU5DRS1MRVNTIG5vZGUgcHJvcG9zYWwgb25seSwgLS1kb2MgbmFtZXMgdGhlIGRvY1xuLy8gICAgICAgICAgICAgICAgIGhvbWUgKG11c3QgZXhpc3Q7IHJlcXVpcmVzIC0tZG9jLWVkaXQpIGFuZCBtaW50cyB0aGUgbm9kZSdzXG4vLyAgICAgICAgICAgICAgICAgc291cmNlcyByb3cgd2l0aCB0aGUgb3B0aW9uYWwgLS1zcGFuIGV4Y2VycHRcbi8vICAgbGVucyBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGRvY0lkPikgfCBsZW5zIGNsZWFyXG4vLyAgIGxvb2staGVyZSA8bm9kZUlkPiAgZmlyZS1vbmNlIGF0dGVudGlvbiBudWRnZSwgbm90IHBlcnNpc3RlZFxuLy8gICBzZW5kICAgICAgICAgIGJvZHkgY2hhaW46IC0tYm9keS1maWxlIDxwYXRoPiA+IC0tc3RkaW4gPiBpbmxpbmUgPHRleHQuLi4+ID5cbi8vICAgICAgICAgICAgICAgICBwaXBlZCBzdGRpbjsgWy0tcm9sZSB1c2VyfGFnZW50XSBbLS1raW5kXSBbLS1ncm91bmQgYSxiXVxuLy8gICAgICAgICAgICAgICAgIChyZXBlYXRhYmxlIOKAlCByZXBlYXRzIGFjY3VtdWxhdGUsIGNvbW1hcyBzcGxpdCBlaXRoZXIgd2F5KVxuLy8gICAgICAgICAgICAgICAgIFstLWZvcmNlXSDihpIgUE9TVCAvc2VuZC4gRW1wdHkgcmVzb2x2ZWQgYm9keSA9IHVzYWdlIGVycm9yLiBUaGVcbi8vICAgICAgICAgICAgICAgICBwaXBlZCBkZWZhdWx0IEhBTkdTIHdpdGggbm8gcGlwZSB1bmRlciBhZ2VudCBzaGVsbHMg4oCUIGFsd2F5c1xuLy8gICAgICAgICAgICAgICAgIHBhc3MgYSBib2R5ICgtLWJvZHktZmlsZSBwcmVmZXJyZWQgZm9yIHByb3NlKS5cbi8vICAgICAgICAgICAgICAgICBSMTE6IC0ta2luZCBpcyB0aGUgQ0hBTk5FTCB0aGUgbWVzc2FnZSBhcnJpdmVkIHRocm91Z2hcbi8vICAgICAgICAgICAgICAgICAodHVybnxhbmFseXplfGNhbnZhczsgb3BlbiBzZXQg4oCUIGFuIHVua25vd24gb25lIGlzIHN0b3JlZFxuLy8gICAgICAgICAgICAgICAgIHdpdGggYSBzdGRlcnIgYWR2aXNvcnksIG5ldmVyIHJlamVjdGVkKS5cbi8vICAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gIOKGkiBQT1NUIC9hY3Rpdml0eS4gVGhlXG4vLyAgICAgICAgICAgICAgICAgbWVzc2FnZUlkIHRpZXMgdGhlIHNpZ25hbCB0byBPTkUgbWVzc2FnZSBzbyB0aGUgaHVtYW4gc2Vlc1xuLy8gICAgICAgICAgICAgICAgIHdoaWNoIG9uZSBpcyBiZWluZyB3b3JrZWQ7IG9taXR0ZWQsIGl0IGluaGVyaXRzIHRoZSBvcGVuXG4vLyAgICAgICAgICAgICAgICAgbGFkZGVyJ3MgbWVzc2FnZS4gaWRsZSBjbG9zZXMgdGhlIGxhZGRlciAodGhlcmUgaXMgbm8gYGRvbmVgXG4vLyAgICAgICAgICAgICAgICAg4oCUIGFuIGFnZW50IGBzZW5kYCBJUyB0aGUgY29tcGxldGlvbiBzaWduYWwpLlxuLy9cbi8vIC0tcHJvamVjdCA8aWQ+IGlzIGFjY2VwdGVkIGJ5IGV2ZXJ5IHZlcmIgYWJvdmUgZXhjZXB0IG9wZW4gKHNjb3BlcyB0byBhXG4vLyBub24tZGVmYXVsdCBwcm9qZWN0OyBvbWl0IGZvciB0aGUgZGVmYXVsdCBwcm9qZWN0KS5cbi8vXG4vLyBFUlJPUiBDT05UUkFDVCAoYWNjIEwwLCBzdGF0ZWQgT05DRSDigJQgcGVyLXZlcmIgcHJvc2UgYWJvdmUgbmFtZXMgSFRUUFxuLy8gc3RhdHVzZXMsIHRoaXMgdGFibGUgaXMgd2hhdCB0aGUgUFJPQ0VTUyBkb2VzIHdpdGggdGhlbSk6IGV2ZXJ5IGZhaWx1cmUgaXNcbi8vIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciB3aXRoIHN0ZG91dCBlbXB0eSDigJRcbi8vICAge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vICAgIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbi8vICAgdXNhZ2Ug4oaSIGV4aXQgMiDCtyBpbnRlcm5hbCDihpIgMSDCtyBub3RfZm91bmQg4oaSIDUgKEhUVFAgNDA0KSDCtyBjb25mbGljdCDihpIgNlxuLy8gICAoSFRUUCA0MDkpOyBIVFRQIDQwMCBtYXBzIHRvIHVzYWdlLiBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgdGhlIHNlcnZlcidzXG4vLyAgIG93biBKU09OIGJvZHkgVkVSQkFUSU0gdW5kZXIgZXJyb3Iuc2VydmVyIChuZWVkcy1wcm9qZWN0LCBjaXRlZCwgem9uZWQsXG4vLyAgIHpvbmUtbm90LWVtcHR5LCBjbGFpbSBjb25mbGljdHMsIOKApikg4oCUIGJyYW5jaCBvbiBraW5kL3NlcnZlciwgbmV2ZXIgcHJvc2UuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIEVYSVRfRk9SLFxuICBlcnJvckVudmVsb3BlLFxuICBnZXRDdXJyZW50Q29tbWFuZCxcbiAgQ2xpRXJyb3IgYXMgS2l0Q2xpRXJyb3IsXG4gIHR5cGUgRXJyS2luZCBhcyBLaXRFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbiAgc2V0Q3VycmVudENvbW1hbmQsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50cy50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TLCBUQUlMX1JFVFJZX01BWF9NUywgVEFJTF9SRVRSWV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG4vLyDim5QgRVZFUlkgUEFUSCBCRUxPVyBJUyBDT01QVVRFRCBGUk9NIFRIRSBBUlRJRkFDVCdTIEFERFJFU1MsIFdISUNIIElTXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21pbmQtbWFwcGVyL2Rpc3QvY2xpLmpzYCDigJQgTk9UIEZST00gVEhJUyBTT1VSQ0Vcbi8vIEZJTEUuIFRoYXQgaXMgd2hhdCBtYWtlcyB0aGUgYGltcG9ydC5tZXRhLm1haW5gIGJsb2NrJ3MgYWJzZW5jZSBhdCB0aGUgYm90dG9tXG4vLyBvZiB0aGlzIGZpbGUgYSByZXF1aXJlbWVudCByYXRoZXIgdGhhbiBhIHRpZHk6IHJ1biBmcm9tXG4vLyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvYCB0aGVzZSByZXNvbHZlIGludG8gYHNyYy9taW5kLW1hcHBlci9gLCB3aGljaCBoYXMgbm9cbi8vIGBkaXN0L2luZGV4Lmh0bWxgLCBzbyB0aGUgQ0xJIHdvdWxkIGNob29zZSBERVYgYW5kIHRoZW4gc3Bhd24gYSBkYWVtb24gZnJvbVxuLy8gdGhlIHdyb25nIGFuY2hvci4gYGRpc3QvYCBzaXRzIGF0IHRoZSBzYW1lIGRlcHRoIHVuZGVyIHRoZSBza2lsbCByb290IGFzIHRoZVxuLy8gYHNjcmlwdHMvYCBpdCByZXBsYWNlZCwgc28gZXZlcnkgYW5jZXN0b3IgY2xpbWIgYmVsb3cgaXMgdW5jaGFuZ2VkIOKAlCBhXG4vLyBDT0lOQ0lERU5DRSBPRiBERVBUSCwgYXNzZXJ0ZWQgYnkgYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByYXRoZXJcbi8vIHRoYW4gdHJ1c3RlZCAocGxheWJvb2sgQjQvQjUpLlxuY29uc3QgU0NSSVBUX0RJUiA9IGltcG9ydC5tZXRhLmRpcjtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBOT1QgQSBGTEFUIFNJQkxJTkcuIFRoaXMgd2FzIGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgdW50aWwgdGhlIGJhY2tlbmQgcG9ydCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IHNoYXBlLFxuLy8gY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tIGBkaXN0L2AgdGhlXG4vLyBmbGF0IGZvcm0gbmFtZXMgYGRpc3Qvc2VydmVyLnRzYCwgd2hpY2ggZG9lcyBub3QgZXhpc3Q7IHRoZSBzeW1wdG9tIGlzIG5vdCBhXG4vLyBjcmFzaCBidXQgYGVuc3VyZURhZW1vbmAncyBwb2xsIHJ1bm5pbmcgb3V0IHRvIFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW5cbi8vIDEwc1wiLiBUaGUgbGF1bmNoZXIgaXMgdGhlIHByb2Nlc3MgYSBjYWxsZXIgcnVucywgYW5kIGl0IGxpdmVzIGluIGBzY3JpcHRzL2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2U7IEJ1biByZWFkcyBidW5maWcudG9tbFxuLy8gKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2QgTVVTVCBiZVxuLy8gc3JjL21pbmQtbWFwcGVyLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBwYWdlIDUwMHM7XG4vLyBtaW5kLW1hcHBlcidzIG93biBmYWlsdXJlIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnXG4vLyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lXG4vLyBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkIGJyZWFrIHNwYXduLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1pbmQtbWFwcGVyXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuY29uc3QgSE9NRSA9IHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLm1pbmQtbWFwcGVyXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihIT01FLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKEhPTUUsIFwiZGFlbW9uLnBpZFwiKTtcblxuZnVuY3Rpb24gbGl2ZVBvcnQoKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpIHx8ICFleGlzdHNTeW5jKFBJRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpZCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUElEX0ZJTEUsIFwidXRmOFwiKS50cmltKCksIDEwKTtcbiAgY29uc3QgcG9ydCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0ZjhcIikudHJpbSgpLCAxMCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHBpZCkgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKHBpZCwgMCk7IC8vIGxpdmVuZXNzIHByb2JlLCBubyBzaWduYWwgZGVsaXZlcmVkXG4gICAgcmV0dXJuIHBvcnQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsOyAvLyBzdGFsZSBkaXNjb3ZlcnkgZmlsZXNcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24ocG9ydD86IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJ1bm5pbmcgPSBsaXZlUG9ydCgpO1xuICAvLyBSb3VuZCA3IChQT1JUKTogYSBsaXZlIGRhZW1vbiBJR05PUkVTIC0tcG9ydCDigJQgdGhlIHN0YWJsZS11cmwgZ3VhcmFudGVlXG4gIC8vIG9ubHkgaG9sZHMgaWYgdGhlIEZJUlNUIG9wZW4gc2V0IHRoZSBwb3J0ICh0aGUgZGFlbW9uIGJpbmRzIG9uY2UgYXQgYm9vdCkuXG4gIGlmIChydW5uaW5nICE9PSBudWxsKSByZXR1cm4gcnVubmluZztcbiAgY29uc3QgcHJvYyA9IHNwYXduKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCIsIC4uLihwb3J0ID8gW1wiLS1wb3J0XCIsIFN0cmluZyhwb3J0KV0gOiBbXSldLFxuICAgIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICAgIH0sXG4gICk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gUG9sbCBkaXNjb3ZlcnkgdW50aWwgdGhlIGRhZW1vbiB3cml0ZXMgaXRzIHBvcnQgKGNvbGQgQnVuIGJ1bmRsZSBjYW4gbGFnKS5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwMCkpO1xuICAgIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICAgIGlmIChwb3J0ICE9PSBudWxsKSByZXR1cm4gcG9ydDtcbiAgfVxuICB0aHJvdyBuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBcImRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDEwc1wiKTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY21kID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gIHNwYXduKGNtZCwgW3VybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG59XG5cbi8vIOKblCBgZW52TXNgIElTIEdPTkUsIEFORCBJVFMgVFdPIEtOT0JTIE1PVkVEIFJBVEhFUiBUSEFOIERJU0FQUEVBUkVELlxuLy8gYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCBhcmUgcmVzb2x2ZWQgaW5cbi8vIGAuL2hlYXJ0YmVhdC50c2Ag4oCUIHRoZSBzZWFtIGZpbGUgQk9USCBoYWx2ZXMgaW1wb3J0IOKAlCBiZWNhdXNlIHRoZSB3YXRjaGRvZyBpc1xuLy8gREVSSVZFRCBmcm9tIHRoZSBkYWVtb24ncyBiZWF0IGFuZCBhIGtub2IgcmVzb2x2ZWQgYWJvdmUgdGhlIGRlcml2YXRpb24gc3BsaXRzXG4vLyB0aGUgcGFpciBzaWxlbnRseSwgaW52aXNpYmx5IGF0IHRoZSBkZWZhdWx0IChENzUpLlxuXG4vLyDilIDilIAgdGhlIGZhaWx1cmUgY29udHJhY3Q6IFRIRSBIT1VTRSdTIE9ORSBDT1BZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBERS1EVVBMSUNBVEVELCBBTkQgTUlORC1NQVBQRVIgSVMgT05FIE9GIFRIRSBUV08gU1BFTExTIFRISVMgTU9EVUxFJ1MgT1dOXG4vLyBIRUFERVIgTkFNRVMgQVMgSEFWSU5HIFJFQUNIRUQgSVRTIFNIQVBFIElOREVQRU5ERU5UTFkgKGBlcnJvcnMudHM6MzNgOlxuLy8gXCJnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDBcbi8vIHBhc3Nlc1wiKS4gVGhlIGRlbHRhIG9uIHRoZSBXSVJFIGlzIE5JTCwgYW5kIHRoYXQgaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhblxuLy8gYSBob3BlOiB0aGUgYEVycktpbmRgIHVuaW9uIHdhcyBjaGFyYWN0ZXItZm9yLWNoYXJhY3RlciBpZGVudGljYWwsIGBFWElUX0ZPUmBcbi8vIHdhcyB0aGUgc2FtZSBgMi8xLzUvNmAsIGFuZCB0aGUgZW52ZWxvcGUgaGFkIHRoZSBzYW1lIGtleXMgaW4gdGhlIHNhbWUgb3JkZXJcbi8vIOKAlCBge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1gIOKAlCBpbmNsdWRpbmcgYHNlcnZlcmAgTEFTVCwgd2hpY2ggdGhlIGtpdCdzIG93blxuLy8gY29tbWVudCBzYXlzIGlzIGRlbGliZXJhdGUgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCBpdCBrZWVwcyBpdHMgYnl0ZVxuLy8gb3JkZXIuIOKaoCBPTkUgbGF0ZW50IGRpZmZlcmVuY2UsIGNoZWNrZWQgYW5kIGVtcHR5OiB0aGUga2l0IGd1YXJkcyBgaGludGAgYW5kXG4vLyBgY2hvaWNlc2Agb24gVFJVVEhJTkVTUyB3aGVyZSB0aGlzIGZpbGUgZ3VhcmRlZCBvbiBQUkVTRU5DRSwgc28gYVxuLy8gYGhpbnQ6IFwiXCJgIHdvdWxkIHNoaXAgZnJvbSBvbmUgYW5kIG5vdCB0aGUgb3RoZXIuIEdyZXBwZWQ6IHRoaXMgQ0xJIGhhcyBub1xuLy8gZW1wdHktc3RyaW5nIGhpbnQgYXQgYW55IG9mIGl0cyA2NCByYWlzZSBzaXRlcywgc28gdGhlIHBvcHVsYXRpb25zIGFncmVlLlxuLy9cbi8vIG1pbmQtbWFwcGVyIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0XG4vLyBFVkVSWSBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXNcbi8vIHByZXNlbnRhdGlvbiDigJQgcmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzXG4vLyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBEZWxpdmVyeSBpcyBib3VudHkncywgbm90IG1hZ3BpZSdzOiBUSFJPV1xuLy8gYW5kIGxldCBtYWluKCkgY2F0Y2ggYW5kIFJFVFVSTiB0aGUgY29kZSDigJQgdGhpcyBDTEkgc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4vLyBwYXlsb2FkcywgYW5kIGEgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgYGRpZSgpYCB3b3VsZCB0cnVuY2F0ZSB0aGVtIGF0IDY1LDUzNlxuLy8gYnl0ZXMgKHNlZSB0aGUgZHJhaW4gaWRpb20gYXQgdGhlIGJvdHRvbSBvZiB0aGlzIGZpbGUpLiBUaGUga2l0J3MgYGRpZWBcbi8vIHRocm93cyBmb3IgZXhhY3RseSB0aGF0IHJlYXNvbiwgc28gdGhlIGFkb3B0aW9uIGNoYW5nZXMgbm8gZGVsaXZlcnkgZWl0aGVyLlxuLy9cbi8vIOKblCBBTkQgVEhJUyBJUyBUSEUgT05FIFNURVAgT0YgVEhFIFdIT0xFIFBIQVNFIFdIRVJFIFRIRSBLSVQgSVMgTUVBU1VSQUJMWVxuLy8gV0VBS0VSLCBXSElDSCBJUyBXSFkgVEhFIFRSSUFHRSBDSEFJTiBJTiBgbWFpbmAgQkVMT1cgSVMgS0VQVCBBTkQgTk9UXG4vLyBSRVBMQUNFRC4gYGVycm9ycy50c2AgaXMgVFdPIHRoaW5ncyDigJQgYW4gRU5WRUxPUEUgYW5kIGEgQ0xBU1NJRklFUiDigJQgYW5kIG9ubHlcbi8vIHRoZSBlbnZlbG9wZSBjb252ZXJnZWQuIGByZXBvcnRDbGlFcnJvcmAgcmV0dXJucyBgbnVsbGAgZm9yIGFueXRoaW5nIHRoYXQgaXNcbi8vIG5vdCBhIGBDbGlFcnJvcmAgYW5kIGRlbWFuZHMgdGhlIGNhbGxlciByZXRocm93OyB0aGlzIENMSSB0cmlhZ2VzIFRIUkVFXG4vLyBkb2N1bWVudGVkIHVzYWdlIGNsYXNzZXMgb3V0IG9mIHJhdyB0aHJvd3MgKGBFUlJfUEFSU0VfQVJHUypgLCBhXG4vLyBgU3ludGF4RXJyb3JgIGZyb20gYSBKU09OIGJvZHksIGFuZCBgRU5PRU5UYCBvbiBhIG5hbWVkIGZpbGUpLiBBZG9wdGluZyB0aGVcbi8vIGNsYXNzaWZpZXIgbmFpdmVseSB3b3VsZCByZWdyZXNzIGFsbCB0aHJlZSBpbnRvIGEgc3RhY2stdHJhY2UgY3Jhc2gg4oCUIHRoZVxuLy8gZXhhY3QgZGVmZWN0IHRoaXMgZmlsZSdzIG93biBjb21tZW50IHJlY29yZHMgYXMgY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nLFxuLy8gcmUtY3JlYXRlZCBieSB0aGUgYWRvcHRpb24gbWVhbnQgdG8gc3RhbmRhcmRpc2UgaXQuIFNvIGByZXBvcnRDbGlFcnJvcmAgaXNcbi8vIGNhbGxlZCBJTlNJREUgdGhlIGNoYWluLCBhdCB0aGUgcG9zaXRpb24gdGhlIGNoYWluIHJlYWNoZXMgZm9yIGEgdHlwZWRcbi8vIGZhaWx1cmUsIGFuZCB0aGUgY2hhaW4ga2VlcHMgdGhlIHRocmVlIGJyYW5jaGVzIHRoZSBraXQgZG9lcyBub3QgY2FycnkuXG50eXBlIEVycktpbmQgPSBLaXRFcnJLaW5kO1xuXG4vKipcbiAqIG1pbmQtbWFwcGVyJ3MgcmFpc2UgdHlwZSBpcyBub3cgdGhlIGtpdCdzIGBDbGlFcnJvcmAsIHJlLWV4cG9ydGVkIHVuZGVyIHRoZVxuICogbmFtZSA2MiBjYWxsIHNpdGVzIGFscmVhZHkgdXNlLiDimqAgVGhlIEZJRUxEIFNIQVBFIGRpZmZlcnM6IHRoaXMgZmlsZSdzIGNsYXNzXG4gKiBoZWxkIGBoaW50YC9gY2hvaWNlc2AvYHNlcnZlcmAgYXMgb3duIHByb3BlcnRpZXMgYW5kIHRoZSBraXQgaG9sZHMgdGhlbSBpbiBhblxuICogYGV4dHJhYCBiYWcsIHNvIHRoZSBjb25zdHJ1Y3RvciBiZWxvdyBhZGFwdHMgcmF0aGVyIHRoYW4gdGhlIGNhbGwgc2l0ZXNcbiAqIGNoYW5naW5nIOKAlCBhIHJlbG9jYXRpb24tc2hhcGVkIGVkaXQgYXQgNjIgc2l0ZXMgaW5zaWRlIGEgY2hhcHRlciB0aXRsZWRcbiAqIFwiYmVoYXZpb3VyIGNoYW5nZXMsIGFuZCBlYWNoIGNoYW5nZSBpcyBuYW1lZFwiIGlzIGhvdyBhIHJlYWwgY2hhbmdlIGhpZGVzLlxuICovXG5jbGFzcyBDbGlFcnJvciBleHRlbmRzIEtpdENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAga2luZDogRXJyS2luZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9LFxuICApIHtcbiAgICBzdXBlcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuY29uc3QgdXNhZ2VFcnJvciA9IChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkgPT5cbiAgbmV3IENsaUVycm9yKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuXG4vKipcbiAqIFJlcG9ydCBvbmUgb2YgdGhlIHRocmVlIFJBVyB0aHJvd3MgdGhlIGtpdCdzIGNsYXNzaWZpZXIgZG9lcyBub3QgcmVjb2duaXNlIGFzXG4gKiBhIGB1c2FnZWAgZW52ZWxvcGUsIGFuZCBoYW5kIGJhY2sgaXRzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgVEhFIENMQVNTSUZJRVIgSVMgVEhFIEhBTEYgVEhBVCBESUQgTk9UIENPTlZFUkdFLiBUaGVzZVxuICogdGhyZWUgYXJlIG5vdCBgQ2xpRXJyb3JgcyDigJQgdGhleSBhcmUgYSBgbm9kZTp1dGlsYCBwYXJzZSByZWplY3Rpb24sIGFcbiAqIGBTeW50YXhFcnJvcmAgb3V0IG9mIGBKU09OLnBhcnNlYCwgYW5kIGFuIGBFTk9FTlRgIGZyb20gYSBuYW1lZCBwYXRoIOKAlCBhbmRcbiAqIGByZXBvcnRDbGlFcnJvcmAgYW5zd2VycyBgbnVsbGAgZm9yIGFsbCB0aHJlZS4gUm91dGluZyB0aGVtIHRocm91Z2ggdGhlXG4gKiBFTlZFTE9QRSAod2hpY2ggZGlkIGNvbnZlcmdlKSBpcyB0aGUgd2hvbGUgb2YgdGhlIHJlcGFpcjogc2FtZSBieXRlcyBvblxuICogc3RkZXJyLCBzYW1lIGV4aXQgMiwgYW5kIHRoZSB0cmlhZ2Ugc3RheXMgd2hlcmUgdGhlIHNwZWxsIGNhbiBzZWUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlcG9ydFVzYWdlKG1lc3NhZ2U6IHN0cmluZyk6IG51bWJlciB7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBtZXNzYWdlKSk7XG4gIHJldHVybiBFWElUX0ZPUi51c2FnZTtcbn1cblxuLy8gVGhlIG9uZSBleGl0IGZvciBldmVyeSBkYWVtb24gcm91bmQtdHJpcDogb2sg4oaSIHRoZSBib2R5IHRleHQgKGNhbGxlciBwcmludHNcbi8vIGl0IG9uIHN0ZG91dCksIHJlZnVzZWQg4oaSIGEgdHlwZWQgQ2xpRXJyb3Igd2hvc2Uga2luZCBtYXBzIG9mZiB0aGUgSFRUUFxuLy8gc3RhdHVzIGFuZCB3aG9zZSBgc2VydmVyYCBmaWVsZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gSlNPTiBib2R5LlxuYXN5bmMgZnVuY3Rpb24gcGFzc09yVGhyb3cocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICBpZiAocmVzLm9rKSByZXR1cm4gdGV4dDtcbiAgbGV0IHNlcnZlcjogdW5rbm93biA9IHRleHQ7XG4gIHRyeSB7XG4gICAgc2VydmVyID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gZGFlbW9uIGJvZHkgcmlkZXMgYXMgdGhlIHJhdyBzdHJpbmcgKi9cbiAgfVxuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICByZXMuc3RhdHVzID09PSA0MDRcbiAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgOiByZXMuc3RhdHVzID09PSA0MDlcbiAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgOiByZXMuc3RhdHVzID09PSA0MDBcbiAgICAgICAgICA/IFwidXNhZ2VcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgYCR7Z2V0Q3VycmVudENvbW1hbmQoKSA/PyBcInJlcXVlc3RcIn0gcmVmdXNlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHtcbiAgICBzZXJ2ZXIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlRGFlbW9uKCk6IG51bWJlciB7XG4gIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICBpZiAocG9ydCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBDbGlFcnJvcihcIm5vdF9mb3VuZFwiLCBcIm5vIGRhZW1vbiBydW5uaW5nICh1c2UgYG9wZW5gIGZpcnN0KVwiKTtcbiAgfVxuICByZXR1cm4gcG9ydDtcbn1cblxuLy8gU2tlbGV0b24gcHJvamVjdGlvbiDigJQgaWRzL3RpdGxlcy9kZWdyZWUgb25seSwgbm8gc3lub3BzaXMvY29udGVudC4gS2VwdCBhc1xuLy8gYSBjbGllbnQtc2lkZSB0cmFuc2Zvcm0gKHRoZSBkYWVtb24gc3RheXMgZHVtYiBhbmQgYWx3YXlzIHNlcnZlcyB0aGUgZnVsbFxuLy8gc25hcHNob3Q7IHNrZWxldG9uIGlzIGEgY291cnRlc3kgc2hhcGUgZm9yIGNvbnRleHQtYnVkZ2V0ZWQgYWdlbnQgcmVhZHMpLlxuZnVuY3Rpb24gdG9Ta2VsZXRvbihzdGF0ZToge1xuICBub2RlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBraW5kOiBzdHJpbmc7IHRpZXI6IHN0cmluZyB9PjtcbiAgZWRnZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgc291cmNlOiBzdHJpbmc7IHRhcmdldDogc3RyaW5nIH0+O1xufSkge1xuICBjb25zdCBkZWdyZWUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2Ygc3RhdGUuZWRnZXMpIHtcbiAgICBkZWdyZWUuc2V0KGUuc291cmNlLCAoZGVncmVlLmdldChlLnNvdXJjZSkgPz8gMCkgKyAxKTtcbiAgICBkZWdyZWUuc2V0KGUudGFyZ2V0LCAoZGVncmVlLmdldChlLnRhcmdldCkgPz8gMCkgKyAxKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG5vZGVzOiBzdGF0ZS5ub2Rlcy5tYXAoKG4pID0+ICh7XG4gICAgICBpZDogbi5pZCxcbiAgICAgIHRpdGxlOiBuLnRpdGxlLFxuICAgICAga2luZDogbi5raW5kLFxuICAgICAgdGllcjogbi50aWVyLFxuICAgICAgZGVncmVlOiBkZWdyZWUuZ2V0KG4uaWQpID8/IDAsXG4gICAgfSkpLFxuICB9O1xufVxuXG4vLyDilIDilIAgdGhlIGZsYWcgcmVnaXN0cnkgKyB2ZXJiIHNwZWMgKG1hZ3BpZSdzIHR3by1zdGFnZSBwYXJzZSwgcGF0aC1leHRlbmRlZCkg4pSA4pSAXG4vL1xuLy8gVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuIFN0YWdlIDEgcGFyc2VzIGV2ZXJ5IGludm9jYXRpb25cbi8vIGFnYWluc3QgdGhpcyB3aG9sZSByZWdpc3RyeSAoc3RyaWN0KSwgc28gYSB0b2tlbiBtaW5kLW1hcHBlciBoYXMgbmV2ZXIgaGVhcmRcbi8vIG9mIGlzIHJlZnVzZWQgYnkgbm9kZTp1dGlsIHdpdGggaXRzIG93biBtZXNzYWdlOyBzdGFnZSAyIHRoZW4gYXNrcyB0aGVcbi8vIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OiBpcyB0aGlzIGZsYWcgYWNjZXB0ZWQgQVQgVEhJUyBWRVJCLiBUaGUgb3JkZXIgaXNcbi8vIHRoZSBwb2ludCDigJQgaGFuZGluZyBwYXJzZUFyZ3MgYSBwZXItdmVyYiBzdWJzZXQgd291bGQgYW5zd2VyIGBzdGF0ZSAtLXJ1bGluZ2Bcbi8vIHdpdGggXCJVbmtub3duIG9wdGlvbiAnLS1ydWxpbmcnXCIsIHdoaWNoIGlzIGZhbHNlIGFuZCBzZW5kcyBhbiBhZ2VudCBodW50aW5nIGFcbi8vIHR5cG8gaXQgZGlkIG5vdCBtYWtlLlxuLy9cbi8vIE5PIERFRkFVTFRTIGluIHRoZSByZWdpc3RyeSwgc3RydWN0dXJhbGx5OiBzdGFnZSAyIGRldGVjdHMgYSBzdHJheSBmbGFnIGJ5XG4vLyBrZXktcHJlc2VuY2UgaW4gdGhlIHBhcnNlZCB2YWx1ZXMsIGFuZCBhIHJlZ2lzdHJ5IGRlZmF1bHQgd291bGQgcGxhbnQgdGhhdFxuLy8ga2V5IG9uIGV2ZXJ5IHZlcmIuIFBlci12ZXJiIGRlZmF1bHRzIGxpdmUgYXQgdGhlIGNvbnN1bXB0aW9uIHNpdGUgKD8/IFwi4oCmXCIpLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFkZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGFuY2hvcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGF1dGhvcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJhdGNoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNoZWNrOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2xlYXI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgY3JlYXRlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZGVsaXZlcmFibGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkZXB0aDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRldGFpbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRvYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiZG9jLWVkaXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZpbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmb3JjZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICAvLyBzZW5kIC0tZ3JvdW5kIGlzIHBhcnNlQXJncy1gbXVsdGlwbGVgIEJZIFNFQU0gKENvbnRyYWN0IDkgUjQ6IHJlcGVhdHNcbiAgLy8gYWNjdW11bGF0ZSwgY29tbWFzIHNwbGl0KSDigJQgYW55IHZlcmIgY29weWluZyB0aGUgcGF0dGVybiBjb3BpZXMgdGhpcyB0b28uXG4gIGdyb3VuZDogeyB0eXBlOiBcInN0cmluZ1wiLCBtdWx0aXBsZTogdHJ1ZSB9LFxuICBpbmJvdW5kOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGtpbmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBtZXNzYWdlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbm9kZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBvd25lcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwcm9qZWN0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcm9sZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJ1bGluZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNldDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2tlbGV0b246IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3BhbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN5bm9wc2lzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0bzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHVuY2hlY2s6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB5ZXM6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgem9uZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG4vLyBXSElDSCBGTEFHUyBFQUNIIENPTU1BTkQgUEFUSCBBQ0NFUFRTIOKAlCBhbmQgdGhlIG9ubHkgc291cmNlIG9mIHRoZSB2ZXJiIHNldC5cbi8vIEtleXMgYXJlIFBBVEhTLCBub3QgYmFyZSB2ZXJiczogbWluZC1tYXBwZXIncyBncmFtbWFyIGlzIHR3by10b2tlbiBmb3IgdGhlXG4vLyBzdWItY29tbWFuZGVkIHZlcmJzICh6b25lIGNyZWF0ZSwgbm9kZSBlZGl0LCBqb2IgY2xhaW0g4oCmKSwgc28gdGhlIHNwZWNcbi8vIGV4dGVuZHMgbWFncGllJ3MgZmxhdCB0YWJsZSB3aXRoIHNwYWNlLWpvaW5lZCBwYXRocy4gYHJlc29sdmVQYXRoYCBwaWNrcyB0aGVcbi8vIHR3by10b2tlbiBrZXkgd2hlbiB0aGUgc2Vjb25kIHRva2VuIG5hbWVzIGEga25vd24gc3ViLCBlbHNlIHRoZSBvbmUtdG9rZW5cbi8vIGtleS4gVGhlIGhlbHAgdGV4dCwgdGhlIHJlamVjdGlvbnMnIGBjaG9pY2VzYCBhbmQgdGhlIHBhcnNlciBhbGwgcmVhZCB0aGlzXG4vLyBvbmUgb2JqZWN0OyBhZGRpbmcgYSBmbGFnIHRvIGEgdmVyYiBpcyBvbmUgZWRpdC5cbmV4cG9ydCBjb25zdCBWRVJCX1NQRUMgPSB7XG4gIG9wZW46IFtcIm5vLW9wZW5cIiwgXCJwb3J0XCIsIFwicHJvamVjdFwiXSxcbiAgc3RhdGU6IFtcInNrZWxldG9uXCIsIFwiYmF0Y2hcIiwgXCJwcm9qZWN0XCJdLFxuICBjaGFuZ2VzOiBbXCJzaW5jZVwiLCBcInByb2plY3RcIl0sXG4gIHRhaWw6IFtcInNpbmNlXCIsIFwiaW5ib3VuZFwiLCBcInByb2plY3RcIl0sXG4gIHByb2plY3RzOiBbXCJjcmVhdGVcIl0sXG4gIGluZ2VzdDogW1widGl0bGVcIiwgXCJmaWxlXCIsIFwic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2Utbm9kZVwiOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2UtZWRnZVwiOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2UtYmF0Y2hcIjogW1wic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICBcInJhdGlmeS1iYXRjaFwiOiBbXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gIFwiZGVsZXRlLWJhdGNoXCI6IFtcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgXCJub2RlIGFuY2hvclwiOiBbXCJ0b1wiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgXCJub2RlIGVkaXRcIjogW1widGl0bGVcIiwgXCJzeW5vcHNpc1wiLCBcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgXCJub2RlIGRlbGV0ZVwiOiBbXCJmb3JjZVwiLCBcInByb2plY3RcIl0sXG4gIHJlYWQ6IFtcInByb2plY3RcIl0sXG4gIFwiem9uZSBjcmVhdGVcIjogW1wicHJvamVjdFwiXSxcbiAgXCJ6b25lIGxpc3RcIjogW1wicHJvamVjdFwiXSxcbiAgXCJ6b25lIGRlbGV0ZVwiOiBbXCJ5ZXNcIiwgXCJwcm9qZWN0XCJdLFxuICBwcm9tb3RlOiBbXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2FsIHpvbmVcIjogW1widG9cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIFwicHJvcG9zYWwgZGVsZXRlXCI6IFtcInByb2plY3RcIl0sXG4gIGRvYzogW1wicHJvamVjdFwiXSxcbiAgXCJkb2MgZGVsZXRlXCI6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgXCJkb2Mga2luZFwiOiBbXCJhdXRob3JcIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIG1hcms6IFtcInN0YXR1c1wiLCBcIm5vdGVcIiwgXCJhdXRob3JcIiwgXCJwcm9qZWN0XCJdLFxuICBzZWFyY2g6IFtcInByb2plY3RcIl0sXG4gIG5laWdoYm9yczogW1wiZGVwdGhcIiwgXCJwcm9qZWN0XCJdLFxuICByYXRpZnk6IFtcInJ1bGluZ1wiLCBcImRvYy1lZGl0XCIsIFwiZG9jXCIsIFwic3BhblwiLCBcImFuY2hvclwiLCBcInByb2plY3RcIl0sXG4gIFwibGVucyBzZXRcIjogW1wibm9kZVwiLCBcImRvY1wiLCBcImRlcHRoXCIsIFwib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICBcImxlbnMgY2xlYXJcIjogW1wicHJvamVjdFwiXSxcbiAgXCJsb29rLWhlcmVcIjogW1wicHJvamVjdFwiXSxcbiAgYWN0aW9uczogW1wic2V0XCIsIFwic3RkaW5cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIHRhZ3M6IFtcInNldFwiLCBcInN0ZGluXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICBcImpvYiBjcmVhdGVcIjogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgXCJqb2IgdXBkYXRlXCI6IFtcInRpdGxlXCIsIFwic3RhdHVzXCIsIFwiZGVsaXZlcmFibGVcIiwgXCJkZXRhaWxcIiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiLCBcInByb2plY3RcIl0sXG4gIFwiam9iIGNsYWltXCI6IFtcIm93bmVyXCIsIFwicHJvamVjdFwiXSxcbiAgXCJqb2IgcmVsZWFzZVwiOiBbXCJwcm9qZWN0XCJdLFxuICBcImpvYiBzdWJ0YXNrXCI6IFtcImFkZFwiLCBcImNoZWNrXCIsIFwidW5jaGVja1wiLCBcInByb2plY3RcIl0sXG4gIFwiam9iIGxpc3RcIjogW1wicHJvamVjdFwiXSxcbiAgXCJqb2IgZGVsZXRlXCI6IFtcInByb2plY3RcIl0sXG4gIGFjdGl2aXR5OiBbXCJtZXNzYWdlXCIsIFwicHJvamVjdFwiXSxcbiAgc2VuZDogW1wicm9sZVwiLCBcImtpbmRcIiwgXCJncm91bmRcIiwgXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgaGVscDogW10sXG59IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSAoa2V5b2YgdHlwZW9mIENMSV9PUFRJT05TKVtdPjtcblxudHlwZSBWZXJiUGF0aCA9IGtleW9mIHR5cGVvZiBWRVJCX1NQRUM7XG5cbi8vIGBtZXNzYWdlYCBpcyBhbiBhZHZlcnRpc2VkIEFMSUFTIG9mIGByZWFkYCAob25lIG1lc3NhZ2UtZmV0Y2ggdmVyYiwgdHdvXG4vLyBzcGVsbGluZ3MpIOKAlCBhbiBhbGlhcyBtYXBzIG9udG8gaXRzIHRhcmdldCdzIHBhdGggYW5kIG5ldmVyIGdldHMgaXRzIG93blxuLy8gc3BlYyByb3csIHNvIHRoZSB0d28gY2FuIG5vdCBkcmlmdCBhcGFydC5cbmV4cG9ydCBjb25zdCBWRVJCX0FMSUFTRVM6IFJlY29yZDxzdHJpbmcsIFZlcmJQYXRoPiA9IHsgbWVzc2FnZTogXCJyZWFkXCIgfTtcblxuLy8gVGhlIGFkdmVydGlzZWQgdmVyYiByb3N0ZXIsIERFUklWRUQ6IHRvcC1sZXZlbCB0b2tlbnMgb2YgdGhlIHNwZWMgcGF0aHMuXG5leHBvcnQgY29uc3QgVkVSQlMgPSBbLi4ubmV3IFNldChPYmplY3Qua2V5cyhWRVJCX1NQRUMpLm1hcCgocCkgPT4gcC5zcGxpdChcIiBcIilbMF0gYXMgc3RyaW5nKSldO1xuXG4vLyBQYXRocyB3aG9zZSBncmFtbWFyIHRha2VzIE5PIGZyZWUgcG9zaXRpb25hbHMgKGV2ZXJ5dGhpbmcgdGhleSBuZWVkIHJpZGVzXG4vLyBmbGFncyk7IHN0YWdlIDIgcmVmdXNlcyBhIHN0cmF5IHRva2VuIGJ5IG5hbWUgaW5zdGVhZCBvZiBzaWxlbnRseVxuLy8gZHJvcHBpbmcgaXQuIEV2ZXJ5IG90aGVyIHBhdGggY29uc3VtZXMgcG9zaXRpb25hbHMgKGlkcywgcXVlcmllcywgcHJvc2UpLlxuY29uc3QgTk9fUE9TSVRJT05BTFM6IFJlYWRvbmx5U2V0PFZlcmJQYXRoPiA9IG5ldyBTZXQoW1xuICBcIm9wZW5cIixcbiAgXCJzdGF0ZVwiLFxuICBcImNoYW5nZXNcIixcbiAgXCJ0YWlsXCIsXG4gIFwiaW5nZXN0XCIsXG4gIFwicHJvcG9zZS1ub2RlXCIsXG4gIFwicHJvcG9zZS1lZGdlXCIsXG4gIFwicHJvcG9zZS1iYXRjaFwiLFxuICBcInJhdGlmeS1iYXRjaFwiLFxuICBcImRlbGV0ZS1iYXRjaFwiLFxuICBcImxlbnMgc2V0XCIsXG4gIFwibGVucyBjbGVhclwiLFxuICBcImhlbHBcIixcbl0gYXMgVmVyYlBhdGhbXSk7XG5cbmNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IFZlcmJQYXRoKTogc3RyaW5nW10gPT4gVkVSQl9TUEVDW3BhdGhdLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuY29uc3Qgc3Vic09mID0gKHZlcmI6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gIE9iamVjdC5rZXlzKFZFUkJfU1BFQylcbiAgICAuZmlsdGVyKChwKSA9PiBwLnN0YXJ0c1dpdGgoYCR7dmVyYn0gYCkpXG4gICAgLm1hcCgocCkgPT4gcC5zbGljZSh2ZXJiLmxlbmd0aCArIDEpKTtcblxuLy8gVFdPIFNUQUdFUywgQU5EIFRIRSBPUkRFUiBJUyBUSEUgUE9JTlQgKHNlZSB0aGUgcmVnaXN0cnkgaGVhZGVyKS4gQWxzbyBzZXRzXG4vLyBtZXRhLmNvbW1hbmQgdG8gdGhlIFJFU09MVkVEIHBhdGggc28gYW4gZW52ZWxvcGUgZnJvbSBgbm9kZSBlZGl0YCBzYXlzIHNvLlxuZnVuY3Rpb24gcGFyc2VWZXJiQXJncyhwYXRoOiBWZXJiUGF0aCwgYXJnczogc3RyaW5nW10pIHtcbiAgc2V0Q3VycmVudENvbW1hbmQocGF0aCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgYXJncyxcbiAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICBzdHJpY3Q6IHRydWUsXG4gICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgfSk7XG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oVkVSQl9TUEVDW3BhdGhdKTtcbiAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyhwYXJzZWQudmFsdWVzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7cGF0aH1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBtaW5kLW1hcHBlciBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgeyBjaG9pY2VzOiBmbGFnc0ZvcihwYXRoKSB9LFxuICAgICk7XG4gIH1cbiAgaWYgKE5PX1BPU0lUSU9OQUxTLmhhcyhwYXRoKSAmJiBwYXJzZWQucG9zaXRpb25hbHMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBgJHtwYXRofSB0YWtlcyBubyBwb3NpdGlvbmFsIGFyZ3VtZW50cyAoZ290IFwiJHtwYXJzZWQucG9zaXRpb25hbHNbMF19XCIpYCxcbiAgICAgIFZFUkJfU1BFQ1twYXRoXS5sZW5ndGggPiAwID8geyBjaG9pY2VzOiBmbGFnc0ZvcihwYXRoKSB9IDogdW5kZWZpbmVkLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHBhcnNlZDtcbn1cblxuY29uc3QgSEVMUCA9IGBtaW5kLW1hcHBlciDigJQgYSBjby1wcmVzZW50IGtub3dsZWRnZSBtYXA6IGEgZHVtYiBkYWVtb24gaG9sZHMgdGhlIGdyYXBoLCB0aGUgY2FzdGluZyBhZ2VudCBkb2VzIHRoZSB0aGlua2luZy5cblxuICBvcGVuICAgWy0tcHJvamVjdCA8aWQ+XSBbLS1wb3J0IDxuPl0gWy0tbm8tb3Blbl0gICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybFxuICBzdGF0ZSAgWy0tc2tlbGV0b25dIFstLWJhdGNoIDxpZD5dICAgICAgICAgICAgICAgICB0aGUgcHJvamVjdCBzbmFwc2hvdCAoc2tlbGV0b24gPSBpZHMvdGl0bGVzL2RlZ3JlZSlcbiAgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+ICAgICAgICAgICAgICAgICAgICAgYm91bmRlZCBkZWx0YSwgQURESVRJT05TIE9OTFkgKG5vdENvdmVyZWQgbmFtZXMgdGhlIHJlc3QpXG4gIHRhaWwgICBbLS1zaW5jZSBOXSBbLS1pbmJvdW5kXSAgICAgICAgICAgICAgICAgICAgIFNTRSBldmVudHMgYXMgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yKVxuICBwcm9qZWN0cyBbLS1jcmVhdGUgPHRpdGxlPl0gICAgICAgICAgICAgICAgICAgICAgICBsaXN0IHByb2plY3RzIC8gY3JlYXRlIG9uZVxuICBpbmdlc3QgLS10aXRsZSA8dD4gKC0tZmlsZSA8cD4gfCAtLXN0ZGluKSAgICAgICAgICBhZGQgYSBkb2NcbiAgcHJvcG9zZS1ub2RlIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3RhZ2UgYSBub2RlIHByb3Bvc2FsIChKU09OIHtkcmFmdCwgZXZpZGVuY2UsIC4uLn0pXG4gIHByb3Bvc2UtZWRnZSAtLXN0ZGluIFstLXpvbmUgPGlkPl0gICAgICAgICAgICAgICAgIHN0YWdlIGFuIGVkZ2UgcHJvcG9zYWxcbiAgcHJvcG9zZS1iYXRjaCAtLXN0ZGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3RhZ2UgYSBzZXQgaW4gb25lIHR4biAoe25vZGVzLCBlZGdlc30pXG4gIHJhdGlmeS1iYXRjaCAtLXN0ZGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdGlmeSBhIHNldCBpbiBvbmUgdHhuICh7cnVsaW5nLCBpZHMsIGFuY2hvcnM/fSlcbiAgZGVsZXRlLWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGEgcHJvcG9zYWwgc2V0IGluIG9uZSB0eG4gKHtpZHN9LCBhbGwtb3Itbm90aGluZylcbiAgcmF0aWZ5IDxpZD4gLS1ydWxpbmcgPHI+IFstLWRvYy1lZGl0IDxmaWxlPl0gWy0tZG9jIDxkb2NJZD4gLS1zcGFuIDx0Pl0gWy0tYW5jaG9yIDxwYXJlbnRJZD5dXG4gIHpvbmUgICBjcmVhdGUgPG5hbWU+IHwgbGlzdCB8IGRlbGV0ZSA8aWQ+IFstLXllc10gIHN0YWdpbmcgcGVucyBmb3IgcHJvcG9zYWxzXG4gIHByb21vdGUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1vdmUgYSB6b25lZCBwcm9wb3NhbCB0byB0aGUgbWFpbiBxdWV1ZVxuICBwcm9wb3NhbCB6b25lIDxpZD4gKC0tdG8gPHo+IHwgLS1jbGVhcikgfCBwcm9wb3NhbCBkZWxldGUgPGlkPlxuICBub2RlICAgYW5jaG9yIDxpZD4gKC0tdG8gPHA+IHwgLS1jbGVhcikgfCBlZGl0IDxpZD4gWy0tdGl0bGUvLS1zeW5vcHNpcy8tLXN0ZGluXSB8IGRlbGV0ZSA8aWQ+IFstLWZvcmNlXVxuICBkb2MgICAgPGlkPiB8IGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSB8IGtpbmQgPGRvY0lkPiAoPGtpbmQ+IFstLWF1dGhvciBhXSB8IC0tY2xlYXIpXG4gIG1hcmsgICA8ZG9jSWQ+IC0tc3RhdHVzIDxzPiBbLS1ub3RlIDx0Pl0gICAgICAgICAgIGFwcGVuZCBhIGRvYyBzdGF0dXMgbWFya1xuICBhY3Rpb25zIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgIGFjdGlvbiBzbG90cyBvbiBhIG5vZGUvcGVuZGluZyBwcm9wb3NhbFxuICB0YWdzICAgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpICAgIGZyZWVmb3JtIHRhZ3MsIHNhbWUgdGFyZ2V0c1xuICBqb2IgICAgY3JlYXRlfHVwZGF0ZXxjbGFpbXxyZWxlYXNlfHN1YnRhc2t8bGlzdHxkZWxldGUgIHBlcnNpc3RlZCB1bml0cyBvZiBhZ2VudCB3b3JrXG4gIHNlYXJjaCA8cXVlcnkuLi4+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEZUUyBvdmVyIG5vZGVzLCBkb2NzLCBtZXNzYWdlc1xuICBuZWlnaGJvcnMgPGlkPiBbLS1kZXB0aCAxXSAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbCBob29kICsgZWRnZSByZWFzb25zXG4gIGxlbnMgICBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGlkPikgfCBsZW5zIGNsZWFyXG4gIGxvb2staGVyZSA8bm9kZUlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpcmUtb25jZSBhdHRlbnRpb24gbnVkZ2VcbiAgcmVhZCAgIDxtZXNzYWdlSWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25lIGZ1bGwgbWVzc2FnZSByb3cgKGFsaWFzOiBtZXNzYWdlIDxpZD4pXG4gIHNlbmQgICA8dGV4dC4uLj4gfCAtLWJvZHktZmlsZSA8cD4gfCAtLXN0ZGluICAgICAgIHBvc3QgYSBtZXNzYWdlIChbLS1yb2xlXSBbLS1raW5kXSBbLS1ncm91bmRdKVxuICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gWy0tbWVzc2FnZSA8aWQ+XSB0aGUgY2FzdGluZy1sb29wIGxpdmVuZXNzIHNpZ25hbFxuICBoZWxwIHwgLS12ZXJzaW9uXG5cbiAgLS1wcm9qZWN0IDxpZD4gaXMgYWNjZXB0ZWQgYnkgZXZlcnkgdmVyYiBleGNlcHQgb3BlbidzIHNwYXduLXRpbWUgZmxhZ3M7IG9taXQgZm9yIHRoZSBkZWZhdWx0IHByb2plY3QuXG5cbiAgT3V0cHV0OiBldmVyeSB2ZXJiIHByaW50cyBKU09OIG9uIHN0ZG91dCBieSBkZWZhdWx0LCBvbmUgZG9jdW1lbnQgcGVyIGFuc3dlciDigJRcbiAgZXhjZXB0IHRhaWwsIGEgc3RyZWFtIHRoYXQgcHJpbnRzIG9uZSBKU09OIGxpbmUgcGVyIGV2ZW50LiBQcm9zZSwgd2FybmluZ3MgYW5kXG4gIGRpYWdub3N0aWNzIGdvIHRvIHN0ZGVycjsgZmFpbHVyZXMgZXhpdCBub24temVybyAoMiA9IHVzYWdlKS5gO1xuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyIChhc3Ryb2xhYmUncyBwYXR0ZXJuKS4gTGF5b3V0LWRlcGVuZGVudCwgc28gYWJzZW5jZVxuLy8gZGVncmFkZXMgdG8gXCJ1bmtub3duXCIgaW5zdGVhZCBvZiBpbnZlbnRpbmcgb25lLlxuZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoXG4gICAgICBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSxcbiAgICAgIFwidXRmOFwiLFxuICAgICk7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcbiAgICBpZiAodHlwZW9mIHBrZy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSByZXR1cm4geyBuYW1lOiBcIm1pbmQtbWFwcGVyXCIsIHZlcnNpb246IHBrZy52ZXJzaW9uIH07XG4gIH0gY2F0Y2gge1xuICAgIC8qIGZhbGwgdGhyb3VnaCB0byB1bmtub3duICovXG4gIH1cbiAgcmV0dXJuIHsgbmFtZTogXCJtaW5kLW1hcHBlclwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vLyBwYXJzZUFyZ3MgdGhyb3dzIChFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTiBldGMuKSBvbiBhbiB1bnJlY29nbml6ZWRcbi8vIGZsYWcgbGlrZSBhIHN0cmF5IC0taGVscCDigJQgdW5jYXVnaHQsIHRoYXQncyBhIHN0YWNrLXRyYWNlIGNyYXNoIGluc3RlYWQgb2Zcbi8vIGEgdXNhZ2UgbWVzc2FnZSAoY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nKS4gRXZlcnkgdmVyYidzIHBhcnNlQXJncyBjYWxsXG4vLyBmdW5uZWxzIHRocm91Z2ggaGVyZSBzbyBhIGJhZCBmbGFnIGFsd2F5cyBleGl0cyAyIHdpdGggYSBvbmUtbGluZSBlcnJvci5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIOKblCBUSEUgS0lUJ1MgUkVQT1JURVIgU0lUUyBJTlNJREUgVEhJUyBDSEFJTiwgTk9UIElOIFBMQUNFIE9GIElULiBJdFxuICAgIC8vIHdyaXRlcyB0aGUgZW52ZWxvcGUgYW5kIGhhbmRzIGJhY2sgdGhlIHRheG9ub215IGNvZGUgZm9yIGEgdHlwZWQgZmFpbHVyZSxcbiAgICAvLyBhbmQgcmV0dXJucyBgbnVsbGAgZm9yIGV2ZXJ5dGhpbmcgZWxzZSDigJQgc28gdGhlIHRocmVlIHVzYWdlIGNsYXNzZXMgYmVsb3dcbiAgICAvLyBhcmUgc3RpbGwgY2xhc3NpZmllZCBIRVJFLiBSZXBsYWNpbmcgdGhlIGNoYWluIHdpdGggYSBiYXJlXG4gICAgLy8gYHJlcG9ydENsaUVycm9yKGUpID8/IHJldGhyb3dgIHdvdWxkIHR1cm4gYSBzdHJheSBmbGFnLCBhIG1hbGZvcm1lZCBKU09OXG4gICAgLy8gYm9keSBhbmQgYSBtaXNzaW5nIGZpbGUgaW50byBzdGFjay10cmFjZSBjcmFzaGVzLlxuICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgY29uc3QgY29kZSA9XG4gICAgICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbiAgICBjb25zdCBtc2cgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgLy8gQSBzdHJheS91bmtub3duIGZsYWcgKG5vZGU6dXRpbCBzdHJpY3QpIGlzIHRoZSBDQUxMRVIncyB0byBmaXguXG4gICAgaWYgKGNvZGUuc3RhcnRzV2l0aChcIkVSUl9QQVJTRV9BUkdTXCIpKSByZXR1cm4gcmVwb3J0VXNhZ2UobXNnKTtcbiAgICAvLyBBIGJvZHkgdGhhdCBmYWlsZWQgdG8gcGFyc2UgKHN0ZGluLy0tYm9keS1maWxlIEpTT04pIOKAlCBhbHNvIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoZSBpbnN0YW5jZW9mIFN5bnRheEVycm9yKSByZXR1cm4gcmVwb3J0VXNhZ2UoYGludmFsaWQgSlNPTjogJHttc2d9YCk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUvLS1kb2MtZWRpdCBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydFVzYWdlKG1zZyk7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGZhdWx0OiBvbmUgSU5URVJOQUwgZW52ZWxvcGUsIG5ldmVyXG4gICAgLy8gYSBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcImludGVybmFsXCIsIG1zZykpO1xuICAgIHJldHVybiBFWElUX0ZPUi5pbnRlcm5hbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHZlcmIgPSBhcmd2WzBdO1xuICBjb25zdCByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgLy8gVGhlIGVudmVsb3BlIG5hbWVzIHRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiAobWV0YS5jb21tYW5kKTsgcm9vdCB0b2tlbnNcbiAgLy8gYW5kIHRoZSBmYWxsdGhyb3VnaCBsZWF2ZSBpdCBhcyB0aGUgcmF3IGZpcnN0IHRva2VuLCB3aGljaCBpcyB0aGUgaG9uZXN0XG4gIC8vIGFuc3dlciB0byBcIndoYXQgd2FzIGJlaW5nIHJ1biB3aGVuIHRoaXMgZmFpbGVkXCIuIFRoZSBraXQgb3ducyB0aGUgdmFyaWFibGVcbiAgLy8gbm93IOKAlCBvbmUgbW9kdWxlLCBvbmUgYG1ldGEuY29tbWFuZGAuXG4gIHNldEN1cnJlbnRDb21tYW5kKHZlcmIgPz8gbnVsbCk7XG5cbiAgLy8gUk9PVCBUT0tFTlMgRklSU1QsIGJlZm9yZSBhbnkgZmxhZyBwYXJzaW5nIChtYWdwaWUvYXN0cm9sYWJlIHBhdHRlcm4pLlxuICAvLyAtLWhlbHAvLWggcmVzb2x2ZSBhdCB0aGUgcm9vdDsgYGhlbHBgIGlzIEFMU08gYSBkaXNwYXRjaGFibGUgdmVyYiBiZWxvdywgc29cbiAgLy8gYGhlbHAgLS1mb29gIGlzIGEgcmVqZWN0ZWQgZmxhZywgbm90IGEgc2lsZW50bHktdG9sZXJhdGVkIG9uZS5cbiAgaWYgKHZlcmIgPT09IFwiLS1oZWxwXCIgfHwgdmVyYiA9PT0gXCItaFwiKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICAvLyBSb290IFRPS0VOLCBkZWxpYmVyYXRlbHkgTk9UIGEgZmxhZzogbm8gcGVyLXZlcmIgcGFyc2VyIGJlbG93IHRoZSByb290IGlzXG4gIC8vIGV2ZXIgZXhwZWN0ZWQgdG8gYWNjZXB0IGl0LCBhbmQgaXQgY2FycmllcyBubyBmbGFncyBvZiBpdHMgb3duLlxuICBpZiAodmVyYiA9PT0gXCItLXZlcnNpb25cIiB8fCB2ZXJiID09PSBcIi1WXCIgfHwgdmVyYiA9PT0gXCJ2ZXJzaW9uXCIpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh2ZXJzaW9uSW5mbygpKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBpZiAodmVyYiA9PT0gXCJoZWxwXCIpIHtcbiAgICAvLyBEaXNwYXRjaGFibGUgdmVyYiB3aXRoIGFuIEVNUFRZIGZsYWcgc2V0IOKAlCBhIHN0cmljdCBwYXJzZSBvZiB0aGUgcmVzdFxuICAgIC8vIG1lYW5zIGBoZWxwIC0tZm9vYCBpcyByZWZ1c2VkIGluc3RlYWQgb2YgaWdub3JlZC5cbiAgICBwYXJzZVZlcmJBcmdzKFwiaGVscFwiLCByZXN0KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwib3BlblwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcIm9wZW5cIiwgcmVzdCk7XG4gICAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbihwYXJzZWQudmFsdWVzLnBvcnQpO1xuICAgIC8vIC0tcHJvamVjdCBzY29wZXMgdGhlIHByaW50ZWQgVVJMICsgc3Bhd25lZCBicm93c2VyICg/cHJvamVjdD0gcmlkZXNcbiAgICAvLyBhbG9uZykuIE9wZW4gbmV2ZXIgbWludHM6IGFuIHVua25vd24gaWQgaXMgYSB1c2FnZSBlcnJvciBwb2ludGluZyBhdFxuICAgIC8vIGBwcm9qZWN0cyAtLWNyZWF0ZWAsIG5vdCBhIHNpbGVudCBuZXcgc3RvcmUuXG4gICAgY29uc3QgcHJvamVjdCA9IHBhcnNlZC52YWx1ZXMucHJvamVjdDtcbiAgICBpZiAocHJvamVjdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb2plY3RzYCk7XG4gICAgICBjb25zdCBib2R5ID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgICAgaWYgKCFib2R5LnByb2plY3RzLnNvbWUoKHApID0+IHAuaWQgPT09IHByb2plY3QpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgYHVua25vd24gcHJvamVjdDogJHtwcm9qZWN0fSAob3BlbiBuZXZlciBjcmVhdGVzIG9uZSDigJQgdXNlIFxcYHByb2plY3RzIC0tY3JlYXRlIDx0aXRsZT5cXGAgZmlyc3QpYCxcbiAgICAgICAgICB7IGNob2ljZXM6IGJvZHkucHJvamVjdHMubWFwKChwKSA9PiBwLmlkKSB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwcm9qZWN0ID8gYC8/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwcm9qZWN0KX1gIDogXCJcIn1gO1xuICAgIGlmICghcGFyc2VkLnZhbHVlc1tcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgdXJsIH0pfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwic3RhdGVcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJzdGF0ZVwiLCByZXN0KTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLmJhdGNoKSBwYXJhbXMuc2V0KFwiYmF0Y2hcIiwgcGFyc2VkLnZhbHVlcy5iYXRjaCk7XG4gICAgY29uc3QgcXMgPSBwYXJhbXMuc2l6ZSA+IDAgPyBgPyR7cGFyYW1zfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3RhdGUke3FzfWApO1xuICAgIC8vIEEgbm9uLW9rIC9zdGF0ZSAoNDA5IG5lZWRzLXByb2plY3Qgb24gYSBmcmVzaCBzdG9yZSwgNDA0IHVua25vd25cbiAgICAvLyBwcm9qZWN0KSByaWRlcyB0aGUgZXJyb3IgZW52ZWxvcGUgd2l0aCB0aGUgZGFlbW9uIGJvZHkgdW5kZXJcbiAgICAvLyBlcnJvci5zZXJ2ZXIg4oCUIHRoZSBza2VsZXRvbiB0cmFuc2Zvcm0gb25seSBydW5zIG9uIGEgcmVhbCBzbmFwc2hvdC5cbiAgICBjb25zdCBzdGF0ZVRleHQgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLnNrZWxldG9uKSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGVUZXh0KSBhcyBQYXJhbWV0ZXJzPHR5cGVvZiB0b1NrZWxldG9uPlswXTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHRvU2tlbGV0b24oc3RhdGUpKX1cXG5gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7c3RhdGVUZXh0fVxcbmApO1xuICAgIH1cbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFJvdW5kIDEyIChTRUFNIDMpOiBgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+YCDigJQgdGhlIGJvdW5kZWQgZGVsdGEuXG4gIC8vIFJlYWQgdGhlIHJlc3BvbnNlJ3Mgbm90Q292ZXJlZCBiZWZvcmUgdHJ1c3RpbmcgYW4gZW1wdHkgb25lOiBcIm5vdGhpbmdcbiAgLy8gYWRkZWRcIiBpcyBOT1QgXCJub3RoaW5nIGNoYW5nZWRcIiAoZGVsZXRpb25zLCByZWplY3Rpb25zIGFuZCBpbi1wbGFjZSBlZGl0c1xuICAvLyBhcmUgaW52aXNpYmxlIGhlcmUgYnkgY29uc3RydWN0aW9uKS5cbiAgaWYgKHZlcmIgPT09IFwiY2hhbmdlc1wiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImNoYW5nZXNcIiwgcmVzdCk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuc2luY2UgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJjaGFuZ2VzIHJlcXVpcmVzIC0tc2luY2UgPGVwb2NoU2Vjb25kcz4gKHVzZSAwIGZvciBldmVyeXRoaW5nLCB0aGVuIHBhc3MgYmFjayB0aGUgYG5vd2AgZnJvbSB0aGUgcHJldmlvdXMgcmVzcG9uc2UpXCIsXG4gICAgICAgIHtcbiAgICAgICAgICBoaW50OiBcIkFERElUSU9OUyBPTkxZIOKAlCB0aGUgcmVzcG9uc2UncyBub3RDb3ZlcmVkIG5hbWVzIHdoYXQgaXQgY2Fubm90IHNlZTsgYSBmdWxsIGBzdGF0ZWAgcmVhZCBpcyBzdGlsbCB0aGUgb25seSB3YXkgdG8gcmVjb25jaWxlIGRlbGV0aW9ucywgcmVqZWN0aW9ucyBhbmQgaW4tcGxhY2UgZWRpdHNcIixcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7IHNpbmNlOiBwYXJzZWQudmFsdWVzLnNpbmNlIH0pO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFuZ2VzPyR7cGFyYW1zfWApO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJ0YWlsXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwidGFpbFwiLCByZXN0KTtcbiAgICBjb25zdCBpbmJvdW5kID0gcGFyc2VkLnZhbHVlcy5pbmJvdW5kID09PSB0cnVlO1xuICAgIHJlcXVpcmVEYWVtb24oKTsgLy8gbm8gZGFlbW9uIGF0IHN0YXJ0IGlzIGEgdXNhZ2UgZXJyb3I7IG1pZC10YWlsIGRlYXRoIGlzIHNlbGYtaGVhbGVkIGJlbG93XG4gICAgY29uc3Qgc2luY2UgPSBOdW1iZXIucGFyc2VJbnQocGFyc2VkLnZhbHVlcy5zaW5jZSBhcyBzdHJpbmcsIDEwKTtcbiAgICAvLyBUaGUgc2VydmVyIChyZS0pZW1pdHMgYSBncm91bmRpbmcgZnJhbWUgYXQgdGhlIHRvcCBvZiBFVkVSWSBpbmJvdW5kIFNTRVxuICAgIC8vIGNvbm5lY3Q7IGZvcndhcmQgb25seSB0aGUgRklSU1Qgc28gdGhlIGFnZW50J3MgTW9uaXRvciBzZWVzIGV4YWN0bHkgb25lXG4gICAgLy8gZ3JvdW5kaW5nIGxpbmUsIG5vdCBvbmUgcGVyIHJlY29ubmVjdCAoRjU6IGZpcnN0LWNvbm5lY3QgbGluZSkuXG4gICAgLy9cbiAgICAvLyDim5QgVEhFIFNVUFBSRVNTSU9OJ1MgU1RBVEUgTElWRVMgSU4gVEhJUyBDTE9TVVJFLCBPVVRTSURFIFRIRSBUSElORyBUSEFUXG4gICAgLy8gT1dOUyBUSEUgUkVDT05ORUNUUywgQU5EIFRIQVQgSVMgVEhFIE9ORSBIT05FU1QgR0FQIElOIFRISVMgQURPUFRJT04uXG4gICAgLy8gYHJlbmRlcmAgaXMgYSBjYWxsZXItd3JpdHRlbiBjbG9zdXJlLCBzbyBgZ3JvdW5kZWRgIHN1cnZpdmVzIHRoZVxuICAgIC8vIHJlY29ubmVjdHMgYHRhaWxFdmVudHNgIHBlcmZvcm1zIOKAlCB3aGljaCBpcyBleGFjdGx5IHdoeSBpdCBXT1JLUywgYW5kIGFsc29cbiAgICAvLyB3aHkgbm90aGluZyBpbiB0aGUga2l0IGd1YXJhbnRlZXMgaXQ6IHRoZXJlIGlzIG5vIGRlZGljYXRlZFxuICAgIC8vIGZpcnN0LWZyYW1lLW9uY2UgYWZmb3JkYW5jZSBhbmQgbm8gd29ya2VkIGV4YW1wbGUgb2Ygb25lLCBhbmQgYSBmdXR1cmVcbiAgICAvLyBjaGFuZ2UgdG8gd2hlbiBgdGFpbEV2ZW50c2AgcmUtaW52b2tlcyBpdHMgaG9va3Mgd291bGQgbW92ZSB0aGlzXG4gICAgLy8gYmVoYXZpb3VyIHdpdGhvdXQgdG91Y2hpbmcgdGhpcyBmaWxlLiBUaGUgYWx0ZXJuYXRpdmUgd2FzIGFza2luZyB0aGUga2l0XG4gICAgLy8gZm9yIGEgYGZpcnN0RnJhbWVPbmNlYCBvcHRpb24sIHdoaWNoIGlzIGEgd2lkZW5pbmcgZm9yIGEgY2xvc3VyZSB0aGVcbiAgICAvLyBjYWxsZXIgY2FuIHdyaXRlIGluIHRocmVlIGxpbmVzIChEODIncyBub3QtdGFrZW4pLlxuICAgIGxldCBncm91bmRlZCA9IGZhbHNlO1xuXG4gICAgLy8g4puUIE9ORSBDQUxMIElOVE8gVEhFIEhPVVNFJ1MgU0hBUkVEIFRBSUwgQ0xJRU5UXG4gICAgLy8gKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLCBSRVBMQUNJTkcgQSBIQU5ELVJPTExFRFxuICAgIC8vIFRIUkVFLUxFVkVMIExPT1Ag4oCUIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGwgdGhhdCBtb2R1bGUncyBvd25cbiAgICAvLyBjb25zdGFudC1iYWNrb2ZmIHdhcm5pbmcgd2FzIHdyaXR0ZW4gYWJvdXQ6IHRoZSBsb29wIGJlbG93IHVzZWQgdG8gc2xlZXBcbiAgICAvLyBgcmV0cnlNc2AgYWZ0ZXIgRVZFUlkgZmFpbGVkIGF0dGVtcHQsIGZsYXQsIGZvcmV2ZXIsIHdoaWNoIGlzIGFcbiAgICAvLyByZWNvbm5lY3Qgc3Rvcm0gcmF0aGVyIHRoYW4gYSBiYWNrb2ZmLiBXaGF0IHRoZSBzd2FwIGNsb3NlcyBoZXJlLCBub25lIG9mXG4gICAgLy8gaXQgYnkgYW55b25lIGVkaXRpbmcgaXQ6XG4gICAgLy9cbiAgICAvLyAgIMK3IEJBQ0tPRkYuIDEsMDAwIG1zIGZsYXQgYmVjb21lcyAxLDAwMCDCtyAyLDAwMCDCtyA0LDAwMCDCtyA1LDAwMCDCtyA1LDAwMCxcbiAgICAvLyAgICAgcmVzZXQgb24gYSBzdWNjZXNzZnVsIG9wZW4uIERyaXZlbiBvbiBnbGFtb3VyIGJlZm9yZSBhbmQgYWZ0ZXJcbiAgICAvLyAgICAgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGRyb3BzOiA1MSBhdHRlbXB0cyBpblxuICAgIC8vICAgICAxNCBzIGF0IGEgZmxhdCB+MjUyIG1zIGJlY2FtZSA2IGF0dGVtcHRzIGF0IDI1MiDCtyA1MDMgwrcgMTAwMSDCtyAyMDAyIMK3XG4gICAgLy8gICAgIDQwMDIuXG4gICAgLy8gICDCtyBUSEUgU1BFQy4gVGhlIGhhbmQtcm9sbGVkIGZyYW1lIHBhcnNlciBtYXRjaGVkIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYFxuICAgIC8vICAgICBhbmQga2VwdCBvbmx5IHRoZSBGSVJTVCBkYXRhIGxpbmUsIHNvIGEgc3BlYy1sZWdhbCBgZGF0YTp7Li4ufWAgd2FzXG4gICAgLy8gICAgIHNpbGVudGx5IERST1BQRUQgKiphbmQgdGhlIGN1cnNvciBkaWQgbm90IGFkdmFuY2UqKiDigJQgYSBmcmFtZSBub2JvZHlcbiAgICAvLyAgICAgY2FuIHJlYWQgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAgLy8gICAgIFRoZSBraXQgc3BsaXRzIGF0IHRoZSBmaXJzdCBjb2xvbiBhbmQgc3RyaXBzIGF0IG1vc3Qgb25lIHNwYWNlLCBwZXJcbiAgICAvLyAgICAgV0hBVFdHLCB3aGljaCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aCBldmVyeSBob3VzZVxuICAgIC8vICAgICBkYWVtb24uXG4gICAgLy8gICDCtyBUSEUgU0lHTkFMIEhBTkRMRVJTLiBUaGVyZSB3ZXJlIG5vbmUuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhXG4gICAgLy8gICAgIHJlYWRlciBub3cgZW5kcyB0aGUgd2F0Y2ggYnkgUkVUVVJOSU5HLCBzbyB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0XG4gICAgLy8gICAgIGZpcnN0IOKAlCB0aGUgaGFsZiBvZiB0aGUgUDBmIGRyYWluIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgIC8vICAgwrcgVEhFIEVYSVQgQ09ERSBDUk9TU0VTIFRIRSBMT09QUy4gVGhlIGNsaWVudCBSRVRVUk5TIGEgY29kZSBpbnN0ZWFkIG9mXG4gICAgLy8gICAgIGVuZGluZyB0aGUgcHJvY2VzcyBmcm9tIGluc2lkZSB0aHJlZSBuZXN0ZWQgbG9vcHMsIHdoaWNoIGlzIHdoYXRcbiAgICAvLyAgICAgcmV0aXJlcyB0aGUgcGVyLXNpdGUgcXVlc3Rpb24gb2Ygd2hldGhlciBhIGByZXR1cm5gIGVzY2FwZXMgdGhlbSBhbGwuXG4gICAgLy9cbiAgICAvLyDimqAgQU5EIGBpZGxlTXNgL2ByZXRyeWAgQVJFIERFUklWRUQsIE5PVCBDT1BJRUQgKEI4J3Mgb25lIHVuY29weWFibGUgcnVsZSkuXG4gICAgLy8gVGhleSBjb21lIGZyb20gYC4vaGVhcnRiZWF0LnRzYCwgdGhlIHNlYW0gZmlsZSBib3RoIGhhbHZlcyBpbXBvcnQsIHdoZXJlXG4gICAgLy8gdGhlIHdhdGNoZG9nIGlzIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCDigJQgdGhyZWUgb2YgVEhJUyBkYWVtb24nc1xuICAgIC8vIGJlYXRzLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzIOKAlCBhbmQgd2hlcmUgdGhlIHR3byBlbnYga25vYnMgdGhpc1xuICAgIC8vIHNwZWxsJ3Mgb3duIHRhaWwgc3VpdGUgZHJpdmVzIGFyZSByZXNvbHZlZCAoRDc1KS4gVGhlIG51bWJlciBpcyA0NSwwMDAgYXRcbiAgICAvLyB0aGUgZGVmYXVsdCwgd2hpY2ggaXMgd2hhdCB0aGlzIGZpbGUgaGFyZC1jb2RlZDsgdGhlIEVYUFJFU1NJT04gaXMgd2hhdFxuICAgIC8vIGNoYW5nZWQuXG4gICAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8eyBpZD86IHVua25vd247IGVwb2NoPzogdW5rbm93bjsga2luZD86IHVua25vd24gfT4oe1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBwb3J0ID0gbGl2ZVBvcnQoKTtcbiAgICAgICAgcmV0dXJuIHBvcnQgPT09IG51bGwgPyBudWxsIDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWA7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZTogTnVtYmVyLmlzRmluaXRlKHNpbmNlKSA/IHNpbmNlIDogMCxcbiAgICAgIHF1ZXJ5OiAoY3Vyc29yKSA9PiAoe1xuICAgICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICAgIC4uLihwYXJzZWQudmFsdWVzLnByb2plY3QgPyB7IHByb2plY3Q6IHBhcnNlZC52YWx1ZXMucHJvamVjdCBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgLi4uKGluYm91bmQgPyB7IGluYm91bmQ6IFwiMVwiIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC8vIOKblCBgaWRgLCBOT1QgYHNlcWAg4oCUIHRoZSBkYWVtb24ncyBlbnZlbG9wZSBmaWVsZCB3YXMgcmVuYW1lZCBieSB0aGVcbiAgICAgIC8vIGBjcmVhdGVFdmVudExvZ2AgYWRvcHRpb24gKEQ4MSksIGFuZCB0aGlzIGlzIHRoZSBDTEktc2lkZSByZWFkZXIgb2YgaXQuXG4gICAgICAvLyDimqAgVGhlIENMSSBoYWxmIEZPUkNFRCBub3RoaW5nOiBgY3Vyc29yT2ZgIGlzIGNhbGxlci1zdXBwbGllZCwgc29cbiAgICAgIC8vIGAoZXYpID0+IGV2LnNlcWAgd291bGQgaGF2ZSBjb21waWxlZCBhbmQgcnVuLiBJdCB3b3VsZCBhbHNvIGhhdmUgcmVhZCBhXG4gICAgICAvLyBmaWVsZCB0aGUgZGFlbW9uIG5vIGxvbmdlciBlbWl0cywgc28gdGhlIGN1cnNvciB3b3VsZCBuZXZlciBhZHZhbmNlIGFuZFxuICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHdvdWxkIHJlLXJlcXVlc3QgYHNpbmNlPTBgIOKAlCB0aGUgd2hvbGUgcmVwbGF5IHdpbmRvd1xuICAgICAgLy8gaW50byBhbiBhZ2VudCdzIHBpcGUsIHNpbGVudGx5LCBmb3JldmVyLiAqKkEgY2FsbGVyLXN1cHBsaWVkIGFjY2Vzc29yIGlzXG4gICAgICAvLyB3aGVyZSBhIHdpcmUgcmVuYW1lIGdvZXMgd3JvbmcgcXVpZXRseS4qKlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4gKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiA/IGV2LmlkIDogdW5kZWZpbmVkKSxcbiAgICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAgIC8vIEEgcmVjb25uZWN0IHRoYXQgbGFuZHMgb24gYSBkaWZmZXJlbnQgZXBvY2ggbWVhbnMgdGhlIGRhZW1vbiByZXN0YXJ0ZWQ6XG4gICAgICAvLyB0aGUga2l0IHJlc2V0cyB0aGUgY3Vyc29yIHRvIDAgYW5kIHRoaXMgbGluZSB0ZWxscyB0aGUgY2FzdGluZyBhZ2VudCB0b1xuICAgICAgLy8gcmVmZXRjaCBzdGF0ZS4gQ0xJLXN5bnRoZXNpemVkIG9ubHksIG5ldmVyIGEgYnVzIGV2ZW50ICh0aGUgYnJvd3NlciBXU1xuICAgICAgLy8gbmV2ZXIgc2VlcyBpdCksIGFuZCBpdCBjYXJyaWVzIG5vIGBpZGAg4oCUIHNvIGl0IG5ldmVyIGFkdmFuY2VzIHRoZVxuICAgICAgLy8gY3Vyc29yLCB3aGljaCBpcyB0aGUgc2FtZSBzZXBhcmF0aW9uIHRoZSBncm91bmRpbmcgbGluZSBtYWtlcy5cbiAgICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyBraW5kOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgICAvLyBHcm91bmRpbmcgaXMgYSBzeW50aGV0aWMsIGlkLWxlc3MgZmlyc3QtY29ubmVjdCBmcmFtZTogZm9yd2FyZCB0aGVcbiAgICAgIC8vIGZpcnN0LCBzdXBwcmVzcyByZS1ncm91bmRpbmdzIG9uIHJlY29ubmVjdCAoZXhhY3RseSBvbmUgcGVyIHByb2Nlc3MpLlxuICAgICAgLy8gUmV0dXJuaW5nIG51bGwgd3JpdGVzIG5vdGhpbmc7IGl0IG5ldmVyIGNhcnJpZXMgaWQvZXBvY2gsIHNvIHRoZVxuICAgICAgLy8gY3Vyc29yIGFuZCB0aGUgZXBvY2ggYXJlIHVudG91Y2hlZCBlaXRoZXIgd2F5LlxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChldi5raW5kID09PSBcImdyb3VuZGluZ1wiKSB7XG4gICAgICAgICAgaWYgKGdyb3VuZGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZyYW1lLmRhdGE7XG4gICAgICB9LFxuICAgICAgLy8gQSByZWZ1c2VkIGNvbm5lY3Rpb24gKDQwOSBuZWVkcy1wcm9qZWN0IG9uIGEgcHJvamVjdGxlc3Mgc3RvcmUsIDQwNFxuICAgICAgLy8gdW5rbm93biBwcm9qZWN0KSBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSB0cmFuc3BvcnQgYmxpcCDigJQgcmV0cnlpbmcgaXRcbiAgICAgIC8vIGZvcmV2ZXIgd291bGQganVzdCBzcGluIHNpbGVudGx5LiBgcGFzc09yVGhyb3dgIGFsd2F5cyB0aHJvd3MgaGVyZSwgYW5kXG4gICAgICAvLyB0aGUgdGhyb3cgcHJvcGFnYXRlcyBvdXQgb2YgdGhlIGNsaWVudCBpbnRvIGBtYWluYCdzIGNhdGNoLCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSByYWlzZSByZWFjaGFibGUgZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcC5cbiAgICAgIG9uSHR0cEVycm9yOiBhc3luYyAocmVzKSA9PiB7XG4gICAgICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDkgfHwgcmVzLnN0YXR1cyA9PT0gNDA0KSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgICAgfSxcbiAgICAgIC8vIOKblCBUSEUgVU5QQVJTRUFCTEUgTElORSBHT0VTIFRPIFNURE9VVCwgV0hJQ0ggSVMgVEhJUyBTUEVMTCdTIE9XTlxuICAgICAgLy8gQkVIQVZJT1VSIEFORCBUSEUgT05FIFRIRSBLSVQnUyBERUZBVUxUIFdPVUxEIEhBVkUgQ0hBTkdFRC4gVGhlXG4gICAgICAvLyBoYW5kLXJvbGxlZCBsb29wIGNhdWdodCB0aGUgYEpTT04ucGFyc2VgIGFuZCBwYXNzZWQgdGhlIHJhdyBsaW5lXG4gICAgICAvLyB0aHJvdWdoIHVudHJhY2tlZDsgdGhlIGtpdCdzIGBvbk1hbGZvcm1lZGAgcmV0dXJuIHZhbHVlIGdvZXMgdG8gYGVycmBcbiAgICAgIC8vIGluc3RlYWQsIGJlY2F1c2UgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0gaXMgbm90IGRhdGEuIG1pbmQtbWFwcGVyXG4gICAgICAvLyBpcyB0aGUgXCJvbmUgc3BlbGxcIiB0aGF0IG1vZHVsZSdzIGhlYWRlciBuYW1lcyBhcyBnZW51aW5lbHkgd2FudGluZyBpdCBvblxuICAgICAgLy8gc3Rkb3V0LCBhbmQgdGhlIHdheSB0byBrZWVwIHRoYXQgaXMgdG8gd3JpdGUgaXQgZnJvbSBpbnNpZGUgdGhlIGhvb2sgYW5kXG4gICAgICAvLyByZXR1cm4gbnVsbC5cbiAgICAgIG9uTWFsZm9ybWVkOiAoZnJhbWUpID0+IHtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7ZnJhbWUuZGF0YX1cXG5gKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgICByZXRyeTogeyBpbml0aWFsTXM6IFRBSUxfUkVUUllfTVMsIG1heE1zOiBUQUlMX1JFVFJZX01BWF9NUyB9LFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicHJvamVjdHNcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJwcm9qZWN0c1wiLCByZXN0KTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLmNyZWF0ZSkge1xuICAgICAgY29uc3QgdGl0bGUgPSBwYXJzZWQudmFsdWVzLmNyZWF0ZTtcbiAgICAgIGNvbnN0IGlkID0gdGl0bGVcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2AsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZCwgdGl0bGUgfSksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2ApO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJpbmdlc3RcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJpbmdlc3RcIiwgcmVzdCk7XG4gICAgaWYgKCFwYXJzZWQudmFsdWVzLnRpdGxlKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiaW5nZXN0IHJlcXVpcmVzIC0tdGl0bGVcIik7XG4gICAgfVxuICAgIGlmICghcGFyc2VkLnZhbHVlcy5maWxlICYmICFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiaW5nZXN0IHJlcXVpcmVzIC0tZmlsZSA8cGF0aD4gb3IgLS1zdGRpblwiKTtcbiAgICB9XG4gICAgY29uc3QgdGV4dCA9IHBhcnNlZC52YWx1ZXMuZmlsZVxuICAgICAgPyByZWFkRmlsZVN5bmMocGFyc2VkLnZhbHVlcy5maWxlLCBcInV0ZjhcIilcbiAgICAgIDogYXdhaXQgQnVuLnN0ZGluLnRleHQoKTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9pbmdlc3Qke3FzfWAsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHRpdGxlOiBwYXJzZWQudmFsdWVzLnRpdGxlLCB0ZXh0IH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiB8fCB2ZXJiID09PSBcInByb3Bvc2UtZWRnZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyh2ZXJiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIGAke3ZlcmJ9IHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlWywgc3VnZ2VzdGVkVGllciwgYXV0aG9yLCB0YWdzLCBiYXRjaElkXX1gLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgICdwcm9wb3NlLWVkZ2UgZW5kcG9pbnRzOiBhIG5vZGUgaWQsIGEgcGVuZGluZyBub2RlLXByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiICcgK1xuICAgICAgICAgICAgXCIodGl0bGUgcmVmcyByZXNvbHZlIGF0IElOVEFLRSBhZ2FpbnN0IHJhdGlmaWVkIG5vZGVzIG9ubHksIGV4YWN0ICsgY2FzZS1zZW5zaXRpdmU7IFwiICtcbiAgICAgICAgICAgIFwiYW4gYW1iaWd1b3VzIHRpdGxlIGVycm9ycyBhbmQgbmFtZXMgZXZlcnkgY2FuZGlkYXRlIGlkKVwiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICAgIGRyYWZ0OiB1bmtub3duO1xuICAgICAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgICAgIHN1Z2dlc3RlZFRpZXI/OiBzdHJpbmc7XG4gICAgICBhdXRob3I/OiBzdHJpbmc7XG4gICAgICAvLyBSb3VuZCA3IChUQUdTKTogcHJvcG9zZS10aW1lIHRhZ3MgcmlkZSB0aGUgc3RkaW4gSlNPTiDigJQgbXVzdCBiZVxuICAgICAgLy8gZm9yd2FyZGVkIGludG8gdGhlIFBPU1QgYm9keSwgb3IgdGhlIC9wcm9wb3NhbHMgcm91dGUgbmV2ZXIgc2VlcyB0aGVtXG4gICAgICAvLyAodGhlIGJhdGNoIHBhdGggZm9yd2FyZHMgaXRzIG5vZGUgdGFnczsgdGhlIHNpbmdsZSB2ZXJiIG11c3QgdG9vKS5cbiAgICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAgIC8vIFJvdW5kIDEyIChTRUFNIDEpOiBqb2luIGFuIGV4aXN0aW5nIHN0YWdpbmcgYWN0IChmcm9tIHByb3Bvc2UtYmF0Y2gpLlxuICAgICAgYmF0Y2hJZD86IHN0cmluZztcbiAgICB9O1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2FscyR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAga2luZDogdmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiA/IFwibm9kZVwiIDogXCJlZGdlXCIsXG4gICAgICAgIGRyYWZ0OiBpbnB1dC5kcmFmdCxcbiAgICAgICAgZXZpZGVuY2U6IGlucHV0LmV2aWRlbmNlID8/IHt9LFxuICAgICAgICBzdWdnZXN0ZWRUaWVyOiBpbnB1dC5zdWdnZXN0ZWRUaWVyLFxuICAgICAgICBhdXRob3I6IGlucHV0LmF1dGhvcixcbiAgICAgICAgLy8gLS16b25lIHN0YWdlcyB0aGUgcHJvcG9zYWwgaW4gYSB6b25lIChmbGFnIHdpbnM7IHRoZSBzdGRpbiBKU09OXG4gICAgICAgIC8vIHN0YXlzIHRoZSBkcmFmdC9ldmlkZW5jZSBzaGFwZSDigJQgem9uZSBpcyByb3V0aW5nLCBub3QgY29udGVudCkuXG4gICAgICAgIHpvbmU6IHBhcnNlZC52YWx1ZXMuem9uZSxcbiAgICAgICAgLy8gVEFHUzogZm9yd2FyZCB0aGUgc3RkaW4gdGFncyAodGhlIHJvdXRlIHZhbGlkYXRlcyB0aGUgc2hhcGUpLlxuICAgICAgICB0YWdzOiBpbnB1dC50YWdzLFxuICAgICAgICAvLyBTRUFNIDE6IGZvcndhcmQgdGhlIHN0ZGluIGJhdGNoSWQgKHRoZSBib2R5LW1pcnJvciBkaXNjaXBsaW5lIOKAlCBhXG4gICAgICAgIC8vIGZpZWxkIGFkZGVkIHRvIHRoZSBzaGFyZWQgL3Byb3Bvc2FscyBib2R5IG11c3QgYmUgdGhyZWFkZWQgaW50byBFVkVSWVxuICAgICAgICAvLyBDTEkgdmVyYiB0aGF0IHBvc3RzIHRvIGl0OyB0aGUgcHJvcG9zZS1ub2RlLXRhZ3Mgc2NhcikuXG4gICAgICAgIGJhdGNoSWQ6IGlucHV0LmJhdGNoSWQsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgICAvLyBNaXJyb3IgdGhlIGRhZW1vbidzIGFkZGl0aXZlIGVkZ2UtZHJhZnQgd2FybmluZyB0byBzdGRlcnIg4oCUIGEgY29sZFxuICAgIC8vIGFnZW50IHNjYW5uaW5nIGZvciBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgZG9lc24ndCBwYXJzZSBzdGRvdXQuXG4gICAgaWYgKHZlcmIgPT09IFwicHJvcG9zZS1lZGdlXCIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLWJhdGNoXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicHJvcG9zZS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwicHJvcG9zZS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge25vZGVzOlt7cmVmLCBkcmFmdCwgc3VnZ2VzdGVkVGllcj8sIGV2aWRlbmNlP31dLCBlZGdlczpbe2RyYWZ0Ontzb3VyY2UsIHRhcmdldCwgbGFiZWw/fX1dfVwiLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgIFwiYW4gZWRnZSBlbmRwb2ludCBtYXkgYmUgYSBub2RlIExPQ0FMIFJFRiAobWF0Y2hlcyBhIG5vZGUncyByZWYgaW4gdGhpcyBiYXRjaCksIFwiICtcbiAgICAgICAgICAgICdhIHJlYWwgbm9kZSBpZCwgYSBwZW5kaW5nIHByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIOKAlCBsb2NhbCByZWZzICcgK1xuICAgICAgICAgICAgXCJyZXNvbHZlIHRvIG1pbnRlZCBpZHMgYW5kIHRpdGxlIHJlZnMgdG8gcmF0aWZpZWQgbm9kZSBpZHMsIGJvdGggc2VydmVyLXNpZGU7IFwiICtcbiAgICAgICAgICAgIFwib3B0aW9uYWwgYmF0Y2hJZDogb21pdCBhbmQgb25lIGlzIE1JTlRFRCArIHJldHVybmVkOyBzdXBwbHkgb25lIHRvIGV4dGVuZCB0aGF0IGFjdFwiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICAgIG5vZGVzPzogdW5rbm93bjtcbiAgICAgIGVkZ2VzPzogdW5rbm93bjtcbiAgICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICAgIH07XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL2JhdGNoJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBub2RlczogaW5wdXQubm9kZXMgPz8gW10sXG4gICAgICAgIGVkZ2VzOiBpbnB1dC5lZGdlcyA/PyBbXSxcbiAgICAgICAgLy8gU0VBTSAxOiBvbWl0dGVkIOKGkiB0aGUgZGFlbW9uIG1pbnRzIGEgYmF0Y2hJZCBhbmQgcmV0dXJucyBpdDsgc3VwcGxpZWRcbiAgICAgICAgLy8g4oaSIHRoaXMgY2FsbCBqb2lucyB0aGF0IGFjdCAodGhlIFwiSSBmb3Jnb3QgdGhlIGVkZ2VzXCIgcmVwYWlyKS5cbiAgICAgICAgYmF0Y2hJZDogaW5wdXQuYmF0Y2hJZCxcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIC8vIFJlc3BvbnNlIGNhcnJpZXMge2JhdGNoSWQsIHJlZlRvSWQ6IHs8cmVmPjogPG1pbnRlZElkPn0sIHByb3Bvc2FsczogWy4uLl19XG4gICAgLy8g4oCUIHRoZSByZWbihpJpZCBtYXAgaXMgdGhlIHBvaW50IGZvciBUSElTIGNhbGwsIGFuZCBiYXRjaElkIGlzIHRoZSBwb2ludCBmb3JcbiAgICAvLyBldmVyeSBsYXRlciBvbmUgKGBzdGF0ZSAtLWJhdGNoIDxpZD5gIHJlY29uY2lsZXMgYSBwYXJ0aWFsIHJhdGlmaWNhdGlvbikuXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInJhdGlmeS1iYXRjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInJhdGlmeS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICdyYXRpZnktYmF0Y2ggcmVxdWlyZXMgLS1zdGRpbiBKU09OIHtydWxpbmc6IFwiY2Fub258dGhyZWFkfHN0b3J5LWxvY2FsXCIsIGlkczogW3Byb3Bvc2FsSWRdLCBhbmNob3JzPzogW3tub2RlLCBwYXJlbnR9XX0nLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgIFwicmF0aWZpZXMgdGhlIHNldCBpbiBPTkUgY2FsbC90eG47IG5vZGVzIHJhdGlmeSBiZWZvcmUgZWRnZXMgKGF1dG8tcGFydGl0aW9uZWQpLCBcIiArXG4gICAgICAgICAgICBcImVkZ2UgZW5kcG9pbnRzICsgYW5jaG9yIHJlZnMgcmVzb2x2ZSBvbGQgcHJvcG9zYWwgaWRzIOKGkiBtaW50ZWQgbm9kZSBpZHMgdmlhIHRoZSBcIiArXG4gICAgICAgICAgICBcInJldHVybmVkIGlkTWFwLiBOTyBhdXRvLWluY2x1ZGUgb2YgdW5saXN0ZWQgZWRnZXM7IHJlamVjdCBpcyBub3QgYSBiYXRjaCBhY3RcIixcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7XG4gICAgICBydWxpbmc/OiB1bmtub3duO1xuICAgICAgaWRzPzogdW5rbm93bjtcbiAgICAgIGFuY2hvcnM/OiB1bmtub3duO1xuICAgIH07XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL3JhdGlmeS1iYXRjaCR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcnVsaW5nOiBpbnB1dC5ydWxpbmcsXG4gICAgICAgIGlkczogaW5wdXQuaWRzID8/IFtdLFxuICAgICAgICBhbmNob3JzOiBpbnB1dC5hbmNob3JzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgLy8gUmVzcG9uc2UgY2FycmllcyB7aWRNYXA6IHs8b2xkUHJvcG9zYWxJZD46IDxtaW50ZWROb2RlSWQ+fSwgcmF0aWZpZWQ6Wy4uLl19XG4gICAgLy8g4oCUIHRoZSBpZE1hcCBpcyB0aGUgcG9pbnQgKHJlY29ubmVjdCBhbiBlZGdlL2FuY2hvciB0byB0aGUgcmVhbCBub2RlKS5cbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgMTIgKFNFQU0gNSkg4oCUIHRoZSBpbnZlcnNlIG9mIHJhdGlmeS1iYXRjaDogY2xlYXIgYSBzZXQgb2YgcHJvcG9zYWxzXG4gIC8vIGluIE9ORSB0cmFuc2FjdGlvbmFsIGNhbGwgaW5zdGVhZCBvZiBOIEhUVFAgZGVsZXRlcyBpbiBhIGxvb3AuXG4gIGlmICh2ZXJiID09PSBcImRlbGV0ZS1iYXRjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImRlbGV0ZS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoJ2RlbGV0ZS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge2lkczogW1wiPHByb3Bvc2FsSWQ+XCIsIC4uLl19Jywge1xuICAgICAgICBoaW50OlxuICAgICAgICAgIFwiZGVsZXRlcyB0aGUgc2V0IGluIE9ORSB0eG4g4oCUIGFsbC1vci1ub3RoaW5nOiBpZiBhbnkgaWQgaXMgdW5rbm93biwgTk9USElORyBpcyBcIiArXG4gICAgICAgICAgXCJkZWxldGVkIGFuZCB0aGUgZXJyb3IgbmFtZXMgZXZlcnkgdW5rbm93biBpZC4gVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIFwiICtcbiAgICAgICAgICBcIntiYXRjaDogPGlkPn0gc2hvcnRoYW5kIOKAlCBydW4gYHN0YXRlIC0tYmF0Y2ggPGlkPmAgYW5kIGxvb2sgYmVmb3JlIHlvdSBzd2VlcCBcIiArXG4gICAgICAgICAgXCIoZHJpdmUgIzEwJ3MgYnVnIHdhcyBhbiBvdmVyLWJyb2FkIGNsZWFudXAgdGhhdCB0b29rIHRoZSBlZGdlcyB3aXRoIGl0KVwiLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7IGlkcz86IHVua25vd24gfTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvZGVsZXRlLWJhdGNoJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZHM6IGlucHV0LmlkcyA/PyBbXSB9KSxcbiAgICB9KTtcbiAgICBjb25zdCBkZWxldGVCYXRjaEJvZHkgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RlbGV0ZUJhdGNoQm9keX1cXG5gKTtcbiAgICAvLyBSMTIgZ2F0ZSBmaW5kaW5nIDE6IG1pcnJvciB0aGUgc3RyYW5kZWQtbm9kZSBhZHZpc29yeSB0byBzdGRlcnIsIHRoZSBzYW1lXG4gICAgLy8gd2F5IHByb3Bvc2UtZWRnZSBtaXJyb3JzIGVkZ2VEcmFmdFdhcm5pbmcg4oCUIGEgY29sZCBhZ2VudCBzY2FubmluZyBmb3JcbiAgICAvLyBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgbmV2ZXIgcGFyc2VzIHN0ZG91dC4gQWR2aXNvcnksIG5vdCBhIGZhaWx1cmU6XG4gICAgLy8gdGhlIGV4aXQgY29kZSBpcyB1bmNoYW5nZWQuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShkZWxldGVCYXRjaEJvZHkpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgaWYgKHR5cGVvZiB3YXJuaW5nID09PSBcInN0cmluZ1wiKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB3YXJuaW5nOiAke3dhcm5pbmd9XFxuYCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJub2RlXCIpIHtcbiAgICBjb25zdCBzdWIgPSByZXN0WzBdO1xuICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCB8fCAhc3Vic09mKFwibm9kZVwiKS5pbmNsdWRlcyhzdWIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBzdWIgPT09IHVuZGVmaW5lZCA/IFwibm9kZSByZXF1aXJlcyBhIHN1Yi1jb21tYW5kXCIgOiBgdW5rbm93biBub2RlIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcIm5vZGVcIikgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoYG5vZGUgJHtzdWJ9YCBhcyBWZXJiUGF0aCwgcmVzdC5zbGljZSgxKSk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICAvLyBSb3VuZCA2IChERUwpOiBgbm9kZSBkZWxldGUgPGlkPiBbLS1mb3JjZV1gIOKAlCA0MDkge2Vycm9yOlwiY2l0ZWRcIixcbiAgICAvLyBjaXRlZEJ5OntlZGdlcywgY2hpbGRyZW59fSB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuICAgIC8vIChlZGdlcyBnb25lLCBjaGlsZHJlbiByZS1wYXJlbnRlZCB0byB0b3AtbGV2ZWwsIGRldHJpdHVzIGdvbmUpLlxuICAgIGlmIChzdWIgPT09IFwiZGVsZXRlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgICAgaWYgKCFpZCkge1xuICAgICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBub2RlIGRlbGV0ZSA8bm9kZUlkPiBbLS1mb3JjZV1cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICAgICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgZHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgLy8gUm91bmQgMTIgKFNFQU0gNCk6IGBub2RlIGVkaXQgPGlkPiBbLS10aXRsZSBUXSBbLS1zeW5vcHNpcyBTXSB8IC0tc3RkaW5gXG4gICAgLy8g4oCUIGEgcmF0aWZpZWQgbm9kZSBjYW4gZmluYWxseSBnYWluIGEgc3lub3BzaXMgKEYyKS4gV3JpdGVzIGV4YWN0bHkgd2hhdFxuICAgIC8vIGl0IGlzIGdpdmVuOyB0aWVyIGFuZCBraW5kIGFyZSBOT1QgZWRpdGFibGUgKHNlZSBlZGl0LnRzIGZvciB3aHkpLlxuICAgIGlmIChzdWIgPT09IFwiZWRpdFwiKSB7XG4gICAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICAgIGNvbnN0IHBhdGNoOiB7IHRpdGxlPzogc3RyaW5nOyBzeW5vcHNpcz86IHN0cmluZyB9ID0ge307XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikge1xuICAgICAgICAvLyBQcm9zZSBiZWxvbmdzIG9uIHN0ZGluIOKAlCBhIHN5bm9wc2lzIGlzIGEgcGFyYWdyYXBoLCBub3QgYSBmbGFnIHZhbHVlLlxuICAgICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICAgIHBhdGNoLFxuICAgICAgICAgIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyB0aXRsZT86IHN0cmluZzsgc3lub3BzaXM/OiBzdHJpbmcgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnRpdGxlICE9PSB1bmRlZmluZWQpIHBhdGNoLnRpdGxlID0gcGFyc2VkLnZhbHVlcy50aXRsZTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnN5bm9wc2lzICE9PSB1bmRlZmluZWQpIHBhdGNoLnN5bm9wc2lzID0gcGFyc2VkLnZhbHVlcy5zeW5vcHNpcztcbiAgICAgIGlmICghaWQgfHwgKHBhdGNoLnRpdGxlID09PSB1bmRlZmluZWQgJiYgcGF0Y2guc3lub3BzaXMgPT09IHVuZGVmaW5lZCkpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICAndXNhZ2U6IGNsaS50cyBub2RlIGVkaXQgPG5vZGVJZD4gKC0tdGl0bGUgPHQ+IHwgLS1zeW5vcHNpcyA8cz4gfCAtLXN0ZGluIFxcJ3tcInN5bm9wc2lzXCI6IFwiLi4uXCJ9XFwnKScsXG4gICAgICAgICAge1xuICAgICAgICAgICAgaGludDpcbiAgICAgICAgICAgICAgXCJ3cml0ZXMgZXhhY3RseSB3aGF0IGl0IGlzIGdpdmVuIChubyBpbmZlcmVuY2UpOyBvbmx5IHRpdGxlL3N5bm9wc2lzIGFyZSBlZGl0YWJsZSDigJQgXCIgK1xuICAgICAgICAgICAgICBcInRpZXIgaXMgdGhlIGh1bWFuJ3MgcnVsaW5nIGFuZCBraW5kIGlzIGEgcmF0aWZpY2F0aW9uLXRpbWUgY2xhc3NpZmljYXRpb25cIixcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgLy8gQm9keS1taXJyb3IgZGlzY2lwbGluZTogdGhyZWFkIGV2ZXJ5IGZpZWxkIGV4cGxpY2l0bHkgKHRoZVxuICAgICAgICAvLyBwcm9wb3NlLW5vZGUtdGFncyBzY2FyKSDigJQgYW4gb21pdHRlZCBrZXkgbXVzdCBzdGF5IG9taXR0ZWQgc28gdGhlXG4gICAgICAgIC8vIHJvdXRlIHBhdGNoZXMgaW5zdGVhZCBvZiBibGFua2luZy5cbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIC4uLihwYXRjaC50aXRsZSAhPT0gdW5kZWZpbmVkID8geyB0aXRsZTogcGF0Y2gudGl0bGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4ocGF0Y2guc3lub3BzaXMgIT09IHVuZGVmaW5lZCA/IHsgc3lub3BzaXM6IHBhdGNoLnN5bm9wc2lzIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgIT09IFwiYW5jaG9yXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBub2RlIGFuY2hvciA8bm9kZUlkPiAoLS10byA8cGFyZW50SWQ+IHwgLS1jbGVhcikgfCBub2RlIGVkaXQgPG5vZGVJZD4gKC0tdGl0bGUgPHQ+IHwgLS1zeW5vcHNpcyA8cz4gfCAtLXN0ZGluKSB8IG5vZGUgZGVsZXRlIDxub2RlSWQ+IFstLWZvcmNlXVxcblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgY29uc3QgaGFzVG8gPSBwYXJzZWQudmFsdWVzLnRvICE9PSB1bmRlZmluZWQ7XG4gICAgaWYgKCFpZCB8fCAoaGFzVG8gJiYgcGFyc2VkLnZhbHVlcy5jbGVhcikgfHwgKCFoYXNUbyAmJiAhcGFyc2VkLnZhbHVlcy5jbGVhcikpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBub2RlIGFuY2hvciA8bm9kZUlkPiAoLS10byA8cGFyZW50SWQ+IHwgLS1jbGVhcilcXG5cIiArXG4gICAgICAgICAgXCIgIC0tdG8gYW5jaG9ycyB0aGUgbm9kZSB1bmRlciA8cGFyZW50SWQ+IChhIHJlYWwgbm9kZSBpZCk7IC0tY2xlYXIgbW92ZXMgaXQgdG8gdG9wLWxldmVsXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0vYW5jaG9yJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJlbnRJZDogcGFyc2VkLnZhbHVlcy5jbGVhciA/IG51bGwgOiBwYXJzZWQudmFsdWVzLnRvIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJyZWFkXCIgfHwgdmVyYiA9PT0gXCJtZXNzYWdlXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicmVhZFwiLCByZXN0KTtcbiAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyByZWFkIDxtZXNzYWdlSWQ+XCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9tZXNzYWdlLyR7aWR9JHtxc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwiem9uZVwiKSB7XG4gICAgY29uc3Qgc3ViID0gcmVzdFswXTtcbiAgICBpZiAoc3ViID09PSB1bmRlZmluZWQgfHwgIXN1YnNPZihcInpvbmVcIikuaW5jbHVkZXMoc3ViKSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgc3ViID09PSB1bmRlZmluZWQgPyBcInpvbmUgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gem9uZSBzdWItY29tbWFuZDogJHtzdWJ9YCxcbiAgICAgICAgeyBjaG9pY2VzOiBzdWJzT2YoXCJ6b25lXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGB6b25lICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBpZiAoc3ViID09PSBcImNyZWF0ZVwiKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGFyc2VkLnBvc2l0aW9uYWxzLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCFuYW1lKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHpvbmUgY3JlYXRlIDxuYW1lPlwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pLFxuICAgICAgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgPT09IFwibGlzdFwiKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3pvbmVzJHtxc31gKTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHpvbmUgZGVsZXRlIDxpZD4gWy0teWVzXVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy55ZXMpIHBhcmFtcy5zZXQoXCJ5ZXNcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgZHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgem9uZSA8Y3JlYXRlIDxuYW1lPiB8IGxpc3QgfCBkZWxldGUgPGlkPiBbLS15ZXNdPlwiKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInByb21vdGVcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJwcm9tb3RlXCIsIHJlc3QpO1xuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGlmICghaWQpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHByb21vdGUgPHByb3Bvc2FsSWQ+XCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vcHJvbW90ZSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICB9KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicHJvcG9zYWxcIikge1xuICAgIGNvbnN0IHN1YiA9IHJlc3RbMF07XG4gICAgaWYgKHN1YiA9PT0gdW5kZWZpbmVkIHx8ICFzdWJzT2YoXCJwcm9wb3NhbFwiKS5pbmNsdWRlcyhzdWIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBzdWIgPT09IHVuZGVmaW5lZFxuICAgICAgICAgID8gXCJwcm9wb3NhbCByZXF1aXJlcyBhIHN1Yi1jb21tYW5kXCJcbiAgICAgICAgICA6IGB1bmtub3duIHByb3Bvc2FsIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcInByb3Bvc2FsXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGBwcm9wb3NhbCAke3N1Yn1gIGFzIFZlcmJQYXRoLCByZXN0LnNsaWNlKDEpKTtcbiAgICBjb25zdCBwcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3RcbiAgICAgID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YFxuICAgICAgOiBcIlwiO1xuICAgIC8vIFJvdW5kIDYgKERFTCk6IGBwcm9wb3NhbCBkZWxldGUgPGlkPmAg4oCUIHRoaW4sIG5vIGd1YXJkIChkcm9wIHJvdyArXG4gICAgLy8gY2FzY2FkZSBub2RlX2FjdGlvbnMpLiBUaGUgbGl0dGVyLWNsZWFyaW5nIHBhdGggKGNsZWFyIGEgcmF3XG4gICAgLy8gaW5zdHJ1Y3Rpb24tbm9kZSB0aHJvdWdoIERFTEVURSwgbm90IHJlamVjdCkuXG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHByb3Bvc2FsIGRlbGV0ZSA8cHJvcG9zYWxJZD5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0ke3Bxc31gLCB7XG4gICAgICAgIG1ldGhvZDogXCJERUxFVEVcIixcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViICE9PSBcInpvbmVcIikge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJ1c2FnZTogY2xpLnRzIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpIHwgcHJvcG9zYWwgZGVsZXRlIDxpZD5cXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGNvbnN0IGhhc1RvID0gcGFyc2VkLnZhbHVlcy50byAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghaWQgfHwgKGhhc1RvICYmIHBhcnNlZC52YWx1ZXMuY2xlYXIpIHx8ICghaGFzVG8gJiYgIXBhcnNlZC52YWx1ZXMuY2xlYXIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcInVzYWdlOiBjbGkudHMgcHJvcG9zYWwgem9uZSA8cHJvcG9zYWxJZD4gKC0tdG8gPHpvbmVJZD4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgLS10byBtb3ZlcyBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyA8em9uZUlkPjsgLS1jbGVhciBtb3ZlcyBpdCBiYWNrIHRvIHRoZSBtYWluIHF1ZXVlXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vem9uZSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgem9uZUlkOiBwYXJzZWQudmFsdWVzLmNsZWFyID8gbnVsbCA6IHBhcnNlZC52YWx1ZXMudG8gfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImRvY1wiKSB7XG4gICAgLy8gZG9jJ3Mgc3ViIGlzIE9QVElPTkFMIChgZG9jIDxpZD5gIHJlYWRzKSBhbmQgcmlkZXMgdGhlIHBvc2l0aW9uYWxzLCBzbyBhXG4gICAgLy8gcmVnaXN0cnktd2lkZSBwcm9iZSBwYXJzZSByZXNvbHZlcyB0aGUgcGF0aCBiZWZvcmUgdGhlIHBlci1wYXRoIGNoZWNrLlxuICAgIGNvbnN0IHByb2JlID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IHJlc3QsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgY29uc3QgZG9jUGF0aDogVmVyYlBhdGggPVxuICAgICAgcHJvYmUucG9zaXRpb25hbHNbMF0gPT09IFwia2luZFwiXG4gICAgICAgID8gXCJkb2Mga2luZFwiXG4gICAgICAgIDogcHJvYmUucG9zaXRpb25hbHNbMF0gPT09IFwiZGVsZXRlXCJcbiAgICAgICAgICA/IFwiZG9jIGRlbGV0ZVwiXG4gICAgICAgICAgOiBcImRvY1wiO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoZG9jUGF0aCwgcmVzdCk7XG4gICAgLy8gYGRvYyBkZWxldGUgPGlkPmAgLyBgZG9jIGtpbmQgPGlkPmAgb3ZlcmxvYWQgdGhlIHBvc2l0aW9uYWwgKGEgZG9jXG4gICAgLy8gbGl0ZXJhbGx5IHNsdWdnZWQgXCJkZWxldGVcIi9cImtpbmRcIiBpcyB1bmFkZHJlc3NhYmxlIOKAlCBhY2NlcHRlZCBmb3IgdGhlXG4gICAgLy8gcmVjb3JkLCBwbGFuLXYxeCkuXG4gICAgLy8gUm91bmQgNCAoSzEpOiBgZG9jIGtpbmQgPGRvY0lkPiA8a2luZC4uLj4gWy0tYXV0aG9yIHVzZXJ8YWdlbnRdYCBzZXRzLFxuICAgIC8vIGBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJgIGNsZWFycyAoYXV0aG9yIG51bGxzIHdpdGggaXQpLiBUaGUgaW5nZXN0XG4gICAgLy8gZGVmYXVsdHMgZGllZCDigJQgdGhpcyB2ZXJiIGlzIGhvdyBhIGRvYyBnZXRzIHR5cGVkIGF0IGFsbC5cbiAgICBpZiAocGFyc2VkLnBvc2l0aW9uYWxzWzBdID09PSBcImtpbmRcIikge1xuICAgICAgY29uc3QgZG9jSWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMV07XG4gICAgICBjb25zdCBraW5kV29yZHMgPSBwYXJzZWQucG9zaXRpb25hbHMuc2xpY2UoMikuam9pbihcIiBcIik7XG4gICAgICBpZiAoIWRvY0lkIHx8IChraW5kV29yZHMgPT09IFwiXCIgJiYgIXBhcnNlZC52YWx1ZXMuY2xlYXIpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGRvYyBraW5kIDxkb2NJZD4gPGtpbmQ+IFstLWF1dGhvciB1c2VyfGFnZW50XSB8IGRvYyBraW5kIDxkb2NJZD4gLS1jbGVhclxcblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0XG4gICAgICAgID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YFxuICAgICAgICA6IFwiXCI7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9raW5kJHtxc31gLCB7XG4gICAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KFxuICAgICAgICAgIHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgICAgICAgID8geyBraW5kOiBudWxsIH1cbiAgICAgICAgICAgIDogeyBraW5kOiBraW5kV29yZHMsIGF1dGhvcjogcGFyc2VkLnZhbHVlcy5hdXRob3IgPz8gXCJhZ2VudFwiIH0sXG4gICAgICAgICksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgY29uc3QgaXNEZWxldGUgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gPT09IFwiZGVsZXRlXCI7XG4gICAgY29uc3QgaWQgPSBpc0RlbGV0ZSA/IHBhcnNlZC5wb3NpdGlvbmFsc1sxXSA6IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcInVzYWdlOiBjbGkudHMgZG9jIDxpZD4gfCBkb2MgZGVsZXRlIDxpZD4gWy0tZm9yY2VdIHwgZG9jIGtpbmQgPGRvY0lkPiA8a2luZHwtLWNsZWFyPiBbLS1wcm9qZWN0IDxpZD5dXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICAgIGlmIChpc0RlbGV0ZSAmJiBwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICAgIGNvbnN0IHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2lkfSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBpc0RlbGV0ZSA/IFwiREVMRVRFXCIgOiBcIkdFVFwiLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJtYXJrXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwibWFya1wiLCByZXN0KTtcbiAgICBjb25zdCBkb2NJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWRvY0lkIHx8ICFwYXJzZWQudmFsdWVzLnN0YXR1cykge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgbWFyayA8ZG9jSWQ+IC0tc3RhdHVzIDxzPiBbLS1ub3RlIDx0Pl1cIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9tYXJrJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBhdXRob3I6IHBhcnNlZC52YWx1ZXMuYXV0aG9yID8/IFwiYWdlbnRcIixcbiAgICAgICAgbm90ZTogcGFyc2VkLnZhbHVlcy5ub3RlLFxuICAgICAgICBzdGF0dXM6IHBhcnNlZC52YWx1ZXMuc3RhdHVzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInNlYXJjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInNlYXJjaFwiLCByZXN0KTtcbiAgICBjb25zdCBxdWVyeSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBzZWFyY2ggPHF1ZXJ5Li4uPlwiKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgcTogcXVlcnkgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3NlYXJjaD8ke3BhcmFtc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwibmVpZ2hib3JzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwibmVpZ2hib3JzXCIsIHJlc3QpO1xuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGlmICghaWQpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXVwiKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPz8gXCIxXCIgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L25laWdoYm9ycy8ke2lkfT8ke3BhcmFtc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicmF0aWZ5XCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicmF0aWZ5XCIsIHJlc3QpO1xuICAgIGNvbnN0IHByb3Bvc2FsSWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgaWYgKCFwcm9wb3NhbElkIHx8ICFwYXJzZWQudmFsdWVzLnJ1bGluZykge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJ1c2FnZTogY2xpLnRzIHJhdGlmeSA8cHJvcG9zYWxJZD4gLS1ydWxpbmcgPHI+IFstLWRvYy1lZGl0IDxmaWxlPl0gWy0tZG9jIDxkb2NJZD4gLS1zcGFuIDx0ZXh0Pl0gWy0tYW5jaG9yIDxwYXJlbnRJZD5dXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyAtLWRvYyByZXF1aXJlcyAtLWRvYy1lZGl0IOKAlCB0aGUgZGFlbW9uIGVuZm9yY2VzIGl0IHRvbywgYnV0IGEgbG9jYWxcbiAgICAvLyB1c2FnZSBlcnJvciBiZWF0cyBhIHJvdW5kLXRyaXAgZm9yIHRoZSBjb21tb24gc2xpcC5cbiAgICBpZiAocGFyc2VkLnZhbHVlcy5kb2MgJiYgIXBhcnNlZC52YWx1ZXNbXCJkb2MtZWRpdFwiXSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcIi0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQgKHRoZSBkcmFmdGVkIGRvYyBob21lKVwiKTtcbiAgICB9XG4gICAgY29uc3QgZG9jRWRpdCA9IHBhcnNlZC52YWx1ZXNbXCJkb2MtZWRpdFwiXVxuICAgICAgPyByZWFkRmlsZVN5bmMocGFyc2VkLnZhbHVlc1tcImRvYy1lZGl0XCJdLCBcInV0ZjhcIilcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke3Byb3Bvc2FsSWR9L3J1bGluZyR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcnVsaW5nOiBwYXJzZWQudmFsdWVzLnJ1bGluZyxcbiAgICAgICAgZG9jRWRpdCxcbiAgICAgICAgZG9jSWQ6IHBhcnNlZC52YWx1ZXMuZG9jLFxuICAgICAgICBzcGFuOiBwYXJzZWQudmFsdWVzLnNwYW4sXG4gICAgICAgIC8vIFJvdW5kIDYgKFJCKTogLS1hbmNob3IgPHBhcmVudElkPiByYXRpZmllcyB0aGVuIG5lc3RzIHRoZSBtaW50ZWRcbiAgICAgICAgLy8gbm9kZSB1bmRlciA8cGFyZW50SWQ+IGluIG9uZSBhdG9taWMgY2FsbCAobm9kZSBwcm9wb3NhbHMgb25seSkuXG4gICAgICAgIGFuY2hvcjogcGFyc2VkLnZhbHVlcy5hbmNob3IsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwibGVuc1wiKSB7XG4gICAgY29uc3Qgc3ViID0gcmVzdFswXTtcbiAgICBpZiAoc3ViID09PSB1bmRlZmluZWQgfHwgIXN1YnNPZihcImxlbnNcIikuaW5jbHVkZXMoc3ViKSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgc3ViID09PSB1bmRlZmluZWQgPyBcImxlbnMgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gbGVucyBzdWItY29tbWFuZDogJHtzdWJ9YCxcbiAgICAgICAgeyBjaG9pY2VzOiBzdWJzT2YoXCJsZW5zXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGBsZW5zICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIC8vIFJvdW5kIDMgKENsYWltIFYyKTogb25lIGxlbnMsIHR3byBtb2RlcyDigJQgLS1ub2RlIGFuZCAtLWRvYyBhcmVcbiAgICAvLyBleGNsdXNpdmUgYXQgcGFyc2UgdGltZSAodGhlIGRhZW1vbiBlbmZvcmNlcyB0aGUgWE9SIHRvbywgYnV0IHRoZVxuICAgIC8vIGNvbW1vbiBzbGlwIHNob3VsZCBmYWlsIGJlZm9yZSBhIHJvdW5kLXRyaXApLlxuICAgIGlmIChwYXJzZWQudmFsdWVzLm5vZGUgIT09IHVuZGVmaW5lZCAmJiBwYXJzZWQudmFsdWVzLmRvYyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwibGVucyBzZXQgdGFrZXMgLS1ub2RlIE9SIC0tZG9jLCBub3QgYm90aFwiKTtcbiAgICB9XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuZG9jICE9PSB1bmRlZmluZWQgJiYgcGFyc2VkLnZhbHVlcy5kZXB0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiLS1kZXB0aCBhcHBsaWVzIHRvIGEgbm9kZSBsZW5zIG9ubHlcIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBpZiAoc3ViID09PSBcInNldFwiKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2xlbnMke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIG93bmVyOiBwYXJzZWQudmFsdWVzLm93bmVyID8/IFwiYWdlbnRcIixcbiAgICAgICAgICBub2RlSWQ6IHBhcnNlZC52YWx1ZXMubm9kZSxcbiAgICAgICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICAgICAgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPyBOdW1iZXIucGFyc2VJbnQocGFyc2VkLnZhbHVlcy5kZXB0aCwgMTApIDogdW5kZWZpbmVkLFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcImNsZWFyXCIpIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbGVucyR7cXN9YCwgeyBtZXRob2Q6IFwiREVMRVRFXCIgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgbGVucyA8c2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxkb2NJZD4pIHwgY2xlYXI+XFxuXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImxvb2staGVyZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImxvb2staGVyZVwiLCByZXN0KTtcbiAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBsb29rLWhlcmUgPG5vZGVJZD5cIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2xvb2staGVyZS8ke2lkfSR7cXN9YCwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJhY3Rpb25zXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiYWN0aW9uc1wiLCByZXN0KTtcbiAgICBjb25zdCB0YXJnZXRJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBjb25zdCBtb2RlcyA9IFtwYXJzZWQudmFsdWVzLnNldCAhPT0gdW5kZWZpbmVkLCBwYXJzZWQudmFsdWVzLnN0ZGluLCBwYXJzZWQudmFsdWVzLmNsZWFyXTtcbiAgICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBhY3Rpb25zIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICAgJyAge1wiaWRcIiwgXCJsYWJlbFwiLCBcInNlZWRcIn0g4oCUIGVtcHR5IGFycmF5IChvciAtLWNsZWFyKSByZW1vdmVzIHRoZSBzbG90c1xcbicsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpb25zLyR7dGFyZ2V0SWR9JHtxc31gO1xuICAgIGNvbnN0IHJlcyA9IHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgID8gYXdhaXQgZmV0Y2godGFyZ2V0LCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KVxuICAgICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgICBtZXRob2Q6IFwiUFVUXCIsXG4gICAgICAgICAgYm9keTogcGFyc2VkLnZhbHVlcy5zdGRpbiA/IGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkgOiAocGFyc2VkLnZhbHVlcy5zZXQgYXMgc3RyaW5nKSxcbiAgICAgICAgfSk7XG4gICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZXNwb25zZVRleHR9XFxuYCk7XG4gICAgLy8gTWlycm9yIHRoZSBkYWVtb24ncyBhZGRpdGl2ZSBzb2Z0LWNhcCB3YXJuaW5nIHRvIHN0ZGVyciAodGhlXG4gICAgLy8gZWRnZURyYWZ0V2FybmluZyBwYXR0ZXJuIOKAlCBhIGNvbGQgYWdlbnQgc2Nhbm5pbmcgZm9yIHByb2JsZW1zIHNlZXMgaXQpLlxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gICAgfVxuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgNyAoVEFHUykg4oCUIHR3aW4gb2YgdGhlIGFjdGlvbnMgdmVyYjogd2hvbGVzYWxlIHJlcGxhY2UgLyBjbGVhciBhXG4gIC8vIHRhcmdldCdzIGZyZWVmb3JtIHRhZ3MuIFRhcmdldCBpcyBhIG5vZGUgaWQgb3IgYSBQRU5ESU5HIHByb3Bvc2FsIGlkLlxuICBpZiAodmVyYiA9PT0gXCJ0YWdzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwidGFnc1wiLCByZXN0KTtcbiAgICBjb25zdCB0YXJnZXRJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBjb25zdCBtb2RlcyA9IFtwYXJzZWQudmFsdWVzLnNldCAhPT0gdW5kZWZpbmVkLCBwYXJzZWQudmFsdWVzLnN0ZGluLCBwYXJzZWQudmFsdWVzLmNsZWFyXTtcbiAgICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICAgXCIgIGZyZWVmb3JtIHN0cmluZ3Mg4oCUIGVtcHR5IGFycmF5IChvciAtLWNsZWFyKSByZW1vdmVzIHRoZSB0YWdzXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS90YWdzLyR7dGFyZ2V0SWR9JHtxc31gO1xuICAgIGNvbnN0IHJlcyA9IHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgID8gYXdhaXQgZmV0Y2godGFyZ2V0LCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KVxuICAgICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgICBtZXRob2Q6IFwiUFVUXCIsXG4gICAgICAgICAgYm9keTogcGFyc2VkLnZhbHVlcy5zdGRpbiA/IGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkgOiAocGFyc2VkLnZhbHVlcy5zZXQgYXMgc3RyaW5nKSxcbiAgICAgICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFJvdW5kIDkgKEpvYiBRdWV1ZSkg4oCUIHRoZSBgam9iYCB2ZXJiOiBjcmVhdGUvdXBkYXRlL2NsYWltL3JlbGVhc2Uvc3VidGFzay9cbiAgLy8gbGlzdC9kZWxldGUsIGNvcHlpbmcgdGhlIGBwcm9wb3NhbCA8c3ViPmAgbGlmZWN5Y2xlIHNoYXBlICsgdGhlIHRhZ3NcbiAgLy8gYm9keS1idWlsZGVyIGRpc2NpcGxpbmUuIEVWRVJZIGZpZWxkIGlzIHRocmVhZGVkIGludG8gdGhlIFBPU1QgYm9keSAodGhlIFI3XG4gIC8vIGdhdGUgc2NhcjogYSBoYW5kLXdyaXR0ZW4gYm9keS1idWlsZGVyIGlzIGEgTUlSUk9SIG9mIHRoZSByb3V0ZSdzIGZpZWxkIHNldFxuICAvLyBhbmQgZHJpZnRzIHNpbGVudGx5IOKAlCBzbyB1cGRhdGUgZm9yd2FyZHMgZWFjaCBwcm92aWRlZCBzY2FsYXIsIHN1YnRhc2tcbiAgLy8gZm9yd2FyZHMgb3AgKyBsYWJlbHxzdWJ0YXNrSWQsIGNsYWltIGZvcndhcmRzIG93bmVyKS5cbiAgaWYgKHZlcmIgPT09IFwiam9iXCIpIHtcbiAgICBjb25zdCBzdWIgPSByZXN0WzBdO1xuICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCB8fCAhc3Vic09mKFwiam9iXCIpLmluY2x1ZGVzKHN1YikpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIHN1YiA9PT0gdW5kZWZpbmVkID8gXCJqb2IgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gam9iIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcImpvYlwiKSB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhgam9iICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgYmFzZSA9IChwb3J0OiBudW1iZXIsIHN1ZmZpeCA9IFwiXCIpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vam9icyR7c3VmZml4fSR7cXN9YDtcbiAgICAvLyBBIEpTT04gYm9keSBmcm9tIC0tYm9keS1maWxlID4gLS1zdGRpbiBvdmVycmlkZXMgdGhlIGZsYWctYnVpbHQgYm9keSAodGhlXG4gICAgLy8gc2VuZCBwcmVjZWRlbmNlIGNoYWluKSwgc28gYSBmdWxsIGpvYiBjYW4gYmUgcGlwZWQgaW4gb25lIHNob3QuXG4gICAgY29uc3QgYm9keUZyb21Tb3VyY2UgPSBhc3luYyAoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw+ID0+IHtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgcCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgICAgIGlmICghZXhpc3RzU3luYyhwKSkge1xuICAgICAgICAgIHRocm93IHVzYWdlRXJyb3IoYGpvYjogLS1ib2R5LWZpbGUgbm90IGZvdW5kOiAke3B9YCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9O1xuXG4gICAgaWYgKHN1YiA9PT0gXCJsaXN0XCIpIHtcbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQpKTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJjcmVhdGVcIikge1xuICAgICAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBib2R5RnJvbVNvdXJjZSgpO1xuICAgICAgY29uc3QgYm9keSA9IG92ZXJyaWRlID8/IHtcbiAgICAgICAgdGl0bGU6IHBhcnNlZC52YWx1ZXMudGl0bGUsXG4gICAgICAgIHN0YXR1czogcGFyc2VkLnZhbHVlcy5zdGF0dXMsXG4gICAgICAgIGRlbGl2ZXJhYmxlOiBwYXJzZWQudmFsdWVzLmRlbGl2ZXJhYmxlLFxuICAgICAgICBkZXRhaWw6IHBhcnNlZC52YWx1ZXMuZGV0YWlsLFxuICAgICAgfTtcbiAgICAgIGlmICh0eXBlb2YgYm9keS50aXRsZSAhPT0gXCJzdHJpbmdcIiB8fCBib2R5LnRpdGxlID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiBjcmVhdGUgLS10aXRsZSA8dD4gWy0tc3RhdHVzIDxzPl0gWy0tZGVsaXZlcmFibGUgPHJlZj5dIFstLWRldGFpbCA8eD5dXFxuXCIgK1xuICAgICAgICAgICAgXCIgIG9yOiBjbGkudHMgam9iIGNyZWF0ZSAoLS1zdGRpbiB8IC0tYm9keS1maWxlIDxwYXRoPikgd2l0aCBKU09OIHt0aXRsZSwgc3RhdHVzPywgZGVsaXZlcmFibGU/LCBkZXRhaWw/fVxcblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGJhc2UocG9ydCksIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgPT09IFwidXBkYXRlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgICAgaWYgKCFpZCkge1xuICAgICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICAgIFwidXNhZ2U6IGNsaS50cyBqb2IgdXBkYXRlIDxpZD4gWy0tdGl0bGUgPHQ+XSBbLS1zdGF0dXMgPHM+XSBbLS1kZWxpdmVyYWJsZSA8cmVmPl0gWy0tZGV0YWlsIDx4Pl1cXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG92ZXJyaWRlID0gYXdhaXQgYm9keUZyb21Tb3VyY2UoKTtcbiAgICAgIC8vIEZvcndhcmQgb25seSB0aGUgZmxhZ3MgdGhhdCB3ZXJlIFBST1ZJREVEICh0aHJlYWQgZXZlcnkgZmllbGQg4oCUIHRoZSBSN1xuICAgICAgLy8gYm9keS1taXJyb3Igc2Nhcik7IGEgYmFyZSBgam9iIHVwZGF0ZSA8aWQ+YCB3aXRoIG5vIGZpZWxkcyBpcyBhIHVzYWdlXG4gICAgICAvLyBlcnJvciwgbm90IGEgc2lsZW50IG5vLW9wIFBPU1QuXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9XG4gICAgICAgIG92ZXJyaWRlID8/XG4gICAgICAgIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICAoW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiXSBhcyBjb25zdClcbiAgICAgICAgICAgIC5maWx0ZXIoKGspID0+IHBhcnNlZC52YWx1ZXNba10gIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgIC5tYXAoKGspID0+IFtrLCBwYXJzZWQudmFsdWVzW2tdXSksXG4gICAgICAgICk7XG4gICAgICBpZiAoT2JqZWN0LmtleXMoYm9keSkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiB1cGRhdGUgPGlkPiAoYXQgbGVhc3Qgb25lIG9mIC0tdGl0bGV8LS1zdGF0dXN8LS1kZWxpdmVyYWJsZXwtLWRldGFpbClcXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQsIGAvJHtpZH1gKSwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJjbGFpbVwiKSB7XG4gICAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICAgIGlmICghaWQgfHwgcGFyc2VkLnZhbHVlcy5vd25lciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiBjbGFpbSA8aWQ+IC0tb3duZXIgPHdobz5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYmFzZShwb3J0LCBgLyR7aWR9L2NsYWltYCksIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBvd25lcjogcGFyc2VkLnZhbHVlcy5vd25lciB9KSxcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcInJlbGVhc2VcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiByZWxlYXNlIDxpZD5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYmFzZShwb3J0LCBgLyR7aWR9L3JlbGVhc2VgKSwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcInN1YnRhc2tcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBjb25zdCBtb2RlcyA9IFtcbiAgICAgICAgcGFyc2VkLnZhbHVlcy5hZGQgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgcGFyc2VkLnZhbHVlcy5jaGVjayAhPT0gdW5kZWZpbmVkLFxuICAgICAgICBwYXJzZWQudmFsdWVzLnVuY2hlY2sgIT09IHVuZGVmaW5lZCxcbiAgICAgIF07XG4gICAgICBpZiAoIWlkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICBcInVzYWdlOiBjbGkudHMgam9iIHN1YnRhc2sgPGlkPiAoLS1hZGQgPGxhYmVsPiB8IC0tY2hlY2sgPHN1YnRhc2tJZD4gfCAtLXVuY2hlY2sgPHN1YnRhc2tJZD4pXFxuXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBqb2JCb2R5ID1cbiAgICAgICAgcGFyc2VkLnZhbHVlcy5hZGQgIT09IHVuZGVmaW5lZFxuICAgICAgICAgID8geyBvcDogXCJhZGRcIiwgbGFiZWw6IHBhcnNlZC52YWx1ZXMuYWRkIH1cbiAgICAgICAgICA6IHBhcnNlZC52YWx1ZXMuY2hlY2sgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyB7IG9wOiBcImNoZWNrXCIsIHN1YnRhc2tJZDogcGFyc2VkLnZhbHVlcy5jaGVjayB9XG4gICAgICAgICAgICA6IHsgb3A6IFwidW5jaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMudW5jaGVjayB9O1xuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGJhc2UocG9ydCwgYC8ke2lkfS9zdWJ0YXNrYCksIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoam9iQm9keSksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiBkZWxldGUgPGlkPlwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQsIGAvJHtpZH1gKSwgeyBtZXRob2Q6IFwiREVMRVRFXCIgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgam9iIDxjcmVhdGV8dXBkYXRlIDxpZD58Y2xhaW0gPGlkPiAtLW93bmVyIDx3aG8+fHJlbGVhc2UgPGlkPnxzdWJ0YXNrIDxpZD4gLi4ufGxpc3R8ZGVsZXRlIDxpZD4+XFxuXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImFjdGl2aXR5XCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiYWN0aXZpdHlcIiwgcmVzdCk7XG4gICAgY29uc3Qgc3RhdGUgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgaWYgKHN0YXRlICE9PSBcInJlY2VpdmVkXCIgJiYgc3RhdGUgIT09IFwidGhpbmtpbmdcIiAmJiBzdGF0ZSAhPT0gXCJpZGxlXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGFjdGl2aXR5IDxyZWNlaXZlZHx0aGlua2luZ3xpZGxlPiBbLS1tZXNzYWdlIDxpZD5dXCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpdml0eSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdGUsIG1lc3NhZ2VJZDogcGFyc2VkLnZhbHVlcy5tZXNzYWdlIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJzZW5kXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwic2VuZFwiLCByZXN0KTtcbiAgICAvLyBSb3VuZCAzIChDbGFpbSBDMSk6IGdyYXBldmluZSdzIGJvZHktcmVzb2x1dGlvbiBjaGFpbiwgcHJlY2VkZW5jZVxuICAgIC8vIC0tYm9keS1maWxlID4gLS1zdGRpbiA+IGlubGluZSBwb3NpdGlvbmFsID4gcGlwZWQtc3RkaW4gZGVmYXVsdC5cbiAgICAvLyBTaGFycCBlZGdlIChtZWFzdXJlZCwgaG91c2Utd2lkZSk6IHRoZSBwaXBlZC1zdGRpbiBkZWZhdWx0IEhBTkdTXG4gICAgLy8gRk9SRVZFUiB1bmRlciBhZ2VudCBzaGVsbHMgKGlzVFRZIG51bGwsIG5vIEVPRikg4oCUIG5vIHJlYWQgdGltZW91dCBvblxuICAgIC8vIHB1cnBvc2UgKGl0IHdvdWxkIGJyZWFrIHNsb3cgcGlwZXMpOyBhbHdheXMgcGFzcyBhIGJvZHkuXG4gICAgY29uc3QgaGFzSW5saW5lID0gcGFyc2VkLnBvc2l0aW9uYWxzLmxlbmd0aCA+IDA7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICBsZXQgZnJvbUlubGluZSA9IGZhbHNlO1xuICAgIGlmIChwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHBhdGggPSBwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoYHNlbmQ6IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwYXRofWApO1xuICAgICAgfVxuICAgICAgLy8gVHJhaWxpbmcgbmV3bGluZSBzdHJpcHBlZCAoZmlsZXMgYW5kIGhlcmVkb2NzIGVuZCB3aXRoIG9uZTsgdGhlXG4gICAgICAvLyBtZXNzYWdlIHNob3VsZG4ndCkg4oCUIG1hdGNoaW5nIC0tc3RkaW4sIGFuZCBncmFwZXZpbmUuXG4gICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG4gICAgfSBlbHNlIGlmIChwYXJzZWQudmFsdWVzLnN0ZGluIHx8ICghaGFzSW5saW5lICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgICAgdGV4dCA9IChhd2FpdCBCdW4uc3RkaW4udGV4dCgpKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRleHQgPSBwYXJzZWQucG9zaXRpb25hbHMuam9pbihcIiBcIik7XG4gICAgICBmcm9tSW5saW5lID0gdHJ1ZTtcbiAgICB9XG4gICAgLy8gQW4gRU1QVFkgcmVzb2x2ZWQgYm9keSBpcyBhIHVzYWdlIGVycm9yIChleGl0IDIpLCB3aGF0ZXZlciBwYXRoXG4gICAgLy8gcHJvZHVjZWQgaXQg4oCUIGEgYmxhbmsgbWVzc2FnZSBoZWxwcyBub2JvZHkgYW5kIHVzdWFsbHkgbWVhbnMgYSBmdW1ibGUuXG4gICAgaWYgKHRleHQgPT09IFwiXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBzZW5kIDx0ZXh0Li4uPiB8IC0tYm9keS1maWxlIDxwYXRoPiB8IC0tc3RkaW5cXG5cIiArXG4gICAgICAgICAgXCJtaW5kLW1hcHBlcjogc2VuZCByZXNvbHZlZCBhbiBlbXB0eSBib2R5IOKAlCBub3RoaW5nIHNlbnRcXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIEEgZnVtYmxlZCBoZXJlZG9jIHBpcGVzIHRoZSBsaXRlcmFsIHNlbmQgaW52b2NhdGlvbiBpbiBhcyB0aGUgYm9keSDigJRcbiAgICAvLyByZWZ1c2UgdG8gcG9zdCB0aGF0IChuYXJyb3dlZCB0byB0aGUgc2VuZCB2ZXJiOyAtLWZvcmNlIG92ZXJyaWRlcyBmb3JcbiAgICAvLyBhIGJvZHkgdGhhdCBnZW51aW5lbHkgcXVvdGVzIHRoZSBjb21tYW5kKS5cbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuZm9yY2UgJiYgLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxic2VuZFxcYi8udGVzdCh0ZXh0KSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJtaW5kLW1hcHBlcjogdGhhdCBib2R5IGxvb2tzIGxpa2UgYSBsZWFrZWQgY2xpIGludm9jYXRpb24gKGEgZnVtYmxlZCBoZXJlZG9jPykuIFwiICtcbiAgICAgICAgICBcIk5vdGhpbmcgd2FzIHNlbnQuIFBpcGUgdGhlIHJlYWwgYm9keSB2aWEgLS1zdGRpbiBvciAtLWJvZHktZmlsZSA8cGF0aD4sIFwiICtcbiAgICAgICAgICBcIm9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIElubGluZSBib2RpZXMgd2l0aCBzdXJ2aXZpbmcgc2hlbGwgbWV0YWNoYXJhY3RlcnMgbWFkZSBpdCB0aHJvdWdoIFRISVNcbiAgICAvLyB0aW1lIOKAlCB3YXJuIChzdGRlcnIsIG5ldmVyIGJsb2NrcykgYW5kIHN0ZWVyIHRvIHRoZSBzaGVsbC1mcmVlIHBhdGhzLlxuICAgIGlmIChmcm9tSW5saW5lICYmIC9gfFxcJFxcKHxcXCRcXHsvLnRlc3QodGV4dCkpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBcIiMgd2FybmluZzogaW5saW5lIGJvZHkgY29udGFpbnMgc2hlbGwgbWV0YWNoYXJhY3RlcnMgKGJhY2t0aWNrLCAkKCksIGN1cmx5LWJyYWNlIHZhcnMpLiBcIiArXG4gICAgICAgICAgXCJJdCB3YXMgc2VudCBhcy1pcywgYnV0IHRoZSBzaGVsbCBjYW4gY29tbWFuZC1zdWJzdGl0dXRlIHRoZXNlIGZpcnN0IOKAlCBcIiArXG4gICAgICAgICAgXCJ1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc2VuZCR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcm9sZTogcGFyc2VkLnZhbHVlcy5yb2xlID8/IFwiYWdlbnRcIixcbiAgICAgICAga2luZDogcGFyc2VkLnZhbHVlcy5raW5kID8/IFwidHVyblwiLFxuICAgICAgICB0ZXh0LFxuICAgICAgICAvLyBGbGF0dGVuIHJlcGVhdHMsIHNwbGl0IGNvbW1hcywgZHJvcCBibGFuayBmcmFnbWVudHMg4oCUIGFuIGVtcHR5XG4gICAgICAgIC8vIHJlc29sdmVkIGxpc3QgcG9zdHMgYXMgbm8gZ3JvdW5kIGF0IGFsbCAobmV2ZXIgW1wiXCJdKS5cbiAgICAgICAgZ3JvdW5kOiAoKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlZnMgPSAocGFyc2VkLnZhbHVlcy5ncm91bmQgPz8gW10pXG4gICAgICAgICAgICAuZmxhdE1hcCgoZykgPT4gZy5zcGxpdChcIixcIikpXG4gICAgICAgICAgICAubWFwKChnKSA9PiBnLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoKGcpID0+IGcgIT09IFwiXCIpO1xuICAgICAgICAgIHJldHVybiByZWZzLmxlbmd0aCA+IDAgPyByZWZzIDogdW5kZWZpbmVkO1xuICAgICAgICB9KSgpLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZXNwb25zZVRleHR9XFxuYCk7XG4gICAgLy8gUm91bmQgMTEgKFNFQU0gMSk6IG1pcnJvciB0aGUgZGFlbW9uJ3MgdW5rbm93bi1jaGFubmVsIGFkdmlzb3J5IHRvIHN0ZGVycixcbiAgICAvLyBzYW1lIGFzIHByb3Bvc2UtZWRnZSdzIGRyYWZ0IHdhcm5pbmcg4oCUIGEgdHlwbydkIGAtLWtpbmRgIGlzIG90aGVyd2lzZSBhXG4gICAgLy8gbWVzc2FnZSB0aGF0IHNpbGVudGx5IHJlbmRlcnMgYXMgYSBwbGFpbiBjaGF0IHR1cm4uXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgaWYgKHR5cGVvZiB3YXJuaW5nID09PSBcInN0cmluZ1wiKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB3YXJuaW5nOiAke3dhcm5pbmd9XFxuYCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICAvLyBSb290IGZhbGx0aHJvdWdoIOKAlCBOQU1FIHRoZSBvZmZlbmRpbmcgdG9rZW4sIGFuZCBkaXN0aW5ndWlzaCBmbGFnLXNoYXBlZFxuICAvLyBmcm9tIHZlcmItc2hhcGVkOiBcIi0teCBhdCB0aGUgcm9vdFwiIHNlbmRzIHRoZSBjYWxsZXIgdG8gcHV0IGl0IGFmdGVyIGFcbiAgLy8gdmVyYiwgXCJ1bmtub3duIHZlcmIgeFwiIHNlbmRzIHRoZW0gdG8gdGhlIHJvc3RlciAoY2hvaWNlcykuIEEgYmFyZVxuICAvLyBpbnZvY2F0aW9uIG5hbWVkIG5vdGhpbmcgYXQgYWxsIOKAlCBhIHVzYWdlIGVycm9yLCBub3QgYSBoZWxwIHBhdGggKHRoaXMgQ0xJXG4gIC8vIGlzIGFnZW50LWRyaXZlbjsgbWFncGllJ3MgcnVsaW5nKS5cbiAgLy9cbiAgLy8gY2hvaWNlcyBuYW1lcyBFVkVSWVRISU5HIHRoZSBwYXJzZXIgYWNjZXB0czogdGhlIHJvc3RlciB2ZXJicyBwbHVzIHRoZVxuICAvLyBhY2NlcHRlZCBhbGlhcyBzcGVsbGluZ3MsIGFsaWFzZXMgYXBwZW5kZWQgYWZ0ZXIgdGhlIHJvc3RlclxuICAvLyAoZGV0ZXJtaW5pc3RpYykuIFZFUkJTIGFsb25lIHVuZGVyc3RhdGVkIHRoZSBhY2NlcHRlZCBzZXQgYnkgZXhhY3RseSB0aGVcbiAgLy8gYWxpYXNlcyDigJQgYWNjJ3MgYWR2ZXJ0aXNlZC12ZXJicyBjb21wYXJpc29uIGZsYWdnZWQgYG1lc3NhZ2VgIGFzIHJlY29yZGVkXG4gIC8vIGJ1dCBuZXZlciBhZHZlcnRpc2VkIChncmFwZXZpbmUncyBvbmUtcm93LXBlci1hbGlhcyByZWdpc3RyeSBpcyB0aGUgaG91c2VcbiAgLy8gcHJlY2VkZW50IHRoaXMgbWF0Y2hlcykuIEhlbHAgaXMgTk9UIHRvdWNoZWQ6IHRoZSBhbGlhcyBzdGF5cyBhZHZlcnRpc2VkXG4gIC8vIG9uIGl0cyB0YXJnZXQncyBsaW5lIHBlciB0aGUgIzEwOTcgcnVsaW5nLlxuICBjb25zdCBWRVJCX0NIT0lDRVMgPSBbLi4uVkVSQlMsIC4uLk9iamVjdC5rZXlzKFZFUkJfQUxJQVNFUyldO1xuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcIm5vIHZlcmIgZ2l2ZW5cIiwgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQl9DSE9JQ0VTIH0pO1xuICB9XG4gIGlmICh2ZXJiLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIGB1bmtub3duIGZsYWcgYXQgdGhlIHJvb3Q6ICR7dmVyYn0gKGZsYWdzIGJlbG9uZyBhZnRlciBhIHZlcmI7IHJvb3QgdG9rZW5zIGFyZSAtLWhlbHAvLWggYW5kIC0tdmVyc2lvbi8tVilgLFxuICAgICAgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQl9DSE9JQ0VTIH0sXG4gICAgKTtcbiAgfVxuICB0aHJvdyB1c2FnZUVycm9yKGB1bmtub3duIHZlcmI6ICR7dmVyYn1gLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBWRVJCX0NIT0lDRVMgfSk7XG59XG5cbi8qKlxuICogVGhlIENMSSdzIG9uZSBlbnRyeSwgY2FsbGVkIGJ5IHRoZSBsYXVuY2hlciBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9taW5kLW1hcHBlci9zY3JpcHRzL2NsaS50c2AuXG4gKlxuICog4puUIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIFRIQVQgSVMgVEhFIFBPSU5ULlxuICogYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSB0aGUgbGF1bmNoZXIsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzXG4gKiBlbnRyeSwgc28gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZSBidW5kbGU6IGEgYmxvY2sgaGVyZSB3b3VsZCBuZXZlclxuICogcnVuIGFuZCB0aGUgQ0xJIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kIGV4aXQgMCBmb3IgZXZlcnkgdmVyYi4gVGhpcyBleHBvcnQgaXNcbiAqIHdoYXQgcmVwbGFjZXMgaXQuIEFuZCB0aGUgc291cmNlIGtlZXBzIG5vIHNlY29uZCBlbnRyeSBkZWxpYmVyYXRlbHkg4oCUIHRoZVxuICogYXJpdGhtZXRpYyBhYm92ZSBpcyB0cnVlIGF0IHRoZSBhcnRpZmFjdCdzIGFkZHJlc3MgYW5kIGZhbHNlIGF0IHRoaXMgZmlsZSdzLFxuICogc28gb2ZmZXJpbmcgYGJ1biBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9jbGkudHNgIHdvdWxkIGJlIG9mZmVyaW5nIGEgd3JvbmdcbiAqIHByb2Nlc3MgKHBsYXlib29rIEIzKS5cbiAqXG4gKiDim5QgSVQgUkVUVVJOUyBUSEUgQ09ERSBSQVRIRVIgVEhBTiBTRVRUSU5HIElULiBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbiAqIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlXG4gKiAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdFxuICogZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5XG4gKiB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWVcbiAqIHNoYXBlLCBzYW1lIHJlYXNvbi4gVGhlIGFzc2lnbm1lbnQgaGFwcGVucyBvbmNlLCBpbiB0aGUgbGF1bmNoZXIuIERvIG5vdCB0aWR5XG4gKiB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTOiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVNcbiAqIGl0LCB3aGljaCBpcyB0aGlzIG9uZS4gQSBsYXVuY2hlciByZWFkaW5nIHRoZSBhcmd1bWVudCB2ZWN0b3Igd291bGQgbWF0Y2ggdGhlXG4gKiBhcmctcGFyc2luZyBwcmVkaWNhdGUgaW4gYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgdGhlIGJhY2tlbmQgcG9ydCByZWxvY2F0ZXNcbiAqIGFuZCB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgIG1heSBiZSByZXBsYWNlZCwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdFxuICogcmlzay4gSXQgaXMgbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHNcbiAqIG93biBoZWFkaW5nIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEFcbiAqIERFQUQgQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLiBUd29cbiAqIGZ1cnRoZXIgY29waWVzIGxpdmUgaW4gbWluZC1tYXBwZXIncyBgcHJlc2VuY2UudGVzdC50c2AgYW5kXG4gKiBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogTWluZC1tYXBwZXIncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIG9mIHRoZSBzcGVsbCwgYW5kIFRIRSBPTkUgUExBQ0UgVEhFIEVOViBJUyBSRUFELlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0sIEFORCBGT1IgTUlORC1NQVBQRVIgVEhFIFNFQU0gV0FTIFJFQUwgQU5EXG4gKiBIQU5ELU1JUlJPUkVELiBCZWZvcmUgUGhhc2UgNyB0aGUga2VlcGFsaXZlIHdhcyBhIGxpdGVyYWwgYDE1XzAwMGAgaW5zaWRlXG4gKiBgc2VydmVyLnRzYCdzIGBrZWVwYWxpdmVNcygpYCwgYGlkbGVUaW1lb3V0OiAyNTVgIHdhcyBhIHNlY29uZCBsaXRlcmFsIGFcbiAqIGh1bmRyZWQgbGluZXMgYXdheSB3aXRoIHRoZSByZWxhdGlvbnNoaXAgd3JpdHRlbiBvbmx5IGluIHByb3NlLCBhbmQgdGhlXG4gKiBDTEkncyB0YWlsIGNhcnJpZWQgYSBIQVJELUNPREVEIGA0NV8wMDBgIHdhdGNoZG9nIHVuZGVyIGEgY29tbWVudCBzYXlpbmdcbiAqIFwi4omIIDMgbWlzc2VkIHNlcnZlciBrZWVwYWxpdmVzICgxNXMgdGljaywgQ2xhaW0gRilcIiDigJQgdGhyZWUgbnVtYmVycywgdHdvXG4gKiBmaWxlcywgYW5kIHRoZSBhcml0aG1ldGljIHR5aW5nIHRoZW0gdG9nZXRoZXIgbGl2aW5nIGluIGEgc2VudGVuY2UuIE5laXRoZXJcbiAqIGZpbGUgY291bGQgaW1wb3J0IHRoZSBvdGhlcjogdGhlIENMSSByZWFjaGluZyBpbnRvIHRoZSBkYWVtb24gd291bGQgZHJhZyB0aGVcbiAqIHdob2xlIDIzLW1vZHVsZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aG9zZSBvbmx5IGltcG9ydHNcbiAqIGFyZSB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqICoqQSB2YWx1ZSB0aGF0IGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0KiosIGFuZCB0aGVcbiAqIFwi4omIXCIgaW4gdGhhdCBjb21tZW50IGlzIG5vdyBhbiBgPWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gTUlORC1NQVBQRVInUyBPV04gSEVBUlRCRUFULCBORVZFUlxuICogQ09QSUVEIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgdGhlIHJ1bGUgYXN0cm9sYWJlIHBhaWQgZm9yOiBhIGhhcmQtY29kZWRcbiAqIDQ1IHMgd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcyxcbiAqICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHlcbiAqIGJlY2F1c2UgYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4g4pqgIE1pbmQtbWFwcGVyIGlzIHRoZVxuICogc3BlbGwgdGhhdCB3YXMgT05FIEVOViBWQVIgYXdheSBmcm9tIHRoYXQgZXhhY3QgZGVmZWN0OiBpdHMga2VlcGFsaXZlIGFscmVhZHlcbiAqIHRvb2sgYE1JTkRfTUFQUEVSX0tFRVBBTElWRV9NU2AgKGl0cyBvd24gcHJlc2VuY2Ugc3VpdGUgZHJpdmVzIGl0IGF0IDI1IG1zKVxuICogd2hpbGUgdGhlIHdhdGNoZG9nIHdhcyBhIGxpdGVyYWwsIHNvIGFueSBrZWVwYWxpdmUgYWJvdmUgMTUgcyBhbHJlYWR5IGJyb2tlXG4gKiBldmVyeSB0YWlsIGFuZCBhbnkga2VlcGFsaXZlIGJlbG93IGl0IG1hZGUgdGhlIHdhdGNoZG9nIHRvbGVyYXRlIGZhciBtb3JlXG4gKiB0aGFuIHRocmVlIG1pc3NlZCBiZWF0cy4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tIHRoZVxuICogYmVhdCBpdCBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDim5QgKipUSEUgRU5WIElTIFJFU09MVkVEIEhFUkUgQU5EIE5PV0hFUkUgRUxTRSAoRDc1KSwgQU5EIEZPUiBUSElTIFNQRUxMIFRIQVRcbiAqIFJVTEUgSVMgTE9BRC1CRUFSSU5HIFJBVEhFUiBUSEFOIFRJRFkuKiogR3JhcGV2aW5lJ3MgcG9ydCBzaGlwcGVkIHRoZSBiZWF0J3NcbiAqIGtub2IgaW4gYGRhZW1vbi50c2AgYW5kIGxlZnQgaXRzIHNlYW0gZmlsZSBkZXJpdmluZyB0aGUgd2F0Y2hkb2cgZnJvbSB0aGVcbiAqIExJVEVSQUwgZGVmYXVsdDogdGhlIGRhZW1vbidzIGJlYXQgd2FzIHR1bmFibGUgYW5kIHRoZSBDTEkncyB3YXRjaGRvZyB3YXNcbiAqIG5vdCwgYW5kIGFueSB2YWx1ZSBhYm92ZSB0aGUgZGVmYXVsdCBicm9rZSBldmVyeSB0YWlsIOKAlCBpbnZpc2libGUgYXQgdGhlXG4gKiBkZWZhdWx0LCB3aGljaCBpcyB3aHkgaXQgc2hpcHBlZC4gVGhlIGdlbmVyYWxpc2F0aW9uOiAqKmFuIGVudiBrbm9iIG11c3QgYmVcbiAqIHJlc29sdmVkIGF0IHRoZSBMT1dFU1QgcG9pbnQgZXZlcnkgY29uc3VtZXIgb2YgdGhlIGRlcml2ZWQgdmFsdWUgY2FuIHNlZS4qKlxuICogYHByb2Nlc3MuZW52YCBpcyBhbWJpZW50IGluIGJvdGggaGFsdmVzLCB3aGljaCBpcyBleGFjdGx5IHdoeSB0aGlzIGZpbGUg4oCUIGFuZFxuICogbm90IGBzZXJ2ZXIudHNgIOKAlCBjYW4gaG9sZCB0aGUgcmVzb2x1dGlvbiwgYW5kIHJlYWRpbmcgaXQgaGVyZSBpcyBub3QgdGhlXG4gKiBraW5kIG9mIGltcG9ydCB0aGF0IGNsb3NlcyB0aGUgc2VhbS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIERFUklWQVRJT04gU1VQUExJRVMgVEhFIERFRkFVTFQsIE5PVCBUSEUgVkFMVUUgKEQ4MikuKiogVGhlIHR3b1xuICogdGFpbCBrbm9icyBiZWxvdyBhcmUgdGhlIHJlYXNvbjogYGJhY2tlbmQvdGFpbC50ZXN0LnRzYCBpcyB0aGUgcmVwbydzIE9OTFlcbiAqIGV4ZWN1dGFibGUgdGFpbCBzcGVjaWZpY2F0aW9uLCBpdCBpcyB0aGlzIHBvcnQncyBPUkFDTEUsIGFuZCBhbGwgZm91ciBvZiBpdHNcbiAqIGNlbGxzIGRyaXZlIGBNSU5EX01BUFBFUl9UQUlMX0lETEVfTVM9MjAwYCAvIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TPTUwYC5cbiAqIFdyaXR0ZW4gZ2xhbW91cidzIHdheSDigJQgdGhyZWUgcGxhaW4gYGV4cG9ydCBjb25zdGBzIHdpdGggbm8gb3ZlcnJpZGUgYW55d2hlcmVcbiAqIOKAlCB0aGUgaWRsZS13YXRjaGRvZyBjZWxsIEZBSUxTIChhIDQ1LDAwMCBtcyB3YXRjaGRvZyBjYW5ub3QgZmlyZSBpbnNpZGUgaXRzXG4gKiA1IHMgZGVhZGxpbmUsIGFuZCBpdCByZWFkcyBhcyBhIGJyb2tlbiB3YXRjaGRvZykgYW5kIHRoZSBrZWVwYWxpdmUgY2VsbFxuICogKipQQVNTRVMgVkFDVU9VU0xZKio6IGl0IGFzc2VydHMgdGhhdCBub3RoaW5nIHdhcyBhYm9ydGVkLCBhbmQgNDUgcyBjYW5ub3RcbiAqIGFib3J0IGFueXRoaW5nIGluc2lkZSBpdHMgODAwIG1zIHdpbmRvdy4gQSBncmVlbiBjZWxsIHRoYXQgbG9zdCBpdHMgc3ViamVjdFxuICogaXMgd29yc2UgdGhhbiBhIHJlZCBvbmUuIOKaoCBBbmQgdGhlIGtub2IgY2Fubm90IGJlIHJvdXRlZCB0aHJvdWdoIHRoZSBCRUFUXG4gKiBpbnN0ZWFkOiB0aGUga2l0IGZsb29ycyBgaGVhcnRiZWF0TXNgIGF0IGBNSU5fSEVBUlRCRUFUX01TID0gNTAwYCAoRDc2IOKAlCB0aGVcbiAqIGZsb29yIGxpdmVzIGF0IHRoZSBkZXJpdmF0aW9uKSwgc28gdGhlIHNtYWxsZXN0IHdhdGNoZG9nIHJlYWNoYWJsZSB0aHJvdWdoXG4gKiBgdGFpbElkbGVNc2AgaXMgMSw1MDAgbXMgYW5kICoqMjAwIG1zIGlzIHVucmVhY2hhYmxlIHRoYXQgd2F5IGJ5XG4gKiBjb25zdHJ1Y3Rpb24uKiogYHRhaWxJZGxlTXNgIGNhcnJpZXMgbm8gZmxvb3Igb2YgaXRzIG93biwgc28gYSBkaXJlY3RcbiAqIG92ZXJyaWRlIHJlYWNoZXMgaXQuXG4gKlxuICog4pqgICoqVGhlIG1hcHBpbmcgYmVsb3cgd2FzIHdyaXR0ZW4gZWlnaHQgbW9udGhzIGVhcmx5IGFuZCBhZGRyZXNzZWQgdG9cbiAqIG5vYm9keSoqIOKAlCBgcGhhc2UtMS1qb3VybmFsLm1kOjE1MS0xNTVgIG5hbWVkIGBNSU5EX01BUFBFUl9UQUlMX0lETEVfTVNgIOKGklxuICogYGlkbGVNc2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCDihpIgYHJldHJ5LmluaXRpYWxNc2AgYW5kIGNvbmNsdWRlZFxuICogXCJhIHNwZWxsIHdob3NlIHRlc3RzIGRyaXZlIGEgc2hvcnQgd2luZG93IHdpbGwgbmVlZCBvbmUsIGFuZCBpdCBzaG91bGQgYmVcbiAqIHRoYXQgc3BlbGwncyBlbnYgdmFyLCBub3QgdGhlIGtpdCdzXCIuIFRoaXMgaXMgdGhhdCBzcGVsbCAoRDg0KS5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIGhlYXJ0YmVhdE1zLFxuICBpZGxlVGltZW91dFNlYyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBBIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIG9yIHRoZSBmYWxsYmFjay5cbiAqXG4gKiDimqAgVEhFIEtJVCdTIGBpbnRPcmAgSVMgTk9UIEVYUE9SVEVELCBkZWxpYmVyYXRlbHkg4oCUIGl0IGlzIHRoZSBwcml2YXRlIHBhcnNlclxuICogYmVoaW5kIGBoZWFydGJlYXRNc2AvYGlkbGVUaW1lb3V0U2VjYCwgYW5kIEQ3NiBydWxlZCB0aGF0IGEga25vYiB3aXRoIGEga25vd25cbiAqIHNhZmUgbWluaW11bSBjbGFtcHMgYXQgaXRzIERFUklWQVRJT04gcmF0aGVyIHRoYW4gaW4gdGhlIHNoYXJlZCBwYXJzZXIuIFNvXG4gKiB0aGlzIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGNvcHkgb2YgdGhlIHNhbWUgdGhyZWUgbGluZXMsIHdpdGggdGhlIHNhbWVcbiAqIGBwYXJzZUludGAgc2VtYW50aWNzIHRoZSBraXQgZG9jdW1lbnRzIChgXCIxZTlcImAgaXMgMSwgYFwiNWFiY1wiYCBpcyA1KSBhbmQgdGhlXG4gKiBzYW1lIFwiYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlIHRha2VzIHRoZSBmYWxsYmFja1wiIHJ1bGUuXG4gKiBJdCBpcyB0aGUgZXhwcmVzc2lvbiB0aGUgQ0xJJ3Mgb3duIGBlbnZNc2AgdXNlZCBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQuXG4gKlxuICog4puUIEFORCBUSEUgVFdPIFRBSUwgS05PQlMgQkVMT1cgREVMSUJFUkFURUxZIEhBVkUgTk8gRkxPT1IuIEEgd2F0Y2hkb2cgYW5kIGFcbiAqIHJlY29ubmVjdCBkZWxheSBhcmUgdGhlIHR3byB2YWx1ZXMgdGhpcyBzcGVsbCdzIG93biB0ZXN0IHN1aXRlIG11c3QgYmUgYWJsZVxuICogdG8gZHJpdmUgRE9XTiB0byAyMDAgbXMgYW5kIDUwIG1zOyBhIGZsb29yIGhlcmUgd291bGQgbWFrZSB0aGUgb3JhY2xlXG4gKiB1bnJlYWNoYWJsZSwgd2hpY2ggaXMgdGhlIGRlZmVjdCBEODIgd2FzIHdyaXR0ZW4gYWJvdXQuIFRoZSBmbG9vciBleGlzdHNcbiAqIHdoZXJlIHRoZSBmbG9vZCByaXNrIGlzIOKAlCBvbiB0aGUgQkVBVCwgaW4gdGhlIGtpdC5cbiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBNaW5kLW1hcHBlcidzIG93biBtZWFzdXJlZCB2YWx1ZSxcbiAqIG5vdCBhbiBpbmhlcml0ZWQgb25lOiBgc2VydmVyLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB1bmRlciBhIGNvbW1lbnRcbiAqIHJlY29yZGluZyB0aGF0IFNTRSBhbmQgV1MgY29ubmVjdGlvbnMgb24gYC9ldmVudHNgIHNpdCBpZGxlIGJldHdlZW4gZW1pdHMgYnlcbiAqIGRlc2lnbiwgdGhhdCBCdW4ncyBkZWZhdWx0IDEwIHMgd291bGQgcmVzZXQgYSBxdWlldCBzdHJlYW0sIGFuZCB0aGF0IGAwYCBpc1xuICogbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgc3RhbGxzIHRoZSBpbml0aWFsIHJlc3BvbnNlIOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYVxuICogY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uXG4gKlxuICog4pqgIGBNSU5EX01BUFBFUl9JRExFX1RJTUVPVVRfU0VDYCBpcyBhY2NlcHRlZCBzbyB0aGUgUEFJUiBjYW4gYmUgdHVuZWRcbiAqIHRvZ2V0aGVyLCBhbmQgdGhlIGNsYW1wIGluIGBoZWFydGJlYXRNc2AgYmVsb3cgaXMgd2hhdCBrZWVwcyB0aGVtIGEgcGFpci5cbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBpZGxlVGltZW91dFNlYyhcbiAgcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfSURMRV9USU1FT1VUX1NFQyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4pO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBhbmQgbWluZC1tYXBwZXIncyBvd24gbGl0ZXJhbCAoQ2xhaW0gRidzIDE1IHNcbiAqICB0aWNrKSBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQg4oCUIHRoZSBERUZBVUxULCBiZWZvcmUgdGhlIGVudiBpcyBjb25zdWx0ZWQuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKlxuICogVGhlIFNTRSBrZWVwYWxpdmUsIGluIG1zLCBlbnYtcmVzb2x2ZWQgYW5kIGNsYW1wZWQgYXQgYm90aCBlbmRzIGJ5IHRoZSBraXQ6XG4gKiBuZXZlciBhYm92ZSBgSURMRV9USU1FT1VUX1NFQyAvIDJgIChvciBCdW4gY2xvc2VzIHRoZSBjb25uZWN0aW9uIHRoZVxuICoga2VlcGFsaXZlIHdhcyBwcmVzZXJ2aW5nKSwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIOKblCBUSEUgRkxPT1IgSVMgTk9UIERFQ09SQVRJT04gKEQ3NikuIGBNSU5EX01BUFBFUl9LRUVQQUxJVkVfTVNgIGlzIGEga25vYlxuICogbWluZC1tYXBwZXIncyBvd24gcHJlc2VuY2Ugc3VpdGUgZHJpdmVzLCBhbmQgYHBhcnNlSW50YCByZWFkcyBgXCIxZTlcImAg4oCUIHRoZVxuICogbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0IGh1Z2VcIiDigJQgYXMgKioxKiouIERyaXZlbiBhdCBncmFwZXZpbmUnc1xuICogcmVwYWlyIGJlZm9yZSB0aGUgZmxvb3IgZXhpc3RlZDogYSAxIG1zIGJlYXQgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG9cbiAqIGV2ZXJ5IG9wZW4gU1NFIGNsaWVudCBpbiA1MjggbXMuXG4gKlxuICog4pqgIEFORCBGT1IgVEhJUyBTUEVMTCBUSEUgQkVBVCBBTFNPIEJPVU5EUyBBIEhVTUFOLVZJU0lCTEUgTlVNQkVSLiBQcmVzZW5jZVxuICogKENsYWltIEMpIGlzIGNvdW50ZWQgYXQgU1NFIHN1YnNjcmliZS91bnN1YnNjcmliZSBhbmQgYSBkZWFkIHNvY2tldCBpcyBvbmx5XG4gKiByZWNsYWltZWQgd2hlbiB0aGUgbmV4dCBrZWVwYWxpdmUgd3JpdGUgZmFpbHMsIHNvIHJhaXNpbmcgdGhpcyBrbm9iIG1ha2VzIHRoZVxuICogYWdlbnQgY291bnQgaW4gdGhlIGJvYXJkJ3MgYWN0aXZpdHkgaW5kaWNhdG9yIHN0YWxlciwgbm90IGp1c3QgcXVpZXRlci5cbiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfS0VFUEFMSVZFX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuIDQ1LDAwMCBtcyBhdCB0aGUgZGVmYXVsdCDigJRcbiAqIHdoaWNoIGlzIHRoZSBudW1iZXIgYGNsaS50c2AgdXNlZCB0byBoYXJkLWNvZGUsIHNvIHRoZSBwb3J0IGNoYW5nZXMgbm9cbiAqIGRlZmF1bHQgd2hpbGUgbWFraW5nIHRoZSByZWxhdGlvbnNoaXAgdHJ1ZSBhdCBldmVyeSBvdGhlciB2YWx1ZS5cbiAqXG4gKiDim5QgREVSSVZFRCBGUk9NIFRIRSBSRVNPTFZFRCBCRUFULCBORVZFUiBGUk9NIFRIRSBERUZBVUxUIOKAlCBncmFwZXZpbmUnc1xuICogcmVwYWlyIGNoYXB0ZXIgaXMgd2hhdCB0aGUgZGlmZmVyZW5jZSBjb3N0LiBBbmQgdGhlIGVudiBvdmVycmlkZSBpcyB0aGVcbiAqIEZBTExCQUNLJ3MgcmVwbGFjZW1lbnQsIG5vdCB0aGUgZGVyaXZhdGlvbidzOiB0aGUgZGVyaXZhdGlvbiBpcyB3aGF0IHRoZSBrbm9iXG4gKiBmYWxscyBiYWNrIHRvLCBzbyBhbiB1bnR1bmVkIHRhaWwgc3RpbGwgd2F0Y2hlcyB0aHJlZSBvZiB0aGlzIGRhZW1vbidzIGJlYXRzLlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gaW50T3IoXG4gIHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX1RBSUxfSURMRV9NUyxcbiAgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKSxcbik7XG5cbi8qKlxuICogVGhlIHJlY29ubmVjdCBiYWNrb2ZmJ3MgRklSU1QgZGVsYXksIGluIG1zLiAxLDAwMCB0b2RheSwgd2hpY2ggaXMgd2hhdFxuICogYGNsaS50c2AncyBgcmV0cnlNc2AgZGVmYXVsdGVkIHRvLlxuICpcbiAqIOKblCBBTkQgVEhFIFNIQVBFIENIQU5HRVMgRVZFTiBUSE9VR0ggVEhFIE5VTUJFUiBET0VTIE5PVDogdGhlIGhhbmQtcm9sbGVkXG4gKiBsb29wIHNsZXB0IHRoaXMgbG9uZyBhZnRlciBFVkVSWSBmYWlsZWQgYXR0ZW1wdCwgZmxhdCwgZm9yZXZlciDigJQgYVxuICogY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtLCBhbmQgbWluZC1tYXBwZXIgaXMgdGhlIHNwZWxsXG4gKiBgdGFpbEV2ZW50c2AncyBvd24gd2FybmluZyBhYm91dCB0aGF0IGJyYW5jaCB3YXMgd3JpdHRlbiBhYm91dC4gVGhlIGtpdFxuICogZG91YmxlcyBpdCB0byBgbWF4TXNgIGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4sIHNvIGEgZGVhZCBkYWVtb24gaXNcbiAqIGJhY2tlZCBvZmYgZnJvbSBpbnN0ZWFkIG9mIGhhbW1lcmVkLlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9SRVRSWV9NUyA9IGludE9yKHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX1RBSUxfUkVUUllfTVMsIDFfMDAwKTtcblxuLyoqIFRoZSBiYWNrb2ZmIGNlaWxpbmcsIHRoZSBraXQncyBkZWZhdWx0LCBzdGF0ZWQgaGVyZSBzbyBib3RoIGhhbHZlcyBjYW4gc2VlXG4gKiAgdGhlIHdob2xlIHJldHJ5IHNoYXBlIGluIG9uZSBwbGFjZSByYXRoZXIgdGhhbiBoYWxmIG9mIGl0LiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfUkVUUllfTUFYX01TID0gNV8wMDA7XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBMEdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3pETyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQUdaLFNBQVMsaUJBQWlCLEdBQWtCO0FBQUEsRUFDakQsT0FBTztBQUFBO0FBU0YsU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8sVUFBVSxFQUFFLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQztBQUFBLFNBRS9DLE9BQU8sV0FBVyxZQUFZLEVBQUUsUUFBUSxNQUFNLE9BQU8sSUFBSSxDQUFDO0FBQUEsSUFDaEU7QUFBQSxJQUNBLE1BQU0sRUFBRSxTQUFTLGVBQWU7QUFBQSxFQUNsQyxDQUFDO0FBQUE7QUFBQTtBQUFBO0FBSUksTUFBTSxpQkFBaUIsTUFBTTtBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBRVQsV0FBVyxDQUFDLE1BQWUsU0FBaUIsT0FBa0I7QUFBQSxJQUM1RCxNQUFNLE9BQU87QUFBQSxJQUNiLEtBQUssT0FBTztBQUFBLElBQ1osS0FBSyxPQUFPO0FBQUEsSUFDWixLQUFL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LFVBQVU7QUFBQSxFQUN6QixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsYUFBYSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzlCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsS0FBSyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3RCLFlBQVksRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUM3QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBR3pCLFFBQVEsRUFBRSxNQUFNLFVBQVUsVUFBVSxLQUFLO0FBQUEsRUFDekMsU0FBUyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQzNCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsV0FBVyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQzdCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixLQUFLLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdEIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLFVBQVUsRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUM1QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsUUFBUSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3pCLE9BQU8sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN6QixVQUFVLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDM0IsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLElBQUks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QVEsWUFBWSxLQUFLLE1BQU0sWUFBWTtBQUFBLE1BQzNDLElBQUksT0FBTyxZQUFZO0FBQUEsUUFBVSxRQUFRLE9BQU8sTUFBTSxjQUFjO0FBQUEsQ0FBVztBQUFBLE1BQy9FLE1BQU07QUFBQSxJQUdSLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFlQSxNQUFNLGVBQWUsQ0FBQyxHQUFHLE9BQU8sR0FBRyxPQUFPLEtBQUssWUFBWSxDQUFDO0FBQUEsRUFDNUQsSUFBSSxTQUFTLFdBQVc7QUFBQSxJQUN0QixNQUFNLFdBQVcsaUJBQWlCLEVBQUUsTUFBTSxvQkFBb0IsU0FBUyxhQUFhLENBQUM7QUFBQSxFQUN2RjtBQUFBLEVBQ0EsSUFBSSxLQUFLLFdBQVcsR0FBRyxHQUFHO0FBQUEsSUFDeEIsTUFBTSxXQUNKLDZCQUE2QixnRkFDN0IsRUFBRSxNQUFNLG9CQUFvQixTQUFTLGFBQWEsQ0FDcEQ7QUFBQSxFQUNGO0FBQUEsRUFDQSxNQUFNLFdBQVcsaUJBQWlCLFFBQVEsRUFBRSxNQUFNLG9CQUFvQixTQUFTLGFBQWEsQ0FBQztBQUFBO0FBNkIvRixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI1NjJDNUU4RjEyRDVBNUZBNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
