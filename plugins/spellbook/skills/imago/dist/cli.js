#!/usr/bin/env bun
// @bun

// src/imago/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";
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
function die(msg) {
  process.stderr.write(`imago: ${msg}
`);
  process.exit(2);
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
    die(`cannot read the session pointer (${code ?? "unknown error"}): ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`the session pointer is not valid JSON: ${path}`);
  }
}
function requireSession(session) {
  const s = readSession(session);
  if (!s)
    die("no running imago session \u2014 run: cli.ts open");
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
  const { status } = await api(s.port, "POST", "/cmd", msg);
  if (status !== 200)
    die(`cmd failed (HTTP ${status}) \u2014 is the session still alive?`);
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
  die("imago server failed to start within 5s");
}
async function cmdState(session, full = false) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200)
    die(`state failed (HTTP ${status})`);
  printJson(data);
}
async function cmdTail(session, sinceArg) {
  let since = sinceArg;
  let delay = 250;
  let stopped = false;
  let boundId = session;
  let grounded = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    const s = readSession(boundId);
    if (!s) {
      if (grounded)
        process.exit(0);
      process.stderr.write(`# no session yet, retrying\u2026
`);
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!boundId)
      boundId = s.session_id;
    if (!grounded) {
      grounded = true;
      process.stdout.write(`${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}
`);
    }
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
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
    while (true) {
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
            process.stderr.write(`: imago-keepalive
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
          if (ev.type === "closed") {
            process.stdout.write(`${payload}
`, () => process.exit(0));
            stopped = true;
            return;
          }
          process.stdout.write(`${payload}
`);
        } catch {}
      }
    }
    await sleep(delay);
  }
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
    die(`fetch failed (HTTP ${res.status}): ${url}`);
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
    die("no running imago session");
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
async function main(argv) {
  const [verb, ...rest] = argv;
  let pos;
  let flags;
  try {
    ({ pos, flags } = parseArgs(rest));
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    process.stderr.write(`imago: ${e.message}
`);
    return 2;
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
async function run() {
  return await main(process.argv.slice(2));
}
export {
  run,
  parseArgs,
  main
};

//# debugId=80662ED41E39756164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2ltYWdvL2JhY2tlbmQvY2xpLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBpbWFnbyBDTEkg4oCUIHRoaW4gd3JhcHBlciBhcm91bmQgdGhlIHBlci1zZXNzaW9uIGRhZW1vbidzIEhUVFAgc3VyZmFjZVxuLy8gKHNlcnZlci50cykuIFRoZSBhZ2VudCBkcml2ZXMgYSBncm91bmRlZCBpbWFnZSBjb252ZXJzYXRpb24gdGhyb3VnaCB0aGVzZVxuLy8gdmVyYnM7IGB0YWlsYCBzdHJlYW1zIHVzZXIgZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAuXG4vL1xuLy8gTGlmZWN5Y2xlOlxuLy8gICBidW4gY2xpLnRzIG9wZW4gWy0tdGl0bGUgLi5dIFstLW5vLW9wZW5dICAgIyBzcGF3biBhIHNlc3Npb25cbi8vICAgYnVuIGNsaS50cyB0YWlsICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAoTW9uaXRvciB0aGlzKVxuLy8gICBidW4gY2xpLnRzIHN0YXRlIFstLWZ1bGxdICAgICAgICAgICAgICAgICAgIyBsZWFuIHN0YXRlIHNuYXBzaG90XG4vL1xuLy8gVGFsa2luZyArIGRyaXZpbmcgdGhlIGNhbnZhcyAoUE9TVCAvY21kKTpcbi8vICAgYnVuIGNsaS50cyBzYXkgPHRleHQuLi4+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIHBvc3QgYWdlbnQgZGlhbG9ndWVcbi8vICAgYnVuIGNsaS50cyBwcm9wb3NlIDxwcm9tcHQuLi4+IFstLW4gTl0gICAgICAgICAgICAgICAgICAgICAjIHByb3Bvc2UgYSBwcm9tcHQgdG8gc2VuZFxuLy8gICBidW4gY2xpLnRzIGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdICAgICAgICAgICAgICAgIyBhc2sgdGhlIHVzZXIgKGluLXRocmVhZClcbi8vICAgYnVuIGNsaS50cyBiYXRjaCBbLS1raW5kIGdlbmVyYXRlfGVkaXRdIFstLXByb21wdCAuLl0gWy0tdGFnIC4uXVxuLy8gICAgICAgICAgICAgICAgICAgIFstLWVkaXRlZC1mcm9tIDx2YXJpYW50SWQ+XSBbLS1zdW1tYXJ5IC4uXSA8c3JjMT4gPHNyYzI+IC4uLlxuLy8gICAgICAgICAgICAgICAgICAgICMgZWFjaCBzcmMgPSBhbiBodHRwKHMpIHVybCwgYSBkYXRhOiB1cmwsIG9yIGEgZmlsZSBwYXRoXG4vLyAgIGJ1biBjbGkudHMgZm9jdXMgPGJhdGNoSWQ+IDx2YXJpYW50SWQ+ICAgICAgICAgICAgICAgICAgICAjIHB1dCBhbiBpbWFnZSBvbiB0aGUgY2FudmFzXG4vLyAgIGJ1biBjbGkudHMgY29udGV4dCA8a2luZD4gPG5hbWUuLi4+IFstLWNvbnRlbnQgXCI8dGV4dD5cIl0gWy0taW1hZ2UgPHBhdGh8dXJsPl1cbi8vICAgICAgICAgICAgICAgICAgICBbLS1saW5rIGFjdGl2ZXxxdWlja1Byb21wdHNdIFstLXRhZ3MgYSxiLGNdXG4vLyAgICAgICAgICAgICAgICAgICAgIyBhZGQvdXBzZXJ0IGEgQ29udGV4dCBMaWJyYXJ5IGVudHJ5IChraW5kOiBwcm9tcHR8c3R5bGV8c2tpbGx8Y29udGV4dClcbi8vICAgYnVuIGNsaS50cyBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZiAgICAgICAgICAgICAgICMgdGhlIHdvcmtpbmcgc3Bpbm5lclxuLy8gICBidW4gY2xpLnRzIGNvc3QgPHRleHQuLi4+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgY3VtdWxhdGl2ZSBzcGVuZCBkaXNwbGF5XG4vLyAgIGJ1biBjbGkudHMgaGFuZG9mZiA8dGV4dC4uLj4gfCBoYW5kb2ZmIC0tY2xlYXIgICAgICAgICAgICAjIGVzY2FsYXRlIHRvIGEgdGVybWluYWwgYXNrXG4vLyAgIGJ1biBjbGkudHMgY2xvc2UgfCBpbmZvIHwgc2Vzc2lvbnMgfCBoZWxwXG4vL1xuLy8gQWxsIHZlcmJzIHRhcmdldCB0aGUgbW9zdCByZWNlbnQgc2Vzc2lvbiBieSBkZWZhdWx0OyBwYXNzIC0tc2Vzc2lvbiA8aWQ+XG4vLyB0byB0YXJnZXQgYSBzcGVjaWZpYyBvbmUuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcblxuLy8g4puUIEVWRVJZIFBBVEggQkVMT1cgSVMgUkVTT0xWRUQgRlJPTSBUSEUgRU1JVFRFRCBCVU5ETEUsIE5FVkVSIEZST00gVEhJUyBGSUxFLlxuLy8gVGhpcyBtb2R1bGUgaXMgYXV0aG9yZWQgaGVyZSBhbmQgU0hJUFMgQlVJTFQgYXRcbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvaW1hZ28vZGlzdC9jbGkuanNgLCBpbXBvcnRlZCBieSB0aGUgbGF1bmNoZXIgYXRcbi8vIGAuLi9zY3JpcHRzL2NsaS50c2AgKGJhY2tlbmQgY29udmVyZ2VuY2UgUGhhc2UgMzsgc2VhbXMgQ29udHJhY3QgNCdzXG4vLyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCkuIGBpbXBvcnQubWV0YS51cmxgIHRoZXJlZm9yZSBuYW1lcyBgZGlzdC9jbGkuanNgLFxuLy8gc28gYFNDUklQVF9ESVJgIGlzIGA8c2tpbGw+L2Rpc3QvYCBhbmQgYFNLSUxMX1JPT1RgIGlzIHRoZSBza2lsbCByb290IOKAlCB3aGljaFxuLy8gaXMgd2hhdCB0aGUgdHdvIGxpbmVzIGJlbG93IGFscmVhZHkgbWVhbnQgZnJvbSBgc2NyaXB0cy9gLCB1bmNoYW5nZWQsIGJlY2F1c2Vcbi8vIGBkaXN0L2Agc2l0cyBhdCB0aGUgc2FtZSBkZXB0aCBhcyB0aGUgYHNjcmlwdHMvYCBpdCByZXBsYWNlZC4g4pqgIFRIQVQgSVMgQVxuLy8gQ09JTkNJREVOQ0UgT0YgREVQVEgsIE5PVCBBIFBST1BFUlRZOiBgcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzYCBhc3NlcnRzIGl0XG4vLyByYXRoZXIgdGhhbiB0cnVzdGluZyBpdC5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBORVZFUiBgam9pbihTQ1JJUFRfRElSLCBcInNlcnZlci50c1wiKWAuIFRoZSBkYWVtb24gaXNcbi8vIHNwYXduZWQgYnkgUEFUSCwgYW5kIHRoZSBwYXRoIGlzIHRoZSBMQVVOQ0hFUiBhdCBgPHNraWxsPi9zY3JpcHRzL3NlcnZlci50c2Bcbi8vIOKAlCBhIHJlYWwgYC50c2AgZmlsZSB0aGF0IGltcG9ydHMgYC4uL2Rpc3Qvc2VydmVyLmpzYC4gVGhlIHNpYmxpbmcgc3BlbGxpbmdcbi8vIHRoaXMgbGluZSB1c2VkIHRvIGNhcnJ5IHdhcyBjb3JyZWN0IG9ubHkgd2hpbGUgdGhlIENMSSBpdHNlbGYgbGl2ZWQgaW5cbi8vIGBzY3JpcHRzL2A7IGZyb20gYGRpc3QvYCBpdCByZXNvbHZlcyB0byBgZGlzdC9zZXJ2ZXIudHNgLCBhIGZpbGUgdGhhdCBkb2VzXG4vLyBub3QgYW5kIG11c3Qgbm90IGV4aXN0LCBhbmQgdGhlIHN5bXB0b20gaXMgbm90IGEgY3Jhc2gg4oCUIGBvcGVuYCB3YWl0cyBvdXQgaXRzXG4vLyBzdGFydCBkZWFkbGluZSBhbmQgcmVwb3J0cyBhIHRpbWVvdXQsIHdoaWNoIHJlYWRzIGxpa2UgYSBzbG93IGZpcnN0IGJ1aWxkLlxuLy8gZ2xhbW91ciBzaGlwcGVkIGV4YWN0bHkgdGhhdCBkZWZlY3QgaW4gUGhhc2UgMiAocGxheWJvb2sgQjQpLlxuLy8gYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCBpcyB0aGUgaW5zdHJ1bWVudCB0aGF0IGNhdGNoZXMgYVxuLy8gcmVncmVzc2lvbiBoZXJlOyBjb25maXJtIGl0cyBjb3ZlcmFnZSByb3cgbmFtZXMgaW1hZ28gd2l0aCBhIG5vbi16ZXJvIHBpblxuLy8gY291bnQsIGJlY2F1c2UgYSB3YXJkIHdob3NlIHBvcHVsYXRpb24gaXMgZGVyaXZlZCBpcyBub3QgdGhlcmVieSBDT1ZFUkVELlxuY29uc3QgU0VSVkVSX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJzZXJ2ZXIudHNcIik7XG4vLyBkZXY6IHRoZSBkYWVtb24gc2VydmVzIGEgQnVuLWJ1bmRsZWQgUmVhY3Qgc3VyZmFjZSwgYW5kIEJ1biByZWFkcyBidW5maWcudG9tbFxuLy8gKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2QgTVVTVCBiZSBzcmMvaW1hZ28vXG4vLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2IGJ1bmRsZXIgY2Fubm90XG4vLyBjb21waWxlIHRoZSBzdHlsZXNoZWV0IChtZWFzdXJlZCBvbiBnbGFtb3VyOiB0aGUgUEFHRSA1MDBzIHdpdGggbm8gc3R5bGVzaGVldFxuLy8gbGluazsgbm90IFwidW5zdHlsZWQgYXQgMjAwXCIg4oCUIHRoYXQgc2VudGVuY2Ugd2FzIG5ldmVyIHJ1bjsgaW1hZ28ncyBvd24gZmFpbHVyZVxuLy8gc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmRcbi8vIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWVcbi8vIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGRcbi8vIGJyZWFrIHRoZSBzcGF3bi5cbi8vIOKaoCBUaGUgZml2ZSBgLi5gIGFyZSBjb3VudGVkIGZyb20gYDxza2lsbD4vZGlzdC9gLCB3aGljaCBpcyB3aGVyZSB0aGlzIGxpbmVcbi8vIEVYRUNVVEVTIOKAlCBub3QgZnJvbSBgc3JjL2ltYWdvL2JhY2tlbmQvYCwgd2hlcmUgaXQgaXMgd3JpdHRlbi4gUmVhZCBhcyBhblxuLy8gb3JkaW5hcnkgcmVsYXRpdmUgcGF0aCBvZiB0aGUgZmlsZSBpdCBzaXRzIGluIGl0IHdvdWxkIGNsaW1iIG91dCBvZiB0aGUgcmVwby5cbi8vIEl0IGlzIHRoZSBzYW1lIHN0cmluZyBhcyBiZWZvcmUgdGhlIHJlbG9jYXRpb24gb25seSBiZWNhdXNlIGBkaXN0L2AgYW5kXG4vLyBgc2NyaXB0cy9gIHNpdCBhdCB0aGUgc2FtZSBkZXB0aCAoRDExJ3MgY29pbmNpZGVuY2Utb2YtZGVwdGgsIGFnYWluKS5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJpbWFnb1wiKTtcblxuZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5jb25zdCBTTkFQU0hPVFNfRElSID0gam9pbihwcm9jZXNzLmVudi5JTUFHT19IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5pbWFnb1wiKSwgXCJzbmFwc2hvdHNcIik7XG5cbmNvbnN0IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi53ZWJwXCI6IFwiaW1hZ2Uvd2VicFwiLFxuICBcIi5naWZcIjogXCJpbWFnZS9naWZcIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxufTtcblxudHlwZSBTZXNzaW9uID0ge1xuICB1cmw6IHN0cmluZztcbiAgcG9ydDogbnVtYmVyO1xuICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGZpbGVzX2Rpcj86IHN0cmluZztcbiAgLyoqIFRoZSBkYWVtb24ncyByZXNvbHZlZCBzdXJmYWNlIG1vZGUgKENvbnRyYWN0IDEpLiBBZGRpdGl2ZS1vcHRpb25hbDogYVxuICAgKiAgc2Vzc2lvbiBmaWxlIHdyaXR0ZW4gYnkgYW4gb2xkZXIgZGFlbW9uIGhhcyBubyBgbW9kZWAsIGFuZCBhYnNlbnQgbWVhbnNcbiAgICogIFwidW5rbm93blwiLCBuZXZlciBcImRldlwiLiAqL1xuICBtb2RlPzogXCJkZXZcIiB8IFwicmVsZWFzZVwiO1xufTtcblxuZnVuY3Rpb24gZGllKG1zZzogc3RyaW5nKTogbmV2ZXIge1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgaW1hZ286ICR7bXNnfVxcbmApO1xuICBwcm9jZXNzLmV4aXQoMik7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzZXNzaW9uID8gam9pbih0bXBkaXIoKSwgYGltYWdvLSR7c2Vzc2lvbn0uanNvbmApIDogam9pbih0bXBkaXIoKSwgXCJpbWFnby1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIOKblCBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFLlxuICpcbiAqICBUaGlzIGNhdWdodCBldmVyeSBlcnJvciBmcm9tIHRoZSByZWFkIGFuZCByZXR1cm5lZCBudWxsLCBzbyBhIGNvcnJ1cHRcbiAqICBwb2ludGVyLCBhbiBFQUNDRVMsIGFuZCBhbnkgdHJhbnNpZW50IHRoZSBPUyByYWlzZXMgdW5kZXIgbG9hZCBhbGwgYXJyaXZlZFxuICogIGF0IHRoZSBjYWxsZXJzIHdlYXJpbmcgYWJzZW5jZSdzIGNsb3RoZXMg4oCUIGFuZCB0aGUgY2FsbGVycyBhY3Qgb24gYWJzZW5jZTpcbiAqICB0aGV5IHJlcG9ydCBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiLCBhbmQgYSB0YWlsIGxvb3AgcmVhZHMgaXQgYXMgXCJ0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbiB3ZW50IGF3YXlcIiBhbmQgZXhpdHMgMC4gQSByZXNvdXJjZSBmYWlsdXJlIHdhcyB0aGVyZWZvcmUgcmVwb3J0ZWRcbiAqICBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBpbiBnbGFtb3VyLCB3aG9zZSBjb3B5IG9mIHRoaXMgZnVuY3Rpb24gaXMgYnl0ZS1pZGVudGljYWw6IGl0cyBDTElcbiAqICBjb250cmFjdCBjZWxsIGZhaWxlZCBvbmNlIHVuZGVyIHRoZSBmdWxsIGdhdGUgd2l0aCB0aGUgbm90X2ZvdW5kIGV4aXQgd2hlcmVcbiAqICB0aGUgY29udHJhY3Qgc2FpZCB1c2FnZSwgYW5kIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuLiBGaXhlZCB0aGVyZVxuICogIDIwMjYtMDktMDc7IGZvdW5kIHN0aWxsIHN0YW5kaW5nIGhlcmUgMjAyNi0wOS0wOCBieSB0aGUgYmFja2VuZCBkdXBsaWNhdGlvblxuICogIHJlY29uIChkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtYmFja2VuZC1kdXBsaWNhdGlvbi1yZWNvbi5tZCkuXG4gKlxuICogIEVOT0VOVCBpcyB0aGUgb25seSBob25lc3QgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHNheXMgd2hhdCBpdCB3YXMuXG4gKlxuICogIOKaoCBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgd2hpY2ggaXMgd2hhdCBsZXRzXG4gKiAgdW5wYXJzZWFibGUgY29udGVudCBjb3VudCBhcyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGEgaGFsZi13cml0dGVuIHJlYWQuICovXG5mdW5jdGlvbiByZWFkU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvbiB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykgYXMgU2Vzc2lvbjtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB0aGUgc2Vzc2lvbiBwb2ludGVyIGlzIG5vdCB2YWxpZCBKU09OOiAke3BhdGh9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24ge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBpbWFnbyBzZXNzaW9uIOKAlCBydW46IGNsaS50cyBvcGVuXCIpO1xuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgIG9yIGJvb2xlYW4gYC0tZmxhZ2AuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhlIGhhbmQtcm9sbGVkIHBhcnNlciBoYWQgbm8gcmVnaXN0cnksIHNvIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXRcbi8vIGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhc1xuLy8gc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC4gYG5vZGU6dXRpbGAgc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiwgdGhlXG4vLyBgPWAgZm9ybSBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBmcm9tIHRoZSBzdGFuZGFyZCBsaWJyYXJ5LlxuLy9cbi8vIFR5cGVzIGFyZSB0aG90aCdzIGF1ZGl0ZWQgYXJ0aWZhY3QgKDE3IHN0cmluZyDCtyAzIGJvb2xlYW4pLCBlYWNoIHNldHRsZWQgYnlcbi8vIHVuYW1iaWd1b3VzIGV2aWRlbmNlIGF0IGV2ZXJ5IGNvbnN1bXB0aW9uIHNpdGUuIEdldHRpbmcgb25lIHdyb25nIGlzIG5vdCBhXG4vLyBuby1vcDogYSBcInN0cmluZ1wiIHRoYXQgc2hvdWxkIGJlIGJvb2xlYW4gU1dBTExPV1MgVEhFIE5FWFQgUE9TSVRJT05BTCwgYW5kIGFcbi8vIFwiYm9vbGVhblwiIHRoYXQgc2hvdWxkIGJlIHN0cmluZyBicmVha3MgdGhlIHNwYWNlIGZvcm0uLy9cbi8vIGBraW5kYCBpcyBTVFJJTkcgZGVzcGl0ZSByZWFkaW5nIGFzIGBmbGFncy5raW5kID09PSBcImVkaXRcImAg4oCUIGl0IGlzIGNvbXBhcmVkXG4vLyB0byBhIHN0cmluZyBsaXRlcmFsLCBub3QgdGVzdGVkIGZvciBwcmVzZW5jZS4gRGVjbGFyaW5nIGl0IGJvb2xlYW4gdGhlcmVcbi8vIHdvdWxkIG1ha2UgYC0ta2luZCBlZGl0YCBwdXNoIFwiZWRpdFwiIGludG8gcG9zaXRpb25hbHMgYW5kIHRoZSBjb21wYXJpc29uXG4vLyB3b3VsZCBuZXZlciBtYXRjaDogYSBzaWxlbnQgbm8tb3AsIG5vdCBhIGNyYXNoLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGNvbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImVkaXRlZC1mcm9tXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbWFnZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGtpbmQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaW5rOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWxzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9wdGlvbnM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwcm9tcHQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3VtbWFyeTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRhZ3M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmdWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG5jbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYCR7ZGV0YWlsfVxcbmAgK1xuICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke09iamVjdC5rZXlzKENMSV9PUFRJT05TKVxuICAgICAgICAgIC5tYXAoKGspID0+IGAtLSR7a31gKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gICtcbiAgICAgICAgYCAgZm9yIGZyZWUgdGV4dCBjb250YWluaW5nIGRhc2hlcywgdXNlIC0tc3RkaW4sIG9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1gLFxuICAgICk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cyB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgY21kIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pIOKAlCBpcyB0aGUgc2Vzc2lvbiBzdGlsbCBhbGl2ZT9gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IG1zZy50eXBlIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmIChmbGFncy50aXRsZSkgYXJncy5wdXNoKFwiLS10aXRsZVwiLCBTdHJpbmcoZmxhZ3MudGl0bGUpKTtcbiAgaWYgKGZsYWdzLnRpbWVvdXQpIGFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBTdHJpbmcoZmxhZ3MudGltZW91dCkpO1xuICBpZiAoZmxhZ3MucmVzdG9yZSkgYXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIFN0cmluZyhmbGFncy5yZXN0b3JlKSk7XG4gIGlmIChmbGFnc1tcIm5vLW9wZW5cIl0pIGFyZ3MucHVzaChcIi0tbm8tb3BlblwiKTtcblxuICBjb25zdCBwcmV2SWQgPSByZWFkU2Vzc2lvbigpPy5zZXNzaW9uX2lkO1xuICAvLyBub2RlOmNoaWxkX3Byb2Nlc3MgKG5vdCBCdW4uc3Bhd24pIGlzIGRlbGliZXJhdGUgKyBtYXRjaGVzIGdyYXBldmluZS9ib3VudHk6XG4gIC8vIHRoZSBkYWVtb24gbXVzdCBTVVJWSVZFIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdGluZywgd2hpY2ggbmVlZHMgYGRldGFjaGVkOiB0cnVlYFxuICAvLyArIGB1bnJlZigpYC4gQnVuLnNwYXduIGNhbid0IGRldGFjaCBhIHN1cnZpdmluZyBkYWVtb24g4oCUIHNvIHRoZSBob3VzZSBwYXR0ZXJuXG4gIC8vIGZvciBzcGF3bmluZyBhIHN0YW5kaW5nIGRhZW1vbiBpcyBub2RlJ3Mgc3Bhd24uIChDTEFVREUubWQncyBCdW4tc3Bhd24gcHJlZlxuICAvLyBhcHBsaWVzIHRvIGluLXByb2Nlc3MgY2hpbGQgY29tbWFuZHMsIG5vdCBkZXRhY2hlZCBkYWVtb25zLilcbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGFyZ3MsIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgLy8gQ29udHJhY3QgNSDigJQgc2VlIGRhZW1vbkN3ZCgpLiBBIHdyb25nIGN3ZCBza2lwcyBidW5maWcudG9tbCdzIFRhaWx3aW5kXG4gICAgLy8gcGx1Z2luOyBvbiBnbGFtb3VyIHRoYXQgZmFpbHMgdGhlIHBhZ2Ugb3V0cmlnaHQgKDUwMCkuIEFzc2VydCB0aGUgaW52YXJpYW50LFxuICAgIC8vIG5vdCB0aGUgc3RhdHVzOiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gY3dkIGlzIHdyb25nLlxuICAgIGN3ZDogZGFlbW9uQ3dkKCksXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IHNsZWVwKDgwKTtcbiAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oKTtcbiAgICBpZiAocyAmJiBzLnNlc3Npb25faWQgIT09IHByZXZJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fS9zdGF0ZWApO1xuICAgICAgICBpZiAoci5vaykge1xuICAgICAgICAgIHByaW50SnNvbihzKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBub3QgdXAgeWV0ICovXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGRpZShcImltYWdvIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDVzXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uPzogc3RyaW5nLCBmdWxsID0gZmFsc2UpIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiXCIgOiBcIj9sZWFuPTFcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlQXJnOiBudW1iZXIpIHtcbiAgbGV0IHNpbmNlID0gc2luY2VBcmc7XG4gIGxldCBkZWxheSA9IDI1MDtcbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgLy8gUGluIHRoZSBzZXNzaW9uOiByZXNvbHZlIG9uY2UsIHRoZW4gUkVDT05ORUNUIHRvIHRoZSBTQU1FIHNlc3Npb24gb24gZXZlcnlcbiAgLy8gcmV0cnkg4oCUIG5ldmVyIHNpbGVudGx5IGhvcCB0byBhIG5ldyBcIm1vc3QgcmVjZW50XCIgZGFlbW9uICh0aGF0IGhpamFjayBlbmRlZCBhXG4gIC8vIHdhdGNoZXIgdGhlIG1vbWVudCBhIHNlY29uZCBkYWVtb24gc3Bhd25lZCkuIGBzZXNzaW9uYCBtYXkgYmUgdW5kZWZpbmVkOyBpdCdzXG4gIC8vIHBpbm5lZCB0byB0aGUgZmlyc3QgcmVzb2x2ZWQgaWQgYmVsb3cuIE9uY2UgcGlubmVkICsgZ3JvdW5kZWQsIGlmIHRoYXQgc2Vzc2lvblxuICAvLyBkaXNhcHBlYXJzIHdlIEVYSVQgKGVuZC1vZi1zZXNzaW9uKSwgcmF0aGVyIHRoYW4gcmV0cnkgZm9yZXZlciBvciByZS1yZXNvbHZlLlxuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGxldCBncm91bmRlZCA9IGZhbHNlO1xuICBjb25zdCBzdG9wID0gKCkgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIHByb2Nlc3MuZXhpdCgwKTtcbiAgfTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBzdG9wKTtcbiAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgc3RvcCk7XG5cbiAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgIGlmICghcykge1xuICAgICAgaWYgKGdyb3VuZGVkKSBwcm9jZXNzLmV4aXQoMCk7IC8vIG91ciBwaW5uZWQgc2Vzc2lvbiB3ZW50IGF3YXkg4oaSIGRvbmVcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiIyBubyBzZXNzaW9uIHlldCwgcmV0cnlpbmfigKZcXG5cIik7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkOyAvLyBwaW4gdG8gdGhlIGZpcnN0IHNlc3Npb24gd2UgcmVzb2x2ZWRcbiAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAvLyBncm91bmRpbmcgbGluZSDigJQgcGFyc2VhYmxlICsgdmlzaWJsZSBpbiBhIE1vbml0b3IsIG5hbWVzIHRoZSBiaW5kaW5nIHNvIGFcbiAgICAgIC8vIHdyb25nIHNlc3Npb24vcG9ydCBpcyBvYnZpb3VzIGluc3RlYWQgb2Ygc2lsZW50LlxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vZXZlbnRzP3NpbmNlPSR7c2luY2V9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZGVsYXkgPSAyNTA7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGxldCBjaHVuazogUmVhZGFibGVTdHJlYW1SZWFkUmVzdWx0PFVpbnQ4QXJyYXk+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKGNodW5rLmRvbmUpIGJyZWFrO1xuICAgICAgYnVmICs9IGRlYy5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiOiBpbWFnby1rZWVwYWxpdmVcXG5cIik7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnRyaW0oKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFkYXRhTGluZXMubGVuZ3RoKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGV2ID0gSlNPTi5wYXJzZShwYXlsb2FkKSBhcyB7IGlkPzogbnVtYmVyOyB0eXBlPzogc3RyaW5nIH07XG4gICAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiAmJiBldi5pZCA+IHNpbmNlKSBzaW5jZSA9IGV2LmlkO1xuICAgICAgICAgIGlmIChldi50eXBlID09PSBcImNsb3NlZFwiKSB7XG4gICAgICAgICAgICAvLyBQMGYg4oCUIFNIQVBFIEI6IHRoZSBkcmFpbiBjYWxsYmFjayByaWRlcyBUSElTIHdyaXRlLCBzbyBpdCBmaXJlc1xuICAgICAgICAgICAgLy8gb24gdGhpcyB3cml0ZSdzIGNvbXBsZXRpb24uIE5PVCBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIOKAlCBhXG4gICAgICAgICAgICAvLyBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgb25seSBpdHMgb3duIHdyaXRlIGFuZCBpcyBub3QgYSBiYXJyaWVyXG4gICAgICAgICAgICAvLyAobWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm8gZml4KSwgYW5kIHRoYXQgaXMgZXhhY3RseVxuICAgICAgICAgICAgLy8gdGhlIGhlbHBlciB0aGlzIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLlxuICAgICAgICAgICAgLy9cbiAgICAgICAgICAgIC8vIFBFUi1TSVRFIFBSRUNPTkRJVElPTiwgcmVhZCBhdCBUSElTIHNpdGUgcmF0aGVyIHRoYW4gY2FycmllZCBvdmVyXG4gICAgICAgICAgICAvLyBmcm9tIGEgc2libGluZzogdGhlIGV4aXQgc2l0cyBpbnNpZGUgYHdoaWxlICghc3RvcHBlZClgIC0+XG4gICAgICAgICAgICAvLyBgd2hpbGUgKHRydWUpYCAtPiB0aGUgZnJhbWUgbG9vcCwgc28gYHByb2Nlc3MuZXhpdENvZGVgICsgYVxuICAgICAgICAgICAgLy8gbmF0dXJhbCByZXR1cm4gKHNoYXBlIEQpIGRvZXMgTk9UIGxlYXZlIHRoZSB0YWlsIOKAlCBpdCBmYWxsc1xuICAgICAgICAgICAgLy8gdGhyb3VnaCBhbmQgdGhlIGxvb3BzIGdvIHJvdW5kIGFnYWluLiBUaGUgZXhwbGljaXQgYHJldHVybmAgaXNcbiAgICAgICAgICAgIC8vIHdoYXQgZXhpdHMgdGhlIGxvb3BzOyB0aGUgY2FsbGJhY2sgaXMgd2hhdCBkcmFpbnMuIEJvdGgsIGZvclxuICAgICAgICAgICAgLy8gZGlmZmVyZW50IHJlYXNvbnMuXG4gICAgICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtwYXlsb2FkfVxcbmAsICgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XG4gICAgICAgICAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cGF5bG9hZH1cXG5gKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogc2tpcCBtYWxmb3JtZWQgZnJhbWUgKi9cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICAvLyBzdHJlYW0gZW5kZWQg4oCUIHNlc3Npb24gbGlrZWx5IGNsb3NlZDsgbG9vcCB3aWxsIHJldHJ5IG9yIGV4aXQuXG4gICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbGVUb0RhdGFVcmwocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gcmVhZEZpbGVTeW5jKHBhdGgpO1xuICBjb25zdCBkb3QgPSBwYXRoLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID49IDAgPyBwYXRoLnNsaWNlKGRvdCkudG9Mb3dlckNhc2UoKSA6IFwiXCI7XG4gIGNvbnN0IG1pbWUgPSBNSU1FX0JZX0VYVFtleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG4gIHJldHVybiBgZGF0YToke21pbWV9O2Jhc2U2NCwke2J1Zi50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xufVxuXG4vLyBEb3dubG9hZCBhbiBpbWFnZSBVUkwgYW5kIGlubGluZSBpdCBhcyBhIGRhdGEgVVJMIOKAlCBzbyBhIGdlbmVyYXRlZCB2YXJpYW50XG4vLyBpcyBzZWxmLWNvbnRhaW5lZCAocGVyc2lzdHMgaW4gdGhlIHNuYXBzaG90LCBzdXJ2aXZlcyBwcmVzaWduZWQtVVJMIGV4cGlyeSkuXG5hc3luYyBmdW5jdGlvbiB1cmxUb0RhdGFVcmwodXJsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwpO1xuICBpZiAoIXJlcy5vaykgZGllKGBmZXRjaCBmYWlsZWQgKEhUVFAgJHtyZXMuc3RhdHVzfSk6ICR7dXJsfWApO1xuICBjb25zdCBidWYgPSBCdWZmZXIuZnJvbShhd2FpdCByZXMuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IG1pbWUgPSAocmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpIHx8IFwiaW1hZ2UvanBlZ1wiKS5zcGxpdChcIjtcIilbMF07XG4gIHJldHVybiBgZGF0YToke21pbWV9O2Jhc2U2NCwke2J1Zi50b1N0cmluZyhcImJhc2U2NFwiKX1gO1xufVxuXG4vLyBSZXNvbHZlIGEgdmFyaWFudCBzb3VyY2UgYXJndW1lbnQ6IGFuIGh0dHAocykgVVJMIChkb3dubG9hZGVkICsgaW5saW5lZCksIGFcbi8vIGRhdGE6IFVSTCAocGFzc2VkIHRocm91Z2gpLCBvciBhIGxvY2FsIGZpbGUgcGF0aCAocmVhZCArIGlubGluZWQpLlxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVNyYyhhcmc6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QoYXJnKSkgcmV0dXJuIHVybFRvRGF0YVVybChhcmcpO1xuICBpZiAoYXJnLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcmV0dXJuIGFyZztcbiAgcmV0dXJuIGZpbGVUb0RhdGFVcmwoYXJnKTtcbn1cblxuZnVuY3Rpb24gY21kSW5mbyhzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIGltYWdvIHNlc3Npb25cIik7XG4gIHByaW50SnNvbihzKTtcbn1cblxuZnVuY3Rpb24gY21kU2Vzc2lvbnMoKSB7XG4gIGxldCBmaWxlczogc3RyaW5nW107XG4gIHRyeSB7XG4gICAgZmlsZXMgPSByZWFkZGlyU3luYyhTTkFQU0hPVFNfRElSKS5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvblwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFwibm8gc2F2ZWQgc2Vzc2lvbnNcXG5cIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHR5cGUgUm93ID0geyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBiYXRjaGVzOiBudW1iZXI7IGdlbnM6IG51bWJlcjsgbXRpbWU6IG51bWJlciB9O1xuICBjb25zdCByb3dzOiBSb3dbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihTTkFQU0hPVFNfRElSLCBmKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgY29uc3QgYmF0Y2hlcyA9IChzdC5iYXRjaGVzIHx8IFtdKSBhcyBBcnJheTx7IHZhcmlhbnRzPzogdW5rbm93bltdIH0+O1xuICAgICAgcm93cy5wdXNoKHtcbiAgICAgICAgaWQ6IGYucmVwbGFjZSgvXFwuanNvbiQvLCBcIlwiKSxcbiAgICAgICAgdGl0bGU6IHN0LnRpdGxlLFxuICAgICAgICBiYXRjaGVzOiBiYXRjaGVzLmxlbmd0aCxcbiAgICAgICAgZ2VuczogYmF0Y2hlcy5yZWR1Y2UoKG4sIGIpID0+IG4gKyAoYi52YXJpYW50cz8ubGVuZ3RoID8/IDApLCAwKSxcbiAgICAgICAgbXRpbWU6IHN0YXRTeW5jKHBhdGgpLm10aW1lTXMsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgdW5yZWFkYWJsZSBzbmFwc2hvdCAqL1xuICAgIH1cbiAgfVxuICByb3dzLnNvcnQoKGEsIGIpID0+IGIubXRpbWUgLSBhLm10aW1lKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyLmlkfSAgJHtyLmJhdGNoZXN9IGJhdGNoZXMgwrcgJHtyLmdlbnN9IGdlbmVyYXRpb25zICDigJQgJHtyLnRpdGxlfVxcbmApO1xuICB9XG4gIGlmICghcm93cy5sZW5ndGgpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFwibm8gc2F2ZWQgc2Vzc2lvbnNcXG5cIik7XG59XG5cbmNvbnN0IEhFTFAgPSBgaW1hZ28g4oCUIGEgZ3JvdW5kZWQgaW1hZ2UgY29udmVyc2F0aW9uLlxuXG4gIG9wZW4gICBbLS10aXRsZSAuLl0gWy0tbm8tb3Blbl0gWy0tdGltZW91dCBTXSBbLS1yZXN0b3JlIDxpZHxwYXRoPl1cbiAgc2Vzc2lvbnMgICAgICAgICAgICAgICAgICAgICAgICAgICBsaXN0IHNhdmVkIChyZXN1bWFibGUpIHNlc3Npb25zXG4gIHRhaWwgICBbLS1zaW5jZSBOXSAgICAgICAgICAgICAgICAgIFNTRSB1c2VyIGV2ZW50cyDihpIgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yKVxuICBzdGF0ZSAgWy0tZnVsbF0gICAgICAgICAgICAgICAgICAgIGxlYW4gc3RhdGUgc25hcHNob3QgKGFkZCAtLWZ1bGwgZm9yIHJhdyBpbmNsLiBiYXNlNjQpXG4gIHNheSAgICA8dGV4dC4uLj4gICAgICAgICAgICAgICAgICAgcG9zdCBhZ2VudCBkaWFsb2d1ZSBpbnRvIHRoZSBjb252ZXJzYXRpb25cbiAgcHJvcG9zZSA8cHJvbXB0Li4uPiBbLS1uIE5dICAgICAgICBwcm9wb3NlIGEgcHJvbXB0IGZvciB0aGUgdXNlciB0byBzZW5kICjDl04sIOKJpDQpXG4gIGFzayAgICA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdICAgYXNrIHRoZSB1c2VyIGEgcXVlc3Rpb24gKGluLXRocmVhZClcbiAgYmF0Y2ggIFstLWtpbmQgZ2VuZXJhdGV8ZWRpdF0gWy0tcHJvbXB0IC4uXSBbLS10YWcgLi5dIFstLWVkaXRlZC1mcm9tIDx2aWQ+XSBbLS1zdW1tYXJ5IC4uXSBbLS1tb2RlbHMgbTEsbTIsLi5dIDxzcmM+IC4uLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFkZCBhIHByb2R1Y2VkIGJhdGNoOyBlYWNoIHNyYyA9IGh0dHAgdXJsLCBkYXRhOiB1cmwsIG9yIGZpbGUgcGF0aDsgLS1tb2RlbHMgbGFiZWxzIGVhY2ggdmFyaWFudFxuICBmb2N1cyAgPGJhdGNoSWQ+IDx2YXJpYW50SWQ+ICAgICAgIHB1dCBhbiBpbWFnZSBvbiB0aGUgY2FudmFzXG4gIHNlbGVjdCA8dmFyaWFudElkPiBbb2ZmXSAgICAgICAgICAgcG9pbnQgYSB2YXJpYW50IGF0IHRoZSBuZXh0IGdlbiBhcyBhIHJlZmVyZW5jZSAoaGlnaGxpZ2h0cyBpdCBmb3IgdGhlIHVzZXIpXG4gIGFuYWx5emUgPHZhcmlhbnRJZD4gPHRleHQuLi4+ICAgICAgd3JpdGUgeW91ciByZWFkIG9udG8gYW4gaW1hZ2UgKGR1cmFibGUgbWV0YWRhdGEpXG4gIGNvbnRleHQgPGtpbmQ+IDxuYW1lLi4uPiBbLS1jb250ZW50IFwiPHRleHQ+XCJdIFstLWltYWdlIDxwYXRofHVybD5dIFstLWxpbmsgYWN0aXZlfHF1aWNrUHJvbXB0c10gWy0tdGFncyBhLGIsY11cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhZGQvdXBzZXJ0IGEgQ29udGV4dCBMaWJyYXJ5IGVudHJ5IChraW5kOiBwcm9tcHR8c3R5bGV8c2tpbGx8Y29udGV4dClcbiAgc3RhdHVzIG9uIFt0ZXh0Li4uXSB8IHN0YXR1cyBvZmYgICBzaG93L2hpZGUgdGhlIFwiaW1hZ28gd29ya2luZ1wiIHNwaW5uZXJcbiAgY29zdCAgIDx0ZXh0Li4uPiAgICAgICAgICAgICAgICAgICBjdW11bGF0aXZlIHNwZW5kIGRpc3BsYXkgKGUuZy4gXCIkMC4zOCDCtyA4IGltZ3NcIilcbiAgaGFuZG9mZiA8dGV4dC4uLj4gfCBoYW5kb2ZmIC0tY2xlYXIgICByYWlzZS9jbGVhciBhIHRlcm1pbmFsLWFzayBlc2NhbGF0aW9uXG4gIGNsb3NlIHwgaW5mbyB8IGhlbHBcblxuICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gdGFyZ2V0IGEgc3BlY2lmaWMgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLmA7XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbdmVyYiwgLi4ucmVzdF0gPSBhcmd2O1xuICAvLyBBIHVzYWdlIGZhaWx1cmUgcmV0dXJucyAyIHJhdGhlciB0aGFuIGV4aXRpbmcsIHNvIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQuXG4gIGxldCBwb3M6IHN0cmluZ1tdO1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuICB0cnkge1xuICAgICh7IHBvcywgZmxhZ3MgfSA9IHBhcnNlQXJncyhyZXN0KSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGltYWdvOiAke2UubWVzc2FnZX1cXG5gKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBjb25zdCBzZXNzaW9uID0gdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJ0YWlsXCI6XG4gICAgICBhd2FpdCBjbWRUYWlsKHNlc3Npb24sIHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlSW50KGZsYWdzLnNpbmNlLCAxMCkgOiAtMSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic3RhdGVcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNheVwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogc2F5IDx0ZXh0Li4uPlwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNheVwiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwicHJvcG9zZVwiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZShcInVzYWdlOiBwcm9wb3NlIDxwcm9tcHQuLi4+IFstLW4gTl1cIik7XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlOiBcInByb3Bvc2VcIiwgcHJvbXB0OiBwb3Muam9pbihcIiBcIikgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MubiA9PT0gXCJzdHJpbmdcIikgbXNnLm4gPSBwYXJzZUludChmbGFncy5uLCAxMCk7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG1zZyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImFza1wiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZSgndXNhZ2U6IGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdJyk7XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlOiBcImFza1wiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Mub3B0aW9ucyA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBtc2cub3B0aW9ucyA9IGZsYWdzLm9wdGlvbnNcbiAgICAgICAgICAuc3BsaXQoXCJ8XCIpXG4gICAgICAgICAgLm1hcCgocykgPT4gcy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgbXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiYmF0Y2hcIjoge1xuICAgICAgaWYgKCFwb3MubGVuZ3RoKSB7XG4gICAgICAgIGRpZShcbiAgICAgICAgICBcInVzYWdlOiBiYXRjaCBbLS1raW5kIGdlbmVyYXRlfGVkaXRdIFstLXByb21wdCAuLl0gWy0tdGFnIC4uXSBbLS1lZGl0ZWQtZnJvbSA8dmlkPl0gWy0tc3VtbWFyeSAuLl0gWy0tbW9kZWxzIG0xLG0yLC4uXSA8c3JjPiAuLi5cXG5cIiArXG4gICAgICAgICAgICBcIiAgc3JjID0gYW4gaHR0cChzKSB1cmwsIGEgZGF0YTogdXJsLCBvciBhIGZpbGUgcGF0aDsgLS1tb2RlbHMgbGFiZWxzIGVhY2ggdmFyaWFudCBpbiBvcmRlclwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gb3B0aW9uYWwgcGVyLXZhcmlhbnQgbW9kZWwgbGFiZWxzLCBjb21tYS1zZXBhcmF0ZWQsIHBvc2l0aW9uYWwgdG8gc3Jjc1xuICAgICAgY29uc3QgbW9kZWxzID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLm1vZGVscyA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLm1vZGVscy5zcGxpdChcIixcIikubWFwKChtKSA9PiBtLnRyaW0oKSkgOiBbXTtcbiAgICAgIGNvbnN0IHZhcmlhbnRzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcG9zLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBzcmM6IGF3YWl0IHJlc29sdmVTcmMocG9zW2ldKSB9O1xuICAgICAgICBpZiAobW9kZWxzW2ldKSB2Lm1vZGVsID0gbW9kZWxzW2ldO1xuICAgICAgICB2YXJpYW50cy5wdXNoKHYpO1xuICAgICAgfVxuICAgICAgY29uc3QgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgdHlwZTogXCJiYXRjaC5hZGRcIixcbiAgICAgICAga2luZDogZmxhZ3Mua2luZCA9PT0gXCJlZGl0XCIgPyBcImVkaXRcIiA6IFwiZ2VuZXJhdGVcIixcbiAgICAgICAgcHJvbXB0OiB0eXBlb2YgZmxhZ3MucHJvbXB0ID09PSBcInN0cmluZ1wiID8gZmxhZ3MucHJvbXB0IDogXCJcIixcbiAgICAgICAgdmFyaWFudHMsXG4gICAgICB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy50YWcgPT09IFwic3RyaW5nXCIpIG1zZy50YWcgPSBmbGFncy50YWc7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzW1wiZWRpdGVkLWZyb21cIl0gPT09IFwic3RyaW5nXCIpIG1zZy5lZGl0ZWRGcm9tVmFyaWFudElkID0gZmxhZ3NbXCJlZGl0ZWQtZnJvbVwiXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc3VtbWFyeSA9PT0gXCJzdHJpbmdcIikgbXNnLnN1bW1hcnkgPSBmbGFncy5zdW1tYXJ5O1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBtc2cpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJmb2N1c1wiOlxuICAgICAgaWYgKHBvcy5sZW5ndGggPCAyKSBkaWUoXCJ1c2FnZTogZm9jdXMgPGJhdGNoSWQ+IDx2YXJpYW50SWQ+XCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZm9jdXNcIiwgYmF0Y2hJZDogcG9zWzBdLCB2YXJpYW50SWQ6IHBvc1sxXSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzZWxlY3RcIjpcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IHNlbGVjdCA8dmFyaWFudElkPiBbb2ZmXVwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlZi5zZWxlY3RcIiwgaWQ6IHBvc1swXSwgc2VsZWN0ZWQ6IHBvc1sxXSAhPT0gXCJvZmZcIiB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJhbmFseXplXCI6IHtcbiAgICAgIGlmIChwb3MubGVuZ3RoIDwgMikgZGllKFwidXNhZ2U6IGFuYWx5emUgPGltYWdlLWlkPiA8dGV4dC4uLj5cIik7XG4gICAgICBjb25zdCBbYWlkLCAuLi53b3Jkc10gPSBwb3M7XG4gICAgICAvLyByZWZzIGFyZSB2YXJpYW50cyBub3cg4oaSIG9uZSB2ZXJiIHdyaXRlcyBhIHJlYWQgb250byBhbnkgaW1hZ2UgKGluY2wuXG4gICAgICAvLyBtaWdyYXRlZCByZWZzIHRoYXQga2VwdCB0aGVpciBvbGQgXCJyZWYt4oCmXCIgaWQpXG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ2YXJpYW50LmFuYWx5emVcIiwgaWQ6IGFpZCwgdGV4dDogd29yZHMuam9pbihcIiBcIikgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImNvbnRleHRcIjoge1xuICAgICAgY29uc3QgVkFMSURfS0lORFMgPSBbXCJwcm9tcHRcIiwgXCJzdHlsZVwiLCBcInNraWxsXCIsIFwiY29udGV4dFwiXSBhcyBjb25zdDtcbiAgICAgIHR5cGUgQ29udGV4dEtpbmQgPSAodHlwZW9mIFZBTElEX0tJTkRTKVtudW1iZXJdO1xuICAgICAgY29uc3QgVkFMSURfTElOS1MgPSBbXCJhY3RpdmVcIiwgXCJxdWlja1Byb21wdHNcIl0gYXMgY29uc3Q7XG4gICAgICBjb25zdCBba2luZEFyZywgLi4ubmFtZVdvcmRzXSA9IHBvcztcbiAgICAgIGlmICgha2luZEFyZyB8fCAhVkFMSURfS0lORFMuaW5jbHVkZXMoa2luZEFyZyBhcyBDb250ZXh0S2luZCkpIHtcbiAgICAgICAgZGllKFxuICAgICAgICAgIGB1c2FnZTogY29udGV4dCA8a2luZD4gPG5hbWUuLi4+IFstLWNvbnRlbnQgXCI8dGV4dD5cIl0gWy0taW1hZ2UgPHBhdGh8dXJsPl0gWy0tbGluayBhY3RpdmV8cXVpY2tQcm9tcHRzXSBbLS10YWdzIGEsYixjXVxcbmAgK1xuICAgICAgICAgICAgYCAga2luZCBtdXN0IGJlIG9uZSBvZjogJHtWQUxJRF9LSU5EUy5qb2luKFwiLCBcIil9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghbmFtZVdvcmRzLmxlbmd0aClcbiAgICAgICAgZGllKFwidXNhZ2U6IGNvbnRleHQgPGtpbmQ+IDxuYW1lLi4uPiDigJQgYXQgbGVhc3Qgb25lIG5hbWUgd29yZCByZXF1aXJlZFwiKTtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIGZsYWdzLmxpbmsgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgIVZBTElEX0xJTktTLmluY2x1ZGVzKGZsYWdzLmxpbmsgYXMgKHR5cGVvZiBWQUxJRF9MSU5LUylbbnVtYmVyXSlcbiAgICAgICkge1xuICAgICAgICBkaWUoYC0tbGluayBtdXN0IGJlIG9uZSBvZjogJHtWQUxJRF9MSU5LUy5qb2luKFwiLCBcIil9YCk7XG4gICAgICB9XG4gICAgICBjb25zdCBjdHhNc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICB0eXBlOiBcImNvbnRleHQuYWRkXCIsXG4gICAgICAgIGtpbmQ6IGtpbmRBcmcgYXMgQ29udGV4dEtpbmQsXG4gICAgICAgIG5hbWU6IG5hbWVXb3Jkcy5qb2luKFwiIFwiKSxcbiAgICAgICAgY29udGVudDogdHlwZW9mIGZsYWdzLmNvbnRlbnQgPT09IFwic3RyaW5nXCIgPyBmbGFncy5jb250ZW50IDogXCJcIixcbiAgICAgIH07XG4gICAgICAvLyBhIGNhcHR1cmVkIHN0eWxlIGNhcnJpZXMgYSBjYW5vbmljYWwgZXhhbXBsZSBpbWFnZSAoYSB2YXJpYW50IHBhdGgvdXJsKSDihpJcbiAgICAgIC8vIGlubGluZSBpdCBzbyBpdCdzIHNlbGYtY29udGFpbmVkLCBsaWtlIGJhdGNoIHNyY3NcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MuaW1hZ2UgPT09IFwic3RyaW5nXCIpIGN0eE1zZy5pbWFnZSA9IGF3YWl0IHJlc29sdmVTcmMoZmxhZ3MuaW1hZ2UpO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy50YWdzID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGN0eE1zZy50YWdzID0gZmxhZ3MudGFnc1xuICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAubWFwKCh0KSA9PiB0LnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBmbGFncy5saW5rID09PSBcInN0cmluZ1wiKSBjdHhNc2cubGluayA9IGZsYWdzLmxpbms7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIGN0eE1zZyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInN0YXR1c1wiOiB7XG4gICAgICBjb25zdCBvbiA9IHBvc1swXSA9PT0gXCJvblwiO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IG9uLCB0ZXh0OiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImNvc3RcIjpcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IGNvc3QgPHRleHQuLi4+XCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY29zdFwiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaGFuZG9mZlwiOlxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiaGFuZG9mZlwiLFxuICAgICAgICB0ZXh0OiBmbGFncy5jbGVhciA9PT0gdHJ1ZSA/IFwiXCIgOiBwb3Muam9pbihcIiBcIiksXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpbmZvXCI6XG4gICAgICBjbWRJbmZvKHNlc3Npb24pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNlc3Npb25zXCI6XG4gICAgICBjbWRTZXNzaW9ucygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImhlbHBcIjpcbiAgICBjYXNlIFwiLS1oZWxwXCI6XG4gICAgY2FzZSBcIi1oXCI6XG4gICAgY2FzZSB1bmRlZmluZWQ6XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIGRpZShgdW5rbm93biB2ZXJiIFwiJHt2ZXJifVwiIOKAlCBydW46IGNsaS50cyBoZWxwYCk7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogVGhlIENMSSdzIE9ORSBlbnRyeSwgYW5kIGl0IGlzIHRoZSBMQVVOQ0hFUidzIHRvIGNhbGwuXG4gKlxuICog4puUIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIFRIQVQgSVMgVEhFIEZJUlNUIFRISU5HIEFcbiAqIEJVTkRMRSBCUkVBS1MuIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgYDxza2lsbD4vc2NyaXB0cy9jbGkudHNgLCBuZXZlclxuICogZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3MgZW50cnksIHNvIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSB0aGVyZSBhbmQgdGhlXG4gKiBibG9jayB0aGF0IHVzZWQgdG8gc2l0IGhlcmUgd291bGQgbmV2ZXIgcnVuIOKAlCB0aGUgQ0xJIHdvdWxkIHByaW50IG5vdGhpbmdcbiAqIGFuZCBleGl0IDAgZm9yIGV2ZXJ5IHZlcmIsIHdoaWNoIHJlYWRzIGxpa2UgYW4gZW1wdHkgcmVzdWx0IHJhdGhlciB0aGFuIGFcbiAqIGRlYWQgYmluYXJ5IChwbGF5Ym9vayBCMykuXG4gKlxuICog4pqgIFRIRSBEUkFJTkVEIEVYSVQgTU9WRUQgVE8gVEhFIExBVU5DSEVSLCBJVCBESUQgTk9UIEdPIEFXQVkuIGBydW4oKWAgaGFuZHNcbiAqIGJhY2sgYSBjb2RlIGFuZCB0aGUgbGF1bmNoZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWA7IGl0IG11c3QgTkVWRVIgYmVcbiAqIHRpZGllZCBpbnRvIGBwcm9jZXNzLmV4aXQoY29kZSlgLiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZVxuICogKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAqIGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBhbmQgaW1hZ28gc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4gKiBwYXlsb2FkcyAoYHN0YXRlIC0tZnVsbGAgaW5saW5lcyBiYXNlNjQgaW1hZ2VzKSwgc28gdGhlIGNhbGxlciB3b3VsZCBnZXRcbiAqIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIGZpeGVkIGFuZCBnYXRlZFxuICogaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogYHJ1bigpYCB0YWtlcyBOTyBBUkdVTUVOVFM6IHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlc1xuICogaXQsIHdoaWNoIGlzIHRoaXMgb25lLiBBIGZvcndhcmRlciB0aGF0IHJlYWQgYHByb2Nlc3MuYXJndmAgaXRzZWxmIHdvdWxkXG4gKiBtYXRjaCB0aGUgcm9zdGVyIGVudW1lcmF0b3IncyBhcmctcGFyc2luZyBwcmVkaWNhdGUgYW5kIHRoZSBmbGFnIHdhcmQgd291bGRcbiAqIHRoZW4ganVkZ2UgaW1hZ28ncyBkb2N1bWVudGVkIGZsYWdzIGFnYWluc3QgYSBmaWxlIHRoYXQgcmVjb2duaXNlcyBub25lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7IG1haW4gfTtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUE4QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLHNCQUFTO0FBWVQsSUFBTSxhQUFhLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUN6RCxJQUFNLGFBQWEsS0FBSyxZQUFZLElB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LFFBQ3JCLE1BQU07QUFBQSxRQUNOLE1BQU0sTUFBTSxVQUFVLE9BQU8sS0FBSyxJQUFJLEtBQUssR0FBRztBQUFBLE1BQ2hELENBQUM7QUFBQSxNQUNEO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUFBLE1BQ3hDO0FBQUEsU0FDRztBQUFBLE1BQ0gsUUFBUSxPQUFPO0FBQUEsTUFDZjtBQUFBLFNBQ0c7QUFBQSxNQUNILFlBQVk7QUFBQSxNQUNaO0FBQUEsU0FDRztBQUFBLFNBQ0E7QUFBQSxTQUNBO0FBQUEsU0FDQTtBQUFBLE1BQ0gsUUFBUSxPQUFPLE1BQU0sR0FBRztBQUFBLENBQVE7QUFBQSxNQUNoQztBQUFBO0FBQUEsTUFFQSxJQUFJLGlCQUFpQiwrQkFBeUI7QUFBQTtBQUFBLEVBRWxELE9BQU87QUFBQTtBQTJCVCxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI4MDY2MkVENDFFMzk3NTYxNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
