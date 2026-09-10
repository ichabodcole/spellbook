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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS9lcnJvcnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWluZC1tYXBwZXIvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIG1pbmQtbWFwcGVyIOKAlCB0aGUgZnVsbCB2ZXJiIHNldCAoVjEgKyBWMS54ICsgUm91bmQgMyk6XG4vLyAgIG9wZW4gICAgICAgICAgc3Bhd24gKG9yIGZpbmQpIHRoZSBkYWVtb24sIHByaW50IGl0cyB1cmwsIG9wZW4gdGhlIGJyb3dzZXJcbi8vICAgICAgICAgICAgICAgICAtLXByb2plY3QgPGlkPiBzY29wZXMgdGhlIHVybCAoP3Byb2plY3Q9KTsgb3BlbiBuZXZlciBtaW50cyDigJRcbi8vICAgICAgICAgICAgICAgICBhbiB1bmtub3duIGlkIGVycm9ycyAodXNlIHByb2plY3RzIC0tY3JlYXRlIGZpcnN0KVxuLy8gICAgICAgICAgICAgICAgIC0tcG9ydCA8bj4gYmluZHMgYSBTVEFCTEUgcG9ydCBzbyBhIGJyb3dzZXIgcmVmcmVzaCByZWNvbm5lY3RzXG4vLyAgICAgICAgICAgICAgICAgYWNyb3NzIGFuIGVudmlyb25tZW50LXJlYXAgKyByZXN0YXJ0LiBUd28gd3JpbmtsZXM6ICgxKSBhZ2FpbnN0XG4vLyAgICAgICAgICAgICAgICAgYSBMSVZFIGRhZW1vbiAtLXBvcnQgTiBpcyBJR05PUkVEIChvcGVuIHJldHVybnMgdGhlIGV4aXN0aW5nXG4vLyAgICAgICAgICAgICAgICAgZGFlbW9uKSDigJQgdGhlIHN0YWJsZSB1cmwgaG9sZHMgb25seSBpZiB0aGUgRklSU1Qgb3BlbiBzZXQgaXQ7XG4vLyAgICAgICAgICAgICAgICAgKDIpIGlmIHBvcnQgTiBpcyBhbHJlYWR5IGluIHVzZSB0aGUgZGFlbW9uIGV4aXRzIGFuZCB0aGlzIHBvbGxcbi8vICAgICAgICAgICAgICAgICB0aW1lcyBvdXQgKFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cFwiKSDigJQgcGljayBhIGZyZWUgcG9ydC5cbi8vICAgc3RhdGUgICAgICAgICBHRVQgL3N0YXRlIOKGkiB0aGUgcmVhbCBwcm9qZWN0IHNuYXBzaG90IG9uIHN0ZG91dFxuLy8gICAgICAgICAgICAgICAgIC0tc2tlbGV0b24gcmV0dXJucyBpZHMvdGl0bGVzL2RlZ3JlZSBvbmx5IChjb250ZXh0IGJ1ZGdldGluZylcbi8vICAgICAgICAgICAgICAgICBmcmVzaCBzdG9yZSB3aXRoIG5vIHByb2plY3Qg4oaSIHRoZSBuZWVkcy1wcm9qZWN0IDQwOSByaWRlc1xuLy8gICAgICAgICAgICAgICAgIHRoZSBlcnJvciBlbnZlbG9wZSAoY29uZmxpY3QsIGV4aXQgNjsgYm9keSB1bmRlciBlcnJvci5zZXJ2ZXIpXG4vLyAgIHRhaWwgICAgICAgICAgTW9uaXRvci1zaGFwZWQ6IEdFVCAvZXZlbnRzP3NpbmNlPTxjdXJzb3I+IFNTRSDihpIgb25lIEpTT05cbi8vICAgICAgICAgICAgICAgICBsaW5lIHBlciBldmVudCBvbiBzdGRvdXRcbi8vICAgICAgICAgICAgICAgICAtLWluYm91bmQgZmlsdGVycyBzZXJ2ZXItc2lkZSB0byBodW1hbi1vcmlnaW5hdGVkIGV2ZW50c1xuLy8gICAgICAgICAgICAgICAgIChjaGF0ICsgZHJvcHBlZCBub2RlcykgKyBvcGVucyB3aXRoIGEga2luZDpcImdyb3VuZGluZ1wiIGxpbmVcbi8vICAgcHJvamVjdHMgICAgICBsaXN0IHNhdmVkIHByb2plY3RzOyAtLWNyZWF0ZSA8dGl0bGU+IG1ha2VzIGEgbmV3IG9uZVxuLy8gICBpbmdlc3QgICAgICAgIC0tdGl0bGUgVCAoLS1maWxlIFAgfCAtLXN0ZGluKSDihpIgUE9TVCAvaW5nZXN0XG4vLyAgIHByb3Bvc2Utbm9kZSAgLS1zdGRpbiBKU09OIHtkcmFmdCwgZXZpZGVuY2UsIHN1Z2dlc3RlZFRpZXI/fSDihpIgUE9TVCAvcHJvcG9zYWxzXG4vLyAgIHByb3Bvc2UtZWRnZSAgc2FtZSBzaGFwZSwga2luZDogXCJlZGdlXCIgKHNvdXJjZS90YXJnZXQgbWF5IGJlIGEgcmVhbCBub2RlXG4vLyAgICAgICAgICAgICAgICAgaWQgT1IgYSBwZW5kaW5nIHByb3Bvc2FsJ3MgaWQg4oCUIHJhdGlmeSByZXNvbHZlcyB0aGUgbGF0dGVyKVxuLy8gICAgICAgICAgICAgICAgIC0tem9uZSA8aWQ+IHN0YWdlcyB0aGUgcHJvcG9zYWwgaW4gYSB6b25lXG4vLyAgIHByb3Bvc2UtYmF0Y2ggLS1zdGRpbiBKU09OIHtub2Rlczpbe3JlZiwgZHJhZnQsIC4uLn1dLCBlZGdlczpbe2RyYWZ0Ontcbi8vICAgICAgICAgICAgICAgICBzb3VyY2UsIHRhcmdldCwgbGFiZWw/fX1dfSDigJQgb25lIHRyYW5zYWN0aW9uOyBhbiBlZGdlXG4vLyAgICAgICAgICAgICAgICAgZW5kcG9pbnQgbWF5IGJlIGEgbm9kZSdzIExPQ0FMIFJFRiAocmVzb2x2ZWQgdG8gdGhlIG1pbnRlZFxuLy8gICAgICAgICAgICAgICAgIGlkIHNlcnZlci1zaWRlKSwgYSByZWFsIG5vZGUgaWQsIG9yIGEgcGVuZGluZyBwcm9wb3NhbCBpZC5cbi8vICAgICAgICAgICAgICAgICBSZXR1cm5zIHtyZWZUb0lkLCBwcm9wb3NhbHN9XG4vLyAgIHJlYWQgPGlkPiAgICAgR0VUIC9tZXNzYWdlLzppZCDihpIgdGhlIGZ1bGwgbWVzc2FnZSByb3cgKGFsaWFzOiBtZXNzYWdlIDxpZD4pXG4vLyAgIG5vZGUgYW5jaG9yIDxpZD4gKC0tdG8gPHBhcmVudElkPiB8IC0tY2xlYXIpICBQT1NUIC9ub2Rlcy86aWQvYW5jaG9yIOKAlFxuLy8gICAgICAgICAgICAgICAgIGFuY2hvciBhIHJlYWwgbm9kZSB1bmRlciBhIHBhcmVudCBpbiB0aGUgc3VibWFwIHRyZWUsIG9yXG4vLyAgICAgICAgICAgICAgICAgLS1jbGVhciB0byBtb3ZlIGl0IGJhY2sgdG8gdG9wLWxldmVsIChjeWNsZXMgcmVqZWN0ZWQpXG4vLyAgIHpvbmUgICAgICAgICAgY3JlYXRlIDxuYW1lPiAoc2x1ZyBpZCBkZXJpdmVkKSB8IGxpc3QgfCBkZWxldGUgPGlkPiBbLS15ZXNdXG4vLyAgICAgICAgICAgICAgICAgKGRlbGV0ZSBjYXNjYWRlcyB0aGUgem9uZSdzIHByb3Bvc2FsczsgcG9wdWxhdGVkIHpvbmVzIDQwOVxuLy8gICAgICAgICAgICAgICAgIHdpdGhvdXQgLS15ZXMpXG4vLyAgIHByb21vdGUgPGlkPiAgbW92ZSBhIHpvbmVkIHBlbmRpbmcgcHJvcG9zYWwgdG8gdGhlIG1haW4gcmV2aWV3IHF1ZXVlXG4vLyAgICAgICAgICAgICAgICAgKGVkZ2UgZW5kcG9pbnRzIG11c3QgcHJvbW90ZSBmaXJzdCDigJQgZXJyb3IgbmFtZXMgdGhlbSlcbi8vICAgcHJvcG9zYWwgem9uZSA8aWQ+ICgtLXRvIDx6b25lSWQ+IHwgLS1jbGVhcikgIFBPU1QgL3Byb3Bvc2Fscy86aWQvem9uZSDigJRcbi8vICAgICAgICAgICAgICAgICBtb3ZlIGEgUEVORElORyBwcm9wb3NhbCBJTlRPIGEgem9uZSAodGhlIGludmVyc2Ugb2YgcHJvbW90ZSksXG4vLyAgICAgICAgICAgICAgICAgb3IgLS1jbGVhciB0byBtb3ZlIGl0IGJhY2sgdG8gbWFpblxuLy8gICBkb2MgPGlkPiAgICAgIEdFVCAvZG9jLzppZCDihpIgdGhlIGRvYyBlbnZlbG9wZSBvbiBzdGRvdXRcbi8vICAgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSAgREVMRVRFIC9kb2MvOmlkIOKGkiA0MDkge2Vycm9yOlwiY2l0ZWRcIiwgY2l0ZWRCeX1cbi8vICAgICAgICAgICAgICAgICB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuLy8gICBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kPiBbLS1hdXRob3IgdXNlcnxhZ2VudF0gfCBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJcbi8vICAgICAgICAgICAgICAgICBQT1NUIC9kb2MvOmlkL2tpbmQg4oCUIGFzc2VydCAob3IgY2xlYXIpIGEgZG9jJ3Mga2luZDsgaW5nZXN0XG4vLyAgICAgICAgICAgICAgICAgbmV2ZXIgZ3Vlc3NlcyBvbmUgKHVudHlwZWQgPSBraW5kIG51bGwgb24gdGhlIHdpcmUpXG4vLyAgIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICBQT1NUIC9kb2MvOmlkL21hcmsg4oaSIGFwcGVuZCBhXG4vLyAgICAgICAgICAgICAgICAgc3RhdHVzIG1hcmsgKGRvYy5tYXJrZWQgY2FycmllcyB0aGUgZnVsbCBtYXJrIGlubGluZSlcbi8vICAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgIFBVVC9ERUxFVEVcbi8vICAgICAgICAgICAgICAgICAvYWN0aW9ucy86dGFyZ2V0SWQg4oCUIHJlcGxhY2UgKHdob2xlc2FsZSkgb3IgY2xlYXIgdGhlXG4vLyAgICAgICAgICAgICAgICAgYWN0aW9uIHNsb3RzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuXG4vLyAgICAgICAgICAgICAgICAgYXJyYXkgb2Yge2lkLCBsYWJlbCwgc2VlZH07ID40IGVudHJpZXMgd2FybnMgKHNvZnQgY2FwKVxuLy8gICB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgUFVUL0RFTEVURVxuLy8gICAgICAgICAgICAgICAgIC90YWdzLzp0YXJnZXRJZCDigJQgcmVwbGFjZSAod2hvbGVzYWxlKSBvciBjbGVhciB0aGUgZnJlZWZvcm1cbi8vICAgICAgICAgICAgICAgICB0YWdzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuIGFycmF5IG9mXG4vLyAgICAgICAgICAgICAgICAgc3RyaW5nczsgdGFncyBhbHNvIHJpZGUgcHJvcG9zZS0qIHN0ZGluIEpTT04gKGEgYHRhZ3NgIGtleSlcbi8vICAgam9iICAgICAgICAgICBjcmVhdGUgLS10aXRsZSBUIFstLXN0YXR1cyBzXSBbLS1kZWxpdmVyYWJsZSByZWZdIFstLWRldGFpbCB4XVxuLy8gICAgICAgICAgICAgICAgIHwgdXBkYXRlIDxpZD4gWy0tdGl0bGUvLS1zdGF0dXMvLS1kZWxpdmVyYWJsZS8tLWRldGFpbF1cbi8vICAgICAgICAgICAgICAgICB8IGNsYWltIDxpZD4gLS1vd25lciA8d2hvPiAoYXRvbWljIGxlYXNlOyA0MDkgaWYgaGVsZCBieVxuLy8gICAgICAgICAgICAgICAgICAgYW5vdGhlciBvd25lcikgfCByZWxlYXNlIDxpZD4gfCBzdWJ0YXNrIDxpZD4gKC0tYWRkIDxsYWJlbD5cbi8vICAgICAgICAgICAgICAgICAgIHwgLS1jaGVjayA8c3VidGFza0lkPiB8IC0tdW5jaGVjayA8c3VidGFza0lkPikgfCBsaXN0XG4vLyAgICAgICAgICAgICAgICAgfCBkZWxldGUgPGlkPi4gQSBwZXJzaXN0ZWQgdW5pdCBvZiBBR0VOVCBXT1JLIChzdGF0dXMgK1xuLy8gICAgICAgICAgICAgICAgIHN1Yi10YXNrcyArIGRlbGl2ZXJhYmxlICsgb3duZXIpOyBjcmVhdGUvdXBkYXRlIGFsc28gdGFrZSBhXG4vLyAgICAgICAgICAgICAgICAgZnVsbCBKU09OIGJvZHkgdmlhIC0tc3RkaW4gLyAtLWJvZHktZmlsZVxuLy8gICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gIFBPU1QgL2FjdGl2aXR5IOKGkiBmaXJlLWFuZC1mb3JnZXRcbi8vICAgICAgICAgICAgICAgICBhZ2VudC5hY3Rpdml0eSBzaWduYWwgKH42MHMgVFRMIGVtaXRzIHN5bnRoZXRpYyBpZGxlKVxuLy8gICBzZWFyY2ggPHEuLi4+IEdFVCAvc2VhcmNoIOKGkiB7aGl0czogW3traW5kOiBub2RlfGRvY3xtZXNzYWdlLCAuLi59XX1cbi8vICAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gIEdFVCAvbmVpZ2hib3JzLzppZCDihpIgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuLy8gICByYXRpZnkgPGlkPiAtLXJ1bGluZyBjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWx8cmVqZWN0IFstLWRvYy1lZGl0IDxmaWxlPl1cbi8vICAgICAgICAgICAgICAgICBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSAgcmF0aWZ5LXRpbWUgZXZpZGVuY2UgYXR0YWNoOlxuLy8gICAgICAgICAgICAgICAgIGZvciBhbiBFVklERU5DRS1MRVNTIG5vZGUgcHJvcG9zYWwgb25seSwgLS1kb2MgbmFtZXMgdGhlIGRvY1xuLy8gICAgICAgICAgICAgICAgIGhvbWUgKG11c3QgZXhpc3Q7IHJlcXVpcmVzIC0tZG9jLWVkaXQpIGFuZCBtaW50cyB0aGUgbm9kZSdzXG4vLyAgICAgICAgICAgICAgICAgc291cmNlcyByb3cgd2l0aCB0aGUgb3B0aW9uYWwgLS1zcGFuIGV4Y2VycHRcbi8vICAgbGVucyBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGRvY0lkPikgfCBsZW5zIGNsZWFyXG4vLyAgIGxvb2staGVyZSA8bm9kZUlkPiAgZmlyZS1vbmNlIGF0dGVudGlvbiBudWRnZSwgbm90IHBlcnNpc3RlZFxuLy8gICBzZW5kICAgICAgICAgIGJvZHkgY2hhaW46IC0tYm9keS1maWxlIDxwYXRoPiA+IC0tc3RkaW4gPiBpbmxpbmUgPHRleHQuLi4+ID5cbi8vICAgICAgICAgICAgICAgICBwaXBlZCBzdGRpbjsgWy0tcm9sZSB1c2VyfGFnZW50XSBbLS1raW5kXSBbLS1ncm91bmQgYSxiXVxuLy8gICAgICAgICAgICAgICAgIChyZXBlYXRhYmxlIOKAlCByZXBlYXRzIGFjY3VtdWxhdGUsIGNvbW1hcyBzcGxpdCBlaXRoZXIgd2F5KVxuLy8gICAgICAgICAgICAgICAgIFstLWZvcmNlXSDihpIgUE9TVCAvc2VuZC4gRW1wdHkgcmVzb2x2ZWQgYm9keSA9IHVzYWdlIGVycm9yLiBUaGVcbi8vICAgICAgICAgICAgICAgICBwaXBlZCBkZWZhdWx0IEhBTkdTIHdpdGggbm8gcGlwZSB1bmRlciBhZ2VudCBzaGVsbHMg4oCUIGFsd2F5c1xuLy8gICAgICAgICAgICAgICAgIHBhc3MgYSBib2R5ICgtLWJvZHktZmlsZSBwcmVmZXJyZWQgZm9yIHByb3NlKS5cbi8vICAgICAgICAgICAgICAgICBSMTE6IC0ta2luZCBpcyB0aGUgQ0hBTk5FTCB0aGUgbWVzc2FnZSBhcnJpdmVkIHRocm91Z2hcbi8vICAgICAgICAgICAgICAgICAodHVybnxhbmFseXplfGNhbnZhczsgb3BlbiBzZXQg4oCUIGFuIHVua25vd24gb25lIGlzIHN0b3JlZFxuLy8gICAgICAgICAgICAgICAgIHdpdGggYSBzdGRlcnIgYWR2aXNvcnksIG5ldmVyIHJlamVjdGVkKS5cbi8vICAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gIOKGkiBQT1NUIC9hY3Rpdml0eS4gVGhlXG4vLyAgICAgICAgICAgICAgICAgbWVzc2FnZUlkIHRpZXMgdGhlIHNpZ25hbCB0byBPTkUgbWVzc2FnZSBzbyB0aGUgaHVtYW4gc2Vlc1xuLy8gICAgICAgICAgICAgICAgIHdoaWNoIG9uZSBpcyBiZWluZyB3b3JrZWQ7IG9taXR0ZWQsIGl0IGluaGVyaXRzIHRoZSBvcGVuXG4vLyAgICAgICAgICAgICAgICAgbGFkZGVyJ3MgbWVzc2FnZS4gaWRsZSBjbG9zZXMgdGhlIGxhZGRlciAodGhlcmUgaXMgbm8gYGRvbmVgXG4vLyAgICAgICAgICAgICAgICAg4oCUIGFuIGFnZW50IGBzZW5kYCBJUyB0aGUgY29tcGxldGlvbiBzaWduYWwpLlxuLy9cbi8vIC0tcHJvamVjdCA8aWQ+IGlzIGFjY2VwdGVkIGJ5IGV2ZXJ5IHZlcmIgYWJvdmUgZXhjZXB0IG9wZW4gKHNjb3BlcyB0byBhXG4vLyBub24tZGVmYXVsdCBwcm9qZWN0OyBvbWl0IGZvciB0aGUgZGVmYXVsdCBwcm9qZWN0KS5cbi8vXG4vLyBFUlJPUiBDT05UUkFDVCAoYWNjIEwwLCBzdGF0ZWQgT05DRSDigJQgcGVyLXZlcmIgcHJvc2UgYWJvdmUgbmFtZXMgSFRUUFxuLy8gc3RhdHVzZXMsIHRoaXMgdGFibGUgaXMgd2hhdCB0aGUgUFJPQ0VTUyBkb2VzIHdpdGggdGhlbSk6IGV2ZXJ5IGZhaWx1cmUgaXNcbi8vIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciB3aXRoIHN0ZG91dCBlbXB0eSDigJRcbi8vICAge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vICAgIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1cbi8vICAgdXNhZ2Ug4oaSIGV4aXQgMiDCtyBpbnRlcm5hbCDihpIgMSDCtyBub3RfZm91bmQg4oaSIDUgKEhUVFAgNDA0KSDCtyBjb25mbGljdCDihpIgNlxuLy8gICAoSFRUUCA0MDkpOyBIVFRQIDQwMCBtYXBzIHRvIHVzYWdlLiBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgdGhlIHNlcnZlcidzXG4vLyAgIG93biBKU09OIGJvZHkgVkVSQkFUSU0gdW5kZXIgZXJyb3Iuc2VydmVyIChuZWVkcy1wcm9qZWN0LCBjaXRlZCwgem9uZWQsXG4vLyAgIHpvbmUtbm90LWVtcHR5LCBjbGFpbSBjb25mbGljdHMsIOKApikg4oCUIGJyYW5jaCBvbiBraW5kL3NlcnZlciwgbmV2ZXIgcHJvc2UuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIEVYSVRfRk9SLFxuICBlcnJvckVudmVsb3BlLFxuICBnZXRDdXJyZW50Q29tbWFuZCxcbiAgQ2xpRXJyb3IgYXMgS2l0Q2xpRXJyb3IsXG4gIHR5cGUgRXJyS2luZCBhcyBLaXRFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbiAgc2V0Q3VycmVudENvbW1hbmQsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50cy50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TLCBUQUlMX1JFVFJZX01BWF9NUywgVEFJTF9SRVRSWV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG4vLyDim5QgRVZFUlkgUEFUSCBCRUxPVyBJUyBDT01QVVRFRCBGUk9NIFRIRSBBUlRJRkFDVCdTIEFERFJFU1MsIFdISUNIIElTXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21pbmQtbWFwcGVyL2Rpc3QvY2xpLmpzYCDigJQgTk9UIEZST00gVEhJUyBTT1VSQ0Vcbi8vIEZJTEUuIFRoYXQgaXMgd2hhdCBtYWtlcyB0aGUgYGltcG9ydC5tZXRhLm1haW5gIGJsb2NrJ3MgYWJzZW5jZSBhdCB0aGUgYm90dG9tXG4vLyBvZiB0aGlzIGZpbGUgYSByZXF1aXJlbWVudCByYXRoZXIgdGhhbiBhIHRpZHk6IHJ1biBmcm9tXG4vLyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvYCB0aGVzZSByZXNvbHZlIGludG8gYHNyYy9taW5kLW1hcHBlci9gLCB3aGljaCBoYXMgbm9cbi8vIGBkaXN0L2luZGV4Lmh0bWxgLCBzbyB0aGUgQ0xJIHdvdWxkIGNob29zZSBERVYgYW5kIHRoZW4gc3Bhd24gYSBkYWVtb24gZnJvbVxuLy8gdGhlIHdyb25nIGFuY2hvci4gYGRpc3QvYCBzaXRzIGF0IHRoZSBzYW1lIGRlcHRoIHVuZGVyIHRoZSBza2lsbCByb290IGFzIHRoZVxuLy8gYHNjcmlwdHMvYCBpdCByZXBsYWNlZCwgc28gZXZlcnkgYW5jZXN0b3IgY2xpbWIgYmVsb3cgaXMgdW5jaGFuZ2VkIOKAlCBhXG4vLyBDT0lOQ0lERU5DRSBPRiBERVBUSCwgYXNzZXJ0ZWQgYnkgYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByYXRoZXJcbi8vIHRoYW4gdHJ1c3RlZCAocGxheWJvb2sgQjQvQjUpLlxuY29uc3QgU0NSSVBUX0RJUiA9IGltcG9ydC5tZXRhLmRpcjtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBOT1QgQSBGTEFUIFNJQkxJTkcuIFRoaXMgd2FzIGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgdW50aWwgdGhlIGJhY2tlbmQgcG9ydCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IHNoYXBlLFxuLy8gY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tIGBkaXN0L2AgdGhlXG4vLyBmbGF0IGZvcm0gbmFtZXMgYGRpc3Qvc2VydmVyLnRzYCwgd2hpY2ggZG9lcyBub3QgZXhpc3Q7IHRoZSBzeW1wdG9tIGlzIG5vdCBhXG4vLyBjcmFzaCBidXQgYGVuc3VyZURhZW1vbmAncyBwb2xsIHJ1bm5pbmcgb3V0IHRvIFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW5cbi8vIDEwc1wiLiBUaGUgbGF1bmNoZXIgaXMgdGhlIHByb2Nlc3MgYSBjYWxsZXIgcnVucywgYW5kIGl0IGxpdmVzIGluIGBzY3JpcHRzL2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2U7IEJ1biByZWFkcyBidW5maWcudG9tbFxuLy8gKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2QgTVVTVCBiZVxuLy8gc3JjL21pbmQtbWFwcGVyLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBwYWdlIDUwMHM7XG4vLyBtaW5kLW1hcHBlcidzIG93biBmYWlsdXJlIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnXG4vLyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lXG4vLyBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkIGJyZWFrIHNwYXduLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1pbmQtbWFwcGVyXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuY29uc3QgSE9NRSA9IHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLm1pbmQtbWFwcGVyXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihIT01FLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKEhPTUUsIFwiZGFlbW9uLnBpZFwiKTtcblxuZnVuY3Rpb24gbGl2ZVBvcnQoKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpIHx8ICFleGlzdHNTeW5jKFBJRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpZCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUElEX0ZJTEUsIFwidXRmOFwiKS50cmltKCksIDEwKTtcbiAgY29uc3QgcG9ydCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0ZjhcIikudHJpbSgpLCAxMCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHBpZCkgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKHBpZCwgMCk7IC8vIGxpdmVuZXNzIHByb2JlLCBubyBzaWduYWwgZGVsaXZlcmVkXG4gICAgcmV0dXJuIHBvcnQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsOyAvLyBzdGFsZSBkaXNjb3ZlcnkgZmlsZXNcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24ocG9ydD86IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJ1bm5pbmcgPSBsaXZlUG9ydCgpO1xuICAvLyBSb3VuZCA3IChQT1JUKTogYSBsaXZlIGRhZW1vbiBJR05PUkVTIC0tcG9ydCDigJQgdGhlIHN0YWJsZS11cmwgZ3VhcmFudGVlXG4gIC8vIG9ubHkgaG9sZHMgaWYgdGhlIEZJUlNUIG9wZW4gc2V0IHRoZSBwb3J0ICh0aGUgZGFlbW9uIGJpbmRzIG9uY2UgYXQgYm9vdCkuXG4gIGlmIChydW5uaW5nICE9PSBudWxsKSByZXR1cm4gcnVubmluZztcbiAgY29uc3QgcHJvYyA9IHNwYXduKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCIsIC4uLihwb3J0ID8gW1wiLS1wb3J0XCIsIFN0cmluZyhwb3J0KV0gOiBbXSldLFxuICAgIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICAgIH0sXG4gICk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gUG9sbCBkaXNjb3ZlcnkgdW50aWwgdGhlIGRhZW1vbiB3cml0ZXMgaXRzIHBvcnQgKGNvbGQgQnVuIGJ1bmRsZSBjYW4gbGFnKS5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwMCkpO1xuICAgIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICAgIGlmIChwb3J0ICE9PSBudWxsKSByZXR1cm4gcG9ydDtcbiAgfVxuICB0aHJvdyBuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBcImRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDEwc1wiKTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY21kID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gIHNwYXduKGNtZCwgW3VybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG59XG5cbi8vIOKblCBgZW52TXNgIElTIEdPTkUsIEFORCBJVFMgVFdPIEtOT0JTIE1PVkVEIFJBVEhFUiBUSEFOIERJU0FQUEVBUkVELlxuLy8gYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCBhcmUgcmVzb2x2ZWQgaW5cbi8vIGAuL2hlYXJ0YmVhdC50c2Ag4oCUIHRoZSBzZWFtIGZpbGUgQk9USCBoYWx2ZXMgaW1wb3J0IOKAlCBiZWNhdXNlIHRoZSB3YXRjaGRvZyBpc1xuLy8gREVSSVZFRCBmcm9tIHRoZSBkYWVtb24ncyBiZWF0IGFuZCBhIGtub2IgcmVzb2x2ZWQgYWJvdmUgdGhlIGRlcml2YXRpb24gc3BsaXRzXG4vLyB0aGUgcGFpciBzaWxlbnRseSwgaW52aXNpYmx5IGF0IHRoZSBkZWZhdWx0IChENzUpLlxuXG4vLyDilIDilIAgdGhlIGZhaWx1cmUgY29udHJhY3Q6IFRIRSBIT1VTRSdTIE9ORSBDT1BZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBERS1EVVBMSUNBVEVELCBBTkQgTUlORC1NQVBQRVIgSVMgT05FIE9GIFRIRSBUV08gU1BFTExTIFRISVMgTU9EVUxFJ1MgT1dOXG4vLyBIRUFERVIgTkFNRVMgQVMgSEFWSU5HIFJFQUNIRUQgSVRTIFNIQVBFIElOREVQRU5ERU5UTFkgKGBlcnJvcnMudHM6MzNgOlxuLy8gXCJnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDBcbi8vIHBhc3Nlc1wiKS4gVGhlIGRlbHRhIG9uIHRoZSBXSVJFIGlzIE5JTCwgYW5kIHRoYXQgaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhblxuLy8gYSBob3BlOiB0aGUgYEVycktpbmRgIHVuaW9uIHdhcyBjaGFyYWN0ZXItZm9yLWNoYXJhY3RlciBpZGVudGljYWwsIGBFWElUX0ZPUmBcbi8vIHdhcyB0aGUgc2FtZSBgMi8xLzUvNmAsIGFuZCB0aGUgZW52ZWxvcGUgaGFkIHRoZSBzYW1lIGtleXMgaW4gdGhlIHNhbWUgb3JkZXJcbi8vIOKAlCBge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1gIOKAlCBpbmNsdWRpbmcgYHNlcnZlcmAgTEFTVCwgd2hpY2ggdGhlIGtpdCdzIG93blxuLy8gY29tbWVudCBzYXlzIGlzIGRlbGliZXJhdGUgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCBpdCBrZWVwcyBpdHMgYnl0ZVxuLy8gb3JkZXIuIOKaoCBPTkUgbGF0ZW50IGRpZmZlcmVuY2UsIGNoZWNrZWQgYW5kIGVtcHR5OiB0aGUga2l0IGd1YXJkcyBgaGludGAgYW5kXG4vLyBgY2hvaWNlc2Agb24gVFJVVEhJTkVTUyB3aGVyZSB0aGlzIGZpbGUgZ3VhcmRlZCBvbiBQUkVTRU5DRSwgc28gYVxuLy8gYGhpbnQ6IFwiXCJgIHdvdWxkIHNoaXAgZnJvbSBvbmUgYW5kIG5vdCB0aGUgb3RoZXIuIEdyZXBwZWQ6IHRoaXMgQ0xJIGhhcyBub1xuLy8gZW1wdHktc3RyaW5nIGhpbnQgYXQgYW55IG9mIGl0cyA2NCByYWlzZSBzaXRlcywgc28gdGhlIHBvcHVsYXRpb25zIGFncmVlLlxuLy9cbi8vIG1pbmQtbWFwcGVyIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0XG4vLyBFVkVSWSBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXNcbi8vIHByZXNlbnRhdGlvbiDigJQgcmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzXG4vLyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBEZWxpdmVyeSBpcyBib3VudHkncywgbm90IG1hZ3BpZSdzOiBUSFJPV1xuLy8gYW5kIGxldCBtYWluKCkgY2F0Y2ggYW5kIFJFVFVSTiB0aGUgY29kZSDigJQgdGhpcyBDTEkgc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4vLyBwYXlsb2FkcywgYW5kIGEgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgYGRpZSgpYCB3b3VsZCB0cnVuY2F0ZSB0aGVtIGF0IDY1LDUzNlxuLy8gYnl0ZXMgKHNlZSB0aGUgZHJhaW4gaWRpb20gYXQgdGhlIGJvdHRvbSBvZiB0aGlzIGZpbGUpLiBUaGUga2l0J3MgYGRpZWBcbi8vIHRocm93cyBmb3IgZXhhY3RseSB0aGF0IHJlYXNvbiwgc28gdGhlIGFkb3B0aW9uIGNoYW5nZXMgbm8gZGVsaXZlcnkgZWl0aGVyLlxuLy9cbi8vIOKblCBBTkQgVEhJUyBJUyBUSEUgT05FIFNURVAgT0YgVEhFIFdIT0xFIFBIQVNFIFdIRVJFIFRIRSBLSVQgSVMgTUVBU1VSQUJMWVxuLy8gV0VBS0VSLCBXSElDSCBJUyBXSFkgVEhFIFRSSUFHRSBDSEFJTiBJTiBgbWFpbmAgQkVMT1cgSVMgS0VQVCBBTkQgTk9UXG4vLyBSRVBMQUNFRC4gYGVycm9ycy50c2AgaXMgVFdPIHRoaW5ncyDigJQgYW4gRU5WRUxPUEUgYW5kIGEgQ0xBU1NJRklFUiDigJQgYW5kIG9ubHlcbi8vIHRoZSBlbnZlbG9wZSBjb252ZXJnZWQuIGByZXBvcnRDbGlFcnJvcmAgcmV0dXJucyBgbnVsbGAgZm9yIGFueXRoaW5nIHRoYXQgaXNcbi8vIG5vdCBhIGBDbGlFcnJvcmAgYW5kIGRlbWFuZHMgdGhlIGNhbGxlciByZXRocm93OyB0aGlzIENMSSB0cmlhZ2VzIFRIUkVFXG4vLyBkb2N1bWVudGVkIHVzYWdlIGNsYXNzZXMgb3V0IG9mIHJhdyB0aHJvd3MgKGBFUlJfUEFSU0VfQVJHUypgLCBhXG4vLyBgU3ludGF4RXJyb3JgIGZyb20gYSBKU09OIGJvZHksIGFuZCBgRU5PRU5UYCBvbiBhIG5hbWVkIGZpbGUpLiBBZG9wdGluZyB0aGVcbi8vIGNsYXNzaWZpZXIgbmFpdmVseSB3b3VsZCByZWdyZXNzIGFsbCB0aHJlZSBpbnRvIGEgc3RhY2stdHJhY2UgY3Jhc2gg4oCUIHRoZVxuLy8gZXhhY3QgZGVmZWN0IHRoaXMgZmlsZSdzIG93biBjb21tZW50IHJlY29yZHMgYXMgY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nLFxuLy8gcmUtY3JlYXRlZCBieSB0aGUgYWRvcHRpb24gbWVhbnQgdG8gc3RhbmRhcmRpc2UgaXQuIFNvIGByZXBvcnRDbGlFcnJvcmAgaXNcbi8vIGNhbGxlZCBJTlNJREUgdGhlIGNoYWluLCBhdCB0aGUgcG9zaXRpb24gdGhlIGNoYWluIHJlYWNoZXMgZm9yIGEgdHlwZWRcbi8vIGZhaWx1cmUsIGFuZCB0aGUgY2hhaW4ga2VlcHMgdGhlIHRocmVlIGJyYW5jaGVzIHRoZSBraXQgZG9lcyBub3QgY2FycnkuXG50eXBlIEVycktpbmQgPSBLaXRFcnJLaW5kO1xuXG4vKipcbiAqIG1pbmQtbWFwcGVyJ3MgcmFpc2UgdHlwZSBpcyBub3cgdGhlIGtpdCdzIGBDbGlFcnJvcmAsIHJlLWV4cG9ydGVkIHVuZGVyIHRoZVxuICogbmFtZSA2MiBjYWxsIHNpdGVzIGFscmVhZHkgdXNlLiDimqAgVGhlIEZJRUxEIFNIQVBFIGRpZmZlcnM6IHRoaXMgZmlsZSdzIGNsYXNzXG4gKiBoZWxkIGBoaW50YC9gY2hvaWNlc2AvYHNlcnZlcmAgYXMgb3duIHByb3BlcnRpZXMgYW5kIHRoZSBraXQgaG9sZHMgdGhlbSBpbiBhblxuICogYGV4dHJhYCBiYWcsIHNvIHRoZSBjb25zdHJ1Y3RvciBiZWxvdyBhZGFwdHMgcmF0aGVyIHRoYW4gdGhlIGNhbGwgc2l0ZXNcbiAqIGNoYW5naW5nIOKAlCBhIHJlbG9jYXRpb24tc2hhcGVkIGVkaXQgYXQgNjIgc2l0ZXMgaW5zaWRlIGEgY2hhcHRlciB0aXRsZWRcbiAqIFwiYmVoYXZpb3VyIGNoYW5nZXMsIGFuZCBlYWNoIGNoYW5nZSBpcyBuYW1lZFwiIGlzIGhvdyBhIHJlYWwgY2hhbmdlIGhpZGVzLlxuICovXG5jbGFzcyBDbGlFcnJvciBleHRlbmRzIEtpdENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAga2luZDogRXJyS2luZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9LFxuICApIHtcbiAgICBzdXBlcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuY29uc3QgdXNhZ2VFcnJvciA9IChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkgPT5cbiAgbmV3IENsaUVycm9yKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuXG4vKipcbiAqIFJlcG9ydCBvbmUgb2YgdGhlIHRocmVlIFJBVyB0aHJvd3MgdGhlIGtpdCdzIGNsYXNzaWZpZXIgZG9lcyBub3QgcmVjb2duaXNlIGFzXG4gKiBhIGB1c2FnZWAgZW52ZWxvcGUsIGFuZCBoYW5kIGJhY2sgaXRzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgVEhFIENMQVNTSUZJRVIgSVMgVEhFIEhBTEYgVEhBVCBESUQgTk9UIENPTlZFUkdFLiBUaGVzZVxuICogdGhyZWUgYXJlIG5vdCBgQ2xpRXJyb3JgcyDigJQgdGhleSBhcmUgYSBgbm9kZTp1dGlsYCBwYXJzZSByZWplY3Rpb24sIGFcbiAqIGBTeW50YXhFcnJvcmAgb3V0IG9mIGBKU09OLnBhcnNlYCwgYW5kIGFuIGBFTk9FTlRgIGZyb20gYSBuYW1lZCBwYXRoIOKAlCBhbmRcbiAqIGByZXBvcnRDbGlFcnJvcmAgYW5zd2VycyBgbnVsbGAgZm9yIGFsbCB0aHJlZS4gUm91dGluZyB0aGVtIHRocm91Z2ggdGhlXG4gKiBFTlZFTE9QRSAod2hpY2ggZGlkIGNvbnZlcmdlKSBpcyB0aGUgd2hvbGUgb2YgdGhlIHJlcGFpcjogc2FtZSBieXRlcyBvblxuICogc3RkZXJyLCBzYW1lIGV4aXQgMiwgYW5kIHRoZSB0cmlhZ2Ugc3RheXMgd2hlcmUgdGhlIHNwZWxsIGNhbiBzZWUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlcG9ydFVzYWdlKG1lc3NhZ2U6IHN0cmluZyk6IG51bWJlciB7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBtZXNzYWdlKSk7XG4gIHJldHVybiBFWElUX0ZPUi51c2FnZTtcbn1cblxuLy8gVGhlIG9uZSBleGl0IGZvciBldmVyeSBkYWVtb24gcm91bmQtdHJpcDogb2sg4oaSIHRoZSBib2R5IHRleHQgKGNhbGxlciBwcmludHNcbi8vIGl0IG9uIHN0ZG91dCksIHJlZnVzZWQg4oaSIGEgdHlwZWQgQ2xpRXJyb3Igd2hvc2Uga2luZCBtYXBzIG9mZiB0aGUgSFRUUFxuLy8gc3RhdHVzIGFuZCB3aG9zZSBgc2VydmVyYCBmaWVsZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gSlNPTiBib2R5LlxuYXN5bmMgZnVuY3Rpb24gcGFzc09yVGhyb3cocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICBpZiAocmVzLm9rKSByZXR1cm4gdGV4dDtcbiAgbGV0IHNlcnZlcjogdW5rbm93biA9IHRleHQ7XG4gIHRyeSB7XG4gICAgc2VydmVyID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gZGFlbW9uIGJvZHkgcmlkZXMgYXMgdGhlIHJhdyBzdHJpbmcgKi9cbiAgfVxuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICByZXMuc3RhdHVzID09PSA0MDRcbiAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgOiByZXMuc3RhdHVzID09PSA0MDlcbiAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgOiByZXMuc3RhdHVzID09PSA0MDBcbiAgICAgICAgICA/IFwidXNhZ2VcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgYCR7Z2V0Q3VycmVudENvbW1hbmQoKSA/PyBcInJlcXVlc3RcIn0gcmVmdXNlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHtcbiAgICBzZXJ2ZXIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlRGFlbW9uKCk6IG51bWJlciB7XG4gIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICBpZiAocG9ydCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBDbGlFcnJvcihcIm5vdF9mb3VuZFwiLCBcIm5vIGRhZW1vbiBydW5uaW5nICh1c2UgYG9wZW5gIGZpcnN0KVwiKTtcbiAgfVxuICByZXR1cm4gcG9ydDtcbn1cblxuLy8gU2tlbGV0b24gcHJvamVjdGlvbiDigJQgaWRzL3RpdGxlcy9kZWdyZWUgb25seSwgbm8gc3lub3BzaXMvY29udGVudC4gS2VwdCBhc1xuLy8gYSBjbGllbnQtc2lkZSB0cmFuc2Zvcm0gKHRoZSBkYWVtb24gc3RheXMgZHVtYiBhbmQgYWx3YXlzIHNlcnZlcyB0aGUgZnVsbFxuLy8gc25hcHNob3Q7IHNrZWxldG9uIGlzIGEgY291cnRlc3kgc2hhcGUgZm9yIGNvbnRleHQtYnVkZ2V0ZWQgYWdlbnQgcmVhZHMpLlxuZnVuY3Rpb24gdG9Ta2VsZXRvbihzdGF0ZToge1xuICBub2RlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBraW5kOiBzdHJpbmc7IHRpZXI6IHN0cmluZyB9PjtcbiAgZWRnZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgc291cmNlOiBzdHJpbmc7IHRhcmdldDogc3RyaW5nIH0+O1xufSkge1xuICBjb25zdCBkZWdyZWUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2Ygc3RhdGUuZWRnZXMpIHtcbiAgICBkZWdyZWUuc2V0KGUuc291cmNlLCAoZGVncmVlLmdldChlLnNvdXJjZSkgPz8gMCkgKyAxKTtcbiAgICBkZWdyZWUuc2V0KGUudGFyZ2V0LCAoZGVncmVlLmdldChlLnRhcmdldCkgPz8gMCkgKyAxKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG5vZGVzOiBzdGF0ZS5ub2Rlcy5tYXAoKG4pID0+ICh7XG4gICAgICBpZDogbi5pZCxcbiAgICAgIHRpdGxlOiBuLnRpdGxlLFxuICAgICAga2luZDogbi5raW5kLFxuICAgICAgdGllcjogbi50aWVyLFxuICAgICAgZGVncmVlOiBkZWdyZWUuZ2V0KG4uaWQpID8/IDAsXG4gICAgfSkpLFxuICB9O1xufVxuXG4vLyDilIDilIAgdGhlIGZsYWcgcmVnaXN0cnkgKyB2ZXJiIHNwZWMgKG1hZ3BpZSdzIHR3by1zdGFnZSBwYXJzZSwgcGF0aC1leHRlbmRlZCkg4pSA4pSAXG4vL1xuLy8gVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuIFN0YWdlIDEgcGFyc2VzIGV2ZXJ5IGludm9jYXRpb25cbi8vIGFnYWluc3QgdGhpcyB3aG9sZSByZWdpc3RyeSAoc3RyaWN0KSwgc28gYSB0b2tlbiBtaW5kLW1hcHBlciBoYXMgbmV2ZXIgaGVhcmRcbi8vIG9mIGlzIHJlZnVzZWQgYnkgbm9kZTp1dGlsIHdpdGggaXRzIG93biBtZXNzYWdlOyBzdGFnZSAyIHRoZW4gYXNrcyB0aGVcbi8vIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OiBpcyB0aGlzIGZsYWcgYWNjZXB0ZWQgQVQgVEhJUyBWRVJCLiBUaGUgb3JkZXIgaXNcbi8vIHRoZSBwb2ludCDigJQgaGFuZGluZyBwYXJzZUFyZ3MgYSBwZXItdmVyYiBzdWJzZXQgd291bGQgYW5zd2VyIGBzdGF0ZSAtLXJ1bGluZ2Bcbi8vIHdpdGggXCJVbmtub3duIG9wdGlvbiAnLS1ydWxpbmcnXCIsIHdoaWNoIGlzIGZhbHNlIGFuZCBzZW5kcyBhbiBhZ2VudCBodW50aW5nIGFcbi8vIHR5cG8gaXQgZGlkIG5vdCBtYWtlLlxuLy9cbi8vIE5PIERFRkFVTFRTIGluIHRoZSByZWdpc3RyeSwgc3RydWN0dXJhbGx5OiBzdGFnZSAyIGRldGVjdHMgYSBzdHJheSBmbGFnIGJ5XG4vLyBrZXktcHJlc2VuY2UgaW4gdGhlIHBhcnNlZCB2YWx1ZXMsIGFuZCBhIHJlZ2lzdHJ5IGRlZmF1bHQgd291bGQgcGxhbnQgdGhhdFxuLy8ga2V5IG9uIGV2ZXJ5IHZlcmIuIFBlci12ZXJiIGRlZmF1bHRzIGxpdmUgYXQgdGhlIGNvbnN1bXB0aW9uIHNpdGUgKD8/IFwi4oCmXCIpLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFkZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGFuY2hvcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGF1dGhvcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJhdGNoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNoZWNrOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2xlYXI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgY3JlYXRlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZGVsaXZlcmFibGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkZXB0aDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRldGFpbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRvYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiZG9jLWVkaXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZpbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmb3JjZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICAvLyBzZW5kIC0tZ3JvdW5kIGlzIHBhcnNlQXJncy1gbXVsdGlwbGVgIEJZIFNFQU0gKENvbnRyYWN0IDkgUjQ6IHJlcGVhdHNcbiAgLy8gYWNjdW11bGF0ZSwgY29tbWFzIHNwbGl0KSDigJQgYW55IHZlcmIgY29weWluZyB0aGUgcGF0dGVybiBjb3BpZXMgdGhpcyB0b28uXG4gIGdyb3VuZDogeyB0eXBlOiBcInN0cmluZ1wiLCBtdWx0aXBsZTogdHJ1ZSB9LFxuICBpbmJvdW5kOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGtpbmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBtZXNzYWdlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbm9kZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBvd25lcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwcm9qZWN0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcm9sZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJ1bGluZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNldDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2tlbGV0b246IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3BhbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN5bm9wc2lzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0bzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHVuY2hlY2s6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB5ZXM6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgem9uZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG4vLyBXSElDSCBGTEFHUyBFQUNIIENPTU1BTkQgUEFUSCBBQ0NFUFRTIOKAlCBhbmQgdGhlIG9ubHkgc291cmNlIG9mIHRoZSB2ZXJiIHNldC5cbi8vIEtleXMgYXJlIFBBVEhTLCBub3QgYmFyZSB2ZXJiczogbWluZC1tYXBwZXIncyBncmFtbWFyIGlzIHR3by10b2tlbiBmb3IgdGhlXG4vLyBzdWItY29tbWFuZGVkIHZlcmJzICh6b25lIGNyZWF0ZSwgbm9kZSBlZGl0LCBqb2IgY2xhaW0g4oCmKSwgc28gdGhlIHNwZWNcbi8vIGV4dGVuZHMgbWFncGllJ3MgZmxhdCB0YWJsZSB3aXRoIHNwYWNlLWpvaW5lZCBwYXRocy4gYHJlc29sdmVQYXRoYCBwaWNrcyB0aGVcbi8vIHR3by10b2tlbiBrZXkgd2hlbiB0aGUgc2Vjb25kIHRva2VuIG5hbWVzIGEga25vd24gc3ViLCBlbHNlIHRoZSBvbmUtdG9rZW5cbi8vIGtleS4gVGhlIGhlbHAgdGV4dCwgdGhlIHJlamVjdGlvbnMnIGBjaG9pY2VzYCBhbmQgdGhlIHBhcnNlciBhbGwgcmVhZCB0aGlzXG4vLyBvbmUgb2JqZWN0OyBhZGRpbmcgYSBmbGFnIHRvIGEgdmVyYiBpcyBvbmUgZWRpdC5cbmV4cG9ydCBjb25zdCBWRVJCX1NQRUMgPSB7XG4gIG9wZW46IFtcIm5vLW9wZW5cIiwgXCJwb3J0XCIsIFwicHJvamVjdFwiXSxcbiAgc3RhdGU6IFtcInNrZWxldG9uXCIsIFwiYmF0Y2hcIiwgXCJwcm9qZWN0XCJdLFxuICBjaGFuZ2VzOiBbXCJzaW5jZVwiLCBcInByb2plY3RcIl0sXG4gIHRhaWw6IFtcInNpbmNlXCIsIFwiaW5ib3VuZFwiLCBcInByb2plY3RcIl0sXG4gIHByb2plY3RzOiBbXCJjcmVhdGVcIl0sXG4gIGluZ2VzdDogW1widGl0bGVcIiwgXCJmaWxlXCIsIFwic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2Utbm9kZVwiOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2UtZWRnZVwiOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2UtYmF0Y2hcIjogW1wic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICBcInJhdGlmeS1iYXRjaFwiOiBbXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gIFwiZGVsZXRlLWJhdGNoXCI6IFtcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgXCJub2RlIGFuY2hvclwiOiBbXCJ0b1wiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgXCJub2RlIGVkaXRcIjogW1widGl0bGVcIiwgXCJzeW5vcHNpc1wiLCBcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgXCJub2RlIGRlbGV0ZVwiOiBbXCJmb3JjZVwiLCBcInByb2plY3RcIl0sXG4gIHJlYWQ6IFtcInByb2plY3RcIl0sXG4gIFwiem9uZSBjcmVhdGVcIjogW1wicHJvamVjdFwiXSxcbiAgXCJ6b25lIGxpc3RcIjogW1wicHJvamVjdFwiXSxcbiAgXCJ6b25lIGRlbGV0ZVwiOiBbXCJ5ZXNcIiwgXCJwcm9qZWN0XCJdLFxuICBwcm9tb3RlOiBbXCJwcm9qZWN0XCJdLFxuICBcInByb3Bvc2FsIHpvbmVcIjogW1widG9cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIFwicHJvcG9zYWwgZGVsZXRlXCI6IFtcInByb2plY3RcIl0sXG4gIGRvYzogW1wicHJvamVjdFwiXSxcbiAgXCJkb2MgZGVsZXRlXCI6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgXCJkb2Mga2luZFwiOiBbXCJhdXRob3JcIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIG1hcms6IFtcInN0YXR1c1wiLCBcIm5vdGVcIiwgXCJhdXRob3JcIiwgXCJwcm9qZWN0XCJdLFxuICBzZWFyY2g6IFtcInByb2plY3RcIl0sXG4gIG5laWdoYm9yczogW1wiZGVwdGhcIiwgXCJwcm9qZWN0XCJdLFxuICByYXRpZnk6IFtcInJ1bGluZ1wiLCBcImRvYy1lZGl0XCIsIFwiZG9jXCIsIFwic3BhblwiLCBcImFuY2hvclwiLCBcInByb2plY3RcIl0sXG4gIFwibGVucyBzZXRcIjogW1wibm9kZVwiLCBcImRvY1wiLCBcImRlcHRoXCIsIFwib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICBcImxlbnMgY2xlYXJcIjogW1wicHJvamVjdFwiXSxcbiAgXCJsb29rLWhlcmVcIjogW1wicHJvamVjdFwiXSxcbiAgYWN0aW9uczogW1wic2V0XCIsIFwic3RkaW5cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIHRhZ3M6IFtcInNldFwiLCBcInN0ZGluXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICBcImpvYiBjcmVhdGVcIjogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgXCJqb2IgdXBkYXRlXCI6IFtcInRpdGxlXCIsIFwic3RhdHVzXCIsIFwiZGVsaXZlcmFibGVcIiwgXCJkZXRhaWxcIiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiLCBcInByb2plY3RcIl0sXG4gIFwiam9iIGNsYWltXCI6IFtcIm93bmVyXCIsIFwicHJvamVjdFwiXSxcbiAgXCJqb2IgcmVsZWFzZVwiOiBbXCJwcm9qZWN0XCJdLFxuICBcImpvYiBzdWJ0YXNrXCI6IFtcImFkZFwiLCBcImNoZWNrXCIsIFwidW5jaGVja1wiLCBcInByb2plY3RcIl0sXG4gIFwiam9iIGxpc3RcIjogW1wicHJvamVjdFwiXSxcbiAgXCJqb2IgZGVsZXRlXCI6IFtcInByb2plY3RcIl0sXG4gIGFjdGl2aXR5OiBbXCJtZXNzYWdlXCIsIFwicHJvamVjdFwiXSxcbiAgc2VuZDogW1wicm9sZVwiLCBcImtpbmRcIiwgXCJncm91bmRcIiwgXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgaGVscDogW10sXG59IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSAoa2V5b2YgdHlwZW9mIENMSV9PUFRJT05TKVtdPjtcblxudHlwZSBWZXJiUGF0aCA9IGtleW9mIHR5cGVvZiBWRVJCX1NQRUM7XG5cbi8vIGBtZXNzYWdlYCBpcyBhbiBhZHZlcnRpc2VkIEFMSUFTIG9mIGByZWFkYCAob25lIG1lc3NhZ2UtZmV0Y2ggdmVyYiwgdHdvXG4vLyBzcGVsbGluZ3MpIOKAlCBhbiBhbGlhcyBtYXBzIG9udG8gaXRzIHRhcmdldCdzIHBhdGggYW5kIG5ldmVyIGdldHMgaXRzIG93blxuLy8gc3BlYyByb3csIHNvIHRoZSB0d28gY2FuIG5vdCBkcmlmdCBhcGFydC5cbmV4cG9ydCBjb25zdCBWRVJCX0FMSUFTRVM6IFJlY29yZDxzdHJpbmcsIFZlcmJQYXRoPiA9IHsgbWVzc2FnZTogXCJyZWFkXCIgfTtcblxuLy8gVGhlIGFkdmVydGlzZWQgdmVyYiByb3N0ZXIsIERFUklWRUQ6IHRvcC1sZXZlbCB0b2tlbnMgb2YgdGhlIHNwZWMgcGF0aHMuXG5leHBvcnQgY29uc3QgVkVSQlMgPSBbLi4ubmV3IFNldChPYmplY3Qua2V5cyhWRVJCX1NQRUMpLm1hcCgocCkgPT4gcC5zcGxpdChcIiBcIilbMF0gYXMgc3RyaW5nKSldO1xuXG4vLyBQYXRocyB3aG9zZSBncmFtbWFyIHRha2VzIE5PIGZyZWUgcG9zaXRpb25hbHMgKGV2ZXJ5dGhpbmcgdGhleSBuZWVkIHJpZGVzXG4vLyBmbGFncyk7IHN0YWdlIDIgcmVmdXNlcyBhIHN0cmF5IHRva2VuIGJ5IG5hbWUgaW5zdGVhZCBvZiBzaWxlbnRseVxuLy8gZHJvcHBpbmcgaXQuIEV2ZXJ5IG90aGVyIHBhdGggY29uc3VtZXMgcG9zaXRpb25hbHMgKGlkcywgcXVlcmllcywgcHJvc2UpLlxuY29uc3QgTk9fUE9TSVRJT05BTFM6IFJlYWRvbmx5U2V0PFZlcmJQYXRoPiA9IG5ldyBTZXQoW1xuICBcIm9wZW5cIixcbiAgXCJzdGF0ZVwiLFxuICBcImNoYW5nZXNcIixcbiAgXCJ0YWlsXCIsXG4gIFwiaW5nZXN0XCIsXG4gIFwicHJvcG9zZS1ub2RlXCIsXG4gIFwicHJvcG9zZS1lZGdlXCIsXG4gIFwicHJvcG9zZS1iYXRjaFwiLFxuICBcInJhdGlmeS1iYXRjaFwiLFxuICBcImRlbGV0ZS1iYXRjaFwiLFxuICBcImxlbnMgc2V0XCIsXG4gIFwibGVucyBjbGVhclwiLFxuICBcImhlbHBcIixcbl0gYXMgVmVyYlBhdGhbXSk7XG5cbmNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IFZlcmJQYXRoKTogc3RyaW5nW10gPT4gVkVSQl9TUEVDW3BhdGhdLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuY29uc3Qgc3Vic09mID0gKHZlcmI6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gIE9iamVjdC5rZXlzKFZFUkJfU1BFQylcbiAgICAuZmlsdGVyKChwKSA9PiBwLnN0YXJ0c1dpdGgoYCR7dmVyYn0gYCkpXG4gICAgLm1hcCgocCkgPT4gcC5zbGljZSh2ZXJiLmxlbmd0aCArIDEpKTtcblxuLy8gVFdPIFNUQUdFUywgQU5EIFRIRSBPUkRFUiBJUyBUSEUgUE9JTlQgKHNlZSB0aGUgcmVnaXN0cnkgaGVhZGVyKS4gQWxzbyBzZXRzXG4vLyBtZXRhLmNvbW1hbmQgdG8gdGhlIFJFU09MVkVEIHBhdGggc28gYW4gZW52ZWxvcGUgZnJvbSBgbm9kZSBlZGl0YCBzYXlzIHNvLlxuZnVuY3Rpb24gcGFyc2VWZXJiQXJncyhwYXRoOiBWZXJiUGF0aCwgYXJnczogc3RyaW5nW10pIHtcbiAgc2V0Q3VycmVudENvbW1hbmQocGF0aCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgYXJncyxcbiAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICBzdHJpY3Q6IHRydWUsXG4gICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgfSk7XG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oVkVSQl9TUEVDW3BhdGhdKTtcbiAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyhwYXJzZWQudmFsdWVzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICBpZiAoc3RyYXkpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7cGF0aH1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBtaW5kLW1hcHBlciBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgeyBjaG9pY2VzOiBmbGFnc0ZvcihwYXRoKSB9LFxuICAgICk7XG4gIH1cbiAgaWYgKE5PX1BPU0lUSU9OQUxTLmhhcyhwYXRoKSAmJiBwYXJzZWQucG9zaXRpb25hbHMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBgJHtwYXRofSB0YWtlcyBubyBwb3NpdGlvbmFsIGFyZ3VtZW50cyAoZ290IFwiJHtwYXJzZWQucG9zaXRpb25hbHNbMF19XCIpYCxcbiAgICAgIFZFUkJfU1BFQ1twYXRoXS5sZW5ndGggPiAwID8geyBjaG9pY2VzOiBmbGFnc0ZvcihwYXRoKSB9IDogdW5kZWZpbmVkLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHBhcnNlZDtcbn1cblxuY29uc3QgSEVMUCA9IGBtaW5kLW1hcHBlciDigJQgYSBjby1wcmVzZW50IGtub3dsZWRnZSBtYXA6IGEgZHVtYiBkYWVtb24gaG9sZHMgdGhlIGdyYXBoLCB0aGUgY2FzdGluZyBhZ2VudCBkb2VzIHRoZSB0aGlua2luZy5cblxuICBvcGVuICAgWy0tcHJvamVjdCA8aWQ+XSBbLS1wb3J0IDxuPl0gWy0tbm8tb3Blbl0gICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybFxuICBzdGF0ZSAgWy0tc2tlbGV0b25dIFstLWJhdGNoIDxpZD5dICAgICAgICAgICAgICAgICB0aGUgcHJvamVjdCBzbmFwc2hvdCAoc2tlbGV0b24gPSBpZHMvdGl0bGVzL2RlZ3JlZSlcbiAgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+ICAgICAgICAgICAgICAgICAgICAgYm91bmRlZCBkZWx0YSwgQURESVRJT05TIE9OTFkgKG5vdENvdmVyZWQgbmFtZXMgdGhlIHJlc3QpXG4gIHRhaWwgICBbLS1zaW5jZSBOXSBbLS1pbmJvdW5kXSAgICAgICAgICAgICAgICAgICAgIFNTRSBldmVudHMgYXMgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yKVxuICBwcm9qZWN0cyBbLS1jcmVhdGUgPHRpdGxlPl0gICAgICAgICAgICAgICAgICAgICAgICBsaXN0IHByb2plY3RzIC8gY3JlYXRlIG9uZVxuICBpbmdlc3QgLS10aXRsZSA8dD4gKC0tZmlsZSA8cD4gfCAtLXN0ZGluKSAgICAgICAgICBhZGQgYSBkb2NcbiAgcHJvcG9zZS1ub2RlIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3RhZ2UgYSBub2RlIHByb3Bvc2FsIChKU09OIHtkcmFmdCwgZXZpZGVuY2UsIC4uLn0pXG4gIHByb3Bvc2UtZWRnZSAtLXN0ZGluIFstLXpvbmUgPGlkPl0gICAgICAgICAgICAgICAgIHN0YWdlIGFuIGVkZ2UgcHJvcG9zYWxcbiAgcHJvcG9zZS1iYXRjaCAtLXN0ZGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3RhZ2UgYSBzZXQgaW4gb25lIHR4biAoe25vZGVzLCBlZGdlc30pXG4gIHJhdGlmeS1iYXRjaCAtLXN0ZGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdGlmeSBhIHNldCBpbiBvbmUgdHhuICh7cnVsaW5nLCBpZHMsIGFuY2hvcnM/fSlcbiAgZGVsZXRlLWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGEgcHJvcG9zYWwgc2V0IGluIG9uZSB0eG4gKHtpZHN9LCBhbGwtb3Itbm90aGluZylcbiAgcmF0aWZ5IDxpZD4gLS1ydWxpbmcgPHI+IFstLWRvYy1lZGl0IDxmaWxlPl0gWy0tZG9jIDxkb2NJZD4gLS1zcGFuIDx0Pl0gWy0tYW5jaG9yIDxwYXJlbnRJZD5dXG4gIHpvbmUgICBjcmVhdGUgPG5hbWU+IHwgbGlzdCB8IGRlbGV0ZSA8aWQ+IFstLXllc10gIHN0YWdpbmcgcGVucyBmb3IgcHJvcG9zYWxzXG4gIHByb21vdGUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1vdmUgYSB6b25lZCBwcm9wb3NhbCB0byB0aGUgbWFpbiBxdWV1ZVxuICBwcm9wb3NhbCB6b25lIDxpZD4gKC0tdG8gPHo+IHwgLS1jbGVhcikgfCBwcm9wb3NhbCBkZWxldGUgPGlkPlxuICBub2RlICAgYW5jaG9yIDxpZD4gKC0tdG8gPHA+IHwgLS1jbGVhcikgfCBlZGl0IDxpZD4gWy0tdGl0bGUvLS1zeW5vcHNpcy8tLXN0ZGluXSB8IGRlbGV0ZSA8aWQ+IFstLWZvcmNlXVxuICBkb2MgICAgPGlkPiB8IGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSB8IGtpbmQgPGRvY0lkPiAoPGtpbmQ+IFstLWF1dGhvciBhXSB8IC0tY2xlYXIpXG4gIG1hcmsgICA8ZG9jSWQ+IC0tc3RhdHVzIDxzPiBbLS1ub3RlIDx0Pl0gICAgICAgICAgIGFwcGVuZCBhIGRvYyBzdGF0dXMgbWFya1xuICBhY3Rpb25zIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgIGFjdGlvbiBzbG90cyBvbiBhIG5vZGUvcGVuZGluZyBwcm9wb3NhbFxuICB0YWdzICAgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpICAgIGZyZWVmb3JtIHRhZ3MsIHNhbWUgdGFyZ2V0c1xuICBqb2IgICAgY3JlYXRlfHVwZGF0ZXxjbGFpbXxyZWxlYXNlfHN1YnRhc2t8bGlzdHxkZWxldGUgIHBlcnNpc3RlZCB1bml0cyBvZiBhZ2VudCB3b3JrXG4gIHNlYXJjaCA8cXVlcnkuLi4+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEZUUyBvdmVyIG5vZGVzLCBkb2NzLCBtZXNzYWdlc1xuICBuZWlnaGJvcnMgPGlkPiBbLS1kZXB0aCAxXSAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbCBob29kICsgZWRnZSByZWFzb25zXG4gIGxlbnMgICBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGlkPikgfCBsZW5zIGNsZWFyXG4gIGxvb2staGVyZSA8bm9kZUlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpcmUtb25jZSBhdHRlbnRpb24gbnVkZ2VcbiAgcmVhZCAgIDxtZXNzYWdlSWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25lIGZ1bGwgbWVzc2FnZSByb3cgKGFsaWFzOiBtZXNzYWdlIDxpZD4pXG4gIHNlbmQgICA8dGV4dC4uLj4gfCAtLWJvZHktZmlsZSA8cD4gfCAtLXN0ZGluICAgICAgIHBvc3QgYSBtZXNzYWdlIChbLS1yb2xlXSBbLS1raW5kXSBbLS1ncm91bmRdKVxuICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gWy0tbWVzc2FnZSA8aWQ+XSB0aGUgY2FzdGluZy1sb29wIGxpdmVuZXNzIHNpZ25hbFxuICBoZWxwIHwgLS12ZXJzaW9uXG5cbiAgLS1wcm9qZWN0IDxpZD4gaXMgYWNjZXB0ZWQgYnkgZXZlcnkgdmVyYiBleGNlcHQgb3BlbidzIHNwYXduLXRpbWUgZmxhZ3M7IG9taXQgZm9yIHRoZSBkZWZhdWx0IHByb2plY3QuXG5cbiAgT3V0cHV0OiBldmVyeSB2ZXJiIHByaW50cyBKU09OIG9uIHN0ZG91dCBieSBkZWZhdWx0LCBvbmUgZG9jdW1lbnQgcGVyIGFuc3dlciDigJRcbiAgZXhjZXB0IHRhaWwsIGEgc3RyZWFtIHRoYXQgcHJpbnRzIG9uZSBKU09OIGxpbmUgcGVyIGV2ZW50LiBQcm9zZSwgd2FybmluZ3MgYW5kXG4gIGRpYWdub3N0aWNzIGdvIHRvIHN0ZGVycjsgZmFpbHVyZXMgZXhpdCBub24temVybyAoMiA9IHVzYWdlKS5gO1xuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyIChhc3Ryb2xhYmUncyBwYXR0ZXJuKS4gTGF5b3V0LWRlcGVuZGVudCwgc28gYWJzZW5jZVxuLy8gZGVncmFkZXMgdG8gXCJ1bmtub3duXCIgaW5zdGVhZCBvZiBpbnZlbnRpbmcgb25lLlxuZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoXG4gICAgICBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSxcbiAgICAgIFwidXRmOFwiLFxuICAgICk7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcbiAgICBpZiAodHlwZW9mIHBrZy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSByZXR1cm4geyBuYW1lOiBcIm1pbmQtbWFwcGVyXCIsIHZlcnNpb246IHBrZy52ZXJzaW9uIH07XG4gIH0gY2F0Y2gge1xuICAgIC8qIGZhbGwgdGhyb3VnaCB0byB1bmtub3duICovXG4gIH1cbiAgcmV0dXJuIHsgbmFtZTogXCJtaW5kLW1hcHBlclwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vLyBwYXJzZUFyZ3MgdGhyb3dzIChFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTiBldGMuKSBvbiBhbiB1bnJlY29nbml6ZWRcbi8vIGZsYWcgbGlrZSBhIHN0cmF5IC0taGVscCDigJQgdW5jYXVnaHQsIHRoYXQncyBhIHN0YWNrLXRyYWNlIGNyYXNoIGluc3RlYWQgb2Zcbi8vIGEgdXNhZ2UgbWVzc2FnZSAoY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nKS4gRXZlcnkgdmVyYidzIHBhcnNlQXJncyBjYWxsXG4vLyBmdW5uZWxzIHRocm91Z2ggaGVyZSBzbyBhIGJhZCBmbGFnIGFsd2F5cyBleGl0cyAyIHdpdGggYSBvbmUtbGluZSBlcnJvci5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIOKblCBUSEUgS0lUJ1MgUkVQT1JURVIgU0lUUyBJTlNJREUgVEhJUyBDSEFJTiwgTk9UIElOIFBMQUNFIE9GIElULiBJdFxuICAgIC8vIHdyaXRlcyB0aGUgZW52ZWxvcGUgYW5kIGhhbmRzIGJhY2sgdGhlIHRheG9ub215IGNvZGUgZm9yIGEgdHlwZWQgZmFpbHVyZSxcbiAgICAvLyBhbmQgcmV0dXJucyBgbnVsbGAgZm9yIGV2ZXJ5dGhpbmcgZWxzZSDigJQgc28gdGhlIHRocmVlIHVzYWdlIGNsYXNzZXMgYmVsb3dcbiAgICAvLyBhcmUgc3RpbGwgY2xhc3NpZmllZCBIRVJFLiBSZXBsYWNpbmcgdGhlIGNoYWluIHdpdGggYSBiYXJlXG4gICAgLy8gYHJlcG9ydENsaUVycm9yKGUpID8/IHJldGhyb3dgIHdvdWxkIHR1cm4gYSBzdHJheSBmbGFnLCBhIG1hbGZvcm1lZCBKU09OXG4gICAgLy8gYm9keSBhbmQgYSBtaXNzaW5nIGZpbGUgaW50byBzdGFjay10cmFjZSBjcmFzaGVzLlxuICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgY29uc3QgY29kZSA9XG4gICAgICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbiAgICBjb25zdCBtc2cgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgLy8gQSBzdHJheS91bmtub3duIGZsYWcgKG5vZGU6dXRpbCBzdHJpY3QpIGlzIHRoZSBDQUxMRVIncyB0byBmaXguXG4gICAgaWYgKGNvZGUuc3RhcnRzV2l0aChcIkVSUl9QQVJTRV9BUkdTXCIpKSByZXR1cm4gcmVwb3J0VXNhZ2UobXNnKTtcbiAgICAvLyBBIGJvZHkgdGhhdCBmYWlsZWQgdG8gcGFyc2UgKHN0ZGluLy0tYm9keS1maWxlIEpTT04pIOKAlCBhbHNvIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoZSBpbnN0YW5jZW9mIFN5bnRheEVycm9yKSByZXR1cm4gcmVwb3J0VXNhZ2UoYGludmFsaWQgSlNPTjogJHttc2d9YCk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUvLS1kb2MtZWRpdCBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydFVzYWdlKG1zZyk7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGZhdWx0OiBvbmUgSU5URVJOQUwgZW52ZWxvcGUsIG5ldmVyXG4gICAgLy8gYSBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcImludGVybmFsXCIsIG1zZykpO1xuICAgIHJldHVybiBFWElUX0ZPUi5pbnRlcm5hbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHZlcmIgPSBhcmd2WzBdO1xuICBjb25zdCByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgLy8gVGhlIGVudmVsb3BlIG5hbWVzIHRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiAobWV0YS5jb21tYW5kKTsgcm9vdCB0b2tlbnNcbiAgLy8gYW5kIHRoZSBmYWxsdGhyb3VnaCBsZWF2ZSBpdCBhcyB0aGUgcmF3IGZpcnN0IHRva2VuLCB3aGljaCBpcyB0aGUgaG9uZXN0XG4gIC8vIGFuc3dlciB0byBcIndoYXQgd2FzIGJlaW5nIHJ1biB3aGVuIHRoaXMgZmFpbGVkXCIuIFRoZSBraXQgb3ducyB0aGUgdmFyaWFibGVcbiAgLy8gbm93IOKAlCBvbmUgbW9kdWxlLCBvbmUgYG1ldGEuY29tbWFuZGAuXG4gIHNldEN1cnJlbnRDb21tYW5kKHZlcmIgPz8gbnVsbCk7XG5cbiAgLy8gUk9PVCBUT0tFTlMgRklSU1QsIGJlZm9yZSBhbnkgZmxhZyBwYXJzaW5nIChtYWdwaWUvYXN0cm9sYWJlIHBhdHRlcm4pLlxuICAvLyAtLWhlbHAvLWggcmVzb2x2ZSBhdCB0aGUgcm9vdDsgYGhlbHBgIGlzIEFMU08gYSBkaXNwYXRjaGFibGUgdmVyYiBiZWxvdywgc29cbiAgLy8gYGhlbHAgLS1mb29gIGlzIGEgcmVqZWN0ZWQgZmxhZywgbm90IGEgc2lsZW50bHktdG9sZXJhdGVkIG9uZS5cbiAgaWYgKHZlcmIgPT09IFwiLS1oZWxwXCIgfHwgdmVyYiA9PT0gXCItaFwiKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICAvLyBSb290IFRPS0VOLCBkZWxpYmVyYXRlbHkgTk9UIGEgZmxhZzogbm8gcGVyLXZlcmIgcGFyc2VyIGJlbG93IHRoZSByb290IGlzXG4gIC8vIGV2ZXIgZXhwZWN0ZWQgdG8gYWNjZXB0IGl0LCBhbmQgaXQgY2FycmllcyBubyBmbGFncyBvZiBpdHMgb3duLlxuICBpZiAodmVyYiA9PT0gXCItLXZlcnNpb25cIiB8fCB2ZXJiID09PSBcIi1WXCIgfHwgdmVyYiA9PT0gXCJ2ZXJzaW9uXCIpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh2ZXJzaW9uSW5mbygpKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBpZiAodmVyYiA9PT0gXCJoZWxwXCIpIHtcbiAgICAvLyBEaXNwYXRjaGFibGUgdmVyYiB3aXRoIGFuIEVNUFRZIGZsYWcgc2V0IOKAlCBhIHN0cmljdCBwYXJzZSBvZiB0aGUgcmVzdFxuICAgIC8vIG1lYW5zIGBoZWxwIC0tZm9vYCBpcyByZWZ1c2VkIGluc3RlYWQgb2YgaWdub3JlZC5cbiAgICBwYXJzZVZlcmJBcmdzKFwiaGVscFwiLCByZXN0KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwib3BlblwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcIm9wZW5cIiwgcmVzdCk7XG4gICAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbihwYXJzZWQudmFsdWVzLnBvcnQpO1xuICAgIC8vIC0tcHJvamVjdCBzY29wZXMgdGhlIHByaW50ZWQgVVJMICsgc3Bhd25lZCBicm93c2VyICg/cHJvamVjdD0gcmlkZXNcbiAgICAvLyBhbG9uZykuIE9wZW4gbmV2ZXIgbWludHM6IGFuIHVua25vd24gaWQgaXMgYSB1c2FnZSBlcnJvciBwb2ludGluZyBhdFxuICAgIC8vIGBwcm9qZWN0cyAtLWNyZWF0ZWAsIG5vdCBhIHNpbGVudCBuZXcgc3RvcmUuXG4gICAgY29uc3QgcHJvamVjdCA9IHBhcnNlZC52YWx1ZXMucHJvamVjdDtcbiAgICBpZiAocHJvamVjdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb2plY3RzYCk7XG4gICAgICBjb25zdCBib2R5ID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgICAgaWYgKCFib2R5LnByb2plY3RzLnNvbWUoKHApID0+IHAuaWQgPT09IHByb2plY3QpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgYHVua25vd24gcHJvamVjdDogJHtwcm9qZWN0fSAob3BlbiBuZXZlciBjcmVhdGVzIG9uZSDigJQgdXNlIFxcYHByb2plY3RzIC0tY3JlYXRlIDx0aXRsZT5cXGAgZmlyc3QpYCxcbiAgICAgICAgICB7IGNob2ljZXM6IGJvZHkucHJvamVjdHMubWFwKChwKSA9PiBwLmlkKSB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwcm9qZWN0ID8gYC8/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwcm9qZWN0KX1gIDogXCJcIn1gO1xuICAgIGlmICghcGFyc2VkLnZhbHVlc1tcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgdXJsIH0pfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwic3RhdGVcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJzdGF0ZVwiLCByZXN0KTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLmJhdGNoKSBwYXJhbXMuc2V0KFwiYmF0Y2hcIiwgcGFyc2VkLnZhbHVlcy5iYXRjaCk7XG4gICAgY29uc3QgcXMgPSBwYXJhbXMuc2l6ZSA+IDAgPyBgPyR7cGFyYW1zfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3RhdGUke3FzfWApO1xuICAgIC8vIEEgbm9uLW9rIC9zdGF0ZSAoNDA5IG5lZWRzLXByb2plY3Qgb24gYSBmcmVzaCBzdG9yZSwgNDA0IHVua25vd25cbiAgICAvLyBwcm9qZWN0KSByaWRlcyB0aGUgZXJyb3IgZW52ZWxvcGUgd2l0aCB0aGUgZGFlbW9uIGJvZHkgdW5kZXJcbiAgICAvLyBlcnJvci5zZXJ2ZXIg4oCUIHRoZSBza2VsZXRvbiB0cmFuc2Zvcm0gb25seSBydW5zIG9uIGEgcmVhbCBzbmFwc2hvdC5cbiAgICBjb25zdCBzdGF0ZVRleHQgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLnNrZWxldG9uKSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGVUZXh0KSBhcyBQYXJhbWV0ZXJzPHR5cGVvZiB0b1NrZWxldG9uPlswXTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHRvU2tlbGV0b24oc3RhdGUpKX1cXG5gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7c3RhdGVUZXh0fVxcbmApO1xuICAgIH1cbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFJvdW5kIDEyIChTRUFNIDMpOiBgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+YCDigJQgdGhlIGJvdW5kZWQgZGVsdGEuXG4gIC8vIFJlYWQgdGhlIHJlc3BvbnNlJ3Mgbm90Q292ZXJlZCBiZWZvcmUgdHJ1c3RpbmcgYW4gZW1wdHkgb25lOiBcIm5vdGhpbmdcbiAgLy8gYWRkZWRcIiBpcyBOT1QgXCJub3RoaW5nIGNoYW5nZWRcIiAoZGVsZXRpb25zLCByZWplY3Rpb25zIGFuZCBpbi1wbGFjZSBlZGl0c1xuICAvLyBhcmUgaW52aXNpYmxlIGhlcmUgYnkgY29uc3RydWN0aW9uKS5cbiAgaWYgKHZlcmIgPT09IFwiY2hhbmdlc1wiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImNoYW5nZXNcIiwgcmVzdCk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuc2luY2UgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJjaGFuZ2VzIHJlcXVpcmVzIC0tc2luY2UgPGVwb2NoU2Vjb25kcz4gKHVzZSAwIGZvciBldmVyeXRoaW5nLCB0aGVuIHBhc3MgYmFjayB0aGUgYG5vd2AgZnJvbSB0aGUgcHJldmlvdXMgcmVzcG9uc2UpXCIsXG4gICAgICAgIHtcbiAgICAgICAgICBoaW50OiBcIkFERElUSU9OUyBPTkxZIOKAlCB0aGUgcmVzcG9uc2UncyBub3RDb3ZlcmVkIG5hbWVzIHdoYXQgaXQgY2Fubm90IHNlZTsgYSBmdWxsIGBzdGF0ZWAgcmVhZCBpcyBzdGlsbCB0aGUgb25seSB3YXkgdG8gcmVjb25jaWxlIGRlbGV0aW9ucywgcmVqZWN0aW9ucyBhbmQgaW4tcGxhY2UgZWRpdHNcIixcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7IHNpbmNlOiBwYXJzZWQudmFsdWVzLnNpbmNlIH0pO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFuZ2VzPyR7cGFyYW1zfWApO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJ0YWlsXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwidGFpbFwiLCByZXN0KTtcbiAgICBjb25zdCBpbmJvdW5kID0gcGFyc2VkLnZhbHVlcy5pbmJvdW5kID09PSB0cnVlO1xuICAgIHJlcXVpcmVEYWVtb24oKTsgLy8gbm8gZGFlbW9uIGF0IHN0YXJ0IGlzIGEgdXNhZ2UgZXJyb3I7IG1pZC10YWlsIGRlYXRoIGlzIHNlbGYtaGVhbGVkIGJlbG93XG4gICAgY29uc3Qgc2luY2UgPSBOdW1iZXIucGFyc2VJbnQocGFyc2VkLnZhbHVlcy5zaW5jZSBhcyBzdHJpbmcsIDEwKTtcbiAgICAvLyBUaGUgc2VydmVyIChyZS0pZW1pdHMgYSBncm91bmRpbmcgZnJhbWUgYXQgdGhlIHRvcCBvZiBFVkVSWSBpbmJvdW5kIFNTRVxuICAgIC8vIGNvbm5lY3Q7IGZvcndhcmQgb25seSB0aGUgRklSU1Qgc28gdGhlIGFnZW50J3MgTW9uaXRvciBzZWVzIGV4YWN0bHkgb25lXG4gICAgLy8gZ3JvdW5kaW5nIGxpbmUsIG5vdCBvbmUgcGVyIHJlY29ubmVjdCAoRjU6IGZpcnN0LWNvbm5lY3QgbGluZSkuXG4gICAgLy9cbiAgICAvLyDim5QgVEhFIFNVUFBSRVNTSU9OJ1MgU1RBVEUgTElWRVMgSU4gVEhJUyBDTE9TVVJFLCBPVVRTSURFIFRIRSBUSElORyBUSEFUXG4gICAgLy8gT1dOUyBUSEUgUkVDT05ORUNUUywgQU5EIFRIQVQgSVMgVEhFIE9ORSBIT05FU1QgR0FQIElOIFRISVMgQURPUFRJT04uXG4gICAgLy8gYHJlbmRlcmAgaXMgYSBjYWxsZXItd3JpdHRlbiBjbG9zdXJlLCBzbyBgZ3JvdW5kZWRgIHN1cnZpdmVzIHRoZVxuICAgIC8vIHJlY29ubmVjdHMgYHRhaWxFdmVudHNgIHBlcmZvcm1zIOKAlCB3aGljaCBpcyBleGFjdGx5IHdoeSBpdCBXT1JLUywgYW5kIGFsc29cbiAgICAvLyB3aHkgbm90aGluZyBpbiB0aGUga2l0IGd1YXJhbnRlZXMgaXQ6IHRoZXJlIGlzIG5vIGRlZGljYXRlZFxuICAgIC8vIGZpcnN0LWZyYW1lLW9uY2UgYWZmb3JkYW5jZSBhbmQgbm8gd29ya2VkIGV4YW1wbGUgb2Ygb25lLCBhbmQgYSBmdXR1cmVcbiAgICAvLyBjaGFuZ2UgdG8gd2hlbiBgdGFpbEV2ZW50c2AgcmUtaW52b2tlcyBpdHMgaG9va3Mgd291bGQgbW92ZSB0aGlzXG4gICAgLy8gYmVoYXZpb3VyIHdpdGhvdXQgdG91Y2hpbmcgdGhpcyBmaWxlLiBUaGUgYWx0ZXJuYXRpdmUgd2FzIGFza2luZyB0aGUga2l0XG4gICAgLy8gZm9yIGEgYGZpcnN0RnJhbWVPbmNlYCBvcHRpb24sIHdoaWNoIGlzIGEgd2lkZW5pbmcgZm9yIGEgY2xvc3VyZSB0aGVcbiAgICAvLyBjYWxsZXIgY2FuIHdyaXRlIGluIHRocmVlIGxpbmVzIChEODIncyBub3QtdGFrZW4pLlxuICAgIGxldCBncm91bmRlZCA9IGZhbHNlO1xuXG4gICAgLy8g4puUIE9ORSBDQUxMIElOVE8gVEhFIEhPVVNFJ1MgU0hBUkVEIFRBSUwgQ0xJRU5UXG4gICAgLy8gKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLCBSRVBMQUNJTkcgQSBIQU5ELVJPTExFRFxuICAgIC8vIFRIUkVFLUxFVkVMIExPT1Ag4oCUIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGwgdGhhdCBtb2R1bGUncyBvd25cbiAgICAvLyBjb25zdGFudC1iYWNrb2ZmIHdhcm5pbmcgd2FzIHdyaXR0ZW4gYWJvdXQ6IHRoZSBsb29wIGJlbG93IHVzZWQgdG8gc2xlZXBcbiAgICAvLyBgcmV0cnlNc2AgYWZ0ZXIgRVZFUlkgZmFpbGVkIGF0dGVtcHQsIGZsYXQsIGZvcmV2ZXIsIHdoaWNoIGlzIGFcbiAgICAvLyByZWNvbm5lY3Qgc3Rvcm0gcmF0aGVyIHRoYW4gYSBiYWNrb2ZmLiBXaGF0IHRoZSBzd2FwIGNsb3NlcyBoZXJlLCBub25lIG9mXG4gICAgLy8gaXQgYnkgYW55b25lIGVkaXRpbmcgaXQ6XG4gICAgLy9cbiAgICAvLyAgIMK3IEJBQ0tPRkYuIDEsMDAwIG1zIGZsYXQgYmVjb21lcyAxLDAwMCDCtyAyLDAwMCDCtyA0LDAwMCDCtyA1LDAwMCDCtyA1LDAwMCxcbiAgICAvLyAgICAgcmVzZXQgb24gYSBzdWNjZXNzZnVsIG9wZW4uIERyaXZlbiBvbiBnbGFtb3VyIGJlZm9yZSBhbmQgYWZ0ZXJcbiAgICAvLyAgICAgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGRyb3BzOiA1MSBhdHRlbXB0cyBpblxuICAgIC8vICAgICAxNCBzIGF0IGEgZmxhdCB+MjUyIG1zIGJlY2FtZSA2IGF0dGVtcHRzIGF0IDI1MiDCtyA1MDMgwrcgMTAwMSDCtyAyMDAyIMK3XG4gICAgLy8gICAgIDQwMDIuXG4gICAgLy8gICDCtyBUSEUgU1BFQy4gVGhlIGhhbmQtcm9sbGVkIGZyYW1lIHBhcnNlciBtYXRjaGVkIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYFxuICAgIC8vICAgICBhbmQga2VwdCBvbmx5IHRoZSBGSVJTVCBkYXRhIGxpbmUsIHNvIGEgc3BlYy1sZWdhbCBgZGF0YTp7Li4ufWAgd2FzXG4gICAgLy8gICAgIHNpbGVudGx5IERST1BQRUQgKiphbmQgdGhlIGN1cnNvciBkaWQgbm90IGFkdmFuY2UqKiDigJQgYSBmcmFtZSBub2JvZHlcbiAgICAvLyAgICAgY2FuIHJlYWQgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAgLy8gICAgIFRoZSBraXQgc3BsaXRzIGF0IHRoZSBmaXJzdCBjb2xvbiBhbmQgc3RyaXBzIGF0IG1vc3Qgb25lIHNwYWNlLCBwZXJcbiAgICAvLyAgICAgV0hBVFdHLCB3aGljaCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aCBldmVyeSBob3VzZVxuICAgIC8vICAgICBkYWVtb24uXG4gICAgLy8gICDCtyBUSEUgU0lHTkFMIEhBTkRMRVJTLiBUaGVyZSB3ZXJlIG5vbmUuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhXG4gICAgLy8gICAgIHJlYWRlciBub3cgZW5kcyB0aGUgd2F0Y2ggYnkgUkVUVVJOSU5HLCBzbyB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0XG4gICAgLy8gICAgIGZpcnN0IOKAlCB0aGUgaGFsZiBvZiB0aGUgUDBmIGRyYWluIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgIC8vICAgwrcgVEhFIEVYSVQgQ09ERSBDUk9TU0VTIFRIRSBMT09QUy4gVGhlIGNsaWVudCBSRVRVUk5TIGEgY29kZSBpbnN0ZWFkIG9mXG4gICAgLy8gICAgIGVuZGluZyB0aGUgcHJvY2VzcyBmcm9tIGluc2lkZSB0aHJlZSBuZXN0ZWQgbG9vcHMsIHdoaWNoIGlzIHdoYXRcbiAgICAvLyAgICAgcmV0aXJlcyB0aGUgcGVyLXNpdGUgcXVlc3Rpb24gb2Ygd2hldGhlciBhIGByZXR1cm5gIGVzY2FwZXMgdGhlbSBhbGwuXG4gICAgLy9cbiAgICAvLyDimqAgQU5EIGBpZGxlTXNgL2ByZXRyeWAgQVJFIERFUklWRUQsIE5PVCBDT1BJRUQgKEI4J3Mgb25lIHVuY29weWFibGUgcnVsZSkuXG4gICAgLy8gVGhleSBjb21lIGZyb20gYC4vaGVhcnRiZWF0LnRzYCwgdGhlIHNlYW0gZmlsZSBib3RoIGhhbHZlcyBpbXBvcnQsIHdoZXJlXG4gICAgLy8gdGhlIHdhdGNoZG9nIGlzIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCDigJQgdGhyZWUgb2YgVEhJUyBkYWVtb24nc1xuICAgIC8vIGJlYXRzLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzIOKAlCBhbmQgd2hlcmUgdGhlIHR3byBlbnYga25vYnMgdGhpc1xuICAgIC8vIHNwZWxsJ3Mgb3duIHRhaWwgc3VpdGUgZHJpdmVzIGFyZSByZXNvbHZlZCAoRDc1KS4gVGhlIG51bWJlciBpcyA0NSwwMDAgYXRcbiAgICAvLyB0aGUgZGVmYXVsdCwgd2hpY2ggaXMgd2hhdCB0aGlzIGZpbGUgaGFyZC1jb2RlZDsgdGhlIEVYUFJFU1NJT04gaXMgd2hhdFxuICAgIC8vIGNoYW5nZWQuXG4gICAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8eyBpZD86IHVua25vd247IGVwb2NoPzogdW5rbm93bjsga2luZD86IHVua25vd24gfT4oe1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBwb3J0ID0gbGl2ZVBvcnQoKTtcbiAgICAgICAgcmV0dXJuIHBvcnQgPT09IG51bGwgPyBudWxsIDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWA7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZTogTnVtYmVyLmlzRmluaXRlKHNpbmNlKSA/IHNpbmNlIDogMCxcbiAgICAgIHF1ZXJ5OiAoY3Vyc29yKSA9PiAoe1xuICAgICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICAgIC4uLihwYXJzZWQudmFsdWVzLnByb2plY3QgPyB7IHByb2plY3Q6IHBhcnNlZC52YWx1ZXMucHJvamVjdCBhcyBzdHJpbmcgfSA6IHt9KSxcbiAgICAgICAgLi4uKGluYm91bmQgPyB7IGluYm91bmQ6IFwiMVwiIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC8vIOKblCBgaWRgLCBOT1QgYHNlcWAg4oCUIHRoZSBkYWVtb24ncyBlbnZlbG9wZSBmaWVsZCB3YXMgcmVuYW1lZCBieSB0aGVcbiAgICAgIC8vIGBjcmVhdGVFdmVudExvZ2AgYWRvcHRpb24gKEQ4MSksIGFuZCB0aGlzIGlzIHRoZSBDTEktc2lkZSByZWFkZXIgb2YgaXQuXG4gICAgICAvLyDimqAgVGhlIENMSSBoYWxmIEZPUkNFRCBub3RoaW5nOiBgY3Vyc29yT2ZgIGlzIGNhbGxlci1zdXBwbGllZCwgc29cbiAgICAgIC8vIGAoZXYpID0+IGV2LnNlcWAgd291bGQgaGF2ZSBjb21waWxlZCBhbmQgcnVuLiBJdCB3b3VsZCBhbHNvIGhhdmUgcmVhZCBhXG4gICAgICAvLyBmaWVsZCB0aGUgZGFlbW9uIG5vIGxvbmdlciBlbWl0cywgc28gdGhlIGN1cnNvciB3b3VsZCBuZXZlciBhZHZhbmNlIGFuZFxuICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHdvdWxkIHJlLXJlcXVlc3QgYHNpbmNlPTBgIOKAlCB0aGUgd2hvbGUgcmVwbGF5IHdpbmRvd1xuICAgICAgLy8gaW50byBhbiBhZ2VudCdzIHBpcGUsIHNpbGVudGx5LCBmb3JldmVyLiAqKkEgY2FsbGVyLXN1cHBsaWVkIGFjY2Vzc29yIGlzXG4gICAgICAvLyB3aGVyZSBhIHdpcmUgcmVuYW1lIGdvZXMgd3JvbmcgcXVpZXRseS4qKlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4gKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiA/IGV2LmlkIDogdW5kZWZpbmVkKSxcbiAgICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAgIC8vIEEgcmVjb25uZWN0IHRoYXQgbGFuZHMgb24gYSBkaWZmZXJlbnQgZXBvY2ggbWVhbnMgdGhlIGRhZW1vbiByZXN0YXJ0ZWQ6XG4gICAgICAvLyB0aGUga2l0IHJlc2V0cyB0aGUgY3Vyc29yIHRvIDAgYW5kIHRoaXMgbGluZSB0ZWxscyB0aGUgY2FzdGluZyBhZ2VudCB0b1xuICAgICAgLy8gcmVmZXRjaCBzdGF0ZS4gQ0xJLXN5bnRoZXNpemVkIG9ubHksIG5ldmVyIGEgYnVzIGV2ZW50ICh0aGUgYnJvd3NlciBXU1xuICAgICAgLy8gbmV2ZXIgc2VlcyBpdCksIGFuZCBpdCBjYXJyaWVzIG5vIGBpZGAg4oCUIHNvIGl0IG5ldmVyIGFkdmFuY2VzIHRoZVxuICAgICAgLy8gY3Vyc29yLCB3aGljaCBpcyB0aGUgc2FtZSBzZXBhcmF0aW9uIHRoZSBncm91bmRpbmcgbGluZSBtYWtlcy5cbiAgICAgIG9uRXBvY2hDaGFuZ2U6IChlcG9jaCkgPT4gSlNPTi5zdHJpbmdpZnkoeyBraW5kOiBcImVwb2NoLmNoYW5nZWRcIiwgZXBvY2ggfSksXG4gICAgICAvLyBHcm91bmRpbmcgaXMgYSBzeW50aGV0aWMsIGlkLWxlc3MgZmlyc3QtY29ubmVjdCBmcmFtZTogZm9yd2FyZCB0aGVcbiAgICAgIC8vIGZpcnN0LCBzdXBwcmVzcyByZS1ncm91bmRpbmdzIG9uIHJlY29ubmVjdCAoZXhhY3RseSBvbmUgcGVyIHByb2Nlc3MpLlxuICAgICAgLy8gUmV0dXJuaW5nIG51bGwgd3JpdGVzIG5vdGhpbmc7IGl0IG5ldmVyIGNhcnJpZXMgaWQvZXBvY2gsIHNvIHRoZVxuICAgICAgLy8gY3Vyc29yIGFuZCB0aGUgZXBvY2ggYXJlIHVudG91Y2hlZCBlaXRoZXIgd2F5LlxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIGlmIChldi5raW5kID09PSBcImdyb3VuZGluZ1wiKSB7XG4gICAgICAgICAgaWYgKGdyb3VuZGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZyYW1lLmRhdGE7XG4gICAgICB9LFxuICAgICAgLy8gQSByZWZ1c2VkIGNvbm5lY3Rpb24gKDQwOSBuZWVkcy1wcm9qZWN0IG9uIGEgcHJvamVjdGxlc3Mgc3RvcmUsIDQwNFxuICAgICAgLy8gdW5rbm93biBwcm9qZWN0KSBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSB0cmFuc3BvcnQgYmxpcCDigJQgcmV0cnlpbmcgaXRcbiAgICAgIC8vIGZvcmV2ZXIgd291bGQganVzdCBzcGluIHNpbGVudGx5LiBgcGFzc09yVGhyb3dgIGFsd2F5cyB0aHJvd3MgaGVyZSwgYW5kXG4gICAgICAvLyB0aGUgdGhyb3cgcHJvcGFnYXRlcyBvdXQgb2YgdGhlIGNsaWVudCBpbnRvIGBtYWluYCdzIGNhdGNoLCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSByYWlzZSByZWFjaGFibGUgZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcC5cbiAgICAgIG9uSHR0cEVycm9yOiBhc3luYyAocmVzKSA9PiB7XG4gICAgICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDkgfHwgcmVzLnN0YXR1cyA9PT0gNDA0KSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgICAgfSxcbiAgICAgIC8vIOKblCBUSEUgVU5QQVJTRUFCTEUgTElORSBHT0VTIFRPIFNURE9VVCwgV0hJQ0ggSVMgVEhJUyBTUEVMTCdTIE9XTlxuICAgICAgLy8gQkVIQVZJT1VSIEFORCBUSEUgT05FIFRIRSBLSVQnUyBERUZBVUxUIFdPVUxEIEhBVkUgQ0hBTkdFRC4gVGhlXG4gICAgICAvLyBoYW5kLXJvbGxlZCBsb29wIGNhdWdodCB0aGUgYEpTT04ucGFyc2VgIGFuZCBwYXNzZWQgdGhlIHJhdyBsaW5lXG4gICAgICAvLyB0aHJvdWdoIHVudHJhY2tlZDsgdGhlIGtpdCdzIGBvbk1hbGZvcm1lZGAgcmV0dXJuIHZhbHVlIGdvZXMgdG8gYGVycmBcbiAgICAgIC8vIGluc3RlYWQsIGJlY2F1c2UgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0gaXMgbm90IGRhdGEuIG1pbmQtbWFwcGVyXG4gICAgICAvLyBpcyB0aGUgXCJvbmUgc3BlbGxcIiB0aGF0IG1vZHVsZSdzIGhlYWRlciBuYW1lcyBhcyBnZW51aW5lbHkgd2FudGluZyBpdCBvblxuICAgICAgLy8gc3Rkb3V0LCBhbmQgdGhlIHdheSB0byBrZWVwIHRoYXQgaXMgdG8gd3JpdGUgaXQgZnJvbSBpbnNpZGUgdGhlIGhvb2sgYW5kXG4gICAgICAvLyByZXR1cm4gbnVsbC5cbiAgICAgIG9uTWFsZm9ybWVkOiAoZnJhbWUpID0+IHtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7ZnJhbWUuZGF0YX1cXG5gKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgICByZXRyeTogeyBpbml0aWFsTXM6IFRBSUxfUkVUUllfTVMsIG1heE1zOiBUQUlMX1JFVFJZX01BWF9NUyB9LFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicHJvamVjdHNcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJwcm9qZWN0c1wiLCByZXN0KTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLmNyZWF0ZSkge1xuICAgICAgY29uc3QgdGl0bGUgPSBwYXJzZWQudmFsdWVzLmNyZWF0ZTtcbiAgICAgIGNvbnN0IGlkID0gdGl0bGVcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2AsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZCwgdGl0bGUgfSksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2ApO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJpbmdlc3RcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJpbmdlc3RcIiwgcmVzdCk7XG4gICAgaWYgKCFwYXJzZWQudmFsdWVzLnRpdGxlKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiaW5nZXN0IHJlcXVpcmVzIC0tdGl0bGVcIik7XG4gICAgfVxuICAgIGlmICghcGFyc2VkLnZhbHVlcy5maWxlICYmICFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiaW5nZXN0IHJlcXVpcmVzIC0tZmlsZSA8cGF0aD4gb3IgLS1zdGRpblwiKTtcbiAgICB9XG4gICAgY29uc3QgdGV4dCA9IHBhcnNlZC52YWx1ZXMuZmlsZVxuICAgICAgPyByZWFkRmlsZVN5bmMocGFyc2VkLnZhbHVlcy5maWxlLCBcInV0ZjhcIilcbiAgICAgIDogYXdhaXQgQnVuLnN0ZGluLnRleHQoKTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9pbmdlc3Qke3FzfWAsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHRpdGxlOiBwYXJzZWQudmFsdWVzLnRpdGxlLCB0ZXh0IH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiB8fCB2ZXJiID09PSBcInByb3Bvc2UtZWRnZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyh2ZXJiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIGAke3ZlcmJ9IHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlWywgc3VnZ2VzdGVkVGllciwgYXV0aG9yLCB0YWdzLCBiYXRjaElkXX1gLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgICdwcm9wb3NlLWVkZ2UgZW5kcG9pbnRzOiBhIG5vZGUgaWQsIGEgcGVuZGluZyBub2RlLXByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiICcgK1xuICAgICAgICAgICAgXCIodGl0bGUgcmVmcyByZXNvbHZlIGF0IElOVEFLRSBhZ2FpbnN0IHJhdGlmaWVkIG5vZGVzIG9ubHksIGV4YWN0ICsgY2FzZS1zZW5zaXRpdmU7IFwiICtcbiAgICAgICAgICAgIFwiYW4gYW1iaWd1b3VzIHRpdGxlIGVycm9ycyBhbmQgbmFtZXMgZXZlcnkgY2FuZGlkYXRlIGlkKVwiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICAgIGRyYWZ0OiB1bmtub3duO1xuICAgICAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgICAgIHN1Z2dlc3RlZFRpZXI/OiBzdHJpbmc7XG4gICAgICBhdXRob3I/OiBzdHJpbmc7XG4gICAgICAvLyBSb3VuZCA3IChUQUdTKTogcHJvcG9zZS10aW1lIHRhZ3MgcmlkZSB0aGUgc3RkaW4gSlNPTiDigJQgbXVzdCBiZVxuICAgICAgLy8gZm9yd2FyZGVkIGludG8gdGhlIFBPU1QgYm9keSwgb3IgdGhlIC9wcm9wb3NhbHMgcm91dGUgbmV2ZXIgc2VlcyB0aGVtXG4gICAgICAvLyAodGhlIGJhdGNoIHBhdGggZm9yd2FyZHMgaXRzIG5vZGUgdGFnczsgdGhlIHNpbmdsZSB2ZXJiIG11c3QgdG9vKS5cbiAgICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAgIC8vIFJvdW5kIDEyIChTRUFNIDEpOiBqb2luIGFuIGV4aXN0aW5nIHN0YWdpbmcgYWN0IChmcm9tIHByb3Bvc2UtYmF0Y2gpLlxuICAgICAgYmF0Y2hJZD86IHN0cmluZztcbiAgICB9O1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2FscyR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAga2luZDogdmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiA/IFwibm9kZVwiIDogXCJlZGdlXCIsXG4gICAgICAgIGRyYWZ0OiBpbnB1dC5kcmFmdCxcbiAgICAgICAgZXZpZGVuY2U6IGlucHV0LmV2aWRlbmNlID8/IHt9LFxuICAgICAgICBzdWdnZXN0ZWRUaWVyOiBpbnB1dC5zdWdnZXN0ZWRUaWVyLFxuICAgICAgICBhdXRob3I6IGlucHV0LmF1dGhvcixcbiAgICAgICAgLy8gLS16b25lIHN0YWdlcyB0aGUgcHJvcG9zYWwgaW4gYSB6b25lIChmbGFnIHdpbnM7IHRoZSBzdGRpbiBKU09OXG4gICAgICAgIC8vIHN0YXlzIHRoZSBkcmFmdC9ldmlkZW5jZSBzaGFwZSDigJQgem9uZSBpcyByb3V0aW5nLCBub3QgY29udGVudCkuXG4gICAgICAgIHpvbmU6IHBhcnNlZC52YWx1ZXMuem9uZSxcbiAgICAgICAgLy8gVEFHUzogZm9yd2FyZCB0aGUgc3RkaW4gdGFncyAodGhlIHJvdXRlIHZhbGlkYXRlcyB0aGUgc2hhcGUpLlxuICAgICAgICB0YWdzOiBpbnB1dC50YWdzLFxuICAgICAgICAvLyBTRUFNIDE6IGZvcndhcmQgdGhlIHN0ZGluIGJhdGNoSWQgKHRoZSBib2R5LW1pcnJvciBkaXNjaXBsaW5lIOKAlCBhXG4gICAgICAgIC8vIGZpZWxkIGFkZGVkIHRvIHRoZSBzaGFyZWQgL3Byb3Bvc2FscyBib2R5IG11c3QgYmUgdGhyZWFkZWQgaW50byBFVkVSWVxuICAgICAgICAvLyBDTEkgdmVyYiB0aGF0IHBvc3RzIHRvIGl0OyB0aGUgcHJvcG9zZS1ub2RlLXRhZ3Mgc2NhcikuXG4gICAgICAgIGJhdGNoSWQ6IGlucHV0LmJhdGNoSWQsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgICAvLyBNaXJyb3IgdGhlIGRhZW1vbidzIGFkZGl0aXZlIGVkZ2UtZHJhZnQgd2FybmluZyB0byBzdGRlcnIg4oCUIGEgY29sZFxuICAgIC8vIGFnZW50IHNjYW5uaW5nIGZvciBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgZG9lc24ndCBwYXJzZSBzdGRvdXQuXG4gICAgaWYgKHZlcmIgPT09IFwicHJvcG9zZS1lZGdlXCIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLWJhdGNoXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicHJvcG9zZS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwicHJvcG9zZS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge25vZGVzOlt7cmVmLCBkcmFmdCwgc3VnZ2VzdGVkVGllcj8sIGV2aWRlbmNlP31dLCBlZGdlczpbe2RyYWZ0Ontzb3VyY2UsIHRhcmdldCwgbGFiZWw/fX1dfVwiLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgIFwiYW4gZWRnZSBlbmRwb2ludCBtYXkgYmUgYSBub2RlIExPQ0FMIFJFRiAobWF0Y2hlcyBhIG5vZGUncyByZWYgaW4gdGhpcyBiYXRjaCksIFwiICtcbiAgICAgICAgICAgICdhIHJlYWwgbm9kZSBpZCwgYSBwZW5kaW5nIHByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIOKAlCBsb2NhbCByZWZzICcgK1xuICAgICAgICAgICAgXCJyZXNvbHZlIHRvIG1pbnRlZCBpZHMgYW5kIHRpdGxlIHJlZnMgdG8gcmF0aWZpZWQgbm9kZSBpZHMsIGJvdGggc2VydmVyLXNpZGU7IFwiICtcbiAgICAgICAgICAgIFwib3B0aW9uYWwgYmF0Y2hJZDogb21pdCBhbmQgb25lIGlzIE1JTlRFRCArIHJldHVybmVkOyBzdXBwbHkgb25lIHRvIGV4dGVuZCB0aGF0IGFjdFwiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICAgIG5vZGVzPzogdW5rbm93bjtcbiAgICAgIGVkZ2VzPzogdW5rbm93bjtcbiAgICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICAgIH07XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL2JhdGNoJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBub2RlczogaW5wdXQubm9kZXMgPz8gW10sXG4gICAgICAgIGVkZ2VzOiBpbnB1dC5lZGdlcyA/PyBbXSxcbiAgICAgICAgLy8gU0VBTSAxOiBvbWl0dGVkIOKGkiB0aGUgZGFlbW9uIG1pbnRzIGEgYmF0Y2hJZCBhbmQgcmV0dXJucyBpdDsgc3VwcGxpZWRcbiAgICAgICAgLy8g4oaSIHRoaXMgY2FsbCBqb2lucyB0aGF0IGFjdCAodGhlIFwiSSBmb3Jnb3QgdGhlIGVkZ2VzXCIgcmVwYWlyKS5cbiAgICAgICAgYmF0Y2hJZDogaW5wdXQuYmF0Y2hJZCxcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIC8vIFJlc3BvbnNlIGNhcnJpZXMge2JhdGNoSWQsIHJlZlRvSWQ6IHs8cmVmPjogPG1pbnRlZElkPn0sIHByb3Bvc2FsczogWy4uLl19XG4gICAgLy8g4oCUIHRoZSByZWbihpJpZCBtYXAgaXMgdGhlIHBvaW50IGZvciBUSElTIGNhbGwsIGFuZCBiYXRjaElkIGlzIHRoZSBwb2ludCBmb3JcbiAgICAvLyBldmVyeSBsYXRlciBvbmUgKGBzdGF0ZSAtLWJhdGNoIDxpZD5gIHJlY29uY2lsZXMgYSBwYXJ0aWFsIHJhdGlmaWNhdGlvbikuXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInJhdGlmeS1iYXRjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInJhdGlmeS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICdyYXRpZnktYmF0Y2ggcmVxdWlyZXMgLS1zdGRpbiBKU09OIHtydWxpbmc6IFwiY2Fub258dGhyZWFkfHN0b3J5LWxvY2FsXCIsIGlkczogW3Byb3Bvc2FsSWRdLCBhbmNob3JzPzogW3tub2RlLCBwYXJlbnR9XX0nLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgIFwicmF0aWZpZXMgdGhlIHNldCBpbiBPTkUgY2FsbC90eG47IG5vZGVzIHJhdGlmeSBiZWZvcmUgZWRnZXMgKGF1dG8tcGFydGl0aW9uZWQpLCBcIiArXG4gICAgICAgICAgICBcImVkZ2UgZW5kcG9pbnRzICsgYW5jaG9yIHJlZnMgcmVzb2x2ZSBvbGQgcHJvcG9zYWwgaWRzIOKGkiBtaW50ZWQgbm9kZSBpZHMgdmlhIHRoZSBcIiArXG4gICAgICAgICAgICBcInJldHVybmVkIGlkTWFwLiBOTyBhdXRvLWluY2x1ZGUgb2YgdW5saXN0ZWQgZWRnZXM7IHJlamVjdCBpcyBub3QgYSBiYXRjaCBhY3RcIixcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7XG4gICAgICBydWxpbmc/OiB1bmtub3duO1xuICAgICAgaWRzPzogdW5rbm93bjtcbiAgICAgIGFuY2hvcnM/OiB1bmtub3duO1xuICAgIH07XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL3JhdGlmeS1iYXRjaCR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcnVsaW5nOiBpbnB1dC5ydWxpbmcsXG4gICAgICAgIGlkczogaW5wdXQuaWRzID8/IFtdLFxuICAgICAgICBhbmNob3JzOiBpbnB1dC5hbmNob3JzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgLy8gUmVzcG9uc2UgY2FycmllcyB7aWRNYXA6IHs8b2xkUHJvcG9zYWxJZD46IDxtaW50ZWROb2RlSWQ+fSwgcmF0aWZpZWQ6Wy4uLl19XG4gICAgLy8g4oCUIHRoZSBpZE1hcCBpcyB0aGUgcG9pbnQgKHJlY29ubmVjdCBhbiBlZGdlL2FuY2hvciB0byB0aGUgcmVhbCBub2RlKS5cbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgMTIgKFNFQU0gNSkg4oCUIHRoZSBpbnZlcnNlIG9mIHJhdGlmeS1iYXRjaDogY2xlYXIgYSBzZXQgb2YgcHJvcG9zYWxzXG4gIC8vIGluIE9ORSB0cmFuc2FjdGlvbmFsIGNhbGwgaW5zdGVhZCBvZiBOIEhUVFAgZGVsZXRlcyBpbiBhIGxvb3AuXG4gIGlmICh2ZXJiID09PSBcImRlbGV0ZS1iYXRjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImRlbGV0ZS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoJ2RlbGV0ZS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge2lkczogW1wiPHByb3Bvc2FsSWQ+XCIsIC4uLl19Jywge1xuICAgICAgICBoaW50OlxuICAgICAgICAgIFwiZGVsZXRlcyB0aGUgc2V0IGluIE9ORSB0eG4g4oCUIGFsbC1vci1ub3RoaW5nOiBpZiBhbnkgaWQgaXMgdW5rbm93biwgTk9USElORyBpcyBcIiArXG4gICAgICAgICAgXCJkZWxldGVkIGFuZCB0aGUgZXJyb3IgbmFtZXMgZXZlcnkgdW5rbm93biBpZC4gVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIFwiICtcbiAgICAgICAgICBcIntiYXRjaDogPGlkPn0gc2hvcnRoYW5kIOKAlCBydW4gYHN0YXRlIC0tYmF0Y2ggPGlkPmAgYW5kIGxvb2sgYmVmb3JlIHlvdSBzd2VlcCBcIiArXG4gICAgICAgICAgXCIoZHJpdmUgIzEwJ3MgYnVnIHdhcyBhbiBvdmVyLWJyb2FkIGNsZWFudXAgdGhhdCB0b29rIHRoZSBlZGdlcyB3aXRoIGl0KVwiLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7IGlkcz86IHVua25vd24gfTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvZGVsZXRlLWJhdGNoJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZHM6IGlucHV0LmlkcyA/PyBbXSB9KSxcbiAgICB9KTtcbiAgICBjb25zdCBkZWxldGVCYXRjaEJvZHkgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RlbGV0ZUJhdGNoQm9keX1cXG5gKTtcbiAgICAvLyBSMTIgZ2F0ZSBmaW5kaW5nIDE6IG1pcnJvciB0aGUgc3RyYW5kZWQtbm9kZSBhZHZpc29yeSB0byBzdGRlcnIsIHRoZSBzYW1lXG4gICAgLy8gd2F5IHByb3Bvc2UtZWRnZSBtaXJyb3JzIGVkZ2VEcmFmdFdhcm5pbmcg4oCUIGEgY29sZCBhZ2VudCBzY2FubmluZyBmb3JcbiAgICAvLyBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgbmV2ZXIgcGFyc2VzIHN0ZG91dC4gQWR2aXNvcnksIG5vdCBhIGZhaWx1cmU6XG4gICAgLy8gdGhlIGV4aXQgY29kZSBpcyB1bmNoYW5nZWQuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShkZWxldGVCYXRjaEJvZHkpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgaWYgKHR5cGVvZiB3YXJuaW5nID09PSBcInN0cmluZ1wiKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB3YXJuaW5nOiAke3dhcm5pbmd9XFxuYCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJub2RlXCIpIHtcbiAgICBjb25zdCBzdWIgPSByZXN0WzBdO1xuICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCB8fCAhc3Vic09mKFwibm9kZVwiKS5pbmNsdWRlcyhzdWIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBzdWIgPT09IHVuZGVmaW5lZCA/IFwibm9kZSByZXF1aXJlcyBhIHN1Yi1jb21tYW5kXCIgOiBgdW5rbm93biBub2RlIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcIm5vZGVcIikgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoYG5vZGUgJHtzdWJ9YCBhcyBWZXJiUGF0aCwgcmVzdC5zbGljZSgxKSk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICAvLyBSb3VuZCA2IChERUwpOiBgbm9kZSBkZWxldGUgPGlkPiBbLS1mb3JjZV1gIOKAlCA0MDkge2Vycm9yOlwiY2l0ZWRcIixcbiAgICAvLyBjaXRlZEJ5OntlZGdlcywgY2hpbGRyZW59fSB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuICAgIC8vIChlZGdlcyBnb25lLCBjaGlsZHJlbiByZS1wYXJlbnRlZCB0byB0b3AtbGV2ZWwsIGRldHJpdHVzIGdvbmUpLlxuICAgIGlmIChzdWIgPT09IFwiZGVsZXRlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgICAgaWYgKCFpZCkge1xuICAgICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBub2RlIGRlbGV0ZSA8bm9kZUlkPiBbLS1mb3JjZV1cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICAgICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgZHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgLy8gUm91bmQgMTIgKFNFQU0gNCk6IGBub2RlIGVkaXQgPGlkPiBbLS10aXRsZSBUXSBbLS1zeW5vcHNpcyBTXSB8IC0tc3RkaW5gXG4gICAgLy8g4oCUIGEgcmF0aWZpZWQgbm9kZSBjYW4gZmluYWxseSBnYWluIGEgc3lub3BzaXMgKEYyKS4gV3JpdGVzIGV4YWN0bHkgd2hhdFxuICAgIC8vIGl0IGlzIGdpdmVuOyB0aWVyIGFuZCBraW5kIGFyZSBOT1QgZWRpdGFibGUgKHNlZSBlZGl0LnRzIGZvciB3aHkpLlxuICAgIGlmIChzdWIgPT09IFwiZWRpdFwiKSB7XG4gICAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICAgIGNvbnN0IHBhdGNoOiB7IHRpdGxlPzogc3RyaW5nOyBzeW5vcHNpcz86IHN0cmluZyB9ID0ge307XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikge1xuICAgICAgICAvLyBQcm9zZSBiZWxvbmdzIG9uIHN0ZGluIOKAlCBhIHN5bm9wc2lzIGlzIGEgcGFyYWdyYXBoLCBub3QgYSBmbGFnIHZhbHVlLlxuICAgICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICAgIHBhdGNoLFxuICAgICAgICAgIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyB0aXRsZT86IHN0cmluZzsgc3lub3BzaXM/OiBzdHJpbmcgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnRpdGxlICE9PSB1bmRlZmluZWQpIHBhdGNoLnRpdGxlID0gcGFyc2VkLnZhbHVlcy50aXRsZTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnN5bm9wc2lzICE9PSB1bmRlZmluZWQpIHBhdGNoLnN5bm9wc2lzID0gcGFyc2VkLnZhbHVlcy5zeW5vcHNpcztcbiAgICAgIGlmICghaWQgfHwgKHBhdGNoLnRpdGxlID09PSB1bmRlZmluZWQgJiYgcGF0Y2guc3lub3BzaXMgPT09IHVuZGVmaW5lZCkpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICAndXNhZ2U6IGNsaS50cyBub2RlIGVkaXQgPG5vZGVJZD4gKC0tdGl0bGUgPHQ+IHwgLS1zeW5vcHNpcyA8cz4gfCAtLXN0ZGluIFxcJ3tcInN5bm9wc2lzXCI6IFwiLi4uXCJ9XFwnKScsXG4gICAgICAgICAge1xuICAgICAgICAgICAgaGludDpcbiAgICAgICAgICAgICAgXCJ3cml0ZXMgZXhhY3RseSB3aGF0IGl0IGlzIGdpdmVuIChubyBpbmZlcmVuY2UpOyBvbmx5IHRpdGxlL3N5bm9wc2lzIGFyZSBlZGl0YWJsZSDigJQgXCIgK1xuICAgICAgICAgICAgICBcInRpZXIgaXMgdGhlIGh1bWFuJ3MgcnVsaW5nIGFuZCBraW5kIGlzIGEgcmF0aWZpY2F0aW9uLXRpbWUgY2xhc3NpZmljYXRpb25cIixcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgLy8gQm9keS1taXJyb3IgZGlzY2lwbGluZTogdGhyZWFkIGV2ZXJ5IGZpZWxkIGV4cGxpY2l0bHkgKHRoZVxuICAgICAgICAvLyBwcm9wb3NlLW5vZGUtdGFncyBzY2FyKSDigJQgYW4gb21pdHRlZCBrZXkgbXVzdCBzdGF5IG9taXR0ZWQgc28gdGhlXG4gICAgICAgIC8vIHJvdXRlIHBhdGNoZXMgaW5zdGVhZCBvZiBibGFua2luZy5cbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIC4uLihwYXRjaC50aXRsZSAhPT0gdW5kZWZpbmVkID8geyB0aXRsZTogcGF0Y2gudGl0bGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4ocGF0Y2guc3lub3BzaXMgIT09IHVuZGVmaW5lZCA/IHsgc3lub3BzaXM6IHBhdGNoLnN5bm9wc2lzIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgIT09IFwiYW5jaG9yXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBub2RlIGFuY2hvciA8bm9kZUlkPiAoLS10byA8cGFyZW50SWQ+IHwgLS1jbGVhcikgfCBub2RlIGVkaXQgPG5vZGVJZD4gKC0tdGl0bGUgPHQ+IHwgLS1zeW5vcHNpcyA8cz4gfCAtLXN0ZGluKSB8IG5vZGUgZGVsZXRlIDxub2RlSWQ+IFstLWZvcmNlXVxcblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgY29uc3QgaGFzVG8gPSBwYXJzZWQudmFsdWVzLnRvICE9PSB1bmRlZmluZWQ7XG4gICAgaWYgKCFpZCB8fCAoaGFzVG8gJiYgcGFyc2VkLnZhbHVlcy5jbGVhcikgfHwgKCFoYXNUbyAmJiAhcGFyc2VkLnZhbHVlcy5jbGVhcikpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBub2RlIGFuY2hvciA8bm9kZUlkPiAoLS10byA8cGFyZW50SWQ+IHwgLS1jbGVhcilcXG5cIiArXG4gICAgICAgICAgXCIgIC0tdG8gYW5jaG9ycyB0aGUgbm9kZSB1bmRlciA8cGFyZW50SWQ+IChhIHJlYWwgbm9kZSBpZCk7IC0tY2xlYXIgbW92ZXMgaXQgdG8gdG9wLWxldmVsXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0vYW5jaG9yJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJlbnRJZDogcGFyc2VkLnZhbHVlcy5jbGVhciA/IG51bGwgOiBwYXJzZWQudmFsdWVzLnRvIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJyZWFkXCIgfHwgdmVyYiA9PT0gXCJtZXNzYWdlXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicmVhZFwiLCByZXN0KTtcbiAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyByZWFkIDxtZXNzYWdlSWQ+XCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9tZXNzYWdlLyR7aWR9JHtxc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwiem9uZVwiKSB7XG4gICAgY29uc3Qgc3ViID0gcmVzdFswXTtcbiAgICBpZiAoc3ViID09PSB1bmRlZmluZWQgfHwgIXN1YnNPZihcInpvbmVcIikuaW5jbHVkZXMoc3ViKSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgc3ViID09PSB1bmRlZmluZWQgPyBcInpvbmUgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gem9uZSBzdWItY29tbWFuZDogJHtzdWJ9YCxcbiAgICAgICAgeyBjaG9pY2VzOiBzdWJzT2YoXCJ6b25lXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGB6b25lICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBpZiAoc3ViID09PSBcImNyZWF0ZVwiKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGFyc2VkLnBvc2l0aW9uYWxzLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCFuYW1lKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHpvbmUgY3JlYXRlIDxuYW1lPlwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pLFxuICAgICAgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgPT09IFwibGlzdFwiKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3pvbmVzJHtxc31gKTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHpvbmUgZGVsZXRlIDxpZD4gWy0teWVzXVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy55ZXMpIHBhcmFtcy5zZXQoXCJ5ZXNcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgZHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgem9uZSA8Y3JlYXRlIDxuYW1lPiB8IGxpc3QgfCBkZWxldGUgPGlkPiBbLS15ZXNdPlwiKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInByb21vdGVcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJwcm9tb3RlXCIsIHJlc3QpO1xuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGlmICghaWQpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHByb21vdGUgPHByb3Bvc2FsSWQ+XCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vcHJvbW90ZSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICB9KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicHJvcG9zYWxcIikge1xuICAgIGNvbnN0IHN1YiA9IHJlc3RbMF07XG4gICAgaWYgKHN1YiA9PT0gdW5kZWZpbmVkIHx8ICFzdWJzT2YoXCJwcm9wb3NhbFwiKS5pbmNsdWRlcyhzdWIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBzdWIgPT09IHVuZGVmaW5lZFxuICAgICAgICAgID8gXCJwcm9wb3NhbCByZXF1aXJlcyBhIHN1Yi1jb21tYW5kXCJcbiAgICAgICAgICA6IGB1bmtub3duIHByb3Bvc2FsIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcInByb3Bvc2FsXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGBwcm9wb3NhbCAke3N1Yn1gIGFzIFZlcmJQYXRoLCByZXN0LnNsaWNlKDEpKTtcbiAgICBjb25zdCBwcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3RcbiAgICAgID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YFxuICAgICAgOiBcIlwiO1xuICAgIC8vIFJvdW5kIDYgKERFTCk6IGBwcm9wb3NhbCBkZWxldGUgPGlkPmAg4oCUIHRoaW4sIG5vIGd1YXJkIChkcm9wIHJvdyArXG4gICAgLy8gY2FzY2FkZSBub2RlX2FjdGlvbnMpLiBUaGUgbGl0dGVyLWNsZWFyaW5nIHBhdGggKGNsZWFyIGEgcmF3XG4gICAgLy8gaW5zdHJ1Y3Rpb24tbm9kZSB0aHJvdWdoIERFTEVURSwgbm90IHJlamVjdCkuXG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHByb3Bvc2FsIGRlbGV0ZSA8cHJvcG9zYWxJZD5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0ke3Bxc31gLCB7XG4gICAgICAgIG1ldGhvZDogXCJERUxFVEVcIixcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViICE9PSBcInpvbmVcIikge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJ1c2FnZTogY2xpLnRzIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpIHwgcHJvcG9zYWwgZGVsZXRlIDxpZD5cXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGNvbnN0IGhhc1RvID0gcGFyc2VkLnZhbHVlcy50byAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghaWQgfHwgKGhhc1RvICYmIHBhcnNlZC52YWx1ZXMuY2xlYXIpIHx8ICghaGFzVG8gJiYgIXBhcnNlZC52YWx1ZXMuY2xlYXIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcInVzYWdlOiBjbGkudHMgcHJvcG9zYWwgem9uZSA8cHJvcG9zYWxJZD4gKC0tdG8gPHpvbmVJZD4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgLS10byBtb3ZlcyBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyA8em9uZUlkPjsgLS1jbGVhciBtb3ZlcyBpdCBiYWNrIHRvIHRoZSBtYWluIHF1ZXVlXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vem9uZSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgem9uZUlkOiBwYXJzZWQudmFsdWVzLmNsZWFyID8gbnVsbCA6IHBhcnNlZC52YWx1ZXMudG8gfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImRvY1wiKSB7XG4gICAgLy8gZG9jJ3Mgc3ViIGlzIE9QVElPTkFMIChgZG9jIDxpZD5gIHJlYWRzKSBhbmQgcmlkZXMgdGhlIHBvc2l0aW9uYWxzLCBzbyBhXG4gICAgLy8gcmVnaXN0cnktd2lkZSBwcm9iZSBwYXJzZSByZXNvbHZlcyB0aGUgcGF0aCBiZWZvcmUgdGhlIHBlci1wYXRoIGNoZWNrLlxuICAgIGNvbnN0IHByb2JlID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IHJlc3QsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgY29uc3QgZG9jUGF0aDogVmVyYlBhdGggPVxuICAgICAgcHJvYmUucG9zaXRpb25hbHNbMF0gPT09IFwia2luZFwiXG4gICAgICAgID8gXCJkb2Mga2luZFwiXG4gICAgICAgIDogcHJvYmUucG9zaXRpb25hbHNbMF0gPT09IFwiZGVsZXRlXCJcbiAgICAgICAgICA/IFwiZG9jIGRlbGV0ZVwiXG4gICAgICAgICAgOiBcImRvY1wiO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoZG9jUGF0aCwgcmVzdCk7XG4gICAgLy8gYGRvYyBkZWxldGUgPGlkPmAgLyBgZG9jIGtpbmQgPGlkPmAgb3ZlcmxvYWQgdGhlIHBvc2l0aW9uYWwgKGEgZG9jXG4gICAgLy8gbGl0ZXJhbGx5IHNsdWdnZWQgXCJkZWxldGVcIi9cImtpbmRcIiBpcyB1bmFkZHJlc3NhYmxlIOKAlCBhY2NlcHRlZCBmb3IgdGhlXG4gICAgLy8gcmVjb3JkLCBwbGFuLXYxeCkuXG4gICAgLy8gUm91bmQgNCAoSzEpOiBgZG9jIGtpbmQgPGRvY0lkPiA8a2luZC4uLj4gWy0tYXV0aG9yIHVzZXJ8YWdlbnRdYCBzZXRzLFxuICAgIC8vIGBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJgIGNsZWFycyAoYXV0aG9yIG51bGxzIHdpdGggaXQpLiBUaGUgaW5nZXN0XG4gICAgLy8gZGVmYXVsdHMgZGllZCDigJQgdGhpcyB2ZXJiIGlzIGhvdyBhIGRvYyBnZXRzIHR5cGVkIGF0IGFsbC5cbiAgICBpZiAocGFyc2VkLnBvc2l0aW9uYWxzWzBdID09PSBcImtpbmRcIikge1xuICAgICAgY29uc3QgZG9jSWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMV07XG4gICAgICBjb25zdCBraW5kV29yZHMgPSBwYXJzZWQucG9zaXRpb25hbHMuc2xpY2UoMikuam9pbihcIiBcIik7XG4gICAgICBpZiAoIWRvY0lkIHx8IChraW5kV29yZHMgPT09IFwiXCIgJiYgIXBhcnNlZC52YWx1ZXMuY2xlYXIpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGRvYyBraW5kIDxkb2NJZD4gPGtpbmQ+IFstLWF1dGhvciB1c2VyfGFnZW50XSB8IGRvYyBraW5kIDxkb2NJZD4gLS1jbGVhclxcblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0XG4gICAgICAgID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YFxuICAgICAgICA6IFwiXCI7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9raW5kJHtxc31gLCB7XG4gICAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KFxuICAgICAgICAgIHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgICAgICAgID8geyBraW5kOiBudWxsIH1cbiAgICAgICAgICAgIDogeyBraW5kOiBraW5kV29yZHMsIGF1dGhvcjogcGFyc2VkLnZhbHVlcy5hdXRob3IgPz8gXCJhZ2VudFwiIH0sXG4gICAgICAgICksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgY29uc3QgaXNEZWxldGUgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gPT09IFwiZGVsZXRlXCI7XG4gICAgY29uc3QgaWQgPSBpc0RlbGV0ZSA/IHBhcnNlZC5wb3NpdGlvbmFsc1sxXSA6IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcInVzYWdlOiBjbGkudHMgZG9jIDxpZD4gfCBkb2MgZGVsZXRlIDxpZD4gWy0tZm9yY2VdIHwgZG9jIGtpbmQgPGRvY0lkPiA8a2luZHwtLWNsZWFyPiBbLS1wcm9qZWN0IDxpZD5dXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICAgIGlmIChpc0RlbGV0ZSAmJiBwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICAgIGNvbnN0IHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2lkfSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBpc0RlbGV0ZSA/IFwiREVMRVRFXCIgOiBcIkdFVFwiLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJtYXJrXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwibWFya1wiLCByZXN0KTtcbiAgICBjb25zdCBkb2NJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWRvY0lkIHx8ICFwYXJzZWQudmFsdWVzLnN0YXR1cykge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgbWFyayA8ZG9jSWQ+IC0tc3RhdHVzIDxzPiBbLS1ub3RlIDx0Pl1cIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9tYXJrJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBhdXRob3I6IHBhcnNlZC52YWx1ZXMuYXV0aG9yID8/IFwiYWdlbnRcIixcbiAgICAgICAgbm90ZTogcGFyc2VkLnZhbHVlcy5ub3RlLFxuICAgICAgICBzdGF0dXM6IHBhcnNlZC52YWx1ZXMuc3RhdHVzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInNlYXJjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInNlYXJjaFwiLCByZXN0KTtcbiAgICBjb25zdCBxdWVyeSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBzZWFyY2ggPHF1ZXJ5Li4uPlwiKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgcTogcXVlcnkgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3NlYXJjaD8ke3BhcmFtc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwibmVpZ2hib3JzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwibmVpZ2hib3JzXCIsIHJlc3QpO1xuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGlmICghaWQpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXVwiKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPz8gXCIxXCIgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L25laWdoYm9ycy8ke2lkfT8ke3BhcmFtc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicmF0aWZ5XCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicmF0aWZ5XCIsIHJlc3QpO1xuICAgIGNvbnN0IHByb3Bvc2FsSWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgaWYgKCFwcm9wb3NhbElkIHx8ICFwYXJzZWQudmFsdWVzLnJ1bGluZykge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJ1c2FnZTogY2xpLnRzIHJhdGlmeSA8cHJvcG9zYWxJZD4gLS1ydWxpbmcgPHI+IFstLWRvYy1lZGl0IDxmaWxlPl0gWy0tZG9jIDxkb2NJZD4gLS1zcGFuIDx0ZXh0Pl0gWy0tYW5jaG9yIDxwYXJlbnRJZD5dXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyAtLWRvYyByZXF1aXJlcyAtLWRvYy1lZGl0IOKAlCB0aGUgZGFlbW9uIGVuZm9yY2VzIGl0IHRvbywgYnV0IGEgbG9jYWxcbiAgICAvLyB1c2FnZSBlcnJvciBiZWF0cyBhIHJvdW5kLXRyaXAgZm9yIHRoZSBjb21tb24gc2xpcC5cbiAgICBpZiAocGFyc2VkLnZhbHVlcy5kb2MgJiYgIXBhcnNlZC52YWx1ZXNbXCJkb2MtZWRpdFwiXSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcIi0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQgKHRoZSBkcmFmdGVkIGRvYyBob21lKVwiKTtcbiAgICB9XG4gICAgY29uc3QgZG9jRWRpdCA9IHBhcnNlZC52YWx1ZXNbXCJkb2MtZWRpdFwiXVxuICAgICAgPyByZWFkRmlsZVN5bmMocGFyc2VkLnZhbHVlc1tcImRvYy1lZGl0XCJdLCBcInV0ZjhcIilcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke3Byb3Bvc2FsSWR9L3J1bGluZyR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcnVsaW5nOiBwYXJzZWQudmFsdWVzLnJ1bGluZyxcbiAgICAgICAgZG9jRWRpdCxcbiAgICAgICAgZG9jSWQ6IHBhcnNlZC52YWx1ZXMuZG9jLFxuICAgICAgICBzcGFuOiBwYXJzZWQudmFsdWVzLnNwYW4sXG4gICAgICAgIC8vIFJvdW5kIDYgKFJCKTogLS1hbmNob3IgPHBhcmVudElkPiByYXRpZmllcyB0aGVuIG5lc3RzIHRoZSBtaW50ZWRcbiAgICAgICAgLy8gbm9kZSB1bmRlciA8cGFyZW50SWQ+IGluIG9uZSBhdG9taWMgY2FsbCAobm9kZSBwcm9wb3NhbHMgb25seSkuXG4gICAgICAgIGFuY2hvcjogcGFyc2VkLnZhbHVlcy5hbmNob3IsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwibGVuc1wiKSB7XG4gICAgY29uc3Qgc3ViID0gcmVzdFswXTtcbiAgICBpZiAoc3ViID09PSB1bmRlZmluZWQgfHwgIXN1YnNPZihcImxlbnNcIikuaW5jbHVkZXMoc3ViKSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgc3ViID09PSB1bmRlZmluZWQgPyBcImxlbnMgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gbGVucyBzdWItY29tbWFuZDogJHtzdWJ9YCxcbiAgICAgICAgeyBjaG9pY2VzOiBzdWJzT2YoXCJsZW5zXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGBsZW5zICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIC8vIFJvdW5kIDMgKENsYWltIFYyKTogb25lIGxlbnMsIHR3byBtb2RlcyDigJQgLS1ub2RlIGFuZCAtLWRvYyBhcmVcbiAgICAvLyBleGNsdXNpdmUgYXQgcGFyc2UgdGltZSAodGhlIGRhZW1vbiBlbmZvcmNlcyB0aGUgWE9SIHRvbywgYnV0IHRoZVxuICAgIC8vIGNvbW1vbiBzbGlwIHNob3VsZCBmYWlsIGJlZm9yZSBhIHJvdW5kLXRyaXApLlxuICAgIGlmIChwYXJzZWQudmFsdWVzLm5vZGUgIT09IHVuZGVmaW5lZCAmJiBwYXJzZWQudmFsdWVzLmRvYyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwibGVucyBzZXQgdGFrZXMgLS1ub2RlIE9SIC0tZG9jLCBub3QgYm90aFwiKTtcbiAgICB9XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuZG9jICE9PSB1bmRlZmluZWQgJiYgcGFyc2VkLnZhbHVlcy5kZXB0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiLS1kZXB0aCBhcHBsaWVzIHRvIGEgbm9kZSBsZW5zIG9ubHlcIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBpZiAoc3ViID09PSBcInNldFwiKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2xlbnMke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIG93bmVyOiBwYXJzZWQudmFsdWVzLm93bmVyID8/IFwiYWdlbnRcIixcbiAgICAgICAgICBub2RlSWQ6IHBhcnNlZC52YWx1ZXMubm9kZSxcbiAgICAgICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICAgICAgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPyBOdW1iZXIucGFyc2VJbnQocGFyc2VkLnZhbHVlcy5kZXB0aCwgMTApIDogdW5kZWZpbmVkLFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcImNsZWFyXCIpIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbGVucyR7cXN9YCwgeyBtZXRob2Q6IFwiREVMRVRFXCIgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgbGVucyA8c2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxkb2NJZD4pIHwgY2xlYXI+XFxuXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImxvb2staGVyZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImxvb2staGVyZVwiLCByZXN0KTtcbiAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBsb29rLWhlcmUgPG5vZGVJZD5cIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2xvb2staGVyZS8ke2lkfSR7cXN9YCwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJhY3Rpb25zXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiYWN0aW9uc1wiLCByZXN0KTtcbiAgICBjb25zdCB0YXJnZXRJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBjb25zdCBtb2RlcyA9IFtwYXJzZWQudmFsdWVzLnNldCAhPT0gdW5kZWZpbmVkLCBwYXJzZWQudmFsdWVzLnN0ZGluLCBwYXJzZWQudmFsdWVzLmNsZWFyXTtcbiAgICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBhY3Rpb25zIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICAgJyAge1wiaWRcIiwgXCJsYWJlbFwiLCBcInNlZWRcIn0g4oCUIGVtcHR5IGFycmF5IChvciAtLWNsZWFyKSByZW1vdmVzIHRoZSBzbG90c1xcbicsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpb25zLyR7dGFyZ2V0SWR9JHtxc31gO1xuICAgIGNvbnN0IHJlcyA9IHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgID8gYXdhaXQgZmV0Y2godGFyZ2V0LCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KVxuICAgICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgICBtZXRob2Q6IFwiUFVUXCIsXG4gICAgICAgICAgYm9keTogcGFyc2VkLnZhbHVlcy5zdGRpbiA/IGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkgOiAocGFyc2VkLnZhbHVlcy5zZXQgYXMgc3RyaW5nKSxcbiAgICAgICAgfSk7XG4gICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZXNwb25zZVRleHR9XFxuYCk7XG4gICAgLy8gTWlycm9yIHRoZSBkYWVtb24ncyBhZGRpdGl2ZSBzb2Z0LWNhcCB3YXJuaW5nIHRvIHN0ZGVyciAodGhlXG4gICAgLy8gZWRnZURyYWZ0V2FybmluZyBwYXR0ZXJuIOKAlCBhIGNvbGQgYWdlbnQgc2Nhbm5pbmcgZm9yIHByb2JsZW1zIHNlZXMgaXQpLlxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gICAgfVxuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgNyAoVEFHUykg4oCUIHR3aW4gb2YgdGhlIGFjdGlvbnMgdmVyYjogd2hvbGVzYWxlIHJlcGxhY2UgLyBjbGVhciBhXG4gIC8vIHRhcmdldCdzIGZyZWVmb3JtIHRhZ3MuIFRhcmdldCBpcyBhIG5vZGUgaWQgb3IgYSBQRU5ESU5HIHByb3Bvc2FsIGlkLlxuICBpZiAodmVyYiA9PT0gXCJ0YWdzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwidGFnc1wiLCByZXN0KTtcbiAgICBjb25zdCB0YXJnZXRJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBjb25zdCBtb2RlcyA9IFtwYXJzZWQudmFsdWVzLnNldCAhPT0gdW5kZWZpbmVkLCBwYXJzZWQudmFsdWVzLnN0ZGluLCBwYXJzZWQudmFsdWVzLmNsZWFyXTtcbiAgICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICAgXCIgIGZyZWVmb3JtIHN0cmluZ3Mg4oCUIGVtcHR5IGFycmF5IChvciAtLWNsZWFyKSByZW1vdmVzIHRoZSB0YWdzXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS90YWdzLyR7dGFyZ2V0SWR9JHtxc31gO1xuICAgIGNvbnN0IHJlcyA9IHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgID8gYXdhaXQgZmV0Y2godGFyZ2V0LCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KVxuICAgICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgICBtZXRob2Q6IFwiUFVUXCIsXG4gICAgICAgICAgYm9keTogcGFyc2VkLnZhbHVlcy5zdGRpbiA/IGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkgOiAocGFyc2VkLnZhbHVlcy5zZXQgYXMgc3RyaW5nKSxcbiAgICAgICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFJvdW5kIDkgKEpvYiBRdWV1ZSkg4oCUIHRoZSBgam9iYCB2ZXJiOiBjcmVhdGUvdXBkYXRlL2NsYWltL3JlbGVhc2Uvc3VidGFzay9cbiAgLy8gbGlzdC9kZWxldGUsIGNvcHlpbmcgdGhlIGBwcm9wb3NhbCA8c3ViPmAgbGlmZWN5Y2xlIHNoYXBlICsgdGhlIHRhZ3NcbiAgLy8gYm9keS1idWlsZGVyIGRpc2NpcGxpbmUuIEVWRVJZIGZpZWxkIGlzIHRocmVhZGVkIGludG8gdGhlIFBPU1QgYm9keSAodGhlIFI3XG4gIC8vIGdhdGUgc2NhcjogYSBoYW5kLXdyaXR0ZW4gYm9keS1idWlsZGVyIGlzIGEgTUlSUk9SIG9mIHRoZSByb3V0ZSdzIGZpZWxkIHNldFxuICAvLyBhbmQgZHJpZnRzIHNpbGVudGx5IOKAlCBzbyB1cGRhdGUgZm9yd2FyZHMgZWFjaCBwcm92aWRlZCBzY2FsYXIsIHN1YnRhc2tcbiAgLy8gZm9yd2FyZHMgb3AgKyBsYWJlbHxzdWJ0YXNrSWQsIGNsYWltIGZvcndhcmRzIG93bmVyKS5cbiAgaWYgKHZlcmIgPT09IFwiam9iXCIpIHtcbiAgICBjb25zdCBzdWIgPSByZXN0WzBdO1xuICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCB8fCAhc3Vic09mKFwiam9iXCIpLmluY2x1ZGVzKHN1YikpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIHN1YiA9PT0gdW5kZWZpbmVkID8gXCJqb2IgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gam9iIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcImpvYlwiKSB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhgam9iICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgYmFzZSA9IChwb3J0OiBudW1iZXIsIHN1ZmZpeCA9IFwiXCIpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vam9icyR7c3VmZml4fSR7cXN9YDtcbiAgICAvLyBBIEpTT04gYm9keSBmcm9tIC0tYm9keS1maWxlID4gLS1zdGRpbiBvdmVycmlkZXMgdGhlIGZsYWctYnVpbHQgYm9keSAodGhlXG4gICAgLy8gc2VuZCBwcmVjZWRlbmNlIGNoYWluKSwgc28gYSBmdWxsIGpvYiBjYW4gYmUgcGlwZWQgaW4gb25lIHNob3QuXG4gICAgY29uc3QgYm9keUZyb21Tb3VyY2UgPSBhc3luYyAoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw+ID0+IHtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgcCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgICAgIGlmICghZXhpc3RzU3luYyhwKSkge1xuICAgICAgICAgIHRocm93IHVzYWdlRXJyb3IoYGpvYjogLS1ib2R5LWZpbGUgbm90IGZvdW5kOiAke3B9YCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9O1xuXG4gICAgaWYgKHN1YiA9PT0gXCJsaXN0XCIpIHtcbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQpKTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJjcmVhdGVcIikge1xuICAgICAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBib2R5RnJvbVNvdXJjZSgpO1xuICAgICAgY29uc3QgYm9keSA9IG92ZXJyaWRlID8/IHtcbiAgICAgICAgdGl0bGU6IHBhcnNlZC52YWx1ZXMudGl0bGUsXG4gICAgICAgIHN0YXR1czogcGFyc2VkLnZhbHVlcy5zdGF0dXMsXG4gICAgICAgIGRlbGl2ZXJhYmxlOiBwYXJzZWQudmFsdWVzLmRlbGl2ZXJhYmxlLFxuICAgICAgICBkZXRhaWw6IHBhcnNlZC52YWx1ZXMuZGV0YWlsLFxuICAgICAgfTtcbiAgICAgIGlmICh0eXBlb2YgYm9keS50aXRsZSAhPT0gXCJzdHJpbmdcIiB8fCBib2R5LnRpdGxlID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiBjcmVhdGUgLS10aXRsZSA8dD4gWy0tc3RhdHVzIDxzPl0gWy0tZGVsaXZlcmFibGUgPHJlZj5dIFstLWRldGFpbCA8eD5dXFxuXCIgK1xuICAgICAgICAgICAgXCIgIG9yOiBjbGkudHMgam9iIGNyZWF0ZSAoLS1zdGRpbiB8IC0tYm9keS1maWxlIDxwYXRoPikgd2l0aCBKU09OIHt0aXRsZSwgc3RhdHVzPywgZGVsaXZlcmFibGU/LCBkZXRhaWw/fVxcblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGJhc2UocG9ydCksIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgPT09IFwidXBkYXRlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgICAgaWYgKCFpZCkge1xuICAgICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICAgIFwidXNhZ2U6IGNsaS50cyBqb2IgdXBkYXRlIDxpZD4gWy0tdGl0bGUgPHQ+XSBbLS1zdGF0dXMgPHM+XSBbLS1kZWxpdmVyYWJsZSA8cmVmPl0gWy0tZGV0YWlsIDx4Pl1cXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG92ZXJyaWRlID0gYXdhaXQgYm9keUZyb21Tb3VyY2UoKTtcbiAgICAgIC8vIEZvcndhcmQgb25seSB0aGUgZmxhZ3MgdGhhdCB3ZXJlIFBST1ZJREVEICh0aHJlYWQgZXZlcnkgZmllbGQg4oCUIHRoZSBSN1xuICAgICAgLy8gYm9keS1taXJyb3Igc2Nhcik7IGEgYmFyZSBgam9iIHVwZGF0ZSA8aWQ+YCB3aXRoIG5vIGZpZWxkcyBpcyBhIHVzYWdlXG4gICAgICAvLyBlcnJvciwgbm90IGEgc2lsZW50IG5vLW9wIFBPU1QuXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9XG4gICAgICAgIG92ZXJyaWRlID8/XG4gICAgICAgIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICAoW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiXSBhcyBjb25zdClcbiAgICAgICAgICAgIC5maWx0ZXIoKGspID0+IHBhcnNlZC52YWx1ZXNba10gIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgIC5tYXAoKGspID0+IFtrLCBwYXJzZWQudmFsdWVzW2tdXSksXG4gICAgICAgICk7XG4gICAgICBpZiAoT2JqZWN0LmtleXMoYm9keSkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiB1cGRhdGUgPGlkPiAoYXQgbGVhc3Qgb25lIG9mIC0tdGl0bGV8LS1zdGF0dXN8LS1kZWxpdmVyYWJsZXwtLWRldGFpbClcXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQsIGAvJHtpZH1gKSwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJjbGFpbVwiKSB7XG4gICAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICAgIGlmICghaWQgfHwgcGFyc2VkLnZhbHVlcy5vd25lciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiBjbGFpbSA8aWQ+IC0tb3duZXIgPHdobz5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYmFzZShwb3J0LCBgLyR7aWR9L2NsYWltYCksIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBvd25lcjogcGFyc2VkLnZhbHVlcy5vd25lciB9KSxcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcInJlbGVhc2VcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiByZWxlYXNlIDxpZD5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYmFzZShwb3J0LCBgLyR7aWR9L3JlbGVhc2VgKSwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcInN1YnRhc2tcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBjb25zdCBtb2RlcyA9IFtcbiAgICAgICAgcGFyc2VkLnZhbHVlcy5hZGQgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgcGFyc2VkLnZhbHVlcy5jaGVjayAhPT0gdW5kZWZpbmVkLFxuICAgICAgICBwYXJzZWQudmFsdWVzLnVuY2hlY2sgIT09IHVuZGVmaW5lZCxcbiAgICAgIF07XG4gICAgICBpZiAoIWlkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICBcInVzYWdlOiBjbGkudHMgam9iIHN1YnRhc2sgPGlkPiAoLS1hZGQgPGxhYmVsPiB8IC0tY2hlY2sgPHN1YnRhc2tJZD4gfCAtLXVuY2hlY2sgPHN1YnRhc2tJZD4pXFxuXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBqb2JCb2R5ID1cbiAgICAgICAgcGFyc2VkLnZhbHVlcy5hZGQgIT09IHVuZGVmaW5lZFxuICAgICAgICAgID8geyBvcDogXCJhZGRcIiwgbGFiZWw6IHBhcnNlZC52YWx1ZXMuYWRkIH1cbiAgICAgICAgICA6IHBhcnNlZC52YWx1ZXMuY2hlY2sgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyB7IG9wOiBcImNoZWNrXCIsIHN1YnRhc2tJZDogcGFyc2VkLnZhbHVlcy5jaGVjayB9XG4gICAgICAgICAgICA6IHsgb3A6IFwidW5jaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMudW5jaGVjayB9O1xuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGJhc2UocG9ydCwgYC8ke2lkfS9zdWJ0YXNrYCksIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoam9iQm9keSksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiBkZWxldGUgPGlkPlwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQsIGAvJHtpZH1gKSwgeyBtZXRob2Q6IFwiREVMRVRFXCIgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgam9iIDxjcmVhdGV8dXBkYXRlIDxpZD58Y2xhaW0gPGlkPiAtLW93bmVyIDx3aG8+fHJlbGVhc2UgPGlkPnxzdWJ0YXNrIDxpZD4gLi4ufGxpc3R8ZGVsZXRlIDxpZD4+XFxuXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImFjdGl2aXR5XCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiYWN0aXZpdHlcIiwgcmVzdCk7XG4gICAgY29uc3Qgc3RhdGUgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgaWYgKHN0YXRlICE9PSBcInJlY2VpdmVkXCIgJiYgc3RhdGUgIT09IFwidGhpbmtpbmdcIiAmJiBzdGF0ZSAhPT0gXCJpZGxlXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGFjdGl2aXR5IDxyZWNlaXZlZHx0aGlua2luZ3xpZGxlPiBbLS1tZXNzYWdlIDxpZD5dXCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpdml0eSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdGUsIG1lc3NhZ2VJZDogcGFyc2VkLnZhbHVlcy5tZXNzYWdlIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJzZW5kXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwic2VuZFwiLCByZXN0KTtcbiAgICAvLyBSb3VuZCAzIChDbGFpbSBDMSk6IGdyYXBldmluZSdzIGJvZHktcmVzb2x1dGlvbiBjaGFpbiwgcHJlY2VkZW5jZVxuICAgIC8vIC0tYm9keS1maWxlID4gLS1zdGRpbiA+IGlubGluZSBwb3NpdGlvbmFsID4gcGlwZWQtc3RkaW4gZGVmYXVsdC5cbiAgICAvLyBTaGFycCBlZGdlIChtZWFzdXJlZCwgaG91c2Utd2lkZSk6IHRoZSBwaXBlZC1zdGRpbiBkZWZhdWx0IEhBTkdTXG4gICAgLy8gRk9SRVZFUiB1bmRlciBhZ2VudCBzaGVsbHMgKGlzVFRZIG51bGwsIG5vIEVPRikg4oCUIG5vIHJlYWQgdGltZW91dCBvblxuICAgIC8vIHB1cnBvc2UgKGl0IHdvdWxkIGJyZWFrIHNsb3cgcGlwZXMpOyBhbHdheXMgcGFzcyBhIGJvZHkuXG4gICAgY29uc3QgaGFzSW5saW5lID0gcGFyc2VkLnBvc2l0aW9uYWxzLmxlbmd0aCA+IDA7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICBsZXQgZnJvbUlubGluZSA9IGZhbHNlO1xuICAgIGlmIChwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHBhdGggPSBwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoYHNlbmQ6IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwYXRofWApO1xuICAgICAgfVxuICAgICAgLy8gVHJhaWxpbmcgbmV3bGluZSBzdHJpcHBlZCAoZmlsZXMgYW5kIGhlcmVkb2NzIGVuZCB3aXRoIG9uZTsgdGhlXG4gICAgICAvLyBtZXNzYWdlIHNob3VsZG4ndCkg4oCUIG1hdGNoaW5nIC0tc3RkaW4sIGFuZCBncmFwZXZpbmUuXG4gICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG4gICAgfSBlbHNlIGlmIChwYXJzZWQudmFsdWVzLnN0ZGluIHx8ICghaGFzSW5saW5lICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgICAgdGV4dCA9IChhd2FpdCBCdW4uc3RkaW4udGV4dCgpKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRleHQgPSBwYXJzZWQucG9zaXRpb25hbHMuam9pbihcIiBcIik7XG4gICAgICBmcm9tSW5saW5lID0gdHJ1ZTtcbiAgICB9XG4gICAgLy8gQW4gRU1QVFkgcmVzb2x2ZWQgYm9keSBpcyBhIHVzYWdlIGVycm9yIChleGl0IDIpLCB3aGF0ZXZlciBwYXRoXG4gICAgLy8gcHJvZHVjZWQgaXQg4oCUIGEgYmxhbmsgbWVzc2FnZSBoZWxwcyBub2JvZHkgYW5kIHVzdWFsbHkgbWVhbnMgYSBmdW1ibGUuXG4gICAgaWYgKHRleHQgPT09IFwiXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBzZW5kIDx0ZXh0Li4uPiB8IC0tYm9keS1maWxlIDxwYXRoPiB8IC0tc3RkaW5cXG5cIiArXG4gICAgICAgICAgXCJtaW5kLW1hcHBlcjogc2VuZCByZXNvbHZlZCBhbiBlbXB0eSBib2R5IOKAlCBub3RoaW5nIHNlbnRcXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIEEgZnVtYmxlZCBoZXJlZG9jIHBpcGVzIHRoZSBsaXRlcmFsIHNlbmQgaW52b2NhdGlvbiBpbiBhcyB0aGUgYm9keSDigJRcbiAgICAvLyByZWZ1c2UgdG8gcG9zdCB0aGF0IChuYXJyb3dlZCB0byB0aGUgc2VuZCB2ZXJiOyAtLWZvcmNlIG92ZXJyaWRlcyBmb3JcbiAgICAvLyBhIGJvZHkgdGhhdCBnZW51aW5lbHkgcXVvdGVzIHRoZSBjb21tYW5kKS5cbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuZm9yY2UgJiYgLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxic2VuZFxcYi8udGVzdCh0ZXh0KSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJtaW5kLW1hcHBlcjogdGhhdCBib2R5IGxvb2tzIGxpa2UgYSBsZWFrZWQgY2xpIGludm9jYXRpb24gKGEgZnVtYmxlZCBoZXJlZG9jPykuIFwiICtcbiAgICAgICAgICBcIk5vdGhpbmcgd2FzIHNlbnQuIFBpcGUgdGhlIHJlYWwgYm9keSB2aWEgLS1zdGRpbiBvciAtLWJvZHktZmlsZSA8cGF0aD4sIFwiICtcbiAgICAgICAgICBcIm9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIElubGluZSBib2RpZXMgd2l0aCBzdXJ2aXZpbmcgc2hlbGwgbWV0YWNoYXJhY3RlcnMgbWFkZSBpdCB0aHJvdWdoIFRISVNcbiAgICAvLyB0aW1lIOKAlCB3YXJuIChzdGRlcnIsIG5ldmVyIGJsb2NrcykgYW5kIHN0ZWVyIHRvIHRoZSBzaGVsbC1mcmVlIHBhdGhzLlxuICAgIGlmIChmcm9tSW5saW5lICYmIC9gfFxcJFxcKHxcXCRcXHsvLnRlc3QodGV4dCkpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBcIiMgd2FybmluZzogaW5saW5lIGJvZHkgY29udGFpbnMgc2hlbGwgbWV0YWNoYXJhY3RlcnMgKGJhY2t0aWNrLCAkKCksIGN1cmx5LWJyYWNlIHZhcnMpLiBcIiArXG4gICAgICAgICAgXCJJdCB3YXMgc2VudCBhcy1pcywgYnV0IHRoZSBzaGVsbCBjYW4gY29tbWFuZC1zdWJzdGl0dXRlIHRoZXNlIGZpcnN0IOKAlCBcIiArXG4gICAgICAgICAgXCJ1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc2VuZCR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcm9sZTogcGFyc2VkLnZhbHVlcy5yb2xlID8/IFwiYWdlbnRcIixcbiAgICAgICAga2luZDogcGFyc2VkLnZhbHVlcy5raW5kID8/IFwidHVyblwiLFxuICAgICAgICB0ZXh0LFxuICAgICAgICAvLyBGbGF0dGVuIHJlcGVhdHMsIHNwbGl0IGNvbW1hcywgZHJvcCBibGFuayBmcmFnbWVudHMg4oCUIGFuIGVtcHR5XG4gICAgICAgIC8vIHJlc29sdmVkIGxpc3QgcG9zdHMgYXMgbm8gZ3JvdW5kIGF0IGFsbCAobmV2ZXIgW1wiXCJdKS5cbiAgICAgICAgZ3JvdW5kOiAoKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlZnMgPSAocGFyc2VkLnZhbHVlcy5ncm91bmQgPz8gW10pXG4gICAgICAgICAgICAuZmxhdE1hcCgoZykgPT4gZy5zcGxpdChcIixcIikpXG4gICAgICAgICAgICAubWFwKChnKSA9PiBnLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoKGcpID0+IGcgIT09IFwiXCIpO1xuICAgICAgICAgIHJldHVybiByZWZzLmxlbmd0aCA+IDAgPyByZWZzIDogdW5kZWZpbmVkO1xuICAgICAgICB9KSgpLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZXNwb25zZVRleHR9XFxuYCk7XG4gICAgLy8gUm91bmQgMTEgKFNFQU0gMSk6IG1pcnJvciB0aGUgZGFlbW9uJ3MgdW5rbm93bi1jaGFubmVsIGFkdmlzb3J5IHRvIHN0ZGVycixcbiAgICAvLyBzYW1lIGFzIHByb3Bvc2UtZWRnZSdzIGRyYWZ0IHdhcm5pbmcg4oCUIGEgdHlwbydkIGAtLWtpbmRgIGlzIG90aGVyd2lzZSBhXG4gICAgLy8gbWVzc2FnZSB0aGF0IHNpbGVudGx5IHJlbmRlcnMgYXMgYSBwbGFpbiBjaGF0IHR1cm4uXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgaWYgKHR5cGVvZiB3YXJuaW5nID09PSBcInN0cmluZ1wiKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB3YXJuaW5nOiAke3dhcm5pbmd9XFxuYCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICAvLyBSb290IGZhbGx0aHJvdWdoIOKAlCBOQU1FIHRoZSBvZmZlbmRpbmcgdG9rZW4sIGFuZCBkaXN0aW5ndWlzaCBmbGFnLXNoYXBlZFxuICAvLyBmcm9tIHZlcmItc2hhcGVkOiBcIi0teCBhdCB0aGUgcm9vdFwiIHNlbmRzIHRoZSBjYWxsZXIgdG8gcHV0IGl0IGFmdGVyIGFcbiAgLy8gdmVyYiwgXCJ1bmtub3duIHZlcmIgeFwiIHNlbmRzIHRoZW0gdG8gdGhlIHJvc3RlciAoY2hvaWNlcykuIEEgYmFyZVxuICAvLyBpbnZvY2F0aW9uIG5hbWVkIG5vdGhpbmcgYXQgYWxsIOKAlCBhIHVzYWdlIGVycm9yLCBub3QgYSBoZWxwIHBhdGggKHRoaXMgQ0xJXG4gIC8vIGlzIGFnZW50LWRyaXZlbjsgbWFncGllJ3MgcnVsaW5nKS5cbiAgLy9cbiAgLy8gY2hvaWNlcyBuYW1lcyBFVkVSWVRISU5HIHRoZSBwYXJzZXIgYWNjZXB0czogdGhlIHJvc3RlciB2ZXJicyBwbHVzIHRoZVxuICAvLyBhY2NlcHRlZCBhbGlhcyBzcGVsbGluZ3MsIGFsaWFzZXMgYXBwZW5kZWQgYWZ0ZXIgdGhlIHJvc3RlclxuICAvLyAoZGV0ZXJtaW5pc3RpYykuIFZFUkJTIGFsb25lIHVuZGVyc3RhdGVkIHRoZSBhY2NlcHRlZCBzZXQgYnkgZXhhY3RseSB0aGVcbiAgLy8gYWxpYXNlcyDigJQgYWNjJ3MgYWR2ZXJ0aXNlZC12ZXJicyBjb21wYXJpc29uIGZsYWdnZWQgYG1lc3NhZ2VgIGFzIHJlY29yZGVkXG4gIC8vIGJ1dCBuZXZlciBhZHZlcnRpc2VkIChncmFwZXZpbmUncyBvbmUtcm93LXBlci1hbGlhcyByZWdpc3RyeSBpcyB0aGUgaG91c2VcbiAgLy8gcHJlY2VkZW50IHRoaXMgbWF0Y2hlcykuIEhlbHAgaXMgTk9UIHRvdWNoZWQ6IHRoZSBhbGlhcyBzdGF5cyBhZHZlcnRpc2VkXG4gIC8vIG9uIGl0cyB0YXJnZXQncyBsaW5lIHBlciB0aGUgIzEwOTcgcnVsaW5nLlxuICBjb25zdCBWRVJCX0NIT0lDRVMgPSBbLi4uVkVSQlMsIC4uLk9iamVjdC5rZXlzKFZFUkJfQUxJQVNFUyldO1xuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcIm5vIHZlcmIgZ2l2ZW5cIiwgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQl9DSE9JQ0VTIH0pO1xuICB9XG4gIGlmICh2ZXJiLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIGB1bmtub3duIGZsYWcgYXQgdGhlIHJvb3Q6ICR7dmVyYn0gKGZsYWdzIGJlbG9uZyBhZnRlciBhIHZlcmI7IHJvb3QgdG9rZW5zIGFyZSAtLWhlbHAvLWggYW5kIC0tdmVyc2lvbi8tVilgLFxuICAgICAgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQl9DSE9JQ0VTIH0sXG4gICAgKTtcbiAgfVxuICB0aHJvdyB1c2FnZUVycm9yKGB1bmtub3duIHZlcmI6ICR7dmVyYn1gLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBWRVJCX0NIT0lDRVMgfSk7XG59XG5cbi8qKlxuICogVGhlIENMSSdzIG9uZSBlbnRyeSwgY2FsbGVkIGJ5IHRoZSBsYXVuY2hlciBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9taW5kLW1hcHBlci9zY3JpcHRzL2NsaS50c2AuXG4gKlxuICog4puUIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIFRIQVQgSVMgVEhFIFBPSU5ULlxuICogYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSB0aGUgbGF1bmNoZXIsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzXG4gKiBlbnRyeSwgc28gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZSBidW5kbGU6IGEgYmxvY2sgaGVyZSB3b3VsZCBuZXZlclxuICogcnVuIGFuZCB0aGUgQ0xJIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kIGV4aXQgMCBmb3IgZXZlcnkgdmVyYi4gVGhpcyBleHBvcnQgaXNcbiAqIHdoYXQgcmVwbGFjZXMgaXQuIEFuZCB0aGUgc291cmNlIGtlZXBzIG5vIHNlY29uZCBlbnRyeSBkZWxpYmVyYXRlbHkg4oCUIHRoZVxuICogYXJpdGhtZXRpYyBhYm92ZSBpcyB0cnVlIGF0IHRoZSBhcnRpZmFjdCdzIGFkZHJlc3MgYW5kIGZhbHNlIGF0IHRoaXMgZmlsZSdzLFxuICogc28gb2ZmZXJpbmcgYGJ1biBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9jbGkudHNgIHdvdWxkIGJlIG9mZmVyaW5nIGEgd3JvbmdcbiAqIHByb2Nlc3MgKHBsYXlib29rIEIzKS5cbiAqXG4gKiDim5QgSVQgUkVUVVJOUyBUSEUgQ09ERSBSQVRIRVIgVEhBTiBTRVRUSU5HIElULiBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbiAqIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlXG4gKiAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdFxuICogZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5XG4gKiB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWVcbiAqIHNoYXBlLCBzYW1lIHJlYXNvbi4gVGhlIGFzc2lnbm1lbnQgaGFwcGVucyBvbmNlLCBpbiB0aGUgbGF1bmNoZXIuIERvIG5vdCB0aWR5XG4gKiB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTOiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVNcbiAqIGl0LCB3aGljaCBpcyB0aGlzIG9uZS4gQSBsYXVuY2hlciByZWFkaW5nIHRoZSBhcmd1bWVudCB2ZWN0b3Igd291bGQgbWF0Y2ggdGhlXG4gKiBhcmctcGFyc2luZyBwcmVkaWNhdGUgaW4gYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLiAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiAqL1xuICB0ZXJtaW5hbD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKTogeyBmcmFtZTogU3NlRnJhbWUgfCBudWxsOyBjb21tZW50czogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHJldHVybiBjb2RlO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2KSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBNaW5kLW1hcHBlcidzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgb2YgdGhlIHNwZWxsLCBhbmQgVEhFIE9ORSBQTEFDRSBUSEUgRU5WIElTIFJFQUQuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTSwgQU5EIEZPUiBNSU5ELU1BUFBFUiBUSEUgU0VBTSBXQVMgUkVBTCBBTkRcbiAqIEhBTkQtTUlSUk9SRUQuIEJlZm9yZSBQaGFzZSA3IHRoZSBrZWVwYWxpdmUgd2FzIGEgbGl0ZXJhbCBgMTVfMDAwYCBpbnNpZGVcbiAqIGBzZXJ2ZXIudHNgJ3MgYGtlZXBhbGl2ZU1zKClgLCBgaWRsZVRpbWVvdXQ6IDI1NWAgd2FzIGEgc2Vjb25kIGxpdGVyYWwgYVxuICogaHVuZHJlZCBsaW5lcyBhd2F5IHdpdGggdGhlIHJlbGF0aW9uc2hpcCB3cml0dGVuIG9ubHkgaW4gcHJvc2UsIGFuZCB0aGVcbiAqIENMSSdzIHRhaWwgY2FycmllZCBhIEhBUkQtQ09ERUQgYDQ1XzAwMGAgd2F0Y2hkb2cgdW5kZXIgYSBjb21tZW50IHNheWluZ1xuICogXCLiiYggMyBtaXNzZWQgc2VydmVyIGtlZXBhbGl2ZXMgKDE1cyB0aWNrLCBDbGFpbSBGKVwiIOKAlCB0aHJlZSBudW1iZXJzLCB0d29cbiAqIGZpbGVzLCBhbmQgdGhlIGFyaXRobWV0aWMgdHlpbmcgdGhlbSB0b2dldGhlciBsaXZpbmcgaW4gYSBzZW50ZW5jZS4gTmVpdGhlclxuICogZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZVxuICogd2hvbGUgMjMtbW9kdWxlIHNlcnZlciBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIEEgbW9kdWxlIHdob3NlIG9ubHkgaW1wb3J0c1xuICogYXJlIHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaCBncmFwaCwgc28gYm90aCBoYWx2ZXMgaW1wb3J0IHRoaXMgb25lLlxuICogKipBIHZhbHVlIHRoYXQgY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQqKiwgYW5kIHRoZVxuICogXCLiiYhcIiBpbiB0aGF0IGNvbW1lbnQgaXMgbm93IGFuIGA9YC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBNSU5ELU1BUFBFUidTIE9XTiBIRUFSVEJFQVQsIE5FVkVSXG4gKiBDT1BJRUQgRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyB0aGUgcnVsZSBhc3Ryb2xhYmUgcGFpZCBmb3I6IGEgaGFyZC1jb2RlZFxuICogNDUgcyB3YXRjaGRvZyBhZ2FpbnN0IGFuIGVudi10dW5lZCBoZWFydGJlYXQgcHJvZHVjZWQgcmVjb25uZWN0cyBhdCArNDcuNCBzLFxuICogKzkyLjYgcyBhbmQgKzEzNy45IHMgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbiwgaGFybWxlc3Mgb25seVxuICogYmVjYXVzZSBhbiB1bnJlbGF0ZWQgdGhpcmQgY29uc3RhbnQgYWJzb3JiZWQgdGhlIGNodXJuLiDimqAgTWluZC1tYXBwZXIgaXMgdGhlXG4gKiBzcGVsbCB0aGF0IHdhcyBPTkUgRU5WIFZBUiBhd2F5IGZyb20gdGhhdCBleGFjdCBkZWZlY3Q6IGl0cyBrZWVwYWxpdmUgYWxyZWFkeVxuICogdG9vayBgTUlORF9NQVBQRVJfS0VFUEFMSVZFX01TYCAoaXRzIG93biBwcmVzZW5jZSBzdWl0ZSBkcml2ZXMgaXQgYXQgMjUgbXMpXG4gKiB3aGlsZSB0aGUgd2F0Y2hkb2cgd2FzIGEgbGl0ZXJhbCwgc28gYW55IGtlZXBhbGl2ZSBhYm92ZSAxNSBzIGFscmVhZHkgYnJva2VcbiAqIGV2ZXJ5IHRhaWwgYW5kIGFueSBrZWVwYWxpdmUgYmVsb3cgaXQgbWFkZSB0aGUgd2F0Y2hkb2cgdG9sZXJhdGUgZmFyIG1vcmVcbiAqIHRoYW4gdGhyZWUgbWlzc2VkIGJlYXRzLiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb20gdGhlXG4gKiBiZWF0IGl0IGlzIHdhdGNoaW5nLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKblCAqKlRIRSBFTlYgSVMgUkVTT0xWRUQgSEVSRSBBTkQgTk9XSEVSRSBFTFNFIChENzUpLCBBTkQgRk9SIFRISVMgU1BFTEwgVEhBVFxuICogUlVMRSBJUyBMT0FELUJFQVJJTkcgUkFUSEVSIFRIQU4gVElEWS4qKiBHcmFwZXZpbmUncyBwb3J0IHNoaXBwZWQgdGhlIGJlYXQnc1xuICoga25vYiBpbiBgZGFlbW9uLnRzYCBhbmQgbGVmdCBpdHMgc2VhbSBmaWxlIGRlcml2aW5nIHRoZSB3YXRjaGRvZyBmcm9tIHRoZVxuICogTElURVJBTCBkZWZhdWx0OiB0aGUgZGFlbW9uJ3MgYmVhdCB3YXMgdHVuYWJsZSBhbmQgdGhlIENMSSdzIHdhdGNoZG9nIHdhc1xuICogbm90LCBhbmQgYW55IHZhbHVlIGFib3ZlIHRoZSBkZWZhdWx0IGJyb2tlIGV2ZXJ5IHRhaWwg4oCUIGludmlzaWJsZSBhdCB0aGVcbiAqIGRlZmF1bHQsIHdoaWNoIGlzIHdoeSBpdCBzaGlwcGVkLiBUaGUgZ2VuZXJhbGlzYXRpb246ICoqYW4gZW52IGtub2IgbXVzdCBiZVxuICogcmVzb2x2ZWQgYXQgdGhlIExPV0VTVCBwb2ludCBldmVyeSBjb25zdW1lciBvZiB0aGUgZGVyaXZlZCB2YWx1ZSBjYW4gc2VlLioqXG4gKiBgcHJvY2Vzcy5lbnZgIGlzIGFtYmllbnQgaW4gYm90aCBoYWx2ZXMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IHRoaXMgZmlsZSDigJQgYW5kXG4gKiBub3QgYHNlcnZlci50c2Ag4oCUIGNhbiBob2xkIHRoZSByZXNvbHV0aW9uLCBhbmQgcmVhZGluZyBpdCBoZXJlIGlzIG5vdCB0aGVcbiAqIGtpbmQgb2YgaW1wb3J0IHRoYXQgY2xvc2VzIHRoZSBzZWFtLlxuICpcbiAqIOKblCAqKkFORCBUSEUgREVSSVZBVElPTiBTVVBQTElFUyBUSEUgREVGQVVMVCwgTk9UIFRIRSBWQUxVRSAoRDgyKS4qKiBUaGUgdHdvXG4gKiB0YWlsIGtub2JzIGJlbG93IGFyZSB0aGUgcmVhc29uOiBgYmFja2VuZC90YWlsLnRlc3QudHNgIGlzIHRoZSByZXBvJ3MgT05MWVxuICogZXhlY3V0YWJsZSB0YWlsIHNwZWNpZmljYXRpb24sIGl0IGlzIHRoaXMgcG9ydCdzIE9SQUNMRSwgYW5kIGFsbCBmb3VyIG9mIGl0c1xuICogY2VsbHMgZHJpdmUgYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NUz0yMDBgIC8gYE1JTkRfTUFQUEVSX1RBSUxfUkVUUllfTVM9NTBgLlxuICogV3JpdHRlbiBnbGFtb3VyJ3Mgd2F5IOKAlCB0aHJlZSBwbGFpbiBgZXhwb3J0IGNvbnN0YHMgd2l0aCBubyBvdmVycmlkZSBhbnl3aGVyZVxuICog4oCUIHRoZSBpZGxlLXdhdGNoZG9nIGNlbGwgRkFJTFMgKGEgNDUsMDAwIG1zIHdhdGNoZG9nIGNhbm5vdCBmaXJlIGluc2lkZSBpdHNcbiAqIDUgcyBkZWFkbGluZSwgYW5kIGl0IHJlYWRzIGFzIGEgYnJva2VuIHdhdGNoZG9nKSBhbmQgdGhlIGtlZXBhbGl2ZSBjZWxsXG4gKiAqKlBBU1NFUyBWQUNVT1VTTFkqKjogaXQgYXNzZXJ0cyB0aGF0IG5vdGhpbmcgd2FzIGFib3J0ZWQsIGFuZCA0NSBzIGNhbm5vdFxuICogYWJvcnQgYW55dGhpbmcgaW5zaWRlIGl0cyA4MDAgbXMgd2luZG93LiBBIGdyZWVuIGNlbGwgdGhhdCBsb3N0IGl0cyBzdWJqZWN0XG4gKiBpcyB3b3JzZSB0aGFuIGEgcmVkIG9uZS4g4pqgIEFuZCB0aGUga25vYiBjYW5ub3QgYmUgcm91dGVkIHRocm91Z2ggdGhlIEJFQVRcbiAqIGluc3RlYWQ6IHRoZSBraXQgZmxvb3JzIGBoZWFydGJlYXRNc2AgYXQgYE1JTl9IRUFSVEJFQVRfTVMgPSA1MDBgIChENzYg4oCUIHRoZVxuICogZmxvb3IgbGl2ZXMgYXQgdGhlIGRlcml2YXRpb24pLCBzbyB0aGUgc21hbGxlc3Qgd2F0Y2hkb2cgcmVhY2hhYmxlIHRocm91Z2hcbiAqIGB0YWlsSWRsZU1zYCBpcyAxLDUwMCBtcyBhbmQgKioyMDAgbXMgaXMgdW5yZWFjaGFibGUgdGhhdCB3YXkgYnlcbiAqIGNvbnN0cnVjdGlvbi4qKiBgdGFpbElkbGVNc2AgY2FycmllcyBubyBmbG9vciBvZiBpdHMgb3duLCBzbyBhIGRpcmVjdFxuICogb3ZlcnJpZGUgcmVhY2hlcyBpdC5cbiAqXG4gKiDimqAgKipUaGUgbWFwcGluZyBiZWxvdyB3YXMgd3JpdHRlbiBlaWdodCBtb250aHMgZWFybHkgYW5kIGFkZHJlc3NlZCB0b1xuICogbm9ib2R5Kiog4oCUIGBwaGFzZS0xLWpvdXJuYWwubWQ6MTUxLTE1NWAgbmFtZWQgYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2Ag4oaSXG4gKiBgaWRsZU1zYCBhbmQgYE1JTkRfTUFQUEVSX1RBSUxfUkVUUllfTVNgIOKGkiBgcmV0cnkuaW5pdGlhbE1zYCBhbmQgY29uY2x1ZGVkXG4gKiBcImEgc3BlbGwgd2hvc2UgdGVzdHMgZHJpdmUgYSBzaG9ydCB3aW5kb3cgd2lsbCBuZWVkIG9uZSwgYW5kIGl0IHNob3VsZCBiZVxuICogdGhhdCBzcGVsbCdzIGVudiB2YXIsIG5vdCB0aGUga2l0J3NcIi4gVGhpcyBpcyB0aGF0IHNwZWxsIChEODQpLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgaGVhcnRiZWF0TXMsXG4gIGlkbGVUaW1lb3V0U2VjLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgb3IgdGhlIGZhbGxiYWNrLlxuICpcbiAqIOKaoCBUSEUgS0lUJ1MgYGludE9yYCBJUyBOT1QgRVhQT1JURUQsIGRlbGliZXJhdGVseSDigJQgaXQgaXMgdGhlIHByaXZhdGUgcGFyc2VyXG4gKiBiZWhpbmQgYGhlYXJ0YmVhdE1zYC9gaWRsZVRpbWVvdXRTZWNgLCBhbmQgRDc2IHJ1bGVkIHRoYXQgYSBrbm9iIHdpdGggYSBrbm93blxuICogc2FmZSBtaW5pbXVtIGNsYW1wcyBhdCBpdHMgREVSSVZBVElPTiByYXRoZXIgdGhhbiBpbiB0aGUgc2hhcmVkIHBhcnNlci4gU29cbiAqIHRoaXMgaXMgbWluZC1tYXBwZXIncyBvd24gY29weSBvZiB0aGUgc2FtZSB0aHJlZSBsaW5lcywgd2l0aCB0aGUgc2FtZVxuICogYHBhcnNlSW50YCBzZW1hbnRpY3MgdGhlIGtpdCBkb2N1bWVudHMgKGBcIjFlOVwiYCBpcyAxLCBgXCI1YWJjXCJgIGlzIDUpIGFuZCB0aGVcbiAqIHNhbWUgXCJhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUgdGFrZXMgdGhlIGZhbGxiYWNrXCIgcnVsZS5cbiAqIEl0IGlzIHRoZSBleHByZXNzaW9uIHRoZSBDTEkncyBvd24gYGVudk1zYCB1c2VkIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZC5cbiAqXG4gKiDim5QgQU5EIFRIRSBUV08gVEFJTCBLTk9CUyBCRUxPVyBERUxJQkVSQVRFTFkgSEFWRSBOTyBGTE9PUi4gQSB3YXRjaGRvZyBhbmQgYVxuICogcmVjb25uZWN0IGRlbGF5IGFyZSB0aGUgdHdvIHZhbHVlcyB0aGlzIHNwZWxsJ3Mgb3duIHRlc3Qgc3VpdGUgbXVzdCBiZSBhYmxlXG4gKiB0byBkcml2ZSBET1dOIHRvIDIwMCBtcyBhbmQgNTAgbXM7IGEgZmxvb3IgaGVyZSB3b3VsZCBtYWtlIHRoZSBvcmFjbGVcbiAqIHVucmVhY2hhYmxlLCB3aGljaCBpcyB0aGUgZGVmZWN0IEQ4MiB3YXMgd3JpdHRlbiBhYm91dC4gVGhlIGZsb29yIGV4aXN0c1xuICogd2hlcmUgdGhlIGZsb29kIHJpc2sgaXMg4oCUIG9uIHRoZSBCRUFULCBpbiB0aGUga2l0LlxuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIE1pbmQtbWFwcGVyJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLFxuICogbm90IGFuIGluaGVyaXRlZCBvbmU6IGBzZXJ2ZXIudHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHVuZGVyIGEgY29tbWVudFxuICogcmVjb3JkaW5nIHRoYXQgU1NFIGFuZCBXUyBjb25uZWN0aW9ucyBvbiBgL2V2ZW50c2Agc2l0IGlkbGUgYmV0d2VlbiBlbWl0cyBieVxuICogZGVzaWduLCB0aGF0IEJ1bidzIGRlZmF1bHQgMTAgcyB3b3VsZCByZXNldCBhIHF1aWV0IHN0cmVhbSwgYW5kIHRoYXQgYDBgIGlzXG4gKiBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBzdGFsbHMgdGhlIGluaXRpYWwgcmVzcG9uc2Ug4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhXG4gKiBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS5cbiAqXG4gKiDimqAgYE1JTkRfTUFQUEVSX0lETEVfVElNRU9VVF9TRUNgIGlzIGFjY2VwdGVkIHNvIHRoZSBQQUlSIGNhbiBiZSB0dW5lZFxuICogdG9nZXRoZXIsIGFuZCB0aGUgY2xhbXAgaW4gYGhlYXJ0YmVhdE1zYCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLlxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKFxuICBwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGFuZCBtaW5kLW1hcHBlcidzIG93biBsaXRlcmFsIChDbGFpbSBGJ3MgMTUgc1xuICogIHRpY2spIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZCDigJQgdGhlIERFRkFVTFQsIGJlZm9yZSB0aGUgZW52IGlzIGNvbnN1bHRlZC4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqXG4gKiBUaGUgU1NFIGtlZXBhbGl2ZSwgaW4gbXMsIGVudi1yZXNvbHZlZCBhbmQgY2xhbXBlZCBhdCBib3RoIGVuZHMgYnkgdGhlIGtpdDpcbiAqIG5ldmVyIGFib3ZlIGBJRExFX1RJTUVPVVRfU0VDIC8gMmAgKG9yIEJ1biBjbG9zZXMgdGhlIGNvbm5lY3Rpb24gdGhlXG4gKiBrZWVwYWxpdmUgd2FzIHByZXNlcnZpbmcpLCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICog4puUIFRIRSBGTE9PUiBJUyBOT1QgREVDT1JBVElPTiAoRDc2KS4gYE1JTkRfTUFQUEVSX0tFRVBBTElWRV9NU2AgaXMgYSBrbm9iXG4gKiBtaW5kLW1hcHBlcidzIG93biBwcmVzZW5jZSBzdWl0ZSBkcml2ZXMsIGFuZCBgcGFyc2VJbnRgIHJlYWRzIGBcIjFlOVwiYCDigJQgdGhlXG4gKiBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXQgaHVnZVwiIOKAlCBhcyAqKjEqKi4gRHJpdmVuIGF0IGdyYXBldmluZSdzXG4gKiByZXBhaXIgYmVmb3JlIHRoZSBmbG9vciBleGlzdGVkOiBhIDEgbXMgYmVhdCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50b1xuICogZXZlcnkgb3BlbiBTU0UgY2xpZW50IGluIDUyOCBtcy5cbiAqXG4gKiDimqAgQU5EIEZPUiBUSElTIFNQRUxMIFRIRSBCRUFUIEFMU08gQk9VTkRTIEEgSFVNQU4tVklTSUJMRSBOVU1CRVIuIFByZXNlbmNlXG4gKiAoQ2xhaW0gQykgaXMgY291bnRlZCBhdCBTU0Ugc3Vic2NyaWJlL3Vuc3Vic2NyaWJlIGFuZCBhIGRlYWQgc29ja2V0IGlzIG9ubHlcbiAqIHJlY2xhaW1lZCB3aGVuIHRoZSBuZXh0IGtlZXBhbGl2ZSB3cml0ZSBmYWlscywgc28gcmFpc2luZyB0aGlzIGtub2IgbWFrZXMgdGhlXG4gKiBhZ2VudCBjb3VudCBpbiB0aGUgYm9hcmQncyBhY3Rpdml0eSBpbmRpY2F0b3Igc3RhbGVyLCBub3QganVzdCBxdWlldGVyLlxuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKFxuICBwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9LRUVQQUxJVkVfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC4gNDUsMDAwIG1zIGF0IHRoZSBkZWZhdWx0IOKAlFxuICogd2hpY2ggaXMgdGhlIG51bWJlciBgY2xpLnRzYCB1c2VkIHRvIGhhcmQtY29kZSwgc28gdGhlIHBvcnQgY2hhbmdlcyBub1xuICogZGVmYXVsdCB3aGlsZSBtYWtpbmcgdGhlIHJlbGF0aW9uc2hpcCB0cnVlIGF0IGV2ZXJ5IG90aGVyIHZhbHVlLlxuICpcbiAqIOKblCBERVJJVkVEIEZST00gVEhFIFJFU09MVkVEIEJFQVQsIE5FVkVSIEZST00gVEhFIERFRkFVTFQg4oCUIGdyYXBldmluZSdzXG4gKiByZXBhaXIgY2hhcHRlciBpcyB3aGF0IHRoZSBkaWZmZXJlbmNlIGNvc3QuIEFuZCB0aGUgZW52IG92ZXJyaWRlIGlzIHRoZVxuICogRkFMTEJBQ0sncyByZXBsYWNlbWVudCwgbm90IHRoZSBkZXJpdmF0aW9uJ3M6IHRoZSBkZXJpdmF0aW9uIGlzIHdoYXQgdGhlIGtub2JcbiAqIGZhbGxzIGJhY2sgdG8sIHNvIGFuIHVudHVuZWQgdGFpbCBzdGlsbCB3YXRjaGVzIHRocmVlIG9mIHRoaXMgZGFlbW9uJ3MgYmVhdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSBpbnRPcihcbiAgcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfVEFJTF9JRExFX01TLFxuICB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpLFxuKTtcblxuLyoqXG4gKiBUaGUgcmVjb25uZWN0IGJhY2tvZmYncyBGSVJTVCBkZWxheSwgaW4gbXMuIDEsMDAwIHRvZGF5LCB3aGljaCBpcyB3aGF0XG4gKiBgY2xpLnRzYCdzIGByZXRyeU1zYCBkZWZhdWx0ZWQgdG8uXG4gKlxuICog4puUIEFORCBUSEUgU0hBUEUgQ0hBTkdFUyBFVkVOIFRIT1VHSCBUSEUgTlVNQkVSIERPRVMgTk9UOiB0aGUgaGFuZC1yb2xsZWRcbiAqIGxvb3Agc2xlcHQgdGhpcyBsb25nIGFmdGVyIEVWRVJZIGZhaWxlZCBhdHRlbXB0LCBmbGF0LCBmb3JldmVyIOKAlCBhXG4gKiBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0sIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGxcbiAqIGB0YWlsRXZlbnRzYCdzIG93biB3YXJuaW5nIGFib3V0IHRoYXQgYnJhbmNoIHdhcyB3cml0dGVuIGFib3V0LiBUaGUga2l0XG4gKiBkb3VibGVzIGl0IHRvIGBtYXhNc2AgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbiwgc28gYSBkZWFkIGRhZW1vbiBpc1xuICogYmFja2VkIG9mZiBmcm9tIGluc3RlYWQgb2YgaGFtbWVyZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX1JFVFJZX01TID0gaW50T3IocHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfVEFJTF9SRVRSWV9NUywgMV8wMDApO1xuXG4vKiogVGhlIGJhY2tvZmYgY2VpbGluZywgdGhlIGtpdCdzIGRlZmF1bHQsIHN0YXRlZCBoZXJlIHNvIGJvdGggaGFsdmVzIGNhbiBzZWVcbiAqICB0aGUgd2hvbGUgcmV0cnkgc2hhcGUgaW4gb25lIHBsYWNlIHJhdGhlciB0aGFuIGhhbGYgb2YgaXQuICovXG5leHBvcnQgY29uc3QgVEFJTF9SRVRSWV9NQVhfTVMgPSA1XzAwMDtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUEwR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDekRPLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBR1osU0FBUyxpQkFBaUIsR0FBa0I7QUFBQSxFQUNqRCxPQUFPO0FBQUE7QUFTRixTQUFTLGFBQWEsQ0FBQyxNQUFlLFNBQWlCLE9BQTBCO0FBQUEsRUFDdEYsT0FBTyxHQUFHLEtBQUssVUFBVTtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxNQUNMO0FBQUEsTUFDQSxXQUFXLFNBQVM7QUFBQSxNQUVwQixXQUFXO0FBQUEsTUFDWDtBQUFBLFNBQ0ksT0FBTyxPQUFP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
