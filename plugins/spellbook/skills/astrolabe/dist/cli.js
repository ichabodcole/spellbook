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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2FzdHJvbGFiZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIGFzdHJvbGFiZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgc3RhbmRpbmcgb2JzZXJ2YXRvcnlcbi8vIGRhZW1vbidzIEhUVFAgc3VyZmFjZSAoc2VydmVyLnRzKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgYm9hcmQgdGhyb3VnaCB0aGVzZVxuLy8gdmVyYnM7IGBqb2luYC9gdGFpbGAgc3RyZWFtIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwLlxuLy9cbi8vIERpc2NvdmVyeSArIGxpZmVjeWNsZTogYSBTSU5HTEVUT04gZGFlbW9uIHBlciAkQVNUUk9MQUJFX0hPTUUuIFRoZSBmaXJzdCB2ZXJiXG4vLyB0aGF0IG5lZWRzIGl0IGF1dG8tc3Bhd25zIGl0IChkZXRhY2hlZCwgc3Vydml2ZXMgdGhpcyBDTEkpOyBpdCdzIGZvdW5kIHZpYVxuLy8gJEFTVFJPTEFCRV9IT01FL2RhZW1vbi57cG9ydCxwaWR9LlxuLy9cbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyB1cCArIG9wZW4gdGhlIGJvYXJkXG4vLyAgIGJ1biBjbGkudHMgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbi8vICAgYnVuIGNsaS50cyByZW1vdmUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgIyB1bnJlZ2lzdGVyIGEgcHJvamVjdCAoZHVyYWJsZSlcbi8vICAgYnVuIGNsaS50cyBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXSAgICMgc2NvcGVkIC9ldmVudHMgdGFpbCDigJQgQUNUSVZBVEVTIHRoZSBjYXJkICsgcmVjZWl2ZXMgcG9rZXMgKHdyYXAgd2l0aCBNb25pdG9yKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyA8aWQ+IDxzdW1tYXJ5Li4uPiBbLS1waGFzZSAuLl0gWy0tc3RkaW5dICAgIyByZXBsYWNlIHRoZSBjdXJyZW50IHN0YXR1c1xuLy8gICBidW4gY2xpLnRzIGF0dGVudGlvbiA8aWQ+IFstLWNsZWFyXSBbLS1xdWVzdGlvbiAuLi5dICAgICAgICAgIyByYWlzZSAvIGNsZWFyIHRoZSBodW1hbiBnYXRlXG4vLyAgIGJ1biBjbGkudHMgcG9rZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICMgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyByZWFkLWJhY2s6IHByb2plY3QgY2FyZHNcbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dIFstLWFzIDxuYW1lPl0gICAgIyB1bnNjb3BlZCBldmVudCB0YWlsIOKGkiBKU09OTCAobm8gcHJlc2VuY2UpXG4vLyAgIGJ1biBjbGkudHMgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHBcbi8vXG4vLyBgam9pbmAgaXMgdGhlIGxpc3RlbmluZyBsb29wIGEgcHJvamVjdCdzIGFnZW50IHJ1bnM6IGhvbGRpbmcgdGhlIHNjb3BlZFxuLy8gYC9ldmVudHM/cHJvamVjdD08aWQ+YCB0YWlsIG9wZW4gaXMgd2hhdCBtYXJrcyB0aGUgY2FyZCBhY3RpdmUgKHBlciB0aGUgZGFlbW9uXG4vLyBjb250cmFjdCDigJQgcHJlc2VuY2UgSVMgdGhlIGxpdmUgY29ubmVjdGlvbiksIGFuZCB0aGUgc2FtZSB0YWlsIGRlbGl2ZXJzIHBva2VzLlxuLy9cbi8vIElkZW50aXR5OiAtLWFzIC8gLS1mcm9tIChvciAkQVNUUk9MQUJFX0FTKSBzdGFtcHMgdGhlIGV2ZW50IGBieWAgYW5kIGRyaXZlc1xuLy8gc2VsZi1lY2hvIHN1cHByZXNzaW9uLiAtLXN0ZGluIHJlYWRzIGZyZWUgdGV4dCAoZGVzY3JpcHRpb24vc3VtbWFyeSkgZnJvbVxuLy8gc3RkaW4gKGJ5cGFzc2VzIHNoZWxsIHF1b3RpbmcpLiBEaXNjaXBsaW5lOiBzdHJ1Y3R1cmVkIEpTT04gb24gc3Rkb3V0IChvbmVcbi8vIGxpbmUpOyBsaXZlbmVzcywgZWNob2VzIGFuZCBrZWVwYWxpdmVzIG9uIHN0ZGVycjsgZmFpbHVyZXMgcHV0IE9ORSBKU09OIGVycm9yXG4vLyBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgbGVmdCBlbXB0eSDigJQgbmV2ZXIgbWVyZ2Ugc3RyZWFtcy4gRXhpdCAyIG9uXG4vLyBiYWQgYXJncywgYSBiYXJlIGludm9jYXRpb24sIE9SIGEgcmVqZWN0ZWQgY29tbWFuZCAoZGVkdXBlIC8gdW5rbm93biBpZCk7XG4vLyAwIG9uIHN1Y2Nlc3M7IDEgb24gaW50ZXJuYWwgZmF1bHRzIChkYWVtb24gZmFpbGVkIHRvIHN0YXJ0KTsgYSB0YWlsIGV4aXRzIDBcbi8vIG9uIHRoZSBkYWVtb24ncyBgY2xvc2VkYCBmcmFtZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFwiLi5cIiwgXCJzY3JpcHRzXCIg4oCUIE5PVCBhIHNpYmxpbmcgbG9va3VwLiBUaGlzIGZpbGUgaXMgQVVUSE9SRUQgaGVyZSBhbmRcbi8vIEVYRUNVVEVTIGFzIGAuLi9kaXN0L2NsaS5qc2AgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIGFuZFxuLy8gYGRpc3QvYCBzaXRzIGF0IHRoZSBTQU1FIERFUFRIIGFzIGBzY3JpcHRzL2AsIHNvIGV2ZXJ5IEFOQ0VTVE9SLXJlbGF0aXZlXG4vLyBwYXRoIGluIHRoaXMgZmlsZSAoU0tJTExfUk9PVCwgRElTVF9ESVIsIFNVUkZBQ0VfQ1dELCBwbHVnaW4uanNvbikgaXNcbi8vIHVuY2hhbmdlZCBieSB0aGUgbW92ZS4gQSBTSUJMSU5HLXJlbGF0aXZlIG9uZSBpcyBub3Q6IGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgcmVzb2x2ZWQgdG8gYGRpc3Qvc2VydmVyLnRzYCBhbmQgdGhlIGRhZW1vbiB3b3VsZCBuZXZlclxuLy8gc3Bhd24uIEdvaW5nIHVwIGFuZCBiYWNrIGRvd24gaXMgY29ycmVjdCBmcm9tIEJPVEggbG9jYXRpb25zLlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIGRldjogdGhlIGRhZW1vbiBzZXJ2ZXMgYSBCdW4tYnVuZGxlZCBSZWFjdCBzdXJmYWNlLCBhbmQgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvYXN0cm9sYWJlLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSwgVGFpbHdpbmRcbi8vIGlzIFNJTEVOVExZIHNraXBwZWQgYW5kIHRoZSBib2FyZCByZW5kZXJzIHVuc3R5bGVkLiByZWxlYXNlOiBkaXN0LyBpc1xuLy8gcHJlLWJ1aWx0IGFuZCBzdGF0aWMg4oCUIG5vIGJ1bmZpZyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhXG4vLyBzb3VyY2UtZnJlZSBtYXJrZXRwbGFjZSBjbG9uZSBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmVcbi8vIGFueXdheSB3b3VsZCBicmVhayB0aGUgc3Bhd24uXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiYXN0cm9sYWJlXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cbmNvbnN0IEFTVFJPTEFCRV9IT01FID0gcHJvY2Vzcy5lbnYuQVNUUk9MQUJFX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmFzdHJvbGFiZVwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oQVNUUk9MQUJFX0hPTUUsIFwiZGFlbW9uLnBvcnRcIik7XG5cbi8vIEZhaWx1cmVzIGxlYXZlIHN0ZG91dCBlbXB0eSBhbmQgcHV0IE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciDigJQgdGhlIHNhbWVcbi8vIG1hY2hpbmUgc2hhcGUgYXMgdGhlIGRhdGEgcGF0aCwgc28gYSBwaXBlZCBjYWxsZXIgcGFyc2VzIHRoZSBlcnJvciBpbnN0ZWFkIG9mXG4vLyBzY3JhcGluZyBwcm9zZS4ga2luZCBmb2xsb3dzIHRoZSBhY2MgZXhpdCB0YXhvbm9teSAodXNhZ2U9MiwgaW50ZXJuYWw9MSkuXG5mdW5jdGlvbiBkaWUobXNnOiBzdHJpbmcsIGtpbmQgPSBcInVzYWdlXCIsIGNvZGUgPSAyKTogbmV2ZXIge1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiBmYWxzZSwgZXJyb3I6IHsga2luZCwgbWVzc2FnZTogbXNnIH0gfSl9XFxuYCk7XG4gIHByb2Nlc3MuZXhpdChjb2RlKTtcbn1cbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG5cbi8vIGlkICsgYXZhdGFyIGFyZSBERVJJVkVEIGJ5IHRoZSBkYWVtb24gKHN0YXRlLnRzKSBmcm9tIHRoZSBwcm9qZWN0IG5hbWUsIHNvIHRoZVxuLy8gY2xpIHBhc3NlcyBpZC9hdmF0YXIgdGhyb3VnaCBvbmx5IHdoZW4gdGhlIGNhbGxlciBnYXZlIHRoZW0gZXhwbGljaXRseSDigJQgb25lXG4vLyBzb3VyY2Ugb2YgdHJ1dGgsIG5vIHNsdWcvYXZhdGFyIG1pcnJvciB0byBkcmlmdC5cblxuZnVuY3Rpb24gcmVzb2x2ZUFzKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHYgPSBmbGFncy5hcyA/PyBmbGFncy5mcm9tO1xuICBpZiAodHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgdi50cmltKCkpIHJldHVybiB2LnRyaW0oKTtcbiAgY29uc3QgZW52ID0gcHJvY2Vzcy5lbnYuQVNUUk9MQUJFX0FTO1xuICByZXR1cm4gZW52Py50cmltKCkgPyBlbnYudHJpbSgpIDogdW5kZWZpbmVkO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU3RkaW4oKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgY2h1bmtzOiBVaW50OEFycmF5W10gPSBbXTtcbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBCdW4uc3RkaW4uc3RyZWFtKCkpIGNodW5rcy5wdXNoKGNodW5rKTtcbiAgcmV0dXJuIEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0ZjhcIikudHJpbSgpO1xufVxuXG4vLyDilIDilIAgZGFlbW9uIGRpc2NvdmVyeSArIEhUVFAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRQb3J0KCk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHAgPSBOdW1iZXIucGFyc2VJbnQoKGF3YWl0IEJ1bi5maWxlKFBPUlRfRklMRSkudGV4dCgpKS50cmltKCksIDEwKTtcbiAgICByZXR1cm4gcCA+IDAgPyBwIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gaXNVcChwb3J0OiBudW1iZXIpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3RhdGVgKSkub2s7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vLyBGaW5kIHRoZSBydW5uaW5nIGRhZW1vbiwgb3IgYXV0by1zcGF3biBvbmUgKGRldGFjaGVkIHNvIGl0IG91dGxpdmVzIHRoaXMgQ0xJIOKAlFxuLy8gbm9kZTpjaGlsZF9wcm9jZXNzLCBub3QgQnVuLnNwYXduLCB3aGljaCBjYW4ndCBkZXRhY2ggYSBzdXJ2aXZpbmcgZGFlbW9uKS5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPHsgYmFzZTogc3RyaW5nOyBwb3J0OiBudW1iZXIgfT4ge1xuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gIGlmIChleGlzdGluZyAmJiAoYXdhaXQgaXNVcChleGlzdGluZykpKSB7XG4gICAgcmV0dXJuIHsgYmFzZTogYGh0dHA6Ly8xMjcuMC4wLjE6JHtleGlzdGluZ31gLCBwb3J0OiBleGlzdGluZyB9O1xuICB9XG4gIGNvbnN0IHByb2MgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbXCJydW5cIiwgU0VSVkVSX1NDUklQVCwgXCItLW5vLW9wZW5cIl0sIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgLy8gQ29udHJhY3QgNSDigJQgc2VlIGRhZW1vbkN3ZCgpLiBUSEUgRkFJTFVSRSBJUyBTSUxFTlQ6IGEgd3JvbmcgY3dkIHNraXBzXG4gICAgLy8gYnVuZmlnLnRvbWwncyBUYWlsd2luZCBwbHVnaW4gYW5kIHRoZSBib2FyZCByZW5kZXJzIHVuc3R5bGVkIHJhdGhlciB0aGFuXG4gICAgLy8gZXJyb3JpbmcsIHNvIG5vdGhpbmcgZG93bnN0cmVhbSBvZiBoZXJlIHdpbGwgdGVsbCB5b3UgaXQgd2FzIHdyb25nLlxuICAgIGN3ZDogZGFlbW9uQ3dkKCksXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFRoZSBkYWVtb24gQklORFMgZmFzdCBhbmQgYW5zd2VycyAvc3RhdGUgYXMgc29vbiBhcyBpdCdzIGxpc3RlbmluZyAodGhlXG4gIC8vIGNvbGQgVGFpbHdpbmQrUmVhY3QgYnVuZGxlIGlzIGxhenksIG9uIHRoZSBmaXJzdCBHRVQgXCIvXCIpLCBzbyB0aGlzIGhhbmRzaGFrZVxuICAvLyB1c3VhbGx5IHJldHVybnMgcXVpY2tseS4gVGhlIHdpZGUgZGVhZGxpbmUgY292ZXJzIGEgY29sZCBtYWNoaW5lIHdoZXJlXG4gIC8vIG1vZHVsZSBsb2FkICsgZmlyc3Qgc2VydmUgcnVucyBzbG93IChnbGFtb3VyIHVzZXMgdGhlIHNhbWUgfjQ1cyBidWRnZXQpLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA0NTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IHNsZWVwKDgwKTtcbiAgICBjb25zdCBwID0gYXdhaXQgcmVhZFBvcnQoKTtcbiAgICBpZiAocCAmJiAoYXdhaXQgaXNVcChwKSkpIHJldHVybiB7IGJhc2U6IGBodHRwOi8vMTI3LjAuMC4xOiR7cH1gLCBwb3J0OiBwIH07XG4gIH1cbiAgZGllKFwiYXN0cm9sYWJlIGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDQ1c1wiLCBcImludGVybmFsXCIsIDEpO1xufVxuXG4vLyBBIHJlYWQtb25seSB2ZXJiIHJlcXVpcmVzIGEgbGl2ZSBkYWVtb24gYnV0IG11c3Qgbm90IHNwYXduIG9uZSAobm90aGluZyB0b1xuLy8gb2JzZXJ2ZSB5ZXQpIOKAlCBzbyBgc3RhdGVgL2BsaXN0YC9gaW5mb2Agb24gYSBjb2xkIG1hY2hpbmUgcmVwb3J0IGNsZWFubHkuXG5hc3luYyBmdW5jdGlvbiBydW5uaW5nQmFzZSgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gIHJldHVybiBwID8gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwfWAgOiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKGJhc2U6IHN0cmluZywgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7YmFzZX0vY21kYCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICB9KTtcbiAgcmV0dXJuIChhd2FpdCByZXMuanNvbigpKSBhcyB7IG9rOiBib29sZWFuOyBhcHBsaWVkOiBib29sZWFuOyBlcnJvcj86IHN0cmluZzsgb3V0Y29tZT86IHN0cmluZyB9O1xufVxuXG4vLyBBcHBseSBhIC9jbWQsIHN1cmZhY2UgYSByZWplY3Rpb24gb24gc3RkZXJyICsgbm9uLXplcm8gZXhpdCAoZXhpdC1jb2RlXG4vLyBjb250cmFjdCksIGFuZCBlY2hvIHRoZSBzdHJ1Y3R1cmVkIHJlc3VsdCBvbiBzdGRvdXQgb24gc3VjY2Vzcy5cbmFzeW5jIGZ1bmN0aW9uIGNtZChiYXNlOiBzdHJpbmcsIGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHIgPSBhd2FpdCBwb3N0Q21kKGJhc2UsIGJvZHkpO1xuICAvLyBiMi8jODUg4oCUIERJU1RJTkdVSVNIIFRIRSBUV08gS0lORFMgT0YgYXBwbGllZDpmYWxzZS4gV0lUSCBhbiBlcnJvciA9IGEgcmVhbFxuICAvLyByZWplY3Rpb24gKHVua25vd24gcHJvamVjdCwgZHVwbGljYXRlKSAtPiB2aXNpYmxlLCBub24temVybywgdW5jaGFuZ2VkLlxuICAvLyBXSVRIT1VUIGFuIGVycm9yID0gYSBiZW5pZ24gbm8tb3A6IHRoZSBzdGF0ZSB3YXMgYWxyZWFkeSB3aGF0IHdhcyBhc2tlZCBmb3IsXG4gIC8vIHRoZSBwcm9qZWN0IGV4aXN0cywgdGhlIGRhZW1vbiBpcyByaWdodCwgYW5kIG5vdGhpbmcgaXMgd3JvbmcuIFRoYXQgdXNlZCB0b1xuICAvLyBleGl0IDIgd2l0aCBcImNvbW1hbmQgJ2F0dGVudGlvbicgd2FzIG5vdCBhcHBsaWVkXCIsIHNvIHJlLWlzc3VpbmcgYW5cbiAgLy8gYWxyZWFkeS1hcHBsaWVkIGNvbW1hbmQgd2FzIGEgaGFyZCBmYWlsdXJlIOKAlCB3aGlsZSBib3VudHkgdHJlYXRzIHRoZVxuICAvLyBpZGVudGljYWwgcGF5bG9hZCBhcyBvcmRpbmFyeSBzdWNjZXNzLlxuICAvL1xuICAvLyBUaGlzIGlzIGJvdW50eSdzIGRpc2NpcGxpbmUgKGNsaS50cyBgdGFzay51cGRhdGVgKSwgcG9ydGVkIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRlcml2ZWQuIEl0IHJlcG9ydHMgdGhlIGRhZW1vbidzIGBvdXRjb21lYCBub3VuIGluc3RlYWQgb2YgYm91bnR5J3NcbiAgLy8gYG5vb3A6IHRydWVgIGJvb2xlYW4sIHBlciB0aGUgb3V0Y29tZSBjb250cmFjdCdzIFwiZW51bWVyYXRlZCwgbmV2ZXIgYVxuICAvLyBib29sZWFuXCIg4oCUIHRoZSBub3VuIHNheXMgV0hJQ0ggc3RhdGUgbWFkZSB0aGUgd29yayB1bm5lY2Vzc2FyeS5cbiAgaWYgKCFyLmFwcGxpZWQgJiYgci5lcnJvcikgZGllKHIuZXJyb3IpO1xuICBwcmludEpzb24ocik7XG59XG5cbmZ1bmN0aW9uIG9wZW5Ccm93c2VyKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG9wZW5lciA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICB0cnkge1xuICAgIHNwYXduKG9wZW5lciwgW3VybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gIH1cbn1cblxuLy8gU1NFIHJlYWRlcjogc3RyZWFtIHRoZSBldmVudCBsb2cgYXMgSlNPTkwgb24gc3Rkb3V0LCByZXN1bWFibGUgKyByZWNvbm5lY3RpbmcuXG4vLyBgc2NvcGVJZGAgKHNldCBieSBgam9pbmApIGZpbHRlcnMgdG8gdGhpcyBwcm9qZWN0J3MgZnJhbWVzICsgbGlmZWN5Y2xlOyBhblxuLy8gdW5zY29wZWQgdGFpbCBwYXNzZXMgZXZlcnl0aGluZy4gU2VsZi1lY2hvIChmcmFtZXMgdGhlIGNhbGxlcidzIG93biAtLWFzXG4vLyBjYXVzZWQpIGlzIHN1cHByZXNzZWQuIGA6YCBrZWVwYWxpdmVzIHJpZGUgc3RkZXJyOyBleGl0cyAwIG9uIGBjbG9zZWRgLlxuYXN5bmMgZnVuY3Rpb24gc3RyZWFtRXZlbnRzKFxuICBiYXNlOiBzdHJpbmcsXG4gIG9wdHM6IHsgc2luY2U6IG51bWJlcjsgcHJvamVjdD86IHN0cmluZzsgc2NvcGVJZD86IHN0cmluZzsgc2VsZj86IHN0cmluZyB9LFxuKSB7XG4gIGxldCBzaW5jZSA9IG9wdHMuc2luY2U7XG4gIGxldCBkZWxheSA9IDI1MDtcbiAgY29uc3Qgc3RvcCA9ICgpID0+IHByb2Nlc3MuZXhpdCgwKTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBzdG9wKTtcbiAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgc3RvcCk7XG5cbiAgY29uc3QgaW5TY29wZSA9IChldjogeyB0eXBlPzogc3RyaW5nOyBwcm9qZWN0SWQ/OiBzdHJpbmcgfSkgPT4ge1xuICAgIGlmICghb3B0cy5zY29wZUlkKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoZXYudHlwZSA9PT0gXCJyZWFkeVwiIHx8IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBldi5wcm9qZWN0SWQgPT09IG9wdHMuc2NvcGVJZDtcbiAgfTtcblxuICBmb3IgKDs7KSB7XG4gICAgY29uc3QgcHJvamVjdFEgPSBvcHRzLnByb2plY3QgPyBgJnByb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQob3B0cy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7YmFzZX0vZXZlbnRzP3NpbmNlPSR7c2luY2V9JHtwcm9qZWN0UX1gKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCA1MDAwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCA1MDAwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBkZWxheSA9IDI1MDtcbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWMgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBsZXQgY2h1bms6IFJlYWRhYmxlU3RyZWFtUmVhZFJlc3VsdDxVaW50OEFycmF5PjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmIChjaHVuay5kb25lKSBicmVhaztcbiAgICAgIGJ1ZiArPSBkZWMuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIjogYXN0cm9sYWJlLWtlZXBhbGl2ZVxcblwiKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkudHJpbSgpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWRhdGFMaW5lcy5sZW5ndGgpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBwYXlsb2FkID0gZGF0YUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgZXYgPSBKU09OLnBhcnNlKHBheWxvYWQpIGFzIHtcbiAgICAgICAgICAgIGlkPzogbnVtYmVyO1xuICAgICAgICAgICAgdHlwZT86IHN0cmluZztcbiAgICAgICAgICAgIGJ5Pzogc3RyaW5nO1xuICAgICAgICAgICAgcHJvamVjdElkPzogc3RyaW5nO1xuICAgICAgICAgIH07XG4gICAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiAmJiBldi5pZCA+IHNpbmNlKSBzaW5jZSA9IGV2LmlkO1xuICAgICAgICAgIGNvbnN0IHNlbGZFY2hvID0gb3B0cy5zZWxmICE9PSB1bmRlZmluZWQgJiYgZXYuYnkgPT09IG9wdHMuc2VsZjtcbiAgICAgICAgICBjb25zdCBlbWl0ID0gaW5TY29wZShldikgJiYgIXNlbGZFY2hvO1xuICAgICAgICAgIGlmIChldi50eXBlID09PSBcImNsb3NlZFwiKSB7XG4gICAgICAgICAgICAvLyBQMGYg4oCUIFNIQVBFIEI6IHRoZSBkcmFpbiBjYWxsYmFjayByaWRlcyBUSElTIHdyaXRlLCBzbyBpdCBmaXJlcyBvblxuICAgICAgICAgICAgLy8gdGhpcyB3cml0ZSdzIGNvbXBsZXRpb24uIE5PVCBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgLCB3aGljaFxuICAgICAgICAgICAgLy8gY292ZXJzIG9ubHkgaXRzIG93biB3cml0ZSBhbmQgaXMgbm90IGEgYmFycmllci5cbiAgICAgICAgICAgIC8vXG4gICAgICAgICAgICAvLyBQRVItU0lURSBQUkVDT05ESVRJT04sIHJlYWQgYXQgVEhJUyBzaXRlIOKAlCBhbmQgYXN0cm9sYWJlIGlzIHRoZVxuICAgICAgICAgICAgLy8gb25lIG9mIHRoZSBmaXZlIHRoYXQgZGlmZmVycy4gVGhlIGV4aXQgbGl2ZXMgaW4gYHN0cmVhbUV2ZW50c2AsXG4gICAgICAgICAgICAvLyBOT1QgaW4gYSBgY21kVGFpbGAsIGFuZCB0aGVyZSBpcyBubyBgc3RvcHBlZGAgZmxhZyBoZXJlIHRvIHNldDpcbiAgICAgICAgICAgIC8vIHRoZSBlbmNsb3NpbmcgbG9vcHMgYXJlIGBmb3IgKDs7KWAgLT4gYGZvciAoOzspYCAtPiB0aGUgZnJhbWVcbiAgICAgICAgICAgIC8vIGxvb3AuIGByZXR1cm5gIGlzIHNhZmUgYmVjYXVzZSBgc3RyZWFtRXZlbnRzYCBpcyBhd2FpdGVkIGRpcmVjdGx5XG4gICAgICAgICAgICAvLyBmcm9tIG1haW4ncyBzd2l0Y2ggYW5kIG1haW4gcmV0dXJucyBzdHJhaWdodCBhZnRlciDigJQgc28gcmV0dXJuaW5nXG4gICAgICAgICAgICAvLyBlbmRzIHRoZSBwcm9jZXNzIHJhdGhlciB0aGFuIGxhbmRpbmcgaW4gYW5vdGhlciByZXRyeSBsb29wLCB3aGljaFxuICAgICAgICAgICAgLy8gaXMgdGhlIHRoaW5nIHRoYXQgaGFkIHRvIGJlIGNoZWNrZWQgYW5kIGNvdWxkIG5vdCBiZSBpbmZlcnJlZFxuICAgICAgICAgICAgLy8gZnJvbSB0aGUgc2hhcGUuXG4gICAgICAgICAgICBpZiAoZW1pdCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cGF5bG9hZH1cXG5gLCAoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgICAgICAgZWxzZSBwcm9jZXNzLmV4aXQoMCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlbWl0KSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtwYXlsb2FkfVxcbmApO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBza2lwIG1hbGZvcm1lZCBmcmFtZSAqL1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgfVxufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHsgcG9ydCB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGlmICghZmxhZ3NbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3NlcihgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IG5hbWUgPSBwb3Muam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBhZGQgPG5hbWU+IC0tcGF0aCA8cD4gWy0tZGVzY3JpcHRpb24gLi5dIFstLWF2YXRhciAuLl0gWy0taWQgLi5dXCIpO1xuICBjb25zdCBwYXRoID0gdHlwZW9mIGZsYWdzLnBhdGggPT09IFwic3RyaW5nXCIgPyBmbGFncy5wYXRoLnRyaW0oKSA6IFwiXCI7XG4gIGlmICghcGF0aCkgZGllKFwiYWRkIHJlcXVpcmVzIC0tcGF0aCA8cD5cIik7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gZmxhZ3Muc3RkaW5cbiAgICA/IGF3YWl0IHJlYWRTdGRpbigpXG4gICAgOiB0eXBlb2YgZmxhZ3MuZGVzY3JpcHRpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MuZGVzY3JpcHRpb25cbiAgICAgIDogdW5kZWZpbmVkO1xuICAvLyBpZCArIGF2YXRhciBhcmUgb3B0aW9uYWwg4oCUIHRoZSBkYWVtb24gZGVyaXZlcyBib3RoIGZyb20gdGhlIG5hbWUgd2hlbiBvbWl0dGVkLlxuICBjb25zdCBhdmF0YXIgPSB0eXBlb2YgZmxhZ3MuYXZhdGFyID09PSBcInN0cmluZ1wiID8gZmxhZ3MuYXZhdGFyIDogdW5kZWZpbmVkO1xuICBjb25zdCBpZCA9IHR5cGVvZiBmbGFncy5pZCA9PT0gXCJzdHJpbmdcIiAmJiBmbGFncy5pZC50cmltKCkgPyBmbGFncy5pZC50cmltKCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7XG4gICAgdHlwZTogXCJwcm9qZWN0LmFkZFwiLFxuICAgIHByb2plY3Q6IHsgaWQsIG5hbWUsIHBhdGgsIGRlc2NyaXB0aW9uLCBhdmF0YXIgfSxcbiAgICBhczogcmVzb2x2ZUFzKGZsYWdzKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlbW92ZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiByZW1vdmUgPGlkPlwiKTtcbiAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgYXdhaXQgY21kKGJhc2UsIHsgdHlwZTogXCJwcm9qZWN0LnJlbW92ZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXR1cyhwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBzdGF0dXMgPGlkPiA8c3VtbWFyeS4uLj4gWy0tcGhhc2UgLi5dIFstLXN0ZGluXVwiKTtcbiAgY29uc3Qgc3VtbWFyeSA9IGZsYWdzLnN0ZGluID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICBpZiAoIXN1bW1hcnkpIGRpZShcInN0YXR1cyByZXF1aXJlcyBhIHN1bW1hcnkgKHBvc2l0aW9uYWwgb3IgLS1zdGRpbilcIik7XG4gIGNvbnN0IHBoYXNlID0gdHlwZW9mIGZsYWdzLnBoYXNlID09PSBcInN0cmluZ1wiID8gZmxhZ3MucGhhc2UgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwic3RhdHVzXCIsIGlkLCBzdW1tYXJ5LCBwaGFzZSwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEF0dGVudGlvbihwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBhdHRlbnRpb24gPGlkPiBbLS1jbGVhcl0gWy0tcXVlc3Rpb24gLi4uXVwiKTtcbiAgY29uc3QgcmFpc2VkID0gZmxhZ3MuY2xlYXIgIT09IHRydWU7XG4gIGNvbnN0IHF1ZXN0aW9uID1cbiAgICB0eXBlb2YgZmxhZ3MucXVlc3Rpb24gPT09IFwic3RyaW5nXCJcbiAgICAgID8gZmxhZ3MucXVlc3Rpb25cbiAgICAgIDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwiYXR0ZW50aW9uXCIsIGlkLCByYWlzZWQsIHF1ZXN0aW9uLCBhczogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUG9rZShwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgaWQgPSBwb3NbMF07XG4gIGlmICghaWQpIGRpZShcInVzYWdlOiBwb2tlIDxpZD5cIik7XG4gIGNvbnN0IHsgYmFzZSB9ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGF3YWl0IGNtZChiYXNlLCB7IHR5cGU6IFwicG9rZVwiLCBpZCwgYXM6IHJlc29sdmVBcyhmbGFncykgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKCkge1xuICBjb25zdCBiYXNlID0gYXdhaXQgcnVubmluZ0Jhc2UoKTtcbiAgaWYgKCFiYXNlIHx8ICEoYXdhaXQgaXNVcChOdW1iZXIucGFyc2VJbnQoYmFzZS5zcGxpdChcIjpcIikucG9wKCkgYXMgc3RyaW5nLCAxMCkpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSwgc3RhdGU6IHsgdGl0bGU6IFwiT2JzZXJ2YXRvcnlcIiwgcHJvamVjdHM6IFtdIH0gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke2Jhc2V9L3N0YXRlYCk7XG4gIGlmICghcmVzLm9rKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWApO1xuICBwcmludEpzb24oYXdhaXQgcmVzLmpzb24oKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IGJhc2UgPSBhd2FpdCBydW5uaW5nQmFzZSgpO1xuICAvLyBHdWFyZCB3aXRoIGlzVXAoKSBiZWZvcmUgZmV0Y2hpbmcgKG1pcnJvcnMgY21kU3RhdGUpOiBhIFNUQUxFIGRhZW1vbi5wb3J0XG4gIC8vIGZyb20gYSBjcmFzaGVkIGRhZW1vbiB3b3VsZCBvdGhlcndpc2UgdGhyb3cgRUNPTk5SRUZVU0VEIGhlcmUgaW5zdGVhZCBvZiB0aGVcbiAgLy8gY2xlYW4gcnVubmluZzpmYWxzZSBwYXRoLlxuICBpZiAoIWJhc2UgfHwgIShhd2FpdCBpc1VwKE51bWJlci5wYXJzZUludChiYXNlLnNwbGl0KFwiOlwiKS5wb3AoKSBhcyBzdHJpbmcsIDEwKSkpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHJ1bm5pbmc6IGZhbHNlLCBwcm9qZWN0czogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdGUgfSA9IChhd2FpdCAoYXdhaXQgZmV0Y2goYCR7YmFzZX0vc3RhdGVgKSkuanNvbigpKSBhcyB7XG4gICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9O1xuICB9O1xuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHJ1bm5pbmc6IHRydWUsXG4gICAgcHJvamVjdHM6IHN0YXRlLnByb2plY3RzLm1hcCgocCkgPT4gKHtcbiAgICAgIGlkOiBwLmlkLFxuICAgICAgbmFtZTogcC5uYW1lLFxuICAgICAgem9uZTogcC56b25lLFxuICAgICAgY29ubmVjdGVkOiBwLmNvbm5lY3RlZCxcbiAgICB9KSksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgYmFzZSA9IGF3YWl0IHJ1bm5pbmdCYXNlKCk7XG4gIGlmICghYmFzZSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhcHBsaWVkOiBmYWxzZSwgZXJyb3I6IFwibm8gZGFlbW9uIHJ1bm5pbmdcIiB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoYmFzZSwgeyB0eXBlOiBcImNsb3NlXCIsIGFzOiByZXNvbHZlQXMoZmxhZ3MpIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5mbygpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWRQb3J0KCk7XG4gIGlmIChwb3J0ICYmIChhd2FpdCBpc1VwKHBvcnQpKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiB0cnVlLCB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLCBwb3J0IH0pO1xuICB9IGVsc2Uge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBydW5uaW5nOiBmYWxzZSB9KTtcbiAgfVxufVxuXG5jb25zdCBIRUxQID0gYGFzdHJvbGFiZSDigJQgYSBzdGFuZGluZyBvYnNlcnZhdG9yeSBib2FyZCBmb3IgcHJvamVjdHMgaW4gZmxpZ2h0LlxuXG4gIG9wZW4gWy0tbm8tb3Blbl1cbiAgICAgIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHVwICsgb3BlbiB0aGUgYm9hcmQgaW4gdGhlIGJyb3dzZXJcbiAgYWRkIDxuYW1lPiAtLXBhdGggPHA+IFstLWRlc2NyaXB0aW9uIC4uXSBbLS1hdmF0YXIgLi5dIFstLWlkIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlZ2lzdGVyIGEgcHJvamVjdCAoZGVkdXBlLWd1YXJkZWQ7IGlkICsgYXZhdGFyIGRlcml2ZWQgZnJvbSB0aGUgbmFtZSB3aGVuIG9taXR0ZWQpLlxuICAgICAgdGhlIHJlc3BvbnNlIGVjaG9lcyB0aGUgZGVyaXZlZCBpZCDigJQgeW91IG5lZWQgaXQgZm9yIGpvaW4vc3RhdHVzL2F0dGVudGlvbi9yZW1vdmUuXG4gIHJlbW92ZSA8aWQ+XG4gICAgICB1bnJlZ2lzdGVyIGEgcHJvamVjdFxuICBqb2luIDxpZD4gWy0tYXMgPG5hbWU+XSBbLS1zaW5jZSBOXVxuICAgICAgYWN0aXZhdGUgdGhlIGNhcmQgKyBsaXN0ZW4gZm9yIHBva2VzIChzY29wZWQgdGFpbDsgd3JhcCB3aXRoIE1vbml0b3IpLiBlbmQgaXQgdG8gaWRsZSB0aGUgY2FyZC5cbiAgc3RhdHVzIDxpZD4gPHN1bW1hcnkuLi4+IFstLXBoYXNlIC4uXSBbLS1zdGRpbl1cbiAgICAgIHJlcGxhY2UgYSBwcm9qZWN0J3MgY3VycmVudCBzdGF0dXNcbiAgYXR0ZW50aW9uIDxpZD4gWy0tY2xlYXJdIFstLXF1ZXN0aW9uIC4uLl1cbiAgICAgIHJhaXNlIC8gY2xlYXIgdGhlIG5lZWRzLXlvdSBnYXRlICgtLXF1ZXN0aW9uIGF0dGFjaGVzIHRoZSBwcm9tcHQpXG4gIHBva2UgPGlkPlxuICAgICAgcmVxdWVzdCBhIGZyZXNoIHN0YXR1cyBmcm9tIHRoZSBwcm9qZWN0J3MgYWdlbnRcbiAgc3RhdGVcbiAgICAgIHJlYWQtYmFjazogcHJvamVjdCBjYXJkcyAoZWFjaCBjYXJyaWVzIGEgZGVyaXZlZCB6b25lOiBhdHRlbnRpb24gfCBhY3RpdmUgfCBxdWlldClcbiAgdGFpbCBbLS1zaW5jZSBOXSBbLS1hcyA8bmFtZT5dXG4gICAgICB1bnNjb3BlZCBldmVudCB0YWlsIGFzIEpTT05MIChubyBwcmVzZW5jZSlcbiAgbGlzdCB8IGNsb3NlIHwgaW5mbyB8IGhlbHAgfCAtLXZlcnNpb25cblxuICBJZGVudGl0eTogLS1hcyAvIC0tZnJvbSAob3IgJEFTVFJPTEFCRV9BUykgc3RhbXBzIHRoZSBhY3RvciArIHN1cHByZXNzZXMgc2VsZi1lY2hvLlxuICAtLXN0ZGluIHJlYWRzIGEgZGVzY3JpcHRpb24vc3VtbWFyeSBmcm9tIHN0ZGluIChzaGVsbC1xdW90aW5nLXNhZmUpLlxuICBPdXRwdXQ6IGV2ZXJ5IGNvbW1hbmQgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBsaW5lIHBlciBhbnN3ZXI7XG4gIGZhaWx1cmVzIHB1dCBvbmUgSlNPTiBlcnJvciBlbnZlbG9wZSBvbiBzdGRlcnIgYW5kIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG4gIFRoZXJlIGlzIG5vIHByb3NlIG1vZGUgdG8gc3dpdGNoIG91dCBvZi5gO1xuXG4vLyBUaGUgcGx1Z2luIG1hbmlmZXN0IGlzIHRoZSBvbmUgdmVyc2lvbiBzb3VyY2U7IHRoZSBDTEkgcmVhZHMgaXQgcmF0aGVyIHRoYW5cbi8vIG1pcnJvcmluZyB0aGUgbnVtYmVyLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlIGRlZ3JhZGVzIHRvIFwidW5rbm93blwiLlxuYXN5bmMgZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogUHJvbWlzZTx7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwa2cgPSBhd2FpdCBCdW4uZmlsZShqb2luKFNDUklQVF9ESVIsIFwiLi4vLi4vLi4vLmNsYXVkZS1wbHVnaW4vcGx1Z2luLmpzb25cIikpLmpzb24oKTtcbiAgICBpZiAodHlwZW9mIHBrZz8udmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJhc3Ryb2xhYmVcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBuYW1lOiBcImFzdHJvbGFiZVwiLCB2ZXJzaW9uOiBcInVua25vd25cIiB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdmVyYiA9IGFyZ3ZbMF07XG4gIC8vIEEgYmFyZSBpbnZvY2F0aW9uIHJlcXVlc3RlZCBub3RoaW5nIOKAlCB0aGF0IGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHBcbiAgLy8gcmVxdWVzdC4gaGVscCBzdGF5cyByZWFjaGFibGUgYnkgbmFtZSAoYW5kIC0taGVscC8taCkgb24gc3Rkb3V0IGF0IGV4aXQgMC5cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkgZGllKFwibm8gdmVyYiBnaXZlbiDigJQgdHJ5ICdoZWxwJ1wiKTtcbiAgaWYgKHZlcmIgPT09IFwiaGVscFwiIHx8IHZlcmIgPT09IFwiLS1oZWxwXCIgfHwgdmVyYiA9PT0gXCItaFwiKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICAvLyBSb290IHRva2VuLCBkZWxpYmVyYXRlbHkgTk9UIGEgZmxhZzogZGlzcGF0Y2hlZCBhbG9uZ3NpZGUgaGVscCBpbiB0aGUgdmVyYlxuICAvLyBzd2l0Y2gsIHNvIG5vIHBlci12ZXJiIHBhcnNlciBpcyBleHBlY3RlZCB0byBhY2NlcHQgaXQgYmVsb3cgdGhlIHJvb3QuXG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIiB8fCB2ZXJiID09PSBcInZlcnNpb25cIikge1xuICAgIHByaW50SnNvbihhd2FpdCB2ZXJzaW9uSW5mbygpKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LnNsaWNlKDEpLFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBwYXRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgZGVzY3JpcHRpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBhdmF0YXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHBoYXNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcXVlc3Rpb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgICAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgfSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBkaWUoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgfVxuICBjb25zdCBmbGFncyA9IHBhcnNlZC52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIGNvbnN0IHBvcyA9IHBhcnNlZC5wb3NpdGlvbmFscyBhcyBzdHJpbmdbXTtcbiAgY29uc3Qgc2luY2UgPSB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhZGRcIjpcbiAgICAgIGF3YWl0IGNtZEFkZChwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJyZW1vdmVcIjpcbiAgICAgIGF3YWl0IGNtZFJlbW92ZShwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXR1cyhwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJhdHRlbnRpb25cIjpcbiAgICAgIGF3YWl0IGNtZEF0dGVudGlvbihwb3MsIGZsYWdzKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJwb2tlXCI6XG4gICAgICBhd2FpdCBjbWRQb2tlKHBvcywgZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcInN0YXRlXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0ZSgpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImxpc3RcIjpcbiAgICAgIGF3YWl0IGNtZExpc3QoKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgY21kQ2xvc2UoZmxhZ3MpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGF3YWl0IGNtZEluZm8oKTtcbiAgICAgIHJldHVybiAwO1xuICAgIGNhc2UgXCJqb2luXCI6IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zWzBdO1xuICAgICAgaWYgKCFpZCkgZGllKFwidXNhZ2U6IGpvaW4gPGlkPiBbLS1hcyA8bmFtZT5dIFstLXNpbmNlIE5dXCIpO1xuICAgICAgY29uc3QgeyBiYXNlIH0gPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICAgIC8vIENvbmZpcm0gdGhlIHByb2plY3QgZXhpc3RzIGJlZm9yZSBob2xkaW5nIHRoZSB3YXRjaCAoYSB0eXBvJ2QgaWQgd291bGRcbiAgICAgIC8vIG90aGVyd2lzZSBiaW5kIG5vIHByZXNlbmNlIGFuZCBzaWxlbnRseSBzdHJlYW0gbm90aGluZyB1c2VmdWwpLlxuICAgICAgY29uc3QgeyBzdGF0ZSB9ID0gKGF3YWl0IChhd2FpdCBmZXRjaChgJHtiYXNlfS9zdGF0ZWApKS5qc29uKCkpIGFzIHtcbiAgICAgICAgc3RhdGU6IHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgICAgfTtcbiAgICAgIGlmICghc3RhdGUucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gaWQpKVxuICAgICAgICBkaWUoYHVua25vd24gcHJvamVjdCAnJHtpZH0nIOKAlCByZWdpc3RlciBpdCBmaXJzdGApO1xuICAgICAgYXdhaXQgc3RyZWFtRXZlbnRzKGJhc2UsIHsgc2luY2UsIHByb2plY3Q6IGlkLCBzY29wZUlkOiBpZCwgc2VsZjogcmVzb2x2ZUFzKGZsYWdzKSB9KTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBjYXNlIFwidGFpbFwiOiB7XG4gICAgICBjb25zdCB7IGJhc2UgfSA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgICAgYXdhaXQgc3RyZWFtRXZlbnRzKGJhc2UsIHsgc2luY2UsIHNlbGY6IHJlc29sdmVBcyhmbGFncykgfSk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIGRpZShgdW5rbm93biB2ZXJiICcke3ZlcmJ9JyDigJQgdHJ5ICdoZWxwJ2ApO1xuICB9XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG4vLyBFeHBvcnRlZCBzbyB0aGUgc2hpcHBlZCBsYXVuY2hlciAocGx1Z2lucy8uLi4vc2NyaXB0cy9jbGkudHMpIGNhbiBpbnZva2UgdGhlXG4vLyBCVU5ETEVEIGNvcHkgb2YgdGhpcyBtb2R1bGUuIFRoZSBpbXBvcnQubWV0YS5tYWluIGJsb2NrIGFib3ZlIHN0aWxsIHJ1bnMgdGhpc1xuLy8gZmlsZSBkaXJlY3RseSBkdXJpbmcgZGV2ZWxvcG1lbnQ7IHRoZSB0d28gZW50cnkgcm91dGVzIGFyZSBleGNsdXNpdmUsIGJlY2F1c2Vcbi8vIGltcG9ydC5tZXRhLm1haW4gaXMgZmFsc2UgZm9yIGFuIGltcG9ydGVkIG1vZHVsZS5cbmV4cG9ydCB7IG1haW4gfTtcblxuLyoqXG4gKiBUaGUgU0hJUFBFRCBFTlRSWSBQT0lOVCwgY2FsbGVkIGJ5IGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvYXN0cm9sYWJlL3NjcmlwdHMvY2xpLnRzYFxuICogYWZ0ZXIgdGhlIGJ1bmRsZSBpcyBpbXBvcnRlZC5cbiAqXG4gKiDim5QgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQuIGFyZ3YgYmVsb25ncyB0byB3aGljaGV2ZXIgZmlsZVxuICogUEFSU0VTIGl0LCBhbmQgdGhhdCBpcyB0aGlzIG9uZS4gQW4gZWFybGllciBsYXVuY2hlciByZWFkXG4gKiBgcHJvY2Vzcy5hcmd2LnNsaWNlKDIpYCBpdHNlbGYgYW5kIHBhc3NlZCBpdCBpbiDigJQgd2hpY2ggbWFkZSB0aGUgbGF1bmNoZXIgbWF0Y2hcbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIFBBUlNFU19BUkdTIHByZWRpY2F0ZSAoYHByb2Nlc3MuYXJndmApLCBzbyB0aGVcbiAqIHJvc3RlciBjb3VudGVkIGEgMy1saW5lIGZvcndhcmRlciBhcyBhbiBhcmctcGFyc2luZyBlbnRyeSBwb2ludCBhbmQgdGhlblxuICogcmVwb3J0ZWQgdGhlIHNwZWxsJ3MgZG9jdW1lbnRlZCBmbGFncyBhcyBVTlJFU09MVkVEIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS4gS2VlcGluZyBhcmd2IG9uIHRoaXMgc2lkZSBtYWtlcyB0aGUgZW51bWVyYXRvcidzIGFuc3dlciB0cnVlXG4gKiBpbnN0ZWFkIG9mIG1ha2luZyBpdHMgcmVnZXggbG9vc2VyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGlubGluZSBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgZGVwZW5kZW5jeS1mcmVlIGFuZCBkZWxpYmVyYXRlbHkgZHVsbDogaXQgaXMgYnVuZGxlZCBJTlRPIGVhY2hcbiAqIHNwZWxsJ3MgZW1pdHRlZCBDTEkgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIHNvIGFueXRoaW5nIGl0XG4gKiByZWFjaGVkIGZvciB3b3VsZCBiZWNvbWUgYSBkZXBlbmRlbmN5IG9mIHR3byBzaGlwcGVkIGFydGlmYWN0cyBhdCBvbmNlLlxuICpcbiAqIFRoZSB3aXJlIGNvbnRyYWN0IGl0IGVuY29kZXM6IGV4YWN0bHkgb25lIEpTT04gZG9jdW1lbnQsIG9uZSB0cmFpbGluZ1xuICogbmV3bGluZSwgbm90aGluZyBlbHNlIG9uIHN0ZG91dC4gQSBjYWxsZXIgcmVhZGluZyBvdXIgc3Rkb3V0IHdpdGggYVxuICogbGluZS1kZWxpbWl0ZWQgcGFyc2VyIGRlcGVuZHMgb24gdGhhdCBuZXdsaW5lOyBhIGNhbGxlciByZWFkaW5nIHRvIEVPRlxuICogZGVwZW5kcyBvbiB0aGVyZSBiZWluZyBubyBzZWNvbmQgZG9jdW1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bik6IHZvaWQge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUFrQ0E7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
