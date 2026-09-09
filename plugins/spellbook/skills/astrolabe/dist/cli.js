#!/usr/bin/env bun
// @bun

// src/astrolabe/backend/cli.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// src/kit/lib/printJson.ts
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}

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
      ...extra?.choices ? { choices: extra.choices } : {}
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
function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function idleTimeoutSec(raw, fallback = MAX_IDLE_TIMEOUT_SEC) {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}
function heartbeatMs(raw, idleSec, fallback = DEFAULT_HEARTBEAT_MS) {
  return Math.min(intOr(raw, fallback), Math.max(500, Math.floor(idleSec * 1000 / 2)));
}
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/astrolabe/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.ASTROLABE_IDLE_TIMEOUT);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.ASTROLABE_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, 1e4);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/astrolabe/backend/cli.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "astrolabe");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join(homedir(), ".astrolabe");
var PORT_FILE = join(ASTROLABE_HOME, "daemon.port");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function resolveAs(flags) {
  const v = flags.as ?? flags.from;
  if (typeof v === "string" && v.trim())
    return v.trim();
  const env = process.env.ASTROLABE_AS;
  return env?.trim() ? env.trim() : undefined;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of Bun.stdin.stream())
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}
async function readPort() {
  try {
    const p = Number.parseInt((await Bun.file(PORT_FILE).text()).trim(), 10);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}
async function isUp(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/state`)).ok;
  } catch {
    return false;
  }
}
async function ensureDaemon() {
  const existing = await readPort();
  if (existing && await isUp(existing)) {
    return { base: `http://127.0.0.1:${existing}`, port: existing };
  }
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd: daemonCwd()
  });
  proc.unref();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(80);
    const p = await readPort();
    if (p && await isUp(p))
      return { base: `http://127.0.0.1:${p}`, port: p };
  }
  die("astrolabe daemon failed to start within 45s", "internal");
}
async function runningBase() {
  const p = await readPort();
  return p ? `http://127.0.0.1:${p}` : null;
}
async function postCmd(base, body) {
  const res = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json();
}
async function cmd(base, body) {
  const r = await postCmd(base, body);
  if (!r.applied && r.error)
    die(r.error);
  printJson(r);
}
function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}
async function streamEvents(opts) {
  const inScope = (ev) => {
    if (!opts.scopeId)
      return true;
    if (ev.type === "ready" || ev.type === "closed")
      return true;
    return ev.projectId === opts.scopeId;
  };
  return await tailEvents({
    resolve: runningBase,
    path: "/events",
    since: opts.since,
    cursorOf: (ev) => ev.id,
    query: (cursor) => ({
      since: String(cursor),
      ...opts.project ? { project: opts.project } : {}
    }),
    accept: (ev) => inScope(ev) && !(opts.self !== undefined && ev.by === opts.self),
    terminal: (ev) => ev.type === "closed",
    epochOf: (ev) => ev.epoch,
    onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": astrolabe-keepalive"
  });
}
async function cmdOpen(flags) {
  const { port } = await ensureDaemon();
  if (!flags["no-open"])
    openBrowser(`http://127.0.0.1:${port}`);
  printJson({ ok: true, url: `http://127.0.0.1:${port}`, port });
}
async function cmdAdd(pos, flags) {
  const name = pos.join(" ").trim();
  if (!name)
    die("usage: add <name> --path <p> [--description ..] [--avatar ..] [--id ..]");
  const path = typeof flags.path === "string" ? flags.path.trim() : "";
  if (!path)
    die("add requires --path <p>");
  const description = flags.stdin ? await readStdin() : typeof flags.description === "string" ? flags.description : undefined;
  const avatar = typeof flags.avatar === "string" ? flags.avatar : undefined;
  const id = typeof flags.id === "string" && flags.id.trim() ? flags.id.trim() : undefined;
  const { base } = await ensureDaemon();
  await cmd(base, {
    type: "project.add",
    project: { id, name, path, description, avatar },
    as: resolveAs(flags)
  });
}
async function cmdRemove(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: remove <id>");
  const { base } = await ensureDaemon();
  await cmd(base, { type: "project.remove", id, as: resolveAs(flags) });
}
async function cmdStatus(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: status <id> <summary...> [--phase ..] [--stdin]");
  const summary = flags.stdin ? await readStdin() : pos.slice(1).join(" ").trim();
  if (!summary)
    die("status requires a summary (positional or --stdin)");
  const phase = typeof flags.phase === "string" ? flags.phase : undefined;
  const { base } = await ensureDaemon();
  await cmd(base, { type: "status", id, summary, phase, as: resolveAs(flags) });
}
async function cmdAttention(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: attention <id> [--clear] [--question ...]");
  const raised = flags.clear !== true;
  const question = typeof flags.question === "string" ? flags.question : pos.slice(1).join(" ").trim() || undefined;
  const { base } = await ensureDaemon();
  await cmd(base, { type: "attention", id, raised, question, as: resolveAs(flags) });
}
async function cmdPoke(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: poke <id>");
  const { base } = await ensureDaemon();
  await cmd(base, { type: "poke", id, as: resolveAs(flags) });
}
async function cmdState() {
  const base = await runningBase();
  if (!base || !await isUp(Number.parseInt(base.split(":").pop(), 10))) {
    printJson({ ok: true, running: false, state: { title: "Observatory", projects: [] } });
    return;
  }
  const res = await fetch(`${base}/state`);
  if (!res.ok)
    die(`state failed (HTTP ${res.status})`);
  printJson(await res.json());
}
async function cmdList() {
  const base = await runningBase();
  if (!base || !await isUp(Number.parseInt(base.split(":").pop(), 10))) {
    printJson({ ok: true, running: false, projects: [] });
    return;
  }
  const { state } = await (await fetch(`${base}/state`)).json();
  printJson({
    ok: true,
    running: true,
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      zone: p.zone,
      connected: p.connected
    }))
  });
}
async function cmdClose(flags) {
  const base = await runningBase();
  if (!base) {
    printJson({ ok: true, applied: false, error: "no daemon running" });
    return;
  }
  printJson(await postCmd(base, { type: "close", as: resolveAs(flags) }));
}
async function cmdInfo() {
  const port = await readPort();
  if (port && await isUp(port)) {
    printJson({ ok: true, running: true, url: `http://127.0.0.1:${port}`, port });
  } else {
    printJson({ ok: true, running: false });
  }
}
var HELP = `astrolabe \u2014 a standing observatory board for projects in flight.

  open [--no-open]
      ensure the daemon is up + open the board in the browser
  add <name> --path <p> [--description ..] [--avatar ..] [--id ..] [--stdin]
      register a project (dedupe-guarded; id + avatar derived from the name when omitted).
      the response echoes the derived id \u2014 you need it for join/status/attention/remove.
  remove <id>
      unregister a project
  join <id> [--as <name>] [--since N]
      activate the card + listen for pokes (scoped tail; wrap with Monitor). end it to idle the card.
  status <id> <summary...> [--phase ..] [--stdin]
      replace a project's current status
  attention <id> [--clear] [--question ...]
      raise / clear the needs-you gate (--question attaches the prompt)
  poke <id>
      request a fresh status from the project's agent
  state
      read-back: project cards (each carries a derived zone: attention | active | quiet)
  tail [--since N] [--as <name>]
      unscoped event tail as JSONL (no presence)
  list | close | info | help | --version

  Identity: --as / --from (or $ASTROLABE_AS) stamps the actor + suppresses self-echo.
  --stdin reads a description/summary from stdin (shell-quoting-safe).
  Output: every command prints JSON on stdout by default, one line per answer;
  failures put one JSON error envelope on stderr and exit non-zero (2 = usage).
  There is no prose mode to switch out of.`;
