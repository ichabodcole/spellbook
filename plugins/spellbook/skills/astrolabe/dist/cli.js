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
function die(msg, kind = "usage", code = 2) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { kind, message: msg } })}
`);
  process.exit(code);
}
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
  die("astrolabe daemon failed to start within 45s", "internal", 1);
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
async function streamEvents(base, opts) {
  let since = opts.since;
  let delay = 250;
  const stop = () => process.exit(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const inScope = (ev) => {
    if (!opts.scopeId)
      return true;
    if (ev.type === "ready" || ev.type === "closed")
      return true;
    return ev.projectId === opts.scopeId;
  };
  for (;; ) {
    const projectQ = opts.project ? `&project=${encodeURIComponent(opts.project)}` : "";
    let res;
    try {
      res = await fetch(`${base}/events?since=${since}${projectQ}`);
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!res.ok || !res.body) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    delay = 250;
    const reader = res.body.getReader();
    const dec = new TextDecoder;
    let buf = "";
    for (;; ) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done)
        break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf(`

`);sep >= 0; sep = buf.indexOf(`

`)) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = [];
        for (const line of block.split(`
`)) {
          if (line.startsWith(":")) {
            process.stderr.write(`: astrolabe-keepalive
`);
            continue;
          }
          if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length)
          continue;
        const payload = dataLines.join(`
`);
        try {
          const ev = JSON.parse(payload);
          if (typeof ev.id === "number" && ev.id > since)
            since = ev.id;
          const selfEcho = opts.self !== undefined && ev.by === opts.self;
          const emit = inScope(ev) && !selfEcho;
          if (ev.type === "closed") {
            if (emit)
              process.stdout.write(`${payload}
`, () => process.exit(0));
            else
              process.exit(0);
            return;
          }
          if (emit)
            process.stdout.write(`${payload}
