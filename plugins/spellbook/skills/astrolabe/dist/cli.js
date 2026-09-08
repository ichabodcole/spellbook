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
var IDLE_TIMEOUT_SEC = Math.max(1, Math.min(255, Number.parseInt(process.env.ASTROLABE_IDLE_TIMEOUT ?? "255", 10) || 255));
var SSE_HEARTBEAT_MS = Math.min(Number.parseInt(process.env.ASTROLABE_HEARTBEAT_MS ?? "10000", 10) || 1e4, Math.max(500, Math.floor(IDLE_TIMEOUT_SEC * 1000 / 2)));
var TAIL_IDLE_MS = SSE_HEARTBEAT_MS * 3;
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

//# debugId=E18DE674B402173C64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gYXN0cm9sYWJlIENMSSDigJQgdGhpbiwgc3RhdGVsZXNzIHdyYXBwZXIgYXJvdW5kIHRoZSBzdGFuZGluZyBvYnNlcnZhdG9yeVxuLy8gZGFlbW9uJ3MgSFRUUCBzdXJmYWNlIChzZXJ2ZXIudHMpLiBUaGUgYWdlbnQgZHJpdmVzIHRoZSBib2FyZCB0aHJvdWdoIHRoZXNlXG4vLyB2ZXJiczsgYGpvaW5gL2B0YWlsYCBzdHJlYW0gZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAuXG4vL1xuLy8gRGlzY292ZXJ5ICsgbGlmZWN5Y2xlOiBhIFNJTkdMRVRPTiBkYWVtb24gcGVyICRBU1RST0xBQkVfSE9NRS4gVGhlIGZpcnN0IHZlcmJcbi8vIHRoYXQgbmVlZHMgaXQgYXV0by1zcGF3bnMgaXQgKGRldGFjaGVkLCBzdXJ2aXZlcyB0aGlzIENMSSk7IGl0J3MgZm91bmQgdmlhXG4vLyAkQVNUUk9MQUJFX0hPTUUvZGFlbW9uLntwb3J0LHBpZH0uXG4vL1xuLy8gICBidW4gY2xpLnRzIG9wZW4gWy0tbm8tb3Blbl0gWy0tdGltZW91dCBTXSAgICAjIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHVwICsgb3BlbiB0aGUgYm9hcmRcbi8vICAgYnVuIGNsaS50cyBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dIFstLXN0ZGluXVxuLy8gICBidW4gY2xpLnRzIHJlbW92ZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAjIHVucmVnaXN0ZXIgYSBwcm9qZWN0IChkdXJhYmxlKVxuLy8gICBidW4gY2xpLnRzIGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dICAgIyBzY29wZWQgL2V2ZW50cyB0YWlsIOKAlCBBQ1RJVkFURVMgdGhlIGNhcmQgKyByZWNlaXZlcyBwb2tlcyAod3JhcCB3aXRoIE1vbml0b3IpXG4vLyAgIGJ1biBjbGkudHMgc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl0gICAjIHJlcGxhY2UgdGhlIGN1cnJlbnQgc3RhdHVzXG4vLyAgIGJ1biBjbGkudHMgYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl0gICAgICAgICAjIHJhaXNlIC8gY2xlYXIgdGhlIGh1bWFuIGdhdGVcbi8vICAgYnVuIGNsaS50cyBwb2tlIDxpZD4gICAgICAgICAgICAgICAgICAgICAgICAgIyByZXF1ZXN0IGEgZnJlc2ggc3RhdHVzIGZyb20gdGhlIHByb2plY3QncyBhZ2VudFxuLy8gICBidW4gY2xpLnRzIHN0YXRlICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIHJlYWQtYmFjazogcHJvamVjdCBjYXJkc1xuLy8gICBidW4gY2xpLnRzIHRhaWwgWy0tc2luY2UgTl0gWy0tYXMgPG5hbWU+XSAgICAjIHVuc2NvcGVkIGV2ZW50IHRhaWwg4oaSIEpTT05MIChubyBwcmVzZW5jZSlcbi8vICAgYnVuIGNsaS50cyBsaXN0IHwgY2xvc2UgfCBpbmZvIHwgaGVscFxuLy9cbi8vIGBqb2luYCBpcyB0aGUgbGlzdGVuaW5nIGxvb3AgYSBwcm9qZWN0J3MgYWdlbnQgcnVuczogaG9sZGluZyB0aGUgc2NvcGVkXG4vLyBgL2V2ZW50cz9wcm9qZWN0PTxpZD5gIHRhaWwgb3BlbiBpcyB3aGF0IG1hcmtzIHRoZSBjYXJkIGFjdGl2ZSAocGVyIHRoZSBkYWVtb25cbi8vIGNvbnRyYWN0IOKAlCBwcmVzZW5jZSBJUyB0aGUgbGl2ZSBjb25uZWN0aW9uKSwgYW5kIHRoZSBzYW1lIHRhaWwgZGVsaXZlcnMgcG9rZXMuXG4vL1xuLy8gSWRlbnRpdHk6IC0tYXMgLyAtLWZyb20gKG9yICRBU1RST0xBQkVfQVMpIHN0YW1wcyB0aGUgZXZlbnQgYGJ5YCBhbmQgZHJpdmVzXG4vLyBzZWxmLWVjaG8gc3VwcHJlc3Npb24uIC0tc3RkaW4gcmVhZHMgZnJlZSB0ZXh0IChkZXNjcmlwdGlvbi9zdW1tYXJ5KSBmcm9tXG4vLyBzdGRpbiAoYnlwYXNzZXMgc2hlbGwgcXVvdGluZykuIERpc2NpcGxpbmU6IHN0cnVjdHVyZWQgSlNPTiBvbiBzdGRvdXQgKG9uZVxuLy8gbGluZSk7IGxpdmVuZXNzLCBlY2hvZXMgYW5kIGtlZXBhbGl2ZXMgb24gc3RkZXJyOyBmYWlsdXJlcyBwdXQgT05FIEpTT04gZXJyb3Jcbi8vIGVudmVsb3BlIG9uIHN0ZGVyciB3aXRoIHN0ZG91dCBsZWZ0IGVtcHR5IOKAlCBuZXZlciBtZXJnZSBzdHJlYW1zLiBFeGl0IDIgb25cbi8vIGJhZCBhcmdzLCBhIGJhcmUgaW52b2NhdGlvbiwgT1IgYSByZWplY3RlZCBjb21tYW5kIChkZWR1cGUgLyB1bmtub3duIGlkKTtcbi8vIDAgb24gc3VjY2VzczsgMSBvbiBpbnRlcm5hbCBmYXVsdHMgKGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQpOyBhIHRhaWwgZXhpdHMgMFxuLy8gb24gdGhlIGRhZW1vbidzIGBjbG9zZWRgIGZyYW1lLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50c1wiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFwiLi5cIiwgXCJzY3JpcHRzXCIg4oCUIE5PVCBhIHNpYmxpbmcgbG9va3VwLiBUaGlzIGZpbGUgaXMgQVVUSE9SRUQgaGVyZSBhbmRcbi8vIEVYRUNVVEVTIGFzIGAuLi9kaXN0L2NsaS5qc2AgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIGFuZFxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlXG4vLyBwYXRoIGluIHRoaXMgZmlsZSAoU0tJTExfUk9PVCwgRElTVF9ESVIsIFNVUkZBQ0VfQ1dELCBwbHVnaW4uanNvbikgaXNcbi8vIHVuY2hhbmdlZCBieSB0aGUgbW92ZS4gQSBTSUJMSU5HLXJlbGF0aXZlIG9uZSBpcyBub3Q6IGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgcmVzb2x2ZWQgdG8gYGRpc3Qvc2VydmVyLnRzYCBhbmQgdGhlIGRhZW1vbiB3b3VsZCBuZXZlclxuLy8gc3Bhd24uIEdvaW5nIHVwIGFuZCBiYWNrIGRvd24gaXMgY29ycmVjdCBmcm9tIEJPVEggbG9jYXRpb25zLlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIGRldjogdGhlIGRhZW1vbiBzZXJ2ZXMgYSBCdW4tYnVuZGxlZCBSZWFjdCBzdXJmYWNlLCBhbmQgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvYXN0cm9sYWJlLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IChtZWFzdXJlZCBvbiBnbGFtb3VyOiB0aGUgcGFnZSA1MDBzXG4vLyB3aXRoIG5vIHN0eWxlc2hlZXQgbGluazsgYXN0cm9sYWJlJ3Mgb3duIGZhaWx1cmUgc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzXG4vLyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZVxuLy8gYW55d2F5IHdvdWxkIGJyZWFrIHRoZSBzcGF3bi5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJhc3Ryb2xhYmVcIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgQVNUUk9MQUJFX0hPTUUgPSBwcm9jZXNzLmVudi5BU1RST0xBQkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuYXN0cm9sYWJlXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcblxuLy8g4pSA4pSAIHRoZSB0YWlsIHdhdGNoZG9nLCBERVJJVkVEIEZST00gVEhFIERBRU1PTidTIE9XTiBIRUFSVEJFQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8g4puUIEEgQ09OU1RBTlQgSEVSRSBXT1VMRCBCRSBBIENPTlNUQU5UIERFQ09VUExFRCBGUk9NIFRIRSBUSElORyBJVCBXQVRDSEVTLlxuLy8gVGhlIHdhdGNoZG9nIGFib3J0cyBhIGNvbm5lY3Rpb24gdGhhdCBoYXMgc2FpZCBub3RoaW5nIGZvciBgVEFJTF9JRExFX01TYDtcbi8vIHRoZSBvbmx5IHRoaW5nIGtlZXBpbmcgYSBxdWlldCBjb25uZWN0aW9uIGFsaXZlIGlzIHRoZSBkYWVtb24ncyBgOiBoYmBcbi8vIGNvbW1lbnQuIFNvIHRoZSB0d28gbnVtYmVycyBhcmUgT05FIGludmFyaWFudCDigJQgd2F0Y2hkb2cgPiBoZWFydGJlYXQsIHdpdGhcbi8vIHJvb20gZm9yIG1pc3NlZCBiZWF0cyDigJQgYW5kIGEgaGFyZC1jb2RlZCA0NXMgc2F0aXNmaWVkIGl0IG9ubHkgYXQgdGhlXG4vLyBkYWVtb24ncyBERUZBVUxUIGhlYXJ0YmVhdC5cbi8vXG4vLyBNZWFzdXJlZDogYEFTVFJPTEFCRV9IRUFSVEJFQVRfTVNgIGlzIGVudi10dW5hYmxlIGFuZCBjbGFtcGVkIG9ubHkgdG8gaGFsZlxuLy8gdGhlIGlkbGUgdGltZW91dCwgYSBjZWlsaW5nIG9mIDEyNy41cyBhdCBkZWZhdWx0cywgc28gYW55IHZhbHVlIGFib3ZlIDQ1LDAwMFxuLy8gcHV0IHRoZSB0YWlsIGluIGEgcGVybWFuZW50IGFib3J0L3JlY29ubmVjdCBjeWNsZSDigJQgcmVjb25uZWN0cyBhdCArNDcuNHMsXG4vLyArOTIuNnMgYW5kICsxMzcuOXMgYWdhaW5zdCBhIGhlYWx0aHkgYnV0IHNsb3ctYmVhdGluZyBkYWVtb24uIEl0IHdhcyBoYXJtbGVzc1xuLy8gb25seSBiZWNhdXNlIGBQUkVTRU5DRV9ERUJPVU5DRV9NU2AgaGFwcGVuZWQgdG8gYWJzb3JiIHRoZSBjaHVybiwgd2hpY2ggaXMgYVxuLy8gdGhpcmQgY29uc3RhbnQgd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyLlxuLy9cbi8vIOKaoCBUSEUgVFdPIEVYUFJFU1NJT05TIEJFTE9XIE1JUlJPUiBgc2NyaXB0cy9zZXJ2ZXIudHM6MTM1LTE0MmAgQlkgSEFORCwgYW5kXG4vLyB0aGF0IGlzIGR1cGxpY2F0aW9uIHdpdGggaXRzIGV5ZXMgb3BlbjogdGhlIENMSSBjYW5ub3QgaW1wb3J0IHRoZSBkYWVtb25cbi8vICh0aGF0IHdvdWxkIGRyYWcgdGhlIHdob2xlIHNlcnZlciBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2ApLiBJdCBpcyBleGFjdGx5XG4vLyB0aGUgc2hhcGUgUGhhc2UgMWIncyBzaGFyZWQgc3BpbmUgc2hvdWxkIGNvbGxhcHNlIGludG8gb25lIGV4cG9ydGVkXG4vLyBjb25zdGFudC4gVW50aWwgdGhlbiwgYW4gZWRpdCB0aGVyZSBpcyBhbiBlZGl0IGhlcmUuXG5jb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTWF0aC5tYXgoXG4gIDEsXG4gIE1hdGgubWluKDI1NSwgTnVtYmVyLnBhcnNlSW50KHByb2Nlc3MuZW52LkFTVFJPTEFCRV9JRExFX1RJTUVPVVQgPz8gXCIyNTVcIiwgMTApIHx8IDI1NSksXG4pO1xuY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IE1hdGgubWluKFxuICBOdW1iZXIucGFyc2VJbnQocHJvY2Vzcy5lbnYuQVNUUk9MQUJFX0hFQVJUQkVBVF9NUyA/PyBcIjEwMDAwXCIsIDEwKSB8fCAxMDAwMCxcbiAgTWF0aC5tYXgoNTAwLCBNYXRoLmZsb29yKChJRExFX1RJTUVPVVRfU0VDICogMTAwMCkgLyAyKSksXG4pO1xuLy8gVGhyZWUgbWlzc2VkIGJlYXRzLiDimqAgSVQgTVVTVCBTVEFZIFdFTEwgQUJPVkUgVEhFIEhFQVJUQkVBVDogaG9sZGluZyB0aGVcbi8vIGNvbm5lY3Rpb24gb3BlbiBJUyBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuLy8gY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuLy8gc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuXG5jb25zdCBUQUlMX0lETEVfTVMgPSBTU0VfSEVBUlRCRUFUX01TICogMztcblxuLy8gRmFpbHVyZXMgbGVhdmUgc3Rkb3V0IGVtcHR5IGFuZCBwdXQgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIOKAlCB0aGUgc2FtZVxuLy8gbWFjaGluZSBzaGFwZSBhcyB0aGUgZGF0YSBwYXRoLCBzbyBhIHBpcGVkIGNhbGxlciBwYXJzZXMgdGhlIGVycm9yIGluc3RlYWQgb2Zcbi8vIHNjcmFwaW5nIHByb3NlLiBUSEUgRU5WRUxPUEUsIFRIRSBUQVhPTk9NWSBBTkQgVEhFIEVYSVQgQ09ERVMgQVJFIE5PVyBTSEFSRURcbi8vIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApOyBhc3Ryb2xhYmUncyBmb3VydGgsIG1pbmltYWwgY29weSBpcyBnb25lLiBUd29cbi8vIHRoaW5ncyBjaGFuZ2VkIGFuZCBib3RoIGFyZSBhZGRpdGl2ZTogdGhlIGVudmVsb3BlIGdhaW5zIGBleGl0X2NvZGVgLFxuLy8gYHJldHJ5YWJsZWAgYW5kIGBtZXRhLmNvbW1hbmRgLCBhbmQgYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3IgdGhhdCBgbWFpbmBcbi8vIHJlcG9ydHMsIHJhdGhlciB0aGFuIGV4aXRpbmcgZnJvbSB3aGVyZXZlciBpdCB3YXMgY2FsbGVkLiBga2luZGAgYW5kXG4vLyBgbWVzc2FnZWAg4oCUIHRoZSB0d28gZmllbGRzIGFueXRoaW5nIGNhbiBiZSBrZXlpbmcgb24g4oCUIGFyZSB1bnRvdWNoZWQuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKSA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG4vLyBpZCArIGF2YXRhciBhcmUgREVSSVZFRCBieSB0aGUgZGFlbW9uIChzdGF0ZS50cykgZnJvbSB0aGUgcHJvamVjdCBuYW1lLCBzbyB0aGVcbi8vIGNsaSBwYXNzZXMgaWQvYXZhdGFyIHRocm91Z2ggb25seSB3aGVuIHRoZSBjYWxsZXIgZ2F2ZSB0aGVtIGV4cGxpY2l0bHkg4oCUIG9uZVxuLy8gc291cmNlIG9mIHRydXRoLCBubyBzbHVnL2F2YXRhciBtaXJyb3IgdG8gZHJpZnQuXG5cbmZ1bmN0aW9uIHJlc29sdmVBcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB2ID0gZmxhZ3MuYXMgPz8gZmxhZ3MuZnJvbTtcbiAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpKSByZXR1cm4gdi50cmltKCk7XG4gIGNvbnN0IGVudiA9IHByb2Nlc3MuZW52LkFTVFJPTEFCRV9BUztcbiAgcmV0dXJuIGVudj8udHJpbSgpID8gZW52LnRyaW0oKSA6IHVuZGVmaW5lZDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW107XG4gIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgQnVuLnN0ZGluLnN0cmVhbSgpKSBjaHVua3MucHVzaChjaHVuayk7XG4gIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKTtcbn1cblxuLy8g4pSA4pSAIGRhZW1vbiBkaXNjb3ZlcnkgKyBIVFRQIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiByZWFkUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gTnVtYmVyLnBhcnNlSW50KChhd2FpdCBCdW4uZmlsZShQT1JUX0ZJTEUpLnRleHQoKSkudHJpbSgpLCAxMCk7XG4gICAgcmV0dXJuIHAgPiAwID8gcCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGlzVXAocG9ydDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIChhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3N0YXRlYCkpLm9rO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgcnVubmluZyBkYWVtb24sIG9yIGF1dG8tc3Bhd24gb25lIChkZXRhY2hlZCBzbyBpdCBvdXRsaXZlcyB0aGlzIENMSSDigJRcbi8vIG5vZGU6Y2hpbGRfcHJvY2Vzcywgbm90IEJ1bi5zcGF3biwgd2hpY2ggY2FuJ3QgZGV0YWNoIGEgc3Vydml2aW5nIGRhZW1vbikuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24oKTogUHJvbWlzZTx7IGJhc2U6IHN0cmluZzsgcG9ydDogbnVtYmVyIH0+IHtcbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkUG9ydCgpO1xuICBpZiAoZXhpc3RpbmcgJiYgKGF3YWl0IGlzVXAoZXhpc3RpbmcpKSkge1xuICAgIHJldHVybiB7IGJhc2U6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZXhpc3Rpbmd9YCwgcG9ydDogZXhpc3RpbmcgfTtcbiAgfVxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCJdLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQSB3cm9uZyBjd2Qgc2tpcHMgYnVuZmlnLnRvbWwncyBUYWlsd2luZFxuICAgIC8vIHBsdWdpbjsgb24gZ2xhbW91ciB0aGF0IGZhaWxzIHRoZSBwYWdlIG91dHJpZ2h0ICg1MDApLiBBc3NlcnQgdGhlIGludmFyaWFudCxcbiAgICAvLyBub3QgdGhlIHN0YXR1czogdGhlIHV0aWxpdHkgbmV2ZXIgcmVhY2hlcyB0aGUgYnJvd3NlciB3aGVuIGN3ZCBpcyB3cm9uZy5cbiAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBUaGUgZGFlbW9uIEJJTkRTIGZhc3QgYW5kIGFuc3dlcnMgL3N0YXRlIGFzIHNvb24gYXMgaXQncyBsaXN0ZW5pbmcgKHRoZVxuICAvLyBjb2xkIFRhaWx3aW5kK1JlYWN0IGJ1bmRsZSBpcyBsYXp5LCBvbiB0aGUgZmlyc3QgR0VUIFwiL1wiKSwgc28gdGhpcyBoYW5kc2hha2VcbiAgLy8gdXN1YWxseSByZXR1cm5zIHF1aWNrbHkuIFRoZSB3aWRlIGRlYWRsaW5lIGNvdmVycyBhIGNvbGQgbWFjaGluZSB3aGVyZVxuICAvLyBtb2R1bGUgbG9hZCArIGZpcnN0IHNlcnZlIHJ1bnMgc2xvdyAoZ2xhbW91ciB1c2VzIHRoZSBzYW1lIH40NXMgYnVkZ2V0KS5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBzbGVlcCg4MCk7XG4gICAgY29uc3QgcCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gICAgaWYgKHAgJiYgKGF3YWl0IGlzVXAocCkpKSByZXR1cm4geyBiYXNlOiBgaHR0cDovLzEyNy4wLjAuMToke3B9YCwgcG9ydDogcCB9O1xuICB9XG4gIGRpZShcImFzdHJvbGFiZSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiA0NXNcIiwgXCJpbnRlcm5hbFwiKTtcbn1cblxuLy8gQSByZWFkLW9ubHkgdmVyYiByZXF1aXJlcyBhIGxpdmUgZGFlbW9uIGJ1dCBtdXN0IG5vdCBzcGF3biBvbmUgKG5vdGhpbmcgdG9cbi8vIG9ic2VydmUgeWV0KSDigJQgc28gYHN0YXRlYC9gbGlzdGAvYGluZm9gIG9uIGEgY29sZCBtYWNoaW5lIHJlcG9ydCBjbGVhbmx5LlxuYXN5bmMgZnVuY3Rpb24gcnVubmluZ0Jhc2UoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHAgPSBhd2FpdCByZWFkUG9ydCgpO1xuICByZXR1cm4gcCA/IGBodHRwOi8vMTI3LjAuMC4xOiR7cH1gIDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChiYXNlOiBzdHJpbmcsIGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L2NtZGAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgfSk7XG4gIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyBvazogYm9vbGVhbjsgYXBwbGllZDogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmc7IG91dGNvbWU/OiBzdHJpbmcgfTtcbn1cblxuLy8gQXBwbHkgYSAvY21kLCBzdXJmYWNlIGEgcmVqZWN0aW9uIG9uIHN0ZGVyciArIG5vbi16ZXJvIGV4aXQgKGV4aXQtY29kZVxuLy8gY29udHJhY3QpLCBhbmQgZWNobyB0aGUgc3RydWN0dXJlZCByZXN1bHQgb24gc3Rkb3V0IG9uIHN1Y2Nlc3MuXG5hc3luYyBmdW5jdGlvbiBjbWQoYmFzZTogc3RyaW5nLCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCByID0gYXdhaXQgcG9zdENtZChiYXNlLCBib2R5KTtcbiAgLy8gYjIvIzg1IOKAlCBESVNUSU5HVUlTSCBUSEUgVFdPIEtJTkRTIE9GIGFwcGxpZWQ6ZmFsc2UuIFdJVEggYW4gZXJyb3IgPSBhIHJlYWxcbiAgLy8gcmVqZWN0aW9uICh1bmtub3duIHByb2plY3QsIGR1cGxpY2F0ZSkgLT4gdmlzaWJsZSwgbm9uLXplcm8sIHVuY2hhbmdlZC5cbiAgLy8gV0lUSE9VVCBhbiBlcnJvciA9IGEgYmVuaWduIG5vLW9wOiB0aGUgc3RhdGUgd2FzIGFscmVhZHkgd2hhdCB3YXMgYXNrZWQgZm9yLFxuICAvLyB0aGUgcHJvamVjdCBleGlzdHMsIHRoZSBkYWVtb24gaXMgcmlnaHQsIGFuZCBub3RoaW5nIGlzIHdyb25nLiBUaGF0IHVzZWQgdG9cbiAgLy8gZXhpdCAyIHdpdGggXCJjb21tYW5kICdhdHRlbnRpb24nIHdhcyBub3QgYXBwbGllZFwiLCBzbyByZS1pc3N1aW5nIGFuXG4gIC8vIGFscmVhZHktYXBwbGllZCBjb21tYW5kIHdhcyBhIGhhcmQgZmFpbHVyZSDigJQgd2hpbGUgYm91bnR5IHRyZWF0cyB0aGVcbiAgLy8gaWRlbnRpY2FsIHBheWxvYWQgYXMgb3JkaW5hcnkgc3VjY2Vzcy5cbiAgLy9cbiAgLy8gVGhpcyBpcyBib3VudHkncyBkaXNjaXBsaW5lIChjbGkudHMgYHRhc2sudXBkYXRlYCksIHBvcnRlZCByYXRoZXIgdGhhblxuICAvLyByZS1kZXJpdmVkLiBJdCByZXBvcnRzIHRoZSBkYWVtb24ncyBgb3V0Y29tZWAgbm91biBpbnN0ZWFkIG9mIGJvdW50eSdzXG4gIC8vIGBub29wOiB0cnVlYCBib29sZWFuLCBwZXIgdGhlIG91dGNvbWUgY29udHJhY3QncyBcImVudW1lcmF0ZWQsIG5ldmVyIGFcbiAgLy8gYm9vbGVhblwiIOKAlCB0aGUgbm91biBzYXlzIFdISUNIIHN0YXRlIG1hZGUgdGhlIHdvcmsgdW5uZWNlc3NhcnkuXG4gIGlmICghci5hcHBsaWVkICYmIHIuZXJyb3IpIGRpZShyLmVycm9yKTtcbiAgcHJpbnRKc29uKHIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBzcGF3bihvcGVuZXIsIFt1cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIFNTRSByZWFkZXI6IHN0cmVhbSB0aGUgZXZlbnQgbG9nIGFzIEpTT05MIG9uIHN0ZG91dCwgcmVzdW1hYmxlICsgcmVjb25uZWN0aW5nXG4vLyDigJQgb25lIGNhbGwgaW50byB0aGUgaG91c2UncyBzaGFyZWQgdGFpbCBjbGllbnQgKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLFxuLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGxvb3AsIHRoZSBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmRcbi8vIHRoZSBkcmFpbmVkIGV4aXQgbm93IGxpdmUsIE9OQ0UsIGZvciBldmVyeSBzcGVsbC5cbi8vXG4vLyBgc2NvcGVJZGAgKHNldCBieSBgam9pbmApIGZpbHRlcnMgdG8gdGhpcyBwcm9qZWN0J3MgZnJhbWVzICsgbGlmZWN5Y2xlOyBhblxuLy8gdW5zY29wZWQgdGFpbCBwYXNzZXMgZXZlcnl0aGluZy4gU2VsZi1lY2hvIChmcmFtZXMgdGhlIGNhbGxlcidzIG93biAtLWFzXG4vLyBjYXVzZWQpIGlzIHN1cHByZXNzZWQuIGA6YCBrZWVwYWxpdmVzIHJpZGUgc3RkZXJyOyByZXR1cm5zIDAgb24gYGNsb3NlZGAuXG4vL1xuLy8g4puUIGByZXNvbHZlYCBJUyBgcnVubmluZ0Jhc2VgLCBSRS1SRUFEIE9OIEVWRVJZIEFUVEVNUFQg4oCUIHRoaXMgaXMgdGhlIEIxIGZpeFxuLy8gYW5kIHRoZSByZWFzb24gYXN0cm9sYWJlIHdlbnQgZmlyc3QuIGFzdHJvbGFiZSBiaW5kcyBhbiBFUEhFTUVSQUwgcG9ydCwgYW5kXG4vLyB0aGlzIGZ1bmN0aW9uIHVzZWQgdG8gdGFrZSBhIGNhcHR1cmVkIGBiYXNlOiBzdHJpbmdgLCBzbyBhZnRlciBhbnkgZGFlbW9uXG4vLyByZXN0YXJ0IGBqb2luYCByZWNvbm5lY3RlZCB0byBhIGRlYWQgcG9ydCBmb3JldmVyIGFuZCBzdHJlYW1lZCBub3RoaW5nIHdoaWxlXG4vLyBsb29raW5nIHBlcmZlY3RseSBhbGl2ZS4gSXQgY2Fubm90OiB0aGUgY2FsbGJhY2sgcmUtcmVhZHNcbi8vIGAkQVNUUk9MQUJFX0hPTUUvZGFlbW9uLnBvcnRgIGJlZm9yZSBldmVyeSBjb25uZWN0LiBEcml2ZW4gaW4gYGNsaS50ZXN0LnRzYC5cbi8vXG4vLyBJdCBkZWxpYmVyYXRlbHkgZG9lcyBOT1Qgc3Bhd24uIGBqb2luYC9gdGFpbGAgc3RpbGwgY2FsbCBgZW5zdXJlRGFlbW9uKClgXG4vLyBvbmNlIHVwIGZyb250IChhIHRhaWwgd2l0aCBubyBkYWVtb24gYXQgYWxsIGlzIHdvcnRoIHJlcG9ydGluZyk7IGEgZGFlbW9uXG4vLyB0aGF0IGRpZXMgTUlELXdhdGNoIGlzIGEgd2FpdCwgbm90IGEgcmVzcGF3biwgYmVjYXVzZSBhIHNlY29uZCBhc3Ryb2xhYmVcbi8vIHNwYXduZWQgZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBpcyBhIHdvcnNlIG91dGNvbWUgdGhhbiBhIHdhdGNoIHRoYXRcbi8vIHJlc3VtZXMgd2hlbiB0aGUgaHVtYW4gcmVvcGVucyB0aGUgYm9hcmQuXG5hc3luYyBmdW5jdGlvbiBzdHJlYW1FdmVudHMob3B0czoge1xuICBzaW5jZTogbnVtYmVyO1xuICBwcm9qZWN0Pzogc3RyaW5nO1xuICBzY29wZUlkPzogc3RyaW5nO1xuICBzZWxmPzogc3RyaW5nO1xufSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHR5cGUgRXYgPSB7IGlkPzogbnVtYmVyOyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZzsgcHJvamVjdElkPzogc3RyaW5nIH07XG5cbiAgY29uc3QgaW5TY29wZSA9IChldjogRXYpID0+IHtcbiAgICBpZiAoIW9wdHMuc2NvcGVJZCkgcmV0dXJuIHRydWU7XG4gICAgaWYgKGV2LnR5cGUgPT09IFwicmVhZHlcIiB8fCBldi50eXBlID09PSBcImNsb3NlZFwiKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gZXYucHJvamVjdElkID09PSBvcHRzLnNjb3BlSWQ7XG4gIH07XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICByZXNvbHZlOiBydW5uaW5nQmFzZSxcbiAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICBzaW5jZTogb3B0cy5zaW5jZSxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiBldi5pZCxcbiAgICBxdWVyeTogKGN1cnNvcikgPT4gKHtcbiAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIC4uLihvcHRzLnByb2plY3QgPyB7IHByb2plY3Q6IG9wdHMucHJvamVjdCB9IDoge30pLFxuICAgIH0pLFxuICAgIGFjY2VwdDogKGV2KSA9PiBpblNjb3BlKGV2KSAmJiAhKG9wdHMuc2VsZiAhPT0gdW5kZWZpbmVkICYmIGV2LmJ5ID09PSBvcHRzLnNlbGYpLFxuICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgaWRsZU1zOiBUQUlMX0lETEVfTVMsXG4gICAgb25Db21tZW50OiAoKSA9PiBcIjogYXN0cm9sYWJlLWtlZXBhbGl2ZVwiLFxuICB9KTtcbn1cblxuLy8g4pSA4pSAIHZlcmJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCB7IHBvcnQgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkgb3BlbkJyb3dzZXIoYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCwgcG9ydCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWRkKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBuYW1lID0gcG9zLmpvaW4oXCIgXCIpLnRyaW0oKTtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXVwiKTtcbiAgY29uc3QgcGF0aCA9IHR5cGVvZiBmbGFncy5wYXRoID09PSBcInN0cmluZ1wiID8gZmxhZ3MucGF0aC50cmltKCkgOiBcIlwiO1xuICBpZiAoIXBhdGgpIGRpZShcImFkZCByZXF1aXJlcyAtLXBhdGggPHA+XCIpO1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IGZsYWdzLnN0ZGluXG4gICAgPyBhd2FpdCByZWFkU3RkaW4oKVxuICAgIDogdHlwZW9mIGZsYWdzLmRlc2NyaXB0aW9uID09PSBcInN0cmluZ1wiXG4gICAgICA/IGZsYWdzLmRlc2NyaXB0aW9uXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgLy8gaWQgKyBhdmF0YXIgYXJlIG9wdGlvbmFsIOKAlCB0aGUgZGFlbW9uIGRlcml2ZXMgYm90aCBmcm9tIHRoZSBuYW1lIHdoZW4gb21pdHRlZC5cbiAgY29uc3QgYXZhdGFyID0gdHlwZW9mIGZsYWdzLmF2YXRhciA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmF2YXRhciA6IHVuZGVmaW5lZDtcbiAgY29uc3QgaWQgPSB0eXBlb2YgZmxhZ3MuaWQgPT09IFwic3RyaW5nXCIgJiYgZmxhZ3MuaWQudHJpbSgpID8gZmxhZ3MuaWQudHJpbSgpIDogdW5kZWZpbmVkO1xuICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBhd2FpdCBjbWQoYmFzZSwge1xuICAgIHR5cGU6IFwicHJvamVjdC5hZGRcIixcbiAgICBwcm9qZWN0OiB7IGlkLCBuYW1lLCBwYXRoLCBkZXNjcmlwdGlvbiwgYXZhdGFyIH0sXG4gICAgYXM6IHJlc29sdmVBcyhmbGFncyksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZW1vdmUocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGlkID0gcG9zWzBdO1xuICBpZiAoIWlkKSBkaWUoXCJ1c2FnZTogcmVtb3ZlIDxpZD5cIik7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwicHJvamVjdC5yZW1vdmVcIiwgaWQsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0dXMocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGlkID0gcG9zWzBdO1xuICBpZiAoIWlkKSBkaWUoXCJ1c2FnZTogc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl1cIik7XG4gIGNvbnN0IHN1bW1hcnkgPSBmbGFncy5zdGRpbiA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKTtcbiAgaWYgKCFzdW1tYXJ5KSBkaWUoXCJzdGF0dXMgcmVxdWlyZXMgYSBzdW1tYXJ5IChwb3NpdGlvbmFsIG9yIC0tc3RkaW4pXCIpO1xuICBjb25zdCBwaGFzZSA9IHR5cGVvZiBmbGFncy5waGFzZSA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnBoYXNlIDogdW5kZWZpbmVkO1xuICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBhd2FpdCBjbWQoYmFzZSwgeyB0eXBlOiBcInN0YXR1c1wiLCBpZCwgc3VtbWFyeSwgcGhhc2UsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBdHRlbnRpb24ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGlkID0gcG9zWzBdO1xuICBpZiAoIWlkKSBkaWUoXCJ1c2FnZTogYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl1cIik7XG4gIGNvbnN0IHJhaXNlZCA9IGZsYWdzLmNsZWFyICE9PSB0cnVlO1xuICBjb25zdCBxdWVzdGlvbiA9XG4gICAgdHlwZW9mIGZsYWdzLnF1ZXN0aW9uID09PSBcInN0cmluZ1wiXG4gICAgICA/IGZsYWdzLnF1ZXN0aW9uXG4gICAgICA6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKS50cmltKCkgfHwgdW5kZWZpbmVkO1xuICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBhd2FpdCBjbWQoYmFzZSwgeyB0eXBlOiBcImF0dGVudGlvblwiLCBpZCwgcmFpc2VkLCBxdWVzdGlvbiwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFBva2UocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGlkID0gcG9zWzBdO1xuICBpZiAoIWlkKSBkaWUoXCJ1c2FnZTogcG9rZSA8aWQ+XCIpO1xuICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBhd2FpdCBjbWQoYmFzZSwgeyB0eXBlOiBcInBva2VcIiwgaWQsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZSgpIHtcbiAgY29uc3QgYmFzZSA9IGF3YWl0IHJ1bm5pbmdCYXNlKCk7XG4gIGlmICghYmFzZSB8fCAhKGF3YWl0IGlzVXAoTnVtYmVyLnBhcnNlSW50KGJhc2Uuc3BsaXQoXCI6XCIpLnBvcCgpIGFzIHN0cmluZywgMTApKSkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcnVubmluZzogZmFsc2UsIHN0YXRlOiB7IHRpdGxlOiBcIk9ic2VydmF0b3J5XCIsIHByb2plY3RzOiBbXSB9IH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtiYXNlfS9zdGF0ZWApO1xuICBpZiAoIXJlcy5vaykgZGllKGBzdGF0ZSBmYWlsZWQgKEhUVFAgJHtyZXMuc3RhdHVzfSlgKTtcbiAgcHJpbnRKc29uKGF3YWl0IHJlcy5qc29uKCkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRMaXN0KCkge1xuICBjb25zdCBiYXNlID0gYXdhaXQgcnVubmluZ0Jhc2UoKTtcbiAgLy8gR3VhcmQgd2l0aCBpc1VwKCkgYmVmb3JlIGZldGNoaW5nIChtaXJyb3JzIGNtZFN0YXRlKTogYSBTVEFMRSBkYWVtb24ucG9ydFxuICAvLyBmcm9tIGEgY3Jhc2hlZCBkYWVtb24gd291bGQgb3RoZXJ3aXNlIHRocm93IEVDT05OUkVGVVNFRCBoZXJlIGluc3RlYWQgb2YgdGhlXG4gIC8vIGNsZWFuIHJ1bm5pbmc6ZmFsc2UgcGF0aC5cbiAgaWYgKCFiYXNlIHx8ICEoYXdhaXQgaXNVcChOdW1iZXIucGFyc2VJbnQoYmFzZS5zcGxpdChcIjpcIikucG9wKCkgYXMgc3RyaW5nLCAxMCkpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSwgcHJvamVjdHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXRlIH0gPSAoYXdhaXQgKGF3YWl0IGZldGNoKGAke2Jhc2V9L3N0YXRlYCkpLmpzb24oKSkgYXMge1xuICAgIHN0YXRlOiB7IHByb2plY3RzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gfTtcbiAgfTtcbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBydW5uaW5nOiB0cnVlLFxuICAgIHByb2plY3RzOiBzdGF0ZS5wcm9qZWN0cy5tYXAoKHApID0+ICh7XG4gICAgICBpZDogcC5pZCxcbiAgICAgIG5hbWU6IHAubmFtZSxcbiAgICAgIHpvbmU6IHAuem9uZSxcbiAgICAgIGNvbm5lY3RlZDogcC5jb25uZWN0ZWQsXG4gICAgfSkpLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQ2xvc2UoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGJhc2UgPSBhd2FpdCBydW5uaW5nQmFzZSgpO1xuICBpZiAoIWJhc2UpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgYXBwbGllZDogZmFsc2UsIGVycm9yOiBcIm5vIGRhZW1vbiBydW5uaW5nXCIgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKGJhc2UsIHsgdHlwZTogXCJjbG9zZVwiLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEluZm8oKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkUG9ydCgpO1xuICBpZiAocG9ydCAmJiAoYXdhaXQgaXNVcChwb3J0KSkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcnVubmluZzogdHJ1ZSwgdXJsOiBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCwgcG9ydCB9KTtcbiAgfSBlbHNlIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcnVubmluZzogZmFsc2UgfSk7XG4gIH1cbn1cblxuY29uc3QgSEVMUCA9IGBhc3Ryb2xhYmUg4oCUIGEgc3RhbmRpbmcgb2JzZXJ2YXRvcnkgYm9hcmQgZm9yIHByb2plY3RzIGluIGZsaWdodC5cblxuICBvcGVuIFstLW5vLW9wZW5dXG4gICAgICBlbnN1cmUgdGhlIGRhZW1vbiBpcyB1cCArIG9wZW4gdGhlIGJvYXJkIGluIHRoZSBicm93c2VyXG4gIGFkZCA8bmFtZT4gLS1wYXRoIDxwPiBbLS1kZXNjcmlwdGlvbiAuLl0gWy0tYXZhdGFyIC4uXSBbLS1pZCAuLl0gWy0tc3RkaW5dXG4gICAgICByZWdpc3RlciBhIHByb2plY3QgKGRlZHVwZS1ndWFyZGVkOyBpZCArIGF2YXRhciBkZXJpdmVkIGZyb20gdGhlIG5hbWUgd2hlbiBvbWl0dGVkKS5cbiAgICAgIHRoZSByZXNwb25zZSBlY2hvZXMgdGhlIGRlcml2ZWQgaWQg4oCUIHlvdSBuZWVkIGl0IGZvciBqb2luL3N0YXR1cy9hdHRlbnRpb24vcmVtb3ZlLlxuICByZW1vdmUgPGlkPlxuICAgICAgdW5yZWdpc3RlciBhIHByb2plY3RcbiAgam9pbiA8aWQ+IFstLWFzIDxuYW1lPl0gWy0tc2luY2UgTl1cbiAgICAgIGFjdGl2YXRlIHRoZSBjYXJkICsgbGlzdGVuIGZvciBwb2tlcyAoc2NvcGVkIHRhaWw7IHdyYXAgd2l0aCBNb25pdG9yKS4gZW5kIGl0IHRvIGlkbGUgdGhlIGNhcmQuXG4gIHN0YXR1cyA8aWQ+IDxzdW1tYXJ5Li4uPiBbLS1waGFzZSAuLl0gWy0tc3RkaW5dXG4gICAgICByZXBsYWNlIGEgcHJvamVjdCdzIGN1cnJlbnQgc3RhdHVzXG4gIGF0dGVudGlvbiA8aWQ+IFstLWNsZWFyXSBbLS1xdWVzdGlvbiAuLi5dXG4gICAgICByYWlzZSAvIGNsZWFyIHRoZSBuZWVkcy15b3UgZ2F0ZSAoLS1xdWVzdGlvbiBhdHRhY2hlcyB0aGUgcHJvbXB0KVxuICBwb2tlIDxpZD5cbiAgICAgIHJlcXVlc3QgYSBmcmVzaCBzdGF0dXMgZnJvbSB0aGUgcHJvamVjdCdzIGFnZW50XG4gIHN0YXRlXG4gICAgICByZWFkLWJhY2s6IHByb2plY3QgY2FyZHMgKGVhY2ggY2FycmllcyBhIGRlcml2ZWQgem9uZTogYXR0ZW50aW9uIHwgYWN0aXZlIHwgcXVpZXQpXG4gIHRhaWwgWy0tc2luY2UgTl0gWy0tYXMgPG5hbWU+XVxuICAgICAgdW5zY29wZWQgZXZlbnQgdGFpbCBhcyBKU09OTCAobm8gcHJlc2VuY2UpXG4gIGxpc3QgfCBjbG9zZSB8IGluZm8gfCBoZWxwIHwgLS12ZXJzaW9uXG5cbiAgSWRlbnRpdHk6IC0tYXMgLyAtLWZyb20gKG9yICRBU1RST0xBQkVfQVMpIHN0YW1wcyB0aGUgYWN0b3IgKyBzdXBwcmVzc2VzIHNlbGYtZWNoby5cbiAgLS1zdGRpbiByZWFkcyBhIGRlc2NyaXB0aW9uL3N1bW1hcnkgZnJvbSBzdGRpbiAoc2hlbGwtcXVvdGluZy1zYWZlKS5cbiAgT3V0cHV0OiBldmVyeSBjb21tYW5kIHByaW50cyBKU09OIG9uIHN0ZG91dCBieSBkZWZhdWx0LCBvbmUgbGluZSBwZXIgYW5zd2VyO1xuICBmYWlsdXJlcyBwdXQgb25lIEpTT04gZXJyb3IgZW52ZWxvcGUgb24gc3RkZXJyIGFuZCBleGl0IG5vbi16ZXJvICgyID0gdXNhZ2UpLlxuICBUaGVyZSBpcyBubyBwcm9zZSBtb2RlIHRvIHN3aXRjaCBvdXQgb2YuYDtcblxuLy8gVGhlIHBsdWdpbiBtYW5pZmVzdCBpcyB0aGUgb25lIHZlcnNpb24gc291cmNlOyB0aGUgQ0xJIHJlYWRzIGl0IHJhdGhlciB0aGFuXG4vLyBtaXJyb3JpbmcgdGhlIG51bWJlci4gTGF5b3V0LWRlcGVuZGVudCwgc28gYWJzZW5jZSBkZWdyYWRlcyB0byBcInVua25vd25cIi5cbmFzeW5jIGZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IFByb21pc2U8eyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGtnID0gYXdhaXQgQnVuLmZpbGUoam9pbihTQ1JJUFRfRElSLCBcIi4uLy4uLy4uLy5jbGF1ZGUtcGx1Z2luL3BsdWdpbi5qc29uXCIpKS5qc29uKCk7XG4gICAgaWYgKHR5cGVvZiBwa2c/LnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwiYXN0cm9sYWJlXCIsIHZlcnNpb246IHBrZy52ZXJzaW9uIH07XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgbmFtZTogXCJhc3Ryb2xhYmVcIiwgdmVyc2lvbjogXCJ1bmtub3duXCIgfTtcbn1cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSBmdW5uZWwuIGBkaWVgIFRIUk9XUyBhIENsaUVycm9yIG5vdyAodGhlIGhvdXNlJ3Mgb25lIGVycm9yXG4gKiBjb250cmFjdCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSBpbnN0ZWFkIG9mIGV4aXRpbmcgZnJvbSB3aGVyZXZlciBpdCB3YXNcbiAqIGNhbGxlZCwgc28gdGhpcyBpcyB0aGUgT05FIHBsYWNlIGEgZmFpbHVyZSBiZWNvbWVzIGFuIGV4aXQgY29kZSDigJQgYW5kIHRoZVxuICogcHJvY2VzcyBzdGlsbCBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMsIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGFcbiAqIG5hdHVyYWwgcmV0dXJuLCB3aGljaCBpcyB3aGF0IGRyYWlucyBzdGRvdXQgb24gYSBwaXBlLlxuICpcbiAqIOKblCBBIE5PTi1DbGlFcnJvciBJUyBSRVRIUk9XTiwgTkVWRVIgRU5WRUxPUEVELiBSZXBvcnRpbmcgYW4gdW5rbm93biB0aHJvdyBhc1xuICogYSB0aWR5IHRheG9ub215IGZhaWx1cmUgd291bGQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAoY29kZSA9PT0gbnVsbCkgdGhyb3cgZTtcbiAgICByZXR1cm4gY29kZTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHZlcmIgPSBhcmd2WzBdO1xuICBzZXRDdXJyZW50Q29tbWFuZCh2ZXJiID8/IG51bGwpO1xuICAvLyBBIGJhcmUgaW52b2NhdGlvbiByZXF1ZXN0ZWQgbm90aGluZyDigJQgdGhhdCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBoZWxwXG4gIC8vIHJlcXVlc3QuIGhlbHAgc3RheXMgcmVhY2hhYmxlIGJ5IG5hbWUgKGFuZCAtLWhlbHAvLWgpIG9uIHN0ZG91dCBhdCBleGl0IDAuXG4gIGlmICh2ZXJiID09PSB1bmRlZmluZWQpIGRpZShcIm5vIHZlcmIgZ2l2ZW4g4oCUIHRyeSAnaGVscCdcIik7XG4gIGlmICh2ZXJiID09PSBcImhlbHBcIiB8fCB2ZXJiID09PSBcIi0taGVscFwiIHx8IHZlcmIgPT09IFwiLWhcIikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgLy8gUm9vdCB0b2tlbiwgZGVsaWJlcmF0ZWx5IE5PVCBhIGZsYWc6IGRpc3BhdGNoZWQgYWxvbmdzaWRlIGhlbHAgaW4gdGhlIHZlcmJcbiAgLy8gc3dpdGNoLCBzbyBubyBwZXItdmVyYiBwYXJzZXIgaXMgZXhwZWN0ZWQgdG8gYWNjZXB0IGl0IGJlbG93IHRoZSByb290LlxuICBpZiAodmVyYiA9PT0gXCItLXZlcnNpb25cIiB8fCB2ZXJiID09PSBcIi1WXCIgfHwgdmVyYiA9PT0gXCJ2ZXJzaW9uXCIpIHtcbiAgICBwcmludEpzb24oYXdhaXQgdmVyc2lvbkluZm8oKSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndi5zbGljZSgxKSxcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgYXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcGF0aDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGRlc2NyaXB0aW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgYXZhdGFyOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgaWQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBwaGFzZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHF1ZXN0aW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgY2xlYXI6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgIH0sXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZGllKGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSk7XG4gIH1cbiAgY29uc3QgZmxhZ3MgPSBwYXJzZWQudmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuICBjb25zdCBwb3MgPSBwYXJzZWQucG9zaXRpb25hbHMgYXMgc3RyaW5nW107XG4gIGNvbnN0IHNpbmNlID0gdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gTnVtYmVyLnBhcnNlSW50KGZsYWdzLnNpbmNlLCAxMCkgOiAtMTtcblxuICBzd2l0Y2ggKHZlcmIpIHtcbiAgICBjYXNlIFwib3BlblwiOlxuICAgICAgYXdhaXQgY21kT3BlbihmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwiYWRkXCI6XG4gICAgICBhd2FpdCBjbWRBZGQocG9zLCBmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwicmVtb3ZlXCI6XG4gICAgICBhd2FpdCBjbWRSZW1vdmUocG9zLCBmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0dXMocG9zLCBmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwiYXR0ZW50aW9uXCI6XG4gICAgICBhd2FpdCBjbWRBdHRlbnRpb24ocG9zLCBmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwicG9rZVwiOlxuICAgICAgYXdhaXQgY21kUG9rZShwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJzdGF0ZVwiOlxuICAgICAgYXdhaXQgY21kU3RhdGUoKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJsaXN0XCI6XG4gICAgICBhd2FpdCBjbWRMaXN0KCk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgIGF3YWl0IGNtZENsb3NlKGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJpbmZvXCI6XG4gICAgICBhd2FpdCBjbWRJbmZvKCk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwiam9pblwiOiB7XG4gICAgICBjb25zdCBpZCA9IHBvc1swXTtcbiAgICAgIGlmICghaWQpIGRpZShcInVzYWdlOiBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXVwiKTtcbiAgICAgIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgICAvLyBDb25maXJtIHRoZSBwcm9qZWN0IGV4aXN0cyBiZWZvcmUgaG9sZGluZyB0aGUgd2F0Y2ggKGEgdHlwbydkIGlkIHdvdWxkXG4gICAgICAvLyBvdGhlcndpc2UgYmluZCBubyBwcmVzZW5jZSBhbmQgc2lsZW50bHkgc3RyZWFtIG5vdGhpbmcgdXNlZnVsKS5cbiAgICAgIGNvbnN0IHsgc3RhdGUgfSA9IChhd2FpdCAoYXdhaXQgZmV0Y2goYCR7YmFzZX0vc3RhdGVgKSkuanNvbigpKSBhcyB7XG4gICAgICAgIHN0YXRlOiB7IHByb2plY3RzOiBBcnJheTx7IGlkOiBzdHJpbmcgfT4gfTtcbiAgICAgIH07XG4gICAgICBpZiAoIXN0YXRlLnByb2plY3RzLnNvbWUoKHApID0+IHAuaWQgPT09IGlkKSlcbiAgICAgICAgZGllKGB1bmtub3duIHByb2plY3QgJyR7aWR9JyDigJQgcmVnaXN0ZXIgaXQgZmlyc3RgKTtcbiAgICAgIHJldHVybiBhd2FpdCBzdHJlYW1FdmVudHMoeyBzaW5jZSwgcHJvamVjdDogaWQsIHNjb3BlSWQ6IGlkLCBzZWxmOiByZXNvbHZlQXMoZmxhZ3MpIH0pO1xuICAgIH1cbiAgICBjYXNlIFwidGFpbFwiOiB7XG4gICAgICAvLyBlbnN1cmVEYWVtb24gZm9yIHRoZSBTVEFSVCBvZiB0aGUgd2F0Y2ggb25seTsgdGhlIHRhaWwgcmUtcmVzb2x2ZXMgdGhlXG4gICAgICAvLyBkYWVtb24gb24gZXZlcnkgcmVjb25uZWN0IChzZWUgc3RyZWFtRXZlbnRzKSwgc28gYGJhc2VgIGlzIG5vdCBjYXJyaWVkLlxuICAgICAgYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgICByZXR1cm4gYXdhaXQgc3RyZWFtRXZlbnRzKHsgc2luY2UsIHNlbGY6IHJlc29sdmVBcyhmbGFncykgfSk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICBkaWUoYHVua25vd24gdmVyYiAnJHt2ZXJifScg4oCUIHRyeSAnaGVscCdgKTtcbiAgfVxufVxuXG5pZiAoaW1wb3J0Lm1ldGEubWFpbikge1xuICAvLyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWwgcmV0dXJuLCBORVZFUiBgcHJvY2Vzcy5leGl0KGNvZGUpYDogQnVuJ3NcbiAgLy8gc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhblxuICAvLyBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICAvLyA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyB0aGVcbiAgLy8gY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gUmVwcm9kdWNlZCxcbiAgLy8gZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lIHNoYXBlLCBzYW1lIHJlYXNvbi5cbiAgLy8gRG8gbm90IHRpZHkgdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuLy8gRXhwb3J0ZWQgc28gdGhlIHNoaXBwZWQgbGF1bmNoZXIgKHBsdWdpbnMvLi4uL3NjcmlwdHMvY2xpLnRzKSBjYW4gaW52b2tlIHRoZVxuLy8gQlVORExFRCBjb3B5IG9mIHRoaXMgbW9kdWxlLiBUaGUgaW1wb3J0Lm1ldGEubWFpbiBibG9jayBhYm92ZSBzdGlsbCBydW5zIHRoaXNcbi8vIGZpbGUgZGlyZWN0bHkgZHVyaW5nIGRldmVsb3BtZW50OyB0aGUgdHdvIGVudHJ5IHJvdXRlcyBhcmUgZXhjbHVzaXZlLCBiZWNhdXNlXG4vLyBpbXBvcnQubWV0YS5tYWluIGlzIGZhbHNlIGZvciBhbiBpbXBvcnRlZCBtb2R1bGUuXG5leHBvcnQgeyBtYWluIH07XG5cbi8qKlxuICogVGhlIFNISVBQRUQgRU5UUlkgUE9JTlQsIGNhbGxlZCBieSBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2FzdHJvbGFiZS9zY3JpcHRzL2NsaS50c2BcbiAqIGFmdGVyIHRoZSBidW5kbGUgaXMgaW1wb3J0ZWQuXG4gKlxuICog4puUIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgQU5EIFRIQVQgSVMgVEhFIFBPSU5ULiBhcmd2IGJlbG9uZ3MgdG8gd2hpY2hldmVyIGZpbGVcbiAqIFBBUlNFUyBpdCwgYW5kIHRoYXQgaXMgdGhpcyBvbmUuIEFuIGVhcmxpZXIgbGF1bmNoZXIgcmVhZFxuICogYHByb2Nlc3MuYXJndi5zbGljZSgyKWAgaXRzZWxmIGFuZCBwYXNzZWQgaXQgaW4g4oCUIHdoaWNoIG1hZGUgdGhlIGxhdW5jaGVyIG1hdGNoXG4gKiBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBQQVJTRVNfQVJHUyBwcmVkaWNhdGUgKGBwcm9jZXNzLmFyZ3ZgKSwgc28gdGhlXG4gKiByb3N0ZXIgY291bnRlZCBhIDMtbGluZSBmb3J3YXJkZXIgYXMgYW4gYXJnLXBhcnNpbmcgZW50cnkgcG9pbnQgYW5kIHRoZW5cbiAqIHJlcG9ydGVkIHRoZSBzcGVsbCdzIGRvY3VtZW50ZWQgZmxhZ3MgYXMgVU5SRVNPTFZFRCBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuIEtlZXBpbmcgYXJndiBvbiB0aGlzIHNpZGUgbWFrZXMgdGhlIGVudW1lcmF0b3IncyBhbnN3ZXIgdHJ1ZVxuICogaW5zdGVhZCBvZiBtYWtpbmcgaXRzIHJlZ2V4IGxvb3Nlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIG9uZS1saW5lIEpTT04gZW1pdHRlciDigJQgT05FIGltcGxlbWVudGF0aW9uLCBpbXBvcnRlZCBieSBldmVyeVxuICogc3BlbGwgdGhhdCBzcGVha3MgdGhlIGFnZW50IHdpcmUuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBgc3JjL2tpdC9gJ3MgRklSU1QgSU5IQUJJVEFOVCwgYW5kIHRoYXQgaXMgbG9hZC1iZWFyaW5nIGJleW9uZFxuICogdGhlIHNoYXJpbmcgaXQgZG9lcy4gV2FyZCAyIChcInRoZSBraXQgaXMgYSBsZWFmXCIpIGhhcyBiZWVuIGdyZWVuIGJ5XG4gKiBDT05TVFJVQ1RJT04gc2luY2UgUGhhc2UgMCDigJQgaXQgaGFkIG5vdGhpbmcgdG8gd2FsaywgYW5kIHNhaWQgc28gb24gZXZlcnlcbiAqIHJ1bi4gVGhpcyBtb2R1bGUgaXMgdGhlIGZpcnN0IHRoaW5nIGl0IGFjdHVhbGx5IGd1YXJkcywgd2hpY2ggaXMgd2h5IHRoZVxuICogd2FyZCdzIHplcm8tZ3VhcmQgY2VsbCBkaXN0aW5ndWlzaGVzIGFuIEFCU0VOVCBraXQgZnJvbSBhbiBFTVBUWSBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgbm90IGEgc3BlbGwsXG4gKiBub3QgYSBzdXJmYWNlLCBub3QgYSBiYWNrZW5kLiBUaGF0IGlzIHdhcmQgMidzIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbixcbiAqIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoZSBraXQgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgZGVwZW5kZW5jeS1mcmVlIGFuZCBkZWxpYmVyYXRlbHkgZHVsbDogaXQgaXMgYnVuZGxlZCBJTlRPIGVhY2hcbiAqIHNwZWxsJ3MgZW1pdHRlZCBDTEkgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIHNvIGFueXRoaW5nIGl0XG4gKiByZWFjaGVkIGZvciB3b3VsZCBiZWNvbWUgYSBkZXBlbmRlbmN5IG9mIHR3byBzaGlwcGVkIGFydGlmYWN0cyBhdCBvbmNlLlxuICpcbiAqIFRoZSB3aXJlIGNvbnRyYWN0IGl0IGVuY29kZXM6IGV4YWN0bHkgb25lIEpTT04gZG9jdW1lbnQsIG9uZSB0cmFpbGluZ1xuICogbmV3bGluZSwgbm90aGluZyBlbHNlIG9uIHN0ZG91dC4gQSBjYWxsZXIgcmVhZGluZyBvdXIgc3Rkb3V0IHdpdGggYVxuICogbGluZS1kZWxpbWl0ZWQgcGFyc2VyIGRlcGVuZHMgb24gdGhhdCBuZXdsaW5lOyBhIGNhbGxlciByZWFkaW5nIHRvIEVPRlxuICogZGVwZW5kcyBvbiB0aGVyZSBiZWluZyBubyBzZWNvbmQgZG9jdW1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bik6IHZvaWQge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCByZXBhaXJlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhXG4gKiBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4g4puUIFJFQUNIQUJJTElUWSwgTk9UIENBTEwgU0lURVM6IGFcbiAqIEhFTFBFUiB0aGF0IGRpZXMsIGludm9rZWQgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAsIGhhcyBpdHMgYGRpZWAgYXRcbiAqIGEgc2l0ZSB0aGF0IHJlYWRzIGFzIHBlcmZlY3RseSBzYWZlLiBBbiBhZG9wdGluZyBzcGVsbCBtdXN0IGZvbGxvdyB0aGUgY2FsbFxuICogZ3JhcGgsIG5vdCBncmVwIGZvciBgZGllKGAuIEF1ZGl0ZWQgdGhhdCB3YXkgb24gYWRvcHRpb24g4oCUIDE1IHNpdGVzIGluXG4gKiBhc3Ryb2xhYmUsIDI5IGluIG1hZ3BpZSwgcGx1cyB0aGUgaGVscGVycyByZWFjaGFibGUgZnJvbSB0aGVtIOKAlCBhbmQgZXZlcnlcbiAqIHBhdGggaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLCBmcm9tIHdoaWNoIHRoZSB0aHJvd1xuICogcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKiogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqICBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuIDEuMy4xNCBmaW5kaW5nIHRoYXRcbiAqIGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy4gSXQgaXMgYSBEQUVNT04tc2lkZVxuICogZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnlcbiAqIGNsaWVudC4gSXQgc3RheXMgd2hlcmUgaXQgd2FzIG1lYXN1cmVkLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLiAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiAqL1xuICB0ZXJtaW5hbD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKTogeyBmcmFtZTogU3NlRnJhbWUgfCBudWxsOyBjb21tZW50czogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHJldHVybiBjb2RlO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2KSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBa0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDaEJPLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBT0EsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBYVosU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFB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QVMsS0FBSztBQUFBLE1BQ3BCLE9BQU87QUFBQSxTQUNKO0FBQUEsTUFDSCxNQUFNLFFBQVE7QUFBQSxNQUNkLE9BQU87QUFBQSxTQUNKLFFBQVE7QUFBQSxNQUNYLE1BQU0sS0FBSyxJQUFJO0FBQUEsTUFDZixJQUFJLENBQUM7QUFBQSxRQUFJLElBQUksNENBQTRDO0FBQUEsTUFDekQsUUFBUSxTQUFTLE1BQU0sYUFBYTtBQUFBLE1BR3BDLFFBQVEsVUFBVyxPQUFPLE1BQU0sTUFBTSxHQUFHLFlBQVksR0FBRyxLQUFLO0FBQUEsTUFHN0QsSUFBSSxDQUFDLE1BQU0sU0FBUyxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRTtBQUFBLFFBQ3pDLElBQUksb0JBQW9CLDhCQUF3QjtBQUFBLE1BQ2xELE9BQU8sTUFBTSxhQUFhLEVBQUUsT0FBTyxTQUFTLElBQUksU0FBUyxJQUFJLE1BQU0sVUFBVSxLQUFLLEVBQUUsQ0FBQztBQUFBLElBQ3ZGO0FBQUEsU0FDSyxRQUFRO0FBQUEsTUFHWCxNQUFNLGFBQWE7QUFBQSxNQUNuQixPQUFPLE1BQU0sYUFBYSxFQUFFLE9BQU8sTUFBTSxVQUFVLEtBQUssRUFBRSxDQUFDO0FBQUEsSUFDN0Q7QUFBQTtBQUFBLE1BRUUsSUFBSSxpQkFBaUIseUJBQW1CO0FBQUE7QUFBQTtBQUk5QyxJQUFJLGtCQUFrQjtBQUFBLEVBUXBCLFFBQVEsV0FBVyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQ3JEO0FBcUJBLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkUxOERFNjc0QjQwMjE3M0M2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