async function versionInfo() {
  try {
    const pkg = await Bun.file(join(SCRIPT_DIR, "../../../.claude-plugin/plugin.json")).json();
    if (typeof pkg?.version === "string")
      return { name: "astrolabe", version: pkg.version };
  } catch {}
  return { name: "astrolabe", version: "unknown" };
}
async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (e) {
    const code = reportCliError(e);
    if (code === null)
      throw e;
    return code;
  }
}
async function dispatch(argv) {
  const verb = argv[0];
  setCurrentCommand(verb ?? null);
  if (verb === undefined)
    die("no verb given \u2014 try 'help'");
  if (verb === "help" || verb === "--help" || verb === "-h") {
    process.stdout.write(`${HELP}
`);
    return 0;
  }
  if (verb === "--version" || verb === "-V" || verb === "version") {
    printJson(await versionInfo());
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        as: { type: "string" },
        from: { type: "string" },
        path: { type: "string" },
        description: { type: "string" },
        avatar: { type: "string" },
        id: { type: "string" },
        phase: { type: "string" },
        question: { type: "string" },
        since: { type: "string" },
        timeout: { type: "string" },
        clear: { type: "boolean", default: false },
        stdin: { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false }
      },
      strict: true,
      allowPositionals: true
    });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  const flags = parsed.values;
  const pos = parsed.positionals;
  const since = typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1;
  switch (verb) {
    case "open":
      await cmdOpen(flags);
      return 0;
    case "add":
      await cmdAdd(pos, flags);
      return 0;
    case "remove":
      await cmdRemove(pos, flags);
      return 0;
    case "status":
      await cmdStatus(pos, flags);
      return 0;
    case "attention":
      await cmdAttention(pos, flags);
      return 0;
    case "poke":
      await cmdPoke(pos, flags);
      return 0;
    case "state":
      await cmdState();
      return 0;
    case "list":
      await cmdList();
      return 0;
    case "close":
      await cmdClose(flags);
      return 0;
    case "info":
      await cmdInfo();
      return 0;
    case "join": {
      const id = pos[0];
      if (!id)
        die("usage: join <id> [--as <name>] [--since N]");
      const { base } = await ensureDaemon();
      const { state } = await (await fetch(`${base}/state`)).json();
      if (!state.projects.some((p) => p.id === id))
        die(`unknown project '${id}' \u2014 register it first`);
      return await streamEvents({ since, project: id, scopeId: id, self: resolveAs(flags) });
    }
    case "tail": {
      await ensureDaemon();
      return await streamEvents({ since, self: resolveAs(flags) });
    }
    default:
      die(`unknown verb '${verb}' \u2014 try 'help'`);
  }
}
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  run,
  main
};