`);
        } catch {}
      }
    }
    await sleep(delay);
  }
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
  const verb = argv[0];
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
      await streamEvents(base, { since, project: id, scopeId: id, self: resolveAs(flags) });
      return 0;
    }
    case "tail": {
      const { base } = await ensureDaemon();
      await streamEvents(base, { since, self: resolveAs(flags) });
      return 0;
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

//# debugId=5972CD14558DA2F164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGFzdHJvbGFiZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgc3RhbmRpbmcgb2JzZXJ2YXRvcnlcbi8vIGRhZW1vbidzIEhUVFAgc3VyZmFjZSAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgYm9hcmQgdGhyb3VnaCB0aGVzZVxuLy8gdmVyYnM7IGBqb2luYC9gdGFpbGAgc3RyZWFtIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwLlxuLy9cbi8vIERpc2NvdmVyeSArIGxpZmVjeWNsZTogYSBTSU5HTEVUT04gZGFlbW9uIHBlciAkQVNUUk9MQUJFX0hPTUUuIFRoZSBmaXJzdCB2ZXJiXG4vLyB0aGF0IG5lZWRzIGl0IGF1dG8tc3Bhd25zIGl0IChkZXRhY2hlZCwgc3Vydml2ZXMgdGhpcyBDTEkpOyBpdCdzIGZvdW5kIHZpYVxuLy8gJEFTVFJPTEFCRV9IT01FL2RhZW1vbi57cG9ydCxwaWR9LlxuLy9cbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyB1cCArIG9wZW4gdGhlIGJvYXJkXG4vLyAgIGJ1biBjbGkudHMgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbi8vICAgYnVuIGNsaS50cyByZW1vdmUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgIyB1bnJlZ2lzdGVyIGEgcHJvamVjdCAoZHVyYWJsZSlcbi8vICAgYnVuIGNsaS50cyBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXSAgICMgc2NvcGVkIC9ldmVudHMgdGFpbCDigJQgQUNUSVZBVEVTIHRoZSBjYXJkICsgcmVjZWl2ZXMgcG9rZXMgKHdyYXAgd2l0aCBNb25pdG9yKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyA8aWQ+IDxzdW1tYXJ5Li4uPiBbLS1waGFzZSAuLl0gWy0tc3RkaW5dICAgIyByZXBsYWNlIHRoZSBjdXJyZW50IHN0YXR1c1xuLy8gICBidW4gY2xpLnRzIGF0dGVudGlvbiA8aWQ+IFstLWNsZWFyXSBbLS1xdWVzdGlvbiAuLi5dICAgICAgICAgIyByYWlzZSAvIGNsZWFyIHRoZSBodW1hbiBnYXRlXG4vLyAgIGJ1biBjbGkudHMgcG9rZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICMgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyByZWFkLWJhY2s6IHByb2plY3QgY2FyZHNcbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dIFstLWFzIDxuYW1lPl0gICAgIyB1bnNjb3BlZCBldmVudCB0YWlsIOKGkiBKU09OTCAobm8gcHJlc2VuY2UpXG4vLyAgIGJ1biBjbGkudHMgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHBcbi8vXG4vLyBgam9pbmAgaXMgdGhlIGxpc3RlbmluZyBsb29wIGEgcHJvamVjdCdzIGFnZW50IHJ1bnM6IGhvbGRpbmcgdGhlIHNjb3BlZFxuLy8gYC9ldmVudHM/cHJvamVjdD08aWQ+YCB0YWlsIG9wZW4gaXMgd2hhdCBtYXJrcyB0aGUgY2FyZCBhY3RpdmUgKHBlciB0aGUgZGFlbW9uXG4vLyBjb250cmFjdCDigJQgcHJlc2VuY2UgSVMgdGhlIGxpdmUgY29ubmVjdGlvbiksIGFuZCB0aGUgc2FtZSB0YWlsIGRlbGl2ZXJzIHBva2VzLlxuLy9cbi8vIElkZW50aXR5OiAtLWFzIC8gLS1mcm9tIChvciAkQVNUUk9MQUJFX0FTKSBzdGFtcHMgdGhlIGV2ZW50IGBieWAgYW5kIGRyaXZlc1xuLy8gc2VsZi1lY2hvIHN1cHByZXNzaW9uLiAtLXN0ZGluIHJlYWRzIGZyZWUgdGV4dCAoZGVzY3JpcHRpb24vc3VtbWFyeSkgZnJvbVxuLy8gc3RkaW4gKGJ5cGFzc2VzIHNoZWxsIHF1b3RpbmcpLiBEaXNjaXBsaW5lOiBzdHJ1Y3R1cmVkIEpTT04gb24gc3Rkb3V0IChvbmVcbi8vIGxpbmUpOyBsaXZlbmVzcywgZWNob2VzIGFuZCBrZWVwYWxpdmVzIG9uIHN0ZGVycjsgZmFpbHVyZXMgcHV0IE9ORSBKU09OIGVycm9yXG4vLyBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgbGVmdCBlbXB0eSDigJQgbmV2ZXIgbWVyZ2Ugc3RyZWFtcy4gRXhpdCAyIG9uXG4vLyBiYWQgYXJncywgYSBiYXJlIGludm9jYXRpb24sIE9SIGEgcmVqZWN0ZWQgY29tbWFuZCAoZGVkdXBlIC8gdW5rbm93biBpZCk7XG4vLyAwIG9uIHN1Y2Nlc3M7IDEgb24gaW50ZXJuYWwgZmF1bHRzIChkYWVtb24gZmFpbGVkIHRvIHN0YXJ0KTsgYSB0YWlsIGV4aXRzIDBcbi8vIG9uIHRoZSBkYWVtb24ncyBgY2xvc2VkYCBmcmFtZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFwiLi5cIiwgXCJzY3JpcHRzXCIg4oCUIE5PVCBhIHNpYmxpbmcgbG9va3VwLiBUaGlzIGZpbGUgaXMgQVVUSE9SRUQgaGVyZSBhbmRcbi8vIEVYRUNVVEVTIGFzIGAuLi9kaXN0L2NsaS5qc2AgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIGFuZFxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlXG4vLyBwYXRoIGluIHRoaXMgZmlsZSAoU0tJTExfUk9PVCwgRElTVF9ESVIsIFNVUkZBQ0VfQ1dELCBwbHVnaW4uanNvbikgaXNcbi8vIHVuY2hhbmdlZCBieSB0aGUgbW92ZS4gQSBTSUJMSU5HLXJlbGF0aXZlIG9uZSBpcyBub3Q6IGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgcmVzb2x2ZWQgdG8gYGRpc3Qvc2VydmVyLnRzYCBhbmQgdGhlIGRhZW1vbiB3b3VsZCBuZXZlclxuLy8gc3Bhd24uIEdvaW5nIHVwIGFuZCBiYWNrIGRvd24gaXMgY29ycmVjdCBmcm9tIEJPVEggbG9jYXRpb25zLlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIGRldjogdGhlIGRhZW1vbiBzZXJ2ZXMgYSBCdW4tYnVuZGxlZCBSZWFjdCBzdXJmYWNlLCBhbmQgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvYXN0cm9sYWJlLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IChtZWFzdXJlZCBvbiBnbGFtb3VyOiB0aGUgcGFnZSA1MDBzXG4vLyB3aXRoIG5vIHN0eWxlc2hlZXQgbGluazsgYXN0cm9sYWJlJ3Mgb3duIGZhaWx1cmUgc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzXG4vLyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGFcbi8vIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZVxuLy8gYW55d2F5IHdvdWxkIGJyZWFrIHRoZSBzcGF3bi5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJhc3Ryb2xhYmVcIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuY29uc3QgQVNUUk9MQUJFX0hPTUUgPSBwcm9jZXNzLmVudi5BU1RST0xBQkVfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuYXN0cm9sYWJlXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihBU1RST0xBQkVfSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcblxuLy8gRmFpbHVyZXMgbGVhdmUgc3Rkb3V0IGVtcHR5IGFuZCBwdXQgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIOKAlCB0aGUgc2FtZVxuLy8gbWFjaGluZSBzaGFwZSBhcyB0aGUgZGF0YSBwYXRoLCBzbyBhIHBpcGVkIGNhbGxlciBwYXJzZXMgdGhlIGVycm9yIGluc3RlYWQgb2Zcbi8vIHNjcmFwaW5nIHByb3NlLiBraW5kIGZvbGxvd3MgdGhlIGFjYyBleGl0IHRheG9ub215ICh1c2FnZT0yLCBpbnRlcm5hbD0xKS5cbmZ1bmN0aW9uIGRpZShtc2c6IHN0cmluZywga2luZCA9IFwidXNhZ2VcIiwgY29kZSA9IDIpOiBuZXZlciB7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBlcnJvcjogeyBraW5kLCBtZXNzYWdlOiBtc2cgfSB9KX1cXG5gKTtcbiAgcHJvY2Vzcy5leGl0KGNvZGUpO1xufVxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcikgPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcblxuLy8gaWQgKyBhdmF0YXIgYXJlIERFUklWRUQgYnkgdGhlIGRhZW1vbiAoc3RhdGUudHMpIGZyb20gdGhlIHByb2plY3QgbmFtZSwgc28gdGhlXG4vLyBjbGkgcGFzc2VzIGlkL2F2YXRhciB0aHJvdWdoIG9ubHkgd2hlbiB0aGUgY2FsbGVyIGdhdmUgdGhlbSBleHBsaWNpdGx5IOKAlCBvbmVcbi8vIHNvdXJjZSBvZiB0cnV0aCwgbm8gc2x1Zy9hdmF0YXIgbWlycm9yIHRvIGRyaWZ0LlxuXG5mdW5jdGlvbiByZXNvbHZlQXMoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgdiA9IGZsYWdzLmFzID8/IGZsYWdzLmZyb207XG4gIGlmICh0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiAmJiB2LnRyaW0oKSkgcmV0dXJuIHYudHJpbSgpO1xuICBjb25zdCBlbnYgPSBwcm9jZXNzLmVudi5BU1RST0xBQkVfQVM7XG4gIHJldHVybiBlbnY/LnRyaW0oKSA/IGVudi50cmltKCkgOiB1bmRlZmluZWQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRTdGRpbigpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBjaHVua3M6IFVpbnQ4QXJyYXlbXSA9IFtdO1xuICBmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIEJ1bi5zdGRpbi5zdHJlYW0oKSkgY2h1bmtzLnB1c2goY2h1bmspO1xuICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmOFwiKS50cmltKCk7XG59XG5cbi8vIOKUgOKUgCBkYWVtb24gZGlzY292ZXJ5ICsgSFRUUCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuYXN5bmMgZnVuY3Rpb24gcmVhZFBvcnQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcCA9IE51bWJlci5wYXJzZUludCgoYXdhaXQgQnVuLmZpbGUoUE9SVF9GSUxFKS50ZXh0KCkpLnRyaW0oKSwgMTApO1xuICAgIHJldHVybiBwID4gMCA/IHAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBpc1VwKHBvcnQ6IG51bWJlcik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zdGF0ZWApKS5vaztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8vIEZpbmQgdGhlIHJ1bm5pbmcgZGFlbW9uLCBvciBhdXRvLXNwYXduIG9uZSAoZGV0YWNoZWQgc28gaXQgb3V0bGl2ZXMgdGhpcyBDTEkg4oCUXG4vLyBub2RlOmNoaWxkX3Byb2Nlc3MsIG5vdCBCdW4uc3Bhd24sIHdoaWNoIGNhbid0IGRldGFjaCBhIHN1cnZpdmluZyBkYWVtb24pLlxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGFlbW9uKCk6IFByb21pc2U8eyBiYXNlOiBzdHJpbmc7IHBvcnQ6IG51bWJlciB9PiB7XG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcmVhZFBvcnQoKTtcbiAgaWYgKGV4aXN0aW5nICYmIChhd2FpdCBpc1VwKGV4aXN0aW5nKSkpIHtcbiAgICByZXR1cm4geyBiYXNlOiBgaHR0cDovLzEyNy4wLjAuMToke2V4aXN0aW5nfWAsIHBvcnQ6IGV4aXN0aW5nIH07XG4gIH1cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtcInJ1blwiLCBTRVJWRVJfU0NSSVBULCBcIi0tbm8tb3BlblwiXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICAvLyBDb250cmFjdCA1IOKAlCBzZWUgZGFlbW9uQ3dkKCkuIEEgd3JvbmcgY3dkIHNraXBzIGJ1bmZpZy50b21sJ3MgVGFpbHdpbmRcbiAgICAvLyBwbHVnaW47IG9uIGdsYW1vdXIgdGhhdCBmYWlscyB0aGUgcGFnZSBvdXRyaWdodCAoNTAwKS4gQXNzZXJ0IHRoZSBpbnZhcmlhbnQsXG4gICAgLy8gbm90IHRoZSBzdGF0dXM6IHRoZSB1dGlsaXR5IG5ldmVyIHJlYWNoZXMgdGhlIGJyb3dzZXIgd2hlbiBjd2QgaXMgd3JvbmcuXG4gICAgY3dkOiBkYWVtb25Dd2QoKSxcbiAgfSk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gVGhlIGRhZW1vbiBCSU5EUyBmYXN0IGFuZCBhbnN3ZXJzIC9zdGF0ZSBhcyBzb29uIGFzIGl0J3MgbGlzdGVuaW5nICh0aGVcbiAgLy8gY29sZCBUYWlsd2luZCtSZWFjdCBidW5kbGUgaXMgbGF6eSwgb24gdGhlIGZpcnN0IEdFVCBcIi9cIiksIHNvIHRoaXMgaGFuZHNoYWtlXG4gIC8vIHVzdWFsbHkgcmV0dXJucyBxdWlja2x5LiBUaGUgd2lkZSBkZWFkbGluZSBjb3ZlcnMgYSBjb2xkIG1hY2hpbmUgd2hlcmVcbiAgLy8gbW9kdWxlIGxvYWQgKyBmaXJzdCBzZXJ2ZSBydW5zIHNsb3cgKGdsYW1vdXIgdXNlcyB0aGUgc2FtZSB+NDVzIGJ1ZGdldCkuXG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDQ1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgc2xlZXAoODApO1xuICAgIGNvbnN0IHAgPSBhd2FpdCByZWFkUG9ydCgpO1xuICAgIGlmIChwICYmIChhd2FpdCBpc1VwKHApKSkgcmV0dXJuIHsgYmFzZTogYGh0dHA6Ly8xMjcuMC4wLjE6JHtwfWAsIHBvcnQ6IHAgfTtcbiAgfVxuICBkaWUoXCJhc3Ryb2xhYmUgZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gNDVzXCIsIFwiaW50ZXJuYWxcIiwgMSk7XG59XG5cbi8vIEEgcmVhZC1vbmx5IHZlcmIgcmVxdWlyZXMgYSBsaXZlIGRhZW1vbiBidXQgbXVzdCBub3Qgc3Bhd24gb25lIChub3RoaW5nIHRvXG4vLyBvYnNlcnZlIHlldCkg4oCUIHNvIGBzdGF0ZWAvYGxpc3RgL2BpbmZvYCBvbiBhIGNvbGQgbWFjaGluZSByZXBvcnQgY2xlYW5seS5cbmFzeW5jIGZ1bmN0aW9uIHJ1bm5pbmdCYXNlKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBwID0gYXdhaXQgcmVhZFBvcnQoKTtcbiAgcmV0dXJuIHAgPyBgaHR0cDovLzEyNy4wLjAuMToke3B9YCA6IG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoYmFzZTogc3RyaW5nLCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtiYXNlfS9jbWRgLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXG4gIH0pO1xuICByZXR1cm4gKGF3YWl0IHJlcy5qc29uKCkpIGFzIHsgb2s6IGJvb2xlYW47IGFwcGxpZWQ6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nOyBvdXRjb21lPzogc3RyaW5nIH07XG59XG5cbi8vIEFwcGx5IGEgL2NtZCwgc3VyZmFjZSBhIHJlamVjdGlvbiBvbiBzdGRlcnIgKyBub24temVybyBleGl0IChleGl0LWNvZGVcbi8vIGNvbnRyYWN0KSwgYW5kIGVjaG8gdGhlIHN0cnVjdHVyZWQgcmVzdWx0IG9uIHN0ZG91dCBvbiBzdWNjZXNzLlxuYXN5bmMgZnVuY3Rpb24gY21kKGJhc2U6IHN0cmluZywgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgciA9IGF3YWl0IHBvc3RDbWQoYmFzZSwgYm9keSk7XG4gIC8vIGIyLyM4NSDigJQgRElTVElOR1VJU0ggVEhFIFRXTyBLSU5EUyBPRiBhcHBsaWVkOmZhbHNlLiBXSVRIIGFuIGVycm9yID0gYSByZWFsXG4gIC8vIHJlamVjdGlvbiAodW5rbm93biBwcm9qZWN0LCBkdXBsaWNhdGUpIC0+IHZpc2libGUsIG5vbi16ZXJvLCB1bmNoYW5nZWQuXG4gIC8vIFdJVEhPVVQgYW4gZXJyb3IgPSBhIGJlbmlnbiBuby1vcDogdGhlIHN0YXRlIHdhcyBhbHJlYWR5IHdoYXQgd2FzIGFza2VkIGZvcixcbiAgLy8gdGhlIHByb2plY3QgZXhpc3RzLCB0aGUgZGFlbW9uIGlzIHJpZ2h0LCBhbmQgbm90aGluZyBpcyB3cm9uZy4gVGhhdCB1c2VkIHRvXG4gIC8vIGV4aXQgMiB3aXRoIFwiY29tbWFuZCAnYXR0ZW50aW9uJyB3YXMgbm90IGFwcGxpZWRcIiwgc28gcmUtaXNzdWluZyBhblxuICAvLyBhbHJlYWR5LWFwcGxpZWQgY29tbWFuZCB3YXMgYSBoYXJkIGZhaWx1cmUg4oCUIHdoaWxlIGJvdW50eSB0cmVhdHMgdGhlXG4gIC8vIGlkZW50aWNhbCBwYXlsb2FkIGFzIG9yZGluYXJ5IHN1Y2Nlc3MuXG4gIC8vXG4gIC8vIFRoaXMgaXMgYm91bnR5J3MgZGlzY2lwbGluZSAoY2xpLnRzIGB0YXNrLnVwZGF0ZWApLCBwb3J0ZWQgcmF0aGVyIHRoYW5cbiAgLy8gcmUtZGVyaXZlZC4gSXQgcmVwb3J0cyB0aGUgZGFlbW9uJ3MgYG91dGNvbWVgIG5vdW4gaW5zdGVhZCBvZiBib3VudHknc1xuICAvLyBgbm9vcDogdHJ1ZWAgYm9vbGVhbiwgcGVyIHRoZSBvdXRjb21lIGNvbnRyYWN0J3MgXCJlbnVtZXJhdGVkLCBuZXZlciBhXG4gIC8vIGJvb2xlYW5cIiDigJQgdGhlIG5vdW4gc2F5cyBXSElDSCBzdGF0ZSBtYWRlIHRoZSB3b3JrIHVubmVjZXNzYXJ5LlxuICBpZiAoIXIuYXBwbGllZCAmJiByLmVycm9yKSBkaWUoci5lcnJvcik7XG4gIHByaW50SnNvbihyKTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgb3BlbmVyID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gIHRyeSB7XG4gICAgc3Bhd24ob3BlbmVyLCBbdXJsXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86IFwiaWdub3JlXCIgfSkudW5yZWYoKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG4vLyBTU0UgcmVhZGVyOiBzdHJlYW0gdGhlIGV2ZW50IGxvZyBhcyBKU09OTCBvbiBzdGRvdXQsIHJlc3VtYWJsZSArIHJlY29ubmVjdGluZy5cbi8vIGBzY29wZUlkYCAoc2V0IGJ5IGBqb2luYCkgZmlsdGVycyB0byB0aGlzIHByb2plY3QncyBmcmFtZXMgKyBsaWZlY3ljbGU7IGFuXG4vLyB1bnNjb3BlZCB0YWlsIHBhc3NlcyBldmVyeXRoaW5nLiBTZWxmLWVjaG8gKGZyYW1lcyB0aGUgY2FsbGVyJ3Mgb3duIC0tYXNcbi8vIGNhdXNlZCkgaXMgc3VwcHJlc3NlZC4gYDpgIGtlZXBhbGl2ZXMgcmlkZSBzdGRlcnI7IGV4aXRzIDAgb24gYGNsb3NlZGAuXG5hc3luYyBmdW5jdGlvbiBzdHJlYW1FdmVudHMoXG4gIGJhc2U6IHN0cmluZyxcbiAgb3B0czogeyBzaW5jZTogbnVtYmVyOyBwcm9qZWN0Pzogc3RyaW5nOyBzY29wZUlkPzogc3RyaW5nOyBzZWxmPzogc3RyaW5nIH0sXG4pIHtcbiAgbGV0IHNpbmNlID0gb3B0cy5zaW5jZTtcbiAgbGV0IGRlbGF5ID0gMjUwO1xuICBjb25zdCBzdG9wID0gKCkgPT4gcHJvY2Vzcy5leGl0KDApO1xuICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIHN0b3ApO1xuICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBzdG9wKTtcblxuICBjb25zdCBpblNjb3BlID0gKGV2OiB7IHR5cGU/OiBzdHJpbmc7IHByb2plY3RJZD86IHN0cmluZyB9KSA9PiB7XG4gICAgaWYgKCFvcHRzLnNjb3BlSWQpIHJldHVybiB0cnVlO1xuICAgIGlmIChldi50eXBlID09PSBcInJlYWR5XCIgfHwgZXYudHlwZSA9PT0gXCJjbG9zZWRcIikgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIGV2LnByb2plY3RJZCA9PT0gb3B0cy5zY29wZUlkO1xuICB9O1xuXG4gIGZvciAoOzspIHtcbiAgICBjb25zdCBwcm9qZWN0USA9IG9wdHMucHJvamVjdCA/IGAmcHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChvcHRzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHtiYXNlfS9ldmVudHM/c2luY2U9JHtzaW5jZX0ke3Byb2plY3RRfWApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8ICFyZXMuYm9keSkge1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGRlbGF5ID0gMjUwO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgIGNvbnN0IGRlYyA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWYgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGxldCBjaHVuazogUmVhZGFibGVTdHJlYW1SZWFkUmVzdWx0PFVpbnQ4QXJyYXk+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKGNodW5rLmRvbmUpIGJyZWFrO1xuICAgICAgYnVmICs9IGRlYy5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiOiBhc3Ryb2xhYmUta2VlcGFsaXZlXFxuXCIpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS50cmltKCkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghZGF0YUxpbmVzLmxlbmd0aCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBkYXRhTGluZXMuam9pbihcIlxcblwiKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBldiA9IEpTT04ucGFyc2UocGF5bG9hZCkgYXMge1xuICAgICAgICAgICAgaWQ/OiBudW1iZXI7XG4gICAgICAgICAgICB0eXBlPzogc3RyaW5nO1xuICAgICAgICAgICAgYnk/OiBzdHJpbmc7XG4gICAgICAgICAgICBwcm9qZWN0SWQ/OiBzdHJpbmc7XG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiICYmIGV2LmlkID4gc2luY2UpIHNpbmNlID0gZXYuaWQ7XG4gICAgICAgICAgY29uc3Qgc2VsZkVjaG8gPSBvcHRzLnNlbGYgIT09IHVuZGVmaW5lZCAmJiBldi5ieSA9PT0gb3B0cy5zZWxmO1xuICAgICAgICAgIGNvbnN0IGVtaXQgPSBpblNjb3BlKGV2KSAmJiAhc2VsZkVjaG87XG4gICAgICAgICAgaWYgKGV2LnR5cGUgPT09IFwiY2xvc2VkXCIpIHtcbiAgICAgICAgICAgIC8vIFAwZiDigJQgU0hBUEUgQjogdGhlIGRyYWluIGNhbGxiYWNrIHJpZGVzIFRISVMgd3JpdGUsIHNvIGl0IGZpcmVzIG9uXG4gICAgICAgICAgICAvLyB0aGlzIHdyaXRlJ3MgY29tcGxldGlvbi4gTk9UIGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAsIHdoaWNoXG4gICAgICAgICAgICAvLyBjb3ZlcnMgb25seSBpdHMgb3duIHdyaXRlIGFuZCBpcyBub3QgYSBiYXJyaWVyLlxuICAgICAgICAgICAgLy9cbiAgICAgICAgICAgIC8vIFBFUi1TSVRFIFBSRUNPTkRJVElPTiwgcmVhZCBhdCBUSElTIHNpdGUg4oCUIGFuZCBhc3Ryb2xhYmUgaXMgdGhlXG4gICAgICAgICAgICAvLyBvbmUgb2YgdGhlIGZpdmUgdGhhdCBkaWZmZXJzLiBUaGUgZXhpdCBsaXZlcyBpbiBgc3RyZWFtRXZlbnRzYCxcbiAgICAgICAgICAgIC8vIE5PVCBpbiBhIGBjbWRUYWlsYCwgYW5kIHRoZXJlIGlzIG5vIGBzdG9wcGVkYCBmbGFnIGhlcmUgdG8gc2V0OlxuICAgICAgICAgICAgLy8gdGhlIGVuY2xvc2luZyBsb29wcyBhcmUgYGZvciAoOzspYCAtPiBgZm9yICg7OylgIC0+IHRoZSBmcmFtZVxuICAgICAgICAgICAgLy8gbG9vcC4gYHJldHVybmAgaXMgc2FmZSBiZWNhdXNlIGBzdHJlYW1FdmVudHNgIGlzIGF3YWl0ZWQgZGlyZWN0bHlcbiAgICAgICAgICAgIC8vIGZyb20gbWFpbidzIHN3aXRjaCBhbmQgbWFpbiByZXR1cm5zIHN0cmFpZ2h0IGFmdGVyIOKAlCBzbyByZXR1cm5pbmdcbiAgICAgICAgICAgIC8vIGVuZHMgdGhlIHByb2Nlc3MgcmF0aGVyIHRoYW4gbGFuZGluZyBpbiBhbm90aGVyIHJldHJ5IGxvb3AsIHdoaWNoXG4gICAgICAgICAgICAvLyBpcyB0aGUgdGhpbmcgdGhhdCBoYWQgdG8gYmUgY2hlY2tlZCBhbmQgY291bGQgbm90IGJlIGluZmVycmVkXG4gICAgICAgICAgICAvLyBmcm9tIHRoZSBzaGFwZS5cbiAgICAgICAgICAgIGlmIChlbWl0KSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtwYXlsb2FkfVxcbmAsICgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XG4gICAgICAgICAgICBlbHNlIHByb2Nlc3MuZXhpdCgwKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGVtaXQpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3BheWxvYWR9XFxuYCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIHNraXAgbWFsZm9ybWVkIGZyYW1lICovXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICB9XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgeyBwb3J0IH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWAsIHBvcnQgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFkZChwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgbmFtZSA9IHBvcy5qb2luKFwiIFwiKS50cmltKCk7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGFkZCA8bmFtZT4gLS1wYXRoIDxwPiBbLS1kZXNjcmlwdGlvbiAuLl0gWy0tYXZhdGFyIC4uXSBbLS1pZCAuLl1cIik7XG4gIGNvbnN0IHBhdGggPSB0eXBlb2YgZmxhZ3MucGF0aCA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnBhdGgudHJpbSgpIDogXCJcIjtcbiAgaWYgKCFwYXRoKSBkaWUoXCJhZGQgcmVxdWlyZXMgLS1wYXRoIDxwPlwiKTtcbiAgY29uc3QgZGVzY3JpcHRpb24gPSBmbGFncy5zdGRpblxuICAgID8gYXdhaXQgcmVhZFN0ZGluKClcbiAgICA6IHR5cGVvZiBmbGFncy5kZXNjcmlwdGlvbiA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBmbGFncy5kZXNjcmlwdGlvblxuICAgICAgOiB1bmRlZmluZWQ7XG4gIC8vIGlkICsgYXZhdGFyIGFyZSBvcHRpb25hbCDigJQgdGhlIGRhZW1vbiBkZXJpdmVzIGJvdGggZnJvbSB0aGUgbmFtZSB3aGVuIG9taXR0ZWQuXG4gIGNvbnN0IGF2YXRhciA9IHR5cGVvZiBmbGFncy5hdmF0YXIgPT09IFwic3RyaW5nXCIgPyBmbGFncy5hdmF0YXIgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGlkID0gdHlwZW9mIGZsYWdzLmlkID09PSBcInN0cmluZ1wiICYmIGZsYWdzLmlkLnRyaW0oKSA/IGZsYWdzLmlkLnRyaW0oKSA6IHVuZGVmaW5lZDtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHtcbiAgICB0eXBlOiBcInByb2plY3QuYWRkXCIsXG4gICAgcHJvamVjdDogeyBpZCwgbmFtZSwgcGF0aCwgZGVzY3JpcHRpb24sIGF2YXRhciB9LFxuICAgIGFzOiByZXNvbHZlQXMoZmxhZ3MpLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVtb3ZlKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBpZCA9IHBvc1swXTtcbiAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IHJlbW92ZSA8aWQ+XCIpO1xuICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBhd2FpdCBjbWQoYmFzZSwgeyB0eXBlOiBcInByb2plY3QucmVtb3ZlXCIsIGlkLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdHVzKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBpZCA9IHBvc1swXTtcbiAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IHN0YXR1cyA8aWQ+IDxzdW1tYXJ5Li4uPiBbLS1waGFzZSAuLl0gWy0tc3RkaW5dXCIpO1xuICBjb25zdCBzdW1tYXJ5ID0gZmxhZ3Muc3RkaW4gPyBhd2FpdCByZWFkU3RkaW4oKSA6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKS50cmltKCk7XG4gIGlmICghc3VtbWFyeSkgZGllKFwic3RhdHVzIHJlcXVpcmVzIGEgc3VtbWFyeSAocG9zaXRpb25hbCBvciAtLXN0ZGluKVwiKTtcbiAgY29uc3QgcGhhc2UgPSB0eXBlb2YgZmxhZ3MucGhhc2UgPT09IFwic3RyaW5nXCIgPyBmbGFncy5waGFzZSA6IHVuZGVmaW5lZDtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJzdGF0dXNcIiwgaWQsIHN1bW1hcnksIHBoYXNlLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQXR0ZW50aW9uKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBpZCA9IHBvc1swXTtcbiAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IGF0dGVudGlvbiA8aWQ+IFstLWNsZWFyXSBbLS1xdWVzdGlvbiAuLi5dXCIpO1xuICBjb25zdCByYWlzZWQgPSBmbGFncy5jbGVhciAhPT0gdHJ1ZTtcbiAgY29uc3QgcXVlc3Rpb24gPVxuICAgIHR5cGVvZiBmbGFncy5xdWVzdGlvbiA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBmbGFncy5xdWVzdGlvblxuICAgICAgOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpIHx8IHVuZGVmaW5lZDtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJhdHRlbnRpb25cIiwgaWQsIHJhaXNlZCwgcXVlc3Rpb24sIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQb2tlKHBvczogc3RyaW5nW10sIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBpZCA9IHBvc1swXTtcbiAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IHBva2UgPGlkPlwiKTtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJwb2tlXCIsIGlkLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoKSB7XG4gIGNvbnN0IGJhc2UgPSBhd2FpdCBydW5uaW5nQmFzZSgpO1xuICBpZiAoIWJhc2UgfHwgIShhd2FpdCBpc1VwKE51bWJlci5wYXJzZUludChiYXNlLnNwbGl0KFwiOlwiKS5wb3AoKSBhcyBzdHJpbmcsIDEwKSkpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IGZhbHNlLCBzdGF0ZTogeyB0aXRsZTogXCJPYnNlcnZhdG9yeVwiLCBwcm9qZWN0czogW10gfSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7YmFzZX0vc3RhdGVgKTtcbiAgaWYgKCFyZXMub2spIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7cmVzLnN0YXR1c30pYCk7XG4gIHByaW50SnNvbihhd2FpdCByZXMuanNvbigpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTGlzdCgpIHtcbiAgY29uc3QgYmFzZSA9IGF3YWl0IHJ1bm5pbmdCYXNlKCk7XG4gIC8vIEd1YXJkIHdpdGggaXNVcCgpIGJlZm9yZSBmZXRjaGluZyAobWlycm9ycyBjbWRTdGF0ZSk6IGEgU1RBTEUgZGFlbW9uLnBvcnRcbiAgLy8gZnJvbSBhIGNyYXNoZWQgZGFlbW9uIHdvdWxkIG90aGVyd2lzZSB0aHJvdyBFQ09OTlJFRlVTRUQgaGVyZSBpbnN0ZWFkIG9mIHRoZVxuICAvLyBjbGVhbiBydW5uaW5nOmZhbHNlIHBhdGguXG4gIGlmICghYmFzZSB8fCAhKGF3YWl0IGlzVXAoTnVtYmVyLnBhcnNlSW50KGJhc2Uuc3BsaXQoXCI6XCIpLnBvcCgpIGFzIHN0cmluZywgMTApKSkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcnVubmluZzogZmFsc2UsIHByb2plY3RzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0ZSB9ID0gKGF3YWl0IChhd2FpdCBmZXRjaChgJHtiYXNlfS9zdGF0ZWApKS5qc29uKCkpIGFzIHtcbiAgICBzdGF0ZTogeyBwcm9qZWN0czogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IH07XG4gIH07XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgcnVubmluZzogdHJ1ZSxcbiAgICBwcm9qZWN0czogc3RhdGUucHJvamVjdHMubWFwKChwKSA9PiAoe1xuICAgICAgaWQ6IHAuaWQsXG4gICAgICBuYW1lOiBwLm5hbWUsXG4gICAgICB6b25lOiBwLnpvbmUsXG4gICAgICBjb25uZWN0ZWQ6IHAuY29ubmVjdGVkLFxuICAgIH0pKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZENsb3NlKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBiYXNlID0gYXdhaXQgcnVubmluZ0Jhc2UoKTtcbiAgaWYgKCFiYXNlKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFwcGxpZWQ6IGZhbHNlLCBlcnJvcjogXCJubyBkYWVtb24gcnVubmluZ1wiIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChiYXNlLCB7IHR5cGU6IFwiY2xvc2VcIiwgYXM6IHJlc29sdmVBcyhmbGFncykgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRJbmZvKCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZFBvcnQoKTtcbiAgaWYgKHBvcnQgJiYgKGF3YWl0IGlzVXAocG9ydCkpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IHRydWUsIHVybDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWAsIHBvcnQgfSk7XG4gIH0gZWxzZSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IGZhbHNlIH0pO1xuICB9XG59XG5cbmNvbnN0IEhFTFAgPSBgYXN0cm9sYWJlIOKAlCBhIHN0YW5kaW5nIG9ic2VydmF0b3J5IGJvYXJkIGZvciBwcm9qZWN0cyBpbiBmbGlnaHQuXG5cbiAgb3BlbiBbLS1uby1vcGVuXVxuICAgICAgZW5zdXJlIHRoZSBkYWVtb24gaXMgdXAgKyBvcGVuIHRoZSBib2FyZCBpbiB0aGUgYnJvd3NlclxuICBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dIFstLXN0ZGluXVxuICAgICAgcmVnaXN0ZXIgYSBwcm9qZWN0IChkZWR1cGUtZ3VhcmRlZDsgaWQgKyBhdmF0YXIgZGVyaXZlZCBmcm9tIHRoZSBuYW1lIHdoZW4gb21pdHRlZCkuXG4gICAgICB0aGUgcmVzcG9uc2UgZWNob2VzIHRoZSBkZXJpdmVkIGlkIOKAlCB5b3UgbmVlZCBpdCBmb3Igam9pbi9zdGF0dXMvYXR0ZW50aW9uL3JlbW92ZS5cbiAgcmVtb3ZlIDxpZD5cbiAgICAgIHVucmVnaXN0ZXIgYSBwcm9qZWN0XG4gIGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dXG4gICAgICBhY3RpdmF0ZSB0aGUgY2FyZCArIGxpc3RlbiBmb3IgcG9rZXMgKHNjb3BlZCB0YWlsOyB3cmFwIHdpdGggTW9uaXRvcikuIGVuZCBpdCB0byBpZGxlIHRoZSBjYXJkLlxuICBzdGF0dXMgPGlkPiA8c3VtbWFyeS4uLj4gWy0tcGhhc2UgLi5dIFstLXN0ZGluXVxuICAgICAgcmVwbGFjZSBhIHByb2plY3QncyBjdXJyZW50IHN0YXR1c1xuICBhdHRlbnRpb24gPGlkPiBbLS1jbGVhcl0gWy0tcXVlc3Rpb24gLi4uXVxuICAgICAgcmFpc2UgLyBjbGVhciB0aGUgbmVlZHMteW91IGdhdGUgKC0tcXVlc3Rpb24gYXR0YWNoZXMgdGhlIHByb21wdClcbiAgcG9rZSA8aWQ+XG4gICAgICByZXF1ZXN0IGEgZnJlc2ggc3RhdHVzIGZyb20gdGhlIHByb2plY3QncyBhZ2VudFxuICBzdGF0ZVxuICAgICAgcmVhZC1iYWNrOiBwcm9qZWN0IGNhcmRzIChlYWNoIGNhcnJpZXMgYSBkZXJpdmVkIHpvbmU6IGF0dGVudGlvbiB8IGFjdGl2ZSB8IHF1aWV0KVxuICB0YWlsIFstLXNpbmNlIE5dIFstLWFzIDxuYW1lPl1cbiAgICAgIHVuc2NvcGVkIGV2ZW50IHRhaWwgYXMgSlNPTkwgKG5vIHByZXNlbmNlKVxuICBsaXN0IHwgY2xvc2UgfCBpbmZvIHwgaGVscCB8IC0tdmVyc2lvblxuXG4gIElkZW50aXR5OiAtLWFzIC8gLS1mcm9tIChvciAkQVNUUk9MQUJFX0FTKSBzdGFtcHMgdGhlIGFjdG9yICsgc3VwcHJlc3NlcyBzZWxmLWVjaG8uXG4gIC0tc3RkaW4gcmVhZHMgYSBkZXNjcmlwdGlvbi9zdW1tYXJ5IGZyb20gc3RkaW4gKHNoZWxsLXF1b3Rpbmctc2FmZSkuXG4gIE91dHB1dDogZXZlcnkgY29tbWFuZCBwcmludHMgSlNPTiBvbiBzdGRvdXQgYnkgZGVmYXVsdCwgb25lIGxpbmUgcGVyIGFuc3dlcjtcbiAgZmFpbHVyZXMgcHV0IG9uZSBKU09OIGVycm9yIGVudmVsb3BlIG9uIHN0ZGVyciBhbmQgZXhpdCBub24temVybyAoMiA9IHVzYWdlKS5cbiAgVGhlcmUgaXMgbm8gcHJvc2UgbW9kZSB0byBzd2l0Y2ggb3V0IG9mLmA7XG5cbi8vIFRoZSBwbHVnaW4gbWFuaWZlc3QgaXMgdGhlIG9uZSB2ZXJzaW9uIHNvdXJjZTsgdGhlIENMSSByZWFkcyBpdCByYXRoZXIgdGhhblxuLy8gbWlycm9yaW5nIHRoZSBudW1iZXIuIExheW91dC1kZXBlbmRlbnQsIHNvIGFic2VuY2UgZGVncmFkZXMgdG8gXCJ1bmtub3duXCIuXG5hc3luYyBmdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiBQcm9taXNlPHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHBrZyA9IGF3YWl0IEJ1bi5maWxlKGpvaW4oU0NSSVBUX0RJUiwgXCIuLi8uLi8uLi8uY2xhdWRlLXBsdWdpbi9wbHVnaW4uanNvblwiKSkuanNvbigpO1xuICAgIGlmICh0eXBlb2YgcGtnPy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSByZXR1cm4geyBuYW1lOiBcImFzdHJvbGFiZVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiB7IG5hbWU6IFwiYXN0cm9sYWJlXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCB2ZXJiID0gYXJndlswXTtcbiAgLy8gQSBiYXJlIGludm9jYXRpb24gcmVxdWVzdGVkIG5vdGhpbmcg4oCUIHRoYXQgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgaGVscFxuICAvLyByZXF1ZXN0LiBoZWxwIHN0YXlzIHJlYWNoYWJsZSBieSBuYW1lIChhbmQgLS1oZWxwLy1oKSBvbiBzdGRvdXQgYXQgZXhpdCAwLlxuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKSBkaWUoXCJubyB2ZXJiIGdpdmVuIOKAlCB0cnkgJ2hlbHAnXCIpO1xuICBpZiAodmVyYiA9PT0gXCJoZWxwXCIgfHwgdmVyYiA9PT0gXCItLWhlbHBcIiB8fCB2ZXJiID09PSBcIi1oXCIpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG4gIC8vIFJvb3QgdG9rZW4sIGRlbGliZXJhdGVseSBOT1QgYSBmbGFnOiBkaXNwYXRjaGVkIGFsb25nc2lkZSBoZWxwIGluIHRoZSB2ZXJiXG4gIC8vIHN3aXRjaCwgc28gbm8gcGVyLXZlcmIgcGFyc2VyIGlzIGV4cGVjdGVkIHRvIGFjY2VwdCBpdCBiZWxvdyB0aGUgcm9vdC5cbiAgaWYgKHZlcmIgPT09IFwiLS12ZXJzaW9uXCIgfHwgdmVyYiA9PT0gXCItVlwiIHx8IHZlcmIgPT09IFwidmVyc2lvblwiKSB7XG4gICAgcHJpbnRKc29uKGF3YWl0IHZlcnNpb25JbmZvKCkpO1xuICAgIHJldHVybiAwO1xuICB9XG4gIGxldCBwYXJzZWQ6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz47XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IGFyZ3Yuc2xpY2UoMSksXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIGFzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHBhdGg6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBkZXNjcmlwdGlvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGF2YXRhcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGlkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcGhhc2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBxdWVzdGlvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGNsZWFyOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICB9LFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGRpZShlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuICB9XG4gIGNvbnN0IGZsYWdzID0gcGFyc2VkLnZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbiAgY29uc3QgcG9zID0gcGFyc2VkLnBvc2l0aW9uYWxzIGFzIHN0cmluZ1tdO1xuICBjb25zdCBzaW5jZSA9IHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IE51bWJlci5wYXJzZUludChmbGFncy5zaW5jZSwgMTApIDogLTE7XG5cbiAgc3dpdGNoICh2ZXJiKSB7XG4gICAgY2FzZSBcIm9wZW5cIjpcbiAgICAgIGF3YWl0IGNtZE9wZW4oZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImFkZFwiOlxuICAgICAgYXdhaXQgY21kQWRkKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInJlbW92ZVwiOlxuICAgICAgYXdhaXQgY21kUmVtb3ZlKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInN0YXR1c1wiOlxuICAgICAgYXdhaXQgY21kU3RhdHVzKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImF0dGVudGlvblwiOlxuICAgICAgYXdhaXQgY21kQXR0ZW50aW9uKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInBva2VcIjpcbiAgICAgIGF3YWl0IGNtZFBva2UocG9zLCBmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwic3RhdGVcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXRlKCk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwibGlzdFwiOlxuICAgICAgYXdhaXQgY21kTGlzdCgpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBhd2FpdCBjbWRDbG9zZShmbGFncyk7XG4gICAgICByZXR1cm4gMDtcbiAgICBjYXNlIFwiaW5mb1wiOlxuICAgICAgYXdhaXQgY21kSW5mbygpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImpvaW5cIjoge1xuICAgICAgY29uc3QgaWQgPSBwb3NbMF07XG4gICAgICBpZiAoIWlkKSBkaWUoXCJ1c2FnZTogam9pbiA8aWQ+IFstLWFzIDxuYW1lPl0gWy0tc2luY2UgTl1cIik7XG4gICAgICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgICAgLy8gQ29uZmlybSB0aGUgcHJvamVjdCBleGlzdHMgYmVmb3JlIGhvbGRpbmcgdGhlIHdhdGNoIChhIHR5cG8nZCBpZCB3b3VsZFxuICAgICAgLy8gb3RoZXJ3aXNlIGJpbmQgbm8gcHJlc2VuY2UgYW5kIHNpbGVudGx5IHN0cmVhbSBub3RoaW5nIHVzZWZ1bCkuXG4gICAgICBjb25zdCB7IHN0YXRlIH0gPSAoYXdhaXQgKGF3YWl0IGZldGNoKGAke2Jhc2V9L3N0YXRlYCkpLmpzb24oKSkgYXMge1xuICAgICAgICBzdGF0ZTogeyBwcm9qZWN0czogQXJyYXk8eyBpZDogc3RyaW5nIH0+IH07XG4gICAgICB9O1xuICAgICAgaWYgKCFzdGF0ZS5wcm9qZWN0cy5zb21lKChwKSA9PiBwLmlkID09PSBpZCkpXG4gICAgICAgIGRpZShgdW5rbm93biBwcm9qZWN0ICcke2lkfScg4oCUIHJlZ2lzdGVyIGl0IGZpcnN0YCk7XG4gICAgICBhd2FpdCBzdHJlYW1FdmVudHMoYmFzZSwgeyBzaW5jZSwgcHJvamVjdDogaWQsIHNjb3BlSWQ6IGlkLCBzZWxmOiByZXNvbHZlQXMoZmxhZ3MpIH0pO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGNhc2UgXCJ0YWlsXCI6IHtcbiAgICAgIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgICBhd2FpdCBzdHJlYW1FdmVudHMoYmFzZSwgeyBzaW5jZSwgc2VsZjogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBkZWZhdWx0OlxuICAgICAgZGllKGB1bmtub3duIHZlcmIgJyR7dmVyYn0nIOKAlCB0cnkgJ2hlbHAnYCk7XG4gIH1cbn1cblxuaWYgKGltcG9ydC5tZXRhLm1haW4pIHtcbiAgLy8gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzXG4gIC8vIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc28gYW5cbiAgLy8gZXhwbGljaXQgZXhpdCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAgLy8gNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlXG4gIC8vIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsXG4gIC8vIGZpeGVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KTsgc2FtZSBzaGFwZSwgc2FtZSByZWFzb24uXG4gIC8vIERvIG5vdCB0aWR5IHRoaXMgYmFjayBpbnRvIGFuIGV4cGxpY2l0IGV4aXQuXG4gIHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbi8vIEV4cG9ydGVkIHNvIHRoZSBzaGlwcGVkIGxhdW5jaGVyIChwbHVnaW5zLy4uLi9zY3JpcHRzL2NsaS50cykgY2FuIGludm9rZSB0aGVcbi8vIEJVTkRMRUQgY29weSBvZiB0aGlzIG1vZHVsZS4gVGhlIGltcG9ydC5tZXRhLm1haW4gYmxvY2sgYWJvdmUgc3RpbGwgcnVucyB0aGlzXG4vLyBmaWxlIGRpcmVjdGx5IGR1cmluZyBkZXZlbG9wbWVudDsgdGhlIHR3byBlbnRyeSByb3V0ZXMgYXJlIGV4Y2x1c2l2ZSwgYmVjYXVzZVxuLy8gaW1wb3J0Lm1ldGEubWFpbiBpcyBmYWxzZSBmb3IgYW4gaW1wb3J0ZWQgbW9kdWxlLlxuZXhwb3J0IHsgbWFpbiB9O1xuXG4vKipcbiAqIFRoZSBTSElQUEVEIEVOVFJZIFBPSU5ULCBjYWxsZWQgYnkgYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9hc3Ryb2xhYmUvc2NyaXB0cy9jbGkudHNgXG4gKiBhZnRlciB0aGUgYnVuZGxlIGlzIGltcG9ydGVkLlxuICpcbiAqIOKblCBJVCBUQUtFUyBOTyBBUkdVTUVOVFMsIEFORCBUSEFUIElTIFRIRSBQT0lOVC4gYXJndiBiZWxvbmdzIHRvIHdoaWNoZXZlciBmaWxlXG4gKiBQQVJTRVMgaXQsIGFuZCB0aGF0IGlzIHRoaXMgb25lLiBBbiBlYXJsaWVyIGxhdW5jaGVyIHJlYWRcbiAqIGBwcm9jZXNzLmFyZ3Yuc2xpY2UoMilgIGl0c2VsZiBhbmQgcGFzc2VkIGl0IGluIOKAlCB3aGljaCBtYWRlIHRoZSBsYXVuY2hlciBtYXRjaFxuICogYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgJ3MgUEFSU0VTX0FSR1MgcHJlZGljYXRlIChgcHJvY2Vzcy5hcmd2YCksIHNvIHRoZVxuICogcm9zdGVyIGNvdW50ZWQgYSAzLWxpbmUgZm9yd2FyZGVyIGFzIGFuIGFyZy1wYXJzaW5nIGVudHJ5IHBvaW50IGFuZCB0aGVuXG4gKiByZXBvcnRlZCB0aGUgc3BlbGwncyBkb2N1bWVudGVkIGZsYWdzIGFzIFVOUkVTT0xWRUQgYWdhaW5zdCBhIGZpbGUgdGhhdFxuICogcmVjb2duaXNlcyBub25lLiBLZWVwaW5nIGFyZ3Ygb24gdGhpcyBzaWRlIG1ha2VzIHRoZSBlbnVtZXJhdG9yJ3MgYW5zd2VyIHRydWVcbiAqIGluc3RlYWQgb2YgbWFraW5nIGl0cyByZWdleCBsb29zZXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gaW5saW5lIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlLlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQWtDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2hCTyxTQUFTLFNBQVMsQ0FBQyxNQUFxQjtBQUFBLEVBQzdDLFFBQVEsT0FBTyxNQUFNLEdBQUcsS0FBSyxVQUFVLElBQUk7QUFBQSxDQUFLO0FBQUE7OztBRGtCbEQsSUFBTSxhQUFhLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQVF6RCxJQUFNLGdCQUFnQixLQUFLLFlBQVksTUFBTSxXQUFXLFdBQVc7QUFDbkUsSUFBTSxhQUFhLEtBQUssWUFBWSxJQUFJO0FBQ3hDLElBQU0sV0FBVyxLQUFLLFlBQVksTUFBTTtBQVN4QyxJQUFNLGNBQWMsS0FBSyxZQUFZLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxPQUFPLFdBQVc7QUFFckYsU0FBUyxTQUFTLEdBQVc7QUFBQSxFQUMzQixJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFXLE9BQU87QUFBQSxFQUM3RCxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFPLE9BQU87QUFBQSxFQUN6RCxPQUFPLFdBQVcsS0FBSyxVQUFVLFlBQVksQ0FBQyxJQUFJLGFBQWE7QUFBQTtBQUVqRSxJQUFNLGlCQUFpQixRQUFRLElBQUksa0JBQWtCLEtBQUssUUFBUSxHQUFHLFlBQVk7QUFDakYsSUFBTSxZQUFZLEtBQUssZ0JBQWdCLGFBQWE7QUFLcEQsU0FBUyxHQUFHLENBQUMsS0FBYSxPQUFPLFNBQVMsT0FBTyxHQUFVO0FBQUEsRUFDekQsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsRUFBRSxJQUFJLE9BQU8sT0FBTyxFQUFFLE1BQU0sU0FBUyxJQUFJLEVBQUUsQ0FBQztBQUFBLENBQUs7QUFBQSxFQUN4RixRQUFRLEtBQUssSUFBSTtBQUFBO0FBRW5CLElBQU0sUUFBUSxDQUFDLE9BQWUsSUFBSSxR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QUssS0FBSztBQUFBLE1BQzFCLE9BQU87QUFBQSxTQUNKO0FBQUEsTUFDSCxNQUFNLGFBQWEsS0FBSyxLQUFLO0FBQUEsTUFDN0IsT0FBTztBQUFBLFNBQ0o7QUFBQSxNQUNILE1BQU0sUUFBUSxLQUFLLEtBQUs7QUFBQSxNQUN4QixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxTQUFTO0FBQUEsTUFDZixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxRQUFRO0FBQUEsTUFDZCxPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxTQUFTLEtBQUs7QUFBQSxNQUNwQixPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsTUFBTSxRQUFRO0FBQUEsTUFDZCxPQUFPO0FBQUEsU0FDSixRQUFRO0FBQUEsTUFDWCxNQUFNLEtBQUssSUFBSTtBQUFBLE1BQ2YsSUFBSSxDQUFDO0FBQUEsUUFBSSxJQUFJLDRDQUE0QztBQUFBLE1BQ3pELFFBQVEsU0FBUyxNQUFNLGFBQWE7QUFBQSxNQUdwQyxRQUFRLFVBQVcsT0FBTyxNQUFNLE1BQU0sR0FBRyxZQUFZLEdBQUcsS0FBSztBQUFBLE1BRzdELElBQUksQ0FBQyxNQUFNLFNBQVMsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFBQSxRQUN6QyxJQUFJLG9CQUFvQiw4QkFBd0I7QUFBQSxNQUNsRCxNQUFNLGFBQWEsTUFBTSxFQUFFLE9BQU8sU0FBUyxJQUFJLFNBQVMsSUFBSSxNQUFNLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQSxNQUNwRixPQUFPO0FBQUEsSUFDVDtBQUFBLFNBQ0ssUUFBUTtBQUFBLE1BQ1gsUUFBUSxTQUFTLE1BQU0sYUFBYTtBQUFBLE1BQ3BDLE1BQU0sYUFBYSxNQUFNLEVBQUUsT0FBTyxNQUFNLFVBQVUsS0FBSyxFQUFFLENBQUM7QUFBQSxNQUMxRCxPQUFPO0FBQUEsSUFDVDtBQUFBO0FBQUEsTUFFRSxJQUFJLGlCQUFpQix5QkFBbUI7QUFBQTtBQUFBO0FBSTlDLElBQUksa0JBQWtCO0FBQUEsRUFRcEIsUUFBUSxXQUFXLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFDckQ7QUFxQkEsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiNTk3MkNEMTQ1NThEQTJGMTY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
