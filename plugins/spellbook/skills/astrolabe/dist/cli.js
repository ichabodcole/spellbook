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
  main,
  run
};

//# debugId=F14A7C73FD4CF09164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9hc3Ryb2xhYmUvYmFja2VuZC9oZWFydGJlYXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGFzdHJvbGFiZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgc3RhbmRpbmcgb2JzZXJ2YXRvcnlcbi8vIGRhZW1vbidzIEhUVFAgc3VyZmFjZSAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgYm9hcmQgdGhyb3VnaCB0aGVzZVxuLy8gdmVyYnM7IGBqb2luYC9gdGFpbGAgc3RyZWFtIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwLlxuLy9cbi8vIERpc2NvdmVyeSArIGxpZmVjeWNsZTogYSBTSU5HTEVUT04gZGFlbW9uIHBlciAkQVNUUk9MQUJFX0hPTUUuIFRoZSBmaXJzdCB2ZXJiXG4vLyB0aGF0IG5lZWRzIGl0IGF1dG8tc3Bhd25zIGl0IChkZXRhY2hlZCwgc3Vydml2ZXMgdGhpcyBDTEkpOyBpdCdzIGZvdW5kIHZpYVxuLy8gJEFTVFJPTEFCRV9IT01FL2RhZW1vbi57cG9ydCxwaWR9LlxuLy9cbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyB1cCArIG9wZW4gdGhlIGJvYXJkXG4vLyAgIGJ1biBjbGkudHMgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbi8vICAgYnVuIGNsaS50cyByZW1vdmUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgIyB1bnJlZ2lzdGVyIGEgcHJvamVjdCAoZHVyYWJsZSlcbi8vICAgYnVuIGNsaS50cyBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXSAgICMgc2NvcGVkIC9ldmVudHMgdGFpbCDigJQgQUNUSVZBVEVTIHRoZSBjYXJkICsgcmVjZWl2ZXMgcG9rZXMgKHdyYXAgd2l0aCBNb25pdG9yKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyA8aWQ+IDxzdW1tYXJ5Li4uPiBbLS1waGFzZSAuLl0gWy0tc3RkaW5dICAgIyByZXBsYWNlIHRoZSBjdXJyZW50IHN0YXR1c1xuLy8gICBidW4gY2xpLnRzIGF0dGVudGlvbiA8aWQ+IFstLWNsZWFyXSBbLS1xdWVzdGlvbiAuLi5dICAgICAgICAgIyByYWlzZSAvIGNsZWFyIHRoZSBodW1hbiBnYXRlXG4vLyAgIGJ1biBjbGkudHMgcG9rZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICMgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyByZWFkLWJhY2s6IHByb2plY3QgY2FyZHNcbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dIFstLWFzIDxuYW1lPl0gICAgIyB1bnNjb3BlZCBldmVudCB0YWlsIOKGkiBKU09OTCAobm8gcHJlc2VuY2UpXG4vLyAgIGJ1biBjbGkudHMgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHBcbi8vXG4vLyBgam9pbmAgaXMgdGhlIGxpc3RlbmluZyBsb29wIGEgcHJvamVjdCdzIGFnZW50IHJ1bnM6IGhvbGRpbmcgdGhlIHNjb3BlZFxuLy8gYC9ldmVudHM/cHJvamVjdD08aWQ+YCB0YWlsIG9wZW4gaXMgd2hhdCBtYXJrcyB0aGUgY2FyZCBhY3RpdmUgKHBlciB0aGUgZGFlbW9uXG4vLyBjb250cmFjdCDigJQgcHJlc2VuY2UgSVMgdGhlIGxpdmUgY29ubmVjdGlvbiksIGFuZCB0aGUgc2FtZSB0YWlsIGRlbGl2ZXJzIHBva2VzLlxuLy9cbi8vIElkZW50aXR5OiAtLWFzIC8gLS1mcm9tIChvciAkQVNUUk9MQUJFX0FTKSBzdGFtcHMgdGhlIGV2ZW50IGBieWAgYW5kIGRyaXZlc1xuLy8gc2VsZi1lY2hvIHN1cHByZXNzaW9uLiAtLXN0ZGluIHJlYWRzIGZyZWUgdGV4dCAoZGVzY3JpcHRpb24vc3VtbWFyeSkgZnJvbVxuLy8gc3RkaW4gKGJ5cGFzc2VzIHNoZWxsIHF1b3RpbmcpLiBEaXNjaXBsaW5lOiBzdHJ1Y3R1cmVkIEpTT04gb24gc3Rkb3V0IChvbmVcbi8vIGxpbmUpOyBsaXZlbmVzcywgZWNob2VzIGFuZCBrZWVwYWxpdmVzIG9uIHN0ZGVycjsgZmFpbHVyZXMgcHV0IE9ORSBKU09OIGVycm9yXG4vLyBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgbGVmdCBlbXB0eSDigJQgbmV2ZXIgbWVyZ2Ugc3RyZWFtcy4gRXhpdCAyIG9uXG4vLyBiYWQgYXJncywgYSBiYXJlIGludm9jYXRpb24sIE9SIGEgcmVqZWN0ZWQgY29tbWFuZCAoZGVkdXBlIC8gdW5rbm93biBpZCk7XG4vLyAwIG9uIHN1Y2Nlc3M7IDEgb24gaW50ZXJuYWwgZmF1bHRzIChkYWVtb24gZmFpbGVkIHRvIHN0YXJ0KTsgYSB0YWlsIGV4aXRzIDBcbi8vIG9uIHRoZSBkYWVtb24ncyBgY2xvc2VkYCBmcmFtZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuaW1wb3J0IHsgZGllLCByZXBvcnRDbGlFcnJvciwgc2V0Q3VycmVudENvbW1hbmQgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQgeyB0YWlsRXZlbnRzIH0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxFdmVudHNcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFwiLi5cIiwgXCJzY3JpcHRzXCIg4oCUIE5PVCBhIHNpYmxpbmcgbG9va3VwLiBUaGlzIGZpbGUgaXMgQVVUSE9SRUQgaGVyZSBhbmRcbi8vIEVYRUNVVEVTIGFzIGAuLi9kaXN0L2NsaS5qc2AgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIGFuZFxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlXG4vLyBwYXRoIGluIHRoaXMgZmlsZSAoU0tJTExfUk9PVCwgRElTVF9ESVIsIFNVUkZBQ0VfQ1dELCBwbHVnaW4uanNvbikgaXNcbi8vIHVuY2hhbmdlZCBieSB0aGUgbW92ZS4gQSBTSUJMSU5HLXJlbGF0aXZlIG9uZSBpcyBub3Q6IGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgcmVzb2x2ZWQgdG8gYGRpc3Qvc2VydmVyLnRzYCBhbmQgdGhlIGRhZW1vbiB3b3VsZCBuZXZlclxuLy8gc3Bhd24uIEdvaW5nIHVwIGFuZCBiYWNrIGRvd24gaXMgY29ycmVjdCBmcm9tIEJPVEggbG9jYXRpb25zLlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIGRldjogdGhlIGRhZW1vbiBzZXJ2ZXMgYSBCdW4tYnVuZGxlZCBSZWFjdCBzdXJmYWNlLCBhbmQgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvYXN0cm9sYWJlLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IChtZWFzdXJlZCBvbiBnbGFtb3VyOiB0aGUgcGFnZSA1MDBzXG4vLyB3aXRoIG5vIHN0eWxlc2hlZXQgbGluazsgYXN0cm9sYWJlJ3Mgb3duIGZhaWx1cmUgc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzXG4vLyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZVxuLy8gYW55d2F5IHdvdWxkIGJyZWFrIHRoZSBzcGF3bi5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJhc3Ryb2xhYmVcIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgQVNUUk9MQUJFX0hPTUUgPSBwcm9jZXNzLmVudi5BU1RST0xBQkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuYXN0cm9sYWJlXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcblxuLy8g4pSA4pSAIHRoZSB0YWlsIHdhdGNoZG9nLCBERVJJVkVEIEZST00gVEhFIERBRU1PTidTIE9XTiBIRUFSVEJFQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8g4puUIEEgQ09OU1RBTlQgSEVSRSBXT1VMRCBCRSBBIENPTlNUQU5UIERFQ09VUExFRCBGUk9NIFRIRSBUSElORyBJVCBXQVRDSEVTLlxuLy8gVGhlIHdhdGNoZG9nIGFib3J0cyBhIGNvbm5lY3Rpb24gdGhhdCBoYXMgc2FpZCBub3RoaW5nIGZvciBgVEFJTF9JRExFX01TYDtcbi8vIHRoZSBvbmx5IHRoaW5nIGtlZXBpbmcgYSBxdWlldCBjb25uZWN0aW9uIGFsaXZlIGlzIHRoZSBkYWVtb24ncyBgOiBoYmBcbi8vIGNvbW1lbnQuIFNvIHRoZSB0d28gbnVtYmVycyBhcmUgT05FIGludmFyaWFudCDigJQgd2F0Y2hkb2cgPiBoZWFydGJlYXQsIHdpdGhcbi8vIHJvb20gZm9yIG1pc3NlZCBiZWF0cy5cbi8vXG4vLyDim5QgSVQgVVNFRCBUTyBCRSBNSVJST1JFRCBIRVJFIEJZIEhBTkQuIFR3byBleHByZXNzaW9ucyBjb3BpZWQgb3V0IG9mIHRoZVxuLy8gZGFlbW9uIHVuZGVyIGEgY29tbWVudCBzYXlpbmcgXCJhbiBlZGl0IHRoZXJlIGlzIGFuIGVkaXQgaGVyZVwiLCBiZWNhdXNlIHRoZVxuLy8gQ0xJIGNvdWxkIG5vdCBpbXBvcnQgdGhlIGRhZW1vbiB3aXRob3V0IGRyYWdnaW5nIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50b1xuLy8gYGRpc3QvY2xpLmpzYC4gUGhhc2UgMWIncyBzaGFyZWQgc3BpbmUgaXMgdGhhdCBpbXBvcnQ6IGAuL2hlYXJ0YmVhdC50c2AgaXMgYVxuLy8gbGVhZi1zaGFwZWQgbW9kdWxlIHdpdGggbm8gZGFlbW9uIGluIGl0LCBib3RoIGhhbHZlcyBpbXBvcnQgaXQsIGFuZCB0aGVcbi8vIG1pcnJvciBpcyBnb25lIHJhdGhlciB0aGFuIGFubm90YXRlZC5cblxuLy8gRmFpbHVyZXMgbGVhdmUgc3Rkb3V0IGVtcHR5IGFuZCBwdXQgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIOKAlCB0aGUgc2FtZVxuLy8gbWFjaGluZSBzaGFwZSBhcyB0aGUgZGF0YSBwYXRoLCBzbyBhIHBpcGVkIGNhbGxlciBwYXJzZXMgdGhlIGVycm9yIGluc3RlYWQgb2Zcbi8vIHNjcmFwaW5nIHByb3NlLiBUSEUgRU5WRUxPUEUsIFRIRSBUQVhPTk9NWSBBTkQgVEhFIEVYSVQgQ09ERVMgQVJFIE5PVyBTSEFSRURcbi8vIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApOyBhc3Ryb2xhYmUncyBmb3VydGgsIG1pbmltYWwgY29weSBpcyBnb25lLiBUd29cbi8vIHRoaW5ncyBjaGFuZ2VkIGFuZCBib3RoIGFyZSBhZGRpdGl2ZTogdGhlIGVudmVsb3BlIGdhaW5zIGBleGl0X2NvZGVgLFxuLy8gYHJldHJ5YWJsZWAgYW5kIGBtZXRhLmNvbW1hbmRgLCBhbmQgYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3IgdGhhdCBgbWFpbmBcbi8vIHJlcG9ydHMsIHJhdGhlciB0aGFuIGV4aXRpbmcgZnJvbSB3aGVyZXZlciBpdCB3YXMgY2FsbGVkLiBga2luZGAgYW5kXG4vLyBgbWVzc2FnZWAg4oCUIHRoZSB0d28gZmllbGRzIGFueXRoaW5nIGNhbiBiZSBrZXlpbmcgb24g4oCUIGFyZSB1bnRvdWNoZWQuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKSA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG4vLyBpZCArIGF2YXRhciBhcmUgREVSSVZFRCBieSB0aGUgZGFlbW9uIChzdGF0ZS50cykgZnJvbSB0aGUgcHJvamVjdCBuYW1lLCBzbyB0aGVcbi8vIGNsaSBwYXNzZXMgaWQvYXZhdGFyIHRocm91Z2ggb25seSB3aGVuIHRoZSBjYWxsZXIgZ2F2ZSB0aGVtIGV4cGxpY2l0bHkg4oCUIG9uZVxuLy8gc291cmNlIG9mIHRydXRoLCBubyBzbHVnL2F2YXRhciBtaXJyb3IgdG8gZHJpZnQuXG5cbmZ1bmN0aW9uIHJlc29sdmVBcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB2ID0gZmxhZ3MuYXMgPz8gZmxhZ3MuZnJvbTtcbiAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpKSByZXR1cm4gdi50cmltKCk7XG4gIGNvbnN0IGVudiA9IHByb2Nlc3MuZW52LkFTVFJPTEFCRV9BUztcbiAgcmV0dXJuIGVudj8udHJpbSgpID8gZW52LnRyaW0oKSA6IHVuZGVmaW5lZDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW107XG4gIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgQnVuLnN0ZGluLnN0cmVhbSgpKSBjaHVua3MucHVzaChjaHVuayk7XG4gIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKTtcbn1cblxuLy8g4pSA4pSAIGRhZW1vbiBkaXNjb3ZlcnkgKyBIVFRQIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiByZWFkUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gTnVtYmVyLnBhcnNlSW50KChhd2FpdCBCdW4uZmlsZShQT1JUX0ZJTEUpLnRleHQoKSkudHJpbSgpLCAxMCk7XG4gICAgcmV0dXJuIHAgPiAwID8gcCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGlzVXAocG9ydDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIChhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3N0YXRlYCkpLm9rO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgcnVubmluZyBkYWVtb24sIG9yIGF1dG8tc3Bhd24gb25lIChkZXRhY2hlZCBzbyBpdCBvdXRsaXZlcyB0aGlzIENMSSDigJRcbi8vIG5vZGU6Y2hpbGRfcHJvY2Vzcywgbm90IEJ1bi5zcGF3biwgd2hpY2ggY2FuJ3QgZGV0YWNoIGEgc3Vydml2aW5nIGRhZW1vbikuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24oKTogUHJvbWlzZTx7IGJhc2U6IHN0cmluZzsgcG9ydDogbnVtYmVyIH0+IHtcbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkUG9ydCgpO1xuICBpZiAoZXhpc3RpbmcgJiYgKGF3YWl0IGlzVXAoZXhpc3RpbmcpKSkge1xuICAgIHJldHVybiB7IGJhc2U6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZXhpc3Rpbmd9YCwgcG9ydDogZXhpc3RpbmcgfTtcbiAgfVxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCJdLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQSB3cm9uZyBjd2Qgc2tpcHMgYnVuZmlnLnRvbWwncyBUYWlsd2luZFxuICAgIC8vIHBsdWdpbjsgb24gZ2xhbW91ciB0aGF0IGZhaWxzIHRoZSBwYWdlIG91dHJpZ2h0ICg1MDApLiBBc3NlcnQgdGhlIGludmFyaWFudCxcbiAgICAvLyBub3QgdGhlIHN0YXR1czogdGhlIHV0aWxpdHkgbmV2ZXIgcmVhY2hlcyB0aGUgYnJvd3NlciB3aGVuIGN3ZCBpcyB3cm9uZy5cbiAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBUaGUgZGFlbW9uIEJJTkRTIGZhc3QgYW5kIGFuc3dlcnMgL3N0YXRlIGFzIHNvb24gYXMgaXQncyBsaXN0ZW5pbmcgKHRoZVxuICAvLyBjb2xkIFRhaWx3aW5kK1JlYWN0IGJ1bmRsZSBpcyBsYXp5LCBvbiB0aGUgZmlyc3QgR0VUIFwiL1wiKSwgc28gdGhpcyBoYW5kc2hha2VcbiAgLy8gdXN1YWxseSByZXR1cm5zIHF1aWNrbHkuIFRoZSB3aWRlIGRlYWRsaW5lIGNvdmVycyBhIGNvbGQgbWFjaGluZSB3aGVyZVxuICAvLyBtb2R1bGUgbG9hZCArIGZpcnN0IHNlcnZlIHJ1bnMgc2xvdyAoZ2xhbW91ciB1c2VzIHRoZSBzYW1lIH40NXMgYnVkZ2V0KS5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBzbGVlcCg4MCk7XG4gICAgY29uc3QgcCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gICAgaWYgKHAgJiYgKGF3YWl0IGlzVXAocCkpKSByZXR1cm4geyBiYXNlOiBgaHR0cDovLzEyNy4wLjAuMToke3B9YCwgcG9ydDogcCB9O1xuICB9XG4gIGRpZShcImFzdHJvbGFiZSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiA0NXNcIiwgXCJpbnRlcm5hbFwiKTtcbn1cblxuLy8gQSByZWFkLW9ubHkgdmVyYiByZXF1aXJlcyBhIGxpdmUgZGFlbW9uIGJ1dCBtdXN0IG5vdCBzcGF3biBvbmUgKG5vdGhpbmcgdG9cbi8vIG9ic2VydmUgeWV0KSDigJQgc28gYHN0YXRlYC9gbGlzdGAvYGluZm9gIG9uIGEgY29sZCBtYWNoaW5lIHJlcG9ydCBjbGVhbmx5LlxuYXN5bmMgZnVuY3Rpb24gcnVubmluZ0Jhc2UoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHAgPSBhd2FpdCByZWFkUG9ydCgpO1xuICByZXR1cm4gcCA/IGBodHRwOi8vMTI3LjAuMC4xOiR7cH1gIDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChiYXNlOiBzdHJpbmcsIGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L2NtZGAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgfSk7XG4gIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyBvazogYm9vbGVhbjsgYXBwbGllZDogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmc7IG91dGNvbWU/OiBzdHJpbmcgfTtcbn1cblxuLy8gQXBwbHkgYSAvY21kLCBzdXJmYWNlIGEgcmVqZWN0aW9uIG9uIHN0ZGVyciArIG5vbi16ZXJvIGV4aXQgKGV4aXQtY29kZVxuLy8gY29udHJhY3QpLCBhbmQgZWNobyB0aGUgc3RydWN0dXJlZCByZXN1bHQgb24gc3Rkb3V0IG9uIHN1Y2Nlc3MuXG5hc3luYyBmdW5jdGlvbiBjbWQoYmFzZTogc3RyaW5nLCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCByID0gYXdhaXQgcG9zdENtZChiYXNlLCBib2R5KTtcbiAgLy8gYjIvIzg1IOKAlCBESVNUSU5HVUlTSCBUSEUgVFdPIEtJTkRTIE9GIGFwcGxpZWQ6ZmFsc2UuIFdJVEggYW4gZXJyb3IgPSBhIHJlYWxcbiAgLy8gcmVqZWN0aW9uICh1bmtub3duIHByb2plY3QsIGR1cGxpY2F0ZSkgLT4gdmlzaWJsZSwgbm9uLXplcm8sIHVuY2hhbmdlZC5cbiAgLy8gV0lUSE9VVCBhbiBlcnJvciA9IGEgYmVuaWduIG5vLW9wOiB0aGUgc3RhdGUgd2FzIGFscmVhZHkgd2hhdCB3YXMgYXNrZWQgZm9yLFxuICAvLyB0aGUgcHJvamVjdCBleGlzdHMsIHRoZSBkYWVtb24gaXMgcmlnaHQsIGFuZCBub3RoaW5nIGlzIHdyb25nLiBUaGF0IHVzZWQgdG9cbiAgLy8gZXhpdCAyIHdpdGggXCJjb21tYW5kICdhdHRlbnRpb24nIHdhcyBub3QgYXBwbGllZFwiLCBzbyByZS1pc3N1aW5nIGFuXG4gIC8vIGFscmVhZHktYXBwbGllZCBjb21tYW5kIHdhcyBhIGhhcmQgZmFpbHVyZSDigJQgd2hpbGUgYm91bnR5IHRyZWF0cyB0aGVcbiAgLy8gaWRlbnRpY2FsIHBheWxvYWQgYXMgb3JkaW5hcnkgc3VjY2Vzcy5cbiAgLy9cbiAgLy8gVGhpcyBpcyBib3VudHkncyBkaXNjaXBsaW5lIChjbGkudHMgYHRhc2sudXBkYXRlYCksIHBvcnRlZCByYXRoZXIgdGhhblxuICAvLyByZS1kZXJpdmVkLiBJdCByZXBvcnRzIHRoZSBkYWVtb24ncyBgb3V0Y29tZWAgbm91biBpbnN0ZWFkIG9mIGJvdW50eSdzXG4gIC8vIGBub29wOiB0cnVlYCBib29sZWFuLCBwZXIgdGhlIG91dGNvbWUgY29udHJhY3QncyBcImVudW1lcmF0ZWQsIG5ldmVyIGFcbiAgLy8gYm9vbGVhblwiIOKAlCB0aGUgbm91biBzYXlzIFdISUNIIHN0YXRlIG1hZGUgdGhlIHdvcmsgdW5uZWNlc3NhcnkuXG4gIGlmICghci5hcHBsaWVkICYmIHIuZXJyb3IpIGRpZShyLmVycm9yKTtcbiAgcHJpbnRKc29uKHIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBzcGF3bihvcGVuZXIsIFt1cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIFNTRSByZWFkZXI6IHN0cmVhbSB0aGUgZXZlbnQgbG9nIGFzIEpTT05MIG9uIHN0ZG91dCwgcmVzdW1hYmxlICsgcmVjb25uZWN0aW5nXG4vLyDigJQgb25lIGNhbGwgaW50byB0aGUgaG91c2UncyBzaGFyZWQgdGFpbCBjbGllbnQgKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLFxuLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGxvb3AsIHRoZSBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmRcbi8vIHRoZSBkcmFpbmVkIGV4aXQgbm93IGxpdmUsIE9OQ0UsIGZvciBldmVyeSBzcGVsbC5cbi8vXG4vLyBgc2NvcGVJZGAgKHNldCBieSBgam9pbmApIGZpbHRlcnMgdG8gdGhpcyBwcm9qZWN0J3MgZnJhbWVzICsgbGlmZWN5Y2xlOyBhblxuLy8gdW5zY29wZWQgdGFpbCBwYXNzZXMgZXZlcnl0aGluZy4gU2VsZi1lY2hvIChmcmFtZXMgdGhlIGNhbGxlcidzIG93biAtLWFzXG4vLyBjYXVzZWQpIGlzIHN1cHByZXNzZWQuIGA6YCBrZWVwYWxpdmVzIHJpZGUgc3RkZXJyOyByZXR1cm5zIDAgb24gYGNsb3NlZGAuXG4vL1xuLy8g4puUIGByZXNvbHZlYCBJUyBgcnVubmluZ0Jhc2VgLCBSRS1SRUFEIE9OIEVWRVJZIEFUVEVNUFQg4oCUIHRoaXMgaXMgdGhlIEIxIGZpeFxuLy8gYW5kIHRoZSByZWFzb24gYXN0cm9sYWJlIHdlbnQgZmlyc3QuIGFzdHJvbGFiZSBiaW5kcyBhbiBFUEhFTUVSQUwgcG9ydCwgYW5kXG4vLyB0aGlzIGZ1bmN0aW9uIHVzZWQgdG8gdGFrZSBhIGNhcHR1cmVkIGBiYXNlOiBzdHJpbmdgLCBzbyBhZnRlciBhbnkgZGFlbW9uXG4vLyByZXN0YXJ0IGBqb2luYCByZWNvbm5lY3RlZCB0byBhIGRlYWQgcG9ydCBmb3JldmVyIGFuZCBzdHJlYW1lZCBub3RoaW5nIHdoaWxlXG4vLyBsb29raW5nIHBlcmZlY3RseSBhbGl2ZS4gSXQgY2Fubm90OiB0aGUgY2FsbGJhY2sgcmUtcmVhZHNcbi8vIGAkQVNUUk9MQUJFX0hPTUUvZGFlbW9uLnBvcnRgIGJlZm9yZSBldmVyeSBjb25uZWN0LiBEcml2ZW4gaW4gYGNsaS50ZXN0LnRzYC5cbi8vXG4vLyBJdCBkZWxpYmVyYXRlbHkgZG9lcyBOT1Qgc3Bhd24uIGBqb2luYC9gdGFpbGAgc3RpbGwgY2FsbCBgZW5zdXJlRGFlbW9uKClgXG4vLyBvbmNlIHVwIGZyb250IChhIHRhaWwgd2l0aCBubyBkYWVtb24gYXQgYWxsIGlzIHdvcnRoIHJlcG9ydGluZyk7IGEgZGFlbW9uXG4vLyB0aGF0IGRpZXMgTUlELXdhdGNoIGlzIGEgd2FpdCwgbm90IGEgcmVzcGF3biwgYmVjYXVzZSBhIHNlY29uZCBhc3Ryb2xhYmVcbi8vIHNwYXduZWQgZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBpcyBhIHdvcnNlIG91dGNvbWUgdGhhbiBhIHdhdGNoIHRoYXRcbi8vIHJlc3VtZXMgd2hlbiB0aGUgaHVtYW4gcmVvcGVucyB0aGUgYm9hcmQuXG5hc3luYyBmdW5jdGlvbiBzdHJlYW1FdmVudHMob3B0czoge1xuICBzaW5jZTogbnVtYmVyO1xuICBwcm9qZWN0Pzogc3RyaW5nO1xuICBzY29wZUlkPzogc3RyaW5nO1xuICBzZWxmPzogc3RyaW5nO1xufSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHR5cGUgRXYgPSB7IGlkPzogbnVtYmVyOyBlcG9jaD86IHN0cmluZzsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmc7IHByb2plY3RJZD86IHN0cmluZyB9O1xuXG4gIGNvbnN0IGluU2NvcGUgPSAoZXY6IEV2KSA9PiB7XG4gICAgaWYgKCFvcHRzLnNjb3BlSWQpIHJldHVybiB0cnVlO1xuICAgIGlmIChldi50eXBlID09PSBcInJlYWR5XCIgfHwgZXYudHlwZSA9PT0gXCJjbG9zZWRcIikgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIGV2LnByb2plY3RJZCA9PT0gb3B0cy5zY29wZUlkO1xuICB9O1xuXG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgcmVzb2x2ZTogcnVubmluZ0Jhc2UsXG4gICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgc2luY2U6IG9wdHMuc2luY2UsXG4gICAgY3Vyc29yT2Y6IChldikgPT4gZXYuaWQsXG4gICAgcXVlcnk6IChjdXJzb3IpID0+ICh7XG4gICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICAuLi4ob3B0cy5wcm9qZWN0ID8geyBwcm9qZWN0OiBvcHRzLnByb2plY3QgfSA6IHt9KSxcbiAgICB9KSxcbiAgICBhY2NlcHQ6IChldikgPT4gaW5TY29wZShldikgJiYgIShvcHRzLnNlbGYgIT09IHVuZGVmaW5lZCAmJiBldi5ieSA9PT0gb3B0cy5zZWxmKSxcbiAgICB0ZXJtaW5hbDogKGV2KSA9PiBldi50eXBlID09PSBcImNsb3NlZFwiLFxuICAgIC8vIOKblCBUSEUgUkVTVEFSVCBHQVAuIEFzdHJvbGFiZSBpcyBhIHNpbmdsZXRvbiB0aGF0IGBjbGkudHNgIHJlc3Bhd25zLCBhbmRcbiAgICAvLyBpdHMgZXZlbnQgaWRzIHJlc3RhcnQgYXQgMSDigJQgc28gYSBgam9pbmAgdGhhdCBoYXMgYmVlbiBydW5uaW5nIGZvciBob3Vyc1xuICAgIC8vIHJlc3VtZXMgYXQgYHNpbmNlPTxhIGxhcmdlIG51bWJlcj5gIGFnYWluc3QgYSBkYWVtb24gd2hvc2Ugd2hvbGUgbG9nIGlzXG4gICAgLy8gc21hbGxlciB0aGFuIHRoYXQuIFRoZSBkYWVtb24gaGFsZiAoYGtpdC93aXJlL2V2ZW50TG9nLnRzYCkgcmVwbGF5cyB3aG9sZVxuICAgIC8vIHdoZW4gdGhlIGN1cnNvciBpcyBiZXlvbmQgaXRzIG93bjsgdGhpcyBoYWxmIGlzIHdoYXQgc3RvcHMgdGhlIHRhaWwgdGhlblxuICAgIC8vIHJlLXJlcXVlc3RpbmcgdGhlIHN0YWxlIGN1cnNvciBvbiBldmVyeSBzdWJzZXF1ZW50IHJlY29ubmVjdC4gVGhlIGxpbmUgaXNcbiAgICAvLyBTWU5USEVTSVpFRCDigJQgaXQgaXMgbm90IGEgYnVzIGV2ZW50LCBjYXJyaWVzIG5vIGBpZGAsIGFuZCBuZXZlciBhZHZhbmNlc1xuICAgIC8vIHRoZSBjdXJzb3Ig4oCUIHdoaWNoIGlzIHRoZSBzYW1lIHNlcGFyYXRpb24gbWluZC1tYXBwZXIncyBgZXBvY2guY2hhbmdlZGBcbiAgICAvLyBtYWtlcyBhbmQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvdGFpbC50ZXN0LnRzYCBwaW5zLlxuICAgIGVwb2NoT2Y6IChldikgPT4gZXYuZXBvY2gsXG4gICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICBvbkNvbW1lbnQ6ICgpID0+IFwiOiBhc3Ryb2xhYmUta2VlcGFsaXZlXCIsXG4gIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHsgcG9ydCB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGlmICghZmxhZ3NbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3NlcihgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IG5hbWUgPSBwb3Muam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dXCIpO1xuICBjb25zdCBwYXRoID0gdHlwZW9mIGZsYWdzLnBhdGggPT09IFwic3RyaW5nXCIgPyBmbGFncy5wYXRoLnRyaW0oKSA6IFwiXCI7XG4gIGlmICghcGF0aCkgZGllKFwiYWRkIHJlcXVpcmVzIC0tcGF0aCA8cD5cIik7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gZmxhZ3Muc3RkaW5cbiAgICA/IGF3YWl0IHJlYWRTdGRpbigpXG4gICAgOiB0eXBlb2YgZmxhZ3MuZGVzY3JpcHRpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MuZGVzY3JpcHRpb25cbiAgICAgIDogdW5kZWZpbmVkO1xuICAvLyBpZCArIGF2YXRhciBhcmUgb3B0aW9uYWwg4oCUIHRoZSBkYWVtb24gZGVyaXZlcyBib3RoIGZyb20gdGhlIG5hbWUgd2hlbiBvbWl0dGVkLlxuICBjb25zdCBhdmF0YXIgPSB0eXBlb2YgZmxhZ3MuYXZhdGFyID09PSBcInN0cmluZ1wiID8gZmxhZ3MuYXZhdGFyIDogdW5kZWZpbmVkO1xuICBjb25zdCBpZCA9IHR5cGVvZiBmbGFncy5pZCA9PT0gXCJzdHJpbmdcIiAmJiBmbGFncy5pZC50cmltKCkgPyBmbGFncy5pZC50cmltKCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7XG4gICAgdHlwZTogXCJwcm9qZWN0LmFkZFwiLFxuICAgIHByb2plY3Q6IHsgaWQsIG5hbWUsIHBhdGgsIGRlc2NyaXB0aW9uLCBhdmF0YXIgfSxcbiAgICBhczogcmVzb2x2ZUFzKGZsYWdzKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlbW92ZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiByZW1vdmUgPGlkPlwiKTtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJwcm9qZWN0LnJlbW92ZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXR1cyhwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBzdGF0dXMgPGlkPiA8c3VtbWFyeS4uLj4gWy0tcGhhc2UgLi5dIFstLXN0ZGluXVwiKTtcbiAgY29uc3Qgc3VtbWFyeSA9IGZsYWdzLnN0ZGluID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIXN1bW1hcnkpIGRpZShcInN0YXR1cyByZXF1aXJlcyBhIHN1bW1hcnkgKHBvc2l0aW9uYWwgb3IgLS1zdGRpbilcIik7XG4gIGNvbnN0IHBoYXNlID0gdHlwZW9mIGZsYWdzLnBoYXNlID09PSBcInN0cmluZ1wiID8gZmxhZ3MucGhhc2UgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwic3RhdHVzXCIsIGlkLCBzdW1tYXJ5LCBwaGFzZSwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEF0dGVudGlvbihwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBhdHRlbnRpb24gPGlkPiBbLS1jbGVhcl0gWy0tcXVlc3Rpb24gLi4uXVwiKTtcbiAgY29uc3QgcmFpc2VkID0gZmxhZ3MuY2xlYXIgIT09IHRydWU7XG4gIGNvbnN0IHF1ZXN0aW9uID1cbiAgICB0eXBlb2YgZmxhZ3MucXVlc3Rpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MucXVlc3Rpb25cbiAgICAgIDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwiYXR0ZW50aW9uXCIsIGlkLCByYWlzZWQsIHF1ZXN0aW9uLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUG9rZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBwb2tlIDxpZD5cIik7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwicG9rZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKCkge1xuICBjb25zdCBiYXNlID0gYXdhaXQgcnVubmluZ0Jhc2UoKTtcbiAgaWYgKCFiYXNlIHx8ICEoYXdhaXQgaXNVcChOdW1iZXIucGFyc2VJbnQoYmFzZS5zcGxpdChcIjpcIikucG9wKCkgYXMgc3RyaW5nLCAxMCkpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSwgc3RhdGU6IHsgdGl0bGU6IFwiT2JzZXJ2YXRvcnlcIiwgcHJvamVjdHM6IFtdIH0gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L3N0YXRlYCk7XG4gIGlmICghcmVzLm9rKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWApO1xuICBwcmludEpzb24oYXdhaXQgcmVzLmpzb24oKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IGJhc2UgPSBhd2FpdCBydW5uaW5nQmFzZSgpO1xuICAvLyBHdWFyZCB3aXRoIGlzVXAoKSBiZWZvcmUgZmV0Y2hpbmcgKG1pcnJvcnMgY21kU3RhdGUpOiBhIFNUQUxFIGRhZW1vbi5wb3J0XG4gIC8vIGZyb20gYSBjcmFzaGVkIGRhZW1vbiB3b3VsZCBvdGhlcndpc2UgdGhyb3cgRUNPTk5SRUZVU0VEIGhlcmUgaW5zdGVhZCBvZiB0aGVcbiAgLy8gY2xlYW4gcnVubmluZzpmYWxzZSBwYXRoLlxuICBpZiAoIWJhc2UgfHwgIShhd2FpdCBpc1VwKE51bWJlci5wYXJzZUludChiYXNlLnNwbGl0KFwiOlwiKS5wb3AoKSBhcyBzdHJpbmcsIDEwKSkpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IGZhbHNlLCBwcm9qZWN0czogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdGUgfSA9IChhd2FpdCAoYXdhaXQgZmV0Y2goYCR7YmFzZX0vc3RhdGVgKSkuanNvbigpKSBhcyB7XG4gICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9O1xuICB9O1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHJ1bm5pbmc6IHRydWUsXG4gICAgcHJvamVjdHM6IHN0YXRlLnByb2plY3RzLm1hcCgocCkgPT4gKHtcbiAgICAgIGlkOiBwLmlkLFxuICAgICAgbmFtZTogcC5uYW1lLFxuICAgICAgem9uZTogcC56b25lLFxuICAgICAgY29ubmVjdGVkOiBwLmNvbm5lY3RlZCxcbiAgICB9KSksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgYmFzZSA9IGF3YWl0IHJ1bm5pbmdCYXNlKCk7XG4gIGlmICghYmFzZSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IFwibm8gZGFlbW9uIHJ1bm5pbmdcIiB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoYmFzZSwgeyB0eXBlOiBcImNsb3NlXCIsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5mbygpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gIGlmIChwb3J0ICYmIChhd2FpdCBpc1VwKHBvcnQpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xuICB9IGVsc2Uge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSB9KTtcbiAgfVxufVxuXG5jb25zdCBIRUxQID0gYGFzdHJvbGFiZSDigJQgYSBzdGFuZGluZyBvYnNlcnZhdG9yeSBib2FyZCBmb3IgcHJvamVjdHMgaW4gZmxpZ2h0LlxuXG4gIG9wZW4gWy0tbm8tb3Blbl1cbiAgICAgIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHVwICsgb3BlbiB0aGUgYm9hcmQgaW4gdGhlIGJyb3dzZXJcbiAgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlZ2lzdGVyIGEgcHJvamVjdCAoZGVkdXBlLWd1YXJkZWQ7IGlkICsgYXZhdGFyIGRlcml2ZWQgZnJvbSB0aGUgbmFtZSB3aGVuIG9taXR0ZWQpLlxuICAgICAgdGhlIHJlc3BvbnNlIGVjaG9lcyB0aGUgZGVyaXZlZCBpZCDigJQgeW91IG5lZWQgaXQgZm9yIGpvaW4vc3RhdHVzL2F0dGVudGlvbi9yZW1vdmUuXG4gIHJlbW92ZSA8aWQ+XG4gICAgICB1bnJlZ2lzdGVyIGEgcHJvamVjdFxuICBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXVxuICAgICAgYWN0aXZhdGUgdGhlIGNhcmQgKyBsaXN0ZW4gZm9yIHBva2VzIChzY29wZWQgdGFpbDsgd3JhcCB3aXRoIE1vbml0b3IpLiBlbmQgaXQgdG8gaWRsZSB0aGUgY2FyZC5cbiAgc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlcGxhY2UgYSBwcm9qZWN0J3MgY3VycmVudCBzdGF0dXNcbiAgYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl1cbiAgICAgIHJhaXNlIC8gY2xlYXIgdGhlIG5lZWRzLXlvdSBnYXRlICgtLXF1ZXN0aW9uIGF0dGFjaGVzIHRoZSBwcm9tcHQpXG4gIHBva2UgPGlkPlxuICAgICAgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbiAgc3RhdGVcbiAgICAgIHJlYWQtYmFjazogcHJvamVjdCBjYXJkcyAoZWFjaCBjYXJyaWVzIGEgZGVyaXZlZCB6b25lOiBhdHRlbnRpb24gfCBhY3RpdmUgfCBxdWlldClcbiAgdGFpbCBbLS1zaW5jZSBOXSBbLS1hcyA8bmFtZT5dXG4gICAgICB1bnNjb3BlZCBldmVudCB0YWlsIGFzIEpTT05MIChubyBwcmVzZW5jZSlcbiAgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHAgfCAtLXZlcnNpb25cblxuICBJZGVudGl0eTogLS1hcyAvIC0tZnJvbSAob3IgJEFTVFJPTEFCRV9BUykgc3RhbXBzIHRoZSBhY3RvciArIHN1cHByZXNzZXMgc2VsZi1lY2hvLlxuICAtLXN0ZGluIHJlYWRzIGEgZGVzY3JpcHRpb24vc3VtbWFyeSBmcm9tIHN0ZGluIChzaGVsbC1xdW90aW5nLXNhZmUpLlxuICBPdXRwdXQ6IGV2ZXJ5IGNvbW1hbmQgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBsaW5lIHBlciBhbnN3ZXI7XG4gIGZhaWx1cmVzIHB1dCBvbmUgSlNPTiBlcnJvciBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG4gIFRoZXJlIGlzIG5vIHByb3NlIG1vZGUgdG8gc3dpdGNoIG91dCBvZi5gO1xuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlIGRlZ3JhZGVzIHRvIFwidW5rbm93blwiLlxuYXN5bmMgZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogUHJvbWlzZTx7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwa2cgPSBhd2FpdCBCdW4uZmlsZShqb2luKFNDUklQVF9ESVIsIFwiLi4vLi4vLi4vLmNsYXVkZS1wbHVnaW4vcGx1Z2luLmpzb25cIikpLmpzb24oKTtcbiAgICBpZiAodHlwZW9mIHBrZz8udmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJhc3Ryb2xhYmVcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBuYW1lOiBcImFzdHJvbGFiZVwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vKipcbiAqIFRoZSBmYWlsdXJlIGZ1bm5lbC4gYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3Igbm93ICh0aGUgaG91c2UncyBvbmUgZXJyb3JcbiAqIGNvbnRyYWN0LCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIGluc3RlYWQgb2YgZXhpdGluZyBmcm9tIHdoZXJldmVyIGl0IHdhc1xuICogY2FsbGVkLCBzbyB0aGlzIGlzIHRoZSBPTkUgcGxhY2UgYSBmYWlsdXJlIGJlY29tZXMgYW4gZXhpdCBjb2RlIOKAlCBhbmQgdGhlXG4gKiBwcm9jZXNzIHN0aWxsIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucywgYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYVxuICogbmF0dXJhbCByZXR1cm4sIHdoaWNoIGlzIHdoYXQgZHJhaW5zIHN0ZG91dCBvbiBhIHBpcGUuXG4gKlxuICog4puUIEEgTk9OLUNsaUVycm9yIElTIFJFVEhST1dOLCBORVZFUiBFTlZFTE9QRUQuIFJlcG9ydGluZyBhbiB1bmtub3duIHRocm93IGFzXG4gKiBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSB3b3VsZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlID09PSBudWxsKSB0aHJvdyBlO1xuICAgIHJldHVybiBjb2RlO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdmVyYiA9IGFyZ3ZbMF07XG4gIHNldEN1cnJlbnRDb21tYW5kKHZlcmIgPz8gbnVsbCk7XG4gIC8vIEEgYmFyZSBpbnZvY2F0aW9uIHJlcXVlc3RlZCBub3RoaW5nIOKAlCB0aGF0IGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHBcbiAgLy8gcmVxdWVzdC4gaGVscCBzdGF5cyByZWFjaGFibGUgYnkgbmFtZSAoYW5kIC0taGVscC8taCkgb24gc3Rkb3V0IGF0IGV4aXQgMC5cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkgZGllKFwibm8gdmVyYiBnaXZlbiDigJQgdHJ5ICdoZWxwJ1wiKTtcbiAgaWYgKHZlcmIgPT09IFwiaGVscFwiIHx8IHZlcmIgPT09IFwiLS1oZWxwXCIgfHwgdmVyYiA9PT0gXCItaFwiKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICAvLyBSb290IHRva2VuLCBkZWxpYmVyYXRlbHkgTk9UIGEgZmxhZzogZGlzcGF0Y2hlZCBhbG9uZ3NpZGUgaGVscCBpbiB0aGUgdmVyYlxuICAvLyBzd2l0Y2gsIHNvIG5vIHBlci12ZXJiIHBhcnNlciBpcyBleHBlY3RlZCB0byBhY2NlcHQgaXQgYmVsb3cgdGhlIHJvb3QuXG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIiB8fCB2ZXJiID09PSBcInZlcnNpb25cIikge1xuICAgIHByaW50SnNvbihhd2FpdCB2ZXJzaW9uSW5mbygpKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LnNsaWNlKDEpLFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBwYXRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgZGVzY3JpcHRpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBhdmF0YXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHBoYXNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcXVlc3Rpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgfSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBkaWUoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgfVxuICBjb25zdCBmbGFncyA9IHBhcnNlZC52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIGNvbnN0IHBvcyA9IHBhcnNlZC5wb3NpdGlvbmFscyBhcyBzdHJpbmdbXTtcbiAgY29uc3Qgc2luY2UgPSB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhZGRcIjpcbiAgICAgIGF3YWl0IGNtZEFkZChwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJyZW1vdmVcIjpcbiAgICAgIGF3YWl0IGNtZFJlbW92ZShwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXR1cyhwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhdHRlbnRpb25cIjpcbiAgICAgIGF3YWl0IGNtZEF0dGVudGlvbihwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJwb2tlXCI6XG4gICAgICBhd2FpdCBjbWRQb2tlKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInN0YXRlXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0ZSgpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImxpc3RcIjpcbiAgICAgIGF3YWl0IGNtZExpc3QoKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgY21kQ2xvc2UoZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGF3YWl0IGNtZEluZm8oKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJqb2luXCI6IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zWzBdO1xuICAgICAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dXCIpO1xuICAgICAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIC8vIENvbmZpcm0gdGhlIHByb2plY3QgZXhpc3RzIGJlZm9yZSBob2xkaW5nIHRoZSB3YXRjaCAoYSB0eXBvJ2QgaWQgd291bGRcbiAgICAgIC8vIG90aGVyd2lzZSBiaW5kIG5vIHByZXNlbmNlIGFuZCBzaWxlbnRseSBzdHJlYW0gbm90aGluZyB1c2VmdWwpLlxuICAgICAgY29uc3QgeyBzdGF0ZSB9ID0gKGF3YWl0IChhd2FpdCBmZXRjaChgJHtiYXNlfS9zdGF0ZWApKS5qc29uKCkpIGFzIHtcbiAgICAgICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgICAgfTtcbiAgICAgIGlmICghc3RhdGUucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gaWQpKVxuICAgICAgICBkaWUoYHVua25vd24gcHJvamVjdCAnJHtpZH0nIOKAlCByZWdpc3RlciBpdCBmaXJzdGApO1xuICAgICAgcmV0dXJuIGF3YWl0IHN0cmVhbUV2ZW50cyh7IHNpbmNlLCBwcm9qZWN0OiBpZCwgc2NvcGVJZDogaWQsIHNlbGY6IHJlc29sdmVBcyhmbGFncykgfSk7XG4gICAgfVxuICAgIGNhc2UgXCJ0YWlsXCI6IHtcbiAgICAgIC8vIGVuc3VyZURhZW1vbiBmb3IgdGhlIFNUQVJUIG9mIHRoZSB3YXRjaCBvbmx5OyB0aGUgdGFpbCByZS1yZXNvbHZlcyB0aGVcbiAgICAgIC8vIGRhZW1vbiBvbiBldmVyeSByZWNvbm5lY3QgKHNlZSBzdHJlYW1FdmVudHMpLCBzbyBgYmFzZWAgaXMgbm90IGNhcnJpZWQuXG4gICAgICBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIHJldHVybiBhd2FpdCBzdHJlYW1FdmVudHMoeyBzaW5jZSwgc2VsZjogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIGRpZShgdW5rbm93biB2ZXJiICcke3ZlcmJ9JyDigJQgdHJ5ICdoZWxwJ2ApO1xuICB9XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG4vLyBFeHBvcnRlZCBzbyB0aGUgc2hpcHBlZCBsYXVuY2hlciAocGx1Z2lucy8uLi4vc2NyaXB0cy9jbGkudHMpIGNhbiBpbnZva2UgdGhlXG4vLyBCVU5ETEVEIGNvcHkgb2YgdGhpcyBtb2R1bGUuIFRoZSBpbXBvcnQubWV0YS5tYWluIGJsb2NrIGFib3ZlIHN0aWxsIHJ1bnMgdGhpc1xuLy8gZmlsZSBkaXJlY3RseSBkdXJpbmcgZGV2ZWxvcG1lbnQ7IHRoZSB0d28gZW50cnkgcm91dGVzIGFyZSBleGNsdXNpdmUsIGJlY2F1c2Vcbi8vIGltcG9ydC5tZXRhLm1haW4gaXMgZmFsc2UgZm9yIGFuIGltcG9ydGVkIG1vZHVsZS5cbmV4cG9ydCB7IG1haW4gfTtcblxuLyoqXG4gKiBUaGUgU0hJUFBFRCBFTlRSWSBQT0lOVCwgY2FsbGVkIGJ5IGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYXN0cm9sYWJlL3NjcmlwdHMvY2xpLnRzYFxuICogYWZ0ZXIgdGhlIGJ1bmRsZSBpcyBpbXBvcnRlZC5cbiAqXG4gKiDim5QgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQuIGFyZ3YgYmVsb25ncyB0byB3aGljaGV2ZXIgZmlsZVxuICogUEFSU0VTIGl0LCBhbmQgdGhhdCBpcyB0aGlzIG9uZS4gQW4gZWFybGllciBsYXVuY2hlciByZWFkXG4gKiBgcHJvY2Vzcy5hcmd2LnNsaWNlKDIpYCBpdHNlbGYgYW5kIHBhc3NlZCBpdCBpbiDigJQgd2hpY2ggbWFkZSB0aGUgbGF1bmNoZXIgbWF0Y2hcbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIFBBUlNFU19BUkdTIHByZWRpY2F0ZSAoYHByb2Nlc3MuYXJndmApLCBzbyB0aGVcbiAqIHJvc3RlciBjb3VudGVkIGEgMy1saW5lIGZvcndhcmRlciBhcyBhbiBhcmctcGFyc2luZyBlbnRyeSBwb2ludCBhbmQgdGhlblxuICogcmVwb3J0ZWQgdGhlIHNwZWxsJ3MgZG9jdW1lbnRlZCBmbGFncyBhcyBVTlJFU09MVkVEIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS4gS2VlcGluZyBhcmd2IG9uIHRoaXMgc2lkZSBtYWtlcyB0aGUgZW51bWVyYXRvcidzIGFuc3dlciB0cnVlXG4gKiBpbnN0ZWFkIG9mIG1ha2luZyBpdHMgcmVnZXggbG9vc2VyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1biAxLjMuMTQgZmluZGluZyB0aGF0XG4gKiBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuIEl0IGlzIGEgREFFTU9OLXNpZGVcbiAqIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvbiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55XG4gKiBjbGllbnQuIEl0IHN0YXlzIHdoZXJlIGl0IHdhcyBtZWFzdXJlZC5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSByZXR1cm4gY29kZTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldikgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHJldHVybiBjb2RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgVE8gSEFMRiB0aGUgaWRsZSB0aW1lb3V0LlxuICpcbiAqIFRoZSBjbGFtcCBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OiB0aGVcbiAqIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcCBvbmx5IGluXG4gKiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5taW4oaW50T3IocmF3LCBmYWxsYmFjayksIE1hdGgubWF4KDUwMCwgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogQXN0cm9sYWJlJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyBvZiB0aGUgc3BlbGwuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTS4gQmVmb3JlIFBoYXNlIDFiIHRoZXNlIHRocmVlIGV4cHJlc3Npb25zIGV4aXN0ZWRcbiAqIFRXSUNFOiBvbmNlIGluIHRoZSBkYWVtb24sIHdoaWNoIHVzZXMgdGhlbSB0byBjb25maWd1cmUgYEJ1bi5zZXJ2ZWAgYW5kIGl0c1xuICogU1NFIGhlYXJ0YmVhdCwgYW5kIG9uY2UgaGFuZC1taXJyb3JlZCBpbiBgY2xpLnRzYCwgd2hpY2ggbmVlZHMgdGhlIHNhbWVcbiAqIG51bWJlcnMgdG8gc2l6ZSB0aGUgdGFpbCB3YXRjaGRvZy4gQm90aCBjb3BpZXMgY2FycmllZCBhIGNvbW1lbnQgc2F5aW5nIHNvIOKAlFxuICogXCJhbiBlZGl0IHRoZXJlIGlzIGFuIGVkaXQgaGVyZVwiIOKAlCBiZWNhdXNlIHRoZSBDTEkgY291bGQgbm90IGltcG9ydCB0aGUgZGFlbW9uXG4gKiB3aXRob3V0IGRyYWdnaW5nIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLlxuICpcbiAqIEEgbW9kdWxlIHdpdGggbm8gaW1wb3J0cyBidXQgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoIGdyYXBoLCBzbyBib3RoXG4gKiBoYWx2ZXMgaW1wb3J0IGl0IGFuZCB0aGUgbWlycm9yaW5nIGlzIGdvbmUuIFRoaXMgaXMgdGhlIHBoYXNlJ3MgY2xlYW5lc3RcbiAqIHByb29mIHRoYXQgdGhlIHNlYW0gaXMgcmVhbDogYSB2YWx1ZSB0aGF0IGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIGl0LlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBtaXJyb3JpbmdcbiAqIGNvbWVzIGJhY2sgd2l0aCBpdC5cbiAqL1xuXG5pbXBvcnQgeyBoZWFydGJlYXRNcywgaWRsZVRpbWVvdXRTZWMsIHRhaWxJZGxlTXMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBIZWxkIFNTRSBhbmQgV1MgY29ubmVjdGlvbnMgZGllIHdpdGhvdXQgdGhpcyDigJQgc2VlIGBraXQvd2lyZS9oZWFydGJlYXQudHNgLlxuICogIEVudi10dW5hYmxlIGJlY2F1c2UgdGhlIGRhZW1vbidzIG93biB0ZXN0cyBkcml2ZSBhIHNob3J0IHdpbmRvdy4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMocHJvY2Vzcy5lbnYuQVNUUk9MQUJFX0lETEVfVElNRU9VVCk7XG5cbi8qKiBBc3Ryb2xhYmUgYmVhdHMgZmFzdGVyIHRoYW4gdGhlIGhvdXNlIGRlZmF1bHQgKDEwIHMsIG5vdCAxNSBzKSBiZWNhdXNlXG4gKiAgYGpvaW5gIGNhcnJpZXMgUFJFU0VOQ0U6IGEgY2FyZCBpbiBhIGh1bWFuJ3MgdmlldyBnb2VzIGlkbGUgd2hlbiB0aGUgdGFpbFxuICogIGRyb3BzLCBzbyB0aGlzIHNwZWxsIGJ1eXMgYSB3aWRlciBtYXJnaW4gYWdhaW5zdCB0aGUgaWRsZSB0aW1lb3V0IHRoYW4gdGhlXG4gKiAgc2Vzc2lvbiBzcGVsbHMgbmVlZC4gQ2xhbXBlZCB0byBoYWxmIHRoZSBpZGxlIHRpbWVvdXQgZm9yIGFueSBjb25maWd1cmVkXG4gKiAgdmFsdWUsIHdoaWNoIGlzIHRoZSBpbnZhcmlhbnQgdGhlIGNsYW1wIGV4aXN0cyB0byBob2xkLiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuQVNUUk9MQUJFX0hFQVJUQkVBVF9NUyxcbiAgSURMRV9USU1FT1VUX1NFQyxcbiAgMTBfMDAwLFxuKTtcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQgcmF0aGVyIHRoYW4gY2hvc2VuLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBa0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDaEJPLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUlJLE1BQU0saUJBQWlCLE1BQU07QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUVULFdBQVcsQ0FBQyxNQUFlLFNBQWlCLE9BQWtCO0FBQUEsSUFDNUQsTUFBTSxPQUFPO0FBQUEsSUFDYixLQUFLLE9BQU87QUFBQSxJQUNaLEtBQUssT0FBTztBQUFBLElBQ1osS0FBSyxRQUFRO0FBQUE7QUFBQSxNQUdYLFFBQVEsR0FBVztBQUFBLElBQ3JCLE9BQU8sU0FBUyxLQUFLO0FBQUE7QUFFekI7QUFLTyxTQUFTLEdBQUcsQ0FBQyxTQUFpQixPQUFnQixTQUFTLE9BQXlCO0FBQUEsRUFDckYsTUFBTSxJQUFJLFNBQVMsTUFBTSxTQUFTLEtBQUs7QUFBQTtBQVNsQyxTQUFTLGNBQWMsQ0FDNUIsR0FDQSxNQUF5QyxRQUFRLFFBQ2xDO0FBQUEsRUFDZixJQUFJLEVBQUUsYUFBYTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQ3JDLElBQUksTUFBTSxjQUFjLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUNuRCxPQUFPLEVBQUU7QUFBQTs7O0FDOEZYLElBQU0sa0JBQWtCO0FBQ3hCLElBQU0sZ0JBQWdCLEVBQUUsV0FBVyxLQUFLLE9BQU8sS0FBSztBQVU3QyxTQUFTLGFBQWEsQ0FBQyxPQUErRDtBQUFBLEVBQzNGLE1BQU0sV0FBcUIsQ0FBQztBQUFBLEVBQzVCLE1BQU0sWUFBc0IsQ0FBQztBQUFBLEVBQzdCLElBQUksUUFBUTtBQUFBLEVBQ1osSUFBSSxVQUFVO0FBQUEsRUFFZCxXQUFXLFFBQVEsTUFBTSxNQUFNO0FBQUEsQ0FBSSxHQUFHO0FBQUEsSUFDcEMsSUFBSSxTQUFTO0FBQUEsTUFBSTtBQUFBLElBQ2pCLElBQUksS0FBSyxXQUFXLEdBQUcsR0FBRztBQUFBLE1BQ3hCLFNBQVMsS0FBSyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDM0I7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLFFBQVEsS0FBSyxRQUFRLEdBQUc7QUFBQSxJQUM5QixNQUFNLFFBQVEsVUFBVSxLQUFLLE9BQU8sS0FBSyxNQUFNLEdBQUcsS0FBSztBQUFBLElBQ3ZELElBQUksUUFBUSxVQUFVLEtBQUssS0FBSyxLQUFLLE1BQU0sUUFBUSxDQUFDO0FBQUEsSUFDcEQsSUFBSSxNQUFNLFdBQVcsR0FBRztBQUFBLE1BQUcsUUFBUSxNQUFNLE1BQU0sQ0FBQztBQUFBLElBQ2hELElBQUksVUFBVSxRQUFRO0FBQUEsTUFDcEIsVUFBVSxLQUFLLEtBQUs7QUFBQSxNQUNwQixVQUFVO0FBQUEsSUFDWixFQUFPLFNBQUksVUFBVSxTQUFTO0FBQUEsTUFDNUIsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUVGO0FBQUEsRUFFQSxJQUFJLENBQUM7QUFBQSxJQUFTLE9BQU8sRUFBRSxPQUFPLE1BQU0sU0FBUztBQUFBLEVBQzdDLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxNQUFNLFVBQVUsS0FBSztBQUFBLENBQUksRUFBRSxHQUFHLFNBQVM7QUFBQTtBQVVsRSxlQUFzQixVQUFjLENBQUMsTUFBd0M7QUFBQSxFQUMzRSxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLFNBQVMsS0FBSyxVQUFVO0FBQUEsRUFDOUIsTUFBTSxRQUFRLEtBQUssU0FBUztBQUFBLEVBQzVCLE1BQU0sZUFBZSxLQUFLLGdCQUFnQjtBQUFBLEVBRTFDLElBQUksU0FBUyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxRQUF1QjtBQUFBLEVBQzNCLElBQUksZUFBZTtBQUFBLEVBQ25CLElBQUksZ0JBQWdCO0FBQUEsRUFDcEIsSUFBSSxlQUFlO0FBQUEsRUFDbkIsSUFBSSxRQUFRLE1BQU07QUFBQSxFQUNsQixJQUFJLE9BQU87QUFBQSxFQWdCWCxJQUFJLFVBQVU7QUFBQSxFQUNkLElBQUksVUFBa0M7QUFBQSxFQUN0QyxJQUFJLGNBQW1DO0FBQUEsRUFDdkMsTUFBTSxPQUFPLENBQUMsYUFBcUI7QUFBQSxJQUNqQyxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxTQUFTLE1BQU07QUFBQSxJQUNmLGNBQWM7QUFBQTtBQUFBLEVBSWhCLE1BQU0sVUFBVSxDQUFDLE9BQ2YsSUFBSSxRQUFjLENBQUMsaUJBQWlCO0FBQUEsSUFDbEMsSUFBSTtBQUFBLE1BQVMsT0FBTyxhQUFhO0FBQUEsSUFDakMsTUFBTSxTQUFTLE1BQU07QUFBQSxNQUNuQixhQUFhLEtBQUs7QUFBQSxNQUNsQixjQUFjO0FBQUEsTUFDZCxhQUFhO0FBQUE7QUFBQSxJQUVmLE1BQU0sUUFBUSxXQUFXLFFBQVEsRUFBRTtBQUFBLElBQ25DLGNBQWM7QUFBQSxHQUNmO0FBQUEsRUFFSCxNQUFNLFdBQVcsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUM3QixNQUFNLGFBQWEsS0FBSyxZQUFZO0FBQUEsRUFDcEMsSUFBSSxZQUFZO0FBQUEsSUFDZCxRQUFRLEdBQUcsVUFBVSxRQUFRO0FBQUEsSUFDN0IsUUFBUSxHQUFHLFdBQVcsUUFBUTtBQUFBLEVBQ2hDO0FBQUEsRUFJQSxNQUFNLGFBQWEsQ0FBQyxNQUFlO0FBQUEsSUFDakMsSUFBSyxHQUF5QyxTQUFTO0FBQUEsTUFBUyxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRXhFLE1BQU0sYUFBYTtBQUFBLEVBSW5CLFdBQVcsS0FBSyxTQUFTLFVBQVU7QUFBQSxFQUVuQyxNQUFNLGdCQUFnQixNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ2xDLEtBQUssUUFBUSxpQkFBaUIsU0FBUyxhQUFhO0FBQUEsRUFDcEQsSUFBSSxLQUFLLFFBQVE7QUFBQSxJQUFTLEtBQUssQ0FBQztBQUFBLEVBRWhDLE1BQU0sT0FBTyxDQUFDLFNBQWlCO0FBQUEsSUFDN0IsSUFBSSxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUE7QUFBQSxFQUl2QixNQUFNLE9BQU8sQ0FBQyxTQUFvQztBQUFBLElBQ2hELElBQUksU0FBUyxRQUFRLFNBQVM7QUFBQSxNQUFXLElBQUksTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBO0FBQUEsRUFHaEUsSUFBSTtBQUFBLElBQ0YsT0FBTyxDQUFDLFNBQVM7QUFBQSxNQU1mLE1BQU0sT0FBTyxNQUFNLEtBQUssUUFBUTtBQUFBLE1BQ2hDLElBQUksU0FBUyxNQUFNO0FBQUEsUUFDakIsTUFBTSxVQUFVLEtBQUssZUFBZSxFQUFFLGNBQWMsY0FBYyxDQUFDLEtBQUs7QUFBQSxRQUN4RSxJQUFJLFlBQVk7QUFBQSxVQUFRLE9BQU87QUFBQSxRQUMvQixNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxRQUN2QztBQUFBLE1BQ0Y7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUVmLE1BQU0sU0FBUyxLQUFLLFFBQVEsUUFBUSxZQUFZLEtBQUssRUFBRSxPQUFPLE9BQU8sTUFBTSxFQUFFO0FBQUEsTUFDN0UsTUFBTSxLQUFLLElBQUksZ0JBQWdCLE1BQU0sRUFBRSxTQUFTO0FBQUEsTUFDaEQsTUFBTSxNQUFNLEdBQUcsT0FBTyxLQUFLLE9BQU8sS0FBSyxJQUFJLE9BQU87QUFBQSxNQUVsRCxVQUFVLElBQUk7QUFBQSxNQUNkLE1BQU0sYUFBYTtBQUFBLE1BQ25CLElBQUksV0FBaUQ7QUFBQSxNQUNyRCxNQUFNLGdCQUFnQixNQUFNO0FBQUEsUUFDMUIsSUFBSSxVQUFVO0FBQUEsVUFBRztBQUFBLFFBQ2pCLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsV0FBVyxXQUFXLE1BQU0sV0FBVyxNQUFNLEdBQUcsTUFBTTtBQUFBO0FBQUEsTUFVeEQsSUFBSTtBQUFBLE1BQ0osSUFBSTtBQUFBLFFBQ0YsTUFBTSxNQUFNLE1BQU0sS0FBSyxFQUFFLFFBQVEsV0FBVyxPQUFPLENBQUM7QUFBQSxRQUNwRCxPQUFPLEdBQUc7QUFBQSxRQUNWLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsVUFBVTtBQUFBLFFBQ1YsSUFBSTtBQUFBLFVBQVM7QUFBQSxRQUNiLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxrQkFBa0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFFBQy9ELE1BQU0sUUFBUSxLQUFLO0FBQUEsUUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFFBQ3ZDO0FBQUE7QUFBQSxNQUdGLElBQUk7QUFBQSxRQUNGLElBQUksQ0FBQyxJQUFJLElBQUk7QUFBQSxVQUVYLE1BQU0sS0FBSyxjQUFjLEdBQUc7QUFBQSxVQUs1QixNQUFNLElBQUksTUFBTSxPQUFPLEVBQUUsTUFBTSxNQUFNLEVBQUU7QUFBQSxVQUN2QyxLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sUUFBUSxRQUFRLElBQUksT0FBTyxDQUFDLENBQUM7QUFBQSxVQUMvRCxNQUFNLFFBQVEsS0FBSztBQUFBLFVBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxVQUN2QztBQUFBLFFBQ0Y7QUFBQSxRQUNBLElBQUksQ0FBQyxJQUFJLE1BQU07QUFBQSxVQUliLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxXQUFXLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQztBQUFBLFVBQ2xFLE1BQU0sUUFBUSxLQUFLO0FBQUEsVUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFVBQ3ZDO0FBQUEsUUFDRjtBQUFBLFFBRUEsZ0JBQWdCO0FBQUEsUUFDaEIsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLFFBRWQsTUFBTSxTQUFTLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDbEMsTUFBTSxVQUFVLElBQUk7QUFBQSxRQUNwQixJQUFJLE1BQU07QUFBQSxRQUVWLE9BQU8sQ0FBQyxTQUFTO0FBQUEsVUFDZixJQUFJO0FBQUEsVUFDSixJQUFJO0FBQUEsWUFDRixRQUFRLE1BQU0sT0FBTyxLQUFLO0FBQUEsWUFDMUIsT0FBTyxHQUFHO0FBQUEsWUFHVixJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxnQkFBZ0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFlBQzNFO0FBQUE7QUFBQSxVQUVGLElBQUksTUFBTSxNQUFNO0FBQUEsWUFDZCxJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxhQUFhLENBQUMsQ0FBQztBQUFBLFlBQy9EO0FBQUEsVUFDRjtBQUFBLFVBVUEsUUFBUSxNQUFNO0FBQUEsVUFLZCxjQUFjO0FBQUEsVUFDZCxPQUFPLFFBQVEsT0FBTyxNQUFNLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUFBLFVBRW5ELFNBQVMsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sRUFBRyxPQUFPLEdBQUcsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sR0FBRztBQUFBLFlBQ3ZFLE1BQU0sUUFBUSxJQUFJLE1BQU0sR0FBRyxHQUFHO0FBQUEsWUFDOUIsTUFBTSxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQUEsWUFDdkIsUUFBUSxPQUFPLGFBQWEsY0FBYyxLQUFLO0FBQUEsWUFDL0MsV0FBVyxRQUFRO0FBQUEsY0FBVSxLQUFLLEtBQUssWUFBWSxJQUFJLENBQUM7QUFBQSxZQUN4RCxJQUFJLENBQUM7QUFBQSxjQUFPO0FBQUEsWUFFWixJQUFJO0FBQUEsWUFDSixJQUFJO0FBQUEsY0FDRixLQUFLLEtBQUssTUFBTSxNQUFNLElBQUk7QUFBQSxjQUMxQixPQUFPLEdBQUc7QUFBQSxjQUNWLEtBQUssS0FBSyxjQUFjLE9BQU8sQ0FBQyxDQUFDO0FBQUEsY0FDakM7QUFBQTtBQUFBLFlBR0YsSUFBSSxLQUFLLFNBQVM7QUFBQSxjQUNoQixNQUFNLE9BQU8sS0FBSyxRQUFRLEVBQUU7QUFBQSxjQUM1QixJQUFJLE9BQU8sU0FBUyxVQUFVO0FBQUEsZ0JBQzVCLElBQUksVUFBVSxRQUFRLFNBQVMsT0FBTztBQUFBLGtCQUNwQyxTQUFTO0FBQUEsa0JBQ1QsTUFBTSxPQUFPLEtBQUssZ0JBQWdCLElBQUksS0FBSztBQUFBLGtCQUMzQyxJQUFJLFNBQVM7QUFBQSxvQkFBTSxLQUFLLElBQUk7QUFBQSxnQkFDOUI7QUFBQSxnQkFDQSxRQUFRO0FBQUEsY0FDVjtBQUFBLFlBQ0Y7QUFBQSxZQU1BLE1BQU0sSUFBSSxLQUFLLFdBQVcsRUFBRTtBQUFBLFlBQzVCLElBQUksT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLENBQUMsR0FBRztBQUFBLGNBQy9DLFNBQVMsaUJBQWlCLFdBQVcsSUFBSSxLQUFLLElBQUksUUFBUSxDQUFDO0FBQUEsWUFDN0Q7QUFBQSxZQUVBLE1BQU0sV0FBVyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUs7QUFBQSxZQUM3QyxNQUFNLGFBQWEsS0FBSyxXQUFXLEVBQUUsS0FBSztBQUFBLFlBRTFDLElBQUksWUFBYSxjQUFjLEtBQUssMEJBQTBCLE1BQU87QUFBQSxjQUNuRSxNQUFNLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxJQUFJLEtBQUssSUFBSSxNQUFNO0FBQUEsY0FDMUQsSUFBSSxTQUFTO0FBQUEsZ0JBQU0sS0FBSyxJQUFJO0FBQUEsWUFDOUI7QUFBQSxZQUNBLElBQUk7QUFBQSxjQUFZLE9BQU87QUFBQSxVQUN6QjtBQUFBLFFBQ0Y7QUFBQSxnQkFDQTtBQUFBLFFBQ0EsSUFBSSxhQUFhO0FBQUEsVUFBTSxhQUFhLFFBQVE7QUFBQSxRQUM1QyxVQUFVO0FBQUE7QUFBQSxNQUdaLElBQUk7QUFBQSxRQUFTO0FBQUEsTUFRYixNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxJQUN6QztBQUFBLElBQ0EsT0FBTztBQUFBLFlBQ1A7QUFBQSxJQUNBLElBQUksWUFBWTtBQUFBLE1BQ2QsUUFBUSxJQUFJLFVBQVUsUUFBUTtBQUFBLE1BQzlCLFFBQVEsSUFBSSxXQUFXLFFBQVE7QUFBQSxJQUNqQztBQUFBLElBQ0EsV0FBVyxNQUFNLFNBQVMsVUFBVTtBQUFBLElBQ3BDLEtBQUssUUFBUSxvQkFBb0IsU0FBUyxhQUFhO0FBQUE7QUFBQTs7O0FDeGdCcEQsSUFBTSx1QkFBdUI7QUFHN0IsSUFBTSx1QkFBdUI7QUFPN0IsSUFBTSxlQUFlO0FBSTVCLFNBQVMsS0FBSyxDQUFDLEtBQXlCLFVBQTBCO0FBQUEsRUFDaEUsTUFBTSxJQUFJLE9BQU8sU0FBUyxPQUFPLElBQUksRUFBRTtBQUFBLEVBQ3ZDLE9BQU8sT0FBTyxTQUFTLENBQUMsS0FBSyxJQUFJLElBQUksSUFBSTtBQUFBO0FBSXBDLFNBQVMsY0FBYyxDQUFDLEtBQTBCLFdBQVcsc0JBQThCO0FBQUEsRUFDaEcsT0FBTyxLQUFLLElBQUksR0FBRyxLQUFLLElBQUksc0JBQXNCLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQztBQUFBO0FBWWxFLFNBQVMsV0FBVyxDQUN6QixLQUNBLFNBQ0EsV0FBVyxzQkFDSDtBQUFBLEVBQ1IsT0FBTyxLQUFLLElBQUksTUFBTSxLQUFLLFFBQVEsR0FBRyxLQUFLLElBQUksS0FBSyxLQUFLLE1BQU8sVUFBVSxPQUFRLENBQUMsQ0FBQyxDQUFDO0FBQUE7QUFJaEYsU0FBUyxVQUFVLENBQUMsUUFBd0I7QUFBQSxFQUNqRCxPQUFPLFNBQVM7QUFBQTs7O0FDeERYLElBQU0sbUJBQW1CLGVBQWUsUUFBUSxJQUFJLHNCQUFzQjtBQU8xRSxJQUFNLG1CQUFtQixZQUM5QixRQUFRLElBQUksd0JBQ1osa0JBQ0EsR0FDRjtBQUdPLElBQU0sZUFBZSxXQUFXLGdCQUFnQjs7O0FMT3ZELElBQU0sYUFBYSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFRekQsSUFBTSxnQkFBZ0IsS0FBSyxZQUFZLE1BQU0sV0FBVyxXQUFXO0FBQ25FLElBQU0sYUFBYSxLQUFLLFlBQVksSUFBSTtBQUN4QyxJQUFNLFdBQVcsS0FBSyxZQUFZLE1BQU07QUFTeEMsSUFBTSxjQUFjLEtBQUssWUFBWSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sT0FBTyxXQUFXO0FBRXJGLFNBQVMsU0FBUyxHQUFXO0FBQUEsRUFDM0IsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBVyxPQUFPO0FBQUEsRUFDN0QsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBTyxPQUFPO0FBQUEsRUFDekQsT0FBTyxXQUFXLEtBQUssVUFBVSxZQUFZLENBQUMsSUFBSSxhQUFhO0FBQUE7QUFFakUsSUFBTSxpQkFBaUIsUUFBUSxJQUFJLGtCQUFrQixLQUFLLFFBQVEsR0FBRyxZQUFZO0FBQ2pGLElBQU0sWUFBWSxLQUFLLGdCQUFnQixhQUFhO0FBeUJwRCxJQUFNLFFBQVEsQ0FBQyxPQUFlLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQztBQU1sRSxTQUFTLFNBQVMsQ0FBQyxPQUE2RDtBQUFBLEVBQzlFLE1BQU0sSUFBSSxNQUFNLE1BQU0sTUFBTTtBQUFBLEVBQzVCLElBQUksT0FBTyxNQUFNLFlBQVksRUFBRSxLQUFLO0FBQUEsSUFBRyxPQUFPLEVBQUUsS0FBSztBQUFBLEVBQ3JELE1BQU0sTUFBTSxRQUFRLElBQUk7QUFBQSxFQUN4QixPQUFPLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJO0FBQUE7QUFHcEMsZUFBZSxTQUFTLEdBQW9CO0FBQUEsRUFDMUMsTUFBTSxTQUF1QixDQUFDO0FBQUEsRUFDOUIsaUJBQWlCLFNBQVMsSUFBSSxNQUFNLE9BQU87QUFBQSxJQUFHLE9BQU8sS0FBSyxLQUFLO0FBQUEsRUFDL0QsT0FBTyxPQUFPLE9BQU8sTUFBTSxFQUFFLFNBQVMsTUFBTSxFQUFFLEtBQUs7QUFBQTtBQUtyRCxlQUFlLFFBQVEsR0FBMkI7QUFBQSxFQUNoRCxJQUFJO0FBQUEsSUFDRixNQUFNLElBQUksT0FBTyxVQUFVLE1BQU0sSUFBSSxLQUFLLFNBQVMsRUFBRSxLQUFLLEdBQUcsS0FBSyxHQUFHLEVBQUU7QUFBQSxJQUN2RSxPQUFPLElBQUksSUFBSSxJQUFJO0FBQUEsSUFDbkIsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBO0FBQUE7QUFJWCxlQUFlLElBQUksQ0FBQyxNQUFnQztBQUFBLEVBQ2xELElBQUk7QUFBQSxJQUNGLFFBQVEsTUFBTSxNQUFNLG9CQUFvQixZQUFZLEdBQUc7QUFBQSxJQUN2RCxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUE7QUFBQTtBQU1YLGVBQWUsWUFBWSxHQUE0QztBQUFBLEVBQ3JFLE1BQU0sV0FBVyxNQUFNLFNBQVM7QUFBQSxFQUNoQyxJQUFJLFlBQWEsTUFBTSxLQUFLLFFBQVEsR0FBSTtBQUFBLElBQ3RDLE9BQU8sRUFBRSxNQUFNLG9CQUFvQixZQUFZLE1BQU0sU0FBUztBQUFBLEVBQ2hFO0FBQUEsRUFDQSxNQUFNLE9BQU8sTUFBTSxRQUFRLFVBQVUsQ0FBQyxPQUFPLGVBQWUsV0FBVyxHQUFHO0FBQUEsSUFDeEUsVUFBVTtBQUFBLElBQ1YsT0FBTyxDQUFDLFVBQVUsVUFBVSxRQUFRO0FBQUEsSUFDcEMsS0FBSyxRQUFRO0FBQUEsSUFJYixLQUFLLFVBQVU7QUFBQSxFQUNqQixDQUFDO0FBQUEsRUFDRCxLQUFLLE1BQU07QUFBQSxFQUtYLE1BQU0sV0FBVyxLQUFLLElBQUksSUFBSTtBQUFBLEVBQzlCLE9BQU8sS0FBSyxJQUFJLElBQUksVUFBVTtBQUFBLElBQzVCLE1BQU0sTUFBTSxFQUFFO0FBQUEsSUFDZCxNQUFNLElBQUksTUFBTSxTQUFTO0FBQUEsSUFDekIsSUFBSSxLQUFNLE1BQU0sS0FBSyxDQUFDO0FBQUEsTUFBSSxPQUFPLEVBQUUsTUFBTSxvQkFBb0IsS0FBSyxNQUFNLEVBQUU7QUFBQSxFQUM1RTtBQUFBLEVBQ0EsSUFBSSwrQ0FBK0MsVUFBVTtBQUFBO0FBSy9ELGVBQWUsV0FBVyxHQUEyQjtBQUFBLEVBQ25ELE1BQU0sSUFBSSxNQUFNLFNBQVM7QUFBQSxFQUN6QixPQUFPLElBQUksb0JBQW9CLE1BQU07QUFBQTtBQUd2QyxlQUFlLE9BQU8sQ0FBQyxNQUFjLE1BQStCO0FBQUEsRUFDbEUsTUFBTSxNQUFNLE1BQU0sTUFBTSxHQUFHLFlBQVk7QUFBQSxJQUNyQyxRQUFRO0FBQUEsSUFDUixTQUFTLEVBQUUsZ0JBQWdCLG1CQUFtQjtBQUFBLElBQzlDLE1BQU0sS0FBSyxVQUFVLElBQUk7QUFBQSxFQUMzQixDQUFDO0FBQUEsRUFDRCxPQUFRLE1BQU0sSUFBSSxLQUFLO0FBQUE7QUFLekIsZUFBZSxHQUFHLENBQUMsTUFBYyxNQUErQjtBQUFBLEVBQzlELE1BQU0sSUFBSSxNQUFNLFFBQVEsTUFBTSxJQUFJO0FBQUEsRUFhbEMsSUFBSSxDQUFDLEVBQUUsV0FBVyxFQUFFO0FBQUEsSUFBTyxJQUFJLEVBQUUsS0FBSztBQUFBLEVBQ3RDLFVBQVUsQ0FBQztBQUFBO0FBR2IsU0FBUyxXQUFXLENBQUMsS0FBbUI7QUFBQSxFQUN0QyxNQUFNLFNBQ0osUUFBUSxhQUFhLFdBQVcsU0FBUyxRQUFRLGFBQWEsVUFBVSxVQUFVO0FBQUEsRUFDcEYsSUFBSTtBQUFBLElBQ0YsTUFBTSxRQUFRLENBQUMsR0FBRyxHQUFHLEVBQUUsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsTUFBTTtBQUFBLElBQ2hFLE1BQU07QUFBQTtBQTBCVixlQUFlLFlBQVksQ0FBQyxNQUtSO0FBQUEsRUFHbEIsTUFBTSxVQUFVLENBQUMsT0FBVztBQUFBLElBQzFCLElBQUksQ0FBQyxLQUFLO0FBQUEsTUFBUyxPQUFPO0FBQUEsSUFDMUIsSUFBSSxHQUFHLFNBQVMsV0FBVyxHQUFHLFNBQVM7QUFBQSxNQUFVLE9BQU87QUFBQSxJQUN4RCxPQUFPLEdBQUcsY0FBYyxLQUFLO0FBQUE7QUFBQSxFQUcvQixPQUFPLE1BQU0sV0FBZTtBQUFBLElBQzFCLFNBQVM7QUFBQSxJQUNULE1BQU07QUFBQSxJQUNOLE9BQU8sS0FBSztBQUFBLElBQ1osVUFBVSxDQUFDLE9BQU8sR0FBRztBQUFBLElBQ3JCLE9BQU8sQ0FBQyxZQUFZO0FBQUEsTUFDbEIsT0FBTyxPQUFPLE1BQU07QUFBQSxTQUNoQixLQUFLLFVBQVUsRUFBRSxTQUFTLEtBQUssUUFBUSxJQUFJLENBQUM7QUFBQSxJQUNsRDtBQUFBLElBQ0EsUUFBUSxDQUFDLE9BQU8sUUFBUSxFQUFFLEtBQUssRUFBRSxLQUFLLFNBQVMsYUFBYSxHQUFHLE9BQU8sS0FBSztBQUFBLElBQzNFLFVBQVUsQ0FBQyxPQUFPLEdBQUcsU0FBUztBQUFBLElBVTlCLFNBQVMsQ0FBQyxPQUFPLEdBQUc7QUFBQSxJQUNwQixlQUFlLENBQUMsVUFBVSxLQUFLLFVBQVUsRUFBRSxNQUFNLGlCQUFpQixNQUFNLENBQUM7QUFBQSxJQUN6RSxRQUFRO0FBQUEsSUFDUixXQUFXLE1BQU07QUFBQSxFQUNuQixDQUFDO0FBQUE7QUFLSCxlQUFlLE9BQU8sQ0FBQyxPQUF5QztBQUFBLEVBQzlELFFBQVEsU0FBUyxNQUFNLGFBQWE7QUFBQSxFQUNwQyxJQUFJLENBQUMsTUFBTTtBQUFBLElBQVksWUFBWSxvQkFBb0IsTUFBTTtBQUFBLEVBQzdELFVBQVUsRUFBRSxJQUFJLE1BQU0sS0FBSyxvQkFBb0IsUUFBUSxLQUFLLENBQUM7QUFBQTtBQUcvRCxlQUFlLE1BQU0sQ0FBQyxLQUFlLE9BQXlDO0FBQUEsRUFDNUUsTUFBTSxPQUFPLElBQUksS0FBSyxHQUFHLEVBQUUsS0FBSztBQUFBLEVBQ2hDLElBQUksQ0FBQztBQUFBLElBQU0sSUFBSSx5RUFBeUU7QUFBQSxFQUN4RixNQUFNLE9BQU8sT0FBTyxNQUFNLFNBQVMsV0FBVyxNQUFNLEtBQUssS0FBSyxJQUFJO0FBQUEsRUFDbEUsSUFBSSxDQUFDO0FBQUEsSUFBTSxJQUFJLHlCQUF5QjtBQUFBLEVBQ3hDLE1BQU0sY0FBYyxNQUFNLFFBQ3RCLE1BQU0sVUFBVSxJQUNoQixPQUFPLE1BQU0sZ0JBQWdCLFdBQzNCLE1BQU0sY0FDTjtBQUFBLEVBRU4sTUFBTSxTQUFTLE9BQU8sTUFBTSxXQUFXLFdBQVcsTUFBTSxTQUFTO0FBQUEsRUFDakUsTUFBTSxLQUFLLE9BQU8sTUFBTSxPQUFPLFlBQVksTUFBTSxHQUFHLEtBQUssSUFBSSxNQUFNLEdBQUcsS0FBSyxJQUFJO0FBQUEsRUFDL0UsUUFBUSxTQUFTLE1BQU0sYUFBYTtBQUFBLEVBQ3BDLE1BQU0sSUFBSSxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsSUFDTixTQUFTLEVBQUUsSUFBSSxNQUFNLE1BQU0sYUFBYSxPQUFPO0FBQUEsSUFDL0MsSUFBSSxVQUFVLEtBQUs7QUFBQSxFQUNyQixDQUFDO0FBQUE7QUFHSCxlQUFlLFNBQVMsQ0FBQyxLQUFlLE9BQXlDO0FBQUEsRUFDL0UsTUFBTSxLQUFLLElBQUk7QUFBQSxFQUNmLElBQUksQ0FBQztBQUFBLElBQUksSUFBSSxvQkFBb0I7QUFBQSxFQUNqQyxRQUFRLFNBQVMsTUFBTSxhQUFhO0FBQUEsRUFDcEMsTUFBTSxJQUFJLE1BQU0sRUFBRSxNQUFNLGtCQUFrQixJQUFJLElBQUksVUFBVSxLQUFLLEVBQUUsQ0FBQztBQUFBO0FBR3RFLGVBQWUsU0FBUyxDQUFDLEtBQWUsT0FBeUM7QUFBQSxFQUMvRSxNQUFNLEtBQUssSUFBSTtBQUFBLEVBQ2YsSUFBSSxDQUFDO0FBQUEsSUFBSSxJQUFJLHdEQUF3RDtBQUFBLEVBQ3JFLE1BQU0sVUFBVSxNQUFNLFFBQVEsTUFBTSxVQUFVLElBQUksSUFBSSxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsRUFBRSxLQUFLO0FBQUEsRUFDOUUsSUFBSSxDQUFDO0FBQUEsSUFBUyxJQUFJLG1EQUFtRDtBQUFBLEVBQ3JFLE1BQU0sUUFBUSxPQUFPLE1BQU0sVUFBVSxXQUFXLE1BQU0sUUFBUTtBQUFBLEVBQzlELFFBQVEsU0FBUyxNQUFNLGFBQWE7QUFBQSxFQUNwQyxNQUFNLElBQUksTUFBTSxFQUFFLE1BQU0sVUFBVSxJQUFJLFNBQVMsT0FBTyxJQUFJLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQTtBQUc5RSxlQUFlLFlBQVksQ0FBQyxLQUFlLE9BQXlDO0FBQUEsRUFDbEYsTUFBTSxLQUFLLElBQUk7QUFBQSxFQUNmLElBQUksQ0FBQztBQUFBLElBQUksSUFBSSxrREFBa0Q7QUFBQSxFQUMvRCxNQUFNLFNBQVMsTUFBTSxVQUFVO0FBQUEsRUFDL0IsTUFBTSxXQUNKLE9BQU8sTUFBTSxhQUFhLFdBQ3RCLE1BQU0sV0FDTixJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxFQUFFLEtBQUssS0FBSztBQUFBLEVBQ3ZDLFFBQVEsU0FBUyxNQUFNLGFBQWE7QUFBQSxFQUNwQyxNQUFNLElBQUksTUFBTSxFQUFFLE1BQU0sYUFBYSxJQUFJLFFBQVEsVUFBVSxJQUFJLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQTtBQUduRixlQUFlLE9BQU8sQ0FBQyxLQUFlLE9BQXlDO0FBQUEsRUFDN0UsTUFBTSxLQUFLLElBQUk7QUFBQSxFQUNmLElBQUksQ0FBQztBQUFBLElBQUksSUFBSSxrQkFBa0I7QUFBQSxFQUMvQixRQUFRLFNBQVMsTUFBTSxhQUFhO0FBQUEsRUFDcEMsTUFBTSxJQUFJLE1BQU0sRUFBRSxNQUFNLFFBQVEsSUFBSSxJQUFJLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQTtBQUc1RCxlQUFlLFFBQVEsR0FBRztBQUFBLEVBQ3hCLE1BQU0sT0FBTyxNQUFNLFlBQVk7QUFBQSxFQUMvQixJQUFJLENBQUMsUUFBUSxDQUFFLE1BQU0sS0FBSyxPQUFPLFNBQVMsS0FBSyxNQUFNLEdBQUcsRUFBRSxJQUFJLEdBQWEsRUFBRSxDQUFDLEdBQUk7QUFBQSxJQUNoRixVQUFVLEVBQUUsSUFBSSxNQUFNLFNBQVMsT0FBTyxPQUFPLEVBQUUsT0FBTyxlQUFlLFVBQVUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztBQUFBLElBQ3JGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTSxNQUFNLE1BQU0sTUFBTSxHQUFHLFlBQVk7QUFBQSxFQUN2QyxJQUFJLENBQUMsSUFBSTtBQUFBLElBQUksSUFBSSxzQkFBc0IsSUFBSSxTQUFTO0FBQUEsRUFDcEQsVUFBVSxNQUFNLElBQUksS0FBSyxDQUFDO0FBQUE7QUFHNUIsZUFBZSxPQUFPLEdBQUc7QUFBQSxFQUN2QixNQUFNLE9BQU8sTUFBTSxZQUFZO0FBQUEsRUFJL0IsSUFBSSxDQUFDLFFBQVEsQ0FBRSxNQUFNLEtBQUssT0FBTyxTQUFTLEtBQUssTUFBTSxHQUFHLEVBQUUsSUFBSSxHQUFhLEVBQUUsQ0FBQyxHQUFJO0FBQUEsSUFDaEYsVUFBVSxFQUFFLElBQUksTUFBTSxTQUFTLE9BQU8sVUFBVSxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQ3BEO0FBQUEsRUFDRjtBQUFBLEVBQ0EsUUFBUSxVQUFXLE9BQU8sTUFBTSxNQUFNLEdBQUcsWUFBWSxHQUFHLEtBQUs7QUFBQSxFQUc3RCxVQUFVO0FBQUEsSUFDUixJQUFJO0FBQUEsSUFDSixTQUFTO0FBQUEsSUFDVCxVQUFVLE1BQU0sU0FBUyxJQUFJLENBQUMsT0FBTztBQUFBLE1BQ25DLElBQUksRUFBRTtBQUFBLE1BQ04sTUFBTSxFQUFFO0FBQUEsTUFDUixNQUFNLEVBQUU7QUFBQSxNQUNSLFdBQVcsRUFBRTtBQUFBLElBQ2YsRUFBRTtBQUFBLEVBQ0osQ0FBQztBQUFBO0FBR0gsZUFBZSxRQUFRLENBQUMsT0FBeUM7QUFBQSxFQUMvRCxNQUFNLE9BQU8sTUFBTSxZQUFZO0FBQUEsRUFDL0IsSUFBSSxDQUFDLE1BQU07QUFBQSxJQUNULFVBQVUsRUFBRSxJQUFJLE1BQU0sU0FBUyxPQUFPLE9BQU8sb0JBQW9CLENBQUM7QUFBQSxJQUNsRTtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFVBQVUsTUFBTSxRQUFRLE1BQU0sRUFBRSxNQUFNLFNBQVMsSUFBSSxVQUFVLEtBQUssRUFBRSxDQUFDLENBQUM7QUFBQTtBQUd4RSxlQUFlLE9BQU8sR0FBRztBQUFBLEVBQ3ZCLE1BQU0sT0FBTyxNQUFNLFNBQVM7QUFBQSxFQUM1QixJQUFJLFFBQVMsTUFBTSxLQUFLLElBQUksR0FBSTtBQUFBLElBQzlCLFVBQVUsRUFBRSxJQUFJLE1BQU0sU0FBUyxNQUFNLEtBQUssb0JBQW9CLFFBQVEsS0FBSyxDQUFDO0FBQUEsRUFDOUUsRUFBTztBQUFBLElBQ0wsVUFBVSxFQUFFLElBQUksTUFBTSxTQUFTLE1BQU0sQ0FBQztBQUFBO0FBQUE7QUFJMUMsSUFBTSxPQUFPO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBK0JiLGVBQWUsV0FBVyxHQUErQztBQUFBLEVBQ3ZFLElBQUk7QUFBQSxJQUNGLE1BQU0sTUFBTSxNQUFNLElBQUksS0FBSyxLQUFLLFlBQVkscUNBQXFDLENBQUMsRUFBRSxLQUFLO0FBQUEsSUFDekYsSUFBSSxPQUFPLEtBQUssWUFBWTtBQUFBLE1BQVUsT0FBTyxFQUFFLE1BQU0sYUFBYSxTQUFTLElBQUksUUFBUTtBQUFBLElBQ3ZGLE1BQU07QUFBQSxFQUNSLE9BQU8sRUFBRSxNQUFNLGFBQWEsU0FBUyxVQUFVO0FBQUE7QUFhakQsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sU0FBUyxJQUFJO0FBQUEsSUFDMUIsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQU8sZUFBZSxDQUFDO0FBQUEsSUFDN0IsSUFBSSxTQUFTO0FBQUEsTUFBTSxNQUFNO0FBQUEsSUFDekIsT0FBTztBQUFBO0FBQUE7QUFJWCxlQUFlLFFBQVEsQ0FBQyxNQUFpQztBQUFBLEVBQ3ZELE1BQU0sT0FBTyxLQUFLO0FBQUEsRUFDbEIsa0JBQWtCLFFBQVEsSUFBSTtBQUFBLEVBRzlCLElBQUksU0FBUztBQUFBLElBQVcsSUFBSSxpQ0FBNEI7QUFBQSxFQUN4RCxJQUFJLFNBQVMsVUFBVSxTQUFTLFlBQVksU0FBUyxNQUFNO0FBQUEsSUFDekQsUUFBUSxPQUFPLE1BQU0sR0FBRztBQUFBLENBQVE7QUFBQSxJQUNoQyxPQUFPO0FBQUEsRUFDVDtBQUFBLEVBR0EsSUFBSSxTQUFTLGVBQWUsU0FBUyxRQUFRLFNBQVMsV0FBVztBQUFBLElBQy9ELFVBQVUsTUFBTSxZQUFZLENBQUM7QUFBQSxJQUM3QixPQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsU0FBUyxVQUFVO0FBQUEsTUFDakIsTUFBTSxLQUFLLE1BQU0sQ0FBQztBQUFBLE1BQ2xCLFNBQVM7QUFBQSxRQUNQLElBQUksRUFBRSxNQUFNLFNBQVM7QUFBQSxRQUNyQixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsUUFDdkIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLFFBQ3ZCLGFBQWEsRUFBRSxNQUFNLFNBQVM7QUFBQSxRQUM5QixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsUUFDekIsSUFBSSxFQUFFLE1BQU0sU0FBUztBQUFBLFFBQ3JCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxRQUN4QixVQUFVLEVBQUUsTUFBTSxTQUFTO0FBQUEsUUFDM0IsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLFFBQ3hCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxRQUMxQixPQUFPLEVBQUUsTUFBTSxXQUFXLFNBQVMsTUFBTTtBQUFBLFFBQ3pDLE9BQU8sRUFBRSxNQUFNLFdBQVcsU0FBUyxNQUFNO0FBQUEsUUFDekMsV0FBVyxFQUFFLE1BQU0sV0FBVyxTQUFTLE1BQU07QUFBQSxNQUMvQztBQUFBLE1BQ0EsUUFBUTtBQUFBLE1BQ1Isa0JBQWtCO0FBQUEsSUFDcEIsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFDVixJQUFJLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDLENBQUM7QUFBQTtBQUFBLEVBRWhELE1BQU0sUUFBUSxPQUFPO0FBQUEsRUFDckIsTUFBTSxNQUFNLE9BQU87QUFBQSxFQUNuQixNQUFNLFFBQVEsT0FBTyxNQUFNLFVBQVUsV0FBVyxPQUFPLFNBQVMsTUFBTSxPQUFPLEVBQUUsSUFBSTtBQUFBLEVBRW5GLFFBQVE7QUFBQSxTQUNEO0FBQUEsTUFDSCxNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ25CLE9BQU87QUFBQSxTQUNKO0FBQUEsTUFDSCxNQUFNLE9BQU8sS0FBSyxLQUFLO0FBQUEsTUFDdkIsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sVUFBVSxLQUFLLEtBQUs7QUFBQSxNQUMxQixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxVQUFVLEtBQUssS0FBSztBQUFBLE1BQzFCLE9BQU87QUFBQSxTQUNKO0FBQUEsTUFDSCxNQUFNLGFBQWEsS0FBSyxLQUFLO0FBQUEsTUFDN0IsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sUUFBUSxLQUFLLEtBQUs7QUFBQSxNQUN4QixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxTQUFTO0FBQUEsTUFDZixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxRQUFRO0FBQUEsTUFDZCxPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxTQUFTLEtBQUs7QUFBQSxNQUNwQixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxRQUFRO0FBQUEsTUFDZCxPQUFPO0FBQUEsU0FDSixRQUFRO0FBQUEsTUFDWCxNQUFNLEtBQUssSUFBSTtBQUFBLE1BQ2YsSUFBSSxDQUFDO0FBQUEsUUFBSSxJQUFJLDRDQUE0QztBQUFBLE1BQ3pELFFBQVEsU0FBUyxNQUFNLGFBQWE7QUFBQSxNQUdwQyxRQUFRLFVBQVcsT0FBTyxNQUFNLE1BQU0sR0FBRyxZQUFZLEdBQUcsS0FBSztBQUFBLE1BRzdELElBQUksQ0FBQyxNQUFNLFNBQVMsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxRQUN6QyxJQUFJLG9CQUFvQiw4QkFBeUI7QUFBQSxNQUNuRCxPQUFPLE1BQU0sYUFBYSxFQUFFLE9BQU8sU0FBUyxJQUFJLFNBQVMsSUFBSSxNQUFNLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQSxJQUN2RjtBQUFBLFNBQ0ssUUFBUTtBQUFBLE1BR1gsTUFBTSxhQUFhO0FBQUEsTUFDbkIsT0FBTyxNQUFNLGFBQWEsRUFBRSxPQUFPLE1BQU0sVUFBVSxLQUFLLEVBQUUsQ0FBQztBQUFBLElBQzdEO0FBQUE7QUFBQSxNQUVFLElBQUksaUJBQWlCLHlCQUFvQjtBQUFBO0FBQUE7QUFJL0MsSUFBSSxrQkFBa0I7QUFBQSxFQVFwQixRQUFRLFdBQVcsTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUNyRDtBQXFCQSxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJGMTRBN0M3M0ZENENGMDkxNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