//# debugId=775168903052B05364756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9hc3Ryb2xhYmUvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGFzdHJvbGFiZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgc3RhbmRpbmcgb2JzZXJ2YXRvcnlcbi8vIGRhZW1vbidzIEhUVFAgc3VyZmFjZSAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgYm9hcmQgdGhyb3VnaCB0aGVzZVxuLy8gdmVyYnM7IGBqb2luYC9gdGFpbGAgc3RyZWFtIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwLlxuLy9cbi8vIERpc2NvdmVyeSArIGxpZmVjeWNsZTogYSBTSU5HTEVUT04gZGFlbW9uIHBlciAkQVNUUk9MQUJFX0hPTUUuIFRoZSBmaXJzdCB2ZXJiXG4vLyB0aGF0IG5lZWRzIGl0IGF1dG8tc3Bhd25zIGl0IChkZXRhY2hlZCwgc3Vydml2ZXMgdGhpcyBDTEkpOyBpdCdzIGZvdW5kIHZpYVxuLy8gJEFTVFJPTEFCRV9IT01FL2RhZW1vbi57cG9ydCxwaWR9LlxuLy9cbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyB1cCArIG9wZW4gdGhlIGJvYXJkXG4vLyAgIGJ1biBjbGkudHMgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbi8vICAgYnVuIGNsaS50cyByZW1vdmUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgIyB1bnJlZ2lzdGVyIGEgcHJvamVjdCAoZHVyYWJsZSlcbi8vICAgYnVuIGNsaS50cyBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXSAgICMgc2NvcGVkIC9ldmVudHMgdGFpbCDigJQgQUNUSVZBVEVTIHRoZSBjYXJkICsgcmVjZWl2ZXMgcG9rZXMgKHdyYXAgd2l0aCBNb25pdG9yKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyA8aWQ+IDxzdW1tYXJ5Li4uPiBbLS1waGFzZSAuLl0gWy0tc3RkaW5dICAgIyByZXBsYWNlIHRoZSBjdXJyZW50IHN0YXR1c1xuLy8gICBidW4gY2xpLnRzIGF0dGVudGlvbiA8aWQ+IFstLWNsZWFyXSBbLS1xdWVzdGlvbiAuLi5dICAgICAgICAgIyByYWlzZSAvIGNsZWFyIHRoZSBodW1hbiBnYXRlXG4vLyAgIGJ1biBjbGkudHMgcG9rZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICMgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyByZWFkLWJhY2s6IHByb2plY3QgY2FyZHNcbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dIFstLWFzIDxuYW1lPl0gICAgIyB1bnNjb3BlZCBldmVudCB0YWlsIOKGkiBKU09OTCAobm8gcHJlc2VuY2UpXG4vLyAgIGJ1biBjbGkudHMgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHBcbi8vXG4vLyBgam9pbmAgaXMgdGhlIGxpc3RlbmluZyBsb29wIGEgcHJvamVjdCdzIGFnZW50IHJ1bnM6IGhvbGRpbmcgdGhlIHNjb3BlZFxuLy8gYC9ldmVudHM/cHJvamVjdD08aWQ+YCB0YWlsIG9wZW4gaXMgd2hhdCBtYXJrcyB0aGUgY2FyZCBhY3RpdmUgKHBlciB0aGUgZGFlbW9uXG4vLyBjb250cmFjdCDigJQgcHJlc2VuY2UgSVMgdGhlIGxpdmUgY29ubmVjdGlvbiksIGFuZCB0aGUgc2FtZSB0YWlsIGRlbGl2ZXJzIHBva2VzLlxuLy9cbi8vIElkZW50aXR5OiAtLWFzIC8gLS1mcm9tIChvciAkQVNUUk9MQUJFX0FTKSBzdGFtcHMgdGhlIGV2ZW50IGBieWAgYW5kIGRyaXZlc1xuLy8gc2VsZi1lY2hvIHN1cHByZXNzaW9uLiAtLXN0ZGluIHJlYWRzIGZyZWUgdGV4dCAoZGVzY3JpcHRpb24vc3VtbWFyeSkgZnJvbVxuLy8gc3RkaW4gKGJ5cGFzc2VzIHNoZWxsIHF1b3RpbmcpLiBEaXNjaXBsaW5lOiBzdHJ1Y3R1cmVkIEpTT04gb24gc3Rkb3V0IChvbmVcbi8vIGxpbmUpOyBsaXZlbmVzcywgZWNob2VzIGFuZCBrZWVwYWxpdmVzIG9uIHN0ZGVycjsgZmFpbHVyZXMgcHV0IE9ORSBKU09OIGVycm9yXG4vLyBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgbGVmdCBlbXB0eSDigJQgbmV2ZXIgbWVyZ2Ugc3RyZWFtcy4gRXhpdCAyIG9uXG4vLyBiYWQgYXJncywgYSBiYXJlIGludm9jYXRpb24sIE9SIGEgcmVqZWN0ZWQgY29tbWFuZCAoZGVkdXBlIC8gdW5rbm93biBpZCk7XG4vLyAwIG9uIHN1Y2Nlc3M7IDEgb24gaW50ZXJuYWwgZmF1bHRzIChkYWVtb24gZmFpbGVkIHRvIHN0YXJ0KTsgYSB0YWlsIGV4aXRzIDBcbi8vIG9uIHRoZSBkYWVtb24ncyBgY2xvc2VkYCBmcmFtZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuaW1wb3J0IHsgZGllLCByZXBvcnRDbGlFcnJvciwgc2V0Q3VycmVudENvbW1hbmQgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQgeyB0YWlsRXZlbnRzIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxFdmVudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFwiLi5cIiwgXCJzY3JpcHRzXCIg4oCUIE5PVCBhIHNpYmxpbmcgbG9va3VwLiBUaGlzIGZpbGUgaXMgQVVUSE9SRUQgaGVyZSBhbmRcbi8vIEVYRUNVVEVTIGFzIGAuLi9kaXN0L2NsaS5qc2AgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIGFuZFxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlXG4vLyBwYXRoIGluIHRoaXMgZmlsZSAoU0tJTExfUk9PVCwgRElTVF9ESVIsIFNVUkZBQ0VfQ1dELCBwbHVnaW4uanNvbikgaXNcbi8vIHVuY2hhbmdlZCBieSB0aGUgbW92ZS4gQSBTSUJMSU5HLXJlbGF0aXZlIG9uZSBpcyBub3Q6IGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgcmVzb2x2ZWQgdG8gYGRpc3Qvc2VydmVyLnRzYCBhbmQgdGhlIGRhZW1vbiB3b3VsZCBuZXZlclxuLy8gc3Bhd24uIEdvaW5nIHVwIGFuZCBiYWNrIGRvd24gaXMgY29ycmVjdCBmcm9tIEJPVEggbG9jYXRpb25zLlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIGRldjogdGhlIGRhZW1vbiBzZXJ2ZXMgYSBCdW4tYnVuZGxlZCBSZWFjdCBzdXJmYWNlLCBhbmQgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvYXN0cm9sYWJlLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IChtZWFzdXJlZCBvbiBnbGFtb3VyOiB0aGUgcGFnZSA1MDBzXG4vLyB3aXRoIG5vIHN0eWxlc2hlZXQgbGluazsgYXN0cm9sYWJlJ3Mgb3duIGZhaWx1cmUgc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzXG4vLyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZVxuLy8gYW55d2F5IHdvdWxkIGJyZWFrIHRoZSBzcGF3bi5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJhc3Ryb2xhYmVcIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgQVNUUk9MQUJFX0hPTUUgPSBwcm9jZXNzLmVudi5BU1RST0xBQkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuYXN0cm9sYWJlXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcblxuLy8g4pSA4pSAIHRoZSB0YWlsIHdhdGNoZG9nLCBERVJJVkVEIEZST00gVEhFIERBRU1PTidTIE9XTiBIRUFSVEJFQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8g4puUIEEgQ09OU1RBTlQgSEVSRSBXT1VMRCBCRSBBIENPTlNUQU5UIERFQ09VUExFRCBGUk9NIFRIRSBUSElORyBJVCBXQVRDSEVTLlxuLy8gVGhlIHdhdGNoZG9nIGFib3J0cyBhIGNvbm5lY3Rpb24gdGhhdCBoYXMgc2FpZCBub3RoaW5nIGZvciBgVEFJTF9JRExFX01TYDtcbi8vIHRoZSBvbmx5IHRoaW5nIGtlZXBpbmcgYSBxdWlldCBjb25uZWN0aW9uIGFsaXZlIGlzIHRoZSBkYWVtb24ncyBgOiBoYmBcbi8vIGNvbW1lbnQuIFNvIHRoZSB0d28gbnVtYmVycyBhcmUgT05FIGludmFyaWFudCDigJQgd2F0Y2hkb2cgPiBoZWFydGJlYXQsIHdpdGhcbi8vIHJvb20gZm9yIG1pc3NlZCBiZWF0cy5cbi8vXG4vLyDim5QgSVQgVVNFRCBUTyBCRSBNSVJST1JFRCBIRVJFIEJZIEhBTkQuIFR3byBleHByZXNzaW9ucyBjb3BpZWQgb3V0IG9mIHRoZVxuLy8gZGFlbW9uIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJhbiBlZGl0IHRoZXJlIGlzIGFuIGVkaXQgaGVyZVwiLCBiZWNhdXNlIHRoZVxuLy8gQ0xJIGNvdWxkIG5vdCBpbXBvcnQgdGhlIGRhZW1vbiB3aXRob3V0IGRyYWdnaW5nIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50b1xuLy8gYGRpc3QvY2xpLmpzYC4gUGhhc2UgMWIncyBzaGFyZWQgc3BpbmUgaXMgdGhhdCBpbXBvcnQ6IGAuL2hlYXJ0YmVhdC50c2AgaXMgYVxuLy8gbGVhZi1zaGFwZWQgbW9kdWxlIHdpdGggbm8gZGFlbW9uIGluIGl0LCBib3RoIGhhbHZlcyBpbXBvcnQgaXQsIGFuZCB0aGVcbi8vIG1pcnJvciBpcyBnb25lIHJhdGhlciB0aGFuIGFubm90YXRlZC5cblxuLy8gRmFpbHVyZXMgbGVhdmUgc3Rkb3V0IGVtcHR5IGFuZCBwdXQgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIOKAlCB0aGUgc2FtZVxuLy8gbWFjaGluZSBzaGFwZSBhcyB0aGUgZGF0YSBwYXRoLCBzbyBhIHBpcGVkIGNhbGxlciBwYXJzZXMgdGhlIGVycm9yIGluc3RlYWQgb2Zcbi8vIHNjcmFwaW5nIHByb3NlLiBUSEUgRU5WRUxPUEUsIFRIRSBUQVhPTk9NWSBBTkQgVEhFIEVYSVQgQ09ERVMgQVJFIE5PVyBTSEFSRURcbi8vIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApOyBhc3Ryb2xhYmUncyBmb3VydGgsIG1pbmltYWwgY29weSBpcyBnb25lLiBUd29cbi8vIHRoaW5ncyBjaGFuZ2VkIGFuZCBib3RoIGFyZSBhZGRpdGl2ZTogdGhlIGVudmVsb3BlIGdhaW5zIGBleGl0X2NvZGVgLFxuLy8gYHJldHJ5YWJsZWAgYW5kIGBtZXRhLmNvbW1hbmRgLCBhbmQgYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3IgdGhhdCBgbWFpbmBcbi8vIHJlcG9ydHMsIHJhdGhlciB0aGFuIGV4aXRpbmcgZnJvbSB3aGVyZXZlciBpdCB3YXMgY2FsbGVkLiBga2luZGAgYW5kXG4vLyBgbWVzc2FnZWAg4oCUIHRoZSB0d28gZmllbGRzIGFueXRoaW5nIGNhbiBiZSBrZXlpbmcgb24g4oCUIGFyZSB1bnRvdWNoZWQuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKSA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG4vLyBpZCArIGF2YXRhciBhcmUgREVSSVZFRCBieSB0aGUgZGFlbW9uIChzdGF0ZS50cykgZnJvbSB0aGUgcHJvamVjdCBuYW1lLCBzbyB0aGVcbi8vIGNsaSBwYXNzZXMgaWQvYXZhdGFyIHRocm91Z2ggb25seSB3aGVuIHRoZSBjYWxsZXIgZ2F2ZSB0aGVtIGV4cGxpY2l0bHkg4oCUIG9uZVxuLy8gc291cmNlIG9mIHRydXRoLCBubyBzbHVnL2F2YXRhciBtaXJyb3IgdG8gZHJpZnQuXG5cbmZ1bmN0aW9uIHJlc29sdmVBcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB2ID0gZmxhZ3MuYXMgPz8gZmxhZ3MuZnJvbTtcbiAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpKSByZXR1cm4gdi50cmltKCk7XG4gIGNvbnN0IGVudiA9IHByb2Nlc3MuZW52LkFTVFJPTEFCRV9BUztcbiAgcmV0dXJuIGVudj8udHJpbSgpID8gZW52LnRyaW0oKSA6IHVuZGVmaW5lZDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW107XG4gIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgQnVuLnN0ZGluLnN0cmVhbSgpKSBjaHVua3MucHVzaChjaHVuayk7XG4gIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKTtcbn1cblxuLy8g4pSA4pSAIGRhZW1vbiBkaXNjb3ZlcnkgKyBIVFRQIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiByZWFkUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gTnVtYmVyLnBhcnNlSW50KChhd2FpdCBCdW4uZmlsZShQT1JUX0ZJTEUpLnRleHQoKSkudHJpbSgpLCAxMCk7XG4gICAgcmV0dXJuIHAgPiAwID8gcCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGlzVXAocG9ydDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIChhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3N0YXRlYCkpLm9rO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgcnVubmluZyBkYWVtb24sIG9yIGF1dG8tc3Bhd24gb25lIChkZXRhY2hlZCBzbyBpdCBvdXRsaXZlcyB0aGlzIENMSSDigJRcbi8vIG5vZGU6Y2hpbGRfcHJvY2Vzcywgbm90IEJ1bi5zcGF3biwgd2hpY2ggY2FuJ3QgZGV0YWNoIGEgc3Vydml2aW5nIGRhZW1vbikuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24oKTogUHJvbWlzZTx7IGJhc2U6IHN0cmluZzsgcG9ydDogbnVtYmVyIH0+IHtcbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkUG9ydCgpO1xuICBpZiAoZXhpc3RpbmcgJiYgKGF3YWl0IGlzVXAoZXhpc3RpbmcpKSkge1xuICAgIHJldHVybiB7IGJhc2U6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZXhpc3Rpbmd9YCwgcG9ydDogZXhpc3RpbmcgfTtcbiAgfVxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCJdLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQSB3cm9uZyBjd2Qgc2tpcHMgYnVuZmlnLnRvbWwncyBUYWlsd2luZFxuICAgIC8vIHBsdWdpbjsgb24gZ2xhbW91ciB0aGF0IGZhaWxzIHRoZSBwYWdlIG91dHJpZ2h0ICg1MDApLiBBc3NlcnQgdGhlIGludmFyaWFudCxcbiAgICAvLyBub3QgdGhlIHN0YXR1czogdGhlIHV0aWxpdHkgbmV2ZXIgcmVhY2hlcyB0aGUgYnJvd3NlciB3aGVuIGN3ZCBpcyB3cm9uZy5cbiAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBUaGUgZGFlbW9uIEJJTkRTIGZhc3QgYW5kIGFuc3dlcnMgL3N0YXRlIGFzIHNvb24gYXMgaXQncyBsaXN0ZW5pbmcgKHRoZVxuICAvLyBjb2xkIFRhaWx3aW5kK1JlYWN0IGJ1bmRsZSBpcyBsYXp5LCBvbiB0aGUgZmlyc3QgR0VUIFwiL1wiKSwgc28gdGhpcyBoYW5kc2hha2VcbiAgLy8gdXN1YWxseSByZXR1cm5zIHF1aWNrbHkuIFRoZSB3aWRlIGRlYWRsaW5lIGNvdmVycyBhIGNvbGQgbWFjaGluZSB3aGVyZVxuICAvLyBtb2R1bGUgbG9hZCArIGZpcnN0IHNlcnZlIHJ1bnMgc2xvdyAoZ2xhbW91ciB1c2VzIHRoZSBzYW1lIH40NXMgYnVkZ2V0KS5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBzbGVlcCg4MCk7XG4gICAgY29uc3QgcCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gICAgaWYgKHAgJiYgKGF3YWl0IGlzVXAocCkpKSByZXR1cm4geyBiYXNlOiBgaHR0cDovLzEyNy4wLjAuMToke3B9YCwgcG9ydDogcCB9O1xuICB9XG4gIGRpZShcImFzdHJvbGFiZSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiA0NXNcIiwgXCJpbnRlcm5hbFwiKTtcbn1cblxuLy8gQSByZWFkLW9ubHkgdmVyYiByZXF1aXJlcyBhIGxpdmUgZGFlbW9uIGJ1dCBtdXN0IG5vdCBzcGF3biBvbmUgKG5vdGhpbmcgdG9cbi8vIG9ic2VydmUgeWV0KSDigJQgc28gYHN0YXRlYC9gbGlzdGAvYGluZm9gIG9uIGEgY29sZCBtYWNoaW5lIHJlcG9ydCBjbGVhbmx5LlxuYXN5bmMgZnVuY3Rpb24gcnVubmluZ0Jhc2UoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHAgPSBhd2FpdCByZWFkUG9ydCgpO1xuICByZXR1cm4gcCA/IGBodHRwOi8vMTI3LjAuMC4xOiR7cH1gIDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChiYXNlOiBzdHJpbmcsIGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L2NtZGAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgfSk7XG4gIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyBvazogYm9vbGVhbjsgYXBwbGllZDogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmc7IG91dGNvbWU/OiBzdHJpbmcgfTtcbn1cblxuLy8gQXBwbHkgYSAvY21kLCBzdXJmYWNlIGEgcmVqZWN0aW9uIG9uIHN0ZGVyciArIG5vbi16ZXJvIGV4aXQgKGV4aXQtY29kZVxuLy8gY29udHJhY3QpLCBhbmQgZWNobyB0aGUgc3RydWN0dXJlZCByZXN1bHQgb24gc3Rkb3V0IG9uIHN1Y2Nlc3MuXG5hc3luYyBmdW5jdGlvbiBjbWQoYmFzZTogc3RyaW5nLCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCByID0gYXdhaXQgcG9zdENtZChiYXNlLCBib2R5KTtcbiAgLy8gYjIvIzg1IOKAlCBESVNUSU5HVUlTSCBUSEUgVFdPIEtJTkRTIE9GIGFwcGxpZWQ6ZmFsc2UuIFdJVEggYW4gZXJyb3IgPSBhIHJlYWxcbiAgLy8gcmVqZWN0aW9uICh1bmtub3duIHByb2plY3QsIGR1cGxpY2F0ZSkgLT4gdmlzaWJsZSwgbm9uLXplcm8sIHVuY2hhbmdlZC5cbiAgLy8gV0lUSE9VVCBhbiBlcnJvciA9IGEgYmVuaWduIG5vLW9wOiB0aGUgc3RhdGUgd2FzIGFscmVhZHkgd2hhdCB3YXMgYXNrZWQgZm9yLFxuICAvLyB0aGUgcHJvamVjdCBleGlzdHMsIHRoZSBkYWVtb24gaXMgcmlnaHQsIGFuZCBub3RoaW5nIGlzIHdyb25nLiBUaGF0IHVzZWQgdG9cbiAgLy8gZXhpdCAyIHdpdGggXCJjb21tYW5kICdhdHRlbnRpb24nIHdhcyBub3QgYXBwbGllZFwiLCBzbyByZS1pc3N1aW5nIGFuXG4gIC8vIGFscmVhZHktYXBwbGllZCBjb21tYW5kIHdhcyBhIGhhcmQgZmFpbHVyZSDigJQgd2hpbGUgYm91bnR5IHRyZWF0cyB0aGVcbiAgLy8gaWRlbnRpY2FsIHBheWxvYWQgYXMgb3JkaW5hcnkgc3VjY2Vzcy5cbiAgLy9cbiAgLy8gVGhpcyBpcyBib3VudHkncyBkaXNjaXBsaW5lIChjbGkudHMgYHRhc2sudXBkYXRlYCksIHBvcnRlZCByYXRoZXIgdGhhblxuICAvLyByZS1kZXJpdmVkLiBJdCByZXBvcnRzIHRoZSBkYWVtb24ncyBgb3V0Y29tZWAgbm91biBpbnN0ZWFkIG9mIGJvdW50eSdzXG4gIC8vIGBub29wOiB0cnVlYCBib29sZWFuLCBwZXIgdGhlIG91dGNvbWUgY29udHJhY3QncyBcImVudW1lcmF0ZWQsIG5ldmVyIGFcbiAgLy8gYm9vbGVhblwiIOKAlCB0aGUgbm91biBzYXlzIFdISUNIIHN0YXRlIG1hZGUgdGhlIHdvcmsgdW5uZWNlc3NhcnkuXG4gIGlmICghci5hcHBsaWVkICYmIHIuZXJyb3IpIGRpZShyLmVycm9yKTtcbiAgcHJpbnRKc29uKHIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBzcGF3bihvcGVuZXIsIFt1cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIFNTRSByZWFkZXI6IHN0cmVhbSB0aGUgZXZlbnQgbG9nIGFzIEpTT05MIG9uIHN0ZG91dCwgcmVzdW1hYmxlICsgcmVjb25uZWN0aW5nXG4vLyDigJQgb25lIGNhbGwgaW50byB0aGUgaG91c2UncyBzaGFyZWQgdGFpbCBjbGllbnQgKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLFxuLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGxvb3AsIHRoZSBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmRcbi8vIHRoZSBkcmFpbmVkIGV4aXQgbm93IGxpdmUsIE9OQ0UsIGZvciBldmVyeSBzcGVsbC5cbi8vXG4vLyBgc2NvcGVJZGAgKHNldCBieSBgam9pbmApIGZpbHRlcnMgdG8gdGhpcyBwcm9qZWN0J3MgZnJhbWVzICsgbGlmZWN5Y2xlOyBhblxuLy8gdW5zY29wZWQgdGFpbCBwYXNzZXMgZXZlcnl0aGluZy4gU2VsZi1lY2hvIChmcmFtZXMgdGhlIGNhbGxlcidzIG93biAtLWFzXG4vLyBjYXVzZWQpIGlzIHN1cHByZXNzZWQuIGA6YCBrZWVwYWxpdmVzIHJpZGUgc3RkZXJyOyByZXR1cm5zIDAgb24gYGNsb3NlZGAuXG4vL1xuLy8g4puUIGByZXNvbHZlYCBJUyBgcnVubmluZ0Jhc2VgLCBSRS1SRUFEIE9OIEVWRVJZIEFUVEVNUFQg4oCUIHRoaXMgaXMgdGhlIEIxIGZpeFxuLy8gYW5kIHRoZSByZWFzb24gYXN0cm9sYWJlIHdlbnQgZmlyc3QuIGFzdHJvbGFiZSBiaW5kcyBhbiBFUEhFTUVSQUwgcG9ydCwgYW5kXG4vLyB0aGlzIGZ1bmN0aW9uIHVzZWQgdG8gdGFrZSBhIGNhcHR1cmVkIGBiYXNlOiBzdHJpbmdgLCBzbyBhZnRlciBhbnkgZGFlbW9uXG4vLyByZXN0YXJ0IGBqb2luYCByZWNvbm5lY3RlZCB0byBhIGRlYWQgcG9ydCBmb3JldmVyIGFuZCBzdHJlYW1lZCBub3RoaW5nIHdoaWxlXG4vLyBsb29raW5nIHBlcmZlY3RseSBhbGl2ZS4gSXQgY2Fubm90OiB0aGUgY2FsbGJhY2sgcmUtcmVhZHNcbi8vIGAkQVNUUk9MQUJFX0hPTUUvZGFlbW9uLnBvcnRgIGJlZm9yZSBldmVyeSBjb25uZWN0LiBEcml2ZW4gaW4gYGNsaS50ZXN0LnRzYC5cbi8vXG4vLyBJdCBkZWxpYmVyYXRlbHkgZG9lcyBOT1Qgc3Bhd24uIGBqb2luYC9gdGFpbGAgc3RpbGwgY2FsbCBgZW5zdXJlRGFlbW9uKClgXG4vLyBvbmNlIHVwIGZyb250IChhIHRhaWwgd2l0aCBubyBkYWVtb24gYXQgYWxsIGlzIHdvcnRoIHJlcG9ydGluZyk7IGEgZGFlbW9uXG4vLyB0aGF0IGRpZXMgTUlELXdhdGNoIGlzIGEgd2FpdCwgbm90IGEgcmVzcGF3biwgYmVjYXVzZSBhIHNlY29uZCBhc3Ryb2xhYmVcbi8vIHNwYXduZWQgZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBpcyBhIHdvcnNlIG91dGNvbWUgdGhhbiBhIHdhdGNoIHRoYXRcbi8vIHJlc3VtZXMgd2hlbiB0aGUgaHVtYW4gcmVvcGVucyB0aGUgYm9hcmQuXG5hc3luYyBmdW5jdGlvbiBzdHJlYW1FdmVudHMob3B0czoge1xuICBzaW5jZTogbnVtYmVyO1xuICBwcm9qZWN0Pzogc3RyaW5nO1xuICBzY29wZUlkPzogc3RyaW5nO1xuICBzZWxmPzogc3RyaW5nO1xufSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHR5cGUgRXYgPSB7IGlkPzogbnVtYmVyOyBlcG9jaD86IHN0cmluZzsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmc7IHByb2plY3RJZD86IHN0cmluZyB9O1xuXG4gIGNvbnN0IGluU2NvcGUgPSAoZXY6IEV2KSA9PiB7XG4gICAgaWYgKCFvcHRzLnNjb3BlSWQpIHJldHVybiB0cnVlO1xuICAgIGlmIChldi50eXBlID09PSBcInJlYWR5XCIgfHwgZXYudHlwZSA9PT0gXCJjbG9zZWRcIikgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIGV2LnByb2plY3RJZCA9PT0gb3B0cy5zY29wZUlkO1xuICB9O1xuXG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgcmVzb2x2ZTogcnVubmluZ0Jhc2UsXG4gICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgc2luY2U6IG9wdHMuc2luY2UsXG4gICAgY3Vyc29yT2Y6IChldikgPT4gZXYuaWQsXG4gICAgcXVlcnk6IChjdXJzb3IpID0+ICh7XG4gICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICAuLi4ob3B0cy5wcm9qZWN0ID8geyBwcm9qZWN0OiBvcHRzLnByb2plY3QgfSA6IHt9KSxcbiAgICB9KSxcbiAgICBhY2NlcHQ6IChldikgPT4gaW5TY29wZShldikgJiYgIShvcHRzLnNlbGYgIT09IHVuZGVmaW5lZCAmJiBldi5ieSA9PT0gb3B0cy5zZWxmKSxcbiAgICB0ZXJtaW5hbDogKGV2KSA9PiBldi50eXBlID09PSBcImNsb3NlZFwiLFxuICAgIC8vIOKblCBUSEUgUkVTVEFSVCBHQVAuIEFzdHJvbGFiZSBpcyBhIHNpbmdsZXRvbiB0aGF0IGBjbGkudHNgIHJlc3Bhd25zLCBhbmRcbiAgICAvLyBpdHMgZXZlbnQgaWRzIHJlc3RhcnQgYXQgMSDigJQgc28gYSBgam9pbmAgdGhhdCBoYXMgYmVlbiBydW5uaW5nIGZvciBob3Vyc1xuICAgIC8vIHJlc3VtZXMgYXQgYHNpbmNlPTxhIGxhcmdlIG51bWJlcj5gIGFnYWluc3QgYSBkYWVtb24gd2hvc2Ugd2hvbGUgbG9nIGlzXG4gICAgLy8gc21hbGxlciB0aGFuIHRoYXQuIFRoZSBkYWVtb24gaGFsZiAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCkgcmVwbGF5cyB3aG9sZVxuICAgIC8vIHdoZW4gdGhlIGN1cnNvciBpcyBiZXlvbmQgaXRzIG93bjsgdGhpcyBoYWxmIGlzIHdoYXQgc3RvcHMgdGhlIHRhaWwgdGhlblxuICAgIC8vIHJlLXJlcXVlc3RpbmcgdGhlIHN0YWxlIGN1cnNvciBvbiBldmVyeSBzdWJzZXF1ZW50IHJlY29ubmVjdC4gVGhlIGxpbmUgaXNcbiAgICAvLyBTWU5USEVTSVpFRCDigJQgaXQgaXMgbm90IGEgYnVzIGV2ZW50LCBjYXJyaWVzIG5vIGBpZGAsIGFuZCBuZXZlciBhZHZhbmNlc1xuICAgIC8vIHRoZSBjdXJzb3Ig4oCUIHdoaWNoIGlzIHRoZSBzYW1lIHNlcGFyYXRpb24gbWluZC1tYXBwZXIncyBgZXBvY2guY2hhbmdlZGBcbiAgICAvLyBtYWtlcyBhbmQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvdGFpbC50ZXN0LnRzYCBwaW5zLlxuICAgIGVwb2NoT2Y6IChldikgPT4gZXYuZXBvY2gsXG4gICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICBvbkNvbW1lbnQ6ICgpID0+IFwiOiBhc3Ryb2xhYmUta2VlcGFsaXZlXCIsXG4gIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHsgcG9ydCB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGlmICghZmxhZ3NbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3NlcihgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IG5hbWUgPSBwb3Muam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dXCIpO1xuICBjb25zdCBwYXRoID0gdHlwZW9mIGZsYWdzLnBhdGggPT09IFwic3RyaW5nXCIgPyBmbGFncy5wYXRoLnRyaW0oKSA6IFwiXCI7XG4gIGlmICghcGF0aCkgZGllKFwiYWRkIHJlcXVpcmVzIC0tcGF0aCA8cD5cIik7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gZmxhZ3Muc3RkaW5cbiAgICA/IGF3YWl0IHJlYWRTdGRpbigpXG4gICAgOiB0eXBlb2YgZmxhZ3MuZGVzY3JpcHRpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MuZGVzY3JpcHRpb25cbiAgICAgIDogdW5kZWZpbmVkO1xuICAvLyBpZCArIGF2YXRhciBhcmUgb3B0aW9uYWwg4oCUIHRoZSBkYWVtb24gZGVyaXZlcyBib3RoIGZyb20gdGhlIG5hbWUgd2hlbiBvbWl0dGVkLlxuICBjb25zdCBhdmF0YXIgPSB0eXBlb2YgZmxhZ3MuYXZhdGFyID09PSBcInN0cmluZ1wiID8gZmxhZ3MuYXZhdGFyIDogdW5kZWZpbmVkO1xuICBjb25zdCBpZCA9IHR5cGVvZiBmbGFncy5pZCA9PT0gXCJzdHJpbmdcIiAmJiBmbGFncy5pZC50cmltKCkgPyBmbGFncy5pZC50cmltKCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7XG4gICAgdHlwZTogXCJwcm9qZWN0LmFkZFwiLFxuICAgIHByb2plY3Q6IHsgaWQsIG5hbWUsIHBhdGgsIGRlc2NyaXB0aW9uLCBhdmF0YXIgfSxcbiAgICBhczogcmVzb2x2ZUFzKGZsYWdzKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlbW92ZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiByZW1vdmUgPGlkPlwiKTtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJwcm9qZWN0LnJlbW92ZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXR1cyhwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBzdGF0dXMgPGlkPiA8c3VtbWFyeS4uLj4gWy0tcGhhc2UgLi5dIFstLXN0ZGluXVwiKTtcbiAgY29uc3Qgc3VtbWFyeSA9IGZsYWdzLnN0ZGluID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIXN1bW1hcnkpIGRpZShcInN0YXR1cyByZXF1aXJlcyBhIHN1bW1hcnkgKHBvc2l0aW9uYWwgb3IgLS1zdGRpbilcIik7XG4gIGNvbnN0IHBoYXNlID0gdHlwZW9mIGZsYWdzLnBoYXNlID09PSBcInN0cmluZ1wiID8gZmxhZ3MucGhhc2UgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwic3RhdHVzXCIsIGlkLCBzdW1tYXJ5LCBwaGFzZSwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEF0dGVudGlvbihwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBhdHRlbnRpb24gPGlkPiBbLS1jbGVhcl0gWy0tcXVlc3Rpb24gLi4uXVwiKTtcbiAgY29uc3QgcmFpc2VkID0gZmxhZ3MuY2xlYXIgIT09IHRydWU7XG4gIGNvbnN0IHF1ZXN0aW9uID1cbiAgICB0eXBlb2YgZmxhZ3MucXVlc3Rpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MucXVlc3Rpb25cbiAgICAgIDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwiYXR0ZW50aW9uXCIsIGlkLCByYWlzZWQsIHF1ZXN0aW9uLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUG9rZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBwb2tlIDxpZD5cIik7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwicG9rZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKCkge1xuICBjb25zdCBiYXNlID0gYXdhaXQgcnVubmluZ0Jhc2UoKTtcbiAgaWYgKCFiYXNlIHx8ICEoYXdhaXQgaXNVcChOdW1iZXIucGFyc2VJbnQoYmFzZS5zcGxpdChcIjpcIikucG9wKCkgYXMgc3RyaW5nLCAxMCkpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSwgc3RhdGU6IHsgdGl0bGU6IFwiT2JzZXJ2YXRvcnlcIiwgcHJvamVjdHM6IFtdIH0gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L3N0YXRlYCk7XG4gIGlmICghcmVzLm9rKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWApO1xuICBwcmludEpzb24oYXdhaXQgcmVzLmpzb24oKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IGJhc2UgPSBhd2FpdCBydW5uaW5nQmFzZSgpO1xuICAvLyBHdWFyZCB3aXRoIGlzVXAoKSBiZWZvcmUgZmV0Y2hpbmcgKG1pcnJvcnMgY21kU3RhdGUpOiBhIFNUQUxFIGRhZW1vbi5wb3J0XG4gIC8vIGZyb20gYSBjcmFzaGVkIGRhZW1vbiB3b3VsZCBvdGhlcndpc2UgdGhyb3cgRUNPTk5SRUZVU0VEIGhlcmUgaW5zdGVhZCBvZiB0aGVcbiAgLy8gY2xlYW4gcnVubmluZzpmYWxzZSBwYXRoLlxuICBpZiAoIWJhc2UgfHwgIShhd2FpdCBpc1VwKE51bWJlci5wYXJzZUludChiYXNlLnNwbGl0KFwiOlwiKS5wb3AoKSBhcyBzdHJpbmcsIDEwKSkpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IGZhbHNlLCBwcm9qZWN0czogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdGUgfSA9IChhd2FpdCAoYXdhaXQgZmV0Y2goYCR7YmFzZX0vc3RhdGVgKSkuanNvbigpKSBhcyB7XG4gICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9O1xuICB9O1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHJ1bm5pbmc6IHRydWUsXG4gICAgcHJvamVjdHM6IHN0YXRlLnByb2plY3RzLm1hcCgocCkgPT4gKHtcbiAgICAgIGlkOiBwLmlkLFxuICAgICAgbmFtZTogcC5uYW1lLFxuICAgICAgem9uZTogcC56b25lLFxuICAgICAgY29ubmVjdGVkOiBwLmNvbm5lY3RlZCxcbiAgICB9KSksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgYmFzZSA9IGF3YWl0IHJ1bm5pbmdCYXNlKCk7XG4gIGlmICghYmFzZSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IFwibm8gZGFlbW9uIHJ1bm5pbmdcIiB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoYmFzZSwgeyB0eXBlOiBcImNsb3NlXCIsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5mbygpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gIGlmIChwb3J0ICYmIChhd2FpdCBpc1VwKHBvcnQpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xuICB9IGVsc2Uge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSB9KTtcbiAgfVxufVxuXG5jb25zdCBIRUxQID0gYGFzdHJvbGFiZSDigJQgYSBzdGFuZGluZyBvYnNlcnZhdG9yeSBib2FyZCBmb3IgcHJvamVjdHMgaW4gZmxpZ2h0LlxuXG4gIG9wZW4gWy0tbm8tb3Blbl1cbiAgICAgIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHVwICsgb3BlbiB0aGUgYm9hcmQgaW4gdGhlIGJyb3dzZXJcbiAgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlZ2lzdGVyIGEgcHJvamVjdCAoZGVkdXBlLWd1YXJkZWQ7IGlkICsgYXZhdGFyIGRlcml2ZWQgZnJvbSB0aGUgbmFtZSB3aGVuIG9taXR0ZWQpLlxuICAgICAgdGhlIHJlc3BvbnNlIGVjaG9lcyB0aGUgZGVyaXZlZCBpZCDigJQgeW91IG5lZWQgaXQgZm9yIGpvaW4vc3RhdHVzL2F0dGVudGlvbi9yZW1vdmUuXG4gIHJlbW92ZSA8aWQ+XG4gICAgICB1bnJlZ2lzdGVyIGEgcHJvamVjdFxuICBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXVxuICAgICAgYWN0aXZhdGUgdGhlIGNhcmQgKyBsaXN0ZW4gZm9yIHBva2VzIChzY29wZWQgdGFpbDsgd3JhcCB3aXRoIE1vbml0b3IpLiBlbmQgaXQgdG8gaWRsZSB0aGUgY2FyZC5cbiAgc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlcGxhY2UgYSBwcm9qZWN0J3MgY3VycmVudCBzdGF0dXNcbiAgYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl1cbiAgICAgIHJhaXNlIC8gY2xlYXIgdGhlIG5lZWRzLXlvdSBnYXRlICgtLXF1ZXN0aW9uIGF0dGFjaGVzIHRoZSBwcm9tcHQpXG4gIHBva2UgPGlkPlxuICAgICAgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbiAgc3RhdGVcbiAgICAgIHJlYWQtYmFjazogcHJvamVjdCBjYXJkcyAoZWFjaCBjYXJyaWVzIGEgZGVyaXZlZCB6b25lOiBhdHRlbnRpb24gfCBhY3RpdmUgfCBxdWlldClcbiAgdGFpbCBbLS1zaW5jZSBOXSBbLS1hcyA8bmFtZT5dXG4gICAgICB1bnNjb3BlZCBldmVudCB0YWlsIGFzIEpTT05MIChubyBwcmVzZW5jZSlcbiAgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHAgfCAtLXZlcnNpb25cblxuICBJZGVudGl0eTogLS1hcyAvIC0tZnJvbSAob3IgJEFTVFJPTEFCRV9BUykgc3RhbXBzIHRoZSBhY3RvciArIHN1cHByZXNzZXMgc2VsZi1lY2hvLlxuICAtLXN0ZGluIHJlYWRzIGEgZGVzY3JpcHRpb24vc3VtbWFyeSBmcm9tIHN0ZGluIChzaGVsbC1xdW90aW5nLXNhZmUpLlxuICBPdXRwdXQ6IGV2ZXJ5IGNvbW1hbmQgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBsaW5lIHBlciBhbnN3ZXI7XG4gIGZhaWx1cmVzIHB1dCBvbmUgSlNPTiBlcnJvciBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG4gIFRoZXJlIGlzIG5vIHByb3NlIG1vZGUgdG8gc3dpdGNoIG91dCBvZi5gO1xuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlIGRlZ3JhZGVzIHRvIFwidW5rbm93blwiLlxuYXN5bmMgZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogUHJvbWlzZTx7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwa2cgPSBhd2FpdCBCdW4uZmlsZShqb2luKFNDUklQVF9ESVIsIFwiLi4vLi4vLi4vLmNsYXVkZS1wbHVnaW4vcGx1Z2luLmpzb25cIikpLmpzb24oKTtcbiAgICBpZiAodHlwZW9mIHBrZz8udmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJhc3Ryb2xhYmVcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBuYW1lOiBcImFzdHJvbGFiZVwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vKipcbiAqIFRoZSBmYWlsdXJlIGZ1bm5lbC4gYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3Igbm93ICh0aGUgaG91c2UncyBvbmUgZXJyb3JcbiAqIGNvbnRyYWN0LCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIGluc3RlYWQgb2YgZXhpdGluZyBmcm9tIHdoZXJldmVyIGl0IHdhc1xuICogY2FsbGVkLCBzbyB0aGlzIGlzIHRoZSBPTkUgcGxhY2UgYSBmYWlsdXJlIGJlY29tZXMgYW4gZXhpdCBjb2RlIOKAlCBhbmQgdGhlXG4gKiBwcm9jZXNzIHN0aWxsIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucywgYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYVxuICogbmF0dXJhbCByZXR1cm4sIHdoaWNoIGlzIHdoYXQgZHJhaW5zIHN0ZG91dCBvbiBhIHBpcGUuXG4gKlxuICog4puUIEEgTk9OLUNsaUVycm9yIElTIFJFVEhST1dOLCBORVZFUiBFTlZFTE9QRUQuIFJlcG9ydGluZyBhbiB1bmtub3duIHRocm93IGFzXG4gKiBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSB3b3VsZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlID09PSBudWxsKSB0aHJvdyBlO1xuICAgIHJldHVybiBjb2RlO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdmVyYiA9IGFyZ3ZbMF07XG4gIHNldEN1cnJlbnRDb21tYW5kKHZlcmIgPz8gbnVsbCk7XG4gIC8vIEEgYmFyZSBpbnZvY2F0aW9uIHJlcXVlc3RlZCBub3RoaW5nIOKAlCB0aGF0IGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHBcbiAgLy8gcmVxdWVzdC4gaGVscCBzdGF5cyByZWFjaGFibGUgYnkgbmFtZSAoYW5kIC0taGVscC8taCkgb24gc3Rkb3V0IGF0IGV4aXQgMC5cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkgZGllKFwibm8gdmVyYiBnaXZlbiDigJQgdHJ5ICdoZWxwJ1wiKTtcbiAgaWYgKHZlcmIgPT09IFwiaGVscFwiIHx8IHZlcmIgPT09IFwiLS1oZWxwXCIgfHwgdmVyYiA9PT0gXCItaFwiKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICAvLyBSb290IHRva2VuLCBkZWxpYmVyYXRlbHkgTk9UIGEgZmxhZzogZGlzcGF0Y2hlZCBhbG9uZ3NpZGUgaGVscCBpbiB0aGUgdmVyYlxuICAvLyBzd2l0Y2gsIHNvIG5vIHBlci12ZXJiIHBhcnNlciBpcyBleHBlY3RlZCB0byBhY2NlcHQgaXQgYmVsb3cgdGhlIHJvb3QuXG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIiB8fCB2ZXJiID09PSBcInZlcnNpb25cIikge1xuICAgIHByaW50SnNvbihhd2FpdCB2ZXJzaW9uSW5mbygpKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LnNsaWNlKDEpLFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBwYXRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgZGVzY3JpcHRpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBhdmF0YXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHBoYXNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcXVlc3Rpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgfSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBkaWUoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgfVxuICBjb25zdCBmbGFncyA9IHBhcnNlZC52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIGNvbnN0IHBvcyA9IHBhcnNlZC5wb3NpdGlvbmFscyBhcyBzdHJpbmdbXTtcbiAgY29uc3Qgc2luY2UgPSB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhZGRcIjpcbiAgICAgIGF3YWl0IGNtZEFkZChwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJyZW1vdmVcIjpcbiAgICAgIGF3YWl0IGNtZFJlbW92ZShwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXR1cyhwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhdHRlbnRpb25cIjpcbiAgICAgIGF3YWl0IGNtZEF0dGVudGlvbihwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJwb2tlXCI6XG4gICAgICBhd2FpdCBjbWRQb2tlKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInN0YXRlXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0ZSgpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImxpc3RcIjpcbiAgICAgIGF3YWl0IGNtZExpc3QoKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgY21kQ2xvc2UoZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGF3YWl0IGNtZEluZm8oKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJqb2luXCI6IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zWzBdO1xuICAgICAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dXCIpO1xuICAgICAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIC8vIENvbmZpcm0gdGhlIHByb2plY3QgZXhpc3RzIGJlZm9yZSBob2xkaW5nIHRoZSB3YXRjaCAoYSB0eXBvJ2QgaWQgd291bGRcbiAgICAgIC8vIG90aGVyd2lzZSBiaW5kIG5vIHByZXNlbmNlIGFuZCBzaWxlbnRseSBzdHJlYW0gbm90aGluZyB1c2VmdWwpLlxuICAgICAgY29uc3QgeyBzdGF0ZSB9ID0gKGF3YWl0IChhd2FpdCBmZXRjaChgJHtiYXNlfS9zdGF0ZWApKS5qc29uKCkpIGFzIHtcbiAgICAgICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgICAgfTtcbiAgICAgIGlmICghc3RhdGUucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gaWQpKVxuICAgICAgICBkaWUoYHVua25vd24gcHJvamVjdCAnJHtpZH0nIOKAlCByZWdpc3RlciBpdCBmaXJzdGApO1xuICAgICAgcmV0dXJuIGF3YWl0IHN0cmVhbUV2ZW50cyh7IHNpbmNlLCBwcm9qZWN0OiBpZCwgc2NvcGVJZDogaWQsIHNlbGY6IHJlc29sdmVBcyhmbGFncykgfSk7XG4gICAgfVxuICAgIGNhc2UgXCJ0YWlsXCI6IHtcbiAgICAgIC8vIGVuc3VyZURhZW1vbiBmb3IgdGhlIFNUQVJUIG9mIHRoZSB3YXRjaCBvbmx5OyB0aGUgdGFpbCByZS1yZXNvbHZlcyB0aGVcbiAgICAgIC8vIGRhZW1vbiBvbiBldmVyeSByZWNvbm5lY3QgKHNlZSBzdHJlYW1FdmVudHMpLCBzbyBgYmFzZWAgaXMgbm90IGNhcnJpZWQuXG4gICAgICBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIHJldHVybiBhd2FpdCBzdHJlYW1FdmVudHMoeyBzaW5jZSwgc2VsZjogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIGRpZShgdW5rbm93biB2ZXJiICcke3ZlcmJ9JyDigJQgdHJ5ICdoZWxwJ2ApO1xuICB9XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG4vLyBFeHBvcnRlZCBzbyB0aGUgc2hpcHBlZCBsYXVuY2hlciAocGx1Z2lucy8uLi4vc2NyaXB0cy9jbGkudHMpIGNhbiBpbnZva2UgdGhlXG4vLyBCVU5ETEVEIGNvcHkgb2YgdGhpcyBtb2R1bGUuIFRoZSBpbXBvcnQubWV0YS5tYWluIGJsb2NrIGFib3ZlIHN0aWxsIHJ1bnMgdGhpc1xuLy8gZmlsZSBkaXJlY3RseSBkdXJpbmcgZGV2ZWxvcG1lbnQ7IHRoZSB0d28gZW50cnkgcm91dGVzIGFyZSBleGNsdXNpdmUsIGJlY2F1c2Vcbi8vIGltcG9ydC5tZXRhLm1haW4gaXMgZmFsc2UgZm9yIGFuIGltcG9ydGVkIG1vZHVsZS5cbmV4cG9ydCB7IG1haW4gfTtcblxuLyoqXG4gKiBUaGUgU0hJUFBFRCBFTlRSWSBQT0lOVCwgY2FsbGVkIGJ5IGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYXN0cm9sYWJlL3NjcmlwdHMvY2xpLnRzYFxuICogYWZ0ZXIgdGhlIGJ1bmRsZSBpcyBpbXBvcnRlZC5cbiAqXG4gKiDim5QgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQuIGFyZ3YgYmVsb25ncyB0byB3aGljaGV2ZXIgZmlsZVxuICogUEFSU0VTIGl0LCBhbmQgdGhhdCBpcyB0aGlzIG9uZS4gQW4gZWFybGllciBsYXVuY2hlciByZWFkXG4gKiBgcHJvY2Vzcy5hcmd2LnNsaWNlKDIpYCBpdHNlbGYgYW5kIHBhc3NlZCBpdCBpbiDigJQgd2hpY2ggbWFkZSB0aGUgbGF1bmNoZXIgbWF0Y2hcbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIFBBUlNFU19BUkdTIHByZWRpY2F0ZSAoYHByb2Nlc3MuYXJndmApLCBzbyB0aGVcbiAqIHJvc3RlciBjb3VudGVkIGEgMy1saW5lIGZvcndhcmRlciBhcyBhbiBhcmctcGFyc2luZyBlbnRyeSBwb2ludCBhbmQgdGhlblxuICogcmVwb3J0ZWQgdGhlIHNwZWxsJ3MgZG9jdW1lbnRlZCBmbGFncyBhcyBVTlJFU09MVkVEIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS4gS2VlcGluZyBhcmd2IG9uIHRoaXMgc2lkZSBtYWtlcyB0aGUgZW51bWVyYXRvcidzIGFuc3dlciB0cnVlXG4gKiBpbnN0ZWFkIG9mIG1ha2luZyBpdHMgcmVnZXggbG9vc2VyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC10YWlsLXJlYWRlci1jb252ZXJnZW5jZS5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW4gMS4zLjE0IGZpbmRpbmcgdGhhdFxuICogYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLiBJdCBpcyBhIERBRU1PTi1zaWRlXG4gKiBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb24gYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueVxuICogY2xpZW50LiBJdCBzdGF5cyB3aGVyZSBpdCB3YXMgbWVhc3VyZWQuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7IGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7IGNvbW1lbnRzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikgcmV0dXJuIGNvZGU7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSByZXR1cm4gY29kZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIFRPIEhBTEYgdGhlIGlkbGUgdGltZW91dC5cbiAqXG4gKiBUaGUgY2xhbXAgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDogdGhlXG4gKiBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXAgb25seSBpblxuICogcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWluKGludE9yKHJhdywgZmFsbGJhY2spLCBNYXRoLm1heCg1MDAsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKSk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIEFzdHJvbGFiZSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgb2YgdGhlIHNwZWxsLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0uIEJlZm9yZSBQaGFzZSAxYiB0aGVzZSB0aHJlZSBleHByZXNzaW9ucyBleGlzdGVkXG4gKiBUV0lDRTogb25jZSBpbiB0aGUgZGFlbW9uLCB3aGljaCB1c2VzIHRoZW0gdG8gY29uZmlndXJlIGBCdW4uc2VydmVgIGFuZCBpdHNcbiAqIFNTRSBoZWFydGJlYXQsIGFuZCBvbmNlIGhhbmQtbWlycm9yZWQgaW4gYGNsaS50c2AsIHdoaWNoIG5lZWRzIHRoZSBzYW1lXG4gKiBudW1iZXJzIHRvIHNpemUgdGhlIHRhaWwgd2F0Y2hkb2cuIEJvdGggY29waWVzIGNhcnJpZWQgYSBjb21tZW50IHNheWluZyBzbyDigJRcbiAqIFwiYW4gZWRpdCB0aGVyZSBpcyBhbiBlZGl0IGhlcmVcIiDigJQgYmVjYXVzZSB0aGUgQ0xJIGNvdWxkIG5vdCBpbXBvcnQgdGhlIGRhZW1vblxuICogd2l0aG91dCBkcmFnZ2luZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC5cbiAqXG4gKiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHMgYnV0IHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaCBncmFwaCwgc28gYm90aFxuICogaGFsdmVzIGltcG9ydCBpdCBhbmQgdGhlIG1pcnJvcmluZyBpcyBnb25lLiBUaGlzIGlzIHRoZSBwaGFzZSdzIGNsZWFuZXN0XG4gKiBwcm9vZiB0aGF0IHRoZSBzZWFtIGlzIHJlYWw6IGEgdmFsdWUgdGhhdCBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyBpdC5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgbWlycm9yaW5nXG4gKiBjb21lcyBiYWNrIHdpdGggaXQuXG4gKi9cblxuaW1wb3J0IHsgaGVhcnRiZWF0TXMsIGlkbGVUaW1lb3V0U2VjLCB0YWlsSWRsZU1zIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogSGVsZCBTU0UgYW5kIFdTIGNvbm5lY3Rpb25zIGRpZSB3aXRob3V0IHRoaXMg4oCUIHNlZSBga2l0L3dpcmUvaGVhcnRiZWF0LnRzYC5cbiAqICBFbnYtdHVuYWJsZSBiZWNhdXNlIHRoZSBkYWVtb24ncyBvd24gdGVzdHMgZHJpdmUgYSBzaG9ydCB3aW5kb3cuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKHByb2Nlc3MuZW52LkFTVFJPTEFCRV9JRExFX1RJTUVPVVQpO1xuXG4vKiogQXN0cm9sYWJlIGJlYXRzIGZhc3RlciB0aGFuIHRoZSBob3VzZSBkZWZhdWx0ICgxMCBzLCBub3QgMTUgcykgYmVjYXVzZVxuICogIGBqb2luYCBjYXJyaWVzIFBSRVNFTkNFOiBhIGNhcmQgaW4gYSBodW1hbidzIHZpZXcgZ29lcyBpZGxlIHdoZW4gdGhlIHRhaWxcbiAqICBkcm9wcywgc28gdGhpcyBzcGVsbCBidXlzIGEgd2lkZXIgbWFyZ2luIGFnYWluc3QgdGhlIGlkbGUgdGltZW91dCB0aGFuIHRoZVxuICogIHNlc3Npb24gc3BlbGxzIG5lZWQuIENsYW1wZWQgdG8gaGFsZiB0aGUgaWRsZSB0aW1lb3V0IGZvciBhbnkgY29uZmlndXJlZFxuICogIHZhbHVlLCB3aGljaCBpcyB0aGUgaW52YXJpYW50IHRoZSBjbGFtcCBleGlzdHMgdG8gaG9sZC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LkFTVFJPTEFCRV9IRUFSVEJFQVRfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIDEwXzAwMCxcbik7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzLCBERVJJVkVEIHJhdGhlciB0aGFuIGNob3Nlbi4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQWtDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2hCTyxTQUFTLFNBQVMsQ0FBQyxNQUFxQjtBQUFBLEVBQzdDLFFBQVEsT0FBTyxNQUFNLEdBQUcsS0FBSyxVQUFVLElBQUk7QUFBQSxDQUFLO0FBQUE7OztBQzZCM0MsSUFBTSxXQUFvQztBQUFBLEVBQy9DLE9BQU87QUFBQSxFQUNQLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLFVBQVU7QUFDWjtBQU9BLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxT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QSxNQUNILE1BQU0sVUFBVSxLQUFLLEtBQUs7QUFBQSxNQUMxQixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxhQUFhLEtBQUssS0FBSztBQUFBLE1BQzdCLE9BQU87QUFBQSxTQUNKO0FBQUEsTUFDSCxNQUFNLFFBQVEsS0FBSyxLQUFLO0FBQUEsTUFDeEIsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sU0FBUztBQUFBLE1BQ2YsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sUUFBUTtBQUFBLE1BQ2QsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sU0FBUyxLQUFLO0FBQUEsTUFDcEIsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sUUFBUTtBQUFBLE1BQ2QsT0FBTztBQUFBLFNBQ0osUUFBUTtBQUFBLE1BQ1gsTUFBTSxLQUFLLElBQUk7QUFBQSxNQUNmLElBQUksQ0FBQztBQUFBLFFBQUksSUFBSSw0Q0FBNEM7QUFBQSxNQUN6RCxRQUFRLFNBQVMsTUFBTSxhQUFhO0FBQUEsTUFHcEMsUUFBUSxVQUFXLE9BQU8sTUFBTSxNQUFNLEdBQUcsWUFBWSxHQUFHLEtBQUs7QUFBQSxNQUc3RCxJQUFJLENBQUMsTUFBTSxTQUFTLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQUEsUUFDekMsSUFBSSxvQkFBb0IsOEJBQXdCO0FBQUEsTUFDbEQsT0FBTyxNQUFNLGFBQWEsRUFBRSxPQUFPLFNBQVMsSUFBSSxTQUFTLElBQUksTUFBTSxVQUFVLEtBQUssRUFBRSxDQUFDO0FBQUEsSUFDdkY7QUFBQSxTQUNLLFFBQVE7QUFBQSxNQUdYLE1BQU0sYUFBYTtBQUFBLE1BQ25CLE9BQU8sTUFBTSxhQUFhLEVBQUUsT0FBTyxNQUFNLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQSxJQUM3RDtBQUFBO0FBQUEsTUFFRSxJQUFJLGlCQUFpQix5QkFBbUI7QUFBQTtBQUFBO0FBSTlDLElBQUksa0JBQWtCO0FBQUEsRUFRcEIsUUFBUSxXQUFXLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFDckQ7QUFxQkEsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiNzc1MTY4OTAzMDUyQjA1MzY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
