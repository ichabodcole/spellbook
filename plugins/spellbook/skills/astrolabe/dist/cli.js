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
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const stop = (exitCode) => {
    stopped = true;
    code = exitCode;
    attempt?.abort();
  };
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
  try {
    while (!stopped) {
      const base = await opts.resolve();
      if (base === null) {
        const verdict = opts.onUnresolved?.({ everResolved, everConnected }) ?? "retry";
        if (verdict === "stop")
          return code;
        await sleep(delay);
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
      } catch {
        if (watchdog !== null)
          clearTimeout(watchdog);
        attempt = null;
        if (stopped)
          break;
        await sleep(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      try {
        if (!res.ok) {
          await opts.onHttpError?.(res);
          await sleep(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        if (!res.body) {
          await sleep(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        everConnected = true;
        firstConnect = false;
        delay = retry.initialMs;
        resetWatchdog();
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buf = "";
        while (!stopped) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch {
            break;
          }
          if (chunk.done)
            break;
          resetWatchdog();
          buf += decoder.decode(chunk.value, { stream: true });
          for (let sep = buf.indexOf(`

`);sep >= 0; sep = buf.indexOf(`

`)) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const { frame, comments } = parseSseFrame(block);
            for (const text of comments)
              opts.onComment?.(text);
            if (!frame)
              continue;
            let ev;
            try {
              ev = JSON.parse(frame.data);
            } catch (e) {
              const line = opts.onMalformed?.(frame, e) ?? null;
              if (line !== null)
                emit(line);
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
      await sleep(delay);
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
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
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
    await sleep2(80);
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
    idleMs: 45000,
    onComment: () => process.stderr.write(`: astrolabe-keepalive
`)
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

//# debugId=06681E3E16EC8A3C64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gYXN0cm9sYWJlIENMSSDigJQgdGhpbiwgc3RhdGVsZXNzIHdyYXBwZXIgYXJvdW5kIHRoZSBzdGFuZGluZyBvYnNlcnZhdG9yeVxuLy8gZGFlbW9uJ3MgSFRUUCBzdXJmYWNlIChzZXJ2ZXIudHMpLiBUaGUgYWdlbnQgZHJpdmVzIHRoZSBib2FyZCB0aHJvdWdoIHRoZXNlXG4vLyB2ZXJiczsgYGpvaW5gL2B0YWlsYCBzdHJlYW0gZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAuXG4vL1xuLy8gRGlzY292ZXJ5ICsgbGlmZWN5Y2xlOiBhIFNJTkdMRVRPTiBkYWVtb24gcGVyICRBU1RST0xBQkVfSE9NRS4gVGhlIGZpcnN0IHZlcmJcbi8vIHRoYXQgbmVlZHMgaXQgYXV0by1zcGF3bnMgaXQgKGRldGFjaGVkLCBzdXJ2aXZlcyB0aGlzIENMSSk7IGl0J3MgZm91bmQgdmlhXG4vLyAkQVNUUk9MQUJFX0hPTUUvZGFlbW9uLntwb3J0LHBpZH0uXG4vL1xuLy8gICBidW4gY2xpLnRzIG9wZW4gWy0tbm8tb3Blbl0gWy0tdGltZW91dCBTXSAgICAjIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHVwICsgb3BlbiB0aGUgYm9hcmRcbi8vICAgYnVuIGNsaS50cyBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dIFstLXN0ZGluXVxuLy8gICBidW4gY2xpLnRzIHJlbW92ZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAjIHVucmVnaXN0ZXIgYSBwcm9qZWN0IChkdXJhYmxlKVxuLy8gICBidW4gY2xpLnRzIGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dICAgIyBzY29wZWQgL2V2ZW50cyB0YWlsIOKAlCBBQ1RJVkFURVMgdGhlIGNhcmQgKyByZWNlaXZlcyBwb2tlcyAod3JhcCB3aXRoIE1vbml0b3IpXG4vLyAgIGJ1biBjbGkudHMgc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl0gICAjIHJlcGxhY2UgdGhlIGN1cnJlbnQgc3RhdHVzXG4vLyAgIGJ1biBjbGkudHMgYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl0gICAgICAgICAjIHJhaXNlIC8gY2xlYXIgdGhlIGh1bWFuIGdhdGVcbi8vICAgYnVuIGNsaS50cyBwb2tlIDxpZD4gICAgICAgICAgICAgICAgICAgICAgICAgIyByZXF1ZXN0IGEgZnJlc2ggc3RhdHVzIGZyb20gdGhlIHByb2plY3QncyBhZ2VudFxuLy8gICBidW4gY2xpLnRzIHN0YXRlICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIHJlYWQtYmFjazogcHJvamVjdCBjYXJkc1xuLy8gICBidW4gY2xpLnRzIHRhaWwgWy0tc2luY2UgTl0gWy0tYXMgPG5hbWU+XSAgICAjIHVuc2NvcGVkIGV2ZW50IHRhaWwg4oaSIEpTT05MIChubyBwcmVzZW5jZSlcbi8vICAgYnVuIGNsaS50cyBsaXN0IHwgY2xvc2UgfCBpbmZvIHwgaGVscFxuLy9cbi8vIGBqb2luYCBpcyB0aGUgbGlzdGVuaW5nIGxvb3AgYSBwcm9qZWN0J3MgYWdlbnQgcnVuczogaG9sZGluZyB0aGUgc2NvcGVkXG4vLyBgL2V2ZW50cz9wcm9qZWN0PTxpZD5gIHRhaWwgb3BlbiBpcyB3aGF0IG1hcmtzIHRoZSBjYXJkIGFjdGl2ZSAocGVyIHRoZSBkYWVtb25cbi8vIGNvbnRyYWN0IOKAlCBwcmVzZW5jZSBJUyB0aGUgbGl2ZSBjb25uZWN0aW9uKSwgYW5kIHRoZSBzYW1lIHRhaWwgZGVsaXZlcnMgcG9rZXMuXG4vL1xuLy8gSWRlbnRpdHk6IC0tYXMgLyAtLWZyb20gKG9yICRBU1RST0xBQkVfQVMpIHN0YW1wcyB0aGUgZXZlbnQgYGJ5YCBhbmQgZHJpdmVzXG4vLyBzZWxmLWVjaG8gc3VwcHJlc3Npb24uIC0tc3RkaW4gcmVhZHMgZnJlZSB0ZXh0IChkZXNjcmlwdGlvbi9zdW1tYXJ5KSBmcm9tXG4vLyBzdGRpbiAoYnlwYXNzZXMgc2hlbGwgcXVvdGluZykuIERpc2NpcGxpbmU6IHN0cnVjdHVyZWQgSlNPTiBvbiBzdGRvdXQgKG9uZVxuLy8gbGluZSk7IGxpdmVuZXNzLCBlY2hvZXMgYW5kIGtlZXBhbGl2ZXMgb24gc3RkZXJyOyBmYWlsdXJlcyBwdXQgT05FIEpTT04gZXJyb3Jcbi8vIGVudmVsb3BlIG9uIHN0ZGVyciB3aXRoIHN0ZG91dCBsZWZ0IGVtcHR5IOKAlCBuZXZlciBtZXJnZSBzdHJlYW1zLiBFeGl0IDIgb25cbi8vIGJhZCBhcmdzLCBhIGJhcmUgaW52b2NhdGlvbiwgT1IgYSByZWplY3RlZCBjb21tYW5kIChkZWR1cGUgLyB1bmtub3duIGlkKTtcbi8vIDAgb24gc3VjY2VzczsgMSBvbiBpbnRlcm5hbCBmYXVsdHMgKGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQpOyBhIHRhaWwgZXhpdHMgMFxuLy8gb24gdGhlIGRhZW1vbidzIGBjbG9zZWRgIGZyYW1lLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50c1wiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFwiLi5cIiwgXCJzY3JpcHRzXCIg4oCUIE5PVCBhIHNpYmxpbmcgbG9va3VwLiBUaGlzIGZpbGUgaXMgQVVUSE9SRUQgaGVyZSBhbmRcbi8vIEVYRUNVVEVTIGFzIGAuLi9kaXN0L2NsaS5qc2AgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIGFuZFxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlXG4vLyBwYXRoIGluIHRoaXMgZmlsZSAoU0tJTExfUk9PVCwgRElTVF9ESVIsIFNVUkZBQ0VfQ1dELCBwbHVnaW4uanNvbikgaXNcbi8vIHVuY2hhbmdlZCBieSB0aGUgbW92ZS4gQSBTSUJMSU5HLXJlbGF0aXZlIG9uZSBpcyBub3Q6IGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgcmVzb2x2ZWQgdG8gYGRpc3Qvc2VydmVyLnRzYCBhbmQgdGhlIGRhZW1vbiB3b3VsZCBuZXZlclxuLy8gc3Bhd24uIEdvaW5nIHVwIGFuZCBiYWNrIGRvd24gaXMgY29ycmVjdCBmcm9tIEJPVEggbG9jYXRpb25zLlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIGRldjogdGhlIGRhZW1vbiBzZXJ2ZXMgYSBCdW4tYnVuZGxlZCBSZWFjdCBzdXJmYWNlLCBhbmQgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvYXN0cm9sYWJlLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IChtZWFzdXJlZCBvbiBnbGFtb3VyOiB0aGUgcGFnZSA1MDBzXG4vLyB3aXRoIG5vIHN0eWxlc2hlZXQgbGluazsgYXN0cm9sYWJlJ3Mgb3duIGZhaWx1cmUgc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzXG4vLyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZVxuLy8gYW55d2F5IHdvdWxkIGJyZWFrIHRoZSBzcGF3bi5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJhc3Ryb2xhYmVcIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgQVNUUk9MQUJFX0hPTUUgPSBwcm9jZXNzLmVudi5BU1RST0xBQkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuYXN0cm9sYWJlXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcblxuLy8gRmFpbHVyZXMgbGVhdmUgc3Rkb3V0IGVtcHR5IGFuZCBwdXQgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIOKAlCB0aGUgc2FtZVxuLy8gbWFjaGluZSBzaGFwZSBhcyB0aGUgZGF0YSBwYXRoLCBzbyBhIHBpcGVkIGNhbGxlciBwYXJzZXMgdGhlIGVycm9yIGluc3RlYWQgb2Zcbi8vIHNjcmFwaW5nIHByb3NlLiBUSEUgRU5WRUxPUEUsIFRIRSBUQVhPTk9NWSBBTkQgVEhFIEVYSVQgQ09ERVMgQVJFIE5PVyBTSEFSRURcbi8vIChgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApOyBhc3Ryb2xhYmUncyBmb3VydGgsIG1pbmltYWwgY29weSBpcyBnb25lLiBUd29cbi8vIHRoaW5ncyBjaGFuZ2VkIGFuZCBib3RoIGFyZSBhZGRpdGl2ZTogdGhlIGVudmVsb3BlIGdhaW5zIGBleGl0X2NvZGVgLFxuLy8gYHJldHJ5YWJsZWAgYW5kIGBtZXRhLmNvbW1hbmRgLCBhbmQgYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3IgdGhhdCBgbWFpbmBcbi8vIHJlcG9ydHMsIHJhdGhlciB0aGFuIGV4aXRpbmcgZnJvbSB3aGVyZXZlciBpdCB3YXMgY2FsbGVkLiBga2luZGAgYW5kXG4vLyBgbWVzc2FnZWAg4oCUIHRoZSB0d28gZmllbGRzIGFueXRoaW5nIGNhbiBiZSBrZXlpbmcgb24g4oCUIGFyZSB1bnRvdWNoZWQuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKSA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG4vLyBpZCArIGF2YXRhciBhcmUgREVSSVZFRCBieSB0aGUgZGFlbW9uIChzdGF0ZS50cykgZnJvbSB0aGUgcHJvamVjdCBuYW1lLCBzbyB0aGVcbi8vIGNsaSBwYXNzZXMgaWQvYXZhdGFyIHRocm91Z2ggb25seSB3aGVuIHRoZSBjYWxsZXIgZ2F2ZSB0aGVtIGV4cGxpY2l0bHkg4oCUIG9uZVxuLy8gc291cmNlIG9mIHRydXRoLCBubyBzbHVnL2F2YXRhciBtaXJyb3IgdG8gZHJpZnQuXG5cbmZ1bmN0aW9uIHJlc29sdmVBcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB2ID0gZmxhZ3MuYXMgPz8gZmxhZ3MuZnJvbTtcbiAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiICYmIHYudHJpbSgpKSByZXR1cm4gdi50cmltKCk7XG4gIGNvbnN0IGVudiA9IHByb2Nlc3MuZW52LkFTVFJPTEFCRV9BUztcbiAgcmV0dXJuIGVudj8udHJpbSgpID8gZW52LnRyaW0oKSA6IHVuZGVmaW5lZDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW107XG4gIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgQnVuLnN0ZGluLnN0cmVhbSgpKSBjaHVua3MucHVzaChjaHVuayk7XG4gIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKTtcbn1cblxuLy8g4pSA4pSAIGRhZW1vbiBkaXNjb3ZlcnkgKyBIVFRQIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiByZWFkUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gTnVtYmVyLnBhcnNlSW50KChhd2FpdCBCdW4uZmlsZShQT1JUX0ZJTEUpLnRleHQoKSkudHJpbSgpLCAxMCk7XG4gICAgcmV0dXJuIHAgPiAwID8gcCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGlzVXAocG9ydDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIChhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3N0YXRlYCkpLm9rO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgcnVubmluZyBkYWVtb24sIG9yIGF1dG8tc3Bhd24gb25lIChkZXRhY2hlZCBzbyBpdCBvdXRsaXZlcyB0aGlzIENMSSDigJRcbi8vIG5vZGU6Y2hpbGRfcHJvY2Vzcywgbm90IEJ1bi5zcGF3biwgd2hpY2ggY2FuJ3QgZGV0YWNoIGEgc3Vydml2aW5nIGRhZW1vbikuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24oKTogUHJvbWlzZTx7IGJhc2U6IHN0cmluZzsgcG9ydDogbnVtYmVyIH0+IHtcbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkUG9ydCgpO1xuICBpZiAoZXhpc3RpbmcgJiYgKGF3YWl0IGlzVXAoZXhpc3RpbmcpKSkge1xuICAgIHJldHVybiB7IGJhc2U6IGBodHRwOi8vMTI3LjAuMC4xOiR7ZXhpc3Rpbmd9YCwgcG9ydDogZXhpc3RpbmcgfTtcbiAgfVxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCJdLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQSB3cm9uZyBjd2Qgc2tpcHMgYnVuZmlnLnRvbWwncyBUYWlsd2luZFxuICAgIC8vIHBsdWdpbjsgb24gZ2xhbW91ciB0aGF0IGZhaWxzIHRoZSBwYWdlIG91dHJpZ2h0ICg1MDApLiBBc3NlcnQgdGhlIGludmFyaWFudCxcbiAgICAvLyBub3QgdGhlIHN0YXR1czogdGhlIHV0aWxpdHkgbmV2ZXIgcmVhY2hlcyB0aGUgYnJvd3NlciB3aGVuIGN3ZCBpcyB3cm9uZy5cbiAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBUaGUgZGFlbW9uIEJJTkRTIGZhc3QgYW5kIGFuc3dlcnMgL3N0YXRlIGFzIHNvb24gYXMgaXQncyBsaXN0ZW5pbmcgKHRoZVxuICAvLyBjb2xkIFRhaWx3aW5kK1JlYWN0IGJ1bmRsZSBpcyBsYXp5LCBvbiB0aGUgZmlyc3QgR0VUIFwiL1wiKSwgc28gdGhpcyBoYW5kc2hha2VcbiAgLy8gdXN1YWxseSByZXR1cm5zIHF1aWNrbHkuIFRoZSB3aWRlIGRlYWRsaW5lIGNvdmVycyBhIGNvbGQgbWFjaGluZSB3aGVyZVxuICAvLyBtb2R1bGUgbG9hZCArIGZpcnN0IHNlcnZlIHJ1bnMgc2xvdyAoZ2xhbW91ciB1c2VzIHRoZSBzYW1lIH40NXMgYnVkZ2V0KS5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBzbGVlcCg4MCk7XG4gICAgY29uc3QgcCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gICAgaWYgKHAgJiYgKGF3YWl0IGlzVXAocCkpKSByZXR1cm4geyBiYXNlOiBgaHR0cDovLzEyNy4wLjAuMToke3B9YCwgcG9ydDogcCB9O1xuICB9XG4gIGRpZShcImFzdHJvbGFiZSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiA0NXNcIiwgXCJpbnRlcm5hbFwiKTtcbn1cblxuLy8gQSByZWFkLW9ubHkgdmVyYiByZXF1aXJlcyBhIGxpdmUgZGFlbW9uIGJ1dCBtdXN0IG5vdCBzcGF3biBvbmUgKG5vdGhpbmcgdG9cbi8vIG9ic2VydmUgeWV0KSDigJQgc28gYHN0YXRlYC9gbGlzdGAvYGluZm9gIG9uIGEgY29sZCBtYWNoaW5lIHJlcG9ydCBjbGVhbmx5LlxuYXN5bmMgZnVuY3Rpb24gcnVubmluZ0Jhc2UoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHAgPSBhd2FpdCByZWFkUG9ydCgpO1xuICByZXR1cm4gcCA/IGBodHRwOi8vMTI3LjAuMC4xOiR7cH1gIDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChiYXNlOiBzdHJpbmcsIGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L2NtZGAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgfSk7XG4gIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyBvazogYm9vbGVhbjsgYXBwbGllZDogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmc7IG91dGNvbWU/OiBzdHJpbmcgfTtcbn1cblxuLy8gQXBwbHkgYSAvY21kLCBzdXJmYWNlIGEgcmVqZWN0aW9uIG9uIHN0ZGVyciArIG5vbi16ZXJvIGV4aXQgKGV4aXQtY29kZVxuLy8gY29udHJhY3QpLCBhbmQgZWNobyB0aGUgc3RydWN0dXJlZCByZXN1bHQgb24gc3Rkb3V0IG9uIHN1Y2Nlc3MuXG5hc3luYyBmdW5jdGlvbiBjbWQoYmFzZTogc3RyaW5nLCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCByID0gYXdhaXQgcG9zdENtZChiYXNlLCBib2R5KTtcbiAgLy8gYjIvIzg1IOKAlCBESVNUSU5HVUlTSCBUSEUgVFdPIEtJTkRTIE9GIGFwcGxpZWQ6ZmFsc2UuIFdJVEggYW4gZXJyb3IgPSBhIHJlYWxcbiAgLy8gcmVqZWN0aW9uICh1bmtub3duIHByb2plY3QsIGR1cGxpY2F0ZSkgLT4gdmlzaWJsZSwgbm9uLXplcm8sIHVuY2hhbmdlZC5cbiAgLy8gV0lUSE9VVCBhbiBlcnJvciA9IGEgYmVuaWduIG5vLW9wOiB0aGUgc3RhdGUgd2FzIGFscmVhZHkgd2hhdCB3YXMgYXNrZWQgZm9yLFxuICAvLyB0aGUgcHJvamVjdCBleGlzdHMsIHRoZSBkYWVtb24gaXMgcmlnaHQsIGFuZCBub3RoaW5nIGlzIHdyb25nLiBUaGF0IHVzZWQgdG9cbiAgLy8gZXhpdCAyIHdpdGggXCJjb21tYW5kICdhdHRlbnRpb24nIHdhcyBub3QgYXBwbGllZFwiLCBzbyByZS1pc3N1aW5nIGFuXG4gIC8vIGFscmVhZHktYXBwbGllZCBjb21tYW5kIHdhcyBhIGhhcmQgZmFpbHVyZSDigJQgd2hpbGUgYm91bnR5IHRyZWF0cyB0aGVcbiAgLy8gaWRlbnRpY2FsIHBheWxvYWQgYXMgb3JkaW5hcnkgc3VjY2Vzcy5cbiAgLy9cbiAgLy8gVGhpcyBpcyBib3VudHkncyBkaXNjaXBsaW5lIChjbGkudHMgYHRhc2sudXBkYXRlYCksIHBvcnRlZCByYXRoZXIgdGhhblxuICAvLyByZS1kZXJpdmVkLiBJdCByZXBvcnRzIHRoZSBkYWVtb24ncyBgb3V0Y29tZWAgbm91biBpbnN0ZWFkIG9mIGJvdW50eSdzXG4gIC8vIGBub29wOiB0cnVlYCBib29sZWFuLCBwZXIgdGhlIG91dGNvbWUgY29udHJhY3QncyBcImVudW1lcmF0ZWQsIG5ldmVyIGFcbiAgLy8gYm9vbGVhblwiIOKAlCB0aGUgbm91biBzYXlzIFdISUNIIHN0YXRlIG1hZGUgdGhlIHdvcmsgdW5uZWNlc3NhcnkuXG4gIGlmICghci5hcHBsaWVkICYmIHIuZXJyb3IpIGRpZShyLmVycm9yKTtcbiAgcHJpbnRKc29uKHIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBvcGVuZXIgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgdHJ5IHtcbiAgICBzcGF3bihvcGVuZXIsIFt1cmxdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogXCJpZ25vcmVcIiB9KS51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIFNTRSByZWFkZXI6IHN0cmVhbSB0aGUgZXZlbnQgbG9nIGFzIEpTT05MIG9uIHN0ZG91dCwgcmVzdW1hYmxlICsgcmVjb25uZWN0aW5nXG4vLyDigJQgb25lIGNhbGwgaW50byB0aGUgaG91c2UncyBzaGFyZWQgdGFpbCBjbGllbnQgKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLFxuLy8gd2hpY2ggaXMgd2hlcmUgdGhlIGxvb3AsIHRoZSBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmRcbi8vIHRoZSBkcmFpbmVkIGV4aXQgbm93IGxpdmUsIE9OQ0UsIGZvciBldmVyeSBzcGVsbC5cbi8vXG4vLyBgc2NvcGVJZGAgKHNldCBieSBgam9pbmApIGZpbHRlcnMgdG8gdGhpcyBwcm9qZWN0J3MgZnJhbWVzICsgbGlmZWN5Y2xlOyBhblxuLy8gdW5zY29wZWQgdGFpbCBwYXNzZXMgZXZlcnl0aGluZy4gU2VsZi1lY2hvIChmcmFtZXMgdGhlIGNhbGxlcidzIG93biAtLWFzXG4vLyBjYXVzZWQpIGlzIHN1cHByZXNzZWQuIGA6YCBrZWVwYWxpdmVzIHJpZGUgc3RkZXJyOyByZXR1cm5zIDAgb24gYGNsb3NlZGAuXG4vL1xuLy8g4puUIGByZXNvbHZlYCBJUyBgcnVubmluZ0Jhc2VgLCBSRS1SRUFEIE9OIEVWRVJZIEFUVEVNUFQg4oCUIHRoaXMgaXMgdGhlIEIxIGZpeFxuLy8gYW5kIHRoZSByZWFzb24gYXN0cm9sYWJlIHdlbnQgZmlyc3QuIGFzdHJvbGFiZSBiaW5kcyBhbiBFUEhFTUVSQUwgcG9ydCwgYW5kXG4vLyB0aGlzIGZ1bmN0aW9uIHVzZWQgdG8gdGFrZSBhIGNhcHR1cmVkIGBiYXNlOiBzdHJpbmdgLCBzbyBhZnRlciBhbnkgZGFlbW9uXG4vLyByZXN0YXJ0IGBqb2luYCByZWNvbm5lY3RlZCB0byBhIGRlYWQgcG9ydCBmb3JldmVyIGFuZCBzdHJlYW1lZCBub3RoaW5nIHdoaWxlXG4vLyBsb29raW5nIHBlcmZlY3RseSBhbGl2ZS4gSXQgY2Fubm90OiB0aGUgY2FsbGJhY2sgcmUtcmVhZHNcbi8vIGAkQVNUUk9MQUJFX0hPTUUvZGFlbW9uLnBvcnRgIGJlZm9yZSBldmVyeSBjb25uZWN0LiBEcml2ZW4gaW4gYGNsaS50ZXN0LnRzYC5cbi8vXG4vLyBJdCBkZWxpYmVyYXRlbHkgZG9lcyBOT1Qgc3Bhd24uIGBqb2luYC9gdGFpbGAgc3RpbGwgY2FsbCBgZW5zdXJlRGFlbW9uKClgXG4vLyBvbmNlIHVwIGZyb250IChhIHRhaWwgd2l0aCBubyBkYWVtb24gYXQgYWxsIGlzIHdvcnRoIHJlcG9ydGluZyk7IGEgZGFlbW9uXG4vLyB0aGF0IGRpZXMgTUlELXdhdGNoIGlzIGEgd2FpdCwgbm90IGEgcmVzcGF3biwgYmVjYXVzZSBhIHNlY29uZCBhc3Ryb2xhYmVcbi8vIHNwYXduZWQgZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBpcyBhIHdvcnNlIG91dGNvbWUgdGhhbiBhIHdhdGNoIHRoYXRcbi8vIHJlc3VtZXMgd2hlbiB0aGUgaHVtYW4gcmVvcGVucyB0aGUgYm9hcmQuXG5hc3luYyBmdW5jdGlvbiBzdHJlYW1FdmVudHMob3B0czoge1xuICBzaW5jZTogbnVtYmVyO1xuICBwcm9qZWN0Pzogc3RyaW5nO1xuICBzY29wZUlkPzogc3RyaW5nO1xuICBzZWxmPzogc3RyaW5nO1xufSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHR5cGUgRXYgPSB7IGlkPzogbnVtYmVyOyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZzsgcHJvamVjdElkPzogc3RyaW5nIH07XG5cbiAgY29uc3QgaW5TY29wZSA9IChldjogRXYpID0+IHtcbiAgICBpZiAoIW9wdHMuc2NvcGVJZCkgcmV0dXJuIHRydWU7XG4gICAgaWYgKGV2LnR5cGUgPT09IFwicmVhZHlcIiB8fCBldi50eXBlID09PSBcImNsb3NlZFwiKSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gZXYucHJvamVjdElkID09PSBvcHRzLnNjb3BlSWQ7XG4gIH07XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICByZXNvbHZlOiBydW5uaW5nQmFzZSxcbiAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICBzaW5jZTogb3B0cy5zaW5jZSxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiBldi5pZCxcbiAgICBxdWVyeTogKGN1cnNvcikgPT4gKHtcbiAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIC4uLihvcHRzLnByb2plY3QgPyB7IHByb2plY3Q6IG9wdHMucHJvamVjdCB9IDoge30pLFxuICAgIH0pLFxuICAgIGFjY2VwdDogKGV2KSA9PiBpblNjb3BlKGV2KSAmJiAhKG9wdHMuc2VsZiAhPT0gdW5kZWZpbmVkICYmIGV2LmJ5ID09PSBvcHRzLnNlbGYpLFxuICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgLy8gVGhlIGRhZW1vbiBoZWFydGJlYXRzIGV2ZXJ5IDE1cywgc28gdGhpcyBpcyB0aHJlZSBtaXNzZWQgYmVhdHMuIOKaoCBJVCBNVVNUXG4gICAgLy8gU1RBWSBXRUxMIEFCT1ZFIFRIQVQ6IGhvbGRpbmcgdGhlIGNvbm5lY3Rpb24gb3BlbiBJUyBgam9pbmAncyBwcmVzZW5jZVxuICAgIC8vIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsXG4gICAgLy8gd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldCBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHlcbiAgICAvLyBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLlxuICAgIGlkbGVNczogNDVfMDAwLFxuICAgIG9uQ29tbWVudDogKCkgPT4gcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCI6IGFzdHJvbGFiZS1rZWVwYWxpdmVcXG5cIiksXG4gIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHsgcG9ydCB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGlmICghZmxhZ3NbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3NlcihgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IG5hbWUgPSBwb3Muam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dXCIpO1xuICBjb25zdCBwYXRoID0gdHlwZW9mIGZsYWdzLnBhdGggPT09IFwic3RyaW5nXCIgPyBmbGFncy5wYXRoLnRyaW0oKSA6IFwiXCI7XG4gIGlmICghcGF0aCkgZGllKFwiYWRkIHJlcXVpcmVzIC0tcGF0aCA8cD5cIik7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gZmxhZ3Muc3RkaW5cbiAgICA/IGF3YWl0IHJlYWRTdGRpbigpXG4gICAgOiB0eXBlb2YgZmxhZ3MuZGVzY3JpcHRpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MuZGVzY3JpcHRpb25cbiAgICAgIDogdW5kZWZpbmVkO1xuICAvLyBpZCArIGF2YXRhciBhcmUgb3B0aW9uYWwg4oCUIHRoZSBkYWVtb24gZGVyaXZlcyBib3RoIGZyb20gdGhlIG5hbWUgd2hlbiBvbWl0dGVkLlxuICBjb25zdCBhdmF0YXIgPSB0eXBlb2YgZmxhZ3MuYXZhdGFyID09PSBcInN0cmluZ1wiID8gZmxhZ3MuYXZhdGFyIDogdW5kZWZpbmVkO1xuICBjb25zdCBpZCA9IHR5cGVvZiBmbGFncy5pZCA9PT0gXCJzdHJpbmdcIiAmJiBmbGFncy5pZC50cmltKCkgPyBmbGFncy5pZC50cmltKCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7XG4gICAgdHlwZTogXCJwcm9qZWN0LmFkZFwiLFxuICAgIHByb2plY3Q6IHsgaWQsIG5hbWUsIHBhdGgsIGRlc2NyaXB0aW9uLCBhdmF0YXIgfSxcbiAgICBhczogcmVzb2x2ZUFzKGZsYWdzKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlbW92ZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiByZW1vdmUgPGlkPlwiKTtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJwcm9qZWN0LnJlbW92ZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXR1cyhwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBzdGF0dXMgPGlkPiA8c3VtbWFyeS4uLj4gWy0tcGhhc2UgLi5dIFstLXN0ZGluXVwiKTtcbiAgY29uc3Qgc3VtbWFyeSA9IGZsYWdzLnN0ZGluID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIXN1bW1hcnkpIGRpZShcInN0YXR1cyByZXF1aXJlcyBhIHN1bW1hcnkgKHBvc2l0aW9uYWwgb3IgLS1zdGRpbilcIik7XG4gIGNvbnN0IHBoYXNlID0gdHlwZW9mIGZsYWdzLnBoYXNlID09PSBcInN0cmluZ1wiID8gZmxhZ3MucGhhc2UgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwic3RhdHVzXCIsIGlkLCBzdW1tYXJ5LCBwaGFzZSwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEF0dGVudGlvbihwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBhdHRlbnRpb24gPGlkPiBbLS1jbGVhcl0gWy0tcXVlc3Rpb24gLi4uXVwiKTtcbiAgY29uc3QgcmFpc2VkID0gZmxhZ3MuY2xlYXIgIT09IHRydWU7XG4gIGNvbnN0IHF1ZXN0aW9uID1cbiAgICB0eXBlb2YgZmxhZ3MucXVlc3Rpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MucXVlc3Rpb25cbiAgICAgIDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwiYXR0ZW50aW9uXCIsIGlkLCByYWlzZWQsIHF1ZXN0aW9uLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUG9rZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBwb2tlIDxpZD5cIik7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwicG9rZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKCkge1xuICBjb25zdCBiYXNlID0gYXdhaXQgcnVubmluZ0Jhc2UoKTtcbiAgaWYgKCFiYXNlIHx8ICEoYXdhaXQgaXNVcChOdW1iZXIucGFyc2VJbnQoYmFzZS5zcGxpdChcIjpcIikucG9wKCkgYXMgc3RyaW5nLCAxMCkpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSwgc3RhdGU6IHsgdGl0bGU6IFwiT2JzZXJ2YXRvcnlcIiwgcHJvamVjdHM6IFtdIH0gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L3N0YXRlYCk7XG4gIGlmICghcmVzLm9rKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWApO1xuICBwcmludEpzb24oYXdhaXQgcmVzLmpzb24oKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IGJhc2UgPSBhd2FpdCBydW5uaW5nQmFzZSgpO1xuICAvLyBHdWFyZCB3aXRoIGlzVXAoKSBiZWZvcmUgZmV0Y2hpbmcgKG1pcnJvcnMgY21kU3RhdGUpOiBhIFNUQUxFIGRhZW1vbi5wb3J0XG4gIC8vIGZyb20gYSBjcmFzaGVkIGRhZW1vbiB3b3VsZCBvdGhlcndpc2UgdGhyb3cgRUNPTk5SRUZVU0VEIGhlcmUgaW5zdGVhZCBvZiB0aGVcbiAgLy8gY2xlYW4gcnVubmluZzpmYWxzZSBwYXRoLlxuICBpZiAoIWJhc2UgfHwgIShhd2FpdCBpc1VwKE51bWJlci5wYXJzZUludChiYXNlLnNwbGl0KFwiOlwiKS5wb3AoKSBhcyBzdHJpbmcsIDEwKSkpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IGZhbHNlLCBwcm9qZWN0czogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdGUgfSA9IChhd2FpdCAoYXdhaXQgZmV0Y2goYCR7YmFzZX0vc3RhdGVgKSkuanNvbigpKSBhcyB7XG4gICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9O1xuICB9O1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHJ1bm5pbmc6IHRydWUsXG4gICAgcHJvamVjdHM6IHN0YXRlLnByb2plY3RzLm1hcCgocCkgPT4gKHtcbiAgICAgIGlkOiBwLmlkLFxuICAgICAgbmFtZTogcC5uYW1lLFxuICAgICAgem9uZTogcC56b25lLFxuICAgICAgY29ubmVjdGVkOiBwLmNvbm5lY3RlZCxcbiAgICB9KSksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgYmFzZSA9IGF3YWl0IHJ1bm5pbmdCYXNlKCk7XG4gIGlmICghYmFzZSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IFwibm8gZGFlbW9uIHJ1bm5pbmdcIiB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoYmFzZSwgeyB0eXBlOiBcImNsb3NlXCIsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5mbygpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gIGlmIChwb3J0ICYmIChhd2FpdCBpc1VwKHBvcnQpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xuICB9IGVsc2Uge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSB9KTtcbiAgfVxufVxuXG5jb25zdCBIRUxQID0gYGFzdHJvbGFiZSDigJQgYSBzdGFuZGluZyBvYnNlcnZhdG9yeSBib2FyZCBmb3IgcHJvamVjdHMgaW4gZmxpZ2h0LlxuXG4gIG9wZW4gWy0tbm8tb3Blbl1cbiAgICAgIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHVwICsgb3BlbiB0aGUgYm9hcmQgaW4gdGhlIGJyb3dzZXJcbiAgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlZ2lzdGVyIGEgcHJvamVjdCAoZGVkdXBlLWd1YXJkZWQ7IGlkICsgYXZhdGFyIGRlcml2ZWQgZnJvbSB0aGUgbmFtZSB3aGVuIG9taXR0ZWQpLlxuICAgICAgdGhlIHJlc3BvbnNlIGVjaG9lcyB0aGUgZGVyaXZlZCBpZCDigJQgeW91IG5lZWQgaXQgZm9yIGpvaW4vc3RhdHVzL2F0dGVudGlvbi9yZW1vdmUuXG4gIHJlbW92ZSA8aWQ+XG4gICAgICB1bnJlZ2lzdGVyIGEgcHJvamVjdFxuICBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXVxuICAgICAgYWN0aXZhdGUgdGhlIGNhcmQgKyBsaXN0ZW4gZm9yIHBva2VzIChzY29wZWQgdGFpbDsgd3JhcCB3aXRoIE1vbml0b3IpLiBlbmQgaXQgdG8gaWRsZSB0aGUgY2FyZC5cbiAgc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlcGxhY2UgYSBwcm9qZWN0J3MgY3VycmVudCBzdGF0dXNcbiAgYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl1cbiAgICAgIHJhaXNlIC8gY2xlYXIgdGhlIG5lZWRzLXlvdSBnYXRlICgtLXF1ZXN0aW9uIGF0dGFjaGVzIHRoZSBwcm9tcHQpXG4gIHBva2UgPGlkPlxuICAgICAgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbiAgc3RhdGVcbiAgICAgIHJlYWQtYmFjazogcHJvamVjdCBjYXJkcyAoZWFjaCBjYXJyaWVzIGEgZGVyaXZlZCB6b25lOiBhdHRlbnRpb24gfCBhY3RpdmUgfCBxdWlldClcbiAgdGFpbCBbLS1zaW5jZSBOXSBbLS1hcyA8bmFtZT5dXG4gICAgICB1bnNjb3BlZCBldmVudCB0YWlsIGFzIEpTT05MIChubyBwcmVzZW5jZSlcbiAgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHAgfCAtLXZlcnNpb25cblxuICBJZGVudGl0eTogLS1hcyAvIC0tZnJvbSAob3IgJEFTVFJPTEFCRV9BUykgc3RhbXBzIHRoZSBhY3RvciArIHN1cHByZXNzZXMgc2VsZi1lY2hvLlxuICAtLXN0ZGluIHJlYWRzIGEgZGVzY3JpcHRpb24vc3VtbWFyeSBmcm9tIHN0ZGluIChzaGVsbC1xdW90aW5nLXNhZmUpLlxuICBPdXRwdXQ6IGV2ZXJ5IGNvbW1hbmQgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBsaW5lIHBlciBhbnN3ZXI7XG4gIGZhaWx1cmVzIHB1dCBvbmUgSlNPTiBlcnJvciBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG4gIFRoZXJlIGlzIG5vIHByb3NlIG1vZGUgdG8gc3dpdGNoIG91dCBvZi5gO1xuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlIGRlZ3JhZGVzIHRvIFwidW5rbm93blwiLlxuYXN5bmMgZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogUHJvbWlzZTx7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwa2cgPSBhd2FpdCBCdW4uZmlsZShqb2luKFNDUklQVF9ESVIsIFwiLi4vLi4vLi4vLmNsYXVkZS1wbHVnaW4vcGx1Z2luLmpzb25cIikpLmpzb24oKTtcbiAgICBpZiAodHlwZW9mIHBrZz8udmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJhc3Ryb2xhYmVcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBuYW1lOiBcImFzdHJvbGFiZVwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG4vKipcbiAqIFRoZSBmYWlsdXJlIGZ1bm5lbC4gYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3Igbm93ICh0aGUgaG91c2UncyBvbmUgZXJyb3JcbiAqIGNvbnRyYWN0LCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIGluc3RlYWQgb2YgZXhpdGluZyBmcm9tIHdoZXJldmVyIGl0IHdhc1xuICogY2FsbGVkLCBzbyB0aGlzIGlzIHRoZSBPTkUgcGxhY2UgYSBmYWlsdXJlIGJlY29tZXMgYW4gZXhpdCBjb2RlIOKAlCBhbmQgdGhlXG4gKiBwcm9jZXNzIHN0aWxsIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucywgYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYVxuICogbmF0dXJhbCByZXR1cm4sIHdoaWNoIGlzIHdoYXQgZHJhaW5zIHN0ZG91dCBvbiBhIHBpcGUuXG4gKlxuICog4puUIEEgTk9OLUNsaUVycm9yIElTIFJFVEhST1dOLCBORVZFUiBFTlZFTE9QRUQuIFJlcG9ydGluZyBhbiB1bmtub3duIHRocm93IGFzXG4gKiBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSB3b3VsZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlID09PSBudWxsKSB0aHJvdyBlO1xuICAgIHJldHVybiBjb2RlO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdmVyYiA9IGFyZ3ZbMF07XG4gIHNldEN1cnJlbnRDb21tYW5kKHZlcmIgPz8gbnVsbCk7XG4gIC8vIEEgYmFyZSBpbnZvY2F0aW9uIHJlcXVlc3RlZCBub3RoaW5nIOKAlCB0aGF0IGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHBcbiAgLy8gcmVxdWVzdC4gaGVscCBzdGF5cyByZWFjaGFibGUgYnkgbmFtZSAoYW5kIC0taGVscC8taCkgb24gc3Rkb3V0IGF0IGV4aXQgMC5cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkgZGllKFwibm8gdmVyYiBnaXZlbiDigJQgdHJ5ICdoZWxwJ1wiKTtcbiAgaWYgKHZlcmIgPT09IFwiaGVscFwiIHx8IHZlcmIgPT09IFwiLS1oZWxwXCIgfHwgdmVyYiA9PT0gXCItaFwiKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICAvLyBSb290IHRva2VuLCBkZWxpYmVyYXRlbHkgTk9UIGEgZmxhZzogZGlzcGF0Y2hlZCBhbG9uZ3NpZGUgaGVscCBpbiB0aGUgdmVyYlxuICAvLyBzd2l0Y2gsIHNvIG5vIHBlci12ZXJiIHBhcnNlciBpcyBleHBlY3RlZCB0byBhY2NlcHQgaXQgYmVsb3cgdGhlIHJvb3QuXG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIiB8fCB2ZXJiID09PSBcInZlcnNpb25cIikge1xuICAgIHByaW50SnNvbihhd2FpdCB2ZXJzaW9uSW5mbygpKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LnNsaWNlKDEpLFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBwYXRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgZGVzY3JpcHRpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBhdmF0YXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHBoYXNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcXVlc3Rpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgfSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBkaWUoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgfVxuICBjb25zdCBmbGFncyA9IHBhcnNlZC52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIGNvbnN0IHBvcyA9IHBhcnNlZC5wb3NpdGlvbmFscyBhcyBzdHJpbmdbXTtcbiAgY29uc3Qgc2luY2UgPSB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhZGRcIjpcbiAgICAgIGF3YWl0IGNtZEFkZChwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJyZW1vdmVcIjpcbiAgICAgIGF3YWl0IGNtZFJlbW92ZShwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXR1cyhwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhdHRlbnRpb25cIjpcbiAgICAgIGF3YWl0IGNtZEF0dGVudGlvbihwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJwb2tlXCI6XG4gICAgICBhd2FpdCBjbWRQb2tlKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInN0YXRlXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0ZSgpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImxpc3RcIjpcbiAgICAgIGF3YWl0IGNtZExpc3QoKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgY21kQ2xvc2UoZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGF3YWl0IGNtZEluZm8oKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJqb2luXCI6IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zWzBdO1xuICAgICAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dXCIpO1xuICAgICAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIC8vIENvbmZpcm0gdGhlIHByb2plY3QgZXhpc3RzIGJlZm9yZSBob2xkaW5nIHRoZSB3YXRjaCAoYSB0eXBvJ2QgaWQgd291bGRcbiAgICAgIC8vIG90aGVyd2lzZSBiaW5kIG5vIHByZXNlbmNlIGFuZCBzaWxlbnRseSBzdHJlYW0gbm90aGluZyB1c2VmdWwpLlxuICAgICAgY29uc3QgeyBzdGF0ZSB9ID0gKGF3YWl0IChhd2FpdCBmZXRjaChgJHtiYXNlfS9zdGF0ZWApKS5qc29uKCkpIGFzIHtcbiAgICAgICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgICAgfTtcbiAgICAgIGlmICghc3RhdGUucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gaWQpKVxuICAgICAgICBkaWUoYHVua25vd24gcHJvamVjdCAnJHtpZH0nIOKAlCByZWdpc3RlciBpdCBmaXJzdGApO1xuICAgICAgcmV0dXJuIGF3YWl0IHN0cmVhbUV2ZW50cyh7IHNpbmNlLCBwcm9qZWN0OiBpZCwgc2NvcGVJZDogaWQsIHNlbGY6IHJlc29sdmVBcyhmbGFncykgfSk7XG4gICAgfVxuICAgIGNhc2UgXCJ0YWlsXCI6IHtcbiAgICAgIC8vIGVuc3VyZURhZW1vbiBmb3IgdGhlIFNUQVJUIG9mIHRoZSB3YXRjaCBvbmx5OyB0aGUgdGFpbCByZS1yZXNvbHZlcyB0aGVcbiAgICAgIC8vIGRhZW1vbiBvbiBldmVyeSByZWNvbm5lY3QgKHNlZSBzdHJlYW1FdmVudHMpLCBzbyBgYmFzZWAgaXMgbm90IGNhcnJpZWQuXG4gICAgICBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIHJldHVybiBhd2FpdCBzdHJlYW1FdmVudHMoeyBzaW5jZSwgc2VsZjogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIGRpZShgdW5rbm93biB2ZXJiICcke3ZlcmJ9JyDigJQgdHJ5ICdoZWxwJ2ApO1xuICB9XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG4vLyBFeHBvcnRlZCBzbyB0aGUgc2hpcHBlZCBsYXVuY2hlciAocGx1Z2lucy8uLi4vc2NyaXB0cy9jbGkudHMpIGNhbiBpbnZva2UgdGhlXG4vLyBCVU5ETEVEIGNvcHkgb2YgdGhpcyBtb2R1bGUuIFRoZSBpbXBvcnQubWV0YS5tYWluIGJsb2NrIGFib3ZlIHN0aWxsIHJ1bnMgdGhpc1xuLy8gZmlsZSBkaXJlY3RseSBkdXJpbmcgZGV2ZWxvcG1lbnQ7IHRoZSB0d28gZW50cnkgcm91dGVzIGFyZSBleGNsdXNpdmUsIGJlY2F1c2Vcbi8vIGltcG9ydC5tZXRhLm1haW4gaXMgZmFsc2UgZm9yIGFuIGltcG9ydGVkIG1vZHVsZS5cbmV4cG9ydCB7IG1haW4gfTtcblxuLyoqXG4gKiBUaGUgU0hJUFBFRCBFTlRSWSBQT0lOVCwgY2FsbGVkIGJ5IGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYXN0cm9sYWJlL3NjcmlwdHMvY2xpLnRzYFxuICogYWZ0ZXIgdGhlIGJ1bmRsZSBpcyBpbXBvcnRlZC5cbiAqXG4gKiDim5QgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQuIGFyZ3YgYmVsb25ncyB0byB3aGljaGV2ZXIgZmlsZVxuICogUEFSU0VTIGl0LCBhbmQgdGhhdCBpcyB0aGlzIG9uZS4gQW4gZWFybGllciBsYXVuY2hlciByZWFkXG4gKiBgcHJvY2Vzcy5hcmd2LnNsaWNlKDIpYCBpdHNlbGYgYW5kIHBhc3NlZCBpdCBpbiDigJQgd2hpY2ggbWFkZSB0aGUgbGF1bmNoZXIgbWF0Y2hcbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIFBBUlNFU19BUkdTIHByZWRpY2F0ZSAoYHByb2Nlc3MuYXJndmApLCBzbyB0aGVcbiAqIHJvc3RlciBjb3VudGVkIGEgMy1saW5lIGZvcndhcmRlciBhcyBhbiBhcmctcGFyc2luZyBlbnRyeSBwb2ludCBhbmQgdGhlblxuICogcmVwb3J0ZWQgdGhlIHNwZWxsJ3MgZG9jdW1lbnRlZCBmbGFncyBhcyBVTlJFU09MVkVEIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS4gS2VlcGluZyBhcmd2IG9uIHRoaXMgc2lkZSBtYWtlcyB0aGUgZW51bWVyYXRvcidzIGFuc3dlciB0cnVlXG4gKiBpbnN0ZWFkIG9mIG1ha2luZyBpdHMgcmVnZXggbG9vc2VyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGlubGluZSBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgZGVwZW5kZW5jeS1mcmVlIGFuZCBkZWxpYmVyYXRlbHkgZHVsbDogaXQgaXMgYnVuZGxlZCBJTlRPIGVhY2hcbiAqIHNwZWxsJ3MgZW1pdHRlZCBDTEkgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIHNvIGFueXRoaW5nIGl0XG4gKiByZWFjaGVkIGZvciB3b3VsZCBiZWNvbWUgYSBkZXBlbmRlbmN5IG9mIHR3byBzaGlwcGVkIGFydGlmYWN0cyBhdCBvbmNlLlxuICpcbiAqIFRoZSB3aXJlIGNvbnRyYWN0IGl0IGVuY29kZXM6IGV4YWN0bHkgb25lIEpTT04gZG9jdW1lbnQsIG9uZSB0cmFpbGluZ1xuICogbmV3bGluZSwgbm90aGluZyBlbHNlIG9uIHN0ZG91dC4gQSBjYWxsZXIgcmVhZGluZyBvdXIgc3Rkb3V0IHdpdGggYVxuICogbGluZS1kZWxpbWl0ZWQgcGFyc2VyIGRlcGVuZHMgb24gdGhhdCBuZXdsaW5lOyBhIGNhbGxlciByZWFkaW5nIHRvIEVPRlxuICogZGVwZW5kcyBvbiB0aGVyZSBiZWluZyBubyBzZWNvbmQgZG9jdW1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bik6IHZvaWQge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gaW5saW5lXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhIHNpbGVudFxuICogY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4gRXZlcnkgY2FsbCBzaXRlIGluIGFuIGFkb3B0aW5nIHNwZWxsIG11c3QgYmVcbiAqIHJlYWQgZm9yIHRoYXQgYmVmb3JlIGl0IGFkb3B0cy4gQXVkaXRlZCBmb3IgYXN0cm9sYWJlICgxNiBzaXRlcykgYW5kIG1hZ3BpZVxuICogKDMwKSBvbiBhZG9wdGlvbjogZXZlcnkgb25lIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCxcbiAqIGZyb20gd2hpY2ggdGhlIHRocm93IHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqIEV4dHJhIGZpZWxkcyBhIGZhaWx1cmUgbWF5IGNhcnJ5LiBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiAgYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBpbmxpbmUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LXRhaWwtcmVhZGVyLWNvbnZlcmdlbmNlLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1biAxLjMuMTQgZmluZGluZyB0aGF0XG4gKiBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuIEl0IGlzIGEgREFFTU9OLXNpZGVcbiAqIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvbiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55XG4gKiBjbGllbnQuIEl0IHN0YXlzIHdoZXJlIGl0IHdhcyBtZWFzdXJlZC5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC4gKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKiogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiBSZXR1cm5pbmcgYSBzdHJpbmdcbiAgICogIGVtaXRzIGl0LiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhXG4gICAqICBQRVJNQU5FTlRMWSBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlXG4gICAqICBkYWVtb24ncyBsaWZlOyBhIHNwZWxsIHRoYXQgY2FuIGhhcHBlbiB0byBzaG91bGQgbG9nIGl0LiAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlblxuICAgKiAgdGhvdWdoIHRoZSBkYXRhIGZpbHRlciBkaXNjYXJkcyB0aGVtIOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXNcbiAgICogIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgb3V0PzogU2luaztcbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7IGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7IGNvbW1lbnRzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQgYW5kIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQ7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZCBSRVRVUk5TLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICB9O1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHJldHVybiBjb2RlO1xuICAgICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSwgd2hpY2ggaXMgYSAyNTBtcyByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudFxuICAgICAgICAgIC8vIGludGVydmFsLlxuICAgICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNczsgLy8gcmVzZXQgb24gYSBzdWNjZXNzZnVsIG9wZW5cbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIGJyZWFrO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBvcHRzLm9uQ29tbWVudD8uKHRleHQpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpID8/IG51bGw7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIGZpbHRlciBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2KSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQWtDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2hCTyxTQUFTLFNBQVMsQ0FBQyxNQUFx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
